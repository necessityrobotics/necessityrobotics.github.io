// Necessity Robotics v4: THE ROUTE DOOR. Every route line drawn anywhere on the site goes through this one function,
// so every one behaves the same (BRIEF T4, BUILD_PLAN section 5):
//   pointer cursor, thicker and brighter line on hover / focus, a ring on the nearest point of the path, a tooltip with
//   the real camera photo nearest to that point, and click / tap / Enter opens  explore.html?map=<id>&at=<metres> .
//
//   import { routeDoor, initRouteDoors } from './js/v4/route-door.js';
//   routeDoor(svgOrEl, { id, mode: 'link' | 'jump', onJump })
//
// Two ways to use it (FOUNDATION.md has the snippets):
//   1. STATIC: the element is the <a class="v4-route" data-route="<id>"> of a generated fragment (tools/build_static.py).
//      It is a plain link without JS; this module upgrades it. On load, every such element in the page is upgraded.
//   2. DRAWN HERE: any empty element with a size. The module draws the path from data/routes.json (or opts.pts) into it.
//      This is the form for the "You are here" map of the 3-D view:  mode 'jump' calls onJump(metres) and never leaves
//      the page.
// Nothing here moves by itself (R1). The photo list (/assets/maps/<id>/keyframes.json) loads on first use only.
import { asset } from '../config.js';
import { exploreHref, fmtOf, getJSON } from './common.js';

const NS = 'http://www.w3.org/2000/svg';
const DOORS = new WeakMap();
const mk = (name, attrs = {}, parent) => {
  const e = document.createElementNS(NS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ------------------------------------------------------------------ real camera photos along a path (first use only)
const KF = new Map();
/** Metres along the path at time t (s). pts = the points of data/routes.json: [[t s, x m, y m, metres], ...]. */
export function atOfTime(pts, t) {
  let lo = 0, hi = pts.length - 1;
  if (t <= pts[0][0]) return pts[0][3];
  if (t >= pts[hi][0]) return pts[hi][3];
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (pts[mid][0] <= t) lo = mid; else hi = mid; }
  const span = pts[hi][0] - pts[lo][0];
  return pts[lo][3] + (pts[hi][3] - pts[lo][3]) * (span > 0 ? (t - pts[lo][0]) / span : 0);
}
/** The real camera photos of a place: [{ i, t, at, src }] sorted along the path (at = metres). Loaded once per place. */
export function photos(id) {
  if (!KF.has(id)) {
    KF.set(id, Promise.all([
      fetch(asset(id, 'keyframes.json')).then((r) => { if (!r.ok) throw new Error(`keyframes ${r.status}`); return r.json(); }),
      getJSON('data/routes.json'),
    ]).then(([j, routes]) => {
      const pts = routes.routes[id].pts;
      return j.keyframes.map((k, i) => ({ i, t: k.t, at: atOfTime(pts, k.t), src: asset(id, k.file) }));
    }).catch(() => []));
  }
  return KF.get(id);
}
/** The photo taken nearest to `at` metres along the path (null when the list is empty). */
export function nearestPhoto(list, at) {
  let best = null, d = Infinity;
  for (const k of list) { const e = Math.abs(k.at - at); if (e < d) { d = e; best = k; } }
  return best;
}

// ------------------------------------------------------------------ one tooltip and one live region for all doors
let tip = null, live = null;
function tipShow(cx, cy, title, sub, photo) {
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'v4-tip';
    tip.setAttribute('role', 'tooltip');
    tip.innerHTML = '<img alt="" width="168" height="105" hidden><b></b><small></small>';
    document.body.appendChild(tip);
  }
  const im = tip.querySelector('img');
  if (photo) { if (im.getAttribute('src') !== photo) im.src = photo; im.hidden = false; } else im.hidden = true;
  tip.querySelector('b').textContent = title;
  const sm = tip.querySelector('small');
  sm.textContent = sub || '';
  sm.hidden = !sub;
  tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  const x = clamp(cx - w / 2, 8, window.innerWidth - w - 8);
  let y = cy - h - 18;
  if (y < 8) y = Math.min(cy + 22, window.innerHeight - h - 8);
  tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}
function tipHide() { if (tip) tip.hidden = true; }
function say(text) {
  if (!live) {
    live = document.createElement('div');
    live.className = 'v4-sr';
    live.setAttribute('aria-live', 'polite');
    live.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap';
    document.body.appendChild(live);
  }
  live.textContent = text;
}

/**
 * Make one drawn route a door.
 *   svgOrEl        the <a class="v4-route"> of a fragment (or the <svg> inside it), or an empty element with a size
 *   opts.id        the place id (default: the element's data-route)
 *   opts.mode      'link' (default): open explore.html?map=<id>&at=<metres>.  'jump': call opts.onJump(metres), stay here
 *   opts.onJump    (metres, detail) => void, for mode 'jump'
 *   opts.pts       route points [[t s, x m, y m, metres], ...] when the page already has them (else data/routes.json)
 *   opts.start     metres of a start mark to draw (drawn-here form only; static fragments carry their own)
 *   opts.pad       { t, r, b, l } px around the path (drawn-here form), default 14
 *   opts.tip       tooltip text (default: "Open this place in 3-D, from this point" / "Jump to this point")
 *   opts.label     aria-label of the element (drawn-here form)
 *   opts.photo     false: no camera photo in the tooltip
 * Returns a handle: { el, id, mode, ready (Promise), total (metres), setAt(m), setXY(x, y), setHeading(deg), setLook(deg),
 *   clearYou(), atOfClient(clientX, clientY) -> { at, distPx } | null, xyOfAt(m) -> [clientX, clientY] | null, destroy() }
 */
export function routeDoor(svgOrEl, opts = {}) {
  let host = svgOrEl;
  if (host instanceof SVGElement) host = host.closest('.v4-route') || host.parentElement;
  if (!host) return null;
  if (DOORS.has(host)) {
    if (!Object.keys(opts).length) return DOORS.get(host);
    DOORS.get(host).destroy();                       // a second call WITH options replaces the door made on page load
  }

  const id = opts.id || host.dataset.route;
  const mode = opts.mode || host.dataset.mode || 'link';
  const isLink = host instanceof HTMLAnchorElement;
  const baseHref = isLink ? host.getAttribute('href') : null;
  const ac = new AbortController();
  const on = (el, type, fn, o = {}) => el.addEventListener(type, fn, { ...o, signal: ac.signal });

  let svg = null, line = null, ring = null, you = null, fan = null;
  let V = [], M = [], total = 0, start = null, tf = null;       // vertices (SVG units), metres at each, route -> SVG map
  let drawnPts = null, ro = null;
  const st = { hover: null, kbd: null, you: null, youXY: null, heading: null, look: null, shown: null, dead: false };

  host.classList.add('v4-route', 'is-door');
  host.removeAttribute('title');                     // the native tooltip of the no-JS state; ours replaces it
  if (!isLink) {
    host.tabIndex = 0;
    host.setAttribute('role', mode === 'jump' ? 'button' : 'link');
  }
  if (opts.label) host.setAttribute('aria-label', opts.label);
  else if (!host.hasAttribute('aria-label') && !host.textContent.trim()) {
    host.setAttribute('aria-label', mode === 'jump'
      ? "Map of the camera's path. Left and Right choose a point. Enter jumps there."
      : "The camera's path. Open this place in 3-D at a point of the path.");
  }

  // ---------------------------------------------------------------- geometry
  function readStatic() {
    svg = host.querySelector('svg');
    line = svg && svg.querySelector('path[data-m]');
    if (!line) return false;
    V = line.getAttribute('d').slice(1).split('L').map((s) => s.trim().split(/[ ,]+/).map(Number));
    M = line.dataset.m.trim().split(/\s+/).map(Number);
    if (V.length < 2 || V.length !== M.length) return false;
    total = +host.dataset.total || M[M.length - 1];
    start = host.dataset.start != null && host.dataset.start !== '' ? +host.dataset.start : null;
    const t = (svg.dataset.tf || '').trim().split(/\s+/).map(Number);
    tf = t.length === 3 && t.every(Number.isFinite) ? { a: t[0], bx: t[1], by: t[2] } : null;
    return true;
  }
  function layoutDrawn() {
    if (!drawnPts || st.dead) return;
    const box = svg.getBoundingClientRect();
    const W = box.width, H = box.height;
    if (W < 4 || H < 4) return;
    const pad = { t: 14, r: 14, b: 14, l: 14, ...(opts.pad || {}) };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of drawnPts) { x0 = Math.min(x0, p[1]); x1 = Math.max(x1, p[1]); y0 = Math.min(y0, p[2]); y1 = Math.max(y1, p[2]); }
    const iw = Math.max(1, W - pad.l - pad.r), ih = Math.max(1, H - pad.t - pad.b);
    const s = Math.min(iw / Math.max(1e-6, x1 - x0), ih / Math.max(1e-6, y1 - y0));
    const ox = pad.l + (iw - (x1 - x0) * s) / 2, oy = pad.t + (ih - (y1 - y0) * s) / 2;
    tf = { a: s, bx: ox - x0 * s, by: oy + y1 * s };
    V = drawnPts.map((p) => [tf.a * p[1] + tf.bx, tf.by - tf.a * p[2]]);       // the path's y axis points up on the map
    M = drawnPts.map((p) => p[3]);
    total = M[M.length - 1];
    svg.setAttribute('viewBox', `0 0 ${W.toFixed(1)} ${H.toFixed(1)}`);
    line.setAttribute('d', 'M' + V.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('L'));
    const dot = svg.querySelector('.v4-route-dot');
    if (dot && start != null) { const q = xyAt(start); dot.setAttribute('cx', q[0].toFixed(1)); dot.setAttribute('cy', q[1].toFixed(1)); }
    paintYou();
    if (st.shown != null) show(st.shown, st.shownTip);
  }
  async function draw() {
    let pts = opts.pts;
    if (!pts) pts = (await getJSON('data/routes.json')).routes[id].pts;
    if (st.dead) return;
    drawnPts = pts;
    start = opts.start != null ? +opts.start : null;
    host.classList.add('v4-route--map');
    svg = mk('svg', { class: 'v4-route-svg', 'aria-hidden': 'true', focusable: 'false' });
    host.prepend(svg);
    line = mk('path', { class: 'v4-route-line' }, svg);
    if (start != null) mk('circle', { class: 'v4-route-dot', r: '4.5' }, svg);
    layoutDrawn();
    if ('ResizeObserver' in window) { ro = new ResizeObserver(() => layoutDrawn()); ro.observe(host); }
    else on(window, 'resize', layoutDrawn);
  }

  /** [x, y, segment index] in SVG units at `at` metres along the path. */
  function xyAt(at) {
    const n = M.length;
    const want = clamp(at, M[0], M[n - 1]);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (M[mid] <= want) lo = mid; else hi = mid; }
    const span = M[hi] - M[lo], k = span > 0 ? (want - M[lo]) / span : 0;
    return [V[lo][0] + (V[hi][0] - V[lo][0]) * k, V[lo][1] + (V[hi][1] - V[lo][1]) * k, lo];
  }
  const ctm = () => (svg && svg.getScreenCTM ? svg.getScreenCTM() : null);
  const scale = () => { const m = ctm(); return m ? Math.hypot(m.a, m.b) || 1 : 1; };      // screen px per SVG unit
  /** The point of the path nearest to a screen point: { at, x, y, distPx }. */
  function nearest(cx, cy) {
    const m = ctm();
    if (!m || V.length < 2) return null;
    const p = new DOMPoint(cx, cy).matrixTransform(m.inverse());
    let best = null, bd = Infinity;
    for (let i = 0; i < V.length - 1; i++) {
      const ax = V[i][0], ay = V[i][1], dx = V[i + 1][0] - ax, dy = V[i + 1][1] - ay;
      const den = dx * dx + dy * dy;
      const k = den > 1e-9 ? clamp(((p.x - ax) * dx + (p.y - ay) * dy) / den, 0, 1) : 0;
      const qx = ax + dx * k, qy = ay + dy * k, d = (p.x - qx) ** 2 + (p.y - qy) ** 2;
      if (d < bd) { bd = d; best = { at: M[i] + (M[i + 1] - M[i]) * k, x: qx, y: qy }; }
    }
    best.distPx = Math.sqrt(bd) * Math.hypot(m.a, m.b);
    return best;
  }
  function clientOf(x, y) {
    const m = ctm();
    if (!m) return null;
    const p = new DOMPoint(x, y).matrixTransform(m);
    return [p.x, p.y];
  }

  // ---------------------------------------------------------------- the ring + tooltip on the chosen point
  let kfList = null, kfAsked = false;
  const tipText = opts.tip || (mode === 'jump' ? 'Jump to this point' : 'Open this place in 3-D, from this point');
  function show(at, withTip) {
    if (!svg || V.length < 2) return;
    st.shown = at; st.shownTip = withTip;
    if (!ring) { ring = mk('g', { class: 'v4-route-ring' }, svg); mk('circle', {}, ring); }
    const q = xyAt(at), s = scale();
    ring.firstChild.setAttribute('r', (9 / s).toFixed(2));
    ring.setAttribute('transform', `translate(${q[0].toFixed(1)} ${q[1].toFixed(1)})`);
    ring.setAttribute('visibility', 'visible');
    host.classList.add('is-hot');
    if (isLink && mode === 'link') host.href = exploreHref(id, at);
    if (!withTip) return;
    const c = clientOf(q[0], q[1]);
    if (!c) return;
    const ph = kfList && kfList.length ? nearestPhoto(kfList, at) : null;
    tipShow(c[0], c[1], tipText, ph ? `Camera photo near this point · ${fmtOf(at, total)}` : fmtOf(at, total), ph && ph.src);
    if (!kfAsked && opts.photo !== false && id) {
      kfAsked = true;
      photos(id).then((l) => { kfList = l; if (st.shown != null && st.shownTip && !st.dead) show(st.shown, true); });
    }
  }
  function hide() {
    st.shown = null;
    if (ring) ring.setAttribute('visibility', 'hidden');
    host.classList.remove('is-hot');
    tipHide();
    if (isLink && mode === 'link' && baseHref != null) host.setAttribute('href', baseHref);
  }

  // ---------------------------------------------------------------- "You are here" (the map inside the 3-D view)
  function paintYou() {
    if (!you || !svg || V.length < 2) return;
    let x, y, seg;
    if (st.youXY && tf) { x = tf.a * st.youXY[0] + tf.bx; y = tf.by - tf.a * st.youXY[1]; seg = xyAt(st.you ?? 0)[2]; }
    else if (st.you != null) { [x, y, seg] = xyAt(st.you); }
    else { you.setAttribute('visibility', 'hidden'); return; }
    const k = 1 / scale();
    you.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${k.toFixed(3)})`);
    you.setAttribute('visibility', 'visible');
    let rot = null;
    if (st.heading != null) rot = -st.heading;                         // route frame: counter-clockwise from +x; SVG y points down
    else if (st.look != null) {
      const a = V[seg], b = V[Math.min(V.length - 1, seg + 1)];
      rot = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI - st.look;
    }
    if (rot == null) fan.setAttribute('visibility', 'hidden');
    else { fan.setAttribute('visibility', 'inherit'); fan.setAttribute('transform', `rotate(${rot.toFixed(1)})`); }
  }
  function needYou() {
    if (you || !svg) return;
    you = mk('g', { class: 'v4-route-you', visibility: 'hidden' }, svg);
    fan = mk('path', { class: 'v4-route-fan', d: 'M0 0 L38 -18 A42 42 0 0 1 38 18 Z', visibility: 'hidden' }, you);
    mk('circle', { class: 'v4-route-you-halo', r: '13' }, you);
    mk('circle', { class: 'v4-route-you-ring', r: '8' }, you);
    mk('circle', { class: 'v4-route-you-core', r: '5.5' }, you);
    if (ring) svg.appendChild(ring);                                   // the ring stays on top
  }

  // ---------------------------------------------------------------- open / jump
  const defaultAt = () => (st.you != null ? st.you : start != null ? start : 0);
  function go(at, ev, how) {
    if (mode === 'jump') {
      if (ev) ev.preventDefault();
      if (at != null && typeof opts.onJump === 'function') opts.onJump(at, { id, total, how });
      return;
    }
    const href = exploreHref(id, at == null ? undefined : at);
    if (isLink && ev && ev.type === 'click') { host.href = href; return; }   // the link's own navigation follows
    if (ev) ev.preventDefault();
    window.location.assign(href);
  }

  function wire() {
    on(host, 'pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      const n = nearest(e.clientX, e.clientY);
      if (n && (mode === 'link' || n.distPx <= 44)) { st.hover = n.at; show(n.at, true); }
      else if (st.kbd == null) { st.hover = null; hide(); }
    });
    on(host, 'pointerleave', () => { st.hover = null; if (st.kbd != null) show(st.kbd, true); else hide(); });
    on(host, 'pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      const n = nearest(e.clientX, e.clientY);            // a tap: show where it lands; the click that follows opens it
      if (n && (mode === 'link' || n.distPx <= 48)) show(n.at, false);
    }, { passive: true });
    on(host, 'pointercancel', () => { if (st.kbd == null) hide(); });
    on(host, 'click', (e) => {
      if (e.defaultPrevented) return;
      let at = null, how = 'pointer';
      if (e.detail === 0 && !(e.clientX || e.clientY)) { at = st.kbd != null ? st.kbd : defaultAt(); how = 'key'; }
      else {
        const n = nearest(e.clientX, e.clientY);
        if (n && (mode === 'link' || n.distPx <= 48)) at = n.at;
        else if (mode === 'jump') { e.preventDefault(); return; }
      }
      go(at, e, how);
    });
    on(host, 'keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End') {
        if (V.length < 2) return;
        e.preventDefault();
        const step = Math.max(1, total / 40);
        const from = st.kbd != null ? st.kbd : defaultAt();
        st.kbd = clamp(e.key === 'Home' ? 0 : e.key === 'End' ? total : from + (e.key === 'ArrowRight' ? step : -step), 0, total);
        show(st.kbd, true);
        say(`${fmtOf(st.kbd, total)}. ${mode === 'jump' ? 'Press Enter to jump here.' : 'Press Enter to open the 3-D place here.'}`);
      } else if (e.key === 'Enter' || e.key === ' ') {
        const at = st.kbd != null ? st.kbd : defaultAt();
        if (isLink && mode === 'link' && e.key === 'Enter') { host.href = exploreHref(id, at); return; }   // native Enter follows
        e.preventDefault();
        go(at, null, 'key');
      } else if (e.key === 'Escape') { st.kbd = null; hide(); }
    });
    on(host, 'focus', () => {
      let kb = false;
      try { kb = host.matches(':focus-visible'); } catch (err) { kb = true; }
      if (!kb || V.length < 2) return;
      st.kbd = defaultAt();
      show(st.kbd, true);
    });
    on(host, 'blur', () => { st.kbd = null; st.hover = null; hide(); });
    on(window, 'scroll', () => {                        // the tooltip is fixed to the window: keep it true while the page scrolls
      if (st.shown == null) return;
      if (st.kbd != null) show(st.kbd, true); else hide();
    }, { passive: true });
  }

  const ready = (readStatic() ? Promise.resolve() : draw()).then(() => { if (!st.dead) wire(); });
  ready.catch((err) => { console.warn('routeDoor:', id, err); });

  const handle = {
    el: host, id, mode, ready,
    get total() { return total; },
    /** Put the "You are here" dot at `m` metres along the path. */
    setAt(m) { st.you = clamp(+m, 0, total || +m); st.youXY = null; needYou(); paintYou(); },
    /** Put the dot at a map position in metres (the x, y of data/routes.json), for a visitor who left the path. */
    setXY(x, y, nearAt) { st.youXY = [+x, +y]; if (nearAt != null) st.you = +nearAt; needYou(); paintYou(); },
    /** Turn the view fan: degrees in the map frame of data/routes.json, counter-clockwise from +x. null hides it. */
    setHeading(deg) { st.heading = deg == null ? null : +deg; st.look = null; needYou(); paintYou(); },
    /** Turn the view fan relative to the path direction at the dot: 0 = along the path, positive = to the left. */
    setLook(deg) { st.look = deg == null ? null : +deg; st.heading = null; needYou(); paintYou(); },
    clearYou() { st.you = null; st.youXY = null; paintYou(); },
    atOfClient(cx, cy) { const n = nearest(cx, cy); return n ? { at: n.at, distPx: n.distPx } : null; },
    xyOfAt(m) { const q = xyAt(m); return clientOf(q[0], q[1]); },
    destroy() {
      st.dead = true;
      ac.abort();
      if (ro) ro.disconnect();
      hide();
      if (ring) ring.remove();
      if (you) you.remove();
      if (drawnPts && svg) svg.remove();
      host.classList.remove('is-door', 'is-hot');
      DOORS.delete(host);
    },
  };
  DOORS.set(host, handle);
  return handle;
}

/** Upgrade every static route of a fragment inside `root` (default: the page). Safe to call again after adding cards. */
export function initRouteDoors(root = document) {
  const out = [];
  root.querySelectorAll('.v4-route[data-route]:not([data-route-manual])').forEach((el) => { out.push(routeDoor(el)); });
  return out;
}

initRouteDoors();
