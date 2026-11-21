// Look with your phone (owner 2026-11-16: "can we introduce ar\vr features in site for phone and tablet since they themselves
// have imu? play in that area and amaze users"). The device's orientation turns the 3-D view: a magic window.
//
//   canTilt()                    a touch device in a secure context that has DeviceOrientationEvent (hidden elsewhere)
//   askTilt()                    MUST be called synchronously inside a click/tap handler (iOS asks the visitor once);
//                                resolves 'granted' | 'denied' | 'unavailable' (no reading within 1.2 s)
//   startTilt(cb, opts)          cb({ yaw, pitch }) in radians, relative to the attitude when it started (or recentred):
//                                yaw = the turn about the vertical (left = +), pitch = the change of the view's elevation
//                                (up = +). Roll is ignored, so the horizon stays level. Returns { stop(), recentre() }.
//
// Maths: the device attitude as the old three.js DeviceOrientationControls did it (Euler(beta, alpha, -gamma, 'YXZ'),
// then -90 deg about X so the camera looks out of the back of the device, then the screen angle). From it only the
// forward vector is used: its heading and its elevation, against the same at the start. No Euler deltas (no gimbal lock
// when the phone is upright). A low-pass and a 0.25 deg deadband let the stage rest when the hand is still.
const DEG = Math.PI / 180;
const TOUCH = matchMedia('(hover: none), (pointer: coarse)');

export function canTilt() {
  return !!(window.isSecureContext && 'DeviceOrientationEvent' in window && TOUCH.matches);
}

/** iPhone / iPad (iPadOS says "MacIntel"): the only platform where the visitor must allow motion, from a tap. Recent
 *  Chrome also has requestPermission, so its presence alone does not tell. */
export const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function askTilt({ prompt = true } = {}) {
  const D = window.DeviceOrientationEvent;
  let ask;
  try { ask = prompt && typeof D?.requestPermission === 'function' ? D.requestPermission() : Promise.resolve('granted'); }   // iOS 13+: a prompt
  catch (e) { ask = Promise.resolve('denied'); }
  return ask.then(r => (r === 'granted' ? probe() : 'denied'), () => 'blocked');   // rejected = no gesture, not a "no"
}

/** 'granted' when a real reading arrives within 1.2 s, else 'unavailable' (a desktop, a phone without the sensor). */
function probe() {
  return new Promise(res => {
    let done = false;
    const on = e => { if (e.alpha == null && e.beta == null) return; finish('granted'); };
    const finish = r => { if (done) return; done = true; removeEventListener('deviceorientation', on); res(r); };
    addEventListener('deviceorientation', on, { passive: true });
    setTimeout(() => finish('unavailable'), 1200);
  });
}

/** The forward vector of the device's back camera in a y-up world, as [x, y, z]:
 *  f = Ry(alpha) Rx(beta) Rz(-gamma) Rx(-90 deg) Rz(-screen) (0, 0, -1). Rz(-screen) turns about the view axis, so it does
 *  not move f; Rx(-90 deg) takes (0, 0, -1) to (0, -1, 0) (a phone lying flat looks down). Checked: upright, facing ahead
 *  (beta 90) -> (0, 0, -1); a turn to the left (alpha +) -> heading +; tilted back (beta 120) -> elevation +30 deg. */
function forward(alpha, beta, gamma) {
  const a = alpha * DEG, b = beta * DEG, g = -gamma * DEG;
  let x = 0, y = -1, z = 0;
  const cg = Math.cos(g), sg = Math.sin(g);
  [x, y] = [x * cg - y * sg, x * sg + y * cg];          // Rz(-gamma)
  const cb = Math.cos(b), sb = Math.sin(b);
  [y, z] = [y * cb - z * sb, y * sb + z * cb];          // Rx(beta)
  const ca = Math.cos(a), sa = Math.sin(a);
  [x, z] = [x * ca + z * sa, -x * sa + z * ca];         // Ry(alpha)
  return [x, y, z];
}

const wrapPi = a => Math.atan2(Math.sin(a), Math.cos(a));

/**
 * cb({ yaw, pitch }) on every change past the deadband, cb(null) on stop.
 *   absPitch: pitch = the view's elevation against gravity (phone upright = the horizon), for a true magic window (explore);
 *             else pitch is relative to the start, with the start clamped to -25..0 deg (home)
 *   range:    { yaw, pitch } (radians): past these the base slides along, so the view never pins at an edge (home)
 * The heading is defined only while the phone is not flat (|elevation| < 65 deg): until then, and near straight up or down,
 * the turn holds. A screen rotation does not move the back camera's forward vector, so nothing re-bases on it.
 */
export function startTilt(cb, { gain = 1, deadband = 0.25 * DEG, smooth = 0.35, absPitch = false, range = null } = {}) {
  let baseH = null, baseEl = null, out = { yaw: 0, pitch: 0 }, last = null, on = true;
  function onOri(e) {
    if (!on || document.hidden || (e.alpha == null && e.beta == null)) return;
    const [x, y, z] = forward(e.alpha || 0, e.beta || 0, e.gamma || 0);
    const h = Math.atan2(-x, -z), el = Math.asin(Math.max(-1, Math.min(1, y)));
    if (baseH == null && Math.abs(el) < 65 * DEG) baseH = h - out.yaw / gain;          // continue from the current turn
    if (baseEl == null) baseEl = absPitch ? 0 : Math.max(-25 * DEG, Math.min(0, el));   // (recentre() re-takes it: level again)
    const k = smooth;
    let ty = out.yaw;
    if (baseH != null && Math.abs(el) < 80 * DEG) ty = out.yaw + wrapPi(wrapPi(h - baseH) * gain - out.yaw);   // unbounded, continuous
    let yaw = out.yaw + (ty - out.yaw) * (1 - k);
    // a phone lying flat (or held straight up or down) has no useful elevation: the pitch holds, as the heading does
    let pitch = Math.abs(el) >= 65 * DEG ? out.pitch : out.pitch + ((el - baseEl) * gain - out.pitch) * (1 - k);
    if (range) {                                                   // slide the base: the edge follows the phone
      if (Math.abs(yaw) > range.yaw) { const ex = yaw - Math.sign(yaw) * range.yaw; if (baseH != null) baseH += ex / gain; yaw -= ex; }
      if (Math.abs(pitch) > range.pitch) { const ex = pitch - Math.sign(pitch) * range.pitch; baseEl += ex / gain; pitch -= ex; }
    }
    out = { yaw, pitch };
    if (last && Math.abs(yaw - last.yaw) < deadband && Math.abs(pitch - last.pitch) < deadband) return;
    last = { yaw, pitch };
    cb({ yaw, pitch });
  }
  addEventListener('deviceorientation', onOri, { passive: true });
  return {
    stop() { if (!on) return; on = false; removeEventListener('deviceorientation', onOri); cb(null); },
    /** "ahead" is where the phone points now */
    recentre() { baseH = null; baseEl = null; out = { yaw: 0, pitch: 0 }; last = null; cb({ yaw: 0, pitch: 0 }); },
  };
}

// ------------------------------------------------------------------ the visitor's choice: Phone (the default) or Touch
// Owner 2026-11-21: "make the ar\vr feature as default, option to toggle to touch". The choice is the same on every page
// (localStorage 'nr-look'); touch dragging works in both modes, "Touch" only turns the phone's motion off.
const KEY = 'nr-look';
let memPref = null;                                         // the choice on this page (also when storage is blocked)
export function lookPref() { if (memPref) return memPref; try { return localStorage.getItem(KEY) === 'touch' ? 'touch' : 'phone'; } catch (e) { return 'phone'; } }
export function setLookPref(v) { memPref = v === 'touch' ? 'touch' : 'phone'; try { localStorage.setItem(KEY, memPref); } catch (e) { /* blocked: memPref keeps it */ } }

/**
 * A Phone / Touch switch for a page's 3-D view. el holds two buttons, [data-look="phone"] and [data-look="touch"].
 *   start()   begin the phone look (called after the motion is allowed); stop() end it; say(text) a short message
 * Returns { live(on), stop(), running }. Call live(true) when the 3-D view is ready: with the choice "phone" the look
 * starts then. Android: at once (no prompt). iPhone / iPad: Safari asks only from a tap, so the visitor's first tap on the
 * page (not on a link or a button) asks once; after a "yes" the look comes back by itself (AR, Back / Forward).
 * The switch shows what really runs: "Phone" while the look runs or waits for that first tap, else "Touch".
 */
export function lookSwitch(el, { start, stop, say = () => {} }) {
  const btns = [...el.querySelectorAll('[data-look]')];
  const needsTap = IOS && typeof window.DeviceOrientationEvent?.requestPermission === 'function';
  let running = false, asking = false, granted = false, isLive = false, unarm = null;
  // an iPhone's "no" is kept for this visit, so the pages do not ask again on every tap (the Phone button still asks)
  let refused = false;
  try { refused = sessionStorage.getItem('nr-look-refused') === '1'; } catch (e) { /* blocked */ }
  const show = () => {
    const mode = running || asking || unarm ? 'phone' : 'touch';
    for (const b of btns) b.setAttribute('aria-pressed', String(b.dataset.look === mode));
  };
  const disarm = () => { unarm?.(); unarm = null; };
  const off = () => { disarm(); asking = false; if (running) { running = false; stop(); } show(); };
  const ask = prompt => {
    if (asking || running) return;
    disarm(); asking = true; show();
    askTilt({ prompt }).then(r => {                        // (with prompt: called inside the visitor's tap)
      asking = false;
      if (r === 'granted') {
        granted = true;
        if (lookPref() === 'phone' && isLive && !running) { running = true; start(); }
      } else if (r === 'blocked') {
        // the browser wanted a real tap: wait for the next one (no message, no "no")
        if (needsTap && lookPref() === 'phone' && isLive && !running) { show(); arm(true); return; }
      } else if (prompt || r === 'denied') {
        if (r === 'denied') { refused = true; try { sessionStorage.setItem('nr-look-refused', '1'); } catch (e) { /* blocked */ } }
        say(r === 'denied' ? 'This page has no motion access. Drag to look.' : 'This device gives no motion data. Drag to look.');
      }
      show();
    });
  };
  // an iPhone: the first tap on the page asks (Safari allows the question only inside a tap)
  const arm = (quiet = false) => {
    if (unarm) return;
    let t0 = null;
    const onStart = e => { const p = e.changedTouches && e.changedTouches[0]; t0 = p ? { x: p.clientX, y: p.clientY, t: e.timeStamp } : null; };
    const onTap = e => {
      const p = e.changedTouches && e.changedTouches[0];
      if (!t0 || !p || Math.hypot(p.clientX - t0.x, p.clientY - t0.y) > 10 || e.timeStamp - t0.t > 500) return;   // a scroll, a drag, a long press
      if (e.target instanceof Element && e.target.closest('a, button, input, select, textarea, label, summary, [role="button"], [role="dialog"], #xp-places, #xp-sheet')) return;
      disarm();
      if (lookPref() === 'phone' && isLive && !running) ask(true);
    };
    addEventListener('touchstart', onStart, { capture: true, passive: true });
    addEventListener('touchend', onTap, true);
    unarm = () => { removeEventListener('touchstart', onStart, true); removeEventListener('touchend', onTap, true); };
    show();
    if (!quiet) say('Tap the place once to look with your phone. Or tap the hand button to use touch only.');
  };
  for (const b of btns) b.addEventListener('click', () => {
    const v = b.dataset.look;
    setLookPref(v);
    if (v === 'touch') { const was = running || asking || !!unarm; off(); if (was) say('Phone look is off. Drag to look.'); return; }
    if (!running) ask(true);                               // (inside this tap: an iPhone asks once)
    else show();
  });
  return {
    live(v) {
      isLive = !!v; el.hidden = !isLive;
      if (!isLive) { off(); return; }
      if (lookPref() !== 'phone' || running || asking) { show(); return; }
      if (needsTap && !granted) { if (!refused) arm(); else show(); } else ask(false);
    },
    /** call inside the tap that opens the 3-D view: an iPhone asks then (not on a later tap); the look starts at live() */
    prime() { if (lookPref() === 'phone' && needsTap && !granted && !running) ask(true); },
    stop: off,
    get running() { return running; },
  };
}
