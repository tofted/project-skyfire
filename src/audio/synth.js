// Procedural sound bank: every sound is a small WebAudio node graph built on demand (no audio files).
// Works on AudioContext and OfflineAudioContext alike, so tools/ui/audio_levels.mjs renders the same code offline.
//   makeBank(ctx)                      -> shared buffers (noise colours, fire crackle, reverb IR, shaper curves)
//   SOUNDS[name](ctx, bank, out, t, o) -> schedules a one-shot at time t into `out`; returns its length (s)
//   LOOPS[name](ctx, bank, out, o)     -> starts a loop now; returns { set(params), stop(when?) }
// o.rate is a pitch multiplier everywhere; o.strength / o.size shape individual sounds.

const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
export { midiHz };

export function makeBank(ctx) {
  const sr = ctx.sampleRate;
  let seed = 0x2545f491;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const mk = (seconds, ch, fill) => {
    const b = ctx.createBuffer(ch, Math.floor(sr * seconds), sr);
    for (let c = 0; c < ch; c++) fill(b.getChannelData(c), c);
    return b;
  };
  const white = mk(3, 1, (d) => { for (let i = 0; i < d.length; i++) d[i] = rnd() * 2 - 1; });
  const pink = mk(4, 1, (d) => {          // Paul Kellet's refined pink filter
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < d.length; i++) {
      const w = rnd() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
    }
  });
  const brown = mk(4, 1, (d) => {
    let last = 0;
    for (let i = 0; i < d.length; i++) { last = (last + 0.02 * (rnd() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
  });
  const crackle = mk(3, 1, (d) => {       // sparse pops with tiny noisy tails: burning wood / fire
    let i = 0;
    while (i < d.length) {
      i += Math.floor(sr * (0.003 + rnd() * 0.028));
      const a = Math.pow(rnd(), 1.6) * (rnd() < 0.5 ? -1 : 1);
      const n = Math.floor(sr * (0.0006 + rnd() * 0.0035));
      for (let k = 0; k < n && i + k < d.length; k++) d[i + k] += a * Math.exp(-k / (n * 0.28)) * (rnd() * 1.6 - 0.8);
    }
  });
  const ir = mk(2.8, 2, (d, c) => {       // hall: early reflections + exponentially decaying noise, darker late tail
    let lp = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      lp += ((rnd() * 2 - 1) - lp) * (0.55 - 0.4 * Math.min(1, t / 2.2));
      d[i] = lp * Math.exp(-t * 2.1) * Math.min(1, t / 0.012);
    }
    for (const [dt, g] of [[0.011, 0.55], [0.019, 0.42], [0.029, 0.33], [0.043, 0.26], [0.061, 0.2]]) {
      const idx = Math.floor((dt + c * 0.0037) * sr); if (idx < d.length) d[idx] += g * (c ? -1 : 1);
    }
  });
  const curve = (k) => {
    const n = 2048, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
    return c;
  };
  return { white, pink, brown, crackle, ir, soft: curve(1.5), hard: curve(4.5) };
}

// ---------- small node helpers ----------
const EPS = 0.0001;
function amp(ctx, v = 0) { const g = ctx.createGain(); g.gain.value = v; return g; }
function filt(ctx, type, f, Q = 0.707) { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = Q; return b; }
function osc(ctx, type, f, t) { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.start(t); return o; }
function noise(ctx, buf, t, rate = 1, loop = true) {
  const s = ctx.createBufferSource(); s.buffer = buf; s.loop = loop; s.playbackRate.value = rate;
  s.start(t, Math.random() * Math.max(0, buf.duration - 0.5));
  return s;
}
function shaper(ctx, curveArr) { const w = ctx.createWaveShaper(); w.curve = curveArr; w.oversample = '2x'; return w; }
/** Percussive envelope: linear attack to peak, exponential decay to silence. */
function perc(p, t, a, d, peak) {
  p.setValueAtTime(EPS, t);
  p.linearRampToValueAtTime(peak, t + Math.max(0.001, a));
  p.exponentialRampToValueAtTime(EPS, t + a + d);
}
function sweep(p, t, from, to, dur) { p.setValueAtTime(from, t); p.exponentialRampToValueAtTime(Math.max(1, to), t + dur); }
function stopAll(list, t) { for (const n of list) { try { n.stop(t); } catch { /* already stopped */ } } }
/** Envelope through a list of [time offset, value] points (linear ramps), then an exponential release. */
function shape(p, t, pts, releaseEnd) {
  p.setValueAtTime(EPS, t);
  for (const [dt, v] of pts) p.linearRampToValueAtTime(Math.max(EPS, v), t + dt);
  if (releaseEnd) p.exponentialRampToValueAtTime(EPS, t + releaseEnd);
}
/** Dry + hall send (the shared stereo IR from the bank): gives the titan's sounds the size of the open sky. */
function hall(ctx, B, out, wet = 0.35) {
  const inp = amp(ctx, 1);
  inp.connect(out);
  try {
    const cv = ctx.createConvolver(); cv.normalize = true; cv.buffer = B.ir;
    const wg = amp(ctx, wet); inp.connect(cv).connect(wg).connect(out);
  } catch { /* no convolver: dry only */ }
  return inp;
}
/** Echo off the cloud deck: one filtered feedback delay. */
function slap(ctx, out, time = 0.3, fb = 0.32, cutoff = 900) {
  const inp = amp(ctx, 1); inp.connect(out);
  const d = ctx.createDelay(2); d.delayTime.value = time;
  const lp = filt(ctx, 'lowpass', cutoff, 0.5); const g = amp(ctx, fb);
  inp.connect(d); d.connect(lp).connect(g); g.connect(d); g.connect(out);
  return inp;
}
const IR_TAIL = 2.6;   // seconds of hall tail after the dry part of a sound

// ---------- one-shots ----------
export const SOUNDS = {
  /** Deep "whomp" of one downstroke. o.size: 0.8 enemy dragon, 1 Sora, 4 titan. */
  wingbeat(ctx, B, out, t, o = {}) {
    const s = o.strength ?? 0.7, size = o.size ?? 1, r = o.rate ?? 1;
    const k = Math.sqrt(size);
    const dur = 0.5 * k + 0.35;
    const g = amp(ctx, 1); g.connect(out);
    const srcs = [];
    // chest thump (kept above ~40 Hz so laptop speakers still convey it)
    const o1 = osc(ctx, 'sine', 90, t); srcs.push(o1);
    sweep(o1.frequency, t, Math.max(46, 88 / k) * r, Math.max(34, 44 / k) * r, 0.26 * k);
    const g1 = amp(ctx); perc(g1.gain, t, 0.03 * k, 0.3 * k, 0.55 * (0.45 + 0.55 * s));
    o1.connect(g1).connect(g);
    // displaced air: brown noise through a falling band
    const n1 = noise(ctx, B.brown, t, r); srcs.push(n1);
    const bp = filt(ctx, 'bandpass', 240, 0.8); sweep(bp.frequency, t, 300 / k * r, 105 / k * r, 0.45 * k);
    const g2 = amp(ctx); perc(g2.gain, t + 0.015, 0.08 * k, 0.4 * k, 1.5 * (0.3 + 0.7 * s));
    n1.connect(bp).connect(g2).connect(g);
    // membrane snap as the wing locks at the bottom of the stroke
    const n2 = noise(ctx, B.pink, t + 0.12 * k, r); srcs.push(n2);
    const bp2 = filt(ctx, 'bandpass', 820 / Math.sqrt(k) * r, 1.3);
    const g3 = amp(ctx); perc(g3.gain, t + 0.12 * k, 0.006, 0.1 * k, 0.5 * s);
    n2.connect(bp2).connect(g3).connect(g);
    if (size > 2) {       // titan: a long rush of air after the stroke
      const n3 = noise(ctx, B.pink, t, r); srcs.push(n3);
      const lp = filt(ctx, 'lowpass', 500, 0.5); sweep(lp.frequency, t, 700 * r, 160 * r, 1.4);
      const g4 = amp(ctx); perc(g4.gain, t + 0.1, 0.35, 1.2, 0.7 * s);
      n3.connect(lp).connect(g4).connect(g);
    }
    stopAll(srcs, t + dur + 0.1);
    return dur;
  },

  /** Fireball launch: "fwoomp" + rising flame whoosh. o.size 1 dragon, 2.5 titan orb. */
  fireball(ctx, B, out, t, o = {}) {
    const r = (o.rate ?? 1) / Math.sqrt(o.size ?? 1), dur = 0.9;
    const g = amp(ctx, 1); g.connect(out);
    const o1 = osc(ctx, 'sine', 120, t); sweep(o1.frequency, t, 150 * r, 48 * r, 0.25);
    const g1 = amp(ctx); perc(g1.gain, t, 0.01, 0.26, 0.6); o1.connect(g1).connect(g);
    const n = noise(ctx, B.pink, t); const bp = filt(ctx, 'bandpass', 500, 1.1);
    bp.frequency.setValueAtTime(380 * r, t); bp.frequency.exponentialRampToValueAtTime(2300 * r, t + 0.14);
    bp.frequency.exponentialRampToValueAtTime(700 * r, t + 0.7);
    const g2 = amp(ctx); perc(g2.gain, t, 0.05, 0.7, 1.6); n.connect(bp).connect(g2).connect(g);
    const c = noise(ctx, B.crackle, t); const hp = filt(ctx, 'highpass', 1500);
    const g3 = amp(ctx); perc(g3.gain, t + 0.02, 0.05, 0.6, 0.9); c.connect(hp).connect(g3).connect(g);
    stopAll([o1, n, c], t + dur);
    return dur;
  },

  /** Explosion. o.size ~ radius/6, o.far 0..1 darkens it (distance). */
  explosion(ctx, B, out, t, o = {}) {
    const size = o.size ?? 1, far = o.far ?? 0, r = (o.rate ?? 1) / Math.pow(size, 0.18);
    const dur = 1.6 + 0.6 * Math.min(2, size);
    const g = amp(ctx, 1); const ws = shaper(ctx, B.soft); const lpOut = filt(ctx, 'lowpass', 12000 * (1 - far * 0.85) + 400);
    g.connect(ws).connect(lpOut).connect(out);
    const sub = osc(ctx, 'sine', 90, t); sweep(sub.frequency, t, 95 * r, 30 * r, 0.7);
    const g1 = amp(ctx); perc(g1.gain, t, 0.006, 1.0 + 0.3 * size, 0.9); sub.connect(g1).connect(g);
    const body = noise(ctx, B.brown, t, r); const lp = filt(ctx, 'lowpass', 2000, 0.6);
    sweep(lp.frequency, t, 2600 * r, 160 * r, 1.4);
    const g2 = amp(ctx); perc(g2.gain, t, 0.004, 1.5 + 0.4 * size, 1.5); body.connect(lp).connect(g2).connect(g);
    const crack = noise(ctx, B.white, t); const hp = filt(ctx, 'highpass', 1400);
    const g3 = amp(ctx); perc(g3.gain, t, 0.001, 0.09, 0.8 * (1 - far)); crack.connect(hp).connect(g3).connect(g);
    const deb = noise(ctx, B.crackle, t + 0.05, 0.8 * r); const bp = filt(ctx, 'bandpass', 2400, 0.8);
    const g4 = amp(ctx); perc(g4.gain, t + 0.05, 0.1, 1.2, 0.8 * (1 - far * 0.7)); deb.connect(bp).connect(g4).connect(g);
    stopAll([sub, body, crack, deb], t + dur);
    return dur;
  },

  /** Big creature roar. o.voice 'titan' (deep, long) or 'dragon' (screech). */
  roar(ctx, B, out, t, o = {}) {
    const titan = (o.voice ?? 'titan') === 'titan';
    const r = o.rate ?? 1;
    const f0 = (titan ? 58 : 170) * r, dur = titan ? 3.2 : 1.25;
    const g = amp(ctx, 1); const ws = shaper(ctx, B.hard); const post = amp(ctx, titan ? 0.5 : 0.42);
    const src = amp(ctx, 1);
    const srcs = [];
    const det = [-14, -6, 0, 7, 15];
    for (const d of det) {
      const v = osc(ctx, 'sawtooth', f0, t); v.detune.value = d * (titan ? 1.6 : 1); srcs.push(v);
      const f = v.frequency;
      f.setValueAtTime(f0 * 0.8, t); f.linearRampToValueAtTime(f0 * 1.12, t + dur * 0.18);
      f.linearRampToValueAtTime(f0 * 1.0, t + dur * 0.55); f.linearRampToValueAtTime(f0 * 0.66, t + dur);
      v.connect(src);
    }
    // growl: amplitude modulation at a rough, throaty rate
    const trem = osc(ctx, 'sine', titan ? 23 : 41, t); const tremG = amp(ctx, 0.45); srcs.push(trem);
    const am = amp(ctx, 0.6); trem.connect(tremG).connect(am.gain); src.connect(am);
    // formants ("aah" -> "ooh" as the jaw closes)
    const fm = titan ? [330, 760, 1900] : [650, 1350, 2900];
    const fg = [1.0, 0.7, 0.35];
    fm.forEach((fr, i) => {
      const b = filt(ctx, 'bandpass', fr * r, 5 + i); b.frequency.setValueAtTime(fr * r, t);
      b.frequency.linearRampToValueAtTime(fr * r * 0.78, t + dur);
      const bg = amp(ctx, fg[i] * 3.2); am.connect(b).connect(bg).connect(g);
    });
    const br = noise(ctx, B.pink, t); srcs.push(br);
    const bb = filt(ctx, 'bandpass', (titan ? 900 : 2300) * r, 0.9); const bg = amp(ctx, 0.6); br.connect(bb).connect(bg).connect(g);
    // the titan's roar fills the sky: sub layer + hall
    if (titan) {
      const sub = osc(ctx, 'sine', f0 * 0.5, t); srcs.push(sub);
      sub.frequency.setValueAtTime(f0 * 0.42, t); sub.frequency.linearRampToValueAtTime(f0 * 0.56, t + dur * 0.2); sub.frequency.linearRampToValueAtTime(f0 * 0.34, t + dur);
      const sg = amp(ctx, 0.9); sub.connect(sg).connect(g);
    }
    g.connect(ws).connect(post).connect(titan ? hall(ctx, B, out, 0.38) : out);
    perc(g.gain, t, dur * 0.12, dur * 0.88, 1);
    stopAll(srcs, t + dur + 0.05);
    return dur + (titan ? IR_TAIL : 0.1);
  },

  /** Generic doppler whoosh of a huge hand passing (fallback when no hand position is known). */
  swat(ctx, B, out, t, o = {}) {
    const r = o.rate ?? 1, dur = o.duration ?? 1.1;
    const g = amp(ctx, 1); g.connect(out);
    const n = noise(ctx, B.pink, t); const bp = filt(ctx, 'bandpass', 300, 1.1);
    const f = bp.frequency; f.setValueAtTime(220 * r, t); f.exponentialRampToValueAtTime(900 * r, t + dur * 0.55);
    f.exponentialRampToValueAtTime(170 * r, t + dur);
    const g1 = amp(ctx); const gp = g1.gain;
    gp.setValueAtTime(EPS, t); gp.exponentialRampToValueAtTime(1.8, t + dur * 0.55); gp.exponentialRampToValueAtTime(EPS, t + dur);
    n.connect(bp).connect(g1).connect(g);
    const low = noise(ctx, B.brown, t); const lp = filt(ctx, 'lowpass', 180);
    const g2 = amp(ctx); const lpG = g2.gain;
    lpG.setValueAtTime(EPS, t); lpG.exponentialRampToValueAtTime(1.6, t + dur * 0.58); lpG.exponentialRampToValueAtTime(EPS, t + dur);
    low.connect(lp).connect(g2).connect(g);
    stopAll([n, low], t + dur + 0.05);
    return dur;
  },

  /** Short fly-by whoosh (fireball passing close). o.doppler > 1 approaching. */
  whoosh(ctx, B, out, t, o = {}) {
    const r = o.rate ?? 1, dur = 0.55;
    const g = amp(ctx, 1); g.connect(out);
    const n = noise(ctx, B.pink, t); const bp = filt(ctx, 'bandpass', 900, 1.4);
    bp.frequency.setValueAtTime(1400 * r, t); bp.frequency.exponentialRampToValueAtTime(380 * r, t + dur);
    const g1 = amp(ctx); perc(g1.gain, t, 0.18, 0.37, 1.4); n.connect(bp).connect(g1).connect(g);
    const c = noise(ctx, B.crackle, t); const hp = filt(ctx, 'highpass', 2000);
    const g2 = amp(ctx); perc(g2.gain, t, 0.15, 0.35, 0.6); c.connect(hp).connect(g2).connect(g);
    stopAll([n, c], t + dur + 0.05);
    return dur;
  },

  /** Storm thunder: crack then long rolling rumble. o.far 0..1 (distant thunder has no crack). */
  thunder(ctx, B, out, t, o = {}) {
    const far = o.far ?? 0.5, dur = 5.5;
    const g = amp(ctx, 1); const ws = shaper(ctx, B.soft); g.connect(ws).connect(out);
    const srcs = [];
    if (far < 0.8) {
      const c = noise(ctx, B.white, t); srcs.push(c);
      const bp = filt(ctx, 'bandpass', 2600, 0.6); const cg = amp(ctx);
      const p = cg.gain; p.setValueAtTime(EPS, t);
      for (let i = 0; i < 5; i++) { const ti = t + i * 0.035 + Math.random() * 0.02; p.linearRampToValueAtTime(0.9 * (1 - far) * (1 - i * 0.15), ti + 0.004); p.exponentialRampToValueAtTime(0.02, ti + 0.03); }
      p.exponentialRampToValueAtTime(EPS, t + 0.4);
      c.connect(bp).connect(cg).connect(g);
    }
    const rb = noise(ctx, B.brown, t, 0.7); srcs.push(rb);
    const lp = filt(ctx, 'lowpass', 900 - far * 600, 0.5); const rg = amp(ctx);
    const q = rg.gain; q.setValueAtTime(EPS, t);
    let tt = t + 0.05;
    for (let i = 0; i < 6; i++) {          // rolling bumps
      const a = (1.7 - i * 0.22) * (0.7 + Math.random() * 0.5);
      q.linearRampToValueAtTime(Math.max(0.05, a), tt + 0.12 + Math.random() * 0.15);
      tt += 0.45 + Math.random() * 0.5;
      q.linearRampToValueAtTime(Math.max(0.03, a * 0.35), tt);
    }
    q.exponentialRampToValueAtTime(EPS, t + dur);
    rb.connect(lp).connect(rg).connect(g);
    stopAll(srcs, t + dur + 0.05);
    return dur;
  },

  /** Deep ground-and-sky rumble (the titan stirring beneath the cloud sea). */
  rumble(ctx, B, out, t, o = {}) {
    const dur = o.duration ?? 4.5;
    const g = amp(ctx, 1); const ws = shaper(ctx, B.soft); g.connect(ws).connect(out);
    const n = noise(ctx, B.brown, t, 0.5); const lp = filt(ctx, 'lowpass', 140, 0.8);
    const ng = amp(ctx); const p = ng.gain;
    p.setValueAtTime(EPS, t);
    let tt = t;
    for (let i = 0; i < 5; i++) { tt += dur / 6; p.linearRampToValueAtTime(0.65 * (0.6 + 0.4 * Math.sin(i * 1.7) ** 2), tt); }
    p.exponentialRampToValueAtTime(EPS, t + dur);
    n.connect(lp).connect(ng).connect(g);
    const sub = osc(ctx, 'sine', 34, t); const sg = amp(ctx);
    sg.gain.setValueAtTime(EPS, t); sg.gain.linearRampToValueAtTime(0.3, t + dur * 0.4); sg.gain.exponentialRampToValueAtTime(EPS, t + dur);
    sub.connect(sg).connect(g);
    // stone grinding: sparse crackle through a low band
    const c = noise(ctx, B.crackle, t, 0.35); const bp = filt(ctx, 'bandpass', 420, 1.2); const cg = amp(ctx);
    cg.gain.setValueAtTime(EPS, t); cg.gain.linearRampToValueAtTime(0.9, t + dur * 0.5); cg.gain.exponentialRampToValueAtTime(EPS, t + dur);
    c.connect(bp).connect(cg).connect(g);
    stopAll([n, sub, c], t + dur + 0.05);
    return dur;
  },

  /** The player gets hit: body thud + crunch. */
  hit(ctx, B, out, t, o = {}) {
    const s = o.strength ?? 1, dur = 0.45;
    const g = amp(ctx, 1); g.connect(out);
    const o1 = osc(ctx, 'sine', 130, t); sweep(o1.frequency, t, 140, 48, 0.2);
    const g1 = amp(ctx); perc(g1.gain, t, 0.004, 0.28, 0.9 * s); o1.connect(g1).connect(g);
    const n = noise(ctx, B.white, t); const bp = filt(ctx, 'bandpass', 1600, 0.9);
    const g2 = amp(ctx); perc(g2.gain, t, 0.002, 0.12, 0.9 * s); n.connect(bp).connect(g2).connect(g);
    const n2 = noise(ctx, B.brown, t); const lp = filt(ctx, 'lowpass', 700);
    const g3 = amp(ctx); perc(g3.gain, t, 0.003, 0.3, 0.9 * s); n2.connect(lp).connect(g3).connect(g);
    stopAll([o1, n, n2], t + dur);
    return dur;
  },

  /** Our attack connected: short bright tick (UI-like, not positional). */
  hitmarker(ctx, B, out, t, o = {}) {
    const s = o.strength ?? 1, r = o.rate ?? 1;
    const g = amp(ctx, 1); g.connect(out);
    const a = osc(ctx, 'triangle', 2100 * r, t); const ga = amp(ctx); perc(ga.gain, t, 0.002, 0.06, 0.35 * s); a.connect(ga).connect(g);
    const b = osc(ctx, 'sine', 3150 * r, t + 0.012); const gb = amp(ctx); perc(gb.gain, t + 0.012, 0.002, 0.05, 0.22 * s); b.connect(gb).connect(g);
    const n = noise(ctx, B.white, t); const hp = filt(ctx, 'highpass', 5000); const gn = amp(ctx); perc(gn.gain, t, 0.001, 0.02, 0.25 * s);
    n.connect(hp).connect(gn).connect(g);
    stopAll([a, b, n], t + 0.15);
    return 0.15;
  },

  /** Enemy downed: bright chime + low boom (the "kill confirm"). */
  kill(ctx, B, out, t, o = {}) {
    const g = amp(ctx, 1); g.connect(out);
    const srcs = [];
    const r = o.rate ?? 1;                          // the HUD's combo raises it step by step
    [88, 92, 95, 100].forEach((m, i) => {          // E6 G#6 B6 E7 arpeggio
      const ti = t + i * 0.055;
      const v = osc(ctx, 'sine', midiHz(m) * r, ti); const v2 = osc(ctx, 'triangle', midiHz(m) * 2.01 * r, ti); srcs.push(v, v2);
      const gv = amp(ctx); perc(gv.gain, ti, 0.004, 0.9 - i * 0.12, 0.2); v.connect(gv).connect(g);
      const gv2 = amp(ctx); perc(gv2.gain, ti, 0.002, 0.25, 0.05); v2.connect(gv2).connect(g);
    });
    const sub = osc(ctx, 'sine', 70, t); sweep(sub.frequency, t, 80, 38, 0.4); srcs.push(sub);
    const gs = amp(ctx); perc(gs.gain, t, 0.005, 0.5, 0.7); sub.connect(gs).connect(g);
    stopAll(srcs, t + 1.2);
    return 1.2;
  },

  /** Telegraph sting: anime eye-glint shimmer + a low hit. Plays with every titan telegraph. */
  sting(ctx, B, out, t, o = {}) {
    const g = amp(ctx, 1); g.connect(out);
    const srcs = [];
    [96, 103, 108].forEach((m, i) => {
      const v = osc(ctx, 'sine', midiHz(m), t + i * 0.03); srcs.push(v);
      const gv = amp(ctx); perc(gv.gain, t + i * 0.03, 0.003, 0.5, 0.12); v.connect(gv).connect(g);
    });
    const n = noise(ctx, B.white, t); const bp = filt(ctx, 'bandpass', 7000, 2); srcs.push(n);
    const gn = amp(ctx); const p = gn.gain; p.setValueAtTime(EPS, t); p.exponentialRampToValueAtTime(0.35, t + 0.08); p.exponentialRampToValueAtTime(EPS, t + 0.45);
    n.connect(bp).connect(gn).connect(g);
    const d = osc(ctx, 'sine', 60, t); sweep(d.frequency, t, 75, 40, 0.35); srcs.push(d);
    const gd = amp(ctx); perc(gd.gain, t, 0.004, 0.5, (o.strength ?? 1) * 0.9); d.connect(gd).connect(g);
    stopAll(srcs, t + 0.9);
    return 0.9;
  },

  /** Alarm: two-tone beeps (warning banners). o.level 1 warn, 2 danger (faster, higher). */
  warning(ctx, B, out, t, o = {}) {
    const lv = o.level ?? 1, n = lv >= 2 ? 4 : 2, step = lv >= 2 ? 0.14 : 0.2;
    const g = amp(ctx, 1); const lp = filt(ctx, 'lowpass', 2600); g.connect(lp).connect(out);
    const srcs = [];
    for (let i = 0; i < n; i++) {
      const ti = t + i * step;
      const v = osc(ctx, 'square', i % 2 ? (lv >= 2 ? 740 : 660) : (lv >= 2 ? 988 : 880), ti); srcs.push(v);
      const gv = amp(ctx); const p = gv.gain; p.setValueAtTime(EPS, ti); p.linearRampToValueAtTime(0.22, ti + 0.006);
      p.setValueAtTime(0.22, ti + step * 0.62); p.exponentialRampToValueAtTime(EPS, ti + step * 0.9);
      v.connect(gv).connect(g);
    }
    stopAll(srcs, t + n * step + 0.05);
    return n * step + 0.1;
  },

  /** Overheat: steam hiss + two dry coughs. */
  overheat(ctx, B, out, t) {
    const g = amp(ctx, 1); g.connect(out);
    const n = noise(ctx, B.white, t); const hp = filt(ctx, 'highpass', 3200);
    const g1 = amp(ctx); perc(g1.gain, t, 0.03, 1.0, 0.45); n.connect(hp).connect(g1).connect(g);
    const srcs = [n];
    for (const dt of [0.12, 0.42]) {
      const c = noise(ctx, B.brown, t + dt); const bp = filt(ctx, 'bandpass', 420, 1.5); srcs.push(c);
      const gc = amp(ctx); perc(gc.gain, t + dt, 0.01, 0.16, 1.8); c.connect(bp).connect(gc).connect(g);
    }
    stopAll(srcs, t + 1.2);
    return 1.2;
  },

  /** Dodge roll swish. */
  dodge(ctx, B, out, t) {
    const g = amp(ctx, 1); g.connect(out);
    const n = noise(ctx, B.pink, t); const bp = filt(ctx, 'bandpass', 700, 1.6);
    bp.frequency.setValueAtTime(500, t); bp.frequency.exponentialRampToValueAtTime(3200, t + 0.16); bp.frequency.exponentialRampToValueAtTime(900, t + 0.42);
    const g1 = amp(ctx); perc(g1.gain, t, 0.08, 0.34, 1.5); n.connect(bp).connect(g1).connect(g);
    stopAll([n], t + 0.5);
    return 0.5;
  },

  /** Boost: swelling rush + a heavy stroke. */
  boost(ctx, B, out, t) {
    const g = amp(ctx, 1); g.connect(out);
    const n = noise(ctx, B.pink, t); const lp = filt(ctx, 'lowpass', 600, 0.8); sweep(lp.frequency, t, 400, 5000, 0.5);
    const g1 = amp(ctx); perc(g1.gain, t, 0.3, 0.6, 0.9); n.connect(lp).connect(g1).connect(g);
    SOUNDS.wingbeat(ctx, B, g, t, { strength: 1, size: 1.1 });
    stopAll([n], t + 1);
    return 1;
  },

  lock(ctx, B, out, t) {
    const g = amp(ctx, 1); g.connect(out);
    const a = osc(ctx, 'sine', 1175, t); const b = osc(ctx, 'sine', 1568, t + 0.07);
    const ga = amp(ctx); perc(ga.gain, t, 0.003, 0.06, 0.2); a.connect(ga).connect(g);
    const gb = amp(ctx); perc(gb.gain, t + 0.07, 0.003, 0.09, 0.2); b.connect(gb).connect(g);
    stopAll([a, b], t + 0.25);
    return 0.25;
  },

  heartbeat(ctx, B, out, t) {
    const g = amp(ctx, 1); g.connect(out);
    const srcs = [];
    for (const [dt, a] of [[0, 1], [0.16, 0.7]]) {
      const v = osc(ctx, 'sine', 58, t + dt); sweep(v.frequency, t + dt, 64, 42, 0.12); srcs.push(v);
      const gv = amp(ctx); perc(gv.gain, t + dt, 0.01, 0.16, 0.8 * a); v.connect(gv).connect(g);
    }
    stopAll(srcs, t + 0.5);
    return 0.5;
  },

  // UI clicks: soft wooden/glass ticks, never harsh.
  uiMove(ctx, B, out, t) {
    const v = osc(ctx, 'sine', 1480, t); const g = amp(ctx); perc(g.gain, t, 0.002, 0.045, 0.14);
    v.connect(g).connect(out); v.stop(t + 0.08); return 0.08;
  },
  uiSelect(ctx, B, out, t) {
    const g = amp(ctx, 1); g.connect(out);
    const a = osc(ctx, 'triangle', 880, t); const b = osc(ctx, 'triangle', 1320, t + 0.06);
    const ga = amp(ctx); perc(ga.gain, t, 0.003, 0.12, 0.22); a.connect(ga).connect(g);
    const gb = amp(ctx); perc(gb.gain, t + 0.06, 0.003, 0.22, 0.22); b.connect(gb).connect(g);
    stopAll([a, b], t + 0.35); return 0.35;
  },
  uiBack(ctx, B, out, t) {
    const g = amp(ctx, 1); g.connect(out);
    const a = osc(ctx, 'triangle', 990, t); const b = osc(ctx, 'triangle', 660, t + 0.06);
    const ga = amp(ctx); perc(ga.gain, t, 0.003, 0.1, 0.18); a.connect(ga).connect(g);
    const gb = amp(ctx); perc(gb.gain, t + 0.06, 0.003, 0.18, 0.18); b.connect(gb).connect(g);
    stopAll([a, b], t + 0.3); return 0.3;
  },
  /** A wave is cleared: a rising major triad on soft horns (triangle + saw through a low-pass) over a taiko hit. */
  waveClear(ctx, B, out, t) {
    const g = amp(ctx, 1); g.connect(out);
    const srcs = [];
    [[64, 0], [68, 0.09], [71, 0.18], [76, 0.3]].forEach(([m, dt]) => {   // E4 G#4 B4 E5
      const ti = t + dt, f = midiHz(m);
      const a = osc(ctx, 'triangle', f, ti), b = osc(ctx, 'sawtooth', f * 1.003, ti); srcs.push(a, b);
      const lp = filt(ctx, 'lowpass', 1400, 0.7); sweep(lp.frequency, ti, 900, 2600, 0.25);
      const ga = amp(ctx); perc(ga.gain, ti, 0.03, 1.1 - dt, 0.16); a.connect(ga).connect(g);
      const gb = amp(ctx); perc(gb.gain, ti, 0.04, 0.9 - dt, 0.06); b.connect(lp).connect(gb).connect(g);
    });
    const d = osc(ctx, 'sine', 80, t); sweep(d.frequency, t, 92, 46, 0.4); srcs.push(d);
    const gd = amp(ctx); perc(gd.gain, t, 0.004, 0.6, 0.7); d.connect(gd).connect(g);
    const n = noise(ctx, B.pink, t); const bp = filt(ctx, 'bandpass', 6000, 1.6); srcs.push(n);
    const gn = amp(ctx); shape(gn.gain, t, [[0.35, 0.18]], 1.5); n.connect(bp).connect(gn).connect(g);
    stopAll(srcs, t + 1.6);
    return 1.6;
  },
  /** Banner / wave start: soft taiko + shimmer. */
  banner(ctx, B, out, t) {
    const g = amp(ctx, 1); g.connect(out);
    const d = osc(ctx, 'sine', 70, t); sweep(d.frequency, t, 88, 44, 0.4);
    const gd = amp(ctx); perc(gd.gain, t, 0.004, 0.7, 0.8); d.connect(gd).connect(g);
    const n = noise(ctx, B.pink, t); const bp = filt(ctx, 'bandpass', 5200, 1.5);
    const gn = amp(ctx); const p = gn.gain; p.setValueAtTime(EPS, t); p.exponentialRampToValueAtTime(0.25, t + 0.3); p.exponentialRampToValueAtTime(EPS, t + 1.4);
    n.connect(bp).connect(gn).connect(g);
    stopAll([d, n], t + 1.5); return 1.5;
  },
};

// ---------- the Cloud Titan ----------
// The titan (actors/titan.js) calls game.audio.play with these names at its own attack stages (pos = its body).
// Each is built to read at 150–600 m: long, low, with a hall send, and distinct in shape so the ear learns them:
// inhale rises, whoosh swells and falls, crack is a chain of transients, charge climbs in pitch, clap is a single
// broadband crack with a slap echo, slam is lower and longer, gust is a flutter of wind, fall is seven seconds.
Object.assign(SOUNDS, {
  /** A colossal breath before an attack: rising air through a throat the size of a house. */
  'titan-inhale'(ctx, B, out, t, o = {}) {
    const r = o.rate ?? 1, dur = o.duration ?? 1.5;
    const g = amp(ctx, 1); g.connect(hall(ctx, B, out, 0.3));
    const srcs = [];
    const n = noise(ctx, B.pink, t, r); srcs.push(n);
    const bp = filt(ctx, 'bandpass', 200, 0.9); sweep(bp.frequency, t, 170 * r, 1150 * r, dur * 0.92);
    const ng = amp(ctx); shape(ng.gain, t, [[dur * 0.25, 0.35], [dur * 0.85, 1.25], [dur * 0.93, 1.1]], dur + 0.12);
    n.connect(bp).connect(ng).connect(g);
    const th = noise(ctx, B.brown, t, r); srcs.push(th);                    // throat resonance
    const tb = filt(ctx, 'bandpass', 95, 3); sweep(tb.frequency, t, 85 * r, 170 * r, dur);
    const tg = amp(ctx); shape(tg.gain, t, [[dur * 0.3, 0.6], [dur * 0.88, 1.6]], dur + 0.15);
    th.connect(tb).connect(tg).connect(g);
    const s = osc(ctx, 'sine', 36 * r, t); srcs.push(s); sweep(s.frequency, t, 34 * r, 52 * r, dur);   // chest draw
    const sg = amp(ctx); shape(sg.gain, t, [[dur * 0.8, 0.4]], dur + 0.2);
    s.connect(sg).connect(g);
    const w = noise(ctx, B.white, t, 1); srcs.push(w);                      // whistle through the teeth
    const wb = filt(ctx, 'bandpass', 2400, 16); sweep(wb.frequency, t, 2200 * r, 3300 * r, dur);
    const wg = amp(ctx); shape(wg.gain, t, [[dur * 0.6, 0.02], [dur * 0.9, 0.12]], dur + 0.1);
    w.connect(wb).connect(wg).connect(g);
    stopAll(srcs, t + dur + 0.3);
    return dur + IR_TAIL;
  },

  /** The arm starts its swing: a pressure thump, a stone creak, then a huge band of air that swells and falls. */
  'titan-whoosh'(ctx, B, out, t, o = {}) {
    const r = o.rate ?? 1, dur = o.duration ?? 1.35;
    const g = amp(ctx, 0.95); g.connect(hall(ctx, B, out, 0.25));
    const srcs = [];
    const th = osc(ctx, 'sine', 46 * r, t); srcs.push(th); sweep(th.frequency, t, 48 * r, 29 * r, 0.5);
    const tg = amp(ctx); perc(tg.gain, t, 0.04, 0.6, 0.7); th.connect(tg).connect(g);
    const n = noise(ctx, B.brown, t, r); srcs.push(n);
    const lp = filt(ctx, 'lowpass', 260, 0.7);
    lp.frequency.setValueAtTime(220 * r, t); lp.frequency.exponentialRampToValueAtTime(760 * r, t + dur * 0.55); lp.frequency.exponentialRampToValueAtTime(170 * r, t + dur);
    const ng = amp(ctx); shape(ng.gain, t, [[dur * 0.55, 1.9]], dur + 0.1);
    n.connect(lp).connect(ng).connect(g);
    const m = noise(ctx, B.pink, t, r); srcs.push(m);
    const bp = filt(ctx, 'bandpass', 300, 1.3);
    bp.frequency.setValueAtTime(150 * r, t); bp.frequency.exponentialRampToValueAtTime(640 * r, t + dur * 0.55); bp.frequency.exponentialRampToValueAtTime(140 * r, t + dur);
    const mg = amp(ctx); shape(mg.gain, t, [[dur * 0.55, 1.3]], dur + 0.05);
    m.connect(bp).connect(mg).connect(g);
    const c = noise(ctx, B.crackle, t, 0.3); srcs.push(c);                  // shoulder creak
    const cb = filt(ctx, 'bandpass', 320 * r, 2.2); const cg = amp(ctx); perc(cg.gain, t, 0.05, 0.45, 1.4);
    c.connect(cb).connect(cg).connect(g);
    stopAll(srcs, t + dur + 0.2);
    return dur + IR_TAIL;
  },

  /** Stone fracturing (the grab locks, the titan staggers): a chain of cracks, a knock, a grinding groan, grit. */
  'titan-crack'(ctx, B, out, t, o = {}) {
    const r = o.rate ?? 1, dur = 1.4;
    const g = amp(ctx, 0.95); const ws = shaper(ctx, B.soft); g.connect(ws).connect(hall(ctx, B, out, 0.35));
    const srcs = [];
    const n = noise(ctx, B.white, t); srcs.push(n);
    const bp = filt(ctx, 'bandpass', 2600 * r, 0.9); const ng = amp(ctx); const p = ng.gain;
    p.setValueAtTime(EPS, t);
    [0, 0.05, 0.12, 0.2, 0.34].forEach((dt, i) => {
      const ti = t + dt;
      p.setValueAtTime(EPS, ti); p.linearRampToValueAtTime(1.5 * (1 - i * 0.16), ti + 0.003); p.exponentialRampToValueAtTime(0.004, ti + 0.042);
    });
    n.connect(bp).connect(ng).connect(g);
    const k = osc(ctx, 'sine', 80 * r, t); srcs.push(k); sweep(k.frequency, t, 80 * r, 34 * r, 0.35);
    const kg = amp(ctx); perc(kg.gain, t, 0.003, 0.45, 1.0); k.connect(kg).connect(g);
    const s = osc(ctx, 'sawtooth', 64 * r, t + 0.05); srcs.push(s); sweep(s.frequency, t + 0.05, 66 * r, 44 * r, 0.9);
    const slp = filt(ctx, 'lowpass', 320, 0.9); const am = amp(ctx, 0.5);
    const lfo = osc(ctx, 'sine', 17, t); srcs.push(lfo); const lg = amp(ctx, 0.5); lfo.connect(lg).connect(am.gain);
    const sg = amp(ctx); shape(sg.gain, t + 0.05, [[0.12, 0.55], [0.6, 0.35]], 1.1);
    s.connect(slp).connect(am).connect(sg).connect(g);
    const d = noise(ctx, B.crackle, t + 0.08, 0.6); srcs.push(d);
    const db = filt(ctx, 'bandpass', 1300, 0.9); const dg = amp(ctx); perc(dg.gain, t + 0.08, 0.06, 1.1, 1.2);
    d.connect(db).connect(dg).connect(g);
    stopAll(srcs, t + dur + 0.1);
    return dur + IR_TAIL;
  },

  /** Molten fire gathering in a palm before a volley: a roar that opens up, a hum climbing an octave, crackle. */
  'titan-charge'(ctx, B, out, t, o = {}) {
    const r = o.rate ?? 1, dur = o.duration ?? 1.9;
    const g = amp(ctx, 0.8); g.connect(hall(ctx, B, out, 0.3));
    const srcs = [];
    const n = noise(ctx, B.brown, t, r); srcs.push(n);
    const lp = filt(ctx, 'lowpass', 200, 0.8); sweep(lp.frequency, t, 180 * r, 2400 * r, dur);
    const ng = amp(ctx); shape(ng.gain, t, [[dur * 0.2, 0.3], [dur * 0.95, 1.5]], dur + 0.25);
    n.connect(lp).connect(ng).connect(g);
    for (const [m, det] of [[1, -7], [1, 6], [1.5, 0]]) {
      const v = osc(ctx, 'sawtooth', 55 * m * r, t); v.detune.value = det; srcs.push(v);
      sweep(v.frequency, t, 55 * m * r, 110 * m * r, dur);
      const vl = filt(ctx, 'lowpass', 300, 1.2); sweep(vl.frequency, t, 260, 2600, dur);
      const vg = amp(ctx); shape(vg.gain, t, [[dur * 0.4, 0.05], [dur * 0.95, 0.16]], dur + 0.2);
      v.connect(vl).connect(vg).connect(g);
    }
    const c = noise(ctx, B.crackle, t, 0.7 * r); srcs.push(c);
    c.playbackRate.setValueAtTime(0.7 * r, t); c.playbackRate.linearRampToValueAtTime(1.6 * r, t + dur);
    const hp = filt(ctx, 'highpass', 1400); const cg = amp(ctx); shape(cg.gain, t, [[dur * 0.3, 0.2], [dur * 0.95, 1.3]], dur + 0.2);
    c.connect(hp).connect(cg).connect(g);
    stopAll(srcs, t + dur + 0.3);
    return dur + IR_TAIL;
  },

  /** Air-burst clap of two 14 m hands: one broadband crack, a concussion, a ringing pressure wave, a slap echo. */
  'titan-clap'(ctx, B, out, t, o = {}) {
    const r = o.rate ?? 1, far = o.far ?? 0, dur = 2.2;
    const g = amp(ctx, 0.85); const ws = shaper(ctx, B.soft); const lpo = filt(ctx, 'lowpass', 14000 * (1 - far * 0.8) + 500);
    g.connect(ws).connect(lpo).connect(hall(ctx, B, slap(ctx, out, 0.34, 0.3, 700), 0.5));
    const srcs = [];
    const cr = noise(ctx, B.white, t); srcs.push(cr);
    const cb = filt(ctx, 'bandpass', 1300 * r, 0.55); const cg = amp(ctx); perc(cg.gain, t, 0.001, 0.08, 1.7);
    cr.connect(cb).connect(cg).connect(g);
    const s = osc(ctx, 'sine', 72 * r, t); srcs.push(s); sweep(s.frequency, t, 76 * r, 27 * r, 0.8);
    const sg = amp(ctx); perc(sg.gain, t, 0.004, 1.0, 1.1); s.connect(sg).connect(g);
    const b = noise(ctx, B.brown, t, r); srcs.push(b);
    const bl = filt(ctx, 'lowpass', 1800, 0.6); sweep(bl.frequency, t, 2000 * r, 110 * r, 1.3);
    const bg = amp(ctx); perc(bg.gain, t, 0.003, 1.5, 1.6); b.connect(bl).connect(bg).connect(g);
    const p = noise(ctx, B.pink, t, r); srcs.push(p);
    const pb = filt(ctx, 'bandpass', 520 * r, 4); sweep(pb.frequency, t, 600 * r, 380 * r, 1.4);
    const pg = amp(ctx); perc(pg.gain, t + 0.01, 0.02, 1.4, 1.4); p.connect(pb).connect(pg).connect(g);
    stopAll(srcs, t + dur);
    return dur + IR_TAIL + 1;
  },

  /** Hammer slam into the cloud deck: lower and longer than the clap — sub boom, vapour whumpf, debris, rumble. */
  'titan-slam'(ctx, B, out, t, o = {}) {
    const r = o.rate ?? 1, far = o.far ?? 0, dur = 3.4;
    const g = amp(ctx, 0.8); const ws = shaper(ctx, B.soft); const lpo = filt(ctx, 'lowpass', 9000 * (1 - far * 0.8) + 400);
    g.connect(ws).connect(lpo).connect(hall(ctx, B, slap(ctx, out, 0.42, 0.28, 500), 0.45));
    const srcs = [];
    const s = osc(ctx, 'sine', 50 * r, t); srcs.push(s); sweep(s.frequency, t, 52 * r, 21 * r, 1.6);
    const sg = amp(ctx); perc(sg.gain, t, 0.006, 2.0, 1.25); s.connect(sg).connect(g);
    const th = noise(ctx, B.pink, t, r); srcs.push(th);
    const tb = filt(ctx, 'bandpass', 210 * r, 0.8); const tg = amp(ctx); perc(tg.gain, t, 0.002, 0.35, 1.3);
    th.connect(tb).connect(tg).connect(g);
    const b = noise(ctx, B.brown, t, 0.8 * r); srcs.push(b);
    const bl = filt(ctx, 'lowpass', 900, 0.6); sweep(bl.frequency, t, 950 * r, 70 * r, 2.4);
    const bg = amp(ctx); perc(bg.gain, t, 0.005, 2.6, 1.9); b.connect(bl).connect(bg).connect(g);
    const v = noise(ctx, B.pink, t + 0.06, r); srcs.push(v);
    const vl = filt(ctx, 'lowpass', 2600, 0.5); sweep(vl.frequency, t + 0.06, 2800 * r, 380 * r, 1.8);
    const vg = amp(ctx); perc(vg.gain, t + 0.06, 0.12, 1.7, 0.7); v.connect(vl).connect(vg).connect(g);
    const d = noise(ctx, B.crackle, t + 0.12, 0.5 * r); srcs.push(d);
    const db = filt(ctx, 'bandpass', 900, 0.9); const dg = amp(ctx); perc(dg.gain, t + 0.12, 0.1, 1.9, 1.0);
    d.connect(db).connect(dg).connect(g);
    const rb = noise(ctx, B.brown, t, 0.6); srcs.push(rb);
    const rl = filt(ctx, 'lowpass', 110, 0.7); const rg = amp(ctx);
    shape(rg.gain, t, [[0.25, 0.9], [0.8, 0.45], [1.3, 0.7], [2.0, 0.35], [2.6, 0.4]], dur);
    rb.connect(rl).connect(rg).connect(g);
    stopAll(srcs, t + dur + 0.1);
    return dur + IR_TAIL + 1;
  },

  /** Wing gust: the downstroke's whomp, then a wall of wind with feathers fluttering in it. */
  'titan-gust'(ctx, B, out, t, o = {}) {
    const r = o.rate ?? 1, dur = o.duration ?? 2.8;
    const g = amp(ctx, 1); g.connect(hall(ctx, B, out, 0.25));
    const srcs = [];
    const s = osc(ctx, 'sine', 42 * r, t); srcs.push(s); sweep(s.frequency, t, 44 * r, 26 * r, 0.7);
    const sg = amp(ctx); perc(sg.gain, t, 0.05, 0.8, 0.8); s.connect(sg).connect(g);
    const n = noise(ctx, B.pink, t, r); srcs.push(n);
    const bp = filt(ctx, 'bandpass', 300, 0.7);
    bp.frequency.setValueAtTime(240 * r, t); bp.frequency.exponentialRampToValueAtTime(950 * r, t + 0.55); bp.frequency.exponentialRampToValueAtTime(280 * r, t + dur);
    const ng = amp(ctx); shape(ng.gain, t, [[0.5, 1.5], [1.2, 1.0]], dur);
    n.connect(bp).connect(ng).connect(g);
    const lo = noise(ctx, B.brown, t, r); srcs.push(lo);
    const ll = filt(ctx, 'lowpass', 170, 0.7); const lg = amp(ctx); shape(lg.gain, t, [[0.45, 1.2], [1.4, 0.6]], dur);
    lo.connect(ll).connect(lg).connect(g);
    const f = noise(ctx, B.white, t, 1); srcs.push(f);
    const fb = filt(ctx, 'bandpass', 1700 * r, 1.4); const fam = amp(ctx, 0.5);
    const lfo = osc(ctx, 'triangle', 13, t); srcs.push(lfo); const lfg = amp(ctx, 0.5); lfo.connect(lfg).connect(fam.gain);
    const fg = amp(ctx); shape(fg.gain, t, [[0.4, 0.5], [1.3, 0.25]], dur - 0.2);
    f.connect(fb).connect(fam).connect(fg).connect(g);
    stopAll(srcs, t + dur + 0.1);
    return dur + IR_TAIL;
  },

  /** The colossus falls into the cloud sea: a last groan, the impact, a cloud surge, seconds of crumbling stone. */
  'titan-fall'(ctx, B, out, t, o = {}) {
    const r = o.rate ?? 1, dur = 7;
    const g = amp(ctx, 0.62); const ws = shaper(ctx, B.soft); g.connect(ws).connect(hall(ctx, B, slap(ctx, out, 0.5, 0.35, 420), 0.5));
    const srcs = [];
    const m = osc(ctx, 'sawtooth', 44 * r, t); srcs.push(m); sweep(m.frequency, t, 46 * r, 27 * r, 2.8);
    const ml = filt(ctx, 'lowpass', 240, 0.8); const mf = filt(ctx, 'bandpass', 300, 3); const mg = amp(ctx);
    shape(mg.gain, t, [[0.3, 0.35], [1.8, 0.25]], 3.0);
    m.connect(ml).connect(mg).connect(g); ml.connect(mf).connect(mg);
    const T0 = t + 0.25;
    const cr = noise(ctx, B.white, T0); srcs.push(cr);
    const ch = filt(ctx, 'highpass', 1500); const cg = amp(ctx); perc(cg.gain, T0, 0.001, 0.16, 0.9); cr.connect(ch).connect(cg).connect(g);
    const s = osc(ctx, 'sine', 42 * r, T0); srcs.push(s); sweep(s.frequency, T0, 44 * r, 17 * r, 3);
    const sg = amp(ctx); perc(sg.gain, T0, 0.01, 3.4, 1.3); s.connect(sg).connect(g);
    const b = noise(ctx, B.brown, T0, 0.7 * r); srcs.push(b);
    const bl = filt(ctx, 'lowpass', 1400, 0.6); sweep(bl.frequency, T0, 1500 * r, 60 * r, 4.2);
    const bg = amp(ctx); perc(bg.gain, T0, 0.01, 4.5, 1.9); b.connect(bl).connect(bg).connect(g);
    const v = noise(ctx, B.pink, T0, r); srcs.push(v);
    const vl = filt(ctx, 'lowpass', 400, 0.5);
    vl.frequency.setValueAtTime(400, T0); vl.frequency.exponentialRampToValueAtTime(2600, T0 + 0.8); vl.frequency.exponentialRampToValueAtTime(260, T0 + 5);
    const vg = amp(ctx); shape(vg.gain, T0, [[0.8, 0.9], [2.5, 0.5]], 5.5);
    v.connect(vl).connect(vg).connect(g);
    const d = noise(ctx, B.crackle, T0 + 0.1, 0.4 * r); srcs.push(d);
    const db = filt(ctx, 'bandpass', 700, 1); const dg = amp(ctx); shape(dg.gain, T0 + 0.1, [[0.3, 1.3], [2.5, 0.8], [4, 0.4]], 5.5);
    d.connect(db).connect(dg).connect(g);
    const rb = noise(ctx, B.brown, T0, 0.5); srcs.push(rb);
    const rl = filt(ctx, 'lowpass', 140, 0.7); const rg = amp(ctx);
    shape(rg.gain, T0, [[0.4, 1.0], [1.1, 0.5], [1.8, 0.9], [2.7, 0.45], [3.5, 0.7], [4.6, 0.3], [5.4, 0.35]], dur - 0.3);
    rb.connect(rl).connect(rg).connect(g);
    stopAll(srcs, t + dur + 0.1);
    return dur + IR_TAIL + 1.5;
  },

  /** A titan hand connects (titan:impact on a hit): stone thump + crunch + grit. o.strength 0.5..1.5 */
  'titan-impact'(ctx, B, out, t, o = {}) {
    const r = o.rate ?? 1, s = Math.min(1.5, Math.max(0.4, o.strength ?? 1)), dur = 1.3;
    const g = amp(ctx, 1); const ws = shaper(ctx, B.soft); g.connect(ws).connect(hall(ctx, B, out, 0.3));
    const srcs = [];
    const k = osc(ctx, 'sine', 95 * r, t); srcs.push(k); sweep(k.frequency, t, 100 * r, 38 * r, 0.45);
    const kg = amp(ctx); perc(kg.gain, t, 0.003, 0.55, 1.1 * s); k.connect(kg).connect(g);
    const c = noise(ctx, B.white, t); srcs.push(c);
    const cb = filt(ctx, 'bandpass', 1500 * r, 0.8); const cg = amp(ctx); perc(cg.gain, t, 0.001, 0.11, 1.0 * s); c.connect(cb).connect(cg).connect(g);
    const b = noise(ctx, B.brown, t, r); srcs.push(b);
    const bl = filt(ctx, 'lowpass', 1300, 0.6); sweep(bl.frequency, t, 1300 * r, 140 * r, 0.9);
    const bg = amp(ctx); perc(bg.gain, t, 0.003, 0.9, 1.4 * s); b.connect(bl).connect(bg).connect(g);
    const d = noise(ctx, B.crackle, t + 0.03, 0.7); srcs.push(d);
    const db = filt(ctx, 'bandpass', 1800, 0.9); const dg = amp(ctx); perc(dg.gain, t + 0.03, 0.02, 0.7, 0.8 * s); d.connect(db).connect(dg).connect(g);
    stopAll(srcs, t + dur);
    return dur + IR_TAIL;
  },
});

// ---------- loops ----------
export const LOOPS = {
  /** Flight wind. set({ speed m/s, dive 0..1, altitude m, cloud 0..1 }) */
  wind(ctx, B, out) {
    const t = ctx.currentTime;
    const g = amp(ctx, 1); g.connect(out);
    const body = noise(ctx, B.pink, t, 1); const bodyLp = filt(ctx, 'lowpass', 900, 0.6); const bodyG = amp(ctx, 0);
    body.connect(bodyLp).connect(bodyG).connect(g);
    // stereo rush: two decorrelated noise sources panned apart
    const rushG = amp(ctx, 0);
    const mkSide = (pan) => {
      const n = noise(ctx, B.white, t, 1); const bp = filt(ctx, 'bandpass', 1400, 0.7);
      const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (p) { p.pan.value = pan; n.connect(bp).connect(p).connect(rushG); } else n.connect(bp).connect(rushG);
      return { n, bp };
    };
    const L = mkSide(-0.7), R = mkSide(0.7);
    rushG.connect(g);
    const low = noise(ctx, B.brown, t, 1); const lowLp = filt(ctx, 'lowpass', 130, 0.7); const lowG = amp(ctx, 0);
    const buff = osc(ctx, 'sine', 0.37, t); const buff2 = osc(ctx, 'sine', 1.9, t);
    const buffG = amp(ctx, 0); buff.connect(buffG); buff2.connect(buffG); buffG.connect(lowG.gain);
    low.connect(lowLp).connect(lowG).connect(g);
    const wh = noise(ctx, B.white, t, 1); const whBp = filt(ctx, 'bandpass', 1900, 14); const whG = amp(ctx, 0);
    wh.connect(whBp).connect(whG).connect(g);
    const srcs = [body, L.n, R.n, low, buff, buff2, wh];
    const tc = 0.18;
    return {
      set(p = {}) {
        const now = ctx.currentTime;
        const v = Math.max(0, p.speed ?? 30), s = Math.min(1.3, v / 90), dive = Math.min(1, Math.max(0, p.dive ?? 0));
        const alt = p.altitude ?? 1000, cloud = Math.min(1, Math.max(0, p.cloud ?? 0));
        const thin = Math.min(1, Math.max(0, (alt - 1500) / 2000));
        const muff = 1 - 0.55 * cloud;
        bodyG.gain.setTargetAtTime((0.06 + 0.55 * s * s) * (1 - 0.2 * thin), now, tc);
        bodyLp.frequency.setTargetAtTime((500 + 5500 * Math.min(1, s * s)) * muff, now, tc);
        rushG.gain.setTargetAtTime(0.015 + 0.1 * s * s + 0.28 * dive * s, now, tc);
        const f = (1100 + 2000 * dive + 700 * s) * muff;
        L.bp.frequency.setTargetAtTime(f * 0.93, now, tc); R.bp.frequency.setTargetAtTime(f * 1.07, now, tc);
        lowG.gain.setTargetAtTime(0.1 + 0.5 * s * (1 - thin * 0.5), now, tc);
        buffG.gain.setTargetAtTime(0.1 + 0.25 * s, now, tc);
        whG.gain.setTargetAtTime((0.02 + 0.1 * thin) * s * s + 0.12 * dive * s, now, 0.4);
        whBp.frequency.setTargetAtTime(1500 + 16 * v, now, 0.4);
        if (p.volume !== undefined) g.gain.setTargetAtTime(p.volume, now, 0.1);
      },
      stop(when = ctx.currentTime) { g.gain.setTargetAtTime(0, when, 0.2); stopAll(srcs, when + 1.2); },
    };
  },

  /** Fire breath roar + crackle. set({ intensity 0..1 }) */
  breath(ctx, B, out, o = {}) {
    const t = ctx.currentTime, r = o.rate ?? 1;
    const g = amp(ctx, 0); g.connect(out);
    const roar = noise(ctx, B.brown, t, r); const lp = filt(ctx, 'lowpass', 1000, 0.6); const roarG = amp(ctx, 0.7);
    roar.connect(lp).connect(roarG).connect(g);
    const hiss = noise(ctx, B.pink, t, r); const bp = filt(ctx, 'bandpass', 1700, 0.6); const hissG = amp(ctx, 0.5);
    hiss.connect(bp).connect(hissG).connect(g);
    const crk = noise(ctx, B.crackle, t, r); const hp = filt(ctx, 'highpass', 1300); const crkG = amp(ctx, 0.8);
    crk.connect(hp).connect(crkG).connect(g);
    const low = osc(ctx, 'sawtooth', 57 * r, t); const lowLp = filt(ctx, 'lowpass', 170); const lowG = amp(ctx, 0.22);
    low.connect(lowLp).connect(lowG).connect(g);
    const lfo = osc(ctx, 'sine', 9.5, t); const lfoG = amp(ctx, 0.22); lfo.connect(lfoG).connect(roarG.gain);
    const srcs = [roar, hiss, crk, low, lfo];
    // ignition "whoomph"
    const ig = noise(ctx, B.brown, t, r); const igBp = filt(ctx, 'bandpass', 250, 0.9);
    sweep(igBp.frequency, t, 180, 1100, 0.22); const igG = amp(ctx); perc(igG.gain, t, 0.03, 0.35, 2.2);
    ig.connect(igBp).connect(igG).connect(out); ig.stop(t + 0.5);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.9, t + 0.12);
    let stopped = false;
    return {
      set(p = {}) {
        const now = ctx.currentTime, i = Math.min(1, Math.max(0, p.intensity ?? 1));
        lp.frequency.setTargetAtTime(650 + 900 * i, now, 0.1);
        if (p.volume !== undefined && !stopped) g.gain.setTargetAtTime(0.9 * p.volume, now, 0.08);
      },
      stop(when = ctx.currentTime) {
        if (stopped) return; stopped = true;
        g.gain.cancelScheduledValues(when); g.gain.setTargetAtTime(0, when, 0.09);
        stopAll(srcs, when + 0.6);
      },
    };
  },

  /** Titan presence: sub drone that breathes with its wings. set({ intensity 0..1 }) */
  titanDrone(ctx, B, out) {
    const t = ctx.currentTime;
    const g = amp(ctx, 0); g.connect(out);
    const a = osc(ctx, 'sawtooth', 31, t); const b = osc(ctx, 'sawtooth', 32.9, t); const c = osc(ctx, 'sine', 46.5, t);
    const lp = filt(ctx, 'lowpass', 150, 0.9); const sub = amp(ctx, 0.5);
    a.connect(lp); b.connect(lp); lp.connect(sub).connect(g);
    const cg = amp(ctx, 0.4); c.connect(cg).connect(g);
    const n = noise(ctx, B.brown, t, 0.6); const nlp = filt(ctx, 'lowpass', 95); const ng = amp(ctx, 0.9);
    n.connect(nlp).connect(ng).connect(g);
    const lfo = osc(ctx, 'sine', 0.28, t); const lfoG = amp(ctx, 0.25); lfo.connect(lfoG).connect(sub.gain); lfoG.connect(cg.gain);
    const srcs = [a, b, c, n, lfo];
    g.gain.setTargetAtTime(0.6, t, 1.2);
    return {
      set(p = {}) {
        const now = ctx.currentTime, i = Math.min(1.5, Math.max(0, p.intensity ?? 1));
        lp.frequency.setTargetAtTime(110 + 110 * i, now, 0.5);
        if (p.volume !== undefined) g.gain.setTargetAtTime(0.6 * p.volume, now, 0.4);
      },
      stop(when = ctx.currentTime) { g.gain.setTargetAtTime(0, when, 0.8); stopAll(srcs, when + 4); },
    };
  },

  /** Air rush of a huge moving hand (titan swat). set({ doppler, speed m/s }) — driven per frame by audio.js. */
  rush(ctx, B, out) {
    const t = ctx.currentTime;
    const g = amp(ctx, 0); g.connect(out);
    const n = noise(ctx, B.pink, t); const bp = filt(ctx, 'bandpass', 420, 1.0); const ng = amp(ctx, 0.9);
    n.connect(bp).connect(ng).connect(g);
    const low = noise(ctx, B.brown, t); const lp = filt(ctx, 'lowpass', 200); const lg = amp(ctx, 0.75);
    low.connect(lp).connect(lg).connect(g);
    const srcs = [n, low];
    return {
      set(p = {}) {
        const now = ctx.currentTime, d = Math.min(2, Math.max(0.5, p.doppler ?? 1)), v = Math.max(0, p.speed ?? 60);
        const k = Math.min(1.4, v / 90);
        n.playbackRate.setTargetAtTime(d, now, 0.03); low.playbackRate.setTargetAtTime(d, now, 0.03);
        bp.frequency.setTargetAtTime((260 + 520 * k) * d, now, 0.03);
        lp.frequency.setTargetAtTime(150 * d + 60 * k, now, 0.03);
        g.gain.setTargetAtTime(k * k * (p.volume ?? 1), now, 0.05);
      },
      stop(when = ctx.currentTime) { g.gain.setTargetAtTime(0, when, 0.15); stopAll(srcs, when + 1); },
    };
  },
};
