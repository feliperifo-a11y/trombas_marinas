#!/usr/bin/env python3
"""Qué mostraba el modelo en cada aviso de trombas marinas → data/trombas_avisos.json (archivo en el repositorio)

Cada vez que data/avisos.json trae un aviso de trombas marinas (aviso especial de un CMM), calcula con el GFS 0,25°
los ingredientes convectivos sobre el mar del área del aviso, cada 3 h dentro de su vigencia, en tres etapas:
  · emision:    la corrida GFS que el pronosticador tenía disponible al emitir (publicación − 5 h, redondeada a 6 h).
  · referencia: la misma área y las mismas horas, 7 días antes (análisis y plazo de 3 h), como día de comparación.
  · durante:    análisis y plazo de 3 h de cada hora de la vigencia, una vez terminado el aviso (lo que de verdad hubo).
Área: zonas del Cuadro "F" que nombra el aviso (desde su límite norte), puntos de mar a 1° o menos de la costa.
Por variable guarda percentiles 10, 50 y 90, mínimo y máximo de todos los puntos y horas, más conteos sobre umbral.
El archivo se acumula: con el tiempo muestra qué condiciones acompañan a los avisos de trombas.
Avisos anteriores: data/trombas_avisos_historicos.json (lista curada: oficiales y de prensa que citan al CMM).
NOMADS guarda unos 10 días de corridas; para fechas anteriores se lee el archivo del GFS 0,25° en la nube de NOAA
(noaa-gfs-bdp-pds, desde 2021) con descargas parciales por mensaje GRIB. Para no alargar el flujo, cada ejecución
procesa como máximo PRESUPUESTO plazos del GFS; los avisos pendientes se completan en las siguientes.
En avisos largos se usan como máximo MAX_HORAS horas por etapa, repartidas en la vigencia. Nunca hace fallar el flujo.

Segundo modelo (reg["ecmwf"]): las mismas tres etapas con el ECMWF IFS 0,25° de sus datos abiertos (CC-BY-4.0), sobre la
misma área y las mismas horas. Al emitir se usa la corrida IFS publicada ~7 h antes del aviso (el IFS abierto aparece
unas 7 h después de la hora de corrida). Los espejos de Google Cloud y AWS guardan unos 30 días de corridas: lo que
ya no está publicado se marca "sin_datos" y no se vuelve a intentar; el resto se completa con PRESUPUESTO_EC plazos
por ejecución.
"""
import json
import math
from concurrent.futures import ThreadPoolExecutor
import sys
import time
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import trombas as tr          # noqa: E402  (descarga y cálculo GFS 0,25°)
import trombas_ecmwf as tec   # noqa: E402  (descarga y cálculo ECMWF IFS 0,25°)
import ecmwf_datos as ed      # noqa: E402
import geo as va            # noqa: E402  (polígonos de tierra de data/geo/land.json)

DATA = Path(__file__).resolve().parent.parent / "data"
SALIDA = DATA / "trombas_avisos.json"
VERSION = 1
TZ = ZoneInfo("America/Santiago")
DIAS_NOMADS = 9
DIST_COSTA = 1.0          # grados
MAX_HORAS = 8
PRESUPUESTO = 40          # plazos GFS por ejecución
PRESUPUESTO_EC = 120      # plazos ECMWF por ejecución (cada uno tarda ~1–3 s)
RETRASO_EC = 7            # h entre la hora de corrida del IFS y su publicación abierta (aprox.)
RETENCION_EC = 28         # días que guardan los espejos (medido: ~30); más antiguo → sin datos
ZONAS_LAT = {"III": (-33.03, -35.33), "IV": (-35.33, -38.37), "V": (-38.37, -41.8), "VI": (-41.8, -48.0)}
S3 = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
CAMPOS_S3 = ([(v, f"{n} mb") for v in ("HGT", "TMP", "RH", "UGRD", "VGRD") for n in tr.NIVELES]
             + [("PRES", "surface"), ("HGT", "surface"), ("TMP", "surface"), ("LAND", "surface"), ("TMP", "2 m above ground"),
                ("DPT", "2 m above ground"), ("UGRD", "10 m above ground"), ("VGRD", "10 m above ground")])
gasto = 0
gasto_ec = 0
_disp_ec = {}
VARS = ["mucape", "mlcape", "mlcape3", "mlcin", "ebsmu", "bwd06", "shr01", "srh500", "lr01", "lr03", "lr75",
        "mllcl", "dT", "dZ", "w850", "t850", "t500", "stp", "sherbe", "vgp", "nst"]


def leer(p, defecto):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except Exception:
        return defecto


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%MZ")


def piso(t, h):
    return t.replace(minute=0, second=0, microsecond=0, hour=t.hour // h * h)


def area(aviso):
    """Polígono de mar evaluado: zonas del Cuadro F del aviso (desde su límite norte), a ≤ 1° de la costa."""
    from shapely.geometry import box, shape
    from shapely.ops import unary_union
    feats = {f["properties"]["id"]: shape(f["geometry"]) for f in leer(DATA / "geo" / "metarea.json", {"features": []})["features"]}
    partes, norte, sur = [], None, None
    for z in aviso.get("zonas") or []:
        ids = [a for a in (z.get("areas") or []) if a in feats]
        if ids:
            partes.append(unary_union([feats[a] for a in ids]))
        elif z.get("geom"):
            partes.append(shape(z["geom"]))
        if z.get("north") is not None:
            norte = max(norte, z["north"]) if norte is not None else z["north"]
        if z.get("south") is not None:
            sur = min(sur, z["south"]) if sur is not None else z["south"]
    if not partes:
        return None
    g = unary_union(partes)
    if norte is not None or sur is not None:
        b = g.bounds
        g = g.intersection(box(b[0] - 1, sur if sur is not None else b[1] - 1, b[2] + 1, norte if norte is not None else b[3] + 1))
    t = va.tierra()
    return g.intersection(t.buffer(DIST_COSTA)).difference(t)


def horas(desde, hasta):
    t = piso(desde, 3)
    if t < desde:
        t += timedelta(hours=3)
    out = []
    while t <= hasta:
        out.append(t); t += timedelta(hours=3)
    out = out or [piso(desde, 3)]
    if len(out) > MAX_HORAS:
        idx = np.unique(np.round(np.linspace(0, len(out) - 1, MAX_HORAS)).astype(int))
        out = [out[i] for i in idx]
    return out


def bajar_s3(c, f):
    """Mensajes GRIB necesarios de un archivo GFS 0,25° del archivo de NOAA (lecturas parciales por rango)."""
    import requests
    d, h = c.strftime("%Y%m%d"), c.strftime("%H")
    base = f"{S3}/gfs.{d}/{h}/atmos/gfs.t{h}z.pgrb2.0p25.f{f:03d}"
    lineas = requests.get(base + ".idx", headers=tr.CAB, timeout=60).text.strip().splitlines()
    pos = [(int(l.split(":")[1]), ":".join(l.split(":")[3:5])) for l in lineas]
    quiero = {f"{v}:{n}" for v, n in CAMPOS_S3}
    rangos, vistos = [], set()
    for i, (ini, clave) in enumerate(pos):
        if clave in quiero and clave not in vistos:
            vistos.add(clave)
            rangos.append([ini, pos[i + 1][0] - 1 if i + 1 < len(pos) else None])
    unidos = []
    for r in rangos:
        if unidos and unidos[-1][1] is not None and r[0] == unidos[-1][1] + 1:
            unidos[-1][1] = r[1]
        else:
            unidos.append(r)

    def uno(r):
        for intento in range(3):
            try:
                x = requests.get(base, headers={**tr.CAB, "Range": f"bytes={r[0]}-{'' if r[1] is None else r[1]}"}, timeout=90)
                x.raise_for_status(); return x.content
            except Exception:
                if intento == 2:
                    raise
                time.sleep(3)
    with ThreadPoolExecutor(8) as ex:
        return b"".join(ex.map(uno, unidos))


def leer_recortado(contenido):
    campos, lat, lon = tr.leer_grib(contenido)
    lon180 = np.where(lon > 180, lon - 360, lon)
    filas = np.where((lat[:, 0] <= tr.NORTE) & (lat[:, 0] >= tr.SUR))[0]
    cols = np.where((lon180[0] >= tr.OESTE) & (lon180[0] <= tr.ESTE))[0]
    sl = (slice(filas.min(), filas.max() + 1), slice(cols.min(), cols.max() + 1))
    return {k: v[sl] for k, v in campos.items()}, lat[sl], lon[sl]


def q_gfs(c, f):
    global gasto
    gasto += 1
    if (datetime.now(timezone.utc) - c).days > DIAS_NOMADS:
        campos, lat, lon = leer_recortado(bajar_s3(c, f))
    else:
        campos, lat, lon = tr.leer_grib(tr.bajar(c, f))
    q, la, lo = tr.procesar(campos, lat, lon)
    mar = (campos[("lsm", 1, 0)] < 0.5).ravel()
    q["t500"] = campos[("t", 100, 500)].ravel()[mar]
    return q, la, lo


def q_ecmwf(c, f):
    global gasto_ec
    gasto_ec += 1
    campos, la1, lo1 = tec.campos_paso(c, f)
    q, la, lo = tec.procesar(campos, la1, lo1)
    mar = (campos["lsm"] < 0.5).ravel()
    q["t500"] = campos[("t", 500)].ravel()[mar]
    return q, la, lo


def ec_disponible(pares):
    """True si todas las corridas/plazos están publicados; False si alguno ya salió del archivo (no reintentar);
    None si alguno aún no aparece pero podría aparecer (reintentar más adelante)."""
    ahora = datetime.now(timezone.utc)
    for c, f in sorted(set(pares)):
        if (c, f) not in _disp_ec:
            _disp_ec[(c, f)] = ed.indice(c, "oper", "fc", f) is not None
        if not _disp_ec[(c, f)]:
            return False if (ahora - c).days >= RETENCION_EC or ahora - c > timedelta(days=2) else None
    return True


def estadistica(pares, g, modelo="gfs"):
    """pares: lista de (corrida, fhr). Devuelve percentiles por variable sobre todos los puntos y horas del área."""
    import shapely
    shapely.prepare(g)
    b = g.bounds
    tr.NORTE, tr.SUR, tr.OESTE, tr.ESTE = math.ceil(b[3] + 0.5), math.floor(b[1] - 0.5), math.floor(b[0] - 0.5), math.ceil(b[2] + 0.5)
    tec.NORTE, tec.SUR, tec.OESTE, tec.ESTE = tr.NORTE, tr.SUR, tr.OESTE, tr.ESTE
    acum = {v: [] for v in VARS}
    cont = {"stp": 0, "hslc": 0, "nst": 0, "sherbe": 0, "dT12": 0, "lr01_9": 0, "total": 0}
    por_hora = []
    for c, f in pares:
        q, la, lo = (q_ecmwf if modelo == "ecmwf" else q_gfs)(c, f)
        q["t500"] = q["t500"] - 273.15
        q["t850"] = q["t850"] - 273.15
        for k in ("ebsmu", "bwd06", "shr01"):
            q[k] = q[k] * tr.MS_A_KT
        m = shapely.contains_xy(g, lo, la)
        for v in VARS:
            x = np.asarray(q[v], float)[m]
            acum[v].append(x[np.isfinite(x)])
        cont["stp"] += int((q["stp"][m] <= tr.UMBRAL["stp"]).sum()); cont["hslc"] += int(q["hslc"][m].sum())
        cont["nst"] += int((q["nst"][m] > tr.UMBRAL["nst"]).sum()); cont["sherbe"] += int((q["sherbe"][m] >= 1).sum())
        cont["dT12"] += int((q["dT"][m] >= 12).sum()); cont["lr01_9"] += int((q["lr01"][m] >= 9).sum()); cont["total"] += int(m.sum())
        por_hora.append({"valida": iso(c + timedelta(hours=f)), "corrida": c.strftime("%Y-%m-%dT%HZ"), "fhr": f,
                         **{v: (round(float(np.nanmedian(q[v][m])), 2) if m.any() else None) for v in ("mucape", "ebsmu", "srh500", "lr01", "dT", "t500", "nst", "stp")}})
        if modelo == "gfs":
            time.sleep(1)
    est = {}
    for v, xs in acum.items():
        x = np.concatenate(xs) if xs else np.array([])
        est[v] = [round(float(np.percentile(x, p)), 2) for p in (10, 50, 90)] + [round(float(x.min()), 2), round(float(x.max()), 2)] if x.size else None
    return {"puntos": int(cont["total"] / max(len(pares), 1)), "horas": len(pares), "estad": est, "conteos": cont, "por_hora": por_hora}


def etapas_ecmwf(reg, a, g, hs, desde, hasta, ahora, clave):
    """Las tres etapas con el ECMWF IFS, en reg["ecmwf"]. Devuelve True si cambió algo."""
    ec, cambio = reg.setdefault("ecmwf", {}), False
    etapas = []
    if a.get("publicado"):
        pub = datetime.strptime(a["publicado"], "%d/%m/%Y %H:%M").replace(tzinfo=TZ).astimezone(timezone.utc)
        c = piso(pub - timedelta(hours=RETRASO_EC), 6)
        etapas.append(("emision", [(c, int((t - c).total_seconds() // 3600)) if t >= c else (piso(t, 6), t.hour % 6) for t in hs], {"corrida": c.strftime("%Y-%m-%dT%HZ")}))
    etapas.append(("referencia", [(piso(t - timedelta(days=7), 6), (t - timedelta(days=7)).hour % 6) for t in hs], {"desde": iso(desde - timedelta(days=7))}))
    if ahora > hasta + timedelta(hours=7):
        etapas.append(("durante", [(piso(t, 6), t.hour % 6) for t in hs], {}))
    for nombre, pares, extra in etapas:
        if nombre in ec or gasto_ec + len(pares) > PRESUPUESTO_EC:
            continue
        d = ec_disponible(pares)
        if d is None:
            continue
        if d is False:
            ec[nombre] = {"sin_datos": "Corrida ECMWF fuera del archivo abierto (guarda ~30 días)"}; cambio = True; continue
        print(f"{clave}: ECMWF {nombre}")
        ec[nombre] = {**extra, **estadistica(pares, g, "ecmwf")}; cambio = True
    return cambio


def main():
    arch = leer(SALIDA, {"version": VERSION, "avisos": {}})
    avisos = [dict(a, fuente="oficial") for a in leer(DATA / "avisos.json", {}).get("avisos", []) if "tromba" in (a.get("tipo", "") + a.get("resumen", "")).lower()]
    for h in sorted(leer(DATA / "trombas_avisos_historicos.json", {}).get("avisos", []), key=lambda x: x["desde"], reverse=True):
        d0 = datetime.fromisoformat(h["desde"]).replace(tzinfo=TZ).astimezone(timezone.utc)
        d1 = datetime.fromisoformat(h["hasta"]).replace(tzinfo=TZ).astimezone(timezone.utc)
        zs = [z for z, (n, s_) in ZONAS_LAT.items() if n > h["sur"] and s_ < h["norte"]]
        avisos.append({"codigo": h.get("codigo"), "tipo": "Aviso especial · trombas marinas", "sector": h.get("sector"),
                       "publicado": h.get("publicado"), "resumen": h.get("situacion", ""), "url": (h.get("urls") or [None])[0],
                       "fuente": h.get("fuente"), "centro": h.get("centro"), "urls": h.get("urls"), "nota_aviso": h.get("nota"),
                       "observadas": h.get("observadas"), "busqueda_prensa": h.get("busqueda_prensa"), "historico": True,
                       "zonas": [{"areas": zs, "north": h["norte"], "south": h["sur"], "desde": iso(d0), "hasta": iso(d1)}]})
    ahora = datetime.now(timezone.utc)
    cambios = False
    # Avisos ya archivados que esperan la etapa "durante" aunque ya no figuren en data/avisos.json
    vistos = set()
    for a in avisos:
        zs = a.get("zonas") or []
        if zs:
            d0 = min(datetime.fromisoformat(z["desde"].replace("Z", "+00:00")) for z in zs)
            vistos.add(f"{a.get('codigo') or 'Prensa'} · {d0:%Y-%m-%dT%HZ}")
    for clave, reg in arch["avisos"].items():
        if clave not in vistos and reg.get("emision") and "durante" not in reg and reg.get("desde"):
            zs = reg.get("zonas_aviso") or [{"areas": reg.get("zonas") or []}]
            avisos.append({"codigo": reg.get("codigo"), "tipo": reg.get("tipo"), "sector": reg.get("sector"), "publicado": reg.get("publicado"),
                           "resumen": reg.get("situacion", ""), "url": reg.get("url"),
                           "zonas": [dict(z, desde=reg["desde"], hasta=reg["hasta"]) for z in zs]})
    for a in avisos:
        zonas = a.get("zonas") or []
        if not zonas:
            continue
        desde = min(datetime.fromisoformat(z["desde"].replace("Z", "+00:00")) for z in zonas)
        hasta = max(datetime.fromisoformat(z["hasta"].replace("Z", "+00:00")) for z in zonas)
        clave = f"{a.get('codigo') or 'Prensa'} · {desde:%Y-%m-%dT%HZ}"
        reg = arch["avisos"].setdefault(clave, {})
        if a.get("historico") and reg.get("fuente") == "oficial" and not a.get("codigo"):
            continue
        for k in ("fuente", "centro", "urls", "observadas", "nota_aviso", "busqueda_prensa"):
            if a.get(k) is not None:
                reg[k] = a[k]
        reg.update({"codigo": a.get("codigo"), "tipo": a.get("tipo"), "sector": a.get("sector"), "publicado": a.get("publicado"),
                    "situacion": (a.get("resumen") or "").replace("Situación sinóptica:", "").strip() or reg.get("situacion", ""), "url": a.get("url"),
                    "desde": iso(desde), "hasta": iso(hasta), "zonas": sorted({x for z in zonas for x in (z.get("areas") or [])})})
        reg["zonas_aviso"] = [{k: z[k] for k in ("areas", "north", "south") if z.get(k) is not None} for z in zonas]
        try:
            g = area(a)
            if g is None or g.is_empty:
                reg["nota"] = "Sin área evaluable en el Cuadro F"; continue
            hs = horas(desde, hasta)
            if "emision" not in reg and a.get("publicado") and gasto < PRESUPUESTO:
                pub = datetime.strptime(a["publicado"], "%d/%m/%Y %H:%M").replace(tzinfo=TZ).astimezone(timezone.utc)
                c = piso(pub - timedelta(hours=5), 6)
                pares = [(c, int((t - c).total_seconds() // 3600)) if t >= c else (piso(t, 6), t.hour % 6) for t in hs]
                print(f"{clave}: emisión con GFS {c:%Y-%m-%d %HZ}")
                reg["emision"] = {"corrida": c.strftime("%Y-%m-%dT%HZ"), **estadistica(pares, g)}; cambios = True
            if "referencia" not in reg and gasto < PRESUPUESTO:
                pares = [(piso(t - timedelta(days=7), 6), (t - timedelta(days=7)).hour % 6) for t in hs]
                print(f"{clave}: referencia 7 días antes")
                reg["referencia"] = {"desde": iso(desde - timedelta(days=7)), **estadistica(pares, g)}; cambios = True
            if "durante" not in reg and ahora > hasta + timedelta(hours=7) and gasto < PRESUPUESTO:
                pares = [(piso(t, 6), t.hour % 6) for t in hs]
                print(f"{clave}: durante (análisis)")
                reg["durante"] = estadistica(pares, g); cambios = True
            reg.pop("error", None)
            try:
                cambios = etapas_ecmwf(reg, a, g, hs, desde, hasta, ahora, clave) or cambios
                reg.get("ecmwf", {}).pop("error", None)
            except Exception as e:
                ln = traceback.extract_tb(e.__traceback__)[-1]
                reg.setdefault("ecmwf", {})["error"] = f"{type(e).__name__}: {e} ({Path(ln.filename).name}:{ln.lineno})"[:300]
                print(clave, "error ECMWF", reg["ecmwf"]["error"]); cambios = True
        except Exception as e:
            ln = traceback.extract_tb(e.__traceback__)[-1]
            reg["error"] = f"{type(e).__name__}: {e} ({Path(ln.filename).name}:{ln.lineno})"[:300]
            print(clave, "error", reg["error"]); cambios = True
    if cambios:
        arch["version"] = VERSION
        arch["actualizado"] = ahora.strftime("%Y-%m-%dT%H:%M:%SZ")
        SALIDA.write_text(json.dumps(arch, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print("Trombas avisos: archivo actualizado,", len(arch["avisos"]), "avisos")
    else:
        print("Trombas avisos: sin cambios")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("Trombas avisos: error", e)
