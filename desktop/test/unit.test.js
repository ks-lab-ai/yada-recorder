const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const deepgram = require('../src/transcribe/deepgram');
const elevenlabs = require('../src/transcribe/elevenlabs');
const { transcribe } = require('../src/transcribe');
const { transcriptText } = require('../src/format');
const { Config } = require('../src/config');
const { Secrets, memoryBackend } = require('../src/secrets');
const { CallStore } = require('../src/store');
const { Pipeline } = require('../src/pipeline');
const { createServer } = require('../src/server');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yadarec-test-'));
const ID = '11111111-2222-4333-8444-555555555555';

test('Deepgram : utterances multicanal -> Moi / Interlocuteur', () => {
  const out = deepgram.normalize({
    metadata: { duration: 12, channels: 2 },
    results: {
      channels: [{ detected_language: 'fr', alternatives: [{ words: [] }] }, { detected_language: 'fr', alternatives: [{ words: [] }] }],
      utterances: [
        { channel: 1, start: 0.5, end: 1.2, transcript: 'Allô ?' },
        { channel: 0, start: 1.5, end: 3.0, transcript: 'Bonjour, je vous appelle au sujet du devis.' },
      ],
    },
  }, 'nova-3');
  assert.equal(out.language, 'fr');
  assert.deepEqual(out.segments.map((s) => s.speaker), ['them', 'me']);
});

test('Deepgram : 400 en mode multi -> nouvel essai en détection de langue', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes('language=multi')) return { ok: false, status: 400, text: async () => 'bad' };
    return { ok: true, json: async () => ({ results: { channels: [], utterances: [{ channel: 0, start: 0, end: 1, transcript: 'ok' }] } }) };
  };
  const out = await transcribe('deepgram', Buffer.from('x'), { apiKey: 'k', language: 'multi', fetchImpl });
  assert.equal(out.segments.length, 1);
  assert.ok(urls[1].includes('detect_language=true'));
});

test('ElevenLabs : transcripts par canal -> segments triés', () => {
  const out = elevenlabs.normalize({
    transcripts: [
      { channel_index: 0, language_code: 'en', words: [{ text: 'Hi,', type: 'word', start: 2, end: 2.3 }, { text: ' ', type: 'spacing', start: 2.3, end: 2.4 }, { text: 'Sarah', type: 'word', start: 2.4, end: 2.8 }] },
      { channel_index: 1, language_code: 'en', words: [{ text: 'Hello?', type: 'word', start: 0.4, end: 0.9 }] },
    ],
  }, 'scribe_v2');
  const sorted = out.segments.sort((a, b) => a.start - b.start);
  assert.equal(sorted[0].speaker, 'them');
  assert.equal(sorted[1].text, 'Hi, Sarah');
  assert.equal(out.language, 'en');
});

test('transcript_text : une ligne par tour de parole', () => {
  const t = transcriptText([
    { speaker: 'them', start: 0.5, end: 1, text: 'Allô ?' },
    { speaker: 'me', start: 1.2, end: 2, text: 'Bonjour.' },
    { speaker: 'me', start: 2.1, end: 3, text: 'Je suis Alex.' },
    { speaker: 'them', start: 65, end: 66, text: 'Oui.' },
  ]);
  assert.equal(t, '[00:00] Interlocuteur : Allô ?\n[00:01] Moi : Bonjour. Je suis Alex.\n[01:05] Interlocuteur : Oui.');
});

function setup(overrides = {}) {
  const dir = tmpDir();
  const config = new Config(dir, {});
  config.set({ port: 0, supabaseUrl: 'https://x.supabase.co' });
  const secrets = new Secrets({ backend: memoryBackend(), env: {} });
  const store = new CallStore(dir);
  let now = Date.now();
  const rows = [];
  const pipeline = new Pipeline({
    store, config, secrets, now: () => now, log: { warn() {}, error() {} },
    remoteFactory: async () => ({ uploadAudio: async () => {}, upsertCall: async (r) => rows.push(r) }),
    transcribeFn: async () => ({ provider: 'deepgram', segments: [{ speaker: 'me', start: 0, end: 1, text: 'Salut' }] }),
    summarizeFn: async () => ({ text: '## Résumé\nok' }),
    ...overrides,
  });
  return { dir, config, secrets, store, pipeline, rows, advance: (ms) => { now += ms; }, now: () => now };
}

test('Pipeline : échec de transcription -> erreur + nouvel essai planifié, upload pas refait', async () => {
  let calls = 0;
  let uploads = 0;
  const s = setup({
    transcribeFn: async () => { calls++; if (calls === 1) throw new Error('Deepgram 503'); return { provider: 'deepgram', segments: [] }; },
    remoteFactory: async () => ({ uploadAudio: async () => { uploads++; }, upsertCall: async () => {} }),
  });
  await s.store.start(ID, { startedAt: new Date().toISOString() });
  await s.store.chunk(ID, 0, Buffer.from('webm'), Date.now());
  await s.store.end(ID, { chunks: 1, endedAt: new Date().toISOString() });
  await s.pipeline.tick();
  let m = await s.store.read(ID);
  assert.equal(m.state, 'error');
  assert.equal(m.attempts, 1);
  assert.match(m.lastError, /503/);
  await s.pipeline.tick(); // pas encore l'heure
  assert.equal(calls, 1);
  s.advance(61_000);
  await s.pipeline.tick();
  assert.equal(calls, 2);
  assert.equal(uploads, 1, 'audio uploadé une seule fois');
  assert.equal(await s.store.read(ID), null, 'dossier supprimé une fois fini');
});

test('Pipeline : appel jamais terminé (onglet tué) -> clos après 3 min sans chunk', async () => {
  const s = setup();
  await s.store.start(ID, { startedAt: new Date().toISOString() });
  await s.store.chunk(ID, 0, Buffer.from('webm'), Date.now());
  await s.store.update(ID, (c) => ({ ...c, lastActivityAt: s.now() - 4 * 60_000 }));
  await s.pipeline.tick(); // stale -> ended
  s.advance(25_000);
  await s.pipeline.tick(); // grace écoulée -> traité
  assert.equal(await s.store.read(ID), null);
  assert.equal(s.rows.at(-1).status, 'done');
});

function req(port, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

test('Serveur : auth, anti DNS-rebinding, appairage, ticket UI', async () => {
  const s = setup();
  let paired = 0;
  const app = createServer({ config: s.config, secrets: s.secrets, store: s.store, pipeline: s.pipeline, hooks: { confirmPair: async () => { paired++; return true; } }, log: { error() {} } });
  const port = await app.listen();
  s.config.data.port = port;
  try {
    assert.equal((await req(port, 'GET', '/health')).status, 200);
    assert.equal((await req(port, 'GET', '/health', { headers: { host: 'evil.com' } })).status, 421);
    assert.equal((await req(port, 'POST', `/v1/calls/${ID}/start`, { body: '{}' })).status, 401);
    assert.equal((await req(port, 'POST', '/pair', { headers: { origin: 'https://evil.com' } })).status, 403);
    const pair = await req(port, 'POST', '/pair', { headers: { origin: 'chrome-extension://abc' } });
    assert.equal(pair.status, 200);
    const { token } = JSON.parse(pair.body);
    assert.equal(paired, 1);
    const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    assert.equal((await req(port, 'POST', `/v1/calls/${ID}/start`, { headers: auth, body: JSON.stringify({ phoneNumber: '+33612345678' }) })).status, 204);
    assert.equal((await req(port, 'PUT', `/v1/calls/${ID}/chunks/0`, { headers: auth, body: 'abc' })).status, 204);
    assert.equal((await req(port, 'POST', '/v1/calls/../../etc/start', { headers: auth, body: '{}' })).status, 404);
    assert.equal((await s.store.read(ID)).phoneNumber, '+33612345678');
    // UI : sans session refusée, ticket à usage unique
    assert.equal((await req(port, 'GET', '/api/calls')).status, 401);
    const url = new URL(app.uiUrl());
    const first = await req(port, 'GET', url.pathname + url.search);
    assert.equal(first.status, 302);
    assert.match(first.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
    assert.equal((await req(port, 'GET', url.pathname + url.search)).status, 401, 'ticket réutilisé');
    const cookie = first.headers['set-cookie'][0].split(';')[0];
    assert.equal((await req(port, 'POST', `/api/calls/${ID}/retry`, { headers: { cookie } })).status, 403, 'POST sans en-tête anti-CSRF');
    const settings = await req(port, 'GET', '/api/settings', { headers: { cookie } });
    assert.equal(settings.status, 200);
    assert.ok(!settings.body.includes('sk-'), 'aucune clé renvoyée');
  } finally {
    await app.close();
  }
});

test('Keychain macOS : écriture, lecture, suppression (entrée de test)', { skip: process.platform !== 'darwin' }, async () => {
  const s = new Secrets({ service: 'Yada Recorder Test', env: {} });
  await s.set('deepgramKey', 'test-123_ABC');
  const fresh = new Secrets({ service: 'Yada Recorder Test', env: {} });
  assert.equal(await fresh.get('deepgramKey'), 'test-123_ABC');
  await fresh.set('deepgramKey', '');
  const after = new Secrets({ service: 'Yada Recorder Test', env: {} });
  assert.equal(await after.get('deepgramKey'), null);
});

test('Connexion de test Yadaphone (courte, sans son) : jetée sans traitement', async () => {
  let transcribed = 0;
  const s = setup({ transcribeFn: async () => { transcribed++; return { provider: 'deepgram', segments: [] }; } });
  await s.store.start(ID, { startedAt: new Date().toISOString() });
  await s.store.chunk(ID, 0, Buffer.from('webm'), Date.now());
  await s.store.end(ID, { chunks: 1, durationSec: 3, remotePeak: 0 });
  await s.pipeline.tick();
  assert.equal(await s.store.read(ID), null);
  assert.equal(transcribed, 0);
  assert.equal(s.rows.length, 0);
});
