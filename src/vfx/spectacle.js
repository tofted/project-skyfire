// game.spectacle — the "juice" layer (effects update): presentation only, driven by events the game already emits.
//   kills        every shot-down dragon bursts into a double shock ring, a spray of sparks and a slow shower of
//                twinkles; its essence leaves as glowing wisps that curve through the air into Sora (rider 5, ace 9,
//                drake 2) and flash as she takes them in; the screen ripples from the spot and the bloom kicks
//   combos       from ×3 an aura of sparks streams off Sora in her element's colour, thicker with every kill of the
//                chain; an ace, or a ×5 / ×8 / ×12 … chain, lands on a short slow-motion beat
//   level-ups    a pillar of light climbs through Sora with rings on its way up (bigger for a new element)
//   wave cleared a salvo of fireworks ahead of her flight path; the Titan's fall sets off the finale
//   hits taken   a heavy hit ripples the frame from Sora
//   night skies  drifting motes of light around the flight path and shooting stars (the dusk / night / aurora stages)
// Everything is the game's own stateless GPU particles (vfx/particles.js — one more user of the four existing draw
// calls), two screen shockwaves and a kick in the final pass (pipeline.ripple / kick). Slow motion scales
// game.time.scale and always returns it to 1. prefers-reduced-motion: no slow motion, quarter-strength ripples.
// spectacle.config scales or switches each part; spectacle.stats counts what was drawn (tests).
import * as THREE from 'three';
import { getParticles, GLOW } from './particles.js';
import { ROW } from './textures.js';

const V3 = THREE.Vector3;
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const _a = new V3(), _b = new V3(), _c = new V3(), _d = new V3(), _up = new V3(0, 1, 0), _p = new V3();
function randDir(out) { const z = rnd(-1, 1), ph = Math.random() * 6.2832, r = Math.sqrt(1 - z * z); return out.set(r * Math.cos(ph), z, r * Math.sin(ph)); }

/** The essence colours of what was shot down, and Sora's own by element (ramp rows: body, spark). */
const FOE = { drake: [ROW.enemy, ROW.enemySpark], rider: [ROW.enemy, ROW.enemySpark], ace: [ROW.ace, ROW.aceSpark], titan: [ROW.titan, ROW.titanSpark] };
const MINE = {
  ember: [ROW.player, ROW.spark], azure: [ROW.azure, ROW.azureSpark], radiant: [ROW.radiant, ROW.radiantSpark],
  lightning: [ROW.lightning, ROW.lightningSpark], storm: [ROW.inferno, ROW.lightningSpark], prism: [ROW.prism, ROW.prismSpark],
};
/** Firework colours: [ember body, spark]. */
const SHELL_ROWS = [[ROW.radiant, ROW.radiantSpark], [ROW.azure, ROW.azureSpark], [ROW.player, ROW.spark], [ROW.lightning, ROW.lightningSpark], [ROW.enemy, ROW.enemySpark], [ROW.titan, ROW.titanSpark]];
/** Violet / indigo shadowfire burns in the soft class, everything else in the cel flame class (fire.js firePool). */
const SHADOW = new Set([ROW.enemy, ROW.ace]);

export default function createSpectacle(game) {
  const config = {
    on: game.params?.get?.('spectacle') !== '0',
    kills: 1, wisps: 1, aura: 1, fireworks: 1, night: 1, ripples: 1, slowmo: 1,
    comboBeat: [5, 8, 12, 16, 20],      // chains that land on a slow-motion beat
    slow: { scale: 0.32, hold: 0.11, ease: 0.42, gap: 2.5 },
  };
  const stats = { kills: 0, wisps: 0, absorbed: 0, shells: 0, moved: 0, pillars: 0, ripples: 0, beats: 0, motes: 0, stars: 0 };
  const reduced = (() => { try { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();
  let E = null;
  const wisps = [];                       // { p, v, t, delay, life, row, spark, size, trail, seed }
  const shells = [];                      // scheduled fireworks { at, ahead, side, up, row, size }
  const slow = { t: -1, lastAt: -99 };
  let chain = { n: 0, t: -99 };
  let auraAcc = 0, moteAcc = 0, starIn = 4, absorbRun = 0, absorbT = -9, pillar = null, warned = false;
  const warn = (what, e) => { if (!warned) { warned = true; console.warn('[spectacle] ' + what, e); } };

  const q = () => Math.min(1.25, E?.quality ?? 1);
  // (the player system, or its dragon: whichever carries pos / vel — the director's own rule)
  const player = () => { const p = game.player; const d = p && p.pos?.isVector3 ? p : p?.dragon; return d && d.pos?.isVector3 && d.vel?.isVector3 ? d : null; };
  const playerActor = () => game.player?.actor || game.player?.dragon?.actor || (game.actors || []).find((a) => a.team === 'player') || null;
  const playing = () => game.state === 'play';
  /** Sora's colours now: her element's (prism once she has ascended). */
  function mine() {
    let el = 'ember';
    try { el = game.progress?.ascended ? 'prism' : game.progress?.element || 'ember'; } catch { /* ember */ }
    return MINE[el] || MINE.ember;
  }
  /** A world point on screen: uv (0..1, y up) and whether it is in front of the lens and near the view. */
  function screen(pos, out) {
    _p.copy(pos).project(game.camera);
    out.x = _p.x * 0.5 + 0.5; out.y = _p.y * 0.5 + 0.5;
    out.on = _p.z > -1 && _p.z < 1 && out.x > -0.25 && out.x < 1.25 && out.y > -0.25 && out.y < 1.25;
    return out;
  }
  const _scr = { x: 0.5, y: 0.5, on: false };
  function ripple(pos, strength, speed = 1.3, life = 0.75) {
    if (!config.ripples || !game.pipeline?.ripple) return;
    const s = pos ? screen(pos, _scr) : (_scr.x = 0.5, _scr.y = 0.5, _scr.on = true, _scr);
    if (!s.on) return;
    if (game.pipeline.ripple(s.x, s.y, strength * config.ripples, speed, life)) stats.ripples++;
  }
  const kick = (a) => { try { game.pipeline?.kick?.(a); } catch { /* optional */ } };

  // ---- particle helpers (records for the shared glow pool) -------------------------------------------------------
  function glow(pos, shape, row, size0, size1, life, intensity = 1, heat = 1, cool = 1) {
    const P = E.reset();
    P.x = pos.x; P.y = pos.y; P.z = pos.z; P.shape = shape; P.row = row; P.size0 = size0; P.size1 = size1; P.life = life;
    P.intensity = intensity; P.heat = heat; P.cool = cool;
    E.glow.push(P);
  }
  /** n sparks from a point: streaks that fly out, slow down and fall. vel: inherited velocity. */
  function sparks(pos, n, row, speed, life, o = {}) {
    const cnt = Math.max(1, Math.round(n * q()));
    for (let i = 0; i < cnt; i++) {
      const P = E.reset();
      randDir(_a);
      if (o.up) _a.y = Math.abs(_a.y) * o.up + _a.y * (1 - o.up);
      const sp = speed * rnd(0.45, 1.25);
      P.x = pos.x; P.y = pos.y; P.z = pos.z;
      P.vx = _a.x * sp + (o.vel?.x || 0); P.vy = _a.y * sp + (o.vel?.y || 0); P.vz = _a.z * sp + (o.vel?.z || 0);
      P.life = life * rnd(0.6, 1.25); P.size0 = P.size1 = (o.size ?? 0.16) * rnd(0.7, 1.3);
      P.drag = o.drag ?? 2.2; P.grav = o.grav ?? -7; P.stretch = o.stretch ?? 0.05; P.shape = GLOW.streak; P.row = row;
      P.heat = 1; P.cool = o.cool ?? 0.9; P.intensity = o.intensity ?? 1.5;
      E.glow.push(P);
    }
  }
  /** n puffs of flame in a faction's colours (they read on white clouds, where an additive glow washes out). */
  function puffs(pos, n, row, speed, life, size, o = {}) {
    const pool = SHADOW.has(row) ? E.soft : E.flame;
    const cnt = Math.max(1, Math.round(n * q()));
    for (let i = 0; i < cnt; i++) {
      const P = E.reset();
      randDir(_a);
      const sp = speed * rnd(0.4, 1.2);
      P.x = pos.x + _a.x * size * 0.3; P.y = pos.y + _a.y * size * 0.3; P.z = pos.z + _a.z * size * 0.3;
      P.vx = _a.x * sp + (o.vel?.x || 0); P.vy = _a.y * sp + (o.vel?.y || 0); P.vz = _a.z * sp + (o.vel?.z || 0);
      P.life = life * rnd(0.7, 1.2); P.size0 = size * rnd(0.5, 0.8); P.size1 = size * rnd(1.0, 1.4) * (o.shrink ? 0.25 : 1); P.grow = 3;
      P.drag = o.drag ?? 3; P.grav = o.grav ?? 1.5; P.heat = 1.03; P.cool = o.cool ?? 0.6; P.row = row; P.spin = rnd(-1, 1);
      P.opacity = o.opacity ?? 0.9; P.guardWeak = true; P.intensity = 1;
      pool.push(P);
    }
  }
  /** n twinkles that hang in the air and sink slowly (the anime four-point star). */
  function twinkles(pos, n, row, speed, life, o = {}) {
    const cnt = Math.max(1, Math.round(n * q()));
    for (let i = 0; i < cnt; i++) {
      const P = E.reset();
      randDir(_a);
      const sp = speed * rnd(0.3, 1.2), r0 = o.radius ? rnd(0, o.radius) : 0;
      P.x = pos.x + _a.x * r0; P.y = pos.y + _a.y * r0; P.z = pos.z + _a.z * r0;
      P.vx = _a.x * sp + (o.vel?.x || 0); P.vy = _a.y * sp + (o.vel?.y || 0); P.vz = _a.z * sp + (o.vel?.z || 0);
      P.life = life * rnd(0.6, 1.3); P.size0 = (o.size ?? 0.9) * rnd(0.6, 1.4); P.size1 = P.size0 * 0.5;
      P.drag = o.drag ?? 1.8; P.grav = o.grav ?? -2.5; P.shape = GLOW.sparkle; P.row = row; P.t0 = game.time.now + (o.delay ? rnd(0, o.delay) : 0);
      P.heat = rnd(0.75, 1); P.cool = 0.5; P.intensity = o.intensity ?? 1.3; P.fadeIn = 0.08;
      E.glow.push(P);
    }
  }

  // ---- kills -----------------------------------------------------------------------------------------------------
  function killBurst(actor, kind, combo) {
    const pos = actor?.pos;
    if (!pos?.isVector3) return;
    const [row, spark] = FOE[kind] || FOE.rider;
    const big = (kind === 'titan' ? 3 : kind === 'ace' ? 1.6 : kind === 'rider' ? 1 : 0.55) * config.kills;
    const P = player();
    const dist = P ? P.pos.distanceTo(pos) : 200;
    const near = clamp(1.25 - dist / 700, 0.35, 1);
    stats.kills++;
    // the hit lands: a white ring snaps out, a second one in the dragon's own colour follows it
    glow(pos, GLOW.ring, ROW.flash, 5 * big, 44 * big, 0.42, 1.15, 0.8, 0.9);
    glow(pos, GLOW.ring, spark, 3 * big, 30 * big, 0.7, 0.9, 1, 0.7);
    glow(pos, GLOW.star, ROW.flash, 16 * big, 26 * big, 0.14, 1.1, 0.95, 2);
    glow(pos, GLOW.soft, row, 9 * big, 20 * big, 0.5, 0.75, 1, 1.4);
    puffs(pos, 9 * big, row, 34, 0.55, 4.2 * Math.sqrt(big), { vel: actor.vel });
    // (sizes for a kill 50–250 m away: a 0.2 m spark is under a pixel there)
    const far = clamp(dist / 110, 1, 2.6);
    sparks(pos, 24 * big, spark, 70, 0.7, { vel: actor.vel, drag: 2.4, size: 0.2 * far, stretch: 0.06, intensity: 2 });
    sparks(pos, 8 * big, ROW.flash, 38, 0.45, { vel: actor.vel, drag: 2.8, size: 0.16 * far, intensity: 1.6 });
    twinkles(pos, 16 * big, spark, 22, 1.6, { vel: actor.vel, radius: 3 * big, delay: 0.25, size: 0.95 * far, intensity: 1.6 });
    // the frame feels it: a shockwave from the spot, a bloom kick (a chain hits harder)
    const chainK = clamp(1 + 0.08 * (combo - 1), 1, 1.6);
    ripple(pos, clamp(0.42 * big * near * chainK, 0.12, 1.1), 1.25 + 0.3 * big, 0.6 + 0.2 * big);
    kick(clamp(0.3 * big * near * chainK, 0.1, 0.85));
    // its essence flies to Sora
    if (config.wisps && P) {
      const n = Math.round((kind === 'titan' ? 16 : kind === 'ace' ? 9 : kind === 'rider' ? 5 : 2) * config.wisps * Math.min(1, q() + 0.25));
      for (let i = 0; i < n && wisps.length < 64; i++) {
        randDir(_a);
        _a.y = Math.abs(_a.y) * 0.6 + 0.2;
        wisps.push({ p: pos.clone().addScaledVector(_a, rnd(1, 4)), v: _a.clone().multiplyScalar(rnd(22, 46)).add(actor.vel || _b.set(0, 0, 0)),
          t: 0, delay: rnd(0.12, 0.5) + i * 0.035, life: 4.5, row, spark, size: rnd(1.3, 1.9) * (kind === 'drake' ? 0.8 : 1), trail: 0, seed: Math.random() });
        stats.wisps++;
      }
    }
    // a beat of slow motion for an ace, or when the chain reaches a milestone
    if (kind === 'ace' || config.comboBeat.includes(combo)) beat();
  }
  /** Soul wisps: out of the burst, then pulled into Sora ever harder; drawn as a bright head with a fading tail. */
  function updateWisps(dt) {
    if (!wisps.length) return;
    const P = player();
    const now = game.time.now;
    for (let i = wisps.length - 1; i >= 0; i--) {
      const w = wisps[i];
      w.t += dt;
      if (!P || w.t > w.life) { wisps.splice(i, 1); continue; }
      const t = w.t - w.delay;
      // before the pull: drift out of the fireball and slow down
      if (t < 0) { w.v.multiplyScalar(Math.exp(-2.2 * dt)); }
      else {
        _a.copy(P.pos).sub(w.p);
        const d = _a.length();
        if (d < 3.5 + 0.02 * P.vel.length()) { absorb(P, w); wisps.splice(i, 1); continue; }
        _a.multiplyScalar(1 / Math.max(d, 1e-3));
        // steer toward her at a speed that climbs past her own (she may be diving at 90 m/s)
        const want = 70 + 150 * Math.min(1, t / 1.1) + P.vel.length();
        const k = 1 - Math.exp(-(2.6 + 5 * Math.min(1, t / 0.9)) * dt);
        // a sideways swirl early on, so the wisps arc in instead of flying a straight line
        _b.crossVectors(_a, _up).normalize().multiplyScalar(Math.sin(w.seed * 40 + t * 5) * 0.55 * Math.max(0, 1 - t / 0.9));
        _c.copy(_a).add(_b).normalize().multiplyScalar(want);
        w.v.lerp(_c, k);
      }
      const sp = w.v.length();
      w.p.addScaledVector(w.v, dt);
      // the tail: one glow every 1.3 m flown (frame-rate independent), a twinkle now and then
      w.trail += sp * dt;
      let guard = 0;
      while (w.trail > 1.3 && guard++ < 6) {
        w.trail -= 1.3;
        const R = E.reset();
        R.x = w.p.x - w.v.x / Math.max(sp, 1) * w.trail; R.y = w.p.y - w.v.y / Math.max(sp, 1) * w.trail; R.z = w.p.z - w.v.z / Math.max(sp, 1) * w.trail;
        // (the body row at mid heat: saturated violet / indigo — the spark rows are near white and vanish on a cloud)
        R.shape = GLOW.soft; R.row = w.row; R.size0 = 1.05 * w.size; R.size1 = 0.15; R.life = 0.42; R.intensity = 1.5; R.heat = 0.74; R.cool = 0.5; R.t0 = now;
        E.glow.push(R);
      }
      // … and a body under the glow: a small flame in the fallen dragon's colour (it reads on white clouds)
      w.body = (w.body || 0) + sp * dt;
      if (w.body > 2.2) {
        w.body = 0;
        const B = E.reset();
        B.x = w.p.x; B.y = w.p.y; B.z = w.p.z; B.vx = w.v.x * 0.25; B.vy = w.v.y * 0.25; B.vz = w.v.z * 0.25;
        B.life = 0.42; B.size0 = 1.5 * w.size; B.size1 = 0.5 * w.size; B.grow = 1.5; B.drag = 2; B.heat = 1.03; B.cool = 0.9; B.row = w.row;
        B.opacity = 0.9; B.intensity = 1; B.spin = rnd(-2, 2);
        (SHADOW.has(w.row) ? E.soft : E.flame).push(B);
      }
      // the head (redrawn every frame as a one-frame-plus glow)
      const H = E.reset();
      H.x = w.p.x; H.y = w.p.y; H.z = w.p.z; H.shape = GLOW.soft; H.row = w.row; H.size0 = 1.2 * w.size; H.size1 = 1.0 * w.size;
      H.life = Math.max(0.05, dt * 2.2); H.intensity = 2.4; H.heat = 0.84; H.cool = 0;
      E.glow.push(H);
      if (Math.random() < 6 * dt) { const T = E.reset(); T.x = w.p.x; T.y = w.p.y; T.z = w.p.z; T.shape = GLOW.sparkle; T.row = w.spark; T.size0 = 0.9; T.size1 = 0.4; T.life = 0.5; T.intensity = 1.2; T.heat = 1; T.cool = 0.4; E.glow.push(T); }
    }
  }
  function absorb(P, w) {
    stats.absorbed++;
    const [row, spark] = mine();
    // she takes it in: a small flash in her own colour at her chest, a few motes thrown off
    glow(P.pos, GLOW.soft, row, 3.2, 6.5, 0.22, 0.8, 1, 1.6);
    glow(P.pos, GLOW.sparkle, spark, 2.4, 1, 0.3, 1.3, 1, 0.6);
    const now = game.time.real ?? 0;
    absorbRun = now - absorbT < 0.6 ? absorbRun + 1 : 0;
    absorbT = now;
    // a rising run of soft ticks as the wisps arrive one after another
    try { game.audio?.play?.('uiMove', { volume: 0.16, rate: Math.min(2, 1 + 0.07 * absorbRun) }); } catch { /* optional */ }
  }

  // ---- combo aura ------------------------------------------------------------------------------------------------
  function updateAura(dt) {
    if (!config.aura) return;
    const P = player();
    const now = game.time.now;
    const win = game.director?.comboWindow ?? 6;
    const left = win - (now - chain.t);
    if (!P || chain.n < 3 || left <= 0 || playerActor()?.alive === false) return;
    const k = clamp((chain.n - 2) / 8, 0.15, 1) * clamp(left / 1.5, 0, 1) * config.aura;
    auraAcc += dt * (20 + 80 * k) * q();
    const [row, spark] = mine();
    const sp = P.vel.length();
    _c.copy(P.vel);
    if (sp > 1) _c.multiplyScalar(1 / sp); else _c.set(0, 0, 1);
    _a.crossVectors(_c, _up).normalize(); _b.crossVectors(_a, _c);
    while (auraAcc >= 1) {
      auraAcc -= 1;
      const ang = Math.random() * 6.2832, r = rnd(4.5, 8.5);
      const R = E.reset();
      const cx = Math.cos(ang) * r, cy = Math.sin(ang) * r, back = rnd(-4, 6);
      R.x = P.pos.x + _a.x * cx + _b.x * cy + _c.x * back; R.y = P.pos.y + _a.y * cx + _b.y * cy + _c.y * back; R.z = P.pos.z + _a.z * cx + _b.z * cy + _c.z * back;
      // they ride along with her, swirling around the flight axis and falling slowly behind
      const sw = 9;
      R.vx = P.vel.x * 0.86 + (-Math.sin(ang) * _a.x + Math.cos(ang) * _b.x) * sw; R.vy = P.vel.y * 0.86 + (-Math.sin(ang) * _a.y + Math.cos(ang) * _b.y) * sw + 1.5;
      R.vz = P.vel.z * 0.86 + (-Math.sin(ang) * _a.z + Math.cos(ang) * _b.z) * sw;
      const tw = Math.random() < 0.45;
      R.shape = tw ? GLOW.sparkle : GLOW.streak; R.row = Math.random() < 0.3 ? row : spark;
      R.size0 = tw ? rnd(0.9, 1.7) : rnd(0.09, 0.16); R.size1 = tw ? R.size0 * 0.4 : R.size0; R.stretch = tw ? 0 : 0.045;
      R.life = rnd(0.5, 1.0); R.intensity = 1.2 + 0.9 * k; R.heat = rnd(0.7, 1); R.cool = 0.7; R.fadeIn = 0.15; R.drag = 0.4;
      E.glow.push(R);
    }
  }

  // ---- slow-motion beat ------------------------------------------------------------------------------------------
  function beat() {
    if (!config.slowmo || reduced || !playing()) return;
    const now = game.time.real ?? 0;
    if (now - slow.lastAt < config.slow.gap) return;
    slow.lastAt = now; slow.t = 0;
    stats.beats++;
  }
  function updateSlow(realDt) {
    if (slow.t < 0) return;
    const S = config.slow;
    slow.t += realDt;
    if (!playing()) { slow.t = -1; game.time.scale = 1; return; }
    if (slow.t <= S.hold) game.time.scale = S.scale;
    else {
      const a = (slow.t - S.hold) / S.ease;
      if (a >= 1) { slow.t = -1; game.time.scale = 1; }
      else game.time.scale = S.scale + (1 - S.scale) * a * a * (3 - 2 * a);
    }
  }

  // ---- level-up pillar -------------------------------------------------------------------------------------------
  function levelUp(e = {}) {
    const P = player();
    if (!P || !playing()) return;
    const big = e.elementChanged ? 1.6 : 1;
    pillar = { t: 0, life: 0.55 * big, big, acc: 0 };
    stats.pillars++;
    const [row, spark] = mine();
    for (let i = 0; i < 3; i++) {
      const R = E.reset();
      R.x = P.pos.x; R.y = P.pos.y + i * 5; R.z = P.pos.z; R.vx = P.vel.x; R.vy = P.vel.y + 14 + i * 16; R.vz = P.vel.z;
      R.shape = GLOW.ring; R.row = i === 1 ? ROW.flash : i ? row : spark; R.size0 = 4; R.size1 = (22 + i * 9) * big; R.life = 0.6 + i * 0.12; R.intensity = 1; R.heat = 0.9; R.cool = 0.8;
      R.t0 = game.time.now + i * 0.07;
      E.glow.push(R);
    }
    twinkles(P.pos, 26 * big, spark, 26, 1.3, { vel: P.vel, radius: 5, size: 1.1, grav: 3, delay: 0.3 });
    ripple(P.pos, 0.55 * big, 1.5, 0.8);
    kick(0.45 * big);
    if (e.elementChanged) { salvo(3, 0.5); beat(); }
  }
  function updatePillar(dt) {
    if (!pillar) return;
    const P = player();
    pillar.t += dt;
    if (!P || pillar.t > pillar.life) { pillar = null; return; }
    const [row, spark] = mine();
    pillar.acc += dt * 150 * pillar.big * q();
    while (pillar.acc >= 1) {
      pillar.acc -= 1;
      const ang = Math.random() * 6.2832, r = rnd(1.5, 7.5) * pillar.big;
      const R = E.reset();
      R.x = P.pos.x + Math.cos(ang) * r; R.y = P.pos.y - 6 + rnd(0, 6); R.z = P.pos.z + Math.sin(ang) * r;
      R.vx = P.vel.x; R.vy = P.vel.y + rnd(70, 150); R.vz = P.vel.z;
      R.shape = Math.random() < 0.75 ? GLOW.streak : GLOW.sparkle; R.row = Math.random() < 0.5 ? row : spark;
      R.size0 = R.shape === GLOW.streak ? rnd(0.18, 0.34) : rnd(0.7, 1.3); R.size1 = R.size0; R.stretch = R.shape === GLOW.streak ? 0.11 : 0;
      R.life = rnd(0.35, 0.7); R.intensity = 1.5; R.heat = 1; R.cool = 0.6; R.drag = 1.2;
      E.glow.push(R);
    }
  }

  // ---- fireworks -------------------------------------------------------------------------------------------------
  /** n shells over `span` seconds, bursting ahead of Sora's flight path. */
  function salvo(n, scale = 1, span = null) {
    if (!config.fireworks) return;
    const now = game.time.now;
    const T = span ?? 0.38 * n;
    for (let i = 0; i < n; i++) {
      // (ahead and only a little above her path: in a chase view that is the band around the horizon)
      shells.push({ at: now + 0.25 + (i / Math.max(1, n - 1 || 1)) * T + rnd(0, 0.15), ahead: rnd(170, 330), side: rnd(-130, 130), up: rnd(-6, 58),
        rows: SHELL_ROWS[(Math.floor(Math.random() * 3) + i) % SHELL_ROWS.length], size: rnd(0.85, 1.25) * scale });
    }
  }
  function updateShells() {
    if (!shells.length) return;
    const P = player();
    const now = game.time.now;
    for (let i = shells.length - 1; i >= 0; i--) {
      const s = shells[i];
      if (now < s.at) continue;
      shells.splice(i, 1);
      if (!P) continue;
      // where she is heading now (so the salvo is in view however she turned since the wave fell)
      _c.copy(P.vel).setY(0);
      if (_c.lengthSq() < 1) game.camera.getWorldDirection(_c).setY(0);
      _c.normalize();
      _a.crossVectors(_c, _up);
      // in view: the pipeline hides effects behind a dense cloud, and she is usually flying among them — so a shell
      // goes off where the lens has a clear line to it (a few tries, each nearer; the last one close ahead of her)
      let ahead = s.ahead, side = s.side, up = s.up;
      for (let k = 0; k < 7; k++) {
        _d.copy(P.pos).addScaledVector(_c, ahead).addScaledVector(_a, side); _d.y += up;
        if (clearLine(_d)) break;
        stats.moved++;
        const near = 1 - (k + 1) / 7;                 // 0.86 … 0
        ahead = rnd(60, 110) + 170 * near * Math.random(); side = rnd(-1, 1) * (40 + 80 * near); up = rnd(4, 26 + 40 * near);
      }
      burstShell(_d, s.rows, s.size * clamp(_d.distanceTo(P.pos) / 220, 0.45, 1.1));
    }
  }
  /** Can the lens see this point through the clouds? (ten density samples along the line; true without a sampler) */
  function clearLine(to) {
    const dens = game.clouds?.density;
    if (typeof dens !== 'function') return true;
    try {
      game.camera.getWorldPosition(_b);
      for (let i = 1; i <= 10; i++) {
        const t = i / 10;
        if (dens(_b.x + (to.x - _b.x) * t, _b.y + (to.y - _b.y) * t, _b.z + (to.z - _b.z) * t) > 0.06) return false;
      }
    } catch { return true; }
    return true;
  }
  function burstShell(pos, rows, size) {
    const [body, row] = rows;
    stats.shells++;
    try { config.onShell?.(pos, size); } catch { /* a test hook */ }
    // by day a firework is embers more than light: puffs of flame thrown out with the sparks
    // (200–300 m away: a petal has to be metres across to be more than a dot)
    puffs(pos, 14 * size, body, 40 * size, 1.15, 8.5 * size, { drag: 1.7, grav: -4, shrink: true, cool: 0.7 });
    glow(pos, GLOW.star, ROW.flash, 22 * size, 34 * size, 0.16, 1.2, 0.95, 2);
    glow(pos, GLOW.soft, row, 16 * size, 42 * size, 0.7, 0.7, 1, 1.2);
    glow(pos, GLOW.ring, row, 6 * size, 52 * size, 0.6, 0.8, 0.9, 0.8);
    // a sphere of trails that slow, hang and fall …
    sparks(pos, 78 * size, row, 50 * size, 1.55, { drag: 1.5, grav: -6.5, stretch: 0.085, size: 0.85, cool: 0.75, intensity: 2.2 });
    // … a brighter inner burst, and the glitter that crackles after it
    sparks(pos, 26 * size, ROW.flash, 24 * size, 0.7, { drag: 2.6, grav: -4, stretch: 0.05, size: 0.6 });
    twinkles(pos, 34 * size, row, 32 * size, 1.9, { radius: 6 * size, size: 3.4, delay: 0.7, grav: -3.5, intensity: 1.8 });
    kick(0.22);
    try { game.audio?.play?.('explosion', { pos: pos.clone(), size: 0.7, volume: 0.32 }); } catch { /* optional */ }
  }

  // ---- night skies -----------------------------------------------------------------------------------------------
  function updateNight(dt) {
    if (!config.night) return;
    const night = +game.atmo?.night || 0;
    if (night < 0.2) return;
    const P = player();
    if (!P) return;
    const aurora = +game.atmo?.aurora || 0;
    // motes of light drifting in the air ahead: she flies through them
    moteAcc += dt * (5 + 13 * night) * q() * config.night;
    const sp = P.vel.length();
    _c.copy(P.vel);
    if (sp > 2) _c.multiplyScalar(1 / sp); else game.camera.getWorldDirection(_c);
    while (moteAcc >= 1) {
      moteAcc -= 1;
      randDir(_a);
      const R = E.reset();
      const ahead = rnd(60, 240);
      R.x = P.pos.x + _c.x * ahead + _a.x * rnd(8, 70); R.y = P.pos.y + _c.y * ahead + _a.y * rnd(6, 45); R.z = P.pos.z + _c.z * ahead + _a.z * rnd(8, 70);
      R.vx = rnd(-2, 2); R.vy = rnd(-0.5, 1.5); R.vz = rnd(-2, 2);
      const green = Math.random() < 0.35 + 0.45 * aurora;
      R.shape = Math.random() < 0.3 ? GLOW.sparkle : GLOW.soft; R.row = green ? ROW.prism : Math.random() < 0.5 ? ROW.lightningSpark : ROW.radiantSpark;
      R.size0 = R.shape === GLOW.soft ? rnd(0.5, 1.1) : rnd(0.8, 1.5); R.size1 = R.size0 * 0.8;
      R.life = rnd(2.6, 4.6); R.fadeIn = 0.25; R.intensity = (0.55 + 0.5 * night) * (R.shape === GLOW.soft ? 1 : 1.2);
      R.heat = green ? rnd(0.5, 0.7) : rnd(0.5, 0.9); R.cool = 0.08;
      E.glow.push(R);
      stats.motes++;
    }
    // shooting stars high above (full night only)
    if (night > 0.6) {
      starIn -= dt;
      if (starIn <= 0) {
        starIn = rnd(3.5, 9);
        const az = Math.random() * 6.2832, el = rnd(0.4, 1.0);
        _a.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el));
        _d.copy(game.camera.getWorldPosition(_b)).addScaledVector(_a, 2000);
        const az2 = az + rnd(1.1, 2.0) * (Math.random() < 0.5 ? -1 : 1);
        _c.set(Math.cos(az2), -rnd(0.25, 0.6), Math.sin(az2)).normalize().multiplyScalar(rnd(900, 1500));
        for (let k = 0; k < 2; k++) {
          const R = E.reset();
          R.x = _d.x; R.y = _d.y; R.z = _d.z; R.vx = _c.x; R.vy = _c.y; R.vz = _c.z;
          R.shape = k ? GLOW.wisp : GLOW.streak; R.row = k ? ROW.lightningSpark : ROW.flash; R.size0 = k ? 9 : 4; R.size1 = k ? 4 : 2; R.stretch = k ? 0.2 : 0.13;
          R.life = rnd(0.7, 1.05); R.intensity = k ? 0.8 : 2.2; R.heat = 1; R.cool = 0.5; R.fadeIn = 0.12;
          E.glow.push(R);
        }
        stats.stars++;
      }
    }
  }

  // ---- events ----------------------------------------------------------------------------------------------------
  const safe = (name, fn) => (e) => { if (!config.on || !E) return; try { fn(e || {}); } catch (err) { warn(name, err); } };
  const S = {
    name: 'spectacle',
    config, stats,
    get wisps() { return wisps.length; },
    /** Fireworks on demand (tests, the victory finale): n shells, size scale. */
    salvo, beat,
    /** A kill burst at a point (tests / sandboxes): kind 'drake' | 'rider' | 'ace' | 'titan', the chain count, a velocity. */
    burst(pos, kind = 'rider', combo = 1, vel = null) { if (!E || !pos) return; chain = { n: combo, t: game.time.now }; killBurst({ pos, vel: vel || new V3() }, kind, combo); },
    init() {
      try { E = getParticles(game); } catch (e) { warn('particles', e); return; }
      const on = (n, fn) => { try { game.events.on(n, safe(n, fn)); } catch (e) { warn('listen ' + n, e); } };
      on('director:kill', (e) => { chain = { n: e.combo || 1, t: game.time.now }; killBurst(e.actor, e.kind, e.combo || 1); });
      on('levelup', (e) => levelUp(e));
      on('wave:cleared', (e) => { if (e.index) { salvo(5 + Math.min(3, e.index >> 1)); ripple(null, 0.35, 1.0, 1.0); } });
      on('survival:cleared', () => { salvo(3, 0.8); });
      on('death', (e) => {
        const a = e.actor;
        if (a?.kind === 'titan') { ripple(a.pos, 1.4, 0.8, 1.7); kick(1); salvo(12, 1.5, 6); killBurst(a, 'titan', 1); }
      });
      on('damage', (e) => {
        const P = player();
        if (!P || e.target !== playerActor() || !(e.amount >= 32)) return;
        ripple(P.pos, clamp(e.amount / 150, 0.25, 0.8), 1.7, 0.5);
        kick(clamp(e.amount / 220, 0.15, 0.5));
      });
      on('state', (e) => {
        // a new flight, the title, the results: nothing left hanging in the air, time back at full speed
        if (e.next === 'title' || (e.next === 'play' && e.prev !== 'paused' && e.prev !== 'photo')) { wisps.length = 0; shells.length = 0; pillar = null; chain = { n: 0, t: -99 }; }
        if (e.next !== 'play' && slow.t >= 0) { slow.t = -1; game.time.scale = 1; }
      });
    },
    update(dt, realDt) {
      if (!config.on || !E) return;
      try {
        updateSlow(realDt);
        if (dt <= 0) return;
        updateWisps(dt);
        updateAura(dt);
        updatePillar(dt);
        updateShells();
        updateNight(dt);
      } catch (e) { warn('update', e); }
    },
  };
  return S;
}
