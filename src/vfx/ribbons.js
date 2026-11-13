// Breath core lines: one camera-facing ribbon per breath stream, drawn through the stream's real centreline (the
// closed-form positions of flame packets launched over the last few tenths of a second), so the line bends when the
// dragon hoses the stream around. It is the white-hot "blade" of an anime flame jet and the part that keeps the
// stream readable when it is seen along its axis from the chase camera. One draw call for every stream.
// Premultiplied additive (alpha 0) like the glow particles; the pipeline tags it onto its FX layer.
import * as THREE from 'three';

const VERT = /* glsl */`
attribute vec3 aTan;      // world tangent along the line
attribute vec4 aR;        // u (0 mouth .. 1 end), side (-1 | 1), half width (m), heat
attribute vec4 aR2;       // row, seed, intensity, pull toward the camera (m)
attribute float aAlong;   // metres from the mouth along the line
uniform float uTime, uStepFps;
varying vec4 vR, vR2;
varying float vShapeT;
varying vec3 vFogT;
__ATMO__
void main() {
  vec4 mv = viewMatrix * vec4(position, 1.0);
  float depth = max(-mv.z, 0.05);
  vec3 t = mat3(viewMatrix) * aTan;
  vec3 toCam = normalize(-mv.xyz);
  vec3 side = cross(t, toCam);
  float sl = length(side);
  // seen end-on the side vector is undefined: keep a stable one (the line is a dot there anyway)
  side = sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0);
  float w = aR.z;
  w = min(w, 0.03 * depth);                                  // never a screen-filling bar right at the camera
  w *= smoothstep(0.6, 3.0, depth);
  mv.xyz += side * aR.y * w;
  // Painted over the flame bodies: pulled toward the camera WITHOUT moving on screen (xy scaled with depth). Seen
  // along its axis (chase camera) the far part is pulled up to the mouth's depth, so the nearer tongues no longer
  // hide it — but never in front of the mouth, so the dragon's own head still covers it.
  float fore = smoothstep(0.5, 0.95, abs(normalize(t).z));
  float d0 = max(-mv.z, 0.05);
  float pull = min(aR2.w + 0.85 * fore * aAlong, d0 * 0.6);
  mv.xy *= (d0 - pull) / d0;
  mv.z += pull;
  gl_Position = projectionMatrix * mv;
  vR = aR; vR2 = aR2;
  vShapeT = floor(uTime * uStepFps) / uStepFps;
  vFogT = atmoApply(vec3(1.0), position) - atmoApply(vec3(0.0), position);
}
`;

const FRAG = /* glsl */`
uniform sampler2D uNoise, uRamp;
uniform float uRows;
varying vec4 vR, vR2;
varying float vShapeT;
varying vec3 vFogT;
float aa(float e, float x) { float w = max(fwidth(x), 1e-4); return smoothstep(e - w, e + w, x); }
vec3 ramp(float row, float heat) { return texture2D(uRamp, vec2(clamp(heat, 0.0, 1.0) * (63.0 / 64.0) + 0.5 / 64.0, (row + 0.5) / uRows)).rgb; }
void main() {
  float u = vR.x, s = vR.y, heat = vR.w;
  float seed = vR2.y;
  // flowing, broken edges (on twos): noise scrolls down the line, so the core seems to shoot out of the mouth
  float n = texture2D(uNoise, vec2(u * 2.6 - vShapeT * 2.1 + seed, s * 0.18 + seed * 3.7)).r;
  float n2 = texture2D(uNoise, vec2(u * 7.0 - vShapeT * 3.3 + seed * 5.0, s * 0.35)).b;
  float e = 1.0 - abs(s) + (n - 0.5) * 0.9 + (n2 - 0.5) * 0.35 - smoothstep(0.55, 1.0, u) * 0.9;
  e = min(e, u * 14.0);                                      // pointed at the mouth
  float m = aa(0.0, e) * 0.5 + aa(0.42, e) * 0.5;            // two stepped bands: hot rim, white-hot core
  if (m <= 0.0) discard;
  vec3 col = ramp(vR2.x, heat + aa(0.42, e) * 0.12) * m * vR2.z * vFogT;
  gl_FragColor = vec4(col, 0.0);
}
`;

export function createRibbons(game, tex, maxRibbons = 24, points = 20) {
  const atmoChunk = game.atmo ? game.atmo.chunk : 'vec3 atmoApply(vec3 c, vec3 p) { return c; }';
  const atmoU = game.atmo ? game.atmo.uniforms : {};
  const nv = maxRibbons * points * 2;
  const pos = new Float32Array(nv * 3), tan = new Float32Array(nv * 3), r1 = new Float32Array(nv * 4), r2 = new Float32Array(nv * 4);
  const al = new Float32Array(nv);
  const geo = new THREE.BufferGeometry();
  const mk = (arr, n) => { const a = new THREE.BufferAttribute(arr, n); a.setUsage(THREE.DynamicDrawUsage); return a; };
  const aPos = mk(pos, 3), aTan = mk(tan, 3), aR = mk(r1, 4), aR2 = mk(r2, 4), aAl = mk(al, 1);
  geo.setAttribute('position', aPos); geo.setAttribute('aTan', aTan); geo.setAttribute('aR', aR); geo.setAttribute('aR2', aR2);
  geo.setAttribute('aAlong', aAl);
  const idx = [];
  for (let r = 0; r < maxRibbons; r++) {
    for (let i = 0; i < points - 1; i++) {
      const a = (r * points + i) * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  geo.setIndex(idx);
  geo.setDrawRange(0, 0);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  const uTime = { value: 0 };
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...atmoU, uTime, uStepFps: { value: 12 }, uNoise: { value: tex.noise }, uRamp: { value: tex.ramp }, uRows: { value: tex.rows } },
    vertexShader: VERT.replace('__ATMO__', atmoChunk), fragmentShader: FRAG,
    transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  mat.toneMapped = false;
  mat.userData.fx = true;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'fx-ribbons';
  mesh.frustumCulled = false;
  mesh.renderOrder = 52;
  mesh.matrixAutoUpdate = false;
  game.scene.add(mesh);

  let used = 0;
  const api = {
    mesh, points, maxRibbons,
    get count() { return used; },
    /** Start a frame (call before add). */
    begin() { used = 0; },
    /**
     * Add one ribbon. pts: array of Vector3 (mouth first), n ≤ points; width(u) half width in metres, heat(u) 0..1.
     * o: { row, seed, intensity, pull }
     */
    add(pts, n, width, heat, o) {
      if (used >= maxRibbons || n < 2) return false;
      n = Math.min(n, points);
      const base = used * points * 2;
      let along = 0;
      for (let i = 0; i < points; i++) {
        if (i > 0 && i < n) along += pts[i].distanceTo(pts[i - 1]);
        const k = Math.min(i, n - 1);
        const p = pts[k];
        const pa = pts[Math.max(0, k - 1)], pb = pts[Math.min(n - 1, k + 1)];
        let tx = pb.x - pa.x, ty = pb.y - pa.y, tz = pb.z - pa.z;
        const tl = Math.hypot(tx, ty, tz) || 1;
        tx /= tl; ty /= tl; tz /= tl;
        const u = k / (n - 1);
        const w = i < n ? width(u) : 0;          // unused tail points collapse onto the last one
        const h = heat(u);
        for (let s = 0; s < 2; s++) {
          const v = base + i * 2 + s;
          pos[v * 3] = p.x; pos[v * 3 + 1] = p.y; pos[v * 3 + 2] = p.z;
          tan[v * 3] = tx; tan[v * 3 + 1] = ty; tan[v * 3 + 2] = tz;
          r1[v * 4] = u; r1[v * 4 + 1] = s ? 1 : -1; r1[v * 4 + 2] = w; r1[v * 4 + 3] = h;
          r2[v * 4] = o.row; r2[v * 4 + 1] = o.seed; r2[v * 4 + 2] = o.intensity; r2[v * 4 + 3] = o.pull;
          al[v] = along;
        }
      }
      used++;
      return true;
    },
    flush() {
      uTime.value = game.time.now;
      geo.setDrawRange(0, used * (points - 1) * 6);
      mesh.visible = used > 0;
      if (!used) return;
      const nvUsed = used * points * 2;
      for (const [a, n] of [[aPos, 3], [aTan, 3], [aR, 4], [aR2, 4], [aAl, 1]]) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, nvUsed * n);
        a.needsUpdate = true;
      }
    },
  };
  return api;
}
