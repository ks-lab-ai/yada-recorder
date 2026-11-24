// Faux appel : pcA = la PeerConnection "Yadaphone/Twilio" (patchée), pcB = Twilio côté réseau (native).
// Micro simulé = 300 Hz faible, interlocuteur = 1200 Hz. On mesure ce que pcB reçoit (consentement).
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const report = { bRms: [], errors: [] };
  window.onerror = (m) => report.errors.push(String(m));
  try {
    const ac = new AudioContext();
    await ac.resume();
    const osc = (freq, gain) => {
      const o = ac.createOscillator();
      o.frequency.value = freq;
      const g = ac.createGain();
      g.gain.value = gain;
      const d = ac.createMediaStreamDestination();
      o.connect(g).connect(d);
      o.start();
      return d.stream.getAudioTracks()[0];
    };
    // Le numéro composé, comme sur yadaphone.com/phone
    const cc = document.createElement('button'); cc.textContent = '🇺🇸+1'; document.body.appendChild(cc);
    const tel = document.createElement('input'); tel.type = 'tel'; tel.value = '415 555 0132'; document.body.appendChild(tel);

    const pcA = new RTCPeerConnection();
    const pcB = new window.__NativePC();
    pcA.onicecandidate = (e) => e.candidate && pcB.addIceCandidate(e.candidate);
    pcB.onicecandidate = (e) => e.candidate && pcA.addIceCandidate(e.candidate);
    pcA.addTrack(osc(300, 0.05));
    if (location.search.includes('ringback')) {
      // Tonalité de retour d'appel US (440+480 Hz, 2 s on / 4 s off) puis décroché à 6,5 s.
      const d = ac.createMediaStreamDestination();
      const ring = ac.createGain(); ring.gain.value = 0; ring.connect(d);
      for (const f of [440, 480]) { const o = ac.createOscillator(); o.frequency.value = f; const g = ac.createGain(); g.gain.value = 0.15; o.connect(g).connect(ring); o.start(); }
      const voice = ac.createGain(); voice.gain.value = 0; voice.connect(d);
      const ov = ac.createOscillator(); ov.frequency.value = 1200; const gv = ac.createGain(); gv.gain.value = 0.3; ov.connect(gv).connect(voice); ov.start();
      const now = ac.currentTime;
      ring.gain.setValueAtTime(1, now); ring.gain.setValueAtTime(0, now + 2);
      ring.gain.setValueAtTime(1, now + 6); ring.gain.setValueAtTime(0, now + 6.5);
      voice.gain.setValueAtTime(1, now + 6.5);
      pcB.addTrack(d.stream.getAudioTracks()[0]);
    } else {
      pcB.addTrack(osc(1200, 0.3));
    }
    let atB = null;
    pcB.ontrack = (e) => { atB = e.track; };
    const offer = await pcA.createOffer();
    await pcA.setLocalDescription(offer);
    await pcB.setRemoteDescription(offer);
    const answer = await pcB.createAnswer();
    await pcB.setLocalDescription(answer);
    await pcA.setRemoteDescription(answer);

    while (!atB) await sleep(50);
    const sink = new Audio(); sink.muted = true; sink.srcObject = new MediaStream([atB]); sink.play().catch(() => {});
    const an = ac.createAnalyser();
    an.fftSize = 2048;
    ac.createMediaStreamSource(new MediaStream([atB])).connect(an);
    const buf = new Float32Array(an.fftSize);
    const t0 = performance.now();
    const meter = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let s = 0;
      for (const v of buf) s += v * v;
      report.bRms.push([Math.round(performance.now() - t0), Math.sqrt(s / buf.length)]);
    }, 200);

    await sleep(location.search.includes('ringback') ? 14000 : 13000);
    pcA.close();
    await sleep(2500);
    clearInterval(meter);
    pcB.close();
    report.events = window.__events;
  } catch (e) {
    report.errors.push(String(e && e.stack || e));
  }
  await fetch('/report', { method: 'POST', body: JSON.stringify(report) });
})();
