// Flight-move effects — the game.fx additions of the shared move contract (presentation only, no damage):
//   dashRing(pos, dir)    — double-W dash: an anime shock ring she bursts out of, air-shatter streaks, and afterimage
//                            streaks + fading "echo" silhouettes trailing her body for ~0.45 s
//   sonicBoom(pos, dir)   — dive past ~70 m/s: a condensation cone riding the dragon + a wide boom ring + a vapour burst
//   skimMist(dragon, on)  — skimming 3–20 m over a cloud top (mist streams off the wingtips, the cloud churned up behind
//                            the belly), over terrain (dust and torn leaves) or over water (spray)
//   nearMiss(pos)         — a close pass at speed: a small streak burst and a snap ring (+ cloud / dust shreds)
//   the fireball charge-up at the mouth while F is held (game.player.fireCharge), unless the pilot code shows its own
//   fx.charge on a dragon.
// Driven by explicit calls from the pilot code; the move events ('move' dash start, 'nearmiss', 'skim', 'charge') and
// the player's speed (sonic boom) are a fallback, deduplicated so one move never shows twice. Never throws.
import * as THREE from 'three';
import { GLOW, SMOKE } from './particles.js';
import { ROW } from './textures.js';
import { RING_STYLE } from './shock.js';
import { clamp, damp, smoothstep } from '../core/util.js';

const V3 = THREE.Vector3;
const rnd = (a, b) => a + Math.random() * (b - a);
const mix = (a, b, t) => a + (b - a) * t;
const VARIANT_ROW = { hero: ROW.player, crimson: ROW.enemy, drake: ROW.enemy, shade: ROW.enemy, onyx: ROW.ace };

export function createMoveFx(game, { E, shock, orbs, lights, spawn, hasDragonCharge, arcs = null, palette = null }) {
  const config = {
    dash: { r0: 2.2, r1: 13, life: 0.5, width: 0.075, trail: 0.45, streaks: 170, echoes: 3, echoN: 44, echoOpacity: 0.5 },
    boom: { speed: 70, dive: -0.3, cooldown: 3.5, coneLife: 0.65, R: 5.6, L: 11, ring: 28, puffs: 16, streaks: 24 },
    // skim: rates /s at full strength; `carry` = share of her velocity the churned-up dust / spray / cloud keeps (her
    // wake drags it along; with drag it falls back behind her over ~1 s instead of vanishing under the chase camera in
    // 0.4 s); `wash` = downwash rings flattened on the surface under her belly, one every washGap s
    skim: { cloudMax: 28, groundMax: 30, tips: 22, tipWisps: 26, wake: 20, dust: 24, leaves: 36, spray: 34, carry: 0.42, washGap: 0.22 },
    near: { streaks: 12 },
    // charge-up at the mouth from game.player.fireCharge ≥ `from` (a tap of F — a normal shot — stays below it)
    charge: { orb: 0.9, streaks: 90, wisps: 22, from: 0.15, pull: 3.5 },
    auto: true,               // the event / speed fallbacks (see gate())
  };
  const stat = { dash: 0, boom: 0, near: 0, skim: 0, auto: 0 };
  const _a = new V3(), _b = new V3(), _c = new V3(), _d = new V3(), _f = new V3(), _s = new V3(), _u = new V3(), _w = new V3();
  const _tl = new V3(), _tr = new V3(), _up = new V3(0, 1, 0);
  const now = () => game.time.now;
  const q = () => E.quality;

  // ---------- helpers ----------
  /** A Dragon from a Dragon, an actor (actor.dragon) or a proxy; null otherwise. */
  function dragonOf(x) {
    if (!x) return null;
    if (x.pos?.isVector3 && (x.actor || x.root || x.body)) return x;
    if (x.dragon?.pos?.isVector3) return x.dragon;
    if (x.owner?.pos?.isVector3 && x.owner.actor) return x.owner;
    if (x.kind === 'dragon' && x.pos?.isVector3) return x;
    return null;
  }
  function nearestDragon(pos, maxD) {
    let best = null, bd = maxD * maxD;
    const pl = game.player;
    if (pl?.pos?.isVector3) { const d2 = pl.pos.distanceToSquared(pos); if (d2 < bd) { bd = d2; best = pl; } }
    for (const a of game.actors || []) {
      if (a.kind !== 'dragon' || !a.alive || !a.pos?.isVector3) continue;
      const d2 = a.pos.distanceToSquared(pos);
      if (d2 < bd) { bd = d2; best = dragonOf(a) || a; }
    }
    return best;
  }
  const alive = (d) => d && d.alive !== false && d.actor?.alive !== false;
  const rowOf = (d) => VARIANT_ROW[d?.variant ?? d?.actor?.dragon?.variant] ?? (d?.actor?.team === 'enemy' ? ROW.enemy : ROW.player);
  const isFoe = (d) => (d?.actor?.team || d?.team) === 'enemy';
  function fwdOf(d, dir, out) {
    if (dir?.isVector3 && dir.lengthSq() > 1e-6) return out.copy(dir).normalize();
    if (d?.vel?.isVector3 && d.vel.lengthSq() > 1) return out.copy(d.vel).normalize();
    if (d?.quat?.isQuaternion) return out.set(0, 0, 1).applyQuaternion(d.quat);
    return out.set(0, 0, 1);
  }
  /** Any unit vector perpendicular to n. */
  function perp(out, n) {
    const t = Math.abs(n.y) < 0.95 ? _up : _w.set(1, 0, 0);
    return out.crossVectors(n, t).normalize();
  }
  /** wingtips: explicit field → the actor's wing capsules (farthest ends) → a model-space estimate */
  function wingtips(d, outL, outR) {
    if (d.wingtips?.L?.isVector3 && d.wingtips?.R?.isVector3) { outL.copy(d.wingtips.L); outR.copy(d.wingtips.R); return true; }
    const a = d.actor;
    if (a?.shapes?.length && a.pos) {
      let bl = -1, br = -1;
      for (const s of a.shapes) {
        if (s.part !== 'wingL' && s.part !== 'wingR') continue;
        for (const p of [s.a, s.b]) {
          if (!p) continue;
          const dd = p.distanceToSquared(a.pos);
          if (s.part === 'wingL' && dd > bl) { bl = dd; outL.copy(p); }
          if (s.part === 'wingR' && dd > br) { br = dd; outR.copy(p); }
        }
      }
      if (bl > 0 && br > 0) return true;
    }
    if (d.root?.isObject3D) { d.root.localToWorld(outL.set(8, 0.4, -0.5)); d.root.localToWorld(outR.set(-8, 0.4, -0.5)); return true; }
    return false;
  }
  /** A random point on the dragon's body (its hit capsules, weighted by length), for afterimages. */
  function bodyPoint(d, out) {
    const sh = d.actor?.shapes;
    if (sh?.length) {
      let tot = 0;
      for (const s of sh) tot += (s.b ? s.a.distanceTo(s.b) : 0) + s.r;
      let x = Math.random() * tot;
      for (const s of sh) {
        const w = (s.b ? s.a.distanceTo(s.b) : 0) + s.r;
        if ((x -= w) > 0) continue;
        if (s.b) out.lerpVectors(s.a, s.b, Math.random()); else out.copy(s.a);
        return out.set(out.x + rnd(-0.5, 0.5) * s.r, out.y + rnd(-0.5, 0.5) * s.r, out.z + rnd(-0.5, 0.5) * s.r);
      }
    }
    if (d.root?.isObject3D) return d.root.localToWorld(out.set(rnd(-7, 7) * Math.random(), rnd(-0.5, 1), rnd(-6, 6)));
    return out.copy(d.pos);
  }
  function height(x, z) {
    try { const h = game.world?.heightAt?.(x, z); return Number.isFinite(h) ? h : -1e9; } catch { return -1e9; }
  }
  function water(x, z) {
    try {
      const w = game.world?.waterLevelAt?.(x, z);
      if (Number.isFinite(w)) return w;
    } catch { /* optional */ }
    return game.world?.seaLevel ?? 0;
  }
  /** Metres inside the cloud surface at a point (positive inside), or null when no cloud query exists. */
  function inside(x, y, z) {
    try {
      const ins = game.clouds?.inside;
      if (typeof ins === 'function') { const m = ins.call(game.clouds, x, y, z); if (Number.isFinite(m)) return m; }
      const dn = game.world?.cloudDensity;
      if (typeof dn === 'function') { const v = dn.call(game.world, x, y, z) || 0; return (v - 0.5) * 20; }
    } catch { /* never throw */ }
    return null;
  }

  // ---------- dedupe: explicit calls win; event / speed fallbacks only fill in ----------
  const gates = {};
  function gate(name, o) {
    const g = gates[name] || (gates[name] = { lastExplicit: -1e9, lastShown: -1e9, lastAuto: false });
    const t = now();
    if (o?._auto) {
      if (!config.auto) return false;
      if (t - g.lastExplicit < 0.5 || t - g.lastShown < 0.3) return false;
    } else {
      g.lastExplicit = t;
      if (g.lastAuto && t - g.lastShown < 0.3) return false;   // the fallback already showed this one
    }
    g.lastShown = t; g.lastAuto = !!o?._auto;
    if (o?._auto) stat.auto++;
    return true;
  }
  const pending = [];
  const later = (fn, delay = 0.08) => { if (pending.length < 16) pending.push({ fn, t: now() + delay }); };

  // ---------- dash ----------
  const trails = [];
  function dashRing(pos, dir, o = {}) {
    if (!pos?.isVector3 || !gate('dash', o)) return false;
    const d = dragonOf(o.dragon || o.actor) || nearestDragon(pos, 16);
    const fwd = fwdOf(d, dir, _f);
    const vel = d?.vel?.isVector3 ? d.vel : null;
    const style = isFoe(d) ? RING_STYLE.enemy : RING_STYLE.dash;
    const C = config.dash, P = E.P;
    const drift = vel ? _d.copy(vel).multiplyScalar(0.3) : null;
    // the burst ring just behind her chest (she punches out of it), a wider thin echo ring a beat later
    _c.copy(pos).addScaledVector(fwd, -1.5);
    shock.ring({ pos: _c, normal: fwd, r0: C.r0, r1: C.r1, life: C.life, width: C.width, style, vel: drift, drag: 1.5, near: 7 });
    _b.copy(_c).addScaledVector(fwd, -2);
    shock.ring({ pos: _b, normal: fwd, r0: C.r0 * 0.7, r1: C.r1 * 1.45, life: C.life * 1.25, width: C.width * 0.55, intensity: 0.7, style, vel: drift, drag: 1.5, near: 7, delay: 0.06 });
    // air shatter: short white streaks flung out in the ring's plane
    perp(_u, fwd); _s.crossVectors(fwd, _u);
    const n = Math.round(14 * Math.min(1.2, q()));
    for (let i = 0; i < n; i++) {
      E.reset();
      const a = (i / n) * 6.2832 + rnd(-0.2, 0.2), sp = rnd(26, 42);
      _a.copy(_u).multiplyScalar(Math.cos(a)).addScaledVector(_s, Math.sin(a));
      P.x = _c.x + _a.x * 2.5; P.y = _c.y + _a.y * 2.5; P.z = _c.z + _a.z * 2.5;
      P.vx = _a.x * sp + (drift?.x || 0); P.vy = _a.y * sp + (drift?.y || 0); P.vz = _a.z * sp + (drift?.z || 0);
      P.life = rnd(0.2, 0.3); P.size0 = P.size1 = rnd(0.05, 0.09); P.drag = 3; P.stretch = 0.05; P.shape = GLOW.streak;
      P.row = ROW.steam; P.heat = 1; P.cool = 1; P.intensity = 0.9;
      spawn(E.glow, P);
    }
    if (d) trails.push({ d, t: 0, dur: config.dash.trail, acc: 0, echo: 0, row: rowOf(d) });
    stat.dash++;
    return true;
  }
  function trailVisuals(tr, dt) {
    const d = tr.d, P = E.P, C = config.dash;
    tr.t += dt;
    if (tr.t >= tr.dur || !alive(d) || !d.vel?.isVector3) return false;
    const k = 1 - tr.t / tr.dur;
    // afterimage streaks off the body, left behind (they keep 55 % of her speed, so they trail backward)
    tr.acc += C.streaks * q() * k * dt;
    const t0 = now() - dt;
    while (tr.acc >= 1) {
      tr.acc -= 1;
      E.reset();
      P.t0 = t0 + Math.random() * dt;
      bodyPoint(d, _a);
      P.x = _a.x; P.y = _a.y; P.z = _a.z;
      P.vx = d.vel.x * 0.55; P.vy = d.vel.y * 0.55; P.vz = d.vel.z * 0.55;
      P.life = rnd(0.18, 0.28); P.size0 = P.size1 = rnd(0.08, 0.16); P.drag = 0.5;
      const white = Math.random() < 0.55;
      P.stretch = 0.16; P.shape = white ? GLOW.streak : GLOW.wisp; P.row = white ? ROW.steam : tr.row;
      P.heat = white ? 1 : 0.62; P.cool = 0.8; P.intensity = (white ? 0.8 : 0.9) * k;
      spawn(E.glow, P);
    }
    // echoes: faint soft silhouettes of her body stamped in the air behind her (anime afterimage), 3 in 0.25 s
    const due = Math.min(C.echoes, Math.floor(tr.t / 0.075) + 1);
    while (tr.echo < due) {
      tr.echo++;
      const n = Math.round(C.echoN * Math.min(1.2, q()));
      for (let i = 0; i < n; i++) {
        E.reset();
        bodyPoint(d, _a);
        P.x = _a.x; P.y = _a.y; P.z = _a.z;
        P.vx = d.vel.x * 0.35; P.vy = d.vel.y * 0.35; P.vz = d.vel.z * 0.35;
        P.life = rnd(0.18, 0.26); P.size0 = rnd(0.8, 1.1); P.size1 = rnd(1.1, 1.6); P.drag = 1; P.grow = 1.5;
        // pale white-blue ghosts (her own scarlet in soft fire read as fire puffs, not an afterimage)
        P.row = ROW.steam; P.heat = 0.85; P.cool = 0.2; P.opacity = C.echoOpacity * (1 - 0.25 * tr.echo); P.fadeIn = 0.1;
        P.spin = rnd(-1, 1);
        spawn(E.soft, P);
      }
    }
    return true;
  }

  // ---------- sonic boom ----------
  function sonicBoom(pos, dir, o = {}) {
    if (!pos?.isVector3 || !gate('boom', o)) return false;
    const d = dragonOf(o.dragon || o.actor) || nearestDragon(pos, 20);
    const fwd = fwdOf(d, dir, _f).clone();
    const C = config.boom, P = E.P;
    const vel = d?.vel?.isVector3 ? d.vel : null;
    const at = pos.clone();
    // the condensation cone rides the dragon: apex just ahead of her chest, flaring back past the tail
    shock.cone((outP, outD) => {
      if (d) {
        if (!alive(d)) return false;
        if (d.vel?.lengthSq() > 1) outD.copy(d.vel); else outD.copy(fwd);
        outD.normalize();
        outP.copy(d.pos).addScaledVector(outD, 3.5);
      } else { outD.copy(fwd); outP.copy(at); }
      return true;
    }, { life: C.coneLife, R: C.R, L: C.L, intensity: 0.85 });
    const drift = vel ? _d.copy(vel).multiplyScalar(0.2) : null;
    shock.ring({ pos: at, normal: fwd, r0: 4, r1: C.ring, life: 0.75, width: 0.05, style: RING_STYLE.boom, vel: drift, drag: 1.2, near: 8 });
    shock.ring({ pos: at, normal: fwd, r0: 3, r1: C.ring * 1.35, life: 0.9, width: 0.03, intensity: 0.6, style: RING_STYLE.boom, vel: drift, drag: 1.2, near: 8, delay: 0.08 });
    perp(_u, fwd); _s.crossVectors(fwd, _u);
    // vapour burst in a collar around her body, and white streaks flung out in the boom's plane
    const np = Math.round(C.puffs * Math.min(1.2, q()));
    for (let i = 0; i < np; i++) {
      E.reset();
      const a = (i / np) * 6.2832 + rnd(-0.2, 0.2), r = rnd(3, 5);
      _a.copy(_u).multiplyScalar(Math.cos(a)).addScaledVector(_s, Math.sin(a));
      P.x = at.x + _a.x * r; P.y = at.y + _a.y * r; P.z = at.z + _a.z * r;
      const sp = rnd(6, 10);
      P.vx = _a.x * sp + (vel?.x || 0) * 0.35; P.vy = _a.y * sp + (vel?.y || 0) * 0.35; P.vz = _a.z * sp + (vel?.z || 0) * 0.35;
      P.life = rnd(0.8, 1.2); P.size0 = rnd(1.0, 1.4); P.size1 = rnd(3.2, 4.4); P.drag = 1.6; P.grav = 0.4;
      P.row = SMOKE.white; P.heat = 0; P.spin = rnd(-0.3, 0.3); P.opacity = 0.5; P.fadeIn = 0.08;
      spawn(E.smoke, P);
    }
    const ns = Math.round(C.streaks * Math.min(1.2, q()));
    for (let i = 0; i < ns; i++) {
      E.reset();
      const a = Math.random() * 6.2832, sp = rnd(45, 70);
      _a.copy(_u).multiplyScalar(Math.cos(a)).addScaledVector(_s, Math.sin(a));
      P.x = at.x + _a.x * 3; P.y = at.y + _a.y * 3; P.z = at.z + _a.z * 3;
      P.vx = _a.x * sp + (vel?.x || 0) * 0.3; P.vy = _a.y * sp + (vel?.y || 0) * 0.3; P.vz = _a.z * sp + (vel?.z || 0) * 0.3;
      P.life = rnd(0.25, 0.4); P.size0 = P.size1 = rnd(0.06, 0.1); P.drag = 2.5; P.stretch = 0.05; P.shape = GLOW.streak;
      P.row = ROW.steam; P.heat = 1; P.cool = 1; P.intensity = 0.9;
      spawn(E.glow, P);
    }
    E.reset();
    P.x = at.x; P.y = at.y; P.z = at.z; P.vx = vel?.x * 0.5 || 0; P.vy = vel?.y * 0.5 || 0; P.vz = vel?.z * 0.5 || 0;
    P.life = 0.12; P.size0 = 3; P.size1 = 5; P.shape = GLOW.star; P.row = ROW.steam; P.heat = 1; P.cool = 2; P.intensity = 0.55;
    spawn(E.glow, P);
    stat.boom++;
    return true;
  }
  // fallback: the player crossing boom.speed in a dive — only for a pilot without the move contract (no numeric
  // game.player.momentum) that has never called sonicBoom itself; the contract pilot decides its own booms
  const boomWatch = { prev: 0, last: -1e9 };
  function watchBoom() {
    const pl = game.player, C = config.boom;
    if (Number.isFinite(pl?.momentum) || (gates.boom && gates.boom.lastExplicit > -1e9)) return;
    const v = pl?.vel;
    if (!v?.isVector3 || !alive(pl) || game.state !== 'play') { boomWatch.prev = 0; return; }
    const sp = v.length();
    const t = now();
    if (boomWatch.prev < C.speed && sp >= C.speed && v.y / Math.max(sp, 1) < C.dive && t - boomWatch.last > C.cooldown) {
      boomWatch.last = t;
      later(() => { if (alive(pl)) sonicBoom(pl.pos, pl.vel, { dragon: pl, _auto: true }); });
    }
    boomWatch.prev = sp;
  }

  // ---------- near miss ----------
  function nearMiss(pos, o = {}) {
    if (!gate('near', o)) return false;
    const d = dragonOf(o.dragon || o.actor) || game.player;
    if (!pos?.isVector3) pos = guessNearPoint(d, o.kind, _c);
    if (!pos) return false;
    const fwd = fwdOf(d, o.dir, _f);
    const vel = d?.vel?.isVector3 ? d.vel : null;
    const P = E.P;
    const n = Math.round(config.near.streaks * Math.min(1.2, q()));
    for (let i = 0; i < n; i++) {
      E.reset();
      randDir(_a);
      P.x = pos.x + _a.x * 1.2; P.y = pos.y + _a.y * 1.2; P.z = pos.z + _a.z * 1.2;
      const sp = rnd(10, 22);
      P.vx = (vel?.x || 0) * 0.35 + _a.x * sp; P.vy = (vel?.y || 0) * 0.35 + _a.y * sp; P.vz = (vel?.z || 0) * 0.35 + _a.z * sp;
      P.life = rnd(0.22, 0.34); P.size0 = P.size1 = rnd(0.05, 0.09); P.drag = 2; P.stretch = 0.09; P.shape = i % 3 ? GLOW.streak : GLOW.wisp;
      P.row = ROW.steam; P.heat = 1; P.cool = 1; P.intensity = 0.85;
      spawn(E.glow, P);
    }
    shock.ring({ pos, normal: fwd, r0: 0.8, r1: 5, life: 0.28, width: 0.09, style: RING_STYLE.snap, vel: vel ? _d.copy(vel).multiplyScalar(0.3) : null, near: 5 });
    const kind = o.kind || 'enemy';
    if (kind === 'cloud' || kind === 'terrain') {
      for (let i = 0; i < 5; i++) {
        E.reset();
        randDir(_a);
        P.x = pos.x + _a.x * 1.5; P.y = pos.y + _a.y * 1.5; P.z = pos.z + _a.z * 1.5;
        P.vx = (vel?.x || 0) * 0.25 + _a.x * 3; P.vy = (vel?.y || 0) * 0.25 + _a.y * 3 + 1; P.vz = (vel?.z || 0) * 0.25 + _a.z * 3;
        P.life = rnd(0.8, 1.2); P.size0 = rnd(1.2, 1.8); P.size1 = rnd(3.5, 5); P.drag = 1.5; P.grav = 0.4;
        P.row = kind === 'cloud' ? SMOKE.cloud : SMOKE.dust; P.opacity = 0.55; P.fadeIn = 0.1; P.spin = rnd(-0.4, 0.4);
        spawn(E.smoke, P);
      }
    } else {
      E.reset();
      P.x = pos.x; P.y = pos.y; P.z = pos.z;
      P.life = 0.1; P.size0 = 1.4; P.size1 = 2; P.shape = GLOW.star; P.row = ROW.steam; P.heat = 1; P.cool = 2; P.intensity = 0.45;
      spawn(E.glow, P);
    }
    stat.near++;
    return true;
  }
  const randDir = (out) => { const z = rnd(-1, 1), ph = Math.random() * 6.2832, r = Math.sqrt(1 - z * z); return out.set(r * Math.cos(ph), z, r * Math.sin(ph)); };
  /** No point given (event fallback): a spot beside the dragon on the side of what it just missed. */
  function guessNearPoint(d, kind, out) {
    if (!d?.pos?.isVector3) return null;
    const p = d.pos;
    let target = null;
    if (kind === 'terrain') {
      const h = Math.max(height(p.x, p.z), water(p.x, p.z));
      target = _b.set(p.x, h, p.z);
    } else if (kind === 'titan' && game.titan?.actor?.pos?.isVector3) target = game.titan.actor.pos;
    else if (kind === 'enemy' || !kind) {
      let bd = 1e9;
      for (const a of game.actors || []) {
        if (a.team !== 'enemy' || !a.alive || !a.pos?.isVector3) continue;
        const dd = a.pos.distanceToSquared(p);
        if (dd < bd) { bd = dd; target = a.pos; }
      }
    } else if (kind === 'cloud') {
      // the side (left / right / below / above) where the cloud is
      fwdOf(d, null, _f); perp(_u, _f); _s.crossVectors(_f, _u);
      let best = -1e9;
      for (const [x, y] of [[1, 0], [-1, 0], [0, -1], [0, 1]]) {
        _a.copy(p).addScaledVector(_u, x * 12).addScaledVector(_s, y * 12);
        const m = inside(_a.x, _a.y, _a.z);
        if (m != null && m > best) { best = m; target = _w.copy(_a); }
      }
    }
    if (!target) return out.copy(p);
    _a.subVectors(target, p);
    const L = _a.length();
    return out.copy(p).addScaledVector(_a, L > 1e-3 ? Math.min(L, 9) / L : 0);
  }

  // ---------- skim mist ----------
  const skims = new Map();
  function skimMist(dragon, on, o = {}) {
    const d = dragonOf(dragon) || (dragon === undefined ? game.player : null);
    if (!d?.pos?.isVector3) return false;
    let st = skims.get(d);
    if (!st) {
      if (!on) return false;
      st = { d, on: false, str: 0, surface: null, top: 0, close: 0, sampleT: 0, acc: {}, explicit: false, want: 1, forced: null };
      skims.set(d, st);
    }
    if (o._auto) { if (st.explicit || !config.auto) return false; } else st.explicit = true;
    st.on = !!on;
    st.forced = o.surface || null;
    st.want = Number.isFinite(o.strength) ? clamp(o.strength, 0, 1) : 1;
    if (on) stat.skim++;
    return true;
  }
  /** 10 Hz: what is under her — a cloud top, terrain or water — and how close (1 at ≤ 4 m, 0 past ~22 m). */
  function sampleSurface(st) {
    const p = st.d.pos, C = config.skim;
    const h = height(p.x, p.z), wl = water(p.x, p.z);
    const ground = Math.max(h, wl);
    const agl = p.y - ground;
    let top = null;
    for (const dy of [1, 4, 8, 13, 19, 27]) {
      const m = inside(p.x, p.y - dy, p.z);
      if (m == null) break;
      if (m >= 0) { top = p.y - dy + Math.min(m, dy); break; }
    }
    let surf = null, y = 0;
    if (st.forced === 'cloud') { surf = 'cloud'; y = top ?? p.y - 8; }
    else if (st.forced === 'terrain' || st.forced === 'water') { surf = wl >= h ? 'water' : 'terrain'; y = ground; }
    else if (top != null && p.y - top < C.cloudMax && (agl > p.y - top + 4)) { surf = 'cloud'; y = top; }
    else if (agl < C.groundMax) { surf = wl >= h - 0.3 ? 'water' : 'terrain'; y = ground; }
    st.surface = surf; st.top = y;
    st.close = surf ? 1 - smoothstep(4, 22, p.y - y) : 0;
  }
  function skimVisuals(st, dt) {
    const d = st.d, P = E.P, C = config.skim;
    if (!alive(d) || !d.vel?.isVector3) { skims.delete(d); return; }
    st.str += ((st.on ? st.want : 0) - st.str) * damp(6, dt);
    if (!st.on && st.str < 0.02) { skims.delete(d); return; }
    st.sampleT -= dt;
    if (st.sampleT <= 0) { st.sampleT = 0.1; sampleSurface(st); }
    if (!st.surface || dt <= 0 || d.pos.y - st.top > 40) return;     // nothing under her within reach: no emission
    const k = st.str * (0.35 + 0.65 * st.close);
    if (k < 0.02) return;
    const sp = d.vel.length();
    const fast = clamp(sp / 45, 0.4, 1.4);
    const fwd = fwdOf(d, null, _f);
    perp(_u, fwd);                                     // side
    const t0 = now() - dt;
    const emit = (key, rate, fn) => {
      st.acc[key] = (st.acc[key] || 0) + rate * k * fast * q() * dt;
      while (st.acc[key] >= 1) { st.acc[key] -= 1; E.reset(); P.t0 = t0 + Math.random() * dt; fn(P); }
    };
    const vx = d.vel.x, vy = d.vel.y, vz = d.vel.z;
    const p = d.pos;
    // downwash rings flattened on the surface under her belly (grass / water / the cloud top pressed by her wings)
    st.washT = (st.washT || 0) - dt;
    if (st.washT <= 0 && st.close > 0.15) {
      st.washT = C.washGap;
      _a.set(p.x, st.top + 0.4, p.z);
      shock.ring({ pos: _a, normal: _up, r0: 2, r1: 9 + 5 * st.close, life: 0.5, width: 0.07, intensity: 0.55 * k,
        style: RING_STYLE.snap, vel: _b.set(vx * C.carry, 0, vz * C.carry), drag: 1.5, near: 6 });
    }
    if (st.surface === 'cloud') {
      if (wingtips(d, _tl, _tr)) {
        // mist streams peeling off the wingtips, curling like wingtip vortices (up outside, down inside)
        for (const [tip, sgn] of [[_tl, 1], [_tr, -1]]) {
          emit('tip' + sgn, C.tips, (P) => {
            P.x = tip.x + rnd(-0.3, 0.3); P.y = tip.y + rnd(-0.3, 0.3); P.z = tip.z + rnd(-0.3, 0.3);
            _a.subVectors(tip, p); _a.addScaledVector(fwd, -_a.dot(fwd)).normalize();   // outward from the body
            _b.crossVectors(fwd, _a).multiplyScalar(sgn * 3);                              // vortex swirl
            P.vx = vx * 0.18 + _b.x; P.vy = vy * 0.18 + _b.y - 0.8; P.vz = vz * 0.18 + _b.z;
            P.life = rnd(0.8, 1.25); P.size0 = rnd(0.5, 0.7); P.size1 = rnd(2.4, 3.4); P.drag = 1.2; P.grav = 0.3;
            P.row = SMOKE.cloud; P.heat = 0; P.opacity = 0.6 * k; P.fadeIn = 0.12; P.spin = rnd(-0.5, 0.5);
            spawn(E.smoke, P);
          });
          emit('wisp' + sgn, C.tipWisps, (P) => {
            P.x = tip.x; P.y = tip.y; P.z = tip.z;
            P.vx = vx * 0.65; P.vy = vy * 0.65; P.vz = vz * 0.65;
            P.life = rnd(0.25, 0.4); P.size0 = P.size1 = rnd(0.09, 0.14); P.drag = 0.6; P.stretch = 0.1; P.shape = GLOW.wisp;
            P.row = ROW.steam; P.heat = 1; P.cool = 0.6; P.intensity = 0.45 * k;
            spawn(E.glow, P);
          });
        }
      }
      // the cloud top churned up behind her belly (her downwash), thrown up and aside like a wake
      emit('wake', C.wake, (P) => {
        const side = rnd(-1, 1), al = rnd(-5, 3), cr = C.carry * rnd(0.7, 1.1);
        P.x = p.x + fwd.x * al + _u.x * side * 3; P.y = st.top + 0.5; P.z = p.z + fwd.z * al + _u.z * side * 3;
        const out = rnd(3, 8) * Math.sign(side || 1);
        P.vx = vx * cr + _u.x * out; P.vy = rnd(4, 9) * (0.4 + 0.6 * st.close); P.vz = vz * cr + _u.z * out;
        P.life = rnd(1.0, 1.6); P.size0 = rnd(1.6, 2.2); P.size1 = rnd(4.5, 7); P.drag = 1.5; P.grav = 0.6;
        P.row = SMOKE.cloud; P.heat = 0; P.opacity = 0.55 * k; P.fadeIn = 0.2; P.spin = rnd(-0.3, 0.3);
        spawn(E.smoke, P);
      });
    } else if (st.surface === 'terrain') {
      emit('dust', C.dust, (P) => {
        const side = rnd(-1, 1), al = rnd(-5, 3), cr = C.carry * rnd(0.7, 1.1);
        P.x = p.x + fwd.x * al + _u.x * side * 4; P.y = st.top + 0.6; P.z = p.z + fwd.z * al + _u.z * side * 4;
        const out = rnd(4, 10) * Math.sign(side || 1);
        P.vx = vx * cr + _u.x * out; P.vy = rnd(3, 8) * (0.4 + 0.6 * st.close); P.vz = vz * cr + _u.z * out;
        P.life = rnd(1.1, 1.8); P.size0 = rnd(1.3, 1.8); P.size1 = rnd(4.5, 6.5); P.drag = 1.5; P.grav = 0.5;
        P.row = SMOKE.dust; P.heat = 0; P.opacity = 0.7 * k; P.fadeIn = 0.15; P.spin = rnd(-0.4, 0.4);
        spawn(E.smoke, P);
      });
      emit('leaf', C.leaves, (P) => {
        // (anime-sized: real 5 cm leaves would be single pixels from the chase camera)
        const al = rnd(-6, 4), sd = rnd(-7, 7), cr = C.carry * rnd(0.6, 1.15);
        P.x = p.x + fwd.x * al + _u.x * sd; P.y = st.top + rnd(0.5, 3); P.z = p.z + fwd.z * al + _u.z * sd;
        P.vx = vx * cr + _u.x * sd * 0.8 + rnd(-3, 3); P.vy = rnd(7, 14) * (0.4 + 0.6 * st.close); P.vz = vz * cr + _u.z * sd * 0.8 + rnd(-3, 3);
        P.life = rnd(1.6, 2.6); P.size0 = P.size1 = rnd(0.35, 0.6); P.drag = 1.2; P.grav = -3;
        P.row = SMOKE.leaf; P.shape = 1; P.squash = 1; P.heat = 0; P.spin = rnd(3, 7) * (Math.random() < 0.5 ? -1 : 1);
        spawn(E.smoke, P);
      });
    } else if (st.surface === 'water') {
      emit('spray', C.spray, (P) => {
        const side = rnd(-1, 1), al = rnd(-5, 2), cr = C.carry * rnd(0.7, 1.1);
        P.x = p.x + fwd.x * al + _u.x * side * 3; P.y = st.top + 0.3; P.z = p.z + fwd.z * al + _u.z * side * 3;
        P.vx = vx * cr + _u.x * side * 5; P.vy = rnd(7, 15) * (0.4 + 0.6 * st.close); P.vz = vz * cr + _u.z * side * 5;
        P.life = rnd(0.7, 1.2); P.size0 = rnd(0.8, 1.1); P.size1 = rnd(2.4, 3.4); P.drag = 1; P.grav = -9.5;
        P.row = SMOKE.spray; P.heat = 0; P.opacity = 0.8 * k; P.spin = rnd(-0.5, 0.5);
        spawn(E.smoke, P);
      });
    }
  }

  // ---------- fireball charge-up at the mouth ----------
  const cg = { orb: null, acc: 0, acc2: 0, ringT: 0, ev: 0, evT: -1e9 };
  function chargeLevel() {
    const pl = game.player;
    const v = pl?.fireCharge;
    if (Number.isFinite(v)) return clamp(v, 0, 1);
    return now() - cg.evT < 0.3 ? cg.ev : 0;      // the 'charge' event (a pilot that only emits it)
  }
  function chargeVisuals(dt) {
    const pl = game.player;
    const raw = alive(pl) && game.state === 'play' && !hasDragonCharge() ? chargeLevel() : 0;
    const from = config.charge.from;
    const L = raw >= 0.999 ? 1 : clamp((raw - from) / (1 - from), 0, 1);
    if (raw < from + 0.01) { if (cg.orb) { orbs.remove(cg.orb); cg.orb = null; } return; }
    const m = _a;
    if (pl.mouth?.isVector3) m.copy(pl.mouth); else m.copy(pl.pos).addScaledVector(fwdOf(pl, null, _f), 6);
    const md = pl.mouthDir?.isVector3 ? _b.copy(pl.mouthDir).normalize() : fwdOf(pl, null, _b);
    m.addScaledVector(md, 0.9);
    const full = L >= 0.98;
    // levels and elements: the charge gathers in Sora's element (fire.js passes palette(); ember = the old look)
    let pal = null;
    try { pal = palette?.() || null; } catch { pal = null; }
    const bolt = !!pal?.arcs;
    const rowBase = bolt ? ROW.lightning : pal?.row ?? ROW.player, rowHot = bolt ? ROW.lightning : pal?.hot ?? ROW.inferno;
    const rowSpark = pal?.spark ?? ROW.spark;
    const RB = full ? rowHot : rowBase;
    if (!cg.orb) cg.orb = orbs.add({ pos: m, radius: 0, row: rowBase, wobble: 0.22 });
    const t = now();
    const ease = 1 - Math.pow(1 - L, 2);
    cg.orb.pos.copy(m);
    cg.orb.radius = config.charge.orb * (0.2 + 0.8 * ease) * (full ? 1 + 0.12 * Math.sin(t * 30) : 1 + 0.04 * Math.sin(t * 41));
    cg.orb.row = RB;
    cg.orb.intensity = 0.9 + 0.5 * L;
    const v = pl.vel?.isVector3 ? pl.vel : _w.set(0, 0, 0);
    if (dt > 0) {
      const P = E.P;
      cg.acc += dt * (30 + config.charge.streaks * L) * q();
      while (cg.acc >= 1) {
        cg.acc -= 1;
        E.reset();
        randDir(_c);
        const r = rnd(2.4, 4.4), life = rnd(0.22, 0.36);
        P.x = m.x + _c.x * r; P.y = m.y + _c.y * r; P.z = m.z + _c.z * r;
        const s = (r * 0.92) / life;
        P.vx = -_c.x * s + v.x; P.vy = -_c.y * s + v.y; P.vz = -_c.z * s + v.z;
        P.life = life; P.size0 = P.size1 = 0.05 + 0.03 * L; P.stretch = 0.05; P.shape = GLOW.streak;
        P.row = full ? rowHot : rowSpark; P.heat = 0.9; P.cool = -0.2; P.intensity = 1.1; P.fadeIn = 0.3;
        spawn(E.glow, P);
      }
      cg.acc2 += dt * (6 + config.charge.wisps * L) * q();
      while (cg.acc2 >= 1) {
        cg.acc2 -= 1;
        E.reset();
        randDir(_c);
        // flame wisps spiralling in from beyond her head's silhouette (from the chase camera the mouth is behind it)
        const r = rnd(1.6, 3.2), life = rnd(0.2, 0.32);
        P.x = m.x + _c.x * r; P.y = m.y + _c.y * r; P.z = m.z + _c.z * r;
        _d.set(-_c.z, 0, _c.x).multiplyScalar(r * 2.2);
        P.vx = -_c.x * r / life + _d.x + v.x; P.vy = -_c.y * r / life + v.y; P.vz = -_c.z * r / life + _d.z + v.z;
        P.life = life; P.size0 = 0.3 + 0.25 * L; P.size1 = 0.55 + 0.6 * L; P.stretch = 0.03;
        P.heat = 0.95; P.cool = 0.2; P.row = RB;
        if (bolt) { P.opacity = 0.7; spawn(E.soft, P); } else spawn(E.flame, P);
      }
      // a flickering halo pulled toward the camera (drawn over her head: from the chase camera the mouth is behind it)
      cg.acc3 = (cg.acc3 || 0) + dt * 30;
      while (cg.acc3 >= 1) {
        cg.acc3 -= 1;
        E.reset();
        P.x = m.x; P.y = m.y; P.z = m.z; P.vx = v.x; P.vy = v.y; P.vz = v.z;
        P.life = rnd(0.06, 0.11); P.size0 = (0.7 + 1.3 * ease) * (full ? 1.15 : 1); P.size1 = P.size0 * 1.25;
        P.shape = GLOW.soft; P.row = RB; P.heat = 0.95; P.cool = 1;
        P.intensity = (0.25 + 0.45 * L) * (full ? 1.2 : 1); P.squash = config.charge.pull;
        spawn(E.glow, P);
      }
      // …and a soft flame aura around the jaws (soft class: it occludes a little, so it reads on the white cloud deck
      // behind her head where additive light vanishes)
      cg.acc4 = (cg.acc4 || 0) + dt * (8 + 18 * L) * q();
      while (cg.acc4 >= 1) {
        cg.acc4 -= 1;
        E.reset();
        randDir(_c);
        P.x = m.x + _c.x * 0.5; P.y = m.y + _c.y * 0.5 + 0.3; P.z = m.z + _c.z * 0.5;
        P.vx = v.x + _c.x * 2; P.vy = v.y + 2.5; P.vz = v.z + _c.z * 2;
        P.life = rnd(0.16, 0.26); P.size0 = 0.5 + 0.5 * L; P.size1 = 1.1 + 1.3 * L; P.drag = 2; P.grow = 1.6;
        P.row = RB; P.heat = rnd(0.85, 1.0); P.cool = 0.4; P.spin = rnd(-2, 2);
        P.opacity = 0.45 + 0.35 * L; P.fadeIn = 0.15;
        spawn(E.soft, P);
      }
      if (full && t - cg.ringT > 0.28) {
        cg.ringT = t;
        E.reset();
        P.x = m.x; P.y = m.y; P.z = m.z; P.vx = v.x; P.vy = v.y; P.vz = v.z;
        P.life = 0.28; P.size0 = 0.8; P.size1 = 2.8; P.shape = GLOW.ring; P.row = rowHot; P.heat = 0.95; P.cool = 1; P.intensity = 0.9;
        P.squash = config.charge.pull;
        spawn(E.glow, P);
      }
      // lightning tiers: little arcs crackling from the gathering orb to the jaws (more as it fills)
      if (bolt && arcs) {
        cg.acc5 = (cg.acc5 || 0) + dt * (6 + 18 * L);
        if (cg.acc5 >= 1) {
          cg.acc5 = Math.min(cg.acc5 - 1, 1);
          randDir(_c).multiplyScalar(rnd(1.4, 2.6) * (0.6 + 0.6 * L));
          arcs.strike({ from: { ref: cg.orb.pos }, to: { ref: cg.orb.pos, off: _c }, amp: 0.22, life: 0.07, width: 0.16 + 0.12 * L, intensity: 0.9,
            style: pal.arcStyle ?? 0, branches: Math.random() < 0.5 ? 1 : 0, fork: 0.4 });
        }
      }
    }
    lights.request(m, full ? pal?.hotLight ?? INFERNO_LIGHT : pal && pal.row !== ROW.player ? pal.light : CHARGE_LIGHT, 50 + 190 * L, 9 + 4 * L, cg, 1.4);
  }
  const INFERNO_LIGHT = new THREE.Color(1.0, 0.78, 0.36), CHARGE_LIGHT = new THREE.Color(1.0, 0.56, 0.18);

  // ---------- events (fallbacks) ----------
  function init() {
    const ev = game.events;
    if (!ev?.on) return;
    try {
      ev.on('move', (e) => {
        if (e?.name !== 'dash' || (e.phase && e.phase !== 'start')) return;
        later(() => { const d = dragonOf(e.actor || e.dragon) || game.player; if (alive(d)) dashRing(d.pos, d.vel, { dragon: d, _auto: true }); });
      });
      ev.on('nearmiss', (e) => {
        const p = e?.pos?.isVector3 ? e.pos.clone() : e?.point?.isVector3 ? e.point.clone() : null;
        later(() => nearMiss(p, { kind: e?.kind, dragon: e?.actor || e?.dragon, _auto: true }));
      });
      ev.on('skim', (e) => { skimMist(e?.actor || e?.dragon || game.player, !!e?.on, { _auto: true, surface: e?.surface || e?.kind }); });
      ev.on('charge', (e) => { cg.ev = clamp(+e?.level || 0, 0, 1); cg.evT = now(); });
      ev.on('state', (e) => { if (e?.next === 'title' || e?.next === 'defeat' || e?.next === 'victory') clear(); });
    } catch { /* optional */ }
  }

  function update(dt) {
    if (dt > 0) {
      const t = now();
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i].t > t) continue;
        const f = pending[i].fn;
        pending.splice(i, 1);
        try { f(); } catch (e) { console.warn('[fx] move fallback failed', e); }
      }
      if (config.auto) watchBoom();
    }
    for (let i = trails.length - 1; i >= 0; i--) if (dt > 0 && !trailVisuals(trails[i], dt)) trails.splice(i, 1);
    for (const st of [...skims.values()]) skimVisuals(st, dt);
    chargeVisuals(dt);
  }
  function clear() {
    trails.length = 0; skims.clear(); pending.length = 0;
    if (cg.orb) { orbs.remove(cg.orb); cg.orb = null; }
  }

  return {
    config, stat, dashRing, sonicBoom, nearMiss, skimMist, init, update, clear,
    isSkimming: (d) => !!skims.get(dragonOf(d) || d)?.on,
    skimState: (d) => { const s = skims.get(dragonOf(d) || d); return s ? { on: s.on, strength: +s.str.toFixed(2), surface: s.surface, close: +s.close.toFixed(2) } : null; },
    get chargeOrb() { return cg.orb ? { radius: cg.orb.radius, row: cg.orb.row } : null; },
    stats: () => ({ ...stat, trails: trails.length, skims: skims.size, charge: cg.orb ? +cg.orb.radius.toFixed(2) : 0 }),
  };
}
