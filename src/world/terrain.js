// game.terrain — the valley (painted map, 16 km) inside a procedural 48 km world: ranges to the west, north and
// south, a coastal range and the sea to the east. GPU CDLOD (one quadtree, two instanced grid meshes, 2 draw calls),
// heights sampled in the vertex shader from the baked grids (src/world/terrain/data.js), anime-painted shading.
// Fills game.world.heightAt(x, z), game.world.seaLevel and extras (waterLevelAt, surfaceAt, data).
// Public (for water / vegetation / other owners):
//   terrain.data                    world data (textures, CPU samplers, world.json info)
//   terrain.lod                     CDLOD selection (lists of nodes for this frame's camera)
//   terrain.ensureSelection(camera) select nodes for the main camera once per frame (late system 'terrainLod', order 98)
//   terrain.selectHooks             push fn(lod, camera): runs right after each selection (same frame, final camera)
//   terrain.uniforms                shared uniforms (world textures, wind, time) to spread into ShaderMaterials
//   terrain.wind                    Vector2, wind vector (m/s) shared by grass sheen, trees, water, petals
//   terrain.stats                   { nodes, visited, tris }
//   terrain.horizon                 { mesh, material }: the horizon apron (wave 5), uniforms uHorizon / uFarLand / uFarSea
//                                   in terrain.uniforms (shared with the water)
import * as THREE from 'three';
import { loadWorldData, assetUrl } from './terrain/data.js';
import { CDLOD, gridGeometry } from './terrain/cdlod.js';
import { TERRAIN_VS, terrainFS, NO_SHADOW_CHUNK, FAKE_SHADOW_CHUNK, HORIZON_VS, horizonFS } from './terrain/shaders.js';
import { buildMistFloor, mistUniforms } from './terrain/mist.js';

// Wave 4 low-altitude look (painterly near range, valley mist, planar water reflections, bank vegetation).
// ?world4=0 restores the wave-2 look for A/B comparisons (render-only switch, read by terrain, water and vegetation).
export const WAVE4 = (() => { try { return !/[?&]world4=0\b/.test(location.search); } catch { return true; } })();

export default function createTerrain(game) {
  const wind = new THREE.Vector2(4.5, 2.2);           // m/s, from the WSW: matches a gentle afternoon breeze
  const terrain = {
    name: 'terrain',
    data: null, lod: null, uniforms: null, wind, material: null,
    stats: { nodes: 0, visited: 0, tris: 0 },
    meshes: [],
    ready: false,
    _frame: -1,
    ensureSelection,
    selectHooks: [],                 // fn(lod, camera) after each selection (water filters its nodes, vegetation its tiles)
  };
  const frustum = new THREE.Frustum();
  const projScreen = new THREE.Matrix4();

  function ensureSelection(camera) {
    if (!terrain.lod) return;
    if (camera !== game.camera) return;                  // shadow / probe cameras reuse the main selection
    const f = game.time.frame;
    if (f === terrain._frame) return;
    terrain._frame = f;
    camera.updateMatrixWorld();
    projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreen);
    terrain.lod.select(camera.position, frustum);
    const lod = terrain.lod;
    const [mFull, mHalf] = terrain.meshes;
    upload(mFull.geometry, lod.full, lod.nFull);
    upload(mHalf.geometry, lod.half, lod.nHalf);
    const G = lod.grid;
    terrain.stats.nodes = lod.nFull + lod.nHalf;
    terrain.stats.visited = lod.visited;
    terrain.stats.tris = lod.nFull * G * G * 2 + lod.nHalf * (G / 2) * (G / 2) * 2;
    for (const fn of terrain.selectHooks) { try { fn(lod, camera); } catch (e) { console.error('[terrain] select hook', e); } }
  }

  function upload(geo, src, n) {
    const attr = geo.getAttribute('aNode');
    attr.array.set(src.subarray(0, n * 4));
    attr.clearUpdateRanges(); attr.addUpdateRange(0, Math.max(4, n * 4));
    attr.needsUpdate = true;
    geo.instanceCount = n;
  }

  terrain.init = async () => {
    const data = await loadWorldData();
    terrain.data = data;
    const q = game.quality || {};
    const G = 32;
    const lodRatio = 2.6 * (q.terrainLod ?? 1);
    // Wave 5: root ±131 km (was ±65.5 km), so the root edge is always beyond the far fade (52 km) even from the world
    // border; nodes past the 60 km far plane are culled by the frustum, so nothing more is drawn from inside the map
    const lod = new CDLOD({ rootSize: 262144, leafSize: 64, grid: G, lodRatio, boundsY: data.boundsY, maxNodes: 1536 });
    terrain.lod = lod;

    // game.world contract
    game.world.heightAt = data.heightAt;
    game.world.seaLevel = 0;
    game.world.waterLevelAt = data.waterLevelAt;
    game.world.surfaceAt = (x, z) => Math.max(data.heightAt(x, z), data.waterLevelAt(x, z));
    game.world.terrain = terrain;
    game.world.info = data.info;

    // textures
    const loader = new THREE.TextureLoader();
    const load = (name, srgb, aniso = 8) => new Promise((res) => {
      loader.load(assetUrl(name), (t) => {
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
        t.anisotropy = Math.min(aniso, game.renderer.capabilities.getMaxAnisotropy());
        t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
        t.generateMipmaps = true;
        t.flipY = false;                                   // row 0 = north (-z), like the data grids
        res(t);
      }, undefined, () => { console.warn('[terrain] missing', name); res(null); });
    });
    const [albedo, maskA, maskB, flowOut, flowIn, detail] = await Promise.all([
      load('valley_albedo.jpg', true), load('valley_masks_a.png', false), load('valley_masks_b.png', false),
      load('outer_flow.png', false), load('valley_flow.png', false), load('detail_atlas.jpg', true, 2)]);
    const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); blank.needsUpdate = true;
    const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); white.needsUpdate = true;
    terrain.textures = { albedo, maskA, maskB, flowOut, flowIn };

    const atmoU = game.atmo ? game.atmo.uniforms : {};
    const shadow = game.clouds?.shadow;
    const shadowChunk = shadow?.chunk ? shadow.chunk : (game.clouds ? NO_SHADOW_CHUNK : FAKE_SHADOW_CHUNK);
    // valley mist floor (terrain/mist.js); the uniforms are shared by reference with water and vegetation
    let mist = null;
    try { mist = buildMistFloor(data); } catch (e) { console.warn('[terrain] mist floor failed; mist off', e); }
    const blankF = new THREE.DataTexture(new Float32Array([0]), 1, 1, THREE.RedFormat, THREE.FloatType); blankF.needsUpdate = true;
    const mistU = mistUniforms(mist ? mist.texture : blankF, data.halfOut);
    // game.atmo owns the valley mist when it has one (atmoApply integrates it for every material); this layer is the
    // world's fallback and would double it
    if (!mist || !WAVE4 || game.atmo?.uniforms?.atmoMist) mistU.uMist.value.z = 0;
    terrain.mist = { ...mist, uniforms: mistU };
    const shared = {
      ...data.uniforms,
      uTime: { value: 0 },
      uWind: { value: wind },
      uWave4: { value: WAVE4 ? 1 : 0 },
      ...mistU,
      // wave 5 horizon (terrain/shaders.js HORIZON_GLSL): fade 36 → 52 km into the far colour (the apron covers
      // what lies beyond 53.8 km view depth), ground plane y = 0, 1.15° blend into the sky at the horizon (golden
      // hour: the peach horizon sky and the blue-grey haze below meet as a gradient, not a line); far land / sea
      // colours before the haze (linear)
      uHorizon: { value: new THREE.Vector4(36000, 52000, 0, 0.02) },
      uFarLand: { value: new THREE.Vector3(0.10, 0.15, 0.09) },
      uFarSea: { value: new THREE.Vector3(0.02, 0.09, 0.19) },
    };
    terrain.uniforms = shared;
    const palette = { value: new THREE.Vector3(0.16, 0.8, 0.7) };   // shared by both LOD materials, live-tunable
    terrain.palette = palette;
    const morph = { value: Array.from({ length: 16 }, (_, l) => new THREE.Vector2(lod.morph[l * 2] ?? 1e9, lod.morph[l * 2 + 1] ?? 1)) };
    const makeMat = (grid) => new THREE.ShaderMaterial({
      name: 'terrain',
      uniforms: {
        ...atmoU, ...(shadow?.uniforms || {}), ...shared,
        uMorph: morph, uGrid: { value: grid },
        tAlbedo: { value: albedo || blank }, tMaskA: { value: maskA || blank }, tMaskB: { value: maskB || blank },
        tFlowOut: { value: flowOut || blank },
        tDetail: { value: detail || white },
        // mean linear colour of each painted tile (tools/world: measured from the generated sources)
        uDetailMean: { value: detail ? [new THREE.Vector3(0.298, 0.541, 0.166), new THREE.Vector3(0.664, 0.458, 0.065),
          new THREE.Vector3(0.740, 0.580, 0.453), new THREE.Vector3(0.850, 0.727, 0.607)] : Array.from({ length: 4 }, () => new THREE.Vector3(1, 1, 1)) },
        uShade: { value: new THREE.Vector3(0.40, 0.43, 0.62) },   // shade = albedo * uShade + uSkyFill * (0.3 + luma)
        uSkyFill: { value: new THREE.Vector3(0.008, 0.011, 0.032) },
        uLight: { value: 1.0 },
        uDebug: { value: 0 },
        uDetailOn: { value: 1 },
        uPalette: palette,
        uForceOuter: { value: 0 },
        uNearK: { value: new THREE.Vector4(650, 1500, 300, 900) },   // wave 4: tile range, map/bank range (m)
      },
      vertexShader: TERRAIN_VS,
      fragmentShader: terrainFS({ atmoChunk: game.atmo ? game.atmo.chunk : FALLBACK_ATMO, shadowChunk }),
    });
    const matFull = makeMat(G), matHalf = makeMat(G / 2);
    terrain.material = matFull;
    terrain.materials = [matFull, matHalf];

    const mk = (geo, mat, cap) => {
      geo.setAttribute('aNode', new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage));
      geo.instanceCount = 0;
      const m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false;                           // CDLOD culls per node
      m.matrixAutoUpdate = false;
      m.renderOrder = -10;                               // early: big occluder for early-z
      m.name = 'terrain';
      m.onBeforeRender = (renderer, scene, camera) => ensureSelection(camera);
      return m;
    };
    const mFull = mk(gridGeometry(G), matFull, lod.maxNodes);
    const mHalf = mk(gridGeometry(G / 2), matHalf, lod.maxNodes);
    terrain.meshes = [mFull, mHalf];
    const group = new THREE.Group(); group.name = 'terrain';
    group.add(mFull, mHalf);
    // Wave 5 horizon apron: the lower sky hemisphere (to 0.5° above the horizon) drawn right after the sky dome
    // (renderOrder 1e6), just in front of its depth (HORIZON_VS), so it covers what the dome covers — beyond the
    // terrain / sea or where no geometry is — plus the fully faded terrain past 53.8 km view depth. It paints
    // worldFarColor, the colour the far terrain and sea fade into, instead of the dome's below-horizon mist grey (the
    // straight light band at the horizon). No depth write: the pipeline and the clouds still read those pixels as sky.
    // Left out of the water's mirror pass (water.js).
    try {
      const hzMat = new THREE.ShaderMaterial({
        name: 'terrainHorizon',
        uniforms: { ...atmoU, ...shared, tFlowOut: { value: flowOut || blank } },
        vertexShader: HORIZON_VS,
        fragmentShader: horizonFS(game.atmo ? game.atmo.chunk : FALLBACK_ATMO),
        side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false,
      });
      const up = 0.0087;                                   // rad above the horizon: the chords' sag stays above 0
      const hz = new THREE.Mesh(new THREE.SphereGeometry(1000, 96, 20, 0, Math.PI * 2, Math.PI / 2 - up, Math.PI / 2 + up), hzMat);
      hz.name = 'terrainHorizon';
      hz.frustumCulled = false;
      hz.matrixAutoUpdate = false;
      hz.renderOrder = 1e6 + 1;                            // right after the sky dome
      hz.castShadow = hz.receiveShadow = false;
      hz.onBeforeRender = (r, s, camera) => {
        const e = camera.matrixWorld.elements;
        hz.matrixWorld.makeTranslation(e[12], e[13], e[14]);
      };
      group.add(hz);
      terrain.horizon = { mesh: hz, material: hzMat };
    } catch (e) { console.warn('[terrain] horizon apron failed; the sky dome shows below the horizon', e); }
    game.scene.add(group);
    terrain.group = group;
    terrain.ready = true;
    // Select once per frame with the FINAL camera (after the camera rig, before the pipeline renders): instance
    // buffers must be written before three uploads attributes (projectObject runs before any onBeforeRender).
    game.add({ name: 'terrainLod', lateUpdate: () => ensureSelection(game.camera) }, 98);
  };

  terrain.update = (dt, realDt) => {
    if (!terrain.uniforms) return;
    terrain.uniforms.uTime.value += dt || 0;
    // cloud shadow texture may be swapped by its owner (ping-pong); keep the reference current
    const sh = game.clouds?.shadow;
    if (sh?.uniforms && terrain.materials) {
      for (const m of terrain.materials) {
        if (m.uniforms.cloudShadowMap && sh.uniforms.cloudShadowMap) m.uniforms.cloudShadowMap.value = sh.uniforms.cloudShadowMap.value;
      }
    }
  };

  terrain.setLodRatio = (r) => { terrain.lod?.setLodRatio(r); const u = terrain.materials?.[0].uniforms.uMorph.value; if (u) for (let l = 0; l < 16; l++) u[l].set(terrain.lod.morph[l * 2] ?? 1e9, terrain.lod.morph[l * 2 + 1] ?? 1); };

  return terrain;
}

const FALLBACK_ATMO = /* glsl */`
uniform vec3 atmoSunDir; uniform vec3 atmoSunColor;
const vec3 atmoSurface = vec3(1.0);
vec3 atmoApply(vec3 col, vec3 p) { return col; }
vec3 atmoHazeColor(vec3 rd) { return vec3(0.6, 0.7, 0.85); }
vec3 atmoSky(vec3 d) { return vec3(0.6, 0.7, 0.85); }
vec3 atmoMistIn(vec3 d) { return vec3(0.6, 0.7, 0.85); }
float atmoMistSkyT(vec3 ro, vec3 rd) { return 1.0; }
`;
