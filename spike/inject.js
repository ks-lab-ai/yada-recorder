// SPIKE Yada Recorder (diagnostic) : tourne dans le monde MAIN de yadaphone.com, avant les scripts de la page.
// N'enregistre rien et n'envoie rien. Affiche un panneau en haut à droite et permet de copier un diagnostic.
// Deux mesures indépendantes de l'audio :
//   1. WebAudio : ce que l'enregistreur captera réellement (barres Moi / Interlocuteur) ;
//   2. statistiques WebRTC (getStats) : ce qui passe vraiment sur le réseau, quelle que soit la façon
//      dont la page branche ses pistes.
(() => {
  if (window.__yadarecSpike) return;
  const NativePC = window.RTCPeerConnection;
  if (!NativePC) return;

  const isTop = window === window.top;
  const t0 = Date.now();
  const since = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  const log = (...a) => console.log('%c[yadarec-spike]', 'color:#e11d48;font-weight:bold', `(${isTop ? 'top' : 'iframe'})`, ...a);

  const state = {
    version: '0.0.5',
    frame: isTop ? 'top' : 'iframe',
    pcs: [], // { id, states: [], tracks: [], stats: {} }
    wsHosts: {}, // hôte -> nb de messages
    signal: null,
    gum: [],
    mediaEls: 0,
    level: { local: 0, remote: 0 },
    peak: { local: 0, remote: 0 },
    ctxState: null,
    errors: [],
  };
  window.__yadarecSpike = state;

  // ------------------------------------------------------------ mesure WebAudio
  let ctx = null;
  const metered = new WeakSet();
  function meter(track, kind, how, pcInfo) {
    if (!track || track.kind !== 'audio') return;
    if (pcInfo) pcInfo.tracks.push({ how, kind, label: track.label || '', readyState: track.readyState, muted: track.muted, enabled: track.enabled, at: since() });
    if (metered.has(track)) return;
    metered.add(track);
    log(`piste ${kind} via ${how}`, track.label, `muted=${track.muted}`);
    try {
      ctx = ctx || new AudioContext();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const stream = new MediaStream([track]);
      const sink = new Audio();
      sink.muted = true;
      sink.srcObject = stream;
      sink.play().catch(() => {});
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Float32Array(an.fftSize);
      const t = setInterval(() => {
        state.ctxState = ctx.state;
        if (track.readyState === 'ended') { clearInterval(t); state.level[kind] = 0; return; }
        an.getFloatTimeDomainData(buf);
        let s = 0;
        for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
        const rms = Math.sqrt(s / buf.length);
        state.level[kind] = rms;
        state.peak[kind] = Math.max(state.peak[kind], rms);
      }, 250);
      // garde une référence pour éviter le ramasse-miettes
      (state._keep = state._keep || []).push(sink, an);
    } catch (e) {
      state.errors.push(`meter ${kind}: ${e.message}`);
    }
  }

  // ------------------------------------------------------------ statistiques réseau
  async function pollStats(pc, info) {
    try {
      const report = await NativePC.prototype.getStats.call(pc);
      const st = info.stats;
      report.forEach((r) => {
        if (r.kind !== 'audio' && r.mediaType !== 'audio') return;
        if (r.type === 'inbound-rtp') {
          st.inBytes = r.bytesReceived || 0;
          st.inPackets = r.packetsReceived || 0;
          if (typeof r.audioLevel === 'number') { st.inLevel = r.audioLevel; st.inLevelMax = Math.max(st.inLevelMax || 0, r.audioLevel); }
          st.codec = st.codec || r.codecId;
        } else if (r.type === 'outbound-rtp') {
          st.outBytes = r.bytesSent || 0;
          st.outPackets = r.packetsSent || 0;
        } else if (r.type === 'media-source') {
          if (typeof r.audioLevel === 'number') { st.outLevel = r.audioLevel; st.outLevelMax = Math.max(st.outLevelMax || 0, r.audioLevel); }
        }
      });
    } catch (e) {
      info.stats.error = e.message;
    }
  }

  function scanPc(pc, info) {
    try {
      for (const r of NativePC.prototype.getReceivers.call(pc)) meter(r.track, 'remote', 'getReceivers', info);
      for (const s of NativePC.prototype.getSenders.call(pc)) meter(s.track, 'local', 'getSenders', info);
    } catch (_) {}
  }

  // ------------------------------------------------------------ patch RTCPeerConnection
  class PatchedPC extends NativePC {
    constructor(...args) {
      super(...args);
      const info = { id: state.pcs.length + 1, created: since(), createdMs: Date.now(), states: [], tracks: [], stats: {}, closed: false };
      state.peak = { local: 0, remote: 0 };
      state.pcs.push(info);
      this.__info = info;
      log(`PC#${info.id} créée`);
      this.addEventListener('track', (e) => meter(e.track, 'remote', 'event track', info));
      const onState = () => {
        info.states.push(`${since()} ${this.connectionState}/${this.iceConnectionState}`);
        if (this.connectionState === 'connected') scanPc(this, info);
      };
      this.addEventListener('connectionstatechange', onState);
      this.addEventListener('iceconnectionstatechange', onState);
      const timer = setInterval(() => {
        if (info.closed) return clearInterval(timer);
        pollStats(this, info);
        scanPc(this, info);
      }, 1000);
    }
    addTrack(track, ...streams) {
      meter(track, 'local', 'addTrack', this.__info);
      return super.addTrack(track, ...streams);
    }
    addTransceiver(trackOrKind, init) {
      if (typeof trackOrKind !== 'string') meter(trackOrKind, 'local', 'addTransceiver', this.__info);
      else if (this.__info) this.__info.tracks.push({ how: `addTransceiver('${trackOrKind}')`, at: since() });
      return super.addTransceiver(trackOrKind, init);
    }
    close() {
      if (this.__info) {
        this.__info.closed = true;
        this.__info.lifetimeSec = Math.round((Date.now() - this.__info.createdMs) / 1000);
        this.__info.states.push(`${since()} close()`);
      }
      return super.close();
    }
  }
  window.RTCPeerConnection = PatchedPC;
  if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = PatchedPC;

  const nativeReplace = RTCRtpSender.prototype.replaceTrack;
  RTCRtpSender.prototype.replaceTrack = function (track) {
    const info = state.pcs[state.pcs.length - 1];
    if (info) info.tracks.push({ how: 'replaceTrack', kind: track ? track.kind : null, at: since() });
    meter(track, 'local', 'replaceTrack', null);
    return nativeReplace.call(this, track);
  };

  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    const nativeGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await nativeGum(constraints);
      state.gum.push({ at: since(), audio: stream.getAudioTracks().map((t) => t.label) });
      return stream;
    };
  }

  // Éléments audio/vidéo qui reçoivent un flux (la page joue souvent l'audio distant ainsi).
  const srcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
  if (srcDesc && srcDesc.set) {
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
      ...srcDesc,
      set(v) {
        if (v && v.getAudioTracks) {
          state.mediaEls++;
          for (const t of v.getAudioTracks()) meter(t, 'remote', 'srcObject', state.pcs[state.pcs.length - 1]);
        }
        return srcDesc.set.call(this, v);
      },
    });
  }

  // Tous les WebSockets : on note seulement l'hôte et, s'ils sont en JSON, le type des messages.
  const NativeWS = window.WebSocket;
  function sniff(data, dir) {
    if (typeof data !== 'string' || data[0] !== '{') return;
    try {
      const m = JSON.parse(data);
      const type = m.type || m.method || m.event || m.action;
      if (typeof type === 'string' && /invite|call|answer|ring|hangup|bye/i.test(type)) state.signal = `${dir} ${type}`;
    } catch (_) {}
  }
  window.WebSocket = class extends NativeWS {
    constructor(url, protocols) {
      super(url, protocols);
      let host = '?';
      try { host = new URL(String(url)).host; } catch (_) {}
      state.wsHosts[host] = state.wsHosts[host] || 0;
      this.__host = host;
      this.addEventListener('message', (e) => { state.wsHosts[host]++; sniff(e.data, '<='); });
    }
    send(data) {
      sniff(data, '=>');
      return super.send(data);
    }
  };

  log('patch installé', state.version);
  if (!isTop) return;

  // ------------------------------------------------------------ panneau (haut à droite)
  function bar(v) {
    const pct = Math.min(100, Math.round(v * 1200));
    return `<span style="display:inline-block;vertical-align:middle;width:80px;height:8px;border-radius:4px;background:#3f3f46;overflow:hidden"><span style="display:block;height:100%;width:${pct}%;background:#28DC8C"></span></span>`;
  }
  const ok = (b) => (b ? '<b style="color:#28DC8C">✓</b>' : '<b style="color:#9ca3af">·</b>');
  const kb = (n) => `${Math.round((n || 0) / 1024)} ko`;

  function diagnostic() {
    const { _keep, ...rest } = state;
    return JSON.stringify({ ...rest, ua: navigator.userAgent, url: location.pathname }, null, 2);
  }

  let showInfo = false;
  function panel() {
    let el = document.getElementById('yadarec-spike');
    if (!el) {
      el = document.createElement('div');
      el.id = 'yadarec-spike';
      el.style.cssText = 'position:fixed;right:14px;top:76px;z-index:2147483647;background:rgba(17,17,17,.9);color:#fff;font:12px/1.6 ui-monospace,Menlo,monospace;padding:10px 12px;border-radius:12px;box-shadow:0 4px 16px rgba(0,0,0,.25);min-width:300px';
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-copy]');
        if (!b) return;
        navigator.clipboard.writeText(diagnostic()).then(() => { b.textContent = 'Copié ✓ colle-le à Claude'; setTimeout(() => { b.textContent = 'Copier le diagnostic'; }, 2500); });
      });
      document.documentElement.appendChild(el);
    }
    const pc = state.pcs[state.pcs.length - 1];
    const st = (pc && pc.stats) || {};
    const probe = !!(pc && pc.closed && (pc.lifetimeSec || 0) < 8 && (st.inBytes || 0) < 20000);
    const lastState = pc && pc.states.length ? pc.states[pc.states.length - 1].split(' ')[1] : null;
    const connected = !!(pc && pc.states.some((s) => /connected/.test(s)));
    const ended = !!(pc && pc.closed);
    const netIn = (st.inBytes || 0) > 2000;
    const netOut = (st.outBytes || 0) > 2000;
    const remoteHeard = state.peak.remote > 0.01;
    const localHeard = state.peak.local > 0.01;
    let verdict = '';
    const probe0 = probe;
    if (probe0) verdict = '<span style="color:#9ca3af">Connexion de test de Yadaphone (ignorée).<br>Passe un vrai appel.</span>';
    else if (ended) {
      if (remoteHeard && localHeard) verdict = '<b style="color:#28DC8C">Résultat : les 2 voix sont captées, c’est bon.</b>';
      else verdict = '<b style="color:#ff6b6b">Une voix manque : clique « Copier le diagnostic »<br>et colle-le dans la conversation.</b>';
    }
    el.innerHTML = [
      `<b style="color:#28DC8C">● SPIKE Yada Recorder</b> <span style="color:#9ca3af">v${state.version}</span>`,
      `${ok(!!pc && !probe)} Appel détecté ${pc && !probe ? `(${lastState || 'new'})` : ': passe un appel'}`,
      `${ok(connected && !probe)} Connexion établie`,
      `<span style="color:#9ca3af">Capté par l’enregistreur</span>`,
      `${ok(localHeard)} Moi&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;${bar(state.level.local)}`,
      `${ok(remoteHeard)} Interlocuteur ${bar(state.level.remote)}`,
      `<span style="color:#9ca3af">Sur le réseau (WebRTC)</span>`,
      `${ok(netOut)} Envoyé ${kb(st.outBytes)}${st.outLevelMax != null ? `, niveau max ${st.outLevelMax.toFixed(2)}` : ''}`,
      `${ok(netIn)} Reçu ${kb(st.inBytes)}${st.inLevelMax != null ? `, niveau max ${st.inLevelMax.toFixed(2)}` : ''}`,
      `${ok(!!state.signal)} Signalisation ${state.signal ? `(${state.signal})` : ''}`,
      verdict,
      showInfo ? '<span style="color:#9ca3af">Transcripts : dans la version complète, ce bouton<br>ouvre la fenêtre Transcripts de l’app Yada Recorder.</span>' : '',
      '<button data-copy style="margin-top:6px;font:inherit;background:#28DC8C;color:#111;border:0;border-radius:8px;padding:5px 10px;cursor:pointer">Copier le diagnostic</button>',
    ].filter(Boolean).join('<br>');
  }
  setInterval(panel, 300);

  // ------------------------------------------------------------ bouton Transcripts dans la nav (aperçu)
  const ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>';
  function injectNav() {
    for (const nav of document.querySelectorAll('nav')) {
      if (nav.querySelector('[data-yadarec="nav"]')) continue;
      const links = [...nav.querySelectorAll('a[href]')];
      const anchor = links.find((a) => /\/messages\/?$/.test(a.getAttribute('href'))) || links.find((a) => /\/contacts\/?$/.test(a.getAttribute('href')));
      if (!anchor) continue;
      const a = document.createElement('a');
      a.href = '#';
      a.dataset.yadarec = 'nav';
      a.className = anchor.className;
      a.innerHTML = `${ICON}<span>Transcripts</span><span style="width:7px;height:7px;border-radius:50%;background:#28DC8C;display:inline-block;margin-left:4px"></span>`;
      a.addEventListener('click', (e) => { e.preventDefault(); showInfo = !showInfo; panel(); });
      anchor.insertAdjacentElement('afterend', a);
    }
  }
  const boot = () => {
    injectNav();
    new MutationObserver(() => injectNav()).observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
