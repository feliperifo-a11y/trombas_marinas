/**
 * Alertas por correo de trombasmarinas.cl (Google Apps Script ligado a una planilla de Google).
 *
 * - Suscripción con doble confirmación: el sitio llama a ?accion=suscribir&correo=…, el script envía un correo con el
 *   enlace ?accion=confirmar&token=… y solo entonces el correo queda activo.
 * - Baja con un clic: cada alerta trae ?accion=baja&token=…, que borra la fila de la planilla.
 * - revisar() corre cada hora: lee el ensamble GEFS publicado en el sitio (data/trombas_prob.json) y, si alguna zona III a VI
 *   llega a probabilidad alta (≥ 50 % de los escenarios) o muy alta (≥ 80 %) en un día que aún no se avisó con ese nivel,
 *   envía un correo a cada suscriptor activo.
 *
 * Instalación: ver apps_script/INSTRUCCIONES.md. Después de pegar el código, ejecutar instalar() una vez.
 * Estimación automática: no constituye aviso. Los avisos oficiales los emite la Armada (meteoarmada.directemar.cl).
 */
const CONFIG = {
  SITIO: 'https://trombasmarinas.cl',
  PROB: 'https://trombasmarinas.cl/data/trombas_prob.json',
  OFICIAL: 'https://meteoarmada.directemar.cl',
  UMBRAL_ALTO: 50,               // % de los escenarios del ensamble (nivel alto del sitio: 50 a 79)
  UMBRAL_MUY_ALTO: 80,           // nivel muy alto del sitio: 80 o más
  VIGENCIA_H: 30,                // no se avisa con un pronóstico más antiguo que esto
  NOMBRE: 'Trombas marinas · MeteoIA',
  HOJA: 'Suscriptores',
  MAX_CONFIRMACIONES_DIA: 40,    // tope de correos de confirmación por día (protege la cuota de Gmail)
  ZONA: 'America/Santiago'
};
const NOMBRE_ZONA = { III: 'Valparaíso a Constitución', IV: 'Constitución a Isla Mocha', V: 'Isla Mocha a Puerto Montt', VI: 'Puerto Montt a San Pedro' };
const COLUMNAS = ['correo', 'estado', 'token', 'creado', 'confirmado'];

// ---------------------------------------------------------------- planilla
function hoja_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let h = ss.getSheetByName(CONFIG.HOJA);
  if (!h) { h = ss.insertSheet(CONFIG.HOJA); h.appendRow(COLUMNAS); h.setFrozenRows(1); }
  return h;
}
function filas_() {
  const h = hoja_(), n = h.getLastRow();
  if (n < 2) return [];
  return h.getRange(2, 1, n - 1, COLUMNAS.length).getValues().map((v, k) => ({ fila: k + 2, correo: String(v[0]), estado: String(v[1]), token: String(v[2]), creado: v[3] }));
}
const ahoraTxt_ = () => Utilities.formatDate(new Date(), CONFIG.ZONA, 'yyyy-MM-dd HH:mm');
const url_ = () => ScriptApp.getService().getUrl();
const esc_ = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------- web
function doGet(e) {
  const p = (e && e.parameter) || {};
  try {
    if (p.accion === 'suscribir') return json_(suscribir_(p.correo, p.web));
    if (p.accion === 'confirmar') return pagina_(confirmar_(p.token));
    if (p.accion === 'baja') return pagina_(baja_(p.token));
  } catch (err) {
    console.error(err);
    return p.accion === 'suscribir' ? json_({ ok: false, msg: 'No se pudo procesar la solicitud. Intenta más tarde.' })
      : pagina_({ titulo: 'Error', texto: 'No se pudo procesar la solicitud. Intenta más tarde.' });
  }
  return pagina_({ titulo: 'Alertas de trombas marinas', texto: 'Para suscribirte entra a trombasmarinas.cl.' });
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function pagina_(o) {
  return HtmlService.createHtmlOutput(
    `<!DOCTYPE html><meta name="viewport" content="width=device-width,initial-scale=1"><div style="font-family:system-ui,sans-serif;max-width:520px;margin:40px auto;padding:24px;border-radius:14px;background:#0b1c30;color:#e8f1fa">` +
    `<h2 style="margin-top:0">${esc_(o.titulo)}</h2><p style="line-height:1.5">${esc_(o.texto)}</p>` +
    `<p><a href="${CONFIG.SITIO}" target="_top" style="color:#5fb0ff">Ir a trombasmarinas.cl</a></p></div>`)
    .setTitle(o.titulo).addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

const MSG_REVISA = 'Te enviamos un correo para confirmar la suscripción. Revisa tu bandeja de entrada (y la de spam).';
function suscribir_(correo, trampa) {
  if (trampa) return { ok: true, msg: MSG_REVISA };                       // campo oculto lleno: robot
  correo = String(correo || '').trim().toLowerCase();
  if (correo.length > 120 || !/^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/.test(correo)) return { ok: false, msg: 'Ese correo no parece válido.' };
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    const props = PropertiesService.getScriptProperties(), hoy = Utilities.formatDate(new Date(), CONFIG.ZONA, 'yyyy-MM-dd');
    const cuenta = JSON.parse(props.getProperty('confirmaciones') || '{}');
    const enviadasHoy = cuenta.dia === hoy ? cuenta.n : 0;
    const f = filas_().find(x => x.correo === correo);
    if (f && f.estado === 'activo') return { ok: true, msg: MSG_REVISA };   // no revela quién está suscrito
    if (f && f.creado && (Date.now() - new Date(f.creado).getTime()) < 15 * 60000) return { ok: true, msg: MSG_REVISA };
    if (enviadasHoy >= CONFIG.MAX_CONFIRMACIONES_DIA) return { ok: false, msg: 'Hoy se alcanzó el máximo de suscripciones nuevas. Intenta mañana.' };
    const token = Utilities.getUuid(), h = hoja_();
    if (f) h.getRange(f.fila, 2, 1, 4).setValues([['pendiente', token, new Date(), '']]);
    else h.appendRow([correo, 'pendiente', token, new Date(), '']);
    const enlace = `${url_()}?accion=confirmar&token=${token}`;
    MailApp.sendEmail({
      to: correo, name: CONFIG.NOMBRE, subject: 'Confirma tu suscripción a las alertas de trombas marinas',
      htmlBody: marco_(`<p>Recibimos una solicitud para enviar alertas de trombas marinas de <a href="${CONFIG.SITIO}">trombasmarinas.cl</a> a este correo.</p>` +
        `<p style="margin:22px 0"><a href="${enlace}" style="background:#2f8cff;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Confirmar suscripción</a></p>` +
        `<p>Si no la pediste, ignora este mensaje: sin confirmar no te llegará nada.</p>`, ''),
      body: `Confirma tu suscripción a las alertas de trombas marinas: ${enlace}\nSi no la pediste, ignora este mensaje.`
    });
    props.setProperty('confirmaciones', JSON.stringify({ dia: hoy, n: enviadasHoy + 1 }));
    return { ok: true, msg: MSG_REVISA };
  } finally { lock.releaseLock(); }
}
function confirmar_(token) {
  const f = token && filas_().find(x => x.token === token);
  if (!f) return { titulo: 'Enlace no válido', texto: 'El enlace ya no es válido. Puedes volver a suscribirte en trombasmarinas.cl.' };
  hoja_().getRange(f.fila, 2).setValue('activo'); hoja_().getRange(f.fila, 5).setValue(new Date());
  return { titulo: 'Suscripción confirmada', texto: 'Te escribiremos cuando alguna zona entre Valparaíso y San Pedro llegue a probabilidad alta o muy alta de condiciones para trombas marinas. Cada correo trae un enlace para darte de baja.' };
}
function baja_(token) {
  const f = token && filas_().find(x => x.token === token);
  if (!f) return { titulo: 'Baja realizada', texto: 'Este correo ya no está en la lista de alertas.' };
  hoja_().deleteRow(f.fila);
  return { titulo: 'Baja realizada', texto: 'Borramos tu correo de la lista. No recibirás más alertas.' };
}

// ---------------------------------------------------------------- alertas
const fechaLarga_ = f => {
  const d = new Date(f + 'T12:00:00Z');
  const dias = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'], meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  return `${dias[d.getUTCDay()]} ${d.getUTCDate()} de ${meses[d.getUTCMonth()]}`;
};
/** Zonas y días con nivel alto o muy alto en el pronóstico publicado. */
function evaluar_(d, hoy) {
  const res = [];
  for (const f of (d.dias || []).filter(x => x >= hoy)) for (const a of d.areas || []) {
    const v = d.prob_dia && d.prob_dia[a.id] && d.prob_dia[a.id].alguno ? d.prob_dia[a.id].alguno[f] : null;
    if (v == null || v < CONFIG.UMBRAL_ALTO) continue;
    res.push({ zona: a.id, dia: f, prob: v, nivel: v >= CONFIG.UMBRAL_MUY_ALTO ? 2 : 1 });
  }
  return res;
}
function revisar() {
  const r = UrlFetchApp.fetch(CONFIG.PROB + '?t=' + Date.now(), { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) { console.warn('Pronóstico no disponible: HTTP ' + r.getResponseCode()); return; }
  const d = JSON.parse(r.getContentText());
  if (!d.generado || (Date.now() - new Date(d.generado).getTime()) > CONFIG.VIGENCIA_H * 3600e3) { console.warn('Pronóstico desactualizado: ' + d.generado); return; }
  const hoy = Utilities.formatDate(new Date(), CONFIG.ZONA, 'yyyy-MM-dd');
  const props = PropertiesService.getScriptProperties();
  const enviados = JSON.parse(props.getProperty('enviados') || '{}');      // "zona|día" -> nivel ya avisado (1 alto, 2 muy alto)
  for (const k of Object.keys(enviados)) if (k.split('|')[1] < hoy) delete enviados[k];
  const todos = evaluar_(d, hoy), nuevos = todos.filter(x => (enviados[x.zona + '|' + x.dia] || 0) < x.nivel);
  if (!nuevos.length) { props.setProperty('enviados', JSON.stringify(enviados)); return; }
  const n = enviarAlerta_(todos, nuevos, d);
  if (n > 0) for (const x of nuevos) enviados[x.zona + '|' + x.dia] = x.nivel;
  props.setProperty('enviados', JSON.stringify(enviados));
  console.log(`Alerta enviada a ${n} suscriptores: ${nuevos.map(x => x.zona + ' ' + x.dia + ' ' + x.prob + '%').join(', ')}`);
}
function contenido_(todos, nuevos, d) {
  const muyAlta = todos.some(x => x.nivel === 2);
  const asunto = `Trombas marinas: probabilidad ${muyAlta ? 'muy alta' : 'alta'} en ${[...new Set(nuevos.map(x => 'zona ' + x.zona))].join(', ')}`;
  const filas = todos.map(x => {
    const nuevo = nuevos.some(y => y.zona === x.zona && y.dia === x.dia);
    return `<tr><td style="padding:6px 10px;border-bottom:1px solid #22405f"><b>Zona ${esc_(x.zona)}</b><br><span style="color:#9fb3c8">${esc_(NOMBRE_ZONA[x.zona] || '')}</span></td>` +
      `<td style="padding:6px 10px;border-bottom:1px solid #22405f">${esc_(fechaLarga_(x.dia))}${nuevo ? ' <span style="color:#ffd400">(nuevo)</span>' : ''}</td>` +
      `<td style="padding:6px 10px;border-bottom:1px solid #22405f"><b style="color:${x.nivel === 2 ? '#ff5a5a' : '#ff9800'}">${x.nivel === 2 ? 'Muy alta' : 'Alta'}</b><br><span style="color:#9fb3c8">${x.prob} % de los escenarios</span></td></tr>`;
  }).join('');
  const html = `<p>El pronóstico automático de <a href="${CONFIG.SITIO}">trombasmarinas.cl</a> muestra condiciones propicias para trombas marinas en:</p>` +
    `<table style="border-collapse:collapse;width:100%;font-size:14px">${filas}</table>` +
    `<p style="margin:20px 0"><a href="${CONFIG.SITIO}" style="background:#2f8cff;color:#fff;padding:11px 18px;border-radius:8px;text-decoration:none;font-weight:600">Ver el mapa y el detalle</a></p>` +
    `<p style="color:#9fb3c8;font-size:13px">Probabilidad según ${d.miembros || 31} escenarios del ensamble GFS de NOAA (corrida ${esc_(d.corrida || '')}). ` +
    `Es una estimación automática y experimental: <b>no constituye aviso</b>. Los avisos oficiales los emite la Armada de Chile en <a href="${CONFIG.OFICIAL}">meteoarmada.directemar.cl</a>.</p>`;
  const texto = `Condiciones propicias para trombas marinas:\n` + todos.map(x => `- Zona ${x.zona} (${NOMBRE_ZONA[x.zona] || ''}), ${fechaLarga_(x.dia)}: ${x.nivel === 2 ? 'muy alta' : 'alta'} (${x.prob} %)`).join('\n') +
    `\n\nDetalle: ${CONFIG.SITIO}\nEstimación automática: no constituye aviso. Avisos oficiales: ${CONFIG.OFICIAL}`;
  return { asunto, html, texto };
}
function marco_(cuerpo, baja) {
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:600px;margin:0 auto;background:#0b1c30;color:#e8f1fa;padding:24px;border-radius:14px">` +
    `<div style="font-size:20px;font-weight:700;margin-bottom:12px">Trombas marinas · MeteoIA</div>${cuerpo}` +
    `<hr style="border:0;border-top:1px solid #22405f;margin:20px 0"><p style="color:#9fb3c8;font-size:12px">CF Felipe Rifo Espósito · <a href="mailto:feliperifo@gmail.com" style="color:#5fb0ff">feliperifo@gmail.com</a>${baja ? ` · <a href="${baja}" style="color:#5fb0ff">Darme de baja</a>` : ''}</p></div>`;
}
function enviarAlerta_(todos, nuevos, d) {
  const activos = filas_().filter(x => x.estado === 'activo');
  if (!activos.length) return 0;
  const { asunto, html, texto } = contenido_(todos, nuevos, d);
  const cuota = MailApp.getRemainingDailyQuota();
  let n = 0;
  for (const s of activos) {
    if (n >= cuota) break;
    const baja = `${url_()}?accion=baja&token=${s.token}`;
    try {
      MailApp.sendEmail({ to: s.correo, name: CONFIG.NOMBRE, subject: asunto, htmlBody: marco_(html, baja), body: texto + `\n\nDarme de baja: ${baja}` });
      n++;
    } catch (err) { console.error(s.correo + ': ' + err); }
  }
  if (n < activos.length) MailApp.sendEmail(Session.getEffectiveUser().getEmail(), 'Alertas de trombas: cuota de Gmail agotada',
    `Se enviaron ${n} de ${activos.length} alertas; la cuota diaria de Gmail no alcanzó para el resto.`);
  return n;
}

// ---------------------------------------------------------------- instalación y pruebas
/** Ejecutar una vez: crea la hoja y el activador horario. */
function instalar() {
  hoja_();
  for (const t of ScriptApp.getProjectTriggers()) if (t.getHandlerFunction() === 'revisar') ScriptApp.deleteTrigger(t);
  ScriptApp.newTrigger('revisar').timeBased().everyHours(1).create();
  console.log('Listo: hoja "' + CONFIG.HOJA + '" y revisión cada hora. Cuota de correos restante hoy: ' + MailApp.getRemainingDailyQuota());
}
/** Envía a tu propio correo un ejemplo de alerta (no toca la lista ni el registro de avisos). */
function probarAlerta() {
  const d = JSON.parse(UrlFetchApp.fetch(CONFIG.PROB).getContentText());
  const hoy = Utilities.formatDate(new Date(), CONFIG.ZONA, 'yyyy-MM-dd');
  let todos = evaluar_(d, hoy);
  if (!todos.length) todos = [{ zona: 'IV', dia: d.dias[d.dias.length - 1], prob: 55, nivel: 1 }];   // ejemplo si hoy no hay señal
  const { asunto, html, texto } = contenido_(todos, todos, d);
  MailApp.sendEmail({ to: Session.getEffectiveUser().getEmail(), name: CONFIG.NOMBRE, subject: '[PRUEBA] ' + asunto, htmlBody: marco_(html, CONFIG.SITIO), body: texto });
}
