// The titan's root: a heavy rigid body hovering on wing thrust (titan-boss.md §4.3).
// The flap is a phase accumulator (never sin(2πft)), so frequency changes never pop. Lift arrives as a thrust
// profile per beat: the altitude controller works on the smooth "mean" body only, and the beat-by-beat bob is a
// separate oscillator driven by the same thrust — so the bob is never cancelled, and it lags the wing push by a
// quarter cycle (lowest at mid-downstroke, rising fastest at its end): that lag is what reads as weight.
// Horizontal motion is tilt-to-translate: the body leans first, then moves, surging on every downstroke.
import * as THREE from 'three';
import { clamp, damp } from '../../core/util.js';

const G = 9.81;
export const DOWN_FRACTION = 0.58;                 // downstroke share of a beat
export function thrustProfile(p) {
  const D = DOWN_FRACTION;
  return p < D ? Math.pow(Math.sin(Math.PI * p / D), 1.5) : -0.12 * Math.sin(Math.PI * (p - D) / (1 - D));
}
// Mean of the profile over one beat, sampled (not hard-coded).
export const THRUST_MEAN = (() => { let s = 0; const n = 2000; for (let i = 0; i < n; i++) s += thrustProfile((i + 0.5) / n); return s / n; })();

const smooth = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };

/** Critically damped scalar spring toward .target (rate .wn). */
class ScalarSpring {
  constructor() { this.x = 0; this.v = 0; this.target = 0; this.wn = 2; }
  step(dt) { const w = this.wn; this.v += (w * w * (this.target - this.x) - 2 * w * this.v) * dt; this.x += this.v * dt; }
}

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _h = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class HoverBody {
  constructor() {
    this.pos = new THREE.Vector3();        // world, includes the bob
    this.vel = new THREE.Vector3();
    this.accel = new THREE.Vector3();      // world linear acceleration of the root this step (bob + surge + lean)
    this.mean = new THREE.Vector3();       // smooth body (altitude hold acts here)
    this.meanVel = new THREE.Vector3();
    this.bob = 0; this.bobV = 0;           // vertical beat oscillation (m, m/s)
    this.yaw = 0; this.yawRate = 0;
    this.lean = new THREE.Vector2();       // (pitch forward, roll right) in radians, spring-driven
    this.leanVel = new THREE.Vector2();
    this.pitchOsc = 0; this.pitchOscV = 0; // nose-up kick per downstroke
    this.phase = 0.7; this.freq = 0.42;
    this.quat = new THREE.Quaternion();
    this.target = new THREE.Vector3();     // world hover target (the AI moves it)
    this.yawTarget = 0;
    this.thrust = 1;                       // 1 = full; stagger ~0.4; death 0
    this.surge = new THREE.Vector3();      // extra commanded accel (m/s²), decays
    this.T = 1;                            // normalised thrust this step (mean 1)
    this.events = { downStart: false, downEnd: false, strength: 0 };
    this.cfg = {
      f0: 0.42, fMin: 0.32, fMax: 0.8, pulse: 1.0,
      yKp: 0.5, yKd: 1.27, yAccMax: 4,
      xzKp: 0.045, xzKd: 0.42, leanMax: 20 * Math.PI / 180, leanWn: 1.2, leanZeta: 0.9, drag: 0.011,
      yawRateMax: 13 * Math.PI / 180, yawAccMax: 8 * Math.PI / 180, yawKp: 0.35, yawKd: 1.1,
    };
    this.freqBoost = 1;                    // attacks ask for harder beats (slam windup, gust)
    this.cfg0 = { ...this.cfg };           // pursuit changes leanMax / drag / xzKd; place() restores them
    this.forceBeat = null;                 // { freq } override (gust: fast forward beats)
    this.falling = false;                  // death: no thrust, drag-limited fall
    this.baseY = 0;                        // altitude the AI asks for; rise() offsets it
    this.riseOff = new ScalarSpring();     // slam windup lifts the body, the strike drops it
    this.beatK = 1; this.beatT = 0;        // a single harder downstroke (strikes)
    this.lungeS = null;                    // kinematic lunge (strikes reach further than the arm)
    this.rising = null;                    // emergence: { t, dur, y0, y1 }
  }

  /** One forceful beat (strikes): beats faster/harder for ~0.8 s. */
  beat(k = 1.3) { this.beatK = Math.max(this.beatK, k); this.beatT = 0.8; }
  /** Lift (+) or drop (−) the hover altitude by dy over roughly dur seconds. */
  rise(dy, dur = 1) { this.riseOff.target += dy; this.riseOff.wn = clamp(3 / Math.max(0.3, dur), 1, 6); }
  /** Override the beat frequency (gust: two fast forward strokes); 0 releases it. */
  forceBeats(freq) { this.forceBeat = freq > 0 ? { freq } : null; if (freq > 0) this.phase = 0.96; }
  /** Surge dist metres along dirWorld (horizontal) with a smooth profile over dur. */
  lunge(dirWorld, dist, dur) { this.lungeS = { dir: dirWorld.clone().setY(0).normalize(), dist, dur: Math.max(0.2, dur), t: 0 }; }

  place(pos, yaw = 0) {
    this.pos.copy(pos); this.mean.copy(pos); this.target.copy(pos);
    this.vel.set(0, 0, 0); this.meanVel.set(0, 0, 0); this.bob = 0; this.bobV = 0;
    this.yaw = yaw; this.yawTarget = yaw; this.yawRate = 0; this.lean.set(0, 0); this.leanVel.set(0, 0);
    this.surge.set(0, 0, 0); this.thrust = 1; this.falling = false; this.baseY = pos.y;
    this.riseOff.x = 0; this.riseOff.v = 0; this.riseOff.target = 0; this.lungeS = null; this.lungeLean = 0; this.rising = null;
    this.forceBeat = null; this.beatK = 1; this.beatT = 0;
    if (this.cfg0) { this.cfg.leanMax = this.cfg0.leanMax; this.cfg.drag = this.cfg0.drag; this.cfg.xzKd = this.cfg0.xzKd; }
    this.updateQuat();
  }

  step(dt) {
    const c = this.cfg;
    const prevVel = _w.copy(this.vel);
    this.events.downStart = false; this.events.downEnd = false;

    // --- flap phase accumulator ---
    let aCmdY = 0;
    this.riseOff.step(dt);
    this.target.y = this.baseY + this.riseOff.x;
    if (!this.falling) {
      aCmdY = clamp(c.yKp * (this.target.y - this.mean.y) - c.yKd * this.meanVel.y, -c.yAccMax, c.yAccMax);
    }
    if (this.beatT > 0) { this.beatT -= dt; if (this.beatT <= 0) this.beatK = 1; }
    const want = this.forceBeat ? this.forceBeat.freq
      : clamp(c.f0 * Math.sqrt(Math.max(0.2, (G + aCmdY) / G)) * this.freqBoost * this.beatK, c.fMin, c.fMax * (this.beatK > 1 ? 1.2 : 1));
    this.freq += (want - this.freq) * damp(this.forceBeat ? 6 : 1.2, dt);
    const prevPhase = this.phase;
    this.phase = (this.phase + this.freq * dt) % 1;
    if (this.phase < prevPhase) { this.events.downStart = true; this.events.strength = this.thrust * this.freq / c.f0; }
    if (prevPhase < DOWN_FRACTION && this.phase >= DOWN_FRACTION) this.events.downEnd = true;
    const T = thrustProfile(this.phase) / THRUST_MEAN;
    this.T = T;

    // --- vertical: smooth mean body + beat bob ---
    if (this.rising) {
      // emergence: a scripted climb (decelerating) — the wings still beat and the bob still acts on top
      const R = this.rising;
      R.t += dt;
      const u = clamp(R.t / R.dur, 0, 1), e = 1 - (1 - u) * (1 - u);
      // R.curve (u → y, wave 4): hidden under the deck → a burst through its top → a slow final ascent
      const y = typeof R.curve === 'function' ? R.curve(u) : R.y0 + (R.y1 - R.y0) * e;
      this.meanVel.y = (y - this.mean.y) / Math.max(dt, 1e-4);
      if (u >= 1) { this.rising = null; this.meanVel.y = 0; }
    } else if (this.falling) {
      const sp = this.meanVel.length();
      this.meanVel.y -= G * dt;
      this.meanVel.addScaledVector(this.meanVel, -0.006 * sp * dt);          // terminal ≈ 40 m/s
    } else {
      const liftMean = (G + aCmdY) * this.thrust;
      this.meanVel.y += (liftMean - G) * dt;
    }
    const pulse = c.pulse * this.thrust * (this.falling ? 0 : 1);
    const bobA = G * pulse * (T - 1) - 0.09 * this.bob - 0.6 * this.bobV;   // weak centring: no drift, no damping of the beat
    this.bobV += bobA * dt;
    this.bob += this.bobV * dt;

    // --- horizontal: lean toward the wanted acceleration, then move ---
    if (!this.falling) {
      _v.subVectors(this.target, this.mean).setY(0).multiplyScalar(c.xzKp).addScaledVector(_h.copy(this.meanVel).setY(0), -c.xzKd);
      const aMax = G * Math.tan(c.leanMax);
      if (_v.length() > aMax) _v.setLength(aMax);
      // lean target in body frame (pitch = along heading, roll = sideways)
      const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
      const aF = _v.x * sy + _v.z * cy, aR = -(_v.x * cy - _v.z * sy);
      const tgtP = Math.atan2(aF, G), tgtR = Math.atan2(aR, G);
      for (const [k, tgt] of [['x', tgtP], ['y', tgtR]]) {
        const a = c.leanWn * c.leanWn * (tgt - this.lean[k]) - 2 * c.leanZeta * c.leanWn * this.leanVel[k];
        this.leanVel[k] += a * dt; this.lean[k] += this.leanVel[k] * dt;
      }
      // actual horizontal accel from the leaned thrust (surges on each downstroke)
      const thrustG = G * this.thrust * (1 + 0.5 * pulse * (T - 1));
      const fwd = Math.tan(this.lean.x) * thrustG, right = Math.tan(this.lean.y) * thrustG;
      const ax = fwd * sy - right * cy, az = fwd * cy + right * sy;
      const sp = Math.hypot(this.meanVel.x, this.meanVel.z);
      this.meanVel.x += (ax - c.drag * sp * this.meanVel.x) * dt;
      this.meanVel.z += (az - c.drag * sp * this.meanVel.z) * dt;
    }
    // commanded surges (lunges, recoil) decay quickly
    this.meanVel.addScaledVector(this.surge, dt);
    this.surge.multiplyScalar(Math.exp(-3 * dt));
    this.mean.addScaledVector(this.meanVel, dt);
    if (this.lungeS) {
      const L = this.lungeS;
      const s0 = smooth(L.t / L.dur); L.t += dt; const s1 = smooth(L.t / L.dur);
      this.mean.addScaledVector(L.dir, L.dist * (s1 - s0));
      this.target.addScaledVector(L.dir, L.dist * (s1 - s0));
      // lean into the lunge (the chest leads), then settle back
      const lean = Math.sin(Math.PI * clamp(L.t / L.dur, 0, 1)) * clamp(L.dist / 30, 0, 1) * 0.16;
      this.lungeLean = lean;
      if (L.t >= L.dur) { this.lungeS = null; this.lungeLean = 0; }
    }

    // --- yaw: heavy PD with rate/accel limits (flanking works) ---
    let e = this.yawTarget - this.yaw;
    e = Math.atan2(Math.sin(e), Math.cos(e));
    const ya = clamp(c.yawKp * e - c.yawKd * this.yawRate, -c.yawAccMax, c.yawAccMax) * (this.falling ? 0.2 : 1);
    this.yawRate = clamp(this.yawRate + ya * dt, -c.yawRateMax, c.yawRateMax);
    this.yaw += this.yawRate * dt;

    // --- nose-up kick on each downstroke (thrust above the centre of mass) ---
    const po = -8 * this.pitchOsc - 2.4 * this.pitchOscV + 0.05 * pulse * (T - 1);
    this.pitchOscV += po * dt; this.pitchOsc += this.pitchOscV * dt;

    // --- compose ---
    const newPos = _v.copy(this.mean).addScaledVector(UP, this.bob);
    this.vel.subVectors(newPos, this.pos).divideScalar(Math.max(dt, 1e-4));
    this.pos.copy(newPos);
    this.accel.subVectors(this.vel, prevVel).divideScalar(Math.max(dt, 1e-4));
    this.updateQuat();
  }

  updateQuat() {
    // yaw, then lean (pitch forward about the body's right axis, roll), then the per-beat pitch kick
    const e = new THREE.Euler(this.lean.x + (this.lungeLean || 0) - this.pitchOsc, this.yaw, this.lean.y, 'YXZ');
    this.quat.setFromEuler(e);
  }
}
