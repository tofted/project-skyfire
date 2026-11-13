// Parametric wing kinematics — the single source of wing shape for BOTH the physics strips and the skeleton.
// Bat/pterosaur-style arm wing: shoulder -> elbow -> wrist -> 4 finger spars, membrane to the flank.
//
// Frames. Body/model frame: +Z forward, +Y up, +X model LEFT. Every joint frame coincides with the body axes in the
// BIND pose (WING_GEOMETRY: wings fully spread and flat). A pose quaternion is the joint's rotation relative to its
// parent segment in those canonical frames (shoulder: humerus vs chest; elbow: forearm vs humerus; wrist: hand vs
// forearm; fingers[i]: finger vs hand). The right wing is the mirror image: quaternion (x, -y, -z, w).
// Map onto a real bone whose bind rotation in model space is B and bind local rotation is Lb:
//     bone.quaternion = Lb * (B^-1 * q * B)                  -> retargetJoint(q, Lb, B, out)
//
// Stroke timing: phase 0 = top of stroke, downstroke 0..D (D ~ 0.56), upstroke D..1 with a strong fold.
import * as THREE from 'three';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth01 = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

/**
 * Canonical LEFT wing at scale 1, in the bind pose (metres, body frame). It matches the dragon rig's bind joint
 * positions (dragon-fallback.js), so the physics strips are the visible membrane. The bind already carries ~6 deg of
 * dihedral; finger tips are given as [angle in the wing plane from +X toward +Z (deg), length, rise dy].
 */
export const WING_GEOMETRY = {
  shoulder: [0.42, 0.42, 0.95],
  elbow: [2.25, 0.62, 0.35],
  wrist: [4.6, 0.85, 1.4],
  hand: [5.05, 0.88, 1.45],            // finger roots
  fingers: [[4, 3.3, 0.1], [-24, 3.5, 0.07], [-52, 3.1, 0.02], [-83, 2.6, -0.02]],   // f1 leading/tip .. f4 trailing
  rootTE: [0.44, 0.13, -1.8],          // membrane meets the flank at the hip (plagiopatagium root)
  teScallop: 0.55,                     // inward bulge of the arm-wing trailing edge (m)
  // mass fractions of one wing, at the mid-points of humerus / forearm / hand
  massSplit: [0.5, 0.28, 0.22],
};

const V3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

/** Scaled geometry cache: bone vectors (bind), twist axes and the radii used by the twist feed-forward. */
export function buildGeometry(scale = 1, g = WING_GEOMETRY) {
  const s = scale;
  const S = V3(g.shoulder).multiplyScalar(s), E = V3(g.elbow).multiplyScalar(s), W = V3(g.wrist).multiplyScalar(s);
  const H = V3(g.hand).multiplyScalar(s);
  const out = {
    scale: s, S,
    h: E.clone().sub(S), f: W.clone().sub(E), m: H.clone().sub(W),
    fing: g.fingers.map(([deg, len, dy]) => new THREE.Vector3(Math.cos(deg * DEG) * len, dy, Math.sin(deg * DEG) * len).multiplyScalar(s)),
    fingDir: g.fingers.map((fi) => fi[0]),
    te: V3(g.rootTE).multiplyScalar(s),
    teScallop: (g.teScallop ?? 0.5) * s,
    massSplit: g.massSplit.slice(),
  };
  out.hAxis = out.h.clone().normalize();
  out.mAxis = out.m.clone().normalize();
  out.f1Axis = out.fing[0].clone().normalize();
  out.rArm = (S.distanceTo(E) + S.distanceTo(W)) * 0.5;
  out.rHand = H.clone().addScaledVector(out.fing[0], 0.45).sub(S).length();
  out.rTip = H.clone().addScaledVector(out.fing[0], 0.9).sub(S).length();
  out.semispan = H.clone().add(out.fing[0]).x;
  out.bind = { S: S.clone(), E, W, H, T: out.fing.map((v) => H.clone().add(v)) };
  return out;
}

/** Default stroke / pose parameters (a blend state). All angles in radians. */
export function defaultParams() {
  return {
    phase: 0,       // 0..1
    freq: 1.3,      // Hz (used by the twist feed-forward)
    airspeed: 30,   // m/s (twist feed-forward)
    a: 1,           // flap amount 0 (locked glide) .. 1
    amp: 30 * DEG,  // half amplitude of the shoulder elevation
    psi0: 0,        // mean elevation relative to the bind (which already has ~6 deg of dihedral)
    down: 0.56,     // downstroke fraction
    snap: 0.3,      // hang at reversals / snap mid-stroke
    sweep0: -5 * DEG,
    sweepOsc: 7 * DEG,   // tip forward on the downstroke (oval/figure-8 path)
    fig8: 2.5 * DEG,     // 2:1 Lissajous term
    tilt: 14 * DEG,      // stroke-plane tilt: the downstroke also goes forward
    fold: 0.55,          // upstroke fold
    tuck: 0,             // dive tuck 0..1
    flare: 0,            // flare/brake 0..1
    twistD: 0,           // twist bias on the downstroke (+ = supinate, leading edge up)
    twistU: -8 * DEG,    // unloading bias on the upstroke
    kff: 1,              // twist feed-forward gain (pronation against flap inflow)
    incidence: 4 * DEG,  // root incidence
    washout: -3 * DEG,
    camber: 0.5,         // membrane billow 0..1 (visual + physics camber)
    whip: 0.35,          // hand lag behind the arm (overlapping action)
    beat: 0,             // power-beat weight (extra elevation reach, deeper fold)
    cup: 0,              // wave 6: membranes cupped into the air in a move's pull (CUP: raised, forward, billowed, supinated)
    hover: 0,            // flight modes: hover stroke weight 0..1 (HOVER: near-horizontal stroke plane, deep strokes)
    hoverPitch: 0,       // rad: the body's pitch above its rest hover pitch (the stroke plane tilts with it: thrust stays up)
    hoverKff: null,      // the hover downstroke pronation for this wing (flight.js calibrates it per rig geometry; null: HOVER.kff)
    load: 1,             // wing load (g, filtered): the spars bend up above 1 g (down under a push), see LOAD_BEND
    soarT: 0,            // s, the soaring clock: slow gliding adjustments of shoulder, hand and fingers (SOAR)
    // scripted stroke overlay (power beat, dodge): w blends each wing's elevation/fold toward its prog values;
    // kffDown/kffUp: pronation feed-forward while that wing moves down (low: big normal force) / up (feathered)
    prog: { w: 0, kffDown: 0.4, kffUp: 1, tilt: 14 * DEG },
    // per-wing asymmetry (roll/yaw/pitch controls) and per-wing scripted stroke, set by the mixer
    L: { twist: 0, elev: 0, fold: 0, sweep: 0, prog: { psi: 0, psiDot: 0, fold: 0 } },
    R: { twist: 0, elev: 0, fold: 0, sweep: 0, prog: { psi: 0, psiDot: 0, fold: 0 } },
  };
}

/** Normalised stroke position s(phase) with a downstroke fraction and reversal "hang". */
function strokeS(phase, down, snap) {
  const p = phase - Math.floor(phase);
  const u = p < down ? 0.5 * p / down : 0.5 + 0.5 * (p - down) / (1 - down);
  return u - snap * Math.sin(4 * Math.PI * u) / (4 * Math.PI);
}
/** Elevation curve (cos of stroke): +1 at the top (phase 0), -1 at the bottom (phase = down). */
export function strokeCurve(phase, down, snap) { return Math.cos(TAU * strokeS(phase, down, snap)); }
/** Smooth downstroke weight 1 in the downstroke, 0 in the upstroke. */
function downWeight(phase, down, lead = 0.03) {
  const p = ((phase + lead) % 1 + 1) % 1;
  const r = 0.06;
  return smooth01(p / r) * (1 - smooth01((p - down) / r));
}
/** Upstroke fold window, starts in the late downstroke, peaks mid-upstroke, done at the top. */
function foldWindow(phase, down) {
  const p = ((phase % 1) + 1) % 1;
  const t = clamp((p - down + 0.05) / (1 - down + 0.02), 0, 1);
  const s = Math.sin(Math.PI * t);
  return s * s;
}

const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _ax = new THREE.Vector3();
const AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);
const _v = new THREE.Vector3(), _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();

function makeSide() {
  return {
    shoulder: new THREE.Quaternion(), elbow: new THREE.Quaternion(), wrist: new THREE.Quaternion(),
    fingers: [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()],
    fold: 0, camber: 0, sweep: 0, twist: 0, elev: 0, span: 0, psiDot: 0, downstroke: true,
    // body-frame joint positions (metres): S shoulder, E elbow, W wrist, H finger roots, T[i] finger tips
    joints: { S: new THREE.Vector3(), E: new THREE.Vector3(), W: new THREE.Vector3(), H: new THREE.Vector3(),
      T: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()], TE: new THREE.Vector3() },
    // segment orientations in the body frame (products of the joint chain), handy for visuals
    seg: { humerus: new THREE.Quaternion(), forearm: new THREE.Quaternion(), hand: new THREE.Quaternion(),
      fingers: [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()] },
    mass: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()],   // point-mass positions
  };
}

/** Allocate a pose object (contract shape: pose.L / pose.R / pose.body). */
export function createPose() {
  return {
    L: makeSide(), R: makeSide(),
    body: { neckPitch: 0, tailPitch: 0, legTuck: 1, bob: 0, tailYaw: 0, hover: 0 },
    phase: 0, downstroke: true, flapAmount: 0, stroke: 0,
  };
}

// Roll / yaw asymmetry limits outside scripted strokes (feel fix): in a bank the inner wing may rise and fold only a
// little — a strongly folded inner wing read as a broken wing. The roll then comes mostly from differential twist.
// Soft (C1) limits, blended out while a scripted stroke (dodge tuck-roll, power beat) runs: those keep their shape.
export const ASYM_LIMITS = { elev: 4 * DEG, fold: 0.12, knee: 0.6 };
function softLimit(x, cap, knee = ASYM_LIMITS.knee) {
  const ax = Math.abs(x), k = knee * cap;
  if (ax <= k) return x;
  const r = cap - k;
  return Math.sign(x) * (k + r * Math.tanh((ax - k) / r));
}
function asymElev(prm, w) {
  const pw = clamp(prm.prog.w, 0, 1);
  return pw >= 1 ? w.elev : w.elev + (softLimit(w.elev, ASYM_LIMITS.elev) - w.elev) * (1 - pw);
}
function asymFold(prm, w) {
  const pw = clamp(prm.prog.w, 0, 1);
  return pw >= 1 ? w.fold : w.fold + (softLimit(w.fold, ASYM_LIMITS.fold) - w.fold) * (1 - pw);
}

// Wave 4 (critic: "the wings freeze into rigid planks in banked glides, no load bending at 3 g").
// Load bending: per g above 1 the shoulder lifts, the hand bends up at the wrist and the finger spars curl up (caps),
// ≈ +0.35 m of tip rise per g; scaled out by the dive tuck. Under a push (< 1 g) the wing droops the other way.
export const LOAD_BEND = { shoulder: 1.4 * DEG, wrist: 1.2 * DEG, finger: 1.5 * DEG, capG: 3.2, minG: -1 };
// Soaring: while gliding the wings keep working — slow shoulder / hand adjustments, a breathing finger fan and a
// trailing-edge flutter of the camber that grows with airspeed. Pure sines of the soaring clock (zero at t = 0, so the
// glide calibration is unchanged), both wings in phase (no roll moment), weight (1 − flap) · (1 − tuck) · (1 − flare).
export const SOAR = { hz: 0.42, shoulder: 2.5 * DEG, wrist: 2.2 * DEG, fanHz: 0.61, fan: 0.06, flutterHz: 2.3, flutter: 0.05 };
// Wave 6 — flight moves: in the pull of a wingover / loop the wings bite the air: raised a little, swept forward, the
// membrane billowed deeper and the leading edge up (supination). × prm.cup (0..1, blended by the flight mixer). The
// strips fly this shape too (more camber and incidence = more lift and drag — what you see is what flies).
export const CUP = { shoulder: 7 * DEG, sweep: 11 * DEG, camber: 0.3, sup: 5 * DEG };
// Flight modes (user: "the dragon should not always fly forward, only with a button"): the HOVER stroke. With the body
// pitched up ~28° (flight.js spec.hover.pitch) the stroke plane is tilted forward (tilt): the downstroke sweeps down AND
// forward, the upstroke up and back, so in the world the tips row a near-horizontal oval — the hovering stroke of a big
// bat / a kestrel. Deep (the mixer gives ~48° half amplitude at ~2.1 Hz), raised a little (psi0), a wider oval
// (sweepOsc / fig8), the chord meeting the stroke's own inflow at ~30–40° (kff: less pronation than in forward flight,
// where the forward speed adds to the inflow), a hand flick on the upstroke (flick: the hand supinates and folds, a tip-
// reversal upstroke), full camber. Body hints: the head held level (the neck bends down against the pitched body), the
// tail hangs down as the balance and counters the stroke's pitch swing (tailSway), the legs dangle. × prm.hover (0..1,
// blended by the flight mixer) — what you see is what flies: the strips fly this stroke (the lift it makes is measured
// by the hover controller, which only tops up the rest).
// Measured with the body held still at V = 0 (node, hero wing, ρ 1.04, the stroke 44° / 2.0 Hz): the cycle-mean force
// is 0.95 × the weight, 31° ahead of body-up (the pronation sets that axis: kff 0.05 → 25°, 0.15 → 34°; the tilt moves
// it < 6°), peaks 5.6 g mid-downstroke, −2.6 g as the wing flips at the top; 40° / 1.8 Hz → 0.63 g, 48° / 2.2 Hz → 1.36 g.
// kffPitch: the pronation change per radian of hoverPitch (the force axis follows the body when the aim pitches it).
export const HOVER = { tilt: 50 * DEG, psi0: 7 * DEG, sweepOsc: 13 * DEG, fig8: 5 * DEG, kff: 0.12, kffPitch: 0.64, flick: 0, fold: 0.82,
  camber: 0.25, neck: -0.34, tail: -0.42, tailSway: 0.08, legs: 0 };
function hoverW(prm) { return clamp(prm.hover || 0, 0, 1) * (1 - clamp(prm.tuck, 0, 1)); }
function loadG(prm) { return clamp((prm.load ?? 1) - 1, LOAD_BEND.minG, LOAD_BEND.capG) * (1 - prm.tuck); }
function soarW(prm) { return clamp(1 - prm.a, 0, 1) * (1 - prm.tuck) * (1 - clamp(prm.flare, 0, 1)); }

// Wave 5 (critic physics #5 via the dragon owner: "the cruise stroke is biased upward, +35° / −17° at the tips, the
// power stroke ends near horizontal; from the side the bottom of the stroke is a thin edge-on sliver"):
//  - low: the stroke reaches further DOWN than up — the elevation curve c (+1 top … −1 bottom) is shaped to
//    c − low·((1 − c)/2)², monotonic and smooth (the top is unchanged, the bottom is (1 + low) × amp, mid-stroke
//    −low/4 × amp); psiDot is its exact rate (central difference of the same curve). low is what it takes for the
//    bottom to reach `bottom` (≤ lowMax): the cruise strokes (20–34°) get it, the 37° W / boost strokes almost not
//    (low 0.03), so their thrust — the W / Shift speed gains — stays about where it was;
//  - droop: the hand leads the downstroke — it bends down at the wrist (about the forward axis, like the whip) from
//    the top, fully from ~55 % of the downstroke to the bottom, released in the first 30 % of the upstroke.
//    Mid-downstroke the hand membrane then faces the side camera instead of being edge-on, and the tips reach
//    −35…−45° at the bottom. × flap amount; out with the dive tuck, the flare and the scripted strokes (they have their
//    own shape), and below ~26 m/s (droopV: slow, near the stall, the hand stays in line — a zoom climb's recovery).
// Both change the strips the physics flies with (what you see is what flies); the calibration follows. Tuned with
// node/flight.test.mjs: W +12.8 / Shift +17.4 m/s in 4 s (wave 4: +12.5 / +16.2), cruise effort 0.58 (0.63), aim
// response and bank peaks within the wave-4 checks.
export const STROKE_SHAPE = { bottom: 38 * DEG, lowMax: 0.3, droop: 20 * DEG, droopPeak: 0.55, droopBottom: 1.55, droopRelease: 0.4,
  droopV: [22, 30],               // m/s: the droop fades in with airspeed — slow, near the stall the hand stays in line (full lift)
  droopAmp: [32 * DEG, 37 * DEG] }; // the full-power 37° strokes (W, boost) are deep already: no droop (their thrust as before)
/** Shaped stroke elevation (in units of the amplitude amp, rad) for the stroke curve value c (+1 top, −1 bottom). */
export function shapeStroke(c, amp) {
  const S = STROKE_SHAPE, low = amp > 1e-3 ? clamp(S.bottom / amp - 1, 0, S.lowMax) : 0;
  const u = (1 - c) * 0.5;
  return c - low * u * u;
}
/** Flapping shoulder elevation (rad) for the stroke curve value c, flap amount a and half amplitude amp. */
export function strokeElevation(c, a, amp) { return a * amp * shapeStroke(c, amp); }
function droopV(V, amp) {
  const [a, b] = STROKE_SHAPE.droopV, [a0, a1] = STROKE_SHAPE.droopAmp;
  return smooth01(((V ?? b) - a) / (b - a)) * (1 - smooth01((amp - a0) / (a1 - a0)));
}
/** Hand droop weight 0..1 at a stroke phase (see STROKE_SHAPE). */
function droopW(phase, down) {
  const S = STROKE_SHAPE, p = phase - Math.floor(phase);
  if (p < down) {
    const u = p / down;
    if (u < S.droopPeak) { const s = Math.sin(0.5 * Math.PI * u / S.droopPeak); return s * s; }
    return 1 - (1 - S.droopBottom) * smooth01((u - S.droopPeak) / (1 - S.droopPeak));
  }
  return S.droopBottom * (1 - smooth01((p - down) / ((1 - down) * S.droopRelease)));
}

function angles(prm, w, phase) {
  // Shoulder elevation and sweep of one wing (w = its asymmetry block) at a stroke phase.
  const a = prm.a;
  const amp = prm.amp * (1 + 0.25 * prm.beat);
  const c = strokeCurve(phase, prm.down, prm.snap);
  const sN = strokeS(phase, prm.down, prm.snap);
  const psiFlap = strokeElevation(c, a, amp);
  const soar = soarW(prm) * SOAR.shoulder * Math.sin(TAU * SOAR.hz * (prm.soarT || 0));
  const cup = prm.cup || 0;
  // hover (flight modes): the stroke plane tilts forward (HOVER.tilt, + the body's pitch above its rest hover pitch, so
  // the rowed oval stays level in the world), deeper oval, raised stroke centre
  const hv = hoverW(prm);
  const tilt = prm.tilt + (HOVER.tilt + (prm.hoverPitch || 0) - prm.tilt) * hv;
  const sOsc = prm.sweepOsc + (HOVER.sweepOsc - prm.sweepOsc) * hv, f8 = prm.fig8 + (HOVER.fig8 - prm.fig8) * hv;
  const psi = prm.psi0 + psiFlap + asymElev(prm, w) + prm.tuck * 14 * DEG + prm.flare * 16 * DEG
    + loadG(prm) * LOAD_BEND.shoulder + soar + cup * CUP.shoulder + HOVER.psi0 * hv;
  let sweep = prm.sweep0 + w.sweep + a * (sOsc * Math.sin(TAU * sN) + f8 * Math.sin(2 * TAU * sN))
    - Math.tan(tilt) * psiFlap * 0.6
    - prm.tuck * 42 * DEG + prm.flare * 20 * DEG + cup * CUP.sweep;
  return { psi, sweep, c };
}

/**
 * Joint rotations of one wing in the canonical LEFT frame (w = prm.L or prm.R: that wing's asymmetry and scripted
 * stroke). The right wing is computed the same way and mirrored by the caller.
 */
function evalWing(prm, w, geom, out) {
  const phase = prm.phase;
  const a = prm.a;
  let { psi, sweep } = angles(prm, w, phase);
  // Elevation rate by central difference of the same curve (rad/s): drives pronation/supination.
  const dp = 0.004;
  const psiA = angles(prm, w, phase + dp).psi, psiB = angles(prm, w, phase - dp).psi;
  let psiDot = (psiA - psiB) / (2 * dp) * prm.freq;
  let lagA = angles(prm, w, phase - 0.07).psi;
  const pg = w.prog, pw = prm.prog.w;
  if (pw > 0) {
    // Scripted stroke: same offsets as the flap curve, stroke-plane tilt coupling included.
    const cupP = prm.cup || 0;
    const off = asymElev(prm, w) + prm.tuck * 14 * DEG + prm.flare * 16 * DEG + loadG(prm) * LOAD_BEND.shoulder + cupP * CUP.shoulder;
    const psiP = pg.psi + off;
    const sweepP = prm.sweep0 + w.sweep - Math.tan(prm.prog.tilt) * (pg.psi - prm.psi0) * 0.6 - prm.tuck * 42 * DEG + prm.flare * 20 * DEG
      + cupP * CUP.sweep;
    psi += (psiP - psi) * pw;
    sweep += (sweepP - sweep) * pw;
    psiDot += (pg.psiDot - psiDot) * pw;
    lagA += (psiP - pg.psiDot * 0.06 - lagA) * pw;
  }

  // Twist command per segment: pronate against the flap-induced inflow at three radii (k_ff), plus biases.
  const V = Math.max(prm.airspeed, 6);
  let wD = downWeight(phase, prm.down);
  if (pw > 0) wD += ((pg.psiDot < 0 ? 1 : 0) - wD) * pw;
  let kff = pw > 0 ? prm.kff + ((pg.psiDot < 0 ? prm.prog.kffDown : prm.prog.kffUp) - prm.kff) * pw : prm.kff;
  // hover: less pronation in the downstroke (the chord meets the stroke's own inflow at an angle: lift), feathered on the
  // way up, then the hand flicks (supinates) through the upstroke — the tip-reversal of a hovering bat (× the stroke)
  const hvW = hoverW(prm) * (1 - pw);
  if (hvW > 0) kff += (1 + ((prm.hoverKff ?? HOVER.kff) + HOVER.kffPitch * (prm.hoverPitch || 0) - 1) * wD - kff) * hvW;
  const flick = hvW * HOVER.flick * (1 - wD) * a;
  const bias = prm.twistU + (prm.twistD - prm.twistU) * wD;
  const ffArm = Math.atan(psiDot * geom.rArm / V) * kff;
  const ffHand = Math.atan(psiDot * geom.rHand / V) * kff;
  const ffTip = Math.atan(psiDot * geom.rTip / V) * kff;
  const aBias = a * bias;
  const flareSup = prm.flare * 26 * DEG + (prm.cup || 0) * CUP.sup;
  const tw = w.twist;
  let rhoS = clamp(prm.incidence + ffArm + aBias * 0.5 + tw * 0.5 + flareSup * 0.6, -40 * DEG, 40 * DEG);
  let rhoHand = clamp(ffHand + aBias + tw + flareSup + flick * 0.6, -45 * DEG, 45 * DEG);
  let rhoTip = clamp(ffTip + aBias + tw + prm.washout + flareSup + flick, -50 * DEG, 50 * DEG);
  const rhoW = (rhoHand - rhoS) * (1 - prm.tuck);
  const rhoF = (rhoTip - rhoHand) * (1 - prm.tuck);
  rhoS *= (1 - prm.tuck * 0.8);

  // Fold: upstroke fold (flap), dive tuck, flare (full extension), control fold (roll).
  const fw = foldWindow(phase - 0.02, prm.down);
  let foldFlap = a * (prm.fold + (HOVER.fold - prm.fold) * hvW) * fw * (1 + 0.35 * prm.beat);
  if (pw > 0) foldFlap += (pg.fold - foldFlap) * pw;
  const fold = clamp(foldFlap + asymFold(prm, w), 0, 1);
  const tuck = prm.tuck;
  const elbow = fold * 64 * DEG + tuck * 96 * DEG - prm.flare * 6 * DEG;
  const wristFlex = fold * 118 * DEG + tuck * 128 * DEG - prm.flare * 4 * DEG;
  const sw = soarW(prm), st = prm.soarT || 0, lg = loadG(prm);
  const close = clamp(0.8 * fold + tuck * 0.92 + sw * SOAR.fan * Math.sin(TAU * SOAR.fanHz * st), 0, 1);
  // Hand lag (whip): the hand trails the arm through the reversals; + the load bend and the soaring hand motion.
  // (+ the downstroke hand droop, STROKE_SHAPE: the hand leads the arm down)
  const whip = clamp((lagA - psi) * prm.whip * Math.max(a, pw), -25 * DEG, 25 * DEG)
    + lg * LOAD_BEND.wrist + sw * SOAR.wrist * Math.sin(TAU * SOAR.hz * st)
    - STROKE_SHAPE.droop * a * (1 - pw) * (1 - tuck) * (1 - clamp(prm.flare, 0, 1)) * droopV(prm.airspeed, prm.amp) * droopW(phase, prm.down);

  // Shoulder = elevation about body forward, then sweep about the elevated up axis, then twist about the humerus.
  _q1.setFromAxisAngle(AZ, psi);
  _q2.setFromAxisAngle(AY, -sweep);
  _q3.setFromAxisAngle(geom.hAxis, -rhoS);
  out.shoulder.copy(_q1).multiply(_q2).multiply(_q3);
  // Elbow flexes forward (the forearm swings toward the head as the wing folds).
  out.elbow.setFromAxisAngle(AY, -elbow);
  // Wrist flexes backward, lags in the stroke plane, and pronates the hand about the leading spar.
  _q1.setFromAxisAngle(AY, wristFlex);
  _q2.setFromAxisAngle(AZ, whip);
  _q3.setFromAxisAngle(geom.mAxis, -rhoW);
  out.wrist.copy(_q1).multiply(_q2).multiply(_q3);
  // Fingers: fan closes toward f1, trailing spars twist (tip washout / pronation), curl gives camber.
  const flutter = sw * SOAR.flutter * clamp((prm.airspeed - 20) / 30, 0, 1) * Math.sin(TAU * SOAR.flutterHz * st);
  const camber = clamp(prm.camber * (0.6 + 0.6 * wD * Math.max(a, pw)) * (1 - 0.8 * fold) * (1 - tuck) + prm.flare * 0.35 + flutter
    + (prm.cup || 0) * CUP.camber * (1 - tuck) + HOVER.camber * hvW * wD, 0, 1);
  const f1d = geom.fingDir[0];
  for (let i = 0; i < 4; i++) {
    const closeAng = (f1d - geom.fingDir[i]) * DEG * close * [0, 0.55, 0.8, 0.95][i];
    const spreadExtra = prm.flare * [0, -3, -5, -6][i] * DEG;   // flare fans the hand wide
    const curl = -(2 + 5 * camber) * DEG * (i === 0 ? 0.6 : 1) - whip * 0.25 + LOAD_BEND_SIGN * lg * LOAD_BEND.finger * [1, 0.8, 0.6, 0.4][i];
    const k = [0, 0.6, 0.85, 1.0][i];
    _q1.setFromAxisAngle(geom.f1Axis, -rhoF * k);
    _q2.setFromAxisAngle(AY, -(closeAng) + spreadExtra);
    _v.copy(geom.fing[i]).normalize();
    _ax.set(-_v.z, 0, _v.x);            // in-plane perpendicular: rotation about it lifts/lowers the tip
    _q3.setFromAxisAngle(_ax.normalize(), curl);
    out.fingers[i].copy(_q1).multiply(_q2).multiply(_q3);
  }
  out.fold = Math.max(fold, tuck);
  out.camber = camber;
  out.sweep = sweep;
  out.twist = rhoHand;
  out.elev = psi;
  out.psiDot = psiDot;
  return out;
}

/** Forward kinematics of one side (canonical left frame): joint positions, segment rotations, point masses. */
function fk(side, geom) {
  const j = side.joints, sg = side.seg;
  side.teScallop = geom.teScallop;
  j.S.copy(geom.S);
  sg.humerus.copy(side.shoulder);
  j.E.copy(geom.h).applyQuaternion(sg.humerus).add(j.S);
  sg.forearm.copy(sg.humerus).multiply(side.elbow);
  j.W.copy(geom.f).applyQuaternion(sg.forearm).add(j.E);
  sg.hand.copy(sg.forearm).multiply(side.wrist);
  j.H.copy(geom.m).applyQuaternion(sg.hand).add(j.W);
  for (let i = 0; i < 4; i++) {
    sg.fingers[i].copy(sg.hand).multiply(side.fingers[i]);
    j.T[i].copy(geom.fing[i]).applyQuaternion(sg.fingers[i]).add(j.H);
  }
  j.TE.copy(geom.te);
  side.mass[0].copy(j.S).add(j.E).multiplyScalar(0.5);
  side.mass[1].copy(j.E).add(j.W).multiplyScalar(0.5);
  side.mass[2].copy(j.H).lerp(j.T[1], 0.35);
  side.span = Math.max(j.T[0].x, j.T[1].x, j.W.x);
}

function mirrorSide(src, dst) {
  const mq = (a, b) => b.set(a.x, -a.y, -a.z, a.w);
  const mv = (a, b) => b.set(-a.x, a.y, a.z);
  mq(src.shoulder, dst.shoulder); mq(src.elbow, dst.elbow); mq(src.wrist, dst.wrist);
  for (let i = 0; i < 4; i++) { mq(src.fingers[i], dst.fingers[i]); mq(src.seg.fingers[i], dst.seg.fingers[i]); mv(src.joints.T[i], dst.joints.T[i]); }
  mq(src.seg.humerus, dst.seg.humerus); mq(src.seg.forearm, dst.seg.forearm); mq(src.seg.hand, dst.seg.hand);
  const j = src.joints, k = dst.joints;
  mv(j.S, k.S); mv(j.E, k.E); mv(j.W, k.W); mv(j.H, k.H); mv(j.TE, k.TE);
  for (let i = 0; i < 3; i++) mv(src.mass[i], dst.mass[i]);
  dst.fold = src.fold; dst.camber = src.camber; dst.sweep = src.sweep; dst.twist = src.twist; dst.elev = src.elev;
  dst.span = src.span; dst.psiDot = src.psiDot; dst.teScallop = src.teScallop;
}

const _tmpSide = makeSide();
// sign of the finger curl that lifts a finger tip (checked by FK in tests/flight.test.mjs: load bending lifts the tips)
const LOAD_BEND_SIGN = 1;

/**
 * Evaluate the full pose for the stroke parameters. Writes into `pose` (from createPose()) and returns it.
 * geom = buildGeometry(scale).
 */
export function evaluatePose(prm, geom, pose = createPose()) {
  evalWing(prm, prm.L, geom, pose.L);
  fk(pose.L, geom);
  evalWing(prm, prm.R, geom, _tmpSide);
  fk(_tmpSide, geom);
  mirrorSide(_tmpSide, pose.R);
  const c = strokeCurve(prm.phase, prm.down, prm.snap);
  const p = ((prm.phase % 1) + 1) % 1;
  pose.phase = p;
  pose.downstroke = prm.prog.w > 0.5 ? (prm.L.prog.psiDot < 0 || prm.R.prog.psiDot < 0) : p < prm.down;
  pose.L.downstroke = prm.prog.w > 0.5 ? prm.L.prog.psiDot < 0 : pose.downstroke;
  pose.R.downstroke = prm.prog.w > 0.5 ? prm.R.prog.psiDot < 0 : pose.downstroke;
  pose.flapAmount = prm.a;
  pose.stroke = c;
  // Secondary-motion hints: neck counter-bobs, tail pitches in antiphase (lagged), legs trail except in flare.
  const lagC = strokeCurve(prm.phase - 0.15, prm.down, prm.snap);
  const b = pose.body;
  b.neckPitch = (-0.05 * c * prm.a) + prm.flare * 0.35 - prm.tuck * 0.12;
  b.tailPitch = 0.05 * lagC * prm.a + prm.flare * -0.35 + prm.tuck * 0.05;
  b.legTuck = clamp(1 - prm.flare * 1.2, 0, 1);
  // hover: the head held level (the neck bends down against the pitched-up body), the tail hangs as the balance and
  // swings against the stroke (up while the wings row down), the legs dangle
  const hv = hoverW(prm);
  b.hover = hv;
  if (hv > 0) {
    b.neckPitch += (HOVER.neck - 0.6 * (prm.hoverPitch || 0)) * hv;
    b.tailPitch += (HOVER.tail + HOVER.tailSway * lagC) * hv;
    b.legTuck = Math.min(b.legTuck, 1 - (1 - HOVER.legs) * hv);
  }
  // Wing-mass counter-motion of the body (m_w/M ~ 0.13): the body drops as the wings rise.
  b.bob = -0.13 * 0.5 * (pose.L.mass[2].y + pose.R.mass[2].y - 2 * geom.S.y) * 0.35;
  return pose;
}

// ---------------------------------------------------------------------------------------------------------------
// Strip geometry — spanwise sections (leading edge point, trailing edge point) per wing, body frame.
// Sections: shoulder | elbow | finger roots | 35 % of f1 | 68 % of f1 | f1 tip. Strip i spans sections i..i+1:
// 0 inner arm wing, 1 outer arm wing, 2..4 hand wing. Returns the number of sections (6).
// ---------------------------------------------------------------------------------------------------------------
export const SECTION_COUNT = 6;
export const STRIPS_PER_WING = SECTION_COUNT - 1;

export function makeSections() {
  return Array.from({ length: SECTION_COUNT }, () => ({ le: new THREE.Vector3(), te: new THREE.Vector3() }));
}

/** Fill `sections` (makeSections()) with LE/TE points for one side of `pose` (body frame). */
export function wingSections(side, sections) {
  const j = side.joints;
  sections[0].le.copy(j.S); sections[0].te.copy(j.TE);
  // propatagium: the arm wing's leading edge is the straight shoulder->wrist line ahead of the arm bones
  const lse = j.S.distanceTo(j.E), lew = j.E.distanceTo(j.W);
  sections[1].le.copy(j.S).lerp(j.W, lse / Math.max(1e-6, lse + lew));
  sections[1].te.copy(j.TE).lerp(j.T[3], 0.5);
  // the arm-wing trailing edge is concave (it bulges toward the arm, like the membrane mesh)
  _v.subVectors(j.E, sections[1].te);
  const ln = _v.length();
  if (ln > 1e-6) sections[1].te.addScaledVector(_v, Math.min(0.45, side.teScallop / ln));
  sections[2].le.copy(j.H); sections[2].te.copy(j.T[3]);
  sections[3].le.copy(j.H).lerp(j.T[0], 0.36); sections[3].te.copy(j.T[2]);
  sections[4].le.copy(j.H).lerp(j.T[0], 0.7); sections[4].te.copy(j.T[1]);
  sections[5].le.copy(j.T[0]); sections[5].te.copy(j.T[1]).lerp(j.T[0], 0.78);
  return SECTION_COUNT;
}

/**
 * Convert sections into aerodynamic strips (body frame). strips[i] = { r, s, c, n, chord, width, area } where
 * r = quarter-chord mid-point, s = span unit (root->tip), c = chord unit (LE->TE, orthogonal to s),
 * n = upper normal (sideSign +1 left, -1 right). Returns total area.
 */
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _ca = new THREE.Vector3(), _cb = new THREE.Vector3();
export function stripsFromSections(sections, sideSign, strips) {
  let total = 0;
  for (let i = 0; i < SECTION_COUNT - 1; i++) {
    const A = sections[i], B = sections[i + 1], st = strips[i];
    _ca.subVectors(A.te, A.le); _cb.subVectors(B.te, B.le);
    // quarter-chord points of both sections
    _a.copy(A.le).addScaledVector(_ca, 0.25);
    _b.copy(B.le).addScaledVector(_cb, 0.25);
    st.r.addVectors(_a, _b).multiplyScalar(0.5);
    st.s.subVectors(_b, _a);
    const width = st.s.length();
    if (width > 1e-6) st.s.multiplyScalar(1 / width); else st.s.set(sideSign, 0, 0);
    st.c.addVectors(_ca, _cb);
    st.c.addScaledVector(st.s, -st.c.dot(st.s));
    const cl = st.c.length();
    if (cl > 1e-6) st.c.multiplyScalar(1 / cl); else st.c.set(0, 0, -1);
    st.n.crossVectors(st.s, st.c).multiplyScalar(sideSign);
    // mean chord measured perpendicular to the span line
    const chA = Math.abs(_ca.dot(st.c)), chB = Math.abs(_cb.dot(st.c));
    st.chord = 0.5 * (chA + chB);
    st.width = width;
    st.area = st.chord * width;
    total += st.area;
  }
  return total;
}

export function makeStrips(n = STRIPS_PER_WING) {
  return Array.from({ length: n }, () => ({
    r: new THREE.Vector3(), s: new THREE.Vector3(), c: new THREE.Vector3(), n: new THREE.Vector3(),
    chord: 0, width: 0, area: 0,
  }));
}

/** Retarget a canonical pose rotation onto a bone: out = bindLocal * (bindModel^-1 * q * bindModel). */
export function retargetJoint(q, bindLocal, bindModel, out = new THREE.Quaternion()) {
  _qa.copy(bindModel).invert();
  _qb.copy(_qa).multiply(q).multiply(bindModel);
  return out.copy(bindLocal).multiply(_qb);
}

export { DEG };
