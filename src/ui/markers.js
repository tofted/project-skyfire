// World-anchored HUD: enemy markers, target lock brackets, off-screen arrows (enemies, titan, incoming fireballs)
// and anime damage numbers. Pooled DOM, translate3d per frame, nothing is created or removed while flying.
//
// Built for big waves (wave 2): the sky can hold 14+ riders and drake flocks at once, so markers have tiers —
//   full     name + HP bar + distance: only the locked target, the nearest few, and whoever you just hit
//   mini     a small chevron + a hair-thin HP bar for every other rider on screen
//   flock    one aggregated marker per drake flock ("DRAKE FLOCK ×5", summed HP) at the flock's centre
// Off-screen: the titan and the locked target get their own arrows; everything else is clustered by direction into
// at most a handful of arrows with a count ("×3") and the nearest distance. Incoming fireballs have their own arrows.
import * as THREE from 'three';
import { h, s as svgEl, fmt } from './dom.js';
import { tr, lang } from './i18n.js';

// ---------------------------------------------------------------------------------------------------- languages
// (29.09, the user: "a language choice: Russian and English") The HUD's per-frame words go through tr() (src/ui/i18n.js;
// Russian texts in src/ui/i18n/ru-hud.js); English stays byte-identical. Two helpers for the per-frame writers:
/** A one-number template ('{n} m') as a fast formatter: pre + n + post, split again only when the language changes (no
 *  template fill per frame). get() returns the template in the current language (a literal tr() call). */
export function tplN(get) {
  let L = null, pre = '', post = '';
  return (n) => {
    const l = lang();
    if (l !== L) { L = l; const t = String(get()); const i = t.indexOf('{n}'); pre = i < 0 ? t + ' ' : t.slice(0, i); post = i < 0 ? '' : t.slice(i + 3); }
    return pre + n + post;
  };
}
// (Russian: no separator in a 4-digit number — "1032", "10 320" — and the narrow no-break space U+202F between the groups:
// the font's full space read as two numbers, "1  032")
const NF_RU = typeof Intl === 'object' && Intl.NumberFormat ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0, useGrouping: 'min2' }) : null;
/** dom.js fmt in the current language: English "1,250" (as before), Russian "1250", "12 500" (a comma is the decimal
 *  mark there). */
export const fmtL = (n) => (lang() === 'ru' && NF_RU ? NF_RU.format(Math.round(n)).replace(/[\u00a0 ]/g, '\u202f') : fmt(n));
/** A one-number plural text as a cached formatter (one entry: for a single per-frame writer — the wave strip, the boss
 *  bar): get(n) is a literal trn() call, asked again only when n or the language changes. */
export function plN(get) {
  let L = null, N = null, S = '';
  return (n) => { const l = lang(); if (l !== L || n !== N) { L = l; N = n; S = String(get(n)); } return S; };
}
/** Distance label ("340 m" / "340 (other language)"). */
export const mText = tplN(() => tr('{n} m'));

// Diamond lock brackets: four corner chevrons around a thin inner diamond.
function lockSVG() {
  const d = 'M26 3 L33 10 M26 3 L19 10 M49 26 L42 33 M49 26 L42 19 M26 49 L33 42 M26 49 L19 42 M3 26 L10 33 M3 26 L10 19';
  return svgEl('svg', { viewBox: '0 0 52 52' }, svgEl('path', { class: 'lk-o', d }), svgEl('path', { class: 'lk-i', d: 'M26 14 L38 26 L26 38 L14 26 Z' }));
}

const _v = new THREE.Vector3();

/** Project a world point. out = { x, y (px), cx, cy (camera space, y up), z (distance in front, m), onScreen } */
export function project(cam, p, w, hgt, out, margin = 0) {
  _v.copy(p).applyMatrix4(cam.matrixWorldInverse);
  out.cx = _v.x; out.cy = _v.y; out.z = -_v.z;
  if (out.z <= 0.5) { out.onScreen = false; return out; }
  _v.applyMatrix4(cam.projectionMatrix);
  out.x = (_v.x * 0.5 + 0.5) * w; out.y = (-_v.y * 0.5 + 0.5) * hgt;
  out.onScreen = out.x >= -margin && out.x <= w + margin && out.y >= -margin && out.y <= hgt + margin;
  return out;
}

// (names stay English on the actors — code tests them; the screen shows tr(name): ru-game.js has them)
const upper = (s) => tr(String(s || 'Shade Rider')).toUpperCase();

/** Tuning (exported for tests / the sandbox). */
export const MARKER_RULES = {
  fullNearest: 3,        // nearest on-screen riders that get a full name plate (plus the locked one and recent hits)
  fullMax: 5,            // hard cap of full plates on screen
  fullRange: 1500,       // m: beyond this only the locked target / a recent hit gets a full plate
  miniRange: 3400,       // m: minis fade out towards this distance
  arrowRange: 2600,      // m: off-screen riders farther than this get no arrow (the titan and the lock always do)
  clusterAngle: 0.2,     // rad: off-screen enemies within this bearing share one arrow
  enemyArrows: 5,        // clustered enemy arrows (titan + lock are extra)
  shotArrows: 3,         // incoming fireball arrows
};

export class Markers {
  constructor(root, { full = 6, mini = 32, flocks = 6, arrows = 8, shots = 4 } = {}) {
    this.root = root;
    this.pool = [];                 // full plates
    for (let i = 0; i < full; i++) {
      const name = h('div.mk-name'), fill = h('i.fill'), chip = h('i.chip'), dist = h('div.mk-dist');
      const lock = h('div.mk-lock', {}, lockSVG());
      const el = h('div.mk', { style: { opacity: '0' } }, h('div.mk-chev'), lock, h('div.mk-in', {}, name, h('div.bar', {}, chip, fill), dist));
      root.append(el);
      this.pool.push({ el, name, fill, chip, dist, actor: null, last: {}, hpShown: null });
    }
    this.minis = [];
    for (let i = 0; i < mini; i++) {
      const fill = h('i.fill');
      const el = h('div.mk.mini', { style: { opacity: '0' } }, h('div.mk-chev'), h('div.mk-in', {}, h('div.bar', {}, fill)));
      root.append(el);
      this.minis.push({ el, fill, last: {} });
    }
    this.flocks = [];
    for (let i = 0; i < flocks; i++) {
      const name = h('div.mk-name'), fill = h('i.fill'), dist = h('div.mk-dist'), n = h('b.fk-n');
      const el = h('div.mk.flock', { style: { opacity: '0' } }, h('div.fk-ic', {}, h('i'), h('i'), h('i')),
        h('div.mk-in', {}, h('div.fk-row', {}, name, n), h('div.bar', {}, fill), dist));
      root.append(el);
      this.flocks.push({ el, name, n, fill, dist, last: {} });
    }
    this.arrows = [];
    for (let i = 0; i < arrows + shots; i++) {
      const n = h('em'), d = h('span'); const el = h('div.arr', { style: { opacity: '0' } }, h('i'), h('b', {}, n, d));
      root.append(el);
      this.arrows.push({ el, b: d, n, last: {} });
    }
    this.nShotArrows = shots;
    this.pr = { x: 0, y: 0, cx: 0, cy: 0, z: 0, onScreen: false };
    // screen rects [[l, t, r, b], …] the off-screen arrows keep out of (hud.js: the touch buttons, the PAUSE /
    // FULLSCREEN pair, the Minimal HUD's top-right panel): an arrow slides along the edge ellipse past them
    this.avoid = [];
    // world-HUD scale (hud.js, touch mode: 2 at 4K; styles.css zooms the marker parts by the same --z): the edge
    // insets, the arrows' spacing and the plates' overlap test grow with it (1 = the desktop, as before)
    this.scale = 1;
    // the Minimal HUD (hud.js; the user: "show LESS information"): a full plate (name, HP, distance) only for the locked
    // target and the aim assist's soft target (list item .soft); every other rider a mini (chevron + thin HP bar); the
    // flock plates and the arrows lose their words / distances (styles.css .hud.min)
    this.minimal = false;
    this.blocked = 0;                 // plates / minis / flocks out of sight this frame: their box lay on a control (avoid)
    this.recent = new WeakMap();      // actor -> time of last damage by the player (plates stay full for 4 s)
    this.rules = { ...MARKER_RULES };
    // per-frame scratch (reused; no allocations while flying)
    this._on = []; this._off = []; this._clusters = []; this._shots = []; this._fullList = []; this._recs = []; this._ri = 0;
    this.stats = { full: 0, mini: 0, flock: 0, arrows: 0, shotArrows: 0, clustered: 0 };
  }

  noteDamage(actor, t) { if (actor) this.recent.set(actor, t); }

  /**
   * list: [{ actor, kind: 'dragon'|'titan'|'flock'|'shot', locked, pos?, soon?, count?, hp?, maxHp?, label? }]
   * ppos: player position for distance text.
   */
  update(cam, w, hgt, list, ppos, now) {
    const R = this.rules, pr = this.pr;
    const on = this._on, off = this._off, shots = this._shots;
    on.length = 0; off.length = 0; shots.length = 0;
    this.placed = [];
    // Off-screen arrows ride an ellipse inside the screen edge. On a portrait phone it stays clear of the player panel
    // (top) and the touch buttons (bottom).
    const S = this.scale > 0 ? this.scale : 1;
    const ins = w < 600 && hgt > w ? { t: 118, b: 272, s: 30 } : { t: 42 * S, b: 42 * S, s: 42 * S };
    const edgeRX = w / 2 - ins.s, edgeRY = (hgt - ins.t - ins.b) / 2;
    this._cx = w / 2; this._cy = ins.t + edgeRY;
    let oi = 0, fi = 0;
    this._ri = 0;
    this.blocked = 0;
    // ---- classify
    for (const it of list) {
      const a = it.actor;
      const pos = it.pos || a?.pos;
      if (!pos) continue;
      const dist = ppos ? pos.distanceTo(ppos) : pos.distanceTo(cam.position);
      if (it.kind === 'shot') {
        project(cam, pos, w, hgt, pr, -40);
        if (!pr.onScreen) shots.push(this._rec(it, pr, dist, 0, 0));
        continue;
      }
      const lift = it.kind === 'titan' || it.kind === 'flock' ? 0 : Math.max(3, (a?.radius || 8) * 0.45);
      _anchor.copy(pos); _anchor.y += lift;
      project(cam, _anchor, w, hgt, pr, -30);
      const recent = a && now - (this.recent.get(a) ?? -99) < 4 ? 1 : 0;
      if (pr.onScreen) on.push(this._rec(it, pr, dist, 0, recent));
      else off.push(this._rec(it, pr, dist, Math.atan2(pr.cy, pr.cx), recent));
    }
    // ---- on screen
    // priority: locked, then recently hit, then distance
    on.sort((x, y) => (y.it.locked - x.it.locked) || (y.recent - x.recent) || (x.dist - y.dist));
    const full = this._fullList; full.length = 0;
    let nearestUsed = 0, mi = 0;
    for (const r of on) {
      const it = r.it, a = it.actor;
      if (it.kind === 'flock') {
        if (fi < this.flocks.length) this._flock(this.flocks[fi++], r);
        continue;
      }
      if (it.kind === 'titan') {                  // the titan has the boss bar; only its lock brackets show
        if (it.locked && oi < this.pool.length) this._full(this.pool[oi++], r, 'titan');
        continue;
      }
      let wantFull = this.minimal ? !!(it.locked || it.soft)
        : it.locked || (r.recent && full.length < R.fullMax) || (nearestUsed < R.fullNearest && r.dist < R.fullRange);
      // two full plates touching help nobody: the farther one becomes a mini (plate width ≈ its name's width)
      r.w = plateWidth(a?.name) * S;
      if (wantFull && !it.locked && full.some((q) => Math.abs(q.x - r.x) < (q.w + r.w) / 2 + 10 * S && Math.abs(q.y - r.y) < 42 * S)) wantFull = false;
      if (wantFull && oi < this.pool.length && full.length < R.fullMax + (it.locked ? 1 : 0)) {
        if (!it.locked && !r.recent) nearestUsed++;
        full.push(r);
        this._full(this.pool[oi++], r, '');
      } else if (mi < this.minis.length) {
        const fade = r.recent ? 1 : clamp01(1.25 - r.dist / R.miniRange);
        if (fade > 0.05) this._mini(this.minis[mi++], r, Math.max(0.3, fade));
      }
    }
    for (let k = oi; k < this.pool.length; k++) hide(this.pool[k]);
    for (let k = mi; k < this.minis.length; k++) hide(this.minis[k]);
    for (let k = fi; k < this.flocks.length; k++) hide(this.flocks[k]);
    // ---- off screen: titan and lock alone, everything else clustered by bearing
    let ai = 0;
    const nEnemyArrows = this.arrows.length - this.nShotArrows;
    off.sort((x, y) => (y.it.locked - x.it.locked) || ((y.it.kind === 'titan') - (x.it.kind === 'titan')) || (x.dist - y.dist));
    const clusters = this._clusters; clusters.length = 0;
    let clustered = 0;
    for (const r of off) {
      const it = r.it;
      if (it.kind === 'titan' || it.locked) {
        if (ai < nEnemyArrows) this._arrow(this.arrows[ai++], r.ang, w, hgt, edgeRX, edgeRY, (it.kind === 'titan' ? 'titan' : '') + (it.locked ? ' locked' : ''), r.dist, 1, 1);
        continue;
      }
      if (r.dist > R.arrowRange * (it.kind === 'flock' ? 1.2 : 1)) continue;
      const n = it.kind === 'flock' ? (it.count || 1) : 1;
      let c = null;
      for (const q of clusters) { if (Math.abs(angDiff(q.ang, r.ang)) < R.clusterAngle) { c = q; break; } }
      if (!c && clusters.length >= R.enemyArrows) {   // over the cap: join the closest bearing
        let best = Infinity;
        for (const q of clusters) { const d = Math.abs(angDiff(q.ang, r.ang)); if (d < best) { best = d; c = q; } }
      }
      if (c) { c.n += n; c.dist = Math.min(c.dist, r.dist); clustered++; }
      else clusters.push({ ang: r.ang, n, dist: r.dist, flock: it.kind === 'flock' });
    }
    for (const c of clusters) {
      if (ai >= nEnemyArrows) break;
      this._arrow(this.arrows[ai++], c.ang, w, hgt, edgeRX, edgeRY, c.flock && c.n > 1 ? 'flock' : '', c.dist, c.n, clamp01(1.25 - c.dist / R.arrowRange));
    }
    const enemyArrows = ai;
    // ---- incoming fireballs (soonest first)
    shots.sort((x, y) => (y.it.soon - x.it.soon) || (x.dist - y.dist));
    let si = 0;
    for (const r of shots) {
      if (si >= R.shotArrows || ai >= this.arrows.length) break;
      this._arrow(this.arrows[ai++], Math.atan2(r.cy, r.cx), w, hgt, edgeRX, edgeRY, 'shot' + (r.it.soon ? ' soon' : ''), 0, 1, 1);
      si++;
    }
    for (let k = ai; k < this.arrows.length; k++) { const r = this.arrows[k]; setIf(r, 'op', '0', (v) => { r.el.style.opacity = v; }); }
    const st = this.stats;
    st.full = oi; st.mini = mi; st.flock = fi; st.arrows = enemyArrows; st.shotArrows = si; st.clustered = clustered;
  }

  _rec(it, pr, dist, ang, recent) {
    let r = this._recs[this._ri];
    if (!r) { r = {}; this._recs[this._ri] = r; }
    this._ri++;
    r.it = it; r.x = pr.x; r.y = pr.y; r.cx = pr.cx; r.cy = pr.cy; r.dist = dist; r.ang = ang; r.recent = recent;
    return r;
  }

  /**
   * A world marker whose estimated box (offsets from its anchor, CSS px at scale 1: [l, t, r, b]) would lie on one of
   * the avoid rects (touch mode / Minimal HUD: the buttons, the stick, PAUSE / FULLSCREEN, the top-right panel) steps
   * out of sight (opacity 0) until it is clear: nothing is drawn over — or shows through — a control. Arithmetic on the
   * numbers only (no layout reads). Desktop Full HUD: no avoid rects, never hidden.
   */
  _blocked(x, y, l, t, rr, b) {
    const A = this.avoid;
    if (!A || !A.length) return false;
    const S = this.scale > 0 ? this.scale : 1;
    if (!inAvoidBox(A, x + l * S, y + t * S, x + rr * S, y + b * S)) return false;
    this.blocked++;
    return true;
  }

  _full(m, r, cls) {
    const it = r.it, a = it.actor;
    const fade = it.locked || r.recent ? 1 : clamp01(1 - (r.dist - 450) / 1300);
    const far = !it.locked && !r.recent && r.dist > 800;
    // the plate's box (styles.css .mk: name / bar / distance column 14 px over the anchor; lock brackets ±32, the
    // titan's ±40; a far plate is a short bar)
    const hw = plateWidth(a?.name) / 2;
    const off = cls === 'titan' ? this._blocked(r.x, r.y, -42, -42, 42, 42)
      : it.locked ? this._blocked(r.x, r.y, -Math.max(hw, 34), -74, Math.max(hw, 34), 34)
        : far ? this._blocked(r.x, r.y, -26, -28, 26, 7) : this._blocked(r.x, r.y, -hw, -60, hw, 7);
    setIf(m, 'tf', `translate3d(${r.x.toFixed(1)}px, ${r.y.toFixed(1)}px, 0)`, (v) => { m.el.style.transform = v; });
    setIf(m, 'op', off ? '0' : Math.max(0.35, fade).toFixed(2), (v) => { m.el.style.opacity = v; });
    setIf(m, 'cls', `mk${far ? ' far' : ''}${it.locked ? ' locked' : ''}${cls ? ' ' + cls : ''}${it.drake ? ' drake' : ''}`, (v) => { m.el.className = v; });
    if (m.actor !== a) { m.actor = a; m.hpShown = null; }
    setIf(m, 'name', upper(a.name), (v) => { m.name.textContent = v; });
    setIf(m, 'dist', mText(Math.round(r.dist)), (v) => { m.dist.textContent = v; });
    const f = a.maxHp > 0 ? clamp01(a.hp / a.maxHp) : 1;
    setIf(m, 'hp', f.toFixed(3), (v) => {
      m.fill.style.transform = `scaleX(${v})`;
      m.chip.style.transition = m.hpShown === null || f > m.hpShown ? 'none' : '';
      m.chip.style.transform = `scaleX(${v})`;
      m.hpShown = f;
    });
  }

  _mini(m, r, fade) {
    const it = r.it, a = it.actor;
    const off = this._blocked(r.x, r.y, -21, -15, 21, 6);
    setIf(m, 'tf', `translate3d(${r.x.toFixed(1)}px, ${r.y.toFixed(1)}px, 0)`, (v) => { m.el.style.transform = v; });
    setIf(m, 'op', off ? '0' : fade.toFixed(2), (v) => { m.el.style.opacity = v; });
    setIf(m, 'cls', `mk mini${it.drake ? ' drake' : ''}${r.recent ? ' hit' : ''}`, (v) => { m.el.className = v; });
    const f = a.maxHp > 0 ? clamp01(a.hp / a.maxHp) : 1;
    setIf(m, 'hp', f.toFixed(2), (v) => { m.fill.style.transform = `scaleX(${v})`; });
  }

  _flock(m, r) {
    const it = r.it;
    const fade = clamp01(1.3 - r.dist / (this.rules.miniRange * 1.1));
    // (Minimal HUD / a far flock: the icon, "×5" and the bar only — styles.css; else the name and the distance too)
    const off = this.minimal || r.dist > 900 ? this._blocked(r.x, r.y, -36, -42, 36, 7) : this._blocked(r.x, r.y, -62, -58, 62, 7);
    setIf(m, 'tf', `translate3d(${r.x.toFixed(1)}px, ${r.y.toFixed(1)}px, 0)`, (v) => { m.el.style.transform = v; });
    setIf(m, 'op', off ? '0' : Math.max(0.4, fade).toFixed(2), (v) => { m.el.style.opacity = v; });
    setIf(m, 'cls', `mk flock${r.dist > 900 ? ' far' : ''}`, (v) => { m.el.className = v; });
    setIf(m, 'name', it.label ? tr(it.label) : tr('DRAKE FLOCK'), (v) => { m.name.textContent = v; });
    setIf(m, 'n', `×${it.count || 0}`, (v) => { m.n.textContent = v; });
    setIf(m, 'dist', mText(Math.round(r.dist)), (v) => { m.dist.textContent = v; });
    const f = it.maxHp > 0 ? clamp01(it.hp / it.maxHp) : 1;
    setIf(m, 'hp', f.toFixed(3), (v) => { m.fill.style.transform = `scaleX(${v})`; });
  }

  _arrow(r, ang, w, hgt, rx, ry, cls, dist, n, alpha) {
    // Direction in camera space (x right, y up); behind the camera it still points to the correct side.
    if (!Number.isFinite(ang)) ang = -Math.PI / 2;
    // Arrows in nearly the same direction slide apart along the screen edge instead of stacking (and off the HUD's
    // buttons / panels in this.avoid: up to ±1 rad along the ellipse).
    let x = 0, y = 0, found = false;
    const A = this.avoid, steps = A?.length ? 29 : 7, S = this.scale > 0 ? this.scale : 1;
    for (let k = 0; k < steps; k++) {
      const a = ang + (k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.07);
      x = this._cx + Math.cos(a) * rx; y = this._cy - Math.sin(a) * ry;
      if (!this.placed.some((q) => Math.abs(q[0] - x) < 36 * S && Math.abs(q[1] - y) < 32 * S) && !(A?.length && inAvoid(A, x, y, 24 * S))) { ang = a; found = true; break; }
    }
    // (touch mode on a small screen: the whole stretch of the edge is under the buttons) — the arrow comes inward along
    // its own direction until it is clear of them, so it still points the true way
    if (!found && A?.length) {
      const ex = this._cx + Math.cos(ang) * rx, ey = this._cy - Math.sin(ang) * ry;
      for (let t = 0.08; t <= 0.72; t += 0.08) {
        x = ex + (this._cx - ex) * t; y = ey + (this._cy - ey) * t;
        if (!inAvoid(A, x, y, 24 * S)) break;
      }
    }
    this.placed.push([x, y]);
    const rot = Math.atan2(-Math.sin(ang) * ry, Math.cos(ang) * rx);
    setIf(r, 'tf', `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`, (v) => { r.el.style.transform = v; });
    setIf(r, 'rot', rot.toFixed(3), (v) => { r.el.firstChild.style.transform = `rotate(${v}rad)`; });
    setIf(r, 'op', Math.max(0.35, alpha).toFixed(2), (v) => { r.el.style.opacity = v; });
    setIf(r, 'cls', 'arr ' + cls + (n > 1 ? ' multi' : ''), (v) => { r.el.className = v; });
    setIf(r, 'lbl', dist > 0 && dist < 10000 ? mText(Math.round(dist)) : '', (v) => { r.b.textContent = v; });
    setIf(r, 'n', n > 1 ? `×${n}` : '', (v) => { r.n.textContent = v; });
  }
}

const _anchor = new THREE.Vector3();
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
/** Name plate width in px: 10.5 px bold caps with .18em tracking ≈ 9 px per character, at least the 84 px bar. */
function plateWidth(name) { return Math.max(88, tr(String(name || 'Shade Rider')).length * 9); }
function angDiff(a, b) { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }
function inAvoid(list, x, y, pad) { for (const r of list) if (r && x > r[0] - pad && x < r[2] + pad && y > r[1] - pad && y < r[3] + pad) return true; return false; }
/** The box [l, t, r, b] (screen px) overlaps one of the rects. */
function inAvoidBox(list, l, t, rr, b) { for (const r of list) if (r && l < r[2] && rr > r[0] && t < r[3] && b > r[1]) return true; return false; }
function setIf(o, k, v, fn) { if (o.last[k] !== v) { o.last[k] = v; fn(v); } }
function hide(m) { setIf(m, 'op', '0', (v) => { m.el.style.opacity = v; }); }

// ---------------------------------------------------------------------------------------------------- damage numbers
// Wave 5: numbers keep out of HUD panels (the speed / altitude readouts): a number whose box would touch a panel is
// held beside it — on the nearer side that stays on screen, chosen once per number so it never flips — at once (a
// number never sits on a panel), and glides back to its hit point when the point leaves the panel; if the point
// leaves on the far side, the number hops over rather than gliding across. Its size is estimated from the text.
const DN_FONT = { '': 26, fire: 26, crit: 36, player: 24, kill: 22, combo: 22 };
const DN_TRACK = { kill: 0.18, combo: 0.1 };
/** Half extents (px) of a number's text: condensed italic digits ≈ 0.52 em, + tracking, + the 5 px outline. */
function dnHalf(text, kind) {
  const fs = DN_FONT[kind] ?? 26;
  let w = String(text).length * fs * (0.52 + (DN_TRACK[kind] || 0)) + 10;
  if (kind === 'crit') w += 5 * 15 * 0.72;              // " CRIT" (::after, 15 px, .12em tracking; Russian " (other language)" the same)
  return [w / 2, fs * 0.5 + 5];
}
// px kept from a panel; px/s a number is pushed out at (≈ at once); 1/s glide back to its point once released
export const DN_AVOID = { pad: 6, push: 2400, glide: 16 };

export class DamageNumbers {
  constructor(root, n = 40) {
    this.pool = [];
    for (let i = 0; i < n; i++) {
      const span = h('span'); const el = h('div.dn', { style: { opacity: '0' } }, span);
      root.append(el);
      this.pool.push({ el, span, t: 99, life: 0.95, pos: new THREE.Vector3(), jx: 0, on: false, hw: 20, hh: 18, ox: 0, side: 0, fresh: true, x: 0, y: 0 });
    }
    this.next = 0;
    this.pr = { x: 0, y: 0, cx: 0, cy: 0, z: 0, onScreen: false };
    this.enabled = true;
    /** Screen rects the numbers keep out of: [[left, top, right, bottom], …] (hud.js passes the readouts). */
    this.avoid = [];
    this.scale = 1;              // world-HUD scale (touch mode, big screens): the keep-out half sizes follow the zoom
    this.stats = { spawned: 0, nudged: 0 };
  }

  /** kind: '' | 'fire' | 'crit' | 'player' | 'kill' | 'combo' */
  spawn(pos, text, kind = '') {
    if (!this.enabled || !pos) return;
    const d = this.pool[this.next]; this.next = (this.next + 1) % this.pool.length;
    d.pos.copy(pos); d.t = 0; d.on = true;
    d.life = kind === 'combo' ? 1.35 : kind === 'kill' ? 1.3 : kind === 'crit' ? 1.15 : 0.95;
    // numbers pop beside the hit, alternating sides, so they do not bury the target's name plate
    this.side = -(this.side || 1);
    d.jx = kind === 'kill' || kind === 'player' || kind === 'combo' ? 0 : this.side * (34 + Math.random() * 30);
    d.dy = kind === 'combo' ? 96 : kind === 'kill' ? 64 : -6;   // "DOWN!" floats above the killing blow's number, the combo above that
    d.el.className = 'dn' + (kind ? ' ' + kind : '');
    d.span.textContent = text;
    [d.hw, d.hh] = dnHalf(text, kind);
    if (this.scale > 0 && this.scale !== 1) { d.hw *= this.scale; d.hh *= this.scale; d.jx *= this.scale; d.dy *= this.scale; }
    d.ox = 0; d.side = 0; d.fresh = true; d.rect = null;
    this.stats.spawned++;
    const big = d.big = kind === 'crit' ? 1.5 : kind === 'kill' || kind === 'combo' ? 1.25 : 1.35;
    d.span.animate([
      { transform: 'translate(-50%, -50%) scale(0.3)' },
      { transform: `translate(-50%, -50%) scale(${big})`, offset: 0.4 },
      { transform: 'translate(-50%, -50%) scale(1)' },
    ], { duration: 190, easing: 'cubic-bezier(.3, 1.6, .5, 1)' });
    if (kind === 'crit') d.span.animate([{ marginLeft: '-4px' }, { marginLeft: '4px' }, { marginLeft: '-2px' }, { marginLeft: '0px' }], { duration: 60, delay: 90 });
  }

  update(cam, w, hgt, dt) {
    for (const d of this.pool) {
      if (!d.on) continue;
      d.t += dt;
      if (d.t >= d.life) { d.on = false; d.el.style.opacity = '0'; continue; }
      project(cam, d.pos, w, hgt, this.pr, 60);
      if (!this.pr.onScreen) { d.el.style.opacity = '0'; continue; }
      const sc = this.scale > 0 ? this.scale : 1;
      const k = d.t / 0.9, rise = (d.dy > 30 * sc ? 30 : 32) * sc * (1 - Math.pow(1 - Math.min(1, k), 3));
      const fade = d.t > d.life - 0.25 ? (d.life - d.t) / 0.25 : 1;
      const x0 = this.pr.x + d.jx, y = this.pr.y - d.dy - rise;
      const want = this._keepOut(d, x0, y, w);
      const st = Math.min(0.1, dt), R = d.rect;
      if (d.fresh) d.ox = want;                                        // appears beside the panel, never on it
      else if (want === 0 && d.ox !== 0 && R && y > R[1] && y < R[3] && (x0 + d.ox < R[0]) !== (x0 < R[0])) d.ox = 0;   // its point left on the far side: hop over
      else if (want * d.ox >= 0 && Math.abs(want) >= Math.abs(d.ox)) d.ox += Math.max(-DN_AVOID.push * st, Math.min(DN_AVOID.push * st, want - d.ox));   // pushed: held at the panel's edge
      else d.ox += (want - d.ox) * (1 - Math.exp(-DN_AVOID.glide * st));   // released: glide back to its point
      d.fresh = false;
      d.x = x0 + d.ox; d.y = y;
      d.el.style.transform = `translate3d(${d.x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
      d.el.style.opacity = fade.toFixed(2);
    }
  }

  /** Sideways offset that takes number d (natural centre x0, y) out of every keep-out rect; 0 when it touches none. */
  _keepOut(d, x0, y, w) {
    const A = this.avoid;
    if (!A || !A.length) { d.side = 0; return 0; }
    // during the 190 ms pop the text is up to d.big × its size: keep that much room, then settle in
    const pop = d.t < 0.2 ? (d.big || 1) - 1 : 0;
    const hw = d.hw * (1 + pop) + DN_AVOID.pad, hh = d.hh * (1 + pop) + DN_AVOID.pad;
    for (const r of A) {
      if (!r) continue;
      const l = r[0] - hw, t = r[1] - hh, rr = r[2] + hw, b = r[3] + hh;
      if (x0 <= l || x0 >= rr || y <= t || y >= b) continue;
      if (!d.side) {
        // the nearer way out, unless it would push the number off the screen
        const leftOk = l - d.hw >= 2, rightOk = rr + d.hw <= w - 2;
        d.side = (x0 - l <= rr - x0 ? leftOk || !rightOk : !rightOk && leftOk) ? -1 : 1;
        this.stats.nudged++;
      }
      d.rect = d.rect || [0, 0, 0, 0];
      d.rect[0] = l; d.rect[1] = t; d.rect[2] = rr; d.rect[3] = b;      // the panel it is held beside (expanded)
      return (d.side < 0 ? l : rr) - x0;
    }
    d.side = 0;                                         // out of every panel: the next one picks its own way out
    return 0;
  }
}

// ---------------------------------------------------------------------------------------------------- weak points
// The titan's weak points while a damage window is open: a pulsing gold ring on the part with its multiplier —
// "WEAK ×1.5" on a hand mid-strike, "CORE OPEN ×7.5" while the core blazes open. Source: game.titan.weakPoints()
// ([{ part, mult, pos, open }], titan owner, wave 4); without it, a core / hand shape whose `mult` rose above the
// lowest value that shape has had. A permanent multiplier (the head, the closed core) gets no ring. Three pooled
// elements; transform / opacity / text only when changed.
const WEAK_PARTS = /^(core|handL|handR)$/;
export class WeakPoints {
  constructor(root, n = 3) {
    this.pool = [];
    for (let i = 0; i < n; i++) {
      const lbl = h('b');
      const el = h('div.wk', { style: { opacity: '0' } }, h('i.wk-ring'), lbl);
      root.append(el);
      this.pool.push({ el, lbl, last: {} });
    }
    this.base = new Map();          // shape -> lowest mult seen (fallback path)
    this.actor = null;
    // hud.js: the world-HUD scale, the Minimal HUD ("WEAK" / "CORE OPEN" without the multiplier: less to read) and the
    // controls' rects (a ring whose box lies on one steps out of sight, as the markers do)
    this.scale = 1; this.minimal = false; this.avoid = []; this.blocked = 0;
    this.pr = { x: 0, y: 0, cx: 0, cy: 0, z: 0, onScreen: false };
    this._c = new THREE.Vector3();
    this._list = [];
    this.shown = 0;
  }
  /** Weak points open right now: [{ part, mult, pos }] (reused array). */
  _open(titan, sys) {
    const out = this._list; out.length = 0;
    if (typeof sys?.weakPoints === 'function') {
      let wp = null;
      try { wp = sys.weakPoints(); } catch { wp = null; }
      if (Array.isArray(wp)) {
        for (const p of wp) if (p?.pos && typeof p.mult === 'number' && (p.part !== 'core' || p.open)) out.push(p);
        return out;
      }
    }
    if (titan !== this.actor) { this.actor = titan; this.base.clear(); }
    for (const s of titan?.shapes || []) {
      if (!s || !WEAK_PARTS.test(s.part || '') || typeof s.mult !== 'number' || !s.a) continue;
      const b = this.base.get(s);
      if (b === undefined || s.mult < b) { this.base.set(s, s.mult); continue; }
      if (s.mult >= Math.max(1.5, b + 0.25)) out.push({ part: s.part, mult: s.mult, pos: s.b ? this._c.copy(s.a).add(s.b).multiplyScalar(0.5) : s.a, open: s.part === 'core' });
    }
    return out;
  }
  update(cam, w, hgt, titan, sys = null) {
    let k = 0;
    this.blocked = 0;
    const list = titan ? this._open(titan, sys) : null;
    if (list) {
      for (const p of list) {
        if (k >= this.pool.length) break;
        project(cam, p.pos, w, hgt, this.pr);
        if (!this.pr.onScreen) continue;
        const m = this.pool[k++];
        const core = p.part === 'core';
        // inside the reticle (the player is already aiming at it) the ring stays and the label steps aside: the
        // reticle's arcs, "IN RANGE" and the label must not stack on one spot
        const nearAim = Math.abs(this.pr.x - w / 2) < 130 && Math.abs(this.pr.y - hgt / 2) < 130;
        const aim = nearAim ? (this.pr.x + 210 > w ? ' aim l' : ' aim') : '';     // to the left when the right edge is near
        const word = core ? tr('CORE OPEN') : tr('WEAK');
        const txt = this.minimal ? word : `${word} ×${lang() === 'ru' ? String(+p.mult.toFixed(1)).replace('.', ',') : +p.mult.toFixed(1)}`;
        setIf(m, 'txt', txt, (v) => { m.lbl.textContent = v; });
        setIf(m, 'cls', (core ? 'wk core' : 'wk') + aim, (v) => { m.el.className = v; });
        m.el.style.transform = `translate3d(${this.pr.x.toFixed(1)}px, ${this.pr.y.toFixed(1)}px, 0)`;
        // its box (styles.css .wk: the ring ±20 / ±28, the label 42 / 50 px above it, or beside it at the reticle)
        let off = false;
        if (this.avoid?.length) {
          const S = this.scale > 0 ? this.scale : 1, R = core ? 30 : 22, lw = txt.length * 5 + 8, x = this.pr.x, y = this.pr.y;
          const box = !aim ? [-Math.max(R, lw), -(core ? 52 : 44), Math.max(R, lw), R]
            : aim === ' aim' ? [-R, -R, 76 + 2 * lw, R] : [-76 - 2 * lw, -R, R, R];
          off = inAvoidBox(this.avoid, x + box[0] * S, y + box[1] * S, x + box[2] * S, y + box[3] * S);
          if (off) this.blocked++;
        }
        setIf(m, 'op', off ? '0' : '1', (v) => { m.el.style.opacity = v; });
      }
    }
    this.shown = k;
    for (let i = k; i < this.pool.length; i++) hide(this.pool[i]);
  }
}
