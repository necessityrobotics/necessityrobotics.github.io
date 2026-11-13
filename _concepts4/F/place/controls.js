// V12 concept A (LIFT-OFF): a COPY of site/js/place/controls.js. Changes: attachLift (the home background: the pointer's
// parallax, a click on the path from above opens the 3-D view); in attachFull the pointer's parallax, a ring on the ground
// with the distance in metres, and any input ends the drop at once. The original is unchanged.
// Necessity Robotics v4, lane ENGINE: the visitor's input. Two sets:
//   attachFull(E)   the 3-D view (explore.html): drag / swipe = look (full circle), arrow keys, W / S, A / D, wheel and
//                   pinch (move freely on a soft leash), a tap on the camera's path = go there; touch-action: none on the
//                   canvas only (css), so the page chrome keeps its own gestures.
//   attachFrame(E)  the home frame: look only. Sideways swipe = look, vertical swipe = the page scrolls
//                   (touch-action: pan-y; the arc rule of js/world/input.js: a swipe that starts sideways and then turns
//                   clearly vertical scrolls the page by hand). A mouse over the frame turns the view a few degrees; a
//                   drag turns it up to 60 degrees; it eases back only after the visitor lets go. A tap = "enter".
// Every change of the view here starts from a pointer or a key event: nothing is scheduled by a timer except the
// "hold Up to ride" delay, which a key release cancels.
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const DEG = Math.PI / 180;

function listeners() {
  const all = [];
  return {
    on(el, ev, fn, opt) { el.addEventListener(ev, fn, opt); all.push([el, ev, fn, opt]); },
    off() { for (const [el, ev, fn, opt] of all) el.removeEventListener(ev, fn, opt); all.length = 0; },
  };
}
const local = (E, e) => { const r = E.canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

/** Mouse over the camera's path: pointer cursor, a ring on the nearest point, one plain line. */
function hoverPath(E, e, text) {
  const [x, y] = local(E, e);
  const hit = E.live ? E.pickPath(x, y, 22) : null;
  const was = E.ribbon.uniforms.uHot.value;
  if (hit) { E.steps.showPick(hit.x, hit.y, text(hit)); E.canvas.dataset.over = 'path'; E.ribbon.uniforms.uHot.value = 1; }
  else { E.steps.hidePick(); delete E.canvas.dataset.over; E.ribbon.uniforms.uHot.value = 0; }
  if (was !== E.ribbon.uniforms.uHot.value) E.stage.invalidate();
}
function leavePath(E) {
  E.steps.hidePick(); delete E.canvas.dataset.over;
  if (E.ribbon.uniforms.uHot.value) { E.ribbon.uniforms.uHot.value = 0; E.stage.invalidate(); }
}

/** The ring on the ground under the mouse, with the distance from the visitor in metres (drawn after each frame). */
function ringOf(E) {
  if (E._ring) return E._ring;
  const r = document.createElement('div');
  r.className = 'a-ring'; r.hidden = true; r.setAttribute('aria-hidden', 'true');
  r.innerHTML = '<i></i><span></span>';
  E.o.layer.appendChild(r);
  E._ring = r;
  E.stage.after.add(() => placeRing(E));
  return r;
}
function placeRing(E) {
  const r = E._ring, h = E._hover && !E._hover.path && E.live && !E.lift.dropping ? E.groundAt(E._hover.x, E._hover.y) : null;
  if (!h) { if (!r.hidden) r.hidden = true; return; }
  const c = { x: 0, y: 0 }, a = { x: 0, y: 0 }, b = { x: 0, y: 0 }, R = 0.22, p = h.p;
  if (!E.project(p, c) || !E.project(p.clone().setX(p.x + R), a) || !E.project(p.clone().setZ(p.z + R), b)) { r.hidden = true; return; }
  r.hidden = false;
  r.style.transform = `translate(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px)`;
  r.firstChild.style.transform = `matrix(${((a.x - c.x) / 50).toFixed(4)}, ${((a.y - c.y) / 50).toFixed(4)}, ${((b.x - c.x) / 50).toFixed(4)}, ${((b.y - c.y) / 50).toFixed(4)}, 0, 0)`;
  const t = `${h.d < 10 ? h.d.toFixed(1) : Math.round(h.d)} m`;
  if (r.lastChild.textContent !== t) r.lastChild.textContent = t;
}

export function attachFull(E) {
  const c = E.canvas, L = listeners(), S = E.S;
  const ptrs = new Map();
  let drag = null, pinch = null, lastTap = null, hold = 0, holdKey = '', holdRide = false;
  ringOf(E);
  // any input ends the drop at once (it lands); a pointer move does not
  const skip = () => { if (E.lift.dropping) E.skipDrop(); };
  L.on(window, 'pointerdown', skip, { capture: true });
  L.on(window, 'wheel', skip, { capture: true, passive: true });
  L.on(window, 'keydown', skip, { capture: true });
  L.on(window, 'touchstart', skip, { capture: true, passive: true });
  // the pointer's parallax: over the whole page, so the place answers the mouse everywhere
  L.on(window, 'pointermove', e => {
    if (e.pointerType !== 'mouse' || e.buttons || !E.live) return;
    const r = E.canvas.getBoundingClientRect();
    E.setPar(((e.clientX - r.left) / r.width) * 2 - 1, ((e.clientY - r.top) / r.height) * 2 - 1);
  }, { passive: true });

  L.on(c, 'pointerdown', e => {
    if (e.button > 0 || !E.live) return;
    E._hover = null;                                     // no ring while the visitor drags
    const touch = e.pointerType === 'touch';
    if (touch && (e.clientX < 16 || e.clientX > window.innerWidth - 16)) return;      // the screen edge is the browser's back swipe
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { c.setPointerCapture(e.pointerId); } catch (err) { /* older browsers */ }
    if (ptrs.size === 1) drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: e.timeStamp, yaw: S.tyaw, pitch: S.tpitch, az: S.above.taz, el: S.above.tel, moved: 0, touch };
    else if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { last: Math.hypot(a.x - b.x, a.y - b.y) }; drag = null; }
    E.el.dataset.dragging = '1';
    leavePath(E);
  });
  L.on(c, 'pointermove', e => {
    if (!ptrs.has(e.pointerId)) {
      if (e.pointerType === 'mouse' && !e.buttons) {
        hoverPath(E, e, () => (S.above.k > 0.5 ? 'Drop in here' : 'Walk to this point'));
        const [x, y] = local(E, e);
        E._hover = { x, y, path: E.canvas.dataset.over === 'path' };
        if (e.target instanceof Element && e.target.closest('.pl-step')) E._hover = null;
        E.stage.invalidate();
      }
      return;
    }
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && ptrs.size === 2) {
      const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
      E.moveBy((d - pinch.last) * 0.012 * E.step);
      pinch.last = d;
      return;
    }
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.moved = Math.max(drag.moved, Math.abs(dx) + Math.abs(dy));
    if (drag.moved < 5) return;
    if (S.above.on) {
      S.above.taz = drag.az + dx * 0.006; S.above.tel = clamp(drag.el + dy * 0.005, 25 * DEG, 85 * DEG);
      E.stage.invalidate();
    } else {
      // the place turns under the finger: a point of the picture stays under the pointer
      const f = E.fov();
      E.lookTo(drag.yaw + dx * f.h / E.W, drag.pitch + dy * f.v / E.H);
    }
  });
  const end = e => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.delete(e.pointerId);
    if (ptrs.size < 2) pinch = null;
    if (!ptrs.size) delete E.el.dataset.dragging;
    const d = drag;
    if (!d || e.pointerId !== d.id) return;
    drag = null;
    if (e.type !== 'pointerup') return;
    // the events' own times: a slow frame between press and release must not turn a tap into a drag. A slow, careful
    // tap (up to 0.8 s) is still a tap. CPU tests (?force3d=1) draw one frame in seconds and their tool stamps the
    // release after that frame, so there the limit is off.
    const now = e.timeStamp;
    if (d.moved < 6 && now - d.t < (E.o.soft ? 6e4 : 800)) {
      const [x, y] = local(E, e);
      if (d.touch && lastTap && now - lastTap.t < 320 && Math.hypot(x - lastTap.x, y - lastTap.y) < 30) { lastTap = null; recentre(); return; }
      lastTap = { t: now, x, y };
      E.tap(x, y);
    } else if (d.moved >= 14 && !S.above.on) E._firstLook();
  };
  L.on(c, 'pointerup', end);
  L.on(c, 'pointercancel', end);
  L.on(c, 'pointerleave', () => { leavePath(E); E._hover = null; E.stage.invalidate(); });
  const recentre = () => { if (S.above.on) return; S.tyaw = Math.round(S.tyaw / (2 * Math.PI)) * 2 * Math.PI; S.tpitch = 0; E.stage.invalidate(); };
  L.on(c, 'dblclick', recentre);
  L.on(c, 'wheel', e => {
    if (!E.live) return;
    e.preventDefault();
    E.moveBy(clamp(-e.deltaY, -240, 240) * 0.0035 * E.step);
  }, { passive: false });

  // ---- keyboard: Left / Right turn; Up / W and Down / S walk along the path; A / D step sideways; hold Up / W to ride
  const stopHold = () => { clearTimeout(hold); hold = 0; holdKey = ''; if (holdRide) { holdRide = false; E.ride(false); } };
  L.on(window, 'keydown', e => {
    if (!E.live || E.keysOff || e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return;
    const t = e.target;
    if (t instanceof Element && t.closest('input, textarea, select, [contenteditable="true"], .v4-route, [data-pl-keys="off"]')) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); E.lookBy((k === 'ArrowLeft' ? 15 : -15) * DEG, 0); }
    else if (k === 'ArrowUp' || k === 'w') {
      e.preventDefault();
      if (e.repeat || S.riding) return;
      E.walk(1);
      clearTimeout(hold);
      holdKey = k;
      const t0 = performance.now();
      const go = () => { hold = 0; if (holdKey) { holdRide = true; E.ride(true); } };
      // a timer that fires late (a slow frame held the page) waits one more turn, so a key release already in the
      // queue is seen first: a short press stays one step
      hold = setTimeout(() => { if (performance.now() - t0 > 560) hold = setTimeout(go, 70); else go(); }, 420);
    } else if (k === 'ArrowDown' || k === 's') {
      e.preventDefault();
      if (S.riding) { E.ride(false); return; }
      if (!e.repeat || !S.tw) E.walk(-1);
    } else if (k === 'a' || k === 'd') { e.preventDefault(); E.moveBy(0, k === 'd' ? 0.6 : -0.6); }
    else if (k === 'PageUp' || k === 'PageDown') { e.preventDefault(); E.lookBy(0, (k === 'PageUp' ? 8 : -8) * DEG); }
  });
  L.on(window, 'keyup', e => {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === holdKey) stopHold();
  });
  L.on(window, 'blur', stopHold);
  return { detach() { stopHold(); L.off(); } };
}

/** The home background (mode 'lift'): the pointer's parallax over the whole page; from above, the path is a door. */
export function attachLift(E) {
  const c = E.canvas, L = listeners();
  L.on(window, 'pointermove', e => {
    if (e.pointerType !== 'mouse') return;
    const r = E.canvas.getBoundingClientRect();
    E.setPar(((e.clientX - r.left) / r.width) * 2 - 1, ((e.clientY - r.top) / r.height) * 2 - 1);
    if (E.S.above.k > 0.5 && e.target === c) hoverPath(E, e, () => 'Walk in here');
    else leavePath(E);
  }, { passive: true });
  L.on(document.documentElement, 'pointerleave', () => { E.setPar(0, 0); leavePath(E); }, { passive: true });
  L.on(c, 'click', e => { const [x, y] = local(E, e); E.tap(x, y); });
  return { detach() { L.off(); } };
}

export function attachFrame(E) {
  const el = E.el, c = E.canvas, L = listeners(), S = E.S;
  const K = { hx: 0, hy: 0, dx: 0, dy: 0 };
  let drag = null, lastMoved = 0;
  const wake = () => E.stage.invalidate();
  const SMOOTH = 'scrollBehavior' in document.documentElement.style;

  L.on(el, 'pointermove', e => {
    if (e.pointerType !== 'mouse' || drag) return;
    // over a stepping circle the view holds still: the circle must not slide away from under the pointer
    if (e.target instanceof Element && e.target.closest('.pl-step')) { leavePath(E); return; }
    const r = el.getBoundingClientRect();
    K.hx = clamp(((e.clientX - r.left) / r.width - 0.5) * 2, -1, 1);
    K.hy = clamp(((e.clientY - r.top) / r.height - 0.5) * 2, -1, 1);
    hoverPath(E, e, () => 'Open this place in 3-D, from this point');
    wake();
  }, { passive: true });
  L.on(el, 'pointerleave', e => { if (e.pointerType !== 'mouse') return; K.hx = K.hy = 0; leavePath(E); wake(); }, { passive: true });

  L.on(c, 'pointerdown', e => {
    if (e.button > 0) return;
    const touch = e.pointerType !== 'mouse';
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), dx: K.dx, dy: K.dy, moved: 0, touch, mode: 'look',
      ax: e.clientX, ay: e.clientY, ly: e.clientY, hist: [] };
    lastMoved = 0;
    if (!touch) { try { c.setPointerCapture(e.pointerId); } catch (err) { /* older browsers */ } el.dataset.dragging = '1'; }
    leavePath(E);
  }, { passive: true });
  /** A touch the browser left to the page (it started sideways): look, until it turns clearly vertical; then scroll. */
  function touchMove(d, e) {
    const x = e.clientX, y = e.clientY, now = e.timeStamp || performance.now();
    if (d.mode === 'scroll') {
      const dy = d.ly - y;
      d.ly = y;
      d.hist.push([now, y]);
      while (d.hist.length > 2 && now - d.hist[0][0] > 100) d.hist.shift();
      if (dy) window.scrollBy(0, dy);
      return;
    }
    const ax = Math.abs(x - d.ax), ay = Math.abs(y - d.ay);
    if (ax >= ay) { d.ax = x; d.ay = y; }
    else if (ay > 30 && ay > 2 * ax) { d.mode = 'scroll'; d.ly = y; d.hist = [[now, y]]; K.dx = 0; K.dy = 0; wake(); return; }
    K.dx = clamp(d.dx + (x - d.x) / Math.max(1, E.W) * 2.2, -1, 1);
  }
  L.on(window, 'pointermove', e => {
    const d = drag;
    if (!d || e.pointerId !== d.id) return;
    d.moved = Math.max(d.moved, Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y));
    if (d.touch) touchMove(d, e);
    else if (d.moved >= 4) {
      K.dx = clamp(d.dx + (e.clientX - d.x) / Math.max(1, E.W) * 2.0, -1, 1);
      K.dy = clamp(d.dy + (e.clientY - d.y) / Math.max(1, E.H) * 2.0, -1, 1);
    }
    wake();
  }, { passive: true });
  const end = e => {
    const d = drag;
    if (!d || e.pointerId !== d.id) return;
    drag = null;
    lastMoved = d.moved;
    delete el.dataset.dragging;
    if (d.mode === 'scroll' && e.type === 'pointerup' && SMOOTH && d.hist.length >= 2) {
      const [t0, y0] = d.hist[0], [t1, y1] = d.hist[d.hist.length - 1];
      const v = t1 - t0 >= 16 ? (y0 - y1) / (t1 - t0) : 0;
      if (Math.abs(v) >= 0.2) window.scrollBy({ top: Math.round(Math.sign(v) * Math.min(2.5 * window.innerHeight, v * v / 0.005)), behavior: 'smooth' });
    }
    if (d.mode === 'look' && d.moved >= 14 && Math.abs(K.dx) > 0.06) E._firstLook();
    K.dx = 0; K.dy = 0;                                  // the visitor let go: the view eases back to the path's direction
    wake();
  };
  L.on(window, 'pointerup', end, { passive: true });
  L.on(window, 'pointercancel', end, { passive: true });   // a vertical pan became the browser's scroll
  // a tap or click on the picture (not a drag) = walk in: the page navigates
  L.on(c, 'click', e => { if (lastMoved < 8) { const [x, y] = local(E, e); E.tap(x, y); } });

  return {
    /** The frame's look targets, from the pointer's state. The engine eases the view to them. */
    step() {
      S.tyaw = -K.hx * 7 * DEG + K.dx * 60 * DEG;
      S.tpitch = -K.hy * 4 * DEG + K.dy * 12 * DEG;
      return false;
    },
    detach() { L.off(); },
  };
}
