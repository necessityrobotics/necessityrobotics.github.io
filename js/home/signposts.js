// Chapter 2's facts in the world, HOME's side (website_nr3/_build/FACTS_WORLD_PLAN.md 1.2 - 1.5, 2.3). The engine
// (js/world/marks.js) stands four signposts beside xclean's route and moves HOME's cards with them; on phones, in still
// mode and before the island's 3-D is up, the fact sits in the strip's cap instead (the dock). This module only writes
// state, on a change: which fact is current (data-s on each signpost and cap row, data-cur on the cap and on the layer,
// where the engine reads it), the layout and the boxes the signposts keep clear of (data-layout, data-avoid on the layer),
// keyboard focus in the chapter's card (data-kbd: the cards and the leader hide) and the way in (data-enter="back": no
// rise, no planting). Every motion is CSS (opacity / transform). It also splits each number into one box per glyph for
// the rise (after fillMap, from the final text: textContent is unchanged), and keeps the Gaussians note true to what the
// view draws (world:layer).
// The fact shown follows the scroll through a queue (lead, 11-01: a mouse wheel crossed a fact in one notch and showed
// none): once a fact has opened it stays HOLD before it hands over, one fact at a time, so a reader rolling through the
// beat sees each one in turn, late, and the last one once they stop. It hands over at once when the reader leaves the
// beat, or when its signpost has left the screen (the engine's data-out: a card hangs from its post; the dock waits
// freely); in a flick (more than FLICK px/s) it may skip to where the reader is. Driven by the engine's frames (tick)
// and, while a hand-over waits with nothing else drawing, its own frames: no timer.
import { EVENTS } from '../world/api.js';

const HOLD = 0.9;                       // s a fact stays once it has opened
const OPEN = { fwd: 0.3, back: 0.18 };  // s from the hand-over until it opens (css/home.css --sp-in)
const FLICK = 1500, WIN = 300;          // px/s over any WIN ms since the fact's hand-over: a flick

// the panels on screen through the facts beat, per layout (a phone on its side, 760 px or narrower, has no top view and no
// rail in the beat: overlays.js steps them aside on every phone)
const CARDS = '.head, #ch-2 .strip, .world-hud .hud-map, .world-hud .hud-tilt, .rail-in';
const DOCK = '.head, #ch-2 .strip, #ch-2 .strip-fact, .world-hud .hud-tilt';
const AVOID = { cards: CARDS, slim: CARDS, 'slim-phone': '.head, #ch-2 .strip, .world-hud .hud-tilt', dock: DOCK, 'dock-slim': DOCK };
// the Gaussians card says what this view draws of the full map's splats (the numbers are the engine's, from the data);
// one short line, as Keyframes' (lead, 11-01: Route and Duration carry none)
const NOTE = {
  still: 'This view is a still image.',
  points: 'Points shown while the splats load.',
  // release QA: the engine's black-splat safety net dropped the splats for this visit (world.info().noSplats): none load
  pointsOnly: "This view shows the map's points.",
  standard: 'This view draws all of them.',
  part: n => `This view draws ${(n / 1e6).toFixed(2)} M of them.`,
};
const SPLATS = new Set(['cut', 'lite', 'standard']);

const attr = (el, name, v) => {
  if (!el) return;
  const k = `data-${name}`, now = el.getAttribute(k);
  if (v == null || v === '') { if (now !== null) el.removeAttribute(k); } else if (now !== String(v)) el.setAttribute(k, String(v));
};

/**
 * "271.5 s" -> one inline box per glyph (--i: its place in the rise), the unit last; the text stays "271.5 s" (the space
 * is its own small inline text between them, so the rendered text keeps it too).
 */
function split(el) {
  if (el.dataset.split) return;
  const m = /^([\d.,]+)(\s*)(.*)$/.exec(el.textContent);
  if (!m) return;
  el.dataset.split = '1';
  el.textContent = '';
  [...m[1]].forEach((c, i) => {
    const s = document.createElement('span');
    s.className = 'dg'; s.style.setProperty('--i', i); s.textContent = c;
    el.appendChild(s);
  });
  if (m[2] && m[3]) {
    const g = document.createElement('span');
    g.className = 'dg-gap'; g.textContent = m[2];
    el.appendChild(g);
  }
  if (m[3]) {
    const u = document.createElement('span');
    u.className = 'dg un'; u.style.setProperty('--i', m[1].length); u.textContent = m[3];
    el.appendChild(u);
  }
}

/**
 * W: #world; layer: the chapter's [data-world="marks"] layer; ride: the chapter's ride beat element (its height turns
 * progress into pixels for the flick test). Returns {set, tick} or null without a layer.
 */
export function startSignposts(world, { W, layer, ride = null }) {
  if (!layer) return null;
  const id = layer.dataset.island;
  const cap = layer.closest('.chapter')?.querySelector('.strip-fact') || null;
  const posts = [...layer.querySelectorAll('.spost')], rows = cap ? [...cap.querySelectorAll('.sf')] : [];
  for (const el of [...layer.querySelectorAll('[data-rise]'), ...(cap ? cap.querySelectorAll('[data-rise]') : [])]) split(el);

  // the Gaussians note: from what the engine reports for this island
  const notes = [...W.querySelectorAll(`[data-map="${id}"] [data-sp="g-note"]`)];
  const view = { mode: W.dataset.mode || 'still', best: 'poster', splats: null };
  const note = () => {
    const { mode, best, splats } = view;
    const t = mode !== 'live' || best === 'poster' || !best ? NOTE.still : best === 'points' ? (world.info()?.noSplats ? NOTE.pointsOnly : NOTE.points)
      : best === 'standard' ? NOTE.standard : Number.isFinite(splats) ? NOTE.part(splats) : NOTE.still;
    for (const e of notes) if (e.textContent !== t) e.textContent = t;
  };
  world.on(EVENTS.MODE, ({ mode }) => { if (mode) { view.mode = mode; note(); } });
  // review A: a fall from the splats back to the points is taken only once it has lasted 1.5 s in this island's ride. The
  // pull-back's height fades the splats out and the way back down fades them in again, so back up into the ride the
  // phones' cap read "points shown while ..." for a moment, then "draws 0.30 M"; a lasting fall in the ride (splats
  // dropped, loading again) still shows
  let fall = null, fallT = 0;
  const take = ev => { view.best = ev.best; view.splats = ev.splats; note(); };
  const arm = () => {
    clearTimeout(fallT);
    const s = world.state();
    if (fall && s.beat === 'ride' && s.island === id) fallT = setTimeout(() => { if (fall) { take(fall); fall = null; } }, 1500);
  };
  world.on(EVENTS.LAYER, ev => {
    if (ev.id !== id) return;
    // (the engine repeats a layer with its load progress every 250 ms: a repeat keeps the fall's clock running)
    if (ev.best === 'points' && SPLATS.has(view.best)) { const was = fall; fall = ev; if (!was) arm(); } else { fall = null; clearTimeout(fallT); take(ev); }
  });
  world.on(EVENTS.BEAT, arm);
  note();

  // the reader's scroll through the ride, for the flick test: the last 1.5 s as [t, px] pairs, from the ride's progress
  // (the engine's, every frame) times its height (a ResizeObserver): no layout read (scrollY in a scroll listener forced
  // one now and then). A new height starts the history afresh (verifier, 11-01: a phone turned onto its side changed
  // the ride's height by 800 px in a frame, which read as a flick and skipped the fact just handed over)
  const hist = [];
  let rideH = 0;
  if (ride && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(es => {
      const b = es[0].borderBoxSize?.[0], hh = b ? b.blockSize : es[0].contentRect.height;
      if (hh !== rideH) { rideH = hh; hist.length = 0; }
    }).observe(ride);
  }
  const sample = p => {
    if (p == null || !rideH) return;
    const t = performance.now();
    hist.push(t, p * rideH);
    while (hist.length > 4 && t - hist[0] > 1500) hist.splice(0, 2);
  };
  /** The fastest scroll (px/s) over any WIN ms since time `since`. */
  const rate = since => {
    let best = 0, j = 0;
    while (j + 2 < hist.length && hist[j] < since - WIN) j += 2;
    for (let i = j; i < hist.length; i += 2) {
      if (hist[i] < since) continue;
      while (j + 2 < i && hist[i] - hist[j + 2] >= WIN) j += 2;
      const dt = hist[i] - hist[j];
      if (dt >= 100) best = Math.max(best, Math.abs(hist[i + 1] - hist[j + 1]) / dt * 1000);
    }
    return best;
  };
  const ats = posts.map(p => p.querySelector('.sp-at'));

  // the queue: T, the fact the scroll is in (-1: none); k, the fact shown, since t (ms), its way in (back) at that hand-over
  const q = { T: -1, k: -1, t: 0, back: false, way: false, kbd: false, layout: '', phone: false };
  const st = { k: null, kbd: null, layout: null, avoid: null };
  let raf = 0;
  const loop = now => { raf = 0; step(now); };
  function step(now) {
    const T = q.T;
    let k = q.k, back = q.back;
    // out of the beat, keyboard focus in the card (no card shows), or the way in: at once
    if (T < 0 || q.kbd || k < 0) { if (T !== k) { k = T; back = q.way; } }
    else if (T !== k) {
      const age = (now - q.t) / 1000, open = q.back ? OPEN.back : OPEN.fwd;
      const flick = rate(q.t) > FLICK;
      // its signpost has left the screen (or has no place left for its card): cards only, the dock waits freely
      const gone = !q.layout.startsWith('dock') && W.dataset.marks === 'live' && !!ats[k]?.hasAttribute('data-out');
      if (age >= open + HOLD || gone || (flick && age < open)) {
        k = flick ? T : k + Math.sign(T - k);
        back = k < q.k;
      }
    }
    if (k !== q.k) { q.k = k; q.t = now; q.back = back; }
    write();
    if (q.k !== q.T && !raf) raf = requestAnimationFrame(loop);
  }
  function write() {
    const { k, kbd, layout, back } = q;
    const flip = k !== st.k || kbd !== st.kbd;
    if (flip) {                                     // the way in is written with the flip, before the states it styles
      attr(layer, 'enter', back ? 'back' : '');
      attr(cap, 'enter', back ? 'back' : '');
    }
    const avoid = AVOID[layout === 'slim' && q.phone ? 'slim-phone' : layout];
    if (layout !== st.layout) attr(layer, 'layout', layout);
    if (avoid !== st.avoid) { attr(layer, 'avoid', avoid); st.avoid = avoid; }
    if (flip || layout !== st.layout) {
      const dock = layout.startsWith('dock');
      posts.forEach((p, i) => attr(p, 's', k < 0 ? '' : i === k ? 'cur' : i === k + 1 && !dock ? 'next' : i < k ? 'gone' : ''));
      rows.forEach((r, i) => attr(r, 's', i === k ? 'cur' : ''));
      attr(cap, 'cur', k >= 0 ? k : '');
      attr(layer, 'cur', k);                        // the engine's current signpost (js/world/marks.js)
      attr(layer, 'kbd', kbd ? '1' : '');
    }
    st.k = k; st.kbd = kbd; st.layout = layout;
  }
  /**
   * k: the fact the scroll is in (-1: none); kbd: keyboard focus in the card; layout; phone: 760 px or narrower; back: the
   * reader came into the state backwards (from the pull-back, or keyboard focus leaving the card); p: the progress in
   * this chapter's ride (null elsewhere).
   */
  function set({ k, kbd, layout, phone, back, p = null }) {
    sample(p);
    if (kbd !== q.kbd) q.back = back;               // keyboard focus left the card: the card comes back without a rise
    q.T = k; q.kbd = kbd; q.layout = layout; q.phone = phone; q.way = back;
    step(performance.now());
  }
  /** Every engine frame (overlays.js onProgress; p as in set): a hand-over that waits is taken when it is due. */
  function tick(p = null) { sample(p); if (q.k !== q.T) step(performance.now()); }
  return { set, tick };
}
