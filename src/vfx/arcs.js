// Lightning arcs (levels and elements: Sora's lightning / stormfire breath, the lightning bolt, chain arcs, level-up
// crackle). One draw call for every arc.
//   An arc is a jagged polyline between two END points that may follow live positions (the mouth, a target's body), so
//   an arc stays attached while the dragon and her target move: the zigzag is stored as offsets relative to the line
//   between the ends (midpoint displacement, 17 points), scaled by its length, plus 0–3 forked branches in the same
//   frame. Every arc lives ~0.05–0.25 s: the fire system strikes a new generation 24 times a second, so the previous
//   ones fade under it (a short afterimage) and the bolt flickers on twos like hand-drawn anime lightning.
//   Look (fix pass, playtester rank 1: "thin white-lavender threads, weaker than the azure flame"): a cel stroke, not a
//   white line with a glow. Across the stroke: a thin white-hot core (≥ 0.6 px each side, HDR: it blooms), a hot zone
//   around it in the style's colour (additive, HDR: the bloom halo is cyan, not white), a SATURATED band painted "over"
//   (lightning: #3fd0ff–#62e2ff cyan; ≤ 1.0 so the tone mapper's AgX highlight branch cannot turn it lavender) and a
//   dark-blue inked rim (≥ 1 px), so the stroke reads on white cloud (where additive light vanishes) and on the blue
//   sky (where a blue glow vanishes). Haze arcs (over 0) are a soft additive glow body along a channel.
//   Widths: `width` is the half width in metres; `minPx` keeps it ≥ that many CSS px at any distance (Sora's beam
//   ≥ 7–8 px wide at 40 m); near the lens the half width is ≤ uMaxW × depth (never a screen-wide bar) and the arc fades
//   within ~1.5–6 m.
// Premultiplied, depthWrite off, depth-tested: the pipeline draws it on its FX layer after the clouds. Never throws.
import * as THREE from 'three';

/** Arc colour styles: lightning (Sora L7–8: cyan), storm (L9–10: electric blue with a gold rim), gold (radiant
 *  level-ups), azure (azure level-ups). */
export const ARC_STYLE = { lightning: 0, storm: 1, gold: 2, azure: 3, prism: 4 };   // (prism: levels update, L11+)
const NST = 5;

const VERT = /* glsl */`
attribute vec3 aTan;      // world tangent along the arc
attribute vec4 aR;        // u (0..1 along), side (-1 | 1), half width (m), intensity
attribute vec4 aR2;       // style, seed, core share of the half width, min half width (CSS px)
attribute vec2 aR3;       // over (band / rim opacity, 0 = additive haze only), haze (soft additive body)
uniform float uMaxW, uPx;
varying vec4 vR, vR2;
varying vec2 vR3;
varying float vNear, vFar, vHp;
varying vec3 vFogT, vFogAdd;
__ATMO__
void main() {
  vec4 mv = viewMatrix * vec4(position, 1.0);
  float depth = max(-mv.z, 0.05);
  vec3 t = mat3(viewMatrix) * aTan;
  vec3 toCam = normalize(-mv.xyz);
  vec3 side = cross(t, toCam);
  float sl = length(side);
  side = sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0);
  // never a screen-filling bar next to the lens; never thinner than minPx far away (a distant bolt stays a stroke)
  float px = uPx * depth;                                   // metres per CSS px at this depth
  float w = min(aR.z, uMaxW * depth);
  w = max(w, aR2.w * px * step(0.001, aR.z));
  mv.xyz += side * aR.y * w;
  gl_Position = projectionMatrix * mv;
  vR = aR; vR2 = aR2; vR3 = aR3;
  vHp = w / max(px, 1e-6);                                  // half width in CSS px (the profile keeps px-sized parts)
  vNear = smoothstep(1.5, 6.0, depth);
  vFar = 1.0 + 0.6 * smoothstep(60.0, 320.0, depth);        // far arcs are brighter (bloom keeps them readable)
  vFogAdd = atmoApply(vec3(0.0), position);
  vFogT = atmoApply(vec3(1.0), position) - vFogAdd;
}
`;

const FRAG = /* glsl */`
uniform vec3 uCore[NST], uHot[NST], uHaze[NST];
uniform vec4 uBand[NST], uRim[NST];
uniform vec2 uShape[NST];     // rim: share of the half width, min CSS px
varying vec4 vR, vR2;
varying vec2 vR3;
varying float vNear, vFar, vHp;
varying vec3 vFogT, vFogAdd;
vec3 pick3(vec3 arr[NST], float s) { int i = int(s + 0.5); vec3 c = arr[0]; for (int k = 1; k < NST; k++) if (k == i) c = arr[k]; return c; }
vec4 pick4(vec4 arr[NST], float s) { int i = int(s + 0.5); vec4 c = arr[0]; for (int k = 1; k < NST; k++) if (k == i) c = arr[k]; return c; }
vec2 pick2(vec2 arr[NST], float s) { int i = int(s + 0.5); vec2 c = arr[0]; for (int k = 1; k < NST; k++) if (k == i) c = arr[k]; return c; }
void main() {
  float s = abs(vR.y);                         // 0 on the centre line, 1 at the ribbon's edge
  float I = vR.w * vNear * vFar;
  float hp = max(vHp, 0.6);
  float d = s * hp;                            // CSS px from the centre line (the profile's parts keep px sizes)
  float fw = max(fwidth(d), 0.05);
  float st = vR2.x;
  // white-hot core: its share of the stroke, never thinner than 0.6 px each side (a hard anime line)
  float cp = vR2.z > 0.0 ? max(0.6, vR2.z * hp) : 0.0;
  float core = cp > 0.0 ? 1.0 - smoothstep(cp - 0.5 * fw, cp + 0.5 * fw, d) : 0.0;
  // hot zone: the style's colour glowing just outside the core (HDR, so the bloom halo carries the colour)
  float hot = cp > 0.0 ? 1.0 - smoothstep(cp, cp + max(0.5, 0.16 * hp), d) : 0.0;
  // inked rim: the outer max(16 %, 0.9 px) of the half width (storm: a wider gold wrap); the saturated band fills
  // the rest, painted "over" (a thin 6 px stroke still gets ~1.8 px of band colour)
  vec2 sh = pick2(uShape, st);
  float rp = hp - max(sh.y, sh.x * hp);
  float inRim = smoothstep(rp - 0.5 * fw, rp + 0.5 * fw, d);
  float edge = 1.0 - smoothstep(hp - 0.4, hp, d);
  float rim = inRim * edge, band = 1.0 - inRim;
  float haze = vR3.y * pow(max(1.0 - s, 0.0), 2.2);
  vec4 B = pick4(uBand, st), R = pick4(uRim, st);
  float ov = vR3.x * min(I, 1.0);
  float aB = B.a * band * ov, aR = R.a * rim * ov;
  vec3 add = (pick3(uCore, st) * core + pick3(uHot, st) * hot + pick3(uHaze, st) * haze) * I;
  float a = aB + aR;
  vec3 col = add * vFogT + ((B.rgb * aB + R.rgb * aR) * vFogT + vFogAdd * a);
  if (a < 0.002 && max(col.r, max(col.g, col.b)) < 0.002) discard;
  gl_FragColor = vec4(col, a);
}
`;

const V3 = THREE.Vector3;
const rnd = (a, b) => a + Math.random() * (b - a);
const hash = (x) => { const s = Math.sin(x * 12.9898) * 43758.5453; return s - Math.floor(s); };

/** Midpoint displacement: 2D perpendicular offsets (fractions of the arc's length) for n = 2^k + 1 points, ends 0. */
function displace(out, n, amp, rough = 0.55) {
  out.fill(0, 0, 2 * n);
  let step = n - 1, a = amp;
  while (step > 1) {
    const h = step >> 1;
    for (let i = h; i < n - 1; i += step) {
      const l = i - h, r = i + h;
      out[2 * i] = (out[2 * l] + out[2 * r]) * 0.5 + (Math.random() * 2 - 1) * a;
      out[2 * i + 1] = (out[2 * l + 1] + out[2 * r + 1]) * 0.5 + (Math.random() * 2 - 1) * a;
    }
    a *= rough; step = h;
  }
  return out;
}
/** End descriptor → { ref (live Vector3 | null), off (Vector3, copied), dir (live Vector3 | null), dist }. */
function endOf(e) {
  if (!e) return { ref: null, off: new V3(), dir: null, dist: 0 };
  if (e.isVector3) return { ref: null, off: e.clone(), dir: null, dist: 0 };
  return { ref: e.ref?.isVector3 ? e.ref : null, off: e.off?.isVector3 ? e.off.clone() : new V3(), dir: e.dir?.isVector3 ? e.dir : null, dist: +e.dist || 0 };
}
function endPos(e, out) {
  if (e.ref) out.copy(e.ref); else out.set(0, 0, 0);
  out.add(e.off);
  if (e.dir) out.addScaledVector(e.dir, e.dist);
  return out;
}

export function createArcs(game, { maxRibbons = 192, points = 17, maxArcs = 160 } = {}) {
  const atmoChunk = game.atmo ? game.atmo.chunk : 'vec3 atmoApply(vec3 c, vec3 p) { return c; }';
  const atmoU = game.atmo ? game.atmo.uniforms : {};
  const nv = maxRibbons * points * 2;
  const pos = new Float32Array(nv * 3), tan = new Float32Array(nv * 3), r1 = new Float32Array(nv * 4), r2 = new Float32Array(nv * 4);
  const r3 = new Float32Array(nv * 2);
  const geo = new THREE.BufferGeometry();
  const mk = (arr, n) => { const a = new THREE.BufferAttribute(arr, n); a.setUsage(THREE.DynamicDrawUsage); return a; };
  const aPos = mk(pos, 3), aTan = mk(tan, 3), aR = mk(r1, 4), aR2 = mk(r2, 4), aR3 = mk(r3, 2);
  geo.setAttribute('position', aPos); geo.setAttribute('aTan', aTan); geo.setAttribute('aR', aR); geo.setAttribute('aR2', aR2);
  geo.setAttribute('aR3', aR3);
  const idx = [];
  for (let r = 0; r < maxRibbons; r++) {
    for (let i = 0; i < points - 1; i++) {
      const a = (r * points + i) * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  geo.setIndex(idx);
  geo.setDrawRange(0, 0);
  geo.boundingSphere = new THREE.Sphere(new V3(), 1e9);
  const c = (r, g, b) => new V3(r, g, b);
  const c4 = (r, g, b, a) => new THREE.Vector4(r, g, b, a);
  // Per style (linear HDR; the band and rim stay ≤ 1 so the tone mapper keeps them saturated, the core and hot zone
  // go HDR so the bloom picks them up):
  //   lightning: white core, cyan hot zone, cyan band #3fd0ff–#62e2ff, deep-blue ink rim
  //   storm: white core, electric-blue band, a gold rim (the lightning is wrapped in gold fire)
  //   gold (radiant level-ups): white-gold core, gold band, dark amber rim · azure: white core, azure band, navy rim
  // (the core stays ≈ 2.5: white after the tone map, but dozens of overlapping 4.0 cores bloomed the whole beam white)
  //   prism (levels update): white core; the hot zone, band, haze and rim are rewritten every frame (setPrism)
  const uCore = [c(2.0, 2.5, 2.7), c(2.4, 2.4, 2.5), c(2.8, 2.5, 1.7), c(2.0, 2.5, 2.9), c(2.5, 2.4, 2.6)];
  const uHot = [c(0.12, 0.95, 1.35), c(0.12, 0.42, 1.25), c(1.3, 0.8, 0.14), c(0.12, 0.62, 1.5), c(1.3, 0.3, 1.2)];
  const uHaze = [c(0.04, 0.5, 0.8), c(0.14, 0.34, 0.85), c(0.8, 0.48, 0.08), c(0.03, 0.3, 0.85), c(0.7, 0.2, 0.8)];
  const uBand = [c4(0.07, 0.68, 1.0, 0.9), c4(0.02, 0.2, 1.0, 0.92), c4(1.0, 0.6, 0.06, 0.85), c4(0.02, 0.34, 1.0, 0.85), c4(1.0, 0.2, 0.9, 0.9)];
  const uRim = [c4(0.004, 0.03, 0.26, 0.85), c4(1.0, 0.5, 0.03, 0.95), c4(0.32, 0.07, 0.0, 0.8), c4(0.0, 0.02, 0.22, 0.8), c4(0.1, 0.9, 0.7, 0.9)];
  const V2 = (x, y) => new THREE.Vector2(x, y);
  const uShape = [V2(0.16, 0.9), V2(0.28, 1.4), V2(0.16, 0.9), V2(0.16, 0.9), V2(0.3, 1.5)];
  const uMaxW = { value: 0.016 }, uPx = { value: 0.00128 };
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...atmoU, uMaxW, uPx, uCore: { value: uCore }, uHot: { value: uHot }, uHaze: { value: uHaze }, uBand: { value: uBand }, uRim: { value: uRim }, uShape: { value: uShape } },
    vertexShader: VERT.replace('__ATMO__', atmoChunk), fragmentShader: FRAG, defines: { NST },
    transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  mat.toneMapped = false;
  mat.userData.fx = true;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'fx-arcs';
  mesh.frustumCulled = false;
  mesh.renderOrder = 53;
  mesh.matrixAutoUpdate = false;
  mesh.visible = false;
  game.scene.add(mesh);

  const recs = [];
  const stat = { spawned: 0, dropped: 0, ribbons: 0, peak: 0 };
  const P = Array.from({ length: points }, () => new V3());
  const Q = Array.from({ length: points }, () => new V3());
  const _A = new V3(), _B = new V3(), _D = new V3(), _s1 = new V3(), _s2 = new V3(), _t1 = new V3(), _t2 = new V3(), _bd = new V3();
  const _up = new V3(0, 1, 0), _x = new V3(1, 0, 0);
  let used = 0;
  // the first frames draw the (empty) mesh so its program is compiled at boot, not at the first lightning (a hitch)
  let warm = 4;

  function basis(dn, s1, s2) {
    s1.crossVectors(dn, Math.abs(dn.y) < 0.9 ? _up : _x).normalize();
    s2.crossVectors(dn, s1);
  }
  /** Write one ribbon through pts[0..n-1]: half width W × taper(u), intensity I (r: the arc's look record). */
  function ribbon(pts, n, W, taper, I, style, seed, core, minPx, over, haze) {
    if (used >= maxRibbons || n < 2) return;
    const base = used * points * 2;
    for (let i = 0; i < points; i++) {
      const k = Math.min(i, n - 1);
      const p = pts[k];
      const pa = pts[Math.max(0, k - 1)], pb = pts[Math.min(n - 1, k + 1)];
      let tx = pb.x - pa.x, ty = pb.y - pa.y, tz = pb.z - pa.z;
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl; ty /= tl; tz /= tl;
      const u = k / (n - 1);
      const w = i < n ? W * (taper === 1 ? 1 - 0.6 * u : taper === 2 ? 0.4 + 0.6 * u : taper === 3 ? 1 : 0.3 + 0.7 * Math.pow(Math.sin(Math.PI * u), 0.35)) : 0;
      for (let s = 0; s < 2; s++) {
        const v = base + i * 2 + s;
        pos[v * 3] = p.x; pos[v * 3 + 1] = p.y; pos[v * 3 + 2] = p.z;
        tan[v * 3] = tx; tan[v * 3 + 1] = ty; tan[v * 3 + 2] = tz;
        r1[v * 4] = u; r1[v * 4 + 1] = s ? 1 : -1; r1[v * 4 + 2] = w; r1[v * 4 + 3] = I;
        r2[v * 4] = style; r2[v * 4 + 1] = seed; r2[v * 4 + 2] = core; r2[v * 4 + 3] = minPx;
        r3[v * 2] = over; r3[v * 2 + 1] = haze;
      }
    }
    used++;
  }

  const api = {
    mesh,
    /** levels update — the prism style's colours for this frame: band (a THREE.Color, ~unit) and rim (the hue a third
     *  of a turn on): the lightning runs through the rainbow with the flame. */
    setPrism(band, rim) {
      const P = ARC_STYLE.prism;
      uBand[P].set(band.r, band.g, band.b, 0.9);
      uCore[P].set(0.7 + band.r * 2.1, 0.7 + band.g * 2.1, 0.7 + band.b * 2.1);     // a tinted HDR core: it blooms in colour
      uHot[P].set(0.15 + band.r * 1.2, 0.15 + band.g * 1.2, 0.15 + band.b * 1.2);
      uHaze[P].set(band.r * 0.75, band.g * 0.75, band.b * 0.75);
      if (rim) uRim[P].set(rim.r, rim.g, rim.b, 0.92);
    },
    get count() { return recs.length; },
    get stats() { return { live: recs.length, ribbons: stat.ribbons, spawned: stat.spawned, dropped: stat.dropped, peak: stat.peak }; },
    /**
     * Strike one arc. o: { from, to (Vector3 = a fixed point, or { ref: live Vector3, off: Vector3, dir: live unit
     * Vector3, dist: m } → ref + off + dir·dist, re-read every frame), amp (zigzag, fraction of the length, 0.09),
     * rough (0.55), life (s, 0.1), delay (s), width (half width, m), minPx (half width never below this many CSS px,
     * 2.2), intensity, style (ARC_STYLE), core (share of the half width drawn white-hot, 0.3; 0 = none), over (opacity
     * of the saturated band and the inked rim, 1; 0 = an additive glow only), haze (soft additive body, 0),
     * hold (share of the life at full brightness before the afterimage fades, 0.12), flicker (0..1 of the stepped
     * 24 Hz flicker, 1), taper (0 both ends, 1 thin toward `to`, 2 thin toward `from`, 3 none), branches (0–3), fork
     * (branch length, fraction of the arc, 0.3), prio (true: may replace the oldest arc when full), once (drawn in
     * the next update only: a per-frame line) }. → record | null
     */
    strike(o = {}) {
      try {
        if (recs.length >= maxArcs) {
          if (!o.prio) { stat.dropped++; return null; }
          recs.shift();
        }
        const n = points;
        const amp = o.amp ?? 0.09;
        const offs = displace(new Float32Array(2 * n), n, amp, o.rough ?? 0.55);
        const du = new Float32Array(n);
        if (amp > 0) for (let i = 1; i < n - 1; i++) du[i] = (Math.random() - 0.5) * 0.5 / (n - 1);
        const br = [];
        const nb = Math.max(0, Math.min(3, Math.round(o.branches ?? 1)));
        for (let b = 0; b < nb; b++) {
          const nb2 = 9;
          const th = rnd(0.35, 0.85), ph = Math.random() * 6.2832;
          br.push({
            j: Math.floor(rnd(0.18, 0.72) * (n - 1)), n: nb2, len: (o.fork ?? 0.3) * rnd(0.55, 1.25),
            along: Math.cos(th), p1: Math.sin(th) * Math.cos(ph), p2: Math.sin(th) * Math.sin(ph),
            offs: displace(new Float32Array(2 * nb2), nb2, Math.max(amp, 0.06) * 1.5, 0.55),
          });
        }
        const num = (v, d) => (Number.isFinite(+v) && v !== null ? +v : d);
        const rec = {
          from: endOf(o.from), to: endOf(o.to), offs, du, br,
          t0: game.time.now + (o.delay || 0), life: Math.max(0.02, o.life ?? 0.1),
          width: o.width ?? 0.4, intensity: o.intensity ?? 1, style: o.style ?? 0, core: num(o.core, 0.3),
          taper: o.taper ?? 0, seed: Math.random(),
          minPx: Math.max(0, num(o.minPx, 2.2)), over: Math.max(0, Math.min(1, num(o.over, 1))), haze: Math.max(0, num(o.haze, 0)),
          hold: Math.max(0, Math.min(0.95, num(o.hold, 0.12))), flicker: Math.max(0, Math.min(1, num(o.flicker, 1))), once: !!o.once, drawn: false,
        };
        recs.push(rec);
        stat.spawned++;
        return rec;
      } catch (e) { return null; }
    },
    /** Per frame (after everything that strikes arcs): age the arcs and rebuild the ribbons. */
    update() {
      used = 0;
      try {
        const now = game.time.now;
        const cam = game.camera;
        // widths in CSS px (the same look at DPR 1 and 2): metres per CSS px per metre of depth
        const el = game.renderer?.domElement;
        const H = el?.clientHeight || (el?.height || 900) / Math.max(1, game.renderer?.getPixelRatio?.() || 1);
        uPx.value = (2 * Math.tan(((cam?.fov || 60) * Math.PI) / 360)) / Math.max(1, H);
        const fl = Math.floor(now * 24);
        for (let i = recs.length - 1; i >= 0; i--) if (recs[i].drawn || now - recs[i].t0 > recs[i].life) recs.splice(i, 1);
        stat.peak = Math.max(stat.peak, recs.length);
        for (const r of recs) {
          const age = now - r.t0;
          if (age < 0) continue;
          if (r.once) r.drawn = true;
          const a = r.once ? 0 : age / r.life;
          // bright at birth (for `hold` of its life), then a fading afterimage; a stepped (24 Hz) flicker per arc
          const flick = 1 - r.flicker * 0.3 * (1 - hash(r.seed * 97.3 + fl));
          const h = r.hold;
          const I = r.intensity * (a < h ? 1 : Math.pow(Math.max(0, 1 - (a - h) / (1 - h)), 1.6)) * flick;
          if (I < 0.01) continue;
          endPos(r.from, _A); endPos(r.to, _B);
          _D.subVectors(_B, _A);
          const L = _D.length();
          if (!(L > 0.05) || !Number.isFinite(L)) continue;
          const dn = _D.divideScalar(L);
          basis(dn, _s1, _s2);
          const n = points, o = r.offs;
          for (let k = 0; k < n; k++) {
            const u = k / (n - 1) + r.du[k];
            P[k].copy(_A).addScaledVector(dn, u * L).addScaledVector(_s1, o[2 * k] * L).addScaledVector(_s2, o[2 * k + 1] * L);
          }
          ribbon(P, n, r.width, r.taper, I, r.style, r.seed, r.core, r.minPx, r.over, r.haze);
          for (const b of r.br) {
            const st = P[b.j];
            _bd.copy(dn).multiplyScalar(b.along).addScaledVector(_s1, b.p1).addScaledVector(_s2, b.p2).normalize();
            const Lb = L * b.len;
            basis(_bd, _t1, _t2);
            for (let k = 0; k < b.n; k++) {
              const u = k / (b.n - 1);
              Q[k].copy(st).addScaledVector(_bd, u * Lb).addScaledVector(_t1, b.offs[2 * k] * Lb).addScaledVector(_t2, b.offs[2 * k + 1] * Lb);
            }
            ribbon(Q, b.n, r.width * 0.55, 1, I * 0.72, r.style, r.seed + 0.37, r.core, r.minPx * 0.6, r.over, r.haze);
          }
          if (used >= maxRibbons) break;
        }
      } catch (e) { if (!api._warned) { api._warned = true; console.warn('[fx] arcs', e); } }
      stat.ribbons = used;
      geo.setDrawRange(0, used * (points - 1) * 6);
      if (warm > 0) warm--;
      mesh.visible = used > 0 || warm > 0;
      if (!used) return;
      const nvUsed = used * points * 2;
      for (const [a, n] of [[aPos, 3], [aTan, 3], [aR, 4], [aR2, 4], [aR3, 2]]) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, nvUsed * n);
        a.needsUpdate = true;
      }
    },
    clear() { recs.length = 0; used = 0; geo.setDrawRange(0, 0); mesh.visible = false; },
  };
  return api;
}
