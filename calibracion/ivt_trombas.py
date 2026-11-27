#!/usr/bin/env python3
"""¿Coinciden las trombas del catálogo con ríos atmosféricos? IVT de ERA5 (1000–300 hPa, desde T, HR y viento en niveles
de presión) en una caja de ±0,5° alrededor de cada tromba (celdas de mar), máximo diario en 12, 15, 18 y 21 UTC,
comparado con los demás días del mismo mes en el mismo lugar (excluye ±1 día). Salida: ~/trombas-era5/ivt_trombas.json

Resultado (27-nov-2026, 39 trombas con control, 27 fechas únicas): el día de la tromba el IVT llegó a 250 o más en el
63 % de las fechas, contra 33 % esperado en los días de control (p ≈ 0,001); el día o el anterior, 89 % contra 47 %.
"""
import json
from datetime import date, datetime, timedelta, timezone

import netCDF4 as N
import numpy as np

from comun import DATOS, eventos

E5 = DATOS / "era5"
G = 9.80665
_cache = {}


def q_de(t, r, p):
    """Humedad específica desde T (K), HR (%) y p (hPa)."""
    es = 6.112 * np.exp(17.67 * (t - 273.15) / (t - 29.65))
    e = np.clip(r, 0, 100) / 100 * es
    return 0.622 * e / (p - 0.378 * e)


def campo(clave):
    if clave in _cache:
        return _cache[clave]
    pl, sf = N.Dataset(E5 / f"pl_{clave}.nc"), N.Dataset(E5 / f"sfc_{clave}.nc")
    niv = pl["pressure_level"][:].astype(float)
    k = np.where(niv >= 300)[0]
    k = k[np.argsort(-niv[k])]                                   # 1000 → 300 hPa
    p = niv[k]
    t, r, u, v = (np.asarray(pl[x][:, k]) for x in ("t", "r", "u", "v"))
    q = q_de(t, r, p[None, :, None, None])
    ps = np.asarray(sf["sp"][:]) / 100.0
    w = (np.broadcast_to(p[None, :, None, None], q.shape) <= ps[:, None]).astype(float)   # solo sobre la superficie
    qu, qv, dp = q * u * w, q * v * w, -np.diff(p) * 100.0
    iu = (0.5 * (qu[:, 1:] + qu[:, :-1]) * dp[None, :, None, None]).sum(1) / G
    iv = (0.5 * (qv[:, 1:] + qv[:, :-1]) * dp[None, :, None, None]).sum(1) / G
    tt = np.array([datetime.fromtimestamp(int(x), timezone.utc) for x in pl["valid_time"][:]])
    _cache[clave] = (tt, pl["latitude"][:], pl["longitude"][:], np.hypot(iu, iv), np.degrees(np.arctan2(iu, iv)) % 360,
                     np.asarray(sf["lsm"][0]))
    return _cache[clave]


def caja(lat, lon, la, lo, lsm, r=0.5):
    m = np.zeros_like(lsm, bool)
    m[np.ix_(np.where(np.abs(lat - la) <= r)[0], np.where(np.abs(lon - lo) <= r)[0])] = True
    mar = m & (lsm < 0.5)
    return mar if mar.any() else m


def main():
    res = []
    for e in eventos():
        d = date.fromisoformat(e["fecha"])
        clave = d.strftime("%Y%m") if (E5 / f"pl_{d:%Y%m}.nc").exists() else (f"ev_{d:%Y%m%d}" if (E5 / f"pl_ev_{d:%Y%m%d}.nc").exists() else None)
        if not clave:
            continue
        tt, lat, lon, mag, dr, lsm = campo(clave)
        m = caja(lat, lon, e["lat"], e["lon"], lsm)
        serie = mag[:, m].max(1)
        dias = np.array([x.date() for x in tt])
        dmax = {dd: float(serie[dias == dd].max()) for dd in sorted(set(dias))}
        ev_d, prev = dmax.get(d), dmax.get(d - timedelta(days=1))
        i = np.where(dias == d)[0]
        i = i[np.argmax(serie[i])]
        ctrl = [x for dd, x in dmax.items() if abs((dd - d).days) > 1]
        ctrl2 = [max(dmax[dd], dmax.get(dd - timedelta(days=1), dmax[dd])) for dd in dmax if abs((dd - d).days) > 2]
        res.append(dict(id=e["id"], fecha=e["fecha"], lugar=e["lugar"], lat=e["lat"], tipo=e["tipo"], ivt_dia=round(ev_d),
                        ivt_2d=round(max(x for x in (ev_d, prev) if x is not None)), dir=round(float(np.median(dr[i][m]))),
                        pct=float((np.array(ctrl) < ev_d).mean() * 100) if len(ctrl) >= 10 else None, ctrl_n=len(ctrl),
                        ctrl_frac250=float(np.mean(np.array(ctrl) >= 250)) if ctrl else None,
                        ctrl2_frac250=float(np.mean(np.array(ctrl2) >= 250)) if ctrl2 else None))
    (DATOS / "ivt_trombas.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    print(len(res), "trombas analizadas")


if __name__ == "__main__":
    main()
