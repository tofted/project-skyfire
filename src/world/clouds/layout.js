// Deterministic cloud layout shared by the GPU renderer and the CPU twin (game.world.cloudDensity).
//   Towers: towering cumulus / cumulonimbus as smooth unions of ellipsoid lobes with flat bases (baked to a 3D SDF).
//   Deck:   a broken stratocumulus slab driven by a 2D map (cell value, thickness, base offset), equalised so the
//           shader's `coverage` uniform is the real covered fraction of the combat area.
// Both volumes use a log warp on x/z (fine near the origin, coarse toward the horizon) so one texture reaches 40–60 km.
import { rng, clamp, smoothstep, fbm2 } from '../../core/util.js';

export const FIELD = { L: 8000, R: 40000, nx: 384, ny: 64, yMin: 600, yMax: 3800, clampMin: -600, clampMax: 3000 };
// Wave 4: every tower (crown bulges included) stays this far below FIELD.yMax, so no crown is clipped flat.
const TOP_MARGIN = 260;
// Wave 4: smooth maximum radius (m) of the flat cumulus base: a rounded bottom edge instead of a sharp cut.
export const BASE_ROUND = 70;
FIELD.S = FIELD.L * Math.log1p(FIELD.R / FIELD.L);
export const WEATHER = { L: 8000, R: 60000, n: 512 };
WEATHER.S = WEATHER.L * Math.log1p(WEATHER.R / WEATHER.L);
export const DECK = { base: 700, thick: 620, coverage: 0.45, baseVar: 160 };
// Clear pocket in the deck around the start position and the title circuit (actors/player.js START / title autopilot).
export const SPAWN_GAP = { x: -1250, z: -2150, r0: 1000, r1: 3000 };
DECK.topMax = DECK.base + DECK.baseVar * 0.5 + DECK.thick;   // highest possible deck top before erosion
// Noise erosion amplitudes (metres) and density edge; the shader reads the same numbers.
export const NOISE = { shapeAmp: 165, detailAmp: 72, edge: 36, shapeTile: 2200, detailTile: 380, bias: 0.5,
  // Wave 4: near-field cauliflower puffs (37/19/9 m cells, ±13 m) within ~700 m of the camera; far towers' big billows
  // grow up to 1 + farGrow times (amplitude) with distance (4 -> 24 km).
  nearAmp: 26, nearTile: 150, nearFar: 700, farGrow: 1.5 };
// Measured on the GPU (gpuSample inside towers): the sphere-shaped billows average 0.79, i.e. the erosion grows
// surfaces by ~48 m on average. The CPU twin adds this mean so both agree.
NOISE.mean = 0.79;

export const warp = (v, L) => Math.sign(v) * L * Math.log1p(Math.abs(v) / L);
export const unwarp = (s, L) => Math.sign(s) * L * Math.expm1(Math.abs(s) / L);

// ---------------------------------------------------------------------------------------------------------------
// Towers

/** One tower = list of ellipsoids [x, y, z, rx, ry, rz] + base plane + smooth-union radius. */
function buildTower(r, o) {
  const sph = [];
  const H = o.top - o.base;
  const R0 = o.radius;
  const add = (x, y, z, rx, ry, rz) => sph.push([x, y, z, rx, ry ?? rx, rz ?? rx]);
  const leanX = o.lean?.x ?? 0, leanZ = o.lean?.z ?? 0;
  const axis = (t) => [o.x + leanX * t * H, o.z + leanZ * t * H];

  // Foot: squat lobes that sit on the base plane and melt into the deck. Wave 4: centred higher (0.62 of their
  // half-height above the base) so the flat base cuts their lower caps -> the sides curve in toward the base
  // (tapered, rounded foot) instead of a vertical wall cut flat ("cylinder-cut" towers).
  const nFoot = 6 + Math.floor(r() * 3);
  for (let i = 0; i < nFoot; i++) {
    const a = (i / nFoot) * Math.PI * 2 + r() * 0.7;
    const d = R0 * (0.35 + 0.35 * r());
    const rr = R0 * (0.38 + 0.2 * r());
    add(o.x + Math.cos(a) * d * 0.9, o.base + rr * 0.82 * 0.62, o.z + Math.sin(a) * d * 0.9, rr, rr * 0.82, rr);
  }

  // Body: stacked levels of a core lobe and 3–5 side lobes. Width swells a little, then tapers into the head.
  const phase = r() * 6.28;
  let y = o.base + R0 * 0.55;
  let lastW = R0;
  let guard = 0;
  while (guard++ < 40) {
    const t = (y - o.base) / H;
    if (t > 0.93) break;
    const swell = 0.92 + 0.16 * Math.sin(t * 7.5 + phase) + 0.12 * Math.sin(t * 3.1 + phase * 2);
    const w = R0 * swell * (1 - 0.58 * Math.pow(t, 1.6)) * (o.slim ?? 1);
    const [cx, cz] = axis(t);
    add(cx, y, cz, w * 0.78, w * 0.74, w * 0.78);
    const k = 3 + Math.floor(r() * 3);
    const a0 = r() * 6.28;
    for (let j = 0; j < k; j++) {
      const a = a0 + (j / k) * Math.PI * 2 + (r() - 0.5) * 0.9;
      const d = w * (0.42 + 0.3 * r());
      const rr = w * (0.38 + 0.26 * r());
      add(cx + Math.cos(a) * d, y + (r() - 0.35) * w * 0.5, cz + Math.sin(a) * d, rr, rr * (0.85 + 0.2 * r()), rr);
    }
    // Occasional turret: a side column that climbs a little and ends in its own cauliflower dome.
    if (t > 0.35 && t < 0.8 && r() < 0.28) {
      const a = r() * 6.28;
      const d = w * 0.62;
      const tw = w * (0.42 + 0.15 * r());
      let ty = y;
      for (let q = 0; q < 3; q++) {
        add(cx + Math.cos(a) * d, ty, cz + Math.sin(a) * d, tw * (1 - q * 0.12));
        ty += tw * 0.7;
      }
      for (let q = 0; q < 3; q++) {
        const b = r() * 6.28;
        add(cx + Math.cos(a) * d + Math.cos(b) * tw * 0.4, ty - tw * 0.2, cz + Math.sin(a) * d + Math.sin(b) * tw * 0.4, tw * 0.55);
      }
    }
    lastW = w;
    y += w * (0.46 + 0.18 * r());
  }

  // Head: cauliflower dome of lobes on the upper hemisphere, the tallest one reaching `top`.
  const [hx, hz] = axis(1);
  const hw = lastW * 0.95;
  const hy = o.top - hw * 0.55;
  add(hx, hy, hz, hw * 0.62);
  const nHead = 5 + Math.floor(r() * 4);
  for (let i = 0; i < nHead; i++) {
    const a = r() * 6.28;
    const el = 0.25 + r() * 0.9;
    const d = hw * (0.35 + 0.25 * r());
    const rr = hw * (0.3 + 0.2 * r());
    add(hx + Math.cos(a) * Math.cos(el) * d, hy + Math.sin(el) * d * 0.6, hz + Math.sin(a) * Math.cos(el) * d, rr);
  }

  // Cumulonimbus anvil: a wide, flat shelf spreading downwind at the top.
  if (o.anvil) {
    const dir = o.anvil.dir ?? 0;
    const spread = R0 * (o.anvil.spread ?? 2.2);
    for (let i = 0; i < 11; i++) {
      const f = i / 10;
      const a = dir + (r() - 0.5) * 1.6;
      const d = spread * (0.1 + 0.8 * f);
      const rr = R0 * (0.55 + 0.35 * r()) * (1 - 0.3 * f);
      add(hx + Math.cos(a) * d, o.top - R0 * 0.3 + (r() - 0.5) * R0 * 0.25 - f * R0 * 0.15, hz + Math.sin(a) * d, rr, rr * (0.35 + 0.15 * r()), rr);
    }
  }

  // Cauliflower: a second level of bulges on the upper / outer surface of every lobe (not the flat foot).
  const nCore = sph.length;
  for (let i = 0; i < nCore; i++) {
    const [px, py, pz, rx, ry] = sph[i];
    if (rx < R0 * 0.18) continue;
    const ax = px - o.x, az = pz - o.z;
    const al = Math.hypot(ax, az) || 1;
    const nb = 3 + Math.floor(r() * 3);
    for (let j = 0; j < nb; j++) {
      // Direction: mostly upward and away from the column axis.
      let dx = (r() - 0.5) * 2 + (ax / al) * 0.8, dy = 0.15 + r() * 0.95, dz = (r() - 0.5) * 2 + (az / al) * 0.8;
      const dl = Math.hypot(dx, dy, dz); dx /= dl; dy /= dl; dz /= dl;
      const br = rx * (0.3 + 0.16 * r());
      const d = 0.78 + 0.12 * r();
      add(px + dx * rx * d, py + dy * ry * d, pz + dz * rx * d, br, br * 0.92, br);
    }
  }

  // Wave 4: fit the whole tower (crown bulges included) under the SDF field ceiling (FIELD.yMax - TOP_MARGIN):
  // taller lobes were clipped flat by the field's y range ("bricks with flat tops", flat anvil shelves). Heights
  // above the base are scaled, so the domed crown keeps its shape.
  const yCap = FIELD.yMax - TOP_MARGIN;
  let yTop = -Infinity;
  for (const s of sph) yTop = Math.max(yTop, s[1] + s[4]);
  if (yTop > yCap) {
    const f = (yCap - o.base) / (yTop - o.base);
    for (const s of sph) { s[1] = o.base + (s[1] - o.base) * f; s[4] *= f; }
  }
  // Bounds (with the smooth-union bulge margin).
  const k = o.k ?? R0 * 0.14;
  const min = [Infinity, o.base, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const s of sph) {
    min[0] = Math.min(min[0], s[0] - s[3]); max[0] = Math.max(max[0], s[0] + s[3]);
    max[1] = Math.max(max[1], s[1] + s[4]);
    min[2] = Math.min(min[2], s[2] - s[5]); max[2] = Math.max(max[2], s[2] + s[5]);
  }
  for (let i = 0; i < 3; i++) { min[i] -= k; max[i] += k; }
  min[1] = o.base - 1;
  return { ...o, spheres: sph, k, min, max, H };
}

/** The art-directed layout: 12 towers around the combat area (clear pocket at the spawn) + a far ring. */
export function buildLayout(seed = 7) {
  const r = rng(seed);
  const near = [
    // x, z, top, radius, extra — the start is (−1500, 1350, −2600) heading 32° (toward +x+z), the title circuit
    // r 850 m around (−1200, −1900); the sun sits toward (−x, −z) (azimuth −145°, elevation 38°), so no tower may
    // stand sunward of that area within ~5 km (its shadow would grey the first view) or within ~2.3 km of it.
    [2700, -1000, 3300, 850, { lean: { x: 0.08, z: 0.03 } }],
    [3900, 1700, 2650, 700, {}],
    [5600, -2900, 3500, 1050, { anvil: { dir: 0.4, spread: 2.0 } }],
    [1300, 2800, 2250, 620, {}],
    [-1900, 2600, 2950, 780, {}],
    [-2750, -7240, 3050, 820, { lean: { x: 0.05, z: 0.06 } }],   // 20° off the sun line from the start: backlit, shadow misses the start
    [-4900, 1900, 2450, 700, {}],
    [700, -3800, 2800, 760, {}],
    [4600, 4300, 3250, 880, {}],
    [-900, 5300, 2550, 700, {}],
    [-5800, -3600, 3400, 1000, { anvil: { dir: 0.7, spread: 1.8 } }],
    [6400, 500, 2350, 660, {}],
  ];
  const towers = [];
  for (const [x, z, top, radius, extra] of near) {
    const base = DECK.base - 20 + r() * 60;
    towers.push(buildTower(r, { x: x + (r() - 0.5) * 200, z: z + (r() - 0.5) * 200, base, top, radius: radius * 1.25, ...extra }));
  }
  // Far ring (outside the playable radius): towering cumulus toward the horizon. Wave 4: they were 2.6–7 km wide
  // blocks only 0.5–0.9 as tall as wide (one body level + a head clipped by the field ceiling) -> "bricks". Now
  // 1.9–3.4 km wide and taller than wide (several swelling body levels, cauliflower crown), a slight lean downwind.
  const nFar = 16;
  for (let i = 0; i < nFar; i++) {
    const a = (i / nFar) * Math.PI * 2 + (r() - 0.5) * 0.3;
    const d = 11000 + r() * 20000;
    const radius = 820 + r() * 520;
    const top = 2850 + r() * 650;
    const anvil = r() < 0.25 ? { dir: r() * 6.28, spread: 1.5 } : null;
    towers.push(buildTower(r, {
      x: Math.cos(a) * d, z: Math.sin(a) * d, base: DECK.base - 20 + r() * 80, top, radius, anvil, far: true,
      lean: { x: 0.05, z: 0.015 }, k: radius * 0.11,
    }));
  }
  return { towers, weather: buildWeather(towers, seed + 101) };
}

// ---------------------------------------------------------------------------------------------------------------
// Deck map

function buildWeather(towers, seed) {
  const n = WEATHER.n;
  const val = new Float32Array(n * n);
  const r = rng(seed);
  const ox = r() * 1000, oz = r() * 1000;
  for (let j = 0; j < n; j++) {
    const z = unwarp(((j + 0.5) / n - 0.5) * 2 * WEATHER.S, WEATHER.L);
    for (let i = 0; i < n; i++) {
      const x = unwarp(((i + 0.5) / n - 0.5) * 2 * WEATHER.S, WEATHER.L);
      const big = fbm2(x / 4200 + ox, z / 4200 + oz, 4);
      const mid = fbm2(x / 1300 + ox * 2, z / 1300 + oz * 2, 3);
      let v = big * 0.62 + mid * 0.38;
      const rr = Math.hypot(x, z);
      // Start / title circuit: the valley shows through a ragged gap under it (the key-art view).
      const rs = Math.hypot(x - SPAWN_GAP.x, z - SPAWN_GAP.z);
      v -= 0.3 * (1 - smoothstep(SPAWN_GAP.r0, SPAWN_GAP.r1, rs));
      // Cloud sea thickens toward the horizon.
      v += 0.09 * smoothstep(9000, 22000, rr);
      // Tower skirts: the deck swells around tower feet.
      for (const t of towers) {
        const d = Math.hypot(x - t.x, z - t.z) / (t.radius * 1.8);
        if (d < 2.5) v += 0.12 * Math.exp(-d * d);
      }
      val[j * n + i] = v;
    }
  }
  // Equalise over the combat area so `coverage` = covered fraction there.
  const inner = [];
  for (let j = 0; j < n; j += 2) for (let i = 0; i < n; i += 2) {
    const x = unwarp(((i + 0.5) / n - 0.5) * 2 * WEATHER.S, WEATHER.L), z = unwarp(((j + 0.5) / n - 0.5) * 2 * WEATHER.S, WEATHER.L);
    if (x * x + z * z < 8000 * 8000) inner.push(val[j * n + i]);
  }
  inner.sort((a, b) => a - b);
  const q = (v) => {                                   // empirical CDF (binary search), extrapolated beyond
    let lo = 0, hi = inner.length - 1;
    if (v <= inner[0]) return 0;
    if (v >= inner[hi]) return 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (inner[m] <= v) lo = m; else hi = m; }
    return lo / (inner.length - 1);
  };
  const data = new Uint8Array(n * n * 4);
  const rt = rng(seed + 5);
  const tox = rt() * 1000, toz = rt() * 1000;
  for (let j = 0; j < n; j++) {
    const z = unwarp(((j + 0.5) / n - 0.5) * 2 * WEATHER.S, WEATHER.L);
    for (let i = 0; i < n; i++) {
      const x = unwarp(((i + 0.5) / n - 0.5) * 2 * WEATHER.S, WEATHER.L);
      const k = (j * n + i) * 4;
      data[k] = Math.round(clamp(q(val[j * n + i]), 0, 1) * 255);
      data[k + 1] = Math.round(clamp(fbm2(x / 2600 + tox, z / 2600 + toz, 3) * 1.6 - 0.3, 0, 1) * 255);   // thickness
      data[k + 2] = Math.round(clamp(fbm2(x / 3400 + toz, z / 3400 + tox, 2), 0, 1) * 255);                // base offset
      data[k + 3] = Math.round(domes(warp(x, WEATHER.L), warp(z, WEATHER.L), seed) * 255);
    }
  }
  return { n, data };
}

// Field of round cumulus humps (max of hemispheres on a jittered grid) in warped space, so humps grow with
// distance at the same rate as the texels. 0..1.
function hash2i(i, j, s) {
  let h = (i * 374761393 + j * 668265263 + s * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function domes(sx, sz, seed) {
  const D = 520;
  const ci = Math.floor(sx / D), cj = Math.floor(sz / D);
  let best = 0;
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    const i = ci + di, j = cj + dj;
    const px = (i + 0.15 + 0.7 * hash2i(i, j, seed)) * D, pz = (j + 0.15 + 0.7 * hash2i(i, j, seed + 7)) * D;
    const R = D * (0.55 + 0.35 * hash2i(i, j, seed + 13));
    const hgt = 0.55 + 0.45 * hash2i(i, j, seed + 29);
    const d2 = ((sx - px) ** 2 + (sz - pz) ** 2) / (R * R);
    if (d2 < 1) best = Math.max(best, hgt * Math.sqrt(1 - d2));
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// CPU twin — same envelope maths as the GPU (see shaders.js), without the noise erosion (±100 m band).

export function sdEllipsoid(px, py, pz, rx, ry, rz) {
  const ax = px / rx, ay = py / ry, az = pz / rz;
  const k0 = Math.sqrt(ax * ax + ay * ay + az * az);
  const bx = px / (rx * rx), by = py / (ry * ry), bz = pz / (rz * rz);
  const k1 = Math.sqrt(bx * bx + by * by + bz * bz);
  return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(rx, ry, rz);
}
export function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
export const smax = (a, b, k) => -smin(-a, -b, k);

/** Signed distance (m, <0 inside) to the union of tower envelopes. */
export function towerSdf(towers, x, y, z) {
  let d = FIELD.clampMax;
  for (const t of towers) {
    const qx = Math.max(t.min[0] - x, x - t.max[0], 0);
    const qy = Math.max(t.min[1] - y, y - t.max[1], 0);
    const qz = Math.max(t.min[2] - z, z - t.max[2], 0);
    const box = Math.sqrt(qx * qx + qy * qy + qz * qz);
    if (box > 800) { if (box < d) d = box; continue; }
    let dt = 1e5;
    for (const s of t.spheres) dt = smin(dt, sdEllipsoid(x - s[0], y - s[1], z - s[2], s[3], s[4], s[5]), t.k);
    dt = smax(dt, t.base - y, BASE_ROUND);          // flat base with a rounded edge (same as FIELD_FS)
    if (dt < d) d = dt;
  }
  return clamp(d, FIELD.clampMin, FIELD.clampMax);
}

/** Bilinear lookup of the deck map at world x/z, returns [cell, thickness, baseOffset, dome] in 0..1 (like the GPU). */
export function sampleWeather(w, x, z, out = [0, 0, 0, 0]) {
  const n = w.n;
  const u = (warp(x, WEATHER.L) / (2 * WEATHER.S) + 0.5) * n - 0.5;
  const v = (warp(z, WEATHER.L) / (2 * WEATHER.S) + 0.5) * n - 0.5;
  const i0 = clamp(Math.floor(u), 0, n - 1), j0 = clamp(Math.floor(v), 0, n - 1);
  const i1 = Math.min(i0 + 1, n - 1), j1 = Math.min(j0 + 1, n - 1);
  const fu = clamp(u - i0, 0, 1), fv = clamp(v - j0, 0, 1);
  const d = w.data;
  for (let c = 0; c < 4; c++) {
    const a = d[(j0 * n + i0) * 4 + c], b = d[(j0 * n + i1) * 4 + c];
    const e = d[(j1 * n + i0) * 4 + c], f = d[(j1 * n + i1) * 4 + c];
    out[c] = ((a + (b - a) * fu) * (1 - fv) + (e + (f - e) * fu) * fv) / 255;
  }
  return out;
}

/** Metres inside the deck (>0 inside). Mirrors deckInside() in the shader. */
export function deckInside(wv, y, coverage) {
  const cov = (wv[0] - (1 - coverage)) / Math.max(coverage, 0.05);
  const base = DECK.base + (wv[2] - 0.5) * DECK.baseVar;
  const cell = cov > 0 ? Math.sqrt(cov) : cov * 2;
  const body = cell * (0.8 + 0.4 * wv[1]);
  const fill = body > 0 ? 1 - Math.exp(-body * 1.9) : body;          // soft clamp (no flat plateau), as the GPU
  const top = base + DECK.thick * fill * (0.5 + 0.5 * wv[3]);
  return Math.min(top - y, (y - base) * 1.5);
}
