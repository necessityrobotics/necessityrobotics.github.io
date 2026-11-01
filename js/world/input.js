// Look-around and picking input (MASTER_PLAN.md 2.6 / 4.6; PH-2 / 3 / 10 / 13 / 19, DE-1). Scrolling stays native:
// every listener is passive, nothing calls preventDefault, and the stage's CSS (touch-action: pan-y pinch-zoom) lets the
// browser own vertical pans and pinch-zoom while sideways swipes arrive here as pointer moves.
//   mouse   hover position -> a small look (+-7 deg / +-4 deg); drag -> a large look that springs back; click -> onTap
//   touch   sideways swipe -> look (springs back); a tap (< 8 px, < 450 ms) -> onTap; works over the hero copy
//   arcs    pan-y leaves a gesture that STARTS sideways to the page for its whole length, so a thumb arc that starts
//           sideways and then turns up would never scroll (PH-3). Once such a gesture turns clearly vertical, the page
//           scrolls with the finger and keeps a short fling on release; a gesture the browser scrolls is never touched
//   tilt    after world.tilt(true) (the permission is asked inside the tap by api.js): the phone's attitude relative to
//           where it was, rotated by the screen orientation, with a deadband and a hysteresis (a steady hand redraws
//           nothing); re-based when the screen rotates; the rest attitude follows slowly (a new posture re-centres)
//   keys    Escape -> onKey('Escape')
// The look is a pair of angles (yaw, pitch; radians) that follows its target with a time constant, so it is correct at
// 30, 60 or 120 Hz; it snaps when settled so the stage can idle.
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const CONTROLS = 'a, button, input, select, textarea, label, summary, [role="button"], [data-world="tilt"], [data-world="chips"]';
const IGNORE = `${CONTROLS}, .ch-card, .explore-card, .dive-bar, .mcard, .ov-panel, .strip, .ex-intro, .ex-foot`;
const IGNORE_MOUSE = `${IGNORE}, p, h1, h2, h3, li, dd, dt, small, code`;
const NO_ARC = 'input, select, textarea, [contenteditable]';
const ARC_MIN = 30;            // px of vertical travel since the gesture's turn ...
const ARC_RATIO = 2;           // ... at most 26.6 deg off vertical: a curving sideways thumb sweep never qualifies
const FLING_DECEL = 0.0025;    // px / ms^2: a 2 px / ms release travels about 800 px
const SMOOTH = typeof document !== 'undefined' && 'scrollBehavior' in document.documentElement.style;

/** Inside a box the browser scrolls vertically (the explore card on phones): its gestures stay the browser's. */
function inScroller(el, root) {
  for (let e = el; e && e !== root && e.nodeType === 1; e = e.parentElement) {
    if (e.scrollHeight > e.clientHeight + 1) {
      const o = getComputedStyle(e).overflowY;
      if (o === 'auto' || o === 'scroll') return true;
    }
  }
  return false;
}

export function attachInput(root, { reduced, onLook, onHover, onTap, onKey, onType } = {}) {
  const L = { hx: 0, hy: 0, dx: 0, dy: 0, x: 0, y: 0, drag: null, tilt: null, active: false };
  const wake = () => onLook?.();
  const type = t => onType?.(t);
  const listeners = [];
  const on = (el, ev, fn, opt = { passive: true }) => { el.addEventListener(ev, fn, opt); listeners.push([el, ev, fn, opt]); };
  /** The look's resting target: the tilt's while it is on, else straight ahead. */
  const rest = () => { L.dx = L.tilt ? L.tilt.ax : 0; L.dy = L.tilt ? L.tilt.ay : 0; };

  on(window, 'pointermove', e => {
    if (e.pointerType === 'mouse') {
      type('mouse');
      if (!reduced && !L.drag) { L.hx = clamp((e.clientX / innerWidth - 0.5) * 2, -1, 1); L.hy = clamp((e.clientY / innerHeight - 0.5) * 2, -1, 1); }
      onHover?.(e.clientX, e.clientY, e.target);
    }
    const d = L.drag;
    if (d && e.pointerId === d.id) {
      d.moved = Math.max(d.moved, Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y));
      if (d.touch) touchMove(d, e);
      else if (d.look) {
        // grab the world: dragging right turns the view left; down tilts it up
        L.dx = clamp(d.dx - (e.clientX - d.x) / innerWidth * 2.4, -1, 1);
        L.dy = clamp(d.dy - (e.clientY - d.y) / innerHeight * 2.4, -1, 1);
      }
    }
    if (!reduced) wake();
  });
  if (!reduced) on(document.documentElement, 'pointerleave', () => { L.hx = L.hy = 0; onHover?.(-1, -1, null); wake(); });

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
    if (d.arc) {
      const ax = Math.abs(x - d.ax), ay = Math.abs(y - d.ay);
      if (ax >= ay) { d.ax = x; d.ay = y; }          // still sideways: the turn point follows the finger
      else if (ay > ARC_MIN && ay > ARC_RATIO * ax) {
        d.mode = 'scroll';
        d.ly = y;
        d.hist = [[now, y]];
        if (d.look) { rest(); wake(); }              // the look springs back while the page scrolls
        return;
      }
    }
    if (d.look) L.dx = clamp(d.dx - (x - d.x) / innerWidth * 2.4, -1, 1);
  }
  function fling(d) {
    if (!SMOOTH || reduced || d.hist.length < 2) return;
    const [t0, y0] = d.hist[0], [t1, y1] = d.hist[d.hist.length - 1];
    if (t1 - t0 < 16 || performance.now() - t1 > 80) return;       // a finger that stopped before lifting: no fling
    const v = (y0 - y1) / (t1 - t0);
    if (Math.abs(v) < 0.2) return;
    const dist = Math.sign(v) * Math.min(2.5 * innerHeight, v * v / (2 * FLING_DECEL));
    window.scrollBy({ top: Math.round(dist), behavior: 'smooth' });
  }

  on(root, 'pointerdown', e => {
    const touch = e.pointerType !== 'mouse';
    type(touch ? 'touch' : 'mouse');
    if (e.button > 0) return;
    // touch adjustment retargets a touch NEAR a panel to the panel (an island 10 px from the explore intro could not be
    // tapped): real controls keep their adjusted hit; panels are judged by what lies under the finger's centre
    const under = touch ? document.elementFromPoint(e.clientX, e.clientY) || e.target : e.target;
    const ui = touch ? !!(e.target.closest(CONTROLS) || under.closest(IGNORE)) : !!e.target.closest(IGNORE_MOUSE);
    if (!touch && ui) return;
    const arc = touch && !under.closest(NO_ARC) && !inScroller(under, root);
    if (touch && ui && !arc) return;
    // look: the drag turns the view; pick: a tap / click picks (also under reduced motion); a gesture that starts on a
    // panel only keeps its arc rescue
    L.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), dx: L.dx, dy: L.dy, moved: 0, touch,
      look: !ui && !reduced, pick: !ui, arc, mode: 'look', ax: e.clientX, ay: e.clientY, ly: e.clientY, hist: [] };
    if (!touch && !reduced) root.dataset.dragging = '1';
  });
  // A touch tap acts after the browser's own click for it: the click is hit-tested (with touch adjustment) after the
  // pointerup, so UI that the tap itself brought up under the finger took it (a dive's bar opened the viewer: a ghost
  // click in landscape). 350 ms is the fallback when no click comes.
  let pendingTap = null;
  const fireTap = () => { const p = pendingTap; pendingTap = null; if (p) { clearTimeout(p.timer); onTap?.(...p.args); } };
  on(window, 'click', () => { if (pendingTap) setTimeout(fireTap, 0); }, { capture: true, passive: true });
  const end = e => {
    const d = L.drag;
    if (!d || e.pointerId !== d.id) return;
    L.drag = null;
    delete root.dataset.dragging;
    if (d.mode === 'scroll' && e.type === 'pointerup') fling(d);
    rest();
    if (e.type === 'pointerup' && d.pick && d.mode !== 'scroll' && d.moved < 8 && performance.now() - d.t < 450) {
      const args = [e.clientX, e.clientY, d.touch ? 'touch' : 'mouse', e.target];
      if (d.touch) { fireTap(); pendingTap = { args, timer: setTimeout(fireTap, 350) }; } else onTap?.(...args);
    }
    wake();
  };
  on(window, 'pointerup', end);
  on(window, 'pointercancel', end);       // a vertical pan became the browser's scroll: the look springs back
  on(window, 'keydown', e => { if (e.key === 'Tab' || e.key.startsWith('Arrow')) type('keyboard'); if (e.key === 'Escape') onKey?.('Escape'); });

  // ---- tilt (the permission was granted by api.js inside the user's tap)
  const wrap = v => ((v + 540) % 360) - 180;
  const dead = v => (Math.abs(v) < 1.5 ? 0 : v - Math.sign(v) * 1.5);     // a resting hand does not drift the view
  const TILT_RANGE = 28, TILT_MAX = TILT_RANGE + 1.5;                       // degrees for a full look (after the deadband)
  const onOri = e => {
    const t = L.tilt;
    if (!t || e.gamma == null || e.beta == null) return;
    t.seen = true;
    // the screen's rotation decides which device axis is "sideways" (PH-13)
    const a = (screen.orientation?.angle ?? window.orientation ?? 0) | 0;
    let sx = e.gamma, sy = e.beta;
    if (a === 90) { sx = e.beta; sy = -e.gamma; } else if (a === -90 || a === 270) { sx = -e.beta; sy = e.gamma; } else if (a === 180) { sx = -e.gamma; sy = -e.beta; }
    // straight ahead = the attitude when tilt was switched on or the screen last turned. Turned past the look's range,
    // the rest attitude is dragged along (a clutch), so a reader who settles into a new posture is never left looking
    // sideways, and turning back answers at once; inside the range nothing drifts (no redraws for a held tilt)
    if (!t.base || t.a !== a) { t.base = [sx, sy]; t.a = a; }
    const ox = wrap(sx - t.base[0]), oy = wrap(sy - t.base[1]);
    if (Math.abs(ox) > TILT_MAX) t.base[0] += ox - Math.sign(ox) * TILT_MAX;
    if (Math.abs(oy) > TILT_MAX) t.base[1] += oy - Math.sign(oy) * TILT_MAX;
    const gx = dead(wrap(sx - t.base[0])), gy = dead(wrap(sy - t.base[1]));
    // hysteresis: sensor noise and hand tremor (tenths of a degree) never move the target, so a steady hand lets the
    // stage idle (PH-19); the look's time-based smoothing (step) turns these 0.6 deg steps into smooth motion
    if (Math.abs(gx - t.gx) < 0.6 && Math.abs(gy - t.gy) < 0.6) return;
    t.gx = gx; t.gy = gy;
    t.ax = clamp(gx / TILT_RANGE, -1, 1); t.ay = clamp(-gy / TILT_RANGE, -1, 1);
    if (L.drag?.look) return;
    L.dx = t.ax; L.dy = t.ay;
    wake();
  };
  function tilt(onOff) {
    if (!onOff) {
      if (L.tilt) { removeEventListener('deviceorientation', onOri); L.tilt = null; rest(); wake(); }
      return Promise.resolve('off');
    }
    if (L.tilt) return Promise.resolve('on');
    L.tilt = { base: null, a: 0, seen: false, gx: 0, gy: 0, ax: 0, ay: 0 };
    addEventListener('deviceorientation', onOri, { passive: true });
    // no non-null reading within 1 s: the device has no usable sensor
    return new Promise(res => setTimeout(() => { if (L.tilt && !L.tilt.seen) { tilt(false); res('unavailable'); } else res('on'); }, 1000));
  }

  /**
   * Advance the look toward its target (dt s). Returns true while it moves. yaw / pitch in radians, camera frame. It
   * snaps within 1e-4 rad (0.006 deg: about 0.3 px on a 4K screen, 0.03 px on a phone): at 1e-5 every spring-back or
   * tilt step drew about 0.4 s of frames that moved nothing visible (battery, heat).
   */
  function step(dt, gain = 1) {
    const tx = (L.hx * 0.12 + L.dx * 0.56) * gain, ty = (L.hy * 0.07 + L.dy * 0.24) * gain;
    const k = 1 - Math.exp(-dt * 6);
    L.x += (tx - L.x) * k; L.y += (ty - L.y) * k;
    if (Math.abs(tx - L.x) < 1e-4 && Math.abs(ty - L.y) < 1e-4) { L.x = tx; L.y = ty; return false; }
    return true;
  }
  return {
    look: L, step, tilt,
    detach() { for (const [el, ev, fn, opt] of listeners) el.removeEventListener(ev, fn, opt); clearTimeout(pendingTap?.timer); pendingTap = null; tilt(false); },
  };
}
