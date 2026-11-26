#!/usr/bin/env python3
"""Ríos atmosféricos: transporte integrado de vapor de agua (IVT) del GFS 0,25° → data/ivt.json + data/ivt.bin

IVT = (1/g) ∫ q·V dp, desde la superficie hasta 300 hPa, con la humedad específica (SPFH) y el viento (UGRD, VGRD) en
17 niveles de presión (1000 a 300 hPa). Se integra por trapecios solo sobre los niveles que están sobre la superficie.
Dominio: Pacífico suroriental y Chile, 20°–57° S / 110°–66° W, para ver los ríos atmosféricos antes de que lleguen a la costa.
Plazos: 0 a 120 h cada 3 h, corrida GFS más reciente con plazo 120 h disponible (filtro NOMADS).

Salida (pensada para el navegador):
  - ivt.bin: para cada plazo, dos capas de un byte por celda de 0,5°: magnitud/10 (kg m⁻¹ s⁻¹; 255 = sin dato) y
    dirección hacia donde va el transporte/2 (grados). Un solo archivo: la página lo baja una vez y saca de ahí la serie
    de cualquier punto (necesaria para la escala de Ralph et al., 2019, que usa máximo y duración).
  - ivt.json: grilla, plazos y celdas costeras (océano con tierra al este) para la escala en la costa.
Solo trabaja con una corrida nueva. Estimación automática: no constituye aviso. Nunca hace fallar el flujo de trabajo.
"""
import json
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import requests

DATA = Path(__file__).resolve().parent.parent / "data"
INDICE, BINARIO = DATA / "ivt.json", DATA / "ivt.bin"
VERSION = 1
CAB = {"User-Agent": "dashboard-meteo-publico/1.0 (ivt GFS)"}
NORTE, SUR, OESTE, ESTE = -20, -57, -110, -66
NIVELES = [1000, 975, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300]
FHRS = list(range(0, 121, 3))
G = 9.80665
SUB = 2            # se publica cada 2 celdas: 0,5°
SIN_DATO = 255
# Códigos WMO GRIB2: (disciplina, categoría, número)
COD = {"q": (0, 1, 0), "u": (0, 2, 2), "v": (0, 2, 3), "sp": (0, 3, 0), "lsm": (2, 0, 0)}


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
           "subregion": "", "toplat": NORTE, "bottomlat": SUR, "leftlon": OESTE + 360, "rightlon": ESTE + 360,
           "var_SPFH": "on", "var_UGRD": "on", "var_VGRD": "on", "var_PRES": "on", "lev_surface": "on"}
    if fhr == 0:
        par["var_LAND"] = "on"
    for n in NIVELES:
        par[f"lev_{n}_mb"] = "on"
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
            if g.typeOfLevel == "isobaricInhPa":
                campos[(nombre, int(round(g.level)))] = np.ma.filled(g.values.astype(float), np.nan)
            elif g.typeOfLevel == "surface":
                campos[nombre] = np.ma.filled(g.values.astype(float), np.nan)
            if lat is None:
                lat, lon = g.latlons()
    return campos, lat, lon


def ivt(campos):
    """Componentes del IVT (kg m⁻¹ s⁻¹) integrando por trapecios desde la superficie hasta 300 hPa."""
    p = np.array(NIVELES, float) * 100.0                     # Pa, de abajo hacia arriba
    ps = campos["sp"]
    q = np.stack([campos[("q", n)] for n in NIVELES])
    fu = q * np.stack([campos[("u", n)] for n in NIVELES])
    fv = q * np.stack([campos[("v", n)] for n in NIVELES])
    iu, iv = np.zeros_like(ps), np.zeros_like(ps)
    # bajo 1000 hPa (superficie con presión mayor): se usa el valor de 1000 hPa
    extra = np.clip(ps - p[0], 0, None)
    iu += fu[0] * extra; iv += fv[0] * extra
    for k in range(len(p) - 1):
        abajo, arriba = p[k], p[k + 1]
        tope = np.minimum(abajo, ps)                          # parte de la capa que está sobre la superficie
        dp = np.clip(tope - arriba, 0, None)
        base = np.where(abajo <= ps, 1.0, 0.0)                # si el nivel inferior está bajo tierra, se usa el superior
        au = 0.5 * (np.where(base > 0, fu[k], fu[k + 1]) + fu[k + 1])
        av = 0.5 * (np.where(base > 0, fv[k], fv[k + 1]) + fv[k + 1])
        iu += au * dp; iv += av * dp
    return iu / G, iv / G


def main():
    previo = leer(INDICE, {})
    c = elegir_corrida()
    if c is None:
        print("IVT GFS: no hay una corrida reciente con plazo 120 h; se mantiene el archivo anterior.")
        return
    tag = c.strftime("%Y-%m-%dT%HZ")
    if previo.get("corrida") == tag and previo.get("version") == VERSION and BINARIO.exists():
        print(f"IVT GFS: la corrida {tag} ya está procesada.")
        return
    t0 = time.time()
    contenidos = {}
    with ThreadPoolExecutor(4) as ex:     # cuatro descargas a la vez, dentro de lo que tolera NOMADS
        for fhr, b in zip(FHRS, ex.map(lambda f: bajar(c, f), FHRS)):
            contenidos[fhr] = b
    capas, lat, lon, tierra = [], None, None, None
    for fhr in FHRS:
        campos, la, lo = leer_grib(contenidos.pop(fhr))
        if lat is None:
            lat, lon = la, lo
        if "lsm" in campos:
            tierra = campos["lsm"] >= 0.5
        iu, iv = ivt(campos)
        mag = np.hypot(iu, iv)[::SUB, ::SUB]
        dr = (np.degrees(np.arctan2(iu, iv)) % 360.0)[::SUB, ::SUB]       # hacia donde va el transporte
        b_mag = np.where(np.isfinite(mag), np.clip(np.rint(mag / 10.0), 0, 254), SIN_DATO).astype(np.uint8)
        b_dir = np.where(np.isfinite(dr), np.rint(dr / 2.0) % 180, SIN_DATO).astype(np.uint8)
        capas += [b_mag, b_dir]
        print(f"  f{fhr:03d}: IVT máx {np.nanmax(mag):.0f} kg m⁻¹ s⁻¹")
    la1, lo1 = lat[::SUB, 0], ((lon[0, ::SUB] + 180) % 360) - 180
    nlat, nlon = len(la1), len(lo1)
    # Celdas costeras: océano con tierra inmediatamente al este (en la grilla publicada de 0,5°)
    costa = []
    if tierra is not None:
        t = tierra[::SUB, ::SUB]
        for i in range(nlat):
            for j in range(nlon - 1):
                if not t[i, j] and t[i, j + 1] and la1[i] <= -18:
                    costa.append([i, j])
                    break                                      # la primera costa desde el oeste (deja fuera lagos e islas interiores)
    gen = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    BINARIO.write_bytes(np.stack(capas).tobytes())
    salida = {"version": VERSION, "corrida": tag, "generado": gen, "clave": tag.replace(":", ""),
              "fuente": "NOAA GFS 0,25° (filtro NOMADS); IVT integrado de superficie a 300 hPa, publicado a 0,5°",
              "lat0": round(float(la1[0]), 3), "lon0": round(float(lo1[0]), 3), "dlat": round(float(la1[1] - la1[0]), 3),
              "dlon": round(float(lo1[1] - lo1[0]), 3), "nlat": nlat, "nlon": nlon, "sin_dato": SIN_DATO,
              "campos": [{"clave": "ivt", "escala": 0.1}, {"clave": "dir", "escala": 0.5}],
              "plazos": [{"paso": f, "valido": (c + timedelta(hours=f)).strftime("%Y-%m-%dT%H:%MZ")} for f in FHRS],
              "costa": costa, "archivo": "ivt.bin"}
    INDICE.write_text(json.dumps(salida, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"IVT GFS: corrida {tag}, {len(FHRS)} plazos, {nlat}×{nlon} celdas, {len(costa)} celdas costeras, "
          f"{BINARIO.stat().st_size / 1e6:.2f} MB, {time.time() - t0:.0f} s")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # nunca botar el flujo de trabajo
        print(f"::warning::IVT GFS: {e}")
        sys.exit(0)
