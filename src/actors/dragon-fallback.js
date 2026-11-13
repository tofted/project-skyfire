// Procedural fallback dragon: a skinned, toon-shaded model with the contract bone names (ARCHITECTURE.md "Assets"),
// used until the Blender GLBs exist and whenever one fails to load. Everything is generated here: skeleton, a
// sculpted body tube with shaped cross-sections, head with a hinged jaw, horns, crest, four clawed legs, a finned
// tail, wing spars and real membrane panels (Coons patches between the spars with a scalloped trailing edge),
// saddle, and canvas-painted textures per variant.
//
// Bind pose = glide pose: wings spread, fingers fanned. Every bone's bind orientation is the model frame (identity),
// so bone-local offsets are plain model-space vectors; dragon.js maps poses through per-bone convention frames.
// Model frame: +Z forward, +Y up, +X left, metres, the centre of mass at the origin.
import * as THREE from 'three';

const TAU = Math.PI * 2;
const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------------------------------------------------------
// Palettes (sRGB). hero = Sora (scarlet / amber-gold membranes / gold horns), crimson = Shade Riders (charcoal /
// violet), onyx = ace tint of the crimson shape (slate / indigo-blue). Warm player vs cool enemies reads in a dogfight.
export const DRAGON_PALETTES = {
  hero: {
    shape: 'hero',
    body: '#c8281e', dorsal: '#a51d18', flank: '#d8392a', belly: '#f0c890', bellyLine: '#d89a58', limb: '#b8241c',
    horn: ['#9c6c28', '#dcb465', '#f7e8b8'], claw: ['#cbb996', '#f6eedc'], crest: ['#e0741c', '#ffc865'],
    iris: '#ffc23a', irisDark: '#b8520a', eyeGlow: 1.2,
    membrane: { spar: '#b8401a', mid: '#f08a2a', light: '#ffc870', vein: '#c05a1c', ink: '#5a1e08' },
    glow: '#ffd08a', glowStrength: 1.35, glowMix: 0.5,     // backlit membranes glow gold (key art), not just brighter orange
    saddle: '#6e452a', strap: '#43291a', metal: '#d8b060', mouth: '#8c2b3c', teeth: '#fbf6ea', ear: '#f0a07a',
    outline: '#3a1414',
    // Wave 4 (critics: "Sora reads flat", membranes #d4661a vs the key art's #e5a54d…#fce064):
    //   membRemap — GLB membrane albedo re-graded to an amber-at-the-spars → light-gold trailing-edge gradient, the
    //     painted veins kept as luminance detail (texL = mean linear luminance of the GLB's membrane texels);
    //   glowBase — a translucent glow the membranes always keep (more toward the sun), veins darken against the glow;
    //   volume — painted volume on the body in the dragon's own frame (see patchVolume).
    membRemap: { spar: '#e2892a', edge: '#fdd27a', texL: 0.214, k: 0.9 },
    glowBase: 0.2, veinDark: [0.55, 0.28, 0.16],
    // (the toon owner's wave-4 "form" shading already moves the terminator (formMid) and paints the hot highlight
    //  tone for every character, so the dragon's own patch keeps what needs the dragon's frame: countershading, the warm
    //  underside, a soft core band before the silhouette; no extra terminator shift (mid 0) and a faint highlight)
    volume: { dorsal: [0.8, 0.66, 0.7], k: [0.65, 0.4, 0.15, 0.22], warm: [1.0, 0.56, 0.3], hi: [1.0, 0.72, 0.5, 0.8], mid: 0 },
  },
  crimson: {
    shape: 'crimson',
    body: '#1b1a22', dorsal: '#121118', flank: '#26242f', belly: '#3a2a30', bellyLine: '#5a2c34', limb: '#211f29',
    horn: ['#7e7466', '#d2c9b8', '#f2ece0'], claw: ['#7e7466', '#e8e1d4'], crest: ['#a79d8c', '#f0eadc'],
    iris: '#ffae2a', irisDark: '#c0400a', eyeGlow: 2.6,
    membrane: { spar: '#3a1668', mid: '#7a3fc4', light: '#a878f0', vein: '#34125e', ink: '#12061f' },
    glow: '#c9a0ff', glowStrength: 1.2, glowMix: 0.3,
    saddle: '#141217', strap: '#7a3fc4', metal: '#9a9080', mouth: '#5c0f1a', teeth: '#efe8da', ear: '#3a2a30',
    outline: '#07060a',
    volume: { dorsal: [0.85, 0.8, 0.9], k: [0.5, 0.25, 0.1, 0.15], warm: [0.75, 0.55, 1.0], hi: [0.9, 0.8, 1.0, 0.8], mid: 0 },
    // Feel fix (readability at 100–400 m): the Shade Riders' own light — a violet rim ("shade aura", stronger with
    // distance), glowing spars / veins on the membranes, glowing eyes, violet ink and wing-tip trails. HDR multipliers
    // (> 1 blooms). aura: [near, far] strength; vein: spar glow; self: faint membrane self-light.
    shade: { aura: '#9a62ff', auraK: [0.55, 1.5], vein: '#a070ff', veinK: 1.25, self: 0.07, eye: '#e6ccff', eyeK: 3.2,
      ink: [0.075, 0.03, 0.17, 0.8], trail: '#a878ff', trailK: 1.1 },
  },
  onyx: {
    shape: 'crimson',
    body: '#2d3244', dorsal: '#1f2330', flank: '#373d52', belly: '#414865', bellyLine: '#5a6384', limb: '#2b3040',
    horn: ['#5e6380', '#b4b8d0', '#eceef8'], claw: ['#5e6380', '#e4e6f2'], crest: ['#8a8eb0', '#e4e6f4'],
    iris: '#d77cff', irisDark: '#6a1ea8', eyeGlow: 2.4,
    membrane: { spar: '#1c2a6e', mid: '#3f5fd0', light: '#7a9cff', vein: '#18245e', ink: '#080c22' },
    glow: '#a8c0ff', glowStrength: 1.25, glowMix: 0.3,
    saddle: '#1c1e26', strap: '#3f5fd0', metal: '#b4b8d0', mouth: '#4a1830', teeth: '#eee8f0', ear: '#414865',
    outline: '#0a0a12',
    volume: { dorsal: [0.85, 0.85, 0.92], k: [0.5, 0.25, 0.1, 0.15], warm: [0.6, 0.65, 1.0], hi: [0.85, 0.9, 1.0, 0.8], mid: 0 },
    // the ace: the same shade look in indigo-blue
    shade: { aura: '#5a86ff', auraK: [0.55, 1.5], vein: '#6a92ff', veinK: 1.3, self: 0.07, eye: '#d4e4ff', eyeK: 3.2,
      ink: [0.03, 0.05, 0.18, 0.8], trail: '#7aa0ff', trailK: 1.1 },
  },
};
// Drake: the Shade Riders' small riderless wyvern — same charcoal/violet look as their dragons (crimson shape).
DRAGON_PALETTES.drake = { ...DRAGON_PALETTES.crimson, texKey: 'crimson' };
/** Head-space eye sockets of the GLBs (model frame of the GLB wrapper, left eye; mirrored), for the glowing eyes.
 *  (25.09: the hero's, measured with markers on the bind head — levels and elements: Sora's eyes glow in her element) */
export const GLB_EYES = { dragon_crimson: [0.41, 0.43, 4.02], dragon_hero: [0.42, -0.22, 5.72] };
/** 25.09 — the main horn of each GLB as a polyline base → tip (GLB wrapper model frame, bind, left horn; mirrored),
 *  from the head-rigid vertices beside the skull (|x| > 0.45); the lightning arcs crawl along it. */
export const GLB_HORNS = { dragon_hero: [[0.62, 0.12, 4.85], [0.8, 0.14, 4.6], [0.95, 0.2, 4.2], [1.08, 0.34, 3.8], [1.18, 0.45, 3.52]] };

// ---------------------------------------------------------------------------------------------------------------
// Skeleton layout (bind = glide). Joint = bone head position in model space.
function side(p, s) { return v3(p.x * s, p.y, p.z); }

function makeLayout(shape) {
  const J = {};
  J.root = v3(0, 0, 0);
  J.pelvis = v3(0, 0.02, -1.55);
  J.spine1 = v3(0, 0.05, -0.75);
  J.spine2 = v3(0, 0.08, 0.05);
  J.chest = v3(0, 0.12, 0.85);
  const neck = [v3(0, 0.32, 1.72), v3(0, 0.6, 2.18), v3(0, 0.86, 2.64), v3(0, 1.05, 3.12), v3(0, 1.16, 3.62), v3(0, 1.2, 4.12)];
  neck.forEach((p, i) => { J['neck' + (i + 1)] = p; });
  J.head = v3(0, 1.2, 4.6);
  J.nose = v3(0, 1.07, 5.8);                        // not a bone: end of the head
  J.jaw = v3(0, 1.03, 4.84);
  J.chin = v3(0, 0.92, 5.73);
  // Tail: tapering segments with a gentle droop that lifts again toward the tip.
  let p = J.pelvis.clone(), len = 0.86;
  const tail = [];
  for (let i = 0; i < 10; i++) {
    tail.push(p.clone());
    const t = (i + 1) / 10;
    const dir = v3(0, -0.13 * Math.cos(t * Math.PI * 0.95) + 0.02, -1).normalize();
    p = p.clone().addScaledVector(dir, len);
    len *= 0.91;
  }
  tail.forEach((q, i) => { J['tail' + (i + 1)] = q; });
  J.tailTip = p;
  // Wings (left; right is mirrored). Angles in the XZ plane: 0 = straight out, + = forward.
  const S = v3(0.42, 0.42, 0.95), E = v3(2.25, 0.62, 0.35), W = v3(4.6, 0.85, 1.4), R = v3(5.05, 0.88, 1.45);
  const fingers = [[4, 3.3, 0.1], [-24, 3.5, 0.07], [-52, 3.1, 0.02], [-83, 2.6, -0.02]];
  const tips = fingers.map(([deg, l, dy]) => {
    const a = THREE.MathUtils.degToRad(deg);
    return v3(R.x + Math.cos(a) * l, R.y + dy, R.z + Math.sin(a) * l);
  });
  J.wing = { S, E, W, R, tips };
  // Legs (left; right mirrored): attach, knee, ankle, toe tip.
  J.legF = [v3(0.36, -0.3, 1.2), v3(0.45, -1.0, 0.95), v3(0.43, -1.6, 1.2), v3(0.43, -1.76, 1.52)];
  J.legB = [v3(0.4, -0.18, -1.45), v3(0.5, -0.86, -1.02), v3(0.47, -1.44, -1.52), v3(0.45, -1.86, -1.34)];
  J.saddle = v3(0, 0.66, 1.32);
  if (shape === 'crimson') {                        // heavier, lower-slung neck, shorter snout
    J.head.y -= 0.05; J.nose.set(0, 0.98, 5.72); J.jaw.y -= 0.05; J.chin.set(0, 0.83, 5.66);
  }
  return J;
}

// Bone list (name, parent, head position). Order = parents first.
function boneTable(J) {
  const T = [];
  const add = (name, parent, pos, tip = null) => T.push({ name, parent, pos: pos.clone(), tip: tip && tip.clone() });
  add('root', null, J.root);
  add('pelvis', 'root', J.pelvis);
  add('spine1', 'pelvis', J.spine1);
  add('spine2', 'spine1', J.spine2);
  add('chest', 'spine2', J.chest);
  for (let i = 1; i <= 6; i++) add('neck' + i, i === 1 ? 'chest' : 'neck' + (i - 1), J['neck' + i]);
  add('head', 'neck6', J.head, J.nose);
  add('jaw', 'head', J.jaw, J.chin);
  for (let i = 1; i <= 10; i++) add('tail' + i, i === 1 ? 'pelvis' : 'tail' + (i - 1), J['tail' + i], i === 10 ? J.tailTip : null);
  for (const [S, s] of [['L', 1], ['R', -1]]) {
    const w = J.wing;
    add('wing_shoulder_' + S, 'chest', side(w.S, s));
    add('wing_elbow_' + S, 'wing_shoulder_' + S, side(w.E, s));
    add('wing_wrist_' + S, 'wing_elbow_' + S, side(w.W, s), side(w.R, s));
    for (let i = 0; i < 4; i++) add(`wing_f${i + 1}_${S}`, 'wing_wrist_' + S, side(w.R, s), side(w.tips[i], s));
  }
  for (const [leg, parent, pts] of [['F', 'chest', J.legF], ['B', 'pelvis', J.legB]]) {
    for (const [S, s] of [['L', 1], ['R', -1]]) {
      const id = leg + S;
      add('leg_upper_' + id, parent, side(pts[0], s));
      add('leg_lower_' + id, 'leg_upper_' + id, side(pts[1], s));
      add('foot_' + id, 'leg_lower_' + id, side(pts[2], s), side(pts[3], s));
    }
  }
  add('saddle', 'chest', J.saddle);
  return T;
}

// ---------------------------------------------------------------------------------------------------------------
// Geometry builder with skin weights and welded smooth normals.
export class Builder {
  constructor(boneIndex) {
    this.B = boneIndex; this.P = []; this.UV = []; this.SI = []; this.SW = []; this.X = []; this.I = [];
  }
  get count() { return this.P.length / 3; }
  vert(p, u, v, w, x = null) {
    this.P.push(p.x, p.y, p.z); this.UV.push(u, v);
    const m = new Map();
    for (const [b, wt] of w) { if (wt <= 0) continue; const i = typeof b === 'number' ? b : this.B[b]; m.set(i, (m.get(i) || 0) + wt); }
    const s = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    let sum = 0; for (const e of s) sum += e[1];
    if (!sum) { s.length = 0; s.push([0, 1]); sum = 1; }
    for (let i = 0; i < 4; i++) { const e = s[i]; this.SI.push(e ? e[0] : 0); this.SW.push(e ? e[1] / sum : 0); }
    if (x) this.X.push(x[0], x[1], x[2]);
    return this.count - 1;
  }
  tri(a, b, c) { this.I.push(a, b, c); }
  geometry({ extra = false, weld = true } = {}) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.UV, 2));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(this.SI, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(this.SW, 4));
    if (extra) g.setAttribute('aMemb', new THREE.Float32BufferAttribute(this.X, 3));
    g.setIndex(this.I);
    smoothNormals(g, weld);
    g.computeBoundingSphere();
    return g;
  }
}

/** Area-weighted normals, then averaged across vertices sharing a position (closes UV seams and outline cracks). */
function smoothNormals(g, weld) {
  const pos = g.attributes.position.array, idx = g.index.array, n = pos.length / 3;
  const nor = new Float32Array(n * 3);
  const a = v3(), b = v3(), c = v3(), ab = v3(), ac = v3(), f = v3();
  for (let i = 0; i < idx.length; i += 3) {
    const i0 = idx[i], i1 = idx[i + 1], i2 = idx[i + 2];
    a.fromArray(pos, i0 * 3); b.fromArray(pos, i1 * 3); c.fromArray(pos, i2 * 3);
    f.crossVectors(ab.subVectors(b, a), ac.subVectors(c, a));
    for (const k of [i0, i1, i2]) { nor[k * 3] += f.x; nor[k * 3 + 1] += f.y; nor[k * 3 + 2] += f.z; }
  }
  if (weld) {
    const groups = new Map();
    for (let i = 0; i < n; i++) {
      const key = `${Math.round(pos[i * 3] * 1e4)}|${Math.round(pos[i * 3 + 1] * 1e4)}|${Math.round(pos[i * 3 + 2] * 1e4)}`;
      let gr = groups.get(key); if (!gr) groups.set(key, gr = []); gr.push(i);
    }
    for (const gr of groups.values()) {
      if (gr.length < 2) continue;
      let x = 0, y = 0, z = 0;
      for (const i of gr) { x += nor[i * 3]; y += nor[i * 3 + 1]; z += nor[i * 3 + 2]; }
      for (const i of gr) { nor[i * 3] = x; nor[i * 3 + 1] = y; nor[i * 3 + 2] = z; }
    }
  }
  for (let i = 0; i < n; i++) {
    f.set(nor[i * 3], nor[i * 3 + 1], nor[i * 3 + 2]);
    if (f.lengthSq() < 1e-20) f.set(0, 1, 0); else f.normalize();
    nor[i * 3] = f.x; nor[i * 3 + 1] = f.y; nor[i * 3 + 2] = f.z;
  }
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
}

/** Parallel-transport frames along points. B = N x T (so +B is the model's left when T=+Z, N=+Y). */
export function frames(points, up = v3(0, 1, 0)) {
  const out = [], n = points.length;
  let N = up.clone();
  for (let i = 0; i < n; i++) {
    const T = (i === 0 ? points[1].clone().sub(points[0]) : i === n - 1 ? points[n - 1].clone().sub(points[n - 2])
      : points[i + 1].clone().sub(points[i - 1])).normalize();
    N.addScaledVector(T, -N.dot(T));
    if (N.lengthSq() < 1e-8) N = Math.abs(T.y) < 0.9 ? v3(0, 1, 0) : v3(0, 0, 1), N.addScaledVector(T, -N.dot(T));
    N.normalize();
    out.push({ p: points[i].clone(), T, N: N.clone(), B: v3().crossVectors(N, T).normalize() });
  }
  return out;
}

/**
 * Tube along frames. shape(i, th) -> [x, y] offsets along (B, N); uv(i, k01) -> [u, v];
 * weight(i, th) -> [[bone, w], ...]. Caps close the ends (length along -T / +T).
 */
export function tube(b, fr, { radial = 12, shape, uv, weight, capStart = null, capEnd = null }) {
  const rings = [];
  for (let i = 0; i < fr.length; i++) {
    const f = fr[i], ring = [];
    for (let k = 0; k <= radial; k++) {
      const th = (k / radial) * TAU;
      const [x, y] = shape(i, th);
      const p = f.p.clone().addScaledVector(f.B, x).addScaledVector(f.N, y);
      const [u, v] = uv(i, k / radial);
      ring.push(b.vert(p, u, v, weight(i, th)));
    }
    rings.push(ring);
  }
  for (let i = 0; i < rings.length - 1; i++) {
    for (let k = 0; k < radial; k++) {
      const a = rings[i][k], bb = rings[i][k + 1], c = rings[i + 1][k + 1], d = rings[i + 1][k];
      b.tri(a, c, bb); b.tri(a, d, c);
    }
  }
  if (capStart !== null) {
    const f = fr[0], [u, v] = uv(0, 0.5);
    const c = b.vert(f.p.clone().addScaledVector(f.T, -capStart), u, v, weight(0, 0));
    for (let k = 0; k < radial; k++) b.tri(rings[0][k], rings[0][k + 1], c);
  }
  if (capEnd !== null) {
    const L = fr.length - 1, f = fr[L], [u, v] = uv(L, 0.5);
    const c = b.vert(f.p.clone().addScaledVector(f.T, capEnd), u, v, weight(L, 0));
    for (let k = 0; k < radial; k++) b.tri(rings[L][k], c, rings[L][k + 1]);
  }
  return rings;
}

/** 1D Catmull-Rom interpolation through keys [[x, value], ...] (x ascending). */
function keyed(keys, x) {
  if (x <= keys[0][0]) return keys[0][1];
  const n = keys.length;
  if (x >= keys[n - 1][0]) return keys[n - 1][1];
  let i = 0; while (keys[i + 1][0] < x) i++;
  const p0 = keys[Math.max(0, i - 1)][1], p1 = keys[i][1], p2 = keys[i + 1][1], p3 = keys[Math.min(n - 1, i + 2)][1];
  const t = (x - keys[i][0]) / (keys[i + 1][0] - keys[i][0]);
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** Weights along a chain of bones by arc position: linear blend between neighbouring segment centres. */
function chainWeights(centres, bones, s) {
  const n = centres.length;
  if (s <= centres[0]) return [[bones[0], 1]];
  if (s >= centres[n - 1]) return [[bones[n - 1], 1]];
  let i = 0; while (centres[i + 1] < s) i++;
  const t = (s - centres[i]) / (centres[i + 1] - centres[i]);
  return [[bones[i], 1 - t], [bones[i + 1], t]];
}

/** Sample a polyline at spacing ds; returns {pts, s[], seg[] (segment index), t[] (0..1 within segment)}. */
function samplePolyline(joints, ds) {
  const pts = [], S = [], seg = [], tt = [];
  let acc = 0;
  for (let i = 0; i < joints.length - 1; i++) {
    const a = joints[i], b = joints[i + 1], L = a.distanceTo(b), n = Math.max(1, Math.ceil(L / ds));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      pts.push(a.clone().lerp(b, t)); S.push(acc + L * t); seg.push(i); tt.push(t);
    }
    acc += L;
  }
  pts.push(joints[joints.length - 1].clone()); S.push(acc); seg.push(joints.length - 2); tt.push(1);
  return { pts, s: S, seg, t: tt, length: acc };
}

// Atlas regions of the body texture (1024 x 512): tube region x in [0, 0.75), swatches in the right quarter.
const SW = { horn: 0, claw: 1, crest: 2, mouth: 3, teeth: 4, saddle: 5, strap: 6, metal: 7, ear: 8, limb: 9, dark: 10, spar: 11 };
function swatchUV(name, t = 0.5, s = 0.5) {
  const i = SW[name], col = i % 4, row = Math.floor(i / 4);        // 4 columns x 3 rows of 64 x 170 px
  return [0.75 + (col + 0.2 + 0.6 * s) * 0.0625, 1 - (row + 0.92 - 0.84 * clamp01(t)) / 3];
}

// ---------------------------------------------------------------------------------------------------------------
// Parts
function buildBody(b, J, shape, info) {
  // Spine chain from the tail tip to just inside the skull.
  const chainNames = [];
  const joints = [J.tailTip];
  for (let i = 10; i >= 1; i--) { joints.push(J['tail' + i]); }
  // tail1 head == pelvis head: skip the duplicate point, keep bones in arc order.
  joints.pop();
  joints.push(J.pelvis, J.spine1, J.spine2, J.chest);
  for (let i = 1; i <= 6; i++) joints.push(J['neck' + i]);
  joints.push(J.head, J.head.clone().lerp(J.nose, 0.32));
  // Segment bones in arc order: tail10 .. tail1, pelvis, spine1, spine2, chest, neck1..6, head
  for (let i = 10; i >= 1; i--) chainNames.push('tail' + i);
  chainNames.push('pelvis', 'spine1', 'spine2', 'chest');
  for (let i = 1; i <= 6; i++) chainNames.push('neck' + i);
  chainNames.push('head');

  const curve = new THREE.CatmullRomCurve3(joints, false, 'centripetal');
  const L = curve.getLength();
  // Arc position of each control point.
  const lens = curve.getLengths(2000);
  const arcAt = (t) => { const f = t * 2000, i = Math.floor(f); return i >= 2000 ? lens[2000] : lerp(lens[i], lens[i + 1], f - i); };
  const jointArc = joints.map((_, i) => arcAt(i / (joints.length - 1)));
  const centres = chainNames.map((_, i) => 0.5 * (jointArc[i] + jointArc[i + 1]));
  const A = (name) => jointArc[joints.indexOf(J[name])];
  const sPel = A('pelvis'), sCh = A('chest'), sN1 = A('neck1'), sHead = A('head'), sS1 = A('spine1'), sS2 = A('spine2');
  info.bodyArc = { L, sPel, sCh, sHead };

  // Cross-section keys: [arc, rx, ryTop, ryBottom].
  const heavy = shape === 'crimson' ? 1.08 : 1;
  const keys = [
    [0, 0.035, 0.03, 0.03], [0.5, 0.075, 0.07, 0.065], [1.4, 0.12, 0.11, 0.1], [2.4, 0.17, 0.16, 0.15],
    [3.4, 0.24, 0.22, 0.22], [4.3, 0.33, 0.3, 0.32], [sPel - 0.35, 0.44, 0.4, 0.44],
    [sPel, 0.52 * heavy, 0.46, 0.5], [0.5 * (sPel + sS1), 0.46 * heavy, 0.43, 0.49], [sS1, 0.5 * heavy, 0.46, 0.6],
    [sS2, 0.57 * heavy, 0.5, 0.76], [sCh, 0.62 * heavy, 0.54, 0.84], [0.5 * (sCh + sN1), 0.56 * heavy, 0.52, 0.68],
    [sN1, 0.45 * heavy, 0.42, 0.5], [A('neck2'), 0.38, 0.35, 0.41], [A('neck3'), 0.34, 0.31, 0.36],
    [A('neck4'), 0.31, 0.28, 0.32], [A('neck5'), 0.29, 0.26, 0.29], [A('neck6'), 0.27, 0.25, 0.27],
    [sHead, 0.26, 0.24, 0.24], [L, 0.2, 0.19, 0.18],
  ];
  const col = (k) => keys.map((r) => [r[0], r[k]]);
  const kRx = col(1), kTop = col(2), kBot = col(3);
  const sShoulder = sCh + 0.1, sHaunch = sPel - 0.05;

  const rings = Math.ceil(L / 0.11);
  const pts = [], arcs = [];
  for (let i = 0; i <= rings; i++) { const u = i / rings; pts.push(curve.getPointAt(u)); arcs.push(u * L); }
  const fr = frames(pts, v3(0, 1, 0));
  const shapeFn = (i, th) => {
    const s = arcs[i];
    const sn = Math.sin(th), cs = Math.cos(th);
    let rx = keyed(kRx, s), ry = lerp(keyed(kBot, s), keyed(kTop, s), sstep(-0.35, 0.35, cs));
    // Muscle bulges: shoulders (upper flank) and haunches (lower flank), chest keel.
    const gS = Math.exp(-((s - sShoulder) ** 2) / (2 * 0.35 ** 2)), gH = Math.exp(-((s - sHaunch) ** 2) / (2 * 0.4 ** 2));
    const upperFlank = Math.exp(-((Math.abs(cs) - 0.55) ** 2) / 0.05) * (cs > 0 ? 1 : 0.3);
    const lowerFlank = Math.exp(-((cs + 0.45) ** 2) / 0.08);
    rx *= 1 + 0.16 * gS * upperFlank + 0.2 * gH * lowerFlank;
    const keel = Math.exp(-((s - (sCh - 0.25)) ** 2) / (2 * 0.5 ** 2)) * Math.max(0, -cs) ** 3;
    ry *= 1 + 0.1 * keel;
    const ex = 0.88;                                  // slightly boxy superellipse
    return [rx * Math.sign(sn) * Math.abs(sn) ** ex, ry * Math.sign(cs) * Math.abs(cs) ** ex];
  };
  tube(b, fr, {
    radial: 24, shape: shapeFn,
    uv: (i, k) => [k * 0.75, arcs[i] / L],
    weight: (i) => chainWeights(centres, chainNames, arcs[i]),
    capStart: 0.02, capEnd: 0.05,
  });
  info.bodySurface = (s, th) => {                    // for attachments (crest, saddle, membrane roots)
    const u = clamp01(s / L), p = curve.getPointAt(u);
    const fi = Math.min(fr.length - 1, Math.round(u * rings));
    const [x, y] = shapeFn(fi, th);
    return { p: p.clone().addScaledVector(fr[fi].B, x).addScaledVector(fr[fi].N, y), f: fr[fi], w: chainWeights(centres, chainNames, s) };
  };
  info.arcOf = A;
}

function buildHead(b, J, shape, info) {
  const axis = v3().subVectors(J.nose, J.head);
  const Lh = axis.length(); axis.normalize();
  const up0 = v3(0, 1, 0).addScaledVector(axis, -axis.y).normalize();
  const crim = shape === 'crimson';
  const wMul = crim ? 1.1 : 1;
  // Profile keys over a in [-0.12, 1]: rx, ryTop, ryBottom, dy (centre offset along up).
  const K = crim ? [
    [-0.12, 0.22, 0.22, 0.18, 0], [0, 0.29, 0.28, 0.2, 0.02], [0.16, 0.33, 0.3, 0.2, 0.04], [0.3, 0.31, 0.27, 0.18, 0.03],
    [0.46, 0.25, 0.21, 0.16, 0.0], [0.66, 0.22, 0.18, 0.15, -0.02], [0.86, 0.2, 0.16, 0.13, -0.03], [0.97, 0.16, 0.13, 0.11, -0.035], [1, 0.06, 0.06, 0.05, -0.04],
  ] : [
    [-0.12, 0.21, 0.21, 0.17, 0], [0, 0.29, 0.29, 0.2, 0.02], [0.14, 0.33, 0.32, 0.2, 0.045], [0.28, 0.31, 0.28, 0.18, 0.035],
    [0.42, 0.225, 0.2, 0.15, -0.02], [0.6, 0.185, 0.165, 0.13, -0.045], [0.8, 0.165, 0.145, 0.115, -0.05], [0.94, 0.14, 0.125, 0.1, -0.045], [1, 0.05, 0.05, 0.04, -0.05],
  ];
  const kk = (j) => K.map((r) => [r[0], r[j]]);
  const kRx = kk(1), kTop = kk(2), kBot = kk(3), kDy = kk(4);
  const N = 30, as = [];
  for (let i = 0; i <= N; i++) as.push(lerp(-0.12, 1, (i / N) ** 0.9));
  const pts = as.map((a) => J.head.clone().addScaledVector(axis, a * Lh).addScaledVector(up0, keyed(kDy, a)));
  const fr = frames(pts, up0);
  const headW = [['head', 1]];
  const shapeFn = (i, th) => {
    const a = as[i], sn = Math.sin(th), cs = Math.cos(th);
    const rx = keyed(kRx, a) * wMul;
    let ry = lerp(keyed(kBot, a), keyed(kTop, a), sstep(-0.3, 0.3, cs));
    let y = ry * Math.sign(cs) * Math.abs(cs) ** 0.85;
    if (cs < 0 && a > 0.25) y = -ry * Math.abs(cs) ** (0.85 - 0.5 * sstep(0.25, 0.5, a));   // flat palate (mouth line)
    // Brow ridge above the eyes, slight nose-bridge dip.
    const brow = Math.exp(-((a - 0.28) ** 2) / 0.004) * Math.exp(-((Math.abs(sn) - 0.62) ** 2) / 0.05) * (cs > 0 ? 1 : 0);
    const x = rx * Math.sign(sn) * Math.abs(sn) ** 0.85 * (1 + 0.1 * brow);
    return [x, y + 0.03 * brow * (crim ? 1.6 : 1)];
  };
  tube(b, fr, {
    radial: 24, shape: shapeFn,
    uv: (i, k) => {
      const a = as[i], th = k * TAU, cs = Math.cos(th);
      if (cs < -0.82 && a > 0.3 && a < 0.97) return swatchUV('mouth', 0.4);
      return [k * 0.75, 0.994];                     // head: top rows of the tube region (no belly plates)
    },
    weight: () => headW, capStart: 0.02, capEnd: 0.04,
  });
  info.head = { axis, up: up0, Lh, frames: fr, as, shapeFn };
  info.headPoint = (a, th, out = 0) => {
    let i = 0; while (i < as.length - 1 && as[i + 1] < a) i++;
    const f = fr[i], [x, y] = shapeFn(i, th);
    const n = v3().addScaledVector(f.B, x).addScaledVector(f.N, y).normalize();
    return { p: f.p.clone().addScaledVector(f.B, x).addScaledVector(f.N, y).addScaledVector(n, out), n, f };
  };

  // Lower jaw: hinge below the skull to the chin, flat top (mouth floor).
  const jAxis = v3().subVectors(J.chin, J.jaw); const Lj = jAxis.length(); jAxis.normalize();
  const jUp = v3(0, 1, 0).addScaledVector(jAxis, -jAxis.y).normalize();
  const JK = [[0, 0.24, 0.05, 0.13], [0.2, 0.22, 0.05, 0.15], [0.5, 0.18, 0.04, 0.13], [0.8, 0.15, 0.035, 0.1], [0.96, 0.12, 0.03, 0.075], [1, 0.05, 0.02, 0.04]];
  const jk = (j) => JK.map((r) => [r[0], r[j]]);
  const jRx = jk(1), jTop = jk(2), jBot = jk(3);
  const jas = []; for (let i = 0; i <= 18; i++) jas.push(i / 18);
  const jpts = jas.map((a) => J.jaw.clone().addScaledVector(jAxis, a * Lj));
  const jfr = frames(jpts, jUp);
  tube(b, jfr, {
    radial: 20,
    shape: (i, th) => {
      const a = jas[i], sn = Math.sin(th), cs = Math.cos(th);
      const rx = keyed(jRx, a) * wMul, ry = cs > 0 ? keyed(jTop, a) : keyed(jBot, a);
      return [rx * Math.sign(sn) * Math.abs(sn) ** 0.8, ry * Math.sign(cs) * Math.abs(cs) ** (cs > 0 ? 0.35 : 0.9)];
    },
    uv: (i, k) => {
      const cs = Math.cos(k * TAU), a = jas[i];
      if (cs > 0.55 && a > 0.1) return swatchUV('mouth', 0.7);
      return [k * 0.75, 0.994];
    },
    weight: (i) => (jas[i] < 0.12 ? [['jaw', 0.6 + jas[i] * 3], ['head', 0.4 - jas[i] * 3]] : [['jaw', 1]]),
    capStart: 0.02, capEnd: 0.03,
  });
  info.jaw = { axis: jAxis, up: jUp, Lj };

  // Teeth: upper row pointing down along the lip, lower row pointing up.
  const tooth = (base, dir, len, r, bone) => cone(b, base, dir, len, r, [[bone, 1]], 'teeth', 5);
  for (const s of [1, -1]) {
    for (let k = 0; k < 5; k++) {
      const a = 0.52 + k * 0.1;
      const hp = info.headPoint(a, Math.PI * (s > 0 ? 0.66 : 1.34), -0.01);
      const len = k === 3 ? 0.085 : 0.05;
      tooth(hp.p, v3(0, -1, 0).addScaledVector(axis, 0.15), len, k === 3 ? 0.022 : 0.015, 'head');
    }
    for (let k = 0; k < 3; k++) {
      const a = 0.45 + k * 0.15;
      const base = J.jaw.clone().addScaledVector(jAxis, a * Lj).addScaledVector(jUp, 0.03).add(v3(s * keyed(jRx, a) * 0.72 * wMul, 0, 0));
      tooth(base, v3(0, 1, 0), 0.04, 0.013, 'jaw');
    }
  }
  // Eyes are a separate unlit mesh (built in buildEyes); remember where they sit.
  const eyeA = crim ? 0.31 : 0.3;
  info.eyes = [1, -1].map((s) => {
    const hp = info.headPoint(eyeA, s > 0 ? 1.12 : TAU - 1.12, -0.012);
    return { p: hp.p, n: hp.n.clone().addScaledVector(axis, 0.35).normalize(), s };
  });
  // Nostrils
  for (const s of [1, -1]) {
    const hp = info.headPoint(0.93, s > 0 ? 0.62 : TAU - 0.62, -0.005);
    blob(b, hp.p, v3(0.025, 0.012, 0.03), [['head', 1]], 'dark');
  }
}

/** Closed cone along dir (base radius r, tip 0) with a small base cap. */
function cone(b, base, dir, len, r, w, sw, radial = 6, bend = null) {
  const d = dir.clone().normalize();
  const pts = [];
  const n = 5;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = base.clone().addScaledVector(d, len * t);
    if (bend) p.addScaledVector(bend, len * t * t);
    pts.push(p);
  }
  const fr = frames(pts, Math.abs(d.y) < 0.9 ? v3(0, 1, 0) : v3(0, 0, 1));
  tube(b, fr, {
    radial, shape: (i, th) => { const rr = r * (1 - i / n) ** 0.9; return [Math.sin(th) * rr, Math.cos(th) * rr]; },
    uv: (i) => swatchUV(sw, i / n), weight: () => w, capStart: 0.0,
  });
}

/** Small ellipsoid blob (radii in model axes). */
function blob(b, c, r, w, sw, seg = 8) {
  const pts = [];
  for (let i = 0; i <= seg; i++) pts.push(c.clone().add(v3(0, 0, -r.z + (2 * r.z * i) / seg)));
  const fr = frames(pts, v3(0, 1, 0));
  tube(b, fr, {
    radial: seg,
    shape: (i, th) => { const t = -1 + (2 * i) / seg, k = Math.sqrt(Math.max(0, 1 - t * t)); return [Math.sin(th) * r.x * k, Math.cos(th) * r.y * k]; },
    uv: (i) => swatchUV(sw, i / seg), weight: () => w,
  });
}

/** Curved horn: quadratic bezier from base through ctrl to tip, radius r0 -> r1. */
function horn(b, p0, p1, p2, r0, r1, w, sw, flat = 1, radial = 10, n = 14, flatB = 1) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, it = 1 - t;
    pts.push(v3().addScaledVector(p0, it * it).addScaledVector(p1, 2 * it * t).addScaledVector(p2, t * t));
  }
  const fr = frames(pts, v3(0, 1, 0));
  tube(b, fr, {
    radial, shape: (i, th) => { const t = i / n, rr = lerp(r0, r1, t ** 0.8); return [Math.sin(th) * rr * flatB, Math.cos(th) * rr * flat]; },
    uv: (i) => swatchUV(sw, i / n), weight: typeof w === 'function' ? (i) => w(i / n) : () => w, capStart: 0.01, capEnd: 0.005,
  });
}

function buildHornsAndCrest(b, J, shape, info) {
  const H = info.head;
  const crim = shape === 'crimson';
  const at = (a, up, sideX) => J.head.clone().addScaledVector(H.axis, a * H.Lh).addScaledVector(H.up, up).add(v3(sideX, 0, 0));
  // 25.09: the main horns' curves (model frame, bind; [base, ctrl, tip] per side) for the lightning arcs (dragon.js)
  const bez = (p0, p1, p2) => Array.from({ length: 5 }, (_, i) => { const t = i / 4, it = 1 - t; return v3().addScaledVector(p0, it * it).addScaledVector(p1, 2 * it * t).addScaledVector(p2, t * t); });
  info.horns = [];
  for (const s of [1, -1]) {
    if (!crim) {
      // Main horns: long, sweeping back and up (gold). Secondary pair below, pointing back-outward.
      const p0 = at(0.12, 0.2, s * 0.14);
      horn(b, p0, p0.clone().add(v3(s * 0.12, 0.55, -0.45)), p0.clone().add(v3(s * 0.28, 0.72, -1.25)), 0.085, 0.006, [['head', 1]], 'horn');
      info.horns.push(bez(p0, p0.clone().add(v3(s * 0.12, 0.55, -0.45)), p0.clone().add(v3(s * 0.28, 0.72, -1.25))));
      const q0 = at(0.06, 0.02, s * 0.24);
      horn(b, q0, q0.clone().add(v3(s * 0.2, 0.08, -0.25)), q0.clone().add(v3(s * 0.34, 0.12, -0.55)), 0.045, 0.004, [['head', 1]], 'horn');
      // Ears: pointed leaves, flattened, pointing back-up-out.
      const e0 = at(0.02, 0.16, s * 0.2);
      horn(b, e0, e0.clone().add(v3(s * 0.12, 0.12, -0.12)), e0.clone().add(v3(s * 0.2, 0.2, -0.32)), 0.075, 0.004, [['head', 1]], 'ear', 0.3, 8, 8);
      // Cheek tufts (white fur) behind the jaw hinge.
      for (let k = 0; k < 2; k++) {
        const c0 = at(0.16 + k * 0.06, -0.12 - k * 0.04, s * 0.25);
        horn(b, c0, c0.clone().add(v3(s * 0.1, -0.02, -0.12)), c0.clone().add(v3(s * 0.16, -0.06 - k * 0.04, -0.34 + k * 0.08)), 0.05, 0.004, [['head', 1]], 'claw', 0.35, 6, 6);
      }
    } else {
      // Ram-like curling horns (bone) with a row of cheek spikes.
      const p0 = at(0.1, 0.18, s * 0.17);
      horn(b, p0, p0.clone().add(v3(s * 0.25, 0.55, -0.55)), p0.clone().add(v3(s * 0.45, 0.08, -0.85)), 0.11, 0.035, [['head', 1]], 'horn');
      const p1 = p0.clone().add(v3(s * 0.45, 0.08, -0.85));
      horn(b, p1, p1.clone().add(v3(s * 0.12, -0.3, -0.05)), p1.clone().add(v3(s * 0.02, -0.38, 0.3)), 0.036, 0.005, [['head', 1]], 'horn');
      for (let k = 0; k < 3; k++) {
        const c0 = at(0.12 + k * 0.1, -0.08, s * 0.3);
        cone(b, c0, v3(s * 0.5, 0.1, -1), 0.18 - k * 0.03, 0.035, [['head', 1]], 'horn', 6);
      }
    }
  }
  // Dorsal crest / spikes along the neck (and back/tail for the crimson shape).
  const L = info.bodyArc.L, sHead = info.bodyArc.sHead, sPel = info.bodyArc.sPel;
  if (!crim) {
    for (let k = 0; k < 9; k++) {
      const s = sHead + 0.05 - k * 0.36;
      const t = k / 8;
      const at2 = info.bodySurface(s, 0);
      const h = lerp(0.46, 0.16, t);
      const dir = at2.f.N.clone().multiplyScalar(0.7).addScaledVector(at2.f.T, -1).normalize();
      horn(b, at2.p.clone().addScaledVector(at2.f.N, -0.05), at2.p.clone().addScaledVector(dir, h * 0.55).addScaledVector(at2.f.N, 0.06),
        at2.p.clone().addScaledVector(dir, h).addScaledVector(at2.f.T, -h * 0.45), 0.1, 0.004, at2.w, 'crest', 1, 8, 7, 0.4);
    }
  } else {
    for (let k = 0; ; k++) {
      const s = sHead - 0.2 - k * 0.34;
      if (s < 0.5) break;
      const at2 = info.bodySurface(s, 0);
      const t = clamp01((sHead - s) / (sHead - 0.5));
      const back = s < sPel;
      const h = back ? lerp(0.34, 0.12, clamp01((sPel - s) / (sPel - 0.5))) : lerp(0.18, 0.4, t * 1.6);
      const dir = at2.f.N.clone().addScaledVector(at2.f.T, -0.8).normalize();
      cone(b, at2.p.clone().addScaledVector(at2.f.N, -0.03), dir, h, h * 0.28, at2.w, 'horn', 7, at2.f.T.clone().multiplyScalar(-0.3));
    }
  }
  // Tail tip: turquoise spade fin (hero) or a fan of bone spikes (crimson).
  const tip = J.tailTip, t10 = J.tail10;
  const tdir = v3().subVectors(tip, t10).normalize();
  const tw = [['tail10', 1]];
  if (!crim) {
    const shapeFin = new THREE.Shape();
    shapeFin.moveTo(0, -0.25);
    shapeFin.bezierCurveTo(0.2, -0.1, 0.42, 0.18, 0.55, 0.42);
    shapeFin.bezierCurveTo(0.3, 0.38, 0.14, 0.5, 0.0, 0.95);
    shapeFin.bezierCurveTo(-0.14, 0.5, -0.3, 0.38, -0.55, 0.42);
    shapeFin.bezierCurveTo(-0.42, 0.18, -0.2, -0.1, 0, -0.25);
    const eg = new THREE.ExtrudeGeometry(shapeFin, { depth: 0.035, bevelEnabled: true, bevelThickness: 0.018, bevelSize: 0.02, bevelSegments: 1, curveSegments: 10 });
    // Shape XY -> model: x across (X), y along the tail direction (-Z), extrusion depth -> Y.
    const m = new THREE.Matrix4().makeBasis(v3(1, 0, 0), tdir, v3(0, 1, 0)).setPosition(tip.clone().addScaledVector(tdir, -0.25).add(v3(0, -0.035, 0)));
    appendGeometry(b, eg, m, (p) => [['tail10', 1]], (p, u) => swatchUV('crest', clamp01(u)));
    // Vertical keel fin on top
    const k0 = J.tail9.clone().add(v3(0, 0.04, 0));
    horn(b, k0, k0.clone().add(v3(0, 0.18, -0.3)), tip.clone().add(v3(0, 0.12, 0.05)), 0.05, 0.004, (t) => (t < 0.5 ? [['tail9', 1 - t], ['tail10', t]] : tw), 'crest', 1, 6, 8, 0.25);
  } else {
    for (let k = -2; k <= 2; k++) {
      const d = tdir.clone().applyAxisAngle(v3(0, 1, 0), k * 0.32).add(v3(0, 0.25 + 0.08 * Math.abs(k), 0)).normalize();
      cone(b, tip.clone().addScaledVector(tdir, -0.1), d, 0.42 - Math.abs(k) * 0.06, 0.045, tw, 'horn', 6);
    }
  }
}

/** Append a THREE.BufferGeometry (non-indexed or indexed) transformed by m with weights and UVs. */
function appendGeometry(b, g, m, wFn, uvFn) {
  const pos = g.attributes.position, idx = g.index;
  const base = b.count;
  const bb = new THREE.Box3().setFromBufferAttribute(pos);
  const p = v3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const u = (p.y - bb.min.y) / Math.max(1e-6, bb.max.y - bb.min.y);
    const q = p.clone().applyMatrix4(m);
    const [uu, vv] = uvFn(q, u);
    b.vert(q, uu, vv, wFn(q));
  }
  const det = m.determinant();
  const flip = det < 0;
  if (idx) for (let i = 0; i < idx.count; i += 3) { const a = idx.getX(i), c = idx.getX(i + 1), d = idx.getX(i + 2); flip ? b.tri(base + a, base + d, base + c) : b.tri(base + a, base + c, base + d); }
  else for (let i = 0; i < pos.count; i += 3) flip ? b.tri(base + i, base + i + 2, base + i + 1) : b.tri(base + i, base + i + 1, base + i + 2);
}

function buildLegs(b, J, shape, info) {
  const heavy = shape === 'crimson' ? 1.1 : 1;
  for (const [leg, parent, pts, radii] of [
    ['F', 'chest', J.legF, [0.24, 0.13, 0.1, 0.1]],
    ['B', 'pelvis', J.legB, [0.33, 0.16, 0.095, 0.1]],
  ]) {
    for (const [S, s] of [['L', 1], ['R', -1]]) {
      const id = leg + S;
      const joints = pts.map((p) => side(p, s));
      // Start buried in the body, a little above the attach point.
      const start = joints[0].clone().add(v3(-s * 0.12, 0.25, 0));
      const chain = [start, ...joints];
      const bones = [parent, 'leg_upper_' + id, 'leg_lower_' + id, 'foot_' + id];
      const sp = samplePolyline(chain, 0.07);
      const segLen = [];
      for (let i = 0; i < chain.length - 1; i++) segLen.push(chain[i].distanceTo(chain[i + 1]));
      const rAt = (seg, t) => {
        const R = [radii[0] * 1.15, radii[0], radii[1], radii[2], radii[3]];
        let r = lerp(R[seg], R[seg + 1], t);
        if (seg === 1) r *= 1 + 0.25 * Math.sin(Math.PI * t) * (leg === 'B' ? 1.2 : 0.8);   // calf / forearm muscle
        if (seg === 3) r = radii[3] * (1 + 0.5 * Math.sin(Math.PI * Math.min(1, t * 1.2)));    // paw
        return r * heavy;
      };
      const fr = frames(sp.pts, v3(0, 0, 1));
      tube(b, fr, {
        radial: 12,
        shape: (i, th) => {
          const r = rAt(sp.seg[i], sp.t[i]);
          const flat = sp.seg[i] === 3 ? 0.62 : 1;
          return [Math.sin(th) * r, Math.cos(th) * r * flat];
        },
        uv: (i) => swatchUV('limb', sp.s[i] / sp.length),
        weight: (i) => {
          const seg = sp.seg[i], t = sp.t[i];
          const L = segLen[seg], blend = 0.12;
          const dStart = t * L, dEnd = (1 - t) * L;
          if (seg > 0 && dStart < blend) { const k = 0.5 * (1 - dStart / blend); return [[bones[seg - 1], k], [bones[seg], 1 - k]]; }
          if (seg < 3 && dEnd < blend) { const k = 0.5 * (1 - dEnd / blend); return [[bones[seg + 1], k], [bones[seg], 1 - k]]; }
          return [[bones[seg], 1]];
        },
        capStart: 0.02, capEnd: 0.06,
      });
      // Claws at the paw front.
      const toe = joints[3], ankle = joints[2];
      const fwd = v3().subVectors(toe, ankle).normalize();
      const lat = v3(1, 0, 0);
      for (let k = -1.5; k <= 1.5; k += 1) {
        const base = toe.clone().addScaledVector(lat, k * 0.055 * heavy).addScaledVector(fwd, -0.03);
        cone(b, base, fwd.clone().add(v3(0, -0.35, 0)).normalize(), 0.13 * heavy, 0.028 * heavy, [['foot_' + id, 1]], 'claw', 6, v3(0, -0.25, 0));
      }
    }
  }
}

function buildWingSpars(b, J, shape, info) {
  const w = J.wing;
  const heavy = shape === 'crimson' ? 1.08 : 1;
  for (const [S, s] of [['L', 1], ['R', -1]]) {
    const Sp = side(w.S, s), Ep = side(w.E, s), Wp = side(w.W, s), Rp = side(w.R, s);
    // Arm: shoulder (buried) -> elbow -> wrist -> finger root.
    const start = Sp.clone().add(v3(-s * 0.2, -0.08, 0));
    const chain = [start, Sp, Ep, Wp, Rp];
    const bones = ['chest', 'wing_shoulder_' + S, 'wing_elbow_' + S, 'wing_wrist_' + S];
    const R = [0.24, 0.2, 0.12, 0.095, 0.075];
    const sp = samplePolyline(chain, 0.08);
    const segLen = []; for (let i = 0; i < chain.length - 1; i++) segLen.push(chain[i].distanceTo(chain[i + 1]));
    const fr = frames(sp.pts, v3(0, 1, 0));
    tube(b, fr, {
      radial: 12,
      shape: (i, th) => {
        const seg = sp.seg[i], t = sp.t[i];
        let r = lerp(R[seg], R[seg + 1], t);
        if (seg === 1) r *= 1 + 0.18 * Math.sin(Math.PI * t);              // biceps
        if (seg === 2) r *= 1 - 0.18 * Math.sin(Math.PI * t);              // slim forearm
        if (seg === 3) r *= 1 + 0.2 * Math.sin(Math.PI * t);               // wrist knuckle
        return [Math.sin(th) * r * heavy, Math.cos(th) * r * 0.85 * heavy];
      },
      uv: (i) => swatchUV('spar', sp.s[i] / sp.length),
      weight: (i) => {
        const seg = sp.seg[i], t = sp.t[i], L = segLen[seg];
        const blend = 0.16;
        const own = seg === 0 ? 'chest' : bones[seg];
        const prev = seg <= 1 ? 'chest' : bones[seg - 1];
        const next = seg >= 3 ? null : bones[seg + 1];
        const dS = t * L, dE = (1 - t) * L;
        if (seg === 0) { const k = sstep(0, 1, t); return [['chest', 1 - 0.5 * k], ['wing_shoulder_' + S, 0.5 * k]]; }
        if (dS < blend) { const k = 0.5 * (1 - dS / blend); return [[prev, k], [own, 1 - k]]; }
        if (next && dE < blend) { const k = 0.5 * (1 - dE / blend); return [[next, k], [own, 1 - k]]; }
        return [[own, 1]];
      },
      capStart: 0.02,
    });
    // Fingers: tapered spars with small claws at the tips.
    for (let i = 0; i < 4; i++) {
      const T = side(w.tips[i], s);
      const fb = `wing_f${i + 1}_${S}`;
      const n = 12, pts = [];
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        pts.push(Rp.clone().lerp(T, t).add(v3(0, 0.04 * Math.sin(Math.PI * t), 0)));   // slight upward bow
      }
      const ffr = frames(pts, v3(0, 1, 0));
      const r0 = [0.07, 0.068, 0.06, 0.055][i] * heavy;
      tube(b, ffr, {
        radial: 8,
        shape: (k, th) => { const t = k / n, r = lerp(r0, 0.016, t ** 0.7) * (1 + 0.15 * Math.exp(-((t - 0.45) ** 2) / 0.003)); return [Math.sin(th) * r, Math.cos(th) * r * 0.8]; },
        uv: (k) => swatchUV('spar', k / n),
        weight: (k) => { const t = k / n; return t < 0.08 ? [['wing_wrist_' + S, 0.5 - t * 6], [fb, 0.5 + t * 6]] : [[fb, 1]]; },
        capStart: 0.01,
      });
      const d = v3().subVectors(T, Rp).normalize();
      cone(b, T.clone().addScaledVector(d, -0.03), d.clone().add(v3(0, -0.3, 0)).normalize(), 0.16, 0.022, [[fb, 1]], 'claw', 6, v3(0, -0.2, 0));
    }
    // Thumb claw at the wrist, pointing forward.
    const fwd = v3().subVectors(Wp, Ep).normalize();
    cone(b, Wp.clone().add(v3(0, 0.03, 0)), fwd.clone().add(v3(0, 0.25, 0.4)).normalize(), 0.26, 0.05, [['wing_wrist_' + S, 1]], 'horn', 7, v3(0, -0.18, 0));
  }
}

function buildSaddle(b, J, shape, info) {
  const sN1 = info.arcOf('neck1'), sCh = info.bodyArc.sCh;
  const sMid = lerp(sCh, sN1, 0.55);
  const at = info.bodySurface(sMid, 0);
  const w = [['saddle', 1]];
  // Seat: a shell hugging the back (partial ring surfaces lifted off the body).
  const seatRings = [];
  const n = 8;
  for (let i = 0; i <= n; i++) {
    const s = sMid - 0.42 + (0.84 * i) / n;
    const ring = [];
    for (let k = 0; k <= 10; k++) {
      const th = -1.05 + (2.1 * k) / 10;
      const sp = info.bodySurface(s, th < 0 ? th + TAU : th);
      const lift = 0.05 + 0.07 * Math.sin((Math.PI * i) / n) * Math.cos(th) + (i === 0 || i === n ? -0.02 : 0);
      const nrm = v3().subVectors(sp.p, sp.f.p).normalize();
      ring.push(b.vert(sp.p.clone().addScaledVector(nrm, lift), ...swatchUV('saddle', i / n, k / 10), w));
    }
    seatRings.push(ring);
  }
  for (let i = 0; i < n; i++) for (let k = 0; k < 10; k++) {
    const a = seatRings[i][k], bb = seatRings[i][k + 1], c = seatRings[i + 1][k + 1], d = seatRings[i + 1][k];
    b.tri(a, c, bb); b.tri(a, d, c);
  }
  // Pommel (front) and cantle (back), girth straps, buckles.
  const front = info.bodySurface(sMid + 0.44, 0), back = info.bodySurface(sMid - 0.44, 0);
  horn(b, front.p.clone().addScaledVector(front.f.N, 0.02), front.p.clone().addScaledVector(front.f.N, 0.16), front.p.clone().addScaledVector(front.f.N, 0.22).addScaledVector(front.f.T, 0.05), 0.06, 0.035, w, 'saddle', 1, 8, 5);
  horn(b, back.p.clone().addScaledVector(back.f.N, 0.02), back.p.clone().addScaledVector(back.f.N, 0.1), back.p.clone().addScaledVector(back.f.N, 0.14).addScaledVector(back.f.T, -0.04), 0.09, 0.05, w, 'saddle', 0.6, 8, 5);
  for (const ds of [-0.2, 0.25]) {
    const s = sMid + ds;
    const ring = [];
    for (let k = 0; k <= 28; k++) ring.push(info.bodySurface(s, (k / 28) * TAU));
    const pts = ring.map((r) => r.p.clone().addScaledVector(v3().subVectors(r.p, r.f.p).normalize(), 0.02));
    const fr = frames(pts, ring[0].f.T);
    tube(b, fr, { radial: 4, shape: (i, th) => [Math.sin(th) * 0.018, Math.cos(th) * 0.05], uv: () => swatchUV('strap'), weight: () => ring[0].w });
    blob(b, pts[7], v3(0.03, 0.05, 0.05), ring[0].w, 'metal', 6);
    blob(b, pts[21], v3(0.03, 0.05, 0.05), ring[0].w, 'metal', 6);
  }
  // Saddle bag / quiver on the right side (hero) for silhouette interest.
  if (shape === 'hero') {
    const bag = info.bodySurface(sMid - 0.15, TAU - 1.35);
    blob(b, bag.p.clone().add(v3(-0.1, 0, 0)), v3(0.08, 0.14, 0.18), w, 'saddle', 8);
  }
  info.saddleSurface = at.p.clone();
}

// ---------------------------------------------------------------------------------------------------------------
// Membranes: Coons patches between spars; attributes aMemb = (bell, side, chord).
function coons(C0, C1, D0, D1, P00, P10, P01, P11, s, t) {
  return v3()
    .addScaledVector(C0(s), 1 - t).addScaledVector(C1(s), t)
    .addScaledVector(D0(t), 1 - s).addScaledVector(D1(t), s)
    .addScaledVector(P00, -(1 - s) * (1 - t)).addScaledVector(P10, -s * (1 - t))
    .addScaledVector(P01, -(1 - s) * t).addScaledVector(P11, -s * t);
}
function polyAt(pts, u) {
  const lens = [0];
  for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const L = lens[lens.length - 1], d = clamp01(u) * L;
  let i = 0; while (i < pts.length - 2 && lens[i + 1] < d) i++;
  const t = (d - lens[i]) / Math.max(1e-6, lens[i + 1] - lens[i]);
  return pts[i].clone().lerp(pts[i + 1], t);
}

function segDist(p, a, b) {
  const ab = v3().subVectors(b, a), t = clamp01(v3().subVectors(p, a).dot(ab) / Math.max(1e-9, ab.lengthSq()));
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

function buildMembranes(b, J, shape, info) {
  const w = J.wing;
  const span = 8.5;
  const eps = 0.02 * span;
  for (const [S, s] of [['L', 1], ['R', -1]]) {
    const Sp = side(w.S, s), Ep = side(w.E, s), Wp = side(w.W, s), Rp = side(w.R, s);
    const T = w.tips.map((q) => side(q, s));
    // Body flank attachment line from the shoulder to the hip.
    const flank = [Sp.clone(), side(v3(0.5, 0.26, -0.2), s), side(v3(0.44, 0.13, -1.8), s)];
    const segs = [
      [Sp, Ep, 'wing_shoulder_' + S], [Ep, Wp, 'wing_elbow_' + S], [Wp, Rp, 'wing_wrist_' + S],
      ...T.map((q, i) => [Rp, q, `wing_f${i + 1}_${S}`]),
      [J.pelvis, J.spine1, 'pelvis'], [J.spine1, J.spine2, 'spine1'], [J.spine2, J.chest, 'spine2'], [J.chest, J.neck1, 'chest'],
      [J.tail1, J.tail2, 'tail1'],
    ];
    const weights = (p) => {
      const d = segs.map(([a, bb, bone]) => [bone, segDist(p, a, bb)]).sort((x, y) => x[1] - y[1]).slice(0, 3);
      const ws = d.map(([bone, dd]) => [bone, 1 / (dd + eps) ** 3]);
      const sum = ws.reduce((a, e) => a + e[1], 0);
      return ws.map(([bone, x]) => [bone, x / sum]).filter((e) => e[1] > 0.02);
    };
    const sideFlag = s;
    const panel = (P, ns, nt, uvFn, edgeFn) => {
      const grid = [];
      for (let i = 0; i <= ns; i++) {
        const row = [];
        for (let j = 0; j <= nt; j++) {
          const si = i / ns, tj = j / nt;
          const p = P(si, tj);
          const bell = 16 * si * (1 - si) * tj * (1 - tj);
          const [u, v] = uvFn(si, tj);
          row.push(b.vert(p, u, v, weights(p), [bell, sideFlag, edgeFn(si, tj)]));
        }
        grid.push(row);
      }
      for (let i = 0; i < ns; i++) for (let j = 0; j < nt; j++) {
        const a = grid[i][j], bb = grid[i + 1][j], c = grid[i + 1][j + 1], d = grid[i][j + 1];
        triUp(b, a, bb, c); triUp(b, a, c, d);
      }
    };
    // Finger panels (fan from the finger root R).
    for (let i = 0; i < 3; i++) {
      const A = T[i], B = T[i + 1];
      const mid = A.clone().lerp(B, 0.5);
      const nIn = v3().subVectors(Rp, mid).normalize();
      const c = 0.17 * A.distanceTo(B);
      const edge = (t) => A.clone().lerp(B, t).addScaledVector(nIn, c * Math.sin(Math.PI * t));
      panel((si, tj) => Rp.clone().lerp(edge(tj), si), 12, 7, (si, tj) => [si, 0.06 + tj * 0.94], (si) => si);
      edgeInk(b, edge, 20, weights);
    }
    // Plagiopatagium: arm (leading) / trailing edge / flank / finger 4.
    const arm = [Sp, Ep, Wp, Rp];
    const T4 = T[3], FH = flank[2];
    const trail = (u) => {           // from the hip (u=0) to the finger-4 tip (u=1), concave toward the arm
      const p = FH.clone().lerp(T4, u);
      const inward = v3(0, 0, 1);
      return p.addScaledVector(inward, 0.55 * Math.sin(Math.PI * u) ** 0.9).add(v3(0, 0.05 * Math.sin(Math.PI * u), 0));
    };
    const C0 = (u) => polyAt(arm, u), C1 = trail;
    const D0 = (t) => polyAt(flank, t), D1 = (t) => Rp.clone().lerp(T4, t);
    panel((si, tj) => coons(C0, C1, D0, D1, Sp, Rp, FH, T4, si, tj), 18, 11, (si, tj) => [tj, 0.06 + si * 0.94], (si, tj) => tj);
    edgeInk(b, trail, 28, weights);
    // Propatagium: triangle ahead of the arm, shoulder -> wrist straight leading edge.
    const lead = (u) => Sp.clone().lerp(Wp, u).add(v3(0, 0.02, 0));
    panel((si, tj) => lead(si).lerp(polyAt([Sp, Ep, Wp], si), tj), 10, 3, (si, tj) => [1 - tj, 0.06 + si * 0.94], () => 0);
    edgeInk(b, lead, 14, weights);
  }
}

/** Triangle with its normal forced to point up (+Y), since membranes are near-horizontal in bind. */
function triUp(b, a, c, d) {
  const P = b.P;
  const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
  const ux = P[c * 3] - ax, uy = P[c * 3 + 1] - ay, uz = P[c * 3 + 2] - az;
  const vx = P[d * 3] - ax, vy = P[d * 3 + 1] - ay, vz = P[d * 3 + 2] - az;
  const ny = uz * vx - ux * vz;
  if (ny >= 0) b.tri(a, c, d); else b.tri(a, d, c);
}

/** Thin ink tube along a membrane edge (drawn in the membrane mesh, ink strip of the texture). */
function edgeInk(b, fn, n, weights) {
  const pts = []; for (let i = 0; i <= n; i++) pts.push(fn(i / n));
  const fr = frames(pts, v3(0, 1, 0));
  const ring = [];
  for (let i = 0; i <= n; i++) {
    const r = [];
    for (let k = 0; k <= 4; k++) {
      const th = (k / 4) * TAU;
      const p = fr[i].p.clone().addScaledVector(fr[i].B, Math.sin(th) * 0.022).addScaledVector(fr[i].N, Math.cos(th) * 0.022);
      r.push(b.vert(p, 0.5, 0.025, weights(fr[i].p), [0, 0, 0]));
    }
    ring.push(r);
  }
  for (let i = 0; i < n; i++) for (let k = 0; k < 4; k++) {
    const a = ring[i][k], bb = ring[i][k + 1], c = ring[i + 1][k + 1], d = ring[i + 1][k];
    b.tri(a, c, bb); b.tri(a, d, c);
  }
}

function buildEyes(b, info, pal) {
  for (const e of info.eyes) {
    const n = e.n, c = e.p;
    const up = v3(0, 1, 0);
    const tang = v3().crossVectors(up, n).normalize(), bit = v3().crossVectors(n, tang);
    const ring = 12, rows = 5;
    const rx = 0.088, ry = 0.056, depth = 0.03;
    const idx = [];
    for (let i = 0; i <= rows; i++) {
      const phi = (i / rows) * (Math.PI / 2);
      const row = [];
      for (let k = 0; k <= ring; k++) {
        const th = (k / ring) * TAU;
        const r = Math.sin(phi);
        const p = c.clone().addScaledVector(tang, Math.cos(th) * r * rx).addScaledVector(bit, Math.sin(th) * r * ry).addScaledVector(n, Math.cos(phi) * depth);
        const u = 0.5 + 0.5 * Math.cos(th) * r * e.s, v = 0.5 + 0.5 * Math.sin(th) * r;
        row.push(b.vert(p, u, v, [['head', 1]]));
      }
      idx.push(row);
    }
    for (let i = 0; i < rows; i++) for (let k = 0; k < ring; k++) {
      const a = idx[i][k], bb = idx[i][k + 1], cc = idx[i + 1][k + 1], d = idx[i + 1][k];
      b.tri(a, bb, cc); b.tri(a, cc, d);
    }
  }
  void pal;
}

// ---------------------------------------------------------------------------------------------------------------
// Textures
function canvas(w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}
function toTex(c, { nearest = false } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  if (nearest) { t.magFilter = THREE.NearestFilter; }
  t.needsUpdate = true;
  return t;
}
function mulberry(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function bodyTexture(pal, info) {
  const W = 1024, H = 512, c = canvas(W, H), g = c.getContext('2d');
  const TW = W * 0.75;
  // Tube: columns = angle around (0 = dorsal), rows = along the body (top row = head end).
  const grad = g.createLinearGradient(0, 0, TW, 0);
  grad.addColorStop(0, pal.dorsal); grad.addColorStop(0.1, pal.body); grad.addColorStop(0.3, pal.flank);
  grad.addColorStop(0.5, pal.flank); grad.addColorStop(0.7, pal.flank); grad.addColorStop(0.9, pal.body); grad.addColorStop(1, pal.dorsal);
  g.fillStyle = grad; g.fillRect(0, 0, TW, H);
  // Belly plates along the ventral side, from the throat to two thirds down the tail.
  const L = info.bodyArc.L;
  const yOf = (s) => (1 - s / L) * H;
  const bellyTop = Math.max(12, yOf(info.bodyArc.sHead - 0.1)), bellyBot = yOf(info.bodyArc.sPel - 2.4);
  const bw = TW * 0.2;
  const bg = g.createLinearGradient(TW / 2 - bw, 0, TW / 2 + bw, 0);
  bg.addColorStop(0, pal.flank); bg.addColorStop(0.22, pal.belly); bg.addColorStop(0.78, pal.belly); bg.addColorStop(1, pal.flank);
  g.fillStyle = bg; g.fillRect(TW / 2 - bw, bellyTop, bw * 2, bellyBot - bellyTop);
  g.strokeStyle = pal.bellyLine; g.lineWidth = 1.3; g.globalAlpha = 0.55;
  for (let s = info.bodyArc.sHead - 0.2; s > info.bodyArc.sPel - 2.2; s -= s > info.bodyArc.sPel ? 0.19 : 0.15) {
    const y = yOf(s), half = bw * (0.5 + 0.35 * Math.min(1, (s - 1) / 3));
    g.beginPath(); g.moveTo(TW / 2 - half, y); g.quadraticCurveTo(TW / 2, y + 3.5, TW / 2 + half, y); g.stroke();
  }
  g.globalAlpha = 1;
  // Soft painterly variation (keeps the flat anime read, avoids a plastic look).
  const rnd = mulberry(7);
  g.globalAlpha = 0.05;
  for (let i = 0; i < 260; i++) {
    g.fillStyle = rnd() < 0.5 ? '#ffffff' : pal.dorsal;
    const x = rnd() * TW, y = rnd() * H, r = 6 + rnd() * 26;
    g.beginPath(); g.ellipse(x, y, r * 1.6, r, 0, 0, TAU); g.fill();
  }
  g.globalAlpha = 1;
  // Swatches: 4 columns x 3 rows in the right quarter, vertical gradients (t = 0 bottom .. 1 top in UV).
  const cw = (W - TW) / 4, ch = H / 3;
  const sw = (i, stops) => {
    const col = i % 4, row = Math.floor(i / 4), x = TW + col * cw, y = row * ch;
    const gr = g.createLinearGradient(0, y + ch, 0, y);          // bottom (t=0) -> top (t=1)
    stops.forEach((s, k) => gr.addColorStop(k / Math.max(1, stops.length - 1), s));
    g.fillStyle = gr; g.fillRect(x, y, cw, ch);
  };
  sw(SW.horn, pal.horn);
  sw(SW.claw, pal.claw);
  sw(SW.crest, pal.crest);
  sw(SW.mouth, [pal.mouth, pal.mouth]);
  sw(SW.teeth, [pal.teeth, pal.teeth]);
  sw(SW.saddle, [shade(pal.saddle, 0.8), pal.saddle, shade(pal.saddle, 1.15)]);
  sw(SW.strap, [pal.strap, pal.strap]);
  sw(SW.metal, [shade(pal.metal, 0.8), pal.metal, shade(pal.metal, 1.2)]);
  sw(SW.ear, [pal.ear, pal.body]);
  sw(SW.limb, [pal.flank, pal.limb, pal.body]);
  sw(SW.dark, ['#1a1420', '#1a1420']);
  sw(SW.spar, [pal.limb, pal.body, pal.limb]);
  return toTex(c);
}

function shade(hex, k) {
  const c = new THREE.Color(hex); c.r = Math.min(1, c.r * k); c.g = Math.min(1, c.g * k); c.b = Math.min(1, c.b * k);
  return '#' + c.getHexString();
}

function membraneTexture(pal) {
  const W = 512, H = 512, c = canvas(W, H), g = c.getContext('2d');
  const m = pal.membrane;
  // u (x) = root -> trailing edge; v (y, flipped) = across between the spars.
  const across = g.createLinearGradient(0, 0, 0, H * 0.94);   // canvas y in [0, 0.94H] = uv v in [0.06, 1]
  across.addColorStop(0, m.spar); across.addColorStop(0.18, m.mid); across.addColorStop(0.5, m.light);
  across.addColorStop(0.82, m.mid); across.addColorStop(1, m.spar);
  g.fillStyle = across; g.fillRect(0, 0, W, H);
  // Lighter, thinner toward the trailing edge.
  const along = g.createLinearGradient(0, 0, W, 0);
  along.addColorStop(0, 'rgba(0,0,0,0.10)'); along.addColorStop(0.55, 'rgba(255,255,255,0.0)'); along.addColorStop(1, 'rgba(255,255,255,0.22)');
  g.fillStyle = along; g.fillRect(0, 0, W, H);
  // Veins: branching strokes from the root toward the edge.
  const rnd = mulberry(pal.shape === 'hero' ? 11 : 23);
  g.strokeStyle = m.vein; g.lineCap = 'round';
  const vein = (x, y, ang, len, width, depth) => {
    if (depth > 4 || width < 0.4) return;
    const x2 = x + Math.cos(ang) * len, y2 = y + Math.sin(ang) * len;
    const cx = (x + x2) / 2 + (rnd() - 0.5) * len * 0.35, cy = (y + y2) / 2 + (rnd() - 0.5) * len * 0.35;
    g.globalAlpha = 0.5 + 0.1 * (4 - depth); g.lineWidth = width;
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(cx, cy, x2, y2); g.stroke();
    const nb = depth < 2 ? 2 : 1 + (rnd() < 0.5 ? 1 : 0);
    for (let k = 0; k < nb; k++) vein(x2, y2, ang + (rnd() - 0.5) * 1.0, len * (0.55 + rnd() * 0.25), width * 0.66, depth + 1);
  };
  for (let i = 0; i < 7; i++) {
    const y = H * 0.94 * (0.08 + 0.84 * (i / 6)) + (rnd() - 0.5) * 20;
    vein(0, y, (rnd() - 0.5) * 0.35, 120 + rnd() * 60, 3.2, 0);
  }
  g.globalAlpha = 1;
  // Ink strip (edge lines) at the bottom 6 %.
  g.fillStyle = m.ink; g.fillRect(0, H * 0.95, W, H * 0.05);
  return toTex(c);
}

function eyeTexture(pal) {
  const S = 128, c = canvas(S, S), g = c.getContext('2d');
  g.fillStyle = '#1a1420'; g.fillRect(0, 0, S, S);
  const gr = g.createRadialGradient(S * 0.5, S * 0.55, 4, S * 0.5, S * 0.5, S * 0.46);
  gr.addColorStop(0, shade(pal.iris, 1.35)); gr.addColorStop(0.55, pal.iris); gr.addColorStop(1, pal.irisDark);
  g.fillStyle = gr; g.beginPath(); g.ellipse(S * 0.5, S * 0.5, S * 0.44, S * 0.4, 0, 0, TAU); g.fill();
  g.fillStyle = '#120c18'; g.beginPath(); g.ellipse(S * 0.5, S * 0.5, S * 0.07, S * 0.3, 0, 0, TAU); g.fill();   // slit pupil
  g.fillStyle = '#ffffff'; g.beginPath(); g.ellipse(S * 0.36, S * 0.32, S * 0.09, S * 0.07, -0.4, 0, TAU); g.fill();
  g.globalAlpha = 0.7; g.beginPath(); g.ellipse(S * 0.62, S * 0.66, S * 0.04, S * 0.03, 0, 0, TAU); g.fill();
  g.globalAlpha = 1;
  // Upper lid line
  g.strokeStyle = '#120c18'; g.lineWidth = 10; g.beginPath(); g.ellipse(S * 0.5, S * 0.56, S * 0.46, S * 0.44, 0, Math.PI * 1.08, Math.PI * 1.92); g.stroke();
  return toTex(c);
}

// ---------------------------------------------------------------------------------------------------------------
// Shape cache (geometry per shape, textures per variant).
const shapeCache = new Map();
const texCache = new Map();

function buildShape(shape) {
  if (shapeCache.has(shape)) return shapeCache.get(shape);
  const J = makeLayout(shape);
  const table = boneTable(J);
  const boneIndex = {}; table.forEach((t, i) => { boneIndex[t.name] = i; });
  const info = {};
  const body = new Builder(boneIndex);
  buildBody(body, J, shape, info);
  buildHead(body, J, shape, info);
  buildHornsAndCrest(body, J, shape, info);
  buildLegs(body, J, shape, info);
  buildWingSpars(body, J, shape, info);
  buildSaddle(body, J, shape, info);
  const memb = new Builder(boneIndex);
  buildMembranes(memb, J, shape, info);
  const eyes = new Builder(boneIndex);
  buildEyes(eyes, info);
  const out = {
    J, table, boneIndex, info,
    bodyGeo: body.geometry(), membGeo: memb.geometry({ extra: true }), eyeGeo: eyes.geometry({ weld: false }),
    // Mouth: a point between the jaws near the front, in the head bone's frame (bind orientation = model).
    mouthLocal: J.head.clone().lerp(J.nose, 0.86).add(v3(0, -0.14, 0)).sub(J.head),
  };
  shapeCache.set(shape, out);
  return out;
}

function variantTextures(variant, shapeData) {
  if (texCache.has(variant)) return texCache.get(variant);
  const pal = DRAGON_PALETTES[variant];
  const t = { body: bodyTexture(pal, shapeData.info), membrane: membraneTexture(pal), eye: eyeTexture(pal) };
  texCache.set(variant, t);
  return t;
}

/**
 * Build one fallback dragon instance (own bones and materials, shared geometry/textures).
 * Returns { scene, bones: Map, skinned: [...], materials, membraneUniforms, mouth: {bone, offset}, fallback: true }.
 */
export function createFallbackDragon(game, variant = 'hero') {
  const pal = DRAGON_PALETTES[variant] || DRAGON_PALETTES.hero;
  const data = buildShape(pal.shape);
  const tex = variantTextures(DRAGON_PALETTES[variant] ? (pal.texKey || variant) : 'hero', data);

  const scene = new THREE.Group();
  scene.name = `dragon_${variant}_fallback`;
  const bones = new Map(), list = [];
  for (const t of data.table) {
    const bone = new THREE.Bone();
    bone.name = t.name;
    const parent = t.parent ? bones.get(t.parent) : null;
    bone.position.copy(t.pos).sub(parent ? data.table[data.boneIndex[t.parent]].pos : v3());
    if (t.tip) bone.userData.tip = t.tip.clone().sub(t.pos);       // leaf direction (bone-local = model axes)
    (parent || scene).add(bone);
    bones.set(t.name, bone); list.push(bone);
  }
  scene.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(list);

  const toon = game.toon;
  const mkToon = (opts) => (toon ? toon.material(opts) : new THREE.MeshToonMaterial({ map: opts.map, side: opts.side ?? THREE.FrontSide }));
  // wave 4: painted volume (the canvas texture already paints dorsal / flank / belly; the patch adds the light on it)
  const volU = pal.volume && toon && game.params?.get?.('dragonVolume') !== '0' ? volumeUniforms(pal.volume) : null;
  const bodyMat = mkToon({ map: tex.body, color: 0xffffff, steps: 3, rim: 0xfff4e0, rimPower: 3.2, ...(volU ? { mid: pal.volume.mid ?? 0 } : {}) });
  if (volU) { if (game.atmo?.sunDir) volU.uVolSun.value = game.atmo.sunDir; patchVolume(bodyMat, volU); }
  const membU = {
    uCamberL: { value: 0 }, uCamberR: { value: 0 }, uFlutter: { value: 0 }, uMembTime: { value: 0 },
    uMembGlow: { value: pal.glowStrength }, uMembGlowColor: { value: new THREE.Color(pal.glow) }, uMembGlowMix: { value: pal.glowMix ?? 0.3 },
    uMembSun: { value: game.atmo?.sunDir || v3(-0.45, 0.62, -0.64).normalize() },
    uMembGlowBase: { value: pal.glowBase || 0 }, uMembVein: { value: new THREE.Color(...(pal.veinDark || [1, 1, 1])) },
  };
  const membMat = mkToon({ map: tex.membrane, color: 0xffffff, steps: 3, side: THREE.DoubleSide, rim: 0xeafffb, rimPower: 4 });
  patchMembrane(membMat, membU, true);

  const body = new THREE.SkinnedMesh(data.bodyGeo, bodyMat);
  body.name = 'dragon_body';
  const memb = new THREE.SkinnedMesh(data.membGeo, membMat);
  memb.name = 'dragon_membrane';
  const eyeMat = new THREE.MeshBasicMaterial({ map: tex.eye, side: THREE.DoubleSide, color: new THREE.Color(1, 1, 1).multiplyScalar(pal.eyeGlow) });
  game.atmo?.patch(eyeMat);
  const eyes = new THREE.SkinnedMesh(data.eyeGeo, eyeMat);
  eyes.name = 'dragon_eyes';
  for (const m of [body, memb, eyes]) {
    scene.add(m);
    m.bind(skeleton, new THREE.Matrix4());
    m.boundingSphere = new THREE.Sphere(v3(0, 0, -0.5), 11);
    m.castShadow = m !== eyes;
    m.receiveShadow = m === body;
  }
  memb.receiveShadow = false;
  const outlines = [];
  if (toon) {
    const o = toon.outline(body, { width: 0.035, tint: pal.outlineTint });
    if (o) { o.boundingSphere = body.boundingSphere; outlines.push(o); }
  }
  return {
    scene, bones, skeleton, skinned: [body, memb, eyes], outlines, fallback: true,
    materials: { body: bodyMat, membrane: membMat, eyes: eyeMat },
    membraneUniforms: membU, membU, volumeUniforms: volU,
    mouth: { bone: 'head', offset: data.mouthLocal.clone() },
    info: { length: 13.4, span: 16.8, headLength: data.info.head.Lh },
    // 25.09 (levels and elements): head-rigid landmarks in the model frame (bind) — eye centres, main horn curves
    eyes: (data.info.eyes || []).map((e) => e.p.clone()), horns: (data.info.horns || []).map((h) => h.map((p) => p.clone())),
  };
}

/**
 * Membrane shading: billow/camber + trailing-edge flutter in the vertex stage (fallback geometry only: needs aMemb),
 * and the anime back-light glow (sun behind the membrane relative to the viewer) in the fragment stage.
 * Works on top of whatever onBeforeCompile the toon/atmo owners installed; missing chunks are skipped.
 */
// Billow displacement (vertex stage, before skinning). aMemb = (bell 0 at a spar .. 1 mid-panel, side +1 L / -1 R,
// edge 0 leading .. 1 trailing edge). 'attr' mode (GLB closed-shell membranes) displaces along aMembN, the panel's
// upper normal, so both faces of the shell move together; the fallback's single sheet uses its own normal.
const billowChunk = (dirExpr) => `
          {
            float mSide = aMemb.y;
            float mCamber = mSide > 0.0 ? uCamberL : uCamberR;
            float mBell = aMemb.x;
            float mEdge = aMemb.z;
            float mFlut = uFlutter * sin(uMembTime * 11.0 - mEdge * 9.0 + mSide * 1.3) * mEdge * mEdge * min(1.0, mBell * 4.0);
            transformed += ${dirExpr} * (mCamber * mBell + mFlut);
          }`;
const billowPars = (attr) => `\nattribute vec3 aMemb;${attr ? '\nattribute vec3 aMembN;' : ''}\nuniform float uCamberL, uCamberR, uFlutter, uMembTime;`;

/** The toon outline hull of a billowing membrane gets the same displacement (else the ink line lags the sheet). */
export function patchMembraneOutline(mat, U) {
  if (!mat || mat.userData.membraneBillow) return;
  mat.userData.membraneBillow = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(mat, sh, r);
    Object.assign(sh.uniforms, { uCamberL: U.uCamberL, uCamberR: U.uCamberR, uFlutter: U.uFlutter, uMembTime: U.uMembTime });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>' + billowPars(true))
      .replace('#include <begin_vertex>', '#include <begin_vertex>' + billowChunk('aMembN'));
  };
  addCacheKey(mat, '|membrane-billow-ol');
}

/** Make a shader patch part of the program cache key, whatever key function the toon/atmo owners installed. */
export function addCacheKey(mat, suffix) {
  mat.userData.cacheKey = (mat.userData.cacheKey || 'mat') + suffix;
  const prevKey = mat.customProgramCacheKey;
  mat.customProgramCacheKey = function () { return (prevKey ? prevKey.call(this) : '') + suffix; };
  mat.needsUpdate = true;
}

export function patchMembrane(mat, U, withBillow, masked = false) {
  const prev = mat.onBeforeCompile;
  const attr = withBillow === 'attr';
  // wave 4: the membrane coordinates (aMemb) also reach the fragment stage: albedo re-grade, veins against the glow
  const coords = !!withBillow;
  const remap = coords && !!U.uMembRemap && U.uMembRemap.value > 0;
  if (!U.uMembGlowBase) U.uMembGlowBase = { value: 0 };
  if (!U.uMembVein) U.uMembVein = { value: new THREE.Color(1, 1, 1) };
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(mat, sh, r);
    Object.assign(sh.uniforms, U);
    if (withBillow) {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>' + billowPars(attr) + '\nvarying vec3 vMembM;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vMembM = aMemb;' + billowChunk(attr ? 'aMembN' : 'normalize(objectNormal)'));
    }
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uMembGlow, uMembGlowMix, uMembGlowBase; uniform vec3 uMembGlowColor; uniform vec3 uMembSun; uniform vec3 uMembVein;'
        + (masked ? '\nuniform vec3 uMembMask;' : '') + (coords ? '\nvarying vec3 vMembM;' : '')
        + (remap ? '\nuniform float uMembRemap, uMembTexL; uniform vec3 uMembA, uMembB;' : ''));
    if (remap) {
      // amber at the spars and the leading edge -> light gold toward the trailing edge and mid-panel (key art); the
      // texture's painted veins stay as luminance detail around its mean
      sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
        {
          float mT = clamp(vMembM.z * 0.7 + vMembM.x * 0.45, 0.0, 1.0);
          vec3 mG = mix(uMembA, uMembB, mT);
          float mL = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722)) / max(1e-3, uMembTexL);
          diffuseColor.rgb = mix(diffuseColor.rgb, mG * clamp(pow(max(mL, 0.0), 0.85), 0.3, 1.35), uMembRemap);
        }`);
    }
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <opaque_fragment>', `
        {
          vec3 mV = normalize(vViewPosition);
          vec3 mL = normalize((viewMatrix * vec4(uMembSun, 0.0)).xyz);
          float mBack = clamp(-dot(normal, mL), 0.0, 1.0);
          float mToward = clamp(dot(-mV, mL) * 0.5 + 0.5, 0.0, 1.0);
          float mGlow = smoothstep(0.04, 0.22, mBack) * (0.3 + 0.7 * mToward * mToward);
          ${masked ? `
          // single-material GLB: glow only where the albedo has the membrane's chroma
          vec3 mA = diffuseColor.rgb;
          float mSat = max(mA.r, max(mA.g, mA.b)) - min(mA.r, min(mA.g, mA.b));
          vec3 mN = mA / max(1e-3, mA.r + mA.g + mA.b), mK = uMembMask / max(1e-3, uMembMask.r + uMembMask.g + uMembMask.b);
          mGlow *= (1.0 - smoothstep(0.07, 0.18, distance(mN, mK))) * smoothstep(0.03, 0.12, mSat);` : ''}
          // wave 4: a thin living membrane always passes some light (more toward the sun), not only when backlit
          float mGlowAll = mGlow + uMembGlowBase * (0.35 + 0.65 * mToward) * (1.0 - 0.6 * mGlow);
          // light through the membrane: its albedo shifted toward the glow colour (gold for Sora, lilac / ice-blue
          // for the Shade Riders), so a backlit wing reads luminous rather than just brighter
          outgoingLight += mix(diffuseColor.rgb, uMembGlowColor, uMembGlowMix) * uMembGlowColor * mGlowAll * uMembGlow;
          ${coords ? `
          // veins and spars: darker lines on the glowing panel (bell = 0 on an arm / finger / the flank), >= 1.5 px
          float mB = vMembM.x;
          float mVw = max(0.07, fwidth(mB) * 1.5);
          float mSp = 1.0 - smoothstep(0.0, mVw, mB);
          outgoingLight *= mix(vec3(1.0), uMembVein, mSp * clamp(mGlowAll * 1.4, 0.0, 1.0));` : ''}
        }
        #include <opaque_fragment>`);
  };
  addCacheKey(mat, (withBillow ? (attr ? '|membrane-billow-attr' : '|membrane-billow') : '|membrane') + (masked ? '-masked' : '') + (remap ? '-remap' : '') + '|w4');
}

/**
 * Wave 4 — painted volume on a dragon's body (critics: "Sora reads flat: one-tone red from above and behind"), after
 * the toon lighting, in the dragon's OWN frame (uBodyUpW = the rendered body's up axis in world space, per frame), so
 * a banking dragon keeps its countershading:
 *   darker, deeper dorsal (countershading) · a third, lighter painted value step where the sun meets the ridges ·
 *   warm reflected light on the underside (cream-gold belly, not flat violet) · a darker form band where the flank
 *   turns away before the silhouette (the rim light stays on the edge).
 * Uses the toon lighting terms (lit, x, A, Lc, N, nW) when the toon owner's shader has them; else a self-contained
 * approximation. U = volumeUniforms(palette.volume).
 */
export function volumeUniforms(v = {}) {
  const k = v.k || [0.6, 0.35, 0.4, 0.25], hi = v.hi || [1, 0.75, 0.55, 0.76];
  return {
    uBodyUpW: { value: new THREE.Vector3(0, 1, 0) }, uVolSun: { value: new THREE.Vector3(-0.45, 0.62, -0.64).normalize() },
    uVolK: { value: new THREE.Vector4(...k) }, uVolDorsal: { value: new THREE.Vector3(...(v.dorsal || [0.82, 0.7, 0.74])) },
    uVolWarm: { value: new THREE.Vector3(...(v.warm || [1, 0.56, 0.3])) }, uVolHi: { value: new THREE.Vector4(...hi) },
  };
}
export function patchVolume(mat, U) {
  if (!mat || mat.userData.volumePatched) return;
  mat.userData.volumePatched = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(mat, sh, r);
    Object.assign(sh.uniforms, U);
    const fs = sh.fragmentShader;
    const toonTerms = /float lit\s*=/.test(fs) && /vec3 nW\s*=/.test(fs) && /vec3 Lc\s*=/.test(fs) && /float x\s*=/.test(fs);
    sh.fragmentShader = fs
      .replace('#include <common>', '#include <common>\nuniform vec3 uBodyUpW, uVolSun, uVolDorsal, uVolWarm; uniform vec4 uVolK, uVolHi;')
      .replace('#include <opaque_fragment>', `
        {
          ${toonTerms ? 'vec3 vN = N; vec3 vA = A; float vLit = lit; float vX = x; vec3 vLc = Lc; vec3 vWN = nW;' : `
          vec3 vN = normalize(normal); vec3 vA = diffuseColor.rgb; vec3 vWN = inverseTransformDirection(vN, viewMatrix);
          float vX = dot(vN, normalize((viewMatrix * vec4(uVolSun, 0.0)).xyz)); float vLit = smoothstep(-0.02, 0.02, vX); vec3 vLc = vec3(1.0);`}
          float vUp = dot(vWN, uBodyUpW);
          float vDors = smoothstep(0.2, 0.9, vUp), vBelly = smoothstep(-0.1, -0.8, vUp);
          outgoingLight *= mix(vec3(1.0), uVolDorsal, vDors * uVolK.x);
          float vHi = smoothstep(uVolHi.w, uVolHi.w + 0.05, vX) * vLit;
          outgoingLight += vA * vLc * uVolHi.rgb * vHi * uVolK.z;
          outgoingLight += vA * vLc * uVolWarm * vBelly * uVolK.y * (1.0 - 0.7 * vLit);
          float vNdV = abs(dot(vN, normalize(vViewPosition)));
          outgoingLight *= 1.0 - uVolK.w * smoothstep(0.5, 0.2, vNdV) * smoothstep(0.03, 0.12, vNdV);
        }
        #include <opaque_fragment>`);
  };
  addCacheKey(mat, '|volume-w4');
}

// ---------------------------------------------------------------------------------------------------------------
// Rig: bind data and a model-space pose solver that works for the fallback and for any GLB (dragon or rider).
// Handlers get (i, Qinherited, Qparent) with Pm[i] already set, and return a model-space orientation or null.
const _rq1 = new THREE.Quaternion(), _rq2 = new THREE.Quaternion(), _rq3 = new THREE.Quaternion();
export class Rig {
  /** opts.leafLength(name) -> metres for bones without a child (GLB leaves point along their local +Y). */
  constructor(model, opts = {}) {
    this.model = model;
    const root = model.scene;
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    this.bones = []; this.index = new Map();
    root.traverse((o) => { if (o.isBone) { this.index.set(o.name, this.bones.length); this.bones.push(o); } });
    const n = this.bones.length;
    this.parent = new Int32Array(n).fill(-1);
    this.bindQ = []; this.bindP = []; this.bindS = []; this.Qb = []; this.Pb = []; this.Sb = [];
    this.Qm = []; this.Pm = []; this.Sm = new Float32Array(n);
    this.rootQ = []; this.rootP = []; this.rootS = [];
    const tmpM = new THREE.Matrix4(), s3 = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const b = this.bones[i];
      const pi = b.parent?.isBone ? this.index.get(b.parent.name) : -1;
      this.parent[i] = pi ?? -1;
      this.bindQ.push(b.quaternion.clone()); this.bindP.push(b.position.clone()); this.bindS.push((b.scale.x + b.scale.y + b.scale.z) / 3);
      tmpM.multiplyMatrices(inv, b.matrixWorld);
      const q = new THREE.Quaternion(), p = new THREE.Vector3();
      tmpM.decompose(p, q, s3);
      this.Qb.push(q); this.Pb.push(p); this.Sb.push((s3.x + s3.y + s3.z) / 3);
      this.Qm.push(q.clone()); this.Pm.push(p.clone());
      if (pi < 0) {                                  // static transform of the non-bone ancestors
        const pm = new THREE.Matrix4().multiplyMatrices(inv, b.parent.matrixWorld);
        const pq = new THREE.Quaternion(), pp = new THREE.Vector3(), ps = new THREE.Vector3();
        pm.decompose(pp, pq, ps);
        this.rootQ[i] = pq; this.rootP[i] = pp; this.rootS[i] = (ps.x + ps.y + ps.z) / 3;
      }
    }
    // Child direction / length per bone (model space, bind). Leaf bones use userData.tip or the parent direction.
    this.dir = []; this.len = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const b = this.bones[i];
      const kids = b.children.filter((c) => c.isBone);
      const d = new THREE.Vector3();
      if (b.userData.tip) d.copy(b.userData.tip).multiplyScalar(this.Sb[i]).applyQuaternion(this.Qb[i]);
      else if (kids.length) {
        for (const k of kids) d.add(this.Pb[this.index.get(k.name)]).sub(this.Pb[i]);
        d.divideScalar(kids.length);
      }
      if (d.lengthSq() < 1e-8) {                      // leaf or zero-length bone: glTF/Blender bones run along +Y
        d.set(0, 1, 0).applyQuaternion(this.Qb[i]).multiplyScalar((opts.leafLength?.(b.name) ?? 0.25) * this.Sb[i]);
      }
      this.len[i] = d.length();
      this.dir.push(d.lengthSq() > 1e-12 ? d.normalize() : new THREE.Vector3(0, 0, 1));
    }
    this.handlers = new Array(n).fill(null);
    // 24.09 (many dragons): solve() writes every bone's quaternion each frame, and three keeps each Object3D's Euler
    // `rotation` in sync on every write (a rotation matrix + asin/atan2 per bone: ≈ 0.3 ms per frame with 34 dragons
    // and their riders). Nothing reads a solved bone's Euler (three composes from the quaternion), so the sync is cut for
    // the rig's bones; setting bone.rotation still updates the quaternion.
    const noop = () => {};
    for (const b of this.bones) b.quaternion._onChange?.(noop);
  }
  has(name) { return this.index.has(name); }
  i(name) { return this.index.get(name) ?? -1; }
  /** Solve all bones top-down. handler(i, Qinh) returns a model-space orientation (or null = bind local). */
  solve() {
    const n = this.bones.length;
    for (let i = 0; i < n; i++) {
      const p = this.parent[i];
      const Qp = p >= 0 ? this.Qm[p] : this.rootQ[i], Pp = p >= 0 ? this.Pm[p] : this.rootP[i], Sp = p >= 0 ? this.Sm[p] : this.rootS[i];
      const b = this.bones[i];
      const h = this.handlers[i];
      const Qm = this.Qm[i];
      this.Pm[i].copy(this.bindP[i]).multiplyScalar(Sp).applyQuaternion(Qp).add(Pp);   // joint position (known first)
      this.Sm[i] = Sp * this.bindS[i];
      Qm.copy(Qp).multiply(this.bindQ[i]);           // inherited orientation
      if (h) {
        const r = h(i, Qm, Qp);
        if (r) Qm.copy(r);
      }
      b.quaternion.copy(_rq1.copy(Qp).invert().multiply(Qm));
    }
  }
  /** Model-space rotation of bone i relative to its bind orientation. */
  delta(i, out = new THREE.Quaternion()) { return out.copy(this.Qm[i]).multiply(_rq2.copy(this.Qb[i]).invert()); }
  /** Model-space point at bone-local offset (bind axes of the bone). */
  pointAt(i, local, out = new THREE.Vector3()) { return out.copy(local).multiplyScalar(this.Sm[i]).applyQuaternion(this.Qm[i]).add(this.Pm[i]); }
  tipOf(i, out = new THREE.Vector3()) {           // model-space end of bone i
    return out.copy(this.dir[i]).multiplyScalar(this.len[i]).applyQuaternion(this.delta(i, _rq3)).add(this.Pm[i]);
  }
}


/**
 * Canonical wing convention frames (bind layout = wingkin WING_GEOMETRY): per bone name, the rotation whose columns
 * are X = Y x Z, Y = along the bone, Z = the wing's upper normal, in model axes. Converts a rotation authored in the
 * bone's own frame into body axes: q_body = C q C^-1.
 */
let _canon = null;
export function canonicalWingFrames() {
  if (_canon) return _canon;
  const table = boneTable(makeLayout('hero'));
  const byName = new Map(table.map((t) => [t.name, t]));
  _canon = new Map();
  for (const t of table) {
    if (!t.name.startsWith('wing_')) continue;
    const child = table.find((c) => c.parent === t.name);
    const Yc = (t.tip ? t.tip.clone().sub(t.pos) : child ? child.pos.clone().sub(t.pos) : v3(0, 0, 1)).normalize();
    const Zc = v3(0, 1, 0).addScaledVector(Yc, -Yc.y).normalize();
    const Xc = v3().crossVectors(Yc, Zc).normalize();
    Zc.crossVectors(Xc, Yc).normalize();
    _canon.set(t.name, new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(Xc, Yc, Zc)));
  }
  void byName;
  return _canon;
}

/** Canonical leaf lengths (m, scale 1) for rigs whose leaf bones carry no tail. */
export function dragonLeafLength(name) {
  if (/wing_f1/.test(name)) return 3.3;
  if (/wing_f2/.test(name)) return 3.5;
  if (/wing_f3/.test(name)) return 3.1;
  if (/wing_f4/.test(name)) return 2.6;
  if (/wing_wrist/.test(name)) return 0.45;
  if (name === 'head') return 1.2;
  if (name === 'jaw') return 0.9;
  if (name === 'tail10') return 0.35;
  if (/^foot_/.test(name)) return 0.4;
  if (name === 'saddle') return 0.3;
  return 0.25;
}

/**
 * Synchronous GLB instancing for models that already finished loading (mirrors core/assets.instanceGLB), so a
 * dragon or rider spawned after the first one never shows the procedural fallback for a frame.
 */
const resolvedGLB = new Map();
export function trackGLB(name, loadGLB) {
  if (!resolvedGLB.has(name)) { resolvedGLB.set(name, undefined); loadGLB(name).then((g) => resolvedGLB.set(name, g || null)); }
  return resolvedGLB.get(name);
}
export function instanceSync(gltf, cloneSkinned) {
  const scene = cloneSkinned(gltf.scene);
  const bones = new Map(), skinned = [];
  scene.traverse((o) => { if (o.isBone) bones.set(o.name, o); if (o.isSkinnedMesh) skinned.push(o); });
  return { scene, animations: gltf.animations, bones, skinned, userData: gltf.userData || {} };
}

/**
 * Wave 4 (bug hunter #7: renderer.info.memory grew with every rider ever spawned): release the per-instance GPU
 * resources under `root` — every SkinnedMesh skeleton's bone texture (instances own cloned skeletons; outlines share
 * their mesh's), the ink-hull materials, and optionally the meshes' own materials and extra per-instance objects.
 * Shared geometry and textures (GLB cache, the fallback's shape / texture caches) are never touched.
 *   opts: { materials: dispose mesh materials too (not the maps), geometries: Set of per-instance geometries }
 */
export function disposeInstance(root, opts = {}) {
  if (!root) return 0;
  const skeletons = new Set(), mats = new Set();
  root.traverse((o) => {
    if (o.isSkinnedMesh && o.skeleton) skeletons.add(o.skeleton);
    if (!o.isMesh && !o.isPoints) return;
    if (o.userData.isOutline || opts.materials) for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m) mats.add(m);
    if (opts.geometries?.has?.(o.geometry)) o.geometry.dispose();
  });
  for (const sk of skeletons) { try { sk.dispose(); } catch { /* already gone */ } }
  for (const m of mats) { try { m.dispose(); } catch { /* ignore */ } }
  return skeletons.size;
}

export const FALLBACK_BONES = () => boneTable(makeLayout('hero')).map((t) => t.name);
