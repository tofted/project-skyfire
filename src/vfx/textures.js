// Shared procedural VFX textures, generated once per renderer (no files):
//   noise: 256² RGBA8 tileable — R fbm value noise, G Worley cells (1 − F1), B second fbm (distortion), A hash
//   ramp:  64 × ROWS HalfFloat, linear HDR colour over "heat" (x = heat 0..1, 1 = white-hot), one row per palette
// Rows are shared by every fire/glow shader (particles, orbs) so a palette change is one edit here.
import * as THREE from 'three';
import { rng } from '../core/util.js';

export const ROW = {
  player: 0,      // Sora: classic anime fire — white-hot core → gold → orange → red (dark smoke)
  enemy: 1,       // Shade Riders and drakes: violet shadowfire — white-violet core → violet → deep indigo
  titan: 2,       // the Cloud Titan: molten gold → scarlet → crimson (matches its gold cracks and core)
  spark: 3,       // hot yellow-white sparks cooling to orange (player)
  steam: 4,       // white-blue (wisps, vapour, sea spray glow)
  flash: 5,       // warm white flash
  titanSpark: 6,  // molten-gold sparks cooling to crimson
  enemySpark: 7,  // white-violet sparks cooling to violet
  ace: 8,         // onyx ace: indigo-blue shadowfire (matches its indigo membranes)
  aceSpark: 9,    // white-blue sparks cooling to indigo
  inferno: 10,    // flight moves: Sora's inferno super breath and charged fireballs — white-gold heart → gold → orange
  // Levels and elements (Sora's fire changes with her level, game.progress.element):
  azure: 11,      // L3–4: blue-cyan flame with a white core
  azureSpark: 12, // white-cyan sparks cooling to blue
  radiant: 13,    // L5–6: white-gold flame (paler than the inferno's gold: amber rim → gold → cream → white)
  radiantSpark: 14,
  lightning: 15,  // L7+: lightning arcs, the bolt's orb, crackle — deep indigo → electric blue → cyan-white → white
  lightningSpark: 16,
  // levels update — L11+ (Prismfire): a rainbow over the five cel bands, rewritten every frame so the hues flow
  prism: 17,
  prismSpark: 18,
};
export const RAMP_ROWS = 19;

// Heat stops (heat, linear HDR rgb). Tuned for a neutral-style tone map: > 1 blooms, < 0.76 passes through.
// The flame shader samples 5 stepped bands at heat 0.3 / 0.475 / 0.65 / 0.825 / 1.0 (see particles.js), so each row
// is designed at those five points; body colours keep max channel ≲ 1.25, only the white-hot top blooms.
const RAMPS = [
  // player: warm black → dark red → red → orange → gold → pale yellow → white-hot
  [[0, 0.06, 0.025, 0.02], [0.15, 0.26, 0.03, 0.02], [0.32, 0.64, 0.07, 0.0], [0.52, 0.98, 0.27, 0.0], [0.74, 1.08, 0.64, 0.06], [0.9, 1.18, 0.98, 0.36], [1, 2.6, 2.3, 1.45]],
  // enemy (Shade Riders, drakes): indigo black → deep violet (#3a1a6a) → violet (#7a3fc4) → bright violet → magenta →
  // magenta-white core (wave 4: the soft shadowfire glows from a hot pink-white heart, not a lilac one)
  [[0, 0.02, 0.005, 0.05], [0.15, 0.04, 0.01, 0.14], [0.3, 0.07, 0.018, 0.25], [0.475, 0.2, 0.05, 0.56], [0.65, 0.46, 0.1, 0.92], [0.825, 0.95, 0.3, 1.18], [0.93, 1.4, 0.72, 1.45], [1, 2.8, 2.0, 2.9]],
  // titan: crimson black → deep crimson → crimson → scarlet → molten orange-gold → molten gold → white-gold
  // (one band redder than the player's at every step, and crimson keeps b > g where the player's red has g > b)
  [[0, 0.03, 0.0, 0.01], [0.15, 0.16, 0.005, 0.025], [0.32, 0.42, 0.015, 0.055], [0.52, 0.78, 0.05, 0.07], [0.7, 1.08, 0.28, 0.05], [0.86, 1.25, 0.72, 0.12], [1, 3.0, 2.3, 0.9]],
  // spark (player)
  [[0, 0.3, 0.05, 0.0], [0.3, 1.2, 0.28, 0.02], [0.6, 2.0, 1.0, 0.14], [1, 4.0, 3.2, 1.6]],
  // steam / wisp (display-referred whites, never bloom much)
  [[0, 0.42, 0.50, 0.72], [0.5, 0.80, 0.86, 0.98], [1, 1.02, 1.02, 1.05]],
  // flash
  [[0, 1.0, 0.45, 0.1], [0.5, 2.2, 1.6, 0.7], [1, 5.0, 4.6, 3.6]],
  // titan spark: crimson → molten gold → white-gold
  [[0, 0.5, 0.02, 0.04], [0.4, 2.0, 0.55, 0.06], [1, 4.4, 3.3, 1.2]],
  // enemy spark: violet → lilac → white-violet
  [[0, 0.22, 0.03, 0.55], [0.4, 0.95, 0.32, 2.0], [1, 3.2, 2.6, 4.6]],
  // ace (onyx): blue-black → indigo (#3f5fd0) → cornflower → pale blue → white-blue
  [[0, 0.01, 0.012, 0.05], [0.15, 0.015, 0.025, 0.14], [0.3, 0.02, 0.04, 0.3], [0.475, 0.05, 0.1, 0.62], [0.65, 0.12, 0.24, 0.95], [0.825, 0.36, 0.58, 1.18], [0.93, 0.72, 0.92, 1.3], [1, 1.7, 2.0, 2.9]],
  // ace spark
  [[0, 0.04, 0.1, 0.55], [0.4, 0.4, 0.85, 2.2], [1, 2.4, 3.2, 4.6]],
  // inferno (flight moves): warm black → deep orange → orange → gold-orange → gold → deep gold → white-gold. One band
  // hotter than Sora's normal fire at every step (no red band at all), so the super breath reads gold with orange
  // edges and a white-gold heart; the five cel bands land on orange, gold-orange, gold, deep gold and a blooming top.
  // (measured in the titan fight: pale-gold upper bands bloomed the whole body white — only the heart is white now)
  [[0, 0.08, 0.03, 0.01], [0.15, 0.42, 0.1, 0.0], [0.3, 0.98, 0.38, 0.02], [0.475, 1.1, 0.62, 0.04], [0.65, 1.18, 0.84, 0.12], [0.825, 1.24, 0.98, 0.28], [0.93, 1.6, 1.34, 0.56], [1, 3.0, 2.7, 1.85]],
  // azure (L3–4): blue-black → deep blue rim → azure → cyan → pale cyan → white-blue heart. The five cel bands land on
  // deep blue, azure, cyan-azure, pale cyan and a blooming white core (body channels ≤ 1.25, like the other rows).
  [[0, 0.01, 0.015, 0.06], [0.15, 0.015, 0.05, 0.24], [0.3, 0.03, 0.16, 0.62], [0.475, 0.06, 0.42, 1.04], [0.65, 0.17, 0.76, 1.16], [0.825, 0.55, 1.04, 1.22], [0.93, 1.05, 1.34, 1.42], [1, 2.3, 2.65, 2.95]],
  // azure spark: blue → cyan → white-cyan
  [[0, 0.02, 0.1, 0.5], [0.4, 0.3, 1.0, 2.2], [1, 2.6, 3.4, 4.4]],
  // radiant (L5–6): amber rim → gold → pale gold → cream → white. One band paler than the inferno's gold at every step,
  // so white-gold reads as a new element and not as the super breath; only the heart is white (a white body bloomed the
  // whole stream into a blob in the wave-6 titan fight).
  // (look-dev: the first, paler bands read as a flat beige on white clouds — the rim is amber now, the body steps
  // amber → gold → pale gold → cream-white, so the stream has contrast and a white heart)
  [[0, 0.07, 0.04, 0.01], [0.15, 0.36, 0.16, 0.02], [0.3, 0.98, 0.5, 0.06], [0.475, 1.14, 0.82, 0.16], [0.65, 1.2, 1.02, 0.4], [0.825, 1.25, 1.18, 0.82], [0.93, 1.8, 1.72, 1.4], [1, 3.2, 3.1, 2.8]],
  // radiant spark: gold → pale gold → white
  [[0, 0.6, 0.35, 0.05], [0.4, 2.0, 1.6, 0.6], [1, 4.2, 4.0, 3.4]],
  // lightning (L7+): deep blue edge → saturated cyan → pale cyan → white core (HDR: the core blooms hard).
  // (fix pass, playtester rank 1: the old electric blue-violet mid bands (b ≫ g, HDR) went lavender-white through the
  //  tone mapper's AgX highlight branch; cyan keeps g ≈ 0.6–0.75 of b, so the glows read cyan and bloom cyan)
  [[0, 0.0, 0.03, 0.18], [0.2, 0.01, 0.15, 0.55], [0.4, 0.03, 0.5, 0.95], [0.65, 0.1, 1.05, 1.5], [0.85, 0.7, 2.1, 2.7], [1, 3.4, 4.1, 4.5]],
  // lightning spark: cyan → pale cyan → white
  [[0, 0.02, 0.25, 0.8], [0.4, 0.2, 1.4, 2.2], [1, 3.2, 4.0, 4.4]],
  // prism / prism spark (levels update): the rows at phase 0 — updatePrism() rewrites them while the prism flame burns
  [[0, 0.05, 0.0, 0.08], [0.3, 1.0, 0.12, 0.8], [0.475, 0.2, 0.5, 1.2], [0.65, 0.15, 1.1, 0.6], [0.825, 1.2, 1.0, 0.2], [1, 3.1, 3.0, 3.1]],
  [[0, 0.6, 0.1, 0.7], [0.4, 0.6, 1.6, 2.0], [1, 4.0, 4.0, 4.2]],
];

/** Linear RGB of a hue (turns, 0..1) at saturation s and value v — a soft rainbow (no pure primaries: they cel-band badly). */
function hueRGB(h, s, v, out) {
  const k = (n) => { const x = (n + h * 6) % 6; return v - v * s * Math.max(0, Math.min(x, 4 - x, 1)); };
  out[0] = k(5); out[1] = k(3); out[2] = k(1);
  return out;
}
const _rgb = [0, 0, 0], _top = [0, 0, 0];
/**
 * Levels update — rewrite the prism rows for time t (s): the flame's five cel bands step through the rainbow (rim
 * magenta → blue → green → gold at phase 0, a white-hot heart always) and the whole spectrum drifts at `speed`
 * turns / s, so the fire flows through every colour. 2 × 64 texels; the upload is the whole 64 × 19 ramp (4.8 kB).
 */
export function updatePrism(tex, t, speed = 0.11) {
  const ramp = tex?.ramp, data = ramp?.image?.data;
  if (!data) return;
  const W = 64, H = THREE.DataUtils.toHalfFloat, ph = (t * speed) % 1;
  for (let i = 0; i < W; i++) {
    const h = i / (W - 1);
    // body: hue falls from magenta at the rim to gold near the heart; value rises with heat; the top blooms white
    const hue = (0.86 - h * 0.78 + ph + 1) % 1;
    const v = 0.06 + 1.14 * Math.min(1, h / 0.82), s = 0.9 - 0.3 * h;
    hueRGB(hue, s, Math.min(1.22, v), _rgb);
    // the heart is not white: a bright pastel of the hue half a turn on (HDR, so the beam and the core line bloom in
    // colour and the whole breath changes colour as the spectrum drifts)
    const top = Math.max(0, (h - 0.88) / 0.12), tt = top * top;
    hueRGB((ph + 0.36) % 1, 0.62, 1, _top);
    const tr = 0.55 + 2.7 * _top[0], tg = 0.55 + 2.7 * _top[1], tb = 0.55 + 2.7 * _top[2];
    let o = (ROW.prism * W + i) * 4;
    data[o] = H(_rgb[0] + (tr - _rgb[0]) * tt); data[o + 1] = H(_rgb[1] + (tg - _rgb[1]) * tt); data[o + 2] = H(_rgb[2] + (tb - _rgb[2]) * tt);
    // sparks: brighter, the same hue a quarter turn on
    hueRGB((hue + 0.25) % 1, 0.75 - 0.5 * h, 0.5 + 2.4 * h, _rgb);
    o = (ROW.prismSpark * W + i) * 4;
    data[o] = H(_rgb[0] + 1.4 * h * h); data[o + 1] = H(_rgb[1] + 1.4 * h * h); data[o + 2] = H(_rgb[2] + 1.4 * h * h);
  }
  ramp.needsUpdate = true;
}
/** The prism's colour right now (linear, ~unit) for lights: the body hue at mid heat. */
export function prismColor(t, out, speed = 0.11) {
  hueRGB((0.36 + ((t * speed) % 1)) % 1, 0.7, 1, _rgb);
  return out.setRGB(_rgb[0], _rgb[1], _rgb[2]);
}

const cache = new WeakMap();

export function getTextures(game) {
  if (cache.has(game)) return cache.get(game);
  const tex = { noise: makeNoise(), ramp: makeRamp(), rows: RAMP_ROWS };
  cache.set(game, tex);
  return tex;
}

function makeRamp() {
  const W = 64, H = RAMP_ROWS;
  const data = new Uint16Array(W * H * 4);
  for (let r = 0; r < H; r++) {
    const stops = RAMPS[r] || RAMPS[0];
    for (let i = 0; i < W; i++) {
      const h = i / (W - 1);
      let k = 0;
      while (k < stops.length - 2 && h > stops[k + 1][0]) k++;
      const a = stops[k], b = stops[k + 1];
      const t = THREE.MathUtils.clamp((h - a[0]) / Math.max(1e-6, b[0] - a[0]), 0, 1);
      const o = (r * W + i) * 4;
      for (let c = 0; c < 3; c++) data[o + c] = THREE.DataUtils.toHalfFloat(a[c + 1] + (b[c + 1] - a[c + 1]) * t);
      data[o + 3] = THREE.DataUtils.toHalfFloat(1);
    }
  }
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

function makeNoise() {
  const N = 256;
  const data = new Uint8Array(N * N * 4);
  const r = rng(7331);
  // Tileable value noise: lattice of size `cells` wrapped.
  const lattice = (cells, seed) => {
    const rr = rng(seed);
    const g = new Float32Array(cells * cells);
    for (let i = 0; i < g.length; i++) g[i] = rr();
    return (x, y) => {           // x,y in cell units
      const xi = Math.floor(x), yi = Math.floor(y);
      const xf = x - xi, yf = y - yi;
      const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
      const x0 = ((xi % cells) + cells) % cells, y0 = ((yi % cells) + cells) % cells;
      const x1 = (x0 + 1) % cells, y1 = (y0 + 1) % cells;
      const a = g[y0 * cells + x0], b = g[y0 * cells + x1], c = g[y1 * cells + x0], d = g[y1 * cells + x1];
      return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    };
  };
  const octA = [lattice(4, 11), lattice(8, 12), lattice(16, 13), lattice(32, 14), lattice(64, 15)];
  const octB = [lattice(4, 21), lattice(8, 22), lattice(16, 23), lattice(32, 24)];
  const fbm = (oct, x, y) => {
    let s = 0, a = 0.5, n = 0, c = 4;
    for (const f of oct) { s += a * f((x / N) * c, (y / N) * c); n += a; a *= 0.5; c *= 2; }
    return s / n;
  };
  // Worley F1 on an 8×8 wrapped grid.
  const C = 8, pts = [];
  for (let i = 0; i < C * C; i++) pts.push([r(), r()]);
  const worley = (x, y) => {
    const cx = (x / N) * C, cy = (y / N) * C;
    const ix = Math.floor(cx), iy = Math.floor(cy);
    let best = 9;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const gx = ix + ox, gy = iy + oy;
      const p = pts[(((gy % C) + C) % C) * C + (((gx % C) + C) % C)];
      const dx = gx + p[0] - cx, dy = gy + p[1] - cy;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const o = (y * N + x) * 4;
    const a = fbm(octA, x, y), b = fbm(octB, x + 71, y + 37);
    // Contrast-stretch fbm (it clusters around 0.5) so erosion thresholds bite.
    data[o] = clamp255((a - 0.5) * 2.1 + 0.5);
    data[o + 1] = clamp255(1 - worley(x, y) * 1.25);
    data[o + 2] = clamp255((b - 0.5) * 2.1 + 0.5);
    data[o + 3] = Math.floor(r() * 256);
  }
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}
const clamp255 = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
