/* Portal del pronóstico de riesgo meteorológico (Cloudflare Worker).
   - Sirve las páginas solo a usuarios con sesión (número de usuario + clave).
   - Guarda usuarios, sesiones, emisiones y registro de accesos en Workers KV (binding RIESGO).
   - Administrador inicial: secretos ADMIN_USUARIO y ADMIN_CLAVE (no se guardan en KV).
   Roles: "cliente" (ve emisiones y descarga), "editor" (además emite), "admin" (además administra usuarios). */

const SESION_H = 12;                 // duración de la sesión
const MAX_FALLOS = 5, BLOQUEO_MIN = 15;
const ITER = 10000;                  // PBKDF2-SHA256 (límite de CPU del plan gratuito)
const PUBLICOS = new Set(["/login", "/login.html", "/riesgo.css", "/apoyomet.png", "/robots.txt"]);
const COOKIE = "riesgo_sesion";

export default {
  async scheduled(event, env, ctx) {      // cada 3 horas: observaciones METAR para la verificación
    ctx.waitUntil(actualizarObs(env, 30));
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p.startsWith("/api/")) return await api(req, env, url);
      if (PUBLICOS.has(p) || p.startsWith("/assets/")) return env.ASSETS.fetch(req);
      const ses = await sesion(req, env);
      if (!ses) return Response.redirect(new URL("/login", url).toString(), 302);
      if ((p === "/editor.html" || p === "/editor") && !["editor", "admin"].includes(ses.rol))
        return Response.redirect(new URL("/", url).toString(), 302);
      const r = await env.ASSETS.fetch(req);
      const h = new Headers(r.headers); h.set("Cache-Control", "no-store");
      return new Response(r.body, { status: r.status, headers: h });
    } catch (e) {
      return json({ error: "Error interno: " + (e && e.message || e) }, 500);
    }
  }
};

/* ---------------- utilidades ---------------- */
function json(o, status = 200, extra = {}) {
  return new Response(JSON.stringify(o), { status, headers: Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, extra) });
}
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
function nuevaSal() { return b64(crypto.getRandomValues(new Uint8Array(16))); }
function rnd(n) { return b64(crypto.getRandomValues(new Uint8Array(n))).replace(/[+/=]/g, "").slice(0, n); }
async function hashClave(clave, saltB64, iter = ITER) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(clave), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: unb64(saltB64), iterations: iter, hash: "SHA-256" }, k, 256);
  return b64(bits);
}
function igual(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
function cookieDe(req) { const m = (req.headers.get("Cookie") || "").match(new RegExp("(?:^|;\\s*)" + COOKIE + "=([^;]+)")); return m ? m[1] : null; }
function ip(req) { return req.headers.get("CF-Connecting-IP") || "local"; }
const usuarioValido = u => /^[A-Za-z0-9._-]{2,32}$/.test(u || "");

async function sesion(req, env) {
  const t = cookieDe(req); if (!t) return null;
  const s = await env.RIESGO.get("sess:" + t, "json"); if (!s) return null;
  if (s.rol !== "admin") {                        // usuario dado de baja: la sesión deja de servir
    const u = await env.RIESGO.get("user:" + s.usuario, "json");
    if (!u || !u.activo) { await env.RIESGO.delete("sess:" + t); return null; }
    s.rol = u.rol; s.ciudades = u.ciudades || []; s.nombre = u.nombre || "";
  }
  s.token = t; return s;
}
async function registrar(env, ev) {
  const k = "log:indice";
  const l = (await env.RIESGO.get(k, "json")) || [];
  l.push(Object.assign({ t: new Date().toISOString() }, ev));
  await env.RIESGO.put(k, JSON.stringify(l.slice(-500)));
}
function filtrar(snap, ses) {
  if (!ses.ciudades || !ses.ciudades.length) return snap;
  const ok = new Set(ses.ciudades), s = Object.assign({}, snap);
  s.sites = snap.sites.filter(x => ok.has(x.id));
  s.cells = Object.fromEntries(Object.entries(snap.cells).filter(([k]) => ok.has(k)));
  return s;
}

/* ---------------- API ---------------- */
async function api(req, env, url) {
  const p = url.pathname, m = req.method;
  if (m !== "GET" && m !== "POST" && m !== "DELETE") return json({ error: "Método no permitido" }, 405);
  if (m !== "GET") {                              // protección CSRF básica: mismo origen
    const o = req.headers.get("Origin");
    if (o && o !== url.origin) return json({ error: "Origen no permitido" }, 403);
  }

  if (p === "/api/login" && m === "POST") return login(req, env);
  if (p === "/api/logout" && m === "POST") {
    const t = cookieDe(req); if (t) await env.RIESGO.delete("sess:" + t);
    return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` });
  }

  const ses = await sesion(req, env);
  if (!ses) return json({ error: "Sesión no válida o vencida" }, 401);
  const esEditor = ["editor", "admin"].includes(ses.rol), esAdmin = ses.rol === "admin";

  if (p === "/api/sesion") return json({ usuario: ses.usuario, nombre: ses.nombre, rol: ses.rol, ciudades: ses.ciudades || [] });

  if (p === "/api/clave" && m === "POST") {       // cambio de la propia clave
    if (esAdmin) return json({ error: "La clave del administrador se cambia en los secretos de Cloudflare" }, 400);
    const b = await req.json(); const u = await env.RIESGO.get("user:" + ses.usuario, "json");
    if (!u || !igual(await hashClave(b.actual || "", u.salt, u.iter || ITER), u.hash)) return json({ error: "La clave actual no es correcta" }, 400);
    if ((b.nueva || "").length < 6) return json({ error: "La clave nueva debe tener al menos 6 caracteres" }, 400);
    u.salt = nuevaSal(); u.iter = ITER; u.hash = await hashClave(b.nueva, u.salt); u.modificado = new Date().toISOString();
    await env.RIESGO.put("user:" + ses.usuario, JSON.stringify(u));
    return json({ ok: true });
  }

  /* emisiones */
  if (p === "/api/emisiones" && m === "GET") {
    const idx = (await env.RIESGO.get("emis:indice", "json")) || [];
    return json(idx.slice().reverse());
  }
  if (p === "/api/emisiones/actual" && m === "GET") {
    const id = await env.RIESGO.get("emis:actual"); if (!id) return json({ error: "Todavía no hay pronósticos emitidos" }, 404);
    const snap = await env.RIESGO.get("emis:" + id, "json"); if (!snap) return json({ error: "Emisión no encontrada" }, 404);
    return json(filtrar(snap, ses));
  }
  if (p.startsWith("/api/emisiones/") && m === "GET") {
    const id = decodeURIComponent(p.slice(15)); if (!/^[0-9A-Z]{8,20}$/.test(id)) return json({ error: "Identificador no válido" }, 400);
    const snap = await env.RIESGO.get("emis:" + id, "json"); if (!snap) return json({ error: "Emisión no encontrada" }, 404);
    return json(filtrar(snap, ses));
  }
  if (p === "/api/emisiones" && m === "POST") {
    if (!esEditor) return json({ error: "Solo el equipo editor puede emitir" }, 403);
    const snap = await req.json();
    if (!snap || !Array.isArray(snap.dates) || !Array.isArray(snap.sites) || !snap.cells) return json({ error: "Emisión incompleta" }, 400);
    const now = new Date(), id = now.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
    snap.id = id; snap.emitido = now.toISOString(); snap.por = ses.nombre || ses.usuario; snap.porUsuario = ses.usuario;
    const txt = JSON.stringify(snap); if (txt.length > 5e6) return json({ error: "Emisión demasiado grande" }, 413);
    await env.RIESGO.put("emis:" + id, txt);
    const idx = (await env.RIESGO.get("emis:indice", "json")) || [];
    idx.push({ id, fecha: snap.emision && snap.emision.fecha, hora: snap.emision && snap.emision.hora, desde: snap.dates[0], hasta: snap.dates[snap.dates.length - 1], n: snap.sites.length, por: snap.por });
    await env.RIESGO.put("emis:indice", JSON.stringify(idx.slice(-500)));
    await env.RIESGO.put("emis:actual", id);
    await registrar(env, { ev: "emision", usuario: ses.usuario, id });
    return json({ ok: true, id });
  }

  /* verificación pronóstico vs. observado (equipo editor) */
  if (p === "/api/verificacion" && m === "GET") {
    if (!esEditor) return json({ error: "Solo el equipo editor" }, 403);
    const dias = Math.min(60, Math.max(1, +(url.searchParams.get("dias") || 14)));
    return json(await verificacion(env, dias));
  }
  if (p === "/api/verificacion/actualizar" && m === "POST") {
    if (!esAdmin) return json({ error: "Solo el administrador" }, 403);
    const r = await actualizarObs(env, 168);
    await registrar(env, { ev: "obs_actualizadas", usuario: ses.usuario, sobre: `${r.metar} METAR, ${r.fechas} días` });
    return json(r);
  }

  /* administración de usuarios */
  if (p === "/api/usuarios" && m === "GET") {
    if (!esAdmin) return json({ error: "Solo el administrador" }, 403);
    const out = []; let cursor;
    do {
      const l = await env.RIESGO.list({ prefix: "user:", cursor });
      for (const k of l.keys) { const u = await env.RIESGO.get(k.name, "json"); if (u) out.push({ usuario: u.usuario, nombre: u.nombre, rol: u.rol, ciudades: u.ciudades || [], activo: u.activo, creado: u.creado, ultimo: u.ultimo || null }); }
      cursor = l.list_complete ? null : l.cursor;
    } while (cursor);
    out.sort((a, b) => a.usuario.localeCompare(b.usuario, "es", { numeric: true }));
    return json(out);
  }
  if (p === "/api/usuarios" && m === "POST") {
    if (!esAdmin) return json({ error: "Solo el administrador" }, 403);
    const b = await req.json();
    if (!usuarioValido(b.usuario)) return json({ error: "Usuario no válido: use 2 a 32 letras, números, punto, guion o guion bajo" }, 400);
    if (b.usuario === env.ADMIN_USUARIO) return json({ error: "Ese número está reservado para el administrador" }, 400);
    const k = "user:" + b.usuario, prev = await env.RIESGO.get(k, "json");
    if (!prev && !(b.clave && b.clave.length >= 6)) return json({ error: "Un usuario nuevo necesita una clave de al menos 6 caracteres" }, 400);
    if (b.clave && b.clave.length < 6) return json({ error: "La clave debe tener al menos 6 caracteres" }, 400);
    const rol = ["cliente", "editor"].includes(b.rol) ? b.rol : "cliente";
    const u = Object.assign(prev || { usuario: b.usuario, creado: new Date().toISOString() },
      { nombre: String(b.nombre || "").slice(0, 80), rol, ciudades: Array.isArray(b.ciudades) ? b.ciudades.slice(0, 100) : [], activo: b.activo !== false, modificado: new Date().toISOString() });
    if (b.clave) { u.salt = nuevaSal(); u.iter = ITER; u.hash = await hashClave(b.clave, u.salt); }
    await env.RIESGO.put(k, JSON.stringify(u));
    await registrar(env, { ev: prev ? "usuario_editado" : "usuario_creado", usuario: ses.usuario, sobre: b.usuario });
    return json({ ok: true });
  }
  if (p.startsWith("/api/usuarios/") && m === "DELETE") {
    if (!esAdmin) return json({ error: "Solo el administrador" }, 403);
    const u = decodeURIComponent(p.slice(14)); await env.RIESGO.delete("user:" + u);
    await registrar(env, { ev: "usuario_eliminado", usuario: ses.usuario, sobre: u });
    return json({ ok: true });
  }
  if (p === "/api/accesos" && m === "GET") {
    if (!esAdmin) return json({ error: "Solo el administrador" }, 403);
    const l = (await env.RIESGO.get("log:indice", "json")) || [];
    return json(l.slice().reverse().slice(0, 300));
  }
  return json({ error: "No encontrado" }, 404);
}

async function login(req, env) {
  let b; try { b = await req.json(); } catch (e) { return json({ error: "Solicitud no válida" }, 400); }
  const usuario = String(b.usuario || "").trim(), clave = String(b.clave || "");
  if (!usuarioValido(usuario) || !clave) return json({ error: "Ingrese usuario y clave" }, 400);
  const kf = "fail:" + usuario, kfi = "failip:" + ip(req);
  const f = (await env.RIESGO.get(kf, "json")) || { n: 0 }, fi = (await env.RIESGO.get(kfi, "json")) || { n: 0 };
  if (f.n >= MAX_FALLOS || fi.n >= MAX_FALLOS * 4) return json({ error: `Demasiados intentos fallidos. Espere ${BLOQUEO_MIN} minutos.` }, 429);

  let ok = false, perfil = null;
  if (env.ADMIN_USUARIO && env.ADMIN_CLAVE && usuario === env.ADMIN_USUARIO) {
    const s = "YWRtaW4tc2FsLWZpamE=";                          // comparación de hashes en tiempo constante
    ok = igual(await hashClave(clave, s, 1000), await hashClave(env.ADMIN_CLAVE, s, 1000));
    perfil = { usuario, nombre: "Administrador", rol: "admin", ciudades: [] };
  } else {
    const u = await env.RIESGO.get("user:" + usuario, "json");
    if (u && u.activo) {
      ok = igual(await hashClave(clave, u.salt, u.iter || ITER), u.hash);
      perfil = { usuario, nombre: u.nombre || "", rol: u.rol, ciudades: u.ciudades || [] };
      if (ok) { u.ultimo = new Date().toISOString(); await env.RIESGO.put("user:" + usuario, JSON.stringify(u)); }
    } else await hashClave(clave, "c2FsLWZhbHNh");           // mismo tiempo de respuesta si el usuario no existe
  }
  if (!ok) {
    await env.RIESGO.put(kf, JSON.stringify({ n: f.n + 1 }), { expirationTtl: BLOQUEO_MIN * 60 });
    await env.RIESGO.put(kfi, JSON.stringify({ n: fi.n + 1 }), { expirationTtl: BLOQUEO_MIN * 60 });
    await registrar(env, { ev: "fallo", usuario, ip: ip(req) });
    return json({ error: "Usuario o clave incorrectos" }, 401);
  }
  if (f.n) await env.RIESGO.delete(kf);
  const token = rnd(40);
  await env.RIESGO.put("sess:" + token, JSON.stringify(Object.assign({ creado: new Date().toISOString() }, perfil)), { expirationTtl: SESION_H * 3600 });
  await registrar(env, { ev: "ingreso", usuario, ip: ip(req) });
  return json(perfil, 200, { "Set-Cookie": `${COOKIE}=${token}; Path=/; Max-Age=${SESION_H * 3600}; HttpOnly; Secure; SameSite=Strict` });
}


/* ================= Verificación con estaciones METAR ================= */
/* Estación con METAR más cercana a cada punto (verificada con aviationweather.gov, nov-2026).
   ◐ = reporta solo parte del día. */
const ESTACIONES = {
  arica:["SCAR","Chacalluta",14], iquique:["SCDA","Diego Aracena",34], calama:["SCCF","El Loa",6],
  antofagasta:["SCFA","Cerro Moreno",23], copiapo:["SCAT","Desierto de Atacama",45], laserena:["SCSE","La Florida",6],
  santiago:["SCTB","Tobalaba ◐",9], talcahuano:["SCIE","Carriel Sur",2], losangeles:["SCGE","María Dolores ◐",10],
  barranquilla:["SKBQ","Ernesto Cortissoz",16], cartagena:["SKCG","Rafael Núñez",4], manizales:["SKMZ","La Nubia ◐",5],
  bogota:["SKBO","El Dorado",11], cali:["SKCL","Alfonso Bonilla Aragón",24], trujillo:["SPRU","Martínez de Pinillos",7],
  lima_comas:["SPJC","Jorge Chávez",10], callao_bv:["SPJC","Jorge Chávez",5], lima_surq:["SPJC","Jorge Chávez",15],
  lima_sjm:["SPJC","Jorge Chávez",20], lima_smig:["SPJC","Jorge Chávez",7], callao_cc:["SPJC","Jorge Chávez",3],
  arequipa:["SPQU","Rodríguez Ballón",7], piura:["SPUR","Concha Ibérico",3], huancayo:["SPJJ","Jauja ◐",42],
  chiclayo:["SPHI","Quiñones",2], huanuco:["SPNC","Figueroa Fernandini ◐",8], cajamarca:["SPJR","Revoredo",3]
};
const TZ_EST = c => c.startsWith("SC") ? "America/Santiago" : c.startsWith("SK") ? "America/Bogota" : "America/Lima";
const KT = 1.852;
function fechaLocal(epochS, tz) { return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(epochS * 1000)); }

async function actualizarObs(env, horas) {
  const ids = [...new Set(Object.values(ESTACIONES).map(e => e[0]))];
  const base = env.METAR_URL || "https://aviationweather.gov/api/data/metar";
  const r = await fetch(`${base}?ids=${ids.join(",")}&hours=${horas}&format=json`, { headers: { "User-Agent": "riesgo-apoyomet/1.0 (verificacion de pronostico)" } });
  if (!r.ok) throw new Error("aviationweather.gov respondió " + r.status);
  const lista = await r.json();
  const porFecha = {};
  for (const o of lista) {
    if (!o || !o.icaoId || !o.obsTime) continue;
    const f = fechaLocal(o.obsTime, TZ_EST(o.icaoId));
    ((porFecha[f] = porFecha[f] || {})[o.icaoId] = porFecha[f][o.icaoId] || []).push(o);
  }
  let escritas = 0;
  for (const [f, est] of Object.entries(porFecha)) {
    const k = "obs:" + f, prev = (await env.RIESGO.get(k, "json")) || {};
    let cambio = false;
    for (const [icao, obs] of Object.entries(est)) {
      const a = prev[icao] || { t: [], tmax: null, tmin: null, wmax: null, gmax: null, lluvia: false, tormenta: false };
      for (const o of obs) {
        if (a.t.includes(o.obsTime)) continue;
        a.t.push(o.obsTime); cambio = true;
        if (typeof o.temp === "number") { a.tmax = a.tmax == null ? o.temp : Math.max(a.tmax, o.temp); a.tmin = a.tmin == null ? o.temp : Math.min(a.tmin, o.temp); }
        if (typeof o.wspd === "number") a.wmax = Math.max(a.wmax || 0, Math.round(o.wspd * KT));
        if (typeof o.wgst === "number") a.gmax = Math.max(a.gmax || 0, Math.round(o.wgst * KT));
        // tiempo presente: del campo decodificado o del cuerpo del METAR (sin observaciones RMK)
        const cuerpo = (o.rawOb || "").split(" RMK")[0].split(" ").slice(2).join(" ");
        const wx = ((o.wxString || "") + " " + cuerpo).split(/\s+/);
        if (wx.some(g => /^[-+]?(VC)?(SH|TS|FZ)?(RA|DZ|SN|GR|GS|PL)+$/.test(g))) a.lluvia = true;
        if (wx.some(g => /^[-+]?(VC)?TS/.test(g))) a.tormenta = true;
      }
      a.t.sort(); prev[icao] = a;
    }
    if (cambio) { await env.RIESGO.put(k, JSON.stringify(prev), { expirationTtl: 400 * 86400 }); escritas++; }
  }
  return { metar: lista.length, fechas: Object.keys(porFecha).length, escritas };
}

function nivelObs(ob, s, thr) {
  const why = []; let lv = 0;
  const up = (l, t) => { if (l > 0) why.push(t); if (l > lv) lv = l; };
  const ok = v => v != null && v !== "" && !isNaN(+v);
  const um = k => { let o = s.u && s.u[k]; if (!o && k === "gust" && ok(s.rA)) o = { A: s.rA, R: s.rR };
    return { A: o && ok(o.A) ? +o.A : thr[k].A, R: o && ok(o.R) ? +o.R : thr[k].R }; };
  const G = um("gust"), W = um("wind"), X = um("tmax"), N = um("tmin");
  const g = Math.max(ob.gmax || 0, ob.wmax || 0);
  if (thr.gust.on && (ob.gmax || ob.wmax)) up(g >= G.R ? 2 : g >= G.A ? 1 : 0, `Ráfagas ${g} km/h`);
  if (thr.wind.on && ob.wmax != null) up(ob.wmax >= W.R ? 2 : ob.wmax >= W.A ? 1 : 0, `Viento ${ob.wmax} km/h`);
  if (thr.tmax.on && ob.tmax != null) up(ob.tmax >= X.R ? 2 : ob.tmax >= X.A ? 1 : 0, `Calor ${ob.tmax} °C`);
  if (thr.tmin.on && ob.tmin != null) up(ob.tmin <= N.R ? 2 : ob.tmin <= N.A ? 1 : 0, `Frío ${ob.tmin} °C`);
  if (thr.storm.on && ob.tormenta) up(1, "Tormenta eléctrica");
  return { lv, why };
}

async function verificacion(env, dias) {
  const hoy = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" }).format(new Date());
  const fechas = []; for (let i = dias; i >= 1; i--) { const d = new Date(hoy + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - i); fechas.push(d.toISOString().slice(0, 10)); }
  const idx = (await env.RIESGO.get("emis:indice", "json")) || [];
  const cache = {}, filas = [];
  for (const f of fechas) {
    // pronóstico vigente: la última emisión hecha antes de ese día que lo incluya
    const cand = idx.filter(e => e.fecha && e.fecha < f && e.desde <= f && e.hasta >= f);
    if (!cand.length) continue;
    const e = cand[cand.length - 1];
    if (!cache[e.id]) cache[e.id] = await env.RIESGO.get("emis:" + e.id, "json");
    const snap = cache[e.id]; if (!snap) continue;
    const obsDia = (await env.RIESGO.get("obs:" + f, "json")) || {};
    for (const s of snap.sites) {
      const c = snap.cells[s.id] && snap.cells[s.id][f]; if (!c) continue;
      const est = ESTACIONES[s.id]; const ob = est ? obsDia[est[0]] : null;
      const fila = { fecha: f, site: s.id, nombre: s.nombre, emision: e.id, plazo: Math.round((Date.parse(f) - Date.parse(e.fecha)) / 86400000),
        pr: { tmax: c.tmax, tmin: c.tmin, wlo: c.wlo, whi: c.whi, plo: c.plo, phi: c.phi, pmed: c.pmed, risk: c.risk, code: c.code } };
      if (ob && ob.t.length) {
        const no = nivelObs(ob, s, snap.thr);
        fila.ob = { tmax: ob.tmax, tmin: ob.tmin, wmax: ob.wmax, gmax: ob.gmax, lluvia: ob.lluvia, tormenta: ob.tormenta, n: ob.t.length, risk: no.lv, why: no.why };
      }
      filas.push(fila);
    }
  }
  const estaciones = Object.fromEntries(Object.entries(ESTACIONES).map(([k, v]) => [k, { icao: v[0], nombre: v[1], km: v[2] }]));
  return { desde: fechas[0], hasta: fechas[fechas.length - 1], filas, estaciones };
}
