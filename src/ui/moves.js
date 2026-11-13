// Flight-move HUD (system 'movesHud', order 91 — right after the HUD, so the reticle it follows is already placed).
// What the player sees of the move set (contract: player.js exposes the state on game.player, emits the events):
//   momentum gauge   an arc in the reticle's free bottom gap (between the heat and stamina arcs) that fills in dives;
//                    a tick at 50 % (the SKYFALL threshold), gold past it with "SKYFALL" ready inside the reticle;
//                    on the pull-out it flashes "SKYFALL" and becomes the 3 s buff timer (white-gold, draining)
//   fireball charge  16 segments around the reticle + a ring around the F button while F is held; "MAX" at full,
//                    a burst outward on release
//   special meter    a round R button left of the skill buttons that fills with hits / kills / close calls;
//                    full: glowing "INFERNO — R"; while the inferno burns it drains (a real button on touch). Levels:
//                    caption, icon and colours follow Sora's element — AZURE INFERNO, RADIANT INFERNO, and at the
//                    lightning / storm tiers STORM SURGE with a bolt icon (INFERNO_CALLS)
//   move banner      anime call-outs — WINGOVER! IMMELMANN! DASH! CLOSE CALL! SKIMMING SKYFALL! INFERNO! (by element:
//                    AZURE INFERNO! / RADIANT INFERNO! / STORM SURGE! in the element's colours) — low on the
//                    left, above the player panel (above the tip box when a tip is up); on phones above the skills.
//                    Always below the hit words' bottom inset and far from the warning pill; up to 3 stacked
//   stamina cost     the chunk a move spends flashes on the player panel's stamina bar and on the reticle's stamina
//                    arc; a move pressed without enough stamina shakes both red with "NO STAMINA"
//   soft target      (hover / aim / survival) gold corner brackets around player.softTarget — the enemy the aim assist
//                    bends the breath and fireballs toward; they snap in when it changes and turn warm + tighten while
//                    player.inRange (the reticle's IN RANGE says the same); on the titan they frame the part aimed at
//   flight mode      a subtle pill under the speed readout: HOVER (with "W fly" until the first flight) / FLIGHT with
//                    the throttle bar; pulses during the take-off / flare transition
// Teaching tips for the moves go through tips.js (tipsBus): first dive → SKYFALL, first enemy on the tail →
// wingover, full meter → R, fireballs → hold F, later → dash / Immelmann; hover → "hold W to fly", back in a hover →
// strafe / up / down, the first soft target → the brackets. Wingover / Immelmann tips only while flying forward with
// W held (throttle ≥ 0.5); a flare toward the hover withdraws one that is on screen (tipsBus.withdraw).
// Everything is feature-detected: a widget stays hidden until the player exposes its number. Read-only: this system
// never writes game state; the only input it creates is the old touch R / FLY buttons (input.press, like the HUD's
// old skill buttons) — only while there is no touch layer (game.touchUI has its own INFERNO and stick).
// Per frame: string compares, class / transform / CSS-variable writes only on change; layout rects at most 1 Hz.
import { h, s } from './dom.js';
import { tipsBus } from './tips.js';
import { project, mText } from './markers.js';
import { tr, lang, onLang, bindText } from './i18n.js';

const DEG = Math.PI / 180;

/** Tuning (exported for tests / docs). Times in seconds of HUD time (real time while playing). */
export const MOVE_RULES = {
  cost: { wingover: 0.25, loop: 0.35, dash: 0.2 },           // contract balance (stamina 0..1)
  minFrac: 0.6,              // a move starts with 60 % of its cost (flight.js); below that it is denied
  chargeTap: 0.2,            // player.js CHARGE.tap: a charge below this is a normal fireball
  life: { wingover: 1.5, loop: 1.7, dash: 1.1, nearmiss: 1.2, skyfall: 1.8, inferno: 2.0, denied: 1.0, skim: 0.5 },
  maxBanners: 3,
  mergeWithin: 1.2,          // the same call-out again within this: it pops again with ×2 instead of stacking
  skyfall: { threshold: 0.5, dur: 3 },
  inferno: { dur: 4 },
  denyWait: 0.3,             // s after a key combo: no 'move' start by then → "NO STAMINA" (only if stamina < cost)
  doubleTap: 0.28,           // s (player.js DOUBLE_TAP)
  costFlash: 1.15,           // s the spent stamina chunk flashes (white, holds ~0.4 s like an HP chip, drains)
  tips: { diveVy: -18, diveMomentum: 0.22, tailDist: 480, tailCos: -0.5, tailHold: 0.6, dashAfter: 70, chargeAfterShots: 2, loopAfterWingover: 25,
    flyAfter: 1.5, flyLearn: 0.6, hoverAfterFlight: 2, strafeLearn: 0.4, softHold: 0.4 },
  // soft-target brackets: half-size from the target's projected radius (× fit + pad), clamped (px)
  aim: { fit: 0.85, pad: 10, min: 20, max: 84, titanPart: 30 },
};

export const CALLOUT = {
  wingover: { text: 'WINGOVER!', cls: 'k-air' },
  loop: { text: 'IMMELMANN!', cls: 'k-air' },
  dash: { text: 'DASH!', cls: 'k-dash' },
  nearmiss: { text: 'CLOSE CALL!', cls: 'k-close' },
  skim: { text: 'SKIMMING', cls: 'k-skim' },
  skyfall: { text: 'SKYFALL!', cls: 'k-sky' },
  inferno: { text: 'INFERNO!', cls: 'k-inferno' },
  denied: { text: 'NO STAMINA', cls: 'k-deny' },
};
/**
 * Levels and elements: R's super breath says what it really is at Sora's element (the 'special' / 'move' event's
 * element + surge, else player.element / surgeActive). The ember inferno is the white-gold super breath; azure and
 * radiant are their own flames at inferno heat; at the lightning / storm tiers (player.weaponKind 'bolt') R is the
 * STORM SURGE — a free bolt, then the super breath in lightning. text: the call-out, cap: the R button's caption,
 * sub: the call-out's line (+ "· 4 s"), near: the close call's gain line. Exported for tests / docs.
 */
export const INFERNO_CALLS = {
  ember: { text: 'INFERNO!', cap: 'INFERNO', sub: 'WHITE-GOLD SUPER BREATH', near: 'INFERNO', icon: 'flame' },
  azure: { text: 'AZURE INFERNO!', cap: 'AZURE INFERNO', sub: 'BLUE SUPER FLAME', near: 'INFERNO', icon: 'flame' },
  radiant: { text: 'RADIANT INFERNO!', cap: 'RADIANT INFERNO', sub: 'BLINDING SUPER FLAME', near: 'INFERNO', icon: 'flame' },
  lightning: { text: 'STORM SURGE!', cap: 'STORM SURGE', sub: 'LIGHTNING SUPER BREATH', near: 'SURGE', icon: 'bolt', surge: true },
  storm: { text: 'STORM SURGE!', cap: 'STORM SURGE', sub: 'LIGHTNING + GOLD FIRE', near: 'SURGE', icon: 'bolt', surge: true },
};
/** The call for an element (unknown → ember); surge true on a fire element (an older progress) → lightning. Pure. */
export function infernoCall(element, surge = null) {
  let el = INFERNO_CALLS[element] ? element : 'ember';
  if (surge === true && !INFERNO_CALLS[el].surge) el = 'lightning';
  return { el, cls: `el-${el}`, ...INFERNO_CALLS[el] };
}
const NEAR_KIND = { cloud: 'CLOUD', terrain: 'GROUND', ground: 'GROUND', titan: 'TITAN', enemy: 'ENEMY', dragon: 'ENEMY' };

// ---------------------------------------------------------------------------------------------------- languages
// (29.09) The model stays English (its banners' text / sub are what the tests read); a banner also keeps its sub-line as
// parts (keys, or functions of the current language) and the view shows text and parts through tr() — so a language
// switch re-words the call-outs that are up. Russian: src/ui/i18n/ru-hud.js.
const CALL_TR = {
  'WINGOVER!': () => tr('WINGOVER!'), 'IMMELMANN!': () => tr('IMMELMANN!'), 'DASH!': () => tr('DASH!'), 'CLOSE CALL!': () => tr('CLOSE CALL!'),
  SKIMMING: () => tr('SKIMMING'), 'SKYFALL!': () => tr('SKYFALL!'), 'INFERNO!': () => tr('INFERNO!'), 'NO STAMINA': () => tr('NO STAMINA'),
  'AZURE INFERNO!': () => tr('AZURE INFERNO!'), 'RADIANT INFERNO!': () => tr('RADIANT INFERNO!'), 'STORM SURGE!': () => tr('STORM SURGE!'),
  INFERNO: () => tr('INFERNO'), 'AZURE INFERNO': () => tr('AZURE INFERNO'), 'RADIANT INFERNO': () => tr('RADIANT INFERNO'), 'STORM SURGE': () => tr('STORM SURGE'),
  'WHITE-GOLD SUPER BREATH': () => tr('WHITE-GOLD SUPER BREATH'), 'BLUE SUPER FLAME': () => tr('BLUE SUPER FLAME'),
  'BLINDING SUPER FLAME': () => tr('BLINDING SUPER FLAME'), 'LIGHTNING SUPER BREATH': () => tr('LIGHTNING SUPER BREATH'),
  'LIGHTNING + GOLD FIRE': () => tr('LIGHTNING + GOLD FIRE'),
  CLOUD: () => tr('CLOUD'), GROUND: () => tr('GROUND'), TITAN: () => tr('TITAN'), ENEMY: () => tr('ENEMY'),
  '+10% INFERNO': () => tr('+10% INFERNO'), '+10% SURGE': () => tr('+10% SURGE'),
};
/** A call-out word in the current language (an unknown one — a move without an entry — as it is). */
export const callText = (en) => (CALL_TR[en] ? CALL_TR[en]() : en);
const SEP = '  ·  ';
/** A sub-line's parts ('KEY' | () => text) in the current language, joined as the model joins them. */
export function partsText(parts) { let o = ''; for (let i = 0; i < parts.length; i++) { const p = parts[i]; o += (i ? SEP : '') + (typeof p === 'function' ? p() : callText(p)); } return o; }
const secText = (n) => tr('{n} s', { n: lang() === 'ru' ? String(n).replace('.', ',') : n });   // (Russian: "2,5 (other language)")
const pct = (x) => `${Math.round(x * 100)}%`;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const clamp01 = (x) => Math.max(0, Math.min(1, x));

/** The player's move state as exposed by player.js (contract), feature-detected. Pure; exported for tests. */
export function readPlayer(p, now = 0) {
  if (!p) return null;
  const moves = p.moves && typeof p.moves === 'object' ? p.moves : null;
  // skyfall: seconds left (number), { until } / { t, dur } on the simulation clock, or a boolean
  let sky = null;
  const sf = p.skyfall ?? p.buffs?.skyfall;
  if (typeof sf === 'boolean' && num(p.skyfallT) !== null) sky = { on: sf && p.skyfallT > 0, left: p.skyfallT };
  else if (typeof sf === 'number') sky = { on: sf > 0, left: sf };
  else if (sf && typeof sf === 'object') {
    const until = num(sf.until) ?? (num(sf.t) !== null && num(sf.dur) !== null ? sf.t + sf.dur : null);
    const left = num(sf.left) ?? (until !== null ? until - now : null);
    sky = { on: sf.on ?? (left !== null ? left > 0 : !!sf.active), left };
  } else if (typeof sf === 'boolean') sky = { on: sf, left: null };
  return {
    alive: p.alive !== false && p.actor?.alive !== false,
    stamina: num(p.stamina) ?? num(p.body?.stamina),
    momentum: num(p.momentum),
    special: num(p.special),
    fireCharge: num(p.fireCharge),
    infernoActive: typeof p.infernoActive === 'boolean' ? p.infernoActive : null,
    skim: num(p.skim),
    vy: num(p.vel?.y) ?? 0,
    move: moves ? moves.current || null : null,
    moveSide: moves ? moves.side ?? 0 : 0,
    hasMoves: !!moves,
    denied: moves && moves.denied && typeof moves.denied === 'object' ? moves.denied : null,   // { name, reason, stamina }
    deniedField: !!moves && 'denied' in moves,
    skimKind: typeof p.skimKind === 'string' ? p.skimKind : null,
    skyfall: sky,
    // hover / flight and the aim assist (contract: player.flightMode, throttle, softTarget, inRange)
    mode: typeof p.flightMode === 'string' ? p.flightMode : null,
    phase: typeof p.flightPhase === 'string' ? p.flightPhase : null,        // player.js: 'toFlight' | 'toHover' in a transition
    throttle: num(p.throttle),
    softTarget: p.softTarget && typeof p.softTarget === 'object' && p.softTarget.alive !== false ? p.softTarget : null,
    inRange: typeof p.inRange === 'boolean' ? p.inRange : null,
    // levels and elements (player.js mirrors of game.progress): the element, a surge burning, the F weapon
    element: typeof p.element === 'string' && INFERNO_CALLS[p.element] ? p.element : null,
    surge: typeof p.surgeActive === 'boolean' ? p.surgeActive : null,
    weaponKind: typeof p.weaponKind === 'string' ? p.weaponKind : null,
  };
}

// ======================================================================================================== model
/**
 * The HUD's logic without any DOM (unit-tested): events and polled player state in, a view-model out.
 * Clock = HUD seconds (advances only while playing).
 */
export class MovesModel {
  constructor(R = MOVE_RULES) { this.R = R; this.reset(); }
  reset() {
    this.t = 0;
    this.banners = [];            // newest first: { id, kind, text, sub, t0, life, held, count }
    this.seq = 0;
    this.cost = null;             // { t, from, to } stamina chunk spent by the last move
    this.deny = null;             // { t } — "NO STAMINA" shake
    this.spDeny = null;           // { t } — R pressed with the meter not full
    this.pending = [];            // key combos waiting for their 'move' start
    this.started = {};            // move name -> HUD time of its last start
    this.p = null;                // last read of the player
    this.stamina = null;          // stamina of the previous frame (before a move spends it)
    this.sky = { until: -1, flash: -1, dur: this.R.skyfall.dur };
    this.inferno = { on: false, t0: -1, el: null };
    this.skimOn = false;
    this.charge = { v: 0, peak: 0, release: -1, max: false };
    this.special = { v: null, gain: -1, full: false, fullAt: -1 };
    this.stats = { banners: {}, denied: 0, skyfall: 0, releases: 0 };
  }

  // ------------------------------------------------------------------------------------------ inputs
  /** 'move' event (contract: { name, side, phase: 'start'|'end' }). Only the player's own moves reach here. */
  onMove(e = {}) {
    const name = e.name;
    if (!name || (e.phase && e.phase !== 'start')) return;
    this.started[name] = this.t;
    this.pending = this.pending.filter((a) => a.name !== name);
    if (name === 'inferno') { this._inferno(true, e); return; }
    const c = this.R.cost[name];
    if (c) {
      const before = this.stamina ?? this.p?.stamina ?? null;
      if (before !== null) this.cost = { t: this.t, id: ++this.seq, from: clamp01(before - c), to: clamp01(before) };
    }
    const side = e.side < 0 || e.side === 'left' || e.side === 'L' ? 'LEFT' : e.side > 0 || e.side === 'right' || e.side === 'R' ? 'RIGHT' : '';
    const subs = [];
    if (name === 'wingover' && side) subs.push(side === 'LEFT' ? () => tr('↺ LEFT') : () => tr('RIGHT ↻'));
    if (name === 'loop') subs.push(() => tr('COURSE REVERSED'));
    if (c) { const p = pct(c); subs.push(() => tr('−{p} STAMINA', { p })); }
    this.push(name, subs);
  }
  /** 'nearmiss' { kind, dist, speed } */
  onNearMiss(e = {}) {
    const k = NEAR_KIND[e.kind] || String(e.kind || '').toUpperCase();
    const bits = [];
    if (k) { const d = num(e.dist) !== null ? Math.max(1, Math.round(e.dist)) : null; bits.push(d !== null ? () => `${callText(k)} · ${mText(d)}` : k); }
    if (this.p?.special !== null && this.p?.special !== undefined) bits.push(`+10% ${infernoCall(this.p?.element, this.p?.weaponKind === 'bolt' ? true : null).near}`);
    this.push('nearmiss', bits);
  }
  onSkim(on) {
    on = !!on;
    if (on === this.skimOn) return;
    this.skimOn = on;
    if (on) this.push('skim', [() => tr('+SPEED'), () => tr('+STAMINA')], { held: true });
    else for (const b of this.banners) if (b.kind === 'skim') { b.held = false; b.t0 = this.t - Math.max(0, b.life - this.R.life.skim); }
  }
  /** 'momentum' { level, skyfall, phase } — phase 'start' on the pull-out that triggers the buff, 'end' when it runs
   *  out; a threshold crossing (no phase) carries the current skyfall state. */
  onMomentum(e = {}) {
    if (e.phase === 'end' && !e.skyfall) { this.sky.until = Math.min(this.sky.until, this.t); return; }
    if (e.skyfall) this._skyfall();
  }
  /** 'charge' { level, phase: 'start'|'full'|'release'|'cancel' } — only a release bursts the ring. */
  onCharge(e = {}) {
    this.charge.evt = true;
    if (e.phase === 'release' && (e.level ?? 0) >= this.R.chargeTap) { this.charge.release = this.t; this.charge.relLevel = e.level; this.stats.releases++; }
  }
  /** 'special' { name: 'inferno', on, surge, element, label } */
  onSpecial(e = {}) { if (!e.name || e.name === 'inferno') this._inferno(!!e.on, e); }
  /** A key combo the player pressed (read from the input edges): checked against the next 'move' start. */
  attempt(name) {
    if (name === 'inferno') {
      const sp = this.p?.special;
      if (sp !== null && sp !== undefined && sp < 0.999 && !this.inferno.on) this.spDeny = { t: this.t };
      return;
    }
    if (!this.p?.hasMoves) return;
    this.pending.push({ name, t: this.t, stamina: this.p?.stamina ?? null });
  }

  /** sub: the line under the call-out — a string, or parts ('KEY' | () => text, joined by "  ·  "; languages). */
  push(kind, sub = '', { held = false } = {}) {
    const def = CALLOUT[kind] || { text: String(kind).toUpperCase() + '!', cls: 'k-air' };
    this.stats.banners[kind] = (this.stats.banners[kind] || 0) + 1;
    const parts = Array.isArray(sub) ? sub : null;
    if (parts) sub = partsText(parts);
    const same = this.banners.find((b) => b.kind === kind && (b.held || this.t - b.t0 < this.R.mergeWithin));
    if (same && kind !== 'skim') {
      same.count++; same.t0 = this.t; same.sub = sub; same.parts = parts; same.pop = (same.pop || 0) + 1;
      // back to the front
      this.banners = [same, ...this.banners.filter((b) => b !== same)];
      return same;
    }
    const b = { id: ++this.seq, kind, text: def.text, cls: def.cls, sub, parts, t0: this.t, life: this.R.life[kind] ?? 1.4, held, count: 1, pop: 0 };
    this.banners.unshift(b);
    if (this.banners.length > this.R.maxBanners) this.banners.length = this.R.maxBanners;
    return b;
  }

  _deny(name) {
    const c = this.R.cost[name];
    this.deny = { t: this.t, name, id: ++this.seq };
    this.stats.denied++;
    const label = name === 'loop' ? 'IMMELMANN' : String(name || 'MOVE').toUpperCase();
    const p = c ? pct(c * this.R.minFrac) : '';
    this.push('denied', [c ? (name === 'loop' ? () => tr('IMMELMANN NEEDS {p}', { p }) : name === 'wingover' ? () => tr('WINGOVER NEEDS {p}', { p })
      : name === 'dash' ? () => tr('DASH NEEDS {p}', { p }) : () => `${label} NEEDS ${p}`) : () => label]);
  }
  _skyfall() {
    if (this.t < this.sky.until - 0.2) return;           // one buff at a time (a second event re-flashes nothing)
    this.sky.until = this.t + this.R.skyfall.dur; this.sky.flash = this.t;
    this.stats.skyfall++;
    this.push('skyfall', [() => tr('BREATH & FIREBALLS ×1.5'), () => secText(3)]);
  }
  /** info: the 'special' / 'move' event ({ element, surge }) — else the player's own mirrors (a polled start). */
  _inferno(on, info = null) {
    if (on === this.inferno.on) return;
    this.inferno.on = on;
    if (!on) return;
    const el = typeof info?.element === 'string' && INFERNO_CALLS[info.element] ? info.element : this.p?.element;
    const surge = typeof info?.surge === 'boolean' ? info.surge : this.p?.surge ?? (this.p?.weaponKind === 'bolt' ? true : null);
    const c = infernoCall(el, surge);
    this.inferno.t0 = this.t; this.inferno.el = c.el;
    const dur = this.R.inferno.dur;
    const b = this.push('inferno', [c.sub, () => secText(dur)]);
    if (b) { b.text = c.text; b.cls = `${CALLOUT.inferno.cls} ${c.cls}`; }
  }

  // ------------------------------------------------------------------------------------------ per frame
  /** Advance by dt (HUD seconds) with the player read p (readPlayer). */
  step(dt, p) {
    this.t += Math.max(0, Math.min(0.25, dt || 0));
    const t = this.t;
    this.p = p;
    if (p) {
      // polled transitions (a player that exposes the state without every event still drives the HUD)
      if (p.skyfall?.on && t > this.sky.until) this._skyfall();
      if (p.skyfall && !p.skyfall.on && this.sky.until > t && p.skyfall.left !== null) this.sky.until = t;
      if (p.skyfall?.left !== null && p.skyfall?.left !== undefined && p.skyfall.on) this.sky.until = t + p.skyfall.left;
      if (p.infernoActive !== null) this._inferno(p.infernoActive);
      if (p.skim !== null && !this.skimOn && p.skim > 0.15) this.onSkim(true);
      if (p.skim !== null && this.skimOn && p.skim <= 0.02) this.onSkim(false);
      if (p.move && p.move !== this._lastMove && (this.started[p.move] ?? -9) < t - 0.3) this.onMove({ name: p.move, side: p.moveSide, phase: 'start' });
      this._lastMove = p.move;
      // charge: the release is the drop from a real charge back to 0
      const fc = p.fireCharge;
      if (fc !== null) {
        if (fc > 0.02) { this.charge.peak = Math.max(this.charge.peak, fc); this.charge.max = fc >= 0.999; }
        else if (this.charge.v > 0.02) {
          // (without 'charge' events: a drop from a real charge counts as the release)
          if (!this.charge.evt && this.charge.peak >= this.R.chargeTap) { this.charge.release = t; this.charge.relLevel = this.charge.peak; this.stats.releases++; }
          this.charge.peak = 0; this.charge.max = false;
        }
        this.charge.v = fc;
      }
      // special meter: gains pop, full once
      const sp = p.special;
      if (sp !== null) {
        if (this.special.v !== null && sp > this.special.v + 0.02 && !this.inferno.on) this.special.gain = t;
        const full = sp >= 0.999;
        if (full && !this.special.full) this.special.fullAt = t;
        this.special.full = full;
        this.special.v = sp;
      }
    }
    // "NO STAMINA": the flight body's own verdict (moves.denied, a new object per denial) when the player publishes
    // it; else a key combo that found less than 60 % of the cost and started nothing
    if (p?.deniedField) {
      this.pending.length = 0;
      const d = p.denied;
      if (d && d !== this._denSeen) {
        this._denSeen = d;
        if (d.reason === 'stamina' || d.reason === undefined) this._deny(d.name);
      }
      if (!d) this._denSeen = null;
    }
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const a = this.pending[i];
      if (t - a.t < this.R.denyWait) continue;
      this.pending.splice(i, 1);
      if ((this.started[a.name] ?? -9) >= a.t - 0.05) continue;
      const c = this.R.cost[a.name], st = a.stamina ?? p?.stamina;
      if (c && st !== null && st !== undefined && st < c * this.R.minFrac) this._deny(a.name);
    }
    // banners age out (held ones stay while held); at most maxBanners
    this.banners = this.banners.filter((b) => b.held || t - b.t0 < b.life);
    if (this.banners.length > this.R.maxBanners) this.banners.length = this.R.maxBanners;
    if (p) this.stamina = p.stamina;
  }

  /** View-model for the DOM (and for tests). */
  view() {
    const t = this.t, p = this.p, R = this.R;
    const skyOn = t < this.sky.until;
    const mom = p?.momentum ?? null;
    const diving = !!p && p.vy < R.tips.diveVy;
    return {
      t,
      banners: this.banners.map((b, i) => ({ id: b.id, slot: i, kind: b.kind, text: b.count > 1 && b.kind !== 'skim' ? `${b.text} ×${b.count}` : b.text, cls: b.cls, sub: b.sub,
        base: b.text, count: b.count, parts: b.parts,
        age: t - b.t0, pop: b.pop, held: b.held, fade: !b.held && t - b.t0 > b.life - 0.25 })),
      momentum: mom === null ? null : {
        v: clamp01(mom), ready: mom >= R.skyfall.threshold && !skyOn, diving,
        sky: skyOn, skyFrac: skyOn ? clamp01((this.sky.until - t) / this.sky.dur) : 0, flash: t - this.sky.flash < 0.9,
      },
      charge: p?.fireCharge === null || p?.fireCharge === undefined ? null
        : { v: clamp01(p.fireCharge), max: p.fireCharge >= 0.999, release: t - this.charge.release < 0.35, relLevel: this.charge.relLevel || 0 },
      special: p?.special === null || p?.special === undefined ? null
        : { v: clamp01(p.special), full: p.special >= 0.999 && !this.inferno.on, on: this.inferno.on, gain: t - this.special.gain < 0.3, denied: !!this.spDeny && t - this.spDeny.t < 0.45,
          ready: t - this.special.fullAt < 0.6,
          // what R does at Sora's element (the burning one while it burns): caption, icon, colour class
          ...(({ el, cap, icon }) => ({ el, cap, icon }))(this.inferno.on && this.inferno.el ? infernoCall(this.inferno.el) : infernoCall(p.element, p.weaponKind === 'bolt' ? true : null)) },
      cost: this.cost && t - this.cost.t < R.costFlash ? { id: this.cost.id, from: this.cost.from, to: this.cost.to, age: t - this.cost.t } : null,
      denied: !!this.deny && t - this.deny.t < 0.5, denyId: this.deny?.id ?? 0,
      stamina: p?.stamina ?? null,
      skim: this.skimOn ? clamp01(p?.skim ?? 1) : 0,
    };
  }
}

// ======================================================================================================== view
/** Reticle geometry (flight.js reticleSVG: centre 66, arcs at R 52, heat 128°…232°, stamina 52°…−52°). */
const C = 66, RA = 52, RC = 61;
const P = (r, a) => `${(C + r * Math.cos(a * DEG)).toFixed(2)} ${(C + r * Math.sin(a * DEG)).toFixed(2)}`;
const SEGMENTS = 16;
const BN_OLD = 0.6;           // scale of the older call-outs in the stack

function reticleCompanion() {
  // momentum: the bottom gap, 122° → 58° (left to right), tick at 90° (50 % = the SKYFALL threshold)
  const momD = `M${P(RA, 114)} A${RA} ${RA} 0 0 0 ${P(RA, 66)}`;
  const momBg = s('path.mm-bg', { d: momD });
  const momGlow = s('path.mm-glow', { d: momD, pathLength: '100', 'stroke-dasharray': '0 100' });
  const mom = s('path.mm-fill', { d: momD, pathLength: '100', 'stroke-dasharray': '0 100' });
  const tick = s('path.mm-tick', { d: `M${P(RA - 6, 90)} L${P(RA + 6, 90)}` });
  // the stamina a move spent, on the reticle's stamina arc (same path as flight.js: 52° → −52°)
  const stamD = `M${P(RA, 52)} A${RA} ${RA} 0 0 0 ${P(RA, -52)}`;
  const cost = s('path.mm-cost', { d: stamD, pathLength: '100', 'stroke-dasharray': '0 100' });
  const deny = s('path.mm-deny', { d: stamD });
  // fireball charge: 16 segments on an outer ring, clockwise from the top
  const segs = [], unders = [];
  const gap = 4.2, step = 360 / SEGMENTS;
  for (let i = 0; i < SEGMENTS; i++) {
    const a0 = -90 + i * step + gap / 2, a1 = -90 + (i + 1) * step - gap / 2;
    const d = `M${P(RC, a0)} A${RC} ${RC} 0 0 1 ${P(RC, a1)}`;
    unders.push(s('path.cg-bk', { d }));                  // dark underlay: a lit segment reads on a white cumulus
    segs.push(s('path.cg', { d }));
  }
  const charge = s('g.cg-ring', {}, ...unders, ...segs);
  const svg = s('svg', { viewBox: '0 0 132 132' }, momBg, momGlow, mom, tick, cost, deny, charge);
  const skyLbl = bindText(h('div.mv-rl.sky'), 'SKYFALL');
  const maxLbl = bindText(h('div.mv-rl.max'), 'MAX');
  const el = h('div.mv-ret', {}, svg, skyLbl, maxLbl);
  return { el, mom, momGlow, cost, segs, unders, charge, skyLbl, maxLbl };
}

const FLAME = 'M12 2.5c.8 3.2 3.6 4.4 3.6 8a3.6 3.6 0 0 1-1.3 2.8c.3-1.6-.4-2.8-1.5-3.6.2 1.8-.9 3-2 3.4.4-1.4 0-2.6-.9-3.4-1.4 1.4-2.6 2.8-2.6 4.8a4.7 4.7 0 0 0 9.4.4M5 9.5 3 7.8M19 9.5l2-1.7M4.2 14.6 1.8 14.4M19.8 14.6l2.4-.2';
// the STORM SURGE (lightning / storm tiers): a zigzag bolt with two sparks
const BOLT = 'M13.6 2.4 6.2 13.1h5.2l-1.6 8.5 7.9-11.3h-5.3l1.2-7.9zM4.4 7.2 2.6 6.1M19.6 16.8l1.8 1.1M3.8 17.4l-1.9.9M20.2 6.6l1.9-.9';

export class MovesView {
  constructor(game) {
    this.game = game;
    this.ret = reticleCompanion();
    // special meter (R)
    this.spRing = h('i.sp-ring'); this.spAura = h('i.sp-aura');
    this.spIcon = s('path', { d: FLAME }); this.spCap = h('span.sp-cap', { text: tr('INFERNO') });
    this.spBtn = h('button.mv-sp.el-ember', { type: 'button', 'aria-label': tr('INFERNO').toLowerCase(), tabindex: '-1' },
      this.spAura, this.spRing, s('svg.ic', { viewBox: '0 0 24 24' }, this.spIcon), h('span.key', { text: 'R' }), this.spCap);
    // touch: a FLY button (holds W — forward flight; let go to hover), above the R button, only for a player that
    // hovers (player.flightMode)
    this.flyBtn = bindText(h('button.mv-fly', { type: 'button', tabindex: '-1' },
      s('svg.ic', { viewBox: '0 0 24 24' }, s('path', { d: 'M4 17 12 7l8 10M7 20l5-6 5 6' })), bindText(h('span.fl-cap'), 'FLY')), 'fly forward', null, 'aria-label');
    // ring around the F button while charging
    this.fRing = h('div.mv-fring', {}, h('i'));
    // banner stack + stamina chunk on the player panel
    this.bnWrap = h('div.mv-bn');
    this.stChunk = h('div.mv-stc', {}, h('i'));
    this.el = h('div.mvh', {}, this.ret.el, this.fRing, this.spBtn, this.flyBtn, this.stChunk);
    // the call-outs sit UNDER the world layer (enemy arrows, markers, hit words draw over them: those matter more)
    this.bnLayer = h('div.mvh.mvh-bn', {}, this.bnWrap);
    this.pool = [];
    for (let i = 0; i < 4; i++) {
      const t = h('span.mb-t'), sub = h('span.mb-s'), bar = h('i.mb-bar');
      const el = h('div.mv-b', {}, h('i.mb-plate'), h('span.mb-tx', {}, t), sub, bar);
      this.bnWrap.append(el);
      this.pool.push({ el, t, sub, bar, id: 0, slot: -1, freeAt: 0, cls: '', txt: '', subTxt: '' });
    }
    this._last = new Map();
    this._rects = null; this._rectsAt = -9; this._rectsKey = '';
    this._segN = -1; this._touch = false;
  }
  /** Write only on change. */
  _set(el, key, v, fn) { const k = el; let m = this._last.get(k); if (!m) this._last.set(k, (m = {})); if (m[key] === v) return; m[key] = v; fn(v); }
  _style(el, prop, v) { this._set(el, prop, v, () => { el.style[prop] = v; }); }
  _var(el, name, v) { this._set(el, name, v, () => el.style.setProperty(name, v)); }
  _cls(el, name, on) { on = !!on; this._set(el, '.' + name, on, () => el.classList.toggle(name, on)); }

  attach(root) {
    if (this.el.parentNode !== root) root.append(this.el);
    if (this.bnLayer.parentNode !== root) root.insertBefore(this.bnLayer, root.firstChild);
  }

  /** Layout rects of the HUD's own panels (measured on resize, when the tip box toggles, and at most 1 Hz). */
  rects(now) {
    if (!this._tipsEl || !this._tipsEl.isConnected) this._tipsEl = document.querySelector('#ui .tips');
    const tipsEl = this._tipsEl;
    const tipOn = !!tipsEl?.classList.contains('on');
    const key = `${innerWidth}x${innerHeight}:${tipOn ? tipsEl.textContent.length : 0}`;
    if (this._rects && key === this._rectsKey && now - this._rectsAt < 1 && now >= this._rectsAt) return this._rects;
    this._rectsKey = key; this._rectsAt = now;
    const q = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? r : null; };
    this._rects = {
      pl: q('#ui .pl'), st: q('#ui .pl-st'), skills: q('#ui .skills'), fb: q('#ui .sk[data-sk=fireball]'),
      tips: tipOn ? q('#ui .tips') : null, w: innerWidth, h: innerHeight,
    };
    return this._rects;
  }

  update(vm, now, { retEl = null, touch = false, modes = false, flying = false } = {}) {
    const R = this.rects(now);
    this._cls(this.el, 'touch', touch); this._cls(this.bnLayer, 'touch', touch);
    this._reticle(vm, retEl);
    this._special(vm, R, touch);
    this._flyBtn(R, touch && modes, flying);
    this._fring(vm, R);
    this._banners(vm, R);
    this._stamina(vm, R);
  }

  _reticle(vm, retEl) {
    const r = this.ret;
    const tf = retEl?.style.transform || '';
    const vis = !!retEl && retEl.style.opacity !== '0' && !!tf;
    this._style(r.el, 'transform', tf);
    // momentum arc
    const m = vm.momentum;
    const showM = !!m && (m.v > 0.03 || m.sky);
    this._cls(r.el, 'm-on', vis && showM);
    this._cls(r.el, 'm-ready', !!m?.ready);
    this._cls(r.el, 'm-sky', !!m?.sky);
    this._cls(r.el, 'sky-lbl', vis && !!m && (m.sky || (m.ready && m.diving)));
    if (m) {
      const v = m.sky ? m.skyFrac : m.v;
      const q = Math.round(v * 200) / 2;
      this._set(r.mom, 'dash', q, () => { r.mom.setAttribute('stroke-dasharray', `${q} 100`); r.momGlow.setAttribute('stroke-dasharray', `${q} 100`); });
      if (m.flash && !this._skyFlashed) { this._skyFlashed = true; r.skyLbl.animate([{ transform: 'translateX(-50%) scale(1.9)', opacity: 0 }, { transform: 'translateX(-50%) scale(1)', opacity: 1 }], { duration: 260, easing: 'cubic-bezier(.3,1.6,.5,1)' }); }
      if (!m.flash) this._skyFlashed = false;
    }
    // fireball charge segments
    const c = vm.charge;
    const showC = !!c && (c.v > 0.02 || c.release);
    this._cls(r.el, 'c-on', vis && showC);
    this._cls(r.el, 'c-max', !!c?.max);
    this._cls(r.el, 'max-lbl', vis && !!c?.max);
    if (c) {
      const n = c.v > 0.02 ? Math.max(1, Math.ceil(c.v * SEGMENTS - 1e-6)) : c.release ? SEGMENTS : 0;
      if (n !== this._segN) { this._segN = n; r.segs.forEach((g, i) => g.classList.toggle('on', i < n)); r.unders.forEach((g, i) => g.classList.toggle('on', i < n)); }
      if (c.release && !this._rel) { this._rel = true; r.charge.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(1.55)', opacity: 0 }], { duration: 340, easing: 'ease-out' }); }
      if (!c.release) this._rel = false;
    }
    // stamina chunk + deny on the reticle's stamina arc
    const k = vm.cost;
    if (k) {
      const a = Math.round(k.from * 100), b = Math.max(1, Math.round((k.to - k.from) * 100));
      const key = `${a}/${b}/${k.id}`;
      if (key !== this._retCostKey) {
        this._retCostKey = key;
        r.cost.setAttribute('stroke-dasharray', `0 ${a} ${b} 100`);
        if (vis) r.cost.animate([{ opacity: 1, stroke: '#ffffff' }, { opacity: 1, stroke: '#dff8ff', offset: 0.35 }, { opacity: 0.8, stroke: '#9fecff', offset: 0.6 }, { opacity: 0, stroke: '#7fe3ff' }], { duration: 1150, easing: 'linear' });
      }
    }
    if (vm.denied && this._retDeny !== vm.denyId) {
      this._retDeny = vm.denyId;
      if (vis) r.el.querySelector('.mm-deny').animate([{ opacity: 1 }, { opacity: 0.2 }, { opacity: 1 }, { opacity: 0.2 }, { opacity: 0 }], { duration: 480, easing: 'linear' });
    }
  }

  _special(vm, R, touch) {
    const sp = vm.special, b = this.spBtn;
    const on = !!sp && !!R.skills;
    this._cls(b, 'on', on);
    if (!on) return;
    const size = touch ? 64 : 58, gap = 14;
    const x = R.skills.left - gap - size, y = R.skills.top + R.skills.height / 2 - size / 2;
    this._style(b, 'transform', `translate3d(${x.toFixed(0)}px, ${y.toFixed(0)}px, 0)`);
    this._var(b, '--v', sp.v.toFixed(3));
    this._cls(b, 'full', sp.full);
    this._cls(b, 'burn', sp.on);
    this._cls(b, 'denied', sp.denied);
    // levels and elements: the caption, icon and colours of what R does at Sora's element ("STORM SURGE — R")
    if (sp.el) {
      this._set(b, 'el', sp.el, (v) => { for (const c of [...b.classList]) if (c.startsWith('el-')) b.classList.remove(c); b.classList.add(`el-${v}`); });
      this._set(this.spCap, 'text', callText(sp.cap), (v) => { this.spCap.textContent = v; b.setAttribute('aria-label', v.toLowerCase()); });
      this._set(this.spIcon, 'd', sp.icon, (v) => this.spIcon.setAttribute('d', v === 'bolt' ? BOLT : FLAME));
    }
    if (sp.gain && !this._gain) { this._gain = true; b.animate([{ transform: `translate3d(${x.toFixed(0)}px, ${y.toFixed(0)}px, 0) scale(1.14)` }, { transform: `translate3d(${x.toFixed(0)}px, ${y.toFixed(0)}px, 0)` }], { duration: 220, easing: 'ease-out' }); }
    if (!sp.gain) this._gain = false;
  }

  _flyBtn(R, on, flying) {
    const b = this.flyBtn;
    on = on && !!R.skills;
    this._cls(b, 'on', on);
    this._cls(b, 'flying', on && flying);
    if (!on) return;
    const size = 64, gap = 14;
    const x = R.skills.left - gap - size, y = R.skills.top + R.skills.height / 2 - size / 2 - size - 18;
    this._style(b, 'transform', `translate3d(${x.toFixed(0)}px, ${y.toFixed(0)}px, 0)`);
  }

  _fring(vm, R) {
    const c = vm.charge, f = this.fRing;
    const on = !!c && !!R.fb && (c.v > 0.02);
    this._cls(f, 'on', on);
    this._cls(f, 'max', !!c?.max);
    if (!R.fb) return;
    this._style(f, 'transform', `translate3d(${(R.fb.left + R.fb.width / 2).toFixed(0)}px, ${(R.fb.top + R.fb.height / 2).toFixed(0)}px, 0)`);
    if (c) this._var(f, '--v', c.v.toFixed(3));
  }

  _banners(vm, R) {
    // anchor: low-left above the player panel (above the tip box while one is up); phones: above the skills, right
    const phone = R.w <= 600;
    let x = 28, y = R.h - 118, right = false;
    if (phone && R.skills) { x = R.skills.right; y = R.skills.top - 22; right = true; }
    else {
      // (touch mode: the panel sits top-right and the stick owns the bottom-left — the call-outs go left, over the
      // stick's zone, at 62 % of the height)
      if (R.pl && R.pl.top < R.h * 0.3) { x = 28; y = R.h * 0.62; }
      else if (R.pl) { x = R.pl.left; y = R.pl.top - 10; }
      if (R.tips) y = Math.min(y, R.tips.top - 8);
    }
    this._cls(this.bnWrap, 'right', right);
    this._style(this.bnWrap, 'transform', `translate3d(${x.toFixed(0)}px, ${y.toFixed(0)}px, 0)`);
    this.anchor = { x, y, right };
    const now = vm.t;
    const live = new Set(vm.banners.map((b) => b.id));
    for (const e of this.pool) {
      if (e.id && !live.has(e.id)) { e.id = 0; e.freeAt = now + 0.26; e.el.classList.add('out'); e.el.classList.remove('in'); }
    }
    const order = [];
    for (const b of vm.banners) {
      let e = this.pool.find((q) => q.id === b.id);
      if (!e) {
        e = this.pool.find((q) => !q.id && now >= q.freeAt) || this.pool.find((q) => !q.id) || this.pool[this.pool.length - 1];
        e.id = b.id; e.pop = -1; e.tf = ''; e.hKey = '';
        e.el.className = `mv-b ${b.cls}`;
      }
      // (languages: the words in the current language — English is the model's own text, byte for byte)
      const L = lang();
      const txt = L === 'en' || !b.base ? b.text : b.count > 1 && b.kind !== 'skim' ? `${callText(b.base)} ×${b.count}` : callText(b.base);
      if (e.txt !== txt) { e.txt = txt; e.t.textContent = txt; e.t.dataset.t = txt; }
      if (e.subSrc !== b.sub || e.subL !== L) { e.subSrc = b.sub; e.subL = L; const st = L === 'en' || !b.parts ? b.sub : partsText(b.parts); if (e.subTxt !== st) { e.subTxt = st; e.sub.textContent = st; } }
      e.el.classList.toggle('held', !!b.held);
      e.el.classList.toggle('fade', !!b.fade);
      e.el.classList.toggle('old', b.slot > 0);
      // heights measured once per text (a layout read only when a call-out changes)
      const hk = `${e.txt}|${e.subTxt}|${e.el.className}`;
      if (e.hKey !== hk) { e.hKey = hk; e.hFull = e.el.offsetHeight || 50; e.hText = e.el.querySelector('.mb-tx').offsetHeight || 34; }
      if (e.pop !== b.pop) {
        const first = e.pop === -1;
        e.pop = b.pop;
        e.el.classList.remove('out'); e.el.classList.add('in');
        e.el.querySelector('.mb-tx').animate(first
          ? [{ transform: 'translateX(-46px) skewX(-18deg) scale(1.35)', opacity: 0 }, { transform: 'translateX(4px) skewX(-8deg) scale(1)', opacity: 1, offset: 0.55 }, { transform: 'translateX(0) skewX(-8deg)', opacity: 1 }]
          : [{ transform: 'skewX(-8deg) scale(1.3)' }, { transform: 'skewX(-8deg) scale(1)' }],
        { duration: first ? 300 : 200, easing: 'cubic-bezier(.2,1.3,.4,1)' });
      }
      if (b.kind === 'skim') this._style(e.bar, 'transform', `scaleX(${(vm.skim || 0).toFixed(2)})`);
      order.push(e);
    }
    // stack upward: the newest at full size with its sub-line, older ones compact (text only, × BN_OLD)
    let up = 0;
    order.forEach((e, i) => {
      const tf = `translate3d(0, ${(-up).toFixed(0)}px, 0) scale(${i ? BN_OLD : 1})`;
      if (e.tf !== tf) { e.tf = tf; e.el.style.transform = tf; e.el.style.opacity = i === 0 ? '1' : i === 1 ? '.8' : '.55'; }
      up += (i ? e.hText * BN_OLD : e.hFull) + 5;
    });
    this.stackHeight = up;
  }

  _stamina(vm, R) {
    const e = this.stChunk, k = vm.cost, st = R.st;
    const deny = vm.denied && this._barDeny !== vm.denyId;
    const cost = !!k && this._barCost !== k.id;
    if (!st || (!deny && !cost)) return;
    if (deny) {
      this._barDeny = vm.denyId;
      // the whole remaining bar shakes red
      const w = Math.max(6, st.width * Math.max(0.04, vm.stamina ?? 0.1));
      e.style.transform = `translate3d(${st.left.toFixed(0)}px, ${st.top.toFixed(0)}px, 0)`;
      e.style.width = `${w.toFixed(0)}px`; e.style.height = `${Math.max(4, st.height).toFixed(0)}px`;
      e.classList.add('on', 'deny');
      e.firstChild.animate([{ opacity: 1, transform: 'translateX(0)' }, { opacity: 1, transform: 'translateX(-4px)' }, { opacity: 1, transform: 'translateX(4px)' },
        { opacity: 1, transform: 'translateX(-2px)' }, { opacity: 0, transform: 'translateX(0)' }], { duration: 480, easing: 'linear' });
      return;
    }
    this._barCost = k.id;
    const x = st.left + st.width * k.from, w = Math.max(3, st.width * (k.to - k.from));
    e.style.transform = `translate3d(${x.toFixed(0)}px, ${st.top.toFixed(0)}px, 0)`;
    e.style.width = `${w.toFixed(0)}px`; e.style.height = `${Math.max(4, st.height).toFixed(0)}px`;
    e.classList.add('on'); e.classList.remove('deny');
    // the spent chunk flashes white, holds like an HP chip (~0.4 s), then drains away
    e.firstChild.animate([{ opacity: 1, transform: 'scaleY(2.6)', background: '#ffffff' }, { opacity: 1, transform: 'scaleY(1.5)', background: '#e8fbff', offset: 0.18 },
      { opacity: 0.95, transform: 'scaleY(1.3)', background: '#bff4ff', offset: 0.4 }, { opacity: 0, transform: 'scaleY(1)', background: '#7fe3ff' }], { duration: 1150, easing: 'linear' });
  }
}

// ======================================================================================================== aim
const _ap = { x: 0, y: 0, cx: 0, cy: 0, z: 0, onScreen: false };
const _mid = { x: 0, y: 0, z: 0 };
const RET_TF = /translate3d\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px/;
/** The reticle's screen position from its transform (hud.js writes translate3d(x px, y px, 0)); null when hidden. */
export function reticleXY(retEl) {
  if (!retEl || retEl.style.opacity === '0') return null;
  const m = RET_TF.exec(retEl.style.transform || '');
  return m ? { x: +m[1], y: +m[2] } : null;
}
/** Half-size (px) of the soft-target brackets for a world radius r at depth z (m) with the camera's vertical fov. */
export function bracketHalf(r, z, fovDeg, hPx, R = MOVE_RULES.aim) {
  if (!(z > 0.5)) return R.max;
  const focal = (hPx / 2) / Math.tan(((fovDeg || 60) * DEG) / 2);
  return Math.max(R.min, Math.min(R.max, (r * R.fit * focal) / z + R.pad));
}

/** Gold corner brackets around player.softTarget (drawn under the world layer: markers and hit words stay on top). */
export class AimView {
  constructor() {
    this.inner = h('div.ma-in', {}, h('i.ma-c.tl'), h('i.ma-c.tr'), h('i.ma-c.bl'), h('i.ma-c.br'), h('i.ma-dot'));
    this.el = h('div.mv-aim', {}, this.inner);
    this._last = {}; this.target = null; this.stats = { acquired: 0, frames: 0 };
    this.shown = null;           // { x, y, half, inRange, titan } of the last frame (tests)
  }
  _w(k, v, fn) { if (this._last[k] !== v) { this._last[k] = v; fn(v); } }
  /** target: actor | null; ctx: { cam, w, h, inRange, locked, ret: {x,y}|null, scale (world-HUD scale, touch mode),
   *  avoid (screen rects [[l, t, r, b], …]: touch mode / Minimal HUD — the buttons, the stick, PAUSE / FULLSCREEN, the
   *  top-right panel; hud.keepEdge) } */
  update(target, ctx) {
    const el = this.el;
    let x = 0, y = 0, half = 0, ok = false, titan = false;
    // the bracket sizes grow with the world HUD (touch mode on a big screen); 1 = the desktop, as before
    const S = ctx.scale > 0 ? ctx.scale : 1, A0 = MOVE_RULES.aim;
    if (this._aS !== S) { this._aS = S; this._aR = S === 1 ? A0 : { ...A0, min: A0.min * S, max: A0.max * S, pad: A0.pad * S, titanPart: A0.titanPart * S }; }
    const AR = this._aR;
    if (target && ctx.cam && target.pos) {
      titan = target.kind === 'titan';
      if (titan && Array.isArray(target.shapes) && target.shapes.length) {
        // the titan: frame the part under the reticle (its nearest shape on screen)
        let best = Infinity;
        for (const sh of target.shapes) {
          if (!sh?.a) continue;
          if (sh.b) { _mid.x = (sh.a.x + sh.b.x) / 2; _mid.y = (sh.a.y + sh.b.y) / 2; _mid.z = (sh.a.z + sh.b.z) / 2; } else { _mid.x = sh.a.x; _mid.y = sh.a.y; _mid.z = sh.a.z; }
          project(ctx.cam, _mid, ctx.w, ctx.h, _ap);
          if (!_ap.onScreen) continue;
          const d = ctx.ret ? Math.hypot(_ap.x - ctx.ret.x, _ap.y - ctx.ret.y) : Math.hypot(_ap.x - ctx.w / 2, _ap.y - ctx.h / 2);
          if (d < best) { best = d; x = _ap.x; y = _ap.y; half = bracketHalf(Math.min(sh.r || 6, 14), _ap.z, ctx.cam.fov, ctx.h, AR); ok = true; }
        }
        if (ok) half = Math.max(AR.titanPart, half);
      } else {
        project(ctx.cam, target.pos, ctx.w, ctx.h, _ap);
        if (_ap.onScreen) { ok = true; x = _ap.x; y = _ap.y; half = bracketHalf(Math.max(2, target.radius || 7), _ap.z, ctx.cam.fov, ctx.h, AR); }
      }
    }
    // (fix 29.09, touch mode / Minimal HUD) brackets whose frame would lie on a control or the panel step out of sight
    // until they are clear, as the markers' plates do — nothing is drawn over a control (desktop Full HUD: no rects)
    let blocked = false;
    const A = ctx.avoid;
    if (ok && A && A.length) for (const q of A) if (q && x - half < q[2] && x + half > q[0] && y - half < q[3] && y + half > q[1]) { blocked = true; break; }
    if (blocked) this.stats.blocked = (this.stats.blocked || 0) + 1;
    const on = ok && !blocked;
    this._w('on', on, (v) => el.classList.toggle('on', v));
    if (!on) { if (!target) this.target = null; this.shown = null; return; }
    this.stats.frames++;
    this._w('tf', `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`, (v) => { el.style.transform = v; });
    this._w('half', half.toFixed(0), (v) => el.style.setProperty('--hs', `${v}px`));
    this._w('range', !!ctx.inRange, (v) => el.classList.toggle('range', v));
    this._w('locked', !!ctx.locked, (v) => el.classList.toggle('locked', v));
    this._w('titan', titan, (v) => el.classList.toggle('titan', v));
    if (target !== this.target) {
      this.target = target;
      this.stats.acquired++;
      this.inner.animate([{ transform: 'scale(1.75) rotate(45deg)', opacity: 0 }, { transform: 'scale(.92) rotate(0)', opacity: 1, offset: 0.7 }, { transform: 'scale(1)', opacity: 1 }],
        { duration: 210, easing: 'cubic-bezier(.2,.9,.3,1.2)' });
    }
    this.shown = { x, y, half, inRange: !!ctx.inRange, titan };
  }
}

/** Subtle flight-mode pill under the speed readout: HOVER / FLIGHT + throttle; "W fly" until the first flight. */
export class ModeView {
  constructor() {
    this.t = h('span.md-t'); this.bar = h('i');
    this.hint = h('span.md-hint', {}, tr('hold'), h('kbd', { text: 'W' }));
    // (a language switch: the hint's word again — its first child is a text node)
    try { onLang(() => { const n = this.hint.firstChild; if (n && typeof n === 'object' && n.nodeType === 3) n.data = tr('hold'); }); } catch { /* no i18n */ }
    this.el = h('div.mv-mode', {}, h('div.md-in', {}, h('i.md-ic'), this.t, h('span.md-bar', {}, this.bar), this.hint));
    this._last = {}; this.shown = null;
  }
  _w(k, v, fn) { if (this._last[k] !== v) { this._last[k] = v; fn(v); } }
  /** v = { mode, throttle, rising, hint } | null; at = { x, y, above } (right edge / top of the speed readout) */
  update(v, at) {
    const on = !!v && !!at;
    this._w('on', on, (x) => this.el.classList.toggle('on', x));
    if (!on) { this.shown = null; return; }
    const trans = v.mode === 'transition';   // (not `tr`: that is the language's tr())
    const flight = v.mode === 'flight' || (trans && v.rising);
    const label = flight ? 'FLIGHT' : 'HOVER';
    this._w('t', flight ? tr('FLIGHT') : tr('HOVER'), (x) => { this.t.textContent = x; });
    this._w('fl', flight, (x) => { this.el.classList.toggle('flight', x); this.el.classList.toggle('hover', !x); });
    this._w('tr', trans, (x) => this.el.classList.toggle('tr', x));
    this._w('hint', !!v.hint && !flight, (x) => this.hint.classList.toggle('on', x));
    const th = Math.max(0, Math.min(1, v.throttle ?? (flight ? 1 : 0)));
    this._w('th', th.toFixed(2), (x) => { this.bar.style.transform = `scaleX(${x})`; });
    this._w('tf', `translate3d(${at.x.toFixed(0)}px, ${at.y.toFixed(0)}px, 0)`, (x) => { this.el.style.transform = x; });
    this._w('above', !!at.above, (x) => this.el.classList.toggle('above', x));
    this._w('la', !!at.left, (x) => this.el.classList.toggle('la', x));
    this.shown = { label, throttle: th, transition: trans, hint: !!v.hint && !flight };
  }
}

// ======================================================================================================== tips
/** Teaching moments, from the game (read-only) → tipsBus triggers / learns. Exported for tests. */
export class MoveTeacher {
  constructor(R = MOVE_RULES) { this.R = R; this.reset(); }
  reset() { this.t = 0; this.tailT = 0; this.freeT = 0; this.shots = 0; this.wingoverAt = -1; this.diveWant = false; this.flyT = 0; this.flown = false; this.hoverT = 0; this.strafeT = 0; this.softT = 0; }
  /** ctx: { p (readPlayer), vy, enemyOnTail (bool), playing, strafing (A xor D held) } */
  step(dt, ctx, bus = tipsBus) {
    if (!ctx?.playing || !ctx.p) return;
    const T = this.R.tips, p = ctx.p;
    this.t += dt;
    // hover / flight (only for a player that publishes flightMode): "hold W to fly" while hovering after take-off;
    // back in a hover after the first flight → strafe / up / down; learned by doing
    if (p.mode) {
      // (W held: the take-off transition counts — the "✓" comes while the pilot is still pressing W)
      const forward = p.mode === 'flight' || (p.mode === 'transition' && p.phase === 'toFlight');
      if (forward) { this.flyT += dt; if (this.flyT > T.flyLearn) { bus.learn('fly'); this.flown = true; } } else this.flyT = 0;
      // (hovering, or still settling into the first hover after take-off: the first slot of the flight is this tip)
      const settling = p.mode === 'hover' || (p.mode === 'transition' && p.phase !== 'toFlight' && (p.throttle ?? 0) < 0.5);
      if (settling && this.t > T.flyAfter && !this.flown) bus.trigger('fly');
      if (p.mode === 'hover' && this.flown) { this.hoverT += dt; if (this.hoverT > T.hoverAfterFlight) bus.trigger('hover'); } else this.hoverT = 0;
      if (p.mode === 'hover' && ctx.strafing) { this.strafeT += dt; if (this.strafeT > T.strafeLearn) bus.learn('hover'); } else this.strafeT = 0;
    }
    // the aim assist's brackets: the first soft target held for a moment
    if (p.softTarget) { this.softT += dt; if (this.softT > T.softHold) bus.trigger('aim'); } else this.softT = 0;
    // each move tip is wanted while its moment lasts and withdrawn when it has passed (bus.cancel)
    if (p.special !== null) { if (p.special >= 0.999) bus.trigger('inferno'); else if (p.special < 0.9) bus.cancel?.('inferno'); }
    if (p.momentum !== null) {
      if (p.momentum >= T.diveMomentum && (ctx.vy ?? 0) < T.diveVy) { bus.trigger('skyfall'); this.diveWant = true; }
      else if (this.diveWant && p.momentum < 0.08) { bus.cancel?.('skyfall'); this.diveWant = false; }
    }
    if (p.hasMoves) {
      this.tailT = ctx.enemyOnTail ? this.tailT + dt : 0;
      this.freeT = ctx.enemyOnTail ? 0 : (this.freeT || 0) + dt;
      // wingover and Immelmann are moves of forward flight: their tips only while flying with the throttle up (W held);
      // a flare toward the hover (toHover, W let go) takes one off the screen at once (fix pass: it stayed up through
      // the flare into the hover, where the chord is a strafe + climb)
      const fwd = !p.mode || (p.mode === 'flight' && p.phase !== 'toHover' && (p.throttle ?? 1) >= 0.5);
      if (this.tailT > T.tailHold && fwd) bus.trigger('wingover');
      else if (this.freeT > 3) bus.cancel?.('wingover');
      if (!fwd) { bus.withdraw?.('wingover'); bus.withdraw?.('loop'); }
      if (this.wingoverAt >= 0 && this.t - this.wingoverAt > T.loopAfterWingover && fwd) bus.trigger('loop');
      if (this.t > T.dashAfter) bus.trigger('dash');
    }
    if (p.fireCharge !== null && this.shots >= T.chargeAfterShots) bus.trigger('charge');
  }
  onMove(name, bus = tipsBus) {
    if (name === 'wingover') { this.wingoverAt = this.t; bus.learn('wingover'); }
    else if (name === 'loop') bus.learn('loop');
    else if (name === 'dash') bus.learn('dash');
    else if (name === 'inferno') bus.learn('inferno');
  }
  onShot() { this.shots++; }
}

// ======================================================================================================== system
export default function createMovesHud(game) {
  const model = new MovesModel();
  const teacher = new MoveTeacher();
  let view = null, retEl = null, root = null;
  let aim = null, mode = null, aimLayer = null;
  const modeState = { th: 0, rising: false, spd: null, spdAt: -9, pl: null, hint: true };
  try { modeState.hint = !JSON.parse(localStorage.getItem('skyfire.tips') || '{}')?.fly; } catch { modeState.hint = true; }
  const warned = new Set();
  const warnOnce = (k, e) => { if (!warned.has(k)) { warned.add(k); console.warn('[movesHud] ' + k + ' failed', e); } };
  const isPlayer = (a) => !a || a === game.player || a === game.player?.actor || (a.actor && a.actor === game.player?.actor);
  const taps = { W: -9 };
  let tailAcc = 0, onTail = false;
  const learnSeen = { skyfall: 0, releases: 0 };

  function injectCss() {
    if (document.querySelector('link[data-moves-css]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = new URL('./moves.css', import.meta.url).href; l.dataset.movesCss = '1';
    document.head.append(l);
  }

  /** The flight HUD element (inherits the HUD's show / cinematic / photo hiding); else the HUD root. */
  function findRoot() {
    return document.querySelector('#ui .hud-fly') || document.querySelector('#ui .hud') || null;
  }

  /** An enemy dragon behind Sora (not the camera: the tail sector of the flight path), close. 5 Hz. */
  function enemyOnTail(p) {
    const pos = p?.pos, vel = p?.vel;
    if (!pos || !vel) return false;
    const sp = vel.length(); if (sp < 5) return false;
    const T = MOVE_RULES.tips;
    for (const a of game.actors || []) {
      if (!a?.alive || a.team !== 'enemy' || a.kind !== 'dragon' || !a.pos) continue;
      const dx = a.pos.x - pos.x, dy = a.pos.y - pos.y, dz = a.pos.z - pos.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > T.tailDist || d < 1) continue;
      if ((dx * vel.x + dy * vel.y + dz * vel.z) / (d * sp) < T.tailCos) return true;
    }
    return false;
  }

  function readEdges(inp, p) {
    if (!inp || game.state !== 'play') return;
    const k = (c) => inp.down(c);
    // A / D in a hover is a strafe (and Space a climb): no move attempt there
    if (inp.pressed('Space') && p?.mode !== 'hover') {
      // the same rule as player.js moveFromKeys: A XOR D → wingover, else S → loop (only a fallback for a player
      // that does not publish moves.denied)
      const A = k('KeyA') || k('ArrowLeft'), D = k('KeyD') || k('ArrowRight');
      if (A !== D) model.attempt('wingover');
      else if (k('KeyS') || k('ArrowDown')) model.attempt('loop');
    }
    if (inp.pressed('KeyW')) {
      const now = game.time?.real ?? performance.now() / 1000;
      if (now - taps.W < MOVE_RULES.doubleTap) { model.attempt('dash'); taps.W = -9; } else taps.W = now;
    }
    if (inp.pressed('KeyR')) model.attempt('inferno');
  }

  const sys = {
    name: 'movesHud',
    get model() { return model; },
    get view() { return view; },
    /** Read-only snapshot for tests: the view-model of the last frame and counters. */
    get state() { return { vm: sys._vm || null, stats: { ...model.stats, banners: { ...model.stats.banners } } }; },

    /** The soft-target brackets and the flight-mode pill as shown (tests). */
    get aim() { return aim ? { shown: aim.shown, stats: { ...aim.stats } } : null; },
    get mode() { return mode ? mode.shown : null; },

    init() {
      try { injectCss(); } catch (e) { warnOnce('css', e); }
      try { view = new MovesView(game); } catch (e) { warnOnce('build', e); view = null; }
      try { aim = new AimView(); mode = new ModeView(); aimLayer = h('div.mvh.mvh-aim', {}, aim.el); } catch (e) { warnOnce('build-aim', e); aim = mode = null; }
      const ev = game.events;
      // the first hit on the soft target completes the brackets' tip
      ev.on('damage', (rec = {}) => {
        try {
          const st = game.player?.softTarget;
          if (st && rec.target === st && rec.source && isPlayer(rec.source)) tipsBus.learn('aim');
        } catch (err) { warnOnce('damage', err); }
      });
      ev.on('move', (e = {}) => {
        try {
          if (!isPlayer(e.actor)) return;
          model.onMove(e);
          if (!e.phase || e.phase === 'start') teacher.onMove(e.name);
        } catch (err) { warnOnce('move', err); }
      });
      ev.on('nearmiss', (e = {}) => { try { if (isPlayer(e.actor)) model.onNearMiss(e); } catch (err) { warnOnce('nearmiss', err); } });
      ev.on('skim', (e = {}) => { try { if (isPlayer(e.actor)) model.onSkim(e.on); } catch (err) { warnOnce('skim', err); } });
      ev.on('momentum', (e = {}) => { try { if (isPlayer(e.actor)) model.onMomentum(e); } catch (err) { warnOnce('momentum', err); } });
      ev.on('special', (e = {}) => {
        try { if (isPlayer(e.actor)) { model.onSpecial(e); if (e.on) tipsBus.learn('inferno'); } } catch (err) { warnOnce('special', err); }
      });
      ev.on('charge', (e = {}) => { try { if (isPlayer(e.actor)) model.onCharge(e); } catch (err) { warnOnce('charge', err); } });
      ev.on('fireball', ({ owner } = {}) => { if (owner && isPlayer(owner) && game.state === 'play') teacher.onShot(); });
      ev.on('state', ({ next, prev } = {}) => {
        if (next === 'play' && prev !== 'paused' && prev !== 'photo') { model.reset(); teacher.reset(); learnSeen.skyfall = 0; learnSeen.releases = 0; }
      });
    },

    update(dt, realDt) {
      if (!view) return;
      try {
        if (!root || !root.isConnected) {
          root = findRoot();
          if (root) {
            view.attach(root);
            if (aimLayer) root.insertBefore(aimLayer, root.firstChild);
            if (mode) root.append(mode.el);
          }
        }
        if (!root) return;
        if (!retEl || !retEl.isConnected) retEl = document.querySelector('#ui .ret');
        const st = game.state;
        const playing = st === 'play';
        const p = readPlayer(game.player, game.time?.now ?? 0);
        readEdges(game.input, p);
        model.step(playing ? realDt : 0, p);
        // teaching moments (5 Hz tail check)
        if (playing && p) {
          tailAcc += realDt;
          if (tailAcc > 0.2) { tailAcc = 0; onTail = enemyOnTail(game.player); }
          // learned by doing: the first SKYFALL (event or polled), the first charged release
          if (model.stats.skyfall !== learnSeen.skyfall) { learnSeen.skyfall = model.stats.skyfall; tipsBus.learn('skyfall'); }
          if (model.stats.releases !== learnSeen.releases) { learnSeen.releases = model.stats.releases; tipsBus.learn('charge'); }
          const inp = game.input;
          const A = !!(inp?.down?.('KeyA') || inp?.down?.('ArrowLeft')), D = !!(inp?.down?.('KeyD') || inp?.down?.('ArrowRight'));
          teacher.step(realDt, { p, vy: p.vy, enemyOnTail: onTail, playing, strafing: A !== D });
        }
        const vm = model.view();
        sys._vm = vm;
        // touch (28.09): the HUD's live touch flag; the touch R and FLY buttons are the old layout's — only while there is
        // no touch layer (game.touchUI owns INFERNO and the stick otherwise: never two copies on screen)
        const legacy = !!game.hud?.touch && !game.touchUI;
        view.update(vm, performance.now() / 1000, { retEl, touch: legacy, modes: !!p?.mode, flying: p?.mode === 'flight' });
        if (legacy && !view._touchWired) wireTouch();
        try { updateAim(p, st); } catch (e) { warnOnce('aim', e); }
        try { updateMode(p, st, realDt); } catch (e) { warnOnce('mode', e); }
      } catch (e) { warnOnce('update', e); }
    },
  };

  /** Soft-target brackets: player.softTarget projected with the game camera (only in flight, not in cinematics). */
  function updateAim(p, st) {
    if (!aim) return;
    const on = (st === 'play' || st === 'paused') && !!p?.softTarget && !game.cameraRig?.cinematic;
    const w = game.size?.w || innerWidth, H = game.size?.h || innerHeight;
    const lock = game.cameraRig?.lockTarget ?? null;
    aim.update(on ? p.softTarget : null, { cam: game.camera, w, h: H, inRange: !!p?.inRange, locked: !!lock && lock === p?.softTarget, ret: reticleXY(retEl), scale: game.hud?.worldScale ?? 1, avoid: game.hud?.keepEdge ?? null });
  }
  /** The flight-mode pill, placed under the speed readout (measured at 1 Hz / on resize), above it when that would
   *  meet the player panel (narrow landscape: the readout sits bottom-left). */
  function updateMode(p, st, realDt) {
    if (!mode) return;
    if (!p?.mode || (st !== 'play' && st !== 'paused')) { mode.update(null, null); return; }
    const now = performance.now() / 1000;
    if (!modeState.spd || now - modeState.spdAt > 1 || modeState.w !== innerWidth || modeState.h !== innerHeight) {
      modeState.spdAt = now; modeState.w = innerWidth; modeState.h = innerHeight;
      const q = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? r : null; };
      const v = q('#ui .fr.spd .fr-v');
      const spd = q('#ui .fr.spd');
      modeState.pl = q('#ui .pl');
      // right-aligned with the value, clear of the speed tape (the 2 px line at the readout's right edge)
      modeState.spd = v && spd ? { right: Math.min(v.right + 4, spd.right - 12), top: spd.top, bottom: v.bottom, left: spd.left } : null;
    }
    const R = modeState.spd;
    if (!R) { mode.update(null, null); return; }
    const pl = modeState.pl;
    const above = !!pl && R.bottom + 34 > pl.top && R.left < pl.right;
    const left = R.left < 60;                   // the readout sits at the left edge (narrow layouts): align left
    const at = { x: left ? R.left : R.right, y: above ? R.top - 26 : R.bottom + 10, above, left };
    const th = p.throttle ?? (p.mode === 'flight' ? 1 : 0);
    if (Math.abs(th - modeState.th) > 0.004) modeState.rising = th > modeState.th;
    modeState.th = th;
    if (p.phase === 'toFlight') modeState.rising = true; else if (p.phase === 'toHover') modeState.rising = false;
    if (p.mode === 'flight') modeState.hint = false;
    mode.update({ mode: p.mode, throttle: p.throttle, rising: modeState.rising, hint: modeState.hint }, at);
  }

  function wireTouch() {
    view._touchWired = true;
    // FLY: held like the W key (press on touch, release on lift / cancel / lost capture)
    const f = view.flyBtn;
    let flyHeld = false;
    f.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      flyHeld = true; game.input?.press?.('KeyW'); f.classList.add('pressed');
      try { f.setPointerCapture?.(e.pointerId); } catch { /* pointer already gone */ }
    });
    const up = () => { if (!flyHeld) return; flyHeld = false; game.input?.release?.('KeyW'); f.classList.remove('pressed'); };
    f.addEventListener('pointerup', up); f.addEventListener('pointercancel', up); f.addEventListener('lostpointercapture', up);
    const b = view.spBtn;
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      game.input?.press?.('KeyR');
      setTimeout(() => game.input?.release?.('KeyR'), 90);
    });
  }

  return sys;
}
