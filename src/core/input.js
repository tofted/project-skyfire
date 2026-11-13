// Raw input: keyboard, mouse (pointer lock during play), wheel, touch and gamepad.
// Systems read game.input; they never add their own DOM listeners for gameplay keys.
//   input.down(code)      — key/button held (codes: KeyboardEvent.code, 'Mouse0' LMB, 'Mouse1' MMB, 'Mouse2' RMB)
//   input.pressed(code)   — became down since the previous consumed frame (edge)
//   input.released(code)
//   input.mouse.dx/dy     — accumulated mouse movement (px) since the last endFrame()
//   input.wheel           — accumulated wheel delta since the last endFrame()
//   input.pad             — {lx, ly, rx, ry, lt, rt, buttons[]} of the first gamepad, or null
// Edges are latched per render frame: endFrame() is called by the core after lateUpdate.
// Touch (ui/touch.js, system 'touchUI'): the touch layer holds virtual codes (press / release, the same codes the keyboard
// and mouse use) and adds to mouse.dx / dy and wheel. The browser's compatibility mouse events that follow a touch never
// reach the mouse code here (UIEvent.sourceCapabilities.firesTouchEvents, else "within 700 ms of a touch"), so a tap is
// never also a click of LMB (= breath). While game.touchUI.active there is no pointer lock (requestLock() does nothing).
// input.beforeFrame: hooks run at the start of update() (the first thing of every frame): the touch layer applies the
// stick's keys there, on the frame clock, so its timing rules (chord guards, the dash flick) see what the pilot sees.
// Without a touch system (sandboxes) one finger on the canvas still drags the view as before.
export const COMPAT_MS = 700;

export function createInput(game) {
  const held = new Set();
  let pressedNow = new Set(), releasedNow = new Set();
  const mouse = { x: 0, y: 0, dx: 0, dy: 0, locked: false, lastMoveTime: 0 };
  const canvas = game.canvas;
  let lastTouchAt = -1e9;               // performance.now() of the last touch / touch pointer event anywhere
  let quietUnlock = false;              // exitLock({ quiet }) in progress: the unlock is not a "pause" signal
  const touchUI = () => game.touchUI || null;

  /** 'touch' | 'mouse' from the event's source capabilities (Chrome / Edge), null when the browser does not say. */
  const source = (e) => {
    const sc = e.sourceCapabilities;
    return sc && typeof sc.firesTouchEvents === 'boolean' ? (sc.firesTouchEvents ? 'touch' : 'mouse') : null;
  };
  /** A compatibility mouse event the browser made from a touch (never a real mouse). */
  const fromTouch = (e) => { const s = source(e); return s ? s === 'touch' : performance.now() - lastTouchAt < COMPAT_MS; };
  const noteTouch = () => { lastTouchAt = performance.now(); };

  const onKeyDown = (e) => {
    if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    if (['Space', 'ArrowUp', 'ArrowDown', 'Tab', 'AltLeft', 'AltRight'].includes(e.code)) e.preventDefault();
    if (!held.has(e.code) && !input.virtual.has(e.code)) pressedNow.add(e.code);
    held.add(e.code);
  };
  const onKeyUp = (e) => { held.delete(e.code); if (!input.virtual.has(e.code)) releasedNow.add(e.code); };
  const onMouseDown = (e) => {
    if (fromTouch(e)) return;
    const c = 'Mouse' + e.button;
    if (!held.has(c) && !input.virtual.has(c)) pressedNow.add(c);
    held.add(c);
  };
  const onMouseUp = (e) => {
    const c = 'Mouse' + e.button;
    // a compat mouseup from a tap: ignored — unless (browsers without sourceCapabilities) a real press is being held
    const s = source(e);
    if (s === 'touch' || (s === null && performance.now() - lastTouchAt < COMPAT_MS && !held.has(c))) return;
    held.delete(c);
    if (!input.virtual.has(c)) releasedNow.add(c);
  };
  const onMouseMove = (e) => {
    if (fromTouch(e)) return;
    mouse.x = e.clientX; mouse.y = e.clientY;
    if (document.pointerLockElement === canvas || input.dragOrbit) {
      mouse.dx += e.movementX || 0; mouse.dy += e.movementY || 0;
    }
    mouse.lastMoveTime = performance.now();
  };
  const onWheel = (e) => { input.wheel += e.deltaY; if (game.state === 'play' || game.state === 'photo') e.preventDefault(); };
  const onBlur = () => { for (const c of held) releasedNow.add(c); held.clear(); input.releaseVirtual('blur'); };
  const onLockChange = () => {
    mouse.locked = document.pointerLockElement === canvas;
    if (quietUnlock && !mouse.locked) { quietUnlock = false; return; }     // the touch layout took over: no pause
    game.events.emit('pointerlock', { locked: mouse.locked });
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  canvas.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup', onMouseUp);
  window.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', () => { if (document.hidden) input.releaseVirtual('hidden'); });
  document.addEventListener('pointerlockchange', onLockChange);
  for (const n of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) window.addEventListener(n, noteTouch, { capture: true, passive: true });
  for (const n of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
    window.addEventListener(n, (e) => { if (e.pointerType === 'touch') noteTouch(); }, { capture: true, passive: true });
  }

  // Fallback without the touch system (sandboxes): one finger on the canvas = look / aim drag, as before.
  const touch = { active: false, id: -1, lx: 0, ly: 0 };
  canvas.addEventListener('touchstart', (e) => {
    if (touchUI()) return;
    const t = e.changedTouches[0];
    touch.active = true; touch.id = t.identifier; touch.lx = t.clientX; touch.ly = t.clientY;
  }, { passive: true });
  canvas.addEventListener('touchmove', (e) => {
    if (touchUI()) return;
    for (const t of e.changedTouches) if (t.identifier === touch.id) {
      mouse.dx += (t.clientX - touch.lx) * 1.5; mouse.dy += (t.clientY - touch.ly) * 1.5;
      touch.lx = t.clientX; touch.ly = t.clientY;
    }
  }, { passive: true });
  canvas.addEventListener('touchend', () => { touch.active = false; }, { passive: true });

  const input = {
    name: 'input',
    mouse, touch, wheel: 0, pad: null, dragOrbit: false,
    virtual: new Set(),               // on-screen controls hold codes here (touch UI)
    /** Functions run at the start of every frame, before the fixed steps read the edges (the touch layer applies its
     *  held keys here, on the frame clock game.time.real — the clock the pilot's key reader uses). */
    beforeFrame: [],
    down: (c) => held.has(c) || input.virtual.has(c),
    pressed: (c) => pressedNow.has(c),
    released: (c) => releasedNow.has(c),
    anyDown: (...cs) => cs.some((c) => input.down(c)),
    anyPressed: (...cs) => cs.some((c) => pressedNow.has(c)),
    /** Hold a virtual code (an edge only when the code was not already down by a key or another control). */
    press(c) { if (!held.has(c) && !input.virtual.has(c)) pressedNow.add(c); input.virtual.add(c); },
    /** Let a virtual code go (an edge only when no real key still holds it). */
    release(c) { input.virtual.delete(c); if (!held.has(c)) releasedNow.add(c); },
    /** Let every virtual code go (blur, tab hidden, the touch layer's releaseAll). */
    releaseVirtual(reason = '') {
      if (!input.virtual.size) return 0;
      const n = input.virtual.size;
      for (const c of [...input.virtual]) input.release(c);
      return n;
    },
    /** performance.now() of the last touch anywhere (compat-mouse guard; tests). */
    get lastTouchAt() { return lastTouchAt; },
    requestLock() {
      if (touchUI()?.active) return;              // the touch layout never locks the pointer
      if (document.pointerLockElement !== canvas && canvas.requestPointerLock) {
        // Only ever called from a user gesture. If raw (unadjusted) movement is refused, retry plain lock at once while
        // the gesture is still valid; a rejection outside a gesture is expected and swallowed.
        const plain = () => { try { const q = canvas.requestPointerLock(); if (q && q.catch) q.catch(() => {}); } catch { /* not allowed now */ } };
        try {
          const p = canvas.requestPointerLock({ unadjustedMovement: true });
          if (p && p.catch) p.catch((e) => { if (e && e.name === 'NotSupportedError') plain(); });
        } catch { plain(); }
      }
    },
    /** Leave pointer lock. { quiet: true } — the touch layout took over: the unlock does not emit 'pointerlock'
     *  (which the camera answers with a pause). */
    exitLock(opts) {
      if (document.pointerLockElement === canvas) {
        if (opts && opts.quiet) quietUnlock = true;
        document.exitPointerLock();
      }
    },
    update(simDt) {
      // (input is also a registered system: game.frame() calls update() first with no arguments — the frame start —
      // and again in the update phase with (simDt, realDt, game); the hooks run at the frame start only)
      if (simDt === undefined) {
        for (const fn of input.beforeFrame) { try { fn(); } catch (e) { if (!input._bfWarned) { input._bfWarned = true; console.warn('[input] beforeFrame', e); } } }
      }
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      const p = pads && [...pads].find((x) => x && x.connected);
      if (p) {
        const dz = (v) => (Math.abs(v) < 0.12 ? 0 : v);
        input.pad = {
          lx: dz(p.axes[0] || 0), ly: dz(p.axes[1] || 0), rx: dz(p.axes[2] || 0), ry: dz(p.axes[3] || 0),
          lt: p.buttons[6]?.value || 0, rt: p.buttons[7]?.value || 0,
          buttons: p.buttons.map((b) => b.pressed),
        };
      } else input.pad = null;
    },
    endFrame() {
      pressedNow = new Set(); releasedNow = new Set();
      mouse.dx = 0; mouse.dy = 0; input.wheel = 0;
    },
  };
  return input;
}
