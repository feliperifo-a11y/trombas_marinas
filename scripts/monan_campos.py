#!/usr/bin/env python3
"""Campos de pronóstico de MONAN para el mapa de la página → data/monan_campos.json

Corre en el computador que ejecuta MONAN, junto con trombas_monan.py. Lee las salidas diag.*.nc cada 3 h
(los mismos plazos que la tira de horas) y guarda, celda por celda de la malla de Voronoi:
  viento a 10 m (kt, componentes u y v), temperatura a 2 m (°C), CAPE (J/kg) y precipitación acumulada (mm).
También guarda la geometría de las celdas (vértices) para dibujarlas con su forma real.

Uso:
    python monan_campos.py DIRECTORIO_CORRIDA SALIDA.json [ARCHIVO_INIT]

Estimación automática y experimental: no constituye aviso.
"""
import glob
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from netCDF4 import Dataset

VERSION = 1
MS_A_KT = 1.943844
CADA_H = 3


def entero(a, esc, lim=1e5):
    a = np.asarray(a, float) * esc
    return [None if (not np.isfinite(x) or abs(x) > lim * esc) else int(round(x)) for x in a]


def texto(v):
    return "".join(c.decode() if isinstance(c, bytes) else c for c in np.asarray(v).astype(str)).strip()


def main():
    corrida, salida = Path(sys.argv[1]), Path(sys.argv[2])
    init = Path(sys.argv[3]) if len(sys.argv) > 3 else next(iter(sorted(corrida.glob("*.init.nc"))), None)
    if init is None:
        raise SystemExit("Falta el archivo *.init.nc de la corrida")
    g = Dataset(init); g.set_auto_mask(False)
    nE = g["nEdgesOnCell"][:]; voc = g["verticesOnCell"][:] - 1
    latV = np.degrees(g["latVertex"][:]); lonV = np.degrees(g["lonVertex"][:]); lonV = np.where(lonV > 180, lonV - 360, lonV)
    land = g["landmask"][:]; bdy = g["bdyMaskCell"][:] if "bdyMaskCell" in g.variables else np.zeros(nE.size, int)
    ini = datetime.strptime(texto(g["xtime"][0]), "%Y-%m-%d_%H:%M:%S")
    g.close()
    nC = nE.size
    usados = np.unique(np.concatenate([voc[c, :nE[c]] for c in range(nC)]))
    remap = -np.ones(lonV.size, int); remap[usados] = np.arange(usados.size)
    celdas = [remap[voc[c, :nE[c]]].tolist() for c in range(nC)]

    plazos, U, V, T, CAPE, P = [], [], [], [], [], []
    for f in sorted(glob.glob(str(corrida / "diag.*.nc"))):
        d = Dataset(f); d.set_auto_mask(False)
        valida = datetime.strptime(texto(d["xtime"][0]), "%Y-%m-%d_%H:%M:%S")
        fhr = int(round((valida - ini).total_seconds() / 3600))
        if fhr % CADA_H:
            d.close(); continue
        u, v = d["u10"][0].astype(float), d["v10"][0].astype(float)
        t2 = d["t2m"][0].astype(float)
        if fhr == 0:                                       # en t = 0 MPAS no calcula los campos de 2 y 10 m
            u[:] = np.nan; v[:] = np.nan; t2[:] = np.nan
        cape = d["cape"][0].astype(float); cape[(cape < 0) | (cape > 1e5)] = np.nan
        pr = d["rainc"][0].astype(float) + d["rainnc"][0].astype(float)
        d.close()
        plazos.append({"fhr": fhr, "valida": valida.strftime("%Y-%m-%dT%H:%MZ")})
        U.append(entero(u * MS_A_KT, 1, 400)); V.append(entero(v * MS_A_KT, 1, 400))
        T.append(entero(t2 - 273.15, 10, 100)); CAPE.append(entero(cape, 1, 20000)); P.append(entero(pr, 10, 5000))
    if not plazos:
        raise SystemExit(f"No hay diag.*.nc en {corrida}")

    out = {"version": VERSION, "corrida": ini.strftime("%Y-%m-%dT%HZ"),
           "generado": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "fuente": "MONAN 2.0 (INPE/CPTEC), malla 12 → 3 km sobre el golfo de Arauco; inicial y bordes GFS 0,25°",
           "vlat": [round(float(x), 4) for x in latV[usados]], "vlon": [round(float(x), 4) for x in lonV[usados]],
           "celdas": celdas, "tierra": [int(x) for x in land], "borde": [int(x > 0) for x in bdy],
           "plazos": plazos,
           "campos": {"u10": {"esc": 1, "uni": "kt", "datos": U}, "v10": {"esc": 1, "uni": "kt", "datos": V},
                      "t2": {"esc": 10, "uni": "°C", "datos": T}, "cape": {"esc": 1, "uni": "J/kg", "datos": CAPE},
                      "precip": {"esc": 10, "uni": "mm", "datos": P}}}
    salida.parent.mkdir(parents=True, exist_ok=True)
    salida.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Campos MONAN: {nC} celdas, {len(plazos)} plazos → {salida} ({os.path.getsize(salida)/1e6:.2f} MB)")


if __name__ == "__main__":
    main()
