// Ríos atmosféricos: transporte integrado de vapor de agua (IVT) del GFS 0,25° (data/ivt.json + data/ivt.bin, scripts/ivt.py).
// Mapa de IVT con flechas, escala de Ralph et al. (2019, BAMS 100) en las celdas costeras y gráfico de la serie al tocar un punto.
// Escala de Ralph: categoría según el IVT máximo del evento (250, 500, 750, 1000 y 1250 kg m⁻¹ s⁻¹) y su duración con
// IVT ≥ 250: baja una categoría si dura menos de 24 h y sube una si dura más de 48 h. Aquí se usa el IVT cada 3 h del GFS
// (no el promedio de 3 h del artículo) y la duración se corta al final del pronóstico (120 h).
const IVT_COLORES = [[100, 'rgba(160,200,230,0)'], [150, 'rgba(160,200,230,.35)'], [249, 'rgba(120,180,230,.6)'], [250, '#ffd400'], [400, '#ff9800'],
  [500, '#ff5a00'], [650, '#e3001b'], [750, '#b0003a'], [1000, '#7a0f7a'], [1250, '#3b0a6b']];
const IVT_CAT = [
  { n: 0, nom: 'Bajo categoría 1', col: '#7fa7c9' }, { n: 1, nom: 'Débil', col: '#ffd400' }, { n: 2, nom: 'Moderado', col: '#ff9800' },
  { n: 3, nom: 'Fuerte', col: '#e3001b' }, { n: 4, nom: 'Extremo', col: '#9c1aa3' }, { n: 5, nom: 'Excepcional', col: '#3b0a6b' }];
function ivtRgba(v) {
  if (!(v >= IVT_COLORES[0][0])) return null;
  const par = x => x.startsWith('#') ? [1, 3, 5].map(k => parseInt(x.substr(k, 2), 16)).concat(1) : x.match(/[\d.]+/g).map(Number);
  let i = 1; while (i < IVT_COLORES.length - 1 && v > IVT_COLORES[i][0]) i++;
  const [v0, a] = IVT_COLORES[i - 1], [v1, b] = IVT_COLORES[i];
  if (v0 === 249) return par(b);                              // corte nítido en 250 (inicio de condiciones de río atmosférico)
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
function crearCapaIVT(L, map, escapar, contenedor, base) {
  base = base || 'data/';
  const grupo = L.layerGroup(), flechas = L.layerGroup(), costaG = L.layerGroup();
  if (!map.getPane('ivtPane')) map.createPane('ivtPane').style.zIndex = 403;
  if (!map.getPane('ivtFlechaPane')) { const p = map.createPane('ivtFlechaPane'); p.style.zIndex = 406; p.style.pointerEvents = 'none'; }
  // Los puntos costeros van en SVG con el panel transparente a los clics: un lienzo cubriría el mapa y taparía la consulta del IVT
  if (!map.getPane('ivtCostaPane')) { const p = map.createPane('ivtCostaPane'); p.style.zIndex = 409; p.style.pointerEvents = 'none'; }
  const rendCosta = L.svg({ pane: 'ivtCostaPane' });
  const panel = document.createElement('section'); panel.className = 'uv-panel ivt-panel'; panel.hidden = true;
  panel.setAttribute('aria-label', 'Control de ríos atmosféricos');
  const grad = IVT_COLORES.slice(1).map(([v, c]) => `${c} ${Math.round((v - 150) / (1400 - 150) * 100)}%`).join(',');
  panel.innerHTML = '<div class="uv-cab"><b>Ríos atmosféricos · IVT</b><a href="https://www.nco.ncep.noaa.gov/pmb/products/gfs/" target="_blank" rel="noopener noreferrer">Fuente GFS ↗</a></div>' +
    '<p class="uv-estado" role="status">Cargando corrida…</p><div class="uv-tiempo" hidden><label>Fecha del pronóstico (hora de Chile)' +
    '<select aria-label="Fecha del pronóstico de IVT"></select></label>' +
    '<div class="uv-botones"><button type="button" class="uv-anterior" aria-label="Fecha anterior">◀</button><button type="button" class="uv-play">Reproducir</button><button type="button" class="uv-siguiente" aria-label="Fecha siguiente">▶</button></div>' +
    '<input class="uv-slider" type="range" min="0" step="1" value="0" aria-label="Avance de la corrida GFS">' +
    `<div class="uv-escala" style="background:linear-gradient(90deg,${grad})" aria-label="Escala de IVT de 150 a 1250 kg por metro por segundo o más"></div>` +
    '<div class="uv-marcas"><span>150</span><span>250</span><span>500</span><span>750</span><span>1000</span><span>1250+</span></div>' +
    '<label class="ww3-op"><input type="checkbox" class="ivt-chk-fl" checked> Flechas del transporte (IVT ≥ 250)</label>' +
    '<label class="ww3-op"><input type="checkbox" class="ivt-chk-co" checked> Escala de Ralph en la costa (próximos 5 días)</label>' +
    '<div class="ivt-zonas"></div>' +
    '<p class="uv-ayuda">IVT en kg m⁻¹ s⁻¹. Desde 250 hay condiciones de río atmosférico. Toca el mapa para ver la serie y la categoría del evento en ese punto.</p>' +
    '<details><summary>Cómo se calcula</summary><p class="uv-info"></p><p>IVT = (1/g) ∫ q·V dp, de la superficie a 300 hPa, con la humedad específica y el viento del GFS 0,25° en 17 niveles. ' +
    'Escala de Ralph et al. (2019, BAMS 100): categoría 1 a 5 según el IVT máximo del evento (250, 500, 750, 1000 y 1250) y su duración con IVT ≥ 250; ' +
    'baja una categoría si dura menos de 24 h y sube una si dura más de 48 h. Aquí se usa el IVT cada 3 h y la duración se corta al final del pronóstico. ' +
    'En Chile los ríos atmosféricos aportan cerca de la mitad de la lluvia anual entre 32° y 47° S (Viale et al., 2018, J. Hydrometeor. 19). Estimación automática: no constituye aviso.</p></details></div>';
  contenedor.appendChild(panel);
  L.DomEvent.disableClickPropagation(panel); L.DomEvent.disableScrollPropagation(panel);
  const estado = panel.querySelector('.uv-estado'), selector = panel.querySelector('select'), slider = panel.querySelector('.uv-slider'), play = panel.querySelector('.uv-play');
  const chkFl = panel.querySelector('.ivt-chk-fl'), chkCo = panel.querySelector('.ivt-chk-co'), cajaZonas = panel.querySelector('.ivt-zonas');
  let idx = null, datos = null, indice = 0, timer = null, overlay = null, zonas = null;
  const activo = () => map.hasLayer(grupo);
  const detener = () => { clearInterval(timer); timer = null; play.textContent = 'Reproducir'; play.setAttribute('aria-pressed', 'false'); };
  const tam = () => idx.nlat * idx.nlon;
  function val(n, c, i, j) { const b = datos[(n * 2 + c) * tam() + i * idx.nlon + j]; return b === idx.sin_dato ? NaN : c === 0 ? b * 10 : b * 2; }
  const serieEn = (i, j) => idx.plazos.map((p, n) => ({ t: Date.parse(p.valido), ivt: val(n, 0, i, j), dir: val(n, 1, i, j) }));
  function ivtEn(lat, lon) {
    const fi = (idx.lat0 - lat) / -idx.dlat, fj = (lon - idx.lon0) / idx.dlon, i0 = Math.floor(fi), j0 = Math.floor(fj);
    if (i0 < 0 || j0 < 0 || i0 >= idx.nlat - 1 || j0 >= idx.nlon - 1) return NaN;
    const ti = fi - i0, tj = fj - j0; let s = 0, w = 0;
    for (const [di, dj, p] of [[0, 0, (1 - ti) * (1 - tj)], [0, 1, (1 - ti) * tj], [1, 0, ti * (1 - tj)], [1, 1, ti * tj]]) {
      const v = val(indice, 0, i0 + di, j0 + dj); if (!isNaN(v)) { s += v * p; w += p; }
    }
    return w > 0.25 ? s / w : NaN;
  }
  function pintar() {
    const latN = idx.lat0, latS = idx.lat0 + idx.dlat * (idx.nlat - 1), lonW = idx.lon0, lonE = idx.lon0 + idx.dlon * (idx.nlon - 1);
    const merc = la => Math.log(Math.tan(Math.PI / 4 + la * Math.PI / 360)), yN = merc(latN), yS = merc(latS);
    const W = idx.nlon * 6, H = Math.round(W * (yN - yS) / ((lonE - lonW) * Math.PI / 180));
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d'), img = ctx.createImageData(W, H), px = img.data;
    for (let y = 0; y < H; y++) {
      const lat = Math.atan(Math.sinh(yN - (y + 0.5) / H * (yN - yS))) * 180 / Math.PI;
      for (let x = 0; x < W; x++) {
        const c = ivtRgba(ivtEn(lat, lonW + (x + 0.5) / W * (lonE - lonW))); if (!c) continue;
        const o = (y * W + x) * 4; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = Math.round(c[3] * 255);
      }
    }
    ctx.putImageData(img, 0, 0);
    if (overlay) grupo.removeLayer(overlay);
    overlay = L.imageOverlay(cv.toDataURL('image/png'), [[latS, lonW], [latN, lonE]], { pane: 'ivtPane', opacity: 0.8, interactive: true, bubblingMouseEvents: false,
      attribution: 'IVT: NOAA GFS' }).on('click', consultar).addTo(grupo);
    pintarFlechas();
  }
  function pintarFlechas() {
    flechas.clearLayers();
    if (!idx || !datos || !activo() || !chkFl.checked) return;
    const b = map.getBounds().pad(0.05), paso = Math.max(1, Math.round(44 / (256 * Math.pow(2, map.getZoom()) * idx.dlon / 360)));
    for (let i = 0; i < idx.nlat; i += paso) {
      const lat = idx.lat0 + idx.dlat * i; if (lat < b.getSouth() || lat > b.getNorth()) continue;
      for (let j = 0; j < idx.nlon; j += paso) {
        const lon = idx.lon0 + idx.dlon * j; if (lon < b.getWest() || lon > b.getEast()) continue;
        const v = val(indice, 0, i, j), d = val(indice, 1, i, j); if (!(v >= 250) || isNaN(d)) continue;
        const largo = 10 + Math.min(v, 1000) / 1000 * 14;
        L.marker([lat, lon], { pane: 'ivtFlechaPane', interactive: false, keyboard: false, icon: L.divIcon({ className: 'ww3-flecha ivt-flecha', iconSize: [0, 0],
          html: `<svg width="30" height="30" viewBox="-15 -15 30 30" style="transform:rotate(${d}deg)"><path d="M0 ${largo / 2}V${-largo / 2}M-4 ${-largo / 2 + 5}L0 ${-largo / 2}L4 ${-largo / 2 + 5}" /></svg>` }) }).addTo(flechas);
      }
    }
  }
  const fecha = t => ww3Fecha(new Date(t).toISOString());
  const nomCat = c => IVT_CAT[c].nom + (c ? ` (categoría ${c})` : '');
  // Escala de Ralph en las celdas costeras: el evento de mayor categoría de los próximos 5 días
  let resCosta = [];
  function pintarCosta() {
    costaG.clearLayers(); resCosta = [];
    if (!idx || !datos) return;
    for (const [i, j] of idx.costa || []) {
      const ev = ivtEventos(serieEn(i, j)); if (!ev.length) continue;
      const e = ev.reduce((a, b) => b.cat > a.cat || (b.cat === a.cat && b.max > a.max) ? b : a);
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
    if (!zonas) { cajaZonas.innerHTML = ''; return; }
    const filas = zonas.map(z => {
      const enZ = resCosta.filter(r => enPoligono(z, r.lat, r.lon) || [0.5, -0.5, 1, -1].some(d => enPoligono(z, r.lat, r.lon + d)));
      const m = enZ.reduce((a, b) => !a || b.e.cat > a.e.cat || (b.e.cat === a.e.cat && b.e.max > a.e.max) ? b : a, null);
      const id = z.properties.id;
      return m ? `<li><b>${escapar(id)}</b> <i style="background:${IVT_CAT[m.e.cat].col}"></i>${escapar(nomCat(m.e.cat))} · ${escapar(fecha(m.e.ini))}</li>`
        : `<li><b>${escapar(id)}</b> <i style="background:transparent;border:1px solid #5d7a96"></i>Sin condiciones de río atmosférico</li>`;
    });
    cajaZonas.innerHTML = `<p class="ivt-zt">Máximo en la costa de cada zona, próximos 5 días</p><ul>${filas.join('')}</ul>`;
  }
  function consultar(e) {
    const { lat, lng } = e.latlng;
    const i = Math.round((idx.lat0 - lat) / -idx.dlat), j = Math.round((lng - idx.lon0) / idx.dlon);
    if (i < 0 || j < 0 || i >= idx.nlat || j >= idx.nlon) return;
    const v = val(indice, 0, i, j), d = val(indice, 1, i, j); if (isNaN(v)) return;
    const S = serieEn(i, j), ev = ivtEventos(S), tSel = Date.parse(idx.plazos[indice].valido);
    const ahora = ev.find(x => x.ini <= tSel && tSel <= x.fin), mayor = ev.length ? ev.reduce((a, b) => b.cat > a.cat || (b.cat === a.cat && b.max > a.max) ? b : a) : null;
    const txtEv = x => `<b style="color:${IVT_CAT[x.cat].col}">${escapar(nomCat(x.cat))}</b>: máx. ${Math.round(x.max)} kg m⁻¹ s⁻¹, ${x.dur} h${x.abierto ? ' o más (sigue al final del pronóstico)' : ''} con IVT ≥ 250, ${escapar(fecha(x.ini))} a ${escapar(fecha(x.fin))}`;
    L.popup({ className: 'uv-popup', maxWidth: 330, autoPanPaddingTopLeft: [10, 10] }).setLatLng(e.latlng).setContent(
      `<div class="uv-ficha"><b>Río atmosférico · IVT</b> · ${escapar(ww3Fecha(idx.plazos[indice].valido))}` +
      `<p>IVT<br><strong>${Math.round(v)}</strong> kg m⁻¹ s⁻¹ ${isNaN(d) ? '' : 'hacia el ' + ww3Rumbo(d)}${v >= 250 ? ' · <b>condiciones de río atmosférico</b>' : ''}</p>` +
      `<p>${ahora ? 'Evento en curso: ' + txtEv(ahora) : mayor ? 'Mayor evento de los próximos días: ' + txtEv(mayor) : 'Sin condiciones de río atmosférico (IVT ≥ 250) en los próximos 5 días.'}</p>` +
      `<div class="ec-evol"><b>Próximos días</b>${grafico(S, tSel)}</div>` +
      `<small>${Math.abs(idx.lat0 + idx.dlat * i).toFixed(1)}° S · ${Math.abs(idx.lon0 + idx.dlon * j).toFixed(1)}° W · celda de 0,5°. Escala de Ralph et al. (2019) con el IVT cada 3 h.</small></div>`).openOn(map);
  }
  function grafico(S, tSel) {
    const W = 300, H = 150, iz = 32, de = 6, ar = 18, ab = 20, w = W - iz - de, h = H - ar - ab;
    const t0 = S[0].t, t1 = S[S.length - 1].t, vmax = Math.max(...S.map(s => s.ivt).filter(x => !isNaN(x)));
    const ymax = Math.max(500, Math.ceil(vmax / 250) * 250), X = t => iz + (t - t0) / (t1 - t0) * w, Y = v => ar + h - v / ymax * h;
    let g = '';
    for (let v = 0; v <= ymax; v += 250) g += `<line x1="${iz}" x2="${W - de}" y1="${Y(v)}" y2="${Y(v)}" stroke="${v ? IVT_CAT[Math.min(5, v / 250)].col : '#2c4560'}" stroke-width="${v ? .8 : .6}"${v ? ' stroke-dasharray="3 3"' : ''}/><text x="${iz - 3}" y="${Y(v) + 3}" text-anchor="end">${v}</text>`;
    const dia = t => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
    let dd = dia(t0);
    for (let t = t0; t <= t1; t += 3600e3) { const x = dia(t); if (x !== dd) { dd = x; g += `<line x1="${X(t)}" x2="${X(t)}" y1="${ar}" y2="${ar + h}" stroke="#5d7a96" stroke-width=".7"/><text x="${X(t) + 2}" y="${H - 6}">${new Date(t).toLocaleDateString('es-CL', { timeZone: 'America/Santiago', weekday: 'short', day: 'numeric' }).replace('.', '')}</text>`; } }
    S.forEach((s, n) => { if (n % 4 || isNaN(s.dir) || !(s.ivt >= 100)) return; g += `<g transform="translate(${X(s.t)},9) rotate(${s.dir})"><path d="M0 5V-5M-3 -1L0 -5L3 -1" fill="none" stroke="#c9d9ea" stroke-width="1.3" stroke-linecap="round"/></g>`; });
    if (tSel >= t0 && tSel <= t1) g += `<line x1="${X(tSel)}" x2="${X(tSel)}" y1="${ar}" y2="${ar + h}" stroke="#2f8cff" stroke-width="1.2"/>`;
    const linea = S.filter(s => !isNaN(s.ivt)).map((s, n) => `${n ? 'L' : 'M'}${X(s.t).toFixed(1)},${Y(s.ivt).toFixed(1)}`).join('');
    return `<svg class="ec-graf" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Evolución del IVT en el punto">${g}<path d="${linea}" fill="none" stroke="#4fb3ff" stroke-width="2"/></svg>` +
      `<div class="ec-ley"><span><i style="background:#4fb3ff"></i>IVT (kg m⁻¹ s⁻¹)</span><span>Líneas: 250, 500, 750, 1000 y 1250</span> · hora de Chile</div>`;
  }
  function mostrar(n) {
    if (!idx || !datos || !activo()) return;
    indice = (n + idx.plazos.length) % idx.plazos.length;
    const p = idx.plazos[indice]; selector.value = String(indice); slider.value = String(indice);
    estado.textContent = ww3Fecha(p.valido) + ' · +' + p.paso + ' h';
    pintar(); map.closePopup();
  }
  async function cargar() {
    try {
      const r = await fetch(base + 'ivt.json?t=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw Error('sin corrida');
      const nuevo = await r.json();
      if (!nuevo.plazos?.length) throw Error('sin plazos');
      if (idx && nuevo.clave === idx.clave && datos) return;
      estado.textContent = 'Cargando la corrida (≈ 0,5 MB)…';
      const rb = await fetch(base + nuevo.archivo + '?c=' + nuevo.clave, { signal: AbortSignal.timeout(60000) });
      if (!rb.ok) throw Error('sin binario');
      const b = new Uint8Array(await rb.arrayBuffer());
      if (b.length !== nuevo.plazos.length * 2 * nuevo.nlat * nuevo.nlon) throw Error('tamaño inesperado');
      idx = nuevo; datos = b;
      selector.innerHTML = idx.plazos.map((p, k) => `<option value="${k}">${escapar(ww3Fecha(p.valido))} · +${p.paso} h</option>`).join('');
      slider.max = String(idx.plazos.length - 1);
      panel.querySelector('.uv-tiempo').hidden = false;
      panel.querySelector('.uv-info').textContent = `Corrida GFS ${ww3Fecha(idx.corrida.replace(/Z$/, ':00Z'))} (hora de Chile), ${idx.plazos.length} fechas cada 3 horas hasta +${idx.plazos.at(-1).paso} h.`;
      const ahora = Date.now(); let k = 0;
      idx.plazos.forEach((p, n) => { if (Math.abs(Date.parse(p.valido) - ahora) < Math.abs(Date.parse(idx.plazos[k].valido) - ahora)) k = n; });
      pintarCosta(); mostrar(k);
    } catch (e) { if (!datos) estado.textContent = 'Los ríos atmosféricos aún no están disponibles. Se calculan con la próxima corrida del GFS.'; }
  }
  selector.onchange = () => { detener(); mostrar(+selector.value); };
  slider.oninput = () => { detener(); mostrar(+slider.value); };
  panel.querySelector('.uv-anterior').onclick = () => { detener(); mostrar(indice - 1); };
  panel.querySelector('.uv-siguiente').onclick = () => { detener(); mostrar(indice + 1); };
  play.onclick = () => {
    if (timer) return detener();
    play.textContent = 'Pausa'; play.setAttribute('aria-pressed', 'true');
    timer = setInterval(() => mostrar(indice + 1), 1000);
  };
  chkFl.onchange = pintarFlechas;
  chkCo.onchange = pintarCosta;
  map.on('moveend zoomend', () => { if (activo()) pintarFlechas(); });
  // Al encender la capa se muestra el Pacífico suroriental, desde donde llegan los ríos atmosféricos
  const VISTA = L.latLngBounds([[-50, -100], [-25, -68]]);
  grupo.on('add', () => {
    panel.hidden = false; flechas.addTo(map); costaG.addTo(map); cargar();
    if (map.getBounds().getWest() > -90) map.flyToBounds(VISTA, { duration: 0.6 });
  });
  grupo.on('remove', () => { panel.hidden = true; detener(); map.removeLayer(flechas); map.removeLayer(costaG); map.closePopup(); });
  setInterval(() => { if (activo()) cargar(); }, 30 * 60000);
  grupo.ponerZonas = fs => { zonas = fs; resumenZonas(); };
  return grupo;
}
