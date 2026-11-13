// Necessity Robotics v4, lane ENGINE: mountPlace(el, opts), the one door to the site's 3-D engine (ENGINE.md has the
// full contract and a copy-paste snippet). This file is small and has no 3-D code: three.js and Spark (about 1.4 MB
// compressed) load only on a device that can run them, and in the home frame only once the frame is on screen.
//
//   const place = await mountPlace(el, { id, mode: 'frame' | 'full', at, kf, onEvent(type, detail) });
//
// el is a positioned box that already holds <img class="pl-still"> (static HTML, painted before any script). The still
// stays on screen until the live place is drawn at the same position; a device that cannot run the place keeps the
// still for good and the page gets one plain sentence (event 'state', detail.text). Never a film, never a spinner.
//
// el.dataset.state : 'still' | 'loading' | 'live' | 'failed'        el.dataset.reason : why it is not live ('' when live)
// TEST SWITCHES (page URL): ?force3d=1 live on software WebGL (CPU tests) · ?shot=1 fixed resolution, 1 buffer pixel per
// CSS pixel · ?bare=1 no interface (pose-matched stills) · ?q=lite|standard the 3-D file · ?tier=T1..T4 a caps.js tier.
import { detectCaps, chooseTier, stillReason } from '../world/caps.js';
import { loadPlaces, siteUrl, isTouch } from '../v4/common.js';

const Q = new URLSearchParams(location.search);
export const SWITCH = Object.freeze({
  force3d: Q.get('force3d') === '1', shot: Q.get('shot') === '1', bare: Q.get('bare') === '1',
  q: ['lite', 'standard'].includes(Q.get('q')) ? Q.get('q') : null, tier: Q.get('tier'),
});

/** One plain sentence per reason (R5). `again` = the label of the button that tries again, where trying again can help. */
export const REASONS = Object.freeze({
  'software': { text: 'This device cannot show the 3-D place. This is a picture of it.' },
  'no-webgl': { text: 'This device cannot show the 3-D place. This is a picture of it.' },
  'old-browser': { text: 'This browser cannot show the 3-D place. This is a picture of it.' },
  'low-memory': { text: 'This device cannot show the 3-D place. This is a picture of it.' },
  'reduced-motion': { text: 'Your device asks for less motion, so this is a picture of the 3-D place.' },
  'save-data': { text: 'Your device is set to save data, so this is a picture of the 3-D place.', again: 'Open the 3-D place anyway' },
  'slow-connection': { text: 'Your connection is slow, so this is a picture of the 3-D place.', again: 'Open the 3-D place anyway' },
  'too-slow': { text: 'This device cannot show the 3-D place smoothly. This is a picture of it.', again: 'Open it again' },
  'context-lost': { text: 'Your device paused the 3-D place to save memory. This is a picture of it.', again: 'Open it again' },
  'error': { text: 'The 3-D place did not load. This is a picture of it.', again: 'Open it again' },
});
const CHEAP = [[/reduced motion/, 'reduced-motion'], [/Save-Data/, 'save-data'], [/slow connection/, 'slow-connection'], [/deviceMemory/, 'low-memory'], [/import maps/, 'old-browser']];
const GL_ATTRS = { alpha: false, antialias: false, stencil: false, depth: true, powerPreference: 'high-performance', preserveDrawingBuffer: false };

function ensureCss() {
  if (document.querySelector('link[data-pl-css], link[href*="js/place/place.css"]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = siteUrl('js/place/place.css'); l.dataset.plCss = '1';
  document.head.appendChild(l);
}

/**
 * Mount one 3-D place in `el`. Resolves when the still picture is in place; the place goes live later, when it can.
 *   opts.id       place id of data/places.json (default: the hero place)
 *   opts.mode     'full' (the 3-D view: look, walk, step, jump, ride, above) | 'frame' (the home page: look only)
 *   opts.at       metres along the camera's path to start at (default: the place's start position, a real photo)
 *   opts.kf       or: the index of a real photo (keyframes.json) to start at
 *   opts.onEvent  (type, detail) => void. Types: 'state' {state, reason, text, again} · 'pose' {at, total, heading, x, y,
 *                 look, pitch, off, facing, above, riding, walked} · 'first-look' · 'first-step' {moved, at, total} ·
 *                 'photo' {src, exact, at, kf, t} · 'enter' {at} (frame: the visitor tapped the picture, the path or a
 *                 circle: the PAGE navigates) · 'ride' {on} · 'above' {on} · 'offpath' {off, show} · 'end' {at} ·
 *                 'tier' {tier} · 'progress' {tier, loaded, total}
 *   opts.stepLabel  HTML of the label beside the nearest stepping circle
 * Returns the handle: { el, place, state, reason, live, at, total, heading, destroy(), goTo({at | kf}), lookBy(dxRad,
 *   dyRad), stepBy(metres), walk(steps), moveBy(fwd, right), ride(on), above(on), toPath(), covers({at | kf}), again(),
 *   redraw(), keys(on), setQuality(tier), setLayer(mode), showPath(on), info() }
 */
export async function mountPlace(el, opts = {}) {
  const mode = opts.mode === 'frame' ? 'frame' : 'full';
  ensureCss();
  const P = await loadPlaces();
  const place = P.byId[opts.id] || P.heroPlace;
  const emit = (type, detail = {}) => { try { opts.onEvent?.(type, detail); } catch (e) { console.warn('[place] onEvent', type, e); } };

  el.classList.add('pl');
  el.dataset.mode = mode; el.dataset.place = place.id;
  if (SWITCH.bare) el.dataset.bare = '1';
  // the still: the page's own <img class="pl-still"> (static HTML). Made here only when the page has none.
  let still = el.querySelector('.pl-still');
  if (!still) { still = document.createElement('img'); still.className = 'pl-still'; still.alt = `Picture of the 3-D place: ${place.name}`; el.appendChild(still); }
  if (still.dataset.place !== place.id || !still.getAttribute('src')) { still.src = siteUrl(place.still); still.dataset.place = place.id; }
  const layer = document.createElement('div');
  layer.className = 'pl-layer'; layer.dataset.live = '0';
  el.appendChild(layer);

  const M = { state: 'still', reason: '', engine: null, canvas: null, dead: false, started: false, forced: false, io: null,
    pending: { at: opts.at ?? null, kf: opts.kf ?? null }, keysOff: false };
  const set = (state, reason = '') => {
    M.state = state; M.reason = reason;
    el.dataset.state = state; el.dataset.reason = reason;
    const r = REASONS[reason] || {};
    emit('state', { state, reason, text: state === 'live' || state === 'loading' ? '' : r.text || '', again: state === 'live' || state === 'loading' ? '' : r.again || '' });
  };
  const dropCanvas = (gl) => {
    try { gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch (e) { /* nothing to release */ }
    M.canvas?.remove(); M.canvas = null;
  };

  // touch says touch (R8), also to a screen reader
  const labelCanvas = () => {
    if (mode !== 'full' || !M.canvas) return;
    M.canvas.setAttribute('aria-label', isTouch()
      ? '3-D place. Swipe to look around. Tap a light on the path to step along it.'
      : "3-D place. Drag to look around. Left and Right arrow keys turn. Up and Down arrow keys walk along the camera's path.");
  };
  document.addEventListener('v4:input', labelCanvas);
  /** Can this device run the place? Makes the canvas and its WebGL2 context when it can. Returns { gl, params } or null. */
  function probe() {
    const canvas = M.canvas = document.createElement('canvas');
    canvas.className = 'pl-canvas';
    if (mode === 'full') { canvas.tabIndex = 0; labelCanvas(); }
    else canvas.setAttribute('aria-hidden', 'true');
    el.insertBefore(canvas, el.firstChild);
    const caps = detectCaps({ canvas });
    // the cheap reasons. The 3-D view (mode full) works under reduced motion: the visitor moves it, nothing eases.
    const why = stillReason(mode === 'full' ? { ...caps, reduced: false } : caps, null);
    let code = why ? (CHEAP.find(([re]) => re.test(why)) || [0, 'low-memory'])[1] : '';
    if (code && (M.forced && REASONS[code].again || SWITCH.force3d && code !== 'old-browser')) code = '';
    let gl = caps.gl;
    if (!code && (caps.webgl2 === false || caps.software)) {
      code = caps.software ? 'software' : 'no-webgl';
      if (code === 'software' && SWITCH.force3d) {
        // CPU tests only: a software context, made without the "no major performance caveat" request
        try { gl = gl || canvas.getContext('webgl2', GL_ATTRS); } catch (e) { gl = null; }
        if (gl) code = '';
      }
    }
    if (code) { dropCanvas(gl); set('still', code); return null; }
    const choice = chooseTier({ ...caps, webgl2: true, software: false, reduced: false, saveData: false, effectiveType: null, deviceMemory: caps.deviceMemory == null ? null : Math.max(2, caps.deviceMemory), modules: true },
      { force: { world: 'live', tier: SWITCH.tier } });
    return { gl, params: choice.params, soft: !!caps.software || caps.webgl2 === false };
  }

  async function start(pr) {
    if (M.started || M.dead) return;
    M.started = true;
    set('loading');
    try {
      const { PlaceEngine } = await import('./engine.js');
      if (M.dead) return;
      const engine = M.engine = new PlaceEngine({
        el, canvas: M.canvas, gl: pr.gl, place, mode, params: pr.params, at: M.pending.at, kf: M.pending.kf,
        shot: SWITCH.shot, soft: pr.soft, quality: opts.q || SWITCH.q, layer, stepLabel: opts.stepLabel, folder: opts.folder,
        emit: (type, detail) => {
          if (type === 'lost') fail('context-lost');
          else if (type === 'slow') { if (!M.forced) fail('too-slow'); }
          else emit(type, detail);
        },
      });
      engine.keysOff = M.keysOff;
      await engine.start();
      if (M.dead || M.engine !== engine) return;
      set('live');
    } catch (e) {
      if (M.dead) return;
      console.warn('[place] the 3-D place did not start:', e);
      fail('error');
    }
  }
  function fail(reason) {
    const e = M.engine;
    M.engine = null; M.started = false;
    if (e) { M.pending = { at: e.at, kf: null }; e.destroy(); }
    M.canvas?.remove(); M.canvas = null;
    set('failed', reason);
  }
  /** Try again (the "Open it again" button): a new canvas, the same spot. */
  function again() {
    if (M.dead || M.engine) return;
    M.forced = true;
    const pr = probe();
    if (pr) start(pr);
  }

  // decide now (cheap: one WebGL2 probe); load later
  set('still', '');
  const pr = probe();
  if (pr) {
    if (mode === 'full') start(pr);
    else if ('IntersectionObserver' in window) {
      // the home frame: start only when it is on screen; stop drawing while it is off screen
      M.io = new IntersectionObserver(es => {
        const on = es[es.length - 1].isIntersecting;
        if (on && !M.started && M.canvas) start(pr);
        M.engine?.setOffscreen(!on);
      }, { threshold: 0.15 });
      M.io.observe(el);
    } else start(pr);
  }
  // the home frame is a door in every state: a tap on the picture opens the 3-D view (the page navigates)
  const startAt = () => (M.pending.at != null ? +M.pending.at : place.start_at_m);
  const onClick = e => {
    if (mode !== 'frame' || M.engine?.live) return;
    if (e.target instanceof Element && e.target.closest('a, button')) return;
    emit('enter', { at: startAt() });
  };
  el.addEventListener('click', onClick);

  if (still.decode && !still.complete) await Promise.race([still.decode().catch(() => {}), new Promise(r => setTimeout(r, 1500))]);

  const E = () => (M.engine && M.engine.live ? M.engine : null);
  const handle = {
    el, place, mode,
    get state() { return M.state; }, get reason() { return M.reason; }, get live() { return M.state === 'live'; },
    get at() { return M.engine?.track ? M.engine.at : startAt(); },
    get total() { return M.engine?.total ?? place.path_m; },
    get heading() { return E() ? E().heading : null; },
    get settled() { return !!E() && E().settled; },
    get engine() { return M.engine; },
    /** Go to a point of the camera's path: { at: metres } or { kf: photo index }. Before the place is live: the start. */
    goTo(to, o) { if (E()) return E().goTo(to, o); M.pending = { at: to?.at ?? null, kf: to?.kf ?? null }; return false; },
    lookBy(dx, dy) { E()?.lookBy(dx, dy); },
    stepBy(m) { E()?.stepBy(m); },
    walk(n) { E()?.walk(n); },
    moveBy(f, r) { E()?.moveBy(f, r); },
    ride(on) { return E() ? E().ride(on) : false; },
    above(on) { E()?.above(on); },
    toPath() { E()?.toPath(); },
    covers(to) { const e = E(); if (!e) return false; const at = to?.kf != null ? e.photos[to.kf]?.at : to?.at; return at != null && e.covers(at); },
    again,
    /** Draw one frame again (the page calls it after it moved a panel over the place: the circles are tested again). */
    redraw() { E()?.stage.invalidate(); },
    keys(on) { M.keysOff = !on; if (M.engine) M.engine.keysOff = !on; },
    setQuality(t) { return E() ? E().setQuality(t) : Promise.resolve(null); },
    setLayer(m) { return E() ? E().setLayer(m) : Promise.resolve(); },
    showPath(on) { E()?.showPath(on); },
    info() { return E() ? E().info() : null; },
    destroy() {
      M.dead = true;
      M.io?.disconnect();
      document.removeEventListener('v4:input', labelCanvas);
      el.removeEventListener('click', onClick);
      M.engine?.destroy(); M.engine = null;
      M.canvas?.remove(); layer.remove();
      el.dataset.state = 'still';
    },
  };
  // the debug handle for tests (BUILD_PLAN section 4)
  window.__place = {
    get state() { return M.state; }, get reason() { return M.reason; }, get at() { return handle.at; }, get heading() { return handle.heading; },
    get total() { return handle.total; }, get settled() { return handle.settled; }, get live() { return handle.live; },
    get look() { return E() ? E().S.tyaw * 180 / Math.PI : null; }, get off() { return E() ? E().S.off : null; },
    get riding() { return !!E()?.S.riding; }, get isAbove() { return !!E()?.S.above.on; }, get tier() { return E()?.tier || null; },
    stepBy: m => handle.stepBy(m), lookBy: (x, y) => handle.lookBy(x, y), goTo: (t, o) => handle.goTo(t, o), ride: on => handle.ride(on),
    above: on => handle.above(on), walk: n => handle.walk(n), handle,
  };
  return handle;
}
