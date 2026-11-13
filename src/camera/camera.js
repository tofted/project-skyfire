// game.cameraRig — the player's eyes (system 'cameraRig', order 80). Input is read in update(), the camera is placed
// in lateUpdate() after every visual has moved. Smoothing runs on realDt, so photo mode, pause and hitstop keep a live
// camera. Wave 5: a tiny second system 'cameraAim' (order 25, before the pilots) applies the frame's mouse motion and
// composes aimDir on the frame's first fixed step, so the pilot steers with this frame's mouse move.
// Modes (see docs/modules/camera.md):
//   chase     default. Mouse-aim: the mouse turns the aim instantly, a damped rig follows it, the camera rides a
//             spring arm behind/above the dragon. player.js steers the dragon toward `aimDir`.
//   free      hold RMB or Alt: orbit 360° around the dragon (front view included), wheel zoom, aim frozen so the dragon
//             keeps its course; on release the camera swings back behind. In rider view it is a look-around.
//   rider     V: seat view from Kaede's head over the neck and horns (wheel out returns to chase, wheel in at the
//             closest zoom enters it).
//   photo     P: game paused, orbit + zoom, Shift+wheel FOV, Q/E tilt; P or Esc leaves.
//   cinematic playCinematic(name | spec) for the director; focus(target) biases the view for a while.
//   title     slow orbit of the gliding dragon behind the menu (also victory / defeat).
// Lock-on (Tab) assists the AIM (sticky + a lean toward the target inside the lead cap); it never turns the camera.
// The lens keeps out of the dragon's own hull (photo mode: wings included).
// Flight moves (wave 6; game.player.moves / FlightBody.move / the 'move' events, feature-detected): a wingover or loop
// (or any near-vertical flight) switches the chase frame to a smoothed 3-D frame that goes over the top without a flip
// and keeps the dragon's back toward the lens; the aim target rides with the course through the move. Dash: FOV kick +
// blur pulse; near miss: tiny shake + FOV pop; skim: a low-slung arm; inferno: a 0.4 s push-in on the head.
// Hover / aim (game.player.flightMode, feature-detected): hovering (no W) the chase is a TPS over-the-shoulder view — the
// view is the aim, the reticle (aimPoint) on the screen centre ray; the soft-target magnet bends the aim ≤ 3°; W held
// blends back to the forward-flight chase (docs/modules/camera.md "Hover / aim / survival").
// The camera never throws: a failure is logged once and that frame keeps the previous camera.
import * as THREE from 'three';
import { clamp, damp, dampTo, lerp, smoothstep, wrapAngle, rng, closestOnSegment } from '../core/util.js';

const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);
const MENU_STATES = new Set(['title', 'victory', 'defeat']);

// Tuning (numbers from docs/research/dragontwin-feel.md §5 and titan-boss.md §4.10, adjusted on screenshots).
export const CAMERA_TUNING = {
  sens: 0.0021,              // rad per mouse pixel (pointer lock)
  padRate: 2.6,              // rad/s at full right stick
  aimPitchMax: 80 * DEG,
  rigLambda: 6,              // rig rotation follows the aim, 1/s (MouseFlight default ≈ 5)
  zoomDefault: 19, zoomMin: 8, zoomMax: 60,   // 19 m: the whole real dragon (tail fin included) fits at cruise
  elev: 16.5 * DEG,          // arm elevation at the default zoom (18 m behind, 5.4 m up)
  elevClose: 27 * DEG,       // at the closest zoom (keeps the tail out of the lens)
  elevFar: 14 * DEG,         // at the widest zoom
  viewBias: 8 * DEG,         // view looks less down than the arm: head ≈ 62 %, tail fin ≈ 88 % of screen height
  sideYaw: 6 * DEG,          // arm-only yaw offset: the camera sits a little right-rear (the sunlit side), the view
                             // stays on the aim — a dead-behind level view reduces the dragon to a flat "T" 
  pivotUp: 1.3,              // m above the dragon's centre (its back / the rider)
  fovBase: 62, fovFast: 74, fovBoost: 4, fovHover: 57, fovRider: 78, fovRiderFast: 88,   // boost peak 78°
  // Feel fix (user report "the dragon breaks when it turns"): the chase view follows the dragon's FLIGHT DIRECTION,
  // rolls with ~55 % of its bank (anime chase), and the arm is placed in that rolled frame, so the dragon stays
  // centre-low and is always read from behind-above. (Before: the view followed the aim, which led the dragon by
  // 60°+ after a mouse swing, and the arm swung to the inside of the turn -> the dragon was seen from the side.)
  rollFollow: 0.55, rollMax: 40 * DEG, rollLambda: 3.2,
  swing: 0, lookAhead: 0, lookAheadMax: 0,   // (retired: inside swing / look into the turn)
  // Aim lead: the mouse moves a world target (aimYaw/aimPitch); the aim the dragon flies toward (aimDir, the reticle)
  // leads the flight direction by at most leadYaw / leadPitch, saturating smoothly past `leadKnee` of the cap. A big
  // swing keeps the aim at the cap (a sustained max-rate turn) until the dragon's course has caught up with the target,
  // then the lead shrinks with the remaining angle (the reticle recentres gradually).
  leadYaw: 28 * DEG, leadPitch: 20 * DEG, leadKnee: 0.55,
  queueMax: 170 * DEG,       // the target may wait at most this far (yaw) from the course
  camLead: 0.3,              // chase view: share of the aim lead the view looks toward (the rest stays on the course)
  courseLambda: 5.5, coursePitchLambda: 4.5,   // 1/s: the chase rig follows the flight direction (+ camLead × lead)
  kbLead: 22 * DEG, kbRate: 110 * DEG,         // A / D: keyboard turn — the target leads the course by 22° while held
  freeReturn: 4.5,           // 1/s swing back behind after free-look
  clearance: 3.0,            // m above terrain / sea
  shapeMargin: 3.0,          // m kept from big bodies (titan)
  selfMargin: 0.7,           // m kept from the player's own hit shapes
  riderLead: 0.62,           // rider view: share of the aim direction vs the dragon's nose
  riderBias: 8 * DEG,        // rider view looks slightly down onto the neck
  riderEye: [1.05, -1.3],    // m above / ahead of Kaede's head: a saddle view over her shoulders (≥ 1 m from any rider
                             // mesh, so the 0.5 m near plane never cuts her), dragon head above her, wings at the edges
  saddleToEye: 1.3,          // m from a saddle-level anchor up to the seated rider's eyes
  // Lock-on (Wave 4; critics: "Tab swings the chase camera 115–149° off the flight path"). The camera never turns toward
  // the lock: it stays behind the dragon and a target off the screen is shown by the HUD's lock arrow. The AIM is
  // assisted instead: while the player's aim (the mouse target) is within lockAssist[1] of the locked target, the aim
  // target moves with the target's bearing (sticky) and drifts onto it (lockPull), and the aim the dragon flies (aimDir,
  // the reticle) leans lockBias of the rest toward it — still inside the lead cap, so the dragon turns no faster than a mouse turn. A flick past
  // lockAssist[1] (≈ 170 px) breaks away: the dragon flies where the player aims.
  lockAssist: [5 * DEG, 20 * DEG],   // full assist inside, none outside (angle mouse target ↔ locked target)
  lockBias: 0.85,            // share of the remaining angle the aim leans toward the locked target
  lockStickRate: 90 * DEG,   // rad/s: the sticky aim follows the target's bearing at most this fast
  lockPull: 2.0,             // 1/s (× the assist weight): the mouse target drifts onto the locked target
  lockRange: [8, 25],        // m: the assist fades in over this range (a rider at 5 m sweeps across the sky)
  lockBigRange: [60, 140],   // m: the same for the titan (aimed at its core; nobody wants to be steered into it)
  lockLead: 0.6,             // s: aim at where the target will be (≤ dist / lockFlame), the flame's travel time
  lockFlame: 70,             // m/s: the breath's muzzle speed relative to the dragon (fire.js breath.muzzle)
  lockLeadMax: 10 * DEG,     // the lead never puts the aim more than this beside the target
  lockView: 10 * DEG,        // chase view bias toward a lock just outside the frame (only when it brings it in)
  // Hull (Wave 4; art critic: "photo mode camera enters the dragon's mesh at 3–4.8 m"). Photo mode (the pose is frozen)
  // uses the dragon's own mesh: its skinned vertices (every 2nd, ~8 ms once per photo session) bucketed in 1.2 m cells;
  // the lens stays photoMargin from every vertex and outside the body / neck / head / tail capsules grown by how far
  // the mesh reaches past them (the cloud only sees surfaces). Chase / free / title use those grown capsules +
  // hullMargin (the flapping wings keep the old selfMargin: a hull there would pump the lens with the wingbeat).
  // Measured on Sora's GLB (title glide + 14 flight poses): the mesh reaches 0.88 / 1.43 m past the body capsule, 1.36 /
  // 1.59 neck, 0.72 head, 1.52 tail, up to 3.25 m past the wing capsules (the membrane between the fingers), Kaede
  // stays within 1.07 m of the body capsule.
  hullGrow: { body: 1.45, neck: 1.6, head: 0.75, tail: 1.55 }, hullGrowDefault: 1.2,
  hullMargin: 0.9,           // m: the 0.5 m near plane's frustum corners reach 0.76 m at 62° / 16:10
  photoMargin: 1.05,         // m from every vertex (0.76 m frustum reach + the GPU membrane billow the CPU does not see)
  photoCell: 1.2,            // m: cloud bucket size (≥ photoMargin, so 3×3×3 buckets answer a query)
  // Title / results orbit: drag with any mouse button (or one finger) to orbit the gliding dragon; release and the
  // slow auto-orbit carries on from there while the tilt eases back to the cinematic angle.
  menuPitchMin: -62 * DEG, menuPitchMax: 55 * DEG, menuPitchReturn: 0.9, menuZoomMin: 0.45, menuZoomMax: 2.4,
  resultsLift: 17 * DEG,     // results orbit looks this far below the dragon (only if the framing below fails)
  // Results framing (resultsFrame): Sora in the band from NDC y resultsBand[0] down to resultsBand[1] above the text
  // block's top (resultsTextTop when the screen's layout cannot be read), her box centre resultsX across; the orbit
  // distance fits her box (hit shapes × resultsGrow — the membrane reaches past the wing capsules; resultsBox m half
  // sizes without shapes) within resultsDist m, smoothed at resultsLambda [growing, shrinking] 1/s.
  resultsBand: [0.93, 0.05], resultsTextTop: 0.43, resultsX: 0.42, resultsDist: [30, 85], resultsGrow: 1.5, resultsBox: [8, 5],
  resultsLambda: [3, 0.7],
  resultsCut: 1.8,           // s: a cinematic still playing when victory / defeat begins ends as the results appear
  // Speed blur (pipeline.setSpeedBlur): subtle radial streaks at high speed, boost and dive; 0..1 into the pipeline.
  blurSpeed: [50, 95], blurSpeedK: 0.26, blurBoostK: 0.16, blurDiveK: 0.2, blurMax: 0.5, blurRider: 0.75,
  // ---- Wave 5 (polish requests of the other owners; docs/modules/camera.md "Wave 5") ----
  // Aim latency: a tiny system (`cameraAim`) at this order — after combat (20), before the pilots (30) — applies the
  // frame's mouse / pad / A-D motion and composes aimDir on the frame's first fixed step (was: in update(), after the
  // steps, so the pilot saw a mouse move one frame late).
  earlyAimOrder: 25,
  // Dodge hop (body.state.dodging): the velocity swings ~40° sideways while the nose holds the course, so the chase
  // view follows the nose instead of the velocity for the hop (weight in / out, 1/s).
  dodgeFollow: [12, 3],
  // Breath (fx.isBreathing(player), chase): the lens rises (m at the default distance, scaled with the arm) and the view
  // pitches down, so the stream reads longer on screen instead of vanishing into its own vanishing point.
  breathRaise: 2.0, breathPitch: 4 * DEG, breathLambda: [3, 1.4],
  // Wings: the membrane reaches up to 3.25 m past Sora's wing capsules, which only keep selfMargin. When the lens comes
  // within wingReach (+ wingMargin + slack) of a wing capsule — a close zoom, a side orbit, a dodge hop banking the near
  // wing through the lens — every wingStride-th skinned wing vertex is tested and the lens slides out along the arm to
  // wingMargin from all of them: out at once, back at wingRelease 1/s (slower than a wingbeat, so it never pumps).
  wingReach: 3.3, wingMargin: 1.1, wingSlack: 1.0, wingStride: 4, wingRelease: 0.8,
  // Titan sight line (titan / dragon owners): the titan's camera shapes are tested against the sight line lens → Sora,
  // now and sightAhead s ahead (each shape's own velocity). When it is blocked the chase frame orbits — arm and view
  // together, so Sora stays framed — to the cheapest clear direction of sightCands ([yaw, pitch] degrees): small turns
  // first, continuity, and while Sora is staggered by a swat the side away from the titan's hand (handAvoid). Moving out
  // at sightRate[0] (≤ sightMaxRate), back at sightRate[1]. Titan shapes never pull the lens in below bigArmMin of the
  // arm (the old pull-in to 12 % filled the frame with Sora after a swat); the offset goes around them instead.
  sightMargin: 1.0, sightAhead: 0.12, sightRate: [11, 1.6], sightMaxRate: 260 * DEG, sightHold: 0.6, bigArmMin: 0.5, handAvoid: 2.6,
  // Melee telegraph (titan:telegraph swat / grab / clap / slam): until meleeHold s after it, the arm drifts (sightTele 1/s,
  // at most teleMax [yaw, pitch] degrees) off the striking hand's side when the lens is clearly on it, and the striking
  // hand / forearm is also looked at meleeAhead s ahead.
  sightTele: 4, meleeHold: 1.3, teleMax: [45, 30], meleeAhead: 0.28,
  sightCands: [[0, 0], [15, 0], [-15, 0], [0, 15], [30, 0], [-30, 0], [22, 15], [-22, 15], [0, 30], [45, 0], [-45, 0],
    [35, 25], [-35, 25], [0, 45], [65, 15], [-65, 15], [90, 20], [-90, 20], [125, 20], [-125, 20], [160, 25], [-160, 25], [0, -15]],
  // Stagger (dragon.stagger after a swat / heavy hit): the course, roll and surge follow drop to staggerHold of their
  // rate, so the knock's sudden Δv and the tumble are absorbed instead of swinging the camera; eased back afterwards.
  staggerHold: 0.1, staggerRelease: 2.2,
  // ---- Flight moves (docs/modules/camera.md "Flight moves"): game.player.moves / the 'move' events, feature-detected ----
  // Aerobatic frame (wingover, loop, and any near-vertical flight): the chase frame becomes a smoothed 3-D frame (forward
  // + up) instead of yaw / pitch / roll, so it goes over the top of a loop without the yaw flip a yaw/pitch rig has at the
  // vertical. Forward = the course + aeroNose of the nose, followed at aeroLambda with aeroFF of the target's own turn rate
  // fed forward (a first-order follow lags a steady 130°/s reversal by ~19°; this leaves ~5° of lag: the dragon swings a
  // little across the frame and stays behind). The up is carried with the forward (parallel transport: a pitch-over keeps
  // the dragon's back toward the lens) and rolls toward aeroRoll of the dragon's bank (loop / vertical: all of it, so the
  // dragon reads upright on screen and the world turns around it), at aeroRollLambda — eased to aeroRollInv while the
  // dragon is inverted (the start of the loop's half roll reads as the dragon rolling; no flip). Loop / vertical, once
  // the dragon has been upside down: as its up comes back over the horizon (up.y −0.3 → 0) the roll follow ramps to
  // aeroRollUp (≤ aeroRollUpRate), and the settle after it keeps that — the world turns upright WITH the dragon (the eased
  // 200°/s follow left the horizon 95° off an upright dragon 0.1 s after the Immelmann, 44° at 0.3 s: it looked edge-on).
  aeroNose: { wingover: 0.35, loop: 0.25, vertical: 0.2, settle: 0 },
  aeroLambda: 7, aeroFF: 0.75, aeroLeadMax: 30 * DEG,
  aeroRoll: { wingover: 0.62, loop: 1, vertical: 1 }, aeroRollMax: 70 * DEG, aeroRollLambda: 4.5, aeroRollInv: 2.0, aeroRollRate: 200 * DEG,
  aeroRollUp: 12, aeroRollUpRate: 540 * DEG, aeroRollUpRamp: [-0.3, 0], aeroRollAcc: 4000 * DEG,   // rad/s²: the spin's build-up
  aeroIn: 6, aeroOut: 2.4,               // 1/s: the aerobatic frame blends in / out
  aeroSettle: [6 * DEG, 1.5],            // after a move: stay in until the roll is within this of the normal chase roll (≤ s)
  aeroSettleCatch: [30 * DEG, 8],        // a settle that starts more than [0] off the chase roll follows at ≥ λ [1], no rate cap
  aeroVertical: [0.87, 0.94],            // |sin course pitch|: the frame also takes over past 70° (off again below 60°)
  aeroDist: 1.08, aeroFov: 3,            // wingover / loop: the arm a little longer, FOV a little wider (the wing sweep fits)
  riderAeroUp: 0.5,                      // seat view in a loop: share of the eased frame's up (the rest: the dragon's own up)
  moveCarry: 2,                          // 1/s: during a wingover / loop the aim target rides with the course and the
                                         //   offset it had at the move start decays, so the dragon ends the move flying
                                         //   its new course; mouse / right-stick motion DURING the move is kept (the
                                         //   player picks the exit direction), capped at moveUserMax
  moveUserMax: [120 * DEG, 60 * DEG],    // yaw / pitch: the most of the in-move aim motion carried out of the move
  // Dash (double-tap W): FOV kick + a speed-blur pulse; envelope [in, hold, out] s. The lens is shoved back a little.
  dashFov: 9, dashBlur: 0.26, dashEnv: [0.07, 0.3, 0.75], dashKick: 0.45,
  // Near miss: a tiny shake (SHAKE_KINDS.nearmiss) and a FOV pop.
  nearFov: 4.5, nearShake: 0.32, nearEnv: [0.05, 0.08, 0.5], nearGap: 0.35,
  // Skim (3–20 m over a cloud top / the ground at speed): a low-slung camera — lower arm, a flatter view, a touch closer
  // and wider — so the surface streams under the dragon; the speed blur gets skimBlur on top; the view follows only
  // (1 − skimLeadPitch) of the aim's pitch lead (holding a skim the aim sits below the course). Over land (trees, houses:
  // the camera has no canopy query) only skimLand of the lower arm; the full one over water and cloud tops.
  skimElev: 7 * DEG, skimViewBias: 2.5 * DEG, skimDist: 0.9, skimFov: 4, skimBlur: 0.12, skimLambda: [2.2, 1.4], skimLeadPitch: 0.8, skimLand: 0.35,
  // Inferno cut-in: as the super breath starts, a 0.4 s push-in (in / hold / out, s) over Kaede's right shoulder that
  // frames the head and the start of the stream (lens cutUp above / cutBack along / cutSide right of the dragon's centre,
  // in its own frame; the view between the head and cutAhead m down the stream, the head within cutHeadMax of the
  // half-FOV; cutLook = the head's share of the view), then back. The lens keeps the usual hull / wing / terrain protection.
  cutEnv: [0.12, 0.28, 0.55], cutUp: 4.6, cutBack: -3.0, cutSide: 1.9, cutAhead: 10, cutLook: 0.6, cutHeadMax: 0.5, cutFov: 55, cutBlur: 0.34,
  // Fireball charge (hold F): the view tightens with the charge; a charged release kicks the lens back.
  chargeFov: 4, chargeKick: 0.5,
  // ---- Hover / aim (docs/modules/camera.md "Hover / aim / survival"): game.player.flightMode, feature-detected ----
  // Flight modes 'hover' | 'transition' | 'flight' (none published = 'flight': the chase exactly as before). HOVER is a
  // TPS over-the-shoulder chase: the view IS the aim (the reticle sits at the screen centre), the lens hoverDist × zoom
  // (≥ hoverDistMin) behind the view, hoverElev above it and hoverSide to its right. The view leads the dragon's nose by
  // at most hoverLeadYaw (soft knee, like the flight lead cap): the dragon turning after the mouse is always seen from
  // behind. Chase ↔ hover blend at hoverBlend [to hover, to flight] 1/s; 'transition' weighs by airspeed (hoverSpeed).
  // While hovering the course is the nose (a strafe / back drift never swings the rig) and level (hoverCourse 1/s).
  hoverDist: 0.78, hoverDistMin: 9, hoverElev: 9 * DEG, hoverSide: 3.4, hoverSideTurn: 0.4,
  // Looking down (view pitch below −hoverDownPitch[0], full at −hoverDownPitch[1]) the lens rises hoverDownElev more
  // and the arm grows by hoverDownPull, so her head and spread wings stay below the reticle; the shoulder offset is
  // capped so the lens stays ≤ hoverAzMax off her tail in the horizontal, the view's lead to the left included (never
  // less room than hoverSideAzMin).
  hoverDownPitch: [15 * DEG, 62 * DEG], hoverDownElev: 9 * DEG, hoverDownPull: 0.25, hoverAzMax: 28 * DEG, hoverSideAzMin: 3 * DEG,
  hoverLeadYaw: 24 * DEG, hoverPitch: [-62 * DEG, 55 * DEG], hoverFov: 60, hoverBlend: [2.6, 3.0],
  hoverSpeed: [10, 22], hoverTakeoff: [3, 12], hoverCourse: 3,
  // The hover aim ray (lens → view) converges where it passes the soft target, or meets the ground, else at aimFar m
  // (never nearer than aimNear from the lens); the distance is smoothed (aimConvLambda, log space).
  aimFar: 400, aimNear: 45, aimConvLambda: 5, aimConvCone: 8 * DEG,
  // Aim magnetism toward game.player.softTarget (player.js picks it): the aim bends at most magnetMax toward it — all of
  // it inside magnetCone[0] of the un-bent aim, none past magnetCone[1] —, within magnetRange m, smoothed (magnetLambda).
  // In hover the view itself bends (the reticle stays at the centre, on the target); in flight the flown aim (reticle).
  // A Tab lock the lock assist already leans toward is left to it (no double pull).
  magnetMax: 3 * DEG, magnetCone: [3.5 * DEG, 8 * DEG], magnetRange: 450, magnetLambda: 7,
};

// Built-in cinematics. Offsets are [right, up, forward] in a frame whose forward is titan → player (horizontal), or
// the player's heading when frame is 'heading' or there is no titan. at: 'player' | 'titan' | 'titan:head' | 'both'
// | Vector3 | Object3D | actor | (game) => Vector3.
export const CINEMATICS = {
  // Reveal from below the titan's chest line on a long lens, then pull back behind the player to frame both.
  'titan-rise': {
    duration: 7.5, blendIn: 0.6, blendOut: 1.4, frame: 'titan',
    keys: [
      // (190–230 m: close enough that the storm haze of the titan phase never swallows the reveal)
      { t: 0, pos: { at: 'titan', offset: [-60, -45, 190] }, look: { at: 'titan:head', offset: [0, 4, 0] }, fov: 31, roll: -4 * DEG },
      { t: 3.6, pos: { at: 'titan', offset: [-82, -24, 230] }, look: { at: 'titan:head', offset: [0, 0, 0] }, fov: 34, roll: -2 * DEG },
      // End 30 m beyond the player (forward = titan → player), looking back past the dragon at the titan.
      { t: 7.5, pos: { at: 'player', offset: [-13, 7, 30] }, look: { at: 'both' }, fov: 56, roll: 0 },
    ],
  },
  // Opening sweep: the dragon's face, its flank, then settle behind it.
  intro: {
    duration: 6, blendIn: 0.2, blendOut: 0.9, frame: 'heading',
    keys: [
      { t: 0, pos: { at: 'player', offset: [7, 1.5, 20] }, look: { at: 'player', offset: [0, 1.2, 0] }, fov: 42 },
      { t: 2.8, pos: { at: 'player', offset: [21, 5, 2] }, look: { at: 'player', offset: [0, 1, 2] }, fov: 48 },
      { t: 6, pos: { at: 'player', offset: [0, 4.5, -16] }, look: { at: 'player', offset: [0, 1.5, 30] }, fov: 62 },
    ],
  },
  // Victory lap: slow rising orbit that pulls out to show the sky.
  victory: {
    duration: 8, blendIn: 0.8, blendOut: 1.2, frame: 'heading',
    keys: [
      { t: 0, pos: { at: 'player', offset: [-10, 3, -14] }, look: { at: 'player', offset: [0, 1.5, 0] }, fov: 50 },
      { t: 4, pos: { at: 'player', offset: [-24, 3, 8] }, look: { at: 'player', offset: [0, 2, 0] }, fov: 48 },
      { t: 8, pos: { at: 'player', offset: [-12, -7, 30] }, look: { at: 'player', offset: [0, 4, -4] }, fov: 58, roll: 8 * DEG },
    ],
  },
};

// Shake presets (Eiserloh trauma model; titan-boss.md §4.10): big things shake slow, small things fast.
const SHAKE_KINDS = {
  hit: { freq: 15, rot: 1.4 * DEG, trans: 0.08 },
  near: { freq: 7.5, rot: 2.5 * DEG, trans: 0.2 },
  titan: { freq: 2.6, rot: 1.5 * DEG, trans: 0.6 },
  fire: { freq: 16, rot: 0.5 * DEG, trans: 0.02 },
  nearmiss: { freq: 13, rot: 0.9 * DEG, trans: 0.1 },      // flight moves: a close pass at speed (tiny)
  inferno: { freq: 17, rot: 0.75 * DEG, trans: 0.04 },     // the super breath's rumble
};

/** Envelope [in, hold, out] (s) at time t: eased 0 → 1, hold, eased 1 → 0. */
const env3 = (t, e) => (t < 0 ? 0 : t < e[0] ? (t / e[0]) * (t / e[0]) * (3 - 2 * (t / e[0])) : t < e[0] + e[1] ? 1
  : t < e[0] + e[1] + e[2] ? 1 - ((t - e[0] - e[1]) / e[2]) ** 2 * (3 - 2 * ((t - e[0] - e[1]) / e[2])) : 0);
const envLen = (e) => e[0] + e[1] + e[2];

/** 1-D gradient noise, −1..1, smooth (quintic fade). */
function gradNoise(seed) {
  const r = rng(seed), g = new Float32Array(256);
  for (let i = 0; i < 256; i++) g[i] = r() * 2 - 1;
  return (x) => {
    const i = Math.floor(x), f = x - i;
    const a = g[i & 255] * f, b = g[(i + 1) & 255] * (f - 1);
    const u = f * f * f * (f * (f * 6 - 15) + 10);
    return (a + (b - a) * u) * 2;
  };
}

/** A settings value as a finite number in [lo, hi] (settings come from localStorage and the HUD). */
const num = (v, def, lo, hi) => (Number.isFinite(+v) && v !== null && v !== '' ? clamp(+v, lo, hi) : def);

const dirFromYP = (yaw, pitch, out) =>
  out.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
const yawOf = (v) => Math.atan2(v.x, v.z);
const pitchOf = (v) => Math.asin(clamp(v.y / (v.length() || 1), -1, 1));
const ease = (u) => u * u * (3 - 2 * u);
const easeInOut = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);

function catmull(p0, p1, p2, p3, t, out) {
  const t2 = t * t, t3 = t2 * t;
  for (const k of ['x', 'y', 'z']) {
    out[k] = 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2
      + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
  }
  return out;
}

export default function createCameraRig(game) {
  const cam = game.camera;
  const T = CAMERA_TUNING;
  const settings = {
    sensitivity: 1, invertY: false, rollFollow: T.rollFollow, shake: 1, fovOffset: 0, autoShake: true, speedBlur: 1,
  };
  try { Object.assign(settings, JSON.parse(localStorage.getItem('skyfire.camera') || '{}')); } catch { /* private mode */ }
  // Settings saved before the feel fix carry the old roll-follow default (0.3, which no UI exposes): adopt the new
  // default once. Every other saved value (sensitivity, invert-Y, …) is kept as it is.
  if (!(settings.feelV >= 2)) {
    if (settings.rollFollow === 0.3 || settings.rollFollow == null) settings.rollFollow = T.rollFollow;
    settings.feelV = 2;
  }

  // ---- state -------------------------------------------------------------------------------------------------
  // aimYaw / aimPitch: the mouse's world TARGET direction. aimDir: the aim the dragon flies toward = the course plus the
  // (capped) lead toward the target. rigYaw / rigPitch: the chase view direction (course + camLead × lead, damped).
  let aimYaw = 0, aimPitch = 0, rigYaw = 0, rigPitch = 0, aimFor = null;
  const aimDir = new THREE.Vector3(0, 0, 1), aimPoint = new THREE.Vector3(), targetDir = new THREE.Vector3(0, 0, 1);
  const aimS = new THREE.Vector3(0, 0, 1);     // smoothed aim (rider view)
  let courseYaw = 0, coursePitch = 0, leadYaw = 0, leadPitch = 0, flying = false, hasLastPos = false;
  // Wave 5: the body's nose yaw (dodge follow), the dodge / breath weights, the early-aim frame guards.
  let noseYaw = 0, dodgeW = 0, breathK = 0, steerFrame = -1, earlyFrame = -1, lastReal = 0, earlyN = 0;
  // Titan sight-line orbit offset (yaw / pitch, rad) and its target; stagger weight (1 while staggered).
  const occ = { yaw: 0, pitch: 0, ty: 0, tp: 0, blocked: false, searched: 0, found: false, cand: -1, n: 0, blockedFrames: 0, holdUntil: -1 };
  let staggerK = 0, staggerKind = null, hitHoldUntil = -1, hitHoldKind = null;
  const lastPos = new THREE.Vector3();
  const _cv = new THREE.Vector3(), _cf = new THREE.Vector3(), _cr = new THREE.Vector3(), _cu = new THREE.Vector3();
  let freeYaw = 0, freePitch = 0, freeW = 0, freeHeld = false;
  let zoom = T.zoomDefault, zoomS = zoom, wheelPush = 0;
  let rollS = 0, swingS = 0, lookS = 0, yawRate = 0, prevHeading = null, fovS = cam.fov, riderRollS = 0;
  const surge = new THREE.Vector3(), surgeV = new THREE.Vector3(), accel = new THREE.Vector3(), prevVel = new THREE.Vector3();
  let hasPrevVel = false;
  const kickX = new THREE.Vector3(), kickV = new THREE.Vector3();
  let kickYaw = 0, kickYawV = 0, kickPitch = 0, kickPitchV = 0;
  let armScale = 1, biasYaw = 0, biasPitch = 0, bossK = 0;
  // Lock-on aim assist: w = assist weight 0..1, oy / op = the (smoothed) lean of the aim toward the target relative to
  // the mouse target, yaw / pitch = bearing of the lock point from the dragon (with the lead), ang = its angle from the
  // mouse target, stuck = total sticky motion (rad, for tests).
  const assist = { target: null, has: false, w: 0, oy: 0, op: 0, yaw: 0, pitch: 0, dist: 0, ang: 0, stuck: 0, dir: new THREE.Vector3(0, 0, 1) };
  let photoReach = 0, hullPush = 0, photoWheelInAt = -1;   // photo: lens distance after the hull push; m pushed out of the hull last frame
  const photo = { yaw: 0, pitch: 0, dist: 20, roll: 0, fov: 50 };
  let viewMode = 'chase', mode = 'title', lastMode = null, orbitT = 0;
  const blend = { t: 1, dur: 0, fromRel: new THREE.Vector3(), fromQuat: new THREE.Quaternion(), fromFov: 62, active: false };
  let cine = null;
  const focusList = [];
  const shakes = [];
  let breathShake = null;
  let lockTarget = null;
  let lockUnavailable = false, lockRequestedAt = -1, lockedNow = false, lockLostAt = -1;
  let telegraphUntil = 0;
  let padPrev = [];
  let failed = 0;
  // Title / results drag orbit.
  const menu = { pitch: 0, zoom: 1, held: false, w: 0, btns: 0, dragged: 0 };
  let orbitYaw = 0, cursorSet = '';
  // Speed blur and cinematic shadow focus.
  let blurS = 0, blurSent = -1, blurOut = 0;
  const blurCenter = new THREE.Vector2(0.5, 0.5);
  const cineLook = new THREE.Vector3(), shadowPt = new THREE.Vector3();
  let shadowFocusSet = null;
  // Titan grab: the grabbing hand is not solid for the camera (the dragon sits in it) and the view frames the face.
  let grabHand = null, grabFocus = null;
  const noise = [gradNoise(11), gradNoise(23), gradNoise(37), gradNoise(51), gradNoise(67), gradNoise(79)];
  // Flight moves. aero: the aerobatic chase frame (forward F / up U, weight w; kind 'wingover' | 'loop' | 'vertical').
  // mv: the move in progress (game.player.moves.current, or the 'move' events when the player publishes no moves), the aim
  // carry during wingover / loop, the event fallbacks for skim / charge / special, counters for tests.
  const aero = { w: 0, kind: null, vertical: false, init: false, settled: false, settleAt: -1, fromMove: false, F: new THREE.Vector3(0, 0, 1), U: new THREE.Vector3(0, 1, 0),
    tPrev: new THREE.Vector3(0, 0, 1), hasPrev: false, omega: new THREE.Vector3(), inverted: false, lead: 0,
    // invSeen: the dragon has been upside down in this loop / vertical episode (its roll back upright is followed fast);
    // catchUp: this settle started > aeroSettleCatch[0] off the chase roll; rollE: the last roll error (rad)
    invSeen: false, catchUp: false, settleNew: false, rollE: 0, rollLam: 0, rollW: 0 };
  const courseV = new THREE.Vector3(0, 0, 1);   // the course as a 3-D unit vector (updateCourse)
  // (uy / up: the aim motion the player made during the carried move — kept; the rest of the offset decays)
  const mv = { name: null, side: 0, since: -1, ev: null, evSide: 0, evAt: -1, carry: false, cy: 0, cp: 0, aimSet: false, uy: 0, up: 0,
    skimEv: 0, chargeEv: 0, specialEv: false, infOn: false, skyfall: false, lastNear: null, lastStart: null,
    counts: { wingover: 0, loop: 0, dash: 0, inferno: 0, nearmiss: 0, skyfall: 0, charged: 0 } };
  const MOVE_MAX = { wingover: 3, loop: 4, dash: 1.2, inferno: 6 };   // s: an event-only move never outlives this
  const pops = [];                              // FOV / blur pops: { t0, fov, blur, env }
  let skimK = 0, chargeK = 0, cutT = -1, cutW = 0, fxFov = 0, fxBlur = 0, lastNearAt = -1e9, infShake = null;
  const cutHead = new THREE.Vector3();
  // Hover (flight modes). hoverRaw: this frame's hover share from game.player.flightMode (+ airspeed in 'transition');
  // hoverW: the camera's chase ↔ hover blend (smoothed); hoverC: the course override (nose, level) while hovering.
  // hv: the hover view (yaw / pitch / F, its lead off the nose), the aim ray's convergence distance, the lens it starts
  // from (hvLens: the placed lens in hover, else the virtual one), the reticle's angle from the screen centre (tests).
  let hoverRaw = 0, hoverW = 0, hoverC = 0, hvArmDist = 15, hoverFade = 0;   // (hoverFade: this frame's eased hover weight in chase / free)
  const hv = { yaw: 0, pitch: 0, F: new THREE.Vector3(0, 0, 1), lead: 0, conv: T.aimFar, convSrc: 'far', reticleDeg: 0, mode: null, side: T.hoverSide, elev: T.hoverElev };
  const hvLens = new THREE.Vector3(), hvVirt = new THREE.Vector3(), hvAim = new THREE.Vector3(), flAim = new THREE.Vector3();
  const flDir = new THREE.Vector3(0, 0, 1), hvPivot = new THREE.Vector3(), preAvoid = new THREE.Vector3();
  const _hf = new THREE.Vector3(), _hr = new THREE.Vector3(), _hu = new THREE.Vector3(), _hp = new THREE.Vector3(), _hd = new THREE.Vector3(), _hpv = new THREE.Vector3();
  const _hq = new THREE.Quaternion(), _hq2 = new THREE.Quaternion(), hvShake = new THREE.Quaternion();   // (hvShake: the last frame's shake / kick rotation of the hover aim)
  let hvLensSet = false;
  // Aim magnetism toward game.player.softTarget: smoothed yaw / pitch lean (rad) of the aim, weight, the angle of the
  // un-bent aim from the target, its distance.
  const magnet = { target: null, w: 0, oy: 0, op: 0, ang: 0, dist: 0 };

  // scratch
  const P = new THREE.Vector3(), dragonPos = new THREE.Vector3(), dragonVel = new THREE.Vector3();
  const dragonQuat = new THREE.Quaternion(), dragonFwd = new THREE.Vector3();
  // (useQuat: the pose's orientation is poseQ — the aerobatic frame's blend — turned by whatever later moved pose.dir
  //  away from poseQDir; otherwise quatFrom(dir, roll) as always)
  const pose = { pos: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, 1), roll: 0, fov: 62, lookAtPivot: false, useQuat: false };
  const poseQ = new THREE.Quaternion(), poseQDir = new THREE.Vector3(0, 0, 1);
  const _k1 = new THREE.Vector3(), _k2 = new THREE.Vector3(), _k3 = new THREE.Vector3(), _k4 = new THREE.Vector3(), _k5 = new THREE.Vector3();
  const _k6 = new THREE.Vector3(), _k7 = new THREE.Vector3(), _af = new THREE.Vector3(), _au = new THREE.Vector3(), _ar = new THREE.Vector3();
  const _kq = new THREE.Quaternion(), _kq2 = new THREE.Quaternion(), _kq3 = new THREE.Quaternion(), _km = new THREE.Matrix4();
  const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
  const _r = new THREE.Vector3(), _u = new THREE.Vector3(), _t = new THREE.Vector3(), _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler();
  const _f = new THREE.Vector3(), _l = new THREE.Vector3(), _lu = new THREE.Vector3(), _up = new THREE.Vector3();
  const seatPos = new THREE.Vector3(), camQuat = new THREE.Quaternion();
  const _h1 = new THREE.Vector3(), _h2 = new THREE.Vector3(), _h3 = new THREE.Vector3(), _h4 = new THREE.Vector3(), _h5 = new THREE.Vector3();
  const bigShapes = [];
  const seatCache = new WeakMap();
  let seatSource = null;

  // ---- helpers -----------------------------------------------------------------------------------------------
  const player = () => game.player || null;
  const nowReal = () => game.time.real;
  // Results framing state (resultsFrame): smoothed distance and pivot placement, the text block's top (NDC) and when read.
  const res = { dist: 0, tx: 0, ty: 0, set: false, text: 0, textAt: -1, box: null, D: 0, top: 0, bot: 0 };
  const _rr = new THREE.Vector3(), _ru = new THREE.Vector3(), _rp = new THREE.Vector3();

  function readDragon(p) {
    // Follow the drawn root (interpolated, no fixed-step jitter); fall back to the physics pos/quat when there is no
    // root or the root is clearly not being synced (> 25 m from pos).
    const r = p.root;
    let fromRoot = false;
    if (r?.isObject3D) {
      if (!r.parent || r.parent === game.scene) { dragonPos.copy(r.position); dragonQuat.copy(r.quaternion); }
      else { r.getWorldPosition(dragonPos); r.getWorldQuaternion(dragonQuat); }
      fromRoot = !(p.pos?.isVector3 && p.pos.distanceToSquared(dragonPos) > 625);
    }
    if (!fromRoot) {
      if (p.pos) dragonPos.copy(p.pos);
      if (p.quat) dragonQuat.copy(p.quat);
    }
    if (!Number.isFinite(dragonPos.x)) dragonPos.set(0, 1200, 0);
    if (p.vel) dragonVel.copy(p.vel); else dragonVel.set(0, 0, 0);
    dragonFwd.set(0, 0, 1).applyQuaternion(dragonQuat);
  }

  function speedOf(p) { return p?.airspeed ?? p?.vel?.length?.() ?? 0; }

  /** The player's fire breath is on: fx's stream for the dragon (or the dragon's own flag when fx breathes from a
   *  proxy source; the camera's breath event state when there is no fx). */
  function breathingOf(p) {
    if (!p) return false;
    try {
      const fx = game.fx;
      if (typeof fx?.isBreathing === 'function') return !!fx.isBreathing(p) || p.breathing === true;
    } catch { /* optional */ }
    return p.breathing === true || !!breathShake;
  }

  /** Bank angle of an orientation: + = right wing down (model left is +X). */
  function bankOf(q) {
    _f.set(0, 0, 1).applyQuaternion(q); _up.set(0, 1, 0).applyQuaternion(q);
    _l.crossVectors(UP, _f);
    if (_l.lengthSq() < 1e-6) return 0;
    _l.normalize();
    _lu.crossVectors(_f, _l).normalize();
    return Math.atan2(-_up.dot(_l), _up.dot(_lu));
  }

  function initAimFrom(p) {
    readDragon(p);
    const v = dragonVel.lengthSq() > 4 ? _a.copy(dragonVel) : _a.copy(dragonFwd);
    aimYaw = rigYaw = yawOf(v);
    // (hovering: the body is pitched up 20–35° — the aim starts level, not at the sky)
    const hs = hoverShareOf(p);
    aimPitch = rigPitch = clamp(pitchOf(v) * (1 - hs), hs > 0.5 ? T.hoverPitch[0] : -T.aimPitchMax, hs > 0.5 ? T.hoverPitch[1] : T.aimPitchMax);
    hoverC = hs;
    freeYaw = freePitch = 0; freeW = 0;
    hasPrevVel = false; prevHeading = null;
    updateCourse(p);
    leadYaw = leadPitch = 0;
    dirFromYP(aimYaw, aimPitch, aimS);
    aimFor = p;
  }

  /** The dragon's flight direction (velocity; the body's nose when hovering). Near vertical the last yaw is kept.
   *  Hover (hoverC): the nose's heading, level — a strafe or a back drift is not a course, the pitched-up hover body
   *  not a climb. */
  function updateCourse(p) {
    const q = p.quat?.isQuaternion ? p.quat : dragonQuat;
    _cf.set(0, 0, 1).applyQuaternion(q);
    const v = p.vel?.isVector3 ? p.vel : null, sp = v ? v.length() : 0;
    const w = smoothstep(6, 14, sp) * (1 - hoverC);
    _cv.copy(_cf).multiplyScalar(1 - w);
    if (sp > 1e-3) _cv.addScaledVector(v, w / sp);
    if (!(_cv.lengthSq() > 1e-6) || !Number.isFinite(_cv.x + _cv.y + _cv.z)) _cv.copy(_cf);
    _cv.normalize();
    courseV.copy(_cv);
    if (Math.hypot(_cv.x, _cv.z) > 0.2) courseYaw = Math.atan2(_cv.x, _cv.z);
    coursePitch = Math.asin(clamp(_cv.y, -1, 1)) * (1 - hoverC);
    if (Math.hypot(_cf.x, _cf.z) > 0.2) noseYaw = Math.atan2(_cf.x, _cf.z);
  }

  // ---- hover / aim (flight modes, aim magnetism) ------------------------------------------------------------------
  /** game.player.flightMode when published ('hover' | 'transition' | 'flight'), else null (= forward flight). */
  function flightModeOf(p) {
    const m = p?.flightMode;
    return m === 'hover' || m === 'transition' || m === 'flight' ? m : null;
  }
  /** This instant's hover share: 1 hovering, 0 forward flight; 'transition' by airspeed (either direction). */
  function hoverShareOf(p) {
    const m = flightModeOf(p);
    if (m === 'hover') return 1;
    if (m === 'transition') {
      // (taking off — W held, throttle up — the chase comes in earlier than on the way down (hoverTakeoff m/s): W is "fly",
      //  and the real take-off rows up slowly (0 → 20 m/s in ~5 s))
      const up = Number.isFinite(+p.throttle) && p.throttle !== null && +p.throttle > 0.5;
      const r = up ? T.hoverTakeoff : T.hoverSpeed;
      return 1 - smoothstep(r[0], r[1], speedOf(p));
    }
    return 0;
  }
  /** The soft target player.js picked (an enemy near the reticle), when alive and placed. */
  function softOf(p) {
    const s = p?.softTarget;
    return s && s.alive !== false && s.pos?.isVector3 && Number.isFinite(s.pos.x + s.pos.y + s.pos.z) ? s : null;
  }

  /** The hover view (= the aim while hovering): the mouse target + the lock-assist / magnet lean, at most hoverLeadYaw
   *  (soft knee) off the dragon's nose, pitch within hoverPitch. Writes hv.yaw / hv.pitch / hv.F / hv.lead. */
  function hoverView(withMagnet = true) {
    const ty = aimYaw + assist.oy + (withMagnet ? magnet.oy : 0);
    const lead = softCap(wrapAngle(ty - noseYaw), T.hoverLeadYaw);
    hv.lead = lead;
    hv.yaw = wrapAngle(noseYaw + lead);
    hv.pitch = clamp(aimPitch + assist.op + (withMagnet ? magnet.op : 0), T.hoverPitch[0], T.hoverPitch[1]);
    dirFromYP(hv.yaw, hv.pitch, hv.F);
  }
  /** The chase pivot without the aerobatic frame (the early aim hook runs before poseChase places P). */
  function hoverPivotOf(out) { out.copy(dragonPos).add(surge); out.y += T.pivotUp; return out; }
  /** Hover lens over the right shoulder for the view hv.F around `pivot`; with `free` the free-look orbit turns it (and
   *  the view eases onto the pivot as the chase's does). outDir: the view. */
  function placeHover(pivot, outPos, outDir, free = false) {
    const fy = hv.yaw + (free ? freeYaw : 0), fp = clamp(hv.pitch + (free ? freePitch : 0), -80 * DEG, 80 * DEG);
    dirFromYP(fy, fp, _hf);
    const fw = free ? freeW : 0;
    // Looking down (dn 0 → 1 over hoverDownPitch; not while free-looking, that orbit is the player's) the arm rises over
    // her back: the lens rises hoverDownElev more and pulls back hoverDownPull, so she sits lower and smaller and her
    // head and spread wings stay below the reticle (−62° before: the right wing over the reticle 16 % of the frames of
    // a look-down turn), and the shoulder offset is capped (below). Level views and looking up: as before.
    const dn = smoothstep(T.hoverDownPitch[0], T.hoverDownPitch[1], -fp) * (1 - fw);
    const d = hvArmDist * (1 + T.hoverDownPull * dn), e = T.hoverElev + T.hoverDownElev * dn;
    frameBasis(_hf, 0, _hr, _hu);
    // (the view leading to the dragon's left swings the lens round to her right — the shoulder offset adds to it: it
    //  shrinks by hoverSideTurn at the full lead, so the lens stays ≤ ~32° off her tail instead of ~37–40°)
    let side = T.hoverSide * (1 - fw) * (1 - T.hoverSideTurn * smoothstep(0, T.hoverLeadYaw, hv.lead));
    // (and it is capped by the arm's horizontal length behind the view, d·cos(e − pitch): looking down that length
    //  shrinks (to a sixth at −62°) while the offset did not, so the lens slid round to 37.5° off her tail (46.6°
    //  turning left); lead to the left + offset stay ≤ hoverAzMax in the horizontal)
    const backH = d * Math.cos(e - fp);
    if (backH > 0) side = Math.min(side, backH * Math.tan(Math.max(T.hoverSideAzMin, T.hoverAzMax - Math.max(0, hv.lead))));
    if (free) { hv.side = side; hv.elev = e; }   // (the placed lens's, for the snapshot)
    outPos.copy(pivot).addScaledVector(_hf, -d * Math.cos(e)).addScaledVector(_hu, d * Math.sin(e)).addScaledVector(_hr, side);
    if (outDir) {
      outDir.copy(_hf);
      // (free-look: onto the pivot — all of it by freeW 0.5, where poseChase's lookAtPivot takes over, so no step there)
      if (fw > 1e-4) { _hpv.subVectors(pivot, outPos).normalize(); outDir.lerp(_hpv, smoothstep(0, 0.5, fw)).normalize(); }
    }
    return outPos;
  }
  /** Where the hover aim ray (from `origin` along hv.F) converges: the soft target it passes (within aimConvCone), the
   *  ground it meets, else aimFar — at least aimNear from the lens. The distance is smoothed when rdt > 0. */
  function hoverAimPoint(origin, out, rdt) {
    let R = T.aimFar, src = 'far';
    const st = softOf(player());
    if (st) {
      lockPoint(st, _h1);
      _h2.subVectors(_h1, origin);
      const along = _h2.dot(hv.F);
      if (along > T.aimNear) {
        const off = Math.sqrt(Math.max(0, _h2.lengthSq() - along * along));
        if (off < along * Math.tan(T.aimConvCone) + (st.radius || 4) && along < R) { R = along; src = 'soft'; }
      }
    }
    if (hv.F.y < 0.1) {
      // the ground (coarse march; the reticle is the ray either way, this only sets where the flame / fireball converge)
      for (let s = 25; s < R; s += 25) {
        _h2.copy(origin).addScaledVector(hv.F, s);
        if (_h2.y < groundY(_h2.x, _h2.z)) { R = Math.max(s - 12.5, 1); src = 'ground'; break; }
      }
    }
    R = Math.max(R, T.aimNear);
    if (!(hv.conv > 0)) hv.conv = R;
    if (rdt > 0) hv.conv = Math.exp(dampTo(Math.log(hv.conv), Math.log(R), T.aimConvLambda, rdt));
    hv.convSrc = src;
    return out.copy(origin).addScaledVector(hv.F, hv.conv);
  }
  /** The aim the dragon flies / breathes toward: the flight aim (flDir, course + the capped lead) blended with the hover
   *  aim ray by the camera's hover weight — aimPoint lerped, aimDir = dragon → aimPoint (hoverW 0: exactly as before). */
  function blendAim(origin, rdt) {
    const e = ease(clamp(hoverW, 0, 1));
    flAim.copy(dragonPos).addScaledVector(flDir, T.aimFar);
    if (e < 1e-4) { aimDir.copy(flDir); aimPoint.copy(flAim); return; }
    hoverAimPoint(origin, hvAim, rdt);
    aimPoint.lerpVectors(flAim, hvAim, e);
    aimDir.subVectors(aimPoint, dragonPos);
    if (aimDir.lengthSq() < 1) aimDir.copy(hv.F); else aimDir.normalize();
  }

  /** Aim magnetism: bend the aim ≤ magnetMax toward game.player.softTarget while the un-bent aim is within magnetCone
   *  of it (hover: seen from the lens, i.e. the reticle; flight: the flown aim from the dragon). Smoothed offsets
   *  magnet.oy / op, added to the aim by hoverView / composeAim. `active`: play, no free-look, no cinematic. */
  function updateMagnet(rdt, active) {
    const st = active ? softOf(player()) : null;
    let ty = 0, tp = 0, w = 0;
    magnet.target = st;
    magnet.ang = 0; magnet.dist = 0;
    if (st && !(st === lockTarget && assist.w > 0.05)) {
      const hov = hoverW > 0.5;
      const O = hov ? (hvLensSet ? hvLens : hoverPivotOf(_h4)) : dragonPos;
      lockPoint(st, _h1);
      _h2.subVectors(_h1, O);
      const dist = _h2.length();
      if (dist > 5 && dist < T.magnetRange && Number.isFinite(dist)) {
        _h2.divideScalar(dist);
        if (hov) { hoverView(false); _h3.copy(hv.F); } else { composeAim(false); _h3.copy(aimDir); }
        const ang = Math.acos(clamp(_h3.dot(_h2), -1, 1));
        w = (1 - smoothstep(T.magnetCone[0], T.magnetCone[1], ang)) * (1 - smoothstep(0.85 * T.magnetRange, T.magnetRange, dist));
        const lean = Math.min(ang, T.magnetMax) * w;
        if (ang > 1e-5 && lean > 1e-6 && Math.abs(_h2.y) < 0.97 && Math.abs(_h3.y) < 0.97) {
          const k = lean / ang;
          ty = wrapAngle(yawOf(_h2) - yawOf(_h3)) * k;
          tp = (Math.asin(clamp(_h2.y, -1, 1)) - Math.asin(clamp(_h3.y, -1, 1))) * k;
        }
        magnet.ang = ang; magnet.dist = dist;
      }
    }
    magnet.w = w;
    magnet.oy = dampTo(magnet.oy, ty, T.magnetLambda, rdt);
    magnet.op = dampTo(magnet.op, tp, T.magnetLambda, rdt);
    if (!st && Math.abs(magnet.oy) + Math.abs(magnet.op) < 1e-6) magnet.oy = magnet.op = 0;
  }

  /** Chase → hover: blend the placed chase pose (pose.*) toward the hover TPS pose by the hover weight — the lens along
   *  an arc around the pivot (never through the dragon), the orientation by a slerp (the chase roll rolls out). */
  function blendHover() {
    const e = ease(clamp(hoverW, 0, 1));
    hvArmDist = Math.max(T.hoverDistMin, zoomS * T.hoverDist) * (1 + 0.15 * bossK);
    hoverView();
    placeHover(P, _hp, _hd, true);
    if (pose.useQuat) _hq.setFromUnitVectors(poseQDir, pose.dir).multiply(poseQ); else quatFrom(pose.dir, pose.roll, _hq);
    quatFrom(_hd, 0, _hq2);
    _k1.subVectors(pose.pos, P); _k2.subVectors(_hp, P);
    const la = _k1.length(), lb = _k2.length();
    if (la > 1e-3 && lb > 1e-3) {
      _k1.divideScalar(la); _k2.divideScalar(lb);
      _kq.setFromUnitVectors(_k1, _k2); _kq2.identity().slerp(_kq, e);
      pose.pos.copy(P).add(_k1.applyQuaternion(_kq2).multiplyScalar(lerp(la, lb, e)));
    } else pose.pos.lerp(_hp, e);
    poseQ.slerpQuaternions(_hq, _hq2, e);
    pose.dir.set(0, 0, -1).applyQuaternion(poseQ);
    poseQDir.copy(pose.dir);
    pose.useQuat = true;
    pose.roll = lerp(pose.roll, 0, e);
    pose.fov = lerp(pose.fov, T.hoverFov + num(settings.fovOffset, 0, -10, 10), e);
  }

  /** Sideways dodge hop in progress (FlightBody state.dodging: −1 / +1 while hopping, 0 otherwise). */
  function dodgingOf(p) {
    const b = p?.body || p?.flight;
    const d = b?.state?.dodging;
    return typeof d === 'number' ? d !== 0 : !!d;
  }

  /** C1 soft limit: identity up to knee·cap, then eases into ±cap. */
  function softCap(x, cap, knee = T.leadKnee) {
    const a = Math.abs(x), k = knee * cap;
    if (a <= k) return x;
    const r = cap - k;
    return Math.sign(x) * (k + r * Math.tanh((a - k) / r));
  }

  /** Aim = course + the lead toward the mouse target, capped on an ellipse (leadYaw × leadPitch). A lock-on assist
   *  leans the lead toward the locked target before the cap (the lead never exceeds what a mouse turn gives). */
  function composeAim(withMagnet = true) {
    // (hover / aim: the soft-target magnet leans the aim too, ≤ magnetMax; still inside the cap)
    const ly = wrapAngle(aimYaw - courseYaw) + assist.oy + (withMagnet ? magnet.oy : 0);
    const lp = aimPitch - coursePitch + assist.op + (withMagnet ? magnet.op : 0);
    const ex = ly / T.leadYaw, ey = lp / T.leadPitch, r = Math.hypot(ex, ey);
    const k = r > 1e-9 ? softCap(r, 1) / r : 1;
    leadYaw = ly * k; leadPitch = lp * k;
    dirFromYP(courseYaw + leadYaw, clamp(coursePitch + leadPitch, -85 * DEG, 85 * DEG), aimDir);
  }

  function titanActor() {
    const a = game.titan?.actor;
    return a && a.alive !== false && game.titan.active !== false && a.root?.visible !== false ? a : null;
  }
  function actorPoint(a, part, out) {
    if (a.shapes) for (const s of a.shapes) if (s.part === part) return out.copy(s.a);
    return out.copy(a.pos || _a.set(0, 0, 0)).add(_b.set(0, part === 'head' ? 50 : part === 'core' ? 30 : 0, 0));
  }

  /** 'saddle' when an anchor marks the seat surface (the camera adds the seated eye height), else 'eye'. */
  function anchorKind(o) {
    const k = o.userData?.skyfire?.kind ?? o.userData?.kind ?? o.userData?.seat;
    return k === 'saddle' || k === 'seat' ? 'saddle' : 'eye';
  }

  function seatOf(p, out) {
    // Kaede's eyes: dragon.seatAnchor (Object3D at eye level, or userData.kind 'saddle' for the seat surface) →
    // rider Head bone → dragon 'saddle' bone → fixed offset on the dragon.
    _f.set(0, 0, 1).applyQuaternion(dragonQuat); _up.set(0, 1, 0).applyQuaternion(dragonQuat);
    const sa = p.seatAnchor?.isObject3D ? p.seatAnchor : null;
    if (sa) {
      sa.getWorldPosition(out);
      if (anchorKind(sa) === 'saddle') out.addScaledVector(_up, T.saddleToEye);
      seatSource = 'seatAnchor';
    } else {
      let o = seatCache.get(p);
      if (!o || (o.none && nowReal() - o.t > 2)) {
        // Models load asynchronously: an unresolved seat is looked up again every 2 s.
        const r = p.rider;
        o = (r?.bones?.get?.('Head')) || (r?.head?.isObject3D ? r.head : null);
        if (!o && r) {
          for (const root of [r.root, r.scene, r.group, r.object, r.model?.scene, r.mesh]) {
            root?.traverse?.((c) => { if (!o && c.isBone && /(^|:)Head$/.test(c.name)) o = c; });
            if (o) break;
          }
        }
        if (!o) {
          const rig = p.rig, si = rig?.i ? rig.i('saddle') : -1;
          const saddle = si >= 0 ? rig.bones?.[si] : p.bones?.get?.('saddle');
          o = saddle?.isObject3D ? { saddle } : { none: true, t: nowReal() };
        }
        seatCache.set(p, o);
      }
      if (o?.saddle) { o.saddle.getWorldPosition(out); out.addScaledVector(_up, T.saddleToEye); seatSource = 'saddle'; }
      else if (o?.isObject3D) { o.getWorldPosition(out); seatSource = 'riderHead'; }
      else { out.copy(dragonPos).addScaledVector(_up, 2.35).addScaledVector(_f, 1.2); seatSource = 'offset'; }
    }
    // Eye: just behind and over Kaede's head (her helmet reads at the bottom edge, the near plane never cuts it).
    return out.addScaledVector(_up, T.riderEye[0]).addScaledVector(_f, T.riderEye[1]);
  }

  function heightAt(x, z) {
    try { const h = game.world?.heightAt?.(x, z); return Number.isFinite(h) ? h : 0; } catch { return 0; }
  }
  function groundY(x, z) { return Math.max(heightAt(x, z), game.world?.seaLevel ?? 0); }
  /** Flight moves (skim along a wooded bank): the ground or, when the world publishes it, the tree canopy there
   *  (vegetation.canopyAt(x, z) / world.canopyAt(x, z) → top height in m, or ≤ ground / NaN for none). Only the arm march
   *  uses it: a tree between the dragon and the lens pulls the lens in, like a hill does. Feature-detected. */
  let canopyFn = undefined, canopyFail = 0, skimOpen = 1;
  /** 1 when the dragon, the arm's middle and the lens are all over an open surface (water, or > 30 m above the ground:
   *  a cloud top), else 0 — trees and houses stand only on land. world.waterLevelAt as the player's skim uses it. */
  function openUnderArm() {
    const w = game.world;
    for (let i = 0; i < 3; i++) {
      const pt = i === 0 ? dragonPos : i === 1 ? _k5.copy(dragonPos).lerp(cam.position, 0.5) : cam.position;
      const g = heightAt(pt.x, pt.z);
      if (pt.y - g > 30) continue;
      let water = g <= (w?.seaLevel ?? 0) + 0.3;
      if (!water && typeof w?.waterLevelAt === 'function') { try { water = w.waterLevelAt(pt.x, pt.z) >= g - 0.05; } catch { water = false; } }
      if (!water) return 0;
    }
    return 1;
  }
  function obstacleY(x, z) {
    const g = groundY(x, z);
    if (canopyFn === undefined || (canopyFn === null && (game.time.frame & 63) === 0)) {
      const v = game.vegetation, w = game.world;
      canopyFn = typeof v?.canopyAt === 'function' ? (a, b) => v.canopyAt(a, b) : typeof w?.canopyAt === 'function' ? (a, b) => w.canopyAt(a, b) : null;
    }
    if (!canopyFn || canopyFail > 5) return g;
    try { const c = +canopyFn(x, z); return Number.isFinite(c) && c > g ? c : g; } catch { canopyFail++; return g; }
  }

  function shapeDist(s, p, out) {
    if (s.kind === 'capsule' && s.b) closestOnSegment(p, s.a, s.b, out); else out.copy(s.a);
    return out.distanceTo(p) - s.r;
  }

  // Big bodies the lens must never enter: every actor over 25 m (the titan). A titan may publish finer camera proxies
  // as game.titan.cameraShapes (same shape format, world space), used instead of its hit shapes.
  const titanProxy = { pos: null, radius: 0, shapes: null };
  function gatherBig(p) {
    bigShapes.length = 0;
    const tt = game.titan;
    const t = tt?.actor;
    const tActive = !!t && t.alive !== false && tt.active !== false;
    let cs = null;
    try { cs = tActive ? tt.cameraShapes : null; } catch { cs = null; }
    const useProxy = Array.isArray(cs) && cs.length > 0;
    for (const a of game.actors || []) {
      if (!a || a.alive === false || a === p?.actor || !a.shapes?.length) continue;
      if (a === t && (useProxy || !tActive)) continue;
      if (a.kind === 'titan' || (a.radius || 0) > 25) bigShapes.push(a);
    }
    if (useProxy) {
      titanProxy.pos = t.pos; titanProxy.radius = (t.radius || 150) + 40; titanProxy.shapes = cs;
      bigShapes.push(titanProxy);
    } else if (tActive && t.shapes?.length && !bigShapes.includes(t)) bigShapes.push(t);
  }

  // While the titan holds the dragon, its grabbing hand and forearm are not solid for the camera (the pivot is in it).
  const skipShape = (s) => grabHand !== null && (s.part === 'hand' + grabHand || s.part === 'arm' + grabHand);

  function insideBig(pt, margin) {
    for (const a of bigShapes) {
      if (a.pos && a.radius && a.pos.distanceTo(pt) > a.radius + margin + 60) continue;
      for (const s of a.shapes) {
        if (!s?.a || skipShape(s)) continue;
        if (shapeDist(s, pt, _c) < margin) return true;
      }
    }
    return false;
  }

  function pushOut(pt, actors, margin) {
    for (let it = 0; it < 3; it++) {
      let moved = false;
      for (const a of actors) {
        if (a.pos && a.radius && a.pos.distanceTo(pt) > a.radius + margin + 60) continue;
        for (const s of a.shapes) {
          if (!s?.a || skipShape(s)) continue;
          if (s.kind === 'capsule' && s.b) closestOnSegment(pt, s.a, s.b, _c); else _c.copy(s.a);
          _d.subVectors(pt, _c);
          if (_d.length() - s.r < margin) {
            const len = _d.length();
            if (len < 1e-4) _d.set(0, 1, 0); else _d.divideScalar(len);
            pt.copy(_c).addScaledVector(_d, s.r + margin);
            moved = true;
          }
        }
      }
      if (!moved) break;
    }
  }

  function quatFrom(dir, roll, out) {
    const up = Math.abs(dir.y) > 0.999 ? _b.set(0, 0, dir.y > 0 ? -1 : 1) : UP;
    _r.crossVectors(dir, up).normalize();
    _u.crossVectors(_r, dir).normalize();
    if (roll) {
      const c = Math.cos(roll), s = Math.sin(roll);
      _t.copy(_u).multiplyScalar(c).addScaledVector(_r, s);
      _r.multiplyScalar(c).addScaledVector(_u, -s);
      _u.copy(_t);
    }
    _m.makeBasis(_r, _u, _t.copy(dir).negate());
    return out.setFromRotationMatrix(_m);
  }

  /** Right / up of a view along `dir` rolled by `roll` (same convention as quatFrom: + tilts the up to the right). */
  function frameBasis(dir, roll, R, U) {
    const up = Math.abs(dir.y) > 0.999 ? _b.set(0, 0, dir.y > 0 ? -1 : 1) : UP;
    R.crossVectors(dir, up).normalize();
    U.crossVectors(R, dir).normalize();
    if (roll) {
      const c = Math.cos(roll), s = Math.sin(roll);
      _t.copy(U).multiplyScalar(c).addScaledVector(R, s);
      R.multiplyScalar(c).addScaledVector(U, -s);
      U.copy(_t);
    }
  }

  // ---- flight moves (wingover / loop / dash / near miss / skim / inferno / charge) ------------------------------------
  /** Camera orientation looking along `dir` with `up` (any frame, no world-up reference: works upside down / vertical). */
  function quatFromUp(dir, up, out) {
    _k6.crossVectors(dir, up);
    if (_k6.lengthSq() < 1e-10) return quatFrom(dir, 0, out);
    _k6.normalize();
    _k7.crossVectors(_k6, dir).normalize();
    _km.makeBasis(_k6, _k7, _k5.copy(dir).negate());
    return out.setFromRotationMatrix(_km);
  }
  /** Signed angle from a to b about `axis` (right-handed; a, b roughly ⊥ axis). */
  const signedAngle = (a, b, axis) => Math.atan2(_k3.crossVectors(a, b).dot(axis), a.dot(b));

  /** The aerobatic frame turned by an orbit offset: yaw about its up, then pitch about its right (like placeChase's
   *  yaw / pitch offsets in the level frame). Writes _af (forward), _au (up), _ar (right). */
  function aeroBasis(oy, op) {
    _af.copy(aero.F); _au.copy(aero.U);
    if (oy) _af.applyAxisAngle(_au, oy);
    _ar.crossVectors(_af, _au).normalize();
    if (op) { _af.applyAxisAngle(_ar, op); _au.applyAxisAngle(_ar, op); }
  }

  /** The aerobatic chase frame (wingover / loop from the player's moves, or near-vertical flight). `allowed`: the camera
   *  mode can use it. Seeds itself from the current chase frame, so it blends in without a jump; while it is fully in, the
   *  normal rig rides along (rigYaw / rigPitch / rollS), so the blend back out starts from where the camera is. `seat`:
   *  the rider view uses the frame (its up is half the dragon's own, which already rolls 1:1): the eased roll only. */
  function updateAero(rdt, sk, allowed, seat = false) {
    const moveKind = mv.name === 'wingover' || mv.name === 'loop' ? mv.name : null;
    const vy = Math.abs(courseV.y);
    aero.vertical = aero.vertical ? vy > T.aeroVertical[0] : vy > T.aeroVertical[1];
    let kind = moveKind || (aero.vertical ? 'vertical' : null);
    // after the move: 'settle' — the frame stays in, rolling toward the normal chase roll (rollFollow of the bank, ≤ rollMax),
    // until it is there (aeroSettle[0]) or aeroSettle[1] s have passed; only then does it blend out (a blend-out from a
    // frame still rolled 90° swung the view 4.6°/frame)
    if (kind) aero.settled = false;
    else if (aero.init && aero.w > 0.05 && !aero.settled) {
      if (aero.kind !== 'settle') { aero.settleAt = nowReal(); aero.kind = 'settle'; aero.settleNew = true; aero.catchUp = false; }
      if (nowReal() - aero.settleAt < T.aeroSettle[1]) kind = 'settle';
    }
    const want = allowed && !!kind;
    // (a new move / episode: the dragon has not been upside down in it yet)
    if (want && kind !== 'settle' && kind !== aero.kind) aero.invSeen = false;
    if (want) { aero.kind = kind; if (kind !== 'settle') aero.fromMove = kind !== 'vertical'; }
    aero.w = dampTo(aero.w, want ? 1 : 0, want ? T.aeroIn : T.aeroOut, rdt);
    if (!want && aero.w < 2e-3) { aero.w = 0; aero.init = false; aero.hasPrev = false; aero.lead = 0; aero.invSeen = false; aero.catchUp = false; return; }
    if (!aero.init) {
      dirFromYP(rigYaw, rigPitch, aero.F); frameBasis(aero.F, rollS, _k1, aero.U);
      aero.init = true; aero.hasPrev = false; aero.omega.set(0, 0, 0); aero.rollW = 0;
    }
    if (!(rdt > 0)) return;
    const K = aero.kind || 'vertical';
    // target forward: the course + a share of the nose (a tail-slide's opposite nose falls back to the course)
    const kn = T.aeroNose[K] ?? 0.25;
    _k2.copy(courseV).multiplyScalar(1 - kn).addScaledVector(dragonFwd, kn);
    if (_k2.lengthSq() < 1e-4) _k2.copy(courseV);
    _k2.normalize();
    // its own turn rate (smoothed: the wingbeat wobbles the velocity), fed forward
    if (aero.hasPrev) {
      _k4.crossVectors(aero.tPrev, _k2);
      const s = _k4.length(), ang = Math.atan2(s, aero.tPrev.dot(_k2));
      if (s > 1e-7) _k4.multiplyScalar(Math.min(ang / rdt, 5) / s); else _k4.set(0, 0, 0);
      aero.omega.lerp(_k4, damp(10, rdt));
    }
    aero.tPrev.copy(_k2); aero.hasPrev = true;
    const lam = Math.max(0.5, T.aeroLambda * sk);
    const om = aero.omega.length();
    aero.lead = Math.min(om * T.aeroFF / lam, T.aeroLeadMax);
    if (aero.lead > 1e-5 && om > 1e-6) _k2.applyAxisAngle(_k4.copy(aero.omega).divideScalar(om), aero.lead);
    // follow: turn F toward the target; U turns with it (parallel transport), then is re-orthogonalised
    _kq.setFromUnitVectors(aero.F, _k2);
    _kq2.identity().slerp(_kq, damp(lam, rdt));
    aero.F.applyQuaternion(_kq2).normalize();
    aero.U.applyQuaternion(_kq2);
    aero.U.addScaledVector(aero.F, -aero.U.dot(aero.F));
    if (aero.U.lengthSq() < 1e-8) frameBasis(aero.F, 0, _k1, aero.U); else aero.U.normalize();
    // roll toward the target up: the dragon's up (loop / vertical), or aeroRoll of its bank from the level up (wingover)
    _k1.set(0, 1, 0).applyQuaternion(dragonQuat);
    const upY = _k1.y;
    aero.inverted = upY < -0.25;
    if (aero.inverted && (K === 'loop' || K === 'vertical')) aero.invSeen = true;
    _k1.addScaledVector(aero.F, -_k1.dot(aero.F));
    const ud = _k1.length();
    const settle = K === 'settle';
    const r = settle ? num(settings.rollFollow, T.rollFollow, 0, 0.8) : T.aeroRoll[K] ?? 1;
    const rmax = settle ? T.rollMax : T.aeroRollMax;
    let target = null;
    if (ud > 0.2) {
      _k1.divideScalar(ud);
      target = _k1;
      if (r < 0.999) {
        _k2.copy(UP).addScaledVector(aero.F, -aero.F.y);
        const ul = _k2.length();
        if (ul > 0.15) {
          _k2.divideScalar(ul);
          // (settle: the normal chase's roll rule — its fade near inverted included)
          let a = signedAngle(_k2, _k1, aero.F);
          if (settle) a = clamp(a, -75 * DEG, 75 * DEG) * (1 - smoothstep(95 * DEG, 150 * DEG, Math.abs(a)));
          target = _k2.applyAxisAngle(aero.F, clamp(a * r, -rmax, rmax));
        }
      }
    } else if (settle) target = _k1.copy(UP).addScaledVector(aero.F, -aero.F.y).normalize();
    if (target) {
      const e = signedAngle(aero.U, target, aero.F);
      // (eased while the dragon is upside down: the roll follow ramps from aeroRollInv back to aeroRollLambda as its up
      //  comes back over the horizon — the half roll starts as the dragon rolling on screen. Loop / vertical once it has
      //  been upside down, and the settle after it: the ramp goes to aeroRollUp / aeroRollUpRate over up.y −0.3 → 0, so
      //  the world is upright when the dragon is — measured: the eased follow left the horizon 95° / 44° / 14° off an
      //  upright dragon 0.1 / 0.3 / 0.6 s after the Immelmann.)
      // (seat view: not — half of its up is the dragon's own; with the fast frame on top it spun at 514°/s p99, faster
      //  than the dragon's own tucked roll)
      const fast = !seat && aero.invSeen && (K === 'loop' || K === 'vertical' || settle);
      let lr, rate;
      if (fast) {
        const wu = smoothstep(T.aeroRollUpRamp[0], T.aeroRollUpRamp[1], upY);
        lr = lerp(T.aeroRollInv, T.aeroRollUp, wu); rate = lerp(T.aeroRollRate, T.aeroRollUpRate, wu);
      } else { lr = lerp(T.aeroRollInv, T.aeroRollLambda, smoothstep(-0.6, 0.3, upY)); rate = T.aeroRollRate; }
      // a settle that starts far off the chase roll (> aeroSettleCatch[0]) catches up at ≥ λ aeroSettleCatch[1], uncapped
      if (settle && aero.settleNew) { aero.catchUp = Math.abs(e) > T.aeroSettleCatch[0]; aero.settleNew = false; }
      if (settle && aero.catchUp && !seat) { lr = Math.max(lr, T.aeroSettleCatch[1]); rate = Infinity; }
      lr *= sk;
      const mx = rate * rdt;
      // (the spin builds up at ≤ aeroRollAcc — the ramp to λ aeroRollUp otherwise started the world's roll with a kick:
      //  2 → 9°/frame in two frames; slowing down is not limited, so it never overshoots)
      let w = clamp(e * damp(lr, rdt), -mx, mx) / rdt;
      const wMax = Math.abs(aero.rollW) + T.aeroRollAcc * rdt;
      if (Math.abs(w) > wMax) w = Math.sign(w) * wMax;
      aero.rollW = w;
      aero.U.applyAxisAngle(aero.F, w * rdt);
      aero.rollE = e; aero.rollLam = lr;
      if (settle && Math.abs(e) < T.aeroSettle[0]) aero.settled = true;
    } else if (settle) { aero.settled = true; aero.settleNew = false; }
    if (!target) aero.rollW = 0;
    // the normal rig rides along while the frame is fully in (near the vertical its yaw is undefined: left alone)
    if (aero.w > 0.98 && Math.hypot(aero.F.x, aero.F.z) > 0.3) {
      rigYaw = yawOf(aero.F); rigPitch = clamp(pitchOf(aero.F), -T.aimPitchMax, T.aimPitchMax);
      _k2.copy(UP).addScaledVector(aero.F, -aero.F.y).normalize();
      rollS = clamp(signedAngle(_k2, aero.U, aero.F), -T.rollMax, T.rollMax);
    }
  }

  /** Wingover / loop: the aim target rides with the course, so the dragon ends the reversal flying its new course
   *  instead of turning back toward the old target. What decays (moveCarry, rdt > 0 once per frame) is only the rest of
   *  the offset — the pending turn at the move start, the A / D lead, the pitch clamp over the top; the aim motion the
   *  player makes DURING the move (mv.uy / mv.up, steerMotion) is kept, so a mouse swing during a wingover picks the exit
   *  direction (it was decayed at 2/s too: a 42° swing moved the exit course 5.6°). A setAim() during the move (another
   *  owner scripting the aim) switches the carry off for that move. */
  function carryAim(rdt = 0) {
    if (!mv.carry || mv.aimSet) { mv.cy = courseYaw; mv.cp = coursePitch; return; }
    const dy = wrapAngle(courseYaw - mv.cy), dp = coursePitch - mv.cp;
    mv.cy = courseYaw; mv.cp = coursePitch;
    aimYaw = wrapAngle(aimYaw + dy);
    aimPitch += dp;
    if (rdt > 0) {
      const k = damp(T.moveCarry, rdt);
      const restY = wrapAngle(wrapAngle(aimYaw - courseYaw) - mv.uy), restP = (aimPitch - coursePitch) - mv.up;
      aimYaw = wrapAngle(aimYaw - restY * k);
      aimPitch -= restP * k;
    }
    aimPitch = clamp(aimPitch, -T.aimPitchMax, T.aimPitchMax);
    dirFromYP(aimYaw, aimPitch, targetDir);
  }
  /** steerMotion's mouse / right-stick aim motion (rad) during a carried move: kept through the move (capped). */
  function carryUser(ey, ep) {
    if (!mv.carry || mv.aimSet) return;
    mv.uy = clamp(mv.uy + ey, -T.moveUserMax[0], T.moveUserMax[0]);
    mv.up = clamp(mv.up + ep, -T.moveUserMax[1], T.moveUserMax[1]);
  }

  function pushPop(fov, blur, env) {
    if (pops.length >= 6) pops.shift();
    pops.push({ t0: nowReal(), fov, blur, env });
  }
  /** Sum of the live FOV / blur pops (dash, near miss, skyfall, charged release) into fxFov / fxBlur. */
  function updatePops() {
    const now = nowReal();
    fxFov = 0; fxBlur = 0;
    for (let i = pops.length - 1; i >= 0; i--) {
      const e = pops[i], t = now - e.t0;
      if (t > envLen(e.env) || t < -1) { pops.splice(i, 1); continue; }
      const k = env3(t, e.env);
      fxFov += e.fov * k; fxBlur += e.blur * k;
    }
  }

  function onMoveStart(name, side) {
    const p = player();
    if (mv.counts[name] !== undefined) mv.counts[name]++;
    mv.lastStart = { name, side, t: +nowReal().toFixed(3) };
    if (name === 'dash') {
      pushPop(T.dashFov, T.dashBlur, T.dashEnv);
      if (p) kick(_k1.copy(dragonFwd).negate(), T.dashKick);      // the dragon surges ahead of the lens
    }
    if (name === 'wingover' || name === 'loop') { mv.carry = true; mv.aimSet = false; mv.cy = courseYaw; mv.cp = coursePitch; mv.uy = mv.up = 0; }
  }

  /** The move in progress: game.player.moves.current when the player publishes it, else the 'move' events. */
  function pollMoves(p, st) {
    let name = null, side = 0;
    const m = p?.moves;
    let bm = null;
    if (!(m && typeof m === 'object' && 'current' in m)) { try { bm = (p?.body || p?.flight)?.move ?? null; } catch { bm = null; } }
    if (m && typeof m === 'object' && 'current' in m) { name = typeof m.current === 'string' ? m.current : null; side = +m.side || 0; mv.src = 'moves'; }
    else if (bm && typeof bm.name === 'string') { name = bm.name; side = +bm.side || 0; mv.src = 'body'; }   // (FlightBody.move)
    else if (mv.ev && nowReal() - mv.evAt < (MOVE_MAX[mv.ev] ?? 3)) { name = mv.ev; side = mv.evSide; mv.src = 'event'; }
    else mv.src = null;
    if (st !== 'play' || !p) name = null;
    if (name !== mv.name) {
      if (mv.name === 'wingover' || mv.name === 'loop') mv.carry = false;
      mv.name = name; mv.side = side; mv.since = nowReal();
      if (name) onMoveStart(name, side);
    }
    // the inferno special: the move, the dragon's flag, or the 'special' event — its start cuts in on the head
    const inf = !!p && st === 'play' && (name === 'inferno' || p.infernoActive === true || mv.specialEv);
    if (inf && !mv.infOn) {
      mv.counts.inferno += name === 'inferno' ? 0 : 1;             // (a move start counted it already)
      if (viewMode === 'chase' && !freeHeld) cutT = nowReal();
      if (settings.autoShake) {
        shake(0.35, 0, 'near');
        infShake = shake(0.34, 1e9, { kind: 'inferno', decay: 3 }); if (infShake) infShake.handle = true;
      }
    } else if (!inf && mv.infOn && infShake) { infShake.hold = 0; infShake = null; }
    mv.infOn = inf;
    // skim / charge: the dragon's numbers, else the events
    const sk = Number.isFinite(p?.skim) ? clamp(+p.skim, 0, 1) : mv.skimEv;
    const ch = Number.isFinite(p?.fireCharge) ? clamp(+p.fireCharge, 0, 1) : mv.chargeEv;
    return { skim: st === 'play' ? sk : 0, charge: st === 'play' ? ch : 0 };
  }

  /** The head / mouth point of the dragon (the cut-in's subject). */
  function headPoint(p, out) {
    const m = p.mouth;
    if (m?.isVector3 && Number.isFinite(m.x + m.y + m.z) && m.distanceToSquared(dragonPos) < 400) return out.copy(m);
    for (const s of p.actor?.shapes || []) if (s?.part === 'head' && s.a?.isVector3) return out.copy(s.a);
    return out.copy(dragonPos).addScaledVector(dragonFwd, 6).addScaledVector(_k1.set(0, 1, 0).applyQuaternion(dragonQuat), 1);
  }

  /** Inferno cut-in (chase): the lens pushes in over Kaede's right shoulder onto the head for T.cutEnv, then back. The
   *  lens is placed in the dragon's own frame (above-behind her shoulder); the view looks between the head and the start
   *  of the stream, turned toward the head when needed so the head always sits inside cutHeadMax of the half-FOV (the
   *  dragon raises its head at the aim: looking along mouthDir alone put the head below the frame). */
  function applyCut(p) {
    if (cutT < 0) { cutW = 0; return; }
    const t = nowReal() - cutT;
    if (t > envLen(T.cutEnv)) { cutT = -1; cutW = 0; return; }
    cutW = env3(t, T.cutEnv) * (1 - freeW);
    if (cutW < 1e-4) return;
    headPoint(p, cutHead);
    _au.set(0, 1, 0).applyQuaternion(dragonQuat);                 // dragon up
    _ar.crossVectors(dragonFwd, _au).normalize();                  // dragon right (model −X)
    _k1.copy(dragonPos).addScaledVector(_au, T.cutUp).addScaledVector(dragonFwd, T.cutBack).addScaledVector(_ar, T.cutSide);
    // the stream's start: along the mouth direction, kept within 25° of the nose
    const md = p.mouthDir?.isVector3 && p.mouthDir.lengthSq() > 0.5 ? _k2.copy(p.mouthDir).normalize() : _k2.copy(dragonFwd);
    const am = Math.acos(clamp(md.dot(dragonFwd), -1, 1));
    if (am > 25 * DEG) md.lerp(dragonFwd, 1 - (25 * DEG) / am).normalize();
    _k4.copy(cutHead).addScaledVector(md, T.cutAhead).sub(_k1).normalize();   // lens → stream
    _af.subVectors(cutHead, _k1).normalize();                                   // lens → head
    _k2.copy(_af).multiplyScalar(T.cutLook).addScaledVector(_k4, 1 - T.cutLook).normalize();
    const a = Math.acos(clamp(_k2.dot(_af), -1, 1)), aMax = T.cutHeadMax * (T.cutFov * DEG) / 2;
    if (a > aMax) _k2.copy(_af).lerp(_k2, aMax / a).normalize();
    pose.pos.lerp(_k1, cutW);
    pose.dir.lerp(_k2, cutW);
    if (pose.dir.lengthSq() < 1e-6) pose.dir.copy(_k2); else pose.dir.normalize();
    pose.fov = lerp(pose.fov, T.cutFov, cutW);
    pose.lookAtPivot = false;
  }

  function beginBlend(dur) {
    const p = player();
    if (p) readDragon(p);
    blend.fromRel.subVectors(cam.position, dragonPos);
    blend.fromQuat.copy(cam.quaternion);
    blend.fromFov = cam.fov;
    blend.t = 0; blend.dur = Math.max(0.01, dur); blend.active = true;
  }

  function persist() {
    try { localStorage.setItem('skyfire.camera', JSON.stringify(settings)); } catch { /* ignore */ }
  }

  // ---- lock-on ------------------------------------------------------------------------------------------------
  function lockCandidates() {
    const p = player();
    const from = p ? dragonPos : cam.position;
    const list = [];
    for (const a of game.actors || []) {
      if (!a || a.alive === false || a.team !== 'enemy' || !a.pos) continue;
      _a.subVectors(a.pos, from);
      const dist = _a.length();
      if (dist < 1 || dist > 2500) continue;
      const ang = Math.acos(clamp(_a.dot(aimDir) / dist, -1, 1));
      list.push({ a, score: ang * 3 + dist / 2500 });
    }
    list.sort((x, y) => x.score - y.score);
    return list.map((x) => x.a);
  }
  function setLock(target) {
    if (target === lockTarget) return;
    lockTarget = target || null;
    game.events.emit('lock', { target: lockTarget });
  }
  function cycleLock() {
    const list = lockCandidates();
    if (!list.length) { setLock(null); return null; }
    const i = lockTarget ? list.indexOf(lockTarget) : -1;
    setLock(list[(i + 1) % list.length]);
    return lockTarget;
  }

  const isBig = (a) => a.kind === 'titan' || (a.radius || 0) > 25;
  /** Where the lock aims: the titan's core (its weak point), anything else its centre. */
  function lockPoint(a, out) { return isBig(a) ? actorPoint(a, 'core', out) : out.copy(a.pos); }

  /** Lock-on aim assist (flying; before composeAim). Never turns the camera: it only moves the aim. `stick`: the mouse
   *  target may follow the target's bearing (play, no free-look, no cinematic). */
  function updateAssist(rdt, stick) {
    const t = lockTarget && lockTarget.alive !== false && lockTarget.pos ? lockTarget : null;
    if (t !== assist.target) { assist.target = t; assist.has = false; }
    let w = 0;
    if (t) {
      lockPoint(t, _h1);
      _h2.subVectors(_h1, dragonPos);
      const dist = _h2.length();
      if (dist > 1 && Number.isFinite(dist)) {
        // Lead: aim where the target will be when the flame gets there (≤ lockLead s). The flame leaves the mouth at
        // lockFlame m/s ON TOP of the dragon's velocity (fire.js), so the lead is the RELATIVE velocity: a head-on
        // target needs almost none (the absolute lead put the aim 16° off a head-on rider at 41 m).
        // The lead is capped at lockLeadMax off the target (fireballs lead and home by themselves, player.js / fire.js;
        // a full 0.6 s on a rider crossing at 43 m/s 84 m out put the reticle 17° beside it).
        if (t.vel?.isVector3 && Number.isFinite(t.vel.x)) {
          const tl = Math.min(T.lockLead, dist / T.lockFlame);
          _h5.copy(t.vel).sub(dragonVel).multiplyScalar(tl).clampLength(0, dist * Math.tan(T.lockLeadMax));
          if (Number.isFinite(_h5.x + _h5.y + _h5.z)) { _h1.add(_h5); _h2.subVectors(_h1, dragonPos); }
        }
        _h2.normalize();
        assist.dir.copy(_h2);
        const y = yawOf(_h2), pch = Math.asin(clamp(_h2.y, -1, 1));
        const fade = isBig(t) ? smoothstep(T.lockBigRange[0], T.lockBigRange[1], dist) : smoothstep(T.lockRange[0], T.lockRange[1], dist);
        const ang = Math.acos(clamp(_h2.dot(targetDir), -1, 1));
        w = (1 - smoothstep(T.lockAssist[0], T.lockAssist[1], ang)) * fade;
        assist.ang = ang;
        // Sticky: inside the assist cone the mouse target moves with the target's bearing (fully, rate-limited), so a
        // crossing target never slides out of the cone by itself (following only w of it let the offset grow by
        // (1 − w) × the bearing rate until the lock let go: measured w 0.82 → 0 in 1.2 s at 90–140 m). On top, a gentle
        // pull (lockPull × w, 1/s) draws the mouse target onto the target; the player's own mouse motion adds on top and
        // a flick past the cone breaks away.
        const ws = (1 - smoothstep(0.75 * T.lockAssist[1], T.lockAssist[1] + 4 * DEG, ang)) * fade;
        if (assist.has && stick && Math.abs(pch) < 80 * DEG && ws > 1e-3) {
          const lim = T.lockStickRate * rdt;
          const dy = clamp(wrapAngle(y - assist.yaw), -lim, lim) * ws, dp = clamp(pch - assist.pitch, -lim, lim) * ws;
          const k = damp(T.lockPull * w, rdt);
          const my = wrapAngle(y - aimYaw - dy) * k, mp = (pch - aimPitch - dp) * k;
          aimYaw = wrapAngle(aimYaw + dy + my);
          aimPitch = clamp(aimPitch + dp + mp, -T.aimPitchMax, T.aimPitchMax);
          assist.stuck += Math.abs(dy) + Math.abs(dp) + Math.abs(my) + Math.abs(mp);
          dirFromYP(aimYaw, aimPitch, targetDir);
        }
        assist.yaw = y; assist.pitch = pch; assist.dist = dist; assist.has = true;
      }
    }
    // The lean toward the target, relative to the mouse target, smoothed (a new lock, a lost lock or a flick away
    // never makes the aim jump; mouse motion itself still moves the aim at once).
    const wb = w * T.lockBias;
    assist.w = w;
    assist.oy = dampTo(assist.oy, wb > 1e-4 ? wb * wrapAngle(assist.yaw - aimYaw) : 0, 8, rdt);
    assist.op = dampTo(assist.op, wb > 1e-4 ? wb * (assist.pitch - aimPitch) : 0, 8, rdt);
    if (!t && Math.abs(assist.oy) + Math.abs(assist.op) < 1e-5) assist.oy = assist.op = 0;
  }

  // ---- shake / kick ---------------------------------------------------------------------------------------------
  function shake(amount = 0.3, duration = 0, opts = {}) {
    if (!(amount > 0)) return null;
    // No kind given: a long shake (≥ 1 s) is a rumble (titan rising, roar) → slow and heavy; short ones are hits.
    const kind = typeof opts === 'string' ? opts : opts.kind || (duration >= 1 ? 'titan' : 'hit');
    const base = SHAKE_KINDS[kind] || SHAKE_KINDS.hit;
    const freq = opts.freq ?? base.freq, rot = opts.rot ?? base.rot, trans = opts.trans ?? base.trans;
    let e = shakes.find((s) => s.kind === kind && s.freq === freq && !s.handle);
    if (e) { e.trauma = Math.min(1, e.trauma + amount); e.hold = Math.max(e.hold, duration); }
    else {
      if (shakes.length >= 8) shakes.shift();
      e = { kind, trauma: Math.min(1, amount), hold: duration, freq, rot, trans, decay: opts.decay ?? 1.2, seed: Math.random() * 100 };
      shakes.push(e);
    }
    return e;
  }

  function kick(dir, amount = 0.5) {
    if (!dir || !(amount > 0)) return;
    _a.copy(dir); if (_a.lengthSq() < 1e-8) return; _a.normalize();
    kickV.addScaledVector(_a, amount * 4.0);
    _r.set(1, 0, 0).applyQuaternion(cam.quaternion); _u.set(0, 1, 0).applyQuaternion(cam.quaternion);
    // (hover TPS: the aim ray turns with the camera, so a hit's rotational flinch is kept small — ≤ ~3° instead of ~7°)
    const rk = 1 - 0.6 * clamp(hoverW, 0, 1);
    kickYawV -= _a.dot(_r) * amount * 0.35 * rk;
    kickPitchV += _a.dot(_u) * amount * 0.25 * rk;
    shake(0.12 * amount, 0, 'hit');
  }

  // ---- cinematic / focus ------------------------------------------------------------------------------------------
  function playCinematic(nameOrSpec, opts = {}) {
    const spec = typeof nameOrSpec === 'string' ? CINEMATICS[nameOrSpec] : nameOrSpec;
    if (!spec?.keys?.length) {
      console.warn('[cameraRig] unknown cinematic', nameOrSpec);
      return { done: Promise.resolve(false), stop() {} };
    }
    if (cine) finishCinematic(false);
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    const keys = spec.keys.map((k) => ({ ...k }));
    cine = {
      name: typeof nameOrSpec === 'string' ? nameOrSpec : spec.name || 'custom', spec: { ...spec, ...opts }, keys, t: 0,
      pts: keys.map(() => new THREE.Vector3()), looks: keys.map(() => new THREE.Vector3()), resolve,
    };
    beginBlend(cine.spec.blendIn ?? 0.5);
    game.events.emit('cinematic', { name: cine.name, on: true });
    const handle = { done, stop: () => { if (cine && cine.resolve === resolve) finishCinematic(false); } };
    return handle;
  }
  function finishCinematic(completed) {
    const c = cine; if (!c) return;
    cine = null;
    beginBlend(c.spec.blendOut ?? 1.0);
    game.events.emit('cinematic', { name: c.name, on: false, completed });
    c.resolve(completed);
  }

  function focus(target, opts = {}) {
    if (!target) return null;
    const f = { target, t: 0, dur: opts.duration ?? 2.5, weight: opts.weight ?? 0.85, maxAngle: opts.maxAngle ?? 35 * DEG };
    focusList.push(f);
    if (focusList.length > 4) focusList.shift();
    return { stop: () => { f.dur = Math.min(f.dur, f.t + 0.01); } };
  }

  function anchor(at, out) {
    if (at?.isVector3) return out.copy(at);
    if (typeof at === 'function') { const v = at(game); return v ? out.copy(v) : out.copy(dragonPos); }
    if (at?.isObject3D) return at.getWorldPosition(out);
    if (at && at.pos?.isVector3) return out.copy(at.pos);
    const t = titanActor() || game.titan?.actor;
    if (at === 'titan' || at === 'titan:core') return t ? actorPoint(t, 'core', out) : out.copy(dragonPos).addScaledVector(dragonFwd, 400);
    if (at === 'titan:head') return t ? actorPoint(t, 'head', out) : out.copy(dragonPos).addScaledVector(dragonFwd, 400).add(_b.set(0, 40, 0));
    if (at === 'both') {
      if (t) { actorPoint(t, 'head', out); return out.lerp(dragonPos, 0.5); }
      return out.copy(dragonPos).addScaledVector(dragonFwd, 30);
    }
    return out.copy(dragonPos);
  }

  function cineFrame(spec) {
    // forward _f (horizontal), right _r
    const t = spec.frame !== 'heading' ? (titanActor() || null) : null;
    if (t && t.pos) _f.subVectors(dragonPos, t.pos); else _f.copy(dragonVel.lengthSq() > 4 ? dragonVel : dragonFwd);
    _f.y = 0;
    if (_f.lengthSq() < 1e-6) _f.set(0, 0, 1);
    _f.normalize();
    _r.crossVectors(_f, UP).normalize();
  }

  function resolveKey(k, part, out) {
    const spec = k[part];
    if (!spec) return part === 'look' ? out.copy(dragonPos) : out.copy(cam.position);
    if (spec.isVector3) return out.copy(spec);
    anchor(spec.at, out);
    const o = spec.offset;
    if (o) out.addScaledVector(_r, o[0]).addScaledVector(UP, o[1]).addScaledVector(_f, o[2]);
    return out;
  }

  // ---- poses ----------------------------------------------------------------------------------------------------
  function poseChase(p, rdt, simDt, sk = 1) {
    const v = speedOf(p);
    const s = smoothstep(36, 72, v);
    const hover = 1 - smoothstep(10, 20, v);
    const boost = p.controls?.boost ? 1 : 0;

    // Surge: the pivot lags a little on acceleration (boost pulls the dragon ahead, a flare brings it closer).
    // (Staggered: a swat's knock is not an acceleration the pivot should lag behind — sk < 1 absorbs it.)
    if (simDt > 0) {
      if (hasPrevVel) {
        _a.subVectors(dragonVel, prevVel).divideScalar(simDt).clampLength(0, 40).multiplyScalar(sk);
        accel.lerp(_a, damp(8, simDt));
      }
      prevVel.copy(dragonVel); hasPrevVel = true;
      const w = 4, z = 0.9;
      _a.copy(surge).multiplyScalar(-w * w).addScaledVector(surgeV, -2 * z * w).addScaledVector(accel, -0.9);
      surgeV.addScaledVector(_a, rdt);
      surge.addScaledVector(surgeV, rdt).clampLength(0, 2.5);
      // Yaw rate from the velocity heading (drives the look-ahead).
      const h = dragonVel.lengthSq() > 4 ? yawOf(dragonVel) : yawOf(dragonFwd);
      if (prevHeading !== null) yawRate = dampTo(yawRate, clamp(wrapAngle(h - prevHeading) / simDt, -3, 3), 6, simDt);
      prevHeading = h;
    }
    P.copy(dragonPos).add(surge);
    // (flight moves: in the aerobatic frame the pivot sits over the dragon's back along the frame's up, not world up)
    if (aero.w > 1e-4) P.addScaledVector(_k1.copy(UP).lerp(aero.U, ease(clamp(aero.w, 0, 1))).normalize(), T.pivotUp);
    else P.y += T.pivotUp;

    zoomS = dampTo(zoomS, zoom, 10, rdt);
    let elev = zoomS < T.zoomDefault
      ? lerp(T.elevClose, T.elev, smoothstep(T.zoomMin, T.zoomDefault, zoomS))
      : lerp(T.elev, T.elevFar, smoothstep(T.zoomDefault, T.zoomMax, zoomS));
    const tit = titanActor();
    let bossTarget = 0;
    if (tit && tit.pos) bossTarget = 1 - smoothstep(180, 700, tit.pos.distanceTo(dragonPos));
    bossK = dampTo(bossK, bossTarget, 1.5, rdt);
    // Flight moves: skimming a surface slings the camera low (lower arm, flatter view, a touch closer); a wingover / loop
    // lengthens the arm a little so the whole wing sweep fits.
    // (over land the low arm went through the bank's tree canopies — the camera has no canopy query: the full low-slung
    //  view is kept for open surfaces under the whole arm (water, a cloud top far above the ground), skimLand of it over land)
    if (skimK > 0.01) skimOpen = dampTo(skimOpen, openUnderArm(), 3, rdt); else skimOpen = 1;
    const skw = skimK * (1 - freeW) * lerp(T.skimLand, 1, skimOpen), aw = aero.fromMove ? aero.w : 0;
    elev = lerp(elev, elev * (T.skimElev / T.elev), skw);             // (scaled: the close zoom keeps the tail out of the lens)
    const dist = zoomS * (1 + 0.18 * s - 0.1 * hover) * (1 + 0.22 * bossK) * lerp(1, T.skimDist, skw) * lerp(1, T.aeroDist, aw);

    // Bank → roll follow (anime chase: ~55 % of the bank, smoothed), faded out near inverted flight so barrel rolls
    // never flip the camera. No swing to the inside of the turn and no look into it: the arm stays behind the course.
    const bank = bankOf(dragonQuat);
    const upright = 1 - smoothstep(95 * DEG, 150 * DEG, Math.abs(bank));
    const bankC = clamp(bank, -75 * DEG, 75 * DEG) * upright;
    // (staggered: the knock's tumble does not roll the camera — the roll follow is held)
    rollS = dampTo(rollS, clamp(bankC * num(settings.rollFollow, T.rollFollow, 0, 0.8), -T.rollMax, T.rollMax) * (1 - freeW), T.rollLambda * sk, rdt);
    swingS = 0; lookS = 0;

    // Lock-on no longer turns the arm (Wave 4): it swung the camera up to 115–149° off the flight path, the reticle left
    // the screen and the mouse stopped steering "where you look". The lock assists the aim instead (updateAssist) and
    // the HUD's lock arrow points at a target off the screen.

    // Chase frame: forward = the rig direction (course + a little of the aim lead, plus the free-look orbit), rolled by
    // the roll follow. The arm sits `elev` above (in the rolled frame, so the dragon stays centre-low on screen whatever
    // the roll) and `sideYaw` to the right-rear; the view looks `viewBias` below the frame forward.
    const cw = 1 - freeW;
    // Wave 5 (fx owner): while Sora breathes fire the lens rises 2 m (at the default zoom) and the view pitches down 4°:
    // from ~4 m over its axis 40 m of stream projected to ~40–55 px under the reticle; raised, it reads longer.
    const br = breathingOf(p);
    breathK = dampTo(breathK, br ? 1 : 0, br ? T.breathLambda[0] : T.breathLambda[1], rdt);
    const bk = breathK * cw;
    arm.dist = dist; arm.elev = elev; arm.cw = cw;
    arm.raise = bk > 1e-4 ? T.breathRaise * bk * clamp(zoomS / T.zoomDefault, 0.5, 1.6) : 0;
    arm.vb = lerp(T.viewBias, T.skimViewBias, skw) * cw + elev * (1 - cw) + T.breathPitch * bk;   // free-look: look straight at the pivot
    placeChase(occ.yaw, occ.pitch, pose.pos, pose.dir);
    pose.roll = rollS;
    pose.lookAtPivot = freeW > 0.5;

    let fov = lerp(T.fovBase, T.fovFast, s) + T.fovBoost * boost - (T.fovBase - T.fovHover) * hover + 5 * bossK
      + T.skimFov * skw + T.aeroFov * aw;
    fov += num(settings.fovOffset, 0, -10, 10);
    const rate = fov > fovS ? 5 : 1.25;           // attack τ 0.2 s, release τ 0.8 s
    fovS = dampTo(fovS, fov, rate, rdt);
    pose.fov = fovS;
    return dist;
  }

  /** Chase arm (the last poseChase's distance / elevation / breath raise): lens and view for the chase frame turned by an
   *  extra orbit (oy, op) — the titan sight-line offset. The frame (arm AND view) turns, so Sora stays framed. */
  const arm = { dist: 19, elev: T.elev, cw: 1, raise: 0, vb: T.viewBias };
  function placeChase(oy, op, outPos, outDir) {
    const fYaw = rigYaw + freeYaw + oy;
    const fPitch = clamp(rigPitch + freePitch + op, -80 * DEG, 80 * DEG);
    dirFromYP(fYaw, fPitch, _cf);
    frameBasis(_cf, rollS, _cr, _cu);
    const dist = arm.dist, ce = Math.cos(arm.elev), se = Math.sin(arm.elev), sy = Math.sin(T.sideYaw * arm.cw), cy = Math.cos(T.sideYaw * arm.cw);
    outPos.copy(P).addScaledVector(_cf, -dist * ce * cy).addScaledVector(_cu, dist * se + arm.raise).addScaledVector(_cr, dist * ce * sy);
    if (outDir) outDir.copy(_cf).multiplyScalar(Math.cos(arm.vb)).addScaledVector(_cu, -Math.sin(arm.vb)).normalize();
    if (!(aero.w > 1e-4)) { if (outDir) pose.useQuat = false; return outPos; }
    // Flight moves: the aerobatic frame (same arm, same offsets, in its own forward / up), blended by aero.w — the lens
    // around the pivot along an arc (never through the dragon), the orientation by a quaternion slerp.
    const w = ease(clamp(aero.w, 0, 1));
    aeroBasis(freeYaw + oy, clamp(freePitch + op, -80 * DEG, 80 * DEG));
    _k1.copy(P).addScaledVector(_af, -dist * ce * cy).addScaledVector(_au, dist * se + arm.raise).addScaledVector(_ar, dist * ce * sy);
    _k1.sub(P); _k2.subVectors(outPos, P);
    const la = _k2.length(), lb = _k1.length();
    if (la > 1e-3 && lb > 1e-3) {
      _k2.divideScalar(la); _k1.divideScalar(lb);
      _kq.setFromUnitVectors(_k2, _k1); _kq2.identity().slerp(_kq, w);
      outPos.copy(P).add(_k2.applyQuaternion(_kq2).multiplyScalar(lerp(la, lb, w)));
    } else outPos.copy(P).addScaledVector(_k1, w);
    if (outDir) {
      quatFrom(outDir, rollS, _kq3);                                             // the normal chase view (as without moves)
      _k1.copy(_af).multiplyScalar(Math.cos(arm.vb)).addScaledVector(_au, -Math.sin(arm.vb)).normalize();
      _k2.copy(_au).multiplyScalar(Math.cos(arm.vb)).addScaledVector(_af, Math.sin(arm.vb)).normalize();
      quatFromUp(_k1, _k2, _kq);
      poseQ.slerpQuaternions(_kq3, _kq, w);
      outDir.set(0, 0, -1).applyQuaternion(poseQ);
      poseQDir.copy(outDir);
      pose.useQuat = true;
    }
    return outPos;
  }

  function poseRider(p, rdt) {
    const v = speedOf(p);
    const s = smoothstep(36, 72, v);
    seatOf(p, seatPos);
    P.copy(seatPos);
    pose.pos.copy(seatPos);
    // Look between the dragon's nose and the (smoothed) aim so the neck and horns stay in view while turning.
    _b.copy(dragonFwd).lerp(aimS, T.riderLead).normalize();
    const yaw = yawOf(_b) + freeYaw, pitch = clamp(pitchOf(_b) - T.riderBias * (1 - freeW) + freePitch, -80 * DEG, 80 * DEG);
    dirFromYP(yaw, pitch, pose.dir);
    const bank = bankOf(dragonQuat);
    const upright = 1 - smoothstep(95 * DEG, 150 * DEG, Math.abs(bank));
    riderRollS = dampTo(riderRollS, clamp(bank, -70 * DEG, 70 * DEG) * 0.5 * upright * (1 - freeW), 6, rdt);
    pose.roll = riderRollS;
    pose.lookAtPivot = false;
    pose.useQuat = false;
    // Flight moves: over the top of a loop (or any near-vertical flight) the seat view looks along the dragon's nose with
    // an up halfway between the dragon's and the aerobatic frame's eased one — the rider's eyes go round with her, no
    // yaw flip at the vertical, the half roll turns the world at about half its rate (a wingover keeps the normal seat view).
    if (aero.w > 1e-4 && aero.kind !== 'wingover') {
      quatFrom(pose.dir, pose.roll, _kq3);
      _k1.set(0, 1, 0).applyQuaternion(dragonQuat); _k2.set(1, 0, 0).applyQuaternion(dragonQuat);
      _k4.copy(dragonFwd).applyAxisAngle(_k2, T.riderBias);   // look down onto the neck (+X is the model's left)
      _k1.applyAxisAngle(_k2, T.riderBias);
      // the up: half the dragon's, half the aerobatic frame's (its roll eased, ≤ aeroRollRate) — 1:1 the tucked half roll
      // spun the seat view at 465°/s (p99); all eased, the neck lay 60–70° across the view after it (T.riderAeroUp)
      _k3.copy(aero.U).addScaledVector(_k4, -aero.U.dot(_k4));
      if (_k3.lengthSq() > 0.05) _k1.lerp(_k3.normalize(), T.riderAeroUp).addScaledVector(_k4, -_k1.dot(_k4)).normalize();
      quatFromUp(_k4, _k1, _kq);
      poseQ.slerpQuaternions(_kq3, _kq, ease(clamp(aero.w, 0, 1)));
      pose.dir.set(0, 0, -1).applyQuaternion(poseQ);
      poseQDir.copy(pose.dir);
      pose.useQuat = true;
    }
    const fov = lerp(T.fovRider, T.fovRiderFast, s) + num(settings.fovOffset, 0, -10, 10);
    fovS = dampTo(fovS, fov, fov > fovS ? 5 : 1.25, rdt);
    pose.fov = fovS;
  }

  function posePhoto(rdt, p) {
    P.copy(dragonPos); P.y += T.pivotUp * 0.6;
    dirFromYP(photo.yaw, photo.pitch, pose.dir);
    // Keep out of the frozen dragon: the lens slides out along the orbit ray to the first clear spot (Wave 4).
    let d = photo.dist;
    try { if (p) d = photoExit(p, pose.dir, photo.dist); } catch (e) { if (failed++ < 3) console.warn('[cameraRig] photo hull', e); }
    hullPush = d - photo.dist;
    pose.pos.copy(P).addScaledVector(pose.dir, -d);
    pose.roll = photo.roll;
    pose.fov = photo.fov;
    pose.lookAtPivot = true;
  }

  function poseOrbit(rdt, results) {
    orbitT += rdt;
    // The auto-orbit pauses while the player drags and carries on from wherever the drag left it.
    orbitYaw += rdt * (results ? 0.06 : 0.085) * (1 - menu.w);
    P.copy(dragonPos); P.y += 1.0;
    const yaw = rigYaw + Math.PI * 0.72 + orbitYaw;
    const autoPitch = -(results ? 10 : 7) * DEG - 5 * DEG * Math.sin(orbitT * 0.11);
    const pitch = clamp(autoPitch + menu.pitch, T.menuPitchMin, T.menuPitchMax);
    dirFromYP(yaw, pitch, _a);
    pose.roll = (results ? 0 : 3 * DEG) * Math.sin(orbitT * 0.09) * (1 - menu.w);
    pose.fov = results ? 50 : 46;
    fovS = pose.fov;
    pose.lookAtPivot = false;
    if (results) {
      // Results: the text block fills the middle and the screen darkens towards the bottom, so Sora flies (or falls)
      // in the band above the text, right of centre — never behind the title (a falling, wing-flailing Sora at 30 m
      // reached 250 px down, over "SURVIVAL / Wave N").
      try { if (resultsFrame(rdt, results)) return; } catch (e) { if (failed++ < 3) console.warn('[cameraRig] results framing', e); }
    }
    const dist = ((results ? 30 : 25) + 4 * Math.sin(orbitT * 0.07)) * menu.zoom;
    pose.pos.copy(P).addScaledVector(_a, -dist);
    // Title: the dragon sits right of centre and a little low, leaving room for the menu.
    dirFromYP(yaw + (results ? 0 : 9 * DEG), clamp(pitch + (results ? -T.resultsLift : 3 * DEG), -85 * DEG, 85 * DEG), pose.dir);
  }

  /** The results orbit's framing: Sora's hit shapes are measured across the orbit's view (her box, m, around the pivot:
   *  a falling Sora is much taller than a gliding one); the orbit distance fits that box into the band between
   *  resultsBand[0] (NDC y) and the text block's top + resultsBand[1] (the results screen's layout when there is one,
   *  else resultsTextTop), and the view puts the box's centre there, resultsX across (inside the screen). Distance and
   *  placement are smoothed (a box that grows is followed faster than one that shrinks). Writes pose.pos / pose.dir. */
  function resultsFrame(rdt) {
    const tanV = Math.tan(pose.fov * DEG / 2), tanH = tanV * (cam.aspect > 0 ? cam.aspect : 16 / 10);
    frameBasis(_a, 0, _rr, _ru);
    // Sora's box in the plane across the view (right / up of the pivot), and how far toward the lens she reaches
    let x0 = -T.resultsBox[0], x1 = T.resultsBox[0], y0 = -T.resultsBox[1], y1 = T.resultsBox[1], zn = 0;
    const sh = player()?.actor?.shapes;
    if (Array.isArray(sh) && sh.length) {
      let n = 0;
      for (const sp of sh) {
        if (!sp?.a?.isVector3) continue;
        const k = sp.b?.isVector3 ? 3 : 1, r = (Number.isFinite(sp.r) ? sp.r : 0.5) * T.resultsGrow;
        for (let i = 0; i < k; i++) {
          _rp.copy(sp.a); if (k > 1) _rp.lerp(sp.b, i / (k - 1));
          _rp.sub(P);
          const x = _rp.dot(_rr), y = _rp.dot(_ru), z = -_rp.dot(_a);
          if (!Number.isFinite(x + y + z) || Math.abs(x) + Math.abs(y) > 60) continue;
          if (n++ === 0) { x0 = x - r; x1 = x + r; y0 = y - r; y1 = y + r; }
          else { x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r); y0 = Math.min(y0, y - r); y1 = Math.max(y1, y + r); }
          zn = Math.max(zn, z + r);
        }
      }
    }
    // the band (tangent units): from resultsBand[0] down to just above the text
    const top = T.resultsBand[0], bot = Math.min(top - 0.12, resultsTextTop() + T.resultsBand[1]);
    const bandH = (top - bot) * tanV, bandW = 2 * T.resultsBand[0] * tanH;
    // the distance that fits the box (its nearest part is nearer the lens), within resultsDist
    let D = Math.max(zn + (y1 - y0) / bandH, zn + (x1 - x0) / bandW);
    D = clamp(D, T.resultsDist[0], T.resultsDist[1]);
    if (!(res.dist > 0)) res.dist = D;
    res.dist = dampTo(res.dist, D, D > res.dist ? T.resultsLambda[0] : T.resultsLambda[1], rdt);
    const dist = res.dist * (1 + 0.1 * (0.5 + 0.5 * Math.sin(orbitT * 0.07))) * menu.zoom;
    // where the pivot must sit (tangent units) so the box's centre is at resultsX across, the band's middle up
    const De = Math.max(1, dist - zn), halfW = (x1 - x0) / 2 / De;
    const cx = (x0 + x1) / 2 / dist, cy = (y0 + y1) / 2 / dist;
    const txT = Math.min(T.resultsX * tanH, T.resultsBand[0] * tanH - halfW);
    const tyT = (top + bot) / 2 * tanV;
    const tx = txT - cx, ty = tyT - cy;
    if (!res.set) { res.tx = tx; res.ty = ty; res.set = true; }
    res.tx = dampTo(res.tx, tx, T.resultsLambda[1] * 2, rdt);
    res.ty = dampTo(res.ty, ty, ty < res.ty ? T.resultsLambda[0] : T.resultsLambda[1] * 2, rdt);
    pose.pos.copy(P).addScaledVector(_a, -dist);
    // the view (no roll) that puts the lens → pivot direction _a at (tx, ty): camera-space ray r = (tx, ty, −1)
    const nr = Math.hypot(res.tx, res.ty, 1), rx = res.tx / nr, ry = res.ty / nr, rf = 1 / nr;
    const th = Math.asin(clamp(_a.y / Math.hypot(ry, rf), -1, 1)) - Math.atan2(ry, rf);
    const fh = rf * Math.cos(th) - ry * Math.sin(th);
    dirFromYP(yawOf(_a) + Math.atan2(rx, fh), clamp(th, -85 * DEG, 85 * DEG), pose.dir);
    res.box = [x0, x1, y0, y1]; res.D = D; res.top = top; res.bot = bot;
    return Number.isFinite(pose.dir.x + pose.dir.y + pose.dir.z + pose.pos.x + pose.pos.y + pose.pos.z);
  }
  /** NDC y of the results text block's top edge: its first visible line in the results screen's layout (4 Hz), else
   *  resultsTextTop (the 1440×900 layout). */
  function resultsTextTop() {
    const t = nowReal();
    if (res.textAt >= 0 && t - res.textAt < 0.25 && t >= res.textAt) return res.text;
    res.textAt = t;
    let y = T.resultsTextTop;
    try {
      const wrap = typeof document !== 'undefined' ? document.querySelector?.('.results.on .r-wrap') : null;
      const cv = game.canvas?.getBoundingClientRect?.();
      if (wrap && cv && cv.height > 0) {
        let tp = Infinity;
        for (const c of wrap.children) { const r = c.getBoundingClientRect(); if (r.width > 0 && r.height > 0) tp = Math.min(tp, r.top); }
        if (Number.isFinite(tp)) y = clamp(1 - 2 * (tp - cv.top) / cv.height, -0.6, 0.8);
      }
    } catch { /* no layout: the default */ }
    res.text = y;
    return y;
  }

  function poseCinematic(rdt) {
    const c = cine;
    c.t += rdt;
    const keys = c.keys, n = keys.length;
    const dur = c.spec.duration ?? keys[n - 1].t;
    const u = clamp(c.t / Math.max(dur, 1e-3), 0, 1);
    const te = (c.spec.ease === 'linear' ? u : easeInOut(u)) * dur;
    cineFrame(c.spec);
    for (let i = 0; i < n; i++) { resolveKey(keys[i], 'pos', c.pts[i]); resolveKey(keys[i], 'look', c.looks[i]); }
    let i = 0;
    while (i < n - 2 && te > keys[i + 1].t) i++;
    const i0 = Math.max(i - 1, 0), i2 = Math.min(i + 1, n - 1), i3 = Math.min(i + 2, n - 1);
    const seg = n > 1 ? clamp((te - keys[i].t) / Math.max(1e-4, keys[i2].t - keys[i].t), 0, 1) : 0;
    catmull(c.pts[i0], c.pts[i], c.pts[i2], c.pts[i3], seg, pose.pos);
    catmull(c.looks[i0], c.looks[i], c.looks[i2], c.looks[i3], seg, _a);
    cineLook.copy(_a);
    pose.dir.subVectors(_a, pose.pos);
    if (pose.dir.lengthSq() < 1e-6) pose.dir.copy(dragonFwd); else pose.dir.normalize();
    const e = ease(seg);
    pose.fov = lerp(keys[i].fov ?? 50, keys[i2].fov ?? 50, e);
    pose.roll = lerp(keys[i].roll ?? 0, keys[i2].roll ?? 0, e);
    pose.lookAtPivot = false;
    fovS = pose.fov;
    P.copy(dragonPos);
    if (c.t >= dur) finishCinematic(true);
    else if (c.t >= (c.cutAt ?? Infinity)) finishCinematic(false);
  }

  // ---- framing bias (lock, titan, focus) -------------------------------------------------------------------------
  function applyBias(rdt, strength, keepDragon = false, keepAim = false) {
    // (flight moves: a near-vertical view has no yaw — the yaw / pitch bias and its keep-in-frame window would be noise
    //  there (measured: a 10° one-frame jump over the top of a loop). The bias eases out unapplied; in the aerobatic frame
    //  its targets fade with the frame's weight.)
    if (Math.abs(pose.dir.y) > 0.9) {
      biasYaw = dampTo(biasYaw, 0, 3, rdt); biasPitch = dampTo(biasPitch, 0, 3, rdt);
      for (let i = focusList.length - 1; i >= 0; i--) { const f = focusList[i]; f.t += rdt; if (f.t >= f.dur + 0.6) focusList.splice(i, 1); }
      return;
    }
    if (aero.w > 1e-4) strength *= 1 - ease(clamp(aero.w, 0, 1));
    const baseYaw = yawOf(pose.dir), basePitch = pitchOf(pose.dir);
    const halfV = (pose.fov * DEG) / 2;
    const half = Math.min(halfV, Math.atan(Math.tan(halfV) * (cam.aspect || 1.6)));
    let wy = 0, wp = 0;
    const want = (pt, comfort, maxAngle, weight, reachOnly = false) => {
      _a.subVectors(pt, pose.pos);
      const len = _a.length(); if (len < 1) return;
      _a.divideScalar(len);
      const ang = Math.acos(clamp(_a.dot(pose.dir), -1, 1));
      if (ang <= comfort) return;
      // reachOnly: a target the bias cannot bring into frame (e.g. behind you) is left to the HUD's off-screen arrow
      // instead of dragging the view uselessly off the dragon.
      if (reachOnly) weight *= 1 - smoothstep(maxAngle, maxAngle * 2, ang - comfort);
      if (weight <= 0) return;
      const k = (Math.min(ang - comfort, maxAngle) / ang) * weight;
      wy += wrapAngle(yawOf(_a) - baseYaw) * k;
      wp += (pitchOf(_a) - basePitch) * k;
    };
    if (strength > 0) {
      // Lock-on: only a gentle nudge for a target just outside the frame (reach only); a target farther off is the HUD
      // lock arrow's job — the camera stays behind the dragon (Wave 4).
      if (lockTarget && lockTarget.alive !== false && lockTarget.pos) want(lockPoint(lockTarget, _h1), 0.7 * half, T.lockView, strength, true);
      const tit = titanActor();
      if (tit) {
        const tele = nowReal() < telegraphUntil;
        actorPoint(tit, 'core', _d);
        want(_d, (tele ? 0.6 : 0.8) * half, (tele ? 30 : 25) * DEG, strength, true);
      }
    }
    for (let i = focusList.length - 1; i >= 0; i--) {
      const f = focusList[i];
      f.t += rdt;
      if (f.t >= f.dur + 0.6) { focusList.splice(i, 1); continue; }
      const env = smoothstep(0, 0.4, f.t) * (1 - smoothstep(f.dur, f.dur + 0.6, f.t));
      anchor(f.target, _d);
      want(_d, 0, f.maxAngle, f.weight * env);
    }
    const lim = 32 * DEG;
    wy = clamp(wy, -lim, lim); wp = clamp(wp, -lim, lim);
    if (keepDragon) {
      // Never bias the dragon out of the frame (lock-on or boss framing far off the aim): the pivot may sit at most
      // (half-FOV − the dragon's own angular radius) off the biased view, so the whole body stays on screen.
      _a.subVectors(P, pose.pos);
      const dl = _a.length();
      if (dl > 1) {
        const hH = Math.atan(Math.tan(halfV) * (cam.aspect || 1.6));
        const angR = Math.atan(7 / dl);
        const Ly = Math.max(0.35 * hH, hH - angR - 3 * DEG), Lp = Math.max(0.3 * halfV, 0.8 * halfV - 0.5 * angR);
        const dy0 = wrapAngle(yawOf(_a) - baseYaw), dp0 = pitchOf(_a) - basePitch;
        let yLo = dy0 - Ly, yHi = dy0 + Ly, pLo = dp0 - Lp, pHi = dp0 + Lp;
        if (keepAim) {
          // ...and never bias the reticle (the aim point) out of the frame either (Wave 4): the intersection of both
          // windows, when there is one (the dragon wins otherwise).
          _a.subVectors(aimPoint, pose.pos);
          if (_a.lengthSq() > 1) {
            const ay = wrapAngle(yawOf(_a) - baseYaw), ap = pitchOf(_a) - basePitch;
            const aLo = ay - 0.8 * hH, aHi = ay + 0.8 * hH, bLo = ap - 0.8 * halfV, bHi = ap + 0.8 * halfV;
            if (Math.max(yLo, aLo) <= Math.min(yHi, aHi)) { yLo = Math.max(yLo, aLo); yHi = Math.min(yHi, aHi); }
            if (Math.max(pLo, bLo) <= Math.min(pHi, bHi)) { pLo = Math.max(pLo, bLo); pHi = Math.min(pHi, bHi); }
          }
        }
        wy = clamp(wy, yLo, yHi);
        wp = clamp(wp, pLo, pHi);
        wy = clamp(wy, -lim, lim); wp = clamp(wp, -lim, lim);
      }
    }
    // (hover: the view IS the aim — no framing bias at all, focus and keep-in-frame windows included; the TPS framing
    //  keeps the dragon at a fixed place on screen by itself)
    const fade = 1 - hoverFade;
    biasYaw = dampTo(biasYaw, wy * fade, 2.5, rdt);
    biasPitch = dampTo(biasPitch, wp * fade, 2.5, rdt);
    if (fade < 1) { biasYaw *= fade; biasPitch *= fade; }
    if (Math.abs(biasYaw) + Math.abs(biasPitch) > 1e-5) {
      dirFromYP(baseYaw + biasYaw, clamp(basePitch + biasPitch, -85 * DEG, 85 * DEG), pose.dir);
    }
  }

  // ---- titan sight line (Wave 5) -----------------------------------------------------------------------------------
  // Each titan shape's motion per real second (for the look-ahead): a swinging arm is avoided before it arrives.
  const shapeTrack = new WeakMap();
  const _s1 = new THREE.Vector3(), _s2 = new THREE.Vector3(), _s3 = new THREE.Vector3(), _s4 = new THREE.Vector3(), _s5 = new THREE.Vector3();
  const handDir = new THREE.Vector3();
  let trackFrame = -1;
  function trackShapes(rdt) {
    const fr = game.time.frame;
    if (trackFrame === fr) return;
    trackFrame = fr;
    for (const a of bigShapes) for (const s of a.shapes) {
      if (!s?.a) continue;
      const b = s.b || s.a;
      let r = shapeTrack.get(s);
      if (!r) { shapeTrack.set(s, { a: s.a.clone(), b: b.clone(), va: new THREE.Vector3(), vb: new THREE.Vector3(), f: fr }); continue; }
      if (rdt > 1e-4 && fr - r.f <= 2) {
        r.va.lerp(_s1.subVectors(s.a, r.a).divideScalar(rdt).clampLength(0, 160), 0.6);
        r.vb.lerp(_s1.subVectors(b, r.b).divideScalar(rdt).clampLength(0, 160), 0.6);
      } else { r.va.set(0, 0, 0); r.vb.set(0, 0, 0); }
      r.a.copy(s.a); r.b.copy(b); r.f = fr;
    }
  }
  /** Distance from p to segment a–b (no allocation). */
  function ptSeg(p, a, b) {
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z, L2 = ux * ux + uy * uy + uz * uz;
    let t = L2 > 1e-9 ? ((p.x - a.x) * ux + (p.y - a.y) * uy + (p.z - a.z) * uz) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = p.x - a.x - ux * t, dy = p.y - a.y - uy * t, dz = p.z - a.z - uz * t;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  /** Squared distance between segments p1–q1 and p2–q2 (Ericson 5.1.9, no allocation). */
  function segSeg2(p1, q1, p2, q2) {
    const d1x = q1.x - p1.x, d1y = q1.y - p1.y, d1z = q1.z - p1.z, d2x = q2.x - p2.x, d2y = q2.y - p2.y, d2z = q2.z - p2.z;
    const rx = p1.x - p2.x, ry = p1.y - p2.y, rz = p1.z - p2.z;
    const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z, f = d2x * rx + d2y * ry + d2z * rz;
    let s = 0, t = 0;
    if (a <= 1e-9 && e <= 1e-9) { s = t = 0; } else if (a <= 1e-9) { t = clamp(f / e, 0, 1); } else {
      const c = d1x * rx + d1y * ry + d1z * rz;
      if (e <= 1e-9) { s = clamp(-c / a, 0, 1); } else {
        const b = d1x * d2x + d1y * d2y + d1z * d2z, den = a * e - b * b;
        s = den > 1e-12 ? clamp((b * f - c * e) / den, 0, 1) : 0;
        t = (b * s + f) / e;
        if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
      }
    }
    const cx = rx + d1x * s - d2x * t, cy = ry + d1y * s - d2y * t, cz = rz + d1z * s - d2z * t;
    return cx * cx + cy * cy + cz * cz;
  }
  /** A lens spot L is clear of the titan: ≥ shapeMargin from every shape and the sight line L → Sora (D) ≥ sightMargin
   *  from them, now and sightAhead s ahead. A shape Sora is at / inside is not counted for the sight line (no camera can
   *  see through it) but stays solid for the lens. */
  function titanClear(L, D) {
    if (L.y < groundY(L.x, L.z) + T.clearance * 0.8) return false;
    const melee = !!meleeParts && nowReal() < meleeUntil;
    for (const a of bigShapes) {
      if (a.pos && a.radius && a.pos.distanceTo(D) > a.radius + 160) continue;
      for (const s of a.shapes) {
        if (!s?.a || skipShape(s)) continue;
        const tr = shapeTrack.get(s);
        // (during a melee blow the striking hand / forearm is also looked at meleeAhead s ahead: a swing that comes
        //  from the camera's side is avoided before it sweeps through the lens)
        const nk = !tr ? 1 : melee && /^(hand|arm)/.test(s.part || '') ? 3 : 2;
        for (let k = 0; k < nk; k++) {
          const tau = k === 1 ? T.sightAhead : T.meleeAhead;
          const A = k ? _s1.copy(s.a).addScaledVector(tr.va, tau) : s.a;
          const B = k ? _s2.copy(s.b || s.a).addScaledVector(tr.vb, tau) : s.b || s.a;
          if (ptSeg(L, A, B) - s.r < T.shapeMargin) return false;
          if (ptSeg(D, A, B) - s.r < 1) continue;
          if (Math.sqrt(segSeg2(L, D, A, B)) - s.r < T.sightMargin) return false;
        }
      }
    }
    return true;
  }
  /** Direction Sora → the titan's nearest hand within 70 m (handDir) and how near it is (handNear 1 → 0 over
   *  25–70 m), or false. */
  let handNear = 0;
  function nearestHand(D, parts = null, far = 70) {
    let best = far;
    for (const a of bigShapes) for (const s of a.shapes) {
      if (!s?.a || !/^hand/.test(s.part || '') || (parts && !parts.includes(s.part))) continue;
      const d = s.a.distanceTo(D);
      if (d < best && d > 1e-3) { best = d; handDir.subVectors(s.a, D).divideScalar(d); }
    }
    handNear = 1 - smoothstep(25, far, best);
    return best < far;
  }
  // A melee blow is announced ≥ 0.8 s ahead (titan:telegraph { attack, hand, duration }): until it has swung through,
  // the arm drifts off the striking hand's side, so the hand never sweeps through the lens (seen: a swat from the
  // camera's side pushed the lens to 8 m from Sora) and the blow is seen coming from the side, not from behind the lens.
  const MELEE = new Set(['swat', 'grab', 'clap', 'slam']);
  let meleeParts = null, meleeUntil = -1;
  /** Chase: keep the titan out of the sight line (and, after a swat, the lens on the side away from its hand) by
   *  orbiting the chase frame to the cheapest clear direction. Re-places pose.pos / pose.dir with the new offset. */
  function titanSight(rdt, allow = true) {
    occ.blocked = false;
    const on = allow && mode === 'chase' && bigShapes.length > 0;
    let fast = false, drift = false;
    if (on) {
      trackShapes(rdt);
      const D = dragonPos;
      const clearNow = titanClear(placeChase(occ.yaw, occ.pitch, _s3, null), D);
      const swatHand = staggerK > 0.05 && staggerKind === 'swat' && nearestHand(D);
      const teleHand = !swatHand && meleeParts && nowReal() < meleeUntil && nearestHand(D, meleeParts, 100);
      const hand = swatHand || teleHand;
      const handW = swatHand ? staggerK : 1;
      occ.blocked = !clearNow;
      if (!clearNow) { occ.blockedFrames++; occ.holdUntil = nowReal() + T.sightHold; }
      // (after a block the chosen offset is held for sightHold s before it relaxes: easing back through the blocked
      //  directions would otherwise hunt between them)
      if (clearNow && !hand && nowReal() < occ.holdUntil) { /* hold the current target */ }
      else if (!clearNow || hand || occ.yaw !== 0 || occ.pitch !== 0) {
        // candidates: the list + staying where it is; cost = size of the offset + change + (after a swat) facing the hand
        let bestCost = Infinity, by = occ.ty, bp = occ.tp, found = false;
        const n = T.sightCands.length;
        for (let i = -1; i < n; i++) {
          const oy = i < 0 ? occ.yaw : T.sightCands[i][0] * DEG, op = i < 0 ? occ.pitch : T.sightCands[i][1] * DEG;
          if (i >= 0 && clearNow && !hand && Math.hypot(oy, op) > Math.hypot(occ.yaw, occ.pitch) + 1e-6) continue;   // clear: only ever relax
          if (i >= 0 && clearNow && teleHand && (Math.abs(oy) > T.teleMax[0] * DEG || op > T.teleMax[1] * DEG)) continue;   // a telegraph only drifts gently
          const L = i < 0 ? _s3 : placeChase(oy, op, _s4, null);
          if (i >= 0 && !titanClear(L, D)) continue;
          if (i < 0 && !clearNow) continue;
          let cost = Math.hypot(oy, op) + 0.6 * Math.hypot(wrapAngle(oy - occ.yaw), op - occ.pitch);
          if (hand) { _s5.subVectors(L, D).normalize(); cost += handW * handNear * T.handAvoid * Math.max(0, _s5.dot(handDir) + (swatHand ? 0.15 : -0.3)); }
          if (cost < bestCost) { bestCost = cost; by = oy; bp = op; found = true; occ.cand = i; }
        }
        occ.searched++;
        if (found) { occ.ty = by; occ.tp = bp; }
        occ.found = found;
        fast = !clearNow || !!swatHand;
        drift = !fast && !!teleHand;
      } else { occ.ty = 0; occ.tp = 0; }
    } else { occ.ty = 0; occ.tp = 0; }
    const lam = fast ? T.sightRate[0] : drift ? T.sightTele : T.sightRate[1], k = damp(lam, rdt), mx = T.sightMaxRate * rdt;
    const oy0 = occ.yaw, op0 = occ.pitch;
    occ.yaw = wrapAngle(occ.yaw + clamp(wrapAngle(occ.ty - occ.yaw) * k, -mx, mx));
    occ.pitch += clamp((occ.tp - occ.pitch) * k, -mx, mx);
    if (Math.abs(occ.yaw) < 1e-4 && Math.abs(occ.pitch) < 1e-4 && !occ.ty && !occ.tp) occ.yaw = occ.pitch = 0;
    if (mode === 'chase' || mode === 'free') {
      if (occ.yaw !== oy0 || occ.pitch !== op0) placeChase(occ.yaw, occ.pitch, pose.pos, pose.dir);
    }
  }

  // ---- avoidance ------------------------------------------------------------------------------------------------
  /** March the arm pivot → camera; the fraction before the first sample under the ground or inside a big body (a big
   *  body never pulls the lens in below bigMin: the sight-line orbit goes around it instead). */
  function armHit(from, to, clear, bigMin = 0.12) {
    const N = 10;
    // (tree canopies count only while the dragon itself is above them, and never pull the lens in below 40 %)
    const canopyOn = obstacleY(from.x, from.z) < from.y - 1.5;
    for (let i = 1; i <= N; i++) {
      const t = i / N;
      _b.lerpVectors(from, to, t);
      const g0 = groundY(_b.x, _b.z);
      if (_b.y < g0 + 0.5 * t * clear) return Math.max((i - 1) / N, 0.12);
      if (canopyOn && canopyFn && _b.y < obstacleY(_b.x, _b.z) + 0.5) return Math.max((i - 1) / N, 0.4);
      if (bigShapes.length && insideBig(_b, T.shapeMargin * t)) return Math.max((i - 1) / N, bigMin);
    }
    return 1;
  }

  function avoid(p, rdt, allowShorten, selfAvoid, clear = T.clearance, bigMin = 0.12) {
    gatherBig(p);
    if (allowShorten) {
      // The arm shortens instantly in and slowly back out, so nothing ever sits between the lens and the dragon.
      const hit = armHit(P, pose.pos, clear, bigMin);
      armScale = hit < armScale ? hit : dampTo(armScale, hit, 2.0, rdt);
      if (armScale < 0.999) pose.pos.sub(P).multiplyScalar(armScale).add(P);
    } else armScale = 1;
    solidify(pose.pos, p, selfAvoid, clear);
    if (pose.lookAtPivot) {
      _a.subVectors(P, pose.pos);
      if (_a.lengthSq() > 1e-4) pose.dir.copy(_a).normalize();
    }
  }

  /** Push a lens position out of big bodies (and the player's own hull when selfAvoid) and keep it above the ground.
   *  (Photo mode keeps out of the dragon by itself, photoExit, and passes selfAvoid = false.) */
  function solidify(pos, p, selfAvoid, clear) {
    if (bigShapes.length) pushOut(pos, bigShapes, T.shapeMargin);
    if (selfAvoid) {
      hullPush = 0;
      if (p?.actor?.shapes?.length) {
        pushOutHull(pos, p.actor.shapes);
        try { wingClear(pos, p); } catch (e) { if (failed++ < 3) console.warn('[cameraRig] wing clearance', e); }
        // Wave 5: Sora's own hull push must not shove the lens back into the titan (the stone wins: measured up to 4 m
        // inside a forearm after a swat that left Sora against it).
        if (bigShapes.length) pushOut(pos, bigShapes, T.shapeMargin);
      }
    }
    const g = groundY(pos.x, pos.z) + clear;
    if (pos.y < g) pos.y = g;
  }

  // ---- wing clearance (Wave 5): the skinned wing membranes near the lens -----------------------------------------------
  const wingSet = { root: null, model: null, meshes: [], t: -1e9, n: 0 };
  let wingExt = 0, wingNeed = 0, wingTested = 0, wingRdt = 0, wingFrame = -1;
  /** Sora's wing vertices (every wingStride-th vertex whose strongest skin bone is a wing bone), cached per model. */
  function wingMeshes(p) {
    const root = p.root, model = p.model?.scene || p.model || null;
    if (wingSet.root === root && wingSet.model === model && (wingSet.meshes.length || nowReal() - wingSet.t < 2)) return wingSet.meshes;
    wingSet.root = root; wingSet.model = model; wingSet.t = nowReal(); wingSet.meshes = []; wingSet.n = 0;
    root?.traverse?.((o) => {
      if (!o.isSkinnedMesh || !o.skeleton || o.userData?.isOutline || /outline|rider|kaede/i.test(o.name || '')) return;
      const geo = o.geometry, sk = geo?.attributes?.skinIndex, sw = geo?.attributes?.skinWeight, pa = geo?.attributes?.position;
      if (!sk || !sw || !pa) return;
      // per side (bone suffix _L / _R; unknown: both), so only the wing near the lens is skinned
      const bones = o.skeleton.bones, side = bones.map((b) => { const n = b?.name || ''; return !/wing/i.test(n) ? 0 : /(_|\.)L$/.test(n) ? 1 : /(_|\.)R$/.test(n) ? 2 : 3; });
      const L = [], R = [];
      for (let i = 0; i < pa.count; i += T.wingStride) {
        let best = 0, bw = -1;
        for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; best = sk.getComponent(i, k); } }
        const sd = side[best];
        if (sd & 1) L.push(i);
        if (sd & 2) R.push(i);
      }
      if (L.length + R.length) { wingSet.meshes.push({ o, idxL: Int32Array.from(L), idxR: Int32Array.from(R) }); wingSet.n += L.length + R.length; }
    });
    return wingSet.meshes;
  }

  /** Keep the lens wingMargin away from Sora's wing membranes: slide it out along the arm ray (pivot P → lens). Only runs
   *  when the lens is near a wing capsule (the default chase never pays for it). */
  function wingClear(pos, p) {
    const fr = game.time.frame;
    if (fr !== wingFrame) {
      if (fr - wingFrame > 3) wingExt = 0;             // (not used for a while, e.g. back from the rider view: no stale push)
      wingFrame = fr; wingRdt = clamp(game.time.real - (wingSet.lastReal ?? game.time.real), 0, 0.1); wingSet.lastReal = game.time.real; wingNeed = 0;
    }
    let nearL = 1e9, nearR = 1e9;
    for (const s of p.actor.shapes) {
      if (s?.a && s.part === 'wingL') nearL = Math.min(nearL, shapeDist(s, pos, _h3));
      else if (s?.a && s.part === 'wingR') nearR = Math.min(nearR, shapeDist(s, pos, _h3));
    }
    const gate = T.wingReach + T.wingMargin + T.wingSlack;
    let need = 0;
    const d = pos.distanceTo(P);
    if ((nearL < gate || nearR < gate) && d > 0.5) {
      const meshes = wingMeshes(p);
      if (meshes.length) {
        // bone matrices are those of the last render until the renderer updates them: bring them up to date first
        try { p.root.updateMatrixWorld(true); } catch { /* keep the render's */ }
        _h5.subVectors(pos, P).divideScalar(d);           // the arm ray
        const m2 = T.wingMargin * T.wingMargin;
        let ext = 0;
        wingTested = 0;
        // the points' along-ray / off-ray split, then the smallest extension outside every point's forbidden interval
        const iv = wingIv; iv.length = 0;
        for (const m of meshes) {
          const o = m.o;
          o.updateMatrixWorld?.();
          for (let sd = 0; sd < 2; sd++) {
          const idx = sd ? m.idxR : m.idxL;
          if ((sd ? nearR : nearL) >= gate) continue;
          for (let k = 0; k < idx.length; k++) {
            o.getVertexPosition(idx[k], _cv3).applyMatrix4(o.matrixWorld);
            const rx = _cv3.x - P.x, ry = _cv3.y - P.y, rz = _cv3.z - P.z;
            const s = rx * _h5.x + ry * _h5.y + rz * _h5.z;
            const h2 = rx * rx + ry * ry + rz * rz - s * s;
            wingTested++;
            if (h2 >= m2 || !Number.isFinite(s)) continue;
            const w = Math.sqrt(m2 - h2);
            if (s + w > d) iv.push(s - w, s + w);
          }
          }
        }
        for (let it = 0; it < 6; it++) {
          let moved = false;
          const at = d + ext;
          for (let k = 0; k < iv.length; k += 2) if (at > iv[k] && at < iv[k + 1]) { ext = iv[k + 1] - d + 0.02; moved = true; }
          if (!moved || ext > 14) break;
        }
        need = Math.min(ext, 14);
      }
    }
    wingNeed = Math.max(wingNeed, need);
    // (out at once; back slowly — the next wingbeat brings the membrane back before the lens has crept in)
    wingExt = need >= wingExt ? need : dampTo(wingExt, need, T.wingRelease, wingRdt);
    if (wingExt > 1e-3 && d > 0.5) pos.sub(P).multiplyScalar((d + wingExt) / d).add(P);
  }
  const wingIv = [];

  // ---- photo hull: the frozen dragon's own mesh as a point cloud ----------------------------------------------------
  const cloud = { owner: null, session: -1, n: 0, pts: new Float32Array(0), cells: new Map(), cx: 0, cy: 0, cz: 0, builds: 0 };
  const photoMemo = { yaw: NaN, pitch: NaN, dist: NaN, d: 0, session: -1 };
  let photoSession = 0;
  const _cv3 = new THREE.Vector3();
  const cellKey = (ix, iy, iz) => (ix + 64) + 128 * ((iy + 64) + 128 * (iz + 64));

  function buildCloud(p) {
    cloud.owner = p; cloud.session = photoSession; cloud.n = 0; cloud.cells.clear();
    const root = p.root;
    if (!root?.traverseVisible) return;
    cloud.cx = dragonPos.x; cloud.cy = dragonPos.y; cloud.cz = dragonPos.z;
    // The first photo frame is the frame P was pressed: the dragon moved in its fixed steps, but the bone / mesh world
    // matrices are still those of the last render (≈ 35 m/s × one frame = 0.7–1.7 m behind). Bring them up to date
    // first, or the whole hull sits one frame back along the course (measured: lens 0.54 m from the wing in a flank view).
    try { root.updateMatrixWorld(true); } catch { /* keep the render's matrices */ }
    const meshes = [];
    let total = 0;
    root.traverseVisible((o) => {
      if (!o.isMesh || o.isInstancedMesh || o.userData?.isOutline || !o.getVertexPosition) return;
      const pa = o.geometry?.attributes?.position;
      if (!pa || pa.count < 3) return;
      meshes.push(o); total += Math.ceil(pa.count / 2);
    });
    if (cloud.pts.length < total * 3) cloud.pts = new Float32Array(total * 3);
    const c = T.photoCell, pts = cloud.pts;
    for (const o of meshes) {
      const cnt = o.geometry.attributes.position.count;
      for (let i = 0; i < cnt; i += 2) {
        o.getVertexPosition(i, _cv3).applyMatrix4(o.matrixWorld);
        if (!Number.isFinite(_cv3.x + _cv3.y + _cv3.z)) continue;
        const ix = Math.floor((_cv3.x - cloud.cx) / c), iy = Math.floor((_cv3.y - cloud.cy) / c), iz = Math.floor((_cv3.z - cloud.cz) / c);
        if (Math.abs(ix) > 60 || Math.abs(iy) > 60 || Math.abs(iz) > 60) continue;
        const k = cellKey(ix, iy, iz);
        let arr = cloud.cells.get(k);
        if (!arr) cloud.cells.set(k, (arr = []));
        const j = cloud.n++;
        pts[j * 3] = _cv3.x; pts[j * 3 + 1] = _cv3.y; pts[j * 3 + 2] = _cv3.z;
        arr.push(j);
      }
    }
  }

  /** True when no vertex of the cloud is within m of pt (m ≤ photoCell). */
  function cloudClear(pt, m) {
    if (!cloud.n) return true;
    const c = T.photoCell, pts = cloud.pts, m2 = m * m;
    const ix = Math.floor((pt.x - cloud.cx) / c), iy = Math.floor((pt.y - cloud.cy) / c), iz = Math.floor((pt.z - cloud.cz) / c);
    if (Math.abs(ix) > 61 || Math.abs(iy) > 61 || Math.abs(iz) > 61) return true;
    for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const arr = cloud.cells.get(cellKey(ix + dx, iy + dy, iz + dz));
      if (!arr) continue;
      for (let q = 0; q < arr.length; q++) {
        const j = arr[q] * 3, ex = pts[j] - pt.x, ey = pts[j + 1] - pt.y, ez = pts[j + 2] - pt.z;
        if (ex * ex + ey * ey + ez * ez < m2) return false;
      }
    }
    return true;
  }

  /** A photo lens spot is clear: away from every vertex and not deep inside the body (the grown capsules). */
  function photoClear(pt, shapes) {
    if (!cloudClear(pt, T.photoMargin)) return false;
    if (shapes) for (const s of shapes) {
      if (!s?.a || s.part === 'wingL' || s.part === 'wingR') continue;
      if (shapeDist(s, pt, _h3) < (T.hullGrow[s.part] ?? T.hullGrowDefault)) return false;
    }
    return true;
  }

  /** Smallest orbit distance ≥ want along −dir from the pivot P whose lens spot is clear (memoised while the orbit is
   *  unchanged — the pose is frozen in photo mode). */
  function photoExit(p, dir, want) {
    // (Rebuilt when the frozen dragon still moved after the build, e.g. the drawn root's interpolation settling.)
    // (At most 3 builds per photo session: a root that keeps creeping never costs a build every frame.)
    const drift = Math.abs(dragonPos.x - cloud.cx) + Math.abs(dragonPos.y - cloud.cy) + Math.abs(dragonPos.z - cloud.cz);
    const fresh = cloud.owner !== p || cloud.session !== photoSession;
    if (fresh || (drift > 0.05 && cloud.builds < 3)) { cloud.builds = fresh ? 0 : cloud.builds; buildCloud(p); cloud.builds++; photoMemo.session = -1; }
    if (photoMemo.session === photoSession && photoMemo.yaw === photo.yaw && photoMemo.pitch === photo.pitch && photoMemo.dist === want) return photoMemo.d;
    const shapes = p.actor?.shapes?.length ? p.actor.shapes : null;
    const at = (d) => photoClear(_h1.copy(P).addScaledVector(dir, -d), shapes);
    let d = want;
    if (!at(want)) {
      let lo = want, hi = want, ok = false;
      for (let k = 1; k <= 60; k++) { hi = want + k * 0.3; if (at(hi)) { ok = true; break; } lo = hi; }
      if (ok) for (let i = 0; i < 5; i++) { const mid = (lo + hi) / 2; if (at(mid)) hi = mid; else lo = mid; }
      d = hi;
    }
    Object.assign(photoMemo, { yaw: photo.yaw, pitch: photo.pitch, dist: want, d, session: photoSession });
    return d;
  }

  /** Chase / free / title: the body, neck, head and tail capsules grown by how far the mesh reaches past them
   *  (hullGrow) + hullMargin; the flapping wings keep the old selfMargin so the lens never pumps with the wingbeat.
   *  Iterated like pushOut (a push out of one capsule may enter another). */
  function pushOutHull(pt, shapes) {
    _h4.copy(pt);
    for (let it = 0; it < 4; it++) {
      let moved = false;
      for (const s of shapes) {
        if (!s?.a || !(s.r >= 0)) continue;
        const m = s.part === 'wingL' || s.part === 'wingR' ? T.selfMargin : (T.hullGrow[s.part] ?? T.hullGrowDefault) + T.hullMargin;
        if (s.kind === 'capsule' && s.b) closestOnSegment(pt, s.a, s.b, _h3); else _h3.copy(s.a);
        _d.subVectors(pt, _h3);
        const len = _d.length();
        if (len - s.r < m) {
          if (len < 1e-4) _d.set(0, 1, 0); else _d.divideScalar(len);
          pt.copy(_h3).addScaledVector(_d, s.r + m);
          moved = true;
        }
      }
      if (!moved) break;
    }
    hullPush = _h4.distanceTo(pt);
  }

  // ---- input (update) --------------------------------------------------------------------------------------------
  /** The frame's aim / free-look motion in play (mouse, right stick, gamepad direct flying, A / D), applied ONCE per
   *  rendered frame: by the early aim hook on the frame's first fixed step, else by readInput() in update(). */
  function steerMotion(rdt) {
    const input = game.input;
    if (!input) return;
    const f = game.time.frame;
    const pad = input.pad;
    freeHeld = input.down('Mouse2') || input.down('AltLeft') || input.down('AltRight') || (pad?.buttons?.[10] ?? false);
    if (steerFrame === f) return;
    steerFrame = f;
    const p = player();
    const sens = T.sens * num(settings.sensitivity, 1, 0.1, 5);
    const inv = settings.invertY ? -1 : 1;
    let dx = input.mouse?.dx || 0, dy = input.mouse?.dy || 0;
    if (!Number.isFinite(dx)) dx = 0;
    if (!Number.isFinite(dy)) dy = 0;
    const rx = pad ? Math.sign(pad.rx) * pad.rx * pad.rx : 0, ry = pad ? Math.sign(pad.ry) * pad.ry * pad.ry : 0;
    const mx = dx * sens + rx * T.padRate * rdt;
    const my = (dy * sens + ry * T.padRate * rdt) * inv;
    if (freeHeld) {
      freeYaw = wrapAngle(freeYaw - mx);
      const lim = viewMode === 'rider' ? 70 * DEG : 80 * DEG;
      freePitch = clamp(freePitch - my, -lim, lim);
      return;
    }
    aimYaw = wrapAngle(aimYaw - mx);
    const ap0 = aimPitch;
    // (hovering: the view is the aim — its pitch range is the hover view's, so the mouse has no dead travel at the limit)
    const hov = hoverRaw > 0.5;
    aimPitch = clamp(aimPitch - my, hov ? T.hoverPitch[0] : -T.aimPitchMax, hov ? T.hoverPitch[1] : T.aimPitchMax);
    if (mx || my) carryUser(-mx, aimPitch - ap0);   // (flight moves: the player's own swing during a wingover / loop is kept)
    // Gamepad direct flying (left stick) with the right stick idle: the aim trails the dragon's velocity.
    if (!hov && pad && Math.abs(pad.lx) + Math.abs(pad.ly) > 0.2 && Math.abs(rx) + Math.abs(ry) < 0.05 && p) {
      const h = dragonVel.lengthSq() > 4 ? dragonVel : dragonFwd;
      aimYaw += wrapAngle(yawOf(h) - aimYaw) * damp(2.5, rdt);
      aimPitch += (clamp(pitchOf(h), -T.aimPitchMax, T.aimPitchMax) - aimPitch) * damp(2.5, rdt);
    }
    if (p) {
      updateCourse(p);
      carryAim();               // (flight moves: before the queue clamp — the course of a loop flips 180° at the top)
      // A / D (arrows): keyboard turn on top of the mouse — while held, the target leads the course by kbLead to
      // that side (a sustained banked turn); released, the dragon finishes the turn to the target and levels out.
      // (hovering, A / D strafe — player.js — and never turn the aim)
      const kb = hov ? 0 : (input.down('KeyD') || input.down('ArrowRight') ? 1 : 0) - (input.down('KeyA') || input.down('ArrowLeft') ? 1 : 0);
      if (kb) {
        const d = wrapAngle(courseYaw - kb * T.kbLead - aimYaw);
        if (d * -kb > 0) aimYaw = wrapAngle(aimYaw + Math.sign(d) * Math.min(Math.abs(d), T.kbRate * rdt));
      }
      // A huge swing waits at most queueMax away from the course (never wraps into a turn the other way).
      aimYaw = wrapAngle(courseYaw + clamp(wrapAngle(aimYaw - courseYaw), -T.queueMax, T.queueMax));
    }
  }

  /** Early aim hook (system `cameraAim`, fixedUpdate at earlyAimOrder, before the pilots): on the frame's first fixed
   *  step apply this frame's mouse motion and compose aimDir / targetDir / aimPoint, so the pilot steers with the
   *  mouse move of THIS frame (input edges and deltas are valid for the whole frame: input.update() runs before the
   *  steps, endFrame() after lateUpdate). lateUpdate recomposes the aim after the steps as before (course + assist). */
  function earlyAim() {
    const f = game.time.frame;
    if (earlyFrame === f) return;
    earlyFrame = f;
    if (game.state !== 'play' || cine) return;
    const p = player();
    if (!p || aimFor !== p) return;
    const rdt = clamp(game.time.real - lastReal, 0, 0.1);   // = this frame's realDt (time.real advanced before the steps)
    readDragon(p);
    steerMotion(rdt);
    earlyN++;
    if (freeHeld) return;                                    // free-look: the aim stays frozen
    dirFromYP(aimYaw, aimPitch, targetDir);
    updateCourse(p);
    carryAim();
    composeAim();
    flDir.copy(aimDir);
    // (hover: the aim is the view's centre ray; its lens here is the virtual one at the dragon's current position —
    //  lateUpdate redoes it from the placed lens)
    if (hoverW > 1e-4) {
      hoverView();
      hv.F.applyQuaternion(hvShake);               // (the last frame's shake / kick rotation: the reticle's ray)
      placeHover(hoverPivotOf(hvPivot), hvVirt, null);
      blendAim(hvVirt, 0);
    } else aimPoint.copy(dragonPos).addScaledVector(aimDir, 400);
  }

  function readInput(rdt) {
    const input = game.input;
    if (!input) return;
    const st = game.state;
    const p = player();
    const locked = !!input.mouse?.locked || (typeof document !== 'undefined' && document.pointerLockElement === game.canvas);
    lockedNow = locked;

    // Pointer lock: click the canvas during play (a click that skips a cinematic locks too, so one click is enough).
    // If the browser refuses, plain mouse motion steers instead.
    if (st === 'play' && !locked && input.pressed('Mouse0')) {
      input.requestLock?.();
      lockRequestedAt = nowReal();
    }
    if (lockRequestedAt > 0 && !locked && nowReal() - lockRequestedAt > 1.0) { lockUnavailable = true; lockRequestedAt = -1; }
    if (locked) { lockUnavailable = false; lockRequestedAt = -1; }

    const rmb = input.down('Mouse2');
    const alt = input.down('AltLeft') || input.down('AltRight');
    const anyBtn = rmb || input.down('Mouse0') || input.down('Mouse1');
    const inMenu = MENU_STATES.has(st);
    menu.held = inMenu && menu.btns !== 0;
    input.dragOrbit = !locked && ((st === 'play' && (rmb || lockUnavailable)) || (st === 'photo' && anyBtn) || menu.held);

    const pad = input.pad;
    const padBtn = (i) => !!pad?.buttons?.[i] && !padPrev[i];
    const sens = T.sens * num(settings.sensitivity, 1, 0.1, 5);
    const inv = settings.invertY ? -1 : 1;
    let dx = input.mouse?.dx || 0, dy = input.mouse?.dy || 0;
    if (!Number.isFinite(dx)) dx = 0;
    if (!Number.isFinite(dy)) dy = 0;
    const rx = pad ? Math.sign(pad.rx) * pad.rx * pad.rx : 0, ry = pad ? Math.sign(pad.ry) * pad.ry * pad.ry : 0;
    const wheel = input.wheel || 0;

    if (st === 'photo') {
      photo.yaw -= dx * sens + rx * T.padRate * rdt;
      photo.pitch = clamp(photo.pitch - (dy * sens + ry * T.padRate * rdt) * inv, -85 * DEG, 85 * DEG);
      if (wheel) {
        if (input.down('ShiftLeft') || input.down('ShiftRight')) photo.fov = clamp(photo.fov * Math.exp(wheel * 0.0008), 18, 95);
        else {
          // Zooming in stops at the dragon's hull: while the lens is pushed out (photoReach > dist) another notch in
          // does nothing, and right after a notch in the stored distance is raised to where the hull left the lens
          // (lateUpdate), so there is no dead wheel travel and the next notch out moves the camera at once.
          const pushed = photoReach > photo.dist + 0.05;
          if (!(wheel < 0 && pushed)) photo.dist = clamp(photo.dist * Math.exp(wheel * 0.0012), 3, 160);
          if (wheel < 0) photoWheelInAt = nowReal();
        }
      }
      if (input.down('KeyQ')) photo.roll += 30 * DEG * rdt;
      if (input.down('KeyE')) photo.roll -= 30 * DEG * rdt;
      if (input.pressed('KeyR')) { photo.roll = 0; photo.fov = 50; }
      if (input.pressed('KeyP') || input.pressed('Escape') || padBtn(1)) { game.setState('play'); lockLostAt = nowReal(); }
    } else if (st === 'play' && !cine) {
      // (the aim / free-look motion of this frame: usually already applied by the early aim hook before the fixed steps)
      steerMotion(rdt);
      if (wheel) {
        if (viewMode === 'rider') {
          if (wheel > 0) setView('chase');
        } else {
          const before = zoom;
          zoom = clamp(zoom * Math.exp(wheel * 0.0012), T.zoomMin, T.zoomMax);
          if (wheel < 0 && before <= T.zoomMin + 1e-3) { wheelPush += wheel; if (wheelPush < -360) { wheelPush = 0; setView('rider'); } }
          else wheelPush = 0;
        }
      }
      if (input.pressed('KeyV') || padBtn(8)) setView(viewMode === 'rider' ? 'chase' : 'rider');
      if (input.pressed('Tab') || padBtn(11)) cycleLock();
      if (input.pressed('KeyP')) game.setState('photo');
      if (input.pressed('Escape') && !game.hud && nowReal() - lockLostAt > 0.4) game.setState('paused');
    } else if (inMenu && !cine) {
      // Title / results: drag orbits the gliding dragon (yaw is kept, the auto-orbit resumes from there on release;
      // the tilt eases back to the cinematic angle); the wheel over the canvas changes the distance.
      freeHeld = false;
      if (menu.held) {
        const mx = dx * sens + rx * T.padRate * rdt, my = (dy * sens + ry * T.padRate * rdt) * inv;
        orbitYaw -= mx;
        menu.pitch = clamp(menu.pitch - my, T.menuPitchMin + 10 * DEG, T.menuPitchMax + 7 * DEG);
        menu.dragged += Math.abs(dx) + Math.abs(dy);
      } else menu.pitch = dampTo(menu.pitch, 0, T.menuPitchReturn, rdt);
      if (wheel) menu.zoom = clamp(menu.zoom * Math.exp(wheel * 0.0012), T.menuZoomMin, T.menuZoomMax);
    } else if (cine) {
      freeHeld = false;
      // Skippable cinematics (default) end on Enter / Space / click or a deliberate mouse sweep: the player wants to fly.
      cine.moved = (cine.moved || 0) + Math.abs(dx) + Math.abs(dy) + (Math.abs(rx) + Math.abs(ry)) * 600 * rdt;
      // On the results screen a drag (menu.held) also ends it and hands over to the drag orbit.
      if (cine.spec.skippable !== false && cine.t > 0.4
        && (input.anyPressed('Enter', 'Space', 'Mouse0') || cine.moved > 250 || padBtn(0) || menu.held)) finishCinematic(false);
    } else freeHeld = false;

    if (!freeHeld) {
      freeYaw = dampTo(freeYaw, 0, T.freeReturn, rdt);
      freePitch = dampTo(freePitch, 0, T.freeReturn, rdt);
    }
    freeW = dampTo(freeW, freeHeld ? 1 : 0, 8, rdt);
    menu.w = dampTo(menu.w, menu.held ? 1 : 0, 6, rdt);
    padPrev = pad?.buttons ? pad.buttons.slice() : [];
    // Cursor hint on the title canvas: grab / grabbing (only ever set by the camera, cleared outside the menus).
    const cur = inMenu && !locked ? (menu.held ? 'grabbing' : 'grab') : '';
    if (cur !== cursorSet && game.canvas?.style) { game.canvas.style.cursor = cur; cursorSet = cur; }
  }

  function setView(v) {
    if (v !== 'chase' && v !== 'rider') return;
    if (v === viewMode) return;
    viewMode = v;
    if (mode === 'chase' || mode === 'rider' || mode === 'free') beginBlend(0.45);
  }

  // ---- events --------------------------------------------------------------------------------------------------------
  const ev = game.events;
  ev.on('state', ({ prev, next }) => {
    const p = player();
    if (next === 'play' && p && (prev === 'title' || prev === 'loading' || prev === 'victory' || prev === 'defeat' || aimFor !== p)) {
      initAimFrom(p);
      beginBlend(prev === 'loading' ? 0.01 : 1.4);
    } else if (next === 'play' && prev === 'photo') beginBlend(0.6);
    if (next === 'photo') {
      photoSession++;             // the frozen pose gets a fresh hull cloud
      photoWheelInAt = nowReal(); // (a start inside the hull, e.g. from the rider view, stores the clear distance)
      // Start the photo orbit exactly where the camera is.
      _a.copy(dragonPos); _a.y += T.pivotUp * 0.6;
      _b.subVectors(_a, cam.position);
      photo.dist = clamp(_b.length(), 3, 160);
      photo.yaw = yawOf(_b); photo.pitch = clamp(pitchOf(_b), -85 * DEG, 85 * DEG);
      photo.roll = 0; photo.fov = clamp(cam.fov, 18, 95);
    }
    if (next === 'title' || next === 'victory' || next === 'defeat') {
      orbitT = 0; orbitYaw = 0; menu.pitch = 0; menu.zoom = 1; menu.w = 0; menu.dragged = 0;
      res.dist = 0; res.set = false; res.textAt = -1;
      // A cinematic (the victory lap) keeps playing until the results screen is up, then hands over to the orbit.
      if (cine && next !== 'title') cine.cutAt = Math.min(cine.cutAt ?? Infinity, cine.t + T.resultsCut);
      else if (cine) finishCinematic(false);
      beginBlend(next === 'title' ? 0.01 : 1.5);
    }
    if (!MENU_STATES.has(next)) menu.btns = 0;
    if (next !== 'play') { grabHand = null; grabFocus?.stop(); grabFocus = null; }
  });
  // Title / results drag orbit. The results screen swallows pointer events (so its buttons work), so the camera
  // listens on the window: a press anywhere that is not a control starts an orbit drag.
  const CONTROLS = 'button, input, select, textarea, a, label, [role="button"], [role="slider"], .panel, .menu';
  if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', (e) => {
      if (!MENU_STATES.has(game.state)) return;
      const t = e.target;
      if (t && t !== game.canvas && t.closest?.(CONTROLS)) return;
      menu.btns = e.buttons || 1;
    }, true);
    const up = (e) => { menu.btns = menu.btns && e?.buttons ? e.buttons : 0; };
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', () => { menu.btns = 0; }, true);
    window.addEventListener('blur', () => { menu.btns = 0; });
  }
  ev.on('pointerlock', ({ locked }) => {
    if (locked) return;
    lockLostAt = nowReal();
    if (game.state === 'photo') game.setState('play');
    else if (game.state === 'play') game.setState('paused');
  });
  if (typeof document !== 'undefined') document.addEventListener('pointerlockerror', () => { lockUnavailable = true; lockRequestedAt = -1; });
  ev.on('wingbeat', ({ actor, strength = 0.5 } = {}) => {
    const p = player();
    if (!actor) return;
    if (p && (actor === p.actor || actor === p)) {
      // Downstroke: the body heaves, the lens dips a touch and nods (subtle; rider view nods more).
      // (hover TPS: no nod — a camera rotation the aim does not share moved the centred reticle 4–6 px per stroke; the
      //  lens still dips with the heave)
      kickV.y -= 2.0 * strength;
      kickPitchV -= (viewMode === 'rider' ? 0.05 : 0.025 * (1 - clamp(hoverW, 0, 1))) * strength;
    } else if (actor.kind === 'titan' && settings.autoShake && actor.pos) {
      const d = actor.pos.distanceTo(cam.position);
      const k = 1 - smoothstep(60, 450, d);
      if (k > 0) shake(0.28 * k, 0, 'titan');
    }
  });
  ev.on('damage', (rec) => {
    const p = player();
    if (!p || rec?.target !== p.actor) return;
    // Wave 5: a swat / titan contact holds the chase follow from this very frame (dragon.stagger comes a step later).
    if ((rec.kind === 'swat' || rec.kind === 'impact') && (rec.amount || 0) >= 10) {
      hitHoldUntil = Math.max(hitHoldUntil, (game.time?.now ?? 0) + (rec.kind === 'swat' ? 0.5 : 0.25));
      hitHoldKind = rec.kind;
    }
    if (!settings.autoShake) return;
    const big = rec.kind === 'swat' || rec.kind === 'impact' || rec.kind === 'crash';
    const amt = clamp((rec.amount || 0) / 35, 0.1, 1);
    shake(big ? 0.55 * amt + 0.2 : 0.3 * amt, 0, big ? 'near' : 'hit');
    if (rec.dir) kick(rec.dir, (big ? 1.2 : 0.5) * amt);
  });
  ev.on('explosion', ({ point, radius = 10, kind } = {}) => {
    // combat/fire.js shakes the camera for its own explosions; this covers explosions from anything else.
    if (!settings.autoShake || !point || game.fx) return;
    const d = point.distanceTo(cam.position);
    const k = 1 - smoothstep(radius * 1.5, radius * 8 + 40, d);
    if (k > 0) shake(0.5 * k, 0, kind === 'titan' ? 'titan' : 'near');
  });
  ev.on('breath', ({ actor, on } = {}) => {
    const p = player();
    if (!settings.autoShake || !p || actor !== p.actor && actor !== p) return;
    if (on && !breathShake) { breathShake = shake(0.14, 1e9, { kind: 'fire', decay: 3 }); if (breathShake) breathShake.handle = true; }
    if (!on && breathShake) { breathShake.hold = 0; breathShake = null; }
  });
  ev.on('titan:telegraph', ({ duration = 1, attack, hand } = {}) => {
    telegraphUntil = nowReal() + duration + 0.5;
    // (Wave 5) a melee blow: the chase arm drifts off the striking hand's side until it has swung through
    if (MELEE.has(attack)) { meleeParts = hand === 'L' ? ['handL'] : hand === 'R' ? ['handR'] : ['handL', 'handR']; meleeUntil = nowReal() + duration + T.meleeHold; }
  });
  ev.on('titan:grab', ({ actor, state, hand } = {}) => {
    const p = player();
    if (!p || (actor && actor !== p.actor && actor !== p)) return;
    if (state === 'caught') {
      grabHand = hand === 'L' || hand === 'R' ? hand : null;
      // Look up at the titan's face while the dragon struggles in its fist; the hold is ≈ 1.6 s + the throw.
      grabFocus?.stop();
      grabFocus = focus('titan:head', { duration: 2.6, weight: 0.7, maxAngle: 30 * DEG });
      if (settings.autoShake) shake(0.45, 0.5, 'near');
    } else if (state === 'thrown' || state === 'released') {
      // ('reach' = the lunge started: nothing to do, the boss framing and the telegraph already frame the hand.)
      grabHand = null;
      if (state === 'released') { grabFocus?.stop(); grabFocus = null; }
    }
  });
  // ---- flight moves (shared move contract; the player's moves are also polled from game.player.moves) ----------------
  /** An event about someone else (AI pilots use the same moves): payloads carry `actor`; none = the player's. */
  const notMine = (actor) => { const p = player(); return !!actor && !!p && actor !== p.actor && actor !== p; };
  ev.on('move', ({ name, side, phase, actor } = {}) => {
    if (typeof name !== 'string' || notMine(actor)) return;
    if (phase === 'start') { mv.ev = name; mv.evSide = +side || 0; mv.evAt = nowReal(); }
    else if (phase === 'end' && mv.ev === name) mv.ev = null;
  });
  ev.on('nearmiss', (e = {}) => {
    const p = player();
    if (!p || game.state !== 'play' || mode === 'photo' || cine || notMine(e.actor)) return;
    const now = nowReal();
    if (now - lastNearAt < T.nearGap) return;
    lastNearAt = now;
    const sp = Number.isFinite(+e.speed) ? +e.speed : speedOf(p);
    const k = 0.6 + 0.4 * smoothstep(35, 80, sp);
    pushPop(T.nearFov * k, 0.07 * k, T.nearEnv);
    if (settings.autoShake) shake(T.nearShake * k, 0, 'nearmiss');
    const at = e.pos?.isVector3 ? e.pos : e.point?.isVector3 ? e.point : null;   // (a nudge away from what we passed)
    if (at) { _k1.subVectors(dragonPos, at); if (_k1.lengthSq() > 1e-4) kick(_k1, 0.22 * k); }
    mv.counts.nearmiss++;
    mv.lastNear = { kind: e.kind ?? null, dist: Number.isFinite(+e.dist) ? +(+e.dist).toFixed(1) : null, speed: +sp.toFixed(1), t: +now.toFixed(3) };
  });
  ev.on('skim', ({ on, actor } = {}) => { if (!notMine(actor)) mv.skimEv = on ? 1 : 0; });
  ev.on('charge', ({ level, actor } = {}) => { if (!notMine(actor)) mv.chargeEv = Number.isFinite(+level) ? clamp(+level, 0, 1) : 0; });
  ev.on('special', ({ name, on, actor } = {}) => { if (name === 'inferno' && !notMine(actor)) mv.specialEv = !!on; });
  ev.on('momentum', ({ skyfall, actor } = {}) => {
    if (notMine(actor)) return;
    const sf = !!skyfall;
    if (sf && !mv.skyfall && game.state === 'play') {
      // the dive pull-out that earns 'skyfall': a punch of FOV and blur, a short shove
      pushPop(5, 0.14, [0.06, 0.18, 0.6]);
      if (settings.autoShake) shake(0.3, 0, 'near');
      mv.counts.skyfall++;
    }
    mv.skyfall = sf;
  });
  ev.on('fireball', ({ owner, projectile, charged } = {}) => {
    const p = player();
    if (!p || !owner || (owner !== p.actor && owner !== p) || game.state !== 'play') return;
    const c = [charged, projectile?.charged, projectile?.opts?.charged].find((v) => Number.isFinite(+v) && v !== null && v !== '');
    const lvl = c !== undefined ? clamp(+c, 0, 1) : chargeK > 0.25 ? chargeK : 0;
    if (lvl > 0.25) {
      kick(_k1.copy(dragonFwd).negate(), T.chargeKick * lvl);        // recoil of a charged shot
      pushPop(3 * lvl, 0.08 * lvl, [0.04, 0.05, 0.4]);
      mv.counts.charged++;
    }
  });
  ev.on('death', ({ actor } = {}) => { if (actor && actor === lockTarget) setLock(null); });
  ev.on('actor:remove', ({ actor } = {}) => { if (actor && actor === lockTarget) setLock(null); });

  // ---- per-frame --------------------------------------------------------------------------------------------------
  function stepSprings(rdt) {
    const h = Math.min(rdt, 1 / 30);
    const n = Math.max(1, Math.ceil(h / (1 / 120)));
    const dt = h / n, w = 10, z = 0.45, wr = 9, zr = 0.5;
    for (let i = 0; i < n; i++) {
      kickV.addScaledVector(kickX, -w * w * dt).addScaledVector(kickV, -2 * z * w * dt);
      kickX.addScaledVector(kickV, dt);
      kickYawV += (-wr * wr * kickYaw - 2 * zr * wr * kickYawV) * dt; kickYaw += kickYawV * dt;
      kickPitchV += (-wr * wr * kickPitch - 2 * zr * wr * kickPitchV) * dt; kickPitch += kickPitchV * dt;
    }
    kickX.clampLength(0, 2.5);
    kickYaw = clamp(kickYaw, -0.12, 0.12); kickPitch = clamp(kickPitch, -0.12, 0.12);
  }

  function shakeOffsets(rdt, speedS) {
    const t = nowReal();
    let yaw = 0, pitch = 0, roll = 0, tx = 0, ty = 0;
    for (let i = shakes.length - 1; i >= 0; i--) {
      const e = shakes[i];
      if (e.hold > 0) e.hold -= rdt; else e.trauma -= e.decay * rdt;
      if (e.trauma <= 0) { shakes.splice(i, 1); if (e === breathShake) breathShake = null; continue; }
      const k = e.trauma * Math.sqrt(e.trauma), x = t * e.freq + e.seed;   // trauma^1.5: 0.15 is light but visible
      yaw += k * e.rot * noise[0](x);
      pitch += k * e.rot * noise[1](x);
      roll += k * e.rot * 0.7 * noise[2](x);
      tx += k * e.trans * noise[3](x);
      ty += k * e.trans * noise[4](x);
    }
    // Speed shake: rotational only, small, 12 Hz (never fights the aim; the aim is not derived from the camera).
    if (speedS > 0) {
      const k = 0.3 * DEG * speedS * speedS, x = t * 12;
      yaw += k * noise[5](x); pitch += k * noise[0](x + 17.3);
    }
    const sc = num(settings.shake, 1, 0, 2);
    return { yaw: yaw * sc, pitch: pitch * sc, roll: roll * sc, tx: tx * sc, ty: ty * sc };
  }

  function lateUpdate(dt, realDt) {
    const rdt = Math.min(0.1, Math.max(0, realDt || 0));
    const st = game.state;
    if (st === 'loading') return;
    const p = player();
    if (p) {
      if (aimFor !== p) initAimFrom(p);
      readDragon(p);
      // Respawn / teleport (> 80 m in one frame): the old world target would turn the dragon back toward where it
      // was flying before, so the aim and the rig restart from the new course.
      if (hasLastPos && lastPos.distanceToSquared(dragonPos) > 80 * 80 && !MENU_STATES.has(st)) initAimFrom(p);
      lastPos.copy(dragonPos); hasLastPos = true;
    } else if (!dragonPos.lengthSq()) dragonPos.set(0, 1200, 0);

    // Aim and rig. Flying (play / photo / pause with a dragon): the aim is the course plus the capped lead toward the
    // mouse target, and the chase rig follows the COURSE (+ camLead of the lead), so the camera is always behind the
    // dragon, never 60° ahead of it. Menus / no dragon: the rig follows the target as before (MouseFlight).
    dirFromYP(aimYaw, aimPitch, targetDir);
    flying = !!p && !MENU_STATES.has(st);
    // Wave 5 (dragon owner): after a swat / heavy blow (dragon.stagger, or the camera's own 'damage' hold, which starts
    // in the very frame of the blow) the course / roll / surge follow is held, so the knock's Δv and the tumble are
    // absorbed instead of swinging the arm toward the titan's hand.
    const stg = p?.stagger;
    const staggered = !!p && st === 'play' && ((stg && Number.isFinite(stg.until) && game.time.now <= stg.until) || game.time.now < hitHoldUntil);
    if (staggered) { staggerK = 1; staggerKind = stg?.kind || hitHoldKind || 'hit'; }
    else { staggerK = dampTo(staggerK, 0, T.staggerRelease, rdt); if (staggerK < 1e-3) { staggerK = 0; staggerKind = null; } }
    const sk = 1 - staggerK * (1 - T.staggerHold);
    // Flight moves (feature-detected: game.player.moves / the 'move', 'skim', 'charge', 'special' events).
    const mvS = pollMoves(p, st);
    skimK = dampTo(skimK, mvS.skim, mvS.skim > skimK ? T.skimLambda[0] : T.skimLambda[1], rdt);
    chargeK = dampTo(chargeK, mvS.charge, 8, rdt);
    // Hover / aim: the hover share of this frame (game.player.flightMode; none = forward flight), the camera's blend
    // weight (only moves in play: pause / photo keep the pose), the course override while hovering.
    if (!flying) hoverRaw = 0;
    else if (st === 'play') hoverRaw = hoverShareOf(p);
    const hrdt = st === 'play' || !flying ? rdt : 0;
    hoverW = dampTo(hoverW, hoverRaw, hoverRaw > hoverW ? T.hoverBlend[0] : T.hoverBlend[1], hrdt);
    if (hoverW < 1e-4 && hoverRaw === 0) hoverW = 0;
    hoverC = dampTo(hoverC, hoverRaw, T.hoverCourse, hrdt);
    if (hoverC < 1e-4 && hoverRaw === 0) hoverC = 0;
    hv.mode = flightModeOf(p);
    if (flying) {
      updateCourse(p);
      carryAim(rdt);            // wingover / loop: the aim target rides with the course
      // Lock-on assist: the aim leans toward (and sticks to) a locked target near where the player aims; the camera
      // still follows the course, so it stays behind the dragon. (Not sticky during a carried move.)
      updateAssist(rdt, st === 'play' && !cine && !freeHeld && !mv.carry);
      // Aim magnetism (≤ 3°) toward the soft target player.js picked near the reticle.
      updateMagnet(rdt, st === 'play' && !cine && !freeHeld);
      composeAim();
      flDir.copy(aimDir);
      // Wave 5 (flight owner): a Q / E dodge hop swings the velocity ~40° sideways for ~0.6 s while the nose holds the
      // course, so for the hop the view follows the NOSE (+ camLead of the flown aim) instead of the velocity. The aim
      // the pilot flies is unchanged (still composed on the velocity course).
      const dodge = dodgingOf(p);
      dodgeW = dampTo(dodgeW, dodge ? 1 : 0, dodge ? T.dodgeFollow[0] : T.dodgeFollow[1], rdt);
      const camCourse = courseYaw + dodgeW * wrapAngle(noseYaw - courseYaw);
      const ty = camCourse + T.camLead * wrapAngle(courseYaw + leadYaw - camCourse);
      // (flight moves — skim: holding a skim, the player keeps the aim below the course; the view does not follow that
      //  pitch lead down into the surface: measured −7.7° rig pitch on a −1.8° course, the lens 2.3 m higher)
      const tp = clamp(coursePitch + T.camLead * leadPitch * (1 - T.skimLeadPitch * skimK), -T.aimPitchMax, T.aimPitchMax);
      rigYaw += wrapAngle(ty - rigYaw) * damp(T.courseLambda * sk, rdt);
      rigPitch += (tp - rigPitch) * damp(T.coursePitchLambda * sk, rdt);
    } else {
      rigYaw += wrapAngle(aimYaw - rigYaw) * damp(T.rigLambda, rdt);
      rigPitch += (aimPitch - rigPitch) * damp(T.rigLambda, rdt);
      aimDir.copy(targetDir); leadYaw = leadPitch = 0;
      assist.oy = assist.op = 0; assist.w = 0;
      magnet.oy = magnet.op = 0; magnet.w = 0; magnet.target = null;
      flDir.copy(aimDir);
    }
    // (hover: a provisional aim from the virtual hover lens — the bias' keep-the-reticle-in-frame window reads it; the
    //  final one comes from the placed lens below)
    if (flying && hoverW > 1e-4) {
      hoverView();
      placeHover(hoverPivotOf(hvPivot), hvVirt, null);
      blendAim(hvVirt, 0);
    } else aimPoint.copy(dragonPos).addScaledVector(aimDir, 400);

    // Mode.
    let m;
    if (cine) m = 'cinematic';
    else if (st === 'photo') m = 'photo';
    else if (st === 'title' || st === 'victory' || st === 'defeat') m = 'title';
    else if (!p) m = 'title';
    else m = viewMode === 'rider' ? 'rider' : freeHeld ? 'free' : 'chase';
    mode = m;
    if (lastMode && lastMode !== m && m !== 'free' && lastMode !== 'free' && !blend.active) beginBlend(0.45);
    lastMode = m;

    let allowShorten = true, selfAvoid = true, biasK = 0;
    const speedS = p ? smoothstep(40, 75, speedOf(p)) : 0;
    pose.useQuat = false;
    // Flight moves: the aerobatic frame (wingover / loop / near-vertical) for the chase / free view; the seat view uses it
    // for loops only. Other modes let it go (it re-seeds from the chase frame next time).
    // (hovering: no aerobatic frame — the moves are forward-flight moves)
    updateAero(rdt, sk, flying && st === 'play' && hoverRaw < 0.5 && (m === 'chase' || m === 'free' || (m === 'rider' && mv.name !== 'wingover')), m === 'rider');
    updatePops();
    const hoverE = flying && (m === 'chase' || m === 'free') ? ease(clamp(hoverW, 0, 1)) : 0;
    hoverFade = hoverE;
    if (m === 'cinematic') { poseCinematic(rdt); allowShorten = false; }
    else if (m === 'photo') { posePhoto(rdt, p); selfAvoid = false; }   // (photo keeps out of the dragon itself: photoExit)
    else if (m === 'title') { poseOrbit(rdt, st === 'victory' || st === 'defeat'); allowShorten = false; }
    else if (m === 'rider') { poseRider(p, rdt); allowShorten = false; selfAvoid = false; biasK = 0.5 * (1 - freeW); }
    else {
      poseChase(p, rdt, game.time.dt || 0, sk); biasK = 1 - freeW;
      // Wave 5: the titan's arm / hand never hides Sora (orbit around it; after a swat keep off the hand's side).
      // (hovering: the view is the aim — no sight-line orbit; the arm shortening / push-out still keep the lens clear)
      gatherBig(p);
      try { titanSight(rdt, hoverW < 0.5); } catch (e) { if (failed++ < 3) console.warn('[cameraRig] titan sight line', e); }
      // Hover: the TPS over-the-shoulder pose, blended in by the hover weight; the framing bias fades out with it
      // (the reticle stays at the screen centre).
      if (hoverE > 1e-4) {
        try { blendHover(); } catch (e) { if (failed++ < 3) console.warn('[cameraRig] hover pose', e); }
        biasK *= 1 - hoverE;
      }
    }
    if (m !== 'chase' && m !== 'free' && (occ.yaw || occ.pitch)) { occ.yaw = occ.pitch = occ.ty = occ.tp = 0; }

    if (m === 'chase' || m === 'free' || m === 'rider') applyBias(rdt, biasK, m !== 'rider', m === 'chase');
    else { biasYaw = dampTo(biasYaw, 0, 3, rdt); biasPitch = dampTo(biasPitch, 0, 3, rdt); }
    // Flight moves: FOV pops (dash, near miss, skyfall, charged release), the charge tightening, the inferno cut-in.
    if (m === 'chase' || m === 'free' || m === 'rider') {
      pose.fov = clamp(pose.fov + fxFov - T.chargeFov * chargeK, 20, 110);
      if (m === 'chase' && p) applyCut(p); else if (cutT >= 0 && nowReal() - cutT > envLen(T.cutEnv)) { cutT = -1; cutW = 0; }
    } else { cutT = -1; cutW = 0; }
    preAvoid.copy(pose.pos);
    avoid(p, rdt, allowShorten, selfAvoid, m === 'rider' ? 0.6 : T.clearance, m === 'chase' || m === 'free' ? T.bigArmMin : 0.12);
    // Photo: how far the lens really is from the orbit pivot after the hull push (the wheel never zooms into the hull).
    if (m === 'photo') {
      photoReach = pose.pos.distanceTo(P);
      if (nowReal() - photoWheelInAt < 0.35 && photoReach > photo.dist + 0.02) photo.dist = Math.min(160, photoReach);
    }

    // (flight moves: the aerobatic frame's orientation, turned by what the bias / free-look / cut-in did to pose.dir)
    if (pose.useQuat) camQuat.setFromUnitVectors(poseQDir, pose.dir).multiply(poseQ);
    else quatFrom(pose.dir, pose.roll, camQuat);
    let fov = pose.fov;
    if (blend.active) {
      blend.t += rdt;
      const e = ease(clamp(blend.t / blend.dur, 0, 1));
      // Blend relative to the pivot along an arc, so a title → chase swing never passes through the dragon.
      _a.subVectors(pose.pos, dragonPos);
      const la = blend.fromRel.length(), lb = _a.length();
      if (la > 1e-3 && lb > 1e-3) {
        _b.copy(blend.fromRel).divideScalar(la); _c.copy(_a).divideScalar(lb);
        _q.setFromUnitVectors(_b, _c); _q2.identity().slerp(_q, e);
        _b.applyQuaternion(_q2).multiplyScalar(lerp(la, lb, e));
        pose.pos.copy(dragonPos).add(_b);
      } else pose.pos.lerpVectors(_d.copy(dragonPos).add(blend.fromRel), pose.pos, e);
      camQuat.slerpQuaternions(blend.fromQuat, camQuat, e);
      fov = lerp(blend.fromFov, fov, e);
      if (blend.t >= blend.dur) blend.active = false;
      // In-between poses get the same protection (e.g. swinging back from a cinematic past the titan's body).
      if (allowShorten && p) {
        const h = armHit(P, pose.pos, T.clearance);
        if (h < 1) pose.pos.sub(P).multiplyScalar(h).add(P);
      }
      solidify(pose.pos, p, selfAvoid, m === 'rider' ? 0.6 : T.clearance);
    }

    stepSprings(rdt);
    const sh = shakeOffsets(rdt, m === 'chase' || m === 'rider' ? speedS : 0);
    cam.position.copy(pose.pos).add(kickX);
    if (sh.tx || sh.ty) {
      _r.set(1, 0, 0).applyQuaternion(camQuat); _u.set(0, 1, 0).applyQuaternion(camQuat);
      cam.position.addScaledVector(_r, sh.tx).addScaledVector(_u, sh.ty);
    }
    _e.set(kickPitch + sh.pitch, kickYaw + sh.yaw, sh.roll, 'YXZ');
    cam.quaternion.copy(camQuat).multiply(_q.setFromEuler(_e));
    if (Math.abs(cam.fov - fov) > 1e-3) { cam.fov = fov; cam.updateProjectionMatrix(); }
    cam.updateMatrixWorld();
    // Hover / aim: the final aim (after the lens is placed and shaken). Hovering, the aim ray starts at the placed lens
    // (the hover lens + what the avoidance did to it) and runs along the hover view turned by this frame's shake / kick
    // rotation, so the reticle (aimPoint) sits exactly at the screen centre — TPS: the screen shakes, the crosshair stays
    // (measured before: the titan's rumble moved it 18 px off the centre). In free-look, the rider view and the other
    // modes it starts at the virtual hover lens along the hover view. Forward flight (hoverW 0): as before.
    if (flying && hoverW > 1e-4) {
      try {
        hoverView();
        placeHover(hoverPivotOf(hvPivot), hvVirt, null);
        // (the avoidance's displacement always; the rest of the placed lens — cut-in, a mode blend, the kick / shake
        //  translation — once fully hovering)
        const act = m === 'chase' ? 1 - freeW : 0, full = act * smoothstep(0.9, 1, hoverE);
        hvLens.copy(hvVirt);
        if (act > 1e-4) hvLens.addScaledVector(_hp.subVectors(pose.pos, preAvoid), act).addScaledVector(_hd.subVectors(cam.position, hvVirt).sub(_hp), full);
        hvLensSet = true;
        // the shake / kick rotation of this frame (world: cam.quaternion · camQuat⁻¹), for the early hook too
        _hq.copy(camQuat).invert().premultiply(cam.quaternion);
        hvShake.identity().slerp(_hq, full);
        hv.F.applyQuaternion(hvShake);
        blendAim(hvLens, rdt);
        // (tests: how far the reticle sits from the screen centre — the camera's forward vs lens → aimPoint)
        _hd.set(0, 0, -1).applyQuaternion(cam.quaternion); _hp.subVectors(aimPoint, cam.position);
        hv.reticleDeg = _hp.lengthSq() > 1 ? Math.acos(clamp(_hd.dot(_hp.normalize()), -1, 1)) / DEG : 0;
      } catch (e) { if (failed++ < 3) console.warn('[cameraRig] hover aim', e); }
    } else { hvLensSet = false; hv.reticleDeg = 0; hvShake.identity(); if (!(hv.conv > 0)) hv.conv = T.aimFar; }
    aimS.lerp(aimDir, damp(T.rigLambda, rdt));
    if (aimS.lengthSq() < 1e-4) aimS.copy(aimDir); else aimS.normalize();
    speedBlur(p, m, st, rdt);
    shadowFocus(m);
  }

  // ---- speed blur / shadow focus (feature-detected hooks of the pipeline and the sky) ------------------------------
  /** Subtle radial blur from speed, boost and dive, centred on the dragon (the pipeline keeps the centre crisp). */
  function speedBlur(p, m, st, rdt) {
    const pl = game.pipeline;
    if (!pl?.setSpeedBlur) return;
    let target = 0;
    if (p && st === 'play' && (m === 'chase' || m === 'free' || m === 'rider')) {
      const v = speedOf(p), c = p.controls || {};
      const boost = c.boost || p.boosting === true ? 1 : 0;
      const dive = clamp(+c.dive || (p.diving === true ? 1 : 0), 0, 1);
      // Boost and dive read at once (the stroke / the stoop is the event); raw speed adds the rest.
      target = T.blurSpeedK * smoothstep(T.blurSpeed[0], T.blurSpeed[1], v)
        + T.blurBoostK * boost * smoothstep(20, 45, v)
        + T.blurDiveK * dive * smoothstep(25, 60, v);
      target = Math.min(target, T.blurMax) * (m === 'rider' ? T.blurRider : 1) * num(settings.speedBlur, 1, 0, 1.5);
    }
    blurS = dampTo(blurS, target, target > blurS ? 3 : 1.6, rdt);
    if (blurS < 1e-3) blurS = 0;
    // Flight moves: pulses on top of the smoothed blur (they are the event) — the dash, near miss and skyfall pops, the
    // skim's streaming surface, the inferno cut-in's zoom burst.
    let out = blurS;
    if (p && st === 'play' && (m === 'chase' || m === 'free' || m === 'rider')) {
      const pulse = (fxBlur + T.skimBlur * skimK * smoothstep(25, 45, speedOf(p)) + T.cutBlur * cutW) * num(settings.speedBlur, 1, 0, 1.5);
      out = Math.min(0.8, blurS + pulse * (m === 'rider' ? T.blurRider : 1));
    }
    if (out < 1e-3) out = 0;
    blurOut = out;
    // Centre: the dragon on screen (chase), or where the flight path points (rider view); the head during the cut-in.
    if (m === 'rider') _a.copy(cam.position).addScaledVector(dragonVel.lengthSq() > 4 ? _b.copy(dragonVel).normalize() : dragonFwd, 200);
    else if (cutW > 0.05) _a.copy(cutHead);
    else _a.copy(dragonPos);
    _a.project(cam);
    if (_a.z < 1 && Number.isFinite(_a.x)) blurCenter.set(clamp(_a.x * 0.5 + 0.5, 0.3, 0.7), clamp(_a.y * 0.5 + 0.5, 0.3, 0.7));
    else blurCenter.set(0.5, 0.5);
    if (out === 0 && blurSent === 0) return;
    try { pl.setSpeedBlur(out, blurCenter); blurSent = out; } catch { /* optional */ }
  }

  /** The near shadow cascade follows the player unless a cinematic looks at something else (the titan's face). */
  function shadowFocus(m) {
    const sky = game.sky;
    if (!sky?.setShadowFocus) return;
    let want = null;
    if (m === 'cinematic' && player()) {
      _a.subVectors(dragonPos, cam.position);
      const d = _a.length();
      _b.set(0, 0, -1).applyQuaternion(cam.quaternion);
      const inView = d > 1e-3 && _a.dot(_b) / d > Math.cos(Math.min(cam.fov * DEG * 0.75, 70 * DEG));
      if (!(inView && d < 90)) want = shadowPt.copy(cineLook);
    }
    if (want === shadowFocusSet) return;
    try { sky.setShadowFocus(want); shadowFocusSet = want; } catch { /* optional */ }
  }

  const rig = {
    name: 'cameraRig',
    settings,
    tuning: T,
    aimDir,
    aimPoint,
    targetDir,                 // the mouse's world target (uncapped); aimDir = course + the capped lead toward it
    get lead() { return { yaw: leadYaw, pitch: leadPitch }; },
    get course() { return { yaw: courseYaw, pitch: coursePitch }; },
    get mode() { return mode; },
    get viewMode() { return viewMode; },
    get lockTarget() { return lockTarget; },
    get zoom() { return zoom; },
    set zoom(v) { zoom = clamp(v, T.zoomMin, T.zoomMax); },
    get pointerLocked() { return lockedNow; },
    get lockUnavailable() { return lockUnavailable; },
    /** Hover / aim: the chase ↔ hover blend (w 0 forward flight … 1 hovering), whether the reticle is the screen centre
     *  now (TPS aim), the soft-target magnet's lean (deg) — read-only, for the HUD and tests. */
    get hover() {
      return { w: hoverW, raw: hoverRaw, mode: hv.mode, centred: hoverW > 0.98 && mode === 'chase',
        magnetDeg: Math.hypot(magnet.oy * Math.cos(aimPitch), magnet.op) / DEG, magnetTarget: magnet.w > 0 ? magnet.target : null };
    },
    /** The aim magnetism toward player.softTarget is applied HERE, to aimDir / aimPoint (≤ maxDeg): a pilot that reads
     *  aimDir should not bend it toward the soft target again (feature-detect `cameraRig.aimMagnet?.applied`). */
    aimMagnet: {
      applied: true, get maxDeg() { return T.magnetMax / DEG; },
      get leanDeg() { return Math.hypot(magnet.oy * Math.cos(aimPitch), magnet.op) / DEG; },
      get target() { return magnet.w > 0 ? magnet.target : null; },
    },
    get cinematic() { return cine ? cine.name : null; },
    shake,
    kick,
    focus,
    playCinematic,
    stopCinematic() { if (cine) finishCinematic(false); },
    setView,
    lock: (target) => setLock(target),
    cycleLock,
    saveSettings: persist,
    /** Point the aim (and the rig) along a world direction, e.g. after a respawn or a scripted turn. */
    setAim(dir, snap = false) {
      if (!dir || dir.lengthSq() < 1e-8) return;
      aimYaw = yawOf(dir); aimPitch = clamp(pitchOf(dir), -T.aimPitchMax, T.aimPitchMax);
      if (snap) { rigYaw = aimYaw; rigPitch = aimPitch; }
      if (mv.carry) mv.aimSet = true;          // someone scripts the aim during a move: the camera stops carrying it
    },
    /** Read-only snapshot for tests and the debug overlay. */
    snapshot() {
      return {
        mode, viewMode, state: game.state, fov: +cam.fov.toFixed(2), zoom: +zoom.toFixed(2), armScale: +armScale.toFixed(3),
        aimYaw: +aimYaw.toFixed(4), aimPitch: +aimPitch.toFixed(4), rigYaw: +rigYaw.toFixed(4), freeYaw: +freeYaw.toFixed(4),
        freePitch: +freePitch.toFixed(4), freeW: +freeW.toFixed(3), roll: +pose.roll.toFixed(4),
        aimDir: aimDir.toArray().map((v) => +v.toFixed(4)), cam: cam.position.toArray().map((v) => +v.toFixed(2)),
        dragon: dragonPos.toArray().map((v) => +v.toFixed(2)), dragonFwd: dragonFwd.toArray().map((v) => +v.toFixed(4)),
        camDist: +cam.position.distanceTo(dragonPos).toFixed(2), locked: lockTarget?.name || null,
        pointerLocked: lockedNow, lockUnavailable, cinematic: cine?.name || null, photo: { ...photo },
        trauma: shakes.reduce((a, s) => Math.max(a, s.trauma), 0),
        orbitYaw: +orbitYaw.toFixed(4), menuPitch: +menu.pitch.toFixed(4), menuZoom: +menu.zoom.toFixed(3),
        menuHeld: menu.held, menuDragged: Math.round(menu.dragged), speedBlur: +blurS.toFixed(3),
        blurCenter: [+blurCenter.x.toFixed(3), +blurCenter.y.toFixed(3)],
        shadowFocus: shadowFocusSet ? shadowFocusSet.toArray().map((v) => +v.toFixed(1)) : null,
        seat: seatSource, grabHand,
        leadYaw: +leadYaw.toFixed(4), leadPitch: +leadPitch.toFixed(4), courseYaw: +courseYaw.toFixed(4),
        coursePitch: +coursePitch.toFixed(4), rigPitch: +rigPitch.toFixed(4),
        remainingYaw: +wrapAngle(aimYaw - courseYaw).toFixed(4), remainingPitch: +(aimPitch - coursePitch).toFixed(4),
        // Wave 4: lock-on aim assist (w 0..1, lean of the aim toward the target, angle mouse target ↔ target, total
        // sticky motion) and the hull (m pushed out of the dragon's hull last frame, photo lens distance).
        assist: { w: +assist.w.toFixed(3), leanYaw: +assist.oy.toFixed(4), leanPitch: +assist.op.toFixed(4),
          angDeg: +(assist.ang / DEG).toFixed(2), dist: +assist.dist.toFixed(1), stuckDeg: +(assist.stuck / DEG).toFixed(1),
          // the lock point's direction (lead included) and the flown aim's angle from it
          lockDir: assist.target && assist.has ? assist.dir.toArray().map((v) => +v.toFixed(4)) : null,
          aimErrDeg: assist.target && assist.has ? +(Math.acos(clamp(aimDir.dot(assist.dir), -1, 1)) / DEG).toFixed(2) : null },
        hullPush: +hullPush.toFixed(3), photoReach: +photoReach.toFixed(2), photoHull: { points: cloud.n, builds: cloud.builds },
        // Wave 5: early aim hook runs, dodge / breath / stagger weights, the titan sight-line orbit, the wing clearance.
        wave5: { earlyN, dodgeW: +dodgeW.toFixed(3), breathK: +breathK.toFixed(3), staggerK: +staggerK.toFixed(3), staggerKind,
          occYawDeg: +(occ.yaw / DEG).toFixed(1), occPitchDeg: +(occ.pitch / DEG).toFixed(1), occBlocked: occ.blocked, occFound: occ.found,
          occBlockedFrames: occ.blockedFrames, occSearched: occ.searched, wingExt: +wingExt.toFixed(2), wingPts: wingSet.n, wingTested },
        // Flight moves: the move seen, the aerobatic frame (weight, kind, lead of the feed-forward), the aim carry, the
        // skim / charge weights, the cut-in weight, the FOV / blur pops, counters.
        moves: { move: mv.name, side: mv.side, source: mv.src ?? null, skimOpen: +skimOpen.toFixed(2),
          aeroW: +aero.w.toFixed(3), aeroKind: aero.w > 0 ? aero.kind : null, aeroF: aero.F.toArray().map((v) => +v.toFixed(4)), aeroU: aero.U.toArray().map((v) => +v.toFixed(4)), aeroInverted: aero.inverted, aeroLeadDeg: +(aero.lead / DEG).toFixed(1), aeroInvSeen: aero.invSeen, aeroCatchUp: aero.catchUp, aeroRollErrDeg: +(aero.rollE / DEG).toFixed(1), aeroRollLambda: +aero.rollLam.toFixed(2),
          carry: mv.carry && !mv.aimSet, carryUserDeg: [+(mv.uy / DEG).toFixed(1), +(mv.up / DEG).toFixed(1)], armElevDeg: +(arm.elev / DEG).toFixed(2), armDist: +arm.dist.toFixed(2), viewBiasDeg: +(arm.vb / DEG).toFixed(2), rigPitchDeg: +(rigPitch / DEG).toFixed(2), skimK: +skimK.toFixed(3), chargeK: +chargeK.toFixed(3), cutW: +cutW.toFixed(3),
          fxFov: +fxFov.toFixed(2), fxBlur: +fxBlur.toFixed(3), blur: +blurOut.toFixed(3), inferno: mv.infOn, skyfall: mv.skyfall,
          lastNear: mv.lastNear, lastStart: mv.lastStart, counts: { ...mv.counts } },
        // Results framing (victory / defeat orbit): fitted / smoothed distance (m), Sora's box across the view (m), the
        // band (NDC y top / bottom; the bottom is the text block's top + a margin), the pivot's placement (tangent units).
        results: { dist: +res.dist.toFixed(2), fitDist: +res.D.toFixed(2), box: res.box ? res.box.map((v) => +v.toFixed(2)) : null,
          band: [+res.top.toFixed(3), +res.bot.toFixed(3)], textTop: +res.text.toFixed(3), tx: +res.tx.toFixed(4), ty: +res.ty.toFixed(4) },
        // Hover / aim: flight mode seen, hover share / blend weight / course override, the hover view (yaw, pitch, its
        // lead off the nose), arm, aim convergence (m, source), the reticle's angle from the screen centre, the magnet.
        hover: { mode: hv.mode, raw: +hoverRaw.toFixed(3), w: +hoverW.toFixed(3), c: +hoverC.toFixed(3),
          viewYawDeg: +(hv.yaw / DEG).toFixed(2), viewPitchDeg: +(hv.pitch / DEG).toFixed(2), leadDeg: +(hv.lead / DEG).toFixed(2),
          noseYawDeg: +(noseYaw / DEG).toFixed(2), armDist: +hvArmDist.toFixed(2), sideM: +hv.side.toFixed(2), elevDeg: +(hv.elev / DEG).toFixed(2),
          conv: +hv.conv.toFixed(1), convSrc: hv.convSrc,
          reticleDeg: +hv.reticleDeg.toFixed(3), throttle: Number.isFinite(player()?.throttle) ? +(+player().throttle).toFixed(2) : null,
          magnet: { w: +magnet.w.toFixed(3), leanDeg: +(Math.hypot(magnet.oy * Math.cos(aimPitch), magnet.op) / DEG).toFixed(2),
            angDeg: +(magnet.ang / DEG).toFixed(2), dist: +magnet.dist.toFixed(1), target: magnet.target?.name || null } },
      };
    },

    update(dt, realDt) {
      try { readInput(Math.min(0.1, Math.max(0, realDt || 0))); }
      catch (e) { if (failed++ < 3) console.error('[cameraRig] input failed', e); }
      lastReal = game.time.real;
    },
    lateUpdate(dt, realDt) {
      try { lateUpdate(dt, realDt); }
      catch (e) { if (failed++ < 3) console.error('[cameraRig] update failed', e); }
    },
  };
  // Early aim hook (Wave 5): its own tiny system so that it runs BEFORE the pilots in every fixed step (the rig itself
  // runs at order 80). Only the frame's first step does anything (earlyAim is guarded per rendered frame).
  try {
    if (typeof game.add === 'function' && !game.cameraAim) {
      game.add({
        name: 'cameraAim',
        fixedUpdate() {
          try { earlyAim(); } catch (e) { if (failed++ < 3) console.error('[cameraRig] early aim failed', e); }
        },
      }, T.earlyAimOrder);
    }
  } catch (e) { console.warn('[cameraRig] early aim hook not registered', e); }
  return rig;
}
