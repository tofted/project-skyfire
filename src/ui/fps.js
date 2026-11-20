// game.fpsTag (system 'fpsTag', order 93) — performance update: Settings → "Show frame rate" puts a small read-out in
// the top of the screen: frames per second (the governor's trimmed mean when it has one, else the core's), and in the
// automatic graphics mode what the governor is running — the feature set and the internal resolution as a share of
// the screen's own pixels. Written twice a second, nothing per frame; off by default (no element at all until then).
export default function createFpsTag(game) {
  let el = null, acc = 0, shown = false;
  const want = () => !!game.settings?.showFps || game.params?.has('fps');
  function build() {
    el = document.createElement('div');
    el.className = 'fps-tag';
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:max(4px,env(safe-area-inset-top));z-index:60;'
      + 'font:600 11px/1.25 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#ffe9b0;background:rgba(10,14,34,.55);'
      + 'padding:3px 7px;border-radius:6px;pointer-events:none;letter-spacing:.02em;white-space:pre;text-shadow:0 1px 2px rgba(0,0,0,.6)';
    (document.getElementById('ui') || document.body).appendChild(el);
  }
  function text() {
    const p = game.perf?.stats;
    const fps = p && p.fps > 1 ? p.fps : game.stats?.fps || 0;
    let s = `${Math.round(fps)} fps`;
    if (p && p.mode === 'auto' && p.rungs) {
      const full = Math.max(0.1, Math.min(game.device?.dpr || 1, 2));
      s += `  ${p.set} ${Math.round((p.pr / full) * 100)}%`;
      if (p.capped) s += `  cap ${Math.round(p.target)}`;
    } else if (game.quality?.name) s += `  ${game.quality.name}`;
    return s;
  }
  return {
    name: 'fpsTag',
    get el() { return el; },
    get text() { return el ? el.textContent : ''; },
    update(dt, realDt) {
      acc += realDt || 0;
      if (acc < 0.5) return;
      acc = 0;
      const on = want();
      if (on && !el) build();
      if (!el) return;
      if (on !== shown) { el.style.display = on ? '' : 'none'; shown = on; }
      if (on) { const t = text(); if (el.textContent !== t) el.textContent = t; }
    },
  };
}
