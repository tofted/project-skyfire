// Online backend: Firebase Authentication + Cloud Firestore (the "lite" REST client — no listeners, no cache).
// Loaded on demand (the SDK is vendored in vendor/firebase, ~420 kB, fetched only when firebase-config.js is filled in),
// so a copy without a config never downloads or runs it.
//
// Data (firestore.rules guards every write):
//   players/{uid}                { name, nameLower, created, updated, stage, stageTimes { <phase>: seconds } }
//   boards/{board}/scores/{uid}  { uid, name, score, grade, time, kills, combo, level, wave, outcome, at, v }
//                                one document per pilot and board = that pilot's best run; board: story | titan | survival
import { cleanEntry, cleanName, nameFrom, nameProblem, BOARDS } from './names.js';

const SDK = new URL('../../vendor/firebase/', import.meta.url).href;
const withTimeout = (p, ms = 15000, what = 'The server') => Promise.race([p,
  new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error(`${what} took too long to answer.`), { code: 'timeout' })), ms))]);

/** Firebase's error codes in plain words (anything else: its own message, shortened). */
export function explain(e) {
  const code = String(e?.code || '');
  const M = {
    'auth/invalid-email': 'That email address does not look right.',
    'auth/missing-email': 'Enter your email address.',
    'auth/missing-password': 'Enter your password.',
    'auth/email-already-in-use': 'An account with that email already exists — sign in instead.',
    'auth/weak-password': 'Pick a password with at least 6 characters.',
    'auth/invalid-credential': 'Wrong email or password.',
    'auth/wrong-password': 'Wrong email or password.',
    'auth/user-not-found': 'Wrong email or password.',
    'auth/invalid-login-credentials': 'Wrong email or password.',
    'auth/user-disabled': 'This account has been disabled.',
    'auth/too-many-requests': 'Too many attempts — wait a minute and try again.',
    'auth/network-request-failed': 'No connection to the server. Check your internet and try again.',
    'auth/popup-closed-by-user': 'The sign-in window was closed before it finished.',
    'auth/cancelled-popup-request': 'The sign-in window was closed before it finished.',
    'auth/popup-blocked': 'Your browser blocked the sign-in window — allow pop-ups for this page and try again.',
    'auth/operation-not-allowed': 'This sign-in method is not switched on for this game yet.',
    'auth/unauthorized-domain': 'This web address is not on the game\'s list of allowed sites yet (Firebase → Authentication → Settings → Authorized domains).',
    'auth/requires-recent-login': 'Sign out and in again, then retry.',
    'permission-denied': 'The server refused that (check that firestore.rules is published).',
    'unavailable': 'The leaderboard server cannot be reached right now.',
    'unauthenticated': 'Sign in first.',
    'not-found': 'The leaderboard database does not exist yet (create Firestore in the Firebase console).',
    'failed-precondition': 'The leaderboard database is not ready yet.',
    'resource-exhausted': 'The leaderboard is over its free quota for today. Try again tomorrow.',
    timeout: e?.message,
  };
  if (M[code]) return M[code];
  const m = String(e?.message || e || 'Something went wrong.').replace(/^Firebase:\s*/i, '').replace(/\s*\(([a-z-]+\/[a-z-]+)\)\.?$/i, '');
  return m.length > 160 ? m.slice(0, 157) + '…' : m;
}

/**
 * cfg: { apiKey, authDomain, projectId, appId, google }. opts.emulator: { auth: 'http://127.0.0.1:9099', firestore:
 * ['127.0.0.1', 8080] } (local development only). Resolves the backend, or rejects when the SDK cannot be loaded.
 */
export async function createFirebaseBackend(cfg, opts = {}) {
  const [appMod, A, F] = await withTimeout(Promise.all([
    import(SDK + 'firebase-app.js'), import(SDK + 'firebase-auth.js'), import(SDK + 'firebase-firestore-lite.js'),
  ]), 30000, 'Loading the online library');
  const app = appMod.initializeApp({ apiKey: cfg.apiKey, authDomain: cfg.authDomain, projectId: cfg.projectId, appId: cfg.appId });
  const auth = A.getAuth(app);
  const db = F.getFirestore(app);
  if (opts.emulator) {
    try { A.connectAuthEmulator(auth, opts.emulator.auth, { disableWarnings: true }); } catch (e) { console.warn('[online] auth emulator', e); }
    try { F.connectFirestoreEmulator(db, opts.emulator.firestore[0], opts.emulator.firestore[1]); } catch (e) { console.warn('[online] firestore emulator', e); }
  }
  const scores = (board) => F.collection(db, 'boards', board, 'scores');
  const scoreDoc = (board, uid) => F.doc(db, 'boards', board, 'scores', uid);
  const playerDoc = (uid) => F.doc(db, 'players', uid);
  // (a pilot without a display name yet — the instant between creating the account and naming it — is 'Pilot')
  const toUser = (u) => (u ? { uid: u.uid, name: cleanName(u.displayName) || 'Pilot', named: !!cleanName(u.displayName), email: u.email || '', provider: u.providerData?.[0]?.providerId || 'password' } : null);
  const me = () => { const u = auth.currentUser; if (!u) throw Object.assign(new Error('Sign in first.'), { code: 'unauthenticated' }); return u; };
  const row = (snap) => { const d = snap.data() || {}; return { uid: d.uid || snap.id, name: String(d.name || 'Pilot'), ...cleanEntryKeep(d), at: d.at?.toMillis?.() ?? null }; };
  // (a stored entry is shown as stored: only its types are normalised — no board cap is applied when reading)
  function cleanEntryKeep(d) { const e = cleanEntry('survival', d); return e; }

  /** players/{uid}: create it on first sign-in, keep the name in step. */
  async function ensurePlayer(u, name) {
    const ref = playerDoc(u.uid);
    const snap = await withTimeout(F.getDoc(ref));
    const n = cleanName(name || u.displayName) || nameFrom('');
    if (!snap.exists()) await withTimeout(F.setDoc(ref, { name: n, nameLower: n.toLowerCase(), created: F.serverTimestamp(), updated: F.serverTimestamp(), stage: 0, stageTimes: {} }));
    else if (snap.data().name !== n) await withTimeout(F.setDoc(ref, { name: n, nameLower: n.toLowerCase(), updated: F.serverTimestamp() }, { merge: true }));
    return snap.exists() ? snap.data() : null;
  }

  const backend = {
    kind: 'firebase',
    google: !!cfg.google,
    explain,
    /** cb(user | null) now and on every change. Returns the unsubscribe function. */
    onAuth(cb) { return A.onAuthStateChanged(auth, (u) => { try { cb(toUser(u)); } catch (e) { console.warn('[online] auth listener', e); } }); },
    get user() { return toUser(auth.currentUser); },

    async signUp(email, password, name) {
      const bad = nameProblem(name);
      if (bad) throw new Error(bad);
      const n = cleanName(name);
      const cred = await withTimeout(A.createUserWithEmailAndPassword(auth, String(email).trim(), password));
      await withTimeout(A.updateProfile(cred.user, { displayName: n }));
      try { await ensurePlayer(cred.user, n); } catch (e) { console.warn('[online] player profile', e); }
      return toUser(auth.currentUser);
    },
    async signIn(email, password) {
      const cred = await withTimeout(A.signInWithEmailAndPassword(auth, String(email).trim(), password));
      try { await ensurePlayer(cred.user); } catch (e) { console.warn('[online] player profile', e); }
      return toUser(cred.user);
    },
    async signInGoogle() {
      const cred = await withTimeout(A.signInWithPopup(auth, new A.GoogleAuthProvider()), 120000, 'The sign-in window');
      const n = cleanName(cred.user.displayName) && !nameProblem(cred.user.displayName) ? cleanName(cred.user.displayName) : nameFrom(cred.user.displayName);
      if (n !== cred.user.displayName) { try { await A.updateProfile(cred.user, { displayName: n }); } catch { /* keeps the Google name */ } }
      try { await ensurePlayer(cred.user, n); } catch (e) { console.warn('[online] player profile', e); }
      return toUser(auth.currentUser);
    },
    async signOut() { await A.signOut(auth); },
    async resetPassword(email) { await withTimeout(A.sendPasswordResetEmail(auth, String(email).trim())); },
    /** Rename: the auth profile, the player document and the name on this pilot's leaderboard rows. */
    async setName(name) {
      const bad = nameProblem(name);
      if (bad) throw new Error(bad);
      const u = me(), n = cleanName(name);
      await withTimeout(A.updateProfile(u, { displayName: n }));
      await withTimeout(F.setDoc(playerDoc(u.uid), { name: n, nameLower: n.toLowerCase(), updated: F.serverTimestamp() }, { merge: true }));
      await Promise.all(BOARDS.map(async (b) => {
        try {
          const snap = await withTimeout(F.getDoc(scoreDoc(b, u.uid)));
          if (snap.exists()) await withTimeout(F.setDoc(scoreDoc(b, u.uid), { name: n, at: F.serverTimestamp() }, { merge: true }));
        } catch (e) { console.warn('[online] rename on board ' + b, e); }
      }));
      return toUser(auth.currentUser);
    },

    /** Post a run. Only a better score than the stored one is written. → { improved, best (entry), prev (entry | null) } */
    async submitScore(board, entry) {
      const u = me(), e = cleanEntry(board, entry);
      const ref = scoreDoc(board, u.uid);
      const snap = await withTimeout(F.getDoc(ref));
      const prev = snap.exists() ? row(snap) : null;
      if (prev && prev.score >= e.score) return { improved: false, best: prev, prev };
      let name = cleanName(u.displayName);
      if (!name) { name = nameFrom(''); try { await A.updateProfile(u, { displayName: name }); } catch { /* the row still gets the name */ } }
      await withTimeout(F.setDoc(ref, { uid: u.uid, name, ...e, at: F.serverTimestamp(), v: 1 }));
      return { improved: true, best: { uid: u.uid, name, ...e, at: Date.now() }, prev };
    },
    /** The top n of a board, best first. */
    async top(board, n = 50) {
      const snap = await withTimeout(F.getDocs(F.query(scores(board), F.orderBy('score', 'desc'), F.limit(n))));
      return snap.docs.map(row);
    },
    /** This pilot's stored best on a board (null when there is none). */
    async mine(board) {
      const u = auth.currentUser;
      if (!u) return null;
      const snap = await withTimeout(F.getDoc(scoreDoc(board, u.uid)));
      return snap.exists() ? row(snap) : null;
    },
    /** The place a score has on a board: 1 + how many stored scores are higher. */
    async rank(board, score) {
      const snap = await withTimeout(F.getCount(F.query(scores(board), F.where('score', '>', Math.round(score)))));
      return (snap.data().count || 0) + 1;
    },
    /** Stage progress kept with the account: { stage, stageTimes } (null without one). */
    async loadProgress() {
      const u = auth.currentUser;
      if (!u) return null;
      const snap = await withTimeout(F.getDoc(playerDoc(u.uid)));
      if (!snap.exists()) return null;
      const d = snap.data();
      return { stage: Math.max(0, Math.round(+d.stage || 0)), stageTimes: d.stageTimes && typeof d.stageTimes === 'object' ? { ...d.stageTimes } : {} };
    },
    async saveProgress(p) {
      const u = auth.currentUser;
      if (!u) return false;
      // (the name rides along: the rules want one on every player document, and this may be the write that creates it)
      const n = cleanName(u.displayName) || nameFrom('');
      const times = {};
      for (const [k, v] of Object.entries(p.stageTimes || {})) if (/^[a-z0-9-]{1,24}$/.test(k) && v > 0) times[k] = Math.round(v);
      await withTimeout(F.setDoc(playerDoc(u.uid), { name: n, nameLower: n.toLowerCase(), stage: Math.max(0, Math.min(20, Math.round(+p.stage || 0))), stageTimes: times, updated: F.serverTimestamp() }, { merge: true }));
      return true;
    },
  };
  return backend;
}
