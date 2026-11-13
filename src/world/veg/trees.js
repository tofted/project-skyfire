// Anime tree kit: puffy broadleaf clumps, stacked-cone cedars / pines, pink cherry clouds. Every species has a near
// mesh (a few hundred triangles, sphere-transferred normals so the cel band splits each crown cleanly into light and
// shade, like painted foliage) and a far mesh (one or two blobs) that reads as a painted dab from altitude.
// Unit size: the base tree is ~12 m tall; instances scale it.
import * as THREE from 'three';
import { part, merge, lumpy } from './common.js';

const TRUNK = 0x4a433c, TRUNK_CHERRY = 0x4a3c3e;

function trunk(h, r, color) {
  const g = new THREE.CylinderGeometry(r * 0.65, r, h, 6, 1, true);
  g.translate(0, h / 2, 0);
  return part(g, { color, sway: (x, y) => Math.min(1, y / 14) * 0.6, center: new THREE.Vector3(0, h / 2, 0) });
}

function blob(radius, sx, sy, sz, x, y, z, detail, seed, center, color = 0xffffff) {
  const g = new THREE.IcosahedronGeometry(radius, detail);
  lumpy(g, 0.12, 1.3 / radius, seed);
  g.scale(sx, sy, sz); g.translate(x, y, z);
  const p = part(g, { color, center, sway: (px, py) => Math.min(1, py / 13) });
  // smooth ellipsoid normals (the facets of the low-poly lobe never show in the cel band)
  const pos = p.getAttribute('position'), nrm = p.getAttribute('normal'), v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.set((pos.getX(i) - x) / (sx * sx), (pos.getY(i) - y) / (sy * sy), (pos.getZ(i) - z) / (sz * sz)).normalize();
    nrm.setXYZ(i, v.x, v.y, v.z);
  }
  return p;
}

// Broadleaf (keyaki / oak-like): 4-5 lobes around a crown centre.
function broadleaf(near) {
  const c = new THREE.Vector3(0, 7.0, 0);
  const parts = [];
  if (near) parts.push(trunk(4.6, 0.42, TRUNK));
  if (near) {
    parts.push(blob(3.9, 1.12, 0.88, 1.12, 0, 7.6, 0, 1, 1.3, c));      // 4 lobes × 80 tris
    parts.push(blob(2.8, 1, 0.9, 1, 2.6, 6.3, 0.8, 1, 2.1, c));
    parts.push(blob(2.7, 1, 0.9, 1, -2.4, 6.5, -1.0, 1, 3.7, c));
    parts.push(blob(2.6, 1, 0.9, 1, 0.3, 6.1, -2.6, 1, 4.2, c));
  } else {
    parts.push(blob(4.5, 1.12, 0.92, 1.12, 0, 6.8, 0, 0, 1.3, c));
    parts.push(trunk(3.4, 0.5, TRUNK));
  }
  return merge(parts);
}

// Cedar / pine: stacked cones, dark and tall.
function conifer(near) {
  const parts = [];
  const c = new THREE.Vector3(0, 8, 0);
  if (near) parts.push(trunk(4, 0.35, TRUNK));
  const tiers = near ? [[3.4, 5.5, 3.2], [2.8, 5.0, 6.4], [2.1, 4.4, 9.2], [1.3, 3.6, 11.8]] : [[3.2, 13.0, 2.6]];
  let i = 0;
  for (const [r, h, y] of tiers) {
    const g = new THREE.ConeGeometry(r, h, near ? 8 : 6, 1, false);
    g.translate(0, y + h / 2, 0);
    if (near) lumpy(g, 0.06, 0.9, i * 1.7);
    parts.push(part(g, { center: c, sway: (px, py) => Math.min(1, py / 14) }));
    i++;
  }
  return merge(parts);
}

// Cherry: wide flat crown of many small puffs on a dark twisted trunk.
function cherry(near) {
  const c = new THREE.Vector3(0, 7.0, 0);
  const parts = [];
  if (near) {
    parts.push(trunk(4.8, 0.5, TRUNK_CHERRY));
    const g = new THREE.CylinderGeometry(0.18, 0.3, 3.2, 5, 1, true); g.rotateZ(0.9); g.translate(1.3, 5.2, 0);
    parts.push(part(g, { color: TRUNK_CHERRY, center: c, sway: 0.4 }));
    const g2 = new THREE.CylinderGeometry(0.16, 0.28, 3.0, 5, 1, true); g2.rotateZ(-0.8); g2.rotateY(2.1); g2.translate(-0.9, 5.1, 0.9);
    parts.push(part(g2, { color: TRUNK_CHERRY, center: c, sway: 0.4 }));
    const puffs = [[0, 7.5, 0, 3.6], [3.0, 6.6, 0.8, 2.6], [-2.8, 6.8, -0.8, 2.6], [0.6, 6.4, 2.9, 2.4], [-0.6, 6.5, -2.9, 2.4]];
    let s = 0;
    for (const [x, y, z, r] of puffs) { parts.push(blob(r, 1.12, 0.72, 1.12, x, y, z, 1, 7.1 + s, c)); s++; }
  } else {
    parts.push(blob(4.6, 1.25, 0.7, 1.25, 0, 7.0, 0, 0, 7.1, c));
    parts.push(trunk(4, 0.5, TRUNK_CHERRY));
  }
  return merge(parts);
}

export const SPECIES = {
  broadleaf: {
    near: () => broadleaf(true), far: () => broadleaf(false), normalBlend: 0.78, rim: 1.0, backGlow: 0.6,
    tints: [0x4f9a4c, 0x3f8446, 0x6aa84e, 0x2f6e44],        // painted greens: mid, deep, light (sunny), blue-green
  },
  conifer: {
    near: () => conifer(true), far: () => conifer(false), normalBlend: 0.55, rim: 0.8, backGlow: 0.2,
    tints: [0x2f6a44, 0x255a3e, 0x3a7a48, 0x2a5a52],
  },
  cherry: {
    near: () => cherry(true), far: () => cherry(false), normalBlend: 0.8, rim: 1.2, backGlow: 1.2,
    tints: [0xf7b7cc, 0xf4a7c1, 0xffd6e4, 0xe89ab8],
  },
};
