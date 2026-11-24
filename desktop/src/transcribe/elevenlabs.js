// ElevenLabs Speech-to-Text (Scribe) : POST /v1/speech-to-text en multipart, use_multi_channel=true.
// Réponse multicanal : { transcripts: [{ channel_index, language_code, words: [{ text, type, start, end }] }] }
// Doc : https://elevenlabs.io/docs/api-reference/speech-to-text/convert
async function transcribe(audio, { apiKey, model = 'scribe_v2', language = 'multi', fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('Clé API ElevenLabs manquante (Réglages).');
  const form = new FormData();
  form.append('file', new Blob([audio], { type: 'audio/webm' }), 'call.webm');
  form.append('model_id', model);
  form.append('use_multi_channel', 'true');
  form.append('timestamps_granularity', 'word');
  form.append('tag_audio_events', 'false');
  form.append('diarize', 'false');
  if (language === 'fr' || language === 'en') form.append('language_code', language);

  const res = await fetchImpl('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: form,
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw Object.assign(new Error(`ElevenLabs ${res.status} : ${body.slice(0, 300)}`), { status: res.status });
  }
  return normalize(await res.json(), model);
}

function normalize(json, model) {
  const { mostCommon, wordsToSegments } = require('./index');
  const parts = Array.isArray(json.transcripts) ? json.transcripts : [json];
  const segments = [];
  const langs = [];
  parts.forEach((t, i) => {
    langs.push(t.language_code);
    const words = (t.words || []).filter((w) => w.type === 'word' || w.type === undefined);
    // Sortie "combined" possible : chaque mot porte alors son channel_index.
    const byChannel = new Map();
    for (const w of words) {
      const ch = w.channel_index ?? t.channel_index ?? i;
      if (!byChannel.has(ch)) byChannel.set(ch, []);
      byChannel.get(ch).push(w);
    }
    for (const [ch, ws] of byChannel) segments.push(...wordsToSegments(ws, ch === 0 ? 'me' : 'them'));
  });
  return { provider: 'elevenlabs', model, language: mostCommon(langs), channels: parts.length, duration: json.audio_duration_secs || null, segments };
}

module.exports = { transcribe, normalize };
