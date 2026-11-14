#!/usr/bin/env python3
"""Verificación de índices contra las trombas observadas → ~/trombas-era5/resultados/resumen.json y resumen.md

Unidad de análisis: el tramo-día (cuatro tramos de costa × cada día de abril a octubre, horas 12–23 UTC).
Para cada índice se toma su valor más favorable del tramo-día (extremo entre celdas y horas) y también el percentil 90.
Entrega, por índice:
  · área bajo la curva ROC con intervalo de 90 % por remuestreo de días completos (las trombas llegan en racimos);
  · el umbral que captura el 80 % y el 90 % de los tramo-días con tromba, y qué fracción de tramo-días deja bajo aviso;
  · la misma prueba dejando un año fuera (umbral elegido sin ese año y probado en él).
Compara con los umbrales actuales de la página y con los avisos archivados, y prueba el resultado en las trombas de reserva
(fuera del período de calibración). Un tramo-día sin registro NO es un tramo-día sin tromba: por eso el criterio no es la
tasa de falsas alarmas, sino capturas contra fracción de días bajo aviso.

Uso:  python calibracion/verificar.py
"""
import json
from datetime import datetime, timedelta, timezone

import numpy as np

from comun import ANIOS, DATOS, HORAS, MESES, RAIZ, TRAMOS, TZ, en_calibracion, eventos, hora_utc, tramo

ENTRADA, SALIDA = DATOS / "indices", DATOS / "resultados"
# +1: valores altos son favorables; −1: valores bajos (STP y helicidad son negativos en el hemisferio sur)
SENTIDO = {"stp": -1, "sherbe": 1, "nst": 1, "vgp": 1, "hslc": 1, "mucape": 1, "mlcape": 1, "mlcape3": 1, "ebsmu": 1, "srh500": -1,
           "bwd06": 1, "shr01": 1, "lr01": 1, "lr03": 1, "lr75": 1, "mllcl": -1, "dT": 1, "dZ": 1, "w850": 1}
NOMBRE = {"stp": "STP (hemisferio sur)", "sherbe": "SHERBE", "nst": "NST", "vgp": "VGP", "hslc": "HSLC (fracción de celdas-hora)", "mucape": "MUCAPE",
          "mlcape": "MLCAPE", "mlcape3": "MLCAPE 0–3 km", "ebsmu": "Cizalle efectivo", "srh500": "Helicidad 0–500 m", "bwd06": "Cizalle 0–6 km",
          "shr01": "Cizalle 0–1 km", "lr01": "Gradiente 0–1 km", "lr03": "Gradiente 0–3 km", "lr75": "Gradiente 700–500 hPa", "mllcl": "Base de nube (MLLCL)",
          "dT": "ΔT mar–850 hPa", "dZ": "Profundidad convectiva ΔZ", "w850": "Viento 850 hPa"}
ACTUAL = {"stp": -0.1, "nst": 1.0}          # umbrales de la página (scripts/trombas.py); HSLC es un criterio compuesto
RNG = np.random.default_rng(20261114)


def cargar():
    """Tabla de tramo-días: fecha, tramo y, por índice, extremo favorable y percentil 90; más los valores por celda de los días con evento."""
    filas, crudo = {}, {}
    dias_ev = {e["fecha"] for e in eventos()}
    for f in sorted(ENTRADA.glob("idx_*.npz")):
        if f.stem == "idx_prueba":
            continue
        d = np.load(f)
        t = d["tiempo"].astype("datetime64[s]")
        hora = (d["tiempo"] % 86400) // 3600
        fecha = t.astype("datetime64[D]")
        tr = d["tramo"]
        for dia in np.unique(fecha):
            sel_t = (fecha == dia) & np.isin(hora, list(HORAS))
            clave = str(dia)
            if clave in dias_ev or str(dia - np.timedelta64(1, 'D')) in dias_ev:
                m = fecha == dia
                crudo.setdefault(clave, []).append({"t": d["tiempo"][m], "lat": d["lat"], "lon": d["lon"], **{k: d[k][m] for k in SENTIDO}})
            if not sel_t.any():
                continue
            for z in range(len(TRAMOS)):
                c = tr == z
                if not c.any():
                    continue
                fila = filas.setdefault((clave, z), {})
                for k, s in SENTIDO.items():
                    v = d[k][np.ix_(sel_t, c)]
                    if np.isfinite(v).any():
                        if k == "hslc":
                            fila[k] = (float(np.nanmean(v)), float(np.nanmax(v)))
                        else:
                            fila[k] = (float(np.nanpercentile(v, 90 if s > 0 else 10)), float(np.nanmax(v) if s > 0 else np.nanmin(v)))
    return filas, crudo


def auc(x, y, w=None):
    """Área ROC ponderada con empates (x alto = favorable)."""
    ok = np.isfinite(x)
    x, y = x[ok], y[ok]; w = np.ones(len(x)) if w is None else w[ok]
    _, inv = np.unique(x, return_inverse=True)
    gp, gn = np.bincount(inv, w * y), np.bincount(inv, w * (1 - y))
    if gp.sum() == 0 or gn.sum() == 0:
        return np.nan
    return float(np.sum(gp * (np.cumsum(gn) - gn + 0.5 * gn)) / (gp.sum() * gn.sum()))


def intervalo(x, y, fechas, n=500):
    u, inv = np.unique(fechas, return_inverse=True)
    vals = [auc(x, y, RNG.multinomial(len(u), np.full(len(u), 1 / len(u)))[inv].astype(float)) for _ in range(n)]
    vals = [v for v in vals if np.isfinite(v)]
    return [round(float(np.percentile(vals, 5)), 3), round(float(np.percentile(vals, 95)), 3)] if vals else [None, None]


def umbral_captura(xe, frac):
    """Valor (en sentido favorable) que supera al menos la fracción `frac` de los eventos."""
    xe = np.sort(xe[np.isfinite(xe)])
    return float(xe[int(np.floor((1 - frac) * len(xe) + 1e-9))]) if len(xe) else np.nan


def en_aviso(fecha, z, avisos):
    n, s, _ = TRAMOS[z]
    a0 = datetime.fromisoformat(fecha + "T08:00"); a1 = datetime.fromisoformat(fecha + "T20:00")
    return any(datetime.fromisoformat(a["desde"]) <= a1 and a0 <= datetime.fromisoformat(a["hasta"]) and a["sur"] <= n and s <= a["norte"] for a in avisos)


def main():
    filas, crudo = cargar()
    if not filas:
        raise SystemExit(f"No hay índices en {ENTRADA}: corre antes era5_indices.py")
    ev = eventos()
    con = {}
    for e in ev:
        con.setdefault((e["fecha"], tramo(e["lat"])), []).append(e["id"])
    cal = sorted(k for k in filas if en_calibracion(k[0]) and int(k[0][:4]) in ANIOS)
    fechas = np.array([k[0] for k in cal]); anio = np.array([int(k[0][:4]) for k in cal])
    y = np.array([1.0 if k in con else 0.0 for k in cal])
    ev_cal = [k for k in con if en_calibracion(k[0])]
    res = {"generado": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "tramo_dias": len(cal), "tramo_dias_con_tromba": int(y.sum()),
           "tramo_dias_con_tromba_sin_datos": sorted(f"{k[0]} tramo {k[1]}" for k in ev_cal if k not in filas),
           "anios_con_datos": sorted({int(a) for a in anio}), "meses": list(MESES), "indices": {}}
    for k, s in SENTIDO.items():
        r = {"nombre": NOMBRE[k], "sentido": "alto" if s > 0 else "bajo"}
        for j, etiqueta in ((1, "extremo"), (0, "p90")):
            x = np.array([s * filas[c][k][j] if k in filas[c] else np.nan for c in cal])
            a = auc(x, y)
            r[etiqueta] = {"auc": None if np.isnan(a) else round(a, 3), "ic90": intervalo(x, y, fechas) if y.sum() else [None, None]}
            if j == 1 and y.sum():
                for frac in (0.8, 0.9):
                    u = umbral_captura(x[y == 1], frac)
                    r[etiqueta][f"captura_{int(frac * 100)}"] = {"umbral": round(s * u, 3), "capturadas": int((x[y == 1] >= u).sum()), "de": int(np.isfinite(x[y == 1]).sum()),
                                                                 "fraccion_bajo_aviso": round(float(np.nanmean(x >= u)), 4)}
                # dejando un año fuera
                h = n_ev = al = n_tot = 0
                for a_ in np.unique(anio):
                    dentro, fuera = anio != a_, anio == a_
                    if y[dentro].sum() < 5:
                        continue
                    u = umbral_captura(x[dentro & (y == 1)], 0.8)
                    h += int((x[fuera & (y == 1)] >= u).sum()); n_ev += int(np.isfinite(x[fuera & (y == 1)]).sum())
                    al += int((x[fuera] >= u).sum()); n_tot += int(np.isfinite(x[fuera]).sum())
                r[etiqueta]["anio_fuera_80"] = {"capturadas": h, "de": n_ev, "fraccion_bajo_aviso": round(al / n_tot, 4) if n_tot else None}
                if k in ACTUAL:
                    ua = s * ACTUAL[k]
                    r["umbral_actual"] = {"umbral": ACTUAL[k], "capturadas": int((x[y == 1] >= ua).sum()), "de": int(np.isfinite(x[y == 1]).sum()), "fraccion_bajo_aviso": round(float(np.nanmean(x >= ua)), 4)}
        res["indices"][k] = r
    # criterio actual de la página: STP ≤ −0,1, o HSLC, o NST > 1 en alguna celda-hora
    f = lambda c, k, j=1: filas[c].get(k, (np.nan, np.nan))[j]
    act = np.array([(f(c, "stp") <= -0.1) or (f(c, "hslc") > 0) or (f(c, "nst") > 1.0) for c in cal])
    res["pagina_actual"] = {"capturadas": int(act[y == 1].sum()), "de": int(y.sum()), "fraccion_bajo_aviso": round(float(act.mean()), 4)}
    # avisos archivados
    try:
        av = json.loads((RAIZ / "data" / "trombas_avisos_historicos.json").read_text(encoding="utf-8"))["avisos"]
        ini = min(a["desde"] for a in av)[:10]
        sub = [i for i, c in enumerate(cal) if c[0] >= ini]
        if sub:
            a_ = np.array([en_aviso(cal[i][0], cal[i][1], av) for i in sub]); ys = y[sub]
            res["avisos_archivados"] = {"desde": ini, "capturadas": int(a_[ys == 1].sum()), "de": int(ys.sum()), "fraccion_bajo_aviso": round(float(a_.mean()), 4)}
    except Exception as e:
        res["avisos_archivados"] = {"error": repr(e)}
    # valores junto a cada tromba con hora conocida (celda más cercana, ±3 h) y prueba en la reserva
    junto, reserva = [], []
    for e in ev:
        hu = hora_utc(e)
        if hu is not None:
            bloques = [b for d in (hu.date() - timedelta(days=1), hu.date(), hu.date() + timedelta(days=1)) for b in crudo.get(str(d), [])]
            mejor = None
            for b in bloques:
                dt = np.abs(b["t"] - int(hu.timestamp()))
                if dt.min() <= 3 * 3600:
                    dist = np.hypot(b["lat"] - e["lat"], (b["lon"] - e["lon"]) * np.cos(np.radians(e["lat"])))
                    i, j = int(dt.argmin()), int(dist.argmin())
                    cand = (float(dt.min()), {"id": e["id"], "fecha": e["fecha"], "lugar": e["lugar"], "dist_grados": round(float(dist.min()), 2),
                                              **{k: (None if not np.isfinite(b[k][i, j]) else round(float(b[k][i, j]), 3)) for k in SENTIDO}})
                    mejor = cand if mejor is None or cand[0] < mejor[0] else mejor
            if mejor:
                junto.append(mejor[1])
        c = (e["fecha"], tramo(e["lat"]))
        if not en_calibracion(e["fecha"]) and c in filas:
            reserva.append({"id": e["id"], "fecha": e["fecha"], "lugar": e["lugar"],
                            **{k: bool(SENTIDO[k] * filas[c][k][1] >= SENTIDO[k] * res["indices"][k]["extremo"]["captura_80"]["umbral"])
                               for k in SENTIDO if k in filas[c] and "captura_80" in res["indices"][k]["extremo"]}})
    res["junto_al_evento"], res["reserva"] = junto, reserva
    SALIDA.mkdir(parents=True, exist_ok=True)
    (SALIDA / "resumen.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    # informe
    L = ["# Calibración de trombas marinas con ERA5", "",
         f"Tramo-días analizados: **{res['tramo_dias']}** · con tromba observada: **{res['tramo_dias_con_tromba']}** · años con datos: {res['anios_con_datos'][0]}–{res['anios_con_datos'][-1]} ({len(res['anios_con_datos'])})", ""]
    if res["tramo_dias_con_tromba_sin_datos"]:
        L += [f"Sin datos ERA5 para {len(res['tramo_dias_con_tromba_sin_datos'])} tramo-días con tromba: falta descargar esos meses.", ""]
    L += ["| Índice | AUC (extremo) | IC 90 % | AUC (p90) | Umbral 80 % | Capturadas | Días bajo aviso | Año fuera: capturadas | Año fuera: bajo aviso |", "|---|---|---|---|---|---|---|---|---|"]
    orden = sorted(res["indices"], key=lambda k: -(res["indices"][k]["extremo"]["auc"] or 0))
    pc = lambda v: "—" if v is None else f"{100 * v:.1f} %"
    for k in orden:
        r = res["indices"][k]; e = r["extremo"]; c = e.get("captura_80"); af = e.get("anio_fuera_80")
        L.append(f"| {r['nombre']} | {e['auc']} | {e['ic90'][0]}–{e['ic90'][1]} | {r['p90']['auc']} | " + (f"{c['umbral']} | {c['capturadas']}/{c['de']} | {pc(c['fraccion_bajo_aviso'])} | {af['capturadas']}/{af['de']} | {pc(af['fraccion_bajo_aviso'])} |" if c else "— | — | — | — | — |"))
    L += ["", "AUC 0,5 = no discrimina; bajo 0,5 = discrimina al revés de lo supuesto. Un intervalo que incluye 0,5 no permite concluir.", "",
          "## Líneas de base", ""]
    p = res["pagina_actual"]; L.append(f"- Criterio actual de la página (STP ≤ −0,1, HSLC o NST > 1): captura {p['capturadas']}/{p['de']} y deja {pc(p['fraccion_bajo_aviso'])} de los tramo-días bajo aviso.")
    for k in ACTUAL:
        u = res["indices"][k].get("umbral_actual")
        if u: L.append(f"- {NOMBRE[k]} con umbral {u['umbral']}: captura {u['capturadas']}/{u['de']}, {pc(u['fraccion_bajo_aviso'])} bajo aviso.")
    a = res.get("avisos_archivados", {})
    if "de" in a: L.append(f"- Avisos archivados desde {a['desde']}: capturan {a['capturadas']}/{a['de']} con {pc(a['fraccion_bajo_aviso'])} de los tramo-días bajo aviso.")
    L += ["", f"## Reserva (fuera del período de calibración): {len(reserva)} trombas con datos", ""]
    for k in orden[:6]:
        n = sum(1 for r in reserva if r.get(k)); L.append(f"- {NOMBRE[k]}: {n}/{sum(1 for r in reserva if k in r)} sobre el umbral de 80 %.")
    L += ["", f"## Valores junto a la tromba (celda más cercana, ±3 h): {len(junto)} eventos con hora", ""]
    for k in orden[:8]:
        v = [j[k] for j in junto if j.get(k) is not None]
        if v: L.append(f"- {NOMBRE[k]}: mediana {np.median(v):.2f} (cuartiles {np.percentile(v, 25):.2f} a {np.percentile(v, 75):.2f}).")
    (SALIDA / "resumen.md").write_text("\n".join(L) + "\n", encoding="utf-8")
    print("\n".join(L[:14 + len(orden)]))


if __name__ == "__main__":
    main()
