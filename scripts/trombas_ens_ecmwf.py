#!/usr/bin/env python3
"""Probabilidad de ambiente favorable a trombas en las zonas III a VI con el ensamble ECMWF (ENS 0,25°)
→ data/trombas_prob_ecmwf.json

Mismo cálculo y mismo formato que scripts/trombas_ens.py (GEFS), para comparar los dos ensambles: para la corrida
ENS de 00 o 12 UTC más reciente con plazo 72 h publicado, toma sus 50 miembros perturbados de 0 a 72 h cada 6 h
(datos abiertos de ECMWF, CC-BY-4.0), con altura, temperatura, humedad relativa y viento en los mismos niveles que
el GEFS (1000, 925, 850, 700, 500, 250 y 200 hPa) y presión, temperatura y punto de rocío a 2 m y viento a 10 m;
en cada miembro calcula STP (hemisferio sur), SHERBE y NST sobre los mismos puntos de mar de cada zona del
Cuadro "F" (trombas_ens.seleccionar, con la grilla de 0,25° del ENS).

Probabilidad = porcentaje de miembros en que al menos un punto de la zona supera el umbral; por plazo y por día
(hora de Chile). Los campos son globales, así que cada plazo baja unos 2 000 mensajes (≈ 1 GB); se recortan al
recuadro de las zonas al decodificarlos. Estimación experimental: no constituye aviso. Solo corre con corrida nueva.
"""
import json
import sys
import time
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ecmwf_datos as ed       # noqa: E402
import trombas_indices as ti   # noqa: E402
import trombas_ens as te       # noqa: E402  (zonas, umbrales y selección de puntos de mar del GEFS)

DATA = Path(__file__).resolve().parent.parent / "data"
SALIDA = DATA / "trombas_prob_ecmwf.json"
VERSION = 1
NORTE, SUR, OESTE, ESTE = -32, -48.5, -81.5, -71
NIVELES = [1000, 925, 850, 700, 500, 250, 200]
FHRS = list(range(0, 73, 6))
PL = {"gh", "t", "r", "u", "v"}
SFC = {"sp", "2t", "2d", "10u", "10v"}
MIN_MIEMBROS = 30
PRESUPUESTO = 1500   # s: si la descarga se alarga más, se conserva el archivo anterior


def elegir_corrida():
    ahora = datetime.now(timezone.utc)
    c = ahora.replace(minute=0, second=0, microsecond=0, hour=ahora.hour // 12 * 12)
    for _ in range(4):
        ind = ed.indice(c, "enfo", "ef", FHRS[-1])
        if ind and sum(1 for e in ind if e.get("param") == "gh") >= 50 * len(NIVELES):
            return c
        c -= timedelta(hours=12)
    return None


def elegir(e):
    if e.get("type") != "pf":
        return False
    if e.get("levtype") == "pl":
        return e.get("param") in PL and int(e.get("levelist", 0)) in NIVELES
    return e.get("levtype") == "sfc" and e.get("param") in SFC


def campos_paso(c, fhr):
    """{miembro: {clave: campo recortado}}, lat1, lon1"""
    por, la, lo, inf = {}, None, None, {}
    for e, grib in ed.bajar(c, "enfo", "ef", fhr, elegir, hilos=6, tope_bloque=60_000_000, hueco=1_000_000, informe=inf):
        v, lats, lons = ed.decodificar(grib)
        sub, la, lo = ed.recortar(v, lats, lons, NORTE, SUR, OESTE, ESTE)
        k = (e["param"], int(e["levelist"])) if e["levtype"] == "pl" else e["param"]
        por.setdefault(int(e["number"]), {})[k] = sub
    print(f"    +{fhr:02d} h: {inf.get('mensajes')} mensajes en {inf.get('lecturas')} lecturas, {inf.get('mb')} MB ({inf.get('espejo')})")
    return por, la, lo


def indices(campos, lat1, lon1, flat):
    def c(k):
        if k not in campos:
            raise KeyError(f"falta {k}")
        return campos[k]
    zeta = ed.vorticidad(c("10u"), c("10v"), lat1, lon1)
    sel = lambda a: a.ravel()[flat]
    niv = lambda n: np.stack([sel(c((n, p))) for p in NIVELES], 1)
    q = ti.calcular(np.array(NIVELES, float), sel(c("sp")) / 100.0, np.zeros(len(flat)), sel(c("2t")), sel(c("2d")),
                    sel(c("10u")), sel(c("10v")), niv("gh"), niv("t"), niv("r"), niv("u"), niv("v"))
    q["nst"] = ti.nst(q["lr01"], q["mlcape3"], q["mlcin"], q["bwd06"], -sel(zeta))
    return q


def main():
    previo = te.leer(SALIDA, {})
    c = elegir_corrida()
    if c is None:
        print("Trombas ENS ECMWF: no hay corrida 00/12 UTC con plazo 72 h disponible"); return
    tag = c.strftime("%Y-%m-%dT%HZ")
    if previo.get("corrida") == tag and previo.get("version") == VERSION and previo.get("completo", True):
        print("Trombas ENS ECMWF: sin corrida nueva", tag); return
    t0, errores = time.time(), []
    areas = flat = pos = None
    banderas = {}      # banderas[miembro][area][indice][plazo]
    fallidos = set()
    for k, fhr in enumerate(FHRS):
        if time.time() - t0 > PRESUPUESTO:
            print(f"Trombas ENS ECMWF: tope de tiempo en +{fhr} h; se conserva el archivo anterior"); return
        try:
            por, la1, lo1 = campos_paso(c, fhr)
        except Exception as e:
            print(f"Trombas ENS ECMWF: +{fhr} h no se pudo bajar ({e}); se conserva el archivo anterior"); return
        if areas is None:
            areas = {a: v for a, v in te.seleccionar(la1, lo1).items() if len(v["i"])}
            todos = np.concatenate([v["i"] * lo1.size + v["j"] for v in areas.values()])
            flat, inv = np.unique(todos, return_inverse=True)
            pos, ini = {}, 0
            for a, v in areas.items():
                pos[a] = inv[ini:ini + len(v["i"])]; ini += len(v["i"])
        for m, campos in por.items():
            if m in fallidos:
                continue
            try:
                q = indices(campos, la1, lo1, flat)
            except Exception as e:
                ln = traceback.extract_tb(e.__traceback__)[-1]
                errores.append(f"m{m} +{fhr} h: {type(e).__name__}: {e} ({Path(ln.filename).name}:{ln.lineno})"[:300])
                fallidos.add(m); continue
            ex = {"stp": q["stp"] <= te.UMBRAL["stp"], "hslc": q["hslc"], "nst": q["nst"] > te.UMBRAL["nst"]}
            fm = banderas.setdefault(m, {})
            for a in areas:
                for ind, f in ex.items():
                    fm.setdefault(a, {}).setdefault(ind, [None] * len(FHRS))[k] = bool(f[pos[a]].any())
        print(f"  +{fhr:02d} h: {len(por)} miembros ({time.time() - t0:.0f} s)")
    ok = sorted(m for m in banderas if m not in fallidos
                and all(None not in banderas[m][a][i] for a in areas for i in te.UMBRAL))
    gen = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if len(ok) < MIN_MIEMBROS:
        print(f"Trombas ENS ECMWF: solo {len(ok)} miembros completos; se conserva el archivo anterior")
        for x in errores[:5]:
            print("  " + x)
        if not previo.get("prob"):
            SALIDA.write_text(json.dumps({"version": VERSION, "corrida": tag, "completo": False, "generado": gen,
                                          "errores": errores[:8]}, ensure_ascii=False), encoding="utf-8")
        return
    validas = [c + timedelta(hours=f) for f in FHRS]
    dias = sorted({v.astimezone(te.TZ).date().isoformat() for v in validas})
    prob, prob_dia = {}, {}
    for a in areas:
        prob[a], prob_dia[a] = {}, {}
        for ind in te.UMBRAL:
            mat = np.array([banderas[m][a][ind] for m in ok])          # miembros × plazos
            prob[a][ind] = [round(100 * float(x)) for x in mat.mean(0)]
            prob_dia[a][ind] = {}
            for d in dias:
                cols = [j for j, v in enumerate(validas) if v.astimezone(te.TZ).date().isoformat() == d]
                prob_dia[a][ind][d] = round(100 * float(mat[:, cols].any(1).mean()))
    salida = {"version": VERSION, "modelo": "ecmwf", "corrida": tag, "generado": gen, "completo": True,
              "fuente": f"ECMWF ENS 0,25° ({len(ok)} miembros, datos abiertos, CC-BY-4.0)", "miembros": len(ok), "umbrales": te.UMBRAL,
              "validas": [v.strftime("%Y-%m-%dT%H:%MZ") for v in validas], "dias": dias,
              "areas": [{"id": a, "nombre": f"Zona {a} · {areas[a]['nombre']}", "puntos": [[round(float(la), 2), round(float(lo), 2)]
                         for la, lo in zip(areas[a]["lat"], areas[a]["lon"])]} for a in areas],
              "prob": prob, "prob_dia": prob_dia, "errores": errores[:8]}
    SALIDA.write_text(json.dumps(salida, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Trombas ENS ECMWF: corrida {tag}, {len(ok)} miembros, {time.time() - t0:.0f} s")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("Trombas ENS ECMWF: error", e)
