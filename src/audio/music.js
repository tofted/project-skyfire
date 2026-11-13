// Procedural score in an anime-adventure style: string pad, harp arpeggios, a horn theme, string ostinato,
// taiko, and (for the titan) choir and low brass. Everything is scheduled bar by bar with sample-accurate times,
// so it renders identically in an OfflineAudioContext (tools/ui/audio_levels.mjs).
//   const m = new Music(ctx, out, bank); m.setMode('explore' | 'combat' | 'boss' | 'victory' | 'defeat' | 'title');
//   m.setIntensity(0..1); m.tick(ctx.currentTime + 0.4)   // call often; schedules whole bars ahead
// Mode changes land on the next bar line; intensity crossfades the layers immediately (~1.5 s).
import { midiHz } from './synth.js';

const EPS = 0.0001;

// Chord voicings (MIDI), bass roots, and melodies as [bar, beat, midi, beats].
const THEME = [   // the Skyfire theme, D major, over the "royal road" progression IV–V–iii–vi–IV–V–I
  [0, 0, 69, 1], [0, 1, 74, 1], [0, 2, 76, 1], [0, 3, 78, 1],
  [1, 0, 76, 2], [1, 2, 74, 0.5], [1, 2.5, 73, 0.5], [1, 3, 69, 1],
  [2, 0, 73, 1.5], [2, 1.5, 74, 0.5], [2, 2, 76, 1], [2, 3, 78, 1],
  [3, 0, 78, 3],
  [4, 0, 79, 1.5], [4, 1.5, 78, 0.5], [4, 2, 76, 1], [4, 3, 74, 1],
  [5, 0, 76, 1.5], [5, 1.5, 78, 0.5], [5, 2, 81, 2],
  [6, 0, 78, 2], [6, 2, 76, 1], [6, 3, 74, 1],
  [7, 0, 74, 4],
];
const ROYAL = [
  { c: [55, 59, 62, 66], b: 43 }, { c: [57, 61, 64, 67], b: 45 }, { c: [54, 57, 61, 64], b: 42 }, { c: [59, 62, 66, 69], b: 47 },
  { c: [55, 59, 62, 66], b: 43 }, { c: [57, 61, 64, 69], b: 45 }, { c: [54, 57, 62, 64], b: 38 }, { c: [57, 62, 66, 69], b: 38 },
];
const COMBAT_CH = [
  { c: [59, 62, 66], b: 35 }, { c: [55, 59, 62], b: 43 }, { c: [57, 61, 64], b: 45 }, { c: [54, 58, 61], b: 42 },
  { c: [59, 62, 66], b: 35 }, { c: [55, 59, 62], b: 43 }, { c: [57, 62, 66], b: 38 }, { c: [57, 61, 64], b: 45 },
];
const COMBAT_MOTIF = [
  [0, 0, 71, 1], [0, 1, 66, 0.5], [0, 1.5, 71, 0.5], [0, 2, 73, 1], [0, 3, 74, 1],
  [1, 0, 76, 2], [1, 2, 74, 1], [1, 3, 73, 1],
  [2, 0, 73, 1.5], [2, 1.5, 74, 0.5], [2, 2, 76, 1], [2, 3, 73, 1],
  [3, 0, 70, 3], [3, 3, 73, 1],
  [4, 0, 74, 1], [4, 1, 73, 0.5], [4, 1.5, 71, 0.5], [4, 2, 71, 2],
  [5, 0, 74, 1], [5, 1, 76, 1], [5, 2, 78, 2],
  [6, 0, 78, 1.5], [6, 1.5, 76, 0.5], [6, 2, 74, 1], [6, 3, 73, 1],
  [7, 0, 73, 4],
];
const BOSS_CH = [
  { c: [62, 65, 69], b: 38 }, { c: [58, 62, 65], b: 46 }, { c: [60, 64, 67], b: 48 }, { c: [57, 61, 64, 67], b: 45 },
  { c: [62, 65, 69], b: 38 }, { c: [58, 62, 65], b: 46 }, { c: [55, 58, 62], b: 43 }, { c: [57, 61, 64], b: 45 },
];
const BOSS_MOTIF = [
  [0, 0, 62, 1.5], [0, 1.5, 62, 0.5], [0, 2, 69, 2],
  [1, 0, 70, 1], [1, 1, 69, 1], [1, 2, 65, 2],
  [2, 0, 67, 1.5], [2, 1.5, 69, 0.5], [2, 2, 72, 1], [2, 3, 70, 1],
  [3, 0, 69, 3], [3, 3, 61, 1],
  [4, 0, 62, 1.5], [4, 1.5, 62, 0.5], [4, 2, 74, 2],
  [5, 0, 72, 1], [5, 1, 70, 1], [5, 2, 69, 2],
  [6, 0, 67, 1], [6, 1, 70, 1], [6, 2, 69, 1], [6, 3, 67, 1],
  [7, 0, 69, 4],
];
const FANFARE_CH = [{ c: [62, 66, 69, 74], b: 38 }, { c: [62, 67, 71, 74], b: 38 }, { c: [61, 64, 69, 73], b: 45 }, { c: [62, 66, 69, 74], b: 38 }];
const FANFARE = [
  [0, 0, 69, 0.5], [0, 0.5, 74, 0.5], [0, 1, 78, 1], [0, 2, 81, 2],
  [1, 0, 79, 1], [1, 1, 78, 0.5], [1, 1.5, 76, 0.5], [1, 2, 74, 2],
  [2, 0, 76, 1], [2, 1, 78, 1], [2, 2, 79, 1], [2, 3, 76, 1],
  [3, 0, 74, 4],
];
const DEFEAT_CH = [{ c: [59, 62, 66], b: 47 }, { c: [55, 59, 62], b: 43 }, { c: [52, 55, 59], b: 40 }, { c: [54, 58, 61], b: 42 }];
const DEFEAT_MEL = [[0, 0, 66, 2], [0, 2, 64, 1], [0, 3, 62, 1], [1, 0, 62, 2], [1, 2, 59, 2], [2, 0, 64, 3], [3, 0, 61, 4]];

const SONGS = {
  title:   { bpm: 84,  prog: ROYAL, mel: THEME, melOffset: -12, melEvery: 2, melFrom: 0 },
  explore: { bpm: 92,  prog: ROYAL, mel: THEME, melOffset: -12, melEvery: 2, melFrom: 1 },
  combat:  { bpm: 132, prog: COMBAT_CH, mel: COMBAT_MOTIF, melOffset: -12, melEvery: 1, melFrom: 0 },
  boss:    { bpm: 140, prog: BOSS_CH, mel: BOSS_MOTIF, melOffset: 0, melEvery: 1, melFrom: 1 },
  victory: { bpm: 96,  prog: FANFARE_CH, mel: FANFARE, melOffset: -12, melEvery: 1, melFrom: 0, then: 'explore' },
  defeat:  { bpm: 66,  prog: DEFEAT_CH, mel: DEFEAT_MEL, melOffset: -12, melEvery: 1, melFrom: 0 },
};

// Layer mix per mode (intensity i adds on top where noted).
function layerTargets(mode, i) {
  switch (mode) {
    case 'title':   return { pad: 0.9, harp: 0.85, bell: 0.5, horn: 0.75, bass: 0.45, strings: 0, taiko: 0, choir: 0, brass: 0 };
    case 'explore': return { pad: 0.8, harp: 0.7, bell: 0.3, horn: 0.6, bass: 0.5, strings: 0.1 + 0.4 * i, taiko: 0.25 * i, choir: 0, brass: 0 };
    case 'combat':  return { pad: 0.55, harp: 0.12, bell: 0, horn: 0.85, bass: 0.8, strings: 0.7 + 0.3 * i, taiko: 0.5 + 0.5 * i, choir: 0, brass: 0.25 * i };
    case 'boss':    return { pad: 0.45, harp: 0, bell: 0, horn: 0.75, bass: 1, strings: 0.85 + 0.15 * i, taiko: 1, choir: 0.7 + 0.3 * i, brass: 0.85 };
    case 'victory': return { pad: 0.8, harp: 0.6, bell: 0.7, horn: 1, bass: 0.6, strings: 0.35, taiko: 0.6, choir: 0, brass: 0.3 };
    case 'defeat':  return { pad: 0.85, harp: 0.35, bell: 0, horn: 0.55, bass: 0.5, strings: 0, taiko: 0, choir: 0.3, brass: 0 };
    default:        return { pad: 0, harp: 0, bell: 0, horn: 0, bass: 0, strings: 0, taiko: 0, choir: 0, brass: 0 };
  }
}
const SENDS = { pad: 0.55, harp: 0.6, bell: 0.8, horn: 0.45, bass: 0.1, strings: 0.35, taiko: 0.3, choir: 0.7, brass: 0.35 };
const TRIMS = { pad: 0.1, harp: 0.15, bell: 0.08, horn: 0.15, bass: 0.2, strings: 0.07, taiko: 0.3, choir: 0.06, brass: 0.07 };

export class Music {
  constructor(ctx, out, bank) {
    this.ctx = ctx; this.B = bank;
    this.bus = ctx.createGain(); this.bus.connect(out);
    this.rev = ctx.createConvolver(); this.rev.buffer = bank.ir;
    this.revG = ctx.createGain(); this.revG.gain.value = 0.55;
    this.rev.connect(this.revG).connect(this.bus);
    this.layers = {};
    for (const k of Object.keys(SENDS)) {
      const g = ctx.createGain(); g.gain.value = 0;
      const trim = ctx.createGain(); trim.gain.value = TRIMS[k];
      const send = ctx.createGain(); send.gain.value = SENDS[k];
      trim.connect(g); g.connect(this.bus); g.connect(send).connect(this.rev);
      this.layers[k] = { g, input: trim };
    }
    this.mode = 'silent'; this.nextMode = 'title'; this.intensity = 0.2;
    this.bar = 0; this.loop = 0; this.next = ctx.currentTime + 0.08;
    this.song = SONGS.title;
  }

  setMode(mode) { if (SONGS[mode] || mode === 'silent') this.nextMode = mode; }
  setIntensity(v) { this.intensity = Math.min(1, Math.max(0, v)); this._mix(); }

  _mix(at = this.ctx.currentTime, tc = 0.6) {
    const tgt = layerTargets(this.mode, this.intensity);
    for (const [k, L] of Object.entries(this.layers)) L.g.gain.setTargetAtTime(tgt[k] ?? 0, at, tc);
  }

  /** Schedule every bar that starts before `until` (seconds, ctx time). */
  tick(until) {
    const now = this.ctx.currentTime;
    if (this.next < now) this.next = now + 0.05;              // fell behind (tab throttled): rejoin
    let guard = 0;
    while (this.next < until && guard++ < 16) {
      if (this.nextMode !== this.mode) {
        this.mode = this.nextMode; this.bar = 0; this.loop = 0;
        this.song = SONGS[this.mode] || null;
        this._mix(this.next, 0.35);
      }
      if (!this.song) { this.next += 1; continue; }
      const beat = 60 / this.song.bpm;
      this._bar(this.next, beat);
      this.next += beat * 4;
      this.bar++;
      if (this.bar >= this.song.prog.length) {
        this.bar = 0; this.loop++;
        if (this.song.then) this.nextMode = this.song.then;
      }
    }
  }

  _bar(t0, beat) {
    const { mode, song, bar, loop } = this;
    const ch = song.prog[bar % song.prog.length];
    const barDur = beat * 4;
    const L = this.layers;
    const I = this.intensity;
    // pad (strings / choir-like) — every mode
    this._pad(L.pad.input, t0, barDur, ch.c, mode === 'boss' ? 1500 : mode === 'combat' ? 2100 : 1250);
    if (mode === 'boss' || mode === 'defeat') this._choir(L.choir.input, t0, barDur, ch.c);
    // bass
    if (mode === 'combat' || mode === 'boss') {
      for (let s = 0; s < 8; s++) {
        const oct = mode === 'boss' && (s === 3 || s === 7) ? 12 : 0;
        this._bass(L.bass.input, t0 + s * beat * 0.5, beat * 0.42, ch.b + oct, 'square');
      }
    } else this._bass(L.bass.input, t0, barDur * 0.98, ch.b, 'sine');
    // harp arpeggio (calm modes) and bell sparkles
    if (mode === 'title' || mode === 'explore' || mode === 'victory' || mode === 'defeat') {
      const c = ch.c, up = [c[0], c[1], c[2], c[3] ?? c[0] + 12, c[0] + 12, c[3] ?? c[1] + 12, c[2], c[1]];
      const n = mode === 'defeat' ? 4 : 8;
      for (let i = 0; i < n; i++) this._pluck(L.harp.input, t0 + i * beat * (8 / n) * 0.5, up[i] + 12, 1.6);
      if (mode !== 'defeat' && (bar % 2 === 1)) {
        this._bell(L.bell.input, t0 + beat * 2.5, c[2] + 24);
        this._bell(L.bell.input, t0 + beat * 3, c[1] + 24);
      }
    }
    // string ostinato (16ths), combat/boss, lighter in explore when intensity rises
    if (mode === 'combat' || mode === 'boss' || (mode === 'explore' && I > 0.3) || mode === 'victory') {
      const c = ch.c, pat = [c[0] + 12, c[2], c[1] + 12, c[2]];
      const steps = mode === 'explore' || mode === 'victory' ? 8 : 16;
      for (let s = 0; s < steps; s++) this._stacc(L.strings.input, t0 + s * barDur / steps, pat[s % 4], mode === 'boss' ? 2900 : 2300);
    }
    // taiko
    if (mode === 'combat' || mode === 'boss' || mode === 'victory' || (mode === 'explore' && I > 0.35)) {
      let don = [0, 8], ka = [4, 12];
      if (mode === 'combat' && I > 0.6) { don = [0, 3, 6, 8, 11, 14]; ka = [4, 12, 15]; }
      else if (mode === 'combat') { don = [0, 6, 8]; ka = [4, 12]; }
      if (mode === 'boss') { don = [0, 2, 3, 6, 8, 10, 11, 14]; ka = [4, 12, 15]; }
      if (mode === 'victory') { don = bar === 0 ? [0, 2, 3] : [0]; ka = []; }
      const st = beat / 4;
      for (const s of don) this._taiko(L.taiko.input, t0 + s * st, s === 0 ? 1 : 0.7, false);
      for (const s of ka) this._taiko(L.taiko.input, t0 + s * st, 0.5, true);
      if (mode === 'boss' && bar % 4 === 0) this._taiko(L.taiko.input, t0, 1.6, false, 0.62);   // odaiko
    }
    // low brass stabs (boss, combat at high intensity)
    if (mode === 'boss' || (mode === 'combat' && I > 0.7) || mode === 'victory') {
      const hits = mode === 'victory' ? [0] : [0, 2.5];
      for (const b of hits) this._brass(L.brass.input, t0 + b * beat, ch.c.map((m) => m - 12), beat * 0.7);
    }
    // horn melody
    const melOn = loop >= song.melFrom && (loop - song.melFrom) % song.melEvery === 0;
    if (melOn && song.mel) {
      for (const [b, at, m, len] of song.mel) {
        if (b !== bar) continue;
        this._horn(L.horn.input, t0 + at * beat, len * beat, m + song.melOffset);
      }
    }
  }

  // ---------- instruments ----------
  _pad(out, t, dur, notes, cutoff) {
    const ctx = this.ctx;
    const g = ctx.createGain(); const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = cutoff; lp.Q.value = 0.5;
    lp.connect(g).connect(out);
    const p = g.gain; p.setValueAtTime(EPS, t); p.linearRampToValueAtTime(1, t + 0.7); p.setValueAtTime(1, t + dur); p.linearRampToValueAtTime(EPS, t + dur + 1.1);
    for (const m of notes) for (const d of [-9, 8]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = midiHz(m); o.detune.value = d;
      o.connect(lp); o.start(t); o.stop(t + dur + 1.2);
    }
  }
  _choir(out, t, dur, notes) {
    const ctx = this.ctx;
    const g = ctx.createGain(); const f1 = ctx.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.value = 720; f1.Q.value = 4;
    const f2 = ctx.createBiquadFilter(); f2.type = 'bandpass'; f2.frequency.value = 1180; f2.Q.value = 5;
    const g2 = ctx.createGain(); g2.gain.value = 0.6;
    f1.connect(g); f2.connect(g2).connect(g); g.connect(out);
    const p = g.gain; p.setValueAtTime(EPS, t); p.linearRampToValueAtTime(2.2, t + 0.5); p.setValueAtTime(2.2, t + dur); p.linearRampToValueAtTime(EPS, t + dur + 0.9);
    for (const m of notes) for (const d of [-12, 0, 11]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = midiHz(m); o.detune.value = d;
      o.connect(f1); o.connect(f2); o.start(t); o.stop(t + dur + 1);
    }
  }
  _bass(out, t, dur, m, type) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = midiHz(m);
    const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = midiHz(m - 12);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = type === 'square' ? 520 : 400;
    const g = ctx.createGain(); const p = g.gain;
    p.setValueAtTime(EPS, t); p.linearRampToValueAtTime(1, t + (type === 'square' ? 0.008 : 0.25));
    p.setValueAtTime(1, t + dur * 0.7); p.exponentialRampToValueAtTime(EPS, t + dur + 0.1);
    o.connect(lp); o2.connect(lp); lp.connect(g).connect(out);
    o.start(t); o2.start(t); o.stop(t + dur + 0.15); o2.stop(t + dur + 0.15);
  }
  _pluck(out, t, m, decay) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = midiHz(m);
    const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = midiHz(m) * 2;
    const g = ctx.createGain(); const g2 = ctx.createGain();
    g.gain.setValueAtTime(EPS, t); g.gain.linearRampToValueAtTime(1, t + 0.004); g.gain.exponentialRampToValueAtTime(EPS, t + decay);
    g2.gain.setValueAtTime(EPS, t); g2.gain.linearRampToValueAtTime(0.35, t + 0.003); g2.gain.exponentialRampToValueAtTime(EPS, t + decay * 0.35);
    o.connect(g).connect(out); o2.connect(g2).connect(out);
    o.start(t); o2.start(t); o.stop(t + decay + 0.05); o2.stop(t + decay + 0.05);
  }
  _bell(out, t, m) {
    const ctx = this.ctx;
    for (const [ratio, a, d] of [[1, 1, 1.8], [2.76, 0.4, 0.6], [5.4, 0.2, 0.3]]) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = midiHz(m) * ratio;
      const g = ctx.createGain(); g.gain.setValueAtTime(EPS, t); g.gain.linearRampToValueAtTime(a, t + 0.003); g.gain.exponentialRampToValueAtTime(EPS, t + d);
      o.connect(g).connect(out); o.start(t); o.stop(t + d + 0.05);
    }
  }
  _stacc(out, t, m, cutoff) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = midiHz(m);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = cutoff; lp.Q.value = 0.8;
    const g = ctx.createGain(); g.gain.setValueAtTime(EPS, t); g.gain.linearRampToValueAtTime(1, t + 0.006); g.gain.exponentialRampToValueAtTime(EPS, t + 0.13);
    o.connect(lp).connect(g).connect(out); o.start(t); o.stop(t + 0.16);
  }
  _taiko(out, t, a, rim, pitch = 1) {
    const ctx = this.ctx, B = this.B;
    if (rim) {   // "ka": the rim, a dry woody click
      const n = ctx.createBufferSource(); n.buffer = B.white;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2100; bp.Q.value = 3;
      const g = ctx.createGain(); g.gain.setValueAtTime(EPS, t); g.gain.linearRampToValueAtTime(a * 0.9, t + 0.001); g.gain.exponentialRampToValueAtTime(EPS, t + 0.06);
      n.connect(bp).connect(g).connect(out); n.start(t, Math.random()); n.stop(t + 0.08);
      return;
    }
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(120 * pitch, t); o.frequency.exponentialRampToValueAtTime(52 * pitch, t + 0.16);
    const g = ctx.createGain(); g.gain.setValueAtTime(EPS, t); g.gain.linearRampToValueAtTime(a, t + 0.003); g.gain.exponentialRampToValueAtTime(EPS, t + 0.55 / pitch);
    o.connect(g).connect(out); o.start(t); o.stop(t + 0.6 / pitch + 0.05);
    const n = ctx.createBufferSource(); n.buffer = B.brown;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 600;
    const gn = ctx.createGain(); gn.gain.setValueAtTime(EPS, t); gn.gain.linearRampToValueAtTime(a * 1.4, t + 0.002); gn.gain.exponentialRampToValueAtTime(EPS, t + 0.14);
    n.connect(lp).connect(gn).connect(out); n.start(t, Math.random()); n.stop(t + 0.2);
  }
  _brass(out, t, notes, dur) {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1.2;
    lp.frequency.setValueAtTime(300, t); lp.frequency.exponentialRampToValueAtTime(2600, t + 0.05); lp.frequency.exponentialRampToValueAtTime(700, t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(EPS, t); g.gain.linearRampToValueAtTime(1, t + 0.02); g.gain.setValueAtTime(1, t + dur * 0.6); g.gain.exponentialRampToValueAtTime(EPS, t + dur + 0.15);
    lp.connect(g).connect(out);
    for (const m of notes) for (const d of [-6, 6]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = midiHz(m); o.detune.value = d;
      o.connect(lp); o.start(t); o.stop(t + dur + 0.2);
    }
  }
  _horn(out, t, dur, m) {
    const ctx = this.ctx;
    const f = midiHz(m);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.9;
    lp.frequency.setValueAtTime(450, t); lp.frequency.linearRampToValueAtTime(2100, t + 0.09); lp.frequency.setTargetAtTime(1350, t + 0.09, 0.25);
    const g = ctx.createGain(); const p = g.gain;
    p.setValueAtTime(EPS, t); p.linearRampToValueAtTime(1, t + 0.06); p.setValueAtTime(0.9, t + Math.max(0.07, dur - 0.08)); p.linearRampToValueAtTime(EPS, t + dur + 0.14);
    lp.connect(g).connect(out);
    const vib = ctx.createOscillator(); vib.frequency.value = 5.2;
    const vibG = ctx.createGain(); vibG.gain.setValueAtTime(0, t); vibG.gain.linearRampToValueAtTime(dur > 0.6 ? 9 : 0, t + Math.min(0.5, dur));
    vib.connect(vibG);
    for (const [type, d, a] of [['sawtooth', -5, 0.6], ['sawtooth', 5, 0.6], ['triangle', 0, 0.8]]) {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = d;
      vibG.connect(o.detune);
      const og = ctx.createGain(); og.gain.value = a;
      o.connect(og).connect(lp); o.start(t); o.stop(t + dur + 0.2);
    }
    vib.start(t); vib.stop(t + dur + 0.2);
  }
}
