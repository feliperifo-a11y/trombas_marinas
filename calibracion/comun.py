"""Definiciones compartidas de la calibración con ERA5 (dominio, período, tramos y lectura del catálogo de eventos)."""
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

RAIZ = Path(__file__).resolve().parent.parent
DATOS = Path(os.environ.get("TROMBAS_ERA5", Path.home() / "trombas-era5"))   # fuera del repositorio
ANIOS = range(2010, 2027)
MESES = range(4, 11)            # abril a octubre
HORAS = range(12, 24)           # 12–23 UTC: horas de luz en Chile continental
LAT_N, LAT_S = -34.0, -42.5
AREA = [-33.5, -76.0, -43.0, -71.0]   # N, W, S, E (con margen para derivadas)
TRAMOS = [(-34.0, -36.0, "34°–36° S"), (-36.0, -38.5, "36°–38,5° S"), (-38.5, -40.2, "38,5°–40,2° S"), (-40.2, -42.5, "40,2°–42,5° S")]
NIVELES = [1000, 975, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300, 250, 200, 150]
TZ = ZoneInfo("America/Santiago")


def tramo(lat):
    """Índice del tramo de costa (0 a 3) o -1 si queda fuera del dominio."""
    for i, (n, s, _) in enumerate(TRAMOS):
        if s <= lat <= n and (lat < n or i == 0):
            return i
    return -1


def eventos():
    """Trombas marinas no dudosas del catálogo, desde 1940 y dentro del dominio."""
    ev = json.loads((RAIZ / "data" / "trombas_eventos.json").read_text(encoding="utf-8"))["eventos"]
    return [e for e in ev if e.get("tipo") == "marina" and e.get("nivel") != "dudosa" and e.get("lat") is not None
            and LAT_S <= e["lat"] <= LAT_N and e["fecha"] >= "1940"]


def hora_utc(e):
    """Hora del evento en UTC (datetime) o None si el catálogo no la da. De un rango se toma el inicio."""
    m = re.match(r"\s*(\d{1,2}):(\d\d)", e.get("hora") or "")
    if not m:
        return None
    a, me, d = (int(x) for x in e["fecha"].split("-"))
    return datetime(a, me, d, int(m[1]), int(m[2]), tzinfo=TZ).astimezone(timezone.utc)


def en_calibracion(fecha):
    return int(fecha[:4]) in ANIOS and int(fecha[5:7]) in MESES
