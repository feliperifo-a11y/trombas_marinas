#!/usr/bin/env python3
"""Perspectiva de ambientes favorables a trombas marinas desde el GFS 0,25° → data/trombas.json

Para cada plazo de 0 a 72 h (cada 3 h) de la corrida GFS más reciente con plazo 72 h disponible, baja
un subconjunto recortado al dominio 20°–56° S / 85°–68° W (filtro NOMADS) y calcula sobre el océano:
  - STP versión hemisferio sur (≤ −0,1) y ambiente HSLC (SHERBE ≥ 1 con cizalle > 18 m/s y CAPE bajo),
    según los estudios chilenos de Marín et al. (2024, MWR 152; 2026, Atmos. Res. 344). VGP y LCL como referencia.
  - NST (umbral > 1), SPC/NWS, con la vorticidad ciclónica del hemisferio sur (−ζ).
  - Ingredientes del nomograma de Szilagyi: ΔT = TSM − T850, ΔZ = EL − LCL y viento en 850 hPa.
    El valor del SWI queda pendiente: requiere el nomograma digitalizado de fuente autorizada.
Solo guarda las celdas que superan algún umbral, más los extremos del dominio por plazo.
Estimación automática y experimental: no constituye aviso. Nunca hace fallar el flujo de trabajo.
"""
import json
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import trombas_indices as ti  # noqa: E402

SALIDA = Path(__file__).resolve().parent.parent / "data" / "trombas.json"
VERSION = 2
CAB = {"User-Agent": "dashboard-meteo-publico/1.0 (trombas GFS)"}
NORTE, SUR, OESTE, ESTE = -20, -56, -85, -68
NIVELES = [1000, 975, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300, 250, 200, 150]
FHRS = list(range(0, 73, 3))
MS_A_KT = 1.943844
# Umbrales (ajustados a estudios chilenos):
#   STP ≤ −0,1: los máximos de STP de los 16 tornados notables de Chile estuvieron entre −0,1 y −0,9 (Marín et al., 2024,
#              MWR 152); además cerca de la mitad de los tornados chilenos tuvo STP = 0 (Marín et al., 2026), así que
#              el STP solo no basta.
#   HSLC:      MUCAPE 0–1000 J/kg, EBSMU > 18 m/s y SHERBE ≥ 1 (definición de Marín et al., 2026, Atmos. Res. 344).
#   NST > 1:   SPC/NWS; sin validación en Chile (referencia para trombas de buen tiempo).
UMBRAL = {"stp": -0.1, "hslc": True, "nst": 1.0}
# Códigos WMO GRIB2: (disciplina, categoría, número)
COD = {"gh": (0, 3, 5), "t": (0, 0, 0), "r": (0, 1, 1), "u": (0, 2, 2), "v": (0, 2, 3),
       "sp": (0, 3, 0), "td": (0, 0, 6), "lsm": (2, 0, 0)}


def leer(p, defecto):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except Exception:
        return defecto


def disponible(c, fhr):
    d, h = c.strftime("%Y%m%d"), c.strftime("%H")
    url = f"https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.{d}/{h}/atmos/gfs.t{h}z.pgrb2.0p25.f{fhr:03d}.idx"
    try:
        return requests.head(url, headers=CAB, timeout=20).status_code == 200
    except Exception:
        return False


def elegir_corrida():
    ahora = datetime.now(timezone.utc)
    c = ahora.replace(minute=0, second=0, microsecond=0, hour=ahora.hour // 6 * 6)
    for _ in range(5):
        if disponible(c, FHRS[-1]):
            return c
        c -= timedelta(hours=6)
    return None


def bajar(c, fhr):
    d, h = c.strftime("%Y%m%d"), c.strftime("%H")
    par = {"dir": f"/gfs.{d}/{h}/atmos", "file": f"gfs.t{h}z.pgrb2.0p25.f{fhr:03d}",
           "subregion": "", "toplat": NORTE, "bottomlat": SUR, "leftlon": OESTE + 360, "rightlon": ESTE + 360}
    for v in ("HGT", "TMP", "RH", "UGRD", "VGRD", "PRES", "DPT", "LAND"):
        par[f"var_{v}"] = "on"
    for n in NIVELES:
        par[f"lev_{n}_mb"] = "on"
    for lv in ("surface", "2_m_above_ground", "10_m_above_ground"):
        par[f"lev_{lv}"] = "on"
    for intento in range(4):
        try:
            r = requests.get("https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl", params=par, headers=CAB, timeout=90)
            if r.status_code == 200 and r.content[:4] == b"GRIB":
                return r.content
            raise RuntimeError(f"HTTP {r.status_code}")
        except Exception as e:
            if intento == 3:
                raise
            print(f"  f{fhr:03d}: reintento ({e})")
            time.sleep(10 * (intento + 1))


def leer_grib(contenido):
    import pygrib
    campos, lat, lon = {}, None, None
    with tempfile.NamedTemporaryFile(suffix=".grb2") as f:
        f.write(contenido); f.flush()
        for g in pygrib.open(f.name):
            clave = (g["discipline"], g["parameterCategory"], g["parameterNumber"])
            nombre = next((k for k, v in COD.items() if v == clave), None)
            if nombre is None:
                continue
            tipo = {"isobaricInhPa": 100, "surface": 1, "heightAboveGround": 103}.get(g.typeOfLevel)
            if tipo is None:
                continue
            nivel = 0 if tipo == 1 else int(round(g.level))   # superficie: el nivel no importa
            campos[(nombre, tipo, nivel)] = np.ma.filled(g.values.astype(float), np.nan)
            if lat is None:
                lat, lon = g.latlons()
    return campos, lat, lon


def procesar(campos, lat, lon):
    def c(nombre, tipo, nivel):
        k = (nombre, tipo, nivel)
        if k not in campos:
            raise KeyError(f"falta {k}; hay {sorted(x for x in campos if x[1] != 100)}")
        return campos[k]
    p = np.array(NIVELES, float)
    lsm = c("lsm", 1, 0)
    mar = lsm < 0.5
    u10f, v10f = c("u", 103, 10), c("v", 103, 10)
    # Vorticidad relativa a 10 m en la grilla completa (antes de recortar al océano)
    R = 6.371e6
    latr, lonr = np.radians(lat), np.radians(lon)
    dvdx = np.gradient(v10f, axis=1) / (np.gradient(lonr, axis=1) * R * np.cos(latr))
    dudy = np.gradient(u10f, axis=0) / (np.gradient(latr, axis=0) * R)
    zeta = dvdx - dudy
    m = mar.ravel()
    sel = lambda a: a.ravel()[m]
    niv = lambda nombre: np.stack([sel(c(nombre, 100, n)) for n in NIVELES], 1)
    q = ti.calcular(p, sel(c("sp", 1, 0)) / 100.0, sel(c("gh", 1, 0)), sel(c("t", 103, 2)), sel(c("td", 103, 2)),
                    sel(u10f), sel(v10f), niv("gh"), niv("t"), niv("r"), niv("u"), niv("v"))
    q["nst"] = ti.nst(q["lr01"], q["mlcape3"], q["mlcin"], q["bwd06"], -sel(zeta))
    q["dT"] = sel(c("t", 1, 0)) - q["t850"]                 # TSM − T850 (°C)
    q["dZ"] = (q["el"] - q["mllcl"]) / 1000.0               # km
    q["w850"] = np.hypot(q["u850"], q["v850"]) * MS_A_KT    # kt
    lo = sel(lon)
    return q, sel(lat), np.where(lo > 180, lo - 360, lo)


def r(v, d):
    return None if v is None or not np.isfinite(v) else round(float(v), d)


def main():
    previo = leer(SALIDA, {})
    c = elegir_corrida()
    if c is None:
        print("Trombas: no hay corrida GFS con plazo 72 h disponible"); return
    tag = c.strftime("%Y-%m-%dT%HZ")
    if previo.get("corrida") == tag and previo.get("version") == VERSION and previo.get("completo", True):
        print("Trombas: sin corrida nueva", tag); return
    pasos, errores, t0 = [], [], time.time()
    for fhr in FHRS:
        try:
            campos, lat, lon = leer_grib(bajar(c, fhr))
            q, la, lo = procesar(campos, lat, lon)
        except Exception as e:
            import traceback
            linea = traceback.extract_tb(e.__traceback__)[-1]
            msj = f"f{fhr:03d}: {type(e).__name__}: {e} ({Path(linea.filename).name}:{linea.lineno})"
            print("  " + msj); errores.append(msj[:300]); continue
        stp, sh, ns = q["stp"], q["sherbe"], q["nst"]
        f_stp, f_sh, f_ns = stp <= UMBRAL["stp"], q["hslc"], ns > UMBRAL["nst"]
        idx = np.where(f_stp | f_sh | f_ns)[0]
        celdas = [[r(la[i], 2), r(lo[i], 2), r(stp[i], 2), r(sh[i], 2), r(ns[i], 2),
                   r(q["dT"][i], 1), r(q["dZ"][i], 1), r(q["w850"][i], 0), r(q["mlcape"][i], 0), r(q["srh500"][i], 0),
                   r(q["ebsmu"][i] * MS_A_KT, 0), r(q["mucape"][i], 0), r(q["vgp"][i], 2), r(q["mllcl"][i], 0), int(bool(q["hslc"][i]))] for i in idx]
        pasos.append({"fhr": fhr, "valida": (c + timedelta(hours=fhr)).strftime("%Y-%m-%dT%H:%MZ"),
                      "extremos": {"stp": r(np.nanmin(stp), 2), "sherbe": r(np.nanmax(sh), 2), "nst": r(np.nanmax(ns), 2), "vgp": r(np.nanmax(q["vgp"]), 2),
                                   "dT": r(np.nanmax(q["dT"]), 1)},
                      "n": {"stp": int(f_stp.sum()), "hslc": int(f_sh.sum()), "nst": int(f_ns.sum()), "puntos": int(stp.size)},
                      "celdas": celdas})
        print(f"  f{fhr:03d}: STP mín {np.nanmin(stp):.2f} · SHERBE máx {np.nanmax(sh):.2f} · NST máx {np.nanmax(ns):.2f} · {len(idx)} celdas")
        time.sleep(1)
    if len(pasos) < len(FHRS) // 2:
        print(f"Trombas: solo {len(pasos)} plazos procesados; se conserva el archivo anterior")
        if not previo.get("pasos"):   # sin archivo útil previo: publica el diagnóstico (completo=False → se reintenta)
            SALIDA.write_text(json.dumps({"version": VERSION, "corrida": tag, "completo": False, "pasos": [],
                                          "generado": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                                          "errores": errores[:8]}, ensure_ascii=False), encoding="utf-8")
        return
    salida = {"version": VERSION, "corrida": tag, "generado": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
              "fuente": "NOAA GFS 0,25° (filtro NOMADS)", "dominio": [SUR, OESTE, NORTE, ESTE], "paso_grilla": 0.25,
              "umbrales": UMBRAL, "solo_oceano": True, "completo": True, "errores": errores[:8],
              "columnas": ["lat", "lon", "stp", "sherbe", "nst", "dT", "dZ_km", "w850_kt", "mlcape", "srh500", "ebsmu_kt", "mucape", "vgp", "mllcl", "hslc"],
              "pasos": pasos}
    SALIDA.write_text(json.dumps(salida, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Trombas: corrida {tag}, {len(pasos)} plazos, {time.time() - t0:.0f} s")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("Trombas: error", e)
