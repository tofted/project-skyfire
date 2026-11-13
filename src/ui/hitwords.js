// Manga hit words: an unmistakable confirmation of every hit the player lands on an enemy dragon (riders, aces,
// drakes — never the titan, never the player being hit). The user: "a confirmation that you hit the dragon".
//
//   confirmation (always)  "HIT!" (breath contact, again every 0.9 s of a held stream; a fireball's splash on a
//                          neighbour), "DIRECT HIT!" (fireball), "CHARGED HIT!" (a charged fireball, direct),
//                          "CRITICAL HIT!" (a weak point, shape.mult ≥ 1.5); hits on 2+ dragons within 0.25 s share
//                          one "MULTI HIT! ×N"; kills: "SHOT DOWN!" (rider), "ACE DOWN!" (ace), "DOWN!" (drake)
//   backed by              a manga X-slash burst on the reticle (colour by type; the only reticle marker for enemy
//                          dragons) and a 1.2 s flash of the struck dragon's name plate + HP bar (markers.js pool; a
//                          compact name + HP tag under the word when the dragon has no full plate this frame)
//   flavour (on top)       FWOOSH! SCORCH! SIZZLE! BURN! (breath, ≤ 1 per 1.2 s per target), BOOM! WHAM! KA-BOOM!
//                          BLAST! (fireball) — never the same word twice in a row; combos DOUBLE! TRIPLE! ×N COMBO!
//   XP (levels)            a kill worth XP (the progression's 'xp' event, hud.js → onXp) gets a small "+25 XP" line
//                          under the kill word (and its combo line); it pops in 0.2 s after the kill word
//
// Rank hit < direct < charged < crit < kill: a weaker hit never cuts a stronger word that is younger than 60 % of its
// life — it "re-hits" it instead (a scale kick, a reticle burst, the plate flash again).
// A miss never shows anything: every word comes from a 'damage' / 'death' event whose source is the player and whose
// target is an enemy dragon. Afterburn ticks (the burning status: kind 'fire' without a shape or direction) confirm
// nothing by themselves (they are not a new hit), but a kill by them is still the player's kill.
// Lettering: every letter is its own little unit (light rim, ink outline, gradient fill) with a deterministic tilt,
// size and baseline jitter, overlapping its neighbour — set once at a spawn, never per frame.
// Pooled DOM (6 word groups, 3 reticle bursts), built once; per frame only transform / opacity and the paused Web
// Animations' currentTime (driven by the group's own clock, so a frame hitch never eats a word's life). Zero work
// while nothing is alive. Text size is estimated from the characters (no layout reads).
import * as THREE from 'three';
import { h, s as svgEl } from './dom.js';
import { project } from './markers.js';
import { tr, lang, onLang } from './i18n.js';

/** Tuning (exported for tests / docs). Times: throttles in simulation seconds, lives in real seconds. */
export const HIT_RULES = {
  confirmEvery: 0.9,      // s per target: a held breath stream confirms again after this
  flavourEvery: 1.2,      // s per target between two breath flavour words
  burstGap: 0.35,         // s without a breath tick on a target: the next tick starts a new burst
  critMult: 1.5,          // shape multiplier of a weak point (the head): the only thing that makes a hit CRITICAL
  directBase: 30,         // fallback when the fireball is unknown: base damage (amount / mult) ≥ this is the direct hit
  chargedAt: 0.2,         // a direct hit by a fireball charged to this level or more is CHARGED HIT! (player CHARGE.tap)
  multiWindow: 0.25,      // s: hits on two or more dragons within this share one MULTI HIT! ×N word
  keepFrac: 0.6,          // a stronger word younger than this share of its life is re-hit, not replaced, by a weaker hit
  rank: { hit: 1, direct: 2, charged: 3, crit: 4, kill: 5 },
  maxAlive: 4,            // word groups on screen at once (the oldest fades out fast)
  life: { hit: 0.8, direct: 0.9, charged: 0.95, crit: 0.95, kill: 1.15 },
  flash: 1.2,             // s the struck dragon's plate flashes
  fastFade: 0.12,         // s: a replaced word / the oldest group when a fifth arrives / a word whose dragon left
  minShow: 0.3,           // s a word stays up (frozen where it is) after its dragon leaves the screen, from its pop
  offMargin: 40,          // px beyond the screen edge where a dragon counts as gone
  nearCam: 12,            // m: a dragon this close to the camera counts as gone (it is passing the lens)
  sideGap: 110,           // px from the hit point up to the spot above the plate; farther: the word goes beside the hit
  playerSoft: 10,         // soft weight of Sora's head / body column (a word / its own plate weighs 10)
  wingSoft: 4,            // … and of her wing band
  panelSoft: 30,          // the objective panel and the kill feed: heavier than anything but the hard reticle / readouts
  // the LEVEL UP! card (hud.js hands it over as a panel [l, t, r, b, cardSoft]): a word goes anywhere else that is free
  // of the hard keep-outs first (fix 29.09: at 1280×800 touch a kill word lay on the card with room left below it)
  cardSoft: 120,
  xpWindow: 0.8,          // s: XP whose event named no actor goes to a kill word spawned within this
  // size: base px at 1440×900 and ~150 m; × distance (0.85…1.08) × screen (0.7…1.1)
  size: { hit: 46, direct: 46, charged: 48, crit: 48, kill: 50 },
  // screen insets the words stay inside (desktop / phone portrait): under the objective / wave strip / boss bar,
  // above the tips (bottom-left), the skills and the player panel (the objective and the kill feed themselves are
  // measured by hud.js: panelSoft)
  inset: { wide: { t: 96, b: 196, s: 16 }, phone: { t: 150, b: 280, s: 10 } },
  warnTop: 146,           // px: the top inset while the warning pill (y 100–136) is up
  reticle: { r: 66, below: 20, pad: 6 },   // the reticle's box (+ its IN RANGE label below) the words keep out of
  reticleNarrow: { r: 56, below: 18, pad: 4 },   // ≤ 600 px wide: the reticle is 112 px (styles.css)
};
export const WORDS = {
  fire: ['FWOOSH!', 'SCORCH!', 'SIZZLE!', 'BURN!'],
  fireball: ['BOOM!', 'WHAM!', 'KA-BOOM!', 'BLAST!'],
  impact: ['WHAM!', 'SMASH!', 'CRASH!'],
};
export const KILL_WORD = { rider: 'SHOT DOWN!', ace: 'ACE DOWN!', drake: 'DOWN!' };
/** The small line over "HIT!" per kind. */
export const PRE_WORD = { hit: '', direct: 'DIRECT', charged: 'CHARGED', crit: 'CRITICAL', multi: 'MULTI' };
/** The combo line for a kill: '' below 2. */
export function comboWord(n) { return n >= 4 ? `×${n} COMBO!` : n === 3 ? 'TRIPLE!' : n === 2 ? 'DOUBLE!' : ''; }

/** Is this damage record something the words answer? (enemy dragon, not the titan) */
export function isEnemyDragon(a) { return !!a && a.kind === 'dragon' && a.team === 'enemy'; }
/** Afterburn (the burning status' damage-over-time): kind 'fire' with no shape and no direction. */
export function isAfterburn(rec) { return rec?.kind === 'fire' && !rec.shape && !rec.dir; }
/** A weak point (the head): the only CRITICAL. A big number alone (a charged shot, skyfall) is not a crit. */
export function isCrit(rec, R = HIT_RULES) { return (rec?.shape?.mult ?? 1) >= R.critMult; }
/**
 * A fireball event that is the direct hit, not the splash on a neighbour. proj: the detonated projectile when known —
 * the direct hit deals exactly its damage (× the shape), the splash at most damage × (0.5 + 0.4 × charge) × falloff.
 * rec.splash (if fire.js ever marks it) wins; without a projectile, base damage ≥ directBase (a plain shot is 45).
 */
export function isDirect(rec, R = HIT_RULES, proj = null) {
  if (!rec || rec.splash) return false;
  const base = (rec.amount ?? 0) / (rec.shape?.mult || 1);
  return proj && proj.damage > 0 ? base >= proj.damage * 0.98 : base >= R.directBase;
}
/** 'hit' (splash) | 'crit' (direct on a weak point) | 'charged' (direct, charged shot) | 'direct'. */
export function fireballKind(rec, proj = null, R = HIT_RULES) {
  if (!isDirect(rec, R, proj)) return 'hit';
  if (isCrit(rec, R)) return 'crit';
  return ((proj ? proj.charged : rec?.charged) || 0) >= R.chargedAt ? 'charged' : 'direct';
}
const KIND_CLS = { hit: 'k-fb', direct: 'k-fb', charged: 'k-chg', crit: 'k-crit' };
const burstOf = (kind, cls) => (kind === 'crit' ? 'crit' : kind === 'charged' ? 'chg' : kind === 'kill' ? 'kill' : cls === 'k-fire' ? 'fire' : 'fb');

// ---------------------------------------------------------------------------------------------------- shapes
/** A small seeded random stream (deterministic per word: the same word jitters the same way on every layer). */
function rng(seed) { let r = (Math.abs(Math.floor(seed)) % 2147483646) + 1; return () => ((r = (r * 16807) % 2147483647) - 1) / 2147483646; }

/** A spiky manga burst balloon as a clip-path polygon (deterministic per seed). */
function starPoly(n, seed, inner = 0.6) {
  const rnd = rng(seed);
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2 + (rnd() - 0.5) * 0.16;
    const rad = i % 2 ? inner * (0.82 + rnd() * 0.3) : 0.86 + rnd() * 0.14;
    pts.push(`${(50 + Math.cos(a) * rad * 50).toFixed(1)}% ${(50 + Math.sin(a) * rad * 50).toFixed(1)}%`);
  }
  return `polygon(${pts.join(', ')})`;
}
const STARS = [starPoly(13, 7), starPoly(16, 911), starPoly(11, 12345)];

/** The reticle burst: four tapered X slashes, four short ticks between them and a ring (kills). 160 px box. */
function burstSVG() {
  const C = 80;
  const slash = (deg, r0, r1, wd) => {
    const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), nx = -s, ny = c;
    const rm = r0 + (r1 - r0) * 0.3;
    const P = (r, o) => `${(C + c * r + nx * o).toFixed(1)},${(C + s * r + ny * o).toFixed(1)}`;
    return `M${P(r0, 0)} L${P(rm, wd)} L${P(r1, 0)} L${P(rm, -wd)} Z`;
  };
  const X = [45, 135, 225, 315].map((d) => slash(d, 24, 60, 4.2)).join(' ');
  const T = [0, 90, 180, 270].map((d) => slash(d + 8, 34, 46, 1.6)).join(' ');
  return svgEl('svg', { viewBox: '0 0 160 160' },
    svgEl('circle.hx-r', { cx: C, cy: C, r: '30' }),
    svgEl('path.hx-t', { d: T }),
    svgEl('path.hx-s', { d: X }));
}

// ---------------------------------------------------------------------------------------------------- lettering
// Avenir Next Condensed Heavy Italic: advance per character in em incl. the .01em tracking (measured in Chrome with
// getBoundingClientRect at 100 px; widths add up exactly, e.g. "HIT!" 1.868 em). Each letter is an inline-block
// with a −.03em right margin (the letters touch and share one outline), "!" .04em more room on its left, a space is a
// .45em spacer.
const CW = { A: 0.62, B: 0.604, C: 0.552, D: 0.643, E: 0.492, F: 0.479, G: 0.625, H: 0.658, I: 0.348, J: 0.509, K: 0.648, L: 0.489,
  M: 0.831, N: 0.655, O: 0.664, P: 0.586, Q: 0.674, R: 0.606, S: 0.515, T: 0.488, U: 0.626, V: 0.626, W: 0.868, X: 0.62, Y: 0.564,
  Z: 0.521, '!': 0.374, '-': 0.284, '×': 0.696 };
// Russian (29.09): Avenir Next Condensed has no Cyrillic — the Russian lettering is Impact (styles.css :root[lang="ru"]
// .hw-t: one face for the whole word, "!" and digits included); its advances, measured the same way (italic 900 at 100 px,
// .01em tracking, Chrome, macOS).
const CW_RU = { A: 0.518, B: 0.562, C: 0.564, D: 0.563, E: 0.426,
  F: 0.408, G: 0.561, H: 0.565, I: 0.298, J: 0.341, K: 0.547, L: 0.39, M: 0.727, N: 0.552, O: 0.556, P: 0.512, Q: 0.556, R: 0.549,
  S: 0.527, T: 0.471, U: 0.557, V: 0.533, W: 0.825, X: 0.492, Y: 0.483, Z: 0.407, 0: 0.546, 1: 0.391, 2: 0.512, 3: 0.54, 4: 0.51,
  5: 0.547, 6: 0.552, 7: 0.402, 8: 0.545, 9: 0.552, '!': 0.28, '-': 0.305, '×': 0.543, '+': 0.543, '.': 0.195, ',': 0.178, '?': 0.535 };
const TRACK = -0.03, SPACE = 0.45, BANG = 0.04;
const textEm = (t) => {
  const W = lang() === 'ru' ? CW_RU : CW, d = W === CW ? 0.584 : 0.55;
  let w = 0; for (const c of String(t)) w += (c === ' ' ? SPACE : W[c] ?? d) + TRACK + (c === '!' ? BANG : 0); return w;
};

// ---------------------------------------------------------------------------------------------------- languages
// English is the source: WORDS, KILL_WORD, PRE_WORD, comboWord(), xpWord() and the log stay English. What a group SHOWS
// is its English lines (g.en) in the current language (g.txt, lettered and measured): the confirmation as one phrase
// (DIRECT HIT! → (other language)!; a "\n" in the Russian text splits the small line above from the big one: MULTI HIT! →
// (other language)!), the kill word, the flavour SFX (Russian onomatopoeia), the combo and the XP lines. A language switch
// re-letters the words that are up (their spots stay).
const HIT_PHRASE = { '': () => tr('HIT!'), DIRECT: () => tr('DIRECT HIT!'), CHARGED: () => tr('CHARGED HIT!'), CRITICAL: () => tr('CRITICAL HIT!'), MULTI: () => tr('MULTI HIT!') };
const WORD_TR = {
  'SHOT DOWN!': () => tr('SHOT DOWN!'), 'ACE DOWN!': () => tr('ACE DOWN!'), 'DOWN!': () => tr('DOWN!'),
  'FWOOSH!': () => tr('FWOOSH!'), 'SCORCH!': () => tr('SCORCH!'), 'SIZZLE!': () => tr('SIZZLE!'), 'BURN!': () => tr('BURN!'),
  'BOOM!': () => tr('BOOM!'), 'WHAM!': () => tr('WHAM!'), 'KA-BOOM!': () => tr('KA-BOOM!'), 'BLAST!': () => tr('BLAST!'),
  'SMASH!': () => tr('SMASH!'), 'CRASH!': () => tr('CRASH!'), 'DOUBLE!': () => tr('DOUBLE!'), 'TRIPLE!': () => tr('TRIPLE!'),
};
const trWord = (w) => (!w ? '' : WORD_TR[w] ? WORD_TR[w]() : tr(w));
/** A group's English lines { pre, main, flav, sub, xp } → what it shows in the current language (same shape). */
export function hitLines(en, out = {}) {
  if (lang() === 'en') { out.pre = en.pre; out.main = en.main; out.flav = en.flav; out.sub = en.sub; out.xp = en.xp; return out; }
  let pre = en.pre, main = en.main;
  const m = /^HIT!(?: ×(\d+))?$/.exec(main || '');
  if (m) {
    const n = m[1] ? +m[1] : 0;
    let t = (HIT_PHRASE[pre] || HIT_PHRASE[''])();
    if (n > 1) t = pre === 'MULTI' ? tr('MULTI HIT! ×{n}', { n }) : `${t} ×${n}`;
    const i = t.indexOf('\n');
    pre = i >= 0 ? t.slice(0, i) : ''; main = i >= 0 ? t.slice(i + 1) : t;
  } else { pre = trWord(pre); main = trWord(main); }
  const c = /^×(\d+) COMBO!$/.exec(en.sub || ''), x = /^\+(\d+) XP$/.exec(en.xp || '');
  out.pre = pre; out.main = main; out.flav = trWord(en.flav);
  out.sub = c ? tr('×{n} COMBO!', { n: +c[1] }) : trWord(en.sub);
  // (the lettering is capitals only — CW_RU measures them: «+25 (other language)» is lettered «+25 (other language)»)
  out.xp = (x ? tr('+{n} XP', { n: +x[1] }) : en.xp ? tr(en.xp) : '').toUpperCase();
  return out;
}
const OUTLINE = 0.32;     // em: the outermost stroke (half of it grows outside the glyphs on each side)
const JITTER = 0.08;      // em: extra height for the letters' tilt / size / baseline jitter
const TAG_H = 26;         // px: the compact name + HP tag under a word (when the dragon has no full plate)
// touch mode (fxBox): the burst balloon's growth in the keep-out box — 1.3× as it fades (visible until ≈ 1.29×) and a
// re-hit's ×1.3 kick of the row, which is back under 1.1× within 60 ms: 1.29 × 1.1
const FX_BOX = 1.42;
// per line: tilt ±deg, size lo…hi, baseline ±em, the first letter's and the "!"'s size
const JIT = {
  main: { rot: 6, lo: 0.92, hi: 1.08, dy: 0.06, first: 1.13, bang: 1.24 },
  pre: { rot: 4, lo: 0.94, hi: 1.07, dy: 0.05, first: 1.1, bang: 1.1 },
  fl: { rot: 8, lo: 0.9, hi: 1.12, dy: 0.08, first: 1.16, bang: 1.26 },
  sub: { rot: 4, lo: 0.95, hi: 1.07, dy: 0.05, first: 1.08, bang: 1.2 },
  xp: { rot: 3, lo: 0.96, hi: 1.05, dy: 0.04, first: 1.06, bang: 1.1 },
};
// Russian (29.09): Cyrillic capitals (other language) read as lower-case when a letter comes out smaller than its
// neighbours (their shapes are the same in both cases, only the height differs — "(other language)"): the size jitter stays small
// there; the tilt and the baseline jitter are the same.
const JIT_RU = Object.fromEntries(Object.entries(JIT).map(([k, j]) => [k, { ...j, lo: 0.98, hi: 1.03, first: Math.min(j.first, 1.08) }]));
const jit = () => (lang() === 'ru' ? JIT_RU : JIT);
const XP_EM = 0.4;        // the "+25 XP" line's size (em of the word)
/** "+25 XP" ('' for nothing). */
export function xpWord(n) { const v = Math.round(+n || 0); return v > 0 ? `+${v} XP` : ''; }

/**
 * One line of letters: three stacked copies of the line (light rim, ink outline, gradient fill — so no letter's rim
 * covers its neighbour's fill; touching letters share one outline), each of `max` pooled letters that get the same
 * per-letter tilt / size / baseline on all three copies.
 */
function letterLine(cls, max) {
  const layers = [h('b.l0'), h('b.l1'), h('b.l2')];
  const el = h('div.hw-t.' + cls, {}, ...layers);
  const L = [];
  for (let i = 0; i < max; i++) {
    const cs = layers.map((b) => { const c = h('i.ch', { style: { display: 'none' } }); b.append(c); return c; });
    L.push({ cs, ch: null, on: false, tf: '' });
  }
  let last = null, lastSeed = -1;
  return {
    el,
    /** Text + a deterministic per-letter jitter (seed); writes only what changed. */
    set(t, seed, J) {
      t = String(t || '');
      if (t === last && seed === lastSeed) return;
      last = t; lastSeed = seed;
      const rnd = rng(seed);
      const n = Math.min(t.length, max);
      for (let i = 0; i < max; i++) {
        const q = L[i];
        if (i >= n) { if (q.on) { q.on = false; for (const c of q.cs) c.style.display = 'none'; } continue; }
        const ch = t[i];
        if (!q.on) { q.on = true; for (const c of q.cs) c.style.display = ''; }
        if (ch !== q.ch) {
          q.ch = ch;
          const s = ch === ' ' ? '' : ch, k = ch === ' ' ? 'ch sp' : ch === '!' ? 'ch bang' : 'ch';
          for (const c of q.cs) { c.textContent = s; c.className = k; }
        }
        const sc = ch === '!' ? J.bang : i === 0 ? J.first : J.lo + (J.hi - J.lo) * rnd();
        const rot = (rnd() * 2 - 1) * J.rot, dy = (rnd() * 2 - 1) * J.dy - (ch === '!' ? 0.04 : 0);
        const tf = ch === ' ' ? '' : `translateY(${dy.toFixed(3)}em) rotate(${rot.toFixed(1)}deg) scale(${sc.toFixed(2)})`;
        if (tf !== q.tf) { q.tf = tf; for (const c of q.cs) c.style.transform = tf; }
      }
    },
  };
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
/** px a word has risen at age t of life L (the last 0.3 s is its fade-out). */
const drift = (t, L) => { const h = Math.max(0.1, L - 0.3); return t < h ? 6 * t / h : 6 + 24 * Math.min(1, (t - h) / 0.3); };
// (names stay English on the actors — code tests them; the screen shows tr(name): ru-game.js has them)
const upper = (s) => tr(String(s || 'Shade Rider')).toUpperCase();

export class HitWords {
  /**
   * worldRoot: the HUD's world layer (words go on top of the damage numbers); retRoot: the flight HUD root (the
   * reticle burst goes above the reticle). opts: { game, markers (Markers, for the plate flash), comboNow() }.
   */
  constructor(worldRoot, retRoot, { game = null, markers = null, comboNow = null, enabled = true, pool = 6, bursts = 3 } = {}) {
    this.game = game; this.markers = markers; this.comboNow = comboNow;
    this.rules = { ...HIT_RULES };
    this.enabled = enabled;
    // world-HUD scale (hud.js: touch mode on a big screen, 2 at 4K): the words' size and every px estimate of the
    // reticle / plates / tag grow with it, so the placement stays true (1 = the desktop, as before)
    this.scale = 1;
    // touch mode (hud.js): a word's box includes its burst balloon (.hw-fx, 5.6 × 3.2 em; the kill's 6.4 × 3.8 em), so
    // the balloon too stays off the touch buttons, the PAUSE / FULLSCREEN pair and the panel (false = the desktop, as before)
    this.fxBox = false;
    this.reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.root = h('div.hwords');
    worldRoot.append(this.root);
    this.pool = [];
    for (let i = 0; i < pool; i++) {
      const fx = h('i.hw-fx'), starBk = h('i.hw-star.bk'), star = h('i.hw-star'), sl = h('i.hw-sl');
      const gl1 = h('i.hw-gl.g1'), gl2 = h('i.hw-gl.g2');
      const pre = letterLine('hw-pre', 8), main = letterLine('hw-main', 10), fl = letterLine('hw-fl', 8), sub = letterLine('hw-sub', 11), xp = letterLine('hw-xp', 12);
      const nm = h('span.hw-nm'), hpFill = h('i');
      const tag = h('div.hw-tag', {}, nm, h('div.hw-bar', {}, hpFill));
      const row = h('div.hw-row', {}, fx, sl, starBk, star, main.el, gl1, gl2, fl.el);
      const inner = h('div.hw-in', {}, pre.el, row, sub.el, xp.el, tag);
      const el = h('div.hw', { style: { opacity: '0' } }, inner);
      this.root.append(el);
      this.pool.push({ el, inner, row, fx, star, starBk, sl, gl1, gl2, pre, main, fl, sub, xp, tag, nm, hpFill, on: false, t: 0, life: 1, born: 0,
        kind: 'hit', cls: '', multi: 0, target: null, follow: false, off: new THREE.Vector3(), fixed: new THREE.Vector3(), x: 0, y: 0,
        fresh: true, fast: -1, fadeAt: -1, screen: false, sx: 0, sy: 0, side: 0, inherit: null, fs: 40, flLeft: false,
        txt: { pre: '', main: '', flav: '', sub: '', xp: '', flCls: '' }, en: { pre: '', main: '', flav: '', sub: '', xp: '' }, ox: 0, oy: 0, ext: [0, 0, 0, 0], bottom0: 0, preH: 0, subH: 0, xpH: 0, xpAnim: null,
        lift: 0, flash: null, tagOn: false, hpLast: -1, tf: '', op: '', anims: [], bump: null, seq: 0, fading: false });
    }
    this.bursts = [];
    for (let i = 0; i < bursts; i++) {
      const el = h('div.hwx', { style: { opacity: '0' } }, burstSVG());
      retRoot.append(el);
      this.bursts.push({ el, svg: el.firstChild, on: false, t: 0, life: 0.3, tf: '', op: '0', anim: null, rank: 0 });
    }
    this.nextBurst = 0;
    this.seq = 0;
    this.alive = 0;
    this.state = new WeakMap();        // target -> { confirm, fireTick, flavour, ticks, weakTicks }
    this.killInfo = new WeakMap();     // actor -> { kind, combo } from director:kill
    this.killRec = new WeakMap();      // actor -> the damage record that killed it
    this.pending = [];                 // player kills to spawn in the next update (after director:kill has run)
    this.flashes = [];                 // { target, t0, el, anims, hasPlate, frames }
    this.shots = [];                   // the player's recent fireball projectiles (direct / splash / charged)
    this.deadAt = new WeakMap();       // projectile -> sim time it was first seen detonated
    this.multi = null;                 // { g, seq, t0, targets: [], top } — the MULTI HIT! word being gathered
    this.lastWord = {};
    this.kindCache = new WeakMap();
    // XP for kills (levels): the progression's 'xp' events, by the actor they are for (or, without one, the next kill
    // within xpWindow); a kill word takes its line when it spawns, a live kill word when the XP comes later
    this.xpBy = new WeakMap();         // actor -> { amount, t }
    this.xpLoose = [];                 // [{ amount, t }] — XP for a kill whose actor the event did not name
    this.pr = { x: 0, y: 0, cx: 0, cy: 0, z: 0, onScreen: false };
    this.pr2 = { x: 0, y: 0, cx: 0, cy: 0, z: 0, onScreen: false };
    this._v = new THREE.Vector3(); this._a = new THREE.Vector3();
    this.stats = { hit: 0, direct: 0, charged: 0, crit: 0, kill: 0, combo: 0, multi: 0, rehit: 0, flavour: 0, bursts: 0, flashes: 0, tags: 0,
      afterburn: 0, throttled: 0, fastFaded: 0, offscreen: 0, lost: 0, shotMatched: 0, shotUnknown: 0, xp: 0, xpLate: 0 };
    /** The last 40 words spawned (tests): { t (sim s), word, pre, main, flavour, sub, kind, target (name), id, dist (m), size (px) } */
    this.log = [];
    /** The last 80 confirmations, one per hit that got one (tests): { t, id, how: 'word'|'multi'|'rehit'|'kill', word, seq (its group) } */
    this.confirms = [];
    // a language switch: the words that are up say it again in the new language
    try { this._offLang = onLang(() => this._relang()); } catch { /* no i18n */ }
  }

  /** The live groups re-lettered in the current language (their clocks, spots and animations stay). */
  _relang() {
    for (const g of this.pool) {
      if (!g.on) continue;
      this._lines(g);
      const s = g.seq * 7919;
      g.pre.set(g.txt.pre, s + 1, jit().pre); g.main.set(g.txt.main, s + 2, jit().main); g.fl.set(g.txt.flav, s + 3, jit().fl);
      g.sub.set(g.txt.sub, s + 4, jit().sub); g.xp.set(g.txt.xp, s + 5, jit().xp);
      this._setClass(g); this._measure(g);
      if (g.tagOn && g.target) g.nm.textContent = upper(g.target.name);
    }
  }
  /** g.en → g.txt in the current language. */
  _lines(g) { hitLines(g.en, g.txt); }

  /** Something to place (live words or kills waiting for the next update): hud.js measures its panels only then. */
  get busy() { return this.alive > 0 || this.pending.length > 0; }
  /** A kill word is up (not fading) or about to spawn: hud.js holds the level-up card for it on a portrait phone. */
  /** A kill word on screen at all (fading ones too) or waiting to be placed: a landscape phone's LEVEL UP! card waits
   *  for it (hud.js — no spot there clears both). */
  get killOn() {
    if (this.pending.length) return true;
    for (const g of this.pool) if (g.on && g.kind === 'kill') return true;
    return false;
  }
  get killUp() {
    if (this.pending.length) return true;
    for (const g of this.pool) if (g.on && g.kind === 'kill' && g.fast < 0 && g.fadeAt < 0 && g.t < g.life - 0.3) return true;
    return false;
  }
  _now() { return this.game?.time?.now ?? 0; }

  // ------------------------------------------------------------------------------------------------ events
  /** A 'damage' record whose source is the player (hud.js filters that). */
  onDamage(rec) {
    if (!this.enabled || !rec || !isEnemyDragon(rec.target)) return;
    const R = this.rules, now = this._now(), target = rec.target;
    if (rec.killed) {
      // the kill word takes over: no confirmation for the killing blow, the target's other words fade out
      this.killRec.set(target, rec);
      this._burst('kill');
      for (const g of this.pool) if (g.on && g.target === target && g.fast < 0) this._fade(g);
      return;
    }
    if (isAfterburn(rec)) { this.stats.afterburn++; return; }
    let st = this.state.get(target);
    if (!st) { st = { confirm: -99, fireTick: -99, flavour: -99, ticks: 0, weakTicks: 0 }; this.state.set(target, st); }
    const weak = isCrit(rec, R);
    if (rec.kind === 'fire') {
      const newBurst = now - st.fireTick > R.burstGap;
      st.fireTick = now;
      if (newBurst) { st.ticks = 0; st.weakTicks = 0; }
      st.ticks++; if (weak) st.weakTicks++;
      if (now - st.confirm < R.confirmEvery && !newBurst) { this.stats.throttled++; return; }
      if (now - st.confirm < R.confirmEvery * 0.5) { this.stats.throttled++; return; }      // a flicker in and out
      // weak point: this tick hit it and (on a held stream) most ticks since the last confirmation did too
      const crit = weak && (newBurst || st.weakTicks * 2 >= st.ticks);
      const flav = now - st.flavour >= R.flavourEvery ? 'fire' : '';
      st.confirm = now; st.ticks = 0; st.weakTicks = 0;
      if (this._hit(rec, crit ? 'crit' : 'hit', flav, 'f-fire', crit ? 'k-crit' : 'k-fire') === 'word' && flav) st.flavour = now;
      return;
    }
    if (rec.kind === 'fireball') {
      const proj = this._projFor(rec);
      this.stats[proj ? 'shotMatched' : 'shotUnknown']++;
      const kind = fireballKind(rec, proj, R);
      st.confirm = now;
      this._hit(rec, kind, 'fireball', 'f-fb', KIND_CLS[kind]);
      return;
    }
    // any other kind the player might deal later (a ram): a plain confirmation
    if (now - st.confirm < R.confirmEvery) { this.stats.throttled++; return; }
    st.confirm = now;
    this._hit(rec, weak ? 'crit' : 'hit', 'impact', 'f-fb', weak ? 'k-crit' : 'k-fb');
  }

  /** 'fireball' by the player: remember the projectile (its damage / charge tell a direct hit from its splash). */
  onShot(p) {
    if (!p || typeof p !== 'object' || this.shots.includes(p)) return;
    this.shots.push(p);
    if (this.shots.length > 12) this.shots.shift();
  }

  /** 'death': true when the words own this kill (hud.js then skips its own "DOWN!" / "×N COMBO" numbers). */
  onDeath(actor, killer, isPlayerKiller) {
    if (!this.enabled || !isEnemyDragon(actor) || !isPlayerKiller) return false;
    const rec = this.killRec.get(actor) || null;
    const p = (rec?.point || actor.pos);
    if (!p) return false;
    this.pending.push({ actor, pos: p.clone(), kind: rec?.kind || 'fire', t: this._now() });
    return true;
  }

  /** 'director:kill' { actor, kind: 'rider'|'ace'|'drake', combo } — the kind and the combo for the kill word. */
  onDirectorKill(e) { if (e?.actor) this.killInfo.set(e.actor, { kind: e.kind, combo: e.combo }); }

  /**
   * XP for a kill (hud.js hands over the progression's 'xp' event: amount, and the actor when the event names it).
   * A live kill word for that actor (or, without an actor, the youngest kill word without XP) gets the line now;
   * otherwise it waits for the kill word (the 'xp' event may come before the 'death' the word is made from).
   * Returns true when the words will show it (enabled).
   */
  onXp(actor, amount) {
    if (!this.enabled || !(amount > 0)) return false;
    const now = this._now();
    let g = null;
    for (const q of this.pool) {
      if (!q.on || q.kind !== 'kill' || q.txt.xp || q.fast >= 0 || q.t > 0.6) continue;
      if (actor ? q.target === actor : !g || q.seq > g.seq) g = q;
    }
    if (g) { this._setXp(g, amount, true); this.stats.xpLate++; return true; }
    if (actor && isEnemyDragon(actor)) {
      const prev = this.xpBy.get(actor);
      this.xpBy.set(actor, { amount: (prev && now - prev.t < 1 ? prev.amount : 0) + amount, t: now });
    } else {
      this.xpLoose.push({ amount, t: now });
      if (this.xpLoose.length > 6) this.xpLoose.shift();
    }
    return true;
  }
  /** The XP waiting for this kill (its own, else a loose one ≤ xpWindow old): the amount, 0 for none. */
  _takeXp(a) {
    const now = this._now(), win = this.rules.xpWindow ?? 0.8;
    const own = this.xpBy.get(a);
    if (own && now - own.t <= win + 0.4 && now >= own.t - 0.05) { this.xpBy.delete(a); return own.amount; }
    while (this.xpLoose.length && now - this.xpLoose[0].t > win) this.xpLoose.shift();
    const lo = this.xpLoose.shift();
    return lo ? lo.amount : 0;
  }
  /** The "+25 XP" line on a word (late: the word is already up — it pops in now, on the word's clock). */
  _setXp(g, amount, late = false) {
    const t0 = xpWord(amount);
    g.en.xp = t0; this._lines(g);
    const t = g.txt.xp;
    g.xp.set(t, g.seq * 7919 + 5, jit().xp);
    this._setClass(g);
    this._measure(g);
    if (t) this.stats.xp++;
    if (late && t && !this.reduced) {
      if (g.xpAnim) { g.xpAnim.a.cancel(); const i = g.anims.indexOf(g.xpAnim); if (i >= 0) g.anims.splice(i, 1); }
      g.xpAnim = this._anim(g, g.xp.el, [{ transform: 'scale(.3)', opacity: 0 }, { transform: 'scale(1.35) rotate(3deg)', opacity: 1, offset: 0.35 }, { transform: 'scale(1) rotate(1deg)', opacity: 1 }], 260, g.t);
    }
  }

  clear() {
    for (const g of this.pool) this._off(g);
    for (const b of this.bursts) { b.on = false; b.anim?.cancel(); b.anim = null; b.el.style.opacity = '0'; b.op = '0'; b.tf = ''; }
    for (const f of this.flashes) this._unflash(f);
    this.flashes.length = 0; this.pending.length = 0; this.shots.length = 0;
    this.state = new WeakMap();
    this.xpBy = new WeakMap(); this.xpLoose.length = 0;
    this.multi = null;
    this.alive = 0;
  }

  // ------------------------------------------------------------------------------------------------ fireballs
  /** The detonated player projectile a fireball damage record comes from (fire.js removes it just before the damage). */
  _projFor(rec) {
    let best = null, bd = Infinity;
    for (const p of this.shots) {
      if (p.alive !== false || !p.pos) continue;
      const d = rec.point ? p.pos.distanceToSquared(rec.point) : 0;
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) return null;
    const reach = (best.splashRadius || 10) + (rec.target?.radius || 12) + 30;
    return bd <= reach * reach ? best : null;
  }
  _pruneShots() {
    const now = this._now();
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const p = this.shots[i];
      if (p.alive !== false) continue;
      const t = this.deadAt.get(p);
      if (t === undefined) this.deadAt.set(p, now);
      else if (now - t > 0.5 || now < t) this.shots.splice(i, 1);
    }
  }

  // ------------------------------------------------------------------------------------------------ spawning
  _pick(list) {
    const L = WORDS[list] || WORDS.impact;
    const last = this.lastWord[list] ?? -1;
    let i = Math.floor(Math.random() * L.length);
    if (i === last) i = (i + 1 + Math.floor(Math.random() * (L.length - 1))) % L.length;
    this.lastWord[list] = i;
    this.stats.flavour++;
    return L[i];
  }

  _enemyKind(a) {
    let k = this.kindCache.get(a);
    if (k) return k;
    const pl = this.game?.enemies?.pilotOf?.(a) || null;
    k = pl?.kind === 'drake' || /drake|wyvern/i.test(a?.name || '') ? 'drake' : pl?.skillName === 'ace' || /\bace\b/i.test(a?.name || '') ? 'ace' : 'rider';
    this.kindCache.set(a, k);
    return k;
  }

  _confirm(target, how, g) {
    this.confirms.push({ t: +this._now().toFixed(3), id: target?.id ?? null, how, word: g?.el.dataset.word || '', seq: g?.seq ?? 0 });
    if (this.confirms.length > 80) this.confirms.shift();
  }

  /**
   * One confirmation. Returns how it was shown: 'multi' (merged into the MULTI HIT! word being gathered), 'rehit'
   * (a stronger word on this dragon took it), 'word' (a new word). flavList: 'fire' | 'fireball' | 'impact' | ''.
   */
  _hit(rec, kind, flavList, flCls, cls) {
    const R = this.rules, target = rec.target, now = this._now();
    const p = rec.point || target.pos;
    if (!p) return '';
    // hits on two or more dragons within multiWindow share one word: MULTI HIT! ×N (one flavour, one burst); each
    // dragon still gets its plate flash
    const M = this._multiFor(target, now);
    if (M) { this._merge(M, kind, cls, target); return 'multi'; }
    // this dragon's own word: a stronger one still young takes the weaker hit (re-hit), otherwise the new one replaces
    // it in the same spot
    let prev = null;
    for (const q of this.pool) if (q.on && q.fast < 0 && q.kind !== 'kill' && q.target === target) prev = q;
    if (prev && R.rank[prev.kind] > R.rank[kind] && prev.t < prev.life * R.keepFrac) {
      this._bump(prev);
      this._flash(target, prev);
      this._burst(burstOf(kind, cls));
      this.stats.rehit++;
      this._confirm(target, 'rehit', prev);
      return 'rehit';
    }
    let inherit = null;
    if (prev) { if (!prev.fresh) inherit = { x: prev.x, y: prev.y, g: prev }; this._fade(prev); }
    const g = this._take();
    g.target = target; g.follow = !!target.pos;
    if (g.follow) {
      g.off.copy(p).sub(target.pos);
      const r = Math.max(2, target.radius || 6);
      if (g.off.lengthSq() > r * r) g.off.setLength(r);
    } else g.fixed.copy(p);
    g.lift = Math.max(3, (target.radius || 8) * 0.45);
    this._fill(g, kind, cls, PRE_WORD[kind] || '', 'HIT!', flavList ? this._pick(flavList) : '', flCls, '', p);
    g.inherit = inherit;
    this._flash(target, g);
    this._burst(burstOf(kind, cls));
    this.stats[kind]++;
    this._confirm(target, 'word', g);
    return 'word';
  }

  /** The MULTI HIT! word to merge a hit on `target` into: the one being gathered, or a fresh word on another dragon. */
  _multiFor(target, now) {
    const R = this.rules;
    const M = this.multi;
    if (M && M.g.on && M.g.seq === M.seq && M.g.fast < 0 && now - M.t0 <= R.multiWindow) return M;
    this.multi = null;
    for (const q of this.pool) {
      if (!q.on || q.fast >= 0 || q.kind === 'kill' || !q.target || q.target === target || now - q.born > R.multiWindow) continue;
      this.multi = { g: q, seq: q.seq, t0: q.born, targets: [q.target], top: q.kind };
      return this.multi;
    }
    return null;
  }

  _merge(M, kind, cls, target) {
    const R = this.rules, g = M.g;
    const add = !M.targets.includes(target);
    if (add) M.targets.push(target);
    const up = R.rank[kind] > R.rank[M.top];
    if (up) M.top = kind;
    if (add || up) {
      g.kind = M.top;
      g.multi = M.targets.length;
      // the word stops being one dragon's: no name tag (every struck dragon's own plate flashes instead)
      if (g.flash && g.flash.group === g) g.flash.group = null;
      g.flash = null;
      const k = M.top === 'hit' ? (g.cls === 'k-fire' ? 'k-fire' : 'k-fb') : KIND_CLS[M.top] || g.cls;
      this._retext(g, PRE_WORD.multi, g.multi > 1 ? `HIT! ×${g.multi}` : 'HIT!', k);
      this._bump(g);
    }
    if (up) this._burst(burstOf(kind, cls));
    this._flash(target, g);
    if (add) this.stats.multi++;
    this._confirm(target, 'multi', g);
  }

  _kill(k) {
    const a = k.actor;
    const info = this.killInfo.get(a);
    const kind = info?.kind || this._enemyKind(a);
    let combo = typeof info?.combo === 'number' ? info.combo : 0;
    if (!info) { try { combo = this.comboNow?.() || 0; } catch { combo = 0; } }
    const flav = k.kind === 'fireball' ? this._pick('fireball') : k.kind === 'fire' ? this._pick('fire') : '';
    const g = this._take();
    g.target = a; g.follow = false; g.fixed.copy(k.pos); g.lift = 0;
    const sub = comboWord(combo);
    const xp = xpWord(this._takeXp(a));
    this._fill(g, 'kill', 'k-kill', '', KILL_WORD[kind] || KILL_WORD.rider, flav, k.kind === 'fireball' ? 'f-fb' : 'f-fire', sub, k.pos, xp);
    this.stats.kill++;
    if (sub) this.stats.combo++;
    this._confirm(a, 'kill', g);
  }

  /** A free group; with maxAlive already on screen the oldest one fades out fast. */
  _take() {
    const R = this.rules;
    let live = 0, oldest = null, oldestFading = null, free = null;
    for (const g of this.pool) {
      if (!g.on) { if (!free) free = g; continue; }
      if (g.fast >= 0) { if (!oldestFading || g.seq < oldestFading.seq) oldestFading = g; continue; }
      live++;
      if (!oldest || g.seq < oldest.seq) oldest = g;
    }
    if (live >= R.maxAlive && oldest) this._fade(oldest);
    const g = free || oldestFading || oldest;
    if (g.on) this._off(g);
    return g;
  }

  _fade(g) { if (g.fast < 0) { g.fast = g.t; this.stats.fastFaded++; } }

  _setClass(g) {
    const k = g.kind, t = g.txt;
    g.el.className = `hw ${g.cls}${t.pre ? ' pre' : ''}${t.flav ? ' fl' : ''}${t.sub ? ' sub' : ''}${t.xp ? ' xp' : ''}${g.flLeft ? ' fl-l' : ''}${k !== 'hit' ? ' big' : ' sl'}${k === 'crit' || k === 'kill' ? ' star' : ''}${g.multi ? ' multi' : ''}`;
    const word = [t.pre ? t.pre + ' ' + t.main : t.main, t.flav, t.sub, t.xp].filter(Boolean).join(' | ');
    if (g.el.dataset.word !== word) g.el.dataset.word = word;
  }

  _fill(g, kind, cls, pre, main, flav, flCls, sub, p, xp = '') {
    const R = this.rules, game = this.game;
    const cam = game?.camera;
    const dist = cam ? cam.position.distanceTo(p) : 150;
    const w = game?.size?.w || innerWidth, H = game?.size?.h || innerHeight;
    // (touch mode on a phone-size screen: the words shrink with it, down to 0.5 — at the desktop's floor of 0.7 a kill
    // word and its balloon (≈ 250 × 150 px) find no spot on a 390 px tall screen clear of the controls and the panel)
    const kScr = Math.min(w / 1440, H / 900);
    const scr = this.fxBox && kScr < 0.6 ? clamp(kScr * 1.15, 0.5, 0.7) : clamp(Math.sqrt(kScr), 0.7, 1.1);
    const ds = clamp(1.12 - dist / 1600, 0.85, 1.08);
    const fs = Math.round((R.size[kind] ?? R.size.hit) * ds * scr * (this.scale > 0 ? this.scale : 1));
    g.on = true; g.t = 0; g.fast = -1; g.fadeAt = -1; g.fresh = true; g.seq = ++this.seq;
    g.born = this._now();
    g.life = R.life[kind] ?? 0.8;
    g.kind = kind; g.cls = cls; g.multi = 0; g.fs = fs;
    g.screen = false; g.side = 0; g.inherit = null; g.ox = 0; g.oy = 0;
    // flavour on the side away from the nearer screen edge
    let sx = 0.5;
    if (cam) { project(cam, p, w, H, this.pr); if (this.pr.z > 0.5) sx = this.pr.x / w; }
    g.flLeft = sx > 0.6;
    g.en.pre = pre; g.en.main = main; g.en.flav = flav; g.en.sub = sub; g.en.xp = xp; g.txt.flCls = flCls;
    this._lines(g);
    g.xpAnim = null;
    this._setClass(g);
    const s = g.seq * 7919, T = g.txt;
    g.pre.set(T.pre, s + 1, jit().pre); g.main.set(T.main, s + 2, jit().main); g.fl.set(T.flav, s + 3, jit().fl); g.sub.set(T.sub, s + 4, jit().sub); g.xp.set(T.xp, s + 5, jit().xp);
    if (xp) this.stats.xp++;
    g.fl.el.className = 'hw-t hw-fl ' + flCls;
    g.inner.style.fontSize = fs + 'px';
    g.star.style.clipPath = g.starBk.style.clipPath = STARS[g.seq % STARS.length];
    g.tagOn = false; g.hpLast = -1; g.tag.style.display = 'none';
    this._measure(g);
    this._animate(g, kind, flav, sub, xp);
    this.alive = this.pool.reduce((n, q) => n + (q.on ? 1 : 0), 0);
    const entry = { t: +(g.born).toFixed(3), word: g.el.dataset.word, pre, main, flavour: flav, sub, kind, target: g.target?.name || null, id: g.target?.id ?? null, dist: Math.round(dist), size: fs };
    if (xp) entry.xp = xp;
    this.log.push(entry); if (this.log.length > 40) this.log.shift();
  }

  /** A live word turned into MULTI HIT! ×N (same group, same clock): new text, class and size estimate. */
  _retext(g, pre, main, cls) {
    g.en.pre = pre; g.en.main = main; g.cls = cls;
    this._lines(g);
    this._setClass(g);
    const s = g.seq * 7919;
    g.pre.set(g.txt.pre, s + 1, jit().pre); g.main.set(g.txt.main, s + 2, jit().main);
    g.tagOn = false; g.tag.style.display = 'none';
    this._measure(g);
    const t = g.en;
    const entry = { t: +this._now().toFixed(3), word: g.el.dataset.word, pre, main, flavour: t.flav, sub: t.sub, kind: g.kind, multi: g.multi, target: g.target?.name || null, id: g.target?.id ?? null, dist: null, size: g.fs };
    this.log.push(entry); if (this.log.length > 40) this.log.shift();
  }

  /** The estimated box (px) around the anchor = the centre of the main line: ext [left, top, right, bottom]. */
  _measure(g) {
    const fs = g.fs, { pre, main, flav, sub, xp } = g.txt, kind = g.kind;
    const mainW = (textEm(main) + (kind === 'kill' ? main.length * 0.02 : 0) + OUTLINE) * fs, lineH = fs * (0.92 + OUTLINE + JITTER);
    const preW = pre ? (textEm(pre) + pre.length * 0.11 + OUTLINE) * fs * 0.5 : 0, preH = pre ? fs * 0.5 * (0.92 + OUTLINE + JITTER) + fs * 0.01 : 0;
    const subW = sub ? (textEm(sub) + sub.length * 0.03 + OUTLINE) * fs * 0.62 : 0, subH = sub ? fs * 0.62 * (0.92 + OUTLINE + JITTER) + fs * 0.06 : 0;
    const flW = flav ? (textEm(flav) + OUTLINE) * fs * 0.54 + fs * 0.22 : 0;
    const xpW = xp ? (textEm(xp) + xp.length * 0.05 + OUTLINE) * fs * XP_EM : 0, xpH = xp ? fs * XP_EM * (0.92 + OUTLINE + JITTER) + fs * 0.05 : 0;
    const half = Math.max(mainW, preW, subW, xpW) / 2;
    g.ext[0] = Math.max(half, mainW / 2 + (g.flLeft ? flW : 0));
    g.ext[2] = Math.max(half, mainW / 2 + (g.flLeft ? 0 : flW));
    g.ext[1] = lineH / 2 + preH + (flav ? fs * 0.25 : 0);
    // the burst balloon (crit, kill) reaches 1.02 / 1.13 em below the main line's centre
    const star = kind === 'crit' ? 1.02 * fs : kind === 'kill' ? 1.13 * fs : 0;
    g.ext[3] = g.bottom0 = Math.max(lineH / 2 + subH + xpH, star);
    if (star) g.ext[1] = Math.max(g.ext[1], star);
    if (this.fxBox && kind !== 'hit') {
      // the balloon's half size (2.8 × 1.6 em; the kill's 3.2 × 1.9) as it really gets: it grows to 1.3× while it fades
      // (still visible near the end), turns 7° inside a word turned ≤ 8° and skewed ≤ 12° (a rotated ellipse: 2.8 →
      // 3.08, 1.6 → 1.71 em; the kill's 3.2 → 3.5, 1.9 → 2.03), and a re-hit kicks the whole row ×1.3 for 0.1 s
      // (fix 29.09: the 4K / 1366 audits caught the fading crit balloon 4 px into the panel with the old × 1.25)
      const FX = FX_BOX;
      const fx = kind === 'kill' ? [3.5 * FX, 2.03 * FX] : [3.08 * FX, 1.71 * FX];
      g.ext[0] = Math.max(g.ext[0], fx[0] * fs); g.ext[2] = Math.max(g.ext[2], fx[0] * fs);
      g.ext[1] = Math.max(g.ext[1], fx[1] * fs); g.ext[3] = g.bottom0 = Math.max(g.ext[3], fx[1] * fs);
    }
    // the block (flex column: pre, main, sub, tag) is centred on the element's origin; the main line's centre sits
    // (preH − subH − tagH) / 2 below the block's centre
    g.preH = preH; g.subH = subH; g.xpH = xpH;
  }

  /** A paused Web Animation that the group's clock drives (t0: group seconds it starts at). */
  _anim(g, node, frames, dur, t0 = 0) {
    const a = node.animate(frames, { duration: dur, fill: 'both' });
    try { a.pause?.(); a.currentTime = 0; } catch { /* ignore */ }
    const e = { a, t0, d: dur, done: false };
    g.anims.push(e);
    return e;
  }
  _tick(g) {
    for (const e of g.anims) {
      if (e.done) continue;
      const ms = (g.t - e.t0) * 1000;
      if (ms < 0) continue;
      if (ms >= e.d) { e.a.currentTime = e.d; e.done = true; } else e.a.currentTime = ms;
    }
  }

  /** A kick for a word that just took another hit (a re-hit, a merge into MULTI HIT!). */
  _bump(g) {
    if (g.bump) { g.bump.a.cancel(); const i = g.anims.indexOf(g.bump); if (i >= 0) g.anims.splice(i, 1); }
    g.bump = this.reduced ? null
      : this._anim(g, g.row, [{ transform: 'scale(1.3) rotate(-3deg)' }, { transform: 'scale(.94) rotate(1deg)', offset: 0.45 }, { transform: 'scale(1)' }], 220, g.t);
  }

  _animate(g, kind, flav, sub, xp = '') {
    for (const e of g.anims) e.a.cancel();
    g.anims.length = 0; g.bump = null;
    const L = g.life, ms = L * 1000;
    const rot = (Math.random() * 2 - 1) * (kind === 'hit' ? 6 : 8);
    const skew = -(6 + Math.random() * 6);
    const o = (sec) => clamp(sec / L, 0, 1);
    // the drift up while it fades is part of the placement (update(): keep-outs see it), not of this animation
    const tf = (sc, jx = 0) => `translate(-50%, -50%) translate(${jx}px, 0px) rotate(${rot.toFixed(1)}deg) skewX(${skew.toFixed(1)}deg) scale(${sc})`;
    const shake = !this.reduced && (kind === 'crit' || kind === 'kill');
    const frames = this.reduced
      ? [{ transform: tf(0.9), opacity: 0, offset: 0 }, { transform: tf(1), opacity: 1, offset: o(0.1) }, { transform: tf(1), opacity: 1, offset: o(L - 0.3) }, { transform: tf(1), opacity: 0, offset: 1 }]
      : [
        { transform: tf(0.35), opacity: 0.3, offset: 0, easing: 'cubic-bezier(.2, .9, .4, 1)' },
        { transform: tf(1.2), opacity: 1, offset: o(0.06), easing: 'ease-out' },
        { transform: tf(1), opacity: 1, offset: o(0.12) },
        ...(shake ? [{ transform: tf(1, -4), opacity: 1, offset: o(0.15) }, { transform: tf(1, 3), opacity: 1, offset: o(0.18) }, { transform: tf(1, 0), opacity: 1, offset: o(0.21) }] : []),
        { transform: tf(1), opacity: 1, offset: o(L - 0.3), easing: 'ease-in' },
        { transform: tf(0.96), opacity: 0, offset: 1 },
      ];
    this._anim(g, g.inner, frames, ms);
    if (flav) {
      const fr = (kind === 'hit' ? 10 : 14) * (Math.random() < 0.5 ? 1 : -1) - rot * 0.5;
      const ft = (sc) => `rotate(${fr.toFixed(1)}deg) scale(${sc})`;
      this._anim(g, g.fl.el, this.reduced
        ? [{ transform: ft(1), opacity: 1 }, { transform: ft(1), opacity: 1 }]
        : [{ transform: ft(0.2), opacity: 0 }, { transform: ft(0.2), opacity: 0, offset: 0.08 }, { transform: ft(1.25), opacity: 1, offset: 0.16 }, { transform: ft(1), opacity: 1, offset: 0.24 }, { transform: ft(1.04), opacity: 1 }], ms);
    }
    if (sub) {
      this._anim(g, g.sub.el, this.reduced
        ? [{ opacity: 1 }, { opacity: 1 }]
        : [{ transform: 'scale(.3)', opacity: 0 }, { transform: 'scale(.3)', opacity: 0, offset: 0.13 }, { transform: 'scale(1.3) rotate(-4deg)', opacity: 1, offset: 0.2 }, { transform: 'scale(1) rotate(-2deg)', opacity: 1, offset: 0.27 }, { transform: 'scale(1) rotate(-2deg)', opacity: 1 }], ms);
    }
    if (xp) {
      // the XP line pops in a beat after the kill word (and its combo line)
      g.xpAnim = this._anim(g, g.xp.el, this.reduced
        ? [{ opacity: 1 }, { opacity: 1 }]
        : [{ transform: 'scale(.3)', opacity: 0 }, { transform: 'scale(.3)', opacity: 0, offset: 0.17 }, { transform: 'scale(1.35) rotate(3deg)', opacity: 1, offset: 0.25 }, { transform: 'scale(1) rotate(1deg)', opacity: 1, offset: 0.32 }, { transform: 'scale(1) rotate(1deg)', opacity: 1 }], ms);
    }
    // two hard white glints twinkle on the letters after the pop
    if (!this.reduced) {
      const gl = [{ transform: 'scale(0) rotate(0deg)', opacity: 0 }, { transform: 'scale(0) rotate(0deg)', opacity: 0, offset: 0.2 }, { transform: 'scale(1.35) rotate(45deg)', opacity: 1, offset: 0.4 }, { transform: 'scale(.8) rotate(80deg)', opacity: 1, offset: 0.75 }, { transform: 'scale(0) rotate(100deg)', opacity: 0 }];
      this._anim(g, g.gl1, gl, 560, 0.05);
      this._anim(g, g.gl2, gl, 560, 0.13);
    }
    // HIT!: a short wedge of speed lines on the side away from the flavour (the big words have focus lines)
    if (!this.reduced && kind === 'hit') {
      this._anim(g, g.sl, [{ transform: 'scaleX(.15)', opacity: 0 }, { transform: 'scaleX(1.1)', opacity: 1, offset: 0.2 }, { transform: 'scaleX(1)', opacity: 0.9, offset: 0.5 }, { transform: 'scaleX(1.05)', opacity: 0 }], 440);
    }
    if (!this.reduced && kind !== 'hit') {
      const d = kind === 'kill' ? 620 : 440;
      this._anim(g, g.fx, [{ transform: 'scale(.5) rotate(0deg)', opacity: 0 }, { transform: 'scale(1) rotate(3deg)', opacity: 1, offset: 0.22 }, { transform: 'scale(1.3) rotate(7deg)', opacity: 0 }], d);
    }
    if (kind === 'crit' || kind === 'kill') {
      const d = kind === 'kill' ? 760 : 520;
      const st = this.reduced ? [{ opacity: 0.9 }, { opacity: 0 }]
        : [{ transform: 'scale(.2) rotate(-12deg)', opacity: 1 }, { transform: 'scale(1.1) rotate(0deg)', opacity: 1, offset: 0.22 }, { transform: 'scale(1) rotate(2deg)', opacity: 0.95, offset: 0.55 }, { transform: 'scale(1.06) rotate(3deg)', opacity: 0 }];
      this._anim(g, g.star, st, d);
      this._anim(g, g.starBk, st, d);
    }
    this._tick(g);
  }

  _off(g) {
    g.on = false; g.target = null; g.fast = -1; g.fadeAt = -1; g.inherit = null; g.multi = 0; g.xpAnim = null;
    for (const e of g.anims) e.a.cancel();
    g.anims.length = 0; g.bump = null;
    if (g.flash && g.flash.group === g) g.flash.group = null;
    g.flash = null;
    if (this.multi?.g === g) this.multi = null;
    if (g.op !== '0') { g.op = '0'; g.el.style.opacity = '0'; }
  }

  /** The reticle burst. type: 'fire' | 'fb' | 'chg' | 'crit' | 'kill'. */
  _burst(type) {
    const b = this.bursts[this.nextBurst]; this.nextBurst = (this.nextBurst + 1) % this.bursts.length;
    b.on = true; b.t = 0;
    b.life = type === 'kill' ? 0.5 : type === 'crit' || type === 'chg' ? 0.36 : 0.28;
    b.el.className = 'hwx ' + type;
    b.anim?.cancel();
    const big = type === 'kill' ? 1.7 : type === 'crit' || type === 'chg' ? 1.55 : 1.4;
    const r = (Math.random() * 2 - 1) * 8;
    b.anim = b.svg.animate(this.reduced
      ? [{ opacity: 1 }, { opacity: 0 }]
      : [{ transform: `rotate(${r}deg) scale(${big})`, opacity: 1 }, { transform: `rotate(${r * 0.3}deg) scale(1)`, opacity: 1, offset: 0.35 }, { transform: 'scale(.96)', opacity: 0 }],
    { duration: b.life * 1000, easing: 'ease-out', fill: 'both' });
    try { b.anim.pause?.(); b.anim.currentTime = 0; } catch { /* ignore */ }
    this.stats.bursts++;
  }

  // ------------------------------------------------------------------------------------------------ plate flash
  _flash(target, g) {
    let f = this.flashes.find((x) => x.target === target);
    if (f) this._unflash(f);
    else { f = { target, t0: 0, el: null, anims: [], hasPlate: false, frames: 0, group: null }; this.flashes.push(f); }
    if (f.group && f.group.flash === f) f.group.flash = null;
    f.t0 = performance.now(); f.frames = 0; f.el = null; f.hasPlate = false;
    // a MULTI HIT! word belongs to no single dragon: it carries no name tag
    f.group = g && !g.multi ? g : null;
    if (f.group) g.flash = f;
    this.stats.flashes++;
  }
  _unflash(f) { for (const a of f.anims) a.cancel(); f.anims.length = 0; f.el = null; }

  /** Per frame: bind each flash to whichever full plate shows its dragon right now (plates can swap slots). */
  _updateFlashes() {
    const R = this.rules, nowMs = performance.now();
    const pool = this.markers?.pool || [];
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      const age = nowMs - f.t0;
      if (age > R.flash * 1000 || !f.target?.alive) { this._unflash(f); if (f.group && f.group.flash === f) f.group.flash = null; this.flashes.splice(i, 1); continue; }
      f.frames++;
      let m = null;
      for (const q of pool) if (q.actor === f.target && q.last?.op !== '0') { m = q; break; }
      const el = m ? m.name.parentNode : null;
      if (el !== f.el) {
        this._unflash(f);
        f.el = el;
        if (m) {
          const dur = R.flash * 1000;
          const at = Math.min(age, dur - 1);
          const run = (node, frames, d = dur) => { if (at >= d) return; const a = node.animate(frames, { duration: d, fill: 'none' }); a.currentTime = at; f.anims.push(a); };
          run(el, [{ transform: 'translateX(-50%) scale(1.32)' }, { transform: 'translateX(-50%) scale(1)', offset: 0.25 }, { transform: 'translateX(-50%) scale(1)' }], 360);
          run(m.name, [{ backgroundColor: 'rgba(255, 246, 214, .98)', color: '#3a0a08' }, { backgroundColor: 'rgba(255, 196, 64, .95)', color: '#2a0806', offset: 0.14 },
            { backgroundColor: 'rgba(232, 60, 40, .9)', color: '#fff', offset: 0.4 }, { backgroundColor: 'rgba(14, 8, 26, .46)', color: '#ffe4e4' }]);
          run(m.fill.parentNode, [{ transform: 'skewX(-24deg) scaleY(2.1)', borderColor: '#fff' }, { transform: 'skewX(-24deg) scaleY(1)', borderColor: '#ffd36a', offset: 0.22 },
            { transform: 'skewX(-24deg) scaleY(1)', borderColor: 'rgba(255, 255, 255, .6)' }]);
        }
      }
      f.hasPlate = !!m;
    }
  }

  // ------------------------------------------------------------------------------------------------ per frame
  /**
   * The word's dragon (or kill point) is gone from view: a word that was already up freezes where it is and fades
   * after minShow; a word that is only now spawning goes beside the reticle, on the side of its dragon (with the name
   * + HP tag). Never pinned to the screen edge pointing at nothing.
   */
  _toScreen(g, pr, ret, w, hgt) {
    const R = this.rules;
    g.screen = true; g.follow = false;
    if (g.fresh) {
      const cx = ret?.visible ? ret.x : w / 2, cy = ret?.visible ? ret.y : hgt * 0.45;
      let dx = pr.cx, dy = -pr.cy;                       // behind the camera: its bearing in camera space
      if (pr.z > 0.5) { dx = pr.x - cx; dy = pr.y - cy; }
      const d = Math.hypot(dx, dy);
      const ux = d > 1e-3 ? dx / d : 0.8, uy = d > 1e-3 ? dy / d : -0.6;
      const E = g.ext, reach = R.reticle.r + 24 + Math.abs(ux) * (ux > 0 ? E[0] : E[2]) + Math.abs(uy) * (uy > 0 ? E[1] : E[3]);
      g.sx = cx + ux * reach; g.sy = cy + uy * reach;
      this.stats.offscreen++;
    } else {
      g.sx = g.x; g.sy = g.y + (this.reduced ? 0 : drift(g.t, g.life)); g.ox = 0; g.oy = 0;
      if (g.t >= R.minShow) this._fade(g); else g.fadeAt = R.minShow;
      this.stats.lost++;
    }
  }

  /**
   * dt: real seconds (0 while paused: the words wait); cam; w × hgt px; ret: the reticle as the HUD placed it
   * { x, y, visible }; avoid: hard keep-out rects [[l, t, r, b], …] (the speed / altitude readouts); warn: the warning
   * pill is up (the words stay under it); panels: rects the words avoid unless nothing else is free (the objective
   * panel, the kill feed — a portrait phone has no room left beside a wide kill word otherwise).
   */
  update(dt, cam, w, hgt, ret, avoid, warn = false, panels = null) {
    if (this.pending.length) { for (const k of this.pending) this._kill(k); this.pending.length = 0; }
    if (this.flashes.length) this._updateFlashes();
    if (this.shots.length) this._pruneShots();
    for (const b of this.bursts) {
      if (!b.on) continue;
      b.t += dt;
      if (b.t >= b.life || !ret?.visible) { b.on = false; b.anim?.cancel(); b.anim = null; b.op = '0'; b.el.style.opacity = '0'; b.tf = ''; continue; }
      const tf = `translate3d(${ret.x.toFixed(1)}px, ${ret.y.toFixed(1)}px, 0)`;
      if (tf !== b.tf) { b.tf = tf; b.el.style.transform = tf; }
      if (b.op !== '1') { b.op = '1'; b.el.style.opacity = '1'; }
      if (b.anim) b.anim.currentTime = Math.min(b.t, b.life) * 1000;
    }
    if (!this.alive) return;
    const S = this.scale > 0 ? this.scale : 1;
    const R = this.rules, pr = this.pr, pr2 = this.pr2, V = this._v;
    const insB = w < 600 && hgt > w ? R.inset.phone : R.inset.wide;
    const ins0 = S === 1 ? insB : (this._insS || (this._insS = {}));
    if (ins0 !== insB) { ins0.t = insB.t * S; ins0.b = insB.b * S; ins0.s = insB.s * S; }
    const ins = warn && ins0.t < R.warnTop * S ? (this._insW || (this._insW = {})) : ins0;
    if (ins !== ins0) { ins.t = R.warnTop * S; ins.b = ins0.b; ins.s = ins0.s; }
    let alive = 0;
    const placed = this._placed || (this._placed = []);
    placed.length = 0;
    const order = this._order || (this._order = []);
    order.length = 0;
    for (const g of this.pool) if (g.on) { g.fading = g.fast >= 0 || g.fadeAt >= 0 || g.t > g.life - 0.3; order.push(g); }
    // live words by rank (kill > crit > charged > direct > hit), the newest first within a rank; the fading ones last
    // and they push nothing aside (a new confirmation takes its spot, not the ghost of the last one)
    order.sort((a, b) => (a.fading - b.fading) || (R.rank[b.kind] - R.rank[a.kind]) || (b.seq - a.seq));
    // the other dragons' full name plates on screen (soft keep-outs: a word avoids covering them when it can)
    const plates = this._plates || (this._plates = []);
    let np = 0;
    const lockT = this.game?.cameraRig?.lockTarget;
    for (const m of this.markers?.pool || []) {
      const a = m.actor;
      if (!a || !a.alive || !a.pos || a.kind === 'titan' || m.last?.op === '0') continue;
      this._a.copy(a.pos); this._a.y += Math.max(3, (a.radius || 8) * 0.45);
      project(cam, this._a, w, hgt, pr, 0);
      if (!pr.onScreen) continue;
      const q = plates[np] || (plates[np] = [0, 0, 0, 0, null]);
      const half = Math.max(46, (a.name ? tr(String(a.name)) : '').length * 4.5 + 6) * S, top = (a === lockT ? 72 : 58) * S;
      q[0] = pr.x - half; q[1] = pr.y - top; q[2] = pr.x + half; q[3] = pr.y + 4; q[4] = a;
      np++;
    }
    // Sora on screen (soft: a word, a kill word above all, slides off the player's dragon when it can): the body
    // column (head to tail) and the wing band, in units of its radius projected (rp) around its centre — measured on
    // the chase view's mesh (radius 11 m at 19 m: rp ≈ 435 px; head top −0.21 rp, wings ±0.72 rp, −0.21…+0.09 rp)
    const me = this._me || (this._me = [0, 0, 0, 0]), me2 = this._me2 || (this._me2 = [0, 0, 0, 0]);
    let meOn = false;
    const pa = this.game?.player?.actor || null;
    if (pa?.pos && cam.isPerspectiveCamera) {
      project(cam, pa.pos, w, hgt, pr, 0);
      if (pr.z > 0.5) {
        const rp = (pa.radius || 8) * (hgt / 2 / Math.tan(cam.fov * Math.PI / 360)) / pr.z;
        me[0] = pr.x - rp * 0.16; me[1] = pr.y - rp * 0.28; me[2] = pr.x + rp * 0.16; me[3] = pr.y + rp * 0.6;
        me2[0] = pr.x - rp * 0.72; me2[1] = pr.y - rp * 0.24; me2[2] = pr.x + rp * 0.72; me2[3] = pr.y + rp * 0.12;
        meOn = true;
      }
    }
    const RR0 = w <= 600 ? R.reticleNarrow : R.reticle, rOn = !!ret?.visible, P = 1.12;
    const RR = S === 1 ? RR0 : (this._rrS || (this._rrS = {}));
    if (RR !== RR0) { RR.r = RR0.r * S; RR.below = RR0.below * S; RR.pad = RR0.pad * S; }
    const rl = rOn ? ret.x - RR.r : 0, rr = rOn ? ret.x + RR.r : 0, rt = rOn ? ret.y - RR.r : 0, rb = rOn ? ret.y + RR.r + RR.below : 0;
    for (const g of order) {
      g.t += dt;
      if (g.fadeAt >= 0 && g.t >= g.fadeAt) { g.fadeAt = -1; this._fade(g); }
      if (g.t >= g.life || (g.fast >= 0 && g.t - g.fast >= R.fastFade)) { this._off(g); continue; }
      alive++;
      this._tick(g);
      const a = g.target, E = g.ext;
      // anchor: the struck dragon (it keeps flying; the word stays on it) or the kill point — unless it left the view
      if (!g.screen) {
        if (g.follow && a?.pos) V.copy(a.pos).add(g.off); else V.copy(g.fixed);
        project(cam, V, w, hgt, pr, R.offMargin);
        let gone = !pr.onScreen;
        if (!gone && g.follow && a?.pos) {
          // the dragon itself: its centre off the screen too, or passing the lens
          gone = cam.position.distanceToSquared(a.pos) < R.nearCam * R.nearCam || !project(cam, a.pos, w, hgt, pr2, R.offMargin).onScreen;
        }
        if (gone) this._toScreen(g, pr, ret, w, hgt);
      }
      // no full plate for this dragon (a mini marker, off screen, or the plate pool is full): a compact name + HP tag
      const f = g.flash;
      const wantTag = !!f && f.frames >= 2 && !f.hasPlate && !!a?.alive;
      if (wantTag !== g.tagOn) {
        g.tagOn = wantTag; g.tag.style.display = wantTag ? '' : 'none';
        if (wantTag) { g.nm.textContent = upper(a.name); this.stats.tags++; }
      }
      if (wantTag) {
        const hp = a.maxHp > 0 ? clamp(a.hp / a.maxHp, 0, 1) : 1;
        const q = Math.round(hp * 100);
        if (q !== g.hpLast) { g.hpLast = q; g.hpFill.style.transform = `scaleX(${(q / 100).toFixed(2)})`; }
      }
      const tagH = g.tagOn ? TAG_H * S : 0;
      E[3] = g.bottom0 + tagH;
      let x, y, pl = null;
      if (g.screen) { x = g.sx; y = g.sy; }
      else {
        x = pr.x; y = pr.y;
        if (g.follow && a?.pos) {
          // above the dragon's name plate (a full plate reaches ≈ 58 px over its anchor = pos + lift, 72 px when
          // locked); the plate itself is a keep-out while the dragon has one. A dragon so near that the plate is far
          // above the hit point (> sideGap): the word goes beside the hit point instead, just past the reticle
          const plate = (a === lockT ? 72 : 58) * S;
          this._a.copy(a.pos); this._a.y += g.lift;
          project(cam, this._a, w, hgt, pr2, 0);
          const top = pr2.z > 0.5 ? Math.min(y, pr2.y - plate) : y - plate;
          if (pr2.z > 0.5 && f?.hasPlate) {
            const half = Math.max(46, (a.name ? tr(String(a.name)) : '').length * 4.5 + 6) * S;
            pl = this._pl || (this._pl = [0, 0, 0, 0]);
            // + 5 px: the word's tilt (≤ 12°) widens its box beyond the estimate
            pl[0] = pr2.x - half - 5; pl[1] = pr2.y - plate - 5; pl[2] = pr2.x + half + 5; pl[3] = pr2.y + 4;
          }
          if (!g.side) {
            g.side = y - top > R.sideGap * S ? (x >= (rOn ? ret.x : w / 2) ? 1 : -1) : 2;
            // beside the reticle the flavour goes on the outer side (the confirmation itself next to the reticle)
            if (g.side !== 2 && g.txt.flav && g.flLeft !== (g.side < 0)) { g.flLeft = g.side < 0; this._setClass(g); this._measure(g); E[3] = g.bottom0 + tagH; }
          }
          if (g.side === 2) y = top - E[3] - 4;           // the word's bottom edge 4 px over the plate
          else { x += g.side * (RR.r + RR.pad + (g.side > 0 ? E[0] : E[2]) * P); y -= 12; }
        } else y -= 26 + E[3] + 4;                       // a kill word: over the kill point
      }
      if (!this.reduced) y -= drift(g.t, g.life);        // then it rises: 6 px while it holds, 24 px more while it fades
      // its natural spot moves rigidly with the dragon; only a detour around a keep-out (its offset) glides
      const ax = x, ay = y;
      const fading = g.fading || g.fast >= 0;
      // keep-outs: the reticle (its box + the IN RANGE label; the word's box grows by the 1.2× pop) and the readouts
      // are hard; the objective and the kill feed (30), stronger / newer live words, its own plate, Sora's body (10)
      // and wings (4), other plates (1) are soft.
      // Candidates: where it wants to be, above / below / beside the reticle, beside or over / under a readout, a
      // word, a plate or Sora — each kept inside the screen; the nearest one clear of everything wins (a little
      // stickiness to where it is now, so it does not flip between two), else the nearest clear of the hard ones.
      const hard = (px, py) => {
        if (rOn && px + E[2] * P > rl && px - E[0] * P < rr && py + E[3] * P > rt && py - E[1] * P < rb) return true;
        if (avoid) for (const r of avoid) if (r && px + E[2] > r[0] && px - E[0] < r[2] && py + E[3] > r[1] && py - E[1] < r[3]) return true;
        return false;
      };
      const over = (q, px, py, k = 1) => px + E[2] * k > q[0] && px - E[0] * k < q[2] && py + E[3] * k > q[1] && py - E[1] * k < q[3];
      // nearby plates of other dragons (within 260 px of the natural spot): a tenth of the weight of a word / its own plate
      const near = this._near || (this._near = []);
      near.length = 0;
      for (let i = 0; i < np; i++) { const q = plates[i]; if (q[4] !== a && q[0] < x + E[2] + 260 && q[2] > x - E[0] - 260 && q[1] < y + E[3] + 260 && q[3] > y - E[1] - 260) near.push(q); }
      const soft = (px, py) => {
        let n = pl && over(pl, px, py, P) ? 10 : 0;
        if (!fading) for (const q of placed) if (over(q, px, py)) n += 10;
        for (const q of near) if (over(q, px, py)) n++;
        if (meOn) { if (over(me, px, py)) n += R.playerSoft; else if (over(me2, px, py)) n += R.wingSoft; }
        if (panels) for (const q of panels) if (q && over(q, px, py)) n += q[4] > 0 ? q[4] : R.panelSoft;
        return n;
      };
      // how bad a spot is for a glide: 2 on the reticle / a readout, 1 on its dragon's plate, 0 clear
      const bad = (px, py) => (hard(px, py) ? 2 : pl && over(pl, px, py, P) ? 1 : 0);
      // inside the screen, with room for the 1.2× pop
      const xmin = ins.s + E[0] * P, xmax = Math.max(xmin, w - ins.s - E[2] * P), ymin = ins.t + E[1], ymax = Math.max(ymin, hgt - ins.b - E[3]);
      const xs = this._xs || (this._xs = []), ys = this._ys || (this._ys = []);
      xs.length = 0; ys.length = 0;
      xs.push(x); ys.push(y);
      const inh = g.fresh ? g.inherit : null;          // a replaced word's spot: the new one pops where the old one was
      if (inh) { xs.push(inh.x); ys.push(inh.y); }
      if (rOn) { xs.push(rl - RR.pad - E[2] * P, rr + RR.pad + E[0] * P); ys.push(rt - RR.pad - E[3] * P, rb + RR.pad + E[1] * P); }
      if (avoid) for (const r of avoid) if (r) { xs.push(r[0] - E[2] - 4, r[2] + E[0] + 4); ys.push(r[1] - E[3] - 4, r[3] + E[1] + 4); }
      if (!fading) for (const q of placed) ys.push(q[1] - E[3] - 2, q[3] + E[1] + 2);
      if (pl) { xs.push(pl[0] - E[2] * P - 4, pl[2] + E[0] * P + 4); ys.push(pl[1] - E[3] * P - 4, pl[3] + E[1] * P + 4); }
      for (const q of near) { xs.push(q[0] - E[2] - 4, q[2] + E[0] + 4); ys.push(q[1] - E[3] - 4, q[3] + E[1] + 4); }
      if (meOn) { xs.push(me[0] - E[2] - 4, me[2] + E[0] + 4, me2[0] - E[2] - 4, me2[2] + E[0] + 4); ys.push(me[1] - E[3] - 4, me2[1] - E[3] - 4); }
      if (panels) for (const q of panels) if (q) { xs.push(q[0] - E[2] - 4, q[2] + E[0] + 4); ys.push(q[1] - E[3] - 4, q[3] + E[1] + 4); }
      let bx = clamp(x, xmin, xmax), by = clamp(y, ymin, ymax), bs = Infinity;
      const stick = fading ? 2 : 0.5;
      for (const cx0 of xs) for (const cy0 of ys) {
        const cx = clamp(cx0, xmin, xmax), cy = clamp(cy0, ymin, ymax);
        if (hard(cx, cy)) continue;
        let sc;
        if (inh) { const dx = cx - inh.x, dy = cy - inh.y; sc = 0.3 * ((cx - x) * (cx - x) + (cy - y) * (cy - y)) + dx * dx + dy * dy; }
        else sc = (cx - x) * (cx - x) + (cy - y) * (cy - y);
        if (!g.fresh) { const dx = cx - ax - g.ox, dy = cy - ay - g.oy; sc += stick * (dx * dx + dy * dy); }
        sc += soft(cx, cy) * 1e6;
        if (sc < bs) { bs = sc; bx = cx; by = cy; }
      }
      x = bx; y = by;
      if (g.fresh) { g.ox = x - ax; g.oy = y - ay; g.fresh = false; g.inherit = null; }
      else {
        const k = 1 - Math.exp(-18 * Math.min(0.1, dt));
        const ox = g.ox + (x - ax - g.ox) * k, oy = g.oy + (y - ay - g.oy) * k;
        // gliding may never cross the reticle, a readout or its dragon's plate: then it jumps to its place
        const gx = clamp(ax + ox, xmin, xmax), gy = clamp(ay + oy, ymin, ymax);
        if (bad(gx, gy) > bad(x, y)) { g.ox = x - ax; g.oy = y - ay; } else { g.ox = ox; g.oy = oy; }
      }
      // inside the screen (a word never follows its dragon out: _toScreen freezes it first)
      g.x = clamp(ax + g.ox, xmin, xmax); g.y = clamp(ay + g.oy, ymin, ymax);
      if (bad(g.x, g.y) > bad(x, y)) { g.x = x; g.y = y; g.ox = x - ax; g.oy = y - ay; }
      if (!fading) placed.push([g.x - E[0], g.y - E[1], g.x + E[2], g.y + E[3]]);
      const op = g.fast >= 0 ? clamp(1 - (g.t - g.fast) / R.fastFade, 0, 1).toFixed(2) : '1';
      this._write(g, `translate3d(${g.x.toFixed(1)}px, ${(g.y - (g.preH - g.subH - g.xpH - tagH) / 2).toFixed(1)}px, 0)`, op);
    }
    this.alive = alive;
  }

  _write(g, tf, op) {
    if (tf && tf !== g.tf) { g.tf = tf; g.el.style.transform = tf; }
    if (op !== g.op) { g.op = op; g.el.style.opacity = op; }
  }
}
