// Levels and elements in the HUD (the user: "the more enemies the dragon kills, the higher its level; each level the
// fire gets stronger and HP grows; the fire changes colour, and later it shoots lightning").
// game.progress (system 'progress', src/actors/progression.js, owned by gameplay) is read, never written:
//   { level 1..10, xp, xpLevel, xpNext, tier, element 'ember'|'azure'|'radiant'|'lightning'|'storm', dmgMult, hpMult, chain }
// events 'xp' { amount, total, source } and 'levelup' { level, prev, tier, prevTier, element, elementChanged, hpGain }.
//   badge      "LV 7" with the element's icon (flame / bolt) and colour, in the player panel before "SORA & KAEDE"
//   XP bar     a thin bar under the stamina bar + "90 / 120 XP" (in-level progress; "MAX LEVEL" at the top); a gain
//              flashes its segment white, a level-up fills it, flashes and starts the next level from the carry-over
//   cut-in     "LEVEL UP!" slides in from the left in the upper-left third (never over the centre of the view): the new
//              level ("LV 6 › LV 7"), "+48 MAX HP · +12% DAMAGE" and, when the element changes, its name ("AZURE
//              FLAME", "RADIANT FLAME", "LIGHTNING BREATH", "STORM DRAGON") with an edge flash in its colour; 1.6 s
//              (1.9 s with an element change); two level-ups close together merge into one ("LV 5 › LV 7"). Held back
//              while a cinematic plays (the HUD is hidden then) and shown when it ends.
// Without game.progress nothing is shown (feature detection). The level-up comes from the event; a level that rises
// without one (polled) gets the same cut-in. A level that drops (a new run) resets silently.
// Pooled DOM built once; per frame only transform / opacity / text when a value changed. The cut-in's animations are
// paused Web Animations driven by its own clock (capped real dt; 0 while paused), so a long frame never eats it.
import { h, textSetter, classSetter, styleSetter } from './dom.js';
import { tr, lang, bindText, onLang } from './i18n.js';
import { fmtL as fmt } from './markers.js';

// Languages (29.09): ELEMENTS, levelUpView() and levelSummary() stay English DATA (tests, the results screen, events); what
// the badge, the XP row and the cut-in SHOW goes through tr() (Russian: src/ui/i18n/ru-hud.js — the element names, titles
// and descriptions are there for every screen that shows them: tr(name) / tr(title) / tr(desc, { chain })).
/** An element's words in the current language (literal keys). */
export const ELEMENT_TR = {
  ember: { name: () => tr('EMBER FLAME'), title: () => tr('Ember Flame'), desc: (chain) => tr('Scarlet dragonfire', { chain }) },
  azure: { name: () => tr('AZURE FLAME'), title: () => tr('Azure Flame'), desc: (chain) => tr('Blue fire burns hotter', { chain }) },
  radiant: { name: () => tr('RADIANT FLAME'), title: () => tr('Radiant Flame'), desc: (chain) => tr('White-gold fire · hotter still', { chain }) },
  lightning: { name: () => tr('LIGHTNING BREATH'), title: () => tr('Lightning Breath'), desc: (chain) => tr('Breath arcs to {chain} foes · fireballs become bolts', { chain }) },
  storm: { name: () => tr('STORM DRAGON'), title: () => tr('Storm Dragon'), desc: (chain) => tr('Lightning and gold fire · arcs to {chain} foes', { chain }) },
  prism: { name: () => tr('PRISM DRAGON'), title: () => tr('Prism Dragon'), desc: (chain) => tr('Rainbow fire and lightning · arcs to {chain} foes', { chain }) },
};

/** The five elements (UI names and colours; the VFX are fx's). The element of a level when progress has none. */
export const ELEMENTS = {
  ember: { name: 'EMBER FLAME', title: 'Ember Flame', icon: 'flame', desc: 'Scarlet dragonfire' },
  azure: { name: 'AZURE FLAME', title: 'Azure Flame', icon: 'flame', desc: 'Blue fire burns hotter' },
  radiant: { name: 'RADIANT FLAME', title: 'Radiant Flame', icon: 'flame', desc: 'White-gold fire · hotter still' },
  lightning: { name: 'LIGHTNING BREATH', title: 'Lightning Breath', icon: 'bolt', desc: 'Breath arcs to {chain} foes · fireballs become bolts' },
  storm: { name: 'STORM DRAGON', title: 'Storm Dragon', icon: 'bolt', desc: 'Lightning and gold fire · arcs to {chain} foes' },
  // levels update — L11–15, the HUD's own sixth element (game.progress.element stays 'storm', .ascended is true)
  prism: { name: 'PRISM DRAGON', title: 'Prism Dragon', icon: 'bolt', desc: 'Rainbow fire and lightning · arcs to {chain} foes' },
};
export const ELEMENT_ORDER = ['ember', 'azure', 'radiant', 'lightning', 'storm', 'prism'];
export const PRISM_LEVEL = 11;
/** Tiers by level (the contract): L1–2 ember, L3–4 azure, L5–6 radiant, L7–8 lightning, L9–10 storm. */
export function elementOfLevel(level) { return level >= PRISM_LEVEL ? 'prism' : ELEMENT_ORDER[Math.max(0, Math.min(4, Math.floor((Math.max(1, level) - 1) / 2)))]; }
const CHAIN_OF = { lightning: 3, storm: 5, prism: 6 };
/** Timing of the cut-in (real seconds) and the XP bar. */
export const LEVEL_RULES = {
  life: 1.6, lifeElement: 1.9,   // s on screen
  merge: 0.45,                   // s: a second level-up within this of the first joins it ("LV 5 › LV 7")
  queueMax: 20,                  // s: a level-up held back by a cinematic is still shown within this
  holdMax: 1.3,                  // s: on a portrait phone the card waits at most this long for the kill word (ctx.hold)
  maxLevel: 15,
};

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * game.progress → the view-model (null when there is no progression). frac = progress inside the level (0..1),
 * into / need = XP gained in it / needed for it; max = the top level.
 */
export function readProgress(P, out = {}) {
  if (!P || typeof P !== 'object' || !(typeof P.level === 'number' && Number.isFinite(P.level))) return null;
  const level = Math.max(1, Math.round(P.level));
  const xp = Math.max(0, num(P.xp));
  const xl = num(P.xpLevel, 0), xn = num(P.xpNext, NaN);
  const max = level >= num(P.maxLevel, LEVEL_RULES.maxLevel) || !Number.isFinite(xn) || xn <= xl;
  out.level = level; out.xp = xp; out.max = max;
  out.into = Math.max(0, Math.round(xp - xl)); out.need = max ? 0 : Math.max(1, Math.round(xn - xl));
  out.frac = max ? 1 : clamp((xp - xl) / Math.max(1, xn - xl), 0, 1);
  out.element = typeof P.element === 'string' && ELEMENTS[P.element] ? P.element : elementOfLevel(level);
  // (levels update: the sixth tier is shown as its own element — progress.ascended, or a storm of level 11+)
  if (P.ascended === true || (P.ascended === undefined && out.element === 'storm' && level >= PRISM_LEVEL)) out.element = 'prism';
  out.tier = Math.round(num(P.tier, ELEMENT_ORDER.indexOf(out.element) + 1));
  out.dmgMult = num(P.dmgMult, 1 + 0.12 * (level - 1));
  out.hpMult = num(P.hpMult, 1 + 0.08 * (level - 1));
  out.chain = Math.round(num(P.chain, CHAIN_OF[out.element] || 0));
  return out;
}

/** The element's description with its chain count ("Breath arcs to 3 foes · …"). */
export function elementDesc(el, chain) {
  const d = ELEMENTS[el]?.desc || '';
  return d.replace('{chain}', String(chain > 0 ? chain : CHAIN_OF[el] || 3));
}

/**
 * A level-up as the cut-in says it: from the 'levelup' event (or a polled rise) and the progress before / after.
 * { level, prev, hpGain, dmgPct, element, elementChanged, name, desc }
 */
export function levelUpView(e = {}, now = null, before = null) {
  const level = Math.round(num(e.level, now?.level ?? 1));
  const prev = Math.round(num(e.prev, before?.level ?? level - 1));
  const element = e.ascended === true ? 'prism' : typeof e.element === 'string' && ELEMENTS[e.element] ? e.element : now?.element || elementOfLevel(level);
  const prevEl = before?.element || (typeof e.prevTier === 'number' ? ELEMENT_ORDER[clamp(e.prevTier - 1, 0, 5)] : elementOfLevel(prev));
  const elementChanged = typeof e.elementChanged === 'boolean' ? e.elementChanged : element !== prevEl;
  // +HP: the event's number, else the change of the player's max HP, else base × the hpMult step
  let hpGain = num(e.hpGain, NaN);
  if (!Number.isFinite(hpGain) && before && now && num(now.maxHp) > num(before.maxHp)) hpGain = now.maxHp - before.maxHp;
  if (!Number.isFinite(hpGain) && now?.maxHp && now.hpMult > 0) hpGain = (now.maxHp / now.hpMult) * (now.hpMult - (before?.hpMult ?? now.hpMult - 0.08 * (level - prev)));
  hpGain = Number.isFinite(hpGain) ? Math.max(0, Math.round(hpGain)) : 0;
  // +DMG %: the dmgMult step (0.12 a level by the contract)
  let dmgPct = now && before && now.dmgMult > before.dmgMult ? (now.dmgMult - before.dmgMult) * 100 : 12 * Math.max(1, level - prev);
  dmgPct = Math.max(0, Math.round(dmgPct));
  const chain = Math.round(num(now?.chain, CHAIN_OF[element] || 0));
  return { level, prev, hpGain, dmgPct, element, elementChanged, name: ELEMENTS[element].name, desc: elementDesc(element, chain), chain: chain > 0 ? chain : CHAIN_OF[element] || 3 };
}

// ---------------------------------------------------------------------------------------------------- lettering
/** A manga lettering line (the hit words' look: light rim, ink outline, gradient fill; a small deterministic tilt
 *  per letter). Uses the hit words' .hw-t CSS. */
function mangaLine(cls, text, seed = 1) {
  const layers = [h('b.l0'), h('b.l1'), h('b.l2')];
  const el = h('div.hw-t.' + cls, {}, ...layers);
  let r = seed * 16807 % 2147483647;
  const rnd = () => ((r = (r * 16807) % 2147483647) - 1) / 2147483646;
  let last = null;
  const set = (t) => {
    t = String(t);
    if (t === last) return;             // rebuilt only when the text changes (the element names repeat)
    last = t;
    for (const b of layers) b.replaceChildren();
    r = seed * 16807 % 2147483647;
    const ru = lang() === 'ru';
    let i = 0;
    for (const ch of String(t)) {
      // (Russian: a small size jitter — a smaller (other language) reads as lower-case, hitwords.js JIT_RU)
      const sc = ch === '!' ? 1.22 : i === 0 ? (ru ? 1.08 : 1.12) : ru ? 0.98 + 0.05 * rnd() : 0.94 + 0.12 * rnd();
      const rot = (rnd() * 2 - 1) * 5, dy = (rnd() * 2 - 1) * 0.05;
      const tf = ch === ' ' ? '' : `translateY(${dy.toFixed(3)}em) rotate(${rot.toFixed(1)}deg) scale(${sc.toFixed(2)})`;
      for (const b of layers) {
        const c = h('i.ch' + (ch === ' ' ? '.sp' : ch === '!' ? '.bang' : ''), { text: ch === ' ' ? '' : ch });
        if (tf) c.style.transform = tf;
        b.append(c);
      }
      i++;
    }
  };
  set(text);
  return { el, set };
}

// ---------------------------------------------------------------------------------------------------- the HUD part
export class LevelHud {
  /**
   * fly: the FlightHud (its player panel .pl gets the badge and the XP row); root: the flight HUD element (the cut-in
   * and the edge flash go there, so a cinematic hides them with the rest of the HUD).
   */
  constructor(fly, root, { reduced = null, under = null, placer = null } = {}) {
    this.reduced = reduced ?? (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
    this.root = root;
    // (touch mode, hud.js) where the card goes so it clears the stick, the buttons and the panel: placer(view) →
    // { top (px, the card's own CSS units), right (under the panel, mirrored), compact (the short variant) } | null
    // (null = the stylesheet's place, as on the desktop)
    this.placer = typeof placer === 'function' ? placer : null;
    this.place = null;
    // badge
    this.badgeN = h('b.lvb-n', { text: '1' });
    this.badge = bindText(h('div.lvb.el-ember', {}, h('i.lvb-ic'), bindText(h('span.lvb-k'), 'LV'), this.badgeN), 'Level', null, 'title');
    // XP row
    this.xpFill = h('i.xp-fill'); this.xpGain = h('i.xp-gl'); this.xpT = h('span.xp-t');
    this.xpRow = h('div.pl-xp.el-ember', {}, h('div.xp-bar', {}, this.xpFill, this.xpGain), this.xpT);
    const pl = fly?.pl;
    const top = pl?.querySelector?.('.pl-top');
    const main = pl?.querySelector?.('.pl-main');
    if (top) top.insertBefore(this.badge, top.firstChild); else pl?.append?.(this.badge);
    (main || pl)?.append?.(this.xpRow);
    this.pl = pl || null;
    // cut-in
    this.cMain = mangaLine('lv-main', tr('LEVEL UP!'), 7);
    this.cFrom = h('span.lv-from'); this.cTo = h('b.lv-to'); this.cArr = h('i.lv-arr');
    this.cHp = h('b'); this.cDmg = h('b');
    this.cElName = mangaLine('lv-eln', '', 11); this.cElDesc = h('div.lv-eld');
    this.cEl = h('div.lv-el', {}, h('i.lv-ic'), this.cElName.el);
    this.cBody = h('div.lv-body', {},
      this.cMain.el,
      h('div.lv-row', {}, this.cFrom, this.cArr, bindText(h('span.lv-lk'), 'LV'), this.cTo),
      h('div.lv-stats', {}, (this.cHpS = h('span', {}, '+', this.cHp, tr(' MAX HP'))), h('i.lv-dot'), (this.cDmgS = h('span', {}, '+', this.cDmg, tr(' DAMAGE')))),
      this.cEl, this.cElDesc);
    this.cBand = h('i.lv-band'); this.cLines = h('i.lv-lines'); this.cEdge = h('i.lv-edge');
    this.cGl1 = h('i.lv-gl', { style: { left: '12%', top: '22%' } }); this.cGl2 = h('i.lv-gl', { style: { left: '44%', top: '10%' } });
    this.cMain.el.append(this.cGl1, this.cGl2);
    this.cut = h('div.lvup.el-ember', { style: { opacity: '0' }, 'aria-live': 'polite' }, this.cBand, this.cLines, this.cEdge, this.cBody);
    this.flash = h('div.lv-flash.el-ember', { style: { opacity: '0' } });
    root?.prepend?.(this.flash);
    // under the world layer (opts.under: markers, hit words): a kill word is never hidden by the card
    if (under && under.parentNode === root && root.insertBefore) root.insertBefore(this.cut, under); else root?.append?.(this.cut);
    this.set = {
      on: classSetter(this.badge, 'on'), xpOn: classSetter(this.xpRow, 'on'), n: textSetter(this.badgeN), xpT: textSetter(this.xpT),
      fill: styleSetter(this.xpFill, 'transform'), max: classSetter(this.xpRow, 'max'),
      // the speed readout steps back while the card is up (a class on that element only: toggling one on the HUD root
      // would restyle the whole flight HUD on the level-up frame)
      busy: classSetter(fly?.spd || this.cut, 'lv-dim'),
    };
    this._rects = new Map();       // the card's box per variant (element + changed) and window size
    this.shown = null;             // the last view-model shown { level, element, frac }
    this.before = null;            // a snapshot of the progress each frame (for polled level-ups and the gains)
    this.el = '';                  // element class on the badge / XP row
    this.cur = null;               // the cut-in up: { view, t, life, anims }
    this.queue = [];               // level-ups waiting for the end of a cinematic
    this.fillAnim = null;          // the level-up sweep of the XP bar
    this.pendingEvent = null;      // the 'levelup' event of this frame (its hpGain), matched by level
    this.stats = { levelUps: 0, cutIns: 0, merged: 0, polled: 0, queued: 0, elementChanges: 0, gains: 0, log: [] };
    this._now = 0;
    // a language switch: the cut-in's words again (a card may be up under the pause screen); the rest is per frame
    try { this._offLang = onLang(() => this._relang()); } catch { /* no i18n */ }
  }

  _relang() {
    this.cMain.set(tr('LEVEL UP!'));
    // (the gains' words are the spans' last text nodes: '+', the number, ' MAX HP')
    for (const [sp, en] of [[this.cHpS, ' MAX HP'], [this.cDmgS, ' DAMAGE']]) { const n = sp?.lastChild; if (n && typeof n === 'object' && n.nodeType === 3) n.data = tr(en); }
    if (this.cur) this._fillCut(this.cur.view);
    this._rects.clear();
  }

  get up() { return !!this.cur; }
  /** The cut-in's box while it is up (hit words keep out of it), else null — from the layout (offsets), so it is its
   *  final place from the first frame on, not where the slide-in animation has it right now. */
  rect() {
    if (!this.cur) return null;
    const c = this.cut, b = this.cBody;
    // touch mode scales the card with CSS zoom (styles.css .tm .lvup): offsets are in its own zoomed units
    let z = 1;
    try { z = typeof getComputedStyle === 'function' ? parseFloat(getComputedStyle(c).zoom) || 1 : 1; } catch { z = 1; }
    // cached per variant, window size, zoom and place: the offsets force a layout, once per kind of card
    const P = this.place;
    const key = `${this.cur.view.element}|${this.cur.view.elementChanged}|${typeof innerWidth === 'number' ? innerWidth : 0}x${typeof innerHeight === 'number' ? innerHeight : 0}|${z}|${P ? `${P.top}|${P.right}|${P.compact}` : ''}`;
    const hit = this._rects.get(key);
    if (hit) return hit;
    if (typeof b.offsetWidth === 'number' && b.offsetWidth > 0) {
      const x = ((c.offsetLeft || 0) + (b.offsetLeft || 0)) * z, y = ((c.offsetTop || 0) + (b.offsetTop || 0)) * z;
      const r = [x - 10, y - 6, x + b.offsetWidth * z + 16, y + b.offsetHeight * z + 6];
      if (this._rects.size > 24) this._rects.clear();
      this._rects.set(key, r);
      return r;
    }
    const r = b.getBoundingClientRect?.();
    return r && r.width > 0 ? [r.left - 10, r.top - 6, r.right + 16, r.bottom + 6] : null;
  }

  /** The 'levelup' event (the progression's): remembered for this frame's update (its hpGain / elementChanged). Several
   *  in one frame (a big XP gain: LV 2 → 4 crosses ember → azure at LV 3) are one: the lowest prev, the highest level,
   *  the gains summed, the element change of ANY of them (the last event alone, LV 3 → 4, says "no change"). */
  onLevelUp(e = {}) {
    const x = e && typeof e === 'object' ? e : {};
    const p = this.pendingEvent;
    if (!p) { this.pendingEvent = x; return; }
    const f = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const m = { ...p, ...x };
    if (f(p.prev) !== null && f(x.prev) !== null) m.prev = Math.min(p.prev, x.prev);
    if (f(p.prevTier) !== null && f(x.prevTier) !== null) m.prevTier = Math.min(p.prevTier, x.prevTier);
    if (f(p.level) !== null && f(x.level) !== null) m.level = Math.max(p.level, x.level);
    // (+HP: both events' numbers, else none — levelUpView then takes the change of the max HP over the whole frame)
    if (f(p.hpGain) !== null && f(x.hpGain) !== null) m.hpGain = p.hpGain + x.hpGain; else delete m.hpGain;
    if (p.elementChanged === true || x.elementChanged === true) m.elementChanged = true;
    else if (typeof p.elementChanged !== 'boolean' || typeof x.elementChanged !== 'boolean') delete m.elementChanged;
    this.pendingEvent = m;
  }

  /** A new run / the title: nothing held back, the next read is the new baseline. */
  reset() {
    this.queue.length = 0;
    this._endCut();
    this.shown = null; this.before = null; this.pendingEvent = null;
  }

  /**
   * Per frame. v: readProgress() (null → hidden); maxHp: the player's max HP (for "+HP" without the event's number);
   * dt: real s (0 while paused); ctx: { playing, cinematic, hold } — a level-up waits for a playing, non-cinematic
   * moment; hold (a portrait phone with a kill word up: no room for both) delays it up to holdMax.
   * Returns the cut-in view that started this frame (the HUD emits 'hud:levelup' for the sound), else null.
   */
  update(v, maxHp, dt, ctx = {}) {
    let started = null;
    const on = !!v;
    this.set.on(on); this.set.xpOn(on);
    if (!on) { this.shown = null; this.before = null; if (this.cur) this._endCut(); return null; }
    const snap = { level: v.level, element: v.element, dmgMult: v.dmgMult, hpMult: v.hpMult, chain: v.chain, maxHp: num(maxHp, 0) };
    // level-ups: the event, else a polled rise; a drop is a new run (silent)
    const b = this.before;
    if (b && v.level > b.level) {
      const e = this.pendingEvent && num(this.pendingEvent.level, v.level) <= v.level ? this.pendingEvent : null;
      if (!e) this.stats.polled++;
      const view = levelUpView(e ? { ...e, level: v.level, prev: Math.min(num(e.prev, b.level), b.level) } : { level: v.level, prev: b.level }, snap, b);
      this.stats.levelUps++;
      this.stats.log.push({ level: view.level, prev: view.prev, element: view.element, changed: view.elementChanged, hp: view.hpGain, dmg: view.dmgPct, polled: !e });
      if (this.stats.log.length > 20) this.stats.log.shift();
      this._enqueue(view);
      this._xpLevelUp();
    } else if (b && v.level < b.level) {
      this.queue.length = 0; this._endCut();
    }
    this.pendingEvent = null;
    this.before = snap;
    // badge + XP row
    if (this.el !== v.element) {
      const cls = 'el-' + v.element;
      for (const e of [this.badge, this.xpRow]) { e.classList.remove('el-' + this.el); e.classList.add(cls); }
      this.badge.classList.toggle('bolt', ELEMENTS[v.element].icon === 'bolt');
      this.el = v.element;
    }
    this.set.n(String(v.level));
    this.set.max(v.max);
    this.set.xpT(v.max ? tr('MAX LEVEL') : this._xpText(v.into, v.need));
    const s = this.shown;
    if (!this.fillAnim) this.set.fill(`scaleX(${v.frac.toFixed(4)})`);
    if (s && s.level === v.level && v.frac > s.frac + 0.002 && !this.reduced) this._xpGain(s.frac, v.frac);
    this.shown = { level: v.level, element: v.element, frac: v.frac };
    // the cut-in: held back during a cinematic / outside play, merged, run on its own clock
    const free = ctx.playing !== false && !ctx.cinematic;
    const d = Math.min(0.1, Math.max(0, dt || 0));
    // the level-up sweep: full + flash for 0.55 s, then the new level's fill snaps in (no transition) and one frame
    // later the bar's normal easing is back
    const F = this.fillAnim;
    if (F) {
      if (F.snap) { this.fillAnim = null; this.xpRow.classList.remove('lvl', 'snap'); }
      else {
        F.t += d;
        if (F.t >= F.d) { F.snap = true; this.xpRow.classList.add('snap'); this.set.fill(`scaleX(${v.frac.toFixed(4)})`); }
      }
    }
    const hold = !!ctx.hold && !!this.queue[0] && this.queue[0].age < LEVEL_RULES.holdMax;
    if (hold && !this.cur && this.queue.length) this.stats.held = (this.stats.held || 0) + 1;
    if (!this.cur && this.queue.length && free && !hold) {
      const q = this.queue.shift();
      started = this._startCut(q.view);
    }
    if (this.cur) {
      if (!free && ctx.cinematic) { this._endCut(); }
      else {
        this.cur.t += d;
        for (const a of this.cur.anims) { try { a.currentTime = Math.min(this.cur.t * 1000, a.effect?.getTiming?.().duration ?? 1e9); } catch { /* old browser */ } }
        if (this.cur.t >= this.cur.life) this._endCut();
      }
    }
    // stale queued level-ups (a very long cinematic) are dropped: the badge already says the level
    for (let i = this.queue.length - 1; i >= 0; i--) { this.queue[i].age += d; if (this.queue[i].age > LEVEL_RULES.queueMax) this.queue.splice(i, 1); }
    return started;
  }

  /** "90 / 120 XP" in the current language (cached: asked every frame). */
  _xpText(a, b) {
    const X = this._xpc || (this._xpc = { a: -1, b: -1, s: '' });
    const s0 = tr('{a} / {b} XP');
    if (a !== X.a || b !== X.b || s0 !== X.t) { X.a = a; X.b = b; X.t = s0; X.s = tr('{a} / {b} XP', { a: fmt(a), b: fmt(b) }); }
    return X.s;
  }

  _enqueue(view) {
    const R = LEVEL_RULES;
    // a second level-up right after the first (a titan kill worth two levels): one cut-in "LV 5 › LV 7"
    if (this.cur && this.cur.t < R.merge) { this._mergeInto(this.cur.view, view); this._fillCut(this.cur.view); this.stats.merged++; return; }
    const last = this.queue[this.queue.length - 1];
    if (last) { this._mergeInto(last.view, view); this.stats.merged++; return; }
    this.queue.push({ view, age: 0 });
    this.stats.queued++;
  }
  _mergeInto(a, b) {
    a.level = Math.max(a.level, b.level); a.prev = Math.min(a.prev, b.prev);
    a.hpGain += b.hpGain; a.dmgPct += b.dmgPct;
    if (b.elementChanged) { a.elementChanged = true; a.element = b.element; a.name = b.name; a.desc = b.desc; a.chain = b.chain; }
  }
  _fillCut(v) {
    this.cFrom.textContent = tr('LV {n}', { n: v.prev });
    this.cTo.textContent = String(v.level);
    this.cHp.textContent = fmt(v.hpGain);
    this.cDmg.textContent = `${fmt(v.dmgPct)}%`;
    const E = ELEMENT_TR[v.element];
    this.cElName.set(v.elementChanged ? (E ? E.name() : v.name) : '');
    this.cElDesc.textContent = v.elementChanged ? (E ? E.desc(v.chain ?? CHAIN_OF[v.element] ?? 3) : v.desc) : '';
    let P = null;
    try { P = this.placer ? this.placer(v) : null; } catch { P = null; }
    this.place = P && typeof P === 'object' ? { top: Number.isFinite(P.top) ? Math.round(P.top) : null, right: !!P.right, compact: !!P.compact } : null;
    const Q = this.place;
    this.cut.className = `lvup el-${v.element}${v.elementChanged ? ' changed' : ''}${ELEMENTS[v.element].icon === 'bolt' ? ' bolt' : ''}${Q?.compact ? ' compact' : ''}${Q?.right ? ' rside' : ''}`;
    const st = this.cut.style;
    if (st) {
      st.top = Q && Q.top !== null ? `${Q.top}px` : '';
      st.left = Q?.right ? 'auto' : '';
      st.right = Q?.right ? '0px' : '';
    }
    this.flash.className = `lv-flash el-${v.element}`;
  }
  _startCut(view) {
    const R = LEVEL_RULES;
    this._fillCut(view);
    const life = view.elementChanged ? R.lifeElement : R.life;
    const ms = life * 1000;
    const anims = [];
    const mk = (node, frames, dur = ms, delay = 0) => {
      if (!node?.animate) return;
      try {
        const a = node.animate(frames, { duration: dur, delay, fill: 'both', easing: 'linear' });
        a.pause?.(); a.currentTime = 0; anims.push(a);
      } catch { /* old browser */ }
    };
    const o = (s) => clamp(s / life, 0, 1);
    const out0 = life - 0.32;
    if (this.reduced) {
      mk(this.cut, [{ opacity: 0 }, { opacity: 1, offset: o(0.12) }, { opacity: 1, offset: o(out0) }, { opacity: 0 }]);
    } else {
      // the whole card: in from the left, out to the left
      // (a card placed on the right — touch mode, the buttons on the left — comes in from the right edge)
      const dx = this.place?.right ? -1 : 1;
      mk(this.cut, [{ opacity: 0, transform: `translate3d(${-70 * dx}px, 0, 0)`, easing: 'cubic-bezier(.2,.9,.3,1)' }, { opacity: 1, transform: 'translate3d(0, 0, 0)', offset: o(0.16) },
        { opacity: 1, transform: 'translate3d(0, 0, 0)', offset: o(out0), easing: 'ease-in' }, { opacity: 0, transform: `translate3d(${-46 * dx}px, 0, 0)` }]);
      // the band sweeps open, its speed lines stream to the left
      mk(this.cBand, [{ transform: 'scaleX(.05)', easing: 'cubic-bezier(.2,.9,.3,1)' }, { transform: 'scaleX(1.04)', offset: o(0.18) }, { transform: 'scaleX(1)', offset: o(0.3) }, { transform: 'scaleX(1)' }]);
      mk(this.cLines, [{ transform: `translate3d(${60 * dx}px, 0, 0)`, opacity: 0 }, { transform: 'translate3d(0, 0, 0)', opacity: 1, offset: o(0.14) }, { transform: `translate3d(${-140 * dx}px, 0, 0)`, opacity: 0.7 }]);
      mk(this.cEdge, [{ opacity: 0, transform: 'scaleX(0)' }, { opacity: 1, transform: 'scaleX(1)', offset: o(0.14) }, { opacity: 0.9, transform: 'scaleX(1)', offset: o(0.5) }, { opacity: 0.4, transform: 'scaleX(1)' }]);
      // LEVEL UP! pops, the new level stamps, the stats slide in
      mk(this.cMain.el, [{ transform: 'scale(1.9) rotate(-6deg)', opacity: 0, easing: 'cubic-bezier(.2,.9,.4,1)' }, { transform: 'scale(1.9) rotate(-6deg)', opacity: 0, offset: o(0.05) },
        { transform: 'scale(.92) rotate(1deg)', opacity: 1, offset: o(0.17) }, { transform: 'scale(1.04) rotate(0deg)', opacity: 1, offset: o(0.24) }, { transform: 'scale(1) rotate(0deg)', opacity: 1 }]);
      mk(this.cTo, [{ transform: 'scale(2.4)', opacity: 0, color: '#ffffff' }, { transform: 'scale(2.4)', opacity: 0, offset: o(0.16) },
        { transform: 'scale(.9)', opacity: 1, offset: o(0.27) }, { transform: 'scale(1.06)', opacity: 1, offset: o(0.33) }, { transform: 'scale(1)', opacity: 1 }]);
      // two glints twinkle on the lettering after the pop
      const gl = [{ transform: 'scale(0) rotate(0deg)', opacity: 0 }, { transform: 'scale(0) rotate(0deg)', opacity: 0, offset: 0.25 }, { transform: 'scale(1.4) rotate(45deg)', opacity: 1, offset: 0.45 }, { transform: 'scale(.8) rotate(80deg)', opacity: 1, offset: 0.75 }, { transform: 'scale(0) rotate(100deg)', opacity: 0 }];
      mk(this.cGl1, gl, 620, 200); mk(this.cGl2, gl, 620, 330);
      const sl = `translate3d(${-24 * dx}px, 0, 0)`;
      mk(this.cBody.children[1], [{ transform: sl, opacity: 0 }, { transform: sl, opacity: 0, offset: o(0.12) }, { transform: 'none', opacity: 1, offset: o(0.26) }, { transform: 'none', opacity: 1 }]);
      mk(this.cBody.children[2], [{ transform: sl, opacity: 0 }, { transform: sl, opacity: 0, offset: o(0.24) }, { transform: 'none', opacity: 1, offset: o(0.38) }, { transform: 'none', opacity: 1 }]);
      // the element: its name slams in with a flash in its colour at the screen edges
      if (view.elementChanged) {
        mk(this.cEl, [{ transform: 'scale(2.2) translate3d(10px, 0, 0)', opacity: 0, easing: 'cubic-bezier(.2,.9,.4,1)' }, { transform: 'scale(2.2) translate3d(10px, 0, 0)', opacity: 0, offset: o(0.36) },
          { transform: 'scale(.94)', opacity: 1, offset: o(0.5) }, { transform: 'scale(1.03)', opacity: 1, offset: o(0.58) }, { transform: 'scale(1)', opacity: 1 }]);
        mk(this.cElDesc, [{ opacity: 0 }, { opacity: 0, offset: o(0.52) }, { opacity: 1, offset: o(0.64) }, { opacity: 1 }]);
      }
    }
    if (view.elementChanged) mk(this.flash, [{ opacity: 0 }, { opacity: 0, offset: o(0.36) }, { opacity: 0.95, offset: o(0.42) }, { opacity: 0.35, offset: o(0.62) }, { opacity: 0, offset: o(0.9) }, { opacity: 0 }]);
    this.cur = { view, t: 0, life, anims };
    this.cut.style.opacity = '';
    this.set.busy(true);
    for (const a of anims) { try { a.currentTime = 0; } catch { /* ignore */ } }
    this.stats.cutIns++;
    if (view.elementChanged) this.stats.elementChanges++;
    // the badge pops with the new number
    try { this.badge.animate?.([{ transform: 'skewX(-14deg) scale(1.6)' }, { transform: 'skewX(-14deg) scale(1)' }], { duration: 420, easing: 'cubic-bezier(.3,1.6,.5,1)' }); } catch { /* ignore */ }
    return view;
  }
  _endCut() {
    if (!this.cur) return;
    for (const a of this.cur.anims) { try { a.cancel(); } catch { /* ignore */ } }
    this.cur = null;
    this.cut.style.opacity = '0';
    this.flash.style.opacity = '0';
    this.set.busy(false);
  }
  /** The XP bar on a level-up: sweeps full, flashes white, then the next level starts from the carry-over. */
  _xpLevelUp() {
    if (this.reduced) return;
    this.fillAnim = { t: 0, d: 0.55, snap: false };
    this.xpRow.classList.remove('snap');
    this.xpRow.classList.add('lvl');
    this.set.fill('scaleX(1)');
  }
  /** A gain inside the level: its segment flashes white. */
  _xpGain(a, b) {
    this.stats.gains++;
    const g = this.xpGain;
    g.style.left = `${(a * 100).toFixed(2)}%`;
    g.style.width = `${Math.max(1.5, (b - a) * 100).toFixed(2)}%`;
    try { g.animate?.([{ opacity: 1 }, { opacity: 0.9, offset: 0.3 }, { opacity: 0 }], { duration: 650, easing: 'ease-out' }); } catch { /* ignore */ }
  }
}

/** The results screen's line: { level, element, name, title, xp } from a readProgress() view (null without one). */
export function levelSummary(v) {
  if (!v) return null;
  return { level: v.level, element: v.element, name: ELEMENTS[v.element].name, title: ELEMENTS[v.element].title, xp: Math.round(v.xp), max: !!v.max, icon: ELEMENTS[v.element].icon };
}
