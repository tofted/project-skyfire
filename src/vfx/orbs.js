// Fireball cores: one instanced displaced icosphere with stepped fresnel heat bands (white-hot centre, coloured rim),
// a dark inked outline hull (reads against a bright sky) and an additive halo billboard. Three draw calls for all.
// Charges (fx.charge) use the same orbs while they grow.
import * as THREE from 'three';
import { RAMP_ROWS } from './textures.js';

const ORB_VERT = /* glsl */`
attribute vec4 aOrb;          // row, seed, intensity, wobble
uniform float uTime, uStepFps;
uniform sampler2D uNoise;
uniform float uWidth;         // outline extrusion (unit-sphere units), 0 for the core
varying vec3 vN, vV, vObj, vWorld;
varying vec4 vOrb;
varying float vShapeT;
__ATMO__
varying vec3 vFogT, vFogAdd;
void main() {
  float st = floor(uTime * uStepFps) / uStepFps;
  vec3 pn = normalize(position);
  float s = aOrb.y * 17.0;
  float n1 = texture2D(uNoise, pn.xy * 0.32 + vec2(s, st * 0.55)).r;
  float n2 = texture2D(uNoise, pn.yz * 0.32 + vec2(st * 0.4, s)).r;
  float n3 = texture2D(uNoise, pn.zx * 0.32 + vec2(s * 0.7, -st * 0.5)).r;
  float disp = ((n1 + n2 + n3) / 3.0 - 0.5) * aOrb.w;
  vec3 p = pn * (1.0 + disp + uWidth);
  vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  vec4 mv = viewMatrix * wp;
  gl_Position = projectionMatrix * mv;
  vN = normalize(mat3(viewMatrix) * mat3(modelMatrix) * mat3(instanceMatrix) * pn);
  vV = normalize(-mv.xyz);
  vObj = pn;
  vOrb = aOrb;
  vShapeT = st;
  vFogAdd = atmoApply(vec3(0.0), wp.xyz);
  vFogT = atmoApply(vec3(1.0), wp.xyz) - vFogAdd;
}
`;

const CORE_FRAG = /* glsl */`
uniform sampler2D uNoise, uRamp;
uniform float uRows;
uniform float uBias[ROWS], uCrust[ROWS];
varying vec3 vN, vV, vObj, vWorld;
varying vec4 vOrb;
varying float vShapeT;
varying vec3 vFogT, vFogAdd;
float aa(float e, float x) { float w = max(fwidth(x), 1e-4); return smoothstep(e - w, e + w, x); }
vec3 ramp(float row, float heat) { return texture2D(uRamp, vec2(clamp(heat, 0.0, 1.0) * (63.0 / 64.0) + 0.5 / 64.0, (row + 0.5) / uRows)).rgb; }
void main() {
  float f = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
  // swirling surface flow (spherical coords), on twos
  float lon = atan(vObj.z, vObj.x) / 6.2831, lat = vObj.y * 0.5 + 0.5;
  float n = texture2D(uNoise, vec2(lon * 3.0 + vShapeT * 0.35 + vOrb.y, lat * 2.2 - vShapeT * 0.9)).r * 0.7
          + texture2D(uNoise, vec2(lon * 7.0 - vShapeT * 0.6, lat * 5.0 - vShapeT * 1.7 + vOrb.y)).r * 0.3;
  int ri = int(vOrb.x + 0.5);
  float bias = 0.0, crust = 0.0;
  for (int k = 0; k < ROWS; k++) if (k == ri) { bias = uBias[k]; crust = uCrust[k]; }
  float heat = 0.14 + bias + 0.8 * pow(f, 1.8) + (n - 0.5) * 0.62;
  if (crust > 0.0) {
    // molten rock (titan): dark crust plates split by glowing veins along the Worley cell borders; the plates
    // drift on twos. The heart facing the camera stays molten so the orb still reads as fire.
    float cell = texture2D(uNoise, vec2(lon * 2.0 + vOrb.y * 3.0 + vShapeT * 0.04, lat * 1.4 - vShapeT * 0.1)).g;
    float vein = 1.0 - aa(0.34, cell + (n - 0.5) * 0.25);
    float rimCrust = 1.0 - smoothstep(0.35, 0.9, f);            // molten gold heart, crusted crimson rim
    heat = mix(heat, heat * 0.42 + 0.1, crust * (1.0 - vein) * rimCrust);
    heat += crust * (vein * 0.22 + (1.0 - rimCrust) * 0.1);
  }
  float lv = (aa(0.3, heat) + aa(0.52, heat) + aa(0.74, heat) + aa(0.93, heat)) * 0.25;
  vec3 col = ramp(vOrb.x, 0.34 + 0.66 * lv) * vOrb.z;
  col *= mix(0.62, 1.0, aa(0.12, f));                // darker rim band just inside the ink line
  col = col * vFogT + vFogAdd;
  gl_FragColor = vec4(col, 1.0);
}
`;

const LINE_FRAG = /* glsl */`
uniform vec3 uInk[ROWS];
varying vec4 vOrb;
varying vec3 vFogT, vFogAdd;
void main() {
  int i = int(vOrb.x + 0.5);
  vec3 c = uInk[0];
  for (int k = 1; k < ROWS; k++) if (k == i) c = uInk[k];
  gl_FragColor = vec4(c * vFogT + vFogAdd, 1.0);
}
`;

const HALO_VERT = /* glsl */`
attribute vec4 aOrb;
varying vec2 vQ;
varying vec4 vOrb;
varying vec3 vFogT;
uniform float uHalo;
__ATMO__
void main() {
  vec3 c = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float r = length((instanceMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz) * uHalo;
  vec4 mv = viewMatrix * vec4(c, 1.0);
  float depth = -mv.z;
  mv.xy += position.xy * r;
  mv.z += min(r * 0.6, depth * 0.5);         // pull toward the camera so the core does not clip the halo
  gl_Position = projectionMatrix * mv;
  vQ = position.xy;
  vOrb = aOrb;
  vFogT = atmoApply(vec3(1.0), c) - atmoApply(vec3(0.0), c);
}
`;

const HALO_FRAG = /* glsl */`
uniform sampler2D uRamp;
uniform float uRows;
varying vec2 vQ;
varying vec4 vOrb;
varying vec3 vFogT;
vec3 ramp(float row, float heat) { return texture2D(uRamp, vec2(clamp(heat, 0.0, 1.0) * (63.0 / 64.0) + 0.5 / 64.0, (row + 0.5) / uRows)).rgb; }
void main() {
  float r = length(vQ);
  float s = max(1.0 - r, 0.0);
  float m = s * s * s * 0.34 + s * 0.05 + (1.0 - smoothstep(0.0, 0.3, r)) * 0.55;   // hot heart shows through the flames
  vec3 col = ramp(vOrb.x, 0.62) * m * vOrb.z * vFogT;
  gl_FragColor = vec4(col, 0.0);
}
`;

// Outline ink per ramp row (see textures.js ROW): player brown-red, Shade Riders indigo-black, titan crimson-black,
// …, ace blue-black.
// Row 10 (inferno, charged fireballs): warm brown ink and a hotter heart (bias +0.06).
// Rows 11–16 (levels and elements): azure navy ink, radiant amber-brown ink (hot heart), lightning deep-blue ink with a
// white-hot heart (the bolt's orb is mostly light).
const INK = [0x4a1606, 0x1c0a34, 0x34040a, 0x4a1606, 0x6070a0, 0x4a1606, 0x34040a, 0x1c0a34, 0x0a1438, 0x0a1438, 0x5a2c06,
  0x08204e, 0x08204e, 0x5e3408, 0x5e3408, 0x042a66, 0x042a66, 0x2a0a4e, 0x2a0a4e];      // (17–18: prism, violet-black ink)
const BIAS = [0, 0, -0.04, 0, 0, 0, 0, 0, 0, 0, 0.06, 0.02, 0.02, 0.07, 0.07, 0.14, 0.14, 0.1, 0.1];
const CRUST = [0, 0, 0.9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
if (INK.length !== RAMP_ROWS || BIAS.length !== RAMP_ROWS || CRUST.length !== RAMP_ROWS) console.warn('[fx] orbs: ink / bias rows != RAMP_ROWS');

export function createOrbs(game, tex, capacity = 64) {
  const atmoChunk = game.atmo ? game.atmo.chunk : 'vec3 atmoApply(vec3 c, vec3 p) { return c; }';
  const atmoU = game.atmo ? game.atmo.uniforms : {};
  const uTime = { value: 0 };
  const common = { uTime, uStepFps: { value: 12 }, uNoise: { value: tex.noise }, uRamp: { value: tex.ramp }, uRows: { value: tex.rows } };

  const geo = new THREE.IcosahedronGeometry(1, 4);
  const aOrb = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  aOrb.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aOrb', aOrb);
  const vert = ORB_VERT.replace('__ATMO__', atmoChunk);

  const coreMat = new THREE.ShaderMaterial({
    uniforms: { ...common, ...atmoU, uWidth: { value: 0 }, uBias: { value: BIAS }, uCrust: { value: CRUST } },
    vertexShader: vert, fragmentShader: CORE_FRAG, defines: { ROWS: RAMP_ROWS },
  });
  const lineMat = new THREE.ShaderMaterial({
    uniforms: { ...common, ...atmoU, uWidth: { value: 0.075 }, uInk: { value: INK.map((h) => new THREE.Color(h)) } },
    vertexShader: vert, fragmentShader: LINE_FRAG, defines: { ROWS: RAMP_ROWS }, side: THREE.BackSide,
  });
  const haloGeo = new THREE.PlaneGeometry(2, 2);
  haloGeo.setAttribute('aOrb', aOrb);
  const haloMat = new THREE.ShaderMaterial({
    uniforms: { ...common, ...atmoU, uHalo: { value: 1.9 } },
    vertexShader: HALO_VERT.replace('__ATMO__', atmoChunk), fragmentShader: HALO_FRAG,
    transparent: true, depthWrite: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  for (const m of [coreMat, lineMat, haloMat]) m.toneMapped = false;

  const core = new THREE.InstancedMesh(geo, coreMat, capacity);
  const line = new THREE.InstancedMesh(geo, lineMat, capacity);
  const halo = new THREE.InstancedMesh(haloGeo, haloMat, capacity);
  line.instanceMatrix = core.instanceMatrix;
  halo.instanceMatrix = core.instanceMatrix;
  core.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  for (const [m, n, ro] of [[core, 'fx-orbs', 12], [line, 'fx-orbs-ink', 12], [halo, 'fx-orbs-halo', 51]]) {
    m.name = n; m.frustumCulled = false; m.count = 0; m.renderOrder = ro;
    m.castShadow = m.receiveShadow = false;
  }
  const group = new THREE.Group();
  group.name = 'fx-orbs';
  group.add(core, line, halo);
  game.scene.add(group);

  const slots = [];
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
  const orbs = {
    group, core, line, halo,
    /** Allocate an orb. Fields you may write each frame: pos (Vector3), radius, row, intensity, wobble, ink. */
    add(o = {}) {
      const slot = {
        pos: (o.pos || new THREE.Vector3()).clone(), radius: o.radius ?? 1, row: o.row ?? 0,
        intensity: o.intensity ?? 1, wobble: o.wobble ?? 0.14, seed: Math.random(), ink: o.ink ?? true, alive: true,
      };
      slots.push(slot);
      return slot;
    },
    remove(slot) { if (slot) slot.alive = false; },
    get count() { return core.count; },
    flush() {
      uTime.value = game.time.now;
      let n = 0;
      for (let i = slots.length - 1; i >= 0; i--) if (!slots[i].alive) slots.splice(i, 1);
      for (const s of slots) {
        if (n >= capacity) break;
        if (s.radius <= 0.001) continue;
        _s.setScalar(s.radius);
        _m.compose(s.pos, _q, _s);
        core.setMatrixAt(n, _m);
        aOrb.array[n * 4] = s.row; aOrb.array[n * 4 + 1] = s.seed;
        aOrb.array[n * 4 + 2] = s.intensity; aOrb.array[n * 4 + 3] = s.wobble;
        n++;
      }
      core.count = halo.count = n;
      line.count = n;          // every orb is inked (outline hidden behind nothing else)
      core.instanceMatrix.needsUpdate = true;
      aOrb.needsUpdate = true;
    },
  };
  return orbs;
}
