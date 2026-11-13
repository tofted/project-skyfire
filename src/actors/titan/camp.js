// The titan reads a still target (2026-09-25, playtest: "hover 180–220 m in front of the chest and snipe the core").
// A pure meter, shared with the node tests: how long the player has been parked by the titan, sniping or breathing.
//   s (seconds of stillness) builds while the player's averaged velocity is slow (a hover, strafes back and forth
//   average out) inside the zone — up to `far` m from the core, in front of the titan; within `close` m every bearing
//   counts and it builds `closeBuild` × faster — and drains once they move.
//   The anchor is the direction core → player when the stillness began: moving it by more than `anchor`° (flying
//   round the titan, climbing over it) starts the count again.
// Second pass (the adversarial verifier: "camping moved in close"): the meter used to stop at 60 m (breath range was
// left to the melee), so a hover parked 25–70 m in front of the core, breathing it and dodging on the "now" flash, won
// in 45–79 s. Now breath range is the closest, fastest-read part of the zone (near = 0).
// The titan answers by level (titan.js): s ≥ mark → aimed, faster volleys, a quicker cadence, no core openings — and
// within buffet.reach the wing buffet that blows the hover out of its spot; s ≥ guard → the palm ward over the core;
// s ≥ lunge within lunge.reach (beyond the buffet's) → the wing-powered lunge with a clap.
import * as THREE from 'three';

const D2R = Math.PI / 180;

export const CAMP = {
  still: 8, move: 16,           // m/s of the averaged velocity: below `still` builds, above `move` drains
  ema: 1.2,                     // s: velocity averaging (a hover strafing back and forth reads as parked)
  near: 0,                      // m: closer does not count (second pass: 60 → 0 — breath range counts, see above)
  close: 110,                   // m: inside, every bearing counts (the hands reach all round), it builds faster and
                                //    the INSTANT speed decides (any hover — the hover strafes at ≤ 8 m/s — is still here)
  closeBuild: 2.5,              // × build rate inside `close` (a hover next to it is read at once)
  closeStill: 12,               // m/s: inside `close`, an instant speed below this is parked (a flare, a drift, a hover)
  far: 450,                     // m: farther is the pursuit's business
  front: 0.25,                  // cos of the angle off the titan's forward (≈ 75°), beyond `close`
  build: 1, drain: 2, hold: 0.25, // per s: build when still, drain when moving, slow drain in between / out of the zone
  anchor: 30,                   // ° the bearing may move before the count starts again
  mark: 2, guard: 3, lunge: 4.5, max: 8,       // s: the levels (see titan.js) and the cap
};

export function newCamp() {
  return { s: 0, ema: new THREE.Vector3(), speed: 0, speedNow: 0, anchor: new THREE.Vector3(), anchored: false, dist: 0, front: 0, inZone: false, close: false, reset: null, t: 0 };
}

const _d = new THREE.Vector3();
/**
 * One step of the meter. rel = core → player (world), vel = player velocity (world), fwd = titan forward (world,
 * unit), dt in s. Returns st (mutated). st.reset = 'anchor' | 'near' | null for this step (what broke a count).
 */
export function campStep(st, rel, vel, fwd, dt, cfg = CAMP) {
  st.reset = null;
  if (!(dt > 0) || !rel || !vel) return st;
  st.t += dt;
  const k = 1 - Math.exp(-dt / Math.max(0.05, cfg.ema));
  st.ema.lerp(vel, k);
  st.speed = st.ema.length();
  st.speedNow = vel.length();
  const dist = rel.length();
  st.dist = dist;
  const dir = _d.copy(rel).divideScalar(Math.max(1e-6, dist));
  const hz = Math.hypot(dir.x, dir.z) || 1e-6;
  st.front = (dir.x * fwd.x + dir.z * fwd.z) / (hz * (Math.hypot(fwd.x, fwd.z) || 1));
  const near = cfg.near ?? 0, close = cfg.close ?? 0;
  st.close = dist < close;
  st.inZone = dist >= near && dist <= cfg.far && (st.front >= cfg.front || st.close);
  if (near > 0 && dist < near && st.s > 0) { st.s = 0; st.anchored = false; st.reset = 'near'; return st; }
  // inside `close` the anchor follows her (a slow circle in its face is still camping); farther, a bearing change of
  // more than `anchor`° (flying round it) starts the count again
  if (st.anchored && st.close) st.anchor.copy(dir);
  else if (st.anchored && st.anchor.dot(dir) < Math.cos(cfg.anchor * D2R)) {
    const had = st.s;
    st.s = 0; st.anchored = false;
    if (had > 0) st.reset = 'anchor';
  }
  // builds while the averaged speed is a hover's (strafes back and forth average out) and she is not flying off now;
  // drains as soon as she really moves (the instant speed: pressing W answers the warning at once)
  // (close: the instant speed — a flier that flares in its face is read as soon as she hangs there, not 1.5 s later)
  const slow = st.close ? st.speedNow < (cfg.closeStill ?? cfg.still) && st.speed < cfg.move : st.speed < cfg.still && st.speedNow < cfg.move;
  if (st.inZone && slow) {
    if (!st.anchored) { st.anchor.copy(dir); st.anchored = true; }
    st.s = Math.min(cfg.max, st.s + cfg.build * (st.close ? cfg.closeBuild ?? 1 : 1) * dt);
  } else if (st.speed > cfg.move || st.speedNow > cfg.move) st.s = Math.max(0, st.s - cfg.drain * dt);
  else st.s = Math.max(0, st.s - cfg.hold * dt);
  if (st.s <= 0) st.anchored = false;
  return st;
}

/**
 * The open core's bonus falls off with range: full `mult` within `near` m of the core, `farMult` from `far` m on
 * (linear between) — the window rewards flying in close, not sniping from a hover. → the open multiplier (×).
 */
export function openMultAt(dist, open) {
  const near = open.near ?? 0, far = open.far ?? Infinity, m = open.mult, fm = open.farMult ?? m;
  if (!(dist > near)) return m;
  if (!(dist < far)) return fm;
  return m + (fm - m) * (dist - near) / (far - near);
}
