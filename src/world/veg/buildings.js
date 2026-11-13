// Villages and landmarks, built from simple solids with painted vertex colours (anime background props).
// Houses: 3 instanced kits (white roof parts take the per-instance roof tint: orange / blue / dark tile / red-brown).
// Landmarks: five-storey pagoda, torii gate, multi-arch vermilion bridge, hilltop shrine — one merged mesh each.
import * as THREE from 'three';
import { part, merge } from './common.js';

const PLASTER = 0xece2cc, WOOD = 0x6a4a36, WOOD_DARK = 0x4a3428, STONE = 0xb9b3a8, VERMILION = 0xe4472f,
  TILE = 0x3d4a63, TILE_EDGE = 0x6b7a96, GOLD = 0xffd36a, ROOF = 0xffffff;

function box(w, h, d, x, y, z, color, ry = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return part(g, { color, flat: true });
}
function cyl(rt, rb, h, x, y, z, color, seg = 8) {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg, 1, false);
  g.translate(x, y + h / 2, z);
  return part(g, { color });
}
/** Gabled roof prism along x: width w (x), depth d (z), eave height y0, ridge height y1, overhang o. */
function gable(w, d, y0, y1, o, color, x = 0, z = 0) {
  const hw = w / 2 + o, hd = d / 2 + o;
  const v = [
    // two slopes
    -hw, y0, -hd, hw, y0, -hd, hw, y1, 0, -hw, y0, -hd, hw, y1, 0, -hw, y1, 0,
    -hw, y0, hd, -hw, y1, 0, hw, y1, 0, -hw, y0, hd, hw, y1, 0, hw, y0, hd,
    // gable ends
    -hw, y0, -hd, -hw, y1, 0, -hw, y0, hd, hw, y0, -hd, hw, y0, hd, hw, y1, 0,
  ];
  // the list above is wound clockwise seen from outside: flip every triangle (b <-> c) so the slopes face out.
  // (Wave 1 shipped it inside-out: from the air the slopes were back-face culled and villages showed white boxes.)
  for (let t = 0; t < v.length; t += 9) for (let k = 0; k < 3; k++) { const a = v[t + 3 + k]; v[t + 3 + k] = v[t + 6 + k]; v[t + 6 + k] = a; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.translate(x, 0, z);
  return part(g, { color, flat: true });
}
/** Hipped roof (4 slopes) — pyramid frustum with an up-turned eave line, used for pagoda tiers and temples. */
function hipRoof(w, d, y0, h, o, color, ridge = 0.15) {   // ridge: top size as a fraction of the base
  const g = new THREE.CylinderGeometry(ridge, 1, h, 4, 1, false);
  g.rotateY(Math.PI / 4);
  g.scale((w / 2 + o) / Math.SQRT1_2, 1, (d / 2 + o) / Math.SQRT1_2);
  g.translate(0, y0 + h / 2, 0);
  return part(g, { color, flat: true });
}

// ---- houses -----------------------------------------------------------------------------------------------------
export function houseKits() {
  // Unit width 1 (x); depth ~1.4; the instance scale is the house width in metres. Big roofs: from the air a village
  // should read as roofs (like the painted map), walls only show from low angles.
  const minka = merge([
    box(1, 0.08, 1.4, 0, 0.04, 0, STONE),
    box(0.9, 0.2, 1.3, 0, 0.18, 0, WOOD),
    box(0.9, 0.26, 1.3, 0, 0.41, 0, PLASTER),
    gable(0.9, 1.3, 0.52, 1.02, 0.17, ROOF),
  ]);
  const townhouse = merge([
    box(1, 0.06, 1.2, 0, 0.03, 0, STONE),
    box(0.94, 0.36, 1.14, 0, 0.23, 0, WOOD),
    box(1.04, 0.05, 1.24, 0, 0.44, 0, ROOF),
    box(0.9, 0.3, 1.1, 0, 0.62, 0, PLASTER),
    gable(0.9, 1.1, 0.76, 1.14, 0.14, ROOF),
  ]);
  const kura = merge([
    box(0.86, 0.1, 1.2, 0, 0.05, 0, STONE),
    box(0.8, 0.18, 1.12, 0, 0.19, 0, TILE),
    box(0.8, 0.42, 1.12, 0, 0.49, 0, PLASTER),
    gable(0.8, 1.12, 0.7, 1.04, 0.12, ROOF),
  ]);
  return { minka, townhouse, kura };
}

// ---- landmarks --------------------------------------------------------------------------------------------------
export function pagoda(height = 58) {
  // Five-storey pagoda (Tō-ji proportions): slender body, wide flared eaves, tall golden sōrin.
  const s = height / 58;
  const parts = [];
  parts.push(box(16 * s, 1.6 * s, 16 * s, 0, 0.8 * s, 0, STONE));
  parts.push(box(12.5 * s, 1.0 * s, 12.5 * s, 0, 2.1 * s, 0, STONE));
  let y = 2.6 * s, w = 8.6 * s;
  for (let i = 0; i < 5; i++) {
    const bodyH = (i === 0 ? 5.6 : 4.2) * s;
    parts.push(box(w, bodyH, w, 0, y + bodyH / 2, 0, PLASTER));
    for (const k of [-1, 1]) {                                   // vermilion posts and rails
      parts.push(box(w * 1.02, 0.5 * s, 0.5 * s, 0, y + bodyH * 0.5, k * w * 0.5, VERMILION));
      parts.push(box(0.5 * s, 0.5 * s, w * 1.02, k * w * 0.5, y + bodyH * 0.5, 0, VERMILION));
      parts.push(box(0.7 * s, bodyH, 0.7 * s, k * w * 0.5, y + bodyH / 2, w * 0.5, VERMILION));
      parts.push(box(0.7 * s, bodyH, 0.7 * s, k * w * 0.5, y + bodyH / 2, -w * 0.5, VERMILION));
    }
    parts.push(box(w * 1.3, 0.9 * s, w * 1.3, 0, y + bodyH + 0.2 * s, 0, VERMILION));   // bracket band
    y += bodyH + 0.6 * s;
    const roofW = w * 2.05;
    parts.push(hipRoof(roofW, roofW, y, 2.4 * s, 0.4 * s, TILE, 0.3));
    parts.push(box(roofW * 1.08, 0.45 * s, roofW * 1.08, 0, y + 0.1 * s, 0, TILE_EDGE));
    for (const [cx, cz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {                    // up-turned corners
      parts.push(box(1.1 * s, 0.5 * s, 1.1 * s, cx * roofW * 0.54, y + 0.55 * s, cz * roofW * 0.54, TILE_EDGE));
    }
    y += 2.0 * s;
    w *= 0.88;
  }
  parts.push(cyl(0.45 * s, 0.8 * s, 13 * s, 0, y, 0, GOLD, 6));
  for (let k = 0; k < 9; k++) parts.push(cyl(1.25 * s, 1.25 * s, 0.32 * s, 0, y + 2 * s + k * 1.05 * s, 0, GOLD, 8));
  return merge(parts);
}

export function torii(height = 16) {
  const s = height / 16;
  const parts = [];
  for (const x of [-4.2, 4.2]) {
    parts.push(cyl(0.55 * s, 0.65 * s, 14.5 * s, x * s, 0, 0, VERMILION, 10));
    parts.push(cyl(0.9 * s, 0.9 * s, 1.1 * s, x * s, 0, 0, 0x222228, 10));
  }
  parts.push(box(10.6 * s, 0.9 * s, 0.9 * s, 0, 11.6 * s, 0, VERMILION));        // nuki
  parts.push(box(1.0 * s, 1.8 * s, 0.7 * s, 0, 13.2 * s, 0, VERMILION));         // gakuzuka
  // kasagi: a long top beam whose ends sweep up
  const segs = 9;
  for (let i = 0; i < segs; i++) {
    const t = (i + 0.5) / segs * 2 - 1;
    const x = t * 6.8 * s, y = 14.6 * s + Math.pow(Math.abs(t), 2.2) * 0.9 * s;
    parts.push(box(13.6 * s / segs * 1.04, 1.2 * s, 1.3 * s, x, y, 0, VERMILION));
    parts.push(box(13.6 * s / segs * 1.04, 0.45 * s, 1.5 * s, x, y + 0.8 * s, 0, 0x2a2a30));
  }
  return merge(parts);
}

/** Multi-arch vermilion bridge from a to b (world Vector3s on the banks), deck clearance above `water`. */
export function bridge(a, b, water) {
  // Kintai-style: a chain of steep wooden arches in vermilion over stone piers.
  const dir = new THREE.Vector3().subVectors(b, a); dir.y = 0;
  const len = dir.length(); dir.normalize();
  const yaw = Math.atan2(dir.x, dir.z);
  const spans = Math.max(1, Math.round(len / 60));
  const width = 9, parts = [];
  const deck0 = Math.max(a.y, b.y, water + 4) + 1.0;
  const archH = 11;
  const N = spans * 12;
  const heightAt = (t) => {
    const u = t * spans, f = u - Math.floor(u);
    return deck0 + archH * Math.pow(Math.sin(Math.PI * f), 0.8);
  };
  for (let i = 0; i < N; i++) {
    const t0 = i / N, t1 = (i + 1) / N;
    const z0 = t0 * len, z1 = t1 * len, y0 = heightAt(t0), y1 = heightAt(t1);
    const mid = (z0 + z1) / 2, ym = (y0 + y1) / 2, seg = Math.hypot(z1 - z0, y1 - y0);
    const tilt = Math.atan2(y1 - y0, z1 - z0);
    const g = new THREE.BoxGeometry(width, 0.7, seg * 1.04); g.rotateX(-tilt); g.translate(0, ym, mid);
    parts.push(part(g, { color: WOOD, flat: true }));
    for (const x of [-width / 2, width / 2]) {
      const r = new THREE.BoxGeometry(0.45, 0.4, seg * 1.04); r.rotateX(-tilt); r.translate(x, ym + 1.6, mid);
      parts.push(part(r, { color: VERMILION, flat: true }));
      const side = new THREE.BoxGeometry(0.4, 1.8, seg * 1.04); side.rotateX(-tilt); side.translate(x, ym - 0.6, mid);
      parts.push(part(side, { color: VERMILION, flat: true }));
      if (i % 2 === 0) parts.push(box(0.5, 1.9, 0.5, x, ym + 0.8, z0, VERMILION));
    }
    // arch ribs under the deck
    const rib = new THREE.BoxGeometry(width * 0.8, 1.2, seg * 1.04); rib.rotateX(-tilt); rib.translate(0, ym - 1.5, mid);
    parts.push(part(rib, { color: VERMILION, flat: true }));
  }
  for (let k = 0; k <= spans; k++) {
    const z = (k / spans) * len, top = heightAt(k / spans) - 0.6;
    parts.push(box(width * 1.15, top - (water - 3), 7, 0, (top + water - 3) / 2, z, STONE));   // stone pier
    parts.push(box(width * 1.3, 1.0, 7.6, 0, top, z, 0x8f8a80));
  }
  const g = merge(parts);
  const m = new THREE.Matrix4().makeRotationY(yaw).setPosition(a.x, 0, a.z);
  g.applyMatrix4(m);
  return g;
}

export function shrine() {
  const parts = [];
  parts.push(box(34, 1.5, 26, 0, 0.75, 0, STONE));
  // main hall
  parts.push(box(20, 7, 14, 0, 5, -2, PLASTER));
  parts.push(box(20.6, 1.2, 14.6, 0, 2.1, -2, VERMILION));
  for (const x of [-9.6, -3.2, 3.2, 9.6]) parts.push(box(0.8, 7, 0.8, x, 5, 5.2, VERMILION));
  parts.push(hipRoof(20, 14, 8.2, 5.5, 3.2, TILE, 0.3));
  parts.push(gable(9, 12, 12.2, 16.2, 0.8, TILE, 0, -2));
  parts.push(box(27, 0.5, 21, 0, 8.4, -2, TILE_EDGE));
  // side halls
  for (const x of [-14, 14]) {
    parts.push(box(6, 4.5, 8, x, 3.7, 6, PLASTER));
    parts.push(gable(6, 8, 5.9, 8.2, 0.8, TILE, x, 6));
  }
  // stone lanterns
  for (const x of [-5, 5]) for (const z of [11, 17]) {
    parts.push(cyl(0.5, 0.7, 2.2, x, 1.5, z, STONE, 6));
    parts.push(box(1.6, 1.2, 1.6, x, 4.3, z, STONE));
    parts.push(hipRoof(1.6, 1.6, 4.9, 0.8, 0.3, STONE, 0.12));
  }
  return merge(parts);
}
