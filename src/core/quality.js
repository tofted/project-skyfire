// Quality presets. Systems read game.quality.<key>; add keys here rather than inventing local presets.
export const QUALITY = {
  low: {
    maxDpr: 1, renderScale: 0.75, shadows: 0, shadowSize: 1024, reflection: 0.3,
    cloudScale: 0.25, cloudSteps: 48, cloudLightSteps: 4,
    godrays: false, bloom: true, ao: false, vegetation: 0.35, terrainLod: 0.6, particles: 0.5, outlines: true,
  },
  medium: {
    maxDpr: 1.5, renderScale: 1, shadows: 1, shadowSize: 2048, reflection: 0.4,
    cloudScale: 0.33, cloudSteps: 64, cloudLightSteps: 5,
    godrays: true, bloom: true, ao: false, vegetation: 0.6, terrainLod: 0.8, particles: 0.75, outlines: true,
  },
  high: {
    maxDpr: 2, renderScale: 1, shadows: 1, shadowSize: 2048, reflection: 0.5,
    cloudScale: 0.5, cloudSteps: 80, cloudLightSteps: 6,
    godrays: true, bloom: true, ao: true, vegetation: 1, terrainLod: 1, particles: 1, outlines: true,
  },
  ultra: {
    maxDpr: 2, renderScale: 1, shadows: 2, shadowSize: 4096, reflection: 0.6,
    cloudScale: 0.5, cloudSteps: 128, cloudLightSteps: 8,
    godrays: true, bloom: true, ao: true, vegetation: 1.4, terrainLod: 1.3, particles: 1.25, outlines: true,
  },
};

export function pickQuality(requested) {
  const name = QUALITY[requested] ? requested : (localStorageGet('skyfire.quality') || 'high');
  return { ...(QUALITY[name] || QUALITY.high), name: QUALITY[name] ? name : 'high' };
}

function localStorageGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
