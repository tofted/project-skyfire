// Drifting cherry petals: a camera-local wrap volume (GPU-only motion, no CPU per-petal work). Density follows the
// cherry mask around the camera and fades out with height above the ground, so petals appear when you skim the
// groves and the riverbanks and never over pine mountains.
import * as THREE from 'three';
import { clamp, smoothstep, damp, rng } from '../../core/util.js';
import { lin } from './common.js';

const VS = /* glsl */`
attribute vec4 aSeed;        // xyz 0..1 position in the box, w phase
uniform vec3 uCam;
uniform float uBox;
uniform float uTime;
uniform vec2 uWind;
uniform float uAmount;
varying vec2 vUv;
varying float vShade;
varying vec3 vW;
void main() {
  float t = uTime;
  vec3 drift = vec3(uWind.x * 0.8, -0.9, uWind.y * 0.8) * t;
  vec3 local = mod(aSeed.xyz * uBox + drift - uCam + uBox * 0.5, uBox) - uBox * 0.5;   // wraps around the camera
  float ph = aSeed.w * 6.2831;
  local.x += sin(t * 1.3 + ph) * 0.9;
  local.z += cos(t * 1.1 + ph * 1.7) * 0.9;
  vec3 center = uCam + local;
  // spin: flutter around a per-petal axis
  float a = t * (2.0 + aSeed.w * 3.0) + ph;
  vec3 ax = normalize(vec3(sin(ph), 0.6, cos(ph * 1.3)));
  vec3 side = normalize(cross(ax, vec3(0.0, 1.0, 0.0)) + 1e-3);
  vec3 up = cross(side, ax);
  vec3 u = side * cos(a) + up * sin(a);
  vec3 v = cross(ax, u);
  float keep = step(aSeed.w, uAmount);
  float fadeEdge = 1.0 - smoothstep(0.35, 0.5, max(max(abs(local.x), abs(local.y)), abs(local.z)) / uBox);
  // petals right at the lens (the chase camera rides 10-20 m behind the dragon) would fill the frame as pink blobs:
  // they shrink away inside a few metres of the camera
  float nearFade = smoothstep(2.5, 7.0, length(local));
  float size = 0.16 * keep * fadeEdge * nearFade;
  vec3 wp = center + (u * position.x + v * position.y) * size;
  vUv = position.xy;
  vShade = 0.75 + 0.25 * abs(dot(normalize(cross(u, v)), vec3(0.0, 1.0, 0.0)));
  vW = wp;
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;
const FS = (atmoChunk) => /* glsl */`
uniform vec3 uColA, uColB;
varying vec2 vUv;
varying float vShade;
varying vec3 vW;
${atmoChunk}
void main() {
  // petal shape: rounded with a notch
  vec2 p = vUv * 2.0;
  float d = length(p * vec2(1.0, 0.7));
  float notch = smoothstep(0.14, 0.0, length(p - vec2(0.0, 0.66)));
  if (d > 0.66 || notch > 0.5) discard;
  vec3 c = mix(uColB, uColA, smoothstep(0.62, 0.1, d)) * vShade;
  vec3 sun = atmoSunColor;
  vec3 col = c * (sun * 0.24 + vec3(0.35, 0.33, 0.45));
  col = atmoApply(col, vW);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createPetals(game, { masks, data, sampleMask }) {
  const q = game.quality?.particles ?? 1;
  const N = Math.round(5000 * q);
  const quad = new THREE.PlaneGeometry(1, 1);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', quad.getAttribute('position'));
  g.setIndex(quad.getIndex());
  const seeds = new Float32Array(N * 4);
  const r = rng(0x9e7a1);
  for (let i = 0; i < N * 4; i++) seeds[i] = r();
  g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
  g.instanceCount = N;
  const tu = game.terrain.uniforms;
  const uniforms = {
    ...game.atmo.uniforms,
    uCam: { value: new THREE.Vector3() }, uBox: { value: 120 }, uTime: tu.uTime, uWind: tu.uWind,
    uAmount: { value: 0 }, uColA: { value: lin(0xffe9f0) }, uColB: { value: lin(0xf29abb) },
  };
  const mat = new THREE.ShaderMaterial({ name: 'petals', uniforms, vertexShader: VS, fragmentShader: FS(game.atmo.chunk), side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false; mesh.name = 'petals';
  let amount = 0;
  const cam = game.camera;
  return {
    mesh,
    update(dt, realDt) {
      const p = cam.position;
      uniforms.uCam.value.copy(p);
      // cherry density in a ~250 m neighbourhood, fading with height above ground
      let c = 0;
      for (const [ox, oz] of [[0, 0], [150, 0], [-150, 0], [0, 150], [0, -150]]) c = Math.max(c, sampleMask(masks.b, p.x + ox, p.z + oz, 1));
      const agl = p.y - data.heightAt(p.x, p.z);
      const target = clamp(c * 2.2, 0.08, 1) * (1 - smoothstep(60, 220, agl));
      amount += (target - amount) * damp(1.5, realDt || 0.016);
      uniforms.uAmount.value = amount;
      mesh.visible = amount > 0.01;
    },
  };
}
