// game.hud — title screen, in-flight HUD, pause / settings / controls, results (all English). Contract API:
//   toast(text, kind?)            kill feed / notice on the right ('kill' kind is red)
//   banner(title, subtitle?, { duration })   cinematic title card
//   warning(text, level = 1, { duration })   hazard band; level 0 info, 1 warn, 2 danger (also emits 'warning')
//   setObjective(text, sub?)      objective line (top-left); the pause screen repeats it
// Extras: settings (same object as game.settings), change(key, value), stats, start(mode), pause(), resume(),
// quit(), retry(), openPanel('settings'|'controls'), closePanel().
// Reads game.player (Dragon), game.actors, game.titan, game.director.phase, game.cameraRig; listens to damage,
// death, fireball, breath, lock, phase, state, titan:telegraph, warning, pointerlock, mute, director:kill.
// Hit words (hitwords.js): manga "HIT!" / "DIRECT HIT!" / "CRITICAL HIT!" / "SHOT DOWN!" on every hit the player lands
// on an enemy dragon, with a reticle burst and a flash of the struck dragon's plate (?hitwords=0 turns them off). On
// enemy dragons their burst is the one reticle hit marker (the small hitx stays for the titan, never for afterburn).
// Levels (levels.js, game.progress from the gameplay owner's progression): the "LV 7" badge + XP bar in the player
// panel, "+25 XP" under the kill word (the 'xp' event → hitWords.onXp), the LEVEL UP! cut-in ('levelup', or a polled
// rise; emits 'hud:levelup' when it shows, for the sound), the level and element on the results screen, the 'level' tip.
// Touch (28.09): the touch flag is LIVE — it follows game.touchUI.active and its 'touchmode' event (the touch layer:
// stick + buttons), else the HUD's own detection (?touch=1|0, Settings Controls, a coarse pointer at boot, the first
// touch). Touch mode: no pointer lock, no CLICK TO FLY, no key labels, no keyboard tips, a PAUSE + FULLSCREEN pair
// top-left, the old on-screen skill buttons only while there is no touch layer. The MINIMAL HUD (Settings HUD: Auto =
// minimal in touch mode) keeps the reticle, markers, hit words, edge warnings, the slim titan bar and the cut-ins, and
// moves the player panel (LV badge, HP, stamina, XP) to the top right; everything else steps off the screen.
// FULLSCREEN: the title's corner button, the pause menu, Settings and (touch; desktop while the cursor is free) the
// in-flight button — document.documentElement.requestFullscreen from the gesture, icons from fullscreenchange.
import * as THREE from 'three';
import { h, textSetter, classSetter } from './dom.js';
import { tr, trn, lang, onLang, bindText, DICTS } from './i18n.js';
import { loadSettings, saveSettings, takeSessionFlag, setSessionFlag, minimalHud } from './settings.js';
import { buildTitle, buildPause, buildSettings, buildControls, buildResults, clock, createFullscreen, fsButton, onTap } from './screens.js';
import { buildOnlineUi } from './online-ui.js';
import { FlightHud, BOSS_NAME, BOSS_TITLE } from './flight.js';
import { Markers, DamageNumbers, WeakPoints, project, fmtL as fmt, tplN } from './markers.js';
import { HitWords, isAfterburn, isEnemyDragon } from './hitwords.js';
import { Tips } from './tips.js';
import { LevelHud, readProgress, levelSummary } from './levels.js';
import { rankRun, reachedLabel, PHASE_LABEL, DEFEAT_CAP } from './rank.js';
import { clamp } from '../core/util.js';

// Languages (29.09, the user: "a language choice on the menu screen: Russian and English"): every word this file writes
// goes through tr() (Russian texts: src/ui/i18n/ru-hud.js), the texts other systems hand over (objectives, warnings,
// toasts, banners, names) arrive in the player's language already (their owners' tr()); a language switch (onLang)
// rewrites what the HUD keeps on screen. English is byte-identical.
// (the fallback lines when a telegraph brings no text of its own: getters, in the current language)
const TELEGRAPH_TEXT = [
  [/overhead|chop/i, () => tr('OVERHEAD CHOP — BREAK SIDEWAYS!'), 2],
  [/swat/i, () => tr('INCOMING SWAT — DIVE!'), 2],
  [/grab/i, () => tr('GRAB — BREAK AWAY!'), 2],
  [/slam/i, () => tr('HAMMER SLAM — GET CLEAR!'), 2],
  [/clap/i, () => tr('CLAP — PULL AWAY!'), 2],
  [/gust|wing/i, () => tr('WING GUST — BRACE!'), 1],
  [/sunfall|beam/i, () => tr('SUNFALL BEAM — BREAK LINE OF SIGHT!'), 2],
  [/meteor|rain/i, () => tr('METEOR RAIN — KEEP MOVING!'), 1],
  [/ring|bloom/i, () => tr('RING BLOOM — FIND THE GAP!'), 1],
  [/orb|hunter/i, () => tr('HUNTER ORBS — BURN THEM DOWN!'), 1],
  [/comet|volley|fan|fireball|barrage|shot/i, () => tr('FIRE VOLLEY — DODGE!'), 1],
  [/lunge|charge|reposition|ram/i, () => tr('TITAN LUNGE — GET OUT OF ITS PATH!'), 2],
  [/roar/i, () => tr('ROAR — HOLD ON!'), 1],
];
const CYRILLIC = /[\u0400-\u04ff]/;
/** An English text the current language's dictionaries have (English: every text). */
function hasText(en) {
  if (lang() === 'en') return true;
  for (const part of Object.values(DICTS[lang()] || {})) if (part && Object.prototype.hasOwnProperty.call(part, en)) return true;
  return false;
}
/** Russian line breaks in the hazard pill (fix 29.09: in Russian it wraps on every screen): a one-letter preposition /
 *  conjunction or a two-letter one ((other language) …) stays with the next word («(other language)\u00a0(other language)»), a dash and a key-cap group (Q / E, ◀ ▶, F, Shift, (other language) …) with
 *  the word before them («(other language)\u00a0Q\u00a0/\u00a0E» — never "Q / E" alone on the last line). English is untouched. */
const RU_KEYS = '(?:Q|E|F|R|W|A|S|D|V|P|H|M|Tab|Shift|Ctrl|Esc)';
const RU_KEEP = [
  [/\s+—/gu, '\u00a0—'],
  [new RegExp(`\\s+(${RU_KEYS}(?:\\s*\\/\\s*${RU_KEYS})?|◀\\s*▶)(?=$|[\\s.,!?;:)»])`, 'gu'), (m, k) => '\u00a0' + k.replace(/\s+/g, '\u00a0')],
];
function ruKeep(s) { let o = String(s); for (const [re, to] of RU_KEEP) o = o.replace(re, to); return o; }
/** ruKeep in Russian, the text as it is in English. */
const ruText = (s) => (lang() === 'ru' ? ruKeep(s ?? '') : s);
/** A card title in Russian: "(other language)" breaks only at its " · " (never "…(other language)"). */
const ruTitle = (s) => (lang() === 'ru' && / · /.test(String(s ?? '')) ? ruKeep(String(s).split(' · ').map((x) => x.replace(/ /g, '\u00a0')).join(' · ')) : ruText(s));
/** "a b · c d" with no-break spaces inside each segment: a narrow line breaks only between segments. */
function keepSegments(...segs) { return segs.filter(Boolean).map((x) => String(x).replace(/ /g, '\u00a0')).join(' · '); }
// Touch mode (fix 29.09): lines written for the keyboard ("Now — dodge Q / E", titan.js; director / enemy warnings) name
// the touch controls instead — the one place every hazard pill, toast and objective line passes (showWarning, toast,
// setObjective). A key that has no touch button of its own (Space, Ctrl: the stick climbs and dives) is said as the stick.
export const TOUCH_WORDS = [
  [/\b(?:the\s+)?Q\s*(?:\/|or|and)\s*E(?:\s+keys?)?\b/gi, '◀ ▶'],
  [/\b(?:the\s+)?(?:left\s+)?Shift(?:\s+key)?\b/gi, 'BOOST'],
  [/\b(?:the\s+)?Tab(?:\s+key)?\b/gi, 'LOCK'],
  [/\b(?:the\s+)?(?:LMB|left[\s-]click|left mouse(?: button)?)\b/gi, 'FIRE'],
  [/\b(?:the\s+)?(?:RMB|right[\s-]click|right mouse(?: button)?)\b/gi, 'a two-finger drag'],
  [/\b(press|hold|tap)\s+F\b/gi, '$1 FIREBALL'],
  [/\b(press|hold|tap)\s+R\b/gi, '$1 INFERNO'],
  [/\b(?:the\s+)?(?:Space(?:bar)?|Ctrl|Control)(?:\s+key)?\b/gi, 'the stick'],
  [/\bthe\s+mouse\b/gi, (m) => (m[0] === 'T' ? 'The right thumb' : 'the right thumb')],
  [/\bmouse\b/gi, 'right thumb'],
];
// Russian (29.09): the owners' Russian lines keep the key letters and Shift / Tab / Ctrl and say (other language)
// (docs/i18n.md) — the same swap, to the touch buttons' Russian names (tr: (other language)) and the
// right thumb / the stick in the case the sentence needs. (\b does not see Cyrillic letters: Unicode look-arounds.)
const NL = '(?<![\\p{L}\\p{N}])', NR = '(?![\\p{L}\\p{N}])';
const ruRe = (src, fl = 'giu') => new RegExp(NL + src + NR, fl);
export const TOUCH_WORDS_RU = [];
/** `to` with the first letter's case of `m` (a sentence may start with the word). */
function capLike(m, to) { return m[0] !== m[0].toLowerCase() ? to[0].toUpperCase() + to.slice(1) : to; }
/** The text with the keyboard's key names replaced by the touch controls' (touch mode only; exported for tests). */
export function touchText(text) {
  let s = String(text ?? '');
  for (const [re, to] of lang() === 'ru' ? TOUCH_WORDS_RU : TOUCH_WORDS) s = s.replace(re, to);
  return s;
}
// (getters: [text, sub] in the current language — a language switch sets the HUD's own objective again)
const PHASE_OBJECTIVE = {
  intro: () => [tr('Take to the skies over Valdena'), tr('Move the mouse to steer Sora')],
  riders1: () => [tr('Drive off the Shade Riders'), ''],
  riders2: () => [tr('Defeat the second wave'), ''],
  riders3: () => [tr('Defeat the Onyx Aces'), ''],
  riders4: () => [tr('Turn back the Drake Tide'), ''],
  riders5: () => [tr('Break the Twilight Lancers'), ''],
  riders6: () => [tr('Face the Night Court'), ''],
  'titan-rise': () => [tr('Something stirs beneath the clouds…'), ''],
  // fallback text; weakText() builds the line from the titan's own numbers (wave 4: core ×2.5, ×3 more while it
  // blazes open = ×7.5; a hand ×1.5 from its windup through the strike)
  titan: () => [tr('Defeat the Cloud Titan'), keepSegments(tr('Core ×2.5, ×7.5 when open'), tr('head and striking hand ×1.5'))],
  'titan-enraged': () => [tr('The Titan is enraged — finish it!'), keepSegments(tr('Dodge the volleys'), tr('the open core takes ×7.5'))],
  victory: () => [tr('The sky is clear'), ''],
  survival: () => [tr('Survive the endless waves'), keepSegments(tr('Kills score × the wave number'), tr('time adds more'))],
};
// Name cards the HUD owns (the director shows the wave cards itself and leaves the titan's to us). (tr at show time)
const PHASE_BANNER = {
  titan: [BOSS_NAME, BOSS_TITLE],
};
// Kill combo. The director's (director.combo = { count, t }, window 6 s) is the truth when it exists, so the HUD and
// the results agree; without a director the HUD keeps its own with the same window.
const COMBO_WINDOW = 6;
const WAVE_PHASE = /^riders(\d+)$/;
const PHASE_NAMES = ['PHASE I · ASCENDANT', 'PHASE II · WRATH', 'PHASE III · DESPERATION'];
/** PHASE_NAMES[i] in the current language (literal keys; a Map lookup per frame). */
const phaseName = (i) => (i === 0 ? tr('PHASE I · ASCENDANT') : i === 1 ? tr('PHASE II · WRATH') : tr('PHASE III · DESPERATION'));
// Insets (px from the top / bottom / sides) of the ellipse the reticle's edge chevron rides on (wave 5). Wide: inside
// the enemy arrows (42 px), under the objective / boss bar / warning pill, above the tips (bottom-left) and skills.
export const RET_EDGE = { wide: { t: 150, b: 200, s: 110 }, narrow: { t: 170, b: 220, s: 44 }, phone: { t: 200, b: 300, s: 46 } };
// Settings "HUD size: Large (TV)" (fix 29.09, the 86" review: HP / LV / labels below the 16′ legibility minimum from 3 m):
// the touch UI's --z × this
export const HUD_LARGE = 1.3;

// ---------------------------------------------------------------------------------------------------- survival
// The best Survival run: the director's (director.survivalBest / director.survival.best, or its localStorage) merged
// with the HUD's own mirror (written at the end of every survival run). Each field is its own best (the longest time
// and the highest score may come from different runs), as the contract keeps them.
export const SURVIVAL_BEST_KEY = 'skyfire.survival.hud';
const SURVIVAL_STORE_KEYS = ['skyfire.survival', 'skyfire.survival.best', 'skyfire.survivalBest', SURVIVAL_BEST_KEY];
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
/** Any shape → { score, time, wave } | null: a number is a score; objects may say score/bestScore, time/bestTime… */
export function normBest(b) {
  if (b === null || b === undefined) return null;
  if (typeof b === 'number') return b > 0 ? { score: b, time: 0, wave: 0 } : null;
  if (typeof b !== 'object') return null;
  const src = b.best && typeof b.best === 'object' ? b.best : b;
  const score = finite(src.score ?? src.bestScore ?? (typeof b.best === 'number' ? b.best : undefined));
  const time = finite(src.time ?? src.bestTime ?? b.bestTime);
  const wave = finite(src.wave ?? src.bestWave ?? b.bestWave);
  return score > 0 || time > 0 || wave > 0 ? { score, time, wave } : null;
}
/** Field-wise maximum of several bests (null when none). */
export function mergeBest(...list) {
  let out = null;
  for (const x of list) {
    const n = normBest(x);
    if (!n) continue;
    out = out ? { score: Math.max(out.score, n.score), time: Math.max(out.time, n.time), wave: Math.max(out.wave, n.wave) } : { ...n };
  }
  return out;
}

const nextWaveText = tplN(() => tr('NEXT WAVE {n} s'));
const incomingText = tplN(() => tr('+{n} INCOMING'));
/** Survival panel, top centre in place of the wave strip: SURVIVAL · WAVE n / time · score · best / enemies alive. */
class SurvivalHud {
  constructor() {
    this.waveN = h('b.sv-wn'); this.timeV = h('b'); this.scoreV = h('b'); this.bestV = h('b'); this.aliveV = h('b'); this.nextV = h('span.sv-next');
    this.bestK = h('span.sv-k', { text: tr('BEST') });
    this.score = h('span.sv-sc', {}, bindText(h('span.sv-k'), 'SCORE'), this.scoreV);
    this.best = h('span.sv-bs', {}, this.bestK, this.bestV);
    this.aliveK = h('span.sv-k', { text: 'ENEMIES' });
    this.alive = h('div.sv-foe', {}, h('i.sv-fd'), this.aliveV, this.aliveK, this.nextV);
    this.el = h('div.svh', {},
      h('div.sv-top', {}, h('i.sv-dia'), bindText(h('span.sv-t'), 'SURVIVAL'), bindText(h('span.sv-wk'), 'WAVE'), this.waveN, h('i.sv-dia')),
      h('div.sv-row', {}, h('span.sv-tm', {}, this.timeV), h('i.sv-sep'), this.score, h('i.sv-sep'), this.best),
      this.alive);
    this.set = {
      on: classSetter(this.el, 'on'), wave: textSetter(this.waveN), time: textSetter(this.timeV), score: textSetter(this.scoreV),
      best: textSetter(this.bestV), bestK: textSetter(this.bestK), newBest: classSetter(this.el, 'newbest'), alive: textSetter(this.aliveV),
      next: textSetter(this.nextV), many: classSetter(this.alive, 'many'), noBest: classSetter(this.best, 'none'), aliveK: textSetter(this.aliveK),
    };
    this._wave = -1; this._score = -1; this._scoreAt = -9;
  }
  /** v = { wave, time, score, best: {score…}|null, alive, next, newBest } or null (hidden). */
  update(v, now) {
    this.set.on(!!v);
    if (!v) { this._wave = -1; return; }
    const w = Math.max(0, Math.round(v.wave || 0));
    this.set.wave(w > 0 ? String(w) : '—');
    if (w !== this._wave) {
      if (this._wave >= 0 && w > this._wave) this.waveN.animate([{ transform: 'scale(1.9) rotate(-8deg)', color: '#ffffff' }, { transform: 'scale(1) rotate(0)' }], { duration: 420, easing: 'cubic-bezier(.3,1.6,.5,1)' });
      this._wave = w;
    }
    this.set.time(clock(v.time));
    const sc = Math.max(0, Math.round(v.score || 0));
    this.set.score(fmt(sc));
    if (sc > this._score && this._score >= 0 && now - this._scoreAt > 0.3) {
      this._scoreAt = now;
      this.scoreV.animate([{ transform: 'scale(1.3)', color: '#ffffff' }, { transform: 'scale(1)' }], { duration: 240, easing: 'ease-out' });
    }
    this._score = sc;
    const bs = v.best?.score > 0 ? Math.round(v.best.score) : 0;
    this.set.newBest(!!v.newBest);
    this.set.bestK(v.newBest ? tr('NEW BEST') : tr('BEST'));
    this.set.best(v.newBest ? fmt(sc) : bs > 0 ? fmt(bs) : '—');
    this.set.noBest(!v.newBest && !bs);
    const alive = Math.max(0, Math.round(v.alive || 0));
    this.set.alive(String(alive));
    // (the word after the number agrees with it in Russian: 1 (other language); English: ENEMIES as before)
    this.set.aliveK(trn(alive, 'ENEMIES', 'ENEMIES'));
    this.set.many(alive >= 12);
    // riders / flocks still on their way in, and the countdown to the next wave (unless the objective line says it)
    const inc = Math.max(0, Math.round(v.incoming || 0));
    const next = v.nextShown !== false && v.next > 0.5 && v.next < 99 ? '  ·  ' + nextWaveText(Math.ceil(v.next)) : '';
    this.set.next((inc > 0 ? '  ·  ' + incomingText(inc) : '') + next);
  }
}

// ---------------------------------------------------------------------------------------------------- attack runs
// Off-screen attack warnings (fix pass; the playtester, survival waves 1–6: 62 % of the damage Sora took came from
// attackers off-screen at the moment of the hit, 34 % from behind the camera — only fireballs had threat arrows).
// A rider's breath run (enemies: state 'attack', mode 'breath') or a drake's bite dive (state 'dive') that will reach
// Sora within `lead` s while the attacker is off-screen → a red chevron flashes inside the screen edge toward it
// ("ATTACK RUN", "· BEHIND" when it comes from behind the camera) and follows it; one short chirp panned to its side
// (event 'attackrun' → audio). Once per run; it goes when the run ends, the attacker comes into view or dies.
// Fireball passes and drake spits are not warned here: their shots get the markers' incoming-fireball arrows.
const DEG = Math.PI / 180;
export const ATTACK_RUN = {
  lead: 1.35,                       // s: warn when the strike (flame / jaws reaching Sora) is this close
  reach: { breath: 60, bite: 9 },   // m where the strike lands (breath: fx.config.breath.maxRange when published)
  maxDist: 460,                     // m
  cone: 38 * DEG,                   // the attacker's flight path within this of the line to Sora
  minClose: 5,                      // m/s: slower closing is no run (a tail chase that does not close)
  life: 1.6, fade: 0.3,             // s up at most / the fade-out
  seenMargin: 40,                   // px inside the frame edge: an attacker this far in counts as seen (no warning)
  seenHold: 0.2,                    // s in view before an up chevron fades (it was seen)
  max: 3,                           // chevrons at once
  soundGap: 0.5,                    // s between two chirps
  hz: 20,                           // detection rate
  // the ellipse the chevrons ride on, inside the enemy arrows (42 px) — wide / portrait phone
  ins: { wide: { t: 96, b: 124, s: 104 }, phone: { t: 172, b: 330, s: 64 } },
};
/** The attack an enemy pilot is flying at the player: 'breath' (a rider's breath run), 'bite' (a drake's dive) or null. */
export function runKind(pl) {
  if (!pl || pl.alive === false || pl.team !== 'enemy') return null;
  if (pl.kind === 'drake' || pl.variant === 'drake') return pl.state === 'dive' ? 'bite' : null;
  return pl.state === 'attack' && pl.mode === 'breath' ? 'breath' : null;
}
/**
 * Geometry of a pilot's run on the player P ({ pos, vel }): { kind, eta (s until the strike reaches), dist, closing }
 * or null (no run, too far, not pointed at Sora, not closing). Pure; exported for tests.
 */
export function attackRunOf(pl, P, R = ATTACK_RUN, breathReach = R.reach.breath) {
  const kind = runKind(pl);
  const d = pl?.dragon || pl?.actor, E = d?.pos;
  if (!kind || !E || !P?.pos) return null;
  const dx = P.pos.x - E.x, dy = P.pos.y - E.y, dz = P.pos.z - E.z;
  const dist = Math.hypot(dx, dy, dz);
  if (!(dist <= R.maxDist) || dist < 0.5) return null;
  const lx = dx / dist, ly = dy / dist, lz = dz / dist;
  const V = d.vel, PV = P.vel;
  const vx = V?.x || 0, vy = V?.y || 0, vz = V?.z || 0;
  const sp = Math.hypot(vx, vy, vz);
  if (sp > 3 && (vx * lx + vy * ly + vz * lz) / sp < Math.cos(R.cone)) return null;
  const closing = (vx - (PV?.x || 0)) * lx + (vy - (PV?.y || 0)) * ly + (vz - (PV?.z || 0)) * lz;
  const reach = kind === 'breath' ? breathReach : R.reach.bite;
  const gap = Math.max(0, dist - reach);
  if (gap > 0 && closing < R.minClose) return null;
  return { kind, eta: gap / Math.max(closing, R.minClose), dist, closing };
}
/** Screen placement of a chevron toward camera-space (cx, cy, z = distance in front; ≤ 0 behind): the angle on the
 *  edge ellipse (behind and nearly straight back → the bottom edge, "turn around"), and whether it is behind. */
/** A point within `pad` px of one of the rects [[l, t, r, b], …]. */
export function inRects(list, x, y, pad = 0) {
  if (!list) return false;
  for (const r of list) if (r && x > r[0] - pad && x < r[2] + pad && y > r[1] - pad && y < r[3] + pad) return true;
  return false;
}
/** The box [l, t, r, b] comes within `pad` px of one of the rects. */
export function rectsHit(list, l, t, r, b, pad = 0) {
  if (!list) return false;
  for (const q of list) if (q && l < q[2] + pad && r > q[0] - pad && t < q[3] + pad && b > q[1] - pad) return true;
  return false;
}
export function threatAngle(cx, cy, z) {
  const behind = !(z > 0.5);
  let ang = Math.atan2(cy, cx);
  if (!Number.isFinite(ang)) ang = -Math.PI / 2;
  if (behind) {
    const k = clamp(1.2 - Math.hypot(cx, cy) / (0.6 * Math.max(1, Math.abs(z))), 0, 1);   // ≤ 7° off the rear axis: fully down, ≥ 36°: its own side
    if (k > 0) { let d = -Math.PI / 2 - ang; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; ang += d * k; }
  }
  return { ang, behind };
}

/** The pooled chevrons (in the world layer, above the markers' arrows). */
class AttackRuns {
  constructor(root, n = ATTACK_RUN.max) {
    this.items = [];
    for (let i = 0; i < n; i++) {
      const c = h('i.atk-c'), t = bindText(h('b.atk-t'), 'ATTACK RUN'), s = h('small.atk-s');
      const el = h('div.atk', {}, c, h('div.atk-l', {}, t, s));
      root.append(el);
      this.items.push({ el, c, lbl: el.lastChild, s, last: {} });
    }
  }
  /** runs: [{ x, y, rot, lx, ly, behind, alpha, fresh }] — the first n are shown, the rest hidden. */
  update(runs) {
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i], r = runs[i];
      const set = (k, v, fn) => { if (it.last[k] !== v) { it.last[k] = v; fn(v); } };
      if (!r) { set('on', false, (v) => it.el.classList.toggle('on', v)); continue; }
      set('on', true, (v) => it.el.classList.toggle('on', v));
      set('tf', `translate3d(${r.x.toFixed(0)}px, ${r.y.toFixed(0)}px, 0)`, (v) => { it.el.style.transform = v; });
      set('rot', r.rot.toFixed(2), (v) => { it.c.style.transform = `rotate(${v}rad)`; });
      set('lb', `translate3d(${r.lx.toFixed(0)}px, ${r.ly.toFixed(0)}px, 0)`, (v) => { it.lbl.style.transform = v; });
      set('op', r.alpha.toFixed(2), (v) => { it.el.style.opacity = v; });
      set('bh', !!r.behind, (v) => { it.s.textContent = v ? tr('BEHIND') : ''; it.el.classList.toggle('behind', v); });
      if (r.behind) set('bhL', lang(), () => { it.s.textContent = tr('BEHIND'); });
      set('kind', r.kind, (v) => it.el.classList.toggle('bite', v === 'bite'));
      set('up', r.ly < 0, (v) => it.el.classList.toggle('up', v));          // label above the chevron: BEHIND above it
      if (r.fresh) {
        it.c.animate([{ transform: `rotate(${r.rot.toFixed(2)}rad) scale(1.9)`, opacity: 0 }, { transform: `rotate(${r.rot.toFixed(2)}rad) scale(0.9)`, opacity: 1, offset: 0.55 }, { transform: `rotate(${r.rot.toFixed(2)}rad) scale(1)`, opacity: 1 }],
          { duration: 220, easing: 'cubic-bezier(.2,.9,.3,1.3)' });
        it.lbl.animate([{ opacity: 0, letterSpacing: '.5em' }, { opacity: 1, letterSpacing: '.14em' }], { duration: 260, easing: 'ease-out' });
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------- number roll
// Levels and elements (critics #7): the lightning stream ticks 10×/s on every enemy in the beam and chains on every
// tick, so a drake flock carried 6–9 small numbers ("2", "4", "7", "10"…) around the reticle, over the targets. Now:
//   - a lightning / storm breath tick adds to ONE growing number per target: it pops in, rises, then holds beside
//     the target (following it) and counts up while the beam stays on; a new number only after `gap` s without a
//     tick on that target, or once it is `maxAge` s old (then the next one starts while this one fades);
//   - a chain jump (the record's `chain` = k ≥ 1: the beam's jumps and the bolt's) has no number of its own: one
//     "CHAIN ×N" word per chain (N = the deepest jump of the strike, never counting down while it is up), at the first
//     jumped enemy and following it; a chained enemy that also has its own growing number gets the jump's damage in it.
// The ember / azure / radiant fire keeps the rolling 0.28 s numbers; fireballs and bolt hits keep one number each.
export const DMG_ROLL = { gap: 0.4, maxAge: 1.6, hold: 0.6, popEvery: 0.2, chainGap: 0.45, chainDy: -30 };
export const isBoltElement = (e) => e === 'lightning' || e === 'storm';
/** A damage record that rolls into its target's one growing number: a lightning / storm breath tick (not a jump). */
export const rollsNumber = (rec) => !!rec && rec.kind === 'fire' && isBoltElement(rec.element) && !(rec.chain > 0);
const numText = (x) => String(Math.max(1, Math.round(x)));
const chainText = tplN(() => tr('CHAIN ×{n}'));

/**
 * The growing numbers and the CHAIN word over a DamageNumbers pool (markers.js; its entries are taken over right after
 * their spawn: text, keep-out half width, life, position). Times: real seconds (nowReal). opts.worded(target): the hit
 * words say CRITICAL on this target (the number drops its " CRIT").
 */
export class DamageRoll {
  constructor(dmg, R = DMG_ROLL, opts = {}) {
    this.dmg = dmg; this.R = R; this.worded = opts.worded || (() => false);
    this.by = new Map();          // target -> { d, text, sum, t0, t, pop, crit, target, off }
    this.chain = null;            // { d, text, t0, t, pop, n, sim, depth, target, off }
    this.stats = { numbers: 0, grown: 0, chainWords: 0, chainJumps: 0, chainGrown: 0, chainIntoNumber: 0 };
  }
  clear() { this.by.clear(); this.chain = null; }
  /** Spawn through the pool; the entry it used, or null when it spawned nothing (numbers off, no position). */
  _spawn(pos, text, kind) {
    const D = this.dmg;
    if (!D?.enabled || !pos || !D.pool?.length) return null;
    const before = D.stats?.spawned;
    D.spawn(pos, text, kind);
    if (D.stats && D.stats.spawned === before) return null;
    return D.pool[(D.next - 1 + D.pool.length) % D.pool.length] || null;
  }
  /** Still ours and still growing: on, not taken by another spawn, the last hit within `gap`, younger than maxAge. */
  _live(r, t, gap) {
    const d = r?.d;
    return !!d && d.on && d.span?.textContent === r.text && t - r.t <= gap && t - r.t0 < this.R.maxAge;
  }
  _setText(r, text, t) {
    const d = r.d, old = r.text;
    if (text === old) return;
    d.span.textContent = text; r.text = text;
    // the keep-out half width follows the characters (markers.js dnHalf: ∝ the length)
    d.hw = 5 + Math.max(0, d.hw - 5) * text.length / Math.max(1, old.length);
    if (t - r.pop >= this.R.popEvery && typeof d.span.animate === 'function') {
      r.pop = t;
      d.span.animate([{ transform: 'translate(-50%, -50%) scale(1.22)' }, { transform: 'translate(-50%, -50%) scale(1)' }], { duration: 150, easing: 'ease-out' });
    }
  }
  /** A roll that stopped growing (too old) but is still up: it fades now, so a target never carries two. */
  _retire(r) {
    const d = r?.d;
    if (d?.on && d.span?.textContent === r.text) d.life = Math.min(d.life, d.t + 0.25);
  }
  _keep(r, target, pos) {
    const d = r.d;
    d.life = Math.max(d.life, d.t + this.R.hold);
    r.target = target || r.target;
    if (pos && r.target?.pos?.isVector3) { r.off = r.off || pos.clone(); r.off.copy(pos).sub(r.target.pos); }
  }
  /** A lightning / storm breath tick on `target` (its hit point `pos`): into its one growing number. */
  add(target, pos, amount, crit, t) {
    if (!(amount > 0)) return null;
    let r = this.by.get(target);
    if (r && this._live(r, t, this.R.gap)) {
      r.sum += amount; r.t = t;
      if (crit && !r.crit) {
        r.crit = true; r.d.el.className = 'dn crit dn-bolt' + (this.worded(target) ? ' dn-hw' : '');
        r.d.hw += 27;
      }
      this._setText(r, numText(r.sum), t);
      this._keep(r, target, pos);
      this.stats.grown++;
      return r;
    }
    this._retire(r);
    const text = numText(amount);
    const d = this._spawn(pos, text, crit ? 'crit' : 'fire');
    if (!d) { this.by.delete(target); return null; }
    d.el.classList.add('dn-bolt');
    if (crit && this.worded(target)) d.el.classList.add('dn-hw');
    r = { d, text, sum: amount, t0: t, t, pop: t, crit: !!crit, target, off: null };
    this._keep(r, target, pos);
    this.by.set(target, r);
    this.stats.numbers++;
    return r;
  }
  /** A chain jump (rec.chain = k ≥ 1) at `pos`, simulation step `sim`: the CHAIN ×N word. */
  chainJump(rec, pos, t, sim) {
    const R = this.R, k = Math.max(1, Math.round(+rec.chain || 1));
    this.stats.chainJumps++;
    // the enemy has its own growing number (the beam hits it too): the jump's damage counts there
    const own = this.by.get(rec.target);
    if (own && this._live(own, t, R.gap) && rec.amount > 0) { own.sum += rec.amount; this._setText(own, numText(own.sum), t); this._keep(own, rec.target, null); this.stats.chainIntoNumber++; }
    let c = this.chain;
    if (!c || !this._live(c, t, R.chainGap)) {
      this._retire(c);
      c = this.chain = { d: null, text: '', t0: t, t, pop: t, n: 0, sim: null, depth: 0, target: null, off: null };
    }
    if (c.sim !== sim) { c.sim = sim; c.depth = 0; }
    c.depth = Math.max(c.depth, k); c.t = t;
    const n = Math.max(c.n, c.depth);
    const anchor = k === 1 || !c.target || c.target.alive === false;
    if (!c.d) {
      const d = this._spawn(pos, chainText(n), 'chain');
      if (!d) { this.chain = null; return null; }
      d.jx = 0; d.dy = R.chainDy;
      c.d = d; c.text = chainText(n); c.n = n;
      this.stats.chainWords++;
    } else {
      if (n !== c.n) { c.n = n; this._setText(c, chainText(n), t); }
      this.stats.chainGrown++;
    }
    // anchored on the first jumped enemy of the chain as it is now (a new first jump moves it there)
    if (anchor) this._keep(c, rec.target, pos); else c.d.life = Math.max(c.d.life, c.d.t + R.hold);
    return c;
  }
  /** Per frame, before DamageNumbers.update: the growing numbers and the CHAIN word follow their enemy. */
  follow() {
    for (const [target, r] of this.by) {
      const d = r.d;
      if (!d?.on || d.span.textContent !== r.text) { this.by.delete(target); continue; }
      if (r.off && target?.pos?.isVector3 && target.alive !== false) d.pos.copy(target.pos).add(r.off);
    }
    const c = this.chain;
    if (c?.d) {
      if (!c.d.on || c.d.span.textContent !== c.text) this.chain = null;
      else if (c.off && c.target?.pos?.isVector3 && c.target.alive !== false) c.d.pos.copy(c.target.pos).add(c.off);
    }
  }
  /** The live rolls (tests / QA): { numbers: [{ text, age, target }], chain: text | null }. */
  get live() {
    const out = [];
    for (const [target, r] of this.by) if (r.d?.on && r.d.span.textContent === r.text) out.push({ text: r.text, age: +(r.d.t || 0).toFixed(2), target: target?.name || null });
    return { numbers: out, chain: this.chain?.d?.on && this.chain.d.span.textContent === this.chain.text ? this.chain.text : null };
  }
}

export default function createHud(game) {
  const settings = loadSettings(game.qualityMode || game.quality?.name);
  if (!game.settings) game.settings = settings;       // shared read-only view for other systems (audio, camera)
  const nowReal = () => performance.now() / 1000;

  let root = null, hudEl = null, fly = null, markers = null, dmg = null;
  let title = null, pause = null, results = null, panels = {};
  let bannerEl = null, warnEl = null, warnPill = null, warnDir = null, toastsEl = null, promptEl = null, tipsEl = null, photoEl = null, muteEl = null, edges = {};
  let tips = null, weak = null, hitWords = null, surv = null, levels = null;
  const photoWords = [];             // [text node, English] of the photo bar (a language switch sets them again)
  // levels: the progress view-model (reused), the level reached at the end of the run (results), the cut-in's rect
  const progVm = {};
  let levelEnd = null, levelRect = null, toastDim = false;
  const xpStats = { events: 0, total: 0, kills: 0, loose: 0, titan: 0, numbers: 0, worded: 0, unclaimed: 0, last: null };
  // XP whose event named no actor (the progression's 'xp' { source: 'rider' | 'drake' | … } comes from its own 'death'
  // listener, which runs just before the HUD's): the HUD's 'death' handler in the same dispatch claims it for that kill
  const xpLoose = [];
  // …and the other way round (if the HUD's 'death' listener ran first): the kill of this step waits for its XP
  let lastKill = null;               // { actor, worded, sim, real, claimed }
  // survival: the run in progress (the best before it started, for "NEW BEST"), the last live numbers (the results
  // screen falls back to them), the director's end payload
  const survRun = { active: false, prevBest: null, last: null, end: null, bannerAt: -99, waveSeen: 0 };
  const survVm = { wave: 0, time: 0, score: 0, best: null, alive: 0, incoming: 0, next: 0, newBest: false, kills: 0 };
  let hoverBlend = 0;              // 0 = the heading crosshair, 1 = the TPS aim point (hover: the reticle is the aim)
  let promptModes = false;
  // warnings: the compact pill in the upper third; src() → world point of the attack (arrow), until = real time
  const warnState = { until: -99, src: null, level: 1, dirShown: false };
  let warnQueue = null, warnFlag = false;
  // the hit words' panels besides the hard readouts: the objective and the kill feed (a portrait phone puts both
  // inside the words' area). Measured when they change, on resize or once a second, and only while words are up.
  const wordPanels = { at: -99, w: 0, h: 0, dirty: true, rects: [] };
  let bannerUntil = -99, nameCardRetry = null;
  let titleSeen = false, veilAnim = null;
  let tipCtxAcc = 0;
  const tipCtx = { playing: false, hidden: false, enemiesNear: 0, enemyBehind: false, camFree: false, hover: false };
  // results of this run (attempts since the last start from the title), summed across Retry
  const runTotals = { attempts: 0, time: 0, downed: 0, damage: 0, bestScore: 0 };
  const navStack = [];
  let openPanelName = null, panelFromH = false, onlineUi = null;
  let stateChangedAt = 0, lastStart = 'story', autostart = null;
  let objective = { text: '', sub: '', setAt: -99 };
  let lastBannerAt = -99, lastObjectiveCall = -99;
  let breathOn = false, overLatch = false;
  let lockTarget = null;
  let lastDrakeToast = null;
  const shots = [];                  // enemy projectiles for threat arrows
  // off-screen attack runs (ATTACK_RUN): pilot → { warned } for the run in progress, the chevrons up, counters (tests)
  const threat = { acc: 0, runs: new WeakMap(), up: [], view: [], lastSound: -99, lastWarn: -99, log: [],
    stats: { warned: 0, breath: 0, bite: 0, behind: 0, sounds: 0, seenFirst: 0 } };
  let atk = null;
  const fireAgg = new Map();         // target -> { sum, pos, t }
  let roll = null;                   // DamageRoll: lightning / storm numbers and the CHAIN word (levels)
  let rollWarned = false;
  const rollWarn = (e) => { if (!rollWarned) { rollWarned = true; console.warn('[hud] lightning numbers', e); } };
  let playerFireAgg = { sum: 0, t: 0 };
  let titleLiveTimer = null, resultsTimer = null, fallbackTimer = null;
  const stats = { time: 0, damage: 0, downed: 0, shots: 0, hits: 0, bestCombo: 0 };
  const combo = { count: 0, kills: 0, until: -99 };        // kill counter and combo (simulation time)
  let waveState = { key: '', left: -1, clearedUntil: -99 };
  let waveFlash = null;              // { title, until } — "WAVE 1/3 · CLEARED" from the director's wave:cleared
  const comboView = { count: 0, kills: 0, frac: 0 };
  /** The combo as shown: director.combo when present (window director.comboWindow ?? 6 s), else the HUD's own. */
  function readCombo() {
    const d = game.director, now = game.time.now;
    const dc = d?.combo;
    if (dc && typeof dc.count === 'number' && typeof dc.t === 'number') {
      const win = num(d.comboWindow ?? d.balance?.comboWindow, COMBO_WINDOW);
      const age = now - dc.t;
      const live = age >= -0.01 && age <= win && dc.count > 0;
      comboView.count = live ? dc.count : 0;
      comboView.frac = live ? clamp(1 - age / win, 0, 1) : 0;
    } else {
      if (combo.count > 0 && now >= combo.until) combo.count = 0;
      comboView.count = combo.count;
      comboView.frac = combo.count > 0 ? clamp((combo.until - now) / COMBO_WINDOW, 0, 1) : 0;
    }
    const dk = d?.stats?.kills;
    comboView.kills = typeof dk === 'number' && d.running !== false ? dk : combo.kills;
    return comboView;
  }
  let breathWin = { t: 0, hit: false }, lastFbHit = -1;
  let runResults = null;             // the director's final numbers (grade, score, time…), when it provides them
  // ---- touch mode (live) and the HUD layout. game.touchUI (the touch layer) is the truth when it exists; without it the
  // HUD decides the same way: ?touch=1 / 0, Settings Controls touch / desktop, else Auto = a coarse pointer at boot or
  // the first real touch. minimal = Settings HUD minimal, or Auto in touch mode.
  const touchParam = game.params?.get?.('touch');     // ?touch=1 / 0 forces the layout (tests, desktop touchscreens)
  const bootCoarse = typeof matchMedia === 'function' && (matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints > 0 && !matchMedia('(pointer: fine)').matches));
  let touchSeen = false;                               // (no touch layer) a real touch happened: Auto becomes touch
  const fallbackTouch = () => {
    if (touchParam === '1' || touchParam === '0') return touchParam === '1';
    if (settings.controls === 'touch' || settings.controls === 'desktop') return settings.controls === 'touch';
    return touchSeen || bootCoarse;
  };
  const touchNow = () => { const T = game.touchUI; return T && typeof T.active === 'boolean' ? T.active : fallbackTouch(); };
  let touch = touchNow(), minimal = minimalHud(settings, touch);
  const layout = { touch: null, minimal: null, ntu: null, z: 0, flips: 0, log: [] };
  let legacyWired = false, tbtns = null, fsHud = null, photoTouch = null;
  const fs = createFullscreen();
  const inputTap = (code) => { try { game.input?.press?.(code); game.input?.release?.(code); } catch { /* input optional */ } };
  // keep-outs (measured ≤ 1 Hz, on resize and when the layout flips): hard = the readouts + the HUD's own panels and
  // buttons (hit words, damage numbers); edge = panels and buttons only (off-screen arrows, attack-run chevrons)
  const keep = { at: -99, w: 0, h: 0, dirty: true, hard: [], edge: [] };
  const _p = new THREE.Vector3(), _q = new THREE.Vector3(), _d = new THREE.Vector3(), _tp = new THREE.Vector3();
  const pr = { x: 0, y: 0, cx: 0, cy: 0, z: 0, onScreen: false };

  const sound = (name) => { try { game.audio?.play?.(name); } catch { /* audio optional */ } };
  const player = () => game.player || null;
  const pActor = () => game.player?.actor || null;
  const isPlayer = (a) => !!a && !!game.player && (a === game.player || a === game.player.actor);
  const titanActor = () => game.titan?.actor || game.actors.find((a) => a.kind === 'titan') || null;
  /** Sora's element for the words that name her weapons (tips, controls): game.progress, else the dragon's mirror. */
  const KIT = new Set(['ember', 'azure', 'radiant', 'lightning', 'storm']);
  const kitNow = () => { try { const e = game.progress?.element ?? player()?.element; return KIT.has(e) ? e : 'ember'; } catch { return 'ember'; } };

  // ------------------------------------------------------------------------------------------------ flow
  function start(mode = 'story') {
    lastStart = mode;
    Object.assign(runTotals, { attempts: 0, time: 0, downed: 0, damage: 0, bestScore: 0 });
    sound('uiSelect');
    closeAllPanels();
    if (!touch) game.input?.requestLock?.();            // inside the click / key gesture (never in touch mode)
    resetStats();
    if (mode === 'survival') beginSurvival();
    game.setState('play', { start: mode });
    if (mode === 'titan') {
      const d = game.director;
      try {
        if (d?.startAt) d.startAt('titan');
        else if (d?.skipTo) d.skipTo('titan-rise');
      } catch (e) { console.warn('[hud] could not jump to the titan', e); }
    } else if (mode === 'survival') {
      const d = game.director;
      try {
        if (d?.startAt) d.startAt('survival');
        else if (d?.start) d.start('survival');
      } catch (e) { console.warn('[hud] could not start survival', e); }
    }
  }
  /** A survival run starts (menu, Retry or the director entering the phase by itself): remember the best before it. */
  function beginSurvival() {
    survRun.active = true;
    survRun.prevBest = readSurvivalBest();
    survRun.last = null; survRun.end = null; survRun.waveSeen = 0;
  }
  function readSurvivalBest() {
    const d = game.director, list = [];
    try { list.push(typeof d?.survivalBest === 'function' ? d.survivalBest() : d?.survivalBest); } catch { /* optional */ }
    try { const S = d?.survival; if (S && typeof S === 'object') list.push(S.best && typeof S.best === 'object' ? S.best : { score: S.best, time: S.bestTime, wave: S.bestWave }); } catch { /* optional */ }
    for (const k of SURVIVAL_STORE_KEYS) {
      try { const raw = localStorage.getItem(k); if (raw) list.push(JSON.parse(raw)); } catch { /* blocked / not JSON */ }
    }
    return mergeBest(...list);
  }
  /** The HUD's mirror of the best run — only for a director that keeps no bests of its own (survivalBest()); never
   *  from a debug start at a later wave (?debug&wave=N), which the director keeps out of its bests too. */
  function saveSurvivalBest(run) {
    const d = game.director;
    if (typeof d?.survivalBest === 'function' || d?.survival?.debugStart || (d?.survival?.startWave ?? 1) > 1) return;
    const best = mergeBest(readSurvivalBest(), run);
    if (!best) return;
    try { localStorage.setItem(SURVIVAL_BEST_KEY, JSON.stringify(best)); } catch { /* private mode */ }
  }
  /** director.survival → the panel's numbers (null outside a survival run). */
  function readSurvival(ph) {
    const d = game.director, S = d?.survival;
    const inPhase = ph === 'survival';
    if (!S || typeof S !== 'object' || !(inPhase || (survRun.active && (ph === 'defeat' || game.state === 'defeat')))) return null;
    if (inPhase && !survRun.active) beginSurvival();
    const v = survVm;
    v.wave = finite(S.wave); v.time = finite(S.time); v.score = finite(S.score); v.kills = finite(S.kills);
    let alive = typeof S.alive === 'number' ? S.alive : null;
    if (alive === null) { alive = 0; for (const a of game.actors) if (a?.alive && a.team === 'enemy' && a.kind !== 'titan') alive++; }
    v.alive = alive;
    v.next = finite(S.nextIn ?? S.next ?? S.nextWave);
    v.incoming = finite(S.pending);
    const prev = survRun.prevBest;
    v.best = mergeBest(prev, S.best && typeof S.best === 'object' ? S.best : typeof S.best === 'number' ? { score: S.best } : null);
    // "NEW BEST" once this run's score passes the best from before it (the director may already count it in best)
    v.newBest = typeof S.newBest === 'boolean' ? S.newBest : v.score > 0 && v.score > (prev?.score || 0) && !!prev;
    if (v.newBest && v.best) v.best.score = Math.max(v.best.score, v.score);
    survRun.last = { wave: v.wave, time: v.time, score: v.score, kills: v.kills };
    return v;
  }
  function pauseGame() {
    if (game.state !== 'play') return;
    game.setState('paused');
    game.input?.exitLock?.();
  }
  function resume() {
    closeAllPanels();
    sound('uiSelect');
    if (!touch) game.input?.requestLock?.();
    game.setState('play');
  }
  function quit() {
    sound('uiBack');
    closeAllPanels();
    const d = game.director;
    if (d?.reset) { try { d.reset(); game.setState('title'); return; } catch (e) { console.warn('[hud] director.reset failed', e); } }
    reload(null);
  }
  function retry() {
    sound('uiSelect');
    const d = game.director;
    try {
      if (d?.restart) { closeAllPanels(); resetStats(); d.restart(lastStart); if (game.state !== 'play') game.setState('play', { start: lastStart }); if (!touch) game.input?.requestLock?.(); return; }
      if (d?.reset) { d.reset(); start(lastStart); return; }
    } catch (e) { console.warn('[hud] retry failed', e); }
    reload(lastStart);
  }
  function reload(autostartMode) {
    if (autostartMode) setSessionFlag('autostart', autostartMode);
    location.reload();
  }

  // ------------------------------------------------------------------------------------------------ panels & nav
  const api = {
    get settings() { return settings; },
    sound, start, resume, quit, retry,
    change, openPanel: (n) => openPanel(n), closePanel: () => closePanel(),
    /** (leaderboard update) The leaderboard on the board of the run just flown (the results screen's button). */
    openBoard() { try { const b = game.online?.last?.board; if (b && onlineUi) onlineUi.panels.leaderboard.board = b; } catch { /* the last board shown */ } openPanel('leaderboard'); },
    fs,
    /** (performance update) The governor's read-out (Settings shows the frame rate beside the graphics mode). */
    perf: () => game.perf?.stats || null,
    /** What Auto resolved to (Settings shows it): touch mode, minimal HUD. */
    mode: () => ({ touch, minimal, controls: settings.controls, hud: settings.hud }),
    // the pause menu's touch items: the same key edges the keyboard gives (V / P), taken by the camera in play
    cameraView() { resume(); inputTap('KeyV'); },
    photoMode() { resume(); inputTap('KeyP'); },
  };
  function topNav() { return navStack[navStack.length - 1] || null; }
  function setScreenNav(nav) { navStack.length = 0; if (nav) { navStack.push(nav); requestAnimationFrame(() => nav.focus(0, true)); } }
  function openPanel(name, fromH = false) {
    const p = panels[name];
    if (!p) return;
    if (openPanelName) closePanel(true);
    sound('uiSelect');
    if (name === 'settings') p.refresh();
    else if (name === 'controls') { try { p.refresh?.(kitNow(), touch); } catch { /* the rows keep their words */ } }
    else { try { p.refresh?.(); } catch (e) { console.warn('[hud] panel ' + name, e); } }      // account / leaderboard / stages
    p.el.classList.add('on');
    title.el.classList.add('dim'); pause.el.classList.add('dim'); results.el.classList.add('dim');
    openPanelName = name; panelFromH = fromH;
    navStack.push(p.nav);
    requestAnimationFrame(() => p.nav.focus(0));
  }
  function closePanel(silent = false) {
    if (!openPanelName) return;
    const p = panels[openPanelName];
    p.el.classList.remove('on');
    title.el.classList.remove('dim'); pause.el.classList.remove('dim'); results.el.classList.remove('dim');
    if (navStack[navStack.length - 1] === p.nav) navStack.pop();
    const wasH = panelFromH;
    openPanelName = null; panelFromH = false;
    if (!silent) sound('uiBack');
    const back = topNav();
    if (back) back.focus(back.i, true);
    if (wasH && game.state === 'paused' && !silent) resume();
  }
  function closeAllPanels() { while (openPanelName) closePanel(true); }

  function change(key, value) {
    settings[key] = value;
    try {
      if (key === 'quality' && game.quality?.name !== value) game.setQuality(value);
      const cam = game.cameraRig?.settings;
      if (cam && key === 'mouseSensitivity') { cam.sensitivity = value; game.cameraRig.saveSettings?.(); }
      if (cam && key === 'invertY') { cam.invertY = value; game.cameraRig.saveSettings?.(); }
      if (key === 'muted' && game.audio?.setMuted && game.audio.muted !== value) game.audio.setMuted(value);
      if ((key === 'damageNumbers' || key === 'minimalNumbers') && dmg) dmg.enabled = numbersOn();
      if (key === 'hitWords' && hitWords) { hitWords.enabled = !!value; if (!value) hitWords.clear(); }
      // Controls: an explicit mode goes to the touch layer at once (Auto: the layer decides from the 'settings' event)
      const T = game.touchUI;
      if (key === 'controls' && T && typeof T.setActive === 'function' && (value === 'touch' || value === 'desktop')) T.setActive(value === 'touch', 'settings');
    } catch (e) { console.warn('[hud] setting failed', key, e); }
    saveSettings(settings);
    game.events.emit('settings', { settings, key });
    if (key === 'controls' || key === 'hud') syncMode('settings');
    if (key === 'touchButtonSize' || key === 'leftHanded' || key === 'touchLayout' || key === 'screenMargin') keep.dirty = true;   // the buttons moved
    if (key === 'hudSize') { updateZoom(); keep.dirty = true; wordPanels.dirty = true; fly?.invalidateLayout?.(); }
  }
  /** Damage numbers of the layout in use (the Full HUD's damageNumbers, the Minimal HUD's minimalNumbers). */
  function numbersOn() { return minimal ? !!settings.minimalNumbers : settings.damageNumbers !== false; }

  function onKey(e) {
    if (!root) return;
    const st = game.state;
    const nav = topNav();
    const menuUp = nav && (st === 'title' || st === 'paused' || st === 'victory' || st === 'defeat');
    if (e.code === 'KeyH' && !e.repeat) {
      if (openPanelName === 'controls') { closePanel(); e.preventDefault(); return; }
      if (st === 'title' || st === 'paused') { openPanel('controls'); e.preventDefault(); return; }
      if (st === 'play') { pauseGame(); openPanel('controls', true); e.preventDefault(); return; }
      if (st === 'photo') { photoEl.classList.toggle('on'); return; }
    }
    if (menuUp) {
      if (e.code === 'Escape' && nowReal() - stateChangedAt < 0.35) return;   // the Esc that just paused (pointer lock)
      if (nav.key(e)) e.preventDefault();
      return;
    }
    if (e.code === 'Escape' && st === 'play' && nowReal() - stateChangedAt > 0.35) { pauseGame(); e.preventDefault(); }
  }

  // ------------------------------------------------------------------------------------------------ public widgets
  function toast(text, kind = '') {
    if (!toastsEl) return;
    const el = h('div.toast' + (kind ? '.' + kind : ''));
    if (kind === 'kill' && typeof text === 'object') el.append(h('b', { text: text.name }), h('span', { text: ' ' + text.rest }));
    else el.textContent = touch ? touchText(text) : String(text);
    if (typeof text !== 'object') el._raw = String(text);        // (a language switch writes a known line again)
    toastsEl.append(el);
    while (toastsEl.children.length > 4) toastsEl.firstChild.remove();
    wordPanels.dirty = true;
    el.animate([{ opacity: 0, transform: 'translate3d(30px, 0, 0)' }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'ease-out' });
    const out = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 500, delay: 3200, fill: 'forwards' });
    out.onfinish = () => el.remove();
    return el;
  }
  function banner(t, sub = '', opts = {}) {
    if (!bannerEl) return;
    lastBannerAt = nowReal();
    const dur = (opts.duration ?? 3.2) * 1000;
    bannerUntil = lastBannerAt + dur / 1000;
    // (Russian: the short words kept with their neighbours — the touch card is narrower since 29.09 and its line wraps)
    bannerEl.replaceChildren(h('div.bn-t', { text: ruTitle(t) }), sub ? h('div.bn-s', { text: ruText(sub) }) : '');
    bannerEl._raw = [String(t ?? ''), String(sub ?? '')];
    bannerEl.getAnimations().forEach((a) => a.cancel());
    bannerEl.animate([
      { opacity: 0, transform: 'scaleY(0.2)', letterSpacing: '0.6em' },
      { opacity: 1, transform: 'scaleY(1)', offset: 0.1 },
      { opacity: 1, transform: 'scaleY(1)', offset: 0.85 },
      { opacity: 0, transform: 'scaleY(1)' },
    ], { duration: dur, easing: 'ease-out', fill: 'forwards' });
    sound('banner');
  }
  function warning(text, level = 1, opts = {}) {
    showWarning(text, level, opts);
    game.events.emit('warning', { text, level, fromHud: true });
  }
  /** The pill's words: touch mode names the touch controls ("dodge Q / E" → "dodge ◀ ▶" — no key names on a touch
   *  screen), Russian keeps its short words with their neighbours (ruKeep), in capitals. */
  function pillText(text) {
    const t = touch ? touchText(text) : String(text ?? '');
    return (lang() === 'ru' ? ruKeep(t) : t).toUpperCase();
  }
  /**
   * The hazard pill: a compact line in the upper third (never over the centre of the screen, where the attack is),
   * short-lived, with an arrow toward the attack when opts.src() gives its world position. A warning wins over a
   * name card that is still up (the card fades out at once). A lower-level line (an info) waits until a more urgent
   * one has run out instead of replacing it; the titan's own "now" cue keeps the arrow of the telegraph it answers.
   */
  function showWarning(text, level = 1, opts = {}) {
    if (!warnEl) return;
    const lv = typeof level === 'number' ? clamp(Math.round(level), 0, 2) : level === 'danger' ? 2 : level === 'info' ? 0 : 1;
    const now = nowReal();
    if (lv < warnState.level && now < warnState.until - 0.25) { warnQueue = { text, level: lv, opts, at: now }; return; }
    warnQueue = null;
    const keepSrc = !opts.src && opts.source === 'titan' && lv >= 2 && now < warnState.until ? warnState.src : null;
    const dur = clamp(opts.duration ?? 1.7, 1.1, 3) * 1000;
    warnEl.className = `warn l${lv}`;
    warnDir = h('i.warn-dir');
    warnPill = h('div.warn-p', {}, warnDir, h('div.warn-t', { text: pillText(text) }));
    warnState.text = String(text);
    warnEl.replaceChildren(warnPill);
    warnPill.animate([
      { opacity: 0, transform: 'translate3d(0, -10px, 0) scale(0.92)' }, { opacity: 1, transform: 'none', offset: 0.1 },
      { opacity: 1, transform: 'none', offset: 0.84 }, { opacity: 0, transform: 'translate3d(0, -6px, 0)' },
    ], { duration: dur, easing: 'ease-out', fill: 'forwards' });
    warnState.until = now + dur / 1000;
    warnState.src = typeof opts.src === 'function' ? opts.src : keepSrc;
    warnState.level = lv;
    warnState.dirShown = false;
    warnState.o = null;                          // the pill's centre, measured once on the first arrow frame
    warnDir.style.display = 'none';
    if (now < bannerUntil) hideBanner();
  }
  /** Per frame: the queued lower-level line once the urgent one is over (if it is still fresh), and the .warning flag
   *  on the HUD (narrow screens give the objective's place to the pill while it is up). */
  function updateWarnFlow() {
    const now = nowReal();
    if (warnQueue && now >= warnState.until - 0.1) {
      const q = warnQueue; warnQueue = null;
      warnState.level = -1;
      if (now - q.at < 2.5) showWarning(q.text, q.level, q.opts);
    }
    const on = now < warnState.until;
    if (on !== warnFlag) { warnFlag = on; hudEl.classList.toggle('warning', on); }
  }
  function hideBanner() {
    bannerUntil = -99;
    // the titan's name card, cut by a warning, comes back once at the next quiet moment
    if (nameCardRetry) { const fn = nameCardRetry; nameCardRetry = null; setTimeout(fn, 400); }
    const cur = +getComputedStyle(bannerEl).opacity || 0;
    bannerEl.getAnimations().forEach((a) => a.cancel());
    bannerEl.animate([{ opacity: cur }, { opacity: 0 }], { duration: 220, easing: 'ease-out', fill: 'forwards' });
  }
  /** Arrow in the warning pill toward the attack (the attacking hand), updated every frame while the pill is up. */
  function updateWarnDir() {
    if (!warnDir || !warnState.src) return;
    if (nowReal() > warnState.until) { warnState.src = null; return; }
    let p = null;
    try { p = warnState.src(); } catch { p = null; }
    if (!p || !game.camera) { if (warnState.dirShown) { warnDir.style.display = 'none'; warnState.dirShown = false; } return; }
    const w = game.size?.w || innerWidth, H = game.size?.h || innerHeight;
    project(game.camera, p, w, H, pr);
    if (!warnState.o) { const r = warnPill.getBoundingClientRect(); warnState.o = [r.left + r.width / 2, r.top + r.height / 2]; }
    const [ox, oy] = warnState.o;
    // on screen: straight at the point; behind or off screen: the camera-space direction (y up → screen y down)
    const ang = pr.onScreen && pr.z > 0 ? Math.atan2(pr.y - oy, pr.x - ox) : Math.atan2(-pr.cy, pr.cx);
    if (!warnState.dirShown) { warnDir.style.display = ''; warnState.dirShown = true; }
    warnDir.style.transform = `rotate(${ang.toFixed(2)}rad)`;
  }
  function setObjective(text, sub = '') {
    lastObjectiveCall = nowReal();
    objective = { text: text || '', sub: sub || '', setAt: nowReal(), hud: null };
    wordPanels.dirty = true;
    fly?.setObjective(touch ? touchText(objective.text) : objective.text, touch ? touchText(objective.sub) : objective.sub);
    pause?.setObjective(touch ? touchText(objective.text) : objective.text);
  }
  /** The HUD's own objective for a phase (PHASE_OBJECTIVE; the titan's weak points from its own numbers) in the current
   *  language, remembered (objective.hud) so that a language switch sets it again. */
  function hudObjective(phase) {
    const [t, s] = PHASE_OBJECTIVE[phase]();
    // (touch mode: no mouse words — the intro's line says what the fingers do)
    const sub = phase === 'intro' && touch ? keepSegments(tr('Drag on the right to aim'), tr('the stick flies Sora')) : s;
    setObjective(t, weakText(phase) || sub);
    objective.hud = phase;
  }
  // A line another system handed over, in the current language when it is a known dictionary text (Russian → its
  // English key → tr): the reverse map is built on the first language switch.
  let revMap = null;
  function retr(str) {
    if (!str) return str;
    if (!revMap) {
      revMap = new Map();
      for (const part of Object.values(DICTS.ru || {})) for (const [k, v] of Object.entries(part || {})) { revMap.set(k, k); if (typeof v === 'string') revMap.set(v, k); }
    }
    const en = revMap.get(str);
    return en === undefined ? str : tr(en);
  }
  /** The survival objective's sub-line counts down to the next wave (then the panel leaves its own NEXT WAVE out): the
   *  director's flag (survival.objCountdown); a director without one — the displayed words (English). */
  function objCountsDown() {
    const f = game.director?.survival?.objCountdown;
    return typeof f === 'boolean' ? f : /next wave/i.test(fly?.objS?.textContent || '');
  }
  /** The kill feed's line after the name (Russian: a drake — (other language) — is feminine). */
  function killRest(drake) { return drake && lang() !== 'en' ? tr('— DOWNED (a drake)') : tr('— DOWNED'); }
  /** A language switch (Settings / the title's selector, no reload): what the HUD keeps on screen, again in the new
   *  language (the per-frame text follows by itself; the DOM built once is bindText's). Registered before the menus'
   *  listeners (init): the pause screen then re-reads the HUD's lines already in the new language. */
  function relang() {
    if (!root) return;
    try {
      for (const [n, en] of photoWords) n.textContent = tr(en);
      // the kill feed and the notices still fading out, the hazard pill and the name card while they are up
      for (const el of toastsEl?.children || []) {
        const K = el._kill;
        if (K && el.firstChild && el.lastChild) { el.firstChild.textContent = tr(K.en).toUpperCase(); el.lastChild.textContent = ' ' + (K.n > 1 ? tr('×{n} — DOWNED', { n: K.n }) : killRest(K.drake)); }
        else if (el._raw) { const t = retr(el._raw); if (t !== el._raw) { el._raw = t; el.textContent = touch ? touchText(t) : t; } }
      }
      const now = nowReal();
      if (warnPill && now < warnState.until && warnState.text) {
        const t = retr(warnState.text), el = warnPill.querySelector('.warn-t');
        if (el && t !== warnState.text) { warnState.text = t; el.textContent = pillText(t); }
      }
      if (bannerEl?._raw && now < bannerUntil) {
        const [t, sb] = bannerEl._raw.map(retr), a = bannerEl.querySelector('.bn-t'), b = bannerEl.querySelector('.bn-s');
        if (a) a.textContent = ruTitle(t); if (b) b.textContent = ruText(sb);
        bannerEl._raw = [t, sb];
      }
      const sub = promptEl?.querySelector('.pr-s');
      if (sub) sub.textContent = promptModes ? tr('The mouse aims Sora  ·  hold W to fly  ·  Esc pauses') : tr('Your mouse steers Sora  ·  Esc pauses');
      // the objective: the HUD's own again (the director sets its own lines again itself: director.relabel); another
      // line keeps what it said, in the new language when it is a known text
      if (objective.hud && PHASE_OBJECTIVE[objective.hud]) hudObjective(objective.hud);
      else if (objective.text) { const t = retr(objective.text), s2 = retr(objective.sub); if (t !== objective.text || s2 !== objective.sub) setObjective(t, s2); }
      // the pause screen's lines (also while it is hidden: its own listener re-reads them on every switch; the numbers line
      // is written again when the game pauses)
      pause?.setObjective?.(touch ? touchText(objective.text) : objective.text);
      // (the wave label is the last frame's, in the old language: read the wave again first)
      if (game.state === 'paused' && minimal) { try { readWave(game.director?.phase || ''); } catch { vm.wave = null; } }
      pause?.setInfo?.(game.state === 'paused' && minimal ? pauseInfo() : '');
      // the results on screen: shown again from the run's numbers (the director's own onLang has relabelled its words)
      // (the director's listener ran before this one — registered at its init — and has relabelled its retry / reached
      // words; the results screen's own listener comes after and re-reads these, already in the new language)
      if ((game.state === 'victory' || game.state === 'defeat') && results?.el?.classList.contains('on')) {
        const win = game.state === 'victory';
        results.show(win, resultsView(win, true));
      }
      wordPanels.dirty = true; keep.dirty = true; fly?.invalidateLayout?.();
    } catch (e) { console.warn('[hud] language switch', e); }
  }
  function edge(side, seconds) {
    const el = edges[side];
    if (!el) return;
    el.classList.add('on');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('on'), seconds * 1000);
  }

  // ------------------------------------------------------------------------------------------------ build
  function build() {
    root = document.getElementById('ui');
    if (!root) { root = h('div'); root.id = 'ui'; (document.getElementById('app') || document.body).append(root); }
    title = buildTitle(api);
    pause = buildPause(api);
    results = buildResults(api);
    panels = { settings: buildSettings(api), controls: buildControls(api) };
    // (leaderboard update) the pilot's panels and the account chip on the title (its last keyboard stop)
    try {
      onlineUi = buildOnlineUi(api, game);
      Object.assign(panels, onlineUi.panels);
      title.el.append(onlineUi.chip);
      title.nav.add({ el: onlineUi.chip });
      game.events.on('online:score', (l) => { try { results.setOnline(onlineUi.resultsText(l, runResults)); } catch { /* the line stays */ } });
    } catch (e) { onlineUi = null; console.warn('[hud] online panels failed', e); }
    fly = new FlightHud();
    surv = new SurvivalHud();
    fly.el.insertBefore(surv.el, fly.objective);
    hudEl = h('div.hud');
    const world = h('div.world');
    markers = new Markers(world);
    atk = new AttackRuns(world);
    weak = new WeakPoints(world);
    dmg = new DamageNumbers(world);
    dmg.enabled = numbersOn();
    roll = new DamageRoll(dmg, DMG_ROLL, { worded: (t) => !!hitWords?.enabled && isEnemyDragon(t) });
    // hit words on top of the numbers; their reticle burst above the reticle (appended to the flight HUD below)
    hitWords = new HitWords(world, fly.el, { game, markers, comboNow: () => readCombo().count,
      enabled: game.params?.get?.('hitwords') !== '0' && settings.hitWords !== false });
    bannerEl = h('div.banner'); warnEl = h('div.warn'); toastsEl = h('div.toasts');
    edges = { l: h('div.edge.l'), r: h('div.edge.r'), t: h('div.edge.t') };
    promptEl = h('div.prompt', {}, bindText(h('div.pr-t'), 'CLICK TO FLY'), h('div.pr-s', { text: tr('Your mouse steers Sora  ·  Esc pauses') }));
    tipsEl = h('div.tips');
    tips = new Tips(tipsEl);
    // photo mode: the keys (desktop) or two buttons and the gestures (touch: Hide takes the bar away, a tap brings it back)
    const phHide = bindText(h('button.ph-b', { type: 'button', tabindex: '-1' }), 'Hide');
    const phExit = bindText(h('button.ph-b.ph-x', { type: 'button', tabindex: '-1' }), 'Exit');
    onTap(phHide, () => { photoEl.classList.add('ph-off'); photoTouch.hiddenAt = nowReal(); });
    onTap(phExit, () => { if (game.state === 'photo') inputTap('KeyP'); });
    // (the words between the key caps are text nodes: set again on a language switch)
    const w = (en) => { const n = document.createTextNode(tr(en)); photoWords.push([n, en]); return n; };
    photoEl = h('div.photo', {}, bindText(h('span.ph-k'), 'PHOTO MODE'),
      h('span.desk', {}, bindText(h('kbd'), 'Drag'), w('orbit')), h('span.desk', {}, bindText(h('kbd'), 'Wheel'), w('zoom')),
      h('span.desk', {}, h('kbd', { text: 'Shift' }), '+', bindText(h('kbd'), 'Wheel'), w('lens')), h('span.desk', {}, h('kbd', { text: 'Q' }), h('kbd', { text: 'E' }), w('tilt')),
      h('span.desk', {}, h('kbd', { text: 'H' }), w('hide')), h('span.desk', {}, h('kbd', { text: 'P' }), w('exit')),
      h('span.tonly', {}, bindText(h('b'), 'Drag'), w('orbit')), h('span.tonly', {}, bindText(h('b'), 'Pinch'), w('zoom')), phHide, phExit);
    photoTouch = { hiddenAt: -99, down: null, shows: 0 };
    muteEl = bindText(h('div.mute-ic'), 'SOUND OFF');
    // PAUSE + FULLSCREEN, top-left (touch: both; desktop: FULLSCREEN while the cursor is free — styles.css)
    const pauseBtn = bindText(h('button.tbtn.tbtn-pause', { type: 'button', tabindex: '-1' }, h('i.tb-bars')), 'Pause', null, 'aria-label');
    onTap(pauseBtn, () => pauseGame());
    fsHud = fsButton(fs, 'tbtn');
    tbtns = h('div.tbtns', {}, pauseBtn, fsHud);
    fly.el.prepend(world);
    try { levels = new LevelHud(fly, fly.el, { under: world, placer: placeLevelCard }); } catch (e) { levels = null; console.warn('[hud] level HUD failed', e); }
    hudEl.append(fly.el, edges.l, edges.r, edges.t, bannerEl, warnEl, toastsEl, promptEl, tipsEl, photoEl, muteEl, tbtns);
    hudEl.classList.toggle('fsa', !!fs.supported);
    root.append(hudEl, title.el, pause.el, results.el, ...Object.values(panels).map((p) => p.el));
    muteEl.classList.toggle('on', !!settings.muted);
    window.addEventListener('keydown', onKey);
    // no touch layer: the first real touch switches Auto to touch (a TV / monitor that also has a mouse)
    window.addEventListener('touchstart', () => {
      if (touchSeen) return;
      touchSeen = true;
      if (!game.touchUI) syncMode('touch');
    }, { passive: true, capture: true });
    // photo mode, touch: a tap (not a drag) anywhere brings the hidden bar back
    window.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse' && game.state === 'photo') photoTouch.down = { x: e.clientX, y: e.clientY, id: e.pointerId }; }, { passive: true, capture: true });
    window.addEventListener('pointerup', (e) => {
      const d = photoTouch.down;
      photoTouch.down = null;
      if (!d || d.id !== e.pointerId || game.state !== 'photo' || !photoEl.classList.contains('ph-off')) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 14 || nowReal() - photoTouch.hiddenAt < 0.3) return;
      photoEl.classList.remove('ph-off'); photoTouch.shows++;
    }, { passive: true, capture: true });
    // Titan fight: the pause screen and HUD need the same objective text
    setObjective('', '');
    syncMode('boot');
  }

  /**
   * The layout follows the touch mode and the HUD setting (cheap: runs every frame, writes only on a change). Classes:
   * .hud.touch (touch mode), .hud.min (Minimal HUD), .hud.ntu (a touch layer owns the buttons: the old ones step
   * aside), #ui.tm / #ui.hud-min, body.touch-mode (the touch layer's contract class, kept in step).
   */
  function syncMode(reason = 'frame') {
    if (!hudEl) return;
    const t = touchNow(), m = minimalHud(settings, t), ntu = !!game.touchUI;
    if (t === layout.touch && m === layout.minimal && ntu === layout.ntu) return;
    const was = layout.touch;
    layout.touch = t; layout.minimal = m; layout.ntu = ntu;
    touch = t; minimal = m;
    hudEl.classList.toggle('touch', t); hudEl.classList.toggle('min', m); hudEl.classList.toggle('ntu', ntu);
    root.classList.toggle('tm', t); root.classList.toggle('hud-min', m);
    try { document.body.classList.toggle('touch-mode', t); } catch { /* no body */ }
    if (dmg) dmg.enabled = numbersOn();
    // the old skill buttons are the touch controls only while there is no touch layer (never two sets on screen)
    if (t && !ntu && !legacyWired) wireTouch();
    // no keyboard tips in touch mode or the Minimal HUD
    if ((t || m) && tips?.active) tips.end();
    try { title?.setTouch(t); panels.controls?.refresh?.(kitNow(), t); panels.settings?.refresh?.(); pause?.refresh?.(pauseOpts()); } catch (e) { console.warn('[hud] menus', e); }
    keep.dirty = true; wordPanels.dirty = true; fly?.invalidateLayout?.();
    updateZoom();
    applyWorldScale();
    layout.flips++;
    layout.log.push({ t: +nowReal().toFixed(2), touch: t, minimal: m, ntu, reason, from: was });
    if (layout.log.length > 20) layout.log.shift();
  }
  /** Touch mode scales its UI with the screen: --z = min(w, h) / 1080 (1 at 1080p, 2 at 4K), never below 1; Settings
   *  "HUD size: Large (TV)" (settings.hudSize 'large', touch mode) ×1.3 for a TV read from the sofa. */
  function updateZoom() {
    const w = game.size?.w || innerWidth, H = game.size?.h || innerHeight;
    const large = touch && settings.hudSize === 'large' ? HUD_LARGE : 1;
    const z = Math.round(clamp(Math.min(w, H) / 1080, 1, 2.2) * large * 1000) / 1000;
    if (z === layout.z) return;
    layout.z = z;
    root?.style.setProperty('--z', String(z));
    keep.dirty = true;
    applyWorldScale();
  }
  /** The world HUD (reticle, markers, hit words, numbers, chevrons) grows with the touch UI: --z in touch mode, 1 with
   *  keyboard & mouse (the desktop stays as it was). CSS zooms the parts; the placement code gets the same factor. */
  function worldScale() { return touch ? layout.z || 1 : 1; }
  function applyWorldScale() {
    const S = worldScale();
    if (hitWords) { hitWords.scale = S; hitWords.fxBox = !!touch; }
    if (markers) { markers.scale = S; markers.minimal = !!minimal; }
    if (weak) { weak.scale = S; weak.minimal = !!minimal; }
    if (dmg) dmg.scale = S;
  }
  function pauseOpts() { return { touch, retry: typeof game.director?.restart === 'function', view: game.cameraRig?.viewMode }; }
  /** The run's numbers for the pause screen when the Minimal HUD keeps them off the flight view. */
  function pauseInfo() {
    const parts = [];
    const sv = surv?.el?.classList.contains('on') ? survVm : null;
    if (sv) parts.push(tr('SURVIVAL WAVE {n}', { n: Math.max(1, Math.round(sv.wave || 0)) }), clock(sv.time), tr('SCORE {n}', { n: fmt(Math.round(sv.score || 0)) }));
    else if (vm.wave) parts.push(vm.wave.label || vm.wave.title, vm.wave.cleared ? tr('CLEARED') : trn(vm.wave.left, '{n} LEFT', '{n} LEFT'));
    if (vm.boss) parts.push(tr('TITAN {n} %', { n: Math.round(100 * vm.boss.hp / Math.max(1, vm.boss.maxHp)) }));
    const c = readCombo();
    if (!sv && c.kills > 0) parts.push(tr('{n} DOWNED', { n: c.kills }));
    return parts.join('  ·  ');
  }
  /** The touch layer's buttons (game.touchUI.buttons: elements, { el }, arrays or maps of them) and a small stick base. */
  function touchEls() {
    const T = game.touchUI, out = [];
    if (!T || typeof Element === 'undefined') return out;
    const take = (x) => { if (x instanceof Element) out.push(x); else if (x?.el instanceof Element) out.push(x.el); };
    const B = T.buttons;
    if (Array.isArray(B)) B.forEach(take); else if (B && typeof B === 'object') Object.values(B).forEach(take);
    take(T.stick?.base ?? T.stick?.el ?? null);
    return out;
  }
  /** keep.hard / keep.edge (see above), re-measured at most once a second, on resize and when the layout changed. */
  function keepOuts(tNow) {
    const K = keep, w = innerWidth, H = innerHeight;
    if (!K.dirty && tNow - K.at < 1 && tNow >= K.at && K.w === w && K.h === H) return K;
    K.dirty = false; K.at = tNow; K.w = w; K.h = H;
    const edge = [];
    const add = (el, pad = 8) => {
      if (!el || el.hidden) return;
      const r = el.getBoundingClientRect?.();
      // (a whole-screen zone — the stick's — is no keep-out)
      if (r && r.width > 0 && r.height > 0 && r.width * r.height < w * H * 0.2) edge.push([r.left - pad, r.top - pad, r.right + pad, r.bottom + pad]);
    };
    // (the top-right panel: 12 px of air — a crit word's balloon still grows as it fades)
    if (minimal || touch) add(fly?.pl, 12);
    if (touch) {
      // (the PAUSE / FULLSCREEN pair is a keep-out in touch mode only: the desktop's FULLSCREEN button is invisible in
      // flight — pointer lock — so the desktop's arrows and chevrons stay exactly where they were)
      for (const b of tbtns?.children || []) add(b, 6);
      for (const e of touchEls()) add(e, 10);
      // the stick's idle ring (game.touchUI.layout.stick = { cx, cy, r }: CSS px)
      const S = game.touchUI?.layout?.stick;
      if (S && Number.isFinite(S.cx) && Number.isFinite(S.cy) && S.r > 0 && S.r < Math.min(w, H) * 0.3) edge.push([S.cx - S.r - 6, S.cy - S.r - 6, S.cx + S.r + 6, S.cy + S.r + 6]);
    }
    K.edge = edge;
    K.hard = (fly?.readoutRects(tNow) || []).concat(edge);
    // (the markers: the off-screen arrows slide past these; an on-screen plate / weak point whose box would lie on a
    // control or the panel steps out of sight until it is clear — nothing overlaps the controls)
    if (markers) markers.avoid = edge;
    if (weak) weak.avoid = edge;
    return K;
  }

  /** The old on-screen skill buttons (only while there is no touch layer: game.touchUI owns the buttons otherwise). */
  function wireTouch() {
    legacyWired = true;
    const map = { breath: 'Mouse0', fireball: 'KeyF', boost: 'ShiftLeft', power: 'Space' };
    for (const [id, code] of Object.entries(map)) {
      const b = fly.sk[id].el;
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        game.input?.press(code); b.classList.add('pressed');
        // a very quick tap can end before capture is possible (InvalidStateError): the press above still counts
        try { b.setPointerCapture?.(e.pointerId); } catch { /* pointer already gone */ }
      });
      const up = () => { game.input?.release(code); b.classList.remove('pressed'); };
      b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('lostpointercapture', up);
    }
    const d = fly.sk.dodge.el;
    let dcode = 'KeyQ';
    d.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const r = d.getBoundingClientRect();
      dcode = e.clientX < r.left + r.width / 2 ? 'KeyQ' : 'KeyE';
      game.input?.press(dcode);
      setTimeout(() => game.input?.release(dcode), 90);
    });
  }

  // ------------------------------------------------------------------------------------------------ state
  function showScreen(name) {
    title.el.classList.toggle('on', name === 'title');
    pause.el.classList.toggle('on', name === 'paused');
    results.el.classList.toggle('on', name === 'results');
    hudEl.classList.toggle('on', name === 'hud' || name === 'paused' || name === 'photo');
    hudEl.classList.toggle('paused', name === 'paused');
  }

  function onState({ prev, next, results: res }) {
    stateChangedAt = nowReal();
    if (res) runResults = res;
    if (next === 'play' && prev !== 'paused' && prev !== 'photo') runResults = null;
    if (!root) return;
    clearTimeout(resultsTimer); clearTimeout(fallbackTimer);
    if (next !== 'paused') closeAllPanels();
    photoEl.classList.toggle('on', next === 'photo');
    if (next === 'photo') photoEl.classList.remove('ph-off');
    hudEl.classList.toggle('photo-mode', next === 'photo');
    if (next === 'title') {
      showScreen('title');
      setScreenNav(title.nav);
      survRun.active = false;
      try { title.setBest(readSurvivalBest()); } catch (e) { console.warn('[hud] survival best', e); }
      tips?.end();
      clearTimeout(titleLiveTimer); stopVeil();
      if (titleSeen && liveAvailable()) title.el.classList.add('live');      // back from a flight: the live world stays
      else {
        title.el.classList.remove('live');
        titleLiveTimer = setTimeout(() => { if (game.state === 'title' && liveAvailable()) goLive(); }, 2600);
      }
      titleSeen = true;
      setObjective('', '');
      if (autostart === null) {
        autostart = takeSessionFlag('autostart') || '';
        if (autostart) setTimeout(() => { if (game.state === 'title') start(autostart); }, 50);
      }
    } else if (next === 'play') {
      showScreen('hud');
      navStack.length = 0;
      if (prev === 'title' || prev === 'victory' || prev === 'defeat' || prev === 'loading') {
        resetStats();
        if (!touch && !minimal) tips?.begin(prev === 'title' || prev === 'loading');
      }
    } else if (next === 'paused') {
      showScreen('paused');
      pause.setObjective(touch ? touchText(objective.text) : objective.text);
      // the Minimal HUD keeps the wave / score off the flight view: the pause screen has them
      try { pause.setInfo(minimal ? pauseInfo() : ''); pause.refresh(pauseOpts()); } catch (e) { console.warn('[hud] pause info', e); }
      setScreenNav(pause.nav);
    } else if (next === 'photo') {
      showScreen('photo');
    } else if (next === 'victory' || next === 'defeat') {
      showScreen('hud');
      try { levelEnd = levelSummary(readProgress(game.progress)); } catch { levelEnd = null; }
      try { game.input?.exitLock?.(); } catch { /* optional */ }
      resultsTimer = setTimeout(() => {
        if (game.state !== next) return;
        try { game.input?.exitLock?.(); } catch { /* optional */ }
        bannerEl.getAnimations().forEach((a) => a.cancel());
        results.show(next === 'victory', resultsView(next === 'victory'));
        try { results.setOnline(onlineUi ? onlineUi.resultsText(game.online?.last, runResults) : {}); } catch { /* no line */ }
        showScreen('results');
        setScreenNav(results.nav);
      }, 1800);
    }
  }
  /**
   * The results screen's numbers. The director (wave 4) hands over the whole run: totals over every attempt, a rank
   * from performance (grade + rating + ratingParts), retryLabel ("Retry — Wave 3"), reachedLabel, attempts and the
   * last attempt. Older directors / the sandbox: the HUD's own rank (rank.js), labels and totals fill in.
   */
  function resultsView(win, again = false) {
    // (again: the same results in another language — a language switch while they are up: nothing is counted twice)
    const r = runResults || {};
    const d = game.director;
    const sv = survivalResults(r, again);
    if (sv) return sv;
    const time = r.time ?? stats.time, damage = r.damageDealt ?? stats.damage, downed = r.kills ?? stats.downed;
    const score = typeof r.score === 'number' ? r.score : null;
    let grade = r.grade, rankNext = '', parts = null;
    if (typeof r.rating === 'number' && r.ratingParts) {
      const P = r.ratingParts;
      parts = [[win ? 'Pace' : 'Progress', P.pace], ['Survival', P.survival], ['Offense', P.offense], ['Kills', P.kills]]
        .filter(([, v]) => typeof v === 'number');
      rankNext = win ? keepSegments(tr('Rating {n} / 100', { n: Math.round(r.rating * 100) }), P.retries ? trn(P.retries, '{n} retry count against it', '{n} retries count against it') : '') : DEFEAT_CAP;
    } else if (score !== null) {
      const pa = pActor();
      const hpLeft = typeof r.hpLeft === 'number' ? r.hpLeft : pa ? Math.round(100 * Math.max(0, pa.hp) / (pa.maxHp || 1)) : 0;
      const rk = rankRun({ outcome: win ? 'victory' : 'defeat', score, time, hpLeft }, { mode: lastStart });
      grade = rk.grade; rankNext = rk.next;
    }
    // where Retry restarts
    let retryTo = '', retryText = '';
    if (typeof r.retryLabel === 'string' && r.retryLabel) retryText = r.retryLabel;
    else if (d?.restart) {
      const from = lastStart === 'titan' ? 'titan-rise' : (r.checkpoint || d?.checkpoint || 'intro');
      retryTo = PHASE_LABEL[from] || '';
    }
    // this run over all attempts: the director's totals when it keeps them, else the HUD's own
    let run = null;
    if (typeof r.attempts === 'number') {
      const A = r.attempt || {};
      run = { attempts: r.attempts, last: { time: A.time ?? null, downed: A.kills ?? null, damage: A.damageDealt ?? null } };
    } else if (again) run = { attempts: runTotals.attempts, totals: { ...runTotals } };
    else {
      runTotals.attempts++;
      runTotals.time += Math.max(0, time || 0); runTotals.downed += downed || 0; runTotals.damage += damage || 0;
      runTotals.bestScore = Math.max(runTotals.bestScore, score || 0);
      run = { attempts: runTotals.attempts, totals: { ...runTotals } };
    }
    return {
      time, damage, downed, shots: stats.shots, hits: stats.hits, grade, score, combo: r.bestCombo ?? stats.bestCombo,
      rankNext, parts, retryTo, retryText, run, level: resultsLevel(r),
      reached: win ? '' : r.reachedLabel || reachedLabel(r.reached || d?.stats?.reached, d?.waves),
    };
  }
  /** The survival variant of the results (null for the story): the director's results / 'survival:end' payload /
   *  director.survival, in that order, and the best from before the run for "NEW BEST". */
  function survivalResults(r, again = false) {
    const d = game.director;
    const S = r.survival && typeof r.survival === 'object' ? r.survival : null;
    const isSurv = r.mode === 'survival' || !!S || (survRun.active && (lastStart === 'survival' || d?.phase === 'survival' || !!d?.survival)) || (again && survRun.shownSurv);
    if (!again) survRun.shownSurv = isSurv;
    if (!isSurv) return null;
    const E = survRun.end || {}, L = survRun.last || {}, D = d?.survival || {};
    const pick = (k, ...alt) => { for (const o of [S, E, r, D, L]) { if (!o) continue; for (const key of [k, ...alt]) if (typeof o[key] === 'number' && Number.isFinite(o[key])) return o[key]; } return 0; };
    const wave = pick('wave', 'waves'), time = pick('time', 'survived'), kills = pick('kills'), score = pick('score');
    const prev = survRun.prevBest;
    const run = { wave, time, score };
    const best = mergeBest(prev, run);
    // newBest: a boolean, or the director's per-field record { score, time, wave, kills, first } (the very first run is
    // not called a new best: there was nothing to beat)
    const flag = S?.newBest ?? E.newBest ?? r.newBest;
    const fields = flag && typeof flag === 'object' ? flag : null;
    const newBest = fields ? !!fields.score && !fields.first : typeof flag === 'boolean' ? flag : score > 0 && !!prev && score > (prev.score || 0);
    const newFields = fields && !fields.first ? ['score', 'time', 'wave'].filter((k) => fields[k]) : [];
    const src = S || r;
    const parts = [['Kills', src.killScore], ['Time', src.timeScore], ['Clears', src.bonus]].filter(([, v]) => typeof v === 'number' && v > 0);
    if (!again) saveSurvivalBest(run);
    survRun.active = false;
    return {
      survival: { wave, time, kills, score, best: mergeBest(best, r.best, S?.best), newBest, newFields, parts, grade: typeof r.grade === 'string' ? r.grade : '' },
      time, damage: r.damageDealt ?? stats.damage, downed: kills, shots: stats.shots, hits: stats.hits, level: resultsLevel(r),
      // (the survival run's own label in any language — the English test for "surviv" never matched a Russian one)
      retryText: r.mode === 'survival' && typeof r.retryLabel === 'string' && r.retryLabel ? r.retryLabel : '',
    };
  }
  /** The level and element reached: the director's results (level / progress) when it hands them over, else the
   *  progression read when the run ended (null without a progression). */
  function resultsLevel(r) {
    try {
      const P = r?.progress && typeof r.progress === 'object' ? r.progress : null;
      const lv = +(r?.levelPeak ?? r?.level ?? P?.peak ?? P?.level);
      if (Number.isFinite(lv) && lv >= 1) {
        const v = readProgress({ level: lv, element: r.element ?? P?.element, xp: +(r.xp ?? P?.xp) || 0 });
        // the director's fields carry no xpNext: max = the top level only
        if (v) { v.max = v.level >= (game.progress?.maxLevel || 15); return levelSummary(v); }
      }
      return levelEnd || levelSummary(readProgress(game.progress));
    } catch { return levelEnd; }
  }
  /**
   * Key art → live render through a sunlit cloud: the veil covers the screen, the pictures swap under it, the veil
   * clears. The two pictures are never blended (the old 2.4 s cross-fade was a double exposure). The swap waits for
   * the veil's own animation to finish (not a timer): a slow first live frame delays the animation, never the order.
   */
  function goLive() {
    const el = title.el, veil = el.querySelector('.t-veil');
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    stopVeil();
    if (reduce || !veil?.animate) { el.classList.add('live'); return; }
    const a = veil.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 520, easing: 'ease-in', fill: 'forwards' });
    veilAnim = a;
    a.onfinish = () => {
      if (veilAnim !== a) return;
      if (game.state === 'title') el.classList.add('live');
      // two frames under the full veil so the live picture is up before it clears
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (veilAnim !== a) return;
        const b = veil.animate([{ opacity: 1 }, { opacity: 0.92, offset: 0.12 }, { opacity: 0 }], { duration: 1150, easing: 'ease-out', fill: 'forwards' });
        veilAnim = b;
        b.onfinish = () => { if (veilAnim === b) stopVeil(); };
      }));
    };
  }
  function stopVeil() {
    veilAnim = null;
    try { title?.el.querySelector('.t-veil')?.getAnimations().forEach((x) => x.cancel()); } catch { /* old browser */ }
  }
  // The live render replaces the key art only when the world is complete enough to be the better picture
  // (dragon + terrain + clouds + the render pipeline). ?title=live | art forces either.
  function liveAvailable() {
    const force = game.params?.get?.('title');
    if (force === 'live') return true;
    if (force === 'art') return false;
    return !!game.player && !!game.terrain && !!game.clouds && !!game.pipeline;
  }

  function resetStats() {
    Object.assign(stats, { time: 0, damage: 0, downed: 0, shots: 0, hits: 0, bestCombo: 0 });
    Object.assign(combo, { count: 0, kills: 0, until: -99 });
    waveState = { key: '', left: -1, clearedUntil: -99 };
    waveFlash = null;
    breathWin = { t: 0, hit: false };
    shots.length = 0; fireAgg.clear(); roll?.clear();
    hitWords?.clear();
    levels?.reset(); levelRect = null;
  }

  // ------------------------------------------------------------------------------------------------ events
  function onDamage(rec = {}) {
    if (!root) return;
    const tNow = nowReal();
    if (isPlayer(rec.target)) {
      const max = rec.target.maxHp || 100;
      if (rec.kind === 'fire') {
        playerFireAgg.sum += rec.amount;
        if (tNow - playerFireAgg.t > 0.35) { flyHit(rec, playerFireAgg.sum / max); playerFireAgg = { sum: 0, t: tNow }; }
      } else flyHit(rec, rec.amount / max);
      return;
    }
    if (!isPlayer(rec.source)) return;
    stats.damage += rec.amount;
    markers?.noteDamage(rec.target, game.time.now);
    hitWords?.onDamage(rec);
    const pos = rec.point || rec.target?.pos;
    const crit = (rec.shape?.mult ?? 1) >= 1.5;
    if (rec.chain > 0 && roll) {
      // a chain jump (lightning): one CHAIN ×N word per chain, no number of its own (critics #7)
      if (rec.kind === 'fire') breathWin.hit = true;
      else if (rec.kind === 'fireball' && game.time.now - lastFbHit > 0.06) { stats.hits++; lastFbHit = game.time.now; }
      if (pos) { try { roll.chainJump(rec, pos, tNow, game.time.now); } catch (e) { rollWarn(e); } }
    } else if (rollsNumber(rec) && roll) {
      // a lightning / storm breath tick: into the target's one growing number
      breathWin.hit = true;
      if (pos) { try { roll.add(rec.target, pos, rec.amount, crit, tNow); } catch (e) { rollWarn(e); } }
    } else if (rec.kind === 'fire') {
      breathWin.hit = true;
      let a = fireAgg.get(rec.target);
      if (!a) { a = { sum: 0, pos: new THREE.Vector3(), t: tNow - 0.2, crit: false }; fireAgg.set(rec.target, a); }
      a.sum += rec.amount; if (pos) a.pos.copy(pos); a.crit = a.crit || crit;
    } else {
      if (rec.kind === 'fireball' && game.time.now - lastFbHit > 0.06) { stats.hits++; lastFbHit = game.time.now; }
      if (rec.target?.kind === 'titan' || pos) { dmg?.spawn(pos, String(Math.max(1, Math.round(rec.amount))), crit ? 'crit' : ''); if (crit) markWorded(rec.target); }
    }
    // the small reticle hitx: never for an afterburn tick (not a new hit — the player may be aiming at empty sky);
    // on an enemy dragon the hit words' burst is the one marker (the titan and words-off keep the hitx)
    if (!isAfterburn(rec) && !(hitWords?.enabled && isEnemyDragon(rec.target))) fly?.hitMarker(!!rec.killed);
  }
  /** The damage number just spawned on a dragon the hit words confirm: its CRITICAL is said by the word (no " CRIT"). */
  function markWorded(target) {
    if (!hitWords?.enabled || !isEnemyDragon(target) || !dmg?.enabled || !dmg.pool?.length) return;
    const d = dmg.pool[(dmg.next - 1 + dmg.pool.length) % dmg.pool.length];
    d?.el.classList.add('dn-hw');
  }
  /** hitWords.update's panels (avoided unless nothing else is free): the objective and the kill feed. */
  function wordPanelRects(tNow) {
    const P = wordPanels;
    if (P.dirty || tNow - P.at > 1 || tNow < P.at || P.w !== innerWidth || P.h !== innerHeight) {
      P.dirty = false; P.at = tNow; P.w = innerWidth; P.h = innerHeight;
      P.rects.length = 0;
      for (const e of [fly?.objective, toastsEl, surv?.el?.classList.contains('on') ? surv.el : null, document.getElementById('watermark')]) {
        const r = e?.getBoundingClientRect?.();
        if (r && r.width > 0 && r.height > 0) P.rects.push([r.left - 6, r.top - 6, r.right + 6, r.bottom + 6]);
      }
    }
    return P.rects;
  }
  /**
   * The hit-direction wedge's reach (px from the screen centre) for a hit from `ang` (rad, 0 = ahead / up, clockwise):
   * as far out as styles.css puts it, but short enough that its arc (styles.css .hitdir i: 60 px tall, min(260 px,
   * 40vh) wide, rotated about the centre) stays off every control and the panel (keep.edge; a 4:3 screen has the
   * button arc ~170 px right of the centre). null = the CSS default (the desktop Full HUD, nothing to keep off). Per
   * hit (event-driven), arithmetic only.
   */
  function hitReach(ang) {
    const E = keep.edge;
    if (!E?.length || !(touch || minimal)) return null;
    const w = innerWidth, H = innerHeight, cx = w / 2, cy = H / 2;
    const R0 = Math.min(0.38 * H, 300, H / 2 - 112), W2 = Math.min(260, 0.4 * H) / 2;
    const c = Math.cos(ang), s = Math.sin(ang);
    // (the wedge's whole box, sampled 9 × 3 like its outline: the arc runs from its bottom corners up to the top middle)
    const hits = (R) => {
      for (let i = 0; i <= 8; i++) for (let j = 0; j <= 2; j++) {
        const px = -W2 + (2 * W2 * i) / 8, py = -R + 30 * j;
        if (inRects(E, cx + px * c - py * s, cy + px * s + py * c, 6)) return true;
      }
      return false;
    };
    const Rmin = Math.max(70, 0.3 * R0);
    for (let R = R0; R > Rmin; R -= Math.max(6, R0 * 0.06)) if (!hits(R)) return R === R0 ? null : Math.round(R);
    return Math.round(Rmin);
  }
  function flyHit(rec, strength) {
    let ang = null;
    const src = rec.source?.pos || (rec.dir ? _d.copy(rec.target.pos).addScaledVector(rec.dir, -50) : null);
    if (src) {
      _p.copy(src).applyMatrix4(game.camera.matrixWorldInverse);
      ang = Math.atan2(_p.x, -_p.z);
    }
    fly.flashDamage(clamp(strength * 3, 0.1, 1), ang, ang !== null ? hitReach(ang) : null);
    if (ang !== null && Math.abs(ang) > 2) tips?.trigger('behind');          // hit from behind: teach the arrows / look-back
    const pa = pActor();
    if (pa?.pos && strength * (pa.maxHp || 100) >= 4) dmg?.spawn(_q.copy(pa.pos).setY(pa.pos.y + 3), `-${Math.round(strength * (pa.maxHp || 100))}`, 'player');
  }
  function onDeath({ actor, killer } = {}) {
    if (!actor || !root) return;
    if (isPlayer(actor)) {
      if (!game.director?.finish) fallbackTimer = setTimeout(() => { if (game.state === 'play') game.setState('defeat'); }, 4500);
      return;
    }
    if (actor.team !== 'enemy') return;
    if (actor.kind === 'titan') return;
    if (!killer || isPlayer(killer)) {
      stats.downed++;
      const now = game.time.now;
      combo.count = now < combo.until ? combo.count + 1 : 1;
      combo.until = now + COMBO_WINDOW;
      combo.kills++;
      readCombo();
      stats.bestCombo = Math.max(stats.bestCombo, comboView.count);
    }
    // (the name stays English on the actor — the drake test reads it; the feed shows its tr())
    const en = String(actor.name || 'Shade Rider');
    const nm = tr(en).toUpperCase();
    const drake = /drake|wyvern/i.test(en);
    // many enemies: drakes fall in bunches — one feed line per kill would flood it, so drakes merge into one line
    if (drake && lastDrakeToast && nowReal() - lastDrakeToast.t < 2.5 && lastDrakeToast.el.isConnected) {
      lastDrakeToast.n++; lastDrakeToast.t = nowReal();
      lastDrakeToast.el.lastChild.textContent = ' ' + tr('×{n} — DOWNED', { n: lastDrakeToast.n });
      if (lastDrakeToast.el._kill) lastDrakeToast.el._kill.n = lastDrakeToast.n;
    } else {
      // (Russian: a drake — (other language) — is feminine: "— (other language)"; the English line is "— DOWNED" for every kind, as before)
      const el = toast({ name: nm, rest: killRest(drake) }, 'kill');
      if (el) el._kill = { en, drake, n: 1 };
      lastDrakeToast = drake && el ? { el, n: 1, t: nowReal() } : null;
    }
    // the player's kills of enemy dragons get a hit word ("SHOT DOWN!" + "DOUBLE!"…); other deaths keep the number
    const worded = !!hitWords?.onDeath(actor, killer, isPlayer(killer));
    // its XP (the progression gained it a moment ago in this same 'death' dispatch): "+25 XP" under the kill word, or
    // a number at a kill the words do not show (an assist: a burning dragon that crashed)
    const xp = claimXp();
    if (xp > 0) xpToKill(actor, xp, worded);
    lastKill = { actor, worded, sim: game.time.now, real: nowReal(), claimed: xp > 0 };
    if (!worded && comboView.count >= 2 && isPlayer(killer) && actor.pos) dmg?.spawn(_q.copy(actor.pos).setY(actor.pos.y + 11), tr('×{n} COMBO', { n: comboView.count }), 'combo');
    // (DOWN! is the drake's word — Russian "(other language)!", (other language); a rider there says "(other language)!". English: DOWN! for all, as before)
    if (!worded && actor.pos) dmg?.spawn(_q.copy(actor.pos).setY(actor.pos.y + 6), drake || lang() === 'en' ? tr('DOWN!') : tr('SHOT DOWN!'), 'kill');
    if (isPlayer(killer) && !worded) fly?.hitMarker(true);
  }
  // ------------------------------------------------------------------------------------------------ levels
  /** The actor an 'xp' event is for: source (an actor, a pilot, a damage record), actor, target, victim. */
  function xpTarget(e) {
    const src = e?.source;
    for (const c of [src, src?.actor, src?.target, e?.actor, e?.target, e?.victim]) if (c && typeof c === 'object' && (c.kind === 'dragon' || c.kind === 'titan') && c.team) return c;
    return null;
  }
  /**
   * 'xp' { amount, total, source }: a kill's XP goes under its kill word ("+25 XP"); titan damage XP only moves the bar
   * (no floaters); the titan's kill and kills the words do not show (words off) get a small number at the actor.
   */
  function onXp(e = {}) {
    if (!root) return;
    const amount = +e.amount || 0;
    if (!(amount > 0)) return;
    xpStats.events++; xpStats.total += amount;
    const a = xpTarget(e);
    const kind = String(typeof e.source === 'string' ? e.source : e.kind || e.reason || e.source?.kind || '');
    const titan = a?.kind === 'titan' || (!a && /titan/i.test(kind));
    xpStats.last = { amount, kind, actor: a?.name || null, t: +game.time.now.toFixed(2) };
    tips?.trigger('level');
    if (titan) {
      xpStats.titan++;
      // the titan's kill (hundreds of XP at once): a number at the titan; its damage XP (1 per 20 damage) says nothing
      const T = a || titanActor();
      if ((amount >= 100 || /kill/.test(kind)) && T?.pos) { dmg?.spawn(_q.copy(T.pos).setY(T.pos.y + 40), tr('+{n} XP', { n: Math.round(amount) }), 'xp'); xpStats.numbers++; }
      return;
    }
    if (a && a.team !== 'enemy') return;
    if (!a) {
      // no actor named: the kill being dispatched right now claims it (onDeath below); else only the bar moves
      xpStats.loose++;
      const t = nowReal();
      const K = lastKill;
      if (K && !K.claimed && Math.abs(K.sim - game.time.now) < 1e-6 && t - K.real < 0.1) { K.claimed = true; xpToKill(K.actor, amount, K.worded); return; }
      while (xpLoose.length && t - xpLoose[0].real > 0.5) { xpLoose.shift(); xpStats.unclaimed++; }
      xpLoose.push({ amount, sim: game.time.now, real: t });
      return;
    }
    xpStats.kills++;
    xpToKill(a, amount, !!hitWords?.enabled && isEnemyDragon(a));
  }
  /** A kill's XP: under its kill word, or (the words off, a kill the words do not show) a small number at it. */
  function xpToKill(a, amount, worded) {
    if (worded && hitWords?.onXp(a, amount)) { xpStats.worded++; return; }
    if (a?.pos) { dmg?.spawn(_q.copy(a.pos).setY(a.pos.y + 9), tr('+{n} XP', { n: Math.round(amount) }), 'xp'); xpStats.numbers++; }
  }
  /** The loose XP of this very dispatch (same simulation step, ≤ 0.1 s), summed and removed. */
  function claimXp() {
    const t = nowReal(), sim = game.time.now;
    let sum = 0;
    for (let i = xpLoose.length - 1; i >= 0; i--) {
      const x = xpLoose[i];
      if (Math.abs(x.sim - sim) < 1e-6 && t - x.real < 0.1) { sum += x.amount; xpLoose.splice(i, 1); }
    }
    return sum;
  }
  function onLevelUp(e = {}) {
    if (!root) return;
    levels?.onLevelUp(e);
    tips?.trigger('level');
  }

  function onFireball({ projectile, owner } = {}) {
    if (isPlayer(owner)) { stats.shots++; hitWords?.onShot(projectile); return; }
    if (projectile && shots.length < 40) shots.push(projectile);
  }
  function onTelegraph(e = {}) {
    if (!root) return;
    const a = String(e.attack || '');
    let text = e.text, level = e.level;
    if (!text) {
      const m = TELEGRAPH_TEXT.find(([re]) => re.test(a));
      text = m ? m[1]() : tr('{attack} — EVADE!', { attack: a.toUpperCase() || tr('TITAN ATTACK') });
      level = level ?? (m ? m[2] : 1);
    }
    // short-lived: until just after the attack lands (the telegraph's own duration + 0.3 s)
    const dur = clamp((e.duration ?? 1.2) + 0.3, 1.2, 2.8);
    const t = titanActor();
    const handPart = /L|left/i.test(String(e.hand || '')) ? 'handL' : /R|right/i.test(String(e.hand || '')) ? 'handR' : null;
    const shapeOf = () => (handPart && t?.shapes?.find((x) => x.part === handPart)) || null;
    // where it comes from, followed every frame: the attacking hand, else the titan's body
    const src = () => { const sh = shapeOf(); return sh?.a || (t?.alive !== false ? t?.pos : null) || null; };
    showWarning(text, level ?? 1, { duration: dur, src: t ? src : null });
    tips?.trigger('dodge');
    // and light the matching screen edge
    const p0 = src();
    if (p0 && game.camera) {
      project(game.camera, p0, game.size?.w || innerWidth, game.size?.h || innerHeight, pr);
      const w = game.size?.w || innerWidth;
      let side = pr.cx < 0 ? 'l' : 'r';
      if (pr.onScreen) side = pr.y < (game.size?.h || innerHeight) * 0.15 ? 't' : pr.x < w / 2 ? 'l' : 'r';
      else if (pr.cy > Math.abs(pr.cx)) side = 't';
      if (level >= 2 || /swat|grab|clap|slam|chop/i.test(a)) edge(side, dur - 0.3);
    }
  }
  /** The titan's weak points in words, from its own numbers: config.weak = { hand, core, open: { mult } } (a hand is
   *  ×hand from its windup through the strike, the core ×core, ×core·open.mult while it blazes open) and
   *  config.partMult.head. '' when the titan does not expose them (the fallback text above is used). Segments keep
   *  their words together (the line may only break at " · ": the objective is narrow beside the boss bar). */
  function weakText(phase) {
    const C = game.titan?.config, W = C?.weak;
    if (!/^titan(?!-rise)/.test(phase) || !W || typeof W.core !== 'number') return '';
    // (Russian writes the decimal comma: ×2,5)
    const f = (x) => { const v = `×${+Number(x).toFixed(1)}`; return lang() === 'ru' ? v.replace('.', ',') : v; };
    const open = typeof W.open?.mult === 'number' && W.open.mult > 1 ? W.core * W.open.mult : null;
    if (phase === 'titan-enraged') return open ? keepSegments(tr('Dodge the volleys'), tr('the open core takes {x}', { x: f(open) })) : '';
    const head = typeof C.partMult?.head === 'number' && C.partMult.head > 1 ? C.partMult.head : null;
    const hand = typeof W.hand === 'number' && W.hand > 1 ? W.hand : null;
    const segs = [open ? tr('Core {x}, {open} when open', { x: f(W.core), open: f(open) }) : tr('Core {x}', { x: f(W.core) })];
    if (head && hand && head === hand) segs.push(tr('head and striking hand {x}', { x: f(hand) }));
    else { if (head) segs.push(tr('head {x}', { x: f(head) })); if (hand) segs.push(tr('striking hand {x}', { x: f(hand) })); }
    return keepSegments(...segs);
  }
  function onPhase({ phase, prev } = {}) {
    if (!root) return;
    const at = nowReal();
    if (phase === 'survival') { lastStart = 'survival'; if (!survRun.active || prev !== 'survival') beginSurvival(); }
    // Director-provided text wins; our defaults fill in only if nothing was set around the phase change.
    setTimeout(() => {
      if (lastObjectiveCall < at - 0.5 && PHASE_OBJECTIVE[phase]) { hudObjective(phase); lastObjectiveCall = -99; }
      const b = PHASE_BANNER[phase];
      if (b && lastBannerAt < at - 0.5) {
        // the titan's name card waits for a quiet moment: never on top of its first telegraph (up to 6 s later)
        if (phase === 'titan') {
          let retried = false;
          const tryCard = (n) => {
            if (lastBannerAt >= at || (game.director && game.director.phase !== 'titan')) return;
            // quiet = no pill on screen: by the clock and by the pill's own animation (which starts a frame late
            // and can outlast the clock when frames are slow)
            const pillUp = nowReal() < warnState.until + 0.2 || !!warnPill?.getAnimations?.().some((x) => x.playState === 'running');
            // no quiet moment within 6 s: no card (never on top of a warning; the boss bar carries the name)
            if (pillUp) { if (n < 24) setTimeout(() => tryCard(n + 1), 250); return; }
            banner(tr(b[0]), tr(b[1]), { duration: 3.2 });
            nameCardRetry = retried ? null : () => { retried = true; lastBannerAt = at - 1; tryCard(0); };
            setTimeout(() => { if (!retried) nameCardRetry = null; }, 2000);   // cut late: it was read, no rerun
          };
          setTimeout(() => tryCard(0), 300);
        } else banner(tr(b[0]), tr(b[1]));
      }
      if (phase === 'titan-enraged') showWarning(tr('{name} IS ENRAGED', { name: tr(BOSS_NAME) }), 2, { duration: 2.4 });
    }, 150);
    // Without a director that finishes the run itself, end it here.
    if (!game.director?.finish && phase === 'victory') fallbackTimer = setTimeout(() => { if (game.state === 'play') game.setState('victory'); }, 7000);
    if (!game.director?.finish && phase === 'defeat') fallbackTimer = setTimeout(() => { if (game.state === 'play') game.setState('defeat'); }, 5000);
  }

  // ------------------------------------------------------------------------------------------------ per-frame view-model
  const vm = { player: false, hp: 0, maxHp: 1, stamina: 1, heat: 0, overheated: false, speedKmh: 0, altitude: 0, vs: 0, boosting: false,
    breathing: false, inRange: false, hover: 0, ret: { x: 0, y: 0, visible: false }, aim: { x: 0, y: 0, visible: false },
    retEdge: { x: 0, y: 0, rot: 0, visible: false },
    fireball: { ready: true, frac: 1, secs: 0, charges: 1, maxCharges: 1 }, boss: null,
    wave: null, waveVm: { title: '', left: 0, cleared: false, total: 0, progress: 0 }, escorts: 0,
    combo: { count: 0, kills: 0, frac: 0 } };
  const bossVm = { hp: 0, maxHp: 1, ticks: [0.7, 0.35], phaseLabel: '', enraged: false, escorts: 0 };
  const markerList = [];
  const pilotMap = new Map(), flockPool = [];
  const _fwd = new THREE.Vector3(), _mouth = new THREE.Vector3(), _aim = new THREE.Vector3();

  /** dragon.fireball = { ready, cooldown, cooldownMax, charges, maxCharges } (player-flight owner); older fallbacks. */
  function readFireball(p) {
    const o = vm.fireball;
    const fb = p.fireball ?? p.weapons?.fireball ?? null;
    if (fb && typeof fb === 'object') {
      const max = Math.max(0.1, num(fb.cooldownMax ?? fb.maxCooldown ?? fb.recharge, 4));
      const cd = Math.max(0, num(fb.cooldown ?? fb.cd, 0));
      const hasCharges = typeof fb.charges === 'number';
      o.maxCharges = Math.max(1, Math.round(num(fb.maxCharges, hasCharges ? Math.max(1, fb.charges) : 1)));
      o.charges = hasCharges ? clamp(Math.round(fb.charges), 0, o.maxCharges) : (fb.ready ?? cd <= 0.001) ? 1 : 0;
      o.ready = typeof fb.ready === 'boolean' ? fb.ready : hasCharges ? o.charges > 0 : cd <= 0.001;
      o.secs = cd;
      o.frac = cd > 0 ? clamp(1 - cd / max, 0, 1) : (typeof fb.charge === 'number' ? clamp(fb.charge, 0, 1) : 1);
      if (!o.ready && cd <= 0 && typeof fb.charge !== 'number') o.frac = 0;
      return o;
    }
    const cd = p.fireballCooldown ?? p.cooldowns?.fireball ?? null;
    const max = p.fireballCooldownMax ?? p.fireballRecharge ?? 4;
    o.maxCharges = 1; o.charges = 1;
    if (typeof p.fireballCharge === 'number' && cd === null) { o.frac = clamp(p.fireballCharge, 0, 1); o.ready = o.frac >= 1; o.secs = 0; }
    else if (typeof cd === 'number') { o.secs = Math.max(0, cd); o.frac = clamp(1 - o.secs / Math.max(0.1, max), 0, 1); o.ready = o.secs <= 0.001; }
    else { o.ready = true; o.frac = 1; o.secs = 0; }
    if (!o.ready) o.charges = 0;
    return o;
  }
  const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

  /** "WAVE 2/3" in the current language (cached: the wave strip asks every frame). */
  const waveLbl = { n: -1, of: -1, L: '', s: '' };
  function waveLabel(n, of) {
    const L = lang();
    if (n !== waveLbl.n || of !== waveLbl.of || L !== waveLbl.L) { waveLbl.n = n; waveLbl.of = of; waveLbl.L = L; waveLbl.s = tr('WAVE {n}/{of}', { n, of }); }
    return waveLbl.s;
  }
  /** Enemies alive (not the titan) + spawns still to come; the wave strip and the boss bar's escort line. */
  function readWave(ph) {
    if (ph === 'survival') { vm.wave = null; vm.escorts = 0; return; }
    let alive = 0;
    for (const a of game.actors) if (a && a.alive && a.team === 'enemy' && a.kind !== 'titan') alive++;
    const d = game.director;
    const w = d?.wave || {};
    let pending = 0;
    try { pending += num(game.enemies?.pending?.(), 0); } catch { /* optional */ }
    pending += Math.max(0, num(w.pending, 0));
    vm.escorts = /titan/.test(ph) ? alive : 0;
    if (waveFlash && game.time.now < waveFlash.until) {
      const W = vm.waveVm;
      W.title = waveFlash.title; W.label = waveLabel(waveFlash.n, waveFlash.of); W.left = 0; W.cleared = true; W.total = 1; W.progress = 1;
      vm.wave = W; return;
    }
    const waveOfPhase = w.phase === undefined || w.phase === ph;          // a stale wave record from an earlier phase
    // left = the director's own count (total − killed, planned groups included) when it keeps one
    const left = waveOfPhase && typeof w.left === 'number' && typeof w.total === 'number' && w.total > 0 ? Math.max(w.left, alive) : alive + pending;
    const m = WAVE_PHASE.exec(ph);
    let idx = waveOfPhase ? num(w.index ?? w.number ?? d?.waveIndex, null) : null;
    if ((idx === null || idx < 1) && m) idx = +m[1];
    const intro = ph === 'intro' || idx === 0;
    if (!intro && (idx === null || !m)) { vm.wave = null; return; }
    if (intro && left === 0) { vm.wave = null; return; }
    let count = num(w.count ?? w.of ?? d?.waveCount, null);
    if (count === null) count = Math.max(idx ?? 1, 6);                       // story: riders1..riders6
    const title = intro ? 'PATROL' : `WAVE ${idx}/${count}`;
    // "cleared" flash for 3 s when the last enemy of a wave falls
    const now = game.time.now;
    if (waveState.key !== title) waveState = { key: title, left, clearedUntil: -99 };
    else {
      if (waveState.left > 0 && left === 0) waveState.clearedUntil = now + 3;
      waveState.left = left;
    }
    const cleared = left === 0 && now < waveState.clearedUntil;
    if (left === 0 && !cleared) { vm.wave = null; return; }
    const total = waveOfPhase ? Math.max(num(w.total, 0), left + num(w.killed, 0)) : 0;
    const W = vm.waveVm;
    W.title = title; W.label = intro ? tr('PATROL') : waveLabel(idx, count); W.left = left; W.cleared = cleared;
    W.total = waveOfPhase && w.total > 0 ? total : 0;
    W.progress = W.total > 0 ? 1 - left / W.total : 0;
    vm.wave = W;
  }

  /**
   * The reticle's edge chevron (wave 5): while the reticle is off screen — mostly in free look (RMB / Alt orbit) — a
   * small crosshair ring on an ellipse inside the screen edge points toward it. The ellipse sits inside the enemy
   * arrows' ring and clear of the HUD panels (objective / boss bar / warning pill on top, tips and player panel
   * bottom-left, skills bottom-right). Direction = the reticle's camera-space direction (the same as on screen for a
   * point in front); a reticle behind the camera leans toward the bottom edge ("turn around"), continuously.
   */
  function placeRetEdge(q, w, H, o) {
    o.visible = !q.onScreen;
    if (!o.visible) return;
    const ins0 = w < 600 && H > w ? RET_EDGE.phone : w <= 900 ? RET_EDGE.narrow : RET_EDGE.wide, S = worldScale();
    const ins = S === 1 ? ins0 : { t: ins0.t * S, b: ins0.b * S, s: ins0.s * S };
    const rx = Math.max(30, w / 2 - ins.s), ry = Math.max(30, (H - ins.t - ins.b) / 2);
    let ang = Math.atan2(q.cy - 0.6 * Math.max(0, -q.z), q.cx);
    if (!Number.isFinite(ang)) ang = -Math.PI / 2;
    // an enemy arrow (and its distance label) right there (last frame's arrows): slide a little along the ellipse
    const placed = markers?.placed || [];
    const E = keep.edge, steps = E.length ? 31 : 9;
    let a = ang;
    for (let k = 0; k < steps; k++) {
      const t = ang + (k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.08);
      const x = w / 2 + Math.cos(t) * rx, y = ins.t + ry - Math.sin(t) * ry;
      if (!placed.some((p) => Math.abs(p[0] - x) < 46 * S && Math.abs(p[1] + 8 * S - y) < 40 * S) && !inRects(E, x, y, 20 * S)) { a = t; break; }
    }
    o.x = w / 2 + Math.cos(a) * rx;
    o.y = ins.t + ry - Math.sin(a) * ry;
    o.rot = Math.atan2(-Math.sin(ang) * ry, Math.cos(ang) * rx);    // still points along the true direction
  }

  function buildVm(realDt) {
    const p = player();
    const cam = game.camera;
    const w = game.size?.w || innerWidth, H = game.size?.h || innerHeight;
    vm.player = !!p;
    if (p) {
      const a = p.actor || p;
      vm.hp = Math.max(0, p.hp ?? a.hp ?? 0); vm.maxHp = a.maxHp ?? p.maxHp ?? 100;
      vm.stamina = clamp(p.stamina ?? 1, 0, 1); vm.heat = clamp(p.heat ?? 0, 0, 1);
      const flag = p.overheated ?? p.overheat;
      if (typeof flag === 'boolean') overLatch = flag;
      else { if (vm.heat >= 0.995) overLatch = true; else if (vm.heat < 0.4) overLatch = false; }
      vm.overheated = overLatch;
      const vel = p.vel || a.vel;
      const speed = p.airspeed ?? (vel ? vel.length() : 0);
      vm.speedKmh = speed * 3.6;
      vm.altitude = Math.max(0, p.altitude ?? (p.pos || a.pos)?.y ?? 0);
      vm.vs = vel ? vel.y : 0;
      vm.boosting = !!p.controls?.boost;
      vm.breathing = breathOn || !!p.controls?.breath;
      readFireball(p);
      // heading crosshair: where the flame goes (mouth + 45 m along the mouth direction)
      const pos = p.pos || a.pos;
      if (p.mouth && p.mouthDir) { _mouth.copy(p.mouth); _fwd.copy(p.mouthDir); }
      else if (pos) { _mouth.copy(pos); _fwd.set(0, 0, 1); if (p.quat) _fwd.applyQuaternion(p.quat); else if (vel && vel.lengthSq() > 1) _fwd.copy(vel).normalize(); }
      if (pos) {
        _p.copy(_mouth).addScaledVector(_fwd, 45);
        project(cam, _p, w, H, pr);
        vm.ret.x = pr.x; vm.ret.y = pr.y; vm.ret.visible = pr.onScreen;
        placeRetEdge(pr, w, H, vm.retEdge);
        // mouse aim point
        const rig = game.cameraRig;
        if (rig?.aimPoint && rig.aimPoint.lengthSq() > 1) _aim.copy(rig.aimPoint);
        else if (rig?.aimDir) _aim.copy(pos).addScaledVector(rig.aimDir, 400);
        else _aim.copy(_p);
        project(cam, _aim, w, H, pr);
        vm.aim.x = pr.x; vm.aim.y = pr.y;
        // hover (player.flightMode): the reticle is the aim point (TPS — where the head and the breath aim), blended
        // over ~0.3 s so a take-off / flare never jumps it; flight keeps the heading crosshair + the mouse-aim ring
        // (the camera's own hover weight when it publishes one: its aimPoint is lerped by the same weight)
        const mode = p.flightMode;
        const camW = rig?.hover && Number.isFinite(rig.hover.w) ? clamp(rig.hover.w, 0, 1) : null;
        const want = typeof mode !== 'string' ? 0 : camW !== null ? camW : mode === 'hover' ? 1 : mode === 'transition' ? 1 - clamp(num(p.throttle, 0.5) / 0.5, 0, 1) : 0;
        if (camW !== null) hoverBlend = want;
        else {
          hoverBlend += (want - hoverBlend) * (1 - Math.exp(-9 * Math.max(0, realDt || 0)));
          if (Math.abs(want - hoverBlend) < 0.002) hoverBlend = want;
        }
        if (hoverBlend > 0.001 && pr.onScreen && vm.ret.visible) {
          vm.ret.x += (pr.x - vm.ret.x) * hoverBlend; vm.ret.y += (pr.y - vm.ret.y) * hoverBlend;
        } else if (hoverBlend > 0.001 && pr.onScreen && !vm.ret.visible && hoverBlend > 0.5) {
          vm.ret.x = pr.x; vm.ret.y = pr.y; vm.ret.visible = true; vm.retEdge.visible = false;
        }
        vm.aim.visible = pr.onScreen && Math.hypot(pr.x - vm.ret.x, pr.y - vm.ret.y) > 14;
        vm.hover = hoverBlend;
        // breath range cue: the player's own verdict (player.inRange: the breath reaches the soft target), else
        // anything hostile inside the flame cone's reach
        if (typeof p.inRange === 'boolean') vm.inRange = p.inRange;
        else {
          vm.inRange = false;
          try {
            _q.copy(_mouth).addScaledVector(_fwd, 32);
            const hits = game.combat?.querySphere?.(_q, 30, { team: 'enemy' });
            vm.inRange = !!hits && hits.length > 0;
          } catch { vm.inRange = false; }
        }
      } else { vm.ret.visible = false; vm.aim.visible = false; vm.retEdge.visible = false; }
    } else vm.retEdge.visible = false;
    // waves, escorts, combo
    const ph = game.director?.phase;
    try { readWave(ph || ''); } catch { vm.wave = null; }
    readCombo();
    vm.combo.count = comboView.count; vm.combo.kills = comboView.kills; vm.combo.frac = comboView.frac;
    // boss
    const t = titanActor();
    const bossPhase = !game.director || /titan/.test(ph || '');
    if (t && t.alive !== false && bossPhase && ph !== 'titan-rise') {
      bossVm.hp = Math.max(0, t.hp); bossVm.maxHp = t.maxHp || 1;
      const f = bossVm.hp / bossVm.maxHp;
      // phase notches: the titan's own thresholds, else the director's balance (escorts at 70 %, enrage at 40 %)
      const bal = game.director?.balance?.titan;
      const ticks = game.titan?.phaseThresholds || (bal ? [bal.escortsAt ?? 0.7, bal.enrageAt ?? 0.4] : [0.7, 0.35]);
      const tp = game.titan?.phase;
      const idx = ph === 'titan-enraged' ? 2 : typeof tp === 'number' ? clamp(tp - 1, 0, 2)
        : /enrag|3|desp/i.test(String(tp ?? '')) ? 2 : /2|wrath/i.test(String(tp ?? '')) ? 1 : f > ticks[0] ? 0 : f > ticks[1] ? 1 : 2;
      bossVm.phaseLabel = phaseName(idx);
      bossVm.enraged = idx === 2;
      bossVm.ticks = ticks;
      bossVm.escorts = vm.escorts;
      vm.boss = bossVm;
    } else vm.boss = null;
    return vm;
  }

  /** The level badge, XP bar and LEVEL UP! cut-in (levels.js); the cut-in waits for a playing, non-cinematic moment. */
  function updateLevels(st, cine, realDt) {
    if (!levels) return;
    const v = readProgress(game.progress, progVm);
    const pa = pActor();
    // a portrait phone has no room for the card beside a kill word (and every level-up comes with one): it waits for it;
    // (fix 29.09) neither has a landscape phone (≤ 500 px tall) nor a touch screen under 900 px tall — the kill word's
    // balloon fills the band left between the insets, the reticle and the controls (844×390 and 1280×800 touch: the word
    // lay on the card, measured: qa/i18n/fix-hud/killcard) — there the card waits until the kill word is gone
    // (≤ LEVEL_RULES.holdMax; 1440×900 / 1080p / 4K touch and the desktop from 800 px tall have room for both)
    const H = game.size?.h || innerHeight;
    const narrow = (game.size?.w || innerWidth) <= 600, cramped = H <= 500 || (touch && H < 900);
    const hold = (narrow && !!hitWords?.killUp) || (cramped && !!hitWords?.killOn);
    const started = levels.update(v, pa?.maxHp ?? player()?.maxHp, st === 'paused' ? 0 : realDt, { playing: st === 'play', cinematic: cine, hold });
    if (started) {
      levelRect = levels.rect();
      wordPanels.dirty = true;
      try { game.events.emit('hud:levelup', { level: started.level, prev: started.prev, element: started.element, elementChanged: started.elementChanged, hpGain: started.hpGain, dmgPct: started.dmgPct }); } catch { /* a listener must not break the HUD */ }
    }
    // the cut-in's box is one of the hit words' panels while it is up; on a phone the kill feed steps back under it
    if (!levels.up) levelRect = null;
    else if (!levelRect) levelRect = levels.rect();
    if (levels.up !== toastDim) { toastDim = levels.up; toastsEl?.classList.toggle('lv-dim', toastDim); }
  }
  /**
   * Touch mode: where the LEVEL UP card goes (levels.js placer, once per card — event-driven). Its stylesheet place
   * (upper left, 150 / 222 px tall) clears the controls on a 16:9 screen, but a landscape phone has the stick ring
   * under it and the left-handed layout the button arc: the card moves up (not above the PAUSE / FULLSCREEN pair), then
   * takes its compact variant (84 / 112 px), then goes right under the panel (mirrored) — the first place whose box
   * clears every control and the panel (keep.edge) wins. null = the stylesheet's place (also the desktop, always).
   */
  function placeLevelCard(view) {
    if (!touch) return null;
    const E = keepOuts(nowReal()).edge;
    if (!E.length) return null;
    const w = innerWidth, H = innerHeight, z = layout.z || 1;
    const tall = !!view?.elementChanged;
    const top0 = z * Math.max(150, (0.21 * H) / z);
    // (screen px; styles.css .tm .lvup: zoom --z, the band 4 px down; the compact card is narrower)
    const V = [
      { right: false, compact: false, w: Math.min(640 * z, 0.47 * w), h: (tall ? 228 : 156) * z },
      { right: false, compact: true, w: Math.min(520 * z, 0.62 * w), h: (tall ? 118 : 90) * z },
      { right: true, compact: false, w: Math.min(640 * z, 0.47 * w), h: (tall ? 228 : 156) * z },
      { right: true, compact: true, w: Math.min(520 * z, 0.62 * w), h: (tall ? 118 : 90) * z },
    ];
    let best = null;
    for (const v of V) {
      const l = v.right ? w - v.w : 0, r = v.right ? w : v.w;
      for (let t = top0; t >= 8 * z; t -= 6 * z) {
        let n = 0;
        for (const q of E) if (q && l < q[2] + 8 && r > q[0] - 8 && t < q[3] + 8 && t + v.h > q[1] - 8) n++;
        if (t + v.h > H - 4) n++;
        if (!n) {
          const out = { top: Math.round(t / z), right: v.right, compact: v.compact };
          layout.lvPlace = { ...out, screen: [Math.round(l), Math.round(t), Math.round(r), Math.round(t + v.h)] };
          return !v.right && !v.compact && t === top0 ? null : out;
        }
        if (!best || n < best.n) best = { n, top: Math.round(t / z), right: v.right, compact: v.compact };
      }
    }
    layout.lvPlace = best ? { ...best, fallback: true } : null;
    return best ? { top: best.top, right: best.right, compact: best.compact } : null;
  }
  function withLevelRect(rects) {
    if (!levelRect) return rects;
    const out = withLevelRect.buf || (withLevelRect.buf = []);
    out.length = 0;
    for (const r of rects || []) out.push(r);
    // (the card with its own weight: a word keeps off it before any other panel — hitwords.js rules.cardSoft)
    const c = withLevelRect.card || (withLevelRect.card = [0, 0, 0, 0, 0]);
    c[0] = levelRect[0]; c[1] = levelRect[1]; c[2] = levelRect[2]; c[3] = levelRect[3]; c[4] = hitWords?.rules?.cardSoft ?? 120;
    out.push(c);
    return out;
  }

  /** Tip context at 5 Hz: enemies spawned within 1.6 km, one of them behind the camera within 900 m, free-look. */
  function updateTips(realDt, playing, hidden) {
    if (!tips?.active) return;
    tipCtx.playing = playing; tipCtx.hidden = hidden;
    tipCtx.camFree = game.cameraRig?.mode === 'free';
    tipCtx.hover = player()?.flightMode === 'hover';          // the hover variant of a tip (dodge: "Ctrl drop down")
    tipCtx.kit = kitNow();                                     // levels: the element's words (F bolt, STORM SURGE…)
    tipCtxAcc += realDt;
    if (tipCtxAcc > 0.2 && playing) {
      tipCtxAcc = 0;
      const p = player(), ppos = p?.pos || p?.actor?.pos;
      let near = 0, behind = false;
      if (ppos && game.camera) {
        for (const a of game.actors) {
          if (!a?.alive || a.team !== 'enemy' || !a.pos || a.kind === 'titan') continue;
          const d2 = a.pos.distanceToSquared(ppos);
          if (d2 < 1600 * 1600) near++;
          if (d2 < 900 * 900 && !behind) { _p.copy(a.pos).applyMatrix4(game.camera.matrixWorldInverse); if (_p.z > 0) behind = true; }
        }
      }
      tipCtx.enemiesNear = near; tipCtx.enemyBehind = behind;
      if ((markers?.stats?.shotArrows || 0) > 0) tips.trigger('dodge');
    }
    tips.update(realDt, tipCtx);
  }

  function updateMarkers(realDt) {
    const cam = game.camera;
    const w = game.size?.w || innerWidth, H = game.size?.h || innerHeight;
    const p = player();
    const ppos = p?.pos || p?.actor?.pos || null;
    lockTarget = game.cameraRig?.lockTarget ?? lockTarget;
    if (lockTarget && lockTarget.alive === false) lockTarget = null;
    // the aim assist's target (player.softTarget): the Minimal HUD names only it and the locked one (markers.js)
    let soft = null;
    try { const s = p?.softTarget; soft = s && typeof s === 'object' && s.alive !== false ? s : null; } catch { soft = null; }
    markerList.length = 0;
    // pilots by actor (enemies.list): drakes fly in flocks; each flock gets one aggregated marker
    pilotMap.clear();
    const list = game.enemies?.list;
    if (Array.isArray(list)) for (const pl of list) if (pl?.actor) pilotMap.set(pl.actor, pl);
    let nf = 0;
    for (const a of game.actors) {
      if (!a || !a.alive || a.team !== 'enemy' || !a.pos) continue;
      const locked = a === lockTarget;
      const d = ppos ? a.pos.distanceToSquared(ppos) : 0;
      if (a.kind === 'titan') { markerList.push({ actor: a, kind: 'titan', locked, d }); continue; }
      const pl = pilotMap.get(a);
      const drake = pl ? pl.kind === 'drake' || pl.variant === 'drake' : /drake|wyvern/i.test(a.name || '');
      if (drake && !locked) {
        const fl = pl?.flock;
        const key = fl ? (fl.id ?? fl) : (pl?.wave ?? 'drakes');
        let f = null;
        for (let i = 0; i < nf; i++) { const c = flockPool[i]; if (c.key === key && c.anchor.distanceToSquared(a.pos) < 380 * 380) { f = c; break; } }
        if (!f) {
          f = flockPool[nf] || (flockPool[nf] = { kind: 'flock', key: null, anchor: new THREE.Vector3(), pos: new THREE.Vector3(), first: null, count: 0, hp: 0, maxHp: 0, label: 'DRAKE FLOCK', locked: false, d: 0 });
          nf++;
          f.key = key; f.anchor.copy(a.pos); f.pos.set(0, 0, 0); f.count = 0; f.hp = 0; f.maxHp = 0; f.first = a; f.d = d;
        }
        f.count++; f.pos.add(a.pos); f.hp += Math.max(0, a.hp || 0); f.maxHp += a.maxHp || 0; f.d = Math.min(f.d, d);
        continue;
      }
      markerList.push({ actor: a, kind: 'dragon', drake, locked, soft: a === soft, d });
    }
    for (let i = 0; i < nf; i++) {
      const f = flockPool[i];
      if (f.count >= 2) { f.pos.divideScalar(f.count); markerList.push(f); }
      else markerList.push({ actor: f.first, kind: 'dragon', drake: true, locked: false, soft: f.first === soft, d: f.d });
    }
    markerList.sort((x, y) => (y.locked - x.locked) || (x.d - y.d));
    // incoming fireballs that will pass close to the player
    if (ppos) {
      const pv = p.vel || p.actor?.vel;
      for (let i = shots.length - 1; i >= 0; i--) {
        const s = shots[i];
        const pos = s.pos || s.position, vel = s.vel || s.velocity;
        if (!pos || s.alive === false || s.dead || s.done) { shots.splice(i, 1); continue; }
        if (!vel) continue;
        _d.copy(pos).sub(ppos); _q.copy(vel); if (pv) _q.sub(pv);
        const vv = _q.lengthSq(); if (vv < 1) continue;
        const tca = -_d.dot(_q) / vv;
        if (tca < 0) { if (_d.length() > 400) shots.splice(i, 1); continue; }
        if (tca > 3.5) continue;
        const miss = _p.copy(_d).addScaledVector(_q, tca).length();
        if (miss < 28) markerList.push({ kind: 'shot', pos, soon: tca < 0.8 });
      }
    }
    markers.update(cam, w, H, markerList, ppos, game.time.now);
    // the titan's weak points while a window is open (a shape's multiplier above its resting value)
    const ta = titanActor();
    const bossOn = !!ta && ta.alive !== false && /^titan(?!-rise)/.test(game.director?.phase || 'titan');
    weak?.update(cam, w, H, bossOn ? ta : null, game.titan);
    // fire damage numbers aggregate per target (one rolling number every ~0.28 s)
    const tNow = nowReal();
    for (const [target, a] of fireAgg) {
      if (a.sum > 0 && tNow - a.t > 0.28) { dmg.spawn(a.pos, String(Math.max(1, Math.round(a.sum))), a.crit ? 'crit' : 'fire'); if (a.crit) markWorded(target); a.sum = 0; a.t = tNow; a.crit = false; }
      else if (a.sum === 0 && tNow - a.t > 3) fireAgg.delete(target);
    }
    try { roll?.follow(); } catch (e) { rollWarn(e); }   // the growing lightning numbers and the CHAIN word follow their enemy
    dmg.avoid = keepOuts(tNow).hard;         // numbers keep off the readouts (wave 5), the Minimal panel and the buttons
    dmg.update(cam, w, H, realDt);
  }

  /** Off-screen attack runs (ATTACK_RUN): detection at `hz`, the chevrons every frame (they follow the attacker). */
  function updateThreats(realDt) {
    if (!atk) return;
    const R = ATTACK_RUN, now = nowReal(), st = game.state, cam = game.camera, p = player();
    const live = st === 'play' && !game.cameraRig?.cinematic && !!cam && !!p?.pos && p.alive !== false && p.actor?.alive !== false;
    if (!live) {
      if (st !== 'paused') { threat.up.length = 0; threat.runs = new WeakMap(); }
      threat.view.length = 0; atk.update(threat.view);
      return;
    }
    const w = game.size?.w || innerWidth, H = game.size?.h || innerHeight;
    // a dodge (player.controls.dodge edge, as the audio hears it) while a chevron is up or just after: the tip is learned
    const dg = p.controls?.dodge || 0;
    if (dg && !threat.dodge && now - threat.lastWarn < 2.2) tips?.learn('threat');
    threat.dodge = dg;
    threat.acc += realDt;
    if (threat.acc >= 1 / R.hz) {
      threat.acc = 0;
      const list = game.enemies?.list;
      const reach = num(game.fx?.config?.breath?.maxRange, R.reach.breath);
      if (Array.isArray(list)) {
        for (const pl of list) {
          if (!runKind(pl)) { threat.runs.delete(pl); continue; }
          let rec = threat.runs.get(pl);
          if (rec?.warned) continue;
          const r = attackRunOf(pl, p, R, reach);
          if (!r || r.eta > R.lead) continue;
          const pos = pl.dragon?.pos || pl.actor?.pos;
          project(cam, pos, w, H, pr, -R.seenMargin);
          if (pr.onScreen) {
            // in view now — but where will it strike from? (its position relative to Sora at the strike, the camera
            // riding along): a run that sweeps in past the frame edge is warned as well
            const ev = pl.dragon?.vel || pl.actor?.vel, pv = p.vel || p.actor?.vel, k = Math.min(r.eta, R.lead);
            _tp.copy(pos);
            if (ev) _tp.addScaledVector(ev, k);
            if (pv) _tp.addScaledVector(pv, -k);
            project(cam, _tp, w, H, pr, -R.seenMargin);
            if (pr.onScreen) { if (!rec) { threat.runs.set(pl, { warned: false }); threat.stats.seenFirst++; } continue; }
            threat.stats.predicted = (threat.stats.predicted || 0) + 1;
            if (!rec) threat.runs.set(pl, rec = { warned: true }); else rec.warned = true;
            warnRun(pl, r, now, true);
            continue;
          }
          if (!rec) threat.runs.set(pl, rec = { warned: true }); else rec.warned = true;
          warnRun(pl, r, now, false);
        }
      }
    }
    // the chevrons: on the edge ellipse toward the attacker, sliding apart when two point the same way
    const view = threat.view; view.length = 0;
    const S = worldScale(), insB = w < 600 && H > w ? R.ins.phone : R.ins.wide;
    const ins = S === 1 ? insB : { t: insB.t * S, b: insB.b * S, s: insB.s * S };
    const rx = w / 2 - ins.s, ry = (H - ins.t - ins.b) / 2, cx0 = w / 2, cy0 = ins.t + ry;
    const placed = [];
    for (let i = threat.up.length - 1; i >= 0; i--) {
      const u = threat.up[i];
      const pos = u.pl.dragon?.pos || u.pl.actor?.pos;
      const gone = !pos || u.pl.alive === false || !runKind(u.pl);
      if (pos) {
        // a run warned for where it will strike from (it was still in view): the chevron follows that point
        _tp.copy(pos);
        if (u.pred) {
          const k = Math.max(0.15, u.eta0 - (now - u.t0)), ev = u.pl.dragon?.vel || u.pl.actor?.vel, pv = p.vel || p.actor?.vel;
          if (ev) _tp.addScaledVector(ev, k);
          if (pv) _tp.addScaledVector(pv, -k);
        }
        project(cam, _tp, w, H, pr, -R.seenMargin);
      }
      u.seenT = pos && pr.onScreen ? u.seenT + realDt : 0;
      if (u.fadeAt < 0 && (gone || u.seenT > R.seenHold || now > u.until - R.fade)) u.fadeAt = now;
      const alpha = u.fadeAt < 0 ? 1 : 1 - (now - u.fadeAt) / R.fade;
      if (alpha <= 0) { threat.up.splice(i, 1); continue; }
      if (!pos) continue;
      let { ang, behind } = threatAngle(pr.cx, pr.cy, pr.z);
      let x = 0, y = 0, found = false;
      // the label under the chevron (above it in the bottom band), kept inside the screen: never over the centre,
      // where the fight is, nor over the speed / altitude readouts inside the ring
      const lab = (px, py) => { const up = py > cy0 + ry * 0.55; return [clamp(px, 70 * S, w - 70 * S) - px, (up ? -36 : 32) * S, up]; };
      // (touch / Minimal: the chevron AND its label — "ATTACK RUN", "BEHIND" under / over it — slide along the ellipse
      // off the buttons, the stick and the top-right panel; no clear spot within ±1.4 rad: the chevron comes inward along
      // its own direction until both are clear, so it still points the true way)
      const E = keep.edge, steps = E.length ? 25 : 7;
      const clear = (px, py) => {
        if (!E.length) return true;
        if (inRects(E, px, py, 30 * S)) return false;
        const [lx, ly, up] = lab(px, py), bx = px + lx, by = py + ly;
        // .atk-t ≈ 118 × 18 px centred on the label point; .atk-s ("BEHIND", 62 × 15) 12 px under it (11 px over it: up)
        const t = by - 10 * S - (behind && up ? 17 * S : 0), b = by + 10 * S + (behind && !up ? 18 * S : 0);
        return !rectsHit(E, bx - 60 * S, t, bx + 60 * S, b, 4);
      };
      for (let k = 0; k < steps; k++) {
        const a = ang + (k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.12);
        x = cx0 + Math.cos(a) * rx; y = cy0 - Math.sin(a) * ry;
        if (!placed.some((q) => Math.abs(q[0] - x) < 120 * S && Math.abs(q[1] - y) < 56 * S) && clear(x, y)) { ang = a; found = true; break; }
      }
      if (!found && E.length) {
        const ex = cx0 + Math.cos(ang) * rx, ey = cy0 - Math.sin(ang) * ry;
        for (let f = 0.08; f <= 0.8; f += 0.08) { x = ex + (cx0 - ex) * f; y = ey + (cy0 - ey) * f; if (clear(x, y)) break; }
        threat.stats.inward = (threat.stats.inward || 0) + 1;
      }
      placed.push([x, y]);
      const rot = Math.atan2(-Math.sin(ang) * ry, Math.cos(ang) * rx);
      const [lx, ly] = lab(x, y);
      view.push({ x, y, rot, lx, ly, behind, alpha, kind: u.kind, fresh: u.fresh });
      u.fresh = false;
      u.behind = behind;
    }
    atk.update(view);
  }
  /** A run warned: the chevron (the oldest one makes room), the chirp (≥ soundGap apart), the tip, the log. */
  function warnRun(pl, r, now, pred) {
    const R = ATTACK_RUN;
    if (threat.up.length >= R.max) { let o = 0; for (let i = 1; i < threat.up.length; i++) if (threat.up[i].t0 < threat.up[o].t0) o = i; threat.up.splice(o, 1); }
    const { behind } = threatAngle(pr.cx, pr.cy, pr.z);
    threat.up.push({ pl, kind: r.kind, t0: now, until: now + R.life, fadeAt: -1, seenT: 0, fresh: true, behind, pred: !!pred, eta0: r.eta });
    const S = threat.stats;
    S.warned++; S[r.kind] = (S[r.kind] || 0) + 1; if (behind) S.behind++;
    threat.lastWarn = now;
    threat.log.push({ t: +game.time.now.toFixed(2), name: pl.actor?.name || pl.name || '?', kind: r.kind, eta: +r.eta.toFixed(2), dist: Math.round(r.dist), behind, pred: !!pred });
    if (threat.log.length > 40) threat.log.shift();
    // one event per warned run; `chirp` false when the last chirp was < soundGap ago (audio stays quiet then)
    const chirp = now - threat.lastSound >= R.soundGap;
    if (chirp) { threat.lastSound = now; S.sounds++; }
    // pan: the attacker's azimuth from the camera (right +), behind: from the rear hemisphere
    const pan = clamp(pr.cx / Math.max(1, Math.hypot(pr.cx, pr.z)), -1, 1);
    try { game.events.emit('attackrun', { actor: pl.actor || null, kind: r.kind, eta: r.eta, pan, behind, chirp }); } catch { /* a listener must not break the HUD */ }
    tips?.trigger('threat');
  }

  // ------------------------------------------------------------------------------------------------ system
  const hud = {
    name: 'hud',
    settings, stats,
    toast, banner, warning, setObjective,
    /** The director hands over its final numbers just before it switches to victory / defeat. */
    showResults(r) { if (r && typeof r === 'object') runResults = r; },
    change, start, pause: pauseGame, resume, quit, retry,
    openPanel: (n) => openPanel(n), closePanel: () => closePanel(),
    get touch() { return touch; },
    /** The Minimal HUD is on (Settings HUD minimal, or Auto in touch mode). */
    get minimal() { return minimal; },
    /** The world-HUD scale (touch mode: the touch UI's --z; 1 with keyboard & mouse). */
    get worldScale() { return worldScale(); },
    /** The controls' and the panel's keep-out rects [[l, t, r, b], …] (touch mode / Minimal HUD; [] on the desktop's
     *  Full HUD), re-measured ≤ 1 Hz — the live array, read-only (moves.js keeps the soft-target brackets off them). */
    get keepEdge() { return keep.edge; },
    /** Layout state for tests: { touch, minimal, ntu (a touch layer owns the buttons), z (touch UI scale), flips, log,
     *  keep: { hard, edge } (the keep-out rects last measured), fullscreen: { supported, on, stats } }. */
    get layout() { return { touch, minimal, ntu: !!layout.ntu, z: layout.z, flips: layout.flips, log: layout.log.slice(), legacyButtons: legacyWired,
      keep: { hard: keep.hard.map((r) => r.map(Math.round)), edge: keep.edge.map((r) => r.map(Math.round)) }, fullscreen: { supported: fs.supported, on: fs.on, stats: { ...fs.stats } },
      lvPlace: layout.lvPlace ? { ...layout.lvPlace } : null, hudSize: settings.hudSize ?? null,
      hidden: { markers: markers?.blocked ?? 0, weak: weak?.blocked ?? 0 }, inward: threat.stats.inward || 0 }; },
    /** The Fullscreen API helper (supported, on, toggle() from a gesture). */
    fullscreen: fs,
    /** (tests, read-only) the hit-direction wedge's reach for a hit from `ang` rad — null = the CSS default. */
    hitReach: (ang) => hitReach(ang),
    /** { count, kills, frac } — the kill combo as shown (audio raises the kill chime with it). */
    get combo() { return readCombo(); },
    get markers() { return markers; },
    /** Damage numbers (read-only for tests: pool, stats { spawned, nudged }, avoid rects). */
    get damageNumbers() { return dmg; },
    /** The lightning numbers and the CHAIN word (read-only for tests: stats, live). */
    get numberRoll() { return roll ? { stats: { ...roll.stats }, live: roll.live } : null; },
    /** Hit words (read-only for tests: stats, log of the last 40 words, alive, enabled). */
    get hitWords() { return hitWords; },
    /** Survival panel as shown (for tests): { on, wave, time, score, best, alive, next, newBest } or null. */
    get survival() { return surv?.el.classList.contains('on') ? { on: true, ...survVm, best: survVm.best ? { ...survVm.best } : null } : null; },
    /** The best Survival run as the title shows it ({ wave, time, score } | null). */
    get survivalBest() { return readSurvivalBest(); },
    /** Off-screen attack-run warnings (for tests): { up (chevrons shown), shown: [{ x, y, behind, kind }], stats, log }. */
    get threats() { return { up: threat.view.length, shown: threat.view.map((v) => ({ x: Math.round(v.x), y: Math.round(v.y), behind: v.behind, kind: v.kind, alpha: +v.alpha.toFixed(2) })), stats: { ...threat.stats }, log: threat.log.slice() }; },
    /** Levels as shown (for tests): { level, element, frac, text, cutIn: { up, level, prev, element, changed } | null,
     *  stats (levelUps, cutIns, merged, polled, elementChanges, gains, log), xp: 'xp' events seen }. */
    get levels() {
      if (!levels) return null;
      const c = levels.cur;
      return { level: levels.shown?.level ?? null, element: levels.shown?.element ?? null, frac: levels.shown ? +levels.shown.frac.toFixed(3) : null,
        text: levels.xpT.textContent, badge: levels.badgeN.textContent, on: levels.badge.classList.contains('on'),
        cutIn: c ? { up: true, t: +c.t.toFixed(2), level: c.view.level, prev: c.view.prev, element: c.view.element, changed: c.view.elementChanged, name: c.view.name, hp: c.view.hpGain, dmg: c.view.dmgPct } : null,
        queued: levels.queue.length, stats: { ...levels.stats, log: levels.stats.log.slice() }, xp: { ...xpStats } };
    },
    /** First-flight tips as shown (for tests): { current: { id, done } | null, shown: [ids], learned: { id: 1 } }. */
    get tips() { return tips ? { current: tips.current, shown: [...tips.shown], learned: { ...tips.learned } } : null; },

    init() {
      onLang(() => relang());           // (before build(): ahead of the menus' own listeners, see relang)
      build();
      const ev = game.events;
      // the touch layer switched (first touch, Settings, ?touch): the layout follows at once
      ev.on('touchmode', (e = {}) => { try { syncMode(e.reason || 'touchmode'); } catch (err) { console.warn('[hud] touchmode', err); } });
      ev.on('resize', () => { updateZoom(); keep.dirty = true; });
      ev.on('state', onState);
      ev.on('damage', onDamage);
      ev.on('death', onDeath);
      ev.on('fireball', onFireball);
      ev.on('breath', ({ actor, on } = {}) => { if (isPlayer(actor)) breathOn = !!on; });
      ev.on('lock', ({ target } = {}) => { lockTarget = target || null; if (target) tips?.learn('lock'); });
      ev.on('director:kill', (e) => hitWords?.onDirectorKill(e));
      ev.on('xp', (e) => { try { onXp(e); } catch (err) { if (!hud._xpWarned) { hud._xpWarned = true; console.warn('[hud] xp', err); } } });
      ev.on('levelup', (e) => { try { onLevelUp(e); } catch (err) { if (!hud._lvWarned) { hud._lvWarned = true; console.warn('[hud] levelup', err); } } });
      // a new run (or ?debug&level=N): the next read is the new baseline — no cut-in for the reset itself
      ev.on('progress:reset', () => { try { levels?.reset(); xpLoose.length = 0; } catch { /* optional */ } });
      ev.on('phase', onPhase);
      ev.on('titan:telegraph', onTelegraph);
      ev.on('wave:cleared', ({ index } = {}) => {
        if (!(index >= 1)) return;
        const count = num(game.director?.wave?.count, 3);
        waveFlash = { title: `WAVE ${index}/${Math.max(count, index)}`, n: index, of: Math.max(count, index), until: game.time.now + 2.6 };
      });
      ev.on('warning', (e = {}) => { if (!e.fromHud && e.text) showWarning(e.text, e.level ?? 1, e); });
      // survival: a wave card when the director shows none of its own (checked 0.25 s later), the end numbers
      ev.on('survival:wave', (e = {}) => {
        if (!root) return;
        const n = Math.round(num(e.wave, 0));
        if (!(n >= 1)) return;
        if (!survRun.active) beginSurvival();
        survRun.waveSeen = n;
        const at = nowReal();
        setTimeout(() => {
          if (lastBannerAt >= at - 0.3 || game.state !== 'play') return;
          const ace = e.ace ?? e.aces ?? (n % 5 === 0);
          const own = ace && n % 5 === 0 ? tr('Ace squadron incoming!') : n === 4 ? tr('The Onyx Aces join the hunt') : n === 1 ? tr('Endless waves — how long can you last?') : tr('More Shade Riders incoming');
          // (the event's label is English data in every language: English shows it as before; another language shows the
          //  director's own words for the wave, else the label's dictionary text, else the HUD's own line)
          const L = e.label || e.subtitle;
          let sub = L || own;
          if (lang() !== 'en') {
            let words = null;
            try { words = game.director?.survivalWaveText?.(n)?.sub || null; } catch { words = null; }
            sub = words || (L && hasText(L) ? tr(L) : L && CYRILLIC.test(L) ? L : own);
          }
          banner(tr('WAVE {n}', { n }), sub, { duration: 2.6 });
          survRun.bannerAt = nowReal();
        }, 250);
      });
      ev.on('survival:end', (e = {}) => {
        survRun.end = e && typeof e === 'object' ? e : null;
        try { saveSurvivalBest({ wave: num(e?.wave, 0), time: num(e?.time, 0), score: num(e?.score, 0) }); } catch { /* optional */ }
      });
      ev.on('mute', ({ muted } = {}) => {
        muteEl.classList.toggle('on', !!muted);
        if (settings.muted !== !!muted) { settings.muted = !!muted; saveSettings(settings); }
        if (game.state === 'play') toast(muted ? (touch ? tr('Sound off') : tr('Sound off  ·  M to unmute')) : tr('Sound on'));
      });
      ev.on('quality', (q) => { if (q?.name && settings.quality !== q.name) { settings.quality = q.name; saveSettings(settings); } });
      // camera owns sensitivity / invert: adopt its persisted values as the truth
      const cam = game.cameraRig?.settings;
      if (cam) {
        if (typeof cam.sensitivity === 'number') settings.mouseSensitivity = clamp(cam.sensitivity, 0.25, 3);
        if (typeof cam.invertY === 'boolean') settings.invertY = cam.invertY;
      }
      if (game.state !== 'loading') onState({ prev: 'loading', next: game.state });
    },

    update(dt, realDt) {
      if (!root) return;
      if (game.state === 'play') {
        stats.time += dt;
        const p = player();
        if (p && (breathOn || p.controls?.breath)) {
          breathWin.t += dt;
          if (breathWin.t >= 0.25) { stats.shots++; if (breathWin.hit) stats.hits++; breathWin = { t: 0, hit: false }; }
        }
      }
    },

    lateUpdate(dt, realDt) {
      if (!root) return;
      try { syncMode('frame'); } catch (e) { if (!hud._modeWarned) { hud._modeWarned = true; console.warn('[hud] layout', e); } }
      try {
        const st = game.state;
        const flying = st === 'play' || st === 'paused' || st === 'victory' || st === 'defeat';
        if (flying || st === 'photo') {
          const cine = !!game.cameraRig?.cinematic;
          hudEl.classList.toggle('cine', cine || st === 'victory' || st === 'defeat');
          if (st !== 'photo') {
            fly.update(buildVm(realDt), realDt);
            try { updateLevels(st, cine, realDt); } catch (e) { if (!hud._lvlWarned) { hud._lvlWarned = true; console.warn('[hud] levels', e); } }
            try { const sv = readSurvival(game.director?.phase || ''); if (sv) sv.nextShown = !objCountsDown(); surv?.update(sv, nowReal()); } catch (e) { surv?.update(null); if (!hud._survWarned) { hud._survWarned = true; console.warn('[hud] survival panel', e); } }
            updateMarkers(realDt);
            try { updateThreats(realDt); } catch (e) { if (!hud._threatWarned) { hud._threatWarned = true; console.warn('[hud] attack-run warnings', e); } }
            updateWarnFlow();
            updateWarnDir();
            // paused: the words wait (dt 0) under the pause screen
            if (hitWords) hitWords.update(st === 'paused' ? 0 : realDt, game.camera, game.size?.w || innerWidth, game.size?.h || innerHeight, vm.ret,
              keep.hard, warnFlag, hitWords.busy ? withLevelRect(wordPanelRects(nowReal())) : null);
          }
          const locked = !!(game.cameraRig ? game.cameraRig.pointerLocked : document.pointerLockElement === game.canvas);
          const prompt = st === 'play' && !touch && !locked && !game.cameraRig?.lockUnavailable && !cine;
          promptEl.classList.toggle('on', prompt);
          // desktop: the in-flight FULLSCREEN button only while the cursor is free (it cannot be clicked while locked)
          const free = st === 'play' && !touch && !locked && !cine;
          if (free !== layout.free) { layout.free = free; hudEl.classList.toggle('free', free); }
          // the hover / flight scheme: the prompt says W flies (once, when the player publishes flight modes)
          if (prompt && !promptModes && typeof player()?.flightMode === 'string') {
            promptModes = true;
            const sub = promptEl.querySelector('.pr-s');
            if (sub) sub.textContent = tr('The mouse aims Sora  ·  hold W to fly  ·  Esc pauses');
          }
          updateTips(realDt, st === 'play', cine || prompt);
        } else {
          promptEl.classList.remove('on');
          if (layout.free) { layout.free = false; hudEl.classList.remove('free'); }
        }
      } catch (e) {
        if (!hud._warned) { hud._warned = true; console.warn('[hud] frame failed', e); }
      }
    },
  };
  return hud;
}
