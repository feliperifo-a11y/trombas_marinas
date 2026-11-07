import sys, time, requests
from datetime import datetime, timedelta, timezone
H = {"User-Agent": "trombas-marinas/1.0 (datos abiertos ECMWF)"}
now = datetime.now(timezone.utc)
c = now.replace(minute=0, second=0, microsecond=0, hour=now.hour // 12 * 12)
BASES = {"ecmwf": "https://data.ecmwf.int/forecasts", "azure": "https://ai4edataeuwest.blob.core.windows.net/ecmwf",
         "google": "https://storage.googleapis.com/ecmwf-open-data", "aws": "https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com"}
for k in range(4):
    cc = c - timedelta(hours=12 * k); d, h = cc.strftime("%Y%m%d"), cc.strftime("%H")
    ruta = f"/{d}/{h}z/ifs/0p25/enfo/{d}{h}0000-0h-enfo-ef"
    ok = False
    for n, b in BASES.items():
        try:
            ri = requests.get(b + ruta + ".index", headers=H, timeout=30)
            t0 = time.time()
            rg = requests.get(b + ruta + ".grib2", headers={**H, "Range": "bytes=0-49999999"}, timeout=120)
            print(d, h, n, "índice", ri.status_code, "| 50 MB:", rg.status_code, len(rg.content), f"{time.time()-t0:.1f}s", "" if rg.status_code == 206 else rg.text[:120])
            ok = ok or ri.status_code == 200
        except Exception as e:
            print(d, h, n, "error", e)
        time.sleep(1)
    if ok:
        # varias lecturas seguidas en el mejor espejo para medir el límite
        for n, b in BASES.items():
            t0, cods = time.time(), []
            for i in range(10):
                rg = requests.get(b + ruta + ".grib2", headers={**H, "Range": f"bytes={i*5_000_000}-{i*5_000_000+4_999_999}"}, timeout=60)
                cods.append(rg.status_code)
            print("  10 lecturas seguidas", n, cods, f"{time.time()-t0:.1f}s")
        break
