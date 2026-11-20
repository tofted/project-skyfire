// Boot: create the Game, load every system from systems.js, then hand control to the UI (title screen).
//   ?quality=low|medium|high|ultra   ?debug (exposes debug helpers)   ?sandbox=<name> (src/sandbox/<name>.js)
//   ?skip=riders|titan (debug only: jump the director to a phase)    ?capture (preserveDrawingBuffer for screenshots)
import { Game } from './core/game.js';
import { createInput } from './core/input.js';
import { SYSTEMS } from './systems.js';
import { tr, lang, onLang } from './ui/i18n.js';

const params = new URLSearchParams(location.search);
// a host page may preset parameters (the web build of the keyboard-and-mouse link sets 'touch=0', since a claude.ai
// artifact gets no query string); a parameter in the address still wins
for (const [k, v] of new URLSearchParams(globalThis.SKYFIRE_PARAMS || '')) if (!params.has(k)) params.set(k, v);
const canvas = document.getElementById('view');
const bootFill = document.getElementById('boot-fill');
const bootNote = document.getElementById('boot-note');
const errors = [];

// Languages (29.09): the boot screen in the player's language — index.html's static English lines are replaced at once
// (the logo SKYFIRE stays); the "Preparing …" line per system (English: `Preparing ${name}…`, the system's own name).
// (fix 29.09: index.html keeps its two lines visibility: hidden — a Russian player saw the English ones for ~20 ms
// before this module ran; they are shown here once they read in the player's language. The tab title follows too.)
const BOOT_STEP = {
  sky: () => tr('Preparing sky…'), terrain: () => tr('Preparing terrain…'), water: () => tr('Preparing water…'),
  vegetation: () => tr('Preparing vegetation…'), clouds: () => tr('Preparing clouds…'), progress: () => tr('Preparing progress…'),
  player: () => tr('Preparing player…'), enemies: () => tr('Preparing enemies…'), titan: () => tr('Preparing titan…'),
  fx: () => tr('Preparing fx…'), director: () => tr('Preparing director…'), ambient: () => tr('Preparing ambient…'),
  cameraRig: () => tr('Preparing cameraRig…'), audio: () => tr('Preparing audio…'), hud: () => tr('Preparing hud…'),
  movesHud: () => tr('Preparing movesHud…'), touchUI: () => tr('Preparing touchUI…'), pipeline: () => tr('Preparing pipeline…'),
};
const bootStep = (name) => (BOOT_STEP[name] ? BOOT_STEP[name]() : lang() === 'en' ? `Preparing ${name}…` : tr('Preparing…'));
{
  const sub = document.querySelector('#boot .boot-sub');
  if (lang() !== 'en') {
    if (sub) sub.textContent = tr('Riders of the Cloud Sea');
    if (bootNote) bootNote.textContent = tr('Loading…');
  }
  for (const el of [sub, bootNote]) if (el) el.style.visibility = '';
}
const setTitle = () => { document.title = 'Skyfire — ' + tr('Riders of the Cloud Sea'); };
setTitle();
onLang(setTitle);

function showError(msg) {
  errors.push(msg);
  let box = document.getElementById('boot-errors');
  if (!box) {
    box = document.createElement('div');
    box.id = 'boot-errors';
    box.className = 'boot-errors';
    document.body.appendChild(box);
  }
  box.textContent = errors.slice(-6).join('\n');
}

async function boot() {
  if (!canvas.getContext('webgl2')) {
    bootNote.textContent = tr('This game needs WebGL 2. Please open it in a recent version of Chrome, Edge, Safari or Firefox.');
    return;
  }
  const game = new Game(canvas, params);
  window.__skyfire = game;              // read-only handle for tests and the debug overlay
  game.add(createInput(game), 0);
  game.events.on('system:error', ({ name, error }) => showError(`${name}: ${error?.message || error}`));

  const sandbox = params.get('sandbox');
  let list = SYSTEMS;
  let sandboxModule = null;
  if (sandbox) {
    sandboxModule = await import(`./sandbox/${sandbox}.js`);
    list = sandboxModule.systems ? SYSTEMS.filter((s) => sandboxModule.systems.some((n) => s.path.includes(n))) : SYSTEMS;
  }

  // Load modules in parallel, register in order.
  const loaded = await Promise.all(list.map(async (entry) => {
    try {
      const mod = await import(entry.path);
      return { entry, create: mod.default };
    } catch (e) {
      console.error('[boot] failed to load', entry.path, e);
      showError(`${entry.path}: ${e.message}`);
      return null;
    }
  }));
  for (const item of loaded) {
    if (!item || typeof item.create !== 'function') continue;
    try {
      const sys = item.create(game);
      if (sys) game.add(sys, item.entry.order);
    } catch (e) {
      console.error('[boot] create failed', item.entry.path, e);
      showError(`${item.entry.path}: ${e.message}`);
    }
  }

  await game.init((p, name) => {
    bootFill.style.width = Math.round(p * 100) + '%';
    bootNote.textContent = bootStep(name);
  });
  if (sandboxModule?.setup) await sandboxModule.setup(game);
  // performance update: build the scene's shader programs now, behind the title, not in the middle of a fight
  try { game.pipeline?.warmup?.(); } catch (e) { console.warn('[boot] warm-up', e); }

  document.getElementById('boot').classList.add('hidden');
  game.setState(sandbox ? 'play' : 'title');
  game.start();
}

boot().catch((e) => {
  console.error(e);
  showError(e.message || String(e));
  bootNote.textContent = tr('Something went wrong while loading. Please reload the page.');
});
