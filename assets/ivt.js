// Ríos atmosféricos con el GFS 0,25° (data/ivt.json, ivt.bin, ivt_extra.bin e ivt_hist.*, scripts/ivt.py).
// Mapas de IVT, agua precipitable (IWV) y lluvia acumulada en 6 días; escala de Ralph et al. (2019, BAMS 100) en las celdas
// costeras; meteograma por punto o ciudad (IVT, dirección, isoterma de 0 °C, con los análisis de las últimas 48 h) y corte
// vertical del flujo de vapor en 77° W.
// Escala de Ralph: categoría según el IVT máximo del evento (250, 500, 750, 1000 y 1250 kg m⁻¹ s⁻¹) y su duración con
// IVT ≥ 250: baja una categoría si dura menos de 24 h y sube una si dura más de 48 h. Aquí se usa el IVT cada 3 h del GFS
// (no el promedio de 3 h del artículo) y la duración se corta al final del pronóstico (144 h).
const IVT_COLORES = [[100, 'rgba(160,200,230,0)'], [150, 'rgba(160,200,230,.35)'], [249, 'rgba(120,180,230,.6)'], [250, '#ffd400'], [400, '#ff9800'],
  [500, '#ff5a00'], [650, '#e3001b'], [750, '#b0003a'], [1000, '#7a0f7a'], [1250, '#3b0a6b']];
const IVT_CAT = [
  { n: 0, nom: 'Bajo categoría 1', col: '#7fa7c9' }, { n: 1, nom: 'Débil', col: '#ffd400' }, { n: 2, nom: 'Moderado', col: '#ff9800' },
  { n: 3, nom: 'Fuerte', col: '#e3001b' }, { n: 4, nom: 'Extremo', col: '#9c1aa3' }, { n: 5, nom: 'Excepcional', col: '#3b0a6b' }];
const IWV_COLORES = [[8, 'rgba(120,170,215,0)'], [12, 'rgba(120,170,215,.35)'], [20, '#4fa3d8'], [30, '#3cc68a'], [40, '#ffd400'], [50, '#ff7a00'], [60, '#d7191c']];
const PP_COLORES = [[1, 'rgba(150,200,240,0)'], [2, 'rgba(150,200,240,.55)'], [10, '#4fa3d8'], [25, '#3cc68a'], [50, '#ffd400'], [100, '#ff7a00'], [200, '#d7191c'], [400, '#7a0f7a']];
const FLUJO_COLORES = [[20, 'rgba(120,170,215,0)'], [40, 'rgba(120,170,215,.45)'], [80, '#4fa3d8'], [120, '#3cc68a'], [160, '#ffd400'], [220, '#ff7a00'], [300, '#d7191c'], [400, '#7a0f7a']];
const IVT_SOLO = IVT_COLORES;
function ivtRgba(v, T) {
  T = T || IVT_SOLO;
  if (!(v >= T[0][0])) return null;
  const par = x => x.startsWith('#') ? [1, 3, 5].map(k => parseInt(x.substr(k, 2), 16)).concat(1) : x.match(/[\d.]+/g).map(Number);
  let i = 1; while (i < T.length - 1 && v > T[i][0]) i++;
  const [v0, a] = T[i - 1], [v1, b] = T[i];
  if (v0 === 249 && T === IVT_SOLO) return par(b);              // corte nítido en 250 (inicio de condiciones de río atmosférico)
  const f = Math.min(1, Math.max(0, (v - v0) / (v1 - v0))), A = par(a), B = par(b);
  return A.map((x, k) => x * (1 - f) + B[k] * f);
}
// Eventos de río atmosférico en una serie [{t, ivt}] cada 3 h y su categoría en la escala de Ralph et al. (2019)
function ivtEventos(S) {
  const ev = []; let ini = -1;
  S.forEach((s, n) => {
    const en = s.ivt >= 250;
    if (en && ini < 0) ini = n;
    if ((!en || n === S.length - 1) && ini >= 0) {
      const fin = en ? n : n - 1, tramo = S.slice(ini, fin + 1), max = Math.max(...tramo.map(x => x.ivt));
      const dur = (S[fin].t - S[ini].t) / 3600e3 + 3;                 // cada dato representa 3 h
      const base = max >= 1250 ? 5 : max >= 1000 ? 4 : max >= 750 ? 3 : max >= 500 ? 2 : 1;
      const cat = Math.max(0, Math.min(5, base - (dur < 24 ? 1 : 0) + (dur > 48 ? 1 : 0)));
      ev.push({ ini: S[ini].t, fin: S[fin].t, max, dur, cat, abierto: fin === S.length - 1, previo: ini === 0 });
      ini = -1;
    }
  });
  return ev;
}
// Puertos y ciudades costeras para el meteograma (se usa la celda costera más cercana)
const IVT_CIUDADES = [['Arica', -18.48, -70.32], ['Iquique', -20.21, -70.15], ['Antofagasta', -23.65, -70.4], ['Caldera', -27.07, -70.83],
  ['Coquimbo', -29.95, -71.34], ['Valparaíso', -33.03, -71.63], ['San Antonio', -33.59, -71.62], ['Constitución', -35.33, -72.42],
  ['Talcahuano', -36.72, -73.12], ['Lebu', -37.61, -73.65], ['Corral', -39.89, -73.43], ['Puerto Montt', -41.47, -72.94],
  ['Castro', -42.48, -73.76], ['Puerto Aysén', -45.4, -72.7], ['Puerto Natales', -51.73, -72.5], ['Punta Arenas', -53.16, -70.91]];
const IVT_CAMPOS = {
  ivt: { nom: 'IVT', tabla: IVT_COLORES, min: 150, max: 1400, marcas: ['150', '250', '500', '750', '1000', '1250+'], unidad: 'kg m⁻¹ s⁻¹',
    ayuda: 'Transporte integrado de vapor (IVT) en kg m⁻¹ s⁻¹. Desde 250 hay condiciones de río atmosférico.' },
  iwv: { nom: 'IWV', tabla: IWV_COLORES, min: 12, max: 60, marcas: ['12', '20', '30', '40', '50', '60+'], unidad: 'kg m⁻²',
    ayuda: 'Agua precipitable (IWV, vapor integrado en la columna) en kg m⁻², equivalente a mm de agua.' },
  pp: { nom: 'Lluvia 6 días', tabla: PP_COLORES, min: 2, max: 400, marcas: ['2', '10', '25', '50', '100', '200', '400 mm'], unidad: 'mm',
    ayuda: 'Precipitación acumulada del GFS en toda la corrida (6 días), en mm. No cambia con la fecha elegida.' }
};
function crearCapaIVT(L, map, escapar, contenedor, base) {
  base = base || 'data/';
  const grupo = L.layerGroup(), flechas = L.layerGroup(), costaG = L.layerGroup();
  if (!map.getPane('ivtPane')) map.createPane('ivtPane').style.zIndex = 403;
  if (!map.getPane('ivtFlechaPane')) { const p = map.createPane('ivtFlechaPane'); p.style.zIndex = 406; p.style.pointerEvents = 'none'; }
  // Los puntos costeros van en SVG con el panel transparente a los clics: un lienzo cubriría el mapa y taparía la consulta
  if (!map.getPane('ivtCostaPane')) { const p = map.createPane('ivtCostaPane'); p.style.zIndex = 409; p.style.pointerEvents = 'none'; }
  const rendCosta = L.svg({ pane: 'ivtCostaPane' });
  const panel = document.createElement('section'); panel.className = 'uv-panel ivt-panel'; panel.hidden = true;
  panel.setAttribute('aria-label', 'Control de ríos atmosféricos');
  panel.innerHTML = '<div class="uv-cab"><b>Ríos atmosféricos</b><a href="https://www.nco.ncep.noaa.gov/pmb/products/gfs/" target="_blank" rel="noopener noreferrer">Fuente GFS ↗</a></div>' +
    '<div class="ivt-campos" role="group" aria-label="Campo del mapa">' + Object.entries(IVT_CAMPOS).map(([k, c]) => `<button type="button" data-campo="${k}">${c.nom}</button>`).join('') + '</div>' +
    '<p class="uv-estado" role="status">Cargando corrida…</p><div class="uv-tiempo" hidden><label>Fecha del pronóstico (hora de Chile)' +
    '<select class="ivt-fecha" aria-label="Fecha del pronóstico"></select></label>' +
    '<div class="uv-botones"><button type="button" class="uv-anterior" aria-label="Fecha anterior">◀</button><button type="button" class="uv-play">Reproducir</button><button type="button" class="uv-siguiente" aria-label="Fecha siguiente">▶</button></div>' +
    '<input class="uv-slider" type="range" min="0" step="1" value="0" aria-label="Avance de la corrida GFS"></div>' +
    '<div class="uv-escala ivt-escala"></div><div class="uv-marcas ivt-marcas"></div>' +
    '<label class="ww3-op"><input type="checkbox" class="ivt-chk-fl" checked> Flechas del transporte (IVT ≥ 250)</label>' +
    '<label class="ww3-op"><input type="checkbox" class="ivt-chk-co" checked> Escala de Ralph en la costa (próximos 6 días)</label>' +
    '<label class="ivt-ciudad">Meteograma de una ciudad<select aria-label="Ciudad para el meteograma"><option value="">Elegir…</option>' +
    IVT_CIUDADES.map(([n], k) => `<option value="${k}">${n}</option>`).join('') + '</select></label>' +
    '<button type="button" class="ivt-btn-corte" aria-pressed="false">Corte vertical en 77° W</button>' +
    '<div class="ivt-zonas"></div>' +
    '<p class="uv-ayuda ivt-ayuda"></p>' +
    '<details><summary>Cómo se calcula</summary><p class="uv-info"></p><p>IVT = (1/g) ∫ q·V dp, de la superficie a 300 hPa, con la humedad específica y el viento del GFS 0,25° en 17 niveles. ' +
    'IWV, isoterma de 0 °C y lluvia salen directo del GFS. Escala de Ralph et al. (2019, BAMS 100): categoría 1 a 5 según el IVT máximo del evento (250, 500, 750, 1000 y 1250) y su duración con IVT ≥ 250; ' +
    'baja una categoría si dura menos de 24 h y sube una si dura más de 48 h. Aquí se usa el IVT cada 3 h, se suman los análisis de las últimas 48 h y la duración se corta al final del pronóstico. ' +
    'En Chile los ríos atmosféricos aportan cerca de la mitad de la lluvia anual entre 32° y 47° S (Viale et al., 2018, J. Hydrometeor. 19). ' +
    'Estimación automática: no constituye aviso.</p></details>';
  contenedor.appendChild(panel);
  const caja = document.createElement('section'); caja.className = 'ivt-corte'; caja.hidden = true; caja.setAttribute('aria-label', 'Corte vertical del flujo de vapor');
  contenedor.appendChild(caja);
  for (const el of [panel, caja]) { L.DomEvent.disableClickPropagation(el); L.DomEvent.disableScrollPropagation(el); }
  const $ = q => panel.querySelector(q);
  const estado = $('.uv-estado'), selector = $('.ivt-fecha'), slider = $('.uv-slider'), play = $('.uv-play');
  const chkFl = $('.ivt-chk-fl'), chkCo = $('.ivt-chk-co'), cajaZonas = $('.ivt-zonas'), selCiudad = $('.ivt-ciudad select'), btnCorte = $('.ivt-btn-corte');
  let idx = null, datos = null, extra = null, hist = null, indice = 0, timer = null, overlay = null, zonas = null, campo = 'ivt';
  try { campo = localStorage.getItem('ivtCampo') || 'ivt'; if (!IVT_CAMPOS[campo]) campo = 'ivt'; } catch (e) { /* sin almacenamiento */ }
  const activo = () => map.hasLayer(grupo);
  const detener = () => { clearInterval(timer); timer = null; play.textContent = 'Reproducir'; play.setAttribute('aria-pressed', 'false'); };
  const tam = () => idx.nlat * idx.nlon;
  const nc = () => idx.campos.length;
  const kc = clave => idx.campos.findIndex(c => c.clave === clave);
  const mult = k => { const e = idx.campos[k].escala; return e < 1 ? 1 / e : e; };      // la versión 1 guardaba el inverso
  function leerByte(arr, n, clave, i, j) {
    const k = kc(clave); if (k < 0 || !arr) return NaN;
    const b = arr[(n * nc() + k) * tam() + i * idx.nlon + j];
    return b === idx.sin_dato || b === undefined ? NaN : b * mult(k);
  }
  const val = (n, clave, i, j) => leerByte(datos, n, clave, i, j);
  const tPron = () => Date.parse(idx.plazos[0].valido);
  // Serie en una celda: análisis de las últimas 48 h (anteriores al pronóstico) + pronóstico
  function serieEn(i, j) {
    const S = [];
    if (hist) hist.validos.forEach((v, n) => { const t = Date.parse(v); if (t < tPron()) S.push({ t, pasado: true, ivt: leerByte(hist.datos, n, 'ivt', i, j), dir: leerByte(hist.datos, n, 'dir', i, j), iwv: leerByte(hist.datos, n, 'iwv', i, j), iso0: leerByte(hist.datos, n, 'iso0', i, j) }); });
    idx.plazos.forEach((p, n) => S.push({ t: Date.parse(p.valido), ivt: val(n, 'ivt', i, j), dir: val(n, 'dir', i, j), iwv: val(n, 'iwv', i, j), iso0: val(n, 'iso0', i, j) }));
    return S;
  }
  const lluvia = (i, j) => { if (!extra) return NaN; const b = extra.pp[i * idx.nlon + j]; return b === 65535 ? NaN : b / (idx.extra.pp_escala || 10); };
  function valorCampo(i, j) { return campo === 'pp' ? lluvia(i, j) : val(indice, campo, i, j); }
  function campoEn(lat, lon) {
    const fi = (idx.lat0 - lat) / -idx.dlat, fj = (lon - idx.lon0) / idx.dlon, i0 = Math.floor(fi), j0 = Math.floor(fj);
    if (i0 < 0 || j0 < 0 || i0 >= idx.nlat - 1 || j0 >= idx.nlon - 1) return NaN;
    const ti = fi - i0, tj = fj - j0; let s = 0, w = 0;
    for (const [di, dj, p] of [[0, 0, (1 - ti) * (1 - tj)], [0, 1, (1 - ti) * tj], [1, 0, ti * (1 - tj)], [1, 1, ti * tj]]) {
      const v = valorCampo(i0 + di, j0 + dj); if (!isNaN(v)) { s += v * p; w += p; }
    }
    return w > 0.25 ? s / w : NaN;
  }
  function leyenda() {
    const c = IVT_CAMPOS[campo], tabla = c.tabla.slice(1);
    const pos = v => campo === 'pp' ? Math.log(v / c.min) / Math.log(c.max / c.min) : (v - c.min) / (c.max - c.min);
    $('.ivt-escala').style.background = `linear-gradient(90deg,${tabla.map(([v, col]) => `${col} ${Math.round(Math.max(0, Math.min(1, pos(v))) * 100)}%`).join(',')})`;
    $('.ivt-escala').setAttribute('aria-label', `Escala de ${c.nom} en ${c.unidad}`);
    $('.ivt-marcas').innerHTML = c.marcas.map(m => `<span>${m}</span>`).join('');
    $('.ivt-ayuda').textContent = c.ayuda + ' Toca el mapa, un punto de la costa o elige una ciudad para ver el meteograma.';
    panel.querySelectorAll('.ivt-campos button').forEach(b => { const on = b.dataset.campo === campo; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    $('.uv-cab b').textContent = 'Ríos atmosféricos · ' + c.nom;
  }
  function pintar() {
    const latN = idx.lat0, latS = idx.lat0 + idx.dlat * (idx.nlat - 1), lonW = idx.lon0, lonE = idx.lon0 + idx.dlon * (idx.nlon - 1);
    const merc = la => Math.log(Math.tan(Math.PI / 4 + la * Math.PI / 360)), yN = merc(latN), yS = merc(latS);
    const W = idx.nlon * 6, H = Math.round(W * (yN - yS) / ((lonE - lonW) * Math.PI / 180));
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d'), img = ctx.createImageData(W, H), px = img.data, tabla = IVT_CAMPOS[campo].tabla;
    for (let y = 0; y < H; y++) {
      const lat = Math.atan(Math.sinh(yN - (y + 0.5) / H * (yN - yS))) * 180 / Math.PI;
      for (let x = 0; x < W; x++) {
        const c = ivtRgba(campoEn(lat, lonW + (x + 0.5) / W * (lonE - lonW)), tabla); if (!c) continue;
        const o = (y * W + x) * 4; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = Math.round(c[3] * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    if (overlay) grupo.removeLayer(overlay);
    overlay = L.imageOverlay(cv.toDataURL('image/png'), [[latS, lonW], [latN, lonE]], { pane: 'ivtPane', opacity: 0.8, interactive: true, bubblingMouseEvents: false,
      attribution: 'Ríos atmosféricos: NOAA GFS' }).on('click', consultar).addTo(grupo);
    pintarFlechas();
  }
  function pintarFlechas() {
    flechas.clearLayers();
    if (!idx || !datos || !activo() || !chkFl.checked || campo === 'pp') return;
    const b = map.getBounds().pad(0.05), paso = Math.max(1, Math.round(44 / (256 * Math.pow(2, map.getZoom()) * idx.dlon / 360)));
    for (let i = 0; i < idx.nlat; i += paso) {
      const lat = idx.lat0 + idx.dlat * i; if (lat < b.getSouth() || lat > b.getNorth()) continue;
      for (let j = 0; j < idx.nlon; j += paso) {
        const lon = idx.lon0 + idx.dlon * j; if (lon < b.getWest() || lon > b.getEast()) continue;
        const v = val(indice, 'ivt', i, j), d = val(indice, 'dir', i, j); if (!(v >= 250) || isNaN(d)) continue;
        const largo = 10 + Math.min(v, 1000) / 1000 * 14;
        L.marker([lat, lon], { pane: 'ivtFlechaPane', interactive: false, keyboard: false, icon: L.divIcon({ className: 'ww3-flecha ivt-flecha', iconSize: [0, 0],
          html: `<svg width="30" height="30" viewBox="-15 -15 30 30" style="transform:rotate(${d}deg)"><path d="M0 ${largo / 2}V${-largo / 2}M-4 ${-largo / 2 + 5}L0 ${-largo / 2}L4 ${-largo / 2 + 5}" /></svg>` }) }).addTo(flechas);
      }
    }
  }
  const fecha = t => ww3Fecha(new Date(t).toISOString());
  const nomCat = c => IVT_CAT[c].nom + (c ? ` (categoría ${c})` : '');
  const mayorEv = ev => ev.length ? ev.reduce((a, b) => b.cat > a.cat || (b.cat === a.cat && b.max > a.max) ? b : a) : null;
  // Eventos que siguen o empiezan desde el inicio del pronóstico (los análisis previos solo aportan duración)
  const eventosFuturos = S => ivtEventos(S).filter(e => e.fin >= tPron());
  // Escala de Ralph en las celdas costeras: el evento de mayor categoría de los próximos 6 días
  let resCosta = [];
  function pintarCosta() {
    costaG.clearLayers(); resCosta = [];
    if (!idx || !datos) return;
    for (const [i, j] of idx.costa || []) {
      const e = mayorEv(eventosFuturos(serieEn(i, j))); if (!e) continue;
      const lat = idx.lat0 + idx.dlat * i, lon = idx.lon0 + idx.dlon * j;
      resCosta.push({ lat, lon, e });
      if (!chkCo.checked) continue;
      L.circleMarker([lat, lon], { pane: 'ivtCostaPane', renderer: rendCosta, radius: e.cat >= 3 ? 7 : 5.5, color: '#0b1d31', weight: 1.2, fillColor: IVT_CAT[e.cat].col, fillOpacity: 0.95 })
        .bindTooltip(`${escapar(nomCat(e.cat))} · máx. ${Math.round(e.max)} · ${e.dur} h${e.abierto ? '+' : ''}`, { direction: 'left' })
        .on('click', ev2 => { L.DomEvent.stop(ev2); consultar({ latlng: L.latLng(lat, lon) }); }).addTo(costaG);
    }
    resumenZonas();
  }
  const anillos = g => g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  function enPoligono(f, lat, lon) {
    for (const pol of anillos(f.geometry)) {
      let ok = false;
      pol.forEach((r, n) => { let c = false; for (let a = 0, b = r.length - 1; a < r.length; b = a++) { const [xa, ya] = r[a], [xb, yb] = r[b]; if ((ya > lat) !== (yb > lat) && lon < (xb - xa) * (lat - ya) / (yb - ya) + xa) c = !c; } if (n === 0) ok = c; else if (c) ok = false; });
      if (ok) return true;
    }
    return false;
  }
  function resumenZonas() {
    if (!zonas || !idx) { cajaZonas.innerHTML = ''; return; }
    const filas = zonas.map(z => {
      const enZ = resCosta.filter(r => enPoligono(z, r.lat, r.lon) || [0.5, -0.5, 1, -1].some(d => enPoligono(z, r.lat, r.lon + d)));
      const m = enZ.reduce((a, b) => !a || b.e.cat > a.e.cat || (b.e.cat === a.e.cat && b.e.max > a.e.max) ? b : a, null);
      const id = z.properties.id;
      return m ? `<li><b>${escapar(id)}</b> <i style="background:${IVT_CAT[m.e.cat].col}"></i>${escapar(nomCat(m.e.cat))} · ${escapar(fecha(Math.max(m.e.ini, tPron())))}</li>`
        : `<li><b>${escapar(id)}</b> <i style="background:transparent;border:1px solid #5d7a96"></i>Sin condiciones de río atmosférico</li>`;
    });
    cajaZonas.innerHTML = `<p class="ivt-zt">Máximo en la costa de cada zona, próximos 6 días</p><ul>${filas.join('')}</ul>`;
  }
  const celda = (lat, lng) => [Math.round((idx.lat0 - lat) / -idx.dlat), Math.round((lng - idx.lon0) / idx.dlon)];
  let ultimaConsulta = null;
  function consultar(e, nombre) {
    if (!idx || !datos) return;
    const [i, j] = celda(e.latlng.lat, e.latlng.lng);
    if (i < 0 || j < 0 || i >= idx.nlat || j >= idx.nlon) return;
    const v = val(indice, 'ivt', i, j), d = val(indice, 'dir', i, j); if (isNaN(v)) return;
    const w = val(indice, 'iwv', i, j), z0 = val(indice, 'iso0', i, j), pp = lluvia(i, j);
    const S = serieEn(i, j), ev = eventosFuturos(S), tSel = Date.parse(idx.plazos[indice].valido);
    const ahora = ev.find(x => x.ini <= tSel && tSel <= x.fin), mayor = mayorEv(ev);
    const txtEv = x => `<b style="color:${IVT_CAT[x.cat].col}">${escapar(nomCat(x.cat))}</b>: máx. ${Math.round(x.max)} kg m⁻¹ s⁻¹, ${x.dur} h${x.abierto ? ' o más (sigue al final del pronóstico)' : ''} con IVT ≥ 250, ${escapar(fecha(x.ini))} a ${escapar(fecha(x.fin))}`;
    const dato = (t, x, u) => isNaN(x) ? '' : `<span><small>${t}</small><b>${x}</b> ${u}</span>`;
    L.popup({ className: 'uv-popup ivt-popup', maxWidth: 340, autoPanPaddingTopLeft: [10, 10] }).setLatLng(e.latlng).setContent(
      `<div class="uv-ficha ivt-ficha"><b>${nombre ? escapar(nombre) + ' · ' : ''}Río atmosférico</b> · ${escapar(ww3Fecha(idx.plazos[indice].valido))}` +
      `<div class="ivt-datos"><span><small>IVT</small><strong>${Math.round(v)}</strong> kg m⁻¹ s⁻¹${isNaN(d) ? '' : ' hacia el ' + ww3Rumbo(d)}</span>` +
      dato('IWV', Math.round(w), 'kg m⁻²') + dato('Isoterma 0 °C', isNaN(z0) ? NaN : Math.round(z0 / 50) * 50, 'm') + dato('Lluvia 6 días (GFS)', isNaN(pp) ? NaN : pp.toFixed(pp < 10 ? 1 : 0).replace('.', ','), 'mm') + '</div>' +
      (v >= 250 ? '<p><b>Condiciones de río atmosférico en esta fecha.</b></p>' : '') +
      `<p>${ahora ? 'Evento en curso: ' + txtEv(ahora) : mayor ? 'Mayor evento de los próximos días: ' + txtEv(mayor) : 'Sin condiciones de río atmosférico (IVT ≥ 250) en los próximos 6 días.'}</p>` +
      `<div class="ec-evol"><b>Meteograma</b>${grafIVT(S, ev, tSel)}${grafIso(S, tSel)}</div>` +
      `<small>${Math.abs(idx.lat0 + idx.dlat * i).toFixed(1)}° S · ${Math.abs(idx.lon0 + idx.dlon * j).toFixed(1)}° W · celda de 0,5°. Sombra gris: análisis de las corridas anteriores (lo ocurrido). Escala de Ralph et al. (2019) con el IVT cada 3 h.</small></div>`).openOn(map);
    ultimaConsulta = { e, nombre }; contenedor.classList.add('ec-ficha');      // en el celular se oculta el panel mientras se ve la ficha
  }
  // Eje de tiempo común a los dos gráficos del meteograma
  function ejeT(S, W, iz, de) {
    const t0 = S[0].t, t1 = S[S.length - 1].t, X = t => iz + (t - t0) / (t1 - t0) * (W - iz - de);
    return { t0, t1, X };
  }
  function diasYMarca(S, X, ar, h, H, tSel) {
    let g = '';
    const dia = t => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
    let dd = dia(S[0].t);
    for (let t = S[0].t; t <= S[S.length - 1].t; t += 3600e3) { const x = dia(t); if (x !== dd) { dd = x; g += `<line x1="${X(t)}" x2="${X(t)}" y1="${ar}" y2="${ar + h}" stroke="#5d7a96" stroke-width=".6"/>` + (H ? `<text x="${X(t) + 2}" y="${H - 6}">${new Date(t).toLocaleDateString('es-CL', { timeZone: 'America/Santiago', weekday: 'short', day: 'numeric' }).replace('.', '')}</text>` : ''); } }
    if (tSel) g += `<line x1="${X(tSel)}" x2="${X(tSel)}" y1="${ar}" y2="${ar + h}" stroke="#2f8cff" stroke-width="1.2"/>`;
    return g;
  }
  function sombraPasado(S, X, ar, h) {
    const p = S.filter(s => s.pasado); if (!p.length) return '';
    const x1 = X(tPron());
    return `<rect x="${X(S[0].t)}" y="${ar}" width="${x1 - X(S[0].t)}" height="${h}" fill="#5d7a96" opacity=".16"/><text x="${X(S[0].t) + 3}" y="${ar + 9}" fill="#9fb3c8">Análisis</text>`;
  }
  function grafIVT(S, ev, tSel) {
    const W = 310, H = 160, iz = 32, de = 6, ar = 18, ab = 20, h = H - ar - ab, { X } = ejeT(S, W, iz, de);
    const vmax = Math.max(0, ...S.map(s => s.ivt).filter(x => !isNaN(x)));
    const ymax = Math.max(500, Math.ceil(vmax / 250) * 250), Y = v => ar + h - v / ymax * h;
    let g = sombraPasado(S, X, ar, h);
    for (const e of ev) {
      const x0 = X(e.ini) - 2, x1 = X(e.fin) + 2;
      g += `<rect x="${x0}" y="${ar}" width="${x1 - x0}" height="${h}" fill="${IVT_CAT[e.cat].col}" opacity=".18"/>` +
        `<text x="${(x0 + x1) / 2}" y="${ar + 9}" text-anchor="middle" fill="${IVT_CAT[e.cat].col}" style="font-weight:700">${e.cat ? 'Cat. ' + e.cat : '<1'}</text>`;
    }
    for (let v = 0; v <= ymax; v += 250) g += `<line x1="${iz}" x2="${W - de}" y1="${Y(v)}" y2="${Y(v)}" stroke="${v ? IVT_CAT[Math.min(5, v / 250)].col : '#2c4560'}" stroke-width="${v ? .8 : .6}"${v ? ' stroke-dasharray="3 3"' : ''}/><text x="${iz - 3}" y="${Y(v) + 3}" text-anchor="end">${v}</text>`;
    g += diasYMarca(S, X, ar, h, H, tSel);
    S.forEach((s, n) => { if (n % 4 || isNaN(s.dir) || !(s.ivt >= 100)) return; g += `<g transform="translate(${X(s.t)},7) rotate(${s.dir})"><path d="M0 5V-5M-3 -1L0 -5L3 -1" fill="none" stroke="#c9d9ea" stroke-width="1.3" stroke-linecap="round"/></g>`; });
    const linea = S.filter(s => !isNaN(s.ivt)).map((s, n) => `${n ? 'L' : 'M'}${X(s.t).toFixed(1)},${Y(s.ivt).toFixed(1)}`).join('');
    return `<svg class="ec-graf" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Evolución del IVT en el punto">${g}<path d="${linea}" fill="none" stroke="#4fb3ff" stroke-width="2"/></svg>` +
      `<div class="ec-ley"><span><i style="background:#4fb3ff"></i>IVT (kg m⁻¹ s⁻¹) y dirección del transporte</span><span>Bandas: eventos y su categoría</span></div>`;
  }
  function grafIso(S, tSel) {
    const vals = S.map(s => s.iso0).filter(x => !isNaN(x)); if (!vals.length) return '';
    const W = 310, H = 92, iz = 32, de = 6, ar = 8, ab = 6, h = H - ar - ab, { X } = ejeT(S, W, iz, de);
    const y0 = Math.floor(Math.min(...vals) / 500) * 500, y1 = Math.max(y0 + 1000, Math.ceil(Math.max(...vals) / 500) * 500), Y = v => ar + h - (v - y0) / (y1 - y0) * h;
    let g = sombraPasado(S, X, ar, h).replace(/<text[^>]*>Análisis<\/text>/, '');
    const paso = y1 - y0 > 3000 ? 1000 : 500;
    for (let v = y0; v <= y1; v += paso) g += `<line x1="${iz}" x2="${W - de}" y1="${Y(v)}" y2="${Y(v)}" stroke="#2c4560" stroke-width=".6"/><text x="${iz - 3}" y="${Y(v) + 3}" text-anchor="end">${v}</text>`;
    g += diasYMarca(S, X, ar, h, 0, tSel);
    const linea = S.filter(s => !isNaN(s.iso0)).map((s, n) => `${n ? 'L' : 'M'}${X(s.t).toFixed(1)},${Y(s.iso0).toFixed(1)}`).join('');
    return `<svg class="ec-graf" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Altura de la isoterma de 0 grados en el punto">${g}<path d="${linea}" fill="none" stroke="#ff9f43" stroke-width="2"/></svg>` +
      `<div class="ec-ley"><span><i style="background:#ff9f43"></i>Isoterma de 0 °C (m sobre el nivel del mar)</span> · hora de Chile</div>`;
  }
  // Corte vertical del flujo de vapor q·|V| a lo largo de 77° W (latitud en el eje horizontal, norte a la izquierda)
  function pintarCorte() {
    if (caja.hidden || !idx) return;
    const C = idx.extra && idx.extra.corte;
    if (!extra || !C) { caja.innerHTML = '<div class="ivt-corte-cab"><b>Corte vertical en 77° W</b><button type="button" class="ivt-cerrar" aria-label="Cerrar">✕</button></div><p>El corte vertical estará disponible con la próxima corrida del GFS.</p>'; caja.querySelector('.ivt-cerrar').onclick = cerrarCorte; return; }
    const nv = C.niveles.length, nl = idx.nlat, off = indice * 2 * nv * nl, j77 = Math.round((C.lon - idx.lon0) / idx.dlon);
    const W = 620, H = 310, iz = 40, de = 10, ar = 86, ab = 26, w = W - iz - de, h = H - ar - ab;
    const latN = idx.lat0, latS = idx.lat0 + idx.dlat * (nl - 1), X = la => iz + (latN - la) / (latN - latS) * w;
    const pMax = C.niveles[0], pMin = C.niveles[nv - 1], Y = p => ar + (p - pMin) / (pMax - pMin) * h;
    const cw = w / (nl - 1);
    let g = '';
    for (let k = 0; k < nv; k++) {
      const p = C.niveles[k], pa = k ? (C.niveles[k - 1] + p) / 2 : p, pb = k < nv - 1 ? (C.niveles[k + 1] + p) / 2 : p;
      for (let i = 0; i < nl; i++) {
        const b = extra.corte[off + k * nl + i], x = X(idx.lat0 + idx.dlat * i) - cw / 2, y = Y(pb), hh = Y(pa) - Y(pb);
        if (b === 255) { g += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cw + .3}" height="${hh + .3}" fill="#3a4b5c"/>`; continue; }
        const c = ivtRgba(b * C.escala, FLUJO_COLORES); if (!c) continue;
        g += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(cw + .3).toFixed(1)}" height="${(hh + .3).toFixed(1)}" fill="rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${c[3].toFixed(2)})"/>`;
      }
    }
    for (let k = 0; k < nv; k += 2) for (let i = 0; i < nl; i += 4) {
      const f = extra.corte[off + k * nl + i], d = extra.corte[off + nv * nl + k * nl + i];
      if (f === 255 || d === 255 || f * C.escala < 40) continue;
      g += `<g transform="translate(${X(idx.lat0 + idx.dlat * i).toFixed(1)},${Y(C.niveles[k]).toFixed(1)}) rotate(${d * 2})"><path d="M0 6V-6M-3 -2L0 -6L3 -2" fill="none" stroke="#0b1d31" stroke-width="1.4" stroke-linecap="round"/></g>`;
    }
    for (const p of [1000, 850, 700, 500, 300]) g += `<line x1="${iz}" x2="${W - de}" y1="${Y(p)}" y2="${Y(p)}" stroke="#ffffff" stroke-opacity=".18"/><text x="${iz - 4}" y="${Y(p) + 3}" text-anchor="end">${p}</text>`;
    for (let la = -20; la >= -55; la -= 5) g += `<line x1="${X(la)}" x2="${X(la)}" y1="${ar}" y2="${ar + h}" stroke="#ffffff" stroke-opacity=".12"/><text x="${X(la)}" y="${H - 10}" text-anchor="middle">${-la}° S</text>`;
    // IVT a lo largo del meridiano, con el umbral de 250
    const top = 16, hb = ar - top - 26, ivts = [];
    for (let i = 0; i < nl; i++) ivts.push(val(indice, 'ivt', i, j77));
    const imax = Math.max(500, Math.ceil(Math.max(0, ...ivts.filter(x => !isNaN(x))) / 250) * 250), YI = v => top + hb - v / imax * hb;
    g += `<line x1="${iz}" x2="${W - de}" y1="${YI(250)}" y2="${YI(250)}" stroke="#ffd400" stroke-dasharray="3 3"/><text x="${iz - 4}" y="${YI(250) + 3}" text-anchor="end">250</text><text x="${iz - 4}" y="${top + 3}" text-anchor="end">${imax}</text>`;
    g += `<path d="${ivts.map((v, i) => isNaN(v) ? '' : `${i ? 'L' : 'M'}${X(idx.lat0 + idx.dlat * i).toFixed(1)},${YI(v).toFixed(1)}`).join('')}" fill="none" stroke="#4fb3ff" stroke-width="2"/>`;
    caja.innerHTML = `<div class="ivt-corte-cab"><b>Corte vertical en 77° W · ${escapar(ww3Fecha(idx.plazos[indice].valido))}</b><button type="button" class="ivt-cerrar" aria-label="Cerrar el corte vertical">✕</button></div>` +
      `<svg class="ec-graf" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Flujo de vapor por nivel y latitud en 77 grados oeste">${g}<text x="${W - de}" y="${top - 3}" text-anchor="end">IVT (kg m⁻¹ s⁻¹)</text><text x="${iz}" y="${ar - 3}">hPa</text></svg>` +
      `<div class="ec-ley"><span><i style="background:linear-gradient(90deg,#4fa3d8,#3cc68a,#ffd400,#ff7a00,#d7191c,#7a0f7a)"></i>Flujo de vapor q·|V| (g kg⁻¹ m s⁻¹): 40 a 400</span><span><i style="background:#4fb3ff"></i>IVT en el meridiano</span><span>Flechas: hacia dónde va el flujo (arriba = norte)</span><span><i style="background:#3a4b5c"></i>bajo la superficie</span></div>`;
    caja.querySelector('.ivt-cerrar').onclick = cerrarCorte;
  }
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && !caja.hidden) cerrarCorte(); });
  function cerrarCorte() { caja.hidden = true; btnCorte.setAttribute('aria-pressed', 'false'); btnCorte.classList.remove('on'); }
  btnCorte.onclick = () => { if (!caja.hidden) return cerrarCorte(); caja.hidden = false; btnCorte.setAttribute('aria-pressed', 'true'); btnCorte.classList.add('on'); pintarCorte(); };
  function mostrar(n) {
    if (!idx || !datos || !activo()) return;
    indice = (n + idx.plazos.length) % idx.plazos.length;
    const p = idx.plazos[indice]; selector.value = String(indice); slider.value = String(indice);
    estado.textContent = campo === 'pp' ? `Lluvia acumulada hasta +${idx.extra?.pp_horas ?? p.paso} h · flechas y costa: ${ww3Fecha(p.valido)}` : ww3Fecha(p.valido) + ' · +' + p.paso + ' h';
    pintar(); pintarCorte();
    if (ultimaConsulta && map._popup && map.hasLayer(map._popup)) consultar(ultimaConsulta.e, ultimaConsulta.nombre);
  }
  async function bajar(nombre, clave, timeout) {
    const r = await fetch(base + nombre + '?c=' + clave, { signal: AbortSignal.timeout(timeout) });
    if (!r.ok) throw Error('sin ' + nombre);
    return new Uint8Array(await r.arrayBuffer());
  }
  async function cargar() {
    try {
      const r = await fetch(base + 'ivt.json?t=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw Error('sin corrida');
      const nuevo = await r.json();
      if (!nuevo.plazos?.length) throw Error('sin plazos');
      if (idx && nuevo.clave === idx.clave && datos) return;
      const ncN = nuevo.campos.length, tamN = nuevo.nlat * nuevo.nlon;
      estado.textContent = `Cargando la corrida (≈ ${(nuevo.plazos.length * ncN * tamN / 1e6).toFixed(1).replace('.', ',')} MB)…`;
      const [b, bx, hj] = await Promise.all([
        bajar(nuevo.archivo, nuevo.clave, 90000),
        nuevo.extra ? bajar(nuevo.extra.archivo, nuevo.clave, 60000).catch(() => null) : null,
        nuevo.historial ? fetch(base + 'ivt_hist.json?c=' + nuevo.historial.clave, { signal: AbortSignal.timeout(30000) }).then(x => x.ok ? x.json() : null).catch(() => null) : null]);
      if (b.length !== nuevo.plazos.length * ncN * tamN) throw Error('tamaño inesperado');
      let h = null;
      if (hj && hj.validos?.length && hj.nlat === nuevo.nlat && hj.nlon === nuevo.nlon) {
        const hb = await bajar(hj.archivo, hj.clave, 60000).catch(() => null);
        if (hb && hb.length === hj.validos.length * ncN * tamN) h = { validos: hj.validos, datos: hb };
      }
      let x = null;
      if (bx && nuevo.extra?.corte) {
        const nPp = tamN * 2, nCo = nuevo.plazos.length * 2 * nuevo.extra.corte.niveles.length * nuevo.nlat;
        if (bx.length === nPp + nCo) x = { pp: new Uint16Array(bx.buffer.slice(0, nPp)), corte: bx.subarray(nPp) };
      }
      idx = nuevo; datos = b; extra = x; hist = h;
      selector.innerHTML = idx.plazos.map((p, k) => `<option value="${k}">${escapar(ww3Fecha(p.valido))} · +${p.paso} h</option>`).join('');
      slider.max = String(idx.plazos.length - 1);
      $('.uv-tiempo').hidden = false;
      panel.querySelector('[data-campo="pp"]').hidden = !extra; if (!extra && campo === 'pp') campo = 'ivt';
      btnCorte.hidden = !extra;
      leyenda();
      $('.uv-info').textContent = `Corrida GFS ${ww3Fecha(idx.corrida.replace(/Z$/, ':00Z'))} (hora de Chile), ${idx.plazos.length} fechas cada 3 horas hasta +${idx.plazos.at(-1).paso} h` +
        (hist ? `, más ${hist.validos.filter(v => Date.parse(v) < tPron()).length} análisis anteriores.` : '.');
      const ahora = Date.now(); let k = 0;
      idx.plazos.forEach((p, n) => { if (Math.abs(Date.parse(p.valido) - ahora) < Math.abs(Date.parse(idx.plazos[k].valido) - ahora)) k = n; });
      pintarCosta(); mostrar(k);
    } catch (e) { if (!datos) estado.textContent = 'Los ríos atmosféricos aún no están disponibles. Se calculan con la próxima corrida del GFS.'; }
  }
  panel.querySelectorAll('.ivt-campos button').forEach(b => b.onclick = () => {
    campo = b.dataset.campo; try { localStorage.setItem('ivtCampo', campo); } catch (e) { /* sin almacenamiento */ }
    leyenda(); if (idx && datos) mostrar(indice);
  });
  selCiudad.onchange = () => {
    if (!idx || !datos || selCiudad.value === '') return;
    const [nombre, la, lo] = IVT_CIUDADES[+selCiudad.value];
    let mejor = null, dm = Infinity;
    for (const [i, j] of idx.costa || []) { const lat = idx.lat0 + idx.dlat * i, lon = idx.lon0 + idx.dlon * j, d = (lat - la) ** 2 + ((lon - lo) * Math.cos(la * Math.PI / 180)) ** 2; if (d < dm) { dm = d; mejor = [lat, lon]; } }
    if (!mejor || dm > 4) { const [i, j] = celda(la, lo); mejor = [idx.lat0 + idx.dlat * i, idx.lon0 + idx.dlon * j]; }
    const ll = L.latLng(mejor[0], mejor[1]);
    map.setView(ll, Math.max(map.getZoom(), 5));
    consultar({ latlng: ll }, nombre);
    selCiudad.value = '';
  };
  selector.onchange = () => { detener(); mostrar(+selector.value); };
  slider.oninput = () => { detener(); mostrar(+slider.value); };
  $('.uv-anterior').onclick = () => { detener(); mostrar(indice - 1); };
  $('.uv-siguiente').onclick = () => { detener(); mostrar(indice + 1); };
  play.onclick = () => {
    if (timer) return detener();
    play.textContent = 'Pausa'; play.setAttribute('aria-pressed', 'true');
    timer = setInterval(() => mostrar(indice + 1), 1000);
  };
  chkFl.onchange = pintarFlechas;
  chkCo.onchange = pintarCosta;
  map.on('moveend zoomend', () => { if (activo()) pintarFlechas(); });
  map.on('popupclose', () => { ultimaConsulta = null; contenedor.classList.remove('ec-ficha'); });
  leyenda();
  // Al encender la capa se muestra el Pacífico suroriental, desde donde llegan los ríos atmosféricos
  const VISTA = L.latLngBounds([[-50, -100], [-25, -68]]);
  grupo.on('add', () => {
    panel.hidden = false; flechas.addTo(map); costaG.addTo(map); cargar();
    if (map.getBounds().getWest() > -90) map.flyToBounds(VISTA, { duration: 0.6 });
  });
  grupo.on('remove', () => { panel.hidden = true; cerrarCorte(); detener(); map.removeLayer(flechas); map.removeLayer(costaG); map.closePopup(); });
  setInterval(() => { if (activo()) cargar(); }, 30 * 60000);
  grupo.ponerZonas = fs => { zonas = fs; resumenZonas(); };
  return grupo;
}
