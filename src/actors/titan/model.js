// Titan model: the GLB ('titan', produced by the Blender owner) when available, else a procedural fallback built
// here with the SAME contract bone names (+ a few helper bones for feathers and the loincloth).
// Procedural rest pose = the rig's canonical pose: T-pose arms along ±X with palms down, legs straight down, wings
// spread along ±X with feathers trailing −Z. Model origin = pelvis. Height ≈ 120 m, wingspan ≈ 260 m.
import * as THREE from 'three';
import { MeshBuilder, ellipsoid, tube, block, feather, addCracks, addSeam, fbm3 } from './geo.js';
import { instanceGLB } from '../../core/assets.js';
import { rng as makeRng, clamp } from '../../core/util.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const Q = (x, y, z, order = 'XYZ') => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, order));
const D2R = Math.PI / 180;
// Aerial perspective strength for the titan's materials (toon default 0.75 for characters): a 110 m colossus should
// sit in the air like a mountain — at 300 m ≈ 10 % haze, at 700 m ≈ 20 % (storm preset), near it unchanged (wave 4).
export const TITAN_ATMO = 3.0;

// Finger layout (left hand; right is mirrored). Segment lengths and radii in metres.
export const FINGERS = {
  thumb: { base: [55.0, 34.5, 1.9], dir: [0.55, -0.32, 0.77], len: [3.0, 2.5, 2.1], r: [1.35, 1.2, 1.02] },
  index: { base: [60.2, 35.7, 1.75], dir: [1, -0.02, 0.06], len: [3.1, 2.3, 1.8], r: [1.05, 0.95, 0.84] },
  middle: { base: [60.7, 35.75, -0.3], dir: [1, -0.02, 0], len: [3.4, 2.5, 1.9], r: [1.1, 1.0, 0.88] },
  ring: { base: [60.3, 35.65, -2.25], dir: [1, -0.02, -0.06], len: [3.2, 2.35, 1.8], r: [1.02, 0.93, 0.82] },
  pinky: { base: [59.4, 35.4, -3.95], dir: [1, -0.03, -0.13], len: [2.5, 1.9, 1.5], r: [0.88, 0.8, 0.7] },
};
export const FINGER_NAMES = ['thumb', 'index', 'middle', 'ring', 'pinky'];
export const PRIMARIES = 10;

/** Canonical rest skeleton (the procedural rig) — name → { parent, pos }. The rig aligns any model to it. */
export function canonicalBones() { return new Map(boneDefs().map((d) => [d.name, d])); }

function boneDefs() {
  const d = [];
  const add = (name, parent, p) => d.push({ name, parent, pos: V(...p) });
  add('root', null, [0, 0, 0]);
  add('hips', 'root', [0, 0, 0]);
  add('spine1', 'hips', [0, 7, 0.4]);
  add('spine2', 'spine1', [0, 15, 0.8]);
  add('chest', 'spine2', [0, 24, 0.4]);
  add('neck', 'chest', [0, 38.5, -0.6]);
  add('head', 'neck', [0, 44, 0.4]);
  add('jaw', 'head', [0, 46.8, 2.2]);
  add('cloth_F1', 'hips', [0, 0.5, 9.2]); add('cloth_F2', 'cloth_F1', [0, -12.5, 10.2]); add('cloth_F3', 'cloth_F2', [0, -25, 10.6]);
  add('cloth_B1', 'hips', [0, 0.5, -8.6]); add('cloth_B2', 'cloth_B1', [0, -11.5, -9.6]); add('cloth_B3', 'cloth_B2', [0, -22, -10]);
  for (const s of [1, -1]) {
    const S = s > 0 ? '_L' : '_R';
    const m = (p) => [p[0] * s, p[1], p[2]];
    add('shoulder' + S, 'chest', m([3.5, 35, -0.6]));
    add('upperarm' + S, 'shoulder' + S, m([15.5, 35.5, -1]));
    add('forearm' + S, 'upperarm' + S, m([36.5, 35.5, -1]));
    add('hand' + S, 'forearm' + S, m([53.5, 35.5, -1]));
    for (const f of FINGER_NAMES) {
      const F = FINGERS[f];
      const dir = V(...F.dir).normalize();
      let p = V(...F.base);
      let parent = 'hand' + S;
      for (let k = 0; k < 3; k++) {
        const name = `${f}${k + 1}${S}`;
        add(name, parent, m(p.toArray()));
        p = p.clone().addScaledVector(dir, F.len[k]);
        parent = name;
      }
    }
    add('thigh' + S, 'hips', m([8, -4, 0]));
    add('shin' + S, 'thigh' + S, m([8.8, -31, 0.6]));
    add('foot' + S, 'shin' + S, m([9.2, -57, -0.8]));
    add('toe' + S, 'foot' + S, m([9.4, -61.2, 7.2]));
    add('wing1' + S, 'chest', m([5, 32.5, -7.5]));
    add('wing2' + S, 'wing1' + S, m([30, 32.5, -7.5]));
    add('wing3' + S, 'wing2' + S, m([62, 32.5, -7.5]));
    add('wing4' + S, 'wing3' + S, m([84, 32.5, -7.5]));
    for (let i = 0; i < PRIMARIES; i++) {
      const x = 64 + i * 3.6;                    // primary roots from the wing hand to the tip
      add(`feather_p${i}${S}`, x < 84 ? 'wing3' + S : 'wing4' + S, m([x, 32.8, -6.6]));
    }
  }
  return d;
}

/** Glow shader for cracks / core / eyes / seams (own material; every uniform is animated by the titan). */
export function makeGlowMaterial(game) {
  const uniforms = {
    uCrack: { value: 1.0 }, uCore: { value: 3.0 }, uEye: { value: 4.0 }, uSeam: { value: 0.8 },
    uTime: { value: 0 }, uFlash: { value: 0 },
    uWaveL: { value: new THREE.Vector4(-100, 8, 0, 0) },   // front (m along the body graph), width, charged, strength
    uWaveR: { value: new THREE.Vector4(-100, 8, 0, 0) },
    uCrackColor: { value: new THREE.Color(1.0, 0.62, 0.16) },
    uHotColor: { value: new THREE.Color(1.0, 0.93, 0.72) },
    uEyeColor: { value: new THREE.Color(1.0, 0.85, 0.45) },
  };
  const m = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 glowData;\nvarying vec3 vGlowData;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlowData = glowData;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vGlowData;
        uniform float uCrack, uCore, uEye, uSeam, uTime, uFlash;
        uniform vec4 uWaveL, uWaveR;
        uniform vec3 uCrackColor, uHotColor, uEyeColor;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float k = vGlowData.z;
          float base = k < 0.5 ? uCrack : (k < 1.5 ? uCore : (k < 2.5 ? uEye : uSeam));
          vec4 wv = vGlowData.y > 0.5 ? uWaveL : (vGlowData.y < -0.5 ? uWaveR : vec4(-100.0, 8.0, 0.0, 0.0));
          float d = (vGlowData.x - wv.x) / max(wv.y, 0.1);
          float front = exp(-d * d) * wv.w;
          float charged = vGlowData.x < wv.x ? wv.z : 0.0;
          float breath = 0.82 + 0.18 * sin(uTime * 0.75 - vGlowData.x * 0.06);
          float heat = clamp(front * 0.8 + charged * 0.4 + uFlash * 0.6, 0.0, 1.0);
          vec3 c = k > 1.5 && k < 2.5 ? uEyeColor : mix(uCrackColor, uHotColor, heat);
          diffuseColor.rgb = c * (base * breath + front * 3.5 + charged * 1.6 + uFlash * 2.0);
        }`);
  };
  m.userData.cacheKey = 'titan-glow';
  m.customProgramCacheKey = () => 'titan-glow';
  if (game.atmo) game.atmo.patch(m);
  m.userData.glowUniforms = uniforms;
  return { material: m, uniforms };
}

/**
 * The shared inverted-hull outline (render/toon.js) extrudes along transformedNormal, which three negates for
 * BackSide materials (FLIP_SIDED), so on thick bodies the hull shrinks inside the mesh and no line shows. Until the
 * toon owner fixes it, un-flip it here — only when the shader still has that exact line and no fix of its own.
 */
export function fixOutlineFlip(outlineMesh) {
  const mat = outlineMesh?.material;
  if (!mat || mat.userData.titanFlipFix) return;
  mat.userData.titanFlipFix = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    const line = 'vec3 olN = normalize(transformedNormal);';
    const i = shader.vertexShader.indexOf(line);
    if (i < 0 || shader.vertexShader.slice(i, i + 400).includes('FLIP_SIDED')) return;
    shader.vertexShader = shader.vertexShader.replace(line, line + '\n  #ifdef FLIP_SIDED\n  olN = -olN;\n  #endif');
  };
  const key = mat.customProgramCacheKey?.bind(mat);
  mat.customProgramCacheKey = () => (key ? key() : '') + '|flipfix';
  mat.needsUpdate = true;
}

function stoneMaterial(game, opts = {}) {
  let m;
  if (game.toon) m = game.toon.material({ color: 0xffffff, steps: 3, rim: opts.rim ?? 0xfff1d8, rimPower: opts.rimPower ?? 2.6, side: opts.side, atmo: TITAN_ATMO });
  else { m = new THREE.MeshLambertMaterial({ color: 0xffffff, side: opts.side ?? THREE.FrontSide }); game.atmo?.patch(m); }
  m.vertexColors = true;
  m.emissive = new THREE.Color(0xff9a40);
  m.emissiveIntensity = 0;
  return m;
}

/**
 * Procedural fallback titan. Returns { root, bones: Map, skeleton, meshes: { stone, feathers, glow }, glow, restPose,
 * procedural: true, height, scale }.
 */
export function buildProceduralTitan(game, { seed = 7 } = {}) {
  const defs = boneDefs();
  const bones = new Map();
  const index = new Map();
  const list = [];
  for (const d of defs) {
    const b = new THREE.Bone(); b.name = d.name;
    const parent = d.parent ? bones.get(d.parent) : null;
    const parentPos = d.parent ? defs.find((x) => x.name === d.parent).pos : V(0, 0, 0);
    b.position.copy(d.pos).sub(parentPos);
    if (parent) parent.add(b);
    bones.set(d.name, b); index.set(d.name, list.length); list.push(b);
  }
  const restPos = new Map(defs.map((d) => [d.name, d.pos.clone()]));
  const bi = (name) => index.get(name) ?? 0;

  const stone = new MeshBuilder();
  const feathers = new MeshBuilder();
  const glow = new MeshBuilder({ glow: true });
  const R = makeRng(seed);

  // ---------- colour helpers (linear) ----------
  const IVORY = new THREE.Color(0xe8dfcc), IVORY_WARM = new THREE.Color(0xf1e6cf), IVORY_COOL = new THREE.Color(0xd5d3cf);
  const stoneColor = (tone = 1, warm = 0.5) => (p, n, out) => {
    const f = fbm3(p.x * 0.09 + 11, p.y * 0.09, p.z * 0.09);
    out.copy(IVORY_COOL).lerp(IVORY_WARM, clamp(warm + (f - 0.5) * 0.9, 0, 1));
    const under = clamp(-n.y, 0, 1) * 0.06;                          // undersides a touch darker (sky occlusion)
    out.multiplyScalar(tone * (0.94 + (f - 0.5) * 0.16 - under));
    return out;
  };
  const featherColor = (p, n, out) => {
    const f = fbm3(p.x * 0.05, p.y * 0.05, p.z * 0.05 + 3);
    const tipCool = clamp((Math.abs(p.x) - 60) / 60, 0, 1) * 0.35 + clamp((-p.z - 30) / 40, 0, 1) * 0.25;
    out.setRGB(0.96, 0.95, 0.92).lerp(new THREE.Color(0.80, 0.84, 0.93), tipCool * 0.6);
    out.multiplyScalar(0.96 + (f - 0.5) * 0.08);
    return out;
  };

  // ---------- helpers to add parts with L/R mirroring ----------
  const mirrorName = (n) => n.replace(/_L$/, '_R');
  const resolveW = (w, mirror) => {
    const map = (name) => bi(mirror ? mirrorName(name) : name);
    if (typeof w === 'string') { const i = map(w); return () => [[i, 1]]; }
    if (Array.isArray(w)) { const r = w.map(([n, x]) => [map(n), x]); return () => r; }
    return (p) => w(mirror ? V(-p.x, p.y, p.z) : p).map(([n, x]) => [map(n), x]);
  };
  const mirrorPart = (part) => {
    const P = part.P.map((p) => V(-p.x, p.y, p.z));
    const N = part.N.map((n) => V(-n.x, n.y, n.z));
    const I = [];
    for (let k = 0; k < part.I.length; k += 3) I.push(part.I[k], part.I[k + 2], part.I[k + 1]);
    const surf = part.surf ? (u, v) => { const s = part.surf(u, v); s.p.x = -s.p.x; s.n.x = -s.n.x; return s; } : null;
    return { P, N, I, surf };
  };
  /** side: 0 = centre only, 1 = left + mirrored right. cracks: addCracks options (per side, different seeds). */
  const part = (builder, g, { w, color, side = 0, cracks = null, glowT = null, seams = null }) => {
    const sides = side ? [false, true] : [false];
    for (const mirror of sides) {
      const gg = mirror ? mirrorPart(g) : g;
      const W = resolveW(w, mirror);
      builder.append(gg.P, gg.N, gg.I, { weights: W, color: color ?? stoneColor() });
      const sideSign = side ? (mirror ? -1 : 1) : 0;
      const glowFn = (p) => [glowT ? glowT(mirror ? V(-p.x, p.y, p.z) : p) : 0, sideSign, 0];
      if (cracks && gg.surf) addCracks(glow, gg.surf, { ...cracks, seed: (cracks.seed ?? 1) * 7919 + (mirror ? 104729 : 0) + Math.floor(R() * 1000), weights: W, glow: glowFn });
      if (seams && gg.surf) for (const v of seams) addSeam(glow, gg.surf, v, { weights: W, glow: (p) => [glowFn(p)[0], sideSign, 3], width: 0.8 });
    }
  };

  // energy distance from the core (drives the charge wave along the cracks)
  const CORE = V(0, 29.5, 8.2);
  const tTorso = (p) => p.distanceTo(CORE);
  const tArm = (p) => 17 + Math.max(0, Math.abs(p.x) - 13);
  const tLeg = (p) => 22 + Math.max(0, -p.y);

  // Torso weights: smooth blend between hips / spine1 / spine2 / chest by height.
  const torsoW = (p) => {
    const ys = [[-100, 'hips'], [3.5, 'hips'], [11, 'spine1'], [19.5, 'spine2'], [28, 'chest']];
    for (let i = 1; i < ys.length; i++) {
      if (p.y < ys[i][0]) { const t = clamp((p.y - ys[i - 1][0]) / (ys[i][0] - ys[i - 1][0]), 0, 1); return [[ys[i - 1][1], 1 - t], [ys[i][1], t]]; }
    }
    return [['chest', 1]];
  };

  // ---------------- TORSO ----------------
  part(stone, ellipsoid(V(0, 27.5, -0.6), [12.6, 11.2, 8.6], {
    lump: 0.35, deform: (l, d) => { if (l.z < 0) l.z *= 0.86; if (l.y > 0) l.x *= 1 + 0.1 * d.y; },
  }), { w: torsoW, cracks: { count: 6, len: 16, width: 0.55, vRange: [0.25, 0.85] }, glowT: tTorso });
  part(stone, ellipsoid(V(5.5, 29.6, 5.4), [6.4, 4.6, 3.6], { rot: Q(0.08, 0.18, -0.1), lump: 0.2 }),
    { w: 'chest', side: 1, cracks: { count: 3, len: 9, width: 0.5, vRange: [0.3, 0.9] }, glowT: tTorso });
  part(stone, ellipsoid(V(0, 35.3, -2.2), [11.5, 3.9, 5.8], { lump: 0.2 }), { w: 'chest' });           // traps
  part(stone, tube([{ p: V(0, 25, 0.2), r: [7.4, 10.2] }, { p: V(0, 16, 1.0), r: [7.0, 9.0] }, { p: V(0, 7, 0.6), r: [7.2, 9.6] }],
    { up: V(0, 0, 1), nu: 19, nv: 10, lump: 0.25 }), { w: torsoW, cracks: { count: 4, len: 10, width: 0.5 }, glowT: tTorso });
  for (let r = 0; r < 3; r++) for (const s of [1, -1]) {                                          // ab plates
    part(stone, block(V(2.35 * s, 21.2 - r * 4.6, 7.2 + (r === 0 ? 0.3 : 0)), [2.1, 1.95, 1.2], { e1: 0.45, e2: 0.5, nu: 10, nv: 7, lump: 0.1 }),
      { w: torsoW });
  }
  part(stone, ellipsoid(V(8.2, 13, 1.2), [2.8, 6.4, 5.2], { rot: Q(0, 0, 0.15) }), { w: torsoW, side: 1 });  // obliques
  part(stone, ellipsoid(V(7.6, 25.5, -4.2), [5.8, 9.4, 4.4], { rot: Q(0, 0, -0.2), lump: 0.2 }), { w: 'chest', side: 1 });   // lats
  part(stone, ellipsoid(V(6.2, 31.2, -7.2), [4.6, 6.2, 2.8], { rot: Q(0, 0.2, 0.25) }), { w: 'chest', side: 1 });   // scapula / wing root
  part(stone, ellipsoid(V(0, -1.2, -0.6), [10.6, 7.2, 8.2], { lump: 0.2 }), { w: 'hips' });            // pelvis
  // Waist sash with folds + front knot.
  part(stone, ellipsoid(V(0, 3.2, 0.3), [11.4, 3.4, 9.4], {
    nu: 29, nv: 9, deform: (l, d) => { const a = Math.atan2(d.z, d.x); const f = 1 + 0.035 * Math.sin(a * 9) + 0.02 * Math.sin(a * 17 + 1); l.x *= f; l.z *= f; },
  }), { w: torsoW, color: stoneColor(0.97, 0.75) });
  part(stone, ellipsoid(V(1.5, 3.0, 9.4), [3.0, 2.6, 1.8], { rot: Q(0, 0, 0.5) }), { w: 'hips', color: stoneColor(0.97, 0.75) });

  // Loincloth panels (weighted along the cloth bones so they swing).
  const clothW = (front) => (p) => {
    // rigid-ish segments per cloth bone, blended ±4 m around each pivot so the panel bends smoothly
    const pre = front ? 'cloth_F' : 'cloth_B';
    const y1 = 0.5, y2 = front ? -12.5 : -11.5, y3 = front ? -25 : -22;
    const s = (a, b, y) => clamp((a - y) / (a - b), 0, 1);
    const w1 = s(y1 + 1.5, y1 - 1.5, p.y), w2 = s(y2 + 4, y2 - 4, p.y), w3 = s(y3 + 4, y3 - 4, p.y);
    return [['hips', 1 - w1], [pre + '1', w1 * (1 - w2)], [pre + '2', w2 * (1 - w3)], [pre + '3', w3]].filter((e) => e[1] > 1e-4);
  };
  const cloth = (front) => {
    const z = front ? 1 : -1;
    const len = front ? 40 : 33;
    const pts = [];
    for (let k = 0; k <= 5; k++) {
      const t = k / 5;
      pts.push({ p: V(0, 1.5 - len * t, z * (9.2 + 1.6 * Math.sin(t * 2.2))), r: [0.75, (front ? 6.6 : 7.4) - 1.6 * t] });
    }
    return tube(pts, { up: V(0, 0, z), nu: 22, nv: 14, caps: [false, true], capRings: 2 });
  };
  const clothFold = (g) => {
    // ripple the panel along its width (vertical folds), stronger near the hem
    const P = g.P;
    for (const p of P) { const h = clamp((1.5 - p.y) / 40, 0, 1); p.z += Math.sign(p.z) * Math.sin(p.x * 1.15) * 0.55 * (0.3 + h); }
    return g;
  };
  part(stone, clothFold(cloth(true)), { w: clothW(true), color: stoneColor(1.0, 0.8) });
  part(stone, clothFold(cloth(false)), { w: clothW(false), color: stoneColor(0.97, 0.8) });
  // Side drapes over the hips.
  part(stone, tube([{ p: V(10.4, 3, 1), r: [0.7, 4.2] }, { p: V(11.6, -6, 1.5), r: [0.7, 4.8] }, { p: V(12.2, -14, 1.8), r: [0.6, 4.4] }],
    { up: V(1, 0, 0), nu: 12, nv: 7, caps: [false, true], capRings: 2 }), { w: (p) => (p.y > -3 ? [['hips', 1]] : [['hips', 0.6], ['thigh_L', 0.4]]), side: 1, color: stoneColor(0.97, 0.8) });

  // ---------------- NECK & HEAD ----------------
  part(stone, tube([{ p: V(0, 34.5, -0.8), r: 6.4 }, { p: V(0, 40, -0.2), r: [5.6, 5.4] }, { p: V(0, 46.5, 0.8), r: [5.0, 4.9] }],
    { nu: 16, nv: 7, caps: [false, false] }), { w: (p) => (p.y < 38 ? [['chest', 0.6], ['neck', 0.4]] : p.y < 44 ? [['neck', 1]] : [['neck', 0.4], ['head', 0.6]]) });
  const headW = 'head';
  part(stone, ellipsoid(V(0, 52.3, 0), [6.7, 8.1, 7.2], {
    lump: 0.15, deform: (l, d) => {
      if (Math.abs(d.x) > 0.6 && d.y > -0.3 && d.y < 0.5) l.x *= 0.94;                            // temples
      if (d.z > 0.3 && d.y < 0.3) l.z *= 0.92;                                                  // face plane
    },
  }), { w: headW, cracks: { count: 2, len: 7, width: 0.4, vRange: [0.45, 0.9] }, glowT: (p) => 30 + p.y - 44 });
  part(stone, ellipsoid(V(0, 53.4, 5.5), [6.3, 1.55, 2.4], { rot: Q(-0.1, 0, 0), deform: (l, d) => { l.y -= Math.abs(d.x) * -0.9; } }), { w: headW });   // brow
  part(stone, ellipsoid(V(3.9, 49.9, 4.7), [2.4, 1.7, 2.1]), { w: headW, side: 1 });                           // cheekbones
  part(stone, block(V(0, 50.9, 6.7), [0.95, 2.5, 1.2], { rot: Q(-0.28, 0, 0), e1: 0.5, e2: 0.6, nu: 9, nv: 7 }), { w: headW });   // nose
  part(stone, ellipsoid(V(0, 49.6, 4.3), [5.2, 4.4, 3.3]), { w: headW });                                      // face mass
  part(stone, ellipsoid(V(0, 46.9, 4.9), [3.6, 1.2, 2.2]), { w: headW, color: stoneColor(0.9, 0.45) });      // upper lip / mouth line
  // Jaw + chin (the jaw bone opens for the roar).
  part(stone, block(V(0, 45.3, 3.4), [4.7, 2.3, 4.3], { e1: 0.55, e2: 0.6, nu: 13, nv: 9, lump: 0.1 }), { w: 'jaw' });
  part(stone, ellipsoid(V(0, 44.3, 6.3), [2.9, 2.2, 1.9]), { w: 'jaw' });
  // Eyes (glow kind 2) under the brow, slanted.
  for (const s of [1, -1]) {
    const e = ellipsoid(V(2.5 * s, 51.55, 6.25), [1.45, 0.48, 0.55], { rot: Q(0, 0.25 * s, 0.2 * s), nu: 10, nv: 6 });
    glow.append(e.P, e.N, e.I, { weights: bi('head'), glow: [0, 0, 2] });
  }
  // Antler crown: branching stone tines.
  const antler = (base, dir, len, r0, depth, seedK) => {
    const Rr = makeRng(seedK);
    const pts = [];
    const d = dir.clone().normalize();
    let p = base.clone();
    const n = 5;
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      pts.push({ p: p.clone(), r: r0 * (1 - 0.8 * t) });
      d.y += 0.12; d.normalize();                                                    // curve upward
      p = p.clone().addScaledVector(d, len / n);
    }
    part(stone, tube(pts, { nu: 9, nv: 7, caps: [false, true], capRings: 3 }), { w: headW, color: stoneColor(1.02, 0.9) });
    if (depth > 0) {
      const at = pts[2 + Math.floor(Rr() * 2)].p;
      const bd = d.clone().add(V((Rr() - 0.5) * 1.2, 0.4, (Rr() - 0.5) * 0.8));
      antler(at, bd, len * 0.45, r0 * 0.55, depth - 1, seedK + 17);
    }
  };
  antler(V(0, 59.2, 0.8), V(0, 1, 0.12), 8.5, 1.5, 1, 3);
  for (const s of [1, -1]) {
    antler(V(2.6 * s, 58.6, 0.2), V(0.45 * s, 1, -0.15), 11.5, 1.35, 1, s > 0 ? 5 : 9);
    antler(V(5.2 * s, 56.6, -0.8), V(1, 0.55, -0.25).multiply(V(s, 1, 1)), 9.5, 1.15, 1, s > 0 ? 13 : 21);
    antler(V(4.0 * s, 57.6, 2.8), V(0.4 * s, 1, 0.5), 5.5, 0.8, 0, s > 0 ? 31 : 37);
  }

  // ---------------- CORE ----------------
  const coreBulb = ellipsoid(CORE, [2.3, 3.0, 1.1], { nu: 12, nv: 9 });
  glow.append(coreBulb.P, coreBulb.N, coreBulb.I, { weights: bi('chest'), glow: [0, 0, 1] });
  for (let k = 0; k < 7; k++) {                                          // star rays radiating over the chest
    const a = (k / 7) * Math.PI * 2 + 0.3;
    const dir = V(Math.cos(a), Math.sin(a) * 1.15, 0);
    const len = 5.5 + (k % 3) * 1.8;
    const pts = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      const p = CORE.clone().addScaledVector(dir, 1.5 + len * t);
      p.z = 8.2 + 0.5 - Math.pow(Math.abs(p.x) / 12, 2) * 5 - Math.pow((p.y - 29.5) / 12, 2) * 2.2;
      pts.push({ p, n: V(p.x * 0.05, (p.y - 29) * 0.05, 1).normalize() });
    }
    const P = [], N = [], I = [];
    for (let i = 0; i < pts.length; i++) {
      const t = i / (pts.length - 1);
      const w = (1 - t) * 1.0 + 0.1;
      const side = V().crossVectors(pts[i].n, dir).normalize();
      P.push(pts[i].p.clone().addScaledVector(side, w).addScaledVector(pts[i].n, 0.2), pts[i].p.clone().addScaledVector(side, -w).addScaledVector(pts[i].n, 0.2));
      N.push(pts[i].n, pts[i].n);
      if (i < pts.length - 1) { const b = i * 2; I.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
    }
    glow.append(P, N, I, { weights: bi('chest'), glow: (p) => [tTorso(p), 0, 1] });
  }

  // ---------------- ARMS ----------------
  const armW = (name) => name;
  // Pauldrons: layered stone plates, blended between clavicle and upper arm so they ride the shoulder.
  part(stone, ellipsoid(V(15.2, 38.4, -1), [8.8, 5.4, 9.2], {
    rot: Q(0, 0, -0.28), lump: 0.3, deform: (l, d) => { if (d.y < -0.1) l.y *= 0.4; l.y += Math.sin(d.x * 3) * 0.3; },
  }), { w: [['upperarm_L', 0.55], ['shoulder_L', 0.45]], side: 1, cracks: { count: 4, len: 10, width: 0.55, vRange: [0.5, 0.95] }, glowT: tArm, color: stoneColor(1.02, 0.6) });
  part(stone, ellipsoid(V(18.8, 34.4, -1), [7.6, 3.1, 8.4], { rot: Q(0, 0, -0.5), lump: 0.2, deform: (l, d) => { if (d.y < 0) l.y *= 0.5; } }),
    { w: [['upperarm_L', 0.85], ['shoulder_L', 0.15]], side: 1, color: stoneColor(1.0, 0.6) });
  part(stone, ellipsoid(V(11.5, 36.2, -0.8), [5.5, 4.4, 5.8], { lump: 0.2 }), { w: [['shoulder_L', 0.7], ['chest', 0.3]], side: 1 });   // deltoid root
  // Upper arm: deltoid, biceps (front), triceps (back).
  part(stone, tube([{ p: V(14.0, 35.6, -1), r: 5.6 }, { p: V(20, 35.7, -0.9), r: [5.5, 5.8] }, { p: V(28, 35.5, -1), r: [4.9, 5.3] }, { p: V(36.4, 35.5, -1), r: 4.1 }], {
    nu: 17, nv: 13, lump: 0.25,
    bulge: (s, a) => 1 + 0.12 * Math.exp(-(((s - 0.5) / 0.2) ** 2)) * Math.max(0, -Math.sin(a)) + 0.09 * Math.exp(-(((s - 0.45) / 0.22) ** 2)) * Math.max(0, Math.sin(a)),
  }), { w: 'upperarm_L', side: 1, cracks: { count: 5, len: 12, width: 0.55 }, glowT: tArm });
  part(stone, ellipsoid(V(36.5, 35.5, -1), [4.4, 4.3, 4.4], { lump: 0.15 }), { w: 'forearm_L', side: 1, glowT: tArm });   // elbow
  part(stone, tube([{ p: V(36.8, 35.5, -1), r: 4.7 }, { p: V(40.5, 35.45, -1), r: [5.0, 5.2] }, { p: V(47, 35.4, -1), r: [3.9, 4.4] }, { p: V(53.2, 35.4, -1), r: [2.9, 3.5] }], {
    nu: 17, nv: 13, lump: 0.22,
    bulge: (s, a) => 1 + 0.08 * Math.exp(-(((s - 0.25) / 0.2) ** 2)) * Math.max(0, Math.cos(a)),
  }), { w: 'forearm_L', side: 1, cracks: { count: 5, len: 11, width: 0.5 }, glowT: tArm, seams: [0.93] });
  part(stone, ellipsoid(V(53.5, 35.45, -1), [3.2, 2.9, 3.6]), { w: 'hand_L', side: 1 });                               // wrist

  // ---------------- HANDS ----------------
  // Palm: a thick slab with a thenar pad and knuckle ridge; slight cup underneath.
  part(stone, block(V(57.1, 35.45, -1.05), [3.9, 1.55, 3.75], {
    e1: 0.5, e2: 0.42, nu: 16, nv: 10, lump: 0.08,
    deform: (l, d) => { if (d.y < 0) l.y *= 0.8 + 0.2 * Math.abs(d.x) + 0.2 * Math.abs(d.z); l.z *= 1 + 0.05 * (l.x / 3.9); },
  }), { w: 'hand_L', side: 1, cracks: { count: 2, len: 5, width: 0.35, vRange: [0.55, 0.95] }, glowT: tArm });
  part(stone, ellipsoid(V(55.6, 34.75, 1.25), [2.8, 1.45, 2.1], { rot: Q(0, 0.4, 0) }), { w: 'hand_L', side: 1 });    // thenar pad
  part(stone, ellipsoid(V(56.4, 34.7, -3.6), [3.0, 1.2, 1.2]), { w: 'hand_L', side: 1 });                               // hypothenar
  for (const f of ['index', 'middle', 'ring', 'pinky']) {                                                                 // knuckles
    const F = FINGERS[f];
    part(stone, ellipsoid(V(F.base[0] - 0.3, F.base[1] + 0.55, F.base[2]), [1.3, 0.95, F.r[0] * 1.05]), { w: 'hand_L', side: 1 });
  }
  for (const f of FINGER_NAMES) {
    const F = FINGERS[f];
    const dir = V(...F.dir).normalize();
    let p = V(...F.base);
    for (let k = 0; k < 3; k++) {
      const q = p.clone().addScaledVector(dir, F.len[k]);
      const r0 = F.r[k], r1 = k < 2 ? F.r[k + 1] * 1.02 : F.r[k] * 0.78;
      const mid = p.clone().lerp(q, 0.5);
      const g = tube([{ p: p.clone().addScaledVector(dir, 0.15), r: r0 }, { p: mid, r: [(r0 + r1) * 0.5 * 0.92, (r0 + r1) * 0.5] }, { p: q.clone().addScaledVector(dir, k < 2 ? 0 : -0.2), r: r1 }], {
        up: f === 'thumb' ? V(0.3, 1, -0.2).normalize() : V(0, 1, 0), nu: 10, nv: 6, capRings: 3, caps: [true, true],
      });
      part(stone, g, { w: `${f}${k + 1}_L`, side: 1, color: stoneColor(1.0, 0.55) });
      p = q;
    }
  }

  // ---------------- LEGS ----------------
  part(stone, tube([{ p: V(8, -1, -0.2), r: 7.4 }, { p: V(8.3, -10, 0.8), r: [7.3, 7.5] }, { p: V(8.6, -22, 0.9), r: [6.1, 6.2] }, { p: V(8.8, -31, 0.6), r: 4.9 }], {
    up: V(0, 0, 1), nu: 19, nv: 14, lump: 0.3,
    bulge: (s, a) => 1 + 0.09 * Math.exp(-(((s - 0.55) / 0.22) ** 2)) * Math.max(0, Math.cos(a)) + 0.05 * Math.exp(-(((s - 0.35) / 0.2) ** 2)) * Math.max(0, -Math.sin(a)),
  }), { w: (p) => (p.y > -3 ? [['thigh_L', 0.75], ['hips', 0.25]] : [['thigh_L', 1]]), side: 1, cracks: { count: 5, len: 14, width: 0.6 }, glowT: tLeg });
  part(stone, ellipsoid(V(8.8, -31, 0.9), [4.7, 4.9, 4.9], { lump: 0.15 }), { w: 'shin_L', side: 1 });                    // knee
  part(stone, block(V(8.9, -30.4, 5.0), [2.9, 3.3, 1.3], { rot: Q(-0.12, 0, 0), e1: 0.5, e2: 0.5, nu: 10, nv: 7 }), { w: 'shin_L', side: 1, color: stoneColor(1.03, 0.6) });
  part(stone, tube([{ p: V(8.8, -31.5, 0.5), r: 4.7 }, { p: V(9.0, -38, -0.3), r: [4.6, 4.9] }, { p: V(9.1, -49, -0.5), r: [3.5, 3.6] }, { p: V(9.2, -56.6, -0.8), r: [2.8, 3.1] }], {
    up: V(0, 0, 1), nu: 16, nv: 13, lump: 0.22,
    bulge: (s, a) => 1 + 0.16 * Math.exp(-(((s - 0.25) / 0.2) ** 2)) * Math.max(0, -Math.cos(a)),
  }), { w: 'shin_L', side: 1, cracks: { count: 4, len: 12, width: 0.5 }, glowT: tLeg, seams: [0.95] });
  part(stone, ellipsoid(V(9.2, -57.2, -0.8), [3.2, 3.0, 3.4]), { w: 'foot_L', side: 1 });                                // ankle
  part(stone, block(V(9.3, -60.2, 1.4), [3.3, 2.1, 5.6], {
    e1: 0.5, e2: 0.55, nu: 14, nv: 9, lump: 0.08,
    deform: (l, d) => { const t = clamp((l.z + 5.6) / 11.2, 0, 1); l.y *= 1.25 - 0.55 * t; if (d.y > 0) l.y -= t * 0.4; l.x *= 0.92 + 0.12 * t; },
  }), { w: (p) => (p.z > 5.2 ? [['toe_L', 1]] : [['foot_L', 1]]), side: 1 });
  for (let k = 0; k < 5; k++) {                                                                                           // toes
    const x = 9.3 + 2.4 - k * 1.2 - (k === 0 ? 0.15 : 0);
    const len = [2.9, 2.5, 2.3, 2.1, 1.8][k];
    part(stone, ellipsoid(V(x, -61.6, 7.4 + len * 0.5 - (k * 0.3)), [0.62 + (k === 0 ? 0.25 : 0), 0.7, len * 0.62]), { w: 'toe_L', side: 1 });
  }

  // ---------------- WINGS ----------------
  // Leading-edge limb (stone) along wing1..wing4, feathers (separate material) on top.
  part(stone, tube([{ p: V(4.5, 32.5, -7.3), r: 3.6 }, { p: V(17, 33.0, -6.6), r: [3.3, 3.1] }, { p: V(30, 32.8, -6.9), r: 2.8 }], { nu: 12, nv: 9 }),
    { w: 'wing1_L', side: 1, cracks: { count: 2, len: 12, width: 0.45 }, glowT: (p) => 20 + Math.abs(p.x) });
  part(stone, tube([{ p: V(30, 32.8, -6.9), r: 2.8 }, { p: V(46, 33.0, -6.5), r: [2.4, 2.2] }, { p: V(62, 32.8, -6.8), r: 1.9 }], { nu: 10, nv: 9 }),
    { w: 'wing2_L', side: 1, glowT: (p) => 20 + Math.abs(p.x) });
  part(stone, tube([{ p: V(62, 32.8, -6.8), r: 1.9 }, { p: V(73, 32.8, -6.6), r: 1.5 }, { p: V(84, 32.7, -6.8), r: 1.2 }], { nu: 9, nv: 7 }), { w: 'wing3_L', side: 1 });
  part(stone, tube([{ p: V(84, 32.7, -6.8), r: 1.2 }, { p: V(92, 32.7, -6.8), r: 0.9 }, { p: V(98, 32.7, -7), r: 0.55 }], { nu: 7, nv: 6, caps: [true, true] }), { w: 'wing4_L', side: 1 });
  for (const x of [30, 62]) part(stone, ellipsoid(V(x, 32.8, -6.9), [3.1, 2.9, 3.1]), { w: x < 50 ? 'wing2_L' : 'wing3_L', side: 1 });

  const addFeather = (base, dir, len, width, boneName, y = 0, opts = {}) => {
    const d = dir.clone().normalize();
    const side = V(0, 1, 0).cross(d).normalize();                                // blade width axis in the wing plane
    // top face normal = side × dir must point +Y (up): flip side when needed
    if (V().crossVectors(side, d).y < 0) side.negate();
    const g = feather(base.clone().add(V(0, y, 0)), d, side, { length: len, width, thick: opts.thick ?? Math.min(1.4, width * 0.16), curl: opts.curl ?? 0.05, tip: 0.3, ns: opts.ns ?? 6, nw: opts.nw ?? 3 });
    for (const mirror of [false, true]) {
      const gg = mirror ? mirrorPart(g) : g;
      feathers.append(gg.P, gg.N, gg.I, { weights: resolveW(boneName, mirror), color: featherColor });
    }
  };
  // Primaries: fan from the wing hand out to the tip, the outermost reach past the bones.
  for (let i = 0; i < PRIMARIES; i++) {
    const t = i / (PRIMARIES - 1);
    const base = restPos.get(`feather_p${i}_L`);
    const ang = (-78 + 84 * Math.pow(t, 1.2)) * D2R;                            // −78° (back) … +6° (outward)
    const dir = V(Math.cos(ang), -0.02, Math.sin(ang));
    const len = 30 + 13 * Math.sin(Math.PI * clamp(t * 0.85 + 0.1, 0, 1)) + t * 2;
    addFeather(base, dir, len, 5.0 - t * 1.1, `feather_p${i}_L`, 0.2 + i * 0.04, { ns: 8 });
  }
  // Secondaries along the forearm (trailing back), tertials near the body.
  for (let i = 0; i < 12; i++) {
    const t = i / 11;
    const x = 31 + t * 32;
    const ang = (-90 + 6 * t) * D2R;
    addFeather(V(x, 32.6, -6.4), V(Math.cos(ang) + 0.1, -0.03, Math.sin(ang)), 32 + 3 * Math.sin(Math.PI * t), 4.6, x < 62 ? 'wing2_L' : 'wing3_L', -0.1);
  }
  for (let i = 0; i < 6; i++) {
    const t = i / 5;
    const x = 8 + t * 21;
    addFeather(V(x, 32.4, -6.4), V(-0.08 + t * 0.12, -0.03, -1), 20 + t * 11, 4.8, 'wing1_L', -0.25);
  }
  // Coverts: two shorter rows on top (overlapping like scales) + scapulars at the root.
  for (let i = 0; i < 20; i++) {
    const t = i / 19;
    const x = 8 + t * 86;
    const bone = x < 30 ? 'wing1_L' : x < 62 ? 'wing2_L' : x < 84 ? 'wing3_L' : 'wing4_L';
    const ang = (-90 + 30 * Math.max(0, (x - 62) / 35)) * D2R;
    addFeather(V(x, 33.4, -5.2), V(Math.cos(ang) + 0.12, -0.02, Math.sin(ang)), 15 + 5 * Math.sin(Math.PI * t), 5.4, bone, 0.9, { curl: 0.03 });
  }
  for (let i = 0; i < 16; i++) {
    const t = i / 15;
    const x = 7 + t * 74;
    const bone = x < 30 ? 'wing1_L' : x < 62 ? 'wing2_L' : 'wing3_L';
    addFeather(V(x, 33.8, -4.6), V(0.14, 0, -1), 8.5 + 3 * Math.sin(Math.PI * t), 5.0, bone, 1.5, { curl: 0.02, ns: 6 });
  }

  // ---------------- assemble ----------------
  const root = new THREE.Group();
  root.name = 'titan-model';
  root.add(list[0]);
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(list);
  const bindMatrix = new THREE.Matrix4();
  const mk = (builder, material, name) => {
    const m = new THREE.SkinnedMesh(builder.geometry(), material);
    m.name = name;
    m.bind(skeleton, bindMatrix);
    m.frustumCulled = false;                 // skinned bounds are stale; the titan is always near the fight
    root.add(m);
    return m;
  };
  const stoneM = stoneMaterial(game);
  const featherM = stoneMaterial(game, { rim: 0xffffff, rimPower: 2.2 });
  const glowMat = makeGlowMaterial(game);
  const meshes = {
    stone: mk(stone, stoneM, 'titan-stone'),
    feathers: mk(feathers, featherM, 'titan-feathers'),
    glow: mk(glow, glowMat.material, 'titan-glow'),
  };
  for (const k of ['stone', 'feathers']) {
    meshes[k].castShadow = true; meshes[k].receiveShadow = true;
    if (game.toon) {
      const o = game.toon.outline(meshes[k], { width: k === 'stone' ? 0.32 : 0.26, color: 0x3b2e44, maxPx: 3.2, atmo: TITAN_ATMO });
      if (o) { o.frustumCulled = false; fixOutlineFlip(o); }
    }
  }
  meshes.glow.castShadow = false;

  return {
    root, bones, skeleton, meshes, glow: glowMat, materials: { stone: stoneM, feathers: featherM },
    procedural: true, height: 120, scale: 1, core: CORE.clone(), sockets: {},
    tris: (stone.idx.length + feathers.idx.length + glow.idx.length) / 3,
  };
}

/**
 * GLB model (skyfire/assets/models/titan.glb). Requires the contract bones and a plausible rest skeleton; returns
 * null (with a console warning saying why) when the file is missing or unusable, so the caller falls back to the
 * procedural titan. Sockets exported by the Blender owner (core_socket, mouth_socket, palm_socket_L/R) are used.
 */
export async function loadTitanGLB(game) {
  let inst = null;
  try { inst = await instanceGLB('titan'); } catch { inst = null; }
  if (!inst) return null;
  const need = ['hips', 'chest', 'head', 'upperarm_L', 'forearm_L', 'hand_L', 'upperarm_R', 'forearm_R', 'hand_R'];
  const missing = need.filter((n) => !inst.bones.has(n));
  if (missing.length) { console.warn('[titan] titan.glb lacks bones', missing.join(', '), '— using the procedural titan'); return null; }
  const root = new THREE.Group();
  root.name = 'titan-model';
  root.add(inst.scene);
  root.updateMatrixWorld(true);
  const meshes = [];
  inst.scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
  const box = new THREE.Box3();
  for (const m of meshes) { m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox.clone().applyMatrix4(m.matrixWorld)); }
  const h = box.max.y - box.min.y;
  let scale = 1;
  if (h > 1 && (h < 90 || h > 160)) { scale = 120 / h; inst.scene.scale.multiplyScalar(scale); root.updateMatrixWorld(true); box.min.multiplyScalar(scale); box.max.multiplyScalar(scale); }
  // Rig sanity: bones must sit inside the mesh and in humanoid order, else skinning would tear the model apart.
  const wp = (n) => { const b = inst.bones.get(n) || inst.scene.getObjectByName(n); return b ? b.getWorldPosition(new THREE.Vector3()) : null; };
  const P = Object.fromEntries(['hips', 'chest', 'head', 'hand_L', 'hand_R', 'shoulder_L', 'foot_L', 'foot_R'].map((n) => [n, wp(n)]));
  const loose = box.clone().expandByScalar(Math.max(8, h * scale * 0.08));
  const problems = [];
  if (!(P.head.y > P.chest.y + 5 && P.chest.y > P.hips.y + 5)) problems.push('spine order (hips < chest < head) broken');
  if (P.foot_L && !(P.foot_L.y < P.hips.y - 25)) problems.push('feet not below the hips');
  if (!(P.hand_L.x > 8 && P.hand_R.x < -8)) problems.push('hands not on their sides (+X left)');
  const outside = [...inst.bones.values()].filter((b) => !loose.containsPoint(b.getWorldPosition(new THREE.Vector3()))).map((b) => b.name);
  if (outside.length > 3) problems.push(`${outside.length} bones outside the mesh (${outside.slice(0, 5).join(', ')}…)`);
  if (problems.length) {
    console.warn('[titan] titan.glb skeleton unusable —', problems.join('; '), '— using the procedural titan');
    return null;
  }
  // Origin at the pelvis.
  inst.scene.position.sub(P.hips);
  root.updateMatrixWorld(true);

  const glowMat = makeGlowMaterial(game);
  for (const o of meshes) {
    o.frustumCulled = false;
    const old = Array.isArray(o.material) ? o.material[0] : o.material;
    if (game.toon) {
      const m = game.toon.material({
        map: old?.map || null, color: old?.map ? 0xffffff : (old?.color?.getHex?.() ?? 0xe8dfcc),
        emissive: old?.emissiveMap ? 0xffffff : 0x000000, emissiveMap: old?.emissiveMap || null,
        emissiveIntensity: old?.emissiveMap ? 1.4 : 0, steps: 3, rim: 0xfff1d8, rimPower: 2.6, side: old?.side, atmo: TITAN_ATMO,
      });
      if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
      if (m.emissiveMap) m.emissiveMap.colorSpace = THREE.SRGBColorSpace;
      o.material = m;
      const ol = game.toon.outline(o, { width: 0.3, color: 0x3b2e44, maxPx: 3.2, atmo: TITAN_ATMO });
      if (ol) { ol.frustumCulled = false; fixOutlineFlip(ol); }
    }
    o.castShadow = true; o.receiveShadow = true;
  }
  const sockets = {};
  for (const n of ['core_socket', 'mouth_socket', 'palm_socket_L', 'palm_socket_R']) { const o = inst.scene.getObjectByName(n); if (o) sockets[n] = o; }
  return {
    root, bones: inst.bones, skeleton: meshes.find((m) => m.isSkinnedMesh)?.skeleton || null,
    meshes: { stone: meshes[0] || null, feathers: null, glow: null, all: meshes }, glow: glowMat, sockets,
    materials: { stone: meshes[0]?.material }, procedural: false, height: h * scale, scale,
    core: null, tris: meshes.reduce((n, m) => n + (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3, 0),
  };
}
