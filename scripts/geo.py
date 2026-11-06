#!/usr/bin/env python3
"""Polígonos de tierra para excluir costa, canales y aguas interiores (data/geo/land.json).

Misma decodificación que usa MeteoIA (polilínea codificada con precisión 1e-6): así los puntos de mar que
evalúan trombas_ens.py y trombas_avisos.py coinciden con los de las alertas de viento y marejadas.
"""
import json
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data"


def leer(p, defecto):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except Exception:
        return defecto


def _dec(s):
    out, i, lat, lon = [], 0, 0, 0
    while i < len(s):
        for k in range(2):
            sh = res = 0
            while True:
                b = ord(s[i]) - 63; i += 1; res |= (b & 0x1F) << sh; sh += 5
                if b < 0x20:
                    break
            d = ~(res >> 1) if res & 1 else res >> 1
            if k == 0:
                lat += d
            else:
                lon += d
        out.append((lon / 1e6, lat / 1e6))
    return out


def tierra():
    from shapely.geometry import Polygon
    from shapely.ops import unary_union
    polys = []
    for c in leer(DATA / "geo" / "land.json", []):
        for poly in c["p"]:
            anillos = [_dec(r) for r in poly]
            if len(anillos[0]) >= 3:
                g = Polygon(anillos[0], [r for r in anillos[1:] if len(r) >= 3]).buffer(0)
                if not g.is_empty:
                    polys.append(g)
    return unary_union(polys)
