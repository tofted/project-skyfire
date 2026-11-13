// Rider: Kaede (hero, red scarf) or a Crimson knight (cape + plume), seated on the dragon's 'saddle' bone.
// Model: instanceGLB('rider_kaede' | 'rider_knight') with Mixamo-style bone names (a 'mixamorig' prefix is
// accepted), or a procedural stylised fallback with the same names. The seated riding pose is procedural and
// frame-agnostic (direction aiming + two-bone IK on the bind skeleton), so it drives the GLB and the fallback alike:
// hips on the saddle, knees gripping, hands on the reins, leaning into turns and against g-forces, head tracking
// the dragon's gaze target, small hit reactions. Cloth (scarf / cape / plume) is a verlet grid simulated in the
// saddle frame with apparent gravity, relative wind, frame rotation and flutter, colliding loosely with the body.
import * as THREE from 'three';
import { clamp, damp, lerp, smoothstep } from '../core/util.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { instanceGLB, loadGLB } from '../core/assets.js';
import { Builder, frames, tube, Rig, trackGLB, instanceSync, disposeInstance } from './dragon-fallback.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const X = v3(1, 0, 0), Y = v3(0, 1, 0), Z = v3(0, 0, 1);
const _a = v3(), _b = v3(), _c = v3(), _d = v3();
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
const RIDER_H = new Map();                       // GLB kind -> bind height (m)

// ---------------------------------------------------------------------------------------------------------------
// Palettes
const RIDER_PALETTES = {
  kaede: {
    skin: '#f7dcc8', skinShade: '#eec3ae', hair: '#231d2a', jacket: '#bf3a2d', jacketLight: '#d85a44', jacketDark: '#8c2520',
    pants: '#272b3d', boots: '#5e3b25', gloves: '#6d4529', belt: '#4b2e1c', gold: '#d8b060', cap: '#6f4a2e',
    lens: '#a6e0f4', eye: '#2a1e2e', white: '#fbf6ee', mouth: '#c46c6c', scarf: '#c0392b', outline: '#3a2430', armor: '#1b1a22', red: '#b3202a',
  },
  knight: {
    skin: '#3a3440', skinShade: '#2c2832', hair: '#b3202a', jacket: '#1b1a22', jacketLight: '#34323f', jacketDark: '#111016',
    pants: '#1f1d26', boots: '#141318', gloves: '#1b1a22', belt: '#b3202a', gold: '#b89a5a', cap: '#1b1a22',
    lens: '#ff3030', eye: '#ff2a2a', white: '#e8e2d8', mouth: '#1b1a22', scarf: '#b3202a', outline: '#050408', armor: '#1b1a22', red: '#b3202a',
  },
};
const SWATCHES = ['skin', 'skinShade', 'hair', 'jacket', 'jacketLight', 'jacketDark', 'pants', 'boots', 'gloves', 'belt', 'gold', 'cap', 'lens', 'eye', 'white', 'mouth', 'armor', 'red'];

function paletteTexture(pal) {
  const n = SWATCHES.length, c = document.createElement('canvas');
  c.width = n * 8; c.height = 8;
  const g = c.getContext('2d');
  SWATCHES.forEach((k, i) => { g.fillStyle = pal[k]; g.fillRect(i * 8, 0, 8, 8); });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.generateMipmaps = false;
  return t;
}
const swUV = (name) => [(SWATCHES.indexOf(name) + 0.5) / SWATCHES.length, 0.5];

// ---------------------------------------------------------------------------------------------------------------
// Procedural rider (T-pose bind, Mixamo names, origin at the hips joint, +Z forward, +X left, metres).
const HUMAN = [
  ['Hips', null, [0, 0, 0]], ['Spine', 'Hips', [0, 0.1, 0]], ['Spine1', 'Spine', [0, 0.2, 0]], ['Spine2', 'Spine1', [0, 0.31, 0]],
  ['Neck', 'Spine2', [0, 0.45, 0]], ['Head', 'Neck', [0, 0.53, 0.005], [0, 0.26, 0]],
];
for (const [S, s] of [['Left', 1], ['Right', -1]]) {
  HUMAN.push(
    [S + 'Shoulder', 'Spine2', [0.035 * s, 0.41, 0]], [S + 'Arm', S + 'Shoulder', [0.16 * s, 0.415, 0]],
    [S + 'ForeArm', S + 'Arm', [0.42 * s, 0.415, 0]], [S + 'Hand', S + 'ForeArm', [0.65 * s, 0.415, 0], [0.13 * s, 0, 0]],
    [S + 'UpLeg', 'Hips', [0.09 * s, -0.03, 0]], [S + 'Leg', S + 'UpLeg', [0.09 * s, -0.44, 0.01]],
    [S + 'Foot', S + 'Leg', [0.09 * s, -0.83, 0]], [S + 'ToeBase', S + 'Foot', [0.09 * s, -0.88, 0.12], [0, 0, 0.08]],
  );
}

function ellipsoid(b, c, r, w, sw, seg = 10, ring = 12, cut = null) {
  // Latitude/longitude ellipsoid; cut(nx, ny, nz) -> true skips a face (hair face opening etc.).
  const rows = [];
  for (let i = 0; i <= seg; i++) {
    const phi = (i / seg) * Math.PI, row = [];
    for (let k = 0; k <= ring; k++) {
      const th = (k / ring) * TAU;
      const nx = Math.sin(phi) * Math.sin(th), ny = Math.cos(phi), nz = Math.sin(phi) * Math.cos(th);
      row.push(b.vert(v3(c.x + nx * r.x, c.y + ny * r.y, c.z + nz * r.z), ...swUV(sw), typeof w === 'function' ? w(ny) : w));
    }
    rows.push(row);
  }
  for (let i = 0; i < seg; i++) for (let k = 0; k < ring; k++) {
    if (cut) {
      const phi = ((i + 0.5) / seg) * Math.PI, th = ((k + 0.5) / ring) * TAU;
      if (cut(Math.sin(phi) * Math.sin(th), Math.cos(phi), Math.sin(phi) * Math.cos(th))) continue;
    }
    const a = rows[i][k], bb = rows[i][k + 1], cc = rows[i + 1][k + 1], d = rows[i + 1][k];
    b.tri(a, cc, bb); b.tri(a, d, cc);
  }
}

function capsule(b, p0, p1, r0, r1, w, sw, radial = 10, flat = 1) {
  const n = 6, pts = [];
  for (let i = 0; i <= n; i++) pts.push(p0.clone().lerp(p1, i / n));
  const up = Math.abs(v3().subVectors(p1, p0).normalize().y) > 0.9 ? Z : Y;
  const fr = frames(pts, up);
  tube(b, fr, {
    radial, shape: (i, th) => { const r = lerp(r0, r1, i / n); return [Math.sin(th) * r, Math.cos(th) * r * flat]; },
    uv: () => swUV(sw), weight: typeof w === 'function' ? (i) => w(i / n) : () => w, capStart: r0 * 0.9, capEnd: r1 * 0.9,
  });
}

function buildRiderGeometry(kind, boneIndex) {
  const b = new Builder(boneIndex), glow = new Builder(boneIndex);
  const P = {};
  for (const [name, , p] of HUMAN) P[name] = v3(...p);
  const W = (bone) => [[bone, 1]];
  const blend = (a, c) => (t) => [[a, 1 - t], [c, t]];
  const knight = kind === 'knight';
  // Torso: pelvis, abdomen, chest.
  ellipsoid(b, v3(0, -0.015, -0.005), v3(0.15, 0.1, 0.115), W('Hips'), 'pants');
  const torso = (y0, y1, rx0, rx1, rz0, rz1, w, sw, n = 6) => {
    const pts = []; for (let i = 0; i <= n; i++) pts.push(v3(0, lerp(y0, y1, i / n), -0.005));
    tube(b, frames(pts, Z), {
      radial: 14, shape: (i, th) => { const t = i / n; return [Math.sin(th) * lerp(rx0, rx1, t), Math.cos(th) * lerp(rz0, rz1, t)]; },
      uv: () => swUV(sw), weight: (i) => w(i / n), capStart: 0.02, capEnd: 0.03,
    });
  };
  torso(0.0, 0.22, 0.135, 0.13, 0.1, 0.1, blend('Spine', 'Spine1'), knight ? 'armor' : 'jacket');
  torso(0.2, 0.44, 0.14, 0.165, 0.105, 0.11, blend('Spine1', 'Spine2'), knight ? 'armor' : 'jacket');
  if (!knight) {
    torso(0.0, 0.06, 0.142, 0.14, 0.108, 0.106, () => [['Spine', 1]], 'belt', 2);       // belt
    ellipsoid(b, v3(0, 0.03, 0.105), v3(0.03, 0.022, 0.012), W('Spine'), 'gold', 6, 8);   // buckle
    for (const s of [1, -1]) ellipsoid(b, v3(0.12 * s, 0.0, 0.05), v3(0.035, 0.045, 0.03), W('Hips'), 'belt', 6, 8);   // pouches
    torso(0.36, 0.47, 0.1, 0.075, 0.085, 0.07, () => [['Spine2', 1]], 'jacketDark', 3);   // collar
    ellipsoid(b, v3(0, 0.3, 0.1), v3(0.05, 0.1, 0.012), W('Spine2'), 'jacketDark', 6, 8);   // jacket front seam
  } else {
    for (let k = 0; k < 4; k++) torso(0.06 + k * 0.1, 0.075 + k * 0.1, 0.15 + k * 0.006, 0.152 + k * 0.006, 0.115, 0.117, () => [[k < 2 ? 'Spine1' : 'Spine2', 1]], 'red', 1);   // lacing
    // Kusazuri (skirt plates) hanging from the waist.
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * TAU + 0.26;
      const c = v3(Math.sin(a) * 0.15, -0.1, Math.cos(a) * 0.12);
      ellipsoid(b, c, v3(Math.abs(Math.cos(a)) * 0.06 + 0.015, 0.1, Math.abs(Math.sin(a)) * 0.05 + 0.015), W('Hips'), k % 2 ? 'armor' : 'jacketLight', 6, 8);
    }
  }
  // Neck and head.
  capsule(b, v3(0, 0.43, -0.005), v3(0, 0.56, 0.0), 0.043, 0.04, W('Neck'), 'skin', 8);
  const hc = v3(0, 0.645, 0.012);
  ellipsoid(b, hc, v3(0.1, 0.118, 0.108), (ny) => [['Head', 1]], knight ? 'armor' : 'skin', 12, 14);
  ellipsoid(b, v3(0, 0.575, 0.05), v3(0.068, 0.05, 0.06), W('Head'), knight ? 'armor' : 'skin', 8, 10);    // jaw / chin
  if (!knight) {
    // Bob hair: shell around the head, face opening in front below the fringe.
    ellipsoid(b, v3(0, 0.655, 0.0), v3(0.112, 0.13, 0.122), W('Head'), 'hair', 12, 16, (nx, ny, nz) => nz > 0.35 && ny < 0.42);
    ellipsoid(b, v3(0, 0.6, -0.02), v3(0.118, 0.085, 0.11), W('Head'), 'hair', 8, 14, (nx, ny, nz) => nz > 0.1 || ny > 0.6);   // bob skirt
    ellipsoid(b, v3(0, 0.715, 0.078), v3(0.095, 0.035, 0.04), W('Head'), 'hair', 6, 12);   // fringe
    // Aviator cap + goggles.
    ellipsoid(b, v3(0, 0.672, -0.005), v3(0.118, 0.128, 0.125), W('Head'), 'cap', 10, 16, (nx, ny) => ny < 0.35);
    for (const s of [1, -1]) {
      ellipsoid(b, v3(0.105 * s, 0.64, -0.01), v3(0.02, 0.05, 0.04), W('Head'), 'cap', 6, 8);    // ear flaps
      const g = v3(0.043 * s, 0.745, 0.095);
      capsule(b, g, g.clone().add(v3(0, 0.012, 0.022)), 0.032, 0.032, W('Head'), 'gold', 10);
      ellipsoid(b, g.clone().add(v3(0, 0.013, 0.026)), v3(0.026, 0.026, 0.008), W('Head'), 'lens', 6, 10);
      // Eyes (big anime eyes, dark with a highlight).
      ellipsoid(b, v3(0.038 * s, 0.638, 0.101), v3(0.018, 0.024, 0.008), W('Head'), 'eye', 6, 8);
      ellipsoid(b, v3(0.032 * s, 0.646, 0.107), v3(0.006, 0.007, 0.003), W('Head'), 'white', 4, 6);
    }
    ellipsoid(b, v3(0, 0.735, 0.0), v3(0.121, 0.012, 0.126), W('Head'), 'belt', 4, 16);   // goggle strap
    ellipsoid(b, v3(0, 0.592, 0.1), v3(0.012, 0.004, 0.004), W('Head'), 'mouth', 4, 6);
    // Scarf wrap around the neck.
    torso(0.44, 0.52, 0.074, 0.066, 0.07, 0.064, () => [['Neck', 1]], 'jacket', 3);
    ellipsoid(b, v3(0.03, 0.47, -0.07), v3(0.04, 0.035, 0.03), W('Neck'), 'jacket', 6, 8);
  } else {
    // Kabuto: dome, neck guard, horns, crest; mask with glowing eyes.
    ellipsoid(b, v3(0, 0.68, -0.005), v3(0.125, 0.12, 0.13), W('Head'), 'armor', 10, 16, (nx, ny) => ny < 0.2);
    for (let k = 0; k < 3; k++) torso(0.62 - k * 0.035, 0.6 - k * 0.035, 0.13 + k * 0.022, 0.14 + k * 0.024, 0.13 + k * 0.022, 0.14 + k * 0.024, () => [['Head', 1]], k === 1 ? 'red' : 'armor', 1);
    for (const s of [1, -1]) {
      const h0 = v3(0.07 * s, 0.76, 0.06);
      const pts = []; for (let i = 0; i <= 8; i++) { const t = i / 8; pts.push(h0.clone().add(v3(0.1 * s * t, 0.34 * t, 0.06 * t - 0.12 * t * t))); }
      tube(b, frames(pts, Z), { radial: 8, shape: (i, th) => { const r = lerp(0.025, 0.003, i / 8); return [Math.sin(th) * r, Math.cos(th) * r * 0.7]; }, uv: () => swUV('armor'), weight: () => W('Head'), capStart: 0.01, capEnd: 0.003 });
      ellipsoid(glow, v3(0.037 * s, 0.645, 0.106), v3(0.016, 0.006, 0.006), W('Head'), 'eye', 4, 6);
    }
    ellipsoid(b, v3(0, 0.77, 0.1), v3(0.03, 0.05, 0.012), W('Head'), 'gold', 6, 8);   // maedate crest
  }
  // Arms.
  for (const [S, s] of [['Left', 1], ['Right', -1]]) {
    const sh = P[S + 'Arm'], el = P[S + 'ForeArm'], wr = P[S + 'Hand'];
    ellipsoid(b, sh.clone().add(v3(0.0, 0.0, 0)), v3(0.062, 0.058, 0.06), (ny) => [['Spine2', 0.4], [S + 'Arm', 0.6]], knight ? 'armor' : 'jacket', 8, 10);
    capsule(b, sh, el, 0.05, 0.043, W(S + 'Arm'), knight ? 'armor' : 'jacket', 10);
    capsule(b, el, wr, 0.043, 0.036, W(S + 'ForeArm'), knight ? 'armor' : 'jacket', 10);
    capsule(b, wr.clone().add(v3(-0.03 * s, 0, 0)), wr.clone().add(v3(-0.005 * s, 0, 0)), 0.042, 0.042, W(S + 'ForeArm'), knight ? 'red' : 'jacketLight', 10);   // cuff
    ellipsoid(b, wr.clone().add(v3(0.06 * s, -0.004, 0.005)), v3(0.058, 0.026, 0.042), W(S + 'Hand'), 'gloves', 6, 10);
    ellipsoid(b, wr.clone().add(v3(0.035 * s, -0.005, 0.045)), v3(0.03, 0.015, 0.016), W(S + 'Hand'), 'gloves', 5, 8);   // thumb
    if (knight) ellipsoid(b, sh.clone().add(v3(0.03 * s, 0.035, 0)), v3(0.085, 0.03, 0.095), W(S + 'Arm'), 'armor', 6, 10);   // sode
    // Legs.
    const hip = P[S + 'UpLeg'], kn = P[S + 'Leg'], an = P[S + 'Foot'], toe = P[S + 'ToeBase'];
    capsule(b, hip.clone().add(v3(0, 0.03, 0)), kn, 0.078, 0.055, W(S + 'UpLeg'), 'pants', 10);
    capsule(b, kn, an, 0.052, 0.042, W(S + 'Leg'), knight ? 'armor' : 'pants', 10);
    capsule(b, kn.clone().lerp(an, 0.35), an.clone().add(v3(0, -0.02, 0)), 0.056, 0.05, W(S + 'Leg'), 'boots', 10);   // boot shaft
    ellipsoid(b, an.clone().add(v3(0, -0.035, 0.035)), v3(0.046, 0.042, 0.1), (ny) => [['Foot', 0], [S + 'Foot', 1]], 'boots', 6, 10);
    ellipsoid(b, toe.clone().add(v3(0, -0.005, 0.02)), v3(0.042, 0.03, 0.06), W(S + 'ToeBase'), 'boots', 6, 10);
    ellipsoid(b, kn.clone().add(v3(0, 0, 0.02)), v3(0.058, 0.058, 0.058), (ny) => [[S + 'UpLeg', 0.5], [S + 'Leg', 0.5]], knight ? 'jacketLight' : 'pants', 6, 8);
  }
  return { body: b.geometry(), glow: glow.count ? glow.geometry({ weld: false }) : null };
}

const riderCache = new Map();
function createFallbackRider(game, kind) {
  const pal = RIDER_PALETTES[kind] || RIDER_PALETTES.kaede;
  const index = {}; HUMAN.forEach(([n], i) => { index[n] = i; });
  if (!riderCache.has(kind)) riderCache.set(kind, { ...buildRiderGeometry(kind, index), tex: paletteTexture(pal) });
  const data = riderCache.get(kind);
  const scene = new THREE.Group(); scene.name = `rider_${kind}_fallback`;
  const bones = new Map(), list = [];
  for (const [name, parent, p, tip] of HUMAN) {
    const bone = new THREE.Bone(); bone.name = name;
    const pp = parent ? HUMAN.find((h) => h[0] === parent)[2] : [0, 0, 0];
    bone.position.set(p[0] - pp[0], p[1] - pp[1], p[2] - pp[2]);
    if (tip) bone.userData.tip = v3(...tip);
    (parent ? bones.get(parent) : scene).add(bone);
    bones.set(name, bone); list.push(bone);
  }
  scene.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(list);
  const mat = game.toon ? game.toon.material({ map: data.tex, color: 0xffffff, steps: 3, rim: 0xfff0e0 }) : new THREE.MeshToonMaterial({ map: data.tex });
  const mesh = new THREE.SkinnedMesh(data.body, mat);
  mesh.name = 'rider_body';
  scene.add(mesh); mesh.bind(skeleton, new THREE.Matrix4());
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.boundingSphere = new THREE.Sphere(v3(0, 0.2, 0), 1.4);
  const skinned = [mesh];
  if (game.toon) { const o = game.toon.outline(mesh, { width: 0.009 }); if (o) o.boundingSphere = mesh.boundingSphere; }
  let glowMat = null;
  if (data.glow) {
    glowMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(pal.eye).multiplyScalar(4) });
    const g = new THREE.SkinnedMesh(data.glow, glowMat);
    scene.add(g); g.bind(skeleton, new THREE.Matrix4()); g.boundingSphere = mesh.boundingSphere;
    skinned.push(g);
  }
  return { scene, bones, skeleton, skinned, fallback: true, materials: { body: mat, glow: glowMat } };
}

// ---------------------------------------------------------------------------------------------------------------
// Verlet cloth grid (rows along the flow, cols across). Row 0 is pinned to anchors every step.
class VerletCloth {
  constructor({ cols, rows, seg, width, drag = 5, flutter = 1, stiffBend = 0.35, color, game, taper = null, alphaMap = null }) {
    this.cols = cols; this.rows = rows; this.seg = seg; this.width = width; this.drag = drag; this.flutter = flutter;
    const n = cols * rows;
    this.p = new Float32Array(n * 3); this.q = new Float32Array(n * 3);
    this.cons = [];
    const id = (r, c) => r * cols + c;
    const wAt = (r) => (typeof width === 'function' ? width(r / (rows - 1)) : width);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (r < rows - 1) this.cons.push([id(r, c), id(r + 1, c), seg, 1]);
      if (c < cols - 1) this.cons.push([id(r, c), id(r, c + 1), wAt(r) / (cols - 1), 1]);
      if (r < rows - 1 && c < cols - 1) {
        const d = Math.hypot(seg, (wAt(r) + wAt(r + 1)) / 2 / (cols - 1));
        this.cons.push([id(r, c), id(r + 1, c + 1), d, 0.6]); this.cons.push([id(r, c + 1), id(r + 1, c), d, 0.6]);
      }
      if (r < rows - 2) this.cons.push([id(r, c), id(r + 2, c), seg * 2, stiffBend]);
    }
    // Mesh
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.p, 3).setUsage(THREE.DynamicDrawUsage));
    const uv = new Float32Array(n * 2), idx = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { uv[id(r, c) * 2] = c / (cols - 1); uv[id(r, c) * 2 + 1] = 1 - r / (rows - 1); }
    for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) { const a = id(r, c), b = id(r + 1, c), cc = id(r + 1, c + 1), d = id(r, c + 1); idx.push(a, b, cc, a, cc, d); }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    this.geometry = g;
    const mat = game.toon ? game.toon.material({ color, side: THREE.DoubleSide, steps: 3, alphaTest: alphaMap ? 0.5 : 0 })
      : new THREE.MeshToonMaterial({ color, side: THREE.DoubleSide });
    if (alphaMap) { mat.alphaMap = alphaMap; mat.alphaTest = 0.5; mat.needsUpdate = true; }
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false; this.mesh.castShadow = true; this.mesh.name = 'rider_cloth';
    this.material = mat;
    this.init = false; this.t = Math.random() * 10;
    this.taper = taper;
  }
  reset(anchors) {
    const { cols, rows, seg } = this;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = (r * cols + c) * 3, a = anchors[c];
      this.p[i] = a.x; this.p[i + 1] = a.y - r * seg * 0.3; this.p[i + 2] = a.z - r * seg * 0.95;
      this.q[i] = this.p[i]; this.q[i + 1] = this.p[i + 1]; this.q[i + 2] = this.p[i + 2];
    }
    this.init = true;
  }
  /** ctx: { force (apparent gravity, local), wind (relative air velocity, local), omega (frame rate, local), spheres [{c,r}] } */
  step(dt, anchors, ctx) {
    if (!this.init) this.reset(anchors);
    if (dt <= 0) { this._pin(anchors); this._upload(); return; }
    const steps = Math.max(1, Math.ceil(dt / (1 / 180))), h = dt / steps;
    const { cols, rows, p, q } = this;
    const V = ctx.wind.length();
    this.t += dt;
    for (let s = 0; s < steps; s++) {
      this._pin(anchors);
      for (let r = 1; r < rows; r++) for (let c = 0; c < cols; c++) {
        const i = (r * cols + c) * 3;
        const x = p[i], y = p[i + 1], z = p[i + 2];
        let vx = (x - q[i]) / h, vy = (y - q[i + 1]) / h, vz = (z - q[i + 2]) / h;
        const sp = Math.hypot(vx, vy, vz);
        if (sp > 60) { vx *= 60 / sp; vy *= 60 / sp; vz *= 60 / sp; }
        const t01 = r / (rows - 1);
        // flutter: travelling snake + twist waves along the ribbon, growing toward the free end and with airspeed
        // (the twist turns the broad side toward the viewer every half wave, like the key art's streaming scarf)
        const f = this.flutter * (1 + 0.12 * V) * t01;
        const ph = this.t * (13 + 0.2 * V) - r * 0.85;
        const side = cols > 1 ? (c / (cols - 1)) * 2 - 1 : 0;
        const fx = Math.sin(ph * 0.8 + 0.4) * f * 9 + Math.cos(ph * 1.7 + c) * f * 2;
        const fy = Math.cos(ph * 1.05) * f * 8 + Math.sin(ph) * side * f * 14;
        let ax = ctx.force.x + this.drag * (ctx.wind.x - vx) + fx;
        let ay = ctx.force.y + this.drag * (ctx.wind.y - vy) + fy;
        let az = ctx.force.z + this.drag * (ctx.wind.z - vz);
        // frame rotation: a point at rest in the world drifts by -omega x r
        const om = ctx.omega;
        const rx = om.y * z - om.z * y, ry = om.z * x - om.x * z, rz = om.x * y - om.y * x;
        q[i] = x; q[i + 1] = y; q[i + 2] = z;
        p[i] = x + vx * h * 0.995 + ax * h * h - rx * h;
        p[i + 1] = y + vy * h * 0.995 + ay * h * h - ry * h;
        p[i + 2] = z + vz * h * 0.995 + az * h * h - rz * h;
      }
      for (let it = 0; it < 4; it++) {
        for (const [a, b, rest, k] of this.cons) {
          const ia = a * 3, ib = b * 3;
          const dx = p[ib] - p[ia], dy = p[ib + 1] - p[ia + 1], dz = p[ib + 2] - p[ia + 2];
          const L = Math.hypot(dx, dy, dz) || 1e-6;
          const diff = ((L - rest) / L) * k;
          const pa = a < cols, pb = b < cols;
          if (pa && pb) continue;
          const wa = pa ? 0 : pb ? 1 : 0.5, wb = pb ? 0 : pa ? 1 : 0.5;
          p[ia] += dx * diff * wa; p[ia + 1] += dy * diff * wa; p[ia + 2] += dz * diff * wa;
          p[ib] -= dx * diff * wb; p[ib + 1] -= dy * diff * wb; p[ib + 2] -= dz * diff * wb;
        }
        for (const sph of ctx.spheres) {
          for (let k = cols; k < cols * rows; k++) {
            const i = k * 3;
            const dx = p[i] - sph.c.x, dy = p[i + 1] - sph.c.y, dz = p[i + 2] - sph.c.z;
            const L = Math.hypot(dx, dy, dz);
            if (L < sph.r && L > 1e-6) { const s2 = sph.r / L; p[i] = sph.c.x + dx * s2; p[i + 1] = sph.c.y + dy * s2; p[i + 2] = sph.c.z + dz * s2; }
          }
        }
      }
    }
    this._upload();
  }
  _pin(anchors) {
    for (let c = 0; c < this.cols; c++) {
      const i = c * 3, a = anchors[c];
      this.q[i] = this.p[i] = a.x; this.q[i + 1] = this.p[i + 1] = a.y; this.q[i + 2] = this.p[i + 2] = a.z;
    }
  }
  _upload() {
    const pos = this.geometry.attributes.position;
    pos.needsUpdate = true;
    this.geometry.computeVertexNormals();
  }
  dispose() {
    this.geometry.dispose();
    if (this.ownAlpha) this.material.alphaMap?.dispose();          // wave 4: the tattered-cape alpha is per instance
    this.material.dispose();
  }
}

function tatteredAlpha() {
  const c = document.createElement('canvas'); c.width = 64; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 64, 128);
  g.fillStyle = '#000';
  g.beginPath(); g.moveTo(0, 128);
  let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let x = 0; x <= 64; x += 4) g.lineTo(x, 128 - (10 + rnd() * 34) * (0.5 + 0.5 * Math.sin(x * 0.3 + 1) ** 2));
  g.lineTo(64, 128); g.closePath(); g.fill();
  for (let k = 0; k < 5; k++) { g.beginPath(); g.ellipse(8 + rnd() * 48, 50 + rnd() * 50, 2 + rnd() * 4, 3 + rnd() * 7, 0, 0, TAU); g.fill(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace;
  return t;
}

// ---------------------------------------------------------------------------------------------------------------
export class Rider {
  constructor(game, { kind = 'kaede', dragon = null, model = 'auto' } = {}) {
    this.game = game; this.kind = kind === 'knight' ? 'knight' : 'kaede'; this.dragon = dragon;
    this.pal = RIDER_PALETTES[this.kind];
    this.root = new THREE.Group(); this.root.name = `rider:${this.kind}`;
    this.seat = new THREE.Group(); this.root.add(this.seat);          // seat offset (crouch), model inside
    this.lean = { roll: new Spring2(2, 0.6), pitch: new Spring2(2, 0.6), yaw: new Spring2(3, 0.7) };
    this.flinch = 0; this._t = Math.random() * 10;
    this._gaze = null;
    this.eye = v3(0, 0.62, 0);                        // eye point in the rider root (saddle) frame, per frame
    this.cloth = [];
    const noGLB = model === 'fallback';
    const cached = noGLB ? null : trackGLB('rider_' + this.kind, loadGLB);
    let usedGLB = false;
    if (cached) { try { usedGLB = this._useGLB(instanceSync(cached, cloneSkinned)); } catch (e) { console.warn('[rider] GLB instancing failed; procedural rider', e); } }
    if (!usedGLB) this._setModel(createFallbackRider(game, this.kind));
    if (this.kind === 'kaede') {
      const mk = (len, w0, w1) => new VerletCloth({ game, cols: 2, rows: 11, seg: len / 10, width: (t) => lerp(w0, w1, t), drag: 4.5, flutter: 1.1, color: this.pal.scarf });
      this.cloth.push({ sim: mk(1.35, 0.13, 0.08), anchor: 'scarfA' }, { sim: mk(1.0, 0.11, 0.07), anchor: 'scarfB' });
    } else if (!this.model?.capeBones) {
      // Procedural knight only: the GLB knight has its own rigged cape and plume (driven in _installHandlers).
      const cape = new VerletCloth({ game, cols: 5, rows: 9, seg: 0.14, width: (t) => lerp(0.44, 0.62, t), drag: 3.2, flutter: 0.6, stiffBend: 0.5, color: '#9e1c26', alphaMap: tatteredAlpha() });
      cape.ownAlpha = true;
      this.cloth.push({ sim: cape, anchor: 'cape' });
      this.cloth.push({ sim: new VerletCloth({ game, cols: 2, rows: 8, seg: 0.1, width: (t) => lerp(0.07, 0.02, t), drag: 5, flutter: 1.2, color: this.pal.hair }), anchor: 'plume' });
    }
    for (const c of this.cloth) this.root.add(c.sim.mesh);
    this.ready = cached || noGLB ? Promise.resolve(!!this.model && !this.model.fallback) : instanceGLB('rider_' + this.kind)
      .then((inst) => {
        if (!inst || this.disposed) return false;
        try { return this._useGLB(inst); } catch (e) { console.warn('[rider] GLB setup failed; keeping the procedural rider', e); return false; }
      })
      .catch((e) => { console.warn('[rider] GLB load failed', e); return false; });
  }

  /** Drop the verlet cape/plume once a GLB with its own rigged cape is in (the knight). */
  _dropCloth(anchors) {
    for (const c of this.cloth.slice()) {
      if (!anchors.includes(c.anchor)) continue;
      this.root.remove(c.sim.mesh); c.sim.dispose();
      this.cloth.splice(this.cloth.indexOf(c), 1);
    }
  }

  /** Adopt a rider GLB (Mixamo names, 'mixamorig' prefix accepted): toon materials, 1.65 m, hips at the seat. */
  _useGLB(inst) {
    const game = this.game;
    const bones = new Map();
    for (const [n, b] of inst.bones) bones.set(n.replace(/^mixamorig[:_]?/i, ''), b);
    if (!bones.has('Hips') || !bones.has('Spine')) { console.warn('[rider] GLB lacks Mixamo bones; keeping the fallback'); return false; }
    for (const [n, b] of bones) b.name = n;
    const toon = game.toon;
    // Collect first, convert after: outlining adds child meshes, which a live traverse() would visit again.
    const meshes = [];
    inst.scene.traverse((o) => { if (o.isMesh && !o.userData.isOutline) meshes.push(o); });
    for (const o of meshes) {
      const old = Array.isArray(o.material) ? o.material[0] : o.material;
      // _TOON_DATA (humanoids README): x outline width multiplier (thin finger lines), y shadow bias, z rim mask.
      const g = o.geometry, td = g?.attributes?._toon_data;
      const vertexData = !!td && !!toon;
      if (vertexData && !g.attributes.color) g.setAttribute('color', td);
      const m = toon ? toon.material({ map: old?.map || null, color: old?.map ? 0xffffff : (old?.color?.getHex?.() ?? 0xffffff), steps: 3, vertexData })
        : new THREE.MeshToonMaterial({ map: old?.map || null });
      if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
      o.material = m; o.castShadow = true; o.receiveShadow = true;
      if (o.isSkinnedMesh) o.boundingSphere = new THREE.Sphere(v3(0, 0.8, 0), 1.5);
      if (toon) { const ol = toon.outline(o, { width: 0.009, vertexData }); if (ol && o.isSkinnedMesh) ol.boundingSphere = o.boundingSphere; }
    }
    const capeBones = ['CapeLeft1', 'CapeMid1', 'CapeRight1'].every((n) => bones.has(n));
    if (capeBones) this._dropCloth(['cape', 'plume']);
    // Normalise height to ~1.65 m and put the hips joint at the seat origin (height measured once per GLB:
    // a skinned bounding box skins every vertex).
    inst.scene.updateMatrixWorld(true);
    let h = RIDER_H.get(this.kind);
    if (h === undefined) { const box = new THREE.Box3().setFromObject(inst.scene); h = box.max.y - box.min.y; RIDER_H.set(this.kind, h); }
    const s = h > 0.3 && (h < 1.4 || h > 1.95) ? 1.65 / h : 1;
    inst.scene.scale.setScalar(s);
    inst.scene.updateMatrixWorld(true);
    const hip = bones.get('Hips').getWorldPosition(v3()).sub(inst.scene.getWorldPosition(v3()));
    inst.scene.position.sub(hip);
    this._setModel({ scene: inst.scene, bones, skinned: inst.skinned, fallback: false, materials: {}, capeBones });
    return true;
  }

  _setModel(model) {
    // wave 4: the replaced model's skeletons (bone textures) and its per-instance materials (maps are shared)
    if (this.model) { this.seat.remove(this.model.scene); disposeInstance(this.model.scene, { materials: true }); }
    this.model = model;
    this.seat.add(model.scene);
    this.seat.updateMatrixWorld(true);
    // Rig relative to the seat group so model-space == saddle frame (+Z forward).
    const wrap = { scene: this.seat };
    this.rig = new Rig(wrap);
    this._idx = {};
    for (const n of ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
      'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot', 'LeftToeBase', 'RightToeBase']) this._idx[n] = this.rig.i(n);
    this._installHandlers();
    // (24.09: the skeleton holds nothing renderable — hidden from the render traversals, matrices still update)
    const hips = model.bones?.get?.('Hips');
    if (hips?.isBone) { let only = true; hips.traverse((c) => { if (!c.isBone) only = false; }); if (only) { hips.visible = false; hips.userData.traversalHidden = true; } }
  }

  /** Parent under the dragon's saddle bone; q/s compensate that bone's bind orientation and scale. */
  attach(bone, q = new THREE.Quaternion(), s = 1) {
    if (this.root.parent) this.root.parent.remove(this.root);
    bone.add(this.root);
    this.root.quaternion.copy(q);
    this.root.scale.setScalar(s);
    this.root.position.set(0, 0.1 * (1 / Math.max(1e-6, s)) * s, -0.04);
    this.root.position.set(0, 0.1, -0.04);
    for (const c of this.cloth) c.sim.init = false;
  }

  hit(dir, strength = 1) {
    // Jolt: pitch back / roll away from the hit, a quick flinch of the head.
    const d = _a.copy(dir || Y);
    this.lean.pitch.v -= 2.2 * strength; this.lean.roll.v += (d.x >= 0 ? 1 : -1) * 2.6 * strength;
    this.flinch = Math.min(1, this.flinch + 0.8 * strength);
  }

  _installHandlers() {
    const rig = this.rig, H = rig.handlers, I = this._idx;
    H.fill(null);
    const aim = (i, dirModel, Qinh) => {
      const cur = _a.copy(rig.dir[i]).applyQuaternion(_qa.copy(Qinh).multiply(_qb.copy(rig.Qb[i]).invert()));
      return _qa.setFromUnitVectors(cur.normalize(), _b.copy(dirModel).normalize()).multiply(Qinh);
    };
    // Hips carry the lean (roll into turns, pitch forward/back).
    if (I.Hips >= 0) H[I.Hips] = (i, Qinh) => _qa.copy(this._leanQ).multiply(Qinh);
    const spineShare = { Spine: 0.28, Spine1: 0.34, Spine2: 0.38 };
    for (const [n, w] of Object.entries(spineShare)) if (I[n] >= 0) H[I[n]] = (i, Qinh) => {
      _qb.setFromAxisAngle(X, this._curl * w).premultiply(_qa.setFromAxisAngle(Z, this._rollExtra * w));
      return _qa.copy(_qb).multiply(Qinh);
    };
    // Head: look along the dragon's gaze, limited, flinch on hits.
    const head = (i, Qinh) => {
      const g = this._gazeLocal;
      if (!g) return null;
      const cur = _a.copy(Z).applyQuaternion(_qa.copy(Qinh).multiply(_qb.copy(rig.Qb[i]).invert()));
      const lim = _b.copy(g);
      const ang = cur.angleTo(lim), max = 1.1;
      if (ang > max) lim.copy(cur).lerp(g, max / ang).normalize();
      lim.x += this.flinch * 0.4; lim.y += this.flinch * 0.25 + (this._shout || 0) * 0.4; lim.normalize();
      return _qa.setFromUnitVectors(cur, lim).multiply(Qinh);
    };
    if (I.Neck >= 0) H[I.Neck] = (i, Qinh) => { const r = head(i, Qinh); return r ? _qb.copy(Qinh).slerp(r, 0.35) : null; };
    if (I.Head >= 0) H[I.Head] = head;
    // Arms: two-bone IK to the rein grips (elbows out and down); legs: IK to the stirrup points (knees forward-out).
    for (const [S, s] of [['Left', 1], ['Right', -1]]) {
      this._ik(S + 'Arm', S + 'ForeArm', S + 'Hand', () => this._handT[S], v3(0.8 * s, -0.6, -0.2), aim);
      this._ik(S + 'UpLeg', S + 'Leg', S + 'Foot', () => this._footT[S], v3(0.45 * s, 0.1, 1), aim);
      if (I[S + 'Hand'] >= 0) H[I[S + 'Hand']] = (i, Qinh) => aim(i, this._handDir?.[S] || _c.set(-0.25 * s, -0.25, 1), Qinh);
      if (I[S + 'Foot'] >= 0) H[I[S + 'Foot']] = (i, Qinh) => aim(i, _c.set(0.1 * s, -0.55, 1), Qinh);
    }
    // Fingers (GLB riders): the grip on the saddle handles = 0.75 of the README fist (MCP/PIP/DIP 85/100/70 deg
    // x finger factor; thumb 20/45/40 + opposition 38, -Z on the left / +Z on the right). +X curls on both sides.
    const local = (i, Qinh, ax, a, ax2, a2) => {
      _qa.setFromAxisAngle(ax, a);
      if (ax2) _qa.multiply(_qb.setFromAxisAngle(ax2, a2));
      return _qb.copy(Qinh).multiply(_qa);
    };
    for (const [S, s] of [['Left', 1], ['Right', -1]]) {
      for (const [f, k] of [['Index', 0.9], ['Middle', 1], ['Ring', 1.05], ['Pinky', 1.1]]) {
        [85, 100, 70].forEach((deg, j) => {
          const i = rig.i(`${S}Hand${f}${j + 1}`);
          // (the shout points the right index finger: that hand closes to a fist, the index straightens)
          if (i >= 0) H[i] = (ii, Qinh) => local(ii, Qinh, X, deg * DEG * k * this._gripOf(S, f));
        });
      }
      [20, 45, 40].forEach((deg, j) => {
        const i = rig.i(`${S}HandThumb${j + 1}`);
        if (i >= 0) H[i] = (ii, Qinh) => local(ii, Qinh, X, deg * DEG * this._gripOf(S, 'Thumb'), j === 0 ? Z : null, -s * 38 * DEG * this._gripOf(S, 'Thumb'));
      });
    }
    // Knight GLB cape: three columns x three rows lifted back into the relative wind (+X lifts, README), with a
    // travelling flutter; the rows bend progressively like cloth, columns out of phase.
    this._cape = [];
    ['CapeLeft', 'CapeMid', 'CapeRight'].forEach((col, c) => {
      for (let r = 1; r <= 3; r++) {
        const i = rig.i(col + r);
        if (i < 0) continue;
        this._cape.push(i);
        H[i] = (ii, Qinh) => {
          const cw = this._capeW;
          const a = cw.lift[r - 1] + cw.amp * (0.5 + 0.5 * r) * Math.sin(this._t * cw.freq - r * 0.9 + c * 1.3);
          // local +Z swings every column toward the model's left (+X); the outer columns also spread outward
          const side = cw.side + (c === 0 ? 0.1 : c === 2 ? -0.1 : 0) * r / 3;
          return local(ii, Qinh, X, a, Z, side);
        };
      }
    });
    this._grip = this._grip ?? 0.75;
    this._capeW = this._capeW || { lift: [35 * DEG, 25 * DEG, 15 * DEG], amp: 0, freq: 9, side: 0 };
  }

  /** Finger curl factor: the seated grip, or (right hand, inferno shout) a fist with the index pointing. */
  _gripOf(S, finger) {
    const g = this._grip, sh = S === 'Right' ? this._shout || 0 : 0;
    if (sh < 0.01) return g;
    return lerp(g, finger === 'Index' ? 0.06 : finger === 'Thumb' ? 0.8 : 1.05, sh);
  }

  _ik(upper, lower, end, targetFn, pole, aim) {
    const rig = this.rig, I = this._idx;
    const iu = I[upper], il = I[lower], ie = I[end];
    if (iu < 0 || il < 0 || ie < 0) return;
    const a = rig.Pb[il].distanceTo(rig.Pb[iu]), b = rig.Pb[ie].distanceTo(rig.Pb[il]);
    (this._reach || (this._reach = {}))[upper] = { root: iu, len: a + b };
    const elbow = v3();
    rig.handlers[iu] = (i, Qinh) => {
      const S = rig.Pm[i], T = targetFn();
      const d = _c.subVectors(T, S); let L = d.length();
      L = clamp(L, Math.abs(a - b) + 1e-3, a + b - 1e-3);
      const u = d.normalize();
      const cosA = clamp((a * a + L * L - b * b) / (2 * a * L), -1, 1), sinA = Math.sqrt(1 - cosA * cosA);
      const w = _d.copy(pole).addScaledVector(u, -pole.dot(u)).normalize();
      elbow.copy(S).addScaledVector(u, a * cosA).addScaledVector(w, a * sinA);
      return aim(i, _d.subVectors(elbow, S), Qinh);
    };
    rig.handlers[il] = (i, Qinh) => aim(i, _d.subVectors(targetFn(), rig.Pm[i]), Qinh);
  }

  /** ctx comes from the dragon: { dt, omegaM, forceM (apparent gravity, model frame), windM, gazeW, dead } */
  update(dt, ctx, lod = 0) {
    this._t += dt;
    const d = this.dragon;
    // Lean: into turns (yaw rate and bank command), forward with speed/boost, back when flaring; g-load crouch.
    const V = ctx.windM ? ctx.windM.length() : 0;
    const ctrl = d?.controls || {};
    // apparent g in the saddle; wave 4: plus the dragon's visual wingbeat heave (the rider sinks into each downstroke)
    const g = (ctx.forceM ? -ctx.forceM.y / 9.81 : 1) + clamp((ctx.heaveAcc || 0) / 9.81, -2.5, 2.5) * 0.8;
    // 24.09 flight moves (ctx.mv from the dragon): lean hard into a wingover, tuck low in the dash / skim / loop pull /
    // barrel roll, brace forward while a fireball charges, duck at a near miss; the inferno "shout": torso forward,
    // chin up, the right arm thrown up through the rear-up, then pointing ahead (index out) through the super breath
    const mo = ctx.mv?.on && !ctx.dead ? ctx.mv : null;
    const kS = Math.max(dt, 1e-4);
    // (25.09 — the level-up pose, ctx.mv.lv: she cheers with the dragon's roar — the right arm thrown up, chin up)
    const lvl = mo ? mo.lv || 0 : 0;
    const shoutT = mo ? Math.max(mo.inf, mo.rear, lvl) : 0;
    this._shout = lerp(this._shout || 0, shoutT, damp(shoutT > (this._shout || 0) ? 10 : 3.5, kS));
    const raiseT = mo ? Math.max(mo.rear, lvl) : 0;
    this._raise = lerp(this._raise || 0, raiseT, damp(raiseT > (this._raise || 0) ? 14 : 5, kS));
    const low = mo ? Math.max(mo.da, mo.sw * 0.7, mo.sk, mo.pull * 0.8, mo.roll * 0.6) : 0;
    // 24.09 hover (ctx.hv from the dragon): a pivot on the spot has no turn to lean into (the yaw-rate lean fades), she
    // sits upright against the pitched-up body (the torso leans forward by 1.1 × its pitch, so it stays near vertical),
    // leans into a strafe, braces forward on straight arms in the flare, crouches forward low in the take-off
    const ho = ctx.hv?.on && !ctx.dead ? ctx.hv : null, hw = ho ? ho.hv : 0;
    let rollT = clamp(-ctx.omegaM.y * 0.45 * (1 - 0.8 * hw) + (ctrl.roll || 0) * 0.18 * (1 - hw) - ctx.omegaM.z * 0.08, -0.5, 0.5);
    if (mo) rollT = clamp(rollT + mo.side * 0.34 * mo.wo, -0.62, 0.62);
    if (ho) rollT = clamp(rollT + 0.16 * ho.strafe, -0.62, 0.62);
    // (the hover's flare rears the body up: she leans forward against it and braces on straight arms)
    const hold = ho ? Math.max(hw, ho.fl) : 0;
    const dive = (ctrl.dive || 0) * (1 - hw), flare = (ctrl.flare || 0) * (1 - hold);
    let pitchT = clamp(0.36 + 0.14 * (ctrl.boost || 0) + 0.18 * dive - 0.28 * flare + 0.05 * smoothstep(20, 60, V) - 0.04 * (g - 1), -0.1, 0.75);
    if (mo) pitchT = clamp(pitchT + 0.24 * low + 0.1 * mo.ch + 0.2 * this._shout, -0.1, 0.9);
    if (ho) pitchT = clamp(pitchT + 1.1 * clamp(ho.bodyPitch, -0.3, 0.9) * hold + 0.1 * ho.fl + 0.26 * ho.to, -0.2, 1.1);
    this.lean.roll.step(dt, ctx.dead ? Math.sin(this._t * 5) * 0.4 : rollT);
    this.lean.pitch.step(dt, ctx.dead ? -0.2 : pitchT);
    this.flinch = Math.max(0, this.flinch - dt * 2.5);
    if (mo?.near > 0.05) this.flinch = Math.max(this.flinch, 0.45 * mo.near);
    this._leanQ = (this._leanQ || new THREE.Quaternion()).setFromAxisAngle(Z, this.lean.roll.x * 0.5).multiply(_qa.setFromAxisAngle(X, this.lean.pitch.x * 0.45));
    this._curl = this.lean.pitch.x * 0.55 + clamp((g - 1) * 0.04, 0, 0.15);
    this._rollExtra = this.lean.roll.x * 0.5;
    const crouch = clamp((g - 1) * 0.02, -0.02, 0.07) + (mo ? 0.045 * low + 0.03 * mo.near : 0) + (ho ? 0.035 * ho.to + 0.015 * ho.fl : 0);
    this.seat.position.y = lerp(this.seat.position.y, -crouch, damp(8, Math.max(dt, 1e-4)));
    // Gaze in the rider frame (≈ the dragon model frame).
    if (ctx.gazeW && this.root.parent) {
      const q = (ctx.riderWorldQ ? _qb.copy(ctx.riderWorldQ) : this.root.getWorldQuaternion(_qb)).invert();
      this._gazeLocal = (this._gazeLocal || v3()).copy(ctx.gazeW).applyQuaternion(q).normalize();
    }
    // IK targets in the seat frame (the dragon's back is ~0.55 m wide at the saddle).
    const lean = this.lean.pitch.x;
    this._handT = this._handT || { Left: v3(), Right: v3() };
    this._handDir = this._handDir || { Left: v3(0.25, -0.25, 1), Right: v3(-0.25, -0.25, 1) };
    this._footT = this._footT || { Left: v3(), Right: v3() };
    for (const [S, s] of [['Left', 1], ['Right', -1]]) {
      // (the flare: arms braced forward against the deceleration)
      this._handT[S].set(0.12 * s + this.lean.roll.x * 0.04, 0.16 - lean * 0.12, 0.34 + lean * 0.12 + (ho ? 0.05 * ho.fl : 0));
      this._footT[S].set(0.5 * s, -0.46 + crouch, 0.1);
      // Keep the elbows bent whatever the arm length (the knight's reach is longer than Kaede's): the grip sits at
      // <= 88 % of the arm's reach from the shoulder (README seated pose: forearm ~55 deg).
      const R = this._reach?.[S + 'Arm'];
      // the shout: the right arm out along a pointing direction (up in the rear-up, then ahead), reach-clamped below
      const hd = this._handDir[S].set(-0.25 * s, -0.25, 1);
      if (S === 'Right' && this._shout > 0.01 && R && R.root >= 0) {
        const dir = _d.set(-0.12, 0.3, 1).normalize().lerp(_b.set(-0.2, 1, 0.3).normalize(), this._raise).normalize();
        this._handT[S].lerp(_c.copy(this.rig.Pm[R.root]).addScaledVector(dir, R.len), this._shout);
        hd.lerp(dir, this._shout);
      }
      if (R && R.root >= 0) {
        const sh = this.rig.Pm[R.root], d = _c.subVectors(this._handT[S], sh), L = d.length(), max = 0.88 * R.len;
        if (L > max) this._handT[S].copy(sh).addScaledVector(d, max / L);
      }
    }
    // Grip and the knight's rigged cape (GLB): lifted back by the relative wind, fluttering faster with speed, swung
    // to the outside of turns.
    this._grip = ctx.dead ? 0.2 + 0.15 * Math.sin(this._t * 9) : 0.75;
    if (this._cape?.length) {
      const w = smoothstep(8, 55, V), cw = this._capeW;
      cw.lift[0] = (35 + 40 * w) * DEG; cw.lift[1] = (25 + 14 * w) * DEG; cw.lift[2] = (15 + 10 * w) * DEG;
      if (ctx.dead) cw.lift[0] += Math.sin(this._t * 6) * 0.4;
      cw.amp = 0.03 + 0.09 * w; cw.freq = 6 + 0.18 * V;
      cw.side = lerp(cw.side, clamp(-ctx.omegaM.y * 0.35 + this.lean.roll.x * 0.2, -0.35, 0.35), damp(4, Math.max(dt, 1e-4)));
    }
    // (24.09: no seat.updateMatrixWorld(true) here any more — the solve works in model space and the renderer updates
    // the matrices before drawing; it recomposed ~60 bones per rider per frame twice)
    this.rig.solve();
    const hi = this._idx.Head;
    if (hi >= 0) this.eye.copy(this.rig.Pm[hi]).add(this.seat.position).add(_d.set(0, 0.1, 0.02));
    // Cloth (frozen and hidden for far dragons)
    for (const c of this.cloth) c.sim.mesh.visible = lod < 2;
    if (this.cloth.length && lod === 0) this._cloth(dt, ctx);
    else if (lod === 1) for (const c of this.cloth) c.sim.init = false;
  }

  _cloth(dt, ctx) {
    const rig = this.rig, I = this._idx;
    const toRoot = (p) => p.clone().add(this.seat.position);           // rig model space = seat frame
    const neck = I.Neck >= 0 ? toRoot(rig.Pm[I.Neck]) : v3(0, 0.45, 0);
    const chest = I.Spine2 >= 0 ? toRoot(rig.Pm[I.Spine2]) : v3(0, 0.31, 0);
    const head = I.Head >= 0 ? toRoot(rig.Pm[I.Head]) : v3(0, 0.55, 0);
    const back = _a.subVectors(neck, chest).normalize();
    const fwdBody = _b.copy(Z).applyQuaternion(this._leanQ || _qa.identity()).normalize();
    const spheres = [
      { c: chest.clone().addScaledVector(fwdBody, -0.02).addScaledVector(back, 0.05), r: 0.17 },
      { c: head.clone().addScaledVector(back, 0.1), r: 0.14 },
      { c: toRoot(v3(0, -0.02, 0)), r: 0.18 },
      { c: v3(0, -0.72, -0.6), r: 0.7 },                                 // dragon's back behind the saddle
    ];
    // (24.09: through the drawn body frame too — ctx.visQ, the dragon's visual rotation: the barrel roll, hit rock —
    // so the scarf keeps hanging with gravity and streaming with the air while the dragon rolls under it)
    const toSeat = this.root.quaternion.clone().invert();
    if (ctx.visQ) toSeat.multiply(_qb.copy(ctx.visQ).invert());
    // (hover: the wings' downwash blows the scarf down, pulsing with every downstroke — ctx.hv.down, model frame)
    const wind = ctx.windM ? ctx.windM.clone() : v3(0, 0, -20);
    if (ctx.hv?.on && ctx.hv.down) wind.add(ctx.hv.down);
    wind.applyQuaternion(toSeat);
    const force = ctx.forceM ? ctx.forceM.clone().applyQuaternion(toSeat) : v3(0, -9.81, 0);
    const omega = ctx.omegaM ? ctx.omegaM.clone() : v3();
    if (ctx.mv?.on && ctx.mv.rollRate) omega.z += ctx.mv.rollRate;
    const c2 = { wind, force, omega, spheres };
    for (const c of this.cloth) {
      let anchors;
      if (c.anchor === 'scarfA' || c.anchor === 'scarfB') {
        const k = c.anchor === 'scarfA' ? 1 : -1;
        const base = neck.clone().addScaledVector(fwdBody, -0.075).addScaledVector(back, 0.01).add(v3(0.02 * k, 0, 0));
        anchors = [base.clone().add(v3(0.045, 0, 0)), base.clone().add(v3(-0.045, 0, 0))];
      } else if (c.anchor === 'cape') {
        const la = I.LeftArm >= 0 ? toRoot(rig.Pm[I.LeftArm]) : v3(0.16, 0.41, 0), ra = I.RightArm >= 0 ? toRoot(rig.Pm[I.RightArm]) : v3(-0.16, 0.41, 0);
        anchors = [];
        for (let k = 0; k < 5; k++) anchors.push(la.clone().lerp(ra, k / 4).addScaledVector(fwdBody, -0.1).addScaledVector(back, -0.02));
      } else {
        const top = head.clone().addScaledVector(back, 0.22).addScaledVector(fwdBody, -0.08);
        anchors = [top.clone().add(v3(0.02, 0, 0)), top.clone().add(v3(-0.02, 0, 0))];
      }
      c.sim.step(dt, anchors, c2);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.root.parent) this.root.parent.remove(this.root);
    for (const c of this.cloth) c.sim.dispose();
    // wave 4 (GPU leak): bone textures of the rider's skeletons and its per-instance toon / ink materials
    if (this.model) disposeInstance(this.model.scene, { materials: true });
  }
}

/** Critically-ish damped scalar spring (x, v) toward a target; f in Hz, z damping ratio. */
class Spring2 {
  constructor(f, z) { this.w = 2 * Math.PI * f; this.z = z; this.x = 0; this.v = 0; }
  step(dt, target) {
    if (dt <= 0) return this.x;
    const n = Math.max(1, Math.ceil(dt / (1 / 120))), h = dt / n;
    for (let i = 0; i < n; i++) { this.v += h * (this.w * this.w * (target - this.x) - 2 * this.z * this.w * this.v); this.x += h * this.v; }
    return this.x;
  }
}

export default Rider;
