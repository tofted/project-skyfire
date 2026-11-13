// Procedural geometry for the fallback titan: parametric parts (ellipsoids, swept tubes, superellipsoid blocks,
// feathers) merged into one skinned BufferGeometry, plus kintsugi crack ribbons laid on the same surfaces.
// Everything is built in the rest pose, in titan model space (metres, +Y up, +Z forward).
import * as THREE from 'three';
import { clamp, rng as makeRng } from '../../core/util.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();

// Deterministic 3D value noise (stone lumps, colour variation).
function hash3(x, y, z) {
  let h = (x * 374761393 + y * 668265263 + z * 1440662683) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
export function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const l = (a, b, t) => a + (b - a) * t;
  const c = (dx, dy, dz) => hash3(xi + dx, yi + dy, zi + dz);
  return l(l(l(c(0, 0, 0), c(1, 0, 0), u), l(c(0, 1, 0), c(1, 1, 0), u), v),
    l(l(c(0, 0, 1), c(1, 0, 1), u), l(c(0, 1, 1), c(1, 1, 1), u), v), w);
}
export const fbm3 = (x, y, z) => noise3(x, y, z) * 0.6 + noise3(x * 2.1, y * 2.1, z * 2.1) * 0.3 + noise3(x * 4.3, y * 4.3, z * 4.3) * 0.1;

/**
 * Accumulates skinned vertices. weights: bone index, or fn(p) -> [[bone, w], ...] (≤ 4, normalised here).
 * color: hex / THREE.Color / fn(p, n) -> THREE.Color (linear).
 */
export class MeshBuilder {
  constructor({ glow = false } = {}) {
    this.pos = []; this.nor = []; this.col = []; this.si = []; this.sw = []; this.idx = []; this.glow = glow ? [] : null;
    this.count = 0;
  }

  /** Append an indexed sub-mesh given as flat arrays (positions/normals as Vector3 lists). */
  append(P, N, I, { weights = 0, color = 0xffffff, glow = null } = {}) {
    const base = this.count;
    const col = new THREE.Color();
    const fixedCol = typeof color === 'function' ? null : new THREE.Color(color);
    const fixedW = typeof weights === 'function' ? null : [[weights, 1]];
    for (let i = 0; i < P.length; i++) {
      const p = P[i], n = N[i];
      this.pos.push(p.x, p.y, p.z); this.nor.push(n.x, n.y, n.z);
      const c = fixedCol || color(p, n, col);
      this.col.push(c.r, c.g, c.b);
      const w = fixedW || weights(p);
      let s = 0; for (const [, x] of w) s += x;
      for (let k = 0; k < 4; k++) {
        const e = w[k];
        this.si.push(e ? e[0] : 0); this.sw.push(e ? e[1] / (s || 1) : 0);
      }
      if (this.glow) {
        const g = typeof glow === 'function' ? glow(p) : (glow || [0, 0, 0]);
        this.glow.push(g[0], g[1], g[2]);
      }
    }
    for (const i of I) this.idx.push(i + base);
    this.count += P.length;
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.sw, 4));
    if (this.glow) g.setAttribute('glowData', new THREE.Float32BufferAttribute(this.glow, 3));
    g.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * Grid surface: fn(u, v, out) writes a point for u ∈ [0,1) around (wraps), v ∈ [0,1] along.
 * Rows at v = 0 / v = 1 collapse to single pole vertices when poles are set. Normals are area-weighted smooth.
 */
export function gridSurface(fn, nu, nv, { poles = [true, true], wrap = true } = {}) {
  const P = [], I = [];
  const rowStart = [];
  const cols = wrap ? nu : nu + 1;
  for (let j = 0; j <= nv; j++) {
    const v = j / nv;
    const isPole = (j === 0 && poles[0]) || (j === nv && poles[1]);
    rowStart.push(P.length);
    if (isPole) { const p = new THREE.Vector3(); fn(0, v, p); P.push(p); continue; }
    for (let i = 0; i < cols; i++) { const p = new THREE.Vector3(); fn(i / nu, v, p); P.push(p); }
  }
  const at = (i, j) => {
    const isPole = (j === 0 && poles[0]) || (j === nv && poles[1]);
    if (isPole) return rowStart[j];
    return rowStart[j] + (wrap ? ((i % nu) + nu) % nu : i);
  };
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = at(i, j), b = at(i + 1, j), c = at(i, j + 1), d = at(i + 1, j + 1);
      if (a !== b) I.push(a, c, b);
      if (c !== d) I.push(b, c, d);
    }
  }
  return { P, N: smoothNormals(P, I), I };
}

export function smoothNormals(P, I) {
  const N = P.map(() => new THREE.Vector3());
  for (let k = 0; k < I.length; k += 3) {
    const a = P[I[k]], b = P[I[k + 1]], c = P[I[k + 2]];
    _a.subVectors(b, a); _b.subVectors(c, a); _c.crossVectors(_a, _b);
    N[I[k]].add(_c); N[I[k + 1]].add(_c); N[I[k + 2]].add(_c);
  }
  for (const n of N) { if (n.lengthSq() < 1e-12) n.set(0, 1, 0); else n.normalize(); }
  return N;
}

/**
 * Ellipsoid part. opts: { rot: Quaternion, lump (m), lumpScale, deform(p, local, dirUnit) mutate local offset }
 * Returns { P, N, I, surf(u, v) -> {p, n} } where surf follows the same parameterisation (for cracks).
 */
export function ellipsoid(center, radii, opts = {}) {
  const { rot = null, nu = 22, nv = 15, lump = 0, lumpScale = 0.12, deform = null } = opts;
  const r = Array.isArray(radii) ? radii : [radii, radii, radii];
  const q = rot || new THREE.Quaternion();
  const dir = new THREE.Vector3(), loc = new THREE.Vector3();
  const point = (u, v, out) => {
    const th = u * Math.PI * 2, ph = v * Math.PI;
    dir.set(Math.sin(ph) * Math.cos(th), -Math.cos(ph), Math.sin(ph) * Math.sin(th));
    loc.set(dir.x * r[0], dir.y * r[1], dir.z * r[2]);
    if (deform) deform(loc, dir);
    out.copy(loc).applyQuaternion(q).add(center);
    if (lump) {
      const n = fbm3(out.x * lumpScale, out.y * lumpScale, out.z * lumpScale) - 0.5;
      out.addScaledVector(_d.copy(loc).normalize().applyQuaternion(q), n * lump * 2);
    }
    return out;
  };
  const g = gridSurface(point, nu, nv);
  g.surf = surfFromPoint(point);
  return g;
}

/**
 * Swept tube along a Catmull-Rom path. pts: [{p: Vector3, r: number | [rx, ry]}]. Cross-section frame from `up`
 * (N axis = rx direction). Rounded caps. opts.bulge(s, ang, basis) -> radius multiplier; ang measured from N.
 * surf(u, v): u = angle / 2π, v = s along the body (caps excluded).
 */
export function tube(pts, opts = {}) {
  const { up = new THREE.Vector3(0, 1, 0), nu = 18, nv = 16, caps = [true, true], capRings = 4, bulge = null,
    lump = 0, lumpScale = 0.12 } = opts;
  const curve = new THREE.CatmullRomCurve3(pts.map((x) => x.p), false, 'centripetal');
  const rad = (s) => {
    const f = s * (pts.length - 1);
    const i = clamp(Math.floor(f), 0, pts.length - 2), t = f - i;
    const R = (k) => { const x = pts[clamp(k, 0, pts.length - 1)].r; return Array.isArray(x) ? x : [x, x]; };
    const a = R(i - 1), b = R(i), c = R(i + 1), d = R(i + 2);
    const cr = (p0, p1, p2, p3) => 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
    return [Math.max(0.05, cr(a[0], b[0], c[0], d[0])), Math.max(0.05, cr(a[1], b[1], c[1], d[1]))];
  };
  // Parallel-transport frames sampled densely.
  const F = 64;
  const frames = [];
  let n = new THREE.Vector3();
  for (let k = 0; k <= F; k++) {
    const s = k / F;
    const T = curve.getTangentAt(s).normalize();
    if (k === 0) { n.copy(up).addScaledVector(T, -up.dot(T)); if (n.lengthSq() < 1e-6) n.set(1, 0, 0).addScaledVector(T, -T.x); n.normalize(); }
    else { n.addScaledVector(T, -n.dot(T)).normalize(); }
    frames.push({ T, N: n.clone(), B: new THREE.Vector3().crossVectors(n, T) });   // B = N × T keeps faces outward
  }
  const frameAt = (s) => frames[clamp(Math.round(s * F), 0, F)];
  const c = new THREE.Vector3();
  const body = (u, s, out, capScale = 1, capShift = 0) => {
    const ang = u * Math.PI * 2;
    const fr = frameAt(s);
    const [rx, ry] = rad(s);
    const m = bulge ? bulge(s, ang, fr) : 1;
    curve.getPointAt(clamp(s, 0, 1), c);
    out.copy(c).addScaledVector(fr.T, capShift)
      .addScaledVector(fr.N, Math.cos(ang) * rx * m * capScale)
      .addScaledVector(fr.B, Math.sin(ang) * ry * m * capScale);
    if (lump) {
      const ln = fbm3(out.x * lumpScale, out.y * lumpScale, out.z * lumpScale) - 0.5;
      out.addScaledVector(fr.N, Math.cos(ang) * ln * lump * 2).addScaledVector(fr.B, Math.sin(ang) * ln * lump * 2);
    }
    return out;
  };
  // v layout: [cap0 rings][body rings][cap1 rings]
  const c0 = caps[0] ? capRings : 0, c1 = caps[1] ? capRings : 0;
  const rows = c0 + nv + c1;
  const len = curve.getLength();
  const point = (u, v, out) => {
    const j = Math.round(v * rows);
    if (j < c0) {                           // start cap: dome shrinking toward the pole
      const phi = (1 - j / c0) * Math.PI / 2;
      const [rx] = rad(0);
      return body(u, 0, out, Math.cos(phi), -Math.sin(phi) * Math.min(rx, len * 0.4));
    }
    if (j > c0 + nv) {
      const k = j - (c0 + nv);
      const phi = (k / c1) * Math.PI / 2;
      const [rx] = rad(1);
      return body(u, 1, out, Math.cos(phi), Math.sin(phi) * Math.min(rx, len * 0.4));
    }
    return body(u, (j - c0) / nv, out);
  };
  const g = gridSurface(point, nu, rows, { poles: [caps[0], caps[1]] });
  g.surf = surfFromPoint((u, v, out) => body(u, v, out));
  g.curve = curve; g.rad = rad; g.frameAt = frameAt;
  return g;
}

/** Superellipsoid block (plates, palms, feet). e1 / e2 < 1 → boxier. */
export function block(center, half, opts = {}) {
  const { rot = null, e1 = 0.35, e2 = 0.35, nu = 24, nv = 16, deform = null, lump = 0, lumpScale = 0.12 } = opts;
  const q = rot || new THREE.Quaternion();
  const sp = (x, e) => Math.sign(x) * Math.pow(Math.abs(x), e);
  const loc = new THREE.Vector3(), dir = new THREE.Vector3();
  const point = (u, v, out) => {
    const th = u * Math.PI * 2 - Math.PI, ph = v * Math.PI - Math.PI / 2;
    const cp = Math.cos(ph), spp = Math.sin(ph);
    loc.set(half[0] * sp(cp, e1) * sp(Math.cos(th), e2), half[1] * sp(spp, e1), half[2] * sp(cp, e1) * sp(Math.sin(th), e2));
    dir.set(cp * Math.cos(th), spp, cp * Math.sin(th));
    if (deform) deform(loc, dir);
    out.copy(loc).applyQuaternion(q).add(center);
    if (lump) {
      const n = fbm3(out.x * lumpScale, out.y * lumpScale, out.z * lumpScale) - 0.5;
      out.addScaledVector(_d.copy(dir).applyQuaternion(q), n * lump * 2);
    }
    return out;
  };
  const g = gridSurface(point, nu, nv);
  g.surf = surfFromPoint(point);
  return g;
}

/**
 * Feather: a thick leaf with a raised rachis and a slightly curved blade, from `base` along +dir, blade width along
 * `side`; the top face normal is side × dir (flip `side` to flip the feather). Returns { P, N, I }.
 */
export function feather(base, dir, side, { length, width, thick = 0.5, curl = 0.08, tip = 0.35, ns = 9, nw = 5 }) {
  const P = [], I = [];
  const normal = new THREE.Vector3().crossVectors(side, dir).normalize();   // top face normal (winding relies on it)
  const w = (s) => width * Math.pow(Math.sin(Math.PI * clamp(s, 0, 1) ** 0.8), 0.7) * (s > 1 - tip ? Math.sqrt(Math.max(0, (1 - s) / tip)) * 0.85 + 0.15 : 1);
  // top and bottom sheets, rows along s, columns across width (−1..1)
  const rows = ns, colsN = nw * 2;
  for (let sheet = 0; sheet < 2; sheet++) {
    const sgn = sheet === 0 ? 1 : -1;
    for (let j = 0; j <= rows; j++) {
      const s = j / rows;
      for (let i = 0; i <= colsN; i++) {
        const x = i / colsN * 2 - 1;
        const ww = w(s) * x;
        const h = thick * 0.5 * (1 - x * x * 0.8) * (0.4 + 0.6 * (1 - s)) + (Math.abs(x) < 0.12 ? thick * 0.25 : 0);
        const bend = curl * length * s * s;                 // droop toward −normal at the tip
        const cam = -Math.abs(x) * width * 0.08;             // slight cup
        P.push(new THREE.Vector3().copy(base)
          .addScaledVector(dir, s * length)
          .addScaledVector(side, ww)
          .addScaledVector(normal, sgn * h - bend + cam));
      }
    }
  }
  const cols = colsN + 1, sheetN = (rows + 1) * cols;
  for (let sheet = 0; sheet < 2; sheet++) {
    const o = sheet * sheetN;
    for (let j = 0; j < rows; j++) for (let i = 0; i < colsN; i++) {
      const a = o + j * cols + i, b = a + 1, c = a + cols, d = c + 1;
      if (sheet === 0) I.push(a, b, c, b, d, c); else I.push(a, c, b, b, c, d);
    }
  }
  // stitch the edges (i = 0 and i = colsN, and the base row) so the outline hull sees a closed shape
  for (let j = 0; j < rows; j++) {
    for (const i of [0, colsN]) {
      const a = j * cols + i, c = a + cols, a2 = sheetN + a, c2 = sheetN + c;
      if (i === 0) I.push(a, c, a2, a2, c, c2); else I.push(a, a2, c, a2, c2, c);
    }
  }
  for (let i = 0; i < colsN; i++) { const a = i, b = i + 1, a2 = sheetN + a, b2 = sheetN + b; I.push(a, a2, b, b, a2, b2); }
  return { P, N: smoothNormals(P, I), I };
}

function surfFromPoint(point) {
  const p = new THREE.Vector3(), pu = new THREE.Vector3(), pv = new THREE.Vector3();
  return (u, v) => {
    v = clamp(v, 0.02, 0.98);
    point(u, v, p); point(u + 0.004, v, pu); point(u, v + 0.004, pv);
    const du = pu.sub(p), dv = pv.sub(p);
    const n = new THREE.Vector3().crossVectors(dv, du);
    if (n.lengthSq() < 1e-12) n.set(0, 1, 0); else n.normalize();
    return { p: p.clone(), n, du: du.length() / 0.004, dv: dv.length() / 0.004 };
  };
}

/**
 * Kintsugi cracks: random walks with branches on a part's surf(u, v). Appends ribbons to a glow MeshBuilder.
 * opts: { count, len (m), width (m), vRange, uRange, seed, weights, glow(p) -> [t, side, kind], outward (+n) sign }
 */
export function addCracks(gb, surf, opts) {
  const { count = 6, len = 14, width = 0.55, vRange = [0.1, 0.9], uRange = [0, 1], seed = 1, weights = 0, glow,
    lift = 0.12, step = 1.6, flip = 1 } = opts;
  const R = makeRng(seed);
  const walk = (u, v, heading, length, w0, depth) => {
    const pts = [];
    let travelled = 0;
    while (travelled <= length && pts.length < 40) {
      const s = surf(u, v);
      pts.push(s);
      heading += (R() - 0.5) * 1.1;
      const du = Math.cos(heading) * step / Math.max(0.2, s.du), dv = Math.sin(heading) * step / Math.max(0.2, s.dv);
      u += du; v += dv;
      if (v < vRange[0] || v > vRange[1]) break;
      travelled += step;
      if (depth < 2 && R() < 0.12 && pts.length > 2) walk(u, v, heading + (R() < 0.5 ? 1 : -1) * (0.7 + R() * 0.6), length * 0.45, w0 * 0.7, depth + 1);
    }
    if (pts.length >= 2) ribbon(gb, pts, w0, lift, weights, glow, flip);
  };
  for (let k = 0; k < count; k++) {
    const u = uRange[0] + R() * (uRange[1] - uRange[0]);
    const v = vRange[0] + R() * (vRange[1] - vRange[0]);
    walk(u, v, R() * Math.PI * 2, len * (0.6 + R() * 0.8), width * (0.7 + R() * 0.6), 0);
  }
}

/** Ring seam around a surface at fixed v (joint seams). */
export function addSeam(gb, surf, v, { width = 0.7, weights = 0, glow, lift = 0.1, n = 32, wobble = 0.012, seed = 3 } = {}) {
  const R = makeRng(seed);
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(surf(i / n, v + (R() - 0.5) * wobble * 2));
  ribbon(gb, pts, width, lift, weights, glow, 1, false);
}

function ribbon(gb, pts, w0, lift, weights, glow, flip, taper = true) {
  const P = [], N = [], I = [];
  const m = pts.length;
  for (let i = 0; i < m; i++) {
    const s = pts[i];
    const nxt = pts[Math.min(m - 1, i + 1)].p, prv = pts[Math.max(0, i - 1)].p;
    _a.subVectors(nxt, prv).normalize();
    _b.crossVectors(s.n, _a).normalize();
    const t = i / (m - 1);
    const w = w0 * (taper ? Math.pow(Math.sin(Math.PI * (0.08 + 0.84 * t)), 0.6) : 1) * 0.5;
    const n = s.n.clone().multiplyScalar(flip);
    P.push(s.p.clone().addScaledVector(n, lift).addScaledVector(_b, w), s.p.clone().addScaledVector(n, lift).addScaledVector(_b, -w));
    N.push(n.clone(), n.clone());
    if (i < m - 1) { const a = i * 2; I.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  gb.append(P, N, I, { weights, glow });
}

/** Merge helper: add a grid part to the stone builder and return its surf for cracks. */
export function addPart(builder, part, opts) {
  builder.append(part.P, part.N, part.I, opts);
  return part;
}
