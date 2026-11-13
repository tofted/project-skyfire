// game.world.wind(pos, out) — the air the dragons fly through, consistent with the clouds you see.
//   prevailing breeze   along the cloud drift (game.clouds.weather.wind), 45 % at the valley floor → 100 % above 2.4 km,
//                       slow ±15 % gusts
//   field thermals      sunlit ground under gaps in the deck: pulsing cells (≈ 900 m grid, r 180–340 m, 0.7–2.2 m/s),
//                       from ~150 m up to the deck base, fading above 1.5 km; switched off under deck shadow
//   tower updrafts      under and inside every cumulus column (feeding inflow below the base, 2.6–4 m/s core inside
//                       the body, fading toward the head, small outflow at the top)
//   tower downdrafts    a sinking ring hugging the tower walls (≈ −2.2 m/s, 100–250 m outside the wall, from just
//                       under the base to ~80 % of the height)
//   deck                gentle lift under / inside deck cells, gentle sinking under gaps
//   turbulence          only inside clouds (towers and deck), ±2.4 m/s: coherent heave bumps ~0.8–1.3 Hz + eddies
//                       (λ ≈ 35–150 m, so the two wing tips feel slightly different air: small roll bumps)
//   storm               (weather.darkness) stronger breeze, downdrafts and bumps
// Magnitudes: vertical clamped to ±6 m/s, horizontal to 9 m/s (breeze included). Calm air far from clouds.
// Cost: a few hundred flops (28 towers rejected by a horizontal test, one deck-map lookup); see docs/modules/clouds.md.
import { DECK, sampleWeather, deckInside } from './layout.js';

const LEVELS = 20;

/** Per-tower body profile: horizontal envelope radius at LEVELS heights between base and top (lobe union, outer). */
function towerProfile(t) {
  const H = Math.max(1, t.max[1] - t.base);
  const r = new Float32Array(LEVELS);
  const lx = t.lean?.x ?? 0, lz = t.lean?.z ?? 0, TH = t.H || H;
  for (let i = 0; i < LEVELS; i++) {
    const y = t.base + ((i + 0.5) / LEVELS) * H;
    const f = (y - t.base) / TH;
    const ax = t.x + lx * f * TH, az = t.z + lz * f * TH;
    let best = 0;
    for (const s of t.spheres) {
      const dy = (y - s[1]) / s[4];
      if (dy <= -1 || dy >= 1) continue;
      const hw = s[3] * Math.sqrt(1 - dy * dy);
      const d = Math.hypot(s[0] - ax, s[2] - az);
      // Outer extent, damped for far-flung lobes (anvils, turrets): the air column is the body, not the shelf.
      const ext = d + hw;
      if (ext > best) best = d > t.radius * 1.6 ? Math.max(best, t.radius * 1.6) : ext;
    }
    r[i] = best * 0.82;   // lobes overlap with gaps: the solid core is a bit narrower than the outer envelope
  }
  // Smooth the profile (turrets make spikes).
  const s = new Float32Array(LEVELS);
  for (let i = 0; i < LEVELS; i++) s[i] = (r[Math.max(0, i - 1)] + 2 * r[i] + r[Math.min(LEVELS - 1, i + 1)]) / 4;
  let rMax = 0;
  for (const v of s) rMax = Math.max(rMax, v);
  return { r: s, rMax, H, top: t.max[1], lx: lx, lz: lz, TH };
}

function hash2(i, j, s) {
  let h = (i * 374761393 + j * 668265263 + s * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/**
 * @param layout  buildLayout() result ({ towers, weather })
 * @param env     { now(): sim seconds, weather: { coverage, darkness, wind: Vector3 }, sunDir: Vector3 }
 */
export function createWind(layout, env) {
  const { towers, weather } = layout;
  const T = towers.map((t) => ({ t, ...towerProfile(t) }));
  const params = {
    breeze: 0.62,          // × weather.wind (6.2 m/s cloud drift → ~3.9 m/s aloft, 1.7 m/s low)
    thermal: 1.0,          // field thermals gain
    updraft: 3.4,          // tower core updraft (m/s)
    downdraft: 2.2,        // tower wall sinking (m/s)
    deck: 0.9,             // deck-cell lift (m/s)
    turb: 2.4,             // turbulence amplitude inside clouds (m/s)
    maxV: 6, maxH: 9,
    enabled: true,
  };
  const wv = [0, 0, 0, 0];
  const THERMAL_CELL = 900;
  const smooth = (e0, e1, v) => { let k = (v - e0) / (e1 - e0); k = k < 0 ? 0 : k > 1 ? 1 : k; return k * k * (3 - 2 * k); };

  function fieldThermals(x, y, z, time) {
    if (y > 1700 || y < 20) return 0;
    const prof = smooth(20, 320, y) * (1 - smooth(1000, 1700, y));
    if (prof <= 0) return 0;
    // Thermals lean downwind with height (rising ~1.5 m/s in a ~2 m/s low breeze).
    const W = env.weather.wind;
    const hx = x - W.x * y * 0.17, hz = z - W.z * y * 0.17;
    const fx = hx / THERMAL_CELL, fz = hz / THERMAL_CELL;
    const ci = Math.floor(fx - 0.5), cj = Math.floor(fz - 0.5);
    let w = 0;
    for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) {
      const i = ci + di, j = cj + dj;
      const cx = (i + 0.2 + 0.6 * hash2(i, j, 11)) * THERMAL_CELL, cz = (j + 0.2 + 0.6 * hash2(i, j, 17)) * THERMAL_CELL;
      const R = 180 + 160 * hash2(i, j, 23);
      const ddx = hx - cx, ddz = hz - cz;
      const d2 = (ddx * ddx + ddz * ddz) / (R * R);
      if (d2 > 4) continue;
      // Pulsing life cycle (90–190 s), some cells are dormant at any time.
      const period = 90 + 100 * hash2(i, j, 31);
      const life = Math.sin((time / period + hash2(i, j, 37)) * 6.2832);
      if (life <= -0.2) continue;
      const strength = (0.7 + 1.5 * hash2(i, j, 41)) * Math.min(1, (life + 0.2) * 1.4);
      // Core rises, a thin sinking skirt around it (mass balance).
      w += strength * (Math.exp(-d2 * 1.6) - 0.22 * Math.exp(-(d2 - 2.2) * (d2 - 2.2) * 1.5));
    }
    if (w === 0) return 0;
    // Sunlit ground only: the deck shadow at the ground below (sun-displaced deck sample) kills the thermal.
    const L = env.sunDir, ly = Math.max(0.15, L.y);
    sampleWeather(weather, hx + (L.x / ly) * 850, hz + (L.z / ly) * 850, wv);
    const cov = (wv[0] - (1 - env.weather.coverage)) / Math.max(env.weather.coverage, 0.05);
    const sun = 1 - 0.85 * smooth(-0.15, 0.25, cov);
    return w * prof * sun;
  }

  function wind(p, out) {
    if (!out) out = { x: 0, y: 0, z: 0, set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; } };
    const x = p.x, y = p.y, z = p.z;
    if (!params.enabled || !(y === y)) return out.set(0, 0, 0);
    const time = env.now();
    const W = env.weather.wind, dark = env.weather.darkness || 0;
    // 1) Prevailing breeze, with slow gusts.
    const hk = 0.45 + 0.55 * smooth(150, 2400, y);
    const gust = 1 + 0.15 * Math.sin(time * 0.31 + x * 0.00041) * Math.sin(time * 0.173 + z * 0.00037 + 1.3);
    const bk = params.breeze * hk * gust * (1 + 0.5 * dark);
    let vx = W.x * bk, vy = 0, vz = W.z * bk;

    // 2) Thermals over sunlit fields.
    if (params.thermal > 0) vy += fieldThermals(x, y, z, time) * params.thermal;

    // 3) Towers: updrafts, wall downdrafts, inflow / outflow, in-cloud turbulence amount.
    let turb = 0;
    for (let k = 0; k < T.length; k++) {
      const c = T[k], t = c.t;
      if (y < t.base - 950 || y > c.top + 200) continue;
      const f = (y - t.base) / c.TH;
      const ax = t.x + c.lx * Math.max(0, f) * c.TH, az = t.z + c.lz * Math.max(0, f) * c.TH;
      const dx = x - ax, dz = z - az;
      const reach = c.rMax * 1.9 + 60;
      if (dx > reach || dx < -reach || dz > reach || dz < -reach) continue;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > reach) continue;
      const u = (y - t.base) / c.H;
      let r;
      if (u <= 0) r = c.r[0];
      else if (u >= 1) r = c.r[LEVELS - 1] * 0.6;
      else { const s = u * LEVELS - 0.5, i0 = Math.max(0, Math.floor(s)), i1 = Math.min(LEVELS - 1, i0 + 1), fr = Math.min(1, Math.max(0, s - i0)); r = c.r[i0] + (c.r[i1] - c.r[i0]) * fr; }
      r = Math.max(r, 60);
      const q = d / r;
      let up;
      if (u < 0) {
        // Feeding thermal under the base: wide, strongest right under the flat base, converging inflow.
        const v = smooth(-950, -60, y - t.base);
        up = params.updraft * 0.75 * v * Math.exp(-q * q * 1.3);
        const inflow = 0.7 * v * q * Math.exp(-q * q);
        if (d > 1) { vx -= (dx / d) * inflow; vz -= (dz / d) * inflow; }
      } else {
        // Inside the column: core updraft fading toward the head; small outflow near the top.
        up = params.updraft * Math.exp(-q * q * 1.1) * (1 - smooth(0.62, 1.05, u));
        const outflow = 0.9 * smooth(0.75, 1.0, u) * Math.exp(-(q - 1) * (q - 1) * 2);
        if (d > 1) { vx += (dx / d) * outflow; vz += (dz / d) * outflow; }
        // In-cloud amount for turbulence: 1 inside the body, fades over ~150 m at the wall.
        if (u < 1.02) turb = Math.max(turb, smooth(r + 60, r - 150, d));
      }
      // Sinking ring hugging the wall (from just under the base to 80 % of the height).
      const band = smooth(-350, -50, y - t.base) * (1 - smooth(0.72, 0.95, u));
      const ring = (d - r - Math.max(90, 0.22 * r)) / Math.max(80, 0.15 * r);   // ~100–250 m outside the wall
      const down = params.downdraft * (1 + 0.5 * dark) * band * Math.exp(-ring * ring);
      vy += up - down;
    }

    // 4) Deck cells: lift under / inside cells, gentle sinking under gaps; turbulence inside.
    const lo = DECK.base - DECK.baseVar * 0.5 - 520, hi = DECK.topMax + 60;
    if (y > lo && y < hi) {
      sampleWeather(weather, x, z, wv);
      const cov = (wv[0] - (1 - env.weather.coverage)) / Math.max(env.weather.coverage, 0.05);
      const base = DECK.base + (wv[2] - 0.5) * DECK.baseVar;
      const ins = deckInside(wv, y, env.weather.coverage);
      if (y < base) {
        const v = smooth(base - 520, base - 30, y);
        vy += params.deck * v * (cov > 0 ? smooth(0, 0.35, cov) : -0.45 * smooth(0, -0.4, cov));
      } else if (ins > -40) {
        vy += params.deck * 0.8 * smooth(-40, 60, ins) * smooth(0, 0.3, cov);
        turb = Math.max(turb, smooth(-20, 90, ins));
      }
    }

    // 5) Turbulence inside clouds: coherent heave bumps + spatial eddies (smooth in space and time).
    if (turb > 0) {
      const A = params.turb * turb * (1 + dark);
      const heave = Math.sin(time * 5.3 + x * 0.013) * 0.6 + Math.sin(time * 8.1 + z * 0.017 + 1.7) * 0.4;
      const e1 = Math.sin(x * 0.041 + time * 1.7 + Math.sin(z * 0.023 + time * 0.6) * 2.0);
      const e2 = Math.sin(z * 0.037 - time * 1.3 + Math.sin(y * 0.029) * 2.0);
      const e3 = Math.sin(y * 0.047 + time * 2.1 + Math.sin(x * 0.031 - time * 0.4) * 2.0);
      const s1 = Math.sin(x * 0.17 + z * 0.11 + time * 3.1), s2 = Math.sin(z * 0.19 - y * 0.13 + time * 2.7);
      vx += A * (0.55 * e1 + 0.2 * s2);
      vz += A * (0.55 * e2 + 0.2 * s1);
      vy += A * (0.9 * heave + 0.4 * e3 + 0.25 * s1);
    }

    // Clamp: never enough to take the dragon away from its pilot.
    if (vy > params.maxV) vy = params.maxV; else if (vy < -params.maxV) vy = -params.maxV;
    const h2 = vx * vx + vz * vz;
    if (h2 > params.maxH * params.maxH) { const k = params.maxH / Math.sqrt(h2); vx *= k; vz *= k; }
    return out.set(vx, vy, vz);
  }

  return { wind, params, profiles: T };
}
