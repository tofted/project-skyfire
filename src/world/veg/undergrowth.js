// Wave 4 undergrowth kit: reed / grass clumps for the river and lake banks, and low puffy bushes (bank scrub, forest
// edges). Same conventions as trees.js (unit meshes, white parts take the per-instance tint, aSway = wind weight).
//   reed: three crossed, leaning fans of tapered blades (15 triangles, double-sided): reads as a clump from the chase
//         camera and from above (the fans lean, so a clump never collapses into lines seen from the air)
//   bush: three lumpy lobes with ellipsoid normals (60 triangles) so the cel band splits it into light and shade
import * as THREE from 'three';
import { part, merge, lumpy } from './common.js';

function fan(angle, lean, seed) {
  // five blades on a 1.4 m base line, tips spread outward and up to ~1 m (unit height; instances scale it)
  const v = [];
  const r = (k) => { const x = Math.sin(seed * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); };
  for (let i = 0; i < 5; i++) {
    const bx = -0.62 + i * 0.31 + (r(i) - 0.5) * 0.1, w = 0.07 + r(i + 7) * 0.05;
    const tx = bx * 1.55 + (r(i + 3) - 0.5) * 0.25, ty = 0.72 + r(i + 11) * 0.34;
    v.push(bx - w, 0, 0, bx + w, 0, 0, tx, ty, 0.0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.rotateX(lean);                 // the whole fan leans, so it has area seen from above
  g.rotateY(angle);
  return part(g, { color: 0xffffff, flat: true, center: new THREE.Vector3(0, 0.45, 0), sway: (x, y) => Math.min(1, Math.max(0, y) / 0.9) });
}

export function reedClump() {
  return merge([fan(0, 0.32, 1), fan(Math.PI / 3, -0.3, 2), fan((2 * Math.PI) / 3, 0.28, 3)]);
}

function lobe(r, x, y, z, sx, sy, sz, seed, center) {
  const g = new THREE.IcosahedronGeometry(r, 0);
  lumpy(g, 0.14, 1.6 / r, seed);
  g.scale(sx, sy, sz); g.translate(x, y, z);
  const p = part(g, { color: 0xffffff, center, sway: (px, py) => Math.min(1, Math.max(0, py) / 2.4) * 0.6 });
  const pos = p.getAttribute('position'), nrm = p.getAttribute('normal'), n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    n.set((pos.getX(i) - x) / (sx * sx), (pos.getY(i) - y) / (sy * sy), (pos.getZ(i) - z) / (sz * sz)).normalize();
    nrm.setXYZ(i, n.x, n.y, n.z);
  }
  return p;
}

export function bush() {
  // unit bush ~2.4 m wide, ~1.5 m tall
  const c = new THREE.Vector3(0, 0.7, 0);
  return merge([
    lobe(1.0, 0, 0.75, 0, 1.15, 0.8, 1.15, 1.1, c),
    lobe(0.7, 0.75, 0.55, 0.3, 1, 0.85, 1, 2.3, c),
    lobe(0.65, -0.6, 0.5, -0.45, 1, 0.85, 1, 3.7, c),
  ]);
}

export const UNDER = {
  reed: {
    near: reedClump, normalBlend: 0.62, rim: 1.1, backGlow: 1.0,
    // yellow-green reed, fresh green, straw, blue-green
    tints: [0x98b44c, 0x6fa046, 0xc2bc62, 0x5f9058],
  },
  bush: {
    near: bush, normalBlend: 0.82, rim: 0.9, backGlow: 0.5,
    tints: [0x4f8e46, 0x3c7642, 0x66a04c, 0x2f6c4a],
  },
};
