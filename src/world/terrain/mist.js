// Valley mist (wave 4): a thin exponential height-fog layer that sits on the valley FLOOR, not on sea level.
// The floor F(x, z) is the terrain's local minimum over ~0.5 km, low-passed (baked on the CPU at load into a 256² float
// texture over the whole 48 km world). Density rho(y) = uMist.x · exp(−(y − F) / uMist.y): basins, river valleys and the
// coastal plain collect a soft blue-white haze, ridges and slopes stay clear. It is integrated analytically along the
// view ray (camera → fragment) with F taken at the fragment, and applied BEFORE game.atmo's aerial perspective.
// World materials (terrain, water, trees, houses) use it; characters are near the camera, where the integral is ~0.
//   MIST_GLSL: uniforms tMistFloor, uMist (x density 1/m at the floor, y scale height m, z strength, w world half size),
//              vec3 worldMist(vec3 col, vec3 p). Needs game.atmo's chunk first (atmoHazeColor, atmoSunDir).
import * as THREE from 'three';

export const MIST_GLSL = /* glsl */`
uniform sampler2D tMistFloor;
uniform vec4 uMist;
uniform vec3 uMistTint;
float worldMistFloor(vec2 p) { return texture(tMistFloor, p / (2.0 * uMist.w) + 0.5).r; }
// optical depth of the mist between the camera and p
float worldMistDepth(vec3 p) {
  if (uMist.z <= 0.0) return 0.0;
  float F = worldMistFloor(p.xz);
  vec3 ro = cameraPosition;
  float dist = length(p - ro);
  float H = uMist.y;
  float h0 = max(ro.y - F, 0.0), h1 = max(p.y - F, 0.0);
  float dy = h1 - h0;
  float I = abs(dy) > 0.05 * H ? H * dist / dy * (exp(-h0 / H) - exp(-h1 / H)) : exp(-0.5 * (h0 + h1) / H) * dist;
  return uMist.x * max(I, 0.0) * uMist.z;
}
vec3 worldMist(vec3 col, vec3 p) {
  float od = worldMistDepth(p);
  if (od <= 1e-4) return col;
  vec3 rd = normalize(p - cameraPosition);
  // brighter and whiter than the aerial haze (sunlit droplets), warm toward the sun
  vec3 hz = atmoHazeColor(rd);
  float l = dot(hz, vec3(0.2126, 0.7152, 0.0722));
  vec3 mc = mix(hz, vec3(l) * uMistTint, 0.45) * 1.12;
  return mix(mc, col, exp(-od));
}
`;

/** Bake the mist floor: per 187.5 m cell the minimum terrain height, spread (min filter) over ~0.4 km, then blurred. */
export function buildMistFloor(data, n = 256) {
  const half = data.halfOut, cell = (2 * half) / n;
  const raw = new Float32Array(n * n);
  const s = 3;                                               // 3×3 height samples per cell
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let m = Infinity;
    for (let b = 0; b < s; b++) for (let a = 0; a < s; a++) {
      const x = -half + (i + (a + 0.5) / s) * cell, z = -half + (j + (b + 0.5) / s) * cell;
      const h = Math.max(data.baseHeight(x, z), data.waterLevelAt(x, z));
      if (h < m) m = h;
    }
    raw[j * n + i] = Math.max(m, 0);
  }
  // min filter (radius 2 cells), then a separable box blur ×2 (radius 2): a smooth floor that hugs the valley bottoms
  const mn = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let m = Infinity;
    for (let b = -2; b <= 2; b++) for (let a = -2; a <= 2; a++) {
      const ii = Math.min(n - 1, Math.max(0, i + a)), jj = Math.min(n - 1, Math.max(0, j + b));
      const v = raw[jj * n + ii]; if (v < m) m = v;
    }
    mn[j * n + i] = m;
  }
  const blur = (src) => {
    const t = new Float32Array(n * n), o = new Float32Array(n * n), r = 2;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      let acc = 0, c = 0;
      for (let a = -r; a <= r; a++) { const ii = Math.min(n - 1, Math.max(0, i + a)); acc += src[j * n + ii]; c++; }
      t[j * n + i] = acc / c;
    }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      let acc = 0, c = 0;
      for (let b = -r; b <= r; b++) { const jj = Math.min(n - 1, Math.max(0, j + b)); acc += t[jj * n + i]; c++; }
      o[j * n + i] = acc / c;
    }
    return o;
  };
  const floor = blur(blur(mn));
  const tex = new THREE.DataTexture(floor, n, n, THREE.RedFormat, THREE.FloatType);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false; tex.flipY = false; tex.needsUpdate = true;
  return { texture: tex, data: floor, n, half };
}

/** Shared mist uniforms (the terrain owns them; water and vegetation spread the same objects). */
export function mistUniforms(floorTex, half) {
  return {
    tMistFloor: { value: floorTex },
    // density at the floor, scale height, strength (0 = off), world half size
    uMist: { value: new THREE.Vector4(1.6e-4, 55, 1, half) },
    uMistTint: { value: new THREE.Vector3(1.0, 1.0, 1.05) },
  };
}
