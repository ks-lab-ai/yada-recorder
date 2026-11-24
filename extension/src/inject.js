// Yada Recorder : script injecté dans le monde MAIN de yadaphone.com, à document_start,
// donc AVANT le SDK Twilio de la page.
//
// Ce qu'il fait :
//  - remplace window.RTCPeerConnection par une sous-classe qui observe chaque appel ;
//  - mixe en stéréo (gauche = moi, droite = interlocuteur) dans un AudioContext ;
//  - enregistre en webm/opus avec MediaRecorder et émet un chunk toutes les 5 s ;
//  - détecte début et fin d'appel (connectionState, close(), fin des pistes, pagehide) ;
//  - récupère numéro, contact et sens de l'appel (signalisation Twilio, puis DOM) ;
//  - joue au besoin un message de consentement dans la piste sortante.
//
// Il ne parle jamais au réseau : tout passe au content script isolé (bridge.js) par
// des CustomEvent synchrones sur document, avec un detail en chaîne JSON.
(() => {
  if (window.__yadarecInstalled) return;
  window.__yadarecInstalled = true;

  const NativePC = window.RTCPeerConnection;
  if (!NativePC) return;

  const TIMESLICE_MS = 5000;
  const AUDIO_BPS = 48000;
  const DISCONNECT_GRACE_MS = 8000;

  const cfg = { consentMode: 'us', consentUrl: null, debug: false };
  const sessions = new Set();
  const nativeReplaceTrack = RTCRtpSender.prototype.replaceTrack;
  let lastGumTrack = null;
  let lastSignal = null; // { direction, phone, at }

  // ---------------------------------------------------------------- messaging
  function toExt(msg) {
    try {
      document.dispatchEvent(new CustomEvent('yadarec:to-ext', { detail: JSON.stringify(msg) }));
    } catch (_) {}
  }
  function log(...a) {
    if (cfg.debug) console.log('%c[yadarec]', 'color:#e11d48;font-weight:bold', ...a);
  }
  document.addEventListener('yadarec:to-page', (e) => {
    let m;
    try { m = JSON.parse(e.detail); } catch (_) { return; }
    if (m.t === 'ping') toExt({ t: 'hello' });
    if (m.t === 'config') {
      Object.assign(cfg, m.config || {});
      log('config', cfg);
    }
  });
  toExt({ t: 'hello' });

  // ---------------------------------------------------------------- helpers
  function normPhone(s) {
    if (!s) return null;
    s = String(s).trim();
    if (/^client:/i.test(s) || /^sip:/i.test(s)) return null;
    const plus = s.startsWith('+') || s.startsWith('00');
    const digits = s.replace(/\D/g, '').replace(/^00/, '');
    if (digits.length < 6 || digits.length > 16) return null;
    return (plus ? '+' : '') + digits;
  }

  // Cherche un numéro dans un objet de signalisation Twilio (clés To, From, phone...).
  function findPhone(obj, prefer) {
    const seen = new Set();
    const candidates = [];
    (function walk(o, key) {
      if (o == null || seen.has(o)) return;
      if (typeof o === 'string') {
        if (key === 'params' || o.includes('=')) {
          try {
            const p = new URLSearchParams(o);
            for (const [k, v] of p) walk(v, k);
          } catch (_) {}
        }
        const n = normPhone(o);
        if (n && /^[+\d\s().-]+$/.test(o.trim())) candidates.push({ key: key || '', n });
        return;
      }
      if (typeof o !== 'object') return;
      seen.add(o);
      for (const k of Object.keys(o)) walk(o[k], k);
    })(obj, '');
    const rank = (c) => {
      const k = c.key.toLowerCase();
      if (prefer.some((p) => k === p)) return 0;
      if (/phone|number|to|from|dest/.test(k)) return 1;
      return 2;
    };
    candidates.sort((a, b) => rank(a) - rank(b));
    return candidates.length ? candidates[0].n : null;
  }

  // DOM Yadaphone (/phone) : bouton indicatif pays ("🇺🇸+1") + input[type=tel].
  function dialedFromDom() {
    try {
      const input = document.querySelector('input[type="tel"]');
      const raw = input && input.value ? input.value.trim() : '';
      if (raw.startsWith('+')) return normPhone(raw);
      let cc = '';
      for (const b of document.querySelectorAll('button')) {
        const m = b.textContent.trim().match(/^\S*\s*(\+\d{1,4})$/);
        if (m) { cc = m[1]; break; }
      }
      if (raw) return normPhone(cc + raw.replace(/^0+/, ''));
    } catch (_) {}
    return null;
  }

  const UI_WORDS = /^(call|calling|mute|unmute|keypad|hang ?up|end|add contact|balance|call from|speaker|hold|record|start recording|transfer|appel|raccrocher|clavier|muet|contacts?|phone|messages|settings)$/i;

  // Nom du contact : un court texte sans chiffres placé près du numéro affiché.
  function contactFromDom(phone) {
    if (!phone) return null;
    const tail = phone.replace(/\D/g, '').slice(-6);
    if (tail.length < 6) return null;
    try {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const txt = node.textContent;
        if (txt.length > 40 || txt.replace(/\D/g, '').indexOf(tail) === -1) continue;
        let el = node.parentElement;
        if (!el || el.closest('nav') || /call from/i.test(el.parentElement ? el.parentElement.textContent : '')) continue;
        for (let up = 0; up < 3 && el; up++, el = el.parentElement) {
          for (const c of el.querySelectorAll('*')) {
            if (c.children.length) continue;
            const t = c.textContent.trim();
            if (t.length >= 2 && t.length <= 40 && !/\d/.test(t) && /\p{L}/u.test(t) && !UI_WORDS.test(t)) return t;
          }
        }
      }
    } catch (_) {}
    return null;
  }

  function blobToB64(blob) {
    return blob.arrayBuffer().then((buf) => {
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    });
  }

  let ctx = null;
  function audioCtx() {
    if (!ctx || ctx.state === 'closed') ctx = new AudioContext({ sampleRate: 48000 });
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  let consentBufferPromise = null;
  function consentBuffer() {
    if (!cfg.consentUrl) return Promise.reject(new Error('consentUrl manquante'));
    if (!consentBufferPromise) {
      consentBufferPromise = fetch(cfg.consentUrl)
        .then((r) => r.arrayBuffer())
        .then((b) => audioCtx().decodeAudioData(b))
        .catch((e) => { consentBufferPromise = null; throw e; });
    }
    return consentBufferPromise;
  }

  // ---------------------------------------------------------------- call session
  class CallSession {
    constructor(pc) {
      this.pc = pc;
      this.id = crypto.randomUUID();
      this.remoteTracks = new Set();
      this.localTrack = null;
      this.started = false;
      this.ended = false;
      this.seq = 0;
      this.chain = Promise.resolve();
      this.sinks = [];
      this.localSrc = null;
      this.disconnectTimer = null;
      this.consentDone = false;
      this.meta = { phoneNumber: null, contactName: null, direction: 'unknown' };
      this.captureMeta();
      sessions.add(this);
    }

    captureMeta() {
      const fresh = lastSignal && Date.now() - lastSignal.at < 30000 ? lastSignal : null;
      const phone = (fresh && fresh.phone) || dialedFromDom() || this.meta.phoneNumber;
      const direction = fresh ? fresh.direction : this.meta.direction !== 'unknown' ? this.meta.direction : dialedFromDom() ? 'outbound' : 'unknown';
      const contact = contactFromDom(phone) || this.meta.contactName;
      const changed = phone !== this.meta.phoneNumber || contact !== this.meta.contactName || direction !== this.meta.direction;
      this.meta = { phoneNumber: phone || null, contactName: contact || null, direction };
      return changed;
    }

    tryStart() {
      if (this.started || this.ended) return;
      const connected = this.pc.connectionState === 'connected' || ['connected', 'completed'].includes(this.pc.iceConnectionState);
      if (!connected || this.remoteTracks.size === 0) return;
      this.start();
    }

    start() {
      this.started = true;
      this.startedAt = new Date();
      this.captureMeta(); // l'invite Twilio part après la création de la PC : on relit ici
      const ac = audioCtx();

      this.merger = ac.createChannelMerger(2);
      this.dest = ac.createMediaStreamDestination();
      this.dest.channelCount = 2;
      this.merger.connect(this.dest);
      this.localGain = ac.createGain();
      this.remoteGain = ac.createGain();
      this.localGain.connect(this.merger, 0, 0);
      this.remoteGain.connect(this.merger, 0, 1);

      for (const t of this.remoteTracks) this.attachRemote(t);
      const sender = this.audioSender();
      this.setLocal((sender && sender.track) || this.localTrack || lastGumTrack);

      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      this.recorder = new MediaRecorder(this.dest.stream, { mimeType: mime, audioBitsPerSecond: AUDIO_BPS });
      this.recorder.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        const seq = this.seq++;
        const at = Date.now();
        this.chain = this.chain
          .then(() => blobToB64(e.data))
          .then((b64) => toExt({ t: 'chunk', callId: this.id, seq, b64, at }))
          .catch((err) => log('chunk error', err));
      };
      this.recorder.onstop = () => this.finish();
      this.recorder.start(TIMESLICE_MS);

      toExt({ t: 'call-start', callId: this.id, startedAt: this.startedAt.toISOString(), mime, ...this.meta });
      toExt({ t: 'state', recording: true, callId: this.id, startedAt: this.startedAt.toISOString() });
      log('enregistrement démarré', this.id, this.meta);

      // Le DOM affiche parfois le contact après le début de l'appel : on réessaie un peu.
      this.metaTimer = setInterval(() => {
        if (this.captureMeta()) toExt({ t: 'call-meta', callId: this.id, ...this.meta });
      }, 3000);
      setTimeout(() => clearInterval(this.metaTimer), 30000);

      // Pic de niveau distant : sert à reconnaître la connexion de test que Yadaphone ouvre
      // et ferme au chargement de la page (aucun son reçu), pour ne pas la traiter comme un appel.
      this.remotePeak = 0;
      const peakBuf = new Float32Array(2048);
      this.peakTimer = setInterval(() => {
        if (!this.answerAnalyser) return;
        this.answerAnalyser.getFloatTimeDomainData(peakBuf);
        let s = 0;
        for (let i = 0; i < peakBuf.length; i++) s += peakBuf[i] * peakBuf[i];
        this.remotePeak = Math.max(this.remotePeak, Math.sqrt(s / peakBuf.length));
      }, 250);

      if (this.shouldPlayConsent()) this.armConsent();
    }

    audioSender() {
      try {
        return this.pc.getSenders().find((s) => s.track && s.track.kind === 'audio') ||
               this.pc.getSenders().find((s) => !s.track || s.track.kind === 'audio') || null;
      } catch (_) { return null; }
    }

    keepAlive(track) {
      // Contournement Chrome : une piste WebRTC distante reste muette dans WebAudio
      // si elle n'est pas aussi branchée sur un élément média.
      const a = new Audio();
      a.muted = true;
      a.srcObject = new MediaStream([track]);
      a.play().catch(() => {});
      this.sinks.push(a);
    }

    attachRemote(track) {
      if (!this.started) return;
      this.keepAlive(track);
      const src = audioCtx().createMediaStreamSource(new MediaStream([track]));
      src.connect(this.remoteGain);
      if (!this.answerAnalyser) {
        this.answerAnalyser = audioCtx().createAnalyser();
        this.answerAnalyser.fftSize = 2048;
        src.connect(this.answerAnalyser);
      }
      track.addEventListener('ended', () => {
        if ([...this.remoteTracks].every((t) => t.readyState === 'ended')) this.end('remote-track-ended');
      });
    }

    setLocal(track) {
      if (!track || track === this.localTrack && this.localSrc) return;
      if (this.mixTrack && track === this.mixTrack) return;
      this.localTrack = track;
      if (!this.started) return;
      if (this.localSrc) try { this.localSrc.disconnect(); } catch (_) {}
      this.localSrc = audioCtx().createMediaStreamSource(new MediaStream([track]));
      this.localSrc.connect(this.localGain);
    }

    // ------------------------------------------------ consentement
    shouldPlayConsent() {
      if (cfg.consentMode === 'off') return false;
      if (cfg.consentMode === 'all') return true;
      // 'us' : numéros +1 (entrants comme sortants), et par prudence quand le numéro est inconnu.
      return !this.meta.phoneNumber || this.meta.phoneNumber.startsWith('+1');
    }

    // Un appel sortant passe "connected" dès la sonnerie (early media Twilio).
    // On attend donc que l'interlocuteur décroche : première parole détectée sur la piste
    // distante, distincte de la tonalité de retour d'appel (400 à 480 Hz). Filet : 40 s.
    armConsent() {
      consentBuffer().catch((e) => log('consent preload', e));
      const ac = audioCtx();
      const an = this.answerAnalyser;
      if (!an) return;
      const bins = new Float32Array(an.frequencyBinCount);
      const hz = ac.sampleRate / an.fftSize;
      const band = (lo, hi) => {
        let s = 0;
        for (let i = Math.floor(lo / hz); i <= Math.ceil(hi / hz) && i < bins.length; i++) s += Math.pow(10, bins[i] / 10);
        return s;
      };
      let voiced = 0;
      const t0 = Date.now();
      this.answerTimer = setInterval(() => {
        if (this.ended || this.consentDone) return clearInterval(this.answerTimer);
        an.getFloatFrequencyData(bins);
        const total = band(250, 3500);
        const tone = band(380, 500);
        const db = 10 * Math.log10(total + 1e-12);
        const isVoice = db > -45 && tone / total < 0.55;
        voiced = isVoice ? voiced + 1 : Math.max(0, voiced - 1);
        if (voiced >= 6 || Date.now() - t0 > 40000) {
          clearInterval(this.answerTimer);
          log('décroché détecté', { voiced, after: Date.now() - t0 });
          setTimeout(() => this.playConsent(), 700);
        }
      }, 60);
    }

    async playConsent() {
      if (this.consentDone || this.ended) return;
      this.consentDone = true;
      const sender = this.audioSender();
      if (!sender) return log('consent : pas de sender audio');
      let buffer;
      try { buffer = await consentBuffer(); } catch (e) { return log('consent : audio introuvable', e); }
      const ac = audioCtx();
      const original = sender.track;
      const mix = ac.createMediaStreamDestination();
      mix.channelCount = 1;
      let micSrc = null;
      if (original) {
        micSrc = ac.createMediaStreamSource(new MediaStream([original]));
        micSrc.connect(mix);
      }
      const src = ac.createBufferSource();
      src.buffer = buffer;
      src.connect(mix);
      src.connect(this.localGain); // le message apparaît aussi sur le canal "moi" de l'enregistrement
      this.mixTrack = mix.stream.getAudioTracks()[0];
      try {
        await nativeReplaceTrack.call(sender, this.mixTrack);
      } catch (e) {
        log('consent : replaceTrack impossible', e);
        return;
      }
      toExt({ t: 'state', recording: true, consent: true, callId: this.id });
      src.onended = async () => {
        try {
          if (sender.track === this.mixTrack) await nativeReplaceTrack.call(sender, original);
        } catch (_) {}
        try { micSrc && micSrc.disconnect(); } catch (_) {}
        this.mixTrack.stop();
        toExt({ t: 'state', recording: !this.ended, consent: false, callId: this.id });
      };
      src.start();
      log('message de consentement joué');
    }

    // ------------------------------------------------ fin
    end(reason) {
      if (this.ended) return;
      this.ended = true;
      this.endReason = reason;
      this.endedAt = new Date();
      clearInterval(this.metaTimer);
      clearInterval(this.answerTimer);
      clearInterval(this.peakTimer);
      clearTimeout(this.disconnectTimer);
      sessions.delete(this);
      if (!this.started) return;
      log('fin d\'appel', reason);
      if (reason === 'pagehide') {
        // La page meurt : pas le temps d'attendre le dernier chunk asynchrone.
        // On envoie la fin tout de suite ; l'app attend un peu les chunks en vol.
        try { this.recorder.state !== 'inactive' && this.recorder.requestData(); } catch (_) {}
        this.sendEnd();
        return;
      }
      try {
        if (this.recorder.state !== 'inactive') this.recorder.stop();
        else this.finish();
      } catch (_) { this.finish(); }
      setTimeout(() => this.finish(), 4000); // filet si onstop ne vient jamais
    }

    finish() {
      if (this.finished) return;
      this.finished = true;
      this.chain.then(() => this.sendEnd());
      for (const a of this.sinks) { try { a.srcObject = null; } catch (_) {} }
      try { this.merger.disconnect(); } catch (_) {}
    }

    sendEnd() {
      if (this.endSent) return;
      this.endSent = true;
      const endedAt = this.endedAt || new Date();
      toExt({
        t: 'call-end',
        callId: this.id,
        endedAt: endedAt.toISOString(),
        durationSec: Math.max(0, Math.round((endedAt - this.startedAt) / 1000)),
        chunks: this.seq,
        reason: this.endReason,
        remotePeak: Math.round((this.remotePeak || 0) * 10000) / 10000,
        ...this.meta,
      });
      toExt({ t: 'state', recording: sessions.size > 0 && [...sessions].some((s) => s.started), callId: this.id });
    }
  }

  // ---------------------------------------------------------------- RTCPeerConnection
  class YadaPeerConnection extends NativePC {
    constructor(...args) {
      super(...args);
      let s;
      try { s = new CallSession(this); } catch (e) { return; }
      this.__yadarec = s;
      log('PeerConnection créée', s.id, s.meta);
      this.addEventListener('track', (e) => {
        if (e.track.kind !== 'audio') return;
        s.remoteTracks.add(e.track);
        if (s.started) s.attachRemote(e.track);
        else s.tryStart();
      });
      const onState = () => {
        const cs = this.connectionState;
        const ice = this.iceConnectionState;
        log('état', cs, ice);
        if (cs === 'connected' || ice === 'connected' || ice === 'completed') {
          clearTimeout(s.disconnectTimer);
          s.disconnectTimer = null;
          s.tryStart();
        } else if (cs === 'failed' || cs === 'closed' || ice === 'failed' || ice === 'closed') {
          s.end(cs === 'closed' || ice === 'closed' ? 'closed' : 'failed');
        } else if ((cs === 'disconnected' || ice === 'disconnected') && !s.disconnectTimer) {
          s.disconnectTimer = setTimeout(() => s.end('disconnected'), DISCONNECT_GRACE_MS);
        }
      };
      this.addEventListener('connectionstatechange', onState);
      this.addEventListener('iceconnectionstatechange', onState);
    }
    addTrack(track, ...streams) {
      if (this.__yadarec && track && track.kind === 'audio') this.__yadarec.setLocal(track);
      return super.addTrack(track, ...streams);
    }
    addTransceiver(trackOrKind, init) {
      if (this.__yadarec && trackOrKind && typeof trackOrKind !== 'string' && trackOrKind.kind === 'audio') this.__yadarec.setLocal(trackOrKind);
      return super.addTransceiver(trackOrKind, init);
    }
    close() {
      // close() ne déclenche aucun connectionstatechange : on termine nous-mêmes.
      if (this.__yadarec) this.__yadarec.end('closed');
      return super.close();
    }
  }
  if (NativePC.prototype.addStream) {
    YadaPeerConnection.prototype.addStream = function (stream) {
      const t = stream && stream.getAudioTracks()[0];
      if (this.__yadarec && t) this.__yadarec.setLocal(t);
      return NativePC.prototype.addStream.call(this, stream);
    };
  }
  window.RTCPeerConnection = YadaPeerConnection;
  if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = YadaPeerConnection;

  // Twilio change de micro avec replaceTrack : on suit la nouvelle piste.
  RTCRtpSender.prototype.replaceTrack = function (track) {
    for (const s of sessions) {
      try {
        if (s.pc.getSenders().includes(this) && track && track.kind === 'audio') s.setLocal(track);
      } catch (_) {}
    }
    return nativeReplaceTrack.call(this, track);
  };

  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    const nativeGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await nativeGum(constraints);
      const t = stream.getAudioTracks()[0];
      if (t) lastGumTrack = t;
      return stream;
    };
  }

  // ---------------------------------------------------------------- signalisation Twilio
  // Le SDK Twilio Voice parle à Twilio par WebSocket. On lit (sans rien modifier) le message
  // "invite" : envoyé par nous = appel sortant (params contient le numéro composé),
  // reçu = appel entrant (parameters.From).
  const NativeWS = window.WebSocket;
  function onSignal(raw, outgoing) {
    if (typeof raw !== 'string' || raw.length > 200000 || raw[0] !== '{') return;
    let m;
    try { m = JSON.parse(raw); } catch (_) { return; }
    if (!m || typeof m.type !== 'string') return;
    if (cfg.debug) log(outgoing ? 'WS =>' : 'WS <=', m.type);
    if (m.type === 'invite') {
      const phone = findPhone(m.payload, outgoing ? ['to', 'phone', 'phonenumber', 'number'] : ['from', 'caller']);
      lastSignal = { direction: outgoing ? 'outbound' : 'inbound', phone, at: Date.now() };
      log('invite', lastSignal);
    }
  }
  class YadaWebSocket extends NativeWS {
    constructor(url, protocols) {
      super(url, protocols);
      if (/twilio/i.test(String(url))) {
        this.__yadarecTwilio = true;
        this.addEventListener('message', (e) => onSignal(e.data, false));
      }
    }
    send(data) {
      if (this.__yadarecTwilio) onSignal(data, true);
      return super.send(data);
    }
  }
  window.WebSocket = YadaWebSocket;

  // ---------------------------------------------------------------- fermeture d'onglet
  window.addEventListener('pagehide', () => {
    for (const s of [...sessions]) s.end('pagehide');
  });

  window.__yadarec = { sessions, cfg };
})();
