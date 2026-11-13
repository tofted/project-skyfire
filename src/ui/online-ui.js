// The pilot's panels (game.online is the data): the account chip on the title, the Account panel (sign in / create
// an account / the pilot's profile; a plain pilot name when the copy has no online setup), the Leaderboard panel and
// the Stage select. Built like screens.js builds Settings: a .panel with a Nav, opened through the HUD's openPanel().
//   buildOnlineUi(api, game) → { chip, panels: { account, leaderboard, stages }, resultsText(last) }
// Text inputs keep their keys to themselves (the menus' W / S / Space / Backspace would otherwise act on a typed
// letter): only Esc, Tab and ↑ ↓ reach the menu navigation.
import { h, s, fmt } from './dom.js';
import { Nav, onTap, guardPanel } from './screens.js';
import { BOARDS, NAME_MAX, nameProblem, reachedText, clock } from '../online/names.js';

const BOARD_LABEL = { story: 'Story', titan: 'Face the Titan', survival: 'Survival' };
const BOARD_SUB = {
  story: 'A whole run, from the Aerial Patrol to the Cloud Titan',
  titan: 'The boss battle on its own',
  survival: 'Endless waves',
};
/** The stage select's cards: [name, what waits there, its sky]. */
const STAGE_INFO = {
  intro: ['Aerial Patrol', 'First contact over the valley', 'Afternoon'],
  riders1: ['Shade Riders', 'Four riders and a drake flock', 'Afternoon'],
  riders2: ['The Shade Wing', 'Six riders, two flocks', 'Afternoon'],
  riders3: ['The Onyx Aces', 'Morrow and Vael lead the wing', 'Golden hour'],
  riders4: ['The Drake Tide', 'Flock after flock from the cloud sea', 'Dusk'],
  riders5: ['The Twilight Lancers', 'A veteran wing and Ace Sable', 'Night'],
  riders6: ['The Night Court', 'Three aces under the aurora', 'Aurora'],
  'titan-rise': ['The Cloud Titan', 'The boss battle', 'Storm'],
};

const btn = (label, onClick, cls = '') => onTap(h('button.pbtn' + (cls ? '.' + cls : ''), { type: 'button', text: label }), onClick);
/** A labelled text input that keeps typed keys away from the menu navigation. onEnter: the form's submit. */
function field(label, attrs, onEnter) {
  const input = h('input.of-in', { spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off', ...attrs });
  input.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' || e.code === 'Tab' || e.code === 'ArrowDown' || e.code === 'ArrowUp') return;
    e.stopPropagation();
    if (e.code === 'Enter' || e.code === 'NumpadEnter') { e.preventDefault(); onEnter?.(); }
  });
  for (const t of ['keyup', 'keypress']) input.addEventListener(t, (e) => e.stopPropagation());
  const el = h('label.of-f', {}, h('span.of-l', { text: label }), input);
  return { el, input, item: { el, focusEl: input } };
}

export function buildOnlineUi(api, game) {
  const O = () => game.online || null;
  const sound = (n) => { try { api.sound?.(n); } catch { /* optional */ } };

  // ================================================================================================ title chip
  const chipName = h('span.oc-n'), chipSub = h('span.oc-s');
  const chip = onTap(h('button.ochip', { type: 'button', 'aria-label': 'Pilot account' },
    h('i.oc-av', {}, s('svg', { viewBox: '0 0 24 24' }, s('path', { d: 'M12 12.2a4.3 4.3 0 1 0 0-8.6 4.3 4.3 0 0 0 0 8.6Zm-7.6 8.2c.5-3.9 3.6-6.2 7.6-6.2s7.1 2.3 7.6 6.2' }))),
    h('span.oc-t', {}, chipName, chipSub)), () => api.openPanel('account'));
  function syncChip() {
    const o = O();
    if (!o) { chip.hidden = true; return; }
    chip.hidden = false;
    const signed = !!o.user;
    chip.classList.toggle('in', signed);
    chip.classList.toggle('ask', o.mode === 'online' && !signed && o.status === 'ready');
    if (o.mode === 'local') { chipName.textContent = o.localName || 'Set pilot name'; chipSub.textContent = 'Pilot'; }
    else if (o.status === 'loading') { chipName.textContent = 'Connecting…'; chipSub.textContent = 'Online'; }
    else if (o.status === 'error') { chipName.textContent = 'Offline'; chipSub.textContent = 'Online play'; }
    else if (signed) { chipName.textContent = o.user.name; chipSub.textContent = 'Signed in'; }
    else { chipName.textContent = 'Sign in'; chipSub.textContent = 'to rank on the leaderboard'; }
  }

  // ================================================================================================ account panel
  const account = (() => {
    const nav = new Nav([], { onBack: () => api.closePanel(), sound: api.sound });
    const msg = h('div.of-msg', { role: 'status' });
    let tab = 'in', busy = false, shown = null;
    const say = (text, kind = '') => { msg.textContent = text || ''; msg.className = 'of-msg' + (kind ? ' ' + kind : ''); };
    const explain = (e) => { try { return O()?.explain(e) || String(e?.message || e); } catch { return String(e?.message || e); } };
    /** Run an account action: one at a time, the buttons disabled meanwhile, the outcome in the message line. */
    async function act(fn, working, done) {
      if (busy) return;
      busy = true; el.classList.add('busy'); say(working || 'Working…');
      try { const r = await fn(); say(typeof done === 'function' ? done(r) : done || '', 'ok'); sound('uiSelect'); }
      catch (e) { say(explain(e), 'err'); sound('uiBack'); }
      finally { busy = false; el.classList.remove('busy'); refresh(); }
    }

    // ---- signed out: sign in / create an account
    const tabs = h('div.seg.of-tabs', { role: 'tablist' });
    const tIn = onTap(h('button', { type: 'button', role: 'tab', text: 'Sign in' }), () => setTab('in'));
    const tUp = onTap(h('button', { type: 'button', role: 'tab', text: 'Create account' }), () => setTab('up'));
    tabs.append(tIn, tUp);
    const submit = () => {
      const email = fEmail.input.value.trim(), pw = fPass.input.value;
      if (tab === 'up') {
        const bad = nameProblem(fName.input.value);
        if (bad) { say(bad, 'err'); fName.input.focus(); return; }
        if (!email) { say('Enter your email address.', 'err'); fEmail.input.focus(); return; }
        if (pw.length < 6) { say('Pick a password with at least 6 characters.', 'err'); fPass.input.focus(); return; }
        act(() => O().signUp(email, pw, fName.input.value), 'Creating your account…', (u) => `Welcome, ${u?.name || 'pilot'}. Your best runs now go on the leaderboard.`);
      } else {
        if (!email || !pw) { say('Enter your email and password.', 'err'); (email ? fPass : fEmail).input.focus(); return; }
        act(() => O().signIn(email, pw), 'Signing in…', (u) => `Welcome back, ${u?.name || 'pilot'}.`);
      }
    };
    const fName = field('Pilot name', { type: 'text', maxlength: String(NAME_MAX), autocomplete: 'nickname', placeholder: 'Shown on the leaderboard' }, submit);
    const fEmail = field('Email', { type: 'email', autocomplete: 'email', inputmode: 'email', placeholder: 'you@example.com' }, submit);
    const fPass = field('Password', { type: 'password', autocomplete: 'current-password', placeholder: 'At least 6 characters' }, submit);
    const go = btn('Sign in', submit, 'primary');
    const forgot = onTap(h('button.of-link', { type: 'button', text: 'Forgot your password?' }), () => {
      const email = fEmail.input.value.trim();
      if (!email) { say('Type your email above first, then press this again.', 'err'); fEmail.input.focus(); return; }
      act(() => O().resetPassword(email), 'Sending…', `If ${email} has an account, a reset link is on its way.`);
    });
    const google = btn('Continue with Google', () => act(() => O().signInGoogle(), 'Waiting for Google…', (u) => `Welcome, ${u?.name || 'pilot'}.`), 'of-google');
    const guestNote = h('div.of-note', { text: 'No account? You can still play — your runs are kept on this device and posted when you sign in.' });
    const vAuth = h('div.of-view', {}, tabs, fName.el, fEmail.el, fPass.el, h('div.of-row', {}, go, forgot), google, guestNote);
    function setTab(t, quiet = false) {
      tab = t; if (!quiet) { sound('uiMove'); say(''); }
      tIn.classList.toggle('sel', t === 'in'); tUp.classList.toggle('sel', t === 'up');
      tIn.setAttribute('aria-selected', String(t === 'in')); tUp.setAttribute('aria-selected', String(t === 'up'));
      fName.el.hidden = t !== 'up';
      forgot.hidden = t !== 'in';
      go.textContent = t === 'up' ? 'Create account' : 'Sign in';
      fPass.input.autocomplete = t === 'up' ? 'new-password' : 'current-password';
    }

    // ---- signed in: the pilot's profile
    const pName = h('b.op-name'), pMail = h('span.op-mail');
    const saveName = () => act(() => O().setName(fRename.input.value), 'Saving…', (n) => `Pilot name saved${typeof n === 'string' ? `: ${n}` : ''}.`);
    const fRename = field('Pilot name', { type: 'text', maxlength: String(NAME_MAX), autocomplete: 'nickname' }, saveName);
    const rename = btn('Save name', saveName);
    const standEls = {};
    const stands = h('div.op-stands', {}, ...BOARDS.map((b) => {
      const v = h('b', { text: '—' }), r = h('span', { text: '' });
      standEls[b] = { v, r };
      return h('div.op-stand', {}, h('i', { text: BOARD_LABEL[b] }), v, r);
    }));
    const out = btn('Sign out', () => act(() => O().signOut(), 'Signing out…', 'Signed out. Your runs stay on this device.'));
    const toBoard = btn('Leaderboard', () => api.openPanel('leaderboard'));
    const vProfile = h('div.of-view', {}, h('div.op-head', {}, h('i.op-av', { text: '' }), h('div', {}, pName, pMail)),
      h('div.of-row.of-rename', {}, fRename.el, rename), stands, h('div.of-row', {}, toBoard, out));

    // ---- no online setup: a pilot name for this device
    const saveLocal = () => act(() => O().setName(fLocal.input.value), 'Saving…', (n) => `Pilot name saved: ${n}.`);
    const fLocal = field('Pilot name', { type: 'text', maxlength: String(NAME_MAX), autocomplete: 'nickname', placeholder: 'Shown next to your runs' }, saveLocal);
    const localSave = btn('Save name', saveLocal, 'primary');
    const vLocal = h('div.of-view', {},
      h('div.of-note.big', { text: 'This copy of Skyfire is not connected to an online leaderboard yet, so there are no accounts to sign in to. Your best runs and stage progress are kept on this device.' }),
      h('div.of-row.of-rename', {}, fLocal.el, localSave),
      h('div.of-note', { text: 'Hosting the game yourself? Fill in firebase-config.js (README.md has the steps) and this panel becomes sign-in.' }));
    // ---- connecting / failed
    const waitText = h('div.of-note.big');
    const vWait = h('div.of-view', {}, waitText);

    const back = btn('Back', () => api.closePanel());
    for (const it of [{ el: tabs, focusEl: tIn, left: () => setTab('in'), right: () => setTab('up'), activate: () => setTab(tab === 'in' ? 'up' : 'in') },
      fName.item, fEmail.item, fPass.item, { el: go }, { el: forgot }, { el: google },
      fRename.item, { el: rename }, { el: toBoard }, { el: out }, fLocal.item, { el: localSave }, { el: back }]) nav.add(it);
    const title = h('div.pn-h', { text: 'Pilot account' });
    const el = guardPanel(h('div.panel.onl.acct', { role: 'dialog', 'aria-label': 'Pilot account' }, title, vAuth, vProfile, vLocal, vWait, msg, h('div.pn-foot', {}, back)));
    setTab('in');

    let standFor = null;
    async function loadStandings() {
      const o = O();
      if (!o?.user) return;
      const uid = o.user.uid;
      standFor = uid;
      for (const b of BOARDS) {
        try {
          const st = await o.standing(b);
          if (standFor !== uid) return;
          standEls[b].v.textContent = st.best ? fmt(st.best.score) : '—';
          standEls[b].r.textContent = st.best ? (st.rank ? `#${st.rank}` : '') : 'no run yet';
        } catch (e) { standEls[b].r.textContent = ''; console.warn('[online-ui] standing', e); }
      }
    }
    function refresh() {
      const o = O();
      const mode = !o ? 'local' : o.mode === 'local' ? 'local' : o.status !== 'ready' ? 'wait' : o.user ? 'profile' : 'auth';
      vAuth.hidden = mode !== 'auth'; vProfile.hidden = mode !== 'profile'; vLocal.hidden = mode !== 'local'; vWait.hidden = mode !== 'wait';
      // back at the sign-in form after a sign-out (or signed in: the password does not stay in the field)
      if (mode !== shown) { if (mode === 'auth' && shown === 'profile') setTab('in', true); if (mode === 'profile' || shown === 'profile') fPass.input.value = ''; shown = mode; }
      title.textContent = mode === 'profile' ? 'Pilot' : mode === 'local' ? 'Pilot name' : 'Pilot account';
      google.hidden = !o?.google;
      if (mode === 'wait') waitText.textContent = o.status === 'loading' ? 'Connecting to the leaderboard server…' : (o.error || 'Online play is not available right now.') + ' You can still play: your runs are kept on this device.';
      if (mode === 'profile') {
        pName.textContent = o.user.name; pMail.textContent = o.user.email || '';
        vProfile.querySelector('.op-av').textContent = (o.user.name || 'P').trim().charAt(0).toUpperCase();
        if (document.activeElement !== fRename.input) fRename.input.value = o.user.name;
        loadStandings();
      }
      if (mode === 'local' && document.activeElement !== fLocal.input) fLocal.input.value = o?.localName || '';
      if (Nav.hidden(nav.items[nav.i])) nav.focus(nav.i, true);
    }
    return { el, nav, refresh, say };
  })();

  // ================================================================================================ leaderboard panel
  const leaderboard = (() => {
    const nav = new Nav([], { onBack: () => api.closePanel(), sound: api.sound });
    let board = 'story', token = 0;
    const cache = new Map();               // board → { at, rows, source }
    const tabs = h('div.seg.lb-tabs', { role: 'tablist' });
    const tabEls = {};
    for (const b of BOARDS) { tabEls[b] = onTap(h('button', { type: 'button', role: 'tab', text: BOARD_LABEL[b] }), () => setBoard(b)); tabs.append(tabEls[b]); }
    const sub = h('div.lb-sub'), src = h('span.lb-src');
    const refreshBtn = onTap(h('button.of-link.lb-ref', { type: 'button', text: 'Refresh' }), () => { cache.delete(board); sound('uiSelect'); load(); });
    const head = h('div.lb-row.lb-head', {}, h('span.c-r', { text: '#' }), h('span.c-n', { text: 'Pilot' }), h('span.c-s', { text: 'Score' }),
      h('span.c-g', { text: 'Rank' }), h('span.c-w', { text: 'Reached' }), h('span.c-t', { text: 'Time' }), h('span.c-l', { text: 'LV' }));
    const list = h('div.lb-list', { tabindex: '-1' });
    const state = h('div.lb-state');
    const mine = h('div.lb-mine');
    const signIn = btn('Sign in to rank', () => api.openPanel('account'), 'primary');
    const back = btn('Back', () => api.closePanel());
    nav.add({ el: tabs, getFocus: () => tabEls[board], left: () => step(-1), right: () => step(1), activate: () => step(1) });
    nav.add({ el: refreshBtn }); nav.add({ el: signIn }); nav.add({ el: back });
    const el = guardPanel(h('div.panel.wide.onl.lb', { role: 'dialog', 'aria-label': 'Leaderboard' }, h('div.pn-h', { text: 'Leaderboard' }),
      tabs, h('div.lb-bar', {}, sub, h('span.lb-right', {}, src, refreshBtn)), head, list, state, h('div.pn-foot.lb-foot', {}, mine, signIn, back)));
    function step(d) { setBoard(BOARDS[(BOARDS.indexOf(board) + d + BOARDS.length) % BOARDS.length]); }
    function setBoard(b) {
      if (!BOARDS.includes(b)) return;
      board = b; sound('uiMove');
      for (const k of BOARDS) { tabEls[k].classList.toggle('sel', k === b); tabEls[k].setAttribute('aria-selected', String(k === b)); }
      sub.textContent = BOARD_SUB[b];
      el.dataset.board = b;
      load();
    }
    function rowEl(r, i, me) {
      const you = me && r.uid && r.uid === me;
      return h('div.lb-row' + (you ? '.you' : '') + (i < 3 ? '.top' + (i + 1) : ''), {},
        h('span.c-r', { text: String(i + 1) }), h('span.c-n', {}, h('b', { text: r.name || 'Pilot' }), you ? h('i', { text: 'YOU' }) : null),
        h('span.c-s', { text: fmt(r.score) }), h('span.c-g' + (r.grade ? '.g-' + r.grade.toLowerCase() : ''), { text: r.grade || '—' }),
        h('span.c-w', { text: reachedText(board, r) }), h('span.c-t', { text: clock(r.time) }), h('span.c-l', { text: String(r.level || 1) }));
    }
    function show(data) {
      const o = O(), me = o?.user?.uid || null;
      list.replaceChildren(...data.rows.map((r, i) => rowEl(r, i, me)));
      state.textContent = data.rows.length ? '' : data.source === 'local' ? 'No runs on this device yet. Fly one and it shows up here.' : 'Nobody has posted a run here yet. Be the first.';
      state.className = 'lb-state';
      src.textContent = data.source === 'local' ? 'This device' : 'Global';
      list.scrollTop = 0;
    }
    async function standing(my) {
      const o = O();
      signIn.hidden = !(o && o.mode === 'online' && o.status === 'ready' && !o.user);
      mine.textContent = '';
      if (!o) return;
      if (o.mode === 'online' && !o.user) {
        const lb = o.localBest(board);
        mine.textContent = lb ? `Your best on this device: ${fmt(lb.score)} — sign in to post it.` : '';
        return;
      }
      try {
        const st = await o.standing(board);
        if (my !== token) return;
        mine.textContent = st.best ? `Your best: ${fmt(st.best.score)}${st.rank ? `  ·  #${st.rank}` : ''}` : o.user ? 'You have no run on this board yet.' : '';
      } catch (e) { console.warn('[online-ui] standing', e); }
    }
    async function load() {
      const o = O(), my = ++token;
      if (!o) { state.textContent = 'The leaderboard is not available.'; return; }
      standing(my);
      const hit = cache.get(board);
      if (hit && performance.now() - hit.at < 30000) { show(hit); return; }
      list.replaceChildren(); state.textContent = 'Loading…'; state.className = 'lb-state wait';
      try {
        const data = await o.top(board, 50);
        if (my !== token) return;
        cache.set(board, { ...data, at: performance.now() });
        show(data);
      } catch (e) {
        if (my !== token) return;
        state.textContent = `Could not load the leaderboard. ${o.explain(e)}`;
        state.className = 'lb-state err';
        src.textContent = '';
      }
    }
    function refresh(o = {}) {
      if (o.board && BOARDS.includes(o.board)) board = o.board;
      const on = O();
      el.classList.toggle('local', on?.mode !== 'online');
      setBoard(board);
      if (Nav.hidden(nav.items[nav.i])) nav.focus(nav.i, true);
    }
    return { el, nav, refresh, invalidate: (b) => { if (b) cache.delete(b); else cache.clear(); }, get board() { return board; }, set board(b) { if (BOARDS.includes(b)) board = b; } };
  })();

  // ================================================================================================ stage select
  const stages = (() => {
    const nav = new Nav([], { onBack: () => api.closePanel(), sound: api.sound });
    const grid = h('div.st-grid');
    const cards = [];
    const list = (() => { try { return game.director?.stages?.() || []; } catch { return []; } })();
    list.forEach((st, i) => {
      const info = STAGE_INFO[st.phase] || [st.label, '', ''];
      const best = h('span.st-best'), lock = h('span.st-lock', { text: 'Reach this stage in a run to unlock it' });
      const start = () => {
        if (card.classList.contains('locked')) { sound('uiBack'); card.animate?.([{ transform: 'translateX(0)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(5px)' }, { transform: 'translateX(0)' }], { duration: 220 }); return; }
        api.start(st.phase === 'intro' ? 'story' : st.phase === 'titan-rise' ? 'titan' : 'stage:' + st.phase);
      };
      const card = onTap(h('button.st-card.sky-' + String(info[2]).toLowerCase().replace(/\s+/g, '-'), { type: 'button' },
        h('i.st-n', { text: String(i + 1).padStart(2, '0') }), h('b.st-t', { text: info[0] }), h('span.st-s', { text: info[1] }),
        h('span.st-meta', {}, h('em', { text: info[2] }), st.level > 1 ? h('em', { text: `Start LV ${st.level}` }) : null), best, lock), start);
      cards.push({ card, best, st });
      grid.append(card);
      nav.add({ el: card });
    });
    const note = h('div.of-note', { text: 'A stage run starts Sora at that stage\'s level. Only a whole run from the Aerial Patrol counts on the Story leaderboard.' });
    const back = btn('Back', () => api.closePanel());
    nav.add({ el: back });
    const el = guardPanel(h('div.panel.wide.onl.stg', { role: 'dialog', 'aria-label': 'Stages' }, h('div.pn-h', { text: 'Stages' }), grid, note, h('div.pn-foot', {}, back)));
    function refresh() {
      const o = O(), times = o?.stageTimes || {};
      cards.forEach(({ card, best, st }, i) => {
        const open = o ? o.unlocked(i) : i === 0;
        card.classList.toggle('locked', !open);
        card.setAttribute('aria-disabled', String(!open));
        const t = times[st.phase];
        best.textContent = t > 0 ? `Best clear ${clock(t)}` : '';
      });
      if (Nav.hidden(nav.items[nav.i])) nav.focus(nav.i, true);
    }
    return { el, nav, refresh };
  })();

  // ================================================================================================ results line
  /** The line under the results' score for a posting (online.last) → { text, kind, action: 'account' | null }. */
  function resultsText(last, results) {
    if (!last) return { text: '', kind: '' };
    const B = BOARD_LABEL[last.board] || '';
    switch (last.state) {
      case 'posting': return { text: 'Posting your score…', kind: 'wait' };
      case 'posted': return { text: `${last.prev ? 'New personal best' : 'First run posted'}${last.rank ? `  ·  #${last.rank} on the ${B} board` : `  ·  ${B} board`}`, kind: 'best' };
      case 'kept': return { text: `Your best stays ${fmt(last.best?.score || 0)}${last.rank ? `  ·  #${last.rank} on the ${B} board` : ''}`, kind: '' };
      case 'guest': return { text: 'Sign in to put this score on the leaderboard', kind: 'ask', action: 'account' };
      case 'local': return { text: last.localBest ? 'New best on this device' : `Best on this device  ·  ${fmt(O()?.localBest(last.board)?.score || 0)}`, kind: last.localBest ? 'best' : '' };
      case 'error': return { text: `The score could not be posted (${last.error || 'no connection'}) — it is kept and posted next time.`, kind: 'err' };
      default:
        if (game.debugMode) return { text: 'Debug runs are not ranked', kind: '' };
        if (results?.mode === 'story' && results.from && results.from !== 'intro') return { text: 'Stage run — a whole run from the Aerial Patrol is ranked', kind: '' };
        return { text: '', kind: '' };
    }
  }

  // keep everything in step with the account
  try {
    game.events.on('online:auth', () => { syncChip(); account.refresh(); leaderboard.invalidate(); if (leaderboard.el.classList.contains('on')) leaderboard.refresh(); });
    game.events.on('online:status', () => { syncChip(); account.refresh(); });
    game.events.on('online:score', (l) => { if (l?.board && (l.state === 'posted' || l.state === 'local')) leaderboard.invalidate(l.board); });
    game.events.on('online:progress', () => { stages.refresh(); });
  } catch (e) { console.warn('[online-ui] events', e); }
  syncChip();
  return { chip, panels: { account, leaderboard, stages }, resultsText, syncChip };
}
