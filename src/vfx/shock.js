// Oriented shock rings and vapour cones (flight moves). Two draw calls for all of them.
//   rings — flat world-space rings in the plane perpendicular to a direction (not camera-facing billboards): the dash
//           burst Sora punches through, the sonic boom, the energy rings along a charged fireball, a near-miss snap.
//           Stateless GPU records in a ring buffer (like vfx/particles.js): the centre drifts with drag, the radius
//           grows easeOutExpo, the band thins and breaks up with age. Two tones: a hot core line and a thin cool (or
//           warm-brown) "ink" line just outside it, so a white ring still reads on white clouds. It fades next to the
//           lens (the chase camera flies through a ring left in the air) and a little when seen edge-on.
//   cones — the condensation (Prandtl–Glauert) cone of a sonic boom: a streaky white bell around the dragon, apex at
//           its chest, flaring backward. It rides the dragon (the CPU sets its transform every frame; ≤ 4 at once),
//           densest at its front edge, thinning backward, over ~0.6 s.
// Both are transparent, premultiplied "over", depthWrite off: the pipeline draws them on its FX layer after the clouds.
import * as THREE from 'three';

// azure / radiant / lightning (levels and elements): Sora's level-up aura rings and her element's energy rings
export const RING_STYLE = { dash: 0, boom: 1, energy: 2, snap: 3, enemy: 4, azure: 5, radiant: 6, lightning: 7 };
const NSTYLE = 8;
const STRIDE = 20;

const RING_VERT = /* glsl */`
attribute vec4 aC;   // centre xyz, t0
attribute vec4 aN;   // normal xyz, life
attribute vec4 aR;   // r0, r1, band half-width (radius units), intensity
attribute vec4 aV;   // drift velocity xyz, seed
attribute vec4 aS;   // style, drag k, near-fade distance (m), delay-free spare
uniform float uTime;
varying vec2 vQ;
varying vec4 vI;     // age, seed, style, width
varying float vFade, vDepth, vInt;
varying vec3 vFogT, vFogAdd;
__ATMO__
void main() {
  float t = uTime - aC.w;
  float life = aN.w;
  float a = t / max(life, 1e-4);
  if (t < 0.0 || a >= 1.0 || life <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float k = aS.y;
  float e = k > 1e-3 ? (1.0 - exp(-k * t)) / k : t;
  vec3 c = aC.xyz + aV.xyz * e;
  vec3 n = normalize(aN.xyz + vec3(0.0, 1e-6, 0.0));
  vec3 u = abs(n.y) < 0.95 ? normalize(cross(n, vec3(0.0, 1.0, 0.0))) : normalize(cross(n, vec3(1.0, 0.0, 0.0)));
  vec3 v = cross(n, u);
  float grow = 1.0 - exp2(-7.0 * a);
  float r = mix(aR.x, aR.y, grow);
  float span = 1.0 + aR.z * 3.0 + 0.06;               // quad half-size in ring radii (room for band + ink)
  vec2 q = position.xy * 2.0 * span;
  vec3 wp = c + (u * q.x + v * q.y) * r;
  vec4 mv = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mv;
  vQ = q;
  vI = vec4(a, aV.w, aS.x, aR.z);
  // seen edge-on the ring is a line: keep it, but dimmer (never a bright bar across the view)
  float facing = abs(dot(n, normalize(cameraPosition - c)));
  vFade = mix(0.3, 1.0, smoothstep(0.06, 0.45, facing));
  vInt = aR.w;
  // depth in units of the ring's near-fade distance (aS.z m): the fragment fades it out next to the lens
  vDepth = -mv.z / max(aS.z, 0.5);
  vFogAdd = atmoApply(vec3(0.0), c);
  vFogT = atmoApply(vec3(1.0), c) - vFogAdd;
}
`;

const RING_FRAG = /* glsl */`
uniform sampler2D uNoise;
uniform vec3 uCore[NSTYLE], uBand[NSTYLE], uInk[NSTYLE];
varying vec2 vQ;
varying vec4 vI;
varying float vFade, vDepth, vInt;
varying vec3 vFogT, vFogAdd;
vec3 pick(vec3 arr[NSTYLE], float s) { int i = int(s + 0.5); vec3 c = arr[0]; for (int k = 1; k < NSTYLE; k++) if (k == i) c = arr[k]; return c; }
void main() {
  float age = vI.x, seed = vI.y, style = vI.z;
  float r = length(vQ);
  float w = vI.w * mix(1.0, 0.4, age);                 // the band thins as it expands
  float d = r - 1.0;
  float fw = max(fwidth(r), 1e-4);
  float ang = atan(vQ.y, vQ.x);
  // broken by noise around the ring (seamless: sampled on a circle), more gaps as it ages
  float brk = texture2D(uNoise, vec2(cos(ang), sin(ang)) * 0.22 + vec2(seed * 3.7, seed * 1.3 + age * 0.35)).r;
  float gaps = smoothstep(0.12 + age * 0.55, 0.3 + age * 0.55, brk);
  float core = 1.0 - smoothstep(w * 0.28, w * 0.28 + fw * 1.5, abs(d + w * 0.15));
  float band = 1.0 - smoothstep(w * 0.4, w + fw, abs(d));
  float ink = 1.0 - smoothstep(w * 0.12, w * 0.12 + fw * 1.5, abs(d - w * 0.95));
  // a faint pressure disc just inside the front (air squeezed by the burst), young rings only
  float disc = (1.0 - smoothstep(0.0, 0.45, -d)) * step(d, 0.0) * (1.0 - smoothstep(0.0, 0.35, age)) * 0.18;
  float life = (1.0 - smoothstep(0.55, 1.0, age)) * smoothstep(0.0, 0.04, age);
  float near = smoothstep(0.35, 1.0, vDepth);          // vDepth is depth / near-fade distance
  float k = life * near * vFade * vInt;
  vec3 col = (pick(uCore, style) * core * gaps + pick(uBand, style) * (band * 0.45 * gaps + disc)) * vFogT;
  // the ink line replaces half of what is behind it (premultiplied "over"), so a white ring reads on a white cloud
  float inkA = ink * gaps * 0.5;
  vec3 outc = (col + (pick(uInk, style) * vFogT + vFogAdd) * inkA) * k;
  float a = (inkA + band * gaps * 0.06) * k;
  if (a < 0.002 && max(outc.r, max(outc.g, outc.b)) < 0.002) discard;
  gl_FragColor = vec4(outc, a);
}
`;

const CONE_VERT = /* glsl */`
attribute vec4 aCone;       // age 0..1, intensity, seed, spare
varying vec3 vL;            // local: x, y (around), s (0 apex .. 1 back)
varying vec4 vC;
varying float vRim, vDepth;
varying vec3 vFogT, vFogAdd;
__ATMO__
void main() {
  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vec4 mv = viewMatrix * wp;
  gl_Position = projectionMatrix * mv;
  vL = vec3(position.xy, -position.z);
  vC = aCone;
  vec3 nrm = normalize(mat3(viewMatrix) * mat3(modelMatrix) * mat3(instanceMatrix) * normal);
  vRim = 1.0 - abs(dot(nrm, normalize(-mv.xyz)));
  vDepth = -mv.z;
  vFogAdd = atmoApply(vec3(0.0), wp.xyz);
  vFogT = atmoApply(vec3(1.0), wp.xyz) - vFogAdd;
}
`;

const CONE_FRAG = /* glsl */`
uniform sampler2D uNoise;
uniform float uTime;
uniform vec3 uLit, uShade;
varying vec3 vL;
varying vec4 vC;
varying float vRim, vDepth;
varying vec3 vFogT, vFogAdd;
void main() {
  float age = vC.x, seed = vC.z;
  float s = clamp(vL.z, 0.0, 1.0);
  float th = atan(vL.y, vL.x) / 6.2831853 + 0.5;
  float st = floor(uTime * 12.0) / 12.0;              // on twos, like the fire
  // streamwise streaks: features stretched along the cone, drifting backward
  float n = texture2D(uNoise, vec2(th * 5.0 + seed, s * 0.45 - st * 0.9 + seed * 2.0)).r;
  float n2 = texture2D(uNoise, vec2(th * 11.0 - seed * 3.0, s * 0.9 - st * 1.6)).b;
  float streak = smoothstep(0.3, 0.75, n * 0.75 + n2 * 0.4);
  // a streaky body from just behind the apex to the flared back; a bright shock front near the apex (reads from the
  // side) and a bright lip near the back edge (from the chase camera the cone is seen through its open back: a white
  // ring around the dragon, not a haze over her). The front moves back a little as the cone ages.
  float front = smoothstep(0.03, 0.1, s - age * 0.1);
  float body = front * (1.0 - smoothstep(0.72, 1.0, s)) * mix(0.2, 1.0, streak) * 0.5;
  float lip = smoothstep(0.55, 0.82, s) * (1.0 - smoothstep(0.86, 1.0, s)) * mix(0.35, 1.0, streak) * 0.75;
  float edge = (1.0 - smoothstep(0.0, 0.07, abs(s - 0.09 - age * 0.1))) * mix(0.4, 1.0, streak) * 0.7;
  float life = smoothstep(0.0, 0.08, age) * (1.0 - smoothstep(0.45, 1.0, age));
  float k = (body + lip + edge) * life * vC.y * mix(0.6, 1.0, vRim);
  k *= smoothstep(2.0, 7.0, vDepth);
  if (k < 0.003) discard;
  vec3 col = mix(uShade, uLit, 0.35 + 0.65 * streak) * vFogT + vFogAdd;
  gl_FragColor = vec4(col * k, k * 0.75);
}
`;

/** Unit cone surface: apex at z = 0, back at z = -1, radius profile bell-shaped (0.16 → 1). */
function coneGeometry(seg = 28, rings = 7) {
  const pos = [], nrm = [], idx = [];
  const prof = (s) => 0.16 + 0.84 * Math.pow(s, 0.5);
  for (let j = 0; j <= rings; j++) {
    const s = j / rings;
    const r = prof(s), dr = (prof(Math.min(1, s + 0.01)) - prof(Math.max(0, s - 0.01))) / 0.02;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const c = Math.cos(a), si = Math.sin(a);
      pos.push(c * r, si * r, -s);
      // outward normal of the surface of revolution (radius r(s) along -z)
      const nx = c, ny = si, nz = dr;
      const l = Math.hypot(nx, ny, nz);
      nrm.push(nx / l, ny / l, nz / l);
    }
  }
  for (let j = 0; j < rings; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * (seg + 1) + i, b = a + seg + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

export function createShock(game, tex, { rings = 48, cones = 4 } = {}) {
  const atmoChunk = game.atmo ? game.atmo.chunk : 'vec3 atmoApply(vec3 c, vec3 p) { return c; }';
  const atmoU = game.atmo ? game.atmo.uniforms : {};
  const uTime = { value: 0 };
  const lin = (r, g, b) => new THREE.Vector3(r, g, b);
  // styles: dash (Sora: white-gold core, warm band, sky-blue ink), boom (white, blue ink), energy (inferno / charged:
  // gold, brown ink), snap (near miss: small white), enemy (violet-white, indigo ink — AI wingovers/dashes)
  // … azure (white-cyan core, blue band, navy ink), radiant (white-gold core, pale gold band, amber ink), lightning
  // (white-cyan core, saturated cyan band, deep-blue ink — fix pass: the blue-violet band went lavender in the tone map)
  const core = [lin(2.1, 1.9, 1.45), lin(2.0, 2.1, 2.3), lin(2.6, 2.0, 0.8), lin(1.6, 1.7, 1.8), lin(1.7, 1.2, 2.3),
    lin(1.5, 2.2, 2.8), lin(2.7, 2.5, 1.8), lin(2.0, 3.0, 3.3)];
  const band = [lin(0.9, 0.78, 0.55), lin(0.75, 0.85, 1.0), lin(1.2, 0.66, 0.12), lin(0.7, 0.8, 0.95), lin(0.55, 0.3, 0.9),
    lin(0.25, 0.7, 1.2), lin(1.2, 0.98, 0.45), lin(0.08, 0.72, 1.05)];
  const ink = [lin(0.22, 0.36, 0.55), lin(0.2, 0.33, 0.55), lin(0.3, 0.12, 0.02), lin(0.2, 0.33, 0.55), lin(0.1, 0.05, 0.22),
    lin(0.02, 0.1, 0.34), lin(0.34, 0.18, 0.03), lin(0.0, 0.04, 0.3)];

  // ---- rings: ring-buffer instanced quads ----
  const data = new Float32Array(rings * STRIDE);
  for (let i = 0; i < rings; i++) data[i * STRIDE + 7] = -1;
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const buf = new THREE.InstancedInterleavedBuffer(data, STRIDE, 1);
  buf.setUsage(THREE.DynamicDrawUsage);
  ['aC', 'aN', 'aR', 'aV', 'aS'].forEach((n, i) => geo.setAttribute(n, new THREE.InterleavedBufferAttribute(buf, 4, i * 4)));
  geo.instanceCount = rings;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  const PREMUL = {
    transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  };
  const ringMat = new THREE.ShaderMaterial({
    uniforms: { ...atmoU, uTime, uNoise: { value: tex.noise }, uCore: { value: core }, uBand: { value: band }, uInk: { value: ink } },
    vertexShader: RING_VERT.replace('__ATMO__', atmoChunk), fragmentShader: RING_FRAG, defines: { NSTYLE }, ...PREMUL,
  });
  const ringMesh = new THREE.Mesh(geo, ringMat);
  ringMesh.name = 'fx-shock-rings';
  ringMesh.frustumCulled = false;
  ringMesh.renderOrder = 49;
  ringMesh.matrixAutoUpdate = false;

  // ---- cones: CPU-posed instanced bells ----
  const cgeo = coneGeometry();
  const aCone = new THREE.InstancedBufferAttribute(new Float32Array(cones * 4), 4);
  aCone.setUsage(THREE.DynamicDrawUsage);
  cgeo.setAttribute('aCone', aCone);
  const coneMat = new THREE.ShaderMaterial({
    uniforms: { ...atmoU, uTime, uNoise: { value: tex.noise }, uLit: { value: new THREE.Color(1.15, 1.16, 1.2) }, uShade: { value: new THREE.Color(0.62, 0.72, 0.9) } },
    vertexShader: CONE_VERT.replace('__ATMO__', atmoChunk), fragmentShader: CONE_FRAG, ...PREMUL,
  });
  const coneMesh = new THREE.InstancedMesh(cgeo, coneMat, cones);
  coneMesh.name = 'fx-shock-cones';
  coneMesh.frustumCulled = false;
  coneMesh.count = 0;
  coneMesh.renderOrder = 47;
  coneMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (const m of [ringMat, coneMat]) { m.toneMapped = false; m.userData.fx = true; }

  const group = new THREE.Group();
  group.name = 'fx-shock';
  group.add(ringMesh, coneMesh);
  game.scene.add(group);

  let head = 0, dirtyStart = 0, dirtyCount = 0, spawned = 0, liveUntil = -1;   // no live ring → the mesh is hidden (no draw)
  const live = [];                  // cones: { dragon, getPose(outPos, outDir), t, life, R, L, intensity, seed }
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _d = new THREE.Vector3();
  const _z = new THREE.Vector3(0, 0, 1);

  const api = {
    group, ringMesh, coneMesh,
    get stats() { return { rings: countLive(), cones: live.length, spawned }; },
    /**
     * One flat ring. o: { pos, normal (unit), r0, r1 (m), life (s), width (band half-width, radius units), intensity,
     * style (RING_STYLE), vel (drift m/s), drag (1/s), near (m: fades closer to the lens than this), delay (s) }
     */
    ring(o) {
      const i = head, b = i * STRIDE, n = o.normal;
      if (!o.pos || !n) return;
      data[b] = o.pos.x; data[b + 1] = o.pos.y; data[b + 2] = o.pos.z; data[b + 3] = game.time.now + (o.delay || 0);
      data[b + 4] = n.x; data[b + 5] = n.y; data[b + 6] = n.z; data[b + 7] = o.life ?? 0.5;
      data[b + 8] = o.r0 ?? 1; data[b + 9] = o.r1 ?? 8; data[b + 10] = o.width ?? 0.06; data[b + 11] = o.intensity ?? 1;
      data[b + 12] = o.vel?.x || 0; data[b + 13] = o.vel?.y || 0; data[b + 14] = o.vel?.z || 0; data[b + 15] = Math.random();
      data[b + 16] = o.style ?? 0; data[b + 17] = o.drag ?? 2; data[b + 18] = o.near ?? 6; data[b + 19] = 0;
      liveUntil = Math.max(liveUntil, data[b + 3] + data[b + 7]);
      if (dirtyCount === 0) dirtyStart = i;
      dirtyCount = Math.min(rings, dirtyCount + 1);
      head = (i + 1) % rings;
      spawned++;
    },
    /**
     * A vapour cone that rides a moving body. pose(outPos, outDir) → false when the body is gone; outPos = apex
     * (world), outDir = flight direction (unit). o: { life, R (m, back radius), L (m, length), intensity }
     */
    cone(pose, o = {}) {
      if (live.length >= cones) live.shift();
      live.push({ pose, t: 0, life: o.life ?? 0.6, R: o.R ?? 7, L: o.L ?? 13, intensity: o.intensity ?? 1, seed: Math.random() });
    },
    update(dt) {
      uTime.value = game.time.now;
      ringMesh.visible = game.time.now < liveUntil;
      // rings: upload new records
      if (dirtyCount) {
        buf.clearUpdateRanges();
        if (dirtyStart + dirtyCount <= rings) buf.addUpdateRange(dirtyStart * STRIDE, dirtyCount * STRIDE);
        else { buf.addUpdateRange(dirtyStart * STRIDE, (rings - dirtyStart) * STRIDE); buf.addUpdateRange(0, (dirtyStart + dirtyCount - rings) * STRIDE); }
        buf.needsUpdate = true;
        dirtyCount = 0;
      }
      // cones: follow their bodies
      let n = 0;
      for (let i = live.length - 1; i >= 0; i--) {
        const c = live[i];
        c.t += dt;
        let ok = false;
        try { ok = c.pose(_p, _d) !== false; } catch { ok = false; }
        if (!ok || c.t >= c.life) { live.splice(i, 1); continue; }
      }
      for (const c of live) {
        const a = c.t / c.life;
        try { c.pose(_p, _d); } catch { continue; }
        if (_d.lengthSq() < 1e-6) _d.set(0, 0, 1); else _d.normalize();
        _q.setFromUnitVectors(_z, _d);
        const g = 0.7 + 0.45 * (1 - Math.pow(1 - a, 2));
        _s.set(c.R * g, c.R * g, c.L * (0.8 + 0.3 * a));
        _m.compose(_p, _q, _s);
        coneMesh.setMatrixAt(n, _m);
        aCone.array[n * 4] = a; aCone.array[n * 4 + 1] = c.intensity; aCone.array[n * 4 + 2] = c.seed; aCone.array[n * 4 + 3] = 0;
        n++;
      }
      coneMesh.count = n;
      coneMesh.visible = n > 0;
      if (n) { coneMesh.instanceMatrix.needsUpdate = true; aCone.needsUpdate = true; }
    },
    clear() {
      for (let i = 0; i < rings; i++) data[i * STRIDE + 7] = -1;
      dirtyStart = 0; dirtyCount = rings;
      live.length = 0; liveUntil = -1;
    },
  };
  function countLive() {
    const now = game.time.now;
    let k = 0;
    for (let i = 0; i < rings; i++) { const t = now - data[i * STRIDE + 3]; if (t >= 0 && t < data[i * STRIDE + 7]) k++; }
    return k;
  }
  return api;
}
