#!/usr/bin/env python3
"""Perspectiva de ambientes favorables a trombas marinas desde MONAN (INPE/CPTEC) → data/trombas_monan.json

Corre en el computador que ejecuta MONAN (no en GitHub Actions). Lee las salidas history.*.nc de una corrida
regional (malla variable 12 → 3 km sobre el golfo de Arauco), lleva cada columna a los mismos niveles de presión
que usa scripts/trombas.py con el GFS y calcula los mismos índices con scripts/trombas_indices.py:
  - STP versión hemisferio sur (≤ −0,1) y ambiente HSLC (SHERBE ≥ 1 con cizalle > 18 m/s y CAPE bajo),
    según Marín et al. (2024, MWR 152; 2026, Atmos. Res. 344).
  - NST (umbral > 1), SPC/NWS, con la vorticidad relativa del primer nivel del modelo (−ζ en el HS).
  - Ingredientes del nomograma de Szilagyi: ΔT = TSM − T850, ΔZ = EL − LCL y viento en 850 hPa.
Mismo formato que data/trombas.json, con una columna extra "paso" (tamaño de la celda en grados),
porque la malla de MONAN no es uniforme.

Además escribe, junto a SALIDA.json, monan_indices.json: los mismos índices para TODAS las celdas de mar,
cada plazo, para consultar cualquier punto en el mapa de la página.

Uso:
    python trombas_monan.py DIRECTORIO_CORRIDA SALIDA.json [ARCHIVO_INIT]

Estimación automática y experimental: no constituye aviso.
"""
import glob
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from netCDF4 import Dataset

sys.path.insert(0, str(Path(__file__).resolve().parent))
import trombas_indices as ti  # noqa: E402

VERSION = 1
NIVELES = [1000, 975, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300, 250, 200, 150]
UMBRAL = {"stp": -0.1, "hslc": True, "nst": 1.0}
MS_A_KT = 1.943844
RD_CP = 287.04 / 1005.7
R_TIERRA = 6371229.0


def r(v, d):
    return None if v is None or not np.isfinite(v) else round(float(v), d)


def a_presion(p_mod, campo, p_obj):
    """Interpola en ln p, columna por columna. p_mod (N, K) decreciente con k; p_obj en Pa. Devuelve (N, L)."""
    n, k = p_mod.shape
    lp = np.log(p_mod)
    out = np.empty((n, len(p_obj)))
    fila = np.arange(n)
    for j, po in enumerate(p_obj):
        lpo = np.log(po)
        idx = np.clip((p_mod > po).sum(1), 1, k - 1)       # primer nivel con p <= po
        a, b = idx - 1, idx
        w = (lpo - lp[fila, a]) / (lp[fila, b] - lp[fila, a])
        w = np.clip(w, 0.0, 1.0)                          # fuera del rango: valor del extremo
        out[:, j] = campo[fila, a] + w * (campo[fila, b] - campo[fila, a])
    return out


def td_de_q(q, p_pa):
    e = np.maximum(q * (p_pa / 100.0) / (0.622 + q), 1e-6)   # hPa
    ln = np.log(e / 6.112)
    return 243.5 * ln / (17.67 - ln) + 273.15


def main():
    corrida, salida = Path(sys.argv[1]), Path(sys.argv[2])
    init = Path(sys.argv[3]) if len(sys.argv) > 3 else next(iter(sorted(corrida.glob("*.init.nc"))), None)
    hist = sorted(glob.glob(str(corrida / "history.*.nc")))
    if not hist:
        raise SystemExit(f"No hay history.*.nc en {corrida}")

    # Geometría y máscaras desde el primer history (y la zona de borde desde el init)
    g = Dataset(hist[0])
    g.set_auto_mask(False)
    lat = np.degrees(g["latCell"][:])
    lon = np.degrees(g["lonCell"][:]); lon = np.where(lon > 180, lon - 360, lon)
    zgrid = g["zgrid"][:]
    zmid = 0.5 * (zgrid[:, :-1] + zgrid[:, 1:])
    zsfc = zgrid[:, 0]
    voc = g["verticesOnCell"][:] - 1
    nE = g["nEdgesOnCell"][:]
    area = g["areaCell"][:]
    radio = float(getattr(g, "sphere_radius", R_TIERRA))
    if radio < 10:                                        # malla en esfera unitaria
        area = area * R_TIERRA ** 2
    paso = np.sqrt(area) / 111195.0                       # lado aproximado de la celda, en grados
    bdy = np.zeros(lat.size, int)
    if init is not None and Path(init).exists():
        di = Dataset(init)
        if "bdyMaskCell" in di.variables:
            bdy = di["bdyMaskCell"][:]
    mar = (g["xland"][0] > 1.5) & (bdy == 0)
    ini_txt = "".join(c.decode() if isinstance(c, bytes) else c for c in np.asarray(g["initial_time"][:]).astype(str)).strip()
    t_ini = datetime.strptime(ini_txt, "%Y-%m-%d_%H:%M:%S")
    g.close()
    m = np.where(mar)[0]
    print(f"MONAN: {lat.size} celdas, {m.size} de mar fuera de la zona de borde, inicio {t_ini:%Y-%m-%d %H} UTC")

    p_obj = np.array(NIVELES, float) * 100.0
    pasos = []
    # Índices de todas las celdas de mar, por plazo (enteros escalados para que el archivo sea liviano)
    COL_P = [("stp", 100), ("sherbe", 100), ("nst", 100), ("vgp", 100), ("mlcape", 1), ("mucape", 1), ("srh500", 1),
             ("ebsmu_kt", 1), ("dT", 10), ("dZ_km", 10), ("w850_kt", 1), ("mllcl", 1), ("hslc", 1)]
    puntos = []
    for f in hist:
        d = Dataset(f)
        d.set_auto_mask(False)
        xt = "".join(c.decode() if isinstance(c, bytes) else c for c in np.asarray(d["xtime"][0]).astype(str)).strip()
        valida = datetime.strptime(xt, "%Y-%m-%d_%H:%M:%S")
        fhr = int(round((valida - t_ini).total_seconds() / 3600))
        P = d["pressure"][0][m].astype(float)
        T = d["theta"][0][m].astype(float) * (P / 1e5) ** RD_CP
        RH = np.clip(d["relhum"][0][m].astype(float), 0, 100)
        U = d["uReconstructZonal"][0][m].astype(float)
        V = d["uReconstructMeridional"][0][m].astype(float)
        psfc = d["surface_pressure"][0][m].astype(float)
        t2 = d["t2m"][0][m].astype(float)
        td2 = np.minimum(td_de_q(d["q2"][0][m].astype(float), psfc), t2)
        u10, v10 = d["u10"][0][m].astype(float), d["v10"][0][m].astype(float)
        sst = d["sst"][0][m].astype(float)
        # En t = 0 MPAS escribe t2m, q2, u10 y v10 con relleno (−1e30): se usa el primer nivel del modelo
        malo = ~np.isfinite(t2) | (np.abs(t2 - 273.15) > 150)
        t2 = np.where(malo, T[:, 0], t2)
        td_k0 = ti.td_de_w(ti.EPS * (RH[:, 0] / 100 * ti.es_hpa(T[:, 0])) /
                           np.maximum(P[:, 0] / 100 - RH[:, 0] / 100 * ti.es_hpa(T[:, 0]), 1e-3), P[:, 0] / 100)
        td2 = np.where(malo | ~np.isfinite(td2), np.minimum(td_k0, t2), td2)
        malo_v = ~np.isfinite(u10) | ~np.isfinite(v10) | (np.abs(u10) > 150) | (np.abs(v10) > 150)
        u10 = np.where(malo_v, U[:, 0], u10)
        v10 = np.where(malo_v, V[:, 0], v10)
        # Vorticidad relativa del primer nivel: promedio de los vértices de cada celda
        vort_v = d["vorticity"][0][:, 0]
        zeta = np.array([vort_v[voc[i, :nE[i]]].mean() for i in m])
        d.close()

        gh = a_presion(P, zmid[m], p_obj)
        tt = a_presion(P, T, p_obj)
        rh = a_presion(P, RH, p_obj)
        uu = a_presion(P, U, p_obj)
        vv = a_presion(P, V, p_obj)
        q = ti.calcular(np.array(NIVELES, float), psfc / 100.0, zsfc[m], t2, td2, u10, v10, gh, tt, rh, uu, vv)
        q["nst"] = ti.nst(q["lr01"], q["mlcape3"], q["mlcin"], q["bwd06"], -zeta)
        q["dT"] = sst - q["t850"]
        q["dZ"] = (q["el"] - q["mllcl"]) / 1000.0
        q["w850"] = np.hypot(q["u850"], q["v850"]) * MS_A_KT

        stp, sh, ns = q["stp"], q["sherbe"], q["nst"]
        f_stp, f_sh, f_ns = stp <= UMBRAL["stp"], q["hslc"], ns > UMBRAL["nst"]
        idx = np.where(f_stp | f_sh | f_ns)[0]
        la, lo, pa = lat[m], lon[m], paso[m]
        celdas = [[r(la[i], 3), r(lo[i], 3), r(stp[i], 2), r(sh[i], 2), r(ns[i], 2),
                   r(q["dT"][i], 1), r(q["dZ"][i], 1), r(q["w850"][i], 0), r(q["mlcape"][i], 0), r(q["srh500"][i], 0),
                   r(q["ebsmu"][i] * MS_A_KT, 0), r(q["mucape"][i], 0), r(q["vgp"][i], 2), r(q["mllcl"][i], 0),
                   int(bool(q["hslc"][i])), r(pa[i], 3)] for i in idx]
        cols = {"stp": stp, "sherbe": sh, "nst": ns, "vgp": q["vgp"], "mlcape": q["mlcape"], "mucape": q["mucape"],
                "srh500": q["srh500"], "ebsmu_kt": q["ebsmu"] * MS_A_KT, "dT": q["dT"], "dZ_km": q["dZ"],
                "w850_kt": q["w850"], "mllcl": q["mllcl"], "hslc": q["hslc"].astype(float)}
        puntos.append({"fhr": fhr, "valida": valida.strftime("%Y-%m-%dT%H:%MZ"),
                       "datos": [[None if not np.isfinite(v) else int(round(float(v) * e)) for v in cols[c]] for c, e in COL_P]})
        pasos.append({"fhr": fhr, "valida": valida.strftime("%Y-%m-%dT%H:%MZ"),
                      "extremos": {"stp": r(np.nanmin(stp), 2), "sherbe": r(np.nanmax(sh), 2), "nst": r(np.nanmax(ns), 2),
                                   "vgp": r(np.nanmax(q["vgp"]), 2), "dT": r(np.nanmax(q["dT"]), 1)},
                      "n": {"stp": int(f_stp.sum()), "hslc": int(f_sh.sum()), "nst": int(f_ns.sum()), "puntos": int(stp.size)},
                      "celdas": celdas})
        print(f"  +{fhr:02d} h: STP mín {np.nanmin(stp):.2f} · SHERBE máx {np.nanmax(sh):.2f} · NST máx {np.nanmax(ns):.2f} "
              f"· ΔT máx {np.nanmax(q['dT']):.1f} · {len(idx)} celdas")

    pasos.sort(key=lambda p: p["fhr"])
    dominio = [r(lat.min(), 2), r(lon.min(), 2), r(lat.max(), 2), r(lon.max(), 2)]
    out = {"version": VERSION, "corrida": t_ini.strftime("%Y-%m-%dT%HZ"),
           "generado": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "fuente": "MONAN 2.0 (INPE/CPTEC), malla 12 → 3 km sobre el golfo de Arauco; inicial y bordes GFS 0,25°",
           "dominio": dominio, "paso_grilla": r(float(np.median(paso[m])), 3),
           "circulo": {"lat": -37.0, "lon": -73.3, "radio_km": 450, "fino_km": 70},
           "umbrales": UMBRAL, "solo_oceano": True, "completo": True, "errores": [],
           "columnas": ["lat", "lon", "stp", "sherbe", "nst", "dT", "dZ_km", "w850_kt", "mlcape", "srh500", "ebsmu_kt",
                        "mucape", "vgp", "mllcl", "hslc", "paso"],
           "pasos": pasos}
    salida.parent.mkdir(parents=True, exist_ok=True)
    salida.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    puntos.sort(key=lambda p: p["fhr"])
    sal_p = salida.parent / "monan_indices.json"
    sal_p.write_text(json.dumps({"version": 1, "corrida": out["corrida"], "generado": out["generado"],
                                 "celdas": [int(i) for i in m], "columnas": [c for c, _ in COL_P],
                                 "escala": [e for _, e in COL_P], "plazos": puntos},
                                ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"MONAN: índices de {m.size} celdas de mar → {sal_p} ({os.path.getsize(sal_p)/1e6:.2f} MB)")
    print(f"MONAN: {len(pasos)} plazos → {salida} ({os.path.getsize(salida)/1e3:.0f} kB)")


if __name__ == "__main__":
    main()
