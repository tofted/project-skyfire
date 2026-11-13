// FlightBody — 6-DOF flapping flight for the dragons. Force-based: gravity + quasi-steady blade-element aerodynamics
// on strips computed from the CURRENT wing pose (wingkin.js), so what you see is what flies. The downstroke makes
// lift + thrust, the folded upstroke little drag; stall/post-stall, induced drag from the live span, body/neck/tail
// drag, the tail as a stabiliser. Control is torque-based through the wings and tail (differential twist/fold,
// sweep, elevator, rudder) plus a bounded pilot-assist torque. Angular momentum is integrated with the inertia of the
// current wing pose (tucking mid-roll spins the body up). No pose or velocity is ever set directly.
//
// Axes: body +Z forward, +Y up, +X left (model convention). Rates: roll right (right wing down) = +w.z,
// pitch nose-up = -w.x, yaw nose-right = -w.y. controls.pitch/roll/yaw are normalised RATE commands (-1..1).
import * as THREE from 'three';
import {
  buildGeometry, defaultParams, createPose, evaluatePose, makeSections, wingSections, stripsFromSections,
  makeStrips, STRIPS_PER_WING, WING_GEOMETRY, strokeElevation, HOVER,
} from './wingkin.js';

const DEG = Math.PI / 180;
const G0 = 9.81;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const damp = (k, dt) => 1 - Math.exp(-k * dt);
const smoothstep = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------------------------------------------------------
// Specs. scale multiplies every length of the canonical wing/body geometry; mass is total (dragon + rider).
// ---------------------------------------------------------------------------------------------------------------
const BASE = {
  mass: 1100, scale: 1, wingMassFrac: 0.13,
  inertiaCore: [7200, 7800, 520],        // core (no wings) about body X (pitch), Y (yaw), Z (roll), kg m^2 at scale 1
  aero: {
    cd0: 0.034,            // membrane profile drag (bones, claws, membrane flutter)
    oswald: 0.8,
    alphaStall: 17.5,      // deg, measured from zero lift
    stallPad: 9,           // deg of blend into post-stall
    stallHyst: 3.5,        // deg: a stalled strip reattaches this much lower
    cd90: 1.98, cf: 0.02,
    lev: 8,                // deg of delayed-stall bonus in fast downstrokes (leading-edge vortex, [tune])
    levProg: 24,           // extra LEV stall delay in scripted power strokes (fantasy membrane vortex, [tune])
    camber: 0.035,         // membrane camber h/c at full billow
    bodyCdA: { front: 0.85, side: 5.0, top: 7.0 },   // m^2 (neck, head, horns, tail, legs, rider, saddle)
    bodyCp: [0, 0, -1.2],  // body drag centre of pressure (behind the CG -> weathercock)
    bodyStrip: { pos: [0, 0.35, 0.1], area: 3.6, incidence: 1 },
    htail: { pos: [0, 0.25, -6.6], area: 3.4, ar: 2.4, alphaStall: 26 },
    vtail: { pos: [0, 0.7, -6.2], area: 1.7, ar: 1.5, alphaStall: 26 },
    neck: { pos: [0, 0.9, 4.2], area: 1.2 },
    legsCdA: 0.7,          // extra drag with legs lowered (flare)
    // dive tuck (wave 4, "the stoop is floaty": 0.5–0.75 of g·sinθ): the folded membranes lie along the flanks, legs,
    // neck and tail streamline — exposed wing-strip area × (1 − tuckWing·tuck), body CdA × (1 − tuckBody·tuck)
    tuckWing: 0.55, tuckBody: 0.45,
    brakeCdA: 0.6,         // the dive air brake (above diveMax − 7 m/s): half-opened wings cupped, tail fanned
  },
  flap: {
    fMin: 1.1, fMax: 1.6, fBoost: 2.2,      // Hz: cruise effort 0..1, boost
    ampMin: 20, ampMax: 34, ampBoost: 37,   // deg half amplitude of the shoulder stroke
    down: 0.56, snap: 0.32, fold: 0.75,     // downstroke share, reversal hang, upstroke fold
    twistD: [-1, 3], twistU: -9, kff: 0.92,
    fHard: 2.0, ampHard: 37,                // W "beat harder" (controls.hard): between cruise effort 1 and boost
    pump: 0.3,                              // flap amount of the shallow strokes in a loaded gliding turn
    loadFold: 0.45, loadUnload: 0.6, loadHurry: 0.8,   // controls.load: spread + loaded upstroke, hurried upstroke
  },
  control: {
    pMax: 150 * DEG, qMax: 60 * DEG, rMax: 35 * DEG,
    // roll through the wings: mostly differential TWIST (reads as a subtle tilt of the membranes); the inner-wing
    // fold / rise is kept small (feel fix: the inner wing folding up by 0.35 read as a broken wing in every turn)
    twistDiff: 19 * DEG, elevDiff: 3 * DEG, foldDiff: 0.1, dodgeTwistDiff: 16 * DEG, dodgeElevDiff: 6 * DEG, dodgeFoldDiff: 0.35,
    sweepPitch: 9 * DEG, elevator: 24 * DEG,
    rudder: 22 * DEG, sweepYaw: 3 * DEG, muscleTau: 0.07,
    assist: { roll: [9, 70000], pitch: [6, 70000], yaw: [5, 30000], weight: 1 },   // [gain 1/s, max N m] at scale 1
    rollDampFF: 26000,     // N m s: assist feed-forward on the commanded roll rate (cancels part of aero damping)
    // Turn entry (wave 4, critic gameplay #4: "0.45 s before the course moves"): controls.skid (−1..1, + = right)
    // asks the tail, rudder and the skidding body for a level side force of up to skidG × weight at cruise dynamic
    // pressure (× V²/34², capped 1.5×), through the muscle lag. The player's pilot only asks for the part of the
    // turn the bank does not deliver: during the roll-in of every turn, and through small corrections (< 20–35°
    // pending), where its bank stays gentle. [tune] (0.6 → 0.7 g: node, 34 m/s, the path moves 1° after 0.13–0.16 s
    // instead of 0.14–0.20 s, a 20° aim is within 5° in 0.80–0.97 s instead of 0.85–0.99 s; bank unchanged)
    skidG: 0.7,
  },
  stamina: { boostDrain: 0.19, dodgeCost: 0.24, beatCost: 0.16, regen: 0.11, delay: 0.9 },
  // Dodge hop (wave 4): D m sideways over T s (minimum jerk) from the outer wing's stroke (lag × the anticipation),
  // heading kept, then stopped sideways; the shove is a bounded force at the CG (|a| ≤ gMax g, PD kp / kd on the
  // lateral offset), a surge above the entry speed + fwdSlack is braked (≤ fwdMax g). bank: deg of the roll into the
  // hop. invulnAt: share of the hop covered by the i-frames (state.dodgeLeft).
  dodgeHop: { D: 12, T: 0.78, lag: 0.5, gMax: 14, kp: 45, kd: 13, fwdK: 5, fwdSlack: 2, fwdMax: 4, kpV: 16, kdV: 8, gV: 3, kNose: 9,
    bank: 38, settle: 0.2, invulnAt: 0.95 },
  // Power beat: the big downstroke's lift as a bounded vertical pulse (peak g × weight, sin² over T s) from the start
  // of the downstroke (0.05–0.12 s after the key: the anticipation is capped), on top of the stroke's own aero.
  // lead: the pulse starts this much before the downstroke — the clap of the wings over the back (clap-and-fling).
  beatBurst: { g: 3.6, T: 0.32, lead: 0.04 },
  dodgeQueue: 0.25,        // s a Q / E press waits for a scripted stroke to allow it (wave 5; see _mix)
  // Flight moves (wave 6, user: "make the dragon controls more interesting"). Scripted PILOT programs: they command
  // body rates through the bounded pilot-assist torque and top up the wings' lift along the body's OWN lift axis (the
  // membranes "bite" the air: bounded, and only as far as the body is rolled / pitched the right way), with the
  // induced drag of that lift (ld). Nothing sets a velocity or an attitude. See _startMove / _moveStep.
  //  wingover: the velocity turns 180° in a plane tilted `tilt`° from vertical toward the side (up, over the wing tip,
  //            down the other way: heading reversed, a little height gained); loop: an Immelmann — the same in the
  //            vertical plane (half loop up), then a half roll upright on top (tucked wings: fast roll); dash: one
  //            huge rowing wingbeat (stroke plane tilted back) + a bounded thrust pulse along the path (+dv m/s over T s).
  //  rate: peak path turn rate (rad/s), rateIn: s to build it, brake: rad/s² easing out, nMax: total lift budget (g),
  //  gMax / gNeg: lift top-up bounds (g), kPlane: 1/s back into the turn plane, att / attMax / roll: attitude loop
  //  gain (1/s), rate cap (rad/s), roll-rate cap (rad/s); cup / tuck: wing shape in the pull / over the top.
  //  Fix pass (critic #4, "exits are slow, chained reversals bleed the dragon to near-stall": wingover 0.79×, loop 0.63×
  //  of the entry speed): ld 9 → 14 (less induced drag from the top-up lift) and an EXIT STROKE — as the wings come level
  //  (the wingover's pull done / the Immelmann's half roll done) one big rowing downstroke (PROGRAMS.exit) drives the
  //  speed back up to exitKeep × the entry speed (never above it) on a minimum-jerk ramp over surgeT s, bounded to
  //  surgeMax g forward (the move's stamina pays for it). minV: below this entry speed (m/s) the reversal is refused
  //  (state.moveDenied reason 'speed') instead of being flown on lift from nowhere.
  //  Dash (critic #7, "three dashes stack 35 → 69 m/s while climbing"): the gain shrinks toward vCap m/s above the
  //  cruise speed (dv = min(dv, cruise + vCap − V); below dvMin: refused, reason 'speed'), and stamina does not
  //  regenerate for noRegen s after it.
  moves: {
    wingover: { cost: 0.25, cooldown: 0.45, tilt: 58, rate: 3.1, rateIn: 0.15, brake: 8, endTol: 0.1, nMax: 8.6, gMax: 5.8, gNeg: 1,
      ld: 14, fwdK: 6, fwdSlack: 1, fwdMax: 3, kPlane: 4, att: 10, attMax: 6, roll: 5, aoaN: 2.4, split: 0.5, cup: 0.8, tuck: 0.35, exit: 0.45, exitG: 1.6, timeout: 3.5,
      minV: 22, exitKeep: 0.9, surgeT: 0.34, surgeMax: 4.5, surgeKp: 10 },
    loop: { cost: 0.35, cooldown: 0.6, tilt: 0, rate: 2.8, rateIn: 0.15, brake: 8, endTol: 0.12, nMax: 7.5, gMax: 5.5, gNeg: 1,
      ld: 14, fwdK: 6, fwdSlack: 1, fwdMax: 3, kPlane: 4, att: 10, attMax: 6, roll: 5.5, aoaN: 2.4, split: 0.55, cup: 0.7, tuck: 0, rollTuck: 0.55, rollMax: 1.1,
      exit: 0.35, exitG: 1.6, timeout: 5, minV: 22, exitKeep: 0.9, surgeT: 0.36, surgeMax: 4.5, surgeKp: 10 },
    dash: { cost: 0.2, cooldown: 0.8, dv: 18, T: 0.38, lead: 0.02, kp: 12, aMax: 9, aMin: 3, streamline: 0.32, tuck: 0.32, vCap: 22, dvMin: 2, noRegen: 1.5 },
  },
  // Hover (flight modes, the user: "the dragon should not always fly forward — only with a button"). The pilot calls
  // hoverSteer() instead of steer(); controls.hover (0..1) blends the HOVER stroke in (wingkin: near-horizontal stroke
  // plane with the body pitched up `pitch`°, deep strokes) and this controller: a velocity loop (+ a position hold once
  // the dragon has stopped, + a small integrator) gives the wanted acceleration (bounded: aH g sideways — aBrake while
  // braking out of flight, aFwd while accelerating into it — aUp / aDown g vertically); the body's LIFT AXIS (the
  // stroke plane's normal, `pitch`° ahead of the body's up) is turned along that acceleration + g (lean into a strafe,
  // tip forward to accelerate, rear up to brake) through bounded assist torques; the wings' own lift along that axis is
  // measured (low-passed over `tau` s: the stroke's pulse stays as a bob) and a hover-assist force ALONG THE BODY'S LIFT
  // AXIS tops up the rest, ≤ assistMax × weight [fantasy: a 1.1 t dragon cannot really hover; the strips give what they
  // give, see the tests]. Nothing sets a position, velocity or attitude. Stamina: none for hovering, strafeCost per
  // second for the first strafeBurst s of a strafe from rest (< strafeFreeV m/s sideways; at most one per strafeGap s).
  // freq / amp: the stroke (idle, climbing, sinking / light).
  // The stroke is the thrust control: u (−1 … +1.3) sets frequency × (1 + fK·u) and amplitude × (1 + aK·u) of the
  // nominal freq / amp (lift ∝ (f·amp)²: u = −1 → ~0.63 g, 0 → wings0, +1.3 → ~1.5 g); its feed-forward comes from the
  // lift wanted over what the nominal stroke gives (wings0 g, measured: wingkin HOVER), a slow integrator trims it on the
  // stroke-cycle mean of the wings' lift. The assist covers the rest while the stroke catches up: ≤ assistMax g up, and
  // down to −assistMin g (a bounded shortcut for the wing feathering its excess).
  hover: {
    pitch: 31, freq: 2.1, amp: 46, fK: 0.1, aK: 0.1, uMin: -1, uMax: 1.3, wings0: 0.85, heaveLoss: 0.74, uKi: 0.8, uIMax: 1.2,
    kv: 1.6, kp: 1.0, ki: 0.35, iMax: 2.5, holdV: 0.6, holdMax: 3, kff: 0.38,
    aH: 0.62, aBrake: 1.3, aFwd: 1.15, aUp: 0.85, aDown: 0.65, tiltMax: 36, tiltBrake: 46, tiltFwd: 54,
    tiltBrakeLow: 14, tiltBrakeV: [13, 25], tiltBrakeEnd: [3, 12], tiltBackRate: 12, tiltDrift: 16,
    assistMax: 1.6, assistMin: 0.35, meanTau: 0.15,
    att: 6, attMax: 1.8, yawRate: 115, aimPitch: 0.22, aimPitchMax: 9,
    strafe: 8, climb: 7, sink: 7, back: 3.5, agl: 7,
    strafeCost: 0.04, strafeBurst: 0.6, strafeFreeV: 2, strafeGap: 1.5,
    blendIn: 2.6, blendOut: 1.8,
  },
  moveQueue: 0.5,          // s a move request waits for the running move / hop to allow it (latest press wins; expiry → moveDenied 'busy')
  chordRefund: 0.16,       // s: a power beat taken over by a move this soon is the same stroke — its stamina is given back
  ground: { takeoffAfter: 0.25, climbOut: 1.2, restitution: 0.3, friction: 0.25, tumble: 0.05 },
  // virtual pilot: nMax / bankMax at urgency 0 and 1
  pilot: { cruise: 34, nMax: [2.1, 4.2], bankMax: [62, 80], turnGain: 1.6, terrainLook: 3.5 },
  diveMax: 75,             // m/s, above this the dive tuck opens and the legs drop (air brake)
  flareMaxG: 2.5,
  clearance: 1.7,          // belly height above ground at scale 1
};

function spec(over) {
  const s = structuredClone(BASE);
  for (const k of Object.keys(over)) {
    if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k])) Object.assign(s[k], over[k]);
    else s[k] = over[k];
  }
  return s;
}

export const DRAGON_SPECS = {
  hero: spec({ name: 'hero' }),
  // Crimson Riders' black dragons: lighter and a touch smaller -> quicker, lower top speed.
  crimson: spec({ name: 'crimson', mass: 900, scale: 0.92, pilot: { ...BASE.pilot, cruise: 33 } }),
  // Onyx: an elite, bigger and heavier; hits harder, turns wider.
  onyx: spec({ name: 'onyx', mass: 1350, scale: 1.08, pilot: { ...BASE.pilot, cruise: 36 } }),
  // Drake: a small riderless wyvern for the Shade Riders' flocks. ~350 kg, span ~9 m (scale 0.54 of the canonical
  // wing), about the hero's wing loading (so a similar stall speed), faster wingbeat for the shorter wing (same
  // Strouhal band), quicker roll, a draggier airframe (weaker glide), top speed ~0.9 x the hero's boost.
  drake: spec({
    name: 'drake', mass: 350, scale: 0.54, wingMassFrac: 0.12,
    aero: { cd0: 0.052, oswald: 0.66, bodyCdA: { front: 1.25, side: 5.4, top: 7.2 } },
    flap: { fMin: 2.0, fMax: 3.0, fBoost: 4.1, ampMin: 22, ampMax: 36, ampBoost: 38 },
    control: {
      pMax: 220 * DEG, qMax: 80 * DEG, rMax: 48 * DEG,
      assist: { roll: [13, 70000], pitch: [8, 70000], yaw: [6, 30000], weight: 1 }, rollDampFF: 30000,
    },
    stamina: { boostDrain: 0.16, dodgeCost: 0.2, beatCost: 0.14, regen: 0.16, delay: 0.7 },
    dodgeHop: { D: 10, T: 0.62, lag: 0.5, gMax: 16, kp: 55, kd: 15, fwdK: 5, fwdSlack: 2, fwdMax: 4, kpV: 16, kdV: 8, gV: 3, kNose: 10,
      bank: 42, settle: 0.18, invulnAt: 0.95 },
    pilot: { ...BASE.pilot, cruise: 36, nMax: [2.4, 4.8], bankMax: [66, 82], turnGain: 1.9 },
  }),
};

/**
 * AI use of the flight moves (fix pass, critic #10: "0 enemy moves in 640 s of fights; the contract says they are fair
 * for the AI too"). A pure advisor for an AI pilot — the enemies owner calls it from its pilot and starts what it
 * returns with body.startMove(name, side) (same stamina, cooldowns and refusals as the player):
 *   const mv = aiMoveChoice(body, { skill: 'ace', threat, target, now }); if (mv) body.startMove(mv.name, mv.side);
 * threat = { pos, vel } of whoever sits on our tail (optional), target = { pos } we are chasing (optional), now = s.
 * Rules (AI_MOVES): aces / veterans reverse with a wingover toward the threat's side when it sits behind (> behind° off
 * the nose) within `near` m and stamina > `stamina`, at most every `every` s (± a per-body jitter); rookies never; drakes
 * (and aces) dash to close on a target `dash.from`–`dash.to` m ahead within `dash.cone`° of the nose. Returns
 * { name, side, reason } or null; remembers its own clock on the body (body._aiMoveAt).
 */
export const AI_MOVES = {
  wingover: { skills: ['veteran', 'ace'], behind: 120, near: 150, stamina: 0.5, every: [8, 10], minV: 26 },
  dash: { skills: ['drake', 'ace'], from: 250, to: 450, cone: 20, stamina: 0.5, every: [6, 8], maxV: 44 },
};
export function aiMoveChoice(body, { skill = 'rookie', threat = null, target = null, now = 0 } = {}) {
  try {
    if (!body || body.dead || body._move || body._dash || body._hop || body._moveQ) return null;
    const V = body.vel.length();
    if (!(V > 1)) return null;
    const A = AI_MOVES, jit = body._aiJit ?? (body._aiJit = ((body.mass * 7919 + (body.pos.x | 0)) % 1000) / 1000);
    const ready = (rule) => now - (body._aiMoveAt ?? -1e9) >= rule.every[0] + (rule.every[1] - rule.every[0]) * jit;
    const fwd = _v1.copy(body.vel).multiplyScalar(1 / V);
    const W = A.wingover;
    if (threat?.pos && W.skills.includes(skill) && body.stamina > W.stamina && V > W.minV && ready(W) && body._moveCd.turn <= 0) {
      const rel = _v2.subVectors(threat.pos, body.pos), d = rel.length();
      if (d > 1 && d < W.near && Math.acos(clamp(rel.dot(fwd) / d, -1, 1)) > W.behind * DEG) {
        const side = Math.sign(_v3.crossVectors(fwd, Y).dot(rel)) || 1;   // right of the path = fwd × up
        body._aiMoveAt = now;
        return { name: 'wingover', side, reason: 'tail' };
      }
    }
    const D = A.dash;
    if (target?.pos && D.skills.includes(skill) && body.stamina > D.stamina && V < D.maxV && ready(D) && body._moveCd.dash <= 0) {
      const rel = _v2.subVectors(target.pos, body.pos), d = rel.length();
      if (d > D.from && d < D.to && Math.acos(clamp(rel.dot(fwd) / d, -1, 1)) < D.cone * DEG) {
        body._aiMoveAt = now;
        return { name: 'dash', side: 0, reason: 'close' };
      }
    }
  } catch { /* an advisor never throws */ }
  return null;
}

/** Default air density (1/e height 9 km, a gentle ISA stand-in). */
export const airDensity = (y) => 1.225 * Math.exp(-Math.max(-500, y) / 9000);

/**
 * Build an env for FlightBody.step from a Game — shared by EVERY dragon (dragon.js uses it for all of them).
 * Everything is resolved lazily on each call, so systems that fill game.world / game.titan later still count:
 *  - heightAt / seaLevel / bounds from game.world;
 *  - wind(pos, out) = game.world.wind?.(pos, out)   (clouds: breeze, thermals near cumulus, downdrafts)
 *                   + game.titan.windAt?.(pos, out) (downwash, beat rings, gust cone) — only while
 *                     titan.config.applyWindForces === false, so the titan's own push on the player is never doubled.
 * Samples that throw or are not finite count as calm air. FlightBody samples the wind once per fixed step (CG + tips).
 */
export function makeEnv(game, extra = {}) {
  const tmp = new THREE.Vector3();
  const add = (fn, self, p, out) => {
    tmp.set(0, 0, 0);
    let r;
    try { r = fn.call(self, p, tmp); } catch { return; }
    if (r && r !== tmp && r.isVector3) tmp.copy(r);
    if (Number.isFinite(tmp.x + tmp.y + tmp.z)) out.add(tmp);
  };
  const wind = (p, out) => {
    out.set(0, 0, 0);
    const W = game?.world;
    if (W && typeof W.wind === 'function') add(W.wind, W, p, out);
    const T = game?.titan;
    if (T && typeof T.windAt === 'function' && T.config?.applyWindForces === false) add(T.windAt, T, p, out);
    if (!Number.isFinite(out.x + out.y + out.z) || out.lengthSq() > 120 * 120) out.set(0, 0, 0);
    return out;
  };
  return {
    gravity: G0,
    airDensity,
    heightAt: (x, z) => { const w = game?.world; return w?.heightAt ? w.heightAt(x, z) : 0; },
    get seaLevel() { return game?.world?.seaLevel ?? 0; },
    get bounds() { return game?.world?.bounds || { radius: 9000, floor: 40, ceiling: 4200 }; },
    wind,
    ...extra,
  };
}

// Scripted strokes: keys [t (s), elevation (deg), fold 0..1] with cosine easing; key 0 = the pose at the trigger.
// Anticipation (wings up, folded) -> power downstroke (little pronation -> force along body-up) -> recovery.
// Power beat (wave 4): the anticipation adapts to where the wing is at 16 rad/s but never takes more than antMax
// (0.12 s), so the downstroke — and the beat's lift pulse (spec.beatBurst) — starts within ~0.05–0.12 s of the key.
export const PROGRAMS = {
  beat: {
    outer: [[0, 0, 0], [0.24, 62, 0.72], [0.54, -46, 0], [0.76, -14, 0.3]],
    inner: [[0, 0, 0], [0.24, 62, 0.72], [0.54, -46, 0], [0.76, -14, 0.3]],
    wIn: 0.05, wOut: [0.58, 0.8], kffDown: 0.4, kffUp: 1, twist: 4, strokeAt: 0.24, rate: 16, antMin: 0.05, antMax: 0.12,
  },
  // Dodge (wave 4, the hop): the outer wing raises and drives ONE big shoving stroke while the inner wing tucks in,
  // then both recover with a shallow stroke. The strokes are the visual of the shove; the hop force does the work.
  dodge: {
    outer: [[0, 0, 0], [0.08, 72, 0.5], [0.27, -40, 0], [0.43, 28, 0.55], [0.58, -18, 0.05], [0.7, -10, 0.3]],
    inner: [[0, 0, 0], [0.08, 30, 0.85], [0.27, 22, 0.7], [0.43, 30, 0.55], [0.58, -18, 0.05], [0.7, -10, 0.3]],
    wIn: 0.04, wOut: [0.56, 0.74], kffDown: 0.75, kffUp: 1, twist: 3, strokeAt: 0.08, tilt: -10, rate: 14, lev: 14,
  },
  // Wave 6 — the entry stroke of a wingover / loop: both wings high, one big grabbing downstroke as the pull begins
  // (no lift pulse of its own: the move's lift top-up does that work), then the pull goes on with loaded, cupped wings.
  grab: {
    outer: [[0, 0, 0], [0.16, 60, 0.7], [0.42, -44, 0], [0.62, -12, 0.25]],
    inner: [[0, 0, 0], [0.16, 60, 0.7], [0.42, -44, 0], [0.62, -12, 0.25]],
    wIn: 0.04, wOut: [0.46, 0.68], kffDown: 0.45, kffUp: 1, twist: 4, strokeAt: 0.16, rate: 16, antMin: 0.04, antMax: 0.1, lev: 22,
  },
  // Wave 6 — dash: wings thrown up and forward, one huge rowing downstroke that drives down AND back (stroke plane
  // tilted back), then swept back half-folded for the surge. The thrust pulse (spec.moves.dash) is the stroke's work.
  dash: {
    outer: [[0, 0, 0], [0.1, 64, 0.62], [0.3, -52, 0], [0.46, -22, 0.5], [0.62, -8, 0.35]],
    inner: [[0, 0, 0], [0.1, 64, 0.62], [0.3, -52, 0], [0.46, -22, 0.5], [0.62, -8, 0.35]],
    wIn: 0.04, wOut: [0.46, 0.64], kffDown: 0.5, kffUp: 1, twist: 3, strokeAt: 0.1, tilt: -26, rate: 16, antMin: 0.04, antMax: 0.1, lev: 20,
  },
  // Fix pass — the exit stroke of a wingover / loop: as the wings come level, both rise and row one big stroke down and
  // back (stroke plane tilted back 16°): the speed the reversal cost is won back (spec.moves.*.exitKeep / surge*).
  exit: {
    outer: [[0, 0, 0], [0.14, 58, 0.66], [0.36, -42, 0], [0.54, -12, 0.25]],
    inner: [[0, 0, 0], [0.14, 58, 0.66], [0.36, -42, 0], [0.54, -12, 0.25]],
    wIn: 0.04, wOut: [0.4, 0.6], kffDown: 0.5, kffUp: 1, twist: 3, strokeAt: 0.14, tilt: -16, rate: 14, antMin: 0.05, antMax: 0.12, lev: 18,
  },
};
const TURN_MOVES = new Set(['wingover', 'loop']);
function evalProgram(keys, pr, out, j = null) {
  // key times after the first are shifted by pr.shift (the anticipation adapts to where the wing starts)
  const sh = pr.shift || 0, kt = (k) => (k === 0 ? 0 : keys[k][0] + sh);
  const t = pr.t;
  let i = 0;
  while (i < keys.length - 2 && t > kt(i + 1)) i++;
  const k0 = [kt(i), keys[i][1], keys[i][2]], k1 = [kt(i + 1), keys[i + 1][1], keys[i + 1][2]];
  // j (wave 5): this wing's start when the script took over a running one (a dodge cutting into a power beat)
  const p0 = i === 0 ? (j ? j.psi : pr.psi0) : k0[1] * DEG, p1 = k1[1] * DEG;
  const f0 = i === 0 ? (j ? j.fold : pr.fold0) : k0[2], f1 = k1[2];
  const T = Math.max(1e-3, k1[0] - k0[0]);
  const u = clamp((t - k0[0]) / T, 0, 1);
  const e = 0.5 - 0.5 * Math.cos(Math.PI * u);
  if (i === 0 && j && j.psiDot) {
    // hand-over: a cubic Hermite from the wing's position AND rate to the first key (the stroke never pops or stops dead)
    const u2 = u * u, u3 = u2 * u, v0 = j.psiDot * T;
    out.psi = (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * v0 + (3 * u2 - 2 * u3) * p1;
    out.psiDot = u < 1 ? ((6 * u2 - 6 * u) * (p0 - p1) + (3 * u2 - 4 * u + 1) * v0) / T : 0;
  } else {
    out.psi = p0 + (p1 - p0) * e;
    out.psiDot = u < 1 ? (p1 - p0) * 0.5 * Math.PI * Math.sin(Math.PI * u) / T : 0;
  }
  out.fold = f0 + (f1 - f0) * e;
}

const DEFAULT_ENV = { gravity: G0, airDensity, heightAt: () => -1e9, seaLevel: -1e9, bounds: null, wind: null };
const CAL_CACHE = new WeakMap();   // spec -> Map(geometry key -> { cal, trimElev }): spawning stays cheap (~0.1 ms)
function calCache(spec) { let m = CAL_CACHE.get(spec); if (!m) CAL_CACHE.set(spec, (m = new Map())); return m; }
const HOVER_CAL = new WeakMap();   // spec -> Map(geometry key -> { kff, wings0, axis }) (flight modes, see _hoverCal)
function hoverCalCache(spec) { let m = HOVER_CAL.get(spec); if (!m) HOVER_CAL.set(spec, (m = new Map())); return m; }
/** Cycle-mean force of the nominal hover stroke at V = 0 on a scratch body with geometry `geom` and downstroke
 *  pronation kff: { along (N, along the lift axis `pitch` rad ahead of body-up), axis (rad ahead of body-up) }. */
function hoverStrokeForce(spec, geom, kff, pitch) {
  const H = spec.hover, b = new FlightBody(spec, { pos: [0, 1500, 0], speed: 0 });
  b.geom = geom;
  const P = b.prm, fl = spec.flap;
  Object.assign(P, { a: 1, amp: H.amp * DEG, freq: H.freq, airspeed: 0, hover: 1, hoverPitch: 0, hoverKff: kff, tuck: 0, flare: 0, beat: 0,
    down: fl.down, snap: fl.snap, fold: fl.fold, kff: fl.kff, camber: 0.55, cup: 0, load: 1, psi0: 0 });
  P.prog.w = 0; b._b.freq = H.freq; b._b.a = 1; b._b.tuck = 0; b._legs = 0; b._brake = 0;
  const n = 64, h = 1 / (H.freq * n), F = new THREE.Vector3(), T = new THREE.Vector3(), Fs = new THREE.Vector3(), vB = new THREE.Vector3(), w0 = new THREE.Vector3();
  b._phase = 0; for (const s of b.surfaces) { s.valid = false; s.stalled = false; }
  b._updatePose(0);
  for (let i = 0; i < n * 2; i++) {
    b._phase += 1 / n; b._updatePose(h);
    F.set(0, 0, 0); T.set(0, 0, 0);
    b._aero(1.04, vB, w0, F, T, null, null);
    if (i >= n) Fs.add(F);
  }
  Fs.multiplyScalar(1 / n);
  return { along: Fs.y * Math.cos(pitch) + Fs.z * Math.sin(pitch), axis: Math.atan2(Fs.z, Fs.y) };
}

// ---------------------------------------------------------------------------------------------------------------
// Aerodynamic coefficients: finite-AR lift slope, attached region with induced drag, blended flat-plate post-stall
// (Khan & Nahon 2015 style). alpha in rad (geometric), camber = h/c. Writes {cl, cd, stalledT} into out.
// ---------------------------------------------------------------------------------------------------------------
function wrapPi(a) { a = (a + Math.PI) % (Math.PI * 2); if (a < 0) a += Math.PI * 2; return a - Math.PI; }
export function aeroCoeffs(alpha, camber, AR, alphaStall, pad, aero, out = {}) {
  const slope = (2 * Math.PI * AR) / (AR + (2 * (AR + 4)) / (AR + 2));
  const a0 = -2 * camber;
  const x = wrapPi(alpha - a0);
  const ax = Math.abs(x);
  const induced = 1 / (Math.PI * aero.oswald * Math.max(AR, 0.5));
  let cl, cd;
  const attached = (xx) => { const c = slope * xx; return [c, aero.cd0 + c * c * induced]; };
  const post = (xx) => {
    const sx = Math.sin(xx), cx = Math.cos(xx);
    const cn = aero.cd90 * sx * (1 / (0.56 + 0.44 * Math.abs(sx)) - 0.41 * (1 - Math.exp(-17 / Math.max(AR, 0.5))));
    const ct = 0.5 * aero.cf * cx;
    return [cn * cx - ct * sx, cn * sx + ct * cx];
  };
  let t = 0;
  if (ax <= alphaStall) { [cl, cd] = attached(x); }
  else {
    t = smoothstep(0, 1, (ax - alphaStall) / pad);
    const [c1, d1] = attached(Math.sign(x) * alphaStall);
    const [c2, d2] = post(x);
    cl = lerp(c1, c2, t); cd = lerp(d1, d2, t);
  }
  out.cl = cl; out.cd = Math.max(cd, aero.cd0); out.stalledT = t;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _w = new THREE.Vector3(), _wp = new THREE.Vector3(), _lhat = new THREE.Vector3(), _f = new THREE.Vector3();
const _qi = new THREE.Quaternion(), _q = new THREE.Quaternion();
const _coef = { cl: 0, cd: 0, stalledT: 0 };
const _F = new THREE.Vector3(), _Fw = new THREE.Vector3(), _up = new THREE.Vector3(), _fw = new THREE.Vector3();
const _rt = new THREE.Vector3(), _d = new THREE.Vector3(), _vh = new THREE.Vector3(), _aL = new THREE.Vector3();
const _lvlUp = new THREE.Vector3(), _lvlRt = new THREE.Vector3(), _tmp = new THREE.Vector3();
const _windC = new THREE.Vector3(), _windL = new THREE.Vector3(), _windR = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);
const _ts = new THREE.Vector3(), _tc = new THREE.Vector3(), _tn = new THREE.Vector3(), _cp = new THREE.Vector3(), _tq = new THREE.Vector3();
// flight moves (wave 6)
const _m1 = new THREE.Vector3(), _m2 = new THREE.Vector3(), _m3 = new THREE.Vector3(), _m4 = new THREE.Vector3(), _m5 = new THREE.Vector3();
const _m6 = new THREE.Vector3(), _mu = new THREE.Vector3(), _mu2 = new THREE.Vector3(), _mf = new THREE.Vector3(), _ml = new THREE.Vector3();
const _me2 = new THREE.Vector3(), _mwd = new THREE.Vector3(), _mel = new THREE.Vector3(), _mae = new THREE.Vector3();
const _mm = new THREE.Matrix4(), _mqD = new THREE.Quaternion(), _mqE = new THREE.Quaternion(), _mqI = new THREE.Quaternion();
// hover (flight modes)
const _h1 = new THREE.Vector3(), _h2 = new THREE.Vector3(), _h3 = new THREE.Vector3(), _h4 = new THREE.Vector3(), _h5 = new THREE.Vector3();
const _h6 = new THREE.Vector3(), _h7 = new THREE.Vector3(), _h8 = new THREE.Vector3(), _h9 = new THREE.Vector3(), _h10 = new THREE.Vector3();
const _hm = new THREE.Matrix4(), _hqD = new THREE.Quaternion(), _hqE = new THREE.Quaternion(), _hqI = new THREE.Quaternion();

function makeSurface(kind, side = 0) {
  return { kind, side, r: new THREE.Vector3(), s: new THREE.Vector3(), c: new THREE.Vector3(), n: new THREE.Vector3(),
    rPrev: new THREE.Vector3(), rDot: new THREE.Vector3(), chord: 1, width: 1, area: 0, valid: false, stalled: false,
    alpha: 0, force: new THREE.Vector3(), cl: 0 };
}

export class FlightBody {
  constructor(specIn = DRAGON_SPECS.hero, opts = {}) {
    this.spec = specIn;
    const s = specIn.scale;
    this.scale = s;
    this.mass = specIn.mass;
    this.geom = buildGeometry(s);
    this.substeps = opts.substeps ?? 2;

    // Public state (world, SI).
    this.pos = new THREE.Vector3(...(opts.pos || [0, 1500, 0]));
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.angVel = new THREE.Vector3();          // world rad/s
    this.L = new THREE.Vector3();               // world angular momentum
    this.prevPos = this.pos.clone();
    this.prevQuat = this.quat.clone();
    this.controls = { pitch: 0, roll: 0, yaw: 0, flap: 0.5, boost: 0, glide: 0, dive: 0, flare: 0, load: 0, hard: 0, skid: 0,
      breath: 0, fireball: 0, dodge: 0, beat: 0, wingover: 0, loop: 0, dash: 0, hover: 0 };
    // Hover (flight modes): controls.hover 0..1 (written by hoverSteer(); 0 = fly with steer() as before — AI dragons
    // never set it). The controller's command, position hold, integrator and the low-passed wing lift along the lift axis.
    this._hcmd = null;
    this._hold = { on: false, p: new THREE.Vector3() };
    this._hvI = new THREE.Vector3();
    this._hvLift = 0; this._strafeT = 0; this._strafeSide = 0; this._strafePay = false; this._strafeGapT = 1e9; this._hvOut = null;
    // Flight moves (wave 6): edges controls.wingover (−1 left | +1 right), controls.loop (±1: side of the half roll),
    // controls.dash (1), or startMove(name, side). onMove(name, side, phase 'start' | 'end', info) reports them.
    this._move = null;                           // running wingover / loop (see _moveStep)
    this._dash = null;                           // running dash thrust pulse
    this._moveQ = null;                          // queued request { name, side, age }
    this._moveCd = { turn: 0, dash: 0 };         // s until the next wingover / loop, dash
    this.onMove = null;
    this.stamina = 1;
    this.onBeat = null;                          // (strength 0..1, body) at the start of each downstroke
    this.onCrash = null;                         // ({ impact, speed, point, normal }, body)

    // Wing kinematics state.
    this.prm = defaultParams();
    this.pose = createPose();
    this._sections = [makeSections(), makeSections()];
    this._wingStrips = [makeStrips(), makeStrips()];
    this.surfaces = [];
    for (let side = 0; side < 2; side++) for (let i = 0; i < STRIPS_PER_WING; i++) this.surfaces.push(makeSurface('wing', side === 0 ? 1 : -1));
    this.bodyStrip = makeSurface('body');
    this.htail = makeSurface('htail');
    this.vtail = makeSurface('vtail');
    this.neck = makeSurface('neck');
    this.surfaces.push(this.bodyStrip, this.htail, this.vtail, this.neck);
    this._initFixedSurfaces();

    // Blend state (critically-damped targets for the pose parameters).
    this._b = { a: 1, amp: 26 * DEG, freq: 1.3, tuck: 0, flare: 0, beat: 0, down: 0.56 };
    this._phase = 0;
    this._act = { roll: 0, pitch: 0, yaw: 0, pitchI: 0, skid: 0 };
    this._Ib = new THREE.Matrix3();
    this._IbInv = new THREE.Matrix3();
    this._wb = new THREE.Vector3();             // body-frame angular velocity
    this._prog = null;                           // scripted stroke (power beat / dodge)
    this._hop = null;                            // dodge hop (lateral shove, bank schedule)
    this._dodgeQ = null;                         // queued dodge request { dir, age } (wave 5)
    this._groundT = 0; this._beatT = 1e9;        // s in ground contact / since the last power beat
    this.autoTakeoff = true;                     // false: stay down on the ground (a pilot may set it, e.g. dead)
    this._staminaIdle = 1;
    this._crashCd = 0;
    this._extF = new THREE.Vector3();
    this._extT = new THREE.Vector3();
    this._clMean = 0.4;
    this._nFilt = 1; this._nSlow = 1;
    this._pilotI = 0; this._speedI = 0; this._nI = 0;
    this._env = DEFAULT_ENV;

    this.state = {
      airspeed: 0, aoa: 0, sideslip: 0, gLoad: 1, lift: 0, drag: 0, thrust: 0, flapPhase: 0, flapRate: 0, flapAmp: 0,
      stamina: 1, pose: this.pose, mode: 'cruise', stalled: 0, power: 0, bank: 0, pitch: 0, heading: 0, climb: 0,
      agl: 1e9, dodging: 0, beating: 0, crash: 0, span: 0, area: 0, AR: 0, beatCount: 0,
    };
    this._calibrateCached('default');
    this.reset(this.pos, opts.heading ?? 0, opts.speed ?? specIn.pilot.cruise);
  }

  /**
   * Use a rig's own bind-pose wing layout (LEFT wing, body frame, metres) so the aero strips match the visible
   * membrane exactly. g: { shoulder, elbow, wrist, hand: [x,y,z], fingerTips: [[x,y,z] x4] (or fingers in
   * WING_GEOMETRY form), rootTE?: [x,y,z] } — missing keys keep the defaults. absolute: positions are final (not
   * multiplied by spec.scale). Rebuilds the strips, inertia and calibrations; keeps position and velocity.
   */
  setWingGeometry(g, { absolute = true } = {}) {
    const a = (v) => (v && v.isVector3 ? [v.x, v.y, v.z] : v);
    const merged = { ...WING_GEOMETRY };
    for (const k of ['shoulder', 'elbow', 'wrist', 'hand', 'rootTE']) if (g[k]) merged[k] = a(g[k]);
    if (g.fingers) merged.fingers = g.fingers;
    if (g.fingerTips) {
      const H = merged.hand;
      merged.fingers = g.fingerTips.map((t) => { t = a(t); const dx = t[0] - H[0], dz = t[2] - H[2]; return [Math.atan2(dz, dx) / DEG, Math.hypot(dx, dz), t[1] - H[1]]; });
    }
    if (g.teScallop != null) merged.teScallop = g.teScallop;
    const pos = this.pos.clone(), vel = this.vel.clone(), quat = this.quat.clone(), L = this.L.clone();
    this.geom = buildGeometry(absolute ? 1 : this.scale, merged);
    for (const s of this.surfaces) s.valid = false;
    this._geomKey = JSON.stringify([merged, absolute ? 1 : this.scale]);
    this._hvCal = null;                                  // (the hover calibration follows the new wing, see _hoverCal)
    this._calibrateCached(this._geomKey);
    this.pos.copy(pos); this.vel.copy(vel); this.quat.copy(quat); this.L.copy(L);
    this._updatePose(0); this._massProps();
    return this.geom;
  }

  /** Place the body level at pos, heading (rad, 0 = +Z, positive toward +X), flying at speed. */
  reset(pos, heading = 0, speed = this.spec.pilot.cruise) {
    this.pos.copy(pos);
    this.quat.setFromAxisAngle(Y, heading);
    this.vel.set(Math.sin(heading) * speed, 0, Math.cos(heading) * speed);
    this.L.set(0, 0, 0); this.angVel.set(0, 0, 0); this._wb.set(0, 0, 0);
    this.prevPos.copy(this.pos); this.prevQuat.copy(this.quat);
    for (const s of this.surfaces) s.valid = false;
    this._prog = null; this.prm.prog.w = 0; this._hop = null; this._dodgeQ = null;
    this._endTurn('reset'); this._endDash('reset');
    this._move = null; this._dash = null; this._moveQ = null; this._moveCd = { turn: 0, dash: 0 }; this.prm.cup = 0; this._b.cup = 0;
    this._act.pitchI = 0; this._act.skid = 0; this.controls.skid = 0;
    this._groundT = 0; this._beatT = 1e9; this._crashCd = 0; this._takeoffT = 0;
    this.state.airspeed = speed; this.state.aoa = 0; this.state.stalled = 0;
    // a respawn is a fresh start (wave 4, critic bugs #10): the wing blend (dive tuck, flare, beat), the muscle lags and
    // the pilot's integrators forget the flight before — a Ctrl dive or a death spiral is not carried into the title
    // glide or the next run
    const b = this._b, P = this.prm;
    Object.assign(b, { a: 1, amp: 26 * DEG, freq: 1.3, tuck: 0, flare: 0, beat: 0, down: this.spec.flap.down, hover: 0 });
    P.a = b.a; P.amp = b.amp; P.freq = b.freq; P.tuck = 0; P.flare = 0; P.beat = 0; P.down = b.down; P.load = 1; P.hover = 0; P.hoverPitch = 0;
    this._hold.on = false; this._hvI.set(0, 0, 0); this._hvLift = 0; this._strafeT = 0; this._strafeSide = 0; this._strafePay = false; this._strafeGapT = 1e9; this._hvOut = null; this._hvU = 0; this._hvCyc = null; this._hvV = null; this._hvVr = null;
    if (this._hcmd) { this._hcmd.vel.set(0, 0, 0); this._hcmd.strafe = 0; this._hcmd.climb = 0; this._hcmd.fwd = 0; }
    for (const w of [P.L, P.R]) { w.twist = 0; w.elev = 0; w.fold = 0; w.sweep = 0; }
    this._act.roll = 0; this._act.pitch = 0; this._act.yaw = 0;
    this._speedI = 0; this._nI = 0; this._pilotI = 0; this._stallI = 0; this._stallSlow = 0; this._recover = 0;
    this._nFilt = 1; this._nSlow = 1; this._rollRef = NaN; this._rollRefAge = 1e9; this._phaseRate = b.freq;
    Object.assign(this.controls, { dive: 0, flare: 0, boost: 0, beat: 0, dodge: 0, hard: 0, load: 0, wingover: 0, loop: 0, dash: 0, hover: 0 });
    // two pose samples so the strip velocities are valid from the very first step
    const h0 = 1 / 240;
    this._phase -= this._b.freq * h0; this._updatePose(0);
    this._phase += this._b.freq * h0; this._updatePose(h0);
    this._massProps();
    return this;
  }

  _initFixedSurfaces() {
    const a = this.spec.aero, s = this.scale;
    const b = this.bodyStrip;
    b.r.set(...a.bodyStrip.pos).multiplyScalar(s); b.area = a.bodyStrip.area * s * s; b.chord = 2.6 * s; b.width = b.area / b.chord;
    const ib = a.bodyStrip.incidence * DEG;
    b.s.set(1, 0, 0); b.c.set(0, -Math.sin(ib), -Math.cos(ib)); b.n.crossVectors(b.s, b.c);
    const h = this.htail; h.r.set(...a.htail.pos).multiplyScalar(s); h.area = a.htail.area * s * s;
    h.chord = Math.sqrt(h.area / a.htail.ar); h.width = h.area / h.chord;
    const v = this.vtail; v.r.set(...a.vtail.pos).multiplyScalar(s); v.area = a.vtail.area * s * s;
    v.chord = Math.sqrt(v.area / a.vtail.ar); v.width = v.area / v.chord;
    const n = this.neck; n.r.set(...a.neck.pos).multiplyScalar(s); n.area = a.neck.area * s * s; n.chord = 2.5 * s; n.width = n.area / n.chord;
    n.s.set(0, 1, 0); n.c.set(0, 0, -1); n.n.set(1, 0, 0);
    for (const x of [b, h, v, n]) x.rDot.set(0, 0, 0);
  }

  // -------------------------------------------------------------------------------------------------------------
  // Mixer: controls -> stroke parameters and control-surface deflections (with a muscle lag).
  // -------------------------------------------------------------------------------------------------------------
  _mix(dt) {
    const c = this.controls, sp = this.spec, fl = sp.flap, ct = sp.control, b = this._b, st = this.state;
    const V = Math.max(st.airspeed, 1);

    // Ground: resting on the ground / water for a moment is never a state — the dragon springs back up (flare +
    // power stroke), whatever the pilot holds (a Ctrl dive held into a valley pinned it there for minutes).
    const canLift = this.autoTakeoff !== false && !this.dead;
    const grounded = canLift && this._groundT > (sp.ground?.takeoffAfter ?? 0.25);
    // the take-off program holds for `climbOut` s after the last ground contact (a held Ctrl must not pin it again)
    // (and it does not run out below 8 m AGL: a held Ctrl cannot push it back down into a skim along the ground)
    const low = (this.state.agl ?? 1e9) < 8 * this.scale;
    this._takeoffT = grounded ? (sp.ground?.climbOut ?? 1.2) : canLift ? Math.max(0, (this._takeoffT || 0) - (low ? 0 : dt)) : 0;
    const takeoff = this._takeoffT > 0;
    // (power beats on the ground and while still slower than 1.2 × the stall speed; they cost no stamina)
    const slow = takeoff && V < 1.2 * this._stallSpeed();
    if (takeoff) {
      c.dive = 0; c.glide = 0; c.flare = 0; c.boost = 0; c.flap = 1; c.hard = 1;
      if ((grounded || slow) && !this._prog && !this._hop) c.beat = 1;
    }

    // Edges: power beat (Space) and dodge (Q/E), stamina gated. Both run a scripted stroke (see PROGRAMS).
    // Wave 5 (titan owner: "a Q press at 8.85 s only became a roll at 10.85 s"): a dodge request is QUEUED — kept
    // spec.dodgeQueue s (0.25), the latest press wins — instead of being dropped while a scripted stroke runs, and it
    // starts at the first step it is allowed (see _dodgeAllowed): a power beat never blocks it (the player's, or the
    // take-off's automatic ones), a running hop only until its move is covered.
    if (c.dodge) this._dodgeQ = { dir: Math.sign(c.dodge) || 1, age: 0 };
    else if (this._dodgeQ && (this._dodgeQ.age += dt) > (sp.dodgeQueue ?? 0.25)) this._dodgeQ = null;
    // Wave 6 — flight moves: requests are queued like the dodge (spec.moveQueue, the latest press wins).
    if (c.wingover) this._moveQ = { name: 'wingover', side: Math.sign(c.wingover) || 1, age: 0 };
    else if (c.loop) this._moveQ = { name: 'loop', side: Math.sign(c.loop) || 1, age: 0 };
    else if (c.dash) this._moveQ = { name: 'dash', side: 0, age: 0 };
    else if (this._moveQ && (this._moveQ.age += dt) > (sp.moveQueue ?? 0.4)) {
      // (fix pass, critic #5: a request that never got to start is reported, not dropped silently)
      this.state.moveDenied = { name: this._moveQ.name, side: this._moveQ.side, reason: 'busy', stamina: this.stamina };
      this._moveQ = null;
    }
    c.wingover = 0; c.loop = 0; c.dash = 0;
    this._moveCd.turn = Math.max(0, this._moveCd.turn - dt); this._moveCd.dash = Math.max(0, this._moveCd.dash - dt);
    if (takeoff || !canLift) { this._endTurn('ground'); this._endDash('ground'); this._moveQ = null; }
    const dodgeNow = !!this._dodgeQ && this._dodgeAllowed();
    // a dodge breaks out of a wingover / loop (the escape), and a hop brakes any surge: the dash pulse ends with it
    if (dodgeNow) { this._endTurn('dodge'); this._endDash('dodge'); }
    if (dodgeNow || (c.beat && !this._prog && !this._hop && !this._move && !this._dash)) {
      const kind = dodgeNow ? 'dodge' : 'beat';
      const cost = kind === 'dodge' ? sp.stamina.dodgeCost : sp.stamina.beatCost;
      const free = kind === 'beat' && (grounded || slow);
      if (this.stamina >= cost * 0.6 || free) {
        const paid = Math.min(this.stamina, free ? 0 : cost);
        this.stamina = Math.max(0, this.stamina - (free ? 0 : cost));
        this._staminaIdle = 0;
        const dir = kind === 'dodge' ? this._dodgeQ.dir : 1;
        const prevHop = this._hop;
        this._startProg(kind, dir);
        if (kind === 'dodge') this._startHop(dir, PROGRAMS.dodge.strokeAt + this._prog.shift, prevHop);
        else { this._beatT = 0; this._prog.paid = paid; }
      }
      if (kind === 'dodge') this._dodgeQ = null;      // started, or not enough stamina: the request is used up
    } else if (this._moveQ && !takeoff && canLift && this._moveAllowed(this._moveQ.name)) {
      const q = this._moveQ, M = sp.moves?.[q.name];
      this._moveQ = null;
      // (a power beat this move takes over within chordRefund s is the same stroke: its stamina counts, see _startMove)
      const refund = this._chordRefund();
      const slow = M ? this._moveSpeedCheck(q.name, M) : null;
      if (M && !slow && this.stamina + refund >= M.cost * 0.6) this._startMove(q.name, q.side);
      else this.state.moveDenied = { name: q.name, side: q.side, reason: !M ? 'unknown' : slow ? 'speed' : 'stamina', stamina: this.stamina, speed: this.vel.length() };
    }
    c.beat = 0; c.dodge = 0;

    let tuckT = clamp(+c.dive || 0, 0, 1);            // dive may be partial (stoop entry: wings half open)
    let boosting = c.boost > 0.5 && this.stamina > 0.02 && tuckT < 0.5;
    let flareT = clamp(+c.flare || 0, 0, 1) * (1 - tuckT);
    let glideT = (c.glide > 0.5 && !boosting) || tuckT > 0.3 ? 1 : 0;
    let effort = clamp(c.flap, 0, 1);
    // W, "beat harder": above the cruise effort range (faster, deeper strokes), below the boost, no stamina
    let hard = boosting ? 0 : clamp(+c.hard || 0, 0, 1) * (1 - tuckT);
    // Wave 6: a wingover / loop / dash shapes the wings itself (the keys and steer()'s speed logic wait until it ends)
    const mv = this._move, ds = this._dash;
    const mw = mv || ds ? this._moveWings(mv, ds) : null;
    if (mw) { tuckT = mw.tuck; boosting = false; flareT = 0; glideT = mw.a < 0.5 ? 1 : 0; effort = 1; hard = mw.hard * (1 - tuckT); }
    // Hover (flight modes): controls.hover blends the hover stroke and controller in (see spec.hover, _hoverStep). Not
    // while a wingover / loop flies (they need speed and fly their own program), dead, or in the automatic take-off.
    const HS = sp.hover;
    const hvT = HS && !mv && canLift && !takeoff ? clamp(+c.hover || 0, 0, 1) : 0;
    b.hover = (b.hover || 0) + (hvT - (b.hover || 0)) * damp(hvT > (b.hover || 0) ? HS?.blendIn ?? 2.5 : HS?.blendOut ?? 1.8, dt);
    if (b.hover < 1e-4 && hvT === 0) b.hover = 0;
    const hw = b.hover;
    if (hw > 0) {
      tuckT *= 1 - hw; flareT *= 1 - hw; hard *= 1 - hw;
      if (hw > 0.5) { glideT = 0; boosting = false; }
    }

    // Targets.
    let fT = lerp(fl.fMin, fl.fMax, effort), ampT = lerp(fl.ampMin, fl.ampMax, effort) * DEG;
    if (hard > 0) { fT = lerp(fT, fl.fHard ?? 1.9, hard); ampT = lerp(ampT, (fl.ampHard ?? 36) * DEG, hard); }
    let aT = mw ? mw.a : glideT ? 0 : 1;
    // Banked glide under load: shallow pumping strokes instead of rigid planks (birds keep working the wing in a
    // hard gliding turn); scales in from 1.4 g, full (30 % amplitude) at 2.4 g. Not in the dive tuck.
    const pump = glideT && tuckT < 0.3 ? (fl.pump ?? 0.3) * smoothstep(1.4, 2.4, this._nSlow) : 0;
    if (pump > 0) aT = Math.max(aT, pump);
    let downT = fl.down, beatW = 0;
    if (boosting) { fT = fl.fBoost; ampT = fl.ampBoost * DEG; aT = 1; }
    if (flareT > 0) { aT = Math.max(aT * (1 - flareT), flareT * 0.75); fT = lerp(fT, 1.25, flareT); ampT = lerp(ampT, 30 * DEG, flareT); }
    if (hw > 0) {
      // the hover stroke: faster and deeper with the thrust the controller asks for (a climb, the start of a strafe),
      // lighter when it sinks (stroke command u, see _hoverStep)
      const u = this._hvOut?.u ?? 0;
      fT = lerp(fT, HS.freq * (1 + HS.fK * u), hw); ampT = lerp(ampT, HS.amp * (1 + HS.aK * u) * DEG, hw); aT = lerp(aT, 1, hw);
    }
    // Air brake: above diveMax the dive tuck opens and the legs come down.
    const brake = tuckT * smoothstep(sp.diveMax - 7, sp.diveMax + 1, V);
    let tuckEff = tuckT * (1 - 0.75 * brake);
    const pr = this._prog;
    let progW = 0;
    if (pr) {
      pr.t += dt;
      const d = pr.def, j = pr.j;
      const tS = pr.t - pr.shift;          // script time after the anticipation
      // (a script that took the wings over mid-stroke starts from the blend weight of the one it replaced)
      const wIn = smoothstep(0, d.wIn, pr.t);
      progW = (j ? j.w + (1 - j.w) * wIn : wIn) * (1 - smoothstep(d.wOut[0], d.wOut[1], tS));
      const outerL = pr.dir > 0;   // dodge right -> the left wing is the outer (rising) wing
      evalProgram(outerL ? d.outer : d.inner, pr, this.prm.L.prog, j?.L);
      evalProgram(outerL ? d.inner : d.outer, pr, this.prm.R.prog, j?.R);
      // (after a hand-over the stroke-plane tilt and the pronation gains ease across in ~0.05 s instead of jumping)
      const PP = this.prm.prog, kj = j ? damp(30, dt) : 1;
      PP.kffDown += (d.kffDown - PP.kffDown) * kj; PP.kffUp += (d.kffUp - PP.kffUp) * kj;
      PP.tilt += ((d.tilt ?? 14) * DEG - PP.tilt) * kj;
      // leave the program at the bottom of a regular stroke, so the blend back never pops
      if (!pr.phased && tS >= d.wOut[0]) { pr.phased = true; this._phase = Math.floor(this._phase) + b.down + 0.08; }
      if (!pr.beatSent && tS >= d.strokeAt) {
        pr.beatSent = true; this.state.beatCount++;
        try { this.onBeat?.(1, this); } catch (e) { /* listeners must not break physics */ }
      }
      tuckEff = 0; aT = Math.max(aT, 0.6); beatW = progW;
      if (tS >= d.wOut[1]) this._prog = null;
    }
    this.prm.prog.w = progW;
    this._rollRefAge = (this._rollRefAge ?? 1e9) + dt;   // steer()'s roll ramp: time since the pilot last steered
    // Blend (critically damped exponential chase; frequency eases so the phase never pops).
    const k = (x) => damp(x, dt);
    b.a += (aT - b.a) * k(aT > b.a ? 5 : 3.2);
    b.amp += (ampT - b.amp) * k(3.5);
    b.freq += (fT - b.freq) * k(2.5);
    b.tuck += (tuckEff - b.tuck) * k(tuckEff > b.tuck ? 2.9 : 2.0);
    b.flare += (flareT - b.flare) * k(4);
    b.beat += (beatW - b.beat) * k(10);
    b.down += (downT - b.down) * k(8);
    b.cup = (b.cup || 0) + ((mw ? mw.cup : 0) - (b.cup || 0)) * k(6);

    // Rate commands (body frame): roll right +, pitch up +, yaw right +.
    let pCmd = clamp(c.roll, -1.4, 1.4) * ct.pMax;     // |roll| ≤ 1 for sticks; the shaped pilot may ask up to 1.4
    let qCmd = clamp(c.pitch, -1, 1) * ct.qMax;
    let rCmd = clamp(c.yaw, -1, 1) * ct.rMax;
    const p = this._wb.z, q = -this._wb.x, r = -this._wb.y;
    // Flare: pitch toward a high angle of attack, limited by the braking g.
    if (b.flare > 0.05) {
      const decelG = Math.max(0, st.drag / (this.mass * G0));
      // limited by the braking g AND by the load factor (a flare at speed must not become a 6 g pull)
      let aoaT = lerp(42, 20, smoothstep(sp.flareMaxG * 0.7, sp.flareMaxG * 1.1, decelG)) * DEG;
      aoaT = Math.min(aoaT, lerp(40, 6, smoothstep(2.2, 3.4, this._nSlow)) * DEG);
      qCmd = lerp(qCmd, clamp(2.2 * (aoaT - st.aoa), -ct.qMax, ct.qMax), b.flare);
    }
    // Take-off from the ground: nose up to a climbing attitude while the wings beat.
    if (takeoff) qCmd = clamp(3 * (22 * DEG - st.pitch), -ct.qMax, ct.qMax);
    const burst = this._burstF || (this._burstF = new THREE.Vector3());
    burst.set(0, 0, 0);
    // Hover (see _hoverStep): the lift axis turned along the wanted acceleration + g, the heading onto the aim, and the
    // hover-assist force along the body's lift axis; blended with whatever flew before by the hover weight.
    this.prm.hoverPitch = 0;
    if (hw > 0 && this._hcmd) {
      const hc = this._hoverStep(dt, burst, hw);
      if (hc) {
        pCmd = lerp(pCmd, hc.p, hw); qCmd = lerp(qCmd, hc.q, hw); rCmd = lerp(rCmd, hc.r, hw);
        this.prm.hoverPitch = hc.pOff * hw;
        if (hw > 0.5) this._rollRefAge = 1e9;          // afterwards steer()'s roll ramp restarts from the body's rate
      }
    } else if (this._hvOut) { this._hvOut.demand = 1; this._hvOut.assist = 0; this._hvOut.wings = 0; this._hvOut.u = 0; this._hold.on = false; this._hvCyc = null; this._hvU = 0; }
    // Dodge hop (see _hopStep): a quick bank toward the side and back, the lateral shove as a bounded force.
    const hop = this._hop;
    if (hop) {
      const cmd = this._hopStep(dt, burst);
      // attitude hold: the nose stays on its entry direction (heading AND pitch) while the body slides sideways, the
      // bank follows the hop's schedule; world rate demand -> body rates (roll right +w.z, pitch up −w.x, yaw right −w.y)
      const f = _fw.set(0, 0, 1).applyQuaternion(this.quat);
      const wDes = _tq.crossVectors(f, hop.nose).multiplyScalar(this.spec.dodgeHop.kNose ?? 9);
      wDes.addScaledVector(f, cmd.rate + 9 * wrapPi(cmd.bank - this._bankNow()));
      _qi.copy(this.quat).invert(); wDes.applyQuaternion(_qi);
      pCmd = clamp(wDes.z, -ct.pMax * 2.8, ct.pMax * 2.8);
      qCmd = clamp(-wDes.x, -ct.qMax * 1.5, ct.qMax * 1.5);
      rCmd = clamp(-wDes.y, -ct.rMax * 2, ct.rMax * 2);
      this._rollRefAge = 1e9;                        // after the hop steer()'s roll ramp restarts from the body's rate
    }
    // Power beat: the big downstroke's lift, lumped at the CG as a bounded vertical pulse (sin² over T from the
    // start of the downstroke), so the climb burst is felt within ~0.1 s of the key.
    if (pr && pr.kind === 'beat' && sp.beatBurst) {
      const B = sp.beatBurst, u = (pr.t - Math.max(0, pr.def.strokeAt + pr.shift - (B.lead || 0))) / B.T;
      if (u > 0 && u < 1) { const s1 = Math.sin(Math.PI * u); burst.y += this.mass * G0 * B.g * s1 * s1; }
    }
    // Wave 6 — flight moves: the move's own pilot program (rate demand -> body rates, lift top-up along the body's lift
    // axis) and the dash's thrust pulse along the path; bounded forces for the integrator (see _moveStep / _dashStep).
    if (this._move) {
      const cmd = this._moveStep(dt, burst);
      pCmd = cmd.p; qCmd = cmd.q; rCmd = cmd.r;
      this._rollRefAge = 1e9;                        // afterwards steer()'s roll ramp restarts from the body's rate
    }
    if (this._dash) this._dashStep(dt, burst);
    // Turn entry side force (controls.skid, see spec.control.skidG): level, perpendicular to the flight path, through
    // the muscle lag; off during the scripted strokes, the dodge hop, the moves and the take-off.
    const skT = pr || hop || takeoff || mv || ds ? 0 : clamp(+c.skid || 0, -1, 1);
    this._act.skid += (skT - this._act.skid) * damp(1 / ct.muscleTau, dt);
    if (Math.abs(this._act.skid) > 1e-4 && ct.skidG) {
      const vx = this.vel.x, vz = this.vel.z, vh = Math.hypot(vx, vz);
      if (vh > 5) {
        const f = this.mass * G0 * ct.skidG * this._act.skid * Math.min(1.5, (V * V) / (34 * 34)) / vh;
        burst.x -= vz * f; burst.z += vx * f;       // level right of the path = (−v.z, 0, v.x) / |v_h|
      }
    }
    this._cmd = { p: pCmd, q: qCmd, r: rCmd };

    // Inner loops -> wing/tail actuators (normalised -1..1), then the muscle lag.
    // (hover: no airflow — the wing deflections keep their cruise-size gains instead of the low-speed boost, and the
    //  pitch integrator bleeds off: the assist holds the attitude, the wings only trim)
    const qs = lerp(clamp((V * V) / (32 * 32), 0.25, 3), 1, hw);
    const uRoll = clamp((0.45 * pCmd / ct.pMax) + 0.35 * (pCmd - p), -1, 1);
    this._act.pitchI = clamp(this._act.pitchI + (qCmd - q) * dt * 1.2 * (1 - hw), -0.8, 0.8) * (1 - damp(3, dt) * hw);
    const uPitch = clamp(0.6 * (qCmd - q) + this._act.pitchI + 0.3 * qCmd / ct.qMax, -1, 1);
    const uYaw = clamp(0.8 * (rCmd - r) + 0.3 * rCmd / ct.rMax, -1, 1);
    const km = damp(1 / ct.muscleTau, dt);
    this._act.roll += (uRoll - this._act.roll) * km;
    this._act.pitch += (uPitch - this._act.pitch) * km;
    this._act.yaw += (uYaw - this._act.yaw) * km;
    const ur = this._act.roll, up = this._act.pitch, uy = this._act.yaw;

    const P = this.prm;
    P.a = b.a; P.amp = b.amp; P.freq = b.freq; P.tuck = b.tuck; P.flare = b.flare; P.beat = b.beat;
    P.down = b.down; P.snap = fl.snap;
    P.airspeed = V;
    P.psi0 = 0;
    // Wing load (g, filtered) bends the wings up; the soaring clock drives the slow gliding adjustments (wingkin).
    P.load = clamp(this._nFilt, -1, 4.5);
    P.soarT = (P.soarT || 0) + dt;
    // Load hold (controls.load 0..1, the pilot asks for more lift): the wings stay spread and loaded through the
    // upstroke, so a pull does not sag every half beat (a turn starts at any stroke phase)
    const loadHold = Math.max(clamp(+c.load || 0, 0, 1), mw ? mw.load : 0);
    P.fold = fl.fold * (1 - (fl.loadFold ?? 0.45) * loadHold);
    const twistEff = boosting ? 1 : Math.max(effort, hard);
    P.twistD = lerp(fl.twistD[0], fl.twistD[1], twistEff) * DEG + (pr ? pr.def.twist * DEG * progW : 0);
    P.twistU = fl.twistU * DEG * (1 - (fl.loadUnload ?? 0.6) * loadHold);
    // ... and the upstroke is hurried (the next downstroke, where the lift is, comes sooner)
    const ph = this._phase - Math.floor(this._phase);
    const upW = smoothstep(b.down, b.down + 0.06, ph) * (1 - smoothstep(0.94, 1, ph));
    this._phaseRate = b.freq * (1 + (fl.loadHurry ?? 0.8) * loadHold * upW * clamp((b.a - 0.4) / 0.4, 0, 1) * (pr ? 0 : 1));
    P.freq = this._phaseRate;
    P.kff = fl.kff;
    P.sweep0 = -5 * DEG + up * ct.sweepPitch / Math.sqrt(qs);
    P.camber = 0.55 + 0.3 * b.flare;
    P.cup = b.cup || 0;                              // wave 6: the membranes cupped / biting the air in a move's pull
    P.hover = hw;                                    // flight modes: the hover stroke (wingkin HOVER)
    P.hoverKff = hw > 0 ? this._hoverCal().kff : null;    // (its pronation, calibrated for this wing)
    // Roll: the rising wing supinates, the inside wing pronates, rises and folds a little.
    // (the dodge is a deliberate tuck-roll: it keeps the strong inner-wing fold / rise of the original tuning)
    const dodgeRoll = !!hop || (!!pr && pr.kind === 'dodge') || (!!mv && mv.phase === 'roll');   // (+ the Immelmann's half roll)
    const elevD = dodgeRoll ? ct.dodgeElevDiff ?? 6 * DEG : ct.elevDiff, foldD = dodgeRoll ? ct.dodgeFoldDiff ?? 0.35 : ct.foldDiff;
    const twd = ur * (dodgeRoll ? ct.dodgeTwistDiff ?? ct.twistDiff : ct.twistDiff) / Math.sqrt(qs);
    P.L.twist = twd; P.R.twist = -twd;
    P.L.elev = -ur * elevD; P.R.elev = ur * elevD;
    P.L.fold = Math.max(0, -ur) * foldD; P.R.fold = Math.max(0, ur) * foldD;
    P.L.sweep = uy * ct.sweepYaw; P.R.sweep = -uy * ct.sweepYaw;
    this._elevator = clamp(-up * ct.elevator / Math.sqrt(qs) + this._trimElev, -30 * DEG, 30 * DEG) - b.flare * 12 * DEG;
    this._rudder = uy * ct.rudder / Math.sqrt(qs);
    this._tailSpread = 1 + 0.4 * b.flare - 0.35 * b.tuck;
    this._legs = Math.max(b.flare, brake);
    this._brake = brake;
    st.mode = mv ? mv.name : ds ? 'dash' : pr ? pr.kind : hop ? 'dodge' : hw > 0.5 ? 'hover' : b.tuck > 0.5 ? 'dive' : b.flare > 0.5 ? 'flare' : boosting ? 'boost'
      : hard > 0.5 && !glideT ? 'hard' : glideT || b.a < 0.3 ? 'glide' : 'cruise';
    st.hover = hw;
    this._boosting = boosting;
    this._effort = effort;
  }

  /** Bank about the flight path (rad, + = right wing down), from the current attitude. */
  _bankNow() {
    _fw.set(0, 0, 1).applyQuaternion(this.quat);
    _up.set(0, 1, 0).applyQuaternion(this.quat);
    _rt.set(-1, 0, 0).applyQuaternion(this.quat);
    return Math.atan2(-_rt.y, _up.y);
  }

  /** AoA (rad) for a load factor n at airspeed V through the calibrated lift curves (glide ↔ flapping blend). */
  _aoaForLoad(n, V) {
    const qd = 0.5 * (this._rho || 1.1) * V * V;
    const clDes = (n * this.mass * G0) / Math.max(qd * this._area, 1);
    const fa = clamp(this._b.a, 0, 1), cf = this.cal.flap;
    const cl0 = lerp(this.cal.cl0, cf.cl0, fa), slope = lerp(this.cal.slope, cf.slope, fa);
    const aStall = lerp(this.cal.aoaStall, cf.aoaStall, fa);
    return clamp((clDes - cl0) / Math.max(slope, 0.5), -8 * DEG, aStall - 2 * DEG);
  }

  /**
   * Dodge = a clean lateral HOP that keeps the heading (wave 4; before it was an ~80° knife-edge jink that turned the
   * course ~30° and surged +25 m/s). The body slides D metres sideways along a minimum-jerk profile over T seconds
   * (starting with the outer wing's stroke), nose held on the heading, then stops sideways; any forward surge from
   * the strokes is braked. The shove is lumped at the CG as a bounded force (feed-forward of the profile + a PD on
   * the lateral offset / speed, |a| ≤ gMax g): a force for the integrator, never a position or velocity write.
   */
  _startHop(dir, t0, prev = null) {
    const H = this.spec.dodgeHop;
    if (!H) { this._hop = null; return; }
    let fwd;
    if (prev) fwd = prev.fwd.clone();
    else {
      fwd = new THREE.Vector3(this.vel.x, 0, this.vel.z);
      if (fwd.lengthSq() < 1) fwd.set(0, 0, 1).applyQuaternion(this.quat).setY(0);
      if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1);
      fwd.normalize();
    }
    const lat = new THREE.Vector3().crossVectors(fwd, Y).multiplyScalar(dir).normalize();   // fwd × up = right
    const ts = Math.max(0, t0 * (H.lag ?? 0.5));
    // a hop chained onto the end of another (wave 5) keeps its course: the same forward axis, nose, entry speed, climb
    // rate and lateral baseline, so the old hop's last metre per second is braked, not kept as a drift
    this._hop = {
      dir, fwd, lat, t: 0, t0: ts, T: H.T, D: H.D, y: 0, z: 0, bank0: this._bankNow(),
      vLat0: prev ? prev.vLat0 * prev.lat.dot(lat) : this.vel.dot(lat), V0: prev ? prev.V0 : this.vel.dot(fwd),
      vy0: prev ? prev.vy0 : this.vel.y,
      nose: prev ? prev.nose.clone() : new THREE.Vector3(0, 0, 1).applyQuaternion(this.quat),
      left: ts + (H.invulnAt ?? 0.8) * H.T,
    };
  }

  /** A queued dodge may start now: nothing scripted runs, or only a power beat (the dodge takes the wings over
   *  mid-stroke), or the running hop has covered its move (state.dodgeLeft is 0: the new hop takes over its settle). */
  _dodgeAllowed() {
    const h = this._hop, pr = this._prog;
    if (h) return h.left === 0;
    return !pr || pr.kind !== 'dodge';
  }

  /** The running script's per-wing stroke and blend weight, for a script that takes the wings over (null: none). */
  _handOver() {
    const w = this.prm.prog.w, L = this.prm.L.prog, R = this.prm.R.prog;
    if (!(w > 0.02)) return null;
    return { w, L: { psi: L.psi, psiDot: L.psiDot, fold: L.fold }, R: { psi: R.psi, psiDot: R.psiDot, fold: R.fold } };
  }

  /** Forget a queued dodge request (e.g. the pilot lost control: grabbed). */
  cancelDodge() { this._dodgeQ = null; }

  /** Start a scripted stroke (PROGRAMS[kind]); the anticipation adapts to where the wing is, and a script that is
   *  already running hands the wings over (per-wing Hermite from its position and rate, see evalProgram). */
  _startProg(kind, dir = 1) {
    const P0 = this.prm, def = PROGRAMS[kind];
    // where the wing is: the regular stroke, or — when the script takes over a running one — that script's blend
    const reg = P0.psi0 + strokeElevation(this.pose.stroke, P0.a, P0.amp * (1 + 0.25 * P0.beat));
    const j = this._prog ? this._handOver() : null;
    const outer = j ? (dir > 0 ? j.L : j.R) : null;
    const psi0 = j ? reg + (outer.psi - reg) * j.w : reg;
    // the anticipation takes as long as the wing needs at def.rate (rad/s), never less than def.antMin nor
    // (power beat) more than def.antMax; the rest of the script shifts with it (a negative shift compresses it)
    const k1 = def.outer[1];
    let need = Math.max(def.antMin ?? k1[0], Math.abs(k1[1] * DEG - psi0) / (def.rate ?? 12));
    if (def.antMax) need = Math.min(need, def.antMax);
    this._prog = {
      kind, def, t: 0, dir, beatSent: false, phased: false, psi0,
      fold0: (this.pose.L.fold + this.pose.R.fold) * 0.5, shift: need - k1[0], j,
    };
    return this._prog;
  }

  // ------------------------------------------------------------------------------------------------ flight moves
  /**
   * Ask for a flight move (wave 6): 'wingover' (side −1 left / +1 right), 'loop' (Immelmann; side = the way of the
   * half roll on top) or 'dash'. Same as the controls edges; queued ≤ spec.moveQueue s while another move / a hop runs.
   * Costs stamina (spec.moves[name].cost; needs 60 % of it) and has a cooldown. AI pilots may use it like the player.
   */
  startMove(name, side = 1) {
    if (!this.spec.moves?.[name]) return false;
    this._moveQ = { name, side: Math.sign(side) || 1, age: 0 };
    return true;
  }

  /** Stop a running move / forget a queued one (the pilot lost control: grabbed, dead). */
  cancelMove() { this._moveQ = null; this._endTurn('cancel'); this._endDash('cancel'); }

  /** The running move (read-only): { name, side, t, phase, u } or null. */
  get move() {
    const m = this._move;
    if (m) return { name: m.name, side: m.side, t: m.t, phase: m.phase, u: m.u };
    const d = this._dash;
    return d ? { name: 'dash', side: 0, t: d.t, phase: 'dash', u: clamp(d.t / (d.t0 + d.T), 0, 1) } : null;
  }

  _moveAllowed(name) {
    if (this.dead) return false;
    // a hop first: the request waits in the queue until the hop has covered its move (fix pass: the queue used to expire
    // before a 0.78 s hop allowed it; now the move takes over the hop's settle, like a chained dodge)
    if (this._hop && this._hop.left > 0) return false;
    if (!this._hop && this._prog?.kind === 'dodge') return false;
    if (name === 'dash') return !this._dash && !this._move && this._moveCd.dash <= 0;
    return !this._move && this._moveCd.turn <= 0;                      // (a dash may run: the move takes its wings over)
  }

  /** Stamina a move gets back when it takes over a power beat started ≤ spec.chordRefund s ago (the same stroke). */
  _chordRefund() {
    const pr = this._prog;
    return pr && pr.kind === 'beat' && pr.t <= (this.spec.chordRefund ?? 0.16) ? pr.paid || 0 : 0;
  }

  /** Too slow for a reversal (below minV) / too fast for a dash to add anything: the reason 'speed', else null. */
  _moveSpeedCheck(name, M) {
    const V = this.vel.length();
    if (name === 'dash') return this._dashGain(V) < (M.dvMin ?? 2) ? 'speed' : null;
    return M.minV && V < M.minV ? 'speed' : null;
  }

  /** The dash's speed gain from V: the full dv up to cruise + vCap − dv, then less, nothing above cruise + vCap. */
  _dashGain(V) {
    const M = this.spec.moves.dash;
    const cap = (this.spec.pilot?.cruise ?? 34) + (M.vCap ?? 1e9);
    return clamp(cap - V, 0, M.dv);
  }

  _startMove(name, side) {
    const M = this.spec.moves[name];
    // a power beat taken over this soon (a chord whose direction key came a moment after Space): the same stroke
    const refund = this._chordRefund();
    if (refund > 0) { this.stamina = Math.min(1, this.stamina + refund); this._prog.paid = 0; this._beatT = 1e9; }
    this.stamina = Math.max(0, this.stamina - M.cost); this._staminaIdle = 0;
    // a hop that has covered its move hands over to the manoeuvre (its settle would fight the move's guidance)
    if (this._hop) this._hop = null;
    const V = this.vel.length();
    if (name === 'dash') {
      const pr = this._startProg('dash', 1);
      // (flight modes: from a hover the dash is a forward burst along the heading — the level nose direction — that
      //  enters flight; at speed it pushes along the flight path as before)
      const dir = V > 8 ? this.vel.clone().multiplyScalar(1 / V) : new THREE.Vector3(0, 0, 1).applyQuaternion(this.quat).setY(0);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
      dir.normalize();
      const V0 = V > 8 ? V : Math.max(0, this.vel.dot(dir));
      this._dash = { t: 0, t0: Math.max(0, PROGRAMS.dash.strokeAt + pr.shift - (M.lead || 0)), T: M.T, dv: this._dashGain(V0), peak: 0, V0, dir, fromHover: V <= 8 };
    } else {
      // The turn plane. Wingover: through the velocity, tilted `tilt`° from vertical toward the side (a level entry
      // exits level with the heading reversed). Loop: the vertical plane of the heading — from a dive it pulls through
      // level and on over the top, so it always ends level and upside down on top (then the half roll).
      const vh = V > 1 ? _m1.copy(this.vel).multiplyScalar(1 / V) : _m1.set(0, 0, 1).applyQuaternion(this.quat);
      const e1h = new THREE.Vector3(vh.x, 0, vh.z);
      if (e1h.lengthSq() < 1e-4) e1h.set(0, 0, 1).applyQuaternion(this.quat).setY(0);
      if (e1h.lengthSq() < 1e-6) e1h.set(0, 0, 1);
      e1h.normalize();
      const right = new THREE.Vector3().crossVectors(e1h, Y);             // fwd × up = right
      const phi = (M.tilt || 0) * DEG;
      const c0 = new THREE.Vector3().copy(Y).multiplyScalar(Math.cos(phi)).addScaledVector(right, side * Math.sin(phi));
      let e1, e2;
      if (name === 'loop') { e1 = e1h; e2 = c0; }
      else {
        e1 = vh.clone();
        e2 = c0.addScaledVector(e1, -c0.dot(e1));
        if (e2.lengthSq() < 1e-4) e2.copy(right).multiplyScalar(side);
        e2.normalize();
      }
      const k = new THREE.Vector3().crossVectors(e1, e2).normalize();     // the path turns about k (e1 → e2)
      const th = Math.atan2(vh.dot(e2), vh.dot(e1));
      this._move = { name, side, t: 0, phase: 'pull', phaseT: 0, e1, e2, k, theta: th, theta0: th, thetaEnd: Math.PI, u: 0,
        V0: V, y0: this.pos.y, minV: V, maxN: 0, maxTop: 0, maxReq: 0 };
      this._startProg('grab', 1);                                          // the big grabbing downstroke as the pull begins
    }
    this.state.moveDenied = null;
    try { this.onMove?.(name, name === 'dash' ? 0 : side, 'start', { speed: V }); } catch (e) { /* listeners must not break physics */ }
  }

  _endTurn(reason) {
    const mv = this._move;
    if (!mv) return;
    this._move = null;
    this._moveCd.turn = this.spec.moves?.[mv.name]?.cooldown ?? 0.5;
    this._rollRefAge = 1e9; this._act.pitchI = 0;
    const info = { reason, t: mv.t, u: mv.u, turned: (mv.theta - mv.theta0) / DEG, dy: this.pos.y - mv.y0, minV: mv.minV,
      maxN: mv.maxN, maxTop: mv.maxTop, speed: this.vel.length() };
    this.state.lastMove = { name: mv.name, side: mv.side, ...info };
    try { this.onMove?.(mv.name, mv.side, 'end', info); } catch (e) { /* listeners must not break physics */ }
  }

  _endDash(reason) {
    const d = this._dash;
    if (!d) return;
    this._dash = null;
    this._moveCd.dash = this.spec.moves?.dash?.cooldown ?? 0.8;
    // no stamina regen for noRegen s after the dash (fix pass: dashes 2 s apart never dipped below 0.77)
    const sm = this.spec.stamina, M = this.spec.moves?.dash;
    if (sm && M?.noRegen) this._staminaIdle = Math.min(this._staminaIdle, sm.delay - M.noRegen);
    const info = { reason, t: d.t, peakG: d.peak, gain: this.vel.length() - d.V0, speed: this.vel.length(), dv: d.dv };
    this.state.lastMove = { name: 'dash', side: 0, ...info };
    try { this.onMove?.('dash', 0, 'end', info); } catch (e) { /* listeners must not break physics */ }
  }

  /** Wing shape of the running move: flap amount a, W-strength strokes, dive tuck, cupped membranes, loaded upstroke. */
  _moveWings(mv, ds) {
    const o = this._mw || (this._mw = { a: 1, hard: 1, tuck: 0, cup: 0, load: 0 });
    o.a = 1; o.hard = 1; o.tuck = 0; o.cup = 0; o.load = 0;
    if (mv) {
      const M = this.spec.moves[mv.name];
      if (mv.phase === 'pull') {
        // the pull: hard strokes, cupped, loaded wings; over the top (after `split` of the turn) the wings stop beating
        // and — in the wingover — half-fold as the nose falls through the horizon
        const early = 1 - smoothstep(M.split - 0.12, M.split + 0.12, mv.u);
        o.a = lerp(0.3, 1, early); o.hard = early; o.cup = (M.cup || 0) * lerp(0.4, 1, early); o.load = early;
        o.tuck = (M.tuck || 0) * (1 - early);
      } else if (mv.phase === 'roll') { o.a = 0; o.hard = 0; o.tuck = M.rollTuck ?? 0.5; }   // tucked: the half roll spins up
      else { o.a = 1; o.hard = 1; o.load = 0.5; }                                          // exit: spread, a strong stroke
    } else if (ds) {
      // after the rowing stroke: swept back and half-folded while the surge lasts
      const M = this.spec.moves.dash, after = ds.t - ds.t0 - ds.T * 0.75;
      if (after > 0) { o.a = 0.25; o.hard = 0; o.tuck = (M.tuck || 0) * (1 - smoothstep(M.streamline * 0.6, M.streamline, after)); }
    }
    return o;
  }

  /**
   * One step of a wingover / loop. Guidance: the velocity turns in the move's plane at a path rate that builds in over
   * rateIn, is capped by the lift budget (nMax g / V) and eases out near the end (brake); a small pull keeps it in the
   * plane. The lift that needs (minus gravity across the path) sets the attitude — the body's up along it, the nose at
   * the angle of attack of the aero share — which the rate demand (path rate + an attitude loop, capped) gives to the
   * bounded assist torque. The wings' lift is topped up ALONG THE BODY'S OWN LIFT AXIS (gMax, only as far as the body is
   * rolled the right way), with its induced drag (ld), so a hard pull bleeds speed and an attitude that is not there yet
   * does not turn the path. Loop: after the half loop a half roll upright (the chosen side), then level. Returns the body
   * rate commands (rad/s) and adds the force (N, world) into `force`.
   */
  _moveStep(dt, force) {
    const mv = this._move, M = this.spec.moves[mv.name], g = G0, m = this.mass, ct = this.spec.control;
    mv.t += dt; mv.phaseT += dt;
    const V = Math.max(this.vel.length(), 0.5);
    const vh = _m1.copy(this.vel).multiplyScalar(1 / V);
    mv.minV = Math.min(mv.minV, V);
    // progress in the plane (continuous angle)
    mv.theta += wrapPi(Math.atan2(vh.dot(mv.e2), vh.dot(mv.e1)) - mv.theta);
    const rem = mv.thetaEnd - mv.theta;
    mv.u = clamp((mv.theta - mv.theta0) / Math.max(1e-3, mv.thetaEnd - mv.theta0), 0, 1);
    const up = _m2.set(0, 1, 0).applyQuaternion(this.quat);
    const lvlUp = _m3.set(0, 1, 0).addScaledVector(vh, -vh.y);
    if (lvlUp.lengthSq() < 1e-4) lvlUp.copy(up).addScaledVector(vh, -up.dot(vh));
    lvlUp.normalize();
    const lvlRt = _m4.crossVectors(vh, lvlUp);
    const bankNow = Math.atan2(up.dot(lvlRt), up.dot(lvlUp));
    // phases: pull (the turn in the plane) → [loop: roll] → exit (wings level + the exit stroke) → done
    if (mv.phase === 'pull' && rem <= M.endTol) { mv.phase = mv.name === 'loop' ? 'roll' : 'exit'; mv.phaseT = 0; if (mv.phase === 'exit') this._exitStroke(mv, M, V); }
    if (mv.phase === 'roll' && (Math.abs(bankNow) < 25 * DEG || mv.phaseT > (M.rollMax ?? 1))) { mv.phase = 'exit'; mv.phaseT = 0; this._exitStroke(mv, M, V); }
    let done = null;
    // (the exit lasts until the wings are level AND the exit stroke's surge is through, bounded)
    const sg = mv.surge, surged = !sg || sg.t >= sg.t0 + sg.T;
    const exitMax = sg ? Math.max(M.exit, sg.t0 + sg.T + 0.05) : M.exit;
    if (mv.phase === 'exit' && ((Math.abs(bankNow) < 12 * DEG && mv.phaseT > 0.12 && surged) || mv.phaseT > exitMax)) done = 'done';
    if (mv.t > M.timeout) done = 'timeout';
    // wanted acceleration across the path (m/s², world)
    const aReq = _m5.set(0, 0, 0);
    let Om = 0;
    const pull = mv.phase === 'pull';
    if (pull) {
      const Ocap = Math.min(M.rate, (M.nMax * g) / V);
      const Oin = M.rate * smoothstep(0, M.rateIn, mv.t);
      const Obr = Math.sqrt(2 * M.brake * Math.max(0, rem));
      Om = Math.max(0, Math.min(Ocap, Oin, Obr));
      const n = _m6.crossVectors(mv.k, vh);
      if (n.lengthSq() > 1e-8) n.normalize();
      aReq.addScaledVector(n, V * Om);
      aReq.addScaledVector(mv.k, -(M.kPlane ?? 4) * V * vh.dot(mv.k));
    } else {
      // roll / exit: straight on, the path eased toward level (≤ 1 g)
      aReq.addScaledVector(lvlUp, clamp(-1.5 * V * Math.asin(clamp(vh.y, -1, 1)), -g, g));
    }
    // lift per kg = wanted − gravity, across the path; the total is bounded by the move's lift budget
    const Lr = aReq; Lr.y += g;
    Lr.addScaledVector(vh, -Lr.dot(vh));
    const lim = (pull ? M.nMax : (M.exitG ?? 1.6)) * g, lr = Lr.length();
    if (lr > lim) Lr.multiplyScalar(lim / lr);
    const nReq = Math.min(lr, lim) / g;
    mv.maxReq = Math.max(mv.maxReq, nReq);
    // attitude wanted: body up along that lift (upright in the roll / exit), the nose at the aero share's AoA
    const uD = _mu.copy(pull && nReq > 0.25 ? Lr : lvlUp);
    if (pull && nReq <= 0.25) uD.copy(up).addScaledVector(vh, -up.dot(vh));
    if (uD.lengthSq() < 1e-8) uD.copy(lvlUp);
    uD.normalize();
    const aoa = mv.phase === 'roll' ? 2 * DEG : this._aoaForLoad(Math.min(nReq, M.aoaN ?? 2.4), V);
    const fD = _mf.copy(vh).multiplyScalar(Math.cos(aoa)).addScaledVector(uD, Math.sin(aoa));
    const uD2 = _mu2.copy(uD).multiplyScalar(Math.cos(aoa)).addScaledVector(vh, -Math.sin(aoa));
    _ml.crossVectors(uD2, fD);                                                // body +X = left = up × forward
    _mm.makeBasis(_ml, uD2, fD);
    _mqD.setFromRotationMatrix(_mm);
    // world-frame rotation from the attitude to the wanted one (shortest way)
    _mqE.copy(_mqD).multiply(_mqI.copy(this.quat).invert());
    if (_mqE.w < 0) { _mqE.x = -_mqE.x; _mqE.y = -_mqE.y; _mqE.z = -_mqE.z; _mqE.w = -_mqE.w; }
    const sh = Math.sqrt(Math.max(0, 1 - _mqE.w * _mqE.w));
    const ang = 2 * Math.atan2(sh, _mqE.w);
    const err = _me2.set(_mqE.x, _mqE.y, _mqE.z).multiplyScalar(sh > 1e-6 ? ang / sh : 2);
    // the Immelmann's half roll goes the chosen way (side), not whichever is shorter from upside down
    if (mv.phase === 'roll' && Math.abs(bankNow) > 100 * DEG) {
      const T2 = Math.PI * 2, want = mv.side > 0 ? (((-bankNow) % T2) + T2) % T2 : -((((bankNow) % T2) + T2) % T2);
      err.addScaledVector(vh, want - err.dot(vh));
    }
    // rate demand (world): the attitude loop (capped; its roll about the path capped by `roll`) + the path's rotation
    const wDes = _mwd.copy(err).multiplyScalar(M.att ?? 10);
    const wl = wDes.length();
    if (wl > (M.attMax ?? 6)) wDes.multiplyScalar((M.attMax ?? 6) / wl);
    const pr = wDes.dot(vh), rMax = M.roll ?? 5;
    if (Math.abs(pr) > rMax) wDes.addScaledVector(vh, Math.sign(pr) * rMax - pr);
    if (Om > 0) wDes.addScaledVector(mv.k, Om);
    wDes.applyQuaternion(_mqI);                                               // body frame (_mqI = q⁻¹)
    const cmd = this._mvCmd || (this._mvCmd = { p: 0, q: 0, r: 0 });
    cmd.p = clamp(wDes.z, -ct.pMax * 2.8, ct.pMax * 2.8);                     // roll right +w.z, pitch up −w.x, yaw right −w.y
    cmd.q = clamp(-wDes.x, -ct.qMax * 3.2, ct.qMax * 3.2);
    cmd.r = clamp(-wDes.y, -ct.rMax * 3, ct.rMax * 3);
    // lift top-up along the body's own lift axis (body up across the path), bounded, with its induced drag
    const ell = _mel.copy(up).addScaledVector(vh, -up.dot(vh));
    const el = ell.length();
    if (el > 0.2) {
      ell.multiplyScalar(1 / el);
      const aero = this._aeroFb ? _mae.copy(this._aeroFb).applyQuaternion(this.quat) : _mae.set(0, 0, 0);
      const have = aero.dot(ell) / m;
      const want = Lr.dot(ell);
      const align = lr > 0.5 * g ? smoothstep(0.25, 0.8, Lr.dot(ell) / Math.max(lr, 1e-6)) : 1;
      const top = clamp((want - have) * align, -(M.gNeg ?? 1) * g, (pull ? M.gMax : 1.5) * g);
      force.addScaledVector(ell, m * top);
      force.addScaledVector(vh, -m * Math.abs(top) / (M.ld || 5));
      mv.maxTop = Math.max(mv.maxTop, Math.abs(top) / g);
      mv.maxN = Math.max(mv.maxN, (have + top) / g);
    }
    // the grabbing strokes must not surge the dragon on: a speed gain over the entry speed (+ slack) is braked by the
    // pulling wings' drag (bounded) — the turn is paid for with speed, never helped by it
    if (pull && M.fwdK) {
      const over = V - mv.V0 - (M.fwdSlack ?? 2);
      if (over > 0) force.addScaledVector(vh, -m * Math.min(M.fwdK * over, (M.fwdMax ?? 3) * g));
    }
    // the exit stroke's surge along the path (see _exitStroke): back up toward exitKeep × the entry speed
    if (sg && mv.phase === 'exit') {
      sg.t += dt;
      const a = this._rampAccel(sg, V, M.surgeKp ?? 10, M.surgeMax ?? 4.5, 0);   // (it only pushes: never brakes)
      if (a !== 0) force.addScaledVector(vh, m * a);
    }
    if (done) this._endTurn(done);
    return cmd;
  }

  /** The exit stroke of a wingover / loop (fix pass, critic #4): as the wings come level, one big rowing downstroke
   *  (PROGRAMS.exit) and a surge that wins back the speed the reversal cost — up to exitKeep × the entry speed, never
   *  above it, never below the speed it has. Nothing when the move was already that fast. */
  _exitStroke(mv, M, V) {
    const want = Math.min(mv.V0, Math.max(V, (M.exitKeep ?? 0) * mv.V0));
    if (!(want - V > 0.5)) return;
    const pr = this._startProg('exit', 1);
    mv.surge = { t: 0, t0: Math.max(0, PROGRAMS.exit.strokeAt + pr.shift - 0.02), T: M.surgeT ?? 0.34, V0: V, dv: want - V, peak: 0 };
  }

  /** Minimum-jerk speed ramp V0 → V0 + dv over T from t0 (feed-forward + P on the speed), bounded to aMax g forward /
   *  aMin g back; returns the acceleration along the path (m/s²). r = { t, t0, T, V0, dv, peak }. Dash and exit surge. */
  _rampAccel(r, V, kp, aMax, aMin) {
    const u = (r.t - r.t0) / r.T;
    if (!(u > 0 && u < 1.15) || !Number.isFinite(V)) return 0;
    const w = Math.min(u, 1), w3 = w * w * w;
    const want = r.V0 + r.dv * (10 * w3 - 15 * w3 * w + 6 * w3 * w * w);
    const ff = u < 1 ? (r.dv / r.T) * 30 * w * w * (1 - w) * (1 - w) : 0;
    const a = clamp(ff + kp * (want - V), -aMin * G0, aMax * G0);
    r.peak = Math.max(r.peak, a / G0);
    return a;
  }

  /**
   * Dash thrust along the flight path from the rowing stroke's downstroke: the speed follows V0 + dv × a minimum-jerk
   * ramp over T s (feed-forward of the ramp + a P loop on the speed, bounded to aMax g forward / aMin g back), so the
   * surge is +dv whatever the stroke itself gives (node's canonical wing rows harder than the game's GLB wing).
   */
  _dashStep(dt, force) {
    const d = this._dash, M = this.spec.moves.dash;
    d.t += dt;
    if (d.fromHover) {
      // from a hover: along the heading it started with (the speed measured along it)
      const a = this._rampAccel(d, this.vel.dot(d.dir), M.kp ?? 12, M.aMax ?? 9, M.aMin ?? 3);
      if (a !== 0) force.addScaledVector(d.dir, this.mass * a);
    } else {
      const V = this.vel.length();
      const a = V > 1 ? this._rampAccel(d, V, M.kp ?? 12, M.aMax ?? 9, M.aMin ?? 3) : 0;
      if (a !== 0) force.addScaledVector(this.vel, (this.mass * a) / V);
    }
    if (d.t > d.t0 + d.T + (M.streamline ?? 0.3)) this._endDash('done');
  }

  _hopStep(dt, force) {
    const Hs = this.spec.dodgeHop, h = this._hop, g = G0;
    h.t += dt;
    const vLat = this.vel.dot(h.lat) - h.vLat0;
    h.y += vLat * dt;
    const s = (h.t - h.t0) / h.T;
    let yd = 0, vd = 0, ad = 0;
    if (s > 0) {
      const u = Math.min(s, 1), u2 = u * u, u3 = u2 * u;
      yd = h.D * (10 * u3 - 15 * u3 * u + 6 * u3 * u2);
      if (s < 1) { vd = (h.D / h.T) * (30 * u2 - 60 * u3 + 30 * u3 * u); ad = (h.D / (h.T * h.T)) * (60 * u - 180 * u2 + 120 * u3); }
    }
    const aMax = Hs.gMax * g;
    const aLat = clamp(ad + Hs.kp * (yd - h.y) + Hs.kd * (vd - vLat), -aMax, aMax);
    force.addScaledVector(h.lat, this.mass * aLat);
    // forward: brake a surge of the strokes above the entry speed (+ a small slack), never push
    const vF = this.vel.dot(h.fwd);
    const aF = clamp(-Hs.fwdK * (vF - h.V0 - Hs.fwdSlack), -Hs.fwdMax * g, 0);
    force.addScaledVector(h.fwd, this.mass * aF);
    // vertical: hold the entry climb rate / height against the lift swings of the sideslip (bounded)
    const vV = this.vel.y - h.vy0;
    h.z += vV * dt;
    const aV = clamp(-(Hs.kpV ?? 16) * h.z - (Hs.kdV ?? 8) * vV, -(Hs.gV ?? 3) * g, (Hs.gV ?? 3) * g);
    force.y += this.mass * aV;
    h.aLat = aLat; h.aF = aF; h.aV = aV;
    // bank schedule (absolute bank, × dir): into the hop, hold, a small catch the other way, level
    const B = Hs.bank * DEG * h.dir, t0 = h.t0, T = h.T;
    const keys = [[0, h.bank0], [t0 + 0.14 * T, B], [t0 + 0.34 * T, 0.6 * B], [t0 + 0.52 * T, 0], [t0 + 0.75 * T, -0.3 * B], [t0 + 1.0 * T, 0]];
    let bank = 0, rate = 0;
    if (h.t >= keys[keys.length - 1][0]) bank = 0;
    else {
      let i = 0; while (i < keys.length - 2 && h.t > keys[i + 1][0]) i++;
      const [ta, ba] = keys[i], [tb, bb] = keys[i + 1], Tk = Math.max(1e-3, tb - ta), uu = clamp((h.t - ta) / Tk, 0, 1);
      bank = ba + (bb - ba) * (0.5 - 0.5 * Math.cos(Math.PI * uu));
      rate = (bb - ba) * 0.5 * Math.PI * Math.sin(Math.PI * uu) / Tk;
    }
    // invulnerability window: until the body has covered invulnAt of the hop (read by pilots / the player)
    const sInv = Hs.invulnAt ?? 0.8;
    h.left = Math.max(0, t0 + sInv * T - h.t);
    const settleEnd = 1 + (Hs.settle ?? 0.2) / T;
    if (s >= settleEnd && (Math.abs(vLat - 0) < 0.6 || s > settleEnd + 0.25 / T)) this._hop = null;
    return { bank, rate };
  }

  // ------------------------------------------------------------------------------------------------ hover
  /**
   * Hover calibration (lazy, the first hover; once per spec × wing geometry, cached): the downstroke pronation that
   * puts the nominal hover stroke's cycle-mean force spec.hover.pitch° ahead of body-up — so the body hovers pitched up
   * that much whatever the rig's wing (the GLB wing sits differently from the canonical one) — and the share of the
   * weight it carries there (wings0, the stroke command's feed-forward). ~5–10 ms once; never throws.
   */
  _hoverCal() {
    if (this._hvCal) return this._hvCal;
    const H = this.spec.hover, key = this._geomKey || 'default', cache = hoverCalCache(this.spec);
    let cal = cache.get(key);
    if (!cal) {
      cal = { kff: HOVER.kff, wings0: H.wings0, axis: H.pitch * DEG, measured: false };
      try {
        const want = H.pitch * DEG, W = this.mass * G0;
        let lo = -0.2, hi = 0.6, flo = hoverStrokeForce(this.spec, this.geom, lo, want).axis - want, fhi = hoverStrokeForce(this.spec, this.geom, hi, want).axis - want;
        let k = HOVER.kff;
        if (flo < 0 && fhi > 0) {
          for (let i = 0; i < 7; i++) {
            k = lo + (hi - lo) * clamp(-flo / (fhi - flo), 0.1, 0.9);    // regula falsi (the axis grows with the pronation)
            const f = hoverStrokeForce(this.spec, this.geom, k, want).axis - want;
            if (Math.abs(f) < 0.3 * DEG) break;
            if (f < 0) { lo = k; flo = f; } else { hi = k; fhi = f; }
          }
        } else k = flo >= 0 ? lo : hi;
        const r = hoverStrokeForce(this.spec, this.geom, k, want);
        // (held still the stroke gives more than in the free hover, where the body heaves up with every downstroke and
        //  meets less inflow: × heaveLoss, measured in node — static 1.18 g, the free hover 0.93 g at u ≈ 0.2)
        if (Number.isFinite(r.along) && r.along > 0.2 * W && Number.isFinite(k)) cal = { kff: k, wings0: clamp((r.along / W) * (H.heaveLoss ?? 1), 0.4, 1.6), static: r.along / W, axis: r.axis, measured: true };
      } catch { /* keep the defaults */ }
      cache.set(key, cal);
    }
    return (this._hvCal = cal);
  }

  /**
   * Hover pilot (flight modes; the player's, instead of steer()): hold the air on hovering wingbeats, turn to the aim
   * (its heading; its pitch aims the head and pitches the body a little), strafe, climb, sink, drift back — or, with
   * fwd > 0, accelerate forward (the W transition into flight), or brake out of flight (brake). Writes controls
   * (hover = 1; the rates come from the controller in the mixer, see _hoverStep) and the command. opts:
   *   strafe −1..1 (+ right), climb −1..1 (+ up), fwd −1..1 (+ forward at vFwd m/s, − back at spec.hover.back),
   *   vFwd (m/s), aFwd (g: the forward acceleration bound), brake (bool), keepAlt (bool: hold the height while braking).
   */
  hoverSteer(aimDir, opts = {}) {
    const H = this.spec.hover, c = this.controls, st = this.state, env = this._env || DEFAULT_ENV;
    if (!H) return c;
    c.hover = 1;
    c.pitch = 0; c.roll = 0; c.yaw = 0; c.glide = 0; c.dive = 0; c.boost = 0; c.flare = 0; c.skid = 0; c.load = 0; c.hard = 0;
    c.flap = 1;
    const cmd = this._hcmd || (this._hcmd = { vel: new THREE.Vector3(), yaw: st.heading || 0, pitch: 0, aH: H.aH, tilt: H.tiltMax,
      strafe: 0, climb: 0, fwd: 0, brake: false });
    const d = _h1.copy(aimDir && Number.isFinite(aimDir.x + aimDir.y + aimDir.z) ? aimDir : _h2.set(0, 0, 1).applyQuaternion(this.quat));
    const dl = d.length();
    if (dl > 1e-6) d.multiplyScalar(1 / dl); else d.set(0, 0, 1).applyQuaternion(this.quat);
    if (Math.hypot(d.x, d.z) > 0.08) cmd.yaw = Math.atan2(d.x, d.z);
    cmd.pitch = Math.asin(clamp(d.y, -1, 1));
    const strafe = clamp(+opts.strafe || 0, -1, 1), climb = clamp(+opts.climb || 0, -1, 1), fwd = clamp(+opts.fwd || 0, -1, 1);
    cmd.strafe = strafe; cmd.climb = climb; cmd.fwd = fwd; cmd.brake = !!opts.brake;
    cmd.mute = clamp(+opts.mute || 0, 0, 1);          // a stagger: the attitude loop lets go (the knock reads), see _hoverStep
    const fx = Math.sin(cmd.yaw), fz = Math.cos(cmd.yaw);          // forward (level); right = fwd × up = (−fz, 0, fx)
    const vf = fwd > 0 ? fwd * (opts.vFwd ?? 30) : fwd * H.back;
    const v = cmd.vel.set(fx * vf - fz * strafe * H.strafe, climb * (climb > 0 ? H.climb : H.sink), fz * vf + fx * strafe * H.strafe);
    // braking out of flight: stop, hold the height the flare reached (no dive into the ground, no zoom)
    if (cmd.brake && opts.keepAlt !== false) v.y = climb ? v.y : 0;
    // ground / sea: never sink below spec.hover.agl m (pushed back up under it); look ahead along the motion for a slope
    const agl = st.agl ?? 1e9;
    if (env.heightAt) {
      let floorAhead = -1e9;
      if (this.vel.x * this.vel.x + this.vel.z * this.vel.z > 4) {
        const x = this.pos.x + this.vel.x * 1.5, z = this.pos.z + this.vel.z * 1.5;
        floorAhead = Math.max(env.heightAt(x, z), env.seaLevel ?? -1e9);
      }
      const aglAhead = this.pos.y - floorAhead;
      const low = Math.min(agl, aglAhead);
      if (low < H.agl + 14) v.y = Math.max(v.y, -H.sink * smoothstep(H.agl, H.agl + 14, low) + Math.max(0, H.agl - low) * 1.5);
    }
    const b = env.bounds;
    if (b?.ceiling && this.pos.y > b.ceiling - 200) v.y = Math.min(v.y, -0.02 * (this.pos.y - (b.ceiling - 200)));
    cmd.aH = cmd.brake ? H.aBrake : fwd > 0 ? (opts.aFwd ?? H.aFwd) : H.aH;
    cmd.tilt = cmd.brake ? H.tiltBrake : fwd > 0 ? H.tiltFwd : H.tiltMax;
    // rearing back (the lift axis behind the heading) while braking scales with the forward speed to lose (fix pass:
    // every stop reared up to 72–80° for ~1 s, even after a short W tap at 13 m/s): the full tiltBrake only when the
    // brake began above tiltBrakeV[1] m/s (the air brake from the cruise), ~tiltBrakeLow° below tiltBrakeV[0] (a short
    // tap rocks back); either way it eases down over the last tiltBrakeEnd m/s (the head clears the reticle as it
    // stops). After the brake the hover's own limit comes back at tiltBackRate °/s (no rear-up spike at the hand-over;
    // the hover needs its full tilt to hold the air in a turn or the wind). Sideways (the lean into a strafe) stays.
    const vFw = Math.max(0, this.vel.x * fx + this.vel.z * fz);
    if (cmd.brake && !cmd.braking) cmd.brakeV0 = vFw;
    cmd.braking = cmd.brake;
    if (H.tiltBrakeLow == null) cmd.tiltBack = cmd.tilt;
    else if (cmd.brake) {
      const k = Math.min(smoothstep(H.tiltBrakeV[0], H.tiltBrakeV[1], cmd.brakeV0 ?? vFw), smoothstep(H.tiltBrakeEnd[0], H.tiltBrakeEnd[1], vFw));
      cmd.tiltBack = Math.min(cmd.tilt, H.tiltBrakeLow + (H.tiltBrake - H.tiltBrakeLow) * k);
    } else {
      cmd.tiltBack = Math.min(cmd.tilt, (cmd.tiltBack ?? cmd.tilt) + (H.tiltBackRate ?? 1e9) * clamp(+opts.dt || 1 / 120, 0, 0.1));
      // (S, the slow drift back, needs little: it leans back tiltDrift° at most — it reared up ~33° past the hover pitch)
      if (fwd < 0 && H.tiltDrift != null) cmd.tiltBack = Math.min(cmd.tiltBack, H.tiltDrift);
    }
    return c;
  }

  /**
   * One step of the hover controller (in the mixer, weight hw 0..1): the wanted acceleration from the velocity command
   * (+ the position hold once stopped, + a small integrator), the body's lift axis turned along it + g (bounded tilt),
   * the heading onto the aim, and the hover-assist force along the body's own lift axis for what the wings' measured
   * lift (low-passed: the stroke's pulse remains, a bob) does not give. Returns the body rate commands (rad/s) and the
   * body pitch offset; adds the assist force (N, world) into `force`. Telemetry in this._hvOut.
   */
  _hoverStep(dt, force, hw) {
    const H = this.spec.hover, cmd = this._hcmd, g = G0, m = this.mass, ct = this.spec.control;
    const out = this._hvOut || (this._hvOut = { p: 0, q: 0, r: 0, pOff: 0, demand: 1, assist: 0, wings: 0, tilt: 0, hold: false });
    if (!H || !cmd || !(dt > 0)) return null;
    // wanted velocity (world, ground-relative) + the position hold once the dragon has come to rest
    const vT = _h1.copy(cmd.vel);
    const hop = this._hop, ds = this._dash;
    const still = cmd.vel.lengthSq() < 0.01 && !hop && !ds && !cmd.brake;
    const HD = this._hold;
    // (the velocity averaged over ~2 strokes decides when the dragon has come to rest: the stroke's own heave swings the
    //  instantaneous velocity ±1.5 m/s — a hold caught at such a moment, while still sinking out of the flare, sat 1.5 m
    //  above where the dragon settled and pulled it back up for seconds)
    const vR = this._hvVr || (this._hvVr = this.vel.clone());
    vR.lerp(this.vel, damp(1 / 0.45, dt));
    if (!still) HD.on = false;
    else if (!HD.on && vR.length() < H.holdV) { HD.on = true; HD.p.copy(this.pos).addScaledVector(vR, 0.45); }
    if (HD.on) {
      const e = _h2.subVectors(HD.p, this.pos), el = e.length(), lim = H.holdMax / H.kp;
      if (el > lim) e.multiplyScalar(lim / el);
      vT.addScaledVector(e, H.kp);
    }
    // (the loop sees the velocity eased over about a stroke: it does not fight the stroke's own heave)
    const vS = this._hvV || (this._hvV = this.vel.clone());
    vS.lerp(this.vel, damp(1 / 0.12, dt));
    const ev = _h3.subVectors(vT, vS);
    // a dodge hop owns the sideways motion, a dash the horizontal (the hover holds the height meanwhile)
    if (hop) ev.addScaledVector(hop.lat, -ev.dot(hop.lat));
    if (ds) { ev.x = 0; ev.z = 0; }
    // (horizontal only — the wind, the stroke's steady side force; the height needs none: the assist closes the lift
    //  error every stroke, and a vertical integrator wound up in the settle held the dragon ~1 m high for seconds)
    if (HD.on) { this._hvI.x += ev.x * H.ki * dt; this._hvI.z += ev.z * H.ki * dt; this._hvI.y = 0; const il = this._hvI.length(); if (il > H.iMax) this._hvI.multiplyScalar(H.iMax / il); }
    else this._hvI.multiplyScalar(1 - damp(2, dt));
    const a = _h4.copy(ev).multiplyScalar(H.kv).add(this._hvI);
    // horizontal drag feed-forward: moving sideways / back / forward the flapping wings and the body drag ~kff m/s² per
    // m/s (measured: 0.33 g at an 8 m/s strafe) — without it the strafe settled ~2 m/s short of its speed
    a.x += (H.kff ?? 0) * vT.x; a.z += (H.kff ?? 0) * vT.z;
    // a dash out of the hover lunges: the lift axis tips forward along it while its thrust ramps (the dash's own speed
    // loop takes the extra push into account)
    if (ds?.dir && ds.fromHover) { const w = smoothstep(0, 0.12, ds.t) * (1 - smoothstep(ds.t0 + ds.T, ds.t0 + ds.T + 0.3, ds.t)); a.addScaledVector(ds.dir, g * Math.tan(26 * DEG) * w); }
    const ah = Math.hypot(a.x, a.z), aHm = cmd.aH * g;
    if (ah > aHm) { a.x *= aHm / ah; a.z *= aHm / ah; }
    a.y = clamp(a.y, -H.aDown * g, H.aUp * g);
    // wanted lift axis: along a + g, tilted at most cmd.tilt° off the vertical
    const need = _h5.copy(a); need.y += g;
    const tD = _h6.copy(need);
    const tl = cmd.tilt * DEG, nh = Math.hypot(tD.x, tD.z);
    if (tD.y < 0.2 * g) tD.y = 0.2 * g;
    if (nh > tD.y * Math.tan(tl)) { const k = (tD.y * Math.tan(tl)) / nh; tD.x *= k; tD.z *= k; }
    // (rearing back: at most cmd.tiltBack°, see hoverSteer)
    if (cmd.tiltBack != null && cmd.tiltBack < cmd.tilt) {
      const hx = Math.sin(cmd.yaw), hz = Math.cos(cmd.yaw), back = -(tD.x * hx + tD.z * hz), bMax = tD.y * Math.tan(cmd.tiltBack * DEG);
      if (back > bMax) { tD.x += hx * (back - bMax); tD.z += hz * (back - bMax); }
    }
    tD.normalize();
    // the body's lift axis now (world): `pitch`° ahead of body-up (the stroke plane's normal); pitch offset by the aim
    const pOff = clamp(cmd.pitch * H.aimPitch, -H.aimPitchMax * DEG, H.aimPitchMax * DEG);
    const th = H.pitch * DEG + pOff;
    const lb = _h7.set(0, Math.cos(th), Math.sin(th)).applyQuaternion(this.quat);
    // the wings' own lift along it, as the mean of the last full stroke (the pulse within a stroke is never topped up —
    // it heaves the body: the bob), eased over meanTau
    const aeroW = this._aeroFb ? _h8.copy(this._aeroFb).applyQuaternion(this.quat) : _h8.set(0, 0, 0);
    const liftNow = aeroW.dot(lb);
    const CY = this._hvCyc || (this._hvCyc = { acc: 0, t: 0, ph: Math.floor(this._phase), mean: 0, n: 0, lp: liftNow });
    CY.acc += liftNow * dt; CY.t += dt;
    CY.lp += (liftNow - CY.lp) * damp(1 / 0.3, dt);
    const ph = Math.floor(this._phase);
    if (ph !== CY.ph || CY.t > 1.2) {
      // (the first, partial stroke after the hover blends in is not a stroke mean: the low-passed lift stands in)
      CY.mean = CY.n > 0 ? CY.acc / Math.max(CY.t, 1e-3) : CY.lp; CY.n++;
      CY.acc = 0; CY.t = 0; CY.ph = ph;
    }
    const meanNow = CY.n > 1 ? CY.mean : CY.lp;
    this._hvLift += (meanNow - this._hvLift) * damp(1 / H.meanTau, dt);
    const want = m * Math.max(0, need.dot(lb));
    // the stroke command: feed-forward from the lift wanted (lift ∝ (f·amp)²) + a slow trim on the measured mean
    const W0 = m * g * (this._hoverCal().wings0 ?? H.wings0);
    this._hvU = clamp((this._hvU ?? 0) + H.uKi * ((want - this._hvLift) / (m * g)) * dt, -(H.uIMax ?? 0.8), H.uIMax ?? 0.8);
    const r = Math.max(0.05, want / W0);
    const uFF = (Math.pow(r, 0.25) - 1) / Math.max(0.02, 0.5 * (H.fK + H.aK));
    const u = clamp(uFF + this._hvU, H.uMin, H.uMax);
    // (only as far as the lift axis is already where it is wanted: a body not yet reared up is not shoved forward)
    const align = smoothstep(Math.cos(45 * DEG), Math.cos(12 * DEG), lb.dot(tD));
    const A = clamp(want - this._hvLift, -H.assistMin * m * g, H.assistMax * m * g) * (want - this._hvLift > 0 ? align : 1);
    force.addScaledVector(lb, A * hw);
    // wanted attitude: lift axis along tD, heading on the aim, the body pitched th above the axis
    const fh = _h9.set(Math.sin(cmd.yaw), 0, Math.cos(cmd.yaw));
    fh.addScaledVector(tD, -fh.dot(tD));
    if (fh.lengthSq() < 1e-6) fh.set(0, 0, 1).applyQuaternion(this.quat).addScaledVector(tD, -_h10.set(0, 0, 1).applyQuaternion(this.quat).dot(tD));
    fh.normalize();
    const fD = _h10.copy(fh).multiplyScalar(Math.cos(th)).addScaledVector(tD, Math.sin(th));
    const uD = _h2.copy(tD).multiplyScalar(Math.cos(th)).addScaledVector(fh, -Math.sin(th));
    const lD = _h3.crossVectors(uD, fD);                                   // body +X = left = up × forward
    _hm.makeBasis(lD, uD, fD);
    _hqD.setFromRotationMatrix(_hm);
    _hqE.copy(_hqD).multiply(_hqI.copy(this.quat).invert());
    if (_hqE.w < 0) { _hqE.x = -_hqE.x; _hqE.y = -_hqE.y; _hqE.z = -_hqE.z; _hqE.w = -_hqE.w; }
    const sh = Math.sqrt(Math.max(0, 1 - _hqE.w * _hqE.w)), ang = 2 * Math.atan2(sh, _hqE.w);
    const err = _h4.set(_hqE.x, _hqE.y, _hqE.z).multiplyScalar(sh > 1e-6 ? ang / sh : 2);
    // rate demand (world): the tilt part (capped attMax) + the yaw part about the vertical (capped yawRate)
    const ey = err.y;
    const wDes = _h5.copy(err).setY(0).multiplyScalar(H.att);
    const wl = wDes.length();
    if (wl > H.attMax) wDes.multiplyScalar(H.attMax / wl);
    wDes.y = clamp(4 * ey, -H.yawRate * DEG, H.yawRate * DEG);
    wDes.applyQuaternion(_hqI);                                            // body frame (_hqI = q⁻¹)
    out.p = clamp(wDes.z, -ct.pMax * 2, ct.pMax * 2);                     // roll right +w.z, pitch up −w.x, yaw right −w.y
    out.q = clamp(-wDes.x, -ct.qMax * 2.5, ct.qMax * 2.5);
    out.r = clamp(-wDes.y, -ct.rMax * 4, ct.rMax * 4);
    // a stagger (swat, heavy blow): hands off — the rates follow 0.35 × the body's own (the assist brakes the tumble
    // gently instead of snapping it back); the lift stays on
    if (cmd.mute > 0) {
      const wb = this._wb, m1 = cmd.mute;
      out.p += (0.35 * wb.z - out.p) * m1; out.q += (-0.35 * wb.x - out.q) * m1; out.r += (-0.35 * wb.y - out.r) * m1;
    }
    out.pOff = pOff; out.u = u;
    out.demand = (A + Math.max(0, this._hvLift)) / (m * g);
    out.assist = A / (m * g); out.wings = this._hvLift / (m * g);
    out.tilt = Math.acos(clamp(tD.y, -1, 1)); out.hold = HD.on;
    // stamina: hovering is free; a strafe started from (near) rest — the burst that sets the body moving sideways — costs
    // strafeCost per second for its first strafeBurst s. Reversing or re-pressing while it still moves sideways faster
    // than strafeFreeV m/s is free, and at most one burst per strafeGap s is paid (fix pass: A / D alternated 16× in 12 s
    // drained 1.00 → 0.42 and left nothing for Q / E, the dash or Shift)
    this._strafeGapT = (this._strafeGapT ?? 1e9) + dt;
    const sd = Math.sign(cmd.strafe);
    if (sd !== 0 && hw > 0.5) {
      if (sd !== this._strafeSide) {
        const vSide = Math.abs(-vS.x * Math.cos(cmd.yaw) + vS.z * Math.sin(cmd.yaw));
        this._strafePay = vSide < (H.strafeFreeV ?? 2) && this._strafeGapT >= (H.strafeGap ?? 0);
        if (this._strafePay) this._strafeGapT = 0;
        this._strafeT = 0;
      }
      this._strafeT += dt;
      if (this._strafePay && this._strafeT < H.strafeBurst) { this.stamina = Math.max(0, this.stamina - H.strafeCost * dt); this._staminaIdle = 0; }
    } else { this._strafeT = 0; this._strafePay = false; }
    this._strafeSide = hw > 0.5 ? sd : 0;
    return out;
  }

  // Pose + strip geometry for the current phase.
  _updatePose(h) {
    const P = this.prm;
    P.phase = this._phase;
    evaluatePose(P, this.geom, this.pose);
    for (let side = 0; side < 2; side++) {
      const sec = this._sections[side];
      wingSections(side === 0 ? this.pose.L : this.pose.R, sec);
      stripsFromSections(sec, side === 0 ? 1 : -1, this._wingStrips[side]);
    }
    let area = 0;
    for (let side = 0; side < 2; side++) {
      for (let i = 0; i < STRIPS_PER_WING; i++) {
        const src = this._wingStrips[side][i], dst = this.surfaces[side * STRIPS_PER_WING + i];
        if (dst.valid && h > 0) dst.rDot.subVectors(src.r, dst.r).multiplyScalar(1 / h);
        else dst.rDot.set(0, 0, 0);
        dst.r.copy(src.r); dst.s.copy(src.s); dst.c.copy(src.c); dst.n.copy(src.n);
        dst.chord = src.chord; dst.width = src.width; dst.area = src.area; dst.valid = true;
        area += src.area;
      }
    }
    const span = this.pose.L.span + this.pose.R.span;
    this._area = area + this.bodyStrip.area;
    this._span = Math.max(span, 1);
    this._AR = (this._span * this._span) / this._area;
  }

  // Inertia tensor (body frame) from the core and the wing point masses of the current pose.
  _massProps() {
    const sp = this.spec, s = this.scale;
    const mw = this.mass * sp.wingMassFrac;
    const mc = this.mass - 2 * mw;
    const k = (mc / (BASE.mass * (1 - 2 * BASE.wingMassFrac))) * s * s;
    const e = this._Ib.elements;
    e.fill(0);
    e[0] = sp.inertiaCore[0] * k; e[4] = sp.inertiaCore[1] * k; e[8] = sp.inertiaCore[2] * k;
    const split = this.geom.massSplit;
    for (const side of [this.pose.L, this.pose.R]) {
      for (let i = 0; i < 3; i++) {
        const m = mw * split[i], p = side.mass[i];
        const xx = p.x * p.x, yy = p.y * p.y, zz = p.z * p.z;
        e[0] += m * (yy + zz); e[4] += m * (xx + zz); e[8] += m * (xx + yy);
        e[1] -= m * p.x * p.y; e[2] -= m * p.x * p.z; e[5] -= m * p.y * p.z;
      }
    }
    e[3] = e[1]; e[6] = e[2]; e[7] = e[5];
    this._IbInv.copy(this._Ib).invert();
  }

  // -------------------------------------------------------------------------------------------------------------
  // Aerodynamics: sum of forces and torques in the BODY frame.
  // -------------------------------------------------------------------------------------------------------------
  _aero(rho, vAirB, wb, F, T, windDiffL, windDiffR) {
    const a = this.spec.aero, st = this.state;
    const AR = this._AR;
    let power = 0, stalledA = 0, liftW = 0, thrust = 0, qS = 0;
    const flapFreq = this._b.freq;
    const progW = this.prm.prog.w;
    const downL = (this.pose.L.downstroke && this._b.a > 0.3) || (progW > 0.5 && this.pose.L.downstroke);
    const downR = (this.pose.R.downstroke && this._b.a > 0.3) || (progW > 0.5 && this.pose.R.downstroke);
    // Fix pass (critic #14, "15–38 g for ONE frame at the onset of a power beat / grab / dash"): a scripted stroke's
    // anticipation throws the wing UP at 16–25 rad/s (the hand strips at 150–220 m/s) — the quasi-steady strips then
    // made a flat-plate paddle of it (up to 55 g, mostly forward, for 1–2 steps). A real wing flicked up that fast is a
    // slack, feathered recovery: the fingers close, the membrane luffs and carries almost no load. So while a script
    // RAISES a wing (its programmed rate > flick.rate rad/s), each strip of it moving faster than flick.v[0] m/s
    // (kinematic, the blend and the fold included) sheds its quasi-steady force, down to (1 − flick.k) of it from
    // flick.v[1] m/s. The regular stroke (tips ≤ ~45 m/s) and every downstroke keep their full force.
    const FK = a.flick || { rate: [2, 6], v: [50, 100], k: 0.92 };
    const gateL = progW > 0 ? Math.min(1, 4 * progW) * FK.k * smoothstep(FK.rate[0], FK.rate[1], this.prm.L.prog.psiDot) : 0;
    const gateR = progW > 0 ? Math.min(1, 4 * progW) * FK.k * smoothstep(FK.rate[0], FK.rate[1], this.prm.R.prog.psiDot) : 0;
    // tail downwash from the mean wing lift
    const eps = clamp(0.8 * 2 * this._clMean / (Math.PI * AR), -0.2, 0.3);
    for (const sf of this.surfaces) {
      if (sf.area <= 1e-4) continue;
      // strip velocity relative to the air (body frame)
      _v1.crossVectors(wb, sf.r).add(vAirB).add(sf.rDot);
      if (sf.kind === 'wing') {
        const t = clamp(Math.abs(sf.r.x) / this.geom.semispan, 0, 1);
        if (sf.side > 0 && windDiffL) _v1.addScaledVector(windDiffL, -t);
        if (sf.side < 0 && windDiffR) _v1.addScaledVector(windDiffR, -t);
      }
      _w.copy(_v1).negate();
      let s = sf.s, c = sf.c, n = sf.n;
      if (sf.kind === 'htail') {
        const inc = this._elevator - eps;
        s = _ts.set(1, 0, 0); c = _tc.set(0, -Math.sin(inc), -Math.cos(inc)); n = _tn.crossVectors(s, c);
      } else if (sf.kind === 'vtail') {
        const inc = this._rudder;
        s = _ts.set(0, 1, 0); c = _tc.set(-Math.sin(inc), 0, -Math.cos(inc)); n = _tn.crossVectors(c, s);
      }
      const ws = _w.dot(s);
      _wp.copy(_w).addScaledVector(s, -ws);
      const Vn = _wp.length();
      if (Vn < 0.3) { sf.force.set(0, 0, 0); continue; }
      _wp.multiplyScalar(1 / Vn);
      const alpha = Math.atan2(_wp.dot(n), _wp.dot(c));
      sf.alpha = alpha;
      let area = sf.area, ar = AR, aStall = a.alphaStall * DEG, camber = 0;
      if (sf.kind === 'wing') {
        area *= 1 - (a.tuckWing ?? 0) * this._b.tuck;
        const gate = sf.side > 0 ? gateL : gateR;
        if (gate > 0) area *= 1 - gate * smoothstep(FK.v[0], FK.v[1], sf.rDot.length());
        camber = a.camber * (sf.side > 0 ? this.pose.L.camber : this.pose.R.camber);
        if (sf.side > 0 ? downL : downR) {
          const kred = Math.PI * flapFreq * sf.chord / Math.max(Vn, 1);
          aStall += a.lev * DEG * clamp((kred - 0.1) / 0.2, 0, 1) + (this._prog?.def.lev ?? a.levProg) * DEG * progW;
        }
      } else if (sf.kind === 'body') { camber = 0; }
      else if (sf.kind === 'htail') { area *= this._tailSpread; ar = this.spec.aero.htail.ar * this._tailSpread; aStall = a.htail.alphaStall * DEG; }
      else if (sf.kind === 'vtail') { ar = a.vtail.ar; aStall = a.vtail.alphaStall * DEG; }
      else if (sf.kind === 'neck') { ar = 1.2; aStall = 30 * DEG; }
      if (sf.stalled) aStall -= a.stallHyst * DEG;
      aeroCoeffs(alpha, camber, ar, aStall, a.stallPad * DEG, a, _coef);
      sf.stalled = _coef.stalledT > 0.5;
      if (sf.kind === 'wing' && sf.stalled) stalledA += area;
      const q = 0.5 * rho * Vn * Vn;
      _lhat.copy(n).multiplyScalar(Math.cos(alpha)).addScaledVector(c, -Math.sin(alpha));
      _f.copy(_lhat).multiplyScalar(q * area * _coef.cl).addScaledVector(_wp, q * area * _coef.cd);
      sf.force.copy(_f); sf.cl = _coef.cl;
      F.add(_f);
      // centre of pressure migrates from 1/4 chord toward 1/2 chord post-stall
      const cpShift = sf.chord * 0.25 * clamp(2 * Math.abs(alpha) / Math.PI, 0, 1);
      _cp.copy(sf.r).addScaledVector(c, cpShift);
      T.add(_tq.crossVectors(_cp, _f));
      if (sf.kind === 'wing') {
        power -= _f.dot(sf.rDot);
        liftW += _f.dot(_up);
        qS += q * area;
      }
    }
    // Body drag (sideslip/AoA dependent CdA) at the body centre of pressure.
    const V = vAirB.length();
    if (V > 0.1) {
      const sb = vAirB.x / V, sa = vAirB.y / V;
      const cda = ((a.bodyCdA.front + (a.bodyCdA.side - a.bodyCdA.front) * sb * sb + (a.bodyCdA.top - a.bodyCdA.front) * sa * sa)
        * (1 - (a.tuckBody ?? 0) * this._b.tuck) + a.legsCdA * this._legs + (a.brakeCdA ?? 0) * (this._brake || 0)) * this.scale * this.scale;
      _f.copy(vAirB).multiplyScalar(-0.5 * rho * V * cda);
      F.add(_f);
      _cp.set(a.bodyCp[0], a.bodyCp[1], a.bodyCp[2]).multiplyScalar(this.scale);
      T.add(_tq.crossVectors(_cp, _f));
    }
    const cl = qS > 1 ? liftW / qS : 0;
    this._clMean += (cl - this._clMean) * 0.02;
    return { power, stalledA };
  }

  // -------------------------------------------------------------------------------------------------------------
  /** Advance the simulation by dt (called at 120 Hz). env: { gravity, airDensity(y), wind(pos,out), heightAt(x,z) }. */
  step(dt, env = DEFAULT_ENV) {
    if (!(dt > 0)) return;
    this._env = env || DEFAULT_ENV;
    env = this._env;
    this.prevPos.copy(this.pos); this.prevQuat.copy(this.quat);
    const n = this.substeps, h = dt / n;
    let power = 0, stalledA = 0;
    const g = env.gravity ?? G0;
    const st = this.state;
    const bounds = env.bounds;
    // Wind: sampled once per fixed step at the CG and both wing tips (world), reused by the substeps and telemetry.
    const hasWind = typeof env.wind === 'function';
    if (hasWind) {
      const W = this._wind || (this._wind = { c: new THREE.Vector3(), l: new THREE.Vector3(), r: new THREE.Vector3() });
      const tipX = this.geom.semispan;
      try {
        env.wind(this.pos, W.c);
        _v1.set(tipX, 0, 0).applyQuaternion(this.quat).add(this.pos); env.wind(_v1, W.l);
        _v1.set(-tipX, 0, 0).applyQuaternion(this.quat).add(this.pos); env.wind(_v1, W.r);
      } catch { W.c.set(0, 0, 0); W.l.set(0, 0, 0); W.r.set(0, 0, 0); }
      if (!Number.isFinite(W.c.x + W.c.y + W.c.z + W.l.x + W.l.y + W.l.z + W.r.x + W.r.y + W.r.z)) { W.c.set(0, 0, 0); W.l.set(0, 0, 0); W.r.set(0, 0, 0); }
    }
    for (let i = 0; i < n; i++) {
      // mixer per substep: every blended pose parameter moves smoothly, so strip velocities never spike
      this._mix(h);
      // phase clock (never resets; the rate eases)
      const prevPh = this._phase;
      this._phase += (this._phaseRate || this._b.freq) * h;
      const P = this.prm;
      const wrapped = Math.floor(this._phase) > Math.floor(prevPh);
      if (wrapped) {
        const strength = clamp(this._b.a * (this._b.amp / (34 * DEG)) * (this._b.freq / 1.4), 0, 1.5);
        if (this._b.a > 0.25 && this.prm.prog.w < 0.5) {
          st.beatCount++;
          try { this.onBeat?.(Math.min(1, strength), this); } catch (e) { /* listeners must not break physics */ }
        }
      }
      this._updatePose(h);
      this._massProps();

      // air-relative body velocity (body frame), with wind at the CG and the wing tips
      _qi.copy(this.quat).invert();
      let windDiffL = null, windDiffR = null;
      _windC.set(0, 0, 0);
      if (hasWind) {
        const W = this._wind;
        _windC.copy(W.c);
        windDiffL = _windL.subVectors(W.l, W.c).applyQuaternion(_qi);
        windDiffR = _windR.subVectors(W.r, W.c).applyQuaternion(_qi);
      }
      const vAirB = _v4.copy(this.vel).sub(_windC).applyQuaternion(_qi).clone();
      let rho = (env.airDensity || airDensity)(this.pos.y);
      if (bounds && bounds.ceiling) rho *= 1 - 0.75 * smoothstep(bounds.ceiling - 500, bounds.ceiling + 250, this.pos.y);
      this._rho = rho;
      _up.set(0, 1, 0);   // body up, for the wing-lift telemetry
      const Fb = _F.set(0, 0, 0), Tb = _tmp.set(0, 0, 0);
      const wb = this._wb.clone();
      const res = this._aero(rho, vAirB, wb, Fb, Tb, windDiffL, windDiffR);
      power += res.power / n; stalledA += res.stalledA / n;
      this._aeroFb = this._aeroFb || new THREE.Vector3();
      this._aeroFb.copy(Fb);

      // Pilot-assist torque (bounded) toward the commanded body rates.
      const as = this.spec.control.assist, cmd = this._cmd;
      const s2 = this.scale * this.scale * (this.mass / BASE.mass);
      const e = this._Ib.elements;
      const w = as.weight;
      const pErr = cmd.p - wb.z, qErr = -cmd.q - wb.x, rErr = -cmd.r - wb.y;
      // (wave 6: a wingover / loop is flown with the dodge's roll authority, the power strokes' pitch authority and
      //  2.5 × the yaw bound — the whole body, tail and neck work the manoeuvre; still bounded torques)
      const inMove = !!this._move;
      // (hover: no airflow over the tail and rudder — the body, neck, tail and the wings' differential strokes hold the
      //  attitude; the bounded assist gets the power strokes' authority, × the hover weight)
      const hvk = this._b.hover || 0;
      const rk = Math.max(this._prog?.kind === 'dodge' || inMove ? 2.4 : 1, 1 + 1.2 * hvk);
      const tr = clamp(e[8] * as.roll[0] * pErr + this.spec.control.rollDampFF * s2 * cmd.p * clamp(this.state.airspeed / 34, 0.3, 2),
        -as.roll[1] * s2 * rk, as.roll[1] * s2 * rk);
      const pk = Math.max(this._prog || inMove ? 2.6 : 1, 1 + 1.6 * hvk);    // power strokes: the tail and body brace against the stroke moments
      const tp = clamp(e[0] * as.pitch[0] * pk * qErr, -as.pitch[1] * s2 * pk, as.pitch[1] * s2 * pk);
      const yk = Math.max(this._prog?.kind === 'dodge' ? 3.5 : inMove ? 2.5 : 1, 1 + 1.5 * hvk);
      const ty = clamp(e[4] * as.yaw[0] * yk * rErr, -as.yaw[1] * s2 * yk, as.yaw[1] * s2 * yk);
      Tb.x += tp * w; Tb.y += ty * w; Tb.z += tr * w;

      // Translational: semi-implicit Euler.
      _Fw.copy(Fb).applyQuaternion(this.quat);
      _Fw.y -= this.mass * g;
      _Fw.add(this._extF);
      if (this._burstF) _Fw.add(this._burstF);
      this.vel.addScaledVector(_Fw, h / this.mass);
      this.pos.addScaledVector(this.vel, h);
      // Rotational: world angular momentum with the pose-dependent inertia.
      _v1.copy(Tb).applyQuaternion(this.quat).add(this._extT);
      this.L.addScaledVector(_v1, h);
      _v2.copy(this.L).applyQuaternion(_qi).applyMatrix3(this._IbInv);   // body omega
      this._wb.copy(_v2);
      this.angVel.copy(_v2).applyQuaternion(this.quat);
      const wx = this.angVel.x, wy = this.angVel.y, wz = this.angVel.z;
      const q = this.quat;
      _q.set(wx, wy, wz, 0).multiply(q);
      q.x += 0.5 * h * _q.x; q.y += 0.5 * h * _q.y; q.z += 0.5 * h * _q.z; q.w += 0.5 * h * _q.w;
      q.normalize();
    }
    this._extF.set(0, 0, 0); this._extT.set(0, 0, 0);
    this._post(dt, env, power, stalledA);
  }

  _post(dt, env, power, stalledA) {
    const st = this.state, sp = this.spec;
    // Ground and water: a real contact impulse (plus crash damage above a threshold). Clouds are passable.
    const hx = env.heightAt ? env.heightAt(this.pos.x, this.pos.z) : -1e9;
    const floor = Math.max(hx, env.seaLevel ?? -1e9);
    const clear = sp.clearance * this.scale;
    st.agl = this.pos.y - floor;
    this._crashCd = Math.max(0, this._crashCd - dt);
    this._beatT += dt;
    st.crash = 0;
    const GR = sp.ground || {};
    if (this.pos.y < floor + clear) {
      const nrm = _v1.set(0, 1, 0);
      if (env.heightAt && hx >= (env.seaLevel ?? -1e9)) {
        const e = 2;
        nrm.set(env.heightAt(this.pos.x - e, this.pos.z) - env.heightAt(this.pos.x + e, this.pos.z), 2 * e,
          env.heightAt(this.pos.x, this.pos.z - e) - env.heightAt(this.pos.x, this.pos.z + e)).normalize();
      }
      const vn = this.vel.dot(nrm);
      this.pos.y = floor + clear;
      if (vn < 0) {
        const impact = -vn, speed0 = this.vel.length();
        // restitution + Coulomb friction (|J_t| ≤ μ |J_n|), as impulses: a hard crash bounces back into the air,
        // a resting contact slides to a stop at ~μ g instead of sticking
        const Jn = -vn * (1 + (GR.restitution ?? 0.3)) * this.mass;
        const vt = _v3.copy(this.vel).addScaledVector(nrm, -vn), vtl = vt.length();
        this.applyImpulse(_v2.copy(nrm).multiplyScalar(Jn));
        if (vtl > 1e-4) this.applyImpulse(vt.multiplyScalar(-Math.min(vtl * this.mass, (GR.friction ?? 0.6) * Jn) / vtl));
        if (impact > 4 && this._crashCd <= 0) {
          this._crashCd = 0.7;
          st.crash = impact;
          // a hard hit tumbles the body (angular impulse about the axis ground normal × velocity) — the pilot and
          // the assist recover it in the air
          if (impact > 18) {
            _v2.copy(this.vel).addScaledVector(nrm, -this.vel.dot(nrm));
            if (_v2.lengthSq() < 1e-4) _v2.set(0, 0, 1).applyQuaternion(this.quat);
            _v4.crossVectors(nrm, _v2).normalize();
            const dw = Math.min(5, (impact - 18) * (GR.tumble ?? 0.05) + 0.6);
            this.L.addScaledVector(_v4, dw * this._Ib.elements[0]);
          }
          // a hard hit springs straight into the take-off (flare + hard strokes, nose up) instead of skimming the
          // ground with the wings still tucked while the pilot holds the dive
          if (impact > 18 && this.autoTakeoff !== false && !this.dead) this._takeoffT = Math.max(this._takeoffT || 0, GR.climbOut ?? 1.2);
          // severity 0..1 (share of max HP a crash should cost): (vn − 8) / 45 squared — ~20 m/s ≈ 7 %, 30 ≈ 24 %,
          // 40 ≈ 51 %, ≥ 53 m/s (190 km/h into the ground) lethal. Damage itself is the dragon owner's (onCrash).
          const severity = clamp((impact - 8) / 45, 0, 1) ** 2;
          const info = { impact, speed: speed0, severity, point: this.pos.clone().addScaledVector(nrm, -clear), normal: nrm.clone() };
          try { this.onCrash?.(info, this); env.onCrash?.(info, this); } catch (e) { /* keep simulating */ }
        }
      }
    }
    // ground-contact clock (drives the automatic take-off in the mixer)
    // (skimming along a few decimetres up counts as contact: it decays instead of resetting, so a bouncing belly
    //  still reaches the take-off after ~0.25 s)
    if (this.pos.y < floor + clear + 0.8) this._groundT += dt; else this._groundT = Math.max(0, this._groundT - 3 * dt);

    // Stamina: boost drains continuously, beats/dodges were charged on the edge; regen after a short delay.
    const sm = sp.stamina;
    if (this._boosting) { this.stamina = Math.max(0, this.stamina - sm.boostDrain * dt); this._staminaIdle = 0; }
    else {
      this._staminaIdle += dt;
      if (this._staminaIdle > sm.delay && !this._prog && !this._hop && !this._move && !this._dash) {
        const bonus = this._b.a < 0.3 ? 1.5 : 1;
        this.stamina = Math.min(1, this.stamina + sm.regen * bonus * dt);
      }
    }

    // Telemetry.
    _qi.copy(this.quat).invert();
    const vAirB = _v4.copy(this.vel);
    if (typeof env.wind === 'function' && this._wind) vAirB.sub(this._wind.c);
    vAirB.applyQuaternion(_qi);
    st.wind = this._wind && typeof env.wind === 'function' ? this._wind.c : null;
    const V = vAirB.length();
    st.airspeed = V;
    st.aoa = Math.atan2(-vAirB.y, Math.max(1e-3, vAirB.z));
    st.sideslip = Math.asin(clamp(-vAirB.x / Math.max(V, 1e-3), -1, 1));  // + = wind from the right... (air moving left)
    const Fb = this._aeroFb || _v1.set(0, 0, 0);
    const vhat = _v2.copy(vAirB).multiplyScalar(1 / Math.max(V, 1e-3));
    const along = Fb.dot(vhat);
    const liftVec = _v3.copy(Fb).addScaledVector(vhat, -along);
    st.lift = liftVec.length();
    st.drag = Math.max(0, -along);
    st.thrust = Math.max(0, along);
    const nNow = Fb.y / (this.mass * G0);
    this._nFilt += (nNow - this._nFilt) * damp(6, dt);
    this._nSlow += (nNow - this._nSlow) * damp(1.2, dt);
    st.gLoad = this._nFilt;
    st.flapPhase = this._phase % 1;
    st.flapRate = this._b.freq * (this._b.a > 0.2 ? 1 : 0);
    st.flapAmp = this._b.amp * this._b.a;
    st.stamina = this.stamina;
    st.power = power;
    st.stalled = this._area > 0 ? stalledA / (this._area - this.bodyStrip.area) : 0;
    st.span = this._span; st.area = this._area; st.AR = this._AR;
    _fw.set(0, 0, 1).applyQuaternion(this.quat);
    _up.set(0, 1, 0).applyQuaternion(this.quat);
    _rt.set(-1, 0, 0).applyQuaternion(this.quat);
    st.pitch = Math.asin(clamp(_fw.y, -1, 1));
    st.heading = Math.atan2(_fw.x, _fw.z);
    st.bank = Math.atan2(-_rt.y, _up.y);        // + = right wing down
    st.climb = this.vel.y;
    st.dodging = this._hop ? this._hop.dir : this._prog?.kind === 'dodge' ? this._prog.dir : 0;
    st.dodgeLeft = this._hop ? this._hop.left ?? 0 : 0;   // s of the hop still to cover (pilots give i-frames)
    st.dodgeQueued = this._dodgeQ ? this._dodgeQ.dir : 0;  // a dodge request waiting to start (≤ spec.dodgeQueue s)
    st.beating = this._prog?.kind === 'beat' ? 1 : 0;
    st.sinceBeat = this._beatT;                           // s since the last power beat started
    st.grounded = this._groundT;
    // wave 6 — flight moves: the running wingover / loop (or dash), its side, time, phase and progress 0..1
    const mv = this._move;
    st.move = mv ? mv.name : this._dash ? 'dash' : null;
    st.moveSide = mv ? mv.side : 0;
    st.moveT = mv ? mv.t : this._dash ? this._dash.t : 0;
    st.movePhase = mv ? mv.phase : this._dash ? 'dash' : null;
    st.moveU = mv ? mv.u : this._dash ? clamp(this._dash.t / (this._dash.t0 + this._dash.T), 0, 1) : 0;
    st.moveQueued = this._moveQ ? this._moveQ.name : null;
    st.dashing = !!this._dash;
    st.moveCooldown = this._moveCd.turn; st.dashCooldown = this._moveCd.dash;
    st.pose = this.pose;
  }

  /** Instant change of momentum (N s), optionally at a world point (adds angular momentum). */
  applyImpulse(J, atPoint = null) {
    if (!J || !Number.isFinite(J.x + J.y + J.z)) return;
    this.vel.addScaledVector(J, 1 / this.mass);
    if (atPoint) { _tmp.subVectors(atPoint, this.pos); this.L.add(_v1.crossVectors(_tmp, J)); }
  }

  /** Force (N, world) for the next step only — call every fixed step for sustained forces (gusts, downwash). */
  applyForce(Fw, atPoint = null) {
    if (!Fw || !Number.isFinite(Fw.x + Fw.y + Fw.z)) return;
    this._extF.add(Fw);
    if (atPoint) { _tmp.subVectors(atPoint, this.pos); this._extT.add(_v1.crossVectors(_tmp, Fw)); }
  }

  /** Interpolated render transform between the last two fixed steps (alpha = game.time.alpha). */
  interpolate(alpha, outPos, outQuat) {
    if (outPos) outPos.lerpVectors(this.prevPos, this.pos, alpha);
    if (outQuat) outQuat.slerpQuaternions(this.prevQuat, this.quat, alpha);
  }

  /** World-space position of a body-frame point (e.g. the mouth). */
  toWorld(localPoint, out = new THREE.Vector3()) { return out.copy(localPoint).applyQuaternion(this.quat).add(this.pos); }

  // -------------------------------------------------------------------------------------------------------------
  // Trim calibration: lift curve of the glide pose (used by the pilot to turn a load factor into an AoA).
  // -------------------------------------------------------------------------------------------------------------
  _calibrate() {
    const saved = { a: this.prm.a };
    this.prm.a = 0; this.prm.phase = 0; this._b.a = 0;
    this._elevator = 0; this._rudder = 0; this._tailSpread = 1; this._legs = 0; this._trimElev = 0;
    this._updatePose(0);
    const rho = 1.225, V = 30;
    const liftAt = (al) => {
      const vB = _v1.set(0, -Math.sin(al) * V, Math.cos(al) * V).clone();
      const F = new THREE.Vector3(), T = new THREE.Vector3();
      for (const s of this.surfaces) s.stalled = false;
      this._aero(rho, vB, new THREE.Vector3(), F, T, null, null);
      return { F, T };
    };
    const q = 0.5 * rho * V * V;
    const r0 = liftAt(0), r1 = liftAt(6 * DEG);
    const L0 = r0.F.y * Math.cos(0) + r0.F.z * 0, L1 = r1.F.y * Math.cos(6 * DEG) + r1.F.z * Math.sin(6 * DEG);
    this.cal = { slope: (L1 - L0) / (q * this._area * 6 * DEG), cl0: L0 / (q * this._area), area: this._area };
    let best = -1, bestA = 0;
    for (let d = 0; d <= 34; d += 0.5) {
      const al = d * DEG, r = liftAt(al);
      const Lx = r.F.y * Math.cos(al) + r.F.z * Math.sin(al);
      if (Lx > best) { best = Lx; bestA = al; }
    }
    this.cal.aoaStall = bestA; this.cal.clMax = best / (q * this._area);
    // Trim elevator for zero pitching moment at the cruise lift coefficient.
    const clCruise = (this.mass * G0) / (0.5 * 1.04 * this.spec.pilot.cruise ** 2 * this._area);
    const aTrim = (clCruise - this.cal.cl0) / this.cal.slope;
    let lo = -20 * DEG, hi = 20 * DEG;
    for (let i = 0; i < 30; i++) {
      this._elevator = (lo + hi) / 2;
      const { T } = liftAt(aTrim);
      if (T.x > 0) hi = this._elevator; else lo = this._elevator;   // +T.x = nose down -> less tail incidence
    }
    this._trimElev = this._elevator;
    this.cal.aTrim = aTrim; this.cal.elevTrim = this._trimElev;
    this._calibrateFlap();
    // leave no trace: the stroke parameters and filters start from the same state as a cached construction
    const fresh = defaultParams();
    for (const k of Object.keys(fresh)) if (typeof fresh[k] === 'number') this.prm[k] = fresh[k];
    this.prm.a = saved.a; this._b.a = 1; this._clMean = 0.4;
    for (const s of this.surfaces) { s.valid = false; s.stalled = false; }
  }

  _calibrateCached(key) {
    const m = calCache(this.spec), hit = m.get(key);
    if (hit) {
      this.cal = structuredClone(hit.cal); this._trimElev = hit.trimElev;
        this._elevator = this._trimElev; this._rudder = 0; this._tailSpread = 1; this._legs = 0; this._clMean = 0.4;
    } else {
      this._calibrate();
      m.set(key, { cal: structuredClone(this.cal), trimElev: this._trimElev });
    }
  }

  /** Cycle-averaged lift curve of mid-effort cruise flapping (fixed attitude): { cl0, slope, aoaStall }. */
  _calibrateFlap() {
    const fl = this.spec.flap, P = this.prm, V = 32, rho = 1.225;
    Object.assign(P, { a: 1, amp: lerp(fl.ampMin, fl.ampMax, 0.5) * DEG, freq: lerp(fl.fMin, fl.fMax, 0.5), airspeed: V,
      down: fl.down, snap: fl.snap, fold: fl.fold, twistD: lerp(fl.twistD[0], fl.twistD[1], 0.5) * DEG, twistU: fl.twistU * DEG,
      kff: fl.kff, tuck: 0, flare: 0, beat: 0, psi0: 0 });
    P.prog.w = 0;
    const n = 64, h = 1 / (P.freq * n), q = 0.5 * rho * V * V;
    const mean = (al) => {
      const vB = new THREE.Vector3(0, -Math.sin(al) * V, Math.cos(al) * V);
      let L = 0;
      this._phase = 0; for (const s of this.surfaces) { s.valid = false; s.stalled = false; }
      this._updatePose(0);
      for (let i = 0; i < n * 2; i++) {
        this._phase += 1 / n; this._updatePose(h);
        const F = new THREE.Vector3(), T = new THREE.Vector3();
        this._aero(rho, vB, new THREE.Vector3(), F, T, null, null);
        if (i >= n) L += F.y * Math.cos(al) + F.z * Math.sin(al);
      }
      return L / n / (q * this.cal.area);
    };
    const c0 = mean(0), c1 = mean(6 * DEG);
    const flap = { cl0: c0, slope: (c1 - c0) / (6 * DEG), aoaStall: this.cal.aoaStall, clMax: 0 };
    for (let d = 8; d <= 26; d += 2) { const c = mean(d * DEG); if (c > flap.clMax) { flap.clMax = c; flap.aoaStall = d * DEG; } }
    this.cal.flap = flap;
    this._phase = 0;
  }

  // -------------------------------------------------------------------------------------------------------------
  /**
   * Virtual pilot: fly toward targetDir (world, need not be normalised) at `speed` m/s. urgency 0..1 raises the
   * allowed load factor / bank. Bank-to-turn with gravity compensation (lift-vector steering), AoA-limited pull,
   * speed hold through flap effort / glide / flare / dive, terrain and ceiling avoidance. Writes this.controls.
   */
  steer(targetDir, opts = {}) {
    const sp = this.spec, pl = sp.pilot, c = this.controls, st = this.state, env = this._env || DEFAULT_ENV;
    const speed = opts.speed ?? pl.cruise;
    const urg = clamp(opts.urgency ?? 0.4, 0, 1);
    const dt = opts.dt ?? 1 / 120;
    _d.copy(targetDir);
    if (_d.lengthSq() < 1e-8) _d.set(0, 0, 1).applyQuaternion(this.quat);
    _d.normalize();

    // Terrain / sea: predict ahead and pull up; soft ceiling pushes down; bounds turn us back toward the centre.
    const V = Math.max(st.airspeed, 5);
    if (env.heightAt && opts.avoidTerrain !== false) {
      let need = -1;
      // opts.terrainMargin [m, m per m/s] / opts.aglFloor (m) — wave 6, the player's pilot: it may come down to skim the
      // ground / the sea (≈ 10 m at 40 m/s); the look-ahead still pulls up for anything the velocity would hit
      const tm = opts.terrainMargin || [45, 0.9], floor = opts.aglFloor ?? 35;
      for (const T of [1.2, 2.4, pl.terrainLook]) {
        _v1.copy(this.pos).addScaledVector(this.vel, T);
        const gy = Math.max(env.heightAt(_v1.x, _v1.z), env.seaLevel ?? -1e9);
        const margin = tm[0] + V * tm[1];
        const deficit = gy + margin - _v1.y;
        if (deficit > 0) need = Math.max(need, clamp(deficit / (V * T), 0, 0.9));
      }
      const agl = st.agl;
      if (agl < floor) need = Math.max(need, 0.6);
      if (need > 0) { _d.y = Math.max(_d.y, need); _d.normalize(); }
    }
    const b = env.bounds;
    if (b) {
      if (b.ceiling && this.pos.y > b.ceiling - 250) { _d.y = Math.min(_d.y, -0.15 * smoothstep(b.ceiling - 250, b.ceiling, this.pos.y)); _d.normalize(); }
      const rh = Math.hypot(this.pos.x, this.pos.z);
      if (b.radius && rh > b.radius * 0.94) {
        const k = smoothstep(b.radius * 0.94, b.radius * 1.02, rh);
        _v1.set(-this.pos.x / rh, _d.y, -this.pos.z / rh).normalize();
        _d.lerp(_v1, k).normalize();
      }
    }

    // Frames.
    _fw.set(0, 0, 1).applyQuaternion(this.quat);
    _up.set(0, 1, 0).applyQuaternion(this.quat);
    _rt.set(-1, 0, 0).applyQuaternion(this.quat);
    const vh = _vh.copy(this.vel);
    if (vh.lengthSq() < 1) vh.copy(_fw);
    vh.normalize();
    // Level frame around the velocity: lvlUp = world up without its velocity component.
    _lvlUp.copy(Y).addScaledVector(vh, -vh.y);
    if (_lvlUp.lengthSq() < 1e-4) _lvlUp.copy(_up).addScaledVector(vh, -_up.dot(vh));
    _lvlUp.normalize();
    _lvlRt.crossVectors(vh, _lvlUp);             // right of the velocity, level  (fwd x up = right)

    // Desired path turn: rate toward the target, capped by the load factor we allow.
    const cosA = clamp(vh.dot(_d), -1, 1);
    const ang = Math.acos(cosA);
    _v1.copy(_d).addScaledVector(vh, -cosA);
    let perpLen = _v1.length();
    if (perpLen < 1e-5) { _v1.copy(_lvlUp); perpLen = 1; if (cosA < 0) _v1.copy(_lvlRt); }
    _v1.multiplyScalar(1 / perpLen);
    const nMax = opts.nMax ?? lerp(pl.nMax[0], pl.nMax[1], urg);
    const vs = this._stallSpeed();
    const nAero = Math.max(0.3, ((V / vs) ** 2) * 0.92);
    const nLim = Math.min(nMax, nAero);
    // opts.turnGain (1/s, the player's pilot): path-turn rate per radian of aim offset, overriding the AI's
    // urgency-scaled gain (a higher gain makes small corrections snappy; the bank limit still caps the rate)
    const kTurn = opts.turnGain ?? pl.turnGain * (0.6 + 0.6 * urg);
    const omega = Math.min(ang * kTurn, (nLim * G0) / V * 1.1);
    _aL.copy(_v1).multiplyScalar(V * omega);
    // + gravity compensation (lift must also hold us up)
    const gy = G0;
    _aL.addScaledVector(_lvlUp, gy * Math.sqrt(Math.max(0, 1 - vh.y * vh.y)));
    let aLat = _aL.dot(_lvlRt), aUp = _aL.dot(_lvlUp);
    // Over the load limit: keep the vertical part (hold altitude), give up turn rate first.
    const aMax = nLim * G0;
    if (aLat * aLat + aUp * aUp > aMax * aMax && Math.abs(aUp) < aMax) aLat = Math.sign(aLat) * Math.sqrt(aMax * aMax - aUp * aUp);
    const aLatDemand = aLat;                      // (before the bank-limit coordination: the turn-entry side force's demand)
    // opts.bankMax (deg, the player's pilot): a hard bank limit with COORDINATION — at the limit the pilot gives up
    // turn rate instead of pulling through (a clamped bank with the full lateral demand turns into a climbing turn).
    const coord = opts.bankMax != null;
    const bankMax = (coord ? opts.bankMax : lerp(pl.bankMax[0], pl.bankMax[1], urg)) * DEG;
    // Steep climb and the target lies "over the top" (below the path): a push-over at -0.5 g would hang the dragon
    // in a vertical zoom until it stalls (a gust or a mouse zoom-climb). Roll the lift vector toward the target
    // instead (up to inverted) and pull: the half-roll / wingover recovery.
    const overTop = vh.y > 0.7 && aUp < 0 && !opts.dive;   // (wave 4: > 44°, was 24° — a 40° climb-out after a crash half-rolled 50 m above the ground)
    let bankDes = aUp >= 0 || overTop ? Math.atan2(aLat, aUp) : Math.atan2(aLat, gy);
    if (!overTop) {
      const b0 = bankDes;
      bankDes = clamp(bankDes, -bankMax, bankMax);
      if (coord && b0 !== bankDes && aUp > 0) aLat = aUp * Math.tan(bankDes);
    }
    let nDes = (aLat * Math.sin(bankDes) + aUp * Math.cos(bankDes)) / G0;
    nDes = clamp(nDes, opts.dive ? -1 : -0.5, nLim);

    // Roll: current bank about the velocity axis.
    const bankNow = Math.atan2(_up.dot(_lvlRt), _up.dot(_lvlUp));
    // opts.skid (the player's pilot, 0..1 scale): turn-entry side force for the part of the lateral demand the bank
    // does not deliver yet (lift · sin bank), same direction only (never a counter-skid), off in the stoop / recovery.
    // It fades out as the bank reaches the pilot's bank (55 → 90 % of it): a transient of the roll-in, never a
    // sustained sideways push in a held turn.
    // Small corrections (a pending turn below opts.skidSmall = [20°, 35°]) keep it through the turn while the bank stays
    // gentle (the player's bank limit grows with the pending turn): the critic's "turn the nose without waiting for
    // the bank" for micro-aiming, bounded by skidG.
    if (opts.skid && !opts.dive && !(this._recover > 0)) {
      const have = G0 * Math.max(0, st.gLoad) * Math.sin(bankNow);
      const miss = aLatDemand - have;
      const prog = (bankNow * Math.sign(bankDes || 1)) / Math.max(Math.abs(bankDes), 10 * DEG);
      const sm = opts.skidSmall || [20 * DEG, 35 * DEG];
      const fade = Math.max(1 - smoothstep(sm[0], sm[1], ang), 1 - smoothstep(0.7, 0.95, prog));
      c.skid = miss * aLatDemand > 0 ? clamp(miss / (G0 * (sp.control.skidG || 0.4)), -1, 1) * opts.skid * fade : 0;
    } else c.skid = 0;
    const rollErr = wrapPi(bankDes - bankNow);
    const kRoll = opts.rollGain ?? 2.6 + 2.2 * urg;   // opts.rollGain (1/s): the player's snappier roll-in
    let pDes = kRoll * rollErr;
    if (opts.rollRate) {
      // Shaped roll (the player's pilot): the roll rate is capped (opts.rollRate deg/s), the command ramps with a
      // bounded angular acceleration (opts.rollAccel deg/s², default 600) and brakes on a sqrt profile, so the bank
      // eases in and out instead of snapping — the neck and tail chains then follow without whipping.
      const pm = opts.rollRate * DEG, am = (opts.rollAccel ?? 600) * DEG, e = Math.abs(rollErr);
      pDes = Math.sign(rollErr) * Math.min(Math.abs(pDes), pm, Math.sqrt(2 * am * 0.8 * e));
      // the ramp starts from the body's own roll rate only when the pilot was not steering the step before (after a
      // dodge script, a grab, a spawn); never from a transient spike, which would latch the command at full stick
      let prev = this._rollRef;
      if (!Number.isFinite(prev) || !(this._rollRefAge <= 3 * dt + 1e-6)) prev = clamp(this._wb.z, -pm, pm);
      pDes = prev + clamp(pDes - prev, -am * dt, am * dt);
      this._rollRef = pDes; this._rollRefAge = 0;
    } else this._rollRef = NaN;
    c.roll = clamp(pDes / sp.control.pMax, opts.rollRate ? -1.4 : -1, opts.rollRate ? 1.4 : 1);
    // Pull only as much as the bank is right.
    const align = Math.max(0, Math.cos(rollErr));
    const nEff = lerp(Math.cos(bankNow) * Math.sqrt(Math.max(0, 1 - vh.y * vh.y)), nDes, align * align);
    // opts.loadHold (the player's pilot): keep the wings spread through the upstroke while a pull is asked for
    c.load = opts.loadHold ? smoothstep(1.12, 1.8, Math.max(nDes, nEff)) : 0;
    // Load factor -> AoA through the calibrated lift curve; an integrator on the filtered g trims the flapping bias.
    const qd = 0.5 * (this._rho || 1.1) * V * V;
    const clDes = (nEff * this.mass * G0) / Math.max(qd * this._area, 1);
    const inProg = !!this._prog || !!this._move;
    // integrate against the cycle-averaged load factor (the per-beat heave must not drive the pitch loop)
    if (!inProg) this._nI = clamp(this._nI + (nEff - this._nSlow) * dt * 0.12, -9 * DEG, 12 * DEG);
    // Stall guard: the glide-pose stall AoA, raised while flapping (the upstroke unloads), lowered as soon as
    // strips actually stall (integrator on the stalled fraction).
    // cycle-averaged separation: some downstroke separation is normal while flapping
    this._stallSlow = (this._stallSlow ?? 0) + (st.stalled - (this._stallSlow ?? 0)) * damp(1.5, dt);
    this._stallI = clamp((this._stallI || 0) + (this._stallSlow - (this._b.a > 0.5 ? 0.22 : 0.1)) * dt * 0.4, 0, 0.14);
    const fa = clamp(this._b.a, 0, 1), cf = this.cal.flap;
    const cl0 = lerp(this.cal.cl0, cf.cl0, fa), slope = lerp(this.cal.slope, cf.slope, fa);
    const aStallBody = lerp(this.cal.aoaStall, cf.aoaStall, fa) - this._stallI;
    let aoaDes = (clDes - cl0) / Math.max(slope, 0.5) + this._nI;
    aoaDes = clamp(aoaDes, -12 * DEG, aStallBody - 2 * DEG);
    // path pitch rate in the lift plane for this load factor -> the body must rotate with it
    const qFF = (nEff - Math.cos(bankNow) * Math.sqrt(Math.max(0, 1 - vh.y * vh.y))) * G0 / V;
    const qCmd = qFF + (opts.pitchGain ?? 3.2) * (aoaDes - st.aoa);
    c.pitch = clamp(qCmd / sp.control.qMax, -1, 1);
    // Yaw: turn-rate feed-forward (a banked turn needs body yaw rate = Omega cos(bank)) + kill sideslip.
    const turnRate = (st.gLoad * G0 * Math.sin(bankNow)) / V;
    // (the player's shaped roll also rolls about the VELOCITY axis: at an AoA the body must yaw with the roll, r = p sin α,
    //  or a fast roll-in builds sideslip whose side force pushes the path the wrong way before the turn starts)
    const rollFF = opts.rollRate ? pDes * Math.sin(clamp(st.aoa, -0.3, 0.5)) * (opts.rollYaw ?? 1) : 0;
    // (+ the path turn rate of the turn-entry side force, so the nose follows the path instead of skidding)
    const skidRate = c.skid ? (c.skid * (sp.control.skidG || 0) * G0 * Math.min(1.5, (V * V) / (34 * 34))) / V : 0;
    c.yaw = clamp((turnRate * _up.y + skidRate * Math.max(0, _up.y) + (opts.betaGain ?? 3) * st.sideslip + rollFF) / sp.control.rMax, -1, 1);

    // Speed and energy: flap effort PI, glide when fast, flare when much too fast, dive when asked and far below.
    const eV = speed - V;
    this._speedI = clamp(this._speedI + eV * dt * 0.05, -0.4, 0.4);
    let effort = clamp(0.45 + 0.09 * eV + this._speedI, 0, 1);
    // hard turns cost energy: flap harder under load
    effort = clamp(effort + 0.25 * Math.max(0, st.gLoad - 1.3), 0, 1);
    c.flap = effort;
    c.glide = eV < -4 && !opts.noGlide ? 1 : 0;
    // automatic air brake only for a large overspeed (gliding handles the rest; S is the player's hard brake)
    c.flare = opts.allowFlare !== false ? clamp((-eV - 18) / 12, 0, 0.8) : 0;
    if (V < vs * 1.15) { c.glide = 0; c.flap = 1; c.flare = 0; }
    // Dive = stoop: push over with the wings half open (negative lift bends the path fast), tuck once it is steep.
    const pathDeg = Math.asin(clamp(vh.y, -1, 1)) / DEG;
    c.dive = opts.dive ? (pathDeg < -24 || _d.y > -0.3 ? 1 : 0.45) : 0;
    // Tumble / deep-stall recovery: tuck the wings (the tail and body then weathercock the nose into the wind).
    const aoaLim = (this._b.flare > 0.3 ? 62 : 40) * DEG;
    const tumbling = Math.abs(st.aoa) > aoaLim || Math.abs(st.sideslip) > 45 * DEG;
    this._recover = tumbling ? 0.6 : Math.max(0, (this._recover || 0) - dt);
    if (this._recover > 0) { c.dive = 1; c.flap = 0; c.flare = 0; c.pitch = clamp(-3 * st.aoa / sp.control.qMax, -1, 1); }
    if (c.dive) { c.glide = 1; c.flare = 0; }
    c.boost = opts.boost ? 1 : 0;
    this._pilot = { bankDes, nDes, aoaDes, rollErr, omega };
    return c;
  }

  /** 1 g stall speed of the glide pose at the current air density (m/s). */
  _stallSpeed() {
    const rho = this._rho || 1.1;
    return Math.sqrt((2 * this.mass * G0) / (rho * this.cal.area * Math.max(this.cal.clMax, 0.3)));
  }
}
