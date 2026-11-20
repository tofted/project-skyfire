// Touch controls (system 'touchUI', order 92 — after the HUD and the moves HUD). The touch layer only PRODUCES the
// inputs a keyboard and mouse produce; it never writes game state (docs/modules/touch.md):
//   virtual keys  game.input.press(code) / release(code), reference-counted per finger (a key two fingers hold is
//                 released when the last one lifts)
//   aim / look    game.input.mouse.dx / dy (the camera applies them exactly like pointer-locked mouse motion)
//   orbit         two fingers: virtual 'Mouse2' held (the camera's free look) + the centroid's motion as mouse dx / dy
//   zoom          pinch: game.input.wheel (the camera's exp(wheel · 0.0012) distance law, so a pinch scales it 1 : 1)
//
// CONTRACT — game.touchUI (this system; the other UI owners read it, nobody else writes it):
//   active                  boolean: the touch layout is on (body has class 'touch-mode' while it is)
//   setActive(on, reason)   flip it (reason is a short string); returns true when it changed
//   mode                    'auto' | 'touch' | 'desktop' — the policy in force (?touch=1/0 at boot, else Settings)
//   shown                   the overlay is up now (active && state 'play' && no cinematic)
//   el                      the overlay root (div.tch inside #ui, after the HUD)
//   buttons                 { fire, fireball, inferno, lock, boost, dodgeL, dodgeR } — their elements (no UP / DOWN: the
//                           stick climbs and descends — user change 28.09, "the joystick must replace them")
//   stick                   { x, y (−1..1, right / up +), defl (0..1), ang (deg, up 90), sector, keys: Set of the codes
//                             the stick holds now, active, cx, cy (base centre, CSS px), el (the base element),
//                             centreSeen / visited (the dead zone / the sectors passed since the last frame start) }
//   pilot                   read-only: { held, vUp, vDown, diveArmed, takeoff, moves, deferred, slack, log, arms } —
//                             what the stick logic did (tests)
//   layout                  { w, h, vmin, stick: { cx, cy, r, zone }, buttons: { id: { x, y, d } }, cluster } (CSS px)
//   releaseAll(reason)      lift every control a finger holds now (no stuck keys, no stuck breath)
//   fingers                 [{ id, role }] live (tests), stats { flips, fingersMax, presses, log }
// Event: game.events.emit('touchmode', { active, reason }) on every flip (and once at init, reason 'boot').
// Activation: ?touch=1 / ?touch=0 at boot; else game.settings.controls 'touch' | 'desktop' | 'auto' (default auto);
// auto = on when (pointer: coarse) at boot, or from the first real touch anywhere (a TV with a mouse), and off again
// from a real mouse press on the game view in play (the mirror rule, fix round 1: a TV with a mouse could not aim with
// the mouse again after one touch). A Settings change of 'controls' wins over the URL from then on. Reads
// game.settings.touchSensitivity (1), touchButtonSize ('xs' | 's' | 'm' | 'l', 'm'), leftHanded (false), touchLayout
// ('corners' | 'compact', 'corners'), screenMargin (0..5 %, 0) with fallbacks and follows the 'settings' event.
// Performance: the DOM is built once; layout is computed on resize / settings only (no layout reads); per frame only
// transforms, class toggles and ring offsets are written, and only when a value changed.
//
// THE STICK (integration 28.09, the user: "remove the UP and DOWN buttons — the joystick must replace them"). Pointer
// events only move the stick; its keys are applied at the start of every frame (input.beforeFrame, the frame clock
// game.time.real that the pilot's key reader uses), so the rules below see exactly the timing the game sees:
//   sectors         8 × 45° (dead zone, hysteresis): up W, down S, left A, right D, diagonals two keys
//   vertical        the stick pushed within TOUCH.vertical.cone of straight up adds, from the LOOK pitch
//                   (cameraRig.targetDir): steeply up → Space (hover: rise; flight: a power wingbeat), steeply down →
//                   Ctrl (hover: sink; flight: tuck and dive → SKYFALL on the pull-up). In the hover the steep look
//                   holds Space / Ctrl WITHOUT W first (a straight rise / sink); a full push held 0.6 s adds W (she
//                   takes off toward the look); level → W (fly forward). In flight W stays (the pilot steers toward the
//                   aim: look up + push climbs, look down + push descends); the flight dive needs the tuck angle and a
//                   look the player's own input put there (not the lock assist, not a move's aim carry).
//   moves (flight)  double flicks: left–centre–left / right–centre–right → A / D + Space in one frame = the
//                   keyboard's wingover chord; down–centre–down → S + Space = the Immelmann; up–centre–up → two
//                   one-frame W taps = the keyboard's W W dash (all with the same human timing windows, + one frame
//                   of slack). A push to the side and back to up is a turn, a pull down and forward again is a brake,
//                   "turn, straighten, turn again" is steering (a push another way between the flicks cancels the
//                   pair) — never a move. Centre passes and sectors are latched from the pointer events.
//   guards          the stick never makes a chord or a double tap by accident: Space waits until A / D / S has been
//                   held TOUCH.guard.lead s, A / D / S wait TOUCH.guard.lag s after a Space, a 2nd A / D press waits
//                   TOUCH.guard.tap s (the A A dodge), a 2nd W waits TOUCH.guard.wGap s unless it is the dash flick.
// Physics / pilot code is untouched: only the keys the touch layer holds are chosen here (player.js MOVE_KEYS rules).
import { h, s, classSetter, styleSetter } from './dom.js';
import { tr, lang, bindText, onLang } from './i18n.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
/** a − b in degrees, wrapped to −180..180. */
const angDiff = (a, b) => ((((a - b) % 360) + 540) % 360) - 180;

/** Tuning (exported for tests and docs). Sizes are [min px, vmin, max px]: the same proportions at 1080p and 4K. */
export const TOUCH = {
  stick: {
    zoneX: 0.40, zoneTop: 0.20,      // the stick zone: the left 40 % of the screen below the top 20 %
    r: [56, 10.5, 300],              // base radius
    dead: 0.28, deadOut: 0.18,       // dead zone (× r): a direction starts past `dead`, ends inside `deadOut`
    hyst: 10,                        // deg: a sector is kept until the thumb is this far into the next one
  },
  aim: {
    perHeight: 400,                  // deg the view turns for a drag across the full screen height (touchSensitivity 1)
    slop: 2.2,                       // vmin a finger on FIRE / FIREBALL travels before its drag also aims
    // controls update ("very hard to aim whilst flying"): the drag's gain follows the thumb's speed — a slow drag
    // (≤ v[0] screen heights / s) turns the view lo × perHeight, a flick (≥ v[1]) hi × perHeight, smoothly between:
    // fine aim on a target and fast turns from the same thumb. on: false = the old straight 1 : 1 drag.
    curve: { on: true, lo: 0.5, hi: 1.3, v: [0.12, 1.4] },
    // … and the drag reaches the camera through a short low-pass (time constant, s; 0 = off): touch events do not
    // arrive in step with the frames (none in one frame, two in the next), which made the view judder at 60 fps
    smooth: 0.022,
  },
  gesture: { orbit: 1.6, pinch: 2.0, dominance: 0.6 },   // vmin of centroid travel / of spread before either engages
  // the look pitch (deg) that adds Space / Ctrl to a stick pushed within `cone` deg of straight up: on at [0], off at
  // [1] (hysteresis). In the hover a steep look + a push is first a straight rise / sink (W let go: measured 28.09,
  // +16.8 m in 2.5 s with 1.2 m drift; with W from the start she drifted 36 m forward and sank only 8.7 m instead of
  // 12.9 m); a FULL push (deflection ≥ takeoff.defl) held takeoff.after s adds W: she takes off toward the look, as the
  // keyboard's W at that look does (fix round 1: "pushing at an enemy above never flew toward it").
  // In flight the dive (Ctrl: the committed tuck toward −55° → SKYFALL) needs the tuck angle itself (dive[0] on, dive[1]
  // off) AND a look the player's own drag took there (`own`: the step that crosses dive[0] must be ≥ share of the
  // player's own downward drag, ≥ min deg — the lock assist or a move's aim carry moving the look does not arm it; fix
  // round 1, the dogfight review: 12–16 dives in 3 min, all from looks the camera moved, or from −42..−50° while aiming
  // at a target slightly below — in flight W at such a look already descends toward it).
  // afterMove: s after a wingover / loop ends (and while it runs) in which flight adds no Space / Ctrl.
  vertical: { cone: 35, up: [30, 22], down: [-34, -26], dive: [-55, -46], takeoff: { defl: 0.92, after: 0.6 }, afterMove: 1.0,
    own: { share: 0.5, min: 0.15, rate: 0.02 } },
  // stick moves in flight (fix round 1 — the review measured the old "hard to the side, then swung up" firing on 6 of 6
  // ordinary rim returns and 2 of 2 fast centre returns: the documented turn / brake ARE its first half, and no timing
  // separates them). gesture 'flick': a double flick, the dash's proven windows — side–centre–side = wingover that way,
  // down–centre–down = Immelmann: the 1st push stays in its sector ≤ flick s (peak deflection ≥ defl), the stick goes
  // back through the dead zone (or the thumb lifts), the 2nd push enters the same sector ≤ gap s later → the key +
  // Space pressed in one frame (the keyboard's chord). gesture 'swing' (the earlier rule, kept for a revert): a hard
  // push (≥ hard) held dwell[0]..dwell[1] s, then up (≥ upDefl, within upCone of straight up) ≤ swing s later.
  // cancel: a push another way between the two flicks (up, the other side; not the flick's own neighbouring diagonals)
  // ends the pair — "turn left, straighten, turn left again" is steering (fix round 1, 29.09).
  moves: { gesture: 'flick', flick: 0.40, gap: 0.36, defl: 0.6, cancel: true,
    hard: 0.8, dwell: [0.15, 1.2], swing: 0.35, upDefl: 0.5, upCone: 25, keyHold: 0.1, cooldown: 0.6 },
  // dash: a W push ≤ flick s (peak deflection ≥ defl), back through the centre, pushed again ≤ gap s later → two
  // one-frame W taps; the stick's own W then waits holdOff s (the dash flies on meanwhile)
  // (measured on the frame clock, CDP touch: scripted 130 / 110 ms … 260 / 230 ms flick / gap arrive as up to 0.35 /
  // 0.333 s; a deliberate second push in the hover after a 0.5 s push and a 0.45 s pause never qualifies)
  dash: { flick: 0.40, gap: 0.36, defl: 0.6, holdOff: 0.22 },
  // the flick / gap windows of the dash and the moves get one frame of slack (the smoothed frame time, ≤ slackMax s):
  // every edge is seen at the next frame start, so a measured push is up to a frame longer than the thumb's (fix round
  // 1: at 3840×2160 the headless GPU ran 32–36 fps, and the 130 / 110 ms double flicks measured 0.400 / 0.200 s)
  slackMax: 0.05,
  // chord / double-tap guards (s), a little wider than player.js MOVE_KEYS (chord lead 0.2, lag 0.12, doubleTap 0.28,
  // dash gap 0.2)
  guard: { lead: 0.25, lag: 0.15, tap: 0.3, wGap: 0.21 },
  fire: [96, 17, 440],               // FIRE diameter (≥ 12 % of the screen height)
  btn: [64, 10.5, 280],              // every other button (≥ 8 %, never below 64 px)
  gap: 2.2, margin: 3.2,             // vmin
  // Button size setting (touchButtonSize). xs (big screens, fix round 1): the smallest that still keeps FIRE ≥ 12 % and
  // the others ≥ 8 % of the height (0.77 × 10.5 vmin = 8.1 %).
  size: { xs: 0.77, s: 0.86, m: 1, l: 1.18 },
  // Layout setting (touchLayout): 'corners' (default: FIRE in the bottom-right corner, the stick bottom-left — the same
  // proportions at every size) | 'compact' (big screens, fix round 1 — an 86" TV put 1.6 m between the hands): FIRE's
  // centre and the stick's rest spot at these fractions of the screen, the stick zone widened to `zone` of the width.
  compact: { fire: [0.76, 0.84], stick: [0.22, 0.84], zone: 0.5 },
  // Screen margin setting (screenMargin, 0..5 % of each side: TVs that overscan HDMI): added to the edge margins.
  safeMax: 5,
  sens: [0.2, 4],                    // touchSensitivity clamp
  compatMs: 700,                     // (input.js) mouse events this soon after a touch are the browser's compat copies
};

// Angles (deg, counter-clockwise from +x, around the FIRE button; right-handed layout). Inner ring: the weapons
// (FIREBALL left of FIRE, INFERNO on the diagonal, LOCK above); outer ring: BOOST, DODGE ◀, DODGE ▶ — one even arc from
// the left to the top, ◀ left of ▶.
const INNER = [['fireball', 184], ['inferno', 137], ['lock', 90]];
const OUTER = [['boost', 164], ['dodgeL', 126], ['dodgeR', 88]];

/** The buttons: each one is a key (held while the finger is down), exactly the key the keyboard uses. (label: English —
 *  the screen shows tr(label) (languages, 29.09: Russian in src/ui/i18n/ru-hud.js); aria: the id, read in the language too) */
export const BUTTONS = [
  { id: 'fire', code: 'Mouse0', label: 'FIRE', icon: 'flame', big: true, drag: true },
  { id: 'fireball', code: 'KeyF', label: 'FIREBALL', icon: 'orb', drag: true },
  { id: 'inferno', code: 'KeyR', label: 'INFERNO', icon: 'inferno' },
  { id: 'lock', code: 'Tab', label: 'LOCK', icon: 'lock' },
  { id: 'boost', code: 'ShiftLeft', label: 'BOOST', icon: 'boost' },
  { id: 'dodgeL', code: 'KeyQ', label: 'DODGE', icon: 'dodgeL' },
  { id: 'dodgeR', code: 'KeyE', label: 'DODGE', icon: 'dodgeR' },
];

/** A button label in the current language (literal keys; the per-frame ones are tr() where they are written). */
const labelText = (en) => (en === 'LOCK' ? tr('LOCK') : en === 'BOOST' ? tr('BOOST') : en === 'DODGE' ? tr('DODGE') : en === 'FIRE' ? tr('FIRE')
  : en === 'FIREBALL' ? tr('FIREBALL') : en === 'INFERNO' ? tr('INFERNO') : tr(en));
// Stick sectors (0 = right, counter-clockwise, 45° each): the held keys. Diagonals hold two keys.
const SECTOR_KEYS = [['KeyD'], ['KeyW', 'KeyD'], ['KeyW'], ['KeyW', 'KeyA'], ['KeyA'], ['KeyS', 'KeyA'], ['KeyS'], ['KeyS', 'KeyD']];
// Targets that belong to another UI owner (menus, the pause / fullscreen buttons): their taps stay clicks.
const CONTROLS = 'button, input, select, textarea, a, label, [role="button"], [role="slider"], .panel, .menu';
const MENU_STATES = new Set(['title', 'victory', 'defeat', 'photo']);
// Settings that move the buttons / the stick (relayout on their 'settings' event)
const LAYOUT_KEYS = new Set(['touchButtonSize', 'leftHanded', 'touchLayout', 'screenMargin']);

const ICONS = {
  flame: [['path', { d: 'M12 2.6c.7 3.3 5 5.4 5 10.1a5 5 0 0 1-10 0c0-2.3 1.1-3.9 2.4-5-.1 1.9.6 3.1 1.8 3.6-.7-3.2.2-6.1.8-8.7z', fill: 'currentColor' }]],
  orb: [['circle', { cx: 14.6, cy: 9.4, r: 5.2, fill: 'currentColor' }], ['path', { d: 'M3.5 20.5l6.4-6.4M3.8 15.6l3.6-3.6M8.4 20.2l3.6-3.6', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' }]],
  bolt: [['path', { d: 'M13.4 2 4.6 13.6h6.1L9.6 22l9.8-12.2h-6.2z', fill: 'currentColor' }]],
  inferno: [['path', { d: 'M12 1.8c.9 3.6 6.1 6.2 6.1 11.6a6.1 6.1 0 0 1-12.2 0c0-2.8 1.4-4.7 3-6-.2 2.3.7 3.8 2.2 4.4-.8-3.9.3-7.4.9-10z', fill: 'currentColor' }],
    ['path', { d: 'M12 12.6c.4 1.6 2.6 2.7 2.6 4.9a2.6 2.6 0 0 1-5.2 0c0-1.2.6-2 1.3-2.6 0 1 .3 1.6.9 1.9-.3-1.7.1-3.1.4-4.2z', fill: '#fff8ec' }]],
  lock: [['path', { d: 'M3.5 9V3.5H9M15 3.5h5.5V9M20.5 15v5.5H15M9 20.5H3.5V15', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }],
    ['circle', { cx: 12, cy: 12, r: 2.6, fill: 'currentColor' }]],
  boost: [['path', { d: 'M4 6l6 6-6 6M11.5 6l6 6-6 6', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]],
  dodgeL: [['path', { d: 'M9.5 6.5 4 12l5.5 5.5M4.5 12h9.5a5.5 5.5 0 0 1 5.5 5.5', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]],
  dodgeR: [['path', { d: 'M14.5 6.5 20 12l-5.5 5.5M19.5 12H10a5.5 5.5 0 0 0-5.5 5.5', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }]],
};
function icon(name) {
  return s('svg.tb-ic', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, ...(ICONS[name] || []).map(([tag, attrs]) => s(tag, attrs)));
}

/** (pointer: coarse) at boot — the rule the HUD used before (a coarse pointer, or touch points and no fine pointer). */
export function coarsePointer() {
  try {
    if (typeof matchMedia !== 'function') return false;
    return matchMedia('(pointer: coarse)').matches || ((navigator.maxTouchPoints || 0) > 0 && !matchMedia('(pointer: fine)').matches);
  } catch { return false; }
}

/** The stick's sector machine (pure; exported for the node test): dx, dy in px (screen, y down), r the base radius,
 *  prev the current sector (−1 = centre). Returns the new sector. */
export function stickSector(dx, dy, r, prev = -1, T = TOUCH.stick) {
  const d = Math.hypot(dx, dy) / Math.max(1, r);
  if (prev < 0 ? d < T.dead : d < T.deadOut) return -1;
  const ang = Math.atan2(-dy, dx) * 180 / Math.PI;           // up = +90°
  const want = ((Math.round(ang / 45) % 8) + 8) % 8;
  if (prev < 0 || want === prev) return want;
  let off = ang - prev * 45;
  off = ((off + 540) % 360) - 180;                             // −180..180 from the current sector's centre
  return Math.abs(off) <= 22.5 + T.hyst ? prev : want;
}
export const sectorKeys = (k) => (k >= 0 ? SECTOR_KEYS[k] : []);
const W_SECTORS = new Set([1, 2, 3]);                   // the sectors that hold W (up-right, up, up-left)

export default function createTouchUI(game) {
  const input = game.input;
  const warned = new Set();
  const warnOnce = (k, e) => { if (!warned.has(k)) { warned.add(k); console.warn('[touchUI] ' + k + ' failed', e); } };
  const nowMs = () => performance.now();

  // ---------------------------------------------------------------------------------------------- policy
  const param = game.params?.get?.('touch');
  let urlForce = param === '1' ? 'touch' : param === '0' ? 'desktop' : null;    // wins at boot, until Settings changes
  const coarseAtBoot = coarsePointer();
  // Auto's wish: the last real input kind decides (a coarse pointer at boot, then the first touch → on; a real mouse
  // press on the game view in play → off; the next touch → on again)
  let autoWant = coarseAtBoot;
  const setting = (k, d) => { try { const v = game.settings?.[k]; return v === undefined || v === null ? d : v; } catch { return d; } };
  const policy = () => {
    if (urlForce) return urlForce;
    const v = setting('controls', 'auto');
    return v === 'touch' || v === 'desktop' ? v : 'auto';
  };
  let active = false;
  let root = null, stickEl = null, baseEl = null, knobEl = null;
  const btn = {};          // id -> { def, el, inner, ring, arc, lb, pips, set* }
  const layout = { w: 0, h: 0, vmin: 0, stick: null, buttons: {}, cluster: null, left: false, size: 'm' };
  const stats = { flips: 0, fingersMax: 0, presses: {}, log: [], cancels: 0, released: 0 };
  const logEv = (o) => { stats.log.push({ t: +(nowMs() / 1000).toFixed(3), ...o }); if (stats.log.length > 60) stats.log.shift(); };

  // ---------------------------------------------------------------------------------------------- held codes
  const owners = new Map();      // code -> Set(owner)
  function hold(code, who) {
    let set = owners.get(code);
    if (!set) owners.set(code, (set = new Set()));
    if (set.has(who)) return;
    set.add(who);
    if (set.size === 1) {
      try { input?.press?.(code); } catch (e) { warnOnce('press', e); }
      stats.presses[code] = (stats.presses[code] || 0) + 1;
    }
  }
  function unhold(code, who) {
    const set = owners.get(code);
    if (!set || !set.delete(who)) return;
    if (set.size === 0) {
      owners.delete(code);
      try { input?.release?.(code); } catch (e) { warnOnce('release', e); }
    }
  }
  function unholdAll(who) { for (const [code, set] of [...owners]) if (set.has(who)) unhold(code, who); }

  // ---------------------------------------------------------------------------------------------- aim
  /** CSS px of finger travel -> mouse px: the view turns TOUCH.aim.perHeight° for a drag over the full screen height,
   *  × touchSensitivity, independent of the mouse sensitivity (the camera multiplies it back in). */
  function aimGain() {
    const H = Math.max(200, layout.h || innerHeight || 1080);
    const rig = game.cameraRig;
    const sens = num(rig?.tuning?.sens, 0.0021);
    const camSens = clamp(num(rig?.settings?.sensitivity, num(setting('mouseSensitivity', 1), 1)), 0.1, 5);
    const ts = clamp(num(setting('touchSensitivity', 1), 1), TOUCH.sens[0], TOUCH.sens[1]);
    return (TOUCH.aim.perHeight * Math.PI / 180) / H / (sens * camSens) * ts;
  }
  /** look = false: a two-finger orbit (Mouse2 held: the camera's free look moves, not the look / aim). */
  function addAim(dx, dy, look = true) {
    if (!input?.mouse || !(dx || dy)) return;
    // (controls update) the response curve: the gain follows the thumb's speed (smoothed over the last events)
    let k = 1;
    const C = TOUCH.aim.curve;
    if (C && C.on !== false) {
      const H = Math.max(200, layout.h || innerHeight || 1080);
      const t = nowMs(), dtE = clamp((t - aimPend.t) / 1000, 1 / 240, 0.05);
      aimPend.t = t;
      const v = Math.hypot(dx, dy) / H / dtE;                              // screen heights per second
      aimPend.v += (v - aimPend.v) * 0.5;
      const u = clamp((aimPend.v - C.v[0]) / Math.max(1e-3, C.v[1] - C.v[0]), 0, 1);
      k = C.lo + (C.hi - C.lo) * u * u * (3 - 2 * u);
    }
    aimStats.k = k;
    const g = aimGain() * k;
    aimStats.px += Math.hypot(dx, dy);
    if (hooked && TOUCH.aim.smooth > 0) {
      // … and it reaches the camera through flushAim(), a little of it every frame
      aimPend.x += dx * g; aimPend.y += dy * g;
      if (look) aimPend.ly += dy * g;
      return;
    }
    input.mouse.dx += dx * g; input.mouse.dy += dy * g;
    if (look) ownLook(dy * g);
  }
  /** How far a look drag (mouse px, as the camera gets it) moves the look DOWN (deg; the camera: aimPitch −= mouse dy ·
   *  sens · sensitivity · invert-Y): the flight dive's own-look test (vertical.own). */
  function ownLook(dyMouse) {
    if (!dyMouse) return;
    const rig = game.cameraRig;
    const sens = num(rig?.tuning?.sens, 0.0021);
    const camSens = clamp(num(rig?.settings?.sensitivity, num(setting('mouseSensitivity', 1), 1)), 0.1, 5);
    const down = dyMouse * sens * camSens * (180 / Math.PI) * (rig?.settings?.invertY ? -1 : 1);
    if (down > 0) PK.ownPend += down;
  }
  /** (controls update) Once per frame, first thing: the share of the pending drag that reaches the camera now. */
  function flushAim(dt) {
    if (!input?.mouse || !(aimPend.x || aimPend.y)) return;
    const tau = TOUCH.aim.smooth;
    let a = tau > 0 ? 1 - Math.exp(-clamp(dt, 1 / 240, 0.1) / tau) : 1;
    if (Math.abs(aimPend.x) + Math.abs(aimPend.y) < 0.4) a = 1;            // the tail: all of it, the view comes to rest
    const ox = aimPend.x * a, oy = aimPend.y * a, ol = aimPend.ly * a;
    aimPend.x -= ox; aimPend.y -= oy; aimPend.ly -= ol;
    input.mouse.dx += ox; input.mouse.dy += oy;
    ownLook(ol);
  }
  const aimPend = { x: 0, y: 0, ly: 0, v: 0, t: 0 };
  const aimStats = { px: 0, k: 1 };
  function addWheel(v) { if (input && Number.isFinite(v)) { input.wheel += v; aimStats.wheel = (aimStats.wheel || 0) + v; } }

  // ---------------------------------------------------------------------------------------------- fingers
  const fingers = new Map();     // pointerId -> finger
  const stick = { x: 0, y: 0, defl: 0, ang: 0, keys: new Set(), active: false, id: -1, cx: 0, cy: 0, sector: -1, kx: 0, ky: 0, centreSeen: false, visited: 0 };
  let gesture = null;            // { a, b, cx0, cy0, d0, cx, cy, d, orbit, zoom, free }
  let lastTouchAt = -1e9;

  const inZone = (x, y) => {
    const z = layout.stick?.zone;
    return !!z && x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1;
  };
  const isForeign = (t) => !!t && t !== game.canvas && !(root && root.contains(t)) && !!t.closest?.(CONTROLS);

  function onDown(e) {
    if (e.pointerType !== 'touch' || !e.isTrusted) return;
    lastTouchAt = nowMs();
    autoWant = true;
    if (!active && policy() === 'auto') setActive(true, 'touch');
    if (!active) return;
    refreshShown();
    const st = game.state, cine = !!game.cameraRig?.cinematic;
    const t = e.target;
    const f = { id: e.pointerId, role: 'none', x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: nowMs(), btn: null, aiming: false };
    if (isForeign(t)) { f.role = 'foreign'; fingers.set(f.id, f); return; }      // a menu / pause / fullscreen tap
    if (st === 'play' && cine) {
      f.role = 'cine'; hold('Enter', f);                                          // a tap skips a skippable cinematic
    } else if (st === 'play' && shown) {
      const b = t?.closest?.('[data-tb]');
      const B = b && btn[b.dataset.tb];
      if (B) {
        f.role = 'btn'; f.btn = B; B.fingers.add(f.id);
        hold(B.def.code, f); B.setDown(true);
        if (e.cancelable) e.preventDefault();
      } else if (!stick.active && inZone(f.x, f.y)) {
        f.role = 'stick'; stickStart(f);
      } else {
        const other = [...fingers.values()].find((o) => o.role === 'aim');
        if (other && !gesture) startGesture(other, f, true);
        else if (gesture) f.role = 'extra';
        else f.role = 'aim';
      }
    } else if (MENU_STATES.has(st)) {
      const other = [...fingers.values()].find((o) => o.role === 'menu');
      if (other && !gesture) startGesture(other, f, false);
      else f.role = gesture ? 'extra' : 'menu';
    } else f.role = 'idle';
    fingers.set(f.id, f);
    stats.fingersMax = Math.max(stats.fingersMax, [...fingers.values()].filter((o) => o.role !== 'foreign').length);
  }

  function onMove(e) {
    if (e.pointerType !== 'touch') return;
    const f = fingers.get(e.pointerId);
    if (!f) return;
    lastTouchAt = nowMs();
    const x = e.clientX, y = e.clientY, dx = x - f.x, dy = y - f.y;
    f.x = x; f.y = y;
    if (!(dx || dy)) return;
    switch (f.role) {
      case 'stick': stickMove(f); break;
      case 'aim': case 'menu': addAim(dx, dy); break;
      case 'btn':
        if (!f.btn?.def.drag) break;
        if (f.aiming) addAim(dx, dy);
        else if (Math.hypot(x - f.x0, y - f.y0) > TOUCH.aim.slop * layout.vmin) {
          // past the slop the drag also aims — from where the finger landed, so the view follows it 1 : 1 (fix round 1:
          // the slop was thrown away, a 140 px drag from FIRE turned 40.7° instead of 51.9°)
          f.aiming = true;
          addAim(x - f.x0, y - f.y0);
        }
        break;
      case 'gesture': gestureMove(); break;
      default: break;
    }
  }

  function onUp(e) {
    if (e.pointerType !== 'touch') return;
    lastTouchAt = nowMs();
    const f = fingers.get(e.pointerId);
    if (!f) return;
    if (e.type === 'pointercancel') { stats.cancels++; logEv({ ev: 'cancel', role: f.role }); }
    endFinger(f, true);
  }

  /** A finger lifts (or is cancelled / released by the game): everything it held goes up. */
  function endFinger(f, handOver) {
    fingers.delete(f.id);
    switch (f.role) {
      case 'stick': stickEnd(); break;
      case 'btn':
        unhold(f.btn.def.code, f);
        f.btn.fingers.delete(f.id);
        if (f.btn.fingers.size === 0) f.btn.setDown(false);
        break;
      case 'cine': unhold('Enter', f); break;
      case 'gesture': endGesture(f, handOver); break;
      default: break;
    }
    unholdAll(f);                  // (belt and braces: nothing this finger owned survives it)
  }

  // ---- stick (pointer events: geometry only; the keys follow in pilotFrame() at the start of the next frame)
  function stickStart(f) {
    stick.active = true; stick.id = f.id;
    stick.cx = f.x; stick.cy = f.y; stick.kx = 0; stick.ky = 0; stick.sector = -1;
    stick.x = 0; stick.y = 0; stick.defl = 0; stick.ang = 0;
  }
  function stickMove(f) {
    const r = layout.stick?.r || 100;
    let dx = f.x - stick.cx, dy = f.y - stick.cy;
    const d = Math.hypot(dx, dy);
    if (d > r) {                       // the base follows the thumb (a reversal never needs more than 2 r)
      const k = (d - r) / d;
      stick.cx += dx * k; stick.cy += dy * k;
      dx = f.x - stick.cx; dy = f.y - stick.cy;
    }
    stick.kx = dx; stick.ky = dy;
    stick.x = clamp(dx / r, -1, 1); stick.y = clamp(-dy / r, -1, 1);
    stick.defl = clamp(Math.hypot(dx, dy) / r, 0, 1);
    if (dx || dy) stick.ang = Math.atan2(-dy, dx) * 180 / Math.PI;
    stick.sector = stickSector(dx, dy, r, stick.sector);
    if (stick.sector < 0) stick.centreSeen = true; else stick.visited |= 1 << stick.sector;
    if (!hooked) pilotFrame();
  }
  function stickEnd() {
    stick.active = false; stick.id = -1; stick.x = 0; stick.y = 0; stick.kx = 0; stick.ky = 0; stick.sector = -1; stick.defl = 0;
    if (!hooked) pilotFrame();
  }

  // ---- the stick's keys, once per frame on the frame clock (see the header: sectors, vertical, moves, guards)
  let hooked = false;                                       // pilotFrame runs from input.beforeFrame
  const PK = {
    held: new Set(),            // codes the stick holds (owner 'stick')
    pressAt: {},                // frame time of the stick's (or a move's) last press, per code
    spaceAt: -1e9,              // the last Space press edge the touch layer made
    holdOffW: -1e9,             // after a dash the stick's W waits until then
    vUp: false, vDown: false,   // the look-pitch Space / Ctrl, with hysteresis
    fullSince: -1, takeoff: false,   // hover: since when the push is full (vertical.takeoff), and W added for it
    wasFlying: false,           // the flight state last frame (hover → flight: the dive arms afresh)
    // look ownership (vertical.own): the flight dive arms only from a look the player's own drag moved down —
    // ownPend: the downward look (deg) of the drags since this frame started; ownStash: last frame's (the camera applied
    // it in that frame, so this frame's pitch change shows it)
    prevPitch: null, ownPend: 0, ownStash: 0, diveArmed: false,
    moveEvAt: -1e9, moveBusy: false,  // the player's last wingover / loop start / end (a 'move' event), one running
    fl: null,                   // gesture 'flick': { key, since, end, peak, centre, used } the current / last side / down push
    hard: null,                 // gesture 'swing': { key, since }: a hard left / right / down push now
    lastHard: null,             // gesture 'swing': { key, dwell, endAt }: the last one, while its swing window is open
    wasUp: false,               // gesture 'swing': the stick was "up" (moves.upDefl / upCone) last frame
    moveAt: -1e9,               // the last stick move (wingover / loop / dash)
    wSeg: null,                 // the stick's last W push: { down, up, peak, centre, checked, used }
    pending: [],                // [{ frames, fn }]: the next frames of a synthetic key sequence
    timed: [],                  // [{ code, until }]: a move's keys (owner 'move'), lifted after moves.keyHold
    deferred: {},               // code -> presses a guard held back (count of episodes)
    deferring: new Set(),
    moves: { wingover: 0, loop: 0, dash: 0 },
    lastNow: -1, dtAvg: 1 / 60,   // the frame clock's smoothed step (the windows' one-frame slack)
    log: [], arms: [],
  };
  const frameNow = () => num(game.time?.real, performance.now() / 1000);
  const slack = () => clamp(PK.dtAvg, 0, TOUCH.slackMax);
  const pilotLog = (o) => {
    const e = { t: +frameNow().toFixed(3), rt: Math.round(performance.now()), ...o };
    PK.log.push(e); if (PK.log.length > 40) PK.log.shift();
    if (o.ev === 'arm') { PK.arms.push(e); if (PK.arms.length > 40) PK.arms.shift(); }
  };
  /** The look pitch in degrees (the camera's world target: where the player looks), null without a rig. */
  function lookPitch() {
    const d = game.cameraRig?.targetDir;
    if (!d || !Number.isFinite(d.y)) return null;
    return Math.asin(clamp(d.y, -1, 1)) * 180 / Math.PI;
  }
  /** Flight (the pilot's forward-flight branch) vs the hover, from what the player publishes (read-only). */
  function flightState() {
    const p = game.player;
    const fm = p?.flightMode;
    let V = 0;
    try { V = p?.vel?.length?.() ?? 0; } catch { V = 0; }
    const flying = fm === 'flight' || (fm === 'transition' && V > 24);
    return { flying, fm, V };
  }
  /** A press edge this frame whatever holds the code now (a move's chord key): owner 'move', lifted after `dur` s. */
  function pulse(code, now, dur) {
    try { if (input.virtual?.has(code)) input.release(code); input.press(code); } catch (e) { warnOnce('pulse', e); }
    let set = owners.get(code);
    if (!set) owners.set(code, (set = new Set()));
    set.add('move');
    PK.timed.push({ code, until: now + dur });
    PK.pressAt[code] = now;
    if (code === 'Space') PK.spaceAt = now;
  }
  /** A one-frame tap (press + release in this frame: the key reader sees both edges, in that order). */
  function tapKey(code) {
    try { if (!input.virtual?.has(code) && !input.down?.(code)) { input.press(code); input.release(code); } } catch (e) { warnOnce('tap', e); }
  }
  function releaseStick(now = frameNow()) {
    for (const c of [...PK.held]) { PK.held.delete(c); unhold(c, 'stick'); if (c === 'KeyW' && PK.wSeg && PK.wSeg.up < 0) { PK.wSeg.up = now; PK.wSeg.centre = true; } }
    stick.keys.clear();
    PK.vUp = PK.vDown = false; PK.hard = null; PK.lastHard = null; PK.wasUp = false; PK.fullSince = -1; PK.takeoff = false;
    if (PK.fl && PK.fl.end < 0) PK.fl.end = now;
    if (PK.fl) PK.fl.centre = true;                          // (the thumb lifted: as good as the centre, like the dash)
  }
  /** The stick's held keys may change now? (the chord / double-tap guards) */
  function mayPress(c, now) {
    const G = TOUCH.guard;
    if (c === 'KeyA' || c === 'KeyD' || c === 'KeyS') {
      if (now - PK.spaceAt < G.lag) return false;                                   // Space + A / D / S "after"
      if (c !== 'KeyS' && now - (PK.pressAt[c] ?? -1e9) < G.tap) return false;       // A A / D D: the dodge
      return true;
    }
    if (c === 'Space') {                                                              // A / D / S + Space "before"
      for (const k of ['KeyA', 'KeyD', 'KeyS']) if ((input.down?.(k)) && now - (PK.pressAt[k] ?? -1e9) < G.lead) return false;
      return true;
    }
    return true;
  }
  /** The W push that ends here was the first flick of up–centre–up? (checked once, when the stick wants W again) */
  function dashFlick(now) {
    const s = PK.wSeg, D = TOUCH.dash;
    if (!s || s.up < 0 || s.checked || s.used) return false;
    s.checked = true;
    const sl = slack();
    const ok = s.up - s.down <= D.flick + sl && now - s.up <= D.gap + sl && s.peak >= D.defl && s.centre;
    if (!ok && s.up - s.down < 0.8 && now - s.up < 0.8) pilotLog({ ev: 'no-dash', flick: +(s.up - s.down).toFixed(3), gap: +(now - s.up).toFixed(3), peak: +s.peak.toFixed(2), centre: s.centre });
    return ok;
  }
  function emitDash(now) {
    tapKey('KeyW');
    PK.pending.push({ frames: 1, fn: () => tapKey('KeyW') });
    PK.holdOffW = now + TOUCH.dash.holdOff;
    PK.moveAt = now; PK.moves.dash++; PK.wSeg = null;
    PK.pressAt.KeyW = now;
    pilotLog({ ev: 'dash' });
  }
  const MOVE_OF = (key) => (key === 'KeyS' ? { name: 'loop', key } : { name: 'wingover', key });
  const FLICK_SECTOR = { KeyA: 4, KeyD: 0, KeyS: 6 };
  /** Stick moves in flight, gesture 'flick' (the default): a double flick to the left / right / down — the 1st push
   *  stays in its sector ≤ moves.flick s with a peak ≥ moves.defl, the stick goes back through the dead zone (or the
   *  thumb lifts), the 2nd push enters the same sector ≤ moves.gap s after the 1st left it → { name, key } (once; a
   *  3rd flick starts over). Diagonals are never a move (a push that wanders into a diagonal ends the flick). */
  function moveFlick(now, live, flying) {
    const M = TOUCH.moves;
    const sec = live ? stick.sector : -1;
    const key = sec === 4 ? 'KeyA' : sec === 0 ? 'KeyD' : sec === 6 ? 'KeyS' : null;
    // the stick passed through the dead zone since the last frame (seen by the pointer events: a quick thumb crosses
    // the centre between two frame starts — at 45–60 fps two touch moves often land in one frame)
    const centred = !live || stick.centreSeen;
    // …and the sectors it went through since then (bit k = sector k; the same pointer-event view)
    const visited = stick.visited | (sec >= 0 ? 1 << sec : 0);
    stick.centreSeen = false; stick.visited = 0;
    const F = PK.fl;
    if (F && F.end < 0) {
      if (key === F.key && !centred) { F.peak = Math.max(F.peak, stick.defl); return null; }
      F.end = now;                                           // the push left its sector (the centre, a diagonal, lifted)
      if (centred) F.centre = true;
      else if (sec >= 0) F.used = true;                      // (straight into another sector: a wobble or a turn, not a flick)
    }
    if (F && (sec < 0 || centred)) F.centre = true;
    // between the two flicks the stick went another way (up, the opposite side; not the flick's own neighbour
    // diagonals, a sloppy re-entry): "turn left, straighten, turn left again" is steering, never a pair
    if (M.cancel && F && F.end >= 0 && !F.used) {
      const k0 = FLICK_SECTOR[F.key];
      for (let k = 0; k < 8; k++) if ((visited & (1 << k)) && Math.abs(((((k - k0) % 8) + 12) % 8) - 4) > 1) { F.used = true; break; }
    }
    if (!key) return null;
    const P = PK.fl;
    const sl = slack();
    const second = !!P && !P.used && P.key === key && P.centre && P.end - P.since <= M.flick + sl && P.peak >= M.defl && now - P.end <= M.gap + sl;
    PK.fl = { key, since: now, end: -1, peak: stick.defl, centre: false, used: second };
    if (!second) {
      if (P && P.key === key && P.centre && !P.used && now - P.end < 0.8 && P.end - P.since < 0.8) {
        pilotLog({ ev: 'no-flick', key, flick: +(P.end - P.since).toFixed(3), gap: +(now - P.end).toFixed(3), peak: +P.peak.toFixed(2) });
      }
      return null;
    }
    if (!flying || now - PK.moveAt < M.cooldown) { pilotLog({ ev: 'no-move', key, flying, cool: now - PK.moveAt < M.cooldown }); return null; }
    return MOVE_OF(key);
  }
  /** Stick moves in flight, gesture 'swing' (the earlier rule, kept for a revert — it fires on ordinary turn / brake
   *  returns, see TOUCH.moves): a hard left / right / down push, then up quickly. Returns { name, key } or null. */
  function moveSwing(now, live, flying) {
    const M = TOUCH.moves;
    const sec = stick.sector, d = stick.defl;
    const hardKey = live && d >= M.hard ? (sec === 4 ? 'KeyA' : sec === 0 ? 'KeyD' : sec === 6 ? 'KeyS' : null) : null;
    if (PK.hard && PK.hard.key !== hardKey) { PK.lastHard = { key: PK.hard.key, dwell: now - PK.hard.since, endAt: now }; PK.hard = null; }
    if (hardKey && !PK.hard) PK.hard = { key: hardKey, since: now };
    if (PK.lastHard && now - PK.lastHard.endAt > M.swing) PK.lastHard = null;
    const up = live && d >= M.upDefl && Math.abs(angDiff(stick.ang, 90)) <= M.upCone;
    const edge = up && !PK.wasUp;
    PK.wasUp = up;
    if (!live) { PK.hard = null; PK.lastHard = null; return null; }
    if (!edge || !PK.lastHard) return null;
    const L = PK.lastHard;
    PK.lastHard = null;
    if (!flying || L.dwell < M.dwell[0] || L.dwell > M.dwell[1] || now - PK.moveAt < M.cooldown) {
      pilotLog({ ev: 'no-move', key: L.key, dwell: +L.dwell.toFixed(3), flying });
      return null;
    }
    return MOVE_OF(L.key);
  }
  const moveStep = (now, live, flying) => (TOUCH.moves.gesture === 'swing' ? moveSwing(now, live, flying) : moveFlick(now, live, flying));

  /** Who moved the look pitch (vertical.own), every frame: the look's change since the last frame start against the
   *  downward look the player's own drags asked for in it (the camera applies a drag in the frame after it arrived).
   *  The flight dive arms when the look goes down to / below the tuck angle and the player's own drag made at least
   *  own.share of that step (≥ own.min deg) — the lock assist pulling the look, a move's aim carry, or a sideways drag
   *  while one of them pulls it down never arm it (fix round 1, 29.09: the dogfight's 9–11 dives in 3 min, all with
   *  LOCK on and the target near level, armed from "any drag within 0.12 s"). It disarms above dive[1], on a LOCK
   *  change and when a wingover / loop starts. */
  function lookTrack(now) {
    const Vt = TOUCH.vertical, O = Vt.own;
    const p = lookPitch();
    const own = PK.ownStash;
    PK.ownStash = PK.ownPend; PK.ownPend = 0;
    if (p !== null && PK.prevPitch !== null) {
      const dp = p - PK.prevPitch;
      if (!PK.diveArmed && dp < -O.rate && p <= Vt.dive[0] && own >= O.min && own >= O.share * -dp) {
        PK.diveArmed = true;
        pilotLog({ ev: 'arm', p: +p.toFixed(1), dp: +dp.toFixed(2), own: +own.toFixed(2) });
      }
    }
    if (p === null || p > Vt.dive[1]) PK.diveArmed = false;
    PK.prevPitch = p;
    if (PK.moveBusy && now - PK.moveEvAt > 4) PK.moveBusy = false;          // (an end event that never came)
  }

  /** Once per frame (input.beforeFrame): which keys the stick holds now, the moves, the guards. */
  function pilotFrame() {
    const now = frameNow();
    if (hooked) {
      const dt = PK.lastNow < 0 ? 1 / 60 : now - PK.lastNow;
      PK.lastNow = now;
      if (dt > 0 && dt < 0.2) PK.dtAvg += (dt - PK.dtAvg) * 0.1;
      flushAim(dt > 0 ? dt : 1 / 60);        // (controls update) before lookTrack: this frame's drag is this frame's own look
    }
    refreshShown();
    // a synthetic sequence's next frame; a move's keys that have been held long enough
    if (PK.pending.length) { const due = PK.pending.filter((p) => --p.frames <= 0); PK.pending = PK.pending.filter((p) => p.frames > 0); for (const p of due) p.fn(); }
    if (PK.timed.length) { for (const t of PK.timed) if (now >= t.until) unhold(t.code, 'move'); PK.timed = PK.timed.filter((t) => now < t.until); }
    lookTrack(now);
    const live = active && shown && stick.active;
    if (!live) {
      if (PK.held.size) releaseStick(now);
      moveStep(now, false, false);
      return;
    }
    const { flying, fm } = flightState();
    if (flying !== PK.wasFlying) { PK.wasFlying = flying; if (flying) PK.vDown = false; }   // hover → flight: a sink's Ctrl never carries into a dive
    const want = new Set(stick.sector >= 0 ? sectorKeys(stick.sector) : []);
    // vertical: the look pitch, with the stick pushed within `cone` of straight up
    const Vt = TOUCH.vertical;
    const inCone = stick.sector >= 0 && Math.abs(angDiff(stick.ang, 90)) <= Vt.cone;
    // (flight: nothing while a wingover / loop runs and for afterMove s after it — its aim carry leaves the look far
    //  up or down)
    const calm = !flying || (!PK.moveBusy && now - PK.moveEvAt >= Vt.afterMove);
    const pitch = inCone && calm ? lookPitch() : null;
    if (pitch !== null) {
      PK.vUp = PK.vUp ? pitch > Vt.up[1] : pitch >= Vt.up[0];
      if (flying) PK.vDown = PK.diveArmed && (PK.vDown ? pitch < Vt.dive[1] : pitch <= Vt.dive[0]);
      // (the hover's sink only in the hover itself: once a take-off's W has her in the transition, Ctrl lets go — else
      //  it was still down in the frame the pilot flipped to flight, a one-frame tuck; the dogfight at DPR 2 saw one)
      else PK.vDown = fm === 'hover' && (PK.vDown ? pitch < Vt.down[1] : pitch <= Vt.down[0]);
    } else { PK.vUp = false; PK.vDown = false; }
    if (PK.vUp) want.add('Space');
    if (PK.vDown) want.add('ControlLeft');
    if ((PK.vUp || PK.vDown) && !flying) {
      // the hover: a straight rise / sink first; a full push held takeoff.after s adds W (she takes off toward the look)
      const TO = Vt.takeoff;
      if (stick.defl >= TO.defl) { if (PK.fullSince < 0) PK.fullSince = now; } else if (stick.defl < TO.defl - 0.12) PK.fullSince = -1;
      if (!PK.takeoff && PK.fullSince >= 0 && now - PK.fullSince >= TO.after) { PK.takeoff = true; pilotLog({ ev: 'takeoff', up: PK.vUp }); }
      if (!PK.takeoff) want.delete('KeyW');
    }
    if (!inCone || stick.defl < 0.5) { PK.fullSince = -1; PK.takeoff = false; }
    const mv = moveStep(now, true, flying);
    // the move's chord must read as that move (player.js moveFromKeys: A XOR D wins over S): a loop lets A / D go this
    // frame, a wingover the other side
    if (mv) { if (mv.name === 'loop') { want.delete('KeyA'); want.delete('KeyD'); } else want.delete(mv.key === 'KeyA' ? 'KeyD' : 'KeyA'); }
    // releases first (a code the stick lets go of is up this frame), then the presses the guards allow
    for (const c of [...PK.held]) {
      if (want.has(c)) continue;
      PK.held.delete(c); unhold(c, 'stick');
      if (c === 'KeyW' && PK.wSeg) PK.wSeg.up = now;
    }
    if (PK.wSeg && PK.wSeg.up >= 0 && stick.sector < 0) PK.wSeg.centre = true;
    // (fix 29.09) between the dash's two W pushes the stick was pushed another way (a side / down sector, a real push —
    // ≥ half deflection for ≥ 80 ms: "forward, turn left, forward again" is steering) — never a dash, as the wingover's
    // cancel rule; a thumb that only wobbles through a side sector on its way back does not cancel
    if (PK.wSeg && PK.wSeg.up >= 0 && !PK.wSeg.used) {
      const other = stick.sector >= 0 && !W_SECTORS.has(stick.sector) && stick.defl >= 0.5;
      if (!other) PK.wSeg.otherSince = -1;
      else if (!(PK.wSeg.otherSince >= 0)) PK.wSeg.otherSince = now;
      else if (now - PK.wSeg.otherSince >= 0.08) PK.wSeg.used = true;
    }
    for (const c of want) {
      if (PK.held.has(c)) continue;
      let ok = true;
      if (c === 'KeyW') {
        if (now < PK.holdOffW) ok = false;
        else if (!mv && dashFlick(now)) { emitDash(now); continue; }
        else if (now - (PK.pressAt.KeyW ?? -1e9) < TOUCH.guard.wGap) ok = false;     // never the game's own W W by accident
      } else ok = mayPress(c, now);
      if (!ok) { if (!PK.deferring.has(c)) { PK.deferring.add(c); PK.deferred[c] = (PK.deferred[c] || 0) + 1; } continue; }
      PK.deferring.delete(c);
      PK.held.add(c); hold(c, 'stick'); PK.pressAt[c] = now;
      if (c === 'Space') PK.spaceAt = now;
      if (c === 'KeyW') PK.wSeg = { down: now, up: -1, peak: stick.defl, centre: false, checked: false };
    }
    for (const c of [...PK.deferring]) if (!want.has(c) || PK.held.has(c)) PK.deferring.delete(c);
    if (PK.wSeg && PK.wSeg.up < 0) PK.wSeg.peak = Math.max(PK.wSeg.peak, stick.defl);
    // a move: its key and Space pressed in this very frame (the keyboard's chord: player.js readMoveKeys "before"), with
    // W held too, as the keyboard player flying forward holds it through A then Space: a double flick lets W go for up
    // to 0.76 s (A / S alone, as the keyboard's A alone), and the flare that starts after 0.18 s can take her under
    // player.js MODES.brakeV — then the move would be dropped (flight test at 30.3 m/s). The pulse sets pressAt.KeyW,
    // so the stick's own W waits guard.wGap (> the W W dash's 0.2 s gap): never a dash with it.
    if (mv) {
      if (!PK.held.has('KeyW')) pulse('KeyW', now, TOUCH.moves.keyHold);
      pulse(mv.key, now, TOUCH.moves.keyHold);
      pulse('Space', now, TOUCH.moves.keyHold);
      PK.moveAt = now; PK.moves[mv.name]++;
      pilotLog({ ev: mv.name, key: mv.key });
    }
    stick.keys.clear();
    for (const c of PK.held) stick.keys.add(c);
  }

  // ---- two fingers: orbit (play: free look) + pinch zoom
  function startGesture(a, b, free) {
    a.role = 'gesture'; b.role = 'gesture';
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, d = Math.max(8, Math.hypot(a.x - b.x, a.y - b.y));
    gesture = { a: a.id, b: b.id, cx0: cx, cy0: cy, d0: d, cx, cy, d, orbit: false, zoom: false, free };
  }
  function gestureMove() {
    const G = gesture;
    if (!G) return;
    const A = fingers.get(G.a), B = fingers.get(G.b);
    if (!A || !B) return;
    const cx = (A.x + B.x) / 2, cy = (A.y + B.y) / 2, d = Math.max(8, Math.hypot(A.x - B.x, A.y - B.y));
    const dcx = cx - G.cx, dcy = cy - G.cy, dl = Math.log(d / G.d);
    G.cx = cx; G.cy = cy; G.d = d;
    const vm = layout.vmin || 10, T = TOUCH.gesture;
    const travel = Math.hypot(cx - G.cx0, cy - G.cy0), spread = Math.abs(d - G.d0);
    if (!G.orbit && travel > T.orbit * vm && travel > T.dominance * spread) {
      G.orbit = true;
      if (G.free) hold('Mouse2', 'gesture');
      logEv({ ev: 'orbit' });
    } else if (G.orbit) addAim(dcx, dcy, !G.free);
    if (!G.zoom && spread > T.pinch * vm && spread > T.dominance * travel) { G.zoom = true; logEv({ ev: 'pinch' }); }
    else if (G.zoom) addWheel(-dl / 0.0012);
  }
  function endGesture(f, handOver) {
    const G = gesture;
    if (!G) return;
    gesture = null;
    unholdAll('gesture');
    const otherId = G.a === f.id ? G.b : G.a;
    const o = fingers.get(otherId);
    if (!o) return;
    if (handOver) o.role = G.free ? 'aim' : 'menu';      // the finger still down aims on from where it is
    else { fingers.delete(o.id); }
  }

  /** Lift everything (state change, pause, blur, cancel, mode flip). Fingers still on the glass stay ignored. */
  function releaseAll(reason = 'api') {
    let n = 0;
    for (const f of [...fingers.values()]) { endFinger(f, false); n++; }
    fingers.clear();
    gesture = null;
    if (stick.active) stickEnd();
    releaseStick();
    PK.pending.length = 0; PK.timed.length = 0; PK.deferring.clear();
    aimPend.x = aimPend.y = aimPend.ly = 0; aimPend.v = 0;      // (controls update) no drag left over for the next view
    for (const [code, set] of [...owners]) for (const who of [...set]) unhold(code, who);
    for (const B of Object.values(btn)) { B.fingers.clear(); B.setDown(false); }
    if (n || reason === 'touchcancel') { stats.released += n; logEv({ ev: 'releaseAll', reason, n }); }
  }

  // ---------------------------------------------------------------------------------------------- activation
  function setActive(on, reason = 'api') {
    on = !!on;
    if (on === active) return false;
    active = on;
    if (!on) releaseAll('mode');
    try { document.body.classList.toggle('touch-mode', on); } catch { /* no body */ }
    if (on) { try { input?.exitLock?.({ quiet: true }); } catch (e) { warnOnce('exitLock', e); } }
    stats.flips++;
    logEv({ ev: 'touchmode', active: on, reason });
    try { game.events.emit('touchmode', { active: on, reason }); } catch (e) { warnOnce('touchmode event', e); }
    refreshShown();
    return true;
  }
  function applyPolicy(reason) {
    const p = policy();
    if (p === 'touch') setActive(true, reason);
    else if (p === 'desktop') setActive(false, reason);
    else setActive(autoWant, reason);
  }
  /** Auto, the mirror of "the first touch turns it on": a REAL mouse press on the game view in play (not a browser
   *  compatibility copy of a touch: sourceCapabilities.firesTouchEvents false, or — browsers without it — no touch for
   *  COMPAT ms) turns the touch layout off and locks the pointer in the same gesture, so a TV / monitor with a mouse
   *  aims with the mouse again at once. ?touch=1 and Settings "Touch" are never overridden; menus / HUD buttons clicked
   *  with the mouse do not flip it. */
  function onMouseDownReal(e) {
    if (!active || !e.isTrusted || policy() !== 'auto' || game.state !== 'play' || game.cameraRig?.cinematic) return;
    if (e.target !== game.canvas) return;
    const sc = e.sourceCapabilities;
    const real = sc && typeof sc.firesTouchEvents === 'boolean' ? !sc.firesTouchEvents : nowMs() - lastTouchAt >= TOUCH.compatMs;
    if (!real) return;
    autoWant = false;
    if (setActive(false, 'mouse')) { try { input?.requestLock?.(); } catch (err) { warnOnce('requestLock', err); } }
  }

  // ---------------------------------------------------------------------------------------------- DOM
  function build() {
    injectCss();
    root = h('div.tch', { 'aria-hidden': 'true' });
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    knobEl = h('div.tch-knob');
    baseEl = h('div.tch-base', {}, h('i.tch-dir.n'), h('i.tch-dir.e'), h('i.tch-dir.s'), h('i.tch-dir.w'), knobEl);
    stickEl = h('div.tch-stick.idle', {}, baseEl);
    const btnsEl = h('div.tch-btns');
    for (const def of BUTTONS) {
      const arc = s('circle.tb-arc', { cx: 50, cy: 50, r: 46.5, pathLength: 100 });
      const ring = s('svg.tb-ring', { viewBox: '0 0 100 100', 'aria-hidden': 'true' }, s('circle.tb-track', { cx: 50, cy: 50, r: 46.5 }), arc);
      const lb = h('span.tb-lb', { text: labelText(def.label) });
      const pips = def.id === 'fireball' ? h('span.tb-pips', {}, h('i'), h('i'), h('i')) : null;
      const ic = h('span.tb-icw', {}, icon(def.icon));
      const inner = h('span.tb-in', {}, ring, ic, lb, pips);
      const el = bindText(h('div.tb.tb-' + def.id + (def.big ? '.big' : ''), { role: 'button', 'data-tb': def.id }, inner), def.id, null, 'aria-label');
      el.addEventListener('contextmenu', (e) => e.preventDefault());
      const B = {
        def, el, inner, ring, arc, lb, pips, ic, fingers: new Set(), iconName: def.icon,
        setDown: classSetter(el, 'down'),
        cls: {}, arcOff: styleSetter(arc, 'strokeDashoffset'), lbText: lb.textContent,
        // (a new word is fitted into the circle at the end of the frame: fitLabels)
        text: (v) => { if (v !== B.lbText) { B.lbText = v; lb.textContent = v; fitDirty.add(B); } },
      };
      fitDirty.add(B);
      B.flag = (name, on) => { (B.cls[name] || (B.cls[name] = classSetter(el, name)))(on); };
      btn[def.id] = B;
      btnsEl.append(el);
    }
    root.append(stickEl, btnsEl);
    const ui = document.getElementById('ui') || document.body;
    const hud = ui.querySelector(':scope > .hud');
    if (hud && hud.nextSibling) ui.insertBefore(root, hud.nextSibling); else ui.append(root);
    setters.stickIdle = classSetter(stickEl, 'idle');
    setters.stickOn = classSetter(stickEl, 'on');
    setters.baseT = styleSetter(baseEl, 'transform');
    setters.knobT = styleSetter(knobEl, 'transform');
    setters.dirs = [...baseEl.querySelectorAll('.tch-dir')];
    setters.dirOn = setters.dirs.map((d) => classSetter(d, 'on'));
    setters.rise = classSetter(stickEl, 'rise');
    setters.sink = classSetter(stickEl, 'sink');
    setters.shown = classSetter(root, 'on');
    setters.left = classSetter(root, 'left');
  }
  const setters = {};
  // Labels in their circles (fix 29.09, the layout review: the English FIREBALL / INFERNO and the Russian (other language)
  // in Arial ran past a phone's 64 px button): a label wider than the circle's chord at its line (× LABEL_FIT.fill) first
  // loses tracking (down to .minTrack em), then size (down to × .minScale). Measured only when a word, the button size or
  // the fonts change (one layout read; cached by word, button and font size); every label that fits keeps its CSS as is.
  const LABEL_FIT = { fill: 0.94, minTrack: 0.02, minScale: 0.7 };
  const fitDirty = new Set();
  const fitCache = new Map();
  function fitLabel(B) {
    const lb = B.lb, inn = B.inner, txt = lb.textContent || '';
    if (!txt || !inn) return;
    // (the key without a layout read: the button's size as relayout set it, the label sizes, the language)
    const key = `${txt}|${B.el.style.width}|${root?.style.getPropertyValue('--tch-fs')}|${root?.style.getPropertyValue('--tch-fs-big')}|${lang()}`;
    let fit = fitCache.get(key);
    if (fit === undefined) {
      const d = inn.offsetWidth || 0;
      if (!d) return;
      lb.style.fontSize = lb.style.letterSpacing = lb.style.paddingLeft = '';
      const cs = getComputedStyle(lb);
      const fs = parseFloat(cs.fontSize) || 13, ls = parseFloat(cs.letterSpacing) || 0, pad = parseFloat(cs.paddingLeft) || 0;
      const n = [...txt].length, gaps = Math.max(1, n - 1);
      // the word's advance without its left pad and the tracking after its last letter; the chord of the circle at the
      // farther edge of the label's line box (from the button's centre)
      const w = lb.offsetWidth - pad - ls, r = d / 2, top = lb.offsetTop + (inn.clientTop || 0);
      const dy = Math.max(Math.abs(top - r), Math.abs(top + lb.offsetHeight - r));
      const max = 2 * Math.sqrt(Math.max(0, r * r - dy * dy)) * LABEL_FIT.fill;
      fit = null;
      if (w > max && max > 0) {
        const ls2 = Math.max(LABEL_FIT.minTrack * fs, ls - (w - max) / gaps);
        const w2 = w - (ls - ls2) * gaps;
        const k = w2 > max ? Math.max(LABEL_FIT.minScale, max / w2) : 1;
        fit = { fs: k < 1 ? `${(fs * k).toFixed(2)}px` : '', ls: `${(ls2 * k).toFixed(2)}px` };
      }
      if (fitCache.size > 64) fitCache.clear();
      fitCache.set(key, fit);
    }
    lb.style.fontSize = fit ? fit.fs : ''; lb.style.letterSpacing = lb.style.paddingLeft = fit ? fit.ls : '';
    B.fit = fit;
  }
  function fitLabels(all = false) {
    if (!root) return;
    const list = all ? Object.values(btn) : [...fitDirty];
    fitDirty.clear();
    for (const B of list) { try { fitLabel(B); } catch (e) { warnOnce('label fit', e); } }
  }
  /** Every label in the current language and the player's state (FIRE / OVERHEAT, FIREBALL / BOLT, INFERNO / SURGE) at
   *  once — a language switch while paused (the per-frame writes wait for the play), then fitted. */
  function writeLabels() {
    const p = game.player;
    let over = false, bolt = false, surge = false;
    try {
      over = p?.overheated === true; bolt = p?.weaponKind === 'bolt';
      const el = ELEMENT.has(p?.element) ? p.element : 'ember';
      surge = el === 'lightning' || el === 'storm' || bolt;
    } catch { /* read-only */ }
    const B = btn;
    B.fire?.text(over ? tr('OVERHEAT') : tr('FIRE'));
    B.fireball?.text(bolt ? tr('BOLT') : tr('FIREBALL'));
    B.inferno?.text(surge ? tr('SURGE') : tr('INFERNO'));
    B.lock?.text(tr('LOCK')); B.boost?.text(tr('BOOST')); B.dodgeL?.text(tr('DODGE')); B.dodgeR?.text(tr('DODGE'));
    fitLabels();
  }
  function injectCss() {
    if (document.querySelector('link[data-touch-css]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = new URL('./touch.css', import.meta.url).href; l.dataset.touchCss = '1';
    // (the labels are fitted from the stylesheet's sizes: again once it is in)
    l.addEventListener('load', () => { fitCache.clear(); fitLabels(true); });
    document.head.append(l);
  }

  /** Sizes and positions (resize / settings only). */
  function relayout() {
    if (!root) return;
    const W = Math.max(1, innerWidth), H = Math.max(1, innerHeight);
    const vm = Math.min(W, H) / 100;
    const sizeKey = String(setting('touchButtonSize', 'm')).toLowerCase();
    const S = TOUCH.size[sizeKey] || 1;
    const left = setting('leftHanded', false) === true;
    const compact = String(setting('touchLayout', 'corners')).toLowerCase() === 'compact';
    // the screen margin (overscan): a share of each side, added to the edge margins
    const safe = clamp(num(Number(setting('screenMargin', 0)), 0), 0, TOUCH.safeMax) / 100;
    const sxm = safe * W, sym = safe * H;
    const cl = (spec, k = 1) => clamp(spec[1] * vm * k, spec[0], spec[2]);
    const F = cl(TOUCH.fire, S), Bd = cl(TOUCH.btn, S);
    const g = TOUCH.gap * vm, m = TOUCH.margin * vm, mx = m + sxm, my = m + sym;
    const r1 = F / 2 + g + Bd / 2, r2 = r1 + Bd + g;
    // FIRE: the bottom-right corner (corners) or its compact spot (kept inside the margins either way)
    const C = TOUCH.compact;
    const fx = compact ? Math.min(C.fire[0] * W, W - mx - F / 2) : W - mx - F / 2;
    const fy = compact ? Math.min(C.fire[1] * H, H - my - F / 2) : H - my - F / 2;
    const P = { fire: { x: fx, y: fy, d: F } };
    const at = (ang, r) => ({ x: fx + r * Math.cos(ang * Math.PI / 180), y: fy - r * Math.sin(ang * Math.PI / 180), d: Bd });
    for (const [id, a] of INNER) P[id] = at(a, r1);
    for (const [id, a] of OUTER) P[id] = at(a, r2);
    if (left) {
      for (const p of Object.values(P)) p.x = W - p.x;
      const lx = P.dodgeL.x, ly = P.dodgeL.y;          // mirrored, ◀ would sit right of ▶: swap the pair back
      P.dodgeL.x = P.dodgeR.x; P.dodgeL.y = P.dodgeR.y; P.dodgeR.x = lx; P.dodgeR.y = ly;
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [id, p] of Object.entries(P)) {
      const B = btn[id];
      if (B) {
        B.el.style.width = B.el.style.height = p.d.toFixed(1) + 'px';
        B.el.style.transform = `translate3d(${(p.x - p.d / 2).toFixed(1)}px, ${(p.y - p.d / 2).toFixed(1)}px, 0)`;
      }
      x0 = Math.min(x0, p.x - p.d / 2); y0 = Math.min(y0, p.y - p.d / 2); x1 = Math.max(x1, p.x + p.d / 2); y1 = Math.max(y1, p.y + p.d / 2);
      P[id] = { x: +p.x.toFixed(1), y: +p.y.toFixed(1), d: +p.d.toFixed(1) };
    }
    const r = cl(TOUCH.stick.r);
    const sx = compact ? Math.max(C.stick[0] * W, mx + r) : mx + r + 1.5 * vm;
    const sy = compact ? Math.min(C.stick[1] * H, H - my - r) : H - my - r - 1.5 * vm;
    const zx = (compact ? C.zone : TOUCH.stick.zoneX) * W;
    const zone = left ? { x0: W - zx, x1: W, y0: TOUCH.stick.zoneTop * H, y1: H } : { x0: 0, x1: zx, y0: TOUCH.stick.zoneTop * H, y1: H };
    Object.assign(layout, {
      w: W, h: H, vmin: vm, left, size: TOUCH.size[sizeKey] ? sizeKey : 'm', mode: compact ? 'compact' : 'corners', safe,
      stick: { cx: left ? W - sx : sx, cy: sy, r, zone },
      buttons: P, cluster: { x: +x0.toFixed(1), y: +y0.toFixed(1), w: +(x1 - x0).toFixed(1), h: +(y1 - y0).toFixed(1) },
    });
    root.style.setProperty('--tch-r', r.toFixed(1) + 'px');
    root.style.setProperty('--tch-fs', clamp(1.28 * vm * S, 11, 40).toFixed(1) + 'px');
    root.style.setProperty('--tch-fs-big', clamp(1.6 * vm * S, 13, 48).toFixed(1) + 'px');
    setters.left(left);
    // For the HUD's CSS (on #ui): --tch-side = how far the button cluster reaches in from its screen edge (the cut-in
    // banner and the hazard pill stay between the arcs, styles.css), --tch-top = the cluster's top edge, --safe-x /
    // --safe-y = the screen margin (overscan) the HUD's own corner items (the top-right panel, PAUSE / FULLSCREEN) add.
    try {
      const ui = document.getElementById('ui') || root.parentElement;
      ui?.style.setProperty('--tch-side', Math.ceil(Math.max(left ? x1 : W - x0, 0) + 8) + 'px');
      ui?.style.setProperty('--tch-top', Math.floor(y0) + 'px');
      ui?.style.setProperty('--safe-x', sxm.toFixed(1) + 'px');
      ui?.style.setProperty('--safe-y', sym.toFixed(1) + 'px');
      // the watermark (index.html, outside #ui) keeps the same margin
      document.documentElement.style.setProperty('--safe-x', sxm.toFixed(1) + 'px');
      document.documentElement.style.setProperty('--safe-y', sym.toFixed(1) + 'px');
    } catch { /* no #ui */ }
    view.base = '';       // re-place the stick next frame
    fitCache.clear(); fitLabels(true);
  }

  // ---------------------------------------------------------------------------------------------- per frame
  let shown = false;
  function refreshShown() {
    const on = !!root && active && game.state === 'play' && !game.cameraRig?.cinematic;
    if (on !== shown) {
      shown = on;
      setters.shown?.(on);
      if (on) fitLabels(true);          // (cached: a layout read per label, on showing only)
      if (!on) {
        // the controls hide (pause, cinematic, results, mode off): lift what fingers hold in play
        for (const f of [...fingers.values()]) if (f.role === 'stick' || f.role === 'btn' || f.role === 'aim' || f.role === 'gesture' || f.role === 'extra') endFinger(f, false);
        if (stick.active) stickEnd();
        releaseStick();
        PK.pending.length = 0; PK.deferring.clear();
        for (const t of PK.timed) unhold(t.code, 'move');
        PK.timed.length = 0;
        unholdAll('gesture'); unholdAll('stick');
        for (const B of Object.values(btn)) { B.fingers.clear(); B.setDown(false); }
      }
    }
    return shown;
  }
  const view = { base: '', knob: '', dir: '' };
  const q = (v, n = 200) => Math.round(clamp(v, 0, 1) * n) / n;

  function updateStick() {
    const L = layout.stick;
    if (!L) return;
    const on = stick.active;
    setters.stickIdle(!on); setters.stickOn(on);
    const cx = on ? stick.cx : L.cx, cy = on ? stick.cy : L.cy;
    const bt = `translate3d(${(cx - L.r).toFixed(1)}px, ${(cy - L.r).toFixed(1)}px, 0)`;
    if (bt !== view.base) { view.base = bt; setters.baseT(bt); }
    const kt = on ? `translate3d(${stick.kx.toFixed(1)}px, ${stick.ky.toFixed(1)}px, 0)` : 'translate3d(0px, 0px, 0)';
    if (kt !== view.knob) { view.knob = kt; setters.knobT(kt); }
    const k = stick.keys;
    const sig = (k.has('KeyW') ? 'W' : '') + (k.has('KeyD') ? 'D' : '') + (k.has('KeyS') ? 'S' : '') + (k.has('KeyA') ? 'A' : '') + (k.has('Space') ? '+' : '') + (k.has('ControlLeft') ? '-' : '');
    if (sig !== view.dir) {
      view.dir = sig;
      setters.dirOn[0](k.has('KeyW')); setters.dirOn[1](k.has('KeyD')); setters.dirOn[2](k.has('KeyS')); setters.dirOn[3](k.has('KeyA'));
      // the look-pitch vertical: the knob shows a rise / sink chevron while the stick holds Space / Ctrl
      setters.rise(k.has('Space')); setters.sink(k.has('ControlLeft'));
    }
  }

  const ELEMENT = new Set(['ember', 'azure', 'radiant', 'lightning', 'storm']);
  function updateButtons() {
    const p = game.player;
    if (!p) return;
    const B = btn;
    // FIRE: heat ring, overheat state
    let heat = 0, over = false;
    try { heat = clamp(num(p.heat, 0), 0, 1); over = p.overheated === true; } catch { /* read-only */ }
    B.fire.arcOff(String(100 - q(heat) * 100));
    B.fire.flag('over', over); B.fire.flag('warm', heat > 0.6 && !over);
    B.fire.text(over ? tr('OVERHEAT') : tr('FIRE'));
    // FIREBALL / BOLT: charge ring while held, else the recharge; pips = charges
    try {
      const fb = p.fireball && typeof p.fireball === 'object' ? p.fireball : null;
      const bolt = p.weaponKind === 'bolt';
      const charge = clamp(num(p.fireCharge, 0), 0, 1);
      const max = fb ? Math.max(1, Math.round(num(fb.maxCharges, 1))) : 1;
      const charges = fb ? clamp(Math.round(num(fb.charges, fb.ready ? 1 : 0)), 0, max) : 1;
      const cd = fb ? Math.max(0, num(fb.cooldown, 0)) : 0, cdMax = fb ? Math.max(0.1, num(fb.cooldownMax, 2.5)) : 1;
      const charging = charge > 0.02 || (charge > 0 && B.fireball.fingers.size > 0);
      const frac = charging ? charge : cd > 0 ? clamp(1 - cd / cdMax, 0, 1) : 1;
      B.fireball.arcOff(String(100 - q(frac) * 100));
      B.fireball.flag('charging', charging); B.fireball.flag('full', charging && charge >= 0.999);
      B.fireball.flag('empty', charges === 0); B.fireball.flag('cool', cd > 0 && !charging);
      B.fireball.text(bolt ? tr('BOLT') : tr('FIREBALL'));
      if (B.fireball.iconName !== (bolt ? 'bolt' : 'orb')) {
        B.fireball.iconName = bolt ? 'bolt' : 'orb';
        const ic = icon(B.fireball.iconName);
        B.fireball.ic.replaceChildren(ic);
      }
      const pk = `${max}:${charges}`;
      if (B.fireball.pipKey !== pk && B.fireball.pips) {
        B.fireball.pipKey = pk;
        [...B.fireball.pips.children].forEach((pip, i) => { pip.className = i >= max ? 'off' : i < charges ? 'full' : ''; });
      }
    } catch (e) { warnOnce('fireball ring', e); }
    // INFERNO / SURGE: the special meter; dim until full, then glowing; draining while it burns
    try {
      const sp = clamp(num(p.special, 0), 0, 1), burn = p.infernoActive === true;
      const el = ELEMENT.has(p.element) ? p.element : 'ember';
      const surge = el === 'lightning' || el === 'storm' || p.weaponKind === 'bolt';
      B.inferno.arcOff(String(100 - q(sp) * 100));
      B.inferno.flag('ready', sp >= 0.999 && !burn); B.inferno.flag('burn', burn); B.inferno.flag('dim', sp < 0.999 && !burn);
      B.inferno.text(surge ? tr('SURGE') : tr('INFERNO'));
      if (B.inferno.el.dataset.el !== el) B.inferno.el.dataset.el = el;
      if (B.fire.el.dataset.el !== el) B.fire.el.dataset.el = el;
    } catch (e) { warnOnce('inferno ring', e); }
    // BOOST: stamina ring; the dodges dim when stamina is low
    try {
      const sta = clamp(num(p.stamina, 1), 0, 1);
      B.boost.arcOff(String(100 - q(sta) * 100));
      B.boost.flag('low', sta < 0.2);
      B.dodgeL.flag('low', sta < 0.12); B.dodgeR.flag('low', sta < 0.12);
    } catch (e) { warnOnce('stamina ring', e); }
    // LOCK: lit while a target is locked
    try { B.lock.flag('on', !!game.cameraRig?.lockTarget); } catch { /* optional */ }
    // the fixed labels in the current language (a language switch; written only when they change)
    B.lock.text(tr('LOCK')); B.boost.text(tr('BOOST')); B.dodgeL.text(tr('DODGE')); B.dodgeR.text(tr('DODGE'));
    if (fitDirty.size) fitLabels();
  }

  // ---------------------------------------------------------------------------------------------- listeners
  function onTouchStart(e) {
    lastTouchAt = nowMs();
    if (!e.isTrusted) return;
    autoWant = true;
    if (!active && policy() === 'auto') setActive(true, 'touch');
    if (!active) return;
    // the canvas and the overlay: no compat mouse events, no click, no browser gesture. Menus keep their clicks.
    const t = e.target;
    if (e.cancelable && (t === game.canvas || (root && root.contains(t)))) e.preventDefault();
  }
  function onTouchEnd(e) {
    lastTouchAt = nowMs();
    if (e.type === 'touchcancel') {
      stats.cancels++;
      if (!e.touches || e.touches.length === 0) releaseAll('touchcancel');
    } else if (e.touches && e.touches.length === 0 && fingers.size) {
      // every finger is off the glass: whatever still holds a control missed its pointerup — lift it now
      const stale = [...fingers.values()].filter((f) => f.role !== 'foreign');
      if (stale.length) { logEv({ ev: 'stale', n: stale.length }); for (const f of stale) endFinger(f, false); }
      fingers.clear();
    }
    if (active && e.cancelable && (e.target === game.canvas || (root && root.contains(e.target)))) e.preventDefault();
  }
  function onTouchMove(e) {
    lastTouchAt = nowMs();
    if (active && e.cancelable && (e.target === game.canvas || (root && root.contains(e.target)))) e.preventDefault();
  }

  const sys = {
    name: 'touchUI',
    get active() { return active; },
    setActive: (on, reason) => setActive(on, reason),
    get mode() { return policy(); },
    get shown() { return shown; },
    get el() { return root; },
    buttons: {},
    stick,
    layout,
    stats,
    get aim() { return { ...aimStats }; },
    get fingers() { return [...fingers.values()].map((f) => ({ id: f.id, role: f.role, btn: f.btn?.def.id || null, aiming: f.aiming })); },
    get held() { return [...owners.keys()]; },
    get lastTouchAt() { return lastTouchAt; },
    releaseAll: (reason) => releaseAll(reason),
    relayout: () => relayout(),
    /** What the stick logic did (read-only, tests): held codes, the look-pitch vertical, moves emitted, deferred
     *  presses (the chord guards), the last events. */
    /** The tuning table (TOUCH; tests and tuning runs read it). */
    tuning: TOUCH,
    get pilot() {
      return { held: [...PK.held], vUp: PK.vUp, vDown: PK.vDown, diveArmed: PK.diveArmed, takeoff: PK.takeoff, gesture: TOUCH.moves.gesture,
        moves: { ...PK.moves }, deferred: { ...PK.deferred }, hooked, slack: +slack().toFixed(4), log: PK.log.slice(), arms: PK.arms.slice() };
    },

    init() {
      try {
        build();
        for (const def of BUTTONS) sys.buttons[def.id] = btn[def.id].el;
        Object.defineProperty(stick, 'el', { value: baseEl, enumerable: false });   // the base (other owners' keep-outs)
        relayout();
      } catch (e) { warnOnce('build', e); }
      // a language switch: every label at once, in the current state (also while paused / hidden)
      try { onLang(() => { try { writeLabels(); } catch (e) { warnOnce('labels', e); } }); } catch { /* no i18n */ }
      // a face that arrives later (local @font-face faces load on first use) changes the widths: fit again
      try { document.fonts?.addEventListener?.('loadingdone', () => { fitCache.clear(); fitLabels(true); }); } catch { /* old browser */ }
      const opt = { capture: true, passive: false };
      window.addEventListener('pointerdown', onDown, true);
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
      window.addEventListener('touchstart', onTouchStart, opt);
      window.addEventListener('touchmove', onTouchMove, opt);
      window.addEventListener('touchend', onTouchEnd, opt);
      window.addEventListener('touchcancel', onTouchEnd, opt);
      window.addEventListener('mousedown', onMouseDownReal, true);
      window.addEventListener('blur', () => releaseAll('blur'));
      document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll('hidden'); });
      window.addEventListener('resize', () => relayout());
      // the stick's keys on the frame clock, before the fixed steps read the edges (input.js beforeFrame)
      if (Array.isArray(input?.beforeFrame)) { input.beforeFrame.push(pilotFrame); hooked = true; }
      const ev = game.events;
      // every state change lifts every finger's control (a title drag never becomes an aim drag in play)
      ev.on('state', ({ next } = {}) => { releaseAll('state:' + next); refreshShown(); });
      ev.on('settings', ({ key } = {}) => {
        if (key === 'controls') { urlForce = null; applyPolicy('settings'); }
        if (!key || LAYOUT_KEYS.has(key)) relayout();
      });
      // (read-only) the look the lock assist moves is not the player's: a LOCK change disarms the flight dive; so does a
      // wingover / loop start, and flight adds no Space / Ctrl while one runs and vertical.afterMove s after it
      ev.on('lock', () => { PK.diveArmed = false; });
      ev.on('move', (e = {}) => {
        const me = game.player?.actor || game.player;
        if (!e || e.ai || (e.actor && e.actor !== me && e.actor !== game.player) || (e.name !== 'wingover' && e.name !== 'loop')) return;
        PK.moveEvAt = frameNow();
        if (e.phase === 'end') PK.moveBusy = false;
        else { PK.moveBusy = true; PK.diveArmed = false; }
      });
      applyPolicy('boot');
      // the HUD (order 90) initialised before this system: it reads game.touchUI.active; tell every listener once
      try { ev.emit('touchmode', { active, reason: 'boot' }); } catch (e) { warnOnce('touchmode event', e); }
      refreshShown();
    },

    lateUpdate() {
      if (!root) return;
      try {
        const wasShown = shown;
        refreshShown();
        if (!shown) { if (wasShown) updateStick(); return; }
        updateStick();
        updateButtons();
      } catch (e) { warnOnce('frame', e); }
    },
  };
  // decide the layout before the HUD's init reads it (systems are created in order, initialised afterwards)
  try {
    const p0 = policy();
    active = p0 === 'touch' || (p0 === 'auto' && coarseAtBoot);
    document.body.classList.toggle('touch-mode', active);
  } catch { /* no DOM */ }
  return sys;
}
