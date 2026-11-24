// Serveur HTTP local, 127.0.0.1 uniquement.
//   /health                      public (l'extension vérifie que l'app tourne)
//   /pair                        public, demande confirmation dans l'app, renvoie le token
//   /v1/*                        extension, Authorization: Bearer <token>
//   /ui?ticket=…  /ui/*  /api/*  fenêtre Transcripts, cookie de session HttpOnly
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CallStore } = require('./store');

const UI_DIR = path.join(__dirname, 'ui');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const CSP = "default-src 'self'; media-src https://*.supabase.co blob:; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'";

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function createServer({ config, secrets, store, pipeline, hooks = {}, version = '1.0.0', log = console }) {
  const tickets = new Map(); // ticket -> expiration
  const sessions = new Set(); // cookies de session UI
  let pairing = null;

  async function token() {
    let t = await secrets.get('extensionToken');
    if (!t) {
      t = crypto.randomBytes(32).toString('hex');
      await secrets.set('extensionToken', t);
    }
    return t;
  }

  function send(res, status, body, headers = {}) {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    res.writeHead(status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(isJson ? { 'Content-Type': 'application/json; charset=utf-8' } : {}), ...headers });
    res.end(isJson ? JSON.stringify(body) : body);
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(Object.assign(new Error('trop gros'), { status: 413 })); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }
  async function readJson(req) {
    const buf = await readBody(req, 256 * 1024);
    if (!buf.length) return {};
    try { return JSON.parse(buf.toString('utf8')); } catch (_) { throw Object.assign(new Error('JSON invalide'), { status: 400 }); }
  }

  function cookie(req, name) {
    const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    return m ? m[1] : null;
  }

  async function bearerOk(req) {
    const h = req.headers.authorization || '';
    return h.startsWith('Bearer ') && safeEqual(h.slice(7), await token());
  }
  function sessionOk(req) {
    const c = cookie(req, 'yr_session');
    return !!c && sessions.has(c);
  }

  function newTicket() {
    const t = crypto.randomBytes(24).toString('hex');
    tickets.set(t, Date.now() + 60000);
    return t;
  }
  function uiUrl(hash = '') {
    return `http://127.0.0.1:${config.get('port')}/ui?ticket=${newTicket()}${hash ? `#${hash.replace(/^#/, '')}` : ''}`;
  }

  // ------------------------------------------------------------------ routes extension
  async function routeV1(req, res, parts) {
    if (!(await bearerOk(req))) return send(res, 401, { error: 'token invalide' });
    // /v1/calls/:id/(start|meta|end)  ou  /v1/calls/:id/chunks/:seq
    if (parts[1] === 'calls' && parts[2]) {
      const id = parts[2];
      if (!CallStore.validId(id)) return send(res, 400, { error: 'id invalide' });
      if (req.method === 'PUT' && parts[3] === 'chunks') {
        const seq = Number(parts[4]);
        const buf = await readBody(req, 10 * 1024 * 1024);
        if (!buf.length) return send(res, 400, { error: 'chunk vide' });
        await store.chunk(id, seq, buf, Number(req.headers['x-chunk-at']) || Date.now());
        return send(res, 204, '');
      }
      if (req.method === 'POST' && ['start', 'meta', 'end'].includes(parts[3])) {
        const body = await readJson(req);
        await store[parts[3]](id, body);
        if (parts[3] === 'start' && hooks.onRecording) hooks.onRecording(true);
        if (parts[3] === 'end') {
          if (hooks.onRecording) hooks.onRecording(false);
          pipeline && pipeline.tick();
        }
        return send(res, 204, '');
      }
    }
    if (parts[1] === 'config') {
      if (req.method === 'GET') return send(res, 200, { consentMode: config.get('consentMode'), consentUpdatedAt: config.get('consentUpdatedAt') });
      if (req.method === 'POST') {
        const b = await readJson(req);
        if (['us', 'all', 'off'].includes(b.consentMode) && (b.consentUpdatedAt || 0) > config.get('consentUpdatedAt')) {
          config.set({ consentMode: b.consentMode, consentUpdatedAt: b.consentUpdatedAt });
        }
        return send(res, 204, '');
      }
    }
    if (parts[1] === 'open' && req.method === 'POST') {
      if (hooks.openWindow) hooks.openWindow();
      return send(res, 204, '');
    }
    if (parts[1] === 'ui-ticket' && req.method === 'POST') return send(res, 200, { url: uiUrl() });
    return send(res, 404, { error: 'introuvable' });
  }

  // ------------------------------------------------------------------ routes UI
  async function localCalls() {
    return (await store.list()).map((m) => ({
      id: m.id, startedAt: m.startedAt, endedAt: m.endedAt || null, phoneNumber: m.phoneNumber || null, contactName: m.contactName || null,
      direction: m.direction, state: m.state, attempts: m.attempts || 0, lastError: m.lastError || null, nextAttemptAt: m.nextAttemptAt || null,
      durationSec: m.durationSec ?? null,
    }));
  }

  async function remote() {
    return pipeline.remoteFactory();
  }

  async function routeApi(req, res, parts, url) {
    if (!sessionOk(req) && !(await bearerOk(req))) return send(res, 401, { error: 'session expirée' });
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'yadarec') return send(res, 403, { error: 'en-tête manquant' });
    const [, a, b, c] = parts;

    if (a === 'calls' && !b && req.method === 'GET') {
      const out = { local: await localCalls(), calls: [], error: null };
      try { out.calls = await (await remote()).search(url.searchParams.get('q') || ''); }
      catch (e) { out.error = e.message; }
      return send(res, 200, out);
    }
    if (a === 'calls' && b && !c && req.method === 'GET') {
      if (!CallStore.validId(b)) return send(res, 400, { error: 'id invalide' });
      const row = await (await remote()).get(b);
      return row ? send(res, 200, row) : send(res, 404, { error: 'introuvable' });
    }
    if (a === 'calls' && b && c === 'audio' && req.method === 'GET') {
      if (!CallStore.validId(b)) return send(res, 400, { error: 'id invalide' });
      const r = await remote();
      const row = await r.get(b);
      if (!row || !row.audio_path) return send(res, 404, { error: 'pas d’audio' });
      return send(res, 200, { url: await r.signedUrl(row.audio_path, 3600) });
    }
    if (a === 'calls' && b && c === 'retry' && req.method === 'POST') {
      if (!CallStore.validId(b)) return send(res, 400, { error: 'id invalide' });
      await pipeline.retry(b);
      return send(res, 204, '');
    }
    if (a === 'settings' && req.method === 'GET') {
      return send(res, 200, { config: config.get(), secrets: await secrets.has(), version, token: await token() });
    }
    if (a === 'settings' && req.method === 'POST') {
      const body = await readJson(req);
      const patch = { ...(body.config || {}) };
      delete patch.port; // le port se change dans config.json, pas à chaud
      delete patch.firstRunDone;
      if (patch.consentMode) patch.consentUpdatedAt = Date.now();
      config.set(patch);
      for (const [k, v] of Object.entries(body.secrets || {})) {
        if (k === 'extensionToken') continue;
        if (v === null || (typeof v === 'string' && v.trim())) await secrets.set(k, v || '');
      }
      if (hooks.onSettingsChanged) hooks.onSettingsChanged(config.get());
      pipeline.retryAll();
      return send(res, 200, { ok: true });
    }
    if (a === 'test' && req.method === 'POST') {
      const result = {};
      try { await (await remote()).ping(); result.supabase = 'ok'; } catch (e) { result.supabase = e.message; }
      const provider = config.get('provider');
      try {
        if (provider === 'deepgram') {
          const k = await secrets.get('deepgramKey');
          if (!k) throw new Error('clé manquante');
          const r = await fetch('https://api.deepgram.com/v1/projects', { headers: { Authorization: `Token ${k}` }, signal: AbortSignal.timeout(10000) });
          result.transcription = r.ok ? 'ok' : `Deepgram ${r.status}`;
        } else {
          const k = await secrets.get('elevenlabsKey');
          if (!k) throw new Error('clé manquante');
          const r = await fetch('https://api.elevenlabs.io/v1/user', { headers: { 'xi-api-key': k }, signal: AbortSignal.timeout(10000) });
          result.transcription = r.ok ? 'ok' : `ElevenLabs ${r.status}`;
        }
      } catch (e) { result.transcription = e.message; }
      result.claude = (await secrets.get('anthropicKey')) ? 'clé enregistrée' : 'clé manquante (pas de résumé)';
      return send(res, 200, result);
    }
    return send(res, 404, { error: 'introuvable' });
  }

  function serveUi(req, res, url) {
    if (url.pathname === '/ui' || url.pathname === '/ui/' && url.searchParams.get('ticket')) {
      const t = url.searchParams.get('ticket');
      const exp = t && tickets.get(t);
      if (t) tickets.delete(t);
      if (exp && exp > Date.now()) {
        const sid = crypto.randomBytes(32).toString('hex');
        sessions.add(sid);
        return send(res, 302, '', { Location: '/ui/', 'Set-Cookie': `yr_session=${sid}; HttpOnly; SameSite=Strict; Path=/` });
      }
      if (!sessionOk(req)) return send(res, 401, '<p style="font:14px system-ui;padding:24px">Lien expiré. Ouvre les transcripts depuis l’icône Yada Recorder de la barre des menus ou depuis Yadaphone.</p>', { 'Content-Type': 'text/html; charset=utf-8' });
      return send(res, 302, '', { Location: '/ui/' });
    }
    if (!sessionOk(req)) return send(res, 401, '<p style="font:14px system-ui;padding:24px">Session expirée. Rouvre les transcripts depuis l’app.</p>', { 'Content-Type': 'text/html; charset=utf-8' });
    let rel = url.pathname.replace(/^\/ui\/?/, '') || 'index.html';
    const file = path.normalize(path.join(UI_DIR, rel));
    if (!file.startsWith(UI_DIR + path.sep)) return send(res, 404, 'introuvable');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'introuvable');
      send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY' });
    });
  }

  // ------------------------------------------------------------------ dispatch
  const server = http.createServer(async (req, res) => {
    const port = config.get('port');
    const host = String(req.headers.host || '');
    // Anti DNS-rebinding : seul 127.0.0.1 / localhost est accepté.
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 421, { error: 'hôte refusé' });
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (url.pathname === '/health') return send(res, 200, { ok: true, app: 'yada-recorder', version });
      if (url.pathname === '/pair' && req.method === 'POST') {
        const origin = String(req.headers.origin || '');
        if (!origin.startsWith('chrome-extension://')) return send(res, 403, { error: 'origine refusée' });
        if (pairing) return send(res, 409, { error: 'appairage déjà en cours' });
        pairing = (hooks.confirmPair ? hooks.confirmPair(origin) : Promise.resolve(true)).finally(() => { pairing = null; });
        const ok = await pairing;
        return ok ? send(res, 200, { token: await token() }) : send(res, 403, { error: 'refusé' });
      }
      if (parts[0] === 'v1') return await routeV1(req, res, parts);
      if (parts[0] === 'api') return await routeApi(req, res, parts, url);
      if (parts[0] === 'ui') return serveUi(req, res, url);
      if (url.pathname === '/') return send(res, 302, '', { Location: '/ui/' });
      return send(res, 404, { error: 'introuvable' });
    } catch (e) {
      const status = e.status || (e.config ? 503 : 500);
      if (status >= 500) log.error('[server]', req.method, url.pathname, e);
      if (!res.headersSent) send(res, status, { error: e.message });
    }
  });

  return {
    server,
    uiUrl,
    token,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.get('port'), '127.0.0.1', () => resolve(server.address().port));
      });
    },
    close() { return new Promise((r) => server.close(r)); },
  };
}

module.exports = { createServer };
