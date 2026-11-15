#!/usr/bin/env python3
"""Prueba de la cadena completa con datos inventados (no son ERA5): comprueba que los scripts corren de punta a punta.

Crea archivos con la misma estructura que entrega el CDS para tres meses y una fecha de reserva, con un ambiente más
inestable y con más cizalle en los días con tromba del catálogo, y luego corre era5_indices.py y verificar.py.
Los números que salen NO significan nada: solo sirven para detectar errores de programa.

Uso:  TROMBAS_ERA5=/tmp/trombas-prueba python calibracion/prueba_sintetica.py
"""
import calendar
import subprocess
import sys
from datetime import date, timedelta

import numpy as np
import xarray as xr

from comun import AREA, DATOS, HORAS, NIVELES, eventos

rng = np.random.default_rng(1)
lat = np.arange(AREA[0], AREA[2] - 0.01, -0.25); lon = np.arange(AREA[1], AREA[3] + 0.01, 0.25)
lon2, lat2 = np.meshgrid(lon, lat)
tierra = lon2 > (-71.6 - 0.22 * (lat2 + 34) * -1)        # costa inclinada, parecida a la real
p = np.array(NIVELES, float)
zstd = 44330.0 * (1 - (p / 1013.25) ** 0.1903)
dias_ev = {e["fecha"] for e in eventos()}


def escribir(etiqueta, dias, horas):
    t = np.array([np.datetime64(f"{d}T{h:02d}:00") for d in dias for h in horas]).astype("datetime64[ns]")
    nt, shp = len(t), (len(t), len(p), len(lat), len(lon))
    fav = np.array([str(x)[:10] in dias_ev for x in t])[:, None, None, None]
    z = np.broadcast_to(zstd[None, :, None, None], shp)
    grad = 6.0 + 1.6 * fav + rng.normal(0, 0.35, (nt, 1, len(lat), len(lon)))
    T = 286.0 - grad * z / 1000.0
    rh = np.clip(88 - 0.012 * z + 8 * fav + rng.normal(0, 5, shp), 5, 100)
    ciz = 2.0 + 3.0 * fav + rng.normal(0, 0.8, (nt, 1, len(lat), len(lon)))
    u = 4 + ciz * z / 1000.0; v = -6 - 0.8 * ciz * z / 1000.0 + rng.normal(0, 1, shp)
    dims = ("valid_time", "pressure_level", "latitude", "longitude")
    co = {"valid_time": t, "pressure_level": p, "latitude": lat, "longitude": lon}
    xr.Dataset({"z": (dims, (z * 9.80665).astype("f4")), "t": (dims, T.astype("f4")), "r": (dims, rh.astype("f4")), "u": (dims, u.astype("f4")), "v": (dims, v.astype("f4"))},
               coords=co).to_netcdf(DATOS / "era5" / f"pl_{etiqueta}.nc")
    s3 = (nt, len(lat), len(lon)); d3 = ("valid_time", "latitude", "longitude"); uno = np.ones(s3, "f4")
    sst = np.where(tierra, np.nan, 286.5) * uno
    xr.Dataset({"sst": (d3, sst), "t2m": (d3, 286.0 * uno + rng.normal(0, 0.4, s3).astype("f4")), "d2m": (d3, 283.5 * uno + 1.2 * fav[:, 0]),
                "sp": (d3, 101500.0 * uno), "u10": (d3, 4 * uno + rng.normal(0, 1.5, s3).astype("f4")), "v10": (d3, -6 * uno + rng.normal(0, 1.5, s3).astype("f4")),
                "lsm": (d3, tierra.astype("f4") * uno), "z": (d3, np.where(tierra, 2000.0, 0.0).astype("f4") * uno)},
               coords={k: co[k] for k in ("valid_time", "latitude", "longitude")}).to_netcdf(DATOS / "era5" / f"sfc_{etiqueta}.nc")


def main():
    if "trombas-era5" in str(DATOS) and "prueba" not in str(DATOS):
        sys.exit("Usa un directorio de prueba: TROMBAS_ERA5=/tmp/trombas-prueba python calibracion/prueba_sintetica.py")
    (DATOS / "era5").mkdir(parents=True, exist_ok=True)
    for a, m in ((2017, 7), (2023, 6), (2025, 9), (2026, 8), (2026, 10)):
        escribir(f"{a}{m:02d}", [date(a, m, d) for d in range(1, calendar.monthrange(a, m)[1] + 1)], HORAS)
    for d0 in (date(2007, 6, 21), date(2017, 2, 16)):
        for d in (d0, d0 + timedelta(days=1)):
            escribir(f"ev_{d:%Y%m%d}", [d], range(24))
    for s in ("era5_indices.py", "verificar.py"):
        subprocess.run([sys.executable, str(DATOS.__class__(__file__).parent / s)], check=True)


if __name__ == "__main__":
    main()
