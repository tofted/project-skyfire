// Results rank when the director does not grade the run itself (the sandbox, an older director). The wave-4 director
// grades from pace, survival, offense and kills (director.js gradeRun: victory S / A / B, defeat C / D) and the
// results screen shows its grade; this fallback keeps the same shape:
//   defeat:  D below 1,000 score, else C (a defeat never ranks above C)
//   victory: B, A with ≥ 30 % HP left or score ≥ 12,000, S with ≥ 60 % HP left inside par time
//            (par: the story 35:00, "Face the Titan" 15:00)
// Pure functions, no DOM. Languages (29.09): the hints go through tr() (src/ui/i18n.js; Russian in ru-menus.js) —
// DEFEAT_CAP is rebuilt on a language change (a live binding: importers read the new text), PHASE_LABEL's getters and
// rankRun() / reachedLabel() answer in the language in use.
import { tr, onLang } from './i18n.js';
import { fmt } from './dom.js';

/** A text another module wrote (the director, hud.js), shown in the language in use: translated here only while it is
 *  still English — a text that is already Cyrillic passes (so a caller that translated it first is not translated twice). */
export function trData(s) {
  return typeof s === 'string' && /[A-Za-z]/.test(s) && !/[\u0400-\u04FF]/.test(s) ? tr(s) : s;
}

export const RANK_RULES = {
  defeat: [['D', 0], ['C', 1000]],
  victoryA: { hpLeft: 30, score: 12000 },
  victoryS: { hpLeft: 60 },
  par: { story: 3300, titan: 900 },
};

/** Segments keep their words together, so a narrow screen breaks the line only at " · ". */
const keep = (...segs) => segs.map((x) => x.replace(/ /g, '\u00a0')).join(' · ');
/** The line under a defeat's rank (rebuilt in the new language on a language change). */
const defeatCap = () => keep(tr('A defeat ranks C at most'), tr('a victory earns B, A or S'));
export let DEFEAT_CAP = defeatCap();
onLang(() => { DEFEAT_CAP = defeatCap(); });

const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const n = (x) => fmt(x);                        // (29.09) "8,300" / Russian "8 300" — dom.js fmt

/**
 * r: { outcome 'victory'|'defeat', score, time (s), hpLeft (0..100) }; mode 'story' | 'titan'.
 * → { grade, next }: next = a short hint toward the next rank, in the language in use ('' when there is none).
 */
export function rankRun(r = {}, { mode = 'story' } = {}) {
  const score = Math.max(0, num(r.score));
  const win = r.outcome === 'victory';
  if (!win) {
    const steps = RANK_RULES.defeat;
    let i = 0;
    for (let k = 0; k < steps.length; k++) if (score >= steps[k][1]) i = k;
    const up = steps[i + 1];
    return { grade: steps[i][0], next: up ? keep(tr('Rank {rank} from {score} score', { rank: up[0], score: n(up[1]) }), tr('a victory earns B, A or S')) : DEFEAT_CAP };
  }
  const hp = num(r.hpLeft, 0), time = num(r.time, 1e9);
  const par = RANK_RULES.par[mode === 'titan' ? 'titan' : 'story'];
  if (hp >= RANK_RULES.victoryS.hpLeft && time <= par) return { grade: 'S', next: '' };
  if (hp >= RANK_RULES.victoryA.hpLeft || score >= RANK_RULES.victoryA.score) {
    return { grade: 'A', next: keep(tr('Rank S: {hp} % HP left', { hp: RANK_RULES.victoryS.hpLeft }), tr('under {time}', { time: mmss(par) })) };
  }
  return { grade: 'B', next: keep(tr('Rank A: {hp} % HP left', { hp: RANK_RULES.victoryA.hpLeft }), tr('or {score} score', { score: n(RANK_RULES.victoryA.score) })) };
}

/** Where Retry restarts, as the player reads it (getters: the language in use). */
export const PHASE_LABEL = {
  get intro() { return tr('Patrol'); },
  get riders1() { return tr('Wave {n}', { n: 1 }); },
  get riders2() { return tr('Wave {n}', { n: 2 }); },
  get riders3() { return tr('Wave {n}', { n: 3 }); },
  get riders4() { return tr('Wave {n}', { n: 4 }); },
  get riders5() { return tr('Wave {n}', { n: 5 }); },
  get riders6() { return tr('Wave {n}', { n: 6 }); },
  get 'titan-rise'() { return tr('The Titan'); },
  get titan() { return tr('The Titan'); },
  get 'titan-enraged'() { return tr('The Titan'); },
};
/** What the run reached, with the wave's name when the director has one ("Wave 3 · The Onyx Aces"). */
export function reachedLabel(phase, waves) {
  if (!phase) return '';
  const b = waves?.[phase]?.banner?.[0];
  if (typeof b === 'string' && b) return trData(b);
  if (phase === 'intro') return tr('Aerial Patrol');
  if (/^titan/.test(phase)) return phase === 'titan-enraged' ? tr('The Cloud Titan · enraged') : tr('The Cloud Titan');
  return PHASE_LABEL[phase] || '';
}
