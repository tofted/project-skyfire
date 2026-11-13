// game.progress — Sora's level, XP and element (system 'progress', order 21, right after combat). The user (25.09):
// "the more enemies the dragon kills, the higher its level; each level the fire hits harder and the HP grows; the fire
// changes colour, and later it shoots lightning instead of fire".
//   game.progress = { level 1..10, xp (total this run), xpLevel (xp where this level began), xpNext (xp of the next
//                     level; = xpLevel at the top level), frac (0..1 toward the next level), maxed, tier 1..5,
//                     element 'ember'|'azure'|'radiant'|'lightning'|'storm', elementName, color, dmgMult, hpMult,
//                     chain (0|3|5), xpMul (the mode's XP factor) and xpCurve (null | a factor per level: the director
//                     sets survival's, full XP early, less for the late tiers), peak,
//                     history [{ level, t, source, xp }], gained { source: xp }, reset(), gain(amount, source) }
//   XP (XP table): drake 10, rookie rider 25, veteran 40, ace 100 — for a kill by Sora (the 'death' event's killer is
//   her actor, or she hit that enemy within ASSIST s: a burning dragon that crashes still counts); the titan: 1 per 20
//   damage she deals it, +150 when her blows take it under 70 % and under 50 % of its HP (TITAN_MARKS, once per run:
//   a checkpoint retry does not pay them again — fix pass: without them L9 and L10 both came with the kill, on the
//   victory frame, and Stormfire was never flown in the story), 500 for the kill. Thresholds (total xp): L2 60, L3 150, L4 270, L5 420, L6 600, L7 820,
//   L8 1080, L9 1380, L10 1720. dmgMult = 1 + 0.12 (L − 1), hpMult = 1 + 0.08 (L − 1). Tiers: L1–2 ember (orange
//   fire), L3–4 azure (blue flame), L5–6 radiant (white-gold), L7–8 lightning (chain 3), L9–10 storm (lightning +
//   gold fire, chain 5). Chain reach (fix pass: at 25 m the chain fired in 8 of 99 hits — rider pairs and drake flocks
//   fly farther apart than that; measured with real input, another dragon was within 25 m of 0–4 % of the beam's hits on
//   riders and 0–22 % of the bolt's): chainRadius (the beam's jumps, m) lightning 40 / storm 45, chainRange (the bolt's
//   jumps, m) lightning 50 / storm 60 — fx and player.js read them (feature-detected; their own 25 m without them).
//   Events: 'xp' { amount, total, source, level, frac }, 'levelup' { level, prev, tier, prevTier, element,
//   prevElement, elementChanged, elementName, hpGain, dmgMult, hpMult, chain, chainRadius, chainRange, xp, source }
//   (one per level gained),
//   'progress:reset' { level, element, debug } (a new run; listeners re-read game.progress).
// Who applies what: player.js sets Sora's max HP (base × hpMult, healing what a level adds) and multiplies her shots;
// fx multiplies her breath ticks and draws the element; the director resets at a new run (keeps it across a checkpoint
// retry), scales the titan's HP and survival's enemies with the level and puts the level in the results.
// ?debug&level=N starts every run (and the title) at level N (visual checks; the XP → level flow itself needs kills).
// Never throws: every listener is wrapped; bad input to gain() is ignored.

import { tr } from '../ui/i18n.js';

export const MAX_LEVEL = 15;          // (levels update: 10 → 15; L11+ is the sixth tier, Prismfire)
/** Total XP at the start of each level (index = level − 1). */
export const THRESHOLDS = [0, 60, 150, 270, 420, 600, 820, 1080, 1380, 1720, 2120, 2580, 3100, 3700, 4400];
/** XP per kill by the enemy's skill; the titan per point of damage and for the kill. */
export const XP = { drake: 10, rookie: 25, rider: 25, veteran: 40, ace: 100, titanPerDamage: 1 / 20, titanKill: 500 };
/** Titan HP marks (fraction of its max HP at spawn): Sora's blow that takes it under `at` pays `xp` (source
 *  'titan-break'), once per run each. With the story's ~935 xp at the rise: L8 around 70 %, L9 (Stormfire) around 50 %,
 *  so the enraged half is flown in the last element and the kill's +500 only tops her up to L10. */
export const TITAN_MARKS = [{ at: 0.7, xp: 150 }, { at: 0.5, xp: 150 }];
/** Level-ups this close (s) to the end of a run, or paid by the titan's kill, are the results' "finale" (the fall
 *  cinematic and the victory / shot-down banner hide their cards). */
export const FINALE_WINDOW = 4;
/** A kill counts for Sora when she landed the killing blow, or hit that enemy within this many seconds (a crash). */
export const ASSIST = 8;
export const ELEMENTS = ['ember', 'azure', 'radiant', 'lightning', 'storm'];
/** Display names and colours (sRGB) for the HUD and fx; `bolt` = F shoots a lightning bolt, `chain` extra targets. */
export const ELEMENT_INFO = {
  ember: { tier: 1, name: 'Ember Fire', short: 'EMBER', color: '#ff8a2a', core: '#fff1c2', bolt: false, chain: 0 },
  azure: { tier: 2, name: 'Azure Flame', short: 'AZURE', color: '#3fb0ff', core: '#e6fbff', bolt: false, chain: 0 },
  radiant: { tier: 3, name: 'Radiant Flame', short: 'RADIANT', color: '#ffe6a0', core: '#ffffff', bolt: false, chain: 0 },
  lightning: { tier: 4, name: 'Lightning', short: 'LIGHTNING', color: '#8fd8ff', core: '#f4fdff', bolt: true, chain: 3, chainRadius: 40, chainRange: 50 },
  storm: { tier: 5, name: 'Stormfire', short: 'STORMFIRE', color: '#ffc83a', core: '#bfeaff', bolt: true, chain: 5, chainRadius: 45, chainRange: 60 },
};
/** Levels update — the sixth tier (L11–15): PRISMFIRE. The fire's KIND stays 'storm' (lightning wrapped in fire: every
 *  system that asks game.progress.element keeps working) and game.progress.ascended says the flame now burns through
 *  the whole rainbow (fx draws it from its prism palette, the HUD names it). Chain 6, a little farther. */
export const PRISM_LEVEL = 11;
export const PRISM_INFO = { tier: 6, name: 'Prismfire', short: 'PRISMFIRE', color: '#ff9af0', core: '#ffffff', bolt: true, chain: 6, chainRadius: 50, chainRange: 65 };
const clampLevel = (l) => Math.max(1, Math.min(MAX_LEVEL, Math.floor(Number.isFinite(+l) ? +l : 1)));

/** The level for a total XP (pure). */
export function levelForXp(xp) {
  const x = Number.isFinite(+xp) ? +xp : 0;
  let l = 1;
  for (let i = 1; i < THRESHOLDS.length; i++) if (x >= THRESHOLDS[i]) l = i + 1;
  return l;
}
/** The tier of a level (pure): L1–2 → 1 … L9–10 → 5. */
export const tierForLevel = (level) => (clampLevel(level) >= PRISM_LEVEL ? 6 : Math.max(1, Math.min(5, Math.ceil(clampLevel(level) / 2))));
export const elementForLevel = (level) => ELEMENTS[Math.min(5, tierForLevel(level)) - 1];
/** Everything a level means (pure): { level, tier, element, dmgMult, hpMult, chain, chainRadius, chainRange, xpLevel,
 *  xpNext, maxed } (chainRadius / chainRange 0 below lightning). */
export function statsForLevel(level) {
  const l = clampLevel(level);
  const tier = tierForLevel(l), element = ELEMENTS[Math.min(5, tier) - 1];
  const ascended = tier >= 6;
  const info = ascended ? PRISM_INFO : ELEMENT_INFO[element];
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    level: l, tier, element, ascended, dmgMult: r2(1 + 0.12 * (l - 1)), hpMult: r2(1 + 0.08 * (l - 1)), chain: info.chain,
    chainRadius: info.chainRadius || 0, chainRange: info.chainRange || 0,
    xpLevel: THRESHOLDS[l - 1], xpNext: l < MAX_LEVEL ? THRESHOLDS[l] : THRESHOLDS[l - 1], maxed: l >= MAX_LEVEL,
  };
}
/** XP for a kill of an enemy of this skill ('drake' | 'rookie' | 'rider' | 'veteran' | 'ace'); unknown → rider. */
export const killXp = (skill) => XP[skill] ?? XP.rider;
/** Titan HP multiplier for Sora's level when it spawns (the director's balance.titan.hp reads it). */
export const titanHpScale = (level) => Math.round((1 + 0.1 * (clampLevel(level) - 1)) * 100) / 100;
/** The enemy's skill from its pilot (enemies.pilotOf) or, failing that, its name. */
export function skillOf(pilot, actor) {
  const s = pilot?.kind === 'drake' ? 'drake' : pilot?.skillName;
  if (s && XP[s] != null) return s;
  const n = String(actor?.name || '');
  return /drake/i.test(n) ? 'drake' : /\bace\b/i.test(n) ? 'ace' : /lancer|veteran/i.test(n) ? 'veteran' : 'rookie';
}

export default function createProgress(game) {
  let titanAcc = 0;                      // fractional titan XP (1 per 20 damage)
  let titanHit = false;                  // Sora hit the titan since it last spawned (its kill XP)
  let marks = new Set();                 // TITAN_MARKS paid this run (indices)
  let hits = new WeakMap();              // enemy actor -> last time Sora hit it (assists)
  let warned = false;
  const warn = (what, e) => { if (!warned) { warned = true; console.warn('[progress] ' + what, e); } };
  const emit = (name, payload) => { try { game.events.emit(name, payload); } catch (e) { warn('emit ' + name, e); } };
  const now = () => game.time?.now ?? 0;
  const playerActor = () => {
    const p = game.player;
    return p?.actor || p?.dragon?.actor || (game.actors || []).find((a) => a.team === 'player') || null;
  };
  const fromPlayer = (src) => !!src && (src === playerActor() || src.team === 'player');
  /** Counting only during a run (the director's) — in a sandbox without a director, always. */
  const counting = () => !game.director || !!game.director.running;
  const baseHp = () => {
    const b = +game.director?.balance?.player?.hp;
    return b > 0 ? b : 600;
  };

  const P = {
    name: 'progress',
    maxLevel: MAX_LEVEL, thresholds: THRESHOLDS, xpTable: XP, elements: ELEMENT_INFO,
    level: 1, xp: 0, xpLevel: 0, xpNext: THRESHOLDS[1], frac: 0, maxed: false,
    tier: 1, element: 'ember', elementName: ELEMENT_INFO.ember.name, color: ELEMENT_INFO.ember.color,
    dmgMult: 1, hpMult: 1, chain: 0, chainRadius: 0, chainRange: 0, ascended: false,
    xpMul: 1,                            // the mode's XP factor (director: story 1; survival 1 + 0.25 (wave − 1))
    xpCurve: null,                       // null | [factor per level] (director: survival SURVIVAL.xpCurve)
    peak: 1, startLevel: 1, history: [], gained: {}, runs: 0, debugLevel: null,

    init() {
      const dl = game.debugMode ? parseInt(game.params?.get?.('level'), 10) : NaN;
      P.debugLevel = Number.isFinite(dl) && dl > 1 ? clampLevel(dl) : null;
      P.reset();
      try {
        game.events.on('damage', (rec) => { try { P.onDamage(rec); } catch (e) { warn('damage', e); } });
        game.events.on('death', (rec) => { try { P.onDeath(rec); } catch (e) { warn('death', e); } });
        // the titan comes back fresh on a (re)spawn: its kill XP needs a new hit
        game.events.on('phase', ({ phase }) => { if (phase === 'titan-rise' || phase === 'titan') { titanHit = false; titanAcc = 0; } });
      } catch (e) { warn('listeners', e); }
    },

    /** A new run: level 1 (or ?debug&level=N), no XP. Emits 'progress:reset'. */
    reset(opts = {}) {
      try {
        const start = clampLevel(opts.level ?? P.debugLevel ?? 1);
        P.xp = THRESHOLDS[start - 1];
        P.startLevel = start; P.peak = start;
        P.history = []; P.gained = {}; P.xpMul = 1; P.xpCurve = null; P.runs++;
        titanAcc = 0; titanHit = false; hits = new WeakMap(); marks = new Set();
        P.apply(start);
        emit('progress:reset', { level: P.level, element: P.element, debug: start > 1 });
      } catch (e) { warn('reset', e); }
      return P;
    },

    /** Write the level's numbers onto the system (level, tier, element, multipliers, xp bounds). */
    apply(level) {
      const s = statsForLevel(level);
      P.level = s.level; P.tier = s.tier; P.element = s.element; P.dmgMult = s.dmgMult; P.hpMult = s.hpMult; P.chain = s.chain;
      P.chainRadius = s.chainRadius; P.chainRange = s.chainRange;
      P.xpLevel = s.xpLevel; P.xpNext = s.xpNext; P.maxed = s.maxed; P.ascended = s.ascended;
      const info = s.ascended ? PRISM_INFO : ELEMENT_INFO[s.element];
      P.elementName = info.name; P.color = info.color;
      P.frac = P.maxed ? 1 : Math.max(0, Math.min(1, (P.xp - P.xpLevel) / Math.max(1, P.xpNext - P.xpLevel)));
      return s;
    },

    /** The XP factor now: xpMul × xpCurve[level − 1] (1 where unset or garbage). */
    xpFactor() {
      const m = Number.isFinite(+P.xpMul) && P.xpMul > 0 ? +P.xpMul : 1;
      const c = Array.isArray(P.xpCurve) ? +P.xpCurve[P.level - 1] : NaN;
      return m * (Number.isFinite(c) && c > 0 ? c : 1);
    },
    /** Add XP (× xpFactor()); emits 'xp' and one 'levelup' per level gained. Returns the levels gained. Never throws. */
    gain(amount, source = 'xp', opts = {}) {
      try {
        let a = +amount;
        if (!Number.isFinite(a) || a <= 0) return 0;
        if (!opts.raw) a *= P.xpFactor();
        a = Math.round(a * 100) / 100;
        if (a <= 0) return 0;
        const prevLevel = P.level;
        P.xp = Math.round((P.xp + a) * 100) / 100;
        P.gained[source] = Math.round(((P.gained[source] || 0) + a) * 100) / 100;
        const target = levelForXp(P.xp);
        const base = baseHp();
        let gainedLevels = 0;
        // one step at a time, so every level (and every element change) gets its own event
        for (let l = prevLevel + 1; l <= target; l++) {
          const was = statsForLevel(l - 1);
          const s = P.apply(l);
          gainedLevels++;
          P.peak = Math.max(P.peak, l);
          P.history.push({ level: l, t: Math.round(now() * 10) / 10, source, xp: P.xp, phase: game.director?.phase ?? null });
          if (P.history.length > 40) P.history.shift();
          emit('levelup', {
            level: l, prev: l - 1, tier: s.tier, prevTier: was.tier, element: s.element, prevElement: was.element,
            elementChanged: s.element !== was.element || s.ascended !== was.ascended, ascended: s.ascended,
            elementName: (s.ascended ? PRISM_INFO : ELEMENT_INFO[s.element]).name,
            hpGain: Math.round(base * (s.hpMult - was.hpMult)), dmgMult: s.dmgMult, hpMult: s.hpMult, chain: s.chain,
            chainRadius: s.chainRadius, chainRange: s.chainRange, xp: P.xp, source,
          });
        }
        if (!gainedLevels) P.apply(P.level);                 // frac
        emit('xp', { amount: a, total: P.xp, source, level: P.level, frac: P.frac });
        return gainedLevels;
      } catch (e) { warn('gain', e); return 0; }
    },

    onDamage(rec) {
      if (!rec || !(rec.amount > 0) || !fromPlayer(rec.source)) return;
      const t = rec.target;
      if (!t || t.team === 'player') return;
      hits.set(t, now());
      if (t.kind === 'titan' && counting()) {
        titanHit = true;
        titanAcc += rec.amount * XP.titanPerDamage;
        if (titanAcc >= 1) { const whole = Math.floor(titanAcc); titanAcc -= whole; P.gain(whole, 'titan'); }
        // the HP marks: this blow took it under 70 % / 50 % of its max HP (once per run each)
        const max = +t.maxHp, hp = +t.hp;
        if (max > 0 && Number.isFinite(hp)) {
          const f = Math.max(0, hp) / max;
          TITAN_MARKS.forEach((m, i) => { if (!marks.has(i) && f <= m.at) { marks.add(i); P.gain(m.xp, 'titan-break'); } });
        }
      }
    },

    onDeath({ actor, killer } = {}) {
      if (!actor || actor.team === 'player' || !counting()) return;
      const last = hits.get(actor);
      const mine = fromPlayer(killer) || (last != null && now() - last <= ASSIST);
      if (actor.kind === 'titan') {
        if (mine || titanHit) P.gain(XP.titanKill, 'titan-kill');
        titanHit = false; titanAcc = 0;
        return;
      }
      if (actor.kind !== 'dragon' || actor.team !== 'enemy' || !mine) return;
      let pilot = null;
      try { pilot = game.enemies?.pilotOf?.(actor) || null; } catch { pilot = null; }
      const skill = skillOf(pilot, actor);
      P.gain(killXp(skill), skill);
    },

    /** The titan HP marks paid this run (indices into TITAN_MARKS; tests / results). */
    get titanMarks() { return [...marks]; },
    /**
     * The run's last level-ups the player could not watch (the titan kill's, or within FINALE_WINDOW s of the end: the fall
     * cinematic and the banners cover their cards): { from, to, levels, element, elementName, elementChanged, stormReached,
     * text: 'LV 8 → LV 10 · Stormfire' } or null.
     */
    finale(endT = now()) {
      try {
        const late = P.history.filter((h) => h.source === 'titan-kill' || endT - h.t <= FINALE_WINDOW);
        if (!late.length) return null;
        const to = late[late.length - 1].level, from = Math.max(1, late[0].level - 1);
        const el = elementForLevel(to), was = elementForLevel(from);
        const asc = tierForLevel(to) >= 6, wasAsc = tierForLevel(from) >= 6;
        const name = (asc ? PRISM_INFO : ELEMENT_INFO[el]).name;
        return { from, to, levels: to - from, element: el, elementName: name, elementChanged: el !== was || asc !== wasAsc,
          stormReached: el === 'storm' && was !== 'storm', ascended: asc,
          // (the line for the HUD in the player's language; elementName stays the English data name)
          text: tr('LV {from} → LV {to} · {element}', { from, to, element: tr(name) }) };
      } catch (e) { warn('finale', e); return null; }
    },
    /** A snapshot for results and tests. */
    summary() {
      return { level: P.level, xp: Math.round(P.xp), tier: P.tier, element: P.element, elementName: P.elementName, ascended: P.ascended, peak: P.peak,
        startLevel: P.startLevel, dmgMult: P.dmgMult, hpMult: P.hpMult, chain: P.chain, chainRadius: P.chainRadius, chainRange: P.chainRange,
        gained: { ...P.gained }, titanMarks: [...marks], finale: P.finale(), levelUps: P.history.map((h) => ({ ...h })) };
    },
  };
  return P;
}
