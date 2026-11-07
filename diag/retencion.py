import sys, requests
from datetime import datetime, timedelta, timezone
sys.path.insert(0, "scripts")
import ecmwf_datos as ed
now = datetime.now(timezone.utc)
c0 = now.replace(minute=0, second=0, microsecond=0, hour=now.hour // 6 * 6)
for base in ed.ESPEJOS:
    ok = []
    for k in range(0, 4 * 30):
        c = c0 - timedelta(hours=6 * k)
        u = ed.url(c, "oper", "fc", 3, "index", base=base)
        try:
            r = requests.head(u, headers=ed.CAB, timeout=20)
        except Exception:
            continue
        if r.status_code == 200:
            ok.append(c)
    print(base.split("/")[2], len(ok), "corridas con +3 h;", "más antigua", min(ok) if ok else None)
