#!/usr/bin/env python3
"""Probabilidad de ambiente favorable a trombas en las zonas III a VI con el ensamble GEFS → data/trombas_prob.json

Para la corrida GEFS de 00 o 12 UTC más reciente con plazo 72 h disponible, baja los 31 miembros (control gec00 y
perturbados gep01–gep30) a 0,5°, de 0 a 72 h cada 6 h, recortados a 32°–48,5° S / 81,5°–71° W (filtro NOMADS, archivos
pgrb2a), y en cada miembro calcula STP (hemisferio sur), SHERBE y NST con scripts/trombas_indices.py sobre los
puntos de mar de las zonas III (Valparaíso a Constitución), IV (Constitución a Isla Mocha), V (Isla Mocha a
Puerto Montt) y VI (Puerto Montt a San Pedro) del Cuadro "F" (data/geo/metarea.json), con salida libre al océano (sin canales ni aguas interiores).

Probabilidad = porcentaje de miembros en que al menos un punto del área supera el umbral del índice
(STP ≤ −0,1; ambiente HSLC; NST > 1; ver UMBRAL), más el criterio combinado "alguno" (cualquiera de los tres).
Por plazo y por día (hora de Chile: al menos una vez en el día). Además, la misma probabilidad en cada punto de mar
(prob_punto y prob_punto_dia), para dibujarla en el mapa.
Limitaciones: el GEFS 0,5° (pgrb2a) solo tiene 1000, 925 y 850 hPa bajo 700 hPa (y 500, 250, 200 arriba), por lo que el SRH 0–500 m y el
gradiente 0–1 km quedan más suavizados que en el GFS 0,25°. Los umbrales no están calibrados para trombas.
Estimación experimental: no constituye aviso. Solo corre con corrida nueva; nunca hace fallar el flujo.
"""
import json
import sys
import tempfile
import time
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import trombas_indices as ti  # noqa: E402
import geo as va            # noqa: E402  (polígonos de tierra de data/geo/land.json)

DATA = Path(__file__).resolve().parent.parent / "data"
SALIDA = DATA / "trombas_prob.json"
VERSION = 4
TZ = ZoneInfo("America/Santiago")
CAB = {"User-Agent": "dashboard-meteo-publico/1.0 (trombas GEFS)"}
NORTE, SUR, OESTE, ESTE = -32, -48.5, -81.5, -71
ZONAS = ["III", "IV", "V", "VI"]
NIVELES = [1000, 925, 850, 700, 500, 250, 200]   # niveles comunes a HGT, TMP, RH y viento en pgrb2a
FHRS = list(range(0, 73, 6))
MIEMBROS = ["gec00"] + [f"gep{i:02d}" for i in range(1, 31)]
MIN_MIEMBROS = 20
HILOS = 3            # descargas simultáneas a NOMADS (~120 solicitudes por minuto como máximo)
PRESUPUESTO = 540    # s: tope de descarga para no exceder el tiempo del flujo; los miembros incompletos se omiten
# Umbrales (ajustados a estudios chilenos):
#   STP ≤ −0,1: los máximos de STP de los 16 tornados notables de Chile estuvieron entre −0,1 y −0,9 (Marín et al., 2024,
#              MWR 152); además cerca de la mitad de los tornados chilenos tuvo STP = 0 (Marín et al., 2026), así que
#              el STP solo no basta.
#   HSLC:      MUCAPE 0–1000 J/kg, EBSMU > 18 m/s y SHERBE ≥ 1 (definición de Marín et al., 2026, Atmos. Res. 344).
#   NST > 1:   SPC/NWS; sin validación en Chile (referencia para trombas de buen tiempo).
UMBRAL = {"stp": -0.1, "hslc": True, "nst": 1.0}
CRITERIOS = ("stp", "hslc", "nst", "alguno")   # "alguno" = se cumple cualquiera de los tres umbrales
COD = {"gh": (0, 3, 5), "t": (0, 0, 0), "r": (0, 1, 1), "u": (0, 2, 2), "v": (0, 2, 3), "sp": (0, 3, 0)}
TIPO = {"isobaricInhPa": 100, "surface": 1, "heightAboveGround": 103}


def leer(p, defecto):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except Exception:
        return defecto


def disponible(c):
    d, h = c.strftime("%Y%m%d"), c.strftime("%H")
    url = f"https://noaa-gefs-pds.s3.amazonaws.com/gefs.{d}/{h}/atmos/pgrb2ap5/gep30.t{h}z.pgrb2a.0p50.f{FHRS[-1]:03d}.idx"
    try:
        return requests.head(url, headers=CAB, timeout=20).status_code == 200
    except Exception:
        return False


def elegir_corrida():
    ahora = datetime.now(timezone.utc)
    c = ahora.replace(minute=0, second=0, microsecond=0, hour=ahora.hour // 12 * 12)
    for _ in range(3):
        if disponible(c):
            return c
        c -= timedelta(hours=12)
    return None


def bajar(c, miembro, fhr):
    d, h = c.strftime("%Y%m%d"), c.strftime("%H")
    par = {"dir": f"/gefs.{d}/{h}/atmos/pgrb2ap5", "file": f"{miembro}.t{h}z.pgrb2a.0p50.f{fhr:03d}",
           "subregion": "", "toplat": NORTE, "bottomlat": SUR, "leftlon": OESTE + 360, "rightlon": ESTE + 360}
    for v in ("HGT", "TMP", "RH", "UGRD", "VGRD", "PRES"):
        par[f"var_{v}"] = "on"
    for n in NIVELES:
        par[f"lev_{n}_mb"] = "on"
    for lv in ("surface", "2_m_above_ground", "10_m_above_ground"):
        par[f"lev_{lv}"] = "on"
    for intento in range(3):
        try:
            r = requests.get("https://nomads.ncep.noaa.gov/cgi-bin/filter_gefs_atmos_0p50a.pl", params=par, headers=CAB, timeout=60)
            if r.status_code == 200 and r.content[:4] == b"GRIB":
                return r.content
            raise RuntimeError(f"HTTP {r.status_code}")
        except Exception:
            if intento == 2:
                raise
            time.sleep(8 * (intento + 1))


def leer_grib(contenido):
    import pygrib
    campos, lat, lon = {}, None, None
    with tempfile.NamedTemporaryFile(suffix=".grb2") as f:
        f.write(contenido); f.flush()
        for g in pygrib.open(f.name):
            clave = (g["discipline"], g["parameterCategory"], g["parameterNumber"])
            nombre = next((k for k, v in COD.items() if v == clave), None)
            tipo = TIPO.get(g.typeOfLevel)
            if nombre is None or tipo is None:
                continue
            nivel = 0 if tipo == 1 else int(round(g.level))
            campos[(nombre, tipo, nivel)] = np.ma.filled(g.values.astype(float), np.nan)
            if lat is None:
                lat, lon = g.latlons()
    return campos, lat, lon


def seleccionar(lat1, lon1):
    """Puntos de mar de cada zona del Cuadro "F" con salida libre al océano hacia el oeste (al sur de 41,4° S,
    también WNW y WSW), igual criterio que las alertas de viento y marejadas."""
    import math
    import shapely
    from shapely.geometry import LineString, shape
    t = va.tierra(); shapely.prepare(t)
    poli = {f["properties"]["id"]: (f["properties"].get("nombre", ""), shape(f["geometry"]).buffer(0.05))
            for f in json.loads((DATA / "geo" / "metarea.json").read_text(encoding="utf-8"))["features"]
            if f["properties"]["id"] in ZONAS}
    I, J = np.meshgrid(np.arange(lat1.size), np.arange(lon1.size), indexing="ij")
    I, J = I.ravel(), J.ravel(); LA, LO = lat1[I], lon1[J]
    mar = ~shapely.contains_xy(t, LO, LA)
    out = {}
    for z in ZONAS:
        nombre, g = poli[z]
        k = np.where(mar & shapely.contains_xy(g, LO, LA))[0]
        libre = []
        for idx in k:
            rumbos = (0, 30, -30) if LA[idx] < -41.4 else (0,)
            libre.append(not any(t.intersects(LineString([(LO[idx], LA[idx]), (LO[idx] - 4, LA[idx] + 4 * math.tan(math.radians(a)))])) for a in rumbos))
        k = k[np.array(libre, bool)] if len(k) else k
        out[z] = {"nombre": nombre, "i": I[k], "j": J[k], "lat": LA[k], "lon": LO[k]}
    return out


def indices(campos, lat, lon, flat_idx):
    def c(nombre, tipo, nivel):
        k = (nombre, tipo, nivel)
        if k not in campos:
            raise KeyError(f"falta {k}")
        return campos[k]
    u10f, v10f = c("u", 103, 10), c("v", 103, 10)
    R = 6.371e6
    latr, lonr = np.radians(lat), np.radians(lon)
    zeta = np.gradient(v10f, axis=1) / (np.gradient(lonr, axis=1) * R * np.cos(latr)) - np.gradient(u10f, axis=0) / (np.gradient(latr, axis=0) * R)
    sel = lambda a: a.ravel()[flat_idx]
    niv = lambda nombre: np.stack([sel(c(nombre, 100, n)) for n in NIVELES], 1)
    t2 = sel(c("t", 103, 2))
    rh2 = np.clip(sel(c("r", 103, 2)), 1, 100)
    td2 = ti.td_de_w(ti.EPS * (rh2 / 100 * ti.es_hpa(t2)) / (sel(c("sp", 1, 0)) / 100 - rh2 / 100 * ti.es_hpa(t2)), sel(c("sp", 1, 0)) / 100)
    zsfc = sel(campos[("gh", 1, 0)]) if ("gh", 1, 0) in campos else np.zeros(len(flat_idx))   # pgrb2a no trae HGT de superficie; sobre el mar es 0 m
    q = ti.calcular(np.array(NIVELES, float), sel(c("sp", 1, 0)) / 100.0, zsfc, t2, td2,
                    sel(u10f), sel(v10f), niv("gh"), niv("t"), niv("r"), niv("u"), niv("v"))
    q["nst"] = ti.nst(q["lr01"], q["mlcape3"], q["mlcin"], q["bwd06"], -sel(zeta))
    return q


def excedencias(q):
    """Puntos que cumplen cada criterio (arreglos booleanos)."""
    ex = {"stp": np.asarray(q["stp"] <= UMBRAL["stp"], bool), "hslc": np.asarray(q["hslc"], bool),
          "nst": np.asarray(q["nst"] > UMBRAL["nst"], bool)}
    ex["alguno"] = ex["stp"] | ex["hslc"] | ex["nst"]
    return ex


def resumir(pts, ok, areas, pos, lat_p, lon_p, validas, paso):
    """pts[miembro][criterio] = booleano (plazos × puntos). Devuelve los campos de probabilidad del archivo de salida:
    por zona (algún punto de la zona) y por punto, cada 6 h y por día de Chile (al menos una vez en el día)."""
    dias = sorted({v.astimezone(TZ).date().isoformat() for v in validas})
    cols = {d: [k for k, v in enumerate(validas) if v.astimezone(TZ).date().isoformat() == d] for d in dias}
    pct = lambda x: [int(v) for v in np.rint(100 * x)]
    prob, prob_dia, pp, ppd = {a: {} for a in areas}, {a: {} for a in areas}, {}, {}
    for ind in CRITERIOS:
        cubo = np.stack([pts[m][ind] for m in ok])                     # miembros × plazos × puntos
        for a in areas:
            mat = cubo[:, :, pos[a]].any(2)                            # miembros × plazos
            prob[a][ind] = pct(mat.mean(0))
            prob_dia[a][ind] = {d: pct(mat[:, cols[d]].any(1).mean(keepdims=True))[0] for d in dias}
        pp[ind] = [pct(cubo[:, k].mean(0)) for k in range(len(validas))]
        ppd[ind] = {d: pct(cubo[:, cols[d]].any(1).mean(0)) for d in dias}
    zona = [""] * len(lat_p)
    for a in areas:
        for k in pos[a]:
            zona[k] = zona[k] or a
    return {"validas": [v.strftime("%Y-%m-%dT%H:%MZ") for v in validas], "dias": dias,
            "prob": prob, "prob_dia": prob_dia,
            "grilla": {"paso": paso, "puntos": [[round(float(la), 2), round(float(lo), 2)] for la, lo in zip(lat_p, lon_p)], "zona": zona},
            "prob_punto": pp, "prob_punto_dia": ppd}


def main():
    previo = leer(SALIDA, {})
    c = elegir_corrida()
    if c is None:
        print("Trombas GEFS: no hay corrida 00/12 UTC con plazo 72 h disponible"); return
    tag = c.strftime("%Y-%m-%dT%HZ")
    if previo.get("corrida") == tag and previo.get("version") == VERSION and previo.get("completo", True):
        print("Trombas GEFS: sin corrida nueva", tag); return
    t0 = time.time()
    areas, flat = None, None
    # pts[miembro][criterio] = plazos × puntos de mar (booleano)
    pts, errores, ok_miembros = {}, [], []
    # Descarga en paralelo (HILOS) con tope de tiempo: en serie los 403 archivos tardaban más que el flujo completo.
    from concurrent.futures import ThreadPoolExecutor
    def bajar_con_tope(args):
        m, fhr = args
        if time.time() - t0 > PRESUPUESTO:
            raise TimeoutError("tope de tiempo de descarga")
        return bajar(c, m, fhr)
    with ThreadPoolExecutor(HILOS) as ex:
        futuros = {(m, fhr): ex.submit(bajar_con_tope, (m, fhr)) for m in MIEMBROS for fhr in FHRS}
    print(f"  descargas terminadas ({time.time() - t0:.0f} s)")
    for m in MIEMBROS:
        fm = None
        try:
            for k, fhr in enumerate(FHRS):
                campos, lat, lon = leer_grib(futuros[(m, fhr)].result())
                if areas is None:   # puntos de mar por área, una sola vez (grilla fija)
                    lat1, lon1 = lat[:, 0], np.where(lon[0] > 180, lon[0] - 360, lon[0])
                    areas = {a: v for a, v in seleccionar(lat1, lon1).items() if len(v["i"])}
                    todos = np.concatenate([v["i"] * lon.shape[1] + v["j"] for v in areas.values()])
                    flat, inv = np.unique(todos, return_inverse=True)
                    pos, ini = {}, 0
                    for a, v in areas.items():
                        pos[a] = inv[ini:ini + len(v["i"])]; ini += len(v["i"])
                    lat_p, lon_p = lat1[flat // lon.shape[1]], lon1[flat % lon.shape[1]]
                    paso = round(float(abs(lat1[1] - lat1[0])), 3)
                q = indices(campos, lat, lon, flat)
                if fm is None:
                    fm = {ind: np.zeros((len(FHRS), len(flat)), bool) for ind in CRITERIOS}
                for ind, f in excedencias(q).items():
                    fm[ind][k] = f
            pts[m] = fm; ok_miembros.append(m)
        except Exception as e:
            ln = traceback.extract_tb(e.__traceback__)[-1]
            errores.append(f"{m}: {type(e).__name__}: {e} ({Path(ln.filename).name}:{ln.lineno})"[:300])
            print("  " + errores[-1])
        print(f"  {m}: {'ok' if m in pts else 'error'} ({time.time() - t0:.0f} s)")
    gen = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if len(ok_miembros) < MIN_MIEMBROS:
        print(f"Trombas GEFS: solo {len(ok_miembros)} miembros; se conserva el archivo anterior")
        if not previo.get("prob"):
            SALIDA.write_text(json.dumps({"version": VERSION, "corrida": tag, "completo": False, "generado": gen,
                                          "errores": errores[:8]}, ensure_ascii=False), encoding="utf-8")
        return
    validas = [c + timedelta(hours=f) for f in FHRS]
    n = len(ok_miembros)
    salida = {"version": VERSION, "corrida": tag, "generado": gen, "completo": True,
              "fuente": f"NOAA GEFS 0,5° ({n} miembros, filtro NOMADS)", "miembros": n, "umbrales": UMBRAL,
              "areas": [{"id": a, "nombre": f"Zona {a} · {areas[a]['nombre']}", "puntos": [[round(float(la), 2), round(float(lo), 2)]
                         for la, lo in zip(areas[a]["lat"], areas[a]["lon"])]} for a in areas],
              **resumir(pts, ok_miembros, areas, pos, lat_p, lon_p, validas, paso), "errores": errores[:8]}
    SALIDA.write_text(json.dumps(salida, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Trombas GEFS: corrida {tag}, {n} miembros, {time.time() - t0:.0f} s")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("Trombas GEFS: error", e)
