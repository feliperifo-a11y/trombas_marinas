"""Sondeo de los datos abiertos de ECMWF (solo lectura de índices y un mensaje de prueba)."""
import json, time, collections, requests
from datetime import datetime, timedelta, timezone
B = "https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com"
H = {"User-Agent": "trombas-marinas/1.0 (sondeo)"}
S = requests.Session()
def pedir(u, extra=None, timeout=60):
    espera = 2
    for _ in range(8):
        r = S.get(u, headers={**H, **(extra or {})}, timeout=timeout)
        if r.status_code not in (429, 500, 502, 503, 504):
            return r
        time.sleep(espera); espera = min(espera * 2, 40)
    return r
def resumen(u):
    r = pedir(u)
    print("  ", u.rsplit("/", 4)[-4:], r.status_code)
    if r.status_code != 200:
        return None
    L = [json.loads(x) for x in r.text.splitlines()]
    cnt = collections.Counter((x.get("param"), x.get("levtype")) for x in L)
    lev = collections.defaultdict(set)
    for x in L:
        if x.get("levtype") == "pl": lev[x["param"]].add(int(x.get("levelist")))
    nums = sorted({int(x.get("number", 0)) for x in L})
    tam = sorted(x["_length"] for x in L)
    print("   params:", dict(cnt))
    print("   niveles pl:", {k: sorted(v, reverse=True) for k, v in lev.items()})
    print("   miembros:", nums[:2], "...", nums[-2:], len(nums), "| mensajes", len(L), "| MB total", round(sum(tam)/1e6), "| mediana msg kB", tam[len(tam)//2]//1000)
    print("   ejemplo:", {k: v for k, v in L[0].items()})
    return L
now = datetime.now(timezone.utc)
c = now.replace(minute=0, second=0, microsecond=0, hour=now.hour // 6 * 6)
for k in range(8):
    cc = c - timedelta(hours=6 * k); d, h = cc.strftime("%Y%m%d"), cc.strftime("%H")
    u = f"{B}/{d}/{h}z/ifs/0p25/oper/{d}{h}0000-72h-oper-fc.index"
    if pedir(u, timeout=30).status_code == 200:
        print("Corrida con 72 h:", d, h); break
    time.sleep(1)
L = resumen(f"{B}/{d}/{h}z/ifs/0p25/oper/{d}{h}0000-72h-oper-fc.index")
if L:
    x = L[0]; t0 = time.time()
    g = pedir(f"{B}/{d}/{h}z/ifs/0p25/oper/{d}{h}0000-72h-oper-fc.grib2", {"Range": f"bytes={x['_offset']}-{x['_offset']+x['_length']-1}"})
    print("   1 msg:", g.status_code, len(g.content), f"{time.time()-t0:.2f}s")
    import eccodes
    hh = eccodes.codes_new_from_message(g.content)
    for key in ("Ni", "Nj", "packingType", "latitudeOfFirstGridPointInDegrees", "longitudeOfFirstGridPointInDegrees"):
        print("     ", key, eccodes.codes_get(hh, key))
# ENS: corridas 00/12
for k in range(4):
    cc = now.replace(minute=0, second=0, microsecond=0, hour=now.hour // 12 * 12) - timedelta(hours=12 * k); d2, h2 = cc.strftime("%Y%m%d"), cc.strftime("%H")
    u = f"{B}/{d2}/{h2}z/ifs/0p25/enfo/{d2}{h2}0000-72h-enfo-ef.index"
    if pedir(u, timeout=30).status_code == 200:
        print("ENS con 72 h:", d2, h2); resumen(u); break
# AIFS
for k in range(4):
    cc = c - timedelta(hours=6 * k); d3, h3 = cc.strftime("%Y%m%d"), cc.strftime("%H")
    u = f"{B}/{d3}/{h3}z/aifs-single/0p25/oper/{d3}{h3}0000-72h-oper-fc.index"
    r = pedir(u, timeout=30)
    if r.status_code == 200:
        print("AIFS con 72 h:", d3, h3); resumen(u); break
