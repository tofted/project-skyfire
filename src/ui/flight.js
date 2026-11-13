// In-flight HUD widgets (presentational only). hud.js computes a small view-model every frame and calls
// FlightHud.update(vm); the widgets write transforms / text / CSS variables only when a value changed.
import { h, s, textSetter, styleSetter, classSetter, varSetter } from './dom.js';
import { tr, trn, lang, bindText } from './i18n.js';
import { fmtL as fmt, tplN, plN } from './markers.js';

// Languages (29.09): every word below goes through tr() (Russian: src/ui/i18n/ru-hud.js) — the DOM built once with
// bindText (a language switch rewrites it), the per-frame text with tr() / tplN (cached per language) and written only
// when it changed, as before. English is byte-identical.
// (Russian agrees with the number: (other language) 3; English says "{n} LEFT" for every n, as before)
const leftText = plN((n) => trn(n, '{n} LEFT', '{n} LEFT'));
const escText = plN((n) => trn(n, 'ESCORTS · {n} LEFT', 'ESCORTS · {n} LEFT'));
const downedText = plN((n) => trn(n, 'DOWNED', 'DOWNED'));
const vsUpText = tplN(() => tr('▲ {n} m/s'));
const vsDnText = tplN(() => tr('▼ {n} m/s'));
/** The fireball's recharge seconds: "0.9" / "2" (Russian: the decimal comma, "0,9"). */
const secs = (x) => { const v = x.toFixed(x < 1 ? 1 : 0); return lang() === 'ru' ? v.replace('.', ',') : v; };
// key caps that have words of their own in a language (the letters and Shift stay: docs/i18n.md)
const KEY_WORDS = { Space: () => tr('Space'), LMB: () => tr('LMB') };
const keyCap = (key) => (KEY_WORDS[key] ? bindText(h('span.key'), key) : h('span.key', { text: key }));

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------------------------------- icons
const ICONS = {
  breath: 'M12 3c1 4 5 5.5 5 10.5a5 5 0 0 1-10 0c0-3 2-4.2 2-7.2 1.6 1.2 2.2 2.4 2.2 4C13.6 8 13.2 5.6 12 3z',
  fireball: 'M15 5.2a4.4 4.4 0 1 1 0 8.8 4.4 4.4 0 0 1 0-8.8zM3.5 20.5l7-7M5 15.5l4-4M9 20l4-4',
  power: 'M2.5 15.5c4-1 7.2-4.2 9.5-10.5 2.3 6.3 5.5 9.5 9.5 10.5M7 15l1 4.2M12 11.5V20M17 15l-1 4.2',
  boost: 'M4.5 6.5l6 5.5-6 5.5M11.5 6.5l6 5.5-6 5.5',
  dodge: 'M5.2 13.5a7 7 0 1 0 2.6-7.1M4 4.8v4.4h4.4',
};
const icon = (d) => s('svg.ic', { viewBox: '0 0 24 24' }, s('path', { d }));

// ---------------------------------------------------------------------------------------------------- reticle
function reticleSVG() {
  const C = 66, R = 52;
  const P = (a) => `${(C + R * Math.cos(a * DEG)).toFixed(2)} ${(C + R * Math.sin(a * DEG)).toFixed(2)}`;
  const arc = (a0, a1, sweep) => `M${P(a0)} A${R} ${R} 0 0 ${sweep} ${P(a1)}`;
  const heatD = arc(128, 232, 1), stamD = arc(52, -52, 0);
  const heat = s('path.rg-heat', { d: heatD, pathLength: '100', 'stroke-dasharray': '0 100' });
  const stam = s('path.rg-stam', { d: stamD, pathLength: '100', 'stroke-dasharray': '100 100' });
  const tick = (a, r0, r1) => { const c = Math.cos(a * DEG), sn = Math.sin(a * DEG); return `M${C + c * r0} ${C + sn * r0}L${C + c * r1} ${C + sn * r1}`; };
  const hitx = s('path.hitx', { d: [45, 135, 225, 315].map((a) => tick(a, 12, 21)).join('') });
  const svg = s('svg', { viewBox: '0 0 132 132' },
    s('path.rg-bg', { d: heatD }), s('path.rg-bg', { d: stamD }), heat, stam,
    // breath range brackets (tighten and turn warm when a target is inside the flame's reach)
    s('path.br', { d: 'M44 52 L44 44 L52 44 M80 44 L88 44 L88 52 M88 80 L88 88 L80 88 M52 88 L44 88 L44 80' }),
    // heading crosshair
    s('circle.ch', { cx: C, cy: C, r: '8.5' }),
    s('path.ch', { d: [0, 90, 180, 270].map((a) => tick(a, 13, 19)).join('') }),
    s('circle.ch-dot', { cx: C, cy: C, r: '1.7' }),
    hitx);
  return { svg, heat, stam, hitx };
}

export class FlightHud {
  constructor() {
    const el = this.el = h('div.hud-fly');

    // vignettes and hit direction
    this.vigDmg = h('div.vig.vig-dmg'); this.vigLow = h('div.vig.vig-low');
    this.hitdir = h('div.hitdir', {}, h('i'));
    el.append(this.vigDmg, this.vigLow, this.hitdir);

    // objective
    this.objT = h('div.obj-t'); this.objS = h('div.obj-s');
    this.objective = h('div.objective', {}, h('i.obj-dia'), h('div', {}, bindText(h('div.obj-k'), 'Objective'), this.objT, this.objS));
    this.objective.style.display = 'none';

    // boss bar
    this.bossFill = h('i.fill'); this.bossChip = h('i.chip');
    this.bossBar = h('div.bar', {}, this.bossChip, this.bossFill);
    this.bossPhase = h('div.boss-phase'); this.bossNum = h('div'); this.bossEsc = h('div.boss-esc');
    this.boss = h('div.boss', {},
      h('div.boss-head', {}, h('div.boss-name', {}, bindText(h('span.bn-nm'), BOSS_NAME), bindText(h('small'), BOSS_TITLE)), this.bossPhase),
      this.bossBar, h('div.boss-under', {}, this.bossEsc, this.bossNum));
    this.bossTicks = [];

    // wave strip (top centre while there is no boss): "WAVE 2/3 · 6 LEFT" + progress
    this.waveT = h('span.wv-t'); this.waveL = h('span.wv-l'); this.waveFill = h('i');
    this.wave = h('div.wave', {}, h('div.wv-row', {}, h('i.wv-dia'), this.waveT, h('i.wv-dot'), this.waveL), h('div.wv-bar', {}, this.waveFill));
    el.append(this.boss, this.wave, this.objective);   // objective after boss / wave: CSS sibling rules move it down

    // kills + combo (top right)
    this.killN = h('b'); this.comboN = h('div.cb-n'); this.comboFill = h('i');
    this.killK = h('span', { text: 'DOWNED' });
    this.kills = h('div.kills', {}, h('i.kl-ic'), this.killN, this.killK);
    this.combo = h('div.combo', {}, h('div.cb-row', {}, this.comboN, bindText(h('div.cb-k'), 'COMBO')), h('div.cb-bar', {}, this.comboFill));
    this.tally = h('div.tally', {}, this.kills, this.combo);
    el.append(this.tally);

    // player panel
    this.hpFill = h('i.fill'); this.hpChip = h('i.chip');
    this.hpText = h('div.pl-hp');
    this.stFill = h('i'); this.st = h('div.pl-st', {}, this.stFill);
    this.pl = h('div.pl', {},
      h('div.pl-por', {}, bindText(h('div.por.sora'), 'Sora', null, 'title'), bindText(h('div.por.kaede'), 'Kaede', null, 'title')),
      h('div.pl-main', {}, h('div.pl-top', {}, bindText(h('div.pl-name'), 'SORA & KAEDE'), this.hpText),
        h('div.bar', {}, this.hpChip, this.hpFill), this.st));
    el.append(this.pl);

    // speed / altitude
    this.spdV = h('span'); this.altV = h('span'); this.vsV = h('div.fr-vs');
    this.spd = h('div.fr.spd', {}, bindText(h('div.fr-k'), 'SPEED'), h('div.fr-v', {}, this.spdV, bindText(h('small'), 'km/h')), h('div.fr-tape'));
    this.alt = h('div.fr.alt', {}, bindText(h('div.fr-k'), 'ALTITUDE'), h('div.fr-v', {}, this.altV, bindText(h('small'), 'm')), h('div.fr-tape'), this.vsV);
    el.append(this.spd, this.alt);

    // reticle + aim point
    const r = reticleSVG();
    this.retHeat = r.heat; this.retStam = r.stam; this.hitx = r.hitx;
    this.ret = h('div.ret', {}, r.svg, bindText(h('div.ret-lbl.range'), 'IN RANGE'), bindText(h('div.ret-lbl.over'), 'OVERHEAT'));
    this.aim = h('div.aim');
    // wave 5: while the reticle is off screen (free look: RMB / Alt orbit), a small crosshair ring at the screen edge
    // with a chevron pointing where the reticle is (hud.js places it: vm.retEdge)
    this.retEdgeRot = h('i.re-rot', {}, h('i.re-chev.bk'), h('i.re-chev'));
    this.retEdge = h('div.ret-edge', {}, h('i.re-ring'), this.retEdgeRot);
    el.append(this.aim, this.ret, this.retEdge);

    // skills (display on desktop, buttons on touch)
    const sk = (id, key, big = false) => {
      const ring = h('i.ring'), cd = h('i.cd'), cdt = h('div.cdt');
      // (data-sk = the id: the selector hook of moves.js and styles.css; aria-label = the id in English — the tools' old
      // hook, byte-identical — and its Russian name in Russian: ru-hud.js 'fireball', 'breath' …)
      const b = h('button.sk' + (big ? '.big' : ''), { type: 'button', 'data-sk': id, tabindex: '-1' }, ring, cd, icon(ICONS[id]), cdt, keyCap(key));
      bindText(b, id, null, 'aria-label');
      b.style.gridArea = id;
      return { el: b, ring, cd, cdt, v: varSetter(b, '--v'), c: varSetter(b, '--c'), t: textSetter(cdt) };
    };
    // charge pips over the fireball button (built for up to 5 charges, shown only when the dragon has more than one)
    this.pips = h('div.pips'); this.pipEls = [];
    for (let i = 0; i < 5; i++) { const p = h('i'); this.pips.append(p); this.pipEls.push(p); }
    this._pipKey = '';
    this.sk = { dodge: sk('dodge', 'Q/E'), fireball: sk('fireball', 'F'), boost: sk('boost', 'Shift'), power: sk('power', 'Space'), breath: sk('breath', 'LMB', true) };
    this.sk.fireball.el.append(this.pips);
    this.skills = h('div.skills', { style: { gridTemplateAreas: '"dodge fireball breath" "boost power breath"' } }, ...Object.values(this.sk).map((x) => x.el));
    el.append(this.skills);

    // setters
    this.set = {
      hpFill: styleSetter(this.hpFill, 'transform'), hpChip: styleSetter(this.hpChip, 'transform'), hpText: textSetter(this.hpText),
      low: classSetter(this.pl, 'low'), vigLow: classSetter(this.vigLow, 'on'), st: styleSetter(this.stFill, 'transform'), stLow: classSetter(this.st, 'low'),
      spd: textSetter(this.spdV), alt: textSetter(this.altV), vs: textSetter(this.vsV), vsUp: classSetter(this.vsV, 'vs-up'), vsDn: classSetter(this.vsV, 'vs-dn'),
      boosting: classSetter(this.spd, 'boosting'), spdNear: classSetter(this.spd, 'near'), altNear: classSetter(this.alt, 'near'),
      ret: styleSetter(this.ret, 'transform'), retVis: styleSetter(this.ret, 'opacity'), aim: styleSetter(this.aim, 'transform'), aimVis: styleSetter(this.aim, 'opacity'),
      reTf: styleSetter(this.retEdge, 'transform'), reVis: styleSetter(this.retEdge, 'opacity'), reRot: styleSetter(this.retEdgeRot, 'transform'),
      heat: (v) => this._dash(this.retHeat, v), stam: (v) => this._dash(this.retStam, v),
      hot: classSetter(this.ret, 'hot'), over: classSetter(this.ret, 'over'), inrange: classSetter(this.ret, 'inrange'),
      bossOn: classSetter(this.boss, 'on'), bossFill: styleSetter(this.bossFill, 'transform'), bossChip: styleSetter(this.bossChip, 'transform'),
      bossPhase: textSetter(this.bossPhase), bossNum: textSetter(this.bossNum), enraged: classSetter(this.boss, 'enraged'),
      bossEsc: textSetter(this.bossEsc),
      waveOn: classSetter(this.wave, 'on'), waveT: textSetter(this.waveT), waveL: textSetter(this.waveL), waveFill: styleSetter(this.waveFill, 'transform'),
      waveClear: classSetter(this.wave, 'cleared'), waveBar: classSetter(this.wave, 'nobar'),
      killsOn: classSetter(this.kills, 'on'), killN: textSetter(this.killN), killK: textSetter(this.killK),
      comboOn: classSetter(this.combo, 'on'), comboN: textSetter(this.comboN), comboFill: styleSetter(this.comboFill, 'transform'), comboHot: classSetter(this.combo, 'hot'),
      pipsOn: classSetter(this.pips, 'on'),
    };
    this._overPrev = false; this._fbReadyPrev = true; this._comboPrev = 0; this._killsPrev = 0; this._waveKey = '';
    this._dashLast = new Map();
    this._hpShown = null; this._bossShown = null; this._bossIntro = 0;
  }

  /** Delayed "chip" bar: it snaps up with heals, and trails behind damage (CSS transition with delay). */
  _chip(chip, set, prev, f) {
    const up = prev === null || f > prev + 1e-4, down = prev !== null && f < prev - 1e-4;
    if (up && chip.dataset.snap !== '1') { chip.dataset.snap = '1'; chip.style.transition = 'none'; }
    else if (down && chip.dataset.snap === '1') { chip.dataset.snap = '0'; chip.style.transition = ''; }
    if (up || down) set(`scaleX(${f.toFixed(4)})`);
    return f;
  }

  _dash(path, v) {
    const q = Math.round(Math.max(0, Math.min(1, v)) * 200) / 2;
    if (this._dashLast.get(path) === q) return;
    this._dashLast.set(path, q);
    path.setAttribute('stroke-dasharray', `${q} 100`);
  }

  /** Screen rects [left, top, right, bottom] of the speed / altitude readouts that are laid out (a hidden one is left
   *  out); damage numbers keep out of them. Measured on resize and at most once a second (layouts change with the
   *  boss bar on phones), never per frame. */
  readoutRects(now) {
    if (!this._rr || now - this._rrAt > 1 || now < this._rrAt || this._rrW !== innerWidth || this._rrH !== innerHeight) {
      this._rrAt = now; this._rrW = innerWidth; this._rrH = innerHeight;
      this._rr = [];
      for (const e of [this.spd, this.alt]) {
        const r = e.getBoundingClientRect();
        // ± 12 px: a value that gains a digit between two measurements (1,000 m) stays inside the rect
        if (r.width > 0 && r.height > 0) this._rr.push([r.left - 12, r.top, r.right + 12, r.bottom]);
      }
    }
    return this._rr;
  }

  /** The layout changed (touch / Minimal HUD): the cached readout boxes are measured again on the next frame. */
  invalidateLayout() { this._rr = null; this._frBox = null; }

  setBossTicks(fracs) {
    for (const t of this.bossTicks) t.remove();
    this.bossTicks = fracs.map((f) => { const t = h('i.tick'); t.style.left = `${(f * 100).toFixed(2)}%`; this.bossBar.append(t); return t; });
  }

  update(vm, realDt) {
    const S = this.set;
    // player
    if (vm.player) {
      const f = vm.maxHp > 0 ? Math.max(0, Math.min(1, vm.hp / vm.maxHp)) : 0;
      S.hpFill(`scaleX(${f.toFixed(4)})`);
      this._hpShown = this._chip(this.hpChip, S.hpChip, this._hpShown, f);
      S.hpText(`${fmt(vm.hp)} / ${fmt(vm.maxHp)}`);
      S.low(f < 0.3 && vm.hp > 0); S.vigLow(f < 0.3 && vm.hp > 0);
      S.st(`scaleX(${vm.stamina.toFixed(3)})`); S.stLow(vm.stamina < 0.25);
      S.spd(fmt(vm.speedKmh)); S.alt(fmt(vm.altitude)); S.boosting(vm.boosting);
      const vs = Math.round(vm.vs);
      S.vs(vs > 1 ? vsUpText(vs) : vs < -1 ? vsDnText(-vs) : tr('— level')); S.vsUp(vs > 1); S.vsDn(vs < -1);
      S.heat(vm.heat); S.stam(vm.stamina);
      S.hot(vm.heat > 0.7); S.over(vm.overheated); S.inrange(vm.inRange && !vm.overheated);
    }
    // reticle and aim point; a side readout steps back when the reticle flies over it
    if (vm.ret) { S.ret(`translate3d(${vm.ret.x.toFixed(1)}px, ${vm.ret.y.toFixed(1)}px, 0)`); S.retVis(vm.ret.visible ? '1' : '0'); } else S.retVis('0');
    if (!this._frBox || this._frW !== innerWidth || this._frH !== innerHeight) {
      this._frW = innerWidth; this._frH = innerHeight;
      this._frBox = [this.spd, this.alt].map((e) => { const r = e.getBoundingClientRect(); return [r.left - 70, r.top - 70, r.right + 70, r.bottom + 70]; });
    }
    const near = (i) => !!vm.ret?.visible && vm.ret.x > this._frBox[i][0] && vm.ret.x < this._frBox[i][2] && vm.ret.y > this._frBox[i][1] && vm.ret.y < this._frBox[i][3];
    S.spdNear(near(0)); S.altNear(near(1));
    const re = vm.retEdge;
    if (re?.visible) {
      S.reTf(`translate3d(${re.x.toFixed(1)}px, ${re.y.toFixed(1)}px, 0)`);
      S.reRot(`rotate(${re.rot.toFixed(2)}rad)`);
      S.reVis('1');
    } else S.reVis('0');
    if (vm.aim) { S.aim(`translate3d(${vm.aim.x.toFixed(1)}px, ${vm.aim.y.toFixed(1)}px, 0)`); S.aimVis(vm.aim.visible ? '1' : '0'); } else S.aimVis('0');
    // skills
    const K = this.sk;
    if (vm.player) {
      K.breath.v(vm.heat.toFixed(3)); K.breath.el.classList.toggle('hot', vm.heat > 0.7); K.breath.el.classList.toggle('over', vm.overheated);
      K.breath.c(vm.overheated ? '1' : '0'); K.breath.t('');
      K.breath.el.classList.toggle('pressed', !!vm.breathing);
      const fb = vm.fireball;
      // ring = recharge of the next charge (full when every charge is stocked); dark sweep only while none is ready
      const full = fb.charges >= fb.maxCharges || fb.secs <= 0;
      K.fireball.v(full ? '1' : fb.frac.toFixed(3)); K.fireball.c(fb.ready ? '0' : (1 - fb.frac).toFixed(3));
      K.fireball.t(fb.ready ? '' : fb.secs > 0 ? secs(fb.secs) : '');
      K.fireball.el.classList.toggle('ready', fb.ready);
      K.fireball.el.classList.toggle('cooling', !fb.ready && fb.secs > 0);
      K.fireball.el.classList.toggle('partial', fb.ready && !full);
      const multi = fb.maxCharges > 1;
      S.pipsOn(multi);
      const pk = multi ? `${fb.charges}/${fb.maxCharges}` : '';
      if (pk !== this._pipKey) {
        this._pipKey = pk;
        this.pipEls.forEach((p, i) => { p.style.display = i < fb.maxCharges ? '' : 'none'; p.classList.toggle('on', i < fb.charges); });
      }
      if (fb.ready && !this._fbReadyPrev) pop(K.fireball.el, 'rgba(255, 214, 120, .9)');
      this._fbReadyPrev = fb.ready;
      if (vm.overheated && !this._overPrev) { pop(K.breath.el, 'rgba(255, 70, 90, .95)', true); this.ret.firstChild.animate([{ transform: 'scale(1.35)' }, { transform: 'scale(1)' }], { duration: 320, easing: 'ease-out' }); }
      this._overPrev = vm.overheated;
      for (const id of ['boost', 'power', 'dodge']) {
        const need = id === 'dodge' ? 0.2 : id === 'power' ? 0.12 : 0.08;
        K[id].v(vm.stamina.toFixed(3)); K[id].c('0'); K[id].t('');
        K[id].el.classList.toggle('off', vm.stamina < need);
      }
      K.boost.el.classList.toggle('pressed', !!vm.boosting);
    }
    // boss
    const b = vm.boss;
    S.bossOn(!!b);
    if (b) {
      if (this._bossShown === null) { this._bossIntro = 0; this.setBossTicks(b.ticks); }
      this._bossIntro = Math.min(1, this._bossIntro + realDt / 1.2);      // entrance: the bar sweeps full in 1.2 s
      const f = Math.max(0, Math.min(1, b.hp / b.maxHp)) * easeOut(this._bossIntro);
      S.bossFill(`scaleX(${f.toFixed(4)})`);
      this._bossShown = this._chip(this.bossChip, S.bossChip, this._bossShown, f);
      S.bossPhase(b.phaseLabel); S.bossNum(`${fmt(b.hp)} / ${fmt(b.maxHp)}`); S.enraged(b.enraged);
      S.bossEsc(b.escorts > 0 ? escText(b.escorts) : '');
    } else this._bossShown = null;
    // wave strip
    const w = !b && vm.wave;
    S.waveOn(!!w);
    if (w) {
      S.waveT(w.label || w.title); S.waveL(w.cleared ? tr('CLEARED') : leftText(w.left)); S.waveClear(w.cleared);
      S.waveBar(!(w.total > 0));
      S.waveFill(`scaleX(${w.total > 0 ? Math.max(0, Math.min(1, w.progress)).toFixed(3) : 0})`);
      const key = w.title + (w.cleared ? '!' : '');
      if (key !== this._waveKey) { this._waveKey = key; this.wave.animate([{ opacity: 0, transform: 'translateX(-50%) translateY(-8px)' }, { opacity: 1, transform: 'translateX(-50%)' }], { duration: 380, easing: 'ease-out' }); }
    } else this._waveKey = '';
    // kills + combo
    const c = vm.combo;
    if (c) {
      S.killsOn(c.kills > 0); S.killN(String(c.kills)); S.killK(downedText(c.kills));
      if (c.kills > this._killsPrev) this.kills.animate([{ transform: 'scale(1.25)' }, { transform: 'scale(1)' }], { duration: 260, easing: 'ease-out' });
      this._killsPrev = c.kills;
      const on = c.count >= 2 && c.frac > 0;
      S.comboOn(on); S.comboHot(c.count >= 5);
      if (on) { S.comboN(`×${c.count}`); S.comboFill(`scaleX(${c.frac.toFixed(3)})`); }
      if (c.count > this._comboPrev && c.count >= 2) this.comboN.animate([{ transform: 'scale(1.7) rotate(-6deg)', color: '#fff' }, { transform: 'scale(1) rotate(0)' }], { duration: 340, easing: 'cubic-bezier(.3, 1.6, .5, 1)' });
      this._comboPrev = c.count;
    }
  }

  setObjective(text, sub = '') {
    if (!text) { this.objective.style.display = 'none'; return; }
    this.objective.style.display = '';
    if (this.objT.textContent !== text) {
      this.objT.textContent = text;
      this.objective.classList.remove('flash'); void this.objective.offsetWidth; this.objective.classList.add('flash');
    }
    this.setObjectiveSub(sub);
  }
  setObjectiveSub(sub) { if (this.objS.textContent !== sub) this.objS.textContent = sub || ''; }

  /** reach: the wedge's distance from the centre in px (hud.js hitReach: shortened so it stays off the touch controls),
   *  null = the CSS default. */
  flashDamage(strength, dirAngle = null, reach = null) {
    const a = Math.min(1, 0.35 + strength);
    this.vigDmg.animate([{ opacity: a }, { opacity: 0 }], { duration: 650, easing: 'ease-out' });
    if (dirAngle !== null) {
      const r = Number.isFinite(reach) && reach > 0 ? `${Math.round(reach)}px` : '';
      if (r !== this._hdR) { this._hdR = r; if (r) this.hitdir.style.setProperty('--hd-r', r); else this.hitdir.style.removeProperty('--hd-r'); }
      this.hitdir.style.transform = `rotate(${dirAngle.toFixed(3)}rad)`;
      this.hitdir.animate([{ opacity: 1 }, { opacity: 1, offset: 0.4 }, { opacity: 0 }], { duration: 700, easing: 'ease-out' });
    }
    this.pl.animate([{ transform: 'translate3d(-5px, 0, 0)' }, { transform: 'translate3d(4px, 0, 0)' }, { transform: 'translate3d(-2px, 0, 0)' }, { transform: 'none' }], { duration: 260 });
  }

  hitMarker(kill = false) {
    this.hitx.classList.toggle('kill', kill);
    this.hitx.animate([{ opacity: 1, transform: `scale(${kill ? 1.5 : 1.25})` }, { opacity: 0.9, transform: 'scale(1)', offset: 0.3 }, { opacity: 0, transform: 'scale(1)' }],
      { duration: kill ? 420 : 200, easing: 'ease-out' });
  }
}

const easeOut = (t) => 1 - Math.pow(1 - t, 3);
export const BOSS_NAME = 'THE CLOUD TITAN';
export const BOSS_TITLE = 'Colossus of the Cloud Sea';
/** A one-shot pop on a skill button (ready / overheat). Transform + box-shadow on a single short animation. */
function pop(el, glow, shake = false) {
  const frames = shake
    ? [{ transform: 'scale(1.18) translateX(-3px)', boxShadow: `0 0 0 3px ${glow}, 0 0 26px ${glow}` }, { transform: 'scale(1.1) translateX(3px)', offset: 0.25 },
      { transform: 'scale(1.05) translateX(-2px)', offset: 0.5 }, { transform: 'none', boxShadow: '0 0 0 0 rgba(0,0,0,0)' }]
    : [{ transform: 'scale(1.22)', boxShadow: `0 0 0 3px ${glow}, 0 0 24px ${glow}` }, { transform: 'none', boxShadow: '0 0 0 0 rgba(0,0,0,0)' }];
  el.animate(frames, { duration: shake ? 520 : 420, easing: 'ease-out' });
}
