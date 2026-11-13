// Dragon = FlightBody (physics, actors/flight.js) + model (GLB or procedural fallback) + rider + combat Actor.
// Contract: docs/ARCHITECTURE.md "Dragons" and "Flight body <-> dragon visuals".
//   const d = new Dragon(game, { variant: 'hero'|'crimson'|'onyx', team, name, rider: 'kaede'|'knight', pos, heading });
//   d.controls (pilot writes each fixed step), d.steer(dir, { speed, urgency }), d.actor, d.root, d.mouth, d.mouthDir …
// Stepping: every Dragon joins a small driver system ('dragons', order 36: after pilots 30/32, before fire 40), so
// owners never have to step it. Calling d.fixedUpdate(dt) / d.update(dt, realDt) yourself is also fine: both are
// idempotent per frame. Pass { autoStep: false } to step it only yourself.
// Visual layers per frame (all procedural, all interpolated with game.time.alpha):
//   wings  <- body.state.pose (wingkin.js: joint rotations relative to the parent segment in BODY axes, bind = the
//             spread glide layout of dragon-fallback.js), retargeted as bone.q = bindLocal * (B^-1 q B); plus a
//             small visual spar bend on the downstroke and membrane billow/flutter in the vertex shader
//   neck/tail <- damped direction-spring chains driven by the body's angular velocity, acceleration and airflow
//   head   <- world-space gaze stabilisation (bird-like), jaw opens with breath
//   legs   <- tuck at speed, dangle when slow, swing with acceleration; torso bend in turns, breathing, wing-mass bob
import * as THREE from 'three';
import { clamp, damp, lerp, smoothstep } from '../core/util.js';
import { instanceGLB, loadGLB } from '../core/assets.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { createFallbackDragon, patchMembrane, patchMembraneOutline, patchVolume, volumeUniforms, disposeInstance, addCacheKey, DRAGON_PALETTES, GLB_EYES, GLB_HORNS, Rig, canonicalWingFrames, dragonLeafLength, trackGLB, instanceSync } from './dragon-fallback.js';
import { Rider } from './rider.js';
import { ROW } from '../vfx/textures.js';

// FlightBody comes from actors/flight.js and wing poses from actors/wingkin.js (flight owner). If they are missing, a
// tiny local stub + the WingCycle below keep the visuals testable.
let FLIGHT = null, WK = null;
try { FLIGHT = await import('./flight.js'); } catch (e) { console.warn('[dragon] actors/flight.js not available, using the local flight stub', e?.message || e); }
try { WK = await import('./wingkin.js'); } catch (e) { console.warn('[dragon] actors/wingkin.js not available, using the local wing cycle', e?.message || e); }

const DEG = Math.PI / 180;
const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3(), _v5 = new THREE.Vector3();
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();
const CANON_SHOULDER = new THREE.Vector3(0.42, 0.42, 0.95);   // wingkin WING_GEOMETRY.shoulder (scale 1)
const MOUTH_Z = new Map();                                     // GLB name -> bind snout z (model frame)
// Wave 4: hind-leg tuck as absolute sagittal angles (deg; 0 = straight down, + = toward the tail): thigh back-down,
// shin and foot folded back along the underside of the tail base (see _installHandlers).
const HIND_TUCK_DEG = [64, 98, 92];
const HEAVE_HIST = 96;                                         // heave history (render frames) for the tail's travelling wave
const HEAVE_GAIN = 1.3;                                        // amplification of the beat's oscillating counter-bob
const TAIL_WAVE = 8.5 * DEG, NECK_WAVE_MAX = 6 * DEG;            // tail tip counter-wave per unit beat; neck flex limit
// Hit reactions (visual springs in the model frame + a bounded physical angular kick; see _hitReact).
const REACT = { rockHz: 1.6, rockZeta: 0.34, rock: 4.2, recoilHz: 2.2, recoilZeta: 0.5, recoil: 5, tumbleW: 3.2,
  flailT: 0.45, keep: 0.3, rampT: 0.1, kickDegS: 70 };
// Flight moves (24.09, the user: "make the dragon controls more interesting") — visual body language on top of the
// physics for the move contract (docs/modules/dragon.md "Flight moves"): wingover, loop (Immelmann), dash, the dodge
// as a barrel roll, fireball charge, inferno, cloud / terrain skim. Nothing here writes the physics. Angles in degrees.
// A/B: ?dragonMoves=0 turns the whole layer off, ?dragonRoll=0 only the dodge barrel roll.
const MOVE_NAMES = new Set(['wingover', 'loop', 'dash', 'inferno']);
const MV = {
  attack: 9, release: 3.2,                                   // 1/s: envelopes in / out
  wingover: { dur: 1.45, hold: 0.5, tuck: 0.5, pump: 1.35, bend: 9, neck: 14, gaze: 48, tail: 18, tailUp: 4 },
  loop: { dur: 2.3, hold: 0.6, arch: 9, neck: 22, gaze: 40, tail: 16, spread: 0.3, rollTuck: 0.3 },
  dash: { end: 1.0, up: 0.1, down: 0.3, psiUp: 56, psiDown: -46, sweep: 0.62, neck: -8, heave: 0.28,
    pumpScripted: 1.2, pumpMax: 10, sweepScripted: 0.3 },
  inferno: { dur: 4.3, rear: 0.3, neck: 32, pitch: 8, gazeUp: 58, tail: -10, jaw: 0.64, spread: 0.3, shudder: 0.8 },
  charge: { jaw: 0.2, coil: 10, puff: 3 },
  skim: { shoulder: 10, droop: 22, neck: -7 },
  roll: { T: 0.72 },
  strike: { hz: 4.5, zeta: 0.45, kick: 12, neck: -10 },         // kick: a full charge's strike ≈ 1 (neck −10°, jaw 0.32)
  pumpMax: 20,                                               // cap of the extra shoulder rotation when pumping
};
const NECK_SHARE = [0.22, 0.2, 0.18, 0.16, 0.13, 0.11];     // Σ 1: a move's neck bend, most at the base
const TAU = Math.PI * 2;
// Hover (24.09, the user: "the dragon should not always fly forward — only with a button"): body language for the flight
// modes (docs/modules/dragon.md "Hover / aim / survival"). The physics hovers (flight.js spec.hover: the body pitched up,
// wingkin HOVER stroke, the lift axis turned into a strafe / a brake / a take-off); this layer only draws on top of it:
// the hovering neck (an S: base raised, the head looking level), the head's wider reach, the tail hanging as the balance
// (it counters the head, the strafe's acceleration, the aim), legs dangling as pendulums under the apparent gravity,
// the strafe lean (a top-up of the physical bank), climb / sink postures (a deeper stroke, wings raised in a parachute
// V), the FLARE when W is released at speed (wings thrown forward and braced, tail down, legs reaching forward, the
// neck bending forward so the head keeps the aim while the body rears up) and the forward-lean TAKE-OFF when W is
// pressed (nose down, power strokes, legs snapped up, neck stretched).
// A visual pitch top-up exists only for a physics that does not pitch the body up itself (else it is 0). Angles in deg.
// A/B: ?dragonHover=0 turns the layer off; review knob (Dragon Studio): ?dragonHover=hover|flare|takeoff|strafeL|
// strafeR|climb|sink.
const HV = {
  pitchMin: 22, pitchTopMax: 24, displayPitch: 28,           // the drawn body's pitch-up in a hover (top-up only)
  neckS: 9, turret: 1.3, gazeUpMax: 0.9, gazeDownMax: 1.15, headLim: 0.62,
  neckHintK: 1, neckHintTau: 0.3, tailHintMax: 0.2, tailCurl: 6,    // the flight hints (neckPitch / tailPitch), capped
  tailStrafe: 1.6, tailStrafeMax: 14, tailHead: 0.28, tailAim: 0.3,
  legFront: { hz: 1.25, zeta: 0.3, k: 0.6 }, legHind: { hz: 0.95, zeta: 0.26, k: 0.9 }, legSagMax: 60, legLatMax: 34,
  strafeV: 7.5, strafeLean: 12, strafePump: 0.14,
  climbV: [1.5, 5], climbPump: 0.12, climbNeck: 5, climbTail: -6,
  sinkLift: 11, sinkAmp: 0.78, sinkLegs: -10, sinkTail: 5,
  flare: { decel: [2, 7], speed: [5, 12], attack: 6, release: 2.2, pitch: 7, pitchUntil: [20, 40], wings: 0.42, sweep: 16, tail: -16, legsF: -12, legsH: -16, neck: -6, knee: 14 },
  takeoff: { accel: [1.2, 4.5], speed: [20, 30], attack: 6, release: 2.4, dip: 6, pump: 0.24, neck: -8, recent: 0.7 },
  cup: 0.12, downwash: [6, 7],                                // extra membrane billow on the downstroke; the scarf's downwash (m/s)
};
// Distance / view LOD (24.09, Survival: up to ~26 enemy dragons at once). Tiers by the size-normalised camera distance:
// 0 < 120 m (casts shadows: only near Sora could an enemy's shadow land on something in view), 1 < 380 (every ink line,
// cloth, the rider's full detail), 2 < 900 (a Shade Rider keeps its violet ink — readability; the rider's ink and the
// hero-style ink off), 3 < 1600 (skeleton every 2nd frame, the rider left out — ≤ 1.5 px at DPR 1), 4 beyond (skeleton
// every 4th frame, no ink, no trails). Enemies outside the final camera's frustum (+ a margin; never while the planar
// water reflection is drawn) leave the scene graph: no bone matrices, draws, shadow draws or traversals; their skeleton
// is solved every 6th frame so hit shapes, wing tips and the mouth stay current, and on the frame they come back into
// view before it is drawn. The player's and display dragons stay tier 0. Solve frames are staggered by the dragon id.
// A/B: ?dragonLod=0 (the LOD before 24.09: 380 m / 1.6 km, skeleton every 3rd frame far away), ?dragonCull=0.
const LOD = { d: [120, 380, 900, 1600], every: [1, 1, 1, 2, 4], culledEvery: 6, margin: 18, radius: 14 };
const _sph = new THREE.Sphere(), _frus = new THREE.Frustum(), _frusM = new THREE.Matrix4();
// Levels and elements (25.09, the user: "the more enemies the dragon kills, the higher its level … the fire changes colour,
// later it shoots lightning"). game.progress (gameplay owner, actors/progression.js) is READ; the player's dragon shows it:
// membrane back-light, eye and mouth glow in the element's colour, a faint elemental aura (an additive hull + rim) that
// grows with the level, arcs crawling over the horns and wing spars at the lightning / storm tiers, and a level-up pose
// on the 'levelup' event (rear up + roar, wings flared, ≈ 0.8 s). Visual only: nothing here writes the physics, the
// controls or game.progress. Enemies unchanged. Colours sRGB, hues from progression.js ELEMENT_INFO; k = HDR factors.
// A/B: ?dragonElements=0 (the whole layer off), ?dragonLevelPose=0 (no pose). Review knobs (player / Dragon Studio hero):
// ?dragonElement=<name>[&dragonLevel=N], ?dragonMove=levelup[&dragonMoveT=0.3].
const ELEMENTS = {
  // membrane back-light: glow colour, its mix into the albedo, strength, always-on base; membA / membB = the GLB
  // membrane albedo gradient (spar → trailing edge; the painted veins stay as luminance detail) — ember keeps Sora's own
  ember: { glow: '#ffd08a', mix: 0.5, memb: 1.35, base: 0.2, membA: '#e2892a', membB: '#fdd27a', eye: '#ffb648', core: '#fff1c2',
    halo: '#ff8a2a', aura: '#ff7a1e', aura2: '#ffc860', spar: '#ffa040', arc: null, arc2: null, arcs: 0, flick: 0 },
  azure: { glow: '#5cb8ff', mix: 0.7, memb: 1.5, base: 0.24, membA: '#2466d0', membB: '#8ad2ff', eye: '#8fe6ff', core: '#e6fbff',
    halo: '#3fb0ff', aura: '#2a86ff', aura2: '#7fe0ff', spar: '#6cc4ff', arc: null, arc2: null, arcs: 0, flick: 0 },
  radiant: { glow: '#fff0c0', mix: 0.6, memb: 1.75, base: 0.3, membA: '#e6a436', membB: '#fff4cc', eye: '#fffbea', core: '#ffffff',
    halo: '#ffe6a0', aura: '#ffc844', aura2: '#fff6d6', spar: '#ffe8a8', arc: null, arc2: null, arcs: 0, flick: 0 },
  lightning: { glow: '#8fdcff', mix: 0.75, memb: 1.7, base: 0.28, membA: '#2f78e6', membB: '#c4eeff', eye: '#eafbff', core: '#f4fdff',
    halo: '#8fd8ff', aura: '#2e9cff', aura2: '#7fd6ff', spar: '#a8e8ff', arc: '#9fe4ff', arc2: '#5ab4ff', arcs: 30, flick: 1 },
  // (storm: gold at the spars into electric ice at the trailing edge — "lightning + gold fire", never ember's amber again)
  storm: { glow: '#9adcff', mix: 0.6, memb: 1.8, base: 0.3, membA: '#f0a01c', membB: '#7ccfff', eye: '#fff4cc', core: '#bfeaff',
    halo: '#ffc83a', aura: '#ffb024', aura2: '#7fd8ff', spar: '#ffe29a', arc: '#a8e8ff', arc2: '#ffd666', arcs: 44, flick: 0.7 },
};
const ELEM_TIER = { ember: 1, azure: 2, radiant: 3, lightning: 4, storm: 5 };
// aura (hull + rim) by level (index = level − 1): nothing at level 1 (the look before 25.09), a faint glow from level 2
const LEVEL_AURA = [0, 0.16, 0.3, 0.4, 0.52, 0.62, 0.74, 0.84, 0.94, 1.0];
const ELEM_K = {
  fade: 0.7,                                                  // s: colour crossfade when the element changes
  rim: 0.26, spar: [0, 0, 0.25, 0.35, 0.9, 1.1],              // in-material rim (× aura) · membrane spar glow by tier (0 = none)
  hull: 1.15, push: [0.1, 0.3],                               // hull strength (× aura) · push along the normal (m) at aura 0 → 1
  eye: [1.0, 1.5, 2.0, 2.4, 2.8], eyeSize: 0.12,              // eye glow HDR by tier · point size (m: ≈ 7 px in the chase view, 25 px from the saddle)
  mouthIdle: [0, 0.12, 0.2, 0.26, 0.34], mouthBreath: [0, 0.45, 0.6, 0.75, 0.9],    // smoulder between the jaws · while breathing
  flash: 2.2, flashBig: 3.2,                                  // level-up flash of the aura / eyes / membranes (element change: big)
};
// the level-up pose (deg / 0..1): rear up about the CG, spine arched, neck and gaze skyward (the gaze only while not
// breathing: the flame keeps the aim), jaws wide (roar), tail down, wings flared, spread and raised, a power shudder
const LV = { dur: 0.8, attack: 0.12, release: 0.34, pitch: 13, arch: 7, neck: 24, gazeUp: 52, tail: -12, jaw: 0.62,
  flare: 0.45, spread: 0.45, raise: 20, shudder: 0.6 };
const lvEnvelope = (t) => (t < 0 ? 0 : smoothstep(0, LV.attack, t) * (1 - smoothstep(LV.dur - LV.release, LV.dur, t)));
function newHoverState(game) {
  const p = game.params;
  return {
    on: p?.get?.('dragonHover') !== '0', knob: p?.get?.('dragonHover') || null,
    hv: 0, fl: 0, to: 0, recent: 0, np: 0, climb: 0, sink: 0, strafe: 0, ax: 0, err: false,
    leg: { FL: [0, 0, 0, 0], FR: [0, 0, 0, 0], BL: [0, 0, 0, 0], BR: [0, 0, 0, 0] },   // [sag, sagV, lat, latV] per leg
    gM: new THREE.Vector3(0, -9.81, 0),
    out: { on: false, hv: 0, fl: 0, to: 0, climb: 0, sink: 0, strafe: 0, pitchTop: 0, leanTop: 0, bodyPitch: 0,
      neckUp: 0, neckS: 0, neckHint: 0, hold: 0, turret: 0, headLim: 0, tailUp: 0, tailYaw: 0, tailCurl: 0, legTuck: 0,
      legsF: 0, legsH: 0, knee: 0, down: new THREE.Vector3(), cup: 0 },
  };
}
/** 'left' | 'L' | −1 → −1, 'right' | 'R' | +1 → +1, anything else 0 (+1 = the dragon's right, model −X). */
function normSide(s) {
  if (typeof s === 'string') { const ch = s[0]?.toLowerCase(); return ch === 'l' ? -1 : ch === 'r' ? 1 : 0; }
  const n = +s;
  return n < 0 ? -1 : n > 0 ? 1 : 0;
}
function approach(x, want, dt, up, down) { return dt > 0 ? lerp(x, want, damp(want > x ? up : down, dt)) : x; }
/** q's rotation angle scaled by k, the extra angle capped at maxExtra (rad); into out. */
function scaleRot(q, k, maxExtra, out) {
  let { x, y, z, w } = q;
  if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
  const s = Math.sqrt(x * x + y * y + z * z);
  if (s < 1e-7) return out.copy(q);
  const ang = 2 * Math.atan2(s, w), a2 = Math.max(0, Math.min(ang * k, ang + maxExtra));
  const f = Math.sin(a2 / 2) / s;
  return out.set(x * f, y * f, z * f, Math.cos(a2 / 2));
}
/** The right wing's version of a left-wing (canonical) rotation: wingkin's mirror (x, −y, −z, w). */
function mirrorQ(q, out) { return out.set(q.x, -q.y, -q.z, q.w); }
function newMoveState(game) {
  const p = game.params, num = (k) => { const v = parseFloat(p?.get?.(k)); return Number.isFinite(v) ? v : null; };
  const knobName = p?.get?.('dragonMove') || null;         // review knob for display dragons (Dragon Studio)
  return {
    on: p?.get?.('dragonMoves') !== '0', rollOn: p?.get?.('dragonRoll') !== '0',
    knob: knobName || num('dragonCharge') != null || num('dragonSkim') != null
      ? { name: knobName, t: num('dragonMoveT'), side: normSide(num('dragonMoveSide') ?? 1) || 1, charge: num('dragonCharge'), skim: num('dragonSkim') } : null,
    cur: null, evt: { name: null, side: 0, on: false }, special: false, chargeEv: null, skimEvt: 0, yawW: 0,
    w: { wingover: 0, loop: 0, inferno: 0, charge: 0, skim: 0, pull: 0, top: 0 },
    inf: { on: false, t: 0 }, dodge: { prev: 0, t: -1, dir: 0, base: 0, end: 0, angle: 0, rate: 0 },
    lv: { t: -1, big: 0, level: 0, n: 0, on: p?.get?.('dragonLevelPose') !== '0' },     // 25.09: the level-up pose's clock
    strike: { x: 0, v: 0 }, near: 0, sideWarn: false, err: false,
    mean: { L: new THREE.Quaternion(), R: new THREE.Quaternion(), init: false }, refs: null, glow: null,
    out: { on: false, wo: 0, side: 1, woLead: 0, woPull: 0, lp: 0, pull: 0, rollTop: 0, da: 0, sw: 0, scripted: false, inf: 0, rear: 0,
      ch: 0, sk: 0, roll: 0, rollAngle: 0, rollRate: 0, strike: 0, near: 0, arch: 0, bend: 0, neckUp: 0, neckYaw: 0, coil: 0,
      tailYaw: 0, tailUp: 0, calm: 0, jaw: 0, tuck: 0, pitch: 0, heave: 0, shudder: 0, gaze: new THREE.Vector3(0, 0, 1), gazeW: 0,
      lv: 0, lvRaw: 0, name: null, t: 0 },
  };
}
/** 25.09 — levels and elements: the player's element look (see ELEMENTS; built lazily, only for the player / the Studio hero). */
function newElementState(game) {
  const p = game.params, knob = p?.get?.('dragonElement');
  const lvl = parseInt(p?.get?.('dragonLevel'), 10);
  return {
    on: p?.get?.('dragonElements') !== '0', knob: ELEMENTS[knob] ? knob : null, knobLevel: Number.isFinite(lvl) ? clamp(lvl, 1, 10) : null,
    active: false, name: null, tier: 1, level: 1, fade: 1, snap: true, aura: 0, flash: 0, big: 0, memFlash: 0, burst: 0, err: false,
    from: null, to: null, cur: null, U: null, mats: null, hull: null, arcs: null, eyes: null, eyeLocal: null, hornLocal: null,
    mouthK: 0, mouth: null, t: 0,
    out: { element: null, tier: 0, level: 0, aura: 0, flash: 0, arcs: 0, hull: 0, eye: 0, mouth: 0, lv: 0 },
  };
}

export const DRAGON_DEFAULTS = {
  hero: { hp: 600, mass: 1100, model: 'dragon_hero', rider: 'kaede', team: 'player', name: 'Sora' },
  crimson: { hp: 220, mass: 900, model: 'dragon_crimson', rider: 'knight', team: 'enemy', name: 'Shade Rider' },
  onyx: { hp: 320, mass: 1350, model: 'dragon_crimson', rider: 'knight', team: 'enemy', name: 'Onyx Rider' },
  // Drake: a small riderless wyvern of the Shade Riders' flocks (the crimson model at ≈ 0.55 scale, violet membranes).
  // Physics: DRAGON_SPECS.drake (flight owner); if that is missing, the crimson spec scaled down (drakeSpec()).
  drake: { hp: 70, mass: 350, model: 'dragon_crimson', rider: null, riderless: true, team: 'enemy', name: 'Shade Drake', scale: 0.55 },
};

/** Crimson spec scaled to a drake, for a flight.js without DRAGON_SPECS.drake. */
function drakeSpec(specs) {
  const base = specs?.crimson || specs?.hero;
  if (!base) return null;
  const s = structuredClone(base);
  s.name = 'drake'; s.scale = DRAGON_DEFAULTS.drake.scale; s.mass = DRAGON_DEFAULTS.drake.mass;
  if (s.pilot) s.pilot.cruise = 36;
  return s;
}

/** One shared env per game (flight.js makeEnv resolves world wind / titan wind lazily on every call). */
function sharedEnv(game) {
  if (game.__dragonEnv) return game.__dragonEnv;
  const env = FLIGHT?.makeEnv ? FLIGHT.makeEnv(game) : {
    gravity: 9.81, airDensity: (y) => 1.225 * Math.exp(-Math.max(0, y) / 8500),
    wind: null, heightAt: (x, z) => game.world?.heightAt?.(x, z) ?? 0, seaLevel: game.world?.seaLevel ?? 0,
  };
  // An older makeEnv captured world.wind at creation time: bind it late if the world publishes wind afterwards.
  if (!env.wind) {
    let bound = null;
    Object.defineProperty(env, 'wind', {
      configurable: true, enumerable: true,
      get() { const w = game.world?.wind; if (!w) return null; if (!bound) bound = (p, out) => w.call(game.world, p, out); return bound; },
    });
  }
  game.__dragonEnv = env;
  return env;
}

/**
 * 24.09 (many dragons): bones never render, but the renderer's projectObject, the pipeline's traverseVisible and the
 * shadow pass walk every visible node — 50 dragon + ~60 rider bones per Shade Rider. A bone chain whose subtree holds
 * nothing but bones is marked invisible: those walks skip it, while its matrices still update (updateMatrixWorld does
 * not look at `visible`) and the skinning is unchanged. Chains with anything else under them (the head's eyes / mouth
 * glow, the saddle's rider) are left alone. Returns how many chains were hidden.
 */
export function hideBoneChains(root, names) {
  let n = 0;
  if (!root || !names?.length) return 0;
  const want = new Set(names);
  root.traverse((o) => {
    if (!o.isBone || !want.has(o.name) || o.visible === false) return;
    let onlyBones = true;
    o.traverse((c) => { if (!c.isBone) onlyBones = false; });
    if (onlyBones) { o.visible = false; o.userData.traversalHidden = true; n++; }
  });
  return n;
}

/** Non-enumerable back-reference (JSON.stringify of userData in Object3D.clone() must never walk into a Dragon). */
function hideRef(obj, key, value) {
  Object.defineProperty(obj, key, { value, configurable: true, enumerable: false, writable: true });
}
const WING_MAP = [['wing_shoulder', 'shoulder'], ['wing_elbow', 'elbow'], ['wing_wrist', 'wrist'],
  ['wing_f1', 0], ['wing_f2', 1], ['wing_f3', 2], ['wing_f4', 3]];

// ---------------------------------------------------------------------------------------------------------------
// Pose containers (contract shape). Rotations in body axes.
function makePose() {
  const side = () => ({ shoulder: new THREE.Quaternion(), elbow: new THREE.Quaternion(), wrist: new THREE.Quaternion(),
    fingers: [0, 1, 2, 3].map(() => new THREE.Quaternion()), fold: 0, camber: 0, sweep: 0, twist: 0, downstroke: true, psiDot: 0 });
  return { L: side(), R: side(), body: { neckPitch: 0, tailPitch: 0, legTuck: 1, bob: 0 }, phase: 0, flapAmount: 0 };
}
function copyPose(dst, src) {
  for (const s of ['L', 'R']) {
    const a = dst[s], b = src?.[s];
    if (!b) continue;
    b.shoulder && a.shoulder.copy(b.shoulder); b.elbow && a.elbow.copy(b.elbow); b.wrist && a.wrist.copy(b.wrist);
    if (b.fingers) for (let i = 0; i < 4; i++) b.fingers[i] && a.fingers[i].copy(b.fingers[i]);
    a.fold = b.fold ?? 0; a.camber = b.camber ?? 0; a.sweep = b.sweep ?? 0; a.twist = b.twist ?? 0;
    a.downstroke = b.downstroke ?? true; a.psiDot = b.psiDot ?? 0;
  }
  if (src?.body) { const B = dst.body, S = src.body; B.neckPitch = S.neckPitch || 0; B.tailPitch = S.tailPitch || 0; B.legTuck = S.legTuck ?? 1; B.bob = S.bob || 0; }
  dst.phase = src?.phase ?? 0; dst.flapAmount = src?.flapAmount ?? 0;
  return dst;
}
function lerpPose(out, a, b, t) {
  for (const s of ['L', 'R']) {
    const o = out[s], p = a[s], q = b[s];
    o.shoulder.slerpQuaternions(p.shoulder, q.shoulder, t);
    o.elbow.slerpQuaternions(p.elbow, q.elbow, t);
    o.wrist.slerpQuaternions(p.wrist, q.wrist, t);
    for (let i = 0; i < 4; i++) o.fingers[i].slerpQuaternions(p.fingers[i], q.fingers[i], t);
    o.fold = lerp(p.fold, q.fold, t); o.camber = lerp(p.camber, q.camber, t);
    o.sweep = lerp(p.sweep, q.sweep, t); o.twist = lerp(p.twist, q.twist, t);
    o.downstroke = t < 0.5 ? p.downstroke : q.downstroke; o.psiDot = lerp(p.psiDot, q.psiDot, t);
  }
  for (const k of ['neckPitch', 'tailPitch', 'legTuck', 'bob']) out.body[k] = lerp(a.body[k] || 0, b.body[k] || 0, t);
  out.phase = b.phase; out.flapAmount = lerp(a.flapAmount, b.flapAmount, t);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Display gaits (sandbox / photo / title screens): the flight owner's wingkin driven directly with named presets,
// so what the sandbox shows is exactly what flies. Values mirror FlightBody's mixer (flight.js spec.flap).
const DISPLAY_GAITS = {
  glide: { a: 0, freq: 1.2, amp: 26, fold: 0.75, tuck: 0, flare: 0, beat: 0 },
  cruise: { a: 1, freq: 1.3, amp: 28, fold: 0.75, tuck: 0, flare: 0, beat: 0 },
  power: { a: 1, freq: 2.2, amp: 37, fold: 0.75, tuck: 0, flare: 0, beat: 0.5 },
  hover: { a: 1, freq: 1.5, amp: 46, fold: 0.85, tuck: 0, flare: 0.25, beat: 0.3, sweepOsc: 12, fig8: 7, tilt: 32 },
  dive: { a: 0, freq: 1.2, amp: 26, fold: 0.75, tuck: 1, flare: 0, beat: 0 },
  flare: { a: 0.75, freq: 1.25, amp: 30, fold: 0.75, tuck: 0, flare: 1, beat: 0 },
  takeoff: { a: 1, freq: 2.2, amp: 40, fold: 0.75, tuck: 0, flare: 0, beat: 0.5 },
};
class DisplayWings {
  constructor(scale = 1, noWingkin = false, hoverSpec = null) {
    this.phase = 0.2; this.freeze = false; this.freq = 0;
    if (WK && !noWingkin) {
      this.prm = WK.defaultParams(); this.geom = WK.buildGeometry(scale); this.pose = WK.createPose();
      this.b = { ...DISPLAY_GAITS.cruise, sweepOsc: 7, fig8: 2.5, tilt: 14, hover: 0 };
      // hover (flight modes): with the flight owner's wingkin HOVER stroke the display hover IS the flown stroke
      // (prm.hover = 1 at spec.hover's frequency / amplitude); an older wingkin keeps the legacy display preset
      this.hoverGait = WK.HOVER ? { a: 1, freq: hoverSpec?.freq ?? 2.1, amp: hoverSpec?.amp ?? 48, fold: 0.75, tuck: 0, flare: 0, beat: 0, hover: 1 } : null;
    } else this.cycle = new WingCycle();
  }
  setPhase(p) { this.phase = ((p % 1) + 1) % 1; if (this.cycle) this.cycle.setPhase(this.phase); }
  /** Jump the gait blend to its target (deterministic screenshots). */
  snap(gait, opts = {}) {
    this._target(gait, opts);
    if (this.b) Object.assign(this.b, this._t);
    else { const f = this.cycle.freeze; this.cycle.freeze = false; for (let i = 0; i < 240; i++) this.cycle.step(1 / 120, this._cmd(gait, opts)); this.cycle.freeze = f; }
  }
  _target(gait, opts) {
    const g = (gait === 'hover' && this.hoverGait) || DISPLAY_GAITS[gait] || DISPLAY_GAITS.cruise;
    this._t = { sweepOsc: 7, fig8: 2.5, tilt: 14, hover: 0, ...g };
    if (opts.breath) { this._t.a *= 0.35; this._t.amp *= 0.7; }
    return this._t;
  }
  _cmd(gait, opts) {
    return { gait: gait === 'dive' || gait === 'flare' || gait === 'takeoff' ? null : gait, flap: gait === 'glide' ? 0 : 0.5, power: gait === 'power' || gait === 'takeoff' ? 1 : 0,
      hover: gait === 'hover' ? 1 : 0, tuck: gait === 'dive' ? 1 : 0, flare: gait === 'flare' ? 1 : 0, breath: opts.breath ? 1 : 0,
      roll: opts.roll || 0, airspeed: opts.airspeed ?? 30 };
  }
  step(dt, gait, opts = {}) {
    if (this.cycle) {
      this.cycle.freeze = this.freeze;
      const p = this.cycle.step(dt, this._cmd(gait, opts));
      this.phase = this.cycle.phase; this.freq = this.cycle.freq;
      return p;
    }
    const t = this._target(gait, opts), b = this.b, k = damp(4, dt);
    for (const key of Object.keys(t)) b[key] = lerp(b[key] ?? t[key], t[key], key === 'freq' ? damp(2.5, dt) : k);
    if (!this.freeze) this.phase = (this.phase + b.freq * dt) % 1;
    this.freq = this.freeze ? 0 : b.freq;
    const P = this.prm;
    P.phase = this.phase; P.a = b.a; P.amp = b.amp * DEG; P.freq = b.freq; P.tuck = b.tuck; P.flare = b.flare; P.beat = b.beat;
    P.fold = b.fold; P.sweepOsc = b.sweepOsc * DEG; P.fig8 = b.fig8 * DEG; P.tilt = b.tilt * DEG;
    P.airspeed = opts.airspeed ?? 30; P.camber = 0.55 + 0.3 * b.flare; P.psi0 = 0; P.prog.w = 0;
    if ('hover' in P) { P.hover = clamp(b.hover || 0, 0, 1); P.hoverPitch = 0; }
    if (this.kff != null) P.kff = this.kff;          // the FlightBody's pronation feed-forward (or ?dragonKff= for reviews)
    const r = clamp(opts.roll || 0, -1, 1);
    P.L.twist = r * 16 * DEG; P.R.twist = -r * 16 * DEG; P.L.elev = -r * 6 * DEG; P.R.elev = r * 6 * DEG;
    P.L.fold = Math.max(0, -r) * 0.35; P.R.fold = Math.max(0, r) * 0.35;
    return WK.evaluatePose(P, this.geom, this.pose);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// WingCycle: local wing kinematics, used only when wingkin.js is missing (stub body / display). flight-physics.md §8
// shaping (lagged phases, snap downstroke, upstroke fold, figure-8 sweep, pronation, tip whip); rotations are
// authored in each bone's own frame and converted to body axes with the canonical wing frames.
const GAITS = {
  glide: { f: 1.2, A: 0, psi0: 3, D: 0.58, snap: 0.3, B1: 0, B2: 0, fold: 0 },
  cruise: { f: 1.3, A: 30, psi0: 4, D: 0.56, snap: 0.32, B1: 8, B2: 2, fold: 0.7 },
  climb: { f: 1.5, A: 40, psi0: 8, D: 0.6, snap: 0.4, B1: 12, B2: 4, fold: 0.85 },
  power: { f: 2.2, A: 40, psi0: 10, D: 0.6, snap: 0.5, B1: 14, B2: 6, fold: 0.9 },
  hover: { f: 1.5, A: 50, psi0: 10, D: 0.6, snap: 0.32, B1: 10, B2: 12, fold: 0.85 },
};
const GAIT_KEYS = ['f', 'A', 'psi0', 'D', 'snap', 'B1', 'B2', 'fold'];
const FOLD_CLOSE = [84, 60, 30, 0];
function strokeS(phi, D, snap) {
  const u = phi < D ? (0.5 * phi) / D : 0.5 + (0.5 * (phi - D)) / (1 - D);
  return u - (snap * Math.sin(4 * Math.PI * u)) / (4 * Math.PI);
}
const frac = (x) => x - Math.floor(x);
class Follower {
  constructor(f, z, r, x0 = 0) { this.k1 = z / (Math.PI * f); this.k2 = 1 / ((2 * Math.PI * f) ** 2); this.k3 = (r * z) / (2 * Math.PI * f); this.y = x0; this.yd = 0; this.xp = x0; }
  step(h, x) {
    if (h <= 0) return this.y;
    const xd = (x - this.xp) / h; this.xp = x;
    const k2 = Math.max(this.k2, (h * h) / 2 + (h * this.k1) / 2, h * this.k1);
    this.y += h * this.yd; this.yd += (h * (x + this.k3 * xd - this.y - this.k1 * this.yd)) / k2;
    return this.y;
  }
}
export class WingCycle {
  constructor() {
    this.phase = 0.2; this.p = { ...GAITS.cruise, A: 0 }; this.amp = 0; this.tuck = 0; this.flare = 0;
    this.pose = makePose(); this.whip = { L: new Follower(3, 0.35, 0), R: new Follower(3, 0.35, 0) };
    this.freeze = false; this.freq = 0; this.canon = canonicalWingFrames();
  }
  setPhase(ph) { this.phase = frac(ph); }
  step(dt, cmd = {}) {
    const k = damp(4.5, dt), kf = damp(2.2, dt);
    const mix = (a, b, t) => { const o = {}; for (const key of GAIT_KEYS) o[key] = lerp(a[key], b[key], t); return o; };
    let target;
    if (cmd.gait && GAITS[cmd.gait]) target = GAITS[cmd.gait];
    else {
      const e = clamp(cmd.flap ?? 0.5, 0, 1);
      target = e < 0.05 ? { ...GAITS.glide, f: this.p.f } : mix(GAITS.cruise, GAITS.climb, smoothstep(0.45, 0.85, e));
      if ((cmd.power ?? 0) > 0) target = mix(target, GAITS.power, clamp(cmd.power, 0, 1));
      if ((cmd.hover ?? 0) > 0) target = mix(target, GAITS.hover, clamp(cmd.hover, 0, 1));
    }
    for (const key of GAIT_KEYS) this.p[key] = lerp(this.p[key], target[key], key === 'f' ? kf : k);
    const want = (target.A > 0 ? 1 : 0) * (1 - clamp(cmd.tuck ?? 0, 0, 1)) * (1 - 0.8 * clamp(cmd.flare ?? 0, 0, 1)) * (1 - 0.55 * clamp(cmd.breath ?? 0, 0, 1));
    this.amp = lerp(this.amp, want, damp(3, dt));
    this.tuck = lerp(this.tuck, clamp(cmd.tuck ?? 0, 0, 1), damp(8, dt));
    this.flare = lerp(this.flare, clamp(cmd.flare ?? 0, 0, 1), damp(5, dt));
    if (!this.freeze) this.phase = frac(this.phase + Math.max(0.3, this.p.f) * dt);
    this.freq = this.freeze ? 0 : this.p.f;
    this._evaluate(dt, cmd);
    return this.pose;
  }
  _evaluate(dt, cmd) {
    const P = this.p, a = this.amp, tuck = this.tuck, flare = this.flare;
    const roll = clamp(cmd.roll ?? 0, -1, 1), pitch = clamp(cmd.pitch ?? 0, -1, 1);
    const A = P.A * DEG, D = P.D;
    const ang = (lag) => { const phi = frac(this.phase - lag), s = strokeS(phi, D, P.snap); return { phi, C: Math.cos(2 * Math.PI * s), Sn: Math.sin(2 * Math.PI * s), S2: Math.sin(4 * Math.PI * s) }; };
    const up = (phi) => { const x = clamp((phi - D + 0.04) / (1 - D), 0, 1); return Math.sin(Math.PI * x) ** 2; };
    const sh = ang(0), el = ang(0.03), wr = ang(0.06), fi = ang(0.09);
    for (const S of ['L', 'R']) {
      const out = this.pose[S];
      const fwd = S === 'L' ? -1 : 1, pro = S === 'L' ? 1 : -1, sideRoll = S === 'L' ? roll : -roll, inside = Math.max(0, -sideRoll);
      let psi = P.psi0 * DEG + a * A * sh.C + 4 * DEG * sideRoll;
      psi = lerp(lerp(psi, 22 * DEG, tuck), 30 * DEG, flare);
      let sig = a * (P.B1 * sh.Sn + P.B2 * sh.S2) * DEG + 7 * DEG * pitch;
      sig = lerp(lerp(sig, -32 * DEG, tuck), 20 * DEG, flare);
      const prS = lerp(a * 13 * DEG * sh.Sn, -26 * DEG, flare) + 5 * DEG * sideRoll;
      const foldAmt = clamp(a * P.fold * up(el.phi) + inside * 0.25, 0, 1);
      const eps = lerp(foldAmt * 38 * DEG, 112 * DEG, tuck) - 8 * DEG * flare;
      const om = lerp(1.25 * eps, 165 * DEG, tuck);
      const prW = a * 16 * DEG * wr.Sn - 12 * DEG * flare;
      const whip = this.whip[S].step(dt, psi);
      const curl = clamp((whip - psi) * 0.55, -25 * DEG, 25 * DEG) * (1 - tuck);
      const close = clamp(0.62 * a * P.fold * up(fi.phi) + tuck * 0.95 + inside * 0.1, 0, 1) - 0.06 * flare;
      const conv = (name, q, target) => { const C = this.canon.get(`${name}_${S}`); return target.copy(C).multiply(q).multiply(_q3.copy(C).invert()); };
      conv('wing_shoulder', _q1.setFromAxisAngle(Z, fwd * sig).multiply(_q2.setFromAxisAngle(X, psi)).multiply(_q3.setFromAxisAngle(Y, pro * prS)), out.shoulder);
      conv('wing_elbow', _q1.setFromAxisAngle(Z, fwd * eps).multiply(_q2.setFromAxisAngle(Y, pro * prS * 0.3)), out.elbow);
      conv('wing_wrist', _q1.setFromAxisAngle(Z, -fwd * om).multiply(_q2.setFromAxisAngle(Y, pro * prW)).multiply(_q3.setFromAxisAngle(X, curl * 0.35)), out.wrist);
      for (let i = 0; i < 4; i++) conv(`wing_f${i + 1}`, _q1.setFromAxisAngle(Z, -fwd * close * FOLD_CLOSE[i] * DEG).multiply(_q2.setFromAxisAngle(X, curl * (0.5 + 0.2 * i))), out.fingers[i]);
      out.fold = clamp(foldAmt + tuck, 0, 1); out.sweep = sig; out.twist = prS;
      out.downstroke = sh.phi < D; out.psiDot = -a * A * sh.Sn * 2 * Math.PI * P.f;
      out.camber = clamp(a * (out.downstroke ? 1 : -0.35) * Math.abs(sh.Sn) + 0.25 * (1 - tuck) + 0.5 * flare, 0, 1);
    }
    this.pose.body.neckPitch = -a * 0.04 * sh.C;
    this.pose.body.tailPitch = a * 0.05 * Math.cos(2 * Math.PI * (this.phase - 0.15));
    this.pose.body.legTuck = 1 - flare;
    this.pose.body.bob = -a * 0.1 * sh.C;
    this.pose.phase = this.phase; this.pose.flapAmount = a;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Local flight stub (only when actors/flight.js is missing). Arcade kinematics with FlightBody's public surface.
class StubFlightBody {
  constructor(spec = {}) {
    this.stub = true; this.mass = spec.mass || 1100; this.scale = 1;
    this.pos = new THREE.Vector3(); this.vel = new THREE.Vector3(0, 0, 30); this.quat = new THREE.Quaternion(); this.angVel = new THREE.Vector3();
    this.controls = { pitch: 0, roll: 0, yaw: 0, flap: 0.5, boost: 0, glide: 0, dive: 0, flare: 0, breath: 0, fireball: 0, dodge: 0, beat: 0 };
    this.wing = new WingCycle(); this.stamina = 1;
    this.state = { airspeed: 30, aoa: 0.08, sideslip: 0, gLoad: 1, lift: 0, drag: 0, thrust: 0, flapPhase: 0, flapRate: 1.3, flapAmp: 0, stamina: 1, pose: this.wing.pose };
    this.yaw = 0; this.pitch = 0; this.bank = 0; this.speed = 30; this.knock = new THREE.Vector3(); this.dodgeT = 0; this.dead = false;
  }
  reset(pos, heading = 0, speed = 30) { this.pos.copy(pos); this.yaw = heading; this.pitch = 0; this.bank = 0; this.speed = speed; this.dead = false; this._q(); this.vel.set(0, 0, speed).applyQuaternion(this.quat); }
  _q() { this.quat.setFromEuler(new THREE.Euler(-this.pitch, this.yaw, this.bank, 'YXZ')); }
  step(dt, env = {}) {
    const c = this.controls, g = env.gravity ?? 9.81;
    if (this.dead) {
      this.vel.y -= g * dt; this.vel.multiplyScalar(1 - 0.08 * dt);
      this.bank += dt * 1.6; this.pitch = lerp(this.pitch, -1.1, damp(0.8, dt)); this._q();
      this.pos.addScaledVector(this.vel, dt); this.state.airspeed = this.vel.length();
      this.wing.step(dt, { flap: 0, tuck: 0.4 });
      return;
    }
    if (c.dodge && this.dodgeT <= 0) { this.dodgeT = 0.55; this.dodgeDir = Math.sign(c.dodge); }
    c.dodge = 0; c.beat = 0;
    this.dodgeT = Math.max(0, this.dodgeT - dt);
    const roll = clamp(c.roll ?? 0, -1, 1), pitchC = clamp(c.pitch ?? 0, -1, 1);
    const prevBank = this.bank, prevPitch = this.pitch, prevYaw = this.yaw;
    this.bank = this.dodgeT > 0 ? this.dodgeDir * Math.PI * 2 * (1 - this.dodgeT / 0.55) : lerp(this.bank, roll * 72 * DEG, damp(3.2, dt));
    this.pitch = clamp(this.pitch + pitchC * 0.9 * dt, -1.35, 1.2);
    const vT = 30 + 14 * (c.boost ? 1 : 0) + 34 * (c.dive ? 1 : 0) - 12 * (c.flare || 0) + 5 * (c.flap || 0);
    this.speed = clamp(this.speed + ((vT - this.speed) * 0.55 - g * Math.sin(this.pitch) * 0.45) * dt, 8, 95);
    this.yaw += (-g * Math.tan(clamp(this.bank, -1.3, 1.3)) / Math.max(12, this.speed) + (c.yaw || 0) * 0.35) * dt;
    this._q();
    const F = _v1.set(0, 0, 1).applyQuaternion(this.quat);
    const prevVel = _v2.copy(this.vel);
    this.vel.copy(F).multiplyScalar(this.speed).add(this.knock);
    this.knock.multiplyScalar(1 - damp(1.5, dt));
    this.pos.addScaledVector(this.vel, dt);
    this.angVel.set(0, (this.yaw - prevYaw) / dt, 0).addScaledVector(_v3.set(1, 0, 0).applyQuaternion(this.quat), -(this.pitch - prevPitch) / dt).addScaledVector(F, (this.bank - prevBank) / dt);
    const acc = _v3.subVectors(this.vel, prevVel).divideScalar(dt), U = _v4.set(0, 1, 0).applyQuaternion(this.quat);
    const st = this.state;
    st.airspeed = this.speed; st.gLoad = (acc.dot(U) + g * U.y) / g;
    const prevPh = this.wing.phase;
    this.wing.step(dt, { flap: clamp((c.flap ?? 0.5) + (c.boost ? 0.3 : 0), 0, 1), power: c.boost ? 1 : 0, tuck: c.dive ? 1 : 0, flare: c.flare || 0,
      breath: c.breath ? 1 : 0, roll, pitch: pitchC, airspeed: this.speed });
    st.flapPhase = this.wing.phase; st.flapRate = this.wing.freq; st.flapAmp = this.wing.amp; st.pose = this.wing.pose;
    if (this.wing.phase < prevPh && this.wing.amp > 0.25) this.onBeat?.(this.wing.amp, this);
  }
  steer(dir, opts = {}) {
    const d = _v1.copy(dir).normalize(), c = this.controls;
    const e = ((Math.atan2(d.x, d.z) - this.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI, urg = opts.urgency ?? 0.6;
    c.roll = clamp(-e * (1.2 + urg), -1, 1);
    c.pitch = clamp((Math.asin(clamp(d.y, -1, 1)) - this.pitch) * (1.5 + urg), -1, 1);
    const sp = opts.speed ?? 30;
    c.flap = clamp(0.35 + (sp - this.speed) * 0.05, 0, 1); c.boost = sp > 44 ? 1 : 0;
  }
  applyImpulse(J) { this.knock.addScaledVector(J, 1 / this.mass); }
}

// ---------------------------------------------------------------------------------------------------------------
// Direction-spring chain (neck / tail), simulated in the model frame (flight-physics.md §9.3).
// Feel fix (24.09): the chain follows a KINEMATIC target — the tail lies along the flight path behind the body (each
// segment points where the body pointed Δs/V seconds ago, built by the caller into `bias`), the neck leads a little
// into the turn — and the spring only adds a stiff, near-critically damped follow-through on top. The old model
// (soft springs held in world space by the −ω×u frame term, apparent gravity divided by the segment length) lagged
// ≈ 0.8·Ω rad and whipped the tail tip 14–24° per joint, which read as a body snapped in half in turns.
//   load  = deviation of the apparent gravity from level 1 g (m/s², model frame), a small sag under g, clamped
//   frame = fraction of the −ω×u term kept (0 = rigidly carried by the body, only the target moves)
//   maxSeg = largest deviation of a segment from its target (rad): no kinks, never folds through itself
class SpringChain {
  constructor(n, { fBase, fTip, zBase, zTip, gain, aero = 0, frame = 0, maxSeg = 0.1 }) {
    this.n = n; this.u = []; this.w = []; this.freq = []; this.zeta = []; this.delta = [];
    for (let j = 0; j < n; j++) {
      const t = n > 1 ? j / (n - 1) : 0;
      this.u.push(new THREE.Vector3()); this.w.push(new THREE.Vector3()); this.delta.push(new THREE.Quaternion());
      this.freq.push(2 * Math.PI * lerp(fBase, fTip, t)); this.zeta.push(lerp(zBase, zTip, t));
    }
    this.gain = gain; this.aero = aero; this.frame = frame; this.cosMax = Math.cos(maxSeg); this.maxSeg = maxSeg;
    this.init = false;
  }
  simulate(dt, base, bindDir, len, bias, ctx) {
    const n = this.n, tgt = _v1, tmp = _v2;
    if (!this.init) {
      _q3.copy(base);
      for (let j = 0; j < n; j++) {
        this.u[j].copy(bindDir[j]).applyQuaternion(bias[j]).applyQuaternion(_q3); this.w[j].set(0, 0, 0);
        this.delta[j].copy(_q3).multiply(bias[j]); _q3.copy(this.delta[j]);
      }
      this.init = true;
    }
    if (!(dt > 0)) return;
    const steps = Math.max(1, Math.ceil(dt / (1 / 120))), h = dt / steps;
    for (let s = 0; s < steps; s++) {
      _q3.copy(base);
      for (let j = 0; j < n; j++) {
        const u = this.u[j], w = this.w[j], om = this.freq[j], ze = this.zeta[j];
        tgt.copy(bindDir[j]).applyQuaternion(bias[j]).applyQuaternion(_q3).normalize();
        tmp.subVectors(tgt, u).multiplyScalar(om * om).addScaledVector(w, -2 * ze * om);
        if (ctx.load && this.gain) { _v3.copy(ctx.load).multiplyScalar(this.gain); _v3.addScaledVector(u, -_v3.dot(u)); tmp.add(_v3); }
        if (this.aero && ctx.wind) {
          const V = ctx.wind.length();
          if (V > 1) { _v3.copy(ctx.wind).divideScalar(V); _v3.addScaledVector(u, -_v3.dot(u)); tmp.addScaledVector(_v3, this.aero * Math.min(V, 60)); }
        }
        w.addScaledVector(tmp, h);
        u.addScaledVector(w, h);
        if (this.frame) { _v3.crossVectors(ctx.omega, u); u.addScaledVector(_v3, -h * this.frame); }
        u.normalize();
        w.addScaledVector(u, -w.dot(u));
        // bounded bend: a segment stays within maxSeg of its target (soft), the excess velocity is absorbed
        const c = u.dot(tgt);
        if (c < this.cosMax) {
          const a = Math.acos(clamp(c, -1, 1));
          tmp.subVectors(u, tgt).multiplyScalar(this.maxSeg / Math.max(a, 1e-4));
          u.copy(tgt).add(tmp).normalize();
          _v3.subVectors(u, tgt);
          const away = w.dot(_v3);
          if (away > 0) w.addScaledVector(_v3, -away / Math.max(1e-6, _v3.lengthSq()));
          w.multiplyScalar(0.6);
        }
        this.delta[j].setFromUnitVectors(tgt, u).multiply(_q3).multiply(bias[j]);
        _q3.copy(this.delta[j]);
      }
    }
  }
}

/** Kinematic path-following / lead biases for a chain (feel fix). Writes per-segment rotations into `out`. */
const _pfAxis = new THREE.Vector3();
function pathBias(out, lens, omega, speed, sign, budget, lead) {
  const rate = omega.length(), n = out.length;
  if (rate < 1e-4) { for (let j = 0; j < n; j++) out[j].identity(); return 0; }
  _pfAxis.copy(omega).divideScalar(rate);
  const V = Math.max(12, speed);
  let total = 0;
  for (let j = 0; j < n; j++) {
    // tail: arc distance between successive segment midpoints / airspeed = how long ago the body pointed there
    const ds = lead != null ? lead / n * V : (j === 0 ? lens[0] * 0.5 : (lens[j - 1] + lens[j]) * 0.5);
    let a = rate * ds / V;
    if (total + a > budget) a = Math.max(0, budget - total);
    total += a;
    out[j].setFromAxisAngle(_pfAxis, sign * a);
  }
  return total;
}

// ---------------------------------------------------------------------------------------------------------------
// Driver system: steps every live dragon once per fixed step and once per frame (order 36).
function driver(game) {
  if (game.__dragonDriver) return game.__dragonDriver;
  const list = [];
  const sys = {
    name: 'dragons', list,
    fixedUpdate(dt) { for (const d of [...list]) d.fixedUpdate(dt); },
    update(dt, realDt) { for (const d of [...list]) d.update(dt, realDt); },
  };
  game.__dragonDriver = sys;
  if (!game.dragons) game.add(sys, 36);
  // (the off-screen cull runs after the camera rig — order 80 — with this frame's final camera, before the terrain LOD /
  // water reflection / pipeline renders)
  if (!game.dragonsCull && game.params?.get?.('dragonCull') !== '0') {
    game.add({
      name: 'dragonsCull',
      lateUpdate() {
        const cam = game.camera;
        if (!cam || !list.length) return;
        try {
          cam.updateMatrixWorld();
          _frus.setFromProjectionMatrix(_frusM.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
          const refl = !!game.water?.reflection?.active;
          for (const d of list) d._cullCheck(_frus, refl);
        } catch (e) { if (!sys._cullErr) { sys._cullErr = true; console.warn('[dragon] cull failed', e); } }
      },
    }, 97);
  }
  return sys;
}
let dragonSeq = 0;

// ---------------------------------------------------------------------------------------------------------------
export class Dragon {
  /** Warm the GLB cache during init (optional; the constructor works without it). */
  static preload(game, variants = ['hero', 'crimson']) {
    return Promise.all(variants.map((v) => loadGLB((DRAGON_DEFAULTS[v] || DRAGON_DEFAULTS.hero).model)));
  }

  /**
   * opts: variant, team, name, rider ('kaede'|'knight'|null), pos, heading (rad, 0 = +Z, + toward +X, or a Vector3),
   * speed, hp, autoStep (default true), model ('auto'|'glb'|'fallback'), display ({ gait, pos, quat, … } pins it).
   */
  constructor(game, opts = {}) {
    this.game = game;
    const variant = DRAGON_DEFAULTS[opts.variant] ? opts.variant : 'hero';
    const def = DRAGON_DEFAULTS[variant];
    this.variant = variant; this.palette = DRAGON_PALETTES[variant];
    this.id = ++dragonSeq;
    this.name = opts.name || def.name;
    this.team = opts.team || def.team;
    this.display = opts.display || null;
    this.modelMode = opts.model || game.params?.get?.('dragonModel') || 'auto';

    // --- physics body
    let body = null;
    const forceStub = !!game.params?.has?.('dragonStub');   // debug: exercise the no-flight.js path
    if (FLIGHT?.FlightBody && !forceStub) {
      const specs = FLIGHT.DRAGON_SPECS;
      const sp = specs?.[variant] || (variant === 'drake' ? drakeSpec(specs) : null) || specs?.hero;
      try { body = new FLIGHT.FlightBody(sp); } catch (e) { console.warn('[dragon] FlightBody failed, using the stub', e); }
    }
    this.body = body || new StubFlightBody({ mass: def.mass });
    if (this.body.stub && def.scale) this.body.scale = def.scale;
    this._mass0 = this.body.mass || def.mass;
    this.scale = this.body.scale || def.scale || 1;
    const pos = opts.pos ? opts.pos.clone() : new THREE.Vector3(0, 1400, 0);
    let heading = 0;
    if (typeof opts.heading === 'number') heading = opts.heading;
    else if (opts.heading?.isVector3) heading = Math.atan2(opts.heading.x, opts.heading.z);
    const speed = opts.speed ?? this.body.spec?.pilot?.cruise ?? 32;
    if (this.body.reset) this.body.reset(pos, heading, speed);
    const hq = new THREE.Quaternion().setFromAxisAngle(Y, heading);
    this.controls = this.body.controls;
    this.env = sharedEnv(game);                       // world wind + titan wind for every dragon (flight.js makeEnv)
    if (!this.body.onBeat) this.body.onBeat = (strength) => { if (this.alive) game.events.emit('wingbeat', { actor: this.actor, strength }); };
    // Crash damage for every dragon (FlightBody reports ground/sea contacts with normal speed > 4 m/s).
    if (!this.body.onCrash) this.body.onCrash = (info) => this._onCrash(info);
    this.handlesCrash = true;                         // pilots: do not add a second crash-damage path

    // --- scene graph: root follows the body (interpolated); visual carries the scale and the wing-mass bob.
    this.root = new THREE.Group();
    this.root.name = `dragon:${this.name}#${this.id}`;
    this.root.position.copy(pos); this.root.quaternion.copy(hq);
    hideRef(this.root.userData, 'dragon', this);
    game.scene.add(this.root);
    this.visual = new THREE.Group(); this.visual.name = 'dragon_visual';
    this.visual.scale.setScalar(this.scale);
    this.root.add(this.visual);
    // Camera anchors: wing tips (world, per frame) and the rider's eye point (Object3D, saddle-frame orientation).
    this.wingtips = { L: new THREE.Vector3().copy(pos), R: new THREE.Vector3().copy(pos) };
    this.seatAnchor = new THREE.Object3D(); this.seatAnchor.name = 'seatAnchor';
    this.seatAnchor.userData.kind = 'eye';

    // --- state
    this.pos = new THREE.Vector3().copy(pos);
    this.vel = new THREE.Vector3().copy(this.body.vel || _v1.set(0, 0, speed).applyQuaternion(hq));
    this.quat = new THREE.Quaternion().copy(hq);
    this.mouth = new THREE.Vector3().copy(pos);
    this.mouthDir = new THREE.Vector3(0, 0, 1).applyQuaternion(hq);
    this.heat = 0; this.overheated = false;
    this.alive = true; this.dying = false; this.removed = false; this.breathing = false;
    this.lookTarget = null;                           // optional world point the head watches (AI / lock-on)
    this.aimDir = null;                               // optional world direction (else cameraRig.aimDir for the player)
    this._prev = { pos: pos.clone(), quat: hq.clone(), pose: makePose() };
    this._cur = { pos: pos.clone(), quat: hq.clone(), pose: makePose() };
    if (this.body.state?.pose) { copyPose(this._prev.pose, this.body.state.pose); copyPose(this._cur.pose, this.body.state.pose); }
    this._pose = makePose();
    this._accel = new THREE.Vector3(); this._prevVel = this.vel.clone(); this._omega = new THREE.Vector3();
    this._lastFixed = -1; this._lastFrame = -1; this._flash = 0; this._breathEvt = false;
    this._shapeLocal = null; this._headWorld = null;
    this._wings = new DisplayWings(this.scale, forceStub, this.body.spec?.hover || null);
    const kffQ = parseFloat(game.params?.get?.('dragonKff'));
    this._wings.kff = Number.isFinite(kffQ) ? kffQ : (this.body.spec?.flap?.kff ?? null);
    this._legTuck = 1; this._legSwing = 0; this._legHeave = 0; this._jaw = 0; this._t = Math.random() * 10; this._bob = 0;
    this._lod = -1; this._lodSkip = 0; this._tier = -1; this._culled = false; this._riderHidden = false; this._lodLists = null; this._solvedFrame = -1;
    this._lodMode = game.params?.get?.('dragonLod') !== '0';
    // Wave 4 — weight: wingbeat heave / pitch / tail + neck waves (visual, on top of the physics), hit reactions.
    this._heave = { slow: 0, disp: 0, vel: 0, acc: 0, noseUp: 0, hN: 0, hist: new Float32Array(HEAVE_HIST), histT: new Float32Array(HEAVE_HIST).fill(-1e9), head: 0 };
    this._react = { rot: new THREE.Vector3(), rotV: new THREE.Vector3(), off: new THREE.Vector3(), offV: new THREE.Vector3(),
      tumble: 0, tumbleV: 0, tumbleT: 0, tumbleAxis: new THREE.Vector3(0, 0, 1), flail: { L: 0, R: 0 }, hitT: -1e9, ramp: [] };
    this._frameQ = new THREE.Quaternion().copy(hq);   // root × visual (the rendered body frame), for the head's world lock
    this._velEnd = this.vel.clone();                  // body velocity at the end of the last fixed step (impulse detector)
    this.stagger = null;                              // { t, until, strength, kind } after a heavy blow (read-only, for pilots)
    // 24.09 — flight moves: body language read from the move contract (dragon.moves / body.state.mode / events);
    // the Dragon never defines moves, momentum, special, fireCharge, infernoActive or skim itself (player.js writes them)
    this._mv = newMoveState(game);
    // 24.09 — hover / flight modes: body language read from game.player.flightMode / throttle and the flight body's
    // state.hover (the Dragon never defines flightMode, throttle, softTarget or inRange: player.js writes them)
    this._hv = newHoverState(game);
    // 25.09 — levels and elements: the player's element look (reads game.progress; see ELEMENTS)
    this._el = newElementState(game);

    // --- combat actor
    const hp = opts.hp ?? def.hp;
    this.actor = {
      name: this.name, kind: 'dragon', team: this.team, hp, maxHp: hp, alive: true,
      root: this.root, pos: this.pos, vel: this.vel, radius: 11 * this.scale, shapes: this._makeShapes(), invuln: 0,
      dragon: this,
      onHit: (rec) => { try { this._onHit(rec); } catch (e) { if (!this._hitErr) { this._hitErr = true; console.warn('[dragon] hit reaction failed', e); } } },
      onDeath: (rec) => { try { this._onDeath(rec); } catch (e) { console.warn('[dragon] death failed', e); } },
    };
    if (game.combat) game.combat.register(this.actor);
    else if (!game.actors.includes(this.actor)) game.actors.push(this.actor);

    // --- model (fallback now, GLB swapped in when it resolves) and rider
    this.riderKind = def.riderless || opts.rider === null ? null : (opts.rider || def.rider);
    // A GLB that already finished loading is instanced synchronously (no fallback frame); otherwise the fallback
    // shows until the download resolves (or forever, if there is no GLB).
    const cached = this.modelMode === 'fallback' ? null : trackGLB(def.model, loadGLB);
    let glb = null;
    if (cached) {
      try { this._setModel(this._prepareGLB(instanceSync(cached, cloneSkinned))); glb = Promise.resolve(true); } catch (e) { console.warn('[dragon] GLB instancing failed', e); }
    }
    if (!glb) {
      this._setModel(createFallbackDragon(game, variant));
      glb = this.modelMode === 'fallback' ? Promise.resolve(false) : this._loadGLB(def.model).catch((e) => { console.warn('[dragon] GLB swap failed', e); return false; });
    }
    if (this.riderKind) { this.rider = new Rider(game, { kind: this.riderKind, dragon: this, model: this.modelMode }); this._attachRider(); }
    this.ready = Promise.all([glb, this.rider?.ready]).then(([g]) => g);
    this._offBreath = game.events.on('breath', (e) => { if (e?.actor === this.actor || e?.actor === this) this._breathEvt = !!e.on; });
    try { this._offMoves = this._moveEvents(); } catch (e) { console.warn('[dragon] move events unavailable', e); }
    if (opts.autoStep !== false) driver(game).list.push(this);
    else this.manualStep = true;
  }

  // ------------------------------------------------------------------ read-only state (contract)
  get airspeed() { return this.body.state?.airspeed ?? this.vel.length(); }
  get aoa() { return this.body.state?.aoa ?? 0; }
  get altitude() { return this.pos.y; }
  get stamina() { return this.body.stamina ?? this.body.state?.stamina ?? 1; }
  get flapPhase() { return this.display ? this._wings.phase : (this.body.state?.flapPhase ?? 0); }
  get wingPose() { return this._pose; }
  get hp() { return this.actor.hp; }
  set hp(v) { this.actor.hp = v; }
  get canBreathe() { return this.alive && !this.overheated; }
  /** Total mass (dragon + rider), live from the FlightBody. */
  get mass() { return this.body?.mass || this._mass0 || 1000; }

  steer(targetDir, opts = {}) { if (this.alive && this.body.steer) this.body.steer(targetDir, opts); }

  /**
   * Momentum change (N s, world), optionally at a world point (angular part). opts.ramp (s, wave 4): a blow that is
   * struck rather than teleported — REACT.keep of it lands now, the rest as a force over `ramp` seconds (momentum is
   * the same). Attackers may use it for heavy knocks (the titan's swat knock).
   */
  applyImpulse(J, point, opts = null) {
    if (!J || !Number.isFinite(J.x + J.y + J.z)) return;
    const T = opts?.ramp > 0 && !this.body.stub && this.body.applyForce ? Math.min(0.3, opts.ramp) : 0;
    const now = T ? _v5.copy(J).multiplyScalar(REACT.keep) : J;
    if (this.body.applyImpulse) this.body.applyImpulse(now, point || null);
    else this.body.vel?.addScaledVector(now, 1 / this.mass);
    if (T) this._react.ramp.push({ F: J.clone().multiplyScalar((1 - REACT.keep) / T), at: point ? point.clone().sub(this.pos) : null, left: T });
  }

  /** Respawn / restart: physics reset, full HP, visible again. */
  reset(pos = this.pos, heading = null, speed = null) {
    const h = heading ?? this.body.state?.heading ?? 0;
    this.body.dead = false;
    this.body.reset?.(pos.clone ? pos.clone() : pos, h, speed ?? this.body.spec?.pilot?.cruise ?? 32);
    this.pos.copy(this.body.pos); this.quat.copy(this.body.quat); this.vel.copy(this.body.vel);
    this._prev.pos.copy(this.pos); this._cur.pos.copy(this.pos); this._prev.quat.copy(this.quat); this._cur.quat.copy(this.quat);
    this.actor.hp = this.actor.maxHp; this.actor.alive = true; this.actor.invuln = 1;
    this.alive = true; this.dying = false; this.heat = 0; this.overheated = false; this._exploded = false;
    this._neck.init = false; this._tail.init = false; this._headWorld = null;
    this._resetReact(); this._velEnd.copy(this.vel);
    this._moveReset();
    this._hoverReset();
    if (this.removed) {
      this.removed = false; this.game.scene.add(this.root);
      if (this.game.combat) this.game.combat.register(this.actor);
      driver(this.game).list.push(this);
    }
    if (this._shade) {
      this._shade.U.uShadeLife.value = 1;
      if (!this._trails) this._trails = new WingTrails(this.game, new THREE.Color(this._shade.sp.trail).multiplyScalar(this._shade.sp.trailK), this.scale);
      this._trails.reset();
    }
    this.game.fx?.smoke?.(this.root, false);
  }

  /** Sandbox / photo mode: pin the dragon and drive the wings from a named gait (wingkin presets). null releases. */
  setDisplay(d) {
    if (!d) { this.display = null; return; }
    this.display = { gait: 'cruise', speed: 30, ...this.display, ...d };
    if (d.snap) this._wings.snap(this.display.gait, this.display);
  }

  // ------------------------------------------------------------------ model
  _setModel(model) {
    if (this.model) {
      this.visual.remove(this.model.scene); this._disposeMaterials(this.model);
      // wave 4: the swapped-out model's skeletons (bone textures) and ink-hull materials (the rider is re-attached)
      if (this.rider?.root?.parent) this.rider.root.parent.remove(this.rider.root);
      if (this.seatAnchor.parent) this.seatAnchor.parent.remove(this.seatAnchor);
      disposeInstance(this.model.scene);
    }
    this.model = model;
    this.visual.add(model.scene);
    if (this._mv?.glow) { this._mv.glow.dispose(); this._mv.glow = null; }   // on the old head bone: rebuilt lazily
    if (this._mv) this._mv.refs = null;
    const rig = this.rig = new Rig(model, { leafLength: dragonLeafLength });
    this._neckIdx = ['neck1', 'neck2', 'neck3', 'neck4', 'neck5', 'neck6'].map((n) => rig.i(n)).filter((i) => i >= 0);
    this._tailIdx = ['tail1', 'tail2', 'tail3', 'tail4', 'tail5', 'tail6', 'tail7', 'tail8', 'tail9', 'tail10'].map((n) => rig.i(n)).filter((i) => i >= 0);
    // Feel fix: stiff, near-critically damped chains that follow kinematic targets (see SpringChain / pathBias).
    this._neck = new SpringChain(this._neckIdx.length, { fBase: 4.2, fTip: 3.6, zBase: 0.95, zTip: 0.9, gain: 0.025, maxSeg: 4 * DEG });
    this._tail = new SpringChain(this._tailIdx.length, { fBase: 3.4, fTip: 2.2, zBase: 0.9, zTip: 0.78, gain: 0.05, aero: 0.04, maxSeg: 5 * DEG });
    this._neckBias = this._neckIdx.map(() => new THREE.Quaternion());
    this._tailBias = this._tailIdx.map(() => new THREE.Quaternion());
    this._neckPath = this._neckIdx.map(() => new THREE.Quaternion());
    this._tailPath = this._tailIdx.map(() => new THREE.Quaternion());
    this._omegaF = new THREE.Vector3();               // low-passed body rate for the chains' path targets
    this._neckDir = this._neckIdx.map((i) => rig.dir[i]); this._neckLen = this._neckIdx.map((i) => rig.len[i]);
    this._tailDir = this._tailIdx.map((i) => rig.dir[i]); this._tailLen = this._tailIdx.map((i) => rig.len[i]);
    const hi = this._headIdx = rig.i('head');
    this._jawIdx = rig.i('jaw');
    const sock = rig.i('mouth') >= 0 ? rig.i('mouth') : rig.i('mouth_socket');
    if (model.mouth && hi >= 0 && (model.mouth.bone || 'head') === 'head') this._mouthLocal = model.mouth.offset.clone();
    else if (hi >= 0 && sock >= 0) this._mouthLocal = rig.Pb[sock].clone().sub(rig.Pb[hi]).divideScalar(rig.Sb[hi] || 1).applyQuaternion(rig.Qb[hi].clone().invert());
    else if (hi >= 0) {
      // snout tip from the bind bounding box (skinning every vertex is costly: measured once per GLB)
      let maxZ = MOUTH_Z.get(model.key);
      if (maxZ === undefined) { maxZ = new THREE.Box3().setFromObject(model.scene).max.z; if (model.key) MOUTH_Z.set(model.key, maxZ); }
      const tip = new THREE.Vector3(0, rig.Pb[hi].y - 0.1, maxZ - 0.25);
      this._mouthLocal = tip.sub(rig.Pb[hi]).divideScalar(rig.Sb[hi] || 1).applyQuaternion(rig.Qb[hi].clone().invert());
    }
    this._installHandlers();
    hideBoneChains(model.scene, ['wing_shoulder_L', 'wing_shoulder_R', 'tail1', 'leg_upper_FL', 'leg_upper_FR', 'leg_upper_BL', 'leg_upper_BR', 'jaw']);
    this._shapeLocal = null; this._headWorld = null; this._mouthModel = null; this._neckGeo = null;
    for (const m of model.skinned) hideRef(m.userData, 'dragon', this);
    this._f1 = { L: rig.i('wing_f1_L'), R: rig.i('wing_f1_R') };
    this._syncWingGeometry();
    this._attachRider();
    try { this._shadeSetup(model); } catch (e) { console.warn('[dragon] shade look failed', e); }
    try { this._elemSetup(model); } catch (e) { console.warn('[dragon] element look failed', e); }
    this._lod = -1; this._tier = -1; this._lodLists = null; this._riderHidden = false;
  }

  /**
   * Feel fix — Shade Rider readability (enemy palettes with `shade`): violet / indigo shade aura + glowing spars on
   * the materials, violet ink kept at distance (≥ 1.4 px), glowing eyes on the GLB head, wing-tip trails.
   */
  _shadeSetup(model) {
    // ?dragonShade=0 turns the readability look off (A/B reviews and perf comparisons)
    const sp = this.game.params?.get?.('dragonShade') === '0' ? null : this.palette?.shade;
    this._shade = null;
    if (this._eyes) { this._eyes.parent?.remove(this._eyes); this._eyes.geometry.dispose(); this._eyes.material.dispose(); }
    this._eyes = null;
    if (!sp) return;
    const col = (hex, k = 1) => new THREE.Color(hex).multiplyScalar(k);
    const U = {
      uShadeAura: { value: col(sp.aura) }, uShadeVein: { value: col(sp.vein, sp.veinK) },
      uShadeK: { value: new THREE.Vector4(sp.auraK[0], sp.auraK[1], 2.6, sp.self) }, uShadeLife: { value: this.dying ? 0.25 : 1 },
    };
    const mats = model.materials || {}, memb = mats.membrane;
    const hasMemb = !!(memb && model.membraneUniforms);          // aMemb is declared by the billow patch
    for (const m of new Set([mats.body, memb, ...(mats.all || [])])) {
      if (!m || m === mats.eyes || !(m.isMeshToonMaterial || m.isMeshStandardMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial)) continue;
      patchShade(m, U, m === memb && hasMemb);
    }
    model.scene.traverse((o) => {
      const ou = o.userData.isOutline ? o.material?.userData?.outline : null;
      if (!ou) return;
      ou.olMinPx.value = 1.4;
      ou.override.value.set(...sp.ink);
    });
    const E = !model.fallback ? GLB_EYES[model.key] : null, rig = this.rig, hi = rig.i('head');
    if (E && hi >= 0) {
      const eyes = makeEyeGlow(col(sp.eye, sp.eyeK), 0.36 * this.scale);
      const qi = rig.Qb[hi].clone().invert(), s = rig.Sb[hi] || 1, arr = eyes.geometry.attributes.position.array;
      [1, -1].forEach((sx, k) => {
        const v = _v1.set(E[0] * sx, E[1], E[2]).sub(rig.Pb[hi]).divideScalar(s).applyQuaternion(qi);
        arr[k * 3] = v.x; arr[k * 3 + 1] = v.y; arr[k * 3 + 2] = v.z;
      });
      rig.bones[hi].add(eyes);
      this._eyes = eyes;
    }
    if (!this._trails) this._trails = new WingTrails(this.game, col(sp.trail, sp.trailK), this.scale);
    this._trailK = 0;
    this._shade = { U, sp };
  }

  _shadeUpdate(c, dt, lod) {
    const S = this._shade, game = this.game, k = Math.max(dt, 1e-3);
    // the shade light goes out when the rider falls (eyes, veins and aura dim to a quarter)
    S.U.uShadeLife.value = lerp(S.U.uShadeLife.value, this.dying ? 0.25 : 1, dt > 0 ? damp(this.dying ? 1.2 : 4, k) : 0);
    const viewH = game.pipeline?.stats?.height || game.renderer?.getDrawingBufferSize?.(_v4).y || 900;
    if (this._eyes) {
      const u = this._eyes.material.uniforms;
      u.uLife.value = S.U.uShadeLife.value; u.uViewH.value = viewH;
    }
    if (this._trails) {
      // manoeuvring: apparent g-load, smoothed turn rate, high speed (dives, boosts)
      const gl = c.forceM.length() / 9.81, rate = this._omegaF.length(), V = c.speed;
      const far = game.camera ? game.camera.position.distanceTo(this.root.position) > 1400 : true;
      const want = this.dying || this.display || far || lod >= 2 ? 0
        : clamp(Math.max(smoothstep(1.35, 2.5, gl), smoothstep(0.8, 1.7, rate) * 0.8, smoothstep(44, 62, V) * 0.5), 0, 1);
      this._trailK = lerp(this._trailK, want, dt > 0 ? damp(want > this._trailK ? 6 : 2.5, k) : 0);
      if (dt > 0 && game.camera && !this._culled) this._trails.update(this.wingtips, this._trailK, game.time.now, game.camera, viewH);
    }
  }

  /**
   * Aero strips = visible wings: hand the rig's bind wing (left side, body frame, metres, scaled) to the FlightBody.
   * The fallback's bind IS wingkin's canonical layout, so only GLB rigs need it.
   */
  _syncWingGeometry() {
    const body = this.body, w = this.model?.wing;
    if (!w || typeof body.setWingGeometry !== 'function') return;
    const s = this.scale, off = this.model.wingOffset || _v1.set(0, 0, 0);
    const P = (v) => [(v.x + off.x) * s, (v.y + off.y) * s, (v.z + off.z) * s];
    const t0 = performance.now();
    try {
      const geom = body.setWingGeometry({
        shoulder: P(w.S), elbow: P(w.E), wrist: P(w.Wr), hand: P(w.H), fingerTips: w.T.map(P), rootTE: P(w.TE),
      }, { absolute: true });
      if (geom && this._wings.geom) this._wings.geom = geom;        // display gaits use the same wing
      this.wingGeometry = 'rig';
    } catch (e) { console.warn('[dragon] setWingGeometry failed; strips keep the canonical wing', e); }
    this._wingSyncMs = performance.now() - t0;
  }

  async _loadGLB(name) {
    const inst = await instanceGLB(name);
    if (!inst || this.removed) return false;
    try { this._setModel(this._prepareGLB(inst)); } catch (e) { console.warn(`[dragon] ${name}.glb: ${e.message}; keeping the fallback`); return false; }
    return true;
  }

  _prepareGLB(inst) {
    const game = this.game, pal = this.palette, toon = game.toon;
    const need = ['head', 'chest', 'wing_shoulder_L', 'wing_shoulder_R', 'wing_elbow_L', 'wing_elbow_R', 'wing_wrist_L', 'wing_wrist_R'];
    const missing = need.filter((n) => !inst.bones.has(n));
    if (missing.length) throw new Error(`GLB lacks bones ${missing.join(', ')}`);
    // Align the GLB to the physics: its wing roots onto wingkin's shoulder joints (y, z) — this places the centre of
    // mass under the shoulders as in the canonical rig; the strips then take the GLB's own wing (setWingGeometry).
    inst.scene.updateMatrixWorld(true);
    const key = DRAGON_DEFAULTS[this.variant].model;
    const wing = glbWingData(key, inst);               // bind wing (left, GLB model space), cached per file
    const sL = inst.bones.get('wing_shoulder_L').getWorldPosition(new THREE.Vector3());
    const sR = inst.bones.get('wing_shoulder_R').getWorldPosition(new THREE.Vector3());
    const sh = sL.add(sR).multiplyScalar(0.5).sub(inst.scene.getWorldPosition(new THREE.Vector3()));
    const wrap = new THREE.Group(); wrap.name = inst.scene.name || 'dragon_glb';
    wrap.add(inst.scene);
    const shift = new THREE.Vector3(0, CANON_SHOULDER.y - sh.y, CANON_SHOULDER.z - sh.z);
    inst.scene.position.add(shift);
    // Leaf finger bones carry no tail in glTF: give the rig their measured lengths (wing tips, hit shapes).
    if (wing) for (const S of ['L', 'R']) wing.len.forEach((len, i) => { const b = inst.bones.get(`wing_f${i + 1}_${S}`); if (b && len > 0.3) b.userData.tip = new THREE.Vector3(0, len, 0); });
    const materials = [], membranes = [];
    const w4memb = game.params?.get?.('dragonMemb') !== '0';          // A/B review: ?dragonMemb=0 = the wave-3 membranes
    const membU = {
      uCamberL: { value: 0 }, uCamberR: { value: 0 }, uFlutter: { value: 0 }, uMembTime: { value: Math.random() * 10 },
      uMembGlow: { value: pal.glowStrength }, uMembGlowColor: { value: new THREE.Color(pal.glow) }, uMembGlowMix: { value: pal.glowMix ?? 0.3 },
      uMembSun: { value: game.atmo?.sunDir || new THREE.Vector3(-0.45, 0.62, -0.64).normalize() },
      uMembMask: { value: new THREE.Color(this.variant === 'onyx' ? DRAGON_PALETTES.crimson.membrane.mid : pal.membrane.mid) },
      // wave 4: translucent base glow, veins against the glow, and (Sora) the amber -> gold re-grade of the GLB texture
      uMembGlowBase: { value: w4memb ? pal.glowBase || 0 : 0 }, uMembVein: { value: new THREE.Color(...(w4memb && pal.veinDark || [1, 1, 1])) },
    };
    if (pal.membRemap && w4memb) {
      const R = pal.membRemap;
      Object.assign(membU, { uMembRemap: { value: R.k }, uMembTexL: { value: R.texL }, uMembA: { value: new THREE.Color(R.spar) }, uMembB: { value: new THREE.Color(R.edge) } });
    }
    // wave 4: painted volume on the body (countershading in the dragon's own frame, highlight step, warm underside)
    const volU = pal.volume && game.params?.get?.('dragonVolume') !== '0' ? volumeUniforms(pal.volume) : null;
    if (volU && game.atmo?.sunDir) volU.uVolSun.value = game.atmo.sunDir;
    if (this.variant === 'onyx') {                   // the onyx hue shift runs before the glow: mask the shifted violet
      const c = membU.uMembMask.value, b = c.b;
      c.setRGB(b * 0.32, b * 0.5, b * 1.12);
    }
    const tint = this.variant === 'onyx' ? 0x8e96c4 : 0xffffff;
    const meshes = [];
    inst.scene.traverse((o) => { if (o.isMesh && !o.userData.isOutline) meshes.push(o); });
    // Membranes: their own primitive/material (*_membrane) when the exporter split them, else one material holds
    // both and the back-light glow is masked by the membrane colour of the texture.
    const split = meshes.some((o) => /memb|patag/i.test(o.name + ' ' + ((Array.isArray(o.material) ? o.material[0] : o.material)?.name || '')));
    // Wave 5 (membrane "acne"): the membrane's inverted-hull ink sits almost on the thin double-sided shell and
    // pierced it beside the spars → its hull is pushed back further (zPush 0.0015 × depth, toon default 0.0006); the
    // silhouette line stays (nothing is in front of it there). A/B: ?dragonInk=0 = the wave-4 value.
    const ink5 = game.params?.get?.('dragonInk') !== '0';
    let billow = false;
    for (const o of meshes) {
      const old = Array.isArray(o.material) ? o.material[0] : o.material;
      const isMemb = /memb|patag/i.test(o.name + ' ' + (old?.name || ''));
      const side = isMemb || !split ? THREE.DoubleSide : THREE.FrontSide;
      const bodyPart = !isMemb && split;
      const m = toon ? toon.material({ map: old?.map || null, color: old?.map ? tint : (old?.color?.getHex?.() ?? 0xffffff), steps: 3, side, rim: 0xfff4e0,
        ...(bodyPart && volU ? { mid: pal.volume.mid ?? 0 } : {}) })
        : new THREE.MeshToonMaterial({ map: old?.map || null, side });
      if (bodyPart && volU) patchVolume(m, volU);
      if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
      // GLB membranes billow and flutter like the fallback's: per-vertex membrane coordinates computed once per file
      // from the bind spars (membraneAttributes), displaced before skinning along the panel's upper normal.
      let mb = false;
      if (isMemb && split && wing) { try { mb = membraneAttributes(o.geometry, wing); } catch (e) { console.warn('[dragon] membrane coordinates failed', e); } }
      if (isMemb || !split) patchMembrane(m, membU, mb ? 'attr' : false, !split);
      if (this.variant === 'onyx') patchOnyx(m);
      materials.push(m); if (isMemb) membranes.push(m);
      billow = billow || mb;
      o.material = m;
      o.userData.isMembrane = isMemb;                                // (read by QA: the toon material has no GLB name)
      o.castShadow = true; o.receiveShadow = !isMemb;
      if (o.isSkinnedMesh) o.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -0.5), 12);
      if (toon) {
        const ol = toon.outline(o, isMemb ? { width: 0.02, ...(split && ink5 ? { zPush: 0.0015 } : {}) } : { width: 0.03 });
        if (ol && o.isSkinnedMesh) ol.boundingSphere = o.boundingSphere;
        if (ol && mb) patchMembraneOutline(ol.material, membU);     // the ink hull follows the billow
      }
    }
    // Exporter metadata: fire origin in head-bone space (models-dragons README).
    let meta = inst.scene.userData?.skyfire;
    if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = null; } }
    const mouth = Array.isArray(meta?.mouthLocal) && inst.bones.has(meta.mouthBone || 'head')
      ? { bone: meta.mouthBone || 'head', offset: new THREE.Vector3(...meta.mouthLocal) } : null;
    return { key, scene: wrap, bones: inst.bones, skinned: inst.skinned, fallback: false,
      materials: { body: materials.find((x) => !membranes.includes(x)) || materials[0], membrane: membranes[0], all: materials },
      membraneUniforms: billow ? membU : null, membU, volumeUniforms: volU, membraneScale: 1, mouth, wing, wingOffset: shift, info: {} };
  }

  _attachRider() {
    if (!this.rig) return;
    const si = this.rig.i('saddle');
    const bone = si >= 0 ? this.rig.bones[si] : this.rig.bones[this.rig.i('chest')] || this.model.scene;
    this._riderBoneIdx = si >= 0 ? si : this.rig.i('chest');
    const q = si >= 0 ? this.rig.Qb[si].clone().invert() : new THREE.Quaternion();
    const s = si >= 0 ? 1 / (this.rig.Sb[si] || 1) : 1;
    const sa = this.seatAnchor;
    sa.parent?.remove(sa);
    if (this.rider) {
      this.rider.attach(bone, q, s);
      this.rider.root.add(sa);                          // moved to the rider's eyes every frame (Rider.eye)
      sa.userData.kind = 'eye';
    } else {
      bone.add(sa);                                     // riderless (drake): the seat surface
      sa.position.set(0, 0, 0); sa.quaternion.copy(q); sa.scale.setScalar(s);
      sa.userData.kind = 'saddle';
    }
  }

  /** Per frame: world wing tips (leading finger tips) and the rider's eye anchor. */
  _updateAnchors() {
    const rig = this.rig, s = this.scale, off = this.visual.position;
    for (const S of ['L', 'R']) {
      const i = this._f1?.[S] ?? -1;
      const out = this.wingtips[S];
      if (i >= 0) rig.tipOf(i, out).multiplyScalar(s).applyQuaternion(this.visual.quaternion).add(off).applyQuaternion(this.root.quaternion).add(this.root.position);
      else out.copy(this.root.position);
    }
    if (this.rider?.eye && this.seatAnchor.parent === this.rider.root) this.seatAnchor.position.copy(this.rider.eye);
  }

  _disposeMaterials(model) {
    const m = model?.materials;
    for (const x of new Set([m?.body, m?.membrane, m?.eyes, ...(m?.all || [])])) x?.dispose?.();
  }

  // ------------------------------------------------------------------ bone handlers
  _installHandlers() {
    const rig = this.rig, H = rig.handlers;
    H.fill(null);
    const set = (name, fn) => { const i = rig.i(name); if (i >= 0) H[i] = fn; };
    // Torso: bend into turns, breathing, stroke-coupled chest pitch.
    for (const [name, w] of [['spine1', 0.3], ['spine2', 0.35], ['chest', 0.35]]) {
      set(name, (i, Qinh) => {
        const c = this._ctx, mo = c.mv;
        let pitch = (name === 'chest' ? c.breathe * 0.012 + c.stroke * 0.04 : -c.breathe * 0.006) * (1 - c.tuckVis * 0.4);
        // torso bends into the turn with the (smoothed) yaw rate, ≤ 5° over the whole spine
        let yaw = clamp(c.omegaF.y * 0.07, -0.09, 0.09) * w;
        // flight moves: the spine arches back in a loop / the inferno rear-up / the charge (head end up), and curls
        // sideways into a wingover (shares 0.3 / 0.35 / 0.35 sum to the whole bend)
        if (mo?.on) { pitch -= mo.arch * w; yaw += mo.bend * w; }
        _q1.setFromAxisAngle(Y, yaw).multiply(_q2.setFromAxisAngle(X, pitch));
        return _q3.copy(_q1).multiply(Qinh);
      });
    }
    // Wings: wingkin rotations are in body axes -> bone-local via the bone's bind rotation B: Lb * (B^-1 q B).
    for (const S of ['L', 'R']) {
      for (const [bn, key] of WING_MAP) {
        const isFinger = typeof key === 'number';
        set(`${bn}_${S}`, (i, Qinh, Qp) => {
          const side = this._pose[S];
          const q = isFinger ? side.fingers[key] : side[key];
          const B = rig.Qb[i];
          _q1.copy(B).invert().multiply(q).multiply(B);
          let Qm = _q2.copy(Qp).multiply(rig.bindQ[i]).multiply(_q1);
          if (isFinger && key > 0) {
            // visual spar bend: loaded trailing spars lift their tips on the downstroke (whip is already in the pose)
            const bend = this._ctx.bend[S] * [0, 0.6, 0.85, 1][key];
            if (bend > 1e-4) {
              const d = _v1.copy(rig.dir[i]).applyQuaternion(_q3.copy(Qm).multiply(_q1.copy(rig.Qb[i]).invert()));
              const ax = _v2.crossVectors(d, Y).normalize();
              Qm = _q3.setFromAxisAngle(ax, -bend).multiply(Qm);
            }
          }
          return Qm;
        });
      }
    }
    // Neck / tail chains: spring simulation, run when the first chain bone is reached (its parent is solved).
    this._neckIdx.forEach((i, j) => {
      H[i] = (ii) => {
        if (j === 0) this._simChain(this._neck, rig.parent[ii], this._neckDir, this._neckLen, this._neckBias, 'neck');
        // wave 4: the beat head-lock flex (cumulative, about the model's lateral axis) on top of the spring chain
        const f = this._neckFlexCum ? this._neckFlexCum[Math.min(7, j)] : 0;
        if (f) return _q1.setFromAxisAngle(X, f).multiply(this._neck.delta[j]).multiply(rig.Qb[ii]);
        return _q1.copy(this._neck.delta[j]).multiply(rig.Qb[ii]);
      };
    });
    this._tailIdx.forEach((i, j) => {
      H[i] = (ii) => {
        if (j === 0) this._simChain(this._tail, rig.parent[ii], this._tailDir, this._tailLen, this._tailBias, 'tail');
        // wave 4: the wingbeat counter-wave (absolute angle of segment j vs the body, lagged toward the tip)
        const f = this._tailWaveCum ? this._tailWaveCum[Math.min(15, j)] : 0;
        if (f) return _q1.setFromAxisAngle(X, f).multiply(this._tail.delta[j]).multiply(rig.Qb[ii]);
        return _q1.copy(this._tail.delta[j]).multiply(rig.Qb[ii]);
      };
    });
    if (this._headIdx >= 0) H[this._headIdx] = (i) => this._headSolve(i);
    if (this._jawIdx >= 0) H[this._jawIdx] = (i, Qinh) => {
      const lat = _v1.copy(X).applyQuaternion(rig.delta(rig.parent[i], _q3));
      return _q2.setFromAxisAngle(lat, this._jaw).multiply(Qinh);
    };
    // Legs: rotations about the model's lateral axis relative to the parent (tuck / dangle / swing / flail).
    // Wave 4 (critic blocker: the hind legs stood folded UP over the back in cruise): the hind tuck is given as
    // ABSOLUTE segment angles in the sagittal plane (0 = straight down, + = back) and converted per rig from its bind
    // directions. The GLBs bind the hind leg digitigrade (thigh down-forward, shin back-UP, foot down), so the old
    // fixed offsets [70, 26, 46]° summed to a shin pointing up and a foot 0.65 m above the back. Now the thigh swings
    // back-down, the shin and the foot fold back along the underside of the tail base — a trailing tuck, always
    // below the belly line whatever the rig (fallback, hero, crimson, onyx, drake).
    const legOff = this._legOffsets = {};
    const sag = (i) => { const d = rig.dir[i]; return Math.atan2(-d.z, -d.y); };      // bind segment angle
    const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
    const tuneQ = String(this.game.params?.get?.('dragonLegs') || '').split(',').map(Number);   // review: ?dragonLegs=58,96,70
    const HIND_TUCK = tuneQ.length === 3 && tuneQ.every(Number.isFinite) ? tuneQ : HIND_TUCK_DEG;
    for (const leg of ['FL', 'FR', 'BL', 'BR']) {
      const front = leg[0] === 'F';
      const ids = ['leg_upper_', 'leg_lower_', 'foot_'].map((pre) => rig.i(pre + leg));
      let tuck = [58, -112, -50].map((x) => x * DEG);            // front: fold against the chest (unchanged)
      if (!front && ids.every((i) => i >= 0)) {
        tuck = []; let acc = 0;
        for (let k = 0; k < 3; k++) { const a = wrap(HIND_TUCK[k] * DEG - sag(ids[k]) - acc); tuck.push(a); acc += a; }
      } else if (!front) tuck = [70, 26, 46].map((x) => x * DEG);
      legOff[leg] = { tuck, dang: (front ? [-6, 12, 20] : [-8, -14, 26]).map((x) => x * DEG) };
    }
    for (const leg of ['FL', 'FR', 'BL', 'BR']) {
      const front = leg[0] === 'F';
      ['leg_upper_', 'leg_lower_', 'foot_'].forEach((pre, k) => {
        set(pre + leg, (i, Qinh) => {
          const c = this._ctx, t = this._legTuck, o = legOff[leg];
          const ho = c.hv?.on && !c.dead ? c.hv : null, hw = ho ? ho.hv : 0;
          // swing with the longitudinal acceleration; the hanging legs also lag the wingbeat heave (weight)
          // (in a hover the pendulum below carries the acceleration: the old swing fades out)
          const sw = (k === 0 ? this._legSwing : this._legSwing * 0.5) * (1 - t * (front ? 0.7 : 0.85)) * (1 - 0.8 * hw) + (front ? 0.5 : 1) * this._legHeave * (k === 0 ? 1 : 0.6);
          let a = lerp(o.dang[k], o.tuck[k], t) + sw, side = 0;
          // hover / flare: the dangling leg hangs as a pendulum along the apparent gravity (sagittal + sideways swing,
          // at the hip), reaches forward in the flare (and a little when sinking), the knee bends into the reach
          if (ho) {
            const dw = 1 - t, pd = this._hv.leg[leg];
            if (k === 0) { a += dw * ((front ? HV.legFront.k : HV.legHind.k) * pd[0] + (front ? ho.legsF : ho.legsH)); side = dw * pd[2] * (front ? 0.7 : 1); }
            else if (k === 1) a += dw * ho.knee * (front ? -1 : 1);
          }
          if (c.dead) a += Math.sin(this._t * (7 + k * 2) + (front ? 0 : 1.7) + (leg[1] === 'L' ? 0 : 2.1)) * 0.45;
          _q3.copy(Qinh).multiply(_q2.copy(rig.Qb[i]).invert());
          const lat = _v1.copy(X).applyQuaternion(_q3);
          _q1.setFromAxisAngle(lat, a);
          if (side) _q1.premultiply(_q2.setFromAxisAngle(_v2.copy(Z).applyQuaternion(_q3), side));
          return _q1.multiply(Qinh);
        });
      });
    }
  }

  _simChain(chain, parentIdx, dirs, lens, bias, kind) {
    const c = this._ctx, rig = this.rig;
    const base = parentIdx >= 0 ? rig.delta(parentIdx, this._chainBaseQ || (this._chainBaseQ = new THREE.Quaternion())) : (this._chainBaseQ || (this._chainBaseQ = new THREE.Quaternion())).identity();
    const n = bias.length;
    // Path targets from the low-passed body rate (τ ≈ 0.12 s: the curve builds up just after the turn does, a touch
    // of follow-through). Budget: ≤ 25° over the chain in a normal turn, up to ≈ 38° in the hardest (≥ 115°/s).
    const rate = c.omegaF.length();
    const budget = c.dead ? 30 * DEG : lerp(25, 38, smoothstep(1.1, 2.0, rate)) * DEG;
    if (kind === 'tail') {
      pathBias(this._tailPath, lens, c.omegaF, c.speed, -1, budget, null);
      // Streamer: the tail leans ≈ 30 % into the relative airflow (angle of attack / sideslip, ≤ 8°), more at the tip.
      const qAir = this._tailAir || (this._tailAir = new THREE.Quaternion());
      let airF = 0;
      const wl = c.windM.length();
      if (wl > 6 && !c.dead) {
        qAir.setFromUnitVectors(_v3.set(0, 0, -1), _v2.copy(c.windM).divideScalar(wl));
        const ang = 2 * Math.acos(clamp(Math.abs(qAir.w), 0, 1));
        airF = ang > 1e-4 ? Math.min(0.3, (8 * DEG) / ang) * smoothstep(6, 20, wl) : 0;
      }
      // the flight hint's hang (tailPitch −0.42 in a hover, −0.35 in a flare) is capped — Σ over the chain ≈ 2.5 × the cap
      // (≈ 29°): a curve, not a plumb line
      const ho = c.hv?.on && !c.dead ? c.hv : null;
      const tp0 = this._pose.body.tailPitch || 0;
      const tp = ho ? clamp(tp0, -HV.tailHintMax, 0.6 * HV.tailHintMax) : tp0;
      const wsum = n * 0.5 + n * 0.5;                                  // Σ (0.5 + t) over the chain
      const nCurl = Math.max(1, Math.round(n * 0.4));
      const aimW = Math.asin(clamp(c.gazeW.y, -1, 1));                  // the aim's world pitch (the hover's balance)
      // flight moves: the tail as a rudder into a wingover, curled with the loop, dropped by the inferno rear-up, and
      // streamed calm (less wag and beat wave) in the dash, the skim and the barrel roll
      const mo = c.mv?.on && !c.dead ? c.mv : null;
      const calm = mo ? 1 - 0.75 * mo.calm : 1;
      // Wave 4 — the tail answers the wingbeat: a counter-wave travelling to the tip (the tail droops as the body
      // rises), each segment's absolute angle Φ_j = −A (0.35 + 0.65 t) · beat(t − τ_j), τ_j = 0.05 + 0.5 t seconds.
      // (a kinematic overlay on the solved chain like the neck's: through the stiff serial springs it was attenuated)
      const wc = this._tailWaveCum || (this._tailWaveCum = new Float32Array(16));
      for (let j = 0; j < n; j++) {
        const t = j / Math.max(1, n - 1);
        const share = (0.5 + t) / wsum;
        let yaw = c.wag * Math.sin(this._t * 1.9 - j * 0.55) * (0.3 + t) * calm + (c.dead ? Math.sin(this._t * 4.2 - j * 0.7) * 0.07 : 0);
        if (j < 16) wc[j] = c.dead ? 0 : -TAIL_WAVE * (0.35 + 0.65 * t) * this._heaveAgo(0.05 + 0.5 * t) * calm;
        let pitch = tp * (0.5 + t) * 0.25 + c.tuckVis * 0.01 + (c.dead ? 0.03 : 0);
        // (the rudder gives way where the path bias already curls the tail in a hard turn: never a folded tail)
        if (mo) { yaw += mo.tailYaw * share * (1 - 0.5 * smoothstep(1.1, 2.0, rate)); pitch += mo.tailUp * share; }
        // hover: the tail as the balance — it swings out against the strafe's acceleration, counters the head's turn and
        // the aim's pitch (the head goes down → the tail comes up), hangs lower in the climb / the flare, and its tip
        // curls up a little (an S)
        if (ho) {
          yaw += (ho.tailYaw + HV.tailHead * c.gazeM.x * ho.hv) * share;
          pitch += (ho.tailUp - HV.tailAim * aimW * ho.hv) * share + (t > 0.6 ? ho.tailCurl / nCurl : 0);
        }
        bias[j].copy(this._tailPath[j]);
        if (airF > 0) bias[j].multiply(_q2.identity().slerp(qAir, airF * (0.5 + t) / wsum));
        bias[j].multiply(_q2.setFromAxisAngle(Y, yaw)).multiply(_q1.setFromAxisAngle(X, pitch));
      }
    } else {
      // the neck leads a little into the turn (≈ 0.09 s ahead of the body) and turrets gently toward the gaze
      pathBias(this._neckPath, lens, c.omegaF, c.speed, 1, budget * 0.6, 0.09);
      const g = c.gazeM, np = this._pose.body.neckPitch || 0;
      const ws = [0.02, 0.03, 0.04, 0.045, 0.05, 0.055];              // Σ 0.24: ≤ ≈ 13° of turret at the gaze clamp
      // hover: the head looks level (or down at the aim) while the body is pitched up — the neck turrets further toward
      // the gaze's pitch and rises in an S (base up, the head end down); the flight hint neckPitch (+ = up) is applied
      // with its sign (before 24.09 it was subtracted ×0.08: a flare LOWERED the neck) — ?dragonHover=0 keeps the old one
      const ho = c.hv?.on && !c.dead ? c.hv : null;
      const gyMax = ho ? lerp(0.6, 1.0, ho.hold || 0) : 0.6, tur = 1 + (ho ? ho.turret : 0);
      const gx = clamp(g.x, -0.95, 0.95), gy = clamp(g.y, -gyMax, gyMax);
      // Wave 4 — the head holds its place in the air while the chest heaves and pitches with the stroke: the neck flexes
      // against the body's beat motion (≈ ±5°), most at its base.
      // (neck base → head span and the head's lever ahead of the CG, measured once per rig)
      if (!this._neckGeo) {
        const i1 = this._neckIdx[0], hi = this._headIdx;
        const Ln = i1 >= 0 && hi >= 0 ? Math.max(1, rig.Pb[hi].distanceTo(rig.Pb[i1])) : 3;
        this._neckGeo = { Ln, zHead: hi >= 0 ? Math.max(1, rig.Pb[hi].z) : 5 };
      }
      const NG = this._neckGeo;
      const flex = c.dead ? 0 : clamp(0.85 * ((c.heave || 0) + (c.noseUp || 0) * NG.zHead) / (0.8 * NG.Ln), -NECK_WAVE_MAX, NECK_WAVE_MAX);
      // (a kinematic overlay on the solved chain — through the serial springs the correction lagged ≈ 110° and the head
      // bobbed MORE than the body; see the neck handler)
      const wf = [0.26, 0.21, 0.17, 0.14, 0.11, 0.11], fc = this._neckFlexCum || (this._neckFlexCum = new Float32Array(8));
      // flight moves: the neck leads into a wingover, lifts along the loop and in the inferno rear-up, stretches forward
      // in the dash / the skim / a fireball strike, and coils into an S while a fireball charges (the head keeps the aim)
      const mo = c.mv?.on && !c.dead ? c.mv : null;
      let acc = 0;
      for (let j = 0; j < n; j++) {
        const w = ws[Math.min(ws.length - 1, j)] * (c.dead ? 0 : 1);
        acc += flex * wf[Math.min(5, j)]; if (j < 8) fc[j] = acc;
        let yawJ = gx * w, upJ = gy * w * tur - (ho ? 0 : np * 0.08) - (c.dead ? 0.1 : 0);
        if (ho) {
          const f = NECK_SHARE[Math.min(5, j)] * (6 / Math.max(1, n));
          upJ += (ho.neckHint + ho.neckUp) * f + ho.neckS * (j < n / 2 ? 1 : -1) * (2 / Math.max(1, n));
        }
        if (mo) {
          const f = NECK_SHARE[Math.min(5, j)] * (6 / Math.max(1, n));
          yawJ += mo.neckYaw * f * (1 - 0.4 * smoothstep(1.1, 2.0, rate));    // (the path lead grows in hard turns)
          upJ += mo.neckUp * f + mo.coil * (j < n / 2 ? 1 : -1) * (2 / Math.max(1, n));
        }
        bias[j].copy(this._neckPath[j]).multiply(_q2.setFromAxisAngle(Y, yawJ)).multiply(_q1.setFromAxisAngle(X, -upJ));
      }
    }
    chain.simulate(c.dt, base, dirs, lens, bias, { omega: c.omegaM, load: c.loadM, wind: kind === 'tail' ? c.windM : null });
  }

  _headSolve(i) {
    const c = this._ctx, rig = this.rig;
    // Desired world orientation: face the gaze, keep 30 % of the horizon in banks.
    const fwdW = _v1.copy(c.gazeW);
    const frameQ = this._frameQ || this.root.quaternion;           // wave 4: the rendered frame (heave pitch, hit rock)
    const bodyUp = _v2.copy(Y).applyQuaternion(frameQ);
    // Feel fix: 30 % horizon lock (was 60 %: in an 80° bank the head rolled ~50° against the neck, a broken look)
    // (a barrel roll carries the head round with the body instead of fighting it)
    const upW = _v3.copy(Y).lerp(bodyUp, c.dead ? 1 : 0.7 + 0.3 * (c.mv?.on ? c.mv.roll : 0)).normalize();
    const xw = _v4.crossVectors(upW, fwdW);
    if (xw.lengthSq() < 1e-6) xw.set(1, 0, 0).applyQuaternion(frameQ);
    xw.normalize();
    const yw = upW.crossVectors(fwdW, xw).normalize();
    _m1.makeBasis(xw, yw, fwdW);
    const target = _q1.setFromRotationMatrix(_m1);
    if (!this._headWorld) this._headWorld = target.clone();
    if (c.dt > 0) this._headWorld.slerp(target, damp(1 / 0.08, c.dt));
    const inv = _q2.copy(frameQ).invert();
    const Rm = _q3.copy(inv).multiply(this._headWorld);        // model-space rotation from the bind basis (+Z fwd, +Y up)
    const rest = rig.delta(rig.parent[i], this._headRestQ || (this._headRestQ = new THREE.Quaternion()));
    // the head may turn ≤ 21° from where the neck carries it (≤ 29° when the gaze is far off: lock-on, hard turns)
    const ang = _v1.copy(Z).applyQuaternion(rest).angleTo(_v2.copy(Z).applyQuaternion(Rm));
    let lim = c.dead ? 0.1 : lerp(0.36, 0.5, smoothstep(0.5, 1.1, Math.abs(c.gazeM.x)));
    if (!c.dead && c.hv?.on && c.hv.headLim > 0) lim = lerp(lim, Math.max(lim, HV.headLim), c.hv.headLim);   // hover: a wider reach
    if (ang > lim) Rm.copy(rest.slerp(Rm, lim / ang));
    return Rm.multiply(rig.Qb[i]);
  }

  // ------------------------------------------------------------------ simulation
  // Public entry points never throw (a broken dragon must not stop the frame loop); errors are logged once.
  fixedUpdate(dt) {
    try { this._fixedUpdate(dt); } catch (e) { if (!this._errF) { this._errF = true; console.error('[dragon] fixedUpdate failed', e); } }
  }

  update(dt, realDt) {
    try { this._update(dt, realDt); } catch (e) { if (!this._errU) { this._errU = true; console.error('[dragon] update failed', e); } }
  }

  _fixedUpdate(dt) {
    const game = this.game;
    if (this.removed || this._lastFixed === game.time.fixedFrame) return;
    this._lastFixed = game.time.fixedFrame;
    if (this.display) {
      const h = this._react.pending;
      if (h) { this._react.pending = null; try { this._hitReact(h, h.dv); } catch (e) { /* visual only */ } }
      this._updateShapes(); return;
    }
    const body = this.body, c = this.controls;
    this._prev.pos.copy(this._cur.pos); this._prev.quat.copy(this._cur.quat); copyPose(this._prev.pose, this._cur.pose);
    // Heat: breath heats up (≈4 s to overheat), cools in ≈2.5 s; overheated until 35 %. A pilot that owns the
    // weapons (player.js sets externalHeat and publishes heat / overheated) replaces this model.
    if (!this.externalHeat) {
      const wantBreath = !!c.breath && this.alive;
      if (wantBreath && !this.overheated) this.heat = Math.min(1, this.heat + dt / 4);
      else this.heat = Math.max(0, this.heat - dt / 2.5);
      if (this.heat >= 1) this.overheated = true;
      if (this.overheated && this.heat < 0.35) this.overheated = false;
      if (this.overheated) c.breath = 0;
    }
    if (this.dying) this._deathControls(dt);
    try { this._absorbKnock(dt); } catch (e) { if (!this._knockErr) { this._knockErr = true; console.warn('[dragon] knock handling failed', e); } }
    try { body.step(dt, this.env); } catch (e) { if (!this._stepErr) { console.error('[dragon] body.step failed', e); this._stepErr = true; } }
    this._velEnd.copy(body.vel);
    if (this.stagger && game.time.now > this.stagger.until) this.stagger = null;
    this.pos.copy(body.pos); this.vel.copy(body.vel); this.quat.copy(body.quat);
    this._accel.lerp(_v1.subVectors(this.vel, this._prevVel).divideScalar(dt), 0.25);
    this._prevVel.copy(this.vel);
    this._cur.pos.copy(this.pos); this._cur.quat.copy(this.quat);
    copyPose(this._cur.pose, body.state?.pose);
    this.actor.alive = this.alive && this.actor.alive;
    this._updateShapes();
    this._updateMouthFixed();
    if (this.dying) this._checkCrash(dt);
  }

  _update(dt, realDt) {
    const game = this.game;
    if (this.removed || this._lastFrame === game.time.frame) return;
    this._lastFrame = game.time.frame;
    this._t += dt;
    const disp = this.display;
    if (disp) {
      if (disp.pos) this.root.position.copy(disp.pos);
      if (disp.quat) this.root.quaternion.copy(disp.quat);
      this.pos.copy(this.root.position); this.quat.copy(this.root.quaternion);
      this.vel.set(0, 0, disp.speed ?? 30).applyQuaternion(this.quat);
      this._wings.freeze = !!disp.freeze;
      if (disp.phase != null) { this._wings.setPhase(disp.phase); disp.phase = null; }
      copyPose(this._pose, this._wings.step(Math.min(dt, 0.05), disp.gait, { breath: disp.breath, roll: disp.roll, airspeed: disp.speed ?? 30 }));
      this._accel.set(0, 0, 0); this._omega.set(0, 0, 0);
    } else {
      const alpha = clamp(game.time.alpha ?? 1, 0, 1);
      this.root.position.lerpVectors(this._prev.pos, this._cur.pos, alpha);
      this.root.quaternion.slerpQuaternions(this._prev.quat, this._cur.quat, alpha);
      lerpPose(this._pose, this._prev.pose, this._cur.pose, alpha);
      if (this.body.angVel) this._omega.copy(this.body.angVel);
    }
    // 24.09 — flight moves: read the move contract, run the visual timelines, accent the wings (before the hit flail,
    // which wins over any move)
    const mo = this._movesStep(Math.min(dt, 0.05));
    // 24.09 — hover / flight modes: flare, take-off, strafe, climb / sink, the leg pendulums; wing accents (before the
    // flail too)
    const ho = this._hoverStep(Math.min(dt, 0.05), mo);
    // limp flailing wings when shot down; after a heavy hit the struck wing flails and folds for a moment (wave 4)
    { const F = this._react.flail; if (this.dying) this._flail(1, 1); else if (F.L > 0.01 || F.R > 0.01) this._flail(F.L, F.R); }

    // Context for the handlers (model frame = root frame).
    const qInv = _q1.copy(this.root.quaternion).invert();
    const c = this._ctx || (this._ctx = { omegaM: new THREE.Vector3(), forceM: new THREE.Vector3(), windM: new THREE.Vector3(),
      loadM: new THREE.Vector3(), omegaF: this._omegaF, gazeW: new THREE.Vector3(), gazeM: new THREE.Vector2(), bend: { L: 0, R: 0 },
      visQ: this.visual.quaternion });
    c.mv = mo;
    c.hv = ho;
    c.dt = Math.min(dt, 0.05);
    c.omegaM.copy(this._omega).applyQuaternion(qInv);
    c.forceM.set(0, -9.81, 0).sub(this._accel).applyQuaternion(qInv);   // apparent gravity in the body frame
    // chain load: the part of the apparent gravity that differs from level 1 g (a sag under g, clamped to 2.5 g)
    c.loadM.copy(c.forceM).add(_v2.set(0, 9.81, 0)).clampLength(0, 25);
    c.windM.copy(this.vel).negate().applyQuaternion(qInv);
    const V = this.vel.length();
    c.speed = V;
    c.omegaF = this._omegaF;
    if (c.dt > 0) this._omegaF.lerp(_v2.copy(c.omegaM).clampLength(0, 2.6), damp(8, c.dt));
    c.turn = clamp(c.omegaM.y, -1.5, 1.5);
    c.wag = (1 - smoothstep(10, 26, V)) * 0.06 + 0.01;
    c.dead = this.dying;
    c.breathe = Math.sin(this._t * 1.6);
    c.stroke = this._pose.L.camber - 0.4;
    for (const S of ['L', 'R']) {
      const p = this._pose[S];
      const want = p.downstroke ? clamp(-p.psiDot * 0.012, 0, 0.07) * (1 - p.fold) : 0;
      c.bend[S] = lerp(c.bend[S], want, c.dt > 0 ? damp(12, c.dt) : 0);
    }
    // Legs tuck with speed (and the pose hint: legs come down in a flare), dangle when slow.
    const hint = this._pose.body.legTuck ?? 1;
    // (every flight move and the skim fold the legs tight)
    // (hover: Ctrl sinks — the legs keep dangling; the take-off snaps them up)
    const hvW = ho.on ? ho.hv : 0;
    const diveTuck = this.controls?.dive && hvW < 0.5 ? 1 : 0;
    const tuckT = this.dying ? 0.15 : Math.max(Math.min(hint, smoothstep(12, 28, V)), diveTuck, mo.on ? mo.tuck : 0, ho.on ? ho.legTuck : 0);
    this._legTuck = lerp(this._legTuck, tuckT, damp(2.5 + (ho.on ? 4 * ho.to : 0), Math.max(c.dt, 1e-4)));
    c.tuckVis = this._legTuck;
    const accLong = _v2.copy(this._accel).applyQuaternion(qInv).z;
    this._legSwing = lerp(this._legSwing, clamp(accLong * 0.03, -0.35, 0.35), damp(4, Math.max(c.dt, 1e-4)));
    // Jaw: open while breathing fire (smoothed), tiny idle.
    const breathing = disp ? !!disp.breath : (!!this.controls.breath && this.canBreathe) || this._breathEvt;
    this.breathing = breathing;
    let jawT = this.dying ? 0.35 : breathing ? 0.46 : 0.02 + 0.015 * Math.max(0, Math.sin(this._t * 0.7));
    // flight moves: a glowing gap while a fireball charges, the inferno roar wide open, a snap on a fireball strike
    const jawMv = !this.dying && mo.on ? mo.jaw : 0;
    if (jawMv > jawT) jawT = jawMv;
    this._jaw = lerp(this._jaw, jawT, damp(breathing || jawMv > this._jaw ? 14 : 6, Math.max(c.dt, 1e-4)));
    this._gaze(c);

    // Distance LOD: far dragons drop outlines, shadows and cloth, and solve their skeleton at a lower rate.
    // (distances scale with the dragon's size: a 9 m drake drops its outlines sooner than the 17 m hero)
    // (24.09: finer tiers, see LOD; `lod` keeps its older 3-level meaning for the rider's cloth and the wing trails)
    const camD = game.camera ? game.camera.position.distanceTo(this.root.position) / clamp(this.scale, 0.6, 1.2) : 0;
    let tier, lod;
    if (this._lodMode) {
      const D = LOD.d;
      tier = game.player === this || disp ? 0 : camD > D[3] ? 4 : camD > D[2] ? 3 : camD > D[1] ? 2 : camD > D[0] ? 1 : 0;
      lod = tier <= 1 ? 0 : tier <= 3 ? 1 : 2;
    } else { lod = camD > 1600 ? 2 : camD > 380 ? 1 : 0; tier = lod === 0 ? 1 : lod === 1 ? 2 : 4; }
    if (this._lodLists && this._lodRiderModel !== this.rider?.model) { this._lodLists = null; this._tier = -1; }   // (a rider GLB swapped in)
    if (tier !== this._tier || lod !== this._lod) this._applyLod(tier, lod);
    const every = this._culled ? LOD.culledEvery : this._lodMode ? LOD.every[tier] : lod === 2 ? 3 : 1;
    this._lodSkip = every > 1 ? (game.time.frame + this.id) % every : 0;
    // Wave 4: the rendered body frame (heave + stroke pitch + hit rock / tumble on the visual) is set BEFORE the solve,
    // so the head's world lock and the neck / tail waves see the frame that is drawn.
    try { this._visualFrame(c); } catch (e) { if (!this._visErr) { this._visErr = true; console.warn('[dragon] visual frame failed', e); } }
    if (this._lodSkip === 0) {
      try { this.rig.solve(); this._solvedFrame = game.time.frame; } catch (e) { if (!this._solveErr) { console.error('[dragon] pose solve failed', e); this._solveErr = true; } }
      this._cacheShapes();
    }
    this._membrane(dt);
    this._hitFlash(realDt || dt);
    this._updateMouthRender();
    // 25.09 — levels and elements (the player's element look; after the solve: the arcs follow the drawn spars)
    if (this._el.on && (this._el.active || this.game.player === this || this.display)) {
      try { this._elemStep(Math.min(dt, 0.05), realDt); }
      catch (e) { if (!this._el.err) { this._el.err = true; console.warn('[dragon] element look failed', e); } }
    }
    if (this._mv.glow || mo.ch > 0.02 || mo.rear > 0.02 || mo.inf > 0.02 || this._el.mouthK > 0.02) {
      try { this._glowStep(mo, dt); } catch (e) { if (!this._glowErr) { this._glowErr = true; console.warn('[dragon] mouth glow failed', e); } }
    }
    if (this.rider && this._lodSkip === 0 && !this._culled && !this._riderHidden) {
      // (the rider root's world rotation from the solved rig: the rider no longer asks three for it — that walked and
      // recomposed every ancestor matrix per rider per frame)
      const rb = this._riderBoneIdx;
      if (rb >= 0 && this.rider.root.parent === this.rig.bones[rb]) (c.riderWorldQ || (c.riderWorldQ = new THREE.Quaternion())).copy(this._frameQ).multiply(this.rig.Qm[rb]).multiply(this.rider.root.quaternion);
      else c.riderWorldQ = null;
      try { this.rider.update(c.dt, c, lod); } catch (e) { if (!this._riderErr) { console.error('[dragon] rider update failed', e); this._riderErr = true; } }
    }
    this._updateAnchors();
    if (this._shade) this._shadeUpdate(c, dt, lod);
  }

  /** Ink lines, shadow casting and the rider for a detail tier (see LOD); `lod` = the older 3-level value. */
  _applyLod(tier, lod) {
    this._tier = tier; this._lod = lod;
    const L = this._lodLists || this._buildLodLists();
    // feel fix: a Shade Rider's ink line stays on to 1.6 km (screen-constant width, ≥ 1.4 px) — it separates a far dragon
    // from the forest; the hero-style ink (and the riders') only up close
    const inkD = this._shade ? tier <= 3 : tier <= 1, inkR = tier <= 1;
    for (const o of L.ink) o.visible = inkD;
    for (const o of L.riderInk) o.visible = inkR;
    const cast = (this._lodMode ? tier === 0 : tier <= 1) && !this._culled;
    for (const o of L.casters) o.castShadow = cast && !!o.userData.castShadow0;
    // the rider left out of the scene graph when it is ≤ 1.5 px (its ~60 bones are not updated or traversed)
    const hideR = this._lodMode && !!this.rider?.root && tier >= 3;
    if (hideR !== this._riderHidden) {
      const r = this.rider.root;
      if (hideR) { this._riderParent = r.parent; r.parent?.remove(r); }
      else if (this._riderParent && !r.parent) this._riderParent.add(r);
      else if (!r.parent) this._attachRider();
      this._riderHidden = hideR;
    }
  }

  /** Meshes the LOD switches (collected once per model / rider model; the old code traversed the whole root). */
  _buildLodLists() {
    const L = { ink: [], riderInk: [], casters: [] };
    const riderRoot = this.rider?.root || null;
    const walk = (root, inRider) => root?.traverse((o) => {
      if (o.userData.isOutline) (inRider ? L.riderInk : L.ink).push(o);
      else if (o.isMesh) { if (o.userData.castShadow0 === undefined) o.userData.castShadow0 = o.castShadow; L.casters.push(o); }
    });
    walk(this.model?.scene, false);
    if (riderRoot) {
      // (the rider root may be under the model; count its meshes as the rider's)
      const inR = new Set(); riderRoot.traverse((o) => inR.add(o));
      L.ink = L.ink.filter((o) => !inR.has(o)); L.casters = L.casters.filter((o) => !inR.has(o));
      walk(riderRoot, true);
    }
    this._lodRiderModel = this.rider?.model;
    this._lodLists = L;
    return L;
  }

  /**
   * Off-screen cull (the 'dragonsCull' late system, after the camera): an enemy outside the frustum (+ margin) leaves the
   * scene graph (root keeps its place; `visual` is detached); back in view it is re-attached with a fresh skeleton solve
   * before the frame is drawn. Never the player's or a display dragon, never while the water reflection is drawn.
   */
  _cullCheck(fr, refl) {
    try {
      if (this.removed) return;
      const want = this._lodMode && !refl && !this.display && this.game.player !== this && this.visual
        && !fr.intersectsSphere(_sph.set(this.root.position, LOD.radius * this.scale + LOD.margin));
      if (want === this._culled) return;
      this._culled = want;
      if (want) { this.root.remove(this.visual); if (this._trails) this._trails.mesh.visible = false; }
      else {
        this.root.add(this.visual);
        this._trails?.reset();
        if (this._solvedFrame !== this.game.time.frame && this._ctx) { this.rig.solve(); this._solvedFrame = this.game.time.frame; this._cacheShapes(); }
      }
      this._applyLod(this._tier, this._lod);
    } catch (e) { if (!this._cullErr) { this._cullErr = true; console.warn('[dragon] cull check failed', e); } }
  }

  _gaze(c) {
    const game = this.game;
    const fwd = _v1.copy(Z).applyQuaternion(this.root.quaternion);
    const dir = _v2;
    const rig = game.cameraRig;
    if (this.lookTarget) dir.subVectors(this.lookTarget, this.mouth).normalize();
    else if (this.aimDir) dir.copy(this.aimDir).normalize();
    else if (game.player === this && rig?.aimDir && !this.display) {
      dir.copy(rig.aimDir).normalize();
      // 24.09 (hover / aim): the jaws converge on the reticle's point (TPS in a hover: the reticle is the screen centre)
      // and, when player.js picks a soft target within ≈ 12° of the aim, the head bends onto it (hysteresis 12 → 15°)
      const ap = rig.aimPoint;
      if (ap && !rig.aimFrozen && Number.isFinite(ap.x + ap.y + ap.z)) {
        const L = _v5.subVectors(ap, this.mouth).length();
        if (L > 25) dir.copy(_v5.divideScalar(L));
      }
      const st = this.softTarget, sp = st?.pos || st?.root?.position;
      if (st && st.alive !== false && sp && Number.isFinite(sp.x)) {
        const L = _v5.subVectors(sp, this.mouth).length();
        const cosA = L > 1 ? _v5.divideScalar(L).dot(dir) : -1;
        const on = cosA > Math.cos((this._softOn ? 15 : 12) * DEG);
        this._softOn = on;
        if (on) dir.copy(_v5);
      } else this._softOn = false;
    }
    else if (this.vel.lengthSq() > 4) dir.copy(this.vel).normalize().lerp(fwd, 0.35).normalize();
    else dir.copy(fwd);
    if (!(dir.lengthSq() > 0.5) || dir.dot(fwd) < -0.2) dir.copy(fwd);
    // flight moves: the head leads — into the wingover's reversal, up along the loop, skyward in the inferno rear-up
    const mo = c.mv;
    if (mo?.on && mo.gazeW > 0.01 && !this.dying) dir.lerp(_v4.copy(mo.gaze).applyQuaternion(this.root.quaternion), mo.gazeW).normalize();
    c.gazeW.copy(dir);
    const dm = _v3.copy(dir).applyQuaternion(_q2.copy(this.root.quaternion).invert());
    // (hover: the aim's pitch reaches further from the pitched-up body — level, or down at a target below)
    const hw = c.hv?.on ? c.hv.hold || 0 : 0;
    c.gazeM.set(clamp(Math.atan2(dm.x, dm.z), -1.2, 1.2), clamp(Math.asin(clamp(dm.y, -1, 1)), -lerp(0.75, HV.gazeDownMax, hw), lerp(0.75, HV.gazeUpMax, hw)));
  }

  _membrane(dt) {
    const U = this.model.membraneUniforms;
    if (!U) return;
    const k = this.display?.freeze ? 1 : damp(10, Math.max(dt, 1e-3));
    const ms = this.model.membraneScale ?? 1;
    // Billow follows the stroke: loaded (cambered) on the downstroke, luffing a little on the upstroke.
    // (hover / flare: the membranes cup deeper on the downstroke, luff more on the way up)
    const ho = this._hv?.out, cup = ho?.on ? ho.cup : 0;
    const cam = (p) => ms * (0.08 + 0.26 * p.camber - (p.downstroke ? 0 : 0.05 * (this._pose.flapAmount || 0)) + cup * (p.downstroke ? 1 : -0.4));
    U.uCamberL.value = lerp(U.uCamberL.value, cam(this._pose.L), k);
    U.uCamberR.value = lerp(U.uCamberR.value, cam(this._pose.R), k);
    U.uFlutter.value = (0.018 * smoothstep(34, 60, this.vel.length()) + 0.006 * smoothstep(20, 34, this.vel.length()) + (this.dying ? 0.05 : 0)) * ms;
    U.uMembTime.value += dt;
  }

  _hitFlash(dt) {
    if (this._flash <= 0 && !this._flashOn) return;
    this._flash = Math.max(0, this._flash - dt / 0.16);
    const f = this._flash * this._flash;
    const m = this.model.materials;
    for (const x of new Set([m.body, m.membrane, ...(m.all || [])])) {
      if (!x) continue;
      if (x.userData.toon?.hitFlash) x.userData.toon.hitFlash.value = f * 0.85;   // skytoon hit flash
      else if (x.emissive) x.emissive.setRGB(f * 1.2, f * 1.1, f * 1.05);
    }
    this._flashOn = this._flash > 0;
  }

  // ------------------------------------------------------------------ flight moves (24.09): body language
  /** Move events → this._mv (returns the unsubscribe). An event without an actor field belongs to game.player. */
  _moveEvents() {
    const game = this.game, M = this._mv, ev = game.events;
    if (!ev?.on) return null;
    const mine = (e) => {
      const a = e.actor ?? e.dragon ?? e.owner ?? null;
      return a ? a === this || a === this.actor || a.dragon === this : game.player === this;
    };
    const on = (name, fn) => ev.on(name, (e) => {
      try { if (!this.removed) fn(e && typeof e === 'object' ? e : {}); }
      catch (err) { if (!M.err) { M.err = true; console.warn('[dragon] move event failed', name, err); } }
    });
    const offs = [
      on('move', (e) => {
        if (!mine(e)) return;
        if (e.phase === 'end') { if (!e.name || M.evt.name === e.name) M.evt.on = false; }
        else if (typeof e.name === 'string') { M.evt.name = e.name; M.evt.side = normSide(e.side); M.evt.on = true; M.evt.t0 = game.time?.now ?? 0; }
      }),
      on('special', (e) => { if (mine(e) && (e.name ?? 'inferno') === 'inferno') M.special = !!e.on; }),
      // (only used when the dragon has no fireCharge: the level at 'start' / 'full', ramped over player.js's 1.2 s)
      on('charge', (e) => {
        if (!mine(e)) return;
        const done = e.phase === 'release' || e.phase === 'cancel';
        M.chargeEv = done ? null : { level: clamp(+e.level || 0, 0, 1), t0: game.time?.now ?? 0 };
      }),
      on('skim', (e) => { if (mine(e)) M.skimEvt = e.on ? 1 : 0; }),
      on('fireball', (e) => { if (e.owner && (e.owner === this.actor || e.owner === this)) this._strike(e); }),
      on('nearmiss', (e) => { if (mine(e)) M.near = Math.min(1, M.near + 0.55 + 0.45 * clamp(((+e.speed || 40) - 35) / 40, 0, 1)); }),
      // 25.09 — levels and elements: game.progress belongs to the player (no actor field): the pose + the flash
      on('levelup', (e) => { if (mine(e)) this._levelUp(e); }),
      on('progress:reset', () => { if (game.player === this && this._el) { this._el.snap = true; M.lv.t = -1; } }),
    ];
    return () => { for (const f of offs) { try { f?.(); } catch { /* ignore */ } } };
  }

  /** A fireball leaves the jaws: the neck strikes forward and the jaw snaps (charged shots harder), the body recoils. */
  _strike(e) {
    const M = this._mv;
    if (!M.on || this.dying || this.display) return;
    const p = e.projectile, raw = p?.charged ?? p?.charge ?? e.charged ?? 0;
    const lvl = clamp(typeof raw === 'boolean' ? (raw ? 1 : 0) : +raw || 0, 0, 1);
    M.strike.v += MV.strike.kick * (0.45 + 0.55 * lvl);
    this._react.offV.z -= 0.5 + 1.1 * lvl;            // visual recoil of the drawn body (the pilot's impulse is physical)
  }

  _moveReset() {
    const M = this._mv;
    if (!M) return;
    M.cur = null; M.evt.on = false; M.special = false; M.chargeEv = null; M.skimEvt = 0; M.inf.on = false; M.inf.t = 0;
    for (const k of Object.keys(M.w)) M.w[k] = 0;
    const D = M.dodge; D.t = -1; D.angle = 0; D.rate = 0; D.prev = 0;
    M.strike.x = M.strike.v = 0; M.near = 0; M.out.on = false; M.out.rollAngle = 0; M.mean.init = false;
    M.lv.t = -1; M.out.lv = 0; M.out.lvRaw = 0;
    if (this._el) this._el.snap = true;
    if (!this._offMoves) { try { this._offMoves = this._moveEvents(); } catch { /* ignore */ } }
  }

  /**
   * 25.09 — a level gained ('levelup' { level, prev, tier, prevTier, element, elementChanged, … } from game.progress):
   * the level-up pose (≈ 0.8 s: rear up + roar, wings flared; visual only), a flash of the aura / eyes / membranes and a
   * burst of arcs; an element change crossfades the look (bigger flash). Several levels at once: one pose, one flash.
   */
  _levelUp(e) {
    if (this.dying || !this.alive || this.removed) return;
    const M = this._mv, E = this._el, big = e?.elementChanged ? 1 : 0;
    if (M.lv.on && (M.lv.t < 0 || M.lv.t > LV.attack + 0.1)) { M.lv.t = 0; M.lv.big = big; }
    else M.lv.big = Math.max(M.lv.big, big);
    M.lv.level = +e?.level || 0; M.lv.n++;
    if (E) {
      E.flash = 1; E.big = Math.max(E.big * 0.5, big); E.burst = 1;
      if (typeof e?.element === 'string' && ELEMENTS[e.element] && !E.knob) E.pending = e.element;
    }
  }

  /**
   * Flight moves, per render frame (dt = sim time: 0 while paused or in photo mode, so every pose holds). Reads the
   * move contract from whichever source exists — dragon.moves (player.js; the AI too if it sets it), the flight
   * body's state.mode (a flight.js program named like the move), the 'move' / 'special' / 'charge' / 'skim' events —
   * runs the visual timelines, writes the body-language targets into this._mv.out (read by the torso / neck / tail /
   * head handlers, the visual frame and the rider) and accents the wing pose. Never throws.
   */
  _movesStep(dt) {
    const M = this._mv, o = M.out;
    if (!M.on) { o.on = false; return o; }
    try { this._movesRead(dt); this._movesOut(); this._moveWings(dt); }
    catch (e) { o.on = false; o.rollAngle = 0; if (!M.err) { M.err = true; console.warn('[dragon] flight-move visuals failed', e); } }
    return o;
  }

  _movesRead(dt) {
    const M = this._mv, game = this.game, st = this.body.state || {};
    const knob = this.display ? (this.display.move || M.knob) : null;
    if (knob) { this._movesKnob(knob); return; }
    let name = null, side = 0, srcT = null, infOn = false, phase = null, u = null;
    if (!this.dying && !this.display) {
      const mv = this.moves;
      if (mv && typeof mv === 'object' && typeof mv.current === 'string') {
        name = mv.current; side = normSide(mv.side); srcT = Number.isFinite(mv.t) ? mv.t : null;
        phase = typeof mv.phase === 'string' ? mv.phase : null; u = Number.isFinite(mv.u) ? mv.u : null;
      }
      const sm = typeof st.move === 'string' ? st.move : st.mode;          // flight.js: state.move / movePhase / moveU
      if (!MOVE_NAMES.has(name) && typeof sm === 'string' && MOVE_NAMES.has(sm)) { name = sm; side = normSide(st.moveSide ?? st.moveDir ?? st.side); srcT = null; }
      if (name && name === sm) {
        if (!phase && typeof st.movePhase === 'string') phase = st.movePhase;
        if (u == null && Number.isFinite(st.moveU)) u = st.moveU;
      }
      if (M.evt.on && (game.time?.now ?? 0) - (M.evt.t0 ?? 0) > 6) M.evt.on = false;        // a lost 'end'
      if (!MOVE_NAMES.has(name) && M.evt.on && MOVE_NAMES.has(M.evt.name)) { name = M.evt.name; side = M.evt.side; srcT = null; }
      if (!MOVE_NAMES.has(name)) name = null;
      infOn = name === 'inferno' || this.infernoActive === true || M.special;
      if (name === 'inferno') name = null;
    }
    // the manoeuvre's own timeline (it runs on after the source ends: the releases, the dash's swept-back dart)
    let cur = M.cur;
    if (name) {
      const again = srcT != null && cur?.srcT != null && srcT + 0.05 < cur.srcT;      // re-triggered (moves.t restarted)
      if (!cur || !cur.active || cur.name !== name || again) cur = M.cur = { name, t: 0, side: side || cur?.side || 1, declared: side, active: true, srcT, endT: 0, phase, u };
      else { if (side) cur.declared = side; cur.srcT = srcT; cur.phase = phase; cur.u = u; }
    } else if (cur?.active) { cur.active = false; cur.endT = cur.t; }
    if (dt > 0) M.yawW = lerp(M.yawW, this._omega.y, damp(6, dt));   // world yaw rate, + = toward +X (a QA readout only)
    if (cur) {
      cur.t += dt;
      if (cur.name === 'wingover') this._woSide(cur, dt);
      else if (cur.declared) cur.side = cur.declared;
      const keep = cur.name === 'dash' ? MV.dash.end + 0.1 : 0;
      if (!cur.active && cur.t > Math.max(cur.endT + 1.2, keep)) M.cur = cur = null;
    }
    const want = (n) => (cur && cur.name === n && (cur.active || cur.t < MV[n].hold) ? 1 : 0);
    M.w.wingover = approach(M.w.wingover, want('wingover'), dt, MV.attack, MV.release);
    M.w.loop = approach(M.w.loop, want('loop'), dt, MV.attack, MV.release);
    // the flight body's move phases (pull → [loop: roll] → exit): the pull carries the arch / tuck / pumping, the
    // Immelmann's half roll its own tuck, the exit lets go (without phases: the pull all along, the roll from the rates)
    const ph = cur?.active ? cur.phase : null;
    // (quick releases: the exit spreads the wings for a strong stroke and the roll's tuck must not linger into it)
    M.w.pull = approach(M.w.pull, cur && (cur.name === 'wingover' || cur.name === 'loop') && (cur.active || cur.t < 0.5) && (!ph || ph === 'pull') ? 1 : 0, dt, MV.attack, 8);
    M.w.top = approach(M.w.top, cur?.name === 'loop' && ph === 'roll' ? 1 : 0, dt, 12, 12);
    // inferno: its own clock from the rising edge (the rear-up comes first)
    if (infOn && !M.inf.on) { M.inf.on = true; M.inf.t = 0; } else if (!infOn) M.inf.on = false;
    if (M.inf.on) M.inf.t += dt;
    M.w.inferno = approach(M.w.inferno, M.inf.on ? 1 : 0, dt, 12, 2.4);
    const fc = this.fireCharge, sk = this.skim;
    const ce = M.chargeEv, chEv = ce ? Math.min(1, ce.level + ((game.time?.now ?? 0) - ce.t0) / 1.2) : 0;
    const ch = this.dying ? 0 : typeof fc === 'number' && Number.isFinite(fc) ? fc : chEv;
    M.w.charge = approach(M.w.charge, clamp(ch || 0, 0, 1), dt, 14, 9);
    const skv = this.dying ? 0 : (typeof sk === 'number' && Number.isFinite(sk)) || typeof sk === 'boolean' ? +sk : M.skimEvt;
    M.w.skim = approach(M.w.skim, clamp(skv || 0, 0, 1), dt, 5, 3);
    // the dodge (FlightBody state.dodging ±1 while hopping) → a barrel roll of the drawn body; a new dodge mid-roll
    // rolls on to the next full turn (never a pop); none in the rider view (the seat camera would spin) or when grabbed
    const D = M.dodge, dg = this.dying || this.display ? 0 : Math.sign(st.dodging || 0);
    const riderView = game.player === this && game.cameraRig?.viewMode === 'rider';
    if (dg && dg !== D.prev && M.rollOn && !riderView && !this.grabbed) {
      D.base = D.t >= 0 ? D.angle : 0;
      D.end = (Math.round(D.base / TAU) + dg) * TAU;
      D.t = 0; D.dir = dg;
    }
    D.prev = dg;
    if (D.t >= 0 && dt > 0) {
      D.t += dt;
      const T = MV.roll.T, u = D.t / T;
      if (u >= 1 || riderView || this.dying) { D.t = -1; D.angle = 0; D.rate = 0; }
      else { const e = u * u * (3 - 2 * u); D.angle = D.base + (D.end - D.base) * e; D.rate = (D.end - D.base) * 6 * u * (1 - u) / T; }
    }
    // fireball strike (spring) and the near-miss flinch
    const S = M.strike;
    if (dt > 0 && (S.x !== 0 || S.v !== 0)) {
      const w = TAU * MV.strike.hz, z = MV.strike.zeta, n = Math.max(1, Math.ceil(dt * 240)), h = dt / n;
      for (let i = 0; i < n; i++) { S.v += (-w * w * S.x - 2 * z * w * S.v) * h; S.x += S.v * h; }
      if (Math.abs(S.x) < 1e-4 && Math.abs(S.v) < 1e-3) S.x = S.v = 0;
    }
    if (dt > 0) M.near = Math.max(0, M.near - dt * 2.2);
    // 25.09 — the level-up pose's clock (holds while paused: dt = 0; a fall ends it)
    const LVs = M.lv;
    if (LVs.t >= 0) { LVs.t += dt; if (LVs.t > LV.dur || this.dying) LVs.t = -1; }
  }

  /**
   * The wingover's side for the body language (inner-wing tuck, outer-wing pump, rudder, spine, neck, gaze, Kaede's
   * lean): the DECLARED one (moves.side / state.moveSide / the event), held for the whole move. The path's own heading
   * turn since the move began (the velocity's, unwrapped — no roll projected onto the yaw, no lag of a counter-turn
   * entry or of the roll-out) overrides it only when, past half the turn, it has gone > 30° the other way: a flipped
   * sign convention of that source (logged once, latched for the move, so the pose never swaps back and forth).
   * A move declared without a side takes the turn's way once it is 15° clear (+1 until then).
   */
  _woSide(cur, dt) {
    const v = this.body?.vel || this.vel, hs = Math.hypot(v.x, v.z);
    if (dt > 0 && hs > 3) {
      const h = Math.atan2(v.x, v.z);                     // + = toward +X = the dragon's left (normSide −1)
      if (Number.isFinite(cur.h)) { let d = h - cur.h; d -= TAU * Math.round(d / TAU); cur.turn = (cur.turn || 0) + d; }
      cur.h = h;
    }
    const turn = cur.turn || 0, phys = turn > 0 ? -1 : 1;
    if (!cur.declared) { if (cur.active && Math.abs(turn) > 15 * DEG) cur.side = phys; return; }
    if (!cur.flip && cur.active && Math.abs(turn) > 30 * DEG && phys !== cur.declared) {
      const u = Number.isFinite(cur.u) ? cur.u : cur.t / MV.wingover.dur;
      if (u >= 0.5) {
        cur.flip = true;
        if (!this._mv.sideWarn) {
          this._mv.sideWarn = true;
          console.warn(`[dragon] wingover side ${cur.declared} but the path turned ${Math.round(turn / DEG)}° the other way by ${Math.round(u * 100)} % of the move: following the turn`);
        }
      }
    }
    cur.side = cur.flip ? -cur.declared : cur.declared;
  }

  /** Review knob for display dragons (Dragon Studio): ?dragonMove=wingover|loop|dash|inferno|roll&dragonMoveT=0.6&
   *  dragonMoveSide=-1, ?dragonCharge=0.8, ?dragonSkim=1 (or display.move = { name, t, side, charge, skim }). */
  _movesKnob(k) {
    const M = this._mv;
    const dur = { wingover: MV.wingover.dur, loop: MV.loop.dur, dash: MV.dash.end, inferno: MV.inferno.dur, roll: MV.roll.T, levelup: LV.dur };
    const n = k.name, T = dur[n] || 1.5, side = normSide(k.side) || 1;
    const t = Number.isFinite(k.t) ? k.t : this._t % (T + 0.6);
    const man = n === 'wingover' || n === 'loop' || n === 'dash';
    M.cur = man ? { name: n, t, side, declared: side, active: t < T, endT: T } : null;
    M.w.wingover = n === 'wingover' && t < T ? 1 : 0; M.w.loop = n === 'loop' && t < T ? 1 : 0;
    M.w.pull = (n === 'wingover' || n === 'loop') && t < T ? 1 : 0; M.w.top = 0;
    M.inf.on = n === 'inferno' && t < T; M.inf.t = t; M.w.inferno = M.inf.on ? 1 : 0;
    M.w.charge = clamp(k.charge ?? 0, 0, 1); M.w.skim = clamp(k.skim ?? 0, 0, 1);
    M.lv.t = n === 'levelup' && t < T ? t : -1;
    const D = M.dodge;
    if (n === 'roll' && t < T) { const u = t / T, e = u * u * (3 - 2 * u); D.t = t; D.dir = side; D.base = 0; D.end = side * TAU; D.angle = D.end * e; D.rate = D.end * 6 * u * (1 - u) / T; }
    else { D.t = -1; D.angle = 0; D.rate = 0; }
  }

  /** Body-language targets from the timelines and weights (rad unless noted), into this._mv.out. */
  _movesOut() {
    const M = this._mv, o = M.out, cur = M.cur, om = this._omegaF;
    const t = cur ? cur.t : 0;
    const W = MV.wingover, L = MV.loop, DA = MV.dash, IN = MV.inferno, C = MV.charge, K = MV.skim;
    o.on = true; o.name = cur?.name || null; o.t = t;
    const wo = M.w.wingover, lp = M.w.loop, sk = M.w.skim, ch = M.w.charge;
    if (cur?.name === 'wingover') o.side = cur.side || 1;
    o.wo = wo;
    // wingover: the head leads the reversal (most through the first two thirds of the turn: moveU, else the clock);
    // the inner-wing tuck, the outer wing's pumping and the rudder belong to the pull
    const u = cur?.name === 'wingover' ? (Number.isFinite(cur.u) ? cur.u : clamp(t / W.dur, 0, 1)) : 0.5;
    o.woLead = wo * (cur?.name === 'wingover' ? smoothstep(0.0, 0.2, u) * (1 - 0.55 * smoothstep(0.7, 1, u)) : 0.5);
    o.woPull = wo * lerp(0.45, 1, M.w.pull);
    // loop: the arch follows the real pitch-up rate (at least half of it while pulling); a tuck in the half roll on
    // top (flight.js phase 'roll', else the roll rate)
    o.lp = lp;
    o.pull = lp * M.w.pull * (this.display ? 1 : 0.5 + 0.5 * clamp(-om.x / 1.3, 0, 1));
    o.rollTop = lp * Math.max(M.w.top, cur?.phase ? 0 : smoothstep(1.4, 2.8, Math.abs(om.z)));
    // dash: one huge stroke (0 … 0.3 s), then the wings swept back into a dart (≈ 0.26 … 1 s)
    let da = 0, sw = 0;
    if (cur?.name === 'dash') {
      da = smoothstep(0, 0.08, t) * (1 - smoothstep(DA.down, DA.down + 0.12, t));
      sw = smoothstep(DA.down - 0.06, DA.down + 0.08, t) * (1 - smoothstep(DA.end - 0.32, DA.end, t));
    }
    o.da = da; o.sw = sw;
    const mode = this.body.state?.mode;
    // the flight body strokes the dash itself (its 'dash' program): exaggerate that (latched for the move)
    if (cur?.name === 'dash' && (mode === 'dash' || mode === 'beat')) cur.scripted = true;
    o.scripted = !!cur?.scripted;
    // inferno: rear up (≈ 0.3 s), then the super-breath pose
    const it = M.inf.t;
    o.rear = M.inf.on ? smoothstep(0, 0.1, it) * (1 - smoothstep(IN.rear - 0.04, IN.rear + 0.14, it)) : 0;
    o.inf = M.w.inferno * smoothstep(IN.rear - 0.1, IN.rear + 0.12, M.inf.on ? it : 9);
    o.ch = ch; o.sk = sk;
    const D = M.dodge;
    o.rollAngle = D.t >= 0 ? D.angle : 0; o.rollRate = D.t >= 0 ? D.rate : 0;
    o.roll = D.t >= 0 ? Math.sin(Math.PI * clamp(D.t / MV.roll.T, 0, 1)) : 0;
    o.strike = clamp(M.strike.x / 0.24, -0.6, 1.2);
    o.near = M.near;
    o.arch = (L.arch * o.pull + IN.pitch * 0.9 * o.rear + C.puff * ch * (1 - o.rear)) * DEG;
    o.bend = -o.side * W.bend * DEG * o.woPull;
    o.neckUp = (L.neck * o.pull + IN.neck * o.rear + K.neck * sk + DA.neck * Math.max(da, sw * 0.6) + MV.strike.neck * o.strike - 4 * o.inf) * DEG;
    o.coil = C.coil * DEG * ch * (1 - o.rear);
    o.neckYaw = -o.side * W.neck * DEG * o.woLead;
    o.tailYaw = o.side * W.tail * DEG * o.woPull;        // Ry(+) swings the tail toward −X: a rudder into the turn
    o.tailUp = (L.tail * o.pull + W.tailUp * wo + IN.tail * o.rear) * DEG;
    o.calm = clamp(Math.max(da, sw, sk * 0.8, o.roll, o.inf * 0.5), 0, 1);
    o.jaw = Math.max(ch > 0.02 ? 0.05 + C.jaw * ch : 0, IN.jaw * o.rear, (IN.jaw - 0.04) * o.inf, 0.32 * clamp(o.strike, 0, 1));
    o.tuck = Math.max(wo, lp, da, sw, sk, o.roll, o.rear);
    o.pitch = IN.pitch * DEG * o.rear;
    o.heave = cur?.name === 'dash' ? DA.heave * Math.sin(Math.PI * clamp((t - DA.up) / (DA.down + 0.1 - DA.up), 0, 1)) : 0;
    o.shudder = IN.shudder * DEG * o.inf;
    // 25.09 — the level-up pose (rear up + roar, wings flared, see LV): damped under another move; while breathing the
    // head keeps the aim (no skyward gaze, a smaller neck lift — the flame goes where it went); half the rear-up in the
    // rider view (the seat camera rides on it)
    const busy = Math.max(wo, lp, da, sw, o.roll, o.inf, o.rear);
    o.lvRaw = M.lv.t >= 0 ? lvEnvelope(M.lv.t) : 0;
    const lv = o.lv = o.lvRaw * (1 - 0.7 * busy);
    const lvBr = this.breathing ? 1 : 0;
    if (lv > 1e-3) {
      const rv = this.game.player === this && this.game.cameraRig?.viewMode === 'rider' ? 0.5 : 1;
      o.arch += LV.arch * DEG * lv; o.neckUp += LV.neck * DEG * lv * (1 - 0.6 * lvBr); o.tailUp += LV.tail * DEG * lv;
      o.jaw = Math.max(o.jaw, LV.jaw * lv); o.pitch += LV.pitch * DEG * lv * rv; o.calm = Math.max(o.calm, 0.6 * lv);
      o.shudder = Math.max(o.shudder, LV.shudder * DEG * lv * smoothstep(0.1, 0.25, M.lv.t));
    }
    // gaze (model frame): the reversal's new heading, up along the loop, skyward in the rear-up
    const gz = o.gaze.set(0, 0, 0);
    let gw = 0;
    if (o.woLead > 0.01) { const a = W.gaze * DEG; gz.addScaledVector(_v5.set(-o.side * Math.sin(a), 0.1, Math.cos(a)), o.woLead); gw = Math.max(gw, o.woLead); }
    if (o.pull > 0.01) { const a = L.gaze * DEG; gz.addScaledVector(_v5.set(0, Math.sin(a), Math.cos(a)), o.pull); gw = Math.max(gw, o.pull); }
    if (o.rear > 0.01) { const a = IN.gazeUp * DEG; gz.addScaledVector(_v5.set(0, Math.sin(a), Math.cos(a)), o.rear * 2); gw = Math.max(gw, o.rear); }
    const lvG = lv * (1 - lvBr);
    if (lvG > 0.01) { const a = LV.gazeUp * DEG; gz.addScaledVector(_v5.set(0, Math.sin(a), Math.cos(a)), lvG * 2); gw = Math.max(gw, lvG); }
    if (gz.lengthSq() > 1e-6) gz.normalize(); else gz.set(0, 0, 1);
    o.gazeW = clamp(gw, 0, 1) * 0.85;
  }

  /**
   * Wing accents on the interpolated physics pose (visual; the flight owner's strokes and tucks stay underneath):
   * wingover — inner wing tucked toward wingkin's dive tuck, outer wing pumping (its stroke exaggerated about a running
   * mean, so it stays in phase); loop — spread and loaded, a tuck in the half roll; dash — one huge stroke (the flight
   * body's own stroke exaggerated, or a keyed one), then swept back; barrel roll — half-tucked; inferno — braced wide
   * (wingkin's flare); skim — a gull glide (shoulders up, hands angled down).
   */
  _moveWings(dt) {
    const M = this._mv, o = M.out, P = this._pose, mean = M.mean;
    if (!mean.init) { mean.L.copy(P.L.shoulder); mean.R.copy(P.R.shoulder); mean.init = true; }
    else if (dt > 0) { const k = damp(2, dt); mean.L.slerp(P.L.shoulder, k); mean.R.slerp(P.R.shoulder, k); }
    if (!o.on || this.dying) return;
    const refs = this._moveRefs();
    if (o.woPull > 0.01) {
      // (pumping only while the wings beat: over the top the flight body stops the strokes and half-folds both)
      const inner = o.side < 0 ? 'L' : 'R', outer = inner === 'L' ? 'R' : 'L';
      if (refs) this._slerpWing(P[inner], refs.tuck[inner], MV.wingover.tuck * o.woPull, 0.55);
      this._pump(outer, 1 + (MV.wingover.pump - 1) * o.woPull * smoothstep(0.2, 0.5, P.flapAmount ?? 1));
    }
    if (o.pull > 0.01 || o.rollTop > 0.01) {
      for (const S of ['L', 'R']) {
        this._spread(P[S], MV.loop.spread * o.pull);
        if (refs && o.rollTop > 0.01) this._slerpWing(P[S], refs.tuck[S], MV.loop.rollTuck * o.rollTop, 0.6);
      }
    }
    if (o.da > 0.01) {
      // the flight body strokes the dash itself (flight.js PROGRAMS.dash): a touch more reach; else a keyed stroke
      if (o.scripted) { const k = lerp(1, MV.dash.pumpScripted, o.da); this._pump('L', k, MV.dash.pumpMax); this._pump('R', k, MV.dash.pumpMax); }
      else this._dashStroke(o.t, o.da, refs);
    }
    if (refs) {
      const swK = o.scripted ? MV.dash.sweepScripted : MV.dash.sweep;
      if (o.sw > 0.01) for (const S of ['L', 'R']) this._slerpWing(P[S], refs.sweep[S], swK * o.sw, 1);
      if (o.roll > 0.01) for (const S of ['L', 'R']) this._slerpWing(P[S], refs.tuck[S], 0.3 * o.roll, 0.6);
      const fl = Math.max(o.inf, o.rear) * MV.inferno.spread;
      if (fl > 0.01) for (const S of ['L', 'R']) this._slerpWing(P[S], refs.flare[S], fl, 1);
    }
    // 25.09 — the level-up pose: wings flared (toward wingkin's flare), spread to full span and raised in a V (the
    // stroke stays underneath at the reduced weight)
    if (o.lv > 0.01) {
      for (const S of ['L', 'R']) {
        if (refs) this._slerpWing(P[S], refs.flare[S], LV.flare * o.lv, 0.6);
        this._spread(P[S], LV.spread * o.lv);
        _q3.setFromAxisAngle(Z, LV.raise * DEG * o.lv); if (S === 'R') mirrorQ(_q3, _q3);
        P[S].shoulder.premultiply(_q3);
      }
    }
    if (o.sk > 0.01) {
      const w = o.sk * (1 - 0.6 * clamp(P.flapAmount || 0, 0, 1));
      this._gull(P.L, w, false); this._gull(P.R, w, true);
    }
  }

  /** Static wingkin reference poses on this dragon's wing geometry: dive tuck, half tuck (swept dart), flare. */
  _moveRefs() {
    const M = this._mv, geom = this._wings?.geom;
    if (!WK?.evaluatePose || !WK.defaultParams || !geom) return null;
    if (M.refs?.geom === geom) return M.refs;
    const mk = (over) => { const P = WK.defaultParams(); Object.assign(P, { a: 0, phase: 0.25, airspeed: 34 }, over); return WK.evaluatePose(P, geom, WK.createPose()); };
    M.refs = { geom, tuck: mk({ tuck: 1 }), sweep: mk({ tuck: 0.55 }), flare: mk({ flare: 0.7, camber: 0.8 }) };
    return M.refs;
  }

  _slerpWing(side, ref, w, kShoulder = 1) {
    if (!(w > 1e-3) || !ref) return;
    if (kShoulder > 0) side.shoulder.slerp(ref.shoulder, w * kShoulder);
    side.elbow.slerp(ref.elbow, w); side.wrist.slerp(ref.wrist, w);
    for (let i = 0; i < 4; i++) side.fingers[i].slerp(ref.fingers[i], w);
    side.fold = lerp(side.fold, ref.fold ?? side.fold, w); side.camber = lerp(side.camber, ref.camber ?? side.camber, w);
  }

  /** Unfold toward the spread bind (loaded, full span). */
  _spread(side, w) {
    if (!(w > 1e-3)) return;
    side.elbow.slerp(_q3.identity(), w); side.wrist.slerp(_q3.identity(), w * 0.8);
    side.fold *= 1 - w;
  }

  /** Exaggerate this wing's stroke by k about its running mean (in phase with the physics), extra ≤ MV.pumpMax. */
  _pump(S, k, maxDeg = MV.pumpMax) {
    if (!(k > 1.001)) return;
    const q = this._pose[S].shoulder, m = this._mv.mean[S];
    const d = _q3.copy(m).invert().multiply(q);
    scaleRot(d, k, maxDeg * DEG, d);
    q.copy(m).multiply(d);
  }

  /** Gull glide: shoulder elevation up, the hand angled down at the wrist (left frame; the right wing mirrored). */
  _gull(side, w, right) {
    _q3.setFromAxisAngle(Z, MV.skim.shoulder * DEG * w); if (right) mirrorQ(_q3, _q3);
    side.shoulder.premultiply(_q3);
    _q3.setFromAxisAngle(Z, -MV.skim.droop * DEG * w); if (right) mirrorQ(_q3, _q3);
    side.wrist.premultiply(_q3);
  }

  /** The dash's one huge stroke when the flight body does not stroke it itself: up (anticipation, hand folded) →
   *  down (fully spread, driving) → held while the sweep takes over. */
  _dashStroke(t, w, refs) {
    const D = MV.dash, P = this._pose;
    let psi, up;
    if (t < D.up) { const e = 0.5 - 0.5 * Math.cos(Math.PI * t / D.up); psi = D.psiUp * DEG * e; up = e; }
    else if (t < D.down) { const e = 0.5 - 0.5 * Math.cos(Math.PI * (t - D.up) / (D.down - D.up)); psi = (D.psiUp + (D.psiDown - D.psiUp) * e) * DEG; up = 1 - e; }
    else { psi = D.psiDown * DEG; up = 0; }
    for (const S of ['L', 'R']) {
      const side = P[S];
      _q3.setFromAxisAngle(Z, psi); if (S === 'R') mirrorQ(_q3, _q3);
      side.shoulder.slerp(_q3, w);
      if (refs && up > 0.01) this._slerpWing(side, refs.sweep[S], 0.45 * up * w, 0);
      this._spread(side, 0.6 * w * (1 - up));
      if (t > D.up && t < D.down) side.downstroke = true;
      side.camber = lerp(side.camber, up > 0.5 ? 0.2 : 0.9, w);
    }
  }

  /** The mouth glow (charge, inferno): a camera-facing glow quad on the head bone just inside the jaws. */
  _glowStep(o, dt) {
    const M = this._mv, hi = this._headIdx;
    // (25.09: + the element's smoulder / breath glow / level-up roar, in the element's colours — see _elemStep)
    const E = this._el, em = E.active && !this.dying ? E.mouth : null;
    const k = Math.max(o.on && !this.dying ? Math.max(o.ch, o.rear, o.inf * 0.5) : 0, em ? E.mouthK : 0);
    let g = M.glow;
    if (!g) {
      if (k < 0.02 || hi < 0 || !this._mouthLocal || !this.rig) return;
      g = M.glow = new MouthGlow(this.scale);
      const rig = this.rig, qi = _q3.copy(rig.Qb[hi]).invert(), s = rig.Sb[hi] || 1;
      g.mesh.position.copy(this._mouthLocal).addScaledVector(_v1.copy(Z).applyQuaternion(qi), -0.3 / s);
      rig.bones[hi].add(g.mesh);
    }
    g.update(o, k, this._t, em);
  }

  // ------------------------------------------------------------------ levels and elements (25.09)
  /**
   * On every model (fallback, then the GLB): the hero's toon materials get the element rim / spar patch (uniforms at 0
   * until the look is active: nothing changes for a dragon that is not the player), the membrane back-light's own values
   * are recorded (the ember look at level 1 IS the look before 25.09), and the eye / horn landmarks go to head-bone
   * space. The aura hull, the eye glow and the arcs are built lazily when the look first needs them.
   */
  _elemSetup(model) {
    const E = this._el;
    this._elemDetach();
    E.U = null; E.mats = null; E.eyeLocal = null; E.hornLocal = null; E.bodyMesh = null; E.looks = null; E.memb0 = null;
    if (!E.on || this.variant !== 'hero' || !model) return;            // enemies unchanged
    const U = E.U = {
      uElemRim: { value: new THREE.Color() }, uElemRim2: { value: new THREE.Color() }, uElemSpar: { value: new THREE.Color() },
      uElemK: { value: new THREE.Vector4(0, 0, 0, 0) },
    };
    const mats = model.materials || {}, memb = mats.membrane, hasMemb = !!(memb && model.membraneUniforms);
    E.mats = [];
    for (const m of new Set([mats.body, memb, ...(mats.all || [])])) {
      if (!m || m === mats.eyes || !(m.isMeshToonMaterial || m.isMeshStandardMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial)) continue;
      patchElement(m, U, m === memb && hasMemb);
      E.mats.push(m);
    }
    const MU = model.membU || model.membraneUniforms;
    if (MU?.uMembGlowColor) {
      E.memb0 = { color: MU.uMembGlowColor.value.clone(), mix: MU.uMembGlowMix?.value ?? 0.3, k: MU.uMembGlow?.value ?? 1, base: MU.uMembGlowBase?.value ?? 0,
        A: MU.uMembA?.value?.clone?.() || null, B: MU.uMembB?.value?.clone?.() || null };
    }
    const rig = this.rig, hi = rig?.i('head') ?? -1;
    if (hi >= 0) {
      const qi = rig.Qb[hi].clone().invert(), s = rig.Sb[hi] || 1;
      const toHead = (p) => new THREE.Vector3().copy(p).sub(rig.Pb[hi]).divideScalar(s).applyQuaternion(qi);
      let eyes = null, horns = null;
      if (model.fallback) { eyes = model.eyes?.length ? model.eyes : null; horns = model.horns?.length ? model.horns : null; }
      else {
        const e = GLB_EYES[model.key], h = GLB_HORNS[model.key];
        if (e) eyes = [new THREE.Vector3(e[0], e[1], e[2]), new THREE.Vector3(-e[0], e[1], e[2])];
        if (h) horns = [h.map((p) => new THREE.Vector3(p[0], p[1], p[2])), h.map((p) => new THREE.Vector3(-p[0], p[1], p[2]))];
      }
      E.eyeLocal = eyes ? eyes.map(toHead) : null;
      E.hornLocal = horns ? horns.map((hp) => hp.map(toHead)) : null;
    }
    E.bodyMesh = (model.skinned || []).find((m) => m.material === mats.body && m.isSkinnedMesh) || null;
    E.spars = null; E.snap = true;
    if (E.active) { E.active = false; E.cur = null; }                 // rebuilt on the next step (new uniforms)
  }

  /** What the look shows: { element, tier, level } or null (not the player / not the hero → the look is off). */
  _elemSource() {
    const E = this._el, g = this.game;
    if (this.variant !== 'hero' || !E.U) return null;
    const isP = g.player === this;
    if (!isP && !this.display) return null;
    const dk = this.display && typeof this.display.element === 'string' && ELEMENTS[this.display.element] ? this.display.element : null;
    const knob = dk || E.knob;
    if (knob) { const tier = ELEM_TIER[knob]; return { element: knob, tier, level: E.knobLevel ?? tier * 2 - 1 }; }
    if (!isP) return null;
    const P = g.progress;
    if (P && typeof P.element === 'string' && ELEMENTS[P.element]) {
      const lv = Number.isFinite(+P.level) ? clamp(Math.round(+P.level), 1, 10) : 1;
      return { element: P.element, tier: ELEM_TIER[P.element], level: lv };
    }
    return { element: 'ember', tier: 1, level: 1 };                  // no progression system: the look before 25.09
  }

  _elemLook(name) {
    const E = this._el, L = E.looks || (E.looks = {});
    if (L[name]) return L[name];
    const s = ELEMENTS[name] || ELEMENTS.ember, tier = ELEM_TIER[name] || 1, C = (h) => new THREE.Color(h);
    const o = { name, tier, glow: C(s.glow), mix: s.mix, memb: s.memb, base: s.base, membA: C(s.membA), membB: C(s.membB), eye: C(s.eye),
      core: C(s.core), halo: C(s.halo), aura: C(s.aura), aura2: C(s.aura2), spar: C(s.spar), arc: C(s.arc || s.core), arc2: C(s.arc2 || s.halo),
      arcs: s.arcs, flick: s.flick, sparK: ELEM_K.spar[tier] || 0 };
    // ember keeps the membranes exactly as they were (incl. the ?dragonMemb=0 A/B)
    if (name === 'ember' && E.memb0) {
      const m = E.memb0;
      o.glow.copy(m.color); o.mix = m.mix; o.memb = m.k; o.base = m.base;
      if (m.A) { o.membA.copy(m.A); o.membB.copy(m.B); }
    }
    return (L[name] = o);
  }

  _elemRetarget(name, snap) {
    const E = this._el, to = this._elemLook(name);
    if (!E.cur) { E.cur = lookCopy(null, to); E.from = lookCopy(null, to); snap = true; }
    lookCopy(E.from, E.cur);
    E.to = to; E.name = name; E.fade = snap ? 1 : 0;
    if (snap) lookCopy(E.cur, to);
  }

  /**
   * Per render frame for the player (dt = sim time: everything holds while paused): the source (game.progress / the
   * knob), the crossfade, then membranes, rim / spar patch, the aura hull, the eyes, the mouth glow values (drawn by
   * _glowStep) and the arcs. Never throws (the caller catches, logs once).
   */
  _elemStep(dt) {
    const E = this._el, game = this.game;
    const src = this._elemSource();
    if (!src) { if (E.active) this._elemOff(); return; }
    let name = src.element, level = src.level;
    // a 'levelup' names the new element: shown at once even if game.progress is read a frame late
    if (E.pending) {
      E.pendingT = (E.pendingT || 0) + dt;
      if (E.pending === name || E.pendingT > 0.5) { E.pending = null; E.pendingT = 0; }
      else { name = E.pending; level = Math.max(level, this._mv.lv.level || level); }
    }
    if (!E.active || E.snap || name !== E.name || !E.cur) this._elemRetarget(name, !E.active || E.snap);
    E.active = true; E.snap = false;
    const tier = ELEM_TIER[name];
    E.tier = tier; E.level = level;
    E.t += dt;
    if (E.fade < 1 && dt > 0) { E.fade = Math.min(1, E.fade + dt / ELEM_K.fade); }
    const cur = lookLerp(E.cur, E.from, E.to, smoothstep(0, 1, E.fade));
    // strengths: the aura by level (ramps over ≈ 0.5 s), the level-up flash (≈ 0.9 s), the arcs' burst
    E.aura = approach(E.aura, LEVEL_AURA[clamp(level, 1, 10) - 1], dt, 2.2, 2.2);
    if (dt > 0) {
      E.flash = Math.max(0, E.flash - dt / 0.9); E.burst = Math.max(0, E.burst - dt / 0.7);
      E.memFlash = Math.max(0, E.memFlash - dt / 0.09);
      if (E.flash <= 0) E.big = 0;
    }
    const fl = E.flash * E.flash, flashK = fl * (E.big ? ELEM_K.flashBig : ELEM_K.flash);
    const life = this.dying ? 0.25 : 1;
    // membranes: the back-light in the element's colour (a lightning arc on a wing flashes it toward the arc's colour)
    const MU = this.model?.membU || this.model?.membraneUniforms;
    if (MU?.uMembGlowColor) {
      MU.uMembGlowColor.value.copy(cur.glow);
      if (E.memFlash > 0.01) MU.uMembGlowColor.value.lerp(cur.arc, 0.6 * E.memFlash);
      if (MU.uMembGlowMix) MU.uMembGlowMix.value = cur.mix;
      if (MU.uMembGlow) MU.uMembGlow.value = cur.memb * (1 + 0.3 * flashK + 0.9 * E.memFlash) * (this.dying ? 0.6 : 1);
      if (MU.uMembGlowBase) MU.uMembGlowBase.value = cur.base + 0.08 * E.aura + 0.05 * flashK;
      // (the GLB's membrane albedo gradient: the wings themselves take the element's colour — they fill the chase view)
      if (MU.uMembA && MU.uMembB && E.memb0?.A) { MU.uMembA.value.copy(cur.membA); MU.uMembB.value.copy(cur.membB); }
    }
    // rim on the body / membranes and the glowing spars (lightning: crackling)
    const U = E.U;
    U.uElemRim.value.copy(cur.aura); U.uElemRim2.value.copy(cur.aura2); U.uElemSpar.value.copy(cur.spar);
    const rimK = ELEM_K.rim * (E.aura + 0.35 * flashK) * life;
    const sparK = cur.sparK * (1 + 0.5 * flashK + 1.2 * E.memFlash) * life;
    U.uElemK.value.set(rimK, sparK, E.t % 1000, cur.flick);
    // aura hull
    const hullK = ELEM_K.hull * (E.aura + 0.5 * flashK) * life;
    if (hullK > 0.01 && !E.hull && E.bodyMesh) E.hull = new ElementAura(E.bodyMesh, game);
    if (E.hull) E.hull.update(cur, hullK, lerp(ELEM_K.push[0], ELEM_K.push[1], E.aura) + 0.08 * fl, E.t % 1000, cur.flick);
    // eyes
    const eyeK = ELEM_K.eye[tier - 1] * (1 + 1.2 * flashK) * (this.dying ? 0.2 : 1);
    if (!E.eyes && E.eyeLocal && this.rig && this._headIdx >= 0) {
      const eyes = E.eyes = makeEyeGlow(new THREE.Color(), ELEM_K.eyeSize * this.scale);
      const arr = eyes.geometry.attributes.position.array;
      E.eyeLocal.slice(0, 2).forEach((v, k) => { arr[k * 3] = v.x; arr[k * 3 + 1] = v.y; arr[k * 3 + 2] = v.z; });
      eyes.geometry.attributes.position.needsUpdate = true;
      eyes.name = 'dragon_element_eyes';
      this.rig.bones[this._headIdx].add(eyes);
    }
    if (E.eyes) {
      const u = E.eyes.material.uniforms;
      u.uColor.value.copy(cur.eye).multiplyScalar(eyeK);
      u.uLife.value = 1;
      u.uViewH.value = game.pipeline?.stats?.height || game.renderer?.getDrawingBufferSize?.(_v4).y || 900;
      E.eyes.visible = eyeK > 0.01;
    }
    // mouth (drawn by _glowStep → MouthGlow): a smoulder between the jaws, brighter while breathing, the level-up roar
    const lvW = this._mv.out?.lv || 0;
    const flick = cur.flick > 0 ? 0.55 + 0.9 * Math.random() * cur.flick + (1 - cur.flick) * 0.45 : 0.8 + 0.2 * Math.sin(E.t * 7.3) * Math.sin(E.t * 3.1 + 1);
    const idle = ELEM_K.mouthIdle[tier - 1] * flick, br = this.breathing ? ELEM_K.mouthBreath[tier - 1] * flick : 0;
    const roar = lvW * (1.4 + 0.8 * (this._mv.lv.big || 0));
    E.mouthK = this.dying ? 0 : Math.max(idle, br, roar);
    const M = E.mouth || (E.mouth = { core: new THREE.Color(), halo: new THREE.Color(), size: 0, k: 0, rays: 0 });
    M.core.copy(cur.core); M.halo.copy(cur.halo);
    M.size = Math.max(idle > 0.005 ? 0.24 + 0.03 * tier : 0, br > 0.005 ? 0.7 : 0, roar > 0.005 ? 1.1 + 1.0 * roar : 0);
    M.k = E.mouthK; M.rays = Math.max(roar, br * 0.5, cur.flick * 0.3 * (idle > 0 ? 1 : 0));
    // arcs over the horns and wing spars (lightning / storm tiers; a burst on a level-up)
    const rate = cur.arcs * (1 + 3 * E.burst) * (this.dying ? 0 : 1);
    if ((rate > 0.5 || E.arcs?.live) && game.camera) {
      if (!E.arcs) E.arcs = new ElementArcs(game, this.scale);
      this._elemSpars();
      const n = E.arcs.update(E.spars, E.nSpars, dt, rate, cur, game.camera, () => { if (Math.random() < 0.45) E.memFlash = Math.max(E.memFlash, 0.5 + 0.5 * Math.random()); });
      E.out.arcs = n;
    } else E.out.arcs = 0;
    const O = E.out;
    O.element = name; O.tier = tier; O.level = level; O.aura = +E.aura.toFixed(3); O.flash = +flashK.toFixed(3); O.hull = +hullK.toFixed(3);
    O.eye = +eyeK.toFixed(3); O.mouth = +E.mouthK.toFixed(3); O.lv = +lvW.toFixed(3); O.fade = +E.fade.toFixed(3);
  }

  /** World polylines of the horns (head-bone landmarks) and the wing spars (arm, 4 fingers per side), this frame. */
  _elemSpars() {
    const E = this._el, rig = this.rig, hi = this._headIdx;
    const S = E.spars || (E.spars = []);
    let k = 0;
    const toW = (v) => v.multiplyScalar(this.scale).applyQuaternion(this.visual.quaternion).add(this.visual.position).applyQuaternion(this.root.quaternion).add(this.root.position);
    const slot = (kind, side, n) => {
      const sp = S[k] || (S[k] = { pts: [], cum: [], len: 0, kind, side });
      sp.kind = kind; sp.side = side;
      while (sp.pts.length < n) sp.pts.push(new THREE.Vector3());
      sp.n = n; k++;
      return sp;
    };
    const finish = (sp) => {
      sp.cum[0] = 0;
      for (let i = 1; i < sp.n; i++) sp.cum[i] = sp.cum[i - 1] + sp.pts[i].distanceTo(sp.pts[i - 1]);
      sp.len = sp.cum[sp.n - 1];
    };
    if (E.hornLocal && hi >= 0) {
      E.hornLocal.forEach((h, j) => {
        const sp = slot('horn', j ? 'R' : 'L', h.length);
        h.forEach((l, i) => toW(rig.pointAt(hi, l, sp.pts[i])));
        finish(sp);
      });
    }
    for (const side of ['L', 'R']) {
      const ids = ['wing_shoulder_', 'wing_elbow_', 'wing_wrist_'].map((p) => rig.i(p + side));
      if (ids.every((i) => i >= 0)) {
        const sp = slot('arm', side, 3);
        ids.forEach((i, j) => toW(sp.pts[j].copy(rig.Pm[i])));
        finish(sp);
      }
      for (let f = 1; f <= 4; f++) {
        const i = rig.i(`wing_f${f}_${side}`);
        if (i < 0) continue;
        const sp = slot('finger', side, 3);
        sp.pts[0].copy(rig.Pm[i]); rig.tipOf(i, sp.pts[2]); sp.pts[1].lerpVectors(sp.pts[0], sp.pts[2], 0.5);
        for (let j = 0; j < 3; j++) toW(sp.pts[j]);
        finish(sp);
      }
    }
    E.nSpars = k;
  }

  /** The look off (no longer the player, the layer switched off): the membranes back to their own values, parts hidden. */
  _elemOff() {
    const E = this._el;
    E.active = false; E.mouthK = 0; E.flash = 0; E.burst = 0; E.memFlash = 0;
    const MU = this.model?.membU || this.model?.membraneUniforms, m0 = E.memb0;
    if (MU && m0) {
      MU.uMembGlowColor?.value.copy(m0.color);
      if (MU.uMembGlowMix) MU.uMembGlowMix.value = m0.mix;
      if (MU.uMembGlow) MU.uMembGlow.value = m0.k;
      if (MU.uMembGlowBase) MU.uMembGlowBase.value = m0.base;
      if (m0.A && MU.uMembA && MU.uMembB) { MU.uMembA.value.copy(m0.A); MU.uMembB.value.copy(m0.B); }
    }
    E.U?.uElemK.value.set(0, 0, 0, 0);
    if (E.hull) E.hull.mesh.visible = false;
    if (E.eyes) E.eyes.visible = false;
    E.arcs?.clear();
  }

  /** Parts on the current model (the hull on the body mesh, the eye glow on the head bone): removed and disposed. */
  _elemDetach() {
    const E = this._el;
    if (!E) return;
    if (E.hull) { E.hull.dispose(); E.hull = null; }
    if (E.eyes) { E.eyes.parent?.remove(E.eyes); E.eyes.geometry.dispose(); E.eyes.material.dispose(); E.eyes = null; }
  }

  _elemDispose() {
    this._elemDetach();
    const E = this._el;
    if (E?.arcs) { E.arcs.dispose(); E.arcs = null; }
  }

  // ------------------------------------------------------------------ hover / flight modes (24.09): body language
  /**
   * Per render frame (dt = sim time: 0 while paused, every pose holds). Reads the flight mode (the flight body's
   * state.hover, else game.player.flightMode / throttle, else the display gait), measures the strafe, climb / sink,
   * flare and take-off from the body's own motion, runs the leg pendulums and accents the wing pose (before the hit
   * flail, which wins). Writes this._hv.out (read by the neck / tail / head / leg handlers, the visual frame, the
   * membranes and the rider). Nothing here writes the physics, the controls or another system's state. Never throws.
   */
  _hoverStep(dt, mo) {
    const H = this._hv, o = H.out;
    if (!H.on) { o.on = false; return o; }
    try { this._hoverRead(dt, mo); this._hoverWings(); }
    catch (e) { o.on = false; o.pitchTop = 0; o.leanTop = 0; if (!H.err) { H.err = true; console.warn('[dragon] hover visuals failed', e); } }
    return o;
  }

  _hoverReset() {
    const H = this._hv;
    if (!H) return;
    H.hv = H.fl = H.to = H.recent = H.np = H.climb = H.sink = H.strafe = H.ax = 0;
    for (const k of Object.keys(H.leg)) H.leg[k].fill(0);
    H.out.on = false; H.out.pitchTop = 0; H.out.leanTop = 0;
  }

  _hoverRead(dt, mo) {
    const H = this._hv, o = H.out, st = this.body.state || {}, F = HV.flare, T = HV.takeoff;
    const q = this.root.quaternion, disp = this.display;
    const vh = Math.hypot(this.vel.x, this.vel.z);
    const fm = typeof this.flightMode === 'string' ? this.flightMode : null;
    const thr = Number.isFinite(this.throttle) ? this.throttle : null;
    const knob = disp ? (typeof disp.hover === 'string' ? disp.hover : H.knob) : null;
    // hover weight: what flies (the flight body's blended state.hover / pose.body.hover), else the pilot's flight mode
    let want = 0;
    if (this.dying) want = 0;
    else if (disp) want = disp.gait === 'hover' || (knob && knob !== 'flare' && knob !== 'takeoff' && knob !== '1') ? 1 : 0;
    else if (Number.isFinite(st.hover)) want = clamp(st.hover, 0, 1);
    else if (Number.isFinite(this._pose.body.hover)) want = clamp(this._pose.body.hover, 0, 1);
    else if (fm === 'hover') want = 1;
    else if (fm === 'transition') want = 1 - smoothstep(8, 22, vh);
    const hv = H.hv = approach(H.hv, want, dt, 8, 8);         // (flight.js blends already: this only smooths steps)
    // motion of the body (physics frame): along the horizontal path, sideways, vertical
    const aW = disp ? _v5.set(0, 0, 0) : this._accel;
    const fwdW = _v2.set(0, 0, 1).applyQuaternion(q);
    const physPitch = Math.asin(clamp(fwdW.y, -1, 1));
    let hx = this.vel.x, hz = this.vel.z;
    if (vh < 1.5) { hx = fwdW.x; hz = fwdW.z; }
    const hl = Math.hypot(hx, hz) || 1;
    const aLong = disp ? 0 : (aW.x * hx + aW.z * hz) / hl;
    const leftW = _v3.set(1, 0, 0).applyQuaternion(q);
    const physRollR = Math.asin(clamp(leftW.y, -1, 1));       // + = rolled right (the left wing up)
    leftW.y = 0;
    const ll = leftW.length();
    if (ll > 1e-3) leftW.divideScalar(ll); else leftW.set(1, 0, 0);
    const latV = disp ? 0 : this.vel.x * leftW.x + this.vel.z * leftW.z;     // + = toward the dragon's left
    const latA = aW.x * leftW.x + aW.z * leftW.z;
    const vy = disp ? 0 : this.vel.y;
    const kn = (name) => (knob === name ? 1 : 0);
    const strafeT = (disp ? kn('strafeR') - kn('strafeL') : clamp(-latV / HV.strafeV, -1, 1)) * hv;
    H.strafe = approach(H.strafe, strafeT, dt, 5, 5);
    H.ax = approach(H.ax, disp ? 0 : latA, dt, 6, 6);
    H.climb = approach(H.climb, (disp ? kn('climb') : smoothstep(HV.climbV[0], HV.climbV[1], vy)) * hv, dt, 4, 3);
    H.sink = approach(H.sink, (disp ? kn('sink') : smoothstep(HV.climbV[0], HV.climbV[1], -vy)) * hv, dt, 4, 3);
    // FLARE: braking at speed into the hover (W released), or the flight's own S brake; never a Ctrl dive or a move
    const inMove = !!(mo?.on && (mo.name || mo.roll > 0.01 || mo.inf > 0.01 || mo.rear > 0.01));
    const braking = smoothstep(F.decel[0], F.decel[1], -aLong) * smoothstep(F.speed[0], F.speed[1], vh);
    const flareCmd = st.mode === 'flare' || (this.controls?.flare || 0) > 0.5;
    let flWant = 0;
    if (!this.dying && !inMove) {
      if (disp) flWant = knob === 'flare' || disp.gait === 'flare' ? 1 : 0;
      else if (flareCmd) flWant = braking;
      else if (fm) flWant = fm !== 'flight' && (thr == null || thr < 0.5) ? braking : 0;
      else if (want > 0.05) flWant = braking;
      if (!disp && this.controls?.dive && hv < 0.3) flWant = 0;
    }
    H.fl = approach(H.fl, flWant, dt, F.attack, F.release);
    // TAKE-OFF: accelerating out of a hover (W pressed): nose down, power strokes, legs up
    H.recent = Math.max(hv, H.recent - dt * T.recent);
    let toWant = 0;
    if (!this.dying && !inMove) {
      if (disp) toWant = knob === 'takeoff' || disp.gait === 'takeoff' ? 1 : 0;
      else {
        const go = thr != null ? smoothstep(0.35, 0.75, thr) : fm === 'flight' || fm === 'transition' || want < 0.5 ? 1 : 0;
        const acc = smoothstep(T.accel[0], T.accel[1], aLong) * (1 - smoothstep(T.speed[0], T.speed[1], vh));
        toWant = acc * go * smoothstep(0.15, 0.5, H.recent) * (1 - H.fl);
      }
    }
    H.to = approach(H.to, toWant, dt, T.attack, T.release);
    // leg pendulums: the dangling legs hang along the apparent gravity in the DRAWN body frame (a pitched-up hover body
    // → they hang plumb, a strafe start swings them out, the stroke's pitch rocks them), springy and lightly damped
    const gM = H.gM.set(0, -9.81, 0);
    if (!disp) gM.sub(this._accel);
    gM.applyQuaternion(_q1.copy(q).invert()).applyQuaternion(_q2.copy(this.visual.quaternion).invert());
    const upright = -gM.y > 0.5;
    const sagT = upright ? clamp(Math.atan2(-gM.z, -gM.y), -40 * DEG, HV.legSagMax * DEG) : 0;
    const latT = upright ? clamp(Math.atan2(gM.x, -gM.y), -HV.legLatMax * DEG, HV.legLatMax * DEG) : 0;
    if (dt > 0) {
      const n = Math.max(1, Math.ceil(dt * 120)), h = dt / n;
      for (const leg of ['FL', 'FR', 'BL', 'BR']) {
        const P = leg[0] === 'F' ? HV.legFront : HV.legHind, s = H.leg[leg];
        const w = TAU * P.hz * (leg[1] === 'L' ? 1 : 1.07), z = P.zeta;       // (a touch of desync between the sides)
        for (let i = 0; i < n; i++) {
          s[1] += (w * w * (sagT - s[0]) - 2 * z * w * s[1]) * h; s[0] += s[1] * h;
          s[3] += (w * w * (latT - s[2]) - 2 * z * w * s[3]) * h; s[2] += s[3] * h;
        }
      }
    }
    // the flight hint neckPitch (+ = up: the flare lifts the neck, a dive lowers it, the hover bends it down so the head
    // stays level), low-passed: the beat's counter-bob stays with the wave-4 neck flex
    const npT = clamp(this._pose.body.neckPitch || 0, -0.6, 0.45);
    H.np = dt > 0 ? lerp(H.np, npT, damp(1 / HV.neckHintTau, dt)) : H.np;
    // --- outputs
    o.on = true; o.hv = hv; o.fl = H.fl; o.to = H.to; o.climb = H.climb; o.sink = H.sink; o.strafe = H.strafe;
    // the drawn body's pitch: a top-up only where the physics does not pitch the body up itself (flight.js does: 0 then);
    // the flare rears it further, the take-off dips the nose
    // (a flight body that hovers itself — state.hover published — owns the pitch: no top-up, it would fight the take-off's
    // tip forward; the display flare rears up like the flown one: the flight pilot's air brake, then the back-beat)
    const physHover = Number.isFinite(st.hover);
    const tgt = (disp ? this.body.spec?.hover?.pitch ?? HV.displayPitch : HV.pitchMin) * DEG;
    const top = physHover && !disp ? 0 : clamp(tgt - physPitch, 0, (disp ? HV.displayPitch + 4 : HV.pitchTopMax) * DEG) * (disp ? Math.max(hv, H.fl) : hv);
    // (the flare's own rear-up only while the physics has not reared up itself: flight.js brakes with the lift axis; the
    // take-off's dip only while it has not tipped forward itself)
    const flP = disp ? 1 : 1 - smoothstep(F.pitchUntil[0] * DEG, F.pitchUntil[1] * DEG, physPitch);
    const toP = disp ? 1 : 1 - smoothstep(5 * DEG, 20 * DEG, -physPitch);
    o.pitchTop = top + F.pitch * DEG * H.fl * flP - T.dip * DEG * H.to * toP;
    o.bodyPitch = physPitch + o.pitchTop;
    // strafe lean: a top-up of what the physics' lift axis already banks into the strafe
    const leanW = HV.strafeLean * DEG * H.strafe, sgn = Math.sign(leanW);
    o.leanTop = sgn * Math.max(0, Math.abs(leanW) - Math.max(0, sgn * (disp ? 0 : physRollR)));
    // (the hint's LIFT — the flight's flare — is dropped in the hover and the flare: there the neck holds the head level)
    const hold = Math.max(hv, H.fl);
    o.neckHint = (H.np < 0 ? H.np : H.np * (1 - hold)) * HV.neckHintK;
    o.hold = hold;
    o.neckS = HV.neckS * DEG * hv;
    o.neckUp = (HV.climbNeck * H.climb + F.neck * H.fl + T.neck * H.to - 4 * H.sink) * DEG;
    o.turret = HV.turret * hold;
    o.headLim = hold;
    o.tailUp = (HV.climbTail * H.climb + HV.sinkTail * H.sink + F.tail * H.fl) * DEG;
    o.tailYaw = clamp(HV.tailStrafe * H.ax, -HV.tailStrafeMax, HV.tailStrafeMax) * DEG * hv;
    o.tailCurl = HV.tailCurl * DEG * hv;
    o.legTuck = H.to;
    o.legsF = F.legsF * DEG * H.fl + HV.sinkLegs * 0.6 * DEG * H.sink;
    o.legsH = F.legsH * DEG * H.fl + HV.sinkLegs * DEG * H.sink;
    o.knee = F.knee * DEG * H.fl;
    o.cup = HV.cup * Math.max(hv, H.fl);
    const pulse = this._pose.L.downstroke ? 1 : 0.15;
    o.down.set(0, -(HV.downwash[0] + HV.downwash[1] * pulse) * Math.max(hv, H.fl * 0.6), 0).applyQuaternion(_q1.copy(q).invert());
  }

  /** Hover wing accents on the interpolated physics pose (the flight owner's HOVER stroke stays underneath). */
  _hoverWings() {
    const H = this._hv, o = H.out, P = this._pose, M = this._mv, mean = M.mean;
    if (!o.on || this.dying) return;
    if (!M.on) {                                           // (the running stroke means live in the moves layer)
      const k = damp(2, Math.max(1e-3, this._ctx?.dt || 1 / 60));
      if (!mean.init) { mean.L.copy(P.L.shoulder); mean.R.copy(P.R.shoulder); mean.init = true; }
      else { mean.L.slerp(P.L.shoulder, k); mean.R.slerp(P.R.shoulder, k); }
    }
    // flare: the wings thrown forward and braced (wingkin's flare pose, half), the stroke kept underneath (the back-beat)
    if (o.fl > 0.01) {
      const refs = this._moveRefs();
      for (const S of ['L', 'R']) {
        if (refs) this._slerpWing(P[S], refs.flare[S], HV.flare.wings * o.fl, 0.5);
        _q3.setFromAxisAngle(Y, -HV.flare.sweep * DEG * o.fl); if (S === 'R') mirrorQ(_q3, _q3);
        P[S].shoulder.premultiply(_q3);
      }
    }
    // take-off / climb: power strokes (the stroke exaggerated about its running mean, in phase with the physics); a
    // strafe rows harder with the outer wing; sinking: the wings held high in a parachute V, the stroke shallower
    let kL = 1 + HV.takeoff.pump * o.to + HV.climbPump * o.climb, kR = kL;
    const sa = Math.abs(o.strafe);
    if (sa > 0.02) { if (o.strafe > 0) kL += HV.strafePump * sa; else kR += HV.strafePump * sa; }
    if (o.sink > 0.01) { const s = lerp(1, HV.sinkAmp, o.sink); kL *= s; kR *= s; }
    for (const [S, k] of [['L', kL], ['R', kR]]) {
      if (Math.abs(k - 1) > 0.002 && mean.init) {
        const qS = P[S].shoulder, m = mean[S];
        const d = _q3.copy(m).invert().multiply(qS);
        scaleRot(d, k, 14 * DEG, d);
        qS.copy(m).multiply(d);
      }
      if (o.sink > 0.01) { _q3.setFromAxisAngle(Z, HV.sinkLift * DEG * o.sink); if (S === 'R') mirrorQ(_q3, _q3); P[S].shoulder.premultiply(_q3); }
    }
  }

  // ------------------------------------------------------------------ wave 4: weight (wingbeat) and hit reactions
  /**
   * The rendered body frame on `visual` (model frame, pivot = the CG), on top of the physics:
   *  - wingbeat heave: the body rises through the downstroke and is highest as the wings reach the bottom, sinks on
   *    the upstroke. wingkin's wing-mass counter-bob (pose.body.bob ∝ −wing height) sets the phase; its oscillating
   *    part is amplified (steady offsets from folding / tucking are high-passed out): ≈ ±0.25 m in cruise.
   *  - stroke pitch: the lift on the shoulders (ahead of the CG) noses the body up through the downstroke (≈ ±2.5°).
   *  - hit reactions: rock (3-axis rotational spring), recoil (translational spring) and, after a titan swat, a
   *    decaying roll tumble (one turn).
   * Writes c.heaveAcc (the rider crouches with it) and this._frameQ (root × visual) for the head's world lock.
   */
  _visualFrame(c) {
    const H = this._heave, R = this._react, dt = c.dt, P = this._pose;
    const bob = P.body.bob || 0;
    if (dt > 0) H.slow = lerp(H.slow, bob, damp(1.1, dt));
    const ac = bob - H.slow;
    const target = clamp(bob + HEAVE_GAIN * ac, -0.5, 0.5) * (this.dying ? 0.3 : 1);
    const prev = H.disp;
    H.disp = dt > 0 ? lerp(H.disp, target, damp(25, dt)) : H.disp;
    if (dt > 0) {
      const v = (H.disp - prev) / dt;
      H.acc = lerp(H.acc, clamp((v - H.vel) / dt, -40, 40), damp(14, dt)); H.vel = v;
      H.hN = clamp(ac / 0.12, -1.8, 1.8) * (this.dying ? 0 : 1);          // normalised beat oscillation for the waves
      H.head = (H.head + 1) % HEAVE_HIST; H.hist[H.head] = H.hN; H.histT[H.head] = this._t;
      const pd = -((P.L.psiDot || 0) + (P.R.psiDot || 0)) * 0.5;          // > 0 on the downstroke
      H.noseUp = lerp(H.noseUp, clamp(pd * 0.012, -0.04, 0.07) * (this.dying ? 0 : 1), damp(14, dt));
    }
    this._reactStep(dt);
    const s = this.scale, q = this.visual.quaternion, mo = c.mv?.on ? c.mv : null;
    this.visual.position.set(R.off.x * s, (H.disp + R.off.y + (mo ? mo.heave : 0)) * s, R.off.z * s);
    q.setFromAxisAngle(R.tumbleAxis, R.tumble);
    // flight moves: the dodge's barrel roll about the body axis (through the CG, on top of the physical bank)
    if (mo && mo.rollAngle) q.premultiply(_q2.setFromAxisAngle(Z, mo.rollAngle));
    const rl = R.rot.length();
    if (rl > 1e-5) q.multiply(_q2.setFromAxisAngle(_v1.copy(R.rot).divideScalar(rl), rl));
    // hover: the strafe lean and the pitch (a top-up where the physics does not pitch up itself, the flare's rear-up,
    // the take-off's dip), about the CG; kept out of c.noseUp (the neck's beat flex)
    const ho = c.hv?.on ? c.hv : null;
    if (ho) {
      if (ho.leanTop) q.multiply(_q2.setFromAxisAngle(Z, ho.leanTop));
      if (ho.pitchTop) q.multiply(_q2.setFromAxisAngle(X, -ho.pitchTop));
    }
    // (+ the inferno rear-up of the whole body, kept out of c.noseUp: the neck must not flex against it)
    q.multiply(_q2.setFromAxisAngle(X, -H.noseUp - (mo ? mo.pitch : 0)));
    if (mo && mo.shudder > 1e-3) {
      // the super breath's recoil tremble (the head holds its world aim: only the body shakes)
      const a = mo.shudder, t = this._t;
      q.multiply(_q2.setFromAxisAngle(X, a * Math.sin(t * 71))).multiply(_q3.setFromAxisAngle(Z, a * 0.8 * Math.sin(t * 53 + 1.3)));
    }
    this._frameQ.copy(this.root.quaternion).multiply(q);
    c.heaveAcc = H.acc;
    c.heave = H.disp;
    const VU = this.model?.volumeUniforms;
    if (VU) VU.uBodyUpW.value.set(0, 1, 0).applyQuaternion(this._frameQ);
    // hanging legs lag the heave: they droop as the body is thrown up, swing up as it sinks
    if (dt > 0) this._legHeave = lerp(this._legHeave, clamp(-H.acc * 0.004, -0.12, 0.05), damp(10, dt));   // (up less: tucked legs lie along the tail)
    c.noseUp = H.noseUp + (rl > 1e-5 ? -R.rot.x : 0);
  }

  /** Beat oscillation `tau` seconds ago (history of H.hN, linear interpolation). */
  _heaveAgo(tau) {
    const H = this._heave, t = this._t - tau;
    let i = H.head;
    for (let n = 0; n < HEAVE_HIST - 1; n++) {
      const j = (i - 1 + HEAVE_HIST) % HEAVE_HIST;
      if (H.histT[j] <= t) {
        const t0 = H.histT[j], t1 = H.histT[i];
        const u = t1 > t0 ? clamp((t - t0) / (t1 - t0), 0, 1) : 0;
        return lerp(H.hist[j], H.hist[i], u);
      }
      i = j;
    }
    return H.hist[i] || 0;
  }

  _reactStep(dt) {
    const R = this._react;
    if (!(dt > 0)) return;
    const n = Math.max(1, Math.ceil(dt / (1 / 120))), h = dt / n;
    const w = 2 * Math.PI * REACT.rockHz, z = REACT.rockZeta, wp = 2 * Math.PI * REACT.recoilHz, zp = REACT.recoilZeta;
    for (let i = 0; i < n; i++) {
      R.rotV.addScaledVector(R.rot, -w * w * h).addScaledVector(R.rotV, -2 * z * w * h); R.rot.addScaledVector(R.rotV, h);
      R.offV.addScaledVector(R.off, -wp * wp * h).addScaledVector(R.offV, -2 * zp * wp * h); R.off.addScaledVector(R.offV, h);
      if (R.tumbleT !== 0 || R.tumbleV !== 0) {
        // tumble: a critically damped spring toward the next full turn (no overshoot at these rates), then unwound
        const wt = REACT.tumbleW;
        R.tumbleV += (wt * wt * (R.tumbleT - R.tumble) - 2 * wt * R.tumbleV) * h;
        R.tumble += R.tumbleV * h;
      }
    }
    R.rot.clampLength(0, 0.55); R.off.clampLength(0, 1.4);
    if (R.tumbleT !== 0 && Math.abs(R.tumbleT - R.tumble) < 0.004 && Math.abs(R.tumbleV) < 0.05) { R.tumble = 0; R.tumbleT = 0; R.tumbleV = 0; }
    for (const S of ['L', 'R']) R.flail[S] = Math.max(0, R.flail[S] - dt / REACT.flailT);
  }

  _resetReact() {
    const R = this._react;
    R.rot.set(0, 0, 0); R.rotV.set(0, 0, 0); R.off.set(0, 0, 0); R.offV.set(0, 0, 0);
    R.tumble = R.tumbleV = R.tumbleT = 0; R.flail.L = R.flail.R = 0; R.ramp.length = 0; R.pending = null;
    this.stagger = null;
  }

  /**
   * Wave 4 — a heavy blow is struck, not teleported: the Dragon's own knock from a swat or a fireball (see _onHit) and
   * any applyImpulse(J, p, { ramp }) keep REACT.keep instantly and the rest arrives as a force over the ramp (momentum
   * conserved). Impulses other systems apply directly on the body (the titan's contact push-out, its knock) are NOT
   * reshaped — re-timing a contact impulse would let the collision push twice — but their measured Δv (since the last
   * fixed step) sizes the visual reaction and the bounded physical angular kick of the pending hit.
   */
  _absorbKnock(dt) {
    const R = this._react, body = this.body;
    const hit = R.pending;
    if (hit) {
      R.pending = null;
      let m = 0;
      if (!body.stub) { const dm = _v3.subVectors(body.vel, this._velEnd).length(); if (dm < 400) m = dm; }
      this._hitReact(hit, Math.max(m + (hit.ramped || 0), hit.dv));
    }
    for (let i = R.ramp.length - 1; i >= 0; i--) {
      const r = R.ramp[i], f = Math.min(1, r.left / dt);
      const F = _v4.copy(r.F).multiplyScalar(f);
      if (body.applyForce) body.applyForce(F, r.at ? _v5.copy(this.pos).add(r.at) : null);
      else body.vel?.addScaledVector(F, dt / this.mass);
      r.left -= dt;
      if (r.left <= 1e-6) R.ramp.splice(i, 1);
    }
  }

  /** Visual + physical reaction to a blow of `dv` m/s (hit record prepared in _onHit, model-frame directions). */
  _hitReact(hit, dv) {
    const R = this._react, game = this.game;
    const k = clamp(dv / 9, 0.12, hit.kind === 'swat' ? 2 : 1.25);          // 1 ≈ a titan fireball (≈ 9 m/s)
    const dM = hit.dirM, rM = hit.rM;
    // torque axis = lever × force; a blow at the CG acts as if struck above it (it rolls / pitches the body away)
    const axis = _v1.crossVectors(rM.lengthSq() > 0.25 ? _v2.copy(rM).clampLength(0, 1.5) : _v2.set(0, 1, 0), dM);
    axis.addScaledVector(_v2.crossVectors(Y, dM), 0.35);
    if (axis.lengthSq() < 1e-6) axis.set(0, 0, 1);
    axis.normalize();
    R.rotV.addScaledVector(axis, REACT.rock * Math.min(k, 1.2));
    R.offV.addScaledVector(dM, REACT.recoil * k);
    // the struck wing (the side of the hit point) flails and folds; the other one a little
    const sideL = rM.x > 0.6 ? 1 : rM.x < -0.6 ? 0.35 : 0.7, sideR = rM.x < -0.6 ? 1 : rM.x > 0.6 ? 0.35 : 0.7;
    R.flail.L = Math.max(R.flail.L, clamp(k * sideL, 0, 1)); R.flail.R = Math.max(R.flail.R, clamp(k * sideR, 0, 1));
    // swat: the body is knocked into a decaying roll tumble (one turn, ≈ 1–1.3 rev/s at first), rider view rocks only
    if (hit.kind === 'swat' && dv > 12 && !this.grabbed && Math.abs(dM.y) < 0.9) {
      const sign = (dM.x < 0 ? 1 : -1);
      const turns = game.cameraRig?.viewMode === 'rider' ? 0 : 1;
      R.tumbleAxis.set(0, 0, 1);
      if (turns && R.tumbleT === 0) { R.tumbleT = sign * 2 * Math.PI; R.tumbleV = sign * 2 * Math.PI * clamp(dv / 40, 0.8, 1.3); }
      else R.rotV.z += sign * 3;
      this.stagger = { t: game.time.now, until: game.time.now + 0.5 + 0.2 * clamp(dv / 40, 0, 1.5), strength: k, kind: hit.kind };
    } else if (k > 0.6) this.stagger = { t: game.time.now, until: game.time.now + 0.25, strength: k, kind: hit.kind };
    // physical angular kick (world angular momentum through a couple of impulses: no net linear change)
    if (!this.display && hit.kind !== 'impact' && !this.body.stub && this.body.applyImpulse) {
      // rad/s about `axis`; a swat's is smaller (the titan's solid hand already tumbles the body through its contact
      // push-out; the big roll is the visual tumble, so the flight model and the chase camera are not thrown off)
      const rate = REACT.kickDegS * DEG * Math.min(k, 1.4) * (hit.kind === 'swat' ? 0.5 : 1);
      const s2 = this.scale * this.scale * this.mass / 1100;
      const I = (Math.abs(axis.x) * 7600 + Math.abs(axis.y) * 11000 + Math.abs(axis.z) * 4000) * s2;
      const dL = _v3.copy(axis).applyQuaternion(this.quat).multiplyScalar(I * rate);
      const u = _v4.set(1, 0, 0).applyQuaternion(this.quat);
      if (Math.abs(u.dot(dL)) > 0.8 * dL.length()) u.set(0, 1, 0).applyQuaternion(this.quat);
      u.addScaledVector(_v2.copy(dL).normalize(), -u.dot(_v2)).normalize();   // lever ⟂ ΔL, 1 m
      const J = _v2.crossVectors(dL, u).multiplyScalar(0.5);
      this.body.applyImpulse(J, _v5.copy(this.pos).add(u));
      this.body.applyImpulse(J.negate(), _v5.copy(this.pos).sub(u));
    }
    this.rider?.hit(hit.dirW, clamp(0.5 + k * 0.8, 0.5, 1.8));
    this._lastHitReact = { t: game.time.now, kind: hit.kind, dv: +dv.toFixed(1), k: +k.toFixed(2) };
  }

  _makeShapes() {
    const V = () => new THREE.Vector3();
    const s = this.scale || 1;
    const cap = (r, part, mult) => ({ kind: 'capsule', a: V(), b: V(), r: r * s, part, mult });
    return [cap(0.95, 'body', 1), cap(0.45, 'neck', 1.2), { kind: 'sphere', a: V(), r: 0.62 * s, part: 'head', mult: 1.5 },
      cap(0.5, 'wingL', 0.8), cap(0.45, 'wingL', 0.8), cap(0.85, 'wingL', 0.8),
      cap(0.5, 'wingR', 0.8), cap(0.45, 'wingR', 0.8), cap(0.85, 'wingR', 0.8),
      cap(0.45, 'tail', 0.7), cap(0.28, 'tail', 0.7)];
  }

  /** Model-space shape endpoints from the solved bones (on solve frames); fixed steps transform them by the body pose.
   *  (24.09: reuses its vectors — it allocated ~22 per dragon per frame) */
  _cacheShapes() {
    const rig = this.rig, s = this.scale, off = this.visual.position;
    let C = this._shapeIdx;
    if (!C || C.rig !== rig) {
      const i = (n) => rig.i(n);
      C = this._shapeIdx = { rig, pelvis: i('pelvis'), chest: i('chest'), n1: i('neck1'), head: i('head'), t1: i('tail1'), t5: i('tail5'), t10: i('tail10'),
        S: ['L', 'R'].map((S) => ({ sh: i('wing_shoulder_' + S), wr: i('wing_wrist_' + S), el: i('wing_elbow_' + S), f2: i('wing_f2_' + S), f4: i('wing_f4_' + S) })) };
      this._shapeLocal = null;
    }
    const L = this._shapeLocal || (this._shapeLocal = Array.from({ length: 11 }, () => [new THREE.Vector3(), new THREE.Vector3()]));
    const put = (k, a, b) => {
      const e = L[k];
      if (a) { e[0].copy(a).multiplyScalar(s).add(off); e.a = true; } else e.a = false;
      if (b) { e[1].copy(b).multiplyScalar(s).add(off); e.b = true; } else e.b = false;
    };
    const P = (i) => (i >= 0 ? rig.Pm[i] : null);
    const T = (i, out) => (i >= 0 ? rig.tipOf(i, out) : null);
    const chest = P(C.chest), n1 = P(C.n1), hp = P(C.head);
    put(0, P(C.pelvis), chest && n1 ? _v1.copy(chest).lerp(n1, 0.3) : chest);
    put(1, n1, hp);
    put(2, hp && this._mouthRig ? _v1.copy(hp).lerp(this._mouthRig, 0.55) : hp, null);
    C.S.forEach((w, j) => {
      put(3 + j * 3, P(w.sh), P(w.wr));
      put(4 + j * 3, P(w.wr), T(w.f2, _v2));
      put(5 + j * 3, P(w.el), T(w.f4, _v2));
    });
    put(9, P(C.t1), P(C.t5));
    put(10, P(C.t5), T(C.t10, _v2));
  }

  _updateShapes() {
    const L = this._shapeLocal, shapes = this.actor.shapes;
    if (!L) return;
    const q = this.display ? this.root.quaternion : this.quat, p = this.display ? this.root.position : this.pos;
    for (let k = 0; k < shapes.length && k < L.length; k++) {
      const e = L[k], sh = shapes[k];
      if (!e.a) continue;
      sh.a.copy(e[0]).applyQuaternion(q).add(p);
      if (sh.b) { if (e.b) sh.b.copy(e[1]).applyQuaternion(q).add(p); else sh.b.copy(sh.a); }
    }
  }

  _updateMouthRender() {
    const rig = this.rig, hi = this._headIdx;
    if (hi < 0 || !this._mouthLocal) return;
    this._mouthRig = rig.pointAt(hi, this._mouthLocal, this._mouthRig || new THREE.Vector3());
    // 24.09: through the drawn body frame (visual: heave, stroke pitch, hit rock, the barrel roll, the rear-up), so the
    // flame leaves the jaws that are drawn and points where the (world-locked) head looks
    const vq = this.visual.quaternion;
    const m = this._mouthModel || (this._mouthModel = new THREE.Vector3());
    m.copy(this._mouthRig).multiplyScalar(this.scale).applyQuaternion(vq).add(this.visual.position);
    this.mouth.copy(m).applyQuaternion(this.root.quaternion).add(this.root.position);
    const d = this._mouthDirModel || (this._mouthDirModel = new THREE.Vector3());
    const hd = rig.delta(hi, _q1);
    d.copy(Z).applyQuaternion(hd);
    // (the flame tilts with the lower jaw as before; the wider inferno roar does not aim it lower)
    d.applyAxisAngle(_v1.copy(X).applyQuaternion(hd), Math.min(this._jaw, 0.46) * 0.5).applyQuaternion(vq).normalize();
    this.mouthDir.copy(d).applyQuaternion(this.root.quaternion);
  }

  _updateMouthFixed() {
    if (!this._mouthModel || this.display) return;
    this.mouth.copy(this._mouthModel).applyQuaternion(this.quat).add(this.pos);
    if (this._mouthDirModel) this.mouthDir.copy(this._mouthDirModel).applyQuaternion(this.quat);
  }

  // ------------------------------------------------------------------ combat
  _onHit(rec) {
    const kind = rec.kind, game = this.game;
    // Feel fix: breath ticks arrive at 10 Hz — a full flash on each kept a breathed-on dragon white for seconds
    // (Sora turned into a white silhouette in fights). Fire ticks flash softly; impacts keep the full flash.
    const fl = kind === 'fire' ? (game.player === this ? 0.34 : 0.6) : kind === 'crash' ? 0.8 : 1;
    this._flash = Math.max(this._flash, fl);
    const dir = rec.dir ? _v1.copy(rec.dir) : _v1.subVectors(this.pos, rec.point || this.pos);
    if (kind === 'fire' || kind === 'crash' || !(dir.lengthSq() > 1e-6)) { this.rider?.hit(rec.dir || dir, kind === 'fire' ? 0.25 : 1); return; }
    dir.normalize();
    // Wave 4: the knock is proportional to the blow (a 72-HP titan fireball ≈ 8.7 m/s, was 2.5); _absorbKnock spreads
    // it (and anything the attacker adds right after, e.g. the titan's knock) over ≈ 0.1 s at the next fixed step and
    // sizes the visual rock / recoil / wing flail / rider jolt / tumble and a bounded angular kick from the measured Δv.
    const amount = rec.amount || 0;
    const dv = kind === 'swat' ? 14 : kind === 'impact' ? 6 : kind === 'fireball' ? clamp(1.5 + amount * 0.1, 2.5, 10) : 1.5;
    const ramp = kind === 'swat' || kind === 'fireball' ? REACT.rampT : 0;
    this.applyImpulse(_v2.copy(dir).multiplyScalar(dv * this.mass), null, ramp ? { ramp } : null);
    const R = this._react, qInv = _q1.copy(this.quat).invert();
    R.hitT = game.time.now;
    const prevDv = R.pending?.dv || 0;
    R.pending = { kind: prevDv > dv ? R.pending.kind : kind, dv: Math.max(dv, prevDv), ramped: ramp ? dv * (1 - REACT.keep) : 0, dirW: dir.clone(), dirM: dir.clone().applyQuaternion(qInv),
      rM: rec.point ? rec.point.clone().sub(this.pos).applyQuaternion(qInv).divideScalar(this.scale || 1) : new THREE.Vector3() };
  }

  /**
   * Ground / sea contact reported by FlightBody.onCrash: { impact (normal m/s), speed, severity, point, normal }.
   * Wave 5: every dragon's crash costs maxHp × info.severity (flight.js: ((vn − 8) / 45)², 20 m/s ≈ 7 %, 30 ≈ 24 %,
   * 40 ≈ 51 %, ≥ 53 m/s lethal) — was 1.6 v + 0.06 v² capped at 90 HP. player.js's top-up then adds nothing.
   */
  _onCrash(info) {
    try {
      const a = this.actor, game = this.game;
      if (!a || this.removed) return;
      const impact = info?.impact ?? 0;
      if (!(impact > 4)) return;
      const sev = Number.isFinite(info.severity) ? clamp(info.severity, 0, 1) : clamp((impact - 8) / 45, 0, 1) ** 2;
      const dmg = (a.maxHp || DRAGON_DEFAULTS[this.variant]?.hp || 600) * sev;
      if (dmg > 0.5 && a.alive) {
        if (game.combat) game.combat.damage(a, dmg, { source: null, point: info.point, dir: info.normal, kind: 'crash', part: 'body' });
        else { a.hp = Math.max(0, a.hp - dmg); if (a.hp <= 0) this._onDeath({ kind: 'crash' }); }
      }
      if (game.player === this) game.cameraRig?.shake?.(clamp(impact / 30, 0.2, 1), 0.4);
      this.lastCrash = { t: game.time?.now ?? 0, impact, severity: sev, damage: dmg };
    } catch (e) { if (!this._crashErr) { this._crashErr = true; console.warn('[dragon] crash handling failed', e); } }
  }

  _onDeath(rec) {
    if (this.dying) return;
    this.dying = true; this.alive = false; this.actor.alive = false;
    this._deathT = 0;
    this._deathSpin = Math.random() < 0.5 ? -1 : 1;
    this.game.fx?.smoke?.(this.root, true);
    // stub and real FlightBody alike (wave 5): a dead body never springs into the automatic take-off after a contact
    this.body.dead = true;
    this.rider?.hit(rec?.dir || Y, 1.5);
  }

  _deathControls(dt) {
    this._deathT = (this._deathT || 0) + dt;
    const c = this.controls;
    c.flap = 0; c.boost = 0; c.breath = 0; c.fireball = 0; c.flare = 0; c.beat = 0; c.dodge = 0;
    c.glide = 1; c.dive = this._deathT > 0.8 ? 1 : 0; c.pitch = -0.6; c.roll = this._deathSpin * 0.9; c.yaw = this._deathSpin * 0.3;
    // Limp wings make no useful lift: add the missing weight so the fall is not a glide (physics keeps integrating).
    if (!this.body.stub && this.body.applyForce) this.body.applyForce(_v1.set(0, -this.mass * 9.81 * 0.85, 0));
  }

  /** A live enemy leaving the scene in view: violet flash + ring + sparks where it was (fire.js public API). */
  _vanishFx() {
    const fx = this.game.fx, cam = this.game.camera;
    if (!fx?.impactFlash || !cam) return;
    const p = this.root.position, d = cam.position.distanceTo(p);
    if (d > 900) return;
    _v1.copy(p).project(cam);
    if (Math.abs(_v1.x) > 1.1 || Math.abs(_v1.y) > 1.1 || _v1.z > 1) return;
    const ace = this.variant === 'onyx';
    try {
      fx.impactFlash(p.clone(), { size: 11 * this.scale, row: ace ? ROW.ace : ROW.enemy, ring: true, intensity: 1.1 });
      fx.sparks?.(p.clone(), 16, { row: ace ? ROW.aceSpark : ROW.enemySpark, vel: this.vel, speed: 24, life: 0.55 });
    } catch { /* optional */ }
  }

  _flail(wL = 1, wR = 1) {
    // Limp, flailing wings on top of the body's pose (visual only), blended by w per side (1 = shot down; a heavy hit
    // flails the struck wing for a moment). Left wing in body axes; right = mirror (x,-y,-z,w).
    const t = this._t, P = this._pose, f = _q3;
    for (const S of ['L', 'R']) {
      const w = S === 'L' ? wL : wR;
      if (!(w > 0.001)) continue;
      const s = S === 'L' ? 1 : 2.3, m = S === 'L' ? 1 : -1;
      const put = (q, out) => { f.set(q.x, m * q.y, m * q.z, q.w); if (w >= 0.999) out.copy(f); else out.slerp(f, w); };
      put(_q1.setFromAxisAngle(Z, 0.35 + Math.sin(t * 6.5 + s) * 0.5 + Math.sin(t * 11 + s * 3) * 0.2).multiply(_q2.setFromAxisAngle(Y, Math.sin(t * 4 + s) * 0.3 - 0.2)), P[S].shoulder);
      put(_q1.setFromAxisAngle(Y, -(0.6 + Math.sin(t * 8 + s) * 0.4)), P[S].elbow);
      put(_q1.setFromAxisAngle(Y, 0.8 + Math.sin(t * 9 + s) * 0.4).multiply(_q2.setFromAxisAngle(Z, Math.sin(t * 13 + s) * 0.3)), P[S].wrist);
      for (let i = 0; i < 4; i++) put(_q1.setFromAxisAngle(Y, -(0.5 + 0.3 * Math.sin(t * 7 + i + s)) * (i / 3)), P[S].fingers[i]);
      P[S].camber = lerp(P[S].camber, 0.3 + Math.sin(t * 12 + s) * 0.4, w);
      if (w > 0.5) P[S].downstroke = false;
    }
  }

  _checkCrash() {
    const g = this.env.heightAt ? this.env.heightAt(this.pos.x, this.pos.z) : 0;
    const sea = this.game.world?.seaLevel ?? 0;
    const hit = this.pos.y < Math.max(g, sea) + 3 || (this.body.state?.crash || 0) > 0;
    if (hit || this._deathT > 14) this._explode();
  }

  _explode() {
    if (this.removed || this._exploded) return;
    this._exploded = true;
    const p = this.pos.clone(), fx = this.game.fx;
    if (fx?.explosion) fx.explosion(p, { radius: 13 * this.scale, kind: 'dragon' });
    else this.game.events.emit('explosion', { point: p, radius: 13 * this.scale, kind: 'dragon' });
    fx?.smoke?.(this.root, false);
    this.dispose();
  }

  /**
   * Remove from the scene, combat and the driver. Shared geometry/textures stay cached.
   * Feel fix — never blink out on screen: a falling (shot-down) dragon removed before its crash explodes where it is;
   * a live Shade Rider removed while in view (a retreat timing out) leaves with a violet shadow-step flash.
   */
  dispose() {
    if (this.removed) return;
    const playing = this.game.state === 'play';
    if (this.dying && !this._exploded && playing) { this._explode(); return; }     // _explode() disposes
    if (this.alive && !this.display && playing && this.palette?.shade) this._vanishFx();
    this.removed = true;
    this._trails?.dispose(); this._trails = null;
    this.game.scene.remove(this.root);
    if (this.game.combat) this.game.combat.unregister(this.actor);
    else { const i = this.game.actors.indexOf(this.actor); if (i >= 0) this.game.actors.splice(i, 1); }
    const drv = this.game.__dragonDriver;
    if (drv) { const i = drv.list.indexOf(this); if (i >= 0) drv.list.splice(i, 1); }
    this.rider?.dispose();
    this._offBreath?.();
    try { this._offMoves?.(); } catch { /* ignore */ }
    this._offMoves = null;
    if (this._mv?.glow) { this._mv.glow.dispose(); this._mv.glow = null; }
    try { this._elemDispose(); } catch { /* ignore */ }
    this._disposeMaterials(this.model);
    // wave 4 (GPU leak): bone textures of the model's skeletons, ink-hull materials, the glowing-eye points
    if (this._eyes) { this._eyes.parent?.remove(this._eyes); this._eyes.geometry.dispose(); this._eyes.material.dispose(); this._eyes = null; }
    disposeInstance(this.model?.scene);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// GLB wing data (bind pose, LEFT wing, GLB model space), measured once per file:
//   S shoulder, E elbow, W wrist joint (= the finger roots on these rigs), Wr/H the wrist/hand points handed to
//   wingkin (the GLB wrist bone has zero length, so wingkin's short carpus is placed 0.1 m up the forearm),
//   T[4] finger tips (farthest skinned vertex along each finger bone), len[4], TE membrane root at the flank.
const WING_CACHE = new Map();
function glbWingData(key, inst) {
  if (WING_CACHE.has(key)) return WING_CACHE.get(key);
  let res = null;
  try {
    const B = inst.bones;
    const names = ['wing_shoulder_L', 'wing_elbow_L', 'wing_wrist_L', 'wing_f1_L', 'wing_f2_L', 'wing_f3_L', 'wing_f4_L'];
    if (names.every((n) => B.has(n))) {
      inst.scene.updateMatrixWorld(true);
      const inv = new THREE.Matrix4().copy(inst.scene.matrixWorld).invert();
      const M = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
      const P = (n) => new THREE.Vector3().setFromMatrixPosition(M.multiplyMatrices(inv, B.get(n).matrixWorld));
      const D = (n) => { M.multiplyMatrices(inv, B.get(n).matrixWorld).decompose(_v1, q, sc); return new THREE.Vector3(0, 1, 0).applyQuaternion(q).normalize(); };
      const S = P('wing_shoulder_L'), E = P('wing_elbow_L'), W = P('wing_wrist_L');
      const fn = names.slice(3), heads = fn.map(P), dirs = fn.map(D);
      const len = fn.map((n) => dragonLeafLength(n));
      const measured = [0, 0, 0, 0];
      let TE = null, teZ = Infinity;
      const v = new THREE.Vector3(), Mm = new THREE.Matrix4();
      for (const m of inst.skinned) {
        const g = m.geometry, pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
        if (!pos || !si || !sw || !m.skeleton) continue;
        Mm.multiplyMatrices(inv, m.matrixWorld);
        const idx = m.skeleton.bones.map((b) => fn.indexOf(b.name));
        const memb = /memb|patag/i.test(m.name + ' ' + (m.material?.name || ''));
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(Mm);
          for (let k = 0; k < 4; k++) {
            if (sw.getComponent(i, k) < 0.5) continue;
            const f = idx[si.getComponent(i, k)];
            if (f < 0) continue;
            const pr = _v2.subVectors(v, heads[f]).dot(dirs[f]);
            if (pr > measured[f]) measured[f] = pr;
          }
          if (memb && v.x > 0 && v.x < S.x + 0.6 && v.z < teZ) { teZ = v.z; TE = v.clone(); }
        }
      }
      for (let i = 0; i < 4; i++) if (measured[i] > 0.5) len[i] = measured[i];
      const T = heads.map((h, i) => h.clone().addScaledVector(dirs[i], len[i]));
      const fore = _v3.subVectors(W, E);
      const Wr = W.clone().addScaledVector(fore.normalize(), -Math.min(0.1, 0.3 * E.distanceTo(W)));
      res = { S, E, W, Wr, H: W.clone(), T, len, dirs, TE: TE || new THREE.Vector3(S.x + 0.2, S.y - 0.2, S.z - 2.4) };
    }
  } catch (e) { console.warn(`[dragon] ${key}: wing measurement failed`, e); res = null; }
  WING_CACHE.set(key, res);
  return res;
}

/**
 * Per-vertex membrane coordinates for a GLB membrane (shared geometry, once): aMemb = (bell, side, edge) as in the
 * fallback, aMembN = upper normal of the panel. Spars: the arm (shoulder-elbow-wrist), the four fingers and the flank
 * (shoulder -> membrane root). bell = sin(pi * d1 / (d1 + d2)) over the two nearest spars, faded in narrow panels;
 * edge = distance behind the leading edge (shoulder-wrist-f1 tip). Returns true when the attributes exist.
 */
function membraneAttributes(geo, w) {
  if (geo.attributes.aMemb && geo.attributes.aMembN) return true;
  const pos = geo.attributes.position;
  if (!pos || !w) return false;
  const seg = (a, b) => ({ a, b, d: b.clone().sub(a) });
  const spars = [[seg(w.S, w.E), seg(w.E, w.W)], ...w.T.map((t) => [seg(w.W, t)]), [seg(w.S, w.TE)]];
  const le = [seg(w.S, w.W), seg(w.W, w.T[0])];
  const p = new THREE.Vector3(), c = new THREE.Vector3(), dir = new THREE.Vector3();
  const segDist = (s, out) => { const t = clamp(c.subVectors(p, s.a).dot(s.d) / Math.max(1e-6, s.d.lengthSq()), 0, 1); out && out.copy(s.d); return c.copy(s.a).addScaledVector(s.d, t).distanceTo(p); };
  const n = pos.count, aM = new Float32Array(n * 3), aN = new Float32Array(n * 3);
  const dA = new THREE.Vector3(), dB = new THREE.Vector3(), tmp = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    p.fromBufferAttribute(pos, i);
    const side = p.x >= 0 ? 1 : -1;
    p.x = Math.abs(p.x);
    let d1 = Infinity, d2 = Infinity;
    for (const sp of spars) {
      let d = Infinity;
      for (const s of sp) { const x = segDist(s, tmp); if (x < d) { d = x; dir.copy(tmp); } }
      if (d < d1) { d2 = d1; dB.copy(dA); d1 = d; dA.copy(dir); } else if (d < d2) { d2 = d; dB.copy(dir); }
    }
    const gap = d1 + d2;
    const bell = gap > 1e-4 ? Math.sin(Math.PI * clamp(d1 / gap, 0, 0.5)) * smoothstep(0.25, 2.6, gap) : 0;
    const dle = Math.min(segDist(le[0]), segDist(le[1]));
    const edge = smoothstep(0.3, 3.4, dle);
    const nn = tmp.crossVectors(dA.normalize(), dB.normalize());
    if (nn.y < 0) nn.negate();
    if (nn.length() < 0.2) nn.set(0, 1, 0); else nn.normalize().lerp(Y, 0.3).normalize();
    aM[i * 3] = bell; aM[i * 3 + 1] = side; aM[i * 3 + 2] = edge;
    aN[i * 3] = nn.x * side; aN[i * 3 + 1] = nn.y; aN[i * 3 + 2] = nn.z;
  }
  geo.setAttribute('aMemb', new THREE.BufferAttribute(aM, 3));
  geo.setAttribute('aMembN', new THREE.BufferAttribute(aN, 3));
  return true;
}

/** Onyx = the crimson model re-tinted: dark slate body, indigo-blue membranes (shader-side shift of the violet). */
function patchOnyx(mat) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(mat, sh, r);
    sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
      {
        vec3 oc = diffuseColor.rgb;
        float oviolet = clamp((min(oc.r, oc.b) - oc.g) * 6.0 + (oc.b - oc.g) * 2.0 - 0.1, 0.0, 1.0);
        diffuseColor.rgb = mix(oc * vec3(0.92, 0.98, 1.18), vec3(oc.b * 0.32, oc.b * 0.5, oc.b * 1.12), oviolet);
      }`);
  };
  addCacheKey(mat, '|onyx');
}

// ---------------------------------------------------------------------------------------------------------------
// Feel fix: Shade Rider readability (charcoal dragons vanished against the dark forest at 100–400 m).
/**
 * All-round coloured rim ("shade aura": its width limited to ≈ uShadeK.z px by the N·V rate of change, so flat
 * membranes seen edge-on never flood, and it grows toward the whole silhouette on a small, far dragon), stronger
 * with distance; on membranes (aMemb from the billow patch) glowing spars / veins and a faint violet self-light.
 * Added after lighting, before the atmosphere (far dragons are still hazed, but keep a violet edge). HDR, blooms.
 */
function patchShade(mat, U, memb) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(mat, sh, r);
    Object.assign(sh.uniforms, U);
    if (memb) {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vShadeMemb;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vShadeMemb = aMemb;');
    }
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uShadeAura, uShadeVein; uniform vec4 uShadeK; uniform float uShadeLife;' + (memb ? '\nvarying vec3 vShadeMemb;' : ''))
      .replace('#include <opaque_fragment>', `
        {
          vec3 sV = normalize(vViewPosition);
          float sNdV = dot(normalize(normal), sV);
          float sFr = 1.0 - clamp(abs(sNdV), 0.0, 1.0);
          float sW = clamp(fwidth(sNdV) * uShadeK.z, 0.02, 0.55);
          float sRim = smoothstep(1.0 - sW, 1.0 - sW * 0.3, sFr);
          float sD = length(vViewPosition);
          float sFar = smoothstep(35.0, 320.0, sD);
          outgoingLight += uShadeAura * sRim * mix(uShadeK.x, uShadeK.y, sFar) * uShadeLife;
          ${memb ? `
          // spars / veins: bell = 0 on a finger, an arm or the flank; the band keeps >= 1.6 px far away
          float sB = vShadeMemb.x;
          float sAw = max(0.1, fwidth(sB) * 1.6);
          float sSpar = 1.0 - smoothstep(0.0, sAw, sB);
          outgoingLight += uShadeVein * (sSpar * (1.3 + 0.5 * sFar) + uShadeK.w * (1.0 + 2.0 * sFar)) * uShadeLife;` : ''}
        }
        #include <opaque_fragment>`);
  };
  addCacheKey(mat, memb ? '|shade-memb' : '|shade');
}

/** Two glowing eyes (additive points on the head bone, ≥ 2 px, bloom; the pipeline draws them after the clouds). */
function makeEyeGlow(color, sizeM) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color }, uSize: { value: sizeM }, uViewH: { value: 900 }, uLife: { value: 1 } },
    vertexShader: /* glsl */`
      uniform float uSize, uViewH; varying float vFade;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float d = max(-mv.z, 1e-3);
        float ppu = projectionMatrix[1][1] * 0.5 * uViewH / d;
        gl_PointSize = clamp(uSize * ppu, 2.2, 48.0);
        vFade = exp(-d / 1400.0) * smoothstep(2.2, 6.0, uSize * ppu + 2.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; uniform float uLife; varying float vFade;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float r = dot(p, p);
        if (r > 1.0) discard;
        float core = exp(-r * 10.0), halo = exp(-r * 3.2) * 0.3;
        gl_FragColor = vec4(uColor * (core * 1.6 + halo) * vFade * uLife, 1.0);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(g, mat);
  pts.name = 'dragon_eye_glow'; pts.frustumCulled = false; pts.renderOrder = 5;
  return pts;
}

/**
 * Flight moves — the mouth glow: fire gathering between the jaws while a fireball charges (grows 0.4 → 1.6 m and
 * flickers faster as it fills, a steady throb when full; the fx owner's charge orb forms ahead of the snout), a
 * white-gold roar in the inferno rear-up, a softer glow under the super breath. A camera-facing quad (no point-size limit) on the head bone just inside the jaws, pulled a
 * little toward the camera so the snout does not cut it from the side; from the chase view the head hides its centre
 * and the light spills around the silhouette. Additive HDR (blooms), FX layer (transparent, no depth write).
 */
const _c1 = new THREE.Color(), _c2 = new THREE.Color();
class MouthGlow {
  constructor(scale) {
    this.scale = scale;
    const g = new THREE.PlaneGeometry(2, 2);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uCore: { value: new THREE.Color() }, uHalo: { value: new THREE.Color() }, uSize: { value: 1 }, uK: { value: 0 },
        uRays: { value: 0 }, uTime: { value: 0 } },
      vertexShader: /* glsl */`
        uniform float uSize; varying vec2 vP;
        void main() {
          vP = position.xy;
          vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          mv.xy += position.xy * uSize * 0.5;
          mv.z += min(0.8, uSize * 0.35);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uCore, uHalo; uniform float uK, uRays, uTime; varying vec2 vP;
        void main() {
          float r2 = dot(vP, vP);
          if (r2 > 1.0) discard;
          float r = sqrt(r2), a = atan(vP.y, vP.x);
          float core = exp(-r2 * 22.0);
          float halo = exp(-r2 * 5.0) * 0.5 * (1.0 - r2);
          float rays = (pow(max(0.0, cos(a * 3.0 + uTime * 2.1)), 14.0) + 0.7 * pow(max(0.0, cos(a * 4.0 - uTime * 1.4 + 0.7)), 18.0))
            * exp(-r * 2.6) * (1.0 - r2) * uRays;
          gl_FragColor = vec4((uCore * core * 2.4 + uHalo * (halo + rays * 1.2)) * uK, 1.0);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.name = 'dragon_mouth_glow'; this.mesh.frustumCulled = false; this.mesh.renderOrder = 6; this.mesh.visible = false;
    this.mesh.castShadow = false; this.mesh.receiveShadow = false;
  }
  /** em (25.09, the player's element; null = the fire colours as before): { core, halo (Color), size (m), k, rays, flick }. */
  update(o, k, t, em = null) {
    const u = this.mat.uniforms, ch = o.ch, full = ch > 0.97 ? 1 : 0;
    const pulse = 1 + (0.08 + 0.1 * ch) * Math.sin(t * (9 + 14 * ch)) + full * 0.18 * Math.sin(t * 16);
    const mv = ch > 0.02 || o.rear > 0.02 || o.inf > 0.02;
    let size = mv ? Math.max((0.4 + 1.2 * ch) * pulse, 2.0 * o.rear, 1.3 * o.inf) : 0;
    let kk = mv ? Math.max((0.3 + 1.5 * Math.pow(ch, 1.2)) * pulse, 2.4 * o.rear, 1.0 * o.inf) * clamp(k * 3, 0, 1) : 0;
    let rays = Math.max(smoothstep(0.45, 1, ch), o.rear, o.inf * 0.6);
    if (em && em.k > 0.005) { size = Math.max(size, em.size); kk = Math.max(kk, em.k); rays = Math.max(rays, em.rays); }
    u.uSize.value = size * this.scale;
    u.uK.value = kk;
    u.uTime.value = t;
    u.uRays.value = rays;
    const white = Math.max(full * 0.5, o.rear, o.inf * 0.6);
    if (em) {
      // the element's colours (the charge / the rear-up whiten them as before)
      u.uCore.value.copy(em.core).lerp(_c1.setRGB(1, 1, 0.97), white * 0.6);
      u.uHalo.value.copy(em.halo).lerp(_c2.copy(em.core), white * 0.3);
    } else {
      u.uCore.value.setRGB(1.0, 0.93, 0.78).lerp(_c1.setRGB(1, 1, 0.95), white);
      u.uHalo.value.setRGB(1.0, 0.55, 0.16).lerp(_c2.setRGB(1.0, 0.8, 0.35), white);
    }
    this.mesh.visible = u.uK.value > 0.01;
  }
  dispose() { this.mesh.parent?.remove(this.mesh); this.mesh.geometry.dispose(); this.mat.dispose(); }
}

// ---------------------------------------------------------------------------------------------------------------
// Levels and elements (25.09): the look's values, the material patch, the aura hull, the crawling arcs.
const LOOK_COLS = ['glow', 'membA', 'membB', 'eye', 'core', 'halo', 'aura', 'aura2', 'spar', 'arc', 'arc2'];
const LOOK_NUMS = ['mix', 'memb', 'base', 'arcs', 'flick', 'sparK'];
function lookCopy(dst, src) {
  if (!dst) { dst = { name: src.name, tier: src.tier }; for (const k of LOOK_COLS) dst[k] = src[k].clone(); }
  else for (const k of LOOK_COLS) dst[k].copy(src[k]);
  for (const k of LOOK_NUMS) dst[k] = src[k];
  dst.name = src.name; dst.tier = src.tier;
  return dst;
}
function lookLerp(out, a, b, t) {
  if (t >= 1) return lookCopy(out, b);
  for (const k of LOOK_COLS) out[k].lerpColors(a[k], b[k], t);
  for (const k of LOOK_NUMS) out[k] = lerp(a[k], b[k], t);
  out.name = b.name; out.tier = b.tier;
  return out;
}

/**
 * The element's rim on Sora's toon materials (body and membranes) + glowing, crackling spars on the membranes (bell = 0
 * on an arm / finger / the flank, ≥ 1.6 px). uElemK = (rim, spar, time, flicker 0 fire … 1 lightning). Added after the
 * lighting (HDR, blooms); all 0 → nothing drawn (every dragon that is not the player).
 */
function patchElement(mat, U, memb) {
  if (!mat || mat.userData.elementPatched) return;
  mat.userData.elementPatched = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(mat, sh, r);
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vElemP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vElemP = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uElemRim, uElemRim2, uElemSpar; uniform vec4 uElemK;\nvarying vec3 vElemP;')
      .replace('#include <opaque_fragment>', `
        if (uElemK.x + uElemK.y > 0.001) {
          vec3 eV = normalize(vViewPosition);
          float eNdV = dot(normalize(normal), eV);
          float eFr = 1.0 - clamp(abs(eNdV), 0.0, 1.0);
          // (a smooth fresnel, not a pixel-width band: on the GLB's bumpy scales a thin band broke into white scratches)
          // (only the last grazing band, and none within ≈ 4–10 m of the camera: from the saddle the spiky crest is all
          // grazing angles and the rim washed it lilac)
          float eRim = smoothstep(0.8, 0.99, eFr) * smoothstep(4.0, 10.0, length(vViewPosition));
          float eT = uElemK.z;
          vec3 eCol = mix(uElemRim, uElemRim2, 0.5 + 0.5 * sin(dot(vElemP, vec3(1.3, 2.1, 0.7)) + eT * 1.7));
          // lightning: a flicker (25 Hz steps) with pulses running along the body / the spars
          float eFlk = 0.7 + 0.6 * fract(sin(floor(eT * 25.0) * 12.9898) * 43758.5453);
          float eBand = pow(max(0.0, sin(dot(vElemP, vec3(0.9, 1.3, 2.4)) - eT * 15.0)), 8.0);
          float eFl = mix(1.0, eFlk * (0.55 + 1.4 * eBand), uElemK.w);
          outgoingLight += eCol * eRim * uElemK.x * eFl;
          ${memb ? `
          float eB = vMembM.x;
          float eAw = max(0.09, fwidth(eB) * 1.6);
          float eSp = 1.0 - smoothstep(0.0, eAw, eB);
          outgoingLight += uElemSpar * eSp * uElemK.y * eFl;` : ''}
        }
        #include <opaque_fragment>`);
  };
  addCacheKey(mat, memb ? '|elem-memb' : '|elem');
}

/**
 * The elemental aura: an additive inverted hull of the body mesh (same geometry and skeleton, pushed out along the
 * outline's smoothed normals, BACK faces only — so it glows only outside the silhouette, never as a film over the body),
 * brightest against the body and fading to the hull's edge, with flame licks streaming back along the body (fire tiers)
 * or crackling cells (lightning tiers). Transparent + additive + no depth write → the pipeline's FX layer.
 */
let _dummyDepth = null;
class ElementAura {
  constructor(src, game) {
    const g = src.geometry, ol = !!g.attributes.outlineNormal;
    if (!_dummyDepth) { _dummyDepth = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); _dummyDepth.needsUpdate = true; }
    this.U = { uAuraA: { value: new THREE.Color() }, uAuraB: { value: new THREE.Color() }, uAuraK: { value: new THREE.Vector4() },
      uDepth: { value: _dummyDepth }, uSoft: { value: 0 }, uNear: { value: 0.5 }, uFar: { value: 60000 }, uInvRes: { value: new THREE.Vector2(1, 1) } };
    const mat = this.mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.BackSide });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.U);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform vec4 uAuraK;\nvarying vec3 vAN, vAV, vAP;\nvarying float vAZ;' + (ol ? '\nattribute vec3 outlineNormal;' : ''))
        .replace('#if defined ( USE_ENVMAP ) || defined ( USE_SKINNING )', '#if 1')
        .replace('#include <beginnormal_vertex>', ol ? 'vec3 objectNormal = outlineNormal;\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3( tangent.xyz );\n#endif' : '#include <beginnormal_vertex>')
        .replace('#include <skinning_vertex>', '#include <skinning_vertex>\n  transformed += normalize(objectNormal) * uAuraK.y;')
        .replace('#include <project_vertex>', '#include <project_vertex>\n  vAN = normalize(normalMatrix * objectNormal); vAV = -mvPosition.xyz; vAP = position; vAZ = -mvPosition.z;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\n#include <packing>\nuniform vec3 uAuraA, uAuraB; uniform vec4 uAuraK;\nvarying vec3 vAN, vAV, vAP;\nvarying float vAZ;'
          + '\nuniform sampler2D uDepth; uniform float uSoft, uNear, uFar; uniform vec2 uInvRes;')
        .replace('#include <opaque_fragment>', `
          // back faces: |N·V| is 0 at the hull's outer edge and grows toward the body's silhouette
          float aNdV = abs(dot(normalize(vAN), normalize(vAV)));
          float aE = pow(smoothstep(0.02, 0.85, aNdV), 1.4);
          float aT = uAuraK.z;
          float n1 = sin(vAP.z * 2.1 + aT * 6.0 + 1.7 * sin(vAP.x * 2.7 + aT * 1.9));
          float n2 = sin(vAP.y * 3.7 - aT * 8.0 + vAP.z * 1.1 + 1.3 * sin(vAP.x * 4.1));
          float lick = clamp(0.6 + 0.28 * n1 + 0.22 * n2, 0.15, 1.2);
          // electric: the whole halo flickers (25 Hz steps) and bright pulses run down the body
          float flk = 0.7 + 0.6 * fract(sin(floor(aT * 25.0) * 12.9898) * 43758.5453);
          float band = pow(max(0.0, sin(vAP.z * 2.6 - aT * 17.0 + 1.4 * sin(vAP.y * 4.0 + vAP.x * 3.0))), 10.0);
          float lk = mix(lick, flk * (0.5 + 1.8 * band), uAuraK.w);
          // fire: hotter (aura2) toward the body; electric: aura2 in the running pulses
          vec3 col = mix(uAuraA, uAuraB, mix(aE * 0.6, band, uAuraK.w));
          // only against what lies well behind the dragon (sky, ground, clouds): where its own body is within ≈ 3 m
          // behind the halo (a leg's halo over the belly), it fades — no flecks on the body
          float aSoft = 1.0;
          if (uSoft > 0.5) {
            float sceneZ = -perspectiveDepthToViewZ(texture2D(uDepth, gl_FragCoord.xy * uInvRes).x, uNear, uFar);
            aSoft = smoothstep(0.6, 3.0, sceneZ - vAZ);
          }
          aSoft *= smoothstep(2.5, 7.0, vAZ);           // not in the camera's face (the rider view, a close photo)
          gl_FragColor = vec4(col * aE * lk * aSoft * uAuraK.x, 1.0);`);
    };
    mat.customProgramCacheKey = () => 'dragonElemAura' + (ol ? '-ol' : '');
    const o = this.mesh = new THREE.SkinnedMesh(g, mat);
    o.bindMode = src.bindMode; o.bind(src.skeleton, src.bindMatrix);
    o.name = 'dragon_element_aura'; o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; o.renderOrder = 4;
    o.userData.castShadow0 = false;
    // soft halo: the pipeline's opaque depth, only when it is not the target's own attachment and has its size (the FX
    // pass draws into the HDR target; a reflection or another pass gets no soft fade)
    o.onBeforeRender = (renderer, scene, camera) => {
      const U = this.U, depth = game?.pipeline?.depthTexture, rt = renderer.getRenderTarget();
      let on = false;
      if (depth?.isDepthTexture && rt && rt.depthTexture !== depth && depth.image?.width && rt.width === depth.image.width && rt.height === depth.image.height) {
        on = true; U.uDepth.value = depth; U.uInvRes.value.set(1 / depth.image.width, 1 / depth.image.height);
      }
      if (!on) U.uDepth.value = _dummyDepth;
      U.uSoft.value = on ? 1 : 0; U.uNear.value = camera.near; U.uFar.value = camera.far;
    };
    src.add(o);
  }
  update(look, k, push, t, flick) {
    const U = this.U;
    U.uAuraA.value.copy(look.aura); U.uAuraB.value.copy(look.aura2);
    U.uAuraK.value.set(k, push, t, flick);
    this.mesh.visible = k > 0.005;
  }
  dispose() { this.mesh.parent?.remove(this.mesh); this.mat.dispose(); }   // (geometry + skeleton: the body mesh's)
}

/**
 * Small lightning arcs crawling over the horns and the wing spars: a pool of jagged camera-facing ribbons (world space,
 * ≈ 2.4 px wide or 2.2 cm, additive HDR, re-jittered 35×/s, each lives 0.07–0.2 s and crawls along its spar), lifted
 * 0.22 m toward the camera so they show over the spar / horn they follow; depth-tested (the body hides the far wing's).
 */
const ARC_N = 18, ARC_P = 9;
class ElementArcs {
  constructor(game, scale = 1) {
    this.game = game; this.scale = scale;
    const nv = ARC_N * ARC_P * 2;
    this.pos = new Float32Array(nv * 3); this.alpha = new Float32Array(nv); this.col = new Float32Array(nv * 3);
    const side = new Float32Array(nv);
    for (let i = 0; i < nv; i++) side[i] = i % 2 ? 1 : -1;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aCol', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    const idx = [];
    for (let a = 0; a < ARC_N; a++) for (let i = 0; i < ARC_P - 1; i++) { const v = (a * ARC_P + i) * 2; idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2); }
    g.setIndex(idx);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uLift: { value: 0.22 * scale } },
      vertexShader: /* glsl */`
        attribute float aAlpha, aSide; attribute vec3 aCol; uniform float uLift; varying float vA, vS; varying vec3 vC;
        void main() {
          vA = aAlpha; vS = aSide; vC = aCol;
          vec4 mv = viewMatrix * vec4(position, 1.0);
          mv.xyz += normalize(-mv.xyz) * uLift;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        varying float vA, vS; varying vec3 vC;
        void main() {
          float e = 1.0 - abs(vS), core = pow(e, 7.0);
          gl_FragColor = vec4((vC * (0.15 + 0.85 * e * e) + vec3(1.0, 1.0, 1.0) * core * 2.2) * vA, 1.0);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.name = 'dragon_element_arcs'; this.mesh.frustumCulled = false; this.mesh.visible = false; this.mesh.renderOrder = 7;
    this.arcs = Array.from({ length: ARC_N }, () => ({ on: false, sp: 0, s0: 0, len: 0, v: 0, t: 0, life: 0.1, amp: 0.1, jitT: 0,
      col: new THREE.Color(), off: new Float32Array(ARC_P * 2), ax: new THREE.Vector3(), ay: new THREE.Vector3() }));
    this.acc = 0; this.live = 0;
    game.scene.add(this.mesh);
  }
  clear() { for (const a of this.arcs) a.on = false; this.live = 0; this.mesh.visible = false; }
  _spawn(spars, n, look, onWing) {
    const a = this.arcs.find((x) => !x.on);
    if (!a || !n) return;
    // pick a spar: the horns weigh like ≈ 1.6 m of wing each (short, but on the head the chase camera looks at)
    let tot = 0;
    for (let i = 0; i < n; i++) tot += spars[i].kind === 'horn' ? 1.6 : spars[i].len * (spars[i].kind === 'arm' ? 1 : 0.7);
    let r = Math.random() * tot, i = 0;
    for (; i < n - 1; i++) { r -= spars[i].kind === 'horn' ? 1.6 : spars[i].len * (spars[i].kind === 'arm' ? 1 : 0.7); if (r <= 0) break; }
    const sp = spars[i], horn = sp.kind === 'horn';
    a.on = true; a.sp = i; a.t = 0; a.life = 0.07 + Math.random() * 0.13;
    a.len = Math.min(sp.len * 0.8, (horn ? 0.35 + Math.random() * 0.45 : 0.8 + Math.random() * 1.4) * this.scale);
    a.s0 = Math.random() * Math.max(0, sp.len - a.len);
    a.v = (Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * 3.5) * this.scale;
    a.amp = (horn ? 0.05 : 0.09 + Math.random() * 0.1) * this.scale;
    a.jitT = 0;
    a.col.copy(Math.random() < (look.name === 'storm' ? 0.5 : 0.3) ? look.arc2 : look.arc).multiplyScalar(horn ? 2.6 : 3.0);
    this._jitter(a);
    if (!horn) onWing?.();
  }
  _jitter(a) {
    for (let i = 0; i < ARC_P; i++) {
      const u = i / (ARC_P - 1), env = Math.sin(Math.PI * u);
      a.off[i * 2] = (Math.random() * 2 - 1) * env; a.off[i * 2 + 1] = (Math.random() * 2 - 1) * env;
    }
  }
  /** Returns the number of live arcs. */
  update(spars, n, dt, rate, look, cam, onWing) {
    if (dt > 0 && rate > 0 && n) {
      this.acc += dt * rate;
      while (this.acc >= 1) { this.acc -= 1; this._spawn(spars, n, look, onWing); }
    }
    const P = this.pos, A = this.alpha, C = this.col, viewH = this.game.pipeline?.stats?.height || 900;
    const tanV = Math.tan(((cam.fov || 50) * DEG) / 2);
    let live = 0;
    for (let k = 0; k < ARC_N; k++) {
      const a = this.arcs[k], base = k * ARC_P * 2;
      if (a.on && dt > 0) { a.t += dt; a.jitT += dt; a.s0 += a.v * dt; if (a.jitT > 1 / 35) { a.jitT = 0; this._jitter(a); } }
      const sp = a.on && a.sp < n ? spars[a.sp] : null;
      if (!sp || a.t >= a.life || a.s0 < -a.len * 0.5 || a.s0 > sp.len - a.len * 0.5) a.on = false;
      if (!a.on) { for (let i = 0; i < ARC_P * 2; i++) A[base + i] = 0; continue; }
      live++;
      const x = a.t / a.life, env = (1 - x) * Math.sqrt(1 - x) * (x < 0.15 ? 1.4 : 1) * (0.7 + 0.3 * Math.random());
      for (let i = 0; i < ARC_P; i++) {
        const u = i / (ARC_P - 1);
        const p = sparAt(sp, clamp(a.s0 + a.len * u, 0, sp.len), _v1, _v2);        // _v2 = tangent
        // a frame across the spar: ax ⟂ the tangent (world up where possible), ay = tangent × ax
        a.ax.crossVectors(_v2, Y); if (a.ax.lengthSq() < 1e-4) a.ax.set(1, 0, 0); a.ax.normalize();
        a.ay.crossVectors(_v2, a.ax).normalize();
        p.addScaledVector(a.ax, a.off[i * 2] * a.amp).addScaledVector(a.ay, a.off[i * 2 + 1] * a.amp);
        _v3.subVectors(cam.position, p);
        const dist = _v3.length();
        const w = _v4.crossVectors(_v2, _v3);
        if (w.lengthSq() < 1e-10) w.set(0, 1, 0); else w.normalize();
        const half = Math.max(0.03 * this.scale, dist * 2 * tanV / Math.max(200, viewH) * 2.6);
        const o = base + i * 2;
        P[o * 3] = p.x - w.x * half; P[o * 3 + 1] = p.y - w.y * half; P[o * 3 + 2] = p.z - w.z * half;
        P[o * 3 + 3] = p.x + w.x * half; P[o * 3 + 4] = p.y + w.y * half; P[o * 3 + 5] = p.z + w.z * half;
        const al = env * (0.55 + 0.45 * Math.sin(Math.PI * u));
        A[o] = A[o + 1] = al;
        C[o * 3] = C[o * 3 + 3] = a.col.r; C[o * 3 + 1] = C[o * 3 + 4] = a.col.g; C[o * 3 + 2] = C[o * 3 + 5] = a.col.b;
      }
    }
    this.live = live;
    this.mesh.visible = live > 0;
    if (live) { const at = this.mesh.geometry.attributes; at.position.needsUpdate = true; at.aAlpha.needsUpdate = true; at.aCol.needsUpdate = true; }
    return live;
  }
  dispose() { this.mesh.parent?.remove(this.mesh); this.mesh.geometry.dispose(); this.mat.dispose(); }
}
/** Point at arc length s along a spar polyline (into out) and the unit tangent there (into tan). */
function sparAt(sp, s, out, tan) {
  const n = sp.n, cum = sp.cum, pts = sp.pts;
  let i = 1;
  while (i < n - 1 && cum[i] < s) i++;
  const seg = cum[i] - cum[i - 1], u = seg > 1e-6 ? clamp((s - cum[i - 1]) / seg, 0, 1) : 0;
  out.lerpVectors(pts[i - 1], pts[i], u);
  tan.subVectors(pts[i], pts[i - 1]);
  if (tan.lengthSq() < 1e-10) tan.set(0, 0, 1); else tan.normalize();
  return out;
}

/**
 * Faint wing-tip trails when a Shade Rider manoeuvres: two camera-facing ribbons (world space, ≈ 0.6 s of history
 * sampled at 60 Hz), width ≈ 1.4 px or 0.15 m, additive HDR violet fading with age; intensity from the dragon's
 * apparent g-load, turn rate and speed. Drawn on the pipeline's FX layer (after the clouds, depth-tested).
 */
const TRAIL_N = 36;
class WingTrails {
  constructor(game, color, scale) {
    this.game = game; this.scale = scale;
    const nv = 2 * TRAIL_N * 2;
    this.pos = new Float32Array(nv * 3); this.alpha = new Float32Array(nv);
    const side = new Float32Array(nv);
    for (let i = 0; i < nv; i++) side[i] = i % 2 ? 1 : -1;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    const idx = [];
    for (let t = 0; t < 2; t++) for (let i = 0; i < TRAIL_N - 1; i++) { const a = (t * TRAIL_N + i) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    g.setIndex(idx);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: color } },
      vertexShader: /* glsl */`
        attribute float aAlpha, aSide; varying float vA, vS;
        void main() { vA = aAlpha; vS = aSide; gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor; varying float vA, vS;
        void main() { float e = 1.0 - vS * vS; gl_FragColor = vec4(uColor * vA * (0.35 + 0.65 * e), 1.0); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.name = 'dragon_wingtrails'; this.mesh.frustumCulled = false; this.mesh.visible = false;
    this.pts = [0, 1].map(() => Array.from({ length: TRAIL_N }, () => new THREE.Vector3()));
    this.ts = [new Float32Array(TRAIL_N), new Float32Array(TRAIL_N)];
    this.as = [new Float32Array(TRAIL_N), new Float32Array(TRAIL_N)];
    this.head = 0; this.count = 0; this.lastT = -1; this.life = 0.6; this.on = 0;
    game.scene.add(this.mesh);
  }
  /** tips { L, R } world; k = manoeuvre intensity 0..1; returns whether anything is drawn. */
  update(tips, k, now, cam, viewH) {
    if (now - this.lastT >= 1 / 60 || this.count === 0) {
      this.head = (this.head + 1) % TRAIL_N; this.count = Math.min(TRAIL_N, this.count + 1); this.lastT = now;
    }
    const h = this.head;
    this.pts[0][h].copy(tips.L); this.pts[1][h].copy(tips.R);
    this.ts[0][h] = this.ts[1][h] = now; this.as[0][h] = this.as[1][h] = k;
    let any = false;
    const tanV = Math.tan(((cam.fov || 50) * DEG) / 2), P = this.pos, A = this.alpha;
    for (let s = 0; s < 2; s++) {
      const pts = this.pts[s], ts = this.ts[s], as = this.as[s], tip = s ? tips.R : tips.L;
      for (let k2 = 0; k2 < TRAIL_N; k2++) {
        const o = (s * TRAIL_N + k2) * 2;
        if (k2 >= this.count) {                               // unused: degenerate at the tip, invisible
          A[o] = A[o + 1] = 0;
          P[o * 3] = P[o * 3 + 3] = tip.x; P[o * 3 + 1] = P[o * 3 + 4] = tip.y; P[o * 3 + 2] = P[o * 3 + 5] = tip.z;
          continue;
        }
        const i = (h - k2 + TRAIL_N) % TRAIL_N, ip = (i + 1) % TRAIL_N, im = (i - 1 + TRAIL_N) % TRAIL_N;
        const p = pts[i];
        const a = k2 === 0 ? pts[i] : pts[ip], b = k2 >= this.count - 1 ? pts[i] : pts[im];
        _v1.subVectors(a, b);                                 // tangent (newer - older)
        _v2.subVectors(cam.position, p);
        const dist = _v2.length();
        _v3.crossVectors(_v1, _v2);
        if (_v3.lengthSq() < 1e-10) _v3.set(0, 1, 0); else _v3.normalize();
        const half = Math.max(0.08 * this.scale, dist * 2 * tanV / Math.max(200, viewH) * 0.7);
        const age = (now - ts[i]) / this.life;
        const fade = age >= 1 ? 0 : (1 - age) * (1 - age) * Math.min(1, k2 / 2);
        const al = as[i] * fade * Math.exp(-dist / 1500);
        if (al > 0.002) any = true;
        P[o * 3] = p.x - _v3.x * half; P[o * 3 + 1] = p.y - _v3.y * half; P[o * 3 + 2] = p.z - _v3.z * half;
        P[o * 3 + 3] = p.x + _v3.x * half; P[o * 3 + 4] = p.y + _v3.y * half; P[o * 3 + 5] = p.z + _v3.z * half;
        A[o] = A[o + 1] = al;
      }
    }
    this.mesh.visible = any;
    if (any) { this.mesh.geometry.attributes.position.needsUpdate = true; this.mesh.geometry.attributes.aAlpha.needsUpdate = true; }
    return any;
  }
  reset() { this.count = 0; this.mesh.visible = false; }
  dispose() { this.mesh.parent?.remove(this.mesh); this.mesh.geometry.dispose(); this.mat.dispose(); }
}

export default Dragon;
