// Small math helpers shared by all systems. Frame-rate independent smoothing everywhere: never lerp by a constant.
import * as THREE from 'three';

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const remap = (v, a, b, c, d) => c + (d - c) * clamp((v - a) / (b - a), 0, 1);
/** Exponential smoothing factor for rate k (1/s) over dt. value += (target - value) * damp(k, dt) */
export const damp = (k, dt) => 1 - Math.exp(-k * dt);
export const dampTo = (cur, target, k, dt) => cur + (target - cur) * damp(k, dt);
export const wrapAngle = (a) => { a = (a + Math.PI) % (Math.PI * 2); if (a < 0) a += Math.PI * 2; return a - Math.PI; };
export const rand = (a = 0, b = 1) => a + Math.random() * (b - a);

/** Deterministic PRNG (mulberry32) — use for world generation so layouts are stable across reloads. */
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Critically damped spring on a scalar (x, v). omega = stiffness in rad/s. */
export function springStep(x, v, target, omega, dt) {
  const f = 1 + 2 * dt * omega;
  const oo = omega * omega;
  const hoo = dt * oo;
  const hhoo = dt * hoo;
  const detInv = 1 / (f + hhoo);
  const nx = (f * x + dt * v + hhoo * target) * detInv;
  const nv = (v + hoo * (target - x)) * detInv;
  return [nx, nv];
}

/** Critically damped spring on a Vector3, in place. vel is a Vector3 kept by the caller. */
export function springVec3(pos, vel, target, omega, dt) {
  for (const k of ['x', 'y', 'z']) {
    const [x, v] = springStep(pos[k], vel[k], target[k], omega, dt);
    pos[k] = x; vel[k] = v;
  }
  return pos;
}

// 2D value noise + fbm (CPU) — cheap, deterministic, for gameplay-side sampling that must match GPU only loosely.
function hash2(x, y) {
  let h = x * 374761393 + y * 668265263;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
export function valueNoise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}
export function fbm2(x, y, oct = 5, lac = 2, gain = 0.5) {
  let s = 0, a = 0.5, f = 1, n = 0;
  for (let i = 0; i < oct; i++) { s += a * valueNoise2(x * f, y * f); n += a; a *= gain; f *= lac; }
  return s / n;
}

const _v = new THREE.Vector3();
/** Closest point on segment ab to p (writes into out). */
export function closestOnSegment(p, a, b, out = new THREE.Vector3()) {
  const ab = _v.subVectors(b, a);
  const len2 = ab.lengthSq();
  const t = len2 > 1e-9 ? clamp(out.subVectors(p, a).dot(ab) / len2, 0, 1) : 0;
  return out.copy(a).addScaledVector(ab, t);
}

/** Squared distance between segments p1-q1 and p2-q2; returns {d2, s, t} (Ericson, RTCD 5.1.9). */
export function segSegDist2(p1, q1, p2, q2) {
  const d1x = q1.x - p1.x, d1y = q1.y - p1.y, d1z = q1.z - p1.z;
  const d2x = q2.x - p2.x, d2y = q2.y - p2.y, d2z = q2.z - p2.z;
  const rx = p1.x - p2.x, ry = p1.y - p2.y, rz = p1.z - p2.z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s, t;
  if (a <= 1e-9 && e <= 1e-9) { s = t = 0; }
  else if (a <= 1e-9) { s = 0; t = clamp(f / e, 0, 1); }
  else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= 1e-9) { t = 0; s = clamp(-c / a, 0, 1); }
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      s = denom !== 0 ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  const cx = p1.x + d1x * s - (p2.x + d2x * t), cy = p1.y + d1y * s - (p2.y + d2y * t), cz = p1.z + d1z * s - (p2.z + d2z * t);
  return { d2: cx * cx + cy * cy + cz * cz, s, t };
}
