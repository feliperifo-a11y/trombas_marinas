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
python era5_descargar.py               # todo: 119 meses + días de eventos, 2 a la vez
python era5_indices.py --borrar        # índices por hora y celda costera, borrando cada mes ya procesado
python verificar.py                    # tablas en ~/trombas-era5/resultados/resumen.md y resumen.json
```

## Cuánto demora

La espera en la cola de Copernicus manda sobre todo lo demás: medido en noviembre de 2026, **más de una hora por
pedido**, sin importar su tamaño. De ahí salen las dos decisiones que hacen viable esto:

- **15 niveles de presión** en vez de los 20 de la página. Con 20, un mes da 12.000 campos y el servicio lo rechaza,
  obligando a partirlo en dos pedidos. Con 15 son 9.000 y el mes entra en uno solo. Se conservan todos los niveles
  bajo 700 hPa, que son los que mandan en CAPE, base de nube y cizalle.
- **Muestreo cada 3 horas** (12, 15, 18 y 21 UTC) en vez de cada hora. Con 12 horas por día, un mes supera el límite
  de tamaño por pedido y hay que partirlo en cuatro: 952 pedidos, unos 52 días de espera. Con 4 horas por día cada
  mes entra en un solo pedido: 238 pedidos.
- **Dos meses a la vez** (`--trabajos`). Copernicus encola pocos pedidos por conjunto de datos y rechaza el resto
  ("Maximum number queued requests for this dataset has been reached. Please configure your scripts to request data
  sequentially"). Con muchos trabajos los hilos se estorban entre sí; 2 es lo razonable. Cuando el servicio rechaza
  un pedido por cola llena, el script espera y lo vuelve a mandar en vez de descartarlo.

El muestreo tiene que ser el mismo para los días con tromba y sin tromba: si los días con evento se muestrearan más
fino, su máximo diario saldría más alto por construcción.

**El orden importa.** La descarga empieza por los 22 meses que contienen trombas y los días de la reserva, que son
los que no se pueden reemplazar, y sigue con el resto en orden aleatorio fijo. Así la descarga se puede detener en
cualquier momento y lo que haya alcanza para calibrar: están todos los eventos y una muestra de meses sin evento
repartida por todo el período, en vez de los primeros años solamente. Con 2 trabajos, los meses con trombas están
listos en poco más de un día; el total es cerca de una semana.

## Espacio en disco

La descarga completa son unos 7 GB (alrededor de 60 MB por mes, ya comprimidos). Los archivos de
ERA5 solo sirven para calcular los índices, que ocupan menos de 1 GB en total. Con `--borrar`, `era5_indices.py`
elimina cada par `pl_`/`sfc_` apenas lo procesa, así que el disco nunca guarda más de un mes a la vez.

Conviene dejar la descarga corriendo en una ventana y, cada cierto rato, correr `era5_indices.py --borrar` en otra:
`era5_descargar.py` escribe primero un archivo `.parcial` y solo le pone el nombre definitivo cuando termina, así que
nunca se procesa una descarga a medio bajar. Si después se borra un mes que hacía falta, basta volver a descargarlo.

Copernicus rechaza un pedido que supere su límite de tamaño ("cost limits exceeded"). Cuando pasa, `era5_descargar.py`
parte el mes en tramos de días hasta que lo acepta (archivos `pl_AAAAMMdDD.nc`) y reutiliza ese tamaño en los meses
siguientes. Los scripts de índices y verificación tratan cada tramo igual que un mes, sin cambios.

La descarga depende de la cola del servicio de Copernicus y puede tomar desde horas hasta más de un día. Los tres
scripts se pueden interrumpir y volver a correr: no repiten lo ya hecho. `verificar.py` funciona con lo que haya
descargado, así que se puede mirar un avance parcial.

## Revisar en la prueba

`era5_indices.py --solo prueba` imprime mediana y extremos de cada variable. Antes de lanzar todo, mirar que sean
razonables para un día de invierno frente a la costa: ΔT mar–850 hPa de unos pocos a ~15 °C, MUCAPE de 0 a algunos
cientos de J/kg, base de nube de cientos de metros, viento en 850 hPa en nudos. Valores absurdos indican un problema
de unidades o de formato del archivo.

## Qué mide y qué no

- Unidad: el tramo-día (cuatro tramos de costa entre 34° y 42,5° S; abril a octubre; 12, 15, 18 y 21 UTC).
- Un tramo-día sin registro no es un tramo-día sin tromba. Por eso se informa cuántas trombas captura cada umbral y
  qué fracción de días deja bajo aviso, no una tasa de falsas alarmas.
- Intervalos por remuestreo de días completos, porque las trombas llegan en racimos.
- El índice de Szilagyi (SWI) no se calcula: su nomograma no tiene fórmula publicada que se haya podido verificar.
  Se evalúan sus tres ingredientes por separado (ΔT, ΔZ y viento en 850 hPa).

## Prueba sin cuenta

`TROMBAS_ERA5=/tmp/trombas-prueba python prueba_sintetica.py` corre toda la cadena con datos inventados. Sirve solo
para detectar errores de programa; sus números no significan nada.
