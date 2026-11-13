// game.combat — HP, hit shapes, damage and targeting queries. Pure logic, no visuals.
// Actor contract (see docs/ARCHITECTURE.md):
//   { id, name, kind:'dragon'|'titan', team:'player'|'enemy', hp, maxHp, alive, root:Object3D,
//     pos:Vector3, vel:Vector3, radius (broad-phase sphere around pos, m),
//     shapes:[{ kind:'sphere'|'capsule', a:Vector3, b?:Vector3, r, part, mult }]  (WORLD space, owner updates each fixed step)
//     invuln: seconds of damage immunity left (owner may set; combat counts it down)
//     onHit?(info), onDeath?(info) }
import * as THREE from 'three';
import { segSegDist2, closestOnSegment } from '../core/util.js';

let nextId = 1;
const _p = new THREE.Vector3(), _q = new THREE.Vector3(), _d = new THREE.Vector3();

export default function createCombat(game) {
  const actors = game.actors;

  const combat = {
    name: 'combat',
    log: [],                                  // recent damage records (last 64) for tests/HUD

    register(actor) {
      if (!actor.id) actor.id = nextId++;
      actor.alive = actor.alive ?? true;
      actor.invuln = actor.invuln || 0;
      actor.shapes = actor.shapes || [];
      if (!actors.includes(actor)) actors.push(actor);
      game.events.emit('actor:add', { actor });
      return actor;
    },
    unregister(actor) {
      const i = actors.indexOf(actor);
      if (i >= 0) actors.splice(i, 1);
      game.events.emit('actor:remove', { actor });
    },

    /** Apply damage. info: { source (actor|null), point, dir, kind:'fire'|'fireball'|'impact'|'swat'|'crash', part, shape } */
    damage(target, amount, info = {}) {
      if (!target || !target.alive || amount <= 0) return 0;
      if (target.invuln > 0 && info.kind !== 'crash') return 0;
      if (info.source && info.source.team === target.team && info.kind !== 'crash') return 0;   // no friendly fire
      const mult = info.shape?.mult ?? 1;
      const dmg = amount * mult;
      target.hp = Math.max(0, target.hp - dmg);
      const killed = target.hp <= 0;
      const rec = { target, amount: dmg, killed, t: game.time.now, ...info };
      combat.log.push(rec); if (combat.log.length > 64) combat.log.shift();
      target.onHit?.(rec);
      game.events.emit('damage', rec);
      if (killed) {
        target.alive = false;
        target.onDeath?.(rec);
        game.events.emit('death', { actor: target, killer: info.source || null, info: rec });
      }
      return dmg;
    },

    heal(target, amount) {
      if (!target?.alive) return;
      target.hp = Math.min(target.maxHp, target.hp + amount);
      game.events.emit('heal', { target, amount });
    },

    /** Distance from point p to a shape's surface (negative inside). Writes the closest surface point into out. */
    shapeDistance(shape, p, out = _p) {
      if (shape.kind === 'capsule') closestOnSegment(p, shape.a, shape.b, out);
      else out.copy(shape.a);
      const dist = out.distanceTo(p);
      if (dist > 1e-6) out.lerp(p, Math.min(1, shape.r / dist));
      return dist - shape.r;
    },

    /** All shapes overlapping a sphere. opts: { team (only actors of this team), exclude (actor), part } */
    querySphere(center, radius, opts = {}) {
      const hits = [];
      for (const a of actors) {
        if (!a.alive || a === opts.exclude || (opts.team && a.team !== opts.team)) continue;
        if (a.pos.distanceTo(center) > (a.radius || 50) + radius) continue;
        let best = null;
        for (const s of a.shapes) {
          const d = combat.shapeDistance(s, center, _q);
          if (d <= radius && (!best || d < best.dist)) best = { actor: a, shape: s, dist: d, point: _q.clone() };
        }
        if (best) hits.push(best);
      }
      return hits;
    },

    /** Swept sphere from p0 to p1 (projectiles): the earliest hit {actor, shape, t, point} or null. */
    sweepSphere(p0, p1, radius, opts = {}) {
      let best = null;
      const len = p0.distanceTo(p1);
      for (const a of actors) {
        if (!a.alive || a === opts.exclude || (opts.team && a.team !== opts.team)) continue;
        const br = (a.radius || 50) + radius + len;
        if (a.pos.distanceTo(p0) > br && a.pos.distanceTo(p1) > br) continue;
        for (const s of a.shapes) {
          const b = s.kind === 'capsule' ? s.b : s.a;
          const r = segSegDist2(p0, p1, s.a, b);
          const rr = s.r + radius;
          if (r.d2 <= rr * rr && (!best || r.s < best.t)) {
            best = { actor: a, shape: s, t: r.s, point: new THREE.Vector3().lerpVectors(p0, p1, r.s) };
          }
        }
      }
      return best;
    },

    /** Best target for aim assist / lock: nearest by angle to dir within maxAngle (rad) and maxDist (m). */
    nearestTarget(from, dir, opts = {}) {
      const { team = 'enemy', maxAngle = 0.5, maxDist = 1500, exclude = null } = opts;
      let best = null, bestScore = Infinity;
      for (const a of actors) {
        if (!a.alive || a === exclude || a.team !== team) continue;
        _d.subVectors(a.pos, from);
        const dist = _d.length();
        if (dist > maxDist || dist < 1) continue;
        const ang = Math.acos(THREE.MathUtils.clamp(_d.dot(dir) / dist, -1, 1));
        if (ang > maxAngle) continue;
        const score = ang * 3 + dist / maxDist;
        if (score < bestScore) { bestScore = score; best = a; }
      }
      return best;
    },

    alive(team) { return actors.filter((a) => a.alive && (!team || a.team === team)); },

    fixedUpdate(dt) {
      for (const a of actors) if (a.invuln > 0) a.invuln = Math.max(0, a.invuln - dt);
    },
  };
  return combat;
}
