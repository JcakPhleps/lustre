/* =========================================================================
   sfx.js — message sounds, synthesized (no audio files)
   -------------------------------------------------------------------------
   2010/iMessage-era feel:
     playSend()    — a soft airy "whoosh" (band-passed noise swept upward)
     playReceive() — a gentle two-note "ding" (triangle-wave marimba/tri-tone)
   Packs: "msn" (default), "classic" (iMessage-era), "aero" (Frutiger Aero —
   water-drop bloops and glassy chimes with a soft echo).
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
function tone(c, freq, startAt, dur, peak = 0.22, type = "triangle", dest = c.destination) {
  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.value = freq;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, startAt);
  g.gain.exponentialRampToValueAtTime(peak, startAt + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, startAt + dur);
  osc.connect(g).connect(dest);
  osc.start(startAt);
  osc.stop(startAt + dur + 0.02);
}

/* ---- Frutiger Aero helpers ---- */
// a soft feedback echo that also passes the dry signal through — the "airy" in aero
let echoBus = null;
function echo(c) {
  if (echoBus && echoBus.context === c) return echoBus;
  const input = c.createGain();
  const delay = c.createDelay(1); delay.delayTime.value = 0.16;
  const fb = c.createGain(); fb.gain.value = 0.32;
  const wet = c.createGain(); wet.gain.value = 0.35;
  const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 3800;
  input.connect(c.destination);                                  // dry
  input.connect(delay); delay.connect(lp).connect(fb).connect(delay);
  lp.connect(wet).connect(c.destination);                        // wet tail
  return (echoBus = input);
}
// a water droplet: a sine that swoops in pitch with a quick decay
function droplet(c, t, from, to, dur = 0.12, peak = 0.22, dest = echo(c)) {
  const osc = c.createOscillator(); osc.type = "sine";
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.exponentialRampToValueAtTime(to, t + dur * 0.7);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(dest);
  osc.start(t); osc.stop(t + dur + 0.02);
}
// a glassy chime: sine fundamental + a quiet bell-like overtone
function glass(c, freq, t, dur = 0.6, peak = 0.12) {
  const bus = echo(c);
  tone(c, freq, t, dur, peak, "sine", bus);
  tone(c, freq * 2.76, t, dur * 0.45, peak * 0.22, "sine", bus);
}

// ---- send / receive vary by sound pack ----
export function playSend() {
  if (!enabled) return;
  try {
    const c = ac(), t = c.currentTime;
    if (pack === "aero") {
      // a bubble popping up out of water
      droplet(c, t, 420, 1350, 0.11, 0.24);
      glass(c, 1567.98, t + 0.05, 0.25, 0.04);                  // G6 sparkle
    } else if (pack === "classic") {
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
    if (pack === "aero") {
      // glassy rising chime — C6 E6 G6 C7, a little shimmer of sky
      [1046.50, 1318.51, 1567.98, 2093.00].forEach((f, i) => glass(c, f, t + i * 0.075, 0.7, 0.11));
    } else if (pack === "classic") {
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
    if (pack === "aero") droplet(c, t, 1800, 2400, 0.04, 0.05, c.destination);
    else tone(c, 1500.0, t, 0.035, 0.05, "sine");
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
    if (pack === "aero") { droplet(c, t, 600, 1000, 0.12, 0.12); droplet(c, t + 0.1, 900, 1500, 0.14, 0.12); return; }
    tone(c, 659.25, t + 0.00, 0.12, 0.10, "sine");  // E5
    tone(c, 987.77, t + 0.09, 0.16, 0.10, "sine");  // B5
  } catch {}
}

/* "x has left" — the same, descending and softer */
export function playLeft() {
  if (!enabled) return;
  try {
    const c = ac(), t = c.currentTime;
    if (pack === "aero") { droplet(c, t, 1500, 900, 0.14, 0.1); droplet(c, t + 0.1, 1000, 600, 0.16, 0.1); return; }
    tone(c, 987.77, t + 0.00, 0.12, 0.09, "sine");  // B5
    tone(c, 659.25, t + 0.09, 0.18, 0.09, "sine");  // E5
  } catch {}
}

/* ---- call ringtone: looping MSN-ish jingle ---- */
let ringTimer = null;
function ringMotif(c, t0) {
  if (pack === "aero") {
    // floating pentatonic phrase over a soft echo: E6 B5 G#6 E6 … B6
    [[1318.51, 0], [987.77, 0.18], [1661.22, 0.36], [1318.51, 0.54], [1975.53, 0.78]]
      .forEach(([f, dt]) => glass(c, f, t0 + dt, 0.55, 0.13));
    return;
  }
  // bright little phrase that repeats, phone-call feel
  tone(c, 659.25, t0 + 0.00, 0.16, 0.16, "triangle"); // E5
  tone(c, 987.77, t0 + 0.16, 0.16, 0.16, "triangle"); // B5
  tone(c, 1318.51, t0 + 0.32, 0.16, 0.16, "triangle"); // E6
  tone(c, 987.77, t0 + 0.52, 0.28, 0.15, "triangle"); // B5 (held)
}
export function startRing() {
  if (ringTimer || !enabled) return;
  const play = () => { try { const c = ac(); ringMotif(c, c.currentTime); } catch {} };
  play();
  ringTimer = setInterval(play, 1700);
}
export function stopRing() { if (ringTimer) { clearInterval(ringTimer); ringTimer = null; } }
