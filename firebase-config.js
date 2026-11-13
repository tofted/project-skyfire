// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// SKYFIRE — online accounts and leaderboards (Firebase).
//
// Paste your project's web config below (Firebase console → Project settings → General → "Your apps" → Web app →
// "SDK setup and configuration" → Config). README.md walks through the whole setup (about ten minutes, free plan).
//
// While apiKey is empty the game still works: no accounts, and the leaderboard shows this device's own runs only.
//
// These values are NOT secrets — every Firebase web app ships them to the browser. What protects your data is
// firestore.rules (publish it in the console) and the "Authorized domains" list under Authentication → Settings.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
globalThis.SKYFIRE_FIREBASE = {
  apiKey: "AIzaSyCDNAKtu8GkYWrES20J6b8AudWRGpWHyzA",
  authDomain: "project-skyfire-91827.firebaseapp.com",          // e.g. "skyfire-12345.firebaseapp.com"
  projectId: "project-skyfire-91827",           // e.g. "skyfire-12345"
  appId: "1:456964223396:web:1b40b3c11c81f90f981131",               // e.g. "1:1234567890:web:abcdef123456"

  // Set to true after you switch on the Google provider (Authentication → Sign-in method → Google):
  // the sign-in panel then shows a "Continue with Google" button.
  google: true,
};
