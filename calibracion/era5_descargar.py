#!/usr/bin/env python3
"""Descarga de ERA5 para calibrar los umbrales de trombas marinas → ~/trombas-era5/era5/

Necesita una cuenta gratuita en Copernicus CDS y la clave en ~/.cdsapirc (ver calibracion/README.md).
Baja, mes por mes, abril a octubre de 2010 a 2026, las horas 12, 15, 18 y 21 UTC, en 33,5°–43° S / 76°–71° W:
  pl_AAAAMM.nc   niveles de presión: geopotencial, temperatura, humedad relativa y viento (20 niveles, los de la página);
  sfc_AAAAMM.nc  superficie: TSM, T y Td a 2 m, presión, viento a 10 m, máscara de tierra y geopotencial del terreno.
Además baja los días de las trombas del catálogo que quedan fuera de ese período (reserva 1940–2009 y fuera de
temporada), con las mismas horas: pl_ev_AAAAMMDD.nc y sfc_ev_AAAAMMDD.nc.

La espera en la cola de Copernicus domina el tiempo total (medido: más de una hora por pedido, cualquiera sea su
tamaño). El servicio rechaza los pedidos cuando hay más de uno en cola ("Maximum number queued requests for this
dataset has been reached. Please configure your scripts to request data sequentially"), y en noviembre de 2026 se
comprobó que el límite es de la cuenta y no de cada conjunto: dos pedidos simultáneos, aunque sean de conjuntos
distintos, terminan los dos rechazados. Por eso la descarga manda un pedido a la vez, en serie.

Si el servicio rechaza un mes completo por tamaño ("cost limits exceeded"), el mes se parte solo en tramos de días
(pl_AAAAMMdDD.nc) hasta que lo acepta, y ese tamaño se reutiliza en los meses siguientes.

Se puede interrumpir y volver a correr: no repite lo ya descargado.
Uso:  python calibracion/era5_descargar.py --probar       (un solo día, para revisar que la cuenta y el formato funcionan)
      python calibracion/era5_descargar.py                (todo)
      python calibracion/era5_descargar.py --desde 2023   (solo desde ese año)
"""
import argparse
import calendar
import random
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

from comun import ANIOS, AREA, DATOS, HORAS, MESES, NIVELES, en_calibracion, eventos

VARS_PL = ["geopotential", "temperature", "relative_humidity", "u_component_of_wind", "v_component_of_wind"]
VARS_SFC = ["sea_surface_temperature", "2m_temperature", "2m_dewpoint_temperature", "surface_pressure",
            "10m_u_component_of_wind", "10m_v_component_of_wind", "land_sea_mask", "geopotential"]
SALIDA = DATOS / "era5"
# El servicio rechaza un pedido que supere su límite de tamaño ("cost limits exceeded"). Cuando eso pasa, el mes se
# parte en mitades hasta que lo acepta, y el tamaño que resultó se reutiliza en los meses siguientes.
TAMANO = {"pl": None, "sfc": None}
CANDADO = threading.Lock()
LOCAL = threading.local()


# Copernicus limita cuántos pedidos puede tener un usuario encolados por conjunto de datos, bastante menos que los
# 10 en paralelo que admite en total ("Maximum number queued requests for this dataset has been reached"). No es un
# fallo: hay que esperar y volver a mandar el pedido, que es lo que hace espera_y_reintenta.
MAX_ESPERA = 6 * 3600


def demasiado_grande(e):
    t = str(e).lower()
    return "cost limit" in t or "too large" in t or "reduce your selection" in t


def cola_llena(e):
    t = str(e).lower()
    return "maximum number queued" in t or "request data sequentially" in t or "too many requests" in t


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


def bajar_uno(cliente, conjunto, variables, niveles, prefijo, etiqueta, anio, mes, dias, horas, partible=False):
    """Un conjunto de datos y un tramo de días: espera si la cola está llena y parte el tramo si el pedido es muy grande.

    Las dos filas (niveles de presión y superficie) corren en paralelo, pero cada una manda un pedido a la vez: el
    servicio encola muy pocos por conjunto de datos y rechaza el resto, con el consejo expreso de pedir en serie.
    """
    dias = list(dias)
    lim = TAMANO[prefijo]
    if partible and lim and len(dias) > lim:
        for i in range(0, len(dias), lim):
            t = dias[i:i + lim]
            bajar_uno(cliente, conjunto, variables, niveles, prefijo, f"{anio}{mes:02d}d{t[0]:02d}", anio, mes, t, horas)
        return
    destino = SALIDA / f"{prefijo}_{etiqueta}.nc"
    espera, total = 60, 0
    while True:
        try:
            n = pedir(cliente, conjunto, variables, anio, mes, dias, horas, destino, niveles)
            break
        except Exception as e:
            if demasiado_grande(e) and len(dias) >= 2:
                destino.unlink(missing_ok=True)
                m = (len(dias) + 1) // 2
                with CANDADO:
                    if not TAMANO[prefijo] or m < TAMANO[prefijo]:
                        TAMANO[prefijo] = m
                print(f"{prefijo} {etiqueta}: el pedido excede el límite del servicio; se parte en tramos de {m} días", flush=True)
                for t in (dias[:m], dias[m:]):
                    bajar_uno(cliente, conjunto, variables, niveles, prefijo, f"{anio}{mes:02d}d{t[0]:02d}", anio, mes, t, horas)
                return
            if not cola_llena(e) or total >= MAX_ESPERA:
                raise
            if total == 0:
                print(f"{prefijo} {etiqueta}: la cola del servicio está llena; espera y reintenta", flush=True)
            time.sleep(espera)
            total += espera
            espera = min(espera * 2, 900)
    print(f"{prefijo} {etiqueta}: {'descargado' if n else 'ya estaba'}", flush=True)


def cliente():
    """Un cliente por hilo: cdsapi no es seguro de compartir entre hilos."""
    import cdsapi
    if not getattr(LOCAL, "c", None):
        LOCAL.c = cdsapi.Client()
    return LOCAL.c


FILAS = [("reanalysis-era5-pressure-levels", VARS_PL, NIVELES, "pl"),
         ("reanalysis-era5-single-levels", VARS_SFC, None, "sfc")]


def recorrer(pendientes):
    """Un pedido a la vez, en serie, alternando los dos conjuntos de datos de cada mes.

    Probado en noviembre de 2026: dos pedidos simultáneos terminan los dos rechazados, incluso siendo de conjuntos
    distintos (uno de niveles de presión y otro de superficie). El límite de pedidos en cola es de la cuenta, no de
    cada conjunto, de modo que la única forma que el servicio acepta es la que él mismo recomienda: en serie.
    """
    c = cliente()
    for etiqueta, anio, mes, dias, partible in pendientes:
        for conjunto, variables, niveles, prefijo in FILAS:
            try:
                bajar_uno(c, conjunto, variables, niveles, prefijo, etiqueta, anio, mes, dias, HORAS, partible=partible)
            except Exception as e:
                print(f"{prefijo} {etiqueta}: ERROR {e!r} (se reintenta en la próxima corrida)", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--probar", action="store_true")
    ap.add_argument("--desde", type=int, default=min(ANIOS))
    a = ap.parse_args()
    try:
        import cdsapi  # noqa: F401
    except ImportError:
        sys.exit("Falta cdsapi: pip install -r calibracion/requirements.txt")
    SALIDA.mkdir(parents=True, exist_ok=True)
    if a.probar:
        for cj, va, ni, pf in FILAS:
            try:
                bajar_uno(cliente(), cj, va, ni, pf, "prueba", 2026, 8, [28], HORAS)
            except Exception as e:
                print(f"{pf} prueba: ERROR {e!r}", flush=True)
        print(f"Prueba lista en {SALIDA}. Ahora: python calibracion/era5_indices.py --solo prueba")
        return
    hoy = date.today()
    meses, dias_sueltos = [], []
    for anio in ANIOS:
        if anio < a.desde:
            continue
        for mes in MESES:
            fin = date(anio, mes, calendar.monthrange(anio, mes)[1])
            if fin > hoy - timedelta(days=7):      # ERA5 llega con unos 5 días de retraso
                continue
            meses.append((f"{anio}{mes:02d}", anio, mes, list(range(1, fin.day + 1)), True))
    for f in sorted({e["fecha"] for e in eventos() if not en_calibracion(e["fecha"])}):
        d = date.fromisoformat(f)
        dias_sueltos.append((f"ev_{d:%Y%m%d}", d.year, d.month, [d.day], False))
    # Primero los meses con trombas y los días de la reserva, que son los que no se pueden reemplazar; después el
    # resto en orden aleatorio fijo. Así, si la descarga se interrumpe a medio camino, lo que hay alcanza para
    # calibrar: están todos los eventos y una muestra de meses sin evento repartida por todo el período, en vez de
    # los primeros años solamente.
    con_evento = {e["fecha"][:7].replace("-", "") for e in eventos() if en_calibracion(e["fecha"])}
    claves = [m for m in meses if m[0] in con_evento]
    resto = [m for m in meses if m[0] not in con_evento]
    random.Random(20261115).shuffle(resto)
    pendientes = claves + dias_sueltos + resto
    print(f"{len(pendientes)} meses y días por descargar, un pedido a la vez.", flush=True)
    print(f"Primero los {len(claves)} meses con trombas y {len(dias_sueltos)} días de la reserva; "
          f"después los {len(resto)} meses restantes en orden aleatorio.", flush=True)
    recorrer(pendientes)


if __name__ == "__main__":
    main()
