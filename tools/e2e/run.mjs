#!/usr/bin/env node
// Test bout en bout sans vrai appel : Chrome headless (profil jetable) joue un faux appel WebRTC,
// inject.js enregistre, le VRAI serveur + store + pipeline de l'app desktop traitent l'appel,
// avec Supabase / transcription / Claude simulés. Vérifie stéréo, canaux, consentement, nettoyage.
//   node tools/e2e/run.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const require = createRequire(path.join(root, 'desktop', 'package.json'));
const { Config } = require('./src/config.js');
const { Secrets, memoryBackend } = require('./src/secrets.js');
const { CallStore } = require('./src/store.js');
const { Pipeline } = require('./src/pipeline.js');
const { createServer } = require('./src/server.js');

const RINGBACK = process.argv.includes('--ringback');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yadarec-e2e-'));
const APP_PORT = 47399;
const PAGE_PORT = 47398;
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` : ${detail}` : ''}`); };

// ---------------------------------------------------------------- app desktop (vrais modules)
const config = new Config(path.join(tmp, 'data'), {});
config.set({ port: APP_PORT, supabaseUrl: 'https://example.supabase.co' });
const secrets = new Secrets({ backend: memoryBackend(), env: {} });
await secrets.set('extensionToken', 'e2e-token');
await secrets.set('deepgramKey', 'fake');
await secrets.set('anthropicKey', 'fake');
const store = new CallStore(path.join(tmp, 'data'));
const upserts = [];
let uploaded = null;
let notified = null;
const fakeRemote = {
  uploadAudio: async (p, buf) => { uploaded = { p, buf }; },
  upsertCall: async (row) => { upserts.push(structuredClone(row)); },
  search: async () => [], get: async () => null, signedUrl: async () => 'about:blank', ping: async () => true,
};
const pipeline = new Pipeline({
  store, config, secrets,
  remoteFactory: async () => fakeRemote,
  transcribeFn: async (provider, audio) => ({ provider, model: 'fake', language: 'en', segments: [{ speaker: 'them', start: 1.2, end: 2, text: 'Hello?' }, { speaker: 'me', start: 2.5, end: 4, text: 'Bonjour, ici Yada Recorder.' }], bytes: audio.length }),
  summarizeFn: async () => ({ text: '## Résumé\nTest.\n## Points clés\n- Aucun\n## Next steps\n- Aucun' }),
  notify: (n) => { notified = n; },
  log: { warn: console.warn, error: console.error },
});
const app = createServer({ config, secrets, store, pipeline, log: console });
await app.listen();

// ---------------------------------------------------------------- page + proxy vers l'app
let report = null;
const files = {
  '/': path.join(here, 'page.html'),
  '/shim.js': path.join(here, 'shim.js'),
  '/scenario.js': path.join(here, 'scenario.js'),
  '/inject.js': path.join(root, 'extension', 'src', 'inject.js'),
  '/consent-en.wav': path.join(root, 'extension', 'assets', 'consent-en.wav'),
};
const page = http.createServer((req, res) => {
  if (req.url.startsWith('/?')) req.url = '/';
  if (req.url === '/report') {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => { report = JSON.parse(b); res.end('ok'); });
    return;
  }
  if (req.url.startsWith('/v1/')) {
    const p = http.request({ host: '127.0.0.1', port: APP_PORT, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${APP_PORT}`, authorization: 'Bearer e2e-token' } }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    req.pipe(p);
    return;
  }
  const f = files[req.url];
  if (!f) { res.writeHead(404); return res.end(); }
  const type = f.endsWith('.html') ? 'text/html' : f.endsWith('.wav') ? 'audio/wav' : 'text/javascript';
  res.writeHead(200, { 'Content-Type': type });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => page.listen(PAGE_PORT, '127.0.0.1', r));

// ---------------------------------------------------------------- Chrome headless
const chromeLog = [];
const chrome = spawn(CHROME, [
  '--headless=new', `--user-data-dir=${path.join(tmp, 'chrome')}`, '--no-first-run', '--no-default-browser-check',
  '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--enable-logging=stderr', '--v=0', `http://127.0.0.1:${PAGE_PORT}/${RINGBACK ? '?ringback' : ''}`,
], { stdio: ['ignore', 'ignore', 'pipe'] });
chrome.stderr.on('data', (d) => { for (const l of String(d).split('\n')) if (/CONSOLE|yadarec/.test(l)) chromeLog.push(l); });

const deadline = Date.now() + 60000;
while (!report && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
check('Chrome a joué le faux appel', !!report, report ? '' : 'pas de rapport (timeout)');
if (report && report.errors.length) check('Pas d’erreur JS dans la page', false, report.errors.join(' | '));

// Laisse le temps au dernier chunk et à la fin d'arriver, puis fait tourner le pipeline.
for (let i = 0; i < 40 && !notified; i++) {
  await new Promise((r) => setTimeout(r, 500));
  await pipeline.tick();
}
chrome.kill('SIGTERM');

// ---------------------------------------------------------------- vérifications
const start = upserts[0];
check('Upload dans le bucket', !!uploaded, uploaded ? `${uploaded.p}, ${uploaded.buf.length} octets` : '');
check('Numéro capté depuis le DOM', start && start.phone_number === '+14155550132', start && start.phone_number);
check('Sens de l’appel', start && start.direction === 'outbound', start && start.direction);
const final = upserts[upserts.length - 1];
check('Ligne finale status=done avec résumé et transcript', final && final.status === 'done' && !!final.summary && !!final.transcript_text, final && final.status);
check('Durée cohérente (~13 s)', final && final.duration >= 11 && final.duration <= 16, final && String(final.duration));
check('Notification émise', !!notified);
check('Cache local purgé après upload', fs.readdirSync(path.join(tmp, 'data', 'calls')).length === 0);

if (uploaded) {
  const webm = path.join(tmp, 'call.webm');
  fs.writeFileSync(webm, uploaded.buf);
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', webm]).toString());
  const a = probe.streams.find((s) => s.codec_type === 'audio');
  check('Fichier webm/opus stéréo', a && a.codec_name === 'opus' && a.channels === 2, a ? `${a.codec_name}, ${a.channels} canaux` : 'pas de flux audio');
  // Décodage PCM et fréquence dominante par canal (passages par zéro) entre 6 s et 11 s.
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', webm, '-f', 'f32le', '-ac', '2', '-ar', '48000', '-'], { maxBuffer: 1 << 28 });
  const f32 = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const freq = (ch, t1, t2) => {
    let z = 0; let prev = 0; let rms = 0; let n = 0;
    for (let i = Math.floor(t1 * 48000); i < Math.min(f32.length / 2, t2 * 48000); i++) {
      const v = f32[i * 2 + ch];
      if (prev <= 0 && v > 0) z++;
      prev = v; rms += v * v; n++;
    }
    return { hz: n ? Math.round(z / (n / 48000)) : 0, rms: n ? Math.sqrt(rms / n) : 0 };
  };
  const [w1, w2] = RINGBACK ? [11.5, 13.5] : [6, 11]; // après le message de consentement
  const L = freq(0, w1, w2);
  const R = freq(1, w1, w2);
  check('Canal gauche = moi (300 Hz)', Math.abs(L.hz - 300) < 30 && L.rms > 0.005, `${L.hz} Hz, rms ${L.rms.toFixed(3)}`);
  check('Canal droit = interlocuteur (1200 Hz)', Math.abs(R.hz - 1200) < 60 && R.rms > 0.02, `${R.hz} Hz, rms ${R.rms.toFixed(3)}`);
  if (!RINGBACK) {
    const Lc = freq(0, 1.5, 3.5);
    check('Consentement présent sur le canal « moi »', Lc.rms > L.rms * 2, `rms pendant ${Lc.rms.toFixed(3)} vs après ${L.rms.toFixed(3)}`);
  }
}

if (report) {
  const tStart = (report.events.find((e) => e.t === 'call-start') || {}).at;
  const tConsent = (report.events.find((e) => e.t === 'state' && e.consent === true) || {}).at;
  const delay = tConsent && tStart ? Math.round(tConsent - tStart) : null;
  if (RINGBACK) check('Pas de message pendant la sonnerie, joué après le décroché (6,5 s)', delay > 6500 && delay < 8500, `message à ${delay} ms`);
  else check('Message joué juste après le décroché', delay !== null && delay < 2500, `message à ${delay} ms`);
  const during = report.bRms.filter(([t]) => t > 1500 && t < 3500).map(([, v]) => v);
  const after = report.bRms.filter(([t]) => t > 6000 && t < 11000).map(([, v]) => v);
  const avg = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
  if (!RINGBACK) check('Consentement envoyé dans la ligne (reçu côté réseau)', avg(during) > avg(after) * 2, `rms reçu ${avg(during).toFixed(3)} pendant vs ${avg(after).toFixed(3)} après`);
  check('Micro rétabli après le message', avg(after) > 0.005, `rms ${avg(after).toFixed(3)}`);
  const ev = report.events.map((e) => e.t);
  check('Séquence call-start → chunks → call-end', ev.indexOf('call-start') < ev.indexOf('chunk') && ev.lastIndexOf('chunk') < ev.indexOf('call-end'), ev.filter((t) => t !== 'state').join(','));
}

const logLines = chromeLog.filter((l) => /yadarec/.test(l)).slice(0, 12);
if (logLines.length) console.log('\nLogs [yadarec] de la page :\n' + logLines.map((l) => '  ' + l.replace(/^.*CONSOLE\(\d+\)\]\s*/, '').slice(0, 160)).join('\n'));

await app.close();
page.close();
fs.rmSync(tmp, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} vérifications OK`);
process.exit(failed ? 1 : 0);
