// Réglages non secrets (JSON dans le dossier de données de l'app). Les clés API vont dans
// le Keychain (secrets.js), jamais ici.
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  port: 47311,
  provider: 'deepgram', // 'deepgram' | 'elevenlabs'
  language: 'multi', // 'multi' (FR/EN mélangés) | 'auto' (détection par canal) | 'fr' | 'en'
  deepgramModel: 'nova-3',
  elevenlabsModel: 'scribe_v2',
  claudeModel: 'claude-sonnet-5-5',
  supabaseUrl: '',
  bucket: 'call-recordings',
  consentMode: 'us', // 'us' | 'all' | 'off'
  consentUpdatedAt: 0,
  launchAtLogin: true,
  notifications: true,
  firstRunDone: false,
};

class Config {
  constructor(dir, env = process.env) {
    this.file = path.join(dir, 'config.json');
    fs.mkdirSync(dir, { recursive: true });
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) {}
    this.data = { ...DEFAULTS, ...saved };
    // En dev, .env peut préremplir ce qui n'est pas encore réglé.
    if (!this.data.supabaseUrl && env.SUPABASE_URL) this.data.supabaseUrl = env.SUPABASE_URL;
    if (env.YADAREC_PORT) this.data.port = Number(env.YADAREC_PORT);
    if (!saved.provider && env.TRANSCRIPTION_PROVIDER) this.data.provider = env.TRANSCRIPTION_PROVIDER;
    this.listeners = new Set();
  }
  get(key) { return key ? this.data[key] : { ...this.data }; }
  set(patch) {
    const allowed = Object.keys(DEFAULTS);
    for (const [k, v] of Object.entries(patch)) if (allowed.includes(k) && v !== undefined) this.data[k] = v;
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    for (const fn of this.listeners) { try { fn(this.data); } catch (_) {} }
  }
  onChange(fn) { this.listeners.add(fn); }
}

module.exports = { Config, DEFAULTS };
