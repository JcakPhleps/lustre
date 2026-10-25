/* =========================================================================
   sfx.js — message sounds, synthesized (no audio files)
   -------------------------------------------------------------------------
   2010/iMessage-era feel:
     playSend()    — a soft airy "whoosh" (band-passed noise swept upward)
     playReceive() — a gentle two-note "ding" (triangle-wave marimba/tri-tone)
   All generated live with the Web Audio API, so there's nothing to download.
   ========================================================================= */

let ctx = null;
let enabled = (() => { try { return localStorage.getItem("lustre.sound") !== "off"; } catch { return true; } })();
let pack = (() => { try { return localStorage.getItem("lustre.pack") || "msn"; } catch { return "msn"; } })();

export function setPack(p) { pack = p; try { localStorage.setItem("lustre.pack", p); } catch {} if (enabled) playReceive(); }
export function getPack() { return pack; }

function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

// browsers need a user gesture before audio can play — unlock on first interaction
["click", "keydown", "touchstart"].forEach(ev =>
  window.addEventListener(ev, () => { try { ac(); } catch {} }, { once: true }));

export function setSoundEnabled(v) {
  enabled = !!v;
  try { localStorage.setItem("lustre.sound", enabled ? "on" : "off"); } catch {}
  if (enabled) playReceive();   // little preview when turned on
}
export function soundEnabled() { return enabled; }

/* a single plucked tone with a fast attack + exponential decay (marimba-ish) */
function tone(c, freq, startAt, dur, peak = 0.22, type = "triangle") {
  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, startAt);
  g.gain.exponentialRampToValueAtTime(peak, startAt + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, startAt + dur);
  osc.connect(g).connect(c.destination);
  osc.start(startAt);
  osc.stop(startAt + dur + 0.02);
}

// ---- send / receive vary by sound pack ----
export function playSend() {
  if (!enabled) return;
  try {
    const c = ac(), t = c.currentTime;
    if (pack === "classic") {
      // airy upward "whoosh" (iMessage-era): band-passed noise swept up
      const dur = 0.19;
      const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const src = c.createBufferSource(); src.buffer = buf;
      const bp = c.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 1.1;
      bp.frequency.setValueAtTime(520, t);
      bp.frequency.exponentialRampToValueAtTime(2300, t + dur);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(bp).connect(g).connect(c.destination);
      src.start(t); src.stop(t + dur);
    } else {
      // MSN: one quick bright blip
      tone(c, 880.00, t, 0.10, 0.18, "triangle");       // A5
    }
  } catch {}
}

export function playReceive() {
  if (!enabled) return;
  try {
    const c = ac(), t = c.currentTime;
    if (pack === "classic") {
      // soft two-note marimba/tri-tone, G5 → C6
      tone(c, 783.99, t + 0.00, 0.33, 0.22, "triangle");
      tone(c, 1046.50, t + 0.09, 0.40, 0.22, "triangle");
    } else {
      // MSN "new message": two quick notes, ascending
      tone(c, 987.77, t + 0.00, 0.11, 0.20, "triangle"); // B5
      tone(c, 1318.51, t + 0.08, 0.15, 0.20, "triangle"); // E6
    }
  } catch {}
}

/* a soft, short key-tick for when the other person is typing */
export function playTyping() {
  if (!enabled) return;
  try {
    const c = ac(), t = c.currentTime;
    tone(c, 1500.0, t, 0.035, 0.05, "sine");
  } catch {}
}

/* super quiet high tick — your message was read */
export function playRead() {
  if (!enabled) return;
  try {
    const c = ac(), t = c.currentTime;
    tone(c, 2093.0, t, 0.05, 0.03, "sine");  // very faint
  } catch {}
}

/* "x is here" — gentle, welcoming two notes ascending */
export function playHere() {
  if (!enabled) return;
  try {
    const c = ac(), t = c.currentTime;
    tone(c, 659.25, t + 0.00, 0.12, 0.10, "sine");  // E5
    tone(c, 987.77, t + 0.09, 0.16, 0.10, "sine");  // B5
  } catch {}
}

/* "x has left" — the same, descending and softer */
export function playLeft() {
  if (!enabled) return;
  try {
    const c = ac(), t = c.currentTime;
    tone(c, 987.77, t + 0.00, 0.12, 0.09, "sine");  // B5
    tone(c, 659.25, t + 0.09, 0.18, 0.09, "sine");  // E5
  } catch {}
}
