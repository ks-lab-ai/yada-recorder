const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(r || {})));

async function refresh() {
  const s = await send({ type: 'status' });
  const dot = $('dot');
  dot.className = 'dot ' + (s.recording ? 'rec' : s.desktopUp && s.paired ? 'ok' : 'warn');
  $('state').textContent = s.recording ? '● REC' : s.desktopUp && s.paired ? 'actif' : '';
  $('desktop').textContent = !s.desktopUp ? 'injoignable' : s.paired ? (s.desktop === 'unpaired' ? 'token refusé' : 'connectée') : 'non appairée';
  $('pending').textContent = s.pending ? `${s.pending} élément(s)` : 'rien';
  $('consent').value = s.consentMode || 'us';
  $('port').value = s.port;
  $('debug').checked = !!s.debug;
  $('pair').textContent = s.paired ? 'Réappairer' : 'Appairer avec l’app';
}

$('consent').addEventListener('change', async (e) => {
  await send({ type: 'set-consent', consentMode: e.target.value });
});

$('pair').addEventListener('click', async () => {
  $('msg').textContent = 'Confirme l’appairage dans la fenêtre de l’app Yada Recorder…';
  const r = await send({ type: 'pair' });
  $('msg').textContent = r.ok ? 'Appairée.' : r.error || 'Échec.';
  refresh();
});

$('saveAdv').addEventListener('click', async () => {
  const token = $('token').value.trim();
  if (token) await send({ type: 'set-token', token });
  await send({ type: 'set-port', port: $('port').value });
  await send({ type: 'set-debug', debug: $('debug').checked });
  $('token').value = '';
  $('msg').textContent = 'Enregistré. Recharge l’onglet Yadaphone pour les logs.';
  refresh();
});

$('open').addEventListener('click', async () => {
  const r = await send({ type: 'open-transcripts', inTab: false });
  if (!r.ok) $('msg').textContent = r.reason === 'unpaired' ? 'Appaire d’abord l’extension.' : 'App injoignable.';
  else window.close();
});
$('openTab').addEventListener('click', async () => {
  const r = await send({ type: 'open-transcripts', inTab: true });
  if (!r.ok) $('msg').textContent = r.reason === 'unpaired' ? 'Appaire d’abord l’extension.' : 'App injoignable.';
  else window.close();
});

refresh();
