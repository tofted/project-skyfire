// game.player (system 'player', order 30): creates the player's Dragon (Sora + Kaede), sets game.player = dragon and
// turns input into pilot intent every fixed step. Mouse aim: the dragon steers toward game.cameraRig.aimDir (the
// camera freezes it during the RMB/Alt free-look orbit, and so does this system, so orbiting never changes course).
// Fallback aim from raw mouse deltas when no camera rig is loaded. In the title state the dragon flies an autopilot
// circuit behind the menu. Also owns the player's WEAPONS for whatever dragon it flies (real Dragon or stand-in):
// LMB edges -> game.fx.breath(dragon, on) with heat / overheat lockout, F -> game.fx.fireball (2 charges, recharge,
// lock-on or aim-assist target, small homing). Public state on the dragon: dragon.heat (0..1), dragon.overheated,
// dragon.fireball = { ready, cooldown, cooldownMax, charges, maxCharges }, dragon.stamina, dragon.grabbed.
// Titan grab ('titan:grab' caught) suspends piloting until 'thrown' / 'released'.
//
// Controls (contract): Mouse aim | W beat harder | S flare/brake | A/D bank | Q/E or double-tap A/D dodge |
// Space power beat | Shift boost | Ctrl tuck + dive | LMB breath | F fireball. Gamepad: left stick pitch/roll,
// RT breath, LT brake, A power beat, B dodge, X fireball, LB boost, RB dive.
import * as THREE from 'three';
import { FlightBody, DRAGON_SPECS, makeEnv } from './flight.js';
import { clamp, damp, smoothstep } from '../core/util.js';

const DEG = Math.PI / 180;
const START = { pos: new THREE.Vector3(-1500, 1350, -2600), heading: 32 * DEG };
const TITLE_CIRCUIT = { center: new THREE.Vector3(-1200, 1300, -1900), radius: 850, speed: 31 };
// Weapons (wave 2): ~4.5 s of continuous breath overheats -> 2 s lockout; cooling starts 0.25 s after release.
export const WEAPONS = {
  heat: { rise: 1 / 4.5, cool: 0.5, coolDelay: 0.25, lockout: 2.0 },
  fireball: {
    maxCharges: 2, recharge: 2.5, gap: 0.3, speed: 90, radius: 1.4, damage: 45,
    homing: { accel: 12, duration: 2.2 },            // small: bends the shot, never a guaranteed hit (fix pass: 26 → 12)
    assistAngle: 9 * DEG, assistDist: 1100, leadMaxAngle: 25 * DEG, recoil: 350,
    // fix pass (the adversarial playtest: inside the soft-target cone the shot went exactly to the lead point, 10–18° off
    // the reticle, and homed hard — the reticle did not matter, the fireball did 91–95 % of the damage): the shot turns
    // from the reticle ray toward the lead point by at most `bend`; the full lead only while the reticle is within
    // fullLead[0]..[1] of the target itself (it fades out between). The rest is the bounded homing. See fireballAim().
    bend: 4.5 * DEG, fullLead: [3 * DEG, 5 * DEG],
    // (the same fix pass: a hovering dragon is a steady turret — its fireball charges come back hoverRecharge × slower,
    //  by the hover weight; flying, as before. The breath and flying back into the fight pay; the HUD ring shows it)
    hoverRecharge: 1.3,
  },
};
const GRAB = { maxHold: 6, recoverThrown: 0.45, recoverReleased: 0.2 };
const TITLE_GLIDE_AT = 2.9; // s of the title clock where its first glide spell (sin(0.21 t) > 0.55) begins
// Feel fix (user: "the dragon breaks when it turns"): the player's pilot banks <= 55° in normal turns and up to 75°
// only for a big pending turn; the roll eases in (rate cap + bounded roll acceleration) instead of snapping.
// Wave 4 (critic: "the aim is sluggish, 0.45 s to react, 1.7 s for 20°"): the same bank limits, but a snappier pilot —
// a faster roll-in (higher roll gain / rate / ramp), a higher path-turn gain for small leads, a firmer AoA loop, the
// roll coordinated about the flight path (no sideslip kick) and the wings kept loaded through the upstroke while it
// pulls; small corrections bank gently (bankSmall) and get the turn-entry side force through the turn (skid). Node,
// 34 m/s, 6 wingbeat phases: 20° within 5° in 0.80–0.97 s (was 1.39–1.61), heading moves 1° after 0.13–0.16 s (was
// 0.26–0.47), bank ≤ 44° for a 20° correction (≤ 42° for the feel test's 18° sweep), 57–59° for 45°.
export const FEEL = {
  bank: [55, 73.5],          // deg: bank limit at urgency 0 / 1 (steer coordinates the turn at the limit). Wave 5: 75 → 73.5 —
                             //   the deeper cruise stroke (wingkin STROKE_SHAPE) rolls ~1° further past the limit; the
                             //   measured peaks stay where they were (feel-pilot 65° turn: 65.4° (wave 4: 65.0°), 120°: 75.2°)
  bankSmall: [24, 1.0],      // small turns bank gently: limit ≤ 24° + 1.0 × the pending turn (deg) — 18° → 42°, 31°+ → 55°
  rollRate: [180, 200],      // deg/s: roll-rate cap at urgency 0 / 1 (feel fix: 90 … 130)
  rollAccel: 2500,           // deg/s²: roll command ramp (feel fix: 1200)
  rollGain: 7,               // 1/s: roll rate per radian of bank error (AI: 2.6 … 4.8) — the bank arrives in ~0.3 s
  turnGain: [2.0, 2.3],      // 1/s at urgency 0 / 1: path-turn rate per radian of aim offset (AI: 0.96 … 1.9)
  pitchGain: 5,              // 1/s: pitch rate per radian of AoA error (AI: 3.2)
  betaGain: 6,               // 1/s: yaw rate per radian of sideslip (AI: 3)
  rollYaw: 2,                // roll about the flight path: yaw feed-forward p·sin(AoA) × this (adverse-yaw margin)
  loadHold: true,            // wings spread + loaded through the upstroke while the pilot pulls (controls.load)
  skid: 1,                   // turn-entry side force: roll-in of every turn, all of a small one (steer opts.skid, spec.control.skidG)
  urgentFrom: 20 * DEG,      // remaining turn (target vs course) where urgency starts (feel fix: 32°)
  urgentAt: 100 * DEG,       //   … and where it is full (feel fix: 110°)
  kbRate: 60 * DEG,          // rad/s: A / D turn rate of the fallback aim (no camera rig)
  // wave 6: the terrain look-ahead margin of the player's pilot (m + m per m/s) and its hard floor (m AGL), so a skim
  // 3–20 m over the ground / the sea is reachable (the AI keeps 45 m + 0.9·V and 35 m); the Ctrl stoop keeps the AI's
  skimTerrain: { margin: [5, 0.12], floor: 4 },
};
const mixF = (a, u) => a[0] + (a[1] - a[0]) * u;

// ---------------------------------------------------------------------------------------------------------------
// Flight moves (wave 6, the user: "make the dragon controls more interesting"). The manoeuvres themselves are
// FlightBody pilot programs (flight.js spec.moves); this system maps the keys onto them and owns the meters:
//   Space + A / D  wingover left / right     Space + S  loop (Immelmann)     W W (double tap)  dash
//   hold F         charge a fireball (0 → 1 over 1.2 s), release fires it (a tap = the normal fireball)
//   R              INFERNO, when the special meter is full (4 s super breath)
// Meters on game.player: moves { current, t, side, phase, u, queued }, momentum 0..1 (fast dives) → SKYFALL on the
// pull-out (3 s: breath / fireball damage × 1.5, faster fireballs), special 0..1 (hits, kills, close calls),
// fireCharge 0..1, infernoActive, skim 0..1 (3–20 m over a cloud top / the ground, fast: a push + stamina).
// Events: move, nearmiss, skim, momentum, charge, special (see docs/modules/flight.md "Flight moves").
// ---------------------------------------------------------------------------------------------------------------
// Fix pass (critic #2 / #5 / #8, misfire.json): the chords are real chords and the double taps are strict.
//  - Space + A / D / S in EITHER order: a direction key pressed ≤ lead s before Space (and still held), or ≤ lag s after
//    it (the power beat that already started becomes the move; FlightBody gives its stamina back). A key held longer
//    than lead before Space is a turn / a brake: Space is then the power beat (a player turning with D who beats to
//    climb, or braking with S, no longer gets a 180° reversal).
//  - A / D double tap → the dodge waits dodgeWait s: a Space in that time makes it the wingover instead (a D nudge,
//    then D + Space, was a dodge that swallowed the wingover). Q / E stay instant.
//  - W W → dash only from two SHORT taps (each < tap s, the second pressed < gap s after the first): feathering the
//    throttle (W every 220 ms) or a quick re-grip into a hold is throttle, never a dash. It fires on the 2nd release.
export const MOVE_KEYS = { doubleTap: 0.28, chord: { lead: 0.2, lag: 0.12, dodgeWait: 0.1 }, dash: { tap: 0.15, gap: 0.2 } };
// ---------------------------------------------------------------------------------------------------------------
// Flight modes (the user: "make the dragon NOT always fly forward — only with a button; aiming is a bit hard").
//   HOVER (no W, slow): the dragon holds the air on hovering wingbeats (FlightBody.hoverSteer): the mouse turns it and
//     aims, A / D strafe, Space climbs, Ctrl sinks, S drifts back, Q / E dodge, W W = a forward burst into flight.
//   FLIGHT (W held): it tips forward and rows up to the cruise (~34 m/s) — everything of before (mouse aim, banked
//     turns, Shift boost, S brake, Ctrl stoop, Space beat and the chords, W W dash, skims, close calls).
//   W released: the flare (the flight pilot's air brake) and the hover controller's back-beat stop it within ~2–3 s,
//     unless it dives (Ctrl) or a move runs. game.player.flightMode 'hover' | 'flight' | 'transition', throttle 0..1.
// flightModeStep() is the (pure) mode machine: hover → toFlight (W) → flight (≥ flightV) → toHover (W released) →
// hover (slow, the hover stroke in). toFlight / toHover publish as 'transition'.
export const MODES = {
  hoverV: 15,          // m/s: without W the dragon settles into the hover below this (a dive does not)
  flightV: 21,         // m/s: the W transition hands over to the flight pilot here (above the 1 g stall, 18.9 m/s)
  brakeV: 30,          // m/s: the flare out of flight hands over to the hover controller's back-beat below this
  settledV: 3.5,       // m/s: … and it is 'hover' again below this with the hover stroke in (hover weight > 0.9)
  throttle: [2.2, 3],  // 1/s: throttle → 1 while W is held, → 0 when released
  vFwd: 30, aFwd: 1.15, aFwdBoost: 1.4,   // the W transition: forward speed wanted, acceleration bound (g), with Shift
  keepAfterDash: 1.4,  // s: a dash out of the hover flies on this long before a released W flares it back
  releaseGrace: 0.18,  // s: W let go this briefly (a feathered throttle, the W W double tap of the dash) does not flare yet
  power: 30,           // m/s: in flight below this W means power strokes (controls.hard) up to the cruise
};
export function newFlightMode(mode = 'hover') { return { mode, throttle: mode === 'flight' ? 1 : 0, t: 0, keepUntil: -1e9, offT: 1e9 }; }
/** One step of the flight-mode machine. W / dive: keys held; busy: a wingover / loop / dash runs; V: airspeed (m/s);
 *  hoverW: the FlightBody's hover weight (state.hover). Returns the mode 'hover' | 'toFlight' | 'flight' | 'toHover'. */
export function flightModeStep(M, { W = false, dive = false, busy = false, now = 0, V = 0, hoverW = 0, dt = 1 / 120 } = {}) {
  const K = MODES;
  M.throttle = clamp(M.throttle + (W ? K.throttle[0] : -K.throttle[1]) * dt, 0, 1);
  M.offT = W ? 0 : (M.offT || 0) + dt;
  const keep = now < M.keepUntil || M.offT <= K.releaseGrace, prev = M.mode;
  switch (M.mode) {
    case 'hover':
      if (W) M.mode = 'toFlight';
      else if (busy) M.mode = 'flight';                                  // (a dash out of the hover)
      else if (V > K.brakeV + 3) M.mode = 'toHover';                    // thrown / knocked: brake it
      break;
    case 'toFlight':
      if (busy || V >= K.flightV) M.mode = 'flight';
      else if (!W) M.mode = V < K.settledV && hoverW > 0.9 ? 'hover' : 'toHover';
      break;
    case 'flight':
      if (!W && !dive && !busy && !keep) M.mode = 'toHover';
      break;
    case 'toHover':
      if (busy) M.mode = 'flight';
      else if (W) M.mode = V >= K.flightV ? 'flight' : 'toFlight';
      else if (dive && V > K.hoverV) M.mode = 'flight';                 // Ctrl at speed: the stoop, not the flare
      else if (V < K.settledV && hoverW > 0.9) M.mode = 'hover';
      break;
    default: M.mode = V > K.hoverV ? 'toHover' : 'hover';
  }
  M.t = M.mode === prev ? M.t + dt : 0;
  return M.mode;
}
export const flightModeName = (m) => (m === 'hover' || m === 'flight' ? m : 'transition');

// Aim assist (the user: "aiming is a bit hard"). player.js decides, the HUD / camera / fx render it:
//   game.player.softTarget: the enemy nearest the reticle within soft.angle° (its angular radius counted) and soft.dist m
//     of the dragon (a Tab lock is preferred within lockAngle° / lockDist m), kept while within keep° (no flicker);
//   magnetism: the aim the dragon flies / turns / aims its head along bends ≤ magnet° toward the target's lead point;
//   breath: within breathCone° (seen from the mouth) the head looks at the target's lead point (dragon.lookTarget), so
//     the flame goes there; game.player.inRange: the breath reaches it (fx breath maxRange, × 1.5 in the inferno);
//   fireball: an intercept lead on the soft target, the turn off the reticle bounded (WEAPONS.fireball.bend / fullLead,
//     fireballAim()), then a small homing; the titan's core (the weak point) only while it is OPEN and the reticle is
//     within titanCore° of it — then the shot homes on the core itself (fix pass: the core was picked within 10° whether
//     open or not and every shot homed on its live point — a hovering dragon won the titan fight in ~70 s, 29/30 hits).
export const AIM = { angle: 8 * DEG, dist: 450, keep: 11 * DEG, lockAngle: 16 * DEG, lockDist: 700, magnet: 3 * DEG,
  breathCone: 12 * DEG, titanCore: 4 * DEG, flame: 70, radiusMax: 7 };
/** Intercept time (s) for a shot of speed s (relative to the shooter) at a target at rel (target − muzzle, m) moving
 *  at vRel (target − shooter velocity, m/s). Falls back to dist / s. */
export function interceptTime(rel, vRel, s) {
  const a = vRel.lengthSq() - s * s, b = 2 * rel.dot(vRel), c = rel.lengthSq();
  let t = NaN;
  if (Math.abs(a) < 1e-6) t = b < 0 ? -c / b : NaN;
  else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const r = Math.sqrt(disc), t1 = (-b - r) / (2 * a), t2 = (-b + r) / (2 * a);
      t = Math.min(t1 > 0 ? t1 : Infinity, t2 > 0 ? t2 : Infinity);
    }
  }
  if (!(t > 0 && t < 8)) t = Math.sqrt(c) / Math.max(s, 1);
  return t;
}

const _fa1 = new THREE.Vector3(), _fa2 = new THREE.Vector3(), _fa3 = new THREE.Vector3();
/**
 * The fireball's launch direction (pure; the player's aim assist, fix pass). aimD: the reticle as seen from the mouth
 * (unit); mouth, point (the target point, world), vRel (target − dragon velocity, m/s), sRel (the shot's speed relative
 * to the dragon), r (the target's radius, m, capped at AIM.radiusMax). The shot turns from aimD toward the intercept
 * lead point by at most WEAPONS.fireball.bend — plus the lead itself while the reticle is within fullLead of the target
 * (fading out between fullLead[0] and [1]); a lead point more than leadMaxAngle off the reticle is not turned to at all.
 * Returns { dir (unit, out), lead (world, out2), t (s), off (the reticle's miss of the target, rad), leadAng (rad),
 * turn (rad, the turn off the reticle), full (0..1) }.
 */
export function fireballAim(aimD, mouth, point, vRel, sRel, r = 0, out = new THREE.Vector3(), out2 = new THREE.Vector3()) {
  const FB = WEAPONS.fireball;
  const rel = _fa1.subVectors(point, mouth), dist = rel.length();
  const t = Math.min(3, interceptTime(rel, vRel, sRel));
  const lead = out2.copy(point).addScaledVector(vRel, Number.isFinite(t) ? t : 0);
  const dL = _fa2.subVectors(lead, mouth);
  out.copy(aimD);
  if (!(dist > 1) || !(dL.lengthSq() > 1)) return { dir: out, lead, t, off: 0, leadAng: 0, turn: 0, full: 0 };
  dL.normalize();
  const dT = rel.multiplyScalar(1 / dist);
  const off = Math.max(0, Math.acos(clamp(aimD.dot(dT), -1, 1)) - Math.atan(Math.min(r || 0, AIM.radiusMax) / dist));
  const leadAng = Math.acos(clamp(dT.dot(dL), -1, 1));
  const need = Math.acos(clamp(aimD.dot(dL), -1, 1));
  const full = 1 - smoothstep(FB.fullLead[0], FB.fullLead[1], off);
  let turn = 0;
  if (need > 1e-6 && need <= FB.leadMaxAngle) {
    turn = Math.min(need, FB.bend + full * leadAng);
    const ax = _fa3.crossVectors(aimD, dL);
    const al = ax.length();
    if (al > 1e-9) out.applyAxisAngle(ax.multiplyScalar(1 / al), turn); else turn = 0;
  }
  return { dir: out.normalize(), lead, t, off, leadAng, turn, full };
}

/** Space pressed with these keys held → the move it asks for (null: the plain power beat). A XOR D wins over S. */
export function moveFromKeys({ A = false, D = false, S = false } = {}) {
  if (A !== D) return { name: 'wingover', side: A ? -1 : 1 };
  if (S) return { name: 'loop', side: 1 };
  return null;
}

/**
 * The move-key reader (pure, shared by pollEdges and the node tests): feed it one frame's edges and held keys with the
 * frame's real time; it returns what the frame asks for — { beat, move, dodge } — and keeps its own timers in `K`
 * (makeKeyReader()). f = { now, space (pressed), A / D / S { pressed, down }, tapA / tapD (pressed, for the double tap),
 * Q / E (pressed), W { pressed, released, down } }.
 */
export function makeKeyReader() {
  return { at: { A: -1e9, D: -1e9, S: -1e9 }, space: null, dodge: null, taps: { A: -1, D: -1 }, w: { d1: -1, u1: -1, d2: -1 } };
}
export function readMoveKeys(K, f) {
  const C = MOVE_KEYS.chord, DT = MOVE_KEYS.dash, now = f.now;
  const out = { beat: false, move: null, dodge: 0, chord: null };
  for (const k of ['A', 'D', 'S']) if (f[k]?.pressed) K.at[k] = now;
  const used = { A: false, D: false };
  if (f.space) {
    const fresh = (k) => !!f[k]?.down && now - K.at[k] <= C.lead + 1e-9;
    const mv = moveFromKeys({ A: fresh('A'), D: fresh('D'), S: fresh('S') });
    if (mv) { out.move = mv; out.chord = 'before'; K.space = null; }
    else { out.beat = true; K.space = { t: now }; }
  } else if (K.space && now - K.space.t <= C.lag + 1e-9) {
    const p = (k) => !!f[k]?.pressed && !!f[k]?.down;
    const mv = moveFromKeys({ A: p('A'), D: p('D'), S: p('S') });
    if (mv) { out.move = mv; out.chord = 'after'; K.space = null; if (mv.name === 'wingover') used[mv.side < 0 ? 'A' : 'D'] = true; }
  }
  if (K.space && now - K.space.t > C.lag) K.space = null;
  // double tap A / D (the dodge, delayed by dodgeWait; a wingover chord in that time cancels it)
  for (const [k, dir] of [['A', -1], ['D', 1]]) {
    if (!f['tap' + k] || used[k]) { if (used[k]) K.taps[k] = -1; continue; }
    if (K.taps[k] > 0 && now - K.taps[k] < MOVE_KEYS.doubleTap) { K.dodge = { dir, t: now }; K.taps[k] = -1; }
    else K.taps[k] = now;
  }
  if (f.Q) { out.dodge = -1; K.dodge = null; } else if (f.E) { out.dodge = 1; K.dodge = null; }
  if (K.dodge) {
    if (out.move?.name === 'wingover') K.dodge = null;
    else if (now - K.dodge.t >= C.dodgeWait - 1e-9) { if (!out.dodge) out.dodge = K.dodge.dir; K.dodge = null; }
  }
  // W W: two short taps → dash (on the 2nd release); the order of a press + release inside one frame follows `down`
  const w = K.w, W = f.W || {};
  const evs = W.pressed && W.released ? (W.down ? ['up', 'down'] : ['down', 'up']) : W.pressed ? ['down'] : W.released ? ['up'] : [];
  for (const e of evs) {
    if (e === 'down') {
      if (w.d1 >= 0 && w.u1 >= 0 && w.u1 - w.d1 < DT.tap && now - w.d1 < DT.gap) w.d2 = now;
      else { w.d1 = now; w.u1 = -1; w.d2 = -1; }
    } else if (w.d2 >= 0) {
      if (now - w.d2 < DT.tap && !out.move) out.move = { name: 'dash', side: 0 };
      w.d1 = -1; w.u1 = -1; w.d2 = -1;
    } else if (w.d1 >= 0 && w.u1 < 0) w.u1 = now;
  }
  if (w.d2 >= 0 && now - w.d2 >= DT.tap) { w.d1 = -1; w.u1 = -1; w.d2 = -1; }   // the 2nd press became a hold: throttle
  return out;
}
// Charged fireball (fix pass, critic #6: "×2.6 for 1.2 s of holding, no trade-off: one-shots rookies, 878 into the
// titan's open core"): damage × (1 + damage·level) = 45 → 79 at full, and the charge it spends recharges
// (1 + recharge·level) × slower (2.5 → 4 s at full): sustained, charged shots deal ~1.1× the taps' damage.
export const CHARGE = { time: 1.2, tap: 0.2, damage: 0.75, recoil: 1, recharge: 0.6 };   // level = held / time; below tap: a normal shot
export const INFERNO = { dur: 4 };
export const SPECIAL = { hit: 0.08, kill: 0.2, close: 0.1, fireGap: 2 };   // + per landed hit (breath: once per target per fireGap s) / kill / close call
export const SKYFALL = { mult: 1.5, speed: 1.35 };                            // fireball damage / launch speed while on

// ---------------------------------------------------------------------------------------------------------------
// Levels and elements (the user: "the more enemies the dragon kills, the higher its level; each level the fire hits
// harder and the HP grows; the fire changes colour, and later it shoots lightning instead of fire"). game.progress
// (system 'progress', src/actors/progression.js, the gameplay owner) keeps the level / xp / tier / element; this system
// APPLIES it to Sora (feature-detected: without game.progress Sora is level 1 ember, exactly as before):
//   - max HP = base × hpMult (re-synced every fixed step and on 'levelup'); a level-up also heals the HP it adds;
//   - fireball / bolt damage × dmgMult (the breath's ticks: fx applies game.progress.dmgMult itself);
//   - the element goes to fx.breath(src, on, { mode, element }) and fx.fireball({ …, element });
//   - tier ≥ 4 (lightning, storm): F fires a LIGHTNING BOLT (BOLT: fast, its own lead / recharge, chain arcs to
//     game.progress.chain enemies within chainRange at chainMult per jump; a charged bolt is bigger and chains +1 / +2);
//     R's inferno becomes the STORM SURGE (the inferno's super breath in the lightning element + a free full-charge
//     opening bolt).
// ---------------------------------------------------------------------------------------------------------------
export const ELEMENTS = ['ember', 'azure', 'radiant', 'lightning', 'storm'];
export const BOLT_ELEMENTS = new Set(['lightning', 'storm']);
// the lightning bolt (tier ≥ 4). speed: m/s relative to the dragon (fx.config.bolt.speed wins when fx sets one; a bolt fx
// calls `instant` is led as a hitscan); damage per hit before dmgMult / charge / skyfall (the fireball's 45 has a
// 50 % splash, the bolt instead jumps to `chain` enemies within chainRange m at chainMult of the hit). 48, not 40: the
// first bolt (L7, × 1.72 = 82.6) must hit harder than the L6 fireball it replaces (45 × 1.6 = 72) — at 40 the number
// on screen DROPPED at the level-up whose card says "+12% DAMAGE" (the playtester's fix pass); chargedChains: + chains
// at a full charge (+1 from half); recharge s per charge (the same 2 charges, the hover's 1.3× slower recharge too)
// lockCone: fx homes a bolt hard (config.lightning.bolt.homing 520 m/s² for 1 s) and re-aims it ≤ 7° at the intercept
// whenever it is given a target — so the target is handed over only while the reticle is within lockCone of it (its
// angular radius counted; = WEAPONS.fireball.fullLead[1]); farther off the bolt flies straight along the bounded
// fireballAim() direction (≤ 4.5° off the reticle) and has to be aimed (the fix pass: the reticle must matter)
export const BOLT = { tier: 4, speed: 320, radius: 1.1, damage: 48, recharge: 2.5, recoil: 220,
  homing: { accel: 12, duration: 1.0 }, chainRange: 25, chainMult: 0.6, chargedChains: 2, lockCone: 5 * DEG };
// the storm surge (the inferno at tier ≥ 4): opens with a free bolt at this charge level (no charge spent)
export const SURGE = { opener: 1 };
/** The level's tier (1..5): L1–2 ember, L3–4 azure, L5–6 radiant, L7–8 lightning, L9–10 storm. */
export const tierOfLevel = (level) => clamp(Math.ceil((+level || 1) / 2), 1, 5);
/**
 * game.progress as the player's weapons read it (pure, never throws): { level, tier, element, dmgMult, hpMult, chain,
 * bolt (the F key fires a lightning bolt), live (a real progress system was read) }. Missing / broken fields fall back to
 * the contract's formulas for the level (dmgMult 1 + 0.12 (L − 1), hpMult 1 + 0.08 (L − 1), chain 3 lightning / 5 storm).
 */
export function progressView(p) {
  const ok = !!p && typeof p === 'object';
  const num = (v, d, lo, hi) => (Number.isFinite(+v) && v !== null && v !== '' ? clamp(+v, lo, hi) : d);
  let level = 1, tier = 1, element = 'ember', dmgMult = 1, hpMult = 1, chain = 0, chainRange = 0;
  try {
    if (ok) {
      level = Math.round(num(p.level, 1, 1, 99));
      tier = Math.round(num(p.tier, tierOfLevel(level), 1, 5));
      element = ELEMENTS.includes(p.element) ? p.element : ELEMENTS[tier - 1];
      dmgMult = num(p.dmgMult, 1 + 0.12 * (level - 1), 0.25, 10);
      hpMult = num(p.hpMult, 1 + 0.08 * (level - 1), 0.25, 10);
      chain = Math.round(num(p.chain, element === 'storm' ? 5 : element === 'lightning' ? 3 : 0, 0, 12));
      chainRange = num(p.chainRange, 0, 0, 120);           // progression's bolt jump range (lightning 50 / storm 60 m)
    }
  } catch { level = 1; tier = 1; element = 'ember'; dmgMult = 1; hpMult = 1; chain = 0; chainRange = 0; }
  return { level, tier, element, dmgMult, hpMult, chain, chainRange, bolt: BOLT_ELEMENTS.has(element), live: ok };
}
/** Max HP for a base and the level's hpMult (whole HP). */
export const levelMaxHp = (base, hpMult) => Math.max(1, Math.round((+base > 0 ? +base : 600) * (+hpMult > 0 ? +hpMult : 1)));
/**
 * The shot F fires (pure): pv = progressView(), charge 0..1 (0 = a tap), skyfall, boltCfg (fx.config.bolt, optional).
 * Returns { bolt, element, speed (m/s relative to the dragon: what the lead is computed for), launch (m/s: the launch
 * velocity sent to fx — the fireball's when fx scales a bolt itself, fxScales), instant, radius, damage, recharge (s, this
 * charge's), recoil (N s), homing, chain (extra targets), chainRange, chainMult }.
 */
export function shotSpec(pv, { charge = 0, skyfall = false, boltCfg = null } = {}) {
  const FB = WEAPONS.fireball, B = BOLT, v = pv || progressView(null);
  const bolt = !!v.bolt, lvl = clamp(+charge || 0, 0, 1);
  // fx's bolt speed: > 50 = m/s relative to the dragon (sent as such); 1..20 = × the fireball's relative speed, which fx
  // applies ITSELF to the launch velocity (fx.config.lightning.bolt.speed 3.2 → 288 m/s): then the shot is sent at the
  // fireball's speed and led for the bolt's
  const raw = boltCfg && boltCfg.speed !== null && boltCfg.speed !== '' ? +boltCfg.speed : NaN;
  let bs = B.speed, fxScales = false;
  if (Number.isFinite(raw) && raw > 50) bs = raw;
  else if (Number.isFinite(raw) && raw >= 1 && raw <= 20) { bs = FB.speed * raw; fxScales = true; }
  const sk = skyfall ? SKYFALL.speed : 1;
  const speed = (bolt ? bs : FB.speed) * sk;
  const damage = (bolt ? B.damage : FB.damage) * (1 + CHARGE.damage * lvl) * (skyfall ? SKYFALL.mult : 1) * (v.dmgMult || 1);
  return {
    bolt, element: v.element || 'ember', speed, launch: bolt && fxScales ? FB.speed * sk : speed, fxScales: bolt && fxScales,
    instant: bolt && !!boltCfg?.instant,
    radius: bolt ? B.radius : FB.radius, damage,
    recharge: (bolt ? B.recharge : FB.recharge) * (1 + CHARGE.recharge * lvl),
    recoil: (bolt ? B.recoil : FB.recoil) * (1 + CHARGE.recoil * lvl),
    homing: { ...(bolt ? B.homing : FB.homing) },
    chain: bolt ? (v.chain || 0) + Math.floor(B.chargedChains * lvl + 1e-6) : 0,
    chainRange: bolt ? (v.chainRange > 0 ? v.chainRange : B.chainRange) : 0, chainMult: bolt ? B.chainMult : 0,
  };
}
/**
 * Sora's max HP from the level (pure on an actor-like { hp, maxHp, alive }): L = { base, applied, mult } is the caller's
 * memory (base HP at level 1, the max it last applied and the hpMult it applied it for). maxHp → levelMaxHp(base, hpMult);
 * the HP a level adds is healed (only while alive, via heal(gain) when given, else hp += gain), a lower max (a new run)
 * clamps hp. A max another system changed is taken as the new base (unless it is exactly this level's max: then someone
 * applied the level already — nothing is added twice). Returns { maxHp, gain, healed }.
 */
export function applyLevelHp(actor, L, hpMult, heal = null) {
  const out = { maxHp: actor?.maxHp ?? 0, gain: 0, healed: 0 };
  if (!actor || !L) return out;
  const m = +hpMult > 0 ? +hpMult : 1;
  if (!(L.base > 0)) { L.base = +actor.maxHp > 0 ? +actor.maxHp / (L.mult || 1) : 600; L.applied = null; }
  if (L.applied != null && actor.maxHp !== L.applied && +actor.maxHp > 0) {
    if (Math.abs(actor.maxHp - levelMaxHp(L.base, m)) > 1) L.base = actor.maxHp / (L.mult || 1);
  }
  const want = levelMaxHp(L.base, m), gain = want - (+actor.maxHp || 0);
  if (gain !== 0) {
    actor.maxHp = want;
    if (gain > 0 && actor.alive !== false) {
      const before = actor.hp;
      if (typeof heal === 'function') heal(gain); else actor.hp = Math.min(want, (+actor.hp || 0) + gain);
      out.healed = (+actor.hp || 0) - (+before || 0);
    } else if (actor.hp > want) actor.hp = want;
  }
  L.applied = actor.maxHp; L.mult = m;
  out.maxHp = actor.maxHp; out.gain = gain;
  return out;
}
// Momentum: builds above `from` m/s in a dive (+(V − from) / per per second), decays in level flight after `hold` s;
// a steep fast dive (path < diveMin, V > diveV) pulled out (path > pullOut) at level ≥ skyfallAt → SKYFALL for
// `skyfall` s. Sonic boom once past `boom` m/s diving (re-armed below boomRearm).
// Fix pass (critic #15, "SKYFALL is expensive for a 3 s buff: Ctrl 5.9 s, 8 s and 237 m for it; 1 SKYFALL in 640 s of
// fighting"): it builds from 42 m/s (was 50) at (V − 42) / 10 per s (was / 20) and fires as the nose comes up through
// −10° (was −5°): node, a Ctrl stoop from 34 m/s cruise → SKYFALL 4.7 s after the key and ~100 m down for 2.5 s of Ctrl,
// 5.3 s / ~125 m for 3 s (before: 6.3 s / 178 m for 4.5 s; 2.5–3.5 s of Ctrl gave nothing).
export const MOMENTUM = { from: 42, per: 10, dive: -8 * DEG, hold: 0.6, decay: 0.3, diveMin: -14 * DEG, diveV: 38, diveT: 0.4,
  pullOut: -10 * DEG, skyfallAt: 0.5, skyfallMinV: 36, skyfall: 3, boom: 70, boomRearm: 62, boomDive: -10 * DEG };
/** One step of the momentum meter (M: { level, holdT, diving, diveT, skyfallT, boomArmed }). V m/s, path rad. */
export function momentumStep(M, V, path, dt) {
  const K = MOMENTUM, ev = { cross: 0, skyfall: 0, boom: false };
  const before = M.level;
  if (V > K.from && path < K.dive) { M.level = Math.min(1, M.level + (dt * (V - K.from)) / K.per); M.holdT = K.hold; }
  else if ((M.holdT -= dt) <= 0) M.level = Math.max(0, M.level - K.decay * dt);
  if (before < 1 && M.level >= 1) ev.cross = 1; else if (before < 0.5 && M.level >= 0.5) ev.cross = 0.5;
  if (path < K.diveMin && V > K.diveV) { M.diving = true; M.diveT += dt; }
  else if (M.diving && path > K.pullOut) {
    if (M.level >= K.skyfallAt && V > K.skyfallMinV && M.diveT > K.diveT) { if (!(M.skyfallT > 0)) ev.skyfall = 1; M.skyfallT = K.skyfall; }
    M.diving = false; M.diveT = 0;
  }
  if (M.skyfallT > 0) { M.skyfallT -= dt; if (M.skyfallT <= 0) { M.skyfallT = 0; ev.skyfall = -1; } }
  if (M.boomArmed && V > K.boom && path < K.boomDive) { ev.boom = true; M.boomArmed = false; }
  else if (!M.boomArmed && V < K.boomRearm) M.boomArmed = true;
  return ev;
}
export function newMomentum() { return { level: 0, holdT: 0, diving: false, diveT: 0, skyfallT: 0, boomArmed: true }; }
// Skim: 3–20 m over a cloud top or the ground / water, faster than `speed`, bank < bankMax → a push along the path
// (accelG × weight, fading out toward `top` m/s) and extra stamina regen; on above 0.6, off below 0.3 (smoothed).
// Fix pass (critic #11, "SKIMMING in a −45…−57° dive past a cloud wall"): also |path| < pathMax, and a cloud top has to
// lie under the BELLY too (inside cloud `below` m along the body's own down axis), not only straight down.
export const SKIM = { min: 3, max: 20, speed: 35, bankMax: 60 * DEG, pathMax: 20 * DEG, rateIn: 5, rateOut: 2.5, on: 0.6, off: 0.3, accelG: 0.16, top: 60, regen: 0.18,
  below: 22, hz: 20 };
// Close calls: a pass at > speed m/s within these distances (m) — beside a cloud wall (not the deck under the belly),
// a ridge / mountain side or the ground after a fast descent, the titan's body / hands, an enemy dragon, an enemy
// shot. One event per `gap` s, none within hitGrace s of being hit.
export const NEAR = { gap: 1.5, speed: 38, hitGrace: 0.5, cloud: [1.5, 10], side: [8, 15], low: 30, lowVy: -12, lowWithin: 1.5, titan: 14, enemy: 22,
  enemyRel: 15, shot: 6 };

/**
 * The player's steer() options for the keys held and the turn still pending (`remaining`, rad: the camera's world
 * target vs the course). Shared by playerPilot() and the node feel tests, so both fly exactly the same pilot.
 * keep (wave 6): after a dash / a fast dive the pilot never brakes with the automatic flare — the speed bleeds off
 * in the glide (S still brakes).
 */
export function pilotOptions({ remaining = 0, W = false, S = false, boost = false, dive = false, keep = false } = {}) {
  const urgency = clamp(smoothstep(FEEL.urgentFrom, FEEL.urgentAt, remaining) * 0.85 + (W ? 0.2 : 0) + (dive ? 0.3 : 0), 0, 1);
  const o = {
    speed: boost ? 62 : W ? 44 : S ? 20 : 34, urgency, dive, boost, allowFlare: !boost && !keep,
    bankMax: mixF(FEEL.bank, urgency), rollRate: mixF(FEEL.rollRate, urgency), rollAccel: FEEL.rollAccel,
  };
  // (the snappier turn gain would bank a gentle 18° correction to the full 55°: the bank grows with the pending turn)
  if (FEEL.bankSmall && !dive) o.bankMax = Math.min(o.bankMax, FEEL.bankSmall[0] + FEEL.bankSmall[1] * remaining / DEG);
  if (FEEL.turnGain) o.turnGain = mixF(FEEL.turnGain, urgency);
  if (FEEL.rollGain) o.rollGain = FEEL.rollGain;
  if (FEEL.pitchGain) o.pitchGain = FEEL.pitchGain;
  if (FEEL.betaGain) o.betaGain = FEEL.betaGain;
  if (FEEL.rollYaw != null) o.rollYaw = FEEL.rollYaw;
  if (FEEL.loadHold) o.loadHold = true;
  if (FEEL.skid) o.skid = FEEL.skid;
  // wave 6 (skim): outside a Ctrl stoop the player may fly down to ~10 m over the ground / the sea (AI: 45 m + 0.9 s × V)
  if (!dive && FEEL.skimTerrain) { o.terrainMargin = FEEL.skimTerrain.margin; o.aglFloor = FEEL.skimTerrain.floor; }
  return o;
}

/**
 * Power-beat climb (Space): for `BEAT_CLIMB.hold` s after the beat the pilot follows the climb the stroke gave
 * (the aim is raised to the flight path, at least `lift` above the mouse aim), then eases back to the mouse aim over
 * `ease` s — so the burst turns into a real climb instead of being levelled out at once. In place on aimD.
 */
export const BEAT_CLIMB = { hold: 1.2, ease: 0.9, lift: 18 * DEG, maxPitch: 40 * DEG };
export function beatAim(aimD, vdir, sinceBeat) {
  const C = BEAT_CLIMB;
  if (!(sinceBeat >= 0) || sinceBeat > C.hold + C.ease) return aimD;
  const w = sinceBeat < C.hold ? 1 : 1 - smoothstep(C.hold, C.hold + C.ease, sinceBeat);
  const aimP = Math.asin(clamp(aimD.y, -1, 1)), pathP = Math.asin(clamp(vdir.y, -1, 1));
  const want = Math.min(C.maxPitch, Math.max(aimP, pathP, aimP + C.lift));
  const p = aimP + (want - aimP) * w;
  const h = Math.hypot(aimD.x, aimD.z) || 1;
  aimD.set((aimD.x / h) * Math.cos(p), Math.sin(p), (aimD.z / h) * Math.cos(p));
  return aimD;
}

/**
 * Stagger (wave 5, dragon owner: "honour dragon.stagger so the tumble reads"). dragon.js sets dragon.stagger =
 * { t, until, strength, kind } after a swat (0.5–0.8 s) or another heavy blow (0.25 s). Meanwhile the pilot lets go:
 * its rate commands fade toward `follow` × the body's own rates (hands off — the assist brakes the knock gently
 * instead of snapping the dragon back onto the aim), the turn-entry side force and the load hold are off; the steering
 * blends back in over the last `ease` s. A swat mutes fully, a lighter blow by `light`. In place on the controls c;
 * returns the mute weight 0..1. body = the FlightBody (its shaped roll ramp continues from what was really sent).
 */
export const STAGGER = { ease: 0.2, light: 0.6, follow: 0.35 };
export function staggerMute(c, body, stagger, now) {
  if (!c || !body || !stagger || !(now < stagger.until) || !(now >= stagger.t - 1e-6)) return 0;
  const S = STAGGER;
  const span = Math.max(1e-3, stagger.until - stagger.t);
  const w = smoothstep(0, Math.min(S.ease, span * 0.5), stagger.until - now) * (stagger.kind === 'swat' ? 1 : S.light);
  if (!(w > 0)) return 0;
  const ct = body.spec?.control, wb = body._wb;
  if (!ct || !wb) return 0;
  const own = (x, max) => clamp((x / max) * S.follow, -1, 1);
  c.roll += (own(wb.z, ct.pMax) - c.roll) * w;          // roll right +w.z, pitch up −w.x, yaw right −w.y
  c.pitch += (own(-wb.x, ct.qMax) - c.pitch) * w;
  c.yaw += (own(-wb.y, ct.rMax) - c.yaw) * w;
  c.skid = (c.skid || 0) * (1 - w);
  c.load = (c.load || 0) * (1 - w);
  if (Number.isFinite(body._rollRef)) body._rollRef = c.roll * ct.pMax;
  return w;
}

/** The stagger's hands-off weight 0..1 now (see staggerMute) — the hover controller mutes its rates by it. */
export function staggerWeight(stagger, now) {
  if (!stagger || !(now < stagger.until) || !(now >= stagger.t - 1e-6)) return 0;
  const span = Math.max(1e-3, stagger.until - stagger.t);
  return smoothstep(0, Math.min(STAGGER.ease, span * 0.5), stagger.until - now) * (stagger.kind === 'swat' ? 1 : STAGGER.light);
}

/** Pilot intent AFTER steer(): steer() writes boost / glide / flare / dive from its own speed logic, the keys win. */
export function applyKeys(c, { W = false, S = false, boost = false, dive = false } = {}) {
  c.hard = W && !boost ? 1 : 0;                    // W: faster, deeper strokes than the cruise pilot's effort range
  if (W) { c.flap = 1; c.glide = 0; }
  if (S) { c.flare = 1; c.glide = 0; }
  c.boost = boost ? 1 : 0;
  if (boost) { c.glide = 0; c.flare = 0; c.flap = 1; }
  if (dive && !c.dive) c.dive = 0.45;              // stoop entry even if steer's path test says not yet
  return c;
}

const _sq = new THREE.Vector3(), _ss = new THREE.Vector3();
/** Angle (rad) of pt off the ray (o, d) less its angular radius (r m, capped at AIM.radiusMax). */
function offRay(o, d, pt, r) {
  const rel = _sq.subVectors(pt, o), dist = rel.length();
  if (dist < 1) return 0;
  return Math.max(0, Math.acos(clamp(rel.dot(d) / dist, -1, 1)) - Math.atan(Math.min(r, AIM.radiusMax) / dist));
}
/**
 * The aim assist's soft target (pure; see AIM): among `actors` (combat actors) of another team than `team`, the one
 * nearest the reticle ray (origin, dir: unit) within AIM.angle — its angular radius counted — and AIM.dist m of `from`
 * (the dragon; the titan: 1.35 × that, measured to its nearest shape point). A `lock` (the Tab lock) wins within
 * AIM.lockAngle / AIM.lockDist; the `current` target is kept within AIM.keep unless another is ≥ 3° nearer the reticle.
 * The titan's point is the nearest point of its shapes to the ray, its core (the weak point) when `coreOpen` (the
 * titan's core window) and the ray passes within AIM.titanCore of the core's centre. Returns { a, ang, pt (world, may be
 * a live shape vector), core (shape|null), dist, r, locked } or null.
 */
export function pickSoftTarget(actors, { origin, dir, from, team = 'player', self = null, current = null, lock = null, titanActive = true, coreOpen = false } = {}) {
  const cands = [];
  for (const a of actors || []) {
    if (!a || a === self || a.alive === false || a.team === team || !a.pos?.isVector3) continue;
    if (a.kind === 'titan') {
      if (!titanActive || a.root?.visible === false || !Array.isArray(a.shapes)) continue;
      let bestA = Infinity, bestPt = null, core = null;
      for (const s of a.shapes) {
        if (!s?.a?.isVector3) continue;
        const us = s.kind === 'capsule' && s.b?.isVector3 ? [0, 0.25, 0.5, 0.75, 1] : [0];
        for (const u of us) {
          const pt = u === 0 ? s.a : _ss.copy(s.a).lerp(s.b, u);
          if (pt.distanceTo(from) > AIM.dist * 1.35) continue;
          const ang = offRay(origin, dir, pt, s.r || 0);
          if (ang < bestA) { bestA = ang; bestPt = (bestPt || new THREE.Vector3()).copy(pt); }
        }
        if (s.part === 'core') core = s;
      }
      if (!bestPt) continue;
      let pt = bestPt, isCore = false;
      if (core && coreOpen && offRay(origin, dir, core.a, 0) <= AIM.titanCore && core.a.distanceTo(from) < AIM.dist * 1.35) {
        pt = core.a; isCore = true; bestA = Math.min(bestA, offRay(origin, dir, core.a, core.r || 0));
      }
      cands.push({ a, ang: bestA, pt, core: isCore ? core : null, dist: pt.distanceTo(from), r: 0, range: AIM.dist * 1.35 });
    } else {
      const dist = a.pos.distanceTo(from);
      if (dist > AIM.lockDist) continue;
      const r = Math.min(a.radius ?? 6, AIM.radiusMax);
      cands.push({ a, ang: offRay(origin, dir, a.pos, r), pt: a.pos, core: null, dist, r, range: AIM.dist });
    }
  }
  if (lock) {
    const c = cands.find((x) => x.a === lock);
    if (c && c.ang <= AIM.lockAngle && c.dist <= AIM.lockDist) return Object.assign(c, { locked: true });
  }
  let best = null, cur = null;
  for (const c of cands) {
    if (c.dist > c.range * (c.a === current ? 1.15 : 1)) continue;
    if (c.a === current && c.ang <= AIM.keep) cur = c;
    if (c.ang <= AIM.angle && (!best || c.ang < best.ang)) best = c;
  }
  const pick = cur && (!best || best === cur || best.ang > cur.ang - 3 * DEG) ? cur : best;
  return pick ? Object.assign(pick, { locked: false }) : null;
}

const _pv = new THREE.Vector3();
/**
 * The player's pilot for one fixed step — pure, shared by player.js and the node tests (they fly exactly this).
 * body: the FlightBody; FM: the mode machine (newFlightMode()); keys: { W, S, A, D, boost, ctrl, space, padLx } (held);
 * o: { aim (the magnetised aim the dragon flies — changed in place for the stoop / the beat's climb), turn (the hover
 * heading aim), target (the camera's world target for the pending turn, or null), now, dt, keep (no automatic flare:
 * after a dash, in a fast dive / SKYFALL), stagger (dragon.stagger), alive (default true) }.
 * Returns { mode, flying, braking, staggerW }.
 */
export function pilotStep(body, FM, keys, o = {}) {
  const c = body.controls, now = o.now ?? 0, dt = o.dt ?? 1 / 120, alive = o.alive !== false;
  const V = body.vel.length(), busy = !!body.state?.move;
  const mode = flightModeStep(FM, { W: !!keys.W, dive: !!keys.ctrl, busy, now, V, hoverW: body.state?.hover ?? 0, dt });
  const flying = mode === 'flight' || (mode === 'toHover' && V > MODES.brakeV);
  const braking = mode === 'toHover' && flying;
  const dive = !!keys.ctrl && flying && !braking;
  const aimD = o.aim;
  if (dive && aimD.y > -0.82) { const h = Math.hypot(aimD.x, aimD.z) || 1; aimD.set(aimD.x / h * 0.573, -0.82, aimD.z / h * 0.573); }
  let staggerW = 0;
  if (!alive) { c.hover = 0; return { mode, flying, braking, staggerW }; }
  const stg = o.stagger;
  if (flying) {
    // How much turn the player still wants: the camera's world target (a big mouse swing waits there while the aim
    // leads the course by at most ~28°), else the aim itself. Normal turns bank <= 55°; only a big pending turn makes it
    // an urgent, harder turn up to ~75°. (W is the throttle now: the flight pilot is the cruise pilot of before.)
    const vdir = _pv.copy(body.vel);
    if (vdir.lengthSq() > 1e-6) vdir.normalize(); else vdir.set(0, 0, 1).applyQuaternion(body.quat);
    const tgt = o.target?.isVector3 && !dive ? o.target : aimD;
    const remaining = Math.acos(clamp(tgt.dot(vdir), -1, 1));
    const k = { W: false, S: !!keys.S || braking, boost: !!keys.boost && !braking, dive };
    // wave 6: while a wingover / loop runs, its own pilot program flies (FlightBody); a heavy blow knocks it out
    const turning = PILOT_TURNS.has(body.state?.move);
    if (turning && stg && now < stg.until && now >= stg.t - 1e-6) body.cancelMove?.();
    c.hover = 0;
    if (!PILOT_TURNS.has(body.state?.move)) {
      if (!dive) beatAim(aimD, vdir, body.state.sinceBeat);      // Space: follow the climb the power beat gave
      body.steer(aimD, { ...pilotOptions({ remaining, ...k, keep: !braking && !!o.keep }), dt });
      // Pilot intent AFTER steer(): the keys win over steer()'s own speed logic.
      // (A / D no longer override the roll: they bank the dragon into a coordinated turn through the aim.)
      if (Math.abs(keys.padLx || 0) > 0.15) { c.roll = clamp(keys.padLx, -1, 1); c.skid = 0; }
      // a swat / heavy blow (dragon.stagger): hands off for ~0.5 s so the knock and the tumble read, then steer again
      staggerW = staggerMute(c, body, stg, now);
      applyKeys(c, k);
      // W below the cruise: the power strokes that row it up to speed (the hand-over from the hover is at ~21 m/s)
      if (keys.W && !keys.boost && !braking && V < MODES.power) c.hard = 1;
      // W released: the flare — wings forward, legs down, a high angle of attack — then the hover's back-beat
      if (braking) { c.flare = 1; c.glide = 0; c.boost = 0; c.hard = 0; c.dive = 0; }
    }
  } else {
    // HOVER / the transitions at low speed: FlightBody.hoverSteer (the hover stroke + controller)
    const strafe = clamp((keys.D ? 1 : 0) - (keys.A ? 1 : 0) + (Math.abs(keys.padLx || 0) > 0.2 ? keys.padLx : 0), -1, 1);
    const climb = (keys.space ? 1 : 0) - (keys.ctrl ? 1 : 0);
    const fwd = mode === 'toFlight' ? 1 : keys.S ? -1 : 0;
    staggerW = staggerWeight(stg, now);
    body.hoverSteer(o.turn || aimD, { strafe, climb, fwd, vFwd: MODES.vFwd, aFwd: keys.boost ? MODES.aFwdBoost : MODES.aFwd,
      brake: mode === 'toHover', mute: staggerW, dt });
    // (Shift in the W transition rows harder: it costs the boost's stamina)
    if (mode === 'toFlight' && keys.boost) { body.stamina = Math.max(0, body.stamina - (body.spec?.stamina?.boostDrain ?? 0.19) * dt); body._staminaIdle = 0; }
  }
  return { mode, flying, braking, staggerW };
}
const PILOT_TURNS = new Set(['wingover', 'loop']);

const _d = new THREE.Vector3(), _v = new THREE.Vector3(), _q = new THREE.Quaternion();
const _q1v = new THREE.Vector3(), _q2v = new THREE.Vector3(), _q3v = new THREE.Vector3(), _q4v = new THREE.Vector3(), _zero = new THREE.Vector3();
const _turnD = new THREE.Vector3(), _flyD = new THREE.Vector3();

/** Find the FlightBody inside a Dragon, whatever the owner named the field. */
export function flightOf(d) {
  if (!d) return null;
  if (d instanceof FlightBody) return d;
  for (const k of ['body', 'flight', 'physics', 'fb']) if (d[k] instanceof FlightBody) return d[k];
  for (const v of Object.values(d)) if (v instanceof FlightBody) return v;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Stand-in Dragon: used when actors/dragon.js is missing or fails. Same public surface as the contract's Dragon,
// real FlightBody physics, the dragon owner's procedural model (dragon-fallback.js) posed from the wing kinematics,
// or a primitive skeleton if that is unavailable too.
// ---------------------------------------------------------------------------------------------------------------
export class StandInDragon {
  constructor(game, o = {}) {
    this.game = game;
    this.variant = o.variant || 'hero';
    this.team = o.team || 'player';
    this.name = o.name || 'Sora';
    this.body = new FlightBody(DRAGON_SPECS[this.variant] || DRAGON_SPECS.hero, { pos: (o.pos || START.pos).toArray?.() || [0, 1300, 0], heading: o.heading ?? 0 });
    this.controls = this.body.controls;
    this.root = new THREE.Group();
    this.root.name = 'dragon-standin';
    this.mouth = new THREE.Vector3();
    this.mouthDir = new THREE.Vector3(0, 0, 1);
    this.heat = 0; this.overheated = false;
    this._mouthLocal = new THREE.Vector3(0, 1.05, 5.9);
    this._model = null;
    this.actor = {
      name: this.name, kind: 'dragon', team: this.team, hp: o.hp ?? 600, maxHp: o.hp ?? 600, alive: true,
      root: this.root, pos: this.body.pos, vel: this.body.vel, radius: 12,
      shapes: [
        { kind: 'capsule', a: new THREE.Vector3(), b: new THREE.Vector3(), r: 1.2, part: 'body', mult: 1 },
        { kind: 'sphere', a: new THREE.Vector3(), r: 0.9, part: 'head', mult: 1.5 },
        { kind: 'capsule', a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0.8, part: 'wingL', mult: 0.7 },
        { kind: 'capsule', a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0.8, part: 'wingR', mult: 0.7 },
        { kind: 'capsule', a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0.6, part: 'tail', mult: 0.8 },
      ],
      invuln: 0, dragon: this,
    };
    this.ready = this._build().catch((e) => { console.warn('[player] stand-in model failed', e); this._buildPrimitive(); });
    // root and physics start together (a root left at the origin until the first update drew the dragon at 0,0,0)
    this.root.position.copy(this.body.pos); this.root.quaternion.copy(this.body.quat);
    game.scene?.add(this.root);
    try { game.combat?.register(this.actor); } catch (e) { console.warn('[player] combat register failed', e); }
  }

  get pos() { return this.body.pos; }
  get vel() { return this.body.vel; }
  get quat() { return this.body.quat; }
  get airspeed() { return this.body.state.airspeed; }
  get aoa() { return this.body.state.aoa; }
  get altitude() { return this.body.pos.y; }
  get stamina() { return this.body.stamina; }
  get flapPhase() { return this.body.state.flapPhase; }
  get wingPose() { return this.body.state.pose; }
  get alive() { return this.actor.alive; }
  get hp() { return this.actor.hp; }
  steer(dir, o) { return this.body.steer(dir, o); }

  async _build() {
    const m = await import('./dragon-fallback.js');
    const model = m.createFallbackDragon(this.game, this.variant);
    this._model = model;
    this.root.add(model.scene);
    if (model.mouth?.offset) this._mouthLocal.copy(model.mouth.offset).add(model.bones.get(model.mouth.bone)?.getWorldPosition(new THREE.Vector3()) ?? new THREE.Vector3()).sub(this.root.getWorldPosition(new THREE.Vector3()));
    this._bindTail = [];
    for (let i = 1; i <= 10; i++) { const b = model.bones.get('tail' + i); if (b) this._bindTail.push([b, b.quaternion.clone()]); }
    this._bindNeck = [];
    for (let i = 1; i <= 6; i++) { const b = model.bones.get('neck' + i); if (b) this._bindNeck.push([b, b.quaternion.clone()]); }
  }

  _buildPrimitive() {
    // Minimal readable dragon: body capsule, neck, head, tail, wing bones + membrane from the physics strips.
    const mat = (c, side) => (this.game.toon ? this.game.toon.material({ color: c, side }) : new THREE.MeshStandardMaterial({ color: c, side, roughness: 0.8 }));
    const ivory = mat(0xefe6d2), memb = mat(0x6fe0d0, THREE.DoubleSide);
    const g = new THREE.Group();
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.85, 3.2, 6, 14), ivory); torso.rotation.x = Math.PI / 2; g.add(torso);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.55, 3.4, 10), ivory); neck.position.set(0, 0.7, 3.2); neck.rotation.x = 1.15; g.add(neck);
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.8, 10), ivory); head.position.set(0, 1.2, 5.2); head.rotation.x = Math.PI / 2; g.add(head);
    const tail = new THREE.Mesh(new THREE.ConeGeometry(0.5, 6.5, 10), ivory); tail.position.set(0, 0, -5.2); tail.rotation.x = -Math.PI / 2; g.add(tail);
    this._primMemb = [];
    for (let s = 0; s < 2; s++) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(5 * 6 * 3), 3));
      const mesh = new THREE.Mesh(geo, memb); mesh.frustumCulled = false; g.add(mesh); this._primMemb.push(mesh);
    }
    this.root.add(g);
    this._prim = g;
  }

  reset(pos = START.pos, heading = START.heading, speed = 34) {
    this.body.reset(pos, heading, speed);
    this.root.position.copy(this.body.pos); this.root.quaternion.copy(this.body.quat);
    this.body.stamina = 1; this.heat = 0; this.overheated = false;
    this.actor.hp = this.actor.maxHp; this.actor.alive = true; this.actor.invuln = 1;
  }

  fixedUpdate(dt, game) {
    if (!this.actor.alive) { this.controls.flap = 0; this.controls.glide = 1; this.controls.breath = 0; }
    this.body.step(dt, this._env || (this._env = makeEnv(game)));
    this._shapes();
    this.body.toWorld(this._mouthLocal, this.mouth);
    this.mouthDir.set(0, -0.12, 1).normalize().applyQuaternion(this.body.quat);
    // Weapons (breath, fireball, heat) are driven by the player system for the stand-in and the real Dragon alike.
  }

  _shapes() {
    const b = this.body, S = this.actor.shapes, j = b.pose;
    const w = (v, out) => b.toWorld(v, out);
    w(_v.set(0, 0.2, 2.2), S[0].a); w(_v.set(0, 0, -2.4), S[0].b);
    w(this._mouthLocal, S[1].a);
    w(j.L.joints.S, S[2].a); w(j.L.joints.T[1], S[2].b);
    w(j.R.joints.S, S[3].a); w(j.R.joints.T[1], S[3].b);
    w(_v.set(0, 0, -3), S[4].a); w(_v.set(0, -0.3, -9.5), S[4].b);
  }

  update(dt, realDt, game) {
    const b = this.body;
    b.interpolate(game.time.alpha ?? 1, this.root.position, this.root.quaternion);
    const pose = b.state.pose;
    if (this._model) {
      const M = this._model.bones;
      for (const [s, P] of [['L', pose.L], ['R', pose.R]]) {
        M.get('wing_shoulder_' + s)?.quaternion.copy(P.shoulder);
        M.get('wing_elbow_' + s)?.quaternion.copy(P.elbow);
        M.get('wing_wrist_' + s)?.quaternion.copy(P.wrist);
        for (let i = 0; i < 4; i++) M.get(`wing_f${i + 1}_${s}`)?.quaternion.copy(P.fingers[i]);
      }
      // secondary motion from the pose hints: tail pitches and swings, neck counter-bobs, legs trail
      const hints = pose.body;
      const yawRate = -b._wb.y;
      this._tailYaw = (this._tailYaw || 0) + (clamp(-yawRate * 0.25, -0.35, 0.35) - (this._tailYaw || 0)) * damp(3, realDt || dt || 0.016);
      for (let i = 0; i < this._bindTail.length; i++) {
        const [bone, q0] = this._bindTail[i];
        _q.setFromEuler(new THREE.Euler(hints.tailPitch * 0.1, this._tailYaw * 0.3 * (i + 1) / 10, 0));
        bone.quaternion.copy(q0).multiply(_q);
      }
      for (const [bone, q0] of this._bindNeck) { _q.setFromAxisAngle(_v.set(1, 0, 0), -hints.neckPitch / 6); bone.quaternion.copy(q0).multiply(_q); }
      const mu = this._model.membraneUniforms;
      if (mu) { mu.uCamberL.value = pose.L.camber; mu.uCamberR.value = pose.R.camber; mu.uMembTime.value = game.time.now; mu.uFlutter.value = clamp((b.state.airspeed - 40) / 40, 0, 1); }
      this.root.position.y += hints.bob;
    } else if (this._prim) {
      for (let s = 0; s < 2; s++) {
        const sec = b._sections[s], arr = this._primMemb[s].geometry.attributes.position.array;
        let k = 0;
        for (let i = 0; i < 5; i++) {
          const A = sec[i], B = sec[i + 1];
          for (const p of [A.le, A.te, B.le, B.le, A.te, B.te]) { arr[k++] = p.x; arr[k++] = p.y; arr[k++] = p.z; }
        }
        this._primMemb[s].geometry.attributes.position.needsUpdate = true;
        this._primMemb[s].geometry.computeVertexNormals();
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
export default function createPlayer(game) {
  const input = () => game.input;
  let dragon = null, body = null;
  const latch = { beat: false, dodge: 0, fireball: false, move: null, inferno: false, fPress: false, fRelease: false };
  const aim = { dir: new THREE.Vector3(0, 0, 1), yaw: 0, pitch: 0, frozen: null };
  const keyReader = makeKeyReader();     // chords, double taps (readMoveKeys)
  let titleT = 0;
  // Weapons state (the player's, whatever dragon class it flies).
  const W = {
    heat: 0, overheated: false, lockT: 0, idle: 0, want: false, breathOn: false, breathSrc: null, breathMode: null,
    fbWant: false, fbPrev: false, fDown: false, gapT: 0, rechargeT: 0, rechargeQ: [], shots: 0, lastShot: null,
    fireball: { ready: true, cooldown: 0, cooldownMax: WEAPONS.fireball.recharge, charges: WEAPONS.fireball.maxCharges, maxCharges: WEAPONS.fireball.maxCharges },
    charge: { held: false, t: 0, level: 0, started: false, full: false },   // F held: the charged fireball (wave 6)
  };
  // Flight-move meters (wave 6): momentum / skyfall, the special meter and the inferno, skim, close calls.
  const X = {
    mom: newMomentum(), special: 0, inferno: { on: false, t: 0 }, skim: { v: 0, on: false, kind: null, tick: 0, mistT: 0 },
    near: { last: -1e9, tick: 0, vyMin: 0, fastAt: -1e9, inCloudAt: -1e9, count: 0 }, hurtAt: -1e9, fireHit: new Map(),
    dashAt: -1e9, stats: { hits: 0, kills: 0, close: 0, specialGain: 0 },
  };
  // game.player.moves (contract): the running move, the inferno included; `queued` = a request waiting to start
  const MV = { current: null, t: 0, side: 0, phase: null, u: 0, queued: null, last: null };
  // Titan grab: piloting suspended while caught, a short tumble after the throw.
  const grab = { on: false, t: 0, recover: 0, count: 0 };
  let proxy = null;
  // Flight modes (MODES) and the aim assist (AIM): the mode machine's state; the soft target, its point (a dragon's
  // position, a titan shape point or the core), the flame's lead point, the magnetised aim (dir: what the dragon flies /
  // turns toward) and head aim (head), the bend (rad), whether the head looks at the target (look) and inRange.
  const FM = newFlightMode();
  const AA = { target: null, point: new THREE.Vector3(), lead: new THREE.Vector3(), core: false, coreRef: null, angle: 0, dist: 0, r: 0,
    dir: new THREE.Vector3(0, 0, 1), head: new THREE.Vector3(0, 0, 1), turn: new THREE.Vector3(0, 0, 1), bend: 0, look: false,
    inRange: false, lockPreferred: false };
  // Levels and elements (game.progress applied): the HP memory of applyLevelHp() and the view read this step
  const LV = { base: 0, applied: null, mult: 1, pv: progressView(null), levelUps: 0, lastHp: null };

  /** Read game.progress (progressView) and apply the max HP / the level-up heal. Every fixed step + on 'levelup'. */
  function syncProgress() {
    let pv = LV.pv;
    try {
      pv = progressView(game.progress);
      LV.pv = pv;
      const a = dragon?.actor;
      if (a) {
        const r = applyLevelHp(a, LV, pv.hpMult, (g) => {
          if (typeof game.combat?.heal === 'function' && a.alive) game.combat.heal(a, g);
          else a.hp = Math.min(a.maxHp, (+a.hp || 0) + g);
        });
        if (r.gain) LV.lastHp = { t: nowS(), level: pv.level, gain: r.gain, healed: Math.round(r.healed), maxHp: r.maxHp };
      }
    } catch (e) { warnOnce('progress', e); }
    return pv;
  }

  function spawnOpts() {
    return { variant: 'hero', team: 'player', name: 'Sora', rider: 'kaede', pos: START.pos.clone(), heading: START.heading };
  }

  function hook(d) {
    body = flightOf(d);
    if (!body) return;
    // Wingbeat events: the stand-in emits every downstroke; a real Dragon emits regular beats itself (phase wraps),
    // so only the scripted power strokes (power beat, dodge) are added here.
    if (!body.onBeat) {
      const all = d instanceof StandInDragon;
      body.onBeat = (strength, b) => { if (all || b._prog) game.events.emit('wingbeat', { actor: d.actor || d, strength }); };
    }
    // Flight moves (wave 6): FlightBody reports its wingover / loop / dash → 'move' events (+ the dash's shock ring)
    const ownMove = body.onMove;
    body.onMove = (name, side, phase, info) => {
      try { ownMove?.(name, side, phase, info); } catch { /* another listener: ignore */ }
      onFlightMove(name, side, phase, info || {});
    };
    // Crash damage (wave 4, critic bugs #3: a 70 m/s dive into the valley cost 15 % HP): the player's crash hurts in
    // proportion to the impact — maxHp × FlightBody's info.severity ((vn − 8) / 45)², ≥ 53 m/s lethal. A dragon that
    // does its own crash damage keeps its handler; this tops it up to the proportional amount (never double-counts:
    // it subtracts what the dragon reported in dragon.lastCrash for this contact).
    const own = body.onCrash;
    if (own && (d.handlesCrash || d.crashDamage)) body.onCrash = (info, b) => { try { own(info, b); } finally { crashDamage(d, info, true); } };
    else if (!own && !d.env?.onCrash) body.onCrash = (info) => crashDamage(d, info, false);
  }

  function crashDamage(d, info, topUp) {
    try {
      const a = d.actor; if (!a || !game.combat || !(a.alive !== false) || !(info?.severity > 0)) return;
      const want = (a.maxHp || 600) * info.severity;
      const done = topUp && d.lastCrash && Math.abs((d.lastCrash.t ?? -1) - (game.time?.now ?? 0)) < 1e-6 ? d.lastCrash.damage || 0 : 0;
      const dmg = want - done;
      if (dmg > 0.5) game.combat.damage(a, dmg, { source: null, point: info.point, dir: info.normal, kind: 'crash', part: 'body' });
      if (!topUp || info.impact > 20) game.cameraRig?.shake?.(clamp(0.3 + info.severity * 1.2, 0.3, 1.2), 0.35 + 0.4 * info.severity);
      sys.lastCrash = { t: game.time?.now ?? 0, impact: info.impact, severity: info.severity, damage: want };
    } catch (e) { warnOnce('crash', e); }
  }

  // ------------------------------------------------------------------------------------------------ flight moves
  const TURN = new Set(['wingover', 'loop']);
  const emit = (name, payload) => { try { game.events.emit(name, payload); } catch (e) { warnOnce('event ' + name, e); } };
  const me = () => dragon?.actor || dragon;
  const nowS = () => game.time?.now ?? 0;

  /** FlightBody reported a wingover / loop / dash start or end. */
  function onFlightMove(name, side, phase, info) {
    emit('move', { name, side, phase, actor: me(), ...info });
    if (phase === 'start' && name === 'dash') {
      X.dashAt = nowS();
      FM.keepUntil = nowS() + MODES.keepAfterDash;             // (a dash out of the hover flies on for a moment)
      try { const v = body.vel; if (v.lengthSq() > 1) game.fx?.dashRing?.(dragon.pos.clone(), v.clone().normalize(), { dragon }); } catch (e) { warnOnce('fx.dashRing', e); }
    }
    if (phase === 'end' && TURN.has(name)) {
      // the new course becomes the aim. A camera rig that carries the aim through the move itself (tuning.moveCarry)
      // is left alone (a setAim during / at the end of the move would override the player's mouse); an older rig gets
      // the course here, levelled to ±8°, so the dragon does not turn back toward the old target
      const rig = game.cameraRig, v = body.vel;
      if (rig?.setAim && !(rig.tuning && rig.tuning.moveCarry != null) && v.lengthSq() > 1) {
        const h = Math.hypot(v.x, v.z) || 1, pitch = clamp(Math.atan2(v.y, h), -8 * DEG, 8 * DEG);
        try { rig.setAim(new THREE.Vector3((v.x / h) * Math.cos(pitch), Math.sin(pitch), (v.z / h) * Math.cos(pitch))); } catch (e) { warnOnce('setAim', e); }
      }
      syncFallbackAim();
    }
  }

  /** Special meter: + per landed hit / kill / close call (not while the inferno burns). */
  function addSpecial(x) {
    if (X.inferno.on || !(x > 0)) return;
    const before = X.special;
    X.special = Math.min(1, X.special + x);
    X.stats.specialGain += X.special - before;
  }

  function startInferno() {
    // at the lightning / storm tiers the inferno is the STORM SURGE: the same 4 s super breath in the lightning element
    // (fx: mode 'inferno' + element + surge) and a free full-charge bolt to open it (no charge spent)
    const pv = LV.pv, surge = !!pv.bolt;
    X.inferno.on = true; X.inferno.t = 0; X.inferno.surge = surge; X.inferno.element = pv.element;
    W.overheated = false; W.lockT = 0;
    const extra = { surge, element: pv.element, label: surge ? 'STORM SURGE' : 'INFERNO', level: pv.level };
    emit('special', { name: 'inferno', on: true, actor: me(), ...extra });
    emit('move', { name: 'inferno', side: 0, phase: 'start', actor: me(), ...extra });
    if (surge && SURGE.opener > 0) { try { fireFireball(SURGE.opener, { free: true }); } catch (e) { warnOnce('surge bolt', e); } }
  }
  function endInferno(reason = 'done') {
    if (!X.inferno.on) return;
    const t = X.inferno.t, extra = { surge: !!X.inferno.surge, element: X.inferno.element || 'ember', label: X.inferno.surge ? 'STORM SURGE' : 'INFERNO' };
    X.inferno.on = false; X.inferno.t = 0; X.special = 0; X.inferno.surge = false;
    emit('special', { name: 'inferno', on: false, actor: me(), reason, ...extra });
    emit('move', { name: 'inferno', side: 0, phase: 'end', actor: me(), reason, t, ...extra });
  }

  /** F: a tap fires the normal fireball, holding charges it (level 0 → 1 over CHARGE.time), the release fires. */
  function chargeStep(dt, live) {
    const C = W.charge, F = W.fireball;
    if (latch.fPress) { latch.fPress = false; Object.assign(C, { held: true, t: 0, level: 0, started: false, full: false }); }
    if (!C.held) { latch.fRelease = false; return; }
    if (live && F.charges > 0) { C.t += dt; C.level = clamp(C.t / CHARGE.time, 0, 1); }
    if (!C.started && C.level >= CHARGE.tap) { C.started = true; emit('charge', { level: C.level, phase: 'start', actor: me() }); }
    if (!C.full && C.level >= 1) { C.full = true; emit('charge', { level: 1, phase: 'full', actor: me() }); }
    if (latch.fRelease || !W.fDown || !live) {
      latch.fRelease = false;
      const lvl = C.level >= CHARGE.tap ? C.level : 0;
      let fired = false;
      if (live && F.charges > 0 && W.gapT <= 0) { fireFireball(lvl); fired = true; }
      if (C.started) emit('charge', { level: lvl, phase: fired ? 'release' : 'cancel', actor: me() });
      Object.assign(C, { held: false, t: 0, level: 0, started: false, full: false });
    }
  }

  /** Cloud surface distance at a point: metres inside (> 0) / outside (< 0) — clouds.inside, else a density guess. */
  function cloudInside(x, y, z) {
    const C = game.clouds;
    try {
      if (typeof C?.inside === 'function') { const e = C.inside(x, y, z); return Number.isFinite(e) ? e : null; }
      const d = game.world?.cloudDensity;
      if (typeof d === 'function') { const v = d(x, y, z); return Number.isFinite(v) ? (v > 0.5 ? 10 : v > 0.02 ? -8 : -60) : null; }
    } catch (e) { warnOnce('cloud query', e); }
    return null;
  }

  /** Momentum / skyfall / sonic boom, skim and close calls; after the physics step of every fixed step in 'play'. */
  function mechanicsStep(dt) {
    const now = nowS(), b = body, V = b.vel.length(), alive = isAlive();
    const path = V > 1 ? Math.asin(clamp(b.vel.y / V, -1, 1)) : 0;
    const ev = momentumStep(X.mom, alive ? V : 0, path, dt);
    const sky = X.mom.skyfallT > 0;
    if (ev.cross) emit('momentum', { level: X.mom.level, skyfall: sky, actor: me() });
    if (ev.skyfall) emit('momentum', { level: X.mom.level, skyfall: ev.skyfall > 0, phase: ev.skyfall > 0 ? 'start' : 'end', actor: me() });
    if (ev.boom && alive) {
      try { game.fx?.sonicBoom?.(dragon.pos.clone(), b.vel.clone().normalize(), { dragon }); } catch (e) { warnOnce('fx.sonicBoom', e); }
      emit('sonicboom', { speed: V, actor: me() });
    }
    // fast-descent memory for the low pull-out close call: when the dragon last came down faster than NEAR.lowVy
    if (b.vel.y < NEAR.lowVy) X.near.fastAt = now;
    X.near.vyMin = Math.min(b.vel.y, X.near.vyMin + 10 * dt);
    X.skim.tick += dt;
    if (X.skim.tick >= 1 / SKIM.hz) {
      const h = X.skim.tick; X.skim.tick = 0;
      const p = b.pos, e0 = cloudInside(p.x, p.y, p.z);
      if (e0 > 0) X.near.inCloudAt = now;
      const below = e0 !== null && e0 > -40 ? cloudInside(p.x, p.y - SKIM.below, p.z) : null;
      try { scanSkim(h, V, e0, below); } catch (e) { warnOnce('skim', e); }
      try { scanNear(now, V, e0, below); } catch (e) { warnOnce('close calls', e); }
    }
    // skimming: a push along the path (fading toward SKIM.top) and extra stamina regen
    if (X.skim.v > 0.02 && alive && V > 5) {
      const k = X.skim.v * (1 - smoothstep(SKIM.top - 8, SKIM.top, V));
      if (k > 0) b.applyForce(_q2v.copy(b.vel).multiplyScalar((b.mass * 9.81 * SKIM.accelG * k) / V));
      b.stamina = Math.min(1, b.stamina + SKIM.regen * X.skim.v * dt);
    }
  }

  function scanSkim(h, V, e0, below) {
    const S = SKIM, b = body, st = b.state, p = b.pos;
    let kind = null, dist = 1e9;
    const path = V > 1 ? Math.asin(clamp(b.vel.y / V, -1, 1)) : 0;
    if (V > S.speed && Math.abs(st.bank) < S.bankMax && Math.abs(path) < S.pathMax && isAlive() && !grab.on && !st.grounded) {
      const agl = st.agl;
      if (agl >= S.min && agl <= S.max) {
        const w = game.world;
        let water = false;
        try { water = !!(w?.waterLevelAt && w.heightAt && w.waterLevelAt(p.x, p.z) >= w.heightAt(p.x, p.z) - 0.05); } catch { water = false; }
        kind = water ? 'water' : 'terrain'; dist = agl;
      }
      // a cloud top: 3–20 m outside a surface that lies below (well inside cloud SKIM.below m under the dragon)
      if (e0 !== null && e0 <= -S.min && e0 >= -S.max && -e0 < dist && below !== null && below > 2) {
        const bd = _q1v.set(0, -S.below, 0).applyQuaternion(b.quat).add(p);                // under the belly
        const belly = cloudInside(bd.x, bd.y, bd.z);
        if (belly !== null && belly > 2) { kind = 'cloud'; dist = -e0; }
      }
    }
    const S0 = X.skim, target = kind ? 1 : 0;
    S0.v += (target - S0.v) * damp(target > S0.v ? S.rateIn : S.rateOut, h);
    if (kind) { S0.kind = kind; S0.dist = dist; }
    const fx = game.fx;
    if (!S0.on && S0.v > S.on) {
      S0.on = true; S0.mistT = 0;
      emit('skim', { on: true, kind: S0.kind, dist, speed: V, actor: me() });
      try { fx?.skimMist?.(dragon, true, { surface: S0.kind, strength: S0.v }); } catch (e) { warnOnce('fx.skimMist', e); }
    } else if (S0.on && S0.v < S.off) {
      S0.on = false;
      emit('skim', { on: false, kind: S0.kind, actor: me() });
      try { fx?.skimMist?.(dragon, false); } catch (e) { warnOnce('fx.skimMist', e); }
    } else if (S0.on && (S0.mistT += h) > 0.5) {
      S0.mistT = 0;
      try { fx?.skimMist?.(dragon, true, { surface: S0.kind, strength: S0.v }); } catch (e) { warnOnce('fx.skimMist', e); }
    }
  }

  function scanNear(now, V, e0, below) {
    const N = NEAR, b = body, p = b.pos;
    if (!isAlive() || grab.on || V < N.speed || now - X.near.last < N.gap || now - X.hurtAt < N.hitGrace) return;
    const myTeam = dragon.actor?.team || 'player';
    let best = null;
    const take = (kind, dist, point) => { if (!best || dist < best.dist) best = { kind, dist, point: point.clone() }; };
    const passed = (pos, vel) => _q1v.subVectors(p, pos).dot(_q3v.subVectors(b.vel, vel || _zero)) > 0;   // separating
    // enemy dragons passing close (fast relative to us, already going apart)
    for (const a of game.actors || []) {
      if (!a || a === dragon.actor || a.alive === false || a.team === myTeam || a.kind !== 'dragon' || !a.pos) continue;
      const d = a.pos.distanceTo(p);
      if (d > N.enemy || d < 3) continue;
      const rel = a.vel ? _q3v.subVectors(b.vel, a.vel).length() : V;
      if (rel > N.enemyRel && passed(a.pos, a.vel)) take('enemy', d, a.pos);
    }
    // the titan's body / hands / wings
    const T = game.titan?.actor, combat = game.combat;
    if (T && T.alive !== false && game.titan.active !== false && T.pos && T.pos.distanceTo(p) < 420 && Array.isArray(T.shapes)) {
      for (const s of T.shapes) {
        if (!s?.a) continue;
        let d;
        if (typeof combat?.shapeDistance === 'function') d = combat.shapeDistance(s, p, _q4v);
        else { _q4v.copy(s.a); d = s.a.distanceTo(p) - (s.r || 0); }
        if (d > 1 && d < N.titan) take('titan', d, _q4v);
      }
    }
    // enemy shots (titan volleys, rider fireballs) that went past
    for (const pr of game.fx?.projectiles || []) {
      if (!pr?.alive || !pr.pos || pr.team === myTeam) continue;
      const d = pr.pos.distanceTo(p) - (pr.radius || 1);
      if (d > 0.5 && d < N.shot && passed(pr.pos, pr.vel)) take(pr.kind === 'titan' ? 'titan' : 'enemy', d, pr.pos);
    }
    // the ground: a ridge / mountain side beside us, or a low pull-out after a fast descent
    const H = game.world?.heightAt;
    if (typeof H === 'function') {
      const lr = _q1v.set(-b.vel.z, 0, b.vel.x);
      if (lr.lengthSq() > 1) {
        lr.normalize();
        for (const sd of [-1, 1]) for (const d of N.side) {
          const x = p.x + lr.x * sd * d, z = p.z + lr.z * sd * d, hy = H(x, z);
          if (Number.isFinite(hy) && hy > p.y - 2) take('terrain', d, _q4v.set(x, hy, z));
        }
      }
      const agl = b.state.agl;
      if (agl > 1.5 && agl < N.low && now - (X.near.fastAt ?? -1e9) < N.lowWithin && b.vel.y > -3) take('terrain', agl, _q4v.set(p.x, p.y - agl, p.z));
    }
    // a cloud wall close beside (not the deck under the belly, not just out of a cloud)
    if (e0 !== null && e0 <= -N.cloud[0] && e0 >= -N.cloud[1] && (below === null || below < 0) && now - X.near.inCloudAt > 0.6) take('cloud', -e0, p);
    if (!best) return;
    X.near.last = now; X.stats.close++;
    emit('nearmiss', { kind: best.kind, dist: best.dist, speed: V, point: best.point, actor: me() });
    try { game.fx?.nearMiss?.(best.point, { kind: best.kind, dir: b.vel.clone().normalize(), dragon }); } catch (e) { warnOnce('fx.nearMiss', e); }
    addSpecial(SPECIAL.close);
  }

  function resetMoves(full = true) {
    endInferno('reset');
    X.mom = newMomentum();
    if (full) X.special = 0;
    if (X.skim.on) { try { game.fx?.skimMist?.(dragon, false); } catch { /* ignore */ } emit('skim', { on: false, kind: X.skim.kind, actor: me() }); }
    Object.assign(X.skim, { v: 0, on: false, kind: null, tick: 0, mistT: 0 });
    X.near.last = -1e9; X.near.vyMin = 0; X.near.fastAt = -1e9; X.dashAt = -1e9;
    Object.assign(W.charge, { held: false, t: 0, level: 0, started: false, full: false });
    latch.move = null; latch.inferno = false; latch.fPress = false; latch.fRelease = false;
    Object.assign(keyReader, makeKeyReader());
    resetFlightMode();
    try { body?.cancelMove?.(); } catch { /* ignore */ }
  }

  /** The mode machine restarts from what the body does now: fast → the flare into the hover, slow → the hover. */
  function resetFlightMode() {
    const V = body?.vel?.length?.() ?? 0;
    Object.assign(FM, newFlightMode(V > MODES.hoverV ? 'toHover' : 'hover'));
    AA.target = null; AA.look = false; AA.inRange = false;
  }

  function aimVector() {
    const rig = game.cameraRig, inp = input();
    const free = inp && (inp.down('Mouse2') || inp.down('AltLeft') || inp.down('AltRight'));
    if (free) {
      if (!aim.frozen) aim.frozen = aim.dir.clone();
      return aim.frozen;            // free-look orbit: course unchanged
    }
    aim.frozen = null;
    if (rig?.aimDir && Number.isFinite(rig.aimDir.x) && rig.aimDir.lengthSq() > 0.5) { aim.dir.copy(rig.aimDir); return aim.dir; }
    // Fallback aim from raw mouse deltas (pointer lock or drag).
    if (inp) {
      aim.yaw -= (inp.mouse.dx || 0) * 0.0021;
      aim.pitch = clamp(aim.pitch - (inp.mouse.dy || 0) * 0.0021, -75 * DEG, 75 * DEG);
      if (inp.pad) { aim.yaw -= inp.pad.rx * 2.4 * (game.time.dt || 0.016); aim.pitch = clamp(aim.pitch - inp.pad.ry * 2.4 * (game.time.dt || 0.016), -75 * DEG, 75 * DEG); }
    }
    aim.dir.set(Math.sin(aim.yaw) * Math.cos(aim.pitch), Math.sin(aim.pitch), Math.cos(aim.yaw) * Math.cos(aim.pitch));
    return aim.dir;
  }

  // ------------------------------------------------------------------------------------------------ aim assist
  const _ro = new THREE.Vector3(), _rd = new THREE.Vector3(), _rq = new THREE.Vector3(), _rx = new THREE.Vector3();
  const _rm = new THREE.Vector3(), _rv = new THREE.Vector3(), _rs = new THREE.Vector3(), _rt = new THREE.Vector3();
  /** Rotate unit v toward unit t by at most maxA (rad), into out; returns the angle turned. */
  function bendToward(v, t, maxA, out) {
    const a = Math.acos(clamp(v.dot(t), -1, 1));
    if (!(a > 1e-6) || !(maxA > 0)) { out.copy(v); return 0; }
    _rx.crossVectors(v, t);
    const al = _rx.length();
    if (al < 1e-9) { out.copy(v); return 0; }
    const k = Math.min(a, maxA);
    out.copy(v).applyAxisAngle(_rx.multiplyScalar(1 / al), k);
    return k;
  }
  /** The titan's core window (titan.coreOpen(): after a volley or a missed blow the core blazes open). Never throws. */
  function titanCoreOpen() {
    try { return typeof game.titan?.coreOpen === 'function' ? !!game.titan.coreOpen() : false; } catch { return false; }
  }
  /** The reticle ray as the player sees it: from the camera through the reticle (cameraRig.aimPoint), else along the aim. */
  function reticleRay(o, d, aimD) {
    const rig = game.cameraRig, cam = game.camera, ap = rig?.aimPoint;
    if (cam?.position && ap?.isVector3 && Number.isFinite(ap.x + ap.y + ap.z) && !aim.frozen && !rig.aimFrozen) {
      o.copy(cam.position); d.subVectors(ap, o);
      const l = d.length();
      if (l > 1) { d.multiplyScalar(1 / l); return; }
    }
    o.copy(dragon.pos); d.copy(aimD);
    if (!(d.lengthSq() > 1e-6)) d.set(0, 0, 1).applyQuaternion(dragon.quat);
    d.normalize();
  }
  /**
   * The soft target and the magnetised aims (every fixed step in 'play', after the aim is known). aimD: the aim the
   * dragon flies (cameraRig.aimDir); turnD: the hover heading aim (the mouse's world target). Never throws.
   */
  function aimAssistStep(aimD, turnD) {
    const d0 = dragon, p = d0.pos;
    reticleRay(_ro, _rd, aimD);
    const lock = game.cameraRig?.lockTarget;
    const pick = pickSoftTarget(game.actors || [], { origin: _ro, dir: _rd, from: p, team: d0.actor?.team || 'player', self: d0.actor,
      current: AA.target, lock: lock && lock.alive !== false ? lock.actor || lock : null, titanActive: game.titan?.active !== false,
      coreOpen: titanCoreOpen() });
    AA.lockPreferred = !!pick?.locked;
    const src = flameSource(), mouth = src.mouth;
    const sel = pick;
    AA.target = sel ? sel.a : null;
    AA.core = !!sel?.core; AA.coreRef = sel?.core ? sel.core.a : null;
    AA.angle = sel ? sel.ang : 0; AA.dist = sel ? sel.dist : 0; AA.r = sel ? sel.r || 0 : 0;
    const headBase = _rm;
    {
      const ap = game.cameraRig?.aimPoint;
      if (ap?.isVector3 && Number.isFinite(ap.x + ap.y + ap.z) && !aim.frozen) headBase.subVectors(ap, mouth);
      else headBase.copy(aimD);
      if (!(headBase.lengthSq() > 1e-6)) headBase.copy(aimD);
      headBase.normalize();
    }
    if (!sel) {
      AA.dir.copy(aimD); AA.turn.copy(turnD); AA.head.copy(headBase);
      AA.bend = 0; AA.look = false; AA.inRange = false;
      return;
    }
    AA.point.copy(sel.pt);
    // the flame's lead point: the flame leaves the mouth at AIM.flame m/s on top of the dragon's own velocity
    const vT = sel.a.vel?.isVector3 ? sel.a.vel : _zero;
    const vRel = _rv.subVectors(vT, d0.vel);
    const rel = _rt.subVectors(AA.point, mouth);
    const muzzle = game.fx?.config?.breath?.muzzle ?? AIM.flame;
    // levels: the lightning / storm breath is a hitscan beam along the mouth (fx config.lightning): no lead — the head
    // looks at the target itself, out to the beam's own reach
    const LB = LV.pv.bolt ? game.fx?.config?.lightning : null;
    const tF = LB ? 0 : Math.min(1.2, interceptTime(rel, vRel, muzzle));
    AA.lead.copy(AA.point).addScaledVector(vRel, tF);
    // magnetism: the flown aim / the hover heading / the head bend ≤ AIM.magnet toward it. A camera rig that bends its
    // own aimDir / aimPoint toward player.softTarget (cameraRig.aimMagnet.applied) has done it for the flown aim and the
    // reticle already: it is not bent twice (the head's look-at inside the breath cone stays ours)
    const rigMag = game.cameraRig?.aimMagnet;
    const camMag = !!rigMag?.applied;
    const toP = _rs.subVectors(AA.lead, p);
    if (toP.lengthSq() > 1) toP.normalize(); else toP.copy(aimD);
    if (camMag) { AA.dir.copy(aimD); AA.bend = (+rigMag.leanDeg || 0) * DEG; }
    else AA.bend = bendToward(aimD, toP, AIM.magnet, AA.dir);
    const tH = _rq.set(toP.x, 0, toP.z);
    if (tH.lengthSq() > 1e-6 && Math.hypot(turnD.x, turnD.z) > 1e-3) bendToward(turnD, tH.normalize().multiplyScalar(1).setY(turnD.y).normalize(), AIM.magnet, AA.turn);
    else AA.turn.copy(turnD);
    // the breath cone is about the TARGET as seen from the mouth; the head looks at the flame's lead point — only once
    // the flame can reach it (farther out the lead of a 1 s flight would swing the head far off the target), and never
    // more than the cone off the target itself
    const reach0 = LB && Number.isFinite(+LB.maxRange) && +LB.maxRange > 0 ? +LB.maxRange : (game.fx?.config?.breath?.maxRange ?? 60);
    const reach = reach0 * (X.inferno.on ? (game.fx?.config?.breath?.inferno?.range ?? 1.5) : 1);
    const toT = _rt.subVectors(AA.point, mouth);
    const dT = toT.length();
    if (dT > 1e-3) toT.multiplyScalar(1 / dT); else toT.copy(headBase);
    AA.look = Math.acos(clamp(toT.dot(headBase), -1, 1)) <= AIM.breathCone;
    const leadW = 1 - smoothstep(reach, reach * 1.6, dT - (sel.r || 0));
    AA.lead.copy(AA.point).addScaledVector(vRel, tF * leadW);
    const toM = _rs.subVectors(AA.lead, mouth);
    const dm = toM.length();
    if (dm > 1e-3) toM.multiplyScalar(1 / dm); else toM.copy(toT);
    bendToward(toT, toM, AIM.breathCone, toM);                                  // (the lead stays within the cone)
    AA.lead.copy(mouth).addScaledVector(toM, dm);
    if (AA.look) AA.head.copy(toM); else if (camMag) AA.head.copy(headBase); else bendToward(headBase, toM, AIM.magnet, AA.head);
    AA.inRange = AA.look && dT - (sel.r || 0) <= reach;
  }

  function syncFallbackAim() {
    if (!body) return;
    const v = body.vel.lengthSq() > 1 ? _v.copy(body.vel).normalize() : _v.set(0, 0, 1).applyQuaternion(body.quat);
    aim.yaw = Math.atan2(v.x, v.z); aim.pitch = Math.asin(clamp(v.y, -1, 1));
    aim.dir.copy(v);
  }

  // ------------------------------------------------------------------------------------------------ weapons
  const isAlive = () => !!dragon && dragon.alive !== false && dragon.actor?.alive !== false;

  /** Breath / fireball source: the dragon itself, or a proxy with a body-derived mouth when the dragon's is not sane. */
  function flameSource() {
    const d = dragon, m = d.mouth;
    if (m?.isVector3 && Number.isFinite(m.x + m.y + m.z) && d.pos && m.distanceToSquared(d.pos) < 625 && d.mouthDir?.lengthSq() > 0.5) return d;
    if (!proxy) {
      const mv = new THREE.Vector3(), mdv = new THREE.Vector3(), local = new THREE.Vector3();
      proxy = {
        get mouth() { const sc = body?.scale || 1; return body ? body.toWorld(local.set(0, 1.05 * sc, 5.9 * sc), mv) : mv.copy(dragon.pos); },
        get mouthDir() { return mdv.set(0, -0.12, 1).normalize().applyQuaternion(body?.quat || dragon.quat); },
        get vel() { return dragon.vel; }, get alive() { return isAlive(); },
        get actor() { return dragon.actor; }, get root() { return dragon.root; }, get team() { return dragon.actor?.team || 'player'; },
      };
    }
    return proxy;
  }

  /** Breath on / off; mode 'inferno' (wave 6) is the special's super breath — fx blends a running stream over. */
  function setBreath(on, mode = 'normal') {
    const el = LV.pv.element || 'ember', surge = on && mode === 'inferno' && !!X.inferno.surge;
    W.breathOn = on; W.breathMode = on ? mode : null; W.breathEl = on ? el : null; W.breathSurge = surge;
    const src = on ? flameSource() : (W.breathSrc || flameSource());
    W.breathSrc = on ? src : null;
    // (levels: the element rides along — fx draws ember / azure / radiant flame or the lightning / storm arcs, and applies
    //  game.progress.dmgMult to the ticks itself; a level-up mid-stream calls again with the new element)
    if (game.fx?.breath) {
      try { if (on) game.fx.breath(src, true, surge ? { mode, element: el, surge: true } : { mode, element: el }); else game.fx.breath(src, false); }
      catch (e) { warnOnce('fx.breath', e); }
    } else game.events.emit('breath', { actor: dragon.actor || dragon, on });
  }

  function resetWeapons() {
    if (W.breathOn && dragon) setBreath(false);
    W.heat = 0; W.overheated = false; W.lockT = 0; W.idle = 0; W.gapT = 0; W.rechargeT = 0; W.fbPrev = false;
    W.fireball.charges = W.fireball.maxCharges; W.fireball.cooldown = 0; W.fireball.ready = true; W.rechargeQ.length = 0;
    publish();
  }

  function publish() {
    const d = dragon; if (!d) return;
    try { d.heat = W.heat; d.overheated = W.overheated; } catch { /* read-only on some dragon class: ignore */ }
    if (d.fireball !== W.fireball) { try { d.fireball = W.fireball; } catch { /* ignore */ } }
    d.grabbed = grab.on;
    // wave 6 — the flight-move contract on game.player
    try {
      const st = body?.state, fm = st?.move || null;
      MV.current = fm || (X.inferno.on ? 'inferno' : null);
      MV.side = fm ? st.moveSide || 0 : 0;
      MV.t = fm ? st.moveT || 0 : X.inferno.on ? X.inferno.t : 0;
      MV.phase = fm ? st.movePhase : X.inferno.on ? 'inferno' : null;
      MV.u = fm ? st.moveU || 0 : X.inferno.on ? clamp(X.inferno.t / INFERNO.dur, 0, 1) : 0;
      MV.queued = st?.moveQueued || null;
      MV.last = st?.lastMove || null;
      MV.denied = st?.moveDenied || null;
      if (d.moves !== MV) d.moves = MV;
      d.momentum = X.mom.level;
      d.skyfall = X.mom.skyfallT > 0;
      d.skyfallT = X.mom.skyfallT;
      d.special = X.special;
      d.fireCharge = W.charge.held ? W.charge.level : 0;
      d.infernoActive = X.inferno.on;
      // levels and elements (read-only mirrors of game.progress as applied here; game.progress stays the source)
      d.surgeActive = X.inferno.on && !!X.inferno.surge;
      d.level = LV.pv.level; d.element = LV.pv.element; d.weaponKind = LV.pv.bolt ? 'bolt' : 'fireball';
      d.skim = X.skim.v;
      d.skimKind = X.skim.on ? X.skim.kind : null;
    } catch { /* a read-only field on some dragon class: ignore */ }
    // flight modes + aim assist (contract): flightMode 'hover' | 'flight' | 'transition', flightPhase (the machine's own
    // state), throttle 0..1, hover (weight of the hover stroke), softTarget, inRange, aimAssist, and the head's aim
    try {
      const play = game.state === 'play' || game.state === 'paused' || game.state === 'photo';
      d.flightMode = flightModeName(FM.mode); d.flightPhase = FM.mode; d.throttle = FM.throttle;
      d.hover = body?.state?.hover ?? 0;
      const live = play && isAlive();
      d.softTarget = live ? AA.target : null;
      d.inRange = live && !!AA.target && AA.inRange;
      d.aimAssist = AA;
      // the head (and so the flame) looks at the soft target's lead point inside the breath cone, else along the
      // magnetised aim; outside play the Dragon's own gaze (camera aim / course) is left alone
      if (d.lookTarget !== undefined || live) d.lookTarget = live && AA.look && AA.target ? AA.lead : null;
      if (d.aimDir !== undefined || live) d.aimDir = live ? AA.head : null;
    } catch { /* ignore */ }
  }

  function weaponsStep(dt) {
    const H = WEAPONS.heat, FB = WEAPONS.fireball, F = W.fireball;
    const alive = isAlive(), live = game.state === 'play' && alive;
    // INFERNO (R with a full special meter, wave 6): 4 s of super breath whatever LMB does; the meter drains, the
    // heat vents instead of rising (no overheat lockout while it burns)
    if (latch.inferno) {
      latch.inferno = false;
      if (live && !X.inferno.on && X.special >= 1 - 1e-6) startInferno();
      else X.infernoDenied = { t: nowS(), special: X.special };
    }
    const inf = X.inferno.on;
    if (inf) {
      X.inferno.t += dt;
      X.special = Math.max(0, 1 - X.inferno.t / INFERNO.dur);
      if (X.inferno.t >= INFERNO.dur) endInferno('done');
      else if (!live) endInferno(alive ? 'state' : 'dead');
    }
    // heat / overheat lockout
    if (W.overheated) { W.lockT -= dt; if (W.lockT <= 0) W.overheated = false; }
    let on = live && ((W.want && !W.overheated) || X.inferno.on);
    if (on && !X.inferno.on) {
      W.heat = Math.min(1, W.heat + H.rise * dt); W.idle = 0;
      if (W.heat >= 1) { W.overheated = true; W.lockT = H.lockout; on = false; }
    } else {
      W.idle += dt;
      if (W.idle > H.coolDelay || W.overheated || X.inferno.on) W.heat = Math.max(0, W.heat - H.cool * dt);
    }
    if (dragon.controls) dragon.controls.breath = on ? 1 : 0;
    const mode = X.inferno.on ? 'inferno' : 'normal';
    const el = LV.pv.element || 'ember', surge = mode === 'inferno' && !!X.inferno.surge;
    if (on !== W.breathOn || (on && (mode !== W.breathMode || el !== W.breathEl || surge !== !!W.breathSurge))) setBreath(on, mode);
    // fireball charges: one at a time, each spent charge in its own time (a charged shot's recharges slower, CHARGE;
    // a bolt's own recharge, BOLT)
    F.kind = LV.pv.bolt ? 'bolt' : 'fireball'; F.element = el;
    const need = W.rechargeQ[0] ?? (LV.pv.bolt ? BOLT.recharge : FB.recharge);
    const hw = clamp(+(body?.state?.hover) || 0, 0, 1);
    const rate = 1 / (1 + ((FB.hoverRecharge ?? 1) - 1) * hw);          // (recharge speed: slower in the hover)
    if (F.charges < F.maxCharges) {
      W.rechargeT += dt * rate;
      if (W.rechargeT >= need) { F.charges++; W.rechargeT = 0; W.rechargeQ.shift(); }
    } else { W.rechargeT = 0; W.rechargeQ.length = 0; }
    W.gapT = Math.max(0, W.gapT - dt);
    // F (wave 6): a tap fires the normal fireball on release, a hold charges it (see chargeStep)
    chargeStep(dt, live);
    const base = LV.pv.bolt ? BOLT.recharge : FB.recharge;
    const needNow = W.rechargeQ[0] ?? base;
    F.cooldown = F.charges < F.maxCharges ? Math.max(0, needNow - W.rechargeT) / rate : 0;
    F.cooldownMax = F.charges < F.maxCharges ? needNow / rate : base;
    F.ready = F.charges > 0 && W.gapT <= 0 && alive;
    publish();
  }

  /** Launch a fireball: level 0 = the normal shot, 0.2..1 = charged (fx grows its radius / speed / splash, the damage
   *  is ours: × (1 + CHARGE.damage × level)); SKYFALL makes it × 1.5 and launches it 1.35 × faster. Levels: × the
   *  level's dmgMult, in its element; at tier ≥ 4 a LIGHTNING BOLT instead (shotSpec / BOLT: fast, chains). o.free: the
   *  storm surge's opening bolt (no charge spent, no recharge queued). */
  function fireFireball(level = 0, o2 = {}) {
    const FB = WEAPONS.fireball, F = W.fireball, d = dragon, fx = game.fx;
    const sky = X.mom.skyfallT > 0;
    const pv = LV.pv, boltCfg = fx?.config?.bolt || fx?.config?.lightning?.bolt || null;   // (fx: config.lightning.bolt)
    const spec = shotSpec(pv, { charge: level, skyfall: sky, boltCfg });
    const speed = spec.speed;
    const src = flameSource();
    const mouth = src.mouth.clone(), mdir = src.mouthDir.clone().normalize();
    const rig = game.cameraRig;
    let aimD = rig?.aimDir && Number.isFinite(rig.aimDir.x) && rig.aimDir.lengthSq() > 0.5 ? rig.aimDir.clone().normalize() : mdir.clone();
    // (the reticle as seen from the mouth: in the hover the camera's reticle, not the course-led flight aim)
    if (rig?.aimPoint?.isVector3 && Number.isFinite(rig.aimPoint.x + rig.aimPoint.y + rig.aimPoint.z) && !rig.aimFrozen) {
      const rd = rig.aimPoint.clone().sub(mouth);
      if (rd.lengthSq() > 25) aimD = rd.normalize();
    }
    // the target: the aim assist's soft target (the Tab lock preferred), else the lock, else the old cone search
    let target = AA.target && AA.target.alive !== false ? AA.target : null;
    let point = target ? AA.point.clone() : null, homeAt = null, tR = target ? AA.r || 0 : 0;
    // the titan's weak point: only while its core is open (the soft pick checks the window and the 4° cone) — then the
    // shot homes on the core's live point; otherwise the shot goes at the part the reticle is on, like any target
    if (target && AA.core && AA.coreRef && titanCoreOpen()) { point = AA.coreRef.clone(); homeAt = AA.coreRef; }
    if (!target) {
      target = rig?.lockTarget && rig.lockTarget.alive !== false && rig.lockTarget.team !== (d.actor?.team || 'player') ? rig.lockTarget : null;
      if (!target && game.combat?.nearestTarget) {
        try { target = game.combat.nearestTarget(mouth, aimD, { team: 'enemy', maxAngle: FB.assistAngle, maxDist: FB.assistDist, exclude: d.actor }); } catch { target = null; }
      }
      point = target?.pos ? target.pos.clone() : null;
      tR = target ? Math.min(target.radius ?? 6, AIM.radiusMax) : 0;
      if (target?.kind === 'titan') tR = 0;
    }
    const dir = new THREE.Vector3();
    let fa = null;
    if (point) {
      // intercept lead (the shot leaves at `speed` × fx's charged speed-up relative to the dragon, which it inherits),
      // the turn off the reticle bounded (fireballAim: ≤ bend, the full lead only with the reticle on the target)
      const vT = target.vel?.isVector3 ? target.vel : _zero;
      // (a bolt keeps its speed when charged — fx is told chargedSpeed: false; an instant bolt is led as a hitscan)
      const sRel = spec.bolt ? (spec.instant ? 1e5 : speed) : speed * (level > 0 ? 1 + (fx?.config?.fireball?.chargedSpeed ?? 0.3) * level : 1);
      const vRel = _v.subVectors(vT, d.vel);
      fa = fireballAim(aimD, mouth, point, vRel, sRel, tR, dir, new THREE.Vector3());
      // (the titan's body: the shot homes on the aimed part where it will be — a fixed world point: the part + its own
      //  velocity × the flight time; fa.lead is in the dragon's frame — never on the live core)
      if (target.kind === 'titan' && !homeAt) homeAt = point.clone().addScaledVector(vT, Number.isFinite(fa.t) ? fa.t : 0);
      if (!(dir.lengthSq() > 0.5) || !Number.isFinite(dir.x + dir.y + dir.z)) dir.set(0, 0, 0);
    }
    if (dir.lengthSq() < 0.5) {
      const ap = rig?.aimPoint && Number.isFinite(rig.aimPoint.x) && !rig.aimFrozen ? rig.aimPoint : _d.copy(d.pos).addScaledVector(aimD, 400);
      dir.subVectors(ap, mouth);
      if (dir.lengthSq() < 1 || dir.normalize().dot(aimD) < 0.8) dir.copy(aimD);
    }
    const vel = d.vel.clone().addScaledVector(dir, spec.launch);      // (a bolt fx speeds up itself: sent at the fireball's)
    const damage = spec.damage;
    if (!o2.free) {
      F.charges--; W.gapT = FB.gap;
      W.rechargeQ.push(spec.recharge);   // (a charged shot's charge comes back slower)
    }
    W.shots++;
    let proj = null, via = null, boltLock = true;
    if (fx) {
      try {
        // (aimed at the titan's core, the shot homes on the core itself — fx accepts a live world point as the target)
        // (a bolt gets its target — fx's hard homing + re-aim — only with the reticle within BOLT.lockCone of it)
        boltLock = !spec.bolt || (!!fa && fa.off <= BOLT.lockCone);
        const o = { from: mouth, vel, owner: d.actor, radius: spec.radius, damage, kind: 'dragon', element: spec.element,
          target: boltLock ? homeAt || target || null : null, homing: target && boltLock ? spec.homing : undefined };
        if (level > 0) o.charged = level;
        if (spec.bolt) {
          // the lightning bolt: fx.bolt() / fx.lightningBolt() when fx has one, else fx.fireball() with element + bolt
          // (fx's fireball() makes a bolt of Sora's lightning / storm shot itself: × config.lightning.bolt.speed)
          Object.assign(o, { bolt: true, chain: spec.chain, chainRange: spec.chainRange, chainMult: spec.chainMult, chargedSpeed: false });
          if (o2.free) o.surge = true;
          if (typeof fx.bolt === 'function') { proj = fx.bolt(o); via = 'bolt'; }
          else if (typeof fx.lightningBolt === 'function') { proj = fx.lightningBolt(o); via = 'lightningBolt'; }
        }
        if (!via && typeof fx.fireball === 'function') { proj = fx.fireball(o); via = 'fireball'; }
        // a charged bolt chains more (+1 from half, +2 full): fx counts game.progress.chain; when it does not take
        // o.chain, the returned bolt's own jump count is raised (never lowered)
        if (spec.bolt && proj && Number.isFinite(proj.chainN) && spec.chain > proj.chainN) proj.chainN = spec.chain;
      } catch (e) { warnOnce(spec.bolt ? 'fx bolt' : 'fx.fireball', e); }
    }
    W.lastShot = { t: game.time.now, target: target?.name || null, dir: dir.toArray(), from: mouth.toArray(), proj: !!proj, level, damage, skyfall: sky,
      soft: !!(AA.target && target === AA.target), core: !!(homeAt && homeAt === AA.coreRef), lead: fa ? fa.lead.toArray() : point ? point.toArray() : null,
      turn: fa ? +(fa.turn / DEG).toFixed(2) : 0, off: fa ? +(fa.off / DEG).toFixed(2) : null, full: fa ? +fa.full.toFixed(2) : 0,
      kind: spec.bolt ? 'bolt' : 'fireball', element: spec.element, chain: spec.chain, speed: +speed.toFixed(1), dmgMult: +(pv.dmgMult || 1).toFixed(3),
      playerLevel: pv.level, free: !!o2.free, via, homed: !!(target && boltLock), boltChains: proj && Number.isFinite(proj.chainN) ? proj.chainN : null,
      projBolt: proj ? !!proj.bolt : null };
    // recoil at the mouth: a small backward shove and nose-up kick (bounded impulse, physics does the rest)
    try { d.applyImpulse?.(_v.copy(dir).multiplyScalar(-spec.recoil), mouth); } catch { /* ignore */ }
  }

  const warned = new Set();
  function warnOnce(k, e) { if (!warned.has(k)) { warned.add(k); console.warn('[player] ' + k + ' failed', e); } }

  /** I-frames for at least `s` seconds (see dragon.setInvulnerable). Returns the actor's invuln seconds. */
  function setInvulnerable(s) {
    const a = dragon?.actor;
    if (!a) return 0;
    const v = typeof s === 'boolean' ? (s ? 1 : 0) : +s;
    if (Number.isNaN(v)) return a.invuln || 0;
    if (v > 0) a.invuln = Math.max(a.invuln || 0, v);
    else a.invuln = Math.max(0, body?.state?.dodgeLeft || 0);
    return a.invuln;
  }

  const sys = {
    name: 'player',
    get dragon() { return dragon; },
    get flight() { return body; },
    get weapons() { return W; },
    get grab() { return grab; },
    get moves() { return X; },          // wave 6: the move meters (momentum, special, inferno, skim, close calls)
    get levels() { return LV; },        // levels: { base, applied, mult, pv (progressView), levelUps, lastHp } (read-only)
    usingStandIn: false,
    setInvulnerable: (s) => setInvulnerable(s),

    async init() {
      let DragonClass = null;
      try {
        const m = await import('./dragon.js');
        DragonClass = m.Dragon || m.default || null;
      } catch (e) { console.warn('[player] actors/dragon.js unavailable, using the stand-in dragon:', e?.message || e); }
      const opts = spawnOpts();
      if (DragonClass && !game.params?.has('standin')) {
        const actors0 = game.actors.slice(), scene0 = game.scene.children.slice();
        try { dragon = new DragonClass(game, opts); } catch (e) {
          console.error('[player] Dragon constructor failed, using the stand-in', e);
          dragon = null;
          // a half-built Dragon must not leave a phantom actor or model behind
          for (const a of game.actors.slice()) if (!actors0.includes(a)) { try { game.combat?.unregister(a); } catch { /* ignore */ } }
          for (const o of game.scene.children.slice()) if (!scene0.includes(o)) game.scene.remove(o);
        }
      }
      if (!dragon) { dragon = new StandInDragon(game, opts); sys.usingStandIn = true; }
      try { if (typeof dragon.init === 'function') await dragon.init(game); } catch (e) { console.warn('[player] dragon.init failed', e); }
      try { if (dragon.ready?.then) await dragon.ready; } catch (e) { console.warn('[player] dragon.ready failed', e); }
      hook(dragon);
      // The player system owns heat / weapons for the player's dragon; dragon.js may skip its own heat model.
      try { dragon.externalHeat = true; dragon.externalWeapons = true; } catch { /* ignore */ }
      // reset(): the director calls it with no arguments on retry -> respawn at the start spot, full weapons; with no
      // arguments while the game is at the title (the director's stop()) -> the title spawn on the circuit.
      const own = typeof dragon.reset === 'function' ? dragon.reset.bind(dragon) : null;
      dragon.reset = (pos, heading, speed) => {
        if (pos == null && heading == null && speed == null && game.state === 'title') { resetForTitle(); return; }
        const p = pos ?? START.pos.clone(), h = heading ?? START.heading, v = speed ?? 34;
        sys._quietUntil = (game.time?.real ?? 0) + 0.5;       // a deliberate jump: snapRoot() may catch up silently
        if (own) own(p, h, v);
        else if (body) {
          body.reset(p, h, v); body.stamina = 1;
          const a = dragon.actor; if (a) { a.hp = a.maxHp; a.alive = true; a.invuln = 1; }
        }
        grab.on = false; grab.recover = 0;
        try { resetMoves(true); } catch (e) { warnOnce('moves reset', e); }
        resetWeapons(); syncFallbackAim(); syncRoot();
      };
      // setInvulnerable(s) (wave 5, the director's victory): i-frames for at least s seconds from now (combat counts
      // them down; Infinity holds them); 0 / negative ends them (a dodge hop still in progress keeps its own).
      if (typeof dragon.setInvulnerable !== 'function') dragon.setInvulnerable = (s) => setInvulnerable(s);
      syncFallbackAim();
      // levels: the base max HP is the dragon's own (600) — captured now, before any level scales it
      LV.base = +dragon.actor?.maxHp > 0 ? +dragon.actor.maxHp : 600; LV.applied = null; LV.mult = 1;
      syncProgress();
      resetWeapons();
      game.player = dragon;          // the core set game.player = this system at add(); the contract wants the Dragon
      game.events.on('state', ({ next, prev }) => {
        if (next === 'play' && prev === 'title') { syncFallbackAim(); resetFlightMode(); }
        if (next === 'play') { latch.beat = false; latch.dodge = 0; latch.fireball = false; latch.move = null; latch.inferno = false; Object.assign(keyReader, makeKeyReader()); }
        if (next === 'title' || next === 'victory' || next === 'defeat') { try { resetMoves(next === 'title'); } catch (e) { warnOnce('moves reset', e); } }
        if (next !== 'play' && W.breathOn) { try { setBreath(false); if (dragon.controls) dragon.controls.breath = 0; } catch { /* ignore */ } }
        if (next === 'title' || next === 'victory' || next === 'defeat') { grab.on = false; grab.recover = 0; }
        // Back to the title (quit, results → Title): Sora starts the title glide again — level at the circuit
        // altitude and speed, wings spread — instead of the dive or low pass she was in (critic bugs #10).
        if (next === 'title' && prev && prev !== 'loading') { try { resetForTitle(); } catch (e) { warnOnce('title reset', e); } }
      });
      // wave 6 — the special meter: + per landed hit (breath: once per target per SPECIAL.fireGap s), per kill; being hit
      // blocks close calls for a moment
      const fireHit = new WeakMap();
      game.events.on('damage', (e) => {
        try {
          const a = dragon?.actor;
          if (!a || !e || !(e.amount > 0)) return;
          if (e.target === a) { X.hurtAt = nowS(); return; }
          if (e.source !== a || e.kind === 'crash' || (e.target?.team && e.target.team === a.team)) return;
          if (e.kind === 'fire' && e.target && typeof e.target === 'object') {
            const last = fireHit.get(e.target) ?? -1e9, t = nowS();
            if (t - last < SPECIAL.fireGap) return;
            fireHit.set(e.target, t);
          }
          X.stats.hits++; addSpecial(SPECIAL.hit);
        } catch (err) { warnOnce('special (damage)', err); }
      });
      game.events.on('death', (e) => {
        try { const a = dragon?.actor; if (a && e?.killer === a && e.actor !== a) { X.stats.kills++; addSpecial(SPECIAL.kill); } }
        catch (err) { warnOnce('special (death)', err); }
      });
      // levels: a level-up raises the max HP and heals what it added at once (the per-step sync would do it one step
      // later); an element change mid-breath re-lights the stream in the new element (weaponsStep)
      game.events.on('levelup', () => {
        try { LV.levelUps++; syncProgress(); publish(); } catch (err) { warnOnce('levelup', err); }
      });
      // a new run (progress.reset(): level 1 or ?debug&level=N): the max HP back to that level's at once
      game.events.on('progress:reset', () => { try { syncProgress(); publish(); } catch (err) { warnOnce('progress reset', err); } });
      game.events.on('titan:grab', (e = {}) => {
        if (!dragon || (e.actor && e.actor !== dragon.actor && e.actor !== dragon)) return;
        if (e.state === 'caught') { grab.on = true; grab.t = 0; grab.count++; latch.beat = false; latch.dodge = 0; }
        else if (e.state === 'thrown' || e.state === 'released') {
          if (grab.on) grab.recover = e.state === 'thrown' ? GRAB.recoverThrown : GRAB.recoverReleased;
          grab.on = false;
        }
        publish();
      });
    },

    update(dt, realDt) {
      // visuals (a real Dragon is also driven by its own 'dragons' system; its update is idempotent per frame)
      try { dragon?.update?.(dt, realDt, game); } catch (e) { if (!sys._warnedU) { sys._warnedU = true; console.error('[player] dragon.update failed', e); } }
      snapRoot();
      pollEdges();
      const inp = input();
      if (!dragon || !inp || game.state !== 'play') return;
      if (!game.cameraRig && inp.pressed('Mouse0') && !inp.mouse.locked) inp.requestLock?.();
    },

    fixedUpdate(dt) {
      if (!dragon || !body) return;
      const st = game.state;
      syncProgress();               // levels: max HP / heal, the element and the weapon for this step (never throws)
      try {
        if (st === 'title') titlePilot(dt);
        else if (st === 'play') {
          pollEdges();              // key edges of this frame reach the first fixed step (not one frame later)
          if (grab.on || grab.recover > 0) grabbedPilot(dt);
          else playerPilot(dt);
        }
        // never rest on the ground: FlightBody springs back up after a moment (not while dead or held by the titan)
        body.autoTakeoff = isAlive() && !grab.on;
        if (typeof dragon.fixedUpdate === 'function') dragon.fixedUpdate(dt, game);
        else body.step(dt, dragon._env || (dragon._env = makeEnv(game)));
        if (st === 'play') { dodgeFrames(dt); mechanicsStep(dt); }
        weaponsStep(dt);
      } catch (e) {
        if (!sys._warned) { sys._warned = true; console.error('[player] fixedUpdate failed', e); }
      }
    },
  };

  /** Key / button edges -> latches, once per rendered frame: from the frame's first fixed step (input.pressed() holds
   *  the edges since the last frame), or from update() when a frame runs no fixed step. */
  function pollEdges() {
    const inp = input();
    if (!dragon || !inp || game.state !== 'play') return;
    const f = game.time?.frame ?? -1;
    if (sys._edgeFrame === f) return;
    sys._edgeFrame = f;
    try {
      // Space: the power beat — or, chorded with A / D (either order), a wingover that way; with S, the loop (wave 6);
      // A A / D D: the dodge (delayed a moment, see MOVE_KEYS); W W (two short taps): the dash. See readMoveKeys().
      const key = (a, b) => ({ pressed: inp.pressed(a) || inp.pressed(b), down: inp.down(a) || inp.down(b) });
      const r = readMoveKeys(keyReader, {
        now: game.time.real, space: inp.pressed('Space'),
        A: key('KeyA', 'ArrowLeft'), D: key('KeyD', 'ArrowRight'), S: key('KeyS', 'ArrowDown'),
        tapA: inp.pressed('KeyA'), tapD: inp.pressed('KeyD'), Q: inp.pressed('KeyQ'), E: inp.pressed('KeyE'),
        W: { pressed: inp.pressed('KeyW') || inp.pressed('ArrowUp'), released: inp.released('KeyW') || inp.released('ArrowUp'),
          down: inp.down('KeyW') || inp.down('ArrowUp') },
      });
      if (r.beat) latch.beat = true;
      if (r.move) { latch.move = r.move; if (r.chord === 'after') latch.beat = false; }   // (a beat still waiting for its step is dropped)
      if (r.dodge) latch.dodge = r.dodge;
      if (inp.pressed('KeyR')) latch.inferno = true;
      // F: press starts the charge, release fires (a tap in one frame = both edges = the normal fireball)
      if (inp.pressed('KeyF')) latch.fPress = true;
      if (inp.released('KeyF')) latch.fRelease = true;
      const pad = inp.pad;
      if (pad) {
        const b = pad.buttons || [], pb = sys._padPrev || [];
        if (b[0] && !pb[0]) {
          const mv = Math.abs(pad.lx) > 0.5 ? { name: 'wingover', side: Math.sign(pad.lx) } : (pad.lt ?? 0) > 0.4 ? { name: 'loop', side: 1 } : null;
          if (mv) latch.move = mv; else latch.beat = true;
        }
        if (b[1] && !pb[1]) latch.dodge = pad.lx < -0.25 ? -1 : 1;
        if (b[2] && !pb[2]) latch.fPress = true;
        if (!b[2] && pb[2]) latch.fRelease = true;
        if (b[3] && !pb[3]) latch.move = { name: 'dash', side: 0 };
        if ((b[10] && !pb[10]) || (b[11] && !pb[11])) latch.inferno = true;
        sys._padPrev = b.slice();
      }
    } catch (e) { warnOnce('input edges', e); }
  }

  /** Respawn / title reset: the drawn dragon jumps with its physics body in the same call (no one-frame pop). */
  function syncRoot() {
    const d = dragon, r = d?.root, p = d?.pos;
    if (!r || !p || d.display || !Number.isFinite(p.x + p.y + p.z)) return;
    r.position.copy(p); if (d.quat) r.quaternion.copy(d.quat);
  }

  /** The title glide ON the title circuit (wave 5, gameplay owner: was the boot spawn off the circle): the circuit point
   *  toward the boot spawn, the autopilot's altitude for that moment, heading along the circuit, circuit speed, level,
   *  a glide spell first. */
  function resetForTitle() {
    if (!dragon?.reset) return;
    const C = TITLE_CIRCUIT, s = START.pos;
    const rx = s.x - C.center.x, rz = s.z - C.center.z, r = Math.hypot(rx, rz) || 1;
    const ux = rx / r, uz = rz / r;
    const y = C.center.y + 60 * Math.sin(TITLE_GLIDE_AT * 0.08);                  // titlePilot's altitude target
    const p = new THREE.Vector3(C.center.x + ux * C.radius, y, C.center.z + uz * C.radius);
    const heading = Math.atan2(uz, -ux);                     // tangent (counter-clockwise), as titlePilot flies it
    dragon.reset(p, heading, C.speed);
    titleT = TITLE_GLIDE_AT;                                  // the autopilot's glide spell starts right away
    if (dragon.controls) Object.assign(dragon.controls, { glide: 1, flap: 0, dive: 0, flare: 0, boost: 0, hard: 0, beat: 0, dodge: 0 });
  }

  /** Keep the drawn dragon where the physics is (title autopilot, a model swapped in late). */
  function snapRoot() {
    const d = dragon, r = d?.root, p = d?.pos;
    if (!r || !p || !Number.isFinite(p.x + p.y + p.z)) return;
    if (d.display) return;                                           // pinned display gaits place the root themselves
    if (r.position.distanceToSquared(p) > 40 * 40) {
      r.position.copy(p); if (d.quat) r.quaternion.copy(d.quat);
      // (silent within 0.5 s of a deliberate reset — a respawn or the title spawn — where a jump is expected)
      const quiet = (game.time?.real ?? 0) < (sys._quietUntil ?? -1);
      if (!quiet && !sys._snapWarned) { sys._snapWarned = true; console.warn('[player] dragon root was away from its physics body; snapped'); }
    }
  }

  /** Dodge i-frames: from the key until the hop has covered its sideways move (FlightBody state.dodgeLeft). */
  function dodgeFrames(dt) {
    const a = dragon.actor, left = body.state?.dodgeLeft;
    if (a && left > 0) a.invuln = Math.max(a.invuln || 0, left + dt);
  }

  function titlePilot(dt) {
    // Autopilot circuit behind the menu: wide banked circle, gentle glides between wingbeats.
    titleT += dt;
    const C = TITLE_CIRCUIT, p = body.pos;
    _v.set(p.x - C.center.x, 0, p.z - C.center.z);
    const r = _v.length() || 1;
    _v.multiplyScalar(1 / r);
    _d.set(_v.z, 0, -_v.x);                                   // tangent (counter-clockwise seen from above)
    _d.addScaledVector(_v, clamp((C.radius - r) / C.radius, -0.6, 0.6) * 1.5);
    _d.y = clamp((C.center.y + 60 * Math.sin(titleT * 0.08) - p.y) / 250, -0.25, 0.25);
    dragon.steer(_d, { speed: C.speed + 4 * Math.sin(titleT * 0.13), urgency: 0.15, dt });
    const c = dragon.controls;
    c.breath = 0; c.fireball = 0; c.boost = 0; c.hard = 0; c.hover = 0;    // (the title glide is forward flight)
    W.want = false; W.fbWant = false;
    if (Math.sin(titleT * 0.21) > 0.55 && body.state.airspeed > 26) { c.glide = 1; }
  }

  /** Caught in the titan's fist: no steering, wings tucked; after the throw, wings spread and the rates are damped. */
  function grabbedPilot(dt) {
    const c = dragon.controls, inp = input();
    grab.t += dt;
    if (grab.on && grab.t > GRAB.maxHold) { grab.on = false; grab.recover = GRAB.recoverReleased; }   // lost release event
    if (!grab.on) grab.recover = Math.max(0, grab.recover - dt);
    c.pitch = 0; c.roll = 0; c.yaw = 0; c.boost = 0; c.flare = 0; c.beat = 0; c.dodge = 0; c.hard = 0; c.load = 0; c.skid = 0;
    c.wingover = 0; c.loop = 0; c.dash = 0; c.hover = 0;             // (no hover controller fighting the fist / the throw)
    body?.cancelDodge?.();                                   // (a Q / E queued just before the catch must not fire in the fist)
    body?.cancelMove?.();                                    // (and no wingover / loop / dash in the fist either)
    if (grab.on) { c.flap = 0; c.glide = 1; c.dive = 1; }
    else { c.flap = 0.3; c.glide = 1; c.dive = 0; }
    latch.beat = false; latch.dodge = 0; latch.move = null;
    // (the aim assist keeps up: the head / flame on a soft target — the titan's hand — not on a stale lead point)
    try { const a = _d.copy(aimVector()); aimAssistStep(a, _turnD.copy(a)); } catch (e) { warnOnce('aim assist', e); AA.target = null; AA.look = false; AA.inRange = false; }
    // weapons stay live: Kaede can still burn the hand that holds them (the inferno too, a charged shot too)
    W.want = !!inp && (inp.down('Mouse0') || (inp.pad?.rt ?? 0) > 0.4);
    W.fDown = !!inp && (inp.down('KeyF') || !!inp.pad?.buttons?.[2]);
    c.fireball = W.charge.held ? 1 : 0;
    c.breath = (W.want && !W.overheated) || X.inferno.on ? (isAlive() ? 1 : 0) : 0;
    if (!grab.on && grab.recover <= 0) syncFallbackAim();
  }

  function playerPilot(dt) {
    const inp = input();
    const c = dragon.controls;
    const k = (code) => inp.down(code);
    const pad = inp.pad;
    // (gamepad, code only: the left stick forward is the throttle, sideways the strafe / bank; LT brake / drift back)
    const keys = {
      W: k('KeyW') || k('ArrowUp') || (pad?.ly ?? 0) < -0.35, S: k('KeyS') || k('ArrowDown') || (pad?.lt ?? 0) > 0.4,
      A: k('KeyA') || k('ArrowLeft'), D: k('KeyD') || k('ArrowRight'),
      boost: k('ShiftLeft') || k('ShiftRight') || !!pad?.buttons?.[4], ctrl: k('ControlLeft') || k('ControlRight') || !!pad?.buttons?.[5],
      space: k('Space') || !!pad?.buttons?.[0], padLx: pad ? pad.lx || 0 : 0,
    };
    const rig = game.cameraRig;
    const now = game.time?.now ?? 0;
    const aimD = _d.copy(aimVector());
    const flyingBefore = FM.mode === 'flight' || (FM.mode === 'toHover' && body.vel.length() > MODES.brakeV);
    if (!rig?.aimDir && keys.A !== keys.D && flyingBefore) {
      // no camera rig: A / D turn the fallback aim (with the rig, the camera turns its target — see camera.js)
      aim.yaw += (keys.A ? 1 : -1) * FEEL.kbRate * dt;
      aim.dir.set(Math.sin(aim.yaw) * Math.cos(aim.pitch), Math.sin(aim.pitch), Math.cos(aim.yaw) * Math.cos(aim.pitch));
      aimD.copy(aim.dir);
    }
    // hover heading: the mouse's world target (TPS: the dragon turns to face where the camera looks), else the aim
    const turnD = _turnD.copy(rig?.targetDir?.isVector3 && !aim.frozen && Number.isFinite(rig.targetDir.x) ? rig.targetDir : aimD);
    if (!(turnD.lengthSq() > 1e-6)) turnD.copy(aimD);
    turnD.normalize();
    // aim assist (AIM): soft target, magnetism, the head / flame on the target, inRange
    try { aimAssistStep(aimD, turnD); } catch (e) { warnOnce('aim assist', e); AA.target = null; AA.dir.copy(aimD); AA.turn.copy(turnD); AA.look = false; AA.inRange = false; }
    // the pilot (pilotStep, pure): the flight modes, steer() in flight, hoverSteer() in the hover
    const keep = now - X.dashAt < 3 || X.mom.level > 0.12 || X.mom.skyfallT > 0;
    const tgt = rig?.targetDir?.isVector3 && !aim.frozen ? rig.targetDir : null;
    const r = pilotStep(body, FM, keys, { aim: _flyD.copy(AA.dir), turn: AA.turn, target: tgt, now, dt, keep, stagger: dragon.stagger, alive: isAlive() });
    sys.staggerW = r.staggerW;
    sys.pilotMode = r;
    const flying = r.flying;
    // Edges -> one fixed step. Space's beat and the chords (wingover, loop) belong to forward flight — in the hover
    // Space climbs and A / D strafe; the dash (W W) also starts from the hover (a forward burst into flight), Q / E dodge.
    c.beat = latch.beat && flying ? 1 : 0; latch.beat = false;
    // (the dodge's i-frames come from the hop itself, after the physics step: see dodgeFrames())
    if (latch.dodge) { c.dodge = latch.dodge; latch.dodge = 0; }
    // wave 6: wingover / loop / dash requests (FlightBody queues them, checks stamina and cooldowns)
    if (latch.move) { if (flying || latch.move.name === 'dash') c[latch.move.name] = latch.move.side || 1; latch.move = null; }
    // Weapons: intent only; weaponsStep() gates heat, charges and calls game.fx after the physics step.
    W.fDown = k('KeyF') || !!pad?.buttons?.[2];
    W.want = k('Mouse0') || (pad?.rt ?? 0) > 0.4;
    c.fireball = W.charge.held ? 1 : 0;
    c.breath = ((W.want && !W.overheated) || X.inferno.on) && isAlive() ? 1 : 0;
  }

  return sys;
}
