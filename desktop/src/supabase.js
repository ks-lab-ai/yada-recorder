// Accès Supabase avec la clé secrète (service_role) : la table et le bucket n'ont aucune
// policy RLS, donc seule cette clé, gardée dans le Keychain, peut lire ou écrire.
const { createClient } = require('@supabase/supabase-js');

const LIST_COLUMNS = 'id,started_at,ended_at,duration,phone_number,contact_name,direction,status,error,language,provider,summary';

class Remote {
  constructor({ url, key, bucket = 'call-recordings' }) {
    if (!url || !key) throw Object.assign(new Error('Supabase non configuré (URL et clé secrète dans Réglages).'), { config: true });
    this.bucket = bucket;
    this.db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  async upsertCall(row) {
    const { error } = await this.db.from('calls').upsert(row, { onConflict: 'id' });
    if (error) throw new Error(`Supabase (table calls) : ${error.message}`);
  }

  async uploadAudio(objectPath, buffer) {
    const { error } = await this.db.storage.from(this.bucket).upload(objectPath, buffer, { contentType: 'audio/webm', upsert: true });
    if (error) throw new Error(`Supabase Storage : ${error.message}`);
  }

  async signedUrl(objectPath, seconds = 3600) {
    const { data, error } = await this.db.storage.from(this.bucket).createSignedUrl(objectPath, seconds);
    if (error) throw new Error(`Supabase Storage : ${error.message}`);
    return data.signedUrl;
  }

  async search(q, limit = 200) {
    const { data, error } = await this.db.rpc('search_calls', { q: q || null, lim: limit, off: 0 }).select(LIST_COLUMNS);
    if (error) throw new Error(`Supabase (recherche) : ${error.message}`);
    return data;
  }

  async get(id) {
    const { data, error } = await this.db.from('calls').select('*').eq('id', id).maybeSingle();
    if (error) throw new Error(`Supabase : ${error.message}`);
    return data;
  }

  async ping() {
    const { error } = await this.db.from('calls').select('id', { head: true, count: 'exact' }).limit(1);
    if (error) throw new Error(error.message);
    const b = await this.db.storage.getBucket(this.bucket);
    if (b.error) throw new Error(`bucket ${this.bucket} : ${b.error.message}`);
    return true;
  }
}

module.exports = { Remote };
