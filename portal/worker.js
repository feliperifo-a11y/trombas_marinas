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
