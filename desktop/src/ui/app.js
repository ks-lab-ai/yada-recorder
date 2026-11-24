// Fenêtre Transcripts : liste + recherche + détail, et Réglages. Vanilla JS, aucune dépendance.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'X-Requested-With': 'yadarec', ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

const STATUS = {
  processing: ['En cours', 'busy'], uploaded: ['Audio envoyé', 'busy'], transcribed: ['Résumé en cours', 'busy'],
  done: ['Prêt', 'done'], empty: ['Sans parole', ''], error: ['Erreur', 'error'],
};
const LOCAL = { recording: ['Enregistrement…', 'busy'], ended: ['Finalisation', 'busy'], queued: ['En file', 'busy'], processing: ['Traitement', 'busy'], error: ['Erreur, nouvel essai auto', 'error'] };

function fmtDur(sec) {
  if (sec == null) return '';
  sec = Math.round(sec);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m ? `${m} min ${String(s).padStart(2, '0')}` : `${s} s`;
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return sameDay ? `Aujourd’hui ${time}` : `${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })} ${time}`;
}
function fmtTs(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}
function who(c) {
  return c.contact_name || c.contactName || c.phone_number || c.phoneNumber || 'Numéro inconnu';
}
function dirIcon(d) { return d === 'inbound' ? '↙ entrant' : d === 'outbound' ? '↗ sortant' : ''; }

// Mini rendu Markdown pour le résumé (titres, puces, cases, gras).
function md(src) {
  const lines = String(src || '').split('\n');
  let html = '';
  let inList = false;
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  for (const raw of lines) {
    const l = raw.trim();
    const item = l.match(/^[-*]\s+(\[( |x|X)\]\s+)?(.*)$/);
    if (item) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += item[1] ? `<li class="task">${item[2].trim() ? '☑' : '☐'} ${inline(item[3])}</li>` : `<li>${inline(item[3])}</li>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    if (!l) continue;
    const h = l.match(/^#{1,4}\s+(.*)$/);
    html += h ? `<h3>${inline(h[1])}</h3>` : `<p>${inline(l)}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

function copy(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const old = btn.textContent;
    btn.textContent = 'Copié';
    setTimeout(() => { btn.textContent = old; }, 1200);
  });
}

// ------------------------------------------------------------------ liste
let selected = null;
let lastList = { calls: [], local: [] };

async function loadList() {
  const q = $('#q').value.trim();
  let data;
  try { data = await api(`/api/calls?q=${encodeURIComponent(q)}`); }
  catch (e) { data = { calls: [], local: [], error: e.message }; }
  lastList = data;
  const banner = $('#banner');
  if (data.error) {
    banner.hidden = false;
    banner.innerHTML = `${esc(data.error)} <a href="#/settings">Ouvrir les réglages</a>`;
  } else banner.hidden = true;

  const ul = $('#calls');
  const remoteIds = new Set(data.calls.map((c) => c.id));
  const local = q ? [] : data.local.filter((m) => !remoteIds.has(m.id) || m.state === 'error' || m.state === 'processing');
  let html = '';
  if (local.length) {
    html += '<li class="section-title">En cours de traitement</li>';
    for (const m of local) {
      const [label, cls] = LOCAL[m.state] || [m.state, ''];
      const retry = m.state === 'error' && m.nextAttemptAt ? ` · nouvel essai ${new Date(m.nextAttemptAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}` : '';
      html += `<li data-local="${esc(m.id)}">
        <span class="who">${esc(who(m))}</span><span class="when">${esc(fmtDate(m.startedAt))}</span>
        <span class="meta"><span class="badge ${cls}">${esc(label)}</span>${esc(retry)}</span>
        ${m.lastError ? `<span class="snippet err">${esc(m.lastError)}</span>` : ''}
      </li>`;
    }
    if (data.calls.length) html += '<li class="section-title">Appels</li>';
  }
  for (const c of data.calls) {
    const [label, cls] = STATUS[c.status] || [c.status, ''];
    const snippet = (c.summary || '').replace(/^#+.*$/gm, '').replace(/\s+/g, ' ').trim().slice(0, 180);
    html += `<li data-id="${esc(c.id)}" class="${c.id === selected ? 'sel' : ''}">
      <span class="who">${esc(who(c))}</span><span class="when">${esc(fmtDate(c.started_at))}</span>
      <span class="meta">${c.contact_name && c.phone_number ? `<span>${esc(c.phone_number)}</span>` : ''}<span>${esc(fmtDur(c.duration))}</span><span>${esc(dirIcon(c.direction))}</span>${c.status !== 'done' ? `<span class="badge ${cls}">${esc(label)}</span>` : ''}</span>
      ${snippet ? `<span class="snippet">${esc(snippet)}</span>` : ''}
    </li>`;
  }
  ul.innerHTML = html;
  $('#empty').hidden = !!(data.calls.length || local.length) || !!data.error;
  if (q && !data.calls.length && !data.error) { $('#empty').hidden = false; $('#empty').textContent = 'Aucun résultat.'; }
  else $('#empty').textContent = 'Aucun appel pour l’instant. Passe un appel sur yadaphone.com : il apparaîtra ici.';
}

$('#calls').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id], li[data-local]');
  if (!li) return;
  if (li.dataset.id) location.hash = `#/call/${li.dataset.id}`;
  else showLocal(li.dataset.local);
});

function showLocal(id) {
  const m = lastList.local.find((x) => x.id === id);
  if (!m) return;
  const [label] = LOCAL[m.state] || [m.state];
  $('#detail').innerHTML = `<h1>${esc(who(m))}</h1>
    <div class="sub"><span>${esc(fmtDate(m.startedAt))}</span><span>${esc(label)}</span><span>${m.attempts ? `${m.attempts} essai(s)` : ''}</span></div>
    ${m.lastError ? `<div class="card"><div class="card-head"><h2>Dernière erreur</h2></div><p class="err">${esc(m.lastError)}</p></div>` : ''}
    ${m.state === 'error' ? '<button class="primary" id="retryBtn">Réessayer maintenant</button>' : '<p class="muted">L’appel est traité automatiquement : upload, transcription, résumé.</p>'}`;
  const b = $('#retryBtn');
  if (b) b.onclick = async () => { b.disabled = true; await api(`/api/calls/${id}/retry`, { method: 'POST' }); setTimeout(loadList, 1500); };
}

// ------------------------------------------------------------------ détail
async function showCall(id) {
  selected = id;
  for (const li of document.querySelectorAll('#calls li')) li.classList.toggle('sel', li.dataset.id === id);
  const el = $('#detail');
  el.innerHTML = '<p class="muted center pad">Chargement…</p>';
  let c;
  try { c = await api(`/api/calls/${id}`); }
  catch (e) { el.innerHTML = `<p class="err pad">${esc(e.message)}</p>`; return; }
  if (selected !== id) return;
  const segs = (c.transcript_json && c.transcript_json.segments) || [];
  const turns = [];
  for (const s of segs) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === s.speaker && s.start - last.end < 2) { last.text += ' ' + s.text; last.end = s.end; }
    else turns.push({ ...s });
  }
  const [label, cls] = STATUS[c.status] || [c.status, ''];
  el.innerHTML = `
    <h1>${esc(who(c))}</h1>
    <div class="sub">
      ${c.contact_name && c.phone_number ? `<span>${esc(c.phone_number)}</span>` : ''}
      <span>${esc(fmtDate(c.started_at))}</span><span>${esc(fmtDur(c.duration))}</span><span>${esc(dirIcon(c.direction))}</span>
      ${c.language ? `<span>${esc(c.language.toUpperCase())}</span>` : ''}
      ${c.status !== 'done' ? `<span class="badge ${cls}">${esc(label)}</span>` : ''}
    </div>
    ${c.audio_path ? '<audio id="player" controls preload="metadata"></audio>' : ''}
    ${c.error ? `<div class="card"><p class="err">${esc(c.error)}</p></div>` : ''}
    <div class="card">
      <div class="card-head"><h2>Résumé et next steps</h2>${c.summary ? '<button id="copySummary">Copier</button>' : ''}</div>
      <div class="summary">${c.summary ? md(c.summary) : `<p class="muted">${c.status === 'empty' ? 'Aucune parole détectée (pas de réponse, messagerie ou appel coupé).' : 'Pas de résumé.'}</p>`}</div>
    </div>
    <div class="card">
      <div class="card-head"><h2>Transcript</h2>${c.transcript_text ? '<button id="copyTranscript">Copier</button>' : ''}</div>
      <div class="turns">${turns.map((t) => `
        <div class="turn ${t.speaker}">
          <button class="t" data-t="${t.start}">${fmtTs(t.start)}</button>
          <span class="sp">${t.speaker === 'me' ? 'Moi' : 'Interlocuteur'}</span>
          <span>${esc(t.text)}</span>
        </div>`).join('') || '<p class="muted">Pas de transcript.</p>'}</div>
    </div>`;

  const cs = $('#copySummary');
  if (cs) cs.onclick = () => copy(c.summary, cs);
  const ct = $('#copyTranscript');
  if (ct) ct.onclick = () => copy(c.transcript_text, ct);

  const player = $('#player');
  if (player) {
    api(`/api/calls/${id}/audio`).then(({ url }) => {
      if (selected !== id) return;
      player.src = url;
      // Les webm de MediaRecorder n'ont pas de durée dans l'en-tête : on force son calcul.
      player.addEventListener('loadedmetadata', function fix() {
        if (player.duration === Infinity) {
          player.currentTime = 1e9;
          player.addEventListener('timeupdate', function back() { player.removeEventListener('timeupdate', back); player.currentTime = 0; });
        }
        player.removeEventListener('loadedmetadata', fix);
      });
    }).catch(() => {});
    el.onclick = (e) => {
      const b = e.target.closest('button.t');
      if (!b) return;
      player.currentTime = Number(b.dataset.t) || 0;
      player.play();
    };
  }
}

// ------------------------------------------------------------------ réglages
const SECRET_FIELDS = ['supabaseServiceKey', 'deepgramKey', 'elevenlabsKey', 'anthropicKey'];

async function loadSettings() {
  const s = await api('/api/settings');
  const f = $('#settingsForm');
  for (const [k, v] of Object.entries(s.config)) {
    const input = f.elements[k];
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = !!v;
    else input.value = v ?? '';
  }
  for (const k of SECRET_FIELDS) {
    const input = f.elements[k];
    input.value = '';
    input.placeholder = s.secrets[k] ? '•••••••• enregistrée (laisser vide pour garder)' : 'non renseignée';
  }
  $('#token').textContent = s.token;
  $('#version').textContent = `Yada Recorder ${s.version}`;
}

$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const config = {};
  for (const k of ['supabaseUrl', 'provider', 'language', 'deepgramModel', 'elevenlabsModel', 'claudeModel', 'consentMode']) config[k] = f.elements[k].value.trim();
  config.launchAtLogin = f.elements.launchAtLogin.checked;
  config.notifications = f.elements.notifications.checked;
  config.supabaseUrl = config.supabaseUrl.replace(/\/+$/, '');
  const secrets = {};
  for (const k of SECRET_FIELDS) if (f.elements[k].value.trim()) secrets[k] = f.elements[k].value.trim();
  $('#saveMsg').textContent = 'Enregistrement…';
  try {
    await api('/api/settings', { method: 'POST', body: JSON.stringify({ config, secrets }) });
    $('#saveMsg').textContent = 'Enregistré.';
    await loadSettings();
  } catch (err) {
    $('#saveMsg').textContent = err.message;
  }
});

$('#testBtn').addEventListener('click', async () => {
  const out = $('#testOut');
  out.hidden = false;
  out.textContent = 'Test en cours…';
  try {
    const r = await api('/api/test', { method: 'POST' });
    out.textContent = `Supabase : ${r.supabase}\nTranscription : ${r.transcription}\nClaude : ${r.claude}`;
  } catch (e) { out.textContent = e.message; }
});
$('#copyToken').addEventListener('click', (e) => copy($('#token').textContent, e.target));

// ------------------------------------------------------------------ routage
function route() {
  const h = location.hash || '#/';
  const settings = h.startsWith('#/settings');
  $('#viewSettings').hidden = !settings;
  $('#viewList').hidden = settings;
  $('#navSettings').classList.toggle('active', settings);
  $('#navList').classList.toggle('active', !settings);
  $('#q').disabled = settings;
  if (settings) return loadSettings();
  const m = h.match(/^#\/call\/([0-9a-f-]{36})/i);
  if (m) showCall(m[1]);
}
window.addEventListener('hashchange', route);

let qTimer = null;
$('#q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(loadList, 250); });

loadList().then(route);
setInterval(() => { if (!$('#viewList').hidden && !$('#q').value) loadList(); }, 15000);
