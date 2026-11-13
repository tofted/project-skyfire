// Screen flash (levels and elements, fix pass — playtester rank 2: "the bolt's impact is invisible at 100–150 m"): a
// short additive flash of the whole frame, strongest at the edges (a thunderclap lighting the sky around the view), for
// Sora's lightning-bolt hits. Drawn on the pipeline's FX layer (before the bloom and the tone map, so it lifts the
// frame like light, not like a white overlay). Near-camera / readability rules: the centre of the view (the reticle and
// the target) gets only `centre` (25 %) of the edge strength, the peak is ≤ 0.3, a flash lasts ~80 ms at full and fades
// by ~0.16 s, and prefers-reduced-motion cuts it to 30 %. One draw call, only while a flash runs. Never throws.
import * as THREE from 'three';

const VERT = /* glsl */`
varying vec2 vP;
void main() { vP = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const FRAG = /* glsl */`
uniform vec3 uColor;
uniform float uAmt, uCentre, uAspect;
varying vec2 vP;
void main() {
  vec2 q = vP * vec2(min(uAspect, 2.0) * 0.62, 1.0);
  float e = smoothstep(0.3, 1.25, length(q));             // 0 in the middle of the view, 1 at the corners
  gl_FragColor = vec4(uColor * uAmt * mix(uCentre, 1.0, e), 0.0);   // premultiplied additive
}
`;

export function createScreenFlash(game) {
  const uColor = { value: new THREE.Vector3(0.4, 0.85, 1.0) }, uAmt = { value: 0 };
  const uCentre = { value: 0.25 }, uAspect = { value: 16 / 9 };
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));   // one screen triangle
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uColor, uAmt, uCentre, uAspect }, vertexShader: VERT, fragmentShader: FRAG,
    transparent: true, depthWrite: false, depthTest: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
  });
  mat.toneMapped = false;
  mat.userData.fx = true;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'fx-screenflash';
  mesh.frustumCulled = false;
  mesh.renderOrder = 90;
  mesh.matrixAutoUpdate = false;
  mesh.visible = false;
  game.scene.add(mesh);
  const reduced = typeof matchMedia === 'function' && (() => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } })();
  let t0 = -1e9, amt = 0, hold = 0.08, fade = 0.08, count = 0;
  let warm = 3;          // the first frames draw it (at 0) so its program compiles at boot, not at the first thunderclap
  const col = new THREE.Vector3();
  const api = {
    mesh,
    get count() { return count; },
    get active() { return mesh.visible; },
    /** o: { amount (peak at the edges, ≤ 0.3), color (THREE.Color | Vector3, linear), hold (s at full, 0.08), fade (s, 0.08), centre } */
    flash(o = {}) {
      try {
        const now = game.time.now;
        const a = Math.min(0.3, Math.max(0, +o.amount || 0.2)) * (reduced ? 0.3 : 1);
        // a new flash while one runs keeps the stronger one (no stacking into a white screen)
        const cur = api.level(now);
        if (a <= cur) return false;
        t0 = now; amt = a; hold = o.hold ?? 0.08; fade = o.fade ?? 0.08;
        if (o.color) col.set(o.color.r ?? o.color.x ?? 0.4, o.color.g ?? o.color.y ?? 0.85, o.color.b ?? o.color.z ?? 1.0);
        else col.set(0.4, 0.85, 1.0);
        uColor.value.copy(col);
        uCentre.value = o.centre ?? 0.25;
        count++;
        return true;
      } catch { return false; }
    },
    level(now = game.time.now) {
      const t = now - t0;
      if (t < 0 || t > hold + fade) return 0;
      return t <= hold ? amt : amt * Math.pow(1 - (t - hold) / Math.max(1e-3, fade), 2);
    },
    update() {
      try {
        const v = api.level();
        uAmt.value = v;
        const el = game.renderer?.domElement;
        if (el?.clientHeight) uAspect.value = el.clientWidth / el.clientHeight;
        mesh.visible = v > 0.002 || warm > 0;
        if (warm > 0) warm--;
      } catch { mesh.visible = false; }
    },
    clear() { t0 = -1e9; mesh.visible = false; },
  };
  return api;
}
