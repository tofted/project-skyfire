// Titan rig: physics in-betweens between authored key poses (titan-boss.md §4).
//   • Canonical skeleton = the procedural titan (T-pose, palms down, wings spread along ±X). Any model with the
//     contract bone names is aligned to it per bone (A), so the same rig drives the GLB whatever its rest pose.
//   • Arms: plan wrist targets → analytic two-bone IK (soft reach, elbows out/back) → joint targets written into a
//     ring buffer → shoulder, elbow, wrist and fingers read them with growing delays (proximal leads, distal
//     lags) → torque/velocity-limited PD joints (slow start, fast mid-swing, overshoot, settle).
//   • Torso reacts to arm accelerations (Newton's third law), legs are damped double pendulums under the pelvis
//     acceleration, the head tracks with lag, wings follow the body's flap phase with a travelling wave.
// Everything here is in titan model space (metres, +Y up, +Z forward, +X = titan's left).
import * as THREE from 'three';
import { clamp } from '../../core/util.js';
import { canonicalBones, FINGERS, FINGER_NAMES, PRIMARIES } from './model.js';
import { DOWN_FRACTION } from './body.js';

const D2R = Math.PI / 180;
const V = () => new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _v1 = V(), _v2 = V(), _v3 = V(), _v4 = V(), _v5 = V();
const _m1 = new THREE.Matrix4(), _m2 = new THREE.Matrix4();
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);

/** Rotation taking the orthonormal frame (a0, b0) onto (a1, b1) (b is orthogonalised against a). */
const _ax = V(), _ay = V(), _az = V(), _am1 = new THREE.Matrix4(), _am2 = new THREE.Matrix4();
export function alignFrames(a0, b0, a1, b1, out = new THREE.Quaternion()) {
  const basis = (a, b, m) => {
    _ax.copy(a).normalize();
    _ay.copy(b).addScaledVector(_ax, -b.dot(_ax)).normalize();
    _az.crossVectors(_ax, _ay);
    return m.makeBasis(_ax, _ay, _az);
  };
  basis(a0, b0, _am1); basis(a1, b1, _am2);     // inputs are read before the temps are reused
  _am2.multiply(_am1.transpose());
  return out.setFromRotationMatrix(_am2);
}
const axisAngle = (axis, ang, out = new THREE.Quaternion()) => out.setFromAxisAngle(axis, ang);
const mirrorAxis = (a, s) => (s > 0 ? a.clone() : new THREE.Vector3(a.x, -a.y, -a.z));

/** Torque-limited PD on a rotation (q relative to its parent frame, w in that frame). */
export class QuatPD {
  constructor() { this.q = new THREE.Quaternion(); this.w = V(); this.acc = V(); }
  step(target, dt, wn, zeta, amax, wmax, ext = null) {
    _q1.copy(target).multiply(_q2.copy(this.q).invert());
    if (_q1.w < 0) { _q1.x = -_q1.x; _q1.y = -_q1.y; _q1.z = -_q1.z; _q1.w = -_q1.w; }
    const s = Math.sqrt(Math.max(0, 1 - _q1.w * _q1.w));
    const ang = 2 * Math.atan2(s, _q1.w);
    const e = _v4.set(_q1.x, _q1.y, _q1.z);
    if (s > 1e-6) e.multiplyScalar(ang / s); else e.set(0, 0, 0);
    const a = this.acc.copy(e).multiplyScalar(wn * wn).addScaledVector(this.w, -2 * zeta * wn);
    if (ext) a.add(ext);
    const al = a.length();
    if (al > amax) a.multiplyScalar(amax / al);
    this.w.addScaledVector(a, dt);
    const wl = this.w.length();
    if (wl > wmax) this.w.multiplyScalar(wmax / wl);
    const wl2 = this.w.length();
    if (wl2 > 1e-9) { _q3.setFromAxisAngle(_v5.copy(this.w).divideScalar(wl2), wl2 * dt); this.q.premultiply(_q3).normalize(); }
    return this.q;
  }
  snap(q) { this.q.copy(q); this.w.set(0, 0, 0); }
}

/** Torque-limited PD on a scalar. */
export class ScalarPD {
  constructor(x = 0) { this.x = x; this.v = 0; this.a = 0; }
  step(target, dt, wn, zeta, amax = Infinity, vmax = Infinity, ext = 0) {
    let a = wn * wn * (target - this.x) - 2 * zeta * wn * this.v + ext;
    a = clamp(a, -amax, amax);
    this.a = a;
    this.v = clamp(this.v + a * dt, -vmax, vmax);
    this.x += this.v * dt;
    return this.x;
  }
  snap(x) { this.x = x; this.v = 0; }
}

// Joint gains [ωn, ζ, α_max, ω_max] per schedule (titan-boss.md §4.5 table, tuned on screenshots).
export const GAINS = {
  idle: { ua: [2.2, 0.9, 4, 1.0], bend: [2.6, 0.9, 6, 1.4], wrist: [4, 0.8, 12, 3], finger: [10, 0.7, 50, 8], clav: [2, 0.8, 3, 1.0] },
  windup: { ua: [2.8, 0.8, 3.5, 1.1], bend: [3.2, 0.8, 6, 1.5], wrist: [5, 0.75, 14, 3], finger: [14, 0.7, 60, 10], clav: [2.5, 0.8, 3, 1.0] },
  strike: { ua: [6.5, 0.5, 13, 2.6], bend: [7, 0.45, 18, 3.4], wrist: [10, 0.45, 30, 6], finger: [16, 0.6, 60, 10], clav: [3.5, 0.6, 5, 1.6] },
  follow: { ua: [4.5, 0.4, 12, 3.0], bend: [5.5, 0.4, 16, 3.6], wrist: [8, 0.45, 25, 5], finger: [14, 0.6, 60, 10], clav: [3, 0.6, 4, 1.4] },
  limp: { ua: [0.9, 0.35, 4, 2.6], bend: [1.1, 0.35, 5, 3.0], wrist: [1.6, 0.35, 8, 4], finger: [4, 0.4, 20, 6], clav: [0.8, 0.4, 2, 1] },
};
// Delays (s) at which each joint reads the target history: torso leads, fingers trail.
const DELAY = { ua: 0.12, bend: 0.2, wrist: 0.28, finger: 0.34 };
const RIPPLE = { thumb: 0.02, index: 0.0, middle: 0.06, ring: 0.1, pinky: 0.14 };
const KF = { thumb: 1, index: 0.85, middle: 1, ring: 1.08, pinky: 1.15 };
const SPREAD = { thumb: 0, index: 11, middle: 2, ring: -7, pinky: -15 };

/** Finger pose library: curl per finger [thumb, index, middle, ring, pinky], spread, thumb opposition, claw. */
export const HAND_POSES = {
  relaxed: { curl: [0.22, 0.24, 0.3, 0.36, 0.42], spread: 0.15, opp: 0.3, claw: 0 },
  splay: { curl: [-0.1, -0.14, -0.12, -0.1, -0.06], spread: 1, opp: -0.25, claw: 0 },
  claw: { curl: [0.2, 0.22, 0.24, 0.26, 0.3], spread: 0.6, opp: 0.3, claw: 0.75 },
  cup: { curl: [0.28, 0.32, 0.36, 0.4, 0.44], spread: 0.05, opp: 0.75, claw: 0.1 },
  fist: { curl: [0.85, 1.0, 1.02, 1.04, 1.06], spread: 0, opp: 1.0, claw: 0 },
  cast: { curl: [0.02, 0.06, 0.05, 0.08, 0.12], spread: 0.65, opp: 0.05, claw: 0 },
  grip: { curl: [0.62, 0.68, 0.7, 0.72, 0.75], spread: 0, opp: 0.9, claw: 0.3 },
  point: { curl: [0.6, -0.05, 0.95, 1.0, 1.02], spread: 0.1, opp: 0.8, claw: 0 },
};

// Wing poses per segment (wing1 → wing2, wing2 → wing3, wing3 → wing4, wing4 → tip): direction and feather chord
// (trailing edge), left side, body frame. Closed = the concept's raised V with the flight feathers hanging;
// spread = hover mid-stroke (≈ 260 m span); up = wings raised high over the back (gust windup, death fall).
const nv = (x, y, z) => new THREE.Vector3(x, y, z).normalize();
const WING_CLOSED = [
  { d: nv(0.82, 0.25, -0.43), c: nv(0, -1, -0.35) }, { d: nv(0.72, 0.59, -0.35), c: nv(0.3, -1, -0.25) },
  { d: nv(0.52, 0.85, 0.01), c: nv(0.55, -0.5, -0.5) }, { d: nv(0.18, -0.98, -0.08), c: nv(0.1, 0, -1) },
];
// Spread chords lean down as well as back: the feathers face forward a little, as in the key art (anime first —
// a purely backward chord shows the player only a thin leading edge from the front).
const WING_SPREAD = [
  { d: nv(0.86, 0.12, -0.48), c: nv(0, -0.5, -0.87) }, { d: nv(0.97, 0.16, -0.1), c: nv(0, -0.55, -0.84) },
  { d: nv(0.96, 0.2, 0.14), c: nv(-0.1, -0.55, -0.83) }, { d: nv(0.95, 0.02, -0.3), c: nv(-0.3, -0.45, -0.84) },
];
const WING_UP = [
  { d: nv(0.6, 0.6, -0.5), c: nv(0, -0.3, -1) }, { d: nv(0.5, 0.85, -0.1), c: nv(0.2, -0.3, -1) },
  { d: nv(0.3, 0.95, 0.05), c: nv(0.3, -0.2, -1) }, { d: nv(0.25, 0.9, -0.3), c: nv(0.1, -0.3, -1) },
];

// GLB wings (assets/models/README_humanoids.md, "Bind-pose bone axes"): the feathers are a slab in the frontal plane
// behind the back; per bone, local +X = flap in the wing plane (downstroke sense, the same sign on both sides),
// local Z = sweep out of the plane (mirror: negate on the right), local Y = feather twist (mirror). wing4 carries the
// whole primary fan and counter-rotates (−X fans it out), so the primaries never swing under the body.
// Beat key poses, wing1..wing4 about local X (deg): top of the upstroke, mid-downstroke, end of the downstroke. The
// README's tested glide / downstroke poses (28/22/12/−62, 55/10/0/−80) keep the fan hanging, which reads narrow
// from the chase camera (qa/titan/wave2/tune/poses.png), so the beat keeps the primaries fanned out (−88…−95: a
// 250 m span, as in the key art) and lets the arm part (wing1–3) do the stroke; on the upstroke the hand folds
// (wing4 toward the README's +15). Each bone follows a quadratic through the three key poses in the normalised
// stroke position s (+1 = top, 0 = mid, −1 = bottom), extended linearly past them so there is never a kink.
const GLB_WING_POSES = { up: [-8, -5, 0, -95], glide: [15, 8, 2, -92], down: [40, 26, 12, -88] };
const GLB_WING_CURVES = [0, 1, 2, 3].map((i) => {
  const u = GLB_WING_POSES.up[i], g = GLB_WING_POSES.glide[i], d = GLB_WING_POSES.down[i];
  return { g, b: (u - d) / 2, c: (u + d) / 2 - g };
});
/** Local-X angle (deg) of wing bone i at normalised stroke position s. */
export function glbWingAngle(i, s) {
  const C = GLB_WING_CURVES[i];
  const f = (x) => C.g + C.b * x + C.c * x * x;
  if (s > 1) return f(1) + (C.b + 2 * C.c) * (s - 1);
  if (s < -1) return f(-1) + (C.b - 2 * C.c) * (s + 1);
  return f(s);
}
const WING_STROKE_REF = 50 * D2R;       // plan mid + amp·stroke of this size reaches a key pose

function makeHist(n) {
  return Array.from({ length: n }, () => ({ ua: new THREE.Quaternion(), bend: 0.3, twist: 0, wrist: new THREE.Quaternion(), curl: [0, 0, 0, 0, 0], spread: 0, opp: 0, claw: 0 }));
}

export class TitanRig {
  constructor(model, { fixedDt = 1 / 120 } = {}) {
    this.model = model;
    this.dt = fixedDt;
    const canon = canonicalBones();
    const root = model.root;
    root.updateMatrixWorld(true);
    const inv = _m1.copy(root.matrixWorld).invert().clone();
    const joints = [];
    const byName = new Map();
    root.traverse((o) => {
      if (!o.isBone) return;
      const M = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
      const P0 = V(), R0 = new THREE.Quaternion(), S0 = V();
      M.decompose(P0, R0, S0);
      const parent = o.parent?.isBone ? byName.get(o.parent.name) : null;
      let Rpn = null;
      if (!parent && o.parent) { const Mp = new THREE.Matrix4().multiplyMatrices(inv, o.parent.matrixWorld); const t = V(), r = new THREE.Quaternion(), sc = V(); Mp.decompose(t, r, sc); Rpn = r; }
      const j = { name: o.name, bone: o, parent, P0, R0, q0: o.quaternion.clone(), Rpn: Rpn || new THREE.Quaternion(), A: new THREE.Quaternion(), D: new THREE.Quaternion(), Gc: new THREE.Quaternion(), G: new THREE.Quaternion(), P: P0.clone(), canon: canon.get(o.name) || null };
      joints.push(j); byName.set(o.name, j);
    });
    this.joints = joints; this.byName = byName;
    this.J = (n) => byName.get(n) || null;
    this.canon = canon;
    const cpos = (n) => canon.get(n)?.pos;

    // ---- per-bone alignment to the canonical skeleton ----
    const align = (name, childName, second, secondCanon) => {
      const j = this.J(name), c = this.J(childName);
      if (!j || !c || !cpos(name) || !cpos(childName)) return;
      const u0 = _v1.subVectors(c.P0, j.P0).clone(), uc = V().subVectors(cpos(childName), cpos(name));
      if (u0.lengthSq() < 1e-6 || uc.lengthSq() < 1e-6) return;
      alignFrames(u0, second(j, u0), uc, secondCanon ?? second(j, uc, true), j.A);
      j.aligned = true;
    };
    for (const s of ['_L', '_R']) {
      const side = s === '_L' ? 1 : -1;
      align('upperarm' + s, 'forearm' + s, () => new THREE.Vector3(0, 0, -1));
      align('forearm' + s, 'hand' + s, () => new THREE.Vector3(0, 0, -1));
      // Hand: long axis to the middle knuckle, secondary = palm normal (from the index→pinky spread).
      const palmN = (useCanon) => {
        const g = (n) => (useCanon ? cpos(n + s) : this.J(n + s)?.P0);
        const h = g('hand'), m = g('middle1'), i = g('index1'), p = g('pinky1');
        if (!h || !m || !i || !p) return new THREE.Vector3(0, -1, 0);
        const f = V().subVectors(m, h).normalize();
        const a = V().subVectors(i, p); a.addScaledVector(f, -a.dot(f)).normalize();
        return V().crossVectors(a.negate(), f).multiplyScalar(side).normalize();
      };
      if (this.J('middle1' + s)) {
        const j = this.J('hand' + s);
        if (j) {
          alignFrames(V().subVectors(this.J('middle1' + s).P0, j.P0), palmN(false), V().subVectors(cpos('middle1' + s), cpos('hand' + s)), palmN(true), j.A);
          j.aligned = true;
        }
      }
      // Fingers: every segment aligned to the canonical straight finger (curl 0 = straight, whatever the rest curl)
      if (this.J('middle1' + s)) {
        const nA = palmN(false), nC = palmN(true);
        for (const f of FINGER_NAMES) {
          for (let k = 1; k <= 3; k++) {
            const j = this.J(`${f}${k}${s}`); if (!j) continue;
            const nx = this.J(`${f}${k + 1}${s}`), pv = this.J(`${f}${k - 1}${s}`);
            const u0 = nx ? V().subVectors(nx.P0, j.P0) : (pv ? V().subVectors(j.P0, pv.P0) : null);
            const cN = cpos(`${f}${k}${s}`), cX = cpos(`${f}${k + 1}${s}`), cP = cpos(`${f}${k - 1}${s}`);
            const uc = cX ? V().subVectors(cX, cN) : (cP ? V().subVectors(cN, cP) : null);
            if (!u0 || !uc || u0.lengthSq() < 1e-6) continue;
            alignFrames(u0, nA, uc, nC, j.A);
            j.aligned = true;
          }
        }
      }
      align('thigh' + s, 'shin' + s, () => new THREE.Vector3(0, 0, 1));
      align('shin' + s, 'foot' + s, () => new THREE.Vector3(0, 0, 1));
      align('foot' + s, 'toe' + s, () => new THREE.Vector3(0, -1, 0));
      // Wings are posed by aiming each segment from its own rest (direction, feather chord): no alignment.
      for (let k = 1; k <= 4; k++) { const w = this.J(`wing${k}${s}`); if (w) { w.A.identity(); w.aligned = true; } }
    }
    // Unaligned bones inherit their parent's alignment (so an undriven child follows rigidly).
    for (const j of joints) if (!j.aligned && j.parent) j.A.copy(j.parent.A);

    // ---- chains ----
    this.arms = { L: this.makeArm(1), R: this.makeArm(-1) };
    this.legs = { L: this.makeLeg(1), R: this.makeLeg(-1) };
    this.wings = { L: this.makeWing(1), R: this.makeWing(-1) };
    this.torso = { yaw: new ScalarPD(), pitch: new ScalarPD(), roll: new ScalarPD(), hipYaw: new ScalarPD(), hipPitch: new ScalarPD() };
    this.head = { yaw: new ScalarPD(), pitch: new ScalarPD(), roll: new ScalarPD(), jaw: new ScalarPD() };
    this.cloth = ['F', 'B'].map((k) => ({ k, bones: [1, 2, 3].map((i) => this.J(`cloth_${k}${i}`)), th: [new ScalarPD(), new ScalarPD(), new ScalarPD()], rl: new ScalarPD() }));
    this.wingParams = { amp: new ScalarPD(50 * D2R), mid: new ScalarPD(8 * D2R), fold: new ScalarPD(0), sweep: new ScalarPD(0), tilt: new ScalarPD(0), spread: new ScalarPD(0), flapFold: new ScalarPD(1),
      liftL: new ScalarPD(0), liftR: new ScalarPD(0), backL: new ScalarPD(0), backR: new ScalarPD(0) };
    this.stepCount = 0;
    // GLB wing root (deg): base sweep (− = back); feather twist = twist − twistSwing·stroke (+ = trailing edge back):
    // near the top of the beat the feather faces tilt up and forward (read from the front and above, catch the sky
    // light), at the bottom they face down (read from below) — the surface sweeps light across the wing every beat
    this.wingTune = { sweep: -15, twist: -6, twistSwing: 26 };
    this._gE = V();
    this.limp = 0;                           // death: 0..1 weakens every joint
    this.reaction = V();                     // model-space angular accel pushed back onto the body (yaw)
    this.handVel = { L: V(), R: V() };
    this.handPrev = { L: null, R: null };
    this.sockets = this.makeSockets();
    try { this.wingShapes = this.buildWingShapes(); } catch (e) { console.warn('[titan] wing proxies', e); this.wingShapes = []; }
    this.fk();
  }

  // ------------------------------------------------------------------ setup helpers
  estimateChord(boneName, u) {
    // Trailing direction of a wing segment from the vertices it carries (GLB): centroid minus its projection.
    const j = this.J(boneName);
    const mesh = this.model.meshes?.all?.find((m) => m.isSkinnedMesh) || (this.model.meshes?.stone?.isSkinnedMesh ? this.model.meshes.stone : null);
    if (!j || !mesh) return new THREE.Vector3(0, 0, -1);
    const bi = mesh.skeleton.bones.indexOf(j.bone);
    const pos = mesh.geometry.attributes.position, si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight;
    if (bi < 0 || !si || !sw) return new THREE.Vector3(0, 0, -1);
    const inv = _m1.copy(this.model.root.matrixWorld).invert();
    const M = _m2.multiplyMatrices(inv, mesh.matrixWorld);
    const acc = V(); let n = 0;
    const p = V(), ud = u.clone().normalize();
    for (let i = 0; i < pos.count; i += 3) {
      for (let k = 0; k < 4; k++) {
        if (si.getComponent(i, k) === bi && sw.getComponent(i, k) > 0.5) {
          p.fromBufferAttribute(pos, i).applyMatrix4(M).sub(j.P0);
          p.addScaledVector(ud, -p.dot(ud));
          acc.add(p); n++;
        }
      }
    }
    return n > 10 && acc.lengthSq() > 1e-6 ? acc.normalize() : new THREE.Vector3(0, 0, -1);
  }

  makeArm(side) {
    const S = side > 0 ? '_L' : '_R';
    const J = this.J;
    const c = (n) => this.canon.get(n + S)?.pos;
    const ua = J('upperarm' + S), fa = J('forearm' + S), hd = J('hand' + S), sh = J('shoulder' + S);
    if (!ua || !fa || !hd) return null;
    const uCan = V().subVectors(c('forearm'), c('upperarm')).normalize();
    const poleCan = new THREE.Vector3(0, 0, -1);
    const hingeCan = V().crossVectors(poleCan, uCan).normalize();
    const fCan = V().subVectors(c('middle1') || c('hand').clone().add(uCan), c('hand')).normalize();
    const nCan = new THREE.Vector3(0, -1, 0);
    const fingers = FINGER_NAMES.map((f) => {
      const segs = [1, 2, 3].map((k) => J(`${f}${k}${S}`));
      const F = FINGERS[f];
      const dirL = new THREE.Vector3(...F.dir).normalize();
      const dir = side > 0 ? dirL : new THREE.Vector3(-dirL.x, dirL.y, dirL.z);
      let curlAxis;
      if (f === 'thumb') {
        // thumb bends across the palm toward the little finger and down
        const toward = side > 0 ? new THREE.Vector3(0.25, -0.55, -0.8) : new THREE.Vector3(-0.25, -0.55, -0.8);
        curlAxis = V().crossVectors(dir, toward).normalize();
      } else curlAxis = V().crossVectors(dir, nCan).normalize();
      const spreadAxis = V().crossVectors(dir, new THREE.Vector3(0, 0, 1)).normalize();
      return { name: f, segs, curlAxis, spreadAxis, curl: new ScalarPD(0.3), claw: new ScalarPD(0), dir, len: F.len };
    });
    const oppAxis = new THREE.Vector3(1, 0, 0);          // axial vector: mirrors to itself (see mirrorAxis)
    return {
      side, S, sh, ua, fa, hd, fingers, uCan, hingeCan, poleCan, fCan, nCan, oppAxis,
      a: ua.P0.distanceTo(fa.P0), b: fa.P0.distanceTo(hd.P0),
      qua: new QuatPD(), bend: new ScalarPD(0.25), twist: new ScalarPD(0), wrist: new QuatPD(),
      spread: new ScalarPD(0.15), opp: new ScalarPD(0.3), clavRaise: new ScalarPD(), clavFwd: new ScalarPD(),
      hist: makeHist(80), histN: 80,
      ik: { elbow: V(), wrist: V(), reach: 0 },
      lastPalmN: nCan.clone(), tgtUa: new THREE.Quaternion(), tgtWrist: new THREE.Quaternion(),
      prevW: V(),
    };
  }

  makeLeg(side) {
    const S = side > 0 ? '_L' : '_R';
    const th = this.J('thigh' + S), sn = this.J('shin' + S), ft = this.J('foot' + S), to = this.J('toe' + S);
    if (!th) return null;
    const rest = side > 0 ? { flex: 14 * D2R, abd: 4 * D2R, knee: 24 * D2R, ankle: 32 * D2R } : { flex: 24 * D2R, abd: 5 * D2R, knee: 40 * D2R, ankle: 26 * D2R };
    return { side, S, th, sn, ft, to, rest, flex: new ScalarPD(rest.flex), abd: new ScalarPD(rest.abd), knee: new ScalarPD(rest.knee), ankle: new ScalarPD(rest.ankle) };
  }

  makeWing(side) {
    const S = side > 0 ? '_L' : '_R';
    const bones = [1, 2, 3, 4].map((k) => this.J(`wing${k}${S}`));
    if (!bones[0]) return null;
    const feathers = [];
    for (let i = 0; i < PRIMARIES; i++) { const j = this.J(`feather_p${i}${S}`); if (j) feathers.push({ j, i }); }
    // Rest frame of every segment: direction to the next joint (leaf: the bone's own +Y, or the procedural tip),
    // and the feather chord (trailing direction) — measured on the mesh for the GLB.
    const rest = bones.map((j, k) => {
      if (!j) return null;
      let dir;
      const next = bones[k + 1];
      if (next) dir = V().subVectors(next.P0, j.P0);
      else if (this.model.procedural) dir = new THREE.Vector3(side, 0, 0);
      else dir = new THREE.Vector3(0, 1, 0).applyQuaternion(j.R0);
      dir.normalize();
      let chord = this.model.procedural ? new THREE.Vector3(0, 0, -1) : this.estimateChord(j.name, dir);
      chord.addScaledVector(dir, -chord.dot(dir));
      if (chord.lengthSq() < 1e-4) chord.set(0, 0, -1).addScaledVector(dir, -dir.z);
      chord.normalize();
      // left-side frame (mirrored for the right) — the closed pose of the GLB is its own rest
      const m = (v) => (side > 0 ? v.clone() : new THREE.Vector3(-v.x, v.y, v.z));
      return { dir, chord, dirL: m(dir), chordL: m(chord) };
    });
    return { side, S, bones, feathers, rest };
  }

  makeSockets() {
    // name → { joint, rest point (model, rest pose) }. GLB sockets win when present.
    const s = {};
    const add = (name, jn, p) => { const j = this.J(jn); if (j && p) s[name] = { j, p: p.clone() }; };
    const node = (n) => { const o = this.model.sockets?.[n]; if (!o) return null; this.model.root.updateMatrixWorld(true); return o.getWorldPosition(V()).applyMatrix4(_m1.copy(this.model.root.matrixWorld).invert()); };
    const sc = this.model.procedural ? 1 : (this.model.height || 120) / 120;
    const rel = (jn, off) => { const j = this.J(jn); return j ? j.P0.clone().add(off.clone().multiplyScalar(sc)) : null; };
    add('core', 'chest', node('core_socket') || (this.model.core ? this.model.core : rel('chest', new THREE.Vector3(0, 5.5, 8))));
    add('chest', 'chest', rel('chest', new THREE.Vector3(0, 6, 2)));
    add('head', 'head', rel('head', new THREE.Vector3(0, 7, 2.5)));
    add('mouth', 'jaw', node('mouth_socket') || rel('head', new THREE.Vector3(0, 2.4, 6)));
    add('eyeL', 'head', rel('head', new THREE.Vector3(2.5, 7.5, 6.5)));
    add('eyeR', 'head', rel('head', new THREE.Vector3(-2.5, 7.5, 6.5)));
    add('crown', 'head', rel('head', new THREE.Vector3(0, 20, 0)));
    for (const [S, side] of [['L', 1], ['R', -1]]) {
      const arm = this.arms[S];
      const palm = node('palm_socket_' + S) || (arm ? this.J('hand_' + S).P0.clone().addScaledVector(V().subVectors(this.J('middle1_' + S)?.P0 || this.J('hand_' + S).P0, this.J('hand_' + S).P0), 0.55).add(new THREE.Vector3(0, -1.6 * sc, 0)) : null);
      add('palm' + S, 'hand_' + S, palm);
      add('elbow' + S, 'forearm_' + S, this.J('forearm_' + S)?.P0);
      add('shoulder' + S, 'upperarm_' + S, this.J('upperarm_' + S)?.P0);
      add('wrist' + S, 'hand_' + S, this.J('hand_' + S)?.P0);
      add('knee' + S, 'shin_' + S, this.J('shin_' + S)?.P0);
      add('hip' + S, 'thigh_' + S, this.J('thigh_' + S)?.P0);
      add('foot' + S, 'foot_' + S, this.J('foot_' + S)?.P0);
      for (let k = 1; k <= 4; k++) add(`wing${k}${S}`, `wing${k}_${S}`, this.J(`wing${k}_${S}`)?.P0);
      const w4 = this.J('wing4_' + S), w3 = this.J('wing3_' + S);
      if (w4 && w3) add('wingtip' + S, 'wing4_' + S, w4.P0.clone().add(V().subVectors(w4.P0, w3.P0).multiplyScalar(0.9)));
      for (const f of FINGER_NAMES) {
        const d = this.J(`${f}3_${S}`), m = this.J(`${f}2_${S}`);
        if (d && m) add(`tip_${f}${S}`, `${f}3_${S}`, d.P0.clone().add(V().subVectors(d.P0, m.P0).multiplyScalar(0.85)));
      }
    }
    return s;
  }

  /** Posed model-space position of a socket (after fk()). */
  socket(name, out = V()) {
    const s = this.sockets[name];
    if (!s) return null;
    return out.subVectors(s.p, s.j.P0).applyQuaternion(s.j.G).add(s.j.P);
  }
  /** Canonical-frame rotation of a joint (maps canonical rest directions to posed model space). */
  frame(name) { return this.J(name)?.Gc || null; }

  // ------------------------------------------------------------------ kinematics
  fk() {
    for (const j of this.joints) {
      const p = j.parent;
      if (p) {
        j.Gc.multiplyQuaternions(p.Gc, j.D);
        j.G.multiplyQuaternions(j.Gc, j.A);
        j.P.subVectors(j.P0, p.P0).applyQuaternion(p.G).add(p.P);
      } else {
        j.Gc.copy(j.D);
        j.G.multiplyQuaternions(j.Gc, j.A);
        j.P.copy(j.P0);
      }
    }
  }

  /** Put every bone back to the model's own rest pose (debug views). */
  restPose() { for (const j of this.joints) j.bone.quaternion.copy(j.q0); }

  /** Write bone local rotations for rendering. */
  apply() {
    if (this.showRest) return this.restPose();
    for (const j of this.joints) {
      const Rp = j.parent ? _q1.multiplyQuaternions(j.parent.G, j.parent.R0) : _q1.copy(j.Rpn);
      _q2.multiplyQuaternions(j.G, j.R0);
      j.bone.quaternion.copy(Rp.invert().multiply(_q2));
    }
  }

  /** Analytic two-bone IK with soft reach. Returns elbow & wrist (model) in arm.ik. */
  solveArm(arm, S, T, pole) {
    const a = arm.a, b = arm.b;
    const toT = _v1.subVectors(T, S);
    let d = toT.length();
    const dir = _v2.copy(toT).divideScalar(Math.max(d, 1e-4));
    const soft = 3.0, dSoft = a + b - soft;
    if (d > dSoft) d = dSoft + soft * (1 - Math.exp(-(d - dSoft) / soft));
    d = clamp(d, Math.abs(a - b) + 0.5, a + b - 0.05);
    const cosA = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1), sinA = Math.sqrt(1 - cosA * cosA);
    const perp = _v3.copy(pole).addScaledVector(dir, -pole.dot(dir));
    if (perp.lengthSq() < 1e-6) perp.set(0, -1, 0).addScaledVector(dir, -dir.y);
    perp.normalize();
    arm.ik.elbow.copy(S).addScaledVector(dir, a * cosA).addScaledVector(perp, a * sinA);
    arm.ik.wrist.copy(S).addScaledVector(dir, d);
    arm.ik.dir = dir.clone(); arm.ik.perp = perp.clone();
    arm.ik.reach = d;
    return arm.ik;
  }

  // ------------------------------------------------------------------ per fixed step
  /**
   * plan: { torso:{yaw,pitch,roll}, hips:{pitch}, arms:{L,R:{wrist:V3, pole:V3, palm:V3|null, flex, hand:poseName|{…}, clav:{raise,fwd},
   *         gains, tremble, amax, wmax}}, head:{look:V3 (model point)|null, pitch, roll}, jaw, wings:{amp,mid,fold,sweep,tilt,spread,flapFold},
   *         legs:{L,R:{flex,knee,abd,ankle}} (offsets), torsoGains }
   * ctx: { phase, T (thrust), accel (model-space pelvis accel incl. bob), gravity (model-space), time, speed (attack time scale) }
   */
  step(plan, ctx) {
    const dt = this.dt;
    const limp = this.limp;
    this.stepCount++;
    const t = ctx.time;

    // ---------------- torso (scalar PDs + reaction from the arms) ----------------
    const tg = plan.torsoGains === 'strike' ? [2.5, 0.6, 1.5, 0.8] : plan.torsoGains === 'windup' ? [1.8, 0.8, 1.2, 0.6] : [1.5, 0.85, 1.2, 0.6];
    const tw = tg[0] * (1 - 0.6 * limp);
    const breath = Math.sin(t * 2 * Math.PI * 0.12);
    const R = this.reaction;
    this.torso.yaw.step((plan.torso?.yaw || 0), dt, tw, tg[1], tg[2], tg[3], -R.y * 0.12);
    this.torso.pitch.step((plan.torso?.pitch || 0) + breath * 0.012, dt, tw, tg[1], tg[2], tg[3], -R.x * 0.08);
    this.torso.roll.step((plan.torso?.roll || 0), dt, tw, tg[1], tg[2], tg[3], -R.z * 0.08);
    // hips counter-twist: the pelvis swings against the chest (and with the legs)
    this.torso.hipYaw.step(-0.28 * this.torso.yaw.x, dt, 1.6, 0.7, 2, 1);
    this.torso.hipPitch.step((plan.hips?.pitch || 0), dt, 1.6, 0.7, 2, 1);
    const Tq = _q1.setFromEuler(new THREE.Euler(this.torso.pitch.x, this.torso.yaw.x, this.torso.roll.x, 'YXZ'));
    const setD = (name, q) => { const j = this.J(name); if (j) j.D.copy(q); };
    setD('hips', _q2.setFromEuler(new THREE.Euler(this.torso.hipPitch.x, this.torso.hipYaw.x, 0, 'YXZ')));
    setD('spine1', _q3.identity().slerp(Tq, 0.3));
    setD('spine2', _q3.identity().slerp(Tq, 0.3));
    setD('chest', _q3.identity().slerp(Tq, 0.4));

    // ---------------- clavicles ----------------
    for (const k of ['L', 'R']) {
      const arm = this.arms[k]; if (!arm) continue;
      const P = plan.arms?.[k] || {};
      const g = GAINS[limp > 0.5 ? 'limp' : (P.gains || 'idle')].clav;
      arm.clavRaise.step(P.clav?.raise ?? 0, dt, g[0], g[1], g[2], g[3]);
      arm.clavFwd.step(P.clav?.fwd ?? 0, dt, g[0], g[1], g[2], g[3]);
      if (arm.sh) arm.sh.D.setFromEuler(new THREE.Euler(0, -arm.side * arm.clavFwd.x, arm.side * arm.clavRaise.x, 'YXZ'));
    }
    this.fk();

    // ---------------- arms: IK → history → delayed PD ----------------
    R.set(0, 0, 0);
    for (const k of ['L', 'R']) {
      const arm = this.arms[k]; if (!arm) continue;
      const P = plan.arms?.[k];
      const sched = limp > 0.5 ? 'limp' : (P?.gains || 'idle');
      const G = GAINS[sched];
      const hi = this.stepCount % arm.histN;
      const H = arm.hist[hi];
      const Gsh = arm.sh ? arm.sh.Gc : this.J('chest').Gc;
      if (P?.wrist) {
        const S = arm.ua.P;
        const pole = P.pole || _v4.set(arm.side, -0.6, -0.9).normalize();
        const ik = this.solveArm(arm, S, P.wrist, pole);
        const u = _v1.subVectors(ik.elbow, S).normalize();
        const hinge = _v2.crossVectors(ik.perp, ik.dir).normalize();
        const Gua = alignFrames(arm.uCan, arm.hingeCan, u, hinge, _q1);
        H.ua.copy(Gsh).invert().multiply(Gua);
        if (P.tremble) {
          const tr = P.tremble * 0.006 * Math.sin(t * 2 * Math.PI * 6.2);
          H.ua.premultiply(_q2.setFromAxisAngle(_v5.set(0.3, 1, 0.2).normalize(), tr));
        }
        const fdir = _v3.subVectors(ik.wrist, ik.elbow).normalize();
        H.bend = Math.acos(clamp(u.dot(fdir), -1, 1));
        H.twist = P.twist || 0;
        // wrist: palm normal wanted in model space, fingers along the forearm as far as the palm allows
        const Gfa = _q2.copy(Gua).multiply(_q3.setFromAxisAngle(arm.hingeCan, H.bend));
        let n = P.palm ? _v4.copy(P.palm) : _v4.copy(arm.lastPalmN);
        const f = _v5.copy(fdir);
        const nPerp = n.addScaledVector(f, -n.dot(f));
        if (nPerp.lengthSq() < 0.04) nPerp.copy(arm.lastPalmN).addScaledVector(f, -arm.lastPalmN.dot(f));
        nPerp.normalize();
        arm.lastPalmN.copy(nPerp);
        let fh = f.clone(), nh = nPerp.clone();
        if (P.flex) { const ax = V().crossVectors(fh, nh).normalize(); fh.applyAxisAngle(ax, -P.flex); nh.applyAxisAngle(ax, -P.flex); }
        const Ghd = alignFrames(arm.fCan, arm.nCan, fh, nh, _q3);
        H.wrist.copy(Gfa).invert().multiply(Ghd);
        const wAng = 2 * Math.acos(clamp(Math.abs(H.wrist.w), 0, 1));
        if (wAng > 1.5) H.wrist.slerp(_q1.identity(), 1 - 1.5 / wAng);
      } else {
        const prev = arm.hist[(hi + arm.histN - 1) % arm.histN];
        H.ua.copy(prev.ua); H.bend = prev.bend; H.twist = prev.twist; H.wrist.copy(prev.wrist);
      }
      const pose = typeof P?.hand === 'string' ? HAND_POSES[P.hand] : (P?.hand || HAND_POSES.relaxed);
      for (let i = 0; i < 5; i++) H.curl[i] = pose.curl[i];
      H.spread = pose.spread; H.opp = pose.opp; H.claw = pose.claw || 0;

      const read = (delay) => arm.hist[(hi + arm.histN - Math.min(arm.histN - 1, Math.round(delay / dt))) % arm.histN];
      const amaxK = P?.amax ? P.amax / G.ua[2] : 1, wmaxK = P?.wmax ? P.wmax / G.ua[3] : 1;
      const soft = 1 - 0.55 * limp;
      // gravity sag: a raised arm droops a little until the PD lifts it (effort reads as weight)
      arm.prevW.copy(arm.qua.w);
      arm.qua.step(read(DELAY.ua).ua, dt, G.ua[0] * soft, G.ua[1], G.ua[2] * amaxK, G.ua[3] * wmaxK);
      arm.ua.D.copy(arm.qua.q);
      const hb = read(DELAY.bend);
      arm.bend.step(hb.bend, dt, G.bend[0] * soft, G.bend[1], G.bend[2] * amaxK, G.bend[3] * wmaxK);
      arm.bend.x = clamp(arm.bend.x, 0.04, 2.5);
      arm.twist.step(hb.twist, dt, G.bend[0], 0.8, G.bend[2], G.bend[3]);
      arm.fa.D.copy(_q1.setFromAxisAngle(arm.hingeCan, arm.bend.x)).multiply(_q2.setFromAxisAngle(arm.uCan, arm.twist.x));
      arm.wrist.step(read(DELAY.wrist).wrist, dt, G.wrist[0] * soft, G.wrist[1], G.wrist[2], G.wrist[3]);
      arm.hd.D.copy(arm.wrist.q);
      // reaction torque: the arm's angular acceleration, in model space, pushed back onto the torso & body
      const alpha = _v1.subVectors(arm.qua.w, arm.prevW).divideScalar(dt).applyQuaternion(Gsh);
      R.add(alpha);

      // fingers (ripple: each finger reads its own delay)
      const gf = G.finger;
      const hs = read(DELAY.finger);
      arm.spread.step(hs.spread, dt, gf[0], gf[1], gf[2], gf[3]);
      arm.opp.step(hs.opp, dt, gf[0], gf[1], gf[2], gf[3]);
      for (let i = 0; i < 5; i++) {
        const F = arm.fingers[i];
        const hf = read(DELAY.finger + RIPPLE[F.name]);
        F.curl.step(hf.curl[i], dt, gf[0] * soft, gf[1], gf[2], gf[3]);
        F.claw.step(hf.claw, dt, gf[0], gf[1], gf[2], gf[3]);
        const c = clamp(F.curl.x, -0.3, 1.15), kf = KF[F.name], cl = F.claw.x;
        const S0 = F.segs[0], S1 = F.segs[1], S2 = F.segs[2];
        let a0, a1, a2;
        if (F.name === 'thumb') {
          a0 = c * 22 * D2R; a1 = c * 48 * D2R; a2 = c * 62 * D2R;
          // opposition rolls the thumb under the palm about the hand's long axis (+X on both sides after mirroring)
          if (S0) S0.D.setFromAxisAngle(arm.oppAxis, arm.opp.x * 48 * D2R).multiply(_q1.setFromAxisAngle(F.curlAxis, a0));
        } else {
          const mcp = (c >= 0 ? c * 88 : c * 55) * kf * D2R * (1 - 0.7 * cl) + cl * 18 * D2R;
          const pip = Math.max(0, c) * 100 * kf * D2R * (1 - 0.2 * cl) + cl * 55 * D2R;
          a0 = mcp; a1 = pip; a2 = 0.7 * pip + cl * 20 * D2R;
          if (S0) S0.D.setFromAxisAngle(F.spreadAxis, arm.spread.x * SPREAD[F.name] * D2R).multiply(_q1.setFromAxisAngle(F.curlAxis, a0));
        }
        if (S1) S1.D.setFromAxisAngle(F.curlAxis, a1);
        if (S2) S2.D.setFromAxisAngle(F.curlAxis, a2);
      }
    }

    // ---------------- legs: damped double pendulums under the pelvis acceleration ----------------
    const gE = this._gE.copy(ctx.gravity || _v3.set(0, -9.81, 0)).sub(ctx.accel || _v4.set(0, 0, 0));   // effective gravity (model)
    for (const k of ['L', 'R']) {
      const L = this.legs[k]; if (!L) continue;
      const off = plan.legs?.[k] || {};
      const lw = 1 - 0.5 * limp;
      const tFlex = L.rest.flex + (off.flex || 0), tKnee = L.rest.knee + (off.knee || 0), tAbd = L.rest.abd + (off.abd || 0), tAnk = L.rest.ankle + (off.ankle || 0);
      const Lc = 24;
      // hip flex: leg dir (0, −cosθ, sinθ); gravity torque on it, 88 % compensated at the rest angle
      const th = L.flex.x;
      const torqueF = (gE.y * Math.sin(th) + gE.z * Math.cos(th)) / Lc - (-9.81 * Math.sin(tFlex)) / Lc * 0.88;
      L.flex.step(tFlex, dt, 1.2 * lw, 0.35, 6, 2, torqueF - 0.3 * this.torso.pitch.a);
      const ph = L.abd.x;
      const torqueA = (L.side * gE.x * Math.cos(ph) + gE.y * Math.sin(ph)) / Lc - (-9.81 * Math.sin(tAbd)) / Lc * 0.88;
      L.abd.step(tAbd, dt, 1.3 * lw, 0.4, 6, 2, torqueA);
      L.knee.step(tKnee, dt, 1.8 * lw, 0.4, 8, 2.5, -0.6 * L.flex.a + (gE.z * 0.2) / 13);
      L.ankle.step(tAnk, dt, 3 * lw, 0.5, 10, 3, -0.4 * L.knee.a);
      L.flex.x = clamp(L.flex.x, -45 * D2R, 110 * D2R);
      L.knee.x = clamp(L.knee.x, 0, 140 * D2R);
      L.abd.x = clamp(L.abd.x, -12 * D2R, 35 * D2R);
      L.th.D.setFromAxisAngle(X, -L.flex.x).premultiply(_q1.setFromAxisAngle(Z, L.side * L.abd.x));
      if (L.sn) L.sn.D.setFromAxisAngle(X, L.knee.x);
      if (L.ft) L.ft.D.setFromAxisAngle(X, L.ankle.x - 12 * D2R);
    }

    // ---------------- head & jaw ----------------
    {
      const H = plan.head || {};
      const hg = H.fast ? [3.5, 0.8, 4, 1.5] : [2.5, 0.9, 3, 1.2];
      let yaw = 0, pitch = 0;
      const hj = this.J('head'), cj = this.J('chest');
      if (H.look && hj && cj) {
        const from = this.socket('head', _v1);
        const d = _v2.subVectors(H.look, from).normalize().applyQuaternion(_q1.copy(cj.Gc).invert());
        yaw = Math.atan2(d.x, d.z); pitch = -Math.asin(clamp(d.y, -1, 1));
        yaw = clamp(yaw, -80 * D2R, 80 * D2R); pitch = clamp(pitch, -50 * D2R, 45 * D2R);
      }
      pitch += H.pitch || 0;
      this.head.yaw.step(yaw, dt, hg[0], hg[1], hg[2], hg[3]);
      this.head.pitch.step(pitch, dt, hg[0], hg[1], hg[2], hg[3]);
      this.head.roll.step(H.roll || 0, dt, hg[0], hg[1], hg[2], hg[3]);
      const e = (k) => new THREE.Euler(this.head.pitch.x * k, this.head.yaw.x * k, this.head.roll.x * k, 'YXZ');
      setD('neck', _q1.setFromEuler(e(0.4)));
      setD('head', _q1.setFromEuler(e(0.6)));
      this.head.jaw.step(plan.jaw || 0, dt, 9, 0.6, 30, 4);
      const jj = this.J('jaw');
      if (jj) jj.D.setFromAxisAngle(X, clamp(this.head.jaw.x, 0, 1.2) * 30 * D2R);
    }

    // ---------------- wings ----------------
    this.stepWings(plan.wings || {}, ctx, dt);

    // ---------------- cloth ----------------
    for (const C of this.cloth) {
      if (!C.bones[0]) continue;
      const front = C.k === 'F' ? 1 : -1;
      const legs = [this.legs.L?.flex.x || 0, this.legs.R?.flex.x || 0];
      for (let i = 0; i < 3; i++) {
        const th = C.th[i];
        const acc = (gE.y * Math.sin(th.x) + gE.z * Math.cos(th.x)) / (10 + i * 2) - (ctx.downwash || 0) * 0.02 * front;
        th.step(0, dt, 1.4 - i * 0.2, 0.28, 8, 2.5, acc * (i === 0 ? 1 : 0.6));
        if (i === 0) {
          // the front panel rides on the thighs, the back panel is pushed by legs swinging back
          if (front > 0) th.x = Math.max(th.x, 0.55 * Math.max(legs[0], legs[1]) - 0.12);
          else th.x = Math.min(th.x, 0.55 * Math.min(legs[0], legs[1]) + 0.12);
        }
        C.bones[i]?.D.setFromAxisAngle(X, -th.x);
      }
    }

    this.fk();
  }

  stepWings(W, ctx, dt) {
    const P = this.wingParams;
    const lim = 1 - 0.6 * this.limp;
    const ws = W.snap ? 12 : 3.2;
    P.amp.step(W.amp ?? 50 * D2R, dt, ws * lim, 0.9, 20, 3);
    P.mid.step(W.mid ?? 8 * D2R, dt, ws * lim, 0.85, 20, 3);
    P.fold.step(W.fold ?? 0, dt, (W.snap ? 10 : 2.6) * lim, W.snap ? 0.5 : 0.85, 30, 4);
    P.sweep.step(W.sweep ?? 0, dt, ws * lim, 0.85, 20, 3);
    P.tilt.step(W.tilt ?? 0, dt, ws, 0.9, 20, 3);
    P.spread.step(W.spread ?? 0, dt, 4, 0.8, 20, 4);
    P.flapFold.step(W.flapFold ?? 1, dt, 3, 0.9, 20, 3);
    for (const k of ['L', 'R']) {
      P['lift' + k].step(W.lift?.[k] ?? 0, dt, 2.6 * lim, 0.85, 12, 2);
      P['back' + k].step(W.back?.[k] ?? 0, dt, 2.6 * lim, 0.85, 12, 2);
    }
    const D = DOWN_FRACTION;
    const stroke = (ph) => { ph = ((ph % 1) + 1) % 1; return ph < D ? Math.cos(Math.PI * ph / D) : -Math.cos(Math.PI * (ph - D) / (1 - D)); };
    const upFold = (ph) => { ph = ((ph % 1) + 1) % 1; return ph < D ? 0 : Math.pow(Math.sin(Math.PI * (ph - D) / (1 - D)), 2); };
    const phi = ctx.phase ?? 0;
    const fold = clamp(P.fold.x, -0.3, 1.1);
    const open = 1 - clamp(fold, 0, 1);
    const flapK = open * P.flapFold.x;
    const amp = P.amp.x * (0.25 + 0.75 * open);
    const tiltAxis = _v5.set(0, Math.sin(P.tilt.x), Math.cos(P.tilt.x)).normalize().clone();
    const chest = this.J('chest');
    const ph0 = ((phi % 1) + 1) % 1;
    const twist = (ph0 < D ? 10 * Math.sin(Math.PI * ph0 / D) : -12 * Math.sin(Math.PI * (ph0 - D) / (1 - D))) * D2R * flapK;
    const lags = [0, 0.05, 0.1, 0.16];
    if (!this.model.procedural) {
      this.stepWingsGLB({ P, phi, fold, open, flapK, amp, lags, stroke, upFold, ph0 });
      return;
    }
    for (const k of ['L', 'R']) {
      const w = this.wings[k]; if (!w) continue;
      const s = w.side;
      let prevQ = chest ? chest.Gc : _q3.identity();
      for (let i = 0; i < 4; i++) {
        const j = w.bones[i], r = w.rest[i];
        if (!j || !r) continue;
        // closed (the concept's raised V; the GLB's own rest) ↔ spread (≈ 260 m span), in the left-side body frame
        const C = this.model.procedural ? WING_CLOSED[i] : { d: r.dirL, c: r.chordL };
        const Sp = WING_SPREAD[i];
        const d = _v1.copy(Sp.d).lerp(C.d, clamp(fold, 0, 1)).normalize();
        const c = _v2.copy(Sp.c).lerp(C.c, clamp(fold, 0, 1));
        if (fold < 0) { d.lerp(WING_UP[i].d, -fold / 0.3).normalize(); c.lerp(WING_UP[i].c, -fold / 0.3); }
        c.addScaledVector(d, -c.dot(d)).normalize();
        // upstroke: the wrist folds back and the primaries sweep down/back (feathers slot open)
        const uf = upFold(phi - lags[i] - 0.04) * flapK;
        if (i >= 2 && uf > 0) {
          const nrm = _v3.crossVectors(c, d).normalize();
          const ang = (i === 2 ? 22 : 48) * D2R * uf;
          d.applyAxisAngle(nrm, -ang); c.applyAxisAngle(nrm, -ang);
        }
        // travelling-wave stroke about the (tilted) body axis, then sweep, then angle of attack
        const th = P.mid.x + P['lift' + k].x + amp * stroke(phi - lags[i]) * (i === 0 ? 1 : 0.9 + 0.1 * i);
        _q1.setFromAxisAngle(tiltAxis, th);
        d.applyQuaternion(_q1); c.applyQuaternion(_q1);
        _q1.setFromAxisAngle(Y, (-P.sweep.x + P['back' + k].x) * (1 - 0.3 * i / 3));
        d.applyQuaternion(_q1); c.applyQuaternion(_q1);
        c.applyAxisAngle(d, twist * (0.6 + 0.2 * i));
        if (s < 0) { d.x = -d.x; c.x = -c.x; }
        // to model space through the chest, then aim this segment from its rest frame
        if (chest) { d.applyQuaternion(chest.Gc); c.applyQuaternion(chest.Gc); }
        const Q = alignFrames(r.dir, r.chord, d, c, _q2);
        j.D.copy(prevQ).invert().multiply(Q);
        prevQ = j._wq || (j._wq = new THREE.Quaternion());
        prevQ.copy(Q);
      }
      // procedural primaries: fan open with `spread`, slot apart on the upstroke, stack when folded
      for (const F of w.feathers) {
        const tI = F.i / Math.max(1, PRIMARIES - 1);
        const fan = (P.spread.x * 10 * (tI - 0.4) - clamp(fold, 0, 1) * 18 * (1 - tI)) * D2R;
        const slot = (upFold(phi - 0.12) * flapK * (6 + 10 * tI)) * D2R;
        F.j.D.setFromAxisAngle(Y, fan).multiply(_q1.setFromAxisAngle(X, -slot));
        if (s < 0) F.j.D.set(F.j.D.x, -F.j.D.y, -F.j.D.z, F.j.D.w);
      }
    }
  }

  /** GLB wings: the tested local-axis key poses (GLB_WING_POSES) driven by the body's flap phase. */
  stepWingsGLB({ P, phi, fold, flapK, amp, lags, stroke, upFold, ph0 }) {
    const D = DOWN_FRACTION;
    const shut = clamp(fold, 0, 1);                     // 1 = closed = the GLB's own raised-V rest pose
    const high = clamp(-fold / 0.3, 0, 1);              // fold < 0: wings raised high over the back
    // feather twist through the beat: pronate on the downstroke, supinate on the upstroke
    const tw = (ph0 < D ? 8 * Math.sin(Math.PI * ph0 / D) : -10 * Math.sin(Math.PI * (ph0 - D) / (1 - D))) * flapK;
    for (const k of ['L', 'R']) {
      const w = this.wings[k]; if (!w) continue;
      const side = w.side;
      const raise = P.mid.x + P['lift' + k].x;
      for (let i = 0; i < 4; i++) {
        const j = w.bones[i]; if (!j) continue;
        const st = stroke(phi - lags[i]);
        const s = clamp((raise + amp * st * (i === 0 ? 1 : 0.9 + 0.1 * i)) / WING_STROKE_REF + high * 0.8, -1.35, 1.5);
        let ax = glbWingAngle(i, s);                       // degrees
        // upstroke: the hand folds (primaries in) so the wing recovers with less drag; `spread` fans them out
        const uf = upFold(phi - lags[i] * 0.4 - 0.02) * flapK;
        if (i === 3) ax += 40 * uf - 8 * P.spread.x;
        if (i === 2) ax += 8 * uf;
        ax *= 1 - shut;
        if (this.wingOverride) ax = this.wingOverride[i];  // debug review: fixed local-X angles
        // sweep (local Z, + = forward on the left) and twist (local Y, + = trailing edge back on the left) on the
        // root bone only, so the whole wing turns as one: a swept-back V seen from above, the feathers slanting
        // down-back so the surface reads from the front, the side and below
        let az = 0, ay = 0;
        if (i === 0) {
          az = (this.wingTune.sweep * D2R - P['back' + k].x + P.sweep.x + P.tilt.x * 0.2 * (1 - st)) * (1 - shut);
          ay = (this.wingTune.twist - this.wingTune.twistSwing * st + tw) * D2R * (1 - shut);
        }
        // local rotation L = Rx·Rz·Ry (right side: Z and Y mirrored); D = R0·L·R0⁻¹ is that same rotation as a
        // model-space delta under the parent, so bone.quaternion ends up = rest × L exactly as in the README
        _q1.setFromAxisAngle(X, ax * D2R).multiply(_q2.setFromAxisAngle(Z, side * az)).multiply(_q3.setFromAxisAngle(Y, side * ay));
        j.D.copy(j.R0).multiply(_q1).multiply(_q2.copy(j.R0).invert());
      }
    }
  }

  /**
   * Feather-surface proxies for hits and the camera: every wing vertex goes to its dominant wing / feather bone;
   * each bone's cloud is cut into slices along its long principal axis, one capsule across every slice (rest model
   * space, carried by the bone). → [{ j, side: 'L'|'R', a0, b0, r }]
   */
  buildWingShapes(maxSlices = 4) {
    const out = [];
    const all = this.model.meshes?.all || [this.model.meshes?.stone, this.model.meshes?.feathers];
    const meshes = all.filter((m) => m?.isSkinnedMesh && m.skeleton);
    if (!meshes.length) return out;
    this.model.root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(this.model.root.matrixWorld).invert();
    const buckets = new Map();
    const p = V();
    const RE = /^(wing[1-4]|feather_p\d+)_([LR])$/;
    for (const mesh of meshes) {
      const g = mesh.geometry, pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
      if (!pos || !si || !sw) continue;
      const M = new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld);
      const jointOf = mesh.skeleton.bones.map((b) => (b && RE.test(b.name) ? this.J(b.name) : null));
      for (let i = 0; i < pos.count; i++) {
        let best = -1, bw = 0;
        for (let c = 0; c < 4; c++) { const w = sw.getComponent(i, c); if (w > bw) { bw = w; best = si.getComponent(i, c); } }
        const j = jointOf[best];
        if (!j) continue;
        let b = buckets.get(j);
        if (!b) { b = []; buckets.set(j, b); }
        p.fromBufferAttribute(pos, i).applyMatrix4(M);
        b.push(p.x, p.y, p.z);
      }
    }
    const cov = (arr, c) => {
      const C = [0, 0, 0, 0, 0, 0];                      // xx xy xz yy yz zz
      for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i] - c.x, y = arr[i + 1] - c.y, z = arr[i + 2] - c.z;
        C[0] += x * x; C[1] += x * y; C[2] += x * z; C[3] += y * y; C[4] += y * z; C[5] += z * z;
      }
      return C;
    };
    const mulC = (C, v, o) => o.set(C[0] * v.x + C[1] * v.y + C[2] * v.z, C[1] * v.x + C[3] * v.y + C[4] * v.z, C[2] * v.x + C[4] * v.y + C[5] * v.z);
    const power = (C, ortho) => {
      const v = V().set(0.577, 0.577, 0.577), t = V();
      for (let it = 0; it < 40; it++) {
        mulC(C, v, t);
        if (ortho) t.addScaledVector(ortho, -t.dot(ortho));
        if (t.lengthSq() < 1e-12) { v.set(ortho ? ortho.y : 1, ortho ? -ortho.x : 0, 0.3); if (ortho) v.addScaledVector(ortho, -v.dot(ortho)); v.normalize(); continue; }
        v.copy(t).normalize();
      }
      return v;
    };
    // true feather tip per side (the vertex farthest from the wing root): the 'wingtipL/R' sockets
    for (const [j, arr] of buckets) {
      const side = /_L$/.test(j.name) ? 'L' : 'R';
      const root = this.J('wing1_' + side)?.P0;
      if (!root) continue;
      for (let i = 0; i < arr.length; i += 3) {
        p.set(arr[i], arr[i + 1], arr[i + 2]);
        const d = p.distanceToSquared(root);
        if (!this.sockets['_tip' + side] || d > this.sockets['_tip' + side].d) this.sockets['_tip' + side] = { d, j, p: p.clone() };
      }
    }
    for (const k of ['L', 'R']) { const t = this.sockets['_tip' + k]; if (t) { this.sockets['wingtip' + k] = { j: t.j, p: t.p }; } delete this.sockets['_tip' + k]; }
    for (const [j, arr] of buckets) {
      const n = arr.length / 3;
      if (n < 12) continue;
      const side = /_L$/.test(j.name) ? 'L' : 'R';
      const c = V();
      for (let i = 0; i < arr.length; i += 3) { c.x += arr[i]; c.y += arr[i + 1]; c.z += arr[i + 2]; }
      c.divideScalar(n);
      const C = cov(arr, c);
      const e1 = power(C, null), e2 = power(C, e1), e3 = V().crossVectors(e1, e2).normalize();
      let umin = Infinity, umax = -Infinity;
      for (let i = 0; i < arr.length; i += 3) { const u = (arr[i] - c.x) * e1.x + (arr[i + 1] - c.y) * e1.y + (arr[i + 2] - c.z) * e1.z; umin = Math.min(umin, u); umax = Math.max(umax, u); }
      const N = clamp(Math.ceil((umax - umin) / 14), 1, /^feather/.test(j.name) ? 1 : maxSlices);   // a procedural primary is one quill
      const du = (umax - umin) / N;
      const S = Array.from({ length: N }, () => ({ vmin: Infinity, vmax: -Infinity, w: 0, w2: 0, n: 0 }));
      for (let i = 0; i < arr.length; i += 3) {
        const x = arr[i] - c.x, y = arr[i + 1] - c.y, z = arr[i + 2] - c.z;
        const u = x * e1.x + y * e1.y + z * e1.z, v = x * e2.x + y * e2.y + z * e2.z, w = x * e3.x + y * e3.y + z * e3.z;
        const s = S[clamp(Math.floor((u - umin) / Math.max(du, 1e-6)), 0, N - 1)];
        s.vmin = Math.min(s.vmin, v); s.vmax = Math.max(s.vmax, v); s.w += w; s.w2 += w * w; s.n++;
      }
      S.forEach((s, k) => {
        if (s.n < 4) return;
        const wm = s.w / s.n, wsd = Math.sqrt(Math.max(0, s.w2 / s.n - wm * wm));
        const r = clamp(du * 0.5 + 0.5, 3, 12) + Math.min(3, wsd);
        const uc = umin + (k + 0.5) * du;
        const base = c.clone().addScaledVector(e1, uc).addScaledVector(e3, wm);
        let v0 = s.vmin + r * 0.6, v1 = s.vmax - r * 0.6;
        if (v1 < v0) v0 = v1 = (s.vmin + s.vmax) / 2;
        out.push({ j, side, a0: base.clone().addScaledVector(e2, v0), b0: base.clone().addScaledVector(e2, v1), r });
      });
    }
    return out;
  }

  /** Posed model-space ends of a wing proxy (after fk()). */
  wingShapePosed(ws, outA, outB) {
    const j = ws.j;
    outA.subVectors(ws.a0, j.P0).applyQuaternion(j.G).add(j.P);
    outB.subVectors(ws.b0, j.P0).applyQuaternion(j.G).add(j.P);
  }

  /** Snap every PD to the current plan targets (spawning, teleports). */
  settle(plan, ctx, steps = 240) {
    for (let i = 0; i < steps; i++) this.step(plan, ctx);
  }
}
