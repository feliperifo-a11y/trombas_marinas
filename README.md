# Trombas marinas · MeteoIA

Página experimental dedicada a las trombas marinas en la costa de Chile (zonas III a VI del Cuadro "F", subdivisión nacional de METAREA XV). Es un proyecto sin fines de lucro asociado a [MeteoIA](https://meteoia.cl).

**No constituye aviso.** Los avisos oficiales los emite el Servicio Meteorológico de la Armada en [meteoarmada.directemar.cl](https://meteoarmada.directemar.cl).

## Contenido

| Sección | Qué muestra | Script | Archivo |
|---|---|---|---|
| Probabilidad por zona | Porcentaje de miembros del ensamble (GEFS 0,5°, 31 miembros; ECMWF ENS 0,25°, 50 miembros) en que algún punto de mar de la zona supera STP ≤ −0,1, alto cizalle con CAPE bajo (HSLC) o NST > 1, por día y cada 6 h, a 72 h | `scripts/trombas_ens.py`, `scripts/trombas_ens_ecmwf.py` | `data/trombas_prob.json`, `data/trombas_prob_ecmwf.json` |
| Detalle por celda | Celdas de 0,25° sobre umbral en la corrida más reciente del GFS y del ECMWF IFS, cada 3 h hasta 72 h, con sus ingredientes | `scripts/trombas.py`, `scripts/trombas_ecmwf.py` | `data/trombas.json`, `data/trombas_ecmwf.json` |
| Avisos archivados | Qué mostraba el GFS en el área de cada aviso de trombas: al emitir, durante la vigencia y en un día de referencia 7 días antes | `scripts/trombas_avisos.py` | `data/trombas_avisos.json` (se acumula en el repositorio) |
| Ficha técnica | Mecanismos, índices, umbrales y referencias | — | `assets/trombas.js` |

Los índices se calculan en `scripts/trombas_indices.py` (validado contra MetPy). Los avisos anteriores a 2026-11 están en `data/trombas_avisos_historicos.json` (lista curada: oficiales y de prensa que citan al CMM).

## Actualización

GitHub Actions (`.github/workflows/actualizar.yml`) corre cada hora y en cada cambio de la página o los scripts. Cada script trabaja solo cuando hay corrida nueva o aviso nuevo; si falla, se mantiene el archivo anterior. Los avisos vigentes se leen de `https://meteoia.cl/data/avisos.json`.

## Umbrales y fuentes

- STP (hemisferio sur) ≤ −0,1: Marín et al. (2024), *Monthly Weather Review*, 152(8). doi:10.1175/MWR-D-23-0249.1
- HSLC (SHERBE ≥ 1, cizalle efectivo > 18 m/s, MUCAPE < 1000 J/kg): Marín et al. (2026), *Atmospheric Research*, 344, 109331. doi:10.1016/j.atmosres.2026.109331
- NST > 1: SPC/NWS, sin validación en Chile.

Los umbrales provienen de tornados sobre tierra y no están calibrados para trombas. El archivo de avisos existe precisamente para ir calibrándolos.

## Datos

NOAA/NCEP: GFS 0,25° y GEFS 0,5° (NOMADS y archivo en AWS). ECMWF: IFS y ENS 0,25° de sus datos abiertos en AWS (licencia CC-BY-4.0, atribución visible en la página; `scripts/ecmwf_datos.py` baja solo los mensajes necesarios). ECMWF publica 1000, 925 y 850 hPa bajo 700 hPa y no publica TSM (ΔT usa la temperatura de piel). Límites de zonas: `data/geo/metarea.json`. Tierra: `data/geo/land.json`.
