// Quality presets. Systems read game.quality.<key>; add keys here rather than inventing local presets.
//
// Two ways to run:
//   a fixed preset   low | medium | high | ultra (Settings, ?quality=<name>): exactly these numbers, never changed;
//   'auto' (default) the frame-rate governor (core/perf.js) picks a rung of a ladder built for THIS device and moves
//                    along it to hold 60 fps: every rung is a feature set (AUTO_SETS) × an internal resolution.
// Keys read once at boot (a change needs a reload): vegetation, terrainLod, particles, shadowSize, ao, outlines.
// Keys read every frame (the governor moves these): maxDpr, renderScale, cloudScale, cloudSteps, cloudLightSteps,
// godrays, bloom, bloomLevels, msaa (null = the pipeline's own rule), speedTaps, reflections, reflection, bossFx.
// `tier` is the preset a quality behaves like for code that keys on a name (low | medium | high | ultra); `name` is
// what Settings shows ('auto' in the automatic mode).
export const QUALITY = {
  low: {
    maxDpr: 1, renderScale: 0.75, shadows: 0, shadowSize: 1024, reflection: 0.3,
    cloudScale: 0.25, cloudSteps: 48, cloudLightSteps: 4,
    godrays: false, bloom: true, ao: false, vegetation: 0.35, terrainLod: 0.6, particles: 0.5, outlines: true,
    bloomLevels: 5, speedTaps: 4, bossFx: 0.6,
  },
  medium: {
    maxDpr: 1.5, renderScale: 1, shadows: 1, shadowSize: 2048, reflection: 0.4,
    cloudScale: 0.33, cloudSteps: 64, cloudLightSteps: 5,
    godrays: true, bloom: true, ao: false, vegetation: 0.6, terrainLod: 0.8, particles: 0.75, outlines: true,
    bloomLevels: 6, speedTaps: 8, bossFx: 0.85,
  },
  high: {
    maxDpr: 2, renderScale: 1, shadows: 1, shadowSize: 2048, reflection: 0.5,
    cloudScale: 0.5, cloudSteps: 80, cloudLightSteps: 6,
    godrays: true, bloom: true, ao: true, vegetation: 1, terrainLod: 1, particles: 1, outlines: true,
    bloomLevels: 6, speedTaps: 8, bossFx: 1,
  },
  ultra: {
    maxDpr: 2, renderScale: 1, shadows: 2, shadowSize: 4096, reflection: 0.6,
    cloudScale: 0.5, cloudSteps: 128, cloudLightSteps: 8,
    godrays: true, bloom: true, ao: true, vegetation: 1.4, terrainLod: 1.3, particles: 1.25, outlines: true,
    bloomLevels: 6, speedTaps: 8, bossFx: 1,
  },
};
export const PRESETS = ['low', 'medium', 'high', 'ultra'];
export const MODES = ['auto', ...PRESETS];

// ---- the automatic mode ------------------------------------------------------------------------------------------
// The live half of a rung (everything the governor may change while the game runs, without a shader recompile).
export const AUTO_SETS = {
  bare: {
    tier: 'low', cloudScale: 0.2, cloudSteps: 26, cloudLightSteps: 3, godrays: false, bloom: true, bloomLevels: 4,
    msaa: 2, speedTaps: 4, reflections: false, reflection: 0.3, bossFx: 0.45,
  },
  low: {
    tier: 'low', cloudScale: 0.25, cloudSteps: 40, cloudLightSteps: 4, godrays: false, bloom: true, bloomLevels: 5,
    msaa: 2, speedTaps: 4, reflections: false, reflection: 0.3, bossFx: 0.65,
  },
  medium: {
    tier: 'medium', cloudScale: 0.33, cloudSteps: 60, cloudLightSteps: 5, godrays: true, bloom: true, bloomLevels: 6,
    msaa: 2, speedTaps: 8, reflections: true, reflection: 0.4, bossFx: 0.85,
  },
  high: {
    tier: 'high', cloudScale: 0.5, cloudSteps: 80, cloudLightSteps: 6, godrays: true, bloom: true, bloomLevels: 6,
    msaa: null, speedTaps: 8, reflections: true, reflection: 0.5, bossFx: 1,
  },
};
// Internal resolution of the rungs, megapixels (so a phone, a tablet and a 4K monitor climb the same ladder).
const RUNG_MP = {
  bare: [0.30, 0.38, 0.48, 0.60],
  low: [0.60, 0.75, 0.92, 1.15],
  medium: [1.15, 1.40, 1.75, 2.10],
  high: [2.10, 2.60, 3.20, 4.00, 5.20, 6.60, 8.30],
};
const SET_ORDER = ['bare', 'low', 'medium', 'high'];

/** The boot half of an automatic quality (read once by the world systems) per device class. */
function bootPart(dev) {
  if (dev.mobile || dev.gpuClass === 0) {
    return { shadows: 0, shadowSize: 1024, ao: false, vegetation: 0.4, terrainLod: 0.65, particles: 0.55, outlines: true };
  }
  if (dev.gpuClass === 1) {
    return { shadows: 1, shadowSize: 2048, ao: false, vegetation: 0.6, terrainLod: 0.8, particles: 0.75, outlines: true };
  }
  return { shadows: 1, shadowSize: 2048, ao: true, vegetation: 1, terrainLod: 1, particles: 1, outlines: true };
}

/** 0 software · 1 integrated / mobile-class · 2 unknown or mid · 3 discrete, from the WebGL renderer string. */
export function gpuClassOf(renderer = '') {
  const s = String(renderer).toLowerCase();
  if (!s) return 2;
  if (/swiftshader|llvmpipe|software|softpipe|basic render|microsoft basic/.test(s)) return 0;
  if (/nvidia|geforce|rtx|gtx|quadro|radeon rx|radeon pro|radeon \(tm\) rx|arc\(tm\) a\d|arc a\d|apple m\d+ (pro|max|ultra)/.test(s)) return 3;
  if (/apple m\d/.test(s)) return 2;
  if (/intel|iris|uhd|hd graphics|mali|adreno|powervr|videocore|radeon|vivante/.test(s)) return 1;
  return 2;
}

/**
 * What the game runs on: { mobile, ios, android, tablet, dpr, cores, memory, gpu (renderer string), gpuClass }.
 * gl: the game's own WebGL context (no second context is made). Safe without a DOM (node tests): everything falls
 * back to a desktop of unknown strength.
 */
export function detectDevice(gl = null, env = globalThis, gpuOverride = null) {
  const nav = env.navigator || {};
  const ua = String(nav.userAgent || '');
  const touchPts = +nav.maxTouchPoints || 0;
  // iPadOS reports itself as a Mac: a "Mac" with a touch screen is an iPad
  const ios = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPts > 0);
  const android = /Android/i.test(ua);
  let coarse = false;
  try { coarse = !!env.matchMedia?.('(pointer: coarse)').matches && !env.matchMedia?.('(any-pointer: fine)').matches; } catch { /* no matchMedia */ }
  const mobile = ios || android || /Mobile|Silk|Kindle|Quest|Tablet/i.test(ua) || (coarse && touchPts > 0);
  const sw = Math.min(env.screen?.width || 0, env.screen?.height || 0);
  let gpu = '';
  try {
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      gpu = String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '');
    }
  } catch { /* blocked: unknown */ }
  if (gpuOverride) gpu = String(gpuOverride);              // ?gpu=<renderer string> (tests: another device's ladder)
  let gpuClass = gpuClassOf(gpu);
  if (mobile && gpuClass > 1) gpuClass = 1;
  return {
    mobile, ios, android, tablet: mobile && sw >= 600, dpr: +env.devicePixelRatio || 1,
    cores: +nav.hardwareConcurrency || 0, memory: +nav.deviceMemory || 0, gpu, gpuClass,
  };
}

/**
 * The ladder for a device and a view size (CSS px): [{ set, mp, pr }] from the cheapest rung to the best one, and the
 * rung a first launch starts on. pr is the canvas pixel ratio (internal pixels per CSS pixel, may be below 1).
 */
export function buildLadder(dev, cssW, cssH) {
  const css = Math.max(1, cssW * cssH);
  const prMax = Math.max(0.5, Math.min(dev.dpr || 1, dev.mobile ? 1.5 : 2));
  const top = dev.mobile || dev.gpuClass === 0 ? 'medium' : 'high';
  const rungs = [];
  for (const set of SET_ORDER) {
    for (const mp of RUNG_MP[set]) {
      const pr = +Math.max(0.35, Math.min(prMax, Math.sqrt((mp * 1e6) / css))).toFixed(3);
      const last = rungs[rungs.length - 1];
      if (last && last.set === set && Math.abs(last.pr - pr) < 0.04) continue;        // the view cannot use more pixels
      if (last && last.set !== set && last.pr > pr + 0.02) continue;                   // never a step back in sharpness
      rungs.push({ set, mp, pr });
    }
    if (set === top) break;
  }
  // first launch: a megapixel budget per device class, in the class's feature set
  const want = dev.gpuClass === 0 ? ['bare', 0.4] : dev.mobile ? ['low', 0.92]
    : dev.gpuClass === 1 ? ['medium', 1.4] : dev.gpuClass === 2 ? ['high', 2.6] : ['high', 4.0];
  let start = 0, best = Infinity;
  rungs.forEach((r, i) => {
    const d = Math.abs(SET_ORDER.indexOf(r.set) - SET_ORDER.indexOf(want[0])) * 10 + Math.abs(Math.log(r.mp / want[1]));
    if (d < best) { best = d; start = i; }
  });
  return { rungs, start, prMax, top };
}

/** The quality object of a rung (name 'auto'). `shadowsOff`: the governor gave the shadows up for this session. */
export function autoQuality(dev, rung, { shadowsOff = false, index = 0 } = {}) {
  const boot = bootPart(dev);
  const set = AUTO_SETS[rung.set] || AUTO_SETS.low;
  const q = { ...QUALITY[set.tier], ...boot, ...set, maxDpr: rung.pr, renderScale: 1, name: 'auto', set: rung.set, rung: index };
  if (shadowsOff) q.shadows = 0;
  return q;
}

/** The mode asked for: ?quality= wins, then the saved choice, then 'auto'. */
export function pickMode(requested) {
  if (MODES.includes(requested)) return requested;
  const saved = localStorageGet('skyfire.gfx');
  return MODES.includes(saved) ? saved : 'auto';
}

/** A fixed preset's quality object. */
export function presetQuality(name) {
  const n = QUALITY[name] ? name : 'high';
  return { ...QUALITY[n], name: n, tier: n };
}

/** (kept for older callers) the quality of a mode without a device: 'auto' gives the medium preset's numbers. */
export function pickQuality(requested) {
  const mode = pickMode(requested);
  return mode === 'auto' ? { ...QUALITY.medium, name: 'auto', tier: 'medium' } : presetQuality(mode);
}

export function saveMode(mode) {
  try { if (MODES.includes(mode)) localStorage.setItem('skyfire.gfx', mode); } catch { /* storage blocked */ }
}

function localStorageGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}

// ---- what the governor learned, kept per device + view (the next launch starts on the rung this one settled on) ----
const PERF_KEY = 'skyfire.perf.v1';
export function perfKey(dev, cssW, cssH) {
  const a = Math.max(cssW, cssH), b = Math.min(cssW, cssH);      // the same key in portrait and landscape
  return `${Math.round(a / 40) * 40}x${Math.round(b / 40) * 40}@${(+dev.dpr || 1).toFixed(2)}|${String(dev.gpu || '').slice(0, 60)}`;
}
/** The saved rung { set, mp } for this device + view, or null. */
export function loadRung(key) {
  try {
    const all = JSON.parse(localStorageGet(PERF_KEY) || '{}');
    const r = all && all[key];
    return r && AUTO_SETS[r.set] && Number.isFinite(r.mp) ? { set: r.set, mp: r.mp, shadowsOff: !!r.shadowsOff } : null;
  } catch { return null; }
}
export function saveRung(key, rung, extra = {}) {
  try {
    let all = {};
    try { all = JSON.parse(localStorageGet(PERF_KEY) || '{}') || {}; } catch { all = {}; }
    const keys = Object.keys(all);
    if (keys.length > 12) for (const k of keys.slice(0, keys.length - 12)) delete all[k];
    all[key] = { set: rung.set, mp: rung.mp, ...extra, at: Date.now() };
    localStorage.setItem(PERF_KEY, JSON.stringify(all));
  } catch { /* storage blocked */ }
}
/** Index of the ladder rung nearest a saved { set, mp }. */
export function nearestRung(rungs, saved) {
  if (!saved) return -1;
  let best = -1, bd = Infinity;
  rungs.forEach((r, i) => {
    const d = Math.abs(SET_ORDER.indexOf(r.set) - SET_ORDER.indexOf(saved.set)) * 10 + Math.abs(Math.log(r.mp / saved.mp));
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}
