// Remplace bridge.js + service worker pour le test : relaie vers le serveur de test (même origine).
window.__NativePC = window.RTCPeerConnection;
window.__events = [];
(() => {
  const q = [];
  let busy = false;
  const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  async function send(m) {
    if (m.t === 'chunk') {
      await fetch(`/v1/calls/${m.callId}/chunks/${m.seq}`, { method: 'PUT', body: b64ToBytes(m.b64), headers: { 'X-Chunk-At': String(m.at) } });
    } else {
      const kind = { 'call-start': 'start', 'call-meta': 'meta', 'call-end': 'end' }[m.t];
      await fetch(`/v1/calls/${m.callId}/${kind}`, { method: 'POST', body: JSON.stringify(m), headers: { 'Content-Type': 'application/json' } });
    }
  }
  async function pump() {
    if (busy) return;
    busy = true;
    while (q.length) await send(q.shift()).catch((e) => console.log('shim send error', e));
    busy = false;
  }
  document.addEventListener('yadarec:to-ext', (e) => {
    const m = JSON.parse(e.detail);
    window.__events.push({ t: m.t, at: performance.now(), recording: m.recording, consent: m.consent });
    if (m.t === 'hello') {
      document.dispatchEvent(new CustomEvent('yadarec:to-page', { detail: JSON.stringify({ t: 'config', config: { consentMode: 'all', debug: true, consentUrl: '/consent-en.wav' } }) }));
    } else if (['call-start', 'chunk', 'call-meta', 'call-end'].includes(m.t)) {
      q.push(m);
      pump();
    }
  });
})();
