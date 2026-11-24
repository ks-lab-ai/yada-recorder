// Yada Recorder : content script isolé (accès aux API chrome.*).
// - relaie au service worker ce que inject.js (monde MAIN) envoie ;
// - pousse la config (consentement, debug) vers inject.js ;
// - ajoute le bouton « Transcripts » dans la nav et l'indicateur « ● REC ».
(() => {
  const isTop = window === window.top;

  // ------------------------------------------------------------ relais
  function toPage(msg) {
    document.dispatchEvent(new CustomEvent('yadarec:to-page', { detail: JSON.stringify(msg) }));
  }

  function sendToWorker(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
    } catch (_) {
      // Extension rechargée pendant que la page reste ouverte : plus de canal.
    }
  }

  document.addEventListener('yadarec:to-ext', (e) => {
    let m;
    try { m = JSON.parse(e.detail); } catch (_) { return; }
    switch (m.t) {
      case 'hello':
        pushConfig();
        break;
      case 'call-start':
      case 'chunk':
      case 'call-meta':
      case 'call-end':
        sendToWorker({ type: 'rec', msg: m });
        break;
      case 'state':
        if (isTop) setRecState(m);
        else sendToWorker({ type: 'frame-state', msg: m });
        break;
    }
  });

  async function pushConfig() {
    const { consentMode = 'us', debug = false } = await chrome.storage.local.get(['consentMode', 'debug']);
    toPage({ t: 'config', config: { consentMode, debug, consentUrl: chrome.runtime.getURL('assets/consent-en.wav') } });
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.consentMode || changes.debug)) pushConfig();
  });
  pushConfig();

  if (!isTop) return;

  // Un appel enregistré dans une iframe remonte son état par le worker.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'frame-state') setRecState(msg.msg);
  });

  // ------------------------------------------------------------ indicateur permanent
  // Toujours visible en haut à droite, sous la nav :
  //   vert   « Recorder actif »             tout est prêt
  //   orange « app hors ligne / appairage » les appels restent enregistrés et mis en attente
  //   rouge  « ● REC 1:23 »                 appel en cours d'enregistrement
  //   rouge  « Recorder inactif »           le patch WebRTC n'est pas chargé (recharger la page)
  const COLORS = { ok: '#22c55e', warn: '#f59e0b', rec: '#ff4d4f', off: '#ef4444' };
  const status = { patch: false, desktopUp: null, paired: null, pending: 0, recording: false, consent: false, recStart: 0 };
  let pill = null;
  let tick = null;

  function fmt(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function ensurePill() {
    if (pill) return pill;
    const style = document.createElement('style');
    style.textContent = `
      @keyframes yadarecBlink{0%,100%{opacity:1}50%{opacity:.3}}
      #yadarec-indicator{position:fixed;right:14px;top:76px;z-index:2147483647;display:flex;align-items:center;gap:7px;
        font:600 12px/1 system-ui,-apple-system,sans-serif;letter-spacing:.01em;padding:7px 11px 7px 9px;border-radius:999px;
        background:rgba(17,17,17,.78);color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.18);cursor:pointer;user-select:none;
        opacity:.75;transition:opacity .2s}
      #yadarec-indicator:hover,#yadarec-indicator[data-state=rec],#yadarec-indicator[data-state=warn],#yadarec-indicator[data-state=off]{opacity:1}
      #yadarec-indicator i{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none}
      #yadarec-indicator[data-state=rec] i{animation:yadarecBlink 1.4s infinite}
      .yadarec-navdot{width:7px;height:7px;border-radius:50%;display:inline-block;margin-left:5px;vertical-align:middle}`;
    document.documentElement.appendChild(style);
    pill = document.createElement('div');
    pill.id = 'yadarec-indicator';
    pill.setAttribute('role', 'status');
    pill.addEventListener('click', () => openTranscripts(false));
    document.documentElement.appendChild(pill);
    return pill;
  }

  function computeState() {
    if (status.recording) {
      const sec = status.recStart ? Math.max(0, Math.round((Date.now() - status.recStart) / 1000)) : 0;
      return { state: 'rec', text: `REC ${fmt(sec)}${status.consent ? ' · message de consentement…' : ''}`, title: 'Appel en cours d’enregistrement' };
    }
    if (!status.patch) return { state: 'off', text: 'Recorder inactif', title: 'Le module d’enregistrement n’est pas chargé dans cette page : recharge-la.' };
    if (status.desktopUp === null) return { state: 'ok', text: 'Recorder actif', title: 'Vérification de l’app desktop…' };
    if (!status.paired) return { state: 'warn', text: 'Recorder : appairage requis', title: 'Les appels sont enregistrés et gardés dans Chrome. Appaire l’extension depuis son popup.' };
    if (!status.desktopUp) {
      return { state: 'warn', text: `Recorder actif · app hors ligne${status.pending ? ` (${status.pending})` : ''}`, title: 'Les appels sont enregistrés et gardés dans Chrome jusqu’au retour de l’app Yada Recorder.' };
    }
    return { state: 'ok', text: status.pending ? 'Recorder actif · envoi…' : 'Recorder actif', title: 'Chaque appel est enregistré et transcrit automatiquement. Clic : transcripts.' };
  }

  function render() {
    const el = ensurePill();
    const { state, text, title } = computeState();
    el.dataset.state = state;
    el.title = title;
    el.innerHTML = `<i style="background:${COLORS[state]}"></i><span></span>`;
    el.lastChild.textContent = text;
    for (const d of document.querySelectorAll('.yadarec-navdot')) { d.style.background = COLORS[state]; d.title = title; }
    clearInterval(tick);
    if (status.recording) tick = setInterval(render, 1000);
  }

  function setRecState(m) {
    if (m.startedAt) status.recStart = Date.parse(m.startedAt);
    if (typeof m.consent === 'boolean') status.consent = m.consent;
    status.recording = !!m.recording;
    status.patch = true;
    render();
  }

  async function refreshStatus() {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'status-lite' });
      if (r) Object.assign(status, { desktopUp: r.desktopUp, paired: r.paired, pending: r.pending });
    } catch (_) {
      status.desktopUp = false;
    }
    render();
  }

  // Le patch (monde MAIN) répond « hello » à ce ping : preuve qu'il est bien installé.
  document.addEventListener('yadarec:to-ext', (e) => {
    try { if (JSON.parse(e.detail).t === 'hello' && !status.patch) { status.patch = true; render(); } } catch (_) {}
  });
  toPage({ t: 'ping' });

  // Un appel enregistré dans une iframe remonte son état par le worker.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'frame-state') setRecState(msg.msg);
  });

  function bootPill() {
    render();
    refreshStatus();
    setInterval(refreshStatus, 20000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshStatus(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootPill);
  else bootPill();

  // ------------------------------------------------------------ bouton Transcripts
  const ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>';

  function makeButton(className) {
    const a = document.createElement('a');
    a.href = '#';
    a.dataset.yadarec = 'nav';
    a.className = className || 'flex items-center gap-1 text-sm hover:underline px-4';
    a.innerHTML = `${ICON}<span>Transcripts</span><span class="yadarec-navdot"></span>`;
    a.title = 'Ouvrir les transcripts (Maj+clic : dans un onglet)';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      openTranscripts(e.shiftKey);
    });
    return a;
  }

  function injectNav() {
    const navs = document.querySelectorAll('nav');
    let done = false;
    for (const nav of navs) {
      if (nav.querySelector('[data-yadarec="nav"]')) { done = true; continue; }
      // Les liens de la nav Yadaphone : Phone, Contacts, Buy credits, Buy number, Messages, More.
      const links = [...nav.querySelectorAll('a[href]')];
      const anchor = links.find((a) => /\/messages\/?$/.test(a.getAttribute('href'))) ||
                     links.find((a) => /\/contacts\/?$/.test(a.getAttribute('href')));
      if (!anchor || !anchor.parentElement) continue;
      anchor.insertAdjacentElement('afterend', makeButton(anchor.className));
      done = true;
    }
    const floating = document.getElementById('yadarec-floating');
    if (done && floating) floating.remove();
    if (done) render();
    if (!done && !floating && document.body) {
      // Repli si la nav change de structure : petit bouton flottant en haut à droite.
      const b = makeButton('');
      b.id = 'yadarec-floating';
      b.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483646;display:flex;gap:6px;align-items:center;padding:6px 12px;border-radius:999px;background:#111;color:#fff;font:500 13px system-ui,sans-serif;text-decoration:none;';
      document.body.appendChild(b);
    }
  }

  let navQueued = false;
  const observer = new MutationObserver(() => {
    if (navQueued) return;
    navQueued = true;
    setTimeout(() => { navQueued = false; injectNav(); }, 400);
  });
  function bootUi() {
    injectNav();
    observer.observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootUi);
  else bootUi();

  // ------------------------------------------------------------ ouverture de l'app
  function toast(text) {
    const t = document.createElement('div');
    t.textContent = text;
    t.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#111;color:#fff;padding:10px 14px;border-radius:10px;font:500 13px system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.2)';
    document.documentElement.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }

  function openTranscripts(inTab) {
    chrome.runtime.sendMessage({ type: 'open-transcripts', inTab }, (res) => {
      if (chrome.runtime.lastError) return toast('Extension Yada Recorder rechargée : recharge la page.');
      if (res && res.ok) return;
      if (res && res.reason === 'unpaired') return toast('Yada Recorder : appaire l’extension depuis son popup.');
      // App injoignable : le deep link la lance, le worker réessaie ensuite d'ouvrir la fenêtre.
      const link = document.createElement('a');
      link.href = 'yadarec://open';
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      link.remove();
      chrome.runtime.sendMessage({ type: 'open-after-launch' }, (r) => {
        void chrome.runtime.lastError;
        if (!r || !r.ok) toast('L’app Yada Recorder ne répond pas. Est-elle installée ?');
      });
    });
  }
})();
