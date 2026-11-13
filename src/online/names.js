// Pilot names and leaderboard entries: the rules both the client and firestore.rules enforce (keep them in step).
export const NAME_MIN = 3, NAME_MAX = 16;
// letters and digits of any script, spaces and . _ - (names are only ever shown as text, never as markup; the server
// checks the length — firestore.rules)
export const NAME_RE = /^[\p{L}\p{N} _.\-]+$/u;
/** The boards and the highest score the server accepts on each (firestore.rules has the same numbers). */
export const BOARDS = ['story', 'titan', 'survival'];
export const SCORE_CAP = { story: 200000, titan: 80000, survival: 5000000 };
export const MAX_LEVEL = 15;

/** A typed name → the stored one: trimmed, inner runs of spaces collapsed. */
export function cleanName(s) { return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX); }
/** '' when the name is fine, else the reason in plain words. */
export function nameProblem(s) {
  const n = cleanName(s);
  if (n.length < NAME_MIN) return `Pilot names need at least ${NAME_MIN} characters.`;
  if (!NAME_RE.test(n)) return 'Use letters, numbers, spaces and . _ - only.';
  return '';
}
/** A name from a display name (a Google profile's): invalid characters dropped; too short → "Pilot 123". Never built
 *  from an email address — a leaderboard name is public. */
export function nameFrom(s, fallback = 'Pilot') {
  let n = cleanName(String(s ?? '').replace(/@.*$/, '').replace(/[^\p{L}\p{N} _.\-]/gu, ''));
  if (n.length < NAME_MIN) n = cleanName(`${fallback} ${Math.floor(100 + Math.random() * 900)}`);
  return n;
}
const int = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number.isFinite(+v) ? +v : 0)));
/** A run's results → the leaderboard entry (every field typed and bounded the way the rules check it). */
export function cleanEntry(board, e = {}) {
  return {
    score: int(e.score, 0, SCORE_CAP[board] ?? 0),
    grade: /^[SABCD]$/.test(e.grade) ? e.grade : '',
    time: int(e.time, 0, 86400),
    kills: int(e.kills, 0, 100000),
    combo: int(e.combo, 0, 100000),
    level: int(e.level || 1, 1, MAX_LEVEL),
    wave: int(e.wave, 0, 100000),
    outcome: e.outcome === 'victory' ? 'victory' : 'defeat',
  };
}
/** What a run reached, in words (the leaderboard's "Reached" column). */
export function reachedText(board, e) {
  if (!e) return '';
  if (board === 'survival') return e.wave > 0 ? `Wave ${e.wave}` : '—';
  if (e.outcome === 'victory') return 'Victory';
  if (board === 'titan') return 'Titan';
  return e.wave >= 7 ? 'Titan' : e.wave >= 1 ? `Wave ${e.wave}` : 'Patrol';
}
export function clock(sec) {
  const t = Math.max(0, Math.floor(+sec || 0));
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
