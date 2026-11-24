// Transcription stéréo : canal 0 (gauche) = moi, canal 1 (droit) = l'interlocuteur.
// Chaque provider renvoie la même forme normalisée :
//   { provider, model, language, segments: [{ speaker: 'me'|'them', start, end, text }] }
const deepgram = require('./deepgram');
const elevenlabs = require('./elevenlabs');

const PROVIDERS = { deepgram, elevenlabs };

async function transcribe(provider, audio, opts) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Provider de transcription inconnu : ${provider}`);
  const out = await p.transcribe(audio, opts);
  out.segments = out.segments
    .filter((s) => s.text && s.text.trim())
    .map((s) => ({ ...s, text: s.text.trim(), start: round(s.start), end: round(s.end) }))
    .sort((a, b) => a.start - b.start || (a.speaker === 'me' ? -1 : 1));
  return out;
}

const round = (x) => Math.round((Number(x) || 0) * 100) / 100;

// Regroupe des mots horodatés d'un même canal en segments lisibles.
function wordsToSegments(words, speaker) {
  const segs = [];
  let cur = null;
  for (const w of words) {
    const text = String(w.text || '').trim();
    if (!text) continue;
    const start = Number(w.start) || 0;
    const end = Number(w.end) || start;
    const gap = cur ? start - cur.end : 0;
    const sentenceEnd = cur && /[.!?…]$/.test(cur.text);
    if (!cur || gap > 1.2 || (sentenceEnd && gap > 0.5) || end - cur.start > 30) {
      cur = { speaker, start, end, text };
      segs.push(cur);
    } else {
      cur.text += (/^[,.!?;:…%)]/.test(text) ? '' : ' ') + text;
      cur.end = end;
    }
  }
  return segs;
}

function mostCommon(list) {
  const counts = new Map();
  for (const x of list) if (x) counts.set(x, (counts.get(x) || 0) + 1);
  let best = null;
  for (const [k, v] of counts) if (!best || v > best[1]) best = [k, v];
  return best ? best[0] : null;
}

module.exports = { transcribe, wordsToSegments, mostCommon, PROVIDERS };
