// game.online — pilot accounts, the leaderboards and stage progress (system 'online', order 22).
//
// Two ways to run:
//   online  firebase-config.js is filled in: email + password accounts (and Google when it is switched on), global
//           leaderboards in Cloud Firestore, stage progress kept with the account. The page stays a static site —
//           GitHub Pages serves the files, Firebase is the only server.
//   local   no config: no accounts; a pilot name, this device's own best runs and stage progress in localStorage.
// Either way the device keeps its own records (LOCAL below), so a guest's runs are never lost: a best run flown while
// signed out is posted the next time the pilot signs in.
//
//   online.mode        'online' | 'local'
//   online.status      'loading' | 'ready' | 'error'   (online mode: the SDK and the first auth answer)
//   online.user        { uid, name, email } | null     (local mode: null)
//   online.name        the pilot's name as shown (account name, else the local name, else 'Guest')
//   online.signUp / signIn / signInGoogle / signOut / resetPassword / setName
//   online.top(board, n) → rows · online.standing(board) → { best, rank } · online.localBoard(board) → rows
//   online.last        the last run's posting: { board, entry, state: 'posted'|'kept'|'local'|'guest'|'ineligible'|'error',
//                      rank, improved, error } | null
//   online.stage / stageTimes / unlocked(i)            stage progress (the stage select)
// Events: 'online:auth' { user }, 'online:status' { status, mode }, 'online:score' online.last, 'online:progress' {}.
// Boards: story (a whole run from the Aerial Patrol), titan ("Face the Titan"), survival. A run started at a later
// stage, or with ?debug, is not ranked. Scores are computed in the browser, so the server can only bound them
// (firestore.rules) — good enough for a leaderboard among friends, not cheat-proof.
import { BOARDS, cleanEntry, cleanName, nameProblem, reachedText } from './names.js';

const KEY = 'skyfire.online.v1';
const LOCAL_ROWS = 20;
const blank = () => ({ name: '', bests: {}, pending: {}, rows: {}, stage: 0, stageTimes: {} });

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!s || typeof s !== 'object') return blank();
    const b = blank();
    return { ...b, ...s, bests: { ...s.bests }, pending: { ...s.pending }, rows: { ...s.rows }, stageTimes: { ...s.stageTimes }, stage: Math.max(0, Math.round(+s.stage || 0)), name: cleanName(s.name) };
  } catch { return blank(); }
}
function save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private window */ } }

/** The story's progress number of a phase (director PROGRESS): waves 1–6, the titan 7 / 8. */
const REACHED = { intro: 0, riders1: 1, riders2: 2, riders3: 3, riders4: 4, riders5: 5, riders6: 6, 'titan-rise': 7, titan: 7, 'titan-enraged': 8 };

/** A run's results (the director's) → { board, entry } or null when the run is not ranked. */
export function entryOf(r, { debug = false } = {}) {
  if (!r || typeof r !== 'object' || debug) return null;
  let board = null;
  if (r.mode === 'survival') board = r.survival?.startWave > 1 ? null : 'survival';
  else if (r.mode === 'titan') board = 'titan';
  else if (r.mode === 'story' && (r.from ?? 'intro') === 'intro') board = 'story';
  if (!board || !(r.score > 0)) return null;
  const wave = board === 'survival' ? (r.wave ?? r.survival?.wave ?? 0) : (REACHED[r.reached] ?? 0);
  return { board, entry: cleanEntry(board, { score: r.score, grade: r.grade, time: r.time, kills: r.kills, combo: r.bestCombo, level: r.levelPeak ?? r.level, wave, outcome: r.outcome }) };
}

export default function createOnline(game) {
  const L = load();
  let backend = null, unsub = null, busy = 0;
  const cfg = (() => { const c = globalThis.SKYFIRE_FIREBASE; return c && typeof c === 'object' && c.apiKey && c.projectId ? c : null; })();
  // local development against the Firebase emulators: ?fbemu=1 on localhost (a demo project, nothing leaves the machine)
  const emu = game.params?.get?.('fbemu') === '1' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const emit = (name, p) => { try { game.events.emit(name, p); } catch (e) { console.warn('[online] emit', e); } };
  const stagesList = () => { try { return game.director?.stages?.() || []; } catch { return []; } };

  const O = {
    name: 'online',
    mode: cfg || emu ? 'online' : 'local',
    status: cfg || emu ? 'loading' : 'ready',
    error: '',
    user: null,
    last: null,
    get google() { return !!backend?.google; },
    get pilot() { return O.user?.name || L.name || 'Guest'; },
    get localName() { return L.name; },
    get stage() { return L.stage; },
    get stageTimes() { return { ...L.stageTimes }; },
    /** Stage i (0 = the Aerial Patrol) can be started: reached before, or the Titan (always open: "Face the Titan"). */
    unlocked(i) { const s = stagesList()[i]; return i <= L.stage || s?.phase === 'titan-rise'; },
    explain(e) { return backend?.explain ? backend.explain(e) : String(e?.message || e); },

    init() {
      try {
        game.events.on('state', ({ next, results }) => { if ((next === 'victory' || next === 'defeat') && results) O.onRunEnd(results); });
        game.events.on('phase', ({ phase }) => O.onPhase(phase));
        game.events.on('wave:cleared', (e) => O.onWaveCleared(e));
      } catch (e) { console.warn('[online] listeners', e); }
      // The SDK loads behind the title screen: the game never waits for the network.
      if (O.mode === 'online') O.connect();
    },

    async connect() {
      try {
        const { createFirebaseBackend } = await import('./backend-firebase.js');
        backend = await createFirebaseBackend(emu ? { apiKey: 'demo-key', authDomain: 'demo-skyfire.firebaseapp.com', projectId: 'demo-skyfire', appId: 'demo', google: !!cfg?.google, ...(cfg || {}) } : cfg,
          emu ? { emulator: { auth: 'http://127.0.0.1:9099', firestore: ['127.0.0.1', 8080] } } : {});
        unsub = backend.onAuth((u) => O.onAuth(u));
      } catch (e) {
        console.warn('[online] could not start', e);
        O.status = 'error'; O.error = 'Online play could not start: ' + (e?.message || e);
        emit('online:status', { status: O.status, mode: O.mode, error: O.error });
      }
    },

    onAuth(u) {
      const was = O.user?.uid || null;
      O.user = u;
      if (O.status !== 'ready') { O.status = 'ready'; O.error = ''; }
      emit('online:status', { status: O.status, mode: O.mode });
      emit('online:auth', { user: u });
      // a session restored at load: sync now. A sign-in / sign-up in progress syncs when it has finished (the new
      // account has its name by then — a pending score must never be posted under a placeholder).
      if (u && u.uid !== was && !busy) O.afterSignIn();
    },
    afterSignIn() { O.syncProgress(); O.postPending(); },
    async during(fn) {
      busy++;
      try { const u = await fn(); if (u) { O.user = u; emit('online:auth', { user: u }); } return u; }
      finally { busy--; if (!busy && O.user) O.afterSignIn(); }
    },

    // ---- accounts --------------------------------------------------------------------------------------------
    need() { if (!backend) throw new Error(O.status === 'loading' ? 'Still connecting — try again in a moment.' : O.error || 'Online play is not set up for this copy of the game.'); return backend; },
    async signUp(email, password, name) { const b = O.need(); return O.during(() => b.signUp(email, password, name)); },
    async signIn(email, password) { const b = O.need(); return O.during(() => b.signIn(email, password)); },
    async signInGoogle() { const b = O.need(); return O.during(() => b.signInGoogle()); },
    async signOut() { await O.need().signOut(); },
    async resetPassword(email) { return O.need().resetPassword(email); },
    /** Rename the pilot (the account's name online; the device's own name in local mode). */
    async setName(name) {
      const bad = nameProblem(name);
      if (bad) throw new Error(bad);
      if (O.mode === 'online' && O.user) { const u = await O.need().setName(name); O.user = u; emit('online:auth', { user: u }); return u.name; }
      L.name = cleanName(name); save(L);
      emit('online:auth', { user: O.user });
      return L.name;
    },

    // ---- scores ----------------------------------------------------------------------------------------------
    /** The end of a run: keep it on the device, post it when a pilot is signed in. */
    async onRunEnd(results) {
      const e = entryOf(results, { debug: !!game.debugMode });
      if (!e) { O.last = { board: null, entry: null, state: 'ineligible' }; emit('online:score', O.last); return O.last; }
      const { board, entry } = e;
      const prevLocal = L.bests[board] || null;
      const localBest = !prevLocal || entry.score > prevLocal.score;
      if (localBest) L.bests[board] = { ...entry, at: Date.now() };
      // this device's own table (local mode shows it): the best LOCAL_ROWS runs
      const rows = (L.rows[board] || []).concat([{ name: O.pilot, ...entry, at: Date.now() }]).sort((a, b) => b.score - a.score).slice(0, LOCAL_ROWS);
      L.rows[board] = rows;
      const last = { board, entry, state: 'local', rank: null, improved: localBest, localBest, prev: prevLocal, error: '' };
      if (O.mode !== 'online') { last.rank = rows.findIndex((r) => r.score === entry.score && r.time === entry.time) + 1 || null; save(L); O.last = last; emit('online:score', last); return last; }
      if (!O.user || !backend) {
        // a guest's best waits on the device until they sign in
        if (!L.pending[board] || entry.score > L.pending[board].score) L.pending[board] = { ...entry };
        save(L);
        last.state = O.status === 'error' ? 'error' : 'guest'; last.error = O.error;
        O.last = last; emit('online:score', last); return last;
      }
      save(L);
      last.state = 'posting';
      O.last = last; emit('online:score', last);
      try {
        const res = await backend.submitScore(board, entry);
        let rank = null;
        try { rank = await backend.rank(board, res.best.score); } catch (err) { console.warn('[online] rank', err); }
        // (the state changes last: whoever reads 'posted' / 'kept' finds the place with it)
        last.improved = res.improved; last.best = res.best; last.prev = res.prev; last.rank = rank;
        last.state = res.improved ? 'posted' : 'kept';
        if (L.pending[board] && L.pending[board].score <= res.best.score) { delete L.pending[board]; save(L); }
      } catch (err) {
        console.warn('[online] submit', err);
        last.state = 'error'; last.error = O.explain(err);
        if (!L.pending[board] || entry.score > L.pending[board].score) { L.pending[board] = { ...entry }; save(L); }
      }
      if (O.last === last) emit('online:score', last);
      return last;
    },
    /** Post the bests a guest flew before signing in (quietly; a failure keeps them for the next time). */
    async postPending() {
      if (!backend || !O.user) return;
      for (const board of BOARDS) {
        const e = L.pending[board];
        if (!e) continue;
        try { await backend.submitScore(board, e); delete L.pending[board]; save(L); }
        catch (err) { console.warn('[online] pending ' + board, err); }
      }
      emit('online:progress', {});
    },
    /** The top of a board: the server's in online mode, this device's own runs otherwise. → { rows, source } */
    async top(board, n = 50) {
      if (O.mode === 'online' && backend) return { rows: await backend.top(board, n), source: 'online' };
      if (O.mode === 'online') throw new Error(O.status === 'loading' ? 'Connecting…' : O.error || 'Offline');
      return { rows: O.localBoard(board), source: 'local' };
    },
    localBoard(board) { return (L.rows[board] || []).map((r) => ({ ...r })); },
    localBest(board) { return L.bests[board] ? { ...L.bests[board] } : null; },
    /** The signed-in pilot's best and place on a board: { best, rank } (nulls when there is none). */
    async standing(board) {
      if (O.mode !== 'online' || !backend || !O.user) { const best = O.localBest(board); return { best, rank: null }; }
      const best = await backend.mine(board);
      let rank = null;
      if (best) { try { rank = await backend.rank(board, best.score); } catch (e) { console.warn('[online] rank', e); } }
      return { best, rank };
    },
    reachedText,

    // ---- stage progress --------------------------------------------------------------------------------------
    onPhase(phase) {
      try {
        if (game.debugMode || game.director?.run?.mode !== 'story') return;
        const i = stagesList().findIndex((s) => s.phase === phase);
        if (i > L.stage) { L.stage = i; save(L); emit('online:progress', {}); O.pushProgress(); }
      } catch (e) { console.warn('[online] phase', e); }
    },
    onWaveCleared(e) {
      try {
        if (game.debugMode || !e?.phase || !(e.time > 0) || game.director?.run?.mode !== 'story') return;
        const cur = L.stageTimes[e.phase];
        if (!cur || e.time < cur) { L.stageTimes[e.phase] = Math.round(e.time); save(L); emit('online:progress', {}); O.pushProgress(); }
      } catch (err) { console.warn('[online] wave time', err); }
    },
    /** Signed in: the account and the device agree on the furthest stage and the best clear times. */
    async syncProgress() {
      if (!backend || !O.user) return;
      try {
        const remote = await backend.loadProgress();
        let changed = false;
        if (remote) {
          if (remote.stage > L.stage) { L.stage = remote.stage; changed = true; }
          for (const [k, v] of Object.entries(remote.stageTimes || {})) if (v > 0 && (!L.stageTimes[k] || v < L.stageTimes[k])) { L.stageTimes[k] = Math.round(v); changed = true; }
        }
        if (changed) { save(L); emit('online:progress', {}); }
        await backend.saveProgress({ stage: L.stage, stageTimes: L.stageTimes });
      } catch (e) { console.warn('[online] progress sync', e); }
    },
    pushProgress() { if (backend && O.user) backend.saveProgress({ stage: L.stage, stageTimes: L.stageTimes }).catch((e) => console.warn('[online] progress save', e)); },
    dispose() { try { unsub?.(); } catch { /* ignore */ } },
  };
  return O;
}
