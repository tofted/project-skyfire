// Load-time GPU bakes: tileable 3D noise (shape 128^3, detail 64^3) and the tower SDF field (one slice per draw).
import * as THREE from 'three';
import { QUAD_VS, NOISE_FS, FIELD_FS, READBACK_FS } from './shaders.js';
import { FIELD, BASE_ROUND } from './layout.js';

export function makeQuad() {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const mesh = new THREE.Mesh(geo, null);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  return {
    mesh, scene, camera,
    draw(renderer, material, target, layer = 0) {
      mesh.material = material;
      renderer.setRenderTarget(target, layer);
      renderer.render(scene, camera);
    },
  };
}

function volumeTarget(w, h, d, { format, type, wrap, filter = THREE.LinearFilter }) {
  const rt = new THREE.WebGL3DRenderTarget(w, h, d, {
    format, type, depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    minFilter: filter, magFilter: filter,
  });
  const tx = rt.texture;
  tx.wrapS = tx.wrapT = tx.wrapR = wrap;
  tx.minFilter = tx.magFilter = filter;
  tx.generateMipmaps = false;
  return rt;
}

/** kind 0 = shape, 1 = detail. Returns the WebGL3DRenderTarget (its .texture is a Data3DTexture). */
export function bakeNoise(renderer, quad, size, kind) {
  const rt = volumeTarget(size, size, size, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, wrap: THREE.RepeatWrapping });
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: QUAD_VS, fragmentShader: NOISE_FS,
    uniforms: { uLayer: { value: 0 }, uSize: { value: size }, uKind: { value: kind } },
    depthTest: false, depthWrite: false,
  });
  for (let z = 0; z < size; z++) {
    mat.uniforms.uLayer.value = (z + 0.5) / size;
    quad.draw(renderer, mat, rt, z);
  }
  mat.dispose();
  return rt;
}

/** Tower SDF: x/z log-warped (FIELD.S), slices along y. Width = x, height = z, depth = y. */
export function bakeField(renderer, quad, towers) {
  const nS = towers.reduce((a, t) => a + t.spheres.length, 0);
  const sph = new Float32Array(nS * 2 * 4);
  const tw = new Float32Array(Math.max(1, towers.length) * 3 * 4);
  let k = 0;
  towers.forEach((t, ti) => {
    const start = k;
    for (const s of t.spheres) {
      sph.set([s[0], s[1], s[2], 0], k * 4);
      sph.set([s[3], s[4], s[5], 0], (nS + k) * 4);
      k++;
    }
    const n = towers.length;
    tw.set([t.min[0], t.min[1], t.min[2], start], ti * 4);
    tw.set([t.max[0], t.max[1], t.max[2], t.spheres.length], (n + ti) * 4);
    tw.set([t.base, t.k, BASE_ROUND, 0], (2 * n + ti) * 4);
  });
  const sphTex = new THREE.DataTexture(sph, nS, 2, THREE.RGBAFormat, THREE.FloatType);
  const towTex = new THREE.DataTexture(tw, Math.max(1, towers.length), 3, THREE.RGBAFormat, THREE.FloatType);
  for (const t of [sphTex, towTex]) { t.minFilter = t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; t.needsUpdate = true; }

  const rt = volumeTarget(FIELD.nx, FIELD.nx, FIELD.ny, { format: THREE.RedFormat, type: THREE.HalfFloatType, wrap: THREE.ClampToEdgeWrapping });
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: QUAD_VS, fragmentShader: FIELD_FS,
    uniforms: {
      uSpheres: { value: sphTex }, uTowers: { value: towTex }, uTowerCount: { value: towers.length },
      uY: { value: 0 }, uWarp: { value: new THREE.Vector2(FIELD.L, FIELD.S) },
      uClamp: { value: new THREE.Vector2(FIELD.clampMin, FIELD.clampMax) },
    },
    depthTest: false, depthWrite: false,
  });
  for (let j = 0; j < FIELD.ny; j++) {
    mat.uniforms.uY.value = FIELD.yMin + ((j + 0.5) / FIELD.ny) * (FIELD.yMax - FIELD.yMin);
    quad.draw(renderer, mat, rt, j);
  }
  mat.dispose(); sphTex.dispose(); towTex.dispose();
  return rt;
}

/**
 * Wave 4: read a baked 3D noise back to the CPU as one 8-bit value per voxel, dot(rgba, weights), so the CPU twin
 * (game.world.cloudDensity) erodes with the same billows as the GPU instead of their mean. Packs 4 voxels per RGBA8
 * texel of a 1024-wide 2D target and reads it once at load (128^3 -> 2 MB). Returns { size, data: Uint8Array,
 * mean } where voxel (x, y, z) is data[x + size * (y + size * z)] and x, y, z follow the texture's s, t, r axes.
 */
export function readNoise(renderer, quad, tex3d, size, weights) {
  const n = size * size * size, W = 1024, H = Math.ceil(n / 4 / W);
  const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false });
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: QUAD_VS, fragmentShader: READBACK_FS,
    uniforms: { uTex: { value: tex3d }, uSize: { value: size }, uW: { value: new THREE.Vector4(...weights) }, uWidth: { value: W } },
    depthTest: false, depthWrite: false,
  });
  quad.draw(renderer, mat, rt);
  const buf = new Uint8Array(W * H * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
  mat.dispose(); rt.dispose();
  const data = buf.subarray(0, n);
  let sum = 0;
  for (let i = 0; i < n; i += 7) sum += data[i];
  return { size, data, mean: sum / Math.ceil(n / 7) / 255 };
}
