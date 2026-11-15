# Calibración de umbrales con ERA5

Comprueba con datos chilenos qué índices separan los días con tromba de los días sin tromba, y con qué umbral.
Usa el catálogo `data/trombas_eventos.json` y el mismo código de índices de la página (`scripts/trombas_indices.py`).
El diseño completo está en el documento "Calibración de umbrales de trombas marinas con ERA5".

Corre en un computador propio (no en GitHub Actions). Los datos quedan fuera del repositorio, en `~/trombas-era5`
(se cambia con la variable `TROMBAS_ERA5`).

## Una sola vez

1. Crear una cuenta gratuita en https://cds.climate.copernicus.eu y aceptar la licencia de ERA5 en la página de cada
   conjunto de datos ("ERA5 hourly data on pressure levels" y "on single levels").
2. Guardar la clave personal en `~/.cdsapirc`, con el contenido exacto que muestra la página "CDSAPI setup" del sitio.
3. Instalar: `pip install -r calibracion/requirements.txt`

## Pasos

```bash
cd calibracion
python era5_descargar.py --probar      # un día: confirma que la cuenta funciona
python era5_indices.py --solo prueba   # confirma que el formato se lee y muestra valores para revisar
python era5_descargar.py               # todo: 119 meses + días de eventos fuera de temporada
python era5_indices.py --borrar        # índices por hora y celda costera, borrando cada mes ya procesado
python verificar.py                    # tablas en ~/trombas-era5/resultados/resumen.md y resumen.json
```

## Espacio en disco

La descarga completa son unos 15 GB (118 MB de niveles de presión y 9 MB de superficie por mes). Los archivos de
ERA5 solo sirven para calcular los índices, que ocupan menos de 1 GB en total. Con `--borrar`, `era5_indices.py`
elimina cada par `pl_`/`sfc_` apenas lo procesa, así que el disco nunca guarda más de un mes a la vez.

Conviene dejar la descarga corriendo en una ventana y, cada cierto rato, correr `era5_indices.py --borrar` en otra:
`era5_descargar.py` escribe primero un archivo `.parcial` y solo le pone el nombre definitivo cuando termina, así que
nunca se procesa una descarga a medio bajar. Si después se borra un mes que hacía falta, basta volver a descargarlo.

La descarga depende de la cola del servicio de Copernicus y puede tomar desde horas hasta más de un día. Los tres
scripts se pueden interrumpir y volver a correr: no repiten lo ya hecho. `verificar.py` funciona con lo que haya
descargado, así que se puede mirar un avance parcial.

## Revisar en la prueba

`era5_indices.py --solo prueba` imprime mediana y extremos de cada variable. Antes de lanzar todo, mirar que sean
razonables para un día de invierno frente a la costa: ΔT mar–850 hPa de unos pocos a ~15 °C, MUCAPE de 0 a algunos
cientos de J/kg, base de nube de cientos de metros, viento en 850 hPa en nudos. Valores absurdos indican un problema
de unidades o de formato del archivo.

## Qué mide y qué no

- Unidad: el tramo-día (cuatro tramos de costa entre 34° y 42,5° S; abril a octubre; 12–23 UTC).
- Un tramo-día sin registro no es un tramo-día sin tromba. Por eso se informa cuántas trombas captura cada umbral y
  qué fracción de días deja bajo aviso, no una tasa de falsas alarmas.
- Intervalos por remuestreo de días completos, porque las trombas llegan en racimos.
- El índice de Szilagyi (SWI) no se calcula: su nomograma no tiene fórmula publicada que se haya podido verificar.
  Se evalúan sus tres ingredientes por separado (ΔT, ΔZ y viento en 850 hPa).

## Prueba sin cuenta

`TROMBAS_ERA5=/tmp/trombas-prueba python prueba_sintetica.py` corre toda la cadena con datos inventados. Sirve solo
para detectar errores de programa; sus números no significan nada.
