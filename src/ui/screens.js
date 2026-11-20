// Full-screen UI: title, pause, settings, controls, results. Keyboard (arrows / W S / Tab, Enter / Space, Esc)
// and mouse (hover focuses, click activates) share one focus highlight through Nav.
// Languages (29.09, src/ui/i18n.js): every text here goes through tr() / trn() (English is the source, the Russian texts
// are in src/ui/i18n/ru-menus.js); DOM built once is re-written on every language change (bindText, live(), onLang).
// The title has the language choice "English | (other language)" (under the FULLSCREEN corner button, in the title's keyboard
// navigation); Settings has a Language row. A pick calls setLang() at once (no reload) and saves it: api.change('language').
import { h, s, fmt } from './dom.js';
import { tr, trn, lang, setLang, onLang, bindText, LANGS, LANG_CHOICE } from './i18n.js';
import { trData } from './rank.js';

/** fn() now and after every language change (text built from state: a label that follows the fullscreen state …). */
function live(fn) { fn(); onLang(fn); return fn; }
/** A decimal number in the language in use: 1.00 / Russian 1,00 (docs/i18n.md: the decimal comma in Russian). */
export function dec(x, digits) { const t = (+x || 0).toFixed(digits); return lang() === 'en' ? t : t.replace('.', ','); }
/** 'In flight: hold *right mouse* to …' (already translated) → text and <b> nodes: the *marked* words are bold, so a
 *  line with bold words stays ONE translation (the Russian word order is free). */
function rich(str) {
  return String(str).split('*').map((part, i) => (i % 2 ? h('b', { text: part }) : part)).filter((x) => x !== '');
}
/** 'Objective: {0}' (translated) + nodes → text and the nodes in the template's order. */
function withNodes(str, nodes) {
  return String(str).split(/\{(\d+)\}/).map((part, i) => (i % 2 ? nodes[+part] ?? '' : part)).filter((x) => x !== '');
}
/** A key cap's caption: key names stay (W, Tab, Shift, Ctrl …), words are translated ("Left mouse" → "(other language)", "Space"). */
const KEEP_CAPS = new Set(['Tab', 'Shift', 'Ctrl', 'Alt', 'Esc', 'Enter']);
export function capText(k) { return /[A-Za-z]{2,}/.test(k) && !KEEP_CAPS.has(k) ? tr(k) : k; }
/** The language pick (the title's choice and the Settings row): switch at once, save it through the HUD's settings. */
function chooseLang(api, l) {
  if (!LANGS[l]) return false;
  const changed = setLang(l);
  try { if (api.settings?.language !== l) api.change?.('language', l); } catch (e) { console.warn('[ui] language', e); }
  api.sound?.(changed ? 'uiSelect' : 'uiMove');
  return changed;
}

// ---------------------------------------------------------------------------------------------------- navigation
// Hover focuses an item only when the pointer really moved: a resting cursor under a menu that just appeared
// (Chrome sends synthetic mouse events on layout changes) must not steal the keyboard focus.
const mouse = { x: -1, y: -1 };
window.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; }, { passive: true });

/** A vertical list of focusable items. item.el; optional item.left(), item.right(), item.activate(). */
export class Nav {
  constructor(items = [], { onBack = null, sound = null } = {}) {
    this.items = []; this.i = 0; this.onBack = onBack; this.sound = sound;
    for (const it of items) this.add(it);
  }
  add(it) {
    const idx = this.items.length;
    this.items.push(it);
    it.el.addEventListener('mousemove', (e) => {
      if (e.clientX === mouse.x && e.clientY === mouse.y) return;   // not a real move (the window listener runs after us)
      if (this.i !== idx || !it.el.classList.contains('focus')) this.focus(idx, true);
    });
    return it;
  }
  /** An item that is not shown (hidden, or inside a hidden group): the keyboard steps over it. */
  static hidden(it) { return !!it?.el && (it.el.hidden || !!it.el.closest?.('[hidden]')); }
  focus(i, fromMouse = false) {
    if (!this.items.length) return;
    const n = this.items.length;
    const dir = i < this.i ? -1 : 1;
    let k = ((i % n) + n) % n;
    for (let t = 0; t < n && Nav.hidden(this.items[k]); t++) k = (((k + dir) % n) + n) % n;
    this.i = k;
    this.items.forEach((it, k) => it.el.classList.toggle('focus', k === this.i));
    const it = this.items[this.i];
    const target = (it.getFocus && it.getFocus()) || it.focusEl || it.el;
    try { target.focus({ preventScroll: fromMouse }); } catch { /* old browser */ }
    if (!fromMouse) it.el.scrollIntoView?.({ block: 'nearest' });
    this.sound?.('uiMove');
  }
  key(e) {
    const it = this.items[this.i];
    const k = e.code;
    const inRange = document.activeElement?.type === 'range';
    if (k === 'ArrowDown' || k === 'KeyS' || (k === 'Tab' && !e.shiftKey)) { this.focus(this.i + 1); return true; }
    if (k === 'ArrowUp' || k === 'KeyW' || (k === 'Tab' && e.shiftKey)) { this.focus(this.i - 1); return true; }
    // a focused range input moves itself on arrow keys (native 'input' event); A / D nudge it through the nav
    if ((k === 'ArrowLeft' || k === 'ArrowRight') && inRange) return false;
    if ((k === 'ArrowLeft' || k === 'KeyA') && it?.left) { it.left(); return true; }
    if ((k === 'ArrowRight' || k === 'KeyD') && it?.right) { it.right(); return true; }
    if (k === 'Space' || k === 'Enter' || k === 'NumpadEnter') {
      const native = k !== 'Space' && document.activeElement?.tagName === 'BUTTON' && it?.el.contains(document.activeElement);
      if (!native) (it?.activate || (() => it?.el.click?.()))();
      return !native;
    }
    if (k === 'Escape' || k === 'Backspace') { if (this.onBack) { this.onBack(); return true; } }
    return false;
  }
}

// Every menu button answers through onTap (below), not a plain onclick: Chrome makes no click for a tap while another
// finger rests on the glass (a thumb on the stick zone, a hand on a TV's frame), so a click-only Resume / Back / Retry
// ignored it (fix round 1).
// title / sub: an English text (translated, re-written on a language change) or a function returning the text (live:
// run again on a language change; the button's .sync() runs it on a state change too).
function mbtn(title, sub, onClick, primary = false) {
  const t = h('span.mb-t'), sb = sub ? h('span.mb-s') : null;
  const b = onTap(h('button.mbtn' + (primary ? '.primary' : ''), { type: 'button' }, h('span.mb-dia'), t, sb), onClick);
  const fns = [];
  for (const [el, v] of [[t, title], [sb, sub]]) {
    if (!el) continue;
    if (typeof v === 'function') fns.push(() => { el.textContent = v(); });
    else bindText(el, v);
  }
  b.sync = () => { for (const f of fns) f(); };
  if (fns.length) live(b.sync);
  return b;
}
function pbtn(label, onClick) { return onTap(bindText(h('button.pbtn', { type: 'button' }), label), onClick); }

// ---------------------------------------------------------------------------------------------------- taps, fullscreen
/** A touch / pen event, or a click a touch made (Chrome: click.pointerType, sourceCapabilities.firesTouchEvents). */
export function fromTouch(e) {
  return !!e && (e.pointerType === 'touch' || e.pointerType === 'pen' || e.sourceCapabilities?.firesTouchEvents === true);
}
/**
 * fn on a click (mouse, keyboard Enter / Space, el.click()), and on the lift of a finger / pen (pointerup) that went down
 * on the element, stayed within a small slop and lifts inside it — so a button answers a tap even when Chrome makes no
 * click for it (multi-touch: another finger rests on the glass) or a touch layer cancels the compatibility click. One
 * tap never runs fn twice (a click within 0.7 s of a touch pointerup on the element is that tap's), a touch's
 * compatibility click never presses anything (it may land on a panel the tap just opened under the finger), and a drag
 * that starts on a button (the title's orbit, a panel scroll) does not press it. pointerup of a touch and click are both user
 * activations (fullscreen may be asked). opts.filter(e) → false ignores an event (a row that is a target only outside
 * its own controls). Returns el.
 */
export function onTap(el, fn, { filter = null } = {}) {
  const downs = new Map();           // pointerId → where the finger went down
  let touchAt = -1e9;
  const slop = () => Math.max(18, 0.03 * Math.min(globalThis.innerWidth || 0, globalThis.innerHeight || 0));
  const run = (e, what) => { try { fn(e); } catch (err) { console.warn('[ui] ' + what, err); } };
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || (filter && !filter(e))) return;
    downs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  });
  el.addEventListener('pointercancel', (e) => { downs.delete(e.pointerId); });
  el.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'mouse') return;
    touchAt = performance.now();
    const d = downs.get(e.pointerId);
    downs.delete(e.pointerId);
    if (!d || e.button > 0 || Math.hypot(e.clientX - d.x, e.clientY - d.y) > slop()) return;
    const r = el.getBoundingClientRect?.();
    if (r && (e.clientX < r.left - 1 || e.clientX > r.right + 1 || e.clientY < r.top - 1 || e.clientY > r.bottom + 1)) return;
    if (filter && !filter(e)) return;
    run(e, 'tap');
  });
  el.addEventListener('click', (e) => {
    if (performance.now() - touchAt < 700 || (filter && !filter(e))) return;
    // a touch's compatibility click belongs to its pointerup (above), wherever it lands: a tap that opens a panel or a
    // screen under the finger must not also press what appears there (fix round 1: the title's Settings tap flipped the
    // Settings panel's Fullscreen row; Quit to Title could start a mode) — Chrome marks it (pointerType / firesTouchEvents);
    // without those marks, a trusted click right after any finger's lift is taken as one
    if (fromTouch(e) || (e.isTrusted && !e.pointerType && !e.sourceCapabilities && performance.now() - lastLift < 700)) return;
    run(e, 'click');
  });
  return el;
}
let lastLift = -1e9;                 // the last lift of a finger / pen anywhere (the fallback rule above)
try {
  globalThis.addEventListener?.('pointerup', (e) => { if (e.pointerType && e.pointerType !== 'mouse') lastLift = performance.now(); }, { capture: true, passive: true });
  globalThis.addEventListener?.('touchend', () => { lastLift = performance.now(); }, { capture: true, passive: true });
} catch { /* no DOM */ }

/** How long a panel that just opened ignores touch input on its controls (below). */
export const PANEL_GUARD_MS = 700;
/**
 * A panel's first moments (review round 1, a pre-existing touch bug): a tap on a menu's Settings item opens the panel on
 * the finger's lift, and the same tap's compatibility mousedown / click — hit-tested again, after the panel appeared —
 * landed on the control now under the finger: the range input took it and Master volume jumped 0.85 → 0.15 (the pause
 * menu at 1280×800). onTap's buttons already skip compatibility clicks; a native <input type=range> does not. For
 * PANEL_GUARD_MS after the panel opens (its class "on" added, whoever adds it), every event that comes from a touch —
 * a touch / pen pointer, a touch event, a mouse event a touch made (sourceCapabilities.firesTouchEvents), or, in a browser
 * without that mark, a mouse event within PANEL_GUARD_MS of a finger's lift — stops at the panel (capture phase,
 * default prevented): nothing inside moves, flips or picks (a quick second tap of a double tap included). The mouse and
 * the keyboard are untouched, and a finger that goes down later works as before (drag a slider, tap an option). Returns el.
 */
export function guardPanel(el) {
  let openedAt = -1e9, was = false;
  const isOn = () => !!el.classList?.contains?.('on');
  const mark = () => { const on = isOn(); if (on && !was) openedAt = performance.now(); was = on; };
  try { new MutationObserver(mark).observe(el, { attributes: true, attributeFilter: ['class'] }); } catch { return el; }   // (no DOM: the unit tests)
  const touchy = (e) => e.pointerType === 'touch' || e.pointerType === 'pen' || String(e.type).startsWith('touch')
    || e.sourceCapabilities?.firesTouchEvents === true
    || (!e.pointerType && !e.sourceCapabilities && performance.now() - lastLift < PANEL_GUARD_MS);
  const stop = (e) => {
    mark();                            // (the class may have changed in this very task, before the observer ran)
    if (performance.now() - openedAt >= PANEL_GUARD_MS || !touchy(e)) return;
    if (e.cancelable) e.preventDefault();
    e.stopPropagation();
    guardPanel.stats.blocked++;
  };
  for (const t of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'touchstart', 'touchend']) el.addEventListener(t, stop, { capture: true, passive: false });
  return el;
}
guardPanel.stats = { blocked: 0 };

/**
 * The Fullscreen API on one element (document.documentElement): supported, on, toggle() (from a tap / click / key —
 * a user gesture), listen(fn) on every change. Never throws: a refusal (no gesture, a policy, an iframe) is swallowed.
 */
export function createFullscreen(target = typeof document !== 'undefined' ? document.documentElement : null) {
  const doc = typeof document !== 'undefined' ? document : null;
  // (looked up at each call: a prefixed / late-installed API is picked up)
  const req = () => target && (target.requestFullscreen || target.webkitRequestFullscreen);
  const exit = () => doc && (doc.exitFullscreen || doc.webkitExitFullscreen);
  const supported = !!(doc && req() && exit() && (doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled ?? true));
  const fns = new Set();
  const fs = {
    supported,
    get on() { return !!(doc && (doc.fullscreenElement || doc.webkitFullscreenElement)); },
    stats: { toggles: 0, changes: 0, refused: 0 },
    toggle() {
      if (!supported) return false;
      fs.stats.toggles++;
      const refused = () => { fs.stats.refused++; };
      try {
        const p = fs.on ? exit().call(doc) : req().call(target, { navigationUI: 'hide' });
        if (p && typeof p.catch === 'function') p.catch(refused);
      } catch { refused(); }
      return true;
    },
    listen(fn) { fns.add(fn); return () => fns.delete(fn); },
  };
  if (doc) {
    const changed = () => { fs.stats.changes++; for (const f of fns) { try { f(fs.on); } catch { /* a listener must not break the others */ } } };
    doc.addEventListener('fullscreenchange', changed);
    doc.addEventListener('webkitfullscreenchange', changed);
  }
  return fs;
}

// enter: four corners pointing out; exit: four corners pointing in
const FS_ENTER = 'M4 9.5V4h5.5M14.5 4H20v5.5M20 14.5V20h-5.5M9.5 20H4v-5.5';
const FS_EXIT = 'M9.5 4v5.5H4M20 9.5h-5.5V4M14.5 20v-5.5H20M4 14.5h5.5V20';
/** A round FULLSCREEN button (enter / exit icon from fullscreenchange); hidden when the API is unavailable. */
export function fsButton(fs, cls = '') {
  const path = s('path', { d: FS_ENTER });
  const b = h('button.fsb' + (cls ? '.' + cls : ''), { type: 'button', 'aria-label': 'Fullscreen', tabindex: '-1' }, s('svg.ic', { viewBox: '0 0 24 24' }, path));
  const sync = (on) => { path.setAttribute('d', on ? FS_EXIT : FS_ENTER); b.classList.toggle('on', on); b.setAttribute('aria-label', on ? tr('Exit fullscreen') : tr('Fullscreen')); };
  if (!fs?.supported) { b.hidden = true; bindText(b, 'Fullscreen', null, 'aria-label'); }
  else { sync(fs.on); fs.listen(sync); onLang(() => sync(fs.on)); onTap(b, () => fs.toggle()); }
  return b;
}

// ---------------------------------------------------------------------------------------------------- logo
export function logo() {
  const svg = s('svg', { viewBox: '0 0 520 150', role: 'img', 'aria-label': 'Skyfire' },
    s('defs', {},
      s('linearGradient', { id: 'sf-fill', x1: '0', y1: '0', x2: '0', y2: '1' },
        s('stop', { offset: '0', 'stop-color': '#ffffff' }), s('stop', { offset: '0.48', 'stop-color': '#fff5da' }),
        s('stop', { offset: '0.78', 'stop-color': '#ffd67a' }), s('stop', { offset: '1', 'stop-color': '#ee9f3a' })),
      s('linearGradient', { id: 'sf-wing', x1: '0', y1: '0', x2: '1', y2: '0' },
        s('stop', { offset: '0', 'stop-color': '#f08a2a', 'stop-opacity': '0' }), s('stop', { offset: '0.25', 'stop-color': '#f08a2a', 'stop-opacity': '0.95' }),
        s('stop', { offset: '0.7', 'stop-color': '#ffd98a' }), s('stop', { offset: '1', 'stop-color': '#fff6e0', 'stop-opacity': '0' })),
      s('filter', { id: 'sf-glow', x: '-20%', y: '-40%', width: '140%', height: '180%' }, s('feGaussianBlur', { stdDeviation: '7' }))),
    // wing-membrane swoosh under the letters (Sora's amber-gold membranes, key art 24.09)
    s('path', { d: 'M18 128 C 150 150, 330 138, 505 86', fill: 'none', stroke: 'url(#sf-wing)', 'stroke-width': '7', 'stroke-linecap': 'round', opacity: '0.85' }),
    s('path', { d: 'M40 136 C 170 152, 340 140, 492 100', fill: 'none', stroke: 'url(#sf-wing)', 'stroke-width': '1.6', 'stroke-linecap': 'round' }),
    s('text', { x: '260', y: '112', 'text-anchor': 'middle', textLength: '486', lengthAdjust: 'spacingAndGlyphs', class: 'lg-glow', filter: 'url(#sf-glow)',
      fill: 'none', stroke: '#ffffff', 'stroke-width': '10', opacity: '0.45' }, 'SKYFIRE'),
    s('text', { x: '260', y: '112', 'text-anchor': 'middle', textLength: '486', lengthAdjust: 'spacingAndGlyphs', class: 'lg-edge',
      fill: '#13245a', stroke: '#13245a', 'stroke-width': '9', 'stroke-linejoin': 'round' }, 'SKYFIRE'),
    s('text', { x: '260', y: '112', 'text-anchor': 'middle', textLength: '486', lengthAdjust: 'spacingAndGlyphs', class: 'lg-fill',
      fill: 'url(#sf-fill)', stroke: '#fffaf0', 'stroke-width': '1.2' }, 'SKYFIRE'),
    // sun glint
    s('path', { d: 'M468 10 L472 30 L492 34 L472 38 L468 58 L464 38 L444 34 L464 30 Z', fill: '#fffbe8', opacity: '0.95', class: 'lg-star' }),
  );
  for (const t of svg.querySelectorAll('text')) {
    t.setAttribute('font-family', 'Optima, Palatino, "Book Antiqua", serif');
    t.setAttribute('font-size', '112'); t.setAttribute('font-weight', '700');
  }
  const sub = h('div.logo-sub'), i1 = h('i'), i2 = h('i');
  live(() => sub.replaceChildren(i1, tr('Riders of the Cloud Sea'), i2));
  return h('div.logo', {}, svg, sub);
}

// ---------------------------------------------------------------------------------------------------- language choice
/**
 * "English | (other language)" (each name in its own language, the current one highlighted): a tap, a click, the keyboard (the
 * title's Nav item: ← / → or A / D pick, Enter / Space on a focused option). Placed under the title's FULLSCREEN corner
 * button (SCREENS_CSS .t-lang): the watermark and that button above it, the menu on the left, the footer at the bottom.
 */
export function langPicker(api) {
  const btns = Object.entries(LANGS).map(([l, name]) => {
    const b = onTap(h('button.tl-b', { type: 'button', role: 'radio', lang: l, text: name }), () => chooseLang(api, l));
    b.dataset.lang = l;
    return b;
  });
  const el = bindText(h('div.t-lang', { role: 'radiogroup' }, ...btns), 'Language', null, 'aria-label');
  const cur = () => btns.find((b) => b.dataset.lang === lang()) || btns[0];
  const sync = live(() => { for (const b of btns) { const on = b.dataset.lang === lang(); b.classList.toggle('sel', on); b.setAttribute('aria-checked', String(on)); } });
  const step = (d) => {
    const ls = Object.keys(LANGS);
    chooseLang(api, ls[Math.max(0, Math.min(ls.length - 1, ls.indexOf(lang()) + d))]);
    try { cur().focus({ preventScroll: true }); } catch { /* old browser */ }
  };
  /** The Nav item: the focus sits on the current language; Space / Enter pick the focused option. */
  const item = {
    el, getFocus: cur, left: () => step(-1), right: () => step(1),
    activate: () => { const f = btns.find((b) => b === document.activeElement) || cur(); chooseLang(api, f.dataset.lang); },
  };
  return { el, btns, item, sync, cur };
}

// ---------------------------------------------------------------------------------------------------- fit rules
// The screens' fit on short / narrow touch screens (a landscape phone 844×390, a 1024×600 tablet, a 1024×768 one): the
// title's six items in two columns on a short tablet too (561–800 px of height; styles.css does it up to 560 px; on a
// phone the menu starts 14 px from the top and the footer drops its brand line, so it stays under the last row), the
// pause menu in two columns, a compact results screen whose buttons stay on screen, Settings in one column when two do
// not fit, the panels' Back pinned to the bottom of a panel that scrolls. Only touch mode (#ui.tm) changes the layout;
// for both modes a closing panel stops taking taps at once (it fades for 0.3 s: a quick tap on the title under it was
// swallowed) and an option waiting for its confirming tap is outlined. One <style> in <head>, added once by the first
// screen built (skipped without a DOM: the unit tests' fake document has no head).
const SCREENS_CSS = `
/* the title's language choice: a pill under the FULLSCREEN corner button (46 px + 14 px; touch: 64 px + 14 px, zoomed
   by --z like that button), right-aligned with it; a short touch screen (a landscape phone) stacks the two options so
   the pill stays clear of the menu's right column. Faces with Cyrillic in both languages (one face per word). */
.t-lang { position: absolute; right: max(34px, env(safe-area-inset-right, 0px)); display: flex; gap: 3px; padding: 3px;
  top: calc(max(34px, env(safe-area-inset-top, 0px)) + var(--wm-reserve, 0px) + 60px);
  border-radius: 23px; border: 1.5px solid rgba(255, 246, 225, .62); background: rgba(9, 18, 46, .58);
  transition: opacity .3s ease, border-color .18s ease, box-shadow .18s ease; }
.t-lang button { min-width: 86px; height: 34px; padding: 0 14px; border: 0; border-radius: 17px; background: none; cursor: pointer; outline: none;
  font: 600 13px/1 "Avenir Next", "Segoe UI", "Helvetica Neue", Arial, system-ui, sans-serif; letter-spacing: .08em; color: var(--ink);
  text-shadow: var(--shadow-t); touch-action: manipulation; transition: background .15s, color .15s; }
.t-lang button:not(.sel):hover { background: rgba(255, 231, 163, .16); }
.t-lang button.sel { background: var(--gold-hi); color: var(--navy); text-shadow: none; font-weight: 700; }
.t-lang button:focus-visible { box-shadow: inset 0 0 0 2px rgba(255, 250, 240, .9); }
.t-lang.focus { border-color: var(--gold-hi); box-shadow: 0 0 0 2px rgba(255, 231, 163, .3), 0 0 16px rgba(255, 220, 140, .5); }
.scr.dim .t-lang { opacity: .25; }
.tm .t-lang { zoom: var(--z); gap: 4px; padding: 4px; border-radius: 36px;
  right: max(34px, calc(env(safe-area-inset-right, 0px) / var(--z) + 4px));
  top: calc(max(34px, calc(env(safe-area-inset-top, 0px) / var(--z))) + var(--wm-reserve, 0px) / var(--z) + 78px); }
.tm .t-lang button { min-width: 96px; height: 64px; padding: 0 16px; border-radius: 32px; font-size: 16px; }
@media (max-height: 560px) { .tm .t-lang { flex-direction: column; } }
/* Settings → Language: the names as the title's choice writes them, "English | (other language)" (normal case in both languages) */
.seg button[lang] { text-transform: none; letter-spacing: .04em; }
/* Russian: the segmented options in sentence case (uppercase Cyrillic "(other language)" does not fit a third of a touch
   row), a word is never broken inside; a wider value column in touch mode (Auto shows "(other language)") */
:root[lang="ru"] .seg button { text-transform: none; letter-spacing: .02em; font-size: 13px; }
:root[lang="ru"] .tm .seg button { font-size: 14px; }
:root[lang="ru"] .tm .panel.set .set-row { grid-template-columns: minmax(118px, 164px) minmax(0, 1fr) 88px; }
/* Russian: the touch rows' gesture chips ("(other language)") keep to their column; the logo's subtitle as wide as the English one */
:root[lang="ru"] .ctl kbd.tk { letter-spacing: .03em; padding-left: 8px; padding-right: 8px; }
:root[lang="ru"] .logo-sub { letter-spacing: .3em; }
/* Russian: "(other language)" is half as long again as "Defeat" — the title stays inside the results with room for the rank beside it */
:root[lang="ru"] .results.lose .r-title { font-size: clamp(40px, 7vw, 88px); }
:root[lang="ru"] .tm .results.lose .r-title { font-size: clamp(40px, calc(7vw / var(--z)), 88px); }
@media (max-height: 560px) { :root[lang="ru"] .tm .results.lose .r-title { font-size: clamp(34px, calc(10vh / var(--z)), 58px); } }
.seg button.arm { border-color: #ff9aa8; box-shadow: inset 0 0 0 2px rgba(255, 138, 156, .6); }
.panel:not(.on) { pointer-events: none; }
.tm .panel .pn-foot { position: sticky; bottom: -22px; z-index: 1; margin: 10px -30px -22px; padding: 12px 30px 16px;
  background: linear-gradient(180deg, rgba(9, 18, 46, 0), rgba(9, 18, 46, .97) 36%); pointer-events: none; }
/* the pinned bar only takes taps on its buttons: a row that shows through its fade (Large HUD size: "Mute all sound") stays tappable */
.tm .panel .pn-foot > * { pointer-events: auto; }
.tm .panel.set .pn-foot { margin-left: -24px; margin-right: -24px; padding-left: 24px; padding-right: 24px; }
.tm .p-card { max-height: calc(100vh / var(--z) - 16px); overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; }
.tm .r-wrap { max-height: calc(100vh / var(--z) - 12px); overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; }
.tm .panel.set.two .set-cols { grid-template-columns: repeat(auto-fit, minmax(min(100%, 540px), 1fr)); }
.tm .panel.set .set-row { grid-template-columns: minmax(118px, 164px) minmax(0, 1fr) 58px; }
.tm .panel.set .seg button { white-space: normal; }
/* an option wraps only between its words, never inside one (review round 1: "overflow-wrap: anywhere" made the touch
   Button size row's "MEDIUM" read "MEDIU / M" at 1080p, 4K and 1280×800): its longest word is the button's minimum
   width, the row's other options give way (measured in both languages at 1920×1080, 3840×2160, 1280×800 and 844×390,
   touch and desktop: qa/i18n/fix-menus/layout-check.mjs) */
.seg button { overflow-wrap: normal; word-break: normal; hyphens: manual; }
@media (max-width: 1140px) { .tm .panel.set.two { width: min(700px, calc(100vw / var(--z) - 32px)); } }
@media (min-height: 561px) and (max-height: 800px) {
  .tm .t-menu { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 14px; margin-bottom: calc(3vh / var(--z)); }
  .tm .t-menu .mbtn { width: 100%; min-height: 64px; }
  .tm .t-menu .mbtn.focus { transform: none; }
  .tm .t-left { width: min(700px, calc(100vw / var(--z) - 190px)); }
  .tm .logo { width: min(400px, calc(40vw / var(--z))); }
}
@media (max-height: 760px) {
  .tm .p-card { top: 50%; transform: translateY(-50%); width: min(680px, calc(100vw / var(--z) - 48px)); }
  .tm .p-card .menu { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 14px; }
  .tm .p-card .mbtn { width: 100%; min-height: 64px; }
  .tm .p-card .mbtn.focus { transform: none; }
  .tm .p-card .mb-s { display: none; }
  .tm .p-title { font-size: clamp(28px, calc(8vh / var(--z)), 52px); margin: 2px 0 2px; }
  .tm .p-obj { margin-bottom: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tm .p-info { margin: 0 0 10px; }
}
@media (max-height: 560px) {
  .tm .t-left { top: 14px; bottom: 56px; }
  .tm .t-foot > span:last-child { display: none; }
  .tm .p-k { display: none; }
  .tm .r-wrap { top: 50%; transform: translate(-50%, -50%); }
  .tm .r-k { font-size: 11px; }
  .tm .r-title { font-size: clamp(34px, calc(12vh / var(--z)), 64px); margin: 4px 0 2px; }
  .tm .r-grade { width: 60px; height: 60px; } .tm .r-gl { font-size: 32px; }
  .tm .r-best { width: 64px; height: 64px; } .tm .r-best b { font-size: 19px; } .tm .r-best span { font-size: 8.5px; letter-spacing: .24em; }
  .tm .r-line, .tm .r-reach, .tm .r-next, .tm .r-run, .tm .r-parts { display: none; }
  .tm .r-lvl { display: flex; width: max-content; max-width: 100%; margin: 4px auto 6px; padding-top: 4px; padding-bottom: 4px; }
  .tm .r-score, .tm .results.surv .r-score { font-size: 16px; margin-bottom: 8px; }
  .tm .r-stats { gap: 8px; margin-bottom: 10px; }
  .tm .r-stat { padding: 8px 6px 7px; }
  .tm .r-sv { font-size: 22px; } .tm .r-sl { margin-top: 5px; font-size: 10px; letter-spacing: .12em; }
}
/* keyboard & mouse on a short screen (a landscape phone or a small tablet with a mouse, 844×390; review round 1): the
   title's six items in two columns and the footer on one line without the brand line (the menu ran under the footer),
   the results screen compact like the touch one (its top line was cut off, Retry below the fold) */
@media (max-height: 560px) {
  #ui:not(.tm) .t-menu { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 14px; margin-bottom: 0; }
  #ui:not(.tm) .t-menu .mbtn { width: 100%; }
  #ui:not(.tm) .t-menu .mbtn.focus { transform: none; }
  #ui:not(.tm) .t-foot { font-size: 10.5px; gap: 2px 22px; }
  #ui:not(.tm) .t-foot > span:last-child { display: none; }
  #ui:not(.tm) .r-wrap { top: 50%; transform: translate(-50%, -50%); max-height: calc(100vh - 12px); overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; }
  #ui:not(.tm) .r-k { font-size: 11px; }
  #ui:not(.tm) .r-title { font-size: clamp(34px, 12vh, 64px); margin: 4px 0 2px; }
  #ui:not(.tm) .r-grade { width: 60px; height: 60px; } #ui:not(.tm) .r-gl { font-size: 32px; }
  #ui:not(.tm) .r-best { width: 64px; height: 64px; } #ui:not(.tm) .r-best b { font-size: 19px; } #ui:not(.tm) .r-best span { font-size: 8.5px; letter-spacing: .24em; }
  #ui:not(.tm) .r-line, #ui:not(.tm) .r-reach, #ui:not(.tm) .r-next, #ui:not(.tm) .r-run, #ui:not(.tm) .r-parts { display: none; }
  #ui:not(.tm) .r-lvl { display: flex; width: max-content; max-width: 100%; margin: 4px auto 6px; padding-top: 4px; padding-bottom: 4px; }
  #ui:not(.tm) .r-score, #ui:not(.tm) .results.surv .r-score { font-size: 16px; margin-bottom: 8px; }
  #ui:not(.tm) .r-stats { gap: 8px; margin-bottom: 10px; }
  #ui:not(.tm) .r-stat { padding: 8px 6px 7px; }
  #ui:not(.tm) .r-sv { font-size: 22px; } #ui:not(.tm) .r-sl { margin-top: 5px; font-size: 10px; letter-spacing: .12em; }
  :root[lang="ru"] #ui:not(.tm) .results.lose .r-title { font-size: clamp(34px, 10vh, 58px); }
}
/* keyboard & mouse, 1280×800 and other screens up to 860 px high: Settings fits without scrolling with its Language row
   (a 752 px panel; 10 px row padding ran 19 px over, the Back button under the edge) */
@media (max-height: 860px) and (min-height: 561px) { #ui:not(.tm) .panel.set .set-row { padding-top: 8px; padding-bottom: 8px; } }`;
function injectCss() {
  try {
    if (typeof document === 'undefined' || !document.head || document.querySelector('style[data-screens-css]')) return;
    const st = document.createElement('style');
    st.dataset.screensCss = '1';
    st.textContent = SCREENS_CSS;
    document.head.append(st);
  } catch { /* no DOM */ }
}

// ---------------------------------------------------------------------------------------------------- title
/**
 * The title menu: Take Flight (the primary item, the focus for Enter), Face the Titan, Survival, Fullscreen, Controls,
 * Settings — every item answers a tap, a click and Enter.
 */
export function buildTitle(api) {
  injectCss();
  const menu = bindText(h('nav.menu.t-menu'), 'Main menu', null, 'aria-label');
  const nav = new Nav([], { sound: api.sound });
  let touchShown = null, best = null;
  // Survival: endless waves; its best run (wave · time · score) is shown under the subtitle once there is one
  const survival = mbtn('Survival', 'Endless waves — how long can you last?', () => api.start('survival'));
  survival.classList.add('mb-surv');
  const bestEl = h('span.mb-best');
  survival.append(bestEl);
  const controlsBtn = mbtn('Controls', () => tr(touchShown ? 'Stick, buttons and gestures' : 'Mouse, keyboard and gamepad'), () => api.openPanel('controls'));
  // Fullscreen (the user, 28.09: "make a fullscreen button in the main menu"): between the modes and Controls; the label
  // follows the state (fullscreenchange). Tap, click and Enter all toggle it from the gesture. Absent without the API.
  const fsItem = api.fs?.supported
    ? mbtn(() => tr(api.fs.on ? 'Exit Fullscreen' : 'Fullscreen'), () => tr(api.fs.on ? 'Back to the window' : 'Fill the whole screen'), () => api.fs.toggle())
    : null;
  if (fsItem) {
    fsItem.classList.add('mb-fs');
    api.fs.listen(() => fsItem.sync());
  }
  // (levels update) Stages: start at any stage reached before; Leaderboard: the best runs (src/ui/online-ui.js panels)
  const stagesBtn = mbtn('Stages', 'Replay any stage you have reached', () => api.openPanel('stages'));
  const boardBtn = mbtn('Leaderboard', 'The best runs and where you stand', () => api.openPanel('leaderboard'));
  boardBtn.classList.add('mb-board');
  const items = [
    mbtn('Take Flight', 'Ride with Sora and Kaede', () => api.start('story'), true),
    stagesBtn,
    mbtn('Face the Titan', 'Skip straight to the boss battle', () => api.start('titan')),
    survival,
    boardBtn,
    fsItem,
    controlsBtn,
    mbtn('Settings', 'Graphics, controls and sound', () => api.openPanel('settings')),
  ].filter(Boolean);
  for (const b of items) { menu.append(b); nav.add({ el: b }); }
  // the language choice: the last item of the keyboard navigation (↓ from Settings), a tap / click on either option
  // (an English-only copy, ?langs=en, has no choice to show)
  const picker = LANG_CHOICE ? langPicker(api) : null;
  if (picker) nav.add(picker.item);
  // FULLSCREEN also in the top-right corner (touch and desktop; hidden when the browser has no Fullscreen API)
  const fsBtn = api.fs ? fsButton(api.fs, 't-fs') : null;
  // the footer lines: one translation each, the *marked* words bold
  const foot = [
    [h('span.desk'), () => tr('*↑ ↓* select  ·  *Enter* confirm')],
    [h('span.desk'), () => tr('In flight: hold *right mouse* to circle your dragon  ·  *P* photo mode')],
    // touch mode: TAP, not Enter (the camera turns the live view when it is dragged)
    [h('span.tonly'), () => tr('*Tap* to choose  ·  *drag* to look around')],
    [h('span.tonly'), () => tr('In flight: *left stick* flies  ·  drag on the right to aim')],
    [h('span'), () => tr('Skyfire · Riders of the Cloud Sea')],
  ];
  live(() => { for (const [span, text] of foot) span.replaceChildren(...rich(text())); });
  // .t-veil: the key art → live render change passes through a sunlit cloud (no cross-fade of two pictures)
  const el = h('div.scr.title', {},
    h('div.t-art'), h('div.t-veil'), h('div.t-flare'), h('div.t-shade'), h('div.t-frame'),
    h('div.t-left', {}, logo(), menu),
    fsBtn, picker?.el,
    h('div.t-foot', {}, ...foot.map(([span]) => span)));
  const showBest = () => {
    const txt = bestText(best);
    bestEl.replaceChildren(...(txt ? [h('b', { text: tr('Best') }), txt] : []));
    survival.classList.toggle('has-best', !!txt);
    survival.setAttribute('aria-label', txt ? tr('Survival — best: {best}', { best: txt }) : tr('Survival — endless waves'));
  };
  onLang(showBest);
  return {
    el, nav, fsBtn, fsItem, survival, picker,
    /** Touch mode on / off: the Controls line says what it shows (the footer switches by CSS, .tm). */
    setTouch(on) {
      on = !!on;
      if (on === touchShown) return;
      touchShown = on;
      controlsBtn.sync();
    },
    /** best = { wave, time, score } | null — the best Survival run (hud.js reads it from the director / storage). */
    setBest(b) { best = b; showBest(); },
  };
}
/** "Wave 7 · 04:12 · 18,450" (the parts that exist), '' when there is no best run yet. */
export function bestText(best) {
  if (!best || typeof best !== 'object') return '';
  const parts = [];
  if (best.wave > 0) parts.push(tr('Wave {n}', { n: Math.round(best.wave) }));
  if (best.time > 0) parts.push(clock(best.time));
  if (best.score > 0) parts.push(fmt(Math.round(best.score)));
  return parts.join('  ·  ');
}
/** 252 → "04:12" (mm:ss; hours roll into the minutes). */
export function clock(sec) {
  const t = Math.max(0, Math.floor(+sec || 0));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------------------------------- pause
export function buildPause(api) {
  injectCss();
  const menu = bindText(h('nav.menu'), 'Pause menu', null, 'aria-label');
  const nav = new Nav([], { onBack: () => api.resume(), sound: api.sound });
  let view = null, objText = '', infoText = '';
  // Touch mode adds what the keyboard has keys for: Camera view (V), Photo mode (P), Retry. Fullscreen (both modes)
  // when the browser has the API. Hidden items are skipped by the keyboard.
  const B = {
    resume: mbtn('Resume', null, () => api.resume(), true),
    view: mbtn('Camera View', () => tr(view === null ? 'Chase / rider' : view === 'rider' ? 'Rider view  ·  tap for the chase view' : 'Chase view  ·  tap for the rider view'), () => api.cameraView?.()),
    photo: mbtn('Photo Mode', null, () => api.photoMode?.()),
    controls: mbtn('Controls', null, () => api.openPanel('controls')),
    settings: mbtn('Settings', null, () => api.openPanel('settings')),
    retry: mbtn('Retry', null, () => api.retry()),
    fs: mbtn(() => tr(api.fs?.supported && api.fs.on ? 'Exit Fullscreen' : 'Fullscreen'), null, () => api.fs?.toggle()),
    quit: mbtn('Quit to Title', null, () => api.quit()),
  };
  for (const b of Object.values(B)) { menu.append(b); nav.add({ el: b }); }
  B.view.hidden = B.photo.hidden = B.retry.hidden = true;
  B.fs.hidden = !api.fs?.supported;
  if (api.fs?.supported) api.fs.listen(() => B.fs.sync());
  const obj = h('div.p-obj'), info = h('div.p-info');
  info.hidden = true;
  // the objective and the run's numbers come from the HUD / the director: shown translated (trData: a text that is
  // already in the current language passes), written again on a language change (Settings over the pause menu)
  const showObj = () => obj.replaceChildren(...(objText ? withNodes(tr('Objective: {0}'), [h('b', { text: trData(objText) })]) : []));
  const showInfo = () => { info.hidden = !infoText; info.textContent = infoText ? trData(infoText) : ''; };
  onLang(() => { showObj(); showInfo(); });
  const el = h('div.scr.pause.block', {}, h('div.p-dim'),
    h('div.p-card', {}, h('div.p-k', { text: 'Skyfire' }), bindText(h('div.p-title'), 'Paused'), obj, info, menu));
  return {
    el, nav, items: B,
    setObjective(t) { objText = t || ''; showObj(); },
    /** The run's numbers the Minimal HUD does not show in flight ("WAVE 2/3 · 6 LEFT · 12 DOWNED"); '' hides them. */
    setInfo(t) { infoText = t || ''; showInfo(); },
    /** o = { touch, retry (a Retry exists), view: 'chase' | 'rider' } → which items are shown. */
    refresh(o = {}) {
      B.view.hidden = !o.touch; B.photo.hidden = !o.touch; B.retry.hidden = !(o.touch && o.retry);
      view = o.view === 'rider' ? 'rider' : 'chase';
      B.view.sync();
      B.fs.hidden = !api.fs?.supported;
      if (Nav.hidden(nav.items[nav.i])) nav.focus(nav.i, true);
    },
  };
}

// ---------------------------------------------------------------------------------------------------- settings
const QUALITIES = [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']];
const CONFIRM_MS = 3000;          // a pick that asks for a second tap waits this long for it

/**
 * Settings. Two groups: "Display & sound" and "Controls". Keyboard & mouse: one column (the touch-only rows hidden);
 * touch mode: two columns, every control ≥ 64 px (styles.css .tm). api.mode() → { touch, minimal, controls, hud }
 * says what Auto resolved to; api.fs is the Fullscreen API (the Fullscreen row is hidden without it).
 */
export function buildSettings(api) {
  injectCss();
  const S = api.settings;
  const mode = () => (typeof api.mode === 'function' ? api.mode() : null) || { touch: false, minimal: false };
  const nav = new Nav([], { onBack: () => api.closePanel(), sound: api.sound });
  const colA = h('div.set-col', {}, bindText(h('div.set-grp'), 'Display & sound'));
  const colB = h('div.set-col', {}, bindText(h('div.set-grp'), 'Controls'));
  const rows = h('div.set-cols', {}, colA, colB);
  const rowEls = {};
  let col = colA;
  /** A row label with a small line under it (translated; the small line's text is set by the row). */
  const subLabel = (en, subEn, aria = false) => {
    const sub = subEn ? bindText(h('small.set-sub'), subEn) : h('small.set-sub');
    const lbl = h('div.set-l');
    if (aria) lbl.dataset.en = en;             // the control's aria-label follows the label (the slider below it)
    live(() => lbl.replaceChildren(tr(en), sub));
    lbl.sub = sub;
    return lbl;
  };
  const addRow = (label, control, valueEl, handlers = {}) => {
    const lbl = typeof label === 'string' ? bindText(h('div.set-l'), label) : label;
    const row = h('div.set-row', { tabindex: '-1' }, lbl, control, valueEl || h('div.set-v'));
    col.append(row);
    nav.add({ el: row, focusEl: handlers.focusEl || control, ...handlers });
    if (handlers.id) rowEls[handlers.id] = row;
    return row;
  };

  // segmented choices (quality, HUD, controls, button size): the DOM focus follows the selected option (A / D or ← / →
  // on the row), so Enter / Space act on it. opts.confirm(k, e) → a text: that pick waits for a second tap on the same
  // option within CONFIRM_MS (the text is shown under the label meanwhile); keyboard picks never wait.
  const segSyncs = [];
  // options: [key, English text, context?]; a context key is the dictionary entry of a word whose Russian depends on the
  // row (the button size's "Medium" is not the quality's); opts.own: the texts are shown as they are (the language
  // names, each in its own language); opts.get / opts.put: a choice that is not a plain stored setting (the language)
  const segmented = (key, label, options, { id, after, value, confirm, own, get, put } = {}) => {
    const lbl = h('div.set-l');
    const sub = h('small.set-sub');
    live(() => lbl.replaceChildren(tr(label), sub));
    const seg = bindText(h('div.seg', { role: 'radiogroup' }), label, null, 'aria-label');
    const btns = options.map(([k, text, ctx]) => {
      const b = onTap(h('button', { type: 'button', role: 'radio' }), (e) => pick(k, e));
      if (own) { b.textContent = text; b.setAttribute('lang', k); } else if (ctx) live(() => { b.textContent = lang() === 'en' ? text : tr(ctx); }); else bindText(b, text);
      b.dataset.q = k; seg.append(b); return b;
    });
    const v = h('div.set-v');
    const cur = get || (() => S[key]);
    let armed = null;                  // { k, at, text }: a pick waiting for its confirming tap
    const pick = (k, e) => {
      const ask = confirm && cur() !== k ? confirm(k, e) : '';
      if (ask && !(armed && armed.k === k && performance.now() - armed.at < CONFIRM_MS)) {
        armed = { k, at: performance.now(), text: ask };
        clearTimeout(pick.t); pick.t = setTimeout(() => { armed = null; refresh(); }, CONFIRM_MS + 50);
        refresh();
        return;
      }
      armed = null;
      set(k);
    };
    const sel = () => btns.find((b) => b.dataset.q === cur()) || btns[0];
    const set = (k) => { if (put) put(k); else if (S[key] !== k) api.change(key, k); after?.(k); refresh(); };
    const step = (d) => {
      const i = options.findIndex(([k]) => k === cur());
      set(options[Math.max(0, Math.min(options.length - 1, i + d))][0]);
      try { sel().focus({ preventScroll: true }); } catch { /* old browser */ }
    };
    addRow(lbl, seg, v, {
      id, left: () => step(-1), right: () => step(1), getFocus: sel,
      activate: () => { const f = btns.find((b) => b === document.activeElement); if (f && f.dataset.q !== cur()) set(f.dataset.q); },
    });
    segSyncs.push(() => {
      if (armed && performance.now() - armed.at >= CONFIRM_MS) armed = null;
      for (const b of btns) {
        const on = b.dataset.q === cur();
        b.classList.toggle('sel', on); b.setAttribute('aria-checked', String(on));
        b.classList.toggle('arm', !!armed && armed.k === b.dataset.q);
      }
      v.textContent = value ? value() : '';
      sub.textContent = armed ? armed.text : '';
    });
  };
  const slider = (key, label, min, max, step, show, id) => {
    const inp = h('input.rng', { type: 'range', min: String(min), max: String(max), step: String(step) });
    if (typeof label === 'string') bindText(inp, label, null, 'aria-label');
    else if (label?.dataset?.en) bindText(inp, label.dataset.en, null, 'aria-label');
    else inp.setAttribute('aria-label', label.firstChild?.textContent || id || key);
    const v = h('div.set-v');
    const sync = () => { inp.value = String(S[key]); inp.style.setProperty('--p', `${((S[key] - min) / (max - min)) * 100}%`); v.textContent = show(S[key]); };
    inp.addEventListener('input', () => { api.change(key, +inp.value); sync(); });
    inp.addEventListener('keydown', (e) => { if (e.code === 'ArrowUp' || e.code === 'ArrowDown') e.preventDefault(); });
    const nudge = (d) => { api.change(key, Math.min(max, Math.max(min, +(S[key] + d * step).toFixed(3)))); sync(); };
    addRow(label, inp, v, { id, left: () => nudge(-1), right: () => nudge(1) });
    return sync;
  };
  // a switch; keyOf() may pick the key at the moment (damage numbers: the Full or the Minimal HUD's own); get / set
  // for a switch that is not a stored setting (fullscreen)
  const toggle = (keyOf, label, { id, get, set } = {}) => {
    const K = typeof keyOf === 'function' ? keyOf : () => keyOf;
    const val = get || (() => !!S[K()]);
    const put = set || ((on) => api.change(K(), on));
    const b = h('button.toggle', { type: 'button', role: 'switch' });
    if (typeof label === 'string') bindText(b, label, null, 'aria-label');
    else if (label?.dataset?.en) bindText(b, label.dataset.en, null, 'aria-label');
    else b.setAttribute('aria-label', id || 'toggle');
    const v = h('div.set-v');
    const sync = () => { const on = val(); b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); v.textContent = on ? tr('On') : tr('Off'); };
    const flip = () => { put(!val()); sync(); };
    onTap(b, flip);
    // Space goes through Nav (which blocks the button's native Space click, so it must flip the switch itself);
    // Enter keeps the native button click.
    const row = addRow(label, b, v, { id, left: () => { put(false); sync(); }, right: () => { put(true); sync(); }, activate: flip });
    // the whole row is the switch's target (a finger on a TV does not need to find the knob); the knob answers itself
    onTap(row, flip, { filter: (e) => e.target === row || !!e.target?.closest?.('.set-l, .set-v') });
    return sync;
  };
  const pct = (x) => `${Math.round(x * 100)}%`;
  const x2 = (x) => `${dec(x, 2)}×`;

  // ---- display & sound
  // the language first (the same choice as the title's; the one in use is selected — a first launch follows the browser):
  // a player who cannot read the language shown finds it at once (review round 1: at the column's end it was two screens
  // down on a landscape phone and under the fold of a 1280×800 laptop)
  if (LANG_CHOICE) segmented('language', 'Language', Object.entries(LANGS), { id: 'language', own: true, get: () => lang(), put: (l) => chooseLang(api, l) });
  // performance update: Auto holds 60 fps by itself (core/perf.js); the value shows what it is running at now
  segmented('quality', 'Graphics quality', QUALITIES, { id: 'quality', value: () => {
    const p = typeof api.perf === 'function' ? api.perf() : null;
    return p && p.fps > 1 ? `${Math.round(p.fps)} fps` : '';
  } });
  segmented('hud', 'HUD', [['auto', 'Auto'], ['minimal', 'Minimal'], ['full', 'Full']], { value: () => (S.hud === 'auto' ? tr(mode().minimal ? 'Minimal' : 'Full') : '') });
  // HUD size (touch mode: hud.js scales the touch UI ×1.3 for a TV read from the sofa)
  segmented('hudSize', 'HUD size', [['normal', 'Normal'], ['large', 'Large (TV)']], { id: 'hudSize' });
  const dnLabel = subLabel('Damage numbers');
  const dnSub = dnLabel.sub;
  const syncs = [
    toggle(() => (mode().minimal ? 'minimalNumbers' : 'damageNumbers'), dnLabel, { id: 'numbers' }),
    toggle('fullscreen', 'Fullscreen', { id: 'fs', get: () => !!api.fs?.on, set: (on) => { if (!!api.fs?.on !== on) api.fs?.toggle(); } }),
    toggle('showFps', 'Show frame rate', { id: 'fps' }),
    slider('master', 'Master volume', 0, 1, 0.05, pct),
    slider('music', 'Music', 0, 1, 0.05, pct),
    slider('sfx', 'Sound effects', 0, 1, 0.05, pct),
    toggle('muted', 'Mute all sound'),
  ];
  // ---- controls
  col = colB;
  // Keyboard & mouse picked by a finger in touch mode takes the stick, the buttons and PAUSE away: a touch-only player
  // would be locked out of the pause menu, so a touch pick needs a second tap (a mouse or keyboard pick is one step)
  segmented('controls', 'Controls', [['auto', 'Auto'], ['touch', 'Touch'], ['desktop', 'Keyboard & mouse']], {
    value: () => (S.controls === 'auto' ? tr(mode().touch ? 'Touch' : 'Mouse') : ''),
    confirm: (k, e) => (k === 'desktop' && mode().touch && fromTouch(e) ? tr('Touch controls turn off · tap again') : ''),
  });
  // controls update: Auto = Strong with touch controls, Normal with a mouse (src/actors/assist.js)
  segmented('aimAssist', 'Aim assist', [['auto', 'Auto'], ['normal', 'Normal'], ['strong', 'Strong']], {
    id: 'assist', value: () => (S.aimAssist === 'auto' ? tr(mode().touch ? 'Strong' : 'Normal') : ''),
  });
  syncs.push(
    slider('touchSensitivity', 'Touch aim sensitivity', 0.25, 3, 0.05, x2, 'touchSens'),
    slider('mouseSensitivity', 'Mouse sensitivity', 0.25, 3, 0.05, x2),
    toggle('invertY', 'Invert vertical look'),
  );
  // touch layout (the touch layer's settings: touchButtonSize, touchLayout, leftHanded, screenMargin)
  segmented('touchButtonSize', 'Button size', [['xs', 'XS'], ['s', 'Small'], ['m', 'Medium', 'Button size: Medium'], ['l', 'Large']], { id: 'btnSize' });
  segmented('touchLayout', 'Button layout', [['corners', 'Corners'], ['compact', 'Compact']], { id: 'layout' });
  syncs.push(
    toggle('leftHanded', 'Left-handed (stick right)', { id: 'left' }),
    slider('screenMargin', subLabel('Screen margin', 'TV overscan', true), 0, 5, 0.5, (x) => `${dec(x, 1)}%`, 'margin'),
  );
  const back = pbtn('Back', () => api.closePanel());
  nav.add({ el: back });
  const el = guardPanel(bindText(h('div.panel.set', { role: 'dialog' },
    bindText(h('div.pn-h'), 'Settings'), rows, h('div.pn-foot', {}, back)), 'Settings', null, 'aria-label'));
  if (api.fs) api.fs.listen?.(() => refresh());
  onLang(() => refresh());
  function refresh() {
    const m = mode();
    // touch-only rows are hidden with keyboard & mouse (switch Controls to Touch to see them)
    for (const id of ['hudSize', 'touchSens', 'btnSize', 'layout', 'left', 'margin']) if (rowEls[id]) rowEls[id].hidden = !m.touch;
    if (rowEls.fs) rowEls.fs.hidden = !api.fs?.supported;
    el.classList.toggle('two', !!m.touch);
    if (dnSub) dnSub.textContent = m.minimal ? tr('Minimal HUD') : '';
    for (const f of segSyncs) f();
    for (const f of syncs) f();
    if (Nav.hidden(nav.items[nav.i])) nav.focus(nav.i, true);
  }
  refresh();
  return { el, nav, refresh };
}

// ---------------------------------------------------------------------------------------------------- controls
// The hover / flight scheme: Sora hovers in place until W is held (then flies forward; letting go flares back into a
// hover). Keys that do two things say both, the hover meaning first.
export const CONTROLS = [
  ['Flight · Sora hovers until you fly forward'],
  [['Mouse'], 'Aim — Sora looks where you look'],
  [['W'], 'Hold: fly forward · let go: hover'],
  [['A', 'D'], 'Strafe in a hover · bank in flight'],
  [['Space'], 'Climb · in flight: power wingbeat'],
  [['Ctrl'], 'Descend · in flight: tuck and dive'],
  [['S'], 'Drift back · in flight: flare'],
  [['Shift'], 'Boost while flying forward (stamina)'],
  [['Q', 'E'], 'Dodge hop left / right (stamina)'],
  ['Flight moves · while flying forward'],
  // the turn key FIRST, then Space (Space first is the power beat): the caps read in the order they are pressed
  [['A / D', '+', 'Space'], '180° wingover — A / D, then Space'],
  [['S', '+', 'Space'], 'Immelmann loop — S, then Space'],
  [['W', 'W'], 'Double-tap: dash (stamina)'],
  [['Ctrl'], 'Dive, pull up: SKYFALL — fire ×1.5'],
  ['Combat'],
  [['Left mouse'], 'Fire breath · bends to the brackets'], [['F'], 'Fireball on release · hold to charge'],
  [['R'], 'INFERNO super breath (full meter)'], [['Tab'], 'Cycle target lock'],
  ['Camera'],
  [['Right mouse', 'Alt'], 'Hold: circle around your dragon'], [['Wheel'], 'Camera distance'],
  [['V'], 'Chase / rider view'], [['P'], 'Photo mode (drag to orbit)'],
  ['Game'],
  [['Esc'], 'Pause'], [['H'], 'Controls'], [['M'], 'Mute'],
  // levels: kills → XP → a level (the 4th Game row fills the grid's empty cell: the panel keeps its height)
  [['Kills', '›', 'XP'], 'Level up: stronger fire, more HP'],
];

/**
 * Levels and elements: the combat rows as they are at Sora's element (game.progress.element; hud.js refreshes the
 * panel with it when it opens). The CONTROLS text above is the ember wording; ≤ 36 characters each, like the rest.
 * At the lightning / storm tiers F fires a lightning bolt and R is the STORM SURGE.
 */
export const CONTROLS_BY_ELEMENT = {
  ember: {},
  azure: { R: 'AZURE INFERNO super flame (full)' },
  radiant: { R: 'RADIANT INFERNO super flame (full)' },
  lightning: { 'Left mouse': 'Lightning breath · chains to foes', F: 'Lightning bolt · tap / hold: charge', R: 'STORM SURGE lightning breath (full)', pad: 'X bolt' },
  storm: { 'Left mouse': 'Storm breath · chains to foes', F: 'Lightning bolt · tap / hold: charge', R: 'STORM SURGE lightning + fire (full)', pad: 'X bolt' },
};
const PAD_TEXT = (x) => tr('Gamepad: left stick forward = fly, sideways = strafe / bank · right stick aim · RT breath · LT brake · A climb / power beat · B dodge · {x}', { x: tr(x) });

/**
 * The touch layout (touch mode shows it instead of the keyboard rows): the floating stick on the left, the buttons in
 * the bottom-right arc, gestures on the right half. Names are the on-screen button captions (the touch layer's).
 */
export const TOUCH_CONTROLS = [
  ['Flight · the stick on the left'],
  [['Stick up'], 'Fly where you look · let go: hover'],
  [['Look up', '+', 'stick up'], 'Rise · flying: climb, power beat'],
  [['Look down', '+', 'stick up'], 'Sink · flying: steep look dives'],
  [['Stick ◀ ▶'], 'Strafe in a hover · turn in flight'],
  [['Stick down'], 'Drift back · in flight: brake'],
  [['BOOST'], 'Hold: boost while flying (stamina)'],
  [['◀ DODGE ▶'], 'Dodge hop left / right (stamina)'],
  // fix round 1 (touch layer): the moves are double flicks (push, back to the centre, push again, quickly) — a push to
  // the side and back up is a turn, a pull down and forward again a brake, never a move
  ['Flight moves · flick the stick twice'],
  [['◀◀', '/', '▶▶'], 'Flick twice to a side: wingover'],
  [['▼▼'], 'Flick down twice: Immelmann loop'],
  [['▲▲'], 'Flick up twice: dash (stamina)'],
  [['Dive', '›', 'look up'], 'Pull out: SKYFALL — fire ×1.5'],
  ['Combat'],
  [['FIRE'], 'Hold: fire breath (heats up)'],
  [['FIREBALL'], 'Tap: fireball · hold to charge'],
  [['INFERNO'], 'Super breath once the ring is full'],
  [['LOCK'], 'Cycle target lock'],
  ['Camera & game'],
  [['Drag right side'], 'Aim — Sora looks where you drag'],
  [['Two fingers'], 'Drag: circle the camera'],
  [['Pinch'], 'Camera distance'],
  [['Pause'], 'Camera view · photo mode · retry'],
  [['Fullscreen'], 'Fill the whole screen'],
];
/** The touch combat rows by element (the keyboard's CONTROLS_BY_ELEMENT in the buttons' words). */
export const TOUCH_BY_ELEMENT = {
  ember: {},
  azure: { INFERNO: 'AZURE INFERNO when the ring fills' },
  radiant: { INFERNO: 'RADIANT INFERNO when the ring fills' },
  lightning: { FIRE: 'Hold: lightning breath · chains', FIREBALL: 'Tap: lightning bolt · hold: charge', INFERNO: 'STORM SURGE when the ring fills' },
  storm: { FIRE: 'Hold: storm breath · chains', FIREBALL: 'Tap: lightning bolt · hold: charge', INFERNO: 'STORM SURGE when the ring fills' },
};

/** Fill a controls grid in the current language (built again on a language change); byKey gets the description spans
 *  of the keyed rows (their English text as base). */
function fillGrid(grid, list, byKey, keyed, cap) {
  for (const k of Object.keys(byKey)) delete byKey[k];
  const kids = [];
  for (const row of list) {
    if (row.length === 1) { kids.push(h('div.ctl-grp', { text: tr(row[0]) })); continue; }
    const [keys, what] = row;
    const span = h('span', { text: tr(what) });
    if (keys.length === 1 && keyed.includes(keys[0]) && !byKey[keys[0]]) byKey[keys[0]] = { span, base: what };
    // '+' (a combo), '›' (then) and '/' (or) are separators between key caps, not keys
    kids.push(h('div.ctl', {}, h('span.keys', {}, ...keys.map((k) => (k === '+' || k === '›' || k === '/' ? h('span.ksep', { text: k }) : h(cap, { text: capText(k) })))), span));
  }
  grid.replaceChildren(...kids);
  return grid;
}
function controlGrid(list, byKey, keyed, cap = 'kbd') { return fillGrid(h('div.ctl-grid'), list, byKey, keyed, cap); }

export function buildControls(api) {
  const byKey = {};          // the combat rows' description spans ('Left mouse', 'F', 'R'), rewritten per element
  const tByKey = {};         // the same for the touch rows ('FIRE', 'FIREBALL', 'INFERNO')
  const KEYED = ['Left mouse', 'F', 'R'], TKEYED = ['FIRE', 'FIREBALL', 'INFERNO'];
  const grid = controlGrid(CONTROLS, byKey, KEYED);
  const tgrid = controlGrid(TOUCH_CONTROLS, tByKey, TKEYED, 'kbd.tk');
  tgrid.classList.add('ctl-touch');
  tgrid.hidden = true;
  const back = pbtn('Back', () => api.closePanel());
  const nav = new Nav([{ el: back }], { onBack: () => api.closePanel(), sound: api.sound });
  const pad = h('div.ctl-pad', {}, PAD_TEXT('X fireball'));
  const el = guardPanel(bindText(h('div.panel.wide', { role: 'dialog' },
    bindText(h('div.pn-h'), 'Controls'), grid, pad, tgrid,
    h('div.pn-foot', {}, back)), 'Controls', null, 'aria-label'));
  let shown = 'ember', touchShown = false;
  /** The combat rows' words at the element shown (text only). */
  function words() {
    const V = CONTROLS_BY_ELEMENT[shown], T = TOUCH_BY_ELEMENT[shown] || {};
    for (const [k, r] of Object.entries(byKey)) r.span.textContent = tr(V[k] || r.base);
    for (const [k, r] of Object.entries(tByKey)) r.span.textContent = tr(T[k] || r.base);
    pad.textContent = PAD_TEXT(V.pad || 'X fireball');
  }
  // a language change: both grids in the new words, then the element's rows again
  onLang(() => { fillGrid(grid, CONTROLS, byKey, KEYED, 'kbd'); fillGrid(tgrid, TOUCH_CONTROLS, tByKey, TKEYED, 'kbd.tk'); words(); });
  /** Rewrite the combat rows for an element ('ember' … 'storm'; anything else → ember). Text only, write on change.
   *  touch (optional): show the touch layout instead of the keyboard / gamepad rows. */
  function refresh(element, touch) {
    if (typeof touch === 'boolean' && touch !== touchShown) {
      touchShown = touch;
      grid.hidden = touch; pad.hidden = touch; tgrid.hidden = !touch;
    }
    const el2 = CONTROLS_BY_ELEMENT[element] ? element : 'ember';
    if (el2 === shown) return;
    shown = el2;
    words();
  }
  return { el, nav, refresh, get element() { return shown; }, get touch() { return touchShown; } };
}

// ---------------------------------------------------------------------------------------------------- results
/** A rating part's label (hud.js hands the director's parts over in English): 'Survival' there is how well Sora came
 *  through, not the mode — its own key 'Survival (rating)' (Russian «(other language)»; the mode is «(other language)»). */
export function partLabel(label) {
  if (label === 'Survival' || label === 'Survival (rating)') return lang() === 'en' ? 'Survival' : tr('Survival (rating)');
  return trData(label);
}
export function buildResults(api) {
  injectCss();
  const k = h('div.r-k'), title = h('div.r-title'), line = h('div.r-line');
  const gradeL = h('div.r-gl'), scoreV = h('div.r-score');
  const grade = h('div.r-grade', {}, bindText(h('div.r-gk'), 'Rank'), gradeL);
  const stat = (label) => { const v = h('div.r-sv', { text: '—' }); return { el: h('div.r-stat', {}, v, bindText(h('div.r-sl'), label)), v }; };
  const st = { time: stat('Flight time'), dmg: stat('Damage dealt'), downed: stat('Enemies downed'), combo: stat('Best combo'), acc: stat('Accuracy') };
  const gradeNext = h('div.r-next'), reached = h('div.r-reach'), run = h('div.r-run'), partsEl = h('div.r-parts');
  // the level and element Sora reached (levels): "LV 7 · LIGHTNING BREATH · 1,240 XP" in the element's colour
  const lvN = h('b.rl-n'), lvName = h('span.rl-el'), lvXp = h('span.rl-xp');
  const lvl = h('div.r-lvl', {}, h('i.rl-ic'), bindText(h('span.rl-k'), 'LV'), lvN, h('i.rl-dot'), lvName, lvXp);
  // Retry says where it restarts ("Retry · Wave 3"); the label is filled in by show()
  const retryT = bindText(h('span'), 'Retry'), retryS = h('small');
  const retry = onTap(h('button.pbtn.primary.retry', { type: 'button' }, retryT, retryS), () => api.retry());
  const toTitle = pbtn('Title', () => api.quit());
  // (leaderboard update) the run's posting ("New personal best · #4 on the Story board") and the way to the board
  const online = h('div.r-online');
  let onlineAction = null;
  onTap(online, () => { if (onlineAction) api.openPanel(onlineAction); });
  const toBoard = pbtn('Leaderboard', () => (api.openBoard ? api.openBoard() : api.openPanel('leaderboard')));
  const nav = new Nav([{ el: retry }, { el: toTitle }, { el: toBoard }], { sound: api.sound });
  nav.key = ((orig) => function (e) {       // left/right move along the row too
    if (e.code === 'ArrowLeft' || e.code === 'KeyA') { this.focus(this.i - 1); return true; }
    if (e.code === 'ArrowRight' || e.code === 'KeyD') { this.focus(this.i + 1); return true; }
    return orig.call(this, e);
  })(nav.key);
  // Survival: the wave reached is the title, a "NEW BEST" stamp where the rank sits, and its own stat row
  const bestStamp = h('div.r-best', {}, bindText(h('b'), 'New'), bindText(h('span'), 'Best'));
  const sv = { wave: stat('Wave reached'), time: stat('Time survived'), kills: stat('Enemies downed'), score: stat('Score'), best: stat('Best') };
  const statsEl = h('div.r-stats', {}, st.time.el, st.dmg.el, st.downed.el, st.combo.el, st.acc.el);
  const survStats = h('div.r-stats.r-sv-stats', {}, sv.wave.el, sv.time.el, sv.kills.el, sv.score.el, sv.best.el);
  const el = h('div.scr.results.block', {}, h('div.r-dim'),
    h('div.r-wrap', {}, k, h('div.r-head', {}, title, grade, bestStamp), line, lvl, reached, scoreV, online, partsEl, gradeNext,
      statsEl, survStats, run, h('nav.menu.r-menu', {}, retry, toTitle, toBoard)));
  /** stats.level = { level, element, name, title, xp, max, icon } | null → the level line (hidden without one). */
  function showLevel(L) {
    lvl.style.display = L ? '' : 'none';
    if (!L) return;
    lvl.className = `r-lvl el-${L.element}${L.icon === 'bolt' ? ' bolt' : ''}`;
    lvN.textContent = String(L.level);
    lvName.textContent = trData(L.name);
    lvXp.textContent = L.max ? `  ·  ${tr('MAX LEVEL')}` : L.xp > 0 ? `  ·  ${tr('{xp} XP', { xp: fmt(L.xp) })}` : '';
    lvl.setAttribute('aria-label', tr('Level {n}, {title}', { n: L.level, title: trData(L.title) }));
  }
  /** Survival's new-best fields (hud.js: 'score' | 'time' | 'wave') in words: the first field as it stands alone (Russian
   *  «(other language)»), the next ones in their list form («(other language)»: «(other language)»). */
  const FIELD = { score: () => tr('score'), time: () => tr('time'), wave: () => tr('wave') };
  const FIELD_NEXT = { score: () => tr('score (next field)'), time: () => tr('time (next field)'), wave: () => tr('wave (next field)') };
  /** English "score · time · wave" (as before); other languages "A, B and C" ('{a} and {b}': «(other language)»). */
  const fieldList = (nf) => {
    if (lang() === 'en') return nf.map((f) => (FIELD[f] ? FIELD[f]() : f)).join(' · ');
    const w = nf.map((f, i) => { const F = i ? FIELD_NEXT : FIELD; return F[f] ? F[f]() : trData(f); });
    return w.length < 2 ? w[0] || '' : tr('{a} and {b}', { a: w.slice(0, -1).join(', '), b: w[w.length - 1] });
  };
  /** The Survival variant of the screen (stats.survival = { wave, time, kills, score, best: { wave, time, score }, newBest }). */
  function showSurvival(stats) {
    const S = stats.survival;
    el.classList.add('surv'); el.classList.remove('win', 'lose');
    k.textContent = tr('Survival');
    title.textContent = S.wave > 0 ? tr('Wave {n}', { n: Math.round(S.wave) }) : tr('Survival');
    line.textContent = S.kills > 0
      ? trn(S.kills, 'You held the sky for {time} and downed {n} Shade dragon. The waves never end — how long can you last?',
        'You held the sky for {time} and downed {n} Shade dragons. The waves never end — how long can you last?', { time: clock(S.time), n: fmt(S.kills) })
      : tr('You held the sky for {time}. The waves never end — how long can you last?', { time: clock(S.time) });
    run.style.display = 'none';
    // the director's rank for the run (gradeSurvival), where the story's rank sits; NEW BEST on the other side
    grade.style.display = S.grade ? '' : 'none';
    gradeL.textContent = S.grade || '';
    grade.className = 'r-grade g-' + String(S.grade || '').toLowerCase();
    bestStamp.style.display = S.newBest ? '' : 'none';
    // what the score is made of (kills × wave, seconds, early clears)
    const P = (S.parts || []).filter(([, v]) => v > 0);
    reached.textContent = P.map(([label, v]) => `${trData(label)} ${fmt(Math.round(v))}`).join('  ·  ');
    reached.style.display = P.length ? '' : 'none';
    partsEl.style.display = 'none';
    const B = S.best;
    const bestLine = B ? bestText(B) : '';
    const nf = S.newFields || [];
    const what = nf.length ? fieldList(nf) : tr('score');
    gradeNext.textContent = S.newBest || nf.length ? tr('New best {what}  ·  {best}', { what, best: bestLine || tr('the sky remembers') })
      : bestLine ? tr('Best run  ·  {best}', { best: bestLine }) : '';
    gradeNext.style.display = gradeNext.textContent ? '' : 'none';
    scoreV.textContent = tr('Score  {n}', { n: fmt(Math.round(S.score || 0)) });
    scoreV.style.display = '';
    sv.wave.v.textContent = S.wave > 0 ? String(Math.round(S.wave)) : '—';
    sv.time.v.textContent = clock(S.time);
    sv.kills.v.textContent = fmt(S.kills || 0);
    sv.score.v.textContent = fmt(Math.round(S.score || 0));
    sv.best.v.textContent = B?.score > 0 ? fmt(Math.round(Math.max(B.score, S.newBest ? S.score : 0))) : S.score > 0 ? fmt(Math.round(S.score)) : '—';
    retryT.textContent = tr('Retry'); retryS.textContent = `·  ${tr('Survival')}`;
    retry.setAttribute('aria-label', tr('Retry Survival'));
  }
  let last = null;                   // the screen shown (written again on a language change)
  function show(win, stats) {
    last = [win, stats];
    const surv = !!stats?.survival;
    el.classList.toggle('surv', surv);
    bestStamp.style.display = 'none';
    showLevel(stats?.level || null);
    statsEl.style.display = surv ? 'none' : '';
    survStats.style.display = surv ? '' : 'none';
    if (surv) { showSurvival(stats); return; }
    el.classList.toggle('win', win); el.classList.toggle('lose', !win);
    k.textContent = win ? tr('The sky is clear') : tr('Sora and Kaede have fallen');
    title.textContent = win ? tr('Victory') : tr('Defeat');
    line.textContent = win ? tr('The Cloud Titan sinks beneath the cloud sea. Valdena is safe.') : tr('The clouds close over the valley. Take to the sky again?');
    reached.textContent = stats.reached ? tr('Reached  ·  {where}', { where: trData(stats.reached) }) : '';
    reached.style.display = stats.reached ? '' : 'none';
    gradeNext.textContent = stats.rankNext ? trData(stats.rankNext) : '';
    gradeNext.style.display = stats.rankNext ? '' : 'none';
    if (stats.retryText) { retryT.textContent = trData(stats.retryText); retryS.textContent = ''; }
    else { retryT.textContent = tr('Retry'); retryS.textContent = stats.retryTo ? `·  ${trData(stats.retryTo)}` : ''; }
    retry.setAttribute('aria-label', stats.retryText ? trData(stats.retryText) : stats.retryTo ? tr('Retry from {where}', { where: trData(stats.retryTo) }) : tr('Retry'));
    // what the rank is made of (the director's rating parts, 0..1 each)
    if (stats.parts?.length) {
      partsEl.replaceChildren(...stats.parts.map(([label, v]) => {
        const i = h('i'); i.style.transform = `scaleX(${Math.max(0, Math.min(1, v)).toFixed(2)})`;
        return h('div.r-part', {}, h('span', { text: partLabel(label) }), h('b', {}, i));
      }));
      partsEl.style.display = '';
    } else partsEl.style.display = 'none';
    const R = stats.run, mm = (x) => { const tt = Math.max(0, x | 0); return `${String(Math.floor(tt / 60)).padStart(2, '0')}:${String(tt % 60).padStart(2, '0')}`; };
    if (R && R.attempts > 1) {
      const L = R.last, T = R.totals;
      // (the phrases are separate texts: each one is there only when its number is)
      const rest = L && L.time !== null
        ? ` ${tr('totals above')}  ·  ${tr('last attempt {time}', { time: mm(L.time) })}${L.downed !== null ? ` · ${tr('{n} downed', { n: fmt(L.downed) })}` : ''}${L.damage !== null ? ` · ${tr('{n} damage', { n: fmt(L.damage) })}` : ''}`
        : T ? ` ${[tr('{time} flown', { time: mm(T.time) }), tr('{n} downed', { n: fmt(T.downed) }), tr('{n} damage', { n: fmt(T.damage) }), tr('best score {n}', { n: fmt(T.bestScore) })].join('  ·  ')}` : '';
      run.replaceChildren(h('b', { text: trn(R.attempts, 'This run · {n} attempt', 'This run · {n} attempts') }), rest);
      run.style.display = '';
    } else run.style.display = 'none';
    const t = Math.max(0, stats.time | 0);
    st.time.v.textContent = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    st.dmg.v.textContent = fmt(stats.damage);
    st.downed.v.textContent = String(stats.downed);
    st.combo.v.textContent = stats.combo > 1 ? `×${stats.combo}` : '—';
    st.acc.v.textContent = stats.shots > 0 ? `${Math.round((100 * stats.hits) / stats.shots)}%` : '—';
    grade.style.display = stats.grade ? '' : 'none';
    gradeL.textContent = stats.grade || '';
    grade.className = 'r-grade g-' + String(stats.grade || '').toLowerCase();
    scoreV.textContent = typeof stats.score === 'number' ? tr('Score  {n}', { n: fmt(stats.score) }) : '';
    scoreV.style.display = typeof stats.score === 'number' ? '' : 'none';
  }
  onLang(() => { if (last) { try { show(...last); } catch { /* the next show() writes it */ } } });
  return {
    el, nav,
    /** stats: { time, damage, downed, shots, hits, grade, score, combo, rankNext?, reached?, retryTo?, run?, survival? } */
    show,
    /** The leaderboard line under the score: { text, kind: ''|'best'|'ask'|'err'|'wait', action: a panel to open on a tap }. */
    setOnline(o = {}) {
      online.textContent = o.text || '';
      online.className = 'r-online' + (o.kind ? ' ' + o.kind : '');
      onlineAction = o.action || null;
    },
  };
}
