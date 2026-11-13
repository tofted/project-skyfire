// game.atmo — one source of truth for sun, sky colours, haze, height fog and the anime palette.
// Every opaque material in the world goes through atmoApply() so distant things fade into the same anime haze
// the sky and clouds use. Built-in materials: game.atmo.patch(material). Custom ShaderMaterials: add
// `...game.atmo.uniforms` to uniforms, prepend game.atmo.chunk to the fragment shader, and call
// `gl_FragColor.rgb = atmoApply(gl_FragColor.rgb, vWorldPos);` (linear HDR, before any tone mapping).
//
// Presets ('afternoon' | 'storm' | 'victory') blend smoothly: game.atmo.setPreset(name, seconds). Everything that
// changes lives in shared objects that are mutated in place (uniform .value, palette, grade), so consumers keep
// their references and nothing recompiles.
//   atmo.palette  — shared uniform objects for characters and lights (toon.js, sky.js):
//                   sunLight (DirectionalLight colour × intensity), charLight (toon key light: same brightness, softer
//                   hue), shade, rim, skyUp, bounce, hemiSky, hemiGround
//   atmo.grade    — plain numbers read by the pipeline each frame (exposure, saturation, contrast, warmth, bloom,
//                   godrays, vignette, flare) + colours (shadowTint, highlightTint, raysColor)
//   atmo.uniforms — also carries atmoCloudLit / atmoCloudShade / atmoCloudDeep for the cloud renderer (not declared
//                   in the chunk, so declaring them yourself never collides)
//   Wave 4 valley mist: inside atmoApplyK (so terrain, water, vegetation, props, particles and the clouds all get it
//   with no change on their side) + atmoMistSkyT() for the sky dome. Presets carry `mist`; atmo.mistEnabled (?mist=0)
//   switches it off; uniforms atmoMist / atmoMistBase / atmoMistColor (a shader without them sees density 0 = off).
import * as THREE from 'three';
import { clamp, smoothstep } from '../core/util.js';

export const ATMO_CHUNK = /* glsl */`
uniform vec3 atmoSunDir;        // world, points toward the sun
uniform vec3 atmoSunColor;      // linear HDR
uniform vec3 atmoZenith;        // sky colour straight up
uniform vec3 atmoHorizon;       // sky colour at the horizon
uniform vec3 atmoHaze;          // aerial-perspective colour (away from the sun)
uniform vec3 atmoHazeSun;       // aerial-perspective colour toward the sun (warm)
uniform float atmoDensity;      // haze extinction per metre at sea level
uniform float atmoFalloff;      // haze height falloff (1/m)
uniform float atmoTime;
uniform vec3 atmoFarTint;       // anime layering: far things lean toward this cool tint before the haze
uniform float atmoFarDist;      // e-folding distance of that tint (m); 0 disables it
uniform float atmoSkyCurve;     // sky gradient exponent (smaller = deeper blue reaches lower); 0 = default 0.38
// Wave 4 valley mist ("morning mist" layer on the valley floor, the Sakura-valley depth): a flat-topped layer that pools
// on a plane fitted to the river / lake levels, so the low valley fills and the hills rise out of it.
uniform vec4 atmoMist;          // x density at the layer base (1/m; 0 = off, also when a shader lacks the uniform),
                                // y 1 / thickness above the base (1/m), z 1 / thickness below it, w patchiness 0..1
uniform vec4 atmoMistBase;      // base plane y = x + y·worldX + z·worldZ (m), never below w
uniform vec3 atmoMistColor;     // linear HDR in-scatter colour of the sunlit mist
// levels update: what lit SURFACES are multiplied by before the haze (terrain, water, plants, props): white by day,
// a moonlit blue at night. Fire, sparks and glows never use it — they light the night.
uniform vec3 atmoSurface;

// ∫ density dy / atmoMist.x as a function of u = height above the base (bounded both ways: numerically safe).
float atmoMistG(float u) {
  return u >= 0.0 ? 1.0 / atmoMist.z + (1.0 - exp(-atmoMist.y * u)) / atmoMist.y : exp(atmoMist.z * u) / atmoMist.z;
}
float atmoMistBaseAt(vec2 xz) { return max(atmoMistBase.x + dot(atmoMistBase.yz, xz), atmoMistBase.w); }
float atmoMistHash(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float atmoMistNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p), s = f * f * (3.0 - 2.0 * f);
  return mix(mix(atmoMistHash(i), atmoMistHash(i + vec2(1.0, 0.0)), s.x),
             mix(atmoMistHash(i + vec2(0.0, 1.0)), atmoMistHash(i + vec2(1.0, 1.0)), s.x), s.y);
}
// Optical depth of the mist from ro to p (analytic along the ray, base plane taken under p; drifting patches).
float atmoMistOD(vec3 ro, vec3 p, float dist) {
  float b = atmoMistBaseAt(p.xz);
  float u0 = ro.y - b, u1 = p.y - b;
  float um = 0.5 * (u0 + u1);
  float od = abs(u1 - u0) > 0.5 ? (atmoMistG(u1) - atmoMistG(u0)) / (u1 - u0) * dist
                                : exp(um >= 0.0 ? -atmoMist.y * um : atmoMist.z * um) * dist;
  vec2 w = p.xz + vec2(2.1, 0.8) * atmoTime;
  float nz = atmoMistNoise(w / 1150.0) * 0.62 + atmoMistNoise(w / 390.0 + 17.0) * 0.38;
  nz = smoothstep(0.18, 0.82, nz) * 1.6 + 0.2;                         // 0.2 … 1.8, mean ≈ 1
  od *= mix(1.0, nz, atmoMist.w * (1.0 - smoothstep(2500.0, 9000.0, dist)));
  // Art direction: the mist gives depth to LOW flight; from combat altitude (the painted aerial view of the
  // valley) it thins to a light veil, so the palette seen from 1–1.5 km stays as it was.
  od *= mix(1.0, 0.3, smoothstep(250.0, 1000.0, u0));
  return max(od, 0.0) * atmoMist.x;
}
// Mist in-scatter colour along rd: sunlit mist, glowing warm toward the sun (forward scattering).
vec3 atmoMistIn(vec3 rd) {
  float mu = max(dot(rd, atmoSunDir), 0.0);
  return mix(atmoMistColor, atmoHazeSun * 1.15, 0.55 * pow(mu, 5.0));
}
// Transmittance of the mist for a ray from ro to infinity (sky dome).
float atmoMistSkyT(vec3 ro, vec3 rd) {
  if (atmoMist.x <= 0.0) return 1.0;
  float u0 = ro.y - atmoMistBaseAt(ro.xz);
  float g = rd.y >= 0.0 ? (1.0 / atmoMist.z + 1.0 / atmoMist.y - atmoMistG(u0)) : atmoMistG(u0);
  return exp(-atmoMist.x * g / max(abs(rd.y), 0.02));
}

// In-scatter colour of the haze along a view direction: cool blue away from the sun, warm toward it.
vec3 atmoHazeColor(vec3 rd) {
  float mu = max(dot(rd, atmoSunDir), 0.0);
  vec3 haze = mix(atmoHaze, atmoHazeSun, pow(mu, 5.0));
  haze += atmoSunColor * (0.025 * pow(mu, 16.0) + 0.05 * pow(mu, 96.0));
  return haze;
}

// Painted anime sky gradient. The horizon band is exactly the haze colour, so terrain melts into the sky.
vec3 atmoSky(vec3 dir) {
  float h = clamp(dir.y, -1.0, 1.0);
  float up = pow(max(h, 0.0), atmoSkyCurve > 0.0 ? atmoSkyCurve : 0.38);
  vec3 sky = mix(atmoHorizon, atmoZenith, smoothstep(0.0, 1.0, up));
  float band = 1.0 - smoothstep(-0.03, 0.14, h);
  sky = mix(sky, atmoHazeColor(dir), band * 0.92);
  float mu = max(dot(dir, atmoSunDir), 0.0);
  sky += atmoSunColor * (0.016 * pow(mu, 4.0) + 0.05 * pow(mu, 40.0));
  return sky;
}

// Analytic exponential height fog integrated along the view ray (camera -> p), k scales its strength
// (characters use ~0.75 so they stay readable against the haze).
vec3 atmoApplyK(vec3 col, vec3 p, float k) {
  vec3 ro = cameraPosition;
  vec3 rd = p - ro;
  float dist = length(rd);
  rd /= max(dist, 1e-4);
  if (atmoMist.x > 0.0) {                     // valley mist first: it lies near the ground end of the ray
    float mt = exp(-atmoMistOD(ro, p, dist) * k);
    col = col * mt + atmoMistIn(rd) * (1.0 - mt);
  }
  float kf = atmoFalloff;
  float h0 = max(ro.y, 0.0);
  float dy = rd.y * dist;
  float integral = (abs(dy) > 1e-2)
    ? (exp(-kf * h0) - exp(-kf * max(h0 + dy, 0.0))) / (kf * rd.y)
    : exp(-kf * h0) * dist;
  float optical = atmoDensity * max(integral, 0.0) * k;
  float trans = exp(-optical);
  if (atmoFarDist > 0.0) {
    float ft = (1.0 - exp(-dist / atmoFarDist)) * k;
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(col, mix(vec3(l), col, 0.6) * atmoFarTint, ft * 0.5);
  }
  return col * trans + atmoHazeColor(rd) * (1.0 - trans);
}
vec3 atmoApply(vec3 col, vec3 p) { return atmoApplyK(col, p, 1.0); }
`;

const lin = (hex) => new THREE.Color(hex);          // THREE.Color(hex) converts sRGB hex to linear (ColorManagement)
const dirFrom = (elevDeg, azimDeg) => {
  const e = THREE.MathUtils.degToRad(elevDeg), a = THREE.MathUtils.degToRad(azimDeg);
  return new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
};

// Base plane of the valley mist: least-squares fit to the river and lake levels inside the painted map (world.json,
// 298 points: y = 88 − 0.0013·x − 0.0038·z, residuals −4 … +23 m) plus 12 m, so the layer is thickest just above the
// water and fields; never below 45 m (the sea at y = 0 only gets its thin lower tail).
const MIST_BASE = { y0: 100, dx: -0.0013, dz: -0.0038, min: 45 };

// Keyframes. Colours are sRGB hex (converted to linear). sunLight = colour × intensity of the DirectionalLight;
// toon materials show a white surface at sunLight / π (so intensity 3 ≈ 0.95).
const AZIMUTH = -144.9;                              // afternoon sun behind-left of the start heading (+Z forward)
export const PRESETS = {
  afternoon: {
    // Wave 2 look pass vs the key art (assets/textures/keyart.jpg): deep azure zenith reaching lower (skyCurve),
    // cyan-leaning horizon / haze (key art #9ecde3, far hills #afccd7), cloud shadows blue instead of lavender
    // (#8a9ad4 -> #96b6d4, key art #95b3c4), grade shadows and vignette blue instead of violet.
    sunDir: dirFrom(38.4, AZIMUTH), sunColor: [0xfff6ec, 3.3],
    zenith: 0x1249a0, horizon: 0xa2cfe8, haze: 0xa8cce4, hazeSun: 0xf3e2c4, skyCurve: 0.3,
    density: 0.00012, falloff: 1 / 2200, farTint: 0xb4d4ea, farDist: 7000,
    sunLight: [0xfff6ea, 3.0], shade: 0xb8bde8, rim: 0xfff2dc, skyUp: 0x243a70, bounce: 0x3a3428,
    hemiSky: [0xa8c8f0, 1.15], hemiGround: 0x7a7458,
    cloudLit: 0xfffaf0, cloudShade: 0x96b6d4, cloudDeep: 0x7896c2,
    // Wave 4 valley mist: pale sunlit morning mist pooled on the valley floor (key art: river valley in soft haze).
    mist: { density: 0.001, above: 70, below: 60, noise: 0.7, color: 0xdfe8ec },
    grade: { exposure: 1.0, saturation: 1.14, contrast: 1.04, warmth: 0.0, bloom: 0.75, godrays: 0.6, vignette: 0.3,
      flare: 0.55, shadowTint: 0x22407a, shadowAmt: 0.07, highlightTint: 0xfffcf6, raysColor: 0xfff2dc,
      vignetteTint: [0.8, 0.86, 0.94] },
  },
  storm: {
    // Wave 2: slate / steel blue instead of bruised violet-mauve (the titan fight read purple); warm sun kept.
    sunDir: dirFrom(21, AZIMUTH + 18), sunColor: [0xffb870, 3.8],
    zenith: 0x1c2c4c, horizon: 0x7f8a9c, haze: 0x6a7488, hazeSun: 0xf2a862,
    density: 0.00018, falloff: 1 / 2400, farTint: 0x8e9ab0, farDist: 5000,
    sunLight: [0xffcf94, 2.7], shade: 0x9098b8, rim: 0xffb676, skyUp: 0x1a2238, bounce: 0x3e2a26,
    hemiSky: [0x6a7896, 1.0], hemiGround: 0x4a3c34,
    cloudLit: 0xf6dcc0, cloudShade: 0x66728e, cloudDeep: 0x434c68,
    mist: { density: 0.0012, above: 85, below: 60, noise: 0.6, color: 0x7e8798 },
    grade: { exposure: 0.96, saturation: 1.04, contrast: 1.16, warmth: 0.08, bloom: 0.95, godrays: 1.15, vignette: 0.45,
      flare: 0.75, shadowTint: 0x1e2c56, shadowAmt: 0.1, highlightTint: 0xffeed8, raysColor: 0xffc070,
      vignetteTint: [0.74, 0.77, 0.86] },
  },
  victory: {
    // Wave 2: golden hour with a bluer upper sky and blue (not violet) cloud shadows; peach-gold horizon kept.
    sunDir: dirFrom(9, AZIMUTH + 8), sunColor: [0xffc88a, 3.2],
    zenith: 0x2a5cb4, horizon: 0xffd2a0, haze: 0xbfc4d6, hazeSun: 0xffcf98, skyCurve: 0.3,
    density: 0.00013, falloff: 1 / 2000, farTint: 0xcfd0e0, farDist: 7000,
    sunLight: [0xffd6a6, 2.85], shade: 0xa8a0d0, rim: 0xffc98a, skyUp: 0x1c2448, bounce: 0x4a3428,
    hemiSky: [0xa8b0e0, 1.05], hemiGround: 0x7a5c44,
    cloudLit: 0xfff0d8, cloudShade: 0xa0a8cc, cloudDeep: 0x7e88b4,
    mist: { density: 0.0022, above: 90, below: 60, noise: 0.7, color: 0xf4d8bc },
    grade: { exposure: 1.02, saturation: 1.12, contrast: 1.05, warmth: 0.12, bloom: 0.9, godrays: 0.85, vignette: 0.32,
      flare: 0.8, shadowTint: 0x2a3470, shadowAmt: 0.08, highlightTint: 0xfff0dc, raysColor: 0xffd49a,
      vignetteTint: [0.8, 0.82, 0.92] },
  },
  // ---- levels update: the day runs out over the story's late waves (director.js WAVES.sky) -----------------------
  // golden (wave 3): a low warm sun, peach horizon, long light. `stars` / `aurora` (0..1) are the sky dome's night
  // layers (world/sky.js); a preset without them has none.
  golden: {
    sunDir: dirFrom(15, AZIMUTH + 6), sunColor: [0xffc27a, 3.4],
    zenith: 0x1f4fa6, horizon: 0xffc890, haze: 0xc8bfc8, hazeSun: 0xffc27e, skyCurve: 0.3,
    density: 0.00013, falloff: 1 / 2100, farTint: 0xd4c8d0, farDist: 7000,
    sunLight: [0xffd09a, 2.95], shade: 0xb0a4d4, rim: 0xffc27e, skyUp: 0x20306a, bounce: 0x4a3626,
    hemiSky: [0xb0b8e4, 1.08], hemiGround: 0x7c6046,
    cloudLit: 0xffeacc, cloudShade: 0xa6a6cc, cloudDeep: 0x7f84b4,
    mist: { density: 0.0016, above: 80, below: 60, noise: 0.7, color: 0xf2d6b6 },
    grade: { exposure: 1.02, saturation: 1.16, contrast: 1.06, warmth: 0.14, bloom: 0.9, godrays: 0.95, vignette: 0.32,
      flare: 0.8, shadowTint: 0x2a3272, shadowAmt: 0.08, highlightTint: 0xffeeda, raysColor: 0xffcf8e,
      vignetteTint: [0.8, 0.8, 0.92] },
  },
  // dusk (wave 4): the sun on the horizon, a rose and violet twilight, the first stars.
  dusk: {
    sunDir: dirFrom(4.5, AZIMUTH + 10), sunColor: [0xff8a5c, 3.0],
    zenith: 0x1a2a7a, horizon: 0xff9a8a, haze: 0x9a88b8, hazeSun: 0xff9a6a, skyCurve: 0.34,
    density: 0.00014, falloff: 1 / 2100, farTint: 0xb09cc8, farDist: 6500,
    sunLight: [0xffb08c, 2.65], shade: 0x9c90cc, rim: 0xff9e80, skyUp: 0x1c2460, bounce: 0x4a2c34,
    hemiSky: [0x9c94dc, 1.05], hemiGround: 0x6a4c50,
    cloudLit: 0xffcdb8, cloudShade: 0x8a80c0, cloudDeep: 0x5c5a9c,
    mist: { density: 0.0016, above: 85, below: 60, noise: 0.7, color: 0xd8a8b4 },
    grade: { exposure: 1.04, saturation: 1.18, contrast: 1.08, warmth: 0.08, bloom: 1.0, godrays: 1.0, vignette: 0.36,
      flare: 0.85, shadowTint: 0x2a2470, shadowAmt: 0.1, highlightTint: 0xffe6dc, raysColor: 0xff9e78,
      vignetteTint: [0.76, 0.74, 0.9] },
    stars: 0.35, surface: [0.94, 0.86, 0.93],
  },
  // night (wave 5): an anime night — a bright moon where the sun went down, deep blue sky, a full star field. The
  // "sun" is the moon here (the same light, disc and shadows); it is kept bright so the fight stays readable.
  night: {
    sunDir: dirFrom(36, AZIMUTH + 14), sunColor: [0xcfe0ff, 1.25],
    zenith: 0x060f38, horizon: 0x2c4a8c, haze: 0x243a70, hazeSun: 0x4a6ab0, skyCurve: 0.42,
    density: 0.00011, falloff: 1 / 2300, farTint: 0x3a5088, farDist: 6500,
    sunLight: [0xa8c0ff, 1.75], charSat: 0.3, shade: 0x7c8cd0, rim: 0xcfe4ff, skyUp: 0x16286a, bounce: 0x1c2444,
    hemiSky: [0x5878c8, 0.9], hemiGround: 0x2c3658,
    cloudLit: 0x8ea2da, cloudShade: 0x6276b6, cloudDeep: 0x485896,
    mist: { density: 0.0012, above: 80, below: 60, noise: 0.7, color: 0x5a74b0 },
    grade: { exposure: 1.06, saturation: 1.12, contrast: 1.06, warmth: -0.1, bloom: 1.15, godrays: 0.5, vignette: 0.4,
      flare: 0.45, shadowTint: 0x101a56, shadowAmt: 0.12, highlightTint: 0xe8f0ff, raysColor: 0xbcd4ff,
      vignetteTint: [0.7, 0.74, 0.9] },
    stars: 1, aurora: 0.2, surface: [0.44, 0.52, 0.8],
  },
  // aurora (wave 6, deep survival): the same night under a full aurora — its green light in the ambient and the rims.
  aurora: {
    sunDir: dirFrom(40, AZIMUTH + 16), sunColor: [0xcfe6ff, 1.2],
    zenith: 0x050c30, horizon: 0x24508a, haze: 0x1f3c6c, hazeSun: 0x3f7aa8, skyCurve: 0.42,
    density: 0.00011, falloff: 1 / 2300, farTint: 0x34588a, farDist: 6500,
    sunLight: [0xa8c8ff, 1.75], charSat: 0.3, shade: 0x7494cc, rim: 0xa8ffe0, skyUp: 0x143068, bounce: 0x183040,
    hemiSky: [0x5c9cc4, 0.95], hemiGround: 0x284858,
    cloudLit: 0x88b8c4, cloudShade: 0x5c80ac, cloudDeep: 0x42608c,
    mist: { density: 0.0012, above: 80, below: 60, noise: 0.7, color: 0x5a8cae },
    grade: { exposure: 1.08, saturation: 1.18, contrast: 1.06, warmth: -0.12, bloom: 1.25, godrays: 0.5, vignette: 0.4,
      flare: 0.45, shadowTint: 0x0c2450, shadowAmt: 0.12, highlightTint: 0xe6fff4, raysColor: 0xbcf0e0,
      vignetteTint: [0.68, 0.76, 0.88] },
    stars: 1, aurora: 1, surface: [0.4, 0.56, 0.76],
  },
};

// Characters keep their albedo identity under coloured light (anime): same brightness, part of the hue.
function charLight(sun, sat) {
  const l = sun.r * 0.2126 + sun.g * 0.7152 + sun.b * 0.0722;
  return new THREE.Color(l, l, l).lerp(sun, sat);
}

// Flattened, linear numeric state that can be interpolated.
function resolve(p) {
  const c = (hex, k = 1) => lin(hex).multiplyScalar(k);
  const pair = (v) => (Array.isArray(v) ? c(v[0], v[1]) : c(v));
  return {
    sunDir: p.sunDir.clone().normalize(), sunColor: pair(p.sunColor),
    zenith: c(p.zenith), horizon: c(p.horizon), haze: c(p.haze), hazeSun: c(p.hazeSun),
    density: p.density, falloff: p.falloff, farTint: c(p.farTint), farDist: p.farDist, skyCurve: p.skyCurve ?? 0.38,
    sunLight: pair(p.sunLight), charLight: charLight(pair(p.sunLight), p.charSat ?? 0.45), shade: c(p.shade), rim: c(p.rim), skyUp: c(p.skyUp), bounce: c(p.bounce),
    hemiSky: pair(p.hemiSky), hemiGround: c(p.hemiGround),
    cloudLit: c(p.cloudLit), cloudShade: c(p.cloudShade), cloudDeep: c(p.cloudDeep),
    mistDensity: p.mist?.density ?? 0, mistAbove: p.mist?.above ?? 70, mistBelow: p.mist?.below ?? 60,
    mistNoise: p.mist?.noise ?? 0, mistColor: c(p.mist?.color ?? 0xdde8ee),
    stars: p.stars ?? 0, aurora: p.aurora ?? 0,          // levels update: the sky dome's night layers (0..1)
    surface: new THREE.Color().setRGB(...(p.surface || [1, 1, 1])),   // raw multiplier of lit surfaces (atmoSurface)
    grade: {
      ...p.grade,
      shadowTint: c(p.grade.shadowTint), highlightTint: c(p.grade.highlightTint), raysColor: c(p.grade.raysColor),
      // display-space multiplier at the frame edge (raw numbers, not colour-managed)
      vignetteTint: new THREE.Color().setRGB(...(p.grade.vignetteTint || [0.78, 0.8, 0.92])),
    },
  };
}

function copyState(dst, src) {
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (v && v.isColor) dst[k].copy(v);
    else if (v && v.isVector3) dst[k].copy(v);
    else if (k === 'grade') copyState(dst.grade, v);
    else dst[k] = v;
  }
}

function lerpState(dst, a, b, t) {
  for (const k of Object.keys(b)) {
    const va = a[k], vb = b[k];
    if (vb && vb.isColor) dst[k].copy(va).lerp(vb, t);
    else if (vb && vb.isVector3) dst[k].copy(va).lerp(vb, t).normalize();
    else if (k === 'grade') lerpState(dst.grade, va, vb, t);
    else if (typeof vb === 'number') dst[k] = va + (vb - va) * t;
  }
}

function cloneState(s) {
  const out = {};
  for (const k of Object.keys(s)) {
    const v = s[k];
    out[k] = v && (v.isColor || v.isVector3) ? v.clone() : k === 'grade' ? cloneState(v) : v;
  }
  return out;
}

export default function createAtmosphere(game) {
  const cur = resolve(PRESETS.afternoon);
  const sunDir = cur.sunDir;                                       // the shared Vector3 others hold on to
  const uniforms = {
    atmoSunDir: { value: sunDir },
    atmoSunColor: { value: cur.sunColor },
    atmoZenith: { value: cur.zenith },
    atmoHorizon: { value: cur.horizon },
    atmoHaze: { value: cur.haze },
    atmoHazeSun: { value: cur.hazeSun },
    atmoDensity: { value: cur.density },
    atmoFalloff: { value: cur.falloff },
    atmoTime: { value: 0 },
    atmoFarTint: { value: cur.farTint },
    atmoFarDist: { value: cur.farDist },
    atmoSkyCurve: { value: cur.skyCurve },
    // for the cloud renderer (not declared in ATMO_CHUNK)
    atmoCloudLit: { value: cur.cloudLit },
    atmoCloudShade: { value: cur.cloudShade },
    atmoCloudDeep: { value: cur.cloudDeep },
    // wave 4 valley mist (declared in the chunk; x = 0 switches it off)
    atmoMist: { value: new THREE.Vector4(cur.mistDensity, 1 / cur.mistAbove, 1 / cur.mistBelow, cur.mistNoise) },
    atmoMistBase: { value: new THREE.Vector4(MIST_BASE.y0, MIST_BASE.dx, MIST_BASE.dz, MIST_BASE.min) },
    atmoMistColor: { value: cur.mistColor },
    // levels update: the night layers of the sky dome (declared by world/sky.js, not in the chunk)
    atmoStars: { value: cur.stars }, atmoAurora: { value: cur.aurora },
    atmoSurface: { value: cur.surface },
  };
  const palette = {
    sunLight: { value: cur.sunLight },          // DirectionalLight colour × intensity
    charLight: { value: cur.charLight },        // key light for game.toon characters (sun brightness, softer hue)
    shade: { value: cur.shade },                // character shadow tint (multiplies albedo)
    rim: { value: cur.rim },
    skyUp: { value: cur.skyUp },                // flat ambient from above (characters)
    bounce: { value: cur.bounce },              // bounce from below (characters)
    hemiSky: { value: cur.hemiSky },            // HemisphereLight for built-in materials (colour × intensity)
    hemiGround: { value: cur.hemiGround },
  };
  const grade = cur.grade;                      // mutated in place

  let from = null, to = null, t = 0, dur = 0, presetName = 'afternoon';

  const atmo = {
    name: 'atmo',
    /** Valley mist on/off (A/B: ?mist=0, or Digit9 with ?debug — pipeline.js). */
    mistEnabled: game.params?.get?.('mist') !== '0',
    sunDir,
    uniforms,
    chunk: ATMO_CHUNK,
    palette,
    grade,
    presets: Object.keys(PRESETS),
    get preset() { return presetName; },
    /** levels update: how much of the night is up (0 day … 1 full star field) and the aurora's strength (0..1). */
    get night() { return cur.stars; },
    get aurora() { return cur.aurora; },
    /** Blend to a preset over `seconds` (0 = instant). Unknown names are ignored. */
    setPreset(name, seconds = 3) {
      const p = PRESETS[name];
      if (!p) { console.warn(`[atmo] unknown preset ${name}`); return; }
      presetName = name;
      from = cloneState(cur);
      to = resolve(p);
      t = 0; dur = Math.max(0, seconds);
      if (dur === 0) { copyState(cur, to); from = to = null; }
      game.events.emit('atmo:preset', { name, seconds: dur });
    },
    /** Blend factor of the running transition (1 when idle). */
    get transition() { return to ? clamp(t / dur, 0, 1) : 1; },
    /** Sun elevation (radians) — handy for lights and audio. */
    get sunElevation() { return Math.asin(clamp(sunDir.y, -1, 1)); },
    /** Inject haze into a built-in material (MeshStandard/Lambert/Toon/Basic…). Safe to call twice.
     *  material.userData.atmoStrength (0..1, default 1) scales the haze, e.g. 0.75 for characters. */
    patch(material) {
      if (material.userData.atmoPatched) return material;
      material.userData.atmoPatched = true;
      const prev = material.onBeforeCompile;
      material.onBeforeCompile = (shader, renderer) => {
        prev?.call(material, shader, renderer);
        Object.assign(shader.uniforms, uniforms);
        const k = material.userData.atmoStrength ?? 1;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vAtmoWorld;')
          .replace('#include <project_vertex>', '#include <project_vertex>\nvAtmoWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\n#ifdef USE_INSTANCING\nvAtmoWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;\n#endif\n#ifdef USE_BATCHING\nvAtmoWorld = (modelMatrix * batchingMatrix * vec4(transformed, 1.0)).xyz;\n#endif');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vAtmoWorld;\n' + ATMO_CHUNK)
          .replace('#include <opaque_fragment>', `#include <opaque_fragment>\ngl_FragColor.rgb = atmoApplyK(gl_FragColor.rgb * atmoSurface, vAtmoWorld, ${Number(k).toFixed(3)});`);
      };
      material.customProgramCacheKey = () => (material.userData.cacheKey || '') + '|atmo' + (material.userData.atmoStrength ?? 1);
      material.needsUpdate = true;
      return material;
    },
    update(dt, realDt) {
      uniforms.atmoTime.value += dt;
      if (to) {
        t += realDt;                                 // real time: transitions also run in victory/defeat screens
        const w = smoothstep(0, 1, t / dur);
        lerpState(cur, from, to, w);
        if (t >= dur) { copyState(cur, to); from = to = null; }
      }
      uniforms.atmoDensity.value = cur.density;
      uniforms.atmoFalloff.value = cur.falloff;
      uniforms.atmoFarDist.value = cur.farDist;
      uniforms.atmoSkyCurve.value = cur.skyCurve;
      uniforms.atmoStars.value = cur.stars; uniforms.atmoAurora.value = cur.aurora;
      uniforms.atmoMist.value.set(atmo.mistEnabled ? cur.mistDensity : 0, 1 / Math.max(1, cur.mistAbove),
        1 / Math.max(1, cur.mistBelow), cur.mistNoise);
    },
  };
  // URL override for reviews: ?preset=storm
  const q = game.params?.get?.('preset');
  if (q && PRESETS[q]) atmo.setPreset(q, 0);
  return atmo;
}
