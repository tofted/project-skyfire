// World data: heights, water levels and roughness baked by tools/world/bake_world.py, plus the runtime detail noise.
// One height function, two implementations that agree texel-for-texel:
//   CPU  heightAt(x, z)          (collision, placement)       — bilinear on the same arrays the GPU samples
//   GPU  worldHeight(p) in WORLD_GLSL (terrain vertices/normals, water, vegetation)
// H(x, z) = base(x, z) + R(x, z) * D(x, z): base/water from the inner (map, 8 m) or outer (48 km, 32 m) grid,
// R = roughness in metres (0 near water, up to ~90 m on crags), D = ridged detail noise 0..1 from a 256² tile.
import * as THREE from 'three';
import { rng } from '../../core/util.js';
import { fetchBytes } from '../../core/assets.js';

const ASSETS = new URL('../../../assets/textures/', import.meta.url);
export const assetUrl = (name) => new URL(name, ASSETS).href;

// ---------------------------------------------------------------------------------------------------------------
// Container decoding (see bake_world.py "Export"): 'SKW1', u32 header length, JSON header, arrays.
async function fetchGzip(url) {
  const buf = await fetchBytes(url);               // plain fetch, or base64 text on web-type-only hosts
  // Served as raw gzip bytes (no Content-Encoding); decompress here unless the browser already did.
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    const ds = new DecompressionStream('gzip');
    const out = await new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer();
    return new Uint8Array(out);
  }
  return buf;
}

function decodeU16Delta2D(bytes, n, min, step) {
  const N = n * n, out = new Float32Array(N);
  const lo = bytes.subarray(0, N), hi = bytes.subarray(N, 2 * N);
  const prev = new Int32Array(n);            // previous row (decoded integer values)
  for (let i = 0; i < n; i++) {
    let left = 0, upLeft = 0;
    const row = i * n;
    for (let j = 0; j < n; j++) {
      const r = lo[row + j] | (hi[row + j] << 8);
      const up = prev[j];
      const v = (r + left + up - upLeft) & 0xffff;
      upLeft = up; left = v; prev[j] = v;
      out[row + j] = min + v * step;
    }
  }
  return out;
}

function decodeU8DeltaRow(bytes, n) {
  const out = new Uint8Array(n * n);
  for (let i = 0; i < n; i++) {
    let v = 0; const row = i * n;
    for (let j = 0; j < n; j++) { v = (v + bytes[row + j]) & 0xff; out[row + j] = v; }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Sampling helpers that mirror GL_LINEAR + CLAMP_TO_EDGE (texel centres at (i + 0.5) / n).
function bilinearClamp(arr, n, stride, ch, u, v) {
  let x = u * n - 0.5, y = v * n - 0.5;
  if (x < 0) x = 0; else if (x > n - 1) x = n - 1;
  if (y < 0) y = 0; else if (y > n - 1) y = n - 1;
  let x0 = Math.floor(x), y0 = Math.floor(y);
  if (x0 > n - 2) x0 = n - 2; if (y0 > n - 2) y0 = n - 2;
  const tx = x - x0, ty = y - y0;
  const i00 = (y0 * n + x0) * stride + ch, i10 = i00 + stride, i01 = i00 + n * stride, i11 = i01 + stride;
  const a = arr[i00] + (arr[i10] - arr[i00]) * tx;
  const b = arr[i01] + (arr[i11] - arr[i01]) * tx;
  return a + (b - a) * ty;
}
// GL_LINEAR + REPEAT on a single-channel n×n tile.
function bilinearRepeat(arr, n, u, v) {
  const x = u * n - 0.5, y = v * n - 0.5;
  const fx = Math.floor(x), fy = Math.floor(y);
  const tx = x - fx, ty = y - fy;
  const m = n - 1;
  const x0 = fx & m, y0 = fy & m, x1 = (fx + 1) & m, y1 = (fy + 1) & m;
  const a = arr[y0 * n + x0] + (arr[y0 * n + x1] - arr[y0 * n + x0]) * tx;
  const b = arr[y1 * n + x0] + (arr[y1 * n + x1] - arr[y1 * n + x0]) * tx;
  return a + (b - a) * ty;
}

// Tileable value-noise tile (two octaves), deterministic. Values 0..1.
function makeNoiseTile(n = 256, seed = 9127) {
  const r = rng(seed);
  const out = new Float32Array(n * n);
  const octaves = [[16, 0.62], [32, 0.28], [64, 0.10]];
  for (const [cells, amp] of octaves) {
    const lat = new Float32Array(cells * cells);
    for (let i = 0; i < lat.length; i++) lat[i] = r();
    const s = cells / n;
    for (let y = 0; y < n; y++) {
      const gy = y * s, iy = Math.floor(gy), ty0 = gy - iy, ty = ty0 * ty0 * (3 - 2 * ty0);
      const y0 = iy % cells, y1 = (iy + 1) % cells;
      for (let x = 0; x < n; x++) {
        const gx = x * s, ix = Math.floor(gx), tx0 = gx - ix, tx = tx0 * tx0 * (3 - 2 * tx0);
        const x0 = ix % cells, x1 = (ix + 1) % cells;
        const a = lat[y0 * cells + x0] + (lat[y0 * cells + x1] - lat[y0 * cells + x0]) * tx;
        const b = lat[y1 * cells + x0] + (lat[y1 * cells + x1] - lat[y1 * cells + x0]) * tx;
        out[y * n + x] += amp * (a + (b - a) * ty);
      }
    }
  }
  // stretch to 0..1
  let lo = Infinity, hi = -Infinity;
  for (const v of out) { if (v < lo) lo = v; if (v > hi) hi = v; }
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) / (hi - lo);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Min/max mip pyramid over a grid channel, for CDLOD node bounds and "is there water here" queries.
class MinMax {
  constructor(arr, n, stride, ch, half, fnMin = (v) => v, fnMax = fnMin) {
    this.n = n; this.half = half; this.texel = (2 * half) / n;
    this.levels = [];
    let mn = new Float32Array(n * n), mx = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) { const v = arr[i * stride + ch]; mn[i] = fnMin(v, i); mx[i] = fnMax(v, i); }
    let m = n;
    this.levels.push({ n: m, mn, mx });
    while (m > 1) {
      const h = (m + 1) >> 1, nmn = new Float32Array(h * h), nmx = new Float32Array(h * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < h; x++) {
        const y0 = 2 * y, y1 = Math.min(2 * y + 1, m - 1), x0 = 2 * x, x1 = Math.min(2 * x + 1, m - 1);
        const a = y0 * m, b = y1 * m;
        nmn[y * h + x] = Math.min(mn[a + x0], mn[a + x1], mn[b + x0], mn[b + x1]);
        nmx[y * h + x] = Math.max(mx[a + x0], mx[a + x1], mx[b + x0], mx[b + x1]);
      }
      mn = nmn; mx = nmx; m = h;
      this.levels.push({ n: m, mn, mx });
    }
  }
  /** [min, max] over world rect (clamped to the grid; a rect outside maps onto the border texels). */
  query(x0, z0, x1, z1, out) {
    const n = this.n, t = this.texel, h = this.half;
    // texel index range (dilate one texel for bilinear reach)
    let i0 = Math.floor((x0 + h) / t) - 1, i1 = Math.floor((x1 + h) / t) + 1;
    let j0 = Math.floor((z0 + h) / t) - 1, j1 = Math.floor((z1 + h) / t) + 1;
    i0 = Math.min(Math.max(i0, 0), n - 1); i1 = Math.min(Math.max(i1, 0), n - 1);
    j0 = Math.min(Math.max(j0, 0), n - 1); j1 = Math.min(Math.max(j1, 0), n - 1);
    const span = Math.max(i1 - i0, j1 - j0) + 1;
    let lv = Math.max(0, Math.ceil(Math.log2(span)) - 1);
    lv = Math.min(lv, this.levels.length - 1);
    const L = this.levels[lv], s = 1 << lv;
    const a0 = i0 >> lv, a1 = i1 >> lv, b0 = j0 >> lv, b1 = j1 >> lv;
    let mn = Infinity, mx = -Infinity;
    for (let b = b0; b <= b1; b++) for (let a = a0; a <= a1; a++) {
      const k = b * L.n + a;
      if (L.mn[k] < mn) mn = L.mn[k];
      if (L.mx[k] > mx) mx = L.mx[k];
    }
    out[0] = mn; out[1] = mx;
    return out;
  }
}

// ---------------------------------------------------------------------------------------------------------------
export async function loadWorldData() {
  const [bin, info] = await Promise.all([
    fetchGzip(assetUrl('world_height.bin')),
    fetch(assetUrl('world.json')).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const magic = String.fromCharCode(bin[0], bin[1], bin[2], bin[3]);
  if (magic !== 'SKW1') throw new Error('world_height.bin: bad magic');
  const hlen = dv.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(bin.subarray(8, 8 + hlen)));
  const base = 8 + hlen;
  const arr = {};
  for (const a of header.arrays) {
    const bytes = bin.subarray(base + a.offset, base + a.offset + a.bytes);
    arr[a.name] = a.type === 'u16' ? decodeU16Delta2D(bytes, a.n, a.min, a.step) : decodeU8DeltaRow(bytes, a.n);
    arr[a.name].meta = a;
  }
  const nIn = header.inner.n, halfIn = header.inner.half, nOut = header.outer.n, halfOut = header.outer.half;
  const nRIn = arr.innerR.meta.n, nROut = arr.outerR.meta.n, rStep = arr.innerR.meta.step;

  // Interleave height + water level for RG32F textures (also the CPU copy).
  const hwIn = new Float32Array(nIn * nIn * 2), hwOut = new Float32Array(nOut * nOut * 2);
  for (let i = 0, k = 0; i < nIn * nIn; i++, k += 2) { hwIn[k] = arr.innerH[i]; hwIn[k + 1] = arr.innerW[i]; }
  for (let i = 0, k = 0; i < nOut * nOut; i++, k += 2) { hwOut[k] = arr.outerH[i]; hwOut[k + 1] = arr.outerW[i]; }
  const rIn = arr.innerR, rOut = arr.outerR;
  const noiseN = 256, noise = makeNoiseTile(noiseN);
  // noise + its gradient per uv unit (for analytic detail normals in the fragment shader)
  const noiseG = new Float32Array(noiseN * noiseN * 4);
  for (let y = 0; y < noiseN; y++) for (let x = 0; x < noiseN; x++) {
    const m = noiseN - 1, k = (y * noiseN + x) * 4;
    noiseG[k] = noise[y * noiseN + x];
    noiseG[k + 1] = (noise[y * noiseN + ((x + 1) & m)] - noise[y * noiseN + ((x - 1) & m)]) * noiseN * 0.5;
    noiseG[k + 2] = (noise[((y + 1) & m) * noiseN + x] - noise[((y - 1) & m) * noiseN + x]) * noiseN * 0.5;
  }
  // Shading normals (RGBA8, mipmapped): n.x, n.z, curvature (0.5 = flat), roughness byte (full res)
  const nrm = (hw, n, texel, rArr, rn, curvStep) => {
    const out = new Uint8Array(n * n * 4);
    const H = (i, j) => hw[((j < 0 ? 0 : j >= n ? n - 1 : j) * n + (i < 0 ? 0 : i >= n ? n - 1 : i)) * 2];
    const rs = rn / n;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const gx = (H(i + 1, j) - H(i - 1, j)) / (2 * texel), gz = (H(i, j + 1) - H(i, j - 1)) / (2 * texel);
      const il = 1 / Math.hypot(gx, 1, gz);
      const c = curvStep, h0 = H(i, j);
      const lap = (H(i + c, j) + H(i - c, j) + H(i, j + c) + H(i, j - c) - 4 * h0) / (c * texel);
      const k = (j * n + i) * 4;
      out[k] = Math.round((-gx * il * 0.5 + 0.5) * 255);
      out[k + 1] = Math.round((-gz * il * 0.5 + 0.5) * 255);
      out[k + 2] = Math.max(0, Math.min(255, Math.round((0.5 + Math.max(-1, Math.min(1, lap * 0.6)) * 0.5) * 255)));
      const ri = Math.min(rn - 1, Math.floor(i * rs)), rj = Math.min(rn - 1, Math.floor(j * rs));
      out[k + 3] = rArr[rj * rn + ri];
    }
    return out;
  };
  const nrmIn = nrm(hwIn, nIn, (2 * halfIn) / nIn, arr.innerR, nRIn, 3);
  const nrmOut = nrm(hwOut, nOut, (2 * halfOut) / nOut, arr.outerR, nROut, 1);

  const tex = (data, n, format, type, wrap = THREE.ClampToEdgeWrapping) => {
    const t = new THREE.DataTexture(data, n, n, format, type);
    t.wrapS = t.wrapT = wrap;
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearFilter;
    t.generateMipmaps = false; t.flipY = false;
    t.needsUpdate = true;
    return t;
  };
  const textures = {
    hwIn: tex(hwIn, nIn, THREE.RGFormat, THREE.FloatType),
    hwOut: tex(hwOut, nOut, THREE.RGFormat, THREE.FloatType),
    rIn: tex(rIn, nRIn, THREE.RedFormat, THREE.UnsignedByteType),
    rOut: tex(rOut, nROut, THREE.RedFormat, THREE.UnsignedByteType),
    noise: tex(noise, noiseN, THREE.RedFormat, THREE.FloatType, THREE.RepeatWrapping),
    noiseG: tex(noiseG, noiseN, THREE.RGBAFormat, THREE.FloatType, THREE.RepeatWrapping),
    nrmIn: tex(nrmIn, nIn, THREE.RGBAFormat, THREE.UnsignedByteType),
    nrmOut: tex(nrmOut, nOut, THREE.RGBAFormat, THREE.UnsignedByteType),
  };
  for (const t of [textures.nrmIn, textures.nrmOut]) {
    t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 4;
  }

  // ---- CPU mirror of WORLD_GLSL -------------------------------------------------------------------------------
  const iw = 1 / (2 * halfIn), ow = 1 / (2 * halfOut);
  const wInner = (x, z) => {
    const e = halfIn - Math.max(Math.abs(x), Math.abs(z));
    return e <= 0 ? 0 : e >= 64 ? 1 : e / 64;
  };
  const nz = (u, v) => bilinearRepeat(noise, noiseN, u, v);
  const detail = (x, z) => {
    let a = nz(x / 620 + 0.13, z / 620 + 0.71); a = 1 - Math.abs(2 * a - 1);
    let b = nz(x / 210 + 0.37, z / 210 + 0.29); b = 1 - Math.abs(2 * b - 1);
    const c = nz(x / 70 + 0.61, z / 70 + 0.05);
    return 0.55 * a + 0.3 * b + 0.15 * c;
  };
  const baseCh = (x, z, ch) => {
    const w = wInner(x, z);
    const o = bilinearClamp(hwOut, nOut, 2, ch, x * ow + 0.5, z * ow + 0.5);
    if (w <= 0) return o;
    const i = bilinearClamp(hwIn, nIn, 2, ch, x * iw + 0.5, z * iw + 0.5);
    return o + (i - o) * w;
  };
  const rough = (x, z) => {
    const w = wInner(x, z);
    const o = bilinearClamp(rOut, nROut, 1, 0, x * ow + 0.5, z * ow + 0.5) * rStep;
    if (w <= 0) return o;
    const i = bilinearClamp(rIn, nRIn, 1, 0, x * iw + 0.5, z * iw + 0.5) * rStep;
    return o + (i - o) * w;
  };
  const baseHeight = (x, z) => baseCh(x, z, 0);
  const heightAt = (x, z) => {
    const r = rough(x, z);
    return baseCh(x, z, 0) + (r > 0 ? r * detail(x, z) : 0);
  };
  const waterLevelAt = (x, z) => baseCh(x, z, 1);

  // Bounds pyramids (heights include the maximum detail: D <= 1)
  const mmHIn = new MinMax(hwIn, nIn, 2, 0, halfIn);
  const mmHOut = new MinMax(hwOut, nOut, 2, 0, halfOut);
  const mmRIn = new MinMax(rIn, nRIn, 1, 0, halfIn, (v) => v * rStep);
  const mmROut = new MinMax(rOut, nROut, 1, 0, halfOut, (v) => v * rStep);
  // "wet" = water surface above the ground somewhere in the texel neighbourhood (for water node culling)
  const wetIn = new MinMax(hwIn, nIn, 2, 1, halfIn, (w, i) => w - hwIn[i * 2]);
  const wetOut = new MinMax(hwOut, nOut, 2, 1, halfOut, (w, i) => w - hwOut[i * 2]);
  const tmp = [0, 0], tmp2 = [0, 0];
  /** Node bounds: returns [minY, maxY] over a world rect. */
  const boundsY = (x0, z0, x1, z1, out = [0, 0]) => {
    const insideAny = x1 > -halfIn && x0 < halfIn && z1 > -halfIn && z0 < halfIn;
    mmHOut.query(x0, z0, x1, z1, tmp); mmROut.query(x0, z0, x1, z1, tmp2);
    let mn = tmp[0], mx = tmp[1] + tmp2[1];
    if (insideAny) {
      mmHIn.query(Math.max(x0, -halfIn), Math.max(z0, -halfIn), Math.min(x1, halfIn), Math.min(z1, halfIn), tmp);
      mmRIn.query(Math.max(x0, -halfIn), Math.max(z0, -halfIn), Math.min(x1, halfIn), Math.min(z1, halfIn), tmp2);
      mn = Math.min(mn, tmp[0]); mx = Math.max(mx, tmp[1] + tmp2[1]);
    }
    out[0] = mn; out[1] = mx;
    return out;
  };
  /** Highest (water - ground) in a rect: > 0 means visible water somewhere. */
  const wetness = (x0, z0, x1, z1) => {
    wetOut.query(x0, z0, x1, z1, tmp);
    let w = tmp[1];
    if (x1 > -halfIn && x0 < halfIn && z1 > -halfIn && z0 < halfIn) {
      wetIn.query(Math.max(x0, -halfIn), Math.max(z0, -halfIn), Math.min(x1, halfIn), Math.min(z1, halfIn), tmp);
      // inside the map the inner grid is authoritative (the outer copy is low-passed)
      const fully = x0 >= -halfIn + 64 && x1 <= halfIn - 64 && z0 >= -halfIn + 64 && z1 <= halfIn - 64;
      w = fully ? tmp[1] : Math.max(w, tmp[1]);
    }
    return w;
  };

  return {
    header, info, textures,
    halfIn, halfOut, nIn, nOut, rStep,
    heightAt, baseHeight, waterLevelAt, rough, detail, boundsY, wetness,
    uniforms: {
      tHWIn: { value: textures.hwIn }, tHWOut: { value: textures.hwOut },
      tRIn: { value: textures.rIn }, tROut: { value: textures.rOut },
      tWNoise: { value: textures.noise },
      tWNoiseG: { value: textures.noiseG },
      tNrmIn: { value: textures.nrmIn }, tNrmOut: { value: textures.nrmOut },
      uWorldHalf: { value: new THREE.Vector4(halfIn, halfOut, 255 * rStep, 0) },
    },
    dispose() { for (const t of Object.values(textures)) t.dispose(); },
  };
}

// GLSL twin of heightAt/waterLevelAt. Needs the uniforms above. Use in vertex and fragment shaders (textureLod).
export const WORLD_GLSL = /* glsl */`
uniform sampler2D tHWIn;     // RG32F: base height, water level (map square, 8 m)
uniform sampler2D tHWOut;    // RG32F: same over 48 km (32 m)
uniform sampler2D tRIn;      // R8: roughness (metres = r * uWorldHalf.z)
uniform sampler2D tROut;
uniform sampler2D tWNoise;   // R32F 256² tile, repeat
uniform vec4 uWorldHalf;     // x inner half size, y outer half size, z roughness scale
float worldInnerW(vec2 p) { return clamp((uWorldHalf.x - max(abs(p.x), abs(p.y))) / 64.0, 0.0, 1.0); }
vec2 worldUvIn(vec2 p) { return p / (2.0 * uWorldHalf.x) + 0.5; }
vec2 worldUvOut(vec2 p) { return p / (2.0 * uWorldHalf.y) + 0.5; }
float worldNz(vec2 uv) { return textureLod(tWNoise, uv, 0.0).r; }
float worldDetail(vec2 p) {
  float a = worldNz(p / 620.0 + vec2(0.13, 0.71)); a = 1.0 - abs(2.0 * a - 1.0);
  float b = worldNz(p / 210.0 + vec2(0.37, 0.29)); b = 1.0 - abs(2.0 * b - 1.0);
  float c = worldNz(p / 70.0 + vec2(0.61, 0.05));
  return 0.55 * a + 0.3 * b + 0.15 * c;
}
vec2 worldHW(vec2 p) {
  vec2 o = textureLod(tHWOut, worldUvOut(p), 0.0).rg;
  float w = worldInnerW(p);
  if (w <= 0.0) return o;
  vec2 i = textureLod(tHWIn, worldUvIn(p), 0.0).rg;
  return mix(o, i, w);
}
float worldRough(vec2 p) {
  float o = textureLod(tROut, worldUvOut(p), 0.0).r;
  float w = worldInnerW(p);
  if (w <= 0.0) return o * uWorldHalf.z;
  float i = textureLod(tRIn, worldUvIn(p), 0.0).r;
  return mix(o, i, w) * uWorldHalf.z;
}
float worldHeight(vec2 p) { return worldHW(p).x + worldRough(p) * worldDetail(p); }
float worldWater(vec2 p) { return worldHW(p).y; }
`;

// Fragment-side shading helpers: baked base normals + analytic detail-noise gradient (cheap: ~5 fetches).
export const WORLD_SHADE_GLSL = /* glsl */`
uniform sampler2D tNrmIn;    // RGBA8 mipmapped: n.x, n.z, curvature, roughness byte
uniform sampler2D tNrmOut;
uniform sampler2D tWNoiseG;  // RGBA32F: noise, d/du, d/dv
vec4 worldNrm(vec2 p, float lodIn) {
  vec4 o = textureLod(tNrmOut, worldUvOut(p), max(lodIn - 2.0, 0.0));
  float w = worldInnerW(p);
  if (w <= 0.0) return o;
  return mix(o, textureLod(tNrmIn, worldUvIn(p), lodIn), w);
}
vec2 worldBaseGrad(vec4 t) { vec2 n = t.rg * 2.0 - 1.0; float ny = sqrt(max(1.0 - dot(n, n), 0.02)); return -n / ny; }
// (dD/dx, dD/dz) of worldDetail; 'fade' drops the small octaves with distance
vec2 worldDetailGrad(vec2 p, float fade, float bigOnly) {
  vec3 a = texture(tWNoiseG, p / 620.0 + vec2(0.13, 0.71)).rgb;
  vec2 g = -2.0 * sign(2.0 * a.x - 1.0) * a.yz / 620.0 * 0.55;
  if (bigOnly < 0.5 && fade > 0.0) {
    vec3 b = texture(tWNoiseG, p / 210.0 + vec2(0.37, 0.29)).rgb;
    vec3 c = texture(tWNoiseG, p / 70.0 + vec2(0.61, 0.05)).rgb;
    g += (-2.0 * sign(2.0 * b.x - 1.0) * b.yz / 210.0 * 0.3 + c.yz / 70.0 * 0.15) * fade;
  }
  return g;
}
`;
