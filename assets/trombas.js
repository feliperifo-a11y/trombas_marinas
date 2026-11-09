// ============================ Trombas marinas: perspectiva 0–72 h, avisos archivados y ficha técnica ============================
// Lee data/trombas.json (scripts/trombas.py): STP (hemisferio sur), ambiente HSLC y NST calculados sobre el océano con el GFS 0,25°,
// e ingredientes del nomograma de Szilagyi. Estimación experimental: no constituye aviso. Toda cifra de la ficha lleva su fuente.
function crearTrombas(L, map, h) {
  // h.contenedor: elemento donde se inserta el panel; h.alCambiar(pestaña): aviso a la página (p. ej., ajustar el mapa)
  const escH = h.escH;
  const nf = (v, d = 1) => v == null ? '–' : Number(v).toFixed(d).replace('.', ',');
  const horaChile = iso => new Date(iso).toLocaleString('es-CL', { timeZone: 'America/Santiago', weekday: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', '');
  const hhChile = iso => new Date(iso).toLocaleString('es-CL', { timeZone: 'America/Santiago', hour: '2-digit', hour12: false });
  const diaChile = iso => new Date(iso).toLocaleDateString('es-CL', { timeZone: 'America/Santiago', weekday: 'short', day: 'numeric' }).replace('.', '');
  const dm = (v, pos, neg) => { const t = Math.round(Math.abs(v) * 60), g = Math.floor(t / 60), mi = t - g * 60; return `${g}°${String(mi).padStart(2, '0')}′ ${v < 0 ? neg : pos}`; };
  const COLOR = { stp: '#b3149a', hslc: '#f28c00', nst: '#1f6fb2' };
  const grupo = L.layerGroup();
  let datos = null, sel = null, cargado = 0;
  // Probabilidad por zona (GEFS, data/trombas_prob.json)
  const grupoZona = L.layerGroup();
  let prob = null, indProb = 'stp', celdaProb = null;
  // Modelos disponibles: mismo cálculo y mismo formato de archivo para comparar
  const MODELOS = {
    gfs: { det: 'data/trombas.json', prob: 'data/trombas_prob.json', nDet: 'GFS 0,25°', nProb: 'ensamble GEFS',
      sinDet: 'Se genera con cada corrida nueva del GFS (cuatro al día) cuando está disponible el plazo de 72 h.',
      sinProb: 'Se calcula con las corridas GEFS de 00 y 12 UTC cuando está disponible el plazo de 72 h.', atr: 'Datos: NOAA/NCEP.' },
    ecmwf: { det: 'data/trombas_ecmwf.json', prob: 'data/trombas_prob_ecmwf.json', nDet: 'ECMWF IFS 0,25°', nProb: 'ensamble ECMWF (ENS)',
      sinDet: 'Se genera con cada corrida nueva del IFS de ECMWF (cuatro al día) cuando está publicado el plazo de 72 h.',
      sinProb: 'Se calcula con las corridas ENS de 00 y 12 UTC cuando están publicados los 50 miembros a 72 h.',
      atr: 'Datos de ECMWF (open data), licencia <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC-BY-4.0</a>; los índices los calcula esta página.' },
    monan: { det: 'data/trombas_monan.json', prob: null, campos: 'data/monan_campos.json', puntos: 'data/monan_indices.json', nDet: 'MONAN 3 km', nProb: 'no disponible para MONAN',
      sinDet: 'Se genera con la corrida diaria de MONAN (malla 12 → 3 km sobre el golfo de Arauco) cuando termina.',
      sinProb: 'MONAN se corre de forma determinística (una sola corrida): no tiene ensamble ni probabilidad por zona.',
      atr: 'Modelo comunitario <a href="https://github.com/monanadmin/MONAN-Model" target="_blank" rel="noopener">MONAN</a> (INPE/CPTEC), corrido por esta página en una malla de 12 km que se afina a 3 km sobre el golfo de Arauco; condiciones iniciales y de borde NOAA GFS 0,25°. Los índices los calcula esta página con el mismo método.' },
  };
  let modelo = 'gfs';
  try { const g = localStorage.getItem('trombasModelo'); if (g === 'ecmwf' || g === 'monan') modelo = g; } catch (e) {}
  // Campos de pronóstico de MONAN dibujados con la forma real de las celdas (data/monan_campos.json, scripts/monan_campos.py)
  const CAMPOS_M = {
    ninguno: { nombre: 'Sin campo' },
    viento: { nombre: 'Viento 10 m', uni: 'kt', dec: 0, esc: [[0, '#1b2f52'], [5, '#1f5a7a'], [10, '#2a9d8f'], [15, '#8ac926'], [20, '#f6d36b'], [25, '#f29a3b'], [30, '#d9482b'], [40, '#a01a5a']] },
    t2: { nombre: 'Temperatura 2 m', uni: '°C', dec: 1, esc: [[-10, '#2f5fbf'], [0, '#5aa9e6'], [5, '#9bd6e8'], [10, '#e8f1d4'], [15, '#f6d36b'], [20, '#f29a3b'], [25, '#d9482b'], [30, '#8f1d2c']] },
    cape: { nombre: 'CAPE', uni: 'J/kg', dec: 0, esc: [[0, '#1b2f52'], [100, '#1f5a7a'], [250, '#2a9d8f'], [500, '#8ac926'], [1000, '#f6d36b'], [1500, '#f29a3b'], [2000, '#d9482b'], [3000, '#8f1d2c']] },
    precip: { nombre: 'Precipitación', uni: 'mm', dec: 1, min: 0.1, esc: [[0.1, '#cfe8f3'], [1, '#7fc8e8'], [5, '#2f8fd1'], [10, '#2a9d8f'], [20, '#8ac926'], [40, '#f6d36b'], [60, '#d9482b']] },
  };
  let campoSel = 'viento', camposM = null, polysM = null, cargandoM = false;
  try { const g = localStorage.getItem('trombasCampoMonan'); if (g && CAMPOS_M[g]) campoSel = g; } catch (e) {}
  if (!map.getPane('camposMonan')) { map.createPane('camposMonan'); map.getPane('camposMonan').style.zIndex = 380; }
  const rendM = L.canvas({ pane: 'camposMonan', padding: 0.3 });
  const capaCampos = L.layerGroup(), capaFlechas = L.layerGroup();
  // Grupo que el usuario enciende o apaga desde "Capas"; el cambio de modelo solo vacía o llena su contenido
  const grupoMonan = L.layerGroup().addTo(map);
  const NOMBRE_IND = { stp: 'STP ≤ −0,1', hslc: 'Alto cizalle y CAPE bajo', nst: 'NST > 1 (sin validar en Chile)' };
  const claseP = v => v == null ? '' : v >= 80 ? 'p4' : v >= 50 ? 'p3' : v >= 20 ? 'p2' : v > 0 ? 'p1' : 'p0';
  const diaLargo = f => new Date(f + 'T12:00:00Z').toLocaleDateString('es-CL', { weekday: 'short', day: 'numeric', timeZone: 'UTC' }).replace('.', '');
  const card = document.createElement('section');
  card.className = 'tr-card'; card.id = 'trombas';
  card.innerHTML = `<nav class="tr-nav" role="tablist" aria-label="Secciones">
      <button type="button" role="tab" data-tab="pron" aria-selected="true">Pronóstico</button>
      <button type="button" role="tab" data-tab="avisos" aria-selected="false">Avisos</button>
      <button type="button" role="tab" data-tab="ficha" aria-selected="false">Ficha técnica</button></nav>
    <p class="tr-exp">Estimación automática y experimental: <b>no constituye aviso</b>. Los avisos oficiales los emite el Servicio Meteorológico de la Armada en <a href="https://meteoarmada.directemar.cl" target="_blank" rel="noopener">meteoarmada.directemar.cl</a>.</p>
    <div class="tr-panel" data-tab="pron">
    <div class="tr-mod" role="radiogroup" aria-label="Modelo"><span>Modelo</span>${Object.entries({ gfs: 'GFS · NOAA', ecmwf: 'ECMWF', monan: 'MONAN 3 km' }).map(([k, t]) => `<button type="button" role="radio" data-m="${k}" aria-checked="${k === modelo}">${t}</button>`).join('')}</div>
    <p class="tr-atr"></p>
    <div class="tr-campos" style="display:none">
      <div class="tr-mod" role="radiogroup" aria-label="Campo de MONAN en el mapa"><span>Mapa</span>${Object.entries(CAMPOS_M).map(([k, c]) => `<button type="button" role="radio" data-c="${k}" aria-checked="${k === campoSel}">${c.nombre}</button>`).join('')}</div>
      <div class="tr-cley"></div>
      <p class="mar-ayuda" style="margin:4px 0 0">Toca cualquier punto del dominio de MONAN para ver todos sus parámetros en el plazo elegido.</p>
    </div>
    <h3 class="tr-h">Probabilidad por zona · <span class="tr-nprob"></span></h3>
    <p class="mar-sub tr-psub" aria-live="polite">Cargando…</p>
    <div class="ev-tabs tr-ptabs" role="tablist">${Object.entries(NOMBRE_IND).map(([k, t]) => `<button type="button" role="tab" data-i="${k}" aria-selected="${k === 'stp'}">${t}</button>`).join('')}</div>
    <div class="tr-ptabla"></div>
    <div class="mar-ley tr-pley"><span><i class="tr-p0"></i>0 %</span><span><i class="tr-p1"></i>1–19</span><span><i class="tr-p2"></i>20–49</span><span><i class="tr-p3"></i>50–79</span><span><i class="tr-p4"></i>80–100 %</span></div>
    <div class="mar-det tr-pdet" aria-live="polite"><p class="mar-ayuda">Porcentaje de los miembros del ensamble en que al menos un punto de la zona supera el umbral durante el día (hora de Chile). Selecciona una casilla para ver el detalle cada 6 h.</p></div>
    <h3 class="tr-h">Detalle por celda · <span class="tr-ndet"></span> (una corrida, sin probabilidad)</h3>
    <p class="mar-sub tr-sub" aria-live="polite">Cargando…</p>
    <div class="tr-tira"></div>
    <div class="mar-ley tr-ley"><span><i style="background:${COLOR.stp}"></i>STP ≤ −0,1</span><span><i style="background:${COLOR.hslc}"></i>Alto cizalle y CAPE bajo</span><span><i style="background:${COLOR.nst}"></i>NST &gt; 1</span><span class="tr-nceldas">número = celdas de 0,25° sobre umbral</span></div>
    <div class="mar-det tr-det" aria-live="polite"><p class="mar-ayuda">Selecciona un plazo para ver en el mapa las celdas que superan algún umbral.</p></div>
    <p class="mar-nota">Índices calculados sobre el océano con el modelo elegido, dominio 20°–56° S / 85°–68° W, con el mismo método para el GFS y para ECMWF. Los umbrales vienen de estudios de tornados chilenos en tierra (Marín et al., 2024 y 2026) y del NST del SPC: aún no están calibrados para trombas. Ningún modelo global resuelve la vorticidad de escala local, por lo que el NST rara vez supera su umbral. ECMWF publica menos niveles bajo 700 hPa que el GFS (1000, 925 y 850 hPa) y su ΔT usa la temperatura de piel del mar. MONAN cubre solo un círculo de 450 km centrado en el golfo de Arauco (zona IV), con celdas de 3 km hasta unos 70 km del centro y de 12 km en el resto; sus columnas se llevan a los mismos niveles de presión que el GFS y su NST usa la vorticidad del primer nivel del modelo, que a 3 km ya resuelve parte de la escala local.</p>
    </div>
    <div class="tr-panel" data-tab="avisos" hidden>
    <h3 class="tr-h">Qué mostraba el modelo en cada aviso de trombas</h3>
    <p class="mar-sub tr-asub" aria-live="polite">Cargando…</p>
    <div class="ev-tabs tr-atabs" role="tablist"></div>
    <div class="tr-adet" aria-live="polite"></div>
    </div>
    <div class="tr-panel" data-tab="ficha" hidden>
    

    <h3 class="tr-h">Dos mecanismos, dos juegos de parámetros</h3>
    <ul class="tr-l">
      <li><b>Frontal o postfrontal (mesociclónica).</b> Nace de convección organizada en ambiente de alto cizalle y CAPE bajo (HSLC). Es el caso típico de los avisos entre Maule y Los Lagos.</li>
      <li><b>De buen tiempo (no mesociclónica).</b> Se forma desde la superficie cuando un cúmulo en crecimiento estira un vórtice preexistente. Requiere cizalle débil, inestabilidad en capas bajas y vorticidad en superficie.</li>
    </ul>

    <h3 class="tr-h">Índices propuestos</h3>
    <div class="ev-tw"><table class="ev-tabla tr-tabla">
      <thead><tr><th>Tipo</th><th>Índice e ingredientes</th><th>Umbral de referencia</th><th>Fuente</th></tr></thead>
      <tbody>
        <tr><th>Frontal / postfrontal</th><td><b>STP</b> (versión hemisferio sur): MLCAPE, MLLCL, MLCIN, SRH 0–500 m con movimiento Bunkers izquierdo, cizalle efectivo</td><td>STP ≤ −0,1 (máximos de los 16 tornados notables entre −0,1 y −0,9)</td><td>Marín et al. (2024)</td></tr>
        <tr><th></th><td><b>Alto cizalle y CAPE bajo (HSLC)</b>: SHERBE (cizalle efectivo, gradientes 0–3 km y 700–500 hPa) con cizalle efectivo y CAPE</td><td>SHERBE ≥ 1, cizalle efectivo &gt; 18 m/s y MUCAPE &lt; 1000 J/kg (MeteoIA exige además MUCAPE &gt; 0)</td><td>Marín et al. (2026)</td></tr>
        <tr><th></th><td><b>VGP</b>: cizalle 0–1 km × √CAPE; y <b>base de nube</b> (LCL)</td><td>Sin umbral publicado; se muestran como referencia</td><td>Caballero-Morán y Rondanelli (2025); Marín et al. (2026)</td></tr>
        <tr class="ev-sep"><th>Convectiva general</th><td><b>SWI</b> (nomograma de Szilagyi): ΔT = TSM − T850; ΔZ = EL − LCL; viento en 850 hPa</td><td>SWI ≥ 0; viento 850 hPa ≤ 40 kt</td><td>Szilagyi (2009)</td></tr>
        <tr class="ev-sep"><th>Buen tiempo</th><td><b>NST</b>: gradiente 0–1 km, MLCAPE 0–3 km, MLCIN, cizalle 0–6 km, vorticidad relativa en superficie (signo invertido en el hemisferio sur)</td><td>NST &gt; 1 (sin validación en Chile) · gradiente 0–1 km &gt; 9 °C/km · MLCAPE 0–3 km &gt; 100 J/kg · MLCIN &gt; −25 J/kg · vorticidad &gt; 8×10⁻⁵ s⁻¹ · cizalle 0–6 km ≤ 25 kt (necesario ≤ 35 kt)</td><td>NWS WDTD (2023)</td></tr>
      </tbody></table></div>

    <details class="mar-crit" open><summary>Ambiente de los tornados chilenos (Marín et al., 2024)</summary><div>
      <p>16 tornados notables entre 1981 y 2021 (San Carlos, Villarrica, Los Ángeles, Concepción, Puerto Montt, Toltén, entre otros), analizados con ERA5. Valores aproximados leídos de las figuras 2 y 3 del artículo: corresponden a los <b>máximos dentro de una caja de 0,5° × 0,5°</b>, no a valores puntuales.</p>
      <ul>
        <li><b>MLCAPE</b> (capa mezclada 100 hPa): aumenta desde T−12 h; algunos casos superan 400 J/kg.</li>
        <li><b>EBSMU</b> (cizalle efectivo de la parcela más inestable): media cercana a 20 m/s (≈ 39 kt) en la hora del reporte.</li>
        <li><b>Gradiente 0–3 km</b>: entre −6 y −7 K/km. <b>Gradiente 700–500 hPa</b>: más intenso que −6 K/km.</li>
        <li><b>SRH 0–500 m</b> (Bunkers izquierdo): media cercana a −200 m²/s², con máximo unas <b>15 h antes</b> del tornado, mientras CAPE, cizalle y STP lo alcanzan cerca de la hora del evento.</li>
        <li><b>STP</b>: máximos entre −0,1 y −0,9. Discrimina lugar y momento mejor que SHERBE, que da señales falsas sobre la cordillera.</li>
        <li>Temporada favorable: mayo a agosto. Zonas con más días de STP ≤ −0,3: entre la Cordillera de la Costa y los Andes cerca de 38° S, e isla de Chiloé, donde hay reportes de trombas.</li>
      </ul>
      <p><b>Limitación.</b> Los 16 casos son tornados sobre tierra y los umbrales se evaluaron con máscara continental. El artículo señala que la estacionalidad de las trombas no calza tan bien con el STP y lo deja como tema pendiente. Para trombas, estos umbrales son una referencia sin calibrar.</p>
    </div></details>

    <details class="mar-crit"><summary>Lo que dicen los estudios chilenos sobre el CAPE</summary><div><ul>
      <li><b>El CAPE por sí solo no discrimina.</b> En 40 tornados chilenos (1980–2023), más de la mitad ocurrió con MUCAPE de 0 a 400 J/kg y casi siempre bajo 500; los autores no encuentran un umbral de CAPE útil (Marín et al., 2026).</li>
      <li><b>Manda el cizalle.</b> En la simulación de los tornados de mayo de 2019, quitar relieve debilitó el chorro de bajo nivel y redujo cizalle y helicidad; calentar el mar 2 K aumentó el CAPE, sobre todo mar afuera, pero no compensó la pérdida de cizalle (Marín et al., 2021).</li>
      <li><b>Valores típicos en Chile:</b> cizalle efectivo 16–18 m/s, helicidad 0–500 m de 50 a 150 m²/s² en magnitud, base de nube media de unos 300 m, y STP = 0 en cerca de la mitad de los casos (Marín et al., 2026).</li>
      <li><b>Rayos:</b> al menos 65 % de las tormentas tornádicas tuvo actividad eléctrica; el número de rayos se correlacionó más con SHERBE (r = 0,59) que con el CAPE (r = 0,31) (Marín et al., 2026).</li>
      <li><b>Temporada:</b> en el centro-sur, de mediados de mayo a mediados de junio, reproducida con el VGP; en la zona austral (47,5°–54° S) hay condiciones favorables en diciembre y enero, sin registros (Caballero-Morán y Rondanelli, 2025).</li>
      <li>No hay estudios chilenos específicos de trombas marinas: todos analizan tornados en tierra.</li>
    </ul></div></details>

    <details class="mar-crit"><summary>Diferencias a nivel del mar</summary><div><ul>
      <li>Nivel de condensación bajo: favorece el término LCL del STP.</li>
      <li>La inestabilidad en capas bajas depende del aire frío postfrontal sobre agua más cálida: ΔT (TSM − T850) es más informativo que el gradiente 0–3 km genérico.</li>
      <li>En el caso de Concepción (31 mayo 2019), la señal de STP negativo apareció primero sobre el océano adyacente, unas 12 h antes, y luego se extendió a la costa.</li>
      <li>Mar adentro se debilita el refuerzo del chorro de bajo nivel por bloqueo andino, que explicó parte del cizalle en 2019.</li>
    </ul></div></details>

    <details class="mar-crit"><summary>Validación del método de Szilagyi</summary><div><ul>
      <li>Desarrollado con 172 eventos en 21 años en los Grandes Lagos; ΔT y ΔZ resultaron los mejores correladores entre 14 parámetros.</li>
      <li>Adriático 2010: el nomograma acertó 14 de 19 casos (73,7 %).</li>
      <li>Adriático, WRF a 500 m: el SWI acertó casi todos los casos; falló uno invernal con nube poco profunda (ΔZ 2,5 km) y cizalle 0–1 km alto (16 m/s). Ese tipo de caso se parece al ambiente HSLC chileno.</li>
    </ul></div></details>

    <details class="mar-crit"><summary>Dónde obtener los datos</summary><div><ul>
      <li><b>GFS 0,25° (NOMADS):</b> CAPE y CIN 180-0 mb (parcela más inestable) y 90-0 mb (capa mezclada), HLCY 0–3000 m (Bunkers; no equivale al SRH 0–500 m con movimiento izquierdo), temperatura, viento y humedad por niveles (975, 950, 925, 900 hPa…), temperatura de superficie.</li>
      <li><b>ECMWF IFS open data (CC-BY-4.0):</b> MUCAPE. Sirve para el patrón sinóptico; tiene pocos niveles en la capa límite para SRH 0–500 m.</li>
      <li><b>WRF 3 km:</b> todos los niveles del modelo; la mejor base para los cuatro índices en la franja costera.</li>
      <li><b>TSM:</b> NASA GIBS MUR (ya en el sitio) o temperatura de superficie del GFS sobre el océano.</li>
      <li><b>Calibración:</b> ERA5 (Copernicus CDS), la misma base del artículo de Marín et al.</li>
      <li><b>Cálculo:</b> MetPy (Python) o thundeR (R, el paquete usado por Marín et al.; calcula el STP para el hemisferio norte por defecto).</li>
      <li><b>Dominio de referencia:</b> 20°–56° S, 85°–68° W (ERA5 en Marín et al.), sin máscara continental para incluir el océano.</li>
    </ul></div></details>

    <details class="mar-crit"><summary>Próximos pasos</summary><div><ul>
      <li>Calcular STP (HS), SHERBE, SWI y NST cada 3 h desde GFS 0,25°, y luego desde WRF.</li>
      <li>Reunir casos chilenos de trombas con hora conocida (avisos SERVIMET, reportes visuales) y verificar los umbrales contra ellos.</li>
      <li>Mostrar en el mapa solo las celdas que superen el umbral, con hora de corrida y de validez.</li>
    </ul></div></details>

    <details class="mar-crit"><summary>Referencias</summary><div><ul class="tr-ref">
      <li>Marín, J. C., Barrett, B. S., Gutiérrez Cotapos, F. y Pozo, D. (2026). Mesoscale environments of tornadoes in Chile and along the U.S. west coast. <i>Atmospheric Research</i>, 344, 109331. <a href="https://doi.org/10.1016/j.atmosres.2026.109331" target="_blank" rel="noopener">doi:10.1016/j.atmosres.2026.109331</a></li>
      <li>Caballero-Morán, V. y Rondanelli, R. (2025). Tornado Seasonality in Central-Southern Chile. <i>Geophysical Research Letters</i>, 52, e2024GL110900. <a href="https://doi.org/10.1029/2024GL110900" target="_blank" rel="noopener">doi:10.1029/2024GL110900</a></li>
      <li>Marín, J. C., Barrett, B. S. y Pozo, D. (2021). The tornadoes of 30–31 May 2019 in south-central Chile: Sensitivity to topography and SST. <i>Atmospheric Research</i>, 249, 105301. <a href="https://doi.org/10.1016/j.atmosres.2020.105301" target="_blank" rel="noopener">doi:10.1016/j.atmosres.2020.105301</a></li>
      <li>Marín, J. C., Gutiérrez, F., Gensini, V. A., Barrett, B. S., Pozo, D., Jacques-Coper, M. y Veloso-Aguila, D. (2024). Climatological Aspects of Notable Tornado Events in Chile. <i>Monthly Weather Review</i>, 152(8), 1803–1819. <a href="https://doi.org/10.1175/MWR-D-23-0249.1" target="_blank" rel="noopener">doi:10.1175/MWR-D-23-0249.1</a></li>
      <li>Vicencio, J. et al. (2021). The Chilean Tornado Outbreak of May 2019: Synoptic, Mesoscale, and Historical Contexts. <i>Bulletin of the American Meteorological Society</i>, 102(3), E611–E634. <a href="https://doi.org/10.1175/BAMS-D-19-0218.1" target="_blank" rel="noopener">doi:10.1175/BAMS-D-19-0218.1</a></li>
      <li>Szilagyi, W. (2009). A waterspout forecasting technique. 5th European Conference on Severe Storms, Landshut. <a href="https://www.essl.org/ECSS/2009/preprints/O05-14-sziladgyi.pdf" target="_blank" rel="noopener">ESSL</a></li>
      <li>Renko, T., Kozarić, T. y Tudor, M. (2011). Testing waterspout forecasting indices over the Adriatic Sea using the ALADIN model. 6th ECSS, Palma de Mallorca. <a href="https://www.essl.org/ECSS/2011/programme/posters/7.pdf" target="_blank" rel="noopener">ESSL</a></li>
      <li>Ivušić, S. et al. (2017). Performance of waterspout forecasting method using high resolution numerical weather model. 9th ECSS, Pula. <a href="https://meetingorganizer.copernicus.org/ECSS2017/ECSS2017-5-2.pdf" target="_blank" rel="noopener">Copernicus</a></li>
      <li>NWS Warning Decision Training Division (2023). RAC one-pager reference: umbrales del Non-Supercell Tornado Parameter. <a href="https://training.weather.gov/wdtd/courses/rac/severe/apd-50dbz-height/story_content/external_files/RAC%20one%20pagers%20reference%20-%20Sep%202023%20update.pdf" target="_blank" rel="noopener">NWS</a></li>
    </ul></div></details>
    </div>`;
  h.contenedor.appendChild(card);
    const tabs = card.querySelectorAll('.tr-nav button');
  function pestana(t) {
    tabs.forEach(b => b.setAttribute('aria-selected', b.dataset.tab === t));
    card.querySelectorAll('.tr-panel').forEach(x => { x.hidden = x.dataset.tab !== t; });
    if (h.alCambiar) h.alCambiar(t);
  }
  tabs.forEach(b => b.onclick = () => pestana(b.dataset.tab));
  const sub = card.querySelector('.tr-sub'), tira = card.querySelector('.tr-tira'), det = card.querySelector('.tr-det');
  // Avisos de trombas (data/trombas_avisos.json, scripts/trombas_avisos.py)
  const asub = card.querySelector('.tr-asub'), atabs = card.querySelector('.tr-atabs'), adet = card.querySelector('.tr-adet');
  const VARS_AV = [
    ['dT', 'ΔT TSM − T850', '°C', 1], ['lr01', 'Gradiente 0–1 km', '°C/km', 1], ['lr03', 'Gradiente 0–3 km', '°C/km', 1],
    ['t500', 'T 500 hPa', '°C', 1], ['t850', 'T 850 hPa', '°C', 1], ['mucape', 'MUCAPE', 'J/kg', 0], ['mlcape3', 'MLCAPE 0–3 km', 'J/kg', 0],
    ['mlcin', 'MLCIN', 'J/kg', 0], ['dZ', 'Profundidad convectiva EL − LCL', 'km', 1], ['mllcl', 'Base de nube (LCL)', 'm', 0],
    ['w850', 'Viento 850 hPa', 'kt', 0], ['ebsmu', 'Cizalle efectivo', 'kt', 0], ['shr01', 'Cizalle 0–1 km', 'kt', 0],
    ['bwd06', 'Cizalle 0–6 km', 'kt', 0], ['srh500', 'Helicidad 0–500 m', 'm²/s²', 0], ['lr75', 'Gradiente 700–500 hPa', '°C/km', 1],
    ['stp', 'STP (HS)', '', 2], ['sherbe', 'SHERBE', '', 2], ['nst', 'NST', '', 2], ['vgp', 'VGP', 'm/s²', 2]];
  let avs = null, avSel = null;
  async function cargarAvisos() {
    try {
      const r = await fetch('data/trombas_avisos.json?t=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      avs = await r.json();
    } catch (e) { avs = null; asub.textContent = 'Aún no hay avisos de trombas procesados. Cada aviso nuevo se calcula automáticamente.'; atabs.innerHTML = ''; adet.innerHTML = ''; return; }
    const todos = Object.values(avs.avisos);
    const lista = Object.entries(avs.avisos).filter(([, a]) => a.emision || a.durante).sort((a, b) => b[1].desde.localeCompare(a[1].desde));
    if (!lista.length) { asub.textContent = 'Aún no hay avisos de trombas procesados. Cada aviso nuevo se calcula automáticamente.'; return; }
    const pend = todos.length - lista.length;
    asub.innerHTML = `${lista.length} aviso${lista.length > 1 ? 's' : ''} procesado${lista.length > 1 ? 's' : ''}${pend > 0 ? ` (${pend} en cálculo; se completan en las próximas actualizaciones)` : ''}. Mediana del área del aviso (mar a 1° o menos de la costa) en las horas de vigencia, con el GFS y con el ECMWF IFS (ambos 0,25°). Se destaca lo que queda fuera del rango normal del día de referencia de cada modelo (percentiles 10–90, 7 días antes).`;
    atabs.innerHTML = lista.map(([k, a]) => `<button type="button" role="tab" data-k="${escH(k)}">${escH(new Date(a.desde).toLocaleDateString('es-CL', { timeZone: 'America/Santiago', day: 'numeric', month: 'short', year: '2-digit' }).replace(/\./g, ''))}${a.observadas && a.observadas.length ? ' ●' : ''}</button>`).join('') +
      (lista.length > 1 ? '<button type="button" role="tab" data-k="__todos">Todos</button>' : '');
    atabs.querySelectorAll('button').forEach(b => b.onclick = () => pintarAviso(b.dataset.k));
    pintarAviso(avSel && (avSel === '__todos' || avs.avisos[avSel]) ? avSel : lista[0][0]);
  }
  function pintarAviso(k) {
    avSel = k;
    atabs.querySelectorAll('button').forEach(b => b.setAttribute('aria-selected', b.dataset.k === k));
    const fmt = (v, d) => v == null ? '–' : nf(Math.abs(v) < 0.5 * 10 ** -d ? 0 : v, d);
    const ok = e => e && e.estad ? e : null;                      // etapa calculada (no "sin_datos")
    const ec = a => a.ecmwf || {};
    const cab2 = '<th class="tr-m">GFS</th><th class="tr-m">ECMWF</th>';
    if (k === '__todos') {
      const lista = Object.values(avs.avisos).filter(a => a.emision || a.durante);
      const med = (arr) => { const x = arr.filter(v => v != null).sort((a, b) => a - b); return x.length ? x[Math.floor((x.length - 1) / 2)] : null; };
      const con = lista.filter(a => a.observadas && a.observadas.length), sin = lista.filter(a => !(a.observadas && a.observadas.length));
      const valG = a => ok(a.durante) || ok(a.emision), valE = a => ok(ec(a).durante) || ok(ec(a).emision);
      const nE = arr => arr.filter(valE).length;
      const celda = (arr, f, v, d) => fmt(med(arr.map(f).filter(Boolean).map(e => e.estad[v]?.[1])), d);
      adet.innerHTML = `<p class="mar-ayuda">Mediana, entre los avisos de cada grupo, de la mediana del área de cada aviso (durante la vigencia; si aún no termina, al emitir), con cada modelo. "Con tromba" = avisos con al menos una tromba registrada en prensa o confirmada por la Armada; "sin registro" no significa que no hubo trombas. ECMWF existe para los avisos cuyas corridas siguen en su archivo abierto (hoy, desde julio de 2026) y para todos los nuevos.</p>
        <div class="ev-tw"><table class="ev-tabla tr-at tr-at2"><thead><tr><th rowspan="2">Parámetro</th><th colspan="2">Con tromba <small>(${con.length} · ${nE(con)} avisos)</small></th><th colspan="2">Sin registro <small>(${sin.length} · ${nE(sin)} avisos)</small></th><th colspan="2">Referencias</th></tr><tr>${cab2}${cab2}${cab2}</tr></thead><tbody>` +
        VARS_AV.map(([v, t, u, d]) => `<tr><th>${t}${u ? ` <small>${u}</small>` : ''}</th><td>${celda(con, valG, v, d)}</td><td>${celda(con, valE, v, d)}</td><td>${celda(sin, valG, v, d)}</td><td>${celda(sin, valE, v, d)}</td><td>${celda(lista, a => ok(a.referencia), v, d)}</td><td>${celda(lista, a => ok(ec(a).referencia), v, d)}</td></tr>`).join('') +
        '</tbody></table></div>';
      return;
    }
    const a = avs.avisos[k], E = ec(a);
    const G = { em: ok(a.emision), du: ok(a.durante), rf: ok(a.referencia) }, X = { em: ok(E.emision), du: ok(E.durante), rf: ok(E.referencia) };
    const e = G.em || G.du;
    // Cada valor se compara con el rango normal (p10–p90) del día de referencia del mismo modelo
    const clase = (st, rf, v) => { const x = st?.estad[v], y = rf?.estad[v]; return x && y ? (x[1] > y[2] ? 'tr-alto' : x[1] < y[0] ? 'tr-bajo' : '') : ''; };
    const td = (st, rf, v, d) => `<td class="${clase(st, rf, v)}"${st?.estad[v] ? ` title="p10 ${fmt(st.estad[v][0], d)} · p90 ${fmt(st.estad[v][2], d)}"` : ''}>${st?.estad[v] ? fmt(st.estad[v][1], d) : '–'}</td>`;
    const ETAPA = { em: 'emision', du: 'durante', rf: 'referencia' };
    const estadoEC = n => E[ETAPA[n]]?.sin_datos ? 'sin datos' : X[n] ? '' : 'pendiente';
    const notaEC = (G.em ? ['em', 'du', 'rf'] : ['du', 'rf']).map(n => [n, estadoEC(n)]).filter(([, t]) => t);
    const links = (a.urls || (a.url ? [a.url] : [])).map((u, i) => `<a href="${escH(u)}" target="_blank" rel="noopener">${a.fuente === 'oficial' && i === 0 ? 'aviso' : 'fuente ' + (i + 1)}</a>`).join(' · ');
    const NOMBRE_ET = { em: 'al emitir', du: 'durante', rf: 'referencia' };
    adet.innerHTML = `<div class="tr-acab"><b>${escH(a.codigo || 'Aviso sin código')}</b> <span class="tr-fte">${a.fuente === 'oficial' ? 'Oficial' : 'Prensa (cita al CMM)'}</span> · ${escH(a.sector || '')} · ${escH(horaChile(a.desde))} a ${escH(horaChile(a.hasta))} (hora Chile)${links ? ' · ' + links : ''}</div>
      ${a.situacion ? `<p class="mar-ayuda">Situación sinóptica: ${escH(a.situacion)}</p>` : ''}${a.nota_aviso ? `<p class="mar-ayuda">${escH(a.nota_aviso)}</p>` : ''}
      ${(a.observadas || []).map(o => `<p class="tr-obs">● Tromba observada: ${escH(o.lugar)}, ${escH(o.fecha.replace('T', ' ') + (o.fecha.length > 10 ? ' h' : ''))} · ${escH(o.confirmada || '')}${o.url ? ` · <a href="${escH(o.url)}" target="_blank" rel="noopener">nota</a>` : ''}</p>`).join('')}
      <p class="mar-ayuda">${G.em ? `Al emitir: GFS ${escH(G.em.corrida.replace('T', ' ').replace('Z', ' UTC'))}${X.em ? ` y ECMWF ${escH(X.em.corrida.replace('T', ' ').replace('Z', ' UTC'))}` : ''}, ` : 'Hora de emisión desconocida: se usan los análisis de la vigencia. '}${e ? `${e.puntos} puntos, ${e.horas} horas.` : ''}${G.du ? '' : ' "Durante" se calcula al terminar la vigencia.'}${notaEC.length ? ` ECMWF ${notaEC.map(([n, t]) => `${NOMBRE_ET[n]}: ${t}`).join(', ')}${notaEC.some(([, t]) => t === 'sin datos') ? ' (la corrida ya no está en el archivo abierto de ECMWF)' : ''}.` : ''}${a.error ? ` <span class="mar-viejo">${escH(a.error)}</span>` : ''}${E.error ? ` <span class="mar-viejo">ECMWF: ${escH(E.error)}</span>` : ''}</p>
      <div class="ev-tw"><table class="ev-tabla tr-at tr-at2"><thead><tr><th rowspan="2">Parámetro <small>mediana del área</small></th><th colspan="2">Al emitir</th><th colspan="2">Durante</th><th colspan="2">Referencia −7 d</th></tr><tr>${cab2}${cab2}${cab2}</tr></thead><tbody>` +
      VARS_AV.map(([v, t, u, d]) => `<tr><th>${t}${u ? ` <small>${u}</small>` : ''}</th>${td(G.em, G.rf, v, d)}${td(X.em, X.rf, v, d)}${td(G.du, G.rf, v, d)}${td(X.du, X.rf, v, d)}${td(G.rf, null, v, d)}${td(X.rf, null, v, d)}</tr>`).join('') +
      `</tbody></table></div>
      ${e ? `<p class="mar-ayuda">Celdas sobre umbral con el GFS ${G.em ? 'al emitir' : 'durante'} (puntos × horas, de ${e.conteos.total}): STP ≤ −0,1: ${e.conteos.stp} · alto cizalle y CAPE bajo: ${e.conteos.hslc} · NST &gt; 1: ${e.conteos.nst} · ΔT ≥ 12 °C: ${e.conteos.dT12} · gradiente 0–1 km ≥ 9 °C/km: ${e.conteos.lr01_9}.` : '<p class="mar-ayuda">'}${(X.em || X.du) ? ` Con ECMWF ${X.em ? 'al emitir' : 'durante'} (de ${(X.em || X.du).conteos.total}): STP ${(X.em || X.du).conteos.stp} · alto cizalle ${(X.em || X.du).conteos.hslc} · NST ${(X.em || X.du).conteos.nst} · ΔT ≥ 12 °C ${(X.em || X.du).conteos.dT12} · gradiente 0–1 km ≥ 9 °C/km ${(X.em || X.du).conteos.lr01_9}.` : ''}
      <span class="tr-alto">Fondo naranjo</span>: sobre el rango normal del día de referencia del mismo modelo; <span class="tr-bajo">fondo azul</span>: bajo ese rango. Toca un valor para ver sus percentiles 10 y 90.</p>`;
  }
  const psub = card.querySelector('.tr-psub'), ptabla = card.querySelector('.tr-ptabla'), pdet = card.querySelector('.tr-pdet');
  card.querySelectorAll('.tr-ptabs button').forEach(b => b.onclick = () => {
    indProb = b.dataset.i;
    card.querySelectorAll('.tr-ptabs button').forEach(x => x.setAttribute('aria-selected', x === b));
    if (prob) pintarProb();
  });

  async function cargarProb() {
    if (!MODELOS[modelo].prob) {
      prob = null; ptabla.innerHTML = ''; grupoZona.clearLayers();
      psub.textContent = MODELOS[modelo].sinProb;
      return;
    }
    try {
      const m = modelo, r = await fetch(MODELOS[m].prob + '?t=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json(); if (m !== modelo) return; prob = j;
    } catch (e) {
      prob = null; ptabla.innerHTML = ''; grupoZona.clearLayers();
      psub.textContent = 'Aún no hay una corrida del ensamble procesada. ' + MODELOS[modelo].sinProb;
      return;
    }
    if (!prob.prob) { psub.innerHTML = 'La última corrida del ensamble no se pudo procesar; se reintenta en la próxima ejecución.'; ptabla.innerHTML = ''; return; }
    pintarProb();
  }

  function pintarProb() {
    const d = prob, hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
    const dias = d.dias.filter(f => f >= hoy);
    psub.innerHTML = `Corrida ${escH(d.corrida.replace('T', ' ').replace('Z', ' UTC'))} · ${escH(d.fuente)} · procesada ${escH(horaChile(d.generado))} (hora Chile)`;
    ptabla.innerHTML = `<div class="ev-tw"><table class="ev-tabla tr-pt"><thead><tr><th>Zona</th>${dias.map(f => `<th>${escH(diaLargo(f))}</th>`).join('')}</tr></thead><tbody>` +
      d.areas.map(a => `<tr><th title="${escH(a.nombre)}">${escH(a.nombre.replace(/^Zona (\S+) · /, '$1 · '))}</th>` +
        dias.map(f => { const v = d.prob_dia[a.id][indProb][f]; return `<td><button type="button" class="tr-pc tr-${claseP(v)}${celdaProb && celdaProb[0] === a.id && celdaProb[1] === f ? ' sel' : ''}" data-a="${a.id}" data-f="${f}">${v == null ? '–' : v + ' %'}</button></td>`; }).join('') + '</tr>').join('') +
      '</tbody></table></div>';
    ptabla.querySelectorAll('.tr-pc').forEach(b => b.onclick = () => elegirProb(b.dataset.a, b.dataset.f));
    if (celdaProb) elegirProb(...celdaProb, true);
  }

  function elegirProb(id, f, silencioso) {
    celdaProb = [id, f];
    ptabla.querySelectorAll('.tr-pc').forEach(b => b.classList.toggle('sel', b.dataset.a === id && b.dataset.f === f));
    const d = prob, a = d.areas.find(x => x.id === id); if (!a) return;
    const filas = d.validas.map((v, k) => [v, d.prob[id][indProb][k]]).filter(([v]) => new Date(v).toLocaleDateString('en-CA', { timeZone: 'America/Santiago' }) === f);
    pdet.innerHTML = `<h3>${escH(a.nombre)} · ${escH(diaLargo(f))}</h3>
      <p class="mar-ayuda">${escH(NOMBRE_IND[indProb])}: porcentaje de ${d.miembros} miembros, cada 6 h (hora de Chile).</p>
      <div class="tr-6h">${filas.map(([v, x]) => `<span class="tr-${claseP(x)}"><b>${escH(hhChile(v))} h</b>${x} %</span>`).join('')}</div>`;
    grupoZona.clearLayers();
    for (const [la, lo] of a.puntos) L.circleMarker([la, lo], { radius: 4, color: '#18212b', weight: 1, fillColor: '#ffffff', fillOpacity: 0.7 }).addTo(grupoZona);
    if (!map.hasLayer(grupoZona)) grupoZona.addTo(map);
    if (!silencioso) map.fitBounds(L.latLngBounds(a.puntos).pad(0.2), { maxZoom: 7 });
  }

  async function cargar() {
    try {
      const m = modelo, r = await fetch(MODELOS[m].det + '?t=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json(); if (m !== modelo) return; datos = j; cargado = Date.now();
    } catch (e) {
      datos = null; tira.innerHTML = '';
      grupo.clearLayers(); det.innerHTML = '';
      sub.textContent = 'Aún no hay una corrida procesada. ' + MODELOS[modelo].sinDet;
      return;
    }
    pintar();
  }

  function pintar() {
    const d = datos, ahora = Date.now() - 3 * 3600e3;
    const pasos = d.pasos.filter(p => new Date(p.valida) >= ahora);
    const viejo = Date.now() - new Date(d.generado) > 15 * 3600e3;
    sub.innerHTML = `Corrida ${escH(d.corrida.replace('T', ' ').replace('Z', ' UTC'))} · ${escH(d.fuente)} · procesada ${escH(horaChile(d.generado))} (hora Chile)${viejo ? ' · <b class="mar-viejo">corrida antigua</b>' : ''}`;
    if (d.completo === false) sub.innerHTML += ' · <b class="mar-viejo">no se pudo procesar; se reintenta en la próxima ejecución</b>';
    let html = '', dia = '';
    for (const p of pasos) {
      const dd = diaChile(p.valida);
      if (dd !== dia) { html += `${dia ? '</div>' : ''}<div class="tr-dia"><span class="tr-dia-t">${escH(dd)}</span>`; dia = dd; }
      const n = p.celdas.length, k = p.n.stp ? 'stp' : p.n.hslc ? 'hslc' : p.n.nst ? 'nst' : '';
      html += `<button type="button" class="tr-p${k ? ' tr-' + k : ''}${sel === p.fhr ? ' sel' : ''}" data-f="${p.fhr}" title="Válido ${escH(horaChile(p.valida))} · +${p.fhr} h"><b>${escH(hhChile(p.valida))}</b><small>${n || '·'}</small></button>`;
    }
    tira.innerHTML = (html ? html + '</div>' : '<p class="mar-nota">Sin plazos vigentes en la corrida disponible.</p>');
    tira.querySelectorAll('.tr-p').forEach(b => b.onclick = () => elegir(+b.dataset.f));
    if (sel == null) { const p = pasos.find(x => x.celdas.length) || pasos[0]; if (p) elegir(p.fhr); }
    else elegir(sel);
  }

  function elegir(fhr) {
    const p = datos.pasos.find(x => x.fhr === fhr); if (!p) return;
    sel = fhr;
    tira.querySelectorAll('.tr-p').forEach(b => b.classList.toggle('sel', +b.dataset.f === fhr));
    grupo.clearLayers();
    const col = datos.columnas, i = Object.fromEntries(col.map((c, k) => [c, k]));
    if (datos.circulo) {   // MONAN: contorno del dominio regional y de la zona de 3 km
      const ci = datos.circulo;
      L.circle([ci.lat, ci.lon], { radius: ci.radio_km * 1000, color: '#9fd3ff', weight: 1.2, dashArray: '6 6', fill: false, interactive: false }).addTo(grupo);
      L.circle([ci.lat, ci.lon], { radius: ci.fino_km * 1000, color: '#9fd3ff', weight: 1, dashArray: '2 4', fill: false, interactive: false }).addTo(grupo);
    }
    for (const c of p.celdas) {
      const k = c[i.stp] <= datos.umbrales.stp ? 'stp' : c[i.hslc] ? 'hslc' : 'nst';
      const m = (i.paso != null && c[i.paso] != null ? c[i.paso] : datos.paso_grilla) / 2;
      L.rectangle([[c[0] - m, c[1] - m], [c[0] + m, c[1] + m]], { color: COLOR[k], weight: 0.5, fillOpacity: 0.45 })
        .bindPopup(`<div class="pp"><div class="ppT">${dm(c[0], 'N', 'S')} · ${dm(c[1], 'E', 'W')}</div><table>` +
          `<tr><th>Válido</th><td>${escH(horaChile(p.valida))}</td></tr>` +
          `<tr><th>STP (HS)</th><td>${nf(c[i.stp], 2)}</td></tr><tr><th>SHERBE</th><td>${nf(c[i.sherbe], 2)}</td></tr><tr><th>Alto cizalle, CAPE bajo</th><td>${c[i.hslc] ? 'sí' : 'no'}</td></tr><tr><th>NST</th><td>${nf(c[i.nst], 2)}</td></tr><tr><th>VGP</th><td>${nf(c[i.vgp], 2)} m/s²</td></tr><tr><th>Base de nube (LCL)</th><td>${nf(c[i.mllcl], 0)} m</td></tr><tr><th>MUCAPE</th><td>${nf(c[i.mucape], 0)} J/kg</td></tr>` +
          `<tr><th>MLCAPE</th><td>${nf(c[i.mlcape], 0)} J/kg</td></tr><tr><th>SRH 0–500 m</th><td>${nf(c[i.srh500], 0)} m²/s²</td></tr><tr><th>Cizalle efectivo</th><td>${nf(c[i.ebsmu_kt], 0)} kt</td></tr>` +
          `<tr><th>ΔT (TSM − T850)</th><td>${nf(c[i.dT])} °C</td></tr><tr><th>ΔZ (EL − LCL)</th><td>${nf(c[i.dZ_km])} km</td></tr><tr><th>Viento 850 hPa</th><td>${nf(c[i.w850_kt], 0)} kt</td></tr></table></div>`)
        .addTo(grupo);
    }
    if (!map.hasLayer(grupo)) grupo.addTo(map);
    pintarCampo();
    const e = p.extremos;
    det.innerHTML = `<h3>${escH(horaChile(p.valida))} <small>(+${p.fhr} h)</small></h3>
      <dl><dt>STP mínimo</dt><dd>${nf(e.stp, 2)} · ${p.n.stp} celdas ≤ −0,1</dd>
      <dt>Alto cizalle, CAPE bajo</dt><dd>${p.n.hslc} celdas (SHERBE máximo ${nf(e.sherbe, 2)})</dd>
      <dt>NST máximo</dt><dd>${nf(e.nst, 2)} · ${p.n.nst} celdas &gt; 1 (sin validar en Chile)</dd>
      <dt>VGP máximo</dt><dd>${nf(e.vgp, 2)} m/s² (referencia, sin umbral chileno)</dd>
      <dt>ΔT máximo</dt><dd>${nf(e.dT)} °C (TSM − T850)</dd></dl>
      <p class="mar-ayuda">${p.celdas.length ? 'Toca una celda en el mapa para ver sus valores.' : 'Ninguna celda supera los umbrales en este plazo.'} Evaluados ${p.n.puntos} puntos de océano.</p>`;
  }

  // ---- Campos de MONAN en el mapa
  const hex = c => [1, 3, 5].map(k => parseInt(c.slice(k, k + 2), 16));
  function colorM(c, v) {
    const e = c.esc;
    if (v <= e[0][0]) return e[0][1];
    for (let k = 1; k < e.length; k++) if (v <= e[k][0]) {
      const f = (v - e[k - 1][0]) / (e[k][0] - e[k - 1][0]), a = hex(e[k - 1][1]), b = hex(e[k][1]);
      return `rgb(${a.map((x, j) => Math.round(x + (b[j] - x) * f)).join(',')})`;
    }
    return e[e.length - 1][1];
  }
  const cajaCampos = card.querySelector('.tr-campos'), cley = card.querySelector('.tr-cley');
  function valorM(k, t, i) {
    const C = camposM.campos;
    if (k === 'viento') { const u = C.u10.datos[t][i], v = C.v10.datos[t][i]; return u == null || v == null ? null : Math.hypot(u, v); }
    const m = { t2: 't2', cape: 'cape', precip: 'precip' }[k], a = C[m].datos[t][i];
    return a == null ? null : a / C[m].esc;
  }
  function leyendaM() {
    const c = CAMPOS_M[campoSel];
    if (!c.esc) { cley.innerHTML = ''; return; }
    cley.innerHTML = `<div class="mar-ley" style="flex-wrap:wrap;gap:2px 0"><span style="width:100%">${escH(c.nombre)} (${escH(c.uni)}) · MONAN, celdas de 3 a 12 km${camposM && camposM._sinDato ? ' · <b>sin dato en este plazo</b>' : ''}</span>` +
      c.esc.map(([v, col]) => `<span><i style="background:${col}"></i>${String(v).replace('.', ',')}</span>`).join('') + '</div>';
  }
  async function cargarCampos() {
    const url = MODELOS[modelo].campos;
    cajaCampos.style.display = url ? '' : 'none';
    if (!url) { grupoMonan.removeLayer(capaCampos); grupoMonan.removeLayer(capaFlechas); map.closePopup(); return; }
    if (!camposM && !cargandoM) {
      cargandoM = true;
      try {
        const r = await fetch(url + '?t=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(60000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        camposM = await r.json();
      } catch (e) { camposM = null; cley.innerHTML = '<p class="mar-nota">Aún no hay campos de MONAN publicados.</p>'; cargandoM = false; return; }
      cargandoM = false;
      polysM = camposM.celdas.map((vs, i) => L.polygon(vs.map(k => [camposM.vlat[k], camposM.vlon[k]]),
        { renderer: rendM, pane: 'camposMonan', stroke: false, fillOpacity: 0, interactive: true })
        .on('click', ev => fichaPunto(i, ev.latlng)).addTo(capaCampos));
      // centros de celda para las flechas de viento
      camposM._centros = camposM.celdas.map(vs => [vs.reduce((s, k) => s + camposM.vlat[k], 0) / vs.length, vs.reduce((s, k) => s + camposM.vlon[k], 0) / vs.length]);
    }
    if (camposM) pintarCampo();
  }
  // ---- Ficha de un punto: todos los parámetros de MONAN en la celda tocada
  let indicesM = null, cargandoI = null;
  async function cargarIndices() {
    if (indicesM || !MODELOS[modelo].puntos) return indicesM;
    if (!cargandoI) cargandoI = fetch(MODELOS[modelo].puntos + '?t=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(60000) })
      .then(r => r.ok ? r.json() : null).then(j => {
        if (j) { j._pos = new Map(j.celdas.map((c, k) => [c, k])); j._col = Object.fromEntries(j.columnas.map((c, k) => [c, k])); }
        indicesM = j; return j;
      }).catch(() => null);
    return cargandoI;
  }
  async function fichaPunto(i, latlng) {
    const t = plazoM(), P = camposM.plazos[t], C = camposM.campos, [la, lo] = camposM._centros[i];
    const fila = (n, v) => `<tr><th>${n}</th><td>${v}</td></tr>`;
    const u = C.u10.datos[t][i], v = C.v10.datos[t][i];
    let viento = 's/d';
    if (u != null && v != null) { const kt = Math.hypot(u, v), dir = (270 - Math.atan2(v, u) * 180 / Math.PI + 360) % 360; viento = `${String(Math.round(dir / 10) * 10 % 360).padStart(3, '0')}° / ${nf(kt, 0)} kt`; }
    const val = (k, e, d, uni) => { const a = C[k].datos[t][i]; return a == null ? 's/d' : nf(a / e, d) + ' ' + uni; };
    const cab = `<div class="pp"><div class="ppT">${dm(la, 'N', 'S')} · ${dm(lo, 'E', 'W')}</div><table>` +
      fila('Válido', escH(horaChile(P.valida)) + ` (+${P.fhr} h)`) +
      fila('Superficie', (camposM.tierra[i] ? 'tierra' : 'mar') + (camposM.borde[i] ? ' · zona de borde (no representativa)' : '')) +
      fila('Viento 10 m', viento) + fila('Temperatura 2 m', val('t2', 10, 1, '°C')) +
      fila('CAPE', val('cape', 1, 0, 'J/kg')) + fila('Precipitación acumulada', val('precip', 10, 1, 'mm'));
    // Viento pronosticado en el punto, todos los plazos
    const flecha = (uu, vv) => { const a = Math.atan2(-vv, uu) * 180 / Math.PI + 90; return `<span style="display:inline-block;transform:rotate(${a.toFixed(0)}deg)">↑</span>`; };
    let serie = '<div style="margin-top:6px"><b>Viento 10 m pronosticado</b></div><div style="max-height:170px;overflow:auto;margin-top:2px"><table class="tr-vserie" style="width:100%;font-size:12px;border-collapse:collapse">';
    camposM.plazos.forEach((pp, k) => {
      const uu = C.u10.datos[k][i], vv = C.v10.datos[k][i];
      let txt = 's/d', fl = '';
      if (uu != null && vv != null) {
        const kt = Math.hypot(uu, vv), dir = (270 - Math.atan2(vv, uu) * 180 / Math.PI + 360) % 360;
        txt = `${String(Math.round(dir / 10) * 10 % 360).padStart(3, '0')}° / <b>${nf(kt, 0)} kt</b>`; fl = flecha(uu, vv);
      }
      const act = k === t ? ' style="background:rgba(63,179,217,.18)"' : '';
      serie += `<tr${act}><td style="padding:1px 4px">${escH(horaChile(pp.valida))}</td><td style="padding:1px 4px;text-align:right">${txt}</td><td style="padding:1px 4px;width:14px">${fl}</td></tr>`;
    });
    serie += '</table></div>';
    const cab2 = () => cab;   // se arma una vez
    const pop = L.popup({ maxWidth: 340 }).setLatLng(latlng).setContent(cab + '</table>' + serie + '<table>' + fila('Índices de trombas', 'cargando…') + '</table></div>').openOn(map);
    const I = await cargarIndices();
    let ind = '';
    if (camposM.tierra[i]) ind = fila('Índices de trombas', 'solo se calculan sobre el mar');
    else if (!I || !I._pos.has(i)) ind = fila('Índices de trombas', camposM.borde[i] ? 'no se calculan en la zona de borde' : 'no disponibles');
    else {
      const pl = I.plazos.find(x => x.fhr === P.fhr), k = I._pos.get(i);
      const g = c => { const a = pl && pl.datos[I._col[c]][k]; return a == null ? null : a / I.escala[I._col[c]]; };
      const mark = (txt, alto) => alto ? `<b style="color:#f28c00">${txt}</b>` : txt;
      const stp = g('stp'), sh = g('sherbe'), ns = g('nst'), hs = g('hslc');
      ind = fila('STP (HS)', mark(nf(stp, 2), stp != null && stp <= -0.1)) + fila('SHERBE', nf(sh, 2)) +
        fila('Alto cizalle, CAPE bajo', mark(hs ? 'sí' : 'no', !!hs)) + fila('NST', mark(nf(ns, 2), ns != null && ns > 1)) +
        fila('VGP', nf(g('vgp'), 2) + ' m/s²') + fila('Base de nube (LCL)', nf(g('mllcl'), 0) + ' m') +
        fila('MUCAPE', nf(g('mucape'), 0) + ' J/kg') + fila('MLCAPE', nf(g('mlcape'), 0) + ' J/kg') +
        fila('SRH 0–500 m', nf(g('srh500'), 0) + ' m²/s²') + fila('Cizalle efectivo', nf(g('ebsmu_kt'), 0) + ' kt') +
        fila('ΔT (TSM − T850)', nf(g('dT'), 1) + ' °C') + fila('ΔZ (EL − LCL)', nf(g('dZ_km'), 1) + ' km') +
        fila('Viento 850 hPa', nf(g('w850_kt'), 0) + ' kt');
    }
    if (map.hasLayer(pop)) pop.setContent(cab2() + '</table>' + serie + '<div style="margin-top:6px"><b>Índices de trombas</b> (' + escH(horaChile(P.valida)) + ')</div><table>' + ind + '</table><p class="mar-ayuda" style="margin:6px 0 0">En naranjo, lo que supera el umbral. Las flechas indican hacia dónde sopla. MONAN, celda de la malla de 3 a 12 km.</p></div>');
  }
  function plazoM() {
    if (!camposM) return 0;
    const f = sel == null ? camposM.plazos[0].fhr : sel;
    let k = 0; camposM.plazos.forEach((p, j) => { if (p.fhr <= f) k = j; });
    return k;
  }
  function pintarCampo() {
    if (!camposM || modelo !== 'monan') return;
    const c = CAMPOS_M[campoSel], t = plazoM();
    capaFlechas.clearLayers();
    if (!grupoMonan.hasLayer(capaCampos)) grupoMonan.addLayer(capaCampos);   // celdas siempre tocables (ficha)
    if (!c.esc) { polysM.forEach(p => p.setStyle({ fillOpacity: 0 })); grupoMonan.removeLayer(capaFlechas); camposM._sinDato = false; leyendaM(); return; }
    let n = 0;
    polysM.forEach((p, i) => {
      const v = valorM(campoSel, t, i);
      if (v == null || (c.min != null && v < c.min)) { p.setStyle({ fillOpacity: 0 }); return; }
      n++; p.setStyle({ fillColor: colorM(c, v), fillOpacity: camposM.borde[i] ? 0.25 : 0.6 });
    });
    camposM._sinDato = n === 0 && campoSel !== 'precip';

    if (campoSel === 'viento') {
      // densidad según el zoom: unas 30 flechas a lo ancho del mapa
      const b = map.getBounds(), paso = Math.max((b.getEast() - b.getWest()) / 22, 0.03), vistas = new Map();
      camposM._centros.forEach(([la, lo], i) => {
        if (camposM.borde[i] || !b.pad(0.1).contains([la, lo])) return;
        const key = Math.floor(la / paso) + ',' + Math.floor(lo / paso);
        if (!vistas.has(key)) vistas.set(key, [i, la, lo]);
      });
      for (const [i, la, lo] of vistas.values()) {
        const u = camposM.campos.u10.datos[t][i], v = camposM.campos.v10.datos[t][i];
        if (u == null || v == null) continue;
        const kt = Math.hypot(u, v); if (kt < 1) continue;
        const L_ = paso * (0.35 + Math.min(kt, 40) * 0.012), dx = u / kt * L_ / Math.cos(la * Math.PI / 180), dy = v / kt * L_;
        const a = [la - dy / 2, lo - dx / 2], b = [la + dy / 2, lo + dx / 2], ang = Math.atan2(dy, dx * Math.cos(la * Math.PI / 180));
        const p1 = [b[0] - 0.35 * L_ * Math.sin(ang - 0.5), b[1] - 0.35 * L_ * Math.cos(ang - 0.5) / Math.cos(la * Math.PI / 180)];
        const p2 = [b[0] - 0.35 * L_ * Math.sin(ang + 0.5), b[1] - 0.35 * L_ * Math.cos(ang + 0.5) / Math.cos(la * Math.PI / 180)];
        L.polyline([a, b], { renderer: rendM, pane: 'camposMonan', color: '#fff', weight: 1.2, opacity: 0.85, interactive: false }).addTo(capaFlechas);
        L.polyline([p1, b, p2], { renderer: rendM, pane: 'camposMonan', color: '#fff', weight: 1.2, opacity: 0.85, interactive: false }).addTo(capaFlechas);
      }
      if (!grupoMonan.hasLayer(capaFlechas)) grupoMonan.addLayer(capaFlechas);
    } else grupoMonan.removeLayer(capaFlechas);
    leyendaM();
  }
  map.on('moveend', () => { if (campoSel === 'viento' && camposM && modelo === 'monan') pintarCampo(); });
  cajaCampos.querySelectorAll('button').forEach(b => b.onclick = () => {
    campoSel = b.dataset.c;
    try { localStorage.setItem('trombasCampoMonan', campoSel); } catch (e) {}
    cajaCampos.querySelectorAll('button').forEach(x => x.setAttribute('aria-checked', x === b));
    pintarCampo();
  });

  // Selector de modelo
  function rotularModelo() {
    const M = MODELOS[modelo];
    card.querySelector('.tr-nprob').textContent = M.nProb;
    card.querySelector('.tr-ndet').textContent = M.nDet;
    card.querySelector('.tr-atr').innerHTML = M.atr;
    for (const c of ['.tr-ptabs', '.tr-pley', '.tr-pdet']) card.querySelector(c).style.display = M.prob ? '' : 'none';   // sin ensamble: sin tabla de probabilidad
    card.querySelector('.tr-nceldas').textContent = modelo === 'monan' ? 'número = celdas de MONAN (3 a 12 km) sobre umbral' : 'número = celdas de 0,25° sobre umbral';
    card.querySelectorAll('.tr-mod button').forEach(b => b.setAttribute('aria-checked', b.dataset.m === modelo));
  }
  card.querySelectorAll('.tr-mod button').forEach(b => b.onclick = () => {
    if (b.dataset.m === modelo) return;
    modelo = b.dataset.m;
    try { localStorage.setItem('trombasModelo', modelo); } catch (e) {}
    rotularModelo();
    datos = null; prob = null; sel = null;
    sub.textContent = 'Cargando…'; psub.textContent = 'Cargando…'; tira.innerHTML = ''; ptabla.innerHTML = '';
    cargar(); cargarProb(); cargarCampos();
  });
  rotularModelo();

  function actualizar() {
    capaCampos.clearLayers(); capaFlechas.clearLayers(); camposM = null; polysM = null; indicesM = null; cargandoI = null;   // relee la corrida nueva
    cargar(); cargarProb(); cargarAvisos(); cargarCampos();
  }
  return { actualizar, pestana, capas: { celdas: grupo, zona: grupoZona, monan: grupoMonan }, get cargado() { return cargado; } };
}
