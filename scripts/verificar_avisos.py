#!/usr/bin/env python3
"""Verificación de los avisos de trombas marinas contra las trombas observadas → data/verificacion_avisos.json

Cruza el archivo de avisos (data/trombas_avisos.json, horas en UTC, con los límites norte y sur de cada uno) con el
catálogo de trombas observadas (data/trombas_eventos.json, horas en hora de Chile) y responde dos preguntas:

  · ¿Qué fracción de las trombas observadas ocurrió dentro de un aviso vigente? (probabilidad de detección, POD)
  · ¿Cuánto cuesta esa detección, medida como la fracción del tiempo y de la costa bajo aviso?

NO se calcula tasa de falsa alarma. Un aviso sin tromba observada no es una falsa alarma: el registro de trombas
depende de que alguien mire, y casi todas las conocidas son de día y frente a lugares poblados. Lo que sí se puede
afirmar es cuántas de las trombas que SÍ se vieron quedaron cubiertas, y a qué costo en tiempo bajo aviso.

Para saber si la detección es mejor que el azar se compara el POD observado con el que daría un aviso puesto al azar
cubriendo la misma fracción de tiempo en la latitud de cada evento (prueba binomial de una cola).

Uso:  python scripts/verificar_avisos.py
"""
import json
import math
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

R = Path(__file__).resolve().parent.parent
DATOS = R / "data"
SALIDA = DATOS / "verificacion_avisos.json"
CHILE = timezone(timedelta(hours=-3))          # el catálogo guarda hora de Chile; ERA5 y los avisos, UTC
PASO_LAT = 0.1                                  # grilla de latitud para medir la cobertura
REGIONES = [("Maule", -34.75, -35.95), ("Ñuble", -35.95, -36.45), ("Biobío", -36.45, -38.45),
            ("La Araucanía", -38.45, -39.4), ("Los Ríos", -39.4, -40.2)]


def leer(nombre):
    return json.loads((DATOS / nombre).read_text(encoding="utf-8"))


def utc(s):
    """Texto ISO sin zona horaria del archivo de avisos: ya viene en UTC."""
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc)


def avisos():
    """[(desde_utc, hasta_utc, norte, sur, etiqueta, fuente)] de data/trombas_avisos.json."""
    out = []
    for k, a in leer("trombas_avisos.json")["avisos"].items():
        if not a.get("desde") or not a.get("hasta"):
            continue
        tramos = a.get("zonas_aviso") or []
        for z in tramos:
            n, s = z.get("north"), z.get("south")
            if n is None or s is None:
                continue
            out.append({"desde": utc(a["desde"]), "hasta": utc(a["hasta"]), "norte": float(n), "sur": float(s),
                        "id": k, "fuente": a.get("fuente"), "zonas": z.get("areas") or a.get("zonas")})
    return sorted(out, key=lambda x: x["desde"])


def eventos(desde, hasta):
    """Trombas marinas no dudosas del catálogo dentro del período del archivo de avisos."""
    out = []
    for e in leer("trombas_eventos.json")["eventos"]:
        if e.get("tipo") != "marina" or e.get("nivel") == "dudosa" or e.get("lat") is None:
            continue
        h = (e.get("hora") or "")[:5]
        hh = h if len(h) == 5 and h[2] == ":" else None
        d = datetime.fromisoformat(e["fecha"] + "T" + (hh or "00:00")).replace(tzinfo=CHILE)
        ini = d.astimezone(timezone.utc)
        fin = ini if hh else ini + timedelta(hours=23, minutes=59)
        if fin < desde or ini > hasta:
            continue
        out.append({**e, "ini": ini, "fin": fin, "hora_exacta": bool(hh)})
    return sorted(out, key=lambda e: e["ini"])


def wilson(k, n, z=1.96):
    """Intervalo de confianza de 95 % para una proporción (Wilson), robusto con muestras chicas."""
    if not n:
        return [None, None]
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    r = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(max(0, c - r), 3), round(min(1, c + r), 3)]


def binomial_cola(k, n, p):
    """P(X >= k) con X ~ Binomial(n, p): probabilidad de capturar al menos k por azar."""
    if not n or p <= 0:
        return None
    if p >= 1:
        return 1.0
    return round(sum(math.comb(n, i) * p ** i * (1 - p) ** (n - i) for i in range(k, n + 1)), 6)


def main():
    av = avisos()
    if not av:
        sys.exit("No hay avisos con límites norte y sur en data/trombas_avisos.json")
    desde, hasta = min(a["desde"] for a in av), max(a["hasta"] for a in av)
    ev = eventos(desde, hasta)

    # Cobertura: fracción de las horas del período bajo aviso, en cada latitud
    horas = int((hasta - desde).total_seconds() // 3600)
    lats = [round(-34.0 - i * PASO_LAT, 2) for i in range(int((42.5 - 34.0) / PASO_LAT) + 1)]
    bajo = {la: 0 for la in lats}
    for a in av:
        h = int((a["hasta"] - a["desde"]).total_seconds() // 3600)
        for la in lats:
            if a["sur"] <= la <= a["norte"]:
                bajo[la] += h
    cobertura = {la: min(1.0, bajo[la] / horas) for la in lats}          # min: avisos que se solapan
    cob = lambda la: cobertura[min(lats, key=lambda x: abs(x - la))]

    # ¿Cada tromba cayó dentro de un aviso vigente?
    detalle, capturadas = [], 0
    for e in ev:
        dentro = [a for a in av if a["sur"] <= e["lat"] <= a["norte"] and a["desde"] <= e["fin"] and e["ini"] <= a["hasta"]]
        a0 = min(dentro, key=lambda a: a["desde"]) if dentro else None
        capturadas += bool(dentro)
        motivo, brecha = None, None
        if not dentro:
            en_lat = [a for a in av if a["sur"] <= e["lat"] <= a["norte"]]
            if not en_lat:
                motivo = "fuera del tramo de costa que cubren los avisos archivados"
            else:
                a_hora = [a for a in av if a["desde"] <= e["fin"] and e["ini"] <= a["hasta"]]
                if a_hora:
                    motivo = "había aviso a esa hora, pero en otro tramo de costa"
                else:
                    # ¿Por cuánto se pasó? El aviso más cercano en el tiempo dentro de su latitud
                    cerca = min(en_lat, key=lambda a: min(abs((e["ini"] - a["hasta"]).total_seconds()), abs((a["desde"] - e["fin"]).total_seconds())))
                    def cuanto(horas):
                        return f"{round(horas * 60)} min" if horas < 1 else f"{horas:.0f} h"
                    aprox = "" if e["hora_exacta"] else " al menos "
                    if cerca["hasta"] < e["ini"]:
                        brecha = round((e["ini"] - cerca["hasta"]).total_seconds() / 3600, 2)
                        motivo = f"el aviso de su tramo terminó{aprox or ' '}{cuanto(brecha)} antes"
                    else:
                        brecha = round((cerca["desde"] - e["fin"]).total_seconds() / 3600, 2)
                        motivo = f"el aviso de su tramo empezó{aprox or ' '}{cuanto(brecha)} después"
        detalle.append({
            "id": e["id"], "fecha": e["fecha"], "hora": e.get("hora"), "hora_exacta": e["hora_exacta"],
            "lugar": e["lugar"], "lat": e["lat"], "nivel": e["nivel"], "en_aviso": bool(dentro),
            "aviso": a0["id"] if a0 else None,
            "anticipacion_h": round((e["ini"] - a0["desde"]).total_seconds() / 3600, 1) if a0 and e["hora_exacta"] else None,
            "motivo": motivo, "brecha_h": brecha,
            "cobertura_en_su_latitud": round(cob(e["lat"]), 4),
        })

    # Las trombas fuera del tramo de costa que cubren los avisos no miden el acierto del pronóstico, sino el alcance
    # del sistema de avisos: se informan aparte y no entran en el POD.
    sin_cobertura = [t for t in detalle if t["motivo"] and t["motivo"].startswith("fuera del tramo")]
    ids_sin = {t["id"] for t in sin_cobertura}
    ev = [e for e in ev if e["id"] not in ids_sin]
    detalle_pod = [t for t in detalle if t["id"] not in ids_sin]
    capturadas = sum(1 for t in detalle_pod if t["en_aviso"])
    n = len(ev)
    esperado = sum(cob(e["lat"]) for e in ev) / n if n else 0        # POD que daría el azar con la misma cobertura
    res = {
        "generado": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "_ayuda": ("Verificación de los avisos de trombas contra las trombas observadas. NO incluye tasa de falsa alarma: "
                   "un aviso sin tromba observada no es una falsa alarma, porque el registro de trombas depende de que alguien "
                   "mire. 'esperado_por_azar' es el POD que daría un aviso puesto al azar con la misma cobertura en la latitud "
                   "de cada evento, y 'p_azar' la probabilidad de alcanzar el POD observado por casualidad."),
        "periodo": {"desde": desde.strftime("%Y-%m-%dT%H:%MZ"), "hasta": hasta.strftime("%Y-%m-%dT%H:%MZ"), "horas": horas},
        "avisos": {"n": len({a["id"] for a in av}), "oficiales": len({a["id"] for a in av if a["fuente"] == "oficial"}),
                   "horas_bajo_aviso": sum(int((a["hasta"] - a["desde"]).total_seconds() // 3600) for a in {a["id"]: a for a in av}.values())},
        "fuera_del_alcance": [{"id": t["id"], "fecha": t["fecha"], "lugar": t["lugar"], "lat": t["lat"]} for t in sin_cobertura],
        "deteccion": {"trombas": n, "capturadas": capturadas, "pod": round(capturadas / n, 3) if n else None,
                      "ic95": wilson(capturadas, n), "esperado_por_azar": round(esperado, 3),
                      "p_azar": binomial_cola(capturadas, n, esperado)},
        "cobertura_por_region": [{"region": r, "cobertura": round(sum(cobertura[la] for la in lats if min(s, nte) <= la <= max(s, nte)) /
                                                                  max(1, len([la for la in lats if min(s, nte) <= la <= max(s, nte)])), 4),
                                  "trombas": sum(1 for t in detalle_pod if min(s, nte) <= t["lat"] <= max(s, nte)),
                                  "capturadas": sum(1 for t in detalle_pod if t["en_aviso"] and min(s, nte) <= t["lat"] <= max(s, nte))}
                                 for r, nte, s in REGIONES],
        "trombas": detalle,
    }
    SALIDA.write_text(json.dumps(res, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    d = res["deteccion"]
    pc = lambda v: "–" if v is None else f"{100 * v:.0f} %"
    print(f"Período: {desde:%d-%m-%Y} a {hasta:%d-%m-%Y} ({horas} h)")
    print(f"Avisos archivados: {res['avisos']['n']} ({res['avisos']['oficiales']} oficiales), {res['avisos']['horas_bajo_aviso']} h bajo aviso")
    print(f"Trombas observadas: {d['trombas']} · dentro de un aviso: {d['capturadas']} (POD {pc(d['pod'])}, IC95 {pc(d['ic95'][0])}–{pc(d['ic95'][1])})")
    print(f"POD que daría el azar con la misma cobertura: {pc(d['esperado_por_azar'])} · probabilidad de lograr lo observado por casualidad: {d['p_azar']}")
    print()
    print(f"{'Región':<14}{'cobertura':>11}{'trombas':>9}{'dentro':>8}")
    for r in res["cobertura_por_region"]:
        print(f"{r['region']:<14}{pc(r['cobertura']):>11}{r['trombas']:>9}{r['capturadas']:>8}")
    if sin_cobertura:
        print(f"\nFuera del tramo de costa que cubren los avisos ({len(sin_cobertura)}, no entran en el POD):")
        for t in sin_cobertura:
            print(f"  {t['fecha']}  {t['lugar'][:38]:40s} {t['lat']}°")
    fuera = [t for t in detalle_pod if not t["en_aviso"]]
    if fuera:
        print(f"\nQuedaron fuera {len(fuera)}:")
        for t in fuera:
            print(f"  {t['fecha']} {t['hora'] or '--:--'}  {t['lugar'][:38]:40s} {t['motivo']}")
    ant = [t["anticipacion_h"] for t in detalle if t["anticipacion_h"] is not None]
    if ant:
        ant.sort()
        print(f"\nAnticipación del aviso (solo trombas con hora exacta, n={len(ant)}): mediana {ant[len(ant) // 2]:.0f} h, de {ant[0]:.0f} a {ant[-1]:.0f} h")


if __name__ == "__main__":
    main()
