// Stateless GPU particles shared by fire.js and ambient.js (one engine per game, four draw calls in total).
// Each particle is one spawn record in a ring buffer; motion is closed-form in the vertex shader
// (linear drag k, vertical gravity/buoyancy g), so the CPU only writes new records:
//   p(t) = p0 + v0·e + g·(t − e)/k,  v(t) = v0·e^(−kt) + g·e,  e = (1 − e^(−kt))/k
// fire.js mirrors the same formula for breath damage packets, so what you see is what burns.
// Classes:
//   flame — noise-eroded tongues in stepped heat bands (white-hot → yellow → orange → red), inked rim, depth-written
//           (Sora's and the titan's fire far from the camera: the anime cel look)
//   soft  — wave 4: emissive soft-alpha flame (premultiplied, a little occlusion, no ink): the Shade Riders' violet
//           shadowfire everywhere, plus any fire near the camera (explosions, Sora's breath seen from behind)
//   smoke — wave 4: soft-edged two-tone puffs lit by the sun colour and sky ambient, dissipating (+ petals, cloud
//           wisps tinted with the live cloud colours); transparent, drawn after the clouds
//   glow  — premultiplied additive: soft glow, star flash, shockwave ring, spark streak, wisp
// soft and smoke never blind the player: an on-screen size fade/clamp and a capsule around the camera→player segment
// (uGuard) fade whatever sits between the lens and Sora.
// Shapes animate "on twos" (stepped noise time at 12 fps) while motion runs at the full frame rate (anime look).
import * as THREE from 'three';
import { getTextures } from './textures.js';

export const STRIDE = 24;
export const GLOW = { soft: 0, star: 1, ring: 2, streak: 3, wisp: 4, blade: 5, heat: 6, sparkle: 7 };
// Smoke rows. dark = the player's charcoal smoke, shadow = Shade Riders / drakes (deep indigo-violet),
// aceShadow = the onyx ace (blue-indigo), titan = light warm ash glowing molten from below (wave 5).
// leaf (flight moves): green leaves torn up when Sora skims the treetops (petal shape, P.shape = 1).
// Levels and elements: azure (Sora's blue flame: cool slate smoke glowing blue), radiant (white-gold flame: pale warm ash
// glowing gold). Lightning makes no smoke.
export const SMOKE = { dark: 0, grey: 1, white: 2, spray: 3, petal: 4, titan: 5, soot: 6, dust: 7, shadow: 8, aceShadow: 9, puff: 10, cloud: 11, leaf: 12,
  azure: 13, radiant: 14 };
const SMOKE_N = 15;

// Smoke palettes: lit, shade (sRGB hex, converted to linear) and fire-glow tint for young smoke. No lavender greys:
// the player's smoke is a warm charcoal with a cool (not violet) shadow; only the Shade Riders' smoke is violet.
// Wave 4: the dark rows are lighter (the shade of the charcoal is #4a4458, not near-black) and every row has a maximum
// opacity (≤ 0.5 for every fire smoke row: charcoal, grey, titan soot, soot, shadow), so a smoke column never reads
// as a black cardboard blot.
// Row 11 (cloud) is rewritten every frame from the live cloud colours (atmoCloudLit / atmoCloudShade).
// Wave 5: the titan's smoke (row 5) is a light warm ash (#b49c98 / #6e585c, was a crimson-black soot #76585a /
// #3e2a2e that read as red-brown splotches on the white clouds), its young smoke glows molten orange instead of red,
// and its opacity is 0.42.
const SMOKE_LIT = [0x8a807a, 0x9e9894, 0xfffaf0, 0xf4fbff, 0xffd0dc, 0xb49c98, 0x60565c, 0xd8c8a8, 0x6a6080, 0x5a6484, 0xc8c2bc, 0xfffaf0, 0x8cc050, 0x8c9aae, 0xd2c6b2];
const SMOKE_SHADE = [0x4a4458, 0x5e5b66, 0x8a9ad4, 0x9fb4e0, 0xd87a9c, 0x6e585c, 0x3a3440, 0x8a7a70, 0x3a3252, 0x323a56, 0x6c6a74, 0x96b6d4, 0x3a6a34, 0x4a5672, 0x7e7466];
const SMOKE_GLOW = [0xff7a20, 0xff8a30, 0xffc080, 0xffffff, 0xffffff, 0xff8a38, 0xff6010, 0xffa060, 0x7a3cd0, 0x4064d8, 0xffa050, 0x000000, 0x000000, 0x4aa8ff, 0xffd070];
const SMOKE_ALPHA = [0.5, 0.5, 0.5, 0.7, 1.0, 0.42, 0.5, 0.6, 0.5, 0.5, 0.5, 0.42, 1.0, 0.42, 0.38];

const FALLBACK_ATMO = /* glsl */`
vec3 atmoApply(vec3 col, vec3 p) { return col; }
`;

const VERT = /* glsl */`
attribute vec4 aP;   // p0.xyz, seed
attribute vec4 aV;   // v0.xyz, life
attribute vec4 aT;   // t0, row, shape, intensity
attribute vec4 aS;   // size0, size1, rot0, spin
attribute vec4 aM;   // drag k, gravity y, stretch (s of motion; < 0 = tip points against velocity), grow power
attribute vec4 aX;   // heat0, cool, fade-in (fraction of life), w: smoke = petal squash, flame = fan m/s, glow = pull (m)
uniform float uTime, uStepFps, uMaxScreen, uStretchComp;
uniform vec4 uGuard;     // xyz: the end of the camera→player guard segment (just in front of Sora), w: radius (0 = off)
uniform vec3 uFade;      // on-screen size fade: x = start, y = end (radius / view height), z = floor
uniform float uGuardMin; // opacity left inside the guard capsule (uGuardWeak for records flagged "weak": blasts)
varying vec2 vQ;
varying float vFade;
varying vec4 vInfo;    // age, seed, row, shape
varying vec4 vInfo2;   // intensity, heat0, cool, fade-in
varying vec3 vFogT, vFogAdd;
varying float vShapeT, vDepth;
varying vec4 vAxes;
__ATMO__
void main() {
  float t = uTime - aT.x;
  float life = aV.w;
  float a = t / max(life, 1e-4);
  if (t < 0.0 || a >= 1.0 || life <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float k = max(aM.x, 0.0);
  float kt = k * t, e, tme, ek;
  if (kt < 0.02) { e = t * (1.0 - 0.5 * kt + kt * kt / 6.0); tme = t * t * (0.5 - kt / 6.0); ek = 1.0 - kt + 0.5 * kt * kt; }
  else { ek = exp(-kt); e = (1.0 - ek) / k; tme = (t - e) / k; }
  vec3 g = vec3(0.0, aM.y, 0.0);
  vec3 p = aP.xyz + aV.xyz * e + g * tme;
  vec3 v = aV.xyz * ek + g * e;

  float gp = aM.w > 0.0 ? aM.w : 2.5;
  float grow = 1.0 - pow(1.0 - a, gp);
#ifdef GLOW_CLASS
  if (abs(aT.z - 2.0) < 0.5) grow = 1.0 - exp2(-9.0 * a);        // shockwave ring: easeOutExpo
#endif
  float size = mix(aS.x, aS.y, grow);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float depth = -mv.z;
#if defined(FLAME_CLASS)
  // Chase-view readability: a stream seen along its axis (from behind or the front) foreshortens into a blob, so
  // flame tongues fan out radially in the view plane at aX.w m/s (decelerated by the same drag), only as much as the
  // launch velocity points along the view axis. Side views are unchanged. The fan stays inside the breath's real
  // hit radius (0.8 + 0.2 m per metre), so the wider cone is honest.
  if (aX.w > 0.0) {
    vec3 vv0 = mat3(viewMatrix) * aV.xyz;
    float sp0 = length(vv0);
    float fore = sp0 > 1e-3 ? smoothstep(0.45, 0.96, abs(vv0.z) / sp0) : 0.0;
    float ph = aP.w * 43.73;
    vec2 rd = vec2(cos(ph), sin(ph) * 0.7) * sqrt(fract(aP.w * 91.31));   // a little wider than tall
    mv.xy += rd * (aX.w * fore * e);
  }
#endif
  vFade = 1.0;
  float guardF = 1.0;
#if defined(SOFT_CLASS) || defined(SMOKE_CLASS)
  // Never blind the player (wave 4). A particle that would cover a large part of the view fades (by the radius it
  // WANTS, before the clamp below; redone with the streak's area further down), and anything inside a capsule around
  // the camera→Sora segment fades to uGuardMin.
  float rsWant = 0.5 * size * projectionMatrix[1][1] / max(depth, 0.05);
  vFade = mix(uFade.z, 1.0, 1.0 - smoothstep(uFade.x, uFade.y, rsWant));
  if (uGuard.w > 0.0) {
#ifdef SOFT_CLASS
    float gmin = aT.z > 1.5 ? 0.6 : uGuardMin;    // the opacity slot carries +2 for weakly guarded records
#else
    float gmin = aX.y > 1.5 ? 0.6 : uGuardMin;
#endif
    vec3 ab = uGuard.xyz - cameraPosition;
    float h = clamp(dot(p - cameraPosition, ab) / max(dot(ab, ab), 1e-4), 0.0, 1.0);
    float dc = length(p - cameraPosition - ab * h) - 0.6 * size;
    float R = uGuard.w * mix(1.0, 0.5, h);                                    // 6 m at the lens, 3 m at Sora
    guardF = mix(gmin, 1.0, smoothstep(0.35 * R, R, dc));
  }
#endif
#ifdef SMOKE_CLASS
  if (aT.z > 0.5) guardF *= smoothstep(1.2, 4.5, depth);                    // petals: no pink capsules at the lens
#endif
  size = min(size, uMaxScreen * max(depth, 0.0) / projectionMatrix[1][1]);   // screen-size clamp (overdraw)
  size *= smoothstep(0.4, 2.2, depth);                                        // shrink at the near plane

  vec2 q = position.xy * 2.0;
  float rot = aS.z + aS.w * t;
  vec2 dir = vec2(-sin(rot), cos(rot));
  float along = size, across = size;
  float stretch = aM.z;
  if (stretch != 0.0) {
    vec3 vv = mat3(viewMatrix) * v;
    vec2 sv = vv.xy + mv.xy * vv.z / max(depth, 0.05);   // apparent (perspective) velocity at this depth
    float L = length(sv);
    float w = smoothstep(0.4, 3.0, L);
    vec2 d = L > 1e-5 ? sv / L : dir;
    if (stretch < 0.0) d = -d;
    dir = normalize(mix(dir, d, w) + vec2(1e-5, 0.0));
    // foreshortening compensation: motion along the view axis still streaks a little (toward its vanishing point),
    // so a stream seen from behind shows converging tongues instead of round blobs
    float Leff = mix(L, length(vv), uStretchComp);
    // the streak length is clamped like the size: next to the camera the apparent velocity explodes (1/depth), which
    // would turn one flame into a screen-wide bar
    float sl = min(Leff * abs(stretch) * w, max(size * 8.0, 0.2));
    sl = min(sl, 0.35 * depth) * smoothstep(0.4, 2.2, depth);
    // wave 4: moving away from the camera, a motion streak can only reach toward its own vanishing point, never past
    // it. Without this, a stream seen from behind (the chase camera sits ~4 m off its axis, so 40 m of stream project
    // to ~60 px) grew a crown of spikes poking up past the reticle — the "burning bush on the head".
    if (stretch > 0.0 && vv.z < -1e-3) sl = min(sl, 0.8 * length(vv.xy * (depth / -vv.z) - mv.xy));
    along = min(size + sl, 1.5 * uMaxScreen * depth / projectionMatrix[1][1]);
  }
#ifdef SMOKE_CLASS
  across *= mix(1.0, abs(cos(rot * 1.7)) * 0.85 + 0.15, aX.w);   // petals: tumbling squash
#endif
#if defined(SOFT_CLASS) || defined(SMOKE_CLASS)
  // the fade above only saw the round size; a long motion streak covers more of the view, so the same fade also
  // applies to the streak's area-equivalent radius (a stream crossing the chase view at 8-15 m streaks a lot)
  float rsArea = 0.5 * sqrt(along * across) * projectionMatrix[1][1] / max(depth, 0.05);
  vFade = min(vFade, mix(uFade.z, 1.0, 1.0 - smoothstep(uFade.x, uFade.y, rsArea))) * guardF;
#endif
  vec2 side = vec2(dir.y, -dir.x);
  mv.xy += side * q.x * across + dir * q.y * along;
#ifdef GLOW_CLASS
  mv.z += min(aX.w, depth * 0.5);                                  // pull toward the camera (glow over flame bodies)
#endif
  gl_Position = projectionMatrix * mv;

  vQ = q;
  vAxes = vec4(side, dir);
  vInfo = vec4(a, aP.w, aT.y, aT.z);
  vInfo2 = vec4(aT.w, aX.x, aX.y, aX.z);
  vShapeT = floor(uTime * uStepFps) / uStepFps;
  vDepth = depth;
  vFogAdd = atmoApply(vec3(0.0), p);
  vFogT = atmoApply(vec3(1.0), p) - vFogAdd;
}
`;

const FRAG_COMMON = /* glsl */`
uniform sampler2D uNoise, uRamp;
uniform float uRows;
varying vec2 vQ;
varying vec4 vInfo, vInfo2;
varying vec3 vFogT, vFogAdd;
varying float vShapeT, vDepth;
varying vec4 vAxes;      // quad x / y axes in view space (for lighting)
float aa(float e, float x) { float w = max(fwidth(x), 1e-4); return smoothstep(e - w, e + w, x); }
vec3 ramp(float row, float heat) { return texture2D(uRamp, vec2(clamp(heat, 0.0, 1.0) * (63.0 / 64.0) + 0.5 / 64.0, (row + 0.5) / uRows)).rgb; }
`;
// Soft-particle depth fade for the transparent classes (FX pass: the depth texture is not the render target's).
const SOFT_DEPTH = /* glsl */`
#include <packing>
uniform sampler2D uDepth;
uniform float uSoft, uNear, uFar;
uniform vec2 uInvRes;
float softDepth(float range) {
  if (uSoft < 0.5) return 1.0;
  float sd = texture2D(uDepth, gl_FragCoord.xy * uInvRes).x;
  float sceneZ = -perspectiveDepthToViewZ(sd, uNear, uFar);
  return clamp((sceneZ - vDepth) / range, 0.0, 1.0);
}
`;

const FRAG_FLAME = FRAG_COMMON + /* glsl */`
void main() {
  float age = vInfo.x, seed = vInfo.y, row = vInfo.z;
  vec2 q = vQ;
  vec2 uv = q * 0.5 + 0.5;
  vec2 dq = texture2D(uNoise, uv * 0.42 + vec2(seed * 7.13, seed * 3.37 - vShapeT * 0.85)).gb - 0.5;
  vec2 w = q + dq * 0.6;
  // teardrop body: round base, tongue tapering toward +y (the flow direction)
  float taper = mix(0.95, 0.24, smoothstep(-0.6, 1.0, w.y));
  float d = length(vec2(w.x / taper, w.y * 0.86 + 0.16)) * 1.12;
  float body = 1.0 - d;
  // flow-aligned noise (features stretched along the tongue) → licking tongues, holes as it ages
  float n = texture2D(uNoise, uv * vec2(0.75, 0.32) + vec2(seed * 13.7, seed * 5.1 - vShapeT * 1.45)).r;
  float n2 = texture2D(uNoise, uv * vec2(1.6, 0.8) + vec2(seed * 3.9 + vShapeT * 0.3, seed * 9.7 - vShapeT * 2.2)).r;
  float v = body + (n - 0.5) * 1.05 + (n2 - 0.5) * 0.35 - age * age * 1.05 - age * 0.22 - age * age * age * 0.9;
  v -= (1.0 - smoothstep(2.5, 9.0, vDepth)) * 1.3;   // erode next to the camera: a stream through the lens never blinds
  // wave 4: young tongues of a stream seen from behind stay thin (no billow at the mouth); vInfo.w = amount
  v -= vInfo.w * (1.0 - smoothstep(0.08, 0.36, age)) * 1.3;
  v = min(v, (0.97 - length(q)) * 3.0);             // never touch the quad edge (no straight cuts)
  float heat = vInfo2.y * pow(max(1.0 - age, 0.0), 0.6 + vInfo2.z);
  // wave 5: the titan's molten fire (row 2) burns out once it has cooled into its scarlet / crimson bands — the
  // tongue shrinks away and the (light ash) smoke takes over — instead of lingering as flat crimson fragments that
  // read as opaque red smoke splotches after every titan fireball impact
  if (abs(row - 2.0) < 0.5) v -= (1.0 - smoothstep(0.26, 0.52, heat)) * 1.1;
  float alpha = aa(0.0, v);
  if (alpha < 0.5) discard;
  // inner heat has its own noisy shape (biased to the tongue's root) so bands are not concentric onion rings
  float n3 = texture2D(uNoise, uv * vec2(0.9, 0.55) + vec2(seed * 2.3 - vShapeT * 0.2, seed * 7.9 - vShapeT * 1.9)).b;
  float inner = 1.0 - length(vec2(w.x * 1.1, w.y * 0.9 + 0.3)) + (n3 - 0.5) * 1.1;
  float local = heat * mix(0.34, 1.1, clamp(min(inner * 1.8 + 0.25, v * 3.0), 0.0, 1.0));
  // stepped bands (anime cel fire), anti-aliased band edges
  float lv = (aa(0.22, local) + aa(0.44, local) + aa(0.66, local) + aa(0.88, local)) * 0.25;
  vec3 col = ramp(row, 0.3 + 0.7 * lv) * vInfo2.x;
  col *= mix(0.5, 1.0, aa(0.075, v));              // thin darker "inked" rim
  col = col * vFogT + vFogAdd;
  gl_FragColor = vec4(col, alpha);
}
`;

// Wave 4 — emissive soft-alpha fire (premultiplied "over" with little occlusion, no ink rim). The same tongue shape as
// the cel flame, but a soft edge, a continuous heat gradient with a bright core, and an opacity that follows the
// particle's age, its on-screen size and the camera guard (vFade). Used for the Shade Riders' violet shadowfire
// (dark violet body, magenta-white core) and for any fire that comes close to the camera.
const FRAG_SOFT = FRAG_COMMON + SOFT_DEPTH + /* glsl */`
varying float vFade;
uniform float uOcc;
void main() {
  float age = vInfo.x, seed = vInfo.y, row = vInfo.z;
  float opacity = vInfo.w > 1.5 ? vInfo.w - 2.0 : vInfo.w > 0.0 ? vInfo.w : 1.0;   // per-particle opacity (shape slot)
  vec2 q = vQ;
  vec2 uv = q * 0.5 + 0.5;
  vec2 dq = texture2D(uNoise, uv * 0.42 + vec2(seed * 7.13, seed * 3.37 - vShapeT * 0.85)).gb - 0.5;
  vec2 w = q + dq * 0.55;
  float taper = mix(0.95, 0.3, smoothstep(-0.6, 1.0, w.y));
  float d = length(vec2(w.x / taper, w.y * 0.86 + 0.16)) * 1.08;
  float n = texture2D(uNoise, uv * vec2(0.75, 0.32) + vec2(seed * 13.7, seed * 5.1 - vShapeT * 1.45)).r;
  float n2 = texture2D(uNoise, uv * vec2(1.6, 0.8) + vec2(seed * 3.9 + vShapeT * 0.3, seed * 9.7 - vShapeT * 2.2)).r;
  float v = 1.0 - d + (n - 0.5) * 0.8 + (n2 - 0.5) * 0.3 - age * age * 0.75 - age * 0.18;
  v -= (1.0 - smoothstep(2.5, 9.0, vDepth)) * 0.9;  // thin out next to the lens
  v = min(v, (0.97 - length(q)) * 2.0);
  float cov = smoothstep(0.03, 0.26, v);            // soft edge, no ink (crisp enough to keep the tongue shapes)
  float life = smoothstep(0.0, max(vInfo2.w, 0.05), age) * (1.0 - smoothstep(0.4, 0.95, age));   // fade in (aX.z), out
  float heat = vInfo2.y * pow(max(1.0 - age, 0.0), 0.6 + vInfo2.z);
  // wave 5: cooled titan fire (row 2) fades out instead of hanging in the air as translucent red blobs
  bool titanRow = abs(row - 2.0) < 0.5;
  if (titanRow) life *= smoothstep(0.28, 0.56, heat);
  float k = cov * life * opacity * vFade;
  if (k < 0.004) discard;
  k *= softDepth(1.6);
  float n3 = texture2D(uNoise, uv * vec2(0.9, 0.55) + vec2(seed * 2.3 - vShapeT * 0.2, seed * 7.9 - vShapeT * 1.9)).b;
  float inner = 1.0 - length(vec2(w.x * 1.1, w.y * 0.9 + 0.3)) + (n3 - 0.5) * 0.9;
  // a wide heat range inside each tongue (dark edges, a hot heart) plus flickering hot veins, so overlapping soft
  // tongues still read as flame and not as a flat violet haze
  // (titan: a narrower range — scarlet / molten bodies, not crimson ones that read as red smoke)
  float local = heat * mix(titanRow ? 0.42 : 0.16, 1.2, clamp(inner * 1.9 + 0.1, 0.0, 1.0)) * mix(titanRow ? 0.8 : 0.58, 1.0, smoothstep(0.0, 0.5, v));
  local += 0.28 * heat * smoothstep(0.58, 0.86, n3) * smoothstep(0.05, 0.4, v);
  vec3 col = ramp(row, 0.1 + 0.9 * local) * vInfo2.x;
  float core = smoothstep(0.6, 0.95, local);
  // the dark body occludes (deep violet on sky and white clouds), the hot core is almost pure light
  // shadowfire (rows 1, 8) is mostly light; gold / molten fire drawn soft near the camera replaces more of the
  // background, so a translucent blast still reads against a white cloud
  float occK = (abs(row - 1.0) < 0.5 || abs(row - 8.0) < 0.5) ? uOcc : 0.92;
  float occ = k * occK * mix(1.0, 0.3, core) * mix(1.0, 0.8, smoothstep(0.0, 0.3, 1.0 - cov));
  occ *= mix(0.35, 1.0, smoothstep(5.0, 22.0, vDepth));   // near the lens it glows over the view instead of painting it
  gl_FragColor = vec4(col * k * vFogT + vFogAdd * occ, occ);
}
`;

const FRAG_SMOKE = FRAG_COMMON + SOFT_DEPTH + /* glsl */`
uniform vec3 uSunV, uSunTint, uAmbTint;
uniform float uNearCut;
uniform vec3 uLit[SMOKE_N], uShade[SMOKE_N], uGlowC[SMOKE_N];
uniform float uAlphaRow[SMOKE_N];
varying float vFade;
vec3 pick(vec3 arr[SMOKE_N], float r) {
  int i = int(r + 0.5);
  vec3 c = arr[0];
  for (int k = 1; k < SMOKE_N; k++) if (k == i) c = arr[k];
  return c;
}
float pickF(float arr[SMOKE_N], float r) {
  int i = int(r + 0.5);
  float c = arr[0];
  for (int k = 1; k < SMOKE_N; k++) if (k == i) c = arr[k];
  return c;
}
void main() {
  float age = vInfo.x, seed = vInfo.y, row = vInfo.z;
  vec2 p = vQ;
  vec3 lit = pick(uLit, row), shade = pick(uShade, row);
  vec3 col;
  float alpha;
  float opacity = vInfo2.z > 1.5 ? vInfo2.z - 2.0 : vInfo2.z > 0.0 ? vInfo2.z : 1.0;   // per-particle opacity (cool slot)
  if (vInfo.w > 0.5) {
    // petal: slim ellipse with a notch at the tip, soft two-tone
    vec2 e = vec2(p.x * 1.9, p.y * 1.05);
    float body = 1.0 - dot(e, e);
    float notch = smoothstep(0.0, 0.18, abs(p.x) * 1.6 + (0.92 - p.y) * 0.9);
    float v = min(body, notch - 0.05);
    alpha = aa(0.0, v) * vFade;
    if (alpha < 0.01) discard;
    col = mix(shade, lit, aa(0.0, p.x * 0.8 + p.y * 0.4 + (seed - 0.5)));
  } else {
    // Wave 4: a soft puff (no hard cut-out, no ink): two tones with a soft terminator, lit by the sun colour and the
    // sky ambient, fading in, then thinning and dissipating over its life.
    float r2 = dot(p, p);
    vec2 uv = p * 0.5 + 0.5;
    float cells = texture2D(uNoise, uv * 0.55 + vec2(seed * 3.1, seed * 1.7) + vec2(0.0, vShapeT * 0.02)).g;
    float n = texture2D(uNoise, uv * 0.8 + vec2(seed * 5.3, seed * 2.9 - vShapeT * 0.04)).r;
    float v = 1.0 - r2 + (cells - 0.5) * 0.7 + (n - 0.5) * 0.35 - smoothstep(0.3, 1.0, age) * 0.9;
    v -= (1.0 - smoothstep(4.0, 16.0, vDepth)) * uNearCut * 1.2;   // dissolve near the camera: smoke never blinds
    float cov = smoothstep(0.0, 0.55, v);
    float fin = vInfo2.w > 0.0 ? smoothstep(0.0, vInfo2.w, age) : smoothstep(0.0, 0.08, age);
    alpha = cov * fin * (1.0 - smoothstep(0.45, 1.0, age)) * opacity * pickF(uAlphaRow, row) * vFade;
    if (alpha < 0.004) discard;
    alpha *= softDepth(3.0);
    vec2 pv = vAxes.xy * p.x + vAxes.zw * p.y;       // quad coords → view-space xy
    vec3 nrm = normalize(vec3(pv * 0.95, sqrt(max(1.0 - r2, 0.04))));
    float l = dot(nrm, uSunV) + (cells - 0.5) * 0.5;
    col = mix(shade * uAmbTint, lit * uSunTint, smoothstep(-0.2, 0.4, l));
    // backlit silhouette rim (anime): a soft bright edge on the side facing away from the sun
    float back = clamp(-uSunV.z, 0.0, 1.0);
    float rim = (1.0 - smoothstep(0.1, 0.3, v)) * smoothstep(0.0, 0.1, v) * smoothstep(-0.1, 0.2, dot(pv, uSunV.xy));
    col = mix(col, lit * uSunTint * 1.2, rim * back * 0.6);
    // young smoke glows from the fire below it
    float glow = vInfo2.y * (1.0 - smoothstep(0.0, 0.35, age)) * (1.0 - smoothstep(-0.2, 0.4, l) * 0.6);
    col += pick(uGlowC, row) * glow * 0.7;
  }
  col *= vInfo2.x;
  gl_FragColor = vec4((col * vFogT + vFogAdd) * alpha, alpha);   // premultiplied
}
`;

const FRAG_GLOW = FRAG_COMMON + SOFT_DEPTH + /* glsl */`
void main() {
  float age = vInfo.x, seed = vInfo.y, row = vInfo.z, shape = vInfo.w;
  vec2 p = vQ;
  float r = length(p);
  float fadeIn = vInfo2.w > 0.0 ? smoothstep(0.0, vInfo2.w, age) : 1.0;
  float fade = fadeIn * (1.0 - smoothstep(0.55, 1.0, age));
  float heat = clamp(vInfo2.y - age * vInfo2.z, 0.0, 1.0);
  vec3 c = ramp(row, heat);
  float m;
  if (shape < 0.5) {                        // soft glow with a hot core
    float s = max(1.0 - r, 0.0);
    m = s * s * 0.55 + (1.0 - smoothstep(0.0, 0.32, r)) * 0.9;
  } else if (shape < 1.5) {                 // star flash
    float ang = atan(p.y, p.x) + seed * 6.2831;
    float spikes = pow(abs(cos(ang * 3.0)), 28.0) + 0.6 * pow(abs(cos(ang * 3.0 + 0.5236)), 60.0);
    float star = clamp((spikes * 0.9 + 0.08) / (r * 5.0 + 1e-3) - 0.3, 0.0, 3.0);
    float core = 1.0 - smoothstep(0.0, 0.2, r);
    m = (star * 0.55 + core * 2.0) * (1.0 - smoothstep(0.75, 1.0, r));
  } else if (shape < 2.5) {                 // shockwave ring, crisp and broken by noise
    float th = mix(0.075, 0.012, age);
    float rr = 1.0 - th;
    float band = 1.0 - aa(th, abs(r - rr));
    float ang = atan(p.y, p.x);
    float brk = texture2D(uNoise, vec2(cos(ang), sin(ang)) * 0.18 + vec2(seed, age * 0.25)).r;   // seamless around the ring
    m = band * mix(1.0, smoothstep(0.25 + age * 0.45, 0.45 + age * 0.45, brk), 0.8) * 1.3;
  } else if (shape < 3.5) {                 // spark streak: hot core line
    float ax = abs(p.x);
    m = (1.0 - smoothstep(0.0, 1.0, ax)) * (1.0 - p.y * p.y) * 1.2 + (1.0 - aa(0.25, ax)) * (1.0 - smoothstep(0.5, 1.0, abs(p.y)));
  } else if (shape < 4.5) {                 // wisp: soft stretched streak
    float ax = 1.0 - p.x * p.x, ay = 1.0 - p.y * p.y;
    m = ax * ax * ay * 0.6;
  } else if (shape < 5.5) {                 // blade: hard-edged hot core of a flame jet
    vec2 uv = p * 0.5 + 0.5;
    float n = texture2D(uNoise, uv * vec2(0.5, 0.25) + vec2(seed * 7.0, seed * 3.0 - vShapeT * 1.2)).r;
    float e = 1.0 - length(vec2(p.x * 1.15, p.y * 0.9)) + (n - 0.5) * 0.7;
    e = min(e, (0.97 - length(p)) * 3.0);
    m = aa(0.0, e) * 0.6 + aa(0.3, e) * 0.4;
  } else if (shape < 6.5) {                // heat shimmer (inferno): anime heat-haze strokes — 2–3 thin wavy lines
    // across the quad that ripple on twos; faint, so they read as shimmering air inside the super breath (fix pass:
    // hairlines, 0.6× as thick, tapering to nothing at both ends — they read as heavy "worms" before)
    float wv = sin(p.x * 6.5 + vShapeT * 9.0 + seed * 21.0) * 0.1 + sin(p.x * 13.0 - vShapeT * 6.0 + seed * 8.0) * 0.045;
    float y = (p.y + wv) * 1.3 + seed;
    float l = abs(fract(y) - 0.5);
    float line = 1.0 - smoothstep(0.03, 0.03 + max(fwidth(y) * 1.5, 0.02), l);
    float ax = 1.0 - p.x * p.x;
    m = line * ax * ax * (1.0 - smoothstep(0.55, 1.0, abs(p.y))) * 0.9;
  } else {                                  // sparkle (radiant fire, level-up): a 4-point anime twinkle star
    // two thin crossed spikes and a round hot heart; it twinkles (the spikes breathe) at its own phase
    float tw = 0.6 + 0.4 * sin(age * 34.0 + seed * 40.0);
    vec2 a = abs(p);
    float sx = (1.0 - smoothstep(0.0, 1.0, a.y)) * (1.0 - smoothstep(0.0, 0.05 + 0.07 * tw, a.x));
    float sy = (1.0 - smoothstep(0.0, 1.0, a.x)) * (1.0 - smoothstep(0.0, 0.05 + 0.07 * tw, a.y));
    float heart = exp(-r * r * 22.0);
    m = (max(sx, sy) * (0.55 + 0.6 * tw) + heart * 1.3) * (1.0 - smoothstep(0.85, 1.0, r));
  }
  float soft = softDepth(2.5);
  vec3 col = c * m * fade * vInfo2.x * soft * vFogT;
  gl_FragColor = vec4(col, 0.0);            // premultiplied, alpha 0 = additive
}
`;

class Pool {
  /** opSlot: record slot that carries P.opacity for this class (soft: the shape slot, smoke: the cool slot), or -1. */
  constructor(engine, name, capacity, material, renderOrder, opSlot = -1) {
    this.engine = engine;
    this.name = name;
    this.opSlot = opSlot;
    this.capacity = capacity;
    this.head = 0;
    this.dirtyStart = 0;
    this.dirtyCount = 0;
    this.spawned = 0;
    this.data = new Float32Array(capacity * STRIDE);
    for (let i = 0; i < capacity; i++) this.data[i * STRIDE + 7] = -1;   // life < 0 = dead
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const buf = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
    buf.setUsage(THREE.DynamicDrawUsage);
    this.buffer = buf;
    const names = ['aP', 'aV', 'aT', 'aS', 'aM', 'aX'];
    names.forEach((n, i) => geo.setAttribute(n, new THREE.InterleavedBufferAttribute(buf, 4, i * 4)));
    geo.instanceCount = capacity;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
    this.geometry = geo;
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.name = 'fx-' + name;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.onBeforeRender = (renderer) => engine.beforeRender(renderer, this);
  }

  /** Write one spawn record (from engine.P) into the ring buffer. */
  push(P) {
    const i = this.head;
    const o = i * STRIDE, d = this.data;
    d[o] = P.x; d[o + 1] = P.y; d[o + 2] = P.z; d[o + 3] = P.seed;
    d[o + 4] = P.vx; d[o + 5] = P.vy; d[o + 6] = P.vz; d[o + 7] = P.life;
    d[o + 8] = P.t0; d[o + 9] = P.row; d[o + 10] = P.shape; d[o + 11] = P.intensity;
    d[o + 12] = P.size0; d[o + 13] = P.size1; d[o + 14] = P.rot; d[o + 15] = P.spin;
    d[o + 16] = P.drag; d[o + 17] = P.grav; d[o + 18] = P.stretch; d[o + 19] = P.grow;
    d[o + 20] = P.heat; d[o + 21] = P.cool; d[o + 22] = P.fadeIn; d[o + 23] = P.fan > 0 ? P.fan : P.squash;
    // opacity (0..1] in the class's spare slot; +2 flags a weakly guarded record (explosions: 60 % in the capsule)
    if (this.opSlot >= 0) d[o + this.opSlot] = (P.opacity > 0 ? Math.min(P.opacity, 1) : 1) + (P.guardWeak ? 2 : 0);
    if (this.dirtyCount === 0) this.dirtyStart = i;
    this.dirtyCount = Math.min(this.capacity, this.dirtyCount + 1);
    this.head = (i + 1) % this.capacity;
    this.spawned++;
  }

  flush() {
    if (this.dirtyCount === 0) return;
    const buf = this.buffer;
    buf.clearUpdateRanges();
    const s = this.dirtyStart, n = this.dirtyCount, cap = this.capacity;
    if (s + n <= cap) buf.addUpdateRange(s * STRIDE, n * STRIDE);
    else {
      buf.addUpdateRange(s * STRIDE, (cap - s) * STRIDE);
      buf.addUpdateRange(0, (s + n - cap) * STRIDE);
    }
    buf.needsUpdate = true;
    this.dirtyCount = 0;
  }

  /** Kill every record (retry / checkpoint): the whole buffer is re-uploaded once. */
  clear() {
    for (let i = 0; i < this.capacity; i++) this.data[i * STRIDE + 7] = -1;
    this.dirtyStart = 0;
    this.dirtyCount = this.capacity;
  }

  /** Approximate live count (records whose life window contains now). Debug/tests only: O(capacity). */
  live(now) {
    let n = 0;
    for (let i = 0; i < this.capacity; i++) {
      const o = i * STRIDE, t = now - this.data[o + 8];
      if (t >= 0 && t < this.data[o + 7]) n++;
    }
    return n;
  }
}

const engines = new WeakMap();
const _up = new THREE.Vector3(0, 1, 0), _cp = new THREE.Vector3(), _gp = new THREE.Vector3();
/** out = white blended toward the hue of `c` by `sat`, at a clamped brightness (max channel of c × k in [lo, hi]). */
function tint(out, c, k, lo, hi, sat) {
  if (!c?.isColor) { out.setRGB(1, 1, 1); return; }
  const m = Math.max(c.r, c.g, c.b, 1e-4);
  const b = Math.min(hi, Math.max(lo, m * k));
  const h = (x) => (1 - sat + sat * (x / m)) * b;
  out.setRGB(h(c.r), h(c.g), h(c.b));
}

/** The shared particle engine for this game (created on first use; meshes are added to game.scene). */
export function getParticles(game) {
  if (engines.has(game)) return engines.get(game);
  const e = createEngine(game);
  engines.set(game, e);
  return e;
}

function createEngine(game) {
  const tex = getTextures(game);
  const atmo = game.atmo;
  const atmoChunk = atmo ? atmo.chunk : FALLBACK_ATMO;
  const q = Math.max(0.25, game.quality?.particles ?? 1);
  const shared = {
    uTime: { value: 0 },
    uStepFps: { value: 12 },
    uMaxScreen: { value: 0.45 },
    uStretchComp: { value: 0.35 },
    uNoise: { value: tex.noise },
    uRamp: { value: tex.ramp },
    uRows: { value: tex.rows },
  };
  const atmoU = atmo ? atmo.uniforms : {};
  const lin = (hex) => new THREE.Color(hex);   // r186: hex is sRGB and is converted to linear on construction
  const sunV = { value: new THREE.Vector3(0, 1, 0) };

  const vert = VERT.replace('__ATMO__', atmoChunk);
  const mkMat = (frag, defines, extra, opts) => new THREE.ShaderMaterial({
    uniforms: { ...shared, ...atmoU, ...extra },
    vertexShader: vert,
    fragmentShader: (atmo ? '' : '') + frag,
    defines,
    ...opts,
  });

  const flameMat = mkMat(FRAG_FLAME, { FLAME_CLASS: 1 }, {}, {
    transparent: false, depthWrite: true, depthTest: true,
    blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  });
  const dummyDepth = new THREE.DataTexture(new Float32Array([1, 1, 1, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  dummyDepth.needsUpdate = true;
  const glowU = {
    uDepth: { value: dummyDepth }, uSoft: { value: 0 }, uNear: { value: 0.5 }, uFar: { value: 60000 },
    uInvRes: { value: new THREE.Vector2(1, 1) },
  };
  // camera guard (wave 4): shared by the soft fire and smoke classes, updated in frame()
  const guard = { value: new THREE.Vector4(0, 0, 0, 0) };
  const sunTint = { value: new THREE.Color(1, 1, 1) }, ambTint = { value: new THREE.Color(1, 1, 1) };
  // premultiplied "over" into the HDR target; the target's alpha is left alone (like the glow class)
  const PREMUL = {
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  };
  const smokeLit = SMOKE_LIT.map(lin), smokeShade = SMOKE_SHADE.map(lin);
  const smokeMat = mkMat(FRAG_SMOKE, { SMOKE_CLASS: 1, SMOKE_N }, {
    ...glowU,
    uMaxScreen: { value: 0.3 },          // smoke is the heaviest fragment shader: tighter screen-size clamp
    uSunV: sunV, uSunTint: sunTint, uAmbTint: ambTint,
    uNearCut: { value: 1 },
    uLit: { value: smokeLit },
    uShade: { value: smokeShade },
    uGlowC: { value: SMOKE_GLOW.map(lin) },
    uAlphaRow: { value: SMOKE_ALPHA.slice() },
    uGuard: guard, uGuardMin: { value: 0.25 }, uFade: { value: new THREE.Vector3(0.1, 0.28, 0.25) },
  }, PREMUL);
  const softMat = mkMat(FRAG_SOFT, { FLAME_CLASS: 1, SOFT_CLASS: 1 }, {
    ...glowU,
    uMaxScreen: { value: 0.36 },         // radius ≤ 18 % of the view height per tongue
    uOcc: { value: 0.78 },               // shadowfire body occlusion away from the lens (0.35× of it within 5 m)
    uGuard: guard, uGuardMin: { value: 0.2 }, uFade: { value: new THREE.Vector3(0.08, 0.26, 0.2) },
  }, PREMUL);
  const glowMat = mkMat(FRAG_GLOW, { GLOW_CLASS: 1 }, glowU, PREMUL);
  for (const m of [flameMat, smokeMat, softMat, glowMat]) { m.toneMapped = false; m.fog = false; }
  softMat.userData.fx = smokeMat.userData.fx = true;

  const cap = (n) => Math.max(512, Math.round(n * Math.min(1.5, q)));
  const engine = {
    tex,
    shared,
    quality: q,
    /** Scratch spawn record: fill fields, then pool.push(engine.P). reset() restores defaults. */
    P: {},
    reset() {
      const P = engine.P;
      P.x = P.y = P.z = 0; P.vx = P.vy = P.vz = 0; P.seed = Math.random();
      P.life = 1; P.t0 = game.time.now; P.row = 0; P.shape = 0; P.intensity = 1;
      P.size0 = 1; P.size1 = 1; P.rot = Math.random() * 6.283; P.spin = 0;
      P.drag = 0; P.grav = 0; P.stretch = 0; P.grow = 0;
      P.heat = 1; P.cool = 0; P.fadeIn = 0; P.squash = 0; P.fan = 0; P.opacity = 1; P.guardWeak = false;
      return P;
    },
    flame: null, smoke: null, soft: null, glow: null,
    /** Camera guard: particles of the soft and smoke classes fade inside the camera→player capsule (config). */
    guard: { on: true, radius: 6 },
    _lastSoftCheck: null,
    beforeRender(renderer, pool) {
      pool.flush();
      shared.uTime.value = game.time.now;
      if (pool !== engine.flame) engine._soft(renderer);
    },
    _soft(renderer) {
      // Soft particles only when the pipeline's depth texture is NOT attached to the target being drawn
      // (sampling it there would be a feedback loop) and has the same size.
      const depth = game.pipeline?.depthTexture;
      const rt = renderer.getRenderTarget();
      let on = false;
      if (depth && depth.isDepthTexture && rt && rt.depthTexture !== depth && depth.image?.width) {
        const w = depth.image.width, h = depth.image.height;
        if (rt.width === w && rt.height === h) {
          on = true;
          glowU.uDepth.value = depth;
          glowU.uInvRes.value.set(1 / w, 1 / h);
        }
      }
      if (!on) glowU.uDepth.value = dummyDepth;
      glowU.uSoft.value = on ? 1 : 0;
      glowU.uNear.value = game.camera.near;
      glowU.uFar.value = game.camera.far;
    },
    /** Per-frame: sun direction in view space, sun / sky tints and cloud colours for smoke, the camera guard. */
    frame() {
      const sd = atmo?.sunDir || _up;
      sunV.value.copy(sd).transformDirection(game.camera.matrixWorldInverse);
      // smoke is lit by the sun's colour and the sky ambient (normalised: only the hue and a little brightness)
      const pal = atmo?.palette;
      tint(sunTint.value, pal?.charLight?.value, 1.0, 0.9, 1.15, 0.6);
      tint(ambTint.value, pal?.skyUp?.value, 4.0, 0.72, 0.95, 0.3);
      // cloud wisps (row SMOKE.cloud) take the live cloud colours
      const cl = atmo?.uniforms?.atmoCloudLit?.value, cs = atmo?.uniforms?.atmoCloudShade?.value;
      if (cl?.isColor) smokeLit[SMOKE.cloud].copy(cl);
      if (cs?.isColor) smokeShade[SMOKE.cloud].copy(cs);
      // guard capsule: from the lens to 1.5 m in front of Sora (her breath and the space ahead are never faded)
      const pp = game.player?.pos;
      const g = guard.value;
      if (engine.guard.on && pp?.isVector3 && game.camera) {
        game.camera.getWorldPosition(_cp);
        _gp.subVectors(pp, _cp);
        const L = _gp.length();
        if (L > 2 && L < 80) { g.set(pp.x, pp.y, pp.z, engine.guard.radius); g.x -= _gp.x / L * 1.5; g.y -= _gp.y / L * 1.5; g.z -= _gp.z / L * 1.5; }
        else g.w = 0;
      } else g.w = 0;
    },
  };
  engine.flame = new Pool(engine, 'flame', cap(6144), flameMat, 10);
  engine.smoke = new Pool(engine, 'smoke', cap(3072), smokeMat, 46, 21);
  engine.soft = new Pool(engine, 'soft', cap(6144), softMat, 48, 10);
  engine.glow = new Pool(engine, 'glow', cap(6144), glowMat, 50);
  engine.reset();
  const group = new THREE.Group();
  group.name = 'fx-particles';
  group.add(engine.flame.mesh, engine.smoke.mesh, engine.soft.mesh, engine.glow.mesh);
  game.scene.add(group);
  engine.group = group;
  return engine;
}
