#!/usr/bin/env python3
"""Descarga de ERA5 para calibrar los umbrales de trombas marinas → ~/trombas-era5/era5/

Necesita una cuenta gratuita en Copernicus CDS y la clave en ~/.cdsapirc (ver calibracion/README.md).
Baja, mes por mes, abril a octubre de 2010 a 2026, las horas 12, 15, 18 y 21 UTC, en 33,5°–43° S / 76°–71° W:
  pl_AAAAMM.nc   niveles de presión: geopotencial, temperatura, humedad relativa y viento (20 niveles, los de la página);
  sfc_AAAAMM.nc  superficie: TSM, T y Td a 2 m, presión, viento a 10 m, máscara de tierra y geopotencial del terreno.
Además baja los días de las trombas del catálogo que quedan fuera de ese período (reserva 1940–2009 y fuera de
temporada), con las mismas horas: pl_ev_AAAAMMDD.nc y sfc_ev_AAAAMMDD.nc.

La espera en la cola de Copernicus domina el tiempo total (medido: más de una hora por pedido), así que conviene
bajar varios meses a la vez con --trabajos. El servicio admite hasta 10 pedidos en paralelo por usuario, pero
castiga con menor prioridad a quien manda demasiados: 4 a 6 es un punto razonable.

Si el servicio rechaza un mes completo por tamaño ("cost limits exceeded"), el mes se parte solo en tramos de días
(pl_AAAAMMdDD.nc) hasta que lo acepta, y ese tamaño se reutiliza en los meses siguientes.

Se puede interrumpir y volver a correr: no repite lo ya descargado.
Uso:  python calibracion/era5_descargar.py --probar       (un solo día, para revisar que la cuenta y el formato funcionan)
      python calibracion/era5_descargar.py                (todo, 4 meses a la vez)
      python calibracion/era5_descargar.py --trabajos 6   (6 meses a la vez)
      python calibracion/era5_descargar.py --desde 2023   (solo desde ese año)
"""
import argparse
import calendar
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

from comun import ANIOS, AREA, DATOS, HORAS, MESES, NIVELES, en_calibracion, eventos

VARS_PL = ["geopotential", "temperature", "relative_humidity", "u_component_of_wind", "v_component_of_wind"]
VARS_SFC = ["sea_surface_temperature", "2m_temperature", "2m_dewpoint_temperature", "surface_pressure",
            "10m_u_component_of_wind", "10m_v_component_of_wind", "land_sea_mask", "geopotential"]
SALIDA = DATOS / "era5"
# El servicio rechaza un pedido que supere su límite de tamaño ("cost limits exceeded"). Cuando eso pasa, el mes se
# parte en mitades hasta que lo acepta, y el tamaño que resultó se reutiliza en los meses siguientes.
TAMANO = {"dias": None}
CANDADO = threading.Lock()
LOCAL = threading.local()


def demasiado_grande(e):
    t = str(e).lower()
    return "cost limit" in t or "too large" in t or "reduce your selection" in t


def pedir(cliente, conjunto, variables, anio, mes, dias, horas, destino, niveles=None):
    if destino.exists() and destino.stat().st_size > 10_000:
        return False
    req = {"product_type": ["reanalysis"], "variable": variables, "year": [f"{anio}"], "month": [f"{mes:02d}"],
           "day": [f"{d:02d}" for d in dias], "time": [f"{h:02d}:00" for h in horas], "area": AREA,
           "data_format": "netcdf", "download_format": "unarchived"}
    if niveles:
        req["pressure_level"] = [str(n) for n in niveles]
    tmp = destino.with_suffix(".parcial")
    cliente.retrieve(conjunto, req, str(tmp))
    tmp.rename(destino)
    return True


def bajar(cliente, etiqueta, anio, mes, dias, horas, partible=False):
    """Descarga un tramo de días. Si el servicio lo rechaza por tamaño, lo parte en mitades y reintenta."""
    dias = list(dias)
    lim = TAMANO["dias"]
    if partible and lim and len(dias) > lim:
        for i in range(0, len(dias), lim):
            t = dias[i:i + lim]
            bajar(cliente, f"{anio}{mes:02d}d{t[0]:02d}", anio, mes, t, horas)
        return
    try:
        n = pedir(cliente, "reanalysis-era5-pressure-levels", VARS_PL, anio, mes, dias, horas, SALIDA / f"pl_{etiqueta}.nc", NIVELES)
        n |= pedir(cliente, "reanalysis-era5-single-levels", VARS_SFC, anio, mes, dias, horas, SALIDA / f"sfc_{etiqueta}.nc")
    except Exception as e:
        if not demasiado_grande(e) or len(dias) < 2:
            raise
        for f in (SALIDA / f"pl_{etiqueta}.nc", SALIDA / f"sfc_{etiqueta}.nc"):
            f.unlink(missing_ok=True)
        m = (len(dias) + 1) // 2
        with CANDADO:
            if not TAMANO["dias"] or m < TAMANO["dias"]:
                TAMANO["dias"] = m
        print(f"{etiqueta}: el pedido excede el límite del servicio; se parte en tramos de {m} días", flush=True)
        for t in (dias[:m], dias[m:]):
            bajar(cliente, f"{anio}{mes:02d}d{t[0]:02d}", anio, mes, t, horas)
        return
    print(f"{etiqueta}: {'descargado' if n else 'ya estaba'}", flush=True)


def cliente():
    """Un cliente por hilo: cdsapi no es seguro de compartir entre hilos."""
    import cdsapi
    if not getattr(LOCAL, "c", None):
        LOCAL.c = cdsapi.Client()
    return LOCAL.c


def tarea(etiqueta, anio, mes, dias, partible=False):
    try:
        bajar(cliente(), etiqueta, anio, mes, dias, HORAS, partible=partible)
    except Exception as e:
        print(f"{etiqueta}: ERROR {e!r} (se reintenta en la próxima corrida)", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--probar", action="store_true")
    ap.add_argument("--desde", type=int, default=min(ANIOS))
    ap.add_argument("--trabajos", type=int, default=4, help="meses a descargar a la vez (1 a 10; Copernicus castiga el exceso)")
    a = ap.parse_args()
    try:
        import cdsapi  # noqa: F401
    except ImportError:
        sys.exit("Falta cdsapi: pip install -r calibracion/requirements.txt")
    SALIDA.mkdir(parents=True, exist_ok=True)
    if a.probar:
        tarea("prueba", 2026, 8, [28])
        print(f"Prueba lista en {SALIDA}. Ahora: python calibracion/era5_indices.py --solo prueba")
        return
    hoy = date.today()
    pendientes = []
    for anio in ANIOS:
        if anio < a.desde:
            continue
        for mes in MESES:
            fin = date(anio, mes, calendar.monthrange(anio, mes)[1])
            if fin > hoy - timedelta(days=7):      # ERA5 llega con unos 5 días de retraso
                continue
            pendientes.append((f"{anio}{mes:02d}", anio, mes, list(range(1, fin.day + 1)), True))
    for f in sorted({e["fecha"] for e in eventos() if not en_calibracion(e["fecha"])}):
        d = date.fromisoformat(f)
        pendientes.append((f"ev_{d:%Y%m%d}", d.year, d.month, [d.day], False))
    n = max(1, min(a.trabajos, 10))
    print(f"{len(pendientes)} meses y días por descargar, {n} a la vez.", flush=True)
    with ThreadPoolExecutor(max_workers=n) as pool:
        for t in pendientes:
            pool.submit(tarea, *t)


if __name__ == "__main__":
    main()
