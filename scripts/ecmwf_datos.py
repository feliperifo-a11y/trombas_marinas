#!/usr/bin/env python3
"""Lectura de los datos abiertos de ECMWF (IFS y ENS 0,25°) desde su repositorio público en AWS.

ECMWF publica los mismos archivos en varios espejos; se usa primero el de Google Cloud, porque el de AWS rechaza con
frecuencia las lecturas del ensamble ("SlowDown", archivo saturado por otros usuarios), y después AWS y el servidor de
ECMWF como respaldo. Licencia CC-BY-4.0 (atribución visible obligatoria: "Datos de ECMWF, CC-BY-4.0"). Cada archivo GRIB2 trae un índice
(.index, una línea JSON por mensaje con su desplazamiento y largo), así que se bajan solo los mensajes necesarios con
lecturas parciales (Range) y se unen los que quedan contiguos para hacer menos solicitudes. Los campos vienen en
grilla global de 0,25° con compresión CCSDS; se decodifican con eccodes y se recortan al recuadro pedido.
"""
import json
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import requests

ESPEJOS = ["https://storage.googleapis.com/ecmwf-open-data",
           "https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com",
           "https://data.ecmwf.int/forecasts"]
CAB = {"User-Agent": "trombas-marinas/1.0 (datos abiertos ECMWF)"}
ATRIBUCION = "Datos de ECMWF (open data, CC-BY-4.0)"
_SES = requests.Session()


def pedir(u, rango=None, timeout=120):
    """GET con reintentos: el repositorio S3 responde 503 (Slow Down) si se le pide demasiado rápido."""
    espera, r = 2, None
    for _ in range(8):
        try:
            r = _SES.get(u, headers={**CAB, **({"Range": f"bytes={rango[0]}-{rango[1]}"} if rango else {})}, timeout=timeout)
        except requests.RequestException:
            time.sleep(espera); espera = min(espera * 2, 40); continue
        if r.status_code not in (429, 500, 502, 503, 504):
            return r
        time.sleep(espera); espera = min(espera * 2, 40)
    if r is None:
        raise RuntimeError(f"sin respuesta de {u}")
    return r


def url(c, stream, tipo, paso, ext, modelo="ifs", base=ESPEJOS[0]):
    d, h = c.strftime("%Y%m%d"), c.strftime("%H")
    return f"{base}/{d}/{h}z/{modelo}/0p25/{stream}/{d}{h}0000-{paso}h-{stream}-{tipo}.{ext}"


def indice_y_espejo(c, stream, tipo, paso, modelo="ifs"):
    """Índice del primer espejo que lo tenga publicado, y ese espejo (los archivos se bajan del mismo)."""
    for base in ESPEJOS:
        try:
            r = pedir(url(c, stream, tipo, paso, "index", modelo, base), timeout=60)
        except Exception:
            continue
        if r.status_code == 200 and r.text.strip():
            return [json.loads(x) for x in r.text.splitlines() if x.strip()], base
    return None, None


def indice(c, stream, tipo, paso, modelo="ifs"):
    return indice_y_espejo(c, stream, tipo, paso, modelo)[0]


def bajar(c, stream, tipo, paso, elegir, modelo="ifs", hilos=6, tope_bloque=48_000_000, hueco=0, informe=None):
    """Baja los mensajes del índice que cumplen elegir(entrada). Devuelve [(entrada, bytes)].

    hueco: bytes de mensajes no pedidos que se aceptan entre dos pedidos para unirlos en una sola lectura
    (menos solicitudes; el repositorio limita la cantidad por segundo)."""
    ind, base = indice_y_espejo(c, stream, tipo, paso, modelo)
    if ind is None:
        raise RuntimeError(f"sin índice para +{paso} h")
    sel = sorted((e for e in ind if elegir(e)), key=lambda e: e["_offset"])
    bloques = []                                   # [inicio, fin, [entradas]]
    for e in sel:
        ini, fin = e["_offset"], e["_offset"] + e["_length"] - 1
        if bloques and ini - bloques[-1][1] - 1 <= hueco and fin - bloques[-1][0] < tope_bloque:
            bloques[-1][1] = fin; bloques[-1][2].append(e)
        else:
            bloques.append([ini, fin, [e]])
    u = url(c, stream, tipo, paso, "grib2", modelo, base)
    if informe is not None:
        informe.update(mensajes=len(sel), lecturas=len(bloques), mb=round(sum(b[1] - b[0] + 1 for b in bloques) / 1e6), espejo=base.split('/')[2])

    def uno(b):
        r = pedir(u, (b[0], b[1]))
        if r.status_code not in (200, 206) or len(r.content) != b[1] - b[0] + 1:
            raise RuntimeError(f"lectura parcial fallida ({r.status_code}, {len(r.content)} bytes)")
        return [(e, r.content[e["_offset"] - b[0]: e["_offset"] - b[0] + e["_length"]]) for e in b[2]]

    with ThreadPoolExecutor(hilos) as ex:
        return [m for parte in ex.map(uno, bloques) for m in parte]


def decodificar(grib):
    """(valores Nj×Ni, lats 1D, lons 1D) de un mensaje GRIB2 de grilla regular lat-lon."""
    import eccodes
    h = eccodes.codes_new_from_message(grib)
    try:
        ni, nj = eccodes.codes_get(h, "Ni"), eccodes.codes_get(h, "Nj")
        v = eccodes.codes_get_values(h).reshape(nj, ni).astype(float)
        la1, lo1 = eccodes.codes_get(h, "latitudeOfFirstGridPointInDegrees"), eccodes.codes_get(h, "longitudeOfFirstGridPointInDegrees")
        la2, lo2 = eccodes.codes_get(h, "latitudeOfLastGridPointInDegrees"), eccodes.codes_get(h, "longitudeOfLastGridPointInDegrees")
        if lo2 < lo1:
            lo2 += 360
        return v, np.linspace(la1, la2, nj), np.linspace(lo1, lo2, ni)
    finally:
        eccodes.codes_release(h)


def recortar(v, lats, lons, norte, sur, oeste, este):
    """Recorte al recuadro, con latitudes de norte a sur y longitudes de oeste a este (−180…180)."""
    lons = ((lons + 180) % 360) - 180
    fi = np.where((lats <= norte + 1e-6) & (lats >= sur - 1e-6))[0]
    fj = np.where((lons >= oeste - 1e-6) & (lons <= este + 1e-6))[0]
    sub, la, lo = v[np.ix_(fi, fj)], lats[fi], lons[fj]
    orden = np.argsort(lo)
    sub, lo = sub[:, orden], lo[orden]
    if la[0] < la[-1]:
        sub, la = sub[::-1], la[::-1]
    sub = sub.copy(); sub[np.abs(sub) > 1e10] = np.nan
    return sub, la, lo


def vorticidad(u, v, lat1, lon1):
    """Vorticidad relativa (s⁻¹) en una grilla regular (lat de norte a sur)."""
    R = 6.371e6
    LA, LO = np.meshgrid(np.radians(lat1), np.radians(lon1), indexing="ij")
    dvdx = np.gradient(v, axis=1) / (np.gradient(LO, axis=1) * R * np.cos(LA))
    dudy = np.gradient(u, axis=0) / (np.gradient(LA, axis=0) * R)
    return dvdx - dudy
