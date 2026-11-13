// game.clouds — genuinely 3D, anime-styled volumetric clouds (towering cumulus + broken deck + far layer).
// Pipeline per frame (called by game.pipeline after the opaque scene):
//   march (cloudScale res, blue-noise jitter, stops at scene depth) -> cloud G-buffer (sun visibility, lobe N.L,
//   crease, alpha, front distance) -> temporal reprojection + stepped anime ramp + aerial perspective -> output.
// Public API (docs/ARCHITECTURE.md, "Clouds <-> pipeline"; details in docs/modules/clouds.md):
//   render({ renderer, camera, depthTexture, width, height, frame, realDt, alphaSharpen? })
//     -> { texture, depthTexture, scale, width, height, alphaSharpen: { lo, hi, soft } }   (same object every frame)
//     depthTexture: r = front distance (m, 0 = no cloud), g = march limit (m), b = alpha as output, a = sharpen amount
//     soft = true when the pipeline declared full-res sharpening (ctx.alphaSharpen / game.pipeline.cloudAlphaSharpen):
//     then alpha is soft and the pipeline applies a2 = mix(a, smoothstep(lo, hi, a), depth.a), rgb *= a2 / a.
//   shadow = { texture, matrix, uniforms, chunk }      top-down sun transmittance for terrain / water
//   towers  read-only [{ x, z, base, top, radius, far, anvil, lean }]
//   addDisplacer({ pos, radius, strength }) -> handle { pos, radius, strength, remove() }
//   setWeather({ coverage, darkness, wind }, seconds)
//   density(x, y, z) == game.world.cloudDensity(x, y, z)  (CPU twin, 0..1)
//   wind(pos, out) == game.world.wind(pos, out)           (air motion in m/s, see clouds/wind.js)
// Wave 5 (read, not called by others): game.titan.actor.shapes cast the titan's shadow on the clouds; game.actors
//   dragons within ~230 m keep a silhouette inside clouds (view transmittance floor); displacer holes have a ragged
//   edge. Test helper visibilityOf(pos, radius) -> share of an object the cloud in front leaves visible.
import * as THREE from 'three';
import { clamp, damp, lerp } from '../core/util.js';
import { buildLayout, FIELD, WEATHER, DECK, NOISE, towerSdf, sampleWeather, deckInside } from './clouds/layout.js';
import { QUAD_VS, CLOUD_COMMON, MARCH_FS, RESOLVE_FS, SHADOW_FS, PROBE_FS } from './clouds/shaders.js';
import { makeQuad, bakeNoise, bakeField, readNoise } from './clouds/bake.js';
import { createWind } from './clouds/wind.js';

const HALTON = [];
for (let i = 1; i <= 8; i++) {
  const h = (b, n) => { let f = 1, r = 0; while (n > 0) { f /= b; r += f * (n % b); n = Math.floor(n / b); } return r; };
  HALTON.push([h(2, i) - 0.5, h(3, i) - 0.5]);
}
const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const smooth01 = (x) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };

export default function createClouds(game) {
  const renderer = game.renderer;
  const layout = buildLayout(7);
  const { towers, weather } = layout;

  // Tuning knobs (read every frame; safe to change live from the console: __skyfire.clouds.params).
  const params = {
    ext: 0.05, extLight: 0.014, lightStep0: 26, minStep: 6, stepK: 0.012, maxDist: 60000,
    edge: NOISE.edge, shapeAmp: NOISE.shapeAmp, detailAmp: NOISE.detailAmp, bias: NOISE.bias, detailFar: 6000,
    blend: 0.12,
    upsample: 'auto',            // 1 = march every cloud pixel; 2 = one per 2x2 block per frame; 'auto' by buffer size
    interior: 0.3,
    // Wave 4: interior pockets / cores (0 = uniform interior), distance over which the cloud thins toward the camera
    // (keeps the own dragon >= ~85 % visible), near-field puffs, far-tower billow growth, soft-shadow sharpness.
    pocket: 0.85, nearThin: 45, nearAmp: NOISE.nearAmp, nearTile: NOISE.nearTile, nearFar: NOISE.nearFar,
    farGrow: NOISE.farGrow, shadowSoft: 2.2, shadowSteps: 8,    // soft SDF sun shadow from the first hit (steps, 1..12)
    // Shading-normal gradient step: normalK m per metre of distance, at least normalMin m (screen-size-stable puffs).
    normalK: 0.012, normalMin: 16,
    // Close-range bump: gain of the fine / near billows in the shading normal (1 = off), fading out by closeRange m.
    closeBump: 2.0, closeRange: 900,
    // CPU twin: density = smoothstep(-rampOut, rampIn, metres inside the surface) (wave 3: 0..1 over 36 m inside).
    rampOut: 50, rampIn: 70,
    // Bands (wave 4): thresholds on a smooth light amount (big shadow x lobe terminator), lower and softer so
    // front-lit cumulus read as sunlit with blue-grey undersides and creases, not noise patches.
    // Blended in log space (perceptual), so the whole ramp between the band centres reads as a soft painted gradient.
    band1: 0.18, band2: 0.48, bandSoft: 0.13, lobeW: 0.9, crease: 0.22, rim: 1.0,
    // Painted top light (lift of the sun toward the zenith: base + extra in front light), haze strength on clouds,
    // sky-lit crowns inside the shadow band.
    paintUp: 0.35, paintFront: 0.8, haze: 0.65, shadowForm: 0.4,
    puffSmall: 0.5, puffFine: 0.35,  // small puffs in the shading normal (0 = bulge scale only, as in wave 1)
    creaseGain: 1.4, creaseK: 0.03,  // crease occlusion: gain, tap radius per metre of distance (clamped 40–420 m)
    deckTrough: 0.75,                // troughs between deck domes as creases (0 = off)
    sharpNear: 0.6, sharpFar: 0.85, sharpLo: 0.1, sharpHi: 0.62,
    // 'auto': soft alpha + per-texel sharpen amount when the pipeline says it sharpens at full resolution
    // (ctx.alphaSharpen === true or game.pipeline.cloudAlphaSharpen === true), else sharpened here (old path).
    softAlpha: 'auto',
    // lit / shadow / deep come from game.atmo (atmoCloudLit / Shade / Deep) when it publishes them; these are the
    // fallbacks (key-art values). mid, bounce, warm and fog are always derived from lit / shadow / deep.
    colors: { lit: 0xfff8ec, shadow: 0x9cb8d6, deep: 0x7f9cc4, rim: 0xfff2d8 },
    // Warmth added to the lit band: the tone map's highlight shoulder desaturates, the key-art tops are cream.
    litWarm: 0xfff0dc,
    // Multipliers of the sun luminance (~3.1 in the afternoon), calibrated against the pipeline's 'hybrid' tone map
    // so the bands land on the key-art colours on screen (lit ≈ #ede7dd, mid ≈ #c6ccd8, shadow ≈ the shade hex).
    gains: { lit: 1.4, warm: 1.45, mid: 0.3, shadow: 0.36, deep: 0.3, bounce: 0.34, rim: 1.1, fog: 0.42 },
    shadowSize: 512, shadowExtent: 24000, shadowExt: 0.004, shadowEvery: 4,   // refresh 1/N of the rows per frame (whole map on re-centre)
    followAtmo: true,            // take lit / shade / deep from game.atmo presets when it publishes them
    // Wave 5. Titan shadow on the clouds: its hit capsules (game.titan.actor.shapes) occlude the sun at the first hit
    // (0 = off); radius scale of the capsules; penumbra half-width = soft0 m + softK m per m toward the sun.
    titanShadow: 1, titanScale: 1.1, titanSoft0: 1.5, titanSoftK: 0.008,
    // Ragged displacer / punch holes: radius varies by ±holeRag × the hole-sized billows (0 = wave-4 smooth bowl),
    // lumpy piled-up rim (holeLumps 0..1), billow tile = holeLobe × the hole's initial radius.
    holeRag: 0.6, holeLumps: 0.8, holeLobe: 3.0,
    // Dragons keep a silhouette inside clouds (gameplay #8: Sora >= 80 %, others >= 60 % within ~150 m): view
    // transmittance floor in front of a dragon — own (team 'player') silOwn, others silEnemy, 5 points above the
    // request so silhouette-edge texels stay above it — full within silNear m of the camera, fading to 0 by silFar m;
    // the sphere tested is radius × silPad + 2 m. silhouette 0 = off.
    silhouette: 1, silOwn: 0.85, silEnemy: 0.65, silNear: 150, silFar: 230, silPad: 1.6,
    debug: 0,
  };

  // Weather (tweened by setWeather).
  const wx = { coverage: DECK.coverage, darkness: 0, wind: new THREE.Vector3(6, 0, 1.5) };
  let tween = null;
  const windOffset = new THREE.Vector3();
  let time = 0;

  // Read-only tower list for other systems (fx birds circle them, AI can use them as cover).
  //   radius: solid body radius at mid height (m); top: highest lobe; lean: horizontal metres per metre of height.
  const towerList = Object.freeze(towers.map((t) => {
    const H = t.max[1] - t.base;
    let r = 0, n = 0;
    for (const s of t.spheres) {
      if (s[1] < t.base + H * 0.25 || s[1] > t.base + H * 0.7) continue;
      const ax = t.x + (t.lean?.x ?? 0) * (s[1] - t.base), az = t.z + (t.lean?.z ?? 0) * (s[1] - t.base);
      const d = Math.hypot(s[0] - ax, s[2] - az);
      if (d > t.radius * 1.6) continue;
      r = Math.max(r, d + s[3]); n++;
    }
    return Object.freeze({
      x: t.x, z: t.z, base: t.base, top: t.max[1], radius: Math.round((n ? r * 0.85 : t.radius)),
      far: !!t.far, anvil: !!t.anvil, lean: Object.freeze({ x: t.lean?.x ?? 0, z: t.lean?.z ?? 0 }),
    });
  }));

  // Displacers.
  const displacers = new Set();
  const dispU = { pos: Array.from({ length: 8 }, () => new THREE.Vector4()), k: new Float32Array(8), s: new Float32Array(8) };
  // Wave 5: titan occluder capsules (sun shadow on the clouds) and dragon silhouette spheres.
  const MAX_OCC = 40;
  const occU = { a: Array.from({ length: MAX_OCC }, () => new THREE.Vector4()), b: Array.from({ length: MAX_OCC }, () => new THREE.Vector4()) };
  const silU = { s: Array.from({ length: 8 }, () => new THREE.Vector4()), t: new Float32Array(8) };

  // Shared uniforms (one object per uniform; every material spreads the same references).
  const atmoU = game.atmo?.uniforms || {};
  const sunDir = game.atmo?.sunDir || new THREE.Vector3(-0.45, 0.62, -0.64).normalize();

  // Air motion consistent with the clouds (breeze along the drift, thermals, tower updrafts / wall downdrafts, bumps
  // inside clouds). game.world.wind(pos, out) -> out (m/s, world). Simulation time, so it freezes with the game.
  const air = createWind(layout, { now: () => game.time?.now ?? time, weather: wx, sunDir });
  const common = {
    uField: { value: null }, uWeather: { value: null }, uShape: { value: null }, uDetail: { value: null },
    uFieldMap: { value: new THREE.Vector4(FIELD.L, FIELD.S, FIELD.yMin, FIELD.yMax) },
    uWeatherMap: { value: new THREE.Vector2(WEATHER.L, WEATHER.S) },
    uDeck: { value: new THREE.Vector4(DECK.base, DECK.thick, DECK.coverage, DECK.topMax) },
    uDeckBaseVar: { value: DECK.baseVar },
    uNoise: { value: new THREE.Vector4(NOISE.shapeAmp, NOISE.detailAmp, NOISE.edge, NOISE.shapeTile) },
    uNoise2: { value: new THREE.Vector4(NOISE.detailTile, 0, 6000, NOISE.bias) },
    uNoise3: { value: new THREE.Vector4(NOISE.nearAmp, NOISE.nearTile, NOISE.nearFar, NOISE.farGrow) },
    uWindOffset: { value: windOffset },
    uTowerGrow: { value: 0 },
    uDisp: { value: dispU.pos }, uDispK: { value: dispU.k }, uDispS: { value: dispU.s }, uDispN: { value: 0 },
    uDispRag: { value: new THREE.Vector4(0.6, 0.8, 3, 0) },
    uSunDir: { value: sunDir },
  };
  const silCommon = { uSil: { value: silU.s }, uSilT: { value: silU.t }, uSilN: { value: 0 } };

  // Weather map texture (CPU-built, shared with the CPU twin byte for byte).
  const weatherTex = new THREE.DataTexture(weather.data, weather.n, weather.n, THREE.RGBAFormat, THREE.UnsignedByteType);
  weatherTex.minFilter = weatherTex.magFilter = THREE.LinearFilter;
  weatherTex.wrapS = weatherTex.wrapT = THREE.ClampToEdgeWrapping;
  weatherTex.generateMipmaps = false;
  weatherTex.needsUpdate = true;
  common.uWeather.value = weatherTex;

  const quad = makeQuad();
  const mat = (fs, uniforms, glsl3 = true) => new THREE.ShaderMaterial({
    glslVersion: glsl3 ? THREE.GLSL3 : null, vertexShader: QUAD_VS, fragmentShader: fs,
    uniforms, depthTest: false, depthWrite: false, toneMapped: false,
  });

  const marchU = {
    ...common,
    uDepth: { value: null }, uHasDepth: { value: 0 }, uDepthSize: { value: new THREE.Vector2(1, 1) },
    uProjInv: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
    uCamPos: { value: new THREE.Vector3() }, uNearFar: { value: new THREE.Vector2(0.5, 60000) },
    uRes: { value: new THREE.Vector2(1, 1) }, uJitter: { value: new THREE.Vector2() }, uFrame: { value: 0 },
    uOffset: { value: new THREE.Vector2() }, uUp: { value: 1 }, uInterior: { value: new THREE.Vector4(0.3, 0, 0.85, 45) },
    uMarch: { value: new THREE.Vector4(80, 6, 60000, 0.012) },
    uLight: { value: new THREE.Vector4(0.05, 0.014, 26, 6) },
    uPuff: { value: new THREE.Vector4(1, 1, 1.15, 0.04) }, uPuff2: { value: new THREE.Vector4(0.6, 2.2, 0.03, 16) }, uPuff3: { value: new THREE.Vector4(2.0, 900, 8, 0) },
    uOccA: { value: occU.a }, uOccB: { value: occU.b }, uOccN: { value: 0 }, uOccBound: { value: new THREE.Vector4() },
    uOccSoft: { value: new THREE.Vector2(1.5, 0.008) },
    ...silCommon,
  };
  const marchMat = mat(CLOUD_COMMON + MARCH_FS, marchU);

  // r186: Color(hex) takes sRGB hex and stores linear (ColorManagement). Cached: updateLook runs every frame.
  const cCache = new Map();
  const C = (hex) => { let c = cCache.get(hex); if (!c) { c = new THREE.Color(hex); cCache.set(hex, c); } return c; };
  const _tint = new THREE.Color(), _sunFallback = new THREE.Color(3.2, 3.0, 2.56);
  const _lit = new THREE.Color(), _sh = new THREE.Color(), _dp = new THREE.Color(), _d = new THREE.Color(), _mid = new THREE.Color();
  const PAL = ['lit', 'warm', 'mid', 'shadow', 'deep', 'bounce', 'rim', 'fog'];
  const pal = {};
  for (const k of PAL) pal[k] = new THREE.Vector3();
  const resolveU = {
    ...atmoU,
    uCurA: { value: null }, uCurB: { value: null }, uHistA: { value: null }, uHistB: { value: null },
    uPrevViewProj: { value: new THREE.Matrix4() }, uProjInv: marchU.uProjInv, uCamWorld: marchU.uCamWorld,
    uCloudCamPos: marchU.uCamPos, uRes: marchU.uRes, uBlend: { value: 0.12 }, uReset: { value: 1 },
    uLowRes: { value: new THREE.Vector2(1, 1) }, uOffset: marchU.uOffset, uUp: marchU.uUp,
    uSunDir: common.uSunDir,
    uLit: { value: pal.lit }, uWarm: { value: pal.warm }, uMid: { value: pal.mid }, uShadow: { value: pal.shadow },
    uDeep: { value: pal.deep }, uBounce: { value: pal.bounce }, uRim: { value: pal.rim }, uFog: { value: pal.fog },
    uBands: { value: new THREE.Vector4() }, uLook: { value: new THREE.Vector4() }, uSharp: { value: new THREE.Vector2() },
    uPaint: { value: new THREE.Vector4() },
    uSharpLoHi: { value: new THREE.Vector2(0.1, 0.62) }, uSoftAlpha: { value: 0 },
    uDebug: { value: 0 },
    ...silCommon,
  };
  const atmoChunk = (game.atmo?.chunk || FALLBACK_ATMO).replace(/cameraPosition/g, 'uCloudCamPos');
  const resolveMat = mat(RESOLVE_FS.replace('ATMO_CHUNK', atmoChunk), resolveU);
  if (!game.atmo) Object.assign(resolveU, fallbackAtmoUniforms(sunDir));

  // Top-down shadow (created now so consumers can grab the texture during their own init).
  const shadowRT = new THREE.WebGLRenderTarget(params.shadowSize, params.shadowSize, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
  });
  shadowRT.texture.wrapS = shadowRT.texture.wrapT = THREE.ClampToEdgeWrapping;
  const shadowU = { ...common, uRect: { value: new THREE.Vector4(0, 0, params.shadowExtent, params.shadowExt) } };
  const shadowMat = mat(CLOUD_COMMON + SHADOW_FS, shadowU, false);
  const shadowMatrix = new THREE.Matrix4();
  const shadow = {
    texture: shadowRT.texture,
    matrix: shadowMatrix,
    uniforms: { cloudShadowMap: { value: shadowRT.texture }, cloudShadowMatrix: { value: shadowMatrix } },
    chunk: SHADOW_CHUNK,
  };
  {
    // Lit until the first real update.
    const prev = renderer.getRenderTarget();
    const cc = new THREE.Color(); renderer.getClearColor(cc); const ca = renderer.getClearAlpha();
    renderer.setRenderTarget(shadowRT); renderer.setClearColor(0xffffff, 1); renderer.clear(true, false, false);
    renderer.setClearColor(cc, ca); renderer.setRenderTarget(prev);
  }

  // Targets sized per frame.
  let marchRT = null, hist = [null, null], cur = 0, size = { w: 0, h: 0, fw: 0, fh: 0 };
  const prevViewProj = new THREE.Matrix4();
  const prevCamPos = new THREE.Vector3(), _camPos = new THREE.Vector3();
  let frameN = 0, needReset = true, ready = false, lastCtx = null;
  let camFog = 0;
  const emptyOut = { texture: null, scale: 1, depthTexture: null };
  // Returned every frame (same object): the pipeline applies alphaSharpen at full res when `soft` is true.
  const sharpOut = { lo: 0.1, hi: 0.62, soft: false, channel: 'depthTexture.a' };
  const out = { texture: null, depthTexture: null, scale: 1, width: 0, height: 0, alphaSharpen: sharpOut };

  function mrt(w, h, count) {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      count, type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    });
    for (const t of rt.textures) { t.minFilter = t.magFilter = THREE.LinearFilter; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; }
    return rt;
  }
  function ensureTargets(fw, fh) {
    const scale = clamp(game.quality?.cloudScale ?? 0.5, 0.1, 1);
    const w = Math.max(16, Math.round(fw * scale)), h = Math.max(16, Math.round(fh * scale));
    const up = params.upsample === 'auto' ? (w * h > 350000 ? 2 : 1) : clamp(Math.round(params.upsample) || 1, 1, 2);
    if (w === size.w && h === size.h && up === size.up && marchRT) return;
    marchRT?.dispose(); hist[0]?.dispose(); hist[1]?.dispose();
    const lw = Math.ceil(w / up), lh = Math.ceil(h / up);
    marchRT = mrt(lw, lh, 2);
    hist = [mrt(w, h, 4), mrt(w, h, 4)];
    size = { w, h, fw, fh, scale: w / fw, up, lw, lh };
    needReset = true;
  }

  function updateLook() {
    const sunC = atmoU.atmoSunColor?.value || _sunFallback;
    const sunL = Math.max(0.05, lum(sunC));
    const tint = _tint.setRGB(sunC.r / sunL, sunC.g / sunL, sunC.b / sunL);
    const g = params.gains;
    // Atmosphere presets (afternoon / storm / victory) publish the cloud lit / shade / deep colours: they already carry
    // the preset's hue. Without them: own key-art colours, lit tinted by the sun.
    const aLit = atmoU.atmoCloudLit?.value, aShade = atmoU.atmoCloudShade?.value, aDeep = atmoU.atmoCloudDeep?.value;
    const follow = !!(params.followAtmo && aLit && aShade && aDeep);
    const lit = _lit.copy(follow ? aLit : C(params.colors.lit));
    if (!follow) lit.multiply(tint);
    const sh = _sh.copy(follow ? aShade : C(params.colors.shadow));
    const dp = _dp.copy(follow ? aDeep : C(params.colors.deep));
    const put = (k, c) => { const m = sunL * (g[k] ?? 1); pal[k].set(c.r * m, c.g * m, c.b * m); };
    put('fog', _d.copy(lit).lerp(sh, 0.25).multiply(C(0xf4f8ff)));           // inside a cloud: bright, slightly cool
    // Mid band: the shade hue lifted to the lit/shade mean luminance (a light sky blue, not the grey a straight mix
    // of cream and blue gives), 35 % toward that mix so it never over-saturates.
    const lm = lum(_d.copy(sh).lerp(lit, 0.5)), ls = Math.max(1e-4, lum(sh));
    _mid.copy(sh).multiplyScalar(lm / ls).lerp(_d, 0.35);
    lit.multiply(C(params.litWarm));
    put('lit', lit);
    put('warm', _d.copy(lit).multiply(C(0xffeed6)));                         // warmer toward the sun
    put('mid', _mid);
    put('shadow', sh);
    put('deep', dp);
    put('bounce', _d.copy(dp).lerp(sh, 0.5));
    put('rim', _d.copy(C(params.colors.rim)).multiply(tint));
    resolveU.uBands.value.set(params.band1, params.band2, params.bandSoft, params.lobeW);
    resolveU.uLook.value.set(params.crease, params.rim, wx.darkness, camFog);
    resolveU.uSharp.value.set(params.sharpNear, params.sharpFar);
    resolveU.uPaint.value.set(params.paintUp, params.paintFront, params.haze, params.shadowForm);
    resolveU.uSharpLoHi.value.set(params.sharpLo, params.sharpHi);
    resolveU.uBlend.value = params.blend;
    resolveU.uDebug.value = params.debug;
    common.uNoise.value.set(params.shapeAmp, params.detailAmp, params.edge, NOISE.shapeTile);
    common.uNoise2.value.set(NOISE.detailTile, time, params.detailFar, params.bias);
    common.uNoise3.value.set(params.nearAmp, Math.max(20, params.nearTile), Math.max(50, params.nearFar), params.farGrow);
    common.uDeck.value.z = clamp(wx.coverage, 0.02, 0.98);
    common.uTowerGrow.value = (wx.coverage - DECK.coverage) * 320;
  }

  function packDisplacers(camPos) {
    const list = [...displacers].filter((d) => d.strength > 0.001 && d.radius > 0);
    if (list.length > 8) list.sort((a, b) => (b.radius * b.strength) / (1 + b.pos.distanceTo(camPos)) - (a.radius * a.strength) / (1 + a.pos.distanceTo(camPos)));
    const n = Math.min(8, list.length);
    for (let i = 0; i < n; i++) {
      const d = list[i];
      dispU.pos[i].set(d.pos.x, d.pos.y, d.pos.z, d.radius); dispU.k[i] = clamp(d.strength, 0, 1);
      // Ragged-edge billow size: the hole's initial radius (a growing / moving hole keeps its pattern in place).
      const r0 = d.baseRadius ?? d.r0;
      dispU.s[i] = Number.isFinite(r0) && r0 > 0 ? r0 : d.radius;
    }
    for (let i = n; i < 8; i++) { dispU.pos[i].set(0, -1e5, 0, 0); dispU.k[i] = 0; dispU.s[i] = 100; }
    common.uDispN.value = n;
    common.uDispRag.value.set(Math.max(0, +params.holeRag || 0), clamp(+params.holeLumps || 0, 0, 1), Math.max(0.5, +params.holeLobe || 3), 0);
  }

  // Wave 5: the titan's hit capsules as sun occluders for the cloud lighting (its shadow on the deck / towers).
  // World-space shapes from game.titan.actor.shapes (capsule { a, b, r } or sphere { a, r }); the core sphere sits
  // inside the body capsule and is skipped. Off when the titan is inactive, hidden or > 14 km away.
  let occWarned = false;
  const _ob = new THREE.Vector3();
  function packOccluders(camPos) {
    let n = 0;
    try {
      const T = game.titan, a = T?.actor, shapes = a?.shapes;
      if (params.titanShadow > 0 && T?.active && a && T.root?.visible !== false && Array.isArray(shapes) && a.pos
        && a.pos.distanceTo(camPos) < 14000) {
        const sc = Math.max(0.1, +params.titanScale || 1);
        _ob.set(0, 0, 0);
        for (const s of shapes) {
          if (n >= MAX_OCC) break;
          if (!s?.a || !(s.r > 0) || s.part === 'core') continue;
          const b = s.b || s.a;
          if (!Number.isFinite(s.a.x + s.a.y + s.a.z + b.x + b.y + b.z)) continue;
          occU.a[n].set(s.a.x, s.a.y, s.a.z, s.r * sc); occU.b[n].set(b.x, b.y, b.z, 0);
          _ob.add(s.a).add(b);
          n++;
        }
        if (n) {
          _ob.multiplyScalar(0.5 / n);
          let R = 0;
          for (let i = 0; i < n; i++) {
            const A = occU.a[i], B = occU.b[i];
            R = Math.max(R, Math.hypot(A.x - _ob.x, A.y - _ob.y, A.z - _ob.z) + A.w, Math.hypot(B.x - _ob.x, B.y - _ob.y, B.z - _ob.z) + A.w);
          }
          const pen = (+params.titanSoft0 || 0) + 8;
          marchU.uOccBound.value.set(_ob.x, _ob.y, _ob.z, R + pen);
        }
      }
    } catch (e) {
      if (!occWarned) { console.error('[clouds] titan occluder failed', e); occWarned = true; }
      n = 0;
    }
    marchU.uOccN.value = n;
    marchU.uOccSoft.value.set(Math.max(0.1, +params.titanSoft0 || 0), Math.max(0, +params.titanSoftK || 0));
  }

  // Wave 5: dragons keep a silhouette inside clouds. The 8 nearest dragons (game.actors, kind 'dragon', visible)
  // within silFar m of the camera: sphere radius × silPad + 2 m, transmittance floor silOwn (team 'player') or
  // silEnemy, full within silNear m, smoothly to 0 at silFar.
  let silWarned = false;
  const silList = [];
  function packSilhouettes(camPos) {
    let n = 0;
    try {
      if (params.silhouette > 0) {
        silList.length = 0;
        const near = Math.max(1, +params.silNear || 150), far = Math.max(near + 1, +params.silFar || 230);
        for (const a of game.actors || []) {
          if (!a || a.kind !== 'dragon' || !a.pos || a.root?.visible === false) continue;
          const d = a.pos.distanceTo(camPos);
          if (!(d < far)) continue;
          const own = a.team === 'player';
          const f = clamp(own ? +params.silOwn : +params.silEnemy, 0, 0.98) * (1 - smooth01((d - near) / (far - near)));
          if (f > 0.002) silList.push({ a, d, f });
        }
        silList.sort((x, y) => x.d - y.d);
        const pad = Math.max(0.5, +params.silPad || 1.5);
        for (const it of silList) {
          if (n >= 8) break;
          const p = it.a.pos, r = (Number.isFinite(it.a.radius) && it.a.radius > 0 ? it.a.radius : 11) * pad + 2;
          if (!Number.isFinite(p.x + p.y + p.z)) continue;
          silU.s[n].set(p.x, p.y, p.z, r); silU.t[n] = it.f;
          n++;
        }
      }
    } catch (e) {
      if (!silWarned) { console.error('[clouds] silhouettes failed', e); silWarned = true; }
      n = 0;
    }
    for (let i = n; i < 8; i++) { silU.s[i].set(0, -1e5, 0, 0); silU.t[i] = 0; }
    silCommon.uSilN.value = n;
  }

  // CPU twin of the density (envelope + the same shape billows as the GPU + mean fine erosion + displacers).
  // Wave 4: the shape billows are read back from the GPU bake (noiseCpu), so the twin's surface is the rendered one
  // within the fine detail (±36 m near the camera); and the value is smooth: smoothstep(-rampOut, rampIn, metres
  // inside), 0.5 about 10 m inside the surface, so wisps, cover, audio and the camera fog build up gradually as the
  // picture does (wave 3: 0 -> 1 over the first 36 m inside, i.e. a switch at flight speed).
  const _w = [0, 0, 0];
  let noiseCpu = null, detailMean = 0.79, holeCpu = null;
  function shapeBill(x, y, z) {
    const tile = NOISE.shapeTile;
    return tri3(noiseCpu, (x + windOffset.x) / tile, (y + windOffset.y) / tile, (z + windOffset.z) / tile);
  }
  /** Trilinear, wrapping sample of a read-back 3D noise at texture coordinates (s, t, r), 0..1 like the GPU. */
  function tri3(nz, s, t, r) {
    const S = nz.size, d = nz.data;
    const u = s * S - 0.5, v = t * S - 0.5, w = r * S - 0.5;
    const iu = Math.floor(u), iv = Math.floor(v), iw = Math.floor(w);
    const fu = u - iu, fv = v - iv, fw = w - iw;
    const m = S - 1;
    const x0 = iu & m, x1 = (iu + 1) & m, y0 = (iv & m) * S, y1 = ((iv + 1) & m) * S, z0 = (iw & m) * S * S, z1 = ((iw + 1) & m) * S * S;
    const a = d[x0 + y0 + z0] + (d[x1 + y0 + z0] - d[x0 + y0 + z0]) * fu;
    const b = d[x0 + y1 + z0] + (d[x1 + y1 + z0] - d[x0 + y1 + z0]) * fu;
    const c = d[x0 + y0 + z1] + (d[x1 + y0 + z1] - d[x0 + y0 + z1]) * fu;
    const e = d[x0 + y1 + z1] + (d[x1 + y1 + z1] - d[x0 + y1 + z1]) * fu;
    const ab = a + (b - a) * fv, ce = c + (e - c) * fv;
    return (ab + (ce - ab) * fw) / 255;
  }
  /** Metres inside the rendered cloud surface (>0 inside), CPU approximation. */
  function insideCpu(x, y, z) {
    if (!(y > DECK.base - DECK.baseVar - 100 && y < FIELD.yMax)) return -1e4;
    let e = -towerSdf(towers, x, y, z) + (wx.coverage - DECK.coverage) * 320;
    if (y < DECK.topMax + 60) e = Math.max(e, deckInside(sampleWeather(weather, x, z, _w), y, wx.coverage));
    if (e < -params.shapeAmp - 200) return e;
    const body = clamp((y - DECK.base + 40) / 300, 0, 1), bs = body * body * (3 - 2 * body);
    const bill = noiseCpu ? shapeBill(x, y, z) : NOISE.mean;
    e += (bill - params.bias) * params.shapeAmp * (0.3 + 0.7 * bs);
    if (e > -params.detailAmp && e < 160) {
      // Mean of the fine billows (they grow the surface near the camera; faded with distance like the GPU).
      const cp = game.camera?.position;
      const dist = cp ? Math.hypot(x - cp.x, y - cp.y, z - cp.z) : 0;
      const fade = 1 - clamp((dist - params.detailFar * 0.35) / (params.detailFar * 0.65), 0, 1);
      e += (detailMean - 0.5) * params.detailAmp * fade * (1 - clamp(e / 160, 0, 1)) * (0.5 + 0.5 * bs);
    }
    for (const d of displacers) {
      if (d.strength <= 0) continue;
      const dist = Math.hypot(x - d.pos.x, y - d.pos.y, z - d.pos.z);
      if (dist > d.radius * 1.9) continue;
      // Wave 5: the same ragged edge as the GPU (hole-sized billows read back from the detail bake).
      let R = d.radius, lump = 1;
      if (holeCpu && params.holeRag > 0 && dist > d.radius * 0.35) {
        const r0 = d.baseRadius ?? d.r0, S = Math.max(20, Number.isFinite(r0) && r0 > 0 ? r0 : d.radius) * Math.max(0.5, +params.holeLobe || 3);
        const s0 = (x + windOffset.x) / S + 0.37, t0 = (y + windOffset.y) / S + 0.53, r1 = (z + windOffset.z) / S + 0.71;
        R *= 1 - params.holeRag * (tri3(holeCpu.rag, s0, t0, r1) - 0.79);
        lump = lerp(1, 0.2 + 1.7 * clamp((tri3(holeCpu.big, s0, t0, r1) - 0.45) / 0.55, 0, 1), clamp(+params.holeLumps || 0, 0, 1));
      }
      const hole = dist - R;
      const rim = Math.exp(-(((dist - d.radius * 1.12) / (d.radius * 0.32)) ** 2)) * d.radius * 0.28 * lump;
      const k = clamp(d.strength, 0, 1);
      e = lerp(e, Math.min(e, hole), k) + k * rim * clamp((e + d.radius * 0.3) / (d.radius * 0.3), 0, 1);
    }
    return e;
  }
  let densWarned = false;
  function density(x, y, z) {
    let e;
    try { e = insideCpu(x, y, z); } catch (err) {
      if (!densWarned) { console.error('[clouds] density failed', err); densWarned = true; }
      return 0;
    }
    const lo = -Math.max(1, params.rampOut), hi = Math.max(1, params.rampIn);
    if (!(e > lo)) return 0;                 // also NaN input
    if (e >= hi) return 1;
    const f = (e - lo) / (hi - lo);
    return f * f * (3 - 2 * f);
  }

  // GPU timer (EXT_disjoint_timer_query_webgl2) when the browser exposes it.
  const gl = renderer.getContext();
  const timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const queries = [];
  const stats = { w: 0, h: 0, scale: 0, steps: 0, lightSteps: 0, gpuMs: null, timer: !!timerExt, bakeMs: 0 };
  const gpuSamples = [];
  /** Min / median / p90 of the last per-frame GPU timings (ms): robust against other GPU work sharing the device. */
  stats.gpu = () => {
    if (!gpuSamples.length) return null;
    const a = [...gpuSamples].sort((x, y) => x - y);
    const q = (f) => +a[Math.min(a.length - 1, Math.floor(f * a.length))].toFixed(2);
    return { n: a.length, min: q(0), med: q(0.5), p90: q(0.9) };
  };
  stats.resetGpu = () => { gpuSamples.length = 0; };
  function pollQueries() {
    while (queries.length) {
      const q = queries[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = gl.getParameter(timerExt.GPU_DISJOINT_EXT);
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
      if (!disjoint) {
        const ms = ns / 1e6;
        stats.gpuMs = stats.gpuMs == null ? ms : stats.gpuMs * 0.9 + ms * 0.1;
        gpuSamples.push(ms); if (gpuSamples.length > 240) gpuSamples.shift();
      }
      gl.deleteQuery(q); queries.shift();
    }
  }

  // Never throws (physics calls it 4x per dragon per 120 Hz step): a bad input returns calm air.
  let windWarned = false;
  function safeWind(pos, out) {
    try { return air.wind(pos, out); } catch (e) {
      if (!windWarned) { console.error('[clouds] wind failed', e); windWarned = true; }
      return out ? out.set(0, 0, 0) : { x: 0, y: 0, z: 0 };
    }
  }

  const clouds = {
    name: 'clouds',
    params, layout, stats, weather: wx,
    shadow,
    /** Read-only [{ x, z, base, top, radius, far, anvil, lean: { x, z } }] — every cumulus column (near + far ring). */
    towers: towerList,
    /** Same function as game.world.wind; windParams = live tuning (gains in m/s, enabled). */
    wind: safeWind,
    windParams: air.params,
    get ready() { return ready; },

    async init() {
      const t0 = performance.now();
      const prev = renderer.getRenderTarget();
      try {
        common.uShape.value = bakeNoise(renderer, quad, 128, 0).texture;
        common.uDetail.value = bakeNoise(renderer, quad, 64, 1).texture;
        common.uField.value = bakeField(renderer, quad, towers).texture;
        ready = true;
        // CPU twin: the same shape billows as erode() (g·0.5 + b·0.32 + a·0.18) and the fine billows' mean.
        try {
          noiseCpu = readNoise(renderer, quad, common.uShape.value, 128, [0, 0.5, 0.32, 0.18]);
          detailMean = readNoise(renderer, quad, common.uDetail.value, 64, [0.55, 0.3, 0.15, 0]).mean;
          // Wave 5: ragged hole edge (displace() in shaders.js: rag = r·0.5 + g·0.32 + b·0.18, lumps from r).
          holeCpu = { rag: readNoise(renderer, quad, common.uDetail.value, 64, [0.5, 0.32, 0.18, 0]), big: readNoise(renderer, quad, common.uDetail.value, 64, [1, 0, 0, 0]) };
          stats.noiseMean = +noiseCpu.mean.toFixed(3); stats.detailMean = +detailMean.toFixed(3);
        } catch (e) { noiseCpu = null; console.error('[clouds] noise readback failed (CPU twin uses the mean)', e); }
      } catch (e) {
        console.error('[clouds] bake failed', e);
      }
      renderer.setRenderTarget(prev);
      stats.bakeMs = Math.round(performance.now() - t0);
      game.world.cloudDensity = density;
      game.events.on('explosion', (e) => {
        try {
          if (!e?.point) return;
          const r = Math.max(40, (e.radius || 10) * 2.5);
          if (density(e.point.x, e.point.y, e.point.z) > 0 || density(e.point.x, e.point.y + r * 0.5, e.point.z) > 0) clouds.punch(e.point, r, 7);
        } catch { /* never break the emitter */ }
      });
      game.events.on('quality', () => { needReset = true; });
    },

    update(dt) {
      time += dt;
      windOffset.addScaledVector(wx.wind, dt);
      if (tween) {
        tween.t = Math.min(tween.dur, tween.t + dt);
        const f = tween.dur > 0 ? tween.t / tween.dur : 1;
        const s = f * f * (3 - 2 * f);
        if (tween.to.coverage != null) wx.coverage = lerp(tween.from.coverage, tween.to.coverage, s);
        if (tween.to.darkness != null) wx.darkness = lerp(tween.from.darkness, tween.to.darkness, s);
        if (tween.to.wind) wx.wind.lerpVectors(tween.from.wind, tween.to.wind, s);
        if (f >= 1) tween = null;
      }
      for (const d of displacers) {
        if (d.ttl == null) continue;
        d.age += dt;
        const inT = Math.min(1, d.age / 0.25);
        const outT = clamp((d.age - d.hold) / d.ttl, 0, 1);
        d.strength = d.peak * inT * (1 - outT * outT);
        d.radius = d.baseRadius * (0.7 + 0.3 * inT);
        if (d.age > d.hold + d.ttl) displacers.delete(d);
      }
      const cp = game.camera.position;
      camFog = lerp(camFog, density(cp.x, cp.y, cp.z), damp(6, Math.max(dt, 1 / 120)));
    },

    render(ctx) {
      if (!ready || !ctx?.renderer || !ctx.camera) return emptyOut;
      try {
        return renderClouds(ctx);
      } catch (e) {
        if (!clouds._warned) { console.error('[clouds] render failed', e); clouds._warned = true; }
        return emptyOut;
      }
    },

    addDisplacer({ pos, radius = 100, strength = 1 } = {}) {
      const h = {
        pos: pos ? pos : new THREE.Vector3(), radius, strength, r0: radius,
        remove() { displacers.delete(h); },
      };
      displacers.add(h);
      return h;
    },
    /** Temporary hole (explosions, dragons bursting out): opens in 0.25 s, heals over `seconds`. */
    punch(pos, radius = 60, seconds = 6, strength = 1) {
      const h = clouds.addDisplacer({ pos: new THREE.Vector3().copy(pos), radius, strength: 0 });
      Object.assign(h, { ttl: seconds, age: 0, hold: 0.8, peak: strength, baseRadius: radius });
      return h;
    },
    setWeather(target = {}, seconds = 0) {
      const to = {};
      if (target.coverage != null) to.coverage = clamp(target.coverage, 0.02, 0.98);
      if (target.darkness != null) to.darkness = clamp(target.darkness, 0, 1);
      if (target.wind != null) {
        const w = target.wind;
        to.wind = typeof w === 'number' ? wx.wind.clone().normalize().multiplyScalar(w) : new THREE.Vector3(w.x || 0, w.y || 0, w.z || 0);
      }
      tween = { from: { coverage: wx.coverage, darkness: wx.darkness, wind: wx.wind.clone() }, to, t: 0, dur: Math.max(0, seconds) };
      if (!(seconds > 0)) clouds.update(0);
      return tween;
    },
    density,
    /** Metres inside the rendered surface (>0 inside), the CPU twin before the smooth ramp (tests / AI). */
    inside: (x, y, z) => { try { return insideCpu(x, y, z); } catch { return -1e4; } },
    resetHistory() { needReset = true; },

    /** Test helper: the G-buffer, colour and depth outputs at a cloud-buffer pixel (stalls; tests only). */
    readPixel(x, y) {
      const rt = hist[cur];
      if (!rt) return null;
      const names = ['attrA', 'attrB', 'color', 'depth'];
      const res = {};
      const buf = new Uint16Array(4);
      names.forEach((n, i) => {
        renderer.readRenderTargetPixels(rt, x, y, 1, 1, buf, undefined, i);
        res[n] = [...buf].map((h) => +THREE.DataUtils.fromHalfFloat(h).toFixed(3));
      });
      res.palette = Object.fromEntries(Object.entries(pal).map(([k, v]) => [k, v.toArray().map((a) => +a.toFixed(3))]));
      return res;
    },

    /** Test helper: histograms (10 bins, 0..1) of the accumulated G-buffer over cloud pixels (alpha > 0.5) of the
     *  current history: sunVis, lobe N·L (0..1 encoded), crease, normal y (encoded), rim; plus the pixel count.
     *  Stalls the GPU (full readback); tests only. */
    gbufferStats() {
      const rt = hist[cur];
      if (!rt) return null;
      const n = rt.width * rt.height;
      const a = new Uint16Array(n * 4), b = new Uint16Array(n * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, a, undefined, 0);
      renderer.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, b, undefined, 1);
      const f = THREE.DataUtils.fromHalfFloat;
      const H = { sunVis: new Array(10).fill(0), ndl: new Array(10).fill(0), crease: new Array(10).fill(0), ny: new Array(10).fill(0), rim: new Array(10).fill(0) };
      let count = 0;
      const bin = (v) => Math.max(0, Math.min(9, Math.floor(v * 10)));
      for (let i = 0; i < n; i += 3) {
        if (f(a[i * 4 + 3]) < 0.5) continue;
        count++;
        H.sunVis[bin(f(a[i * 4]))]++; H.ndl[bin(f(a[i * 4 + 1]))]++; H.crease[bin(f(a[i * 4 + 2]))]++;
        H.ny[bin(f(b[i * 4 + 1]))]++; H.rim[bin(f(b[i * 4 + 2]))]++;
      }
      for (const k of Object.keys(H)) H[k] = H[k].map((v) => Math.round((v / Math.max(1, count)) * 100));
      return { count, ...H };
    },

    /** Test helper (wave 5): how much of an object at `pos` (sphere of `radius` m) the cloud in front hides, read from
     *  the current output at cloud-buffer resolution. Texels whose march limit lies within the sphere's depth range
     *  count as the object's pixels; alpha is taken after the pipeline's full-res sharpening curve (depth.a amount).
     *  -> { n, meanVis, minVis, p10Vis, below60, below80, dist } (vis = 1 - alpha = share of the object still seen),
     *  null when off screen. Stalls the GPU (readback); tests only. */
    visibilityOf(pos, radius = 10) {
      const rt = hist[cur], cam = game.camera;
      if (!rt || !pos || !cam) return null;
      const dist = cam.position.distanceTo(pos);
      const v = new THREE.Vector3().copy(pos).project(cam);
      if (v.z > 1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2) return null;
      const W = rt.width, H = rt.height;
      const rpx = (radius / Math.max(dist, 1)) * (H / 2) / Math.tan((cam.fov * Math.PI) / 360);
      const cx = (v.x * 0.5 + 0.5) * W, cy = (v.y * 0.5 + 0.5) * H;
      const x0 = clamp(Math.floor(cx - rpx), 0, W - 1), x1 = clamp(Math.ceil(cx + rpx), 0, W - 1);
      const y0 = clamp(Math.floor(cy - rpx), 0, H - 1), y1 = clamp(Math.ceil(cy + rpx), 0, H - 1);
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      if (w <= 0 || h <= 0 || w * h > 400000) return null;
      const buf = new Uint16Array(w * h * 4);
      renderer.readRenderTargetPixels(rt, x0, y0, w, h, buf, undefined, 3);
      const f = THREE.DataUtils.fromHalfFloat, soft = sharpOut.soft, lo = sharpOut.lo, hi = sharpOut.hi;
      const vis = [];
      for (let i = 0; i < w * h; i++) {
        const g = f(buf[i * 4 + 1]);
        if (!(g > dist - radius && g < dist + radius)) continue;
        const a = f(buf[i * 4 + 2]), amt = clamp(f(buf[i * 4 + 3]), 0, 1);
        let a2 = a;
        if (soft) { const t = clamp((a - lo) / (hi - lo), 0, 1); a2 = a + (t * t * (3 - 2 * t) - a) * amt; }
        vis.push(1 - clamp(a2, 0, 1));
      }
      if (!vis.length) return { n: 0, dist: +dist.toFixed(1) };
      vis.sort((a, b) => a - b);
      const mean = vis.reduce((s, x) => s + x, 0) / vis.length;
      return {
        n: vis.length, dist: +dist.toFixed(1), meanVis: +mean.toFixed(3), minVis: +vis[0].toFixed(3),
        p10Vis: +vis[Math.floor(vis.length * 0.1)].toFixed(3),
        below60: +(vis.filter((x) => x < 0.6).length / vis.length).toFixed(3), below80: +(vis.filter((x) => x < 0.8).length / vis.length).toFixed(3),
      };
    },

    /** Test helper: evaluate the GPU density functions at world points (array of [x,y,z]).
     *  Returns [{ sdf, deck, cheap, density }] read back from the GPU (stalls; tests only). */
    gpuSample(points) {
      if (!ready || !points?.length) return [];
      const n = points.length;
      const data = new Float32Array(n * 4);
      points.forEach((p, i) => data.set([p[0], p[1], p[2], 0], i * 4));
      const tex = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat, THREE.FloatType);
      tex.needsUpdate = true;
      const rt = new THREE.WebGLRenderTarget(n, 1, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false });
      const m = mat(CLOUD_COMMON + PROBE_FS, { ...common, uPoints: { value: tex }, uCount: { value: n } }, false);
      updateLook();
      const prev = renderer.getRenderTarget();
      quad.draw(renderer, m, rt);
      const out = new Float32Array(n * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, n, 1, out);
      renderer.setRenderTarget(prev);
      m.dispose(); rt.dispose(); tex.dispose();
      return points.map((p, i) => ({ sdf: out[i * 4], deck: out[i * 4 + 1], cheap: out[i * 4 + 2], density: out[i * 4 + 3] }));
    },

    /** Average ms per render() call measured with a GPU sync (for tests; stalls the pipeline, do not use in play). */
    bench(n = 20) {
      if (!lastCtx) return null;
      const px = new Float32Array(4);
      const sync = () => { try { renderer.readRenderTargetPixels(hist[cur], 0, 0, 1, 1, px); } catch { gl.finish(); } };
      sync();
      const t0 = performance.now();
      for (let i = 0; i < n; i++) renderClouds({ ...lastCtx, frame: frameN + 1 });
      sync();
      return (performance.now() - t0) / n;
    },
  };

  function renderClouds(ctx) {
    const { renderer: r, camera, depthTexture } = ctx;
    const fw = ctx.width || game.size?.pw || 1, fh = ctx.height || game.size?.ph || 1;
    ensureTargets(fw, fh);
    lastCtx = ctx;
    if (timerExt) pollQueries();
    const q = timerExt && queries.length < 4 ? gl.createQuery() : null;
    if (q) gl.beginQuery(timerExt.TIME_ELAPSED_EXT, q);

    camera.updateMatrixWorld();
    const camPos = _camPos.setFromMatrixPosition(camera.matrixWorld);
    if (camPos.distanceTo(prevCamPos) > 400) needReset = true;
    updateLook();
    packDisplacers(camPos);
    packOccluders(camPos);
    packSilhouettes(camPos);

    const qa = game.quality || {};
    stats.steps = qa.cloudSteps ?? 80; stats.lightSteps = qa.cloudLightSteps ?? 6;
    stats.w = size.w; stats.h = size.h; stats.scale = size.scale; stats.up = size.up;
    frameN++;
    const up = size.up;
    const OFFS = [[0, 0], [1, 1], [1, 0], [0, 1]];
    const off = up === 2 ? OFFS[frameN & 3] : [0, 0];
    const j = HALTON[(up === 2 ? frameN >> 2 : frameN) & 7];
    marchU.uOffset.value.set(off[0], off[1]);
    marchU.uUp.value = up;
    marchU.uInterior.value.set(params.interior, clamp(camFog * 2, 0, 1), params.pocket, Math.max(5, params.nearThin));
    resolveU.uLowRes.value.set(size.lw, size.lh);
    marchU.uDepth.value = depthTexture || null;
    marchU.uHasDepth.value = depthTexture ? 1 : 0;
    marchU.uDepthSize.value.set(fw, fh);
    marchU.uProjInv.value.copy(camera.projectionMatrixInverse);
    marchU.uCamWorld.value.copy(camera.matrixWorld);
    marchU.uCamPos.value.copy(camPos);
    marchU.uNearFar.value.set(camera.near, camera.far);
    marchU.uRes.value.set(size.w, size.h);
    marchU.uJitter.value.set(j[0], j[1]);
    marchU.uFrame.value = frameN % 64;
    marchU.uMarch.value.set(stats.steps, stats.lightSteps, params.maxDist, params.stepK);
    marchU.uLight.value.set(params.ext, params.extLight, params.lightStep0, params.minStep);
    // Storm clouds read as heavier, smoother masses: fewer small puffs in the shading.
    const calm = 1 - 0.55 * wx.darkness;
    marchU.uPuff.value.set(params.puffSmall * calm, params.puffFine * calm, params.creaseGain, params.creaseK);
    marchU.uPuff2.value.set(params.deckTrough, params.shadowSoft, params.normalK, Math.max(2, params.normalMin));
    marchU.uPuff3.value.set(Math.max(1, params.closeBump), Math.max(50, params.closeRange), clamp(Math.round(params.shadowSteps), 1, 12), 0);

    const soft = params.softAlpha === 'auto' ? !!(ctx.alphaSharpen === true || game.pipeline?.cloudAlphaSharpen === true) : !!params.softAlpha;
    resolveU.uSoftAlpha.value = soft ? 1 : 0;
    sharpOut.soft = soft; sharpOut.lo = params.sharpLo; sharpOut.hi = params.sharpHi;

    const prevTarget = r.getRenderTarget();
    const prevAutoClear = r.autoClear;
    r.autoClear = true;          // full overwrite; a clear is the cheap load action on tile GPUs
    quad.draw(r, marchMat, marchRT);

    const src = hist[cur], dst = hist[1 - cur];
    resolveU.uCurA.value = marchRT.textures[0];
    resolveU.uCurB.value = marchRT.textures[1];
    resolveU.uHistA.value = src.textures[0];
    resolveU.uHistB.value = src.textures[1];
    resolveU.uPrevViewProj.value.copy(prevViewProj);
    resolveU.uReset.value = needReset ? 1 : 0;
    quad.draw(r, resolveMat, dst);
    cur = 1 - cur;
    needReset = false;

    // Cloud shadow map around the camera, snapped to texels so it does not swim.
    const ext = params.shadowExtent, texel = ext / params.shadowSize;
    const L = sunDir, ly = Math.max(L.y, 0.08);
    const cx = Math.round(camPos.x / (texel * 4)) * texel * 4;
    const cz = Math.round(camPos.z / (texel * 4)) * texel * 4;
    const moved = cx !== shadowU.uRect.value.x || cz !== shadowU.uRect.value.y;
    shadowU.uRect.value.set(cx, cz, ext, params.shadowExt);
    shadowMatrix.set(
      1 / ext, -L.x / ly / ext, 0, 0.5 - cx / ext,
      0, -L.z / ly / ext, 1 / ext, 0.5 - cz / ext,
      0, 0, 0, 0,
      0, 0, 0, 1,
    );
    // Amortised: one horizontal strip of N per frame (scissor), the whole map when the window re-centres.
    const nStrips = Math.max(1, params.shadowEvery | 0), ss = params.shadowSize;
    if (moved || nStrips === 1) { shadowRT.scissorTest = false; }
    else {
      const k = frameN % nStrips, y0 = Math.floor((k * ss) / nStrips), y1 = Math.floor(((k + 1) * ss) / nStrips);
      shadowRT.scissor.set(0, y0, ss, y1 - y0); shadowRT.scissorTest = true;
    }
    quad.draw(r, shadowMat, shadowRT);
    shadowRT.scissorTest = false;

    r.autoClear = prevAutoClear;
    r.setRenderTarget(prevTarget);
    if (q) { gl.endQuery(timerExt.TIME_ELAPSED_EXT); queries.push(q); }

    prevViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    prevCamPos.copy(camPos);
    const h = hist[cur];
    out.texture = h.textures[2]; out.depthTexture = h.textures[3];
    out.scale = size.scale; out.width = size.w; out.height = size.h;
    return out;
  }

  game.world.cloudDensity = density;
  game.world.wind = safeWind;
  return clouds;
}

// Consumers (terrain, water): `...game.clouds.shadow.uniforms` + this chunk, then cloudShadow(worldPos) in 0..1.
const SHADOW_CHUNK = /* glsl */`
uniform sampler2D cloudShadowMap;
uniform mat4 cloudShadowMatrix;
float cloudShadow(vec3 worldPos) {
  vec2 uv = (cloudShadowMatrix * vec4(worldPos, 1.0)).xy;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 1.0;
  vec4 s = texture(cloudShadowMap, uv);
  return mix(s.r, s.g, smoothstep(1150.0, 1350.0, worldPos.y));
}
`;

const FALLBACK_ATMO = /* glsl */`
uniform vec3 atmoSunDir; uniform vec3 atmoSunColor; uniform vec3 atmoHaze; uniform vec3 atmoHazeSun;
uniform float atmoDensity; uniform float atmoFalloff;
vec3 atmoApplyK(vec3 col, vec3 p, float k) {
  vec3 rd = p - cameraPosition; float dist = length(rd);
  float trans = exp(-atmoDensity * dist * exp(-atmoFalloff * max(cameraPosition.y, 0.0)) * k);
  return col * trans + atmoHaze * (1.0 - trans);
}
vec3 atmoApply(vec3 col, vec3 p) { return atmoApplyK(col, p, 1.0); }
`;
function fallbackAtmoUniforms(sunDir) {
  return {
    atmoSunDir: { value: sunDir }, atmoSunColor: { value: new THREE.Color(3.2, 3.0, 2.56) },
    atmoHaze: { value: new THREE.Color(0x9dbde6) }, atmoHazeSun: { value: new THREE.Color(0xf3e2c4) },
    atmoDensity: { value: 0.00011 }, atmoFalloff: { value: 1 / 1400 },
  };
}
