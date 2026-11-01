// The 3-D world engine's ONLY public surface (website_nr3/MASTER_PLAN.md section 3.2). Owner: the ENGINE builder.
// HOME (js/home/*) and PAGES (js/maps.js, js/viewer/*) import from this file only; its exported names, signatures and
// event names are frozen for the build round (an addition needs a line in website_nr3/REQUESTS.md). It holds no three.js
// or Spark and starts no download: importing it costs a few KB.
//
// Written by the architect as the contract; the ENGINE builder fills in world.js / still.js / atlas-mount.js behind it.
// Until an implementation attaches, calls are queued and the state reads 'still' / 'T0' / 'hero'.

export const EVENTS = Object.freeze({
  MODE: 'world:mode',            // {mode: 'live'|'still', tier: 'T0'..'T4', level: 0..7, why}
  BEAT: 'world:beat',            // {beat, chapter, island, dir: 1|-1, from}
  ISLAND: 'world:island',        // {id, why: 'focus'|'hover'|'select'|'clear'}
  DIVE: 'world:dive',            // {id, phase: 'in'|'ride'|'out'|'done', t}
  LAYER: 'world:layer',          // {id, best: 'poster'|'points'|'cut'|'lite'|'standard', progress: 0..1|null, splats}
  TIER: 'world:tier',            // {tier, level, reason}
  CTX: 'world:ctx',              // {state: 'lost'|'restored'|'replaced'|'failed'}
  TELEMETRY: 'world:telemetry',  // {id, t, d, len} at <= 10 Hz (replay clock s, metres along, route length)
  READY: 'world:ready',          // {first3d_ms}
});

const listeners = new Map();          // type -> Set(fn)
const progressFns = new Set();        // per-frame progress subscribers
let impl = null;                      // the engine's implementation (live or still), attached by _attach()
const queue = [];                     // calls made before an implementation attached: [method, args, resolve, reject]
const state = { mode: 'still', tier: 'T0', level: 0, beat: 'hero', chapter: 0, island: '', diving: false, best: 'poster' };

function call(method, ...args) {
  if (impl) {
    try { return Promise.resolve(impl[method]?.(...args)); } catch (e) { return Promise.reject(e); }
  }
  return new Promise((resolve, reject) => queue.push([method, args, resolve, reject]));
}

function patch(type, d = {}) {
  if (type === EVENTS.MODE) Object.assign(state, { mode: d.mode ?? state.mode, tier: d.tier ?? state.tier, level: d.level ?? state.level });
  else if (type === EVENTS.TIER) Object.assign(state, { tier: d.tier ?? state.tier, level: d.level ?? state.level });
  else if (type === EVENTS.BEAT) Object.assign(state, { beat: d.beat ?? state.beat, chapter: d.chapter ?? state.chapter, island: d.island ?? state.island });
  else if (type === EVENTS.ISLAND) state.island = d.why === 'clear' ? '' : (d.id ?? state.island);
  else if (type === EVENTS.DIVE) state.diving = d.phase === 'in' || d.phase === 'ride' || d.phase === 'out';
  else if (type === EVENTS.LAYER && d.id === state.island) state.best = d.best ?? state.best;
}

export const world = {
  /** Subscribe to one of EVENTS; returns an unsubscribe function. Also dispatched as a CustomEvent on window. */
  on(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); return () => world.off(type, fn); },
  off(type, fn) { listeners.get(type)?.delete(fn); },
  /** Per-frame progress {beat, p (0..1 in the beat), chapter, island, t, d, len, yaw}; at most once per rendered frame. */
  onProgress(fn) { progressFns.add(fn); return () => progressFns.delete(fn); },
  /** Lift an island and make it the focus (card). why: 'chip'|'label'|'tap'|'key'|'minimap'. */
  select(id, opts = {}) { return call('select', id, opts); },
  /** Fly into the island's camera point of view and ride its stretch (time-based). Still mode: resolves without flying. */
  dive(id) { return call('dive', id); },
  /** Leave a dive back to the atlas. */
  surface() { return call('surface'); },
  /** Scroll to a target: 'hero'|'atlas'|'explore'|'story'|'chapter:<n>'|'island:<id>'. opts: {smooth: true} */
  goto(target, opts = {}) { return call('goto', target, opts); },
  /**
   * Look by tilting the phone. Call it synchronously from a click / tap handler: iOS asks for the permission here,
   * inside the user's gesture. Resolves 'on' | 'off' | 'denied' | 'unavailable'.
   */
  tilt(on) {
    if (!on) return call('tilt', false).then(() => 'off');
    const D = window.DeviceOrientationEvent;
    if (!D) return Promise.resolve('unavailable');
    let ask;
    try { ask = typeof D.requestPermission === 'function' ? D.requestPermission() : Promise.resolve('granted'); } catch (e) { ask = Promise.resolve('denied'); }
    return Promise.resolve(ask).then(r => (r === 'granted' ? call('tilt', true) : 'denied'), () => 'denied');
  },
  /** A copy of the current state (mode, tier, level, beat, chapter, island, diving, best). */
  state() { return { ...state }; },
  /** Debug information (also window.__world.info()). */
  info() { return impl?.info ? impl.info() : { attached: false, state: { ...state } }; },
};

// ------------------------------------------------------------------ engine side (ENGINE modules only)
/** The engine attaches its implementation {select, dive, surface, goto, tilt, info}; queued calls run now. */
export function _attach(i) {
  impl = i;
  for (const [m, a, res, rej] of queue.splice(0)) { try { res(impl[m]?.(...a)); } catch (e) { rej(e); } }
}
/** The engine emits one of EVENTS (updates state, calls subscribers, dispatches a window CustomEvent). */
export function _emit(type, detail = {}) {
  patch(type, detail);
  for (const fn of listeners.get(type) || []) { try { fn(detail); } catch (e) { console.warn('[world] listener', type, e); } }
  try { window.dispatchEvent(new CustomEvent(type, { detail })); } catch (e) { /* old browsers */ }
}
/** The engine pushes per-frame progress. */
export function _progress(p) { for (const fn of progressFns) { try { fn(p); } catch (e) { console.warn('[world] progress', e); } } }

// ------------------------------------------------------------------ entry points (the heavy modules load on demand)
// SP: on the home page the world's module graph (world.js and its imports, three levels deep) starts loading as soon as
// this facade is evaluated, in parallel with the page's JSON that startWorld() waits for; it used to start only after
// that JSON, which put three extra round trips before the hero's first download (4G: 1.55 s -> about 1.2 s)
const early = document.getElementById('world') ? import('./world.js').catch(() => null) : null;
/** Home page: start the world on #world. {maps, atlas, routes, root}. Picks the tier, then live (world.js) or still (still.js). */
export async function startWorld(opts) {
  const { start } = (await early) || (await import('./world.js'));
  return start(opts);
}
/**
 * Maps page (and any other page): mount the atlas of all islands in an element.
 * opts: {maps, atlas, interactive = true, initial = null, onSelect(id), onDive(id), still}
 * Resolves {select(id), focus(id), destroy(), mode: 'live'|'still'}.
 */
export async function mountAtlas(el, opts) {
  const { mount } = await import('./atlas-mount.js');
  return mount(el, opts);
}
