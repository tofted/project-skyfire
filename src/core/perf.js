// game.perf — the frame-rate governor (system 'perf', order 1). In the automatic graphics mode it holds 60 fps by
// moving along the device's ladder (core/quality.js: feature set × internal resolution), one rung at a time:
//   down   the trimmed mean frame time of a window is over the target (+10 %) twice in a row (at once when it is far
//          over): 1–3 rungs down, by how far over it is;
//   up     the frame time has sat at the target for a while: one rung up, on probation — if that rung cannot hold the
//          target it goes back down and is not tried again for `backoff` s (doubling every time it fails);
//   capped three steps down that bought nothing (a browser that caps the page at 30 fps: iOS Low Power Mode, a
//          battery saver; or a CPU-bound page): the steps are taken back and the cap becomes the target, so the game
//          keeps the best picture that cap allows. A frame time well under the cap later restores the 60 fps target.
// A display that runs faster than 75 Hz only climbs while it keeps a clear margin (the extra frames are not traded
// for pixels down to 60). With a fixed preset the governor only measures (stats), it never changes anything.
// Public: perf.stats { fps, ms, p95, rung, rungs, set, pr, mp, target, capped, changes, mode }, perf.rung,
// perf.setRung(i, reason), perf.config (live tuning), perf.log (the last changes), perf.hold(seconds) (no changes for
// a while: cinematics, loading), events 'perf:rung' { rung, set, pr, reason }.
// Tests drive it through game.frame(now) with made-up frame times (the governor reads the frame's real dt).
import { autoQuality, buildLadder, perfKey, saveRung, nearestRung } from './quality.js';

const T60 = 1000 / 60;

export default function createPerf(game) {
  const config = {
    window: 0.75, minFrames: 30,   // one measurement: this many seconds and at least this many frames
    trim: 0.12,                    // the slowest share of a window's frames is left out (a hitch is not a trend)
    slow: 1.07, verySlow: 1.5,     // × target: over `slow` twice → down; over `verySlow` once → down
    good: 1.025,                   // × target: at or under it counts toward a step up
    upWindows: 7,                  // good windows in a row before a step up (≈ 5 s)
    probation: 4,                  // windows a new higher rung must hold
    backoff: 45, backoffMax: 600,  // s before a rung that failed is tried again (doubles per failure)
    regret: 90,                    // s: a rung climbed to less than this long ago that then proves too slow has failed too
    rest: 20,                      // s a rung given up for any other reason is left alone
    settle: 0.6,                   // s after a change that are not measured (buffers are reallocated)
    fastHz: 75, fastGood: 0.62,    // a display faster than fastHz climbs only under fastGood × target
    stuckGain: 0.93, stuckSteps: 3,
  };
  const st = {
    acc: 0, n: 0, buf: new Float32Array(600), slow: 0, good: 0, skip: 1.5, hold: 0,
    target: T60, capped: false, block: [], fail: [], upAt: [], probation: 0, probFrom: -1,
    stuck: 0, lastDown: null, minMs: 99, minAge: 0, changes: 0, clock: 0, saveAt: 0,
  };
  const stats = { fps: 0, ms: 0, p95: 0, rung: 0, rungs: 0, set: '', pr: 1, mp: 0, target: 60, capped: false, changes: 0, mode: game.qualityMode, hz: 60 };
  const log = [];
  const auto = () => game.qualityMode === 'auto' && !!game.auto;

  function publish() {
    const A = game.auto;
    stats.mode = game.qualityMode;
    stats.target = +(1000 / st.target).toFixed(1); stats.capped = st.capped; stats.changes = st.changes;
    if (A) {
      const R = A.ladder.rungs[A.rung];
      stats.rung = A.rung; stats.rungs = A.ladder.rungs.length; stats.set = R?.set || ''; stats.pr = R?.pr || 1; stats.mp = R?.mp || 0;
    } else { stats.rung = -1; stats.rungs = 0; stats.set = game.quality?.name || ''; stats.pr = game.size?.dpr || 1; }
  }

  function setRung(i, reason = 'manual') {
    const A = game.auto;
    if (!A) return false;
    const n = A.ladder.rungs.length;
    i = Math.max(0, Math.min(n - 1, i | 0));
    if (i === A.rung) return false;
    const from = A.rung;
    A.rung = i;
    const R = A.ladder.rungs[i];
    // shadows are a boot key: giving them up needs a recompile (one hitch), so it happens once, on the way down into
    // the cheap sets, and they stay off for the session
    let recompiled = false;
    if (!A.shadowsOff && game.quality?.shadows > 0 && (R.set === 'bare' || R.set === 'low') && i < from) { A.shadowsOff = true; recompiled = true; }
    game.applyQuality(autoQuality(game.device, R, { shadowsOff: A.shadowsOff, index: i }));
    st.skip = recompiled ? 2.5 : config.settle; st.acc = 0; st.n = 0; st.slow = 0; st.good = 0;
    st.changes++;
    log.push({ t: +st.clock.toFixed(1), from, to: i, set: R.set, pr: R.pr, reason, ms: +stats.ms.toFixed(1) });
    if (log.length > 40) log.shift();
    st.saveAt = st.clock + 4;                       // saved once it has held for a few seconds
    publish();
    game.events.emit('perf:rung', { rung: i, from, set: R.set, pr: R.pr, reason });
    return true;
  }

  /** One finished window: `ms` trimmed mean, `p95`. */
  function judge(ms, p95) {
    stats.ms = ms; stats.p95 = p95; stats.fps = 1000 / ms;
    // the display's own pace: the fastest window seen lately (a 120 Hz screen shows ~8.3 ms when the game is light)
    if (ms < st.minMs || st.minAge > 120) { st.minMs = ms; st.minAge = 0; }
    stats.hz = Math.round(1000 / Math.max(4, st.minMs));
    if (!auto()) return;
    const A = game.auto, n = A.ladder.rungs.length, r = A.rung, T = st.target;

    // a cap that went away (Low Power Mode off): back to 60
    if (st.capped && ms < T * 0.8) { st.capped = false; st.target = T60; st.slow = 0; st.good = 0; note('cap lifted'); return; }

    const over = ms / T;
    if (over > config.slow) { st.slow++; st.good = 0; } else if (over <= goodLimit()) { st.good++; st.slow = 0; } else { st.slow = 0; st.good = 0; }

    // a rung climbed to that has held long past its probation is trusted again
    if (st.upAt[r] !== undefined && st.clock - st.upAt[r] >= config.regret) { if (st.fail[r] > 0) st.fail[r]--; st.upAt[r] = undefined; }

    // probation of a rung just climbed to
    if (st.probation > 0) {
      if (over > config.slow) {
        const back = st.probFrom >= 0 ? st.probFrom : r - 1;
        failed(r);
        st.probation = 0; st.probFrom = -1; st.upAt[r] = undefined;
        setRung(back, 'probe failed');
        return;
      }
      if (--st.probation === 0) st.probFrom = -1;
    }

    if (over > config.verySlow || st.slow >= 2) {
      // did the last step down buy anything? Steps that did not (three in a row, or one that ended on the lowest
      // rung): the page is capped or CPU-bound — they are taken back and the pace it does hold becomes the target
      let origin = r;
      if (st.lastDown && st.lastDown.to === r) {
        if (ms > st.lastDown.ms * config.stuckGain) { st.stuck++; origin = st.lastDown.origin; } else st.stuck = 0;
      } else st.stuck = 0;
      if (st.stuck >= config.stuckSteps || (r === 0 && st.stuck > 0)) {
        const back = Math.min(n - 1, origin);
        st.capped = true; st.target = Math.max(T60, ms * 1.02); st.stuck = 0; st.lastDown = null; st.slow = 0; st.good = 0;
        st.block.length = 0; st.fail.length = 0; st.upAt.length = 0; st.probation = 0;
        note(`capped at ${(1000 / ms).toFixed(0)} fps`);
        if (back !== r) setRung(back, 'capped: steps taken back');
        return;
      }
      if (r === 0) { st.slow = 0; return; }             // the lowest rung: nothing left to give up
      const k = over > 1.8 ? 3 : over > 1.35 ? 2 : 1;
      const to = Math.max(0, r - k);
      st.lastDown = { to, ms, origin };
      // the rung held its probation in a quiet sky and failed in a fight: it failed like a probe (the back-off doubles);
      // any other rung given up is left alone for a short while
      if (st.upAt[r] !== undefined && st.clock - st.upAt[r] < config.regret) failed(r);
      for (let i = to + 1; i <= r; i++) { st.block[i] = Math.max(st.block[i] || 0, st.clock + config.rest); st.upAt[i] = undefined; }
      setRung(to, `slow ${ms.toFixed(1)} ms`);
      return;
    }

    if (st.good >= config.upWindows && r < n - 1) {
      if (st.clock < (st.block[r + 1] || 0)) { st.good = config.upWindows - 2; return; }
      st.probation = config.probation; st.probFrom = r; st.lastDown = null; st.stuck = 0;
      st.upAt[r + 1] = st.clock;
      setRung(r + 1, 'headroom');
    }
  }
  /** Rung i could not hold the target: not tried again for backoff × 2^(times it failed before) s. */
  function failed(i) {
    const f = st.fail[i] || 0;
    st.block[i] = st.clock + Math.min(config.backoffMax, config.backoff * Math.pow(2, f));
    st.fail[i] = Math.min(6, f + 1);
  }
  const goodLimit = () => (stats.hz > config.fastHz && !st.capped ? config.fastGood : config.good);
  function note(text) { log.push({ t: +st.clock.toFixed(1), note: text }); if (log.length > 40) log.shift(); }

  /** The view changed size (rotation, fullscreen, a window resize): the ladder is rebuilt, the rung kept. */
  function onResize() {
    const A = game.auto;
    if (!auto()) return;
    const w = Math.max(1, window.innerWidth), h = Math.max(1, window.innerHeight);
    if (Math.abs(w - A.w) < 2 && Math.abs(h - A.h) < 2) return;
    const cur = A.ladder.rungs[A.rung];
    const ladder = buildLadder(game.device, w, h);
    const at = Math.max(0, nearestRung(ladder.rungs, cur));
    game.auto = { ...A, ladder, rung: at, key: perfKey(game.device, w, h), w, h };
    st.block.length = 0; st.fail.length = 0; st.upAt.length = 0; st.probation = 0; st.lastDown = null; st.stuck = 0;
    st.skip = config.settle; st.acc = 0; st.n = 0;
    game.applyQuality(autoQuality(game.device, ladder.rungs[at], { shadowsOff: A.shadowsOff, index: at }));
    publish();
  }

  const perf = {
    name: 'perf',
    config, stats, log,
    get rung() { return game.auto ? game.auto.rung : -1; },
    get ladder() { return game.auto ? game.auto.ladder.rungs : []; },
    get state() { return st; },
    setRung,
    /** No changes (and no measuring) for `seconds`: loading, a cinematic cut, a menu opening. */
    hold(seconds = 1) { st.hold = Math.max(st.hold, +seconds || 0); },
    init() {
      game.events.on('resize', onResize);
      game.events.on('qualitymode', () => {
        st.target = T60; st.capped = false; st.block.length = 0; st.fail.length = 0; st.upAt.length = 0; st.probation = 0; st.lastDown = null; st.stuck = 0;
        st.slow = 0; st.good = 0; st.skip = config.settle; st.acc = 0; st.n = 0;
        publish();
      });
      // a new scene compiles shaders and uploads buffers: those frames say nothing about the device
      game.events.on('state', ({ next } = {}) => { if (next === 'play') perf.hold(1.2); });
      game.events.on('phase', () => perf.hold(0.8));
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { st.skip = 1; st.acc = 0; st.n = 0; });
      publish();
    },
    update(simDt, realDt) {
      const dt = +realDt || 0;
      st.clock += dt; st.minAge += dt;
      if (st.saveAt && st.clock >= st.saveAt && game.auto) {
        st.saveAt = 0;
        const A = game.auto;
        saveRung(A.key, A.ladder.rungs[A.rung], { shadowsOff: !!A.shadowsOff });
      }
      if (game.state === 'loading' || (typeof document !== 'undefined' && document.hidden)) { st.acc = 0; st.n = 0; return; }
      if (st.hold > 0) { st.hold -= dt; st.acc = 0; st.n = 0; return; }
      if (st.skip > 0) { st.skip -= dt; return; }
      if (!(dt > 0.0005)) return;
      if (st.n < st.buf.length) st.buf[st.n++] = dt * 1000;
      st.acc += dt;
      if (st.acc < config.window || st.n < config.minFrames) {
        // a very slow device never fills minFrames in a window: judge what there is after 1.6 s
        if (!(st.acc >= 1.6 && st.n >= 8)) return;
      }
      const a = st.buf.subarray(0, st.n);
      a.sort();
      const keep = Math.max(1, Math.round(st.n * (1 - config.trim)));
      let sum = 0;
      for (let i = 0; i < keep; i++) sum += a[i];
      const ms = sum / keep, p95 = a[Math.min(st.n - 1, Math.floor(st.n * 0.95))];
      st.acc = 0; st.n = 0;
      judge(ms, p95);
      publish();
    },
  };
  return perf;
}
