#!/usr/bin/env python3
"""Índices convectivos sobre ERA5 con el mismo código de la página → ~/trombas-era5/indices/idx_*.npz

Para cada par pl_X.nc / sfc_X.nc calcula, hora por hora, los índices de scripts/trombas_indices.py en las celdas de mar
cercanas a la costa (hasta dos celdas de 0,25° de una celda de tierra) entre 34° y 42,5° S. Guarda un archivo por mes con
un arreglo (hora, celda) por variable. Se puede interrumpir y volver a correr: no repite lo ya calculado.

Los archivos de ERA5 solo sirven para este cálculo: con --borrar se elimina cada par pl_/sfc_ apenas queda
procesado, de modo que el disco nunca guarda más de un mes a la vez (unos 130 MB en vez de ~15 GB).

Uso:  python calibracion/era5_indices.py            (todo lo descargado)
      python calibracion/era5_indices.py --borrar    (y borra cada mes de ERA5 ya procesado)
      python calibracion/era5_indices.py --solo prueba
"""
import argparse
import sys
import warnings
import zipfile

import numpy as np

from comun import DATOS, LAT_N, LAT_S, NIVELES, RAIZ, tramo

sys.path.insert(0, str(RAIZ / "scripts"))
import trombas_indices as ti  # noqa: E402

ENTRADA, SALIDA = DATOS / "era5", DATOS / "indices"
G, MS_A_KT, LOTE = 9.80665, 1.943844, 24
GUARDAR = ["stp", "sherbe", "nst", "vgp", "hslc", "mucape", "mlcape", "mlcape3", "mlcin", "mllcl", "ebsmu", "srh500", "bwd06",
           "shr01", "lr01", "lr03", "lr75", "dT", "dZ", "w850"]


def abrir(ruta):
    import xarray as xr
    if zipfile.is_zipfile(ruta):                       # el CDS a veces entrega varios NetCDF dentro de un ZIP
        tmp = ruta.parent / (ruta.stem + "_zip")
        with zipfile.ZipFile(ruta) as z:
            z.extractall(tmp)
        ds = xr.merge([xr.open_dataset(p) for p in sorted(tmp.glob("*.nc"))], compat="override")
    else:
        ds = xr.open_dataset(ruta)
    ren = {a: b for a, b in (("valid_time", "time"), ("pressure_level", "level"), ("isobaricInhPa", "level"), ("lat", "latitude"), ("lon", "longitude")) if a in ds.dims or a in ds.coords}
    ds = ds.rename(ren)
    for sobra in ("number", "expver"):
        if sobra in ds.dims:
            ds = ds.isel({sobra: 0})
    return ds


def var(ds, *nombres):
    for n in nombres:
        if n in ds:
            return ds[n]
    raise KeyError(f"no encuentro {nombres} en {list(ds.data_vars)}")


def mascara_costera(lsm, lat2):
    mar = lsm < 0.5
    tierra = ~mar
    cerca = np.zeros_like(tierra)
    for di in range(-2, 3):
        for dj in range(-2, 3):
            cerca |= np.roll(np.roll(tierra, di, 0), dj, 1)
    cerca[:2], cerca[-2:], cerca[:, :2], cerca[:, -2:] = False, False, False, False   # np.roll da la vuelta en los bordes
    return mar & cerca & (lat2 <= LAT_N) & (lat2 >= LAT_S)


def procesar(etiqueta):
    destino = SALIDA / f"idx_{etiqueta}.npz"
    if destino.exists():
        return "ya estaba"
    pl, sf = abrir(ENTRADA / f"pl_{etiqueta}.nc"), abrir(ENTRADA / f"sfc_{etiqueta}.nc")
    pl = pl.sel(level=[float(n) for n in NIVELES]).transpose("time", "level", "latitude", "longitude")
    sf = sf.transpose("time", "latitude", "longitude")
    if not np.array_equal(pl.time.values, sf.time.values):
        comunes = np.intersect1d(pl.time.values, sf.time.values)
        pl, sf = pl.sel(time=comunes), sf.sel(time=comunes)
    lat, lon = sf.latitude.values.astype(float), sf.longitude.values.astype(float)
    lon = np.where(lon > 180, lon - 360, lon)
    lon2, lat2 = np.meshgrid(lon, lat)
    lsm = np.nan_to_num(var(sf, "lsm").values[0], nan=1.0)
    m = mascara_costera(lsm, lat2)
    if not m.any():
        raise RuntimeError("la máscara costera quedó vacía: revisar el área descargada")
    zsfc = np.maximum(var(sf, "z").values[0][m] / G, 0.0)
    R = 6.371e6
    latr, lonr = np.radians(lat2), np.radians(lon2)
    dx, dy = np.gradient(lonr, axis=1) * R * np.cos(latr), np.gradient(latr, axis=0) * R
    p = np.array(NIVELES, float)
    nt, nc = pl.sizes["time"], int(m.sum())
    out = {k: np.full((nt, nc), np.nan, np.float32) for k in GUARDAR}
    for i in range(0, nt, LOTE):
        s = slice(i, min(i + LOTE, nt)); n = s.stop - s.start
        sup = lambda *nn: var(sf.isel(time=s), *nn).values[:, m].reshape(-1)                       # (n·nc,)
        niv = lambda *nn: np.moveaxis(var(pl.isel(time=s), *nn).values[:, :, m], 1, 2).reshape(n * nc, len(NIVELES))
        u10f, v10f = var(sf.isel(time=s), "u10").values, var(sf.isel(time=s), "v10").values
        zeta = (np.gradient(v10f, axis=2) / dx - np.gradient(u10f, axis=1) / dy)[:, m].reshape(-1)
        zs = np.tile(zsfc, n)
        with np.errstate(all="ignore"), warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            q = ti.calcular(p, sup("sp") / 100.0, zs, sup("t2m"), sup("d2m"), sup("u10"), sup("v10"),
                            niv("z") / G, niv("t"), np.clip(niv("r"), 0.5, 100.0), niv("u"), niv("v"))
            q["nst"] = ti.nst(q["lr01"], q["mlcape3"], q["mlcin"], q["bwd06"], -zeta)
            q["dT"] = sup("sst") - q["t850"]
            q["dZ"] = (q["el"] - q["mllcl"]) / 1000.0
            q["w850"] = np.hypot(q["u850"], q["v850"]) * MS_A_KT
        for k in GUARDAR:
            out[k][s] = np.asarray(q[k], np.float32).reshape(n, nc)
    SALIDA.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(destino, tiempo=pl.time.values.astype("datetime64[s]").astype(np.int64), lat=lat2[m].astype(np.float32),
                        lon=lon2[m].astype(np.float32), tramo=np.array([tramo(x) for x in lat2[m]], np.int8), **out)
    return f"{nt} horas × {nc} celdas"


def borrar(etiqueta):
    n = 0
    for f in (ENTRADA / f"pl_{etiqueta}.nc", ENTRADA / f"sfc_{etiqueta}.nc"):
        if f.exists():
            n += f.stat().st_size; f.unlink()
        d = f.parent / (f.stem + "_zip")
        if d.is_dir():
            for x in d.glob("*"):
                n += x.stat().st_size; x.unlink()
            d.rmdir()
    return n


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--solo")
    ap.add_argument("--borrar", action="store_true", help="borra el par pl_/sfc_ de ERA5 después de calcular sus índices")
    a = ap.parse_args()
    etiquetas = sorted(f.stem[3:] for f in ENTRADA.glob("pl_*.nc") if (ENTRADA / f"sfc_{f.stem[3:]}.nc").exists())
    if a.solo:
        etiquetas = [e for e in etiquetas if e == a.solo]
    if not etiquetas:
        sys.exit(f"No hay pares pl_/sfc_ en {ENTRADA}")
    liberado = 0
    for e in etiquetas:
        try:
            r = procesar(e)
            if a.borrar and e != "prueba":
                liberado += borrar(e)
                r += " · ERA5 borrado"
            print(f"{e}: {r}", flush=True)
        except Exception as ex:
            print(f"{e}: ERROR {ex!r}", flush=True)
    if liberado:
        print(f"Liberados {liberado / 1e9:.1f} GB de archivos de ERA5 ya procesados.")
    if a.solo:
        d = np.load(SALIDA / f"idx_{a.solo}.npz")
        print("Resumen de la prueba (mediana y extremos por variable):")
        for k in GUARDAR:
            v = d[k]; print(f"  {k:8s} mediana {np.nanmedian(v):9.2f}   mín {np.nanmin(v):9.2f}   máx {np.nanmax(v):9.2f}   sin dato {np.isnan(v).mean():.0%}")


if __name__ == "__main__":
    main()
