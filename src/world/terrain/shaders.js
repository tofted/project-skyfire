// Terrain shaders: CDLOD vertex morph over WORLD_GLSL heights; anime-painted fragment shading.
// Colour = painted valley map (inside the map square) or procedural painted palette (outside), + stylised close-range
// detail (brush-stroke grass, crop rows, cliff strata, sand), soft two-tone cel light with blue-violet shade, curvature
// tint, backlit ridge rim, wind sheen over meadows, cloud shadows, then game.atmo aerial perspective.
import { WORLD_GLSL, WORLD_SHADE_GLSL } from './data.js';
import { MIST_GLSL } from './mist.js';

// Wave 5 — the world has no visible end. The sky dome paints below the horizon in the valley-mist grey (sky.js,
// atmoMistSkyT: a ray going down crosses the whole mist layer) and wins over any fragment beyond ~56.6 km view depth
// (it is drawn last at NDC z = 0.999999; the far plane is 60 km). Between the true horizon and that end of the terrain
// / sea it showed as a straight light band (1.3° tall at 1350 m, 2.5° at 2500 m) with the hazed sea or ground below.
// Now the terrain and the sea fade over uHorizon.x → y (radial metres, 36 → 52 km) into worldFarColor(rd), a colour
// that depends only on the view direction: the ground plane y = uHorizon.z (land or sea by the edge-clamped outer
// water map) seen through game.atmo's haze, meeting the dome's own colour just above the horizon over the last
// uHorizon.w rad of depression; above the horizon it is the dome's colour itself. The horizon apron (terrain.js,
// HORIZON_VS/FS) paints the same colour on every below-horizon sky pixel, so the fade, the apron and the sky meet
// without a seam.
// Needs, declared before it: the atmo chunk (atmoSky, atmoMistIn, atmoMistSkyT, atmoApply), WORLD_GLSL and
// `uniform sampler2D tFlowOut`.
export const HORIZON_GLSL = /* glsl */`
uniform vec4 uHorizon;         // x fade start, y fade end (radial m), z far ground plane height (m), w horizon blend (rad)
uniform vec3 uFarLand;         // far land colour before the haze (linear, lit)
uniform vec3 uFarSea;          // far sea colour before the haze (linear)
// the sky dome's colour in direction d (sky.js without the cirrus, which starts 1.1° up, and the sun disc)
vec3 worldDomeSky(vec3 d) { return mix(atmoMistIn(d), atmoSky(d), atmoMistSkyT(cameraPosition, d)); }
vec3 worldFarColor(vec3 rd) {
  if (rd.y >= 0.0) return worldDomeSky(rd);
  float t = min(max(cameraPosition.y - uHorizon.z, 1.0) / max(-rd.y, 1e-5), 2.0e7);
  vec3 P = cameraPosition + rd * t;
  float sea = smoothstep(0.85, 1.0, textureLod(tFlowOut, worldUvOut(P.xz), 0.0).b);   // clamp-to-edge: the border type
  vec3 g = atmoApply(mix(uFarLand, uFarSea, sea), P);
  vec3 d0 = normalize(vec3(rd.x, 0.0, rd.z) + vec3(0.0, 1e-4, 0.0));                    // the sky just above the horizon
  return mix(worldDomeSky(d0), g, smoothstep(0.0, uHorizon.w, -rd.y));
}
vec3 worldFarFade(vec3 col, vec3 p) {
  vec3 rd = p - cameraPosition;
  float dist = length(rd);
  float k = smoothstep(uHorizon.x, uHorizon.y, dist);
  return k > 0.0 ? mix(col, worldFarColor(rd / max(dist, 1e-3)), k) : col;
}
`;

// Horizon apron: the lower sky hemisphere (to 0.5° above the horizon) around the camera, drawn right after the sky
// dome a little in FRONT of the dome's depth (NDC z 0.999998 vs 0.999999, i.e. 53.8 vs 56.6 km view depth): it covers
// every pixel the dome covers and the terrain / sea beyond 53.8 km, which the fade has already turned into the same
// colour. (At the dome's exact depth, 1-ulp ties with the terrain's last row let the grey dome through as 1 px dashes.)
export const HORIZON_VS = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = vec4(p.xy, p.w * 0.999998, p.w);
}
`;
export function horizonFS(atmoChunk) {
  return /* glsl */`
uniform sampler2D tFlowOut;
varying vec3 vDir;
${WORLD_GLSL}
${atmoChunk}
${HORIZON_GLSL}
void main() {
  gl_FragColor = vec4(worldFarColor(normalize(vDir)), 1.0);
}
`;
}

export const TERRAIN_VS = /* glsl */`
attribute vec4 aNode;          // x0, z0, size, lod level
uniform vec2 uMorph[16];       // per level: morph start distance, 1 / (end - start)
uniform float uGrid;           // quads per node side
varying vec3 vW;
varying float vLod;
${WORLD_GLSL}
void main() {
  vec2 g = position.xz;
  vec2 p = aNode.xy + g * aNode.z;
  float h0 = worldHW(p).x;
  float d = distance(cameraPosition, vec3(p.x, h0, p.y));
  vec2 m = uMorph[int(aNode.w + 0.5)];
  float k = clamp((d - m.x) * m.y, 0.0, 1.0);
  vec2 odd = fract(g * uGrid * 0.5) * 2.0 / uGrid;
  g -= odd * k;
  p = aNode.xy + g * aNode.z;
  vW = vec3(p.x, worldHeight(p), p.y);
  vLod = aNode.w + k;
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
}
`;

export function terrainFS({ atmoChunk, shadowChunk }) {
  return /* glsl */`
uniform sampler2D tAlbedo;      // painted valley map (sRGB -> linear by three)
uniform sampler2D tMaskA;       // forest, field, rock
uniform sampler2D tMaskB;       // sand, cherry, village
uniform sampler2D tFlowOut;     // outer water type (b = 1 at sea)
uniform float uTime;
uniform vec2 uWind;             // wind direction * strength (m/s)
uniform vec3 uShade;            // shade tint (linear)
uniform vec3 uSkyFill;          // ambient from the sky (linear)
uniform float uLight;           // overall light scale
uniform float uDebug;
uniform float uDetailOn;
uniform float uForceOuter;      // A/B: 1 = evaluate the outer palette everywhere (wave-1 cost)
uniform vec3 uPalette;          // key-art palette pass: x field/meadow saturation, y rock grey-green, z sand warmth
uniform vec4 uNearK;          // wave 4: x,y tile range (start, end), z,w map/bank range (start, end), metres
uniform float uWave4;          // 1 = wave-4 near-range painting, 0 = wave-2 look (A/B)
varying vec3 vW;
varying float vLod;
${WORLD_GLSL}
${WORLD_SHADE_GLSL}
${atmoChunk}
${HORIZON_GLSL}
${shadowChunk}
${MIST_GLSL}

vec3 srgb(vec3 c) { return c * c * (c * 0.305306 + 0.682171) + c * 0.012523; }   // cheap sRGB -> linear
float nzs(vec2 p) { return texture(tWNoise, p).r; }                              // mip-filtered noise
uniform sampler2D tDetail;      // 2x2 atlas of painted tiles: grass, crops, rock, sand
uniform vec3 uDetailMean[4];
vec3 detailTex(int k, vec2 uv) {
  vec2 q = vec2(float(k % 2), float(k / 2)) * 0.5;
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  return textureGrad(tDetail, q + 0.004 + fract(uv) * 0.492, dx * 0.492, dy * 0.492).rgb;
}
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
// Wave 4: painted tile k at world scale S and its octaves S·4^i (each rotated): an octave fades to its mean BEFORE its
// brush strokes (stroke = s · strokeFrac metres) shrink below ~3 px, so there is never sub-pixel grain; the bigger
// octaves take over with distance. amp < 1 softens the tile's contrast (painterly, not photographic).
vec3 paintTile(int k, vec2 p, float S, float fp, float amp, float strokeFrac, int oct, float fall) {
  vec3 acc = vec3(1.0);
  float s = S;
  for (int i = 0; i < 4; i++) {
    if (i >= oct) break;
    float stroke = s * strokeFrac;
    float w = 1.0 - smoothstep(stroke / 6.0, stroke / 3.0, fp);
    if (w > 0.01) {
      vec3 r = detailTex(k, p / s + vec2(0.37, 0.61) * float(i)) / uDetailMean[k];
      acc *= mix(vec3(1.0), pow(clamp(r, vec3(0.25), vec3(2.2)), vec3(amp * max(1.0 - fall * float(i), 0.2))), w);
    }
    s *= 4.0;
    p = mat2(0.8, -0.6, 0.6, 0.8) * p;
  }
  return acc;
}

// Procedural painted palette (outside the map square): meadow / forest / rock strata / snow / beach.
vec3 paintOuter(vec3 p, vec3 N, float rough, float sea, out float forestOut, out float rockOut, out float sandOut, out float farmOut) {
  float slope = 1.0 - N.y;
  float n1 = nzs(p.xz / 5600.0 + 0.21);
  float n2 = nzs(p.xz / 480.0 + 0.53);
  float n3 = nzs(p.xz / 12000.0 + 0.77);
  float P = clamp((rough - 2.0) / 40.0, 0.0, 1.0);
  float fo = smoothstep(0.30, 0.52, n1 + 0.25 * P) * smoothstep(1750.0, 1350.0, p.y) * smoothstep(0.55, 0.25, slope);
  float rk = clamp(smoothstep(0.30, 0.55, slope) + smoothstep(1650.0, 2050.0, p.y) * smoothstep(0.08, 0.25, slope), 0.0, 1.0);
  float sd = clamp(sea * 3.0, 0.0, 1.0) * smoothstep(7.0, 2.5, p.y);
  sd = max(sd, smoothstep(3.2, 1.2, p.y) * step(-5.0, p.y));
  // patchwork farmland on the flat lowlands outside the map (like the painted valley): hedged cells of crops
  float farm = smoothstep(0.46, 0.56, nzs(p.xz / 4000.0 + 0.13)) * smoothstep(0.1, 0.04, slope) * smoothstep(180.0, 70.0, p.y)
             * (1.0 - smoothstep(0.08, 0.2, P)) * (1.0 - sd);
  fo *= (1.0 - sd) * (1.0 - farm);
  vec3 meadow = mix(srgb(vec3(0.435, 0.682, 0.290)), srgb(vec3(0.612, 0.784, 0.369)), n3) * (0.9 + 0.2 * n2);
  // painted canopy: crowns ~30 m with violet-green gaps, clumps ~250 m
  float cr = nzs(p.xz / 1100.0 + 0.31) * 0.6 + nzs(p.xz / 380.0 + 0.9) * 0.4;
  float crown = smoothstep(0.35, 0.75, cr);
  vec3 forest = mix(srgb(vec3(0.13, 0.33, 0.25)), srgb(vec3(0.27, 0.52, 0.27)), crown);
  forest = mix(forest, srgb(vec3(0.36, 0.60, 0.30)), smoothstep(0.62, 0.8, n2) * 0.6) * (0.9 + 0.2 * n1);
  float strata = 0.5 + 0.5 * sin(p.y / 23.0 + 3.0 * n2);
  vec3 rock = mix(srgb(vec3(0.663, 0.643, 0.722)), srgb(vec3(0.847, 0.80, 0.69)), strata);
  float snow = smoothstep(2050.0, 2350.0, p.y + 200.0 * n2) * smoothstep(0.6, 0.3, slope);
  vec3 c = meadow;
  c = mix(c, forest, fo);
  if (farm > 0.01) {
    // irregular patchwork: warped grid, staggered rows of different widths
    vec2 pw = p.xz + (vec2(nzs(p.xz / 9000.0 + 0.2), nzs(p.xz / 9000.0 + 0.7)) - 0.5) * 700.0;
    vec2 q = mat2(0.96, -0.28, 0.28, 0.96) * pw / vec2(230.0, 160.0);
    float row = floor(q.y);
    q.x = q.x * (0.7 + 0.6 * hash12(vec2(row, 3.1))) + row * 0.37;
    vec2 cell = floor(q), f = fract(q);
    float h = hash12(cell);
    vec3 crop = h < 0.3 ? srgb(vec3(0.85, 0.76, 0.35)) : h < 0.55 ? srgb(vec3(0.62, 0.78, 0.33)) : h < 0.8 ? srgb(vec3(0.44, 0.68, 0.29)) : srgb(vec3(0.76, 0.80, 0.40));
    float edge = min(min(f.x, 1.0 - f.x) * 230.0, min(f.y, 1.0 - f.y) * 160.0);     // metres to the hedge
    crop = mix(srgb(vec3(0.20, 0.42, 0.24)), crop, smoothstep(2.0, 4.0, edge));
    c = mix(c, crop, farm);
  }
  c = mix(c, rock, rk);
  c = mix(c, vec3(0.93, 0.95, 1.0), snow);
  c = mix(c, srgb(vec3(0.945, 0.89, 0.753)), sd);
  c = mix(c, srgb(vec3(0.20, 0.52, 0.60)), smoothstep(-1.0, -6.0, p.y));   // sea floor (seen through shallows)
  forestOut = fo * (1.0 - rk); rockOut = max(rk, snow); sandOut = sd; farmOut = farm;
  return c;
}

// ---- wave 4: the near range (below ~400 m AGL the camera sees ground 100–1500 m away) ----------------------------
// Painted tiles blended by the class masks replace the stretched map's texture; the map keeps the hue of each patch.
// Sand bars get crisp, brush-edged outlines; the painted river colour that spills onto dry banks becomes wet sand.
void paintNear(inout vec3 alb, vec3 w, vec3 NB, float slope, float fp, float dist, float tileK, float mapK,
               inout float forest, float field, float rock, inout float sand, float cherry, float village, inout float meadow,
               out vec3 dbg) {
  vec2 p = w.xz;
  dbg = vec3(0.0);
  float smallK = 1.0 - smoothstep(0.12, 0.45, fp);        // the 9 m wobble octave only where it is several px wide
  if (mapK > 0.0) {
    // crisp sand-bar / beach edges with a painted wobble (the 16 m mask is a soft blur up close)
    float wob = (nzs(p / 41.0 + 0.3) - 0.5) * 0.55 + (nzs(p / 9.0 + 0.7) - 0.5) * 0.3 * smallK;
    float sandN = smoothstep(0.42, 0.58, sand + wob * 0.7);
    sand = mix(sand, sandN, mapK);
    meadow = clamp(1.0 - forest - rock - sand - village, 0.0, 1.0);
    // banks: metres above the water surface. The painted map's turquoise river spills 1–2 texels onto dry ground
    // (it read as a cyan band of "TV noise" beside the water); it becomes pale bank sand, and a darker wet band
    // runs just above the waterline
    float above = w.y - worldHW(p).y;
    // turquoise / teal paint (the painted river is wider than the baked water): min(g, b) well above r, b ≳ g
    float cy = smoothstep(0.04, 0.14, min(alb.b, alb.g) - alb.r * 1.3) * smoothstep(-0.12, 0.0, alb.b - alb.g)
             * (1.0 - smoothstep(4.0, 9.0, above));
    vec3 bankSand = mix(srgb(vec3(0.86, 0.80, 0.66)), srgb(vec3(0.74, 0.72, 0.58)), nzs(p / 60.0));
    float dry = smoothstep(-0.1, 0.25, above);
    alb = mix(alb, bankSand, cy * dry * mapK);
    sand = max(sand, cy * dry * mapK);
    float wet = (1.0 - smoothstep(0.1, 0.9, above)) * dry;
    dbg = vec3(cy, clamp(above / 3.0, 0.0, 1.0), clamp(-above, 0.0, 1.0));
    alb = mix(alb, alb * vec3(0.70, 0.78, 0.80), wet * 0.75 * mapK);
    // sand and gravel bars: a clean warm beige (the map's grey bars with dark specks read as dirty soap up close)
    alb = mix(alb, mix(alb, srgb(vec3(0.88, 0.82, 0.67)), 0.55), clamp(sand, 0.0, 1.0) * (1.0 - wet) * mapK);
    // broad painterly value / hue variation over meadows and forest floor (brush dabs of 70–260 m)
    float mv = nzs(mat2(0.8, -0.6, 0.6, 0.8) * p / 260.0 + 0.2) * 0.65 + nzs(p / 70.0 + 0.5) * 0.35;
    vec3 dab = mix(vec3(0.90, 0.97, 1.03), vec3(1.07, 1.04, 0.91), smoothstep(0.3, 0.7, mv));
    alb *= mix(vec3(1.0), dab, clamp(meadow + forest * 0.5 + cherry * 0.3, 0.0, 1.0) * 0.85 * mapK);
    // painted roofs on the map give way to village ground near the 3D houses
    float roofish = village * smoothstep(0.02, 0.12, alb.r - alb.g) + village * smoothstep(0.02, 0.1, alb.b - alb.r - 0.02);
    vec3 yard = mix(srgb(vec3(0.72, 0.66, 0.50)), srgb(vec3(0.46, 0.62, 0.34)), nzs(p / 60.0));
    alb = mix(alb, yard, clamp(roofish, 0.0, 1.0) * mapK);
    // forest floor under the 3D trees: darker, cooler
    alb = mix(alb, alb * vec3(0.62, 0.72, 0.78), forest * 0.45 * mapK);
  }
  if (tileK > 0.0) {
    float rockAmt = clamp(max(rock, smoothstep(0.35, 0.6, slope)), 0.0, 1.0);
    float kC = smoothstep(0.3, 0.8, field) * (1.0 - rockAmt);
    float kS = clamp(sand, 0.0, 1.0) * (1.0 - rockAmt) * (1.0 - kC);
    float kG = clamp(meadow + forest * 0.8 + cherry * 0.5 + field * 0.2, 0.0, 1.0) * (1.0 - kC) * (1.0 - kS) * (1.0 - rockAmt);
    // grass: brush-stroke tile, octaves 6 / 24 / 96 / 384 m
    if (kG > 0.01) alb *= mix(vec3(1.0), paintTile(0, p, 6.0, fp, 0.55, 0.04, 4, 0.1), kG * tileK);
    // crop rows: two furrow directions crossfaded by a smooth patch field; octaves (14×22) and ×4 (strips)
    if (kC > 0.01) {
      float fw = smoothstep(0.42, 0.58, nzs(p / 1500.0 + 0.4));
      vec2 rp = fw < 0.5 ? mat2(0.94, -0.34, 0.34, 0.94) * p : mat2(0.34, 0.94, -0.94, 0.34) * p;
      rp /= vec2(14.0, 22.0);
      vec3 c = vec3(1.0);
      for (int i = 0; i < 2; i++) {
        float s = i == 0 ? 1.0 : 4.0;
        float wv = 1.0 - smoothstep(1.75 * s / 6.0, 1.75 * s / 3.0, fp);    // a row is ~1.75 m wide per unit scale
        if (wv > 0.01) c *= mix(vec3(1.0), pow(clamp(detailTex(1, rp / s + 0.13 * float(i)) / uDetailMean[1], vec3(0.3), vec3(2.0)), vec3(0.5)), wv);
      }
      alb *= mix(vec3(1.0), c, kC * tileK * smoothstep(0.05, 0.4, abs(fw - 0.5)));   // rows fade where they turn
    }
    // sand / gravel: pebble tile, octaves 12 / 48 / 192 m, low contrast (pebbles never shrink into specks)
    // (the bigger octaves are much softer: their pebbles are metres wide and read as craters at full contrast)
    if (kS > 0.01) alb *= mix(vec3(1.0), paintTile(3, p, 12.0, fp, 0.36, 0.028, 3, 0.4), kS * tileK);
    // rock: biplanar strata (bands follow height), 34 / 136 m
    if (rockAmt > 0.01) {
      float bw = smoothstep(0.3, 0.7, abs(NB.z) / (abs(NB.x) + abs(NB.z) + 1e-3));
      vec3 r = vec3(1.0);
      for (int i = 0; i < 2; i++) {
        float s = i == 0 ? 34.0 : 136.0;
        float wv = 1.0 - smoothstep(s / 14.0, s / 7.0, fp);
        if (wv < 0.01) continue;
        vec3 a = detailTex(2, vec2(p.x, w.y) / s), b = detailTex(2, vec2(p.y, w.y) / s);
        r *= mix(vec3(1.0), pow(clamp(mix(a, b, bw) / uDetailMean[2], vec3(0.35), vec3(1.9)), vec3(0.7)), wv);
      }
      alb *= mix(vec3(1.0), r, rockAmt * tileK * 0.85);
    }
  }
}

void main() {
  vec3 V = cameraPosition - vW;
  float dist = length(V); V /= max(dist, 1e-3);

  // --- normals: baked base normals (mipmapped by footprint) + analytic gradient of the detail noise ---
  float e = clamp(dist * 0.0016, 0.8, 60.0);
  float fade = 1.0 - smoothstep(1500.0, 5000.0, dist);
  vec4 tn = worldNrm(vW.xz, log2(max(e / 8.0, 1.0)));
  float roughT = tn.a * uWorldHalf.z;
  vec2 gF = worldBaseGrad(tn) + roughT * worldDetailGrad(vW.xz, fade, 0.0);
  vec3 N = normalize(vec3(-gF.x, 1.0, -gF.y));
  // large-form normal for the cel band (anime light follows big shapes, not every bump)
  float e2 = max(e * 4.0, 28.0);
  vec4 tb = worldNrm(vW.xz, log2(max(e2 / 8.0, 1.0)));
  vec2 gB = worldBaseGrad(tb) + roughT * worldDetailGrad(vW.xz, 0.0, 1.0);
  vec3 NB = normalize(vec3(-gB.x, 1.0, -gB.y));
  float curv = (tb.b - 0.5) * 2.0;                     // >0 gully, <0 ridge

  // --- albedo + class masks ---
  vec2 uvI = worldUvIn(vW.xz);
  float wMap = smoothstep(0.0, 1100.0, uWorldHalf.x - max(abs(vW.x), abs(vW.z)));
  float forest = 0.0, field = 0.0, rock = 0.0, sand = 0.0, cherry = 0.0, village = 0.0;
  float rough = roughT;
  // the procedural outer palette (a dozen noise taps + the farmland patchwork) only where the painted map does not
  // fully cover the ground: most of the playable area is inside the map square
  float fo = 0.0, rk = 0.0, sd = 0.0, fm = 0.0;
  vec3 alb = vec3(0.0);
  if (wMap < 0.999 || uForceOuter > 0.5) {
    float sea = smoothstep(0.85, 1.0, texture(tFlowOut, worldUvOut(vW.xz)).b);
    alb = paintOuter(vW, NB, rough, sea, fo, rk, sd, fm);
  }
  // wave 4: near-range weights. mapK: the magnified 8 m/px map gives way to a low-passed map (its hue per field /
  // meadow / bar) + crisp class edges + the bank repaint; tileK: the painted tiles in footprint-aware octaves
  float w4 = step(0.5, uWave4) * uDetailOn;
  float mapK = (1.0 - smoothstep(uNearK.z, uNearK.w, dist)) * w4;
  float tileK = (1.0 - smoothstep(uNearK.x, uNearK.y, dist)) * w4;
  float fp = max(length(fwidth(vW.xz)), 0.02);          // metres per pixel (the long axis of the footprint)
  if (wMap > 0.0) {
    // unsharp mask: the painted map is magnified up close, so lift its edges a little (wave 4: only far away — up
    // close it sharpened the map's JPEG blocks and 1-texel specks into "soap with grain")
    vec3 mapC = texture(tAlbedo, uvI).rgb;
    vec3 mapB = texture(tAlbedo, uvI, 2.0).rgb;
    mapC = max(mapC + (mapC - mapB) * 0.55 * (1.0 - smoothstep(800.0, 4000.0, dist)) * (1.0 - mapK), vec3(0.0));
    if (mapK > 0.0) mapC = mix(mapC, textureLod(tAlbedo, uvI, 1.15).rgb, mapK);
    vec3 mA = texture(tMaskA, uvI).rgb, mB = texture(tMaskB, uvI).rgb;
    alb = wMap >= 0.999 && uForceOuter < 0.5 ? mapC : mix(alb, mapC, wMap);
    forest = mix(fo, mA.r, wMap); field = mA.g * wMap; rock = mix(rk, mA.b, wMap);
    sand = mix(sd, mB.r, wMap); cherry = mB.g * wMap; village = mB.b * wMap;
    field = max(field, fm * (1.0 - wMap));
  } else { forest = fo; rock = rk; sand = sd; field = fm; }
  float slope = 1.0 - NB.y;
  // steep walls (terrace banks, cliff faces): the top-down painted map smears into vertical colour stripes there, so
  // they are painted as grey-green rock strata instead (the close-range strata tile then modulates this colour)
  float wall = smoothstep(0.38, 0.62, 1.0 - min(N.y, NB.y));
  if (wall > 0.0) {
    float lw = dot(alb, vec3(0.2126, 0.7152, 0.0722));
    float strata = clamp(nzs(vW.xz / 420.0 + vec2(0.0, vW.y / 900.0)) * 1.4 - 0.2, 0.0, 1.0);   // broad, no fine bands (they alias far away)
    vec3 wallC = mix(srgb(vec3(0.56, 0.60, 0.53)), srgb(vec3(0.74, 0.72, 0.62)), strata) * (0.8 + 0.5 * clamp(lw * 2.5, 0.0, 1.0));
    alb = mix(alb, wallC, wall * 0.9);
    rock = max(rock, wall);
  }
  float meadow = clamp(1.0 - forest - rock - sand - village, 0.0, 1.0);

  // --- painted close-range detail: hand-painted anime tiles (grass, crop rows, rock strata, sand) modulate the map
  //     colour by their ratio to their own mean, so the valley keeps the map's palette and gains brush strokes ---
  float near = (1.0 - smoothstep(180.0, 1500.0, dist)) * uDetailOn * (1.0 - step(0.5, uWave4));
  vec3 dbg4 = vec3(0.0);
  if (w4 > 0.0) paintNear(alb, vW, NB, slope, fp, dist, tileK, mapK, forest, field, rock, sand, cherry, village, meadow, dbg4);
  if (near > 0.0) {
    vec2 p = vW.xz;
    float rockAmt = max(rock, smoothstep(0.35, 0.6, slope)) * (1.0 - smoothstep(900.0, 3500.0, dist) * 0.5);
    float kG = near * 0.8 * clamp(meadow + forest * 0.7 + field * 0.15 + cherry * 0.5, 0.0, 1.0);
    float kC = near * 0.75 * smoothstep(0.3, 0.8, field);
    // grass: two scales, the second rotated, so the tile never repeats visibly
    if (kG * (1.0 - kC) > 0.01) {
      vec2 pr = mat2(0.8, -0.6, 0.6, 0.8) * p;
      vec3 g = mix(detailTex(0, p / 19.0), detailTex(0, pr / 7.3 + 0.37), 0.42) / uDetailMean[0];
      alb *= mix(vec3(1.0), clamp(g, 0.35, 1.9), kG * (1.0 - kC));
    }
    // crop rows: two furrow directions, crossfaded by a smooth patch field (no hard seams inside painted fields)
    if (kC > 0.01) {
      float fw = smoothstep(0.42, 0.58, nzs(p / 1500.0 + 0.4));
      vec2 rp = fw < 0.5 ? mat2(0.94, -0.34, 0.34, 0.94) * p : mat2(0.34, 0.94, -0.94, 0.34) * p;
      vec3 c = detailTex(1, rp / vec2(14.0, 22.0)) / uDetailMean[1];
      alb *= mix(vec3(1.0), clamp(c, 0.35, 1.9), kC * smoothstep(0.05, 0.4, abs(fw - 0.5)));   // rows fade where they turn
    }
    // rock: biplanar strata (bands follow height)
    if (rockAmt * near > 0.01) {
      float bw = smoothstep(0.3, 0.7, abs(NB.z) / (abs(NB.x) + abs(NB.z) + 1e-3));
      vec3 r = bw < 0.12 ? detailTex(2, vec2(p.x, vW.y) / 34.0) : bw > 0.88 ? detailTex(2, vec2(p.y, vW.y) / 34.0)
             : mix(detailTex(2, vec2(p.x, vW.y) / 34.0), detailTex(2, vec2(p.y, vW.y) / 34.0), bw);
      r /= uDetailMean[2];
      alb = mix(alb, alb * clamp(r, 0.4, 1.7), rockAmt * near * 0.85);
    }
    if (sand * near > 0.01) {
      vec3 sa = detailTex(3, p / 11.0) / uDetailMean[3];
      alb *= mix(vec3(1.0), clamp(sa, 0.5, 1.4), sand * near * 0.8);
    }
    // painted roofs on the map give way to village ground near the 3D houses
    float roofish = village * smoothstep(0.02, 0.12, alb.r - alb.g) + village * smoothstep(0.02, 0.1, alb.b - alb.r - 0.02);
    vec3 yard = mix(srgb(vec3(0.72, 0.66, 0.50)), srgb(vec3(0.46, 0.62, 0.34)), nzs(p / 60.0));
    alb = mix(alb, yard, clamp(roofish, 0.0, 1.0) * (1.0 - smoothstep(700.0, 1600.0, dist)));
    // forest floor under the 3D trees: darker, cooler
    alb = mix(alb, alb * vec3(0.62, 0.72, 0.78), forest * 0.45 * (1.0 - smoothstep(500.0, 2200.0, dist)));
  }

  // --- key-art palette pass: livelier patchwork fields and meadows, grey-green cliffs (the painted strata leaned
  //     lavender-grey), warm beige sandbars and beaches instead of near-white (they read as foam from altitude) ---
  {
    float lA = dot(alb, vec3(0.2126, 0.7152, 0.0722));
    float satK = 1.0 + uPalette.x * clamp(field + meadow * 0.7, 0.0, 1.0) + uPalette.x * 0.35 * forest;
    alb = max(mix(vec3(lA), alb, satK), vec3(0.0));
    float rockK = clamp(max(rock, smoothstep(0.45, 0.7, slope)), 0.0, 1.0) * (1.0 - smoothstep(0.55, 0.8, lA));
    alb = mix(alb, alb * vec3(0.93, 1.03, 0.90), rockK * uPalette.y);
    alb = mix(alb, alb * vec3(1.03, 0.97, 0.83), clamp(sand, 0.0, 1.0) * uPalette.z);
  }

  // --- anime light: soft two-tone band, blue-violet shade, cloud shadows ---
  vec3 L = atmoSunDir;
  float ndl = dot(NB, L);
  float ndlF = dot(N, L);
  float cs = cloudShadow(vW);
  float band = smoothstep(-0.02, 0.16, ndl);
  float lit = band * mix(0.18, 1.0, cs);
  float lam = 0.6 + 0.4 * clamp(mix(ndl, ndlF, 0.55), 0.0, 1.0);
  vec3 sun = atmoSunColor * uLight;
  // two-tone anime light: the shade is the albedo darkened and hue-shifted to blue-violet (never grey/black),
  // the sun adds on top of it
  float lumA = dot(alb, vec3(0.299, 0.587, 0.114));
  vec3 shadeC = alb * uShade * (0.86 + 0.14 * N.y) + uSkyFill * (0.3 + lumA);
  vec3 col = shadeC + alb * sun * lit * lam * 0.30;
  // terminator warmth (a thin warm band where light turns to shade)
  col += alb * sun * 0.035 * (smoothstep(-0.02, 0.06, ndl) - smoothstep(0.06, 0.2, ndl)) * cs;
  // curvature: ridges lighter / warmer, gullies bluer
  col *= mix(vec3(1.0), curv > 0.0 ? vec3(0.86, 0.9, 1.04) : vec3(1.08, 1.05, 0.96), abs(curv) * 0.8);
  // backlit rim on ridges and crowns (sun behind the ridge)
  float rim = pow(1.0 - clamp(dot(NB, V), 0.0, 1.0), 4.0) * clamp(dot(-V, L) + 0.25, 0.0, 1.0);
  col += sun * alb * rim * 0.18 * (1.0 - sand);
  // wind sheen over meadows and fields (moving lighter bands, readable from altitude)
  vec2 wv = uWind * uTime;
  float g1 = nzs((vW.xz - wv) / 520.0 + 0.1), g2 = nzs((vW.xz - wv * 1.3) / 190.0 + 0.6);
  float gust = smoothstep(0.55, 0.85, g1 * 0.65 + g2 * 0.35);
  col = mix(col, col * vec3(1.16, 1.2, 1.04) + vec3(0.006, 0.01, 0.0), gust * (meadow + field * 0.7) * 0.55 * lit);
  // sparse cherry petals on the ground near groves
  col = mix(col, col * vec3(1.25, 0.92, 1.02), cherry * 0.25 * (1.0 - forest));

  if (uDebug > 1.5 && uDebug < 2.5) col = dbg4;       // wave-4 bank debug: r painted-water paint, g height above water / 3 m, b under water
  else if (uDebug > 2.5 && uDebug < 3.5) col = vec3(tileK, mapK, fp / 2.0);
  else if (uDebug > 0.5) {                             // LOD view: hue per level, morph as brightness
    float l = floor(vLod), m = fract(vLod);
    col = (0.5 + 0.5 * cos(6.2831 * (l / 7.0 + vec3(0.0, 0.33, 0.67)))) * (0.35 + 0.4 * (1.0 - m)) * (0.6 + 0.4 * lit);
  }
  col = worldMist(col, vW);
  col = atmoApply(col * atmoSurface, vW);      // (levels update: moonlit at night)
  col = worldFarFade(col, vW);                         // wave 5: the far terrain melts into the horizon apron
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
}

export const NO_SHADOW_CHUNK = /* glsl */`float cloudShadow(vec3 p) { return 1.0; }`;
// Stand-in when there is no cloud system at all (sandbox): large soft drifting shadows.
export const FAKE_SHADOW_CHUNK = /* glsl */`
float cloudShadow(vec3 p) {
  vec3 L = atmoSunDir;
  vec2 q = p.xz + L.xz / max(L.y, 0.1) * (950.0 - p.y);
  vec2 w = uWind * uTime;
  float n = texture(tWNoise, (q - w * 2.0) / 9000.0).r * 0.7 + texture(tWNoise, (q - w * 2.0) / 3100.0 + 0.4).r * 0.3;
  return 1.0 - 0.85 * smoothstep(0.58, 0.66, n);
}
`;
