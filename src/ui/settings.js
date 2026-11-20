// Player settings: one small JSON in localStorage (every access wrapped, private windows may throw).
// The graphics mode ('auto' | low | medium | high | ultra) is saved by game.setQuality() under 'skyfire.gfx', the key
// core/quality.js reads at boot (performance update: the older 'skyfire.quality' is no longer read — every device
// starts in the automatic mode once).
// Consumers: game.settings (same object as game.hud.settings), and the 'settings' event { settings, key }.
export const DEFAULTS = {
  quality: 'auto',          // auto | low | medium | high | ultra  -> game.setQuality()
  mouseSensitivity: 1,      // multiplier, 0.25..3 (camera/aim owner reads it)
  invertY: false,
  master: 0.85,             // 0..1
  music: 0.6,
  sfx: 0.9,
  muted: false,
  damageNumbers: true,      // damage numbers in the Full HUD
  // touch (28.09): the touch layer (game.touchUI) reads controls / touchSensitivity / touchButtonSize / leftHanded;
  // the HUD reads hud and minimalNumbers. New keys only: an older save keeps loading (unknown keys are ignored,
  // missing ones take these defaults).
  language: 'auto',         // (29.09) auto (the browser / TV language: ru* → ru, else en) | en | ru — src/ui/i18n.js
  controls: 'auto',         // auto (touch once the screen is touched / a coarse pointer) | touch | desktop
  hud: 'auto',              // auto (= minimal in touch mode, full with keyboard & mouse) | minimal | full
  touchSensitivity: 1,      // touch aim drag multiplier, 0.25..3
  touchButtonSize: 'm',     // xs | s | m | l (xs: big screens — still FIRE ≥ 12 %, the others ≥ 8 % of the height)
  leftHanded: false,        // stick on the right, buttons on the left
  minimalNumbers: false,    // damage numbers in the Minimal HUD (off by default: less on screen)
  // touch, fix round 1 (the touch layer reads them with the same fallbacks): the layout of the stick and the buttons —
  // corners (FIRE bottom-right, the stick bottom-left) | compact (both nearer the middle: an 86" TV put 1.6 m between the
  // hands) — and a screen margin, % of each side (0..5: a TV that overscans HDMI cuts the edges off)
  touchLayout: 'corners',
  screenMargin: 0,
  // HUD size (fix round 1, the 86" TV review): 'large' scales the touch UI ×1.3 (hud.js HUD_LARGE; touch mode only)
  hudSize: 'normal',
  // controls update: how much help the aim gets — auto (strong with touch controls, normal with a mouse) | normal |
  // strong (src/actors/assist.js)
  aimAssist: 'auto',
  // performance update: a small frames-per-second read-out in the corner (src/ui/fps.js)
  showFps: false,
};

/** The allowed values of the string settings (anything else in a save falls back to the default). */
export const CHOICES = {
  quality: ['auto', 'low', 'medium', 'high', 'ultra'],
  language: ['auto', 'en', 'ru'],          // (29.09) the title's "English | (other language)" and the Settings row save en / ru
  controls: ['auto', 'touch', 'desktop'],
  hud: ['auto', 'minimal', 'full'],
  touchButtonSize: ['xs', 's', 'm', 'l'],
  touchLayout: ['corners', 'compact'],
  hudSize: ['normal', 'large'],
  aimAssist: ['auto', 'normal', 'strong'],
};

const KEY = 'skyfire.settings';

export function loadSettings(qualityName) {
  const s = { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      for (const k of Object.keys(DEFAULTS)) if (typeof saved?.[k] === typeof DEFAULTS[k]) s[k] = saved[k];
    }
  } catch { /* storage blocked or corrupt: defaults */ }
  if (qualityName) s.quality = qualityName;    // the preset actually running wins
  s.mouseSensitivity = Math.min(3, Math.max(0.25, s.mouseSensitivity));
  s.touchSensitivity = Math.min(3, Math.max(0.25, Number.isFinite(s.touchSensitivity) ? s.touchSensitivity : 1));
  s.screenMargin = Math.min(5, Math.max(0, Number.isFinite(s.screenMargin) ? s.screenMargin : 0));
  for (const k of ['master', 'music', 'sfx']) s[k] = Math.min(1, Math.max(0, s[k]));
  for (const [k, list] of Object.entries(CHOICES)) if (k !== 'quality' && !list.includes(s[k])) s[k] = DEFAULTS[k];
  return s;
}

/** The HUD layout for a settings object and the touch mode: true = Minimal (auto: minimal exactly in touch mode). */
export function minimalHud(s, touch) {
  return s?.hud === 'minimal' || (s?.hud !== 'full' && !!touch);
}

export function saveSettings(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch { /* ignore */ }
}

// One-shot flags that survive a reload (Retry / Face the Titan after a reload).
export function takeSessionFlag(name) {
  try { const v = sessionStorage.getItem('skyfire.' + name); sessionStorage.removeItem('skyfire.' + name); return v; } catch { return null; }
}
export function setSessionFlag(name, value) {
  try { sessionStorage.setItem('skyfire.' + name, value); return true; } catch { return false; }
}
