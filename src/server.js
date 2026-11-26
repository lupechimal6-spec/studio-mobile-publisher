// studio-mobile-publisher: publica proyectos de STUDIO MOBILE en el perfil de cada jugador.
//
// Por qué existe: Roblox no deja que un juego suba lugares (Place Publishing) desde dentro
// del propio juego, así que el juego envía el proyecto aquí y este servidor lo sube con la
// API key de Open Cloud del jugador.
//
// Seguridad:
//  - Solo acepta peticiones del juego (cabecera x-studio-token = STUDIO_TOKEN).
//  - Las API keys NO se guardan aquí: se cifran (AES-256-GCM, ligadas al userId) y el
//    cifrado lo guarda el juego en su DataStore. Sin ENCRYPTION_SECRET nadie puede leerlas,
//    ni siquiera el dueño del juego. El servidor no necesita disco ni base de datos.
//  - Las claves nunca se escriben en los registros.

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { projectToRbxlx } = require('./rbxlx');

const PORT = Number(process.env.PORT) || 8080;
const STUDIO_TOKEN = process.env.STUDIO_TOKEN || '';
const ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || '';
const MAX_BODY = 16 * 1024 * 1024; // 16 MB
const ROBLOX_API = 'https://apis.roblox.com';

if (STUDIO_TOKEN.length < 24 || ENCRYPTION_SECRET.length < 24) {
  console.error('Faltan variables: STUDIO_TOKEN y ENCRYPTION_SECRET (mínimo 24 caracteres cada una). Mira el README.');
  process.exit(1);
}

const encKey = crypto.createHash('sha256').update('studio-mobile:' + ENCRYPTION_SECRET).digest();

// ------------------------------------------------------------------ utilidades

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function fail(res, status, error) {
  send(res, status, { ok: false, error });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('El proyecto es demasiado grande.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('JSON no válido.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

const isId = (v) => typeof v === 'string' && /^\d{1,17}$/.test(v);
const isUserId = (v) => (typeof v === 'number' && Number.isInteger(v) && v > 0) || (typeof v === 'string' && /^\d{1,17}$/.test(v));

// ------------------------------------------------------------------ cifrado de las API keys

function encryptKey(userId, apiKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  cipher.setAAD(Buffer.from('user:' + String(userId)));
  const enc = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'v1.' + Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptKey(userId, blob) {
  if (typeof blob !== 'string' || !blob.startsWith('v1.') || blob.length > 6000) throw new Error('nokey');
  const raw = Buffer.from(blob.slice(3), 'base64');
  if (raw.length < 29) throw new Error('nokey');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, iv);
  decipher.setAAD(Buffer.from('user:' + String(userId)));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

function keyFrom(body) {
  try {
    return decryptKey(body.userId, body.blob);
  } catch {
    const e = new Error('No hay ninguna API key guardada (o no se pudo leer). Vuelve a guardarla.');
    e.status = 400;
    throw e;
  }
}

// ------------------------------------------------------------------ límite de peticiones por jugador

const buckets = new Map();
function allow(userId, cost = 1) {
  const now = Date.now();
  const b = buckets.get(userId) || { tokens: 10, last: now };
  b.tokens = Math.min(10, b.tokens + ((now - b.last) / 60000) * 10); // 10 por minuto
  b.last = now;
  if (b.tokens < cost) {
    buckets.set(userId, b);
    return false;
  }
  b.tokens -= cost;
  buckets.set(userId, b);
  return true;
}

// ------------------------------------------------------------------ Roblox Open Cloud

function explainRoblox(status, text) {
  const t = (text || '').toLowerCase();
  if (status === 401) return 'La API key no es válida, está desactivada o caducó. Crea otra en create.roblox.com › Open Cloud › API Keys.';
  if (status === 403) {
    if (t.includes('ip')) return 'La API key tiene restringidas las direcciones IP. En la configuración de la clave, en «Accepted IP Addresses», añade 0.0.0.0/0.';
    return 'La API key no tiene permiso para ese juego. Edita la clave y en «universe-places» añade tu experiencia con el permiso «write».';
  }
  if (status === 404) return 'No existe ese Universe ID o Place ID, o el lugar no pertenece a esa experiencia.';
  if (status === 409) return 'Roblox está procesando otra publicación de este lugar. Espera un minuto y vuelve a intentarlo.';
  if (status === 429) return 'Roblox recibió demasiadas publicaciones seguidas. Espera un minuto.';
  if (status === 413) return 'El juego es demasiado grande para publicarlo.';
  if (status >= 500) return 'Los servidores de Roblox fallaron. Inténtalo de nuevo en unos minutos.';
  return `Roblox respondió ${status}: ${String(text || '').slice(0, 200)}`;
}

async function robloxFetch(path, apiKey, opts = {}) {
  const res = await fetch(ROBLOX_API + path, {
    method: opts.method || 'GET',
    headers: { 'x-api-key': apiKey, ...(opts.headers || {}) },
    body: opts.body,
    signal: AbortSignal.timeout(opts.timeout || 60000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* no es JSON */ }
  return { status: res.status, ok: res.ok, text, json };
}

// ------------------------------------------------------------------ trabajos de publicación

const jobs = new Map(); // id -> trabajo
function newJob(userId) {
  const id = crypto.randomUUID();
  const job = { id, userId: String(userId), progress: 0.05, stage: 'En cola…', done: false, success: false, created: Date.now() };
  jobs.set(id, job);
  return job;
}
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, j] of jobs) if (j.created < cutoff) jobs.delete(id);
  for (const [u, b] of buckets) if (Date.now() - b.last > 10 * 60 * 1000) buckets.delete(u);
}, 60 * 1000).unref();

function decodeProject(text, fmt) {
  if (typeof text !== 'string' || text.length === 0) throw new Error('Proyecto vacío.');
  let json = text;
  if (fmt === 'zb64') {
    const raw = Buffer.from(text, 'base64');
    json = zlib.zstdDecompressSync(raw, { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8');
  } else if (fmt !== 'json') {
    throw new Error('Formato de proyecto desconocido.');
  }
  return JSON.parse(json);
}

async function runPublish(job, body, apiKey) {
  try {
    job.stage = 'Convirtiendo el proyecto…';
    job.progress = 0.2;
    const project = decodeProject(body.project, body.fmt);
    const { xml, objects, warnings } = projectToRbxlx(project);
    job.progress = 0.45;
    job.stage = `Subiendo a Roblox (${(Buffer.byteLength(xml) / 1024).toFixed(0)} KB)…`;
    const versionType = body.versionType === 'Saved' ? 'Saved' : 'Published';
    const r = await robloxFetch(
      `/universes/v1/${body.universeId}/places/${body.placeId}/versions?versionType=${versionType}`,
      apiKey,
      { method: 'POST', headers: { 'Content-Type': 'application/xml' }, body: xml, timeout: 120000 },
    );
    if (!r.ok) throw new Error(explainRoblox(r.status, r.text));
    job.result = { versionNumber: r.json && r.json.versionNumber, objects, warnings };
    job.success = true;
    job.stage = versionType === 'Saved' ? '¡Guardado en Roblox!' : '¡Publicado!';
    job.progress = 1;
  } catch (err) {
    job.success = false;
    job.error = err && err.message ? err.message : 'Error desconocido.';
    job.stage = 'Error';
    console.warn(`[publish] usuario ${job.userId}: ${job.error}`);
  } finally {
    job.done = true;
  }
}

// ------------------------------------------------------------------ rutas

const routes = {
  // Cifra la API key del jugador; el juego guarda el resultado en su DataStore
  'POST /v1/credentials': async (body) => {
    if (!isUserId(body.userId)) return [400, { ok: false, error: 'Usuario no válido.' }];
    const key = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (key.length < 20 || key.length > 2000 || /\s/.test(key)) return [400, { ok: false, error: 'Esa API key no parece válida.' }];
    return [200, { ok: true, blob: encryptKey(body.userId, key), last4: key.slice(-4) }];
  },

  // Comprueba que la clave funciona con ese juego
  'POST /v1/test': async (body) => {
    if (!isUserId(body.userId) || !isId(body.universeId) || !isId(body.placeId)) return [400, { ok: false, error: 'Universe ID y Place ID deben ser números.' }];
    if (!allow(String(body.userId))) return [429, { ok: false, error: 'Demasiados intentos; espera un minuto.' }];
    const apiKey = keyFrom(body);
    const r = await robloxFetch(`/cloud/v2/universes/${body.universeId}/places/${body.placeId}`, apiKey, { timeout: 20000 });
    if (r.ok) return [200, { ok: true, placeName: (r.json && r.json.displayName) || '' }];
    if (r.status === 403 && !/ip/i.test(r.text)) {
      // La clave puede tener solo permiso de publicar (sin lectura): se avisa pero no es un error
      return [200, { ok: true, warning: 'La clave es válida, pero no tiene permiso de lectura para comprobar el lugar. Si tiene «universe-places › write», publicar funcionará.' }];
    }
    return [400, { ok: false, error: explainRoblox(r.status, r.text) }];
  },

  // Empieza a publicar; el juego consulta el progreso con GET /v1/jobs/:id
  'POST /v1/publish': async (body) => {
    if (!isUserId(body.userId) || !isId(body.universeId) || !isId(body.placeId)) return [400, { ok: false, error: 'Universe ID y Place ID deben ser números.' }];
    if (!allow(String(body.userId), 3)) return [429, { ok: false, error: 'Has publicado muchas veces seguidas; espera un par de minutos.' }];
    for (const j of jobs.values()) {
      if (j.userId === String(body.userId) && !j.done) return [409, { ok: false, error: 'Ya hay una publicación en curso.' }];
    }
    const apiKey = keyFrom(body);
    const job = newJob(body.userId);
    runPublish(job, body, apiKey); // en segundo plano
    return [200, { ok: true, jobId: job.id }];
  },
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return send(res, 200, { ok: true, service: 'studio-mobile-publisher' });
    }
    if (!safeEqual(req.headers['x-studio-token'] || '', STUDIO_TOKEN)) return fail(res, 401, 'Token del juego no válido.');

    const jobMatch = url.pathname.match(/^\/v1\/jobs\/([0-9a-f-]{36})$/);
    if (req.method === 'GET' && jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) return fail(res, 404, 'Esa publicación ya no existe.');
      const { userId, created, ...pub } = job;
      return send(res, 200, { ok: true, job: pub });
    }

    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) return fail(res, 404, 'Ruta desconocida.');
    const body = await readJson(req);
    const [status, data] = await handler(body);
    send(res, status, data);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error('[error]', err);
    fail(res, status, status === 500 ? 'Error interno del servidor de publicación.' : err.message);
  }
});

server.listen(PORT, () => console.log(`studio-mobile-publisher escuchando en el puerto ${PORT}`));

module.exports = { encryptKey, decryptKey, decodeProject };
