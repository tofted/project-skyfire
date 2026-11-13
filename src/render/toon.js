// game.toon — anime materials and outlines.
//   game.toon.material(opts) -> Material
//     opts: { map, color, shade, rim, rimPower, steps (2|3|4), emissive, emissiveMap, emissiveIntensity,
//             transparent, opacity, side, alphaTest, normalMap, normalScale, normalStrength (0..1, default 0.35),
//             aoMap, mid (terminator offset), soft (band softness), band (width of the soft mid band),
//             spec (strength), specSize, rimWidth, rimStrength, shadeSat, trans (membrane back-light 0..1),
//             transColor, vertexData (COLOR_0 = R outline width, G shadow bias, B rim mask), atmo (haze 0..1, default 0.75),
//             keyLight (0..1, default 1: characters keep a lit side when the camera looks into the sun; 0 for props),
//             rimAlbedo (0..1, default 0.8: rim takes the albedo's hue), rimPx (max rim band width, CSS px, default 7:
//             flat/thin surfaces at grazing angles do not flood), toonData (read the asset's '_toon_data' attribute:
//             y shadow bias, z rim mask; outline() enables it automatically when the mesh's geometry has it),
//             receiveShadow default true on the mesh,
//             wave 4 "form" shading (characters: keyLight > 0; shared switch toon.shared.toonLook, ?toonlook=0):
//             formAngle (deg, default 58: min angle between key light and view axis), formMid (0.15: terminator
//             bias — about a third of the visible body in shade), highlight (0.7) / highlightEdge (0.6): painted
//             hot tone on surfaces facing the key light, specAuto (0.7: stepped specular on horn-like albedo),
//             aoBias (0.45, baked '_toon_ao'), rimShade (0.6: cool sky rim on the shade side), shadeDeep (0.82) }
//     material.userData.toon holds per-material uniforms ({ hitFlash, hitColor, spec, formMid, … }.value) — mutate freely.
//   game.toon.useAO(mesh) / bakeToonAO(geometry, occluders)   per-vertex AO for characters without '_toon_data'
//     (outline() calls useAO for SkinnedMeshes: the dragons); baked once per geometry (clones share it).
//   game.toon.outline(mesh, opts) -> Mesh
//     Inverted hull added as a child (SkinnedMesh / InstancedMesh safe). Extruded along '_OUTLINE_N' when the asset
//     has it, else along position-welded smoothed normals computed once per geometry (no cracks at seams).
//     Width is roughly constant on screen: px = clamp(width_m × pixels-per-metre, minPx, maxPx) (CSS px × DPR),
//     so far dragons keep a thin line and close-ups are not fat.
//     opts: { width (m, default 0.035), minPx (1), maxPx (2.6), color (flat colour; default: darkened albedo),
//             tint (multiplier on the darkened albedo), zPush, vertexData, toonData (default: on when the geometry
//             has '_toon_data'; x = width multiplier) }
//     BackSide negates transformedNormal (FLIP_SIDED); the hull un-flips it (marker SKYFIRE_OUTLINE_FLIP), so
//     patches that add their own flip must check for 'FLIP_SIDED' / that marker first (titan's fixOutlineFlip does).
//     outlineMesh.material.userData.outline.override.value = Vector4(r,g,b,mix) recolours it (lock-on).
//   game.toon.convert(root, opts)   every mesh under root gets a toon material built from its old map/colour;
//                                   opts.overrides = { [meshOrMaterialName]: opts } for per-part tweaks.
//   game.toon.setFireLight(i, pos|null, color, radius)   up to 4 flat fire lights (breath, fireballs) for toon.
// Lighting comes from the shared palette in game.atmo (sun, shade tint, rim, sky/bounce ambient) and the sun
// shadow cascades of game.sky (directional shadow 0 = near/player, 1 = far/titan). Output is linear HDR.
import * as THREE from 'three';

const TOON_PARS = /* glsl */`
uniform vec3 toonSunLight;   // sun colour × intensity (π = white shows as 1.0)
uniform vec3 toonSunDirW;    // world, toward the sun
uniform vec3 toonShadeTint, toonSkyUp, toonBounce, toonRimColor, toonTransColor, toonHitColor;
uniform float toonMid, toonSoft, toonBand, toonSpec, toonSpecSize, toonRimWidth, toonRimStrength;
uniform float toonShadeSat, toonTrans, toonNormalMix, toonHitFlash, toonShadowSoft, toonKeyBias;
uniform float toonRimAlbedo, toonRimPx, toonPxScale;
// Wave 4 "form" shading (characters, keyLight > 0): toonLook 1 = on (shared; ?toonlook=0 or the debug key Digit8 = off)
uniform float toonLook, toonFormCos, toonFormMid, toonHiK, toonHiEdge, toonSpecAuto, toonAOBias, toonRimShade, toonShadeDeep;
#ifdef TOON_DATA_ATTR
varying vec3 vToonData;        // _toon_data: x outline width, y shadow bias (0.5 neutral), z rim mask
#endif
#ifdef TOON_AO_ATTR
varying float vToonAO;         // _toon_ao: ambient occlusion baked once per geometry by toon.bakeAO (1 = open)
#endif
uniform vec4 toonFire[4];    // xyz world position, w radius (0 = off)
uniform vec3 toonFireColor[4];

float toonAA(float e, float w, float x) { float f = fwidth(x) * 0.75 + w; return smoothstep(e - f, e + f, x); }

// Sun shadow from the cascades: 0 = near (player dragon, crisp), 1 = far (titan / surroundings, coarse).
// Coordinates are rebuilt per fragment from the world position and the face-corrected normal, so thin
// double-sided surfaces (wing membranes) get their normal bias on the correct side and do not self-shadow.
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
uniform mat4 directionalShadowMatrix[ NUM_DIR_LIGHT_SHADOWS ];
#endif
float toonShadow(vec3 wp, vec3 nWf) {
  float s = 1.0;
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
  if (receiveShadow) {
    vec4 c0 = directionalShadowMatrix[ 0 ] * vec4(wp + nWf * directionalLightShadows[ 0 ].shadowNormalBias, 1.0);
    vec3 p0 = c0.xyz / c0.w;
    bool in0 = p0.x > 0.01 && p0.x < 0.99 && p0.y > 0.01 && p0.y < 0.99 && p0.z < 1.0;
    if (in0) {
      s = getShadow(directionalShadowMap[ 0 ], directionalLightShadows[ 0 ].shadowMapSize, 1.0,
                    directionalLightShadows[ 0 ].shadowBias, directionalLightShadows[ 0 ].shadowRadius, c0);
    }
    #if NUM_DIR_LIGHT_SHADOWS > 1
    else {
      vec4 c1 = directionalShadowMatrix[ 1 ] * vec4(wp + nWf * directionalLightShadows[ 1 ].shadowNormalBias, 1.0);
      s = getShadow(directionalShadowMap[ 1 ], directionalLightShadows[ 1 ].shadowMapSize, 1.0,
                    directionalLightShadows[ 1 ].shadowBias, directionalLightShadows[ 1 ].shadowRadius, c1);
    }
    #endif
  }
  #endif
  return s;
}
`;

const TOON_MAIN = /* glsl */`
  vec3 A = diffuseColor.rgb;
  vec3 N = normalize(mix(nonPerturbedNormal, normal, toonNormalMix));
  vec3 V = normalize(vViewPosition);
  vec3 Ls = normalize((viewMatrix * vec4(toonSunDirW, 0.0)).xyz);
  // Anime key-light cheat: when the camera looks into the sun, bend the key light toward "above and behind the
  // camera" so characters keep a lit side instead of reading as flat silhouettes (the sun still casts the shadows).
  float tInto = clamp(-Ls.z, 0.0, 1.0);
  vec3 L = normalize(mix(Ls, vec3(0.0, 0.62, 0.78), mix(0.12, 0.62, tInto * tInto) * toonKeyBias));
  // Wave 4 form light (characters only): a key light on the view axis paints no terminator, so a dragon seen from
  // behind / above with the sun at the camera's back read as one flat red. The key light is kept at least
  // acos(toonFormCos) away from the view axis, leaning up in view space so the shade falls under forms.
  float tLook = toonLook * step(0.001, toonKeyBias);
  if (tLook > 0.0) {
    vec2 tSv = L.xy + vec2(0.0, 0.6);
    vec2 tSd = dot(tSv, tSv) > 1e-6 ? normalize(tSv) : vec2(1.0, 0.0);   // never normalize(0) (NaN = black)
    vec3 tL2 = vec3(tSd * sqrt(max(1.0 - toonFormCos * toonFormCos, 0.0)), toonFormCos);
    L = normalize(mix(L, tL2, tLook * min(toonKeyBias, 1.0) * smoothstep(toonFormCos - 0.18, toonFormCos + 0.06, L.z)));
  }
  vec3 Lc = toonSunLight * RECIPROCAL_PI;
  float tBias = 0.0, tRimMask = 1.0;
  #if defined( TOON_DATA_ATTR )
    tBias = (vToonData.y - 0.5) * 1.2; tRimMask = vToonData.z;
  #elif defined( TOON_VERTEX_DATA ) && ( defined( USE_COLOR ) || defined( USE_COLOR_ALPHA ) )
    tBias = (vColor.g - 0.5) * 1.2; tRimMask = vColor.b;
  #endif
  #ifdef USE_AOMAP
    tBias += (ambientOcclusion - 1.0) * 0.6;
  #endif
  float tAO = 1.0;
  #ifdef TOON_AO_ATTR
    tAO = mix(1.0, clamp(vToonAO, 0.0, 1.0), toonLook);
    tBias += (tAO - 1.0) * toonAOBias;               // gentle: creases (leg / wing roots, belly seams) shade first
  #endif
  // Terminator bias: under a top-front sun about a third of the visible body is in shade (key art: 3–4 values).
  float x = dot(N, L) + tBias - toonFormMid * tLook;
  vec3 tWorld = cameraPosition + transformNormalByInverseViewMatrix(-vViewPosition, viewMatrix) * length(vViewPosition);
  float tSh = toonShadow(tWorld, transformNormalByInverseViewMatrix(nonPerturbedNormal, viewMatrix));
  float tShC = smoothstep(0.5 - toonShadowSoft, 0.5 + toonShadowSoft, tSh);
  // Cast shadows count where the real sun reaches the surface; its own back side is decided by the key light.
  tShC = mix(1.0, tShC, smoothstep(-0.05, 0.2, dot(N, Ls)));
  float lit = toonAA(toonMid, toonSoft, x) * tShC;

  vec3 nW = transformNormalByInverseViewMatrix(N, viewMatrix);
  vec3 amb = mix(toonBounce, toonSkyUp, nW.y * 0.5 + 0.5) * mix(1.0, tAO, 0.75);
  // Shadow colour: albedo × blue-violet tint with a chroma boost (never grey).
  vec3 sc = A * toonShadeTint;
  float sl = dot(sc, vec3(0.2126, 0.7152, 0.0722));
  sc = max(mix(vec3(sl), sc, toonShadeSat), 0.0);
  // (wave 4: characters' shade one value deeper — key art scarlet #c8281e over shade #8a1a18, linear ratio ≈ 0.45)
  vec3 shadeCol = (sc * Lc * (0.9 + 0.1 * clamp(x * 0.5 + 0.5, 0.0, 1.0)) + A * amb) * mix(1.0, tAO, 0.3)
    * mix(1.0, toonShadeDeep, tLook);
  // Lit colour keeps a faint N·L gradient so forms read as volumes, not flat cutouts.
  vec3 litCol = A * Lc * (0.86 + 0.14 * smoothstep(0.0, 0.85, x)) + A * amb * 0.35;
  vec3 col = mix(shadeCol, litCol, lit);
  #if TOON_STEPS > 2
    // Narrow painted band just past the terminator.
    float tBand = toonAA(toonMid + toonBand, toonSoft, x) * tShC;
    col = mix(mix(shadeCol, litCol, 0.62), litCol, tBand);
    col = mix(shadeCol, col, lit);
  #endif
  float aMax = max(A.r, max(A.g, A.b));
  // Wave 4: painted highlight tone on the surfaces that face the key light (key art: scarlet -> hot orange-red top
  // of the haunch). Dark / saturated albedos lift most; bright ones (cream belly) barely, so nothing starts to bloom.
  if (tLook > 0.0 && toonHiK > 0.0) {
    float tHi = toonAA(toonMid + toonHiEdge, toonSoft * 1.5, x) * tShC;
    vec3 hiCol = litCol * (1.0 + 0.25 * toonHiK * (1.0 - 0.75 * aMax))
      + Lc * (toonHiK * 0.14 * aMax) * (1.0 - 0.5 * A / max(aMax, 0.04));   // lift the weak channels: red -> hot red
    col = mix(col, hiCol, tHi * tLook);
  }

  // Membrane back-light: thin wings glow with the sun behind them.
  if (toonTrans > 0.0) {
    float back = clamp(-dot(N, Ls), 0.0, 1.0);
    float through = pow(clamp(dot(-V, Ls), 0.0, 1.0), 2.0);
    float glow = toonTrans * (0.3 + 0.7 * through) * (0.4 + 0.6 * back) * (1.0 - lit);
    col = mix(col, A * toonTransColor * Lc * 0.9 + A * amb, clamp(glow, 0.0, 1.0));
  }

  // Stepped specular band (horns, claws, armour). Wave 4: characters also get it automatically on horn-like albedo
  // (warm, half-saturated gold / khaki of mid brightness: Sora's horns and claws — not the cream belly, the ivory
  // titan or skin; measured on every character texture), tinted by the albedo's hue.
  float tSpec = toonSpec;
  if (tLook > 0.0 && toonSpecAuto > 0.0) {
    vec3 sA = pow(max(A, vec3(0.0)), vec3(0.4545));
    float sMx = max(sA.r, max(sA.g, sA.b)), sMn = min(sA.r, min(sA.g, sA.b));
    float sSat = (sMx - sMn) / max(sMx, 1e-3), sGr = sA.g / max(sA.r, 1e-3);
    float sKey = smoothstep(0.38, 0.44, sSat) * (1.0 - smoothstep(0.56, 0.62, sSat))
      * smoothstep(0.5, 0.6, sMx) * (1.0 - smoothstep(0.86, 0.92, sMx))
      * smoothstep(0.7, 0.78, sGr) * (1.0 - smoothstep(0.93, 0.99, sGr)) * step(sA.b, sA.g);
    tSpec = max(tSpec, toonSpecAuto * sKey);
  }
  if (tSpec > 0.0) {
    vec3 H = normalize(L + V);
    vec3 sTint = mix(vec3(1.0), A / max(aMax, 0.04), 0.3 * tLook);
    col += Lc * sTint * tSpec * toonAA(1.0 - toonSpecSize, 0.0, dot(N, H)) * lit;
  }

  // Hard rim on the sun side of the silhouette, a full ring when backlit. Silhouettes only: the band may be at most
  // ~toonRimPx pixels wide on screen (the N.V rate of change sets its width), so big flat or thin surfaces seen at
  // grazing angles (wing membranes, armour plates) no longer flood; curved silhouettes keep the full rimWidth.
  float ndv = dot(normalize(nonPerturbedNormal), V);
  float fr = 1.0 - clamp(dot(N, V), 0.0, 1.0);
  float rimW = min(toonRimWidth, max(fwidth(ndv), 1e-5) * toonRimPx * toonPxScale);
  float rim = toonAA(1.0 - rimW, 0.0, fr) * step(0.002, rimW);
  float rim0 = rim * tRimMask;
  // The lit side of the silhouette follows the key light the body is shaded with (wave 4), else the raw sun.
  vec3 Lr = normalize(mix(Ls, L, tLook));
  float sunSide = smoothstep(-0.25, 0.45, dot(normalize(N.xy + 1e-5), normalize(Lr.xy + 1e-5)));
  float backlit = clamp(-dot(Ls, V), 0.0, 1.0);
  rim *= mix(sunSide * (0.35 + 0.65 * lit), 1.0, backlit * backlit) * tRimMask;
  // Rim colour carries the albedo's hue (scarlet body -> hot red-pink, gold membrane -> bright gold), never cream.
  vec3 rimHue = mix(A / max(aMax, 0.04), vec3(1.0), 0.28);
  vec3 rimCol = toonRimColor * Lc * mix(vec3(0.62 + 0.38 * aMax), rimHue * (0.7 + 0.45 * aMax), toonRimAlbedo);
  col = mix(col, max(col, rimCol), rim * toonRimStrength);
  // Wave 4: cool reflected-sky rim on the SHADE side of the silhouette, so a shadowed flank still separates from the
  // valley / sky behind it (anime "second rim"). Albedo-hued, lifted by the sky ambient, never brighter than lit.
  if (tLook > 0.0 && toonRimShade > 0.0) {
    float rs = rim0 * (1.0 - sunSide) * (1.0 - lit) * (1.0 - backlit * backlit);
    vec3 skyRim = min(shadeCol * 1.45 + toonSkyUp * 0.9 * (0.4 + aMax), litCol);
    col = mix(col, max(col, skyRim), rs * toonRimShade * tLook);
  }

  // Fire lights: flat, banded, no shadows.
  for (int i = 0; i < 4; i++) {
    vec4 fl = toonFire[ i ];
    if (fl.w <= 0.0) continue;
    vec3 toF = fl.xyz - tWorld;
    float d = length(toF);
    float att = clamp(1.0 - d / fl.w, 0.0, 1.0); att *= att;
    float facing = toonAA(0.0, 0.05, dot(nW, toF / max(d, 1e-3)));
    col += A * toonFireColor[ i ] * att * mix(0.35, 1.0, facing);
  }

  col += totalEmissiveRadiance;
  col = mix(col, toonHitColor, toonHitFlash);
  vec3 outgoingLight = col;
`;

const OUTLINE_VERT_PARS = /* glsl */`
attribute vec3 outlineNormal;
uniform float olWidth, olMinPx, olMaxPx, olZPush, olViewH, olPxScale;
#ifdef OUTLINE_TOON_DATA
attribute vec3 _toon_data;     // x = outline width multiplier (asset pipeline)
#endif
`;
const OUTLINE_VERT = /* glsl */`
{
  float olMask = 1.0;
  #if defined( OUTLINE_TOON_DATA )
    olMask = _toon_data.x;
  #elif defined( OUTLINE_VERTEX_DATA ) && defined( USE_COLOR )
    olMask = color.r;
  #endif
  float olDepth = max(-mvPosition.z, 1e-3);
  float olPxPerUnit = projectionMatrix[ 1 ][ 1 ] * 0.5 * olViewH / olDepth;
  float olPx = clamp(olWidth * olPxPerUnit, olMinPx * olPxScale, olMaxPx * olPxScale) * olMask;
  vec3 olN = normalize(transformedNormal);
  #ifdef FLIP_SIDED
    olN = -olN;                    // SKYFIRE_OUTLINE_FLIP: BackSide flips transformedNormal; the hull must grow outward
  #endif
  vec4 olP = mvPosition;
  olP.xy += normalize(olN.xy + 1e-6) * (olPx / olPxPerUnit);
  olP.z -= olZPush * olDepth;
  gl_Position = projectionMatrix * olP;
}
`;

/** Position-welded average of vertex normals -> 'outlineNormal' (cached on the geometry). */
export function bakeOutlineNormals(g) {
  if (g.attributes.outlineNormal) return g.attributes.outlineNormal;
  const src = g.attributes._outline_n || g.attributes._smoothnormal;
  if (src) { g.setAttribute('outlineNormal', src); return src; }
  const p = g.attributes.position;
  if (!g.attributes.normal) g.computeVertexNormals();
  const n = g.attributes.normal;
  if (!g.boundingBox) g.computeBoundingBox();
  const size = g.boundingBox.getSize(new THREE.Vector3()).length() || 1;
  const inv = 1 / (size * 1e-5);
  const acc = new Map();
  const keys = new Array(p.count);
  for (let i = 0; i < p.count; i++) {
    const k = `${Math.round(p.getX(i) * inv)},${Math.round(p.getY(i) * inv)},${Math.round(p.getZ(i) * inv)}`;
    keys[i] = k;
    let a = acc.get(k);
    if (!a) acc.set(k, (a = [0, 0, 0]));
    a[0] += n.getX(i); a[1] += n.getY(i); a[2] += n.getZ(i);
  }
  const out = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const a = acc.get(keys[i]);
    let l = Math.hypot(a[0], a[1], a[2]);
    if (l < 1e-6) { a[0] = n.getX(i); a[1] = n.getY(i); a[2] = n.getZ(i); l = Math.hypot(a[0], a[1], a[2]) || 1; }
    out[i * 3] = a[0] / l; out[i * 3 + 1] = a[1] / l; out[i * 3 + 2] = a[2] / l;
  }
  const attr = new THREE.BufferAttribute(out, 3);
  g.setAttribute('outlineNormal', attr);
  return attr;
}

// 96 Fibonacci-sphere directions for the AO bake (the ~20 inside a 55° cone around each normal are used).
const AO_DIRS = (() => {
  const out = [], n = 96;
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * i + 1) / n, r = Math.sqrt(1 - y * y), phi = i * 2.399963229728653;
    out.push(Math.cos(phi) * r, y, Math.sin(phi) * r);
  }
  return new Float32Array(out);
})();
const AO_STEPS = [3.2, 4.4, 6, 8.2, 11.2, 15.5, 21];     // march distances in grid cells (first > √3 cells: no self-hit)
const flatArray = (a) => {                                // plain xyz Float32Array of a (possibly interleaved) attribute
  if (!a.isInterleavedBufferAttribute && a.itemSize === 3 && a.array instanceof Float32Array && !a.normalized) return a.array;
  const out = new Float32Array(a.count * 3);
  for (let i = 0; i < a.count; i++) { out[i * 3] = a.getX(i); out[i * 3 + 1] = a.getY(i); out[i * 3 + 2] = a.getZ(i); }
  return out;
};
const indexArray = (g) => {
  if (g.index) return g.index.array;
  const n = g.attributes.position.count, out = new Uint32Array(n);
  for (let i = 0; i < n; i++) out[i] = i;
  return out;
};

/** Bake a per-vertex ambient occlusion attribute '_toon_ao' (1 = open, 0 = fully enclosed) for a (skinned) character
 *  geometry in its bind pose. Occluders = the geometries that share its space (e.g. body + membrane primitives of one
 *  GLB mesh). Voxelises the occluders into a ~150-cell grid, marches a cone of directions around each vertex normal,
 *  welds by position and smooths twice along the triangles. Cached on the geometry (clones share it). */
export function bakeToonAO(g, occluders = [g]) {
  if (g.attributes._toon_ao) return g.attributes._toon_ao;
  const t0 = performance.now();
  if (!g.attributes.normal) g.computeVertexNormals();
  const box = new THREE.Box3();
  for (const o of occluders) { if (!o.boundingBox) o.computeBoundingBox(); box.union(o.boundingBox); }
  const size = box.getSize(new THREE.Vector3());
  let cell = Math.max(size.x, size.y, size.z, 1e-3) / 150;
  const dims = () => [Math.ceil(size.x / cell) + 4, Math.ceil(size.y / cell) + 4, Math.ceil(size.z / cell) + 4];
  let [nx, ny, nz] = dims();
  while (nx * ny * nz > 6e6) { cell *= 1.25; [nx, ny, nz] = dims(); }
  const ox = box.min.x - 2 * cell, oy = box.min.y - 2 * cell, oz = box.min.z - 2 * cell, inv = 1 / cell, nxy = nx * ny;
  const grid = new Uint8Array(nx * ny * nz);
  for (const o of occluders) {
    const P = flatArray(o.attributes.position), I = indexArray(o);
    for (let t = 0; t + 2 < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const ax = P[a], ay = P[a + 1], az = P[a + 2];
      const ux = P[b] - ax, uy = P[b + 1] - ay, uz = P[b + 2] - az;
      const vx = P[c] - ax, vy = P[c + 1] - ay, vz = P[c + 2] - az;
      const e = Math.max(Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz), Math.hypot(ux - vx, uy - vy, uz - vz));
      const m = Math.min(48, Math.max(1, Math.ceil(e * inv * 2)));
      for (let s = 0; s <= m; s++) for (let r = 0; r <= m - s; r++) {
        const fs = s / m, fr = r / m;
        const i = ((ax + ux * fs + vx * fr - ox) * inv) | 0, j = ((ay + uy * fs + vy * fr - oy) * inv) | 0, k = ((az + uz * fs + vz * fr - oz) * inv) | 0;
        if (i >= 0 && j >= 0 && k >= 0 && i < nx && j < ny && k < nz) grid[k * nxy + j * nx + i] = 1;
      }
    }
  }
  const P = flatArray(g.attributes.position), Nn = flatArray(g.attributes.normal);
  const n = g.attributes.position.count;
  const raw = new Float32Array(n);
  const ns = AO_STEPS.length;
  for (let v = 0; v < n; v++) {
    const px = P[v * 3], py = P[v * 3 + 1], pz = P[v * 3 + 2];
    let qx = Nn[v * 3], qy = Nn[v * 3 + 1], qz = Nn[v * 3 + 2];
    const ql = Math.hypot(qx, qy, qz) || 1; qx /= ql; qy /= ql; qz /= ql;
    let occ = 0, wsum = 0;
    for (let d = 0; d < AO_DIRS.length; d += 3) {
      const dx = AO_DIRS[d], dy = AO_DIRS[d + 1], dz = AO_DIRS[d + 2];
      const c = dx * qx + dy * qy + dz * qz;
      if (c < 0.57) continue;
      wsum += c;
      for (let s = 0; s < ns; s++) {
        const k0 = AO_STEPS[s] * cell;
        const i = ((px + dx * k0 - ox) * inv) | 0, j = ((py + dy * k0 - oy) * inv) | 0, k = ((pz + dz * k0 - oz) * inv) | 0;
        if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) break;          // left the model: open sky
        if (grid[k * nxy + j * nx + i] === 1) { occ += c * (1 - 0.5 * s / ns); break; }
      }
    }
    raw[v] = wsum > 0 ? 1 - occ / wsum : 1;
  }
  // Weld by position (UV seams must not show a step), then two smoothing passes along the triangles.
  const ids = new Int32Array(n), map = new Map();
  const sum = [], cnt = [];
  const q = inv * 8;
  for (let v = 0; v < n; v++) {
    const key = `${Math.round(P[v * 3] * q)},${Math.round(P[v * 3 + 1] * q)},${Math.round(P[v * 3 + 2] * q)}`;
    let id = map.get(key);
    if (id === undefined) { id = sum.length; map.set(key, id); sum.push(0); cnt.push(0); }
    ids[v] = id; sum[id] += raw[v]; cnt[id]++;
  }
  let val = Float32Array.from(sum, (s, i) => s / cnt[i]);
  const I = indexArray(g);
  for (let pass = 0; pass < 2; pass++) {
    const acc = Float32Array.from(val), num = new Float32Array(val.length).fill(1);
    for (let t = 0; t + 2 < I.length; t += 3) {
      const a = ids[I[t]], b = ids[I[t + 1]], c = ids[I[t + 2]];
      acc[a] += val[b] + val[c]; num[a] += 2;
      acc[b] += val[a] + val[c]; num[b] += 2;
      acc[c] += val[a] + val[b]; num[c] += 2;
    }
    for (let i = 0; i < val.length; i++) val[i] = acc[i] / num[i];
  }
  const out = new Float32Array(n);
  let mean = 0;
  for (let v = 0; v < n; v++) { out[v] = Math.min(1, Math.max(0, val[ids[v]])); mean += out[v]; }
  const attr = new THREE.BufferAttribute(out, 1);
  g.setAttribute('_toon_ao', attr);
  g.userData.toonAO = { ms: +(performance.now() - t0).toFixed(1), vertices: n, cell: +cell.toFixed(3), mean: +(mean / Math.max(1, n)).toFixed(3) };
  return attr;
}

export default function createToon(game) {
  const A = game.atmo;
  const fallback = (hex) => ({ value: new THREE.Color(hex) });
  const outlineShared = { olViewH: { value: 900 }, olPxScale: { value: 1 } };
  // Shared palette (objects from game.atmo when present, so presets re-light every toon material without recompiles).
  const shared = {
    toonSunLight: A?.palette?.charLight || A?.palette?.sunLight || { value: new THREE.Color(0xfff4e2).multiplyScalar(3) },
    toonSunDirW: A?.uniforms?.atmoSunDir || { value: new THREE.Vector3(-0.45, 0.62, -0.64).normalize() },
    toonShadeTint: A?.palette?.shade || fallback(0xb4b8f0),
    toonSkyUp: A?.palette?.skyUp || fallback(0x243a70),
    toonBounce: A?.palette?.bounce || fallback(0x3a3428),
    toonRimColor: A?.palette?.rim || fallback(0xfff2dc),
    toonFire: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) },
    toonFireColor: { value: Array.from({ length: 4 }, () => new THREE.Color(0, 0, 0)) },
    toonPxScale: outlineShared.olPxScale,           // device px per CSS px (rim width limit)
    // wave 4 form shading on/off for every toon material (A/B: ?toonlook=0, or Digit8 with ?debug — pipeline.js)
    toonLook: { value: game.params?.get?.('toonlook') === '0' ? 0 : 1 },
  };

  function setViewport(heightPx, pxScale) {
    outlineShared.olViewH.value = heightPx;
    outlineShared.olPxScale.value = pxScale;
  }
  const syncViewport = () => {
    const s = game.size || { ph: 900, dpr: 1 };
    const rs = game.quality?.renderScale ?? 1;
    setViewport(Math.max(1, Math.round(s.ph * rs)), (s.dpr || 1) * rs);
  };
  syncViewport();
  game.events.on('resize', syncViewport);
  game.events.on('quality', syncViewport);

  const toColor = (c, d) => (c === undefined || c === null ? new THREE.Color(d) : c.isColor ? c.clone() : new THREE.Color(c));

  const toon = {
    name: 'toon',
    shared,
    setViewport,
    bakeOutlineNormals,

    material(opts = {}) {
      const vertexData = !!opts.vertexData;
      const m = new THREE.MeshToonMaterial({
        color: opts.color ?? 0xffffff,
        map: opts.map || null,
        normalMap: opts.normalMap || null,
        aoMap: opts.aoMap || null,
        emissive: opts.emissive ?? 0x000000,
        emissiveMap: opts.emissiveMap || null,
        emissiveIntensity: opts.emissiveIntensity ?? 1,
        transparent: !!opts.transparent,
        opacity: opts.opacity ?? 1,
        side: opts.side ?? THREE.FrontSide,
        alphaTest: opts.alphaTest ?? 0,
        vertexColors: vertexData,
      });
      if (opts.normalScale) m.normalScale.copy(opts.normalScale.isVector2 ? opts.normalScale : new THREE.Vector2(opts.normalScale, opts.normalScale));
      const steps = opts.steps || 3;
      m.defines = { ...(m.defines || {}), TOON_STEPS: steps };
      if (vertexData) m.defines.TOON_VERTEX_DATA = '';
      if (opts.toonData) m.defines.TOON_DATA_ATTR = '';
      const u = {
        toonMid: { value: opts.mid ?? 0.0 },
        toonSoft: { value: opts.soft ?? 0.025 },
        toonBand: { value: opts.band ?? 0.16 },
        toonSpec: { value: opts.spec ?? 0 },
        toonSpecSize: { value: opts.specSize ?? 0.05 },
        toonRimWidth: { value: opts.rimWidth ?? (opts.rimPower ? THREE.MathUtils.clamp(1 / opts.rimPower, 0.12, 0.6) : 0.26) },
        toonRimStrength: { value: opts.rimStrength ?? 0.75 },
        toonShadeSat: { value: opts.shadeSat ?? 1.2 },
        toonTrans: { value: opts.trans ?? 0 },
        toonTransColor: { value: toColor(opts.transColor, 0xfff0d0) },
        toonNormalMix: { value: opts.normalMap ? (opts.normalStrength ?? 0.35) : 0 },
        toonHitFlash: { value: 0 },
        toonHitColor: { value: new THREE.Color(1.6, 1.5, 1.45) },
        toonShadowSoft: { value: 0.18 },
        toonKeyBias: { value: opts.keyLight ?? 1 },
        toonRimAlbedo: { value: opts.rimAlbedo ?? 0.8 },
        toonRimPx: { value: opts.rimPx ?? 7 },
        // wave 4 form shading (only where keyLight > 0; the shared toonLook switches all of it)
        toonFormCos: { value: Math.cos(THREE.MathUtils.degToRad(opts.formAngle ?? 58)) },
        toonFormMid: { value: opts.formMid ?? 0.15 },
        toonHiK: { value: opts.highlight ?? 0.7 },
        toonHiEdge: { value: opts.highlightEdge ?? 0.6 },
        toonSpecAuto: { value: opts.specAuto ?? 0.7 },
        toonAOBias: { value: opts.aoBias ?? 0.45 },
        toonRimShade: { value: opts.rimShade ?? 0.6 },
        toonShadeDeep: { value: opts.shadeDeep ?? 0.82 },
      };
      if (opts.shade !== undefined) u.toonShadeTint = { value: toColor(opts.shade) };
      if (opts.rim !== undefined) u.toonRimColor = { value: toColor(opts.rim) };
      // Handles by short name too: material.userData.toon.hitFlash.value = 1
      const handles = {};
      for (const k of Object.keys(u)) { handles[k] = u[k]; handles[k[4].toLowerCase() + k.slice(5)] = u[k]; }
      m.userData.toon = handles;
      m.userData.cacheKey = 'skytoon3';
      m.userData.atmoStrength = opts.atmo ?? 0.75;
      m.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, shared, u);
        if (m.defines?.TOON_DATA_ATTR !== undefined) {
          shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nattribute vec3 _toon_data;\nvarying vec3 vToonData;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\nvToonData = _toon_data;');
        }
        if (m.defines?.TOON_AO_ATTR !== undefined) {
          shader.vertexShader = shader.vertexShader
            .replace('#include <common>', '#include <common>\nattribute float _toon_ao;\nvarying float vToonAO;')
            .replace('#include <begin_vertex>', '#include <begin_vertex>\nvToonAO = _toon_ao;');
        }
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <shadowmap_pars_fragment>', '#include <shadowmap_pars_fragment>\n' + TOON_PARS)
          .replace('#include <lights_fragment_begin>', '')
          .replace('#include <lights_fragment_maps>', '')
          .replace('#include <lights_fragment_end>', '')
          .replace('vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;', TOON_MAIN);
        if (vertexData) shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', '');
      };
      if (game.atmo) game.atmo.patch(m);
      else m.customProgramCacheKey = () => 'skytoon3';
      return m;
    },

    outline(mesh, opts = {}) {
      const g = mesh?.geometry;
      if (!g?.attributes?.position) return null;
      // Never outline an outline (callers that add outlines inside traverse() would recurse forever) or twice.
      if (mesh.userData.isOutline) return null;
      if (mesh.userData.outlineMesh) return mesh.userData.outlineMesh;
      try { bakeOutlineNormals(g); } catch (e) { console.warn('[toon] outline normals failed', e); return null; }
      const body = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      const vertexData = !!(opts.vertexData && g.attributes.color);
      const toonData = opts.toonData !== false && !!g.attributes._toon_data;
      const flat = opts.color !== undefined && opts.color !== null;
      const mat = new THREE.MeshBasicMaterial({
        color: flat ? toColor(opts.color) : (body?.color ? body.color.clone() : new THREE.Color(0xffffff)),
        map: flat ? (body?.alphaTest > 0 ? body.map : null) : (body?.map || null),
        alphaTest: body?.alphaTest || 0,
        side: THREE.BackSide,
        vertexColors: vertexData,
      });
      const ou = {
        olWidth: { value: opts.width ?? 0.035 },
        olMinPx: { value: opts.minPx ?? 1.0 },
        olMaxPx: { value: opts.maxPx ?? 2.6 },
        olZPush: { value: opts.zPush ?? 0.0006 },
        olTint: { value: toColor(opts.tint, 0x786878) },
        olUseAlbedo: { value: flat ? 0 : 1 },
        override: { value: new THREE.Vector4(0, 0, 0, 0) },
      };
      if (flat && mat.map) ou.override.value.set(mat.color.r, mat.color.g, mat.color.b, 1);   // map only for alpha
      mat.userData.outline = ou;
      if (vertexData) mat.defines = { OUTLINE_VERTEX_DATA: '' };
      if (toonData) mat.defines = { ...(mat.defines || {}), OUTLINE_TOON_DATA: '' };
      // The body's toon material reads the same attribute (shadow bias, rim mask) once its mesh is outlined.
      if (toonData) toon.useToonData(mesh);
      // Characters without authored _toon_data (the dragons) get a baked ambient occlusion instead (wave 4).
      else if (mesh.isSkinnedMesh && opts.ao !== false) toon.useAO(mesh);
      mat.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, outlineShared, ou, { olOverride: ou.override });
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\n' + OUTLINE_VERT_PARS)
          .replace('#if defined ( USE_ENVMAP ) || defined ( USE_SKINNING )', '#if 1')
          .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = outlineNormal;\n#ifdef USE_TANGENT\nvec3 objectTangent = vec3( tangent.xyz );\n#endif')
          .replace('#include <project_vertex>', '#include <project_vertex>\n' + OUTLINE_VERT);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform vec3 olTint; uniform float olUseAlbedo; uniform vec4 olOverride;')
          .replace('#include <color_fragment>', vertexData ? '' : '#include <color_fragment>')
          .replace('#include <alphatest_fragment>', `#include <alphatest_fragment>
            // Line colour = darkened, more saturated local albedo (never pure black on light characters).
            diffuseColor.rgb = mix(diffuseColor.rgb, pow(max(diffuseColor.rgb, vec3(0.0)), vec3(1.8)) * olTint, olUseAlbedo);
            diffuseColor.rgb = mix(diffuseColor.rgb, olOverride.rgb, olOverride.w);`);
      };
      mat.userData.cacheKey = 'skyoutline3';
      mat.userData.atmoStrength = opts.atmo ?? 0.75;
      if (game.atmo) game.atmo.patch(mat);
      else mat.customProgramCacheKey = () => 'skyoutline3';

      let o;
      if (mesh.isSkinnedMesh) {
        o = new THREE.SkinnedMesh(g, mat);
        o.bindMode = mesh.bindMode;
        o.bind(mesh.skeleton, mesh.bindMatrix);
      } else if (mesh.isInstancedMesh) {
        o = new THREE.InstancedMesh(g, mat, mesh.count);
        o.instanceMatrix = mesh.instanceMatrix;
        o.onBeforeRender = () => { o.count = mesh.count; };
      } else {
        o = new THREE.Mesh(g, mat);
      }
      if (mesh.morphTargetInfluences) o.morphTargetInfluences = mesh.morphTargetInfluences;
      if (mesh.morphTargetDictionary) o.morphTargetDictionary = mesh.morphTargetDictionary;
      o.name = (mesh.name || 'mesh') + '_outline';
      o.castShadow = false; o.receiveShadow = false;
      o.frustumCulled = mesh.frustumCulled;
      o.renderOrder = mesh.renderOrder;
      o.layers.mask = mesh.layers.mask;
      o.userData.isOutline = true;
      mesh.userData.outlineMesh = o;
      mesh.add(o);
      return o;
    },

    /** Let the mesh's game.toon material(s) read the asset's '_toon_data' attribute (y shadow bias, z rim mask).
     *  Only for materials used by geometries that carry it. Returns true when enabled. outline() calls it. */
    useToonData(mesh) {
      if (!mesh?.geometry?.attributes?._toon_data) return false;
      let any = false;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        if (!m?.userData?.toon || m.defines?.TOON_DATA_ATTR !== undefined) continue;
        m.defines = { ...(m.defines || {}), TOON_DATA_ATTR: '' };
        m.needsUpdate = true;
        any = true;
      }
      return any;
    },

    /** Bake (once per geometry) and enable the '_toon_ao' ambient occlusion for the mesh's toon material(s): creases
     *  shade first (terminator bias), ambient and shade darken gently. Occluders = the skinned siblings that share
     *  the mesh's skeleton (body + membrane primitives of one GLB). Returns true when enabled; never throws. */
    useAO(mesh) {
      try {
        const g = mesh?.geometry;
        if (!g?.attributes?.position || g.attributes._toon_data) return false;
        const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).filter((m) => m?.userData?.toon);
        if (!mats.length) return false;
        if (!g.attributes._toon_ao) {
          const occ = [g];
          for (const s of mesh.parent?.children || []) {
            if (s !== mesh && s.isSkinnedMesh && !s.userData.isOutline && s.skeleton === mesh.skeleton && s.geometry?.attributes?.position) occ.push(s.geometry);
          }
          bakeToonAO(g, occ);
        }
        for (const m of mats) {
          if (m.defines?.TOON_AO_ATTR !== undefined) continue;
          m.defines = { ...(m.defines || {}), TOON_AO_ATTR: '' };
          m.needsUpdate = true;
        }
        return true;
      } catch (e) {
        console.warn('[toon] AO bake failed', e);
        return false;
      }
    },

    convert(root, opts = {}) {
      const meshes = [];
      root.traverse((o) => { if (o.isMesh && !o.userData.isOutline) meshes.push(o); });
      const { overrides, outline, outlineWidth, outlineColor, ...base } = opts;
      for (const o of meshes) {
        const old = Array.isArray(o.material) ? o.material[0] : o.material;
        const extra = overrides?.[o.name] || overrides?.[old?.name] || {};
        const m = toon.material({
          map: old?.map || null,
          color: old?.map ? 0xffffff : (old?.color?.getHex?.() ?? 0xffffff),
          emissive: old?.emissive?.getHex?.() ?? 0,
          emissiveMap: old?.emissiveMap || null,
          emissiveIntensity: old?.emissiveIntensity ?? 1,
          normalMap: old?.normalMap || null,
          alphaTest: old?.alphaTest || 0,
          transparent: old?.transparent || false,
          side: old?.side ?? THREE.FrontSide,
          vertexData: !!(opts.vertexData && o.geometry?.attributes?.color),
          toonData: opts.toonData !== false && !!o.geometry?.attributes?._toon_data,
          ...base,
          ...extra,
        });
        if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
        if (m.emissiveMap) m.emissiveMap.colorSpace = THREE.SRGBColorSpace;
        m.name = old?.name || '';
        o.material = m;
        o.castShadow = true; o.receiveShadow = true;
        const ol = extra.outline ?? outline;
        if (ol !== false) {
          toon.outline(o, {
            width: extra.outlineWidth ?? outlineWidth, color: extra.outlineColor ?? outlineColor,
            vertexData: opts.vertexData, ...(typeof ol === 'object' ? ol : {}),
          });
        }
      }
      return root;
    },

    /** Flat fire light for toon materials. pos = world Vector3 (null turns the slot off), radius in metres. */
    setFireLight(i, pos, color = 0xff8a30, radius = 30) {
      const f = shared.toonFire.value[i], c = shared.toonFireColor.value[i];
      if (!f) return;
      if (!pos) { f.w = 0; return; }
      f.set(pos.x, pos.y, pos.z, radius);
      if (color.isColor) c.copy(color); else c.set(color);
    },
  };
  return toon;
}
