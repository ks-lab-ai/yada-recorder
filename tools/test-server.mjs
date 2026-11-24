#!/usr/bin/env node
// Étape 2 (test sans l'app desktop) : faux serveur local qui reçoit ce que l'extension envoie
// et reconstitue un fichier webm stéréo par appel dans tools/out/.
//   node tools/test-server.mjs            (port 47311, token "dev-token")
// Dans le popup de l'extension > Avancé : coller le token "dev-token".
// Vérifier ensuite : ffprobe tools/out/<id>.webm  (doit afficher "stereo").
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 47311);
const TOKEN = process.env.TOKEN || 'dev-token';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out');
fs.mkdirSync(OUT, { recursive: true });
const calls = new Map();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean);
  const done = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(body ? JSON.stringify(body) : ''); };
  if (url.pathname === '/health') return done(200, { ok: true, app: 'yada-recorder-test' });
  if (url.pathname === '/pair') return done(200, { token: TOKEN });
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return done(401, { error: 'token' });
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (parts[0] === 'v1' && parts[1] === 'config') return req.method === 'GET' ? done(200, { consentMode: 'us', consentUpdatedAt: 0 }) : done(204);
    if (parts[0] === 'v1' && ['open', 'ui-ticket'].includes(parts[1])) return done(200, { url: 'about:blank' });
    if (parts[0] !== 'v1' || parts[1] !== 'calls') return done(404);
    const id = parts[2];
    const file = path.join(OUT, `${id}.webm`);
    if (!calls.has(id)) calls.set(id, { seqs: new Set() });
    const c = calls.get(id);
    if (parts[3] === 'chunks') {
      const seq = Number(parts[4]);
      fs.writeFileSync(path.join(OUT, `${id}.${String(seq).padStart(6, '0')}.part`), body);
      c.seqs.add(seq);
      console.log(`chunk ${id.slice(0, 8)} #${seq} ${body.length} o`);
      return done(204);
    }
    const json = body.length ? JSON.parse(body) : {};
    console.log(parts[3].toUpperCase(), id.slice(0, 8), JSON.stringify(json));
    if (parts[3] === 'end') {
      setTimeout(() => {
        const partFiles = fs.readdirSync(OUT).filter((f) => f.startsWith(id) && f.endsWith('.part')).sort();
        fs.writeFileSync(file, Buffer.concat(partFiles.map((f) => fs.readFileSync(path.join(OUT, f)))));
        partFiles.forEach((f) => fs.unlinkSync(path.join(OUT, f)));
        fs.writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify(json, null, 2));
        console.log(`=> ${file} (${partFiles.length} chunks)`);
      }, 3000);
    }
    return done(204);
  });
});
server.listen(PORT, '127.0.0.1', () => console.log(`Serveur de test sur http://127.0.0.1:${PORT} (token: ${TOKEN})`));
