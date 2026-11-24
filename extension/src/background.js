// Yada Recorder : service worker MV3.
// Tout ce qui arrive de la page est d'abord écrit dans IndexedDB (outbox), puis envoyé
// dans l'ordre à l'app desktop sur http://127.0.0.1:<port>. Un élément n'est supprimé de
// l'outbox qu'après un 2xx. Si l'app ne répond pas, on réessaie (alarme toutes les minutes).

const DEFAULT_PORT = 47311;
const DB_NAME = 'yadarec';
const STORE = 'outbox';

// ------------------------------------------------------------------ IndexedDB
let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { autoIncrement: true });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbPromise = null; reject(req.error); };
    });
  }
  return dbPromise;
}
function tx(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(store, (r) => { result = r; })).catch(reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}
const outboxPut = (item) => tx('readwrite', (s) => { s.add(item); });
const outboxDelete = (key) => tx('readwrite', (s) => { s.delete(key); });
const outboxCount = () => tx('readonly', (s, set) => { const r = s.count(); r.onsuccess = () => set(r.result); });
function outboxPeek(limit) {
  return tx('readonly', (s, set) => {
    const items = [];
    const req = s.openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (c && items.length < limit) { items.push({ key: c.key, value: c.value }); c.continue(); }
      else set(items);
    };
  });
}

// ------------------------------------------------------------------ réglages / état
async function settings() {
  const s = await chrome.storage.local.get(['port', 'token', 'consentMode', 'consentUpdatedAt']);
  return { port: s.port || DEFAULT_PORT, token: s.token || null, consentMode: s.consentMode || 'us', consentUpdatedAt: s.consentUpdatedAt || 0 };
}
async function base() {
  const { port } = await settings();
  return `http://127.0.0.1:${port}`;
}
async function setStatus(patch) {
  const { status = {} } = await chrome.storage.session.get('status');
  const next = { ...status, ...patch, at: Date.now() };
  await chrome.storage.session.set({ status: next });
  await updateBadge(next);
}
async function activeCalls() {
  const { active = {} } = await chrome.storage.session.get('active');
  return active;
}
async function setActive(callId, tabId) {
  const active = await activeCalls();
  if (tabId == null) delete active[callId];
  else active[callId] = tabId;
  await chrome.storage.session.set({ active });
  const { status = {} } = await chrome.storage.session.get('status');
  await updateBadge(status);
}
async function updateBadge(status) {
  const recording = Object.keys(await activeCalls()).length > 0;
  let text = '';
  let color = '#6b7280';
  if (recording) { text = 'REC'; color = '#dc2626'; }
  else if (status.desktop === 'unpaired') { text = '!'; color = '#d97706'; }
  else if (status.pending > 0 && status.desktop !== 'ok') { text = String(Math.min(status.pending, 99)); color = '#d97706'; }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}

// ------------------------------------------------------------------ HTTP vers l'app
async function api(path, { method = 'GET', body, headers = {}, auth = true, timeout = 15000 } = {}) {
  const { token } = await settings();
  const h = { ...headers };
  if (auth && token) h.Authorization = `Bearer ${token}`;
  if (body && !(body instanceof Blob) && typeof body !== 'string') {
    h['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  return fetch((await base()) + path, { method, headers: h, body, signal: AbortSignal.timeout(timeout) });
}

async function sendItem(item) {
  const id = encodeURIComponent(item.callId);
  let res;
  try {
    if (item.kind === 'chunk') {
      res = await api(`/v1/calls/${id}/chunks/${item.seq}`, {
        method: 'PUT', body: item.blob, headers: { 'Content-Type': 'application/octet-stream', 'X-Chunk-At': String(item.at) }, timeout: 30000,
      });
    } else {
      res = await api(`/v1/calls/${id}/${item.kind}`, { method: 'POST', body: item.payload });
    }
  } catch (_) {
    return 'retry';
  }
  if (res.ok) return 'ok';
  if (res.status === 401 || res.status === 403) return 'auth';
  if (res.status === 400 || res.status === 404 || res.status === 413 || res.status === 422) return 'drop';
  return 'retry';
}

let flushing = null;
function flush() {
  if (!flushing) flushing = doFlush().catch((e) => console.warn('[yadarec] flush', e)).finally(() => { flushing = null; });
  return flushing;
}
async function doFlush() {
  const { token } = await settings();
  if (!token) {
    await setStatus({ desktop: 'unpaired', pending: await outboxCount() });
    return;
  }
  for (;;) {
    const batch = await outboxPeek(25);
    if (!batch.length) break;
    for (const { key, value } of batch) {
      const r = await sendItem(value);
      if (r === 'ok' || r === 'drop') {
        if (r === 'drop') console.warn('[yadarec] élément rejeté par l’app', value.kind, value.callId);
        await outboxDelete(key);
        continue;
      }
      await setStatus({ desktop: r === 'auth' ? 'unpaired' : 'down', pending: await outboxCount() });
      return;
    }
  }
  await setStatus({ desktop: 'ok', pending: 0 });
}

// ------------------------------------------------------------------ messages de la page
function b64ToBlob(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'audio/webm' });
}

async function handleRec(m, sender) {
  const tabId = sender.tab ? sender.tab.id : null;
  const { t, callId } = m;
  if (!callId) return;
  if (t === 'chunk') {
    await outboxPut({ kind: 'chunk', callId, seq: m.seq, at: m.at, blob: b64ToBlob(m.b64) });
  } else {
    const kind = { 'call-start': 'start', 'call-meta': 'meta', 'call-end': 'end' }[t];
    const { t: _t, ...payload } = m;
    await outboxPut({ kind, callId, payload });
    if (t === 'call-start') await setActive(callId, tabId);
    if (t === 'call-end') await setActive(callId, null);
  }
  flush();
}

// Onglet fermé en plein appel : si la page n'a pas pu envoyer sa fin, on la synthétise.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const active = await activeCalls();
  for (const [callId, t] of Object.entries(active)) {
    if (t !== tabId) continue;
    await outboxPut({ kind: 'end', callId, payload: { callId, endedAt: new Date().toISOString(), reason: 'tab-closed' } });
    await setActive(callId, null);
  }
  flush();
});

// ------------------------------------------------------------------ appairage / config
async function pair() {
  let res;
  try {
    res = await api('/pair', { method: 'POST', auth: false, body: { client: 'chrome-extension' }, timeout: 90000 });
  } catch (_) {
    return { ok: false, error: 'App desktop injoignable. Lance Yada Recorder puis réessaie.' };
  }
  if (!res.ok) return { ok: false, error: res.status === 403 ? 'Appairage refusé dans l’app.' : `Erreur ${res.status}` };
  const { token } = await res.json();
  await chrome.storage.local.set({ token });
  await flush();
  await syncConfig();
  return { ok: true };
}

async function syncConfig() {
  const s = await settings();
  if (!s.token) return;
  try {
    const res = await api('/v1/config');
    if (!res.ok) return;
    const remote = await res.json();
    if ((remote.consentUpdatedAt || 0) > s.consentUpdatedAt) {
      await chrome.storage.local.set({ consentMode: remote.consentMode, consentUpdatedAt: remote.consentUpdatedAt });
    } else if (s.consentUpdatedAt > (remote.consentUpdatedAt || 0)) {
      await api('/v1/config', { method: 'POST', body: { consentMode: s.consentMode, consentUpdatedAt: s.consentUpdatedAt } });
    }
  } catch (_) {}
}

async function health() {
  try {
    const r = await api('/health', { auth: false, timeout: 2000 });
    return r.ok;
  } catch (_) {
    return false;
  }
}

async function openTranscripts(inTab) {
  const { token } = await settings();
  if (!(await health())) return { ok: false, reason: 'down' };
  if (!token) return { ok: false, reason: 'unpaired' };
  try {
    if (inTab) {
      const r = await api('/v1/ui-ticket', { method: 'POST' });
      if (!r.ok) return { ok: false, reason: r.status === 401 ? 'unpaired' : 'error' };
      const { url } = await r.json();
      await chrome.tabs.create({ url });
      return { ok: true };
    }
    const r = await api('/v1/open', { method: 'POST' });
    return r.ok ? { ok: true } : { ok: false, reason: r.status === 401 ? 'unpaired' : 'error' };
  } catch (_) {
    return { ok: false, reason: 'down' };
  }
}

async function openAfterLaunch() {
  const until = Date.now() + 12000;
  while (Date.now() < until) {
    if (await health()) {
      flush();
      return openTranscripts(false);
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  return { ok: false, reason: 'down' };
}

async function popupStatus() {
  const s = await settings();
  const up = await health();
  if (up) await flush();
  const { status = {} } = await chrome.storage.session.get('status');
  const { debug = false } = await chrome.storage.local.get('debug');
  return {
    desktopUp: up,
    paired: !!s.token,
    desktop: status.desktop || (up ? 'ok' : 'down'),
    pending: await outboxCount(),
    recording: Object.keys(await activeCalls()).length,
    consentMode: s.consentMode,
    port: s.port,
    debug,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const reply = (p) => { p.then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) })); return true; };
  switch (msg && msg.type) {
    case 'rec': return reply(handleRec(msg.msg, sender).then(() => ({ ok: true })));
    case 'frame-state':
      if (sender.tab) chrome.tabs.sendMessage(sender.tab.id, msg, { frameId: 0 }).catch(() => {});
      return false;
    case 'open-transcripts': return reply(openTranscripts(!!msg.inTab));
    case 'open-after-launch': return reply(openAfterLaunch());
    case 'status': return reply(popupStatus());
    case 'status-lite':
      return reply((async () => {
        const s = await settings();
        return { desktopUp: await health(), paired: !!s.token, pending: await outboxCount() };
      })());
    case 'pair': return reply(pair());
    case 'set-token':
      return reply(chrome.storage.local.set({ token: msg.token || null }).then(() => flush()).then(() => ({ ok: true })));
    case 'set-port':
      return reply(chrome.storage.local.set({ port: Number(msg.port) || DEFAULT_PORT }).then(() => ({ ok: true })));
    case 'set-consent':
      return reply((async () => {
        const consentUpdatedAt = Date.now();
        await chrome.storage.local.set({ consentMode: msg.consentMode, consentUpdatedAt });
        await syncConfig();
        return { ok: true };
      })());
    case 'set-debug':
      return reply(chrome.storage.local.set({ debug: !!msg.debug }).then(() => ({ ok: true })));
    case 'flush': return reply(flush().then(() => ({ ok: true })));
  }
  return false;
});

// ------------------------------------------------------------------ cycle de vie
function ensureAlarm() {
  chrome.alarms.get('tick', (a) => { if (!a) chrome.alarms.create('tick', { periodInMinutes: 1 }); });
}
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== 'tick') return;
  flush().then(syncConfig);
});
chrome.runtime.onInstalled.addListener(async () => {
  ensureAlarm();
  const { consentMode } = await chrome.storage.local.get('consentMode');
  if (!consentMode) await chrome.storage.local.set({ consentMode: 'us', consentUpdatedAt: 0 });
  flush();
});
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); flush(); });
ensureAlarm();
