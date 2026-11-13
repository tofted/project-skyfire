// Fire lights. Effects submit requests each frame; the most important ones near the camera are applied to:
//   1. game.toon.setFireLight(i, pos, color, radius) — the 4 flat fire-light slots of the anime character shader
//      (the toon shader replaces three's light loop, so PointLights do not reach characters);
//   2. a FIXED pool of PointLights (intensity 0 when unused) for built-in lit materials (terrain, props). Adding or
//      removing lights recompiles every lit material, so the pool is created once at init and never changes.
// Priority: distance to the camera first (what the player looks at up close is what fire should light), measured
// from the edge of the light's reach, with a mild intensity term and hysteresis (a light that held a slot last frame
// keeps it unless a clearly closer one appears), so slots do not flicker between many similar enemy streams.
import * as THREE from 'three';

const TOON_SLOTS = 4;

export function createFireLights(game, count = 4) {
  const lights = [];
  const group = new THREE.Group();
  group.name = 'fx-lights';
  for (let i = 0; i < count; i++) {
    const l = new THREE.PointLight(0xff8030, 0, 30, 2);
    l.castShadow = false;
    l.name = 'fx-light-' + i;
    group.add(l);
    lights.push(l);
  }
  game.scene.add(group);
  const reqs = [];
  let used = 0, toonUsed = 0;
  let held = new Set(), nextHeld = new Set();
  const stat = { requests: 0, peakRequests: 0 };
  const cam = new THREE.Vector3();
  const tc = new THREE.Color();
  const tp = new THREE.Vector3();
  const api = {
    lights,
    stat,
    last: [],
    get active() { return Math.max(used, toonUsed); },
    /**
     * pos: Vector3 (copied), color: THREE.Color (linear, ~unit), intensity: candela-like (breath ≈ 260), range: m,
     * key: any stable object for the source (stream, projectile…) — used for slot hysteresis.
     */
    request(pos, color, intensity, range, key = null, prio = 1) {
      if (!(intensity > 0)) return;
      reqs.push({ x: pos.x, y: pos.y, z: pos.z, color, intensity, range, key, prio, score: 0 });
    },
    flush() {
      game.camera.getWorldPosition(cam);
      // the player's dragon is the receiver that matters most: distance counts from the camera or from it
      const pp = game.player?.pos?.isVector3 ? game.player.pos : null;
      stat.requests = reqs.length;
      stat.peakRequests = Math.max(stat.peakRequests, reqs.length);
      for (const r of reqs) {
        const dx = r.x - cam.x, dy = r.y - cam.y, dz = r.z - cam.z;
        let d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (pp) d = Math.min(d, Math.hypot(r.x - pp.x, r.y - pp.y, r.z - pp.z) + 10);
        const de = Math.max(0, d - 0.25 * r.range) / 30;           // distance from the edge of its near reach
        r.score = r.prio * Math.pow(r.intensity, 0.35) / (1 + de * de);
        if (r.key && held.has(r.key)) r.score *= 1.3;
      }
      if (reqs.length > 1) reqs.sort((a, b) => b.score - a.score);
      nextHeld.clear();
      for (let i = 0; i < Math.min(reqs.length, Math.max(TOON_SLOTS, lights.length)); i++) if (reqs[i].key) nextHeld.add(reqs[i].key);
      const sw = held; held = nextHeld; nextHeld = sw;
      // debug snapshot of the winners (tests: which sources own the toon slots)
      api.last.length = 0;
      for (let i = 0; i < Math.min(reqs.length, TOON_SLOTS); i++) {
        const r = reqs[i];
        api.last.push({ key: r.key, dist: Math.round(Math.hypot(r.x - cam.x, r.y - cam.y, r.z - cam.z)), score: +r.score.toFixed(3), intensity: Math.round(r.intensity) });
      }
      used = Math.min(lights.length, reqs.length);
      for (let i = 0; i < lights.length; i++) {
        const l = lights[i];
        if (i < used) {
          const r = reqs[i];
          l.position.set(r.x, r.y, r.z);
          l.color.copy(r.color);
          l.intensity = r.intensity;
          l.distance = r.range;
        } else l.intensity = 0;
      }
      const setFL = game.toon?.setFireLight;
      if (setFL) {
        const n = Math.min(TOON_SLOTS, reqs.length);
        try {
          for (let i = 0; i < TOON_SLOTS; i++) {
            if (i < n) {
              const r = reqs[i];
              tc.copy(r.color).multiplyScalar(Math.min(1.6, r.intensity / 250));
              game.toon.setFireLight(i, tp.set(r.x, r.y, r.z), tc, r.range);
            } else if (i < toonUsed) game.toon.setFireLight(i, null);
          }
        } catch { /* optional hook */ }
        toonUsed = n;
      }
      reqs.length = 0;
    },
  };
  return api;
}
