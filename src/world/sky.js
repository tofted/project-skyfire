// game.sky — painted anime sky dome (game.atmo gradient + high cirrus/altocumulus layer + sun disc + horizon haze),
// the world sun light with two shadow cascades, and a hemisphere fill for built-in materials.
//   sky.sun        DirectionalLight — THE sunlight (colour × intensity from game.atmo.palette.sunLight). Its shadow is
//                  the NEAR cascade: a tight box around the player's dragon (crisp anime self-shadows on dragon+rider).
//   sky.sunFar     DirectionalLight with intensity 0 — carries only the FAR cascade (titan when present, else the
//                  space in front of the camera), so built-in materials are never double-lit.
//   sky.hemi       HemisphereLight — sky blue above, warm bounce below (built-in Lambert/Standard materials).
//   sky.setShadowFocus(obj|Vector3|null)  near-cascade focus (default: game.player).
//   sky.beforeRender(camera)              fits the cascades; the pipeline calls it once per frame.
// Opting in: casters set mesh.castShadow = true (characters, titan, big props near the player only — not terrain,
// vegetation or particles). Receivers set mesh.receiveShadow = true. game.toon materials sample both cascades
// (shadow 0 near, 1 far); built-in materials go through three's light loop and see the near cascade only.
import * as THREE from 'three';
import { ATMO_CHUNK } from '../render/atmosphere.js';
import { rng, clamp } from '../core/util.js';

const SKY_VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = vec4(p.xy, p.w * 0.999999, p.w);      // on the far plane: drawn only where nothing else is
}
`;

const SKY_FRAG = /* glsl */`
uniform sampler2D tNoise;
uniform float uTime, uCirrus, uCirrusAlt, uSunCos0, uSunCos1, uSunIntensity;
uniform vec2 uWind;
uniform vec3 uCloudLit, uCloudShade;
uniform float atmoStars, atmoAurora;      // levels update: night layers (game.atmo presets dusk / night / aurora)
varying vec3 vDir;
${ATMO_CHUNK}

// ---- levels update: the night sky ------------------------------------------------------------------------------
float skyHash(vec3 p) { p = fract(p * 0.3183099 + vec3(0.1, 0.17, 0.23)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
// Two layers of twinkling stars (cells on the direction sphere; HDR, so the brightest bloom) and a faint milky band.
vec3 skyStars(vec3 d) {
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 2; i++) {
    float sc = i == 0 ? 70.0 : 150.0;
    float th = i == 0 ? 0.90 : 0.93;
    vec3 p = d * sc, ip = floor(p), fp = fract(p) - 0.5;
    float h = skyHash(ip + float(i) * 31.0);
    if (h > th) {
      vec3 off = (vec3(skyHash(ip + 1.7), skyHash(ip + 5.3), skyHash(ip + 9.1)) - 0.5) * 0.5;
      float r = length(fp - off);
      float b = (h - th) / (1.0 - th);
      float tw = 0.7 + 0.3 * sin(uTime * (1.2 + 3.5 * b) + h * 211.0);
      float core = smoothstep(0.2 + 0.1 * b, 0.0, r);
      vec3 tint = mix(vec3(0.72, 0.84, 1.0), vec3(1.0, 0.9, 0.74), skyHash(ip + 3.3));
      acc += tint * core * core * (0.35 + 2.6 * b * b) * tw;
    }
  }
  float band = exp(-pow(dot(d, normalize(vec3(0.35, 0.55, -0.76))) * 3.2, 2.0));
  float dust = texture2D(tNoise, d.xz * 1.3 + d.y * 0.7).r * texture2D(tNoise, d.zy * 2.9 + 0.31).a;
  acc += vec3(0.32, 0.4, 0.72) * band * dust * 0.5;
  return acc * smoothstep(-0.02, 0.2, d.y);
}
// Aurora curtains: eight slices of curtain sheets between 8 and 15 km. In the slice plane a curtain is a long line
// that snakes slowly (sheets a few km apart, not every one lit); the same line on every slice stands up as a vertical
// sheet, and noise along the line gives it its rays. Green at the foot, violet at the crown. Sky pixels only, and only
// while atmoAurora > 0 (8 × 3 noise taps).
vec3 skyAurora(vec3 d) {
  if (d.y <= 0.02) return vec3(0.0);
  vec3 acc = vec3(0.0);
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  for (int i = 0; i < 8; i++) {
    float fi = float(i) + jit, k = fi / 8.0;
    float t = (8000.0 + fi * 1000.0 - cameraPosition.y) / d.y;
    vec2 P = (cameraPosition.xz + d.xz * t) / 30000.0;
    float warp = texture2D(tNoise, P * 0.22 + vec2(uTime * 0.003, 0.0)).r;
    float u = P.x * 1.6 + warp * 1.2;                                        // along the curtain
    float v = P.y * 2.2 + sin(u * 1.7 + uTime * 0.04) * 0.3 + (warp - 0.5) * 1.1;   // across: the sheets snake
    float cell = floor(v), band = fract(v) - 0.5;
    float lit = smoothstep(0.38, 0.62, texture2D(tNoise, vec2(cell * 0.37 + 0.11, u * 0.05 + uTime * 0.0015)).g);
    float rays = texture2D(tNoise, vec2(u * 2.6 + cell * 0.31, cell * 0.17 + uTime * 0.006)).a;
    float line = exp(-band * band * (150.0 + 500.0 * k)) * lit;           // the foot is a soft glow, the crown a thin edge
    vec3 c = mix(vec3(0.06, 1.0, 0.46), vec3(0.6, 0.2, 1.0), k * k);
    c = mix(c, vec3(0.08, 0.7, 1.0), 0.3 * warp * (1.0 - k));
    acc += c * line * (0.25 + 1.1 * rays * rays) * (1.0 - 0.6 * k) * exp(-t / 150000.0);
  }
  return acc * smoothstep(0.03, 0.28, d.y) * 0.34;
}

// High layer density at a point of the cirrus plane (uv in units of 16 km): long brush-stroke cirrus in broad
// patches, plus rare fields of small altocumulus cloudlets.
float highCloud(vec2 P, vec2 w) {
  vec2 wd = normalize(uWind + 1e-5);
  vec2 q = vec2(dot(P, wd), dot(P, vec2(-wd.y, wd.x)));
  float cover = texture2D(tNoise, P * 0.11 + w * 0.1).r;
  float warp = texture2D(tNoise, P * 0.4 + w * 0.3).a - 0.5;
  float streak = texture2D(tNoise, vec2(q.x * 0.35, q.y * 1.7 + warp * 0.25) + w).g;
  float fibre = texture2D(tNoise, vec2(q.x * 0.9, q.y * 7.0 + warp * 0.5) + w * 1.6).a;
  float cirrus = smoothstep(0.48, 0.85, streak) * (0.55 + 0.45 * fibre) * smoothstep(0.4, 0.66, cover);
  float cells = texture2D(tNoise, P * 2.2 + warp * 0.35 + w * 1.2).b;
  float alto = smoothstep(0.66, 0.84, cells * 0.75 + fibre * 0.35) * smoothstep(0.72, 0.86, cover);
  return clamp(cirrus * 0.7 + alto * 0.65, 0.0, 1.0);
}

void main() {
  vec3 d = normalize(vDir);
  vec3 col = atmoSky(d);
  float mu = dot(d, atmoSunDir);
  float veil = 0.0;
  if (d.y > 0.0 && uCirrus > 0.0) {
    float t = (uCirrusAlt - cameraPosition.y) / max(d.y, 0.012);
    vec2 P = (cameraPosition.xz + d.xz * t) / 16000.0;
    vec2 w = uWind * uTime;
    float dens = highCloud(P, w);
    // Painted lighting: brighter on the edge that faces the sun, bluish on the far side.
    vec2 toSun = normalize(atmoSunDir.xz + 1e-4) * 0.018;
    float dens2 = highCloud(P + toSun, w);
    float lit = clamp(0.62 + (dens - dens2) * 2.2, 0.0, 1.0);
    float fade = smoothstep(0.02, 0.22, d.y) * exp(-t / 90000.0);
    float a = dens * fade * uCirrus;
    vec3 cc = mix(uCloudShade, uCloudLit, lit);
    cc += atmoSunColor * 0.25 * pow(max(mu, 0.0), 12.0);                         // silver lining near the sun
    cc = mix(cc, atmoHazeColor(d), 1.0 - smoothstep(0.02, 0.35, d.y));           // high clouds sink into the haze
    col = mix(col, cc, a * 0.85);
    veil = a;
  }
  // levels update: stars and the aurora behind the high clouds (the cirrus veil hides them)
  if (atmoStars > 0.003) col += skyStars(d) * atmoStars * (1.0 - veil * 0.85);
  if (atmoAurora > 0.003) col += skyAurora(d) * atmoAurora * (1.0 - veil * 0.6);
  // Wave 4 valley mist: from inside / just above the layer the horizon sinks into the same sunlit mist as the terrain.
  float mT = atmoMistSkyT(cameraPosition, d);
  col = mix(atmoMistIn(d), col, mT);
  float disc = smoothstep(uSunCos0, uSunCos1, mu);
  col += atmoSunColor * disc * uSunIntensity * (1.0 - veil * 0.7) * mT;
  gl_FragColor = vec4(col, 1.0);
}
`;

/** Tileable RGBA noise: R, G = fbm (two seeds), B = inverted cellular (puffs), A = fine fbm. */
function makeNoiseTexture(size = 256, seed = 7) {
  const rnd = rng(seed);
  const perm = new Float32Array(4 * 4096);
  for (let i = 0; i < perm.length; i++) perm[i] = rnd();
  const lattice = (c, x, y, P) => perm[(c * 4096 + (((x % P) + P) % P) * 64 + (((y % P) + P) % P)) % perm.length];
  const vnoise = (c, x, y, P) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = lattice(c, xi, yi, P), b = lattice(c, xi + 1, yi, P);
    const cc = lattice(c, xi, yi + 1, P), dd = lattice(c, xi + 1, yi + 1, P);
    return a + (b - a) * u + (cc - a) * v + (a - b - cc + dd) * u * v;
  };
  const fbm = (c, x, y, base, oct) => {
    let s = 0, amp = 0.5, n = 0, f = base;
    for (let o = 0; o < oct; o++) { s += amp * vnoise(c, x * f, y * f, f); n += amp; amp *= 0.5; f *= 2; }
    return s / n;
  };
  // Cellular points (wrapping grid).
  const G = 10, pts = [];
  for (let i = 0; i < G * G; i++) pts.push([rnd(), rnd()]);
  const cell = (x, y) => {
    const gx = x * G, gy = y * G, ix = Math.floor(gx), iy = Math.floor(gy);
    let best = 9;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const cx = ix + ox, cy = iy + oy;
      const p = pts[(((cx % G) + G) % G) * G + (((cy % G) + G) % G)];
      const dx = cx + p[0] - gx, dy = cy + p[1] - gy;
      best = Math.min(best, dx * dx + dy * dy);
    }
    return Math.sqrt(best);
  };
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size, i = (y * size + x) * 4;
    const warp = fbm(3, u, v, 4, 3) - 0.5;
    data[i] = clamp(fbm(0, u, v, 4, 5) * 1.25 - 0.12, 0, 1) * 255;
    data[i + 1] = clamp(fbm(1, u + warp * 0.15, v, 8, 5) * 1.3 - 0.15, 0, 1) * 255;
    data[i + 2] = clamp(1 - cell(u + warp * 0.05, v) * 1.25, 0, 1) * 255;
    data[i + 3] = clamp(fbm(2, u, v, 16, 4) * 1.3 - 0.15, 0, 1) * 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

const _right = new THREE.Vector3(), _up = new THREE.Vector3(), _f = new THREE.Vector3(), _fwd = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Point light (sun) camera at focus with texel snapping in light space. */
function fitCascade(light, focus, half, sunDir, depth) {
  const size = light.shadow.mapSize.x || 1024;
  _right.crossVectors(UP, sunDir);
  if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
  _right.normalize();
  _up.crossVectors(sunDir, _right).normalize();
  const texel = (2 * half) / size;
  const fx = focus.dot(_right), fy = focus.dot(_up);
  _f.copy(focus)
    .addScaledVector(_right, Math.round(fx / texel) * texel - fx)
    .addScaledVector(_up, Math.round(fy / texel) * texel - fy);
  const cam = light.shadow.camera;
  const D = depth;
  light.target.position.copy(_f);
  light.position.copy(_f).addScaledVector(sunDir, D);
  if (cam.right !== half || cam.far !== D + depth) {
    cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half;
    cam.near = 0.5; cam.far = D + depth;
    cam.updateProjectionMatrix();
  }
  light.updateMatrixWorld();
  light.target.updateMatrixWorld();
}

export default function createSky(game) {
  const { scene, renderer } = game;
  renderer.shadowMap.type = THREE.PCFShadowMap;          // PCFSoft was removed in r186 (it warned and fell back)
  const q = game.quality;
  const shadowsOn0 = (q.shadows ?? 1) > 0;

  // --- lights ---------------------------------------------------------------------------------------------
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.name = 'sun';
  const sunFar = new THREE.DirectionalLight(0xffffff, 0);
  sunFar.name = 'sunFarCascade';
  const hemi = new THREE.HemisphereLight(0xa8c8f0, 0x7a7458, 1);
  hemi.name = 'skyFill';
  const nearHalf = { value: 13 };
  for (const l of [sun, sunFar]) {
    l.castShadow = shadowsOn0;
    l.layers.enableAll();
    scene.add(l, l.target);
  }
  hemi.layers.enableAll();
  scene.add(hemi);
  const nearSize = Math.min(2048, q.shadowSize || 2048);
  sun.shadow.mapSize.set(nearSize, nearSize);
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.025;
  sun.shadow.radius = 1.6;
  const farSize = Math.min(2048, q.shadowSize || 2048);
  sunFar.shadow.mapSize.set(farSize, farSize);
  sunFar.shadow.bias = -0.0005;
  sunFar.shadow.normalBias = 0.25;
  sunFar.shadow.radius = 1.2;
  sunFar.shadow.autoUpdate = false;                      // amortised: re-rendered every 2nd frame
  sunFar.shadow.needsUpdate = true;
  let shadowsOn = shadowsOn0;
  game.events.on('quality', (qq) => {
    shadowsOn = (qq.shadows ?? 1) > 0;
    const size = Math.min(2048, qq.shadowSize || 2048);
    for (const l of [sun, sunFar]) {
      l.castShadow = shadowsOn;
      if (l.shadow.mapSize.x !== size) { l.shadow.mapSize.set(size, size); l.shadow.map?.dispose(); l.shadow.map = null; }
    }
    sunFar.shadow.needsUpdate = true;                    // re-render the far cascade on the very next frame
  });

  // --- dome -----------------------------------------------------------------------------------------------
  const atmoU = game.atmo?.uniforms || {};
  const uniforms = {
    ...atmoU,
    tNoise: { value: null },
    uTime: atmoU.atmoTime || { value: 0 },
    uCirrus: { value: 1.0 },
    uCirrusAlt: { value: 9000 },
    uWind: { value: new THREE.Vector2(0.0016, 0.0006) },
    uCloudLit: atmoU.atmoCloudLit || { value: new THREE.Color(0xfffaf0) },
    uCloudShade: atmoU.atmoCloudShade || { value: new THREE.Color(0x8a9ad4) },
    uSunCos0: { value: Math.cos(THREE.MathUtils.degToRad(0.75)) },
    uSunCos1: { value: Math.cos(THREE.MathUtils.degToRad(0.55)) },
    uSunIntensity: { value: 16 },
  };
  const material = new THREE.ShaderMaterial({
    name: 'SkyDome', uniforms, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
    side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(1000, 48, 24), material);
  dome.name = 'skyDome';
  dome.frustumCulled = false;
  dome.renderOrder = 1e6;                                 // last among opaques: early-z skips covered pixels
  dome.castShadow = dome.receiveShadow = false;
  dome.matrixAutoUpdate = false;
  dome.onBeforeRender = (r, s, camera) => {
    dome.matrixWorld.makeTranslation(camera.matrixWorld.elements[12], camera.matrixWorld.elements[13], camera.matrixWorld.elements[14]);
  };
  scene.add(dome);

  let focusOverride = null;
  let frame = 0;
  const _focus = new THREE.Vector3();

  function focusPoint(out) {
    const f = focusOverride || game.player;
    if (f) {
      if (f.isVector3) return out.copy(f);
      if (f.pos?.isVector3) return out.copy(f.pos);
      const o = f.root || f;
      if (o.isObject3D) return o.getWorldPosition(out);
    }
    const cam = game.camera;
    return out.copy(cam.position).addScaledVector(cam.getWorldDirection(_fwd), 22);
  }

  const sky = {
    name: 'sky',
    sun, sunFar, hemi, dome, material, uniforms,
    /** Near-cascade half size in metres (13 m fits the 17 m wingspan with margin). */
    nearHalf,
    setShadowFocus(target) { focusOverride = target || null; },
    async init() {
      const t0 = performance.now();
      uniforms.tNoise.value = makeNoiseTexture(256, 7);
      sky.noiseMs = performance.now() - t0;
      sky.applyPalette();
    },
    applyPalette() {
      const pal = game.atmo?.palette;
      if (!pal) return;
      const sl = pal.sunLight.value;
      const m = Math.max(sl.r, sl.g, sl.b, 1e-4);
      sun.color.setRGB(sl.r / m, sl.g / m, sl.b / m);
      sun.intensity = m;
      sunFar.color.copy(sun.color);
      hemi.color.copy(pal.hemiSky.value);
      hemi.groundColor.copy(pal.hemiGround.value);
      hemi.intensity = 1;
    },
    beforeRender(camera = game.camera) {
      frame++;
      const sd = game.atmo?.sunDir || _up.set(0, 1, 0);
      if (!shadowsOn) return;
      fitCascade(sun, focusPoint(_focus), nearHalf.value, sd, 90);
      // Amortised every 2nd frame — but never draw a frame whose far cascade has no map yet (after Low -> a preset
      // with shadows the new shadow programs would sample an unbound depth texture: GL_INVALID_OPERATION).
      const farDue = frame % 2 === 0 || !sunFar.shadow.map;
      if (farDue) {
        const titan = game.actors?.find?.((a) => a.kind === 'titan' && a.alive);
        let half;
        if (titan?.pos) { _focus.copy(titan.pos); half = clamp((titan.radius || 130) * 1.1, 90, 240); }
        else { _focus.copy(camera.position).addScaledVector(camera.getWorldDirection(_fwd), 240); half = 300; }
        fitCascade(sunFar, _focus, half, sd, half * 1.6 + 150);
        sunFar.shadow.needsUpdate = true;
      }
    },
    update() { sky.applyPalette(); },
    lateUpdate() {
      if (!game.pipeline) sky.beforeRender(game.camera);    // without the pipeline nobody else calls it
    },
  };
  return sky;
}
