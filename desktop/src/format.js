const LABELS = { me: 'Moi', them: 'Interlocuteur' };

function ts(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// Fusionne les segments consécutifs d'un même locuteur, puis une ligne par tour de parole.
function transcriptText(segments) {
  const turns = [];
  for (const s of segments) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === s.speaker && s.start - last.end < 2) {
      last.text += ' ' + s.text;
      last.end = s.end;
    } else {
      turns.push({ ...s });
    }
  }
  return turns.map((t) => `[${ts(t.start)}] ${LABELS[t.speaker] || t.speaker} : ${t.text}`).join('\n');
}

module.exports = { transcriptText, ts, LABELS };
