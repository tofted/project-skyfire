# Skyfire — Riders of the Cloud Sea

A dragon-riding action game that runs entirely in the browser (three.js, no build step). This copy is laid out to be
hosted on **GitHub Pages**, with pilot accounts, online leaderboards, eight stages and a heavier effects layer.

## What's in this version

**Accounts and leaderboards**
- A pilot chip on the title screen: create an account (email + password, optional Google sign-in), sign in, rename, sign out.
- Three boards: **Story** (a whole run from the Aerial Patrol), **Face the Titan** and **Survival**. One row per pilot:
  your best run. Your place is shown on the results screen and in the Leaderboard panel.
- Guests can play. Their runs are kept on the device and posted the first time they sign in.
- No setup done yet? The game still runs: the "leaderboard" is then this device's own runs.

**More levels**
- The story is eight stages now: Aerial Patrol, three original waves, three new ones — **The Drake Tide** (dusk),
  **The Twilight Lancers** (night) and **The Night Court** (three aces under an aurora) — then the Cloud Titan.
- **Stages** on the title screen starts any stage you have reached, at a fitting dragon level.
- Sora's level cap went from 10 to **15**. From level 11 she burns **Prismfire**: rainbow flame and lightning that
  drift through the spectrum.
- Skies change with the stages: golden hour, dusk, a starry night, an aurora.

**Effects**
- Kills: double shock ring, spark burst, a shower of twinkles, and the fallen dragon's essence flying into Sora.
- Screen shockwaves and a bloom kick on kills, heavy hits and level-ups; a slow-motion beat on aces and long chains.
- Combo aura from ×3, a pillar of light on level-up, fireworks when a wave falls.
- Night stages: stars, aurora curtains, drifting motes, shooting stars.

---

## 1. Put it on GitHub Pages

1. Create a new **public** repository on GitHub (for example `skyfire`).
2. Upload **everything in this folder** to the root of the repository — `index.html` must sit at the top level.
   The web uploader takes drag-and-drop of the whole folder contents; with git:
   ```
   git init
   git add .
   git commit -m "Skyfire"
   git branch -M main
   git remote add origin https://github.com/YOUR-NAME/skyfire.git
   git push -u origin main
   ```
3. In the repository: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch `main`,
   folder `/ (root)`, **Save**.
4. After a minute or two the game is live at `https://YOUR-NAME.github.io/skyfire/`.

The empty `.nojekyll` file tells Pages to serve the files as they are. Keep it.

## 2. Switch on accounts and the online leaderboard (Firebase, free plan)

GitHub Pages only serves files, so the accounts and scores live in a Firebase project of yours. About ten minutes:

1. Go to <https://console.firebase.google.com>, **Add project** (Analytics is not needed).
2. **Build → Authentication → Get started → Sign-in method → Email/Password → Enable → Save.**
   Optional: enable **Google** there too.
3. **Build → Firestore Database → Create database** → pick a region → **Start in production mode.**
4. In Firestore open the **Rules** tab, replace everything with the contents of [`firestore.rules`](firestore.rules),
   **Publish.**
5. **Project settings (gear icon) → General → Your apps → Web (`</>`)** → register an app (no hosting) → copy the
   `firebaseConfig` values into [`firebase-config.js`](firebase-config.js): `apiKey`, `authDomain`, `projectId`, `appId`.
   If you enabled Google sign-in, set `google: true`.
6. **Authentication → Settings → Authorized domains → Add domain:** `YOUR-NAME.github.io`.
7. Commit and push `firebase-config.js`. Reload the game: the chip on the title screen now says **Sign in**.

**Check it once after publishing:** create an account, fly "Face the Titan", and confirm your row appears on the board.
If a score "could not be posted", step 4 (the rules) is the usual cause.

### Things worth knowing

- **The config is not a secret.** Every Firebase web app ships these values to the browser. Your data is protected by
  `firestore.rules` and the authorized-domains list, not by hiding the key.
- **The leaderboard is not cheat-proof.** Scores are worked out in the browser, so the server can only check that a
  row belongs to the signed-in pilot, has the right shape and stays under a ceiling. Someone determined can post a
  made-up score under that ceiling. Fine among friends; a public competitive board would need server-side validation
  (Cloud Functions, which is not on the free plan).
- **Free-plan limits** (Spark plan, at the time of writing) are 50,000 document reads and 20,000 writes a day. Opening
  a board reads up to 50 rows, so that is roughly a thousand board views a day; past the limit the board stops
  loading until the next day — nothing is charged.
- **Pilot names** are 3–16 characters and are public. Email addresses are never written to the leaderboard.
- **Moderation:** to remove a row or a pilot, delete the document in the Firestore console
  (`boards/<board>/scores/<uid>`, `players/<uid>`) or disable the user under Authentication.

### What counts for the boards

| Board | A run counts when… |
| --- | --- |
| Story | it started at the Aerial Patrol ("Take Flight"). Stage-select runs are practice. |
| Face the Titan | it was started from "Face the Titan" (or stage 8). |
| Survival | it started at wave 1. |

Runs flown with `?debug` in the address are never ranked.

## 3. Run it on your own computer

Browsers will not run the game from a double-clicked file, so it needs a tiny local server:

```
python3 serve.py          # or:  node serve.mjs
```

It opens `http://127.0.0.1:8187/`. Add `?touch=1` for the touch layout, `?quality=low|medium|high|ultra` to pick a
quality tier.

Accounts work locally too once `firebase-config.js` is filled in (`localhost` is an authorized domain by default).

## Files

```
index.html            the page
firebase-config.js    your Firebase web config (empty = no accounts, local records)
firestore.rules       security rules to publish in the Firebase console
styles.css            the game's UI
online.css            account chip, account / leaderboard / stage panels
src/                  the game
  director.js           stages, waves, results and scoring
  online/               accounts + leaderboards (online.js, backend-firebase.js, names.js)
  ui/online-ui.js       the three panels
  vfx/spectacle.js      kill bursts, wisps, aura, fireworks, night motes
  render/pipeline.js    post-processing (screen shockwaves, impact kick)
  render/atmosphere.js  sky presets (golden, dusk, night, aurora)
vendor/               three.js and the Firebase web SDK, bundled (no CDN needed)
assets/               models, textures, sounds
```

## Credits

Game code and assets: see `THIRD-PARTY-LICENSES.txt` for the bundled libraries (three.js — MIT; Firebase JavaScript
SDK — Apache-2.0).
