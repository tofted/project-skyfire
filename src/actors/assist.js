// game.aimAssist (system 'aimAssist', order 31) — how much help the aim gets (controls update: "it becomes very hard
// to aim whilst flying"). Settings → Controls → Aim assist: Auto | Normal | Strong.
//   normal   the game as it was: the soft target within 8° of the reticle, the aim bends ≤ 3° toward it, the head
//            looks at it inside a 12° cone (player.js AIM, camera.js magnet*)
//   strong   wider and firmer (13° / 6° / 19°), the look slows down while the reticle is on a target (so a thumb
//            does not sweep past it), and an AUTO-LOCK: firing at a rider the reticle is on takes the camera rig's
//            own lock on it (the same lock Tab / LOCK gives: the aim sticks to the target's bearing and leans onto
//            it); the lock lets go when the target dies, when the player looks ≥ 32° away for half a second, or 3.5 s
//            after the last shot. A lock the player took themself (Tab / LOCK) is never touched.
//   auto     strong with touch controls, normal with keyboard and mouse (default)
// The titan is never auto-locked (its core window stays a matter of flying and aiming — titan.js / player.js AIM).
// Nothing here writes game state other than the rig's lock and the two tuning tables (AIM, cameraRig.tuning), which
// the original values are restored into when the level goes back to normal.
// Public: aimAssist.level ('normal' | 'strong'), .mode (the setting), .autoLock (the actor it holds, or null),
// .stats { locks, releases }, .levels (the tables).
import { AIM } from './player.js';

const DEG = Math.PI / 180;

export const ASSIST_LEVELS = {
  normal: {
    aim: { angle: 8 * DEG, keep: 11 * DEG, lockAngle: 16 * DEG, magnet: 3 * DEG, breathCone: 12 * DEG },
    rig: { magnetMax: 3 * DEG, magnetCone: [3.5 * DEG, 8 * DEG], lockAssist: [5 * DEG, 20 * DEG], lockPull: 2.0, aimSlow: 0 },
    autoLock: false,
  },
  strong: {
    aim: { angle: 13 * DEG, keep: 18 * DEG, lockAngle: 24 * DEG, magnet: 6 * DEG, breathCone: 19 * DEG },
    rig: { magnetMax: 6 * DEG, magnetCone: [6 * DEG, 13 * DEG], lockAssist: [9 * DEG, 27 * DEG], lockPull: 3.2, aimSlow: 0.45 },
    autoLock: true,
  },
};
export const AUTO_LOCK = { fireWindow: 1.2, idle: 3.5, breakAngle: 32 * DEG, breakTime: 0.5, range: 520 };

export default function createAimAssist(game) {
  let applied = null, base = null;
  let auto = null, offT = 0, lastFire = -1e9, quietUntil = 0;
  const stats = { locks: 0, releases: 0 };

  const setting = () => {
    const s = game.settings?.aimAssist;
    return s === 'normal' || s === 'strong' ? s : 'auto';
  };
  const resolve = () => {
    const s = setting();
    return s === 'auto' ? (game.touchUI?.active ? 'strong' : 'normal') : s;
  };

  function apply(level) {
    const L = ASSIST_LEVELS[level] || ASSIST_LEVELS.normal;
    const T = game.cameraRig?.tuning;
    // the values the game shipped with are the 'normal' table's source of truth: remembered once, restored exactly
    if (!base) {
      base = { aim: {}, rig: {} };
      for (const k of Object.keys(ASSIST_LEVELS.normal.aim)) base.aim[k] = AIM[k];
      if (T) for (const k of Object.keys(ASSIST_LEVELS.normal.rig)) base.rig[k] = Array.isArray(T[k]) ? [...T[k]] : (T[k] ?? ASSIST_LEVELS.normal.rig[k]);
    }
    const aim = level === 'normal' ? base.aim : L.aim;
    for (const k of Object.keys(aim)) AIM[k] = aim[k];
    if (T) {
      const rig = level === 'normal' ? base.rig : L.rig;
      for (const k of Object.keys(rig)) T[k] = Array.isArray(rig[k]) ? [...rig[k]] : rig[k];
    }
    applied = level;
  }

  function release(reason) {
    const rig = game.cameraRig;
    if (auto && rig && rig.lockTarget === auto) { try { rig.lock(null); } catch { /* the rig's own */ } stats.releases++; }
    auto = null; offT = 0;
    // the next lock needs a new shot, and not in the same breath as the one that just let go
    lastFire = -1e9; quietUntil = (game.time?.real || 0) + 0.8;
    sys.lastRelease = reason;
  }

  const sys = {
    name: 'aimAssist',
    levels: ASSIST_LEVELS,
    stats,
    lastRelease: '',
    get mode() { return setting(); },
    get level() { return applied || resolve(); },
    get autoLock() { return auto; },
    init() {
      game.events.on('state', ({ next } = {}) => { if (next !== 'play' && next !== 'paused' && next !== 'photo') release('state'); });
      game.events.on('death', ({ actor } = {}) => { if (actor && actor === auto) { auto = null; offT = 0; } });
    },
    update(dt, realDt) {
      const level = resolve();
      if (level !== applied) { apply(level); if (!ASSIST_LEVELS[level].autoLock) release('level'); }
      if (game.state !== 'play') return;
      const rig = game.cameraRig, p = game.player, inp = game.input;
      if (!rig || !p || !inp || rig.cinematic) return;
      const now = game.time.real;
      const firing = inp.down('Mouse0') || inp.down('KeyF') || inp.down('KeyR') || (inp.pad?.rt ?? 0) > 0.4 || !!inp.pad?.buttons?.[2];
      if (firing) lastFire = now;
      if (inp.pressed('Tab')) { auto = null; offT = 0; return; }          // the player's own lock from here on
      const cur = rig.lockTarget;
      if (cur && cur !== auto) { auto = null; return; }                   // a lock that is not ours: hands off
      if (!ASSIST_LEVELS[level].autoLock) return;
      if (auto) {
        if (!cur) { auto = null; offT = 0; return; }                      // the rig let it go (death, removal)
        const t = auto, o = p.pos, d = rig.targetDir;
        let gone = t.alive === false || !t.pos || !o || !d;
        if (!gone) {
          const dx = t.pos.x - o.x, dy = t.pos.y - o.y, dz = t.pos.z - o.z, L = Math.hypot(dx, dy, dz);
          const ang = L > 1 ? Math.acos(Math.max(-1, Math.min(1, (dx * d.x + dy * d.y + dz * d.z) / L))) : 0;
          offT = ang > AUTO_LOCK.breakAngle ? offT + (realDt || 0) : 0;
          if (L > AUTO_LOCK.range * 1.5) gone = true;
        }
        if (gone) release('gone');
        else if (offT > AUTO_LOCK.breakTime) release('looked away');
        else if (now - lastFire > AUTO_LOCK.idle) release('idle');
        return;
      }
      // acquire: firing (or just fired) with the reticle on a rider
      const st = p.softTarget;
      if (st && now >= quietUntil && st.kind !== 'titan' && st.alive !== false && st.team === 'enemy' && now - lastFire <= AUTO_LOCK.fireWindow) {
        const o = p.pos;
        if (o && st.pos && Math.hypot(st.pos.x - o.x, st.pos.y - o.y, st.pos.z - o.z) <= AUTO_LOCK.range) {
          try { rig.lock(st); auto = st; offT = 0; stats.locks++; } catch { auto = null; }
        }
      }
    },
  };
  return sys;
}
