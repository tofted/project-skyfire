// game.enemies — the Shade Riders: enemy dragons flown by an AI "virtual pilot" through exactly the same Dragon
// physics as the player (the AI only writes dragon.steer() + controls, it never moves a dragon directly).
// Layers: brain (15 Hz state machine) → pilot (120 Hz: smoothed desired direction → dragon.steer, weapon and dodge
// edges) → Dragon physics (stepped by the Dragon's own driver system, order 36).
// Brain states: patrol (pairs in loose formation) → engage (lead/pure pursuit; 2 attack tokens, the rest circle the
// fight and cut across the player's nose) → attack: breath run (close in, flame when a packet would really touch the
// target) or fireball pass (150–470 m, lead + gravity + aim error) → break → extend (beam out) → engage …;
// evade (jinks, rolls, dives into clouds) when the player sits on the tail → reversal (turn into the attacker);
// regroup on the leader; flee (titan rise, victory). The ace (onyx) reacts faster, aims tighter, boosts, rolls.
//   enemies.spawnWave(spec) -> Pilot[]   spec: { riders:[{ skill:'rookie'|'veteran'|'ace', variant, name, hp }]
//                                               | { count, aces, skill }, distance, bearing, dy, formation:'pairs'|'none',
//                                               patrolTime, tag }
//   enemies.spawnPilot(opts) -> Pilot     one AI dragon of any team (opts: variant, team, skill, name, hp, pos, heading,
//                                         leader, slot, passive) — the sandbox flies a sparring hero with it
//   enemies.list                          every AI pilot (alive or falling); alive(), count() = living enemy riders
//   enemies.clear(all = false)            remove enemy riders (all: allied sparring pilots too)
//   enemies.hurry()                       the director's dead-air nudge; enemies.fleeAll() riders break off and leave
//   enemies.maxTokens (2), enemies.aggression (0.5..1), enemies.usingStandIn, SKILL, ENEMY_HP, ENEMY_WEAPONS
//   enemies.spawnFlock(spec) -> Flock     Shade Drakes: riderless small dragons flying as a boids flock around the player
//                                         spec: { count = 5, distance, bearing, dy, tag }. They dive in for bites / claw
//                                         passes ('impact') or spit small fireballs, and scatter from the player's breath.
//   enemies.maxLive (14)                  live enemy dragons at once; spawns beyond it wait in a queue (pending())
//   enemies.flocks, flockTokens (1)       at most 2 riders + 1 flock attack at once; the rest circle, taunt, reposition
//   enemies.pending(tag?), countRiders(), countDrakes(), pilotOf(actor), DRAKE
// Wave 4: enemies.maxLiveRiders (5; the director sets it per wave), riderRoom(); enemies.bringIn(n = 2, seconds = 8)
//   (the director's dead-air / last-enemies nudge: the nearest riders commit to head-on runs from the player's front,
//   flocks attack now); pilots' first attack runs start in the player's front sector (Pilot.frontRuns, spec.frontRuns);
//   fights stay out of clouds (updateCloud → cloudEsc; evade may hide in a cloud ≤ 4 s, every 20 s, aces 30 s);
//   circling riders vary their manoeuvres (level / zoom climb → dive / reverse / roll) and fly with a bank limit
//   (steer bankMax 55° circling, 68° attacking; evasive turns unlimited); a turning fight that gives no shot breaks
//   into a high yo-yo ('yoyo') or an extension; drake bite dives aim to miss by 5 m over / under the target's back.
// Survival (the director's endless mode) scales enemies per wave through spawn specs and a few system knobs; the story
//   never sets them, so its numbers are unchanged:
//   spec.hpMul / spec.dmgMul   HP and weapon damage of every dragon of the group (fireballs, breath via
//                              fx.breath({ damageMult }), drake bites and spits); kept on queued groups
//   spec.spread                bearing range (rad, centred on the player's heading) when no bearing is given, also for
//                              queued groups (default 1.8 ≈ ±52°; 2π = from anywhere, behind included)
//   spec.firstDives / spec.frontDives   a flock's first dives from the player's front (default 2 / true)
//   spec.aimMul / spec.homing  fireball aim error × aimMul (≤ 1 = tighter), + homing rad/s on every shot
//   enemies.aggressionFloor (0.5)      aggression never decays below it; enemies.potshotGap (2.2 s) the shared
//                                      potshot limiter; enemies.potshotCone (20°) how far off its flight path a
//                                      circling rider may take a potshot; all reset by clear()
//   enemies.pressure (0)       0..1, the director's "stop running" pressure on a player who hits nothing: up to 2 more
//                              rider tokens, +1 flock token from 0.5, chases up to +15 % faster (≤ 63.8 m/s, on the
//                              boost from 220 m when the target flies away), potshots up to 35 % more often
//   spec.hunter                Interceptors: always hold an attack token (outside maxTokens), chase +20 % (≤ 63.8 m/s),
//                              evade after twice the delay, pass the rider cap and the live cap by up to one pair
// Levels (25.09): enemies.recoil() — on 'levelup' with elementChanged the drakes near Sora scatter and close riders
//   break away (event 'enemies:recoil' { count, drakes, riders }); XP per kill is game.progress's (by pilot.skillName).
// Pilot: { id, name, dragon, actor, kind:'rider'|'drake', skillName, variant, team, state, mode, alive, wave, token,
//          flock, dmgMul, stats{shots,bursts,dodges,bites} }
import * as THREE from 'three';
import { clamp, damp, lerp, smoothstep, rng } from '../core/util.js';

const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);
const BRAIN_HZ = 15;
const MAX_AI_SPEED = 58;     // m/s the AI may ask for; the player's boost asks for 62 (player.js)

// Skill knobs (flight-physics.md §11.4, dragontwin-feel.md §9). Same airframe as the player; the ace flies an
// onyx dragon (the dragon owner's spec may make it faster) and simply makes better decisions.
export const SKILL = {
  rookie: {
    react: 0.45, aim: 6 * DEG, urgency: 0.62, turnSmooth: 3.5, detect: 1500,
    breathPref: 0.5, burst: 1.3, breathCd: 3.2, fbCd: 6.0, fbShots: 1, homing: 0, fbSpeed: 55, fbError: 0.5,
    dodge: 0.2, evadeDelay: 0.8, evadeMax: 3.5, jink: [1.4, 2.2], jinkAmt: 0.55, weave: true, boost: 0.1, rollDodge: 0.25, speedMul: 1.0, attackMul: 1.18,
  },
  veteran: {
    react: 0.25, aim: 3 * DEG, urgency: 0.8, turnSmooth: 5, detect: 1800,
    breathPref: 0.55, burst: 1.2, breathCd: 2.6, fbCd: 4.5, fbShots: 2, homing: 0, fbSpeed: 60, fbError: 0.6,
    dodge: 0.3, evadeDelay: 0.5, evadeMax: 3.0, jink: [1.0, 1.8], jinkAmt: 0.85, weave: false, boost: 0.35, rollDodge: 0.5, speedMul: 1.04, attackMul: 1.25,
  },
  // Wave 4: the ace was a wall (critics: 0–1 aces downed in 1358 s of wave 3). Still the best pilot in the sky, but it
  // reacts a little later, jinks and rolls (i-frames) less often, dodges a third of the fireballs instead of 60 %, its
  // shots home half as hard and come less often.
  ace: {
    react: 0.16, aim: 1.8 * DEG, urgency: 0.95, turnSmooth: 6.5, detect: 2200,
    breathPref: 0.6, burst: 1.0, breathCd: 2.6, fbCd: 4.2, fbShots: 2, homing: 0.18, fbSpeed: 66, fbError: 0.9,
    dodge: 0.3, evadeDelay: 0.55, evadeMax: 2.2, jink: [1.0, 1.7], jinkAmt: 0.85, weave: false, boost: 0.5, rollDodge: 0.4, speedMul: 1.08, attackMul: 1.3,
  },
  // Shade Drake: no rider, no breath; quick, twitchy, flies with its flock (DrakePilot below).
  drake: {
    react: 0.32, aim: 4 * DEG, urgency: 0.95, turnSmooth: 6.5, detect: 2200,
    breathPref: 0, burst: 0, breathCd: 99, fbCd: 4.5, fbShots: 1, homing: 0, fbSpeed: 58, fbError: 0.7,
    dodge: 0.3, evadeDelay: 9, evadeMax: 2, jink: [0.8, 1.4], jinkAmt: 0.7, weave: false, boost: 0.5, rollDodge: 0.35, speedMul: 1.1, attackMul: 1.32,
  },
};

// Balance (the director's doc has the full table). HP per skill; enemy weapons. Wave 2 retune now that the player
// shoots back: a rookie falls to ~4 fireballs or ~3 s of breath, the ace pair takes clearly longer.
export const ENEMY_HP = { rookie: 160, veteran: 210, ace: 260, drake: 70 };   // wave 4: ace 360 → 260
export const ENEMY_WEAPONS = {
  fireballDamage: { rookie: 26, veteran: 30, ace: 30, drake: 9 },
  fireballRadius: 1.5,
  breathRange: 70,          // m, where the AI opens up (fx.breath decides real reach and damage)
  breathDps: 60,            // only used by the fallback flame when game.fx is missing
  flameSpeed: 45,           // m/s relative to the mouth, for lead
};

// Drawn at random from the pool, no two living dragons share one (survival's bigger skies need the longer lists).
// Languages (29.09): these names stay English on actor.name / pilot.name (code tests them: /drake/, /\bace\b/, /titan/);
// the screen shows tr(name) — every name here (and the dragon.js defaults) has its Russian text in src/ui/i18n/ru-game.js.
const NAMES = {
  rookie: ['Shade Rider Hask', 'Shade Rider Vey', 'Shade Rider Oren', 'Shade Rider Tal', 'Shade Rider Brin', 'Shade Rider Sef',
    'Shade Rider Pell', 'Shade Rider Dask', 'Shade Rider Ulm', 'Shade Rider Garr', 'Shade Rider Nim', 'Shade Rider Cole'],
  veteran: ['Shade Lancer Rook', 'Shade Lancer Idris', 'Shade Lancer Maro', 'Shade Lancer Kest',
    'Shade Lancer Varn', 'Shade Lancer Osk', 'Shade Lancer Tamsin', 'Shade Lancer Drey'],
  ace: ['Onyx Ace Morrow', 'Onyx Ace Vael', 'Onyx Ace Sable', 'Onyx Ace Corvin', 'Onyx Ace Nyra', 'Onyx Ace Thorne'],
  drake: ['Shade Drake'],
};

// Shade Drakes (riderless, small, in flocks). Bites are 'impact' damage on contact during a dive; the spit is a small
// fireball. HP 70 = about 1.2 s of full breath contact: one good burst into the flock.
export const DRAKE = {
  hp: 70,
  bite: 11, biteRadius: 4.2, biteBody: 4.2,          // damage per bite (once per dive) and contact spheres (m)
  spitDamage: 9, spitRadius: 0.9, spitSpeed: 58, spitRange: [50, 300],
  orbitR: [140, 195], attackR: 100, orbitW: 0.08,    // circling radius (m) around the ring centre, orbit rate (rad/s)
  orbitAlt: [5, 60],                                 // circling height above the player: dives are shallow stoops
  leadT: [3.2, 3.5],                                 // ring centre = player + velocity × leadT (circle, attack): in view
  diveGap: [0.5, 1.0], attackMax: 13, tokenCd: [4, 7.5], spitPref: 0.3, diveFrom: 240,
  scatterReact: [0.2, 0.45], scatterChance: 0.8, scatterRange: 95, scatterCone: 40 * DEG, scatterFor: [1.3, 2.1],
  maxDiveSpeed: 64,
};

// ---------------------------------------------------------------------------------------------------------------
// Stand-in flyer: used only when actors/dragon.js is missing or its constructor throws, so the encounter stays
// playable while the real Dragon is being built. Point mass with a load-factor-limited turn (n_max = (v/16)², ≤ 4.5),
// energy trade on climbs and dives, downstroke flap animation and a primitive toon model. Same public surface as
// Dragon (controls, steer, pos/vel/quat, actor, mouth/mouthDir, fixedUpdate/update), so the AI does not care.
// ---------------------------------------------------------------------------------------------------------------
const PALETTE = {
  hero: { body: 0xefe6d2, belly: 0xf6efe0, membrane: 0x6fe0d0, horn: 0xd8b060, rider: 0xc0392b },
  crimson: { body: 0x1b1a22, belly: 0x2a2530, membrane: 0xb3202a, horn: 0xe6dcc4, rider: 0x2b2830 },
  onyx: { body: 0x111018, belly: 0x1d1a24, membrane: 0x5c1020, horn: 0xf0e2c0, rider: 0x16151c },
};

function buildStandInModel(game, variant) {
  const pal = PALETTE[variant] || PALETTE.crimson;
  const T = game.toon;
  const mat = (color, o = {}) => (T ? T.material({ color, ...o }) : new THREE.MeshLambertMaterial({ color, side: o.side ?? THREE.FrontSide }));
  // Own inverted hull (uses the geometry normal, so it compiles for plain meshes); shared per model.
  const olMat = new THREE.MeshBasicMaterial({ color: variant === 'hero' ? 0x3a2e3a : 0x0a0810, side: THREE.BackSide });
  olMat.userData.cacheKey = 'standinOutline';
  olMat.onBeforeCompile = (sh) => {
    sh.uniforms.olW = { value: 0.06 };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float olW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += normalize(normal) * olW;');
  };
  game.atmo?.patch(olMat);
  const outline = (m, w = 0.07) => {
    const o = new THREE.Mesh(m.geometry, w === 0.07 ? olMat : Object.assign(olMat.clone(), { onBeforeCompile: (sh) => { olMat.onBeforeCompile(sh); sh.uniforms.olW.value = w; } }));
    o.userData.isOutline = true; o.castShadow = false;
    m.add(o);
    return m;
  };
  const root = new THREE.Group();
  root.name = `standin_${variant}`;
  const bodyM = mat(pal.body), bellyM = mat(pal.belly), hornM = mat(pal.horn);
  const memM = mat(pal.membrane, { side: THREE.DoubleSide, rim: 0xffd0c0 });

  const add = (geo, m, p, r, s) => {
    const o = new THREE.Mesh(geo, m);
    if (p) o.position.set(...p); if (r) o.rotation.set(...r); if (s) o.scale.set(...s);
    o.castShadow = true;
    root.add(o);
    return o;
  };
  // Torso along +Z (forward), neck and head, tail, legs tucked.
  outline(add(new THREE.CapsuleGeometry(1.25, 4.0, 6, 14), bodyM, [0, 0, 0], [Math.PI / 2, 0, 0], [1, 1, 0.9]));
  outline(add(new THREE.CapsuleGeometry(0.62, 3.2, 4, 10), bodyM, [0, 0.55, 3.9], [Math.PI / 2 - 0.35, 0, 0]));
  const head = outline(add(new THREE.ConeGeometry(0.62, 2.3, 10), bodyM, [0, 1.1, 6.3], [Math.PI / 2 + 0.1, 0, 0]));
  add(new THREE.ConeGeometry(0.16, 1.4, 6), hornM, [0.35, 1.7, 5.3], [-0.9, 0, -0.25]);
  add(new THREE.ConeGeometry(0.16, 1.4, 6), hornM, [-0.35, 1.7, 5.3], [-0.9, 0, 0.25]);
  const tail = new THREE.Group(); tail.position.set(0, 0.1, -2.6); root.add(tail);
  const tailMesh = new THREE.Mesh(new THREE.ConeGeometry(0.75, 7.5, 10), bodyM);
  tailMesh.rotation.x = -Math.PI / 2; tailMesh.position.z = -3.7; tail.add(tailMesh); outline(tailMesh);
  for (let i = 0; i < 6; i++) add(new THREE.ConeGeometry(0.14, 0.7, 5), hornM, [0, 1.25 - i * 0.07, 1.6 - i * 1.1], [-0.4, 0, 0]);
  for (const sx of [1, -1]) {
    outline(add(new THREE.CapsuleGeometry(0.28, 1.2, 3, 6), bellyM, [0.75 * sx, -1.0, 1.4], [0.9, 0, 0]));
    outline(add(new THREE.CapsuleGeometry(0.32, 1.4, 3, 6), bellyM, [0.8 * sx, -0.95, -1.6], [1.2, 0, 0]));
  }
  // Rider: a small armoured figure on the saddle.
  const riderM = mat(pal.rider);
  outline(add(new THREE.CapsuleGeometry(0.32, 0.7, 3, 8), riderM, [0, 1.75, 1.2], [0.35, 0, 0]), 0.03);
  outline(add(new THREE.SphereGeometry(0.26, 10, 8), riderM, [0, 2.45, 1.45]), 0.03);
  if (variant !== 'hero') add(new THREE.ConeGeometry(0.06, 0.5, 5), hornM, [0, 2.75, 1.4], [-0.3, 0, 0]);
  else add(new THREE.BoxGeometry(0.9, 0.08, 0.4), mat(0xc0392b), [0.35, 2.2, 1.0], [0, 0.4, 0.2]);

  // Wings: an arm (leading edge) plus a membrane fan to four finger tips. Pivot at the shoulder; left = +X.
  const wings = [];
  for (const sx of [1, -1]) {
    const pivot = new THREE.Group(); pivot.position.set(0.9 * sx, 0.75, 1.3); root.add(pivot);
    const P = [[0, 0, 0.3], [3.4, 0.35, 0.8], [6.0, 0.5, 1.3], [8.6, 0.2, -0.6], [7.4, 0, -2.7], [5.2, 0, -3.8], [2.4, 0, -3.3], [0, 0, -2.4]];
    const pos = [];
    const tri = (a, b, c) => { for (const i of [a, b, c]) pos.push(P[i][0] * sx, P[i][1], P[i][2]); };
    tri(0, 1, 7); tri(1, 6, 7); tri(1, 2, 6); tri(2, 5, 6); tri(2, 4, 5); tri(2, 3, 4);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    const mem = new THREE.Mesh(g, memM); mem.castShadow = true; pivot.add(mem);
    const bone = (a, b, r) => {
      const va = new THREE.Vector3(a[0] * sx, a[1], a[2]), vb = new THREE.Vector3(b[0] * sx, b[1], b[2]);
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.7, r, va.distanceTo(vb), 6), bodyM);
      m.position.copy(va).add(vb).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(UP, vb.clone().sub(va).normalize());
      pivot.add(m); outline(m, 0.04);
    };
    bone(P[0], P[1], 0.32); bone(P[1], P[2], 0.22); bone(P[2], P[3], 0.1); bone(P[2], P[4], 0.09); bone(P[2], P[5], 0.08);
    wings.push({ pivot, sx });
  }
  root.userData.headMesh = head;
  return { root, wings, tail };
}

class StandInDragon {
  constructor(game, o = {}) {
    this.game = game;
    this.isStandIn = true;
    this.variant = o.variant || 'crimson';
    this.name = o.name || 'Dragon';
    this.pos = (o.pos || new THREE.Vector3(0, 1400, 0)).clone();
    const h = o.heading ?? 0;
    const fwd = new THREE.Vector3(Math.sin(h), 0, Math.cos(h));
    this.cruise = this.variant === 'onyx' ? 36 : this.variant === 'hero' ? 34 : 33;
    this.vel = fwd.clone().multiplyScalar(this.cruise);
    this.quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), fwd);
    this.controls = { pitch: 0, roll: 0, yaw: 0, flap: 0, boost: false, glide: false, dive: false, flare: false, breath: false, fireball: false, dodge: 0 };
    this.airspeed = this.cruise; this.aoa = 0; this.stamina = 1; this.heat = 0; this.flapPhase = Math.random();
    this.mouth = new THREE.Vector3(); this.mouthDir = fwd.clone();
    this._want = fwd.clone(); this._speed = this.cruise; this._urgency = 0.6;
    this._bank = 0; this._dodgeT = 0; this._dodgeSide = 0; this._rollSpin = 0; this._flapAmt = 0.5;
    this._fallSpin = 0;
    const model = buildStandInModel(game, this.variant);
    this.root = model.root; this._wings = model.wings; this._tail = model.tail;
    game.scene.add(this.root);
    const V = () => new THREE.Vector3();
    this.actor = {
      name: this.name, kind: 'dragon', team: o.team || 'enemy', hp: o.hp ?? 220, maxHp: o.hp ?? 220, alive: true,
      root: this.root, pos: this.pos, vel: this.vel, radius: 14, dragon: this,
      shapes: [
        { kind: 'capsule', a: V(), b: V(), r: 1.7, part: 'body', mult: 1 },
        { kind: 'sphere', a: V(), r: 1.3, part: 'head', mult: 1.5 },
        { kind: 'capsule', a: V(), b: V(), r: 1.4, part: 'wingL', mult: 0.8 },
        { kind: 'capsule', a: V(), b: V(), r: 1.4, part: 'wingR', mult: 0.8 },
        { kind: 'capsule', a: V(), b: V(), r: 0.9, part: 'tail', mult: 0.7 },
      ],
    };
    game.combat?.register(this.actor);
    this._updateShapes();
  }
  get alive() { return this.actor.alive; }
  get hp() { return this.actor.hp; }
  get altitude() { return this.pos.y - (this.game.world.heightAt(this.pos.x, this.pos.z) || 0); }

  steer(dir, o = {}) {
    if (dir && dir.lengthSq() > 1e-8) this._want.copy(dir).normalize();
    this._speed = o.speed ?? this.cruise;
    this._urgency = clamp(o.urgency ?? 0.6, 0, 1);
    const lf = _v1.set(0, 0, 1).applyQuaternion(this.quat);
    const c = this.controls;
    c.pitch = clamp((this._want.y - lf.y) * 3, -1, 1);
    c.yaw = clamp(-_v2.crossVectors(lf, this._want).y * 3, -1, 1);
    c.roll = c.yaw;
    c.flap = clamp((this._speed - this.airspeed) / 10 + 0.4, 0, 1);
    c.boost = this._speed > this.airspeed + 12 && this.stamina > 0.3;
    c.flare = this._speed < this.airspeed - 14;
  }

  fixedUpdate(dt) {
    const c = this.controls, g = 9.81;
    if (!this.actor.alive) {
      this.vel.y -= g * dt; this.vel.multiplyScalar(1 - 0.08 * dt);
      this.pos.addScaledVector(this.vel, dt);
      this._fallSpin += dt * 2.4;
      this._updateShapes();
      return;
    }
    const v = Math.max(1, this.vel.length());
    const fwd = _v1.copy(this.vel).divideScalar(v);
    const nMax = Math.min(1.8 + 2.7 * this._urgency, (v / 16) ** 2);
    const omega = g * Math.sqrt(Math.max(nMax * nMax - 1, 0.05)) / v;
    const ang = fwd.angleTo(this._want);
    const nf = _v2.copy(fwd);
    if (ang > 1e-4) {
      const axis = _v3.crossVectors(fwd, this._want);
      if (axis.lengthSq() < 1e-10) axis.set(0, 1, 0);
      nf.applyAxisAngle(axis.normalize(), Math.min(ang, omega * dt));
    }
    // Lateral acceleration → coordinated bank (left = +X in model space).
    const left = _v3.crossVectors(UP, nf).normalize();
    const aLeft = nf.clone().sub(fwd).divideScalar(dt).multiplyScalar(v).dot(left);
    this._bank = lerp(this._bank, -Math.atan2(aLeft, g), damp(8, dt));
    // Energy: thrust toward the wanted speed, gravity along the path (climbs cost, dives pay).
    const boost = c.boost && this.stamina > 0.05;
    const thrust = clamp((this._speed - v) * 0.9, c.flare ? -10 : -3, boost ? 13 : 6.5);
    let nv = clamp(v + (thrust - g * nf.y * 0.85) * dt, 15, 105);
    this.stamina = clamp(this.stamina + (boost ? -0.22 : 0.08) * dt, 0, 1);
    this._flapAmt = lerp(this._flapAmt, clamp(thrust / 6.5, 0.05, 1), damp(3, dt));
    this.vel.copy(nf).multiplyScalar(nv);
    // Dodge roll (edge): 9 m sidestep over 0.35 s with i-frames, a 360° roll for the eye.
    if (c.dodge && this._dodgeT <= 0 && this.stamina > 0.2) {
      this._dodgeT = 0.35; this._dodgeSide = Math.sign(c.dodge); this.stamina -= 0.2; this.actor.invuln = Math.max(this.actor.invuln || 0, 0.3);
    }
    c.dodge = 0;
    if (this._dodgeT > 0) {
      this._dodgeT -= dt;
      this.pos.addScaledVector(left, -this._dodgeSide * (9 / 0.35) * dt);
      this._rollSpin = (1 - Math.max(0, this._dodgeT) / 0.35) * Math.PI * 2 * this._dodgeSide;
    } else this._rollSpin = 0;
    this.pos.addScaledVector(this.vel, dt);
    this.airspeed = nv;
    // Orientation: forward along the path, bank about it.
    const m = _m.lookAt(_v4.set(0, 0, 0), nf.clone().negate(), UP);   // lookAt points -Z; we want +Z forward
    this.quat.setFromRotationMatrix(m);
    this.quat.multiply(_q.setFromAxisAngle(_z, this._bank + this._rollSpin));
    this.flapPhase = (this.flapPhase + dt * (0.72 + 0.5 * this._flapAmt + (boost ? 0.4 : 0))) % 1;
    this._updateShapes();
  }

  _updateShapes() {
    const q = this.quat, p = this.pos, s = this.actor.shapes;
    const L = (x, y, z, out) => out.set(x, y, z).applyQuaternion(q).add(p);
    L(0, 0, -2.8, s[0].a); L(0, 0.3, 3.2, s[0].b);
    L(0, 1.1, 6.6, s[1].a);
    L(1.2, 0.8, 1.2, s[2].a); L(8.0, 0.6, -0.8, s[2].b);
    L(-1.2, 0.8, 1.2, s[3].a); L(-8.0, 0.6, -0.8, s[3].b);
    L(0, 0, -3.0, s[4].a); L(0, 0, -9.5, s[4].b);
    L(0, 1.0, 7.4, this.mouth);
    this.mouthDir.set(0, -0.05, 1).normalize().applyQuaternion(q);
  }

  update(dt, realDt) {
    this.root.position.copy(this.pos);
    this.root.quaternion.copy(this.quat);
    if (!this.actor.alive) this.root.rotateZ(this._fallSpin), this.root.rotateX(Math.sin(this._fallSpin * 0.5) * 0.4);
    // Downstroke is faster than the upstroke (55/45) and the wing stays high a moment at the top.
    const ph = this.flapPhase;
    const s = ph < 0.55 ? Math.cos((ph / 0.55) * Math.PI) : -Math.cos(((ph - 0.55) / 0.45) * Math.PI);
    const amp = this.actor.alive ? 0.25 + 0.55 * this._flapAmt : 0.9;
    for (const w of this._wings) {
      w.pivot.rotation.z = w.sx * (s * amp + 0.08);
      w.pivot.rotation.y = w.sx * (ph < 0.55 ? 0.05 : -0.18) * this._flapAmt;
    }
    this._tail.rotation.y = Math.sin(this.game.time.now * 1.3 + this.pos.x) * 0.12 - this._bank * 0.2;
    this._tail.rotation.x = -this.vel.y * 0.004;
  }

  dispose() {
    this.root.parent?.remove(this.root);
    this.root.traverse((o) => { if (o.isMesh) { o.geometry?.dispose(); if (!o.userData.isOutline) o.material?.dispose?.(); } });
    this.game.combat?.unregister(this.actor);
  }
}
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _z = new THREE.Vector3(0, 0, 1);

// ---------------------------------------------------------------------------------------------------------------
// Helpers shared by pilots
// ---------------------------------------------------------------------------------------------------------------
const FWD = new THREE.Vector3(0, 0, 1);
function forwardOf(d, out) {
  if (d.quat) return out.copy(FWD).applyQuaternion(d.quat);
  if (d.vel && d.vel.lengthSq() > 1) return out.copy(d.vel).normalize();
  return out.copy(FWD);
}
/** Flight-path direction (velocity); the body's nose sits a few degrees above it (angle of attack). */
function pathOf(d, out) {
  if (d.vel && d.vel.lengthSq() > 25) return out.copy(d.vel).normalize();
  return forwardOf(d, out);
}
function actorOf(d) { return d?.actor || (d?.hp !== undefined && d?.team ? d : null); }
function isAlive(d) { const a = actorOf(d); return !!(a ? a.alive : d?.alive); }
function speedOf(d) { return d.airspeed ?? d.vel?.length() ?? 36; }

/** Smallest positive t with |dp + dv t| = s t (intercept); returns aim point relative offset in out, or null. */
function intercept(dp, dv, s, out) {
  const a = dv.dot(dv) - s * s, b = 2 * dp.dot(dv), c = dp.dot(dp);
  let t;
  if (Math.abs(a) < 1e-6) t = b < 0 ? -c / b : -1;
  else {
    const disc = b * b - 4 * a * c;
    if (disc < 0) return -1;
    const r = Math.sqrt(disc);
    const t1 = (-b - r) / (2 * a), t2 = (-b + r) / (2 * a);
    t = Math.min(t1, t2) > 0 ? Math.min(t1, t2) : Math.max(t1, t2);
  }
  if (!(t > 0)) return -1;
  out.copy(dv).multiplyScalar(t).add(dp);
  return t;
}

// ---------------------------------------------------------------------------------------------------------------
// The AI pilot (one per dragon)
// ---------------------------------------------------------------------------------------------------------------
let nextPilotId = 1;
class Pilot {
  constructor(sys, dragon, o) {
    this.id = nextPilotId++;
    this.sys = sys; this.game = sys.game; this.dragon = dragon;
    this.actor = actorOf(dragon);
    this.name = o.name || this.actor?.name || 'Rider';
    this.skillName = SKILL[o.skill] ? o.skill : 'rookie';
    this.skill = SKILL[this.skillName];
    this.variant = o.variant || 'crimson';
    this.team = this.actor?.team || o.team || 'enemy';
    this.wave = o.wave ?? null;
    this.leader = o.leader || null;
    this.slot = o.slot || 0;
    this.rand = rng(o.seed ?? (this.id * 7919 + 17));
    this.state = 'patrol'; this.stateT = 0; this.t = 0;
    this.brainAcc = this.rand() / BRAIN_HZ;               // staggers brains across fixed steps
    this.patrolMax = o.patrolTime ?? 1.2;
    this.anchor = dragon.pos.clone();
    const f = forwardOf(dragon, new THREE.Vector3());
    this.want = f.clone(); this.dir = f.clone();
    this.cruise = dragon.body?.spec?.pilot?.cruise ?? dragon.cruise ?? 34;
    this.lookPoint = new THREE.Vector3();
    this.speed = this.cruise; this.urgency = 0.5;
    this.breathOn = false; this.boostOn = false; this.diveOn = false; this.flareOn = false; this.dodgeEdge = 0;
    this.token = false; this.tailT = 0; this.calmT = 0; this.sixT = 0;
    this.nYaw = 0; this.nPitch = 0;                       // OU aim noise (rad)
    this.breathT = 0; this.breathCd = 1 + this.rand() * 2; this.fbCd = 1.5 + this.rand() * 2.5;
    this.fbShots = 0; this.fbGap = 0; this.bursts = 0; this.runSide = 1; this.runClose = 0; this.stateBoost = false; this.mode = null;
    this.jinkT = 0; this.jinkDir = new THREE.Vector3(); this.breakDir = new THREE.Vector3(); this.breakDur = 2;
    this.crossT = 6 + this.rand() * 5; this.crossing = 0; this.crossPoint = new THREE.Vector3(); this.wheelSign = this.rand() < 0.5 ? -1 : 1;
    this.cloudGoal = null; this.dodgeQueue = []; this.reacted = new WeakSet();
    this.target = null; this.retargetT = 0;
    this.passive = !!o.passive;                           // test dummy: flies a straight, level line, never fires
    if (this.passive) this.state = 'idle';
    this.deadT = 0; this.removeAfter = 9;
    this.kind = 'rider'; this.flock = null;
    this.avoidSkip = null;                                // a dragon we mean to pass close to (drake bite dives)
    // Circling (no token): each rider holds its own ring and height and repositions every 7-12 s, so a big wave
    // spreads around the player instead of bunching; taunt passes cut across the nose with a roll.
    this.wheelR = 230 + this.rand() * 110; this.wheelDy = -40 + this.rand() * 150; this.repoT = 7 + this.rand() * 5;
    // Wave 4. First attacks come from where a beginner can see them: `frontRuns` attack runs start from the player's
    // front sector (±60° of its course, facing it); until then the rider circles in that sector. `forcedUntil`: the
    // director's bring-in (last enemies / dead air) — a committed head-on run, no evading, no cloud hiding.
    this.frontRuns = o.frontRuns ?? 1; this.frontT = 0; this.forcedUntil = -1; this.frontFirst = true;
    // Clouds: fights stay in clear air. cloudIn = s spent inside, cloudEsc = the way out (bent into `want`).
    this.cloudIn = 0; this.cloudDen = 0; this.cloudAcc = this.rand() * 0.2; this.cloudEsc = new THREE.Vector3(); this.lastCloudT = -99;
    // Manoeuvres while circling (no token): orbit | level | climb | dive | reverse | roll, each 3–6 s, so a rider
    // levels out, trades height for speed and reverses instead of holding a 70° bank on a ring.
    this.mnv = 'orbit'; this.mnvT = 1 + this.rand() * 3; this.mnvDir = new THREE.Vector3(0, 0, 1);
    this.bankMax = null;                                  // steer's hard bank limit (deg) for the current state
    // Survival scaling: every weapon of this pilot (fireballs, breath, bites, spits) × dmgMul (story: 1).
    this.dmgMul = Number.isFinite(o.dmgMul) && o.dmgMul > 0 ? o.dmgMul : 1;
    this.aimMul = Number.isFinite(o.aimMul) && o.aimMul > 0 ? Math.min(1.5, o.aimMul) : 1;     // fireball error × this
    this.homingAdd = Number.isFinite(o.homing) && o.homing > 0 ? Math.min(0.5, o.homing) : 0;  // + rad/s on its shots
    // Survival Interceptor (spec.hunter): always holds an attack token (outside maxTokens), chases faster and harder,
    // evades later. The story never spawns one.
    this.hunter = !!o.hunter;
    this.stats = { shots: 0, bursts: 0, dodges: 0, bites: 0 };
    // scratch
    this._rel = new THREE.Vector3(); this._los = new THREE.Vector3(); this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3(); this._tmp = new THREE.Vector3(); this._aim = new THREE.Vector3(); this._lead = new THREE.Vector3();
    this.leadDir = new THREE.Vector3(0, 0, 1);
  }
  get alive() { return isAlive(this.dragon); }
  get pos() { return this.dragon.pos; }

  setState(s) {
    if (this.state === s) return;
    this.state = s; this.stateT = 0;
    if (s !== 'attack' && 'lookTarget' in this.dragon) this.dragon.lookTarget = null;
    if (s === 'engage') { this.nextAttack = null; this.stuckAt = 7 + this.rand() * 4; }
    if (s === 'yoyo') this.yoyoUp = 1.8 + this.rand() * 1.2;
    if (s !== 'attack') this.setBreath(false);
    if (s === 'break') this.enterBreak();
    if (s === 'evade') {
      // A dive into a cloud at most every 20 s (aces: once per 30 s), never during a bring-in; ≤ 4 s inside.
      const cloudOk = !this.forced() && this.t - this.lastCloudT > (this.skillName === 'ace' ? 30 : 20);
      this.jinkT = 0; this.cloudGoal = cloudOk ? this.findCloud() : null; this.stateBoost = this.rand() < this.skill.boost + 0.1;
      if (this.cloudGoal) this.lastCloudT = this.t;
      this.evadeFor = this.skill.evadeMax + this.rand();
    }
  }
  /** The director's bring-in is running: commit to head-on runs, no evading, no clouds. */
  forced() { return this.forcedUntil > this.game.time.now; }
  /** Evading into a cloud right now (the only time a rider may sit inside one, ≤ 4 s). */
  hidingInCloud() { return this.state === 'evade' && !!this.cloudGoal && this.cloudIn < 4; }

  /** Clouds (5 Hz): density here and 2 s ahead; when it is thick, the clearest way out (up / down / left / right). */
  updateCloud(dt) {
    this.cloudAcc += dt;
    if (this.cloudAcc < 0.2) return;
    const step = this.cloudAcc; this.cloudAcc = 0;
    const f = this.game.world?.cloudDensity, d = this.dragon;
    if (typeof f !== 'function' || !d.vel) { this.cloudDen = 0; this.cloudEsc.set(0, 0, 0); return; }
    let den = 0, ahead = 0;
    try {
      den = f(d.pos.x, d.pos.y, d.pos.z) || 0;
      ahead = f(d.pos.x + d.vel.x * 2, d.pos.y + d.vel.y * 2, d.pos.z + d.vel.z * 2) || 0;
    } catch { den = 0; ahead = 0; }
    this.cloudDen = den;
    this.cloudIn = den > 0.3 ? this.cloudIn + step : 0;
    const worst = Math.max(den, ahead * 0.8);
    if (worst < 0.22 || this.hidingInCloud()) { this.cloudEsc.set(0, 0, 0); return; }
    const fwd = pathOf(d, _c1).setY(0);
    if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, 1);
    fwd.normalize();
    const right = _c2.crossVectors(fwd, UP).normalize();
    let best = null, bestDen = worst;
    const cand = [[0, 1, 0, 150], [0, -1, 0, 150], [1, 0.1, 0.5, 170], [-1, 0.1, 0.5, 170]];
    for (const [sr, sy, sf, r] of cand) {
      const dir = _c3.copy(right).multiplyScalar(sr).addScaledVector(UP, sy).addScaledVector(fwd, sf).normalize();
      let dd = 1;
      try { dd = f(d.pos.x + dir.x * r, d.pos.y + dir.y * r, d.pos.z + dir.z * r) || 0; } catch { dd = 1; }
      if (dd < bestDen - 0.05) { bestDen = dd; best = (this._cb || (this._cb = new THREE.Vector3())).copy(dir); }
    }
    if (!best) best = _c3.copy(UP);                       // no clear side: climb out of the deck
    this.cloudEsc.copy(best).multiplyScalar(clamp(0.4 + worst * 1.6 + this.cloudIn * 0.25, 0.4, 2.2));
  }

  setBreath(on) {
    if (this.breathOn === on) return;
    this.breathOn = on;
    this.sys.breathEdge(this, on);
  }

  /** Where the flame starts: dragon.mouth while it is sane (≤ 25 m from the body), else a point ahead of the head. */
  mouthPoint(out) {
    const d = this.dragon, m = d.mouth;
    if (m && m.distanceToSquared(d.pos) < 625) return out.copy(m);
    return out.copy(d.pos).addScaledVector(forwardOf(d, _m1), 9).addScaledVector(UP, 0.8);
  }
  mouthDirection(out) {
    const d = this.dragon, md = d.mouthDir;
    if (md && md.lengthSq() > 0.5 && d.mouth && d.mouth.distanceToSquared(d.pos) < 625) return out.copy(md).normalize();
    // No usable head: the gaze would lead the flight path toward the look target (≤ 30° off the path).
    pathOf(d, out);
    if (d.lookTarget) {
      const want = _m2.subVectors(d.lookTarget, this.mouthPoint(_m3)).normalize();
      const a = Math.acos(clamp(want.dot(out), -1, 1));
      out.lerp(want, a > 1e-3 ? Math.min(1, (30 * DEG) / a) : 1).normalize();
    }
    return out;
  }
  mouthSane() { const m = this.dragon.mouth; return !!m && m.distanceToSquared(this.dragon.pos) < 625; }
  /** Source object for fx.breath: the dragon itself, or a proxy with a corrected mouth when the dragon's is off. */
  flameSource() {
    if (this.mouthSane()) return this.dragon;
    if (!this._flameSrc) {
      const pilot = this, d = this.dragon, mv = new THREE.Vector3(), mdv = new THREE.Vector3();
      this._flameSrc = {
        get mouth() { return pilot.mouthPoint(mv); }, get mouthDir() { return pilot.mouthDirection(mdv); },
        get vel() { return d.vel; }, get alive() { return d.alive !== false && pilot.actor?.alive !== false; },
        actor: this.actor, root: d.root, team: this.team,
      };
    }
    return this._flameSrc;
  }

  pickTarget() {
    const sys = this.sys;
    if (this.team === 'enemy') { const p = sys.playerDragon(); return p && isAlive(p) ? p : null; }
    // A sparring pilot on the player's team hunts the enemy most in front of it.
    this.retargetT -= 1 / BRAIN_HZ;
    if (this.target && isAlive(this.target) && this.retargetT > 0) return this.target;
    this.retargetT = 3;
    const f = forwardOf(this.dragon, this._tmp);
    let best = null, bestS = Infinity;
    for (const p of sys.list) {
      if (p === this || !p.alive || p.team === this.team) continue;
      const d = p.dragon.pos.distanceTo(this.dragon.pos);
      const ang = Math.acos(clamp(this._rel.subVectors(p.dragon.pos, this.dragon.pos).normalize().dot(f), -1, 1));
      const s = d / 400 + ang * 1.5;
      if (s < bestS) { bestS = s; best = p.dragon; }
    }
    this.target = best;
    return best;
  }

  // ---- brain (15 Hz) --------------------------------------------------------------------------------------------
  think(dt) {
    const d = this.dragon, s = this.skill, sys = this.sys;
    this.t += dt; this.stateT += dt;
    this.breathCd = Math.max(0, this.breathCd - dt);
    this.fbCd = Math.max(0, this.fbCd - dt * (0.7 + 0.6 * sys.aggression));
    this.fbGap = Math.max(0, this.fbGap - dt);
    // OU aim noise: wanders with σ = skill.aim, τ = 0.8 s.
    const k = Math.sqrt(2 * dt / 0.8) * s.aim;
    this.nYaw += -this.nYaw * dt / 0.8 + k * gauss(this.rand);
    this.nPitch += -this.nPitch * dt / 0.8 + k * gauss(this.rand);
    this.boostOn = false;                                   // re-decided every tick by the state below

    if (this.passive) { this.want.copy(this.dir).setY(0).normalize(); this.speed = this.cruise; this.urgency = 0.3; return; }
    if (this.state === 'flee') { this.flee(); this.avoid(); return; }
    const tgt = this.pickTarget();
    if (!tgt) { this.setBreath(false); this.loiter(); this.avoid(); return; }
    const T = sys.perceive(tgt, s.react, this._seen || (this._seen = {}));   // seen `react` s ago, extrapolated
    const fwd = pathOf(d, this._fwd);
    const rel = this._rel.subVectors(T.pos, d.pos);
    const dist = Math.max(1, rel.length());
    const los = this._los.copy(rel).divideScalar(dist);
    const cosOff = fwd.dot(los);
    this._right.crossVectors(fwd, UP).normalize();      // world-ish right (model right is −X)
    // Is the target on my tail and pointing at me?
    const aimAtMe = -T.aim.dot(los);
    const onTail = dist < 260 && cosOff < -0.2 && aimAtMe > Math.cos(15 * DEG);
    const breathThreat = dist < 90 && aimAtMe > Math.cos(18 * DEG) && T.breathing;
    this.tailT = onTail || breathThreat ? this.tailT + dt : Math.max(0, this.tailT - dt * 1.5);
    this.checkProjectiles();
    // Mercy rule: sitting on the player's six for more than 5 s → deliberately overshoot.
    const onSix = dist < 160 && cosOff > 0.8 && T.fwd.dot(los) > 0.6;
    this.sixT = onSix ? this.sixT + dt : Math.max(0, this.sixT - dt);

    this.updateCloud(dt);
    const forced = this.forced();
    const canEvade = !forced && this.state !== 'evade' && this.state !== 'patrol' && this.state !== 'reversal' && this.t - (this.lastReversalT ?? -99) > 4;
    if (canEvade && this.tailT > s.evadeDelay * (this.hunter ? 2 : 1) && this.team === 'enemy') this.setState('evade');
    if (forced && this.state === 'evade') this.setState('engage');
    // Bank limit for steer (coordinated: past it the pilot gives up turn rate): ≤ 58° while circling, patrolling,
    // regrouping, extending or zooming (no model-on-a-rod orbits at 70–90°); a rider that is attacking (token) or
    // evading turns with the airframe's full authority — it has to come round quickly.
    const attacking = this.state === 'attack' || this.state === 'evade' || this.state === 'break' || this.state === 'reversal' || (this.state === 'engage' && this.token);
    this.bankMax = attacking ? null : 58;

    switch (this.state) {
      case 'patrol': {
        if (this.leader && this.leader.alive) this.holdSlot(this.leader);
        else { this.want.copy(los).setY(los.y * 0.3).normalize(); this.speed = this.cruise * s.speedMul; this.urgency = 0.45; }
        const alert = this.patrolMax < 3 ? s.detect : 600;   // a long patrol breaks formation only when the player closes in
        if (this.stateT > this.patrolMax || (dist < alert && this.stateT > 0.3)) this.setState('engage');
        break;
      }
      case 'engage': {
        if (!this.token) this.token = forced || sys.requestToken(this);
        if (!this.token) { this.wheel(T, dist, fwd); break; }
        // The first run(s) after spawning start from the player's front sector (Pilot.frontRuns).
        const front = this.frontRuns > 0 && this.team === 'enemy';
        if (front && !this.frontSetup(T, dist, fwd, los)) break;
        if (!front) {
          if (dist > 450) this.pursue(T, 'pure', dist);
          else this.pursue(T, 'lead', dist);
          const receding = T.fwd.dot(los) > 0.5;             // the target flies away from me
          // survival: a player who runs (pressure) or an Interceptor gets chased on the boost from closer in
          const chase = this.hunter || sys.pressure > 0.5;
          this.boostOn = dist > (receding ? (chase ? 220 : 380) : s.boost > 0.3 ? 650 : 1000);
        }
        const busy = sys.titanBusy() && this.team === 'enemy';
        // Pick the next attack once per approach: a breath run (close to flame range) or a fireball pass (150-470 m).
        if (!this.nextAttack) this.nextAttack = this.rand() < s.breathPref ? 'breath' : 'fireball';
        if (!busy && dist < 470 && cosOff > Math.cos(35 * DEG)) {
          let began = false;
          if (this.nextAttack === 'fireball' && this.fbCd <= 0 && dist > 150) { this.mode = 'fireball'; this.fbShots = 0; this.setState('attack'); began = true; }
          else if (this.nextAttack === 'breath' || dist < 200) { this.beginRun(); began = true; }
          if (began && front) { this.frontRuns = Math.max(0, this.frontRuns - 1); this.frontT = 0; this.frontFirst = false; this.stats.frontRuns = (this.stats.frontRuns || 0) + 1; }
        }
        // A turning fight that never gives a shot (a Lufbery circle): break it with a high yo-yo or by extending —
        // a bring-in after 5 s (run 2: the last rider of wave 3 circled 27–75 m from Sora for 40 s without a shot).
        if (!front && this.state === 'engage' && this.stateT > (forced ? Math.min(5, this.stuckAt) : this.stuckAt)) {
          this.setState(forced || this.rand() >= 0.55 ? 'extend' : 'yoyo');
        }
        break;
      }
      case 'yoyo': {
        // High yo-yo: pull up out of the circle (speed into height), then roll over and dive back in on the target.
        if (this.stateT < this.yoyoUp) {
          this.want.copy(fwd).setY(0).normalize().addScaledVector(los, 0.25).setY(0.62).normalize();
          this.speed = this.cruise * s.attackMul; this.urgency = 0.6;
        } else { this.pursue(T, 'lead', dist); this.urgency = 0.85; }
        if (this.stateT > this.yoyoUp + 3.5 || (this.stateT > this.yoyoUp && dist < 420 && cosOff > Math.cos(30 * DEG))) {
          this.setState('engage'); this.stuckAt = 14;       // the dive ends in an attack: engage picks it at once
        }
        break;
      }
      case 'attack': {
        if (this.mode === 'fireball') this.attackFireball(T, dist, fwd);
        else this.attackBreath(T, dist, fwd);
        if (this.sixT > 5) { this.sixT = 0; this.setState('break'); }
        break;
      }
      case 'break': {
        this.want.copy(this.breakDir);
        this.speed = this.cruise * s.attackMul; this.urgency = 1;
        this.boostOn = this.stateBoost && this.stateT < 1.2;
        if (this.stateT > this.breakDur) this.setState('extend');
        break;
      }
      case 'extend': {
        // Beam out (across the line of sight) rather than straight away: distance opens to ~220 m and the next
        // attack is a 90° turn, not a 180° one that bleeds all the energy.
        const side = this._tmp.crossVectors(los, UP);
        if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
        side.normalize();
        if (side.dot(fwd) < 0) side.negate();
        this.want.copy(side).addScaledVector(los, -0.35).addScaledVector(fwd, 0.4).setY(0.05).normalize();
        this.speed = this.cruise * s.attackMul; this.urgency = 0.5;
        if (dist > 220 || this.stateT > (forced ? 3 : 2.5)) {
          if (!forced) sys.releaseToken(this);
          // A bring-in comes straight round again; otherwise rejoin the leader first when it is far.
          this.setState(!forced && this.leader && this.leader.alive && this.leader.dragon.pos.distanceTo(d.pos) > 160 ? 'regroup' : 'engage');
        }
        break;
      }
      case 'evade': {
        this.evade(T, dist, fwd, dt);
        if (this.tailT <= 0) this.calmT += dt; else this.calmT = 0;
        if (this.calmT > 1.2 && this.stateT > 1.5) { this.calmT = 0; this.setState('engage'); }
        // Never run for long: after a few seconds turn hard INTO the attacker (a defensive reversal) and fight back;
        // a rider that opened more than ~380 m turns back as well (no chasing a speck across the sky).
        else if (this.stateT > this.evadeFor || dist > 380) this.reversal(los, fwd);
        break;
      }
      case 'reversal': {
        this.want.copy(this.breakDir);
        this.speed = this.cruise * s.attackMul; this.urgency = 1;
        if (this.stateT > 1.6 || fwd.dot(los) > 0.5) { this.tailT = 0; this.setState('engage'); }
        break;
      }
      case 'regroup': {
        if (this.leader && this.leader.alive) this.holdSlot(this.leader); else this.setState('engage');
        if (this.stateT > 4 || (this.leader && this.leader.dragon.pos.distanceTo(d.pos) < 70)) this.setState('engage');
        break;
      }
      case 'idle': this.loiter(); break;
    }
    this.manageEnergy();
    this.avoid();
  }

  /** Energy: the same physics as the player, so turning and climbing bleed speed. Near the minimum speed a pilot
   *  eases the turn, lowers the nose to trade height for speed and beats harder; climbs are limited by speed. */
  manageEnergy() {
    const d = this.dragon, w = this.want;
    const v = speedOf(d);
    const vmin = d.body?.spec?.pilot?.minSpeed ?? 24;
    const maxClimb = clamp((v - vmin) / 50, 0.1, 0.6);
    if (w.y > maxClimb) { w.y = maxClimb; w.normalize(); }
    // Recovery: below ~min speed + 7 stop pulling the turn (bend the course toward the current velocity), lower the
    // nose and beat; resume once the speed is back. Turning hard while slow is what stalls a heavy flier.
    const k = clamp((vmin + 7 - v) / 7, 0, 1);
    if (k > 0 && d.vel) {
      const vh = _e1.copy(d.vel).setY(0);
      if (vh.lengthSq() > 1) {
        vh.normalize();
        const wy = w.y;
        w.setY(0).normalize().lerp(vh, k * 0.85).normalize().multiplyScalar(Math.sqrt(Math.max(0, 1 - wy * wy)));
        w.y = wy;
      }
      w.y = lerp(w.y, -0.32, k); w.normalize();
      this.urgency *= 1 - 0.75 * k;
      if (k > 0.3 && (d.stamina ?? 1) > 0.4) this.boostOn = true;
    }
  }

  // Lead or pure pursuit on the perceived target (with aim noise). kind: 'pure' | 'lead' | 'flame'
  pursue(T, kind, dist) {
    const d = this.dragon, s = this.skill;
    if (kind === 'pure') this.want.subVectors(T.pos, d.pos).normalize();
    else {
      const dp = this._tmp.subVectors(T.pos, d.pos);
      const dv = this._aim.subVectors(T.vel, d.vel || T.vel);
      const muzzle = kind === 'flame' ? this.sys.flameSpeed() : Math.max(20, speedOf(d) * 0.9);
      const t = intercept(dp, dv, muzzle, this._lead);
      if (t > 0 && t < 6) this.want.copy(this._lead).normalize(); else this.want.copy(dp).normalize();
    }
    this.leadDir.copy(this.want);
    this.applyNoise(this.want, 1);
    const tSpeed = speedOf(T);
    // Far: hurry in; close: match speed with a little closure so the run does not overshoot. A target flying away
    // from beyond 300 m gets the full chase speed (a tail chase at +10 m/s was minutes of nothing).
    const closure = dist > 400 ? 1.3 : dist > 160 ? 1.12 : 1.0;
    // Survival: the pressure on a player who stops fighting (0..1) and the Interceptors chase up to +15 % / +20 %
    // faster, up to the player's own boost speed (62 m/s) and a little past it (story: pressure 0, no hunters).
    const pr = this.team === 'enemy' ? clamp(Number.isFinite(this.sys.pressure) ? this.sys.pressure : 0, 0, 1) : 0;
    const hurry = 1 + 0.15 * pr + (this.hunter ? 0.2 : 0);
    const vmax = MAX_AI_SPEED * (1 + 0.1 * Math.max(pr, this.hunter ? 1 : 0));
    const top = this.cruise * s.attackMul * 1.2;          // the story's ceiling (unchanged when hurry = 1)
    const upper = hurry > 1 ? Math.max(top, Math.min(vmax, top * hurry)) : top;
    this.speed = clamp(Math.max(this.cruise * s.speedMul, tSpeed * closure + (dist > 160 ? 6 : 3)) * hurry, 20, upper);
    const receding = T.fwd.dot(this._los.copy(T.pos).sub(d.pos).normalize()) > 0.5;
    if (receding && dist > (this.hunter || pr > 0.5 ? 200 : 300)) this.speed = vmax;
    this.urgency = this.hunter ? Math.max(s.urgency, 0.9) : s.urgency;
  }

  /** Get out of the player's rear before an attack run: within ±70° of its course for the first run after spawning,
   *  ±100° otherwise (a crossing lead-pursuit pass from the side ends in front of the player, in view; a tail chase
   *  from behind is what a beginner never sees), 60–560 m out, flying toward it. Returns true when in position (then
   *  `want` leads onto the target). */
  frontSetup(T, dist, fwd, los) {
    const d = this.dragon, s = this.skill;
    const forced = this.forced();
    this.frontT += 1 / BRAIN_HZ;
    // A player that outruns the setup still gets attacked, just not from the front: the first run after spawning may
    // take its time (20 s), a later one during a bring-in only 9 s.
    if (this.frontT > (forced && !this.frontFirst ? 9 : 20)) { this.frontRuns = 0; this.frontFirst = false; this.pursue(T, 'lead', dist); return true; }
    const pf = _f1.copy(T.vel).setY(0);
    if (pf.lengthSq() < 1) pf.copy(T.fwd).setY(0);
    if (pf.lengthSq() < 1e-4) pf.set(0, 0, 1);
    pf.normalize();
    const relH = _f2.subVectors(d.pos, T.pos).setY(0);
    relH.divideScalar(Math.max(1, relH.length()));
    const cosB = pf.dot(relH);                              // 1 = dead ahead of the player
    const cone = Math.cos((this.frontFirst ? 70 : 100) * DEG);
    const inFront = cosB > cone && dist > 60 && dist < 560;
    if (inFront && fwd.dot(los) > 0.35) { this.pursue(T, 'lead', dist); return true; }
    if (inFront) {
      // Ahead of the player but not facing it: turn in (a wide, visible turn across its view).
      this.want.copy(los).setY(los.y * 0.5).normalize();
      this.speed = this.cruise * s.attackMul; this.urgency = 0.7;
      return false;
    }
    // Overtake on my own side, wide, to a point ~300 m ahead of the player and a little above it.
    const right = _f3.crossVectors(pf, UP).normalize();
    const side = Math.sign(right.dot(relH)) || this.runSide;
    const goal = _f4.copy(T.pos).addScaledVector(pf, 280 + speedOf(T) * 2).addScaledVector(right, side * 150);
    goal.y = T.pos.y + 30 + this.sys.altBias(T.pos.y) * 0.5;
    this.want.subVectors(goal, d.pos).normalize();
    this.speed = MAX_AI_SPEED; this.urgency = 0.7;
    this.boostOn = (d.stamina ?? 1) > 0.4 && cosB < 0.5;
    return false;
  }

  attackFireball(T, dist, fwd) {
    const d = this.dragon, s = this.skill, sys = this.sys;
    const aim = this.fireballAim(T);
    this.want.copy(aim);
    this.applyNoise(this.want, 0.6);
    this.speed = Math.max(this.cruise * s.speedMul, speedOf(T) + 4); this.urgency = s.urgency;
    // Gate on the flight path (the head turns the last few degrees; the nose rides above the path by the AoA).
    const off = Math.acos(clamp(pathOf(d, this._fwd).dot(aim), -1, 1));
    // Shots at a target flying away only from ≤ 340 m (from farther they only ever fell short or wide).
    const maxShot = T.fwd.dot(this._los) > 0.5 ? 340 : 520;
    if (this.fbGap <= 0 && off < 18 * DEG && dist > 110 && dist < maxShot && !sys.titanBusy()) {
      const shot = aim.clone();
      this.applyNoise(shot, s.fbError * this.aimMul);
      sys.fireball(this, shot);
      this.fbShots++; this.fbGap = 0.6; this.stats.shots++;
    }
    if (this.fbShots >= s.fbShots) {
      this.fbCd = s.fbCd * (0.8 + this.rand() * 0.4);
      if (dist < 180 && fwd.dot(this._los) > 0.6) this.toBreathRun();   // only if the target is still ahead
      else if (dist < 260) this.setState('break');
      else this.setState('engage');
    } else if (this.stateT > 4) this.setState('engage');
  }

  beginRun() {
    this.setState('attack');
    this.toBreathRun();
  }
  toBreathRun() {
    this.mode = 'breath'; this.bursts = 0; this.breathT = 0; this.runClose = 0; this.stateT = 0;
    this.runSide = this.rand() < 0.5 ? -1 : 1;
    this.stateBoost = this.rand() < this.skill.boost + 0.35;
  }

  /** Breath run: close fast with lead on the flame, pass head-on with a side offset (never ram), burst in the cone. */
  attackBreath(T, dist, fwd) {
    const d = this.dragon, s = this.skill, sys = this.sys;
    const headOn = T.fwd.dot(this._los) < -0.4;          // the target flies toward me
    this.pursue(T, 'flame', dist);
    if (headOn && dist < 260) {
      // Aim a little to one side of the target's nose: the flame still sweeps it, the bodies do not collide.
      const side = this._tmp.crossVectors(this._los, UP);
      if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
      this.want.multiplyScalar(dist).addScaledVector(side.normalize(), 11 * this.runSide).normalize();
    }
    const tv = speedOf(T);
    const closing = -this._aim.subVectors(T.vel, d.vel).dot(this._los);
    this.runClose = closing > 6 ? 0 : this.runClose + 1 / BRAIN_HZ;
    // Close fast (boosting when the skill allows), but never faster than the player's boost (≈ 70 m/s): fair.
    // The flame reaches ~40-45 m in a tail chase (drag), so keep closing until then; then hold a small overtake.
    // (A hovering player — the player's new hover mode — is nearly still: never ask to slow to walking pace close to
    // it, a rider that cannot hover would flare into a stall; it keeps flying and passes.)
    this.speed = dist > 45 ? Math.min(MAX_AI_SPEED, Math.max(this.cruise * s.attackMul, tv + 16)) : Math.max(tv + 4, this.cruise * 0.85);
    const chase = !headOn && closing < 12 && dist > 60;         // tail chase that is not closing: beat hard
    this.boostOn = (this.stateBoost || chase) && dist > 60 && this.speed > speedOf(d) + 6 && (d.stamina ?? 1) > 0.45;
    // Turn the head onto the lead point (the neck aims the flame within its range, like the player's gaze).
    if ('lookTarget' in d) { this.mouthPoint(this.lookPoint).addScaledVector(this.leadDir, Math.min(dist, 80)); d.lookTarget = this.lookPoint; }
    const range = sys.breathRange();
    const inCone = dist < range * 2.2 && this.flameWouldHit(T);
    this.flameMiss = inCone ? 0 : (this.flameMiss || 0) + 1 / BRAIN_HZ;
    if (this.breathOn) {
      this.breathT += 1 / BRAIN_HZ;
      // A burst lasts its length while the flame can still reach; it stops once the prediction misses for 0.3 s.
      if (this.breathT > s.burst || (this.breathT > 0.4 && this.flameMiss > 0.3) || sys.titanBusy() || d.overheated) {
        this.setBreath(false); this.breathCd = s.breathCd; this.bursts++; this.stats.bursts++;
      }
    } else if (inCone && this.breathCd <= 0 && !sys.titanBusy() && d.canBreathe !== false) { this.breathT = 0; this.setBreath(true); }
    const tooClose = dist < (headOn ? 18 : 26) || (fwd.dot(this._los) < 0 && dist > 30 && this.stateT > 0.3);   // passed
    const stale = this.runClose > 3 && dist > 120;
    const timeout = this.stateT > (this.runClose < 0.5 && dist < 200 ? 10 : 7);
    if (tooClose || (this.bursts >= 1 && !this.breathOn && this.rand() < 0.4) || timeout || (dist > 300 && this.stateT > 2.5) || stale) {
      if (stale && this.fbCd <= 0 && dist < 470) { this.mode = 'fireball'; this.fbShots = 0; this.stateT = 0; }
      else this.setState('break');
    }
  }

  /** Would a flame packet leaving the mouth now touch the target? The fire system's closed form: world velocity
   *  = mouth dir × muzzle + dragon velocity, linear drag on all of it, buoyancy up; damage only within maxRange of
   *  the (moving) mouth; packet radius r0 + rK·distance. Sampled over the packet's life. */
  flameWouldHit(T) {
    const d = this.dragon, cfg = this.game.fx?.config?.breath || {};
    const muzzle = cfg.muzzle ?? ENEMY_WEAPONS.flameSpeed, k = cfg.drag ?? 0.6, gy = cfg.buoyancy ?? 3, life = cfg.life ?? 1.1;
    const range = cfg.maxRange ?? ENEMY_WEAPONS.breathRange, r0 = cfg.hitRadius0 ?? 0.8, rK = cfg.hitRadiusK ?? 0.2;
    const m0 = this.mouthPoint(_h4), dir = this.mouthDirection(_h5);
    const dv = d.vel || T.vel;
    const v0 = _h1.copy(dv).addScaledVector(dir, muzzle);
    let best = Infinity, bestT = 0;
    for (let i = 1; i <= 10; i++) {
      const t = (life * i) / 10;
      const E = (1 - Math.exp(-k * t)) / k, tme = (t - E) / k;
      const px = m0.x + v0.x * E, py = m0.y + v0.y * E + gy * tme, pz = m0.z + v0.z * E;
      const fromMouth = Math.hypot(px - (m0.x + dv.x * t), py - (m0.y + dv.y * t), pz - (m0.z + dv.z * t));
      if (fromMouth > range) break;
      const miss = Math.hypot(px - (T.pos.x + T.vel.x * t), py - (T.pos.y + T.vel.y * t), pz - (T.pos.z + T.vel.z * t))
        - (r0 + rK * fromMouth) - 2.5;
      if (miss < best) { best = miss; bestT = t; }
    }
    if (this.game.debugMode) this.dbg = { miss: +best.toFixed(1), t: +bestT.toFixed(2) };
    return best < 0;
  }

  /** Defensive reversal: turn toward the side the attacker sits on (it overshoots or meets us nose to nose). */
  reversal(los, fwd) {
    const lateral = this.breakDir.copy(los).addScaledVector(fwd, -fwd.dot(los));
    if (lateral.lengthSq() < 1e-4) lateral.crossVectors(fwd, UP).multiplyScalar(this.rand() < 0.5 ? -1 : 1);
    lateral.normalize().multiplyScalar(0.9).addScaledVector(fwd, 0.25).addScaledVector(UP, 0.15).normalize();
    this.setState('reversal');
    this.lastReversalT = this.t;
    this.stateBoost = false;
    if (this.rand() < this.skill.rollDodge) this.queueDodge(Math.sign(lateral.dot(this._right.crossVectors(fwd, UP))) || 1, 0.1);
  }

  enterBreak() {
    const d = this.dragon, s = this.skill;
    const fwd = forwardOf(d, this._fwd);
    const right = this._right.crossVectors(fwd, UP);
    if (right.lengthSq() < 1e-4) right.set(1, 0, 0);
    right.normalize();
    const side = this.rand() < 0.5 ? -1 : 1;
    const high = d.pos.y - this.sys.floorAt(d.pos.x, d.pos.z);
    const vertical = high > 500 && this.rand() < 0.45 ? -0.45 : 0.35;  // split-S style dive or a climbing break
    this.breakDir.copy(right).multiplyScalar(0.9 * side).addScaledVector(UP, vertical).addScaledVector(fwd, 0.3).normalize();
    this.breakDur = 1.2 + this.rand() * 0.8;
    this.stateBoost = this.rand() < s.boost + 0.25;
    this.setBreath(false);
  }

  evade(T, dist, fwd, dt) {
    const s = this.skill, d = this.dragon;
    this.jinkT -= dt;
    if (this.jinkT <= 0) {
      this.jinkT = s.jink[0] + this.rand() * (s.jink[1] - s.jink[0]);
      const right = this._right.crossVectors(fwd, UP).normalize();
      const side = this.rand() < 0.5 ? -1 : 1;
      this.jinkDir.copy(right).multiplyScalar(side).addScaledVector(UP, (this.rand() - 0.45) * 0.9).normalize();
      if (this.rand() < s.rollDodge) this.queueDodge(side, s.react * 0.5);
    }
    if (s.weave) {
      // Rookies panic predictably: a wide S-weave a good pilot can follow.
      const right = this._right.crossVectors(fwd, UP).normalize();
      this.want.copy(fwd).addScaledVector(right, Math.sin(this.stateT * 1.7 + this.id) * s.jinkAmt).addScaledVector(UP, 0.1).normalize();
    } else if (this.cloudGoal && this.cloudIn < 4 && this.cloudDen < 0.35 && this.cloudGoal.distanceTo(d.pos) > 40) {
      this.want.subVectors(this.cloudGoal, d.pos).normalize().addScaledVector(this.jinkDir, 0.35).normalize();
    } else {
      if (this.cloudGoal && this.cloudIn >= 4) this.cloudGoal = null;   // 4 s inside is enough: out into clear air
      this.want.copy(fwd).addScaledVector(this.jinkDir, s.jinkAmt).normalize();
    }
    this.speed = this.cruise * s.attackMul; this.urgency = 1;
    this.boostOn = this.stateBoost && this.stateT < 2;
  }

  /** Non-token riders circle the fight 240–320 m out and sometimes cut across the player's nose (bait passes). */
  wheel(T, dist, fwd) {
    const d = this.dragon, s = this.skill, sys = this.sys;
    const step = 1 / BRAIN_HZ;
    this.crossT -= step; this.repoT -= step;
    if (this.crossing > 0) {
      this.crossing -= step;
      this.want.subVectors(this.crossPoint, d.pos);
      if (this.want.length() < 40) this.crossing = 0;
      this.want.normalize();
      this.speed = this.cruise * s.attackMul; this.urgency = 0.8;
      // Taunt: a show-off roll (and a screech) right across the player's nose, once per pass.
      if (!this.taunted && dist < 260 && sys.tauntReady()) {
        this.taunted = true;
        this.queueDodge(this.rand() < 0.5 ? -1 : 1, 0.05);
        sys.taunt(this, 0.55);
      }
      return;
    }
    if (this.crossT <= 0) {
      this.crossT = 8 + this.rand() * 5; this.crossing = 4; this.taunted = false;
      const tr = this._tmp.crossVectors(T.fwd, UP).normalize();
      this.crossPoint.copy(T.pos).addScaledVector(T.fwd, 150 + this.rand() * 60).addScaledVector(tr, (this.rand() - 0.5) * 80).y += 10;
      return;
    }
    // Reposition: a new ring, height and direction every 7-12 s.
    if (this.repoT <= 0) {
      this.repoT = 7 + this.rand() * 5;
      this.wheelR = 220 + this.rand() * 120; this.wheelDy = -50 + this.rand() * 170;
      if (this.rand() < 0.35) this.wheelSign = -this.wheelSign;
    }
    const R = this.wheelR;
    // Ring centre: the player, or — while this rider's first run is still due — a point ahead of it, with the orbit
    // angle held inside the front sector (±70° of its course): a rider that will attack from the front waits where
    // a beginner can see it, sweeping back and forth across the view.
    // After the first run the sector widens to ±100° (the forward half and a bit): circling riders stay where the
    // chase camera can find them instead of parking behind the player.
    const front = this.frontRuns > 0 && this.team === 'enemy';
    const sector = this.team === 'enemy';
    const pf = _f1.copy(T.vel).setY(0);
    if (pf.lengthSq() < 1) pf.copy(T.fwd).setY(0);
    if (pf.lengthSq() < 1e-4) pf.set(0, 0, 1);
    pf.normalize();
    const lead = sector ? speedOf(T) * (front ? 2.5 : 1.5) : 0;
    const cx = T.pos.x + pf.x * lead, cz = T.pos.z + pf.z * lead;
    const off = this._tmp.set(d.pos.x - cx, 0, d.pos.z - cz);
    const r = Math.max(1, off.length());
    let ang = Math.atan2(off.z, off.x) + this.wheelSign * 0.45;
    if (sector) {
      const head = Math.atan2(pf.z, pf.x), lim = (front ? 70 : 100) * DEG;
      let rel = Math.atan2(Math.sin(ang - head), Math.cos(ang - head));
      if (Math.abs(rel) > lim) {
        if (Math.sign(rel) === Math.sign(this.wheelSign)) this.wheelSign = -this.wheelSign;   // sweep back
        rel = Math.sign(rel) * lim;
      }
      ang = head + rel;
    }
    const goal = this._aim.set(cx + Math.cos(ang) * R, T.pos.y + this.wheelDy * 0.6 + this.sys.altBias(T.pos.y) + Math.sin(this.t * 0.4 + this.id) * 40, cz + Math.sin(ang) * R);
    this.want.subVectors(goal, d.pos).normalize();
    this.speed = clamp(speedOf(T) + 4, this.cruise, this.cruise * s.attackMul); this.urgency = 0.7;
    if (r > 600) this.want.subVectors(T.pos, d.pos).normalize();
    else this.manoeuvre(fwd, step, r);
    // Potshots from the wheel keep the pressure on without breaking the two-attacker rule; one shared limiter keeps a
    // big wave from turning the sky into a bullet hell.
    const cosOff = pathOf(d, this._fwd).dot(this._los);
    // No potshots from behind the player before this rider's first front run (a beginner cannot see them coming).
    const behind = front && _f2.subVectors(d.pos, T.pos).dot(pf) < -0.3 * dist;
    const cone = Number.isFinite(sys.potshotCone) ? clamp(sys.potshotCone, 5, 45) : 20;
    if (!behind && this.fbCd <= 0 && dist > 160 && dist < 450 && cosOff > Math.cos(cone * DEG) && !sys.titanBusy() && sys.potshotReady()) {
      const aim = this.fireballAim(T);
      this.applyNoise(aim, s.fbError * 1.3 * this.aimMul);
      sys.fireball(this, aim.clone());
      this.stats.shots++;
      this.fbCd = s.fbCd * 1.8;
    }
  }

  /** Variety while circling: level legs, zoom climbs traded back into dives, reversals and the odd roll, instead of
   *  one constant-bank orbit (critics: 84 % of an engagement at ≥ 60° bank, "a model on a rod"). Bends `want`. */
  manoeuvre(fwd, step, r) {
    this.mnvT -= step;
    const d = this.dragon, s = this.skill;
    if (this.mnvT <= 0) {
      const x = this.rand();
      const kind = x < 0.3 ? 'orbit' : x < 0.55 ? 'level' : x < 0.72 ? 'climb' : x < 0.82 ? 'dive' : x < 0.94 ? 'reverse' : 'roll';
      this.mnv = kind; this.mnvT = 3 + this.rand() * 3;
      this.mnvDir.copy(fwd).setY(0);
      if (this.mnvDir.lengthSq() < 1e-4) this.mnvDir.set(0, 0, 1);
      this.mnvDir.normalize();
      if (kind === 'reverse') { this.wheelSign = -this.wheelSign; this.mnv = 'orbit'; }
      else if (kind === 'roll') { this.queueDodge(this.rand() < 0.5 ? -1 : 1, 0.1); this.mnv = 'level'; this.mnvT = 2.5; }
      else if (kind === 'climb') this.mnvT = 2.2 + this.rand() * 1.2;
      else if (kind === 'dive') this.mnvT = 1.8 + this.rand();
    }
    const vmin = d.body?.spec?.pilot?.minSpeed ?? 24;
    switch (this.mnv) {
      case 'level':                                   // wings level: hold the heading, drift back toward the ring
        { const wy = this.want.y; this.want.setY(0).normalize().multiplyScalar(0.25).add(this.mnvDir).normalize(); this.want.y = wy * 0.3; this.want.normalize(); }
        this.urgency = 0.4;
        if (r > 480) this.mnvT = 0;
        break;
      case 'climb':                                   // zoom climb: speed into height…
        this.want.copy(this.mnvDir).setY(0.6).normalize();
        this.speed = this.cruise * s.attackMul; this.urgency = 0.5;
        if (speedOf(d) < vmin + 9) this.mnvT = 0;
        if (this.mnvT <= step) { this.mnv = 'dive'; this.mnvT = 1.6 + this.rand() * 0.8; }   // …and back into speed
        break;
      case 'dive':                                    // a diving pass on the ring: height back into speed (a glide)
        this.want.setY(0).normalize().setY(-0.42).normalize();
        this.speed = this.cruise; this.urgency = 0.55;
        if (d.pos.y < this.sys.floorAt(d.pos.x, d.pos.z) + 350) this.mnvT = 0;
        break;
      default: break;                                 // orbit: the ring as computed
    }
  }

  fireballAim(T) {
    const d = this.dragon, s = this.skill;
    const dp = this._tmp.subVectors(T.pos, this.mouthPoint(_h4));
    const dv = this._aim.subVectors(T.vel, d.vel);
    const t = intercept(dp, dv, s.fbSpeed, this._lead);
    if (t > 0) { this._lead.y += 0.5 * this.sys.fbGravity * t * t; this._lead.normalize(); } else this._lead.copy(dp).normalize();
    return this._lead;
  }

  holdSlot(leader) {
    const L = leader.dragon;
    const lf = forwardOf(L, this._tmp);
    const lr = this._right.crossVectors(lf, UP).normalize();
    const slot = this._aim.copy(L.pos).addScaledVector(lr, 38 * (this.slot || 1)).addScaledVector(lf, -26).addScaledVector(UP, 6);
    const to = this._lead.subVectors(slot, this.dragon.pos);
    const along = to.dot(lf);
    // Aim at a point ahead of the slot so the wingman converges smoothly instead of chasing it.
    this.want.copy(slot).addScaledVector(lf, 60).sub(this.dragon.pos).normalize();
    this.speed = clamp(speedOf(L) + clamp(along * 0.25, -10, 14), 20, 80);
    this.urgency = 0.5;
  }

  loiter() {
    const d = this.dragon;
    const off = this._tmp.subVectors(d.pos, this.anchor); off.y = 0;
    const ang = Math.atan2(off.z, off.x) + 0.5;
    this.want.set(this.anchor.x + Math.cos(ang) * 300 - d.pos.x, this.anchor.y - d.pos.y, this.anchor.z + Math.sin(ang) * 300 - d.pos.z).normalize();
    this.speed = this.cruise; this.urgency = 0.4;
  }

  flee() {
    const p = this.sys.playerDragon();
    const d = this.dragon;
    if (p) this.want.subVectors(d.pos, p.pos).setY(0).normalize().addScaledVector(UP, 0.35).normalize();
    this.speed = this.cruise * this.skill.attackMul; this.urgency = 0.6; this.boostOn = this.stateT < 2;
    this.setBreath(false);
  }

  applyNoise(v, scale) {
    if (scale <= 0) return v;
    const right = _n1.crossVectors(v, UP);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    const up = _n2.crossVectors(right, v).normalize();
    v.addScaledVector(right, Math.tan(this.nYaw * scale)).addScaledVector(up, Math.tan(this.nPitch * scale)).normalize();
    return v;
  }

  queueDodge(side, delay) { this.dodgeQueue.push({ side, t: delay }); }

  /** Incoming fireballs: closest approach t* and miss distance → a dodge roll away from the path (skill-gated). */
  checkProjectiles() {
    const d = this.dragon, s = this.skill;
    for (const inc of this.sys.incoming) {
      if (inc.team === this.team || this.reacted.has(inc.p)) continue;
      const pp = inc.p.pos || inc.p.position, pv = inc.p.vel || inc.p.velocity;
      if (!pp || !pv) continue;
      const dp = this._tmp.subVectors(d.pos, pp), dv = this._aim.subVectors(d.vel, pv);
      const vv = dv.lengthSq(); if (vv < 1) continue;
      const ts = -dp.dot(dv) / vv;
      if (ts <= 0 || ts > 1.4) continue;
      const miss = this._lead.copy(dp).addScaledVector(dv, ts);
      if (miss.length() > (inc.r || 1.5) + 12) continue;
      this.reacted.add(inc.p);
      if (this.rand() > s.dodge) continue;
      const fwd = forwardOf(d, this._fwd);
      const right = this._right.crossVectors(fwd, UP).normalize();
      const side = miss.lengthSq() > 1 ? Math.sign(miss.dot(right)) || 1 : (this.rand() < 0.5 ? -1 : 1);
      this.queueDodge(side, Math.max(0.05, Math.min(s.react, ts - 0.35)));
      this.stats.dodges++;
    }
  }

  findCloud() {
    const w = this.game.world, d = this.dragon;
    let best = null, bestD = 0.45;
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2, r = 180 + (i % 3) * 110;
      const x = d.pos.x + Math.cos(a) * r, z = d.pos.z + Math.sin(a) * r, y = d.pos.y - 60 - (i % 2) * 120;
      const den = w.cloudDensity(x, y, z) || 0;
      if (den > bestD) { bestD = den; best = new THREE.Vector3(x, y, z); }
    }
    return best;
  }

  /** Priority stack: terrain / floor > bounds > titan > separation. Bends `want` in place. */
  avoid() {
    const d = this.dragon, sys = this.sys, w = this.want, v = d.vel;
    const b = this.game.world.bounds || { radius: 9000, floor: 40, ceiling: 4200 };
    const px = d.pos.x + v.x * 3, pz = d.pos.z + v.z * 3, py = d.pos.y + v.y * 3;
    const floor = Math.max(sys.floorAt(px, pz), sys.floorAt(d.pos.x, d.pos.z)) + 160;
    if (py < floor) w.y += clamp((floor - py) / 120, 0, 2.5);
    if (d.pos.y < floor - 80) w.set(w.x * 0.3, 1, w.z * 0.3);
    if (d.pos.y > b.ceiling - 500) w.y -= clamp((d.pos.y - (b.ceiling - 500)) / 200, 0, 1.5);
    const r = Math.hypot(d.pos.x, d.pos.z);
    if (r > b.radius - 1200) { const k = clamp((r - (b.radius - 1200)) / 600, 0, 2); w.x -= (d.pos.x / r) * k; w.z -= (d.pos.z / r) * k; }
    const titan = sys.titanActor();
    if (titan) {
      const off = this._tmp.subVectors(d.pos, titan.pos);
      const dist = off.length(), keep = (titan.radius || 80) + 70;
      if (dist < keep) w.addScaledVector(off.normalize(), clamp((keep - dist) / 40, 0, 3));
    }
    // Clouds: bend out toward clear air (the way out found by updateCloud). A rider on its attack (token, attack,
    // yo-yo) or a diving drake still comes for its pass — only bent a little — and leaves right after it; everything
    // else (circling, evading after its 4 s, extending, breaking) gets out at once.
    if (this.cloudEsc.lengthSq() > 0) {
      const committed = this.state === 'attack' || this.state === 'dive' || this.state === 'spit' || this.state === 'yoyo' || (this.state === 'engage' && this.token);
      const k = committed ? 0.3 : 1;
      w.normalize().addScaledVector(this.cloudEsc, k);
    }
    for (const other of sys.dragons()) {
      if (other === d || !isAlive(other)) continue;
      const off = this._tmp.subVectors(d.pos, other.pos);
      const dist = off.length();
      if (dist > 400) continue;
      if (other === this.avoidSkip) {
        // A bite pass aims to miss by ~5 m over (or under) the target's back; this only pushes the bodies apart if
        // it comes in tighter than that (closest point on the target's hit shapes, not its centre).
        if (dist < 14 && dist > 0.1) {
          let push = 0, px = off.x / dist, py = off.y / dist, pz = off.z / dist;
          try {
            const hit = this.game.combat?.querySphere?.(d.pos, 3.4, { team: actorOf(other)?.team, exclude: this.actor })?.[0];
            if (hit) {
              push = (3.4 - Math.max(0, hit.dist)) / 1.2 + 0.6;
              const hx = d.pos.x - hit.point.x, hy = d.pos.y - hit.point.y, hz = d.pos.z - hit.point.z, hl = Math.hypot(hx, hy, hz);
              if (hl > 0.05) { px = hx / hl; py = hy / hl; pz = hz / hl; }
            }
          } catch { push = 0; }
          if (dist < 4.5) push = Math.max(push, (4.5 - dist) / 1.2 + 0.6);
          if (push > 0) { w.x += px * push; w.y += py * push; w.z += pz * push; }
        }
        continue;
      }
      if (dist < 34 && dist > 0.1) w.addScaledVector(this._aim.copy(off).divideScalar(dist), (34 - dist) / 20);
      // Predicted closest approach within 1.2 s closer than 14 m: sidestep along the miss vector. Tight on purpose:
      // head-on breath passes at 12-15 m stay possible (the flame still sweeps the target), collisions do not.
      const dv = this._aim.subVectors(d.vel, other.vel || d.vel);
      const vv = dv.lengthSq();
      if (vv < 4) continue;
      const ts = -off.dot(dv) / vv;
      if (ts <= 0 || ts > 1.2) continue;
      const miss = this._lead.copy(off).addScaledVector(dv, ts);
      const m = miss.length();
      if (m > 14) continue;
      if (m < 1) miss.crossVectors(dv, UP).normalize(); else miss.divideScalar(m);
      w.addScaledVector(miss, ((14 - m) / 10) * (1.2 - ts) * 1.5);
    }
    w.normalize();
  }

  // ---- pilot (120 Hz) --------------------------------------------------------------------------------------------
  fly(dt) {
    const d = this.dragon;
    if (!this.alive) return;
    this.brainAcc += dt;
    while (this.brainAcc >= 1 / BRAIN_HZ) { this.brainAcc -= 1 / BRAIN_HZ; this.think(1 / BRAIN_HZ); }
    // Never hand the physics a non-finite command: fall back to the flight path.
    if (!Number.isFinite(this.want.x + this.want.y + this.want.z) || this.want.lengthSq() < 1e-8) { pathOf(d, this.want); this.sys.warnOnce('want NaN ' + this.state + '/' + this.mode, this.name); }
    if (!Number.isFinite(this.dir.x + this.dir.y + this.dir.z)) this.dir.copy(this.want);
    if (!Number.isFinite(this.speed)) this.speed = this.cruise;
    if (!Number.isFinite(this.urgency)) this.urgency = 0.5;
    // Smooth the brain's 15 Hz decisions; a better pilot reacts crisper.
    this.dir.lerp(this.want, damp(this.skill.turnSmooth, dt));
    if (this.dir.lengthSq() < 1e-6) this.dir.copy(this.want);
    this.dir.normalize();
    const so = this._steerOpts || (this._steerOpts = { speed: 0, urgency: 0 });
    so.speed = this.speed; so.urgency = this.urgency;
    so.bankMax = this.bankMax || undefined;              // steer: `bankMax != null` = coordinated hard limit
    try { d.steer(this.dir, so); } catch (e) { this.sys.warnOnce('steer', e); }
    const c = d.controls;
    if (!c) return;
    c.breath = this.breathOn;
    c.fireball = false;                  // AI fireballs are aimed and launched by the system (lead + error)
    if (this.boostOn && (d.stamina ?? 1) > 0.35) c.boost = true;
    if (this.diveOn) c.dive = true;
    let edge = 0;
    for (let i = this.dodgeQueue.length - 1; i >= 0; i--) {
      const q = this.dodgeQueue[i];
      q.t -= dt;
      if (q.t <= 0) { edge = q.side; this.dodgeQueue.splice(i, 1); }
    }
    c.dodge = edge;
  }
}
const _n1 = new THREE.Vector3(), _n2 = new THREE.Vector3();
const _c1 = new THREE.Vector3(), _c2 = new THREE.Vector3(), _c3 = new THREE.Vector3();
const _f1 = new THREE.Vector3(), _f2 = new THREE.Vector3(), _f3 = new THREE.Vector3(), _f4 = new THREE.Vector3(), _f5 = new THREE.Vector3();
const _h1 = new THREE.Vector3(), _h2 = new THREE.Vector3(), _h3 = new THREE.Vector3(), _h4 = new THREE.Vector3(), _h5 = new THREE.Vector3();
const _m1 = new THREE.Vector3(), _e1 = new THREE.Vector3(), _m2 = new THREE.Vector3(), _m3 = new THREE.Vector3();
function gauss(r) { return Math.sqrt(-2 * Math.log(Math.max(1e-9, r()))) * Math.cos(2 * Math.PI * r()); }

// ---------------------------------------------------------------------------------------------------------------
// Shade Drakes. A Flock brain (15 Hz) moves a goal point around the player (orbit, repositioning, screech taunts)
// and, while it holds the flock attack token, sends its members in one by one: a bite / claw pass or a spit. Every
// drake is a DrakePilot (a Pilot with its own brain) flying boids toward its slot around that goal through the same
// Dragon physics as everyone else (steer() only). Drakes scatter from the player's breath; a kill makes the
// neighbours panic too.
// ---------------------------------------------------------------------------------------------------------------
let nextFlockId = 1;
class Flock {
  constructor(sys, o = {}) {
    this.id = nextFlockId++;
    this.sys = sys; this.game = sys.game;
    this.tag = o.tag ?? null;
    this.dmgMul = Number.isFinite(o.dmgMul) && o.dmgMul > 0 ? o.dmgMul : 1;   // survival scaling of its members
    this.members = [];
    this.rand = rng(o.seed ?? (this.id * 104729 + 3));
    this.state = 'circle'; this.stateT = 0;
    this.token = false;
    this.tokenCd = 2 + this.rand() * 2.5;                // the first attack comes soon after the flock arrives
    this.theta = 0; this.sign = this.rand() < 0.5 ? -1 : 1;
    this.R = lerp(DRAKE.orbitR[0], DRAKE.orbitR[1], this.rand()); this.alt = lerp(DRAKE.orbitAlt[0], DRAKE.orbitAlt[1], this.rand());
    this.repoT = 6 + this.rand() * 4;
    this.goal = new THREE.Vector3(); this.center = new THREE.Vector3(); this.avgVel = new THREE.Vector3();
    this.diveT = 0; this.dived = new Set(); this.cycles = 0;
    this.started = false;
    // The flock's first dives come from ahead / beside the player, and every drake's own first one (frontDives);
    // survival's later waves turn both off: then drakes dive from wherever they are, behind included.
    this.firstDives = Number.isFinite(o.firstDives) ? Math.max(0, o.firstDives) : 2;
    this.frontDives = o.frontDives !== false;
    this.forcedUntil = -1;                               // director bring-in: attack now, token or not
  }
  get alive() { return this.members.some((m) => m.alive); }
  living() { return this.members.filter((m) => m.alive); }
  add(p) { this.members.push(p); p.flock = this; }

  think(dt) {
    const sys = this.sys, P = sys.playerDragon();
    const live = this.living();
    if (!live.length) { if (this.token) sys.releaseFlockToken(this); return; }
    this.stateT += dt;
    this.center.set(0, 0, 0); this.avgVel.set(0, 0, 0);
    for (const m of live) { this.center.add(m.dragon.pos); if (m.dragon.vel) this.avgVel.add(m.dragon.vel); }
    this.center.divideScalar(live.length); this.avgVel.divideScalar(live.length);
    if (this.state === 'flee' || !P || !isAlive(P)) {
      if (this.token) sys.releaseFlockToken(this);
      this.goal.copy(this.center).addScaledVector(this.avgVel, 3);
      return;
    }
    if (!this.started) { this.started = true; this.theta = Math.atan2(this.center.z - P.pos.z, this.center.x - P.pos.x); }
    const attacking = this.state === 'attack';
    const R = attacking ? DRAKE.attackR : this.R;
    // Far behind (the player sprinted away): the orbit angle follows the flock, so the goal is the near side of the
    // ring and the drakes catch up instead of chasing a point on the far side.
    // The ring is centred ahead of the player (where it will be in a few seconds): the flock stays in view of the
    // chase camera and dives become head-on or crossing passes instead of slow tail chases.
    const lead = attacking ? DRAKE.leadT[1] : DRAKE.leadT[0];
    const cx = P.pos.x + (P.vel?.x || 0) * lead, cz = P.pos.z + (P.vel?.z || 0) * lead;
    const far = Math.hypot(this.center.x - cx, this.center.z - cz) > R + 160;
    if (far) this.theta = Math.atan2(this.center.z - cz, this.center.x - cx);
    else this.theta += this.sign * DRAKE.orbitW * dt * (attacking ? 1.6 : 1);
    this.catchUp = far;
    this.goal.set(cx + Math.cos(this.theta) * R, P.pos.y + this.alt + (attacking ? 25 : 0) + sys.altBias(P.pos.y) * 0.7, cz + Math.sin(this.theta) * R);
    // Reposition between attacks: a new ring, height and direction.
    this.repoT -= dt;
    if (this.repoT <= 0 && !attacking) {
      this.repoT = 6 + this.rand() * 4;
      this.R = lerp(DRAKE.orbitR[0], DRAKE.orbitR[1], this.rand()); this.alt = lerp(DRAKE.orbitAlt[0], DRAKE.orbitAlt[1], this.rand());
      if (this.rand() < 0.3) this.sign = -this.sign;
    }
    // A screech now and then while circling close (shared limiter, so a sky full of drakes is not a choir).
    if (!attacking && this.center.distanceTo(P.pos) < 320 && this.rand() < dt * 0.1 && sys.tauntReady()) sys.taunt(live[Math.floor(this.rand() * live.length)], 0.4);
    if (this.state === 'circle') {
      this.tokenCd -= dt * (0.7 + 0.6 * sys.aggression);
      if (this.tokenCd <= 0 && !sys.titanBusy() && sys.requestFlockToken(this, this.forcedUntil > this.game.time.now)) {
        this.state = 'attack'; this.stateT = 0; this.dived.clear(); this.diveT = 0.2; this.cycles++;
      }
    } else if (attacking) {
      this.diveT -= dt;
      if (this.diveT <= 0) {
        // Next in: the free member best placed for a fast pass — close, and ahead of or beside the player rather
        // than behind it (a tail chase closes too slowly to be a quick bite).
        let best = null, bs = Infinity, bd = 0;
        const pf = pathOf(P, _b1);
        for (const m of live) {
          if (this.dived.has(m) || m.state !== 'flock' || m.scatterIn >= 0) continue;
          const off = _b2.subVectors(m.dragon.pos, P.pos), dd = off.length();
          if (dd > DRAKE.diveFrom) continue;                        // too far for a quick pass: catch up first
          // First dives come from where a beginner looks: ahead or beside (≤ 65° off its course) — the flock's first two
          // and every drake's own first one (the latter relaxed after 8 s of attacking).
          if ((this.firstDives > 0 || (this.frontDives && !m.dives && this.stateT < 8)) && off.dot(pf) / Math.max(1, dd) < Math.cos(65 * DEG)) continue;
          const behind = Math.max(0, -off.dot(pf) / Math.max(1, dd));
          const above = clamp((off.y - 20) / 80, 0, 1);            // height to stoop from is speed
          const facing = -pathOf(m.dragon, _b3).dot(off) / Math.max(1, dd);   // 1 = already flying at the player
          const sc = dd * (1 + 1.2 * behind) * (1 - 0.3 * above) * (1.6 - 0.6 * facing);
          if (sc < bs) { bs = sc; best = m; bd = dd; }
        }
        if (best) {
          if (this.firstDives > 0) this.firstDives--;
          best.dives = (best.dives || 0) + 1;
          this.dived.add(best); best.beginAttack(bd);
          this.diveT = lerp(DRAKE.diveGap[0], DRAKE.diveGap[1], this.rand()) * (sys.aggression > 0.8 ? 0.7 : 1);
        } else if (live.every((m) => this.dived.has(m) || m.state === 'scatter') || this.stateT > 6 && !live.some((m) => m.state === 'dive' || m.state === 'spit')) this.endAttack();
      }
      if (this.stateT > DRAKE.attackMax || sys.titanBusy()) this.endAttack();
    }
  }
  endAttack() {
    this.state = 'circle'; this.stateT = 0;
    this.sys.releaseFlockToken(this);
    this.tokenCd = lerp(DRAKE.tokenCd[0], DRAKE.tokenCd[1], this.rand());
  }
  /** Flockmates near a fallen drake panic. */
  onMemberDeath(p) {
    for (const m of this.living()) {
      if (m === p || m.dragon.pos.distanceTo(p.dragon.pos) > 90 || this.rand() > 0.6) continue;
      m.scatterAway(p.dragon.pos, null, 0.1 + this.rand() * 0.3);
    }
  }
  /** One member saw the flame: the rest of the flock scatters too, a little later and less reliably. */
  panic(src, mouth, dir) {
    for (const m of this.living()) {
      if (m === src || m.state === 'scatter' || m.scatterIn >= 0 || m.dragon.pos.distanceTo(src.dragon.pos) > 130) continue;
      if (this.rand() < 0.55) m.scatterAway(mouth, dir, 0.35 + this.rand() * 0.35);
    }
  }
  flee() { this.state = 'flee'; this.sys.releaseFlockToken(this); for (const m of this.living()) m.setState('flee'); }
}

class DrakePilot extends Pilot {
  constructor(sys, dragon, o) {
    super(sys, dragon, { ...o, skill: 'drake' });
    this.kind = 'drake';
    this.state = 'flock';
    this.slotPhase = this.rand() * Math.PI * 2;
    this.slotR = 14 + this.rand() * 20; this.slotY = (this.rand() - 0.5) * 24;
    this.bitten = false; this.spitDone = false; this.side = 1;
    this.scatterIn = -1; this.scatterDir = new THREE.Vector3(0, 1, 0); this.scatterFor = 1.6; this.ignoreBreath = false;
    this.fbCd = 1 + this.rand() * 3;
    this.pullDir = new THREE.Vector3(); this.pullFor = 1.2; this.passSide = 1;
  }
  setBreath() { /* drakes have no fire breath */ }
  setState(s) {
    if (this.state === s) return;
    this.state = s; this.stateT = 0;
    if (s !== 'dive') this.avoidSkip = null;
    if (s !== 'dive' && s !== 'spit' && 'lookTarget' in this.dragon) this.dragon.lookTarget = null;
    if (s === 'scatter') { this.scatterIn = -1; this.scatterFor = lerp(DRAKE.scatterFor[0], DRAKE.scatterFor[1], this.rand()); }
  }
  /** Called by the flock when it is this drake's turn. */
  beginAttack(dist) {
    const spitOk = this.fbCd <= 0 && dist > DRAKE.spitRange[0] + 40 && dist < DRAKE.spitRange[1];
    const spit = spitOk && this.rand() < DRAKE.spitPref + (dist > 200 ? 0.2 : 0);
    this.bitten = false; this.spitDone = false; this.side = this.rand() < 0.5 ? -1 : 1;
    this.diveMinD = 1e9; this.diveAhead = false;
    const P = this.sys.playerDragon();
    this.passSide = P && this.dragon.pos.y < P.pos.y - 6 ? -1 : 1;          // pass over its back unless coming from below
    this.setState(spit ? 'spit' : 'dive');
  }
  /** Scatter away from a point (and across a flame axis, if given) after `delay` s. */
  scatterAway(from, axis, delay) {
    if (this.state === 'scatter' || this.state === 'flee' || this.scatterIn >= 0) return;
    const rel = _b1.subVectors(this.dragon.pos, from);
    if (axis) rel.addScaledVector(axis, -rel.dot(axis));
    if (rel.lengthSq() < 1) rel.set(this.rand() - 0.5, 0, this.rand() - 0.5);
    this.scatterDir.copy(rel.normalize()).multiplyScalar(0.85).addScaledVector(UP, 0.2 + this.rand() * 0.35);
    if (axis) this.scatterDir.addScaledVector(axis, 0.2);
    this.scatterDir.x += (this.rand() - 0.5) * 0.4; this.scatterDir.z += (this.rand() - 0.5) * 0.4;
    this.scatterDir.normalize();
    this.scatterIn = delay;
  }

  think(dt) {
    const d = this.dragon, s = this.skill, sys = this.sys;
    this.t += dt; this.stateT += dt;
    this.fbCd = Math.max(0, this.fbCd - dt * (0.7 + 0.6 * sys.aggression));
    this.fbGap = Math.max(0, this.fbGap - dt);
    const k = Math.sqrt(2 * dt / 0.8) * s.aim;
    this.nYaw += -this.nYaw * dt / 0.8 + k * gauss(this.rand);
    this.nPitch += -this.nPitch * dt / 0.8 + k * gauss(this.rand);
    this.boostOn = false; this.diveOn = false;             // re-decided every tick (a stale tuck drops a drake like a stone)
    if (this.state === 'flee' || this.flock?.state === 'flee') { this.setState('flee'); this.flee(); this.avoid(); return; }
    const P = sys.playerDragon();
    if (!P || !isAlive(P)) { this.loiter(); this.avoid(); return; }
    this.target = P;
    const T = sys.perceive(P, s.react, this._seen || (this._seen = {}));
    const fwd = pathOf(d, this._fwd);
    const rel = this._rel.subVectors(T.pos, d.pos);
    const dist = Math.max(1, rel.length());
    this._los.copy(rel).divideScalar(dist);
    this.checkProjectiles();
    this.checkBreath(T, P);
    this.updateCloud(dt);
    if (this.scatterIn >= 0) { this.scatterIn -= dt; if (this.scatterIn < 0) this.setState('scatter'); }
    switch (this.state) {
      case 'flock': this.boids(T, dist); break;
      case 'dive': this.dive(T, dist, fwd); break;
      case 'spit': this.spit(T, dist, fwd); break;
      case 'pull':
        this.want.copy(this.pullDir); this.speed = this.cruise * s.attackMul; this.urgency = 0.9;
        this.boostOn = this.stateT < 0.7;
        if (this.stateT > this.pullFor) this.setState('flock');
        break;
      case 'scatter':
        this.want.copy(this.scatterDir); this.speed = MAX_AI_SPEED; this.urgency = 1;
        this.boostOn = this.stateT < 1.2;
        if (this.stateT > this.scatterFor) this.setState('flock');
        break;
      default: this.setState('flock'); this.boids(T, dist);
    }
    this.manageEnergy();
    this.avoid();
  }

  /** Boids toward a slot on a slowly turning ring around the flock goal: seek + separation + alignment + cohesion. */
  boids(T, dist) {
    const fl = this.flock, d = this.dragon;
    const a = this.slotPhase + this.t * 0.45;
    const base = fl ? fl.goal : T.pos;
    const slot = _b3.set(base.x + Math.cos(a) * this.slotR, base.y + this.slotY + Math.sin(this.t * 0.7 + this.id) * 4, base.z + Math.sin(a) * this.slotR);
    const seek = _b2.subVectors(slot, d.pos);
    const sd = Math.max(1, seek.length());
    const w = this.want.copy(seek).divideScalar(sd);
    if (fl) {
      for (const m of fl.members) {
        if (m === this || !m.alive) continue;
        const off = _b1.subVectors(d.pos, m.dragon.pos);
        const dd = off.length();
        if (dd < 24 && dd > 0.1) w.addScaledVector(off.divideScalar(dd), ((24 - dd) / 24) * 1.4);
      }
      if (fl.avgVel.lengthSq() > 25) w.addScaledVector(_b1.copy(fl.avgVel).normalize(), 0.3);
      const toC = _b1.subVectors(fl.center, d.pos), cd = toC.length();
      if (cd > 45) w.addScaledVector(toC.divideScalar(cd), 0.25);
    }
    w.normalize();
    const along = seek.dot(pathOf(d, this._fwd));
    this.speed = clamp(speedOf(T) + clamp(along * 0.15, -8, 22), this.cruise * 0.95, 60);
    this.urgency = 0.75;
    this.boostOn = (sd > 200 || fl?.catchUp) && along > 0 && (d.stamina ?? 1) > 0.4;
    if (fl?.catchUp) this.speed = 60;
    // Rare potshot from the circle when the flock is not attacking (shared limiter with the riders).
    if (fl?.state !== 'attack' && this.fbCd <= 0 && dist > 110 && dist < 260 && pathOf(d, this._fwd).dot(this._los) > Math.cos(14 * DEG)
      && !this.sys.titanBusy() && this.sys.potshotReady()) this.spitAt(T, 1.3);
  }

  /** Bite / claw pass: lead onto a point just above and beside the target, fast; contact damage in fly(). */
  dive(T, dist, fwd) {
    const d = this.dragon, s = this.skill;
    this.avoidSkip = T.dragon;
    const side = _b1.crossVectors(T.fwd, UP);
    if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
    // Terminal phase (inside 120 m): the strike is a reflex, so it uses the target's true state, and the command is
    // pushed past the needed direction to make up for the steering lag (a PD on the flight path).
    const terminal = dist < 120 && T.dragon?.pos;
    const tp = terminal ? T.dragon.pos : T.pos, tv = terminal ? (T.dragon.vel || T.vel) : T.vel;
    // Aim to MISS by ~5 m over (or under) the target's back, on the side the dive comes from: the jaws and the claws
    // still rake it (bite spheres 4.2 m around the mouth and the body), the bodies never pass through each other
    // (art critic: a drake at 4 m flew through Sora; the old aim point was 0.8 m off the centre).
    const tUp = _b4.set(0, 1, 0);
    if (T.dragon?.quat) tUp.applyQuaternion(T.dragon.quat);
    const aimPt = _b3.copy(tp).addScaledVector(tUp, 5 * this.passSide).addScaledVector(side.normalize(), 1.2 * this.side);
    const dp = _b2.subVectors(aimPt, d.pos);
    // Pursuit intercept: my own path speed against the target's velocity (not a projectile's inherited velocity).
    const t = intercept(dp, tv, Math.max(30, speedOf(d)), this._lead);
    if (t > 0 && t < 6) this.want.copy(this._lead).normalize(); else this.want.copy(dp).normalize();
    if (terminal) {
      const path = pathOf(d, _b1);
      this.want.addScaledVector(_b1.subVectors(this.want, path), 0.9).normalize();
    } else this.applyNoise(this.want, 0.4);
    this.speed = Math.min(DRAKE.maxDiveSpeed, Math.max(this.cruise * s.attackMul, speedOf(T) + 22));
    this.urgency = 1;
    this.boostOn = dist > 40 && (d.stamina ?? 1) > 0.25;
    this.diveOn = dist > 90 && d.pos.y > T.pos.y + 25 && this.want.y < -0.2;   // a real stoop from above
    if ('lookTarget' in d) { this.lookPoint.copy(T.pos); d.lookTarget = this.lookPoint; }
    // Passed = we were close and it is opening again, or it went from ahead of us to behind us (not merely "behind
    // at the start", which is a drake still turning in from its orbit).
    this.diveMinD = Math.min(this.diveMinD ?? 1e9, dist);
    if (fwd.dot(this._los) > 0.5) this.diveAhead = true;
    const passed = (this.diveMinD < 45 && dist > this.diveMinD + 12) || (this.diveAhead && fwd.dot(this._los) < -0.2 && dist < 70);
    // A tail chase that does not close is no bite: spit instead.
    const closing = -_b1.subVectors(T.vel, d.vel || T.vel).dot(this._los);
    if (!this.bitten && this.stateT > 2 && dist > 55 && closing < 10 && this.fbCd <= 0 && dist < DRAKE.spitRange[1]) { this.spitDone = false; this.setState('spit'); return; }
    if (this.bitten || passed || this.stateT > 7 || (dist > 520 && this.stateT > 2.5)) {
      if (this.game.debugMode) { (this.stats.pulls ||= []).push([this.bitten ? 'bit' : passed ? 'passed' : this.stateT > 7 ? 'timeout' : 'far', Math.round(dist), +this.stateT.toFixed(1)]); if (this.stats.pulls.length > 10) this.stats.pulls.shift(); }
      this.pullAway(fwd);
    }
  }
  pullAway(fwd) {
    const right = _b1.crossVectors(fwd, UP);
    if (right.lengthSq() < 1e-4) right.set(1, 0, 0);
    this.pullDir.copy(right.normalize()).multiplyScalar(0.8 * this.side).addScaledVector(UP, 0.5 * (this.passSide || 1)).addScaledVector(fwd, 0.35).normalize();
    this.pullFor = 1 + this.rand() * 0.6;
    this.setState('pull');
  }
  spitAt(T, errMul = 1) {
    const aim = this.fireballAim(T).clone();
    this.applyNoise(aim, this.skill.fbError * errMul * this.aimMul);
    this.sys.fireball(this, aim, { damage: DRAKE.spitDamage, radius: DRAKE.spitRadius, speed: DRAKE.spitSpeed });
    this.stats.shots++;
    this.fbCd = this.skill.fbCd * (0.8 + this.rand() * 0.5);
  }
  /** Spit pass: line up at 80-240 m, one small fireball, then peel off (or turn it into a bite if close). */
  spit(T, dist, fwd) {
    const d = this.dragon, s = this.skill;
    this.want.copy(this.fireballAim(T));
    this.applyNoise(this.want, 0.5);
    this.speed = Math.max(this.cruise * s.speedMul, speedOf(T) + 8); this.urgency = 0.95;
    if ('lookTarget' in d) { this.lookPoint.copy(T.pos); d.lookTarget = this.lookPoint; }
    const off = Math.acos(clamp(pathOf(d, this._fwd).dot(this.want), -1, 1));
    if (!this.spitDone && off < 16 * DEG && dist > DRAKE.spitRange[0] && dist < DRAKE.spitRange[1] && !this.sys.titanBusy()) {
      this.spitAt(T); this.spitDone = true; this.stateT = Math.min(this.stateT, 4);
    }
    if (this.spitDone && this.stateT > 0.6) this.pullAway(fwd);
    else if (!this.spitDone && (dist < DRAKE.spitRange[0] || this.stateT > 5)) { if (dist < 140) this.setState('dive'); else this.pullAway(fwd); }
  }
  /** The player's flame (as perceived, `react` s late): drakes in the cone scatter across it; one may freeze. */
  checkBreath(T, P) {
    if (!T.breathing) { this.ignoreBreath = false; return; }
    if (this.ignoreBreath || this.state === 'scatter' || this.scatterIn >= 0) return;
    const mouth = P.mouth && P.mouth.distanceToSquared(P.pos) < 625 ? P.mouth : P.pos;
    const dir = P.mouthDir && P.mouthDir.lengthSq() > 0.5 ? P.mouthDir : T.fwd;
    const rel = _b1.subVectors(this.dragon.pos, mouth);
    const dd = rel.length();
    if (dd > DRAKE.scatterRange || dd < 1 || rel.dot(dir) / dd < Math.cos(DRAKE.scatterCone)) return;
    if (this.rand() > DRAKE.scatterChance) { this.ignoreBreath = true; return; }   // froze in the flame
    this.scatterAway(mouth, dir, lerp(DRAKE.scatterReact[0], DRAKE.scatterReact[1], this.rand()));
    this.flock?.panic(this, mouth, dir);
  }

  fly(dt) {
    super.fly(dt);
    if (this.state === 'dive' && !this.bitten && this.alive) this.tryBite();
    // Debug: closest approach of each dive (?debug), for tuning.
    if (this.game.debugMode) {
      const P = this.sys.playerDragon();
      if (this.state === 'dive' && P) { const dd = this.dragon.pos.distanceTo(P.pos); this._diveMin = Math.min(this._diveMin ?? 1e9, dd); }
      else if (this._diveMin !== undefined) { (this.stats.diveMin ||= []).push(Math.round(this._diveMin * 10) / 10); if (this.stats.diveMin.length > 12) this.stats.diveMin.shift(); this._diveMin = undefined; }
    }
  }
  /** Contact during a dive: one bite per pass ('impact'), the fire system is not involved. */
  tryBite() {
    const P = this.sys.playerDragon(), pa = actorOf(P), c = this.game.combat;
    if (!P || !pa?.alive || !c) return;
    const d = this.dragon;
    if (d.pos.distanceToSquared(P.pos) > 45 * 45) return;
    const opts = { team: pa.team, exclude: this.actor };
    // Radii are not scaled with the small drake: the jaws lunge and the claws reach.
    const hit = c.querySphere(this.mouthPoint(_b1), DRAKE.biteRadius, opts)[0] || c.querySphere(d.pos, DRAKE.biteBody, opts)[0];
    if (!hit) return;
    this.bitten = true;
    this.stats.bites++;
    const dir = _b2.copy(d.vel || UP).normalize().clone();
    c.damage(hit.actor, DRAKE.bite * this.dmgMul, { source: this.actor, point: hit.point, dir, kind: 'impact', part: hit.shape?.part, shape: hit.shape });
    try { this.game.fx?.sparks?.(hit.point, 10, { vel: P.vel, speed: 26 }); this.game.fx?.impactFlash?.(hit.point, { size: 2.4, ring: false }); } catch (e) { this.sys.warnOnce('bite fx', e); }
    this.game.events.emit('drake:bite', { actor: this.actor, target: hit.actor, point: hit.point });
  }
}
const _b1 = new THREE.Vector3(), _b2 = new THREE.Vector3(), _b3 = new THREE.Vector3(), _b4 = new THREE.Vector3();

// ---------------------------------------------------------------------------------------------------------------
// The system
// ---------------------------------------------------------------------------------------------------------------
const _sight = new THREE.Vector3();

export default function createEnemies(game) {
  let DragonClass = null;
  let DragonModule = null;
  let flockAcc = 0;
  const warned = new Set();
  const list = [];
  const history = new Map();          // dragon -> ring of perceived snapshots (for reaction delay)
  const HIST = 40;
  let histAcc = 0;
  const fallbackShots = [];
  let fbGeo = null, fbMat = null;
  const breathAcc = new Map();

  const sys = {
    name: 'enemies',
    game,
    list,
    incoming: [],                     // live projectiles seen through 'fireball' events (for AI dodging)
    maxTokens: 2,                     // simultaneous attackers per team (dragontwin-feel §9)
    aggression: 0.5,                  // 0..1, the director raises it to fill dead air
    fbGravity: 3,                     // m/s² on AI fireballs (a slight arc, lead compensates)
    titanBusyUntil: 0,
    usingStandIn: false,
    flocks: [],                       // live drake flocks
    flockTokens: 1,                   // flocks attacking at once (riders have maxTokens)
    maxLive: 14,                      // live enemy dragons at once; more wait in `queue` and come as others fall
    maxLiveRiders: 5,                 // wave 4: riders (not drakes) at once; the director sets it per wave (wave 3: 4)
    queue: [],                        // [{ kind:'riders', riders, spec } | { kind:'flock', count, spec }]
    queueT: 0,
    potshotT: 0, tauntT: 0,
    aggressionFloor: 0.5,             // survival: aggression never decays below this (the story keeps 0.5)
    potshotGap: 2.2,                  // s between potshots across all circling riders and drakes (survival: shorter)
    potshotCone: 20,                  // deg off its flight path a circling rider may take a potshot (survival: wider)
    pressure: 0,                      // survival: 0..1 on a player who stops hitting anything (the story keeps 0)
    SKILL, ENEMY_HP, ENEMY_WEAPONS, DRAKE,

    async init() {
      try {
        const m = await import('./dragon.js');
        DragonModule = m;
        DragonClass = m.Dragon || m.default || null;
      } catch (e) {
        console.warn('[enemies] actors/dragon.js not available; flying stand-in dragons', e?.message || e);
      }
      sys.usingStandIn = !DragonClass;
      game.events.on('fireball', ({ projectile, owner }) => {
        if (!projectile) return;
        const team = owner?.team || owner?.actor?.team || projectile.team || projectile.owner?.team;
        sys.incoming.push({ p: projectile, team, r: projectile.radius || 1.5, t: game.time.now });
      });
      game.events.on('titan:telegraph', ({ duration }) => {
        sys.titanBusyUntil = Math.max(sys.titanBusyUntil, game.time.now + (duration || 1) + 1.0);
      });
      game.events.on('death', ({ actor }) => {
        const p = list.find((x) => x.actor === actor);
        if (p) sys.onPilotDeath(p);
      });
      // Levels (game.progress): when Sora's element changes (azure, radiant, lightning, storm) the Shade falter — the
      // drakes near her scatter and the riders close by break away for a moment, so the power-up reads on screen.
      game.events.on('levelup', (e) => { try { if (e?.elementChanged) sys.recoil(); } catch (err) { sys.warnOnce('recoil', err); } });
    },
    /**
     * The Shade falter (Sora's element just changed): drakes within `drakes` m scatter away from her (their usual
     * scatter), riders within `riders` m that are not on a bring-in or hunting break away (1.2–2 s hard turn, then
     * extend and come back). Returns how many reacted; emits 'enemies:recoil' { count, drakes, riders }.
     */
    recoil(opts = {}) {
      const P = sys.playerDragon();
      if (!P || !isAlive(P) || !P.pos) return 0;
      const rD = opts.drakes ?? 220, rR = opts.riders ?? 260;
      let nd = 0, nr = 0;
      for (const p of list) {
        if (!p.alive || p.team !== 'enemy' || p.state === 'flee' || p.state === 'dead') continue;
        const dist = p.dragon.pos.distanceTo(P.pos);
        if (p.kind === 'drake') {
          if (dist < rD && typeof p.scatterAway === 'function') { p.scatterAway(P.pos, null, 0.12 + p.rand() * 0.4); nd++; }
        } else if (dist < rR && !p.forced() && !p.hunter && ['engage', 'patrol', 'regroup', 'attack', 'yoyo'].includes(p.state)) {
          p.setState('break'); nr++;
        }
      }
      if (nd + nr) game.events.emit('enemies:recoil', { count: nd + nr, drakes: nd, riders: nr });
      return nd + nr;
    },

    warnOnce(key, e) { if (!warned.has(key)) { warned.add(key); console.warn(`[enemies] ${key}:`, e); } },

    // --- queries ---------------------------------------------------------------------------------------------
    playerDragon() {
      const p = game.player;
      if (!p) return null;
      if (p.pos && (p.actor || p.hp !== undefined)) return p;
      return p.dragon || null;
    },
    playerActor() { const p = sys.playerDragon(); return actorOf(p); },
    titanActor() {
      if (game.titan) return game.titan.active && game.titan.actor?.alive ? game.titan.actor : null;
      return game.actors.find((a) => a.kind === 'titan' && a.alive) || null;
    },
    titanBusy() { return game.time.now < sys.titanBusyUntil; },
    /** Breath reach and flame speed as the fire system actually simulates them. */
    breathRange() { return game.fx?.config?.breath?.maxRange ?? ENEMY_WEAPONS.breathRange; },
    flameSpeed() { return game.fx?.config?.breath?.muzzle ?? ENEMY_WEAPONS.flameSpeed; },
    floorAt(x, z) {
      let h = 0;
      try { h = game.world.heightAt(x, z) || 0; } catch { h = 0; }
      return Math.max(h, game.world.seaLevel || 0, (game.world.bounds?.floor ?? 40));
    },
    /** Every dragon the AI flies around (the player first); rebuilt once per fixed step — each pilot's avoidance
     *  reads it at 15 Hz, and survival puts up to ~26 of them in the sky. */
    dragons() {
      const f = game.time?.fixedFrame;
      if (sys._dragonsFrame === f && sys._dragons && f !== undefined) return sys._dragons;
      const out = sys._dragons || (sys._dragons = []);
      out.length = 0;
      const p = sys.playerDragon(); if (p) out.push(p);
      for (const e of list) out.push(e.dragon);
      sys._dragonsFrame = f;
      return out;
    },
    alive() { return list.filter((p) => p.alive && p.team === 'enemy'); },
    /** Living enemy dragons (riders and drakes). */
    count() { return list.reduce((n, p) => n + (p.alive && p.team === 'enemy' ? 1 : 0), 0); },
    countRiders() { return list.reduce((n, p) => n + (p.alive && p.team === 'enemy' && p.kind !== 'drake' ? 1 : 0), 0); },
    countDrakes() { return list.reduce((n, p) => n + (p.alive && p.team === 'enemy' && p.kind === 'drake' ? 1 : 0), 0); },
    /** Enemies spawned by the director but waiting for room under maxLive (optionally only one wave tag). */
    pending(tag) {
      let n = 0;
      for (const e of sys.queue) if (tag === undefined || e.spec?.tag === tag) n += e.kind === 'flock' ? e.count : e.riders.length;
      return n;
    },
    room() { return Math.max(0, sys.maxLive - sys.count()); },
    /** Room for riders: under both the live cap and the rider cap. */
    riderRoom() { return Math.max(0, Math.min(sys.room(), (sys.maxLiveRiders ?? 99) - sys.countRiders())); },
    pilotOf(actor) { return list.find((p) => p.actor === actor) || null; },
    /** The dragon variant for drakes: the dragon owner's 'drake' when it exists, else a riderless Shade dragon. */
    drakeVariant() { return DragonModule?.DRAGON_DEFAULTS?.drake ? 'drake' : 'crimson'; },
    /** Height offset for rings around the player that draws a dogfight back into the combat band (1300–2300 m, where
     *  the valley, the cloud towers and the titan are): enemies above the player tempt it upward, so above ~2100 m
     *  they circle below it, under ~1300 m above it (run 2: the fight had drifted to 3300–3460 m). */
    altBias(y) { return clamp((1800 - y) * 0.35, -170, 140); },
    potshotReady() {
      if (game.time.now < sys.potshotT) return false;
      const pr = Number.isFinite(sys.pressure) ? clamp(sys.pressure, 0, 1) : 0;
      sys.potshotT = game.time.now + (Number.isFinite(sys.potshotGap) ? sys.potshotGap : 2.2) * (1 - 0.35 * pr);
      return true;
    },
    tauntReady() { return game.time.now >= sys.tauntT; },
    taunt(p, volume = 0.5) {
      sys.tauntT = game.time.now + 5 + Math.random() * 3;
      try { game.audio?.play?.('roar', { voice: 'dragon', pos: p.dragon.pos.clone(), volume, rate: p.kind === 'drake' ? 1.6 : 1.1 }); } catch (e) { sys.warnOnce('taunt audio', e); }
      game.events.emit('enemy:taunt', { actor: p.actor, kind: p.kind });
    },

    /** What a pilot knows about a dragon: the snapshot it saw `delay` seconds ago (so turns are noticed late),
     *  dead-reckoned to now along the seen velocity (so a straight flier is not systematically lagged). */
    perceive(d, delay, out) {
      const h = history.get(d);
      if (!h || !h.length) return sys.snapshot(d, out || {});
      const i = Math.min(h.length - 1, Math.round(delay * BRAIN_HZ));
      const seen = h[h.length - 1 - i];
      if (!out) return seen;
      out.pos = (out.pos || new THREE.Vector3()).copy(seen.pos).addScaledVector(seen.vel, i / BRAIN_HZ);
      out.vel = seen.vel; out.fwd = seen.fwd; out.aim = seen.aim; out.breathing = seen.breathing;
      out.airspeed = seen.airspeed; out.dragon = seen.dragon;
      return out;
    },
    snapshot(d, out) {
      out.pos = (out.pos || new THREE.Vector3()).copy(d.pos);
      out.vel = (out.vel || new THREE.Vector3()).copy(d.vel || _v1.set(0, 0, 0));
      out.fwd = forwardOf(d, out.fwd || new THREE.Vector3());
      const isPlayer = d === sys.playerDragon();
      const aim = isPlayer && game.cameraRig?.aimDir && game.cameraRig.mode !== 'free' ? game.cameraRig.aimDir : (d.mouthDir || out.fwd);
      out.aim = (out.aim || new THREE.Vector3()).copy(aim).normalize();
      out.breathing = !!(d.controls?.breath || d.breathing);
      out.airspeed = speedOf(d);
      out.dragon = d;
      return out;
    },

    // --- tokens ----------------------------------------------------------------------------------------------
    requestToken(p) {
      if (p.team !== 'enemy') return true;
      if (p.hunter) return true;                           // survival Interceptors always attack (outside the tokens)
      // The dead-air nudge may add a third attacker, but only when the sky is not already crowded; survival pressure
      // (a player who stopped fighting) up to two more.
      const pr = Number.isFinite(sys.pressure) ? clamp(sys.pressure, 0, 1) : 0;
      const max = sys.maxTokens + (sys.aggression > 0.8 && sys.countRiders() <= 3 ? 1 : 0) + Math.round(2 * pr);
      let n = 0;
      for (const o of list) if (o.token && o.alive && o.team === p.team && !o.hunter) n++;
      return n < max;
    },
    releaseToken(p) { p.token = false; },
    requestFlockToken(f, force = false) {
      let n = 0;
      for (const o of sys.flocks) if (o !== f && o.token && o.alive) n++;
      if (n >= sys.flockTokens + ((sys.pressure || 0) >= 0.5 ? 1 : 0) && !force) return false;
      f.token = true;
      return true;
    },
    releaseFlockToken(f) { f.token = false; },

    // --- weapons ---------------------------------------------------------------------------------------------
    breathEdge(p, on) {
      // Dragon only heats up from controls.breath; the flame itself is the pilot's call (fx.breath emits 'breath').
      const src = on ? p.flameSource() : (p.breathSrc || p.dragon);
      p.breathSrc = on ? src : null;
      // Survival scaling goes through the fire system's own option (the story passes nothing: unchanged).
      const mult = on && p.dmgMul !== 1 ? { damageMult: p.dmgMul } : undefined;
      if (game.fx?.breath) { try { game.fx.breath(src, on, mult); } catch (e) { sys.warnOnce('fx.breath', e); } }
      else game.events.emit('breath', { actor: p.actor, on });
    },
    fireball(p, dir, o = {}) {
      const d = p.dragon, s = p.skill;
      const from = p.mouthPoint(new THREE.Vector3());
      const vel = dir.clone().multiplyScalar(o.speed ?? s.fbSpeed).add(d.vel || _v1.set(0, 0, 0));
      const tgtDragon = p.target || sys.playerDragon();
      const target = tgtDragon ? sys.perceive(tgtDragon, 0).dragon : null;
      const radius = o.radius ?? ENEMY_WEAPONS.fireballRadius;
      const opts = {
        from, vel, owner: p.actor, radius,
        damage: (o.damage ?? ENEMY_WEAPONS.fireballDamage[p.skillName] ?? 30) * (p.dmgMul || 1), gravity: sys.fbGravity,
        homing: (s.homing || 0) + (p.homingAdd || 0), target: actorOf(target), kind: 'dragon',
      };
      if (o.radius) { opts.visualRadius = radius * 1.1; opts.splashRadius = radius * 1.6; opts.splashDamage = 0; }
      if (game.fx?.fireball) {
        try { game.fx.fireball(opts); return; } catch (e) { sys.warnOnce('fx.fireball', e); }
      }
      sys.fallbackFireball(opts);
    },
    fallbackFireball(o) {
      if (!fbGeo) {
        fbGeo = new THREE.SphereGeometry(1, 12, 8);
        fbMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(4, 1.4, 0.3) });
      }
      const mesh = new THREE.Mesh(fbGeo, fbMat);
      mesh.scale.setScalar(o.radius * 1.3);
      mesh.position.copy(o.from);
      game.scene.add(mesh);
      const shot = { pos: o.from.clone(), vel: o.vel.clone(), owner: o.owner, radius: o.radius, damage: o.damage, gravity: o.gravity, life: 6, mesh, alive: true };
      fallbackShots.push(shot);
      game.events.emit('fireball', { projectile: shot, owner: o.owner, kind: 'dragon' });
    },
    stepFallbackShots(dt) {
      for (let i = fallbackShots.length - 1; i >= 0; i--) {
        const s = fallbackShots[i];
        s.life -= dt;
        const p0 = _v2.copy(s.pos);
        s.vel.y -= s.gravity * dt;
        s.pos.addScaledVector(s.vel, dt);
        const hit = game.combat?.sweepSphere(p0, s.pos, s.radius, { exclude: s.owner });
        let done = s.life <= 0 || s.pos.y < sys.floorAt(s.pos.x, s.pos.z) - 50;
        if (hit && hit.actor.team !== s.owner?.team) {
          game.combat.damage(hit.actor, s.damage, { source: s.owner, point: hit.point, dir: s.vel.clone().normalize(), kind: 'fireball', part: hit.shape.part, shape: hit.shape });
          game.fx?.explosion?.(hit.point, { radius: 6, kind: 'dragon' });
          done = true;
        }
        if (done) { s.alive = false; s.mesh.parent?.remove(s.mesh); fallbackShots.splice(i, 1); }
      }
    },
    /** Only when game.fx is missing: a crude flame cone so enemy breath still hurts. */
    fallbackBreath(p, dt) {
      if (game.fx?.breath || !p.breathOn) return;
      let acc = (breathAcc.get(p) || 0) + dt;
      if (acc < 0.1) { breathAcc.set(p, acc); return; }
      breathAcc.set(p, 0);
      // Hose model: a flame packet leaves the mouth at 45 m/s plus the dragon's velocity and spreads as it goes.
      const d = p.dragon, mouth = p.mouthPoint(_h4), dir = p.mouthDirection(_v3);
      const pv = _v4.copy(d.vel || _v1.set(0, 0, 0)).addScaledVector(dir, ENEMY_WEAPONS.flameSpeed);
      for (const a of game.actors) {
        if (!a.alive || a.team === p.team) continue;
        const dp = _v2.subVectors(a.pos, mouth);
        if (dp.lengthSq() > 200 * 200) continue;
        const dv = _v1.subVectors(a.vel || _v1.set(0, 0, 0), pv);
        const ts = clamp(-dp.dot(dv) / Math.max(1e-6, dv.lengthSq()), 0, 1.4);
        const miss = dp.addScaledVector(dv, ts).length();
        if (miss > 3 + ts * 9 + (a.radius || 10) * 0.25) continue;
        game.combat.damage(a, ENEMY_WEAPONS.breathDps * acc * (p.dmgMul || 1), { source: p.actor, point: a.pos.clone(), dir: dir.clone(), kind: 'fire', part: 'body' });
      }
    },

    // --- spawning --------------------------------------------------------------------------------------------
    createDragon(o) {
      const opts = {
        variant: o.variant || 'crimson', team: o.team || 'enemy', name: o.name,
        rider: o.rider === null ? null : (o.rider || (o.team === 'player' ? 'kaede' : 'knight')),
        pos: o.pos.clone(), heading: o.heading ?? 0, dir: o.dir, hp: o.hp, maxHp: o.hp, ai: true,
      };
      let d = null;
      if (DragonClass && !o.standIn && !game.params?.has?.('enemyStandIn')) {
        try { d = new DragonClass(game, opts); } catch (e) { sys.warnOnce('Dragon constructor', e); d = null; }
      }
      if (!d) { d = new StandInDragon(game, opts); sys.usingStandIn = true; }
      const a = actorOf(d);
      if (a) {
        if (o.hp) { a.maxHp = o.hp; a.hp = o.hp; }
        if (o.name) a.name = o.name;
        if (game.combat && !game.actors.includes(a)) game.combat.register(a);
      }
      if (d.root && !d.root.parent) game.scene.add(d.root);
      return d;
    },

    spawnPilot(o) {
      const d = sys.createDragon(o);
      const p = new Pilot(sys, d, { ...o, team: o.team || 'enemy' });
      list.push(p);
      history.set(d, []);
      sys._dragonsFrame = -1;
      return p;
    },

    /**
     * spec: { riders:[{ skill, variant, name, hp }] } or { count, aces, skill }, plus
     *   distance (m from the player, default 750), bearing (rad from the player's heading, default random ±50°),
     *   dy (m relative to the player, default +60), formation 'pairs'|'none', patrolTime (s), tag
     */
    /** Where a group appears: `distance` m out on `bearing` from the player's heading, nudged into a cloud. */
    spawnCenter(spec, r) {
      const P = sys.playerDragon();
      const ppos = P?.pos || new THREE.Vector3(0, 1400, 0);
      const pf = P ? forwardOf(P, new THREE.Vector3()) : new THREE.Vector3(0, 0, 1);
      pf.y = 0; if (pf.lengthSq() < 1e-4) pf.set(0, 0, 1); pf.normalize();
      const bearing = spec.bearing ?? (r() - 0.5) * (Number.isFinite(spec.spread) ? spec.spread : 1.8);
      const dist = spec.distance ?? 750;
      const dir = pf.clone().applyAxisAngle(UP, bearing);
      const center = ppos.clone().addScaledVector(dir, dist);
      let floor = 0;
      try { floor = sys.floorAt(center.x, center.z); } catch { floor = 0; }
      center.y = clamp(ppos.y + (spec.dy ?? 60), Math.max(800, floor + 250), 2600);
      // "Break from the clouds": nudge the spawn into the densest cloud nearby when there is one.
      let best = center.clone(), bestD = -1;
      for (let i = 0; i < 9; i++) {
        const c = center.clone().add(new THREE.Vector3((r() - 0.5) * 360, (r() - 0.5) * 240, (r() - 0.5) * 360));
        c.y = clamp(c.y, Math.max(800, floor + 250), 2600);
        let den = 0;
        try { den = game.world.cloudDensity?.(c.x, c.y, c.z) || 0; } catch { den = 0; }
        if (den > bestD + 0.05) { bestD = den; best = c; }
      }
      // …but never inside a cloud close to the player (the fight would start in the milk).
      if (bestD > 0.25 && best.distanceTo(ppos) > 420) { center.copy(best); try { game.clouds?.punch?.(center, 70, 5); } catch { /* optional */ } }
      return { center, ppos };
    },

    spawnWave(spec = {}) {
      let riders = spec.riders;
      if (!riders) {
        riders = [];
        for (let i = 0; i < (spec.aces || 0); i++) riders.push({ skill: 'ace' });
        for (let i = 0; i < (spec.count ?? 3) - (spec.aces || 0); i++) riders.push({ skill: spec.skill || 'rookie' });
      }
      // Live caps (all dragons and riders): whatever does not fit waits in the queue (pairs stay whole) and comes as
      // others fall. Survival Interceptors (spec.hunter) pass the rider cap and may pass the live cap by one pair (fps:
      // wave 8 = 26 + 2 measured, docs/modules/gameplay.md); beyond that they queue like everyone else.
      const room = spec.hunter ? Math.max(sys.riderRoom(), Math.min(riders.length, sys.maxLive + 2 - sys.count())) : sys.riderRoom();
      if (riders.length > room) {
        let n = room;
        if (spec.formation !== 'none' && n % 2 === 1 && n < riders.length) n -= 1;
        sys.queue.push({ kind: 'riders', riders: riders.slice(n), spec: { ...spec, riders: undefined } });
        riders = riders.slice(0, n);
        if (!riders.length) return [];
      }
      const r = rng(Math.floor(game.time.now * 1000) + list.length * 31 + 7);
      const { center, ppos } = sys.spawnCenter(spec, r);
      const heading = Math.atan2(ppos.x - center.x, ppos.z - center.z);
      const hf = new THREE.Vector3(Math.sin(heading), 0, Math.cos(heading));
      const hr = new THREE.Vector3().crossVectors(hf, UP).normalize();
      const out = [];
      const pairs = spec.formation !== 'none';
      const used = new Set(list.map((p) => p.name));
      const hpMul = Number.isFinite(spec.hpMul) && spec.hpMul > 0 ? spec.hpMul : 1;
      const dmgMul = Number.isFinite(spec.dmgMul) && spec.dmgMul > 0 ? spec.dmgMul : 1;
      const aimMul = spec.aimMul, homing = spec.homing;
      riders.forEach((rd, i) => {
        const skill = SKILL[rd.skill] ? rd.skill : 'rookie';
        const pairIdx = pairs ? Math.floor(i / 2) : i;
        const isWing = pairs && i % 2 === 1;
        const lateral = (pairIdx - (Math.ceil(riders.length / (pairs ? 2 : 1)) - 1) / 2) * 170;
        const pos = center.clone().addScaledVector(hr, lateral + (isWing ? 38 : 0)).addScaledVector(hf, isWing ? -26 : 0);
        pos.y += isWing ? 6 : (pairIdx % 2) * 30;
        const pool = NAMES[skill].filter((n) => !used.has(n));
        const name = rd.name || pool[Math.floor(r() * pool.length)] || NAMES[skill][0];
        used.add(name);
        const leader = isWing ? out[i - 1] : null;
        const p = sys.spawnPilot({
          variant: rd.variant || (skill === 'ace' ? 'onyx' : 'crimson'), team: 'enemy', skill, name,
          hp: Math.round((rd.hp ?? ENEMY_HP[skill]) * hpMul), pos, heading, leader, slot: isWing ? 1 : 0, wave: spec.tag ?? null,
          patrolTime: (spec.patrolTime ?? 1.2) + i * 0.35, seed: Math.floor(r() * 1e9), frontRuns: rd.frontRuns ?? spec.frontRuns ?? 1,
          dmgMul, aimMul, homing, hunter: !!spec.hunter,
        });
        out.push(p);
      });
      return out;
    },

    /**
     * A flock of Shade Drakes. spec: { count = 5, distance = 600, bearing, dy = 0, tag, join }.
     * Returns the Flock (or null when it all went to the queue). `join`: merge into a living flock of the same tag.
     */
    spawnFlock(spec = {}) {
      const count = Math.max(1, Math.round(spec.count ?? 5));
      const room = sys.room();
      if (room < Math.min(3, count)) { sys.queue.push({ kind: 'flock', count, spec: { ...spec, join: true } }); return null; }
      const n = Math.min(count, room);
      if (n < count) sys.queue.push({ kind: 'flock', count: count - n, spec: { ...spec, join: true } });
      const r = rng(Math.floor(game.time.now * 997) + list.length * 53 + 11);
      const { center, ppos } = sys.spawnCenter({ distance: 600, dy: 0, ...spec }, r);
      let flock = spec.join ? sys.flocks.find((f) => f.tag === (spec.tag ?? null) && f.state !== 'flee' && f.alive && f.living().length < 7) : null;
      const hpMul = Number.isFinite(spec.hpMul) && spec.hpMul > 0 ? spec.hpMul : 1;
      const dmgMul = Number.isFinite(spec.dmgMul) && spec.dmgMul > 0 ? spec.dmgMul : 1;
      if (!flock) {
        flock = new Flock(sys, { tag: spec.tag ?? null, seed: Math.floor(r() * 1e9), dmgMul, firstDives: spec.firstDives, frontDives: spec.frontDives });
        sys.flocks.push(flock);
      }
      const heading = Math.atan2(ppos.x - center.x, ppos.z - center.z);
      const variant = sys.drakeVariant();
      for (let i = 0; i < n; i++) {
        const pos = center.clone().add(new THREE.Vector3((r() - 0.5) * 60, (r() - 0.5) * 30, (r() - 0.5) * 60));
        const d = sys.createDragon({ variant, team: 'enemy', name: NAMES.drake[0], rider: null, pos, heading: heading + (r() - 0.5) * 0.3, hp: Math.round(DRAKE.hp * hpMul), drake: true });
        const p = new DrakePilot(sys, d, { name: NAMES.drake[0], variant, team: 'enemy', wave: spec.tag ?? null, seed: Math.floor(r() * 1e9), dmgMul, aimMul: spec.aimMul, homing: spec.homing });
        flock.add(p);
        list.push(p);
        history.set(d, []);
      }
      sys._dragonsFrame = -1;
      return flock;
    },

    onPilotDeath(p) {
      p.setBreath(false);
      p.token = false;
      p.state = 'dead';
      p.deadT = 0;
      p.avoidSkip = null;
      try { p.flock?.onMemberDeath(p); } catch (e) { sys.warnOnce('flock death', e); }
      if (p.dragon.isStandIn) {
        try { game.fx?.smoke?.(p.dragon.root, true); game.fx?.explosion?.(p.dragon.pos.clone(), { radius: 7, kind: 'dragon' }); } catch (e) { sys.warnOnce('fx death', e); }
      }
    },

    remove(p) {
      const i = list.indexOf(p);
      if (i >= 0) list.splice(i, 1);
      sys._dragonsFrame = -1;
      if (p.breathOn) p.setBreath(false);
      const d = p.dragon;
      try { game.fx?.smoke?.(d.root, false); } catch { /* optional */ }
      try {
        if (d.dispose) { if (!d.removed) d.dispose(); }
        else { d.root?.parent?.remove(d.root); }
      } catch (e) { sys.warnOnce('dispose', e); }
      if ('lookTarget' in d) d.lookTarget = null;
      const a = actorOf(d);
      if (a && game.actors.includes(a)) game.combat?.unregister(a);
      history.delete(d);
      if (p.flock) {
        const f = p.flock, j = f.members.indexOf(p);
        if (j >= 0) f.members.splice(j, 1);
        if (!f.members.length) { f.token = false; const k = sys.flocks.indexOf(f); if (k >= 0) sys.flocks.splice(k, 1); }
      }
    },
    /** Remove every enemy dragon and the spawn queue (allied sparring pilots stay unless `all`). */
    clear(all = false) {
      for (const p of [...list]) if (all || p.team === 'enemy') sys.remove(p);
      for (const s of fallbackShots) s.mesh.parent?.remove(s.mesh);
      fallbackShots.length = 0;
      sys.incoming.length = 0;
      sys.titanBusyUntil = 0;
      sys.queue.length = 0;
      sys.flocks.length = 0;
      sys.aggression = 0.5;
      sys.aggressionFloor = 0.5;         // survival knobs back to the story's values
      sys.potshotGap = 2.2;
      sys.potshotCone = 20;
      sys.pressure = 0;
    },
    hurry() {
      sys.aggression = Math.min(1, sys.aggression + 0.15);
      for (const p of list) {
        if (!p.alive || p.team !== 'enemy') continue;
        p.crossT = Math.min(p.crossT, 0.5);
        if (p.kind !== 'drake' && (p.state === 'patrol' || p.state === 'extend' || p.state === 'regroup')) p.setState('engage');
        p.fbCd = Math.min(p.fbCd, 0.5);
      }
      for (const f of sys.flocks) f.tokenCd = Math.min(f.tokenCd, 0.5);
    },
    /**
     * The director's bring-in (dead air, last enemies of a wave): the `n` nearest riders commit to head-on runs from
     * the player's front sector for `seconds` (no evading, no clouds, cooldowns cut, attack token regardless), and
     * the circling drake flocks attack now. Returns how many riders were sent.
     */
    bringIn(n = 2, seconds = 8) {
      const P = sys.playerDragon();
      if (!P || !isAlive(P)) return 0;
      const now = game.time.now;
      const riders = list.filter((p) => p.alive && p.team === 'enemy' && p.kind !== 'drake' && p.state !== 'flee' && p.state !== 'dead')
        .sort((a, b) => a.dragon.pos.distanceToSquared(P.pos) - b.dragon.pos.distanceToSquared(P.pos)).slice(0, n);
      for (const p of riders) {
        p.forcedUntil = now + seconds;
        if (p.state !== 'attack') {
          // Contact within seconds: from the player's forward half a head-on / crossing breath run, from behind a
          // fireball pass (a first run that is still due keeps its front setup, cut to 9 s).
          const rel = _v1.subVectors(p.dragon.pos, P.pos), dist = rel.length();
          const pv = _v2.copy(P.vel || rel).setY(0).normalize();
          const behind = rel.setY(0).normalize().dot(pv) < -0.17;
          p.nextAttack = behind && dist > 150 ? 'fireball' : 'breath';
          p.token = true;
          if (p.state !== 'engage') { p.setState('engage'); p.nextAttack = behind && dist > 150 ? 'fireball' : 'breath'; }
        }
        p.cloudGoal = null;
        p.breathCd = Math.min(p.breathCd, 0.4);            // the head-on pass is a breath run; fireball rates unchanged
      }
      for (const f of sys.flocks) {
        if (!f.alive || f.state === 'flee') continue;
        f.forcedUntil = now + seconds;
        if (f.state === 'circle') f.tokenCd = Math.min(f.tokenCd, 0.2);
      }
      return riders.length;
    },
    /** Titan rise / victory / defeat: everyone breaks off and leaves; queued spawns are dropped. */
    fleeAll() {
      for (const p of list) if (p.alive && p.team === 'enemy') { sys.releaseToken(p); p.setState('flee'); }
      for (const f of sys.flocks) f.flee();
      sys.queue.length = 0;
    },

    // --- loop ------------------------------------------------------------------------------------------------
    fixedUpdate(dt) {
      // Perception history for everyone (15 Hz).
      histAcc += dt;
      if (histAcc >= 1 / BRAIN_HZ) {
        histAcc -= 1 / BRAIN_HZ;
        const P = sys.playerDragon();
        if (P && !history.has(P)) history.set(P, []);
        for (const [d, h] of history) {
          const snap = h.length >= HIST ? h.shift() : {};
          h.push(sys.snapshot(d, snap));
        }
        const now = game.time.now;
        sys.incoming = sys.incoming.filter((x) => now - x.t < 8 && !(x.p.alive === false || x.p.dead || x.p.done || x.p.removed));
      }
      // Flock brains (15 Hz, before their members think).
      flockAcc += dt;
      while (flockAcc >= 1 / BRAIN_HZ) {
        flockAcc -= 1 / BRAIN_HZ;
        for (const f of sys.flocks) { try { f.think(1 / BRAIN_HZ); } catch (e) { sys.warnOnce('flock', e); } }
      }
      // Spawn queue: one group every 0.8 s while there is room under the live caps (the first queued group that fits:
      // a pair of riders waiting for the rider cap does not hold back a drake flock).
      sys.queueT -= dt;
      if (sys.queue.length && sys.queueT <= 0) {
        let qi = -1;
        for (let i = 0; i < sys.queue.length; i++) {
          const q = sys.queue[i];
          const need = q.kind === 'flock' ? Math.min(3, q.count) : Math.min(2, q.riders.length);
          if ((q.kind === 'flock' ? sys.room() : sys.riderRoom()) >= need) { qi = i; break; }
        }
        if (qi >= 0) {
          const e = sys.queue.splice(qi, 1)[0];
          sys.queueT = 0.8;
          try {
            if (e.kind === 'flock') sys.spawnFlock({ ...e.spec, count: e.count, distance: 600, bearing: undefined });
            else sys.spawnWave({ ...e.spec, riders: e.riders, distance: 620, bearing: undefined, patrolTime: 0.4 });
            game.events.emit('enemies:reinforce', { kind: e.kind, count: e.kind === 'flock' ? e.count : e.riders.length, tag: e.spec?.tag ?? null });
          } catch (err) { sys.warnOnce('queue spawn', err); }
        }
      }
      for (let i = list.length - 1; i >= 0; i--) {
        const p = list[i];
        try {
          if (p.alive) { p.fly(dt); sys.fallbackBreath(p, dt); }
          else {
            p.deadT += dt;
            const d = p.dragon;
            // A real Dragon falls, crashes and disposes itself (≤ 14 s); the stand-in is removed when it lands.
            if (d.removed || p.deadT > (d.isStandIn ? p.removeAfter : 16) || (d.isStandIn && d.pos.y < sys.floorAt(d.pos.x, d.pos.z) + 2)) { sys.remove(p); continue; }
          }
          // A fleeing enemy leaves only where the player cannot watch it vanish: far away, or off-screen and not
          // close; 40 s is the hard cap. (It used to be removed after 9 s even in the middle of the screen.)
          if (p.state === 'flee' && p.stateT > 9 && (p.stateT > 40 || sys.outOfSight(p.dragon))) { sys.remove(p); continue; }
          if (p.state === 'flee') p.stateT += dt;
          sys.stepDragon(p.dragon, dt);
        } catch (e) { sys.warnOnce('pilot ' + p.name, e); }
      }
      sys.stepFallbackShots(dt);
      const floor = Number.isFinite(sys.aggressionFloor) ? clamp(sys.aggressionFloor, 0, 1) : 0.5;
      sys.aggression = Math.max(floor, sys.aggression - dt * 0.01);
    },
    /** True when a dragon can disappear without the player seeing it: > 1400 m from the camera, or behind/outside
     *  the view and > 400 m away. */
    outOfSight(d) {
      const cam = game.camera;
      if (!d?.pos || !cam) return true;
      const dist = d.pos.distanceTo(cam.position);
      if (dist > 1400) return true;
      if (dist < 400) return false;
      _sight.copy(d.pos).project(cam);
      return _sight.z > 1 || Math.abs(_sight.x) > 1.15 || Math.abs(_sight.y) > 1.15;
    },
    /** Real Dragons are stepped by their own driver system ('dragons', order 36, after the pilots); only the
     *  stand-in (and any dragon built with autoStep:false) needs the enemies system to integrate it. */
    stepDragon(d, dt) {
      if (!d.isStandIn && !d.manualStep) return;
      if (d.fixedUpdate) d.fixedUpdate(dt, game);
      else if (d.step) d.step(dt, sys.env());
    },
    env() {
      return sys._env || (sys._env = {
        gravity: 9.81, airDensity: (y) => 1.225 * Math.exp(-Math.max(0, y) / 8500),
        wind: (p, out) => out.set(0, 0, 0), heightAt: (x, z) => game.world.heightAt(x, z),
      });
    },
    update(dt, realDt) {
      for (const p of list) {
        if (!p.dragon.isStandIn && !p.dragon.manualStep) continue;
        try { p.dragon.update?.(dt, realDt, game); } catch (e) { sys.warnOnce('dragon.update', e); }
      }
      for (const s of fallbackShots) s.mesh.position.copy(s.pos);
    },
  };
  return sys;
}
