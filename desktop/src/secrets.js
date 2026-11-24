// Secrets dans le Keychain macOS (trousseau de session), via l'outil système /usr/bin/security.
// Aucune dépendance native. La valeur passe par stdin (mode interactif -i), pas par argv,
// pour ne jamais apparaître dans la liste des processus.
const { execFile, spawn } = require('child_process');

const NAMES = ['deepgramKey', 'elevenlabsKey', 'anthropicKey', 'supabaseServiceKey', 'extensionToken'];
const ENV = {
  deepgramKey: 'DEEPGRAM_API_KEY',
  elevenlabsKey: 'ELEVENLABS_API_KEY',
  anthropicKey: 'ANTHROPIC_API_KEY',
  supabaseServiceKey: 'SUPABASE_SECRET_KEY',
};

class Secrets {
  constructor({ service = 'Yada Recorder', env = process.env, backend } = {}) {
    this.service = service;
    this.env = env;
    this.cache = new Map();
    this.backend = backend || keychainBackend(service);
  }

  async get(name) {
    if (!NAMES.includes(name)) throw new Error(`secret inconnu: ${name}`);
    if (this.cache.has(name)) return this.cache.get(name);
    let v = await this.backend.get(name);
    if (!v && ENV[name] && this.env[ENV[name]]) v = this.env[ENV[name]]; // dev : .env, jamais persisté
    this.cache.set(name, v || null);
    return v || null;
  }

  async set(name, value) {
    if (!NAMES.includes(name)) throw new Error(`secret inconnu: ${name}`);
    value = (value || '').trim();
    if (!value) {
      await this.backend.delete(name);
      this.cache.set(name, null);
      return;
    }
    if (!/^[\x21-\x7e]+$/.test(value) || /["\\]/.test(value)) throw new Error('Caractères non supportés dans la clé.');
    await this.backend.set(name, value);
    this.cache.set(name, value);
  }

  async has() {
    const out = {};
    for (const n of NAMES) out[n] = !!(await this.get(n));
    return out;
  }
}

function keychainBackend(service) {
  return {
    get(name) {
      return new Promise((resolve) => {
        execFile('/usr/bin/security', ['find-generic-password', '-a', name, '-s', service, '-w'], (err, stdout) => {
          resolve(err ? null : stdout.replace(/\n$/, ''));
        });
      });
    },
    set(name, value) {
      return new Promise((resolve, reject) => {
        const p = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
        let errOut = '';
        p.stderr.on('data', (d) => { errOut += d; });
        p.on('close', (code) => (code === 0 && !/error/i.test(errOut) ? resolve() : reject(new Error(`Keychain: ${errOut.trim() || code}`))));
        p.stdin.end(`add-generic-password -U -a "${name}" -s "${service}" -l "${service} (${name})" -w "${value}"\n`);
      });
    },
    delete(name) {
      return new Promise((resolve) => {
        execFile('/usr/bin/security', ['delete-generic-password', '-a', name, '-s', service], () => resolve());
      });
    },
  };
}

function memoryBackend() {
  const m = new Map();
  return { get: async (n) => m.get(n) || null, set: async (n, v) => { m.set(n, v); }, delete: async (n) => { m.delete(n); } };
}

module.exports = { Secrets, memoryBackend, NAMES };
