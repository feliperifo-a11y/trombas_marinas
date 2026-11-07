#!/usr/bin/env python3
"""Perspectiva de ambientes favorables a trombas marinas desde el ECMWF IFS 0,25° → data/trombas_ecmwf.json

Mismo cálculo y mismo formato de salida que scripts/trombas.py (GFS), para comparar los dos modelos:
para cada plazo de 0 a 72 h (cada 3 h) de la corrida IFS más reciente (00, 06, 12 o 18 UTC) con plazo 72 h publicado,
baja de los datos abiertos de ECMWF (CC-BY-4.0) altura, temperatura, humedad relativa y viento en 1000–200 hPa,
y presión, temperatura y punto de rocío a 2 m, viento a 10 m, máscara tierra-mar y temperatura de piel en superficie;
recorta al dominio 20°–56° S / 85°–68° W y calcula sobre el océano STP (hemisferio sur), ambiente HSLC (SHERBE),
NST, VGP y los ingredientes de Szilagyi con scripts/trombas_indices.py.

Diferencias con el GFS: ECMWF publica solo 1000, 925 y 850 hPa bajo 700 hPa (el GFS, diez niveles), así que la
helicidad 0–500 m y el gradiente 0–1 km quedan más suavizados; y no publica TSM: ΔT usa la temperatura de piel,
que sobre el mar equivale a la TSM. La altura de superficie sobre el mar se toma como 0 m.
Estimación automática y experimental: no constituye aviso. Solo trabaja con corrida nueva; nunca hace fallar el flujo.
"""
import json
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ecmwf_datos as ed       # noqa: E402
import trombas_indices as ti   # noqa: E402
from trombas import UMBRAL, MS_A_KT, r, leer  # noqa: E402  (mismos umbrales y formato que el GFS)

DATA = Path(__file__).resolve().parent.parent / "data"
SALIDA = DATA / "trombas_ecmwf.json"
VERSION = 1
NORTE, SUR, OESTE, ESTE = -20, -56, -85, -68
NIVELES = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200]
FHRS = list(range(0, 73, 3))
PL = {"gh", "t", "r", "u", "v"}
SFC = {"sp", "2t", "2d", "10u", "10v", "lsm", "skt"}


def elegir_corrida():
    ahora = datetime.now(timezone.utc)
    c = ahora.replace(minute=0, second=0, microsecond=0, hour=ahora.hour // 6 * 6)
    for _ in range(6):
        ind = ed.indice(c, "oper", "fc", FHRS[-1])
        if ind and any(e.get("param") == "gh" for e in ind):
            return c
        c -= timedelta(hours=6)
    return None


def elegir(e):
    if e.get("levtype") == "pl":
        return e.get("param") in PL and int(e.get("levelist", 0)) in NIVELES
    return e.get("levtype") == "sfc" and e.get("param") in SFC


def campos_paso(c, fhr):
    campos, la, lo = {}, None, None
    for e, grib in ed.bajar(c, "oper", "fc", fhr, elegir):
        v, lats, lons = ed.decodificar(grib)
        sub, la, lo = ed.recortar(v, lats, lons, NORTE, SUR, OESTE, ESTE)
        if e["levtype"] == "pl":
            campos[(e["param"], int(e["levelist"]))] = sub
        else:
            campos[e["param"]] = sub
    return campos, la, lo


def procesar(campos, lat1, lon1):
    def c(k):
        if k not in campos:
            raise KeyError(f"falta {k}")
        return campos[k]
    mar = (c("lsm") < 0.5).ravel()
    zeta = ed.vorticidad(c("10u"), c("10v"), lat1, lon1)
    sel = lambda a: a.ravel()[mar]
    niv = lambda n: np.stack([sel(c((n, p))) for p in NIVELES], 1)
    q = ti.calcular(np.array(NIVELES, float), sel(c("sp")) / 100.0, np.zeros(int(mar.sum())), sel(c("2t")), sel(c("2d")),
                    sel(c("10u")), sel(c("10v")), niv("gh"), niv("t"), niv("r"), niv("u"), niv("v"))
    q["nst"] = ti.nst(q["lr01"], q["mlcape3"], q["mlcin"], q["bwd06"], -sel(zeta))
    q["dT"] = sel(c("skt")) - q["t850"]                     # temperatura de piel (≈ TSM sobre el mar) − T850 (°C)
    q["dZ"] = (q["el"] - q["mllcl"]) / 1000.0               # km
    q["w850"] = np.hypot(q["u850"], q["v850"]) * MS_A_KT    # kt
    LA, LO = np.meshgrid(lat1, lon1, indexing="ij")
    return q, LA.ravel()[mar], LO.ravel()[mar]


def main():
    previo = leer(SALIDA, {})
    c = elegir_corrida()
    if c is None:
        print("Trombas ECMWF: no hay corrida IFS con plazo 72 h disponible"); return
    tag = c.strftime("%Y-%m-%dT%HZ")
    if previo.get("corrida") == tag and previo.get("version") == VERSION and previo.get("completo", True):
        print("Trombas ECMWF: sin corrida nueva", tag); return
    t0, errores, pasos = time.time(), [], []
    # Descarga de dos plazos a la vez (cada uno con varias lecturas parciales en paralelo)
    with ThreadPoolExecutor(2) as ex:
        futuros = {fhr: ex.submit(campos_paso, c, fhr) for fhr in FHRS}
        for fhr in FHRS:
            try:
                campos, la1, lo1 = futuros[fhr].result()
                q, la, lo = procesar(campos, la1, lo1)
            except Exception as e:
                ln = traceback.extract_tb(e.__traceback__)[-1]
                msj = f"f{fhr:03d}: {type(e).__name__}: {e} ({Path(ln.filename).name}:{ln.lineno})"
                print("  " + msj); errores.append(msj[:300]); continue
            stp, sh, ns = q["stp"], q["sherbe"], q["nst"]
            f_stp, f_sh, f_ns = stp <= UMBRAL["stp"], q["hslc"], ns > UMBRAL["nst"]
            idx = np.where(f_stp | f_sh | f_ns)[0]
            celdas = [[r(la[i], 2), r(lo[i], 2), r(stp[i], 2), r(sh[i], 2), r(ns[i], 2),
                       r(q["dT"][i], 1), r(q["dZ"][i], 1), r(q["w850"][i], 0), r(q["mlcape"][i], 0), r(q["srh500"][i], 0),
                       r(q["ebsmu"][i] * MS_A_KT, 0), r(q["mucape"][i], 0), r(q["vgp"][i], 2), r(q["mllcl"][i], 0), int(bool(q["hslc"][i]))] for i in idx]
            pasos.append({"fhr": fhr, "valida": (c + timedelta(hours=fhr)).strftime("%Y-%m-%dT%H:%MZ"),
                          "extremos": {"stp": r(np.nanmin(stp), 2), "sherbe": r(np.nanmax(sh), 2), "nst": r(np.nanmax(ns), 2),
                                       "vgp": r(np.nanmax(q["vgp"]), 2), "dT": r(np.nanmax(q["dT"]), 1)},
                          "n": {"stp": int(f_stp.sum()), "hslc": int(f_sh.sum()), "nst": int(f_ns.sum()), "puntos": int(stp.size)},
                          "celdas": celdas})
            print(f"  f{fhr:03d}: STP mín {np.nanmin(stp):.2f} · SHERBE máx {np.nanmax(sh):.2f} · NST máx {np.nanmax(ns):.2f} · "
                  f"ΔT máx {np.nanmax(q['dT']):.1f} · {len(idx)} celdas ({time.time() - t0:.0f} s)")
    if len(pasos) < len(FHRS) // 2:
        print(f"Trombas ECMWF: solo {len(pasos)} plazos procesados; se conserva el archivo anterior")
        if not previo.get("pasos"):
            SALIDA.write_text(json.dumps({"version": VERSION, "corrida": tag, "completo": False, "pasos": [],
                                          "generado": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                                          "errores": errores[:8]}, ensure_ascii=False), encoding="utf-8")
        return
    salida = {"version": VERSION, "modelo": "ecmwf", "corrida": tag, "generado": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
              "fuente": "ECMWF IFS 0,25° (datos abiertos, CC-BY-4.0)", "dominio": [SUR, OESTE, NORTE, ESTE], "paso_grilla": 0.25,
              "umbrales": UMBRAL, "solo_oceano": True, "completo": True, "errores": errores[:8],
              "columnas": ["lat", "lon", "stp", "sherbe", "nst", "dT", "dZ_km", "w850_kt", "mlcape", "srh500", "ebsmu_kt", "mucape", "vgp", "mllcl", "hslc"],
              "pasos": pasos}
    SALIDA.write_text(json.dumps(salida, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Trombas ECMWF: corrida {tag}, {len(pasos)} plazos, {time.time() - t0:.0f} s")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("Trombas ECMWF: error", e)
