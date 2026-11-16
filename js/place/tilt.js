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
  return ask.then(r => (r === 'granted' ? probe() : 'denied'), () => 'denied');
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
    if (baseEl == null) baseEl = absPitch ? 0 : Math.max(-25 * DEG, Math.min(0, el));
    const k = smooth;
    let ty = out.yaw;
    if (baseH != null && Math.abs(el) < 80 * DEG) ty = out.yaw + wrapPi(wrapPi(h - baseH) * gain - out.yaw);   // unbounded, continuous
    let yaw = out.yaw + (ty - out.yaw) * (1 - k);
    let pitch = out.pitch + ((el - baseEl) * gain - out.pitch) * (1 - k);
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
