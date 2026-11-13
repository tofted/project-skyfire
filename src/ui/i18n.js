// Language of everything the player reads (the user, 29.09: "a language choice on the menu screen: Russian and English").
// English is the source: every UI string stays written in English in the code and goes through tr(), which returns the
// Russian text from the dictionaries when the language is 'ru' (English itself needs no dictionary).
//   tr(en, vars?)            'Wave {n}' + { n: 3 } → 'Wave 3' / '(other language) 3'; a missing Russian text falls back to English
//                            (and is recorded: missingKeys(); a warning with ?debug)
//   trn(n, one, other, vars?) plural: English one / other by n === 1; Russian by the dictionary entry of `one`:
//                            { one, few, many } ("1 (other language)" / "2 (other language)" / "5 (other language)"); {n} in the texts is n
//   lang() / setLang(l)      'en' | 'ru'; setLang switches at once (no reload): <html lang>, the fonts (styles.css
//                            :root[lang="ru"]), every bindText() element, then onLang() callbacks. Saving the choice is the
//                            caller's (Settings / the title selector: hud change('language', l) → settings JSON).
//   bindText(el, en, vars?, attr?)  sets el.textContent (or the attribute) now and again on every language change — for
//                            DOM built once; per-frame text just calls tr() each time it writes
//   onLang(cb) → off()       cb(lang) after a switch (screens rebuilt from data, cached strings)
// First language: ?lang=en|ru (tests; not saved) → the saved settings.language ('en' | 'ru'; 'auto' or none = …) → the
// browser / TV language (ru* → Russian; skipped in automated test browsers — navigator.webdriver — unless ?autolang) → English.
// Dictionaries: src/ui/i18n/ru-core.js (this module's own words), ru-menus.js (title, pause, settings, controls, results,
// tips), ru-hud.js (flight HUD, touch buttons, hit words, levels, markers, moves), ru-game.js (director, enemies, titan,
// player call-outs, boot). A value is a string, or { one, few, many } for trn(). Later files win on a clash;
// tests/i18n.test.mjs reports clashes and missing keys.
import ruCore from './i18n/ru-core.js';
import ruMenus from './i18n/ru-menus.js';
import ruHud from './i18n/ru-hud.js';
import ruGame from './i18n/ru-game.js';

/** A page parameter: the address first, then a host page's preset (globalThis.SKYFIRE_PARAMS, merged the same way by main.js). */
function param(k) {
  try { const q = new URLSearchParams(location.search); if (q.has(k)) return q.get(k); } catch { /* no location */ }
  try { return new URLSearchParams(globalThis.SKYFIRE_PARAMS || '').get(k); } catch { return null; }
}
const ALL_LANGS = { en: 'English' };
/** ?langs=en (the English-only ZIP, 09.11: build_web.py --params "langs=en"): only these languages are used and offered —
 *  with one left, the title's choice and the Settings row are not shown. Unknown or no value: every language. */
function only(list) {
  const keys = String(list || '').split(',').map((s) => s.trim()).filter((l) => ALL_LANGS[l]);
  return keys.length ? Object.fromEntries(keys.map((l) => [l, ALL_LANGS[l]])) : { ...ALL_LANGS };
}
export const LANGS = Object.freeze(only(param('langs')));
/** More than one language to choose from (the title's "English | (other language)" and Settings > Language are shown). */
export const LANG_CHOICE = Object.keys(LANGS).length > 1;
export const DICTS = { ru: { core: ruCore, menus: ruMenus, hud: ruHud, game: ruGame } };
const DICT = { ru: Object.assign({}, ruCore, ruMenus, ruHud, ruGame) };
const SETTINGS_KEY = 'skyfire.settings';
const DEBUG = (() => { try { return new URLSearchParams(location.search).has('debug'); } catch { return false; } })();
const FALLBACK = LANGS.en ? 'en' : Object.keys(LANGS)[0];

function detect() {
  const q = param('lang');
  if (q && LANGS[q]) return q;
  try { const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); if (s && LANGS[s.language]) return s.language; } catch { /* storage blocked */ }
  try {
    // automated test browsers (navigator.webdriver) start in English unless ?lang= is given (this Mac's headless Chrome
    // reports ru-RU; the tests find menu items by their English text); ?autolang keeps the browser rule for testing it
    const auto = new URLSearchParams(location.search).has('autolang');
    if (navigator.webdriver && !auto) return FALLBACK;
    const l = String((navigator.languages && navigator.languages[0]) || navigator.language || '').toLowerCase();
    if (l.startsWith('ru') && LANGS.ru) return 'ru';
  } catch { /* no navigator */ }
  return FALLBACK;
}

let cur = detect();
const missing = new Set();
const bound = new Set();
const listeners = new Set();

function fill(s, vars) {
  return vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m)) : s;
}
function lookup(en) {
  if (cur === 'en') return undefined;
  const v = DICT[cur]?.[en];
  if (v === undefined && !missing.has(en)) {
    missing.add(en);
    if (DEBUG) console.warn(`[i18n] no ${cur} text for`, JSON.stringify(en));
  }
  return v;
}
/** Russian plural form of n: one (1, 21 …), few (2–4, 22–24 …, fractions), many (0, 5–20, 25 …). */
export function ruForm(n) {
  const x = Math.abs(+n);
  if (!Number.isInteger(x)) return 'few';
  const d100 = x % 100, d10 = x % 10;
  if (d100 > 10 && d100 < 20) return 'many';
  if (d10 === 1) return 'one';
  if (d10 > 1 && d10 < 5) return 'few';
  return 'many';
}

export function lang() { return cur; }
export function tr(en, vars) {
  const v = lookup(en);
  const s = typeof v === 'string' ? v : v && typeof v === 'object' ? (v.one ?? v.many ?? en) : en;
  return fill(s, vars);
}
export function trn(n, one, other, vars) {
  const all = { n, ...(vars || {}) };
  if (cur === 'en') return fill(n === 1 ? one : other, all);
  const v = lookup(one);
  if (v && typeof v === 'object') return fill(v[ruForm(n)] ?? v.many ?? v.one ?? other, all);
  if (typeof v === 'string') return fill(v, all);
  return fill(n === 1 ? one : other, all);
}
export function bindText(el, en, vars, attr) {
  if (!el) return el;
  const rec = { ref: typeof WeakRef === 'function' ? new WeakRef(el) : { deref: () => el }, en, vars, attr };
  write(rec, el);
  bound.add(rec);
  return el;
}
function write(rec, el) {
  const s = tr(rec.en, typeof rec.vars === 'function' ? rec.vars() : rec.vars);
  if (rec.attr) el.setAttribute(rec.attr, s); else el.textContent = s;
}
export function onLang(cb) { listeners.add(cb); return () => listeners.delete(cb); }
export function setLang(l) {
  if (!LANGS[l] || l === cur) return false;
  cur = l;
  apply();
  for (const rec of [...bound]) {
    const el = rec.ref.deref();
    if (!el || !el.isConnected) { if (!el) bound.delete(rec); if (!el) continue; }
    try { write(rec, el); } catch { /* element gone */ }
  }
  for (const cb of [...listeners]) { try { cb(cur); } catch (e) { console.warn('[i18n] listener', e); } }
  try { window.dispatchEvent(new CustomEvent('skyfire:lang', { detail: { lang: cur } })); } catch { /* no window */ }
  return true;
}
function apply() {
  try { document.documentElement.lang = cur; } catch { /* no DOM */ }
}
/** Keys asked for in the current language without a text (tests read it: window.__i18n.missing()). */
export function missingKeys() { return [...missing]; }

apply();
try { window.__i18n = { lang, setLang, tr, trn, missing: missingKeys, langs: LANGS }; } catch { /* no window */ }
