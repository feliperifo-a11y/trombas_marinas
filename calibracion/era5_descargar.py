#!/usr/bin/env python3
"""Descarga de ERA5 para calibrar los umbrales de trombas marinas → ~/trombas-era5/era5/

Necesita una cuenta gratuita en Copernicus CDS y la clave en ~/.cdsapirc (ver calibracion/README.md).
Baja, mes por mes, abril a octubre de 2010 a 2026, las horas 12–23 UTC, en 33,5°–43° S / 76°–71° W:
  pl_AAAAMM.nc   niveles de presión: geopotencial, temperatura, humedad relativa y viento (20 niveles, los de la página);
  sfc_AAAAMM.nc  superficie: TSM, T y Td a 2 m, presión, viento a 10 m, máscara de tierra y geopotencial del terreno.
Además baja los días de las trombas del catálogo que quedan fuera de ese período (reserva 1940–2009 y fuera de temporada),
con las 24 horas del día y del día siguiente: pl_ev_AAAAMMDD.nc y sfc_ev_AAAAMMDD.nc.

Se puede interrumpir y volver a correr: no repite lo ya descargado.
Uso:  python calibracion/era5_descargar.py --probar     (un solo día, para revisar que la cuenta y el formato funcionan)
      python calibracion/era5_descargar.py              (todo)
      python calibracion/era5_descargar.py --desde 2023 (solo desde ese año)
"""
import argparse
import calendar
import sys
from datetime import date, timedelta

from comun import ANIOS, AREA, DATOS, HORAS, MESES, NIVELES, en_calibracion, eventos

VARS_PL = ["geopotential", "temperature", "relative_humidity", "u_component_of_wind", "v_component_of_wind"]
VARS_SFC = ["sea_surface_temperature", "2m_temperature", "2m_dewpoint_temperature", "surface_pressure",
            "10m_u_component_of_wind", "10m_v_component_of_wind", "land_sea_mask", "geopotential"]
SALIDA = DATOS / "era5"


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


def bajar(cliente, etiqueta, anio, mes, dias, horas):
    n = pedir(cliente, "reanalysis-era5-pressure-levels", VARS_PL, anio, mes, dias, horas, SALIDA / f"pl_{etiqueta}.nc", NIVELES)
    n |= pedir(cliente, "reanalysis-era5-single-levels", VARS_SFC, anio, mes, dias, horas, SALIDA / f"sfc_{etiqueta}.nc")
    print(f"{etiqueta}: {'descargado' if n else 'ya estaba'}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--probar", action="store_true")
    ap.add_argument("--desde", type=int, default=min(ANIOS))
    a = ap.parse_args()
    try:
        import cdsapi
    except ImportError:
        sys.exit("Falta cdsapi: pip install -r calibracion/requirements.txt")
    SALIDA.mkdir(parents=True, exist_ok=True)
    c = cdsapi.Client()
    if a.probar:
        bajar(c, "prueba", 2026, 8, [28], HORAS)
        print(f"Prueba lista en {SALIDA}. Ahora: python calibracion/era5_indices.py --solo prueba")
        return
    hoy = date.today()
    for anio in ANIOS:
        if anio < a.desde:
            continue
        for mes in MESES:
            fin = date(anio, mes, calendar.monthrange(anio, mes)[1])
            if fin > hoy - timedelta(days=7):      # ERA5 llega con unos 5 días de retraso
                continue
            try:
                bajar(c, f"{anio}{mes:02d}", anio, mes, range(1, fin.day + 1), HORAS)
            except Exception as e:
                print(f"{anio}{mes:02d}: ERROR {e!r} (se reintenta en la próxima corrida)", flush=True)
    extra = sorted({e["fecha"] for e in eventos() if not en_calibracion(e["fecha"])})
    for f in extra:
        d0 = date.fromisoformat(f)
        for d in (d0, d0 + timedelta(days=1)):
            try:
                bajar(c, f"ev_{d:%Y%m%d}", d.year, d.month, [d.day], range(24))
            except Exception as e:
                print(f"ev_{d:%Y%m%d}: ERROR {e!r}", flush=True)


if __name__ == "__main__":
    main()
