// game.director — the encounter flow: intro patrol → three waves of Shade Riders and Shade Drake flocks → the Cloud
// Titan rises out of the cloud sea → titan fight with escorts (enrages under 40 % HP) → victory at golden hour, or
// defeat when Sora's HP reaches 0.
//   director.phase                       intro | riders1 | riders2 | riders3 | titan-rise | titan | titan-enraged | victory | defeat
//   director.start(phase = 'intro')      (re)start a run from a phase (also: setState('play', { start: 'story'|'titan' }))
//   director.startAt(phase)              the HUD's "Face the Titan": startAt('titan') == start('titan-rise')
//   director.retry()                     restart from the last checkpoint (intro, riders1..3 or titan-rise)
//   director.restart(mode)               the HUD's Retry button: 'titan' → titan-rise, otherwise the checkpoint
//   director.restartFromIntro()          the whole run again
//   director.reset()                     back to the title: clear enemies, titan, weather (the HUD's Quit)
//   director.skipTo(phase)               debug only (?debug); also ?debug&skip=riders|riders2|riders3|titan|<phase>
//   director.stats / director.results    live counters and the final results passed to game.setState(outcome, { results })
//   director.wave                        the current wave for the HUD: { index, count, label, total, killed, left,
//                                        riders, drakes, pending, live } (index 0 = intro patrol, 1..3 waves)
//   director.combo                       { count, t } kills chained within COMBO_WINDOW s
//   director.balance                     the HP / damage table (docs/modules/gameplay.md) other owners may read
//   director.run                         the whole run across retries: { from, mode, attempts, totals, titanCp, skip }
//   gradeRun(results) (export)           rank S/A/B (victory) or C/D (defeat) from pace, damage taken, damage dealt,
//                                        kills, combo and retries; pure, unit-tested in tests/director.test.mjs
// Emits `phase` { phase, prev }, `wave` { index, count, label, total, phase }, `wave:cleared` { index, time },
// `director:kill` { actor, kind: 'rider'|'ace'|'drake', kills, combo, left, wave }, `director:hurry` { phase, brought },
// `director:escorts` { reason, riders, drakes }, `director:checkpoint` { checkpoint, label }, `director:arena`
// { dist, level }. Everything else goes through other systems' public APIs, all feature-detected.
//
// SURVIVAL (phase 'survival'; the HUD's "Survival" button → setState('play', { start: 'survival' }) or
// director.startAt('survival'); Retry → restart('survival') = a fresh run; ?mode=survival starts it from the title,
// ?debug&mode=survival&wave=N at wave N): endless waves of Shade Riders and drake flocks. A wave is due 40 → 25 s after
// the last one (4 s after a clear) but comes only once Sora has shot down its quota since the last one came
// (survivalQuota: 3, 4, 5, 6, 7 … ≤ 2 + n; no clock forces it) and the sky is not overfull; wave n = 2 + n riders (aces
// from wave 4, an Ace Squadron every 5th wave) and floor(n / 2) + 1 flocks of 5–7 drakes; the live cap grows 14 → 26 by
// wave 8, attack tokens 2 → 5 riders and 1 → 3 flocks, enemy HP and damage +8 % per wave (compounded), healing per kill
// shrinks, the first waves attack from the front and later ones from anywhere. Running is not safe: 20 s without a
// hit raises enemies.pressure (more attackers, faster chases), 35 s brings Interceptors (a hunter pair from the front).
// survivalWave(n) (export, pure) is the plan; SURVIVAL (export) the knobs.
//   director.survival = { wave, time, score, kills, alive, riders, drakes, pending, nextIn, cleared, multiplier,
//                         holding, holdReason 'quota'|'full', quota, waveKills, need, combatTime, idleT, pressure,
//                         intercepts, interceptors, best { score, time, wave, kills }, bestScore, bestTime, bestWave,
//                         newBest, def (the wave), objCountdown (the objective's sub-line counts down to the next wave:
//                         "Next wave in …", "Thin them out · next wave in ≤ …", "Sky clear · wave N in … s" — the HUD
//                         reads this flag, not the words) }
//   score = Σ kill value × wave (rider 100, ace 250, drake 40) + 10 per second IN THE FIGHT (a foe within 300 m and a
//   hit in the last 20 s) + clear bonuses; the bests live in localStorage 'skyfire.survival.best'. Results: mode
//   'survival', wave, waveReached, time, combatTime, kills, score, best, newBest, grade (gradeSurvival: kills and damage
//   first), retryLabel "Retry — Survival". Events `survival:wave` { wave, label, title, squadron, riders, aces, drakes, flocks,
//   total, cap, tokens, flockTokens, hpMul, dmgMul, duration, quota } (label / title in English in every language — the
//   words on screen: director.survivalWaveText(n) → { title, sub }), `survival:cleared` { wave, time, early, bonus },
//   `survival:intercept` { wave, reason 'idle'|'hold', riders, count, idle, pressure }, `survival:end` { wave, time,
//   kills, score, best, newBest, results }.
//
// LEVELS (25.09; game.progress = actors/progression.js, feature-detected): a new run (story, "Face the Titan",
// survival, Play again, Retry after a victory) resets Sora to level 1 (?debug&level=N: N) — resetProgress(mode), which
// also sets progress.xpCurve (survival SURVIVAL.xpCurve); every survival wave sets progress.xpMul = survivalXpMul(wave)
// (deeper waves pay more); a checkpoint retry keeps her level; the title resets it.
// director.balance.titan.hp is a getter: titanHpForLevel(level) = BALANCE.titan.hp × (1 + 0.1 (L − 1)), read by the
// titan when it spawns. Survival scales each group it spawns by survivalLevelScale(level) on top of the wave's scale.
// Results (story and survival) carry level, levelPeak, element, elementName, xp and progress { level, xp, tier,
// element, elementName, peak, startLevel, gained, levelUps [{ level, t, source, xp, phase }] } and levelFinale (the
// level-ups the fall cinematic / the end banner hid: { from, to, element, elementName, text 'LV 8 → LV 10 · Stormfire' }).
//
// LANGUAGES (29.09, src/ui/i18n.js): the tables below (PHASE_LABEL, RETRY_LABEL, WAVES labels / banners / warnings /
// checkpoint labels) stay English DATA — events, d.wave.label, d.run and the tests read them — and every text the
// player sees goes through tr() / trn() where it is handed to the HUD (Russian texts: src/ui/i18n/ru-game.js). Event
// data stays English in every language (fix 29.09: survival:wave's label); the one exception is the results object
// (d.results, also in `survival:end` and the 'state' change): its retryLabel / reachedLabel and levelFinale.text
// (progression's) are the results screen's words. A language switch (onLang) sets the objective the director showed last again and rewrites the results'
// retryLabel / reachedLabel in the new language; game state is untouched.
import * as THREE from 'three';
import { rng } from './core/util.js';
import { tr, trn, onLang } from './ui/i18n.js';

// (levels update: three more waves — riders4 'The Drake Tide', riders5 'The Twilight Lancers', riders6 'The Night Court')
export const PHASES = ['intro', 'riders1', 'riders2', 'riders3', 'riders4', 'riders5', 'riders6', 'titan-rise', 'titan', 'titan-enraged', 'victory', 'defeat', 'survival'];
// Wave 4: a defeat in the titan fight retries at the titan itself (no second rise cinematic), with the titan's HP
// back at the last threshold it had passed (100 / 70 / 40 %).
const CHECKPOINT = { intro: 'intro', riders1: 'riders1', riders2: 'riders2', riders3: 'riders3', riders4: 'riders4', riders5: 'riders5', riders6: 'riders6', 'titan-rise': 'titan-rise', titan: 'titan', 'titan-enraged': 'titan', survival: 'survival' };
const PHASE_LABEL = {
  intro: 'Aerial Patrol', riders1: 'Wave 1 · Shade Riders', riders2: 'Wave 2 · The Shade Wing', riders3: 'Wave 3 · The Onyx Aces',
  riders4: 'Wave 4 · The Drake Tide', riders5: 'Wave 5 · The Twilight Lancers', riders6: 'Wave 6 · The Night Court',
  'titan-rise': 'The Cloud Titan rises', titan: 'The Cloud Titan', 'titan-enraged': 'The Cloud Titan, enraged', survival: 'Survival',
};
const RETRY_LABEL = {
  intro: 'Retry — Aerial Patrol', riders1: 'Retry — Wave 1', riders2: 'Retry — Wave 2', riders3: 'Retry — Wave 3',
  riders4: 'Retry — Wave 4', riders5: 'Retry — Wave 5', riders6: 'Retry — Wave 6',
  'titan-rise': 'Retry — The Titan rises', titan: 'Retry from the Titan', survival: 'Retry — Survival',
};
const PROGRESS = { intro: 0, riders1: 1, riders2: 2, riders3: 3, riders4: 4, riders5: 5, riders6: 6, 'titan-rise': 7, titan: 7, 'titan-enraged': 8, victory: 9 };
const COMBAT = new Set(['intro', 'riders1', 'riders2', 'riders3', 'riders4', 'riders5', 'riders6', 'titan', 'titan-enraged', 'survival']);
const SKIP_ALIAS = {
  riders: 'riders1', riders1: 'riders1', wave1: 'riders1', riders2: 'riders2', wave2: 'riders2',
  riders3: 'riders3', wave3: 'riders3', ace: 'riders3', aces: 'riders3',
  riders4: 'riders4', wave4: 'riders4', tide: 'riders4', riders5: 'riders5', wave5: 'riders5', lancers: 'riders5', riders6: 'riders6', wave6: 'riders6', court: 'riders6',
  titan: 'titan-rise', boss: 'titan-rise', rise: 'titan-rise',
  survival: 'survival', endless: 'survival',
};
const NEXT = { intro: 'riders1', riders1: 'riders2', riders2: 'riders3', riders3: 'riders4', riders4: 'riders5', riders5: 'riders6', riders6: 'titan-rise' };
/** The story's stages in order (the stage select and the leaderboard read it): every phase a run can start at. */
export const STAGES = ['intro', 'riders1', 'riders2', 'riders3', 'riders4', 'riders5', 'riders6', 'titan-rise'];
/** Sora's level when a run starts AT a stage (the stage select): about what a full run has earned by then, so a late
 *  stage is not flown with level-1 fire. 'titan-rise' is "Face the Titan": level 1, as it always was (its own balance). */
export const STAGE_LEVEL = { intro: 1, riders1: 1, riders2: 3, riders3: 5, riders4: 7, riders5: 9, riders6: 11, 'titan-rise': 1 };
const COMBO_WINDOW = 6;           // s between kills that still chain a combo
// Dead air (wave 4): only DAMAGE either way counts as action (critics: a foe circling 75–260 m away kept the old
// watchdog quiet for 60–100 s). After DEAD_AIR s the director pulls the next group forward when no foe is near,
// otherwise it brings the nearest riders in on head-on runs (enemies.bringIn); it repeats every NUDGE_EVERY s.
const DEAD_AIR = 7;
const NUDGE_EVERY = 7;
// Titan arena: the fight stays at the titan. Past `warn` m a warning, past `lash` m the storm lashes Sora.
const ARENA = { warn: 1500, lash: 2300, lashDamage: 14, lashEvery: 1.6, warnEvery: 7 };

// HP and damage (tuned with tests/autoplay.mjs; see docs/modules/gameplay.md). Owners of the player, fire and titan
// may read these through game.director.balance so the numbers stay in one place.
export const BALANCE = {
  player: { hp: 600 },
  rider: { hp: 160 },            // rookie Shade Rider (enemies.js ENEMY_HP)
  veteran: { hp: 210 },
  ace: { hp: 260 },              // Onyx aces (wave 4: 360 → 260, and they come one at a time)
  drake: { hp: 70 },             // Shade Drake: one good breath burst
  // Wave 4: 7000 → 4500. Critics measured 1.6–3.3 DPS for their bot (35+ min). With the titan owner's open-core
  // windows (core ×2.5, ×7.5 while open) the autoplay bot now deals ≈ 24 DPS in a fight at the titan's height (run 3:
  // 3000 HP in 126 s), 6 DPS strafing from far above it (run 2): 4500 HP ≈ 3–4 min at 20–25 DPS.
  titan: { hp: 4500, enrageAt: 0.4, escortsAt: 0.7,
    // Levels (25.09): the titan's HP at spawn × (1 + perLevel × (Sora's level − 1)) — director.balance.titan.hp is a
    // getter that reads game.progress.level (BALANCE.titan.hp stays the level-1 number). Sora reaches it at ~L7
    // (dmgMult 1.72): 4500 → 7200 HP.
    perLevel: 0.1 },
  breathDps: 60,                 // fire breath, any dragon
  fireball: 45,                  // player's charged fireball
  riderFireball: 26,             // rookie; veteran 30, ace 34 (enemies.js ENEMY_WEAPONS)
  drakeBite: 11,                 // 'impact', once per dive
  drakeSpit: 9,
  titanSwat: 140,
  titanFireball: 90,
  healPerRider: 0.1,             // of the player's max HP, per rider downed
  healPerAce: 0.2,
  healPerDrake: 0.03,
  maxLive: 14,                   // enemy dragons alive at once (more wait and come as others fall)
  maxLiveRiders: 5,              // riders alive at once (a wave may set its own `maxRiders`; wave 3: 4)
  escortCap: 9,                  // no new titan escorts while this many enemy dragons are alive
};

// The waves. Each group spawns `at` s into its phase, or earlier once at most `left` enemies of the wave remain
// (live + queued) and `minAt` s have passed, or once the group `after` names is all down (and `minAt` passed), or when
// the dead-air watchdog pulls it forward. `id` names a group (its riders carry the tag '<phase>:<id>').
//   riders: [skill | { skill, name, hp }] (pairs fly leader + wingman) · flock: n Shade Drakes
//   wave: maxRiders (riders alive at once), checkpoint: { after: [ids], label } — once those groups are down, a retry
//   of this wave skips them ("Aces down").
const R = (...skills) => skills.map((s) => (typeof s === 'string' ? { skill: s } : s));
const WAVES = {
  intro: {
    index: 0, label: 'Shoot down the Shade Riders', music: 0.3, maxRiders: 2, sky: 'afternoon',
    groups: [
      // First contact: two rookies on light armour (130 HP), so the opening is quick; both of their first two attack
      // runs start in front of the player, where a beginner can see them.
      { at: 5, riders: R({ skill: 'rookie', hp: 130, frontRuns: 2 }, { skill: 'rookie', hp: 130, frontRuns: 2 }), distance: 560, bearing: 0.35, dy: 40, patrolTime: 0.5, warn: 'Shade Riders inbound' },
    ],
  },
  riders1: {
    index: 1, label: 'Wave 1 — shoot down the Shade Riders', music: 0.6, maxRiders: 4, sky: 'afternoon',
    banner: ['Wave 1 · Shade Riders', 'Four riders and a drake flock break from the clouds'],
    groups: [
      { at: 1.5, riders: R('veteran', 'rookie'), distance: 600, bearing: -0.35, dy: 70 },
      { at: 5, flock: 5, distance: 480, bearing: 0.7, dy: -60, warn: 'Drake flock rising from the valley' },
      { at: 16, left: 3, minAt: 8, riders: R('rookie', 'rookie'), distance: 620, bearing: 1.1, dy: 20 },
    ],
  },
  riders2: {
    index: 2, label: 'Wave 2 — break the Shade Wing', music: 0.75, maxRiders: 5, sky: 'afternoon',
    banner: ['Wave 2 · The Shade Wing', 'Six riders and two drake flocks'],
    groups: [
      { at: 2, riders: R('veteran', 'rookie'), distance: 580, bearing: 0.2, dy: 90 },
      { at: 4, flock: 5, distance: 500, bearing: -0.9, dy: -40 },
      { at: 14, left: 4, minAt: 7, riders: R('veteran', 'rookie'), distance: 620, bearing: -0.5, dy: 30 },
      { at: 22, left: 4, minAt: 12, flock: 5, distance: 520, bearing: 1.0, dy: 60, warn: 'More drakes!' },
      { at: 30, left: 3, minAt: 16, riders: R('rookie', 'rookie'), distance: 620, bearing: 0.6, dy: -20 },
    ],
  },
  riders3: {
    index: 3, label: 'Wave 3 — defeat the Onyx Aces', music: 0.9, maxRiders: 4, sky: 'golden', skyTime: 30,
    banner: ['Wave 3 · The Onyx Aces', 'Their two best riders lead the last wing'],
    // Wave 4 (critics: a wall, 0–1 aces in 1358 s): the aces come ONE AT A TIME — Morrow first, Vael once Morrow is
    // down (or after 110 s anyway) — at most 4 riders fly at once, 6 riders + 11 drakes in all (was 8 + 11 with both
    // aces together), and once both aces are down a retry starts from the rest of the wave.
    checkpoint: { after: ['ace1', 'ace2'], label: 'Wave 3 · the aces are down' },
    groups: [
      // Progress-driven: each group comes when the sky has thinned out (`left`), the `at` times are only a backstop
      // for a player who hides, so a slower player is not buried under everything at once.
      { id: 'ace1', at: 2.5, riders: R({ skill: 'ace', name: 'Onyx Ace Morrow' }), distance: 600, bearing: 0, dy: 110, warn: 'Onyx Ace Morrow is here' },
      { at: 6, flock: 6, distance: 520, bearing: 0.9, dy: -50 },
      { at: 45, left: 5, minAt: 12, riders: R('veteran', 'rookie'), distance: 600, bearing: -0.9, dy: 40, warn: 'Shade Lancers join the ace' },
      { id: 'ace2', at: 120, after: 'ace1', minAt: 10, riders: R({ skill: 'ace', name: 'Onyx Ace Vael' }), distance: 620, bearing: 0.5, dy: 100, warn: 'Onyx Ace Vael comes for revenge' },
      { at: 100, left: 4, minAt: 30, flock: 5, distance: 520, bearing: -0.6, dy: 20, warn: 'More drakes!' },
      { at: 130, left: 3, minAt: 45, riders: R('veteran', 'rookie'), distance: 620, bearing: 1.2, dy: 60 },
    ],
  },
  // ---- levels update: three more waves before the Titan. Sora is level 7+ by now (lightning, ×1.7 damage and more),
  // so these dragons carry more HP and hit harder (wave: hpMul / dmgMul on every group), pay more XP (xpMul) and the
  // day runs out: golden hour → dusk → a night sky with an aurora. Every group is progress-driven like wave 3's.
  riders4: {
    index: 4, label: 'Wave 4 — turn back the Drake Tide', music: 0.85, maxRiders: 4, sky: 'dusk', skyTime: 40,
    hpMul: 1.45, dmgMul: 1.2, xpMul: 1.3,
    banner: ['Wave 4 · The Drake Tide', 'Flock after flock pours out of the cloud sea'],
    checkpoint: { after: ['tide1', 'tide2'], label: 'Wave 4 · the first flocks are down' },
    groups: [
      { id: 'tide1', at: 2, flock: 7, distance: 500, bearing: 0.3, dy: -40, warn: 'The Drake Tide rises' },
      { id: 'tide2', at: 7, flock: 7, distance: 520, bearing: -0.8, dy: 30 },
      { at: 14, left: 8, minAt: 6, riders: R('veteran', 'veteran'), distance: 600, bearing: 0.9, dy: 80, warn: 'Shade Lancers herd the tide' },
      { at: 40, left: 6, minAt: 16, flock: 6, distance: 520, bearing: 1.4, dy: -20, warn: 'More drakes!' },
      { at: 70, left: 5, minAt: 28, riders: R('veteran', 'rookie'), distance: 620, bearing: -1.1, dy: 50 },
      { at: 95, left: 4, minAt: 40, flock: 7, distance: 520, bearing: -0.2, dy: 70, warn: 'The last of the tide' },
    ],
  },
  riders5: {
    index: 5, label: 'Wave 5 — break the Twilight Lancers', music: 0.9, maxRiders: 5, sky: 'night', skyTime: 45,
    hpMul: 1.65, dmgMul: 1.3, xpMul: 1.5, aimMul: 0.9,
    banner: ['Wave 5 · The Twilight Lancers', 'Their veteran wing, and an ace to lead it'],
    checkpoint: { after: ['lance1', 'lance2'], label: 'Wave 5 · the first lances are broken' },
    groups: [
      { id: 'lance1', at: 2, riders: R('veteran', 'veteran'), distance: 600, bearing: -0.3, dy: 90, warn: 'Twilight Lancers inbound' },
      { id: 'lance2', at: 9, left: 1, minAt: 4, riders: R('veteran', 'veteran'), distance: 620, bearing: 0.8, dy: 40 },
      { at: 12, flock: 6, distance: 500, bearing: -1.0, dy: -50 },
      { id: 'sable', at: 60, left: 4, minAt: 18, riders: R({ skill: 'ace', name: 'Onyx Ace Sable' }), distance: 620, bearing: 0.1, dy: 120, warn: 'Onyx Ace Sable takes the lead' },
      { at: 90, left: 4, minAt: 30, riders: R('veteran', 'rookie'), distance: 620, bearing: 1.3, dy: 20 },
      { at: 120, left: 3, minAt: 45, riders: R('veteran', 'veteran'), distance: 620, bearing: -1.3, dy: 70, warn: 'The last lances' },
    ],
  },
  riders6: {
    index: 6, label: 'Wave 6 — face the Night Court', music: 1, maxRiders: 4, sky: 'aurora', skyTime: 40,
    hpMul: 1.85, dmgMul: 1.4, xpMul: 1.7, aimMul: 0.8, homing: 0.08,
    banner: ['Wave 6 · The Night Court', 'Three Onyx Aces hold the sky under the aurora'],
    checkpoint: { after: ['nyx'], label: 'Wave 6 · Nyx is down' },
    groups: [
      { id: 'nyx', at: 2.5, riders: R({ skill: 'ace', name: 'Onyx Ace Nyx' }), distance: 600, bearing: 0, dy: 120, warn: 'Onyx Ace Nyx opens the court' },
      { at: 6, flock: 6, distance: 520, bearing: 1.0, dy: -40 },
      { at: 40, left: 5, minAt: 14, riders: R('veteran', 'veteran'), distance: 620, bearing: -0.9, dy: 60 },
      // the twins fly together: the wave's set piece (they come once Nyx is down, or after two minutes anyway)
      { id: 'twins', at: 120, after: 'nyx', minAt: 12, riders: R({ skill: 'ace', name: 'Onyx Ace Corvin' }, { skill: 'ace', name: 'Onyx Ace Thane' }), distance: 640, bearing: 0.4, dy: 110, warn: 'The twin aces Corvin and Thane dive together' },
      { at: 110, left: 4, minAt: 35, flock: 7, distance: 520, bearing: -0.5, dy: 30, warn: 'More drakes!' },
      { at: 150, left: 3, minAt: 55, riders: R('veteran', 'veteran'), distance: 620, bearing: 1.2, dy: 80 },
    ],
  },
};
const WAVE_COUNT = 6;

// ---- rank -------------------------------------------------------------------------------------------------------
// Par times: at `fast` s the pace score is 1, at `slow` s it is 0 (whole story vs "Face the Titan").
// (levels update: three more waves — the story's par 13:00 / 40:00 → 23:00 / 65:00)
export const PAR = { story: { fast: 1380, slow: 3900 }, titan: { fast: 210, slow: 900 } };
const clamp01 = (x) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
/**
 * Rank from performance (wave 4; critics: every defeat was C or B by progress alone, S needed < 900 s for the story).
 *   pace      time against PAR (victory) · progress through the story from where the run began (defeat)
 *   survival  damage taken per minute: 0 /min → 1, ≥ 160 /min → 0
 *   offense   damage dealt per minute: ≥ 900 /min (15 DPS) → 1
 *   kills     best combo (×6 → 1) and kills per minute (≥ 3 /min → 1)
 * rating = 0.3 pace + 0.25 survival + 0.25 offense + 0.2 kills − 0.06 per retry, 0..1.
 * Victory: S ≥ 0.72, A ≥ 0.55, else B. Defeat (capped at C): C when 0.45 offense + 0.3 kills + 0.25 progress ≥ 0.25,
 * else D (a run that did nothing). Pure: tests/director.test.mjs checks it.
 */
export function gradeRun(r = {}) {
  const win = r.outcome === 'victory';
  const minutes = Math.max(0.5, (r.time || 0) / 60);
  const par = PAR[r.mode === 'titan' ? 'titan' : 'story'];
  // Progress counts only what this run covered ("Face the Titan" starts at the titan: reaching it earns nothing).
  const p0 = Math.min(PROGRESS[r.from] ?? 0, PROGRESS.victory - 1);
  const progress = clamp01(((PROGRESS[r.reached] ?? 0) - p0) / (PROGRESS.victory - p0));
  const pace = win ? clamp01((par.slow - (r.time || 0)) / (par.slow - par.fast)) : progress;
  const survival = clamp01(1 - (r.damageTaken || 0) / minutes / 160);
  const offense = clamp01((r.damageDealt || 0) / minutes / 900);
  const kills = clamp01(0.5 * Math.min(1, (r.bestCombo || 0) / 6) + 0.5 * Math.min(1, (r.kills || 0) / minutes / 3));
  const retries = Math.max(0, (r.attempts || 1) - 1);
  const rating = clamp01(0.3 * pace + 0.25 * survival + 0.25 * offense + 0.2 * kills - 0.06 * retries);
  let grade;
  if (win) grade = rating >= 0.72 ? 'S' : rating >= 0.55 ? 'A' : 'B';
  else grade = 0.45 * offense + 0.3 * kills + 0.25 * progress >= 0.25 ? 'C' : 'D';
  const round = (x) => Math.round(x * 100) / 100;
  return { grade, rating: round(rating), parts: { pace: round(pace), survival: round(survival), offense: round(offense), kills: round(kills), retries } };
}

// ---- survival -----------------------------------------------------------------------------------------------------
// Knobs of the endless mode (docs/modules/gameplay.md, "Hover / aim / survival" has the table and the measurements).
export const SURVIVAL = {
  firstAt: 3,                     // s from the start to wave 1
  duration: [40, 25], durationWaves: 10,   // wave length: 40 s at wave 1 → 25 s from wave 11 on
  clearedBreak: 4,                // s from a cleared wave to the next one
  // A due wave waits while the sky is still full (live + queued + not yet spawned > holdAt × cap), at most holdMax ×
  // its duration longer: a player who cannot thin the sky out does not race through the waves by time alone.
  holdAt: 1, holdMax: 1,
  cap: [14, 26], capWaves: 7,     // live enemy dragons at once: 14 at wave 1 → 26 at wave 8 (fps measured, see docs)
  capMax: 26,                     // hard ceiling (fps)
  // ceiling per quality preset (a weaker GPU is on Low / Medium); High / Ultra keep capMax. Measured on High only.
  capByQuality: { low: 18, medium: 22 },
  backlog: 2,                     // live + queued stay ≤ backlog × cap: a wave beyond that loses drakes, then rookies
  scale: 0.08,                    // enemy HP and damage per wave, compounded (wave 5 ×1.36, wave 8 ×1.71)
  heal: { rider: 0.06, ace: 0.12, drake: 0.015 },   // of max HP per kill at wave 1 (story: 0.1 / 0.2 / 0.03) …
  healFade: 0.07, healMin: 0.3,   // … × max(0.3, 1 − 0.07 (n − 1))
  clearHeal: 0.08,                // a wave cleared before its timer runs out
  points: { rider: 100, ace: 250, drake: 40 },      // per kill × the wave number
  timePoints: 10,                 // per second IN THE FIGHT (see `combat`), not merely alive
  clearBonus: 150,                // × wave, for a wave cleared before its timer
  storageKey: 'skyfire.survival.best',
  // Fix pass (playtester: running away paid better than fighting — a pilot who never fired reached wave 7 in 7:30
  // with rank B and set the best time / wave, a fighter reached wave 6 in 5:23 with the same B):
  // (1) the next wave needs KILLS: at least ceil(quota × the wave's dragons) since it came, ≥ quotaMin and ≤ 2 + n
  //     (wave 1: 3, 2: 4, 3: 5, 4: 6, 5: 7 …, any enemy counts). A due wave without them waits — no timer forces it.
  quota: 0.4, quotaMin: 2,
  // (2) time points only in combat: an enemy within `near` m AND Sora hit an enemy within the last `recent` s.
  combat: { near: 300, recent: 20 },
  // (3) running is dangerous: `idle` s without hitting anything (while enemies are up) and the pressure rises over
  //     `ramp` s (enemies.pressure 0 → 1: more attack tokens, faster chases, quicker potshots) …
  pressure: { idle: 20, ramp: 20 },
  // … and Interceptors come — a hunter pair (2 veterans; an ace + a veteran from wave 3) from the player's front,
  //     always attacking — after `idle` s without a hit, or when a due wave has waited `hold` × its duration for its
  //     kills (2: the playtester's fighter bot, 3.5 kills / min, spent 155 s in wave 3 with 1); again every `every` s
  //     while it lasts, at most `max` hunters up at once (they pass the rider cap, and the live cap by one pair).
  intercept: { idle: 35, hold: 2, every: 30, max: 4, distance: 520 },
  // Levels (25.09, game.progress): Sora grows stronger with every kill; survival must stay hard by waves 6–8, so
  // (1) XP counts × xpWave(wave) × xpCurve(level), (2) every group that spawns is scaled by her level at that moment:
  // HP × (1 + level.hp × (L − 1)), damage × (1 + level.dmg × (L − 1)) — a bit over half of what a level gives her (+12 %
  // damage, +8 % HP), so a level still feels like one.
  // Fix pass (playtester: the old curve 1, 1, 0.75, 0.6 … cut XP from L3 on — a 6:36 run with 20 kills ended at L4
  // azure, lightning would have needed ~35 more rider kills): XP × (1 + xpWave (n − 1)) in wave n (≤ xpWaveMax; its
  // dragons are ×1.08^(n−1) tougher and scarcer per minute), full XP through L5, then the cliff at lightning:
  // xpCurve 1, 1, 1, 1, 1, 0.9, 0.4, 0.3, 0.25, 0.25. Kill by kill (tests/progression.test.mjs prints it): the quota
  // pilot (exactly the kills each wave asks, 60 % drakes) L3 at wave 3, L5 at wave 5, L7 in wave 6 (≈ 33 kills); a
  // 25–45 % pilot L7 in wave 5 (≈ 20–27 kills); L9 takes ≥ 44 kills, L10 ≥ 68 — long runs only. (First try ×0.25 per
  // wave: the autoplay bot, 2.3 kills / min, was L4 at wave 5 after 6:43 — L7 would have taken ~40 kills.)
  xpCurve: [1, 1, 1, 1, 1, 0.9, 0.4, 0.3, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25], xpWave: 0.4, xpWaveMax: 3,
  // (leveling is faster now, so the enemies' share went up: +7 % HP, +5 % damage per level, was 6 / 4)
  level: { hp: 0.07, dmg: 0.05 },
};

/** Survival's XP factor in wave n (pure): 1 + xpWave (n − 1), ≤ xpWaveMax (wave 1 ×1, wave 3 ×1.8, wave 5 ×2.6, wave 6+ ×3). */
export function survivalXpMul(wave) {
  const n = Math.max(1, Math.floor(Number.isFinite(+wave) ? +wave : 1));
  return Math.round(Math.min(SURVIVAL.xpWaveMax, 1 + SURVIVAL.xpWave * (n - 1)) * 1000) / 1000;
}

/** Survival's extra enemy scale for Sora's level (pure): { hp, dmg } multipliers (1 at level 1). */
export function survivalLevelScale(level) {
  const l = Math.max(1, Math.min(15, Math.floor(Number.isFinite(+level) ? +level : 1)));
  const r = (x) => Math.round(x * 1000) / 1000;
  return { hp: r(1 + SURVIVAL.level.hp * (l - 1)), dmg: r(1 + SURVIVAL.level.dmg * (l - 1)) };
}
/** The titan's HP at spawn for Sora's level (pure): BALANCE.titan.hp × (1 + perLevel × (L − 1)). */
export function titanHpForLevel(level) {
  const l = Math.max(1, Math.min(15, Math.floor(Number.isFinite(+level) ? +level : 1)));
  return Math.round(BALANCE.titan.hp * (1 + BALANCE.titan.perLevel * (l - 1)));
}

/**
 * Survival wave n (pure; tests/director.test.mjs checks it). riders 2 + n: aces from wave 4 (1 → 3), every 5th wave
 * an Ace Squadron (2 + n/5 aces with veterans), veterans floor((n + 1) / 2), rookies the rest; floor(n / 2) + 1 flocks
 * of 5 → 7 drakes; live cap 14 → 26 by wave 8, riders at once 3 + n (≤ 12); attack tokens 2 → 5 riders, 1 → 3 flocks;
 * HP and damage ×1.08^(n−1); healing ×max(0.3, 1 − 0.07 (n − 1)); waves 1–2 come from the front (±40°), 3–4 from the
 * front and sides (±75°) with front first runs, from wave 5 from anywhere (behind included) and straight in.
 */
export function survivalWave(n) {
  n = Math.max(1, Math.floor(Number.isFinite(+n) ? +n : 1));
  const S = SURVIVAL;
  const riders = 2 + n;
  const squadron = n % 5 === 0;
  const aces = squadron ? Math.min(riders, 2 + Math.floor(n / 5)) : n >= 4 ? Math.min(3, 1 + Math.floor((n - 4) / 3)) : 0;
  const veterans = squadron ? riders - aces : Math.min(riders - aces, Math.floor((n + 1) / 2));
  const rookies = riders - aces - veterans;
  const flocks = Math.floor(n / 2) + 1;
  const flockSize = 5 + Math.min(2, Math.floor((n - 1) / 3));
  const cap = Math.min(S.capMax, Math.round(S.cap[0] + (S.cap[1] - S.cap[0]) * clamp01((n - 1) / S.capWaves)));
  const scale = Math.round(Math.pow(1 + S.scale, n - 1) * 1000) / 1000;
  const early = n <= 2, mid = n <= 4;
  return {
    n, squadron, riders, aces, veterans, rookies, flocks, flockSize, drakes: flocks * flockSize, total: riders + flocks * flockSize,
    label: squadron ? `Wave ${n} · Ace Squadron` : `Wave ${n}`,
    cap, riderCap: Math.max(2, Math.min(cap - 4, 3 + n, 12)),
    tokens: Math.min(5, 2 + Math.floor((n - 1) / 2)), flockTokens: Math.min(3, 1 + Math.floor((n - 1) / 3)),
    hpMul: scale, dmgMul: scale,
    healMul: Math.round(Math.max(S.healMin, 1 - S.healFade * (n - 1)) * 1000) / 1000,
    duration: Math.round(S.duration[0] + (S.duration[1] - S.duration[0]) * clamp01((n - 1) / S.durationWaves)),
    spread: early ? 1.4 : mid ? 2.6 : Math.PI * 2,          // bearing range of the groups (rad, centred ahead)
    frontRuns: mid ? 1 : 0,                                  // riders' first attack run from the player's front
    firstDives: n <= 3 ? 2 : n <= 5 ? 1 : 0, frontDives: n <= 5,
    potshotGap: Math.round(Math.max(0.8, 2.2 - 0.2 * (n - 1)) * 100) / 100,
    potshotCone: n >= 4 ? Math.min(32, 20 + 3 * (n - 3)) : 20,           // deg off the flight path for a potshot
    // Shots get tighter and home a little from wave 3 (first survival run: 3 of 295 enemy fireballs hit a player who
    // kept moving; every hit so far came from breath and bites) — Q/E dodges start to matter.
    aimMul: Math.round(Math.max(0.4, 1 - 0.08 * (n - 1)) * 100) / 100,    // fireball aim error × this
    homing: n >= 3 ? Math.round(Math.min(0.25, 0.04 + 0.03 * (n - 3)) * 100) / 100 : 0,   // + rad/s on enemy shots
    aggressionFloor: Math.round(Math.min(0.85, 0.5 + 0.05 * (n - 1)) * 100) / 100,
    music: Math.min(1, 0.6 + 0.08 * (n - 1)),
  };
}

// The survival wave card { title, sub } of wave plan `w`, worded by the translators passed in: i18n's tr / trn for the
// screen (the player's language), EN for the event survival:wave (its data stays English whatever the language).
const EN = {
  tr: (s, v) => (v ? String(s).replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined && v[k] !== null ? String(v[k]) : m)) : s),
  trn: (n, one, other, v) => EN.tr(n === 1 ? one : other, { n, ...(v || {}) }),
};
function survivalCard(w, tr, trn) {
  const n = w.n;
  const flocks = trn(w.flocks, '{n} drake flock', '{n} drake flocks');
  const sub = n === 1 ? tr('Endless waves — how long can you hold the sky?')
    : w.squadron ? tr('{aces} lead {lancers} · {flocks}', { aces: trn(w.aces, '{n} Onyx Ace', '{n} Onyx Aces'), lancers: trn(w.veterans, '{n} Lancer', '{n} Lancers'), flocks })
      : `${trn(w.riders, '{n} rider', '{n} riders')}${w.aces ? ` (${trn(w.aces, '{n} ace', '{n} aces')})` : ''} · ${flocks}`;
  return { title: w.squadron ? tr('Wave {n} · Ace Squadron', { n }) : tr('Wave {n}', { n }), sub };
}

/** Survival rank (pure). Fighting counts most (fix pass: the wave reached used to be 45 % of it, so a pilot who never
 *  fired ranked B by outlasting the timer):
 *    kills    total downed (50 → full)                                   0.30
 *    offense  damage dealt per minute (1200 /min → full) × dur            0.25
 *    rate     kills per minute (6 /min → full) × dur                      0.15
 *    wave     the wave reached (wave 10 → full)                           0.20
 *    combat   seconds in the fight (r.combatTime; else r.time) (480 → full) 0.10
 *  dur = min(1, time / 240): the per-minute parts count fully only for runs of 4 min or more (a 30 s run with 3 kills
 *  is not an A). S ≥ 0.8, A ≥ 0.6, B ≥ 0.4, C ≥ 0.2, else D. */
export function gradeSurvival(r = {}) {
  const t = Math.max(0, Number.isFinite(+r.time) ? +r.time : 0);
  const minutes = Math.max(0.5, t / 60);
  const dur = clamp01(t / 240);
  const wave = clamp01(((+r.wave || 1) - 1) / 9);
  const kills = clamp01((+r.kills || 0) / 50);
  const rate = clamp01((+r.kills || 0) / minutes / 6) * dur;
  const offense = clamp01((+r.damageDealt || 0) / minutes / 1200) * dur;
  const combat = clamp01((Number.isFinite(+r.combatTime) && r.combatTime != null ? +r.combatTime : t) / 480);
  const rating = clamp01(0.3 * kills + 0.25 * offense + 0.15 * rate + 0.2 * wave + 0.1 * combat);
  const grade = rating >= 0.8 ? 'S' : rating >= 0.6 ? 'A' : rating >= 0.4 ? 'B' : rating >= 0.2 ? 'C' : 'D';
  const round = (x) => Math.round(x * 100) / 100;
  return { grade, rating: round(rating), parts: { pace: round(wave), survival: round(combat), offense: round(offense), kills: round(clamp01(0.65 * kills + 0.35 * (dur ? rate / dur : 0))), retries: 0 } };
}
/** Survival score (pure): kill points (already × their wave) + 10 per second in the fight (s.combatTime; a record
 *  without it counts s.time) + bonuses. */
export function survivalScore(s = {}) {
  const tt = Number.isFinite(s.combatTime) ? s.combatTime : s.time;
  return Math.max(0, Math.round((s.killScore || 0) + Math.floor(Math.max(0, tt || 0)) * SURVIVAL.timePoints + (s.bonus || 0)));
}
/** Kills the next survival wave needs since `w` came (pure): ceil(quota × its dragons), ≥ quotaMin, ≤ 2 + n. */
export function survivalQuota(n, total) {
  n = Math.max(1, Math.floor(Number.isFinite(+n) ? +n : 1));
  total = Math.max(0, Math.floor(Number.isFinite(+total) ? +total : 0));
  const S = SURVIVAL;
  return Math.max(Math.min(S.quotaMin, Math.max(1, total)), Math.min(Math.ceil(S.quota * total), 2 + n));
}

export default function createDirector(game) {
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  let schedule = [];
  let lastActionT = 0;
  let proximityAcc = 0;
  let pendingStart = null;
  let escorts = { first: false, second: false, lastT: -99, calls: 0, sawCall: false };
  let titanFallback = false;
  let baseWeather = null;
  let plan = [];                  // the current wave's groups: { ...group, done }
  let adhocPending = 0;           // riders scheduled through the legacy spawn(spec, delay)
  let waveStartT = 0;
  let waveAcc = 0;
  let lastNudgeT = -99;           // dead-air watchdog: last nudge (repeats every NUDGE_EVERY s while it stays quiet)
  let lastNearT = -99;            // last time an enemy dragon was within 350 m of the player
  let arena = { warnT: -99, lashT: -99 };
  let titleReset = false;         // Sora was already put back for the title after this run
  let survRand = rng(1);          // survival spawn bearings / heights (reseeded per run)
  let survObjT = -99;             // last survival objective refresh (1 Hz countdown)
  let bestCache = null;           // the survival bests ({ score, time, wave, kills }), mirrored in localStorage

  const hud = (fn, ...a) => { try { game.hud?.[fn]?.(...a); } catch (e) { console.warn('[director] hud.' + fn, e); } };
  const call = (obj, fn, ...a) => { try { return obj?.[fn]?.(...a); } catch (e) { console.warn('[director] ' + fn, e); return undefined; } };
  const player = () => { const p = game.player; return p && p.pos ? p : p?.dragon || null; };
  const playerActor = () => { const p = player(); return p?.actor || game.actors.find((a) => a.team === 'player') || null; };
  // The titan's actor persists while dormant; it only counts once the titan is active (spawned).
  const titanActor = () => (game.titan ? (game.titan.active ? game.titan.actor : null) : game.actors.find((a) => a.kind === 'titan') || null);
  /** The boss's display name (in the player's language): the titan owner's actor.name when it names the Cloud Titan,
   *  else the contract name. (actor.name itself stays English: code tests it.) */
  const titanName = () => { const n = game.titan?.actor?.name; return tr(n && /titan/i.test(n) ? n : 'The Cloud Titan'); };
  // The objective the director set last ({ phase, args: () => [text, sub?] }, the texts built in the current language):
  // a language switch sets it again (only while its phase lasts — the titan fight's objective is the HUD's own).
  let objLast = null;
  const objective = (args) => { objLast = { phase: d.phase, args }; hud('setObjective', ...args()); };
  // The results' words (retryLabel / reachedLabel) from the numbers kept at the end of the run: rebuilt on a switch.
  let resultsText = null;
  const enemies = () => game.enemies;
  const liveEnemies = () => (enemies()?.count?.() ?? 0);
  // Levels (game.progress, feature-detected: without it Sora is level 1 and nothing below changes anything).
  const progress = () => (game.progress && typeof game.progress === 'object' ? game.progress : null);
  const level = () => { const l = +progress()?.level; return Number.isFinite(l) && l >= 1 ? Math.min(15, Math.floor(l)) : 1; };
  // director.balance: BALANCE with the titan's HP read at spawn time for Sora's level (the titan owner reads
  // balance.titan.hp when it spawns). BALANCE itself stays the level-1 table.
  const balance = { ...BALANCE, titan: { ...BALANCE.titan } };
  Object.defineProperty(balance.titan, 'hp', { enumerable: true, configurable: true, get: () => titanHpForLevel(level()) });
  balance.titan.baseHp = BALANCE.titan.hp;
  const queuedEnemies = () => (enemies()?.pending?.() ?? 0);

  const d = {
    name: 'director',
    phase: null,
    prevPhase: null,
    phaseT: 0,
    running: false,
    checkpoint: 'intro',
    balance,
    waves: WAVES,
    stats: null,
    results: null,
    wave: null,
    combo: { count: 0, t: -99 },
    comboWindow: COMBO_WINDOW,
    run: null,
    arena: ARENA,
    survival: null,                 // the survival run's live numbers (null outside survival; kept on the results)
    survivalConfig: SURVIVAL,

    init() {
      d.resetStats();
      d.newWave(null);
      game.events.on('state', ({ prev, next, start }) => {
        if (next === 'play' && !d.running && (prev === 'title' || prev === 'victory' || prev === 'defeat')) {
          // A Retry of a survival run is a fresh survival run (no checkpoints, the bests stay).
          const surv = start === 'survival' || (prev !== 'title' && d.run?.mode === 'survival' && start !== 'story' && start !== 'titan');
          if (surv) d.start('survival');
          // (stage select: start = 'stage:<phase>' begins a new story run at that stage)
          else if (typeof start === 'string' && start.startsWith('stage:') && STAGES.includes(start.slice(6))) d.start(start.slice(6));
          else d.start(start === 'titan' ? 'titan-rise' : (pendingStart || 'intro'), { retry: prev !== 'title' && !!d.run });
        }
        if (next === 'title') d.stop();
      });
      game.events.on('damage', (rec) => d.onDamage(rec));
      game.events.on('death', (rec) => d.onDeath(rec));
      // (Wave 4: titan telegraphs no longer count as action — a volley that never connects is not contact; in the
      // titan fight dead air brings the escorts in.)
      // The titan calls its escorts (titan owner's event); count = how many dragons answer.
      game.events.on('titan:call', (e) => {
        escorts.sawCall = true;
        if (!d.running || (d.phase !== 'titan' && d.phase !== 'titan-enraged')) return;
        // A threshold wave that just answered (≤ 8 s ago) already is this call's answer.
        if (d.phaseT - escorts.lastT < 8) return;
        if (d.callEscorts(e?.count ?? 4, 'call')) { if (d.phase === 'titan') escorts.first = true; else escorts.second = true; }
      });
      // Retry fallback from a reload (used only when the player dragon has no reset API) and the debug skip.
      try { pendingStart = sessionStorage.getItem('skyfire.start'); sessionStorage.removeItem('skyfire.start'); } catch { pendingStart = null; }
      const skip = game.params.get('skip');
      if (game.debugMode && skip) pendingStart = SKIP_ALIAS[skip] || (PHASES.includes(skip) ? skip : pendingStart);
      // ?mode=survival: a deep link into the endless mode (starts once the title is up).
      if (game.params.get('mode') === 'survival') pendingStart = 'survival';
      if (game.params.has('sandbox') && !game.params.has('director')) pendingStart = null;
      d.autoStart = !!pendingStart;
      bestCache = d.loadSurvivalBest();
      // Language switch (Settings / the title's selector, no reload): what the director put on screen, again in the new
      // language — the objective of the running phase and the results' labels. Nothing else changes.
      onLang(() => d.relabel());
    },
    /** Rewrite the director's on-screen words in the current language (called by the language switch). */
    relabel() {
      try {
        if (d.phase && objLast && objLast.phase === d.phase) hud('setObjective', ...objLast.args());
        if (d.results && resultsText) Object.assign(d.results, resultsText());
      } catch (e) { console.warn('[director] relabel', e); }
    },

    resetStats() {
      d.stats = { time: 0, kills: 0, riderKills: 0, drakeKills: 0, aceKills: 0, bestCombo: 0, damageDealt: 0, damageTaken: 0,
        titanDamage: 0, healed: 0, phaseTimes: {}, waveTimes: {}, startedAt: null, reached: null };
      d.combo = { count: 0, t: -99 };
    },
    /** A new run (from the title, "Face the Titan", or Play again): retries add their attempts to it. */
    newRun(from = 'intro') {
      d.run = {
        from, mode: /^titan/.test(from) ? 'titan' : from === 'survival' ? 'survival' : 'story', attempts: 0, titanCp: 1, skip: {}, checkpointLabel: null,
        totals: { time: 0, kills: 0, riderKills: 0, drakeKills: 0, aceKills: 0, bestCombo: 0, damageDealt: 0, damageTaken: 0, titanDamage: 0, healed: 0 },
      };
      return d.run;
    },

    // ---- flow control ----------------------------------------------------------------------------------------
    /** (Re)start at a phase. opts.retry: a checkpoint retry inside the same run (keeps the run's totals, the titan
     *  checkpoint HP and skipped groups); otherwise a new run begins. */
    start(from = 'intro', opts = {}) {
      if (!PHASES.includes(from)) from = 'intro';
      if (from === 'survival' && opts.retry) opts = { ...opts, retry: false };   // every survival run starts fresh
      const fresh = !opts.retry || !d.run;
      if (fresh) d.newRun(from);
      d.run.attempts++;
      // Levels: a new run starts at level 1 (?debug&level=N: at N); a checkpoint retry keeps what Sora has earned.
      if (fresh) d.resetProgress(d.run.mode, from);
      titleReset = false;
      d.cleanup();
      const P = player();
      const pa = playerActor();
      const wasRun = d.stats?.startedAt != null;
      if (pa && (!pa.alive || wasRun)) {
        if (typeof P?.reset === 'function') call(P, 'reset');
        else if (typeof P?.respawn === 'function') call(P, 'respawn');
        else if (!pa.alive) {
          // No way to bring the player back in place: reload and resume from the checkpoint.
          try { sessionStorage.setItem('skyfire.start', from); } catch { /* private mode */ }
          location.reload();
          return;
        }
        if (pa.alive && pa.hp < pa.maxHp) game.combat?.heal(pa, pa.maxHp);
      }
      d.resetStats();
      d.stats.startedAt = game.time.now;
      d.running = true;
      d.results = null;
      pendingStart = null;
      escorts = { first: false, second: false, lastT: -99, calls: 0, sawCall: escorts.sawCall };
      titanFallback = false;
      d.survival = null;
      const E = enemies();
      if (E) {
        // The story's numbers (survival's enter() raises them per wave; a story run after a survival run is unchanged).
        E.maxTokens = 2; E.maxLive = BALANCE.maxLive; E.maxLiveRiders = BALANCE.maxLiveRiders; E.flockTokens = 1;
        E.aggressionFloor = 0.5; E.potshotGap = 2.2; E.potshotCone = 20; E.pressure = 0;
      }
      // A fresh run starts in the afternoon; a titan retry keeps the storm it died in (no flash back to afternoon).
      const keepStorm = /^titan/.test(from) && game.atmo?.preset === 'storm';
      if (from === 'titan' || from === 'titan-enraged') { d.setSky('storm', 0); d.setWeather('storm', 0); }
      else if (from !== 'victory' && from !== 'defeat' && !keepStorm) {
        // (a stage start or a checkpoint retry of a late wave begins under that wave's sky, not in the afternoon)
        const sky0 = WAVES[from]?.sky || 'afternoon';
        d.setSky(sky0, 0); if (game.atmo?.preset !== sky0) d.setSky('afternoon', 0);
        d.setWeather('fair', 0);
      }
      arena = { warnT: -99, lashT: -99 };
      lastNudgeT = -99;
      d.setPhase(from);
      if (game.state !== 'play') game.setState('play');
    },
    retry() { d.start(d.checkpoint || 'intro', { retry: true }); },
    /** The HUD's Retry: after a defeat, the checkpoint (a titan defeat → the titan itself); after a victory, the run
     *  again from where it began. `mode` ('titan' | 'story') only matters when there is no checkpoint yet. */
    restart(mode) {
      // Survival: Retry is a new survival run (wave 1, the bests kept).
      if (mode === 'survival' || (d.run?.mode === 'survival' && mode !== 'story' && mode !== 'titan')) { d.start('survival'); return; }
      if (d.results?.outcome === 'victory') { d.start(d.run?.from || (mode === 'titan' ? 'titan-rise' : 'intro')); return; }
      d.start(d.checkpoint || (mode === 'titan' ? 'titan-rise' : 'intro'), { retry: true });
    },
    restartFromIntro() { d.start('intro'); },
    /** Public (non-debug) entry at a phase; a no-op if that phase was just entered (the HUD calls it after setState). */
    /** The story's stages for the stage select: [{ phase, index, label, level, sky }] (labels are English data). */
    stages() {
      return STAGES.map((phase, i) => ({ phase, index: i, label: PHASE_LABEL[phase === 'titan-rise' ? 'titan' : phase], level: STAGE_LEVEL[phase] || 1, sky: WAVES[phase]?.sky || (phase === 'titan-rise' ? 'storm' : 'afternoon') }));
    },
    startAt(phase) {
      phase = SKIP_ALIAS[phase] || phase;
      if (!PHASES.includes(phase)) phase = 'intro';
      if (d.running && d.phase === phase && d.phaseT < 1) return;
      d.start(phase);
    },
    reset() { d.stop(); },
    skipTo(phase) {
      if (!game.debugMode) return false;
      phase = SKIP_ALIAS[phase] || phase;
      if (!PHASES.includes(phase)) return false;
      if (phase === 'victory' || phase === 'defeat') { d.running = true; d.setPhase(phase); return true; }
      d.start(phase);
      return true;
    },
    /** Back to the title: clear the arena, afternoon sky, fair weather. */
    stop() {
      // A survival run quit from the pause menu still counts for the bests (wave, time, score so far).
      const S = d.survival;
      if (S && !S.ended && !S.debugStart && S.wave > 0) {
        try { S.ended = true; d.saveSurvivalBest({ score: survivalScore(S), time: Math.round((S.time || 0) * 10) / 10, wave: S.wave, kills: S.kills }); } catch (e) { console.warn('[director] survival best', e); }
      }
      d.running = false;
      d.cleanup();
      d.phase = null;
      d.survival = null;
      d.newWave(null);
      d.setSky('afternoon', 2);
      d.setWeather('fair', 2);
      // Sora glides level behind the menu again, at the start spot (critics: the title orbited a dragon still diving
      // or skimming the rooftops). The player owner's reset() respawns her there with full HP; only after a run.
      if (d.stats?.startedAt != null && !titleReset) {
        titleReset = true;
        d.resetProgress('story');                       // behind the menu Sora is level 1 again (ember)
        const P = player();
        if (typeof P?.reset === 'function') call(P, 'reset');
      }
    },
    /** game.progress back to level 1 (its reset() applies ?debug&level=N) with the mode's XP factors. */
    resetProgress(mode = 'story', from = 'intro') {
      const P = progress();
      if (!P) return;
      // (stage select: a run that starts at a later stage starts at that stage's level — STAGE_LEVEL)
      const lv = mode === 'story' ? (STAGE_LEVEL[from] || 1) : 1;
      if (lv > 1) call(P, 'reset', { level: lv }); else call(P, 'reset');
      try { P.xpMul = mode === 'survival' ? survivalXpMul(1) : 1; P.xpCurve = mode === 'survival' ? SURVIVAL.xpCurve.slice() : null; } catch { /* a read-only stand-in */ }
      if (d.run) d.run.levelAtStart = level();
    },
    /** The results' level fields: level (reached), element, elementName, levelPeak, xp, progress {…} (none without it). */
    levelFields() {
      const pr = d.progressResults();
      if (!pr) return {};
      return { level: pr.level, levelPeak: pr.peak ?? pr.level, element: pr.element, elementName: pr.elementName, xp: pr.xp,
        levelStart: pr.startLevel ?? 1, levelFinale: pr.finale ?? null, progress: pr };
    },
    /** Levels for the results: { level, xp, tier, element, elementName, peak, startLevel, levelUps [...] } or null. */
    progressResults() {
      const P = progress();
      if (!P) return null;
      try {
        const s = typeof P.summary === 'function' ? P.summary() : { level: P.level, xp: P.xp, tier: P.tier, element: P.element, elementName: P.elementName, peak: P.peak ?? P.level, levelUps: [] };
        const finale = s.finale !== undefined ? s.finale : (call(P, 'finale') ?? null);
        return { ...s, finale, levelUps: (s.levelUps || []).slice(-12), startLevel: s.startLevel ?? d.run?.levelAtStart ?? 1 };
      } catch (e) { console.warn('[director] progress results', e); return null; }
    },
    cleanup() {
      schedule = [];
      plan = [];
      call(enemies(), 'clear');
      if (typeof game.titan?.despawn === 'function') call(game.titan, 'despawn');
      else if (typeof game.titan?.reset === 'function') call(game.titan, 'reset');
      call(game.fx, 'clear');
    },

    setPhase(phase) {
      const prev = d.phase;
      adhocPending = 0;
      if (prev) d.stats.phaseTimes[prev] = Math.round((d.stats.phaseTimes[prev] || 0) + d.phaseT);
      d.prevPhase = prev;
      d.phase = phase;
      d.phaseT = 0;
      schedule = [];
      plan = [];
      lastActionT = game.time.now;
      if (CHECKPOINT[phase]) d.checkpoint = CHECKPOINT[phase];
      if (phase === 'titan-rise' && d.run) d.run.titanCp = 1;       // a fresh titan
      if (phase !== 'victory' && phase !== 'defeat') d.stats.reached = phase;
      objLast = null;                                   // (a language switch re-sets only this phase's own objective)
      try { PHASE[phase]?.enter?.(); } catch (e) { console.error('[director] enter ' + phase, e); }
      game.events.emit('phase', { phase, prev });
    },
    after(t, fn) { schedule.push({ t: d.phaseT + t, fn, phase: d.phase }); },
    /** Atmosphere presets as implemented by render/atmosphere.js: afternoon | storm | victory. */
    setSky(name, seconds) {
      const list = game.atmo?.presets;
      if (list && !list.includes(name)) return;
      if (game.atmo?.preset === name && seconds > 0) return;
      call(game.atmo, 'setPreset', name, seconds);
    },
    /** Cloud weather: 'fair' restores what the clouds started with, 'storm' thickens and darkens the deck. */
    setWeather(name, seconds) {
      const c = game.clouds;
      if (typeof c?.setWeather !== 'function') return;
      if (!baseWeather && c.weather) baseWeather = { coverage: c.weather.coverage, darkness: c.weather.darkness ?? 0 };
      const base = baseWeather || { coverage: 0.45, darkness: 0 };
      const to = name === 'storm' ? { coverage: Math.min(0.85, base.coverage + 0.25), darkness: 0.75 } : { ...base };
      call(c, 'setWeather', to, seconds);
    },

    finish(outcome) {
      if (d.run?.mode === 'survival' && d.survival) { d.finishSurvival(outcome); return; }
      const s = d.stats;
      s.time = game.time.now - (s.startedAt ?? game.time.now);
      const run = d.run || d.newRun(s.reached || 'intro');
      if (!run.attempts) run.attempts = 1;
      // The run's totals over every attempt (critics: after a Retry the screen showed only the last attempt).
      const T = run.totals;
      for (const k of ['time', 'kills', 'riderKills', 'drakeKills', 'aceKills', 'damageDealt', 'damageTaken', 'titanDamage', 'healed']) T[k] += s[k] || 0;
      T.bestCombo = Math.max(T.bestCombo, s.bestCombo);
      const pa = playerActor();
      const hpLeft = pa ? pa.hp / (pa.maxHp || 1) : 0;
      const win = outcome === 'victory';
      const perf = {
        outcome, mode: run.mode, from: run.from, time: T.time, kills: T.kills, bestCombo: T.bestCombo, damageDealt: T.damageDealt,
        damageTaken: T.damageTaken, attempts: run.attempts, reached: win ? 'victory' : s.reached,
      };
      const g = gradeRun(perf);
      const score = T.riderKills * 500 + T.aceKills * 700 + T.drakeKills * 150 + T.bestCombo * 100 + Math.round(T.titanDamage)
        + (win ? 3000 + Math.round(hpLeft * 2000) + Math.round(g.rating * 6000) : Math.round(g.rating * 2000));
      // Where Retry goes, in words (the HUD shows retryLabel / reachedLabel when it has room for them).
      const ta = game.titan?.actor;
      const titanLeft = ta && ta.maxHp ? ta.hp / ta.maxHp : null;
      const cp = d.checkpoint || 'intro';
      // (the numbers are kept here: a language switch rebuilds the words from them, not from the run as it is then)
      const cpPct = !win && cp === 'titan' && run.titanCp < 0.999 ? Math.round(run.titanCp * 100) : null;
      const acesDown = !win && !!run.skip[cp]?.length;
      const reached = s.reached;
      const leftPct = !win && /^titan/.test(reached || '') && titanLeft != null && reached !== 'titan-rise' ? Math.round(titanLeft * 100) : null;
      resultsText = () => {
        let retryLabel = win ? tr('Play again') : tr(RETRY_LABEL[cp] || 'Retry');
        if (cpPct !== null) retryLabel += ` (${cpPct} %)`;
        if (acesDown) retryLabel = tr('{label} (aces down)', { label: retryLabel });
        let reachedLabel = win ? tr('The Cloud Titan falls') : PHASE_LABEL[reached] ? tr(PHASE_LABEL[reached]) : '';
        if (leftPct !== null) reachedLabel = tr('{label} · {pct} % left', { label: reachedLabel, pct: leftPct });
        return { retryLabel, reachedLabel };
      };
      const { retryLabel, reachedLabel } = resultsText();
      d.results = {
        outcome, grade: g.grade, rating: g.rating, ratingParts: g.parts, score,
        time: Math.round(T.time), kills: T.kills, riderKills: T.riderKills, drakeKills: T.drakeKills, aceKills: T.aceKills, bestCombo: T.bestCombo,
        damageDealt: Math.round(T.damageDealt), damageTaken: Math.round(T.damageTaken), titanDamage: Math.round(T.titanDamage),
        healed: Math.round(T.healed), hpLeft: Math.round(hpLeft * 100), reached: s.reached, reachedLabel, checkpoint: cp,
        retryFrom: win ? run.from : cp, retryLabel, attempts: run.attempts, mode: run.mode, from: run.from,
        attempt: { time: Math.round(s.time), kills: s.kills, damageDealt: Math.round(s.damageDealt), damageTaken: Math.round(s.damageTaken), titanDamage: Math.round(s.titanDamage) },
        ...d.levelFields(),
      };
      d.running = false;
      // Results are clicked with the mouse: release pointer lock (input's public API) so the cursor is back.
      try { game.input?.exitLock?.(); } catch { /* optional */ }
      hud('showResults', d.results);
      game.setState(outcome, { results: d.results });
    },

    // ---- events ------------------------------------------------------------------------------------------------
    onDamage(rec) {
      if (!d.running) return;
      const pa = playerActor();
      if (rec.target === pa) { d.stats.damageTaken += rec.amount; lastActionT = game.time.now; }
      else if (rec.source?.team === 'player' || (rec.source && rec.source === pa)) {
        d.stats.damageDealt += rec.amount; lastActionT = game.time.now;
        if (rec.target?.kind === 'titan') d.stats.titanDamage += rec.amount;
        // survival: Sora is fighting (combat time, no idle pressure)
        const S = d.phase === 'survival' ? d.survival : null;
        if (S && !S.ended && rec.target?.team === 'enemy' && rec.amount > 0) { S.lastHitT = d.phaseT; S.idleT = 0; }
      }
    },
    onDeath({ actor }) {
      if (!d.running || !actor) return;
      const pa = playerActor();
      if (actor === pa) {
        if (d.phase === 'survival' && d.survival) { d.survival.time = d.phaseT; d.survival.score = survivalScore(d.survival); }
        if (d.phase !== 'victory' && d.phase !== 'defeat') d.setPhase('defeat');
        return;
      }
      if (actor.kind === 'dragon' && actor.team === 'enemy') {
        const pilot = enemies()?.pilotOf?.(actor) || enemies()?.list?.find((p) => p.actor === actor) || null;
        const kind = pilot?.kind === 'drake' || /drake/i.test(actor.name || '') ? 'drake'
          : pilot?.skillName === 'ace' || /ace/i.test(actor.name || '') ? 'ace' : 'rider';
        const s = d.stats;
        s.kills++;
        if (kind === 'drake') s.drakeKills++; else s.riderKills++;
        if (kind === 'ace') s.aceKills++;
        const w = d.wave;
        w.killed++;
        if (kind === 'drake') w.drakes.killed++; else w.riders.killed++;
        const now = game.time.now;
        d.combo = { count: now - d.combo.t <= COMBO_WINDOW ? d.combo.count + 1 : 1, t: now };
        s.bestCombo = Math.max(s.bestCombo, d.combo.count);
        const S = d.phase === 'survival' ? d.survival : null;
        if (S && !S.ended) {
          // kill value × the wave it fell in
          S.kills++; S.waveKills = (S.waveKills || 0) + 1;
          if (kind === 'drake') S.drakeKills++; else S.riderKills++;
          if (kind === 'ace') S.aceKills++;
          S.killScore += (SURVIVAL.points[kind] || 0) * Math.max(1, S.wave);
          S.score = survivalScore(S);
        }
        if (pa?.alive) {
          // survival heals less, and less with every wave
          const k = S ? (SURVIVAL.heal[kind] ?? 0) * (S.def?.healMul ?? 1)
            : kind === 'drake' ? BALANCE.healPerDrake : kind === 'ace' ? BALANCE.healPerAce : BALANCE.healPerRider;
          const before = pa.hp;
          game.combat?.heal(pa, (pa.maxHp || BALANCE.player.hp) * k);
          s.healed += pa.hp - before;
        }
        d.refreshWave();
        d.updateObjective();                              // the HUD's kill feed announces the kill itself
        game.events.emit('director:kill', { actor, kind, kills: s.kills, combo: d.combo.count, left: w.left, wave: w.index });
        lastActionT = now;
        try { d.checkWaveCheckpoint(); } catch (e) { console.warn('[director] checkpoint', e); }
      }
      if (actor.kind === 'titan' && d.phase !== 'victory' && d.phase !== 'defeat') d.setPhase('victory');
    },

    // ---- waves -------------------------------------------------------------------------------------------------
    newWave(label, index = null) {
      d.wave = { index, count: WAVE_COUNT, label, phase: d.phase, total: 0, killed: 0, left: 0, pending: 0, live: 0,
        riders: { total: 0, killed: 0 }, drakes: { total: 0, killed: 0 } };
      waveStartT = game.time?.now ?? 0;
    },
    /** Queue a wave's groups (the phase's plan); groups a mid-wave checkpoint already cleared are left out. */
    planWave(def) {
      d.newWave(def.label, def.index);
      const skip = new Set(d.run?.skip?.[d.phase] || []);
      // (levels update: a wave's own hpMul / dmgMul / aimMul / homing apply to every group that does not set its own)
      const scaleOf = (g) => ({ hpMul: g.hpMul ?? def.hpMul, dmgMul: g.dmgMul ?? def.dmgMul, aimMul: g.aimMul ?? def.aimMul, homing: g.homing ?? def.homing });
      plan = def.groups.filter((g) => !(g.id && skip.has(g.id))).map((g) => ({ ...g, ...scaleOf(g), done: false }));
      if (skip.size && def.checkpoint?.label) hud('toast', tr('Checkpoint · {label}', { label: tr(def.checkpoint.label) }));
      for (const g of plan) {
        const n = g.flock ? g.flock : g.riders.length;
        d.wave.total += n;
        if (g.flock) d.wave.drakes.total += n; else d.wave.riders.total += n;
      }
      d.refreshWave();
      game.events.emit('wave', { index: def.index, count: WAVE_COUNT, label: def.label, total: d.wave.total, phase: d.phase });
    },
    /** Spawn one group now (a plan group or an ad-hoc spec such as the titan's escorts). */
    spawnGroup(g) {
      const E = enemies();
      const tag = g.tag ?? (g.id ? d.phase + ':' + g.id : d.phase);
      if (g.warn) hud('warning', tr(g.warn), 1);
      if (!E) return;
      // Survival groups also carry hpMul / dmgMul / spread / firstDives / frontDives (undefined in the story).
      let hpMul = g.hpMul, dmgMul = g.dmgMul;
      if (d.phase === 'survival' && d.survival) {
        // Levels: survival's enemies grow with Sora's level at the moment they spawn (about half of what she gains).
        const ls = survivalLevelScale(level());
        d.survival.levelScale = ls; d.survival.level = level();
        hpMul = Math.round((hpMul ?? 1) * ls.hp * 1000) / 1000; dmgMul = Math.round((dmgMul ?? 1) * ls.dmg * 1000) / 1000;
      }
      const scale = { hpMul, dmgMul, spread: g.spread, aimMul: g.aimMul, homing: g.homing, ...(g.hunter ? { hunter: true } : {}) };
      if (g.flock) call(E, 'spawnFlock', { count: g.flock, distance: g.distance, bearing: g.bearing, dy: g.dy, tag, ...scale, firstDives: g.firstDives, frontDives: g.frontDives });
      else call(E, 'spawnWave', { riders: g.riders, distance: g.distance, bearing: g.bearing, dy: g.dy, patrolTime: g.patrolTime ?? 0.6, tag, frontRuns: g.frontRuns, ...scale });
      lastActionT = game.time.now;
    },
    /** Kept for the sandbox / debugging: spawn riders now or later, counting them into the current wave. */
    spawn(spec, delay = 0) {
      const n = spec.riders?.length ?? spec.count ?? 1;
      d.wave.total += n; d.wave.riders.total += n; adhocPending += n;
      d.after(delay, () => { adhocPending -= n; call(enemies(), 'spawnWave', spec); d.refreshWave(); d.updateObjective(); });
    },
    runPlan(force = false) {
      if (!plan.length) return false;
      const remaining = liveEnemies() + queuedEnemies();
      for (const g of plan) {
        if (g.done) continue;
        const due = d.phaseT >= g.at || (g.left !== undefined && d.phaseT >= (g.minAt ?? 0) && remaining <= g.left)
          || (g.after && d.phaseT >= (g.minAt ?? 0) && d.groupDown(g.after));
        if (due || force) {
          g.done = true;
          d.spawnGroup(g);
          d.refreshWave();
          d.updateObjective();
          if (force) return true;
        }
      }
      return false;
    },
    refreshWave() {
      const w = d.wave;
      const planned = plan.reduce((n, g) => n + (g.done ? 0 : (g.flock || g.riders.length)), 0);
      w.pending = planned + queuedEnemies() + adhocPending;
      w.live = liveEnemies();
      w.left = Math.max(0, w.total - w.killed);
      w.phase = d.phase;
    },
    waveCleared() { return plan.every((g) => g.done) && liveEnemies() === 0 && queuedEnemies() === 0 && adhocPending <= 0; },
    /** Every dragon of the plan group `id` has spawned and is down (a group left out by a checkpoint counts as down). */
    groupDown(id) {
      const g = plan.find((x) => x.id === id);
      if (!g) return true;
      if (!g.done) return false;
      const E = enemies();
      if (!E) return true;
      const tag = d.phase + ':' + id;
      if ((call(E, 'pending', tag) ?? 0) > 0) return false;
      return !(E.list || []).some((p) => p.alive && p.team === 'enemy' && p.wave === tag);
    },
    /** A mid-wave checkpoint (wave 3: both aces down): a retry of this wave then starts from the rest of it. */
    checkWaveCheckpoint() {
      const def = WAVES[d.phase];
      const cp = def?.checkpoint;
      if (!cp || !d.run || d.run.skip[d.phase]) return;
      if (!cp.after.every((id) => plan.some((g) => g.id === id) && d.groupDown(id))) return;
      d.run.skip[d.phase] = [...cp.after];
      d.run.checkpointLabel = cp.label;
      hud('toast', tr('Checkpoint · {label}', { label: tr(cp.label) }));
      game.events.emit('director:checkpoint', { checkpoint: d.phase, label: cp.label });
    },
    updateObjective() {
      if (d.phase === 'survival' && d.survival) {
        const S = d.survival;
        if (!S.wave) { S.objCountdown = false; objective(() => [tr('Survive the endless waves'), tr('The Shade Riders are coming')]); return; }
        const next = Math.ceil(S.nextIn ?? Math.max(0, S.nextAt - d.phaseT));
        const need = Math.max(0, (S.quota || 0) - (S.waveKills || 0));
        const cleared = S.cleared, quota = S.holding && S.holdReason === 'quota', holding = S.holding, wave = S.wave + 1;
        // Waiting for kills: say how many (no countdown — the next wave never comes by the clock alone).
        // S.objCountdown: the line below counts down to the next wave (the HUD reads it, not the words, to leave its own
        // "next wave in" out of the survival panel — the text differs by language).
        S.objCountdown = cleared || !quota;
        objective(() => [tr('Survive the endless waves'), cleared ? tr('Sky clear · wave {wave} in {s} s', { wave, s: next })
          : quota ? tr('Shoot down {need} more to call wave {wave}', { need, wave })
            : holding ? tr('Thin them out · next wave in ≤ {s} s', { s: next }) : need > 0 ? tr('Next wave in {s} s · shoot down {need} more', { s: next, need })
              : tr('Next wave in {s} s', { s: next })]);
        return;
      }
      const w = d.wave;
      if (!w?.label || !COMBAT.has(d.phase) || d.phase === 'titan' || d.phase === 'titan-enraged') return;
      const r = Math.max(0, w.riders.total - w.riders.killed), k = Math.max(0, w.drakes.total - w.drakes.killed);
      const label = w.label;
      // "2 riders · 5 drakes left" as one sentence per case (Russian agrees the verb with the count)
      objective(() => [tr(label), r && k ? tr('{riders} · {drakes} left', { riders: trn(r, '{n} rider', '{n} riders'), drakes: trn(k, '{n} drake', '{n} drakes') })
        : r ? trn(r, '{n} rider left', '{n} riders left') : k ? trn(k, '{n} drake left', '{n} drakes left') : '']);
    },
    /** A wave phase: banner, music, the plan; the tick chains to the next phase once it is cleared. */
    enterWave(phase) {
      const def = WAVES[phase];
      const E = enemies();
      if (E) E.maxLiveRiders = def.maxRiders ?? BALANCE.maxLiveRiders;
      // levels update: the day moves on with the waves (golden hour → dusk → night → aurora) and the late waves pay more XP
      // (a start / retry AT this wave has already set its sky at once in start(): setSky is a no-op then)
      if (def.sky) d.setSky(def.sky, def.skyTime ?? 20);
      try { const P = progress(); if (P && d.run?.mode === 'story') P.xpMul = def.xpMul ?? 1; } catch { /* a read-only stand-in */ }
      d.planWave(def);
      if (def.banner) hud('banner', tr(def.banner[0]), tr(def.banner[1]));
      call(game.audio, 'music', def.music);
      d.updateObjective();
    },
    tickWave(t) {
      // 10 Hz is plenty for spawn triggers and counters (they scan the enemy list).
      waveAcc += 1 / 120;
      if (waveAcc < 0.1) return;
      waveAcc = 0;
      d.runPlan();
      d.refreshWave();
      if (t > 3 && d.waveCleared()) {
        const w = d.wave;
        d.stats.waveTimes[d.phase] = Math.round(game.time.now - waveStartT);
        game.events.emit('wave:cleared', { index: w.index, time: d.stats.waveTimes[d.phase], phase: d.phase });
        if (w.index) hud('toast', tr('Wave {n} cleared', { n: w.index }));
        d.setPhase(NEXT[d.phase]);
      }
    },

    // ---- titan escorts -------------------------------------------------------------------------------------------
    /** `count` dragons answer the titan: a few riders plus a drake flock (skipped while the sky is already full). */
    callEscorts(count, reason) {
      const E = enemies();
      if (!E) return false;
      const room = BALANCE.escortCap - liveEnemies() - queuedEnemies();
      if (room < 2) return false;
      count = Math.max(2, Math.min(Math.round(count), room));
      // Riders + a flock of at least 3 drakes (a call of 4 = 1 rider + 3 drakes, 6 = 2 + 4, 7 = 3 + 4); ≤ 3 = riders only.
      let riders = Math.max(1, Math.min(3, Math.round(count * 0.4)));
      let drakes = count - riders;
      if (count <= 3) { riders = count; drakes = 0; }
      else if (drakes < 3) { drakes = 3; riders = Math.max(1, count - 3); }
      const enraged = d.phase === 'titan-enraged';
      const skills = [];
      for (let i = 0; i < riders; i++) skills.push(enraged || i % 2 === 0 ? 'veteran' : 'rookie');
      const tag = 'escort' + (++escorts.calls);
      const bearing = (Math.random() - 0.5) * 2.4;
      if (!d.wave || d.wave.index !== 'escort') d.newWave('Titan escorts', 'escort');
      d.wave.total += riders + drakes; d.wave.riders.total += riders; d.wave.drakes.total += drakes;
      d.spawnGroup({ riders: R(...skills), distance: 560, bearing, dy: 80, patrolTime: 0.4, tag });
      if (drakes) d.spawnGroup({ flock: drakes, distance: 480, bearing: bearing + 1.2, dy: -40, tag });
      escorts.lastT = d.phaseT;
      hud('toast', reason === 'enraged' ? tr('More riders dive in') : tr('{titan} calls its Shade Riders', { titan: titanName() }));
      game.events.emit('director:escorts', { reason, riders, drakes });
      d.refreshWave();
      return true;
    },
    titanEscortTick(f, t) {
      waveAcc += 1 / 120;
      if (waveAcc < 0.1) return;
      waveAcc = 0;
      // Thresholds: escorts at 70 % HP (or after 60 s anyway so a slow fight never goes quiet).
      if (!escorts.first && (f < BALANCE.titan.escortsAt || t > 60)) {
        if (d.callEscorts(6, 'escorts')) escorts.first = true;
      }
      // Without the titan's own 'titan:call', keep a cadence: a call every ~40 s when few escorts are left.
      if (!escorts.sawCall && escorts.first && t - escorts.lastT > 40 && liveEnemies() < 3) d.callEscorts(5, 'cadence');
      d.refreshWave();
    },

    // ---- survival ------------------------------------------------------------------------------------------------
    /** The best survival run so far: { score, time, wave, kills } (each field its own best) or null. */
    survivalBest() { return bestCache ? { ...bestCache } : null; },
    loadSurvivalBest() {
      try {
        const raw = localStorage.getItem(SURVIVAL.storageKey);
        if (!raw) return null;
        const o = JSON.parse(raw);
        if (!o || typeof o !== 'object') return null;
        const f = (v) => (Number.isFinite(+v) && +v > 0 ? +v : 0);
        return { score: f(o.score), time: f(o.time), wave: f(o.wave), kills: f(o.kills) };
      } catch { return null; }                            // private mode / blocked storage: no bests, no crash
    },
    /** Merge a finished run into the bests (field by field) and store them; returns { best, newBest, prev }. */
    saveSurvivalBest(run) {
      const prev = bestCache || { score: 0, time: 0, wave: 0, kills: 0 };
      const newBest = { score: run.score > prev.score, time: run.time > prev.time, wave: run.wave > prev.wave, kills: run.kills > prev.kills };
      const best = { score: Math.max(prev.score, run.score), time: Math.max(prev.time, run.time), wave: Math.max(prev.wave, run.wave), kills: Math.max(prev.kills, run.kills) };
      bestCache = best;
      try { localStorage.setItem(SURVIVAL.storageKey, JSON.stringify({ ...best, at: new Date().toISOString() })); } catch { /* private mode */ }
      return { best: { ...best }, newBest, prev };
    },
    /** The enemies' knobs for survival wave `w` (survivalWave(n)): caps, tokens, aggression floor, potshot limiter. */
    applySurvivalKnobs(w) {
      const E = enemies();
      if (!E || !w) return;
      const qCap = SURVIVAL.capByQuality[game.quality?.name] ?? SURVIVAL.capMax;
      const cap = Math.max(8, Math.min(w.cap, qCap));
      if (d.survival) d.survival.cap = cap;
      E.maxLive = cap; E.maxLiveRiders = Math.min(w.riderCap, Math.max(2, cap - 4)); E.maxTokens = w.tokens; E.flockTokens = w.flockTokens;
      E.aggressionFloor = w.aggressionFloor; E.potshotGap = w.potshotGap; E.potshotCone = w.potshotCone;
      if (Number.isFinite(E.aggression)) E.aggression = Math.max(E.aggression, w.aggressionFloor);
    },
    /** The spawn groups of survival wave `w` from phase time t0: pairs of riders every 2.5 s (a veteran leads a
     *  rookie, the aces last; an Ace Squadron comes as one formation), a drake flock every 4 s, all from the wave's
     *  bearing range, scaled by the wave's HP / damage. */
    survivalGroups(w, t0) {
      const r = survRand, tag = 'survival:w' + w.n;
      const common = { spread: w.spread, hpMul: w.hpMul, dmgMul: w.dmgMul, aimMul: w.aimMul, homing: w.homing, tag, frontRuns: w.frontRuns };
      const bearing = () => (r() - 0.5) * w.spread;
      const groups = [];
      if (w.squadron) {
        // aces lead, veterans fly their wings
        const skills = [];
        for (let i = 0; i < Math.max(w.aces, w.veterans); i++) { if (i < w.aces) skills.push('ace'); if (i < w.veterans) skills.push('veteran'); }
        groups.push({ at: t0 + 1, riders: R(...skills), distance: 640, bearing: bearing(), dy: 60 + r() * 80, patrolTime: 1.4, warn: 'Ace squadron inbound!', ...common });
      } else {
        // pairs: a veteran leads a rookie; each ace leads a veteran (or a rookie) and the aces come last
        let v = w.veterans, k = w.rookies;
        const acePairs = [], pairs = [];
        for (let i = 0; i < w.aces; i++) {
          const wing = v > 0 ? (v--, 'veteran') : k > 0 ? (k--, 'rookie') : null;
          acePairs.push(wing ? ['ace', wing] : ['ace']);
        }
        while (v > 0 || k > 0) {
          const pair = [v > 0 ? (v--, 'veteran') : (k--, 'rookie')];
          if (k > 0) { pair.push('rookie'); k--; } else if (v > 0) { pair.push('veteran'); v--; }
          pairs.push(pair);
        }
        pairs.push(...acePairs);
        pairs.forEach((pair, p) => {
          const warn = p === 0 && w.n === 1 ? 'Shade Riders inbound' : pair[0] === 'ace' && p === pairs.length - acePairs.length ? 'An Onyx Ace joins the hunt' : null;
          groups.push({ at: t0 + 0.5 + p * 2.5, riders: R(...pair), distance: 580 + r() * 120, bearing: bearing(), dy: -30 + r() * 120, patrolTime: 0.6, warn, ...common });
        });
      }
      for (let j = 0; j < w.flocks; j++) {
        groups.push({ at: t0 + 1.5 + j * 4, flock: w.flockSize, distance: 480 + r() * 120, bearing: bearing(), dy: -60 + r() * 100,
          firstDives: w.firstDives, frontDives: w.frontDives, warn: j === 0 && w.n === 1 ? 'Drake flock rising from the valley' : null, ...common });
      }
      return groups;
    },
    enterSurvival() {
      const w0 = game.debugMode ? parseInt(game.params.get('wave'), 10) : NaN;     // ?debug&mode=survival&wave=N
      const startWave = Number.isFinite(w0) && w0 > 1 ? Math.min(w0, 60) : 1;
      survRand = rng(((Date.now() & 0x7fffffff) ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0);
      bestCache = d.loadSurvivalBest() || bestCache;
      const best = d.survivalBest();
      d.survival = {
        wave: startWave - 1, time: 0, score: 0, kills: 0, riderKills: 0, drakeKills: 0, aceKills: 0, killScore: 0, bonus: 0,
        alive: 0, riders: 0, drakes: 0, pending: 0, nextAt: SURVIVAL.firstAt, nextIn: SURVIVAL.firstAt, waveT0: 0,
        cleared: false, clears: 0, multiplier: startWave, dropped: 0, def: null, startWave, debugStart: startWave > 1,
        best, bestScore: best?.score || 0, bestTime: best?.time || 0, bestWave: best?.wave || 0, newBest: false,
        waves: [], ended: false,
        // fix pass: kills gate the waves, time scores only in the fight, idling / running raises the pressure
        waveKills: 0, quota: 0, need: 0, holdReason: null, holdT: 0, objCountdown: false,
        combatTime: 0, lastHitT: -99, idleT: 0, pressure: 0, pressureTime: 0, near: false,
        intercepts: 0, interceptors: 0, lastInterceptT: -99, tickT: 0,
      };
      d.wave = { index: 0, count: null, label: 'Survival', phase: 'survival', total: 0, killed: 0, left: 0, pending: 0, live: 0,
        riders: { total: 0, killed: 0 }, drakes: { total: 0, killed: 0 } };
      waveStartT = game.time.now;
      survObjT = -99;
      d.applySurvivalKnobs(survivalWave(startWave));
      objective(() => [tr('Survive the endless waves'), tr('The Shade Riders are coming')]);
      call(game.audio, 'music', 0.5);
    },
    /** The survival wave card of wave n in the player's language, { title, sub } ("Wave 5 · Ace Squadron", "3 Onyx Aces
     *  lead 4 Lancers · 3 drake flocks"): the director's banner, and the words for the HUD's own card (the event
     *  survival:wave carries them in English). */
    survivalWaveText(n) { return survivalCard(survivalWave(Math.max(1, Math.round(+n) || 1)), tr, trn); },
    /** The next survival wave: its groups (trimmed when the sky's backlog is already full), knobs, banner, music. */
    nextSurvivalWave(t) {
      const S = d.survival;
      if (!S) return;
      for (const g of plan) if (!g.done) { g.done = true; d.spawnGroup(g); }   // what had not come yet comes now
      const n = S.wave + 1;
      const w = survivalWave(n);
      d.applySurvivalKnobs(w);
      const groups = d.survivalGroups(w, t);
      // Backlog: live + queued stay ≤ SURVIVAL.backlog × cap — a player who cannot keep up gets the aces of the new
      // wave, not an endless queue (drake flocks go first, then rookies, then veterans).
      const count = (g) => (g.flock || g.riders.length);
      const room = Math.max(0, SURVIVAL.backlog * (S.cap ?? w.cap) - liveEnemies() - queuedEnemies());
      let total = groups.reduce((a, g) => a + count(g), 0), dropped = 0;
      while (total > room) {
        let i = -1;
        for (let j = groups.length - 1; j >= 0 && i < 0; j--) if (groups[j].flock) i = j;
        if (i >= 0) { total -= groups[i].flock; dropped += groups[i].flock; groups.splice(i, 1); continue; }
        let cut = false;
        for (const skill of ['rookie', 'veteran']) {
          for (let j = groups.length - 1; j >= 0 && !cut; j--) {
            const k = groups[j].riders?.findIndex((x) => x.skill === skill) ?? -1;
            if (k >= 0) { groups[j].riders.splice(k, 1); if (!groups[j].riders.length) groups.splice(j, 1); cut = true; }
          }
          if (cut) break;
        }
        if (!cut) break;                                   // only aces left: they always come
        total--; dropped++;
      }
      plan = groups.map((g) => ({ ...g, done: false }));
      const riders = plan.reduce((a, g) => a + (g.riders?.length || 0), 0), drakes = total - riders;
      S.wave = n; S.def = w; S.waveT0 = t; S.nextAt = t + w.duration; S.cleared = false; S.multiplier = n; S.dropped += dropped;
      // Kills beyond the last wave's quota carry over (at most half of the new one): shooting down more than needed
      // early is never wasted, and every wave still asks for a few of its own.
      const quota = survivalQuota(n, total);
      const surplus = S.wave > 0 ? Math.max(0, (S.waveKills || 0) - (S.quota || 0)) : 0;
      S.waveKills = Math.min(surplus, Math.floor(quota / 2)); S.quota = quota; S.need = Math.max(0, quota - S.waveKills);
      S.holdReason = null; S.holdT = 0;
      S.idleT = 0;                                       // a new wave (it took kills to call it): the idle clock restarts
      // Levels: deeper waves pay more XP (progress.xpMul; the curve by level stays progress.xpCurve)
      const P = progress();
      if (P) { try { P.xpMul = survivalXpMul(n); } catch { /* a read-only stand-in */ } }
      S.xpMul = survivalXpMul(n);
      S.waves.push({ wave: n, t: Math.round(t * 10) / 10, total, riders, drakes, dropped, quota: S.quota, level: level(), xpMul: S.xpMul });
      if (S.waves.length > 60) S.waves.shift();
      const W = d.wave;
      W.index = n; W.label = w.label; W.phase = 'survival';
      W.total += total; W.riders.total += riders; W.drakes.total += drakes;
      d.refreshWave();
      // The wave card (the HUD shows its own only when the director shows none) in the player's language.
      const card = survivalCard(w, tr, trn);
      hud('banner', card.title, card.sub);
      call(game.audio, 'music', w.music);
      // The day moves on: golden hour from wave 6 (a fresh run starts in the afternoon again). No storm: its thick
      // deck put the fight in the milk (first run: 85 s inside a cloud, 41 s without a hit either way at wave 12).
      // (levels update: … dusk from wave 9 and a night sky with an aurora from wave 12)
      const skyOf = (k) => (k >= 12 ? 'aurora' : k >= 9 ? 'dusk' : k >= 6 ? 'golden' : null);
      const sk = skyOf(n);
      if (sk && (skyOf(n - 1) !== sk || n === S.startWave)) d.setSky(sk, n === S.startWave ? 3 : 25);
      game.events.emit('wave', { index: n, count: null, label: w.label, total, phase: 'survival' });
      // (label / title: English data, as before the translations — the HUD words what it shows: survivalWaveText)
      game.events.emit('survival:wave', { wave: n, label: survivalCard(w, EN.tr, EN.trn).sub, title: w.label, squadron: w.squadron, riders, aces: w.aces, drakes, flocks: w.flocks,
        total, dropped, cap: w.cap, tokens: w.tokens, flockTokens: w.flockTokens, hpMul: w.hpMul, dmgMul: w.dmgMul, duration: w.duration, quota: S.quota,
        level: level(), levelHp: survivalLevelScale(level()).hp, levelDmg: survivalLevelScale(level()).dmg, xpMul: S.xpMul });
      survObjT = -99;
    },
    tickSurvival(dt, t) {
      waveAcc += 1 / 120;
      if (waveAcc < 0.1) return;
      waveAcc = 0;
      const S = d.survival;
      if (!S || S.ended) return;
      const step = Math.max(0, Math.min(0.5, t - (S.tickT || t)));
      S.tickT = t;
      S.time = t;
      const dur = S.def?.duration ?? SURVIVAL.duration[0];
      S.need = Math.max(0, (S.quota || 0) - (S.waveKills || 0));
      if (t >= S.nextAt) {
        // Due. The first wave and a wave after a clear always come. Otherwise it needs its kills (S.quota since it came;
        // no clock forces it — fix pass: a pilot who never fired reached wave 7 on the timer), then it waits while the
        // sky is still full, at most holdMax × its duration.
        const outstanding = liveEnemies() + queuedEnemies() + plan.reduce((a, g) => a + (g.done ? 0 : (g.flock || g.riders.length)), 0);
        const cap = S.cap ?? S.def?.cap ?? SURVIVAL.cap[0];
        if (!S.wave || S.cleared) { S.holding = false; d.nextSurvivalWave(t); }
        else if (S.need > 0) { S.holding = true; S.holdReason = 'quota'; S.holdT += step; }
        else {
          // the quota met: the full-sky hold counts from the later of "due" and "quota met"
          if (S.holdReason !== 'full') { S.holdReason = 'full'; S.fullSince = t; }
          const forced = t >= Math.max(S.nextAt, S.fullSince ?? t) + dur * SURVIVAL.holdMax;
          if (forced || outstanding <= cap * SURVIVAL.holdAt) { S.holding = false; d.nextSurvivalWave(t); }
          else S.holding = true;
        }
      }
      d.runPlan();
      d.refreshWave();
      const E = enemies();
      S.alive = liveEnemies();
      S.riders = call(E, 'countRiders') ?? 0; S.drakes = call(E, 'countDrakes') ?? 0;
      S.pending = d.wave?.pending ?? 0;
      S.nextIn = !S.holding ? Math.max(0, S.nextAt - t) : S.holdReason === 'quota' ? 0
        : Math.max(0, Math.max(S.nextAt, S.fullSince ?? t) + (S.def?.duration ?? dur) * SURVIVAL.holdMax - t);
      d.survivalPressure(S, t, step, dur);
      // Everything in the sky down (waves overlap, so this is all of them): a short breather, and a bonus + a little
      // HP when it came before the timer.
      if (S.wave > 0 && !S.cleared && t - S.waveT0 > 3 && plan.every((g) => g.done) && S.alive === 0 && queuedEnemies() === 0) {
        S.cleared = true; S.clears++;
        const early = t < S.nextAt - 0.5;
        const bonus = early ? SURVIVAL.clearBonus * S.wave : 0;
        S.bonus += bonus;
        const pa = playerActor();
        if (early && pa?.alive) {
          const before = pa.hp;
          game.combat?.heal(pa, (pa.maxHp || BALANCE.player.hp) * SURVIVAL.clearHeal);
          d.stats.healed += pa.hp - before;
        }
        S.nextAt = Math.min(S.nextAt, t + SURVIVAL.clearedBreak);
        S.holding = false;
        S.nextIn = Math.max(0, S.nextAt - t);
        const last = S.waves[S.waves.length - 1];
        if (last) last.clearedAt = Math.round(t * 10) / 10;
        hud('toast', bonus ? tr('Wave {n} cleared · +{bonus}', { n: S.wave, bonus }) : tr('Wave {n} cleared', { n: S.wave }));
        game.events.emit('survival:cleared', { wave: S.wave, time: Math.round((t - S.waveT0) * 10) / 10, early, bonus });
      }
      S.score = survivalScore(S);
      S.newBest = !!(S.bestScore && S.score > S.bestScore);
      if (t - survObjT >= 1) { survObjT = t; d.updateObjective(); }
    },
    /** Fight or flight (fix pass; 10 Hz from tickSurvival): combat time (a foe within SURVIVAL.combat.near m and a
     *  hit on an enemy within the last `recent` s), the idle clock (enemies up, no hit), enemies.pressure 0 → 1 after
     *  `pressure.idle` s over `ramp` s, and the Interceptors (after `intercept.idle` s idle, or a wave that waited
     *  `intercept.hold` × its duration for its kills; every `every` s, ≤ `max` hunters up). */
    survivalPressure(S, t, step, dur) {
      const E = enemies(), P = player(), pa = playerActor();
      const C = SURVIVAL.combat, PR = SURVIVAL.pressure, IC = SURVIVAL.intercept;
      let near = false, hunters = 0;
      const ppos = P?.pos;
      for (const p of E?.list || []) {
        if (!p?.alive || p.team !== 'enemy') continue;
        if (p.hunter || p.wave === 'survival:intercept') hunters++;
        const q = p.dragon?.pos;
        if (!near && ppos && q && q.distanceTo(ppos) < C.near) near = true;
      }
      S.near = near; S.interceptors = hunters;
      if (near && t - S.lastHitT <= C.recent) S.combatTime += step;
      if (S.wave > 0 && S.alive > 0 && pa?.alive !== false) S.idleT += step;
      const pr = S.wave > 0 ? clamp01((S.idleT - PR.idle) / PR.ramp) : 0;
      S.pressure = Math.round(pr * 100) / 100;
      if (pr > 0) S.pressureTime += step;
      if (E) E.pressure = S.pressure;
      const why = S.idleT >= IC.idle ? 'idle' : S.holdReason === 'quota' && S.holding && S.holdT >= IC.hold * dur ? 'hold' : null;
      if (why && S.wave > 0 && t - S.lastInterceptT >= IC.every && hunters + 2 <= IC.max) d.sendInterceptors(S, why);
    },
    /** An Interceptor pair from the player's front (readable), scaled like the current wave, always attacking. */
    sendInterceptors(S, why) {
      const w = S.def || survivalWave(Math.max(1, S.wave));
      const skills = S.wave >= 3 ? ['ace', 'veteran'] : ['veteran', 'veteran'];
      S.lastInterceptT = d.phaseT; S.intercepts++;
      const W = d.wave;
      if (W) { W.total += skills.length; W.riders.total += skills.length; }
      d.spawnGroup({
        riders: R(...skills), distance: SURVIVAL.intercept.distance, bearing: (survRand() - 0.5) * 1.2, dy: 40, patrolTime: 0.3,
        tag: 'survival:intercept', hunter: true, frontRuns: 1, hpMul: w.hpMul, dmgMul: w.dmgMul, aimMul: w.aimMul, homing: w.homing,
        warn: why === 'idle' ? 'Interceptors inbound — fight back!' : 'Interceptors inbound — shoot them down!',   // (spawnGroup translates)
      });
      d.refreshWave();
      game.events.emit('survival:intercept', { wave: S.wave, reason: why, riders: skills.slice(), count: S.intercepts, idle: Math.round(S.idleT), pressure: S.pressure });
    },
    /** The survival results (the run always ends in a defeat): wave, time, kills, score, bests (stored), a rank. */
    finishSurvival(outcome = 'defeat') {
      const S = d.survival || { wave: 0, time: 0, kills: 0, riderKills: 0, drakeKills: 0, aceKills: 0, killScore: 0, bonus: 0, waves: [], startWave: 1 };
      const s = d.stats;
      s.time = game.time.now - (s.startedAt ?? game.time.now);
      const run = d.run || d.newRun('survival');
      if (!run.attempts) run.attempts = 1;
      const time = Math.round((S.time || 0) * 10) / 10;
      const score = survivalScore({ ...S, time, combatTime: S.combatTime || 0 });
      S.score = score; S.ended = true; S.time = time;
      const rec = { score, time, wave: S.wave, kills: S.kills };
      // A debug start at a later wave (?debug&wave=N) does not touch the stored bests.
      const saved = S.debugStart ? { best: d.survivalBest() || rec, newBest: { score: false, time: false, wave: false, kills: false }, prev: bestCache }
        : d.saveSurvivalBest(rec);
      const hadBest = !!(saved.prev && (saved.prev.score || saved.prev.wave || saved.prev.time));
      const newBest = { ...saved.newBest, first: !hadBest && !S.debugStart };
      S.best = saved.best; S.bestScore = saved.best.score; S.bestTime = saved.best.time; S.bestWave = saved.best.wave;
      S.newBest = hadBest && newBest.score;
      const combatTime = Math.round((S.combatTime || 0) * 10) / 10;
      const g = gradeSurvival({ wave: S.wave, time, kills: S.kills, damageDealt: s.damageDealt, combatTime });
      const mm = Math.floor(time / 60), ss = Math.floor(time % 60);
      const clock = `${mm}:${String(ss).padStart(2, '0')}`;
      const waveN = S.wave;
      resultsText = () => ({ retryLabel: tr('Retry — Survival'), reachedLabel: tr('Survival · wave {wave} · {clock}', { wave: waveN, clock }) });
      const pa = playerActor();
      const hpLeft = pa ? Math.max(0, pa.hp) / (pa.maxHp || 1) : 0;
      d.results = {
        outcome, mode: 'survival', grade: g.grade, rating: g.rating, ratingParts: g.parts, score,
        time: Math.round(time), kills: S.kills, riderKills: S.riderKills, drakeKills: S.drakeKills, aceKills: S.aceKills, bestCombo: s.bestCombo,
        damageDealt: Math.round(s.damageDealt), damageTaken: Math.round(s.damageTaken), titanDamage: 0, healed: Math.round(s.healed),
        hpLeft: Math.round(hpLeft * 100), reached: 'survival', reachedLabel: '', checkpoint: 'survival',
        retryFrom: 'survival', retryLabel: '', attempts: 1,
        attempt: { time: Math.round(time), kills: S.kills, damageDealt: Math.round(s.damageDealt), damageTaken: Math.round(s.damageTaken), titanDamage: 0 },
        wave: S.wave, waveReached: S.wave, best: { ...saved.best }, newBest, bestScore: saved.best.score, bestTime: saved.best.time, bestWave: saved.best.wave,
        survival: { wave: S.wave, time, kills: S.kills, score, killScore: Math.round(S.killScore), timeScore: Math.floor(combatTime) * SURVIVAL.timePoints,
          combatTime, pressureTime: Math.round(S.pressureTime || 0), intercepts: S.intercepts || 0,
          bonus: S.bonus, clears: S.clears || 0, dropped: S.dropped || 0, startWave: S.startWave || 1, best: { ...saved.best }, newBest,
          waves: (S.waves || []).slice(-30) },
        combatTime,
        ...d.levelFields(),
      };
      Object.assign(d.results, resultsText());
      d.running = false;
      try { game.input?.exitLock?.(); } catch { /* optional */ }
      game.events.emit('survival:end', { wave: S.wave, time, kills: S.kills, score, best: { ...saved.best }, newBest, results: d.results });
      hud('showResults', d.results);
      game.setState(outcome, { results: d.results });
    },

    // ---- loop --------------------------------------------------------------------------------------------------
    fixedUpdate(dt) {
      if (!d.running || !d.phase) return;
      d.phaseT += dt;
      for (let i = 0; i < schedule.length; i++) {
        const e = schedule[i];
        if (e.phase !== d.phase) { schedule.splice(i--, 1); continue; }
        if (d.phaseT >= e.t) {
          schedule.splice(i--, 1);
          try { e.fn(); } catch (err) { console.error('[director] scheduled', err); }
        }
      }
      try { PHASE[d.phase]?.tick?.(dt, d.phaseT); } catch (e) { console.error('[director] tick ' + d.phase, e); }
      // Dead-air watchdog: in combat phases someone must be taking damage at least every few seconds. After DEAD_AIR s
      // with no damage either way: with no foe near, pull the wave's next group forward; otherwise (or with nothing
      // left to spawn) hurry everyone and bring the nearest riders in on head-on runs from the player's front — the
      // last enemies of a wave no longer circle for a minute (wave 4). Repeats every NUDGE_EVERY s while quiet.
      if (COMBAT.has(d.phase)) try {
        proximityAcc += dt;
        if (proximityAcc > 0.5) {
          proximityAcc = 0;
          const P = player();
          if (P && enemies()?.list?.some((p) => p.alive && p.team === 'enemy' && p.dragon.pos.distanceTo(P.pos) < 350)) lastNearT = game.time.now;
          d.checkArena(P);
        }
        const now = game.time.now;
        if (now - lastActionT > DEAD_AIR && now - lastNudgeT > NUDGE_EVERY) {
          lastNudgeT = now;
          const pulled = now - lastNearT > 1 && d.phaseT > 4 && d.runPlan(true);
          if (!pulled) {
            call(enemies(), 'hurry');
            const brought = call(enemies(), 'bringIn', 2, 8) ?? 0;
            game.events.emit('director:hurry', { phase: d.phase, brought });
          }
        }
      } catch (e) { if (!d._wdWarned) { d._wdWarned = true; console.warn('[director] watchdog', e); } }
    },

    /** Titan arena (2 Hz): the boss fight stays at the boss. Past ARENA.warn a warning; past ARENA.lash the storm
     *  lashes Sora (small 'impact' hits, a flash and a shake) until she turns back. The titan owner's pursuit brings
     *  the titan after a player who disengages; this is the director's side of it. */
    checkArena(P) {
      if (d.phase !== 'titan' && d.phase !== 'titan-enraged') return;
      const ta = titanActor(), pa = playerActor();
      if (!P?.pos || !ta?.alive || !pa?.alive) return;
      const dist = P.pos.distanceTo(ta.pos), now = game.time.now;
      if (dist < ARENA.warn) return;
      const lash = dist > ARENA.lash;
      if (now - arena.warnT > ARENA.warnEvery) {
        arena.warnT = now;
        hud('warning', lash ? tr('The storm lashes you — fly back to the Titan') : tr('Turn back — the storm walls close in'), lash ? 2 : 1);
        game.events.emit('director:arena', { dist: Math.round(dist), level: lash ? 2 : 1 });
      }
      if (lash && now - arena.lashT > ARENA.lashEvery) {
        arena.lashT = now;
        const dir = ta.pos.clone().sub(P.pos).normalize();
        try { game.combat?.damage(pa, ARENA.lashDamage, { source: null, point: P.pos.clone(), dir, kind: 'impact', part: 'body' }); } catch (e) { console.warn('[director] storm lash', e); }
        call(game.fx, 'impactFlash', P.pos.clone().addScaledVector(dir, 8).add(V(0, 5, 0)), { size: 6, ring: false });
        call(game.cameraRig, 'shake', 0.25, 0.4);
        call(game.audio, 'play', 'titan-crack', { volume: 0.45 });
      }
    },
    /** Victory: keep Sora's actor out of harm's way (its documented `invuln` seconds, refreshed each step). */
    protectPlayer() {
      const pa = playerActor();
      if (pa?.alive) pa.invuln = Math.max(pa.invuln || 0, 1);
    },
    /** A titan checkpoint retry: the titan's HP back at the last threshold it had passed (70 % / 40 %). The titan
     *  owner's spawn({ hpFrac }) does it; if that option is not there, the director sets the actor's HP (the combat
     *  Actor's public field) once, before any damage. */
    applyTitanCheckpoint() {
      const frac = d.run?.titanCp ?? 1, ta = titanActor();
      if (!ta?.alive || !(frac < 0.999)) return;
      const want = Math.max(1, Math.round((ta.maxHp || BALANCE.titan.hp) * frac));
      if (ta.hp > want) ta.hp = want;
    },

    update(dt, realDt) {
      // Auto-start after a reload retry or a debug skip, once the title is up.
      if (d.autoStart && game.state === 'title') { d.autoStart = false; d.start(pendingStart || 'intro'); }
      // Minimal retry path if the HUD has no results screen of its own.
      if ((game.state === 'defeat' || game.state === 'victory') && !game.hud) {
        if (game.input?.pressed('KeyR')) d.retry();
      }
    },
  };

  // ---- phase scripts ---------------------------------------------------------------------------------------------
  const PHASE = {
    intro: {
      enter() {
        const E = enemies();
        if (E) E.maxLiveRiders = WAVES.intro.maxRiders ?? BALANCE.maxLiveRiders;
        d.planWave(WAVES.intro);
        hud('banner', tr('Aerial Patrol'), tr('The skies over the valley'));
        if (!game.params.has('sandbox')) call(game.cameraRig, 'playCinematic', 'intro');
        objective(() => [tr('Patrol the valley')]);
        call(game.audio, 'music', WAVES.intro.music);
        d.after(5.2, () => d.updateObjective());
      },
      tick(dt, t) { d.tickWave(t); },
    },
    riders1: { enter() { d.enterWave('riders1'); }, tick(dt, t) { d.tickWave(t); } },
    riders2: { enter() { d.enterWave('riders2'); }, tick(dt, t) { d.tickWave(t); } },
    riders3: { enter() { d.enterWave('riders3'); }, tick(dt, t) { d.tickWave(t); } },
    riders4: { enter() { d.enterWave('riders4'); }, tick(dt, t) { d.tickWave(t); } },
    riders5: { enter() { d.enterWave('riders5'); }, tick(dt, t) { d.tickWave(t); } },
    riders6: { enter() { d.enterWave('riders6'); }, tick(dt, t) { d.tickWave(t); } },
    survival: { enter() { d.enterSurvival(); }, tick(dt, t) { d.tickSurvival(dt, t); } },
    'titan-rise': {
      enter() {
        d.newWave(null);
        const E = enemies();
        if (E) E.maxTokens = 2;
        try { const P = progress(); if (P && d.run?.mode !== 'survival') P.xpMul = 1; } catch { /* a read-only stand-in */ }
        call(E, 'fleeAll');
        hud('warning', tr('The sky is darkening'), 0);
        objective(() => [tr('Something stirs below the cloud sea')]);
        call(game.audio, 'music', 0.1);
        d.setSky('storm', 8);
        d.setWeather('storm', 8);
        d.after(1.5, () => { call(game.audio, 'play', 'rumble', { volume: 0.7 }); call(game.cameraRig, 'shake', 0.15, 3); });
        d.after(3, () => {
          const P = player();
          const fwd = P?.vel?.clone().setY(0).normalize() || V(0, 0, 1);
          if (typeof game.titan?.spawn === 'function') {
            call(game.titan, 'spawn', { near: P?.pos?.clone(), forward: fwd, rise: true });
          } else {
            // No titan module: keep the run completable with the titan's rider guard instead.
            titanFallback = true;
            d.newWave('Defeat the Titan guard', 'guard');
            d.wave.total = 3; d.wave.riders.total = 3;
            d.spawnGroup({ riders: R({ skill: 'ace', name: 'Onyx Ace Vael' }, 'veteran', 'veteran'), distance: 700, dy: 100, tag: 'guard' });
          }
          hud('warning', tr('Something is rising from the cloud sea!'), 2);
        });
        d.after(4, () => {
          const ta = titanActor();
          if (call(game.cameraRig, 'playCinematic', 'titan-rise') === undefined && ta) call(game.cameraRig, 'focus', ta, { duration: 5 });
        });
        d.after(7, () => { call(game.audio, 'play', 'rumble', { volume: 1 }); call(game.cameraRig, 'shake', 0.35, 2.5); });
        d.after(11, () => call(game.audio, 'music', 'boss'));   // the HUD names the titan when its phase begins
      },
      tick(dt, t) {
        if (titanFallback) { if (t > 6 && liveEnemies() === 0) d.setPhase('victory'); return; }
        if (t < 12.5) return;
        const tt = game.titan;
        const ph = typeof tt?.phase === 'string' ? tt.phase : typeof tt?.state === 'string' ? tt.state : null;
        const ready = tt?.emerged ?? (ph ? /fight|enraged/.test(ph) : undefined);
        if (ready === true || (ready === undefined && t > 14) || t > 22) d.setPhase('titan');
      },
    },
    titan: {
      enter() {
        call(game.audio, 'music', 'boss');              // objective, name card and boss bar: the HUD's defaults
        const E = enemies();
        if (E) E.maxLiveRiders = 4;
        // A titan checkpoint retry (or a direct skip) goes straight into the fight: the titan appears ahead, at the
        // HP of the last threshold it had passed, in the storm.
        if (!titanActor()?.alive && typeof game.titan?.spawn === 'function') {
          const P = player();
          const fwd = P?.vel?.clone().setY(0);
          call(game.titan, 'spawn', { near: P?.pos?.clone(), forward: fwd && fwd.lengthSq() > 1 ? fwd.normalize() : undefined, instant: true, hpFrac: d.run?.titanCp ?? 1 });
          d.applyTitanCheckpoint();
          if ((d.run?.titanCp ?? 1) < 0.999) hud('toast', tr('Checkpoint · {titan} at {pct} %', { titan: titanName(), pct: Math.round(d.run.titanCp * 100) }));
        }
      },
      tick(dt, t) {
        const ta = titanActor();
        if (!ta) { if (t > 10 && !game.titan) d.setPhase('victory'); return; }
        const f = ta.hp / (ta.maxHp || 1);
        // Titan checkpoints: past 70 % a defeat retries at 70 %, once enraged at 40 %.
        if (d.run && f < BALANCE.titan.escortsAt && d.run.titanCp > BALANCE.titan.escortsAt) d.run.titanCp = BALANCE.titan.escortsAt;
        d.titanEscortTick(f, t);
        if (f < BALANCE.titan.enrageAt) d.setPhase('titan-enraged');
      },
    },
    'titan-enraged': {
      enter() {
        // The HUD shows its own "enraged" warning and objective for this phase.
        if (d.run) d.run.titanCp = Math.min(d.run.titanCp, BALANCE.titan.enrageAt);
        call(game.titan, 'setEnraged', true);
        call(game.audio, 'play', 'roar', { volume: 1 });
        call(game.cameraRig, 'shake', 0.3, 1.5);
        escorts.lastT = 0;
        d.after(8, () => {
          if (escorts.second) return;
          if (d.callEscorts(7, 'enraged')) escorts.second = true;
        });
      },
      tick(dt, t) {
        const ta = titanActor();
        if (!ta) return;
        waveAcc += 1 / 120;
        if (waveAcc < 0.1) return;
        waveAcc = 0;
        if (!escorts.second && t > 8) { if (d.callEscorts(7, 'enraged')) escorts.second = true; }
        if (!escorts.sawCall && escorts.second && t - escorts.lastT > 40 && liveEnemies() < 3) d.callEscorts(5, 'cadence');
        d.refreshWave();
      },
    },
    victory: {
      enter() {
        call(enemies(), 'fleeAll');
        d.protectPlayer();
        objective(() => ['']);
        hud('banner', tr('Victory'), titanFallback ? tr('The Shade Riders scatter') : tr('{titan} falls into the cloud sea', { titan: titanName() }));
        d.setSky('victory', 6);
        d.setWeather('fair', 10);
        call(game.audio, 'music', 'victory');
        const ta = titanActor();
        if (ta) call(game.cameraRig, 'focus', ta, { duration: 3 });
        d.after(2.5, () => call(game.cameraRig, 'playCinematic', 'victory'));
        d.after(6.5, () => d.finish('victory'));
      },
      // The fight is over: nothing still in the air (a last fireball, the titan's fall) may shoot Sora down during
      // the victory cinematic (run 1: 154 → 19 HP after the titan fell).
      tick() { d.protectPlayer(); },
    },
    defeat: {
      enter() {
        call(enemies(), 'fleeAll');
        if (d.survival) d.survival.objCountdown = false;
        objective(() => ['']);
        const S = d.run?.mode === 'survival' ? d.survival : null;
        if (S) {
          const tt = Math.floor(S.time || 0);
          hud('banner', tr('Shot Down'), tr('You held the sky for {time} · wave {wave}', { time: `${Math.floor(tt / 60)}:${String(tt % 60).padStart(2, '0')}`, wave: S.wave }));
        } else hud('banner', tr('Shot Down'), tr('Sora spirals into the clouds'));
        call(game.audio, 'music', 0);
        d.after(4, () => d.finish('defeat'));
      },
    },
  };

  return d;
}
