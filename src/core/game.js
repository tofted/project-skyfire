// Game core: renderer, scene, camera, the fixed-step loop and the system registry.
// Every feature lives in a "system" (see docs/ARCHITECTURE.md). The core owns no gameplay.
import * as THREE from 'three';
import { Events } from './events.js';
import { QUALITY, pickQuality } from './quality.js';

export const FIXED_HZ = 120;          // physics / AI / combat rate
const FIXED_DT = 1 / FIXED_HZ;
const MAX_SUBSTEPS = 10;              // spiral-of-death guard (≈ 12 fps floor before slowing time)

export class Game {
  constructor(canvas, params = new URLSearchParams(location.search)) {
    this.params = params;
    this.canvas = canvas;
    this.events = new Events();
    this.debugMode = params.has('debug');
    this.quality = pickQuality(params.get('quality'));

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, alpha: false, stencil: false,
      powerPreference: 'high-performance', preserveDrawingBuffer: params.has('capture'),
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;   // the render pipeline tone-maps in its composite pass
    this.renderer.shadowMap.enabled = this.quality.shadows > 0;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;   // r186 removed PCFSoftShadowMap
    this.renderer.info.autoReset = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.5, 60000);
    this.camera.position.set(0, 1400, 40);
    this.scene.add(this.camera);

    // Shared state that systems fill in (documented in ARCHITECTURE.md).
    this.state = 'loading';           // loading | title | play | paused | photo | victory | defeat
    this.actors = [];                 // every combatant (dragons, titan) — see Actor contract
    this.player = null;               // the player's dragon actor
    this.world = {                    // filled by world systems
      seaLevel: 0,
      heightAt: () => 0,              // terrain height (m) at x,z
      cloudDensity: () => 0,          // CPU approximation of cloud density 0..1 at x,y,z
      bounds: { radius: 9000, floor: 40, ceiling: 4200 },
    };
    this.time = { now: 0, dt: 0, frame: 0, fixedFrame: 0, scale: 1, hitstop: 0, real: 0 };
    this.stats = { fps: 0, frameMs: 0, cpuMs: 0, drawCalls: 0, triangles: 0 };

    this.systems = [];
    this._acc = 0;
    this._last = 0;
    this._fpsAcc = 0; this._fpsN = 0;
    this._running = false;

    this.resize = this.resize.bind(this);
    window.addEventListener('resize', this.resize);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'play') this.setState('paused');
    });
    this.resize();
  }

  /** Register a system. order: lower runs first in every phase. */
  add(system, order = 100) {
    system.order = order;
    this.systems.push(system);
    this.systems.sort((a, b) => a.order - b.order);
    this[system.name] = system;       // game.clouds, game.camera3p, … (names must be unique)
    return system;
  }

  async init(onProgress = () => {}) {
    const list = this.systems.filter((s) => s.init);
    let done = 0;
    for (const s of list) {
      const t0 = performance.now();
      try {
        await s.init(this);
      } catch (e) {
        console.error(`[init] ${s.name} failed`, e);
        this.events.emit('system:error', { name: s.name, error: e });
      }
      done++;
      onProgress(done / list.length, s.name, performance.now() - t0);
    }
    this.events.emit('ready', {});
  }

  setState(next, info = {}) {
    if (next === this.state) return;
    const prev = this.state;
    this.state = next;
    this.events.emit('state', { prev, next, ...info });
  }

  /** Freeze simulation time briefly for impact feel (real time keeps running for UI/camera shake). */
  hitstop(seconds) { this.time.hitstop = Math.max(this.time.hitstop, seconds); }

  get simulating() { return this.state === 'play' || this.state === 'title'; }

  start() {
    if (this._running) return;
    this._running = true;
    this._last = performance.now();
    const tick = (now) => {
      if (!this._running) return;
      requestAnimationFrame(tick);
      this.frame(now);
    };
    requestAnimationFrame(tick);
  }

  frame(now) {
    const t0 = performance.now();
    let realDt = Math.min(0.1, Math.max(0, (now - this._last) / 1000));
    this._last = now;
    this.time.real += realDt;

    // Hitstop and slow-motion scale simulation time only.
    let simDt = realDt * this.time.scale;
    if (this.time.hitstop > 0) { this.time.hitstop -= realDt; simDt *= 0.05; }
    if (!this.simulating) simDt = 0;

    this.input?.update();
    this.time.dt = simDt;
    this.time.now += simDt;
    this.time.frame++;

    // Fixed-step simulation.
    this._acc += simDt;
    let steps = 0;
    while (this._acc >= FIXED_DT && steps < MAX_SUBSTEPS) {
      for (const s of this.systems) if (s.fixedUpdate) s.fixedUpdate(FIXED_DT, this);
      this._acc -= FIXED_DT;
      this.time.fixedFrame++;
      steps++;
    }
    if (steps === MAX_SUBSTEPS) this._acc = 0;
    this.time.alpha = this._acc / FIXED_DT;   // interpolation factor for visuals

    // Variable-rate phases. realDt is passed too: camera/UI keep moving while paused or in hitstop.
    for (const s of this.systems) if (s.update) s.update(simDt, realDt, this);
    for (const s of this.systems) if (s.lateUpdate) s.lateUpdate(simDt, realDt, this);
    // Input edges (pressed/released) live for exactly one render frame: read them in update(), not fixedUpdate().
    this.input?.endFrame();

    this.renderer.info.reset();
    if (this.pipeline) this.pipeline.render(simDt, realDt, this);
    else this.renderer.render(this.scene, this.camera);

    // Stats (smoothed).
    const cpu = performance.now() - t0;
    this._fpsAcc += realDt; this._fpsN++;
    if (this._fpsAcc >= 0.5) {
      this.stats.fps = this._fpsN / this._fpsAcc;
      this.stats.frameMs = (this._fpsAcc / this._fpsN) * 1000;
      this._fpsAcc = 0; this._fpsN = 0;
    }
    this.stats.cpuMs = this.stats.cpuMs * 0.9 + cpu * 0.1;
    this.stats.drawCalls = this.renderer.info.render.calls;
    this.stats.triangles = this.renderer.info.render.triangles;
  }

  resize() {
    const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, this.quality.maxDpr);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.size = { w, h, dpr, pw: Math.round(w * dpr), ph: Math.round(h * dpr) };
    this.events.emit('resize', this.size);
  }

  setQuality(name) {
    if (!QUALITY[name]) return;
    const hadShadows = this.renderer.shadowMap.enabled;
    this.quality = { ...QUALITY[name], name };
    this.renderer.shadowMap.enabled = this.quality.shadows > 0;
    if (hadShadows !== this.renderer.shadowMap.enabled) {
      // Programs compiled without the shadow map would draw one frame with a shadow sampler bound to a colour
      // texture (GL_INVALID_OPERATION): recompile everything and render the shadow map before the next main pass.
      this.scene.traverse((o) => {
        const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        for (const m of ms) m.needsUpdate = true;
      });
      this.renderer.shadowMap.needsUpdate = true;
    }
    this.resize();
    this.events.emit('quality', this.quality);
  }
}
