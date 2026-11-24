// Cache local des appels : <dataDir>/calls/<id>/{meta.json, chunks/*.webm, audio.webm, transcript.json}
// meta.json est aussi l'état persistant de la file de traitement (survit aux redémarrages).
// Le dossier d'un appel est supprimé dès que l'audio est dans Supabase et la ligne enregistrée.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SEQ = 100000;

class CallStore {
  constructor(dataDir) {
    this.root = path.join(dataDir, 'calls');
    fs.mkdirSync(this.root, { recursive: true });
    this.locks = new Map();
  }

  static validId(id) { return ID_RE.test(id); }

  dir(id) {
    if (!ID_RE.test(id)) throw Object.assign(new Error('id invalide'), { status: 400 });
    return path.join(this.root, id.toLowerCase());
  }

  // Sérialise les opérations par appel (chunks et méta arrivent en rafale).
  withLock(id, fn) {
    const prev = this.locks.get(id) || Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(id, next.catch(() => {}));
    return next;
  }

  async read(id) {
    try { return JSON.parse(await fsp.readFile(path.join(this.dir(id), 'meta.json'), 'utf8')); }
    catch (_) { return null; }
  }

  async write(id, meta) {
    const d = this.dir(id);
    await fsp.mkdir(d, { recursive: true });
    const file = path.join(d, 'meta.json');
    await fsp.writeFile(file + '.tmp', JSON.stringify(meta, null, 2));
    await fsp.rename(file + '.tmp', file);
    return meta;
  }

  update(id, fn) {
    return this.withLock(id, async () => {
      const cur = await this.read(id);
      const next = await fn(cur);
      if (next) await this.write(id, next);
      return next;
    });
  }

  static clean(payload) {
    const pick = {};
    for (const k of ['startedAt', 'endedAt', 'phoneNumber', 'contactName', 'direction', 'mime', 'durationSec', 'reason']) {
      const v = payload && payload[k];
      if (v === undefined || v === null || v === '') continue;
      if (typeof v === 'string' && v.length > 200) continue;
      pick[k] = v;
    }
    if (pick.direction && !['outbound', 'inbound', 'unknown'].includes(pick.direction)) delete pick.direction;
    for (const k of ['startedAt', 'endedAt']) if (pick[k] && Number.isNaN(Date.parse(pick[k]))) delete pick[k];
    return pick;
  }

  blank(id, startedAt) {
    return { id: id.toLowerCase(), state: 'recording', startedAt: startedAt || new Date().toISOString(), direction: 'unknown', createdAt: new Date().toISOString(), attempts: 0 };
  }

  start(id, payload) {
    const p = CallStore.clean(payload);
    return this.update(id, (cur) => {
      const base = cur || this.blank(id, p.startedAt);
      return { ...base, ...p, ...(cur && cur.endedAt ? { endedAt: cur.endedAt } : {}), lastActivityAt: Date.now() };
    });
  }

  async chunk(id, seq, buf, at) {
    if (!Number.isInteger(seq) || seq < 0 || seq > MAX_SEQ) throw Object.assign(new Error('seq invalide'), { status: 400 });
    const d = this.dir(id);
    return this.withLock(id, async () => {
      let meta = await this.read(id);
      if (meta && !['recording', 'ended'].includes(meta.state)) return meta; // déjà assemblé : chunk en retard ignoré
      if (!meta) meta = this.blank(id, at ? new Date(at).toISOString() : null);
      await fsp.mkdir(path.join(d, 'chunks'), { recursive: true });
      await fsp.writeFile(path.join(d, 'chunks', `${String(seq).padStart(6, '0')}.webm`), buf);
      meta.lastActivityAt = Date.now();
      meta.lastChunkAt = at || Date.now();
      return this.write(id, meta);
    });
  }

  meta(id, payload) {
    const p = CallStore.clean(payload);
    return this.update(id, (cur) => ({ ...(cur || this.blank(id, p.startedAt)), ...p }));
  }

  end(id, payload) {
    const p = CallStore.clean(payload);
    const chunks = Number.isInteger(payload && payload.chunks) ? payload.chunks : null;
    // Connexion de test de Yadaphone (ouverte puis fermée au chargement, sans aucun son) : on jette.
    const peak = Number(payload && payload.remotePeak);
    const probe = Number.isFinite(peak) && peak < 0.003 && Number(p.durationSec) < 8;
    return this.update(id, (cur) => {
      const base = cur || this.blank(id, p.startedAt);
      if (base.endReceivedAt) {
        // Fin déjà reçue (ex. : fin synthétique "tab-closed" puis vraie fin) : on complète seulement.
        return { ...p, ...base, expectedChunks: base.expectedChunks ?? chunks };
      }
      return {
        ...base,
        ...p,
        state: base.state === 'recording' ? (probe ? 'discard' : 'ended') : base.state,
        expectedChunks: chunks,
        endReceivedAt: Date.now(),
      };
    });
  }

  async chunkFiles(id) {
    try {
      return (await fsp.readdir(path.join(this.dir(id), 'chunks'))).filter((f) => f.endsWith('.webm')).sort();
    } catch (_) { return []; }
  }

  // Concatène les chunks MediaRecorder dans l'ordre : le résultat est un webm valide.
  async assemble(id) {
    const d = this.dir(id);
    const files = await this.chunkFiles(id);
    const out = path.join(d, 'audio.webm');
    if (!files.length) {
      if (fs.existsSync(out)) return out;
      return null;
    }
    const tmp = out + '.tmp';
    const ws = fs.createWriteStream(tmp);
    for (const f of files) {
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(path.join(d, 'chunks', f));
        rs.on('error', reject);
        rs.on('end', resolve);
        rs.pipe(ws, { end: false });
      });
    }
    await new Promise((resolve, reject) => { ws.on('error', reject); ws.end(resolve); });
    await fsp.rename(tmp, out);
    await fsp.rm(path.join(d, 'chunks'), { recursive: true, force: true });
    return out;
  }

  audioPath(id) { return path.join(this.dir(id), 'audio.webm'); }

  async saveJson(id, name, data) {
    await fsp.writeFile(path.join(this.dir(id), name), JSON.stringify(data));
  }
  async loadJson(id, name) {
    try { return JSON.parse(await fsp.readFile(path.join(this.dir(id), name), 'utf8')); } catch (_) { return null; }
  }

  async remove(id) {
    await fsp.rm(this.dir(id), { recursive: true, force: true });
  }

  async list() {
    let ids = [];
    try { ids = await fsp.readdir(this.root); } catch (_) {}
    const out = [];
    for (const id of ids) {
      if (!ID_RE.test(id)) continue;
      const m = await this.read(id);
      if (m) out.push(m);
    }
    return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  }
}

module.exports = { CallStore };
