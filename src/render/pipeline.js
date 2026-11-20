// game.pipeline — owns the frame (called by the core instead of renderer.render):
//   S1  opaque scene → sceneRT: HalfFloat linear HDR, MSAA, FloatType DepthTexture (standard depth, see contract)
//   C   game.clouds.render(ctx) if present (contract in docs/ARCHITECTURE.md → "Clouds ↔ pipeline")
//   P1  composite → hdrRT: depth-aware (bilateral) cloud upsample, final = scene·(1−a) + rgb; copies depth
//       (pulled forward to the cloud front where the cloud is dense) so the FX pass is occluded correctly
//   FX  objects on pipeline.FX_LAYER (fire, fireballs, sparks…) drawn after the clouds, depth-tested
//   GR  god rays: sun mask = sky pixels × (1 − cloud alpha) × sun glow at ¼ res, two chained radial blurs
//   B   bloom: soft-knee max-channel prefilter at ½ res, 6-level 13-tap down / tent up mip chain
//   F   final → canvas: speed blur, tiny chromatic aberration, bloom + rays (anime starburst) + lens ghosts,
//       exposure, tone map ('hybrid' default = palette-true Neutral mid-tones + AgX Punchy highlights; 'agx',
//       'neutral', 'aces' selectable, ?tonemap=), anime grade from game.atmo.grade, vignette, dither, sRGB
//   O   overlays (pipeline.addOverlay(scene)): full-res, after the composite, display-referred, no tone mapping
// Public: depthTexture, sceneTexture, FX_LAYER, setExposure(v), setSpeedBlur(v, centerUv?), addOverlay(scene)
//         -> { remove() }, afterClouds(object) (moves a subtree to the FX layer), setToneMapper('neutral'|'agx'|'aces'),
//         settings (live tuning), debugView ('none'|'bloom'|'rays'|'mask'|'depth'|'clouds'|'scene'), stats,
//         benchmark(n) -> Promise of per-section ms. MSAA 4× (2× when DPR × renderScale ≥ 1.75), ?msaa=N overrides.
// Depth: sample pipeline.depthTexture only in the FX pass or overlays — during S1 it is the render target's attachment.
// Transparent objects with Additive/Custom blending and depthWrite=false are moved to the FX layer automatically
// (opt out: object.userData.beforeClouds = true). Everything else renders in S1.
import * as THREE from 'three';
import { clamp, smoothstep } from '../core/util.js';

const FX_LAYER = 3;

const FS_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// Depth-aware cloud upsample. With the clouds' depthTexture (R = front distance, G = march limit, A = sharpen amount
// still to apply) each of the 4 bilinear taps is weighted by how well the distance that cloud texel was marched to
// matches this pixel's scene distance (both radial metres, sky = uMaxDist). A tap that was marched past this pixel's
// surface with no cloud in front of it is a valid "no cloud" sample (no cloud halo over a dragon in front of a tower).
// Without G the full-res depth at the tap centre is the proxy (wave-1 behaviour). SHARPEN: the anime alpha curve is
// applied here, after the upsample, at full resolution (the clouds then output soft alpha) -> no stair-stepped edges.
const COMPOSITE_FRAG = /* glsl */`
#include <packing>
uniform sampler2D tScene, tDepth, tCloud, tCloudDepth;
uniform vec2 uCloudRes, uSharpLoHi;
uniform float cameraNear, cameraFar, uMaxDist;
uniform mat4 uProjInv;
varying vec2 vUv;
float linZ(float d) { return -perspectiveDepthToViewZ(d, cameraNear, cameraFar); }
void main() {
  vec3 scene = texture2D(tScene, vUv).rgb;
  float d = texture2D(tDepth, vUv).r;
  vec4 vr = uProjInv * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 vd = normalize(vr.xyz / vr.w);
  vec4 cloud = vec4(0.0);
  float cdist = 0.0;
  #ifdef HAS_CLOUDS
  {
    float z = linZ(d);
    float dist = d >= 0.9999999 ? uMaxDist : min(z / max(-vd.z, 1e-4), uMaxDist);   // radial, like the march
    vec2 p = vUv * uCloudRes - 0.5;
    vec2 f = fract(p);
    vec2 b = (floor(p) + 0.5) / uCloudRes;
    vec2 px = 1.0 / uCloudRes;
    vec4 acc = vec4(0.0), accZ = vec4(0.0);
    float wsum = 0.0, wsumZ = 0.0, best = -1.0, amtA = 0.0, amtW = 0.0, amtAZ = 0.0, amtWZ = 0.0;
    vec2 bestUv = b;
    for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
      vec2 uv = b + vec2(float(i), float(j)) * px;
      float wb = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y);
      vec4 s = texture2D(tCloud, uv);
      float zi = linZ(texture2D(tDepth, uv).r);                    // proxy: full-res depth at the tap centre
      float wz = exp(-abs(zi - z) / (0.04 * z + 0.5));
      float wd = wz;
      float amt = 0.0;
      #ifdef HAS_CLOUD_DEPTH
        vec4 cd = texture2D(tCloudDepth, uv);
        amt = cd.a;
        float gi = cd.g;                                             // distance this texel was really marched to
        float wg = exp(-abs(gi - dist) / (0.04 * dist + 0.5));
        bool covers = gi >= dist * 0.97 - 0.5;
        bool empty = cd.r <= 0.0 || cd.r >= dist;
        vec4 sz = s;
        if (covers && empty) { s = vec4(0.0); wg = 1.0; }            // no cloud in front of this pixel's surface
        wd = wg;
        float w2 = wb * (wz + 1e-4);
        accZ += sz * w2; wsumZ += w2; amtAZ += w2 * sz.a * amt; amtWZ += w2 * sz.a;
      #endif
      float w = wb * (wd + 1e-4);
      acc += s * w;
      wsum += w;
      amtA += w * s.a * amt; amtW += w * s.a;
      if (wd * (wb + 0.05) > best) { best = wd * (wb + 0.05); bestUv = uv; }
    }
    cloud = acc / max(wsum, 1e-6);
    float amount = amtA / max(amtW, 1e-5);
    #ifdef HAS_CLOUD_DEPTH
      if (wsum < 0.02) { cloud = accZ / max(wsumZ, 1e-6); amount = amtAZ / max(amtWZ, 1e-5); }   // no tap matched
      cdist = texture2D(tCloudDepth, bestUv).r;
    #endif
    #ifdef SHARPEN
      float a = cloud.a;
      float a2 = mix(a, smoothstep(uSharpLoHi.x, uSharpLoHi.y, a), clamp(amount, 0.0, 1.0));
      cloud = vec4(cloud.rgb * (a2 / max(a, 1e-4)), a2);            // premultiplied: rgb scales with alpha
    #endif
  }
  #endif
  vec3 col = scene * (1.0 - cloud.a) + cloud.rgb;
  gl_FragColor = vec4(col, 1.0);
  #ifdef WRITE_DEPTH
    float outD = d;
    if (cdist > 0.0 && cloud.a > 0.5) outD = min(outD, viewZToPerspectiveDepth(vd.z * cdist, cameraNear, cameraFar));
    gl_FragDepth = outD;
  #endif
}
`;

const MASK_FRAG = /* glsl */`
uniform sampler2D tDepth, tCloud, tCloudDepth;
uniform float uHasCloud, uSharpen;
uniform vec2 uSharpLoHi;
uniform mat4 uProjInv, uViewInv;
uniform vec3 uSunDir;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  float sky = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 o = (vec2(float(i / 2), float(i - (i / 2) * 2)) - 0.5) * uTexel;
    sky += step(0.9999999, texture2D(tDepth, vUv + o).r);
  }
  sky *= 0.25;
  float a = uHasCloud > 0.5 ? texture2D(tCloud, vUv).a : 0.0;
  if (uSharpen > 0.5) a = mix(a, smoothstep(uSharpLoHi.x, uSharpLoHi.y, a), clamp(texture2D(tCloudDepth, vUv).a, 0.0, 1.0));
  vec4 vr = uProjInv * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 dirW = normalize((uViewInv * vec4(vr.xyz / vr.w, 0.0)).xyz);
  float mu = max(dot(dirW, uSunDir), 0.0);
  float glow = pow(mu, 300.0) * 2.5 + pow(mu, 28.0) * 0.35;
  gl_FragColor = vec4(sky * (1.0 - clamp(a, 0.0, 1.0)) * glow, 0.0, 0.0, 1.0);
}
`;

const RAYS_FRAG = /* glsl */`
uniform sampler2D tIn;
uniform vec2 uSun;
uniform float uDensity, uDecay;
varying vec2 vUv;
const int N = 28;
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  vec2 delta = (vUv - uSun) * uDensity / float(N);
  vec2 p = vUv - delta * ign(gl_FragCoord.xy);
  float illum = 1.0, acc = 0.0, wsum = 0.0;
  for (int i = 0; i < N; i++) {
    acc += texture2D(tIn, p).r * illum;
    wsum += illum;
    illum *= uDecay;
    p -= delta;
  }
  gl_FragColor = vec4(acc / wsum, 0.0, 0.0, 1.0);
}
`;

// 13-tap downsample (Jimenez 2014); the first level also applies the soft-knee max-channel threshold with a
// Karis average so the sun disc cannot sparkle.
const DOWN_FRAG = /* glsl */`
uniform sampler2D tIn;
uniform vec2 uTexel;
uniform float uThreshold, uKnee;
varying vec2 vUv;
vec3 pre(vec3 c) {
  c = min(c, vec3(64.0));
  float br = max(c.r, max(c.g, c.b));
  float rq = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
  rq = rq * rq / (4.0 * uKnee + 1e-4);
  return c * max(rq, br - uThreshold) / max(br, 1e-4);
}
float kw(vec3 c) { return 1.0 / (1.0 + max(c.r, max(c.g, c.b))); }
vec3 S(vec2 o) { return texture2D(tIn, vUv + o * uTexel).rgb; }
void main() {
  vec3 a = S(vec2(-2, 2)), b = S(vec2(0, 2)), c = S(vec2(2, 2));
  vec3 d = S(vec2(-2, 0)), e = S(vec2(0, 0)), f = S(vec2(2, 0));
  vec3 g = S(vec2(-2, -2)), h = S(vec2(0, -2)), i = S(vec2(2, -2));
  vec3 j = S(vec2(-1, 1)), k = S(vec2(1, 1)), l = S(vec2(-1, -1)), m = S(vec2(1, -1));
  #ifdef PREFILTER
    a = pre(a); b = pre(b); c = pre(c); d = pre(d); e = pre(e); f = pre(f); g = pre(g);
    h = pre(h); i = pre(i); j = pre(j); k = pre(k); l = pre(l); m = pre(m);
    vec3 g0 = (j + k + l + m) * 0.25, g1 = (a + b + d + e) * 0.25, g2 = (b + c + e + f) * 0.25;
    vec3 g3 = (d + e + g + h) * 0.25, g4 = (e + f + h + i) * 0.25;
    float w0 = kw(g0) * 0.5, w1 = kw(g1) * 0.125, w2 = kw(g2) * 0.125, w3 = kw(g3) * 0.125, w4 = kw(g4) * 0.125;
    vec3 o = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
  #else
    vec3 o = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  #endif
  gl_FragColor = vec4(o, 1.0);
}
`;

const UP_FRAG = /* glsl */`
uniform sampler2D tIn;
uniform vec2 uTexel;
uniform float uScatter;
varying vec2 vUv;
vec3 S(vec2 o) { return texture2D(tIn, vUv + o * uTexel).rgb; }
void main() {
  vec3 s = S(vec2(0, 0)) * 4.0
    + (S(vec2(-1, 0)) + S(vec2(1, 0)) + S(vec2(0, -1)) + S(vec2(0, 1))) * 2.0
    + S(vec2(-1, -1)) + S(vec2(1, -1)) + S(vec2(-1, 1)) + S(vec2(1, 1));
  gl_FragColor = vec4(s / 16.0 * uScatter, 1.0);
}
`;

const FINAL_FRAG = /* glsl */`
uniform sampler2D tHDR, tBloom, tRays, tMask;
uniform vec2 uSun, uSpeedCenter;
uniform float uAspect, uExposure, uBloom, uRaysK, uFlare, uSunVisK, uCA, uSpeed, uTime;
uniform float uSat, uContrast, uWarmth, uVignette, uShadowAmt, uGrain;
uniform vec3 uRaysColor, uShadowTint, uHighlightTint, uSunColor, uVignetteTint;
uniform int uDebug;
// effects update — impact feedback (pipeline.ripple / pipeline.kick): up to two screen shockwaves that bend the frame
// as they travel (xy centre in uv, z radius in view heights, w strength) and a short "kick" (0..1): the bloom swells,
// the colour fringes split and the picture saturates for a few frames.
uniform vec4 uRipple[2];
uniform float uKick;
// boss update — the titan fight (vfx/bossfx.js → pipeline.setBoss, every frame it runs): xy the core on screen (uv),
// z its energy (heat haze round it and light rays pouring out of it, through the bloom), w the enrage (a crimson grade
// and a heartbeat at the edges); uFlash a lightning flash over the whole sky.
uniform vec4 uBoss;
uniform float uFlash;
varying vec2 vUv;

float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

// Khronos PBR Neutral (three.js NeutralToneMapping, MIT) with Desaturation 0.15 -> 0.05: the identity below 0.76,
// so authored cel colours pass untouched while HDR fire stays saturated.
vec3 animeNeutral(vec3 color) {
  const float StartCompression = 0.8 - 0.04;
  const float Desaturation = 0.05;
  float x = min(color.r, min(color.g, color.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < StartCompression) return color;
  float d = 1. - StartCompression;
  float newPeak = 1. - d * d / (peak + d - StartCompression);
  color *= newPeak / peak;
  float g = 1. - 1. / (Desaturation * (peak - newPeak) + 1.);
  return mix(color, vec3(newPeak), g);
}
// three.js AgX (MIT) with the Filament "Punchy" look (power 1.35, saturation 1.4) after the sigmoid.
vec3 agxPunchy(vec3 color) {
  const mat3 R2020_TO_SRGB = mat3(vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
  const mat3 SRGB_TO_R2020 = mat3(vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
  const mat3 AgXIn = mat3(vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
    vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903), vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 AgXOut = mat3(vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
    vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294), vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  const float MinEv = -12.47393, MaxEv = 4.026069;
  color = AgXIn * (SRGB_TO_R2020 * color);
  color = clamp((log2(max(color, 1e-10)) - MinEv) / (MaxEv - MinEv), 0.0, 1.0);
  vec3 x2 = color * color, x4 = x2 * x2;
  color = 15.5 * x4 * x2 - 40.14 * x4 * color + 31.96 * x4 - 6.868 * x2 * color + 0.4298 * x2 + 0.1191 * color - 0.00232;
  float l = luma(color);
  color = l + 1.4 * (pow(max(color, 0.0), vec3(1.35)) - l);
  color = AgXOut * color;
  color = pow(max(vec3(0.0), color), vec3(2.2));
  return clamp(R2020_TO_SRGB * color, 0.0, 1.0);
}
vec3 aces(vec3 color) {
  const mat3 I = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 O = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  color = I * (color / 0.6);
  vec3 a = color * (color + 0.0245786) - 0.000090537;
  vec3 b = color * (0.983729 * color + 0.4329510) + 0.238081;
  return clamp(O * (a / b), 0.0, 1.0);
}
// Anime hybrid: palette-true Neutral through the mid-tones, AgX Punchy's clean whites and depth in the highlights.
vec3 animeHybrid(vec3 c) {
  float m = max(c.r, max(c.g, c.b));
  return mix(animeNeutral(c), agxPunchy(c * 1.1), smoothstep(0.45, 1.5, m));
}
vec3 toSRGB(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// Anime lens ghosts along the sun → centre axis, plus a faint rainbow halo (Shinkai).
vec3 ghosts(vec2 uv) {
  vec2 axis = vec2(0.5) - uSun;
  vec3 acc = vec3(0.0);
  const vec4 G0 = vec4(0.45, 0.045, 0.50, 0.0);   // t along axis, radius, strength, ring?
  const vec4 G1 = vec4(0.80, 0.080, 0.40, 1.0);
  const vec4 G2 = vec4(1.25, 0.030, 0.60, 0.0);
  const vec4 G3 = vec4(1.60, 0.130, 0.30, 1.0);
  const vec4 G4 = vec4(2.00, 0.060, 0.40, 0.0);
  vec4 gs[5]; gs[0] = G0; gs[1] = G1; gs[2] = G2; gs[3] = G3; gs[4] = G4;
  vec3 tints[5];
  tints[0] = vec3(0.55, 0.85, 1.0); tints[1] = vec3(1.0, 0.75, 0.45); tints[2] = vec3(0.6, 1.0, 0.75);
  tints[3] = vec3(0.75, 0.6, 1.0); tints[4] = vec3(1.0, 0.9, 0.6);
  for (int i = 0; i < 5; i++) {
    vec2 c = uSun + axis * gs[i].x;
    vec2 dv = uv - c; dv.x *= uAspect;
    float r = length(dv), R = gs[i].y;
    float disc = gs[i].w > 0.5
      ? exp(-pow((r - R) / (R * 0.18), 2.0)) * 0.8 + smoothstep(R, R * 0.2, r) * 0.15
      : smoothstep(R, R * 0.55, r);
    acc += tints[i] * disc * gs[i].z;
  }
  vec2 hv = uv - uSun; hv.x *= uAspect;
  float hr = length(hv);
  float ring = exp(-pow((hr - 0.34) / 0.03, 2.0));
  vec3 rainbow = 0.5 + 0.5 * cos(6.2831853 * (vec3(0.0, 0.33, 0.67) + (hr - 0.34) * 9.0));
  acc += rainbow * ring * 0.25;
  return acc * 0.3;
}

void main() {
  vec2 uv = vUv;
  float wave = 0.0;
  for (int i = 0; i < 2; i++) {
    float st = uRipple[i].w;
    if (st > 0.001) {
      vec2 d = (uv - uRipple[i].xy) * vec2(uAspect, 1.0);
      float r = length(d) + 1e-4;
      float w = 0.035 + 0.09 * uRipple[i].z;                  // the front widens as it travels
      float k = (r - uRipple[i].z) / w;
      float band = exp(-k * k);
      uv -= (d / r) * vec2(1.0 / uAspect, 1.0) * band * st * 0.03;   // the frame is pulled toward the front
      wave += band * st;
    }
  }
  if (uBoss.z > 0.001) {
    // heat shimmer round the core
    vec2 hd = (uv - uBoss.xy) * vec2(uAspect, 1.0);
    float h = exp(-dot(hd, hd) * 14.0) * min(uBoss.z, 1.5);
    uv += vec2(sin(uv.y * 95.0 + uTime * 9.0), cos(uv.x * 83.0 - uTime * 7.3)) * 0.0024 * h;
  }
  vec2 dc = uv - 0.5;
  float ca = uCA + uKick * 0.012 + uBoss.w * 0.0035;
  vec3 col;
  if (uSpeed > 0.001) {
    // Radial speed blur, masked out of the centre so the dragon stays crisp.
    vec2 dir = uv - uSpeedCenter;
    float m = smoothstep(0.12, 0.55, length(dir * vec2(uAspect, 1.0)));
    vec2 st = dir * uSpeed * 0.045 * m;
    float j = ign(gl_FragCoord.xy);
    col = vec3(0.0);
    for (int i = 0; i < SPEED_TAPS; i++) col += texture2D(tHDR, uv - st * ((float(i) + j) / float(SPEED_TAPS))).rgb;
    col /= float(SPEED_TAPS);
  } else if (ca > 0.0) {
    vec2 o = dc * ca * smoothstep(0.12 - 0.1 * uKick, 0.5, dot(dc, dc));
    col = vec3(texture2D(tHDR, uv - o).r, texture2D(tHDR, uv).g, texture2D(tHDR, uv + o).b);
  } else {
    col = texture2D(tHDR, uv).rgb;
  }
  col += texture2D(tBloom, uv).rgb * uBloom * (1.0 + uKick * 1.1);
  col *= 1.0 + wave * 0.22;                                  // the shock front catches the light
  if (uBoss.z > 0.001) {
    // light pouring out of the core: the bloom smeared along the lines to it (6 taps of the small bloom texture)
    vec2 to = uBoss.xy - uv;
    float jj = ign(gl_FragCoord.xy + 17.0);
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 6; i++) {
      float t = (float(i) + jj) / 6.0;
      acc += texture2D(tBloom, uv + to * t * 0.7).rgb * (1.0 - t * 0.6);
    }
    float fall = 1.0 / (1.0 + dot(to * vec2(uAspect, 1.0), to * vec2(uAspect, 1.0)) * 6.0);
    col += acc * (uBoss.z * 0.55 * fall) * uBloom * 4.0;
  }
  if (uFlash > 0.001) col = col * (1.0 + uFlash * 0.6) + vec3(0.55, 0.62, 1.0) * uFlash * 0.18;

  if (uRaysK > 0.0) {
    vec2 sv = uv - uSun; sv.x *= uAspect;
    float ang = atan(sv.y, sv.x);
    float star = 0.8 + 0.2 * pow(abs(sin(ang * 6.0 + 0.4)), 8.0) + 0.14 * pow(abs(sin(ang * 11.0 + 1.3)), 24.0);
    star = mix(1.0, star, exp(-length(sv) * 2.2));             // spikes near the sun only
    col += texture2D(tRays, uv).r * uRaysColor * uRaysK * star;
  }
  if (uFlare > 0.0) {
    float vis = 0.0;
    for (int i = 0; i < 5; i++) {
      vec2 o = vec2(float(i - 2) * 0.004, float((i * 3) % 5 - 2) * 0.004);
      vis += texture2D(tMask, uSun + o).r;
    }
    vis = clamp(vis / (5.0 * 2.9), 0.0, 1.0) * uSunVisK;
    col += ghosts(uv) * uSunColor * uFlare * vis;
  }

  col *= uExposure;
  #if TONEMAP == 1
    col = agxPunchy(col);
  #elif TONEMAP == 2
    col = aces(col);
  #elif TONEMAP == 3
    col = animeHybrid(col);
  #else
    col = animeNeutral(col);
  #endif

  // Anime grade (linear display space): saturation, blue-violet shadows, warm highlights, warmth.
  float l = luma(col);
  col = max(mix(vec3(l), col, uSat + uKick * 0.14), 0.0);
  col += uShadowTint * uShadowAmt * pow(1.0 - clamp(l * 2.2, 0.0, 1.0), 2.0);
  col *= mix(vec3(1.0), uHighlightTint, smoothstep(0.35, 1.0, l));
  col *= vec3(1.0 + uWarmth * 0.06, 1.0 + uWarmth * 0.01, 1.0 - uWarmth * 0.07);
  col = toSRGB(col);
  // Display-space contrast S-curve, soft vignette leaning blue-violet.
  vec3 s = col * col * (3.0 - 2.0 * col);
  col = mix(col, s, clamp((uContrast - 1.0) * 2.5, -1.0, 1.0));
  vec2 vd = dc * vec2(uAspect, 1.0) / sqrt(uAspect * uAspect * 0.25 + 0.25);
  float v = smoothstep(0.45, 1.25, length(vd));
  col *= mix(vec3(1.0), uVignetteTint, v * uVignette * 1.6);
  if (uBoss.w > 0.001) {
    // the enraged titan: a crimson lean and a heartbeat glowing at the edges of the view
    float beat = pow(0.5 + 0.5 * sin(uTime * 7.4), 6.0) + 0.6 * pow(0.5 + 0.5 * sin(uTime * 7.4 - 1.1), 10.0);
    col = mix(col, col * vec3(1.07, 0.86, 0.9), uBoss.w * 0.5);
    col += vec3(0.42, 0.02, 0.07) * smoothstep(0.35, 1.25, length(vd)) * uBoss.w * (0.25 + 0.35 * beat);
  }
  col += (ign(gl_FragCoord.xy + fract(uTime) * 64.0) - 0.5) * (1.0 / 255.0 + uGrain);

  if (uDebug == 1) col = toSRGB(texture2D(tBloom, uv).rgb);
  else if (uDebug == 2) col = vec3(texture2D(tRays, uv).r);
  else if (uDebug == 3) col = vec3(texture2D(tMask, uv).r);
  gl_FragColor = vec4(col, 1.0);
}
`;

const DEBUG_FRAG = /* glsl */`
#include <packing>
uniform sampler2D tDepth, tCloud, tScene;
uniform float cameraNear, cameraFar, uMode, uHasCloud;
varying vec2 vUv;
void main() {
  vec3 c;
  if (uMode < 4.5) { float z = -perspectiveDepthToViewZ(texture2D(tDepth, vUv).r, cameraNear, cameraFar); c = vec3(fract(log2(z + 1.0) * 0.5)); }
  else if (uMode < 5.5) { vec4 k = uHasCloud > 0.5 ? texture2D(tCloud, vUv) : vec4(0.0); c = mix(vec3(1.0, 0.0, 1.0) * 0.2, k.rgb, k.a); }
  else c = texture2D(tScene, vUv).rgb / (1.0 + texture2D(tScene, vUv).rgb);
  gl_FragColor = vec4(pow(c, vec3(0.4545)), 1.0);
}
`;

const DEBUG_VIEWS = { none: 0, bloom: 1, rays: 2, mask: 3, depth: 4, clouds: 5, scene: 6 };
const TONEMAPS = { neutral: 0, agx: 1, aces: 2, hybrid: 3 };

export default function createPipeline(game) {
  const { renderer, scene, camera } = game;
  const params = game.params || new URLSearchParams();

  const settings = {
    exposure: 1,                 // multiplied with game.atmo.grade.exposure
    toneMapper: TONEMAPS[params.get('tonemap')] !== undefined ? params.get('tonemap') : 'hybrid',
    bloomThreshold: 1.0, bloomKnee: 0.5, bloomScatter: 0.85,
    raysDecay: 0.94, raysDensity: 0.9,
    chromatic: 0.0012,           // tiny; only at the frame edges
    grain: 0.006,
    msaa: params.has('msaa') ? +params.get('msaa') : null,   // null = automatic
    cloudSharpen: params.get('cloudsharp') !== '0',            // full-res cloud alpha sharpening (?cloudsharp=0 = off)
  };
  const state = { speedBlur: 0, speedCenter: new THREE.Vector2(0.5, 0.5),
    // effects update: two shockwave slots { x, y, t, life, speed, strength } and the kick (decays in real time)
    ripples: [{ x: 0.5, y: 0.5, t: 9, life: 1, speed: 1, strength: 0 }, { x: 0.5, y: 0.5, t: 9, life: 1, speed: 1, strength: 0 }], kick: 0,
    boss: { x: 0.5, y: 0.5, energy: 0, enrage: 0, flash: 0, onScreen: false, fresh: false } };
  const reducedMotion = (() => { try { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();
  // Review A/B keys (?debug only; real keyboard, nothing else changes): Digit8 = wave-4 toon form shading on/off,
  // Digit9 = valley mist on/off, Digit7 = raw cloud buffer view on/off. They work in photo mode, so before/after is
  // the same frozen frame. Not in sandboxes (the titan sandbox uses Digit7–9 itself).
  if (params.has('debug') && !params.has('sandbox') && typeof window !== 'undefined') {
    window.addEventListener('keydown', (e) => {
      try {
        if (e.code === 'Digit8' && game.toon?.shared?.toonLook) {
          const u = game.toon.shared.toonLook; u.value = u.value > 0 ? 0 : 1;
        } else if (e.code === 'Digit9' && game.atmo && 'mistEnabled' in game.atmo) {
          game.atmo.mistEnabled = !game.atmo.mistEnabled; game.atmo.update?.(0, 0);
        } else if (e.code === 'Digit7') {
          debugView = debugView === 'clouds' ? 'none' : 'clouds';   // raw cloud buffer vs final (art #10 triage)
        }
      } catch { /* review keys only */ }
    });
  }
  const overlays = new Set();
  let debugView = DEBUG_VIEWS[params.get('view')] ? params.get('view') : 'none';

  // --- full-screen machinery ------------------------------------------------------------------------------
  const fsGeom = new THREE.BufferGeometry();
  fsGeom.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const fsMesh = new THREE.Mesh(fsGeom);
  fsMesh.frustumCulled = false;
  const fsScene = new THREE.Scene();
  fsScene.add(fsMesh);
  const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const mat = (frag, uniforms, defines = {}, extra = {}) => new THREE.ShaderMaterial({
    vertexShader: FS_VERT, fragmentShader: frag, uniforms, defines, depthTest: false, depthWrite: false, ...extra,
  });
  function pass(material, target) {
    fsMesh.material = material;
    renderer.setRenderTarget(target);
    renderer.render(fsScene, fsCam);
  }
  const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  black.needsUpdate = true;

  // --- targets --------------------------------------------------------------------------------------------
  let W = 0, H = 0, samples = -1;
  let sceneRT = null, hdrRT = null, maskRT = null, raysA = null, raysB = null;
  const bloomRTs = [];
  const BLOOM_LEVELS = 6;
  const rtOpts = { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };

  function wantedSize() {
    const s = game.size || { pw: 1, ph: 1, dpr: 1 };
    const rs = clamp(game.quality?.renderScale ?? 1, 0.25, 2);
    const w = Math.max(1, Math.round(s.pw * rs)), h = Math.max(1, Math.round(s.ph * rs));
    let n = settings.msaa;
    // (performance update: a quality may name its own sample count — the automatic mode's cheapest rungs use 0 / 2)
    const qm = game.quality?.msaa;
    if (n === null || !Number.isFinite(n)) n = Number.isFinite(qm) && qm !== null ? qm : (game.quality?.tier || game.quality?.name) === 'low' ? 2 : ((s.dpr || 1) * rs >= 1.75 ? 2 : 4);
    n = Math.min(n, renderer.capabilities.maxSamples || 4);
    return { w, h, n };
  }

  function alloc() {
    const { w, h, n } = wantedSize();
    if (w === W && h === H && n === samples) return false;
    for (const rt of [sceneRT, hdrRT, maskRT, raysA, raysB, ...bloomRTs]) rt?.dispose();
    bloomRTs.length = 0;
    W = w; H = h; samples = n;
    const depth = new THREE.DepthTexture(w, h, THREE.FloatType);
    sceneRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: n, depthBuffer: true, depthTexture: depth });
    sceneRT.texture.name = 'pipeline.scene';
    hdrRT = new THREE.WebGLRenderTarget(w, h, { ...rtOpts, depthBuffer: true });
    hdrRT.texture.name = 'pipeline.hdr';
    const qw = Math.max(1, Math.round(w / 4)), qh = Math.max(1, Math.round(h / 4));
    maskRT = new THREE.WebGLRenderTarget(qw, qh, rtOpts);
    raysA = new THREE.WebGLRenderTarget(qw, qh, rtOpts);
    raysB = new THREE.WebGLRenderTarget(qw, qh, rtOpts);
    let bw = w, bh = h;
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
      bloomRTs.push(new THREE.WebGLRenderTarget(bw, bh, rtOpts));
    }
    pipeline.stats.width = w; pipeline.stats.height = h; pipeline.stats.samples = n;
    game.toon?.setViewport?.(h, h / Math.max(1, game.size?.h || h));
    return true;
  }

  // --- materials ------------------------------------------------------------------------------------------
  const projInv = new THREE.Matrix4();
  const sharpLoHi = { value: new THREE.Vector2(0.1, 0.62) };   // cloud alpha curve (from clouds' out.alphaSharpen)
  const compositeVariants = new Map();
  function compositeMat(hasClouds, hasCloudDepth, writeDepth, sharpen) {
    const key = `${+hasClouds}${+hasCloudDepth}${+writeDepth}${+sharpen}`;
    let m = compositeVariants.get(key);
    if (!m) {
      const defines = {};
      if (hasClouds) defines.HAS_CLOUDS = '';
      if (hasCloudDepth) defines.HAS_CLOUD_DEPTH = '';
      if (writeDepth) defines.WRITE_DEPTH = '';
      if (sharpen) defines.SHARPEN = '';
      m = mat(COMPOSITE_FRAG, {
        tScene: { value: null }, tDepth: { value: null }, tCloud: { value: black }, tCloudDepth: { value: black },
        uCloudRes: { value: new THREE.Vector2(1, 1) }, cameraNear: { value: 0.5 }, cameraFar: { value: 60000 },
        uProjInv: { value: projInv }, uMaxDist: { value: 60000 }, uSharpLoHi: sharpLoHi,
      }, defines, writeDepth ? { depthTest: true, depthWrite: true, depthFunc: THREE.AlwaysDepth } : {});
      compositeVariants.set(key, m);
    }
    return m;
  }
  const maskMat = mat(MASK_FRAG, {
    tDepth: { value: null }, tCloud: { value: black }, tCloudDepth: { value: black }, uHasCloud: { value: 0 },
    uSharpen: { value: 0 }, uSharpLoHi: sharpLoHi, uProjInv: { value: projInv },
    uViewInv: { value: camera.matrixWorld }, uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uTexel: { value: new THREE.Vector2() },
  });
  const raysMat = mat(RAYS_FRAG, {
    tIn: { value: null }, uSun: { value: new THREE.Vector2() }, uDensity: { value: 0.9 }, uDecay: { value: 0.95 },
  });
  const downU = () => ({ tIn: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1 }, uKnee: { value: 0.5 } });
  const prefilterMat = mat(DOWN_FRAG, downU(), { PREFILTER: '' });
  const downMat = mat(DOWN_FRAG, downU());
  const upMat = mat(UP_FRAG, { tIn: { value: null }, uTexel: { value: new THREE.Vector2() }, uScatter: { value: 0.85 } }, {}, {
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    transparent: true,
  });
  const finalUniforms = {
    tHDR: { value: null }, tBloom: { value: black }, tRays: { value: black }, tMask: { value: black },
    uSun: { value: new THREE.Vector2(0.5, 0.8) }, uSpeedCenter: { value: state.speedCenter },
    uAspect: { value: 1.6 }, uExposure: { value: 1 }, uBloom: { value: 0.7 }, uRaysK: { value: 0 }, uFlare: { value: 0 },
    uSunVisK: { value: 0 }, uCA: { value: settings.chromatic }, uSpeed: { value: 0 }, uTime: { value: 0 },
    uRipple: { value: [new THREE.Vector4(0.5, 0.5, 0, 0), new THREE.Vector4(0.5, 0.5, 0, 0)] }, uKick: { value: 0 },
    uBoss: { value: new THREE.Vector4(0.5, 0.5, 0, 0) }, uFlash: { value: 0 },
    uSat: { value: 1.1 }, uContrast: { value: 1.04 }, uWarmth: { value: 0 }, uVignette: { value: 0.3 }, uShadowAmt: { value: 0.07 },
    uGrain: { value: settings.grain }, uRaysColor: { value: new THREE.Color(1, 0.95, 0.85) },
    uShadowTint: { value: new THREE.Color(0x2c327e) }, uHighlightTint: { value: new THREE.Color(0xfff2de) },
    uSunColor: { value: new THREE.Color(1, 0.95, 0.85) }, uVignetteTint: { value: new THREE.Color().setRGB(0.78, 0.8, 0.92) },
    uDebug: { value: 0 },
  };
  const finalVariants = new Map();
  function finalMat() {
    const tm = TONEMAPS[settings.toneMapper] ?? 0;
    const taps = (game.quality?.speedTaps | 0) === 4 ? 4 : 8;
    const key = tm * 16 + taps;
    let m = finalVariants.get(key);
    if (!m) { m = mat(FINAL_FRAG, finalUniforms, { TONEMAP: tm, SPEED_TAPS: taps }); finalVariants.set(key, m); }
    return m;
  }
  const debugMat = mat(DEBUG_FRAG, {
    tDepth: { value: null }, tCloud: { value: black }, tScene: { value: null }, cameraNear: { value: 0.5 },
    cameraFar: { value: 60000 }, uMode: { value: 4 }, uHasCloud: { value: 0 },
  });

  // --- benchmark: pipeline.benchmark(n) re-runs every section n times between two GPU round trips on the next
  // frame and reports wall-clock ms per section. Timer queries do not isolate passes on ANGLE/Metal and
  // gl.finish() does not block in Chrome, so a 1×1 readPixels forces the sync. ---------------------------------
  const bench = { n: 0, res: null, resolve: null, rt: null, px: new Uint8Array(4) };
  function gpuSync() {
    const cur = renderer.getRenderTarget();
    if (!bench.rt) { bench.rt = new THREE.WebGLRenderTarget(1, 1); renderer.setRenderTarget(bench.rt); renderer.clear(); }
    renderer.readRenderTargetPixels(bench.rt, 0, 0, 1, 1, bench.px);
    renderer.setRenderTarget(cur);
  }
  function timed(name, fn) {
    if (!bench.n) return fn();
    gpuSync();
    const t0 = performance.now();
    let r;
    for (let k = 0; k < bench.n; k++) r = fn();
    gpuSync();
    bench.res[name] = +((performance.now() - t0) / bench.n).toFixed(3);
    return r;
  }

  // --- helpers --------------------------------------------------------------------------------------------
  let warnedClouds = false, warnedRender = false, frame = 0;
  const _v = new THREE.Vector3(), _fwd = new THREE.Vector3();

  /** Move VFX-looking transparent objects to the FX layer; returns how many FX objects are visible. */
  function tagFx() {
    let n = 0;
    scene.traverseVisible((o) => {
      if (!o.material || o === fsMesh) return;
      if (o.layers.isEnabled(FX_LAYER)) { n++; return; }
      if (o.userData._fxChecked || o.userData.beforeClouds) return;
      o.userData._fxChecked = true;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (m && m.transparent && m.depthWrite === false &&
          (m.blending === THREE.AdditiveBlending || m.blending === THREE.CustomBlending || m.userData?.fx)) {
        o.layers.set(FX_LAYER);
        n++;
      }
    });
    return n;
  }

  const _sun = { uv: new THREE.Vector2(), facing: 0 };
  function sunScreen() {
    const sd = game.atmo?.sunDir;
    if (!sd) { _sun.uv.set(0.5, 2); _sun.facing = 0; return _sun; }
    camera.getWorldDirection(_fwd);
    _sun.facing = _fwd.dot(sd);
    _v.copy(camera.position).addScaledVector(sd, 1000).project(camera);
    _sun.uv.set(_v.x * 0.5 + 0.5, _v.y * 0.5 + 0.5);
    return _sun;
  }

  function renderFrame(realDt) {
    alloc();
    frame++;
    const q = game.quality || {};
    const grade = game.atmo?.grade || {};
    game.sky?.beforeRender?.(camera);
    camera.updateMatrixWorld();
    projInv.copy(camera.projectionMatrixInverse);

    const prevAutoClear = renderer.autoClear;
    const layerMask = camera.layers.mask;
    const fxCount = tagFx();

    // S1 — opaque scene (+ non-FX transparents) with MSAA into the HDR target.
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    camera.layers.disable(FX_LAYER);
    renderer.autoClear = true;
    renderer.setClearColor(0x000000, 1);
    renderer.setRenderTarget(sceneRT);
    timed('scene', () => { renderer.shadowMap.needsUpdate = true; renderer.render(scene, camera); });
    camera.layers.mask = layerMask;

    // C — clouds (contract: premultiplied RGBA HalfFloat, a = 1 - transmittance).
    let cloud = null;
    if (game.clouds?.render) {
      const t0 = performance.now();
      try {
        pipeline.cloudAlphaSharpen = settings.cloudSharpen;   // handshake: we sharpen cloud alpha at full res
        cloud = timed('clouds', () => game.clouds.render({
          renderer, camera, depthTexture: sceneRT.depthTexture, sceneTexture: sceneRT.texture,
          width: W, height: H, frame, realDt, alphaSharpen: settings.cloudSharpen,
        }));
      } catch (e) {
        if (!warnedClouds) { console.error('[pipeline] clouds.render failed', e); warnedClouds = true; }
        cloud = null;
      }
      pipeline.stats.cloudsCpuMs = performance.now() - t0;
      if (cloud && !cloud.texture) cloud = null;
    }
    renderer.autoClear = false;

    // P1 — composite clouds over the scene (+ depth for the FX pass).
    // Soft cloud alpha + per-texel amount in depthTexture.a: sharpen after the upsample (feature-detected).
    const sh = cloud?.alphaSharpen;
    const sharpen = !!(cloud?.depthTexture && sh && sh.soft && settings.cloudSharpen);
    if (sharpen) sharpLoHi.value.set(Number.isFinite(sh.lo) ? sh.lo : 0.1, Number.isFinite(sh.hi) ? sh.hi : 0.62);
    pipeline.stats.cloudSharpen = sharpen;
    const cm = compositeMat(!!cloud, !!cloud?.depthTexture, fxCount > 0, sharpen);
    const cu = cm.uniforms;
    cu.uMaxDist.value = Math.min(60000, game.clouds?.params?.maxDist ?? 60000, camera.far);
    cu.tScene.value = sceneRT.texture;
    cu.tDepth.value = sceneRT.depthTexture;
    cu.cameraNear.value = camera.near; cu.cameraFar.value = camera.far;
    if (cloud) {
      cu.tCloud.value = cloud.texture;
      const img = cloud.texture.image || {};
      const cw = img.width || Math.round(W * (cloud.scale || 0.5)), ch = img.height || Math.round(H * (cloud.scale || 0.5));
      cu.uCloudRes.value.set(cw, ch);
      cu.tCloudDepth.value = cloud.depthTexture || black;
    }
    timed('composite', () => {
      renderer.setRenderTarget(hdrRT);
      renderer.clear(true, fxCount > 0, false);
      pass(cm, hdrRT);
    });

    // FX — after the clouds, depth-tested against the opaque (and dense cloud) depth.
    if (fxCount > 0) {
      camera.layers.set(FX_LAYER);
      renderer.setRenderTarget(hdrRT);
      timed('fx', () => renderer.render(scene, camera));
      camera.layers.mask = layerMask;
    }

    // GR — god rays.
    const sun = sunScreen();
    const raysOn = q.godrays !== false && (grade.godrays ?? 0.6) > 0 && sun.facing > 0.05;
    const raysFade = smoothstep(0.05, 0.4, sun.facing);
    timed('godrays', () => {
    if (raysOn || (grade.flare ?? 0) > 0) {
      const mu = maskMat.uniforms;
      mu.tDepth.value = sceneRT.depthTexture;
      mu.tCloud.value = cloud ? cloud.texture : black;
      mu.tCloudDepth.value = sharpen ? cloud.depthTexture : black;
      mu.uHasCloud.value = cloud ? 1 : 0;
      mu.uSharpen.value = sharpen ? 1 : 0;
      mu.uSunDir.value.copy(game.atmo?.sunDir || _v.set(0, 1, 0));
      mu.uTexel.value.set(1 / W, 1 / H);
      pass(maskMat, maskRT);
    }
    if (raysOn) {
      const ru = raysMat.uniforms;
      ru.uSun.value.copy(sun.uv);
      ru.tIn.value = maskRT.texture; ru.uDensity.value = settings.raysDensity; ru.uDecay.value = settings.raysDecay;
      pass(raysMat, raysA);
      ru.tIn.value = raysA.texture; ru.uDensity.value = settings.raysDensity * 0.28; ru.uDecay.value = 0.985;
      pass(raysMat, raysB);
    }
    });

    // B — bloom mip chain.
    const bloomOn = q.bloom !== false && (grade.bloom ?? 0.7) > 0;
    // (performance update: the cheap rungs run 4 or 5 of the 6 levels — the widest glow costs the least pixels but a
    // whole pass each on a tile GPU)
    const bloomN = clamp(Math.round(q.bloomLevels ?? BLOOM_LEVELS), 3, BLOOM_LEVELS);
    timed('bloom', () => {
    if (bloomOn) {
      let src = hdrRT.texture, sw = W, sh = H;
      for (let i = 0; i < bloomN; i++) {
        const m = i === 0 ? prefilterMat : downMat;
        m.uniforms.tIn.value = src;
        m.uniforms.uTexel.value.set(1 / sw, 1 / sh);
        m.uniforms.uThreshold.value = settings.bloomThreshold;
        m.uniforms.uKnee.value = settings.bloomKnee;
        pass(m, bloomRTs[i]);
        src = bloomRTs[i].texture; sw = bloomRTs[i].width; sh = bloomRTs[i].height;
      }
      for (let i = bloomN - 1; i > 0; i--) {
        const lo = bloomRTs[i];
        upMat.uniforms.tIn.value = lo.texture;
        upMat.uniforms.uTexel.value.set(1 / lo.width, 1 / lo.height);
        upMat.uniforms.uScatter.value = settings.bloomScatter;
        pass(upMat, bloomRTs[i - 1]);
      }
    }
    });

    // F — final composite to the canvas.
    const fu = finalUniforms;
    fu.tHDR.value = hdrRT.texture;
    fu.tBloom.value = bloomOn ? bloomRTs[0].texture : black;
    fu.tRays.value = raysOn ? raysB.texture : black;
    fu.tMask.value = maskRT.texture;
    fu.uSun.value.copy(sun.uv);
    fu.uAspect.value = W / H;
    fu.uExposure.value = settings.exposure * (grade.exposure ?? 1);
    fu.uBloom.value = bloomOn ? (grade.bloom ?? 0.7) * 0.22 : 0;
    fu.uRaysK.value = raysOn ? (grade.godrays ?? 0.6) * raysFade * 0.8 : 0;
    const onScreen = 1 - smoothstep(0.0, 0.08, Math.max(Math.abs(sun.uv.x - 0.5), Math.abs(sun.uv.y - 0.5)) - 0.5);
    fu.uFlare.value = (grade.flare ?? 0.5);
    fu.uSunVisK.value = sun.facing > 0 ? onScreen : 0;
    fu.uCA.value = settings.chromatic;
    fu.uSpeed.value = state.speedBlur;
    // effects update: the shockwaves travel and fade, the kick decays (real time: they play through a hitstop)
    for (let i = 0; i < 2; i++) {
      const R = state.ripples[i], U = fu.uRipple.value[i];
      R.t += realDt;
      const a = R.t / R.life;
      if (a >= 1 || R.strength <= 0) { U.w = 0; continue; }
      U.set(R.x, R.y, R.speed * R.life * (1 - Math.pow(1 - a, 2.2)), R.strength * (1 - a) * (1 - a));
    }
    state.kick *= Math.exp(-realDt * 6.5);
    if (state.kick < 0.003) state.kick = 0;
    fu.uKick.value = state.kick;
    // boss update: what bossfx set this frame (nothing set: off)
    {
      const B = state.boss;
      if (B.fresh) { fu.uBoss.value.set(B.x, B.y, B.energy * (B.onScreen ? 1 : 0), B.enrage); fu.uFlash.value = B.flash; B.fresh = false; }
      else { fu.uBoss.value.z = 0; fu.uBoss.value.w = 0; fu.uFlash.value = 0; }
    }
    fu.uTime.value = (fu.uTime.value + realDt) % 1000;
    fu.uSat.value = grade.saturation ?? 1.1;
    fu.uContrast.value = grade.contrast ?? 1.04;
    fu.uWarmth.value = grade.warmth ?? 0;
    fu.uVignette.value = grade.vignette ?? 0.3;
    fu.uShadowAmt.value = grade.shadowAmt ?? 0.07;
    fu.uGrain.value = settings.grain;
    if (grade.raysColor) fu.uRaysColor.value.copy(grade.raysColor);
    if (grade.shadowTint) fu.uShadowTint.value.copy(grade.shadowTint);
    if (grade.highlightTint) fu.uHighlightTint.value.copy(grade.highlightTint);
    if (grade.vignetteTint) fu.uVignetteTint.value.copy(grade.vignetteTint);
    const sc = game.atmo?.uniforms?.atmoSunColor?.value;
    if (sc) fu.uSunColor.value.copy(sc).multiplyScalar(1 / Math.max(sc.r, sc.g, sc.b, 1e-3));
    const dv = DEBUG_VIEWS[debugView] || 0;
    fu.uDebug.value = dv <= 3 ? dv : 0;
    if (dv >= 4) {
      const du = debugMat.uniforms;
      du.tDepth.value = sceneRT.depthTexture; du.tScene.value = sceneRT.texture;
      du.tCloud.value = cloud ? cloud.texture : black; du.uHasCloud.value = cloud ? 1 : 0;
      du.cameraNear.value = camera.near; du.cameraFar.value = camera.far; du.uMode.value = dv;
      pass(debugMat, null);
    } else {
      timed('final', () => pass(finalMat(), null));
    }

    // O — overlays at canvas resolution, display-referred.
    if (overlays.size) {
      renderer.setRenderTarget(null);
      renderer.clearDepth();
      for (const ov of overlays) renderer.render(ov, camera);
    }
    renderer.autoClear = prevAutoClear;
    pipeline.stats.fx = fxCount;
    pipeline.stats.clouds = !!cloud;
    if (bench.n) {
      const r = bench.res;
      r.post = +((r.composite || 0) + (r.godrays || 0) + (r.bloom || 0) + (r.final || 0)).toFixed(3);
      r.conditions = { width: W, height: H, samples, dpr: game.size?.dpr, quality: game.quality?.name, n: bench.n,
        clouds: !!cloud, fxObjects: fxCount, raysOn, bloomOn };
      pipeline.stats.bench = r;
      bench.n = 0;
      bench.resolve?.(r);
    }
  }

  const pipeline = {
    name: 'pipeline',
    FX_LAYER,
    settings,
    /** Handshake read by the clouds: true = the composite applies the anime alpha curve at full resolution, so the
     *  clouds may output soft alpha + a per-texel amount in depthTexture.a (their out.alphaSharpen.soft). */
    cloudAlphaSharpen: settings.cloudSharpen,
    stats: { width: 0, height: 0, samples: 0, fx: 0, clouds: false, cloudsCpuMs: 0, cloudSharpen: false },
    get depthTexture() { return sceneRT?.depthTexture || null; },
    get sceneTexture() { return sceneRT?.texture || null; },
    get size() { return { width: W, height: H }; },
    get debugView() { return debugView; },
    set debugView(v) { debugView = DEBUG_VIEWS[v] !== undefined ? v : 'none'; },
    setExposure(v) { settings.exposure = Math.max(0, +v || 0); },
    /** 0..1 radial motion blur at high speed; center in UV (default screen centre). */
    setSpeedBlur(v, center) {
      state.speedBlur = clamp(+v || 0, 0, 1);
      if (center) state.speedCenter.set(center.x, center.y);
    },
    setToneMapper(name) { if (TONEMAPS[name] !== undefined) settings.toneMapper = name; },
    /**
     * effects update — a shockwave across the screen from uv (0..1, y up): strength 0..1.5, speed in view heights / s,
     * life in s. Two at once; a third replaces the one furthest along. Quarter strength with prefers-reduced-motion.
     */
    ripple(u, v, strength = 1, speed = 1.3, life = 0.75) {
      if (!(strength > 0)) return false;
      const R = state.ripples[0].t / state.ripples[0].life >= state.ripples[1].t / state.ripples[1].life ? state.ripples[0] : state.ripples[1];
      R.x = clamp(+u || 0.5, -0.5, 1.5); R.y = clamp(+v || 0.5, -0.5, 1.5); R.t = 0;
      R.life = clamp(life, 0.2, 2.5); R.speed = clamp(speed, 0.2, 4); R.strength = clamp(strength, 0, 1.5) * (reducedMotion ? 0.25 : 1);
      return true;
    },
    /** effects update — an impact kick 0..1 (bloom swell, colour fringe, saturation); the strongest one running wins. */
    /** boss update — the titan fight's screen effects for this frame (call every frame they should show):
     *  { x, y (core uv), energy 0..1.5, enrage 0..1, flash 0..1, onScreen }. */
    setBoss(o = {}) {
      const B = state.boss;
      B.x = clamp(+o.x || 0.5, -0.5, 1.5); B.y = clamp(+o.y || 0.5, -0.5, 1.5);
      B.energy = clamp(+o.energy || 0, 0, 1.5); B.enrage = clamp(+o.enrage || 0, 0, 1);
      B.flash = clamp(+o.flash || 0, 0, 1) * (reducedMotion ? 0.35 : 1); B.onScreen = o.onScreen !== false; B.fresh = true;
    },
    kick(amount = 0.5) { state.kick = Math.max(state.kick, clamp(+amount || 0, 0, 1) * (reducedMotion ? 0.3 : 1)); },
    get impact() { return { kick: state.kick, ripples: state.ripples.map((r) => ({ ...r })) }; },
    /** Time every section on the next frame: resolves { scene, clouds, composite, fx, godrays, bloom, final, post }
     *  in ms (wall clock between two GPU round trips, n repetitions each) plus the conditions. */
    benchmark(n = 20) {
      bench.n = Math.max(1, n | 0); bench.res = {};
      return new Promise((res) => { bench.resolve = res; });
    },
    addOverlay(ovScene) {
      overlays.add(ovScene);
      return { remove: () => overlays.delete(ovScene) };
    },
    removeOverlay(ovScene) { overlays.delete(ovScene); },
    /** Draw this subtree after the cloud composite (fire, fireballs, sparks). */
    afterClouds(object) {
      object.traverse((o) => { o.layers.set(FX_LAYER); o.userData._fxChecked = true; });
      return object;
    },
    init() { alloc(); },
    /**
     * performance update — hand every material in the scene to the driver now (the programs build in the background
     * while the title is up) instead of on the frame that first shows it: the first fire breath, the first explosion,
     * the titan breaking the clouds no longer stop the game for the length of a shader compile. ?warm=0 turns it off.
     * Returns the number of materials prepared (0 when skipped).
     */
    warmup() {
      if (params.get('warm') === '0' || typeof renderer.compile !== 'function') return 0;
      alloc();
      const prev = renderer.getRenderTarget();
      const mask = camera.layers.mask;
      let n = 0;
      try {
        renderer.setRenderTarget(sceneRT);          // the HDR targets are linear: the programs must be built for them
        camera.layers.enableAll();
        const set = renderer.compile(scene, camera);
        n = set && set.size ? set.size : 0;
      } catch (e) {
        console.warn('[pipeline] shader warm-up skipped', e);
      } finally {
        camera.layers.mask = mask;
        renderer.setRenderTarget(prev);
      }
      pipeline.stats.warmed = n;
      return n;
    },
    render(simDt, realDt) {
      try {
        renderFrame(realDt);
      } catch (e) {
        if (!warnedRender) { console.error('[pipeline] render failed, falling back to a plain render', e); warnedRender = true; }
        try {
          renderer.setRenderTarget(null);
          renderer.autoClear = true;
          renderer.shadowMap.needsUpdate = true;
          camera.layers.enableAll();
          renderer.render(scene, camera);
        } catch { /* nothing more we can do this frame */ }
      }
    },
  };
  return pipeline;
}
