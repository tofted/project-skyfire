// First-flight tips that teach a control at the moment it is useful (desktop only; the touch layout has buttons).
//   steer   right after take-off                       mouse / LMB / F
//   lock    first enemy contact (spawned within 1.6 km) red arrows + Tab lock-on        → done on the first lock
//   look    an enemy sits behind the camera (or later)  hold RMB / Alt to look around     → done after 0.25 s of free-look
//   behind  the first hit from behind                   turn toward the red arrow
//   dodge   the first titan telegraph / incoming volley Q / E dodge hop (in a hover: "Ctrl down", not "tuck and dive")
//   threat  the first off-screen attack run (the HUD's red ATTACK RUN chevron) → done on a dodge while it is up
//   moves   a quiet moment later                        Shift / Q E / H
//   level   the first XP (a kill) or the first level-up  kills earn XP, what a level gives, the new flames
//           (learnOnShow: remembered once it has been on screen, so levels are explained once)
// Hover / flight (moves.js drives these through tipsBus when the player publishes flightMode):
//   fly       right after take-off, Sora hovering      hold W to fly forward        → done after 0.6 s of flight
//   hover     back in a hover after the first flight   A / D strafe · Space · Ctrl  → done on the first strafe
//   aim       the first soft target under the reticle  the gold brackets             → done on the first hit on it
// Flight moves (moves.js drives these through tipsBus — it reads the game, the HUD only feeds the context above):
//   inferno   the special meter is full                 R                             → done on the first inferno
//             (by element: AZURE / RADIANT INFERNO, STORM SURGE at the lightning tiers — ctx.kit, see KITS)
//   wingover  an enemy dragon on Sora's tail             hold A / D, then Space        → done on the first wingover
//   skyfall   the first dive that builds momentum       pull up for SKYFALL           → done on the first SKYFALL
//             (move tips are withdrawn — cancel() — when their moment passes before they got the slot)
//   charge    after a couple of fireballs               hold F, release               → done on a charged release
//   loop      a while after the first wingover          hold S, then Space: Immelmann → done on the first loop
//   dash      later in the first flight                 double-tap W                  → done on the first dash
// One tip at a time (priority order above), each 5–7 s or until it is done (a short "✓" line), paused with the game
// and hidden during cinematics or the "click to fly" prompt. A tip with a `hover` variant says it while Sora hovers
// (ctx.hover; re-rendered when the mode changes under it). withdraw(id) takes a tip off the screen when its moment is
// gone (the wingover tip when Sora flares into a hover): it may come back later in its own moment (twice a flight). Learned tips (lock, look) are remembered in
// localStorage['skyfire.tips'] so a returning pilot is not taught twice. Pure DOM text, no per-frame layout.
// Languages (29.09): TIPS stays the English source; a tip is translated when it is written (localize(): the whole tip is
// ONE text, its keys and glyphs as {0}, {1} … in the order they come — the Russian text may put them anywhere; key caps
// that are words, "Right mouse" → "(other language)", are translated too). A tip on screen is written again on a language change.
import { h } from './dom.js';
import { tr, lang, onLang } from './i18n.js';

const LEARN_KEY = 'skyfire.tips';
/** Levels and elements: the kit (ctx.kit = game.progress.element) picks a tip's variant — { parts, done, hover } under the
 *  element's name, else under `bolt` for lightning / storm (F fires a lightning bolt there, R is the STORM SURGE). */
const KITS = new Set(['ember', 'azure', 'radiant', 'lightning', 'storm']);
const BOLT_KITS = new Set(['lightning', 'storm']);
const K = (t) => ['k', t];
export const TIPS = {
  behind: { pri: 6, dur: 5, once: true, parts: [['arrow', ''], ' Hit from behind — turn toward the red arrow  ·  hold ', K('Right mouse'), ' to look back'] },
  lock: {
    pri: 5, dur: 7, learn: true,
    parts: [['arrow', ''], ' Red arrows point to enemies  ·  ', K('Tab'), ' locks on — fireballs lead the target'],
    done: ['✓ Locked on  ·  ', K('Tab'), ' again for the next target'],
    bolt: { parts: [['arrow', ''], ' Red arrows point to enemies  ·  ', K('Tab'), ' locks on — bolts lead the target'] },
  },
  look: {
    pri: 4, dur: 6, learn: true,
    parts: ['Hold ', K('Right mouse'), ' or ', K('Alt'), ' to look around Sora  ·  release to fly on'],
    done: ['✓ Free look  ·  ', K('Wheel'), ' moves the camera closer or farther'],
  },
  dodge: { pri: 3, dur: 5, once: true, parts: [K('Q'), K('E'), ' dodge sideways out of a volley  ·  ', K('Ctrl'), ' tuck and dive'],
    hover: [K('Q'), K('E'), ' dodge sideways out of a volley  ·  ', K('Ctrl'), ' drop down'] },
  // the HUD's off-screen attack-run chevron (hud.js ATTACK_RUN): learned by a dodge while one is up
  threat: {
    pri: 5.3, dur: 5.5, learn: true,
    parts: [['atk', ''], ' ATTACK RUN — a dragon dives in from off-screen  ·  ', K('Q'), K('E'), ' dodge  ·  or turn to face it'],
    done: ['✓ Dodged  ·  the red chevron points to the attacker'],
  },
  steer: { pri: 2, dur: 5, fresh: true, parts: [K('Mouse'), ' aim  ·  ', K('Left mouse'), ' fire breath  ·  ', K('F'), ' fireball'],
    bolt: { parts: [K('Mouse'), ' aim  ·  ', K('Left mouse'), ' lightning breath  ·  ', K('F'), ' lightning bolt'] } },
  // levels (hud.js: the first 'xp' / 'levelup'): shown once ever — remembered as soon as it is on screen
  level: {
    pri: 5.35, dur: 6.5, learn: true, learnOnShow: true,
    parts: [['lv', ''], ' Kills earn XP  ·  every level: stronger fire, more HP  ·  the flame turns blue at LV 3, lightning at LV 7'],
  },
  moves: { pri: 1, dur: 5.5, fresh: true, parts: [K('Shift'), ' boost while flying  ·  ', K('Q'), K('E'), ' dodge  ·  ', K('H'), ' all controls'] },
  // hover / flight (the new scheme: Sora hovers until W is held) — triggered by moves.js when the player has flightMode
  fly: {
    // above the lock tip: holding W to fly is THE control of the new scheme (the first enemies may not cut it short)
    pri: 5.1, dur: 12, fresh: true, learn: true,
    parts: ['Sora hovers in place  ·  hold ', K('W'), ' to fly forward — let go to hover again'],
    done: ['✓ Flying  ·  let go of ', K('W'), ' to flare and hover'],
  },
  hover: {
    pri: 2.4, dur: 6.5, learn: true,
    parts: ['In a hover  ·  ', K('A'), K('D'), ' strafe  ·  ', K('Space'), ' up  ·  ', K('Ctrl'), ' down  ·  ', K('S'), ' back'],
    done: ['✓ Strafing  ·  the mouse turns Sora and aims'],
  },
  aim: {
    pri: 5.2, dur: 6, learn: true,
    parts: [['bracket', ''], ' Gold brackets mark your target  ·  breath and fireballs bend toward it'],
    done: ['✓ On target  ·  IN RANGE on the reticle — the breath reaches'],
    bolt: { parts: [['bracket', ''], ' Gold brackets mark your target  ·  breath and bolts bend toward it'] },
  },
  // flight moves (triggered by moves.js through tipsBus)
  // (by element — moves.js INFERNO_CALLS: what R really does at Sora's level; learned once for all of them)
  inferno: {
    pri: 7, dur: 6, learn: true,
    parts: [['flame', ''], ' INFERNO is ready  ·  press ', K('R'), ' — 4 s of white-gold super breath'],
    done: ['✓ INFERNO  ·  hits, kills and close calls charge it again'],
    azure: { parts: [['flame', ''], ' AZURE INFERNO is ready  ·  press ', K('R'), ' — 4 s of blue super flame'], done: ['✓ AZURE INFERNO  ·  hits, kills and close calls charge it again'] },
    radiant: { parts: [['flame', ''], ' RADIANT INFERNO is ready  ·  press ', K('R'), ' — 4 s of blinding super flame'], done: ['✓ RADIANT INFERNO  ·  hits, kills and close calls charge it again'] },
    lightning: { parts: [['bolt', ''], ' STORM SURGE is ready  ·  press ', K('R'), ' — a free bolt, then 4 s of lightning super breath'], done: ['✓ STORM SURGE  ·  hits, kills and close calls charge it again'] },
    storm: { parts: [['bolt', ''], ' STORM SURGE is ready  ·  press ', K('R'), ' — a free bolt, then 4 s of lightning and gold fire'], done: ['✓ STORM SURGE  ·  hits, kills and close calls charge it again'] },
  },
  wingover: {
    pri: 5.5, dur: 6.5, learn: true,
    // the chord in the order it works: the turn key first, then Space (Space first is the power beat). Each phrase
    // fits one line of the tip box (≈ 390 px at 1280): the keys get a line of their own
    parts: [['arrow', ''], ' Enemy on your tail — wingover 180° to face it  ·  flying, hold ', K('A'), ' or ', K('D'), ', then tap ', K('Space')],
    done: ['✓ Wingover  ·  hold ', K('S'), ', then tap ', K('Space'), ' for the Immelmann'],
  },
  skyfall: {
    pri: 5.8, dur: 6, learn: true,          // above lock and wingover: a dive lasts seconds, the tip must land inside it
    parts: ['Diving builds MOMENTUM  ·  pull up out of the dive for SKYFALL — fire ×1.5 for 3 s'],
    done: ['✓ SKYFALL  ·  breath and fireballs ×1.5 while the arc drains'],
    bolt: { parts: ['Diving builds MOMENTUM  ·  pull up out of the dive for SKYFALL — ×1.5 damage for 3 s'], done: ['✓ SKYFALL  ·  breath and bolts ×1.5 while the arc drains'] },
  },
  charge: {
    pri: 1.6, dur: 6, learn: true,
    parts: ['Hold ', K('F'), ' to charge a fireball  ·  let go to fire — a bigger, faster blast'],
    done: ['✓ Charged fireball  ·  a full ring is the biggest blast'],
    // (player.js BOLT.chargedChains: a full charge jumps to 2 more foes)
    bolt: { parts: ['Hold ', K('F'), ' to charge a lightning bolt  ·  let go to fire — a bigger bolt that chains farther'], done: ['✓ Charged bolt  ·  a full ring arcs to the most foes'] },
  },
  loop: { pri: 1.4, dur: 6, learn: true, parts: ['Flying, hold ', K('S'), ', then tap ', K('Space'), ' — Immelmann  ·  half loop up, roll out: course reversed, higher'] },
  dash: { pri: 1.2, dur: 5.5, learn: true, parts: ['Double-tap ', K('W'), ' to DASH  ·  a burst of wingbeats for stamina'] },
};

/**
 * The live Tips (the HUD makes one) for systems that are not the HUD: moves.js triggers and completes the flight-move
 * tips from what it reads of the game. Same rules as the HUD's own calls (active flight, not learned, one at a time).
 */
const LIVE = new Set();
export const tipsBus = {
  trigger(id) { for (const t of LIVE) { try { t.trigger(id); } catch { /* a tip must never break a system */ } } },
  learn(id) { for (const t of LIVE) { try { t.learn(id); } catch { /* ignore */ } } },
  cancel(id) { for (const t of LIVE) { try { t.cancel(id); } catch { /* ignore */ } } },
  withdraw(id) { for (const t of LIVE) { try { t.withdraw(id); } catch { /* ignore */ } } },
  get current() { for (const t of LIVE) if (t.active) return t.current; return null; },
};

function loadLearned() {
  try { const o = JSON.parse(localStorage.getItem(LEARN_KEY) || '{}'); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
}

export class Tips {
  constructor(el) {
    LIVE.add(this);
    this.el = el;
    this.learned = loadLearned();
    this.active = false;
    this.reset(false);
    onLang(() => { if (this.cur) this._render(this._parts(this.cur.id, this.cur.done), this.cur.done); });
  }
  reset(fresh) {
    this.fresh = fresh;
    this.t = 0;                   // flight time since begin (s, real time while playing)
    this.shown = new Set();       // shown this flight
    this.want = new Set();        // triggered, waiting for their turn
    this.cur = null;              // { id, t, done, doneT }
    this.gap = 0;
    this.freeT = 0;
    this.lastEnemyT = -1;
    this.hover = false;           // ctx.hover of the last frame (the tip's hover variant)
    this.kit = 'ember';           // ctx.kit: Sora's element (levels) — the words for F / R / the breath
    this.withdrawn = {};          // id → times taken off the screen this flight
    this._hide();
  }
  /** fresh = a flight from the title (general tips too); a retry only gets the contextual ones not learned yet. */
  begin(fresh = true) { this.active = true; this.reset(fresh); }
  end() { this.active = false; this._hide(); }
  _remember(id) {
    if (!TIPS[id]?.learn || this.learned[id]) return;
    this.learned[id] = 1;
    try { localStorage.setItem(LEARN_KEY, JSON.stringify(this.learned)); } catch { /* private mode */ }
  }
  /** An action happened (lock / look): the tip completes, and is remembered. */
  learn(id) {
    this._remember(id);
    this.want.delete(id);
    if (this.cur?.id === id && !this.cur.done) {
      const done = this._parts(id, true);
      if (done) { this.cur.done = true; this.cur.doneT = 0; this._render(done, true); }
      else this._finish();
    }
  }
  /** The moment for a waiting tip has passed (the dive ended, the enemy left the tail): it is not shown out of
   *  context later; it can trigger again. A tip already on screen runs its course. */
  cancel(id) { this.want.delete(id); }
  /** The moment has passed while the tip is ON screen (the wingover tip, Sora flaring into a hover): it goes now,
   *  and may come back in its own moment later (at most twice a flight). A "✓" line runs its course. */
  withdraw(id) {
    this.want.delete(id);
    if (this.cur?.id !== id || this.cur.done) return;
    this._finish();
    this.withdrawn[id] = (this.withdrawn[id] || 0) + 1;
    if (this.withdrawn[id] <= 2) this.shown.delete(id);
  }
  /** A contextual trigger (behind / dodge / lock / look). Ignored when already shown this flight or learned. */
  trigger(id) {
    const def = TIPS[id];
    if (!def || !this.active || this.shown.has(id) || this.learned[id]) return;
    if (def.fresh && !this.fresh) return;
    this.want.add(id);
  }
  /**
   * ctx: { playing, hidden (cinematic / prompt), enemiesNear, enemyBehind, camFree, hover (Sora hovers) }. realDt
   * keeps the tips on screen for real seconds; nothing advances while the game is paused.
   */
  update(realDt, ctx) {
    if (!this.active) return;
    if (!ctx.playing) return;
    if (ctx.hidden) { if (this.el.classList.contains('on')) this.el.classList.remove('on'); return; }
    if (this.cur && !this.el.classList.contains('on')) this.el.classList.add('on');
    const dt = Math.min(0.25, realDt);
    this.t += dt;
    // the hover variant follows the mode (a tip on screen is re-rendered when Sora starts / stops hovering)
    const hv = !!ctx.hover;
    if (hv !== this.hover) {
      this.hover = hv;
      if (this.cur && !this.cur.done && TIPS[this.cur.id].hover) this._render(this._parts(this.cur.id), false);
    }
    // levels: the element's words (a level-up to lightning under a tip that names the fireball re-renders it)
    const kit = KITS.has(ctx.kit) ? ctx.kit : 'ember';
    if (kit !== this.kit) {
      const before = this.cur ? this._parts(this.cur.id, this.cur.done) : null;
      this.kit = kit;
      if (this.cur && this._parts(this.cur.id, this.cur.done) !== before) this._render(this._parts(this.cur.id, this.cur.done), this.cur.done);
    }
    // context → triggers
    if (this.fresh && this.t > 2.5) this.trigger('steer');
    if (ctx.enemiesNear > 0) { if (this.lastEnemyT < 0) this.lastEnemyT = this.t; this.trigger('lock'); }
    if (ctx.enemyBehind) this.trigger('look');
    if (this.lastEnemyT >= 0 && this.t - this.lastEnemyT > 16) this.trigger('look');
    if (this.fresh && this.t > 34) this.trigger('moves');
    if (ctx.camFree) { this.freeT += dt; if (this.freeT > 0.25) this.learn('look'); } else this.freeT = 0;
    // the tip on screen
    const c = this.cur;
    if (c) {
      c.t += dt;
      if (c.done) { c.doneT += dt; if (c.doneT > 1.8) this._finish(); return; }
      const def = TIPS[c.id];
      // a more urgent tip may cut in after 1.5 s ('behind' does not cut 'look': both teach the right mouse button,
      // and the pilot is about to press it)
      const urgent = [...this.want].some((id) => TIPS[id].pri > def.pri && id !== 'steer' && id !== 'moves' && !(id === 'behind' && c.id === 'look'));
      if (c.t > def.dur || (urgent && c.t > (def.fresh ? 3.5 : 1.5))) this._finish();
      return;
    }
    if (this.gap > 0) { this.gap -= dt; return; }
    let best = null;
    for (const id of this.want) if (!best || TIPS[id].pri > TIPS[best].pri) best = id;
    if (!best) return;
    this.want.delete(best);
    if (this.shown.has(best) || this.learned[best]) return;
    this.shown.add(best);
    if (TIPS[best].learnOnShow) this._remember(best);
    this.cur = { id: best, t: 0, done: false, doneT: 0 };
    this._render(this._parts(best), false);
    this.el.classList.add('on');
  }
  /** The tip's words for Sora's element (kit variant: the element's own, else 'bolt' at the lightning tiers) and mode. */
  _parts(id, done = false) {
    const d = TIPS[id];
    const v = d[this.kit] || (BOLT_KITS.has(this.kit) ? d.bolt : null) || null;
    if (done) return v?.done || d.done || null;
    if (this.hover && (v?.hover || d.hover)) return v?.hover || d.hover;
    return v?.parts || d.parts;
  }
  get current() { return this.cur ? { id: this.cur.id, done: this.cur.done } : null; }

  _finish() { this.cur = null; this.gap = 0.8; this._hide(); }
  _hide() { this.el.classList.remove('on'); }
  _render(parts, done) {
    this.el.classList.toggle('done', done);
    this.el.replaceChildren(...segments(localize(parts)));
  }
}

/** The one-text key of a tip's parts: the strings as they are, every key cap / glyph as {0}, {1} … in order. */
export function tipKey(parts) {
  let key = '', i = 0;
  for (const p of parts) key += Array.isArray(p) ? `{${i++}}` : String(p);
  return key;
}
/** Key caps that are words (the others — W, Tab, Shift, Ctrl, Alt, Q … — stay as they are). */
const CAP_WORDS = new Set(['Mouse', 'Left mouse', 'Right mouse', 'Wheel', 'Space']);
/** A tip's parts in the language in use (English: the parts themselves). */
export function localize(parts) {
  if (lang() === 'en' || !parts) return parts;
  const key = tipKey(parts);
  const text = tr(key);
  if (text === key) return parts;                  // no Russian text (recorded by tr as missing): the English tip
  const nodes = parts.filter(Array.isArray).map((p) => (p[0] === 'k' && CAP_WORDS.has(p[1]) ? ['k', tr(p[1])] : p));
  const out = [];
  text.split(/\{(\d+)\}/).forEach((s, i) => { if (i % 2) { const p = nodes[+s]; if (p) out.push(p); } else if (s) out.push(s); });
  return out;
}

/**
 * Parts → inline-block segments split at " · " (wave 5): a two-line tip breaks between its phrases ("… around Sora ·"
 * / "release to fly on"), never inside one; a phrase longer than the whole line still wraps inside its own box. The
 * dot ends the segment before it, so a line never starts with "·".
 */
export function segments(parts) {
  const out = [];
  let seg = [];
  const close = (dot) => {
    if (seg.length) out.push(h('span.tp-seg', {}, ...seg), ' ');
    seg = [];
    if (dot && out.length >= 2) out[out.length - 2].append('\u00a0·');
  };
  for (const p of parts) {
    if (Array.isArray(p)) {
      if (p[0] === 'k') seg.push(h('kbd', { text: p[1] }));
      else if (p[0] === 'arrow') seg.push(h('i.tp-arr'));
      else if (p[0] === 'flame') seg.push(h('i.tp-flame'));
      else if (p[0] === 'bolt') seg.push(h('i.tp-bolt'));
      else if (p[0] === 'bracket') seg.push(h('i.tp-brk'));
      else if (p[0] === 'atk') seg.push(h('i.tp-atk'));
      else if (p[0] === 'lv') seg.push(h('i.tp-lv'));
      continue;
    }
    String(p).split(/\s*·\s*/).forEach((txt, i) => {
      if (i > 0) close(true);
      if (txt) seg.push(txt);
    });
  }
  close(false);
  if (out.length && out[out.length - 1] === ' ') out.pop();
  return out;
}
