// game.water — river, lakes and the sea as ONE surface: the terrain's CDLOD node selection filtered to nodes that
// contain visible water, displaced to the baked water level W(x, z) (Gerstner swell on the sea near the camera).
// Anime water: depth bands from the analytic depth (W − ground), sea/lake/river palettes, sky reflection with a strong
// Fresnel, flow-mapped ripples along the river, hard-edged foam at banks and sandbars, moving white surf lines on the
// coast, sun glints as HDR sparkles (bloom turns them into stars), cloud shadows, game.atmo aerial perspective.
// Wave 4 (low flight, below ~1 km over the water): a PLANAR REFLECTION of the scene (terrain, trees, reeds, houses,
// dragons) rendered from a mirrored camera into a half-resolution HDR target before the pipeline's frame, looked up
// with a two-step depth refinement (so water a few metres above / below the mirror plane still reflects its own banks)
// and distorted by the ripple normals; clouds and sky come from the analytic sky + the cloud-shadow map as before.
// Near style: anime depth tones (bed · shallow · mid · deep), a softer Fresnel with a painted minimum reflectance, a
// crisp shore foam line with a second lapping line (from the real distance to the waterline), sand bed and caustics in
// the shallows. It fades in with the camera's height (uRefl.z), so the high-altitude look is unchanged.
// Wave 5: beyond 36 km the sea fades into the terrain's far colour (HORIZON_GLSL), so it meets the horizon apron and
// the sky without the straight light band the sky dome's below-horizon mist used to draw there.
// Public: water.stats { nodes, tris, refl }, water.material, water.uniforms (tune live: uniforms.uSurf, uGlint…),
// water.reflection { enabled, scale, target, camera, plane, weight }.
import * as THREE from 'three';
import { gridGeometry } from './terrain/cdlod.js';
import { WORLD_GLSL } from './terrain/data.js';
import { HORIZON_GLSL } from './terrain/shaders.js';
import { WAVE4 } from './terrain.js';
import { rng, clamp, smoothstep, damp } from '../core/util.js';

// Tileable ripple normal map (RG = normal.xz, B = height) from a sum of lattice-aligned waves + value noise.
function makeRippleTexture(n = 256) {
  const r = rng(4242);
  const h = new Float32Array(n * n);
  const waves = [];
  for (let i = 0; i < 22; i++) {
    const kx = Math.round((r() * 2 - 1) * (3 + i * 0.9)), kz = Math.round((r() * 2 - 1) * (3 + i * 0.9));
    if (kx === 0 && kz === 0) continue;
    waves.push([kx, kz, r() * Math.PI * 2, 1 / Math.pow(Math.hypot(kx, kz), 1.1)]);
  }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let s = 0;
    for (const [kx, kz, ph, a] of waves) s += a * Math.sin(((kx * x + kz * y) / n) * Math.PI * 2 + ph);
    h[y * n + x] = s;
  }
  let lo = Infinity, hi = -Infinity;
  for (const v of h) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const data = new Uint8Array(n * n * 4);
  const at = (x, y) => (h[((y + n) % n) * n + ((x + n) % n)] - lo) / (hi - lo);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * 6, dz = (at(x, y + 1) - at(x, y - 1)) * 6;
    const len = Math.hypot(dx, 1, dz);
    const k = (y * n + x) * 4;
    data[k] = Math.round((-dx / len * 0.5 + 0.5) * 255);
    data[k + 1] = Math.round((-dz / len * 0.5 + 0.5) * 255);
    data[k + 2] = Math.round(at(x, y) * 255);
    data[k + 3] = 255;
  }
  const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true; t.needsUpdate = true;
  return t;
}

const WATER_VS = /* glsl */`
attribute vec4 aNode;
uniform vec2 uMorph[16];
uniform float uGrid;
uniform float uTime;
uniform vec2 uWind;
uniform sampler2D tFlowOut;
varying vec3 vW;
varying float vSea;
varying vec3 vWaveN;
varying float vCrest;
${WORLD_GLSL}
// Gerstner swell (GPU Gems 1, ch. 1). dir.xy, wavelength, steepness
const int NW = 4;
const vec4 WAVES[4] = vec4[4](vec4(0.94, 0.34, 64.0, 0.34), vec4(0.62, 0.78, 33.0, 0.30), vec4(0.99, -0.12, 19.0, 0.26), vec4(0.40, 0.92, 11.0, 0.22));
void main() {
  vec2 g = position.xz;
  vec2 p = aNode.xy + g * aNode.z;
  float h0 = worldHW(p).x;
  float d = distance(cameraPosition, vec3(p.x, max(h0, 0.0), p.y));
  vec2 m = uMorph[int(aNode.w + 0.5)];
  float k = clamp((d - m.x) * m.y, 0.0, 1.0);
  vec2 odd = fract(g * uGrid * 0.5) * 2.0 / uGrid;
  g -= odd * k;
  p = aNode.xy + g * aNode.z;
  vec2 hw = worldHW(p);
  float sea = smoothstep(0.85, 1.0, textureLod(tFlowOut, worldUvOut(p), 0.0).b) * (1.0 - worldInnerW(p));
  vec3 pos = vec3(p.x, hw.y, p.y);
  vec3 n = vec3(0.0, 1.0, 0.0);
  float crest = 0.0;
  float depth = hw.y - hw.x;
  float amp = sea * (1.0 - smoothstep(900.0, 2400.0, d)) * smoothstep(0.3, 6.0, depth);
  if (amp > 0.0) {
    float t = uTime;
    for (int i = 0; i < NW; i++) {
      vec4 w = WAVES[i];
      vec2 D = normalize(w.xy);
      float L = w.z, kk = 6.2831853 / L, c = sqrt(9.81 / kk), A = w.w / kk / float(NW) * 1.6;
      float f = kk * (dot(D, p) - c * t);
      float Q = w.w;
      pos.xz += Q * A * D * cos(f) * amp;
      pos.y += A * sin(f) * amp;
      n.xz -= D * kk * A * cos(f) * amp;
      n.y -= Q * kk * A * sin(f) * amp;
      crest += sin(f) * 0.25;
    }
  }
  vW = pos; vSea = sea; vWaveN = normalize(n); vCrest = crest * amp;
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}
`;

function waterFS({ atmoChunk, shadowChunk }) {
  return /* glsl */`
uniform sampler2D tFlowIn;       // RG flow dir, B type (1..199 river speed, 220 lake, 255 sea)
uniform sampler2D tFlowOut;
uniform sampler2D tAlbedo;       // painted map: river bed colour through the shallows
uniform sampler2D tRipple;       // tileable ripple normals
uniform float uTime;
uniform vec2 uWind;
uniform float uGlint, uSurf, uFoam, uDebug;
uniform float uHaze;             // aerial perspective strength for water (anime: the sea stays blue far out)
uniform float uCloudRefl;        // strength of the cloud reflections (0 = off)
uniform float uFoamFp;           // 1 = foam fades with the pixel footprint (no sub-pixel specks); 0 = wave-1 behaviour
uniform vec3 atmoCloudLit;       // cloud palette from game.atmo (not declared in its chunk)
uniform vec3 atmoCloudShade;
uniform sampler2D tRefl;         // wave 4: planar reflection (linear HDR, mipmapped) from the mirrored camera
uniform sampler2D tReflDepth;    // its depth (1 = nothing: sky)
uniform mat4 uReflVP, uReflVPInv;
uniform vec4 uRefl;              // x planar weight (0 = off), y mirror plane height, z near-style weight, w max blur lod
varying vec3 vW;
varying float vSea;
varying vec3 vWaveN;
varying float vCrest;
${WORLD_GLSL}
${atmoChunk}
${HORIZON_GLSL}
${shadowChunk}
vec3 srgb(vec3 c) { return c * c * (c * 0.305306 + 0.682171) + c * 0.012523; }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 ripple(vec2 uv) { vec3 t = texture(tRipple, uv).rgb; return vec3(t.r * 2.0 - 1.0, t.b, t.g * 2.0 - 1.0); }

void main() {
  vec3 V = cameraPosition - vW;
  float dist = length(V); V /= max(dist, 1e-3);
  vec2 p = vW.xz;
  vec2 hwF = worldHW(p);                 // roughness is zero around water, so the base height is the bed
  float ground = hwF.x;
  float W = hwF.y;
  float depth = max(W - ground, 0.0);

  // water type and flow
  float wIn = worldInnerW(p);
  vec3 fi = texture(tFlowIn, worldUvIn(p)).rgb, fo = texture(tFlowOut, worldUvOut(p)).rgb;
  vec3 fl = mix(fo, fi, wIn);
  float type = fl.b * 255.0;
  float sea = max(vSea, smoothstep(250.0, 254.0, type));
  float lake = smoothstep(210.0, 218.0, type) * (1.0 - smoothstep(228.0, 236.0, type)) * (1.0 - sea);
  float river = (1.0 - sea) * (1.0 - lake);
  vec2 flow = (fl.rg * 2.0 - 1.0);
  float speed = clamp(type / 198.0 * 2.5, 0.2, 2.5) * river;
  flow = normalize(flow + vec2(1e-4)) * speed;

  // ripples: river = two-phase flow map; lake/sea = wind ripples at two scales
  float fade = 1.0 - smoothstep(600.0, 6000.0, dist);
  vec2 wv = uWind * 0.06;
  vec3 r1 = ripple(p / 36.0 + wv * uTime * 0.03), r2 = ripple(p / 13.0 - wv.yx * uTime * 0.05 + 0.37);
  vec3 rw = r1 * 0.6 + r2 * 0.4;
  float ph = fract(uTime * 0.35), ph2 = fract(uTime * 0.35 + 0.5);
  vec3 f1 = ripple(p / 24.0 - flow * ph * 1.6), f2 = ripple(p / 24.0 - flow * ph2 * 1.6 + 0.5);
  float wt = abs(ph * 2.0 - 1.0);
  vec3 rf = mix(f1, f2, wt) * 0.7 + ripple(p / 9.0 - flow * uTime * 0.12) * 0.3;
  vec3 rn = mix(rw, rf, river);
  float rough = mix(0.22, 0.34, river) * fade;
  vec3 N = normalize(vWaveN + vec3(rn.x, 0.0, rn.z) * rough);

  float nr = uRefl.z;                    // near style (low flight) weight
  // anime depth bands (soft edges, three tones; near style: crisper edges and a deeper, greener teal)
  float k = depth / mix(mix(6.0, 14.0, lake), 26.0, sea);
  k += (texture(tWNoise, p / 900.0).r - 0.5) * 0.12;
  vec3 shallow = mix(mix(srgb(vec3(0.55, 0.93, 0.86)), srgb(vec3(0.42, 0.80, 0.86)), lake), srgb(vec3(0.30, 0.78, 0.80)), sea);
  vec3 mid = mix(mix(srgb(vec3(0.235, 0.78, 0.79)), srgb(vec3(0.17, 0.64, 0.76)), lake), srgb(vec3(0.16, 0.47, 0.72)), sea);
  vec3 deep = mix(mix(srgb(vec3(0.07, 0.58, 0.68)), srgb(vec3(0.08, 0.44, 0.66)), lake), srgb(vec3(0.114, 0.31, 0.604)), sea);
  if (nr > 0.0) {
    vec3 shallowN = mix(mix(srgb(vec3(0.54, 0.90, 0.80)), srgb(vec3(0.46, 0.84, 0.84)), lake), srgb(vec3(0.34, 0.78, 0.80)), sea);
    vec3 midN = mix(mix(srgb(vec3(0.19, 0.74, 0.72)), srgb(vec3(0.15, 0.62, 0.72)), lake), srgb(vec3(0.15, 0.45, 0.70)), sea);
    vec3 deepN = mix(mix(srgb(vec3(0.06, 0.52, 0.57)), srgb(vec3(0.06, 0.42, 0.58)), lake), srgb(vec3(0.11, 0.29, 0.58)), sea);
    shallow = mix(shallow, shallowN, nr); mid = mix(mid, midN, nr); deep = mix(deep, deepN, nr);
  }
  vec2 b1 = mix(vec2(0.18, 0.30), vec2(0.19, 0.25), nr), b2 = mix(vec2(0.55, 0.75), vec2(0.56, 0.66), nr);
  vec3 body = mix(shallow, mid, smoothstep(b1.x, b1.y, k));
  body = mix(body, deep, smoothstep(b2.x, b2.y, k));
  // the bed shows through the shallows (painted map inside the valley, sand outside; near style: clean sand with a
  // broad painted variation — the magnified map showed its blotches through the water)
  vec3 bed = wIn > 0.0 ? mix(srgb(vec3(0.93, 0.87, 0.72)), texture(tAlbedo, worldUvIn(p)).rgb, wIn) : srgb(vec3(0.93, 0.87, 0.72));
  float fpB = length(fwidth(p));
  if (nr > 0.0) {
    float bv = texture(tWNoise, p / 70.0 + 0.3).r;
    vec3 bedN = mix(srgb(vec3(0.80, 0.76, 0.60)), srgb(vec3(0.62, 0.66, 0.52)), smoothstep(0.35, 0.7, bv));
    // soft caustic net in the shallows, only where its 2–3 m cells are several pixels wide
    float cz = ripple(p / 7.0 + flow * uTime * 0.05 + vec2(uTime * 0.02, 0.0)).b * 0.6 + ripple(p / 4.3 - vec2(0.0, uTime * 0.03)).b * 0.4;
    bedN += srgb(vec3(0.95, 1.0, 0.92)) * smoothstep(0.62, 0.82, cz) * 0.35 * (1.0 - smoothstep(0.08, 0.3, fpB));
    bed = mix(bed, bedN, nr);
  }
  body = mix(bed * vec3(0.85, 1.0, 1.0), body, smoothstep(0.0, mix(mix(1.8, 3.5, sea), mix(1.1, 3.0, sea), nr), depth));

  // light
  vec3 L = atmoSunDir;
  float cs = cloudShadow(vW);
  vec3 sun = atmoSunColor;
  float ndl = clamp(dot(N, L), 0.0, 1.0);
  // sky fill follows the preset's brightness (storm darker, victory brighter) but keeps the water's cool tint
  float skyLum = dot(atmoHorizon * 0.6 + atmoZenith * 0.4, vec3(0.2126, 0.7152, 0.0722));
  vec3 amb = vec3(0.30, 0.40, 0.52) * clamp(skyLum / 0.358, 0.3, 1.4);
  vec3 col = body * (sun * (0.16 + 0.22 * ndl) * mix(0.35, 1.0, cs) + amb);
  // sea crests catch light (turquoise scatter on the sun side)
  col += srgb(vec3(0.35, 0.85, 0.85)) * max(vCrest, 0.0) * 0.35 * sea * cs;

  // reflection: anime water mirrors the upper, deep-blue sky (not the pale horizon band, which washed the far sea
  // out to lavender-grey), plus the clouds: the reflected ray meets the deck (~950 m) and the top-down cloud map
  // says how cloudy the sky is there. Near style: a calmer mirror normal (reflections stay readable) and a lower
  // lift, so the bright sky near the horizon shows in the far water (like the reference river)
  // (the sky keeps the full ripple normal: facets tilted toward the camera catch the bright low sky as streaks; the
  // mirror's wobble fades out with distance, where the ripple lattice turned bank reflections into regular stripes)
  vec3 Nm = nr > 0.0 ? normalize(mix(N, normalize(vWaveN + vec3(rn.x, 0.0, rn.z) * 0.11 * (1.0 - smoothstep(250.0, 1100.0, dist))), nr)) : N;
  vec3 R = reflect(-V, N); R.y = abs(R.y);
  R = normalize(R);
  vec3 refl = atmoSky(normalize(vec3(R.x, max(R.y, mix(mix(0.12, 0.24, sea), mix(0.035, 0.12, sea), nr)), R.z)));
  // hue guard: a lavender / peach sky (storm, victory) would turn the whole sea violet; water keeps its blue identity
  // and takes the sky's brightness (the sun road still carries the warm colour)
  float warmSky = smoothstep(0.35, 0.95, refl.r / max(refl.b, 1e-3));
  refl = mix(refl, vec3(dot(refl, vec3(0.2126, 0.7152, 0.0722))) * vec3(0.62, 0.9, 1.35), warmSky * 0.7);
  float cov = 0.0;
  if (uCloudRefl > 0.0 && R.y > 0.02) {
    vec3 pc = vW + R * ((950.0 - vW.y) / R.y);
    cov = (1.0 - cloudShadow(pc)) * (1.0 - smoothstep(9000.0, 16000.0, length(pc.xz - cameraPosition.xz)));
    // far clouds show their sunlit sides (white), overhead ones their bellies (a soft blue-white, never lavender-grey)
    float up = clamp(R.y * 1.4, 0.0, 1.0);
    vec3 cloudC = mix(atmoCloudLit, mix(atmoCloudLit, atmoCloudShade, 0.35), up) * 1.05;
    refl = mix(refl, cloudC, smoothstep(0.05, 0.9, cov) * uCloudRefl * mix(1.0, 0.2, sea));   // the open sea stays deep blue (key art)
  }
  // planar reflection of the scene (banks, trees, reeds, houses, dragons). The virtual camera's pixel through this
  // fragment gives a first distance t to what it sees; the reflected ray's point at t is re-projected (twice), which
  // also corrects water a few metres off the mirror plane. Sky pixels keep the analytic sky + clouds above.
  float pw = 0.0, skyPix = 1.0, tRef = 0.0;
  vec3 planar = vec3(0.0);
  if (uRefl.x > 0.001) {
    vec3 Rr = reflect(-V, Nm); Rr.y = max(abs(Rr.y), 0.004); Rr = normalize(Rr);
    vec4 c0 = uReflVP * vec4(vW, 1.0);
    vec2 uv = c0.xy / max(c0.w, 1e-3) * 0.5 + 0.5;
    float t = 4.0e4, ok = step(0.0, c0.w);
    for (int it = 0; it < 2; it++) {
      float d = textureLod(tReflDepth, uv, 0.0).r;
      if (d < 1.0) { vec4 X = uReflVPInv * vec4(vec3(uv, d) * 2.0 - 1.0, 1.0); t = distance(X.xyz / X.w, vW); } else t = 4.0e4;
      vec4 c1 = uReflVP * vec4(vW + Rr * t, 1.0);
      ok *= step(0.0, c1.w);
      uv = c1.xy / max(c1.w, 1e-3) * 0.5 + 0.5;
    }
    float dz = textureLod(tReflDepth, uv, 0.0).r;
    skyPix = step(1.0, dz);
    tRef = t;
    float lod = min(uRefl.w, 0.3 + t / 2200.0);            // far mountains blur a little, banks stay crisp
    planar = min(textureLod(tRefl, uv, lod).rgb, vec3(8.0)) * vec3(0.86, 0.93, 1.0);   // reflections a touch deeper / bluer
    vec2 e = min(uv, 1.0 - uv);
    pw = uRefl.x * ok * smoothstep(0.0, 0.035, min(e.x, e.y)) * (1.0 - smoothstep(6.0, 18.0, abs(W - uRefl.y))) * (1.0 - skyPix);
    refl = mix(refl, planar, pw);
  }
  float ndv = clamp(dot(Nm, V), 0.0, 1.0);
  float fres = pow(1.0 - ndv, 5.0);
  // calm lakes keep a painted minimum reflectance so clouds read from altitude; the sea caps lower so it stays blue
  float F = mix(mix(mix(0.05, 0.10, lake), 0.035, sea), mix(mix(0.5, 0.62, lake), 0.55, sea), fres);
  // near style: softer curve (anime mirror): ~0.07 looking down, ~0.23 at 20° down, ~0.5 at 10°, ~0.9 at the horizon
  float Fn = mix(mix(0.07, 0.10, lake), 0.05, sea) + mix(mix(0.86, 0.84, lake), 0.66, sea) * pow(1.0 - ndv, 4.0);
  F = mix(F, Fn, nr);
  // anime calm water: mirrored banks, trees and reeds are painted strongly (like the reference river), the sky part
  // keeps the physical curve
  F = mix(F, max(F, 0.52), pw * nr);
  col = mix(col, refl, F);
  if (nr > 0.0) {
    // painted wind ripples (near style): light crest strokes catch the sky, troughs a touch deeper, so water seen
    // steeply (where the Fresnel is low and the sky reflection nearly uniform) is never a flat fill. Faded by the
    // pixel footprint (ripple cells are 9–36 m, strokes ~2 m).
    float strokeK = (1.0 - smoothstep(0.3, 0.85, fpB)) * nr * (1.0 - sea * 0.5);
    // crest strokes: a contour line of the ripple height field (thin wavy lines), in wind patches
    float gustW = smoothstep(0.35, 0.75, texture(tWNoise, p / 220.0 + uWind * uTime * 0.0006 + 0.2).r);
    float crest = (1.0 - smoothstep(0.0, 0.05, abs(rn.y - 0.64))) * (0.35 + 0.65 * gustW);
    float trough = smoothstep(0.42, 0.2, rn.y);
    col = mix(col, col * 0.92, trough * 0.6 * strokeK);
    col += mix(refl, atmoCloudLit, 0.3) * crest * 0.2 * strokeK * cs;
  }

  // foam: hard-edged bank line, sandbars, rapids; sea surf lines moving to the shore
  float n1 = texture(tWNoise, p / 40.0 + vec2(uTime * 0.01, 0.0)).r, n2 = texture(tWNoise, p / 11.0 - flow * uTime * 0.02).r;
  // metres per pixel: bank foam, sandbar rings and rapids are a metre wide, so from altitude they turned into white
  // sub-pixel specks on every painted sandbar; they fade out as the pixel footprint grows past their width
  float fp = length(fwidth(p));
  float fpK = mix(1.0, 1.0 - smoothstep(0.9, 2.2, fp), uFoamFp);
  float bank = 1.0 - smoothstep(0.0, mix(0.45, 0.35, sea), depth);
  float foam = step(0.62, bank + ((n1 - 0.5) * 0.5 + (n2 - 0.5) * 0.3) * (1.0 - 0.7 * sea)) * mix(fpK, 1.0, sea);
  float rapids = river * smoothstep(1.3, 2.2, speed) * step(0.72, n2 + n1 * 0.3) * fpK;
  float surfBand = 0.0;
  if (sea > 0.01) {
    // white surf lines parallel to the shore, rolling in (depth grows with distance offshore on the shelf)
    float w1 = texture(tWNoise, p / 420.0 + 0.3).r, w2 = texture(tWNoise, p / 140.0 + 0.7).r;
    float dd = depth * 1.9 + (w1 - 0.5) * 0.6 + (w2 - 0.5) * 0.2;
    float line = fract(dd - uTime * 0.12);
    float width = mix(0.72, 0.88, smoothstep(0.2, 2.2, depth));
    surfBand = smoothstep(width, width + 0.03, line) * (1.0 - smoothstep(0.96, 1.0, line));
    surfBand *= (1.0 - smoothstep(1.6, 2.8, depth)) * smoothstep(0.03, 0.15, depth);
    surfBand *= step(0.32, texture(tWNoise, p / 90.0 + vec2(0.0, uTime * 0.004)).r);
    // wave crests offshore: small white caps
    surfBand = max(surfBand, step(0.93, n2) * step(0.45, vCrest) * (1.0 - smoothstep(800.0, 2500.0, dist)));
    // from far away the separate lines alias: they merge into the white surf zone along the coast (key art)
    float zone = smoothstep(0.02, 0.18, depth) * (1.0 - smoothstep(0.9, 2.4, depth)) * mix(0.55, 1.0, w2);
    surfBand = mix(surfBand, zone * 0.62, smoothstep(0.7, 2.5, fp));
  }
  if (nr > 0.0 && sea < 0.99) {
    // near style: the shore line is found from the real distance to the waterline (depth / bed slope), so broad
    // shallow flats get no noise speckles; a crisp white line at the bank and a second broken line lapping in and out
    float shoreD = 1.0e3;
    if (depth < 2.5) {
      float gx = worldHW(p + vec2(2.0, 0.0)).x - worldHW(p - vec2(2.0, 0.0)).x;
      float gz = worldHW(p + vec2(0.0, 2.0)).x - worldHW(p - vec2(0.0, 2.0)).x;
      shoreD = depth / max(length(vec2(gx, gz)) * 0.25, 0.004);
    }
    float lineW = 1.2 + 0.9 * n1;
    float fpF = 1.0 - smoothstep(lineW * 0.7, lineW * 2.0, fp);          // at least ~1 px wide, or it fades
    float shore = 1.0 - smoothstep(lineW * 0.5, lineW, shoreD + (n2 - 0.5) * 0.8);
    float lap = 3.0 + 1.6 * sin(uTime * 0.8 + n1 * 6.2831);
    float lapL = (1.0 - smoothstep(0.3, 0.7, abs(shoreD - lap))) * step(0.42, n2) * 0.85;
    float foamN = max(shore, lapL) * fpF;
    foam = mix(foam, foamN, nr);
  }
  float fm = clamp(max(max(foam, rapids * 0.9), surfBand * uSurf) * uFoam, 0.0, 1.0);
  vec3 foamC = mix(srgb(vec3(0.75, 0.83, 0.93)), vec3(1.0), smoothstep(0.0, 0.2, dot(vec3(0, 1, 0), L)) * cs);
  col = mix(col, foamC * (sun * 0.3 + vec3(0.62, 0.66, 0.74) * clamp(skyLum / 0.358, 0.3, 1.4)), fm);

  // sun glints: a broad glitter road + discrete HDR sparkles
  vec3 H = normalize(L + V);
  float nh = clamp(dot(N, H), 0.0, 1.0);
  float cellSize = 0.5 + 0.0035 * dist;
  vec2 cell = floor(p / cellSize);
  float rnd = hash12(cell + floor(uTime * 7.0 + hash12(cell) * 7.0));
  float sparkle = step(0.985, rnd) * smoothstep(0.94, 0.995, nh);
  float spec = pow(nh, 900.0) * 12.0 + pow(nh, 80.0) * 0.45 + sparkle * 5.0;
  col += sun * spec * uGlint * cs * (1.0 - fm);

  vec3 preAtmo = col;
  // aerial perspective (atmoApplyK is affine in the colour: A(c) = M(c)·T + H). The in-scattered haze H gets the same
  // hue guard as the reflection, so a lavender preset haze never repaints the far sea violet.
  vec3 hz = atmoApplyK(vec3(0.0), vW, uHaze);
  col = atmoApplyK(col * atmoSurface, vW, uHaze) - hz;      // (levels update: moonlit at night)
  float warmHz = smoothstep(0.35, 0.95, hz.r / max(hz.b, 1e-4));
  col += mix(hz, vec3(dot(hz, vec3(0.2126, 0.7152, 0.0722))) * vec3(0.7, 0.93, 1.25), warmHz * 0.6);
  col = worldFarFade(col, vW);            // wave 5: the far sea melts into the horizon apron (terrain/shaders.js)
  if (uDebug > 0.5 && uDebug < 1.5) col = vec3(surfBand, sea, depth / 3.0);
  else if (uDebug > 1.5 && uDebug < 2.5) col = body;          // unlit body colour, no haze
  else if (uDebug > 2.5 && uDebug < 3.5) col = preAtmo;       // lit + reflection + foam, no haze
  else if (uDebug > 3.5 && uDebug < 4.5) col = vec3(F);
  else if (uDebug > 4.5 && uDebug < 5.5) col = vec3(cov);
  else if (uDebug > 5.5 && uDebug < 6.5) col = vec3(fp / 4.0, fpK, 0.0);
  else if (uDebug > 6.5 && uDebug < 7.5) col = vec3(pw, skyPix, clamp(tRef / 2000.0, 0.0, 1.0));   // planar weight, sky, distance
  else if (uDebug > 7.5 && uDebug < 8.5) col = planar;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
}

const NO_SHADOW = /* glsl */`float cloudShadow(vec3 p) { return 1.0; }`;

// ---- wave 4: planar reflection ------------------------------------------------------------------------------------
// A mirrored copy of the main camera about the plane y = h (the water level where the player looks), with an oblique
// near plane on the water (Lengyel), renders the scene without the water into a half-resolution HDR target + depth.
// The target is mipmapped: far reflections blur a little. It runs as a late system (order 98.5): after the camera rig
// (80) and the terrain LOD selection (98, which the mirror reuses), before the pipeline draws the frame.
function createReflection(game, water) {
  const q = game.quality || {};
  const scale = { low: 0.3, medium: 0.4, high: 0.5, ultra: 0.6 }[q.name] ?? 0.5;
  const R = {
    enabled: WAVE4 && q.reflections !== false && (q.reflection ?? scale) > 0,
    scale: q.reflection ?? scale,
    target: null, camera: new THREE.PerspectiveCamera(), plane: 0, planeTarget: 0, weight: 0, near: 0, active: false,
    // render every Nth frame (medium / low: every 2nd). The lookup always uses the matrices the target was drawn
    // with, so static banks stay exact between updates; only moving things in the mirror lag a frame
    every: { low: 2, medium: 2 }[q.name] ?? 1,
    stats: { w: 0, h: 0, ms: 0, calls: 0, tris: 0, frames: 0, skipped: '' },
  };
  let tick = 0;
  const vc = R.camera;
  vc.layers.set(0);                                           // FX layer (fire, sparks, speed lines) never reflects
  const _n = new THREE.Vector3(0, 1, 0), _p = new THREE.Vector3(), _v = new THREE.Vector3(), _t = new THREE.Vector3();
  const _look = new THREE.Vector3(), _rot = new THREE.Matrix4(), _plane = new THREE.Plane(), _clip = new THREE.Vector4(), _q = new THREE.Vector4();
  const _clear = new THREE.Color(), _f = new THREE.Vector3();
  let lastT = 0;

  function alloc() {
    const sz = game.size || { w: 1440, h: 900 };
    const w = Math.max(64, Math.min(1280, Math.round(sz.w * R.scale))), h = Math.max(48, Math.min(800, Math.round(sz.h * R.scale)));
    if (R.target && R.stats.w === w && R.stats.h === h) return;
    R.target?.dispose();
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType, depthBuffer: true, generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    });
    rt.depthTexture = new THREE.DepthTexture(w, h, THREE.FloatType);
    rt.texture.name = 'water.reflection';
    R.target = rt; R.stats.w = w; R.stats.h = h;
    const u = water.uniforms;
    if (u) { u.tRefl.value = rt.texture; u.tReflDepth.value = rt.depthTexture; }
  }

  // Mirror height: the water level where the player looks (the view ray's ground point, points ahead, under the
  // camera), nearer points weigh more.
  function pickPlane(cam) {
    const W = game.world.waterLevelAt, G = game.world.heightAt;
    if (!W || !G) return null;
    cam.getWorldDirection(_f);
    const hl = Math.hypot(_f.x, _f.z) || 1, fx = _f.x / hl, fz = _f.z / hl;
    let acc = 0, wsum = 0;
    const add = (x, z, wt) => { const w = W(x, z); if (w > G(x, z) + 0.05) { acc += w * wt; wsum += wt; } };
    add(cam.position.x, cam.position.z, 1.2);
    for (const d of [60, 150, 300, 600, 1100]) add(cam.position.x + fx * d, cam.position.z + fz * d, 1 / (1 + d / 250));
    if (_f.y < -0.05) {                                       // where the view centre meets the ground / water
      const gy = Math.max(G(cam.position.x, cam.position.z), W(cam.position.x, cam.position.z));
      const t = Math.min(4000, (cam.position.y - gy) / -_f.y);
      add(cam.position.x + _f.x * t, cam.position.z + _f.z * t, 2.0);
    }
    return wsum > 0 ? acc / wsum : null;
  }

  function render(realDt) {
    const u = water.uniforms, cam = game.camera, r = game.renderer;
    if (!u) return;
    const agl = cam.position.y - (game.world.surfaceAt ? game.world.surfaceAt(cam.position.x, cam.position.z) : 0);
    // near style follows the camera's height above the ground / water (full below ~450 m, gone by ~1 km)
    R.near += ((WAVE4 ? 1 - smoothstep(450, 1000, agl) : 0) - R.near) * damp(3, realDt || 0.016);
    u.uRefl.value.z = R.near;
    if (!R.enabled || !r) { u.uRefl.value.x = 0; R.stats.skipped = 'off'; return; }
    const target = pickPlane(cam);
    if (target !== null) {
      R.planeTarget = target;
      if (!R.active || Math.abs(target - R.plane) > 12) R.plane = target;
      else R.plane += (target - R.plane) * damp(4, realDt || 0.016);
    }
    const h = R.plane, above = cam.position.y - h;
    const want = water.stats.nodes > 0 && target !== null && above > 0.8 ? 1 - smoothstep(650, 1000, above) : 0;
    R.weight += (want - R.weight) * damp(want > R.weight ? 6 : 3, realDt || 0.016);
    if (R.weight < 0.01 || above <= 0.8) { R.active = false; u.uRefl.value.x = 0; R.stats.skipped = want ? 'fade' : 'no water in view'; return; }
    alloc();
    if (R.active && R.every > 1 && (tick++ % R.every) !== 0) { u.uRefl.value.x = R.weight; return; }
    const t0 = performance.now();
    try {
      // virtual camera: mirror position, look target and up about the plane
      cam.updateMatrixWorld();
      _p.set(0, h, 0);
      _v.copy(_p).sub(_t.setFromMatrixPosition(cam.matrixWorld)).reflect(_n).negate().add(_p);   // (x, 2h − y, z)
      _rot.extractRotation(cam.matrixWorld);
      _look.set(0, 0, -1).applyMatrix4(_rot).add(_t.setFromMatrixPosition(cam.matrixWorld));
      _t.copy(_p).sub(_look).reflect(_n).negate().add(_p);
      vc.position.copy(_v);
      vc.up.set(0, 1, 0).applyMatrix4(_rot).reflect(_n);
      vc.lookAt(_t);
      vc.near = cam.near; vc.far = cam.far; vc.fov = cam.fov; vc.aspect = cam.aspect; vc.zoom = cam.zoom;
      vc.updateMatrixWorld();
      vc.projectionMatrix.copy(cam.projectionMatrix);
      // oblique near plane = the water plane (only what is above the water is drawn)
      _plane.setFromNormalAndCoplanarPoint(_n, _p).applyMatrix4(vc.matrixWorldInverse);
      _clip.set(_plane.normal.x, _plane.normal.y, _plane.normal.z, _plane.constant);
      const e = vc.projectionMatrix.elements;
      _q.set((Math.sign(_clip.x) + e[8]) / e[0], (Math.sign(_clip.y) + e[9]) / e[5], -1, (1 + e[10]) / e[14]);
      _clip.multiplyScalar(2 / _clip.dot(_q));
      e[2] = _clip.x; e[6] = _clip.y; e[10] = _clip.z + 1 - 0.003; e[14] = _clip.w;
      vc.projectionMatrixInverse.copy(vc.projectionMatrix).invert();
      u.uReflVP.value.multiplyMatrices(vc.projectionMatrix, vc.matrixWorldInverse);
      u.uReflVPInv.value.copy(u.uReflVP.value).invert();

      // draw: everything on layer 0 except the water itself and the petals; shadows are reused (not re-rendered)
      // (the vegetation lists what it leaves out of reflections: the far tree LOD — ~1 M triangles of thin far
      // bands in the mirror — and the petals)
      // (and the terrain's horizon apron: a draw the mirror does not need, its sky pixels use the analytic sky)
      const hide = [water.group, game.terrain?.horizon?.mesh, ...(game.vegetation?.reflectionHide || []), ...(above > 150 ? game.vegetation?.reflectionHideHigh || [] : [])].filter(Boolean);
      const vis = hide.map((o) => o.visible);
      for (const o of hide) o.visible = false;
      const prevRT = r.getRenderTarget(), prevAuto = r.autoClear, prevAlpha = r.getClearAlpha();
      r.getClearColor(_clear);
      const sm = r.shadowMap, prevSA = sm.autoUpdate, prevSN = sm.needsUpdate;
      sm.autoUpdate = false; sm.needsUpdate = false;
      const calls0 = r.info.render.calls, tris0 = r.info.render.triangles;
      try {
        r.setRenderTarget(R.target);
        r.autoClear = true;
        r.setClearColor(0x000000, 1);
        r.clear(true, true, false);
        r.render(game.scene, vc);
      } finally {
        R.stats.calls = r.info.render.calls - calls0; R.stats.tris = r.info.render.triangles - tris0;
        r.setRenderTarget(prevRT); r.autoClear = prevAuto; r.setClearColor(_clear, prevAlpha);
        sm.autoUpdate = prevSA; sm.needsUpdate = prevSN;
        hide.forEach((o, i) => { o.visible = vis[i]; });
      }
      R.active = true;
      u.uRefl.value.x = R.weight;
      u.uRefl.value.y = h;
      R.stats.frames++;
      R.stats.skipped = '';
    } catch (err) {
      // never throw from a system: switch the planar reflection off and keep the analytic one
      console.error('[water] reflection pass failed; planar reflection disabled', err);
      R.enabled = false; R.active = false; u.uRefl.value.x = 0;
    }
    R.stats.ms = R.stats.ms * 0.9 + (performance.now() - t0) * 0.1;
  }

  R.render = render;
  return R;
}

export default function createWater(game) {
  const water = { name: 'water', stats: { nodes: 0, tris: 0, refl: null }, material: null, uniforms: null, meshes: [] };
  let lists = null;

  function filterNodes() {
    const t = game.terrain, lod = t?.lod, data = t?.data;
    if (!lod || !data) return;
    const out = [lists.full, lists.half];
    const src = [lod.full, lod.half], n = [lod.nFull, lod.nHalf];
    let tris = 0, nodes = 0;
    for (let s = 0; s < 2; s++) {
      let m = 0;
      const a = src[s], o = out[s];
      for (let i = 0; i < n[s]; i++) {
        const k = i * 4, x0 = a[k], z0 = a[k + 1], size = a[k + 2];
        if (data.wetness(x0, z0, x0 + size, z0 + size) <= -0.05) continue;
        const j = m++ * 4; o[j] = x0; o[j + 1] = z0; o[j + 2] = size; o[j + 3] = a[k + 3];
      }
      const mesh = water.meshes[s], geo = mesh.geometry, attr = geo.getAttribute('aNode');
      attr.array.set(o.subarray(0, m * 4));
      attr.clearUpdateRanges(); attr.addUpdateRange(0, Math.max(4, m * 4)); attr.needsUpdate = true;
      geo.instanceCount = m;
      const G = s === 0 ? lod.grid : lod.grid / 2;
      tris += m * G * G * 2; nodes += m;
    }
    water.stats.nodes = nodes; water.stats.tris = tris;
  }

  water.init = async () => {
    const t = game.terrain;
    if (!t?.lod) { console.warn('[water] terrain not ready; water disabled'); return; }
    const lod = t.lod;
    lists = { full: new Float32Array(lod.maxNodes * 4), half: new Float32Array(lod.maxNodes * 4) };
    const shadow = game.clouds?.shadow;
    const atmoU = game.atmo ? game.atmo.uniforms : {};
    const tx = t.textures || {};
    const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); blank.needsUpdate = true;
    const blankDepth = new THREE.DataTexture(new Float32Array([1, 1, 1, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType); blankDepth.needsUpdate = true;
    const uniforms = {
      ...atmoU, ...(shadow?.uniforms || {}), ...t.uniforms,
      uMorph: t.materials[0].uniforms.uMorph,
      tFlowIn: { value: tx.flowIn || blank }, tFlowOut: { value: tx.flowOut || blank }, tAlbedo: { value: tx.albedo || blank },
      tRipple: { value: makeRippleTexture() },
      uGlint: { value: 1.0 }, uSurf: { value: 1.0 }, uFoam: { value: 1.0 }, uDebug: { value: 0 },
      uHaze: { value: 0.8 }, uFoamFp: { value: 1 }, uCloudRefl: { value: shadow ? 1.0 : 0.0 },
      atmoCloudLit: atmoU.atmoCloudLit || { value: new THREE.Color(1, 0.98, 0.94) },
      atmoCloudShade: atmoU.atmoCloudShade || { value: new THREE.Color(0.25, 0.32, 0.66) },
      // wave 4 planar reflection (textures are swapped in when the target is allocated)
      tRefl: { value: blank }, tReflDepth: { value: blankDepth },
      uReflVP: { value: new THREE.Matrix4() }, uReflVPInv: { value: new THREE.Matrix4() },
      uRefl: { value: new THREE.Vector4(0, 0, 0, 1.6) },
    };
    water.uniforms = uniforms;
    const fs = waterFS({ atmoChunk: game.atmo.chunk, shadowChunk: shadow?.chunk || NO_SHADOW });
    const mk = (grid) => {
      const mat = new THREE.ShaderMaterial({ name: 'water', uniforms: { ...uniforms, uGrid: { value: grid } }, vertexShader: WATER_VS, fragmentShader: fs });
      const geo = gridGeometry(grid);
      geo.setAttribute('aNode', new THREE.InstancedBufferAttribute(new Float32Array(lod.maxNodes * 4), 4).setUsage(THREE.DynamicDrawUsage));
      geo.instanceCount = 0;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false; mesh.matrixAutoUpdate = false;
      mesh.renderOrder = -5;                               // after the terrain: early-z rejects water under the ground
      mesh.name = 'water';
      mesh.onBeforeRender = (r, s, camera) => {                 // fallback when the late hook did not run
        if (camera !== game.camera) return;
        t.ensureSelection(camera);
        if (water._frame !== game.time.frame) { water._frame = game.time.frame; filterNodes(); }
      };
      return mesh;
    };
    water.meshes = [mk(lod.grid), mk(lod.grid / 2)];
    t.selectHooks.push(() => { water._frame = game.time.frame; filterNodes(); });
    water.material = water.meshes[0].material;
    const group = new THREE.Group(); group.name = 'water';
    group.add(...water.meshes);
    game.scene.add(group);
    water.group = group;
    // wave 4: planar reflection pass, after the camera rig and the terrain selection, before the pipeline
    const refl = createReflection(game, water);
    water.reflection = refl;
    water.stats.refl = refl.stats;
    game.add({ name: 'waterRefl', lateUpdate: (dt, realDt) => {
      try { refl.render(realDt); } catch (e) {            // a system never throws: fall back to the analytic reflection
        console.error('[water] reflection disabled', e); refl.enabled = false; if (water.uniforms) water.uniforms.uRefl.value.x = 0;
      }
    } }, 98.5);
  };

  return water;
}
