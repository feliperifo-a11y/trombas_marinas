"""Sondeo de los datos abiertos de ECMWF (solo lectura de índices y un mensaje de prueba)."""
import json, time, collections, requests
from datetime import datetime, timedelta, timezone
B = "https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com"
H = {"User-Agent": "trombas-marinas/1.0 (sondeo)"}
now = datetime.now(timezone.utc)
for k in range(6):
    c = now.replace(minute=0, second=0, microsecond=0, hour=now.hour // 6 * 6) - timedelta(hours=6 * k)
    d, h = c.strftime("%Y%m%d"), c.strftime("%H")
    for res, stream, typ in [("0p25", "oper", "fc"), ("0p25", "enfo", "ef"), ("0p25", "scda", "fc")]:
        for paso in (0, 72):
            u = f"{B}/{d}/{h}z/ifs/{res}/{stream}/{d}{h}0000-{paso}h-{stream}-{typ}.index"
            r = requests.get(u, headers=H, timeout=30)
            print(d, h, res, stream, paso, r.status_code, len(r.text))
            if r.status_code != 200:
                continue
            L = [json.loads(x) for x in r.text.splitlines()]
            cnt = collections.Counter((x.get("param"), x.get("levtype")) for x in L)
            lev = collections.defaultdict(set)
            for x in L:
                if x.get("levtype") == "pl": lev[x["param"]].add(x.get("levelist"))
            nums = sorted({int(x.get("number", 0)) for x in L})
            tam = sorted(x["_length"] for x in L)
            print("   params:", dict(cnt))
            print("   niveles pl:", {k: sorted(v, key=lambda s: -int(s)) for k, v in lev.items()})
            print("   miembros:", nums[:3], "...", nums[-3:], len(nums), "| mensajes", len(L), "| bytes total", sum(tam), "| mediana msg", tam[len(tam)//2])
            print("   ejemplo:", L[0])
            if paso == 0 and stream == "oper":
                t0 = time.time(); x = L[0]
                g = requests.get(u.replace(".index", ".grib2"), headers={**H, "Range": f"bytes={x['_offset']}-{x['_offset']+x['_length']-1}"}, timeout=60)
                print("   descarga 1 msg", g.status_code, len(g.content), f"{time.time()-t0:.2f}s")
    if any(True for _ in [0]):
        pass
    break
