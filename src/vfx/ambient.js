// game.ambient — speed and atmosphere cues around the player (presentation only, no gameplay):
//   speed lines  — anime radial lines toward the flight vanishing point when fast / diving / boosting
//                  (pipeline.addOverlay if present, else a clip-space mesh in the scene)
//   wind streaks — 3D air streaks that stream past the camera (parallax the 2D lines cannot give)
//   vapour       — white wingtip ribbons at high g (player + nearby dragons)
//   cloud wisps  — soft fog puffs in the live cloud colours streaming past when skimming / inside clouds
//   birds        — small flocks circling the cloud towers (or drifting near the player when towers are unknown)
//   petals       — drifting cherry petals near the ground
// Respects game.quality.particles. Budget ≤ 1.5 ms (see docs/modules/fx.md for measurements).
import * as THREE from 'three';
import { getParticles, SMOKE, GLOW } from './particles.js';
import { ROW } from './textures.js';
import { clamp, damp, rng, smoothstep } from '../core/util.js';

const V3 = THREE.Vector3;
const rnd = (a, b) => a + Math.random() * (b - a);
const mix01 = (a, b, t) => a + (b - a) * t;

// ---------- speed lines (screen space) ----------
const LINES_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const LINES_FRAG = /* glsl */`
uniform float uS, uTime, uAspect;
uniform vec2 uFocus;
uniform vec3 uColor;
varying vec2 vUv;
float h11(float n) { return fract(sin(n * 127.1) * 43758.5453); }
void main() {
  vec2 p = (vUv - uFocus) * vec2(uAspect, 1.0);
  float r = length(p);
  float a = atan(p.y, p.x) / 6.2831853 + 0.5;
  float N = 96.0;
  float id = floor(a * N), f = fract(a * N);
  float rnd = h11(id + 17.0), rnd2 = h11(id * 3.7 + 1.0);
  float w = mix(0.03, 0.11, rnd);
  float line = 1.0 - smoothstep(w * 0.6, w, abs(f - 0.5));
  float t = floor(uTime * 30.0) / 30.0;                              // stepped at 30 fps (anime)
  float head = fract(rnd2 * 7.0 + t * mix(1.6, 3.2, rnd));
  float len = mix(0.12, 0.3, rnd2);
  float rr = r / 1.25;
  float seg = smoothstep(head - len, head - len * 0.6, rr) * (1.0 - smoothstep(head - 0.02, head, rr));
  float mask = smoothstep(mix(0.72, 0.36, uS), 1.05, r);            // centre (reticle) stays clean
  float on = step(1.0 - (0.2 + 0.8 * uS), rnd);                     // more lines as speed grows
  float k = line * seg * mask * on * uS * 0.6;
  gl_FragColor = vec4(uColor * k, k);
  #include <colorspace_fragment>
}
`;

// ---------- wind streaks (world space, wrap around the camera) ----------
const STREAK_VERT = /* glsl */`
attribute vec4 aBase;          // xyz offset in the box, w seed
uniform vec3 uCam, uVel;
uniform float uBox, uLen, uS, uWidth;
varying float vA;
varying vec2 vQ;
void main() {
  vec3 base = aBase.xyz;
  vec3 rel = mod(base - uCam + 0.5 * uBox, uBox) - 0.5 * uBox;       // periodic image nearest the camera
  vec3 p = uCam + rel;
  float sp = length(uVel);
  vec3 dir = sp > 0.1 ? uVel / sp : vec3(0.0, 0.0, 1.0);
  float L = uLen * (0.6 + aBase.w);
  vec3 a = p, b = p - dir * L;                                         // streak trails behind the motion
  vec3 pw = mix(a, b, position.y * 0.5 + 0.5);
  vec4 mv = viewMatrix * vec4(pw, 1.0);
  vec4 ma = viewMatrix * vec4(a, 1.0), mb = viewMatrix * vec4(b, 1.0);
  vec2 sd = normalize((mb.xy / max(-mb.z, 0.1)) - (ma.xy / max(-ma.z, 0.1)) + vec2(1e-5, 0.0));
  mv.xy += vec2(-sd.y, sd.x) * position.x * uWidth;
  gl_Position = projectionMatrix * mv;
  float d = length(rel);
  float axis = length(cross(rel, dir));                                // distance from the flight axis
  vA = uS * smoothstep(9.0, 18.0, d) * (1.0 - smoothstep(0.32 * uBox, 0.48 * uBox, d)) * smoothstep(6.0, 12.0, axis);
  vQ = position.xy;
}
`;
const STREAK_FRAG = /* glsl */`
uniform vec3 uColor;
varying float vA;
varying vec2 vQ;
void main() {
  float m = (1.0 - vQ.x * vQ.x) * (1.0 - vQ.y * vQ.y);
  float a = vA * m * 0.55;
  gl_FragColor = vec4(uColor * a, a * 0.5);
}
`;

// ---------- vapour ribbons ----------
const RIB_VERT = /* glsl */`
attribute vec2 aInfo;          // x: age 0..1 along the ribbon, y: strength
attribute float aSide;
varying vec2 vI;
varying float vSide;
void main() { vI = aInfo; vSide = aSide; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const RIB_FRAG = /* glsl */`
varying vec2 vI;
varying float vSide;
void main() {
  float edge = 1.0 - vSide * vSide;
  float a = vI.y * (1.0 - vI.x) * smoothstep(0.0, 0.08, vI.x) * edge * 0.55;
  gl_FragColor = vec4(vec3(1.0, 1.0, 1.02) * a, a * 0.6);
}
`;

// ---------- birds ----------
const BIRD_VERT = /* glsl */`
attribute vec2 aBird;          // phase, flap rate
uniform float uTime;
__ATMO__
varying vec3 vFogT, vFogAdd;
varying float vShade;
void main() {
  vec3 p = position;
  float side = sign(p.x) * smoothstep(0.1, 1.0, abs(p.x));
  float flap = sin(uTime * aBird.y + aBird.x);
  p.y += side * flap * 0.55 * abs(p.x);
  p.z -= abs(side) * 0.15 * flap;
  vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
  vShade = 0.5 + 0.5 * flap;
  vFogAdd = atmoApply(vec3(0.0), wp.xyz);
  vFogT = atmoApply(vec3(1.0), wp.xyz) - vFogAdd;
}
`;
const BIRD_FRAG = /* glsl */`
uniform vec3 uColA, uColB;
varying vec3 vFogT, vFogAdd;
varying float vShade;
void main() {
  vec3 c = mix(uColA, uColB, vShade * 0.35);
  gl_FragColor = vec4(c * vFogT + vFogAdd, 1.0);
}
`;

export default function createAmbient(game) {
  const cfg = {
    speedLines: true, streaks: true, vapour: true, wisps: true, birds: true, petals: true,
    lineSpeed0: 45, lineSpeed1: 85,     // m/s where lines start / are full
    petalAltitude: 180,                 // m above ground
    // wave 5: cloud wisps follow "metres inside" the cloud surface (game.clouds.inside, the CPU twin before its smooth
    // ramp): they start 12 m outside it and are full 18 m inside. The clouds owner's density ramp is > 0 from ~50 m
    // outside (0.5 at +10 m), so the old "density > 0.02, full at 0.33" fired 40–90 m before the cloud (look-ahead
    // included) and put wisps in clear air. Without inside() the same window on the density: 0.24 → 0.6.
    wispIn0: -12, wispIn1: 18, wispDens0: 0.24, wispDens1: 0.6,
  };
  let E = null;
  const q = () => Math.max(0.25, game.quality?.particles ?? 1);
  const st = { s: 0, cloud: 0, sampleT: 0, g: 1, lastVel: new V3(), hasVel: false, wispAcc: 0, petalAcc: 0 };
  const _a = new V3(), _b = new V3(), _c = new V3(), _cam = new V3(), _fwd = new V3();

  // speed lines
  let lines = null, overlayHandle = null;
  const linesU = {
    uS: { value: 0 }, uTime: { value: 0 }, uAspect: { value: 1 }, uFocus: { value: new THREE.Vector2(0.5, 0.5) },
    uColor: { value: new THREE.Color(1, 1, 1) },
  };
  // streaks
  let streaks = null;
  const streakU = {
    uCam: { value: new V3() }, uVel: { value: new V3() }, uBox: { value: 110 }, uLen: { value: 6 }, uS: { value: 0 },
    uWidth: { value: 0.05 }, uColor: { value: new THREE.Color(0.95, 0.98, 1.0) },
  };
  // ribbons
  const RIB_N = 40, RIB_MAX = 8;
  let ribMesh = null, ribPos = null, ribInfo = null;
  const trails = new Map();          // dragon -> { L: ring, R: ring, g, lastVel }
  // birds
  let birds = null;
  const flocks = [];
  const birdU = { uTime: { value: 0 }, uColA: { value: new THREE.Color(0x2c3048) }, uColB: { value: new THREE.Color(0x4a5470) } };

  function buildLines() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const mat = new THREE.ShaderMaterial({
      uniforms: linesU, vertexShader: LINES_VERT, fragmentShader: LINES_FRAG,
      transparent: true, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    mat.toneMapped = false;
    lines = new THREE.Mesh(geo, mat);
    lines.name = 'ambient-speedlines';
    lines.frustumCulled = false;
    lines.renderOrder = 1e6;
    if (game.pipeline?.addOverlay) {
      const s = new THREE.Scene();
      s.add(lines);
      overlayHandle = game.pipeline.addOverlay(s);
    } else {
      game.scene.add(lines);
    }
  }

  function buildStreaks() {
    const n = Math.round(220 * Math.min(1.25, q()));
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const r = rng(4242);
    const base = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { base[i * 4] = r() * 1e4; base[i * 4 + 1] = r() * 1e4; base[i * 4 + 2] = r() * 1e4; base[i * 4 + 3] = r(); }
    geo.setAttribute('aBase', new THREE.InstancedBufferAttribute(base, 4));
    geo.instanceCount = n;
    const mat = new THREE.ShaderMaterial({
      uniforms: streakU, vertexShader: STREAK_VERT, fragmentShader: STREAK_FRAG,
      transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    mat.toneMapped = false;
    streaks = new THREE.Mesh(geo, mat);
    streaks.name = 'ambient-streaks';
    streaks.frustumCulled = false;
    streaks.renderOrder = 52;
    game.scene.add(streaks);
  }

  function buildRibbons() {
    const nv = RIB_MAX * RIB_N * 2;
    const geo = new THREE.BufferGeometry();
    ribPos = new Float32Array(nv * 3);
    ribInfo = new Float32Array(nv * 2);
    const side = new Float32Array(nv);
    const idx = [];
    for (let r = 0; r < RIB_MAX; r++) {
      for (let i = 0; i < RIB_N; i++) {
        const v = (r * RIB_N + i) * 2;
        side[v] = -1; side[v + 1] = 1;
        if (i < RIB_N - 1) idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
      }
    }
    geo.setAttribute('position', new THREE.BufferAttribute(ribPos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aInfo', new THREE.BufferAttribute(ribInfo, 2).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    geo.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      vertexShader: RIB_VERT, fragmentShader: RIB_FRAG, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    mat.toneMapped = false;
    ribMesh = new THREE.Mesh(geo, mat);
    ribMesh.name = 'ambient-vapour';
    ribMesh.frustumCulled = false;
    ribMesh.renderOrder = 53;
    game.scene.add(ribMesh);
  }

  function buildBirds() {
    const perFlock = 16, nFlocks = Math.max(2, Math.round(5 * Math.min(1, q())));
    const n = perFlock * nFlocks;
    // a simple gull silhouette: body + two swept wings (x = span, z = forward)
    const pos = [
      0, 0, 0.45, 0, 0, -0.4, 0.12, 0, 0,          // body sliver
      0.1, 0, 0.12, 1.0, 0.05, -0.12, 0.1, 0, -0.12, // right wing
      -0.1, 0, 0.12, -0.1, 0, -0.12, -1.0, 0.05, -0.12,
      0.45, 0.02, 0.0, 1.0, 0.05, -0.12, 0.1, 0, 0.12,
      -0.45, 0.02, 0.0, -0.1, 0, 0.12, -1.0, 0.05, -0.12,
    ];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const ab = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { ab[i * 2] = Math.random() * 6.28; ab[i * 2 + 1] = rnd(9, 13); }
    geo.setAttribute('aBird', new THREE.InstancedBufferAttribute(ab, 2));
    const chunk = game.atmo ? game.atmo.chunk : 'vec3 atmoApply(vec3 c, vec3 p) { return c; }';
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...birdU, ...(game.atmo?.uniforms || {}) },
      vertexShader: BIRD_VERT.replace('__ATMO__', chunk), fragmentShader: BIRD_FRAG, side: THREE.DoubleSide,
    });
    birds = new THREE.InstancedMesh(geo, mat, n);
    birds.name = 'ambient-birds';
    birds.frustumCulled = false;
    birds.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    game.scene.add(birds);
    for (let f = 0; f < nFlocks; f++) {
      const members = [];
      for (let i = 0; i < perFlock; i++) members.push({ r: rnd(3, 16), ph: Math.random() * 6.28, w: rnd(0.25, 0.5), h: rnd(-4, 4), s: rnd(0.9, 1.4) });
      flocks.push({ c: new V3(), center: null, ang: Math.random() * 6.28, rad: rnd(80, 200), speed: rnd(9, 14), y: 0, members, placed: false, prev: new V3() });
    }
  }

  function towersList() {
    const t = game.clouds?.towers || game.clouds?.layout?.towers || game.world?.towers;
    return Array.isArray(t) ? t : null;
  }

  function placeFlock(fl, i, player) {
    const towers = towersList();
    const near = (towers || []).filter((t) => !t.far && Number.isFinite(t.x)).map((t) => ({ t, d: Math.hypot(t.x - player.x, t.z - player.z) }))
      .sort((a, b) => a.d - b.d).slice(0, Math.max(1, flocks.length));
    if (near.length) {
      // circle the nearest cloud towers, one flock per tower
      const pick = near[i % near.length].t;
      const R = (pick.radius || 600) * rnd(0.9, 1.15);
      fl.center = new V3(pick.x, 0, pick.z);
      fl.rad = R;
      fl.y = clamp(player.y + rnd(-120, 120), (pick.base || 700) + 60, (pick.top || 2000) - 100);
    } else {
      const a = Math.random() * 6.28, d = rnd(250, 700);
      fl.center = new V3(player.x + Math.cos(a) * d, 0, player.z + Math.sin(a) * d);
      fl.rad = rnd(60, 160);
      fl.y = player.y + rnd(-60, 80);
    }
    fl.placed = true;
  }

  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new V3(), _up = new V3(0, 1, 0), _look = new THREE.Matrix4();
  function updateBirds(dt, player) {
    if (!birds) return;
    birdU.uTime.value = game.time.now;
    let k = 0;
    const cam = _cam;
    for (let f = 0; f < flocks.length; f++) {
      const fl = flocks[f];
      if (!fl.placed || fl.center.distanceTo(_a.set(player.x, fl.center.y, player.z)) > 4000) placeFlock(fl, f, player);
      if (!towersList() && fl.center.distanceTo(_a.set(player.x, 0, player.z)) > 1600) placeFlock(fl, f, player);
      fl.ang += (fl.speed / fl.rad) * dt;
      const cx = fl.center.x + Math.cos(fl.ang) * fl.rad, cz = fl.center.z + Math.sin(fl.ang) * fl.rad;
      const tx = -Math.sin(fl.ang), tz = Math.cos(fl.ang);
      for (const m of fl.members) {
        const ph = m.ph + game.time.now * m.w;
        _a.set(cx + Math.cos(ph) * m.r - tx * m.r * 0.6, fl.y + m.h + Math.sin(ph * 1.7) * 1.5, cz + Math.sin(ph) * m.r - tz * m.r * 0.6);
        // scatter away from the camera when it flies into the flock
        _b.subVectors(_a, cam);
        const d = _b.length();
        if (d < 40) _a.addScaledVector(_b.normalize(), (40 - d) * 0.8);
        _c.set(tx, Math.sin(ph) * 0.1, tz);
        _look.lookAt(_c, _s.set(0, 0, 0), _up);
        _q.setFromRotationMatrix(_look);
        _m.compose(_a, _q, _s.setScalar(m.s));
        birds.setMatrixAt(k++, _m);
      }
    }
    birds.count = k;
    birds.instanceMatrix.needsUpdate = true;
  }

  // wingtips: explicit field → actor wing shapes (farthest capsule end) → model-space estimate
  function wingtips(d, outL, outR) {
    if (d.wingtips?.L?.isVector3) { outL.copy(d.wingtips.L); outR.copy(d.wingtips.R); return true; }
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
    if (d.root?.isObject3D) {
      d.root.localToWorld(outL.set(8, 0.4, -0.5));
      d.root.localToWorld(outR.set(-8, 0.4, -0.5));
      return true;
    }
    return false;
  }

  function trailFor(d) {
    let t = trails.get(d);
    if (!t) {
      const ring = () => ({ p: Array.from({ length: RIB_N }, () => new V3()), s: new Float32Array(RIB_N), t: new Float32Array(RIB_N), head: 0, n: 0 });
      t = { L: ring(), R: ring(), g: 1, lastVel: new V3(), has: false, sampleT: 0, seen: 0 };
      trails.set(d, t);
    }
    return t;
  }

  const _tl = new V3(), _tr = new V3();
  function updateVapour(dt) {
    if (!ribMesh) return;
    const now = game.time.now;
    const list = [];
    const pl = game.player;
    if (pl) list.push(pl);
    game.camera.getWorldPosition(_cam);
    for (const a of game.actors || []) {
      if (list.length >= RIB_MAX / 2) break;
      const d = a.dragon || a.owner;
      if (a.kind === 'dragon' && a.alive && a !== pl?.actor && a.pos && a.pos.distanceTo(_cam) < 250 && d?.root) list.push(d);
    }
    let r = 0;
    for (const d of list) {
      const t = trailFor(d);
      t.seen = now;
      const vel = d.vel || d.actor?.vel;
      if (!vel) continue;
      if (dt > 0) {
        // g-load: the flight body's if published, else from the velocity change
        let g = d.body?.state?.gLoad ?? d.state?.gLoad;
        if (!Number.isFinite(g)) {
          if (t.has) { _a.subVectors(vel, t.lastVel).divideScalar(dt); _a.y += 9.81; g = _a.length() / 9.81; } else g = 1;
          t.lastVel.copy(vel); t.has = true;
        }
        t.g += (g - t.g) * damp(8, dt);
        const sp = vel.length();
        const strength = clamp((t.g - 1.8) / 2.5, 0, 1) * clamp((sp - 30) / 35, 0, 1);
        if (wingtips(d, _tl, _tr)) {
          for (const [ring, p] of [[t.L, _tl], [t.R, _tr]]) {
            ring.head = (ring.head + 1) % RIB_N;
            ring.p[ring.head].copy(p); ring.s[ring.head] = strength; ring.t[ring.head] = now;
            ring.n = Math.min(RIB_N, ring.n + 1);
          }
        }
      }
      for (const ring of [t.L, t.R]) { if (r < RIB_MAX) writeRibbon(r++, ring, now); }
    }
    for (; r < RIB_MAX; r++) clearRibbon(r);
    for (const [d, t] of trails) if (now - t.seen > 3) trails.delete(d);
    ribMesh.geometry.attributes.position.needsUpdate = true;
    ribMesh.geometry.attributes.aInfo.needsUpdate = true;
  }
  function writeRibbon(r, ring, now) {
    const LIFE = 0.9;
    for (let i = 0; i < RIB_N; i++) {
      const k = (ring.head - i + RIB_N) % RIB_N;
      const kp = (k - 1 + RIB_N) % RIB_N, kn = (k + 1) % RIB_N;
      const v = (r * RIB_N + i) * 2;
      const valid = i < ring.n;
      const p = ring.p[k];
      const age = valid ? clamp((now - ring.t[k]) / LIFE, 0, 1) : 1;
      // camera-facing width
      _a.subVectors(ring.p[i > 0 ? kn : k], ring.p[i < ring.n - 1 ? kp : k]);
      _b.subVectors(_cam, p);
      _c.crossVectors(_a, _b);
      const l = _c.length();
      const w = (0.15 + 0.55 * age) * (valid ? 1 : 0);
      if (l > 1e-6) _c.multiplyScalar(w / l); else _c.set(0, 0, 0);
      ribPos[v * 3] = p.x - _c.x; ribPos[v * 3 + 1] = p.y - _c.y; ribPos[v * 3 + 2] = p.z - _c.z;
      ribPos[v * 3 + 3] = p.x + _c.x; ribPos[v * 3 + 4] = p.y + _c.y; ribPos[v * 3 + 5] = p.z + _c.z;
      const s = valid ? ring.s[k] : 0;
      ribInfo[v * 2] = age; ribInfo[v * 2 + 1] = s;
      ribInfo[v * 2 + 2] = age; ribInfo[v * 2 + 3] = s;
    }
  }
  function clearRibbon(r) {
    for (let i = 0; i < RIB_N * 2; i++) { const v = r * RIB_N * 2 + i; ribInfo[v * 2 + 1] = 0; ribPos[v * 3] = ribPos[v * 3 + 1] = ribPos[v * 3 + 2] = 0; }
  }

  function playerState(out) {
    const p = game.player;
    if (!p) return null;
    const vel = p.vel || p.actor?.vel;
    const pos = p.pos || p.actor?.pos;
    if (!vel || !pos) return null;
    out.vel = vel; out.pos = pos;
    out.speed = vel.length();
    const c = p.controls || {};
    out.boost = c.boost ? 1 : 0;
    out.dive = c.dive ? 1 : 0;
    return out;
  }

  /** 0..1: how far a point is inside a cloud, for wisps (see cfg.wispIn*). Never throws. */
  function inCloud(x, y, z) {
    try {
      const ins = game.clouds?.inside;
      if (typeof ins === 'function') {
        const m = ins.call(game.clouds, x, y, z);
        if (Number.isFinite(m)) return smoothstep(cfg.wispIn0, cfg.wispIn1, m);
      }
      const d = game.world?.cloudDensity?.(x, y, z) || 0;
      return smoothstep(cfg.wispDens0, cfg.wispDens1, d);
    } catch { return 0; }
  }

  function updateWispsAndPetals(dt, ps) {
    const P = E.P;
    const world = game.world;
    // cloud proximity (sampled at 10 Hz): camera + a point ahead on the flight path
    st.sampleT -= dt;
    if (st.sampleT <= 0 && (world.cloudDensity || game.clouds?.inside)) {
      st.sampleT = 0.1;
      let d = 0;
      const f = ps.speed > 1 ? 1 / ps.speed : 0;
      for (const ahead of [0, 20, 45]) {
        _a.copy(_cam).addScaledVector(ps.vel, ahead * f);
        d = Math.max(d, inCloud(_a.x, _a.y, _a.z));
      }
      st.cloudTarget = d;
    }
    st.cloud += ((st.cloudTarget || 0) - st.cloud) * damp(6, dt);
    if (cfg.wisps && st.cloud > 0.02 && dt > 0) {
      const rate = clamp(st.cloud * 3, 0, 1) * clamp(ps.speed / 40, 0.3, 1.6) * 16 * q();
      st.wispAcc += rate * dt;
      const dir = _fwd.copy(ps.vel).normalize();
      while (st.wispAcc >= 1) {
        st.wispAcc -= 1;
        E.reset();
        const ahead = rnd(25, 70);
        _a.copy(_cam).addScaledVector(dir, ahead);
        // off the flight axis only, so the dragon ahead of the camera stays visible
        _b.set(rnd(-1, 1), rnd(-0.7, 0.7), rnd(-1, 1));
        _b.addScaledVector(dir, -_b.dot(dir));
        if (_b.lengthSq() < 1e-4) _b.set(1, 0, 0);
        _b.normalize().multiplyScalar(rnd(16, 34));
        P.x = _a.x + _b.x; P.y = _a.y + _b.y; P.z = _a.z + _b.z;
        // wave 5: only where there is cloud (skimming a tower's side or the deck top, the look-ahead may say "cloud"
        // while this spot is clear air: no cotton balls in the sky)
        const here = inCloud(P.x, P.y, P.z);
        if (here < 0.05) continue;
        // wave 4: soft fog puffs in the live cloud colours (row SMOKE.cloud), fading in and out, thicker in denser
        // cloud — no hard-edged two-tone stickers inside the soft cloud
        P.life = rnd(1.2, 1.9); P.size0 = rnd(3, 4.5); P.size1 = rnd(6, 9);
        P.drag = 0.5; P.grav = 0.2; P.row = SMOKE.cloud; P.heat = 0; P.spin = rnd(-0.2, 0.2);
        P.opacity = clamp((0.25 + st.cloud * 0.6) * mix01(0.5, 1, here), 0.12, 0.8); P.fadeIn = 0.3;
        E.smoke.push(P);
      }
    }
    // petals near the ground (over land)
    if (cfg.petals && dt > 0) {
      let h = -1e9;
      try { h = world.heightAt(_cam.x, _cam.z); } catch { h = -1e9; }
      const agl = _cam.y - Math.max(h, world.seaLevel ?? 0);
      const onLand = h > (world.seaLevel ?? 0) + 1;
      const k = onLand ? 1 - clamp(agl / cfg.petalAltitude, 0, 1) : 0;
      if (k > 0) {
        st.petalAcc += dt * 70 * k * q();
        const dir = _fwd.copy(ps.vel).normalize();
        while (st.petalAcc >= 1) {
          st.petalAcc -= 1;
          E.reset();
          _a.copy(_cam).addScaledVector(dir, rnd(4, 30));
          P.x = _a.x + rnd(-12, 12); P.y = _a.y + rnd(-5, 9); P.z = _a.z + rnd(-12, 12);
          P.vx = rnd(1.2, 2.6); P.vy = rnd(-0.6, 0.2); P.vz = rnd(-0.8, 0.8);    // light breeze toward +x (the sea)
          P.life = rnd(3, 5); P.size0 = P.size1 = rnd(0.13, 0.22);
          P.drag = 0.8; P.grav = -0.7; P.row = SMOKE.petal; P.shape = 1; P.squash = 1;
          P.spin = rnd(2, 5) * (Math.random() < 0.5 ? -1 : 1); P.heat = 0;
          E.smoke.push(P);
        }
      }
    }
  }

  const ps = {};
  const ambient = {
    name: 'ambient',
    config: cfg,
    get speedFactor() { return st.s; },
    get cloudFactor() { return st.cloud; },
    async init() {
      try {
        E = getParticles(game);
        buildLines();
        buildStreaks();
        buildRibbons();
        buildBirds();
      } catch (e) { console.error('[ambient] init failed', e); }
    },
    update(dt, realDt) {
      if (!E) return;
      try {
        game.camera.getWorldPosition(_cam);
        const p = playerState(ps);
        if (!p) { linesU.uS.value = 0; streakU.uS.value = 0; return; }
        // speed factor (smoothed on real time so it relaxes in pause/photo too)
        const target = clamp((p.speed - cfg.lineSpeed0) / (cfg.lineSpeed1 - cfg.lineSpeed0), 0, 1) + p.boost * 0.25 + p.dive * 0.2;
        st.s += (clamp(target, 0, 1) * (game.state === 'play' || game.state === 'title' ? 1 : 0) - st.s) * damp(4, realDt);
        // speed lines toward the vanishing point of the flight direction
        linesU.uS.value = cfg.speedLines ? st.s : 0;
        linesU.uTime.value = game.time.real;
        linesU.uAspect.value = game.size ? game.size.w / game.size.h : 1.6;
        if (p.speed > 1) {
          _a.copy(_cam).addScaledVector(p.vel, 200 / p.speed).project(game.camera);
          if (_a.z < 1 && Math.abs(_a.x) < 1.6 && Math.abs(_a.y) < 1.6) linesU.uFocus.value.set(clamp(_a.x * 0.5 + 0.5, 0.15, 0.85), clamp(_a.y * 0.5 + 0.5, 0.15, 0.85));
          else linesU.uFocus.value.set(0.5, 0.5);
        }
        if (lines) lines.visible = linesU.uS.value > 0.005;
        // 3D streaks
        const sStreak = clamp((p.speed - 28) / 45, 0, 1);
        streakU.uS.value = cfg.streaks ? Math.min(1, sStreak * sStreak + st.cloud * 1.5) : 0;
        streakU.uCam.value.copy(_cam);
        streakU.uVel.value.copy(p.vel);
        streakU.uLen.value = clamp(p.speed * 0.12, 1, 14);
        if (streaks) streaks.visible = streakU.uS.value > 0.005;
        if (cfg.vapour) updateVapour(dt);
        if (cfg.birds) updateBirds(dt, p.pos);
        updateWispsAndPetals(dt, p);
      } catch (e) {
        if (!ambient._warned) { console.error('[ambient] update', e); ambient._warned = true; }
      }
    },
    dispose() { overlayHandle?.remove(); },
  };
  return ambient;
}
