// game.bossFx (system 'bossFx', order 63) — boss update: the Cloud Titan fight dressed up. Presentation only; it reads
// game.titan and listens to the events titan.js already emits.
//   halo       an anime boss halo behind the titan's chest: a molten-gold rune ring (rotating glyph band, tick ring,
//              a hexagram turning the other way) that draws itself in when the titan breaks the clouds; enraged it
//              re-ignites crimson, doubles and spins faster
//   core shell a plasma shell on the titan's core: fresnel rim and crawling electric veins, much brighter while the
//              core is open (titan:weak), crimson when enraged; on the fall it swells into a burst of light
//   lightning  storm bolts fork down around the arena every few seconds (thunder, a sky flash); enraged, arcs crackle
//              between its hands and wing tips; every attack's telegraph charges the striking hand with arcs and light
//   impacts    slams, claps and roars ripple the screen and kick the bloom; guard breaks and staggers shatter sparks
//   enrage     a slow-motion beat, a shockwave, a flash, and the sky blends to 'tempest' (crimson-violet storm)
//   embers     enraged, crimson and gold embers stream up past Sora
//   post       pipeline.setBoss: heat shimmer and light rays pouring from the core, the lightning flash, the
//              enraged crimson grade with a heartbeat at the edges of the view
// Everything scales with game.quality.bossFx (0.45 on the cheapest automatic rungs … 1): fewer bolts, embers and
// particles, no rays below 0.5. ?bossfx=0 turns it off. Draw calls: 3 (halo, shell, its own arcs) and only while the
// titan is up. bossFx.stats counts what it did (tests); bossFx.config switches the parts.
import * as THREE from 'three';
import { getParticles, GLOW } from './particles.js';
import { ROW } from './textures.js';
import { createArcs, ARC_STYLE } from './arcs.js';

const V3 = THREE.Vector3;
const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const damp = (k, dt) => 1 - Math.exp(-k * dt);
const _a = new V3(), _b = new V3(), _c = new V3(), _p = new V3();
function randDir(out) { const z = rnd(-1, 1), ph = Math.random() * 6.2832, r = Math.sqrt(1 - z * z); return out.set(r * Math.cos(ph), z, r * Math.sin(ph)); }

const NOISE = /* glsl */`
float h31(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h31(i), h31(i + vec3(1, 0, 0)), f.x), mix(h31(i + vec3(0, 1, 0)), h31(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(h31(i + vec3(0, 0, 1)), h31(i + vec3(1, 0, 1)), f.x), mix(h31(i + vec3(0, 1, 1)), h31(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
`;

const SHELL_VERT = /* glsl */`
varying vec3 vN, vV, vP;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vV = cameraPosition - wp.xyz;
  vP = position;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const SHELL_FRAG = /* glsl */`
uniform float uTime, uK, uOpen, uEnr, uBurst;
uniform vec3 uColA, uColB;
varying vec3 vN, vV, vP;
${NOISE}
void main() {
  float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  float rim = pow(f, 2.2);
  vec3 p = vP * 2.2 + vec3(0.0, -uTime * 0.9, uTime * 0.25);
  float w = vnoise(p * 0.8 + uTime * 0.35);
  float n = vnoise(p + w * 2.0) * 0.65 + vnoise(p * 2.3 - w) * 0.35;
  float vein = pow(1.0 - clamp(abs(n - 0.5) * 7.0, 0.0, 1.0), 3.0);          // thin bright filaments
  float a = rim * (0.35 + 0.35 * uOpen) + vein * (0.22 + 0.5 * uOpen) * (0.25 + 0.75 * f);
  a *= uK * (1.0 - uBurst * 0.55);
  vec3 col = mix(uColA, uColB, clamp(vein * 1.2 + rim * 0.3, 0.0, 1.0)) * (0.9 + 0.9 * uOpen + 3.0 * uBurst);
  gl_FragColor = vec4(col * a, 0.0);                                         // premultiplied, alpha 0: additive
}`;

const HALO_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const HALO_FRAG = /* glsl */`
uniform float uTime, uK, uReveal, uEnr, uPulse;
uniform vec3 uGold, uCrimson;
varying vec2 vUv;
float h11(float x) { return fract(sin(x * 127.1) * 43758.5453); }
float line(float d, float w) { return exp(-d * d / (w * w)); }
void main() {
  vec2 uv = vUv;
  float r = length(uv);
  if (r > 1.0) discard;
  float a = atan(uv.y, uv.x);
  float TAU = 6.2831853;
  float spin = uTime * (0.07 + 0.16 * uEnr);
  // drawn in clockwise from the top as it reveals
  float an = fract((-a + 1.5708) / TAU + 1.0);
  float shown = smoothstep(uReveal, uReveal - 0.04, an);
  // outer double ring
  float g = line(r - 0.93, 0.006) + 0.6 * line(r - 0.885, 0.004);
  // tick ring
  float tk = fract((a + spin * 0.5) * 72.0 / TAU);
  g += line(r - 0.835, 0.018) * step(0.82, tk) * 0.9;
  // glyph band: 40 cells round the ring, each a 3 × 2 hash pattern of strokes
  float ga = a - spin;
  float cell = floor(ga * 40.0 / TAU);
  float cu = fract(ga * 40.0 / TAU);
  float rv = (r - 0.69) / 0.1;
  if (rv > 0.0 && rv < 1.0 && cu > 0.12 && cu < 0.88) {
    vec2 gp = vec2((cu - 0.12) / 0.76 * 3.0, rv * 2.0);
    vec2 gi = floor(gp), gf = fract(gp);
    float bits = h11(cell + floor(uTime * 0.6 * uEnr) * 13.0);
    float b = step(0.45, fract(bits * (7.0 + gi.x * 3.0 + gi.y * 11.0)));
    float stroke = max(line(gf.x - 0.5, 0.12) * step(0.5, b), line(gf.y - 0.5, 0.14) * step(b, 0.5));
    g += stroke * 0.95;
  }
  g += line(r - 0.67, 0.005) * 0.8 + line(r - 0.8, 0.004) * 0.7;
  // a hexagram turning the other way inside
  float hr = 0.6;
  float t1 = r * cos(mod(a + spin * 1.6, TAU / 3.0) - TAU / 6.0) - hr * 0.5;
  float t2 = r * cos(mod(a + spin * 1.6 + TAU / 6.0, TAU / 3.0) - TAU / 6.0) - hr * 0.5;
  float hex = (line(t1, 0.006) + line(t2, 0.006)) * step(r, hr);
  g += hex * 0.75;
  // a soft glow pooled behind the ring
  float glow = exp(-pow((r - 0.8) / 0.18, 2.0)) * 0.22 + exp(-r * r * 3.0) * 0.06;
  // enraged: a second, outer ring of crimson flame teeth spinning the other way
  float teeth = 0.0;
  if (uEnr > 0.01) {
    float ta = fract((a - spin * 2.2) * 28.0 / TAU);
    float tooth = smoothstep(0.0, 0.5, ta) * smoothstep(1.0, 0.5, ta);
    teeth = line(r - (0.965 + 0.02 * tooth), 0.008 + 0.01 * tooth) * uEnr;
  }
  float pulse = 1.0 + uPulse * 1.8;
  vec3 c = mix(uGold, uCrimson, uEnr);
  vec3 col = c * (g * 2.6 + glow) * pulse * shown + uCrimson * teeth * 3.0;
  float edge = smoothstep(1.0, 0.95, r);
  gl_FragColor = vec4(col * uK * edge, 0.0);
}`;

export default function createBossFx(game) {
  const config = {
    on: game.params?.get?.('bossfx') !== '0',
    halo: 1, shell: 1, lightning: 1, embers: 1, post: 1,
    boltEvery: [2.6, 6], boltEveryEnraged: [1.2, 3.2], boltRange: [220, 700],
    haloSize: 82, haloBack: 70, shellSize: 11,
  };
  const stats = { bolts: 0, crackles: 0, telegraphs: 0, impacts: 0, embers: 0, enrages: 0, opens: 0, bursts: 0, frames: 0 };
  const reduced = (() => { try { return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();
  let built = false, E = null, arcs = null, halo = null, shell = null, warned = false;
  const st = {
    k: 0, reveal: 0, enr: 0, enrOn: false, open: 0, openT: 0, pulse: 0, flash: 0, burst: -1,
    nextBolt: 3, nextCrackle: 1, emberAcc: 0, core: new V3(), chest: new V3(), hands: { L: new V3(), R: new V3() },
    wings: { L: new V3(), R: new V3() }, charge: { L: 0, R: 0 }, energy: 0,
  };
  const warn = (what, e) => { if (!warned) { warned = true; console.warn('[bossFx] ' + what, e); } };
  const fx = () => clamp(game.quality?.bossFx ?? 1, 0.3, 1.25);
  const titan = () => game.titan || null;
  const up = () => { const T = titan(); return !!(T && T.active && T.actor && (T.phase === 'rising' || T.phase === 'fight' || T.phase === 'enraged' || T.phase === 'dying')); };
  const playerPos = () => game.player?.pos || game.player?.dragon?.pos || null;

  function build() {
    built = true;
    const FX = game.pipeline?.FX_LAYER ?? 3;
    const add = (m) => { m.frustumCulled = false; m.layers.set(FX); m.userData._fxChecked = true; m.visible = false; game.scene.add(m); return m; };
    const blend = { transparent: true, depthWrite: false, depthTest: true, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor };
    halo = add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      vertexShader: HALO_VERT, fragmentShader: HALO_FRAG, side: THREE.DoubleSide, ...blend,
      uniforms: { uTime: { value: 0 }, uK: { value: 0 }, uReveal: { value: 0 }, uEnr: { value: 0 }, uPulse: { value: 0 },
        uGold: { value: new THREE.Color(1.0, 0.68, 0.26) }, uCrimson: { value: new THREE.Color(1.0, 0.12, 0.1) } },
    })));
    halo.renderOrder = 40;
    shell = add(new THREE.Mesh(new THREE.IcosahedronGeometry(1, 4), new THREE.ShaderMaterial({
      vertexShader: SHELL_VERT, fragmentShader: SHELL_FRAG, side: THREE.FrontSide, ...blend,
      uniforms: { uTime: { value: 0 }, uK: { value: 0 }, uOpen: { value: 0 }, uEnr: { value: 0 }, uBurst: { value: 0 },
        uColA: { value: new THREE.Color(1.0, 0.55, 0.15) }, uColB: { value: new THREE.Color(1.0, 0.92, 0.7) } },
    })));
    shell.renderOrder = 52;
    for (const m of [halo, shell]) m.material.userData.fx = true;
    try {
      arcs = createArcs(game, { maxRibbons: 72, points: 17, maxArcs: 40 });
      arcs.mesh.layers.set(FX); arcs.mesh.userData._fxChecked = true; game.scene.add(arcs.mesh);
    } catch (e) { warn('arcs', e); arcs = null; }
    try { E = getParticles(game); } catch (e) { warn('particles', e); E = null; }
  }

  // ---- particles ----
  function glow(pos, shape, row, s0, s1, life, intensity = 1) {
    if (!E) return;
    const P = E.reset();
    P.x = pos.x; P.y = pos.y; P.z = pos.z; P.shape = shape; P.row = row; P.size0 = s0; P.size1 = s1; P.life = life;
    P.intensity = intensity; P.heat = 1; P.cool = 1;
    E.glow.push(P);
  }
  function sparks(pos, n, row, speed, life, size = 0.5, o = {}) {
    if (!E) return;
    const cnt = Math.max(1, Math.round(n * fx()));
    for (let i = 0; i < cnt; i++) {
      const P = E.reset();
      randDir(_a);
      if (o.up) _a.y = Math.abs(_a.y);
      const sp = speed * rnd(0.4, 1.2);
      P.x = pos.x; P.y = pos.y; P.z = pos.z;
      P.vx = _a.x * sp; P.vy = _a.y * sp; P.vz = _a.z * sp;
      P.life = life * rnd(0.6, 1.25); P.size0 = P.size1 = size * rnd(0.7, 1.3);
      P.drag = o.drag ?? 1.4; P.grav = o.grav ?? -9; P.stretch = 0.06; P.shape = GLOW.streak; P.row = row;
      P.heat = 1; P.cool = 0.9; P.intensity = o.intensity ?? 1.8;
      E.glow.push(P);
    }
  }
  function shock(pos, size, row = ROW.titan, life = 0.9) {
    glow(pos, GLOW.ring, row, size * 0.15, size, life, 1.6);
    glow(pos, GLOW.ring, ROW.titanSpark, size * 0.1, size * 0.7, life * 0.8, 1.2);
    glow(pos, GLOW.star, ROW.titanSpark, size * 0.5, size * 0.1, life * 0.5, 2.2);
  }

  // ---- screen helpers ----
  function toScreen(pos) {
    _p.copy(pos).project(game.camera);
    return { x: _p.x * 0.5 + 0.5, y: _p.y * 0.5 + 0.5, front: _p.z < 1 && _p.z > -1 };
  }
  function ripple(pos, strength, speed = 1.2, life = 0.8) {
    if (!game.pipeline?.ripple) return;
    const s = toScreen(pos);
    if (!s.front || s.x < -0.3 || s.x > 1.3 || s.y < -0.3 || s.y > 1.3) return;
    game.pipeline.ripple(s.x, s.y, strength, speed, life);
  }
  const kick = (k) => game.pipeline?.kick?.(k);
  const near = (pos, m) => { const pp = playerPos(); return !!(pp && pos && pp.distanceTo(pos) < m); };

  // ---- lightning ----
  function bolt(force = false) {
    const T = titan();
    if (!arcs || !T) return;
    const c = T.actor.pos;
    const ang = Math.random() * 6.2832, d = rnd(config.boltRange[0], config.boltRange[1]);
    const ground = (T.cloudTop?.() ?? c.y - 200) - 10;
    const to = _a.set(c.x + Math.cos(ang) * d, ground + rnd(-20, 60), c.z + Math.sin(ang) * d).clone();
    const from = _b.set(to.x + rnd(-80, 80), c.y + rnd(500, 800), to.z + rnd(-80, 80)).clone();
    const style = st.enrOn ? (Math.random() < 0.5 ? ARC_STYLE.prism : ARC_STYLE.storm) : ARC_STYLE.storm;
    if (style === ARC_STYLE.prism) arcs.setPrism?.(new THREE.Color(1.0, 0.18, 0.3), new THREE.Color(0.6, 0.2, 1.0));
    const w = rnd(2.6, 4.5);
    arcs.strike({ from, to, amp: 0.11, rough: 0.6, life: 0.42, hold: 0.35, width: w, minPx: 2.6, intensity: 2.2, style,
      core: 0.35, branches: 3, fork: 0.35, haze: 0.8, taper: 1, prio: true });
    arcs.strike({ from, to, amp: 0.13, rough: 0.6, life: 0.3, delay: 0.09, hold: 0.2, width: w * 0.7, minPx: 2, intensity: 1.6, style,
      core: 0.3, branches: 2, fork: 0.3, haze: 0.5, taper: 1 });
    glow(to, GLOW.star, ROW.lightning, 60, 10, 0.5, 2.5);
    glow(to, GLOW.ring, ROW.lightning, 10, 90, 0.7, 1.2);
    const pp = playerPos();
    const dist = pp ? pp.distanceTo(to) : 600;
    st.flash = Math.max(st.flash, clamp(1.15 - dist / 1600, 0.25, 0.85) * (reduced ? 0.4 : 1));
    try { game.audio?.play?.('thunder', { pos: to, far: clamp(dist / 5000, 0, 1) }); } catch { /* optional */ }
    stats.bolts++;
  }
  function crackle(from, to, k = 1, style = ARC_STYLE.storm) {
    if (!arcs) return;
    arcs.strike({ from: { ref: from }, to: { ref: to }, amp: 0.16, rough: 0.6, life: rnd(0.12, 0.22), hold: 0.25, width: 0.7 * k,
      minPx: 1.6, intensity: 1.6 * k, style, core: 0.3, branches: 1, fork: 0.25, haze: 0.3, taper: 0 });
    stats.crackles++;
  }

  // ---- events ----
  function on(name, fn) { game.events.on(name, (e) => { if (!config.on || !built) return; try { fn(e || {}); } catch (err) { warn(name, err); } }); }
  function hookEvents() {
    on('titan:spawn', () => { st.reveal = 0; st.k = 0; st.enr = 0; st.enrOn = false; st.burst = -1; });
    on('titan:emerged', () => {
      const T = titan(); if (!T) return;
      st.reveal = 0.001; st.pulse = 1;
      shock(T.socket('chest', _c) || T.actor.pos, 180, ROW.titan, 1.2);
      ripple(T.actor.pos, 0.9, 1.0, 1.1); kick(0.6);
    });
    on('titan:telegraph', (e) => {
      const h = e.hand === 'L' || e.hand === 'R' ? e.hand : null;
      if (h) {
        st.charge[h] = Math.max(st.charge[h], 1);
        glow(st.hands[h], GLOW.star, ROW.titan, 18, 4, Math.min(1.4, e.duration || 1), 2.2);
      }
      st.pulse = Math.max(st.pulse, 0.5);
      stats.telegraphs++;
    });
    on('titan:impact', (e) => {
      if (!e.point) return;
      const s = clamp(e.strength ?? 1, 0.2, 1.6);
      if (e.kind === 'contact' && s < 0.6) return;
      shock(e.point, 50 + 70 * s);
      sparks(e.point, 26 * s, ROW.titanSpark, 60 * s, 1.1, 0.9);
      if (near(e.point, 900)) { ripple(e.point, 0.5 + 0.5 * s, 1.3, 0.8); kick(0.3 + 0.3 * s); }
      stats.impacts++;
    });
    on('titan:roar', (e) => {
      const T = titan(); if (!T) return;
      const m = T.socket('mouth', _c) || T.socket('head', _c) || T.actor.pos;
      glow(m, GLOW.ring, ROW.titan, 10, 160, 1.0, 1.4);
      ripple(m, 0.6 * clamp(e.strength ?? 1, 0.3, 1.4), 0.9, 1.2); kick(0.35);
      st.pulse = 1;
    });
    on('titan:weak', (e) => {
      st.openT = Math.max(st.openT, clamp(+e.duration || 3, 1, 8));
      stats.opens++;
      shock(st.core, 70, ROW.titan, 0.8);
      sparks(st.core, 40, ROW.titanSpark, 70, 1.2, 0.8);
      ripple(st.core, 0.55, 1.4, 0.7); kick(0.45);
    });
    on('titan:guardbreak', () => {
      sparks(st.core, 60, ROW.titanSpark, 110, 1.3, 1.0);
      shock(st.core, 110, ROW.titan, 0.9); ripple(st.core, 0.8, 1.5, 0.8); kick(0.6);
    });
    on('titan:stagger', () => {
      sparks(st.chest, 44, ROW.titanSpark, 90, 1.2, 0.9); kick(0.4); st.pulse = 1;
    });
    on('titan:phase', (e) => {
      if (e.phase !== 'enraged' || st.enrOn) return;
      st.enrOn = true; stats.enrages++;
      st.reveal = 0.001; st.pulse = 1.5; st.flash = Math.max(st.flash, reduced ? 0.35 : 1);
      shock(st.chest, 260, ROW.enemy, 1.4);
      shock(st.chest, 160, ROW.titan, 1.0);
      sparks(st.chest, 90, ROW.titanSpark, 150, 1.6, 1.2);
      ripple(st.chest, 1.2, 0.9, 1.4); kick(1);
      try { game.spectacle?.beat?.(); } catch { /* optional */ }
      try { game.atmo?.setPreset?.('tempest', 4); } catch { /* optional */ }
      for (let i = 0; i < 2; i++) bolt(true);
      st.nextBolt = 0.8;
    });
    on('titan:fallen', () => {
      st.burst = 0; stats.bursts++;
      st.flash = reduced ? 0.4 : 1;
      shock(st.core, 400, ROW.titan, 2.0);
      shock(st.core, 240, ROW.radiant, 1.6);
      sparks(st.core, 140, ROW.titanSpark, 200, 2.2, 1.4);
      ripple(st.core, 1.4, 0.8, 1.8); kick(1);
    });
  }

  // ---- per frame ----
  function hide() {
    if (halo) halo.visible = false;
    if (shell) shell.visible = false;
  }
  function update(dt, realDt) {
    if (!config.on) return;
    if (!built) { if (!up()) return; build(); hookEvents(); }
    const rdt = clamp(realDt || dt || 0.016, 0, 0.1);
    const T = titan();
    const live = up() && game.state !== 'title';
    const q = fx();
    st.k += ((live ? 1 : 0) - st.k) * damp(live ? 1.5 : 3, rdt);
    if (!T || !T.actor || st.k < 0.003) { hide(); arcs?.update(); st.flash = 0; return; }
    stats.frames++;
    const time = game.time?.now ?? 0;
    T.socket('core', st.core) || st.core.copy(T.actor.pos);
    T.socket('chest', st.chest) || st.chest.copy(T.actor.pos);
    for (const h of ['L', 'R']) {
      T.socket('palm' + h, st.hands[h]) || st.hands[h].copy(T.actor.pos);
      T.socket('wingtip' + h, st.wings[h]) || st.wings[h].copy(T.actor.pos);
    }
    if (T.phase === 'enraged' && !st.enrOn) {
      // enraged without the event (a retry from the checkpoint below the enrage line): straight into it
      st.enrOn = true; st.reveal = Math.max(st.reveal, 0.001);
      try { if (game.atmo?.preset !== 'tempest') game.atmo?.setPreset?.('tempest', 2); } catch { /* optional */ }
    }
    if (T.phase !== 'enraged' && T.phase !== 'dying' && st.enrOn && T.phase === 'fight') st.enrOn = false;
    st.enr += ((st.enrOn ? 1 : 0) - st.enr) * damp(1.6, rdt);
    if (st.reveal > 0 && st.reveal < 1.05) st.reveal += rdt / 1.6;
    if (T.phase === 'fight' || T.phase === 'enraged') st.reveal = Math.max(st.reveal, 0.001);
    st.openT = Math.max(0, st.openT - rdt);
    st.open += ((st.openT > 0 ? 1 : 0) - st.open) * damp(st.openT > 0 ? 8 : 2.5, rdt);
    st.pulse *= Math.exp(-rdt * 3);
    st.flash *= Math.exp(-rdt * 7);
    if (st.burst >= 0) st.burst += rdt;
    const cam = game.camera;

    // halo: a camera-facing disc behind the chest
    if (halo) {
      const show = config.halo > 0 && st.reveal > 0 && T.phase !== 'dead';
      halo.visible = show;
      if (show) {
        _a.copy(st.chest).sub(cam.position);
        const dist = _a.length(); _a.multiplyScalar(1 / Math.max(1, dist));
        halo.position.copy(st.chest).addScaledVector(_a, config.haloBack);
        halo.quaternion.copy(cam.quaternion);
        const size = config.haloSize * (1 + 0.12 * st.enr) * (1 + 0.04 * st.pulse);
        halo.scale.setScalar(size);
        const u = halo.material.uniforms;
        u.uTime.value = time; u.uReveal.value = Math.min(1.05, st.reveal); u.uEnr.value = st.enr; u.uPulse.value = st.pulse;
        const dying = T.phase === 'dying' ? Math.max(0, 1 - (st.burst >= 0 ? st.burst / 0.6 : 0)) : 1;
        u.uK.value = st.k * dying * (0.75 + 0.25 * q);
      }
    }
    // core shell
    if (shell) {
      const burst = st.burst >= 0 ? st.burst : 0;
      const show = config.shell > 0 && (T.phase !== 'dead' || (st.burst >= 0 && st.burst < 2.6));
      shell.visible = show;
      if (show) {
        shell.position.copy(st.core);
        const s = config.shellSize * (1 + 0.12 * st.open + 0.08 * Math.sin(time * 6) * st.enr) + burst * burst * 120;
        shell.scale.setScalar(s);
        const u = shell.material.uniforms;
        u.uTime.value = time; u.uOpen.value = st.open; u.uEnr.value = st.enr;
        u.uBurst.value = st.burst >= 0 ? Math.min(1, st.burst * 2) : 0;
        u.uK.value = st.k * (st.burst >= 0 ? Math.max(0, 1 - st.burst / 2.6) : 1);
        u.uColA.value.setRGB(1.0, 0.55 - 0.42 * st.enr, 0.15 + 0.05 * st.enr);
        u.uColB.value.setRGB(1.0, 0.92 - 0.5 * st.enr, 0.7 - 0.3 * st.enr + 0.25 * st.enr);
      }
    }

    const fighting = T.phase === 'fight' || T.phase === 'enraged';
    if (fighting && game.state === 'play') {
      // storm bolts round the arena
      if (config.lightning > 0) {
        st.nextBolt -= rdt;
        if (st.nextBolt <= 0) {
          bolt();
          const r = st.enrOn ? config.boltEveryEnraged : config.boltEvery;
          st.nextBolt = rnd(r[0], r[1]) / Math.max(0.35, q);
        }
      }
      // a charging hand crackles; enraged, arcs leap between hands and wing tips
      for (const h of ['L', 'R']) {
        if (st.charge[h] > 0) {
          st.charge[h] -= rdt;
          if (Math.random() < rdt * 22 * q) {
            _b.copy(st.hands[h]).addScaledVector(randDir(_c), rnd(6, 14));
            crackle(st.hands[h], _b.clone(), 0.8, st.enrOn ? ARC_STYLE.prism : ARC_STYLE.storm);
            if (Math.random() < 0.5) sparks(st.hands[h], 3, ROW.titanSpark, 26, 0.6, 0.6);
          }
        }
      }
      if (st.enrOn && config.lightning > 0) {
        st.nextCrackle -= rdt;
        if (st.nextCrackle <= 0) {
          st.nextCrackle = rnd(0.25, 0.9) / q;
          const pairs = [[st.hands.L, st.wings.L], [st.hands.R, st.wings.R], [st.hands.L, st.hands.R], [st.core, st.wings.L], [st.core, st.wings.R]];
          const [a, b] = pairs[(Math.random() * pairs.length) | 0];
          crackle(a, b, 1.6, Math.random() < 0.6 ? ARC_STYLE.prism : ARC_STYLE.storm);
        }
      }
      // embers streaming up past Sora while it rages
      const pp = playerPos();
      if (st.enr > 0.05 && config.embers > 0 && E && pp && !reduced) {
        st.emberAcc += rdt * 46 * q * st.enr;
        while (st.emberAcc >= 1) {
          st.emberAcc -= 1;
          const P = E.reset();
          randDir(_a); _a.y = 0; _a.normalize();
          const d = rnd(12, 90);
          P.x = pp.x + _a.x * d; P.y = pp.y + rnd(-60, 10); P.z = pp.z + _a.z * d;
          P.vx = rnd(-3, 3); P.vy = rnd(14, 34); P.vz = rnd(-3, 3);
          P.life = rnd(1.6, 3.2); P.size0 = rnd(0.25, 0.6); P.size1 = 0.05;
          P.drag = 0.3; P.grav = 2; P.stretch = 0.04; P.shape = GLOW.sparkle; P.row = Math.random() < 0.6 ? ROW.titanSpark : ROW.enemySpark;
          P.heat = 1; P.cool = 0.8; P.intensity = 1.6;
          E.glow.push(P);
          stats.embers++;
        }
      }
    }
    arcs?.update();

    // post: the core on screen, its energy, the enrage, the flash
    if (game.pipeline?.setBoss && config.post > 0) {
      const s = toScreen(st.core);
      const pp = playerPos();
      const dist = pp ? pp.distanceTo(st.core) : 400;
      const closeK = clamp(1.3 - dist / 900, 0.25, 1);
      const raysOn = q >= 0.5;
      st.energy += (((0.15 + 0.5 * st.open + 0.2 * st.pulse + (st.burst >= 0 ? 1.2 * Math.max(0, 1 - st.burst / 2) : 0)) * closeK * (raysOn ? 1 : 0)) - st.energy) * damp(6, rdt);
      game.pipeline.setBoss({
        x: s.x, y: s.y, energy: st.energy * st.k, enrage: st.enr * st.k * (T.phase === 'dying' || T.phase === 'dead' ? 0.4 : 1),
        flash: st.flash, onScreen: s.front && s.x > -0.2 && s.x < 1.2 && s.y > -0.2 && s.y < 1.2,
      });
    }
  }

  return {
    name: 'bossFx',
    config, stats,
    get state() { return st; },
    get meshes() { return { halo, shell, arcs: arcs?.mesh || null }; },
    /** Tests / reviews: a storm bolt now. */
    bolt: () => { if (built) bolt(true); },
    update,
  };
}
