// Deepgram pre-recorded : POST /v1/listen, audio brut, multichannel=true.
// Avec utterances=true chaque utterance porte son `channel` : c'est notre séparation Moi / Interlocuteur.
// Doc : https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded
//       https://developers.deepgram.com/docs/multichannel
async function transcribe(audio, { apiKey, model = 'nova-3', language = 'multi', fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('Clé API Deepgram manquante (Réglages).');
  const params = new URLSearchParams({
    model,
    multichannel: 'true',
    utterances: 'true',
    smart_format: 'true',
    punctuate: 'true',
  });
  if (language === 'auto') params.set('detect_language', 'true');
  else params.set('language', language); // 'multi' = nova-3 multilingue (FR/EN mélangés)

  const res = await fetchImpl(`https://api.deepgram.com/v1/listen?${params}`, {
    method: 'POST',
    headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'audio/webm' },
    body: audio,
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Si le mode multilingue est refusé avec ce fichier, on retente en détection de langue par canal.
    if (res.status === 400 && language === 'multi') return transcribe(audio, { apiKey, model, language: 'auto', fetchImpl });
    throw Object.assign(new Error(`Deepgram ${res.status} : ${body.slice(0, 300)}`), { status: res.status });
  }
  return normalize(await res.json(), model);
}

function normalize(json, model) {
  const { mostCommon, wordsToSegments } = require('./index');
  const results = json.results || {};
  const channels = results.channels || [];
  let segments;
  if (Array.isArray(results.utterances) && results.utterances.length) {
    segments = results.utterances.map((u) => ({
      speaker: (u.channel || 0) === 0 ? 'me' : 'them',
      start: u.start,
      end: u.end,
      text: u.transcript,
    }));
  } else {
    segments = channels.flatMap((c, i) => {
      const words = ((c.alternatives && c.alternatives[0] && c.alternatives[0].words) || [])
        .map((w) => ({ text: w.punctuated_word || w.word, start: w.start, end: w.end }));
      return wordsToSegments(words, i === 0 ? 'me' : 'them');
    });
  }
  const langs = channels.map((c) => c.detected_language).filter(Boolean);
  if (!langs.length) {
    for (const u of results.utterances || []) for (const l of u.languages || []) langs.push(l);
  }
  return {
    provider: 'deepgram',
    model,
    language: mostCommon(langs),
    channels: channels.length || (json.metadata && json.metadata.channels) || null,
    duration: json.metadata ? json.metadata.duration : null,
    segments,
  };
}

module.exports = { transcribe, normalize };
