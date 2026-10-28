/* =========================================================================
   audio.js — voice messages
   -------------------------------------------------------------------------
   recordVoice() returns a controller: .stop() resolves with {blob, dur, peaks}.
   renderWave(peaks) builds the little bar waveform shown inside a bubble.
   ========================================================================= */

export async function recordVoice() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const rec = new MediaRecorder(stream);
  const chunks = [];
  const started = Date.now();

  // sample loudness for a cheap waveform
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser(); analyser.fftSize = 256;
  src.connect(analyser);
  const buf = new Uint8Array(analyser.frequencyBinCount);
  const peaks = [];
  const sampler = setInterval(() => {
    analyser.getByteFrequencyData(buf);
    const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
    peaks.push(Math.min(1, avg / 128));
  }, 120);

  rec.ondataavailable = e => chunks.push(e.data);
  rec.start();

  return {
    _onLevel: null,
    stop() {
      return new Promise(resolve => {
        clearInterval(sampler);
        rec.onstop = () => {
          stream.getTracks().forEach(t => t.stop());
          ctx.close();
          const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
          const dur = Math.max(1, Math.round((Date.now() - started) / 1000));
          resolve({ blob, dur, peaks: peaks.length ? peaks : [0.3, 0.6, 0.4] });
        };
        rec.stop();
      });
    },
    cancel() { clearInterval(sampler); try { rec.stop(); } catch {} stream.getTracks().forEach(t => t.stop()); ctx.close(); },
  };
}

export function fmtDur(s) {
  const m = Math.floor(s / 60), r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

/* build a waveform element from peak samples (0..1) */
export function renderWave(peaks) {
  const wrap = document.createElement("div"); wrap.className = "wave";
  const target = 22;
  const step = Math.max(1, Math.floor(peaks.length / target));
  for (let i = 0; i < peaks.length; i += step) {
    const bar = document.createElement("i");
    bar.style.height = `${20 + Math.round((peaks[i] || 0) * 80)}%`;
    wrap.appendChild(bar);
  }
  if (!wrap.children.length) for (let i = 0; i < target; i++) { const b = document.createElement("i"); b.style.height = "40%"; wrap.appendChild(b); }
  return wrap;
}
