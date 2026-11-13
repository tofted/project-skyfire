// Titan-owned VFX (telegraph language + scale cues). Fire itself (fireballs, charges, explosions) belongs to
// game.fx; this file only draws what is part of the titan's body language:
//   eye glints (the universal "here it comes"), core glow, palm glow + rune circles, shock rings, anime wind lines,
//   meteor target runes, stone debris + dust, hand smears on fast swings, and a minimal fallback projectile when
//   game.fx is absent (sandbox only). Shapes animate "on twos" (stepped), motion is continuous.
import * as THREE from 'three';
import { clamp } from '../../core/util.js';

const V = () => new THREE.Vector3();
const _a = V(), _b = V(), _c = V(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = V();

function canvasTex(size, draw) {
  const cv = document.createElement('canvas'); cv.width = cv.height = size;
  const g = cv.getContext('2d');
  draw(g, size);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function makeTextures() {
  const glow = canvasTex(128, (g, s) => {
    const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.25, 'rgba(255,255,255,0.55)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, s, s);
  });
  const star = canvasTex(256, (g, s) => {
    const c = s / 2;
    const ray = (ang, len, w) => {
      g.save(); g.translate(c, c); g.rotate(ang);
      const gr = g.createLinearGradient(-len, 0, len, 0);
      gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.5, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.beginPath(); g.moveTo(-len, 0); g.lineTo(0, -w); g.lineTo(len, 0); g.lineTo(0, w); g.closePath(); g.fill();
      g.restore();
    };
    ray(0, c, 7); ray(Math.PI / 2, c, 7); ray(Math.PI / 4, c * 0.45, 3); ray(-Math.PI / 4, c * 0.45, 3);
    const r = g.createRadialGradient(c, c, 0, c, c, c * 0.25);
    r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, s, s);
  });
  const rune = canvasTex(512, (g, s) => {
    const c = s / 2;
    g.strokeStyle = 'rgba(255,255,255,1)'; g.fillStyle = 'rgba(255,255,255,1)';
    g.lineWidth = 10; g.beginPath(); g.arc(c, c, c * 0.94, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 4; g.beginPath(); g.arc(c, c, c * 0.84, 0, Math.PI * 2); g.stroke();
    g.lineWidth = 6; g.beginPath(); g.arc(c, c, c * 0.52, 0, Math.PI * 2); g.stroke();
    // rune ticks between the outer rings
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2;
      g.save(); g.translate(c + Math.cos(a) * c * 0.89, c + Math.sin(a) * c * 0.89); g.rotate(a + Math.PI / 2);
      const k = i % 3;
      g.fillRect(-2, -c * 0.035, 4, c * 0.07);
      if (k === 0) g.fillRect(-c * 0.03, -c * 0.035, c * 0.06, 4);
      if (k === 1) { g.beginPath(); g.arc(0, 0, c * 0.022, 0, Math.PI * 2); g.fill(); }
      g.restore();
    }
    // interlaced triangles (hexagram) + spokes
    g.lineWidth = 5;
    for (const off of [0, Math.PI / 3]) {
      g.beginPath();
      for (let i = 0; i <= 3; i++) { const a = off + (i / 3) * Math.PI * 2 - Math.PI / 2; const x = c + Math.cos(a) * c * 0.84, y = c + Math.sin(a) * c * 0.84; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
      g.stroke();
    }
    g.lineWidth = 3;
    for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; g.beginPath(); g.moveTo(c + Math.cos(a) * c * 0.2, c + Math.sin(a) * c * 0.2); g.lineTo(c + Math.cos(a) * c * 0.5, c + Math.sin(a) * c * 0.5); g.stroke(); }
    const r = g.createRadialGradient(c, c, 0, c, c, c * 0.3);
    r.addColorStop(0, 'rgba(255,255,255,0.9)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.beginPath(); g.arc(c, c, c * 0.3, 0, Math.PI * 2); g.fill();
  });
  const ring = canvasTex(256, (g, s) => {
    const c = s / 2;
    const r = g.createRadialGradient(c, c, c * 0.62, c, c, c);
    r.addColorStop(0, 'rgba(255,255,255,0)'); r.addColorStop(0.72, 'rgba(255,255,255,1)'); r.addColorStop(0.8, 'rgba(255,255,255,0.7)'); r.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = r; g.fillRect(0, 0, s, s);
  });
  const streak = canvasTex(128, (g, s) => {
    const gr = g.createLinearGradient(0, 0, s, 0);
    gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.7, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.beginPath(); g.moveTo(0, s / 2); g.quadraticCurveTo(s * 0.7, s * 0.3, s, s / 2); g.quadraticCurveTo(s * 0.7, s * 0.7, 0, s / 2); g.fill();
  });
  const puff = canvasTex(128, (g, s) => {
    for (let i = 0; i < 7; i++) {
      const x = s * (0.3 + 0.4 * Math.random()), y = s * (0.3 + 0.4 * Math.random()), r = s * (0.16 + 0.12 * Math.random());
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.7, 'rgba(255,255,255,0.8)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
  });
  // soft cloud mist (wave 4): overlapping blobs, alpha only fades (no cut-out edge), r = top-lit variation
  const mist = (() => {
    const cv = document.createElement('canvas'); cv.width = cv.height = 128;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, 128, 128);
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 11; i++) {
      const x = 64 + (rnd() - 0.5) * 50, y = 64 + (rnd() - 0.5) * 40, r = 22 + rnd() * 26;
      const lit = Math.round(255 * clamp(0.62 + (64 - y) / 90 + 0.1 * rnd(), 0.45, 1));
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, `rgba(${lit},${lit},${lit},0.26)`); gr.addColorStop(0.55, `rgba(${lit},${lit},${lit},0.14)`); gr.addColorStop(1, `rgba(${lit},${lit},${lit},0)`);
      g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    }
    // fade the square's edge to zero whatever the blobs did
    const img = g.getImageData(0, 0, 128, 128), d = img.data;
    for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
      const q = Math.hypot(x - 63.5, y - 63.5) / 64, k = clamp((1 - q) / 0.35, 0, 1);
      d[(y * 128 + x) * 4 + 3] *= k * k * (3 - 2 * k);
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.NoColorSpace;
    return t;
  })();
  return { glow, star, rune, ring, streak, puff, mist };
}

const additive = (map, color, opacity = 1) => new THREE.MeshBasicMaterial({
  map, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
});

export class TitanVFX {
  constructor(game, titan) {
    this.game = game; this.titan = titan;
    const tex = this.tex = makeTextures();
    const group = this.group = new THREE.Group();
    group.name = 'titan-vfx';
    game.scene.add(group);
    // Titan fire language (contract): molten gold at the heart → crimson at the edge, never the player's orange
    const HOT = new THREE.Color(1.0, 0.72, 0.28), EYE = new THREE.Color(1.0, 0.92, 0.6);
    const GOLD = new THREE.Color(1.0, 0.8, 0.32), CRIMSON = new THREE.Color(0.95, 0.07, 0.12);
    this.colors = { GOLD, CRIMSON };

    const sprite = (map, color, size, opacity = 1) => {
      const m = new THREE.SpriteMaterial({ map, color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      const s = new THREE.Sprite(m); s.scale.setScalar(size); s.frustumCulled = false; group.add(s); return s;
    };
    this.eyes = [sprite(tex.star, EYE, 1, 0), sprite(tex.star, EYE, 1, 0)];
    // HDR colours: the pipeline blooms only above 1.0 (max channel), so glows must be hot to read as light
    this.eyeGlow = [sprite(tex.glow, EYE.clone().multiplyScalar(2.6), 6, 0.55), sprite(tex.glow, EYE.clone().multiplyScalar(2.6), 6, 0.55)];
    this.core = sprite(tex.glow, HOT.clone().multiplyScalar(3.2), 26, 0.8);
    this.coreHalo = sprite(tex.glow, HOT.clone().multiplyScalar(0.9), 40, 0.5);
    this.coreStar = sprite(tex.star, HOT.clone().multiplyScalar(2.2), 30, 0.35);
    this.palm = { L: sprite(tex.glow, GOLD.clone().multiplyScalar(2.6), 1, 0), R: sprite(tex.glow, GOLD.clone().multiplyScalar(2.6), 1, 0) };
    this.palmHalo = { L: sprite(tex.glow, CRIMSON.clone().multiplyScalar(1.6), 1, 0), R: sprite(tex.glow, CRIMSON.clone().multiplyScalar(1.6), 1, 0) };
    this.glintT = 9; this.flare = { k: 0, t: 0, dur: 1 };

    // rune circles in front of the casting palm (two counter-rotating layers)
    this.runes = {};
    for (const h of ['L', 'R']) {
      const g = new THREE.Group();
      const m1 = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), additive(tex.rune, GOLD.clone().multiplyScalar(1.3), 0.9));
      const m2 = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), additive(tex.rune, CRIMSON.clone().multiplyScalar(1.5), 0.55));
      m2.position.z = -1.2;
      g.add(m1, m2); g.visible = false; group.add(g);
      for (const m of [m1, m2]) m.frustumCulled = false;
      this.runes[h] = { g, m1, m2, on: false, k: 0 };
    }
    // 2026-09-25: the ward over the core (a still target, titan.js guard): a big pale-gold rune disc in front of the
    // core, facing the spot the dragon sniped from (the axis stays put: fly round it and it faces the empty sky)
    {
      const g = new THREE.Group();
      const m1 = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), additive(tex.rune, new THREE.Color(1.0, 0.9, 0.62).multiplyScalar(1.15), 0));
      const m2 = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), additive(tex.rune, GOLD.clone().multiplyScalar(0.9), 0));
      m2.position.z = -1.5; m2.scale.setScalar(0.72);
      g.add(m1, m2); g.visible = false; group.add(g);
      for (const m of [m1, m2]) m.frustumCulled = false;
      this.ward = { g, m1, m2, flash: 0 };
    }

    // pooled shock rings
    this.rings = [];
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), additive(tex.ring, new THREE.Color(1, 1, 1), 0));
      m.visible = false; m.frustumCulled = false; group.add(m);
      this.rings.push({ m, t: 0, dur: 1, r0: 1, r1: 10, alpha: 1, face: false });
    }
    // meteor target runes on the player's altitude plane
    this.markers = [];
    for (let i = 0; i < 14; i++) {
      const g = new THREE.Group();
      const ring = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), additive(tex.rune, CRIMSON.clone().multiplyScalar(1.6), 0));
      const fill = new THREE.Mesh(new THREE.CircleGeometry(0.5, 32), additive(tex.glow, GOLD.clone().multiplyScalar(1.1), 0));
      ring.rotation.x = fill.rotation.x = -Math.PI / 2;
      g.add(ring, fill); g.visible = false; group.add(g);
      ring.frustumCulled = fill.frustumCulled = false;
      this.markers.push({ g, ring, fill, t: 0, dur: 3, on: false, r: 16 });
    }

    // anime wind lines (instanced streak quads, camera-facing along their motion)
    this.windN = 56;
    const wl = this.wind = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), additive(tex.streak, new THREE.Color(1, 1, 1), 0.7), this.windN);
    wl.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.windN * 3), 3);
    wl.frustumCulled = false; wl.count = 0; group.add(wl);
    this.windP = Array.from({ length: this.windN }, () => ({ p: V(), v: V(), life: 0, max: 1, len: 20 }));
    this.windMode = null; this.windT = 0; this.windAcc = 0;

    // debris: stone chunks (toon) + dust puffs
    const rockGeo = new THREE.IcosahedronGeometry(1, 0);
    const rockMat = game.toon ? game.toon.material({ color: 0xe2d8c2, steps: 3 }) : new THREE.MeshLambertMaterial({ color: 0xe2d8c2 });
    this.rocksN = 90;
    this.rocks = new THREE.InstancedMesh(rockGeo, rockMat, this.rocksN);
    this.rocks.frustumCulled = false; this.rocks.count = 0; this.rocks.castShadow = false;
    group.add(this.rocks);
    this.rockP = Array.from({ length: this.rocksN }, () => ({ p: V(), v: V(), q: new THREE.Quaternion(), w: V(), s: 1, life: 0 }));
    this.puffs = [];
    for (let i = 0; i < 40; i++) {
      const m = new THREE.SpriteMaterial({ map: tex.puff, color: new THREE.Color(0.95, 0.93, 0.98), transparent: true, opacity: 0, depthWrite: false });
      const s = new THREE.Sprite(m); s.visible = false; s.frustumCulled = false; group.add(s);
      this.puffs.push({ s, p: V(), v: V(), t: 0, dur: 2, size: 10 });
    }

    // hand smears (swept surface through the fingertips over the last frames)
    this.smears = {};
    const SAMPLES = 7, F = 5;
    for (const h of ['L', 'R']) {
      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array(SAMPLES * F * 3), alpha = new Float32Array(SAMPLES * F);
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1));
      const idx = [];
      for (let s = 0; s < SAMPLES - 1; s++) for (let f = 0; f < F - 1; f++) {
        const a = s * F + f, b = a + 1, c = a + F, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
      geo.setIndex(idx);
      const mat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
        uniforms: { uColor: { value: new THREE.Color(1.0, 0.97, 0.92) } },
        vertexShader: 'attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'uniform vec3 uColor; varying float vA; void main(){ float a = vA; if (a < 0.02) discard; gl_FragColor = vec4(uColor, a * 0.55); }',
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false; mesh.visible = false; mesh.renderOrder = 5;
      group.add(mesh);
      this.smears[h] = { mesh, hist: [], SAMPLES, F, acc: 0 };
    }

    // fallback projectiles (only when game.fx is missing)
    this.shots = [];

    // ---- wave 4: scale + readability ----
    this.palmStar = { L: sprite(tex.star, GOLD.clone().multiplyScalar(3.4), 1, 0), R: sprite(tex.star, GOLD.clone().multiplyScalar(3.4), 1, 0) };
    this.palmFlashT = { L: 9, R: 9 }; this.palmFlashDur = { L: 0.5, R: 0.5 };
    this.blaze = { t: 9, dur: 0 }; this.blazeLevel = 0; this.blazeRingT = 0;
    this.tanHalf = 0.5;
    this.initMist(game, tex);
    this.initBirds(game);
  }

  // ------------------------------------------------------------------ wave 4: mist, birds, flashes
  initMist(game, tex) {
    const N = this.mistN = 200;
    const base = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index; g.setAttribute('position', base.attributes.position); g.setAttribute('uv', base.attributes.uv);
    this.mistPosA = new THREE.InstancedBufferAttribute(new Float32Array(N * 3), 3); this.mistPosA.setUsage(THREE.DynamicDrawUsage);
    this.mistDataA = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4); this.mistDataA.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('aPos', this.mistPosA); g.setAttribute('aData', this.mistDataA);
    g.instanceCount = 0;
    const au = game.atmo?.uniforms || {};
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: {
        uMap: { value: tex.mist },
        uLit: au.atmoCloudLit || { value: new THREE.Color(1, 0.97, 0.92) },
        uShade: au.atmoCloudShade || { value: new THREE.Color(0.55, 0.62, 0.8) },
      },
      vertexShader: 'attribute vec3 aPos; attribute vec4 aData; varying vec2 vUv; varying float vA; varying float vS;\n'
        + 'void main(){ vUv = uv; vA = aData.y; vS = aData.w; vec4 mv = viewMatrix * vec4(aPos, 1.0);\n'
        + ' float c = cos(aData.z), s = sin(aData.z); mv.xy += vec2(c * position.x - s * position.y, s * position.x + c * position.y) * aData.x;\n'
        + ' gl_Position = projectionMatrix * mv; }',
      fragmentShader: 'uniform sampler2D uMap; uniform vec3 uLit; uniform vec3 uShade; varying vec2 vUv; varying float vA; varying float vS;\n'
        + 'void main(){ vec4 t = texture2D(uMap, vUv); float a = t.a * vA * 2.2; if (a < 0.004) discard;\n'
        + ' vec3 col = mix(uShade, uLit * 1.05, clamp(vS * (0.35 + 0.65 * t.r), 0.0, 1.0)); gl_FragColor = vec4(col, min(a, 0.85)); }',
    });
    const m = this.mist = new THREE.Mesh(g, mat);
    m.frustumCulled = false; m.renderOrder = 3; m.name = 'titan-mist';
    this.group.add(m);
    this.mistP = Array.from({ length: N }, () => ({ p: V(), v: V(), age: 0, life: 0, size: 10, rot: 0, spin: 0, shade: 1, a: 0.5 }));
    this.mistAcc = 0; this.trailAcc = 0;
  }
  /** One mist puff (world pos / vel, size m, life s, shade 0 shadow … 1 lit, peak alpha). */
  mistAt(pos, vel, size, life, shade = 1, alpha = 0.45) {
    if (!pos || !Number.isFinite(pos.x + pos.y + pos.z)) return;
    const P = this.mistP.find((x) => x.life <= 0);
    if (!P) return;
    P.p.copy(pos); P.v.copy(vel); P.age = 0; P.life = life; P.size = size; P.rot = Math.random() * 6.283; P.spin = (Math.random() - 0.5) * 0.35;
    P.shade = shade; P.a = alpha;
  }
  /** A spray of cloud around a point (breach, unfurl). */
  mistBurst(pos, n = 10, size = 30, speedK = 1) {
    if (!pos) return;
    const d = V(), q = V(), w = V();
    for (let i = 0; i < n; i++) {
      d.set(Math.random() - 0.5, Math.random() * 0.8 + 0.15, Math.random() - 0.5).normalize();
      this.mistAt(q.copy(pos).addScaledVector(d, size * 0.45 * Math.random()), w.copy(d).multiplyScalar((7 + 15 * Math.random()) * speedK),
        size * (0.6 + 0.6 * Math.random()), 2.6 + 2 * Math.random(), 0.85 + 0.15 * Math.random(), 0.42);
    }
  }
  /** Rise: cloud streams off everything that is coming up through the deck top (it stays behind: trails down). */
  riseMist(dt, T, deck, u = 0, rate = 1) {
    if (!(dt > 0)) return;
    const vy = Math.max(0, T.body.vel.y);
    const k = clamp(vy / 35, 0.2, 1.6) * rate;
    const socks = ['head', 'shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'wristL', 'wristR', 'hipL', 'hipR', 'kneeL', 'kneeR', 'footL', 'footR',
      'wing1L', 'wing1R', 'wing2L', 'wing2R', 'wing3L', 'wing3R', 'wing4L', 'wing4R'];
    this.mistAcc += dt * 48 * k;
    const p = V(), v = V();
    let guard = 0;
    while (this.mistAcc >= 1 && guard++ < 14) {
      this.mistAcc -= 1;
      const s = T.socket(socks[Math.floor(Math.random() * socks.length)], p);
      if (!s) continue;
      const h = s.y - deck;
      if (h < -30 || h > 175) continue;                      // only what is breaking through the cloud top
      const fresh = clamp(1 - h / 175, 0, 1);
      s.x += (Math.random() - 0.5) * 14; s.z += (Math.random() - 0.5) * 14; s.y += (Math.random() - 0.5) * 8;
      v.copy(T.body.vel).multiplyScalar(0.16).add(_b.set((Math.random() - 0.5) * 9, -2 - 5 * Math.random(), (Math.random() - 0.5) * 9));
      this.mistAt(s, v, (15 + 20 * Math.random()) * (0.65 + 0.55 * fresh), 2.4 + 2.4 * Math.random(), 0.7 + 0.3 * Math.random(), 0.3 + 0.2 * fresh);
    }
  }
  /** Vapour streaming off the wingtips while the titan glides fast (pursuit) — speed + scale cue. */
  trailMist(dt, T) {
    if (!(dt > 0)) return;
    const sp = Math.hypot(T.body.vel.x, T.body.vel.z);
    if (sp < 16) return;
    this.trailAcc += dt * 22 * clamp((sp - 16) / 20, 0, 1.2);
    const p = V(), v = V();
    let guard = 0;
    while (this.trailAcc >= 1 && guard++ < 6) {
      this.trailAcc -= 1;
      const n = ['wingtipL', 'wingtipR', 'wing3L', 'wing3R', 'wing4L', 'wing4R'][Math.floor(Math.random() * 6)];
      const s = T.socket(n, p);
      if (!s) continue;
      v.copy(T.body.vel).multiplyScalar(0.08).add(_b.set((Math.random() - 0.5) * 3, -1.5, (Math.random() - 0.5) * 3));
      this.mistAt(s, v, 7 + 8 * Math.random(), 1.6 + 1.2 * Math.random(), 0.95, 0.26);
    }
  }
  updateMist(dt, cam, deck = null) {
    const P = this.mistPosA.array, D = this.mistDataA.array;
    const hasDeck = Number.isFinite(deck);
    let n = 0;
    for (const m of this.mistP) {
      if (m.life <= 0) continue;
      if (dt > 0) {
        m.age += dt;
        if (m.age >= m.life) { m.life = 0; continue; }
        m.p.addScaledVector(m.v, dt); m.v.multiplyScalar(Math.exp(-0.7 * dt)); m.rot += m.spin * dt;
      }
      const u = m.age / m.life;
      const cd = cam.position.distanceTo(m.p);
      let size = m.size * (0.55 + 0.85 * Math.sqrt(u));
      size = Math.min(size, Math.max(2, cd * this.tanHalf * 0.9));          // never a screen-filling sheet
      const env = clamp(m.age / 0.35, 0, 1) * (1 - u * u);
      // a puff that has sunk under the deck top merges with the cloud: seen through a gap (the breach hole) it would
      // read as smoke rising off the fields far below
      const sink = hasDeck ? clamp((m.p.y - (deck - 45)) / 30, 0, 1) : 1;
      const a = m.a * env * sink * clamp((cd - 3) / 45, 0.12, 1);
      P[n * 3] = m.p.x; P[n * 3 + 1] = m.p.y; P[n * 3 + 2] = m.p.z;
      D[n * 4] = size; D[n * 4 + 1] = a; D[n * 4 + 2] = m.rot; D[n * 4 + 3] = m.shade;
      n++;
    }
    this.mist.geometry.instanceCount = n;
    this.mistPosA.needsUpdate = true; this.mistDataA.needsUpdate = true;
    this.mist.visible = n > 0;
  }
  initBirds(game) {
    // a flock of large sea birds (2.4 m span) circling the titan's shoulders: tiny next to its 16 m head
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0.35, 0, 0, -0.3, 0.5, 1, -0.12, 0, 0, 0.35, -0.5, 1, -0.12, 0, 0, -0.3]), 3));
    const mat = new THREE.MeshBasicMaterial({ color: 0x2c2a3a, side: THREE.DoubleSide });
    try { game.atmo?.patch?.(mat); } catch { /* optional */ }
    this.birdN = 18;
    const b = this.birds = new THREE.InstancedMesh(g, mat, this.birdN);
    b.frustumCulled = false; b.castShadow = false; b.name = 'titan-birds'; b.count = 0;
    this.group.add(b);
    let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    this.birdP = Array.from({ length: this.birdN }, (_, i) => ({ th: rnd() * 6.283, r: 42 + rnd() * 55, y: -12 + rnd() * 42, w: (0.16 + rnd() * 0.12) * (i % 3 ? 1 : -1), ph: rnd(), f: 2.4 + rnd() * 1.2, span: 2.1 + rnd() * 0.6, p: V(), init: false }));
    this.scatterT = 99;
  }
  scatterBirds() { this.scatterT = 0; }
  updateBirds(dt, T) {
    const b = this.birds;
    if (!b) return;
    const on = T.visibleEyes && T.phase !== 'dying' && T.phase !== 'dead' && T.phase !== 'dormant';
    if (!on) { b.count = 0; return; }
    const c = T.socket('chest', _s);
    if (!c) { b.count = 0; return; }
    this.scatterT += dt;
    const sc = this.scatterT < 7 ? Math.sin(Math.PI * Math.min(1, this.scatterT / 7)) : 0;
    const want = V(), dir = V(), side = V(), up = V();
    for (let i = 0; i < this.birdN; i++) {
      const B = this.birdP[i];
      B.th += B.w * (1 + 1.4 * sc) * dt;
      B.ph = (B.ph + B.f * dt * (1 + sc)) % 1;
      const r = B.r * (1 + 1.8 * sc);
      want.set(c.x + Math.cos(B.th) * r, c.y + 16 + B.y + 18 * sc + 3 * Math.sin(B.th * 3), c.z + Math.sin(B.th) * r);
      if (!B.init || B.p.distanceTo(want) > 300) { B.p.copy(want); B.init = true; }
      dir.subVectors(want, B.p);
      B.p.lerp(want, 1 - Math.exp(-2.5 * dt));
      // forward = orbit tangent (+ the correction), banked into the circle
      dir.set(-Math.sin(B.th) * Math.sign(B.w), 0, Math.cos(B.th) * Math.sign(B.w)).addScaledVector(dir, 0.02).normalize();
      up.set(0, 1, 0);
      side.crossVectors(up, dir).normalize();
      up.crossVectors(dir, side).normalize();
      _m.makeBasis(side, up, dir);
      _q.setFromRotationMatrix(_m);
      const flap = Math.sin(B.ph * Math.PI * 2) * 0.55;
      _m.compose(B.p, _q, _a.set(B.span, flap, 1.1));
      b.setMatrixAt(i, _m);
    }
    b.count = this.birdN;
    b.instanceMatrix.needsUpdate = true;
  }
  palmFlash(h, dur = 0.5) { if (this.palmStar[h]) { this.palmFlashT[h] = 0; this.palmFlashDur[h] = dur; } }
  coreBlaze(dur = 4) { this.blaze = { t: 0, dur }; this.blazeRingT = 0; }
  /** Largest world size a camera-facing glow at `pos` may have: ≤ `frac` of the frame height. */
  capSize(pos, size, frac = 0.4) {
    const d = this.game.camera.position.distanceTo(pos);
    return Math.min(size, Math.max(1, d * this.tanHalf * 2 * frac));
  }

  // ------------------------------------------------------------------ triggers
  glint() { this.glintT = 0; }
  coreFlare(k = 1, dur = 1.5) { this.flare = { k, t: 0, dur }; }
  rune(hand, on) { const r = this.runes[hand]; if (r) { r.on = on; if (on) r.k = 0; } }
  /** The ward took a hit: a short flash of its rune. */
  wardFlash(k = 1) { if (this.ward) this.ward.flash = Math.max(this.ward.flash, k); }
  ring(pos, normal, r0, r1, dur, color = 0xffffff, alpha = 0.9, face = false) {
    const R = this.rings.find((x) => !x.m.visible) || this.rings[0];
    R.m.visible = true; R.t = 0; R.dur = dur; R.r0 = r0; R.r1 = r1; R.alpha = alpha; R.face = face;
    R.m.position.copy(pos);
    R.m.material.color.set(color);
    if (!face) R.m.quaternion.setFromUnitVectors(_a.set(0, 0, 1), _b.copy(normal).normalize());
  }
  marker(pos, dur, r = 16) {
    const M = this.markers.find((x) => !x.on) || this.markers[0];
    M.on = true; M.t = 0; M.dur = dur; M.r = r; M.g.position.copy(pos); M.g.visible = true;
  }
  windLines(mode, dur) { this.windMode = mode; this.windT = dur; }
  debris(pos, n = 20, speed = 25, size = 2.2, up = 0.5) {
    for (let i = 0; i < n; i++) {
      const R = this.rockP.find((x) => x.life <= 0);
      if (!R) break;
      R.p.copy(pos).add(_a.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(size * 3));
      R.v.set(Math.random() - 0.5, Math.random() * up + 0.2, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.4 + Math.random() * 0.8));
      R.w.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(4);
      R.q.identity(); R.s = size * (0.4 + Math.random()); R.life = 4 + Math.random() * 3;
    }
    this.dust(pos, Math.ceil(n / 4), size * 5, speed * 0.3);
  }
  dust(pos, n = 4, size = 12, speed = 6) {
    for (let i = 0; i < n; i++) {
      const P = this.puffs.find((x) => !x.s.visible);
      if (!P) break;
      P.s.visible = true; P.t = 0; P.dur = 1.8 + Math.random() * 1.6; P.size = size * (0.7 + Math.random() * 0.6);
      P.p.copy(pos).add(_a.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(size));
      P.v.set(Math.random() - 0.5, Math.random() * 0.6, Math.random() - 0.5).multiplyScalar(speed);
      P.s.material.rotation = Math.random() * Math.PI * 2;
    }
  }

  /** Wave 5 — the titan is down: fallback shots lose their damage and fizzle out, the meteor runes go out. → count */
  defuseShots() {
    let n = 0;
    for (const S of this.shots) { if (S.dead) continue; n++; S.dmg = 0; S.life = Math.min(S.life, 0.2 + 0.4 * Math.random()); }
    for (const M of this.markers) { M.on = false; M.g.visible = false; }
    return n;
  }
  /** Fallback fireball (sandbox without game.fx): glowing orb, swept hit, flash ring. */
  fallbackShot(o) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tex.glow, color: new THREE.Color(1.8, 1.2, 0.4), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, toneMapped: false }));
    s.scale.setScalar((o.radius || 5) * 3.2); s.frustumCulled = false;
    this.group.add(s);
    this.shots.push({ s, p: o.from.clone(), v: o.vel.clone(), g: o.gravity || 0, drag: o.drag || 0, r: o.radius || 5, dmg: o.damage || 10, life: o.life || 5, owner: o.owner });
  }

  // ------------------------------------------------------------------ per frame
  update(dt, realDt, T) {
    const game = this.game, cam = game.camera;
    const tick = dt > 0;
    const stepped = Math.floor(game.time.now * 12) / 12;           // shapes animate on twos (12 fps)
    this.tanHalf = Math.tan((cam.fov || 60) * Math.PI / 360);
    // core window (wave 4): the core blazes — bigger, hotter, pulsing rings — while it takes extra damage
    const B = this.blaze;
    B.t += dt;
    const bl = B.t < B.dur ? clamp(B.t / 0.25, 0, 1) * clamp((B.dur - B.t) / 0.6, 0, 1) : 0;
    this.blazeLevel = bl;
    // eyes & core
    this.glintT += dt;
    const g = this.glintT < 0.32 ? Math.sin(Math.PI * this.glintT / 0.32) : 0;
    const eyeOn = T.visibleEyes ? 1 : 0;
    // Glows sit a few metres toward the camera so the depth-tested FX pass does not bury them in the stone, and
    // fade when their side faces away (no eyes or core shining through the back of the head / body).
    const fwd = T.forwardWorld(_c);
    for (const [i, n] of [[0, 'eyeL'], [1, 'eyeR']]) {
      const p = T.socket(n, _a);
      if (!p) continue;
      const toCam = _b.subVectors(cam.position, p).normalize();
      const facing = clamp(toCam.dot(fwd) * 2 + 0.3, 0, 1);
      p.addScaledVector(toCam, 4);
      this.eyes[i].position.copy(p); this.eyeGlow[i].position.copy(p);
      this.eyes[i].material.opacity = g * eyeOn * facing;
      this.eyes[i].scale.setScalar(4 + 34 * g);
      this.eyes[i].material.rotation = 0.3 + stepped * 0.5;
      this.eyeGlow[i].material.opacity = (0.35 + 0.25 * T.glowLevel) * eyeOn * facing * (T.blink ? 0.1 : 1);
    }
    const f = this.flare;
    f.t += dt;
    const flare = f.t < f.dur ? f.k * Math.sin(Math.PI * clamp(f.t / f.dur, 0, 1)) : 0;
    const cp = T.socket('core', _a);
    if (cp) {
      const toCam = _b.subVectors(cam.position, cp).normalize();
      const facing = clamp(toCam.dot(T.forwardWorld(_s)) * 1.8 + 0.2, 0, 1);
      cp.addScaledVector(toCam, 7);
      this.core.position.copy(cp); this.coreStar.position.copy(cp); this.coreHalo.position.copy(cp);
      const breath = 0.85 + 0.15 * Math.sin(game.time.now * 0.75);
      const pulse = bl * (0.8 + 0.2 * Math.sin(game.time.now * 14));
      this.core.scale.setScalar(this.capSize(cp, (11 + 10 * flare + 12 * pulse) * (0.85 + 0.35 * T.glowLevel) * breath, 0.3));
      this.core.material.opacity = T.visibleEyes ? clamp(0.55 + 0.4 * flare + 0.25 * T.glowLevel + 0.4 * bl, 0, 1) * facing : 0;
      this.coreHalo.scale.setScalar(this.capSize(cp, (34 + 24 * flare + 22 * pulse) * (0.9 + 0.3 * T.glowLevel), 0.4));
      this.coreHalo.material.opacity = T.visibleEyes ? clamp(0.35 + 0.35 * flare + 0.3 * T.glowLevel + 0.25 * bl, 0, 1) * facing : 0;
      this.coreStar.scale.setScalar(this.capSize(cp, 26 + 40 * flare + 34 * pulse, 0.4));
      this.coreStar.material.opacity = T.visibleEyes ? clamp(0.25 + 0.6 * flare + 0.55 * bl, 0, 1) * facing : 0;
      this.coreStar.material.rotation = stepped * (0.35 + 1.4 * bl);
      if (bl > 0 && dt > 0) {
        this.blazeRingT -= dt;
        if (this.blazeRingT <= 0) { this.blazeRingT = 0.5; this.ring(cp.clone(), _b.set(0, 0, 1), 5, 30, 0.7, 0xffc850, 0.55 * facing, true); }
      }
    }
    // the "now" flash on a striking palm
    for (const h of ['L', 'R']) {
      const st = this.palmStar[h];
      this.palmFlashT[h] += dt;
      const u = this.palmFlashT[h] / this.palmFlashDur[h];
      const p = u < 1 ? T.socket('palm' + h, _a) : null;
      if (!p) { st.material.opacity = 0; continue; }
      p.addScaledVector(_b.subVectors(cam.position, p).normalize(), 6);
      const k = Math.sin(Math.PI * clamp(u, 0, 1));
      st.position.copy(p);
      st.scale.setScalar(this.capSize(p, 10 + 46 * k, 0.35));
      st.material.opacity = 0.95 * k;
      st.material.rotation = 0.4 + u * 1.2;
    }
    this.coreFlareLevel = flare;

    // palm glows + runes
    for (const h of ['L', 'R']) {
      const pg = this.palm[h], ch = T.charge[h];
      const p = T.socket('palm' + h, _a);
      if (!p) continue;
      const n = T.palmNormal(h, _c);
      pg.position.copy(p).addScaledVector(n, 3);
      const k = ch ? clamp(ch.t / ch.dur, 0, 1) : 0;
      pg.material.opacity = ch ? 0.5 + 0.5 * k : 0;
      pg.scale.setScalar(6 + 20 * k * (1 + 0.08 * Math.sin(game.time.now * 30)));
      const ph = this.palmHalo[h];
      ph.position.copy(pg.position);
      ph.material.opacity = ch ? 0.35 + 0.45 * k : 0;
      ph.scale.setScalar(12 + 34 * k * (1 + 0.06 * Math.sin(game.time.now * 21 + 1)));
      const R = this.runes[h];
      R.k = clamp(R.k + (R.on ? dt * 2.2 : -dt * 3), 0, 1);
      R.g.visible = R.k > 0.01;
      if (R.g.visible) {
        const e = 1 - Math.pow(1 - R.k, 3);
        R.g.position.copy(p).addScaledVector(n, 9 + 3 * e);
        R.g.quaternion.setFromUnitVectors(_b.set(0, 0, 1), n);
        R.g.scale.setScalar(4 + 22 * e);
        R.m1.rotation.z = stepped * 0.9; R.m2.rotation.z = -stepped * 1.4;
        R.m1.material.opacity = 0.95 * R.k; R.m2.material.opacity = 0.6 * R.k;
      }
    }

    // the ward over the core (titan.js guard)
    {
      const W = this.ward, G = T.guard, cfg = T.config?.guard;
      const w = G?.hand ? clamp(G.w, 0, 1) : 0;
      W.flash = Math.max(0, W.flash - dt * 4);
      const cp = w > 0.01 ? T.socket('core', _a) : null;
      W.g.visible = !!cp;
      if (cp) {
        const e = 1 - Math.pow(1 - w, 3);
        W.g.position.copy(cp).addScaledVector(G.axis, (cfg?.dist ?? 13) + 1.5);
        W.g.quaternion.setFromUnitVectors(_b.set(0, 0, 1), G.axis);
        W.g.scale.setScalar((2 * (cfg?.radius ?? 10.5) + 5) * (0.55 + 0.45 * e) * (1 + 0.12 * W.flash));
        W.m1.rotation.z = stepped * 0.6; W.m2.rotation.z = -stepped * 1.1;
        const op = (G.on ? 1 : 0.6) * e;
        W.m1.material.opacity = clamp(0.7 * op + 0.6 * W.flash, 0, 1); W.m2.material.opacity = clamp(0.45 * op + 0.4 * W.flash, 0, 1);
      }
    }

    // rings — never full-screen: a camera-facing ring is at most 40 % of the frame height, fainter near the lens;
    // a flat ring the camera sits inside (near its plane) fades to a hint
    for (const R of this.rings) {
      if (!R.m.visible) continue;
      R.t += dt;
      const u = R.t / R.dur;
      if (u >= 1) { R.m.visible = false; continue; }
      const e = 1 - Math.pow(1 - u, 2.2);
      let r = R.r0 + (R.r1 - R.r0) * e;
      const cd = cam.position.distanceTo(R.m.position);
      let near = clamp((cd - 5) / 70, 0.35, 1);
      if (R.face) r = Math.min(r, Math.max(1, cd * this.tanHalf * 0.8));
      else {
        const nrm = _a.set(0, 0, 1).applyQuaternion(R.m.quaternion), off = _b.subVectors(cam.position, R.m.position);
        const hgt = Math.abs(off.dot(nrm)), rad = Math.sqrt(Math.max(0, off.lengthSq() - hgt * hgt));
        if (rad < r * 1.15) near = Math.min(near, clamp(hgt / 80, 0.25, 1));
      }
      R.m.scale.setScalar(2 * r);
      R.m.material.opacity = R.alpha * (1 - u) * (1 - u) * near;
      if (R.face) R.m.quaternion.copy(cam.quaternion);
    }
    // meteor markers (fill as the impact nears)
    for (const M of this.markers) {
      if (!M.on) continue;
      M.t += dt;
      const u = M.t / M.dur;
      if (u >= 1.15) { M.on = false; M.g.visible = false; continue; }
      const pop = clamp(M.t / 0.25, 0, 1);
      M.ring.scale.setScalar(M.r * 2 * (0.6 + 0.4 * pop));
      M.ring.rotation.z = stepped * 0.6;
      M.ring.material.opacity = u < 1 ? 0.85 * pop : 0.85 * (1 - (u - 1) / 0.15);
      M.fill.scale.setScalar(M.r * 2 * clamp(u, 0, 1));
      M.fill.material.opacity = 0.5 * clamp(u, 0, 1) * (u < 1 ? 1 : 0);
      M.g.quaternion.identity();
    }

    this.updateWind(dt, T);
    this.updateDebris(dt, T);
    this.updateSmears(dt, T);
    if (tick) this.updateShots(dt, T);
    // wave 4: cloud mist (rise drip for a few seconds after the emergence, wingtip vapour in pursuit), birds
    if (T.emerged && T.emergedAt != null && game.time.now - T.emergedAt < 6) this.riseMist(dt, T, T.cloudTop(), 1, 0.5 * (1 - (game.time.now - T.emergedAt) / 6));
    if (T.pursuing) this.trailMist(dt, T);
    this.updateMist(dt, cam, T.cloudTop?.());
    this.updateBirds(dt, T);
  }

  updateWind(dt, T) {
    const cam = this.game.camera;
    this.windT -= dt;
    const on = this.windT > 0 && this.windMode;
    if (on && dt > 0) {
      this.windAcc += dt * (this.windMode === 'in' ? 40 : 70);
      const chest = T.socket('chest', _c);
      const fwd = T.forwardWorld(_s);
      while (this.windAcc >= 1 && chest) {
        this.windAcc -= 1;
        const P = this.windP.find((x) => x.life <= 0);
        if (!P) break;
        // spawn in a cone in front of the titan; inward lines flow toward it, outward ones blast away
        const r = 60 + Math.random() * 220;
        const dir = _a.copy(fwd).applyAxisAngle(_b.set(0, 1, 0), (Math.random() - 0.5) * 1.3);
        dir.y += (Math.random() - 0.5) * 0.7; dir.normalize();
        if (this.windMode === 'in') { P.p.copy(chest).addScaledVector(dir, r); P.v.copy(dir).multiplyScalar(-(60 + Math.random() * 40)); }
        else { P.p.copy(chest).addScaledVector(dir, 20 + Math.random() * 60); P.v.copy(dir).multiplyScalar(110 + Math.random() * 60); }
        P.life = P.max = 0.35 + Math.random() * 0.3; P.len = 18 + Math.random() * 30;
      }
    }
    let n = 0;
    const wl = this.wind;
    for (const P of this.windP) {
      if (P.life <= 0) continue;
      P.life -= dt;
      P.p.addScaledVector(P.v, dt);
      const dir = _a.copy(P.v).normalize();
      const toCam = _b.subVectors(cam.position, P.p).normalize();
      const side = _c.crossVectors(dir, toCam).normalize();
      const nrm = _s.crossVectors(dir, side);
      _m.makeBasis(dir, side, nrm);
      _q.setFromRotationMatrix(_m);
      const a = Math.sin(Math.PI * clamp(1 - P.life / P.max, 0, 1));
      _m.compose(P.p, _q, _b.set(P.len, 1.1 + P.len * 0.02, 1));
      wl.setMatrixAt(n, _m);
      wl.instanceColor.setXYZ(n, a, a, a);
      n++;
    }
    wl.count = n;
    wl.instanceMatrix.needsUpdate = true;
    if (wl.instanceColor) wl.instanceColor.needsUpdate = true;
  }

  updateDebris(dt, T) {
    let n = 0;
    const floor = T.cloudTop();
    for (const R of this.rockP) {
      if (R.life <= 0) continue;
      R.life -= dt;
      R.v.y -= 9.81 * dt; R.v.multiplyScalar(Math.exp(-0.25 * dt));
      R.p.addScaledVector(R.v, dt);
      const wl = R.w.length();
      if (wl > 0) R.q.premultiply(_q.setFromAxisAngle(_a.copy(R.w).divideScalar(wl), wl * dt));
      if (R.p.y < floor) R.life = 0;
      _m.compose(R.p, R.q, _b.setScalar(R.s * clamp(R.life, 0, 1)));
      this.rocks.setMatrixAt(n++, _m);
    }
    this.rocks.count = n;
    this.rocks.instanceMatrix.needsUpdate = true;
    for (const P of this.puffs) {
      if (!P.s.visible) continue;
      P.t += dt;
      const u = P.t / P.dur;
      if (u >= 1) { P.s.visible = false; continue; }
      P.p.addScaledVector(P.v, dt); P.v.multiplyScalar(Math.exp(-0.8 * dt));
      P.s.position.copy(P.p);
      const cd = this.game.camera.position.distanceTo(P.p);
      P.s.scale.setScalar(Math.min(P.size * (0.6 + 0.8 * Math.sqrt(u)), Math.max(1, cd * this.tanHalf * 0.8)));
      P.s.material.opacity = 0.75 * (1 - u) * clamp(u * 8, 0, 1) * clamp((cd - 4) / 50, 0.25, 1);
    }
  }

  updateSmears(dt, T) {
    for (const h of ['L', 'R']) {
      const S = this.smears[h];
      const speed = (T.handRelSpeed || T.handSpeed)[h] || 0;          // the arm's swing, not the body rising / gliding
      const on = speed > 55 && T.visibleEyes && T.phase !== 'rising';
      if (dt <= 0) continue;
      S.acc += dt;
      if (S.acc < 1 / 30) continue;                                    // sample at 30 Hz (drawn "on twos")
      S.acc = 0;
      if (on) {
        const tips = [];
        for (const f of ['thumb', 'index', 'middle', 'ring', 'pinky']) { const p = T.socket(`tip_${f}${h}`, V()); if (p) tips.push(p); }
        if (tips.length === S.F) S.hist.unshift(tips);
      } else if (S.hist.length) S.hist.pop();
      if (S.hist.length > S.SAMPLES) S.hist.length = S.SAMPLES;
      const n = S.hist.length;
      S.mesh.visible = n >= 2;
      if (n < 2) continue;
      const pos = S.mesh.geometry.attributes.position, al = S.mesh.geometry.attributes.alpha;
      for (let s = 0; s < S.SAMPLES; s++) {
        const row = S.hist[Math.min(s, n - 1)];
        for (let f = 0; f < S.F; f++) {
          const p = row[f];
          pos.setXYZ(s * S.F + f, p.x, p.y, p.z);
          const edge = f === 0 || f === S.F - 1 ? 0.5 : 1;
          al.setX(s * S.F + f, s < n ? (1 - s / (S.SAMPLES - 1)) * edge : 0);
        }
      }
      pos.needsUpdate = true; al.needsUpdate = true;
    }
  }

  updateShots(dt, T) {
    const combat = this.game.combat;
    for (const S of this.shots) {
      if (S.dead) continue;
      S.life -= dt;
      const p0 = _a.copy(S.p);
      S.v.y -= S.g * dt;
      if (S.drag) S.v.multiplyScalar(Math.max(0, 1 - S.drag * S.v.length() * dt));
      S.p.addScaledVector(S.v, dt);
      S.s.position.copy(S.p);
      const hit = combat?.sweepSphere(p0, S.p, S.r, { team: 'player' });
      if (hit || S.life <= 0) {
        if (hit && S.dmg > 0) combat.damage(hit.actor, S.dmg, { source: S.owner, point: hit.point, dir: S.v.clone().normalize(), kind: 'fireball', part: hit.shape?.part, shape: hit.shape });
        this.ring(S.p, _b.set(0, 1, 0), 2, S.r * 5, 0.5, 0xff3a2a, 1, true);
        S.dead = true; this.group.remove(S.s); S.s.material.dispose();
      }
    }
    this.shots = this.shots.filter((s) => !s.dead);
  }

  dispose() {
    this.game.scene.remove(this.group);
  }
}
