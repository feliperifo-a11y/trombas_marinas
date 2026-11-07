import sys, time, json, requests
sys.path.insert(0, "scripts")
import ecmwf_datos as ed
from datetime import datetime, timedelta, timezone
now = datetime.now(timezone.utc)
c = now.replace(minute=0, second=0, microsecond=0, hour=now.hour // 12 * 12)
for _ in range(4):
    ind = ed.indice(c, "enfo", "ef", 72)
    if ind: break
    c -= timedelta(hours=12)
print("corrida", c, "mensajes", len(ind))
u = ed.url(c, "enfo", "ef", 0, "grib2")
r = requests.head(u, headers=ed.CAB, timeout=30); print("HEAD", r.status_code, r.headers.get("Content-Length"), dict((k, v) for k, v in r.headers.items() if k.lower().startswith("x-")))
for mb in (1, 10, 50, 120):
    t0 = time.time()
    r = requests.get(u, headers={**ed.CAB, "Range": f"bytes=0-{mb*1_000_000-1}"}, timeout=120)
    print(f"{mb} MB:", r.status_code, len(r.content), f"{time.time()-t0:.1f}s", r.text[:250] if r.status_code != 206 else "")
    time.sleep(2)
# orden de los mensajes en el archivo (primeros 40)
ind0 = ed.indice(c, "enfo", "ef", 0)
print([(e.get("number"), e.get("param"), e.get("levelist")) for e in ind0[:40]])
inf = {}
sel = [e for e in ind0 if __import__("trombas_ens_ecmwf").elegir(e)]
print("necesarios", len(sel), "MB", round(sum(e["_length"] for e in sel)/1e6))
for hueco in (0, 1_000_000, 3_000_000, 10_000_000):
    s = sorted(sel, key=lambda e: e["_offset"]); b = []
    for e in s:
        ini, fin = e["_offset"], e["_offset"] + e["_length"] - 1
        if b and ini - b[-1][1] - 1 <= hueco and fin - b[-1][0] < 120_000_000: b[-1][1] = fin
        else: b.append([ini, fin])
    print("hueco", hueco, "lecturas", len(b), "MB", round(sum(x[1]-x[0]+1 for x in b)/1e6))
