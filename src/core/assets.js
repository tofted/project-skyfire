// GLB loading with caching. load(name) resolves skyfire/assets/models/<name>.glb once; instance(name) returns a
// skeleton-safe clone (SkeletonUtils.clone) so several dragons can share one download.
// Missing files resolve to null (callers must keep a procedural fallback), they never throw.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
const cache = new Map();
const BASE = new URL('../../assets/models/', import.meta.url);

/**
 * Bytes of a binary asset. Static hosts that serve only web file types (e.g. a claude.ai Artifact) get the binaries as
 * base64 text: the web build (tools/web/build_web.py) sets globalThis.SKYFIRE_B64 and ships <file>.b64.txt instead.
 */
export async function fetchBytes(url) {
  if (globalThis.SKYFIRE_B64) {
    const res = await fetch(`${url}.b64.txt`);
    if (!res.ok) throw new Error(`${url}.b64.txt: HTTP ${res.status}`);
    const bin = atob((await res.text()).trim());
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export function loadGLB(name) {
  if (!cache.has(name)) {
    const url = new URL(`${name}.glb`, BASE).href;
    const load = fetchBytes(url).then((b) => loader.parseAsync(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), BASE.href));
    cache.set(name, load.catch((e) => {
      console.warn(`[assets] ${name}.glb not available (${e?.message || e}); using fallback`);
      return null;
    }));
  }
  return cache.get(name);
}

/** Returns { scene, animations, bones: Map<name, Bone>, skinned: SkinnedMesh[] } or null. */
export async function instanceGLB(name) {
  const gltf = await loadGLB(name);
  if (!gltf) return null;
  const scene = cloneSkinned(gltf.scene);
  const bones = new Map();
  const skinned = [];
  scene.traverse((o) => {
    if (o.isBone) bones.set(o.name, o);
    if (o.isSkinnedMesh) skinned.push(o);
  });
  return { scene, animations: gltf.animations, bones, skinned, userData: gltf.userData || {} };
}
