// game.vegetation — forests, cherry groves, villages and landmarks of the valley.
//   Trees: 3 species (broadleaf, cedar/pine, cherry) × 2 LODs (near ≤ ~700 m, far blobs to ~4 km × quality) as
//   instanced meshes (6 draw calls). Placement is generated per 512 m tile from the painted map's class masks
//   (forest, cherry, fields, villages, rock, water) inside the valley, and from the same procedural rules the terrain
//   shader paints with outside it. Far tiles keep only their most important trees (scaled up) — the painted canopy of
//   the terrain carries the rest. Wind sway shares terrain.wind.
//   Villages: ~4 000 houses from the map's painted roofs + a coastal town at the river mouth (3 instanced kits).
//   Landmarks (world.json): multi-arch vermilion bridge, three pagodas, torii gates (two standing in lakes), a hilltop
//   shrine. Petals drift near cherry groves when the camera is low.
// Respects game.quality.vegetation (density and range). Public: vegetation.stats, vegetation.landmarks (by name).
import * as THREE from 'three';
import { rng, clamp, smoothstep } from '../core/util.js';
import { propMaterial } from './veg/common.js';
import { SPECIES } from './veg/trees.js';
import { houseKits, pagoda, torii, bridge, shrine } from './veg/buildings.js';
import { assetUrl } from './terrain/data.js';
import { createPetals } from './veg/petals.js';
import { UNDER } from './veg/undergrowth.js';
import { WAVE4 } from './terrain.js';

// Wave 4: distance to the nearest water (metres) on a coarse grid: the map square at 16 m (from the 8 m inner grid),
// the whole world at 32 m. Two-pass chamfer distance, capped at 400 m. Drives bank reeds, bank scrub and the
// riparian groves (trees ×3–5 within ~120 m of the water).
function shoreField(hw, n, texel, down) {
  const m = Math.floor(n / down), cell = texel * down, INF = 1e9;
  const d = new Float32Array(m * m).fill(INF);
  for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
    let wet = false;
    for (let b = 0; b < down && !wet; b++) for (let a = 0; a < down; a++) {
      const k = ((j * down + b) * n + (i * down + a)) * 2;
      if (hw[k + 1] - hw[k] > 0.05) { wet = true; break; }
    }
    if (wet) d[j * m + i] = 0;
  }
  const D = Math.SQRT2;
  for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
    const k = j * m + i; let v = d[k];
    if (i > 0) v = Math.min(v, d[k - 1] + 1);
    if (j > 0) { v = Math.min(v, d[k - m] + 1); if (i > 0) v = Math.min(v, d[k - m - 1] + D); if (i < m - 1) v = Math.min(v, d[k - m + 1] + D); }
    d[k] = v;
  }
  for (let j = m - 1; j >= 0; j--) for (let i = m - 1; i >= 0; i--) {
    const k = j * m + i; let v = d[k];
    if (i < m - 1) v = Math.min(v, d[k + 1] + 1);
    if (j < m - 1) { v = Math.min(v, d[k + m] + 1); if (i < m - 1) v = Math.min(v, d[k + m + 1] + D); if (i > 0) v = Math.min(v, d[k + m - 1] + D); }
    d[k] = v;
  }
  for (let k = 0; k < d.length; k++) d[k] = Math.min(400, d[k] * cell);
  return { d, m, cell };
}

const TILE = 512;

async function loadMask(name) {
  try {
    const res = await fetch(assetUrl(name));
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    return { n: bmp.width, d };
  } catch (e) {
    console.warn('[vegetation] mask missing', name, e);
    return null;
  }
}

export default function createVegetation(game) {
  const veg = {
    name: 'vegetation',
    stats: { tiles: 0, near: 0, far: 0, houses: 0, landmarks: 0, genMs: 0 },
    landmarks: {},
    meshes: {},
  };
  const tiles = new Map();          // key -> { species: [{ data: Float32Array(8·n), n }], y0, y1 }
  let masks = null, data = null, info = null;
  let q = 1, D0 = 700, DMAX = 4000, SPACING = 10;
  const XW = 45;                    // half width of the near/far dither crossfade (m)
  const XM = XW + 40;               // CPU margin around the switch: the lists are rebuilt every 25 m of travel
  const lists = {};                 // `${species}:${lod}` -> { mesh, pos, rot, cap }
  const frustum = new THREE.Frustum(), mat4 = new THREE.Matrix4(), box = new THREE.Box3();
  const lastCam = new THREE.Vector3(1e9, 0, 0), lastDir = new THREE.Vector3();
  let lastSig = '';
  const genQueue = [];
  let shoreIn = null, shoreOut = null;
  const USPEC = ['reed', 'bush'];
  const EMPTY_UNDER = USPEC.map(() => ({ data: new Float32Array(0), n: 0 }));
  const underQueue = [];
  let URANGE = [720, 980];          // near range of reeds / bushes (m); they shrink away over the last quarter
  /** Distance (m) from (x, z) to the nearest water, 16 m cells inside the map, 32 m outside; 400 = far. */
  function shoreDist(x, z) {
    const f = shoreIn && Math.abs(x) < data.halfIn - 32 && Math.abs(z) < data.halfIn - 32 ? shoreIn : shoreOut;
    if (!f) return 400;
    const half = f === shoreIn ? data.halfIn : data.halfOut;
    const i = Math.floor((x + half) / f.cell), j = Math.floor((z + half) / f.cell);
    if (i < 0 || j < 0 || i >= f.m || j >= f.m) return 400;
    return f.d[j * f.m + i];
  }
  veg.shoreDist = shoreDist;
  veg.underBudget = 2;              // ms per frame for the lazy undergrowth (0 pauses it; tests / A/B only)
  /** Benchmark hook (read-only): generate a tile without caching it; returns ms. */
  veg.timeTile = (i, j) => { const t0 = performance.now(); genTile(i, j); const t1 = performance.now(); if (WAVE4) genUnder(i, j, i * TILE, j * TILE); return [t1 - t0, performance.now() - t1]; };

  // ---- placement ----------------------------------------------------------------------------------------------
  const sampleMask = (m, x, z, ch) => {
    if (!m) return 0;
    const half = data.halfIn, n = m.n;
    const u = (x + half) / (2 * half) * n - 0.5, v = (z + half) / (2 * half) * n - 0.5;
    if (u < 0 || v < 0 || u > n - 1 || v > n - 1) return 0;
    const i = Math.floor(u), j = Math.floor(v), tu = u - i, tv = v - j;
    const i1 = Math.min(i + 1, n - 1), j1 = Math.min(j + 1, n - 1);
    const a = m.d[(j * n + i) * 4 + ch], b = m.d[(j * n + i1) * 4 + ch], c = m.d[(j1 * n + i) * 4 + ch], d = m.d[(j1 * n + i1) * 4 + ch];
    return ((a + (b - a) * tu) * (1 - tv) + (c + (d - c) * tu) * tv) / 255;
  };
  // CPU twin of the terrain shader's outer forest rule (paintOuter)
  const noiseTex = () => game.terrain.data;
  function outerForest(x, z, h) {
    const d = noiseTex();
    const n1 = d.detail ? sampleNoise(x / 5600 + 0.21, z / 5600 + 0.21) : 0.5;
    const r = d.rough(x, z);
    const P = clamp((r - 2) / 40, 0, 1);
    const e = 28;
    const gx = (d.heightAt(x + e, z) - d.heightAt(x - e, z)) / (2 * e), gz = (d.heightAt(x, z + e) - d.heightAt(x, z - e)) / (2 * e);
    const ny = 1 / Math.hypot(gx, 1, gz), slope = 1 - ny;
    const farm = smoothstep(0.46, 0.56, sampleNoise(x / 4000 + 0.13, z / 4000 + 0.13)) * smoothstep(0.1, 0.04, slope) * smoothstep(180, 70, h) * (1 - smoothstep(0.08, 0.2, P));
    return smoothstep(0.30, 0.52, n1 + 0.25 * P) * smoothstep(1750, 1350, h) * smoothstep(0.55, 0.25, slope) * smoothstep(1.5, 4.0, h) * (1 - farm);
  }
  let noiseArr = null, noiseN = 256;
  function sampleNoise(u, v) {
    if (!noiseArr) { noiseArr = game.terrain.data.textures.noise.image.data; noiseN = game.terrain.data.textures.noise.image.width; }
    const n = noiseN, x = u * n - 0.5, y = v * n - 0.5, fx = Math.floor(x), fy = Math.floor(y), tx = x - fx, ty = y - fy, m = n - 1;
    const x0 = fx & m, y0 = fy & m, x1 = (fx + 1) & m, y1 = (fy + 1) & m;
    const a = noiseArr[y0 * n + x0] + (noiseArr[y0 * n + x1] - noiseArr[y0 * n + x0]) * tx;
    const b = noiseArr[y1 * n + x0] + (noiseArr[y1 * n + x1] - noiseArr[y1 * n + x0]) * tx;
    return a + (b - a) * ty;
  }

  // cells (8 m) kept free of trees: houses, landmarks, the bridge ends
  const blocked = new Set();
  const cellKey = (x, z) => (Math.floor(x / 8) * 73856093) ^ (Math.floor(z / 8) * 19349663);
  function block(x, z, r) {
    for (let dz = -r; dz <= r; dz += 8) for (let dx = -r; dx <= r; dx += 8) if (dx * dx + dz * dz <= r * r + 32) blocked.add(cellKey(x + dx, z + dz));
  }
  function buildBlocked() {
    for (const h of info?.houses || []) block(h[0], h[1], Math.max(h[3], h[4]) * 0.8);
    for (const l of info?.landmarks || []) {
      if (l.type === 'bridge') { block(l.a[0], l.a[1], 40); block(l.b[0], l.b[1], 40); }
      else if (l.type === 'pagoda') block(l.pos[0], l.pos[1], 34);
      else if (l.type === 'shrine') block(l.pos[0], l.pos[1], 60);
      else if (l.type === 'torii') block(l.pos[0], l.pos[1], 14);
    }
  }

  const SPEC = ['broadleaf', 'conifer', 'cherry'];
  function genTile(ti, tj) {
    const t0 = performance.now();
    const x0 = ti * TILE, z0 = tj * TILE;
    const r = rng((ti * 73856093) ^ (tj * 19349663) ^ 0x5eed);
    const out = SPEC.map(() => []);
    const half = data.halfIn;
    const step = SPACING;
    for (let gz = 0; gz < TILE; gz += step) for (let gx = 0; gx < TILE; gx += step) {
      const x = x0 + gx + r() * step, z = z0 + gz + r() * step;
      const roll = r(), imp = r(), sv = r(), yaw = r() * 6.283, tint = r();
      r();                                             // (was the wind phase; drawn to keep the placement sequence)
      if (blocked.has(cellKey(x, z))) continue;
      const h = data.heightAt(x, z);
      if (data.waterLevelAt(x, z) > h - 0.6 || h < 1.2) continue;
      const inMap = Math.abs(x) < half - 20 && Math.abs(z) < half - 20;
      const wMap = inMap ? clamp((half - Math.max(Math.abs(x), Math.abs(z))) / 1100, 0, 1) : 0;
      let pF = 0, pC = 0, conifer = 0;
      if (wMap > 0) {
        const f = sampleMask(masks.a, x, z, 0), fld = sampleMask(masks.a, x, z, 1), rk = sampleMask(masks.a, x, z, 2);
        const sd = sampleMask(masks.b, x, z, 0), ch = sampleMask(masks.b, x, z, 1), vil = sampleMask(masks.b, x, z, 2);
        const open = clamp(1 - f - fld - vil - rk - sd, 0, 1);
        pF = smoothstep(0.12, 0.62, f) * (1 - rk * 0.8) * (1 - sd) + open * 0.03 + vil * 0.04;
        pC = clamp(ch * 1.6, 0, 1) * (1 - fld * 0.7) * (1 - sd);
        if (WAVE4) {
          // wave 4: riparian groves along the banks (the banks were bare: 5–15 "lollipops" per frame) and yard trees
          // in the villages (houses keep their cells free)
          const sdist = shoreDist(x, z);
          const rip = smoothstep(2, 12, sdist) * (1 - smoothstep(55, 150, sdist));
          pF = Math.min(1, pF + rip * 0.42 * (1 - rk) * (1 - fld * 0.75) * (1 - sd * 0.94) + vil * 0.16 * (1 - fld));   // bars and fields stay open
          pC = Math.min(1, pC + rip * 0.05 * (1 - fld) * (1 - sd));
        }
        const high = smoothstep(180, 520, h);
        conifer = clamp(0.25 + 0.6 * high + (sampleNoise(x / 3000 + 0.4, z / 3000) - 0.5) * 0.8, 0, 0.95);
      }
      if (wMap < 1) {
        const of = outerForest(x, z, h);
        pF = pF * wMap + of * 0.85 * (1 - wMap);
        pC *= wMap;
        conifer = conifer * wMap + clamp(0.35 + 0.5 * smoothstep(300, 900, h), 0, 0.92) * (1 - wMap);
      }
      let s = -1;
      if (roll < pC) s = 2;
      else if (roll < pC + pF * (1 - pC)) s = sv < conifer ? 1 : 0;
      if (s < 0) continue;
      const scale = s === 1 ? 1.0 + sv * 0.7 : s === 2 ? 0.95 + sv * 0.5 : 1.05 + sv * 0.65;
      const tintI = Math.floor(tint * 4) + (tint * 4 % 1) * 0.999;
      // the phase slot carries the importance (it is uniform random, so it still decorrelates the wind sway): the
      // shader thins far tiles by it continuously
      out[s].push([imp, x, h - 0.6, z, scale, yaw, tintI, 0.85 + r() * 0.35, imp * 6.2831853]);
    }
    const species = out.map((arr) => {
      arr.sort((a, b) => a[0] - b[0]);                 // most important first
      const d = new Float32Array(arr.length * 8);
      for (let i = 0; i < arr.length; i++) { const e = arr[i]; d.set([e[1], e[2], e[3], e[4], e[5], e[6], e[7], e[8]], i * 8); }
      return { data: d, n: arr.length };
    });
    const b = data.boundsY(x0, z0, x0 + TILE, z0 + TILE, [0, 0]);
    veg.stats.genMs = veg.stats.genMs * 0.9 + (performance.now() - t0) * 0.1;
    // undergrowth is generated lazily, only for tiles that come within its range (underQueue)
    return { species, under: WAVE4 ? null : EMPTY_UNDER, ti, tj, y0: b[0] - 2, y1: b[1] + 30 };
  }

  // Wave 4 undergrowth for one tile: reed / grass clumps on the wet margin of rivers and lakes (−0.3 … 1.3 m above
  // the water), scrub bushes on the banks above them and at forest edges. Its own rng: the tree placement is unchanged.
  // One quarter (256 m) of a tile per call (quarter q = 0..3), so a dense braided-river tile never costs one frame
  // more than a few ms; `finishUnder` merges the quarters.
  function genUnder(ti, tj, x0, z0, q = -1) {
    if (q < 0) return finishUnder([0, 1, 2, 3].map((k) => genUnder(ti, tj, x0, z0, k)));
    const r = rng((ti * 19349663) ^ (tj * 83492791) ^ (q * 2654435761) ^ 0x7eed);
    const out = USPEC.map(() => []);
    const half = data.halfIn, B = 16, QS = TILE / 2, qx = (q & 1) * QS, qz = (q >> 1) * QS;
    const push = (k, x, y, z, scale, yaw, tint, hs, imp) => out[k].push([imp, x, y, z, scale, yaw, Math.floor(tint * 4) + (tint * 4 % 1) * 0.999, hs, imp * 6.2831853]);
    for (let bz = qz; bz < qz + QS; bz += B) for (let bx = qx; bx < qx + QS; bx += B) {
      const cxB = x0 + bx + B / 2, czB = z0 + bz + B / 2;
      const sd0 = shoreDist(cxB, czB);
      const inMapB = Math.abs(cxB) < half - 28 && Math.abs(czB) < half - 28;
      if (sd0 <= 40) {
        // skip blocks that are all open water (the wide river's inside) or all high above it
        let lo = Infinity, hi = -Infinity;
        for (const [ox, oz] of [[0, 0], [B, 0], [0, B], [B, B], [B / 2, B / 2]]) {
          const a = data.heightAt(x0 + bx + ox, z0 + bz + oz) - data.waterLevelAt(x0 + bx + ox, z0 + bz + oz);
          if (a < lo) lo = a; if (a > hi) hi = a;
        }
        if (hi < -0.6 || lo > 16) continue;
        // bank block: 5×5 candidates (3.2 m); height above the water decides reed / scrub before any mask lookup
        const STEP = 3.2;
        for (let gz = 0; gz < B; gz += STEP) for (let gx = 0; gx < B; gx += STEP) {
          const x = x0 + bx + gx + r() * STEP, z = z0 + bz + gz + r() * STEP;
          const roll = r(), sv = r(), yaw = r() * 6.283, tint = r(), imp = r();
          const h = data.heightAt(x, z), w = data.waterLevelAt(x, z), above = h - w;
          const reedBand = w > 2.5 && above > -0.3 && above < 1.3;
          const scrubBand = above > 0.8 && above < 14 && h > 1.2;
          if (!reedBand && !scrubBand) continue;
          if (blocked.has(cellKey(x, z))) continue;
          const inMap = Math.abs(x) < half - 20 && Math.abs(z) < half - 20;
          const rk = inMap ? sampleMask(masks.a, x, z, 2) : 0, sdM = inMap ? sampleMask(masks.b, x, z, 0) : 0, vil = inMap ? sampleMask(masks.b, x, z, 2) : 0;
          if (reedBand) {
            // reeds: the wet margin of rivers and lakes (not the sea: its level is ~0), in patches, sparser on bars
            const patch = sampleNoise(x / 90 + 0.31, z / 90 + 0.77);
            const p = smoothstep(0.3, 0.5, patch) * 0.82 * (1 - rk) * (1 - vil) * (1 - sdM * 0.55) + 0.06;
            if (roll < p) { push(0, x, h - 0.15, z, (2.4 + sv * 1.8) * (inMap ? 1 : 0.9), yaw, tint, (1.4 + sv * 1.2) * (above < 0.5 ? 1 : 0.7), imp); continue; }
          }
          if (scrubBand && ((gx + gz + 0.1) / STEP) % 2 < 1) {
            const fld = inMap ? sampleMask(masks.a, x, z, 1) : 0;
            const p = (smoothstep(0.8, 2.0, above) * (1 - smoothstep(6, 14, above)) * 0.3 * (1 - sdM * 0.6) + 0.02) * (1 - rk * 0.8) * (1 - vil * 0.7) * (1 - fld * 0.8);
            if (roll < p) push(1, x, h - 0.2, z, 1.1 + sv * 1.3, yaw, tint, 0.8 + imp * 0.5, imp);
          }
        }
      } else if (inMapB) {
        // forest-edge undergrowth: only in the edge band of the forest mask, 2×2 candidates per block (8 m)
        const fo = sampleMask(masks.a, cxB, czB, 0);
        if (fo < 0.1 || fo > 0.8) continue;
        for (let k = 0; k < 4; k++) {
          const x = x0 + bx + (k & 1) * 8 + r() * 8, z = z0 + bz + (k >> 1) * 8 + r() * 8;
          const roll = r(), sv = r(), yaw = r() * 6.283, tint = r(), imp = r();
          const f = sampleMask(masks.a, x, z, 0);
          const p = smoothstep(0.12, 0.3, f) * (1 - smoothstep(0.55, 0.85, f)) * 0.3;
          if (roll >= p || blocked.has(cellKey(x, z))) continue;
          const h = data.heightAt(x, z);
          if (data.waterLevelAt(x, z) > h - 0.6 || h < 1.2) continue;
          push(1, x, h - 0.2, z, 1.2 + sv * 1.4, yaw, tint, 0.8 + imp * 0.5, imp);
        }
      }
    }
    return out;
  }
  function finishUnder(parts) {
    return USPEC.map((_, k) => {
      const arr = parts.flatMap((p) => p[k]);
      const d = new Float32Array(arr.length * 8);
      for (let i = 0; i < arr.length; i++) { const e = arr[i]; d.set([e[1], e[2], e[3], e[4], e[5], e[6], e[7], e[8]], i * 8); }
      return { data: d, n: arr.length };
    });
  }
  const wMapAt = (x, z) => (Math.abs(x) < data.halfIn - 20 && Math.abs(z) < data.halfIn - 20 ? 1 : 0);

  // ---- instanced meshes -------------------------------------------------------------------------------------------
  function makeList(name, geo, mat, cap) {
    const g = new THREE.InstancedBufferGeometry();
    for (const k of Object.keys(geo.attributes)) g.setAttribute(k, geo.attributes[k]);
    const pos = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    const rot = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', pos); g.setAttribute('iRot', rot);
    g.instanceCount = 0;
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false; mesh.matrixAutoUpdate = false; mesh.name = name;
    return { mesh, pos, rot, cap, n: 0, tris: geo.getAttribute('position').count / 3 };
  }

  function rebuild(cam) {
    const cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;
    // expanded frustum so small turns do not need a rebuild
    const c2 = cam.clone(); c2.fov = Math.min(170, cam.fov * 1.35 + 8); c2.updateProjectionMatrix();
    c2.position.copy(cam.position); c2.quaternion.copy(cam.quaternion); c2.updateMatrixWorld(true);
    mat4.multiplyMatrices(c2.projectionMatrix, c2.matrixWorldInverse);
    frustum.setFromProjectionMatrix(mat4);
    const R = DMAX;
    const i0 = Math.floor((cx - R) / TILE), i1 = Math.floor((cx + R) / TILE), j0 = Math.floor((cz - R) / TILE), j1 = Math.floor((cz + R) / TILE);
    const sel = [];
    let sig = '', split = false;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x0 = i * TILE, z0 = j * TILE;
      const dx = Math.max(x0 - cx, 0, cx - x0 - TILE), dz = Math.max(z0 - cz, 0, cz - z0 - TILE);
      const flat = Math.hypot(dx, dz);
      if (flat > R) continue;
      const key = i + ',' + j;
      let t = tiles.get(key);
      if (!t) { if (!genQueue.includes(key)) genQueue.push(key); continue; }
      box.min.set(x0, t.y0, z0); box.max.set(x0 + TILE, t.y1, z0 + TILE);
      if (!frustum.intersectsBox(box)) continue;
      const dy = Math.max(t.y0 - cy, 0, cy - t.y1);
      const dMin = Math.hypot(flat, dy);
      const fx = Math.max(Math.abs(cx - x0), Math.abs(cx - x0 - TILE)), fz = Math.max(Math.abs(cz - z0), Math.abs(cz - z0 - TILE));
      const dMax = Math.hypot(fx, fz, Math.max(Math.abs(cy - t.y0), Math.abs(cy - t.y1)));
      if (dMin > R) continue;
      // thinning for the far LOD: the shader dissolves instances by importance (same curve, per instance); the CPU
      // uploads every instance that can be visible anywhere in the tile until the next rebuild (keep at dMin, rounded up)
      const keep = clamp(1 - 0.85 * smoothstep(D0, R * 0.7, dMin), 0.15, 1);
      const kq = Math.round(keep * 8);
      sel.push([t, dMin, dMax, Math.min(1, (kq + 0.5) / 8 + 0.1)]);
      if (dMin < URANGE[1] && !t.under && !underQueue.includes(t)) underQueue.push(t);
      sig += key + (dMin < D0 + XM ? 'n' : '') + (dMax > D0 - XM ? 'f' : '') + kq + (dMin < URANGE[0] ? 'r' : '') + (dMin < URANGE[1] ? 'b' : '') + (t.under ? 'U' : '') + ';';
      if (dMin < D0 + XM && dMax > D0 - XM) split = true;
    }
    if (split) sig += '@' + Math.round(cx / 25) + ',' + Math.round(cy / 25) + ',' + Math.round(cz / 25);
    if (sig === lastSig) return;
    lastSig = sig;
    for (let s = 0; s < SPEC.length; s++) {
      const near = lists[SPEC[s] + ':near'], far = lists[SPEC[s] + ':far'];
      let nn = 0, nf = 0;
      for (const [t, dMin, dMax, keep] of sel) {
        const sp = t.species[s];
        if (!sp.n) continue;
        // tiles straddling the LOD boundary are split per instance (so the near mesh only gets the near trees); both
        // lists overlap across the crossfade band, where the shaders dither one into the other
        const split = dMin < D0 + XM && dMax > D0 - XM;
        if (dMin < D0 + XM) nn = copy(near, nn, sp, sp.n, 1, split ? 0 : -1, D0 + XM - 20, cx, cy, cz);
        if (dMax > D0 - XM) nf = copy(far, nf, sp, Math.ceil(sp.n * keep), 1, split ? D0 - XM + 20 : -1, 1e9, cx, cy, cz);
      }
      finish(near, nn); finish(far, nf);
    }
    for (let s = 0; s < USPEC.length; s++) {
      const L = lists[USPEC[s] + ':near'];
      if (!L) continue;
      let n = 0;
      for (const [t, dMin] of sel) { const u = t.under?.[s]; if (u?.n && dMin < URANGE[s]) n = copy(L, n, u, u.n, 1); }
      finish(L, n);
    }
    veg.stats.reeds = lists['reed:near']?.n || 0;
    veg.stats.bushes = lists['bush:near']?.n || 0;
    veg.stats.near = SPEC.reduce((a, s) => a + lists[s + ':near'].n, 0);
    veg.stats.far = SPEC.reduce((a, s) => a + lists[s + ':far'].n, 0);
    veg.stats.tiles = sel.length;
    veg.stats.tris = SPEC.reduce((a, s) => a + lists[s + ':near'].n * lists[s + ':near'].tris + lists[s + ':far'].n * lists[s + ':far'].tris, 0)
      + USPEC.reduce((a, s) => a + (lists[s + ':near'] ? lists[s + ':near'].n * lists[s + ':near'].tris : 0), 0);
  }
  function copy(L, n, sp, count, scaleMul, dLo = -1, dHi = 1e9, cx = 0, cy = 0, cz = 0) {
    const pa = L.pos.array, ra = L.rot.array, d = sp.data;
    const lo2 = dLo > 0 ? dLo * dLo : -1, hi2 = dHi * dHi, test = dLo >= 0;
    for (let i = 0; i < count && n < L.cap; i++) {
      const k = i * 8;
      if (test) {
        const dx = d[k] - cx, dy = d[k + 1] - cy, dz = d[k + 2] - cz, d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < lo2 || d2 > hi2) continue;
      }
      const o = n * 4; n++;
      pa[o] = d[k]; pa[o + 1] = d[k + 1]; pa[o + 2] = d[k + 2]; pa[o + 3] = d[k + 3] * scaleMul;
      ra[o] = d[k + 4]; ra[o + 1] = d[k + 5]; ra[o + 2] = d[k + 6]; ra[o + 3] = d[k + 7];
    }
    return n;
  }
  function finish(L, n) {
    L.n = n;
    for (const a of [L.pos, L.rot]) { a.clearUpdateRanges(); a.addUpdateRange(0, Math.max(4, n * 4)); a.needsUpdate = true; }
    L.mesh.geometry.instanceCount = n;
  }

  // ---- houses ---------------------------------------------------------------------------------------------------
  function buildHouses(group) {
    const hs = info?.houses || [];
    const kits = houseKits();
    const mat = propMaterial(game, { name: 'houses', instanced: true, tints: [0xe0703a, 0x4a6aa8, 0x3d4a63, 0xb0503a], rim: 0.6, fade: [9000, 12000] });
    const perKit = { minka: [], townhouse: [], kura: [] };
    const r = rng(991);
    const mouth = info?.mouth || [1e9, 1e9];
    for (const h of hs) {
      const [x, z, rot, w, d, hh, col] = h;
      const town = Math.hypot(x - mouth[0], z - mouth[1]) < 2500;
      const roll = r();
      const kit = town ? (roll < 0.6 ? 'townhouse' : roll < 0.85 ? 'minka' : 'kura') : (roll < 0.72 ? 'minka' : roll < 0.9 ? 'townhouse' : 'kura');
      const hw = w / 2, hd = d / 2, c = Math.cos(rot), s = Math.sin(rot);
      let y = Infinity;
      for (const [ox, oz] of [[hw, hd], [-hw, hd], [hw, -hd], [-hw, -hd], [0, 0]]) y = Math.min(y, data.heightAt(x + ox * c - oz * s, z + ox * s + oz * c));
      if (data.waterLevelAt(x, z) > y) continue;
      perKit[kit].push([x, y - 0.2, z, w, -rot + Math.PI / 2, col + r() * 0.99, (hh / 7) * (0.9 + r() * 0.25), 0]);
    }
    let total = 0;
    for (const [name, arr] of Object.entries(perKit)) {
      if (!arr.length) continue;
      const L = makeList('houses-' + name, kits[name], mat, arr.length);
      for (let i = 0; i < arr.length; i++) { L.pos.array.set(arr[i].slice(0, 4), i * 4); L.rot.array.set(arr[i].slice(4, 8), i * 4); }
      finish(L, arr.length);
      group.add(L.mesh);
      veg.meshes['houses-' + name] = L.mesh;
      total += arr.length;
    }
    veg.stats.houses = total;
  }

  function buildLandmarks(group) {
    const lm = info?.landmarks || [];
    const mat = propMaterial(game, { name: 'landmarks', rim: 0.8 });
    const matDouble = propMaterial(game, { name: 'landmarks2', rim: 0.8, side: THREE.DoubleSide });
    const add = (name, geo, pos, yaw = 0, m = mat) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(pos[0], pos[1], pos[2]); mesh.rotation.y = yaw;
      mesh.name = name; mesh.updateMatrix(); mesh.matrixAutoUpdate = false;
      group.add(mesh);
      veg.landmarks[name] = mesh;
      if (game.toon?.outline && geo.attributes.position.count < 60000) {
        try { const o = game.toon.outline(mesh, { width: 0.18, color: 0x3a2c44 }); o.material.side = THREE.BackSide; } catch (e) { /* outlines optional */ }
      }
      return mesh;
    };
    let n = 0;
    for (const l of lm) {
      if (l.type === 'bridge') {
        const a = new THREE.Vector3(l.a[0], l.a[2], l.a[1]), b = new THREE.Vector3(l.b[0], l.b[2], l.b[1]);   // json: [x, z, y]
        add('bridge', bridge(a, b, l.water), [0, 0, 0], 0, matDouble); n++;
      } else if (l.type === 'pagoda') {
        const [x, z] = l.pos; const y = Math.min(data.heightAt(x - 10, z - 10), data.heightAt(x + 10, z + 10), data.heightAt(x, z)) - 0.5;
        add(l.name || 'pagoda', pagoda(58), [x, y, z], (l.yaw ?? 0.35)); n++;
      } else if (l.type === 'torii') {
        const [x, z] = l.pos;
        const y = l.water ? data.waterLevelAt(x, z) - 1.5 : data.heightAt(x, z) - 0.3;
        add(l.name || 'torii', torii(16 * (l.scale || 1)), [x, y, z], l.yaw || 0); n++;
      } else if (l.type === 'shrine') {
        const [x, z] = l.pos; const y = data.heightAt(x, z) - 0.8;
        add(l.name || 'shrine', shrine(), [x, y, z], 0.5); n++;
      }
    }
    veg.stats.landmarks = n;
  }

  // ---- system -------------------------------------------------------------------------------------------------------
  veg.init = async () => {
    const t = game.terrain;
    data = t?.data;
    if (!data) { console.warn('[vegetation] terrain data missing; vegetation disabled'); return; }
    info = data.info;
    q = game.quality?.vegetation ?? 1;
    DMAX = 4200 * Math.sqrt(q);
    D0 = 460 * Math.min(1.25, Math.sqrt(q));
    SPACING = 10 / Math.sqrt(Math.max(0.3, q));
    const [a, b] = await Promise.all([loadMask('valley_masks_a.png'), loadMask('valley_masks_b.png')]);
    masks = { a, b };
    if (WAVE4) {
      try {
        const tx = data.textures, t0 = performance.now();
        shoreIn = shoreField(tx.hwIn.image.data, data.nIn, (2 * data.halfIn) / data.nIn, 2);
        shoreOut = shoreField(tx.hwOut.image.data, data.nOut, (2 * data.halfOut) / data.nOut, 1);
        veg.stats.shoreMs = +(performance.now() - t0).toFixed(1);
      } catch (e) { console.warn('[vegetation] shore field failed; no bank undergrowth', e); shoreIn = shoreOut = null; }
    }
    URANGE = [720 * Math.min(1.2, Math.sqrt(q)), 980 * Math.min(1.2, Math.sqrt(q))];
    buildBlocked();
    const group = new THREE.Group(); group.name = 'vegetation';
    game.scene.add(group);
    veg.group = group;
    const capNear = Math.round(24000 * q + 4000), capFar = Math.round(90000 * q + 10000);
    for (const s of SPEC) {
      const sp = SPECIES[s];
      const common = { instanced: true, wind: true, normalBlend: sp.normalBlend, tints: sp.tints, rim: sp.rim, backGlow: sp.backGlow, leaf: 0.5 };
      const thin = [D0, DMAX * 0.7, 0.15, 1];
      lists[s + ':near'] = makeList(s + '-near', sp.near(), propMaterial(game, { ...common, name: s + '-near', xfade: [D0, XW, 1], thin }), capNear);
      lists[s + ':far'] = makeList(s + '-far', sp.far(), propMaterial(game, { ...common, name: s + '-far', xfade: [D0, XW, 2], thin, fade: [DMAX * 0.82, DMAX] }), capFar);
      group.add(lists[s + ':near'].mesh, lists[s + ':far'].mesh);
      veg.meshes[s + '-near'] = lists[s + ':near'].mesh; veg.meshes[s + '-far'] = lists[s + ':far'].mesh;
    }
    if (WAVE4) {
      const capU = [Math.round(38000 * q + 4000), Math.round(16000 * q + 2000)];
      USPEC.forEach((s, i) => {
        const sp = UNDER[s];
        const mat = propMaterial(game, { name: s + '-near', instanced: true, wind: true, normalBlend: sp.normalBlend, tints: sp.tints, rim: sp.rim,
          backGlow: sp.backGlow, leaf: 0.35, fade: [URANGE[i] * 0.72, URANGE[i]], side: s === 'reed' ? THREE.DoubleSide : THREE.FrontSide });
        lists[s + ':near'] = makeList(s + '-near', sp.near(), mat, capU[i]);
        group.add(lists[s + ':near'].mesh);
        veg.meshes[s + '-near'] = lists[s + ':near'].mesh;
      });
    }
    buildHouses(group);
    buildLandmarks(group);
    veg.petals = createPetals(game, { masks, data, sampleMask });
    if (veg.petals) group.add(veg.petals.mesh);
    // left out of the water's planar reflection (wave 4): far tree blobs (most of the triangles, thin bands in the
    // mirror) and the camera-local petals
    veg.reflectionHide = [...SPEC.map((sp) => lists[sp + ':far'].mesh), veg.petals?.mesh].filter(Boolean);
    // …and, while the camera is higher than ~150 m above the water, the 4 000 instanced houses (~0.2 M triangles;
    // their roofs only reflect where a village meets the river, which reads from low down)
    veg.reflectionHideHigh = Object.keys(veg.meshes).filter((k) => k.startsWith('houses-')).map((k) => veg.meshes[k]);
    t.selectHooks?.push(late);
    // warm up the tiles around the start camera
    rebuild(game.camera);
    const t0 = performance.now();
    while (genQueue.length && performance.now() - t0 < 2500) { const k = genQueue.shift(); const [i, j] = k.split(',').map(Number); tiles.set(k, genTile(i, j)); }
    lastSig = ''; rebuild(game.camera);
    while (underQueue.length && performance.now() - t0 < 3500) { const t = underQueue.shift(); if (!t.under) t.under = genUnder(t.ti, t.tj, t.ti * TILE, t.tj * TILE); }
    lastSig = ''; rebuild(game.camera);
  };

  veg.update = (dt, realDt) => {
    if (!data || !masks) return;
    // generate a few tiles per frame (budget ~3 ms)
    const t0 = performance.now();
    let made = 0;
    while (genQueue.length && (performance.now() - t0 < 3 || made === 0)) {
      const k = genQueue.shift(); if (tiles.has(k)) continue;
      const [i, j] = k.split(',').map(Number); tiles.set(k, genTile(i, j)); made++;
    }
    // undergrowth for tiles within its range, nearest first, ~2 ms per frame (at least one tile)
    if (underQueue.length && veg.underBudget > 0) {
      const cx = game.camera.position.x, cz = game.camera.position.z;
      underQueue.sort((a, b) => Math.hypot((a.ti + 0.5) * TILE - cx, (a.tj + 0.5) * TILE - cz) - Math.hypot((b.ti + 0.5) * TILE - cx, (b.tj + 0.5) * TILE - cz));
      const t1 = performance.now();
      let madeU = 0;
      while (underQueue.length && (performance.now() - t1 < veg.underBudget || madeU === 0)) {
        const t = underQueue[0]; if (t.under) { underQueue.shift(); continue; }
        const tu = performance.now();
        (t.uParts ||= []).push(genUnder(t.ti, t.tj, t.ti * TILE, t.tj * TILE, t.uParts.length));
        if (t.uParts.length === 4) { t.under = finishUnder(t.uParts); t.uParts = null; underQueue.shift(); madeU++; }
        veg.stats.genUnderMs = (veg.stats.genUnderMs || 0) * 0.8 + (performance.now() - tu) * 0.2;   // per quarter tile
        if (!t.under && performance.now() - t1 >= veg.underBudget) break;
      }
      if (madeU) lastSig = '';                           // rebuild with the new instances this frame's late hook
    }
    if (tiles.size > 900) {       // forget far tiles
      const cx = game.camera.position.x, cz = game.camera.position.z;
      for (const k of tiles.keys()) { const [i, j] = k.split(',').map(Number); if (Math.hypot((i + 0.5) * TILE - cx, (j + 0.5) * TILE - cz) > DMAX * 2.2) tiles.delete(k); }
    }
    veg.petals?.update(dt, realDt);
  };

  // Rebuild with the final camera of this frame (terrain's late selection hook, after the camera rig): cheap when
  // the tile set did not change.
  function late(lod, cam) {
    if (!data || !masks) return;
    const moved = cam.position.distanceToSquared(lastCam) > 20 * 20;
    if (moved || lastSig === '' || game.time.frame % 6 === 0) { rebuild(cam); lastCam.copy(cam.position); }
  }

  return veg;
}
