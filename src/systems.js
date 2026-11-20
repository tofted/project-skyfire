// The system list. Each entry is an ES module whose default export is create(game) -> system.
// Order = run order inside every phase (fixedUpdate, update, lateUpdate). Lower first.
// A module that fails to load is reported on screen and skipped, so one broken system never blanks the game.
export const SYSTEMS = [
  // core & world
  { path: './core/perf.js', order: 1 },            // game.perf — the 60 fps governor of the automatic graphics mode
  { path: './render/atmosphere.js', order: 5 },    // game.atmo — sun, sky colours, fog/haze uniforms + GLSL chunk
  { path: './render/toon.js', order: 6 },          // game.toon — anime materials + outlines factory
  { path: './world/sky.js', order: 10 },           // sky dome, sun disc, sun light (+ shadows)
  { path: './world/terrain.js', order: 12 },       // valley terrain, LOD, game.world.heightAt
  { path: './world/water.js', order: 13 },         // sea + river surfaces
  { path: './world/vegetation.js', order: 14 },    // instanced forests, fields detail, villages, landmarks
  { path: './world/clouds.js', order: 15 },        // volumetric clouds (render + game.world.cloudDensity)
  // actors & gameplay (fixed-step order matters: pilots -> physics -> weapons -> combat)
  { path: './combat/combat.js', order: 20 },       // game.combat — HP, hit shapes, damage, targeting queries
  { path: './actors/progression.js', order: 21 },  // game.progress — Sora's level / XP / element (ember → lightning)
  { path: './online/online.js', order: 22 },       // game.online — pilot accounts, leaderboards, stage progress
  { path: './actors/player.js', order: 30 },       // player dragon + rider, input -> pilot intent
  { path: './actors/assist.js', order: 31 },       // game.aimAssist — aim assist level (auto / normal / strong), auto-lock
  { path: './actors/enemies.js', order: 32 },      // enemy riders, AI pilots
  { path: './actors/titan.js', order: 34 },        // the winged titan boss
  { path: './combat/fire.js', order: 40 },         // fire breath, fireballs, explosions (sim + VFX)
  { path: './director.js', order: 50 },            // encounter flow: waves -> titan rises -> finale
  // presentation
  { path: './vfx/ambient.js', order: 60 },         // speed lines, wind streaks, birds, cloud wisps, petals
  { path: './vfx/spectacle.js', order: 62 },       // kill bursts + soul wisps, combo aura, fireworks, night motes, screen shockwaves
  { path: './vfx/bossfx.js', order: 63 },          // game.bossFx — the titan fight: halo, core shell, storm, post
  { path: './camera/camera.js', order: 80 },       // game.cameraRig — chase / free-orbit / photo / cinematic
  { path: './audio/audio.js', order: 85 },         // procedural sound + music
  { path: './ui/hud.js', order: 90 },              // title, HUD, pause, results (English only)
  { path: './ui/moves.js', order: 91 },            // movesHud — momentum / charge / INFERNO meter, move call-outs, move tips
  { path: './ui/touch.js', order: 92 },            // touchUI — touch layout: floating stick, aim / orbit / pinch, big buttons
  { path: './ui/fps.js', order: 93 },              // fpsTag — the optional frame-rate read-out (Settings)
  { path: './render/pipeline.js', order: 99 },     // game.pipeline — HDR, clouds composite, god rays, bloom, grade
];
