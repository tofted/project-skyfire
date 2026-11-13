// Tiny DOM helpers for the HUD. Elements are built once; per-frame code only touches transforms, opacity and
// textContent (never innerHTML), and only when a value actually changed.
import { lang } from './i18n.js';

const SVGNS = 'http://www.w3.org/2000/svg';

/** h('div.a.b', { attrs / on* handlers / style }, children...) */
export function h(sel, props = {}, ...kids) {
  const [tag, ...cls] = sel.split('.');
  const el = document.createElement(tag || 'div');
  if (cls.length) el.className = cls.join(' ');
  applyProps(el, props);
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
}

export function s(sel, props = {}, ...kids) {
  const [tag, ...cls] = sel.split('.');
  const el = document.createElementNS(SVGNS, tag);
  if (cls.length) el.setAttribute('class', cls.join(' '));
  for (const [k, v] of Object.entries(props)) el.setAttribute(k, v);
  for (const k of kids.flat()) if (k) el.append(k);
  return el;
}

function applyProps(el, props) {
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else if (k in el && k !== 'list' && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
}

/** Cached setters: write only when the value changes (keeps style recalcs near zero). */
export function textSetter(el) { let last; return (v) => { if (v !== last) { last = v; el.textContent = v; } }; }
export function styleSetter(el, prop) { let last; return (v) => { if (v !== last) { last = v; el.style[prop] = v; } }; }
export function classSetter(el, name) { let last; return (on) => { on = !!on; if (on !== last) { last = on; el.classList.toggle(name, on); } }; }
export function varSetter(el, name) { let last; return (v) => { if (v !== last) { last = v; el.style.setProperty(name, v); } }; }

// Numbers: English "8,300"; Russian "8 300" (a narrow no-break space, grouping from 10 000 — the Russian convention;
// the same rule as markers.js fmtL). English is unchanged.
const NF_RU = (() => { try { return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0, useGrouping: 'min2' }); } catch { try { return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }); } catch { return null; } } })();
const NF_EN = (() => { try { return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }); } catch { return null; } })();   // cached: same text as toLocaleString('en-US')
export const fmt = (n) => (lang() === 'ru' && NF_RU ? NF_RU.format(Math.round(n)).replace(/[\u00a0 ]/g, '\u202f') : NF_EN ? NF_EN.format(Math.round(n)) : Math.round(n).toLocaleString('en-US'));
