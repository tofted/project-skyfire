// Shared anime shading for world props (trees, houses, landmarks). Same light model as the terrain so everything in
// the valley sits in one painted light: soft two-tone band from a sphere-transferred / form normal, blue-violet
// shade, warm terminator, Fresnel rim (strong when backlit), cloud shadows, then game.atmo aerial perspective.
// Geometry attributes: position, normal, color (albedo, sRGB-authored -> linear), aCenter (form centre, local),
//   aSway (0 at the ground -> 1 at the tips; wind weight). Instanced variants add iPos (x, y, z, scale) and
//   iRot (yaw, tint index / variation, height scale, phase).
import * as THREE from 'three';

export const lin = (hex) => new THREE.Color(hex);           // sRGB hex -> linear (three colour management)

export function propVS({ instanced, wind }) {
  return /* glsl */`
attribute vec3 color;
attribute vec3 aCenter;
attribute float aSway;
${instanced ? 'attribute vec4 iPos; attribute vec4 iRot;' : ''}
uniform float uTime;
uniform vec2 uWind;
uniform float uNormalBlend;
uniform vec3 uTint[4];
uniform vec2 uFade;          // x = start, y = end distance of the far fade (shrink); 0,0 = off
uniform vec3 uXfade;         // LOD crossfade: x = switch distance, y = half width, z = role (0 off, 1 near, 2 far)
uniform vec4 uThin;          // far thinning: x = start, y = end distance, z = kept fraction at the end, w = on
varying vec3 vW;
varying vec3 vN;
varying vec3 vCol;
varying float vAO;
varying float vCover;        // 0..1 coverage of this instance (dithered in the fragment shader)
void main() {
  vec3 p = position;
  vCover = 1.0;
  vec3 n = normalize(mix(normal, normalize(position - aCenter + vec3(0.0, 0.001, 0.0)), uNormalBlend));
  vec3 col = color;
  float scale = 1.0;
  vec3 base = vec3(0.0);
  float yaw = 0.0;
  ${instanced ? `
  base = iPos.xyz; scale = iPos.w; yaw = iRot.x;
  p.y *= iRot.z;
  float dI = distance(cameraPosition, base);
  // near <-> far crossfade: both LODs are drawn inside the band and share one dither pattern (complementary)
  if (uXfade.z > 0.5) {
    float t = smoothstep(uXfade.x - uXfade.y, uXfade.x + uXfade.y, dI);
    vCover = uXfade.z < 1.5 ? 1.0 - t : t;
  }
  // thinning with distance: instances are ranked by importance (iRot.w = importance · 2π, also the wind phase); the
  // least important dissolve first and the survivors grow to keep the canopy — continuous, no 1/8 steps
  if (uThin.w > 0.5) {
    float keep = clamp(1.0 - (1.0 - uThin.z) * smoothstep(uThin.x, uThin.y, dI), uThin.z, 1.0);
    float imp = iRot.w / 6.2831853 * 0.95;                     // x0.95: at keep = 1 every instance is fully in
    vCover *= clamp((keep - imp) / 0.05 + 0.5, 0.0, 1.0);
    scale *= inversesqrt(keep);
  }
  int ti = int(iRot.y);
  float tv = fract(iRot.y) * 2.0 - 1.0;
  col = mix(col, uTint[ti] * (1.0 + 0.18 * tv) * col, step(0.9, min(col.r, min(col.g, col.b))));   // white parts take the tint
  ` : ''}
  float c = cos(yaw), s = sin(yaw);
  p = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z) * scale;
  n = vec3(c * n.x + s * n.z, n.y, -s * n.x + c * n.z);
  vec4 wp = modelMatrix * vec4(p + base, 1.0);
  ${wind ? `
  // wind: whole-crown bend (gust front travelling downwind) + a little flutter
  float gust = 0.5 + 0.5 * sin(dot(wp.xz, normalize(uWind + 1e-4)) * 0.018 - uTime * 1.7 ${instanced ? '+ iRot.w' : ''});
  float bend = aSway * aSway * (0.25 + 0.75 * gust) * length(uWind) * 0.07 * scale;
  wp.xz += normalize(uWind + 1e-4) * bend;
  wp.xyz += n * sin(uTime * 2.3 + dot(wp.xz, vec2(0.37, 0.21))) * 0.06 * aSway * scale;
  ` : ''}
  ${instanced ? `
  float k = 1.0;
  if (uFade.y > 0.0) k *= 1.0 - smoothstep(uFade.x, uFade.y, dI);
  if (vCover < 0.004) k = 0.0;                                  // fully faded: collapse (no fragments at all)
  wp.xyz = mix(base, wp.xyz, k);
  ` : ''}
  vW = wp.xyz;
  vN = normalize((modelMatrix * vec4(n, 0.0)).xyz);
  vCol = col;
  vAO = clamp(0.55 + 0.45 * smoothstep(0.0, 1.0, aSway + 0.25), 0.0, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
}

export function propFS({ atmoChunk, shadowChunk }) {
  return /* glsl */`
uniform vec3 uShade;
uniform vec3 uSkyFill;
uniform float uRim;
uniform float uBackGlow;
uniform float uLight;
uniform vec3 uEmissive;
uniform float uLeaf;
varying vec3 vW;
varying vec3 vN;
varying vec3 vCol;
varying float vAO;
varying float vCover;
${atmoChunk}
${shadowChunk}
float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
void main() {
  #ifdef DITHER
  // screen-space dither (interleaved gradient noise); the far LOD uses the complementary half of the pattern
  float dz = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  if (DITHER > 1) dz = 1.0 - dz;
  if (dz >= vCover) discard;
  #endif
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(cameraPosition - vW);
  vec3 L = atmoSunDir;
  float ndl = dot(N, L);
  // painted leaf clusters: break the terminator with a little 3D value noise (foliage only)
  if (uLeaf > 0.0) {
    vec3 q = vW * 0.55;
    vec3 i = floor(q), f = fract(q); f = f * f * (3.0 - 2.0 * f);
    float n000 = hash13(i), n100 = hash13(i + vec3(1, 0, 0)), n010 = hash13(i + vec3(0, 1, 0)), n110 = hash13(i + vec3(1, 1, 0));
    float n001 = hash13(i + vec3(0, 0, 1)), n101 = hash13(i + vec3(1, 0, 1)), n011 = hash13(i + vec3(0, 1, 1)), n111 = hash13(i + vec3(1, 1, 1));
    float nz = mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y), mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
    ndl += (nz - 0.5) * uLeaf * (1.0 - smoothstep(300.0, 900.0, distance(cameraPosition, vW)));
  }
  float cs = cloudShadow(vW);
  float band = smoothstep(-0.05, 0.12, ndl);
  float lit = band * mix(0.2, 1.0, cs);
  vec3 sun = atmoSunColor * uLight;
  vec3 alb = vCol;
  float lumA = dot(alb, vec3(0.299, 0.587, 0.114));
  vec3 shadeC = alb * uShade * (0.86 + 0.14 * N.y) + uSkyFill * (0.3 + lumA);
  vec3 col = shadeC * vAO + alb * sun * lit * (0.62 + 0.38 * clamp(ndl, 0.0, 1.0)) * 0.30 * mix(1.0, vAO, 0.5);
  col += alb * sun * 0.03 * (smoothstep(-0.05, 0.05, ndl) - smoothstep(0.05, 0.2, ndl)) * cs;
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
  float back = clamp(dot(-V, L) + 0.2, 0.0, 1.0);
  col += sun * alb * fres * (0.05 + 0.25 * back) * uRim;
  col += sun * alb * uBackGlow * pow(clamp(dot(-V, L), 0.0, 1.0), 3.0) * (1.0 - lit) * 0.12;   // leaves glow when backlit
  col += uEmissive;
  col = atmoApply(col * atmoSurface, vW);      // (levels update: moonlit at night)
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
}

/** ShaderMaterial for props. opts: instanced, wind, normalBlend, tints[4], rim, backGlow, fade [start,end],
 *  xfade [switch distance, half width, role 1 near | 2 far], thin [start, end, kept fraction, 1] */
export function propMaterial(game, opts = {}) {
  const shadow = game.clouds?.shadow;
  const tints = (opts.tints || [0xffffff, 0xffffff, 0xffffff, 0xffffff]).map((h) => (h?.isColor ? h : lin(h)));
  while (tints.length < 4) tints.push(lin(0xffffff));
  const tu = game.terrain?.uniforms || { uTime: { value: 0 }, uWind: { value: new THREE.Vector2(3, 1) } };
  const m = new THREE.ShaderMaterial({
    name: opts.name || 'prop',
    uniforms: {
      ...(game.atmo?.uniforms || {}), ...(shadow?.uniforms || {}),
      uTime: tu.uTime, uWind: tu.uWind,
      uNormalBlend: { value: opts.normalBlend ?? 0 },
      uTint: { value: tints },
      uFade: { value: new THREE.Vector2(...(opts.fade || [0, 0])) },
      uXfade: { value: new THREE.Vector3(...(opts.xfade || [0, 0, 0])) },
      uThin: { value: new THREE.Vector4(...(opts.thin || [0, 0, 0, 0])) },
      uShade: { value: new THREE.Vector3(...(opts.shade || [0.40, 0.43, 0.62])) },
      uSkyFill: { value: new THREE.Vector3(...(opts.skyFill || [0.008, 0.011, 0.032])) },
      uRim: { value: opts.rim ?? 1 },
      uBackGlow: { value: opts.backGlow ?? 0 },
      uLight: { value: 1 },
      uEmissive: { value: new THREE.Color(0, 0, 0) },
      uLeaf: { value: opts.leaf ?? 0 },
    },
    vertexShader: propVS({ instanced: !!opts.instanced, wind: !!opts.wind }),
    fragmentShader: propFS({ atmoChunk: game.atmo.chunk, shadowChunk: shadow?.chunk || 'float cloudShadow(vec3 p) { return 1.0; }' }),
    side: opts.side ?? THREE.FrontSide,
    // dithered LOD crossfade / thinning only where it is used: discard costs early-z / hidden-surface removal
    defines: opts.xfade || opts.thin ? { DITHER: opts.xfade?.[2] === 2 ? 2 : 1 } : {},
  });
  return m;
}

// ---- geometry helpers -------------------------------------------------------------------------------------------
/** Normalise a geometry to non-indexed with attributes position, normal, color, aCenter, aSway. */
export function part(geo, { color = 0xffffff, center = null, sway = null, flat = false } = {}) {
  let g = geo.index ? geo.toNonIndexed() : geo;
  if (flat || !g.getAttribute('normal')) g.computeVertexNormals();
  const n = g.getAttribute('position').count;
  const c = lin(color);
  const col = new Float32Array(n * 3), cen = new Float32Array(n * 3), sw = new Float32Array(n);
  const pos = g.getAttribute('position');
  g.computeBoundingBox();
  const bb = g.boundingBox, mid = new THREE.Vector3(); bb.getCenter(mid);
  const ctr = center || mid;
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    cen[i * 3] = ctr.x; cen[i * 3 + 1] = ctr.y; cen[i * 3 + 2] = ctr.z;
    sw[i] = typeof sway === 'function' ? sway(pos.getX(i), pos.getY(i), pos.getZ(i)) : (sway ?? 0);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aCenter', new THREE.BufferAttribute(cen, 3));
  g.setAttribute('aSway', new THREE.BufferAttribute(sw, 1));
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color', 'aCenter', 'aSway'].includes(k)) g.deleteAttribute(k);
  return g;
}

/** Merge parts (all non-indexed with the same attributes). */
export function merge(parts) {
  const keys = ['position', 'normal', 'color', 'aCenter', 'aSway'];
  let total = 0;
  for (const p of parts) total += p.getAttribute('position').count;
  const out = new THREE.BufferGeometry();
  for (const k of keys) {
    const size = parts[0].getAttribute(k).itemSize;
    const arr = new Float32Array(total * size);
    let o = 0;
    for (const p of parts) { const a = p.getAttribute(k).array; arr.set(a, o); o += a.length; }
    out.setAttribute(k, new THREE.BufferAttribute(arr, size));
  }
  out.computeBoundingSphere();
  return out;
}

/** Displace vertices of a (non-indexed) geometry with a smooth pseudo-noise so shapes look hand-made. */
export function lumpy(geo, amp, freq, seed = 0) {
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const n = Math.sin(x * freq + seed) * Math.sin(y * freq * 1.3 + seed * 2.1) * Math.sin(z * freq * 0.9 + seed * 0.7);
    const k = 1 + n * amp;
    pos.setXYZ(i, x * k, y * k, z * k);
  }
  pos.needsUpdate = true;
  return geo;
}
