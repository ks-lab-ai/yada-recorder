// Pipeline de fin d'appel, piloté par l'état persistant de chaque appel (meta.json) :
//   recording -> ended -> queued -> (upload, transcription, résumé, sauvegarde) -> dossier supprimé
// En cas d'échec : state 'error' + nouvel essai planifié (1 min, 5 min, 15 min, 1 h, puis toutes les 3 h).
// Chaque étape réussie est mémorisée : un nouvel essai ne refait ni l'upload ni la transcription.
const fsp = require('fs').promises;
const { transcribe } = require('./transcribe');
const { summarize } = require('./summarize');
const { transcriptText } = require('./format');
const { Remote } = require('./supabase');

const TICK_MS = 5000;
const END_GRACE_MS = 20000; // attente des chunks encore en vol après la fin d'appel
const STALE_MS = 3 * 60 * 1000; // plus aucun chunk depuis 3 min sans fin reçue : appel terminé
const BACKOFF_MS = [60e3, 5 * 60e3, 15 * 60e3, 60 * 60e3, 3 * 60 * 60e3];

class Pipeline {
  constructor({ store, config, secrets, notify = () => {}, log = console, remoteFactory, transcribeFn = transcribe, summarizeFn = summarize, now = Date.now }) {
    this.store = store;
    this.config = config;
    this.secrets = secrets;
    this.notify = notify;
    this.log = log;
    this.transcribeFn = transcribeFn;
    this.summarizeFn = summarizeFn;
    this.now = now;
    this.remoteFactory = remoteFactory || (async () => new Remote({
      url: this.config.get('supabaseUrl'),
      key: await this.secrets.get('supabaseServiceKey'),
      bucket: this.config.get('bucket'),
    }));
    this.running = false;
    this.listeners = new Set();
  }

  async start() {
    // Un traitement coupé net (app quittée, Mac éteint) reprend au démarrage suivant.
    for (const m of await this.store.list()) {
      if (m.state === 'processing') await this.store.update(m.id, (cur) => ({ ...cur, state: 'queued', nextAttemptAt: 0 }));
    }
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }
  stop() { clearInterval(this.timer); }
  onChange(fn) { this.listeners.add(fn); }
  emit() { for (const fn of this.listeners) { try { fn(); } catch (_) {} } }

  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.finalize();
      await this.processDue();
    } catch (e) {
      this.log.error('[pipeline] tick', e);
    } finally {
      this.running = false;
    }
  }

  async finalize() {
    const now = this.now();
    for (const m of await this.store.list()) {
      if (m.state === 'recording' && now - (m.lastActivityAt || 0) > STALE_MS) {
        await this.store.end(m.id, { endedAt: new Date(m.lastChunkAt || m.lastActivityAt || now).toISOString(), reason: 'stale' });
        continue;
      }
      if (m.state === 'discard') {
        await this.store.remove(m.id);
        continue;
      }
      if (m.state !== 'ended') continue;
      const files = await this.store.chunkFiles(m.id);
      const complete = m.expectedChunks != null && files.length >= m.expectedChunks;
      if (!complete && now - (m.endReceivedAt || 0) < END_GRACE_MS) continue;
      const audio = await this.store.assemble(m.id);
      if (!audio) {
        this.log.warn('[pipeline] appel sans audio, ignoré', m.id);
        await this.store.remove(m.id);
        continue;
      }
      await this.store.update(m.id, (cur) => ({ ...cur, state: 'queued', nextAttemptAt: 0 }));
      this.emit();
    }
  }

  async processDue() {
    const now = this.now();
    const due = (await this.store.list())
      .filter((m) => (m.state === 'queued' || m.state === 'error') && (m.nextAttemptAt || 0) <= now)
      .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
    for (const m of due) await this.run(m.id);
  }

  retry(id) {
    return this.store.update(id, (cur) => (cur && cur.state === 'error' ? { ...cur, state: 'queued', nextAttemptAt: 0 } : cur))
      .then(() => this.tick());
  }

  async retryAll() {
    for (const m of await this.store.list()) if (m.state === 'error') await this.retry(m.id);
  }

  async run(id) {
    let meta = await this.store.read(id);
    if (!meta) return;
    const save = async (patch) => { meta = await this.store.update(id, (cur) => ({ ...cur, ...patch })); };
    await save({ state: 'processing' });
    this.emit();

    const started = meta.startedAt ? new Date(meta.startedAt) : new Date();
    const ended = meta.endedAt ? new Date(meta.endedAt) : null;
    const duration = meta.durationSec != null ? Math.round(meta.durationSec) : ended ? Math.max(0, Math.round((ended - started) / 1000)) : null;
    const row = {
      id: meta.id,
      started_at: started.toISOString(),
      ended_at: ended ? ended.toISOString() : null,
      duration,
      phone_number: meta.phoneNumber || null,
      contact_name: meta.contactName || null,
      direction: meta.direction || 'unknown',
    };
    let remote = null;

    try {
      remote = await this.remoteFactory();
      const audio = await fsp.readFile(this.store.audioPath(id));

      // 1-2. audio vers Supabase Storage (bucket privé)
      if (!meta.audioPath) {
        const objectPath = `${started.getUTCFullYear()}/${String(started.getUTCMonth() + 1).padStart(2, '0')}/${meta.id}.webm`;
        await remote.uploadAudio(objectPath, audio);
        await save({ audioPath: objectPath });
        await remote.upsertCall({ ...row, audio_path: objectPath, status: 'uploaded', error: null });
      }
      row.audio_path = meta.audioPath;

      // 3-4. transcription multicanal
      let tr = await this.store.loadJson(id, 'transcript.json');
      if (!tr) {
        const provider = this.config.get('provider');
        const keyName = provider === 'elevenlabs' ? 'elevenlabsKey' : 'deepgramKey';
        tr = await this.transcribeFn(provider, audio, {
          apiKey: await this.secrets.get(keyName),
          model: provider === 'elevenlabs' ? this.config.get('elevenlabsModel') : this.config.get('deepgramModel'),
          language: this.config.get('language'),
        });
        await this.store.saveJson(id, 'transcript.json', tr);
      }
      const text = transcriptText(tr.segments);
      const empty = tr.segments.length === 0;
      Object.assign(row, { transcript_json: tr, transcript_text: text, language: tr.language || null, provider: tr.provider });
      await remote.upsertCall({ ...row, status: empty ? 'empty' : 'transcribed', error: null });

      // 5. résumé + next steps (Claude)
      if (!empty && meta.summary === undefined) {
        const apiKey = await this.secrets.get('anthropicKey');
        if (!apiKey) {
          await save({ summary: null, summaryNote: 'Pas de clé Anthropic : résumé non généré.' });
        } else {
          try {
            const s = await this.summarizeFn({ apiKey, model: this.config.get('claudeModel'), transcriptText: text, meta: { ...meta, durationSec: duration } });
            await save({ summary: s.text });
          } catch (e) {
            if (!e.permanent) throw e;
            await save({ summary: null, summaryNote: e.message });
          }
        }
      }

      // 6. ligne finale
      await remote.upsertCall({ ...row, summary: meta.summary || null, status: empty ? 'empty' : 'done', error: null });

      // 7. plus rien à garder en local
      await this.store.remove(id);
      this.emit();
      this.notify({ id: meta.id, phoneNumber: meta.phoneNumber, contactName: meta.contactName, duration, empty, summary: meta.summary || null });
    } catch (e) {
      const attempts = (meta.attempts || 0) + 1;
      const delay = e.config ? 60e3 : BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
      const message = String(e && e.message ? e.message : e).slice(0, 500);
      this.log.warn(`[pipeline] ${id} essai ${attempts} échoué : ${message}`);
      await save({ state: 'error', attempts, lastError: message, nextAttemptAt: this.now() + delay });
      if (remote && meta.audioPath) {
        await remote.upsertCall({ ...row, audio_path: meta.audioPath, status: 'error', error: message }).catch(() => {});
      }
      this.emit();
    }
  }
}

module.exports = { Pipeline, END_GRACE_MS, STALE_MS };
