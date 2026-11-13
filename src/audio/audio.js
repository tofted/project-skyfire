// game.audio — procedural sound and music (WebAudio only, no files). Contract (docs/ARCHITECTURE.md):
//   play(name, { pos, volume, rate, delay, ...params }) -> true | null      one-shots from synth.js SOUNDS
//   loop(name, { pos, volume, rate, ...params }) -> { set({ volume, rate, pos, ...params }), stop() }
//   music(intensity 0..1 | 'boss' | 'victory' | 'defeat' | 'title')         overrides the automatic score until
//                                                                             the next phase/state change
// Also: muted, setMuted(v), unlocked. The context is created on the first user gesture (browser autoplay rule).
// Everything the world does is heard through events: wingbeat, breath, fireball, explosion, damage, death,
// titan:telegraph, titan:attack, phase, state, lock, warning. Wind is driven from the player's speed/altitude.
// Flight moves (MOVE_SOUNDS / MOVE_LOOPS below, contract events): 'move' start → wingover whoosh / Immelmann wind
// roar / dash thump; 'nearmiss' → whip; 'skim' + player.skim → skim hiss loop; player.fireCharge → rising charge
// tone; 'special' inferno (or player.infernoActive) → ignition + inferno roar loop; 'momentum' skyfall → power-up;
// the special meter filling → a chime; 'sonicboom' (a dive through 70 m/s) → a double crack and boom; a move denied
// for stamina (player.moves.denied) → a soft low blip.
// Hover / flight (player.flightMode, throttle): in a hover every player downstroke adds a deep downwash 'hoverBeat' and a
// low 'hover' air loop hums under the beats while the flight wind drops back; taking off ('takeoff': two power strokes
// + a rising rush) and flaring back into a hover ('flare': an air-brake whoomp + flutter) are heard once per change;
// in forward flight the wind carries the sound. Survival: 'survival:wave' → a war horn ('waveHorn', three notes on an
// ace squadron wave); the score leans harder into combat with every wave.
// Attack runs: the HUD's 'attackrun' { pan, behind, kind, chirp } (a rider's breath run / a drake's dive about to reach
// Sora from off-screen; chirp false = too soon after the last one) → 'attackRun': a short rush-in and two warning
// blips panned to the attacker's side, lower and duller when it comes from behind.
// Levels and elements (game.progress; the HUD's 'hud:levelup' when its LEVEL UP! cut-in shows): 'levelUp' — a rising
// anime chime over a whoosh and a sub hit, and Sora's roar (bigger, with a power chord and the element's colour —
// electric crackle from lightning on — when the element changes). The player's breath follows the element: ember as
// before; azure a hotter, faster roar + a blue gas-jet hiss and a cool whistle ('breathTint'); radiant brighter + a
// shimmer of bell partials; lightning the 'lightningStream' loop instead of fire (an electric buzz, a flickering
// crackle, zaps); storm lightning over a gold-fire roar. A bolt instead of a fireball (the player at lightning /
// storm, or a projectile marked bolt / element) cracks with a close thunderclap ('boltThunder'), its hit with a
// 'boltHit' crack; chain arcs (fx events 'chain' / 'lightning:chain' / 'arc') zap ('arcZap').
import * as THREE from 'three';
import { makeBank, SOUNDS, LOOPS } from './synth.js';
import { Music } from './music.js';
import { clamp } from '../core/util.js';

const SOUND_SPEED = 343;
// Per-sound defaults: reference distance (m) for the inverse distance model, max simultaneous voices, delay rule.
const META = {
  wingbeat: { ref: 30, max: 10 }, fireball: { ref: 40, max: 8 }, explosion: { ref: 90, max: 8, delayed: 1.2 },
  roar: { ref: 400, max: 2 }, rumble: { ref: 600, max: 2 }, swat: { ref: 200, max: 2 }, whoosh: { ref: 25, max: 4 }, thunder: { ref: 800, max: 2, delayed: 5 },
  // the titan's own sounds (it passes its body position): heard across the whole arena, impacts slightly delayed
  'titan-inhale': { ref: 320, max: 2 }, 'titan-whoosh': { ref: 300, max: 2 }, 'titan-crack': { ref: 300, max: 2 },
  'titan-charge': { ref: 320, max: 2 }, 'titan-clap': { ref: 450, max: 2, delayed: 0.4 }, 'titan-slam': { ref: 550, max: 2, delayed: 0.4 },
  'titan-gust': { ref: 400, max: 2 }, 'titan-fall': { ref: 1500, max: 1, delayed: 0.6 }, 'titan-impact': { ref: 260, max: 3, delayed: 0.2 },
  hit: { ref: 40, max: 3 }, hitmarker: { max: 3 }, kill: { max: 2 }, waveClear: { max: 1, ui: true }, sting: { max: 2 }, warning: { max: 1 },
  overheat: { max: 1 }, dodge: { max: 2 }, boost: { max: 1 }, lock: { max: 1 }, heartbeat: { max: 1 },
  uiMove: { max: 3, ui: true }, uiSelect: { max: 2, ui: true }, uiBack: { max: 2, ui: true }, banner: { max: 1, ui: true },
};
const LOOP_META = { wind: { ref: 20 }, breath: { ref: 45 }, titanDrone: { ref: 350 }, rush: { ref: 150 } };
Object.assign(META, {
  wingover: { ref: 40, max: 2 }, loopRoar: { ref: 40, max: 2 }, dash: { ref: 40, max: 2 }, nearMiss: { ref: 30, max: 2 },
  skyfall: { max: 1 }, infernoIgnite: { ref: 45, max: 1 }, sonicBoom: { ref: 220, max: 1 },
  moveDenied: { max: 1, ui: true }, specialReady: { max: 1, ui: true },
});
Object.assign(LOOP_META, { skim: { ref: 20 }, charge: { ref: 30 }, inferno: { ref: 50 } });
Object.assign(META, { hoverBeat: { max: 3 }, takeoff: { max: 1 }, flare: { max: 1 }, waveHorn: { max: 1, ui: true }, attackRun: { max: 2 } });
Object.assign(LOOP_META, { hover: { ref: 20 } });
Object.assign(META, { levelUp: { max: 1, ui: true }, boltThunder: { ref: 260, max: 3 }, boltHit: { ref: 120, max: 3 }, arcZap: { ref: 60, max: 6 } });
Object.assign(LOOP_META, { lightningStream: { ref: 45 }, breathTint: { ref: 45 } });
/** The breath / bolt sound of each element (the player's; enemies and the titan keep their fire). */
export const ELEMENT_AUDIO = {
  ember: { fire: 1, rate: 1, tint: null, zap: 0, bolt: false },
  azure: { fire: 1, rate: 1.08, tint: 'azure', zap: 0, bolt: false },
  radiant: { fire: 1, rate: 1.15, tint: 'radiant', zap: 0, bolt: false },
  lightning: { fire: 0, rate: 1, tint: null, zap: 1, bolt: true },
  storm: { fire: 0.6, rate: 1.12, tint: 'radiant', zap: 1, bolt: true },
};

// ---------- flight-move sounds (procedural, same conventions as synth.js: fn(ctx, bank, out, t, o) -> seconds) ----------
const EPS = 0.0001;
const mAmp = (ctx, v = 0) => { const g = ctx.createGain(); g.gain.value = v; return g; };
const mFilt = (ctx, type, f, Q = 0.707) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = Q; return b; };
const mOsc = (ctx, type, f, t) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = f; o.start(t); return o; };
const mNoise = (ctx, buf, t, rate = 1) => { const n = ctx.createBufferSource(); n.buffer = buf; n.loop = true; n.playbackRate.value = rate; n.start(t, Math.random() * Math.max(0, buf.duration - 0.5)); return n; };
const mPerc = (p, t, a, d, peak) => { p.setValueAtTime(EPS, t); p.linearRampToValueAtTime(peak, t + Math.max(0.001, a)); p.exponentialRampToValueAtTime(EPS, t + a + d); };
const mSweep = (p, t, from, to, dur) => { p.setValueAtTime(Math.max(1, from), t); p.exponentialRampToValueAtTime(Math.max(1, to), t + dur); };
const mShape = (p, t, pts, end) => { p.setValueAtTime(EPS, t); for (const [dt, v] of pts) p.linearRampToValueAtTime(Math.max(EPS, v), t + dt); if (end) p.exponentialRampToValueAtTime(EPS, t + end); };
const mStop = (list, t) => { for (const n of list) { try { n.stop(t); } catch { /* already stopped */ } } };
const mPan = (ctx, out, v = 0) => { if (!ctx.createStereoPanner) return { node: out, pan: null }; const p = ctx.createStereoPanner(); p.pan.value = v; p.connect(out); return { node: p, pan: p.pan }; };
/** A heavy chest thump (dash / wingover flare): falling sine + a band of displaced air. */
function thump(ctx, B, out, t, k = 1, r = 1) {
  const o1 = mOsc(ctx, 'sine', 80 * r, t); mSweep(o1.frequency, t, 84 * r, 38 * r, 0.3);
  const g1 = mAmp(ctx); mPerc(g1.gain, t, 0.012, 0.34, 0.8 * k); o1.connect(g1).connect(out);
  const n = mNoise(ctx, B.brown, t, r); const bp = mFilt(ctx, 'bandpass', 300, 0.8); mSweep(bp.frequency, t, 330 * r, 110 * r, 0.4);
  const g2 = mAmp(ctx); mPerc(g2.gain, t + 0.01, 0.05, 0.38, 1.7 * k); n.connect(bp).connect(g2).connect(out);
  return [o1, n];
}

export const MOVE_SOUNDS = {
  /** Wingover: the air swings around Sora (pan from the turn's side across), a membrane flutter as the wing tucks,
   *  the flare's whomp at the top. o.side −1 left / +1 right. */
  wingover(ctx, B, out, t, o = {}) {
    const r = o.rate ?? 1, side = (o.side ?? 1) < 0 ? -1 : 1, dur = 1.6;
    const P = mPan(ctx, out, -0.65 * side);
    if (P.pan) { P.pan.setValueAtTime(-0.65 * side, t); P.pan.linearRampToValueAtTime(0.7 * side, t + 1.25); }
    const g = mAmp(ctx, 1); g.connect(P.node);
    const n = mNoise(ctx, B.pink, t, r); const bp = mFilt(ctx, 'bandpass', 600, 0.9);
    bp.frequency.setValueAtTime(480 * r, t); bp.frequency.exponentialRampToValueAtTime(2300 * r, t + 0.55); bp.frequency.exponentialRampToValueAtTime(650 * r, t + 1.45);
    const g1 = mAmp(ctx); mShape(g1.gain, t, [[0.35, 2.2], [0.85, 1.7]], 1.55); n.connect(bp).connect(g1).connect(g);
    const low = mNoise(ctx, B.brown, t, r); const lp = mFilt(ctx, 'lowpass', 190, 0.7);
    const g2 = mAmp(ctx); mShape(g2.gain, t, [[0.4, 0.5], [0.9, 0.38]], 1.5); low.connect(lp).connect(g2).connect(g);
    // flutter of the tucked wing (0.3–0.9 s)
    const fl = mNoise(ctx, B.white, t + 0.25, r); const fbp = mFilt(ctx, 'bandpass', 1250 * r, 2.2);
    const am = mAmp(ctx, 0); const lfo = mOsc(ctx, 'square', 21, t + 0.25); const lg = mAmp(ctx, 0.5); lfo.connect(lg).connect(am.gain);
    const g3 = mAmp(ctx); mShape(g3.gain, t + 0.25, [[0.12, 0.55], [0.5, 0.45]], 0.7); fl.connect(fbp).connect(am).connect(g3).connect(g);
    const th = thump(ctx, B, g, t + 0.95, 0.6, r);
    mStop([n, low, fl, lfo, ...th], t + dur + 0.05);
    return dur;
  },
  /** Immelmann: a wind roar that climbs with the half loop (howl + rising cutoff), the roll-out flutter and a beat. */
  loopRoar(ctx, B, out, t, o = {}) {
    const r = o.rate ?? 1, dur = 2.5;
    const P = mPan(ctx, out, 0);
    if (P.pan) { P.pan.setValueAtTime(0, t); P.pan.linearRampToValueAtTime(0.35, t + 1.0); P.pan.linearRampToValueAtTime(-0.35, t + 1.6); P.pan.linearRampToValueAtTime(0, t + 2.3); }
    const g = mAmp(ctx, 1); g.connect(P.node);
    const n = mNoise(ctx, B.pink, t, r); const lp = mFilt(ctx, 'lowpass', 300, 0.9);
    lp.frequency.setValueAtTime(320 * r, t); lp.frequency.exponentialRampToValueAtTime(3400 * r, t + 1.05); lp.frequency.exponentialRampToValueAtTime(520 * r, t + 2.3);
    const g1 = mAmp(ctx); mShape(g1.gain, t, [[0.55, 1.05], [1.1, 1.2], [1.7, 0.7]], 2.45); n.connect(lp).connect(g1).connect(g);
    const hw = mNoise(ctx, B.white, t, r); const hb = mFilt(ctx, 'bandpass', 420, 3.2);
    hb.frequency.setValueAtTime(380 * r, t); hb.frequency.exponentialRampToValueAtTime(1650 * r, t + 1.1); hb.frequency.exponentialRampToValueAtTime(600 * r, t + 2.2);
    const g2 = mAmp(ctx); mShape(g2.gain, t, [[0.6, 0.55], [1.15, 0.6]], 2.3); hw.connect(hb).connect(g2).connect(g);
    const low = mNoise(ctx, B.brown, t, r); const llp = mFilt(ctx, 'lowpass', 130, 0.7);
    const g3 = mAmp(ctx); mShape(g3.gain, t, [[0.5, 1.2], [1.3, 1.0]], 2.4); low.connect(llp).connect(g3).connect(g);
    const th = thump(ctx, B, g, t + 1.3, 0.7, r);
    mStop([n, hw, low, ...th], t + dur + 0.05);
    return dur;
  },
  /** Dash: two heavy strokes 0.14 s apart, a membrane crack and the air bursting past. */
  dash(ctx, B, out, t, o = {}) {
    const r = o.rate ?? 1, dur = 0.9;
    const g = mAmp(ctx, 1); g.connect(out);
    const a = thump(ctx, B, g, t, 0.62, r), b = thump(ctx, B, g, t + 0.14, 0.48, r * 1.06);
    const c = mNoise(ctx, B.white, t + 0.02); const hp = mFilt(ctx, 'highpass', 2600);
    const gc = mAmp(ctx); mPerc(gc.gain, t + 0.02, 0.002, 0.07, 0.45); c.connect(hp).connect(gc).connect(g);
    const w = mNoise(ctx, B.pink, t, r); const wb = mFilt(ctx, 'bandpass', 800, 1.1);
    wb.frequency.setValueAtTime(700 * r, t); wb.frequency.exponentialRampToValueAtTime(3300 * r, t + 0.3); wb.frequency.exponentialRampToValueAtTime(1200 * r, t + 0.85);
    const gw = mAmp(ctx); mPerc(gw.gain, t + 0.03, 0.12, 0.7, 1.1); w.connect(wb).connect(gw).connect(g);
    mStop([...a, ...b, c, w], t + dur + 0.05);
    return dur;
  },
  /** Close call: a fast whip (band sweeping down), a tick, and a low rush for something big (titan, ground). */
  nearMiss(ctx, B, out, t, o = {}) {
    const k = Math.min(1.4, Math.max(0.6, (o.speed ?? 50) / 50)), r = (o.rate ?? 1) * (0.9 + 0.2 * k), big = /titan|terrain|ground/.test(String(o.kind || ''));
    const dur = big ? 0.7 : 0.45;
    const P = mPan(ctx, out, o.pan ?? 0);
    const g = mAmp(ctx, 1); g.connect(P.node);
    const n = mNoise(ctx, B.pink, t, r); const bp = mFilt(ctx, 'bandpass', 3000, 2.2);
    bp.frequency.setValueAtTime(4200 * r, t); bp.frequency.exponentialRampToValueAtTime(480 * r, t + 0.24);
    const g1 = mAmp(ctx); mPerc(g1.gain, t, 0.014, 0.34, 4.2 * k); n.connect(bp).connect(g1).connect(g);
    const body = mNoise(ctx, B.pink, t, r); const bl = mFilt(ctx, 'lowpass', 1600, 0.7); mSweep(bl.frequency, t, 2400 * r, 500 * r, 0.3);
    const gb = mAmp(ctx); mPerc(gb.gain, t + 0.01, 0.03, 0.3, 0.9 * k); body.connect(bl).connect(gb).connect(g);
    const tk = mNoise(ctx, B.white, t); const hp = mFilt(ctx, 'highpass', 5200);
    const g2 = mAmp(ctx); mPerc(g2.gain, t, 0.002, 0.04, 0.22); tk.connect(hp).connect(g2).connect(g);
    const srcs = [n, body, tk];
    if (big) {
      const l = mNoise(ctx, B.brown, t, r); const lp = mFilt(ctx, 'lowpass', 380, 0.8);
      const g3 = mAmp(ctx); mPerc(g3.gain, t, 0.05, 0.6, 1.3); l.connect(lp).connect(g3).connect(g); srcs.push(l);
    }
    mStop(srcs, t + dur + 0.05);
    return dur;
  },
  /** SKYFALL: a bright gold chord that rings up over a rising whoosh and a sub drop. */
  skyfall(ctx, B, out, t, o = {}) {
    const r = o.rate ?? 1, dur = 1.6;
    const g = mAmp(ctx, 1); g.connect(out);
    const srcs = [];
    [[76, 0], [83, 0.045], [88, 0.09], [95, 0.14]].forEach(([m, dt], i) => {
      const f = 440 * Math.pow(2, (m - 69) / 12) * r;
      const v = mOsc(ctx, i % 2 ? 'sine' : 'triangle', f, t + dt); srcs.push(v);
      const gv = mAmp(ctx); mPerc(gv.gain, t + dt, 0.006, 1.2 - i * 0.12, 0.2 - i * 0.025); v.connect(gv).connect(g);
    });
    const n = mNoise(ctx, B.pink, t, r); const lp = mFilt(ctx, 'lowpass', 600, 0.8);
    lp.frequency.setValueAtTime(600, t); lp.frequency.exponentialRampToValueAtTime(7000, t + 0.22); lp.frequency.exponentialRampToValueAtTime(900, t + 1.1);
    const gn = mAmp(ctx); mPerc(gn.gain, t, 0.12, 0.9, 0.9); n.connect(lp).connect(gn).connect(g); srcs.push(n);
    const sub = mOsc(ctx, 'sine', 70, t); mSweep(sub.frequency, t, 72, 34, 0.6); srcs.push(sub);
    const gs = mAmp(ctx); mPerc(gs.gain, t, 0.01, 0.7, 0.7); sub.connect(gs).connect(g);
    mStop(srcs, t + dur + 0.05);
    return dur;
  },
  /** INFERNO ignition: a huge whoomph, sub drop, crackle burst — and Sora roars. */
  infernoIgnite(ctx, B, out, t, o = {}) {
    const r = o.rate ?? 1, dur = 1.8;
    const g = mAmp(ctx, 1); g.connect(out);
    const w = mNoise(ctx, B.brown, t, r); const bp = mFilt(ctx, 'bandpass', 200, 0.9); mSweep(bp.frequency, t, 140 * r, 1300 * r, 0.3);
    const gw = mAmp(ctx); mPerc(gw.gain, t, 0.03, 0.8, 1.8); w.connect(bp).connect(gw).connect(g);
    const sub = mOsc(ctx, 'sine', 60, t); mSweep(sub.frequency, t, 64 * r, 28 * r, 0.9);
    const gs = mAmp(ctx); mPerc(gs.gain, t, 0.01, 1.0, 1.0); sub.connect(gs).connect(g);
    const c = mNoise(ctx, B.crackle, t, r); const hp = mFilt(ctx, 'highpass', 1400);
    const gc = mAmp(ctx); mPerc(gc.gain, t + 0.02, 0.08, 1.2, 1.4); c.connect(hp).connect(gc).connect(g);
    try { SOUNDS.roar(ctx, B, g, t + 0.05, { voice: 'dragon', rate: 1.05 * r }); } catch { /* roar is optional */ }
    mStop([w, sub, c], t + dur + 0.05);
    return dur;
  },
  /** Sonic boom through 70 m/s in a dive: a double crack and a rolling low boom. */
  sonicBoom(ctx, B, out, t, o = {}) {
    const dur = 1.4;
    const g = mAmp(ctx, 1); g.connect(out);
    const srcs = [];
    for (const dt of [0, 0.065]) {
      const c = mNoise(ctx, B.white, t + dt); const hp = mFilt(ctx, 'highpass', 900); srcs.push(c);
      const gc = mAmp(ctx); mPerc(gc.gain, t + dt, 0.002, 0.2, 0.62); c.connect(hp).connect(gc).connect(g);
    }
    const b = mNoise(ctx, B.brown, t); const lp = mFilt(ctx, 'lowpass', 240, 0.7); srcs.push(b);
    const gb = mAmp(ctx); mPerc(gb.gain, t, 0.01, 1.1, 0.82); b.connect(lp).connect(gb).connect(g);
    const sub = mOsc(ctx, 'sine', 52, t); mSweep(sub.frequency, t, 56, 27, 0.8); srcs.push(sub);
    const gs = mAmp(ctx); mPerc(gs.gain, t, 0.004, 0.9, 0.6); sub.connect(gs).connect(g);
    mStop(srcs, t + dur + 0.05);
    return dur;
  },
  /** A move pressed without the stamina for it: a soft low double blip. */
  moveDenied(ctx, B, out, t) {
    const g = mAmp(ctx, 1); g.connect(out);
    const srcs = [];
    [[233, 0], [185, 0.09]].forEach(([f, dt]) => {
      const v = mOsc(ctx, 'triangle', f, t + dt); srcs.push(v);
      const gv = mAmp(ctx); mPerc(gv.gain, t + dt, 0.004, 0.11, 0.3); v.connect(gv).connect(g);
    });
    mStop(srcs, t + 0.3);
    return 0.3;
  },
  /** The INFERNO meter is full: a rising gold arpeggio with a shimmer. */
  specialReady(ctx, B, out, t) {
    const g = mAmp(ctx, 1); g.connect(out);
    const srcs = [];
    [84, 88, 91, 96].forEach((m, i) => {
      const v = mOsc(ctx, 'triangle', 440 * Math.pow(2, (m - 69) / 12), t + i * 0.07); srcs.push(v);
      const gv = mAmp(ctx); mPerc(gv.gain, t + i * 0.07, 0.004, 0.7, 0.16); v.connect(gv).connect(g);
    });
    const n = mNoise(ctx, B.white, t); const hp = mFilt(ctx, 'highpass', 7000); srcs.push(n);
    const gn = mAmp(ctx); mPerc(gn.gain, t, 0.2, 0.6, 0.12); n.connect(hp).connect(gn).connect(g);
    mStop(srcs, t + 1.1);
    return 1.1;
  },
};

// ---------- hover / flight / survival (same conventions) ----------
/** A light hall send built on the bank's impulse response (the horn carries across the valley). */
function mHall(ctx, B, out, wet = 0.3) {
  const dry = mAmp(ctx, 1); dry.connect(out);
  if (!B.ir || !ctx.createConvolver) return dry;
  const cv = ctx.createConvolver(); cv.buffer = B.ir;
  const w = mAmp(ctx, wet); dry.connect(cv).connect(w).connect(out);
  return dry;
}
Object.assign(MOVE_SOUNDS, {
  /** One hovering downstroke: the stroke plane is flat, so the air goes DOWN — a deep downwash whoom under the normal
   *  wingbeat, a membrane crack at the bottom and the recovery upstroke's fwip. o.strength 0..1.6 */
  hoverBeat(ctx, B, out, t, o = {}) {
    const k = 0.45 + 0.5 * Math.min(1.4, Math.max(0.3, o.strength ?? 0.8)), r = o.rate ?? 1, dur = 0.95;
    const g = mAmp(ctx, 1); g.connect(out);
    const sub = mOsc(ctx, 'sine', 62 * r, t); mSweep(sub.frequency, t, 64 * r, 34 * r, 0.36);
    const gs = mAmp(ctx); mPerc(gs.gain, t, 0.04, 0.4, 0.42 * k); sub.connect(gs).connect(g);
    const dw = mNoise(ctx, B.brown, t, r); const lp = mFilt(ctx, 'lowpass', 320, 0.8); mSweep(lp.frequency, t, 340 * r, 130 * r, 0.6);
    const gd = mAmp(ctx); mPerc(gd.gain, t + 0.01, 0.09, 0.55, 1.0 * k); dw.connect(lp).connect(gd).connect(g);
    const air = mNoise(ctx, B.pink, t, r); const bp = mFilt(ctx, 'bandpass', 300, 0.7); mSweep(bp.frequency, t, 430 * r, 170 * r, 0.4);
    const ga = mAmp(ctx); mPerc(ga.gain, t + 0.02, 0.06, 0.36, 0.5 * k); air.connect(bp).connect(ga).connect(g);
    const cr = mNoise(ctx, B.pink, t + 0.17, r); const cb = mFilt(ctx, 'bandpass', 880 * r, 1.4);
    const gc = mAmp(ctx); mPerc(gc.gain, t + 0.17, 0.005, 0.09, 0.24 * k); cr.connect(cb).connect(gc).connect(g);
    const up = mNoise(ctx, B.pink, t + 0.3, r); const ub = mFilt(ctx, 'bandpass', 520, 1.1); mSweep(ub.frequency, t + 0.3, 480 * r, 1150 * r, 0.3);
    const gu = mAmp(ctx); mPerc(gu.gain, t + 0.3, 0.09, 0.2, 0.3); up.connect(ub).connect(gu).connect(g);
    mStop([sub, dw, air, cr, up], t + dur + 0.05);
    return dur;
  },
  /** Hover → forward flight: two power strokes and the air starting to rush past. */
  takeoff(ctx, B, out, t, o = {}) {
    const r = o.rate ?? 1, dur = 1.45;
    const g = mAmp(ctx, 1); g.connect(out);
    const a = thump(ctx, B, g, t, 0.55, r), b = thump(ctx, B, g, t + 0.34, 0.5, r * 1.05);
    const n = mNoise(ctx, B.pink, t, r); const bp = mFilt(ctx, 'bandpass', 420, 0.8);
    bp.frequency.setValueAtTime(380 * r, t); bp.frequency.exponentialRampToValueAtTime(1900 * r, t + 1.0); bp.frequency.exponentialRampToValueAtTime(1300 * r, t + 1.4);
    const gn = mAmp(ctx); mShape(gn.gain, t, [[0.2, 0.25], [0.9, 1.25]], 1.42); n.connect(bp).connect(gn).connect(g);
    const low = mNoise(ctx, B.brown, t, r); const llp = mFilt(ctx, 'lowpass', 160, 0.7);
    const gl = mAmp(ctx); mShape(gl.gain, t, [[0.5, 0.6], [1.0, 0.5]], 1.4); low.connect(llp).connect(gl).connect(g);
    mStop([...a, ...b, n, low], t + dur + 0.05);
    return dur;
  },
  /** Forward flight → hover: the wings flare wide and back-beat — an air-brake whoomp, a membrane flutter, a thump. */
  flare(ctx, B, out, t, o = {}) {
    const r = o.rate ?? 1, dur = 1.2;
    const g = mAmp(ctx, 1); g.connect(out);
    const w = mNoise(ctx, B.brown, t, r); const lp = mFilt(ctx, 'lowpass', 700, 0.8); mSweep(lp.frequency, t, 900 * r, 190 * r, 0.9);
    const gw = mAmp(ctx); mShape(gw.gain, t, [[0.16, 1.05], [0.5, 0.7]], 1.1); w.connect(lp).connect(gw).connect(g);
    const rush = mNoise(ctx, B.pink, t, r); const rb = mFilt(ctx, 'bandpass', 1500, 0.9); mSweep(rb.frequency, t, 1800 * r, 420 * r, 0.8);
    const gr = mAmp(ctx); mPerc(gr.gain, t, 0.05, 0.75, 0.7); rush.connect(rb).connect(gr).connect(g);
    const fl = mNoise(ctx, B.white, t + 0.08, r); const fb = mFilt(ctx, 'bandpass', 1150 * r, 2.2);
    const am = mAmp(ctx, 0); const lfo = mOsc(ctx, 'square', 17, t + 0.08); const lg = mAmp(ctx, 0.5); lfo.connect(lg).connect(am.gain);
    const gf = mAmp(ctx); mShape(gf.gain, t + 0.08, [[0.1, 0.4], [0.45, 0.3]], 0.6); fl.connect(fb).connect(am).connect(gf).connect(g);
    const th = thump(ctx, B, g, t + 0.28, 0.55, r * 0.95);
    mStop([w, rush, fl, lfo, ...th], t + dur + 0.05);
    return dur;
  },
  /** An attack run from off-screen (the HUD's chevron): air rushing in, then two falling warning blips, panned to the
   *  attacker's side (o.pan −1..1); from behind (o.behind) an octave lower through a lowpass, with a sub pulse. */
  attackRun(ctx, B, out, t, o = {}) {
    const behind = !!o.behind, dur = 0.5;
    const P = mPan(ctx, out, clamp(+o.pan || 0, -1, 1) * 0.85);
    const g = mAmp(ctx, 1);
    const lp = mFilt(ctx, 'lowpass', behind ? 2100 : 9000, 0.7);
    g.connect(lp).connect(P.node);
    // the rush: pink noise through a band sweeping up (something closing in fast)
    const n = mNoise(ctx, B.pink, t); const bp = mFilt(ctx, 'bandpass', 700, 1.3);
    bp.frequency.setValueAtTime(behind ? 380 : 620, t); bp.frequency.exponentialRampToValueAtTime(behind ? 1500 : 2600, t + 0.2);
    const gn = mAmp(ctx); mShape(gn.gain, t, [[0.16, 1.0]], 0.28); n.connect(bp).connect(gn).connect(g);
    // two blips (a falling fourth): bright in front / at the sides, low from behind
    const f1 = behind ? 740 : 1480;
    const srcs = [n];
    for (const [dt, f, k] of [[0.1, f1, 0.3], [0.21, f1 * 0.75, 0.27]]) {
      const a = mOsc(ctx, 'square', f, t + dt), b = mOsc(ctx, 'triangle', f * 2, t + dt);
      const ga = mAmp(ctx); mPerc(ga.gain, t + dt, 0.004, 0.085, k * 1.1);
      const gb = mAmp(ctx); mPerc(gb.gain, t + dt, 0.003, 0.055, k * 0.7);
      const tone = mFilt(ctx, 'lowpass', f * 3, 0.9);
      a.connect(tone); b.connect(gb).connect(g); tone.connect(ga).connect(g);
      srcs.push(a, b);
    }
    if (behind) {
      const sub = mOsc(ctx, 'sine', 70, t + 0.08); mSweep(sub.frequency, t + 0.08, 90, 46, 0.3);
      const gs = mAmp(ctx); mPerc(gs.gain, t + 0.08, 0.01, 0.3, 0.28); sub.connect(gs).connect(g); srcs.push(sub);
    }
    mStop(srcs, t + dur + 0.05);
    return dur;
  },
  /** Survival: a war horn for every new wave (o.big: an ace squadron — three notes, louder) over a taiko hit. */
  waveHorn(ctx, B, out, t, o = {}) {
    const big = !!o.big, dur = big ? 3.4 : 2.5;
    const g = mHall(ctx, B, out, 0.32);
    const srcs = [];
    const notes = big ? [[50, 0, 0.8], [57, 0.75, 0.9], [62, 1.55, 1.6]] : [[50, 0, 0.85], [57, 0.8, 1.45]];   // D3 A3 (D4)
    for (const [m, dt, len] of notes) {
      const f = 440 * Math.pow(2, (m - 69) / 12), ti = t + dt;
      const a = mOsc(ctx, 'sawtooth', f, ti), b = mOsc(ctx, 'square', f * 0.5, ti), c = mOsc(ctx, 'sawtooth', f * 1.004, ti);
      const vib = mOsc(ctx, 'sine', 5.2, ti); const vg = mAmp(ctx, f * 0.004); vib.connect(vg); vg.connect(a.frequency); vg.connect(c.frequency);
      const lp = mFilt(ctx, 'lowpass', 380, 1.6);
      lp.frequency.setValueAtTime(260, ti); lp.frequency.exponentialRampToValueAtTime(1500, ti + 0.18); lp.frequency.exponentialRampToValueAtTime(820, ti + len);
      const fm = mFilt(ctx, 'peaking', 700, 1.2); fm.gain.value = 6;
      const ga = mAmp(ctx); mShape(ga.gain, ti, [[0.09, 0.2], [len * 0.7, 0.16]], len + 0.35);
      const gb = mAmp(ctx); mShape(gb.gain, ti, [[0.12, 0.12], [len * 0.7, 0.1]], len + 0.3);
      a.connect(lp); c.connect(lp); lp.connect(fm).connect(ga).connect(g);
      b.connect(gb).connect(g);
      const br = mNoise(ctx, B.pink, ti); const bb = mFilt(ctx, 'bandpass', 1300, 1.2);
      const gbr = mAmp(ctx); mPerc(gbr.gain, ti, 0.03, 0.22, 0.25); br.connect(bb).connect(gbr).connect(g);
      srcs.push(a, b, c, vib, br);
    }
    const d = mOsc(ctx, 'sine', 80, t); mSweep(d.frequency, t, 96, 44, 0.45); srcs.push(d);
    const gd = mAmp(ctx); mPerc(gd.gain, t, 0.004, 0.75, big ? 1.0 : 0.8); d.connect(gd).connect(g);
    const tn = mNoise(ctx, B.brown, t); const tl = mFilt(ctx, 'lowpass', 500, 0.8); srcs.push(tn);
    const gt = mAmp(ctx); mPerc(gt.gain, t, 0.006, 0.35, 0.9); tn.connect(tl).connect(gt).connect(g);
    mStop(srcs, t + dur + 0.1);
    return dur + 2.6;
  },
});

// ---------- levels and elements (same conventions) ----------
/** A burst of electric crackle: several micro-transients of white noise through a high band (a lightning snap). */
function snap(ctx, B, out, t, k = 1, n = 5, f = 2600) {
  const c = mNoise(ctx, B.white, t); const bp = mFilt(ctx, 'bandpass', f, 0.6); const cg = mAmp(ctx);
  const p = cg.gain; p.setValueAtTime(EPS, t);
  for (let i = 0; i < n; i++) { const ti = t + i * 0.011 + Math.random() * 0.008; p.linearRampToValueAtTime(k * (1 - i * 0.12), ti + 0.002); p.exponentialRampToValueAtTime(0.02 * k, ti + 0.009); }
  p.exponentialRampToValueAtTime(EPS, t + n * 0.012 + 0.08);
  c.connect(bp).connect(cg).connect(out);
  return c;
}
Object.assign(MOVE_SOUNDS, {
  /** LEVEL UP: a rising anime chime (major arpeggio + sparkle) over a whoosh and a sub hit, then Sora roars.
   *  o.big: the element changed — a power chord swells under it, the roar is bigger; o.element tints it (azure a cool
   *  airy bell, radiant a bright shimmer, lightning / storm an electric crackle). */
  levelUp(ctx, B, out, t, o = {}) {
    const big = !!o.big, el = String(o.element || 'ember'), dur = big ? 2.6 : 2.0;
    const g = mHall(ctx, B, out, big ? 0.34 : 0.26);
    const srcs = [];
    // the cut-in's whoosh (left → centre)
    const P = mPan(ctx, g, -0.5);
    if (P.pan) { P.pan.setValueAtTime(-0.55, t); P.pan.linearRampToValueAtTime(0.1, t + 0.35); }
    const w = mNoise(ctx, B.pink, t); const wb = mFilt(ctx, 'bandpass', 600, 1.0);
    wb.frequency.setValueAtTime(500, t); wb.frequency.exponentialRampToValueAtTime(3800, t + 0.2); wb.frequency.exponentialRampToValueAtTime(1400, t + 0.5);
    const gw = mAmp(ctx); mPerc(gw.gain, t, 0.06, 0.42, 0.5); w.connect(wb).connect(gw).connect(P.node); srcs.push(w);
    // impact: sub hit + a low body
    const sub = mOsc(ctx, 'sine', 70, t + 0.08); mSweep(sub.frequency, t + 0.08, 92, 40, 0.45); srcs.push(sub);
    const gs = mAmp(ctx); mPerc(gs.gain, t + 0.08, 0.005, 0.55, big ? 0.9 : 0.65); sub.connect(gs).connect(g);
    // the chime: C major climbing (C6 E6 G6 C7 E7, + G7 C8 when big), bright triangles with sine octaves
    const notes = big ? [72, 76, 79, 84, 88, 91, 96] : [72, 76, 79, 84, 88];
    const cool = el === 'azure' || el === 'lightning';
    notes.forEach((m, i) => {
      const f = 440 * Math.pow(2, (m - 69) / 12), ti = t + 0.1 + i * 0.058;
      const a = mOsc(ctx, 'triangle', f, ti), b = mOsc(ctx, 'sine', f * 2, ti); srcs.push(a, b);
      const ga = mAmp(ctx); mPerc(ga.gain, ti, 0.004, 1.1 - i * 0.08, 0.17 - i * 0.012);
      const gb = mAmp(ctx); mPerc(gb.gain, ti, 0.003, 0.5, cool ? 0.07 : 0.045);
      a.connect(ga).connect(g); b.connect(gb).connect(g);
    });
    // the held top: a sparkling major chord (E7 G7 C8), shimmering
    const top = [88, 91, 96].map((m) => 440 * Math.pow(2, (m - 69) / 12));
    const tt = t + 0.1 + notes.length * 0.058;
    // (a multiplicative tremolo after the envelopes: nothing rings on once they have decayed)
    const trem = mOsc(ctx, 'sine', 7, tt); const tg = mAmp(ctx, 0.3); const tr = mAmp(ctx, 1); srcs.push(trem);
    trem.connect(tg).connect(tr.gain); tr.connect(g);
    for (const f of top) {
      const v = mOsc(ctx, 'sine', f, tt); srcs.push(v);
      const gv = mAmp(ctx); mShape(gv.gain, tt, [[0.04, 0.07], [0.5, 0.05]], big ? 1.6 : 1.1);
      v.connect(gv).connect(tr);
    }
    const sp = mNoise(ctx, B.white, t + 0.1); const hp = mFilt(ctx, 'highpass', 6500); srcs.push(sp);
    const gsp = mAmp(ctx); mShape(gsp.gain, t + 0.1, [[0.2, 0.18], [0.6, 0.08]], 1.3); sp.connect(hp).connect(gsp).connect(g);
    if (big) {
      // a power chord swells under it (C3 G3 C4 saws through an opening lowpass)
      for (const m of [48, 55, 60]) {
        const f = 440 * Math.pow(2, (m - 69) / 12);
        const v = mOsc(ctx, 'sawtooth', f, t + 0.05), v2 = mOsc(ctx, 'sawtooth', f * 1.006, t + 0.05); srcs.push(v, v2);
        const lp = mFilt(ctx, 'lowpass', 300, 1.4); lp.frequency.setValueAtTime(260, t + 0.05); lp.frequency.exponentialRampToValueAtTime(2400, t + 0.6); lp.frequency.exponentialRampToValueAtTime(700, t + 2.3);
        const gv = mAmp(ctx); mShape(gv.gain, t + 0.05, [[0.35, 0.09], [1.4, 0.06]], 2.4);
        v.connect(lp); v2.connect(lp); lp.connect(gv).connect(g);
      }
    }
    // the element's colour
    if (el === 'lightning' || el === 'storm') {
      srcs.push(snap(ctx, B, g, t + 0.3, 0.8, 6, 3200), snap(ctx, B, g, t + 0.52, 0.55, 4, 4200));
      const bz = mOsc(ctx, 'sawtooth', 110, t + 0.3); const bb = mFilt(ctx, 'bandpass', 1800, 1.2); srcs.push(bz);
      const gbz = mAmp(ctx); mPerc(gbz.gain, t + 0.3, 0.01, 0.4, 0.12); bz.connect(bb).connect(gbz).connect(g);
    } else if (el === 'azure') {
      const air = mNoise(ctx, B.pink, t + 0.25); const ab = mFilt(ctx, 'bandpass', 3200, 0.8); srcs.push(air);
      const ga = mAmp(ctx); mPerc(ga.gain, t + 0.25, 0.1, 0.8, 0.3); air.connect(ab).connect(ga).connect(g);
    }
    // Sora roars (the bank's dragon voice)
    try { SOUNDS.roar(ctx, B, g, t + (big ? 0.42 : 0.3), { voice: 'dragon', rate: big ? 0.96 : 1.06, strength: big ? 1.1 : 0.8 }); } catch { /* the roar is optional */ }
    mStop(srcs, t + dur + 0.1);
    return dur + 1.2;
  },
  /** A lightning bolt leaves the mouth: a close thunderclap — a sharp crack, a sizzle, a boom and a short roll. */
  boltThunder(ctx, B, out, t, o = {}) {
    const k = Math.min(1.3, Math.max(0.6, o.strength ?? 1)), dur = 2.8;
    const g = mHall(ctx, B, out, 0.3);
    const srcs = [snap(ctx, B, g, t, 0.95 * k, 7, 2400)];
    const cl = mNoise(ctx, B.white, t + 0.004); const cb = mFilt(ctx, 'bandpass', 1700, 0.5); srcs.push(cl);
    const gcl = mAmp(ctx); mPerc(gcl.gain, t + 0.004, 0.002, 0.24, 0.9 * k); cl.connect(cb).connect(gcl).connect(g);
    const sz = mNoise(ctx, B.crackle, t + 0.02, 1.7); const shp = mFilt(ctx, 'highpass', 3000); srcs.push(sz);
    const gsz = mAmp(ctx); mPerc(gsz.gain, t + 0.02, 0.01, 0.45, 1.3 * k); sz.connect(shp).connect(gsz).connect(g);
    const bm = mNoise(ctx, B.brown, t + 0.03, 0.8); const blp = mFilt(ctx, 'lowpass', 420, 0.6); mSweep(blp.frequency, t + 0.03, 480, 150, 1.0); srcs.push(bm);
    const gbm = mAmp(ctx); mPerc(gbm.gain, t + 0.03, 0.012, 1.1, 1.5 * k); bm.connect(blp).connect(gbm).connect(g);
    const rl = mNoise(ctx, B.brown, t + 0.35, 0.6); const rlp = mFilt(ctx, 'lowpass', 260, 0.5); srcs.push(rl);
    const grl = mAmp(ctx); mShape(grl.gain, t + 0.35, [[0.2, 0.55 * k], [0.7, 0.3 * k], [1.2, 0.4 * k], [1.8, 0.15 * k]], 2.4); rl.connect(rlp).connect(grl).connect(g);
    const sb = mOsc(ctx, 'sine', 62, t + 0.02); mSweep(sb.frequency, t + 0.02, 66, 30, 0.5); srcs.push(sb);
    const gsb = mAmp(ctx); mPerc(gsb.gain, t + 0.02, 0.004, 0.55, 0.7 * k); sb.connect(gsb).connect(g);
    mStop(srcs, t + dur + 0.05);
    return dur + 1;
  },
  /** A bolt strikes: a hard electric crack and a short sizzle (lighter than a fire explosion). */
  boltHit(ctx, B, out, t, o = {}) {
    const k = Math.min(1.3, Math.max(0.5, o.size ?? 1)), dur = 0.9;
    const g = mAmp(ctx, 1); g.connect(out);
    const srcs = [snap(ctx, B, g, t, 0.9 * k, 5, 3000)];
    const sz = mNoise(ctx, B.crackle, t + 0.01, 1.9); const hp = mFilt(ctx, 'highpass', 2600); srcs.push(sz);
    const gsz = mAmp(ctx); mPerc(gsz.gain, t + 0.01, 0.01, 0.5, 1.2 * k); sz.connect(hp).connect(gsz).connect(g);
    const th = mNoise(ctx, B.brown, t); const lp = mFilt(ctx, 'lowpass', 320, 0.7); srcs.push(th);
    const gth = mAmp(ctx); mPerc(gth.gain, t, 0.008, 0.45, 0.9 * k); th.connect(lp).connect(gth).connect(g);
    mStop(srcs, t + dur + 0.05);
    return dur;
  },
  /** A chain arc jumps to the next foe: a short zap (a band sweeping down, a buzz, a tick). */
  arcZap(ctx, B, out, t, o = {}) {
    const r = (o.rate ?? 1) * (0.9 + Math.random() * 0.25), dur = 0.32;
    const g = mAmp(ctx, 1); g.connect(out);
    const n = mNoise(ctx, B.white, t); const bp = mFilt(ctx, 'bandpass', 5000, 2.4); mSweep(bp.frequency, t, 6200 * r, 1300 * r, 0.14);
    const gn = mAmp(ctx); mPerc(gn.gain, t, 0.002, 0.16, 0.9); n.connect(bp).connect(gn).connect(g);
    const bz = mOsc(ctx, 'square', 220 * r, t); const bl = mFilt(ctx, 'lowpass', 2400, 1.2);
    const gb = mAmp(ctx); mPerc(gb.gain, t, 0.003, 0.12, 0.13); bz.connect(bl).connect(gb).connect(g);
    const tk = snap(ctx, B, g, t, 0.45, 3, 4800);
    mStop([n, bz, tk], t + dur + 0.05);
    return dur;
  },
});

export const MOVE_LOOPS = {
  /** Lightning breath: an electric buzz, a flickering crackle and random zaps along the stream (instead of the fire
   *  roar from LV 7). set({ intensity 0..1 }) */
  lightningStream(ctx, B, out) {
    const t = ctx.currentTime;
    const g = mAmp(ctx, 0); g.connect(out);
    // the buzz: two detuned saws wobbled by fast LFOs through a band
    const a = mOsc(ctx, 'sawtooth', 98, t), b = mOsc(ctx, 'square', 147, t);
    const l1 = mOsc(ctx, 'sine', 31, t), l2 = mOsc(ctx, 'sine', 53, t); const lg = mAmp(ctx, 16); l1.connect(lg); l2.connect(lg); lg.connect(a.frequency); lg.connect(b.frequency);
    const bp = mFilt(ctx, 'bandpass', 1700, 0.9); const bg = mAmp(ctx, 0.16);
    a.connect(bp); b.connect(bp); bp.connect(bg).connect(g);
    // crackle, gated by a flicker
    const c = mNoise(ctx, B.crackle, t, 1.6); const chp = mFilt(ctx, 'highpass', 2400); const cg = mAmp(ctx, 0.7);
    const f1 = mOsc(ctx, 'square', 13, t), f2 = mOsc(ctx, 'square', 23.5, t); const fg = mAmp(ctx, 0.32); f1.connect(fg); f2.connect(fg); fg.connect(cg.gain);
    c.connect(chp).connect(cg).connect(g);
    // ionised air hiss + a low hum
    const hs = mNoise(ctx, B.white, t); const hhp = mFilt(ctx, 'highpass', 5200); const hg = mAmp(ctx, 0.1);
    hs.connect(hhp).connect(hg).connect(g);
    const hum = mOsc(ctx, 'sine', 55, t); const hmg = mAmp(ctx, 0.08); hum.connect(hmg).connect(g);
    const srcs = [a, b, l1, l2, c, f1, f2, hs, hum];
    // ignition: a crack
    srcs.push(snap(ctx, B, out, t, 0.8, 5, 2800));
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.85, t + 0.06);
    let stopped = false, nextZap = t + 0.05;
    return {
      set(p = {}) {
        if (stopped) return;
        const now = ctx.currentTime, i = Math.min(1.2, Math.max(0, p.intensity ?? 1));
        g.gain.setTargetAtTime(0.85 * Math.max(0.25, i), now, 0.08);
        // random zaps along the stream, scheduled a little ahead (per-frame set calls)
        let n = 0;
        while (nextZap < now + 0.12 && n++ < 4) {
          const at = Math.max(now, nextZap);
          const z = snap(ctx, B, g, at, 0.35 + 0.35 * Math.random(), 2 + Math.floor(Math.random() * 3), 2200 + Math.random() * 3200);
          try { z.stop(at + 0.2); } catch { /* ignore */ }
          nextZap = at + 0.06 + Math.random() * 0.14;
        }
      },
      stop(when = ctx.currentTime) {
        if (stopped) return; stopped = true;
        g.gain.cancelScheduledValues(when); g.gain.setTargetAtTime(0, when, 0.06);
        mStop(srcs, when + 0.5);
      },
    };
  },
  /** The element's colour over the fire breath loop. set({ element 'azure'|'radiant', level 0..1 }) — azure: a blue
   *  gas-jet hiss and a cool whistle; radiant: a shimmer of bell partials and a bright hiss. */
  breathTint(ctx, B, out) {
    const t = ctx.currentTime;
    const g = mAmp(ctx, 0); g.connect(out);
    const jet = mNoise(ctx, B.pink, t); const jb = mFilt(ctx, 'bandpass', 3200, 0.8); const jg = mAmp(ctx, 0);
    jet.connect(jb).connect(jg).connect(g);
    const wh = [1480, 2220].map((f) => mOsc(ctx, 'sine', f, t)); const whg = mAmp(ctx, 0);
    const vib = mOsc(ctx, 'sine', 5.2, t); const vg = mAmp(ctx, 9); vib.connect(vg); for (const o of wh) { vg.connect(o.frequency); o.connect(whg); }
    whg.connect(g);
    // bells → a tremolo stage (gain 1 ± 0.35) → their level (0 unless radiant)
    const bells = [880, 1320, 1760, 2640].map((f) => mOsc(ctx, 'sine', f, t)); const bt = mAmp(ctx, 1); const bg = mAmp(ctx, 0);
    const trem = mOsc(ctx, 'sine', 5.6, t); const tg = mAmp(ctx, 0.35); trem.connect(tg).connect(bt.gain);
    for (const o of bells) o.connect(bt);
    bt.connect(bg).connect(g);
    const hs = mNoise(ctx, B.white, t); const hhp = mFilt(ctx, 'highpass', 4800); const hg = mAmp(ctx, 0);
    hs.connect(hhp).connect(hg).connect(g);
    const srcs = [jet, ...wh, vib, ...bells, trem, hs];
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + 0.12);
    let stopped = false, curEl = '', curLv = 1;
    return {
      set(p = {}) {
        if (stopped) return;
        // the element / level stay as set (the per-frame position updates carry neither)
        if (p.element !== undefined) curEl = String(p.element || '');
        if (p.level !== undefined) curLv = Math.min(1, Math.max(0, +p.level || 0));
        if (p.element === undefined && p.level === undefined) return;
        const now = ctx.currentTime, el = curEl, lv = curLv;
        const az = el === 'azure', ra = el === 'radiant';
        jg.gain.setTargetAtTime(az ? 0.34 * lv : 0.06 * lv, now, 0.1);
        whg.gain.setTargetAtTime(az ? 0.022 * lv : 0, now, 0.1);
        bg.gain.setTargetAtTime(ra ? 0.032 * lv : 0, now, 0.1);
        hg.gain.setTargetAtTime(ra ? 0.07 * lv : az ? 0.05 * lv : 0, now, 0.1);
      },
      stop(when = ctx.currentTime) { if (stopped) return; stopped = true; g.gain.cancelScheduledValues(when); g.gain.setTargetAtTime(0, when, 0.08); mStop(srcs, when + 0.6); },
    };
  },
  /** Hovering: the downwash under the beats — a low, slowly breathing air hum. set({ level 0..1, beat 0..1 }) */
  hover(ctx, B, out) {
    const t = ctx.currentTime;
    const g = mAmp(ctx, 0); g.connect(out);
    const n = mNoise(ctx, B.brown, t); const lp = mFilt(ctx, 'lowpass', 170, 0.8); const ng = mAmp(ctx, 1);
    n.connect(lp).connect(ng).connect(g);
    const lfo = mOsc(ctx, 'sine', 0.31, t); const lg = mAmp(ctx, 0.25); lfo.connect(lg).connect(ng.gain);
    const air = mNoise(ctx, B.pink, t); const ab = mFilt(ctx, 'bandpass', 380, 0.6); const ag = mAmp(ctx, 0.22);
    air.connect(ab).connect(ag).connect(g);
    const srcs = [n, lfo, air];
    let stopped = false;
    return {
      set(p = {}) {
        if (stopped) return;
        const now = ctx.currentTime, lv = Math.min(1, Math.max(0, p.level ?? 0)), beat = Math.min(1, Math.max(0, p.beat ?? 0));
        g.gain.setTargetAtTime(lv * (0.16 + 0.1 * beat), now, 0.12);
        lp.frequency.setTargetAtTime(150 + 90 * beat, now, 0.1);
      },
      stop(when = ctx.currentTime) { if (stopped) return; stopped = true; g.gain.setTargetAtTime(0, when, 0.2); mStop(srcs, when + 1.2); },
    };
  },
  /** Skimming a cloud top / the ground. set({ level 0..1, kind 'cloud'|'terrain', speed }) */
  skim(ctx, B, out) {
    const t = ctx.currentTime;
    const g = mAmp(ctx, 0); g.connect(out);
    const hs = mNoise(ctx, B.white, t); const hp = mFilt(ctx, 'highpass', 1700); const hb = mFilt(ctx, 'bandpass', 3600, 0.7); const hg = mAmp(ctx, 0.5);
    hs.connect(hp).connect(hb).connect(hg).connect(g);
    const l1 = mOsc(ctx, 'sine', 7.3, t), l2 = mOsc(ctx, 'sine', 11.7, t); const lg = mAmp(ctx, 0.18); l1.connect(lg); l2.connect(lg); lg.connect(hg.gain);
    const air = mNoise(ctx, B.pink, t); const ab = mFilt(ctx, 'bandpass', 1700, 0.6); const ag = mAmp(ctx, 0);
    air.connect(ab).connect(ag).connect(g);
    const grit = mNoise(ctx, B.brown, t); const gb = mFilt(ctx, 'bandpass', 380, 1.0); const gg = mAmp(ctx, 0);
    grit.connect(gb).connect(gg).connect(g);
    const srcs = [hs, l1, l2, air, grit];
    return {
      set(p = {}) {
        const now = ctx.currentTime, lv = Math.min(1, Math.max(0, p.level ?? 0)), kind = String(p.kind || '');
        const ground = /terrain|ground/.test(kind), water = /water/.test(kind);
        const k = Math.min(1.3, Math.max(0.6, (p.speed ?? 45) / 45));
        g.gain.setTargetAtTime(lv * 0.42 * k, now, 0.12);
        hb.frequency.setTargetAtTime((water ? 2200 : 2600) + 1500 * k, now, 0.2);
        hg.gain.setTargetAtTime(water ? 0.8 : 0.5, now, 0.2);                 // water: more spray hiss
        ag.gain.setTargetAtTime(ground ? 0.25 : water ? 0.45 : 0.7, now, 0.3);
        gg.gain.setTargetAtTime(ground ? 1.1 : water ? 0.3 : 0.08, now, 0.3);
      },
      stop(when = ctx.currentTime) { g.gain.setTargetAtTime(0, when, 0.15); mStop(srcs, when + 1); },
    };
  },
  /** Fireball charge: a tone that climbs with the charge over a thickening crackle; trembles at full. set({ level }) */
  charge(ctx, B, out) {
    const t = ctx.currentTime;
    const g = mAmp(ctx, 0); g.connect(out);
    const a = mOsc(ctx, 'sawtooth', 160, t), b = mOsc(ctx, 'triangle', 240, t); b.detune.value = 7;
    const lp = mFilt(ctx, 'lowpass', 500, 2.5); const tg = mAmp(ctx, 0.5);
    a.connect(lp); b.connect(lp); lp.connect(tg).connect(g);
    const trem = mOsc(ctx, 'sine', 9, t); const trG = mAmp(ctx, 0); trem.connect(trG).connect(tg.gain);
    const sh = mOsc(ctx, 'sine', 640, t); const shG = mAmp(ctx, 0); sh.connect(shG).connect(g);
    const c = mNoise(ctx, B.crackle, t); const hp = mFilt(ctx, 'highpass', 1500); const cg = mAmp(ctx, 0.1);
    c.connect(hp).connect(cg).connect(g);
    const hum = mOsc(ctx, 'sine', 55, t); const hg = mAmp(ctx, 0); hum.connect(hg).connect(g);
    g.gain.setTargetAtTime(0.5, t, 0.04);
    const srcs = [a, b, trem, sh, c, hum];
    return {
      set(p = {}) {
        const now = ctx.currentTime, lv = Math.min(1, Math.max(0, p.level ?? 0));
        const f0 = 150 + 520 * Math.pow(lv, 1.3);
        a.frequency.setTargetAtTime(f0, now, 0.05); b.frequency.setTargetAtTime(f0 * 1.5, now, 0.05); sh.frequency.setTargetAtTime(f0 * 4, now, 0.05);
        lp.frequency.setTargetAtTime(420 + 4200 * lv, now, 0.06);
        tg.gain.setTargetAtTime(0.1 + 0.22 * lv, now, 0.05);
        trG.gain.setTargetAtTime(lv >= 0.999 ? 0.3 : 0, now, 0.05);
        shG.gain.setTargetAtTime(lv >= 0.999 ? 0.06 : 0.015 * lv, now, 0.06);
        cg.gain.setTargetAtTime(0.08 + 0.38 * lv, now, 0.08);
        hg.gain.setTargetAtTime(0.16 * lv, now, 0.1);
      },
      stop(when = ctx.currentTime) { g.gain.cancelScheduledValues(when); g.gain.setTargetAtTime(0, when, 0.04); mStop(srcs, when + 0.4); },
    };
  },
  /** INFERNO: a furnace roar far bigger than the breath (it layers over the breath loop). set({ intensity }) */
  inferno(ctx, B, out) {
    const t = ctx.currentTime;
    const g = mAmp(ctx, 0); g.connect(out);
    const roar = mNoise(ctx, B.brown, t); const lp = mFilt(ctx, 'lowpass', 1500, 0.6); const rg = mAmp(ctx, 1);
    roar.connect(lp).connect(rg).connect(g);
    const lfo = mOsc(ctx, 'sine', 6.5, t); const lfoG = mAmp(ctx, 0.3); lfo.connect(lfoG).connect(rg.gain);
    const hiss = mNoise(ctx, B.pink, t); const hb = mFilt(ctx, 'bandpass', 2300, 0.5); const hg = mAmp(ctx, 0.55);
    hiss.connect(hb).connect(hg).connect(g);
    const crk = mNoise(ctx, B.crackle, t, 0.9); const chp = mFilt(ctx, 'highpass', 1100); const cg = mAmp(ctx, 1.1);
    crk.connect(chp).connect(cg).connect(g);
    const saw = mOsc(ctx, 'sawtooth', 44, t); const slp = mFilt(ctx, 'lowpass', 210); const sg = mAmp(ctx, 0.3);
    saw.connect(slp).connect(sg).connect(g);
    const sub = mOsc(ctx, 'sine', 36, t); const subG = mAmp(ctx, 0.4); sub.connect(subG).connect(g);
    const srcs = [roar, lfo, hiss, crk, saw, sub];
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.5, t + 0.15);
    let stopped = false;
    return {
      set(p = {}) {
        if (stopped) return;
        const now = ctx.currentTime, i = Math.min(1.2, Math.max(0, p.intensity ?? 1));
        lp.frequency.setTargetAtTime(900 + 900 * i, now, 0.1);
        g.gain.setTargetAtTime(0.5 * Math.max(0.2, i), now, 0.12);
      },
      stop(when = ctx.currentTime) { if (stopped) return; stopped = true; g.gain.cancelScheduledValues(when); g.gain.setTargetAtTime(0, when, 0.18); mStop(srcs, when + 1.2); },
    };
  },
};

export default function createAudio(game) {
  let ctx = null, bank = null, music = null;
  let master = null, comp = null, sfxBus = null, musicBus = null, uiBus = null;
  let wind = null, drone = null, analyser = null, meterBuf = null;
  const breathLoops = new Map();          // actor -> { h, actor }
  const rushes = [];                      // { h, getPos, prev, until }
  const tracked = [];                     // enemy projectiles for fly-by whooshes
  const active = new Map();               // name -> [endTimes]
  const listener = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), fwd: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, 1, 0) };
  const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _hand = new THREE.Vector3();
  const passed = new WeakSet();           // enemy dragons that already whooshed past on this approach
  let override = null, overrideAt = 0;    // music() call from another system (lasts until the next phase)
  let lastTelegraph = null;
  let thunderIn = 9, heartIn = 0, lastHitSound = 0, lastMarker = 0, lastWarn = 0;
  let prevOverheat = false, prevBoost = false, prevDodge = 0;
  const flyby = new WeakMap();            // enemy actor -> previous distance
  const lastPlayed = new Map();           // name -> performance.now() of the last request (event de-duplication)
  /** Was `name` (or any name matching the RegExp) requested within the last `ms`? */
  const playedWithin = (name, ms) => {
    const now = performance.now();
    if (typeof name === 'string') return now - (lastPlayed.get(name) ?? -1e9) < ms;
    for (const [k, t] of lastPlayed) if (name.test(k) && now - t < ms) return true;
    return false;
  };
  /** One console line per kind of failure (a sound that throws every time, or the 90 ms music timer, must not
   *  flood the console). */
  const warned = new Set();
  const warnOnce = (key, ...args) => { if (warned.has(key)) return; warned.add(key); console.warn('[audio]', ...args); };
  /** Run after the current event dispatch (the emitter may play its own sound right after emitting). */
  const afterEmit = (fn) => { const run = () => { try { fn(); } catch (e) { warnOnce('event:' + (e?.message || e), 'event sound failed', e); } }; if (typeof queueMicrotask === 'function') queueMicrotask(run); else Promise.resolve().then(run); };

  const getSettings = () => game.settings || game.hud?.settings || { master: 0.85, music: 0.6, sfx: 0.9, muted: false };

  function applyVolumes(t = ctx?.currentTime ?? 0) {
    if (!ctx) return;
    const s = getSettings();
    const paused = game.state === 'paused';
    master.gain.setTargetAtTime(audio.muted ? 0 : clamp(s.master ?? 0.85, 0, 1), t, 0.05);
    musicBus.gain.setTargetAtTime(clamp(s.music ?? 0.6, 0, 1) * (paused ? 0.55 : 1), t, 0.2);
    sfxBus.gain.setTargetAtTime(clamp(s.sfx ?? 0.9, 0, 1) * (paused || game.state === 'photo' ? 0.12 : 1), t, 0.12);
    uiBus.gain.setTargetAtTime(clamp(s.sfx ?? 0.9, 0, 1), t, 0.05);
  }

  function unlock() {
    if (ctx) { if (ctx.state === 'suspended' && !document.hidden) ctx.resume().catch(() => {}); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      ctx = new AC({ latencyHint: 'interactive' });
      bank = makeBank(ctx);
      master = ctx.createGain(); master.gain.value = 0;
      comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -10; comp.knee.value = 8; comp.ratio.value = 6; comp.attack.value = 0.004; comp.release.value = 0.2;
      master.connect(comp).connect(ctx.destination);
      analyser = ctx.createAnalyser(); analyser.fftSize = 2048; comp.connect(analyser);   // level() meter (tests, debug)
      sfxBus = ctx.createGain(); sfxBus.connect(master);
      musicBus = ctx.createGain(); musicBus.connect(master);
      uiBus = ctx.createGain(); uiBus.connect(master);
      music = new Music(ctx, musicBus, bank);
      audio.ctx = ctx; audio.unlocked = true;
      applyVolumes();
      autoMusic();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      game.events.emit('audio:unlock', {});
    } catch (e) {
      console.warn('[audio] WebAudio unavailable', e);
      ctx = null;
    }
  }
  for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, unlock, { capture: true, passive: true });
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend().catch(() => {}); else ctx.resume().catch(() => {});
  });

  // ---------- voices ----------
  function setNodePos(p, pos) {
    if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; }
    else p.setPosition(pos.x, pos.y, pos.z);
  }
  function airCutoff(d) { return 300 + 16000 * Math.exp(-d / 700); }
  /** Output chain for one voice: gain -> (air lowpass -> panner) -> bus. */
  function makeVoice(bus, pos, ref, volume) {
    const g = ctx.createGain(); g.gain.value = volume;
    if (!pos) { g.connect(bus); return { input: g, g }; }
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    const p = ctx.createPanner();
    p.panningModel = 'equalpower'; p.distanceModel = 'inverse'; p.refDistance = ref; p.rolloffFactor = 1; p.maxDistance = 30000;
    setNodePos(p, pos);
    lp.frequency.value = airCutoff(pos.distanceTo(listener.pos));
    g.connect(lp).connect(p).connect(bus);
    return { input: g, g, lp, p };
  }
  function release(v, afterS) {
    setTimeout(() => { try { v.g.disconnect(); v.p?.disconnect(); v.lp?.disconnect(); } catch { /* gone */ } }, afterS * 1000);
  }
  function budget(name, max, until) {
    const now = ctx.currentTime;
    const list = (active.get(name) || []).filter((t) => t > now);
    if (list.length >= max) { active.set(name, list); return false; }
    list.push(until); active.set(name, list);
    return true;
  }

  const audio = {
    name: 'audio',
    ctx: null, unlocked: false,
    stats: { played: {}, loops: {} },     // counters for tests / the debug overlay
    muted: !!getSettings().muted,

    play(name, opts = {}) {
      const fn = SOUNDS[name] || MOVE_SOUNDS[name];
      if (!ctx || audio.muted || !fn) return null;
      lastPlayed.set(name, performance.now());
      try {
        const meta = META[name] || { ref: 40, max: 4 };
        const pos = opts.pos ? _w.copy(opts.pos) : null;
        const dist = pos ? pos.distanceTo(listener.pos) : 0;
        if (pos && dist > 9000) return null;
        let delay = opts.delay ?? 0;
        if (pos && meta.delayed) delay += Math.min(meta.delayed, dist / SOUND_SPEED);
        const t = ctx.currentTime + 0.005 + delay;
        // opts.budget / opts.budgetMax: a separate voice pool for one kind of caller (e.g. enemy wingbeats)
        if (!budget(opts.budget || name, opts.budgetMax ?? meta.max ?? 4, t + 0.25)) return null;
        const bus = meta.ui ? uiBus : sfxBus;
        const v = makeVoice(bus, pos, opts.ref ?? meta.ref ?? 40, opts.volume ?? 1);
        const params = { ...opts, far: opts.far ?? (pos ? clamp(dist / 3000, 0, 1) : 0) };
        delete params.pos; delete params.budget; delete params.budgetMax;
        const dur = fn(ctx, bank, v.input, t, params) || 1;
        audio.stats.played[name] = (audio.stats.played[name] || 0) + 1;
        release(v, delay + dur + 0.6);
        return true;
      } catch (e) {
        warnOnce('play:' + name, 'play failed', name, e);
        return null;
      }
    },

    loop(name, opts = {}) {
      const dead = { set() {}, stop() {}, dead: true };
      const mk = LOOPS[name] || MOVE_LOOPS[name];
      if (!ctx || !mk) return dead;
      try {
        const meta = LOOP_META[name] || { ref: 40 };
        const pos = opts.pos ? opts.pos.clone() : null;
        const v = makeVoice(sfxBus, pos, opts.ref ?? meta.ref, opts.volume ?? 1);
        const inner = mk(ctx, bank, v.input, opts);
        audio.stats.loops[name] = (audio.stats.loops[name] || 0) + 1;
        let stopped = false;
        const h = {
          set(p = {}) {
            if (stopped) return;
            const now = ctx.currentTime;
            if (p.volume !== undefined) v.g.gain.setTargetAtTime(p.volume, now, 0.08);
            if (p.pos && v.p) {
              setNodePos(v.p, p.pos);
              v.lp.frequency.setTargetAtTime(airCutoff(p.pos.distanceTo(listener.pos)), now, 0.1);
            }
            const { volume, pos: _p, ...rest } = p;
            inner.set(rest);
          },
          stop() { if (stopped) return; stopped = true; inner.stop(ctx.currentTime); release(v, 5); },
          get stopped() { return stopped; },
        };
        return h;
      } catch (e) {
        warnOnce('loop:' + name, 'loop failed', name, e);
        return dead;
      }
    },

    /** Score control: number = explore/combat intensity, or a named mode. */
    music(x) {
      override = x; overrideAt = performance.now();
      applyMusic(x);
    },

    /** RMS of the final mix over the last ~43 ms, in dBFS (-Infinity when silent or locked). */
    level() {
      if (!analyser) return -Infinity;
      meterBuf = meterBuf || new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(meterBuf);
      let sum = 0; for (let i = 0; i < meterBuf.length; i++) sum += meterBuf[i] * meterBuf[i];
      return 10 * Math.log10(sum / meterBuf.length + 1e-12);
    },
    get musicMode() { return music ? music.mode : null; },

    setMuted(v) {
      audio.muted = !!v;
      if (ctx) applyVolumes();
      if (audio.muted) { for (const b of breathLoops.values()) b.h.stop(); breathLoops.clear(); }
      game.events.emit('mute', { muted: audio.muted });
    },

    update(dt, realDt) {
      if (game.input?.pressed('KeyM')) audio.setMuted(!audio.muted);
      if (!ctx) return;
      try { frame(dt, realDt); } catch (e) { if (!audio._warned) { audio._warned = true; console.warn('[audio] frame failed', e); } }
    },

    lateUpdate(dt, realDt) {
      if (!ctx) return;
      const cam = game.camera;
      cam.getWorldPosition(_v);
      if (realDt > 0) listener.vel.copy(_v).sub(listener.pos).divideScalar(Math.max(realDt, 1 / 240));
      listener.pos.copy(_v);
      cam.getWorldDirection(listener.fwd);
      listener.up.set(0, 1, 0).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
      const L = ctx.listener;
      if (L.positionX) {
        L.positionX.value = listener.pos.x; L.positionY.value = listener.pos.y; L.positionZ.value = listener.pos.z;
        L.forwardX.value = listener.fwd.x; L.forwardY.value = listener.fwd.y; L.forwardZ.value = listener.fwd.z;
        L.upX.value = listener.up.x; L.upY.value = listener.up.y; L.upZ.value = listener.up.z;
      } else if (L.setPosition) {
        L.setPosition(listener.pos.x, listener.pos.y, listener.pos.z);
        L.setOrientation(listener.fwd.x, listener.fwd.y, listener.fwd.z, listener.up.x, listener.up.y, listener.up.z);
      }
    },
  };

  // ---------- music automation ----------
  function applyMusic(x) {
    if (!music) return;
    if (typeof x === 'number') { music.setMode(x < 0.45 ? 'explore' : 'combat'); music.setIntensity(x); }
    else if (x === 'boss') { music.setMode('boss'); music.setIntensity(game.director?.phase === 'titan-enraged' ? 1 : 0.5); }
    else if (typeof x === 'string') music.setMode(x);
  }
  function autoMusic() {
    if (!music) return;
    const st = game.state, ph = game.director?.phase;
    if (st === 'title' || st === 'loading') return applyMusic('title');
    if (st === 'victory' || ph === 'victory') return applyMusic('victory');
    if (st === 'defeat' || ph === 'defeat') return applyMusic('defeat');
    if (override !== null) return applyMusic(override);
    if (ph === 'titan-rise' || ph === 'titan' || ph === 'titan-enraged') return applyMusic('boss');
    applyMusic(combatIntensity());
  }
  function combatIntensity() {
    if (game.director?.phase === 'survival') {
      const w = Math.max(1, +game.director.survival?.wave || 1);
      return clamp(Math.max(0.55 + 0.06 * w, baseIntensity()), 0, 1);
    }
    return baseIntensity();
  }
  function baseIntensity() {
    const p = game.player;
    const ppos = p?.pos || p?.actor?.pos;
    let near = 0, n = 0;
    for (const a of game.actors) {
      if (!a.alive || a.team !== 'enemy' || a.kind === 'titan') continue;
      n++;
      if (ppos && a.pos) near = Math.max(near, clamp(1 - (a.pos.distanceTo(ppos) - 300) / 1500, 0, 1));
    }
    const ph = game.director?.phase;
    if (!n) return /^riders/.test(ph || '') ? 0.35 : 0.2;
    return 0.5 + 0.5 * near;
  }
  game.events.on('phase', ({ phase }) => {
    if (performance.now() - overrideAt > 40) override = null;   // a call made while entering this phase stays
    if (phase === 'titan-rise') { thunderIn = 1.5; audio.play('roar', { pos: titanActor()?.pos, volume: 1 }); }
    autoMusic();
  });
  game.events.on('state', ({ next, prev }) => {
    if (next === 'title' || prev === 'title') override = null;
    if (next === 'title') { for (const b of breathLoops.values()) b.h.stop(); breathLoops.clear(); drone?.stop(); drone = null; }
    if (ctx) applyVolumes();
    autoMusic();
  });
  game.events.on('settings', () => { audio.muted = !!getSettings().muted; applyVolumes(); });

  // ---------- world events ----------
  const posOf = (a) => a?.mouth || a?.pos || a?.actor?.pos || a?.root?.position || null;
  const isPlayer = (a) => !!a && (a === game.player || a === game.player?.actor || a.actor === game.player?.actor);
  const titanActor = () => game.titan?.actor || game.actors.find((a) => a.kind === 'titan') || null;

  game.events.on('wingbeat', ({ actor, strength = 0.7, titan } = {}) => {
    if (!ctx) return;
    const a = actor?.actor || actor;
    const isTitan = titan || a?.kind === 'titan';
    const me = isPlayer(actor);
    const pos = a?.pos || actor?.pos || actor?.root?.position;
    // Many enemies (14 dragons ≈ 30 beats/s): beyond 350 m a wingbeat is below −22 dB anyway, and enemy beats share a
    // pool of 4 voices so the player's own and the titan's always get through.
    if (!me && !isTitan && pos && pos.distanceTo(listener.pos) > 350) return;
    const size = isTitan ? 4 : me ? 1 : (a?.radius && a.radius < 6) || /drake/i.test(a?.name || '') ? 0.55 : 0.75;
    // the player hovering: the beat is the sound of the hover (deep downwash layered under a softer normal beat)
    const hovering = me && hoverAmount() > 0.5;
    audio.play('wingbeat', { pos, strength: Math.min(1.6, strength), size, ref: isTitan ? 260 : undefined, volume: me ? (hovering ? 0.6 : 0.9) : isTitan ? 1.2 : 1, rate: 0.94 + Math.random() * 0.12,
      budget: me ? 'wingbeat-player' : isTitan ? 'wingbeat-titan' : 'wingbeat-enemy', budgetMax: me || isTitan ? 3 : 4 });
    if (hovering) audio.play('hoverBeat', { strength: Math.min(1.4, 0.55 + 0.6 * strength), rate: 0.95 + Math.random() * 0.1, volume: 0.95 });
  });
  /** 0 = forward flight, 1 = hovering (player.flightMode; the throttle decides during a transition); 0 without modes. */
  function hoverAmount() {
    const p = game.player, m = p?.flightMode;
    if (m === 'hover') return 1;
    if (m === 'transition') return 1 - clamp(typeof p.throttle === 'number' ? p.throttle : 0.5, 0, 1);
    return 0;
  }
  game.events.on('breath', ({ actor, on, element } = {}) => {
    if (!ctx || !actor) return;
    const cur = breathLoops.get(actor);
    if (on && !cur && !audio.muted) {
      const h = isPlayer(actor) ? playerBreath(actor, typeof element === 'string' && ELEMENT_AUDIO[element] ? element : playerElement())
        : audio.loop('breath', { pos: posOf(actor), rate: 1.15, volume: 1 });
      breathLoops.set(actor, { h, actor });
    } else if (!on && cur) { cur.h.stop(); breathLoops.delete(actor); }
  });
  // ---------- levels and elements ----------
  /** The player's element (game.progress.element; ember without a progression). */
  function playerElement() { const e = game.progress?.element; return typeof e === 'string' && ELEMENT_AUDIO[e] ? e : 'ember'; }
  /** The player's breath in its element's sound, as one loop handle: fire roar (pitched up with the element), the
   *  element's tint over it, the lightning stream instead of / over the fire. */
  function playerBreath(actor, el) {
    const A = ELEMENT_AUDIO[el] || ELEMENT_AUDIO.ember;
    const pos = posOf(actor);
    const parts = [];
    if (A.fire > 0) parts.push(audio.loop('breath', { pos, rate: A.rate, volume: 0.85 * A.fire }));
    if (A.tint) { const t = audio.loop('breathTint', { pos }); t.set({ element: A.tint, level: el === 'storm' ? 0.6 : 1 }); parts.push(t); }
    if (A.zap) parts.push(audio.loop('lightningStream', { pos, volume: 0.9 }));
    levelStats.breaths[el] = (levelStats.breaths[el] || 0) + 1;
    return { element: el, progEl: playerElement(), set(p) { for (const x of parts) x.set(p); }, stop() { for (const x of parts) x.stop(); } };
  }
  const levelStats = { breaths: {}, bolts: 0, boltHits: 0, zaps: 0, levelUps: 0 };
  audio.levelStats = levelStats;
  const boltShots = new WeakSet();
  /** A lightning bolt instead of a fireball: the projectile says so (bolt / element), else the player's element. */
  function isBolt(p, owner) {
    if (!p || typeof p !== 'object') return false;
    if (p.bolt || p.kind === 'bolt' || p.lightning) return true;
    if (typeof p.element === 'string') return /lightning|storm/.test(p.element);
    return isPlayer(owner) && !!ELEMENT_AUDIO[playerElement()]?.bolt;
  }
  game.events.on('hud:levelup', ({ elementChanged, element } = {}) => {
    levelStats.levelUps++;
    audio.play('levelUp', { big: !!elementChanged, element: element || playerElement() });
  });
  let lastZap = -1;
  const onArc = (e = {}) => {
    if (!ctx || game.state !== 'play') return;
    const now = ctx.currentTime;
    if (now - lastZap < 0.06) return;
    lastZap = now;
    const to = e.to || e.target || e.actor || null;
    const pos = e.point || e.pos || (to?.isVector3 ? to : to?.pos) || null;
    levelStats.zaps++;
    audio.play('arcZap', { pos: pos?.isVector3 ? pos : null, volume: 0.9 });
  };
  for (const name of ['chain', 'lightning:chain', 'arc', 'fx:chain', 'chainarc', 'lightning:arc']) game.events.on(name, onArc);
  game.events.on('fireball', ({ projectile, owner, kind } = {}) => {
    if (!ctx) return;
    const titan = kind === 'titan' || owner?.kind === 'titan';
    // a charged shot (fx.fireball({ charged: level })) is bigger and louder
    const ch = Math.min(1, Math.max(0, +(projectile?.charged ?? projectile?.charge ?? 0) || 0));
    if (!titan && isPlayer(owner) && isBolt(projectile, owner)) {
      // lightning / storm: a bolt leaves the mouth with a close thunderclap (storm: wrapped in gold fire)
      boltShots.add(projectile);
      levelStats.bolts++;
      audio.play('boltThunder', { pos: projectile?.pos || posOf(owner), strength: 1 + 0.3 * ch });
      if (playerElement() === 'storm' || projectile?.element === 'storm') audio.play('fireball', { pos: projectile?.pos || posOf(owner), size: 1 + ch, volume: 0.5 });
    } else audio.play('fireball', { pos: projectile?.pos || posOf(owner), size: titan ? 2.5 : 1 + 1.1 * ch, volume: titan ? 1.2 : 0.9 + 0.3 * ch });
    const team = owner?.team ?? owner?.actor?.team;
    if (projectile && team !== 'player' && tracked.length < 40) tracked.push({ p: projectile, prev: Infinity, titan });
  });
  game.events.on('explosion', ({ point, radius = 6, kind, projectile } = {}) => {
    // a bolt's strike (fx: kind 'lightning') cracks; storm's gold fire around it (fx: a fire explosion with the same
    // projectile) is a small burst under the crack
    if (/bolt|lightning/.test(String(kind || ''))) {
      levelStats.boltHits++;
      audio.play('boltHit', { pos: point, size: clamp(radius / 6, 0.6, 1.3) });
      return;
    }
    if (projectile && (boltShots.has(projectile) || projectile.bolt)) { audio.play('explosion', { pos: point, size: clamp(radius / 9, 0.4, 2), volume: 0.5 }); return; }
    audio.play('explosion', { pos: point, size: clamp(radius / 6, 0.5, 4), volume: kind === 'titan' ? 1.2 : 1 });
  });
  game.events.on('damage', (rec = {}) => {
    if (!ctx) return;
    const now = ctx.currentTime;
    if (isPlayer(rec.target)) {
      if (rec.kind === 'fire' && now - lastHitSound < 0.35) return;
      lastHitSound = now;
      audio.play('hit', { strength: clamp(rec.amount / 25, 0.4, 1.2) });
    } else if (isPlayer(rec.source)) {
      const gap = rec.kind === 'fire' ? 0.22 : 0.05;
      if (now - lastMarker < gap) return;
      lastMarker = now;
      audio.play('hitmarker', { strength: rec.kind === 'fire' ? 0.5 : 1, rate: (rec.shape?.mult ?? 1) > 1.2 ? 1.25 : 1 });
    }
  });
  game.events.on('death', ({ actor, killer } = {}) => {
    if (!actor) return;
    if (actor.kind === 'titan') { audio.play('roar', { pos: actor.pos, rate: 0.8, volume: 1.3 }); audio.play('explosion', { pos: actor.pos, size: 4 }); return; }
    if (actor.team === 'enemy') {
      audio.play('roar', { pos: actor.pos, voice: 'dragon', rate: (/drake/i.test(actor.name || '') ? 1.25 : 0.9) + Math.random() * 0.2, volume: 0.8 });
      // the kill chime climbs with the HUD's combo (read after the HUD has counted this kill)
      if (isPlayer(killer)) afterEmit(() => { const n = game.hud?.combo?.count || 1; audio.play('kill', { rate: Math.pow(2, Math.min(7, n - 1) / 12) }); });
    }
  });
  game.events.on('titan:telegraph', (e = {}) => {
    lastTelegraph = { ...e, t: game.time.now };
    audio.play('sting', { strength: 1 });
    const a = String(e.attack || '');
    // The titan voices its own windups (titan-inhale / titan-charge / roar); fall back only if it stayed silent.
    if (/roar|gust|clap|slam/i.test(a)) afterEmit(() => { if (!playedWithin(/^titan-|^roar$/, 400)) audio.play('roar', { pos: titanActor()?.pos, rate: 0.9 + Math.random() * 0.15, volume: 0.9 }); });
  });
  game.events.on('titan:roar', ({ actor, strength = 1 } = {}) => {
    afterEmit(() => { if (!playedWithin('roar', 300)) audio.play('roar', { pos: (actor || titanActor())?.pos, volume: strength }); });
  });
  game.events.on('titan:impact', ({ point, strength = 1, kind } = {}) => {
    const k = String(kind || '');
    const own = /clap/.test(k) ? 'titan-clap' : /slam/.test(k) ? 'titan-slam' : null;
    afterEmit(() => {
      if (own) { if (!playedWithin(own, 300)) audio.play(own, { pos: point }); return; }
      audio.play('titan-impact', { pos: point, strength });     // a hand connecting (swat, grab crush…)
    });
  });
  game.events.on('titan:grab', ({ state } = {}) => {
    const t = titanActor();
    if (state === 'caught') afterEmit(() => { if (!playedWithin('titan-crack', 500)) audio.play('titan-crack', { pos: t?.pos, rate: 1.1 }); });
    else if (state === 'thrown') audio.play('titan-whoosh', { pos: t?.pos, rate: 1.3, duration: 1 });
  });
  game.events.on('titan:stagger', ({ actor } = {}) => audio.play('titan-crack', { pos: (actor || titanActor())?.pos, rate: 0.8 }));
  game.events.on('titan:breach', ({ actor } = {}) => audio.play('titan-gust', { pos: (actor || titanActor())?.pos, rate: 0.7, volume: 1.2, duration: 3.4 }));
  game.events.on('titan:fallen', ({ point, actor } = {}) => {
    afterEmit(() => { if (!playedWithin('titan-fall', 1000)) audio.play('titan-fall', { pos: point || actor?.pos }); });
  });
  game.events.on('titan:attack', ({ attack } = {}) => {
    const a = String(attack || '');
    if (!/swat|clap|slam|punch|grab|chop/i.test(a)) return;
    const titan = titanActor();
    const hand = /L|left/i.test(String(lastTelegraph?.hand || '')) ? 'handL' : 'handR';
    const getPos = () => {
      const s = titan?.shapes?.find((x) => x.part === hand) || titan?.shapes?.find((x) => /hand/.test(x.part));
      if (!s) return null;
      return s.b ? _hand.copy(s.a).add(s.b).multiplyScalar(0.5) : _hand.copy(s.a);
    };
    const p0 = getPos();
    if (!p0 || !ctx) { audio.play('swat', { pos: titan?.pos, rate: 0.9 }); return; }
    const h = audio.loop('rush', { pos: p0 });
    rushes.push({ h, getPos, prev: p0.clone(), until: ctx.currentTime + 1.8 });
  });
  game.events.on('lock', ({ target } = {}) => { if (target) audio.play('lock'); });
  game.events.on('attackrun', ({ pan = 0, behind = false, kind, chirp = true } = {}) => { if (chirp !== false && game.state === 'play') audio.play('attackRun', { pan, behind, kind, volume: 0.9 }); });
  game.events.on('survival:wave', ({ wave } = {}) => { const n = Math.round(+wave || 0); if (n >= 1) audio.play('waveHorn', { big: n % 5 === 0 }); });
  game.events.on('wave:cleared', () => audio.play('waveClear'));
  game.events.on('warning', ({ level = 1 } = {}) => {
    if (!ctx || ctx.currentTime - lastWarn < 1.2) return;
    lastWarn = ctx.currentTime;
    audio.play('warning', { level: typeof level === 'number' ? level : level === 'danger' ? 2 : 1 });
  });
  game.events.on('lightning', ({ point, kind, owner, links = 0 } = {}) => {
    if (!point) return;
    // a bolt's strike (fx): its chain arcs zap one after another; no distant storm thunder for a bolt (its thunderclap
    // already cracked at the launch, the strike cracks with its explosion)
    if (kind === 'bolt' || isPlayer(owner)) {
      const n = Math.min(5, Math.max(0, Math.round(+links || 0)));
      for (let i = 0; i < n; i++) { levelStats.zaps++; audio.play('arcZap', { pos: point, delay: 0.04 + i * 0.05, volume: 0.85, rate: 1 + i * 0.06 }); }
      return;
    }
    audio.play('thunder', { pos: point, far: clamp(point.distanceTo(listener.pos) / 5000, 0, 1) });
  });
  game.events.on('dodge', ({ actor } = {}) => { if (!actor || isPlayer(actor)) audio.play('dodge'); });

  // ---------- flight moves (contract: player.js emits the events and exposes the state on game.player) ----------
  const mv = { skim: null, charge: null, inferno: null, infernoOn: false, specialFull: false, skimEvt: false, chargeEvt: 0, skyAt: -1e9, denied: null };
  /** Another dragon's move (an AI wingover) is heard where it is; the player's own moves are not positional. */
  const moverPos = (e) => { const a = e?.actor; return a && !isPlayer(a) ? (a.pos || a.actor?.pos || null) : null; };
  const mine = (e) => !e?.actor || isPlayer(e.actor);
  game.events.on('move', (e = {}) => {
    if (!ctx || (e.phase && e.phase !== 'start')) return;
    const pos = moverPos(e);
    if (pos && pos.distanceTo(listener.pos) > 400) return;
    const volume = pos ? 0.8 : 1;
    if (e.name === 'wingover') audio.play('wingover', { pos, side: e.side === 'left' || e.side < 0 ? -1 : 1, volume });
    else if (e.name === 'loop') audio.play('loopRoar', { pos, volume });
    else if (e.name === 'dash') audio.play('dash', { pos, volume });
    else if (e.name === 'inferno' && !pos) startInferno();
  });
  game.events.on('nearmiss', (e = {}) => { if (ctx && mine(e)) audio.play('nearMiss', { kind: e.kind, speed: e.speed, pan: (Math.random() - 0.5) * 0.9 }); });
  game.events.on('skim', (e = {}) => { if (mine(e)) mv.skimEvt = !!e.on; });
  game.events.on('charge', (e = {}) => { if (mine(e)) mv.chargeEvt = Number.isFinite(e.level) ? e.level : 0; });
  game.events.on('special', (e = {}) => {
    if ((e.name && e.name !== 'inferno') || !mine(e)) return;
    if (e.on) startInferno(); else stopInferno();
  });
  // the pull-out that starts SKYFALL (phase 'start'; a threshold crossing during the buff has no phase)
  game.events.on('momentum', (e = {}) => {
    if (!e.skyfall || !mine(e)) return;
    const now = performance.now();
    if (e.phase === 'start' || (!e.phase && now - mv.skyAt > 3500)) { mv.skyAt = now; audio.play('skyfall'); }
  });
  game.events.on('sonicboom', (e = {}) => { if (mine(e)) audio.play('sonicBoom', { strength: clamp(((e.speed ?? 70) - 60) / 30, 0.6, 1.2) }); });
  function startInferno() {
    if (mv.infernoOn || !ctx) return;
    mv.infernoOn = true;
    audio.play('infernoIgnite');
    if (!audio.muted) mv.inferno = audio.loop('inferno');
  }
  function stopInferno() { if (!mv.infernoOn) return; mv.infernoOn = false; mv.inferno?.stop(); mv.inferno = null; }
  /** Hover / flight: the hover air loop, and one take-off / flare sound per mode change (not on a respawn / reset). */
  const hv = { loop: null, prev: null, th: null, rising: false, at: -1e9 };
  function modeFrame(p, st) {
    const m = typeof p?.flightMode === 'string' ? p.flightMode : null;
    const playing = st === 'play' && !audio.muted && !!p && p.alive !== false && !p.grabbed;
    const amt = hoverAmount();
    if (playing && m && amt > 0.02) { if (!hv.loop) hv.loop = audio.loop('hover'); hv.loop.set({ level: amt, beat: clamp((p.controls?.flap ?? 0.5), 0, 1) }); }
    else if (hv.loop) { hv.loop.stop(); hv.loop = null; }
    const th = typeof p?.throttle === 'number' ? p.throttle : null;
    if (th !== null && hv.th !== null && Math.abs(th - hv.th) > 0.002) hv.rising = th > hv.th;
    hv.th = th;
    if (!m) { hv.prev = null; return; }
    const now = performance.now();
    // the side of the change: hover → (transition up | flight) = take-off; flight → (transition down | hover) = flare
    // (player.flightPhase 'toFlight' / 'toHover' says it exactly; else the throttle's direction)
    const ph = typeof p.flightPhase === 'string' ? p.flightPhase : null;
    if (ph === 'toFlight') hv.rising = true; else if (ph === 'toHover') hv.rising = false;
    const goingUp = m === 'flight' || (m === 'transition' && hv.rising);
    const goingDown = m === 'hover' || (m === 'transition' && !hv.rising);
    // once per change: after the sound the latch holds 'up' / 'down' until the next settled mode (or the other way)
    if (playing && hv.prev && now - hv.at > 700) {
      if ((hv.prev === 'hover' || hv.prev === 'down') && goingUp && m !== 'hover') { audio.play('takeoff'); hv.at = now; hv.prev = 'up'; }
      else if ((hv.prev === 'flight' || hv.prev === 'up') && goingDown && m !== 'flight' && !p.controls?.dive) { audio.play('flare'); hv.at = now; hv.prev = 'down'; }
    }
    // remember the last settled mode (a transition keeps the one it left, or the latch)
    if (m === 'hover' || m === 'flight') hv.prev = m;
    else if (!hv.prev) hv.prev = hv.rising ? 'hover' : 'flight';
  }
  /** Per frame: the skim hiss, the charge tone and the inferno roar follow the player's state; the meter's chime. */
  function movesFrame(p, st) {
    try { modeFrame(p, st); } catch (e) { warnOnce('hover', 'hover sounds failed', e); }
    const playing = st === 'play' && !audio.muted && !!p && p.alive !== false;
    // skim hiss (level from player.skim, else the 'skim' event); cloud or ground from the height above the terrain
    const sk = typeof p?.skim === 'number' ? p.skim : mv.skimEvt ? 1 : 0;
    if (playing && sk > 0.02) {
      if (!mv.skim) mv.skim = audio.loop('skim');
      let kind = p.skimKind || p.skimSurface || null;          // player.js: 'cloud' | 'terrain' | 'water'
      if (!kind && p.pos) { let hgt = -1e9; try { hgt = game.world.heightAt(p.pos.x, p.pos.z); } catch { /* no terrain */ } kind = p.pos.y - hgt < 30 ? 'terrain' : 'cloud'; }
      mv.skim.set({ level: sk, kind, speed: p.airspeed });
    } else if (mv.skim) { mv.skim.stop(); mv.skim = null; }
    // fireball charge tone (player.fireCharge, else the 'charge' event level)
    const ch = typeof p?.fireCharge === 'number' ? p.fireCharge : mv.chargeEvt;
    if (playing && ch > 0.02) { if (!mv.charge) mv.charge = audio.loop('charge'); mv.charge.set({ level: ch }); }
    else if (mv.charge) { mv.charge.stop(); mv.charge = null; }
    // inferno (a player exposing infernoActive without the event still gets the roar)
    if (typeof p?.infernoActive === 'boolean') { if (p.infernoActive && !mv.infernoOn && playing) startInferno(); else if (!p.infernoActive && mv.infernoOn) stopInferno(); }
    if (!playing && mv.infernoOn) stopInferno();
    mv.inferno?.set({ intensity: 1 });
    // a move pressed without the stamina for it (player.moves.denied: a new object per denial)
    const den = p?.moves?.denied;
    if (den && den !== mv.denied && playing && (den.reason === 'stamina' || den.reason === undefined)) audio.play('moveDenied');
    mv.denied = den || null;
    // the INFERNO meter just filled
    if (typeof p?.special === 'number') {
      const full = p.special >= 0.999;
      if (full && !mv.specialFull && playing && !mv.infernoOn) audio.play('specialReady');
      mv.specialFull = full;
    }
  }

  // ---------- per-frame ----------
  function frame(dt, realDt) {
    const p = game.player;
    const st = game.state;
    const flying = st === 'play' || st === 'title';
    // wind
    if (!wind && !audio.muted) wind = audio.loop('wind');
    if (wind) {
      const vel = p?.vel || p?.actor?.vel;
      const speed = p?.airspeed ?? (vel ? vel.length() : 0);
      const dive = vel ? clamp((-vel.y - 12) / 45, 0, 1) : 0;
      const alt = p?.altitude ?? p?.pos?.y ?? listener.pos.y;
      let cloud = 0;
      try { cloud = game.world.cloudDensity(listener.pos.x, listener.pos.y, listener.pos.z) || 0; } catch { cloud = 0; }
      // hover / flight: the wind drops back while hovering (the beats carry the sound), and is full in forward flight
      const modeK = typeof p?.flightMode === 'string' ? 1.12 - 0.5 * hoverAmount() : 1;
      wind.set({ speed, dive, altitude: alt, cloud, volume: !p ? 0.35 : flying ? (st === 'title' ? 0.55 : modeK) : 0 });
    }
    // breath loops follow their mouths
    for (const [actor, b] of breathLoops) {
      if (actor.alive === false || actor.actor?.alive === false || st === 'title') { b.h.stop(); breathLoops.delete(actor); continue; }
      // the element changed under a held stream (a level-up): the breath takes the new element's sound
      if (b.h.progEl && b.h.progEl !== playerElement() && !audio.muted) { b.h.stop(); b.h = playerBreath(actor, playerElement()); }
      const pos = posOf(actor); if (pos) b.h.set({ pos, intensity: 1 });
    }
    // titan drone
    const titan = titanActor();
    const titanOn = titan && titan.alive !== false && /titan/.test(game.director?.phase || 'titan') && st !== 'title';
    if (titanOn && !drone && !audio.muted) drone = audio.loop('titanDrone', { pos: titan.pos });
    if (drone) {
      if (!titanOn) { drone.stop(); drone = null; }
      else drone.set({ pos: titan.pos, intensity: game.director?.phase === 'titan-enraged' ? 1.3 : 1, volume: 1 });
    }
    // swat rush with doppler from the hand's real motion
    for (let i = rushes.length - 1; i >= 0; i--) {
      const r = rushes[i];
      const pos = r.getPos();
      if (!pos || ctx.currentTime > r.until) { r.h.stop(); rushes.splice(i, 1); continue; }
      const vel = _w.copy(pos).sub(r.prev).divideScalar(Math.max(dt, 1 / 240));
      r.prev.copy(pos);
      const toL = _v.copy(listener.pos).sub(pos);
      const d = toL.length() || 1;
      const vr = vel.dot(toL) / d - listener.vel.dot(toL) / d;     // closing speed (m/s), + approaching
      const doppler = SOUND_SPEED / Math.max(80, SOUND_SPEED - clamp(vr, -250, 250));
      r.h.set({ pos, doppler, speed: dt > 0 ? vel.length() : 0 });
    }
    // enemy fireball fly-bys
    for (let i = tracked.length - 1; i >= 0; i--) {
      const t = tracked[i];
      const pos = t.p.pos || t.p.position;
      if (!pos || t.p.alive === false || t.p.dead || t.p.done) { tracked.splice(i, 1); continue; }
      const d = pos.distanceTo(listener.pos);
      if (d < 55 && d > t.prev) { audio.play('whoosh', { pos, rate: t.titan ? 0.7 : 1 }); tracked.splice(i, 1); continue; }
      t.prev = d;
    }
    // enemy dragon fly-bys near the player
    const ppos = p?.pos || p?.actor?.pos;
    if (ppos && st === 'play') {
      for (const a of game.actors) {
        if (a.team !== 'enemy' || a.kind !== 'dragon' || !a.alive || !a.pos) continue;
        const d = a.pos.distanceTo(ppos);
        const prev = flyby.get(a) ?? Infinity;
        if (d < 45 && d > prev && !passed.has(a)) { passed.add(a); audio.play('whoosh', { pos: a.pos, rate: 0.8 }); }
        if (d > 90) passed.delete(a);
        flyby.set(a, d);
      }
    }
    try { movesFrame(p, st); } catch (e) { warnOnce('moves', 'move sounds failed', e); }
    if (st !== 'play') return;
    // storm thunder around the titan fight
    if (/titan/.test(game.director?.phase || '')) {
      thunderIn -= dt;
      if (thunderIn <= 0) {
        thunderIn = 8 + Math.random() * 12;
        const ang = Math.random() * Math.PI * 2, dist = 1500 + Math.random() * 3500;
        const pt = _v.set(listener.pos.x + Math.cos(ang) * dist, listener.pos.y + 300, listener.pos.z + Math.sin(ang) * dist);
        audio.play('thunder', { pos: pt, far: clamp(dist / 5000, 0, 1), volume: 1.2 });
      }
    }
    // player-state cues
    if (p) {
      const hp = p.hp ?? p.actor?.hp, max = p.maxHp ?? p.actor?.maxHp ?? 100;
      if (hp > 0 && hp / max < 0.3) { heartIn -= dt; if (heartIn <= 0) { heartIn = 0.85; audio.play('heartbeat', { volume: 0.9 }); } }
      const over = !!(p.overheated ?? p.overheat ?? ((p.heat ?? 0) >= 0.995));
      if (over && !prevOverheat) audio.play('overheat');
      prevOverheat = over;
      const boost = !!p.controls?.boost;
      if (boost && !prevBoost && (p.stamina ?? 1) > 0.1) audio.play('boost', { volume: 0.8 });
      prevBoost = boost;
      const dodge = p.controls?.dodge || 0;
      if (dodge && !prevDodge) audio.play('dodge');
      prevDodge = dodge;
    }
    // automatic combat intensity (without a named override)
    if (override === null && music && music.mode !== 'boss' && !/titan|victory|defeat/.test(game.director?.phase || '')) {
      const i = combatIntensity();
      music.setMode(i < 0.45 ? 'explore' : 'combat');
      if (Math.abs(i - music.intensity) > 0.05) music.setIntensity(i);
    }
    return undefined;
  }

  // Music scheduler runs on a timer (not rAF) so render hitches never starve it.
  setInterval(() => { if (music && ctx && ctx.state === 'running') { try { music.tick(ctx.currentTime + 0.6); } catch (e) { warnOnce('music', 'music', e); } } }, 90);

  return audio;
}
