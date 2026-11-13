// GLSL for the volumetric clouds. Everything is GLSL ES 3.00 (three.js ShaderMaterial, glslVersion GLSL3 where MRT).
// Pipeline: bake (noise + tower SDF, once) -> march (cloud G-buffer, reduced res) -> temporal + anime shade -> output.

export const QUAD_VS = /* glsl */`
out vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// ---------------------------------------------------------------------------------------------------------------
// Bake: tileable noise. Worley cells and Perlin lattice wrap with `period`, so the 3D textures tile seamlessly.
export const NOISE_FS = /* glsl */`
precision highp float;
in vec2 vUv;
uniform float uLayer;      // z (0..1) of the slice being written
uniform float uSize;       // voxels per side
uniform int uKind;         // 0 = shape, 1 = detail
out vec4 fragColor;

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
float worley(vec3 p, float period) {             // p in [0,1)^3, returns F1 in cell units
  vec3 q = p * period;
  vec3 id = floor(q), f = fract(q);
  float md = 9.0;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 o = vec3(x, y, z);
    vec3 c = mod(id + o, period);
    vec3 d = o + hash33(c + 17.0) - f;
    md = min(md, dot(d, d));
  }
  return sqrt(md);
}
float grad(vec3 c, vec3 f) { vec3 g = hash33(c + 5.0) * 2.0 - 1.0; return dot(normalize(g + 1e-4), f); }
float perlin(vec3 p, float period) {
  vec3 q = p * period;
  vec3 i = floor(q), f = fract(q);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n000 = grad(mod(i, period), f);
  float n100 = grad(mod(i + vec3(1,0,0), period), f - vec3(1,0,0));
  float n010 = grad(mod(i + vec3(0,1,0), period), f - vec3(0,1,0));
  float n110 = grad(mod(i + vec3(1,1,0), period), f - vec3(1,1,0));
  float n001 = grad(mod(i + vec3(0,0,1), period), f - vec3(0,0,1));
  float n101 = grad(mod(i + vec3(1,0,1), period), f - vec3(1,0,1));
  float n011 = grad(mod(i + vec3(0,1,1), period), f - vec3(0,1,1));
  float n111 = grad(mod(i + vec3(1,1,1), period), f - vec3(1,1,1));
  return mix(mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y), mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y), u.z);
}
// Round billows: a sphere-shaped bump per Worley cell (domes, not cones), remapped so the average sits near 0.5.
float billow(vec3 p, float period) {
  float f = worley(p, period) * 1.1;            // sphere radius ~0.9 cell: bulges overlap, creases stay shallow
  return clamp(sqrt(max(1.0 - f * f, 0.0)) * 1.2 - 0.15, 0.0, 1.0);
}

void main() {
  vec3 p = vec3(vUv, uLayer);
  if (uKind == 0) {
    float pf = perlin(p, 4.0) * 0.55 + perlin(p, 8.0) * 0.3 + perlin(p, 16.0) * 0.15;
    pf = clamp(pf * 0.9 + 0.5, 0.0, 1.0);
    float b1 = billow(p, 5.0), b2 = billow(p, 10.0), b3 = billow(p, 20.0);
    float wf = b1 * 0.6 + b2 * 0.3 + b3 * 0.1;
    float pw = clamp((pf - (wf - 1.0)) / (2.0 - wf) , 0.0, 1.0);   // Perlin-Worley (Schneider 2015 remap)
    fragColor = vec4(pw, b1, b2, b3);
  } else {
    float b1 = billow(p, 4.0), b2 = billow(p, 8.0), b3 = billow(p, 16.0);
    float pf = clamp(perlin(p, 6.0) * 0.6 + perlin(p, 12.0) * 0.4 + 0.5, 0.0, 1.0);
    fragColor = vec4(b1, b2, b3, pf);
  }
}
`;

// Bake: signed distance (m) to the smooth union of each tower's ellipsoid lobes, one xz slice per draw.
export const FIELD_FS = /* glsl */`
precision highp float;
precision highp sampler2D;
in vec2 vUv;
uniform sampler2D uSpheres;    // RGBA32F: row 0 = centre xyz, row 1 = radii xyz
uniform sampler2D uTowers;     // RGBA32F: row 0 = min xyz + first sphere, row 1 = max xyz + count, row 2 = base, k, base rounding
uniform int uTowerCount;
uniform float uY;
uniform vec2 uWarp;            // L, S
uniform vec2 uClamp;
out vec4 fragColor;
float sdEllipsoid(vec3 q, vec3 r) {
  float k0 = length(q / r), k1 = length(q / (r * r));
  return k1 > 1e-9 ? k0 * (k0 - 1.0) / k1 : -min(r.x, min(r.y, r.z));
}
float smin(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return min(a, b) - h * h * k * 0.25; }
void main() {
  vec2 s = (vUv - 0.5) * 2.0 * uWarp.y;
  vec2 xz = sign(s) * uWarp.x * (exp(abs(s) / uWarp.x) - 1.0);
  vec3 p = vec3(xz.x, uY, xz.y);
  float d = uClamp.y;
  for (int t = 0; t < 64; t++) {
    if (t >= uTowerCount) break;
    vec4 a = texelFetch(uTowers, ivec2(t, 0), 0);
    vec4 b = texelFetch(uTowers, ivec2(t, 1), 0);
    vec3 q = max(max(a.xyz - p, p - b.xyz), 0.0);
    float box = length(q);
    // Far from the box: its distance is a safe lower bound. Near it, evaluate exactly (keeps the field continuous).
    if (box > 800.0) { d = min(d, box); continue; }
    vec4 c = texelFetch(uTowers, ivec2(t, 2), 0);
    int st = int(a.w + 0.5), cnt = int(b.w + 0.5);
    float dt = 1e5;
    for (int i = 0; i < 512; i++) {
      if (i >= cnt) break;
      vec4 sc = texelFetch(uSpheres, ivec2(st + i, 0), 0);
      vec4 sr = texelFetch(uSpheres, ivec2(st + i, 1), 0);
      dt = smin(dt, sdEllipsoid(p - sc.xyz, sr.xyz), c.y);
    }
    dt = -smin(-dt, p.y - c.x, c.z);  // flat cumulus base with a rounded edge (smooth max, radius c.z m)
    d = min(d, dt);
  }
  fragColor = vec4(clamp(d, uClamp.x, uClamp.y), 0.0, 0.0, 1.0);
}
`;

// Wave 4: 3D noise -> CPU readback, 4 voxels per RGBA8 texel (value = dot(texel, uW)), for the CPU density twin.
export const READBACK_FS = /* glsl */`
precision highp float;
precision highp sampler3D;
uniform sampler3D uTex;
uniform int uSize;
uniform vec4 uW;
uniform int uWidth;
out vec4 fragColor;
float voxel(int i) {
  ivec3 c = ivec3(i % uSize, (i / uSize) % uSize, i / (uSize * uSize));
  return dot(texelFetch(uTex, c, 0), uW);
}
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  int b = (f.y * uWidth + f.x) * 4;
  int n = uSize * uSize * uSize;
  fragColor = vec4(voxel(min(b, n - 1)), voxel(min(b + 1, n - 1)), voxel(min(b + 2, n - 1)), voxel(min(b + 3, n - 1)));
}
`;

// ---------------------------------------------------------------------------------------------------------------
// Shared density model. "inside" = metres inside the cloud surface (>0 inside); density = sat(inside / edge).
export const CLOUD_COMMON = /* glsl */`
precision highp float;
precision highp sampler3D;
uniform sampler3D uField;      // tower SDF (m), xz log-warped, y linear
uniform sampler2D uWeather;    // deck map (log-warped xz): r cell value, g thickness, b base offset
uniform sampler3D uShape;      // RGBA8: perlin-worley, billows x3
uniform sampler3D uDetail;     // RGBA8: fine billows x3, perlin
uniform vec4 uFieldMap;        // L, S, yMin, yMax
uniform vec2 uWeatherMap;      // L, S
uniform vec4 uDeck;            // base, thickness, coverage, topMax
uniform float uDeckBaseVar;
uniform vec4 uNoise;           // shapeAmp, detailAmp, edge, shapeTile
uniform vec4 uNoise2;          // detailTile, time, detailFar, bias
uniform vec4 uNoise3;          // near-field billows: amplitude (m), tile (m), fade distance (m); far tower erosion growth
uniform vec3 uWindOffset;      // accumulated drift (m)
uniform float uTowerGrow;      // extra metres added to tower envelopes (weather coverage)
uniform vec4 uDisp[8];         // displacers: xyz centre, w radius
uniform float uDispK[8];       // strength 0..1
uniform float uDispS[8];       // wave 5: size of the ragged-edge billows per displacer (m, its initial radius)
uniform vec4 uDispRag;         // wave 5: ragged edge amplitude (fraction of the radius, 0 = wave-4 edge), rim lumps, lobe size
uniform int uDispN;

float sat(float x) { return clamp(x, 0.0, 1.0); }
vec2 warpXZ(vec2 v, float L) { return sign(v) * L * log(1.0 + abs(v) / L); }

float towerSdf(vec3 p) {
  vec2 s = warpXZ(p.xz, uFieldMap.x) / (2.0 * uFieldMap.y) + 0.5;
  float fy = (p.y - uFieldMap.z) / (uFieldMap.w - uFieldMap.z);
  float d = texture(uField, vec3(s.x, s.y, fy)).r;
  float outY = max(uFieldMap.z - p.y, p.y - uFieldMap.w);
  return max(d, outY) - uTowerGrow;
}
vec4 deckMap(vec2 xz) { return texture(uWeather, warpXZ(xz, uWeatherMap.x) / (2.0 * uWeatherMap.y) + 0.5); }
float deckInside(vec3 p) {
  vec4 w = deckMap(p.xz);
  float cov = (w.r - (1.0 - uDeck.z)) / max(uDeck.z, 0.05);
  float base = uDeck.x + (w.b - 0.5) * uDeckBaseVar;
  float cell = cov > 0.0 ? sqrt(cov) : cov * 2.0;
  // Cells = clusters of domes: the dome field always shapes the top (soft clamp, no flat plateau on thick cells).
  float body = cell * (0.8 + 0.4 * w.g);
  float fillT = body > 0.0 ? 1.0 - exp(-body * 1.9) : body;
  float top = base + uDeck.y * fillT * (0.5 + 0.5 * w.a);
  return min(top - p.y, (p.y - base) * 1.5);
}
// Envelope without noise, plus gap: metres the ray may advance without reaching anything the noise can grow.
// Deck walls are steep (vertical distance overestimates), so its gap is scaled down.
float envelope(vec3 p, out float gap) {
  float m = uNoise.x * 0.5 + uNoise.y * 0.5 + 20.0;
  float dT = towerSdf(p);
  float e = -dT;
  float lo = uDeck.x - uDeckBaseVar * 0.5 - 40.0, hi = uDeck.w + 40.0;
  if (p.y > lo && p.y < hi) {
    float di = deckInside(p);
    e = max(e, di);
    gap = min(dT - m, (-di - m) * 0.35);
  } else gap = min(dT, p.y >= hi ? p.y - hi : lo - p.y) - m;
  return e;
}
float displace(vec3 p, float ins) {
  for (int i = 0; i < 8; i++) {
    if (i >= uDispN) break;
    vec4 dp = uDisp[i];
    vec3 d = p - dp.xyz;
    float dist = length(d);
    if (dist > dp.w * 1.9) continue;
    float k = uDispK[i];
    float nz = texture(uShape, p / (uNoise.w * 0.45)).g;           // large-scale shape of the hole (mean radius = w)
    float R = dp.w * (1.0 + 0.4 * (nz - 0.79));
    float lump = 1.0;
    if (uDispRag.x > 0.0 && dist > dp.w * 0.35) {
      // Wave 5: torn anime edge instead of a smooth glossy bowl. Billows sized to the hole (uDispS = its initial
      // radius, so the pattern stays put while the hole grows or moves): round puffs of cloud reach into the opening
      // (high billow = smaller radius), narrow cracks open between them, finer puffs ride on the lobes; the wall gets
      // puff-scale shading normals from the same surface, and the piled-up rim is lumpy instead of a clean torus.
      vec4 rb = texture(uDetail, (p + uWindOffset) / (max(uDispS[i], 20.0) * uDispRag.z) + vec3(0.37, 0.53, 0.71));   // CPU twin: same
      float rag = rb.r * 0.5 + rb.g * 0.32 + rb.b * 0.18;
      R *= 1.0 - uDispRag.x * (rag - 0.79);
      lump = mix(1.0, 0.2 + 1.7 * sat((rb.r - 0.45) / 0.55), uDispRag.y);
    }
    float hole = dist - R;
    float rim = exp(-pow((dist - dp.w * 1.12) / (dp.w * 0.32), 2.0)) * dp.w * 0.28 * lump;
    ins = mix(ins, min(ins, hole), k) + k * rim * sat((ins + dp.w * 0.3) / (dp.w * 0.3));
  }
  return ins;
}
// Noise erosion: round billows on the big lobes, fine billows near the surface (faded with distance) and, within a
// few hundred metres of the camera, near-field cauliflower puffs (wave 4, uNoise3) so close surfaces keep domes.
// grow >= 1 scales the big billows with distance on towers (far towers keep bumpy crowns instead of smooth boxes).
float nearBillow(vec3 q) {
  vec4 dn = texture(uDetail, (q + vec3(0.0, uNoise2.y * 0.9, 0.0)) / uNoise3.y + vec3(0.37, 0.61, 0.13));
  return dn.r * 0.5 + dn.g * 0.33 + dn.b * 0.17;
}
float erode(vec3 p, float e, float t, bool detail, float grow) {
  vec3 q = p + uWindOffset;
  vec4 sh = texture(uShape, q / (uNoise.w * (1.0 + (grow - 1.0) * 0.6)));
  float bill = sh.g * 0.5 + sh.b * 0.32 + sh.a * 0.18;
  float body = smoothstep(uDeck.x - 40.0, uDeck.x + 260.0, p.y);    // keep the flat bases flat
  float ins = e + (bill - uNoise2.w) * uNoise.x * grow * mix(0.3, 1.0, body);
  if (detail && ins > -uNoise.y - uNoise3.x && ins < 160.0) {
    float fade = 1.0 - smoothstep(uNoise2.z * 0.35, uNoise2.z, t);
    if (fade > 0.0) {
      vec4 de = texture(uDetail, (q + vec3(0.0, uNoise2.y * 1.6, 0.0)) / uNoise2.x);
      float db = de.r * 0.55 + de.g * 0.3 + de.b * 0.15;
      ins += (db - 0.5) * uNoise.y * fade * (1.0 - sat(ins / 160.0)) * mix(0.5, 1.0, body);
      float nf = 1.0 - smoothstep(uNoise3.z * 0.45, uNoise3.z, t);
      if (nf > 0.0 && ins > -uNoise3.x && ins < 70.0)
        ins += (nearBillow(q) - 0.5) * uNoise3.x * nf * (1.0 - sat(ins / 70.0)) * mix(0.6, 1.0, body);
    }
  }
  return ins;
}
float farGrow(float t) { return 1.0 + uNoise3.w * smoothstep(4000.0, 24000.0, t); }
float cheapInside(vec3 p) {
  float sk;
  float e = envelope(p, sk);
  if (e < -uNoise.x) return e;
  return displace(p, erode(p, e, 0.0, false, 1.0));
}
// Light-march density: big lobes only (half the shape erosion) so self-shadows follow the billows, not the noise.
float lightInside(vec3 p) {
  float sk;
  float e = envelope(p, sk);
  if (e < -uNoise.x * 0.35) return e;
  vec4 sh = texture(uShape, (p + uWindOffset) / uNoise.w);
  return displace(p, e + (sh.g - uNoise2.w) * uNoise.x * 0.35);
}
// Normal density: the bulges that show in the silhouette (envelope + large and mid billows), so the cel terminator
// wraps each cauliflower bulge.
float normalInside(vec3 p) {
  float sk;
  float e = envelope(p, sk);
  vec4 sh = texture(uShape, (p + uWindOffset) / uNoise.w);
  float body = smoothstep(uDeck.x - 40.0, uDeck.x + 260.0, p.y);
  return displace(p, e + (sh.g * 0.7 + sh.b * 0.3 - uNoise2.w) * uNoise.x * 0.7 * mix(0.3, 1.0, body));
}
`;

// ---------------------------------------------------------------------------------------------------------------
// Wave 5: dragons keep a silhouette inside clouds (gameplay request). Nearby dragons are spheres with a view
// transmittance floor (Sora 0.8, others 0.6 within ~150 m of the camera, fading out beyond); a ray whose scene hit
// lies on one of them never loses more than 1 - floor to the cloud in front of it. Shared by the march and resolve.
export const SIL_CHUNK = /* glsl */`
uniform vec4 uSil[8];          // dragon centre xyz, radius (m)
uniform float uSilT[8];        // transmittance floor (0..1)
uniform int uSilN;
float silFloor(vec3 p) {
  float f = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= uSilN) break;
    float r = uSil[i].w;
    f = max(f, uSilT[i] * (1.0 - smoothstep(r * 0.85, r, length(p - uSil[i].xyz))));
  }
  return f;
}
`;

// ---------------------------------------------------------------------------------------------------------------
// March -> cloud G-buffer.
//   oA = (sun light for the bands, lobe N.L * 0.5 + 0.5, crease occlusion, alpha)
//   oB = (weighted front distance or march limit, normal.y * 0.5 + 0.5, rim (1 - |N.V|), march limit)
// Wave 4: oA.x outside = large-scale sun visibility (soft SDF shadow through the eroded envelopes from just outside the
// first-hit surface: follows lobes, overhangs and other towers, never the skin noise) x a little volumetric light;
// for rays that start inside a cloud (camera in fog) it is the volumetric in-scatter average (brighter toward the sun,
// darker cores).
export const MARCH_FS = /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
uniform sampler2D uDepth;
uniform int uHasDepth;
uniform vec2 uDepthSize;
uniform mat4 uProjInv;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform vec2 uNearFar;
uniform vec2 uRes;             // cloud buffer (history) resolution
uniform vec2 uJitter;          // sub-pixel jitter, cloud-buffer pixels
uniform vec2 uOffset;          // which pixel of each uUp x uUp block is marched this frame
uniform float uUp;             // 1 = march every pixel, 2 = one pixel per 2x2 block per frame (temporal upsampling)
uniform float uFrame;
uniform vec3 uSunDir;
uniform vec4 uMarch;           // max steps, light steps, max distance, step growth (m per m)
uniform vec4 uLight;           // view extinction, light extinction, first light segment, min step
uniform vec4 uInterior;        // interior density, camera-inside amount, interior pocket contrast, near-camera thinning (m)
uniform vec4 uPuff2;           // deck trough crease strength, soft shadow sharpness, normal step (m per m, min m)
uniform vec4 uPuff3;           // close-range bump gain of the fine / near billows in the shading normal, range (m), soft-shadow steps
uniform vec4 uPuff;            // shading normal: small shape billows weight, fine billows weight (near); crease gain, radius k
// Wave 5: the titan casts its shadow on the clouds — its hit capsules (a, b, radius) as sun occluders.
uniform vec4 uOccA[40];        // capsule end a xyz, radius (m)
uniform vec4 uOccB[40];        // capsule end b xyz (b = a: sphere)
uniform int uOccN;
uniform vec4 uOccBound;        // bounding sphere of all capsules: centre xyz, radius
uniform vec2 uOccSoft;         // penumbra half-width: metres + metres per metre toward the sun
${SIL_CHUNK}

float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

// Sun visibility past the titan's capsules from a cloud surface point (1 = lit). Closest approach of the sun ray
// (p + L s, s >= 0) to each segment; a narrow soft edge (penumbra grows with the distance to the occluder), anime-crisp.
float occluderShadow(vec3 p) {
  if (uOccN <= 0) return 1.0;
  vec3 oc = uOccBound.xyz - p;
  float s0 = dot(oc, uSunDir);
  if (s0 < -uOccBound.w || dot(oc, oc) - s0 * s0 > uOccBound.w * uOccBound.w) return 1.0;
  float vis = 1.0;
  for (int i = 0; i < 40; i++) {
    if (i >= uOccN) break;
    vec3 a = uOccA[i].xyz, ba = uOccB[i].xyz - a, w0 = p - a;
    float r = uOccA[i].w;
    float B = dot(uSunDir, ba), C = dot(ba, ba), D = dot(uSunDir, w0), E = dot(ba, w0);
    float u = C > 1e-4 ? clamp((E - B * D) / max(C - B * B, 1e-4 * C), 0.0, 1.0) : 0.0;
    float s = max(B * u - D, 0.0);
    u = C > 1e-4 ? clamp((E + B * s) / C, 0.0, 1.0) : 0.0;
    float dist = length(w0 + uSunDir * s - ba * u);
    float pen = uOccSoft.x + uOccSoft.y * s;
    vis = min(vis, smoothstep(r - pen, r + pen, dist));
  }
  return vis;
}

// Wave 4: clouds thin out toward the march limit (the weather map repeats its edge beyond 60 km: a flat deck slab cut
// at maxDist drew a straight "shelf" line along the horizon).
float farFade(float t) { return 700.0 * smoothstep(uMarch.z * 0.62, uMarch.z * 0.9, t); }
float fullInside(vec3 p, float t, float grow) {
  float sk;
  float e = envelope(p, sk) - farFade(t);
  if (e < -uNoise.x * grow - uNoise.y - uNoise3.x) return e;
  return displace(p, erode(p, e, t, true, grow));
}
float sunOD(vec3 p, float jit) {
  float od = 0.0, s = 0.0, seg = uLight.z;
  int n = int(uMarch.y);
  // Camera inside: 3 longer segments (reach ~500 m) so the fog is brighter toward the sun and darker in the core
  // (the thinner near-camera fog makes rays longer; 4 segments cost ~1 ms there).
  if (uInterior.y > 0.5) { n = min(n, 3); seg = uLight.z * 2.7; }
  for (int j = 0; j < 10; j++) {
    if (j >= n) break;
    vec3 q = p + uSunDir * (s + seg * (0.35 + 0.3 * jit));
    if (q.y > uFieldMap.w) break;
    od += sat(lightInside(q) / uNoise.z) * seg;
    s += seg; seg *= 2.0;
  }
  return od * uLight.y;
}
// Shading surface: the bulges plus the small puffs you see in the silhouette (all shape billows + fine billows
// near the camera + the near-field puffs, same offsets as erode()), so the painted terminator wraps every puff.
float puffInside(vec3 p, float fine, float nearF) {
  float sk;
  float e = envelope(p, sk);
  vec3 q = p + uWindOffset;
  vec4 sh = texture(uShape, q / uNoise.w);
  float body = smoothstep(uDeck.x - 40.0, uDeck.x + 260.0, p.y);
  float bulge = sh.g * 0.7 + sh.b * 0.3;
  float bill = sh.g * 0.5 + sh.b * 0.32 + sh.a * 0.18;
  e += (mix(bulge, bill, uPuff.x) - uNoise2.w) * uNoise.x * mix(0.7, 0.9, uPuff.x) * mix(0.3, 1.0, body);
  if (fine > 0.0) {
    vec4 de = texture(uDetail, (q + vec3(0.0, uNoise2.y * 1.6, 0.0)) / uNoise2.x);
    e += ((de.r * 0.55 + de.g * 0.3 + de.b * 0.15) - 0.5) * uNoise.y * fine * mix(0.5, 1.0, body);
  }
  if (nearF > 0.0) e += (nearBillow(q) - 0.5) * uNoise3.x * nearF * mix(0.6, 1.0, body);
  return displace(p, e);
}
vec3 lobeNormal(vec3 p, float t, float fine, float nearF) {
  // Wave 4: the gradient step grows with distance (uPuff2.z m per m, at least uPuff2.w m) so the shading normal
  // follows puffs of a constant screen size: with 6 m taps at 400 m it followed the 9 m near-field cells and the
  // close-up read as speckle (white flecks on blue).
  float h = clamp(t * uPuff2.z, uPuff2.w, 160.0);
  const vec2 k = vec2(1.0, -1.0);
  vec3 g = k.xyy * puffInside(p + k.xyy * h, fine, nearF) + k.yyx * puffInside(p + k.yyx * h, fine, nearF)
         + k.yxy * puffInside(p + k.yxy * h, fine, nearF) + k.xxx * puffInside(p + k.xxx * h, fine, nearF);
  return -normalize(g + vec3(0.0, 1e-5, 0.0));
}
// Large-scale sun visibility from a surface point: a soft shadow ray (Quilez penumbra) through the eroded envelopes
// (cheapInside: towers + deck + shape billows + displacers, the same big forms the silhouette shows), started just
// outside the surface along the normal. Smooth by construction: overhangs, lobes and other towers cast soft shadows,
// the skin noise does not ("cow print" in wave 3 came from light-marching inside the noisy skin).
float envShadow(vec3 p, vec3 n, float t) {
  vec3 o = p + n * clamp(t * 0.012, 14.0, 70.0) + uSunDir * 6.0;
  float res = 1.0, s = 18.0;
  int nS = int(uPuff3.z);
  for (int i = 0; i < 12; i++) {
    if (i >= nS) break;
    vec3 q = o + uSunDir * s;
    if (q.y > uFieldMap.w + 40.0) break;
    float d = -cheapInside(q);
    res = min(res, sat(0.5 + uPuff2.y * d / s));
    if (res < 0.01) break;
    s += clamp(d * 0.75, 22.0, 520.0);
  }
  return res * res * (3.0 - 2.0 * res);
}

void main() {
  vec2 uv = (floor(gl_FragCoord.xy) * uUp + uOffset + 0.5 + uJitter) / uRes;
  vec4 v = uProjInv * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec3 vd = normalize(v.xyz / v.w);
  vec3 rd = normalize(mat3(uCamWorld) * vd);
  vec3 ro = uCamPos;

  float tScene = 1e7;
  if (uHasDepth > 0) {
    ivec2 ip = clamp(ivec2(uv * uDepthSize), ivec2(0), ivec2(uDepthSize) - 1);
    float d = texelFetch(uDepth, ip, 0).r;
    if (d < 0.999999) {
      float vz = (uNearFar.x * uNearFar.y) / ((uNearFar.y - uNearFar.x) * d - uNearFar.y);
      tScene = vz / vd.z;
    }
  }
  float y0 = uDeck.x - uDeckBaseVar * 0.5 - 60.0, y1 = uFieldMap.w;
  float t0 = 0.0, t1 = 1e7;
  if (abs(rd.y) > 1e-6) {
    float ta = (y0 - ro.y) / rd.y, tb = (y1 - ro.y) / rd.y;
    t0 = max(min(ta, tb), 0.0); t1 = max(ta, tb);
  } else if (ro.y < y0 || ro.y > y1) { t1 = -1.0; }
  float tMax = min(min(t1, tScene), uMarch.z);
  float tLimit = min(tScene, uMarch.z);
  // Wave 5: the scene hit is a nearby dragon -> the cloud in front of it keeps at least this view transmittance.
  float floorT = uSilN > 0 && tScene < 1e6 ? silFloor(ro + rd * tScene) : 0.0;
  // Deck zone along this ray.
  float zlo = uDeck.x - uDeckBaseVar * 0.5 - 40.0, zhi = uDeck.w + 40.0;
  float tz0 = 1e7, tz1 = -1.0;
  if (abs(rd.y) > 1e-6) {
    float za = (zlo - ro.y) / rd.y, zb = (zhi - ro.y) / rd.y;
    tz0 = max(min(za, zb), 0.0); tz1 = max(za, zb);
  } else if (ro.y > zlo && ro.y < zhi) { tz0 = 0.0; tz1 = 1e7; }
  float margin0 = uNoise.y * 0.5 + uNoise3.x * 0.5 + 20.0;
  float mu = dot(rd, uSunDir);

  float T = 1.0, sumW = 0.0, sunA = 0.0, tA = 0.0, lastTs = 1.0, nearA = 0.0, wlA = 0.0, wlW = 0.0;
  float ndl = 0.5, ao = 1.0, ny = 0.5, rim = 0.0, shB = 1.0, tHit = 0.0;
  bool hit = false;
  float jit = fract(ign(gl_FragCoord.xy) + uFrame * 0.618034);
  // Second, decorrelated sequence for the phase of the samples in the skin after the surface is found.
  float jit2 = fract(ign(gl_FragCoord.yx + 17.0) + uFrame * 0.7548777);
  float jitL = 0.5;   // fixed light offsets: per-frame jitter here flickers the stepped bands
  float minStep = uLight.w;
  float t = t0 + max(minStep, t0 * uMarch.w) * jit;
  int maxSteps = int(uMarch.x);
  bool wasEmpty = true;
  float prevT = t;

  for (int i = 0; i < 256; i++) {
    if (i >= maxSteps || t > tMax || T < max(0.03, floorT + 0.002)) break;
    vec3 p = ro + rd * t;
    float dtBase = max(minStep, t * uMarch.w);
    // Envelope + conservative skip. The deck zone is entered/left along the ray analytically (tz0..tz1).
    float dT = towerSdf(p);
    float e = -dT;
    float di = -1e5;
    if (t >= tz0 && t <= tz1) { di = deckInside(p); e = max(e, di); }
    e -= farFade(t);
    // Far towers: bigger billows (the SDF texels there are 250-400 m; 80 m bumps vanish at 20 km).
    float grow = mix(1.0, farGrow(t), sat((-dT - di) / 200.0 + 0.5));
    float margin = margin0 + uNoise.x * 0.5 * grow;
    float gap = dT - margin;
    if (di > -1e4) gap = min(gap, (-di - margin) * 0.35);
    else if (t < tz0) gap = min(gap, tz0 - t + 1.0);
    if (gap > 0.0) { prevT = t; t += max(dtBase, gap); wasEmpty = true; continue; }   // empty-space skip
    float ins = displace(p, erode(p, e, t, true, grow));
    if (ins <= 0.0) { prevT = t; t += max(dtBase, -ins * 0.3); wasEmpty = true; continue; }
    float dt = max(minStep, t * uMarch.w * 0.6);
    if (wasEmpty && t - prevT > minStep * 0.5) {
      // Entered from an empty step: bisect back to the surface (3 halvings) so the lit skin is not skipped, then
      // start the skin samples at a jittered phase of one step (stratified; the history averages it). A fixed phase
      // after a coarse approach step drew concentric rings on smooth deck domes (wave 3 report).
      float a = prevT, b = t;
      for (int k = 0; k < 3; k++) {
        float m = 0.5 * (a + b);
        if (fullInside(ro + rd * m, m, grow) > 0.0) b = m; else a = m;
      }
      t = b + dt * jit2 * 0.9;
      p = ro + rd * t;
      ins = max(fullInside(p, t, grow), 0.0);
    }
    wasEmpty = false;
    // Skin: dense (crisp silhouettes) over the first uNoise.z metres, then a lighter interior with billowy pockets
    // and cores (flying inside shows depth and motion instead of a uniform grey).
    float deep = sat((ins - 120.0) / 260.0);
    float interior = uInterior.x;
    if (deep > 0.0) {
      vec4 pk = texture(uDetail, (p + uWindOffset * 1.4) / (uNoise2.x * 0.7) + vec3(0.21, 0.47, 0.83));
      float pocket = pk.r * 0.55 + pk.g * 0.3 + pk.b * 0.15;
      interior *= mix(1.0, 0.25 + 1.5 * smoothstep(0.35, 0.95, pocket), uInterior.z);
    }
    float dens = sat(ins / uNoise.z) * mix(1.0, interior, deep);
    float wLit = 0.5;
    if (uInterior.y > 0.0 && t < 800.0) {
      // Camera inside: thin fog with billowy dense wisps rushing past.
      vec3 wq = (p + uWindOffset * 2.0) / (uNoise2.x * 0.55);
      vec4 wv = texture(uDetail, wq);
      float wisp = smoothstep(0.5, 0.78, wv.a) * (0.45 + 0.55 * wv.r);
      float kIn = uInterior.y * (1.0 - smoothstep(350.0, 800.0, t));
      dens = mix(dens, mix(dens * 0.16, 0.9, wisp), kIn);
      // Wave 4: each wisp gets a lit and a shaded side (directional derivative toward the sun, 14 m): denser toward
      // the sun = in its own shadow. Read by the resolve as the near-wisp light (fog is no longer one flat colour).
      // Gradient of the smooth fields, everywhere (a gradient of the thresholded wisp, or one skipped between wisps,
      // drew outlines round every wisp).
      vec4 ws = texture(uDetail, wq + uSunDir * (16.0 / (uNoise2.x * 0.55)));
      wLit = sat(0.5 + (wv.a - ws.a) * 2.4 + (wv.r - ws.r) * 1.0);
    }
    // Near the camera the cloud thins out (never more than ~15 % of the own dragon hidden at chase distance).
    dens *= mix(0.12, 1.0, smoothstep(4.0, uInterior.w, t)) * smoothstep(0.5, 3.0, t);
    // Skin: never step over the dense edge in one go (quantised skin sampling drew rings / combs). Near only: far
    // away the skin is sub-pixel and the clamp would multiply the steps of every horizon ray.
    if (ins < uNoise.z * 1.5 && t < 2500.0) dt = min(dt, max(minStep, uNoise.z * 0.45));
    if (!hit) {
      hit = true;
      tHit = t;
      float fine = uPuff.y * (1.0 - smoothstep(1200.0, 5000.0, t));
      float nearF = 1.0 - smoothstep(uNoise3.z * 0.45, uNoise3.z, t);
      // Close up the big lobes are flat walls at screen scale: exaggerate the small billows in the shading normal
      // only (bump, silhouette unchanged) so the near-field puffs read.
      float bump = mix(uPuff3.x, 1.0, smoothstep(uPuff3.y * 0.15, uPuff3.y, t));
      vec3 n = lobeNormal(p, t, max(fine, 0.35 * (bump - 1.0)) * bump, nearF * bump);
      ndl = dot(n, uSunDir) * 0.5 + 0.5;
      ny = n.y * 0.5 + 0.5;
      rim = 1.0 - abs(dot(n, rd));
      shB = envShadow(p, n, t);
      if (uOccN > 0) shB *= occluderShadow(p + n * 2.0);   // wave 5: the titan's cast shadow
      // Crease occlusion at bulge scale (SDF AO, 2 taps along the normal, screen-size-stable radius): 1 on convex
      // bulges, lower where neighbouring bulges close in, so the anime blue-grey creases separate the puffs.
      if (uPuff.w > 0.0) {
        float h = clamp(t * uPuff.w, 25.0, 420.0);
        float o1 = max(puffInside(p + n * (h * 0.45), fine, nearF) + h * 0.45, 0.0) / (h * 0.45);
        float o2 = max(puffInside(p + n * h, fine, nearF) + h, 0.0) / h;
        ao = sat(1.0 - (o1 * 0.55 + o2 * 0.45) * uPuff.z);
      } else {
        float h = clamp(t * 0.012, 60.0, 260.0);                 // wave-1 crease (one big-lobe tap), cheaper
        ao = sat(-lightInside(p + n * h) / h);
      }
      // Deck: the troughs between its domes read as soft blue creases (rows of puffs at grazing angles).
      float zl = uDeck.x - uDeckBaseVar * 0.5 - 40.0;
      if (uPuff2.x > 0.0 && p.y > zl && p.y < uDeck.w + 40.0) {
        vec4 wd = deckMap(p.xz);
        if (deckInside(p) > -towerSdf(p) - 40.0) ao = min(ao, 1.0 - uPuff2.x * pow(1.0 - wd.a, 1.5) * smoothstep(zl, zl + 250.0, p.y));
      }
    }
    // Sun visibility; once the view transmittance is low the remaining samples barely show, reuse the last value.
    if (T > 0.3 || sumW == 0.0) {
      float od = sunOD(p, jitL);
      lastTs = max(exp(-od), 0.7 * exp(-0.25 * od));   // multiple-scattering lightening (Nubis)
    }
    float Ts = lastTs;
    float stepT = exp(-dens * uLight.x * dt);
    float Tn = max(T * stepT, floorT);     // wave 5: never below a nearby dragon's floor (0 elsewhere)
    float w = T - Tn;
    sunA += w * Ts; tA += w * t; sumW += w;
    if (t < 90.0) nearA += w;
    if (t < 800.0) { wlA += w * wLit; wlW += w; }
    T = Tn;
    prevT = t; t += dt;
  }
  float alpha = 1.0 - T;
  if (T > 0.985) alpha = 0.0;
  float inv = sumW > 1e-5 ? 1.0 / sumW : 0.0;
  float tFront = sumW > 1e-5 ? tA * inv : tLimit;
  float vol = sunA * inv;
  // Bands: big-scale shadow, a little volumetric light (more when backlit: thin fringes glow); rays that start
  // inside a cloud keep the volumetric in-scatter.
  float volW = mix(0.25, 0.75, smoothstep(0.15, 0.8, mu));
  float band = shB * mix(1.0, sat(vol * 1.35), volW);
  float inW = 1.0 - smoothstep(6.0, 40.0, tHit);
  // Rays that start inside a cloud: z carries the near-wisp light (0.5 = neutral) instead of the crease.
  float wl = wlW > 1e-4 ? wlA / wlW : 0.5;
  oA = vec4(mix(band, vol, inW), ndl, mix(ao, wl, inW * sat(uInterior.y * 2.0)), alpha);
  // Camera inside a cloud: the rim channel carries the opacity of the first 90 m (near wisps) instead.
  oB = vec4(min(tFront, 60000.0), ny, mix(rim, nearA, sat(uInterior.y)), min(tLimit, 60000.0));
}
`;

// ---------------------------------------------------------------------------------------------------------------
// Temporal accumulation (reprojection by the cloud's own depth, neighbourhood clamp) + anime shading.
//   o0/o1 = new history (same layout as the march), o2 = premultiplied linear HDR colour,
//   o3 = (front m or 0, march limit m, alpha, sharpen amount for the pipeline)
export const RESOLVE_FS = /* glsl */`
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;
uniform sampler2D uCurA, uCurB, uHistA, uHistB;
uniform mat4 uPrevViewProj, uProjInv, uCamWorld;
uniform vec3 uCloudCamPos;
uniform vec2 uRes;             // cloud buffer resolution
uniform vec2 uLowRes;          // march resolution
uniform vec2 uOffset;          // pixel of each block marched this frame
uniform float uUp;
uniform float uBlend;          // base weight of the new frame
uniform int uReset;
uniform vec3 uSunDir;
// palette (linear, pre-scaled by light intensity)
uniform vec3 uLit, uWarm, uMid, uShadow, uDeep, uBounce, uRim, uFog;
uniform vec4 uBands;           // band1, band2, softness, lobe weight
uniform vec4 uLook;            // crease strength, rim strength, darkness, camera fog
uniform vec4 uPaint;           // painted top light: base lift, extra lift in front light, haze strength, shadow form
uniform vec2 uSharp;           // alpha sharpen: amount near, amount far
uniform vec2 uSharpLoHi;       // alpha sharpen smoothstep edges (lo, hi)
uniform int uSoftAlpha;        // 1 = output soft alpha + per-texel sharpen amount (the pipeline sharpens at full res)
uniform int uDebug;
${SIL_CHUNK}
ATMO_CHUNK
float sat(float x) { return clamp(x, 0.0, 1.0); }
// Perceptual blend of two HDR colours (log space: the tone maps are log-like above ~1).
vec3 lmix(vec3 a, vec3 b, float t) { return exp2(mix(log2(max(a, vec3(1e-4))), log2(max(b, vec3(1e-4))), t)); }

vec3 rayDir(vec2 uv) {
  vec4 v = uProjInv * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  return normalize(mat3(uCamWorld) * normalize(v.xyz / v.w));
}

vec3 gDbg = vec3(0.0);         // debug channels 7..9: painted lobe term, crease, final light amount
vec4 shade(vec4 A, vec4 B, vec3 rd, out float sharpAmt) {
  float alpha = A.w;
  sharpAmt = 0.0;
  if (alpha < 0.003) return vec4(0.0);
  float sunVis = A.x, ndl = A.y * 2.0 - 1.0, ao = A.z, ny = B.y * 2.0 - 1.0, fres = B.z;
  vec3 P = uCloudCamPos + rd * B.x;
  float mu = dot(rd, uSunDir);
  // Painted key light: the sun lifted toward the zenith (more so in front light, where the real sun lights every
  // bulge head-on and the forms go flat) — each puff gets a lit crown and a shaded underside, as painters do.
  // N.Lp is exact from the stored N.L and N.y (both linear in N, so also after temporal accumulation).
  // "Front light" = the sun behind the camera horizontally; looking down at the deck is not front light.
  vec2 rh = rd.xz, sh2 = uSunDir.xz;
  float muH = dot(rh, sh2) / max(length(rh) * length(sh2), 1e-4);
  // Wave 4: the lift fades out close up (< ~1 km): a front-lit wall that fills the view reads as sunlit cumulus with
  // blue-grey folds, not as the lower half of one giant painted puff (the "blue gel wall" of the approach).
  float farK = smoothstep(150.0, 1600.0, B.x);
  float kUp = (uPaint.x + uPaint.y * sat(-muH * 1.3 + 0.1) * (1.0 - rd.y * rd.y)) * mix(0.2, 1.0, farK);
  float ndlP = (ndl + kUp * ny) / length(uSunDir + vec3(0.0, kUp, 0.0));
  float lobe = smoothstep(-0.15, 0.78, ndlP);
  float crease = mix(smoothstep(0.3, 0.95, ao), 1.0, sat(uLook.w * 2.0 - 0.4));   // inside: A.z is the wisp light
  // Light amount: volumetric sun visibility x big-lobe terminator x crease occlusion x height.
  float s = sunVis * mix(1.0, lobe, uBands.w);
  s *= mix(1.0, 0.25 + 0.75 * crease, uLook.x);
  s *= mix(mix(0.92, 0.74, farK), 1.0, smoothstep(800.0, 2600.0, P.y));   // bright tops, cooler lower bodies (painted cumulus)
  // Painted ramp deep -> shadow -> mid -> lit (soft, log-space blends below; crisp silhouettes come from the alpha).
  gDbg = vec3(lobe, crease, s);
  // Storm: heavier bodies — the bands move up so only the sun-facing crowns stay lit.
  float bk1 = uBands.x + 0.3 * uLook.z, bk2 = uBands.y + 0.4 * uLook.z;
  // Wave 4: a soft gradient map rather than hard cel steps (the key art's cumulus are painted with soft value
  // changes): shadow -> mid over ±soft, mid -> lit over ±1.6 soft, on a light amount that is smooth by construction.
  float b1 = smoothstep(bk1 - uBands.z, bk1 + uBands.z, s);
  float b2 = smoothstep(bk2 - uBands.z * 1.6, bk2 + uBands.z * 1.6, s);
  float up = sat(ny * 0.5 + 0.5);
  // Shadow band keeps the forms (shadow sides, clouds in another cloud's shadow): a painted sky fill light from
  // above the camera (N.F from N.y and |N.V|, both stored) gives every bulge a lighter crown and a deeper underside,
  // creases go deep, thin silhouette edges catch sky light.
  float fill = sat((ny + 0.6 * (1.0 - fres)) / 1.17 * 0.5 + 0.5);
  // Wave 4: stronger form in the shadow band (a tower in its own shadow, e.g. backlit on the title, read as one flat
  // pale-blue "gel" column): sky-lit puff tops lighter, undersides and creases deeper, blended in log space.
  float form = sat(0.72 * fill + 0.2 * lobe + 0.45 * (crease - 0.6) + s / max(bk1, 1e-3) * 0.25 - 0.04);
  vec3 shadow = lmix(uDeep, uShadow, smoothstep(0.08, 0.62, form));
  shadow = lmix(shadow, uMid * 0.95, smoothstep(0.6, 1.0, form) * uPaint.w * 1.7);
  shadow = mix(shadow, uBounce, sat(-ny) * 0.3);
  shadow = mix(shadow, uMid * 0.88, pow(fres, 3.0) * 0.25 * (1.0 - uLook.w));
  vec3 mid = uMid * mix(0.9, 1.04, sat((s - bk1) / max(bk2 - bk1, 1e-3)));
  mid = mix(mid, uShadow, (1.0 - crease) * 0.3);
  vec3 lit = mix(uLit, uWarm, pow(sat(mu * 0.5 + 0.5), 4.0) * 0.8);
  lit *= mix(0.8, 1.08, sat((s - bk2) / max(1.0 - bk2, 1e-3)));   // visible through the tone-map shoulder
  lit = mix(lit, uMid * 1.12, (1.0 - crease) * 0.32);            // soft grey-blue crease lines inside the lit side
  // Wave 4: front light flattens every puff (all of it faces the sun); painters grey the edge of each puff instead,
  // so the cauliflower reads. Rim = 1 - |N.V| of the shading normal (puff scale), strongest in front light.
  float frontL = sat(-mu * 1.4 + 0.25);
  float puffEdge = smoothstep(0.35, 0.95, fres) * frontL * uPaint.w * 2.2;
  lit = lmix(lit, uMid * 1.15, sat(puffEdge * 0.6));
  mid = lmix(mid, uShadow, sat(puffEdge * 0.35));
  // Storm: tops lose most of their light, shadow sides only a little (keeps the anime read of the forms).
  lit *= mix(1.0, 0.5, uLook.z); mid *= mix(1.0, 0.62, uLook.z); shadow *= mix(1.0, 0.82, uLook.z);
  // Wave 4: blend the bands in log space. Linear HDR mixing of the lit band (HDR ~4) with the mid band (~1) put the
  // whole visible gradient into the lowest 20 % of the blend (the tone map's log-like shoulder), so every soft
  // transition still read as a hard cel edge ("cow print" in front light, flat blobs close up).
  vec3 col = lmix(shadow, mid, b1);
  col = lmix(col, lit, b2);
  // Backlit: bodies turn cooler, silhouettes and thin fringes glow (silver lining), forward scatter near the sun.
  float back = pow(sat(mu), 4.0);
  // Wave 4: backlit and side-backlit towers: puff rims facing away from the camera catch a warm silver lining over a
  // wider cone than the forward-scatter glow (the title tower is ~50 deg off the sun).
  float backW = smoothstep(0.05, 0.8, mu) * (1.0 - uLook.w);
  col += uRim * backW * pow(fres, 2.2) * 0.32 * (0.35 + 0.65 * (1.0 - b2)) * uLook.y;
  float edge = pow(fres, 2.5) * (1.0 - uLook.w);
  col = mix(col, col * vec3(0.86, 0.9, 1.0), back * 0.5 * (1.0 - edge));
  col += uRim * back * (edge * (0.55 + 0.45 * sunVis) + (1.0 - alpha) * 0.9) * uLook.y;
  col += uWarm * pow(sat(mu), 24.0) * (0.25 + edge) * 0.6 * uLook.y;
  // Storm: slightly cooler overall.
  col = mix(col, col * vec3(0.86, 0.88, 0.98), uLook.z * 0.6);
  // Close cloud surfaces mist over a little outside a cloud (wave 4: 45 % over the last ~90 m, so near puffs keep
  // their shading); inside a cloud (uLook.w) the fog takes over near the camera.
  float fog = mix(0.45, 1.0, uLook.w) * (1.0 - smoothstep(mix(12.0, 25.0, uLook.w), mix(90.0, 450.0, uLook.w), B.x));
  float nearW = B.z;             // inside: opacity of the first 90 m
  // Fog light (wave 4; wave 3 was one flat colour, "uniform grey inside"): A.x of rays that start inside a cloud is the
  // volumetric in-scatter (brighter toward the sun and near the cloud's edges, blue-grey in the cores), A.z the
  // near-wisp light (lit / shaded sides of the wisps rushing past), B.z their opacity; sky light from above, forward
  // scatter toward the sun.
  float li = smoothstep(0.1, 0.75, sunVis);
  float wl = mix(0.5, ao, sat(uLook.w * 2.0 - 0.4));
  vec3 fogLit = lmix(uFog, uLit, 0.3) * 1.05;
  vec3 fogDark = mix(uShadow, uFog, 0.5) * 0.8;
  vec3 fogC = lmix(fogDark, fogLit, sat(li * 0.72 + 0.28 * (0.5 + 0.6 * rd.y)));
  fogC *= 1.0 + (wl - 0.5) * 1.5 * sat(nearW * 1.5);
  fogC += uWarm * pow(sat(mu), 5.0) * 0.2 * (0.3 + 0.7 * li);
  fogC *= mix(0.96, 1.1, nearW) * mix(1.04, 0.9, smoothstep(40.0, 300.0, B.x));
  col = mix(col, fogC * mix(1.0, 0.5, uLook.z), fog);
  // Aerial perspective at the front distance (same haze as the rest of the world, a bit weaker: clouds pop).
  col = atmoApplyK(col, P, mix(uPaint.z, 1.0, smoothstep(6000.0, 22000.0, B.x)));   // horizon deck melts into haze
  // Alpha sharpening: crisp painted silhouettes; softer only when flying through. With uSoftAlpha the amount is
  // handed to the pipeline (depthTexture.a) and applied after the full-resolution upsample instead.
  float sharp = mix(uSharp.x, uSharp.y, smoothstep(300.0, 4000.0, B.x)) * (1.0 - fog);
  sharpAmt = sharp;
  if (uSoftAlpha == 1) return vec4(col * alpha, alpha);
  float a2 = mix(alpha, smoothstep(uSharpLoHi.x, uSharpLoHi.y, alpha), sharp);
  return vec4(col * a2, a2);
}

void main() {
  ivec2 ip = ivec2(gl_FragCoord.xy);
  int up = int(uUp + 0.5);
  ivec2 lmx = ivec2(uLowRes) - 1;
  ivec2 lp = min(ip / up, lmx);
  bool fresh = up == 1 || (ip - (ip / up) * up) == ivec2(uOffset + 0.5);
  // Current estimate: this frame's sample if this pixel was marched, else the upsampled neighbourhood.
  vec4 a, b;
  if (fresh) { a = texelFetch(uCurA, lp, 0); b = texelFetch(uCurB, lp, 0); }
  else {
    vec2 luv = ((vec2(ip) - uOffset) / uUp + 0.5) / uLowRes;
    a = texture(uCurA, luv); b = texture(uCurB, luv);
  }
  vec4 mnA = vec4(1e9), mxA = vec4(-1e9);
  vec3 mnB = vec3(1e9), mxB = vec3(-1e9);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    ivec2 q = clamp(lp + ivec2(x, y), ivec2(0), lmx);
    vec4 na = texelFetch(uCurA, q, 0), nb = texelFetch(uCurB, q, 0);
    mnA = min(mnA, na); mxA = max(mxA, na);
    mnB = min(mnB, nb.xyz); mxB = max(mxB, nb.xyz);
  }
  vec2 uv = (gl_FragCoord.xy) / uRes;
  vec3 rd = rayDir(uv);
  vec4 pc = uPrevViewProj * vec4(uCloudCamPos + rd * b.x, 1.0);
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  bool valid = uReset == 0 && pc.w > 0.0 && all(greaterThanEqual(puv, vec2(0.0))) && all(lessThanEqual(puv, vec2(1.0)));
  vec4 A = a, B = b;
  // March limit of this texel (scene distance): nearest marched sample, not the bilinear blend across a silhouette.
  float bw = fresh ? b.w : texelFetch(uCurB, lp, 0).w;
  B.w = bw;
  if (valid) {
    vec4 ha = texture(uHistA, puv), hb = texture(uHistB, puv);
    ha = clamp(ha, mnA - vec4(0.03), mxA + vec4(0.03));
    hb.xyz = clamp(hb.xyz, mnB * 0.97, mxB * 1.03);
    float moved = length((puv - uv) * uRes);
    float w = fresh ? clamp(uBlend * float(up * up) * 0.6 + 0.05 * moved, uBlend, 0.8)
                    : clamp(0.03 + 0.04 * moved, 0.03, 0.5);
    // Wave 4: the history was marched to another scene distance (a dragon moved across this texel): drop it,
    // otherwise its cut-off cloud trails behind the silhouette as combs / ladders (2x2 TAAU pattern).
    float occl = abs(hb.w - bw) / (0.1 * min(hb.w, bw) + 4.0);
    w = max(w, 0.9 * smoothstep(1.0, 2.5, occl));
    A = mix(ha, a, w);
    B = vec4(mix(hb.xyz, b.xyz, w), bw);
  }
  o0 = A; o1 = B;
  float sharpAmt;
  o2 = shade(A, B, rd, sharpAmt);
  // Wave 5: a nearby dragon keeps its silhouette: when this texel's march limit (the scene hit it was marched to, the
  // distance the pipeline's depth-aware upsample matches against, o3.g) lies on a dragon, cap the output alpha at
  // 1 - floor (also after the temporal blend and on 2x2 TAAU texels not marched this frame) and hand the pipeline no
  // alpha sharpening there (its curve would push a 0.35 veil up to ~0.6). Texels marched past the dragon (edges) keep
  // their cloud, so the sky / tower behind a silhouette gets no halo.
  if (uSilN > 0 && bw < 59000.0) {
    float fl = silFloor(uCloudCamPos + rd * bw);
    if (fl > 0.0) {
      float cap = 1.0 - fl;
      if (o2.a > cap) o2 *= cap / o2.a;
      sharpAmt *= 1.0 - sat(fl * 10.0);
    }
  }
  if (uDebug > 0) {
    float dv = uDebug == 1 ? A.x : uDebug == 2 ? A.y : uDebug == 3 ? A.z : uDebug == 4 ? A.w : uDebug == 5 ? B.x / 20000.0
             : uDebug == 6 ? B.z : uDebug == 7 ? gDbg.x : uDebug == 8 ? gDbg.y : gDbg.z;
    o2 = vec4(vec3(dv) * (uDebug >= 4 && uDebug <= 6 ? 2.0 : 0.75), 1.0) * step(0.003, A.w);   // 1-3, 7-9: raw (0.75 ≈ white)
  }
  // depth: r = front distance (m, 0 = no cloud), g = march limit (m), b = alpha as output, a = sharpen amount still
  // to apply at full resolution (0 when the alpha in o2 is already sharpened).
  o3 = vec4(A.w > 0.02 ? B.x : 0.0, B.w, o2.a, uSoftAlpha == 1 ? sharpAmt : 0.0);
}
`;

// ---------------------------------------------------------------------------------------------------------------
// Top-down cloud shadow: for each point of the y = 0 plane, the sun transmittance through the cloud layer.
//   r = transmittance through all clouds, g = through clouds above 1250 m only (for peaks above the deck),
//   b = max density on the sun ray (coverage), a = 1
export const SHADOW_FS = /* glsl */`
in vec2 vUv;
uniform vec4 uRect;            // centre x, centre z, size, extinction
uniform vec3 uSunDir;
void main() {
  vec2 xz = uRect.xy + (vUv - 0.5) * uRect.z;
  vec3 L = uSunDir;
  float ly = max(L.y, 0.08);
  float y0 = uDeck.x - uDeckBaseVar * 0.5 - 40.0, y1 = uFieldMap.w;
  const int N = 16;
  float dy = (y1 - y0) / float(N);
  float seg = dy / ly;
  float od = 0.0, odHi = 0.0, mx = 0.0;
  for (int i = 0; i < N; i++) {
    float y = y0 + (float(i) + 0.5) * dy;
    vec3 p = vec3(xz.x, 0.0, xz.y) + L * (y / ly);
    p.y = y;
    float d = sat(cheapInside(p) / (uNoise.z * 2.0));
    od += d * seg;
    if (y > 1250.0) odHi += d * seg;
    mx = max(mx, d);
  }
  gl_FragColor = vec4(exp(-od * uRect.w), exp(-odHi * uRect.w), mx, 1.0);
}
`;

// Debug / test probe: evaluates the shader's own density functions at points from a data texture.
//   out = (towerSdf, deck inside, cheap inside (envelope + shape erosion), density with detail)
export const PROBE_FS = /* glsl */`
in vec2 vUv;
uniform sampler2D uPoints;
uniform float uCount;
void main() {
  int i = int(gl_FragCoord.x);
  vec3 p = texelFetch(uPoints, ivec2(i, 0), 0).xyz;
  float gap;
  float e = envelope(p, gap);
  float ins = displace(p, erode(p, e, 0.0, true, 1.0));
  gl_FragColor = vec4(towerSdf(p), deckInside(p), cheapInside(p), sat(ins / uNoise.z));
}
`;
