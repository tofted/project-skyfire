// Titan attacks: key poses + timing (genga), the rig's PD joints do the in-betweens (douga).
// Each attack is a small script over stages. Stage names used by everything else:
//   telegraph (windup, 'titan:telegraph' fired at t = 0) → tame (held, trembling) → active (hitbox live) →
//   follow (overshoot) → recover (safe window for the player) — plus attack-specific ones (hold, throw, fire…).
// Hand targets are in titan model space (+X = titan's left, +Z forward). s = +1 left hand, −1 right hand.
import * as THREE from 'three';
import { clamp, smoothstep } from '../../core/util.js';

const D2R = Math.PI / 180;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const Yp = V(0, 1, 0);

/** Minimum time from telegraph to live hitbox (titan-boss.md §2.6), never shortened by the enraged tempo. */
export const MIN_TELEGRAPH = { melee: 1.2, slam: 1.6, projectile: 0.9, pattern: 1.2 };

function stages(list, tempo = 1, minTele = 0, liveStage = 'active') {
  // tempo < 1 speeds windups and recoveries up, but the time to the live stage never drops below minTele
  const out = list.map(([name, dur, fixed]) => ({ name, dur: fixed ? dur : dur * tempo }));
  let pre = 0;
  for (const s of out) { if (s.name === liveStage) break; pre += s.dur; }
  if (pre < minTele && pre > 0) { const k = minTele / pre; for (const s of out) { if (s.name === liveStage) break; s.dur *= k; } }
  let t = 0;
  for (const s of out) { s.t0 = t; t += s.dur; s.t1 = t; }
  return out;
}

class Attack {
  constructor(T, name, opts = {}) {
    this.T = T; this.name = name; this.opts = opts;
    this.t = 0; this.si = 0; this.done = false; this.hitDone = false;
    this.hand = opts.hand || null;
    this.tempo = T.tempo;
  }
  get stage() { return this.st[this.si]?.name || 'done'; }
  get local() { const s = this.st[this.si]; return s ? this.t - s.t0 : 0; }
  get frac() { const s = this.st[this.si]; return s ? clamp((this.t - s.t0) / Math.max(1e-3, s.dur), 0, 1) : 1; }
  stageStart(name) { return this.st.find((s) => s.name === name)?.t0 ?? 0; }
  advance(dt) {
    this.t += dt;
    while (this.si < this.st.length && this.t >= this.st[this.si].t1) {
      this.si++;
      if (this.si < this.st.length) this.enter?.(this.st[this.si].name);
    }
    if (this.si >= this.st.length) this.done = true;
  }
  /** Seconds until the hitbox is live (for the telegraph event). */
  timeToLive() { return this.stageStart(this.liveStage || 'active'); }
  begin() {
    this.enter?.(this.st[0].name);
    this.T.telegraph(this.name, this.hand, this.timeToLive(), this);
  }
  interrupt() { this.done = true; this.cleanup?.(); }
  /** The player dodged through this attack's blow (i-frames): one pass per attack, it does not come back for them. */
  get dodged() { return this.T.lastDodge?.attack === this; }
}

// ------------------------------------------------------------------------------------------------ helpers
const sideOf = (h) => (h === 'L' ? 1 : -1);
const _sv = V(), _sS = V(), _sd = V(), _sW = V(), _sP = V(), _sA = V(), _sB = V(), _sC = V();
function pickHand(T) {
  const pm = T.playerModel(V());
  return pm.x >= 0 ? 'L' : 'R';
}

// ================================================================================================ SWAT
class Swat extends Attack {
  constructor(T, opts) {
    super(T, 'swat', opts);
    this.hand = opts.hand || pickHand(T);
    const c = T.config.attacks.swat;
    this.st = stages([['telegraph', c.windup], ['tame', c.tame], ['active', c.strike, true], ['follow', c.follow, true], ['recover', c.recover]], this.tempo, MIN_TELEGRAPH.melee - 0.1);
    this.live = [this.stageStart('active') + 0.12, this.stageStart('recover')];   // the follow-through hand still kills
  }
  enter(name) {
    const T = this.T, s = sideOf(this.hand);
    if (name === 'telegraph') {
      this.lockPlane();
      T.glint(); T.armGlow(this.hand, 0.9);
      T.sound('titan-inhale');
    }
    if (name === 'tame') this.lockPlane();                    // the swing plane is fixed at the end of the windup
    if (name === 'active') { this.lockPlane(true); T.emitAttack(this); T.sound('titan-whoosh'); T.body.beat(1.35); }
  }
  /** Seconds from now until the palm crosses the player's predicted bearing on the arc (joint lag included). */
  contactIn() {
    const e = this.back / Math.max(1e-3, this.back + this.fwd);
    let u = 0.5; for (let i = 0; i < 12; i++) { const f = u * u * (3 - 2 * u) - e, df = 6 * u * (1 - u); u = clamp(u - f / Math.max(0.2, df), 0, 1); }
    const act = this.st.find((x) => x.name === 'active');
    return act.t0 + u * act.dur * 0.62 + 0.16 - this.t;
  }
  /**
   * Second pass: seconds until the palm (or the outer forearm) first meets her, simulated along the swing arc with her
   * velocity RELATIVE to the titan — a dragon flying in fast meets the hand long before the palm crosses her bearing
   * (the verifier: "now" 0.28–0.30 s before the hit at 50–78 m/s). Infinity when the swing misses her path.
   */
  simContact() {
    const T = this.T, pp = T.playerPos();
    if (!pp || this.back == null || !this.target || !this.dirP || !this.axis) return Infinity;
    const act = this.st.find((x) => x.name === 'active');
    const rv = T.playerVel(_sv).sub(T.body.vel);
    const S = T.socket('shoulder' + this.hand, _sS);
    if (!S) return Infinity;
    const pr = 3, Rp = 8 + pr + 3, Rf = 4.5 + pr + 2;
    const R = clamp(this.target.distanceTo(S) - 7, 24, 39);
    for (let tau = 0; tau <= 1.3; tau += 0.035) {
      const ta = this.t + tau - 0.16;                        // the joints lag the planned arc ≈ 0.16 s
      if (ta < act.t0 + 0.05) continue;                     // wound up and still: it hurts only once it swings
      const u = clamp((ta - act.t0) / (act.dur * 0.62), 0, 1);
      const e = u * u * (3 - 2 * u);
      _sd.copy(this.dirP).applyAxisAngle(this.axis, -this.back + (this.back + this.fwd) * e);
      const r = 24 + (R - 24) * Math.min(1, e * 1.8);
      _sW.copy(S).addScaledVector(_sd, r); _sW.y += 3 + 7 * (1 - Math.min(1, e * 2));
      _sP.copy(pp).addScaledVector(rv, tau);
      if (_sW.distanceTo(_sP) < Rp) return tau;
      // the outer forearm (from ~45 % of the way out to the wrist)
      _sA.copy(S).addScaledVector(_sd, r * 0.45);
      _sB.subVectors(_sW, _sA);
      const k = clamp(_sC.subVectors(_sP, _sA).dot(_sB) / Math.max(1e-6, _sB.lengthSq()), 0, 1);
      if (_sC.copy(_sA).addScaledVector(_sB, k).distanceTo(_sP) < Rf) return tau;
    }
    return Infinity;
  }
  lockPlane(final = false) {
    // The swing plane is locked in WORLD space: the body lunges and leans during the strike, and the IK re-aims
    // the arm at the world arc every step, so the palm really sweeps through where the player will be. The
    // prediction uses the player's velocity RELATIVE to the titan (it lunges and glides too), full lead.
    const T = this.T, s = sideOf(this.hand);
    const Sw = T.socket('shoulder' + this.hand, V());
    const tHit = Math.max(0.15, (this.back != null ? this.contactIn() : this.stageStart('active') + 0.45 - this.t));
    const rv = T.playerVel(V()).sub(T.body.vel);
    const pp = T.playerPos();
    const pw = pp ? pp.clone().addScaledVector(rv, tHit * 0.9) : T.toWorld(T.playerModel(V(), tHit, 0.9), V());
    const toP = pw.clone().sub(Sw);
    const dist = toP.length();
    const dirNew = toP.normalize();
    if (final && this.dirP) {
      // last correction as the strike starts: at most 28°, so the wound-up arm does not jump
      const ang = this.dirP.angleTo(dirNew);
      if (ang > 1e-3) { const k = Math.min(1, 28 * D2R / ang); this.dirP.lerp(dirNew, k).normalize(); }
      this.target = Sw.clone().addScaledVector(this.dirP, dist);
      this.axis.copy(T.dirToWorld(V(0, -s, 0)).applyAxisAngle(this.dirP, this.diag * s).normalize());
      return;
    }
    this.dirP = dirNew;
    const reach = T.armReach();
    if (this.si <= 1) {
      // lunge (re-planned at the end of the windup) so the arc's radius reaches the predicted point
      const want = clamp(dist - (reach - 8), 0, 42);
      const left = this.si === 0 ? this.st[0].dur + this.st[1].dur : Math.max(0.3, this.st[1].dur + 0.25);
      if (this.si === 0 || want > (this.lunge || 0) * 0.5 + 4) { this.lunge = want; if (want > 0.5) T.lungeToward(T.toModel(pw, V()), want, left); }
    }
    this.target = pw;
    this.diag = this.diag ?? (this.opts.diag ?? (T.rand() - 0.35) * 40) * D2R;
    const diag = this.diag;
    this.axis = T.dirToWorld(V(0, -s, 0)).applyAxisAngle(this.dirP, diag * s).normalize();
    const fwdW = T.forwardWorld(V());
    let back = 78 * D2R;
    const wd = () => this.dirP.clone().applyAxisAngle(this.axis, -back);
    for (let i = 0; i < 8 && wd().dot(fwdW) < -0.25; i++) back -= 8 * D2R;
    this.back = back; this.fwd = 72 * D2R;
  }
  /** World wrist target on the swing arc about the (current) shoulder: u = 0 wound up … 1 follow-through. */
  arc(u, out) {
    const T = this.T;
    const e = u * u * (3 - 2 * u);
    const dir = this.dirP.clone().applyAxisAngle(this.axis, -this.back + (this.back + this.fwd) * e);
    const S = T.socket('shoulder' + this.hand, V());
    const R = clamp(this.target.distanceTo(S) - 7, 24, 39);
    const r = 24 + (R - 24) * Math.min(1, e * 1.8);
    out.copy(S).addScaledVector(dir, r).add(V(0, 3 + 7 * (1 - Math.min(1, e * 2)), 0));   // +3 m: the palm hangs below the wrist line
    return dir;
  }
  plan(P) {
    const T = this.T, s = sideOf(this.hand), A = P.arms[this.hand];
    const st = this.stage;
    if (st === 'telegraph' || st === 'tame') {
      const dir = this.arc(0, A.wrist);
      T.toModel(A.wrist, A.wrist);
      A.palm = T.dirToModel(V().crossVectors(this.axis, dir).normalize());
      A.pole.set(s * 0.6, 0.1, -0.8).normalize();
      A.hand = 'splay'; A.gains = 'windup'; A.tremble = st === 'tame' ? 1 : 0;
      A.clav.fwd = -0.28; A.clav.raise = 0.18;
      P.torso.yaw = s * 14 * D2R; P.torso.pitch = -4 * D2R; P.torsoGains = 'windup';
      P.wings.amp = 26 * D2R; P.wings.mid = 14 * D2R;
      P.wings.lift[this.hand] = 34 * D2R; P.wings.back[this.hand] = 40 * D2R;      // the wing clears the swinging arm
      P.legs[this.hand].flex = -10 * D2R;
    } else if (st === 'active' || st === 'follow') {
      // the target sweeps the arc (the joints lag it: slow start, whip through the player, overshoot)
      const u = st === 'active' ? clamp(this.local / (this.st[this.si].dur * 0.62), 0, 1) : 1;
      const dir = this.arc(u, A.wrist);
      T.toModel(A.wrist, A.wrist);
      A.palm = T.dirToModel(V().crossVectors(this.axis, dir).normalize());
      A.pole.set(s * 0.5, -0.7, -0.5).normalize();
      A.hand = 'splay'; A.gains = st === 'active' ? 'strike' : 'follow';
      A.clav.fwd = 0.25; A.clav.raise = 0.05;
      P.torso.yaw = -s * 20 * D2R; P.torso.pitch = 8 * D2R; P.torsoGains = 'strike';
      P.wings.amp = 40 * D2R;
      P.wings.lift[this.hand] = 30 * D2R; P.wings.back[this.hand] = 45 * D2R;
      const other = this.hand === 'L' ? 'R' : 'L';
      P.legs[other].flex = -24 * D2R; P.legs[other].knee = 36 * D2R;
      P.legs[this.hand].flex = 16 * D2R;
    } else {
      A.gains = 'idle';
    }
    P.head.fast = true;
  }
  tick() {
    const T = this.T;
    // the "now" cue: ≈ config.dodge.cue s before the palm meets the player — the earlier of the bearing estimate (a
    // dragon holding its spot near the swing) and the arc simulated with her own velocity (a dragon flying into it)
    if (!this.cued && this.back != null && this.stage !== 'recover') {
      const cue = T.config.dodge.cue;
      const tIn = this.contactIn(), tSim = this.simContact();
      const pp = T.playerPos();
      if (tSim <= cue) T.strikeCue(this, this.hand, Math.max(0, tSim));
      else if (this.stage !== 'telegraph' && tIn <= cue && pp && this.target && pp.distanceTo(this.target) < 70) T.strikeCue(this, this.hand, Math.max(0, tIn));
    }
    if (this.t > this.live[1] && !this.missChecked) {
      this.missChecked = true;
      if ((!this.hitDone || this.dodged) && T.playerAlive()) { this.missed = true; T.onMiss?.(this, this.hand); }
    }
    if (this.hitDone || this.t < this.live[0] || this.t > this.live[1]) return;
    if (this.dodged) { this.hitDone = true; return; }
    if (T.handContact(this.hand, { damage: T.dmg('swat'), minSpeed: 25, gate: this })) { this.hitDone = true; this.connected = true; }
  }
}

// ================================================================================================ GRAB
class Grab extends Attack {
  constructor(T, opts) {
    super(T, 'grab', opts);
    this.hand = opts.hand || pickHand(T);
    const c = T.config.attacks.grab;
    this.c = c;
    this.st = stages([['telegraph', c.windup], ['tame', c.tame], ['active', c.lunge, true], ['recover', c.miss]], this.tempo, MIN_TELEGRAPH.melee);
    // second pass: the reaching hand hurts from +0.42 s into the reach (was +0.15: it met a dragon 25–40 m out
    // 0.1–0.3 s after the "now", which came 0.33 s into the reach); the cue now comes as the reach begins
    this.live = [this.stageStart('active') + 0.42, this.stageStart('active') + c.lunge];
    this.cueAt = this.stageStart('active') - 0.1;
    this.V = null; this.Vv = V();
    this.caught = false;
  }
  enter(name) {
    const T = this.T;
    if (name === 'telegraph') { T.glint(); T.armGlow(this.hand, 1.0); T.sound('titan-inhale'); }
    if (name === 'tame') T.engage(T.playerModel(V(), this.st[1].dur + 0.6, 0.8), 34, this.st[1].dur + this.c.lunge * 0.8, 44);
    if (name === 'active') {
      T.emitAttack(this);
      T.grabReach?.(this.hand);
      this.reached = true;
      T.body.beat(1.4);
      // aim point starts on the predicted player; afterwards it only follows their evasion with limited
      // acceleration (a hard juke escapes it), then locks with an audible crack
      this.V = T.playerModel(V(), this.c.lunge, 0.8);
      this.Vv.set(0, 0, 0);
    }
  }
  plan(P, dt) {
    const T = this.T, s = sideOf(this.hand), A = P.arms[this.hand];
    const st = this.stage;
    if (st === 'hold' || st === 'throw') return this.planExtra(P);
    const S = T.rig.socket('shoulder' + this.hand, V());
    P.head.fast = true;
    if (st === 'telegraph' || st === 'tame') {
      const pm = T.playerModel(V());
      const toP = pm.clone().sub(S).normalize();
      A.wrist.copy(S).add(V(s * 14, 12, -6)).addScaledVector(toP, 4);
      A.palm = toP.clone();
      A.hand = 'splay'; A.gains = 'windup'; A.tremble = st === 'tame' ? 1 : 0;
      A.clav.fwd = -0.15; A.clav.raise = 0.2;
      P.torso.pitch = 10 * D2R; P.torso.yaw = s * 8 * D2R; P.torsoGains = 'windup';
      P.head.pitch = 6 * D2R;
      P.wings.amp = 40 * D2R; P.wings.mid = 12 * D2R;
    } else if (st === 'active') {
      // the reaching hand chases the player with limited acceleration, then locks (the audible crack)
      const lt = this.local;
      if (lt < this.c.lock) {
        const want = T.playerModel(V(), Math.max(0, this.c.lunge - lt), 0.8);
        const acc = want.sub(this.V).multiplyScalar(40).addScaledVector(this.Vv, -12);
        if (acc.length() > 60) acc.setLength(60);
        this.Vv.addScaledVector(acc, dt); this.V.addScaledVector(this.Vv, dt);
      } else if (!this.locked) { this.locked = true; T.sound('titan-crack'); }
      const dir = this.V.clone().sub(S).normalize();
      A.wrist.copy(this.V).addScaledVector(dir, -7.5);
      A.palm = dir;
      A.hand = lt > this.c.lunge - 0.24 ? 'grip' : 'splay';
      A.gains = 'strike'; A.amax = 15; A.wmax = 3.0;
      A.pole.set(s * 0.8, -0.4, -0.5).normalize();
      P.torso.pitch = 18 * D2R; P.torso.yaw = -s * 10 * D2R; P.torsoGains = 'strike';
      P.wings.amp = 60 * D2R;
      P.legs.L.flex = -18 * D2R; P.legs.R.flex = -12 * D2R; P.legs.L.knee = 30 * D2R; P.legs.R.knee = 40 * D2R;
    } else if (st === 'recover') {
      if (!this.caught && this.reached && !this.missed) { this.missed = true; T.grabMissed?.(this.hand); if (T.playerAlive()) T.onMiss?.(this, this.hand); }
      // missed: the open palm hangs forward — the palm crystal is exposed
      A.wrist.copy(S).add(V(s * 6, -14, 26));
      A.palm = V(0, 0.2, 1).normalize();
      A.hand = this.frac < 0.7 ? 'splay' : 'relaxed';
      A.gains = 'idle';
      P.torso.pitch = 6 * D2R;
    }
  }
  tick() {
    const T = this.T;
    // the "now" cue as the reach begins (≥ config.dodge.cue s before the hand can hurt), if she is within its reach
    if (!this.cued && this.t >= this.cueAt && this.stage !== 'recover' && !this.caught) {
      const pm = T.playerModel(V(), 0.5, 0.8);
      const S = T.rig.socket('shoulder' + this.hand, V());
      if (pm.distanceTo(S) < T.config.grabReach + 25) T.strikeCue(this, this.hand, this.live[0] - this.t);
    }
    if (this.dodged && !this.caught) this.hitDone = true;
    if (this.stage === 'active' && !this.caught && !this.dodged && this.local > this.c.lunge - 0.32) {
      const palm = T.handWorld(this.hand, V());
      const n = T.palmNormalWorld(this.hand, V());
      const cap = palm.addScaledVector(n, 5);
      const pp = T.playerPos();
      if (pp && pp.distanceTo(cap) < this.c.captureRadius && T.playerAlive() && !T.playerDodging?.() && T.cueReady(this)) {
        this.caught = true;
        // swap the remaining stages for hold → throw → recover
        const now = this.t, c = this.c;
        this.st = this.st.slice(0, this.si + 1);
        this.st[this.si].t1 = now; this.st[this.si].dur = now - this.st[this.si].t0;
        for (const [name, dur] of [['hold', c.hold], ['throw', c.throw], ['recover', c.recover]]) {
          const t0 = this.st[this.st.length - 1].t1;
          this.st.push({ name, dur, t0, t1: t0 + dur });
        }
        T.grabStart(this.hand);
      }
    }
    if (this.stage === 'hold' || (this.stage === 'throw' && this.local < this.c.release)) T.grabHold(this.hand);
    if (this.stage === 'throw' && !this.thrown && this.local >= this.c.release) {
      this.thrown = true;
      T.grabThrow(this.hand);
    }
    if (!this.hitDone && this.stage === 'active' && this.t >= this.live[0] && !this.caught) {
      if (T.handContact(this.hand, { damage: T.dmg('swat') * 0.6, minSpeed: 30, gate: this })) this.hitDone = true;
    }
  }
  cleanup() {
    if (this.caught && !this.thrown) this.T.grabRelease();
    else if (this.reached && !this.caught && !this.missed) { this.missed = true; this.T.grabMissed?.(this.hand); }
  }
  planExtra(P) {
    const T = this.T, s = sideOf(this.hand), A = P.arms[this.hand];
    if (this.stage === 'hold') {
      A.wrist.set(s * 12, 40, 28);
      A.palm = V(-s * 0.4, 0.5, -0.6).normalize();
      A.hand = 'grip'; A.gains = 'windup';
      P.torso.pitch = 4 * D2R; P.jaw = 0.35 + 0.25 * Math.sin(this.local * 9);
      P.head.lookHand = this.hand;
    } else if (this.stage === 'throw') {
      A.wrist.set(s * 46, 26, 12);
      A.palm = V(s, 0.1, 0.3).normalize();
      A.hand = this.local < this.c.release ? 'grip' : 'splay'; A.gains = 'strike';
      P.torso.yaw = s * 22 * D2R; P.torsoGains = 'strike';
    }
  }
}

// ================================================================================================ CLAP
class Clap extends Attack {
  constructor(T, opts) {
    super(T, 'clap', opts);
    this.hand = 'both';
    const c = T.config.attacks.clap;
    this.c = c;
    this.st = stages([['telegraph', c.windup], ['tame', c.tame], ['active', c.strike, true], ['follow', c.follow, true], ['recover', c.recover]], this.tempo, MIN_TELEGRAPH.melee);
    // (second pass: the earliest burst at +0.2 s, so the cue — from the start of the tame — leads it by ≥ 0.5 s)
    const lead = Math.max(0.2, (T.config.dodge?.cue ?? 0.5) - this.st[1].dur);          // (tame × tempo when enraged)
    this.live = [this.stageStart('active') + lead, this.stageStart('active') + c.strike + 0.1];
  }
  enter(name) {
    const T = this.T;
    if (name === 'telegraph') { T.glint(); T.coreFlare(1.0, 1.8); T.sound('titan-inhale'); }
    if (name === 'tame') this.lockPoint();
    if (name === 'active') { T.emitAttack(this); T.sound('titan-whoosh'); T.body.beat(1.3); }
  }
  lockPoint() {
    const T = this.T;
    const pm = T.playerModel(V(), this.st[2].dur * 0.8 + this.st[1].dur, 0.7);
    const moved = T.engage(pm, 38, this.st[1].dur + this.st[2].dur * 0.7, 36);
    const C = pm.clone();
    C.z -= moved;                                             // model space moves with the lunge
    C.x = clamp(C.x, -14, 14); C.y = clamp(C.y, 8, 58); C.z = clamp(C.z, 26, 44);
    this.C = C;
  }
  plan(P) {
    const T = this.T;
    const st = this.stage;
    P.head.fast = true;
    for (const h of ['L', 'R']) {
      const s = sideOf(h), A = P.arms[h];
      if (st === 'telegraph' || st === 'tame') {
        A.wrist.set(s * 50, 42, -4);
        A.palm = V(-s * 0.35, 0.05, 0.94).normalize();
        A.hand = 'splay'; A.gains = 'windup'; A.tremble = st === 'tame' ? 1 : 0;
        A.pole.set(s * 0.2, -1, -0.5).normalize();
        A.clav.fwd = -0.3; A.clav.raise = 0.12;
      } else if (st === 'active' || st === 'follow') {
        const C = this.C || V(0, 36, 36);
        A.wrist.copy(C).add(V(s * 3.5, 0, -7.5));
        A.palm = V(-s, 0, 0);
        A.hand = 'cast'; A.gains = st === 'active' ? 'strike' : 'follow';
        A.amax = 13; A.wmax = 3.2;
        A.pole.set(s * 1, -0.6, -0.3).normalize();
        A.clav.fwd = 0.3;
      }
    }
    if (st === 'telegraph' || st === 'tame') { P.torso.pitch = -9 * D2R; P.torsoGains = 'windup'; P.wings.mid = 26 * D2R; P.wings.amp = 30 * D2R; }
    if (st === 'active' || st === 'follow') { P.torso.pitch = 10 * D2R; P.torsoGains = 'strike'; P.wings.amp = 55 * D2R; }
  }
  tick() {
    const T = this.T;
    if (!this.cued && this.C && this.t >= this.live[0] - T.config.dodge.cue) {
      const pp = T.playerPos();
      if (pp && pp.distanceTo(T.toWorld(this.C, V())) < this.c.burstRadius + 20) T.strikeCue(this, 'both', this.live[0] - this.t + 0.1);
    }
    if (this.hitDone || this.t < this.live[0] || this.t > this.live[1]) return;
    const a = T.handWorld('L', V()), b = T.handWorld('R', V());
    if (a.distanceTo(b) < this.c.meetDist || this.t > this.live[1] - 0.02) {
      this.hitDone = true;
      const mid = a.add(b).multiplyScalar(0.5);
      const hp0 = T.telemetry.hitsOnPlayer;
      T.airBurst(mid, { radius: this.c.burstRadius, killRadius: this.c.hitRadius, damage: T.dmg('clap'), push: this.c.push, gate: this });
      if (T.telemetry.hitsOnPlayer === hp0 && T.playerAlive()) { this.missed = true; T.onMiss?.(this, 'both'); }
    }
  }
}

// ================================================================================================ LUNGE (a still target)
// 2026-09-25: the titan reads a dragon parked in front of it (titan/camp.js). The coil: wings thrown up and back,
// arms drawn wide, it drifts in on the wings (config.lunge.pre of the way — you see it coming). Then one huge
// downstroke drives the body at the target, stopping `stop` m short, and the hands clap shut where the dragon will be
// (its velocity relative to the titan, λ 0.7). Flying out of its path or a dodge on the flash makes it miss: the usual
// opening (off-balance, the core open — and close by).
class Lunge extends Attack {
  constructor(T, opts) {
    super(T, 'lunge', opts);
    this.hand = 'both';
    const c = T.config.lunge;
    this.c = c;
    this.st = stages([['telegraph', c.windup], ['tame', c.tame], ['active', c.dash, true], ['follow', c.follow, true], ['recover', c.recover]], this.tempo, MIN_TELEGRAPH.melee);
    this.meetT = this.stageStart('active') + c.dash * 0.88;     // the palms meet near the end of the dash
    this.live = [this.meetT - 0.15, this.meetT + 0.3];
  }
  /** The clap is what hurts: the telegraph counts down to it (≈ 2.5 s), not to the start of the dash. */
  timeToLive() { return this.live[0]; }
  enter(name) {
    const T = this.T, c = this.c;
    if (name === 'telegraph') {
      T.glint(); T.coreFlare(1.1, 1.7); T.sound('titan-inhale');
      T.armGlow('L', 0.9); T.armGlow('R', 0.9);
      // the coil drifts it in: `pre` of the way during the windup
      const pm = T.playerModel(V());
      const chest = T.rig.socket('chest', V());
      const d = Math.hypot(pm.x - chest.x, pm.z - chest.z);
      this.pre = clamp((d - c.stop) * c.pre, 0, 90);
      if (this.pre > 1) T.lungeToward(pm, this.pre, this.st[0].dur + this.st[1].dur);
    }
    if (name === 'active') {
      T.emitAttack(this); T.sound('titan-whoosh'); T.sound('titan-gust', { volume: 0.8 });
      // lock the clap point: where the dragon will be at the meet (relative to the titan), then drive the body there
      const lead = this.meetT - this.t;
      const pm = T.playerModel(V(), lead, 0.7);
      const chest = T.rig.socket('chest', V());
      const dirM = V(pm.x - chest.x, 0, pm.z - chest.z);
      const d = dirM.length();
      dirM.divideScalar(Math.max(1e-3, d));
      const moved = clamp(d - c.stop, 0, c.reach);
      if (moved > 0.5) T.lungeToward(pm, moved, c.dash * 0.9);
      // model space moves with the lunge: the target ends up ≈ stop m in front of the chest
      const C = pm.clone().addScaledVector(dirM, -moved);
      C.x = clamp(C.x, -16, 16); C.y = clamp(C.y, 6, 60); C.z = clamp(C.z, 26, 46);
      this.C = C; this.moved = moved;
      T.body.forceBeats(1 / (c.dash * 1.05)); T.body.beat(1.8);
      T.shake(0.45, 1.0);
    }
    if (name === 'follow') T.body.forceBeats(0);
  }
  plan(P) {
    const T = this.T, st = this.stage;
    P.head.fast = true;
    const C = this.C || V(0, 30, 38);
    const u = st === 'active' ? clamp(this.local / this.st[this.si].dur, 0, 1) : st === 'follow' ? 1 : 0;
    for (const h of ['L', 'R']) {
      const s = sideOf(h), A = P.arms[h];
      if (st === 'telegraph' || st === 'tame') {
        // drawn back wide and high, palms forward: the coil
        A.wrist.set(s * 44, 42, -10);
        A.palm = V(-s * 0.3, 0.1, 0.95).normalize();
        A.hand = 'splay'; A.gains = 'windup'; A.tremble = st === 'tame' ? 1 : 0;
        A.pole.set(s * 0.3, -0.9, -0.4).normalize();
        A.clav.fwd = -0.35; A.clav.raise = 0.3;
      } else if (st === 'active' || st === 'follow') {
        if (u < 0.55 && st === 'active') {
          // thrown wide and forward, reaching for it
          A.wrist.set(s * 46, C.y + 6, 24);
          A.palm = V(-s * 0.6, 0, 0.8).normalize();
          A.hand = 'splay'; A.gains = 'strike';
        } else {
          // the clap: the palms meet on the target
          A.wrist.copy(C).add(V(s * 3.5, 0, -7.5));
          A.palm = V(-s, 0, 0);
          A.hand = 'cast'; A.gains = st === 'active' ? 'strike' : 'follow';
          A.amax = 13; A.wmax = 3.2;
        }
        A.pole.set(s, -0.6, -0.3).normalize();
        A.clav.fwd = 0.35; A.clav.raise = 0.05;
      }
    }
    if (st === 'telegraph' || st === 'tame') {
      // wings thrown up and back, torso reared, legs tucked: it gathers itself
      P.wings.mid = 55 * D2R; P.wings.amp = 10 * D2R; P.wings.sweep = -8 * D2R; P.wings.spread = 1;
      P.torso.pitch = -14 * D2R; P.torsoGains = 'windup'; P.head.pitch = -8 * D2R;
      for (const h of ['L', 'R']) { P.legs[h].flex = 30 * D2R; P.legs[h].knee = 40 * D2R; }
      P.body.freqBoost = 1.3;
    } else if (st === 'active') {
      // one huge downstroke and the body rushes, chest first, legs trailing
      P.wings.mid = 6 * D2R; P.wings.amp = 80 * D2R; P.wings.sweep = -20 * D2R; P.wings.spread = 1; P.wings.snap = true;
      P.torso.pitch = 22 * D2R; P.torsoGains = 'strike';
      for (const h of ['L', 'R']) { P.legs[h].flex = -22 * D2R; P.legs[h].knee = 34 * D2R; }
    } else if (st === 'follow') {
      P.torso.pitch = 12 * D2R; P.torsoGains = 'strike'; P.wings.amp = 55 * D2R;
    }
  }
  tick() {
    const T = this.T;
    // (second pass: the cue leads the EARLIEST clap — live[0], the hands may meet before meetT — by config.dodge.cue)
    if (!this.cued && this.C && this.t >= this.live[0] - T.config.dodge.cue) {
      const pp = T.playerPos();
      if (pp && pp.distanceTo(T.toWorld(this.C, V())) < this.c.burstRadius + 30) T.strikeCue(this, 'both', Math.max(0, this.meetT - this.t));
    }
    if (this.hitDone || this.t < this.live[0] || this.t > this.live[1]) return;
    const a = T.handWorld('L', V()), b = T.handWorld('R', V());
    if (a.distanceTo(b) < this.c.meetDist || this.t > this.live[1] - 0.02) {
      this.hitDone = true;
      const mid = a.add(b).multiplyScalar(0.5);
      const hp0 = T.telemetry.hitsOnPlayer;
      T.airBurst(mid, { radius: this.c.burstRadius, killRadius: this.c.hitRadius, damage: T.dmg('lunge'), push: this.c.push, gate: this });
      this.connected = T.telemetry.hitsOnPlayer > hp0;
      if (!this.connected && T.playerAlive()) { this.missed = true; T.onMiss?.(this, 'both'); }
    }
  }
  cleanup() { this.T.body.forceBeats(0); }
}

// ================================================================================================ SLAM
class Slam extends Attack {
  constructor(T, opts) {
    super(T, 'slam', opts);
    this.hand = 'both';
    const c = T.config.attacks.slam;
    this.c = c;
    this.st = stages([['telegraph', c.windup], ['tame', c.tame], ['active', c.strike, true], ['recover', c.recover]], this.tempo, MIN_TELEGRAPH.slam);
    this.live = [this.stageStart('active') + 0.12, this.stageStart('active') + c.strike];
  }
  enter(name) {
    const T = this.T;
    if (name === 'telegraph') { T.glint(); T.armGlow('L', 0.8); T.armGlow('R', 0.8); T.body.rise(this.c.rise, this.st[0].dur); T.sound('titan-inhale'); }
    if (name === 'tame') {
      const pm = T.playerModel(V(), this.st[1].dur + 0.35, 0.6);
      this.P = pm;
      const d = Math.hypot(pm.x, pm.z - 40);
      if (d > 20) T.lungeToward(pm, Math.min(22, d), this.st[1].dur + this.st[2].dur);
    }
    if (name === 'active') { T.emitAttack(this); T.body.rise(-this.c.rise, this.st[2].dur + 0.4); T.sound('titan-whoosh'); }
    if (name === 'recover') { T.slamImpact(T.handWorld('R', V()).add(T.handWorld('L', V())).multiplyScalar(0.5)); }
  }
  plan(P) {
    const st = this.stage;
    P.head.fast = true;
    for (const h of ['L', 'R']) {
      const s = sideOf(h), A = P.arms[h];
      if (st === 'telegraph' || st === 'tame') {
        A.wrist.set(s * 4.2, 76, 4);
        A.palm = V(-s, 0, 0);
        A.hand = 'fist'; A.gains = 'windup'; A.tremble = st === 'tame' ? 1 : 0;
        A.pole.set(s, 0.3, -0.4).normalize();
        A.clav.raise = 0.4; A.clav.fwd = -0.1;
      } else if (st === 'active') {
        A.wrist.set(s * 3.8, -2, 40);
        A.palm = V(-s, 0, 0);
        A.hand = 'fist'; A.gains = 'strike'; A.amax = 11; A.wmax = 3.0;
        A.pole.set(s, -0.2, -0.8).normalize();
        A.clav.raise = -0.1; A.clav.fwd = 0.35;
      } else {
        A.wrist.set(s * 7, this.frac < 0.55 ? 0 : 10, this.frac < 0.55 ? 34 : 24);
        A.palm = V(0, -1, 0.2).normalize();
        A.hand = this.frac < 0.5 ? 'fist' : 'relaxed'; A.gains = 'idle';
      }
    }
    if (st === 'telegraph' || st === 'tame') {
      P.torso.pitch = -12 * D2R; P.torsoGains = 'windup';
      P.wings.mid = 30 * D2R; P.wings.amp = 62 * D2R; P.body.freqBoost = 1.45;
      P.head.pitch = -10 * D2R;
    } else if (st === 'active') {
      P.torso.pitch = 34 * D2R; P.torsoGains = 'strike'; P.hips.pitch = 10 * D2R;
      P.wings.mid = 42 * D2R; P.wings.amp = 18 * D2R;
      for (const h of ['L', 'R']) { P.legs[h].flex = 48 * D2R; P.legs[h].knee = 62 * D2R; }
    } else if (st === 'recover') {
      const bent = this.frac < 0.6;
      P.torso.pitch = bent ? 26 * D2R : 6 * D2R; P.hips.pitch = bent ? 8 * D2R : 0;
      if (bent) for (const h of ['L', 'R']) { P.legs[h].flex = 30 * D2R; P.legs[h].knee = 40 * D2R; }
    }
  }
  tick() {
    const T = this.T;
    // (second pass: the cue leads the earliest hit — live[0] — by config.dodge.cue; it came 0.27 s before it)
    if (!this.cued && this.t >= this.live[0] - T.config.dodge.cue) {
      const pp = T.playerPos(), a0 = T.handWorld('L', V()), b0 = T.handWorld('R', V());
      const m0 = a0.add(b0).multiplyScalar(0.5);
      if (pp && Math.hypot(pp.x - m0.x, pp.z - m0.z) < this.c.column + 30 && m0.y - pp.y > -30) T.strikeCue(this, 'both', this.stageStart('active') + 0.3 - this.t);
    }
    if (this.t > this.live[1] && !this.missChecked) {
      this.missChecked = true;
      if ((!this.hitDone || this.dodged) && !this.connected && T.playerAlive()) { this.missed = true; T.onMiss?.(this, 'both'); }
    }
    if (this.hitDone || this.t < this.live[0] || this.t > this.live[1]) return;
    const a = T.handWorld('L', V()), b = T.handWorld('R', V());
    const mid = a.add(b).multiplyScalar(0.5);
    const pp = T.playerPos();
    if (!pp) return;
    const horiz = Math.hypot(pp.x - mid.x, pp.z - mid.z), below = mid.y - pp.y;
    if (horiz < this.c.column && below > -12 && below < this.c.depth) {
      if (!T.playerDodging?.() && !T.cueReady(this, 'both')) return;         // too soon after its "now" flash
      this.hitDone = true; this.connected = !T.playerDodging?.();
      T.hitPlayer(T.dmg('slam'), mid, V(0, -1, 0), 'swat', 'handR', V(0, -this.c.knock, 0).addScaledVector(V(pp.x - mid.x, 0, pp.z - mid.z).normalize(), 12));
    } else if (this.dodged) this.hitDone = true;
    else if (T.handContact('L', { damage: T.dmg('slam'), minSpeed: 30, gate: this }) || T.handContact('R', { damage: T.dmg('slam'), minSpeed: 30, gate: this })) { this.hitDone = true; this.connected = true; }
  }
}

// ================================================================================================ VOLLEY
class Volley extends Attack {
  constructor(T, opts) {
    super(T, 'volley', opts);
    this.hand = opts.hand || pickHand(T);
    const c = T.config.attacks.volley;
    this.c = c;
    // 2026-09-25: an aimed volley at a still target (titan/camp.js mark): led on the target, faster shots, tighter
    // spacing and no lane at the target, the whole fan in half the time; the HUD line says what to do
    this.aimed = !!opts.aimed;
    const A = T.config.aimed || {};
    this.speed = c.speed * (this.aimed ? A.speed ?? 1.35 : 1);
    this.count = opts.count ?? Math.round(c.count[0] + T.rand() * (c.count[1] - c.count[0]) + (T.enraged ? 1 : 0) + (this.aimed ? A.extra ?? 3 : 0));
    this.st = stages([['telegraph', c.raise], ['tame', c.charge, true], ['active', c.fire * (this.aimed ? A.fire ?? 0.5 : 1), true], ['recover', c.recover]], this.tempo, MIN_TELEGRAPH.projectile);
    this.live = [this.stageStart('active'), this.stageStart('recover')];
    this.shots = [];
    this.fired = 0;
    if (this.aimed) { this.teleText = 'Aimed volley — keep moving!'; this.teleLevel = 1; }
  }
  enter(name) {
    const T = this.T;
    if (name === 'telegraph') { T.glint(); T.sound('titan-charge'); }
    if (name === 'tame') { T.chargePalm(this.hand, this.st[1].dur); T.armWave(this.hand, this.st[1].dur * 0.85); T.rune(this.hand, true); }
    if (name === 'active') { T.emitAttack(this); this.pattern(); }
    if (name === 'recover') { T.rune(this.hand, false); T.chargeStop(this.hand); T.openCore?.('volley'); }   // spent: the core blazes open
  }
  pattern() {
    // Fan centred on where the player is now (λ = 0), spacing wide enough to leave lanes at their distance,
    // one slot removed 12–30° from their bearing so they must move but can reach it.
    const T = this.T;
    const from = T.handWorld(this.hand, V());
    const pp0 = T.playerPos();
    const pp = pp0 ? pp0.clone() : from.clone().add(T.forwardWorld(V()).multiplyScalar(200));
    if (this.aimed && pp0) {
      // led on the target: the intercept of its velocity at the shots' speed (3 fixed-point steps)
      const pv = T.playerVel(V());
      let t = pp.distanceTo(from) / this.speed;
      for (let i = 0; i < 3; i++) t = pp0.clone().addScaledVector(pv, t).distanceTo(from) / this.speed;
      pp.addScaledVector(pv, Math.min(t, 4));
    }
    const toP = pp.clone().sub(from);
    const D = Math.max(60, toP.length());
    const fwd = toP.normalize();
    const lat = V().crossVectors(fwd, Yp).normalize();
    const tilt = (T.rand() - 0.5) * 40 * D2R;
    const axis = V().crossVectors(lat.clone().applyAxisAngle(fwd, tilt), fwd).normalize();
    const rb = this.c.radius, rp = 3;
    const dTheta = this.aimed ? Math.max((T.config.aimed?.spacing ?? 3.6) * D2R, (2 * rb + 2 * rp + 2) / D) : Math.max(5.5 * D2R, (2 * rb + 2 * rp + 7) / D);
    const n = this.count + 1;
    // the lane: 12–30° off the player's bearing — for an aimed volley only at the fan's edge (none at the target)
    const gapAt = (T.rand() < 0.5 ? -1 : 1) * (this.aimed ? Math.floor(n / 2) : clamp(Math.round((16 * D2R) / dTheta), 1, Math.floor(n / 2)));
    const center = (n - 1) / 2;
    this.shots = [];
    for (let i = 0; i < n; i++) {
      const k = Math.round(i - center);
      if (k === gapAt) continue;
      this.shots.push(fwd.clone().applyAxisAngle(axis, (i - center) * dTheta));
    }
    this.fireInterval = this.st[2].dur / Math.max(1, this.shots.length);
    // far targets: the shots live long enough to arrive (drag slows them ~15 % over 400 m)
    this.life = clamp(D / this.speed * 1.25 + 1.2, this.c.life, 10);
    this.nextShot = 0;
  }
  plan(P) {
    const T = this.T, s = sideOf(this.hand), A = P.arms[this.hand];
    const st = this.stage;
    const S = T.rig.socket('shoulder' + this.hand, V());
    const pm = T.playerModel(V());
    const toP = pm.sub(S).normalize();
    const behind = toP.z < 0.2 ? clamp(Math.atan2(toP.x, Math.max(0.05, toP.z)), -0.7, 0.7) : 0;   // twist toward a player behind
    if (toP.z < 0.2) { toP.z = 0.2; toP.normalize(); }
    if (st === 'telegraph' || st === 'tame' || st === 'active') {
      const recoil = st === 'active' ? Math.sin(Math.min(1, (this.t - this.lastShotT || 9) / 0.09) * Math.PI) * -3 : 0;
      A.wrist.copy(S).addScaledVector(toP, (st === 'telegraph' ? 24 : 31) + recoil).add(V(0, 3, 0));
      A.palm = toP.clone();
      A.hand = 'cast'; A.gains = st === 'active' ? 'strike' : 'windup'; A.tremble = st === 'tame' ? 0.6 : 0;
      A.pole.set(s, -0.8, -0.4).normalize();
      A.clav.fwd = 0.2;
      P.torso.yaw = s * 10 * D2R + behind; P.torso.pitch = 3 * D2R;
      // the other hand braces the casting arm's power at the chest
      const o = this.hand === 'L' ? 'R' : 'L';
      P.arms[o].wrist.set(-s * 10, 22, 22); P.arms[o].hand = 'claw'; P.arms[o].palm = V(s * 0.3, 0, 1).normalize();
    }
    P.head.fast = true;
  }
  tick(dt) {
    const T = this.T;
    if (this.stage !== 'active') return;
    while (this.fired < this.shots.length && this.local >= this.nextShot) {
      const dir = this.shots[this.fired++];
      this.nextShot += this.fireInterval;
      this.lastShotT = this.t;
      T.shoot(this.hand, dir, { speed: this.speed, radius: this.c.radius, damage: T.dmg('fireball'), drag: this.c.drag, life: this.life || this.c.life });
    }
  }
  cleanup() { this.T.rune(this.hand, false); this.T.chargeStop(this.hand); }
}

// ================================================================================================ GUST
class Gust extends Attack {
  constructor(T, opts, name = 'gust', c = T.config.attacks.gust) {
    super(T, name, opts);
    this.hand = 'wings';
    this.c = c;
    this.st = stages([['telegraph', c.windup], ['tame', c.tame], ['active', c.strike, true], ['recover', c.recover]], this.tempo, MIN_TELEGRAPH.slam);
    this.live = [this.stageStart('active') + 0.12, this.stageStart('recover')];
  }
  enter(name) {
    const T = this.T;
    if (name === 'telegraph') { T.glint(); T.windLines('in', this.st[0].dur + this.st[1].dur); T.sound('titan-inhale'); }
    if (name === 'active') { T.emitAttack(this); T.body.forceBeats(2 / this.c.strike, this.c.strike); T.windLines('out', this.c.strike + 0.6); T.gustStart(this.c); T.sound('titan-gust'); }
    if (name === 'recover') { T.body.forceBeats(0); T.gustEnd(); }
  }
  plan(P) {
    const st = this.stage;
    for (const h of ['L', 'R']) {
      const s = sideOf(h), A = P.arms[h];
      if (st !== 'recover') { A.wrist.set(s * 9, 26, 17); A.palm = V(-s * 0.7, 0, -0.7).normalize(); A.hand = 'fist'; A.gains = 'windup'; }
    }
    if (st === 'telegraph' || st === 'tame') {
      P.wings.mid = 58 * D2R; P.wings.sweep = 28 * D2R; P.wings.amp = 6 * D2R; P.wings.tilt = 20 * D2R; P.wings.spread = 1;
      P.torso.pitch = -9 * D2R; P.torsoGains = 'windup'; P.head.pitch = -6 * D2R;
      for (const h of ['L', 'R']) P.legs[h].flex = 26 * D2R;
    } else if (st === 'active') {
      P.wings.mid = 5 * D2R; P.wings.sweep = 12 * D2R; P.wings.amp = 78 * D2R; P.wings.tilt = 32 * D2R; P.wings.spread = 1; P.wings.snap = true;
      P.torso.pitch = 7 * D2R; P.torsoGains = 'strike';
      for (const h of ['L', 'R']) { P.legs[h].flex = -10 * D2R; P.legs[h].knee = 18 * D2R; }
    }
  }
  tick(dt) { if (this.stage === 'active') this.T.gustPush(dt, this.c); }
  cleanup() { this.T.body.forceBeats(0); this.T.gustEnd(); }
}

// ================================================================================================ WING BUFFET (a still target, close)
// Second pass (the verifier's breath camper: parked 25–70 m in front of the core, dodging every blow on the flash). The
// gust's two forward beats in a wider cone, harder: a hover in breath range is thrown out of it (Δv ≤ buffet.maxDv),
// and the blast front costs buffet.damage × swat within buffet.hurt m (i-frames stop the damage, not the wind). No
// "now" flash — Q / E cannot beat wind; the telegraph says what does: fly clear, or dive under it.
class Buffet extends Gust {
  constructor(T, opts) {
    const B = T.config.buffet, g = T.config.attacks.gust;
    // from the core along the axis it aims at her (locked as the wings come down); up close nothing ducks under a
    // downstroke (a hover sits below the core: the titan holds its pelvis ≈ 32 m under her — the gust's −25° rule
    // let 3 of 4 buffets miss the verifier's breath camper)
    super(T, opts, 'buffet', { ...g, halfAngle: B.halfAngle, push: B.push, maxDv: B.maxDv, dragTo: B.dragTo, strike: B.blow ?? g.strike,
      windup: B.windup ?? g.windup, tame: B.tame ?? g.tame, origin: 'core', below: -90, axis: V() });
    this.B = B;
    this.blastT = this.stageStart('active') + 0.12;
  }
  /** The wings are aimed at her: core → player, at most 70° off the titan's forward (it turns toward her anyway). */
  aim() {
    const T = this.T, pp = T.playerPos(), core = T.socket('core', V()), f = T.forwardWorld(V());
    if (!pp || !core) { this.c.axis.copy(f); return; }
    const d = pp.clone().sub(core).normalize();
    const ang = d.angleTo(f), max = 70 * D2R;
    this.c.axis.copy(ang > max ? f.clone().lerp(d, max / ang).normalize() : d);
  }
  enter(name) {
    if (name === 'active') this.aim();
    super.enter(name);
  }
  tick(dt) {
    const T = this.T;
    if (this.stage === 'tame') this.aim();
    // the "now" flash ≈ cue s before the blast front: Q / E then keeps the damage off (the wind still throws her)
    if (!this.cued && this.t >= this.blastT - T.config.dodge.cue && this.stage !== 'recover') {
      const pp = T.playerPos(), core = T.socket('core', V());
      if (pp && core && pp.distanceTo(core) < this.B.hurt + 20) T.strikeCue(this, 'both', Math.max(0, this.blastT - this.t));
    }
    super.tick(dt);
    if (this.stage !== 'active' || this.t < this.blastT) return;
    // stone grit in the wind: buffet.damage × swat per second while she is in the cone within buffet.hurt m
    const pp = T.playerPos(), core = T.socket('core', V());
    if (!pp || !core) return;
    const d = pp.clone().sub(core), dist = d.length();
    if (dist > this.B.hurt || dist < 1) return;
    d.divideScalar(dist);
    if (d.dot(this.c.axis) < Math.cos(this.c.halfAngle * D2R) || Math.asin(clamp(d.y, -1, 1)) < this.c.below * D2R) return;
    const k = 1 - 0.5 * smoothstep(this.B.hurt * 0.6, this.B.hurt, dist);
    this.acc = (this.acc || 0) + T.dmg('buffet') * k * dt;
    if (this.acc >= 7 || !this.hitDone) {                 // the blast front, then packets of ≈ 7 HP
      const amt = this.acc; this.acc = 0;
      const first = !this.hitDone; this.hitDone = true;
      const done = T.grit(amt, pp, d, 'wing' + (T.playerModel(V()).x >= 0 ? 'L' : 'R'));
      if (first) { T.shake(0.5, 0.7); try { T.vfx?.dust(pp, 3, 10, 0.6); } catch { /* optional */ } }
      if (done > 0) { const tel = T.telemetry.camp; if (tel) tel.buffetHits = (tel.buffetHits || 0) + (first ? 1 : 0), tel.buffetDmg = (tel.buffetDmg || 0) + done; }
    }
  }
}

// ================================================================================================ METEOR RAIN
class Meteor extends Attack {
  constructor(T, opts) {
    super(T, 'meteor', opts);
    this.hand = 'both';
    const c = T.config.attacks.meteor;
    this.c = c;
    this.st = stages([['telegraph', c.windup], ['active', 0.6, true], ['recover', c.recover]], this.tempo, MIN_TELEGRAPH.pattern);
    this.live = [this.stageStart('active') + c.flight - 0.2, this.stageStart('active') + c.flight + 1];
  }
  enter(name) {
    const T = this.T;
    if (name === 'telegraph') { T.glint(); T.coreFlare(1.2, this.st[0].dur); T.roar(0.6); T.meteorOrbs(this.st[0].dur); }
    if (name === 'active') { T.emitAttack(this); this.launch(); }
  }
  launch() {
    const T = this.T, c = this.c;
    const pp = T.playerPos();
    if (!pp) return;
    const pv = T.playerVel(V());
    const center = pp.clone().addScaledVector(pv, c.flight * 0.6);
    center.y = pp.y;
    const cnt = this.opts.count || c.count;
    const n = Math.round(cnt[0] + T.rand() * (cnt[1] - cnt[0]));
    // hex grid around the predicted point; one guaranteed empty cell adjacent to the player (never under them)
    const cells = [];
    const sp = c.spacing;
    for (let q = -2; q <= 2; q++) for (let r = -2; r <= 2; r++) {
      if (Math.abs(q + r) > 2) continue;
      cells.push(V(center.x + sp * (q + r * 0.5), center.y, center.z + sp * r * 0.866));
    }
    cells.sort((a, b) => a.distanceTo(pp) - b.distanceTo(pp));
    const safe = 1 + Math.floor(T.rand() * 3);            // one of the nearest ring cells stays empty
    const targets = cells.filter((_, i) => i !== safe).slice(0, n);
    this.safeCell = cells[safe];
    const g = c.gravity, Tf = c.flight;
    const top = T.body.pos.clone().add(V(0, c.height, 0));
    targets.forEach((tgt, i) => {
      const from = top.clone().add(V((T.rand() - 0.5) * 90, T.rand() * 40, (T.rand() - 0.5) * 90));
      const v0 = tgt.clone().sub(from).sub(V(0, -0.5 * g * Tf * Tf, 0)).divideScalar(Tf);
      T.shootFrom(from, v0, { gravity: g, radius: c.radius, damage: T.dmg('meteor'), life: Tf + 1.5, delay: i * 0.06, marker: tgt, markerTime: Tf });
    });
  }
  plan(P) {
    const st = this.stage;
    for (const h of ['L', 'R']) {
      const s = sideOf(h), A = P.arms[h];
      if (st === 'telegraph' || st === 'active') {
        A.wrist.set(s * 22, 70, 6);
        A.palm = V(-s * 0.3, 1, 0.1).normalize();
        A.hand = 'splay'; A.gains = 'windup'; A.tremble = 0.5;
        A.pole.set(s, -0.4, -0.6).normalize(); A.clav.raise = 0.35;
      }
    }
    if (st === 'telegraph' || st === 'active') { P.torso.pitch = -10 * D2R; P.head.pitch = -28 * D2R; P.jaw = 0.8; P.wings.mid = 25 * D2R; P.wings.spread = 1; }
  }
  tick() {}
}

// ================================================================================================ ROAR (breather)
class Roar extends Attack {
  constructor(T, opts) {
    super(T, 'roar', opts);
    this.hand = null;
    const c = T.config.attacks.roar;
    this.st = stages([['telegraph', 0.5], ['active', c.duration, true], ['recover', 0.8]], 1, 0);
    this.quiet = true;
  }
  begin() { this.enter('telegraph'); }                     // no damage: no telegraph event
  enter(name) { if (name === 'active') { this.T.roar(1.0); this.T.coreFlare(1.3, 2.2); } }
  plan(P) {
    const st = this.stage;
    for (const h of ['L', 'R']) {
      const s = sideOf(h), A = P.arms[h];
      if (st === 'active') { A.wrist.set(s * 34, 8, 14); A.palm = V(0, -0.2, 1).normalize(); A.hand = 'claw'; A.gains = 'windup'; A.tremble = 1; A.clav.raise = 0.25; }
    }
    if (st === 'active') {
      P.head.pitch = -30 * D2R; P.jaw = 1.0; P.torso.pitch = -12 * D2R; P.torsoGains = 'windup';
      P.wings.mid = 34 * D2R; P.wings.spread = 1; P.wings.amp = 40 * D2R;
      for (const h of ['L', 'R']) { P.legs[h].abd = 10 * D2R; P.legs[h].flex = 4 * D2R; }
    }
  }
  tick() {}
}

// ================================================================================================ CALL (phase 2+)
// One hand thrown up to the sky, palm open with a burning rune, a roar: the titan summons its Shade Riders. No
// damage, so no telegraph event; 'titan:call' { count } goes out at the peak for the director.
class Call extends Attack {
  constructor(T, opts) {
    super(T, 'call', opts);
    this.hand = opts.hand || (T.playerModel(V()).x >= 0 ? 'R' : 'L');     // the hand away from the player
    const d = T.config.call?.duration ?? 2.4;
    this.st = stages([['telegraph', 0.55], ['active', d - 1.05, true], ['recover', 0.5]], 1, 0);
    this.quiet = true;
  }
  begin() { this.enter('telegraph'); }
  enter(name) {
    const T = this.T;
    if (name === 'telegraph') { T.glint(); T.rune(this.hand, true); T.armWave(this.hand, 0.55, 1); }
    if (name === 'active') {
      T.roar(0.9); T.coreFlare(1.4, 1.6);
      const p = T.handWorld(this.hand, V());
      T.vfx?.ring(p, V(0, 1, 0), 6, 140, 1.4, 0xffc040, 0.9, false);
      T.vfx?.ring(p.clone().add(V(0, 20, 0)), V(0, 1, 0), 4, 90, 1.1, 0xe02030, 0.8, false);
      T.emitCall?.(p);
    }
    if (name === 'recover') T.rune(this.hand, false);
  }
  plan(P) {
    const st = this.stage, s = sideOf(this.hand), A = P.arms[this.hand];
    if (st === 'telegraph' || st === 'active') {
      A.wrist.set(s * 16, 84, 10);
      A.palm = V(0, 1, 0.15).normalize();
      A.hand = 'splay'; A.gains = st === 'telegraph' ? 'strike' : 'windup'; A.tremble = st === 'active' ? 0.6 : 0;
      A.pole.set(s, -0.2, -0.6).normalize(); A.clav.raise = 0.4;
      const o = P.arms[this.hand === 'L' ? 'R' : 'L'];
      o.wrist.set(-s * 30, 18, 20); o.hand = 'claw';
      P.head.pitch = -24 * D2R; P.jaw = st === 'active' ? 1 : 0.3; P.torso.pitch = -8 * D2R; P.torso.roll = -s * 6 * D2R;
      P.wings.mid = 30 * D2R; P.wings.amp = 44 * D2R; P.wings.spread = 1;
      P.head.lookHand = null;
    }
  }
  tick() {}
  cleanup() { this.T.rune(this.hand, false); }
}

const REGISTRY = { swat: Swat, grab: Grab, clap: Clap, lunge: Lunge, slam: Slam, volley: Volley, gust: Gust, buffet: Buffet, meteor: Meteor, roar: Roar, call: Call };
export const ATTACKS = Object.keys(REGISTRY);
export function createAttack(name, T, opts = {}) {
  const C = REGISTRY[name];
  return C ? new C(T, opts) : null;
}
