// game.fx — fire breath, fireballs, charges, explosions, sparks and smoke (simulation + VFX).
// Contract: docs/ARCHITECTURE.md ("game.fx") and docs/modules/fx.md (exact API as implemented).
// Visuals are stateless GPU particles (vfx/particles.js), instanced orbs (vfx/orbs.js) and a fixed light pool
// (vfx/lights.js). Gameplay: breath damage packets follow the same closed-form motion as the flame particles, so
// what you see is what burns; fireballs integrate at 120 Hz with swept-sphere collision.
import * as THREE from 'three';
import { getParticles, GLOW, SMOKE } from '../vfx/particles.js';
import { createOrbs } from '../vfx/orbs.js';
import { createFireLights } from '../vfx/lights.js';
import { createRibbons } from '../vfx/ribbons.js';
import { createShock, RING_STYLE } from '../vfx/shock.js';
import { createMoveFx } from '../vfx/moves.js';
import { createArcs, ARC_STYLE } from '../vfx/arcs.js';
import { createScreenFlash } from '../vfx/flash.js';
import { ROW, updatePrism, prismColor } from '../vfx/textures.js';
import { clamp, smoothstep } from '../core/util.js';

/**
 * Fire factions: every flame, spark, smoke puff, orb and fire light takes its colours from its owner.
 *   player — Sora: classic anime fire (white-hot → gold → orange → red), charcoal smoke
 *   enemy  — Shade Riders and drakes: violet shadowfire (white-violet → violet → deep indigo), indigo smoke
 *   ace    — the onyx ace: indigo-blue shadowfire matching its membranes
 *   titan  — the Cloud Titan: molten gold → scarlet → crimson, crimson-black soot
 */
export const FACTIONS = {
  player: { row: ROW.player, spark: ROW.spark, smoke: SMOKE.dark, trail: SMOKE.grey, light: new THREE.Color(1.0, 0.52, 0.16) },
  enemy: { row: ROW.enemy, spark: ROW.enemySpark, smoke: SMOKE.shadow, trail: SMOKE.shadow, light: new THREE.Color(0.62, 0.26, 1.0) },
  ace: { row: ROW.ace, spark: ROW.aceSpark, smoke: SMOKE.aceShadow, trail: SMOKE.aceShadow, light: new THREE.Color(0.3, 0.46, 1.0) },
  titan: { row: ROW.titan, spark: ROW.titanSpark, smoke: SMOKE.titan, trail: SMOKE.titan, light: new THREE.Color(1.0, 0.36, 0.1) },
};
/** Flight moves: the inferno super breath and a full charge light the scene white-gold. */
const INFERNO_LIGHT = new THREE.Color(1.0, 0.8, 0.4);
/** Levels and elements (fix pass): the screen flash of Sora's lightning-bolt hit (linear): cyan-white; storm warmer. */
const BOLT_FLASH = new THREE.Color(0.42, 0.85, 1.0), STORM_FLASH = new THREE.Color(0.85, 0.82, 0.9);
/**
 * Levels and elements (game.progress.element, docs/modules/fx.md "Levels and elements"): Sora's fire palette follows
 * her level. Each palette has the FACTIONS shape plus: name, mine (the player's own fire), hot (the inferno / charged
 * row), hotLight, ring (RING_STYLE of her energy rings), fire (flame tongues + damage packets), arcs (lightning strands,
 * beam damage and chain arcs; F shoots a lightning bolt), chain (extra targets when game.progress has none), arcStyle,
 * sparkle (twinkles in the stream and trail), boltFire (the bolt is wrapped in gold fire). Enemy / titan fire never
 * uses these.
 */
export const ELEMENTS = {
  ember: Object.assign(FACTIONS.player, { name: 'ember', mine: true, hot: ROW.inferno, hotLight: INFERNO_LIGHT, ring: RING_STYLE.energy,
    fire: true, arcs: false, chain: 0, arcStyle: ARC_STYLE.gold }),
  azure: { name: 'azure', mine: true, row: ROW.azure, hot: ROW.azure, spark: ROW.azureSpark, smoke: SMOKE.azure, trail: SMOKE.azure,
    light: new THREE.Color(0.3, 0.62, 1.0), hotLight: new THREE.Color(0.55, 0.85, 1.0), ring: RING_STYLE.azure,
    fire: true, arcs: false, chain: 0, arcStyle: ARC_STYLE.azure },
  radiant: { name: 'radiant', mine: true, row: ROW.radiant, hot: ROW.radiant, spark: ROW.radiantSpark, smoke: SMOKE.radiant, trail: SMOKE.radiant,
    light: new THREE.Color(1.0, 0.84, 0.52), hotLight: new THREE.Color(1.0, 0.94, 0.8), ring: RING_STYLE.radiant,
    fire: true, arcs: false, chain: 0, sparkle: true, arcStyle: ARC_STYLE.gold },
  lightning: { name: 'lightning', mine: true, row: ROW.lightning, hot: ROW.lightning, spark: ROW.lightningSpark, smoke: SMOKE.grey, trail: SMOKE.grey,
    light: new THREE.Color(0.35, 0.85, 1.0), hotLight: new THREE.Color(0.7, 0.95, 1.0), ring: RING_STYLE.lightning,
    fire: false, arcs: true, chain: 3, arcStyle: ARC_STYLE.lightning },
  storm: { name: 'storm', mine: true, row: ROW.inferno, hot: ROW.inferno, spark: ROW.lightningSpark, smoke: SMOKE.radiant, trail: SMOKE.radiant,
    light: new THREE.Color(0.82, 0.84, 1.0), hotLight: new THREE.Color(1.0, 0.9, 0.7), ring: RING_STYLE.lightning,
    fire: true, arcs: true, chain: 5, sparkle: true, arcStyle: ARC_STYLE.storm, boltFire: true },
  // levels update — L11+ (game.progress.ascended): the storm's kit (lightning wrapped in fire, so its name stays
  // 'storm' for every rule that asks) burning through the rainbow: the prism rows are rewritten every frame
  // (textures.js updatePrism) and its light follows the hue.
  prism: { name: 'storm', prism: true, mine: true, row: ROW.prism, hot: ROW.prism, spark: ROW.prismSpark, smoke: SMOKE.radiant, trail: SMOKE.radiant,
    light: new THREE.Color(0.9, 0.7, 1.0), hotLight: new THREE.Color(1.0, 0.92, 1.0), ring: RING_STYLE.lightning,
    fire: true, arcs: true, chain: 6, sparkle: true, arcStyle: ARC_STYLE.prism, boltFire: true, fireRate: 1 },
};
const _prismRim = new THREE.Color();
/** Palette of a ramp row (explosions / sparks / smoke that only know a row). */
const PAL_BY_ROW = {
  [ROW.player]: FACTIONS.player, [ROW.enemy]: FACTIONS.enemy, [ROW.titan]: FACTIONS.titan, [ROW.ace]: FACTIONS.ace,
  [ROW.spark]: FACTIONS.player, [ROW.enemySpark]: FACTIONS.enemy, [ROW.titanSpark]: FACTIONS.titan, [ROW.aceSpark]: FACTIONS.ace,
  [ROW.inferno]: FACTIONS.player, [ROW.azure]: ELEMENTS.azure, [ROW.azureSpark]: ELEMENTS.azure, [ROW.radiant]: ELEMENTS.radiant,
  [ROW.radiantSpark]: ELEMENTS.radiant, [ROW.lightning]: ELEMENTS.lightning, [ROW.lightningSpark]: ELEMENTS.lightning,
  [ROW.prism]: ELEMENTS.prism, [ROW.prismSpark]: ELEMENTS.prism,
};
/** Faction for a dragon variant (the membranes decide the fire colour). */
const VARIANT_FACTION = { hero: 'player', crimson: 'enemy', drake: 'enemy', shade: 'enemy', onyx: 'ace' };
/** Wave 4: violet / indigo shadowfire always burns in the soft emissive class (vfx/particles.js `soft`). */
const SHADOW_ROWS = new Set([ROW.enemy, ROW.ace]);
const mix = (a, b, t) => a + (b - a) * t;

const V3 = THREE.Vector3;
const rnd = (a, b) => a + Math.random() * (b - a);
const _a = new V3(), _b = new V3(), _c = new V3(), _d = new V3(), _e = new V3(), _f = new V3();
const _u = new V3(), _w = new V3(), _cam = new V3(), _camFwd = new V3(), _up = new V3(0, 1, 0);
const _g = new V3(), _h = new V3(), _k = new V3(), _x = new V3(1, 0, 0);
const _l0 = new V3(), _l1 = new V3(), _l2 = new V3(), _l3 = new V3();
const DEG = Math.PI / 180;
const hash1 = (x) => { const v = Math.sin(x * 12.9898) * 43758.5453; return v - Math.floor(v); };

/** Closed-form drag + vertical gravity motion — the exact mirror of the particle vertex shader. */
export function ballistic(out, p0, v0, k, gy, t, outVel) {
  const kt = k * t;
  let e, tme, ek;
  if (kt < 0.02) { e = t * (1 - 0.5 * kt + (kt * kt) / 6); tme = t * t * (0.5 - kt / 6); ek = 1 - kt + 0.5 * kt * kt; }
  else { ek = Math.exp(-kt); e = (1 - ek) / k; tme = (t - e) / k; }
  out.set(p0.x + v0.x * e, p0.y + v0.y * e + gy * tme, p0.z + v0.z * e);
  if (outVel) outVel.set(v0.x * ek, v0.y * ek + gy * e, v0.z * ek);
  return out;
}

/** Random unit vector inside a cone of half-angle `ang` around unit `dir`. */
function coneDir(out, dir, ang) {
  const t = Math.abs(dir.y) < 0.95 ? _u.set(0, 1, 0) : _u.set(1, 0, 0);
  const s1 = _w.crossVectors(dir, t).normalize();
  const s2 = t.crossVectors(s1, dir);
  const r = Math.sqrt(Math.random()) * Math.tan(ang), ph = Math.random() * 6.2832;
  return out.copy(dir).addScaledVector(s1, Math.cos(ph) * r).addScaledVector(s2, Math.sin(ph) * r).normalize();
}
function randDir(out) {
  const z = rnd(-1, 1), ph = Math.random() * 6.2832, r = Math.sqrt(1 - z * z);
  return out.set(r * Math.cos(ph), z, r * Math.sin(ph));
}

export default function createFx(game) {
  const config = {
    breath: {
      dps: 60,              // damage per second at full strength (kind 'fire')
      muzzle: 70,           // m/s relative to the mouth, on top of the dragon's velocity
      drag: 0.6,            // 1/s linear drag (particles and packets)
      buoyancy: 3,          // m/s² upward
      life: 1.15,           // s
      spread: 0.12,         // rad cone half-angle
      fullRange: 35,        // m from the mouth: full damage
      maxRange: 60,         // m: linear falloff to 0
      tickHz: 10,           // damage ticks per second (aggregated per target)
      packetHz: 30,         // CPU hit packets spawned per second
      hitRadius0: 0.8,      // packet radius at the mouth (m)
      hitRadiusK: 0.2,      // + per metre travelled
      rate: 340,            // flame particles per second (× quality.particles)
      burnTime: 2.5,        // s of burning status after the last touch
      burnDps: 4,           // damage-over-time while burning (0 = visual only)
      // wave 5: a cloud puts the burning out once the target is this many metres inside its surface (clouds.inside;
      // without it cloudDensity ≥ wetDensity). The smooth density ramp is > 0 from ~50 m outside and 0.5 at +10 m,
      // so the old "density > 0.35" fired ~2 m outside the surface.
      wetInside: 10, wetDensity: 0.5,
      // chase-view readability (visual only; the damage packets above are unchanged)
      fan: 0.14,            // tongues fan out at this fraction of muzzle speed when the stream is seen along its axis
      licks: 44,            // side-licking tongues per second curling out of the jaws
      coreLife: 0.42,       // s of centreline drawn as the white-hot core line (≈ 26 m when hovering)
      lodNear: 150,         // m: full emission within this camera distance…
      lodFar: 550,          // …falling to 30 % here (many enemy streams stay cheap)
      // feel fix: a stream passing the lens (nearCut) — tongues shrink within nearShrink m, end before nearKill m;
      // hostile streams leave less, smaller shadow smoke (dark puffs cluttered the fight) and a brighter core line
      nearShrink: 16, nearKill: 4, hostileSmoke: 0.28, hostileCore: 1.35,
      // wave 4: shadowfire is soft and emissive (fewer, slightly larger tongues); a hostile stream whose mouth is near
      // the camera draws smaller (× hostileNear) and fewer (× hostileNearRate) tongues within 35 m, all of them from 60 m
      softRate: 0.8, hostileNear: 0.4, hostileNearRate: 0.6,
      // wave 4: Sora's stream seen from behind (chase / rider view; the camera sits ~4 m off the stream's axis, so the
      // whole stream projects into ~60 px) reads as a jet flying at the reticle, not a bush on the head: chaseSoft of
      // the tongues glow soft and fade in over the first chaseFadeIn of their life (nothing billows at the mouth), they
      // grow late (grow power chaseGrow < 1), are chaseSize as big, streak toward (never past) their vanishing point,
      // less fan / licks / smoke (× chaseSmoke), fast jet streaks (chaseJet /s) and a longer hot core line
      chaseSoft: 0.9, chaseFadeIn: 0.4, chaseSize: 0.7, chaseGrow: 0.7, chaseStretch: 0.06, chaseSmoke: 0.35, chaseJet: 110,
      chaseCoreLife: 0.62,
      // flight moves — fx.breath(src, on, { mode: 'inferno' }) (or game.player.infernoActive / 'special' inferno): the
      // super breath. Multipliers on the numbers above: dps ×3, reach ×1.5 (muzzle ×1.4, life ×1.1, drag ×0.92 → ≈ 89 m
      // when hovering, fullRange / maxRange ×1.5), a wider cone (spread ×1.7, hit radius ×1.5), bigger (size) and denser
      // (rate) white-gold tongues, a wider / hotter core line, energy rings travelling down the beam (rings /s), heat
      // shimmer strokes hugging it (shimmer /s) and a white-gold light. It blends in over `blend` s (out 1.5× faster).
      // Fix pass (playtester: "opaque beige worms over a third of the screen"): the shimmer was 44 strokes/s of 2–14 m
      // quads up to ~23 m off the axis; now 12/s, 0.4× as bright, each stroke centred inside the flame envelope's own
      // radius R at that point of the beam and ≤ 0.4 R big (nothing shows past ~1.3 R), none within shimmerNear m of
      // the camera (faded over the next 12 m), × shimmerChase as many seen along the beam from behind.
      inferno: { dps: 3, range: 1.5, muzzle: 1.4, life: 1.1, drag: 0.92, spread: 1.7, hit: 1.5, size: 1.3, rate: 1.3,
        core: 1.45, light: 1.8, rings: 9, shimmer: 12, shimmerNear: 12, shimmerChase: 0.4, blend: 0.25 },
      // flight moves: the player's 'skyfall' buff (a dive pull-out at high momentum) — breath damage × this. Applied only
      // when the caller passes no explicit damageMult (fx.breath opts) and the source has no breathDamageMult.
      skyfall: 1.5,
    },
    // wave 4: explosions near the camera never fill the view. Visual only: damage, splash, light and shake use the
    // real radius. The explosion's extent (≈ 2.8 R) is scaled so its on-screen radius stays ≤ maxScreen of the view
    // height; within softNear m its fire is drawn soft, at nearOpacity at opaqueAt m and closer, and dies faster.
    // A fireball's trail and corona turn soft within fireballNear m of the camera (fireballOpacity at 40 % of that).
    // A fireball's own inked core stays ≤ orbMaxScreen of the view height on screen (a volley flying past the lens).
    explosion: { maxScreen: 0.4, softNear: 60, opaqueAt: 30, nearOpacity: 0.35, nearLife: 0.6, fireballNear: 45, fireballOpacity: 0.4,
      orbMaxScreen: 0.12 },
    fireball: {
      splash: 2.6,          // splash radius = radius × this (unless given)
      splashMult: 0.5,      // splash damage = damage × this (unless given)
      titanHp: 40,          // titan fireballs can be burned down by opposing breath (0 = indestructible)
      // flight moves — fx.fireball({ …, charged: level 0..1 }): pass the normal radius / damage / launch velocity; at
      // level L the hit radius grows × (1 + chargedRadius·L), the visual × (1 + chargedVisual·L), the speed relative to
      // the owner × (1 + chargedSpeed·L) (opt out: chargedSpeed: false), the splash radius × (1 + chargedSplash·L) and
      // the splash damage share + chargedSplashDmg·L. Damage itself is the caller's.
      chargedRadius: 0.45, chargedVisual: 0.75, chargedSpeed: 0.3, chargedSplash: 0.6, chargedSplashDmg: 0.4,
    },
    shake: true,            // explosions shake game.cameraRig when near the camera
    deathFx: true,          // a kill flash for every dragon, a compact burst + smoke puff for drakes (on 'death')
    // Levels and elements — L7+ (element 'lightning' | 'storm'): the breath is a crackling lightning beam from the mouth
    // along the aim (hitscan, what you see is what hits): damage like the breath (config.breath.dps × falloff: full to
    // fullRange, 0 at maxRange; hit spheres hitRadius0 + hitRadiusK·d every `step` m, the inferno's reach / width / dps
    // multipliers apply), then chain arcs from the strongest hit to up to game.progress.chain more enemies, each within
    // chainRadius m of the previous, every jump × chainFalloff of the previous (60 % → 36 % → 21.6 %…). Storm (L9–10)
    // also breathes gold fire around the beam: stormFireRate of the tongues, dealing stormFire of the fire damage (and
    // burning). Visuals: `strands` jagged arcs (storm: stormStrands; inferno ×1.6) struck arcHz times a second, each
    // living arcLife (the previous generations fade under the new one: the afterimage), crackle sparks, a strobing
    // light; targets crackle for `shock` s. The bolt (F): relative speed × bolt.speed, re-aimed for its own speed when
    // the shooter's lead was for a fireball (≤ bolt.retarget °), homing bolt.homing m/s² for bolt.homingTime s.
    lightning: {
      fullRange: 42, maxRange: 66, step: 2.5, hitRadius0: 0.9, hitRadiusK: 0.17, damage: 1,
      chainRadius: 25, chainFalloff: 0.6, stormFire: 0.3, stormFireRate: 0.6,
      strands: 4, stormStrands: 5, arcHz: 24, arcLife: 0.1, amp: 0.085, chainAmp: 0.13, width: 0.8, crackle: 40, glow: 30, shock: 0.4,
      // fix pass (playtester rank 1 "thin white-lavender threads"): CSS-px floors of the strands' half widths (the main
      // strand ≥ 10 px wide at any range, the others ≥ 4.4 px), its zigzag, the side strands' width share, the haze channel
      // along the beam (half width m, px floor, intensity), the element-coloured mouth flash (size m, intensity) and
      // the hit-point bloom's px floor (radius)
      mainPx: 5, mainAmp: 0.04, strandPx: 2.2, strandW: 0.45, haze: { width: 1.3, px: 7, intensity: 1.35 }, mouth: { size: 2.3, intensity: 0.7 }, hitPx: 26,
      // bolt: the head arc (trail m), the lightning channel back toward the launch point (≤ channel m, jag ≈ channelJag m)
      // fix pass (rank 2 "the bolt does not look powerful"): px floors of the head / channel / return stroke, the
      // return stroke held `strokeHold` s at full, the thunder flash's screen floor (flashPx, radius), the screen
      // flash (peak at the view's edges, never on the centre) and the thunder kick of the camera for Sora's hits
      bolt: { speed: 3.2, retarget: 7, homing: 520, homingTime: 1.0, trail: 34, width: 0.9, channel: 220, channelJag: 5, chainDelay: 0.035,
        headPx: 4, channelPx: 2.6, strokePx: 3.2, strokeLife: 0.24, strokeHold: 0.15, flashPx: 56, screenFlash: 0.26, kick: 0.14 },
    },
    // Levels and elements: radiant / storm twinkles per second in the stream; the level-up burst around Sora (on the
    // 'levelup' event, or fx.levelUp()).
    elements: { sparkle: 48, levelUp: true },
  };

  let E = null, orbs = null, lights = null, ribbons = null, shock = null, moves = null, arcs = null, sflash = null;
  const streams = new Map();
  const projectiles = [];
  const charges = [];
  const smokers = new Map();
  const burning = new Map();
  const timedLights = [];
  let simT = 0;
  let nextId = 1;
  const stat = { spawned: 0, ticks: 0, fireDamage: 0, bursts: 0, killFlashes: 0, beamTicks: 0, beamDamage: 0, chains: 0, chainDamage: 0,
    bolts: 0, boltHits: 0, levelUps: 0 };
  const shocked = new Map();            // actor → { until, off, acc } (lightning crackles on what it hit)
  const flashOrbs = [];                 // bolt impacts: short inked cel flash balls { slot, t0, life, r0, r1 } (fix pass)
  const deathDone = new WeakSet();
  const _pts = Array.from({ length: 24 }, () => new V3());

  const ensure = () => {
    if (E) return true;
    try {
      E = getParticles(game);
      orbs = createOrbs(game, E.tex, 96);
      const n = { low: 0, medium: 2, high: 4, ultra: 4 }[game.quality?.tier || game.quality?.name] ?? 4;
      lights = createFireLights(game, n);
      ribbons = createRibbons(game, E.tex, 32, 20);
      try { arcs = createArcs(game, { maxRibbons: 224, points: 17, maxArcs: 190 }); } catch (e) { console.error('[fx] arcs init failed', e); arcs = null; }
      try { sflash = createScreenFlash(game); } catch (e) { console.error('[fx] screen flash init failed', e); sflash = null; }
      try {
        shock = createShock(game, E.tex, { rings: 64, cones: 4 });
        moves = createMoveFx(game, { E, shock, orbs, lights, spawn, arcs, palette: () => playerPalette(),
          hasDragonCharge: () => charges.some((c) => c.kind === 'dragon') });
      } catch (e) { console.error('[fx] flight-move fx init failed', e); shock = null; moves = null; }
      return true;
    } catch (e) {
      console.error('[fx] init failed', e);
      return false;
    }
  };

  // ---------- helpers ----------
  const actorOf = (o) => (o ? (o.actor || (o.team ? o : null)) : null);
  const opposing = (team) => (team === 'player' ? 'enemy' : 'player');
  /**
   * Faction name for any fire source: a Dragon, an actor, a flame proxy ({ actor, team }), the titan…
   * Order: explicit src.fireFaction → titan kind → dragon variant (membrane colour) → team.
   */
  function factionOf(src, kindHint) {
    if (!src) return kindHint === 'titan' ? 'titan' : null;
    if (src.fireFaction && FACTIONS[src.fireFaction]) return src.fireFaction;
    const a = actorOf(src);
    const kind = kindHint === 'titan' ? 'titan' : (src.kind || a?.kind);
    if (kind === 'titan') return 'titan';
    const variant = src.variant ?? src.dragon?.variant ?? a?.dragon?.variant ?? a?.variant;
    if (variant && VARIANT_FACTION[variant]) return VARIANT_FACTION[variant];
    const team = a?.team || src.team;
    if (team === 'player') return 'player';
    if (team === 'enemy') return 'enemy';
    return null;
  }
  /** A source's palette: its faction's, except that Sora's (the player's) fire follows her element. */
  function facFor(src, kind, team) {
    const f = FACTIONS[factionOf(src, kind) || (kind === 'titan' ? 'titan' : team === 'player' ? 'player' : 'enemy')];
    return f === FACTIONS.player && src && isPlayerSrc(src) ? playerPalette() : f;
  }
  const facOfRow = (row) => PAL_BY_ROW[row] || FACTIONS.player;
  // ---------- levels and elements ----------
  /** Sora's element from game.progress (feature-detected; 'ember' without it). Never throws. */
  function playerElement() {
    try { const e = game.progress?.element; return ELEMENTS[e] ? e : 'ember'; } catch { return 'ember'; }
  }
  /** (levels update) Sora's palette: her element's — the prism palette once she has ascended (L11+). */
  const ascended = () => { try { return game.progress?.ascended === true; } catch { return false; } };
  const playerPalette = () => (ascended() ? ELEMENTS.prism : ELEMENTS[playerElement()]);
  let prismDirty = false;
  /** Element palette of a fire source: explicit (breath / fireball opts, src.fireElement), else Sora's, else null. */
  function elementOf(src, explicit) {
    const e = explicit ?? src?.fireElement;
    if (e && ELEMENTS[e]) return e === 'storm' && src && isPlayerSrc(src) && ascended() ? ELEMENTS.prism : ELEMENTS[e];
    return src && isPlayerSrc(src) ? playerPalette() : null;
  }
  /** Sora's level damage multiplier (game.progress.dmgMult) for her breath ticks; 1 for everyone else. */
  function levelMult(src) {
    if (!src || !isPlayerSrc(src)) return 1;
    try { const m = +game.progress?.dmgMult; return Number.isFinite(m) && m > 0 ? clamp(m, 0.1, 10) : 1; } catch { return 1; }
  }
  /** Chain jumps: game.progress.chain while the palette is Sora's current element, else the palette's own. */
  function chainCount(pal, src) {
    if (!pal?.arcs) return 0;
    try {
      const pr = game.progress;
      if (pr && src && isPlayerSrc(src) && pr.element === pal.name) { const c = +pr.chain; if (Number.isFinite(c) && c >= 0) return Math.min(8, Math.round(c)); }
    } catch { /* ignore */ }
    return pal.chain || 0;
  }
  const sparkRow = (row) => facOfRow(row).spark;
  const lightColor = (row) => facOfRow(row).light;
  const smokeRow = (row) => facOfRow(row).smoke;
  /** Flame size: src.fireScale, else smaller dragons (drakes) breathe proportionally smaller fire. */
  function fireScaleOf(src) {
    if (src.fireScale != null) return src.fireScale;
    const sc = src.scale ?? src.dragon?.scale ?? actorOf(src)?.dragon?.scale;
    return sc > 0 && sc < 0.95 ? clamp(sc * 1.15, 0.5, 1) : 1;
  }
  /** Small dragons that die in numbers: compact, cheap death effects. */
  function isDrake(a) {
    if (!a) return false;
    const v = a.dragon?.variant ?? a.variant;
    return v === 'drake' || a.drake === true || a.size === 'small' || /\bdrake\b/i.test(a.name || '');
  }
  const actorList = () => game.actors || [];
  function actorAt(point, maxD = 1.5) {
    let best = null, bd = maxD * maxD;
    for (const a of actorList()) {
      if (a.kind !== 'dragon' || !a.pos?.isVector3) continue;
      const d2 = a.pos.distanceToSquared(point);
      if (d2 < bd) { bd = d2; best = a; }
    }
    return best;
  }
  function actorByRoot(obj) {
    for (const a of actorList()) if (a.root === obj || a === obj) return a;
    return null;
  }

  function readSource(src, mouth, dir, vel) {
    const root = src.root;
    if (src.mouth && src.mouth.isVector3) mouth.copy(src.mouth);
    else if (root) { root.getWorldPosition(mouth); root.getWorldDirection(_a); mouth.addScaledVector(_a, 6); }
    else if (src.pos) mouth.copy(src.pos);
    if (src.mouthDir && src.mouthDir.isVector3 && src.mouthDir.lengthSq() > 1e-6) dir.copy(src.mouthDir).normalize();
    else if (root) root.getWorldDirection(dir);
    else dir.set(0, 0, 1);
    const v = src.vel || actorOf(src)?.vel;
    if (v && v.isVector3) vel.copy(v); else vel.set(0, 0, 0);
  }
  function objPos(o, out) {
    if (!o) return null;
    if (o.isVector3) return out.copy(o);
    if (o.isObject3D) return o.getWorldPosition(out);
    if (o.pos?.isVector3) return out.copy(o.pos);
    if (o.root?.isObject3D) return o.root.getWorldPosition(out);
    return null;
  }
  function camDist(p) { game.camera.getWorldPosition(_cam); return _cam.distanceTo(p); }
  /** Metres per CSS px at a point's depth in front of the camera (screen-size floors for far flashes and arcs). */
  const _px0 = new V3(), _px1 = new V3();
  function pxAt(p) {
    const cam = game.camera;
    cam.getWorldPosition(_px0); cam.getWorldDirection(_px1);
    const depth = Math.max(0.5, _px1.dot(_px0.subVectors(p, _px0)));
    const H = game.renderer?.domElement?.clientHeight || 900;
    return (2 * depth * Math.tan(((cam.fov || 60) * Math.PI) / 360)) / Math.max(1, H);
  }
  /** Deep enough inside a cloud to put a fire out (config.breath.wetInside / wetDensity). Never throws. */
  function inCloudWet(p) {
    const cfg = config.breath;
    try {
      const ins = game.clouds?.inside;
      if (typeof ins === 'function') {
        const m = ins.call(game.clouds, p.x, p.y, p.z);
        if (Number.isFinite(m)) return m >= cfg.wetInside;
      }
      return (game.world?.cloudDensity?.(p.x, p.y, p.z) || 0) >= cfg.wetDensity;
    } catch { return false; }
  }
  /** Pool for a fire colour row: shadowfire burns soft and emissive, gold and molten fire keep the cel look. */
  const firePool = (row) => (SHADOW_ROWS.has(row) ? E.soft : E.flame);
  /**
   * Near-camera view of a blast of radius R at `point` (wave 4): k scales every visual size and speed so the blast's
   * extent (≈ 2.8 R) stays within maxScreen of the view height; `soft` draws its fire in the soft class at `opacity`,
   * `life` shortens it. Far blasts: k = 1, cel fire, full opacity.
   */
  const _nv4 = { d: 0, k: 1, soft: false, opacity: 1, life: 1, flash: 1, boost: 1 };
  function nearView(point, R) {
    const c = config.explosion;
    const d = camDist(point);
    const tanH = Math.tan(((game.camera.fov || 60) * Math.PI) / 360);
    const frameH = 2 * Math.max(d, 0.5) * tanH;
    _nv4.d = d;
    _nv4.k = clamp((c.maxScreen * frameH) / Math.max(2.8 * R, 1e-3), 0.1, 1);
    _nv4.soft = d < c.softNear;
    _nv4.opacity = mix(c.nearOpacity, 1, smoothstep(c.opaqueAt, c.softNear, d));
    _nv4.life = mix(c.nearLife, 1, smoothstep(c.opaqueAt * 0.66, c.softNear, d));
    _nv4.flash = mix(0.45, 1, smoothstep(c.opaqueAt * 0.66, c.softNear, d));
    _nv4.boost = _nv4.soft ? mix(1.5, 1, _nv4.opacity) : 1;     // translucent near fire glows a little brighter
    return _nv4;
  }

  // ---------- near-camera readability (feel fix, 24.09) ----------
  // A hostile stream aimed at the player passes the chase camera: 2–4 m flame tongues a few metres from the lens
  // filled the screen with opaque violet blobs ("what is that violet thing?"). Every flame / smoke particle of a
  // stream is checked once, at emission, against the camera's extrapolated path (closed-form motion, 8 samples):
  // one that would pass within nearShrink m is drawn smaller (its on-screen size stays bounded), one that would
  // touch the lens ends just before it does. What burns is unchanged (the damage packets are separate).
  const camNow = new V3(), camVel = new V3(), _nc = new V3(), _nv = new V3(), _nq = new V3();
  let camPrevT = -1;
  function trackCamera() {
    const now = game.time.now;
    game.camera.getWorldPosition(_nq);
    if (camPrevT >= 0 && now > camPrevT) {
      const k = Math.min(1, (now - camPrevT) * 12);
      _nv.subVectors(_nq, camNow).divideScalar(now - camPrevT).clampLength(0, 150);
      camVel.lerp(_nv, k);
    } else if (camPrevT < 0) camVel.set(0, 0, 0);
    camNow.copy(_nq); camPrevT = now;
  }
  function nearCut(P) {
    const cfg = config.breath, life = P.life;
    if (!(life > 0)) return;
    const lead = P.t0 - game.time.now;                     // the particle starts at t0 (smoke is launched "ahead")
    _nv.set(P.vx, P.vy, P.vz); _nq.set(P.x, P.y, P.z);
    let dmin = Infinity, tmin = 0;
    for (let i = 1; i <= 8; i++) {
      const t = life * i / 8;
      ballistic(_nc, _nq, _nv, P.drag, P.grav, t);
      const d = _nc.distanceTo(_cam.copy(camNow).addScaledVector(camVel, lead + t));
      if (d < dmin) { dmin = d; tmin = t; }
    }
    if (dmin < cfg.nearKill) P.life = Math.max(0.03, tmin - life / 8);
    else if (dmin < cfg.nearShrink) {
      const k = Math.max(0.22, (dmin - cfg.nearKill) / (cfg.nearShrink - cfg.nearKill));
      P.size1 *= k; P.size0 *= Math.max(0.5, k);
    }
  }

  function spawn(pool, P) { pool.push(P); stat.spawned++; }

  // ---------- breath ----------
  function streamFor(src) {
    let s = streams.get(src);
    if (!s) {
      s = {
        src, on: false, ramp: 0, has: false, fac: FACTIONS.player, row: ROW.player, hotRow: ROW.inferno, lod: 1,
        // flight moves: mode 'normal' | 'inferno' (explicit from breath opts, else auto from the player's inferno state),
        // inf = 0..1 blend, the live stream parameters (muzzle m/s, life s, drag k, spread rad) and an explicit damage ×
        mode: 'normal', modeAuto: true, inf: 0, infFlag: false, infStart: false, dmgMult: null,
        muzzle: config.breath.muzzle, life: config.breath.life, k: config.breath.drag, spread: config.breath.spread,
        acc: { flame: 0, core: 0, blade: 0, ember: 0, smoke: 0, glow: 0, lick: 0, line: 0, jet: 0, ring: 0, shimmer: 0 },
        mouth: new V3(), dir: new V3(0, 0, 1), vel: new V3(),
        pMouth: new V3(), pDir: new V3(0, 0, 1), pVel: new V3(),
        packets: [], packetAcc: 0, tickAcc: 0, offT: 0,
        // levels and elements: an explicit element (breath opts, sticky until changed; null = auto), the resolved
        // palette / name, and the lightning beam's last tick (end distance, hits along it, chain links)
        elemExplicit: null, elem: null, arcAcc: 0,
        beam: { endD: 0, ground: false, hits: [], links: [], t: -1, linkT: -1 },
        // centreline history for the core line: [p0 xyz, v0 xyz, t0] × 48 (60 Hz ≈ 0.8 s)
        hist: new Float32Array(48 * 7), histHead: 0, histN: 0, seed: Math.random(),
      };
      streams.set(src, s);
    }
    return s;
  }
  /** Resolve a stream's colours from its source (explicit src.fireRow wins). */
  function streamColours(s) {
    const src = s.src;
    const pal = src.fireRow != null ? null : elementOf(src, s.elemExplicit);
    if (src.fireRow != null) { s.row = src.fireRow; s.fac = facOfRow(src.fireRow); }
    else if (pal) { s.fac = pal; s.row = pal.row; }
    else {
      s.fac = facFor(src, src.kind === 'titan' || actorOf(src)?.kind === 'titan' ? 'titan' : 'dragon', actorOf(src)?.team || src.team || 'enemy');
      s.row = s.fac.row;
    }
    // inferno colours are the element's hot row (Sora's ember: white-gold); any other faction keeps its own fire
    s.hotRow = s.fac.hot ?? s.row;
    s.elem = s.fac.mine ? s.fac.name : null;
  }
  /** Levels and elements: follow a level-up mid-stream (fixed step and frame); a changed element flares at the mouth. */
  function refreshElement(s) {
    if (!s.on || s.src.fireRow != null) return;
    const pal = elementOf(s.src, s.elemExplicit);
    if (!pal || pal === s.fac) return;
    streamColours(s);
    s.flare = true;
  }

  // ---------- flight moves: inferno mode, skyfall, damage multiplier ----------
  const ev = { skyfall: false, skyfallT: -1e9, inferno: false, infernoT: -1e9 };
  const isPlayerSrc = (src) => !!src && (src === game.player || (!!game.player?.actor && actorOf(src) === game.player.actor));
  /** The player's skyfall buff (game.player.skyfall / buffs.skyfall, else the latest 'momentum' event). */
  function skyfallOn() {
    const p = game.player;
    if (!p) return false;
    const v = p.skyfall ?? p.buffs?.skyfall;
    if (typeof v === 'number') return v > 0;
    if (typeof v === 'boolean') return v;
    if (v && typeof v === 'object') return !!(v.on || v.active || (v.t ?? v.left ?? v.time ?? v.until - game.time.now) > 0);
    return ev.skyfall && game.time.now - ev.skyfallT < 3.3;
  }
  function autoInferno(src) {
    if (!isPlayerSrc(src)) return false;
    const a = game.player?.infernoActive;
    if (typeof a === 'boolean') return a;
    if (typeof a === 'number') return a > 0;
    return ev.inferno && game.time.now - ev.infernoT < 6;
  }
  function breathMult(s) {
    // (the level multiplier, game.progress.dmgMult, is applied on top of this by levelMult)
    if (s.dmgMult != null) return s.dmgMult;
    const m = s.src.breathDamageMult;
    if (Number.isFinite(m)) return m;
    return isPlayerSrc(s.src) && skyfallOn() ? config.breath.skyfall : 1;
  }
  /** Fixed step: blend toward the wanted mode and derive the live stream parameters (visuals and packets share them). */
  function updateMode(s, dt) {
    const cfg = config.breath, I = cfg.inferno;
    const want = s.on && (s.mode === 'inferno' || (s.modeAuto && autoInferno(s.src))) ? 1 : 0;
    const r = dt / Math.max(0.02, I.blend);
    s.inf = want > s.inf ? Math.min(1, s.inf + r) : Math.max(0, s.inf - r * 1.5);
    if (s.inf > 0.05 && !s.infFlag) { s.infFlag = true; s.infStart = true; }
    else if (s.inf <= 0.01) s.infFlag = false;
    const f = s.inf;
    s.muzzle = cfg.muzzle * mix(1, I.muzzle, f);
    s.life = cfg.life * mix(1, I.life, f);
    s.k = cfg.drag * mix(1, I.drag, f);
    s.spread = cfg.spread * mix(1, I.spread, f);
  }

  function breathVisuals(s, dt) {
    const src = s.src, cfg = config.breath, P = E.P, I = cfg.inferno;
    refreshElement(s);
    readSource(src, s.mouth, s.dir, s.vel);
    if (!s.has) { s.pMouth.copy(s.mouth); s.pDir.copy(s.dir); s.pVel.copy(s.vel); s.has = true; }
    s.ramp = Math.min(1, s.ramp + dt / 0.08);
    const row = s.row, fac = s.fac;
    // flight moves: the inferno blend (0..1) and the live stream parameters (updateMode, shared with the packets)
    const inf = s.inf || 0, hotRow = s.hotRow ?? row;
    const MZ = s.muzzle, LF = s.life, KD = s.k, SP = s.spread;
    const pickRow = (bias = 1) => (inf > 0 && Math.random() < inf * bias ? hotRow : row);
    const scale = fireScaleOf(src) * mix(1, I.size, inf);
    const now = game.time.now, t0 = now - dt;
    const md = _d, mv = _e, dir = _f;
    // distance LOD: far enemy streams emit fewer, slightly bigger particles and skip the fine layers
    const cd = camDist(s.mouth);
    s.lod = cd <= cfg.lodNear ? 1 : clamp(1 - 0.7 * (cd - cfg.lodNear) / Math.max(1, cfg.lodFar - cfg.lodNear), 0.3, 1);
    const q = E.quality * s.lod, big = 1 / Math.sqrt(s.lod);
    const fine = cd < cfg.lodFar * 0.75;
    // feel fix: particles of a stream that can reach the camera are checked against it (see nearCut)
    const cut = cd < MZ * LF + 60 ? nearCut : null;
    const hostile = !s.fac.mine;
    // levels and elements: lightning draws no flame (arcs instead); storm keeps stormFireRate of the gold fire
    const fireOn = s.fac.fire !== false, arcOn = !!s.fac.arcs && !!arcs;
    // (levels update: the prism flame burns at full rate around its beam — fac.fireRate)
    const FR = fireOn ? (arcOn ? (s.fac.fireRate ?? config.lightning.stormFireRate) : 1) : 0;
    const shadow = SHADOW_ROWS.has(row);                  // violet / indigo shadowfire: soft emissive class
    const pool = shadow ? E.soft : E.flame;
    // wave 4: a hostile stream whose mouth is near the camera draws smaller tongues (it passes the lens)
    const nearK = hostile ? smoothstep(35, 60, cd) : 1;
    const hk = mix(cfg.hostileNear, 1, nearK);
    const hr = mix(cfg.hostileNearRate, 1, nearK);           // …and fewer of them (the core line and glow stay)
    // wave 4: Sora's stream seen along its axis from behind (chase / rider camera) → 1
    game.camera.getWorldDirection(_camFwd);
    const chase = hostile ? 0 : smoothstep(0.5, 0.88, _camFwd.dot(s.dir)) * (1 - smoothstep(35, 70, cd));
    s.chase = chase;
    // flight moves: the skyfall buff runs Sora's fire a little hotter (brighter core line, more embers)
    const sky = !hostile && isPlayerSrc(src) && skyfallOn() ? 1 : 0;
    s.sky = sky;

    const emit = (key, rate, fn) => {
      s.acc[key] = (s.acc[key] || 0) + rate * dt;
      const n = Math.floor(s.acc[key]);
      s.acc[key] -= n;
      for (let i = 0; i < n; i++) {
        const f = (i + Math.random()) / n;
        E.reset();
        P.t0 = t0 + f * dt;
        md.lerpVectors(s.pMouth, s.mouth, f);
        dir.lerpVectors(s.pDir, s.dir, f).normalize();
        mv.lerpVectors(s.pVel, s.vel, f);
        fn(P, md, dir, mv);
      }
    };
    const ramp = s.ramp;
    const fan = cfg.fan * MZ * scale;
    if (s.infStart) { s.infStart = false; infernoFlourish(s, scale); }
    if (s.flare) { s.flare = false; infernoFlourish(s, scale * 0.8, true); }
    // Main flame tongues (they fan out when the stream is seen along its axis — see particles.js FLAME_CLASS).
    emit('flame', cfg.rate * q * ramp * hr * FR * (shadow ? cfg.softRate : 1) * mix(1, I.rate, inf), (P, m, d, v) => {
      coneDir(_a, d, SP);
      const sp = MZ * rnd(0.82, 1.08);
      P.x = m.x; P.y = m.y; P.z = m.z;
      P.vx = _a.x * sp + v.x; P.vy = _a.y * sp + v.y; P.vz = _a.z * sp + v.z;
      P.life = LF * rnd(0.72, 1.05);
      // seen from behind the whole stream projects into ~60 px between the mouth and its vanishing point (the chase
      // camera is ~4 m off its axis), so the tongues are narrow there (chaseSize) and converge on the reticle
      P.size0 = rnd(0.3, 0.45) * scale * mix(1, 0.4, chase);
      P.size1 = rnd(2.3, 3.5) * scale * big * hk * mix(1, cfg.chaseSize, chase) * (shadow ? 1.12 : 1);
      P.drag = KD; P.grav = cfg.buoyancy; P.stretch = mix(0.035, cfg.chaseStretch, chase); P.grow = mix(1.8, cfg.chaseGrow, chase);
      P.heat = rnd(0.82, 1.04); P.cool = 0.35 * mix(1, 0.7, inf); P.row = pickRow(); P.spin = rnd(-1.6, 1.6);
      P.fan = fan * rnd(0.6, 1.2) * (1 - 0.8 * chase);
      // seen from behind, part of Sora's tongues glow soft (the target shows through), the rest stay thin cel tongues
      const soft = shadow || (chase > 0 && Math.random() < cfg.chaseSoft * chase);
      // young tongues at the mouth stay thin / fade in, so the head, Kaede and the reticle are not buried
      if (soft) { P.opacity = shadow ? 1 : mix(1, 0.55, chase); P.fadeIn = cfg.chaseFadeIn * chase; }
      else P.shape = chase;                                // cel class: thin young tongues (no billow at the mouth)
      cut?.(P);
      spawn(soft ? E.soft : E.flame, P);
    });
    // Side licks: short tongues curling sideways out of the jaws — they widen the stream at the mouth, so it still
    // reads around the dragon's head from the chase camera.
    if (fine) emit('lick', cfg.licks * q * ramp * hr * FR * (1 - 0.85 * chase) * (shadow ? cfg.softRate : 1), (P, m, d, v) => {
      const up = Math.abs(d.y) < 0.95 ? _u.set(0, 1, 0) : _u.set(1, 0, 0);
      const side = _w.crossVectors(d, up).normalize();
      const upv = _b.crossVectors(side, d);
      const ph = Math.random() * 6.2832;
      const lat = rnd(9, 18) * scale;
      const sx = Math.cos(ph), sy = Math.sin(ph) * 0.6 + 0.25;       // mostly sideways, a little upward
      const sp = MZ * rnd(0.3, 0.55);
      P.x = m.x + d.x * 0.6; P.y = m.y + d.y * 0.6; P.z = m.z + d.z * 0.6;
      P.vx = d.x * sp + (side.x * sx + upv.x * sy) * lat + v.x;
      P.vy = d.y * sp + (side.y * sx + upv.y * sy) * lat + v.y;
      P.vz = d.z * sp + (side.z * sx + upv.z * sy) * lat + v.z;
      P.life = rnd(0.24, 0.4); P.size0 = rnd(0.35, 0.5) * scale; P.size1 = rnd(1.5, 2.3) * scale * hk;
      P.drag = 2.2; P.grav = cfg.buoyancy * 1.5; P.stretch = 0.05; P.grow = 1.6;
      P.heat = rnd(0.9, 1.02); P.cool = 0.5; P.row = pickRow(); P.spin = rnd(-2, 2);
      cut?.(P);
      spawn(pool, P);
    });
    // Hot core painted over the flame bodies near the mouth (additive, pulled toward the camera).
    if (fine) emit('blade', 45 * q * ramp * FR * mix(1, 1.3, inf), (P, m, d, v) => {
      coneDir(_a, d, SP * 0.5);
      const sp = MZ * rnd(0.9, 1.05);
      P.x = m.x; P.y = m.y; P.z = m.z;
      P.vx = _a.x * sp + v.x; P.vy = _a.y * sp + v.y; P.vz = _a.z * sp + v.z;
      P.life = rnd(0.1, 0.18) * (1 + 0.8 * chase); P.size0 = 0.14 * scale; P.size1 = rnd(0.45, 0.65) * scale;
      P.drag = KD; P.grav = 0; P.stretch = 0.03 + 0.05 * chase; P.grow = 1.6;
      P.shape = GLOW.blade; P.row = pickRow(1.4); P.heat = 1.0; P.cool = 0.4; P.intensity = (0.4 + 0.25 * chase) * mix(1, 1.3, inf); P.squash = 1.2 * scale;
      spawn(E.glow, P);
    });
    // White-hot core jet right at the mouth.
    emit('core', 200 * q * ramp * FR, (P, m, d, v) => {
      coneDir(_a, d, SP * 0.45);
      const sp = MZ * rnd(0.95, 1.1);
      P.x = m.x; P.y = m.y; P.z = m.z;
      P.vx = _a.x * sp + v.x; P.vy = _a.y * sp + v.y; P.vz = _a.z * sp + v.z;
      P.life = rnd(0.1, 0.19) * mix(1, 1.3, inf); P.size0 = 0.16 * scale; P.size1 = rnd(0.55, 0.8) * scale * mix(1, 0.7, chase) * (shadow ? 1.2 : 1);
      P.drag = KD; P.grav = 0; P.stretch = 0.03 + 0.05 * chase; P.grow = 1.5;
      P.heat = 1.05; P.cool = 0.0; P.row = pickRow(1.4); P.intensity = 1.15;
      cut?.(P);
      spawn(pool, P);
    });
    // Jet streaks (wave 4, seen from behind only): fast white-gold sparks along the stream's axis. From the chase camera
    // they are lines converging on the reticle, so the stream reads as a jet flying away, not a fire on the head.
    if (chase > 0.05 && FR > 0) emit('jet', cfg.chaseJet * q * ramp * chase * FR * mix(1, 1.4, inf), (P, m, d, v) => {
      coneDir(_a, d, SP * 0.7);
      const sp = MZ * rnd(0.95, 1.15);
      P.x = m.x + _a.x * 1.2; P.y = m.y + _a.y * 1.2; P.z = m.z + _a.z * 1.2;
      P.vx = _a.x * sp + v.x; P.vy = _a.y * sp + v.y; P.vz = _a.z * sp + v.z;
      P.life = rnd(0.28, 0.5) * mix(1, 1.15, inf); P.size0 = P.size1 = rnd(0.05, 0.09) * scale;
      P.drag = KD; P.grav = 0; P.stretch = 0.06; P.shape = GLOW.streak;
      P.heat = 1.0; P.cool = 0.8; P.row = inf > 0.5 ? hotRow : fac.spark; P.intensity = 1.1;
      spawn(E.glow, P);
    });
    // Embers: a wide spray (they also fly out sideways, which keeps the stream lively from behind).
    emit('ember', 70 * q * ramp * FR * (1 + 0.6 * chase) * (1 + 0.5 * sky) * mix(1, 1.8, inf), (P, m, d, v) => {
      coneDir(_a, d, 0.5 * mix(1, 1.2, inf));
      const sp = MZ * rnd(0.4, 0.85);
      P.x = m.x; P.y = m.y; P.z = m.z;
      P.vx = _a.x * sp + v.x; P.vy = _a.y * sp + v.y; P.vz = _a.z * sp + v.z;
      P.life = rnd(0.45, 0.95); P.size0 = P.size1 = rnd(0.04, 0.08) * scale;
      P.drag = 1.4; P.grav = -4; P.stretch = 0.035; P.shape = GLOW.streak;
      P.heat = 0.95; P.cool = 1.0; P.row = fac.spark; P.intensity = 0.85;
      spawn(E.glow, P);
    });
    // Smoke: spawned "in the future" where a flame launched now will be at ~70 % of its life.
    // (seen from behind, Sora's smoke would sit right on the target at the reticle: × chaseSmoke, smaller; the inferno
    // burns clean: half the smoke)
    emit('smoke', 14 * q * ramp * FR * (arcOn ? 0.5 : 1) * (hostile ? cfg.hostileSmoke : mix(1, cfg.chaseSmoke, chase)) * mix(1, 0.5, inf), (P, m, d, v) => {
      coneDir(_a, d, SP * 1.3);
      const sp = MZ * rnd(0.8, 1.0);
      _b.set(_a.x * sp + v.x, _a.y * sp + v.y, _a.z * sp + v.z);
      const ta = LF * rnd(0.68, 0.88);
      ballistic(_c, m, _b, KD, cfg.buoyancy, ta, _w);
      P.t0 += ta;
      P.x = _c.x; P.y = _c.y; P.z = _c.z;
      P.vx = _w.x * 0.7; P.vy = _w.y * 0.7 + 1; P.vz = _w.z * 0.7;
      P.life = rnd(0.9, 1.5); P.size0 = rnd(1.0, 1.4) * scale; P.size1 = rnd(2.2, 3.2) * scale * big * (hostile ? 0.7 * hk : mix(1, 0.7, chase));
      P.drag = 1.1; P.grav = 1.6; P.row = fac.smoke; P.heat = 0.9;
      P.spin = rnd(-0.5, 0.5);
      cut?.(P);
      spawn(E.smoke, P);
    });
    // Mouth flash (flickers because each lives ~2 frames).
    emit('glow', 45 * ramp, (P, m, d, v) => {
      P.x = m.x + d.x * 0.6; P.y = m.y + d.y * 0.6; P.z = m.z + d.z * 0.6;
      P.vx = v.x + d.x * 8; P.vy = v.y + d.y * 8; P.vz = v.z + d.z * 8;
      P.life = rnd(0.05, 0.1); P.size0 = rnd(0.8, 1.2) * scale * (1 - 0.35 * chase); P.size1 = P.size0 * 1.3;
      P.shape = GLOW.soft; P.row = pickRow(1.4); P.heat = 0.95; P.cool = 1; P.intensity = 0.45 * (1 - 0.5 * chase) * mix(1, 1.3, inf);
      spawn(E.glow, P);
    });
    // fix pass (playtester rank 9: from the hover / chase camera, 20–25 m behind the jaws, her head and neck hide the
    // first 20–30 m of her own stream, so the element read from the wings, not the fire): Sora's stream seen from
    // behind gets an element-coloured halo at the jaws that spreads past the head's silhouette, and (fire elements)
    // soft glow bodies riding the stream's centreline 8–26 m out, the part that clears her head. Additive, modest
    // (≤ 0.3; the lightning halo 0.42), none in the rider view (within 9 m of the lens).
    const back = !hostile && isPlayerSrc(src) ? chase * smoothstep(9, 16, cd) : 0;
    if (back > 0.05) {
      emit('halo', 26 * ramp * back, (P, m, d, v) => {
        P.x = m.x + d.x * 1.2; P.y = m.y + d.y * 1.2; P.z = m.z + d.z * 1.2;
        P.vx = v.x + d.x * 6; P.vy = v.y + d.y * 6; P.vz = v.z + d.z * 6;
        P.life = rnd(0.08, 0.14); P.size0 = rnd(1.6, 2.2) * scale * mix(1, 1.25, inf); P.size1 = P.size0 * 1.25;
        P.shape = GLOW.soft; P.row = arcOn && !fireOn ? ROW.lightning : pickRow(0.6); P.heat = rnd(0.72, 0.84); P.cool = 1;
        P.intensity = (arcOn && !fireOn ? 0.42 : 0.3) * back;
        spawn(E.glow, P);
      });
      if (FR > 0) emit('jglow', 30 * q * ramp * back * mix(1, 1.3, inf), (P, m, d, v) => {
        const ta = rnd(0.12, 0.4) * mix(1, 1.2, inf);
        _b.copy(d).multiplyScalar(MZ).add(v);
        ballistic(_c, m, _b, KD, cfg.buoyancy, ta, _w);
        P.t0 += ta;
        P.x = _c.x; P.y = _c.y; P.z = _c.z; P.vx = _w.x; P.vy = _w.y; P.vz = _w.z;
        P.drag = KD; P.grav = cfg.buoyancy;
        P.life = rnd(0.1, 0.18); P.size0 = rnd(1.2, 1.8) * scale; P.size1 = P.size0 * 1.4;
        P.shape = GLOW.soft; P.row = pickRow(); P.heat = rnd(0.7, 0.84); P.cool = 0.8; P.intensity = 0.26 * back;
        spawn(E.glow, P);
      });
    }
    if (inf > 0.05 && fine) {
      // Inferno energy rings: flat gold rings riding down the beam with the flow (shock.js: perpendicular to the
      // stream, so from the chase camera they are concentric rings around the beam, from the side thin ellipses)
      if (shock) emit('ring', I.rings * ramp * inf, (P, m, d, v) => {
        // (a lightning beam is instant: its rings ride out at the stream's speed without drag)
        _b.copy(d).multiplyScalar(MZ * 0.92).add(v);
        _c.copy(m).addScaledVector(d, 2.5 * scale);
        shock.ring({ pos: _c, normal: d, r0: 1.1 * scale, r1: 4.4 * scale, life: 0.38, width: 0.1, intensity: 0.75 * inf,
          style: s.fac.mine ? s.fac.ring ?? RING_STYLE.energy : RING_STYLE.energy, vel: _b, drag: arcOn && !fireOn ? 0.2 : KD, near: 9, delay: P.t0 - now });
      });
      // Heat shimmer: faint wavy strokes in the hot air of the beam (anime heat haze; there is no screen distortion).
      // A stroke starts where the stream's axis is `ta` s after launch, offset sideways inside the flame envelope's
      // radius R there (the cone's lateral spread tan(SP)·MZ·e(ta) + the tongues' half size), and then flows with the
      // stream (its velocity, its drag), so it stays inside the fire it was born in while that fire widens — and it
      // is gone by 0.55 of the stream's life, while the tongues around it (life 0.72–1.05) are still dense (a stroke
      // outliving them hung alone in the sky past the beam's end).
      emit('shimmer', I.shimmer * q * ramp * inf * (FR > 0 ? 1 : 0) * mix(1, I.shimmerChase, chase), (P, m, d, v) => {
        const a = rnd(0.08, 0.38), ta = LF * a;
        coneDir(_g, d, 1.5); _g.addScaledVector(d, -_g.dot(d));      // (coneDir uses _u / _w: before ballistic)
        if (_g.lengthSq() < 1e-6) _g.set(0, 1, 0); else _g.normalize();
        _b.copy(d).multiplyScalar(MZ).add(v);
        ballistic(_c, m, _b, KD, cfg.buoyancy, ta, _w);
        const e = KD * ta > 1e-3 ? (1 - Math.exp(-KD * ta)) / KD : ta;
        const R = Math.tan(SP) * MZ * e * 0.85 + (0.5 + 2.2 * a) * scale * mix(1, cfg.chaseSize, chase);
        const off = R * rnd(0.45, 0.95);
        _c.addScaledVector(_g, off);
        const life = Math.max(0.2, Math.min(rnd(0.3, 0.5), (0.55 - a) * LF));
        // near-camera rule: none within shimmerNear m of the lens (its start or end, against the camera's extrapolated
        // path), faded over the next shimmerNear m
        const lead = P.t0 + ta - now, el = KD * life > 1e-3 ? (1 - Math.exp(-KD * life)) / KD : life;
        _h.copy(camNow).addScaledVector(camVel, lead);
        _k.copy(_c).addScaledVector(_w, el);
        const dn = Math.min(_c.distanceTo(_h), _k.distanceTo(_h.addScaledVector(camVel, life)));
        if (dn < I.shimmerNear) return;
        P.t0 += ta;
        P.x = _c.x; P.y = _c.y; P.z = _c.z;
        P.vx = _w.x; P.vy = _w.y + 1; P.vz = _w.z;
        P.life = life; P.size0 = Math.min(0.28 * R, 3); P.size1 = Math.min(0.4 * R, 4.5);
        P.drag = KD; P.grav = cfg.buoyancy; P.shape = GLOW.heat; P.row = hotRow; P.heat = 0.9; P.cool = 0.3;
        P.intensity = rnd(0.09, 0.15) * smoothstep(I.shimmerNear, 2 * I.shimmerNear, dn); P.rot = 0; P.spin = 0; P.fadeIn = 0.3;
        spawn(E.glow, P);
      });
    }
    // Levels and elements — radiant / storm: anime twinkles riding inside the stream (additive 4-point stars)
    if (s.fac.sparkle && FR > 0 && fine) emit('sparkle', config.elements.sparkle * q * ramp * (1 - 0.5 * chase) * mix(1, 1.4, inf), (P, m, d, v) => {
      const a = rnd(0.06, 0.7), ta = LF * a;
      coneDir(_g, d, SP * 1.1);
      _b.copy(_g).multiplyScalar(MZ * rnd(0.85, 1.05)).add(v);
      ballistic(_c, m, _b, KD, cfg.buoyancy, ta, _w);
      if (_c.distanceTo(camNow) < 8) return;
      P.t0 += ta;
      randDir(_h);
      const R = (0.6 + 2.4 * a) * scale;
      P.x = _c.x + _h.x * R; P.y = _c.y + _h.y * R; P.z = _c.z + _h.z * R;
      P.vx = _w.x * 0.9; P.vy = _w.y * 0.9 + 1.5; P.vz = _w.z * 0.9;
      P.life = rnd(0.3, 0.6); P.size0 = rnd(0.3, 0.5) * scale; P.size1 = rnd(0.6, 1.0) * scale;
      P.drag = KD; P.grav = cfg.buoyancy; P.shape = GLOW.sparkle; P.row = s.fac.spark; P.heat = 1; P.cool = 0.4;
      P.intensity = rnd(0.8, 1.2); P.rot = rnd(-0.3, 0.3); P.spin = rnd(-2, 2);
      spawn(E.glow, P);
    });
    // Levels and elements — lightning / storm: the crackling beam (arcs struck 24×/s, chain links, crackle sparks)
    if (arcOn) lightningVisuals(s, dt, scale, chase, q, emit, cd);
    // Centreline history for the core line (60 Hz, sub-frame interpolated like the particles).
    if (fine && FR > 0) {
      s.acc.line += 60 * dt;
      const n = Math.floor(s.acc.line);
      s.acc.line -= n;
      for (let i = 0; i < n; i++) {
        const f = (i + 1) / n;
        md.lerpVectors(s.pMouth, s.mouth, f);
        dir.lerpVectors(s.pDir, s.dir, f).normalize();
        mv.lerpVectors(s.pVel, s.vel, f);
        const o = s.histHead * 7, H = s.hist;
        H[o] = md.x; H[o + 1] = md.y; H[o + 2] = md.z;
        H[o + 3] = dir.x * MZ + mv.x; H[o + 4] = dir.y * MZ + mv.y; H[o + 5] = dir.z * MZ + mv.z;
        H[o + 6] = t0 + f * dt;
        s.histHead = (s.histHead + 1) % 48; s.histN = Math.min(48, s.histN + 1);
      }
    }
    s.pMouth.copy(s.mouth); s.pDir.copy(s.dir); s.pVel.copy(s.vel);

    // Flickering light a few metres ahead of the mouth (lights the dragon's head and nearby wings).
    // (lightning strobes: a stepped 24 Hz flicker instead of the fire's smooth one)
    const fl = arcOn && !fireOn ? 0.7 + 0.35 * hash1(Math.floor(now * 24) + s.seed * 13)
      : 0.8 + 0.2 * Math.sin(now * 71) * Math.sin(now * 37 + 1.3) + 0.12 * Math.random();
    _a.copy(s.mouth).addScaledVector(s.dir, 3.5 * mix(1, 1.6, inf) * (arcOn ? 2.5 : 1));
    const mine = src === game.player || actorOf(src)?.team === 'player';
    const lc = inf > 0.3 ? fac.hotLight || fac.light : fac.light;
    lights.request(_a, lc, 260 * fl * ramp * scale * mix(1, I.light, inf), 34 * scale * mix(1, 1.3, inf), s, mine ? 1.5 : 1);
    // wave 4: a warm glow over Sora's neck and Kaede while she breathes (seen from behind, the stream's own light is
    // in front of them, so only their backs faced away from it)
    if (src === game.player && src.pos?.isVector3) {
      _b.lerpVectors(s.mouth, src.pos, 0.55).addScaledVector(_up, 2.6);
      lights.request(_b, lc, 190 * fl * ramp * mix(1, 1.4, inf), 13, s.glowKey || (s.glowKey = { dur: 0 }), 1.6);
    }
  }

  /**
   * The inferno igniting: a white-gold flash, two energy rings and a spark burst at the mouth, a light pulse. Also the
   * element changing mid-stream (levels and elements, `element`): the same flourish in the new element's colours.
   */
  function infernoFlourish(s, scale, element = false) {
    const P = E.P, m = s.mouth, d = s.dir, pal = s.fac;
    E.reset();
    P.x = m.x; P.y = m.y; P.z = m.z; P.vx = s.vel.x; P.vy = s.vel.y; P.vz = s.vel.z;
    P.life = 0.14; P.size0 = 3.2 * scale; P.size1 = 4.6 * scale; P.shape = GLOW.star; P.row = pal.arcs && !pal.fire ? ROW.lightning : ROW.flash;
    P.heat = 1; P.cool = 2; P.intensity = element ? 0.8 : 1.0;
    spawn(E.glow, P);
    const style = pal.mine ? pal.ring ?? RING_STYLE.energy : RING_STYLE.energy;
    if (shock) {
      _b.copy(s.vel).multiplyScalar(0.6);
      shock.ring({ pos: m, normal: d, r0: 1.5, r1: 9 * scale, life: 0.42, width: 0.09, style, vel: _b, near: 8 });
      shock.ring({ pos: m, normal: d, r0: 1, r1: 14 * scale, life: 0.55, width: 0.05, intensity: 0.7, style, vel: _b, near: 8, delay: 0.05 });
    }
    fx.sparks(m, 24, { row: pal.spark, vel: s.vel, speed: 40, life: 0.4 });
    timedLights.push({ pos: m.clone(), color: pal.hotLight || pal.light, i0: 900, range: 30, t0: game.time.now, dur: 0.35 });
  }

  /**
   * Levels and elements — the lightning beam's look, per frame: `strands` jagged arcs from the mouth, struck arcHz
   * times a second (each generation fades under the next: the afterimage). Strand 0 (thick, two forks) ends on the
   * nearest thing the last beam tick hit, the others on the other hits or at free points inside the beam's cone at
   * 55–95 % of its reach (they follow the mouth and its aim live). Chain links from the last tick flicker between the
   * targets for ~0.2 s. Crackle sparks along the beam, a flickering blue-white glow and star at the mouth.
   */
  function lightningVisuals(s, dt, scale, chase, q, emit, cd = 30) {
    const L = config.lightning, I = config.breath.inferno, P = E.P, inf = s.inf || 0, beam = s.beam;
    const storm = s.fac.fire !== false;
    const style = s.fac.arcStyle ?? ARC_STYLE.lightning;
    const fresh = beam.t >= 0 && simT - beam.t < 0.3;
    const Rr = fresh ? beam.endD : L.maxRange * mix(1, I.range, inf);
    const W = L.width * scale * mix(1, 1.45, inf) * (storm ? 1.15 : 1);
    const mine = isPlayerSrc(s.src);
    s.arcAcc += dt * L.arcHz;
    if (s.arcAcc >= 1) {
      s.arcAcc = Math.min(s.arcAcc - 1, 1);
      const nStr = Math.max(1, Math.round((storm ? L.stormStrands : L.strands) * mix(1, 1.6, inf)));
      const hits = fresh ? beam.hits : [];
      for (let k = 0; k < nStr; k++) {
        const h = k < hits.length ? hits[k] : k === nStr - 1 && hits.length ? hits[0] : null;
        let to;
        if (h && h.actor?.alive !== false && h.actor.pos) to = { ref: h.actor.pos, off: h.off };
        else {
          const dist = Rr * (k === 0 ? rnd(0.92, 1) : rnd(0.55, 0.95));
          coneDir(_g, s.dir, k === 0 ? 0.03 : 0.11);
          _h.copy(_g).sub(s.dir).multiplyScalar(dist);
          to = { ref: s.mouth, off: _h, dir: s.dir, dist };
        }
        // (fix pass: the main strand is a bold cyan stroke ≥ mainPx px each side at any range, the side strands thinner)
        // (the main strand zigzags less — seen along the beam from the chase camera big lateral zigzags scribble —, the
        //  side strands more, and they fade faster so the afterimage stays on the main one)
        arcs.strike({ from: { ref: s.mouth }, to, amp: k === 0 ? L.mainAmp : L.amp * 1.2, life: L.arcLife * (k === 0 ? rnd(0.9, 1.35) : rnd(0.6, 0.95)),
          width: W * (k === 0 ? 1.2 : L.strandW), minPx: (k === 0 ? L.mainPx : L.strandPx) * (mine ? 1 : 0.6) * mix(1, 1.3, inf),
          core: k === 0 ? 0.14 : 0.22, intensity: (k === 0 ? 1.15 : 0.85) * Math.max(0.35, s.ramp), style, taper: 1,
          branches: k === 0 ? 2 : 1, fork: 0.26, prio: mine && k === 0 });
      }
      if (beam.links.length && simT - beam.linkT < 0.22) {
        for (const ln of beam.links) {
          if (!ln.b?.pos) continue;
          arcs.strike({ from: ln.a?.pos ? { ref: ln.a.pos, off: ln.aOff } : ln.aOff, to: { ref: ln.b.pos, off: ln.bOff }, amp: L.chainAmp,
            life: L.arcLife * 1.25, width: W * 0.72, minPx: 2.8, core: 0.24, intensity: Math.pow(0.85, ln.k - 1), style, branches: 1, fork: 0.22, prio: mine });
        }
      }
      // the mouth flash on every strike: a cyan star (fix pass: it was ≈ 0.3 intensity and 1.1 m from the chase camera,
      // 20–25 m behind the jaws — invisible); none within 9 m of the lens (the rider view: a strobe next to the eye)
      E.reset();
      P.x = s.mouth.x; P.y = s.mouth.y; P.z = s.mouth.z; P.vx = s.vel.x; P.vy = s.vel.y; P.vz = s.vel.z;
      P.life = 0.08; P.size0 = 0.7 * L.mouth.size * scale * mix(1, 1.4, inf); P.size1 = L.mouth.size * scale * mix(1, 1.4, inf);
      P.shape = GLOW.star; P.row = ROW.lightning; P.heat = 1; P.cool = 1.5;
      P.intensity = L.mouth.intensity * (1 - 0.25 * chase) * smoothstep(9, 16, cd) * Math.max(0.4, s.ramp); P.squash = 2.5;
      if (P.intensity > 0.02) spawn(E.glow, P);
      // fix pass (rank 9): seen from behind (hover / chase camera 20–25 m back, the beam nearly end-on) her head hides
      // the beam's root — a crackling corona at the jaws: short arcs thrown forward-outward that stick out around the
      // head's silhouette, so the lightning reads at the mouth too (none in the rider view)
      const back = mine ? chase * smoothstep(9, 16, cd) : 0;
      if (back > 0.1) {
        for (let i = 0; i < 2; i++) {
          // (on a cone 30–65° off the beam: thrown outward, past the head's outline)
          randDir(_h); _h.addScaledVector(s.dir, -_h.dot(s.dir));
          if (_h.lengthSq() < 1e-6) continue;
          const th = rnd(0.55, 1.1);
          _g.copy(s.dir).multiplyScalar(Math.cos(th)).addScaledVector(_h.normalize(), Math.sin(th));
          const len = rnd(2.4, 4.6) * scale * mix(1, 1.3, inf);
          arcs.strike({ from: { ref: s.mouth, off: _l0.copy(_g).multiplyScalar(0.4) }, to: { ref: s.mouth, off: _l1.copy(_g).multiplyScalar(len) }, amp: 0.2, life: rnd(0.05, 0.08),
            width: 0.14 * scale, minPx: 1.8, core: 0.3, intensity: 0.95 * back, style, taper: 1, branches: 1, fork: 0.4 });
        }
      }
    }
    // a blooming body along the beam: short-lived soft blue-white glows on its axis (additive; none within 8 m of the lens)
    emit('bglow', L.glow * q * Math.max(0.3, s.ramp) * mix(1, 1.5, inf), (P, m, d, v) => {
      const x = Rr * rnd(0.08, 1);
      P.x = m.x + d.x * x; P.y = m.y + d.y * x; P.z = m.z + d.z * x;
      if (camNow.distanceToSquared(_l3.set(P.x, P.y, P.z)) < 64) return;
      P.vx = v.x; P.vy = v.y; P.vz = v.z;
      P.life = rnd(0.06, 0.11); P.size0 = rnd(1.3, 2.2) * scale * mix(1, 1.4, inf); P.size1 = P.size0 * 1.3;
      P.shape = GLOW.soft; P.row = ROW.lightning; P.heat = rnd(0.5, 0.72); P.cool = 1; P.intensity = 0.3 * (storm ? 0.8 : 1);
      spawn(E.glow, P);
    });
    // crackle: short blue-white spark streaks thrown off the beam
    emit('crackle', L.crackle * q * Math.max(0.3, s.ramp) * mix(1, 1.5, inf), (P, m, d, v) => {
      const x = Rr * rnd(0.12, 1);
      coneDir(_g, d, 0.06);
      randDir(_h);
      P.x = m.x + _g.x * x; P.y = m.y + _g.y * x; P.z = m.z + _g.z * x;
      const sp = rnd(16, 38);
      P.vx = _h.x * sp + v.x; P.vy = _h.y * sp + v.y; P.vz = _h.z * sp + v.z;
      P.life = rnd(0.07, 0.16); P.size0 = P.size1 = rnd(0.05, 0.09) * scale;
      P.drag = 4; P.stretch = 0.03; P.shape = GLOW.streak; P.row = s.fac.spark; P.heat = 1; P.cool = 1.4; P.intensity = 1.5;
      spawn(E.glow, P);
    });
  }

  /** The stream's white-hot core line through the real centreline (drawn while samples are younger than coreLife). */
  function breathCoreLine(s) {
    if (s.on && s.fac.arcs) { lightningChannel(s); if (s.fac.fire === false) return; }
    if (!s.histN || !ribbons) return;
    const cfg = config.breath, now = game.time.now, H = s.hist, I = cfg.inferno;
    const inf = s.inf || 0;
    const scale = fireScaleOf(s.src) * mix(1, I.core, inf);   // inferno: a wider, longer, hotter white-gold core
    const chase = s.chase || 0;
    const L = mix(cfg.coreLife, cfg.chaseCoreLife, chase) * mix(1, 1.35, inf);
    const kd = s.k ?? cfg.drag;
    let n = 0;
    if (s.on) _pts[n++].copy(s.mouth);
    // newest → oldest
    const step = s.histN > 38 ? 2 : 1;
    for (let k = 0; k < s.histN && n < 20; k += step) {
      const i = ((s.histHead - 1 - k) % 48 + 48) % 48, o = i * 7;
      const age = now - H[o + 6];
      if (age < 0) continue;
      if (age > L) break;
      _b.set(H[o], H[o + 1], H[o + 2]); _c.set(H[o + 3], H[o + 4], H[o + 5]);
      ballistic(_pts[n++], _b, _c, kd, cfg.buoyancy, age);
    }
    if (n < 3) return;
    const fade = s.on ? s.ramp : 0.7;
    const hot = !s.fac.mine ? cfg.hostileCore : 1;   // feel fix: hostile streams show a brighter core
    const boost = mix(1, 1.2, inf) * (s.sky ? 1.2 : 1);
    ribbons.add(_pts, n, (u) => scale * (0.22 + 0.95 * u) * (1 + 0.25 * chase), (u) => 1.0 - 0.42 * u * (1 - 0.4 * chase) * (1 - 0.5 * inf),
      { row: inf > 0.5 ? (s.hotRow ?? s.row) : s.row, seed: s.seed, intensity: 0.95 * fade * hot * (1 + 0.3 * chase) * boost, pull: 1.6 * scale });
  }

  /**
   * Levels and elements — the lightning beam's glowing channel (fix pass, playtester rank 1: "no glow, the beam
   * vanishes on clouds"): a soft cyan haze body along the beam's axis (mouth → the last tick's reach), additive and HDR
   * at its centre so the bloom halo is cyan, ≥ haze.px CSS px each side at any range (so from the hover / chase camera,
   * 20–25 m behind the jaws, it still spreads past her head's silhouette), flickering on the 24 Hz strobe. Drawn every
   * frame (a once-arc, also while paused) under the jagged cel strands. Storm draws it too, inside its gold fire.
   */
  function lightningChannel(s) {
    if (!arcs) return;
    const L = config.lightning, I = config.breath.inferno, inf = s.inf || 0, beam = s.beam;
    const R = beam.t >= 0 && simT - beam.t < 0.3 ? beam.endD : L.maxRange * mix(1, I.range, inf);
    if (!(R > 2)) return;
    const now = game.time.now;
    const scale = fireScaleOf(s.src) * mix(1, 1.45, inf);
    const fl = 0.78 + 0.22 * hash1(Math.floor(now * 24) + s.seed * 31);
    const storm = s.fac.fire !== false;
    arcs.strike({ from: { ref: s.mouth }, to: { ref: s.mouth, dir: s.dir, dist: R }, amp: 0, branches: 0, core: 0, over: 0, haze: 1,
      width: L.haze.width * scale * (storm ? 1.15 : 1), minPx: L.haze.px * mix(1, 1.3, inf), taper: 2,
      intensity: L.haze.intensity * fl * Math.max(0.3, s.ramp) * (storm ? 0.85 : 1), style: s.fac.arcStyle ?? ARC_STYLE.lightning,
      once: true, prio: true });
  }

  function breathPackets(s, dt) {
    const cfg = config.breath;
    refreshElement(s);
    updateMode(s, dt);
    // levels and elements: lightning has no fire packets (the beam ticks instead); storm has both
    const fireOn = s.fac.fire !== false, arcOn = !!s.fac.arcs;
    if (s.on && s.src.alive !== false) {
      readSource(s.src, s.mouth, s.dir, s.vel);
      if (!fireOn) s.packetAcc = 0;
      s.packetAcc += dt * cfg.packetHz * (fireOn ? 1 : 0);
      while (s.packetAcc >= 1) {
        s.packetAcc -= 1;
        // each packet keeps the stream parameters it was launched with (the inferno blends in and out mid-stream)
        s.packets.push({
          p0: s.mouth.clone(),
          v0: s.dir.clone().multiplyScalar(s.muzzle).add(s.vel),
          t0: simT, life: s.life, k: s.k, inf: s.inf, pos: s.mouth.clone(), dead: false,
        });
      }
    }
    const world = game.world;
    for (let i = s.packets.length - 1; i >= 0; i--) {
      const k = s.packets[i];
      const age = simT - k.t0;
      if (age > k.life || k.dead) { s.packets.splice(i, 1); continue; }
      ballistic(k.pos, k.p0, k.v0, k.k ?? cfg.drag, cfg.buoyancy, age);
      const h = safeHeight(k.pos.x, k.pos.z);
      if (k.pos.y < h || k.pos.y < (world.seaLevel ?? 0)) {
        k.dead = true;
        if (Math.random() < 0.5) surfaceBurn(k.pos, h, s);
      }
    }
    s.tickAcc += dt;
    const T = 1 / cfg.tickHz;
    if (s.tickAcc >= T) {
      s.tickAcc -= T;
      if (s.packets.length) breathTick(s, T);
      if (arcOn && s.on && s.src.alive !== false) { try { beamTick(s, T); } catch (e) { if (!fx._beamWarned) { fx._beamWarned = true; console.warn('[fx] beam', e); } } }
    }
  }

  function breathTick(s, T) {
    const cfg = config.breath, combat = game.combat, I = cfg.inferno;
    const owner = actorOf(s.src);
    const team = owner?.team || s.src.team || 'enemy';
    const target = opposing(team);
    const hits = new Map();
    const fbHit = new Set();
    for (const k of s.packets) {
      if (k.dead) continue;
      const dist = k.pos.distanceTo(s.mouth);
      // inferno packets reach 1.5× as far with a 1.5× wider hit sphere (k.inf: the blend at launch)
      const rk = mix(1, I.range, k.inf || 0);
      const full = cfg.fullRange * rk, maxR = cfg.maxRange * rk;
      if (dist > maxR) continue;
      const fall = dist <= full ? 1 : 1 - (dist - full) / (maxR - full);
      const r = (cfg.hitRadius0 + cfg.hitRadiusK * Math.min(dist, maxR)) * mix(1, I.hit, k.inf || 0);
      if (combat) {
        let list = [];
        try { list = combat.querySphere(k.pos, r, { team: target, exclude: owner }); } catch { list = []; }
        for (const h of list) {
          const prev = hits.get(h.actor);
          if (!prev || fall > prev.fall) hits.set(h.actor, { fall, point: h.point, shape: h.shape });
        }
      }
      for (const p of projectiles) {
        if (p.alive && p.hp > 0 && p.team === target && p.pos.distanceTo(k.pos) < r + p.radius) fbHit.add(p);
      }
    }
    // flight moves: inferno ×3 DPS, skyfall / explicit damage multiplier; levels: × game.progress.dmgMult for Sora;
    // storm: the gold fire around the lightning beam deals stormFire of it (the beam does the rest)
    const dpsK = mix(1, I.dps, s.inf || 0) * breathMult(s) * levelMult(s.src) * (s.fac.arcs ? config.lightning.stormFire : 1);
    for (const [actor, h] of hits) {
      const amount = cfg.dps * T * h.fall * dpsK;
      if (amount <= 0) continue;
      let dealt = 0;
      try {
        dealt = combat.damage(actor, amount, { source: owner, point: h.point, dir: s.dir.clone(), kind: 'fire', element: s.elem || undefined,
          part: h.shape?.part, shape: h.shape });
      } catch (e) { console.warn('[fx] damage failed', e); }
      stat.ticks++; stat.fireDamage += dealt || 0;
      // scorch flash + sparks where the stream licks the target, then burning status
      fx.sparks(h.point, 5 + Math.round(4 * (s.inf || 0)), { row: s.fac.spark, vel: actor.vel, speed: 22 });
      if (Math.random() < 0.5 + 0.3 * (s.inf || 0)) fx.impactFlash(h.point, { size: 2.2 * mix(1, 1.5, s.inf || 0), row: (s.inf || 0) > 0.5 ? s.hotRow ?? s.row : s.row, ring: false });
      setBurning(actor, h.point, owner, s.fac.mine ? s.fac : null);
    }
    for (const p of fbHit) {
      p.hp -= cfg.dps * T * dpsK;
      if (p.hp <= 0) detonate(p, 'shot');
    }
  }

  /**
   * Levels and elements — one lightning beam tick (tickHz): the beam runs straight from the mouth along mouthDir to its
   * reach (or the ground). Hit spheres every `step` m (radius hitRadius0 + hitRadiusK·d; the inferno's width); each
   * actor takes the breath's damage once, at its best falloff (full to fullRange, 0 at maxRange); the strongest hit
   * chains on (chain()). Opposing fireballs with HP in the beam burn down like in the fire stream. The tick's geometry
   * (end, hits, links) is what the arcs are drawn to.
   */
  function beamTick(s, T) {
    const L = config.lightning, cfg = config.breath, I = cfg.inferno, combat = game.combat;
    const owner = actorOf(s.src);
    const team = owner?.team || s.src.team || 'enemy';
    const target = opposing(team);
    const inf = s.inf || 0, rk = mix(1, I.range, inf);
    const maxR = L.maxRange * rk, full = L.fullRange * rk;
    const m = s.mouth, d = s.dir;
    const sea = game.world?.seaLevel ?? 0;
    let endD = maxR, ground = false;
    for (let x = L.step; x <= maxR + 1e-6; x += L.step) {
      _l0.copy(m).addScaledVector(d, x);
      if (_l0.y < Math.max(safeHeight(_l0.x, _l0.z), sea)) { endD = Math.max(L.step, x - L.step * 0.5); ground = true; break; }
    }
    const hits = new Map();
    const fbHit = new Set();
    for (let x = L.step; x <= endD + 1e-6; x += L.step) {
      _l0.copy(m).addScaledVector(d, x);
      const fall = x <= full ? 1 : clamp(1 - (x - full) / Math.max(1, maxR - full), 0, 1);
      if (fall <= 0) continue;
      const r = (L.hitRadius0 + L.hitRadiusK * x) * mix(1, I.hit, inf);
      let list = [];
      if (combat) { try { list = combat.querySphere(_l0, r, { team: target, exclude: owner }); } catch { list = []; } }
      for (const h of list) {
        const prev = hits.get(h.actor);
        if (!prev || fall > prev.fall + 1e-6) hits.set(h.actor, { fall, point: h.point, shape: h.shape, x });
      }
      for (const p of projectiles) if (p.alive && p.hp > 0 && p.team === target && p.pos.distanceTo(_l0) < r + p.radius) fbHit.add(p);
    }
    const dpsK = mix(1, I.dps, inf) * breathMult(s) * levelMult(s.src) * L.damage;
    const beam = s.beam;
    beam.endD = endD; beam.ground = ground; beam.t = simT; beam.hits.length = 0;
    let best = null;
    for (const [actor, h] of hits) {
      const amount = cfg.dps * T * h.fall * dpsK;
      if (!(amount > 0)) continue;
      let dealt = 0;
      try {
        dealt = combat.damage(actor, amount, { source: owner, point: h.point, dir: s.dir.clone(), kind: 'fire', element: s.elem || 'lightning',
          part: h.shape?.part, shape: h.shape }) || 0;
      } catch (e) { console.warn('[fx] damage failed', e); }
      stat.ticks++; stat.beamTicks++; stat.fireDamage += dealt; stat.beamDamage += dealt;
      if (actor.pos?.isVector3) beam.hits.push({ actor, off: h.point.clone().sub(actor.pos), x: h.x });
      setShocked(actor, h.point);
      fx.sparks(h.point, 6 + Math.round(4 * inf), { row: s.fac.spark, vel: actor.vel, speed: 30, life: 0.2 });
      if (!best || amount > best.amount) best = { actor, point: h.point, amount };
      else if (Math.random() < 0.55) fx.impactFlash(h.point, { size: 2.2 * mix(1, 1.4, inf), row: ROW.lightning, starRow: ROW.lightning, ring: false, intensity: 0.75 });
    }
    // fix pass (rank 1: "a bright flash at the mouth and a bloom where it hits, like the fire"): the strongest hit
    // blooms every tick, ≥ hitPx CSS px in radius at any range (cyan star + glow; close by, the glow class's screen clamp bounds it)
    if (best) {
      const S = Math.max(2.4 * mix(1, 1.4, inf), (isPlayerSrc(s.src) ? L.hitPx : 12) * pxAt(best.point));
      fx.impactFlash(best.point, { size: S, row: ROW.lightning, starRow: ROW.lightning, ring: false, intensity: 0.95 });
    }
    beam.hits.sort((a, b) => a.x - b.x);
    const n = chainCount(s.fac, s.src);
    if (best && n > 0) {
      // The player's jump radius comes from the progression (lightning 40 / storm 45 m); others keep config.lightning.
      const jumpR = isPlayerSrc(s.src) ? (+game.progress?.chainRadius || null) : null;
      beam.links = chain(owner, target, best.actor, best.point, best.amount, n, new Set(hits.keys()), 'fire', s.elem || 'lightning', jumpR);
      beam.linkT = simT;
    } else if (simT - beam.linkT > 0.3) beam.links = [];
    for (const p of fbHit) { p.hp -= cfg.dps * T * dpsK; if (p.hp <= 0) detonate(p, 'shot'); }
    if (ground && Math.random() < 0.6) {
      _l1.copy(m).addScaledVector(d, endD);
      fx.sparks(_l1, 8, { row: s.fac.spark, speed: 26, life: 0.25, normal: _up });
      if (Math.random() < 0.5) fx.impactFlash(_l1, { size: 2.6, row: ROW.lightning, ring: false, intensity: 0.7 });
    }
  }

  /**
   * Chain lightning: from `fromActor` (null = a point) jump up to n times, each to the nearest not-yet-hit enemy within
   * chainRadius m of the previous hit, each jump × chainFalloff of the previous damage. Returns the links (live ends
   * on the actors) for the arcs. kind 'fire' (beam) or 'fireball' (bolt), with `element` and `chain` (jump number).
   */
  function chain(owner, team, fromActor, fromPoint, amount, n, visited, kind, element, radius = null, falloff = null) {
    const L = config.lightning, combat = game.combat, links = [];
    const CR = radius > 0 ? radius : L.chainRadius, CK = falloff > 0 ? falloff : L.chainFalloff;
    if (!combat || !(amount > 0) || !fromPoint) return links;
    let fa = fromActor;
    const fp = _l2.copy(fromPoint);
    let amt = amount;
    for (let k = 1; k <= n; k++) {
      amt *= CK;
      if (amt < 0.05) break;
      let list = [];
      try { list = combat.querySphere(fp, CR, { team, exclude: owner }); } catch { list = []; }
      let nb = null;
      for (const h of list) { if (visited.has(h.actor) || !h.actor?.pos) continue; if (!nb || h.dist < nb.dist) nb = h; }
      if (!nb) break;
      visited.add(nb.actor);
      const dir = nb.point.clone().sub(fp);
      const dl = dir.length();
      if (dl > 1e-3) dir.divideScalar(dl); else dir.set(0, 0, 1);
      let dealt = 0;
      try {
        dealt = combat.damage(nb.actor, amt, { source: owner, point: nb.point.clone(), dir, kind, element, chain: k, part: nb.shape?.part, shape: nb.shape }) || 0;
      } catch (e) { console.warn('[fx] chain damage failed', e); }
      stat.chains++; stat.chainDamage += dealt;
      links.push({ a: fa?.pos?.isVector3 ? fa : null, aOff: fa?.pos?.isVector3 ? fp.clone().sub(fa.pos) : fp.clone(), b: nb.actor, bOff: nb.point.clone().sub(nb.actor.pos), k });
      setShocked(nb.actor, nb.point);
      fx.sparks(nb.point, 5, { row: ROW.lightningSpark, vel: nb.actor.vel, speed: 26, life: 0.2 });
      fa = nb.actor; fp.copy(nb.point);
    }
    return links;
  }

  /** Lightning crackles over what it hit for config.lightning.shock s (visual only). */
  function setShocked(actor, point) {
    if (!actor?.pos?.isVector3) return;
    let sh = shocked.get(actor);
    if (!sh) { if (shocked.size >= 12) return; sh = { until: 0, off: new V3(), acc: 0 }; shocked.set(actor, sh); }
    sh.until = simT + config.lightning.shock;
    if (point) sh.off.copy(point).sub(actor.pos);
  }
  function shockVisuals(dt) {
    if (!arcs || dt <= 0) return;
    for (const [a, sh] of shocked) {
      if (simT > sh.until || a.alive === false || !a.pos?.isVector3) { shocked.delete(a); continue; }
      sh.acc += dt * 16;
      if (sh.acc < 1) continue;
      sh.acc = Math.min(sh.acc - 1, 1);
      const rho = a.kind === 'titan' ? 7 : clamp(0.35 * (a.radius || 6), 1.4, 4) * (isDrake(a) ? 0.7 : 1);
      randDir(_l0).multiplyScalar(rho * rnd(0.2, 0.6)).add(sh.off);
      randDir(_l1).multiplyScalar(rho * rnd(0.6, 1.1)).add(sh.off);
      arcs.strike({ from: { ref: a.pos, off: _l0 }, to: { ref: a.pos, off: _l1 }, amp: 0.2, life: 0.08, width: 0.22, intensity: 0.9,
        style: ARC_STYLE.lightning, branches: Math.random() < 0.4 ? 1 : 0, fork: 0.35 });
    }
  }

  let surfT = 0;
  function surfaceBurn(pos, h, s) {
    if (simT - surfT < 0.05) return;
    surfT = simT;
    const sea = h < (game.world.seaLevel ?? 0);
    const y = Math.max(h, game.world.seaLevel ?? 0);
    const P = E.P;
    for (let i = 0; i < 2; i++) {
      E.reset();
      P.x = pos.x + rnd(-2, 2); P.y = y + 0.5; P.z = pos.z + rnd(-2, 2);
      P.vx = s.dir.x * 12 + rnd(-6, 6); P.vy = rnd(2, 6); P.vz = s.dir.z * 12 + rnd(-6, 6);
      if (sea) {
        P.life = rnd(0.8, 1.4); P.size0 = 1.5; P.size1 = rnd(4, 6); P.drag = 1.5; P.grav = 3; P.row = SMOKE.spray;
        spawn(E.smoke, P);
      } else {
        P.life = rnd(0.5, 0.9); P.size0 = 1; P.size1 = rnd(3, 5); P.drag = 2; P.grav = 4;
        P.row = s.row; P.heat = 0.85; P.cool = 0.5; P.stretch = -0.01;
        spawn(firePool(s.row), P);
      }
    }
  }

  function safeHeight(x, z) {
    try { const h = game.world.heightAt(x, z); return Number.isFinite(h) ? h : -1e9; } catch { return -1e9; }
  }

  // ---------- burning status ----------
  function setBurning(actor, point, source, pal = null) {
    let b = burning.get(actor);
    if (!b) { b = { actor, until: 0, local: new V3(), source, acc: 0, dot: 0 }; burning.set(actor, b); }
    b.until = simT + config.breath.burnTime;
    if (b.source !== source) b.fac = null;
    if (pal) b.fac = pal;                                 // levels and elements: the burn shows the element that lit it
    b.source = source;
    if (actor.root?.isObject3D && point) { actor.root.updateMatrixWorld(); b.local.copy(point); actor.root.worldToLocal(b.local); }
    else b.local.set(0, 0, 0);
  }
  function burnWorld(b, out) {
    if (b.actor.root?.isObject3D) return b.actor.root.localToWorld(out.copy(b.local));
    return out.copy(b.actor.pos || _a.set(0, 0, 0));
  }

  // ---------- fireballs ----------
  function parseHoming(h, kind) {
    if (!h) return null;
    const titan = kind === 'titan';
    const base = { turnRate: 0, accel: 0, duration: titan ? 1.4 : 3, cutoffTime: titan ? 0.8 : 0, cutoffDist: titan ? 50 : 0 };
    if (h === true) return { ...base, accel: titan ? 9 : 60 };
    if (typeof h === 'number') return h <= 6 ? { ...base, turnRate: h } : { ...base, accel: h };
    if (typeof h === 'object') return { ...base, ...h };
    return null;
  }
  const tpos = (t) => (t?.pos?.isVector3 ? t.pos : t?.isVector3 ? t : null);
  const tvel = (t) => (t?.vel?.isVector3 ? t.vel : null);

  function stepProjectile(p, dt) {
    p.prev.copy(p.pos);
    const v = p.vel;
    if (p.gravity) v.y -= p.gravity * dt;
    if (p.drag) { const sp = v.length(); v.multiplyScalar(Math.max(0, 1 - p.drag * sp * dt)); }
    const H = p.homing, tp = tpos(p.target);
    if (H && tp && !p.homingDone && (p.target.alive ?? true)) {
      const rel = _a.subVectors(tp, p.pos);
      const dist = rel.length();
      const sp = v.length();
      const tv = tvel(p.target);
      const closing = tv ? -_b.subVectors(tv, v).dot(rel) / Math.max(dist, 1e-3) : sp;
      const tgo = closing > 1 ? dist / closing : 99;
      if (p.age > H.duration || dist < H.cutoffDist || (H.cutoffTime && tgo < H.cutoffTime) || rel.dot(v) < 0) p.homingDone = true;
      else if (sp > 1) {
        const aim = _c.copy(tp);
        if (tv) aim.addScaledVector(tv, Math.min(tgo, 4));
        const want = aim.sub(p.pos).normalize();
        const cur = _d.copy(v).divideScalar(sp);
        const ang = Math.acos(clamp(cur.dot(want), -1, 1));
        const rate = H.turnRate || (H.accel ? H.accel / sp : 0);
        const step = Math.min(ang, rate * dt);
        if (step > 1e-5) {
          const axis = _e.crossVectors(cur, want);
          if (axis.lengthSq() > 1e-10) { axis.normalize(); v.applyAxisAngle(axis, step); }
        }
      }
    }
    p.pos.addScaledVector(v, dt);
    p.age += dt;

    let hit = null;
    try { hit = game.combat?.sweepSphere(p.prev, p.pos, p.radius, { team: p.targetTeam, exclude: p.owner }) || null; } catch { hit = null; }
    if (hit) { p.pos.copy(hit.point); detonate(p, 'hit', hit); return; }
    const h = safeHeight(p.pos.x, p.pos.z);
    const sea = game.world.seaLevel ?? 0;
    if (p.pos.y - p.radius * 0.25 < h && h >= sea) { p.pos.y = h + p.radius * 0.3; detonate(p, 'ground'); return; }
    if (p.pos.y < sea) { p.pos.y = sea; detonate(p, 'sea'); return; }
    if (p.age >= p.life) { detonate(p, 'timeout'); return; }
    const b = game.world.bounds;
    if (b && (Math.hypot(p.pos.x, p.pos.z) > b.radius * 1.3 || p.pos.y > (b.ceiling || 4200) + 800)) { remove(p); }
  }

  function remove(p) {
    p.alive = false;
    orbs?.remove(p.orb);
    const i = projectiles.indexOf(p);
    if (i >= 0) projectiles.splice(i, 1);
  }

  function detonate(p, reason, hit = null) {
    if (!p.alive) return;
    remove(p);
    p.reason = reason;
    const point = hit?.point || p.pos;
    const combat = game.combat;
    const dir = p.vel.clone().normalize();
    if (reason !== 'shot' && combat) {
      if (hit) {
        try { combat.damage(hit.actor, p.damage, { source: p.owner, point: point.clone(), dir, kind: 'fireball', element: p.element || undefined, part: hit.shape?.part, shape: hit.shape }); } catch (e) { console.warn('[fx] damage failed', e); }
      }
      if (p.splashDamage > 0 && p.splashRadius > 0) {
        let list = [];
        try { list = combat.querySphere(point, p.splashRadius, { team: p.targetTeam, exclude: p.owner }); } catch { list = []; }
        for (const s of list) {
          if (hit && s.actor === hit.actor) continue;
          const f = 1 - clamp(s.dist / p.splashRadius, 0, 1);
          if (f <= 0) continue;
          try { combat.damage(s.actor, p.splashDamage * f, { source: p.owner, point: s.point, dir, kind: 'fireball', element: p.element || undefined, part: s.shape?.part, shape: s.shape }); } catch { /* ignore */ }
        }
      }
    }
    const surface = reason === 'sea' ? 'sea' : reason === 'ground' ? 'ground' : 'air';
    const R = reason === 'shot' ? p.visualRadius * 1.1 : p.visualRadius * (p.kind === 'titan' ? 1.7 : 2.2);
    const lvl = p.charged || 0;
    if (p.bolt) {
      // levels and elements: a lightning bolt strikes — a thunder flash, radial arcs, then chain lightning from what it hit
      let links = [];
      if (combat && p.chainN > 0 && reason !== 'shot' && reason !== 'timeout' && reason !== 'cleared') {
        const visited = new Set();
        if (hit?.actor) visited.add(hit.actor);
        links = chain(p.owner, p.targetTeam, hit?.actor || null, point, p.damage, p.chainN, visited, 'fireball', p.element, p.chainR, p.chainK);
      }
      boltImpact(p, point, R, surface, reason, dir, links);
      if (reason !== 'shot' && reason !== 'timeout') stat.boltHits++;
    } else fx.explosion(point, { radius: R, kind: p.kind, row: lvl >= 0.5 ? p.hotRow : p.row, surface, owner: p.owner, cause: reason, projectile: p });
    // a charged shot marks its splash: a flat energy ring out to the splash radius, facing the way it came
    if (lvl >= 0.25 && shock && reason !== 'shot' && reason !== 'cleared') {
      shock.ring({ pos: point, normal: dir, r0: p.splashRadius * 0.25, r1: p.splashRadius, life: 0.45, width: 0.06,
        style: p.pal?.ring ?? RING_STYLE.energy, intensity: 0.5 + 0.5 * lvl, near: 8 });
    }
    p.onExplode?.(p, reason, hit);
  }

  function fireballVisuals(p, dt, alpha) {
    const P = E.P, q = E.quality;
    const vis = _a.lerpVectors(p.prev, p.pos, clamp(alpha, 0, 1));
    const vr = p.visualRadius;
    const now = game.time.now;
    p.orb.pos.copy(vis);
    p.visPos?.copy(vis);
    // the solid core is the fireball's heart; the flame corona around it makes the silhouette (a lightning bolt: a small
    // white-hot flickering core — the zigzag bolt is the silhouette)
    p.orb.radius = p.bolt ? vr * 0.55 * (1 + 0.18 * hash1(Math.floor(now * 30) + p.id * 7.1))
      : vr * (p.kind === 'titan' ? 0.64 : 0.8) * (1 + 0.05 * Math.sin(now * 31 + p.id) + 0.03 * Math.sin(now * 53));
    // wave 4: a fireball flying past the lens (dodging a titan volley) never fills the view: the inked core's on-screen
    // radius stays ≤ orbMaxScreen of the view height (its halo scales with it). Visual only: the hit sphere is unchanged.
    const ocd = camDist(vis);
    const ocap = config.explosion.orbMaxScreen * 2 * Math.max(ocd, 0.5) * Math.tan(((game.camera.fov || 60) * Math.PI) / 360);
    if (p.orb.radius > ocap) p.orb.radius = ocap;
    const lvl = p.charged || 0;
    p.orb.intensity = (1.0 + 0.1 * Math.sin(now * 23 + p.id * 3)) * (1 + 0.45 * lvl) * (p.bolt ? 1.35 : 1);
    if (dt > 0) {
      const titan = p.kind === 'titan';
      const moved = p.lastVis ? p.lastVis.distanceTo(vis) : 0;
      if (!p.lastVis) p.lastVis = vis.clone();
      // levels and elements: a bolt has no flame trail (storm: a thinner gold fire trail wrapped around the bolt)
      const fireK = p.bolt ? (p.pal?.boltFire ? 0.45 : 0) : 1;
      const spacing = vr * (titan ? 0.28 : 0.3);
      p.trailAcc += (moved / spacing) * fireK;
      p.trailAcc = Math.min(p.trailAcc, titan ? 40 : 20);
      const n = Math.floor(p.trailAcc * Math.min(1, q + 0.25));
      p.trailAcc -= n;
      const t0 = now - dt;
      // shadowfire orbs trail soft fire; any fireball's trail turns soft and translucent as it passes near the
      // camera (a titan volley flying by the lens no longer paints the view red; far away it keeps the cel look)
      const fd = camDist(vis), fb = config.explosion;
      const nearFb = fd < fb.fireballNear;
      const fpool = nearFb ? E.soft : firePool(p.row), sk = fpool === E.soft ? 1.12 : 1;
      const fop = nearFb ? mix(fb.fireballOpacity, 1, smoothstep(fb.fireballNear * 0.4, fb.fireballNear, fd)) : 1;
      for (let i = 0; i < n; i++) {
        const f = (i + Math.random()) / n;
        E.reset();
        P.t0 = t0 + f * dt;
        _b.lerpVectors(p.lastVis, vis, f);
        randDir(_c).multiplyScalar(vr * rnd(0.1, 0.5));
        P.x = _b.x + _c.x; P.y = _b.y + _c.y; P.z = _b.z + _c.z;
        P.vx = p.vel.x * 0.14 + _c.x * 2; P.vy = p.vel.y * 0.14 + _c.y * 2 + 1; P.vz = p.vel.z * 0.14 + _c.z * 2;
        // wave 5: titan trail tongues stay molten longer (cool 0.7, was 1.1) and burn out once they cool into crimson
        // (particles.js, row 2), so the trail ends in light ash smoke instead of flat red splotches
        P.life = titan ? rnd(0.6, 0.95) : rnd(0.32, 0.55);
        P.size0 = vr * rnd(0.8, 1.05) * sk; P.size1 = vr * rnd(0.35, 0.6) * sk;
        P.drag = 1.6; P.grav = 2.5; P.stretch = -0.09; P.grow = 1.3;
        P.heat = titan ? rnd(0.78, 0.98) : rnd(0.88, 1.0); P.cool = titan ? 0.7 : 0.9; P.spin = rnd(-2, 2);
        P.row = lvl > 0 && Math.random() < 0.6 * lvl ? p.hotRow : p.row;         // a charged shot trails white-gold fire
        P.opacity = fop;
        spawn(fpool, P);
      }
      if (lvl > 0.05) chargedVisuals(p, vis, moved, dt, lvl);
      if (p.bolt) boltVisuals(p, vis, moved, dt);
      else if (p.pal?.sparkle) {
        // radiant: twinkles shed along the path
        p.sparkAcc = (p.sparkAcc || 0) + dt * 26 * q;
        while (p.sparkAcc >= 1) {
          p.sparkAcc -= 1;
          E.reset();
          randDir(_c);
          P.x = vis.x + _c.x * vr * 0.9; P.y = vis.y + _c.y * vr * 0.9; P.z = vis.z + _c.z * vr * 0.9;
          P.vx = p.vel.x * 0.2 + _c.x * 5; P.vy = p.vel.y * 0.2 + _c.y * 5 + 1; P.vz = p.vel.z * 0.2 + _c.z * 5;
          P.life = rnd(0.3, 0.55); P.size0 = 0.25; P.size1 = rnd(0.45, 0.7); P.drag = 2; P.shape = GLOW.sparkle; P.row = p.pal.spark;
          P.heat = 1; P.cool = 0.4; P.intensity = 1.1; P.rot = rnd(-0.3, 0.3); P.spin = rnd(-2, 2);
          spawn(E.glow, P);
        }
      }
      // corona: short flame tongues licking back off the surface (they break the sphere's silhouette)
      p.coronaAcc = (p.coronaAcc || 0) + dt * (titan ? 100 : 45) * Math.min(1, q + 0.25) * fireK;
      while (p.coronaAcc >= 1) {
        p.coronaAcc -= 1;
        E.reset();
        randDir(_c);
        if (_c.dot(p.vel) > 0) _c.addScaledVector(p.vel, -1.2 * _c.dot(p.vel) / Math.max(p.vel.lengthSq(), 1e-6));
        _c.normalize();
        P.t0 = now - Math.random() * dt;
        P.x = vis.x + _c.x * vr * 0.55; P.y = vis.y + _c.y * vr * 0.55; P.z = vis.z + _c.z * vr * 0.55;
        P.vx = p.vel.x * 0.82 + _c.x * vr * 2.2; P.vy = p.vel.y * 0.82 + _c.y * vr * 2.2 + 1; P.vz = p.vel.z * 0.82 + _c.z * vr * 2.2;
        const cs = titan ? 1 : 0.78;
        P.life = rnd(0.18, 0.3); P.size0 = vr * rnd(0.42, 0.56) * cs; P.size1 = vr * rnd(0.62, 0.86) * cs;
        P.drag = 2.2; P.grav = 2; P.stretch = -0.035; P.grow = 1.5;
        // titan: molten-gold tongues with ~35 % cooler crimson ones (the colours of its cracks and core)
        P.heat = titan && Math.random() < 0.35 ? rnd(0.6, 0.72) : rnd(0.82, 0.98); P.cool = 0.8; P.row = p.row; P.spin = rnd(-2, 2);
        P.opacity = fop;
        spawn(fpool, P);
      }
      // smoke and embers behind (a bolt makes no smoke)
      p.smokeAcc += dt * (titan ? 6 : 3) * q * (p.bolt ? 0 : 1);
      while (p.smokeAcc >= 1) {
        p.smokeAcc -= 1;
        E.reset();
        P.t0 = now + (titan ? rnd(0.3, 0.45) : rnd(0.15, 0.3));      // titan: where its trail burns out
        _b.copy(vis).addScaledVector(p.vel, -(titan ? rnd(0.3, 0.45) : rnd(0.15, 0.3)));
        P.x = _b.x + rnd(-1, 1) * vr * 0.4; P.y = _b.y + rnd(-1, 1) * vr * 0.4; P.z = _b.z + rnd(-1, 1) * vr * 0.4;
        P.vx = p.vel.x * 0.05; P.vy = 1.5; P.vz = p.vel.z * 0.05;
        P.life = titan ? rnd(0.9, 1.4) : rnd(0.8, 1.3); P.size0 = vr * 0.45; P.size1 = vr * (titan ? rnd(0.9, 1.25) : rnd(0.8, 1.05));
        if (titan) P.fadeIn = 0.2;
        P.drag = 1; P.grav = 1.2; P.row = facOfRow(p.row).trail; P.heat = 0.3; P.spin = rnd(-0.4, 0.4);
        spawn(E.smoke, P);
      }
      p.emberAcc = (p.emberAcc || 0) + dt * (titan ? 40 : 22) * q * (p.bolt ? 0.3 : 1);
      while (p.emberAcc >= 1) {
        p.emberAcc -= 1;
        E.reset();
        randDir(_c);
        P.x = vis.x + _c.x * vr; P.y = vis.y + _c.y * vr; P.z = vis.z + _c.z * vr;
        P.vx = p.vel.x * 0.3 + _c.x * 12; P.vy = p.vel.y * 0.3 + _c.y * 12; P.vz = p.vel.z * 0.3 + _c.z * 12;
        P.life = rnd(0.3, 0.6); P.size0 = P.size1 = (vr * 0.05 + 0.05) * mix(0.35, 1, smoothstep(8, fb.fireballNear, fd));
        P.drag = 2; P.grav = -3; P.stretch = 0.04; P.shape = GLOW.streak; P.row = sparkRow(p.row); P.heat = 1; P.cool = 1; P.intensity = 1.3;
        spawn(E.glow, P);
      }
      p.lastVis.copy(vis);
    }
    const lc = p.bolt ? p.pal.light : lvl > 0.35 ? p.pal?.hotLight ?? INFERNO_LIGHT : lightColor(p.row);
    lights.request(vis, lc, (vr * vr * 40 + 60) * (1 + 0.6 * lvl) * (p.bolt ? 1.3 * (0.7 + 0.5 * hash1(Math.floor(now * 24) + p.id)) : 1), vr * 9 + 8, p);
  }

  /**
   * Levels and elements — the bolt in flight: a jagged bolt from the core back along its path (up to bolt.trail m,
   * struck 30×/s, both ends ride the bolt) with forks, an afterimage of the path left in the air (fixed ends, fading),
   * crackle sparks and a flickering blue-white glow.
   */
  function boltVisuals(p, vis, moved, dt) {
    const B = config.lightning.bolt, P = E.P, lvl = p.charged || 0;
    const style = p.pal?.arcStyle ?? ARC_STYLE.lightning;
    const sq = Math.sqrt(p.visualRadius / 1.76) * (1 + 0.35 * lvl);
    p.boltLen = Math.min(p.boltLen + moved, B.trail * (1 + 0.3 * lvl));
    const sp = p.vel.length();
    if (!(sp > 1)) return;
    const vd = _g.copy(p.vel).divideScalar(sp);
    if (arcs && p.boltLen > 1) {
      p.arcAcc = (p.arcAcc || 0) + dt * 30;
      if (p.arcAcc >= 1) {
        p.arcAcc = Math.min(p.arcAcc - 1, 1);
        arcs.strike({ from: { ref: p.visPos }, to: { ref: p.visPos, off: _h.copy(vd).multiplyScalar(-p.boltLen) }, amp: 0.075, life: 0.07,
          width: B.width * sq, minPx: B.headPx * (1 + 0.3 * lvl), core: 0.22, intensity: 1.25, style, taper: 1, branches: 2, fork: 0.22, prio: true });
      }
      // fix pass (rank 2: "a 2–4 px white line in flight"): a cyan glow body around the bolt's head part, every frame
      arcs.strike({ from: { ref: p.visPos }, to: { ref: p.visPos, off: _h.copy(vd).multiplyScalar(-Math.min(p.boltLen, B.trail) * 0.9) },
        amp: 0, branches: 0, core: 0, over: 0, haze: 1, width: 1.5 * sq, minPx: 8 * (1 + 0.3 * lvl), taper: 1, intensity: 1.25,
        style, once: true, prio: true });
      // the lightning channel: a thinner, dimmer jagged line from the launch point (≤ bolt.channel m back) to the head —
      // from the chase camera the shot reads as a bolt reaching into the distance, not a speck
      if (p.launch) {
        const back = Math.min(p.launch.distanceTo(p.visPos), B.channel);
        if (back > p.boltLen + 4 && (p.chanAcc = (p.chanAcc || 0) + dt * 24) >= 1) {
          p.chanAcc = Math.min(p.chanAcc - 1, 1);
          _l3.copy(p.visPos).addScaledVector(vd, -back);
          if (clipToView(_l3, p.visPos, 20, _l3) && _l3.distanceTo(p.visPos) > p.boltLen + 4) {
            const Lc = _l3.distanceTo(p.visPos);
            arcs.strike({ from: _l3.clone(), to: { ref: p.visPos }, amp: clamp(B.channelJag / Lc, 0.015, 0.08), life: 0.08,
              width: B.width * 0.55 * sq, minPx: B.channelPx, core: 0.28, intensity: 0.85, style, taper: 2, branches: 2, fork: 0.12, prio: true });
          }
        }
      }
      p.aftAcc = (p.aftAcc || 0) + dt * 14;
      if (p.aftAcc >= 1 && p.boltLen > 6) {
        p.aftAcc = Math.min(p.aftAcc - 1, 1);
        arcs.strike({ from: vis.clone(), to: _h.copy(vis).addScaledVector(vd, -Math.min(p.boltLen, 18)), amp: 0.1, life: 0.2,
          width: B.width * 0.6 * sq, minPx: 2, intensity: 0.55, style, branches: 1, fork: 0.3 });
      }
    }
    p.crkAcc = (p.crkAcc || 0) + dt * 40 * E.quality;
    while (p.crkAcc >= 1) {
      p.crkAcc -= 1;
      E.reset();
      randDir(_c);
      const back = rnd(0, Math.min(p.boltLen, 14));
      P.x = vis.x - vd.x * back + _c.x; P.y = vis.y - vd.y * back + _c.y; P.z = vis.z - vd.z * back + _c.z;
      const s2 = rnd(14, 30);
      P.vx = p.vel.x * 0.15 + _c.x * s2; P.vy = p.vel.y * 0.15 + _c.y * s2; P.vz = p.vel.z * 0.15 + _c.z * s2;
      P.life = rnd(0.07, 0.15); P.size0 = P.size1 = rnd(0.05, 0.08); P.drag = 4; P.stretch = 0.03; P.shape = GLOW.streak;
      P.row = ROW.lightningSpark; P.heat = 1; P.cool = 1.4; P.intensity = 1.5;
      spawn(E.glow, P);
    }
    // a flickering glow around the core (the orb's halo is small; this makes the bolt's head bloom)
    p.glwAcc = (p.glwAcc || 0) + dt * 30;
    while (p.glwAcc >= 1) {
      p.glwAcc -= 1;
      E.reset();
      P.x = vis.x; P.y = vis.y; P.z = vis.z; P.vx = p.vel.x; P.vy = p.vel.y; P.vz = p.vel.z;
      P.life = rnd(0.05, 0.09); P.size0 = p.visualRadius * rnd(1.5, 2.2) * (1 + 0.4 * lvl); P.size1 = P.size0 * 1.2;
      P.shape = GLOW.soft; P.row = ROW.lightning; P.heat = 0.85; P.cool = 1; P.intensity = 0.7;
      spawn(E.glow, P);
    }
  }

  /**
   * Levels and elements: the start of a bolt's channel / return stroke moved along a → b until it is ≥ minDepth in front
   * of the camera (the launch point falls behind the chase camera as Sora flies on: a line through the lens). Writes out;
   * false when the whole segment is closer than that.
   */
  function clipToView(a, b, minDepth, out) {
    game.camera.getWorldPosition(_l1); game.camera.getWorldDirection(_l2);
    const da = _l0.subVectors(a, _l1).dot(_l2), db = _l0.subVectors(b, _l1).dot(_l2);
    if (da >= minDepth) { out.copy(a); return true; }
    if (db < minDepth + 1) return false;
    out.lerpVectors(a, b, (minDepth - da) / (db - da));
    return true;
  }

  /** Levels and elements — the bolt leaving the mouth: a thunder flash, a ring, a leader arc ahead, sparks, a light. */
  function boltLaunch(p, from, vel, owner, lvl) {
    const P = E.P, style = p.pal?.arcStyle ?? ARC_STYLE.lightning;
    E.reset();
    P.x = from.x; P.y = from.y; P.z = from.z;
    const ov = owner?.vel?.isVector3 ? owner.vel : null;
    if (ov) { P.vx = ov.x; P.vy = ov.y; P.vz = ov.z; }
    P.life = 0.1; P.size0 = 2.2 * (1 + 0.5 * lvl); P.size1 = 3.2 * (1 + 0.5 * lvl); P.shape = GLOW.star; P.row = ROW.lightning; P.heat = 1; P.cool = 2;
    P.intensity = 0.8; P.squash = 2;
    spawn(E.glow, P);
    _g.copy(vel); if (ov) _g.sub(ov); _g.normalize();
    if (shock) shock.ring({ pos: from, normal: _g, r0: 0.8, r1: 5 + 4 * lvl, life: 0.28, width: 0.08, style: RING_STYLE.lightning, vel: ov ? _h.copy(ov).multiplyScalar(0.7) : null, drag: 0.5, near: 7, intensity: 0.8 });
    if (arcs) {
      for (let i = 0; i < 2; i++) {
        arcs.strike({ from: from.clone(), to: _h.copy(from).addScaledVector(_g, rnd(16, 26) * (1 + 0.4 * lvl)), amp: 0.1, life: 0.09, delay: i * 0.03,
          width: 0.4 * (1 + 0.3 * lvl), minPx: 3, core: 0.24, intensity: 1.1 - 0.3 * i, style, taper: 1, branches: 2, fork: 0.3, prio: true });
      }
    }
    fx.sparks(from, 12 + Math.round(10 * lvl), { row: ROW.lightningSpark, vel: ov, speed: 36, life: 0.22 });
    timedLights.push({ pos: from.clone(), color: p.pal.light, i0: 700 + 500 * lvl, range: 26, t0: game.time.now, dur: 0.18 });
  }

  /**
   * Levels and elements — the bolt striking: a thunder flash (star + blue-white glow, two lightning rings), 6–9 jagged
   * arcs bursting out of the impact, sparks, a light pulse and a small shake; storm also bursts into gold fire. The same
   * near-camera rules as explosions (nearView: kept ≤ 40 % of the view height, dimmer close by). Emits 'explosion'
   * { kind: 'lightning' } (thunder for the audio) and 'lightning' { kind: 'bolt', links }.
   */
  function boltImpact(p, point, R, surface, reason, dir, links) {
    const P = E.P, style = p.pal?.arcStyle ?? ARC_STYLE.lightning, now = game.time.now;
    const B = config.lightning.bolt;
    const lvl = p.charged || 0;
    const nv = nearView(point, R);
    const Rv = R * nv.k;
    const fizzle = reason === 'timeout' || reason === 'shot';
    const mine = isPlayerSrc(p.owner);
    // fix pass (rank 2: "the impact flash at 100–150 m is almost invisible"): every part of the thunder flash has a
    // screen-size floor (flashPx CSS px in radius for Sora's hits); close by, nearView still bounds it (≤ 40 % of the
    // view height, dimmer) — the floor is ~6 % of the view height, so it never fights that cap
    const m = pxAt(point) * (fizzle ? 0.45 : mine ? 1 : 0.6);
    const F = B.flashPx * m;
    E.reset();
    P.x = point.x; P.y = point.y; P.z = point.z; P.life = 0.12; P.size0 = Math.max(2.6 * Rv, 0.7 * F); P.size1 = Math.max(3.6 * Rv, F);
    P.shape = GLOW.star; P.row = ROW.lightning; P.heat = 1; P.cool = 2.2; P.intensity = (fizzle ? 0.6 : 1.3) * nv.flash;
    spawn(E.glow, P);
    E.reset();
    P.x = point.x; P.y = point.y; P.z = point.z; P.life = 0.26 * nv.life; P.size0 = Math.max(1.8 * Rv, 0.55 * F); P.size1 = Math.max(3.2 * Rv, 0.9 * F);
    P.shape = GLOW.soft; P.row = ROW.lightning; P.heat = 0.9; P.cool = 1.2; P.intensity = (fizzle ? 0.4 : 0.95) * nv.flash;
    spawn(E.glow, P);
    if (!fizzle && orbs) {
      // a cel flash ball (inked, white-hot heart, cyan rim): additive light vanishes on a white cloud, this does not.
      // ≤ 10 % of the view height, whatever the range (nearView bounds it close by)
      const cap = 0.1 * 2 * Math.max(nv.d, 1) * Math.tan(((game.camera.fov || 60) * Math.PI) / 360);
      const r1 = Math.min(Math.max(0.9 * Rv, 0.42 * F), cap);
      const slot = orbs.add({ pos: point, radius: r1 * 0.85, row: ROW.lightning, intensity: 1.6, wobble: 0.35 });
      flashOrbs.push({ slot, t0: now, life: 0.11, r0: r1 * 0.85, r1: r1 * 1.1 });
      if (flashOrbs.length > 8) orbs.remove(flashOrbs.shift().slot);
    }
    if (!fizzle) {
      // the afterglow: a softer cyan bloom that holds ~0.3 s where it struck
      E.reset();
      P.x = point.x; P.y = point.y; P.z = point.z; P.life = 0.34 * nv.life; P.size0 = Math.max(1.4 * Rv, 0.5 * F); P.size1 = Math.max(2.4 * Rv, 0.75 * F);
      P.shape = GLOW.soft; P.row = ROW.lightning; P.heat = 0.72; P.cool = 0.6; P.intensity = 0.55 * nv.flash; P.fadeIn = 0.1;
      spawn(E.glow, P);
    }
    // the return stroke: the whole channel from the launch point to the impact flashes and HOLDS (strokeHold s at full,
    // ≥ strokePx px each side, a cyan glow body around it), then fades
    if (arcs && p.launch && !fizzle && clipToView(p.launch, point, 20, _l3)) {
      const Lc = _l3.distanceTo(point);
      if (Lc > 8 && Lc < 480) {
        const hold = clamp(B.strokeHold / B.strokeLife, 0.1, 0.9);
        arcs.strike({ from: _l3.clone(), to: point.clone(), amp: clamp(B.channelJag / Lc, 0.015, 0.08), life: B.strokeLife, hold, flicker: 0.5,
          width: B.width * (1 + 0.3 * lvl), minPx: B.strokePx * (mine ? 1 : 0.6), core: 0.22, intensity: 1.25, style, taper: 2, branches: 3, fork: 0.1, prio: true });
        arcs.strike({ from: _l3.clone(), to: point.clone(), amp: 0, branches: 0, core: 0, over: 0, haze: 1, life: B.strokeLife, hold: hold * 0.8, flicker: 0.4,
          width: 1.6 * (1 + 0.3 * lvl), minPx: 8, intensity: 1.3, style, taper: 2, prio: true });
      }
    }
    if (shock && !fizzle) {
      game.camera.getWorldPosition(_l3).sub(point).normalize();
      shock.ring({ pos: point, normal: _l3, r0: 0.3 * Rv, r1: Math.max(3.0 * Rv, 1.25 * F), life: 0.36, width: 0.1, style: RING_STYLE.lightning, near: 8, intensity: 1.0 * nv.flash });
      shock.ring({ pos: point, normal: dir, r0: 0.3 * Rv, r1: Math.max(4.2 * Rv, 1.7 * F), life: 0.5, width: 0.05, style: RING_STYLE.lightning, near: 8, intensity: 0.6 * nv.flash, delay: 0.04 });
    }
    if (arcs) {
      // the starburst: jagged cel strokes bursting out (the first half at once, the rest a beat later), ≥ 6 px wide
      const na = fizzle ? 3 : 8 + Math.round(3 * lvl);
      for (let i = 0; i < na; i++) {
        randDir(_l3);
        arcs.strike({ from: point.clone(), to: _h.copy(point).addScaledVector(_l3, Math.max(Rv * rnd(1.6, 3.4), F * rnd(0.8, 1.5))), amp: 0.14, life: rnd(0.1, 0.2),
          delay: i < na / 2 ? 0 : rnd(0.02, 0.07), hold: 0.3, width: 0.3 * Math.sqrt(Math.max(Rv, 1)), minPx: fizzle ? 2 : 3.6, core: 0.2,
          intensity: 1.15 * nv.flash, style, taper: 1, branches: 1, fork: 0.35, prio: i < 4 });
      }
      // chain links flicker 3 times (the jumps are instant; the eye needs ~0.15 s to see them)
      const cd = B.chainDelay;
      for (const ln of links) {
        for (let r = 0; r < 3; r++) {
          arcs.strike({ from: ln.a?.pos ? { ref: ln.a.pos, off: ln.aOff } : ln.aOff, to: { ref: ln.b.pos, off: ln.bOff }, amp: config.lightning.chainAmp,
            life: 0.1, delay: (ln.k - 1) * cd + r * 0.06, width: 0.42 * (1 + 0.3 * lvl), minPx: 3, core: 0.24, intensity: 1.1 * Math.pow(0.88, ln.k - 1), style,
            branches: 1, fork: 0.25, prio: true });
        }
      }
    }
    fx.sparks(point, fizzle ? 8 : 24, { row: ROW.lightningSpark, speed: 40, life: 0.3 });
    if (p.pal?.boltFire && !fizzle) fx.explosion(point, { radius: R * 0.75, kind: 'dragon', row: ROW.inferno, surface, cause: reason, projectile: p });
    else if (surface === 'ground' && !fizzle) fx.sparks(point, 10, { row: ROW.lightningSpark, speed: 22, life: 0.35, normal: _up });
    timedLights.push({ pos: point.clone(), color: p.pal.light, i0: (fizzle ? 200 : 520) * R, range: 10 * R + 14, t0: now, dur: 0.32 });
    if (config.shake && game.cameraRig?.shake && !fizzle) {
      const amt = clamp(0.7 - nv.d / (40 * R), 0, 0.6);
      if (amt > 0.02) { try { game.cameraRig.shake(amt, 0, 'near'); } catch { /* optional */ } }
    }
    if (mine && !fizzle) {
      // the thunderclap, whatever the range: a short screen flash (edges of the view, ~80 ms at full) and a light kick
      // of the camera away from the strike
      const far = smoothstep(60, 320, nv.d);
      sflash?.flash({ amount: B.screenFlash * mix(1, 0.6, far) * (p.pal?.boltFire ? 0.9 : 1), color: p.pal?.boltFire ? STORM_FLASH : BOLT_FLASH, hold: 0.08, fade: 0.09, centre: 0.2 });
      if (config.shake && typeof game.cameraRig?.kick === 'function') {
        try { game.camera.getWorldPosition(_l3).sub(point); if (_l3.lengthSq() > 1) game.cameraRig.kick(_l3.normalize(), B.kick * mix(1, 0.6, far)); } catch { /* optional */ }
      }
    }
    game.events.emit('explosion', { point: point.clone(), radius: R, kind: 'lightning', cause: reason, projectile: p });
    game.events.emit('lightning', { kind: 'bolt', point: point.clone(), owner: p.owner, links: links.length, element: p.element });
  }

  /**
   * Flight moves: a charged fireball's extras — two helical spark arms spiralling around its path and flat energy rings
   * left along it every ~6–9 m (shock.js, perpendicular to the flight), both scaled by the charge level.
   */
  function chargedVisuals(p, vis, moved, dt, lvl) {
    const P = E.P, vr = p.visualRadius, now = game.time.now;
    const sp = p.vel.length();
    if (sp < 1) return;
    const vd = _g.copy(p.vel).divideScalar(sp);
    const u = _h.crossVectors(vd, Math.abs(vd.y) < 0.95 ? _up : _x).normalize();
    const w = _k.crossVectors(vd, u);
    p.spiralAcc = (p.spiralAcc || 0) + dt * 90 * lvl * Math.min(1, E.quality + 0.25);
    const n = Math.floor(p.spiralAcc);
    p.spiralAcc -= n;
    for (let i = 0; i < n; i++) {
      const f = (i + Math.random()) / n;
      const ang = (now - (1 - f) * dt) * 17 + (i % 2) * Math.PI + p.id;
      const c = Math.cos(ang), si = Math.sin(ang), R = vr * 1.25;
      E.reset();
      P.t0 = now - (1 - f) * dt;
      P.x = vis.x + (u.x * c + w.x * si) * R - vd.x * (1 - f) * sp * dt;
      P.y = vis.y + (u.y * c + w.y * si) * R - vd.y * (1 - f) * sp * dt;
      P.z = vis.z + (u.z * c + w.z * si) * R - vd.z * (1 - f) * sp * dt;
      // tangential swirl + most of the shot's speed: the sparks trace a helix that falls back behind the orb
      P.vx = p.vel.x * 0.72 + (w.x * c - u.x * si) * 9; P.vy = p.vel.y * 0.72 + (w.y * c - u.y * si) * 9; P.vz = p.vel.z * 0.72 + (w.z * c - u.z * si) * 9;
      P.life = rnd(0.2, 0.3); P.size0 = P.size1 = 0.07 + 0.05 * lvl; P.drag = 1.5; P.stretch = 0.05; P.shape = GLOW.streak;
      P.row = p.hotRow; P.heat = 1; P.cool = 0.9; P.intensity = 1.2;
      spawn(E.glow, P);
    }
    if (shock && dt > 0) {
      p.ringAcc = (p.ringAcc || 0) + moved / (9 - 3 * lvl);
      if (p.ringAcc >= 1) {
        p.ringAcc = Math.min(p.ringAcc - 1, 1);
        shock.ring({ pos: vis, normal: vd, r0: vr * 0.8, r1: vr * (2 + 1.4 * lvl), life: 0.3, width: 0.1, style: p.pal?.ring ?? RING_STYLE.energy,
          intensity: 0.45 + 0.4 * lvl, vel: _w.copy(p.vel).multiplyScalar(0.12), near: 6 });
      }
    }
  }

  // ---------- charges ----------
  function chargeVisuals(c, dt) {
    const P = E.P, q = E.quality;
    if (!objPos(c.obj, _a)) { c.stop(); return; }
    if (c.obj.isObject3D && !isInScene(c.obj)) { c.stop(); return; }
    c.t += dt;
    const k = clamp(c.t / c.seconds, 0, 1);
    const ease = 1 - Math.pow(1 - k, 3);
    const now = game.time.now;
    const pulse = k >= 1 ? 1 + 0.12 * Math.sin(now * 28) : 1;
    c.orb.pos.copy(_a);
    c.orb.radius = c.scale * (0.12 + 0.88 * ease) * pulse * (1 + 0.04 * Math.sin(now * 41));
    c.orb.intensity = 0.8 + 0.5 * k;
    if (dt > 0) {
      const R = c.scale * 6;
      c.acc += dt * (40 + 110 * k) * q;
      while (c.acc >= 1) {
        c.acc -= 1;
        E.reset();
        randDir(_b);
        const r = R * rnd(0.7, 1.3);
        const life = rnd(0.28, 0.45);
        P.x = _a.x + _b.x * r; P.y = _a.y + _b.y * r; P.z = _a.z + _b.z * r;
        const sp = (r * 0.92) / life;
        P.vx = -_b.x * sp + (c.vel?.x || 0); P.vy = -_b.y * sp + (c.vel?.y || 0); P.vz = -_b.z * sp + (c.vel?.z || 0);
        P.life = life; P.size0 = P.size1 = 0.05 + 0.04 * c.scale;
        P.stretch = 0.05; P.shape = GLOW.streak; P.row = sparkRow(c.row); P.heat = 0.9; P.cool = -0.2; P.intensity = 1.2; P.fadeIn = 0.3;
        spawn(E.glow, P);
      }
      // swirling flame wisps pulled into the palm
      c.acc2 = (c.acc2 || 0) + dt * (10 + 30 * k) * q;
      while (c.acc2 >= 1) {
        c.acc2 -= 1;
        E.reset();
        randDir(_b);
        const r = c.scale * rnd(1.6, 2.6);
        const life = rnd(0.25, 0.4);
        P.x = _a.x + _b.x * r; P.y = _a.y + _b.y * r; P.z = _a.z + _b.z * r;
        _c.set(-_b.z, 0, _b.x).multiplyScalar(r * 2);
        P.vx = -_b.x * r / life + _c.x + (c.vel?.x || 0); P.vy = -_b.y * r / life + (c.vel?.y || 0); P.vz = -_b.z * r / life + _c.z + (c.vel?.z || 0);
        P.life = life; P.size0 = c.scale * 0.5; P.size1 = c.scale * 0.9; P.stretch = 0.03;
        P.heat = 0.95; P.cool = 0.2; P.row = c.row; P.fadeIn = 0;
        spawn(firePool(c.row), P);
      }
      // telegraph pulse rings once charged
      if (k >= 1 && now - (c.ringT || 0) > 0.3) {
        c.ringT = now;
        E.reset();
        P.x = _a.x; P.y = _a.y; P.z = _a.z;
        P.life = 0.3; P.size0 = c.scale * 1.2; P.size1 = c.scale * 3.4; P.shape = GLOW.ring; P.row = c.row; P.heat = 0.9; P.cool = 1; P.intensity = 0.9;
        spawn(E.glow, P);
      }
    }
    lights.request(_a, lightColor(c.row), (60 + 200 * k) * c.scale, 8 + 10 * c.scale, c);
    if (c.t > c.seconds + 8) c.stop();
  }
  function isInScene(o) { let x = o; while (x.parent) x = x.parent; return x === game.scene; }

  // ---------- smoke trails ----------
  function smokerVisuals(sm, dt) {
    const P = E.P, q = E.quality;
    if (!objPos(sm.obj, _a) || (sm.obj.isObject3D && !isInScene(sm.obj))) { smokers.delete(sm.obj); return; }
    if (dt <= 0) return;
    const vel = _b.copy(_a).sub(sm.last || _a).divideScalar(Math.max(dt, 1e-3));
    if (!sm.last) sm.last = _a.clone();
    const s = sm.scale;
    sm.acc += dt * 22 * q * sm.rate;
    const t0 = game.time.now - dt;
    while (sm.acc >= 1) {
      sm.acc -= 1;
      const f = Math.random();
      E.reset();
      P.t0 = t0 + f * dt + 0.08;
      _c.lerpVectors(sm.last, _a, f);
      P.x = _c.x + rnd(-0.6, 0.6) * s; P.y = _c.y + rnd(-0.6, 0.6) * s; P.z = _c.z + rnd(-0.6, 0.6) * s;
      P.vx = vel.x * 0.1; P.vy = vel.y * 0.1 + 2; P.vz = vel.z * 0.1;
      P.life = rnd(1.4, 2.4); P.size0 = 1.2 * s; P.size1 = rnd(3.5, 5.5) * s;
      P.drag = 1.2; P.grav = 1.2; P.row = sm.row; P.heat = sm.fire ? 0.7 : 0; P.spin = rnd(-0.4, 0.4);
      P.opacity = 0.85; P.fadeIn = 0.12;
      spawn(E.smoke, P);
    }
    if (sm.fire) {
      sm.facc += dt * 18 * q * sm.rate;
      while (sm.facc >= 1) {
        sm.facc -= 1;
        const f = Math.random();
        E.reset();
        P.t0 = t0 + f * dt;
        _c.lerpVectors(sm.last, _a, f);
        P.x = _c.x + rnd(-0.8, 0.8) * s; P.y = _c.y + rnd(-0.5, 0.5) * s; P.z = _c.z + rnd(-0.8, 0.8) * s;
        P.vx = vel.x * 0.25; P.vy = vel.y * 0.25 + 3; P.vz = vel.z * 0.25;
        P.life = rnd(0.35, 0.6); P.size0 = 1.0 * s; P.size1 = 2.2 * s; P.drag = 2; P.grav = 5; P.stretch = -0.02;
        P.heat = 0.92; P.cool = 0.6; P.row = sm.fireRow;
        spawn(firePool(sm.fireRow), P);
      }
    }
    sm.last.copy(_a);
  }

  function burnVisuals(b, dt) {
    const P = E.P, q = E.quality;
    if (dt <= 0 || !b.actor.alive) return;
    burnWorld(b, _a);
    const v = b.actor.vel || _b.set(0, 0, 0);
    const s = (b.actor.kind === 'titan' ? 3 : 1) * (isDrake(b.actor) ? 0.6 : 1);
    const left = clamp((b.until - simT) / config.breath.burnTime, 0, 1);
    const fac = b.fac || (b.fac = facFor(b.source, b.source?.kind, b.source?.team || opposing(b.actor.team)));
    b.acc += dt * (12 * left + 3) * q;
    while (b.acc >= 1) {
      b.acc -= 1;
      E.reset();
      const flame = Math.random() < 0.55 * left + 0.25;
      P.x = _a.x + rnd(-1, 1) * s; P.y = _a.y + rnd(-0.5, 0.8) * s; P.z = _a.z + rnd(-1, 1) * s;
      if (flame) {
        P.vx = v.x * 0.7; P.vy = v.y * 0.7 + 4; P.vz = v.z * 0.7;
        P.life = rnd(0.3, 0.55); P.size0 = 0.6 * s; P.size1 = rnd(1.6, 2.6) * s; P.drag = 2.5; P.grav = 6; P.stretch = -0.025;
        P.heat = 0.9; P.cool = 0.6; P.row = fac.row;
        nearCut(P);                                        // feel fix: Sora burning right in front of the chase camera
        spawn(firePool(fac.row), P);
      } else {
        P.t0 += 0.1;
        P.vx = v.x * 0.35; P.vy = v.y * 0.35 + 2.5; P.vz = v.z * 0.35;
        P.life = rnd(0.9, 1.5); P.size0 = 0.7 * s; P.size1 = rnd(1.6, 2.6) * s; P.drag = 1.4; P.grav = 1.5;
        P.row = fac.smoke; P.heat = 0.6 * left;
        spawn(E.smoke, P);
      }
    }
  }

  // ---------- compact bursts (drake deaths) ----------
  function burst(point, o) {
    const P = E.P, q = E.quality;
    const R = Math.max(1, o.radius ?? 4);
    const fac = o.fac || facOfRow(o.row ?? ROW.enemy);
    const row = o.row ?? fac.row;
    const v = o.vel?.isVector3 ? o.vel : null;
    const ix = v ? v.x * 0.45 : 0, iy = v ? v.y * 0.45 : 0, iz = v ? v.z * 0.45 : 0;
    const now = game.time.now;
    stat.bursts++;
    // wave 4: near the camera the burst is scaled to stay on screen, drawn soft and fades sooner (see nearView)
    const nv = nearView(point, R);
    const Rv = R * nv.k, lk = nv.life;
    const fpool = nv.soft ? E.soft : firePool(row), op = nv.soft ? nv.opacity : 1;
    // flash star + ring
    E.reset();
    P.x = point.x; P.y = point.y; P.z = point.z; P.vx = ix; P.vy = iy; P.vz = iz;
    P.life = 0.09; P.size0 = 1.9 * Rv; P.size1 = 2.7 * Rv; P.shape = GLOW.star; P.row = ROW.flash; P.heat = 1; P.cool = 2.5; P.intensity = 1.0 * nv.flash;
    spawn(E.glow, P);
    E.reset();
    P.x = point.x; P.y = point.y; P.z = point.z; P.vx = ix; P.vy = iy; P.vz = iz;
    P.life = 0.28 * lk; P.size0 = 0.3 * Rv; P.size1 = 2.3 * Rv; P.shape = GLOW.ring; P.row = row; P.heat = 0.9; P.cool = 0.8; P.intensity = 0.55 * nv.flash;
    spawn(E.glow, P);
    // three fire puffs and a few tongues
    for (let i = 0; i < 3; i++) {
      E.reset();
      randDir(_a);
      P.x = point.x + _a.x * Rv * 0.2; P.y = point.y + _a.y * Rv * 0.2; P.z = point.z + _a.z * Rv * 0.2;
      P.vx = _a.x * Rv * rnd(1, 2) + ix; P.vy = _a.y * Rv * rnd(1, 2) + Rv * 0.3 + iy; P.vz = _a.z * Rv * rnd(1, 2) + iz;
      P.life = rnd(0.35, 0.5) * lk; P.size0 = Rv * rnd(0.55, 0.7); P.size1 = Rv * rnd(1.0, 1.25); P.grow = 3;
      P.drag = 3.5; P.grav = 2; P.heat = 1.03; P.cool = 0.5; P.row = row; P.spin = rnd(-1, 1);
      P.opacity = op; P.guardWeak = true; P.intensity = nv.boost;
      spawn(fpool, P);
    }
    const nt = Math.max(3, Math.round(6 * q));
    for (let i = 0; i < nt; i++) {
      E.reset();
      randDir(_a); _a.y = _a.y * 0.8 + 0.15; _a.normalize();
      const sp = Rv * rnd(5, 9);
      P.x = point.x; P.y = point.y; P.z = point.z;
      P.vx = _a.x * sp + ix; P.vy = _a.y * sp + iy; P.vz = _a.z * sp + iz;
      P.life = rnd(0.3, 0.5) * lk; P.size0 = Rv * rnd(0.3, 0.4); P.size1 = Rv * rnd(0.7, 0.9); P.grow = 2.5;
      P.drag = 6; P.grav = 3; P.stretch = 0.015; P.heat = rnd(0.9, 1.0); P.cool = 0.55; P.row = row; P.spin = rnd(-1.5, 1.5);
      P.opacity = op; P.guardWeak = true; P.intensity = nv.boost;
      spawn(fpool, P);
    }
    // one smoke puff (two tones: faction smoke + light grey), appearing as the fire dies
    for (let i = 0; i < 3; i++) {
      E.reset();
      randDir(_a); _a.y = Math.abs(_a.y) * 0.5 + 0.3; _a.normalize();
      P.t0 = now + rnd(0.12, 0.22) * lk;
      P.x = point.x + _a.x * Rv * 0.4 + ix * 0.15; P.y = point.y + _a.y * Rv * 0.4 + iy * 0.15; P.z = point.z + _a.z * Rv * 0.4 + iz * 0.15;
      P.vx = _a.x * Rv * 0.8 + ix * 0.6; P.vy = _a.y * Rv * 0.8 + 1.2 + iy * 0.6; P.vz = _a.z * Rv * 0.8 + iz * 0.6;
      P.life = rnd(0.9, 1.4) * lk; P.size0 = Rv * rnd(0.5, 0.6); P.size1 = Rv * rnd(1.0, 1.3);
      P.drag = 2; P.grav = 1.2; P.row = i === 2 ? SMOKE.puff : fac.smoke; P.heat = 0.8; P.spin = rnd(-0.3, 0.3);
      P.opacity = mix(0.5, 1, nv.opacity); P.guardWeak = true;
      spawn(E.smoke, P);
    }
    // sparks
    const nk = Math.max(4, Math.round(9 * q));
    for (let i = 0; i < nk; i++) {
      E.reset();
      randDir(_a);
      const sp = rnd(22, 42) * Math.sqrt(nv.k);
      P.x = point.x; P.y = point.y; P.z = point.z; P.vx = _a.x * sp + ix; P.vy = _a.y * sp + 3 + iy; P.vz = _a.z * sp + iz;
      P.life = rnd(0.3, 0.7) * lk; P.size0 = P.size1 = 0.09;
      P.drag = 2.6; P.grav = -9.8; P.stretch = 0.04 * mix(0.35, 1, nv.k); P.shape = GLOW.streak; P.row = fac.spark; P.heat = 1; P.cool = 1.1; P.intensity = 1.4;
      spawn(E.glow, P);
    }
    if (o.surface === 'sea' || o.surface === 'ground') {
      for (let i = 0; i < 4; i++) {
        E.reset();
        const a = (i / 4) * 6.283 + rnd(-0.4, 0.4);
        P.x = point.x; P.y = point.y + 0.3; P.z = point.z;
        P.vx = Math.cos(a) * Rv * rnd(2, 3.5); P.vy = o.surface === 'sea' ? rnd(8, 14) : rnd(1, 3); P.vz = Math.sin(a) * Rv * rnd(2, 3.5);
        P.life = rnd(0.9, 1.5); P.size0 = Rv * 0.4; P.size1 = Rv * rnd(0.9, 1.2);
        P.drag = 2; P.grav = o.surface === 'sea' ? -9 : 0.8; P.row = o.surface === 'sea' ? SMOKE.spray : SMOKE.dust; P.spin = rnd(-0.4, 0.4);
        spawn(E.smoke, P);
      }
    }
    timedLights.push({ pos: point.clone(), color: fac.light, i0: 260 * R, range: 7 * R + 8, t0: now, dur: 0.25 });
    if (config.shake && game.cameraRig?.shake) {
      const amt = clamp(0.45 - nv.d / (30 * R), 0, 0.4);
      if (amt > 0.02) { try { game.cameraRig.shake(amt, 0, 'near'); } catch { /* optional */ } }
    }
    game.events.emit('explosion', { point: point.clone(), radius: R, kind: o.kind || 'drake', cause: o.cause || 'direct', projectile: null });
  }

  /**
   * Levels and elements — the level-up burst around Sora (the 'levelup' event, or fx.levelUp): two aura rings riding
   * with her (one flat around her, one facing the camera: a halo from the chase view), a flash, a rising helix of
   * element twinkles and a spark burst, element-coloured soft flames licking up around her (fire elements) or
   * lightning crackling over her body (lightning / storm), and a light pulse. A new element (elementChanged) is bigger:
   * a third ring and more of everything. Everything drifts with her, lives ≤ 1.1 s and stays off the view: rings fade
   * within 8 m of the lens, the halo ring stops at ~60 % of the view height from the chase camera.
   */
  let lastLevelUp = { level: -1, t: -1e9 };
  function levelUp(dragon, o = {}) {
    if (!ensure() || !config.elements.levelUp) return false;
    const d = dragon || game.player;
    const pos = d?.pos?.isVector3 ? d.pos : null;
    if (!pos) return false;
    const now = game.time.now;
    const lvl = Number.isFinite(+o.level) ? +o.level : 0;
    // the event + an explicit call for the same level; several levels at once (a titan kill): one burst, unless the
    // element changes with the later one
    if ((lvl === lastLevelUp.level || !o.elementChanged) && now - lastLevelUp.t < 0.4) return false;
    lastLevelUp = { level: lvl, t: now };
    stat.levelUps++;
    const pal = ELEMENTS[o.element] || playerPalette();
    const big = !!o.elementChanged;
    const P = E.P, q = E.quality;
    const v = d.vel?.isVector3 ? d.vel : _l0.set(0, 0, 0);
    const K = big ? 1.6 : 1;
    const lightningPal = pal.arcs && !pal.fire;
    // flash + glow
    E.reset();
    P.x = pos.x; P.y = pos.y + 1; P.z = pos.z; P.vx = v.x; P.vy = v.y; P.vz = v.z;
    P.life = 0.16; P.size0 = 2.6 * (big ? 1.25 : 1); P.size1 = 3.6 * (big ? 1.25 : 1); P.shape = GLOW.star;
    P.row = lightningPal ? ROW.lightning : ROW.flash; P.heat = 1; P.cool = 2; P.intensity = 0.65; P.squash = 3;
    spawn(E.glow, P);
    E.reset();
    P.x = pos.x; P.y = pos.y + 1; P.z = pos.z; P.vx = v.x; P.vy = v.y; P.vz = v.z;
    P.life = 0.5; P.size0 = 3.5; P.size1 = 5.5 * (big ? 1.2 : 1); P.shape = GLOW.soft; P.row = lightningPal ? ROW.lightning : pal.row;
    P.heat = 0.95; P.cool = 0.9; P.intensity = 0.32; P.fadeIn = 0.1; P.squash = 3;
    spawn(E.glow, P);
    // rings (drift with her: vel = hers, no drag)
    if (shock) {
      game.camera.getWorldPosition(_l1).sub(pos);
      const camD = _l1.length();
      _l1.divideScalar(Math.max(camD, 1e-3));
      const tanH = Math.tan(((game.camera.fov || 60) * Math.PI) / 360);
      const halo = Math.min(10 * (big ? 1.2 : 1), 0.62 * camD * tanH);
      shock.ring({ pos, normal: _up, r0: 3, r1: 20 * (big ? 1.3 : 1), life: big ? 0.9 : 0.75, width: big ? 0.12 : 0.08, style: pal.ring, vel: v, drag: 0, near: 8, intensity: 1 });
      shock.ring({ pos, normal: _l1, r0: 2, r1: halo, life: big ? 0.75 : 0.55, width: big ? 0.1 : 0.06, style: pal.ring, vel: v, drag: 0, near: 8, intensity: big ? 1 : 0.85, delay: 0.06 });
      if (big) {
        shock.ring({ pos, normal: _up, r0: 4, r1: 34, life: 1.0, width: 0.06, style: pal.ring, vel: v, drag: 0, near: 8, intensity: 0.8, delay: 0.16 });
        shock.ring({ pos, normal: _l1, r0: 1.5, r1: halo * 0.8, life: 0.7, width: 0.08, style: pal.ring, vel: v, drag: 0, near: 8, intensity: 0.8, delay: 0.3 });
      }
    }
    // a rising helix of twinkles around her body + a spark burst
    const ns = Math.round(36 * K * Math.max(0.5, q));
    for (let i = 0; i < ns; i++) {
      E.reset();
      const a = i * 0.72 + Math.random() * 0.4, r = rnd(4, 7);
      const ca = Math.cos(a), sa = Math.sin(a);
      P.t0 = now + (i / ns) * 0.35;
      P.x = pos.x + ca * r + v.x * (i / ns) * 0.35; P.y = pos.y + rnd(-3, 1) + v.y * (i / ns) * 0.35; P.z = pos.z + sa * r + v.z * (i / ns) * 0.35;
      P.vx = v.x - sa * 7; P.vy = v.y + rnd(7, 13); P.vz = v.z + ca * 7;
      // (mid-ramp heat: the twinkles carry the element's colour — the top of every spark ramp is white)
      P.life = rnd(0.6, 1.0); P.size0 = rnd(0.35, 0.5); P.size1 = rnd(0.6, 0.95); P.drag = 0; P.shape = GLOW.sparkle;
      P.row = pal.spark; P.heat = i % 3 ? rnd(0.5, 0.68) : 0.95; P.cool = 0.2; P.intensity = rnd(1.1, 1.5); P.rot = rnd(-0.3, 0.3); P.spin = rnd(-2, 2);
      spawn(E.glow, P);
    }
    fx.sparks(pos, Math.round(22 * K), { row: pal.spark, vel: v, speed: 30, life: 0.45 });
    if (pal.fire) {
      // element flames licking up around her (soft class: they glow and let her show through)
      const nf = Math.round(16 * K * Math.max(0.5, q));
      for (let i = 0; i < nf; i++) {
        E.reset();
        const a = Math.random() * 6.2832, r = rnd(2.5, 5.5);
        P.x = pos.x + Math.cos(a) * r; P.y = pos.y + rnd(-2.5, 0.5); P.z = pos.z + Math.sin(a) * r;
        P.vx = v.x + Math.cos(a) * 2; P.vy = v.y + rnd(9, 15); P.vz = v.z + Math.sin(a) * 2;
        P.t0 = now + (big ? rnd(0, 0.3) : 0);
        P.life = big ? rnd(0.5, 0.85) : rnd(0.35, 0.6); P.size0 = rnd(0.6, 0.9); P.size1 = rnd(1.5, 2.4); P.drag = 0; P.grow = 1.6; P.stretch = 0.04;
        P.row = pal.row; P.heat = rnd(0.9, 1.02); P.cool = 0.4; P.spin = rnd(-1.5, 1.5); P.opacity = big ? 0.62 : 0.5; P.fadeIn = 0.15;
        spawn(E.soft, P);
      }
    }
    if (pal.arcs && arcs) {
      // lightning crackling over her body
      const na = big ? 10 : 6;
      for (let i = 0; i < na; i++) {
        randDir(_l2).multiplyScalar(rnd(1.5, 3.5));
        randDir(_l3).multiplyScalar(rnd(5, 8));
        arcs.strike({ from: { ref: pos, off: _l2 }, to: { ref: pos, off: _l3 }, amp: 0.16, life: rnd(0.08, 0.14), delay: rnd(0, 0.55),
          width: 0.3, intensity: 1, style: pal.arcStyle ?? ARC_STYLE.lightning, branches: 1, fork: 0.35, prio: true });
      }
    }
    timedLights.push({ pos: pos.clone(), color: pal.hotLight || pal.light, i0: big ? 1500 : 1000, range: 32, t0: now, dur: 0.6 });
    return true;
  }

  /** 'death' → a kill flash on every dragon (the shot-down moment reads), a compact burst for drakes. */
  function onDeath(e) {
    if (!config.deathFx || !E) return;
    const a = e?.actor;
    if (!a || a.kind !== 'dragon' || !a.pos?.isVector3 || deathDone.has(a)) return;
    deathDone.add(a);
    const fac = facFor(a, 'dragon', a.team);
    try {
      if (isDrake(a)) { burst(a.pos, { radius: clamp(7 * (a.dragon?.scale ?? 0.57), 2.5, 6), fac, row: fac.row, vel: a.vel }); return; }
      stat.killFlashes++;
      fx.impactFlash(a.pos, { size: 7, row: fac.row, ring: true, intensity: 1.1 });
      fx.sparks(a.pos, 16, { row: fac.spark, vel: a.vel, speed: 36, life: 0.45 });
    } catch (err) { console.warn('[fx] death fx failed', err); }
  }

  // ---------- public API ----------
  const fx = {
    name: 'fx',
    config,
    projectiles,           // live fireballs (read-only for HUD threat arrows / tests)
    get streams() { return streams; },
    get burning() { return burning; },

    async init() {
      ensure();
      try { game.events.on('death', onDeath); } catch { /* optional */ }
      try {
        moves?.init();
        // flight moves: the skyfall buff and the inferno special, for pilots that only announce them by event
        game.events.on('momentum', (e) => { if (e && 'skyfall' in e) { ev.skyfall = !!e.skyfall; ev.skyfallT = game.time.now; } });
        game.events.on('special', (e) => { if (e?.name === 'inferno') { ev.inferno = !!e.on; ev.infernoT = game.time.now; } });
      } catch { /* optional */ }
      // levels and elements: the level-up burst around Sora
      try {
        game.events.on('levelup', (e) => {
          try { if (game.state === 'play' || game.state === 'title') levelUp(game.player, e || {}); } catch (err) { console.warn('[fx] level-up fx failed', err); }
        });
      } catch { /* optional */ }
    },

    /**
     * Levels and elements: the level-up burst around a dragon (default Sora). o: { level, element, elementChanged }
     * (the 'levelup' payload). The event already triggers it; a second call for the same level within 0.4 s is ignored.
     */
    levelUp(dragon, o) { try { return levelUp(dragon, o || {}); } catch (e) { console.warn('[fx] levelUp', e); return false; } },

    /**
     * Start/stop a breath stream. src: a Dragon (mouth, mouthDir, vel, actor) or any object with those fields.
     * o (flight moves, optional): { mode: 'normal' | 'inferno', damageMult }. A mode given here holds until changed;
     * a stream switched on without a mode is 'normal' and follows the player's inferno state (game.player.infernoActive
     * or the 'special' event). Calling again while on with a new mode blends the stream over (config.breath.inferno.blend).
     */
    breath(src, on, o) {
      if (!src || !ensure()) return;
      const s = streamFor(src);
      const hasMode = o && typeof o === 'object' && o.mode !== undefined;
      const hasMult = o && typeof o === 'object' && o.damageMult !== undefined;
      const hasElem = o && typeof o === 'object' && o.element !== undefined;
      if (hasMode) { s.mode = o.mode === 'inferno' ? 'inferno' : 'normal'; s.modeAuto = false; }
      if (hasMult) s.dmgMult = Number.isFinite(+o.damageMult) && o.damageMult !== null ? +o.damageMult : null;
      // levels and elements: an explicit element holds until changed (null → back to Sora's own / the faction's)
      if (hasElem) { s.elemExplicit = ELEMENTS[o.element] ? o.element : null; if (s.on) refreshElement(s); }
      const want = !!on && src.alive !== false;
      if (want === s.on) return;
      s.on = want;
      if (want) {
        s.ramp = 0; s.has = false; s.packetAcc = 1; streamColours(s);
        s.beam.t = -1; s.beam.hits.length = 0; s.beam.links = []; s.arcAcc = 1; s.flare = false;
        if (!hasMode) { s.mode = 'normal'; s.modeAuto = true; }
        if (!hasMult) s.dmgMult = null;
      } else s.offT = simT;
      game.events.emit('breath', { actor: actorOf(src) || src, on: want, mode: want ? s.mode : undefined, element: want ? s.elem : undefined });
    },
    isBreathing(src) { return !!streams.get(src)?.on; },
    /** 'inferno' while a stream burns in inferno mode (blend > 0.5), 'normal' while on, null when off. */
    breathMode(src) { const s = streams.get(src); return s?.on ? ((s.inf || 0) > 0.5 ? 'inferno' : 'normal') : null; },
    /** Levels and elements: the element a stream burns with ('ember' … 'storm'; null for enemy fire or when off). */
    breathElement(src) { const s = streams.get(src); return s?.on ? s.elem : null; },
    /** Levels and elements: the element palettes (read-only) and Sora's current one. */
    elements: ELEMENTS,
    get element() { return playerElement(); },

    /** Flight moves (vfx/moves.js). dashRing(pos, dir, { dragon }) — the dash burst + afterimages. */
    dashRing(pos, dir, o) { if (!ensure() || !moves) return false; try { return moves.dashRing(pos, dir, o || {}); } catch (e) { console.warn('[fx] dashRing', e); return false; } },
    /** sonicBoom(pos, dir, { dragon }) — condensation cone riding the dragon + boom ring (dive past ~70 m/s). */
    sonicBoom(pos, dir, o) { if (!ensure() || !moves) return false; try { return moves.sonicBoom(pos, dir, o || {}); } catch (e) { console.warn('[fx] sonicBoom', e); return false; } },
    /** skimMist(dragon, on, { surface: 'cloud'|'terrain'|'water', strength }) — idempotent; the surface is detected. */
    skimMist(dragon, on, o) { if (!ensure() || !moves) return false; try { return moves.skimMist(dragon, on, o || {}); } catch (e) { console.warn('[fx] skimMist', e); return false; } },
    /** nearMiss(pos, { kind, dir, dragon }) — a small streak burst where a close pass happened. */
    nearMiss(pos, o) { if (!ensure() || !moves) return false; try { return moves.nearMiss(pos, o || {}); } catch (e) { console.warn('[fx] nearMiss', e); return false; } },
    get moves() { return moves; },
    /** Levels and elements (fix pass): the screen flash of Sora's bolt hits ({ flash(o), level(), count, active }). */
    get screenFlash() { return sflash; },

    /** Launch a fireball. Returns the projectile (fields: pos, vel, radius, kind, team, owner, target, hp, alive, detonate()). */
    fireball(o = {}) {
      if (!ensure()) return null;
      const owner = actorOf(o.owner);
      const kind = o.kind || (owner?.kind === 'titan' ? 'titan' : 'dragon');
      const titan = kind === 'titan';
      const team = owner?.team || o.team || (titan ? 'enemy' : 'player');
      const from = o.from?.isVector3 ? o.from : (objPos(o.from, new V3()) || new V3());
      const vel = o.vel?.isVector3 ? o.vel.clone() : new V3(0, 0, titan ? 50 : 100);
      // flight moves: a charged shot (F held, level 0..1) is bigger, faster and splashes wider (config.fireball.charged*)
      const FC = config.fireball;
      const lvl = clamp(Number(o.charged) || 0, 0, 1);
      const ov = owner?.vel?.isVector3 ? owner.vel : null;
      if (lvl > 0 && o.chargedSpeed !== false) {
        const k = 1 + FC.chargedSpeed * lvl;
        if (ov) vel.sub(ov).multiplyScalar(k).add(ov); else vel.multiplyScalar(k);
      }
      // levels and elements: Sora's shot takes her element (o.element overrides); lightning / storm fire a bolt
      const pal = titan ? null : elementOf(o.owner, o.element);
      const bolt = !!pal?.arcs && o.bolt !== false;
      const target = o.target ? (o.target.actor || o.target) : null;
      const B = config.lightning.bolt;
      if (bolt) {
        // a bolt is bolt.speed × faster relative to the shooter; the shooter's lead was for a fireball, so it is
        // re-aimed at the intercept for its own speed when that is within bolt.retarget ° of the given direction
        if (ov) vel.sub(ov);
        const rs = vel.length() * B.speed;
        if (rs > 1) {
          vel.setLength(rs);
          const tp = tpos(target), tv = tvel(target);
          if (tp) {
            let t = tp.distanceTo(from) / rs;
            for (let it = 0; it < 2; it++) {
              _g.subVectors(tp, from);
              if (tv) _g.addScaledVector(tv, t);
              if (ov) _g.addScaledVector(ov, -t);
              t = _g.length() / rs;
            }
            if (_g.lengthSq() > 1 && _g.angleTo(vel) <= B.retarget * DEG) vel.copy(_g.normalize()).multiplyScalar(rs);
          }
        }
        if (ov) vel.add(ov);
      }
      const baseR = o.radius ?? (titan ? 5 : 1.6);
      const radius = baseR * (1 + FC.chargedRadius * lvl);
      const damage = o.damage ?? (titan ? 12 : 25);
      const row = o.row ?? (pal ? pal.row : facFor(o.owner, kind, team).row);
      const hotRow = lvl > 0 && pal ? pal.hot : lvl > 0 && row === ROW.player ? ROW.inferno : row;
      const p = {
        id: nextId++, kind, team, targetTeam: opposing(team), owner, target,
        pos: from.clone(), prev: from.clone(), vel, lastVis: null,
        radius, visualRadius: (o.visualRadius ?? baseR * (titan ? 1.0 : 1.1)) * (1 + FC.chargedVisual * lvl),
        damage, splashRadius: o.splashRadius ?? radius * FC.splash * (1 + FC.chargedSplash * lvl),
        splashDamage: o.splashDamage ?? damage * (FC.splashMult + FC.chargedSplashDmg * lvl),
        charged: lvl, hotRow,
        gravity: o.gravity ?? 0, drag: o.drag ?? 0,
        homing: target ? (bolt ? parseHoming({ accel: B.homing, duration: B.homingTime }, kind)
          : parseHoming(o.homing ?? (kind === 'dragon' ? true : null), kind)) : null, homingDone: false,
        life: bolt ? ((o.life ?? 4) / B.speed) * 1.1 : o.life ?? (titan ? 8 : 4), age: 0,
        hp: o.hp ?? (titan ? config.fireball.titanHp : 0), row,
        alive: true, trailAcc: 0, smokeAcc: 0, onExplode: o.onExplode || null,
        // levels and elements
        // (the shooter may pass the jumps — a charged bolt chains more — and their range / falloff: o.chain, o.chainRange,
        //  o.chainMult; else game.progress.chain, config.lightning.chainRadius / chainFalloff)
        pal, element: pal ? pal.name : null, bolt, visPos: from.clone(), boltLen: 0,
        chainN: bolt ? (Number.isFinite(+o.chain) && o.chain !== null && +o.chain >= 0 ? Math.min(8, Math.round(+o.chain)) : chainCount(pal, o.owner)) : 0,
        chainR: bolt && +o.chainRange > 0 ? Math.min(80, +o.chainRange) : null,
        chainK: bolt && +o.chainMult > 0 && +o.chainMult <= 1 ? +o.chainMult : null,
        launch: bolt ? from.clone() : null,
      };
      p.maxHp = p.hp;
      p.orb = orbs.add({ pos: from, radius: p.visualRadius, row: bolt ? ROW.lightning : lvl >= 0.35 ? hotRow : row,
        wobble: bolt ? 0.34 : (titan ? 0.2 : 0.14) + 0.08 * lvl });
      p.detonate = () => detonate(p, 'manual');
      projectiles.push(p);
      if (bolt) { stat.bolts++; boltLaunch(p, from, vel, owner, lvl); }
      // muzzle: a flash and a ring at the launch point
      const P = E.P;
      E.reset();
      P.x = from.x; P.y = from.y; P.z = from.z; P.vx = vel.x * 0.1; P.vy = vel.y * 0.1; P.vz = vel.z * 0.1;
      P.life = 0.12; P.size0 = p.visualRadius * 2.2; P.size1 = p.visualRadius * 3.2; P.shape = GLOW.star; P.row = ROW.flash; P.heat = 0.9; P.cool = 2; P.intensity = 0.8 * (1 - 0.35 * lvl);
      spawn(E.glow, P);
      E.reset();
      P.x = from.x; P.y = from.y; P.z = from.z;
      P.life = 0.25; P.size0 = p.visualRadius; P.size1 = p.visualRadius * 2.6; P.shape = GLOW.ring; P.row = bolt ? ROW.lightning : row; P.heat = 0.85; P.cool = 1; P.intensity = 0.5;
      spawn(E.glow, P);
      if (lvl > 0.1) {
        // charged release: a flat energy ring blown out of the mouth around the shot, sparks and a white-gold pulse
        // (levels and elements: in the element's colours)
        _g.copy(vel).normalize();
        if (shock) shock.ring({ pos: from, normal: _g, r0: 1.2, r1: 6 + 6 * lvl, life: 0.36, width: 0.09, style: pal?.ring ?? RING_STYLE.energy,
          vel: owner?.vel?.isVector3 ? _h.copy(owner.vel).multiplyScalar(0.5) : null, near: 7, intensity: 0.6 + 0.4 * lvl });
        fx.sparks(from, Math.round(8 + 16 * lvl), { row: pal?.spark ?? ROW.spark, vel: owner?.vel, speed: 34, life: 0.35 });
        timedLights.push({ pos: from.clone(), color: pal?.hotLight ?? INFERNO_LIGHT, i0: 300 + 500 * lvl, range: 18 + 10 * lvl, t0: game.time.now, dur: 0.3 });
      }
      game.events.emit('fireball', { projectile: p, owner, kind, element: p.element || undefined, bolt: bolt || undefined });
      return p;
    },

    /** Gathering fire at an Object3D (or Vector3 / actor) for `seconds`, orb up to `scale` m radius. → { stop(), progress } */
    charge(obj, seconds = 1, scale = 1, o = {}) {
      if (!ensure()) return { stop() {}, progress: 0 };
      const kind = o.kind || (scale >= 2.5 ? 'titan' : 'dragon');
      const row = o.row ?? facFor(o.owner || o.actor || (obj && !obj.isVector3 && !obj.isObject3D ? obj : null), kind, o.team || (kind === 'titan' ? 'enemy' : 'player')).row;
      const c = { obj, seconds: Math.max(0.05, seconds), scale, row, kind, t: 0, acc: 0, vel: o.vel || null, alive: true };
      c.orb = orbs.add({ pos: objPos(obj, new V3()) || new V3(), radius: 0, row, wobble: 0.22 });
      c.stop = () => { if (!c.alive) return; c.alive = false; orbs.remove(c.orb); const i = charges.indexOf(c); if (i >= 0) charges.splice(i, 1); };
      charges.push(c);
      return { stop: c.stop, get progress() { return clamp(c.t / c.seconds, 0, 1); }, get alive() { return c.alive; } };
    },

    /** Anime explosion. o: { radius (m, default 5), kind ('dragon'|'titan'|…), row, surface ('air'|'ground'|'sea') } */
    explosion(point, o = {}) {
      if (!ensure() || !point) return;
      const P = E.P, q = E.quality;
      const R = Math.max(0.5, o.radius ?? 5);
      const kind = o.kind || 'dragon';
      // whose fire: explicit row → owner/actor → a dragon dying right here (dragon.js passes its own position)
      let src = o.actor || o.owner || null;
      if (!src && o.row == null && !o.team && kind === 'dragon') src = actorAt(point);
      const fac = o.row != null ? facOfRow(o.row) : facFor(src, kind, src?.team || o.team || (kind === 'titan' ? 'enemy' : 'player'));
      const row = o.row ?? fac.row;
      if (o.compact || kind === 'drake' || (!o.projectile && isDrake(actorOf(src)))) {
        burst(point, { radius: Math.min(R, 8), row, fac, surface: o.surface, vel: o.vel || actorOf(src)?.vel, cause: o.cause, kind });
        return;
      }
      const titan = row === ROW.titan;
      const p = point.clone();
      const now = game.time.now;
      // wave 4: near the camera the blast is scaled to stay within 40 % of the view height, its fire is drawn soft at
      // ≤ 35 % opacity (30 m and closer) and it dies sooner. Damage, light and shake keep the real radius R.
      const nv = nearView(p, R);
      const Rv = R * nv.k, lk = nv.life;
      const fpool = nv.soft ? E.soft : firePool(row), op = nv.soft ? nv.opacity : 1;
      // 1 flash star
      E.reset();
      P.x = p.x; P.y = p.y; P.z = p.z; P.life = 0.11 * mix(0.8, 1, lk); P.size0 = 2.4 * Rv; P.size1 = 3.4 * Rv;
      P.shape = GLOW.star; P.row = ROW.flash; P.heat = 1; P.cool = 2.5; P.intensity = 1.2 * nv.flash;
      spawn(E.glow, P);
      // 2 hot glow
      E.reset();
      P.x = p.x; P.y = p.y; P.z = p.z; P.life = 0.32 * lk; P.size0 = 1.6 * Rv; P.size1 = 2.8 * Rv;
      P.shape = GLOW.soft; P.row = row; P.heat = 1; P.cool = 1.2; P.intensity = 1.1 * nv.flash;
      spawn(E.glow, P);
      // 3 shockwave ring (+ a second, thinner one)
      for (let i = 0; i < 2; i++) {
        E.reset();
        P.x = p.x; P.y = p.y; P.z = p.z; P.life = (i ? 0.5 : 0.34) * lk; P.size0 = 0.4 * Rv; P.size1 = (i ? 3.6 : 2.6) * Rv;
        P.shape = GLOW.ring; P.row = i ? ROW.steam : ROW.flash; P.heat = i ? 1.0 : 0.6; P.cool = 0.6; P.intensity = (i ? 0.35 : 0.55) * nv.flash;
        P.t0 = now + i * 0.04;
        spawn(E.glow, P);
      }
      // 4 fire puffs: an inner fireball body + outward tongues
      const nb = 5;
      for (let i = 0; i < nb; i++) {
        E.reset();
        randDir(_a);
        P.x = p.x + _a.x * Rv * 0.25; P.y = p.y + _a.y * Rv * 0.25; P.z = p.z + _a.z * Rv * 0.25;
        P.vx = _a.x * Rv * rnd(0.6, 1.6); P.vy = _a.y * Rv * rnd(0.6, 1.6) + Rv * 0.3; P.vz = _a.z * Rv * rnd(0.6, 1.6);
        P.life = rnd(0.55, 0.85) * lk; P.size0 = Rv * rnd(0.7, 0.9); P.size1 = Rv * rnd(1.35, 1.7); P.grow = 3;
        P.drag = 3; P.grav = 2; P.heat = 1.05; P.cool = 0.45; P.row = row; P.spin = rnd(-1, 1);
        P.opacity = op; P.guardWeak = true; P.intensity = nv.boost;
        spawn(fpool, P);
      }
      const nf = Math.round(clamp((10 + R * 0.8) * q, 6, 30));
      for (let i = 0; i < nf; i++) {
        E.reset();
        randDir(_a); _a.y = _a.y * 0.8 + 0.2; _a.normalize();
        const sp = Rv * rnd(6, 12);
        P.x = p.x; P.y = p.y; P.z = p.z;
        P.vx = _a.x * sp; P.vy = _a.y * sp; P.vz = _a.z * sp;
        P.life = rnd(0.45, 0.8) * lk; P.size0 = Rv * rnd(0.35, 0.5); P.size1 = Rv * rnd(0.9, 1.3); P.grow = 2.5;
        P.drag = 6; P.grav = 3; P.stretch = 0.012; P.heat = rnd(0.9, 1.0); P.cool = 0.5; P.row = row; P.spin = rnd(-1.5, 1.5);
        P.opacity = op; P.guardWeak = true; P.intensity = nv.boost;
        spawn(fpool, P);
      }
      // 5 smoke billow (appears as the fire dies, then dissipates)
      const ns = Math.round(clamp((5 + R * 0.25) * q, 3, 10));
      for (let i = 0; i < ns; i++) {
        E.reset();
        randDir(_a); _a.y = Math.abs(_a.y) * 0.6 + 0.2; _a.normalize();
        P.t0 = now + rnd(0.12, 0.3) * lk;
        P.x = p.x + _a.x * Rv * 0.6; P.y = p.y + _a.y * Rv * 0.6; P.z = p.z + _a.z * Rv * 0.6;
        P.vx = _a.x * Rv * rnd(0.8, 1.6); P.vy = _a.y * Rv * rnd(0.8, 1.6) + 1.5; P.vz = _a.z * Rv * rnd(0.8, 1.6);
        P.life = rnd(1.1, 1.9) * lk; P.size0 = Rv * rnd(0.45, 0.6); P.size1 = Rv * (titan ? rnd(1.1, 1.5) : rnd(0.9, 1.2));
        // wave 5: titan smoke is a light ash (particles.js row 5), glows less (heat 0.6) and spreads wider as it
        // thins out, so a titan fireball impact leaves a pale, dissipating puff and no red-brown blot
        P.drag = 2; P.grav = 1.5; P.row = fac.smoke; P.heat = titan ? 0.6 : 1; P.spin = rnd(-0.3, 0.3);
        P.opacity = mix(0.5, 1, nv.opacity); P.guardWeak = true;
        if (titan) P.fadeIn = 0.15;
        spawn(E.smoke, P);
      }
      // 6 spark debris
      const nk = Math.round(clamp((18 + R * 2) * q * mix(0.45, 1, nv.k), 6, 48));
      const ks = Math.sqrt(Rv / 5);
      for (let i = 0; i < nk; i++) {
        E.reset();
        randDir(_a);
        const sp = rnd(30, 62) * ks;
        P.x = p.x; P.y = p.y; P.z = p.z; P.vx = _a.x * sp; P.vy = _a.y * sp + 4; P.vz = _a.z * sp;
        P.life = rnd(0.4, 0.95) * lk; P.size0 = P.size1 = 0.09 + 0.05 * ks;
        P.drag = 2.4; P.grav = -9.8; P.stretch = 0.04 * mix(0.35, 1, nv.k); P.shape = GLOW.streak; P.row = sparkRow(row); P.heat = 1; P.cool = 1.1; P.intensity = 1.5 * nv.flash;
        spawn(E.glow, P);
      }
      // 7 surface response
      if (o.surface === 'sea') {
        for (let i = 0; i < 14; i++) {
          E.reset();
          const a = (i / 14) * 6.283 + rnd(-0.2, 0.2), r = rnd(0.2, 0.9) * Rv;
          P.x = p.x + Math.cos(a) * r; P.y = p.y + 0.5; P.z = p.z + Math.sin(a) * r;
          const up = rnd(14, 30) * ks;
          P.vx = Math.cos(a) * rnd(4, 10) * ks; P.vy = up; P.vz = Math.sin(a) * rnd(4, 10) * ks;
          P.life = rnd(1.1, 1.9); P.size0 = Rv * 0.4; P.size1 = Rv * rnd(0.9, 1.4);
          P.drag = 1.2; P.grav = -10; P.row = SMOKE.spray; P.spin = rnd(-0.5, 0.5);
          spawn(E.smoke, P);
        }
      } else if (o.surface === 'ground') {
        for (let i = 0; i < 10; i++) {
          E.reset();
          const a = (i / 10) * 6.283 + rnd(-0.3, 0.3);
          P.x = p.x; P.y = p.y; P.z = p.z;
          P.vx = Math.cos(a) * Rv * rnd(3, 5); P.vy = rnd(1, 3); P.vz = Math.sin(a) * Rv * rnd(3, 5);
          P.life = rnd(1.2, 2.2); P.size0 = Rv * 0.4; P.size1 = Rv * rnd(1.0, 1.5);
          P.drag = 2.5; P.grav = 0.8; P.row = SMOKE.dust; P.spin = rnd(-0.4, 0.4);
          spawn(E.smoke, P);
        }
      }
      timedLights.push({ pos: p, color: fac.light, i0: 400 * R, range: 9 * R + 10, t0: now, dur: 0.45 });
      if (config.shake && game.cameraRig?.shake) {
        const d = nv.d;
        const amt = clamp(0.9 - d / (40 * R), 0, 0.8);
        if (amt > 0.02) { try { game.cameraRig.shake(amt, 0, titan ? 'titan' : 'near'); } catch { /* optional */ } }
      }
      game.events.emit('explosion', { point: p, radius: R, kind, cause: o.cause || 'direct', projectile: o.projectile || null });
    },

    /** Spark burst. o: { row, vel (inherited Vector3), speed, normal (hemisphere), life } */
    sparks(point, n = 12, o = {}) {
      if (!ensure() || !point) return;
      const P = E.P;
      const cnt = Math.max(1, Math.round(n * Math.min(1.25, E.quality)));
      const sp0 = o.speed ?? 32;
      for (let i = 0; i < cnt; i++) {
        E.reset();
        randDir(_a);
        if (o.normal && _a.dot(o.normal) < 0) _a.reflect(o.normal);
        const sp = sp0 * rnd(0.6, 1.3);
        P.x = point.x; P.y = point.y; P.z = point.z;
        P.vx = _a.x * sp + (o.vel?.x || 0); P.vy = _a.y * sp + (o.vel?.y || 0); P.vz = _a.z * sp + (o.vel?.z || 0);
        P.life = (o.life ?? 0.28) * rnd(0.6, 1.3); P.size0 = P.size1 = rnd(0.06, 0.11);
        P.drag = 3; P.grav = -9.8; P.stretch = 0.03; P.shape = GLOW.streak; P.row = o.row ?? ROW.spark; P.heat = 1; P.cool = 1.2; P.intensity = 1.4;
        spawn(E.glow, P);
      }
    },

    /** Small hit flash (star + glow + optional ring). o: { size (m, default 3), row, starRow (the star's, ROW.flash), ring, intensity } */
    impactFlash(point, o = {}) {
      if (!ensure() || !point) return;
      const P = E.P, S = o.size ?? 3;
      E.reset();
      P.x = point.x; P.y = point.y; P.z = point.z; P.life = 0.1; P.size0 = S; P.size1 = S * 1.3;
      P.shape = GLOW.star; P.row = o.starRow ?? ROW.flash; P.heat = 0.9; P.cool = 2; P.intensity = 1;
      spawn(E.glow, P);
      E.reset();
      P.x = point.x; P.y = point.y; P.z = point.z; P.life = 0.16; P.size0 = S * 0.8; P.size1 = S;
      P.shape = GLOW.soft; P.row = o.row ?? ROW.player; P.heat = 1; P.cool = 2; P.intensity = o.intensity ?? 0.9;
      spawn(E.glow, P);
      if (o.ring !== false) {
        E.reset();
        P.x = point.x; P.y = point.y; P.z = point.z; P.life = 0.22; P.size0 = S * 0.3; P.size1 = S * 1.6;
        P.shape = GLOW.ring; P.row = ROW.flash; P.heat = 0.7; P.cool = 1; P.intensity = 0.7;
        spawn(E.glow, P);
      }
    },

    /** Burning / falling smoke trail following an Object3D (or actor). o: { scale, fire (default true), row } */
    smoke(obj, on, o = {}) {
      if (!obj || !ensure()) return;
      if (!on) { smokers.delete(obj); return; }
      if (smokers.has(obj)) return;
      // the trail of a falling dragon leaks its own faction's fire (violet for Shade Riders, gold for Sora)
      const a = o.actor || actorByRoot(obj);
      const fac = o.fireRow != null ? facOfRow(o.fireRow) : facFor(a || o.owner, a?.kind, a?.team || o.team || 'player');
      const small = isDrake(a);
      smokers.set(obj, {
        obj, scale: o.scale ?? (small ? 0.55 : 1), fire: o.fire !== false, row: o.row ?? fac.smoke,
        fireRow: o.fireRow ?? fac.row, acc: 0, facc: 0, last: null, rate: o.rate ?? (small ? 0.45 : 1),
      });
    },

    /**
     * Compact death burst for small dragons (drakes): flash, ring, 3 fire puffs, a few tongues, a smoke puff and
     * sparks — about a third of an explosion's particles, so a flock can die at once. o: { radius (m, 4), actor,
     * row, team, vel (inherited), surface }
     */
    burst(point, o = {}) {
      if (!ensure() || !point) return;
      const a = actorOf(o.actor);
      if (a) { if (deathDone.has(a)) return; deathDone.add(a); }
      const fac = o.row != null ? facOfRow(o.row) : facFor(a, a?.kind, a?.team || o.team || 'enemy');
      burst(point, { radius: o.radius ?? 4, row: o.row ?? fac.row, fac, vel: o.vel || a?.vel, surface: o.surface, kind: 'drake' });
    },

    /** Remove every projectile, charge, stream, trail and live particle (retry / checkpoint). No explosions. */
    clear() {
      if (!E) return;
      try {
        for (const p of [...projectiles]) { p.reason = 'cleared'; remove(p); }
        for (const c of [...charges]) c.stop();
        for (const s of streams.values()) if (s.on) fx.breath(s.src, false);
        streams.clear(); smokers.clear(); burning.clear(); shocked.clear(); timedLights.length = 0;
        E.flame.clear(); E.smoke.clear(); E.soft.clear(); E.glow.clear();
        moves?.clear(); shock?.clear(); arcs?.clear(); sflash?.clear();
        for (const f of flashOrbs) orbs.remove(f.slot);
        flashOrbs.length = 0;
      } catch (e) { console.warn('[fx] clear failed', e); }
    },

    /** Debug: the sources that won the 4 toon fire-light slots last frame (nearest to the camera first). */
    lightSlots() {
      if (!lights) return [];
      return lights.last.map((l) => {
        const k = l.key;
        let src = 'other';
        if (k && streams.get(k.src) === k) src = 'breath:' + (actorOf(k.src)?.name || k.src.name || '?');
        else if (k && projectiles.includes(k)) src = 'fireball:' + k.kind + ':' + (k.owner?.name || '?');
        else if (k && charges.includes(k)) src = 'charge';
        else if (k && k.dur) src = 'explosion';
        return { src, dist: l.dist, score: l.score, intensity: l.intensity };
      });
    },

    /** Debug/test counters. */
    stats() {
      if (!E) return null;
      const now = game.time.now;
      return {
        flame: E.flame.live(now), soft: E.soft.live(now), smoke: E.smoke.live(now), glow: E.glow.live(now),
        projectiles: projectiles.length, orbs: orbs.count, charges: charges.length,
        streams: [...streams.values()].filter((s) => s.on).length, burning: burning.size,
        lights: lights.active, lightRequests: lights.stat.requests, lightPeak: lights.stat.peakRequests, ribbons: ribbons.count,
        bursts: stat.bursts, killFlashes: stat.killFlashes,
        spawned: stat.spawned, fireTicks: stat.ticks, fireDamage: Math.round(stat.fireDamage),
        moves: moves ? moves.stats() : null, shock: shock ? shock.stats : null,
        inferno: [...streams.values()].filter((s) => s.on && (s.inf || 0) > 0.5).length,
        // levels and elements
        element: playerElement(),
        elements: [...streams.values()].filter((s) => s.on && s.elem).map((s) => s.elem),
        arcs: arcs ? arcs.stats : null, shocked: shocked.size,
        beamTicks: stat.beamTicks, beamDamage: Math.round(stat.beamDamage), chains: stat.chains, chainDamage: Math.round(stat.chainDamage),
        bolts: stat.bolts, boltHits: stat.boltHits, liveBolts: projectiles.filter((p) => p.bolt).length, levelUps: stat.levelUps,
      };
    },

    fixedUpdate(dt) {
      if (!E) return;
      simT += dt;
      try {
        for (const s of streams.values()) breathPackets(s, dt);
        for (let i = projectiles.length - 1; i >= 0; i--) {
          const p = projectiles[i];
          if (p?.alive) stepProjectile(p, dt);
        }
        // burning damage-over-time, extinguished by clouds and the sea
        for (const [actor, b] of burning) {
          if (!actor.alive || simT > b.until) { burning.delete(actor); continue; }
          b.dot += dt;
          if (b.dot >= 0.5) {
            b.dot -= 0.5;
            const pos = actor.pos;
            const wet = pos && (inCloudWet(pos) || pos.y < (game.world.seaLevel ?? 0) + 2);
            if (wet) { burning.delete(actor); continue; }
            if (config.breath.burnDps > 0 && game.combat) {
              try { game.combat.damage(actor, config.breath.burnDps * 0.5, { source: b.source, point: pos?.clone(), kind: 'fire', part: 'body', element: b.fac?.mine ? b.fac.name : undefined }); } catch { /* ignore */ }
            }
          }
        }
      } catch (e) {
        console.error('[fx] fixedUpdate', e);
      }
    },

    update(dt) {
      if (!E) return;
      try {
        E.frame();
        // levels update: the prism flame's rainbow flows (the ramp rows and its light follow the hue)
        if (ascended()) {
          updatePrism(E.tex, game.time.now); prismColor(game.time.now, ELEMENTS.prism.light); prismDirty = true;
          arcs?.setPrism?.(ELEMENTS.prism.light, prismColor(game.time.now + 3, _prismRim));
        }
        else if (prismDirty) { prismDirty = false; updatePrism(E.tex, 0); }
        trackCamera();
        const alpha = game.time.alpha ?? 1;
        ribbons.begin();
        for (const s of streams.values()) {
          if (s.on && s.src.alive === false) fx.breath(s.src, false);
          if (s.on && dt > 0) breathVisuals(s, dt);
          else if (!s.on) { s.has = false; if (!s.packets.length && simT - s.offT > 3) streams.delete(s.src); }
          breathCoreLine(s);
        }
        ribbons.flush();
        for (const p of projectiles) if (p.alive) fireballVisuals(p, dt, alpha);
        shockVisuals(dt);
        for (const c of [...charges]) chargeVisuals(c, dt);
        for (const sm of [...smokers.values()]) smokerVisuals(sm, dt);
        for (const b of burning.values()) burnVisuals(b, dt);
        const now = game.time.now;
        for (let i = timedLights.length - 1; i >= 0; i--) {
          const L = timedLights[i];
          const k = (now - L.t0) / L.dur;
          if (k >= 1) { timedLights.splice(i, 1); continue; }
          lights.request(L.pos, L.color, L.i0 * (1 - k) * (1 - k), L.range, L);
        }
        for (let i = flashOrbs.length - 1; i >= 0; i--) {
          const f = flashOrbs[i], k = (now - f.t0) / f.life;
          if (!(k < 1)) { orbs.remove(f.slot); flashOrbs.splice(i, 1); continue; }
          f.slot.radius = mix(f.r0, f.r1, 1 - (1 - Math.max(0, k)) * (1 - Math.max(0, k)));
          f.slot.intensity = 1.6 * (1 - 0.45 * Math.max(0, k));
        }
        try { moves?.update(dt); shock?.update(dt); } catch (e) { if (!fx._movesWarned) { fx._movesWarned = true; console.error('[fx] flight-move fx', e); } }
        arcs?.update();
        sflash?.update();
        lights.flush();
        orbs.flush();
      } catch (e) {
        console.error('[fx] update', e);
      }
    },
  };
  return fx;
}
