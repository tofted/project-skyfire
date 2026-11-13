// CDLOD (Strugar 2010) node selection over a square quadtree. The GPU morphs vertices in the outer 1/3 of each LOD
// range onto the next coarser grid, so neighbouring nodes of different LOD meet without cracks or popping.
// Output per frame: node lists for two instanced grid meshes (full G×G nodes, and G/2×G/2 quarter patches drawn
// at their parent's LOD where a child fell out of its own range).
import * as THREE from 'three';

const _box = new THREE.Box3();

export class CDLOD {
  /**
   * @param {object} o
   *  rootSize  world size of the root node (m), centred on the origin
   *  leafSize  size of the finest node (m)
   *  grid      quads per node side (G)
   *  lodRatio  range of LOD 0 in leaf sizes (quality knob)
   *  boundsY   (x0, z0, x1, z1, out) -> [minY, maxY]
   *  maxNodes  capacity per list
   */
  constructor({ rootSize = 131072, leafSize = 64, grid = 32, lodRatio = 2.4, boundsY, maxNodes = 2048, morphStart = 0.66 }) {
    this.rootSize = rootSize; this.leafSize = leafSize; this.grid = grid; this.boundsY = boundsY;
    this.levels = Math.round(Math.log2(rootSize / leafSize));      // root level index
    this.maxNodes = maxNodes;
    this.ranges = new Float32Array(this.levels + 1);
    this.morph = new Float32Array((this.levels + 1) * 2);           // (start, 1/(end-start)) per level
    this.setLodRatio(lodRatio, morphStart);
    this.full = new Float32Array(maxNodes * 4); this.nFull = 0;
    this.half = new Float32Array(maxNodes * 4); this.nHalf = 0;
    this._y = [0, 0];
    this._cam = new THREE.Vector3();
    this.visited = 0;
  }

  setLodRatio(lodRatio, morphStart = 0.66) {
    let prev = 0;
    for (let l = 0; l <= this.levels; l++) {
      const r = this.leafSize * lodRatio * Math.pow(2, l);
      this.ranges[l] = r;
      const start = prev + (r - prev) * morphStart;
      this.morph[l * 2] = start;
      this.morph[l * 2 + 1] = 1 / Math.max(1e-3, r - start);
      prev = r;
    }
  }

  select(camPos, frustum) {
    this._cam.copy(camPos);
    this.nFull = 0; this.nHalf = 0; this.visited = 0;
    const s = this.rootSize, h = s / 2;
    this._node(-h, -h, s, this.levels, frustum);
  }

  _bounds(x0, z0, size) {
    this.boundsY(x0, z0, x0 + size, z0 + size, this._y);
    _box.min.set(x0, this._y[0] - 1, z0);
    _box.max.set(x0 + size, this._y[1] + 1, z0 + size);
    return _box;
  }

  _sphere(r) {
    // sphere (camera, r) vs _box
    const c = this._cam;
    const dx = Math.max(_box.min.x - c.x, 0, c.x - _box.max.x);
    const dy = Math.max(_box.min.y - c.y, 0, c.y - _box.max.y);
    const dz = Math.max(_box.min.z - c.z, 0, c.z - _box.max.z);
    return dx * dx + dy * dy + dz * dz <= r * r;
  }

  _push(list, x0, z0, size, lvl) {
    if (list === 0) {
      if (this.nFull >= this.maxNodes) return;
      const k = this.nFull++ * 4; this.full[k] = x0; this.full[k + 1] = z0; this.full[k + 2] = size; this.full[k + 3] = lvl;
    } else {
      if (this.nHalf >= this.maxNodes) return;
      const k = this.nHalf++ * 4; this.half[k] = x0; this.half[k + 1] = z0; this.half[k + 2] = size; this.half[k + 3] = lvl;
    }
  }

  _node(x0, z0, size, lvl, frustum) {
    this.visited++;
    this._bounds(x0, z0, size);
    if (!this._sphere(this.ranges[lvl])) return false;
    if (frustum && !frustum.intersectsBox(_box)) return true;
    if (lvl === 0 || !this._sphere(this.ranges[lvl - 1])) { this._push(0, x0, z0, size, lvl); return true; }
    const h = size / 2;
    for (let q = 0; q < 4; q++) {
      const cx = x0 + (q & 1) * h, cz = z0 + (q >> 1) * h;
      if (!this._node(cx, cz, h, lvl - 1, frustum)) {
        // child out of its own range: draw that quarter at this node's LOD
        this._bounds(cx, cz, h);
        if (!frustum || frustum.intersectsBox(_box)) this._push(1, cx, cz, h, lvl);
      }
    }
    return true;
  }
}

/** Unit grid in XZ (0..1) with n×n quads, CCW seen from +Y. */
export function gridGeometry(n) {
  const g = new THREE.InstancedBufferGeometry();
  const pos = new Float32Array((n + 1) * (n + 1) * 3);
  let k = 0;
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) { pos[k++] = i / n; pos[k++] = 0; pos[k++] = j / n; }
  const idx = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * (n + 1) + i, b = a + n + 1;
    // one diagonal direction everywhere: fully morphed quads collapse exactly onto the coarser grid's triangles
    idx.push(a, b, b + 1, a, b + 1, a + 1);
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}
