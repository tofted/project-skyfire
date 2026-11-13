// game.titan — The Cloud Titan (actor.name; the HUD and director show it): a ≈ 120 m winged stone giant that rises
// out of the cloud sea, hovers on its wings, swats and grabs with enormous hands and throws fire you have to dodge.
//   game.titan = { actor (kind 'titan'), active, cameraShapes (world-space proxies incl. the feathered wings),
//                  spawn(pos | { pos, near, forward, distance, rise, instant, hpFrac }), despawn(), reset(), ready,
//                  emerged, phase, spawnInfo { t, instant, hpFrac, hp, maxHp },
//                  (instant: no rise, fight at once, config.instantDistance m ahead of `near`; hpFrac ∈ (0, 1): the
//                  director's checkpoint retry — HP = maxHp · hpFrac, enraged at once below enrageAt),
//                  knockPlayer(dv) (ramped knock, spin cap), defuseShots() (at the death),
//                  combatPhase() 1|2|3, phaseThresholds [escorts, enrage], attack, attackStage, config,
//                  windAt(pos, out) (config.applyWindForces = false: the dragons' flight env samples it),
//                  debugAttack(n | name), setEnraged(on), kill(), socket(name) → world Vector3, root, model, rig, body }
//   phase: 'dormant' | 'rising' | 'fight' | 'enraged' | 'dying' | 'dead'
//   events: 'titan:telegraph' { attack, hand, duration, target } (≥ 0.8 s before any damage; one every 4.2–5.6 s,
//           enraged 3.2–4.3 s), 'titan:attack' { attack, phase }, 'wingbeat' { actor, strength } (each downstroke),
//           'titan:grab' { actor, state: 'reach'|'caught'|'thrown'|'released', missed? }, 'titan:call' { count, phase,
//           point } (phase 2+: escorts), 'titan:dodged' { actor, attack } (a blow passed through dodge i-frames),
//           'titan:roar', 'titan:impact' { point, strength }, 'titan:phase' { phase, prev }, 'titan:emerged',
//           'titan:fallen' { point }. 'death' comes from game.combat when HP reaches 0.
//   a still target (2026-09-25, titan/camp.js): camp (the stillness meter { s, inZone, dist, speed }), campMarked(),
//           lungeReady(), guard { on, w, hand, axis }, guardCovering(), openMult(dist); attack 'lunge' (telegraph text
//           "Lunge — …"), the aimed volley (telegraph { aimed: true, text }); events 'titan:camp' { level: 'mark' },
//           'titan:guard' { on, hand, reason }, 'titan:guardbreak' { angle }, 'titan:blocked' { point, amount, part }.
// Layers (titan-boss.md §0): attack scripts give key poses + timing, titan/rig.js makes the in-betweens with
// torque-limited joints, titan/body.js hovers the heavy root on wing thrust, titan/vfx.js draws the telegraphs.
import * as THREE from 'three';
import { clamp, damp, rng as makeRng } from '../core/util.js';
import { buildProceduralTitan, loadTitanGLB } from './titan/model.js';
import { TitanRig } from './titan/rig.js';
import { HoverBody, DOWN_FRACTION } from './titan/body.js';
import { createAttack, ATTACKS } from './titan/attacks.js';
import { TitanVFX } from './titan/vfx.js';
import { CAMP, newCamp, campStep, openMultAt } from './titan/camp.js';
import { tr } from '../ui/i18n.js';

const D2R = Math.PI / 180;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const _a = V(), _b = V(), _c = V(), _d = V(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4();

export const TITAN_CONFIG = {
  hp: 9000,                           // director.balance.titan.hp wins when present
  enrageAt: 0.4,
  hoverAltitude: 1500,                // root (pelvis) altitude when no player is known
  // emergence (wave 4): from riseDepth m under the cloud-deck top up to the hover height in riseTime s — hidden, a
  // burst through the top (head, shoulders, one hand first), the wings unfurl, the head comes up last, a roar
  riseDepth: 125, riseTime: 10.5,
  standoff: { ideal: 150, min: 70, max: 360, leash: 900 },
  // Cadence: a new telegraph every `cadence` s (measured telegraph to telegraph), enraged faster. The running
  // attack's recover window is cut short for it, but never below `minRecover` s (the player's punish window).
  cadence: [4.2, 5.6], enragedCadence: [3.2, 4.3], minRecover: 0.7, tempoEnraged: 0.85, breatherEvery: 0,
  // Phase 2+ (HP below director.balance.titan.escortsAt, default 0.7): the titan raises a hand and calls escorts —
  // 'titan:call' { count, phase, point, actor } for the director. First call on entering phase 2, then every
  // `every` s while fewer than `maxAlive` enemy dragons fly.
  call: { every: 30, count: [4, 6], maxAlive: [6, 9], duration: 2.4 },
  yawRate: 13, enragedYawRate: 18,    // deg/s: a player circling at 45 m/s, 200 m out, barely out-turns it
  poise: 1500, staggerTime: 3.2,
  applyWindForces: false,             // true = push the player with windAt() here (applyForce); default false: every
                                      // dragon's flight env samples game.titan.windAt itself (player-flight owner)
  downwash: { speed: 14, radius: 110, depth: 160 },
  // hands: idle value; while a hand telegraphs / strikes it is a weak point (weak.hand), see updateWeak()
  partMult: { core: 2.5, head: 1.5, handL: 1.0, handR: 1.0, armL: 0.7, armR: 0.7, body: 1, leg: 0.6, wingL: 0.6, wingR: 0.6 },
  damage: { swat: null, clap: 1.1, slam: 1.3, grabCrush: 0.8, grabThrow: 0.45, fireball: null, meteor: 0.8, lunge: 1.25 },
  // ---- wave 4 ----
  // Solid body: every dragon near the titan is a sphere of `radius` m pushed out of the hit shapes along the surface
  // normal; the closing velocity (relative to the moving stone) is removed with a small bounce through
  // FlightBody.applyImpulse (a fast surface throws a dragon at most maxDv). The player takes 'impact' damage above
  // damageFrom m/s closing speed (never from the soft feather capsules), a camera kick and `invuln` s of i-frames.
  collision: { radius: 4.2, restitution: 0.25, wingRestitution: 0.05, friction: 0.12, damageFrom: 10, damagePerMs: 1.3, damageMax: 48,
    invuln: 0.6, cooldown: 0.8, maxDv: 34, wingMaxDv: 16, tumble: 0.25, enemies: true },
  // Weak points: a hand is ×weak.hand while it telegraphs or strikes (else partMult), the core ×weak.core; after a
  // volley or a missed blow the core blazes open for open.duration s at open.mult × its usual damage.
  // 2026-09-25: the window rewards FLYING in, not sniping it from a hover. The speed factor k = 0 (hovering, averaged
  // speed ≤ camp.still) … 1 (flying, ≥ camp.move m/s) blends: a hover gets ×slowMult within `near` m, falling to
  // ×farMult at `far` m (titan/camp.js openMultAt); a flier gets the full ×mult at any range, a bigger blazing core
  // (r 7.5 → `radius` m) and the window stays open `flyExtra` s longer. A dragon the titan has marked as still
  // (camp.mark) gets no opening at all.
  // Second pass (verifier: a hover 25–70 m in front breathed the open core at ×5 — 60 dps × 5 — after every dodged
  // blow): a hover gets ×slowMult 1.25 at every range (core ×3.1; was ×2 close = core ×5), and a blow a SLOW dragon
  // dodges inside camp.close m opens nothing (onMiss) — the window is a flier's reward.
  weak: { hand: 1.5, core: 2.5, open: { mult: 3, duration: 4, cooldown: 3, slowMult: 1.25, near: 140, far: 320, farMult: 1.25, radius: 10, flyExtra: 2.5, slowMissK: 0.5, closeMemory: 15 } },
  // Melee dodge: a dodge (Q / E) that starts within `grace` s before a blow lands makes that pass miss even when the
  // player's own i-frames are over; 'titan:strike' is the "now" cue, `cue` s before the estimated contact.
  // Second pass (verifier: the grab's hand hit 0.1–0.3 s after its "now", a swat 0.28–0.30 s after it on a dragon
  // flying in fast): every cue comes `cue` s before the EARLIEST moment that blow can hurt (the swat's is simulated
  // along its arc with the dragon's own velocity), a blow never hurts within `minLead` s of its cue (if it would, the
  // cue flashes then and the contact is void), and a dodge started after the cue spends that attack's pass.
  dodge: { grace: 0.7, cue: 0.5, minLead: 0.3 },
  // A missed melee blow leaves the titan off-balance for `duration` s: no new telegraph, the core open.
  opening: { duration: 2.4 },
  // Pursuit: farther than `start` m (horizontal) the titan glides after the player (lean up to `lean`°, terminal
  // speed ≈ sqrt(g·tan(lean) / drag) ≈ 61 m/s — a boosting dragon only just holds its lead) until it is back within
  // `stop` m; its arena anchor follows it.
  pursuit: { start: 470, stop: 290, lean: 34, drag: 0.0018, kd: 0.2, warnEvery: 30 },
  // Melee reach from the shoulder at the moment of the blow (arm ≈ 44 m + a lunge of ≤ 42 m); farther = no swat.
  swatReach: 84, grabReach: 95,
  // ---- wave 5 ----
  // Knocks (swat, slam, clap, grab throw) go through the Dragon's applyImpulse(J, null, { ramp }): 30 % now, the rest
  // as a force over `ramp` s (the contact push-out never does). The hand / forearm of a blow that landed passes through
  // the player for `passAfterHit` s (the knock carries her; before, the push-out added up to 34 m/s on top of it).
  // For `spinWindow` s after a knock or a hard bump the player's body spin is capped at `spinCap` °/s (measured before:
  // 350–1068 °/s after a swat — the flight model weathervanes into the new airflow).
  knock: { ramp: 0.1, passAfterHit: 0.35, spinCap: 240, spinWindow: 1.4, bumpFrom: 10 },
  // Checkpoint spawn ({ instant: true } without a distance): this far in front of the player, inside the pursuit start
  // (a rise keeps its longer distance so a cruising dragon does not arrive before the emergence ends).
  instantDistance: 380,
  // s of i-frames asked of the player's setInvulnerable(s) (when it exists) at the titan's death: the victory cinematic
  deathSafe: 7,
  // ---- a still target (2026-09-25: a dragon hovering 180–330 m in front of the chest sniped the core and won) ----
  // The stillness meter (titan/camp.js CAMP): s seconds parked in front of it. s ≥ mark: aimed volleys (led on the
  // target, faster shots, no lane at the target, the whole fan in half the time) and a quicker cadence (× aimed.cadence);
  // s ≥ guard: the palm ward over the core; s ≥ lunge (within lunge.reach m, in front): the wing-powered lunge + clap.
  camp: { ...CAMP },
  aimed: { extra: 3, speed: 1.35, fire: 0.5, cadence: 0.6, spacing: 3.6 },
  // The ward: the hand away from the casting hand is raised in front of the core with its rune, facing the spot the
  // player sniped from (axis fixed in the world). That hand's shape moves to the ward (dist m in front of the core,
  // radius m) and takes ×hand; a shot that still reaches the core takes ×core on top. Moving the bearing more than
  // breakAngle° breaks it: the core opens for `open` s (second pass: closing in no longer drops it, see stepCamp).
  // Second pass: the rune also shields the chest behind it (`body` ×; a camper 45 m out breathed the ×1 chest at 60 dps),
  // and a ward whose bearing changed because the TITAN threw her (buffet, gust, a knock) just drops — no reward.
  guard: { dist: 13, radius: 10.5, hand: 0.2, core: 0.2, body: 0.3, breakAngle: 30, open: 3, cooldown: 6, blendIn: 2.2, blendOut: 3, warnEvery: 12 },
  // The lunge: a coil (it drifts `pre` of the way in during the telegraph), one huge downstroke drives the body to
  // `stop` m short of the target, the hands clap shut on it. At most every `every` s; misses leave the usual opening.
  lunge: { reach: 265, stop: 38, pre: 0.3, windup: 1.3, tame: 0.4, dash: 1.1, follow: 0.45, recover: 2.2, every: 7,
    meetDist: 17, burstRadius: 50, hitRadius: 22, push: 46 },
  // Second pass — the wing buffet: a still target within `reach` m (breath range and just beyond; the lunge is for
  // farther ones) — the gust's forward beats in a wider cone (`halfAngle`°) for `blow` s: a wind that drags her outward
  // at up to `push` m/s² until she moves away at `dragTo` m/s (Δv ≤ `maxDv`; out of the hover, out of breath range — a
  // one-shot push was cancelled by the dodge hop's sideways hold), and stone grit in the wind: `damage` × swat PER SECOND
  // while she is in it within `hurt` m (half at the edge) — a dodge's i-frames cover only part of the blow, so a hover
  // that stays (or flies straight back into it) pays; one thrown clear at once takes ≈ 1 s of it.
  // Aimed from the core at her (≤ 70° off its forward; no ducking under it up close). Its "now" flash comes `dodge.cue` s before the blast: Q / E keeps
  // the damage off, nothing keeps the wind off — the hover is thrown out of breath range either way (getting clear
  // of the cone in time is the other answer). At most every `every` s; it cuts a running recover short like the lunge.
  buffet: { reach: 130, halfAngle: 55, push: 95, maxDv: 60, dragTo: 34, blow: 1.6, damage: 0.8, hurt: 90, every: 4, windup: 1.2, tame: 0.4 },
  attacks: {
    swat: { windup: 1.1, tame: 0.35, strike: 0.85, follow: 0.6, recover: 2.0, knock: 42 },
    grab: { windup: 1.3, tame: 0.2, lunge: 1.1, lock: 0.75, captureRadius: 14, hold: 1.6, throw: 0.8, release: 0.34, miss: 2.5, recover: 1.8, throwSpeed: 58 },
    clap: { windup: 1.4, tame: 0.3, strike: 0.45, follow: 0.5, recover: 1.6, meetDist: 17, burstRadius: 48, hitRadius: 20, push: 40 },
    slam: { windup: 1.6, tame: 0.5, strike: 0.6, recover: 3.5, rise: 12, column: 20, depth: 75, knock: 48 },
    volley: { raise: 0.5, charge: 1.2, fire: 0.55, recover: 1.5, count: [5, 7], speed: 90, radius: 4.5, drag: 0.0035, life: 5 },
    gust: { windup: 1.5, tame: 0.4, strike: 0.9, recover: 1.5, range: 320, halfAngle: 35, push: 70, maxDv: 36 },
    meteor: { windup: 1.2, recover: 2.0, count: [7, 12], flight: 3.0, gravity: 12, spacing: 30, radius: 5, height: 240 },
    roar: { duration: 2.2 },
  },
  weights: { swat: 1.2, grab: 1.3, clap: 1.0, slam: 0.9, volley: 1.2, gust: 0.8, meteor: 1.1 },
  cloudTop: 1150,                     // fallback deck top when game.world.cloudDensity cannot tell
};

/** Rise height over u ∈ [0, 1]: monotone cubic through keys relative to the deck top (hidden → burst → slow). */
export function riseCurve(y0, y1, deck) {
  const top = Math.max(y1, deck + 60);
  const K = [[0, y0], [0.1, deck - 62], [0.2, deck - 18], [0.31, deck + 42], [0.56, deck + 0.75 * (top - deck)], [1, y1]];
  for (let i = 1; i < K.length; i++) K[i][1] = Math.max(K[i][1], K[i - 1][1] + 1);          // strictly rising
  const n = K.length, m = new Array(n).fill(0), dk = [];
  for (let i = 0; i < n - 1; i++) dk.push((K[i + 1][1] - K[i][1]) / (K[i + 1][0] - K[i][0]));
  for (let i = 1; i < n - 1; i++) m[i] = dk[i - 1] * dk[i] <= 0 ? 0 : (2 * dk[i - 1] * dk[i]) / (dk[i - 1] + dk[i]);   // Fritsch–Carlson
  m[0] = dk[0] * 0.2; m[n - 1] = 0;                                                     // starts slowly, ends at rest
  return (u) => {
    u = clamp(u, 0, 1);
    let i = 0; while (i < n - 2 && u > K[i + 1][0]) i++;
    const h = K[i + 1][0] - K[i][0], t = (u - K[i][0]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * K[i][1] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * K[i + 1][1] + (t3 - t2) * h * m[i + 1];
  };
}

const smooth01 = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
const DEBUG_KEYS = { 1: 'swat', 2: 'grab', 3: 'clapslam', 4: 'volley', 5: 'gust', 6: 'meteor' };

export default function createTitan(game) {
  const config = structuredClone(TITAN_CONFIG);
  const R = makeRng(20260924);
  const events = game.events;

  // --- the combat actor (persistent; registered while the titan is active) ---
  const actor = {
    name: 'The Cloud Titan', kind: 'titan', team: 'enemy', hp: config.hp, maxHp: config.hp, alive: true,
    root: null, pos: V(0, config.hoverAltitude + 30, 0), vel: V(), radius: 160, shapes: [], invuln: 0,
  };

  const T = {
    name: 'titan',
    actor, config,
    active: false, ready: false, emerged: false,
    phase: 'dormant', attack: null, attackStage: null,
    enraged: false, tempo: 1,
    model: null, rig: null, body: new HoverBody(), root: new THREE.Group(), vfx: null,
    charge: { L: null, R: null }, handSpeed: { L: 0, R: 0 },
    glowLevel: 0, visibleEyes: true, blink: false,
    plan: null, cur: null, cooldown: 3, count: 0, history: [],
    anchor: V(), displacer: null, telemetry: { hitsOnPlayer: 0, attacks: {} },
    rand: () => R(),
    ATTACKS,
  };
  T.root.name = 'titan';
  T.root.visible = false;
  actor.root = T.root;
  let dying = null, rising = null, stagger = null, grab = null, gust = null;
  let lastWingbeat = 0;
  const hand = { L: { prev: V(), vel: V(), pos: V() }, R: { prev: V(), vel: V(), pos: V() } };

  // ------------------------------------------------------------------ coordinate helpers
  T.toModel = (w, out = V()) => out.copy(w).sub(T.root.position).applyQuaternion(_q.copy(T.root.quaternion).invert());
  T.toWorld = (m, out = V()) => out.copy(m).applyQuaternion(T.root.quaternion).add(T.root.position);
  T.dirToWorld = (m, out = V()) => out.copy(m).applyQuaternion(T.root.quaternion);
  T.dirToModel = (w, out = V()) => out.copy(w).applyQuaternion(_q.copy(T.root.quaternion).invert());
  T.forwardWorld = (out = V()) => out.set(0, 0, 1).applyQuaternion(T.root.quaternion);
  /** World position of a rig socket (core, chest, head, mouth, eyeL/R, palmL/R, wristL/R, footL/R, wingtipL/R, tip_<finger><L|R>…). */
  T.socket = (name, out = V()) => { const p = T.rig?.socket(name, out); return p ? T.toWorld(p, p) : null; };
  T.palmNormal = (h, out = V()) => {
    const arm = T.rig?.arms[h];
    if (!arm) return out.set(0, -1, 0);
    return T.dirToWorld(out.copy(arm.nCan).applyQuaternion(arm.hd.Gc), out);
  };
  T.palmNormalWorld = T.palmNormal;
  T.handWorld = (h, out = V()) => T.socket('palm' + h, out) || out.copy(actor.pos);
  T.armReach = () => { const a = T.rig?.arms.L; return a ? a.a + a.b + 7 : 45; };
  T.cloudTop = () => config.cloudTop;

  // ------------------------------------------------------------------ player access (Dragon object or stand-in)
  const player = () => game.player || null;
  const pActor = () => { const p = player(); return p?.actor || (p?.kind ? p : null); };
  T.playerPos = () => player()?.pos || pActor()?.pos || null;
  T.playerVel = (out = V()) => out.copy(player()?.vel || pActor()?.vel || _a.set(0, 0, 0));
  T.playerAlive = () => { const a = pActor(); return !!(a ? a.alive !== false : player()); };
  /** Player position in model space, optionally predicted t seconds ahead with lead factor lambda. */
  T.playerModel = (out = V(), t = 0, lambda = 1) => {
    const p = T.playerPos();
    if (!p) return out.set(0, 36, 150);
    out.copy(p);
    if (t > 0) out.addScaledVector(T.playerVel(_b), t * lambda);
    return T.toModel(out, out);
  };
  const playerBody = () => { const p = player(); return p?.body || p || null; };
  const playerMass = () => playerBody()?.mass || 1100;
  /** Down, dying or gone: the titan deals no more damage and no more knocks (the victory cinematic is safe). */
  const spent = () => !T.active || !actor.alive || T.phase === 'dying' || T.phase === 'dead';
  /** Velocity change on the player (N·s through FlightBody.applyImpulse when available) — per-step pushes (gust,
   *  grab hold); blows use knockPlayer. */
  T.pushPlayer = (dv, at = null) => {
    const b = playerBody();
    if (!b || !Number.isFinite(dv.x + dv.y + dv.z) || spent()) return;
    if (typeof b.applyImpulse === 'function') b.applyImpulse(_d.copy(dv).multiplyScalar(playerMass()), at);
    else if (b.vel?.isVector3) b.vel.add(dv);
  };
  /**
   * Wave 5: the knock of a blow (swat, slam, clap, grab throw) is struck, not teleported — through the Dragon's
   * applyImpulse(J, point, { ramp }) (30 % now, 70 % as a force over config.knock.ramp s, momentum conserved; at the
   * centre of mass: the Dragon adds its own bounded hit reaction and visual tumble). Else FlightBody / vel (stand-ins).
   * Starts the spin cap window (capPlayerSpin).
   */
  T.knockPlayer = (dv, at = null) => {
    const p = player();
    if (!p || !dv || !Number.isFinite(dv.x + dv.y + dv.z) || spent()) return;
    T._spinUntil = game.time.now + config.knock.spinWindow;
    T.telemetry.knocks = (T.telemetry.knocks || 0) + 1;
    T.blown();
    const b = p.body;
    if (typeof p.applyImpulse === 'function' && b && b !== p && typeof b.applyImpulse === 'function') {
      try { p.applyImpulse(_d.copy(dv).multiplyScalar(playerMass()), at, { ramp: config.knock.ramp }); return; } catch (e) { console.warn('[titan] knock', e); }
    }
    T.pushPlayer(dv, at);
  };
  /**
   * Wave 5: for config.knock.spinWindow s after a knock or a hard bump, the player's body spin is capped at
   * config.knock.spinCap °/s: ΔL = (cap / |ω| − 1) · L as an impulse couple (±J at ±1 m, no net linear change) on the
   * FlightBody. Runs at the start of the titan's step, right after the dragons' integration (angVel = I⁻¹ L).
   */
  function capPlayerSpin(now) {
    if (!(now < (T._spinUntil ?? -1)) || pActor()?.alive === false) return;   // a shot-down dragon spirals as it likes
    const b = playerBody();
    if (!b?.angVel?.isVector3 || !b.L?.isVector3 || !b.pos?.isVector3 || typeof b.applyImpulse !== 'function') return;
    const w = b.angVel.length(), cap = config.knock.spinCap * D2R;
    if (!(w > cap) || !Number.isFinite(w) || !Number.isFinite(b.L.x + b.L.y + b.L.z)) return;
    const dL = _sL.copy(b.L).multiplyScalar(cap / w - 1), l2 = dL.lengthSq();
    if (!(l2 > 1e-6)) return;
    const u = _su.set(1, 0, 0);
    if (Math.abs(u.dot(dL)) > 0.8 * Math.sqrt(l2)) u.set(0, 1, 0);
    u.addScaledVector(dL, -u.dot(dL) / l2).normalize();                           // lever ⟂ ΔL, 1 m
    const J = _sJ.crossVectors(dL, u).multiplyScalar(0.5);                        // 2 u × J = ΔL
    b.applyImpulse(J, _sp.copy(b.pos).add(u));
    b.applyImpulse(J.negate(), _sp.copy(b.pos).sub(u));
    T.telemetry.spinCapped = (T.telemetry.spinCapped || 0) + 1;
    T.telemetry.spinSeen = Math.max(T.telemetry.spinSeen || 0, Math.round(w / D2R));
  }
  const _sL = V(), _su = V(), _sJ = V(), _sp = V();

  // ------------------------------------------------------------------ feedback helpers used by attacks
  T.sound = (name, o = {}) => { try { game.audio?.play?.(name, { pos: actor.pos, volume: 1, ...o }); } catch { /* optional */ } };
  T.shake = (amount, dur, preset = 'titan') => { try { game.cameraRig?.shake?.(amount, dur, preset); } catch { /* optional */ } };
  T.glint = () => { T.vfx?.glint(); T.blinkT = 9; };
  T.coreFlare = (k, dur) => T.vfx?.coreFlare(k, dur);
  T.armGlow = (h, k) => { T.armWave(h, 1.0, k); };
  T.armWave = (h, dur = 1, k = 1) => { const w = T.waves[h]; w.t = 0; w.dur = dur; w.k = k; w.on = true; };
  // HUD text for melee telegraphs names the answer (the HUD shows e.text when given): roll on the palm flash.
  // (Languages, 29.09: getters — the text in the player's language when the telegraph is emitted; ru-game.js.)
  const TELE_TEXT = {
    get swat() { return tr('Swat — dodge Q / E on the flash'); }, get grab() { return tr('Grab — dodge Q / E or break away'); },
    get clap() { return tr('Clap — pull away or dodge Q / E'); }, get slam() { return tr('Hammer slam — get out from under it'); },
    get lunge() { return tr('Lunge — fly out of its path or dodge Q / E'); },
    get buffet() { return tr('Wing buffet — get clear, or dodge Q / E on the flash'); },
  };
  T.telegraph = (attack, h, duration, a) => {
    // an attack may name its own answer (the aimed volley at a still target; its English text is the key)
    const text = a?.teleText ? tr(a.teleText) : TELE_TEXT[attack];
    const level = a?.teleLevel ?? 2;
    events.emit('titan:telegraph', { attack, hand: h, duration: Math.max(0.8, duration), target: pActor(), actor, ...(text ? { text, level } : {}), ...(a?.aimed ? { aimed: true } : {}) });
  };
  T.emitAttack = (a) => { events.emit('titan:attack', { attack: a.name, phase: T.phase, hand: a.hand, actor }); };
  T.dmg = (kind) => {
    const B = game.director?.balance || {};
    const swat = B.titanSwat ?? 140, fb = B.titanFireball ?? 90;
    const m = config.damage;
    switch (kind) {
      case 'swat': return m.swat ?? swat;
      case 'clap': return swat * (m.clap ?? 1.1);
      case 'slam': return swat * (m.slam ?? 1.3);
      case 'grabCrush': return swat * (m.grabCrush ?? 0.8);
      case 'grabThrow': return swat * (m.grabThrow ?? 0.45);
      case 'fireball': return m.fireball ?? fb;
      case 'meteor': return fb * (m.meteor ?? 0.8);
      case 'lunge': return swat * (m.lunge ?? 1.25);
      case 'buffet': return swat * (config.buffet?.damage ?? 0.5);
      default: return swat;
    }
  };
  /**
   * The player is dodging this blow: inside their own i-frames, or (melee) their dodge started during the running
   * attack no more than config.dodge.grace s ago — the i-frames of a roll timed on the "now" cue cover the contact.
   * I-frames that only come from bumping into the titan (collision) are not a dodge.
   */
  T.playerDodging = () => {
    const a = pActor();
    if (!a) return false;
    const now = game.time.now;
    // i-frames count as a dodge only when a roll started recently (a roll's own i-frames last ≈ 0.7–0.8 s) or when
    // they are not the bump's (whose window has a margin: the combat system counts invuln down in its own step)
    const rolled = now - (T.playerDodgeT ?? -99) < 0.9;
    const bumpOnly = now < (T._bumpInvulnUntil ?? -1) && !rolled;
    if (a.invuln > 0 && !bumpOnly) return true;
    const c = T.cur;
    if (!c || !MELEE.has(c.name)) return false;
    // second pass: a dodge started on (or after) this blow's "now" flash spends its pass — the follow-through or a
    // late clap does not come back for her
    if (c.cueT != null && !c.caught && T.playerDodgeT >= c.cueT - 0.1 && T.playerDodgeT <= now) return true;
    return T.playerDodgeT >= c.startT - 0.05 && now - T.playerDodgeT <= config.dodge.grace;
  };
  /**
   * Second pass: may this melee blow hurt her now? Only once its "now" cue has been out for config.dodge.minLead s.
   * A blow that would land before it (a dragon flying fast into the swing, a cue that could not be predicted) flashes
   * the cue at once and the contact is void this step (the pass goes on). → true when the blow may land.
   */
  T.cueReady = (a, h = a?.hand) => {
    if (!a) return true;
    if (a.cueT == null) { T.strikeCue(a, h, config.dodge.minLead); T.telemetry.lateCues = (T.telemetry.lateCues || 0) + 1; return false; }
    if (game.time.now - a.cueT >= config.dodge.minLead) return true;
    if (!a._voided) { a._voided = true; T.telemetry.voidEarly = (T.telemetry.voidEarly || 0) + 1; }
    return false;
  };
  T.hitPlayer = (amount, point, dir, kind = 'swat', part = 'handR', dv = null) => {
    const a = pActor();
    if (!a || a.alive === false || spent()) return false;
    if (a.invuln > 0 && !T.playerDodging()) return false;          // bump i-frames: no damage, the pass goes on
    if (T.playerDodging()) {
      const now = game.time.now;
      T.lastDodge = { t: now, attack: T.cur };            // the running attack's pass is spent (see attacks.js)
      if (!(now - (T._dodgedT ?? -9) < 0.6)) {           // once per pass, not every step of the overlap
        T._dodgedT = now; T.telemetry.dodged = (T.telemetry.dodged || 0) + 1;
        events.emit('titan:dodged', { actor: a, attack: T.attack, kind, point: point.clone() });
      }
      return false;
    }
    const done = game.combat ? game.combat.damage(a, amount, { source: actor, point: point.clone(), dir: dir.clone().normalize(), kind, part }) : amount;
    if (dv) T.knockPlayer(dv, null);
    // the hand of this blow now passes through her for a moment (the knock carries her; no push-out on top of it)
    const side = T.cur?.hand === 'both' ? 'LR' : /^hand[LR]$/.test(part) ? part.slice(-1) : (T.cur?.hand || '');
    T._hitPass = { until: game.time.now + config.knock.passAfterHit, hands: side };
    try { const p = player(); if (p) lastBump.set(p, game.time.now); } catch { /* ignore */ }   // the knock-back bump is part of this blow
    T.telemetry.hitsOnPlayer++;
    try { game.hitstop?.(0.1); } catch { /* optional */ }
    T.shake(0.55, 0.8, 'titan');
    T.vfx?.ring(point, _a.set(0, 1, 0), 3, 26, 0.45, 0xfff0d0, 1, true);
    events.emit('titan:impact', { point: point.clone(), strength: 0.8, kind });
    return done > 0;
  };
  /**
   * Second pass: light damage over time (the buffet's stone grit) — no knock, no hitstop, no dodge bookkeeping; the
   * player's i-frames (a dodge) stop it for as long as they last. → the damage dealt.
   */
  T.grit = (amount, point, dir, part = 'wingL') => {
    const a = pActor();
    if (!a || a.alive === false || spent() || !(amount > 0) || !game.combat) return 0;
    const done = game.combat.damage(a, amount, { source: actor, point: point.clone(), dir: dir.clone().normalize(), kind: 'impact', part }) || 0;
    if (done > 0) T.telemetry.grit = (T.telemetry.grit || 0) + done;
    return done;
  };
  /** Hand (palm sphere + forearm capsule) vs the player during a live window. */
  T.handContact = (h, { damage, minSpeed = 20, gate = null }) => {
    const pp = T.playerPos();
    if (!pp) return false;
    const speed = hand[h].vel.length();
    if (speed < minSpeed) return false;
    const pr = pActor()?.radius ?? 3;
    const palm = T.handWorld(h, _a);
    const wrist = T.socket('wrist' + h, _b), elbow = T.socket('elbow' + h, _c);
    const tip = T.socket('tip_middle' + h, V());
    const dPalm = Math.min(pp.distanceTo(palm) - 8 - pr, tip ? pp.distanceTo(tip) - 4.5 - pr : Infinity);
    let dFore = Infinity;
    if (wrist && elbow) {
      const ab = _d.subVectors(wrist, elbow);
      const t = clamp(V().subVectors(pp, elbow).dot(ab) / Math.max(1e-6, ab.lengthSq()), 0, 1);
      dFore = pp.distanceTo(elbow.clone().addScaledVector(ab, t)) - 4.5 - pr;
    }
    if (Math.min(dPalm, dFore) > 0) return false;
    if (gate && !T.playerDodging() && !T.cueReady(gate, h)) return false;       // too soon after its "now" flash
    const dir = hand[h].vel.clone().normalize();
    const knock = dir.clone().multiplyScalar(Math.min(config.attacks.swat.knock, speed * 0.55)).add(V(0, 6, 0));
    return T.hitPlayer(damage, pp.clone(), dir, 'swat', 'hand' + h, knock);
  };
  T.lungeToward = (targetModel, dist, dur) => {
    if (!(dist > 0.5)) return;
    const dirW = T.dirToWorld(_a.set(targetModel.x, 0, targetModel.z).normalize(), V());
    T.body.lunge(dirW, dist, dur);
  };
  /** Lunge so the target (model point) ends up `want` metres in front of the chest (horizontal), max `cap` m. */
  T.engage = (pm, want, dur, cap = 40) => {
    const chest = T.rig.socket('chest', V());
    const d = Math.hypot(pm.x - chest.x, pm.z - chest.z);
    const dist = clamp(d - want, 0, cap);
    if (dist > 0.5) T.lungeToward(pm, dist, dur);
    return dist;
  };
  T.airBurst = (point, { radius, killRadius, damage, push, gate = null }) => {
    T.vfx?.ring(point, _a.set(0, 0, 1), 4, radius, 0.55, 0xfff4e0, 1, true);
    T.vfx?.ring(point, _a.set(0, 1, 0), 6, radius * 1.4, 0.8, 0xffd8a0, 0.6, false);
    T.vfx?.dust(point, 6, 14, 18);
    T.shake(0.6, 0.9);
    try { game.hitstop?.(0.08); } catch { /* optional */ }
    try { game.clouds?.punch?.(point, radius * 1.2, 4, 0.8); } catch { /* optional */ }
    events.emit('titan:impact', { point: point.clone(), strength: 1, kind: 'clap' });
    T.sound('titan-clap');
    const pp = T.playerPos();
    if (!pp) return;
    const d = pp.distanceTo(point);
    if (d < radius) {
      const dir = _a.subVectors(pp, point).normalize();
      // (second pass) a clap that meets her before its "now" flash has been out long enough only shoves her
      const fair = d < killRadius && (!gate || T.playerDodging() || T.cueReady(gate, 'both'));
      if (fair) T.hitPlayer(damage, pp.clone(), dir, 'swat', 'handL', dir.clone().multiplyScalar(push));
      else T.knockPlayer(dir.clone().multiplyScalar(push * (1 - d / radius)));
    }
  };
  T.slamImpact = (point) => {
    T.shake(0.85, 1.4);
    try { game.hitstop?.(0.1); } catch { /* optional */ }
    T.vfx?.ring(point, _a.set(0, 1, 0), 8, 150, 1.4, 0xfff6e8, 0.9, false);
    T.vfx?.ring(point.clone().add(V(0, -40, 0)), _a.set(0, 1, 0), 10, 220, 1.8, 0xd8e0ff, 0.5, false);
    T.vfx?.debris(point, 26, 30, 2.4, 0.9);
    const deck = config.cloudTop;
    if (point.y - deck < 450) { try { game.clouds?.punch?.(V(point.x, deck, point.z), 160, 6, 1); } catch { /* optional */ } }
    events.emit('titan:impact', { point: point.clone(), strength: 1.4, kind: 'slam' });
    T.sound('titan-slam');
  };
  T.roar = (k = 1) => {
    events.emit('titan:roar', { actor, strength: k });
    T.sound('roar', { volume: k });
    T.shake(0.4 * k, 1.8);
    T.vfx?.scatterBirds?.();
  };
  // fire
  T.chargePalm = (h, dur) => {
    T.charge[h] = { t: 0, dur, fx: null };
    try {
      const s = T.palmObj[h];
      if (s && game.fx?.charge) T.charge[h].fx = game.fx.charge(s, dur, 3.2, { kind: 'titan', team: 'enemy' });
    } catch { /* optional */ }
  };
  T.chargeStop = (h) => { try { T.charge[h]?.fx?.stop?.(); } catch { /* ignore */ } T.charge[h] = null; };
  T.rune = (h, on) => T.vfx?.rune(h, on);
  T.shoot = (h, dir, o) => {
    const from = T.handWorld(h, V()).addScaledVector(dir, 8);
    const vel = dir.clone().multiplyScalar(o.speed).addScaledVector(T.body.vel, 0.5);
    T.shootFrom(from, vel, o);
  };
  T.shootFrom = (from, vel, o) => {
    const go = () => {
      if (spent()) return;                                 // a delayed shot never leaves a dying titan
      const opts = { from, vel, owner: actor, radius: o.radius, damage: o.damage, gravity: o.gravity || 0, drag: o.drag || 0, life: o.life, kind: 'titan', team: 'enemy' };
      if (game.fx?.fireball) {
        try { const p = game.fx.fireball(opts); if (p) trackShot(p); } catch (e) { console.warn('[titan] fx.fireball failed', e); T.vfx?.fallbackShot(opts); }
      } else T.vfx?.fallbackShot(opts);
      if (o.marker) T.vfx?.marker(o.marker, o.markerTime || 3, 16);
    };
    if (o.delay) T.later(o.delay, go, 'shot'); else go();
  };
  T.meteorOrbs = (dur) => {
    for (const h of ['L', 'R']) T.chargePalm(h, dur);
    T.later(dur, () => { T.chargeStop('L'); T.chargeStop('R'); });
  };
  T.windLines = (mode, dur) => T.vfx?.windLines(mode, dur);
  T.gustStart = (c) => {
    gust = { t: 0, c };
    try {
      if (game.clouds?.addDisplacer) {
        gust.pos = T.socket('chest', V()).addScaledVector(T.forwardWorld(_a), 80);
        gust.h = game.clouds.addDisplacer({ pos: gust.pos, radius: 120, strength: 1 });
      }
    } catch { /* optional */ }
    T.vfx?.ring(T.socket('chest', V()).addScaledVector(T.forwardWorld(_a), 30), T.forwardWorld(_b), 20, 200, 1.1, 0xeaf2ff, 0.7, false);
  };
  T.gustEnd = () => { try { gust?.h?.remove?.(); } catch { /* ignore */ } gust = null; };
  T.gustPush = (dt, c) => {
    if (!gust) return;
    gust.t += dt;
    if (gust.pos) { gust.pos.addScaledVector(T.forwardWorld(_a), 260 * dt); if (gust.h?.pos && gust.h.pos !== gust.pos) gust.h.pos.copy(gust.pos); }
    const pp = T.playerPos();
    if (!pp) return;
    // the gust blows from the chest along its forward (dive under it to escape); the buffet (second pass) from the core
    // along the axis it aimed at her (c.axis, locked as it strikes; c.below: how far under it is out of it)
    const chest = c.origin === 'core' ? T.socket('core', _a) : T.socket('chest', _a);
    const d = _b.subVectors(pp, chest);
    const dist = d.length();
    if (dist > c.range || dist < 1) return;
    d.divideScalar(dist);
    const fwd = c.axis?.isVector3 ? _c.copy(c.axis) : T.forwardWorld(_c);
    const cos = d.dot(fwd);
    if (cos < Math.cos(c.halfAngle * D2R) || Math.asin(clamp(d.y, -1, 1)) < (c.below ?? -25) * D2R) return;   // dive under it to escape
    const a = c.push * Math.pow(1 - dist / c.range, 1.5);
    if (c.dragTo) {
      // the buffet (second pass): a wind that drags her outward until she moves away at ≈ dragTo m/s, for the whole
      // blow — it outlasts a dodge hop (whose sideways hold cancels a one-shot push) — at most maxDv m/s in all
      const vOut = T.playerVel(_d).dot(d), want = c.dragTo * Math.sqrt(1 - dist / c.range);
      gust.dv = gust.dv || 0;
      if (vOut < want && gust.dv < c.maxDv) {
        const dv = Math.min(want - vOut, a * dt, c.maxDv - gust.dv);
        gust.dv += dv;
        T.pushPlayer(d.clone().multiplyScalar(dv));
        if (!gust.blew) { gust.blew = true; T.blown(); }
      }
      return;
    }
    gust.dv = (gust.dv || 0) + a * dt;
    if (gust.dv < c.maxDv) { T.pushPlayer(d.clone().multiplyScalar(a * dt)); if (!gust.blew) { gust.blew = true; T.blown(); } }
  };
  // grab
  T.grabStart = (h) => {
    grab = { h, t: 0 };
    T.hitPlayer(T.dmg('grabCrush'), T.handWorld(h, V()), V(0, -1, 0), 'swat', 'hand' + h, null);
    events.emit('titan:grab', { actor: pActor(), state: 'caught', hand: h, titan: actor });
    T.roar(0.5);
  };
  T.grabHold = (h) => {
    const pp = T.playerPos();
    if (!pp || !grab) return;
    const target = T.handWorld(h, _a).addScaledVector(T.palmNormal(h, _b), 5);
    const v = T.playerVel(_c);
    const want = hand[h].vel.clone().add(target.sub(pp).multiplyScalar(6));
    T.pushPlayer(want.sub(v).multiplyScalar(Math.min(1, 14 / 120)));
  };
  T.grabThrow = (h) => {
    const s = h === 'L' ? 1 : -1;
    const dir = T.dirToWorld(V(s * 0.8, -0.35, 0.5).normalize(), V());
    const pp = T.playerPos();
    if (pp) T.hitPlayer(T.dmg('grabThrow'), pp.clone(), dir, 'swat', 'hand' + h, dir.clone().multiplyScalar(config.attacks.grab.throwSpeed));
    events.emit('titan:grab', { actor: pActor(), state: 'thrown', hand: h, titan: actor });
    grab = null;
  };
  T.grabRelease = () => { if (grab) events.emit('titan:grab', { actor: pActor(), state: 'released', hand: grab.h, titan: actor }); grab = null; };
  /** The grab's reach begins (hitbox live in ≤ 1.1 s): listeners may brace; always followed by caught or released. */
  T.grabReach = (h) => events.emit('titan:grab', { actor: pActor(), state: 'reach', hand: h, titan: actor });
  T.grabMissed = (h) => events.emit('titan:grab', { actor: pActor(), state: 'released', hand: h, missed: true, titan: actor });

  // ------------------------------------------------------------------ wave 4: dodge cue, weak points, openings
  /** The "now" cue of a melee blow (once per attack, ≈ config.dodge.cue s before contact): palm flash, a sharp
   *  crack, 'titan:strike' { attack, hand, in } and a short HUD line naming the dodge keys. */
  T.strikeCue = (a, h, tIn = config.dodge.cue) => {
    if (!a || a.cued || a.done) return;
    a.cued = true; a.cueT = game.time.now;
    T.telemetry.cues = (T.telemetry.cues || 0) + 1;
    for (const hh of h === 'both' ? ['L', 'R'] : [h]) T.vfx?.palmFlash?.(hh, 0.55);
    T.sound('titan-crack', { volume: 0.9, rate: 1.35 });
    events.emit('titan:strike', { attack: a.name, hand: h, in: tIn, actor });
    events.emit('warning', { text: tr('Now — dodge Q / E'), level: 2, duration: 1.2, source: 'titan' });
  };
  // Core window: after a volley or a missed blow the core blazes open (×weak.open.mult on top of weak.core).
  const coreWin = { until: -1, lastEnd: -99, reason: null, n: 0 };
  /** Speed factor of the player (0 hovering … 1 flying, from the stillness meter's averaged velocity). */
  // (second pass) the slower of the averaged and the instant speed — a flier who flares in front of the open core to
  // breathe it stops being paid as one at once — and a dragon marked as parked IN ITS FACE (camp.close) within the last
  // weak.open.closeMemory s counts as a hover (the verifier's breath camper: parked → blown out → flew straight back
  // into the next volley's window at the flier's ×7.5)
  const flyK = () => {
    const C = config.camp, sp = Math.min(T.camp?.speed ?? 0, T.camp?.speedNow ?? 0);
    if (game.time.now - (T.closeMarkT ?? -99) < (config.weak.open.closeMemory ?? 0)) return 0;
    return clamp((sp - C.still) / Math.max(1, C.move - C.still), 0, 1);
  };
  T.flyK = flyK;
  // the flier's extension only grows while the window is open (a closed window never reopens when she speeds up)
  const openUntil = () => coreWin.until + (coreWin.ext || 0);
  const stepOpenExt = () => { if (coreWin.until > 0 && game.time.now < openUntil()) coreWin.ext = Math.max(coreWin.ext || 0, (config.weak.open.flyExtra || 0) * flyK()); };
  T.coreOpen = () => game.time.now < openUntil();
  T.coreOpenLeft = () => Math.max(0, openUntil() - game.time.now);
  T.openCore = (reason = 'volley', dur = config.weak.open.duration) => {
    if (!T.active || !actor.alive || T.phase === 'rising' || T.phase === 'dying' || T.phase === 'dead') return false;
    const now = game.time.now;
    // a warded core does not open (the camper's volleys leave no opening); breaking the ward does (reason 'guard')
    if (reason !== 'guard' && (guardCovering() || T.campMarked())) { T.telemetry.openSuppressed = (T.telemetry.openSuppressed || 0) + 1; return false; }
    if (T.coreOpen()) { coreWin.until = Math.max(coreWin.until, now + dur * 0.6); coreWin.lastEnd = Math.max(coreWin.lastEnd, coreWin.until); return true; }
    if (reason !== 'guard' && now - coreWin.lastEnd < config.weak.open.cooldown) return false;
    coreWin.until = now + dur; coreWin.lastEnd = now + dur; coreWin.reason = reason; coreWin.n++; coreWin.ext = 0;
    T.telemetry.coreOpen = coreWin.n;
    T.vfx?.coreBlaze?.(dur + (config.weak.open.flyExtra || 0) * flyK());
    T.sound('titan-crack', { volume: 1, rate: 0.75 });
    T.sound('titan-charge', { volume: 0.7, rate: 0.6 });
    events.emit('titan:weak', { part: 'core', mult: config.weak.core * config.weak.open.mult, duration: dur, reason, actor, near: config.weak.open.near });
    const pp = T.playerPos();
    if (pp && pp.distanceTo(actor.pos) < 420) events.emit('warning', { text: reason === 'guard' ? tr('Guard broken — the core is open!') : tr('The core is open — fly in and strike!'), level: 0, duration: Math.min(2.4, dur), source: 'titan' });
    return true;
  };
  /**
   * The open core's multiplier on top of weak.core for a player `dist` m from the core with speed factor k (flyK):
   * a flier (k 1) gets the full open.mult anywhere; a hover (k 0) ×slowMult within open.near, ×farMult from open.far.
   */
  T.openMult = (dist, k = flyK()) => {
    const O = config.weak.open;
    const slow = openMultAt(dist, { ...O, mult: O.slowMult ?? O.mult });
    return slow + (O.mult - slow) * k;
  };
  const coreDist = () => { const pp = T.playerPos(); return pp ? pp.distanceTo(SH.core.a) : Infinity; };
  /** A melee pass ended without touching the player: off-balance for config.opening.duration s, core open. */
  T.onMiss = (a, h) => {
    if (!a || a.missReported) return;
    a.missReported = true;
    const now = game.time.now;
    // second pass: a SLOW dragon next to it (a hover that hopped aside) only avoided the blow — no stumble, no open
    // core, the next attack comes on the usual cadence. The opening is a flier's reward (the verifier's breath camper
    // at 45 m dodged every blow on the flash and breathed the ×5 open core after each).
    if (Math.min(flyK(), a.k0 ?? 1) < (config.weak.open.slowMissK ?? 0.5) && coreDist() < config.camp.close) {
      T.telemetry.slowMisses = (T.telemetry.slowMisses || 0) + 1;
      return;
    }
    T.openingUntil = now + config.opening.duration;
    T.openingHand = h === 'both' ? null : h;
    T.telemetry.misses = (T.telemetry.misses || 0) + 1;
    // the swing's momentum carries the body on a little (a stumble), wings flail to catch it
    const fwd = T.forwardWorld(_a);
    T.body.lunge(fwd, 10, 1.1);
    T.body.beat(1.5);
    T.openCore('miss');
    events.emit('titan:opening', { attack: a.name, hand: h, duration: config.opening.duration, actor });
  };
  /** Which hands are weak points right now: the attacking hand(s) from the windup through the strike. */
  const WEAK_STAGES = new Set(['telegraph', 'tame', 'active', 'follow', 'hold', 'throw']);
  function updateWeak() {
    const c = T.cur, W = config.weak;
    let L = false, Rr = false;
    if (c && !c.quiet && WEAK_STAGES.has(c.stage) && c.name !== 'gust' && c.name !== 'meteor') {
      if (c.hand === 'L' || c.hand === 'both') L = true;
      if (c.hand === 'R' || c.hand === 'both') Rr = true;
    }
    if (T.openingHand && game.time.now < (T.openingUntil ?? -1)) { if (T.openingHand === 'L') L = true; else Rr = true; }
    // the ward (a still target): the guarding hand's shape sits in front of the core facing the sniper's spot
    const g = T.guard, G = config.guard;
    if (g.hand) {
      const sh = SH['hand' + g.hand];
      const w = clamp(g.w, 0, 1);
      if (w > 0.001) sh.a.lerp(_wk.copy(SH.core.a).addScaledVector(g.axis, G.dist), w);
      sh.r = 8 + (G.radius - 8) * w;
      if (w > 0.5) { if (g.hand === 'L') L = false; else Rr = false; }
    }
    SH.handL.mult = L ? W.hand : config.partMult.handL;
    SH.handR.mult = Rr ? W.hand : config.partMult.handR;
    if (g.hand && g.w > 0.5) SH['hand' + g.hand].mult = G.hand;
    stepOpenExt();
    // the open bonus falls off with range; a warded core takes ×guard.core on top
    SH.core.mult = W.core * (T.coreOpen() ? T.openMult(coreDist()) : 1) * (guardCovering() ? G.core : 1);
    SH.body.mult = (config.partMult.body ?? 1) * (guardCovering() ? G.body ?? 1 : 1);
    // the blazing core is a bigger target (the blaze VFX grows with it); warded or closed it is its own size
    const rOpen = T.coreOpen() && !guardCovering() ? 7.5 + ((W.open.radius ?? 7.5) - 7.5) * flyK() : 7.5;
    SH.core.r += (rOpen - SH.core.r) * Math.min(1, 6 * (1 / 120));
    T.weakHands = { L, R: Rr };
  }
  const _wk = V();
  /** Weak points now (for the HUD): [{ part, mult, pos }]. A warded core is not shown as open. */
  T.weakPoints = () => {
    const out = [{ part: 'core', mult: SH.core.mult, pos: SH.core.a, open: T.coreOpen() && !guardCovering() }];
    for (const h of ['L', 'R']) if (T.weakHands?.[h]) out.push({ part: 'hand' + h, mult: SH['hand' + h].mult, pos: SH['hand' + h].a });
    return out;
  };

  // ------------------------------------------------------------------ 2026-09-25: a still target (camping)
  // A dragon parked in front of the titan, sniping the core, is read (titan/camp.js) and made to move: aimed volleys
  // and a faster cadence (mark), the palm ward over the core (guard), the wing-powered lunge + clap (lunge).
  T.camp = newCamp();
  T.guard = { on: false, w: 0, hand: null, axis: V(0, 0, 1), t0: -99, until: -99, warnT: -99, reason: null };
  T.lastLungeT = -99; T.lastBuffetT = -99;
  const campTel = () => (T.telemetry.camp ||= { marks: 0, guards: 0, breaks: 0, drops: 0, blocks: 0, blocked: 0, lunges: 0, aimed: 0, buffets: 0, buffetHits: 0 });
  const BOTH_HANDS = new Set(['clap', 'slam', 'meteor', 'lunge']);
  const ONE_HAND = new Set(['swat', 'grab', 'volley', 'call']);
  function guardCovering() { return !!(T.guard.on && T.guard.w > 0.5); }
  T.guardCovering = guardCovering;
  /** The player has been still in front of it for camp.mark s: aimed volleys, a faster cadence. */
  T.campMarked = () => T.camp.s >= config.camp.mark && T.camp.inZone;
  function lungeReady(now) {
    const c = T.camp, L = config.lunge;
    // still hovering right now (a dragon that has just taken off is answered by the volleys, not the lunge); inside
    // the buffet's reach the wings answer instead (the lunge would stop in breath range)
    return c.s >= config.camp.lunge && c.inZone && c.front > 0.5 && c.dist < L.reach && c.dist > config.buffet.reach && c.speedNow < config.camp.still + 4 && now - T.lastLungeT > L.every && !grab && T.playerAlive();
  }
  T.lungeReady = () => lungeReady(game.time.now);
  /** Second pass: a marked still target within buffet.reach m, in front, still hovering now → the wing buffet. */
  function buffetReady(now) {
    const c = T.camp, B = config.buffet;
    return T.campMarked() && c.dist < B.reach && c.front > Math.cos((B.halfAngle - 10) * D2R) && c.speedNow < (config.camp.closeStill ?? config.camp.still) + 4 && now - T.lastBuffetT > B.every && !grab && T.playerAlive();
  }
  T.buffetReady = () => buffetReady(game.time.now);
  function canGuard() {
    if ((T.phase !== 'fight' && T.phase !== 'enraged') || stagger || grab || !T.playerAlive()) return false;
    const c = T.cur;
    // (second pass) a two-handed attack frees the ward's hand again once it is recovering (after the lunge's clap)
    if (c && !c.done && BOTH_HANDS.has(c.name) && c.stage !== 'recover') return false;
    if (c && !c.done && T.guard.hand && c.hand === T.guard.hand) return false;
    return true;
  }
  function pickGuardHand() {
    const c = T.cur;
    if (c && !c.done && (c.hand === 'L' || c.hand === 'R')) return c.hand === 'L' ? 'R' : 'L';
    return T.playerModel(_gk).x >= 0 ? 'L' : 'R';
  }
  const _gk = V(), _cr = V(), _cv = V(), _cf = V(), _cd = V();
  function raiseGuard(dir, now) {
    const g = T.guard, G = config.guard;
    if (g.hand && g.w > 0.01 && !g.on) { /* still lowering: raise the same hand again */ } else g.hand = pickGuardHand();
    g.on = true; g.axis.copy(dir); g.t0 = now; g.reason = null; g.noReward = false;
    campTel().guards++;
    T.armWave(g.hand, 0.6, 0.9);
    T.sound('titan-crack', { volume: 0.7, rate: 0.6 });
    events.emit('titan:guard', { on: true, hand: g.hand, dir: dir.clone(), actor });
    if (now - g.warnT > G.warnEvery) { g.warnT = now; events.emit('warning', { text: tr('It wards its core — fly round it!'), level: 1, duration: 2.4, source: 'titan' }); }
  }
  /** Second pass: the titan itself threw her (a knock, the gust, the buffet, a hard bump): the ward stays up but loses its
   *  break reward — her bearing is about to change, and that is not her flying round it. */
  T.blown = () => {
    T._blownT = game.time.now;
    if (T.guard?.on) T.guard.noReward = true;      // it stays up; the bearing change that follows breaks nothing
  };
  function dropGuard(reason) {
    const g = T.guard;
    if (!g.on) return;
    g.on = false; g.reason = reason;
    if (reason !== 'broken') campTel().drops++;
    events.emit('titan:guard', { on: false, hand: g.hand, reason, actor });
  }
  function breakGuard(ang) {
    const g = T.guard, now = game.time.now;
    dropGuard('broken');
    g.until = now + config.guard.cooldown;
    campTel().breaks++;
    T.camp.s = 0; T.camp.anchored = false;
    T.glint(); T.body.beat(1.4);
    T.openCore('guard', config.guard.open);                  // caught out: the reward for flying round it
    events.emit('titan:guardbreak', { angle: ang, hand: g.hand, actor });
  }
  /** One step of the stillness meter and the ward (after the AI chose; shapes of the last step). */
  function stepCamp(dt, now) {
    const c = T.camp, g = T.guard, C = config.camp, G = config.guard;
    const pp = T.playerPos();
    const fighting = (T.phase === 'fight' || T.phase === 'enraged') && pp && T.playerAlive();
    if (!fighting) { c.s = 0; c.anchored = false; c.inZone = false; dropGuard('idle'); }
    else {
      _cr.subVectors(pp, SH.core.a);
      T.playerVel(_cv); T.forwardWorld(_cf);
      const before = c.s;
      campStep(c, _cr, _cv, _cf, dt, C);
      if (c.close && c.s >= C.mark && c.inZone) T.closeMarkT = now;                // parked in its face (flyK memory)
      if (before < C.mark && c.s >= C.mark && c.inZone) {
        campTel().marks++;
        events.emit('titan:camp', { level: 'mark', s: c.s, dist: c.dist, actor });
        if (now - (T._campWarnT ?? -99) > 25) { T._campWarnT = now; events.emit('warning', { text: tr('It reads a still target — keep moving!'), level: 1, duration: 2.2, source: 'titan' }); }
      }
      const dir = _cd.copy(_cr).normalize();
      if (g.on) {
        // (second pass: closing in no longer drops it — a hover in breath range is still sniping, the ward stays; up
        // close the palm turns with her instead of breaking — a slow circle in its face earns nothing — and a bearing
        // the titan itself changed (it threw her) drops it without the reward)
        if (c.close) { g.axis.lerp(dir, 1 - Math.exp(-dt / 0.5)).normalize(); g.noReward = true; }   // raised in its face: no break reward
        const ang = Math.acos(clamp(dir.dot(g.axis), -1, 1)) / D2R;
        if (ang > G.breakAngle && (g.noReward || now - (T._blownT ?? -99) < 3)) { dropGuard('blown'); g.until = Math.max(g.until, now + 2); }
        else if (ang > G.breakAngle) breakGuard(ang);
        else if (c.dist > C.far + 40 || (c.front < 0 && !c.close)) dropGuard('far');
        else if (!canGuard()) dropGuard('busy');
      } else if (c.s >= (c.close ? C.mark : C.guard) && c.inZone && now >= g.until && canGuard()) raiseGuard(dir, now);   // up close: at the mark
    }
    g.w = clamp(g.w + (g.on ? G.blendIn : -G.blendOut) * dt, 0, 1);
    if (!g.on && g.w <= 0) g.hand = null;
  }
  function resetCamp() {
    const c = T.camp; c.s = 0; c.anchored = false; c.inZone = false; c.ema.set(0, 0, 0);
    const g = T.guard;
    g.on = false; g.w = 0; g.hand = null; g.until = -99; g.reason = null;
    SH.handL.r = SH.handR.r = 8; SH.core.r = 7.5;
    T.lastLungeT = -99; T.lastBuffetT = -99; T.closeMarkT = -99;
  }
  /** Ward pose: the guarding hand raised in front of the core, palm (and rune) toward the sniper's spot. */
  const _gp = [V(), V(), V(), V()];
  function guardPose(w) {
    const g = T.guard, h = g.hand, s = h === 'L' ? 1 : -1, A = plan.arms[h];
    const cm = T.rig.socket('core', _gp[0]);
    const am = T.dirToModel(g.axis, _gp[1]);
    if (am.z < 0.35) { am.z = 0.35; am.normalize(); }
    // forearm raised in front of the chest (elbow low), the open palm up in front of the core facing the axis
    const want = _gp[2].copy(cm).addScaledVector(am, config.guard.dist - 4).add(_gp[3].set(s * 3, -2.5, 0));
    A.wrist.lerp(want, w);
    A.palm = (A.palm ? A.palm.clone() : V()).lerp(am, w).normalize();
    A.pole = (A.pole ? A.pole.clone() : V()).lerp(_gp[3].set(s * 0.35, -1, 0.25).normalize(), w).normalize();
    if (w > 0.5) { A.hand = 'splay'; A.gains = 'windup'; A.tremble = 0; A.amax = 0; A.wmax = 0; A.twist = 0; A.clav.fwd = 0.22 * w; A.clav.raise = 0.08 * w; }
    plan.torso.pitch += 4 * D2R * w;
  }

  // delayed callbacks in simulation time
  const timers = [];
  T.later = (s, fn, tag = null) => timers.push({ t: game.time.now + s, fn, shot: tag === 'shot' });

  // ------------------------------------------------------------------ wave 5: its fire dies with it
  // The projectiles game.fx.fireball returned for this titan (volley, meteors); at the death they are defused.
  const shots = [];
  function trackShot(p) {
    if (shots.length > 32) for (let i = shots.length - 1; i >= 0; i--) if (!shots[i]?.alive) shots.splice(i, 1);
    shots.push(p);
  }
  /**
   * The titan is down: nothing it threw may still hurt Sora (the victory cinematic). Delayed launches are dropped, every
   * live titan fireball / meteor loses its damage and splash, stops homing and bursts harmlessly in the air within
   * ≈ 0.2–0.9 s (the fire gutters out with its maker), the fallback shots fizzle, the meteor runes go out.
   * Returns the number of projectiles defused.
   */
  T.defuseShots = () => {
    let n = 0;
    for (let i = timers.length - 1; i >= 0; i--) if (timers[i].shot) timers.splice(i, 1);
    const list = new Set(shots);
    try { for (const p of game.fx?.projectiles || []) if (p?.owner === actor) list.add(p); } catch { /* optional */ }
    for (const p of list) {
      if (!p?.alive) continue;
      n++;
      p.damage = 0; p.splashDamage = 0; p.target = null; p.homing = null;
      const delay = 0.2 + 0.1 * (n - 1) + 0.25 * R();
      timers.push({ t: game.time.now + Math.min(0.9, delay), fn: () => { if (p.alive) p.detonate?.(); } });
    }
    shots.length = 0;
    n += T.vfx?.defuseShots?.() || 0;
    T.telemetry.defused = (T.telemetry.defused || 0) + n;
    return n;
  };

  // crack glow waves (charge travelling from the core to the palm)
  T.waves = { L: { t: 9, dur: 1, k: 0, on: false }, R: { t: 9, dur: 1, k: 0, on: false } };

  // ------------------------------------------------------------------ plan (key poses) — rebuilt every fixed step
  const newArmPlan = () => ({ wrist: V(), pole: V(), palm: null, flex: 0, hand: 'relaxed', clav: { raise: 0, fwd: 0 }, gains: 'idle', tremble: 0, amax: 0, wmax: 0, twist: 0 });
  const plan = {
    torso: { yaw: 0, pitch: 0, roll: 0 }, hips: { pitch: 0 }, torsoGains: 'idle',
    arms: { L: newArmPlan(), R: newArmPlan() },
    head: { look: V(), pitch: 0, roll: 0, fast: false, lookHand: null }, jaw: 0,
    wings: {}, legs: { L: {}, R: {} }, body: { freqBoost: 1 },
  };
  T.plan = plan;
  function idlePlan(t) {
    plan.torso.yaw = 0; plan.torso.pitch = 3 * D2R; plan.torso.roll = 0; plan.hips.pitch = 0; plan.torsoGains = 'idle';
    const sway = Math.sin(t * 2 * Math.PI * 0.12);
    for (const [h, s] of [['L', 1], ['R', -1]]) {
      const A = plan.arms[h];
      // floating guard: forearms forward, hands open and heavy at waist height, elbows out
      A.wrist.set(s * (27 + 1.5 * sway), 13 + 2 * sway * s, 17 + 1.2 * Math.sin(t * 0.9 + s));
      A.pole.set(s * 0.9, -0.35, -0.75).normalize();
      A.palm = A.palm || V();
      A.palm.set(-s * 0.55, -0.45, 0.35).normalize();
      A.flex = 0; A.hand = 'relaxed'; A.clav.raise = 0.02 * sway; A.clav.fwd = 0.05;
      A.gains = 'idle'; A.tremble = 0; A.amax = 0; A.wmax = 0; A.twist = 0;
    }
    const pp = T.playerPos();
    if (pp) T.toModel(pp, plan.head.look); else plan.head.look.set(0, 45, 200);
    plan.head.pitch = 0; plan.head.roll = 0; plan.head.fast = false; plan.head.lookHand = null;
    plan.jaw = 0;
    const w = plan.wings;
    w.amp = 50 * D2R; w.mid = 8 * D2R; w.fold = 0; w.sweep = 0; w.tilt = 0; w.spread = 0; w.snap = false; w.flapFold = 1;
    w.lift = w.lift || {}; w.back = w.back || {}; w.lift.L = w.lift.R = w.back.L = w.back.R = 0;
    for (const h of ['L', 'R']) { const L = plan.legs[h]; L.flex = 0; L.knee = 0; L.abd = 0; L.ankle = 0; }
    plan.body.freqBoost = 1;
    if (T.enraged) { plan.torso.pitch = 6 * D2R; for (const h of ['L', 'R']) plan.arms[h].hand = 'claw'; }
    return plan;
  }

  // ------------------------------------------------------------------ hit shapes
  const shape = (kind, part, r) => ({ kind, a: V(), b: kind === 'capsule' ? V() : undefined, r, part, mult: config.partMult[part] ?? 1 });
  const SH = {
    core: shape('sphere', 'core', 7.5), head: shape('sphere', 'head', 9.5), body: shape('capsule', 'body', 13),
    handL: shape('sphere', 'handL', 8), handR: shape('sphere', 'handR', 8),
    uaL: shape('capsule', 'armL', 5.8), faL: shape('capsule', 'armL', 4.8), uaR: shape('capsule', 'armR', 5.8), faR: shape('capsule', 'armR', 4.8),
    thL: shape('capsule', 'leg', 7), shL: shape('capsule', 'leg', 4.8), thR: shape('capsule', 'leg', 7), shR: shape('capsule', 'leg', 4.8),
  };
  // wings: feather-surface capsules measured on the mesh (rig.wingShapes, built in init); these coarse bone capsules
  // are only the fallback when that fails
  const WING_FALLBACK = {
    w1L: shape('capsule', 'wingL', 13), w2L: shape('capsule', 'wingL', 15), w3L: shape('capsule', 'wingL', 14),
    w1R: shape('capsule', 'wingR', 13), w2R: shape('capsule', 'wingR', 15), w3R: shape('capsule', 'wingR', 14),
  };
  let wingShapes = [];                  // [{ shape, ws }] once the rig exists
  actor.shapes = [...Object.values(SH), ...Object.values(WING_FALLBACK)];
  /** World-space proxies the camera keeps its lens out of: the hit shapes, feathered wings included. */
  T.cameraShapes = actor.shapes;
  function buildWingShapes() {
    const list = T.rig?.wingShapes || [];
    wingShapes = list.map((ws) => ({ ws, shape: { kind: 'capsule', a: V(), b: V(), r: ws.r, part: 'wing' + ws.side, mult: config.partMult['wing' + ws.side] ?? 0.6 } }));
    actor.shapes = [...Object.values(SH), ...(wingShapes.length ? wingShapes.map((w) => w.shape) : Object.values(WING_FALLBACK))];
    T.cameraShapes = actor.shapes;
  }
  function updateShapes() {
    const s = (name, out) => T.socket(name, out);
    s('core', SH.core.a)?.addScaledVector(T.forwardWorld(_a), 1.5);
    s('head', SH.head.a);
    T.toWorld(T.rig.J('hips').P, SH.body.a).addScaledVector(_b.set(0, 1, 0).applyQuaternion(T.root.quaternion), 4);
    s('chest', SH.body.b);
    for (const h of ['L', 'R']) {
      s('palm' + h, SH['hand' + h].a);
      s('shoulder' + h, SH['ua' + h].a); s('elbow' + h, SH['ua' + h].b);
      s('elbow' + h, SH['fa' + h].a); s('wrist' + h, SH['fa' + h].b);
      s('hip' + h, SH['th' + h].a); s('knee' + h, SH['th' + h].b);
      s('knee' + h, SH['sh' + h].a); s('foot' + h, SH['sh' + h].b);
      if (!wingShapes.length) {
        // fallback wing capsules sit behind the bones, over the feathers
        const W = WING_FALLBACK, back = _c.set(0, 0, -16).applyQuaternion(T.root.quaternion);
        s('wing1' + h, W['w1' + h].a); s('wing2' + h, W['w1' + h].b);
        s('wing2' + h, W['w2' + h].a); s('wing3' + h, W['w2' + h].b);
        s('wing3' + h, W['w3' + h].a); s('wingtip' + h, W['w3' + h].b);
        for (const k of ['w1', 'w2', 'w3']) { W[k + h].a.add(back); W[k + h].b.add(back); }
      }
    }
    for (const { ws, shape: sh } of wingShapes) {
      T.rig.wingShapePosed(ws, sh.a, sh.b);
      T.toWorld(sh.a, sh.a); T.toWorld(sh.b, sh.b);
    }
    s('chest', actor.pos);
    actor.vel.copy(T.body.vel);
    // broad-phase radius follows the wings (a spread wing reaches ≈ 110 m from the chest)
    let rMax = 60;
    for (const sh of actor.shapes) {
      const d = Math.max(actor.pos.distanceTo(sh.a), sh.b ? actor.pos.distanceTo(sh.b) : 0) + sh.r;
      if (d > rMax) rMax = d;
    }
    actor.radius = rMax + 5;
  }

  // ------------------------------------------------------------------ solid body (wave 4)
  // Surface velocity of every shape from its endpoints' motion (the swinging hand, the beating wings, the lunge).
  const shapeVel = new WeakMap();                       // shape -> { pa, pb, va, vb }
  let shapesFresh = true;                               // after a spawn / teleport: no velocity from the jump
  function trackShapeVel(dt) {
    for (const sh of actor.shapes) {
      let s = shapeVel.get(sh);
      if (!s) { s = { pa: V(), pb: V(), va: V(), vb: V() }; shapeVel.set(sh, s); shapesFresh = true; }
      if (shapesFresh || !(dt > 0)) { s.va.set(0, 0, 0); s.vb.set(0, 0, 0); }
      else {
        s.va.subVectors(sh.a, s.pa).divideScalar(dt);
        if (sh.b) s.vb.subVectors(sh.b, s.pb).divideScalar(dt); else s.vb.copy(s.va);
        if (s.va.lengthSq() > 250 * 250) s.va.set(0, 0, 0);
        if (s.vb.lengthSq() > 250 * 250) s.vb.set(0, 0, 0);
      }
      s.pa.copy(sh.a); if (sh.b) s.pb.copy(sh.b);
    }
    shapesFresh = false;
  }
  const _cp = V(), _cb = V(), _ab = V(), _ap = V(), _n = V(), _vs = V(), _rv = V(), _vt = V(), _J = V(), _at = V();
  const lastBump = new WeakMap();                       // dragon -> sim time of the last damaging bump
  const isWing = (sh) => sh.part === 'wingL' || sh.part === 'wingR';
  const liveHands = () => {
    // hands (and forearms) of a blow that is live right now: while the player dodges it they pass through
    const c = T.cur;
    if (!c || !MELEE.has(c.name) || !c.live || c.t < c.live[0] - 0.15 || c.t > c.live[1]) return null;
    return c.hand === 'both' ? 'LR' : c.hand || null;
  };
  /**
   * Push one dragon out of the titan's shapes. Returns the contact { sh, n, point, closing } or null.
   * Position is corrected on the FlightBody (its public pos), velocity only through applyImpulse.
   */
  function collideDragon(dragon, isPlayer) {
    const body = dragon?.body;
    if (!body?.pos?.isVector3 || !body.vel?.isVector3 || dragon.removed) return null;
    const C = config.collision;
    const R = C.radius * (dragon.scale || 1);
    const P = body.pos;
    if (!Number.isFinite(P.x + P.y + P.z) || P.distanceTo(actor.pos) > actor.radius + R + 8) return null;
    if (isPlayer && grab) return null;                                         // held in the fist
    let hands = isPlayer && T.playerDodging() ? liveHands() : null;
    // wave 5: the hand of a blow that just landed passes through (its knock is ramped; a push-out would double it)
    if (isPlayer && T._hitPass && game.time.now < T._hitPass.until) hands = (hands || '') + T._hitPass.hands;
    let hit = null;
    for (let it = 0; it < 3; it++) {
      let best = null, bestPen = 0, bestU = 0, bestD = 0;
      for (const sh of actor.shapes) {
        if (!sh?.a) continue;
        if (hands && (sh.part === 'handL' || sh.part === 'armL') && hands.includes('L')) continue;
        if (hands && (sh.part === 'handR' || sh.part === 'armR') && hands.includes('R')) continue;
        let u = 0;
        if (sh.kind === 'capsule' && sh.b) {
          _ab.subVectors(sh.b, sh.a);
          const L2 = _ab.lengthSq();
          u = L2 > 1e-8 ? clamp(_ap.subVectors(P, sh.a).dot(_ab) / L2, 0, 1) : 0;
          _cb.copy(sh.a).addScaledVector(_ab, u);
        } else _cb.copy(sh.a);
        const d = _cb.distanceTo(P);
        const pen = sh.r + R - d;
        if (pen > bestPen) { bestPen = pen; best = sh; bestU = u; bestD = d; _cp.copy(_cb); }
      }
      if (!best) break;
      if (bestD > 1e-3) _n.subVectors(P, _cp).divideScalar(bestD);
      else { _n.subVectors(P, actor.pos); if (_n.lengthSq() < 1e-6) _n.set(0, 1, 0); _n.normalize(); }
      P.addScaledVector(_n, bestPen + 0.02);
      if (!hit || bestPen > hit.pen) {
        hit = hit || { n: V(), point: V(), vs: V() };
        hit.sh = best; hit.pen = bestPen; hit.n.copy(_n); hit.point.copy(_cp).addScaledVector(_n, best.r);
        const s = shapeVel.get(best);
        if (s) hit.vs.copy(s.va).lerp(s.vb, bestU); else hit.vs.set(0, 0, 0);
      }
    }
    if (!hit) return null;
    // velocity: remove the closing speed relative to the moving stone (+ a little bounce), scrape a bit (friction)
    const n = hit.n, soft = isWing(hit.sh);
    _rv.subVectors(body.vel, hit.vs);
    const vn = _rv.dot(n);
    hit.closing = Math.max(0, -vn);
    if (vn < 0) {
      const e = soft ? C.wingRestitution : C.restitution;
      const own = Math.max(0, -body.vel.dot(n)) * (1 + e);                   // the dragon's own inward speed: always removed
      const dv = Math.min(-(1 + e) * vn, Math.max(own, soft ? C.wingMaxDv : C.maxDv));
      _vt.copy(_rv).addScaledVector(n, -vn);
      const vtl = _vt.length();
      const ft = vtl > 1e-3 ? Math.min(vtl, C.friction * dv) / vtl : 0;
      _J.copy(n).multiplyScalar(dv).addScaledVector(_vt, -ft);
      const m = dragon.mass || body.mass || 1100;
      _J.multiplyScalar(m);
      // off-centre contact point: a short tumble (the flight assist rights it)
      _at.copy(P).addScaledVector(n, -R).addScaledVector(_vt.lengthSq() > 1e-6 ? _vt.normalize() : _ab.set(0, 1, 0), C.tumble * (dragon.scale || 1));
      if (typeof body.applyImpulse === 'function') body.applyImpulse(_J, _at);
      else if (typeof dragon.applyImpulse === 'function') dragon.applyImpulse(_J, _at);
      else body.vel.addScaledVector(_J, 1 / m);
    }
    return hit;
  }
  /** Every dragon near the titan (the player, escorts, drakes) is kept outside its body. */
  function collideAll(dt) {
    if (!T.active || T.phase === 'dead') return;
    trackShapeVel(dt);
    const now = game.time.now;
    const p = player();
    if (p?.body) {
      const h = collideDragon(p, true);
      if (h) onPlayerContact(p, h, now);
    }
    if (!config.collision.enemies) return;
    for (const a of game.actors || []) {
      const d = a?.dragon;
      if (!d || d === p || a.kind !== 'dragon' || a === actor) continue;
      try { collideDragon(d, false); } catch { /* one bad dragon never stops the rest */ }
    }
  }
  function onPlayerContact(p, h, now) {
    const C = config.collision, a = pActor();
    T.telemetry.contacts = (T.telemetry.contacts || 0) + 1;
    const soft = isWing(h.sh);
    const cs = h.closing;
    // wave 5: a hard bump (the off-centre push-out + the new airflow) starts the spin cap window too
    if (cs >= config.knock.bumpFrom) { T._spinUntil = Math.max(T._spinUntil ?? -1, now + config.knock.spinWindow); T.blown(); }
    if (soft || cs < C.damageFrom || !a || a.alive === false) return;
    if (now - (lastBump.get(p) ?? -9) < C.cooldown) return;
    // the blow of a live strike is dealt by the attack itself (handContact); the bump never doubles it
    const live = liveHands();
    if (live && /^(hand|arm)/.test(h.sh.part) && live.includes(h.sh.part.slice(-1))) return;
    lastBump.set(p, now);
    const dmg = clamp((cs - C.damageFrom) * C.damagePerMs, 6, C.damageMax);
    let done = 0;
    // the dying / fallen titan is still solid (the push-out above) but never hurts her (the victory cinematic)
    if (!(a.invuln > 0) && game.combat && !spent()) {
      try { done = game.combat.damage(a, dmg, { source: actor, point: h.point.clone(), dir: h.n.clone(), kind: 'impact', part: 'body' }); } catch (e) { console.warn('[titan] contact damage', e); }
    }
    if (!spent()) {
      a.invuln = Math.max(a.invuln || 0, C.invuln);
      T._bumpInvulnUntil = now + C.invuln + 0.1;
    }
    const k = clamp(cs / 40, 0.25, 1.2);
    try { game.cameraRig?.kick?.(h.n, k); } catch { /* optional */ }
    T.shake(clamp(cs / 70, 0.15, 0.7), 0.4, 'hit');
    T.vfx?.debris(h.point, Math.round(3 + 5 * k), 10 + 8 * k, 0.7, 0.5);
    events.emit('titan:impact', { point: h.point.clone(), strength: 0.4 + 0.5 * k, kind: 'contact' });
    events.emit('titan:contact', { actor: a, part: h.sh.part, speed: cs, damage: done, point: h.point.clone(), normal: h.n.clone() });
  }

  // ------------------------------------------------------------------ AI: choose the next attack
  const MELEE = new Set(['swat', 'grab', 'clap', 'slam', 'lunge']);
  /**
   * Next attack by distance and bearing. Close: melee (swat / grab / clap / slam); mid and far: volleys, the gust,
   * meteors when enraged. Melee and volleys alternate where both work, and there is always a candidate while the
   * player is alive (a volley reaches wherever they are), so the titan never goes quiet.
   */
  function chooseAttack() {
    const pp = T.playerPos();
    if (!pp || !T.playerAlive()) return null;
    const pm = T.playerModel(V());
    const chestM = T.rig.socket('chest', V());
    const rel = pm.clone().sub(chestM);
    const dist = rel.length();
    const band = dist < 115 ? 'close' : dist < 330 ? 'mid' : 'far';
    const fz = rel.z / Math.max(1, Math.hypot(rel.x, rel.z));
    const front = fz > 0.25, inArc = fz > -0.35;
    // Melee only where the blow can land: the player's position ~1.3 s ahead relative to the titan's own motion,
    // measured from the nearer shoulder (arm + lunge ≈ config.swatReach). Beyond that a swat is a false alarm.
    const relV = T.playerVel(V()).sub(T.body.vel);
    const pmF = T.toModel(_d.copy(pp).addScaledVector(relV, 1.3), V());
    const shL = T.rig.socket('shoulderL', V()), shR = T.rig.socket('shoulderR', V());
    const reachNow = Math.min(pm.distanceTo(shL), pm.distanceTo(shR)), reachF = Math.min(pmF.distanceTo(shL), pmF.distanceTo(shR));
    const swatOk = reachF < config.swatReach && reachNow < config.swatReach + 45;
    const grabOk = reachF < config.grabReach && reachNow < config.grabReach + 40;
    const W = config.weights;
    // a dragon parked in front of it: in breath range and just beyond, the wing buffet blows it out of its spot; farther,
    // within reach of the wings, the lunge (titan/camp.js) — nothing else
    if (buffetReady(game.time.now)) return 'buffet';
    if (lungeReady(game.time.now)) return 'lunge';
    const marked = T.campMarked();
    const lastMelee = MELEE.has(T.history[0]), lastRanged = T.history[0] && !MELEE.has(T.history[0]);
    const cand = [];
    if (swatOk && inArc) cand.push(['swat', W.swat * (lastRanged ? 1.3 : 1)]);
    if (grabOk && fz > 0) cand.push(['grab', W.grab]);
    if (band === 'close' && front && rel.y > -20 && reachF < 80) cand.push(['clap', W.clap]);
    if (band === 'close' && rel.y < 0 && Math.hypot(rel.x, rel.z) < 75) cand.push(['slam', W.slam * (rel.y < -15 ? 1.6 : 1)]);
    if (band !== 'close' || dist > 55) cand.push(['volley', W.volley * (band === 'close' ? (lastMelee ? 1.1 : 0.35) : lastMelee ? 1.4 : 1) * (marked ? 1.5 : 1)]);
    // the gust blows a hovering dragon out of its spot (Δv ≤ 36 m/s: out of the hover)
    if (band === 'mid' && front && dist < 300) cand.push(['gust', W.gust * (T.pursuing ? 1.4 : 1) * (marked ? 1.8 : 1)]);
    if (T.enraged && band !== 'close') cand.push(['meteor', W.meteor]);
    else if (band === 'far') cand.push(['meteor', W.meteor * 0.55]);          // phase I: a lighter rain at range
    if (!cand.length) cand.push(['volley', 1]);
    let best = null, bestS = 0;
    for (const [name, w] of cand) {
      let s = w;
      if (name === T.history[0]) s *= 0.15;
      if (name === T.history[1]) s *= 0.5;
      s *= 0.85 + 0.3 * R();
      if (s > bestS) { bestS = s; best = name; }
    }
    return best;
  }

  /** Pursuit overlay: a flying titan — leaned into the glide, big slow beats, swept wings, arms trailing. */
  function pursuitPose() {
    const sp = Math.hypot(T.body.meanVel.x, T.body.meanVel.z);
    const k = clamp((sp - 6) / 26, 0, 1);
    if (k <= 0) return;
    const busy = T.cur && !T.cur.quiet && T.cur.stage !== 'recover';            // an attack owns the arms
    const w = plan.wings;
    w.amp = Math.max(w.amp, (50 + 24 * k) * D2R); w.mid = Math.max(w.mid, (8 + 12 * k) * D2R);
    w.sweep = Math.min(w.sweep || 0, -16 * k * D2R);
    plan.body.freqBoost = Math.max(plan.body.freqBoost, 1 + 0.35 * k);
    if (!busy) {
      plan.torso.pitch += 9 * k * D2R;
      for (const [h, s] of [['L', 1], ['R', -1]]) { const A = plan.arms[h]; A.wrist.set(s * 25, 5 - 5 * k, 10 - 12 * k); A.hand = 'relaxed'; }
      for (const h of ['L', 'R']) { plan.legs[h].flex = -16 * k * D2R; plan.legs[h].knee = 24 * k * D2R; }
    }
  }
  /** Off-balance after a missed blow: hunched, head down, wings flailing, the missing hand hanging open. */
  function openingPose(now) {
    const left = clamp(((T.openingUntil ?? now) - now) / config.opening.duration, 0, 1);
    const k = clamp(left * 1.8, 0, 1);
    plan.torso.pitch += 12 * k * D2R; plan.torsoGains = 'idle';
    plan.head.pitch = Math.max(plan.head.pitch, 16 * k * D2R); plan.jaw = Math.max(plan.jaw, 0.35 * k);
    plan.wings.amp = Math.max(plan.wings.amp, 70 * k * D2R); plan.wings.mid = Math.max(plan.wings.mid, 20 * k * D2R);
    plan.body.freqBoost = Math.max(plan.body.freqBoost, 1 + 0.5 * k);
    const h = T.openingHand;
    if (h && (!T.cur || T.cur.stage === 'recover')) {
      const s = h === 'L' ? 1 : -1, A = plan.arms[h];
      A.wrist.lerp(_d.set(s * 15, -8, 31), k); A.hand = 'splay'; A.gains = 'idle';
      A.palm = A.palm || V(); A.palm.set(0, 0.35, 1).normalize();
      plan.torso.roll = s * 7 * k * D2R;
    }
  }

  // ------------------------------------------------------------------ combat phase (1 / 2 / 3) and escort calls
  const balanceT = () => game.director?.balance?.titan || {};
  T.phaseThresholds = [0.7, 0.4];
  /** 1 above the escort threshold, 2 below it, 3 enraged. */
  T.combatPhase = () => (T.enraged ? 3 : actor.hp / (actor.maxHp || 1) < T.phaseThresholds[0] ? 2 : 1);
  const callState = { lastT: -1e9, calls: 0, pending: false };
  function enemyDragonsAlive() {
    try { return (game.combat?.alive?.('enemy') || game.actors || []).filter((a) => a && a !== actor && a.alive !== false && a.team === 'enemy' && a.kind !== 'titan').length; } catch { return 0; }
  }
  function wantCall(now) {
    const ph = T.combatPhase();
    if (ph < 2 || !T.playerAlive()) return false;
    const C = config.call;
    if (callState.pending) return true;
    if (now - callState.lastT < C.every) return false;
    return enemyDragonsAlive() < C.maxAlive[ph >= 3 ? 1 : 0];
  }
  T.emitCall = (point) => {
    const ph = T.combatPhase(), C = config.call;
    const count = C.count[ph >= 3 ? 1 : 0];
    callState.lastT = game.time.now; callState.calls++; callState.pending = false;
    events.emit('titan:call', { count, phase: ph, point: point?.clone?.() || actor.pos.clone(), actor, n: callState.calls });
    T.telemetry.calls = callState.calls;
  };

  function startAttack(name, opts = {}) {
    if (name === 'meteor' && !T.enraged && !opts.count) opts = { ...opts, count: [5, 7] };
    if (name === 'clapslam') {
      const pm = T.playerModel(V());
      name = pm.y < 12 ? 'slam' : 'clap';
    }
    // the ward keeps its hand: a one-handed attack uses the other one; a still target gets the aimed volley
    const g = T.guard;
    if (g.on && g.hand && ONE_HAND.has(name) && !opts.hand) opts = { ...opts, hand: g.hand === 'L' ? 'R' : 'L' };
    const marked = T.campMarked();
    if (name === 'volley' && marked && opts.aimed === undefined) opts = { ...opts, aimed: true };
    const a = createAttack(name, T, opts);
    if (!a) return null;
    if (T.cur) { T.cur.interrupt(); T.cur = null; }
    T.cur = a;
    T.attack = a.name;
    if (BOTH_HANDS.has(a.name)) dropGuard('busy');           // both hands: the ward comes down for it
    a.begin();
    T.count++;
    a.startT = game.time.now;
    a.k0 = flyK();                                  // (second pass) her speed factor as it began: slow-miss check
    T.history.unshift(a.name); T.history.length = Math.min(T.history.length, 4);
    T.telemetry.attacks[a.name] = (T.telemetry.attacks[a.name] || 0) + 1;
    if (a.name === 'lunge') { T.lastLungeT = game.time.now; campTel().lunges++; }
    if (a.name === 'buffet') { T.lastBuffetT = game.time.now; campTel().buffets++; }
    if (a.aimed) campTel().aimed++;
    // cadence: the next telegraph is due `cadence` s after this one began (sooner against a still target)
    const cd = T.enraged ? config.enragedCadence : config.cadence;
    T.lastThreatT = game.time.now;
    T.nextThreatAt = game.time.now + (cd[0] + R() * (cd[1] - cd[0])) * (a.name === 'call' || a.name === 'roar' ? 0.55 : 1) * (marked ? config.aimed.cadence : 1);
    return a;
  }

  // ------------------------------------------------------------------ phases
  function setPhase(p) {
    if (p === T.phase) return;
    const prev = T.phase;
    T.phase = p;
    events.emit('titan:phase', { phase: p, prev, actor });
  }
  T.setEnraged = (on = true) => {
    if (on === T.enraged || !T.active) return;
    T.enraged = on;
    T.tempo = on ? config.tempoEnraged : 1;
    T.body.cfg.yawRateMax = (on ? config.enragedYawRate : config.yawRate) * D2R;
    T.body.cfg.f0 = on ? 0.46 : 0.42;
    if (on && T.phase === 'fight') {
      setPhase('enraged');
      if (!T.cur || T.cur.name === 'roar') startAttack('roar');
      T.coreFlare(1.6, 3);
    } else if (!on && T.phase === 'enraged') setPhase('fight');
  };

  function onHit(rec) {
    T.flash = 1;
    const part = rec.part || rec.shape?.part;
    const weak = part === 'core' || part === 'head' || (part === 'handL' && T.weakHands?.L) || (part === 'handR' && T.weakHands?.R);
    T.poise = (T.poise || 0) + rec.amount * (weak ? 1 : 0.25);
    T.poiseT = 3;
    if (part === 'head') T.rig.head.pitch.v -= Math.min(0.5, rec.amount / 400);          // flinch
    // the ward took it (or the shot slipped past it into a warded core): chips and a flash on the stone palm
    const g = T.guard;
    if (g.hand && g.w > 0.5 && (rec.shape === SH['hand' + g.hand] || ((part === 'core' || part === 'body') && guardCovering()))) {
      const ct = campTel(); ct.blocks++; ct.blocked += rec.amount;
      if (rec.point) {
        T.vfx?.debris(rec.point, 2, 10, 0.8, 0.6);
        T.vfx?.ring(rec.point, g.axis, 2, 16, 0.35, 0xffe2a0, 0.8, true);
      }
      T.sound('titan-crack', { volume: 0.45, rate: 1.7 });
      T.vfx?.wardFlash?.(clamp(rec.amount / 30, 0.4, 1));
      events.emit('titan:blocked', { point: rec.point?.clone?.() || null, amount: rec.amount, part, kind: rec.kind, actor });
    } else if (part === 'core') T.coreFlare(0.6, 0.5);
    if (rec.amount > 60 && rec.point) T.vfx?.debris(rec.point, 3, 14, 1.2, 0.8);
    if (!T.enraged && actor.hp / actor.maxHp < config.enrageAt && actor.alive) T.setEnraged(true);
    if (T.poise > T.poiseMax && !stagger && T.phase !== 'dying' && T.phase !== 'rising') {
      T.poise = 0; T.poiseMax *= 1.25;
      stagger = { t: 0 };
      T.cur?.interrupt(); T.cur = null; T.attack = null;
      T.body.thrust = 0.45;
      T.roar(0.7);
      events.emit('titan:stagger', { actor });
    }
  }
  function onDeath() {
    T.cur?.interrupt(); T.cur = null; T.attack = null; T.attackStage = null;
    T.grabRelease();
    dropGuard('dead');
    dying = { t: 0, fell: false, exploded: false };
    setPhase('dying');
    // wave 5: its fire dies with it — no delayed launch, no live projectile may still hurt Sora; the player's own
    // i-frames API when there is one (the director also keeps her safe during 'victory')
    for (const h of ['L', 'R']) T.chargeStop(h);
    T.gustEnd();
    T.defuseShots();
    T._spinUntil = -1; T._hitPass = null;
    try { game.player?.setInvulnerable?.(config.deathSafe); } catch { /* optional */ }
    T.roar(1.2);
    T.coreFlare(2.5, 3);
    try { game.hitstop?.(0.2); } catch { /* optional */ }
  }
  actor.onHit = (rec) => { try { onHit(rec); } catch (e) { console.warn('[titan] onHit', e); } };
  actor.onDeath = () => { try { onDeath(); } catch (e) { console.warn('[titan] onDeath', e); } };

  // ------------------------------------------------------------------ spawn / despawn
  T.spawn = (arg = {}) => {
    try {
      const o = arg?.isVector3 ? { pos: arg } : (arg || {});
      const near = o.near?.isVector3 ? o.near : (T.playerPos() ? T.playerPos().clone() : null);
      let pos;
      if (o.pos?.isVector3) pos = o.pos.clone();
      else {
        const fwd = (o.forward?.isVector3 ? o.forward.clone() : V(0, 0, 1)).setY(0);
        if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1);
        fwd.normalize();
        const base = near || V(0, config.hoverAltitude, 0);
        // far enough that a cruising dragon does not arrive before the titan has emerged (~riseTime s)
        const sp = Math.hypot(T.playerVel(_a).x, _a.z);
        // an instant spawn (the director's checkpoint retry) appears in view, inside the pursuit start: no "gives chase"
        const dist = o.distance ?? (o.instant ? config.instantDistance : clamp(520 + sp * config.riseTime * 0.5, 520, 1300));
        pos = base.clone().addScaledVector(fwd, dist);
        pos.y = clamp((near ? near.y - 25 : config.hoverAltitude), 1250, 2300);
        // a rise bursts out of cloud: prefer a spot (±35°, 0.85–1.15 × the distance) where the deck is thick under
        // the titan and the air is clear where the rise cinematic's camera will be (toward the player)
        if (o.rise !== false && !o.instant && near) { const best = riseSpot(base, fwd, dist, pos.y); if (best) pos.set(best.x, pos.y, best.z); }
      }
      const B = game.director?.balance?.titan;
      actor.maxHp = B?.hp ?? config.hp; actor.hp = actor.maxHp; actor.alive = true; actor.invuln = 0;
      // checkpoint retry (director): the titan comes back at the HP fraction of the last threshold it had passed
      // (hpFrac in (0, 1); anything else = full HP). ?debug&titanHp=0.05 does the same for a quick kill in tests.
      const dbgHp = game.debugMode ? +(game.params?.get?.('titanHp') || 0) : 0;
      const frac = Number.isFinite(+o.hpFrac) && +o.hpFrac > 0 && +o.hpFrac < 1 ? +o.hpFrac : dbgHp > 0 && dbgHp < 1 ? dbgHp : 1;
      if (frac < 1) actor.hp = Math.max(1, Math.round(actor.maxHp * frac));
      T.spawnInfo = { t: game.time.now, instant: !!(o.instant || o.rise === false), hpFrac: frac, hp: actor.hp, maxHp: actor.maxHp };
      config.enrageAt = B?.enrageAt ?? config.enrageAt;
      T.enraged = false; T.tempo = 1; T.body.cfg.yawRateMax = config.yawRate * D2R; T.body.cfg.f0 = 0.42;
      T.poise = 0; T.poiseMax = config.poise; stagger = null; dying = null; grab = null;
      timers.length = 0; shots.length = 0; T._spinUntil = -1; T._hitPass = null;   // nothing from a previous life
      T.cur?.interrupt(); T.cur = null; T.attack = null; T.count = 0; T.history.length = 0; T.cooldown = 2.5;
      T.nextThreatAt = 0; callState.lastT = -1e9; callState.calls = 0; callState.pending = false;
      T.phaseThresholds = [balanceT().escortsAt ?? 0.7, B?.enrageAt ?? config.enrageAt];
      // debug: ?debug&titanPhase=2 starts in phase 2 (escort calls), =3 enraged
      const dbgPhase = game.debugMode ? +(game.params.get('titanPhase') || 0) : 0;
      if (dbgPhase >= 2) T.phaseThresholds[0] = 1.01;
      T._dbgEnrage = dbgPhase >= 3;
      const look = near ? Math.atan2(near.x - pos.x, near.z - pos.z) : 0;
      T.anchor.copy(pos);
      const instant = o.instant || o.rise === false;
      const yStart = instant ? pos.y : Math.min(config.cloudTop - config.riseDepth, pos.y - 230);
      T.body.place(V(pos.x, yStart, pos.z), look);
      T.body.baseY = yStart;
      T.root.position.copy(T.body.pos); T.root.quaternion.copy(T.body.quat); T.root.updateMatrixWorld(true);
      T.root.visible = true; T.active = true; T.visibleEyes = true;
      shapesFresh = true; coreWin.until = -1; coreWin.lastEnd = -99; coreWin.ext = 0; T.openingUntil = -1; T.openingHand = null; T.playerDodgeT = -99;
      resetCamp();
      T.pursuing = false; T._pursuitWarnT = -99;
      T.glowLevel = 0.2;
      idlePlan(0);
      if (!instant) { plan.wings.fold = 1; for (const h of ['L', 'R']) { plan.arms[h].wrist.set((h === 'L' ? 1 : -1) * 20, 4, 6); } }
      T.rig.limp = 0;
      T.rig.settle(plan, ctxFor(), 200);
      T.rig.apply();
      if (game.combat && !game.actors.includes(actor)) game.combat.register(actor);
      updateShapes();
      if (instant) {
        rising = null; T.ready = true; T.emerged = true; T.emergedAt = null; setPhase('fight');
        if (T._dbgEnrage || actor.hp / (actor.maxHp || 1) < config.enrageAt) T.setEnraged(true);
      } else {
        const y0 = T.body.pos.y;
        rising = { t: 0, dur: config.riseTime, y0, y1: pos.y, breached: false, unfurled: false, roared: false, reach: false, mist: 0 };
        const curve = riseCurve(y0, pos.y, config.cloudTop);
        T.body.rising = { t: 0, dur: config.riseTime, y0, y1: pos.y, curve };
        T.risePoint = pos.clone();
        T.body.baseY = pos.y;
        T.body.target.set(pos.x, pos.y, pos.z);
        actor.invuln = config.riseTime;
        T.ready = false; T.emerged = false;
        setPhase('rising');
        // clouds part around the torso and each wing as they come through (body-shaped, not one round hole)
        T.riseDisp = [];
        try {
          if (game.clouds?.addDisplacer) {
            for (const [sock, r] of [['chest', 58], ['wing2L', 46], ['wing2R', 46]]) {
              const p0 = T.socket(sock, V()) || T.body.pos.clone();
              T.riseDisp.push({ sock, h: game.clouds.addDisplacer({ pos: p0, radius: r, strength: 0 }), r });
            }
          }
        } catch { /* optional */ }
        if (!game.director) { try { game.cameraRig?.playCinematic?.('titan-rise'); } catch { /* optional */ } }
        T.shake(0.3, 3);
        T.sound('rumble', { volume: 1 });
      }
      events.emit('titan:spawn', { actor, rise: !instant });
      return actor;
    } catch (e) {
      console.error('[titan] spawn failed', e);
      return null;
    }
  };
  T.despawn = () => {
    T.cur?.interrupt(); T.cur = null; T.attack = null;
    for (const h of ['L', 'R']) T.chargeStop(h);
    T.gustEnd(); T.grabRelease();
    try { T.displacer?.remove?.(); } catch { /* ignore */ }
    T.displacer = null;
    removeRiseDisp();
    if (game.combat && game.actors.includes(actor)) game.combat.unregister(actor);
    T.active = false; T.ready = false; T.emerged = false; T.root.visible = false; T.pursuing = false;
    rising = null; dying = null; stagger = null;
    timers.length = 0; shots.length = 0; T._spinUntil = -1; T._hitPass = null;
    resetCamp();
    setPhase('dormant');
  };
  T.reset = T.despawn;
  T.kill = () => { if (actor.alive && game.combat) game.combat.damage(actor, actor.hp + 1, { kind: 'crash', part: 'core' }); };
  T.debugAttack = (n, opts = {}) => {
    if (!T.active) T.spawn({ instant: true });
    if (T.phase === 'rising' || T.phase === 'dying' || T.phase === 'dead') return null;
    const name = typeof n === 'number' || /^\d$/.test(String(n)) ? DEBUG_KEYS[+n] : n;
    if (!name) return null;
    if (name === 'meteor' && !T.enraged) T.setEnraged(true);
    stagger = null; T.body.thrust = 1;
    return startAttack(name, opts)?.name || null;
  };

  // ------------------------------------------------------------------ wind field (flight env gusts, VFX)
  /** Wind velocity (m/s, world) the titan causes at pos: downwash under the wings, beat rings, the gust cone. */
  T.windAt = (pos, out = V()) => {
    out.set(0, 0, 0);
    if (!T.active || T.phase === 'dead') return out;
    const c = T.body.pos;
    const dx = pos.x - c.x, dz = pos.z - c.z, dy = pos.y - (c.y + 30);
    const r2 = dx * dx + dz * dz;
    const dw = config.downwash;
    if (dy < 20 && dy > -dw.depth - 200 && r2 < 4 * dw.radius * dw.radius) {
      const pulse = 0.55 + 0.45 * clamp(T.body.T, 0, 3);
      const fall = Math.exp(-r2 / (dw.radius * dw.radius)) * clamp(1 + dy / (dw.depth + 200), 0, 1);
      out.y -= dw.speed * pulse * fall * T.body.thrust;
      const r = Math.sqrt(r2) + 1e-3;
      out.x += (dx / r) * dw.speed * 0.3 * fall; out.z += (dz / r) * dw.speed * 0.3 * fall;
    }
    // expanding ring from the last downstroke (45 m/s)
    const age = game.time.now - lastWingbeat;
    if (age < 3) {
      const rr = Math.sqrt(r2 + dy * dy), front = 45 * age + 60;
      const k = Math.exp(-((rr - front) ** 2) / (30 * 30)) * (1 - age / 3) * 8;
      if (rr > 1) { out.x += (dx / rr) * k; out.y += (dy / rr) * k; out.z += (dz / rr) * k; }
    }
    if (gust) {
      const chest = T.socket('chest', _a), f = T.forwardWorld(_b);
      const d = _c.subVectors(pos, chest); const dist = d.length();
      if (dist < gust.c.range && dist > 1 && d.dot(f) / dist > Math.cos(gust.c.halfAngle * D2R)) out.addScaledVector(d.divideScalar(dist), 48 * Math.pow(1 - dist / gust.c.range, 2));
    }
    return out;
  };

  // ------------------------------------------------------------------ per-step context for the rig
  const ctx = { phase: 0, T: 1, accel: V(), gravity: V(), time: 0, downwash: 0 };
  function ctxFor() {
    ctx.phase = T.body.phase; ctx.T = T.body.T; ctx.time = game.time.now;
    const inv = _q.copy(T.root.quaternion).invert();
    ctx.accel.copy(T.body.accel).applyQuaternion(inv).multiplyScalar(0.9);
    ctx.gravity.set(0, -9.81, 0).applyQuaternion(inv);
    ctx.downwash = Math.max(0, T.body.T - 1);
    return ctx;
  }

  // ------------------------------------------------------------------ main steps
  function fixedStep(dt) {
    const now = game.time.now;
    try { capPlayerSpin(now); } catch (e) { if (!T._capErr) { T._capErr = true; console.warn('[titan] spin cap', e); } }
    for (let i = timers.length - 1; i >= 0; i--) if (now >= timers[i].t) { const f = timers[i].fn; timers.splice(i, 1); try { f(); } catch (e) { console.warn('[titan] timer', e); } }
    idlePlan(now);
    const pp = T.playerPos();
    // the player's dodge starts (FlightBody state.dodging, else the i-frames jumping up): the melee dodge grace
    {
      const dg = playerBody()?.state?.dodging || 0, inv = pActor()?.invuln || 0;
      const started = dg ? !T._dgPrev : (inv > 0.3 && (T._invPrev ?? 0) < 0.05 && !(now < (T._bumpInvulnUntil ?? -1)));
      if (started) T.playerDodgeT = now;
      T._dgPrev = !!dg; T._invPrev = inv;
    }

    // --- phase logic ---
    if (rising) stepRise(dt);
    if (dying) stepDeath(dt);
    if (stagger) {
      stagger.t += dt;
      T.rig.limp = 0.35 * Math.sin(Math.PI * clamp(stagger.t / config.staggerTime, 0, 1));
      plan.head.pitch = -18 * D2R; plan.jaw = 0.6; plan.torso.pitch = -10 * D2R;
      for (const h of ['L', 'R']) { plan.arms[h].hand = 'claw'; plan.arms[h].wrist.y += 12; plan.arms[h].wrist.x *= 1.3; }
      plan.wings.amp = 75 * D2R; plan.wings.mid = 20 * D2R;
      T.body.freqBoost = 1.6;
      if (stagger.t > 1.2) T.body.thrust = Math.min(1, T.body.thrust + dt * 0.8);
      if (stagger.t > config.staggerTime) { stagger = null; T.rig.limp = 0; T.body.thrust = 1; T.body.freqBoost = 1; T.cooldown = 1.5; }
    }

    // --- AI: an attack or telegraph every cadence interval, never going quiet ---
    try { stepCamp(dt, now); } catch (e) { if (!T._campErr) { T._campErr = true; console.warn('[titan] camp', e); } }
    if ((T.phase === 'fight' || T.phase === 'enraged') && !stagger) {
      if (T.combatPhase() >= 2 && !callState.calls && !callState.pending) callState.pending = true;   // entering phase 2
      const lunge = (lungeReady(now) || buffetReady(now)) && T.autoAttack !== false;
      if (T.cur) {
        T.cur.plan(plan, dt);
        T.cur.tick?.(dt);
        T.cur.advance(dt);
        T.attackStage = T.cur.stage;
        // cut a long recover short when the next threat is due (the punish window stays ≥ minRecover) — or when a
        // still target is in reach of the lunge
        const offBalance = now < (T.openingUntil ?? -1);
        if (!T.cur.done && T.cur.stage === 'recover' && T.cur.local >= config.minRecover && (now >= (T.nextThreatAt ?? 0) || lunge) && !offBalance && T.autoAttack !== false && pp) {
          T.cur.done = true;
        }
        if (T.cur.done) {
          T.cur.cleanup?.();
          T.cur = null; T.attack = null; T.attackStage = null;
          T.cooldown = lunge && !offBalance ? 0.35 : Math.max(0.35, (T.nextThreatAt ?? now) - now, (T.openingUntil ?? now) - now);
        }
      } else {
        if (lunge && T.cooldown > 0.5 && !(now < (T.openingUntil ?? -1))) T.cooldown = 0.5;
        T.cooldown -= dt;
        if (T.cooldown <= 0 && pp && T.autoAttack !== false) {
          const every = config.breatherEvery ? config.breatherEvery + (T.enraged ? 1 : 0) : 0;
          let name = null;
          if (wantCall(now)) name = 'call';
          else if (every && T.count > 0 && T.count % every === 0 && T.history[0] !== 'roar') name = 'roar';
          else name = chooseAttack();
          if (name) startAttack(name); else T.cooldown = 0.5;
        }
      }
      // hover positioning: hold the player at the standoff distance, leashed to the arena anchor — or, when the
      // player flies off, glide after them (pursuit): the anchor travels with the titan, so the fight goes along
      if (pp && !T.cur?.hitDone) {
        const s = config.standoff, Pu = config.pursuit;
        _a.subVectors(pp, T.body.mean).setY(0);
        const d = _a.length() || 1;
        const was = !!T.pursuing;
        if (!T.pursuing && d > Pu.start) T.pursuing = true;
        else if (T.pursuing && d < Pu.stop) T.pursuing = false;
        if (T.pursuing !== was) {
          events.emit('titan:pursuit', { on: T.pursuing, distance: d, actor });
          if (T.pursuing && now - (T._pursuitWarnT ?? -99) > Pu.warnEvery) {
            T._pursuitWarnT = now;
            events.emit('warning', { text: tr('The Cloud Titan gives chase'), level: 1, duration: 2, source: 'titan' });
            T.roar(0.6);
          }
        }
        const bc = T.body.cfg;
        if (T.pursuing) {
          // aim at where the player will be, the ideal standoff short of it; heavy beats, long leaned glide
          const pv = T.playerVel(_c).setY(0);
          _b.copy(pp).addScaledVector(pv, 2.5).sub(T.body.mean).setY(0);
          const dp = _b.length() || 1;
          if (!T.cur || !MELEE.has(T.cur.name)) T.body.target.copy(T.body.mean).addScaledVector(_b.divideScalar(dp), dp - s.ideal);
          bc.leanMax = dampTo(bc.leanMax, Pu.lean * D2R, 1.5, dt); bc.drag = Pu.drag; bc.xzKd = Pu.kd;
          T.anchor.copy(T.body.mean);
        } else {
          let want = d > s.max ? d - s.ideal : d < s.min ? d - s.min : 0;
          // a still target beyond the lunge's reach: it comes for them (the lunge follows once they are in reach)
          const reachIn = config.lunge.reach - 60;
          if (T.campMarked() && d > reachIn) want = Math.max(want, d - reachIn);
          if (!T.cur) T.body.target.copy(T.body.mean).addScaledVector(_a.divideScalar(d), want * 0.5);
          bc.leanMax = dampTo(bc.leanMax, 20 * D2R, 1, dt); bc.drag = dampTo(bc.drag, 0.011, 1, dt); bc.xzKd = dampTo(bc.xzKd, 0.42, 1, dt);
          const off = _b.subVectors(T.body.target, T.anchor).setY(0);
          if (off.length() > s.leash) T.body.target.sub(off.setLength(off.length() - s.leash));
        }
        const deck = config.cloudTop;
        T.body.baseY = clamp(pp.y - 32, Math.max(T.anchor.y - 180, deck - 10), Math.min(T.anchor.y + 320, 3600));
        if (T.pursuing) T.anchor.y = clamp(T.body.baseY, deck + 60, 3400);
        T.body.yawTarget = Math.atan2(pp.x - T.body.pos.x, pp.z - T.body.pos.z);
      }
      if (T.pursuing) pursuitPose();
      if (now < (T.openingUntil ?? -1)) openingPose(now);
    }
    if (T.guard.hand && T.guard.w > 0.01 && T.phase !== 'dying' && T.phase !== 'dead') guardPose(smooth01(T.guard.w));
    if (plan.head.lookHand) T.rig.socket('palm' + plan.head.lookHand, plan.head.look);
    if (typeof T.debugPose === 'function') { try { T.debugPose(plan, T); } catch { /* debug only */ } }

    // --- body ---
    T.body.freqBoost = stagger ? T.body.freqBoost : plan.body.freqBoost;
    T.body.step(dt);
    T.root.position.copy(T.body.pos);
    T.root.quaternion.copy(T.body.quat);
    T.root.updateMatrixWorld(true);
    if (T.body.events.downStart) {
      lastWingbeat = now;
      events.emit('wingbeat', { actor, strength: T.body.events.strength * (T.cur?.name === 'gust' || T.cur?.name === 'buffet' ? 2 : 1), titan: true });
    }
    if (T.body.events.downEnd && T.vfx && T.phase !== 'dying') {
      // the downwash stirs the cloud under it and each downstroke tears a wisp off the cloud a primary touches —
      // only where there is cloud (in clear air these puffs read as cotton balls floating over the valley)
      const dens = game.world?.cloudDensity;
      const cloudy = (p) => { try { return typeof dens === 'function' && (dens(p.x, p.y, p.z) || 0) > 0.06; } catch { return false; } };
      const below = T.socket('hipL', _a);
      if (below && cloudy(below.add(_d.set(0, -60, 0)))) T.vfx.dust(below, 1, 30, 20);
      for (const w of ['wingtipL', 'wingtipR']) {
        const p = T.socket(w, _b);
        if (p && p.y - config.cloudTop < 220 && (cloudy(p) || cloudy(_c.copy(p).add(_d.set(0, -25, 0))))) T.vfx.mistBurst?.(p.clone(), 2, 13, 0.35);
      }
    }

    // --- rig ---
    T.rig.step(plan, ctxFor());
    updateShapes();
    for (const h of ['L', 'R']) {
      const H = hand[h];
      T.handWorld(h, H.pos);
      H.vel.subVectors(H.pos, H.prev).divideScalar(dt);
      if (H.vel.length() > 400) H.vel.set(0, 0, 0);          // teleports (spawn)
      H.prev.copy(H.pos);
      T.handSpeed[h] = H.vel.length();
      T.handRelSpeed = T.handRelSpeed || { L: 0, R: 0 };
      T.handRelSpeed[h] = _d.subVectors(H.vel, T.body.vel).length();   // swing speed, not the body's own motion
      if (T.charge[h]) T.charge[h].t += dt;
    }
    // --- wave 4: weak points follow the attack, dragons cannot enter the body ---
    updateWeak();
    try { collideAll(dt); } catch (e) { if (!T._colErr) { T._colErr = true; console.warn('[titan] collision', e); } }

    // --- wind on the player (downwash under the wings) ---
    if (config.applyWindForces && pp && T.phase !== 'dead') {
      T.windAt(pp, _c);
      const b = playerBody();
      if (_c.lengthSq() > 0.5 && typeof b?.applyForce === 'function') {
        // aerodynamic push ∝ relative air (drag area ~ 25 m² for a dragon)
        b.applyForce(_d.copy(_c).multiplyScalar(0.5 * 1.1 * 25 * _c.length()), null);
      }
    }
    if (T.poiseT > 0) { T.poiseT -= dt; if (T.poiseT <= 0) T.poise = 0; }
  }

  /** Where to rise: thick deck under the titan, clear air where the rise camera will be (toward the player). */
  function riseSpot(base, fwd, dist, hoverY) {
    const dens = game.world?.cloudDensity;
    if (typeof dens !== 'function') return null;
    const deck = config.cloudTop;
    let best = null, bestS = -1e9;
    for (const ang of [0, -17, 17, -34, 34]) {
      for (const k of [1, 0.85, 1.15]) {
        const dir = _a.copy(fwd).applyAxisAngle(_b.set(0, 1, 0), ang * D2R);
        const x = base.x + dir.x * dist * k, z = base.z + dir.z * dist * k;
        let under = 0;
        for (const dy of [-30, -70, -120]) under += dens(x, deck + dy, z) || 0;
        // the rise camera sits ≈ 190 m toward the player and 45 m under the core (camera owner's 'titan-rise')
        const cx = x - dir.x * 190, cz = z - dir.z * 190;
        let cam = 0;
        for (const cy of [deck - 20, deck + 30, hoverY - 30]) cam += dens(cx, cy, cz) || 0;
        const sc = under / 3 - 0.8 * cam / 3 - Math.abs(ang) * 0.004 - Math.abs(k - 1) * 0.3;
        if (sc > bestS) { bestS = sc; best = V(x, 0, z); }
      }
    }
    T.telemetry.riseSpot = { score: +bestS.toFixed(2) };
    return best;
  }
  function removeRiseDisp() {
    for (const d of T.riseDisp || []) { try { d.h?.remove?.(); } catch { /* ignore */ } }
    T.riseDisp = [];
  }

  function stepRise(dt) {
    rising.t += dt;
    const u = rising.t / rising.dur;
    const deck = config.cloudTop;
    const U = { unfurl: 0.42, headUp: 0.52, roar: 0.66, settle: 0.8 };
    // wings folded tight while breaching, then they snap open (kime) with one huge downstroke
    plan.wings.fold = u < U.unfurl ? 1 : 0;
    plan.wings.snap = u >= U.unfurl && u < U.unfurl + 0.1;
    plan.wings.amp = u < U.unfurl ? 8 * D2R : (u < U.settle ? 66 : 56) * D2R;
    plan.wings.mid = u < U.unfurl ? 0 : 16 * D2R;
    plan.body.freqBoost = u < U.unfurl ? 1 : 0.8;                 // big slow beats: heavy
    // asymmetry: the right hand punches up through the cloud first, the left fist stays at the heart
    for (const [h, s] of [['L', 1], ['R', -1]]) {
      const A = plan.arms[h];
      A.palm = A.palm || V();
      if (u < 0.12) { A.wrist.set(s * 14, 6, 14); A.hand = 'fist'; A.palm.set(-s, 0, 0); A.gains = 'windup'; }
      else if (u < U.unfurl) {
        if (h === 'R') { A.wrist.set(-18, 52, 18); A.hand = 'splay'; A.palm.set(0.2, 1, 0.2).normalize(); A.gains = 'windup'; A.clav.raise = 0.35; }
        else { A.wrist.set(12, 10, 16); A.hand = 'fist'; A.palm.set(-1, 0, 0.2).normalize(); A.gains = 'windup'; }
      } else if (u < U.settle) {
        // spread: the right arm still higher than the left, hands open to the sky
        const y = h === 'R' ? 30 : 16;
        A.wrist.set(s * (h === 'R' ? 40 : 44), y, h === 'R' ? 10 : 16); A.hand = h === 'R' ? 'splay' : 'claw';
        A.palm.set(0, h === 'R' ? 0.3 : -0.2, 1).normalize(); A.gains = 'windup';
      }
    }
    // the head comes up last: bowed while breaching, lifting after the unfurl, thrown back for the roar
    const hp = u < U.headUp ? 24 : u < U.roar ? 24 - 34 * smooth01((u - U.headUp) / (U.roar - U.headUp)) : u < U.settle ? -30 : -6;
    plan.head.pitch = hp * D2R;
    plan.head.roll = (u < U.unfurl ? -6 : 0) * D2R;
    plan.jaw = u >= U.roar && u < U.settle ? 1 : 0;
    plan.torso.pitch = (u < U.unfurl ? 14 : u < U.roar ? 2 : -9) * D2R;
    plan.torso.yaw = (u < U.unfurl ? -9 : u < U.roar ? 5 : 0) * D2R;
    plan.torso.roll = (u < U.unfurl ? 5 : 0) * D2R;
    for (const h of ['L', 'R']) { plan.legs[h].flex = (u < 0.5 ? -12 : -4) * D2R; plan.legs[h].knee = (u < 0.5 ? 26 : 12) * D2R; plan.legs[h].ankle = 14 * D2R; }
    // clouds part around the rising torso and wings, and heal once the part is well above the deck
    for (const d of T.riseDisp || []) {
      const p = T.socket(d.sock, _a);
      if (!p || !d.h) continue;
      if (d.h.pos?.isVector3) d.h.pos.copy(p);
      const inDeck = clamp(1 - (p.y - (deck + 40)) / 90, 0, 1) * clamp((p.y - (deck - 260)) / 80, 0, 1);
      d.h.strength = inDeck; d.h.radius = d.r * (0.8 + 0.4 * inDeck);
    }
    const headY = T.socket('head', _b)?.y ?? T.body.pos.y + 45;
    if (!rising.breached && headY > deck - 8) {
      rising.breached = true;
      try { game.clouds?.punch?.(V(T.body.pos.x, deck, T.body.pos.z), 95, 9, 1); } catch { /* optional */ }
      T.vfx?.ring(V(T.body.pos.x, deck + 6, T.body.pos.z), V(0, 1, 0), 30, 230, 3.2, 0xffffff, 0.45);
      T.vfx?.mistBurst?.(T.socket('head', V()), 16, 36, 1.0);
      T.shake(0.5, 2.6);
      events.emit('titan:breach', { actor });
    }
    // mist streaming off everything that is coming through the cloud top
    T.vfx?.riseMist?.(dt, T, deck, u);
    if (!rising.unfurled && u >= U.unfurl) {
      rising.unfurled = true; T.glint();
      T.vfx?.ring(T.socket('chest', V()), V(0, 0, 1), 16, 150, 1.3, 0xfff4e0, 0.5, true);
      for (const w of ['wing2L', 'wing3L', 'wing2R', 'wing3R', 'wingtipL', 'wingtipR']) T.vfx?.mistBurst?.(T.socket(w, V()), 5, 30, 0.8);
      T.body.beat(1.8); T.shake(0.55, 1.6);
      try { game.hitstop?.(0.06); } catch { /* optional */ }
    }
    if (!rising.roared && u >= U.roar) { rising.roared = true; T.roar(1.35); T.shake(0.95, 2.8, 'titan'); T.coreFlare(1.8, 2.4); T.vfx?.ring(T.socket('head', V()), V(0, 0, 1), 10, 110, 1.6, 0xfff0d8, 0.45, true); }
    if (u >= 1) {
      rising = null;
      try { T.displacer?.remove?.(); } catch { /* ignore */ }
      T.displacer = null;
      removeRiseDisp();                                   // (no round hole left under it: the parts' holes already healed)
      T.ready = true; T.emerged = true; T.emergedAt = game.time.now;
      actor.invuln = 0;
      setPhase('fight');
      if (T._dbgEnrage || actor.hp / (actor.maxHp || 1) < config.enrageAt) T.setEnraged(true);
      T.cooldown = 2.0;
      events.emit('titan:emerged', { actor });
    }
  }

  function stepDeath(dt) {
    dying.t += dt;
    const t = dying.t;
    // 0–2.6 s: cracks overload, convulsion; then limp, pieces break off, it falls into the cloud sea
    T.overload = clamp(t / 2.4, 0, 1);
    plan.head.pitch = -32 * D2R; plan.jaw = 1; plan.torso.pitch = -14 * D2R;
    for (const [h, s] of [['L', 1], ['R', -1]]) { const A = plan.arms[h]; A.wrist.set(s * 44, 30 + 6 * Math.sin(t * 7 + s), 6); A.hand = 'claw'; A.tremble = 1; }
    plan.wings.mid = 35 * D2R; plan.wings.amp = 20 * D2R; plan.wings.spread = 1;
    if (t < 2.6) {
      if (Math.random() < dt * 6) T.vfx?.debris(T.socket(['core', 'shoulderL', 'shoulderR', 'head', 'elbowL', 'elbowR'][Math.floor(Math.random() * 6)], V()), 3, 18, 1.4);
      if (Math.random() < dt * 3) T.shake(0.3, 0.5);
    } else if (!dying.fell) {
      dying.fell = true;
      T.rig.limp = 1;
      T.body.falling = true; T.body.thrust = 0;
      T.body.meanVel.y = Math.max(T.body.meanVel.y, 6);
      for (const n of ['core', 'shoulderL', 'shoulderR', 'head', 'wing2L', 'wing2R', 'elbowL', 'elbowR', 'knee' + 'L']) T.vfx?.debris(T.socket(n, V()), 8, 34, 3.2, 1.2);
      T.vfx?.ring(T.socket('core', V()), V(0, 0, 1), 10, 260, 1.4, 0xffe0a0, 1, true);
      try { game.fx?.explosion?.(T.socket('core', V()), { radius: 40, kind: 'titan' }); } catch { /* optional */ }
      T.shake(0.9, 2);
      try { game.hitstop?.(0.15); } catch { /* optional */ }
    }
    if (dying.fell) {
      plan.wings.fold = -0.1; plan.wings.mid = 55 * D2R; plan.wings.amp = 0;
      T.body.falling = true;
      T.body.meanVel.y -= dt * 4;                                         // falls faster than a glide
      const chest = T.socket('chest', _a);
      if (!dying.exploded && chest && (chest.y < config.cloudTop + 20 || t > 11)) {
        dying.exploded = true;
        const p = chest.clone();
        try { game.fx?.explosion?.(p, { radius: 170, kind: 'titan', surface: 'air' }); } catch { /* optional */ }
        try { game.clouds?.punch?.(V(p.x, config.cloudTop, p.z), 420, 12, 1); } catch { /* optional */ }
        try { game.clouds?.addDisplacer && (dying.disp = game.clouds.addDisplacer({ pos: V(p.x, config.cloudTop, p.z), radius: 380, strength: 1 })); } catch { /* optional */ }
        T.vfx?.ring(V(p.x, config.cloudTop + 5, p.z), V(0, 1, 0), 60, 900, 3.5, 0xfff2dc, 0.9);
        T.vfx?.ring(p, V(0, 0, 1), 30, 500, 1.6, 0xffc070, 1, true);
        T.shake(1.0, 3);
        events.emit('titan:fallen', { actor, point: p });
        events.emit('explosion', { point: p, radius: 170, kind: 'titan' });
        T.sound('titan-fall', { volume: 1 });
      }
      if (dying.exploded && t > 16) {
        try { dying.disp?.remove?.(); } catch { /* ignore */ }
        T.active = false; T.root.visible = false; T.visibleEyes = false;
        if (game.combat && game.actors.includes(actor)) game.combat.unregister(actor);
        setPhase('dead');
        dying = null;
      }
    }
  }

  // ------------------------------------------------------------------ system hooks
  const sys = Object.assign(T, {
    async init() {
      const force = game.params.get('titanModel');
      let model = force === 'procedural' ? null : await loadTitanGLB(game);
      if (!model) model = buildProceduralTitan(game);
      T.model = model;
      T.root.add(model.root);
      game.scene.add(T.root);
      T.rig = new TitanRig(model);
      buildWingShapes();
      T.vfx = new TitanVFX(game, T);
      // palm anchors (Object3D) for game.fx.charge
      T.palmObj = {};
      for (const h of ['L', 'R']) {
        const o = new THREE.Object3D(); o.name = 'titan-palm-' + h;
        game.scene.add(o); T.palmObj[h] = o;
      }
      T.poiseMax = config.poise;
      idlePlan(0);
      T.rig.settle(plan, ctxFor(), 60);
      T.rig.apply();
      if (game.debugMode) window.__titan = T;
    },
    fixedUpdate(dt) {
      if (!T.active || !T.rig) return;
      try { fixedStep(dt); } catch (e) {
        if (!T._err) { console.error('[titan] step failed', e); T._err = true; }
      }
    },
    update(dt, realDt) {
      if (!T.rig) return;
      try {
        if (!T.active) return;
        T.rig.apply();
        for (const h of ['L', 'R']) { const p = T.socket('palm' + h, T.palmObj[h].position); if (p) T.palmObj[h].position.addScaledVector(T.palmNormal(h, _a), 5); }
        // crack glow: breathing baseline, enraged blaze, charge waves, hit flash, death overload
        const U = T.model.glow.uniforms;
        U.uTime.value = game.time.now;
        T.glowLevel = dampTo(T.glowLevel, (T.enraged ? 1 : 0.25) + (T.cur?.stage === 'tame' ? 0.35 : 0) + (T.coreOpen() ? 0.8 : 0), 3, dt);
        const over = T.overload || 0;
        U.uCrack.value = (0.9 + 1.3 * T.glowLevel) * (1 + 4 * over * (0.7 + 0.3 * Math.sin(game.time.now * 40)));
        U.uCore.value = 2.6 + 2.5 * T.glowLevel + 3 * (T.vfx?.coreFlareLevel || 0) + 6 * over;
        U.uEye.value = T.visibleEyes ? (T.blink ? 0.4 : 4 + 2 * T.glowLevel) : 0;
        T.flash = Math.max(0, (T.flash || 0) - dt * 8);
        U.uFlash.value = T.flash * 0.6;
        for (const h of ['L', 'R']) {
          const w = T.waves[h], u = h === 'L' ? U.uWaveL : U.uWaveR;
          w.t += dt;
          const k = clamp(w.t / w.dur, 0, 1);
          if (w.on && w.t < w.dur + 1.6) u.value.set(15 + 55 * k, 7, w.k * clamp(1 - (w.t - w.dur) / 1.6, 0, 1), w.k * (1 - 0.5 * k));
          else { u.value.set(-100, 7, 0, 0); w.on = false; }
        }
        // blink: fast, never scaled with the body (anime giants stay alive in the eyes)
        T.blinkT = (T.blinkT ?? 3) - dt;
        if (T.blinkT < 0) { T.blink = T.blinkT > -0.12; if (T.blinkT < -0.12) T.blinkT = 3 + Math.random() * 4; }
        const sm = T.model.materials?.stone?.userData?.toon;
        if (sm?.hitFlash) sm.hitFlash.value = T.flash * 0.25;
        if (!T.model.procedural) {
          // GLB: its cracks are baked into the emissive map — breathe, blaze when enraged, overload on death
          const breath = 0.85 + 0.15 * Math.sin(game.time.now * 0.75);
          const e = (0.6 + 4.0 * T.glowLevel) * breath + 1.5 * (T.vfx?.coreFlareLevel || 0) + 2.2 * (T.vfx?.blazeLevel || 0) * (0.8 + 0.2 * Math.sin(game.time.now * 14)) + T.flash * 1.5 + 7 * over * (0.7 + 0.3 * Math.sin(game.time.now * 40));
          for (const m of T.model.meshes.all || []) if (m.material?.emissiveMap) m.material.emissiveIntensity = e;
        }
        T.vfx.update(dt, realDt, T);
      } catch (e) {
        if (!T._uerr) { console.error('[titan] update failed', e); T._uerr = true; }
      }
    },
  });
  const dampTo = (cur, target, k, dt) => cur + (target - cur) * damp(k, dt);
  return sys;
}
