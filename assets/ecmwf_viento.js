// Viento ECMWF IFS 9 km tomado de MeteoIA: copia de meteo_naval/build/ecmwf.js (y de ww3Rumbo y ww3Fecha de build/ww3.js).
// Lee los datos que MeteoIA ya publica (https://meteoia.cl/data/ecmwf/), así el modelo se descarga una sola vez.
// Si cambia el original en MeteoIA, copiarlo de nuevo y cambiar las rutas 'data/ecmwf/' por ECMWF_BASE.
const ECMWF_BASE = 'https://meteoia.cl/data/ecmwf/';
function ww3Rumbo(g) { return ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'][Math.round(((g % 360) + 360) % 360 / 22.5) % 16]; }
function ww3Fecha(iso) {
  const d = new Date(iso);
  return d.toLocaleString('es-CL', { timeZone: 'America/Santiago', weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).replace(/\./g, '');
}
// Capa de viento ECMWF IFS a 0,1° (≈ 9 km) en la franja costera. Datos en data/ecmwf/: indice.json y un
// binario por plazo (un byte por valor: rapidez en nudos, dirección/2 y ráfaga en nudos). Se carga solo al activarla.
// La escala usa los mismos cortes de las alertas: amarillo sobre 25 kt y rojo sobre 34 kt.
const ECMWF_COLORES = [[0,'#e8f3ff'],[5,'#9fd3f5'],[10,'#4fb3e8'],[15,'#3ccf72'],[20,'#b9e04a'],[25,'#f4e23a'],
  [30,'#f6a623'],[34,'#e8452c'],[41,'#c4162f'],[48,'#a3157a'],[56,'#6a1b9a'],[64,'#3b0f5c']];
const ECMWF_TABLA = (() => {
  const c = ECMWF_COLORES.map(([v, x]) => [v, [1,3,5].map(k => parseInt(x.substr(k, 2), 16))]), t = [];
  for (let n = 0; n <= 70; n++) {
    let i = 1; while (i < c.length - 1 && n > c[i][0]) i++;
    const [v0, a] = c[i-1], [v1, b] = c[i], f = Math.min(1, Math.max(0, (n - v0) / (v1 - v0)));
    t.push(a.map((v, k) => Math.round(v * (1-f) + b[k] * f)));
  }
  return t;
})();
function ecmwfRgb(kt) { return ECMWF_TABLA[Math.max(0, Math.min(70, Math.round(kt)))]; }
function ecmwfBeaufort(kt) { return [1,4,7,11,17,22,28,34,41,48,56,64].findIndex(l => kt < l) < 0 ? 12 : [1,4,7,11,17,22,28,34,41,48,56,64].findIndex(l => kt < l); }
function crearCapaECMWF(L, map, escapar, contenedor) {
  contenedor = contenedor || document.getElementById('mapWrap');
  const grupo = L.layerGroup(), flechas = L.layerGroup();
  if (!map.getPane('ecmwfPane')) { map.createPane('ecmwfPane').style.zIndex = 404; }
  if (!map.getPane('ecmwfFlechaPane')) { const p = map.createPane('ecmwfFlechaPane'); p.style.zIndex = 407; p.style.pointerEvents = 'none'; }
  const panel = document.createElement('section'); panel.className = 'uv-panel ecmwf-panel'; panel.hidden = true;
  panel.setAttribute('aria-label', 'Control de viento ECMWF');
  panel.innerHTML = '<div class="uv-cab"><b>Viento ECMWF 9 km</b><a href="https://www.ecmwf.int/en/forecasts/datasets/open-data" target="_blank" rel="noopener noreferrer">Fuente ECMWF ↗</a></div>' +
    '<p class="uv-estado" role="status">Cargando corrida…</p><div class="uv-tiempo" hidden><label>Fecha del pronóstico (hora de Chile)' +
    '<select aria-label="Fecha del pronóstico de viento ECMWF"></select></label>' +
    '<div class="uv-botones"><button type="button" class="uv-anterior" aria-label="Fecha anterior">◀</button><button type="button" class="uv-play">Reproducir</button><button type="button" class="uv-siguiente" aria-label="Fecha siguiente">▶</button></div>' +
    '<input class="uv-slider" type="range" min="0" step="1" value="0" aria-label="Avance de la corrida ECMWF">' +
    '<div class="uv-escala ecmwf-escala" aria-label="Escala de viento de cero a sesenta y cuatro nudos o más"></div>' +
    '<div class="uv-marcas"><span>0 kt</span><span>16</span><span>32</span><span>48</span><span>64+ kt</span></div>' +
    '<label class="ww3-op"><input type="checkbox" checked> Flechas de dirección del viento</label>' +
    '<p class="uv-ayuda">Viento medio a 10 m. Pulsa el mapa para ver rapidez, dirección y ráfaga máxima del período.</p>' +
    '<details><summary>Actualización y alcance</summary><p class="uv-info"></p><p>Modelo global IFS del Centro Europeo (ECMWF) en su resolución nativa de 0,1° (≈ 9 km), ' +
    'recortado a la franja costera entre 17° S y 57° S. Datos abiertos con licencia CC-BY-4.0. Las flechas indican hacia dónde sopla el viento; ' +
    'la dirección del texto es la de procedencia. Se usan las corridas de 00 y 12 UTC; MeteoIA revisa cada 20 minutos si hay una nueva.</p></details></div>';
  contenedor.appendChild(panel);
  L.DomEvent.disableClickPropagation(panel); L.DomEvent.disableScrollPropagation(panel);
  const estado = panel.querySelector('.uv-estado'), selector = panel.querySelector('select'), slider = panel.querySelector('.uv-slider'), play = panel.querySelector('.uv-play');
  const chkFlechas = panel.querySelector('.ww3-op input');
  let idx = null, campos = null, indice = 0, timer = null, overlay = null, token = 0, posicion = {};
  const cache = new Map();
  const activo = () => map.hasLayer(grupo);
  const detener = () => { clearInterval(timer); timer = null; play.textContent = 'Reproducir'; play.setAttribute('aria-pressed', 'false'); };
  function valor(nombre, i, j) {
    const [k, esc] = posicion[nombre];
    const b = campos[k * idx.nlat * idx.nlon + i * idx.nlon + j];
    return b === idx.sin_dato ? NaN : b / esc;
  }
  function velEn(lat, lon) {
    const fi = (idx.lat0 - lat) / -idx.dlat, fj = (lon - idx.lon0) / idx.dlon;
    const i0 = Math.floor(fi), j0 = Math.floor(fj);
    if (i0 < 0 || j0 < 0 || i0 >= idx.nlat - 1 || j0 >= idx.nlon - 1) return NaN;
    const ti = fi - i0, tj = fj - j0;
    let s = 0, w = 0;
    for (const [di, dj, p] of [[0,0,(1-ti)*(1-tj)],[0,1,(1-ti)*tj],[1,0,ti*(1-tj)],[1,1,ti*tj]]) {
      const v = valor('vel', i0 + di, j0 + dj); if (!isNaN(v)) { s += v * p; w += p; }
    }
    return w > 0.25 ? s / w : NaN;
  }
  function pintar() {
    const latN = idx.lat0, latS = idx.lat0 + idx.dlat * (idx.nlat - 1), lonW = idx.lon0, lonE = idx.lon0 + idx.dlon * (idx.nlon - 1);
    const merc = la => Math.log(Math.tan(Math.PI / 4 + la * Math.PI / 360));
    const W = idx.nlon * 4, H = Math.round(W * (merc(latN) - merc(latS)) / ((lonE - lonW) * Math.PI / 180));
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d'), img = ctx.createImageData(W, H), px = img.data;
    const yN = merc(latN), yS = merc(latS);
    for (let y = 0; y < H; y++) {
      const lat = Math.atan(Math.sinh(yN - (y + 0.5) / H * (yN - yS))) * 180 / Math.PI;
      for (let x = 0; x < W; x++) {
        const v = velEn(lat, lonW + (x + 0.5) / W * (lonE - lonW)); if (isNaN(v)) continue;
        const [r, g, b] = ecmwfRgb(v), o = (y * W + x) * 4;
        px[o] = r; px[o+1] = g; px[o+2] = b; px[o+3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    if (overlay) grupo.removeLayer(overlay);
    overlay = L.imageOverlay(cv.toDataURL('image/png'), [[latS, lonW], [latN, lonE]], { pane: 'ecmwfPane', opacity: 0.7, interactive: true, bubblingMouseEvents: false,
      attribution: 'Viento: ECMWF IFS (CC-BY-4.0)' }).on('click', consultar).addTo(grupo);
    pintarFlechas();
  }
  function pintarFlechas() {
    flechas.clearLayers();
    if (!idx || !campos || !activo() || !chkFlechas.checked) return;
    const b = map.getBounds().pad(0.05), z = map.getZoom();
    const paso = Math.max(1, Math.round(40 / (256 * Math.pow(2, z) * idx.dlon / 360)));
    for (let i = 0; i < idx.nlat; i += paso) {
      const lat = idx.lat0 + idx.dlat * i; if (lat < b.getSouth() || lat > b.getNorth()) continue;
      for (let j = 0; j < idx.nlon; j += paso) {
        const lon = idx.lon0 + idx.dlon * j; if (lon < b.getWest() || lon > b.getEast()) continue;
        const d = valor('dir', i, j), v = valor('vel', i, j); if (isNaN(d) || isNaN(v) || v < 1) continue;
        const largo = 10 + Math.min(v, 50) * 0.3;
        L.marker([lat, lon], { pane: 'ecmwfFlechaPane', interactive: false, keyboard: false,
          icon: L.divIcon({ className: 'ww3-flecha ecmwf-flecha', iconSize: [0, 0],
            html: `<svg width="30" height="30" viewBox="-15 -15 30 30" style="transform:rotate(${(d + 180) % 360}deg)"><path d="M0 ${largo/2}V${-largo/2}M-4 ${-largo/2+5}L0 ${-largo/2}L4 ${-largo/2+5}" /></svg>` }) }).addTo(flechas);
      }
    }
  }
  function consultar(e) {
    const { lat, lng } = e.latlng;
    const i = Math.round((idx.lat0 - lat) / -idx.dlat), j = Math.round((lng - idx.lon0) / idx.dlon);
    if (i < 0 || j < 0 || i >= idx.nlat || j >= idx.nlon) return;
    const vel = valor('vel', i, j), d = valor('dir', i, j), raf = valor('raf', i, j);
    if (isNaN(vel)) return;
    const p = idx.plazos[indice];
    const nivel = vel > 34 ? ' · <b style="color:#c4162f">sobre 34 kt</b>' : vel > 25 ? ' · <b style="color:#b07d00">sobre 25 kt</b>' : '';
    L.popup({ className: 'uv-popup', maxWidth: 280 }).setLatLng(e.latlng).setContent(
      `<div class="uv-ficha"><b>Viento ECMWF 9 km</b> · ${escapar(ww3Fecha(p.valido))}<p>Viento medio a 10 m<br><strong>${Math.round(vel)} kt</strong> ${isNaN(d) ? '' : ww3Rumbo(d) + ' (' + Math.round(d) + '°)'}</p>` +
      `<p>Beaufort ${ecmwfBeaufort(vel)}${nivel}<br>Ráfaga máxima del período: <b>${isNaN(raf) ? '–' : Math.round(raf) + ' kt'}</b></p>` +
      `<small>${Math.abs(lat).toFixed(2)}° S · ${Math.abs(lng).toFixed(2)}° W · celda de 0,1°. Dirección de procedencia.</small></div>`).openOn(map);
  }
  async function mostrar(n) {
    if (!idx || !activo()) return;
    const solicitud = ++token; indice = (n + idx.plazos.length) % idx.plazos.length;
    const p = idx.plazos[indice]; selector.value = String(indice); slider.value = String(indice);
    estado.textContent = ww3Fecha(p.valido) + ' · +' + p.paso + ' h';
    try {
      let b = cache.get(p.archivo);
      if (!b) {
        const r = await fetch(ECMWF_BASE + p.archivo + '?c=' + idx.clave, { signal: AbortSignal.timeout(45000) });
        if (!r.ok) throw Error('sin plazo');
        b = new Uint8Array(await r.arrayBuffer());
        if (b.length !== idx.nlat * idx.nlon * idx.campos.length) throw Error('tamaño inesperado');
        cache.set(p.archivo, b);
      }
      if (solicitud !== token || !activo()) return;
      campos = b; pintar(); map.closePopup();
    } catch (e) { if (solicitud === token) { detener(); estado.textContent = 'No se pudo mostrar esta fecha del viento ECMWF.'; } }
  }
  async function cargar() {
    try {
      const r = await fetch(ECMWF_BASE + 'indice.json?t=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw Error('sin corrida');
      const nuevo = await r.json();
      if (!nuevo.plazos?.length) throw Error('sin plazos');
      if (idx && nuevo.clave === idx.clave) return;
      idx = nuevo; cache.clear();
      posicion = Object.fromEntries(idx.campos.map((c, k) => [c.clave, [k, c.escala]]));
      selector.innerHTML = idx.plazos.map((p, k) => `<option value="${k}">${escapar(ww3Fecha(p.valido))} · +${p.paso} h</option>`).join('');
      slider.max = String(idx.plazos.length - 1);
      panel.querySelector('.uv-tiempo').hidden = false;
      panel.querySelector('.uv-info').textContent = `Corrida ${ww3Fecha(idx.corrida.replace(/Z$/, ':00Z'))} (hora de Chile), ${idx.plazos.length} fechas: cada 3 horas hasta +72 h y cada 6 horas hasta +${idx.plazos.at(-1).paso} h.`;
      const ahora = Date.now();
      let k = 0; idx.plazos.forEach((p, n) => { if (Math.abs(Date.parse(p.valido) - ahora) < Math.abs(Date.parse(idx.plazos[k].valido) - ahora)) k = n; });
      await mostrar(k);
    } catch (e) { if (!idx) estado.textContent = 'El viento ECMWF aún no está disponible. Se publica con la próxima corrida del modelo.'; }
  }
  selector.onchange = () => { detener(); mostrar(+selector.value); };
  slider.oninput = () => { detener(); mostrar(+slider.value); };
  panel.querySelector('.uv-anterior').onclick = () => { detener(); mostrar(indice - 1); };
  panel.querySelector('.uv-siguiente').onclick = () => { detener(); mostrar(indice + 1); };
  play.onclick = () => {
    if (timer) return detener();
    play.textContent = 'Pausa'; play.setAttribute('aria-pressed', 'true');
    timer = setInterval(() => mostrar(indice + 1), 1200);
  };
  chkFlechas.onchange = pintarFlechas;
  map.on('moveend zoomend', () => { if (activo()) pintarFlechas(); });
  grupo.on('add', () => { panel.hidden = false; flechas.addTo(map); cargar(); });
  grupo.on('remove', () => { panel.hidden = true; detener(); map.removeLayer(flechas); map.closePopup(); });
  setInterval(() => { if (activo()) cargar(); }, 30 * 60000);
  return grupo;
}
