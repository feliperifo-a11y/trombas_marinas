#!/usr/bin/env python3
"""Ríos atmosféricos con el GFS 0,25° → data/ivt.json, ivt.bin, ivt_extra.bin, ivt_hist.json e ivt_hist.bin

IVT = (1/g) ∫ q·V dp, desde la superficie hasta 300 hPa, con la humedad específica (SPFH) y el viento (UGRD, VGRD) en
17 niveles de presión (1000 a 300 hPa). Se integra por trapecios solo sobre los niveles que están sobre la superficie.
Además: agua precipitable (IWV, PWAT del GFS), altura de la isoterma de 0 °C (HGT en el nivel 0C_isotherm), precipitación
acumulada en 6 días (APCP) y un corte vertical del flujo de vapor q·|V| a lo largo de 77° W, como los productos del
IANIGLA-CONICET (https://ianigla.net/rios_atmosfericos/).
Dominio: Pacífico suroriental y Chile, 17°–57° S / 110°–66° W. Plazos: 0 a 144 h cada 3 h (filtro NOMADS).

Salida (pensada para el navegador), celdas de 0,5°, un byte por valor y 255 = sin dato:
  - ivt.bin: para cada plazo, cuatro capas: IVT/10 (kg m⁻¹ s⁻¹), dirección hacia donde va el transporte/2 (grados),
    IWV (kg m⁻²) e isoterma de 0 °C/100 (m). La página lo baja una vez y saca la serie de cualquier punto (necesaria
    para la escala de Ralph et al., 2019, que usa máximo y duración).
  - ivt_extra.bin: precipitación acumulada 0–144 h (uint16, décimas de mm) y, por plazo, el corte en 77° W:
    q·|V|/2 (g kg⁻¹ m s⁻¹) y dirección/2 en cada nivel y latitud.
  - ivt_hist.*: los análisis (0 y 3 h) de las corridas de las últimas 48 h, con las mismas cuatro capas, para mostrar lo
    ocurrido antes del pronóstico.
  - ivt.json: grilla, plazos, celdas costeras (océano con tierra al este) y descripción de los archivos.
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
INDICE, BINARIO, EXTRA = DATA / "ivt.json", DATA / "ivt.bin", DATA / "ivt_extra.bin"
HIST_J, HIST_B = DATA / "ivt_hist.json", DATA / "ivt_hist.bin"
VERSION = 2
HORAS_HIST = 48
LON_CORTE = -77.0
CAB = {"User-Agent": "dashboard-meteo-publico/1.0 (ivt GFS)"}
NORTE, SUR, OESTE, ESTE = -17, -57, -110, -66
NIVELES = [1000, 975, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300]
FHRS = list(range(0, 145, 3))
G = 9.80665
SUB = 2            # se publica cada 2 celdas: 0,5°
SIN_DATO = 255
# Códigos WMO GRIB2: (disciplina, categoría, número)
COD = {"q": (0, 1, 0), "u": (0, 2, 2), "v": (0, 2, 3), "sp": (0, 3, 0), "lsm": (2, 0, 0), "pwat": (0, 1, 3),
       "hgt": (0, 3, 5), "apcp": (0, 1, 8)}
CAPAS = [("ivt", 10.0), ("dir", 2.0), ("iwv", 1.0), ("iso0", 100.0)]


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
           "var_SPFH": "on", "var_UGRD": "on", "var_VGRD": "on", "var_PRES": "on", "lev_surface": "on",
           "var_PWAT": "on", "lev_entire_atmosphere_(considered_as_a_single_layer)": "on", "var_HGT": "on", "lev_0C_isotherm": "on"}
    if fhr > 0:
        par["var_APCP"] = "on"
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
    campos, lat, lon = {"apcp": {}}, None, None
    with tempfile.NamedTemporaryFile(suffix=".grb2") as f:
        f.write(contenido); f.flush()
        for g in pygrib.open(f.name):
            clave = (g["discipline"], g["parameterCategory"], g["parameterNumber"])
            nombre = next((k for k, v in COD.items() if v == clave), None)
            if nombre is None:
                continue
            x = np.ma.filled(g.values.astype(float), np.nan)
            if nombre == "apcp":
                campos["apcp"][(int(g["startStep"]), int(g["endStep"]))] = x      # balde y/o acumulado desde 0 h
            elif g.typeOfLevel == "isobaricInhPa":
                if nombre != "hgt":
                    campos[(nombre, int(round(g.level)))] = x
            elif g.typeOfLevel == "isothermZero" and nombre == "hgt":
                campos["iso0"] = x
            elif g.typeOfLevel in ("surface", "atmosphereSingleLayer", "atmosphere") and nombre != "hgt":
                campos[nombre] = x
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
        print(f"IVT GFS: no hay una corrida reciente con plazo {FHRS[-1]} h; se mantiene el archivo anterior.")
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
    capas, lat, lon, tierra, apcp, corte, analisis = [], None, None, None, {}, [], []
    for fhr in FHRS:
        campos, la, lo = leer_grib(contenidos.pop(fhr))
        if lat is None:
            lat, lon = la, lo
            jc = int(np.argmin(np.abs(((lon[0] + 180) % 360) - 180 - LON_CORTE)))
        if "lsm" in campos:
            tierra = campos["lsm"] >= 0.5
        apcp.update(campos["apcp"])
        iu, iv = ivt(campos)
        mag = np.hypot(iu, iv)
        dr = np.degrees(np.arctan2(iu, iv)) % 360.0                      # hacia donde va el transporte
        nan = np.full_like(mag, np.nan)
        valores = {"ivt": mag, "dir": dr, "iwv": campos.get("pwat", nan), "iso0": campos.get("iso0", nan)}
        plazo = [byte(valores[k][::SUB, ::SUB], e, 180 if k == "dir" else None) for k, e in CAPAS]
        capas += plazo
        if fhr in (0, 3):
            analisis.append(((c + timedelta(hours=fhr)).strftime("%Y-%m-%dT%H:%MZ"), plazo))
        corte += corte_77(campos, jc)
        print(f"  f{fhr:03d}: IVT máx {np.nanmax(mag):.0f} kg m⁻¹ s⁻¹, IWV máx {np.nanmax(valores['iwv']):.0f} kg m⁻²")
    la1, lo1 = lat[::SUB, 0], ((lon[0, ::SUB] + 180) % 360) - 180
    nlat, nlon = len(la1), len(lo1)
    # Celdas costeras: océano con tierra inmediatamente al este (en la grilla publicada de 0,5°)
    costa = []
    if tierra is not None:
        t = tierra[::SUB, ::SUB]
        for i in range(nlat):
            for j in range(nlon - 1):
                if not t[i, j] and t[i, j + 1]:
                    costa.append([i, j])
                    break                                      # la primera costa desde el oeste (deja fuera lagos e islas interiores)
    pp, horas_pp = acumular(apcp, FHRS[-1])
    if pp is not None:
        pp = pp[::SUB, ::SUB]
        pp_b = np.where(np.isfinite(pp), np.clip(np.rint(pp * 10), 0, 65534), 65535).astype("<u2")
    else:
        pp_b = np.full((nlat, nlon), 65535, "<u2")
    gen = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    BINARIO.write_bytes(np.stack(capas).tobytes())
    EXTRA.write_bytes(pp_b.tobytes() + np.stack(corte).tobytes())
    rejilla = {"lat0": round(float(la1[0]), 3), "lon0": round(float(lo1[0]), 3), "dlat": round(float(la1[1] - la1[0]), 3),
               "dlon": round(float(lo1[1] - lo1[0]), 3), "nlat": nlat, "nlon": nlon}
    hist = historial(analisis, rejilla, c)
    salida = {"version": VERSION, "corrida": tag, "generado": gen, "clave": tag.replace(":", ""),
              "fuente": "NOAA GFS 0,25° (filtro NOMADS); IVT integrado de superficie a 300 hPa, publicado a 0,5°",
              **rejilla, "sin_dato": SIN_DATO,
              "campos": [{"clave": k, "escala": e} for k, e in CAPAS],
              "plazos": [{"paso": f, "valido": (c + timedelta(hours=f)).strftime("%Y-%m-%dT%H:%MZ")} for f in FHRS],
              "costa": costa, "archivo": "ivt.bin",
              "extra": {"archivo": "ivt_extra.bin", "pp_horas": horas_pp, "pp_escala": 10,
                        "corte": {"lon": round(float(((lon[0, jc] + 180) % 360) - 180), 2), "niveles": NIVELES, "escala": 2.0,
                                  "unidad": "g kg⁻¹ m s⁻¹", "campos": ["flujo", "dir"]}},
              "historial": {"archivo": "ivt_hist.bin", "clave": hist["clave"], "n": len(hist["validos"])}}
    INDICE.write_text(json.dumps(salida, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"IVT GFS: corrida {tag}, {len(FHRS)} plazos, {nlat}×{nlon} celdas, {len(costa)} celdas costeras, "
          f"lluvia {horas_pp} h, historial {len(hist['validos'])} análisis, "
          f"{BINARIO.stat().st_size / 1e6:.2f} + {EXTRA.stat().st_size / 1e6:.2f} MB, {time.time() - t0:.0f} s")


def byte(x, escala, modulo=None):
    v = np.rint(x / escala)
    if modulo:
        v = v % modulo
    return np.where(np.isfinite(x), np.clip(v, 0, 254), SIN_DATO).astype(np.uint8)


def corte_77(campos, jc):
    """Flujo de vapor q·|V| (g kg⁻¹ m s⁻¹) y su dirección en cada nivel a lo largo de la columna jc (77° W)."""
    ps = campos["sp"][::SUB, jc]
    flujo, dirs = [], []
    for n in NIVELES:
        q, u, v = (campos[(k, n)][::SUB, jc] for k in ("q", "u", "v"))
        f = q * 1000.0 * np.hypot(u, v)
        f = np.where(ps >= n * 100.0, f, np.nan)                          # bajo la superficie: sin dato
        flujo.append(byte(f, 2.0)); dirs.append(byte(np.degrees(np.arctan2(u, v)) % 360.0, 2.0, 180))
    return [np.stack(flujo), np.stack(dirs)]


def acumular(apcp, fin):
    """Precipitación 0–fin h encadenando los acumulados del GFS (baldes de 6 h o acumulados desde 0 h)."""
    total, pos = None, 0
    while pos < fin:
        cand = [e for (s, e) in apcp if s == pos and e <= fin]
        if not cand:
            break
        e = max(cand)
        total = apcp[(pos, e)] if total is None else total + apcp[(pos, e)]
        pos = e
    if pos < fin:
        print(f"::warning::IVT GFS: precipitación acumulada solo hasta {pos} h")
    return total, pos


def historial(analisis, rejilla, c):
    """Agrega los análisis de esta corrida a los de las últimas 48 h (mismo orden de capas que ivt.bin)."""
    previo = leer(HIST_J, {})
    nc, tam = len(CAPAS), rejilla["nlat"] * rejilla["nlon"]
    validos, bloques = [], []
    if all(previo.get(k) == v for k, v in rejilla.items()) and HIST_B.exists():
        b = np.frombuffer(HIST_B.read_bytes(), np.uint8)
        if b.size == len(previo.get("validos", [])) * nc * tam:
            b = b.reshape(-1, nc, tam)
            validos = list(previo["validos"]); bloques = [b[k] for k in range(len(validos))]
    nuevos = {v: np.stack(p).reshape(nc, tam) for v, p in analisis}
    juntos = {v: x for v, x in zip(validos, bloques) if v not in nuevos} | nuevos
    limite = c - timedelta(hours=HORAS_HIST)
    orden = sorted(v for v in juntos if datetime.strptime(v, "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc) >= limite)
    HIST_B.write_bytes(np.stack([juntos[v] for v in orden]).tobytes() if orden else b"")
    sal = {**rejilla, "version": VERSION, "clave": c.strftime("%Y%m%dT%HZ"), "validos": orden, "archivo": "ivt_hist.bin"}
    HIST_J.write_text(json.dumps(sal, separators=(",", ":")), encoding="utf-8")
    return sal


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # nunca botar el flujo de trabajo
        print(f"::warning::IVT GFS: {e}")
        sys.exit(0)
