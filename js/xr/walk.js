// Walk your own path (owner 2026-11-16: "ar\vr features ... phone and tablet ... imu ... amaze users"). WebXR immersive-ar
// (Android Chrome on ARCore phones): as the visitor walks, a sage line with a tick every metre grows on the real floor
// behind them, the way our maps draw a robot camera's path. At the end the page says how far the phone moved, and what
// xclean does for a robot. HONEST: the line is the PHONE's own tracking (ARCore), not xclean; the page says so. Where the
// phone loses track, the line breaks (no false bar). No camera frame reaches the page; nothing is sent anywhere.
//
//   mountWalk(btn)   shows the button where AR can run (touch + immersive-ar) and starts a walk from its tap
import * as THREE from '/vendor/three/three.module.js';

const SAGE = 0xa7bb98, BONE = 0xe8e0cf;
const MAX_M = 30;                       // CAUTION: a walk stops itself after 30 m
const STEP = 0.15;                      // a new point every 15 cm of the smoothed position (an arm's swing is not a walk)
const HALF = 0.022;                     // the line is 4.4 cm wide on the floor
const MAXSEG = 3000;

const fmt = m => (m < 100 ? m.toFixed(1) : Math.round(m)) + ' m';

function makeUI(onStop) {
  const ui = document.createElement('div');
  ui.className = 'xr-ui';
  ui.innerHTML = `
    <div class="xr-top"><p class="xr-t">YOUR PATH · <span class="xr-m">0.0 M</span></p><button type="button" class="xr-x">Stop</button></div>
    <p class="xr-say" role="status">Hold the phone up. Walk slowly. CAUTION: Look where you walk.</p>`;
  ui.querySelector('.xr-x').addEventListener('click', onStop);
  document.body.append(ui);
  ui.addEventListener('beforexrselect', e => { if (e.target instanceof Element && e.target.closest('button')) e.preventDefault(); });
  return ui;
}

function toast(text) {
  const t = document.createElement('p');
  t.className = 'xr-toast'; t.setAttribute('role', 'status'); t.textContent = text;
  document.body.append(t);
  setTimeout(() => t.remove(), 5000);
}

function endSheet(m, lost, again) {
  const d = document.createElement('div');
  d.className = 'xr-end';
  d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true'); d.setAttribute('aria-labelledby', 'xr-end-h');
  d.innerHTML = `<div class="xr-end-box">
    <p class="xr-end-k">YOUR PATH</p>
    <h3 id="xr-end-h">Your phone moved about ${fmt(m)}.</h3>
    <p>It knew where it was at every step${lost ? ', apart from where the line breaks' : ''}. That line was your phone's own tracking.</p>
    <p><b>xclean does this job for a robot:</b> two cameras and a motion sensor tell it where it is, live.</p>
    <div class="xr-end-acts"><a class="btn btn--acc" href="/explore.html?map=oak_161206">See a robot's path <span aria-hidden="true">→</span></a>
    <button type="button" class="btn xr-again">Walk again</button><button type="button" class="btn xr-done">Close</button></div></div>`;
  document.body.append(d);
  d.querySelector('.xr-done').addEventListener('click', () => d.remove());
  d.querySelector('.xr-again').addEventListener('click', () => { d.remove(); again(); });
  d.addEventListener('keydown', e => { if (e.key === 'Escape') d.remove(); });
  d.querySelector('.btn--acc').focus();
}

export function startWalk() {
  let session = null, renderer = null, ended = false, metres = 0, everLost = false, frames = 0;
  const finish = () => {
    if (ended) return;
    ended = true;
    try { renderer?.setAnimationLoop(null); renderer?.dispose(); renderer?.forceContextLoss(); } catch (e) { /* gone */ }
    renderer?.domElement.remove(); ui.remove();
    if (frames > 0) endSheet(metres, everLost, startWalk);      // only after a walk really ran
  };
  const ui = makeUI(() => (session ? session.end().catch(finish) : finish()));
  const say = t => { ui.querySelector('.xr-say').textContent = t; };
  const sessionP = navigator.xr.requestSession('immersive-ar', { optionalFeatures: ['local-floor', 'dom-overlay'], domOverlay: { root: ui } });
  return sessionP.then(async sess => {
    if (ended) { sess.end().catch(() => {}); return null; }   // closed while the browser still asked: no AR after it
    session = sess;
    session.addEventListener('end', finish);
    const hide = () => { if (document.hidden) session.end().catch(() => {}); };
    document.addEventListener('visibilitychange', hide);
    session.addEventListener('end', () => document.removeEventListener('visibilitychange', hide));
    let floorKnown = true;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
      renderer.domElement.className = 'xr-canvas';
      document.body.append(renderer.domElement);
      renderer.xr.enabled = true;
      try { renderer.xr.setReferenceSpaceType('local-floor'); await renderer.xr.setSession(session); }
      catch (e) { floorKnown = false; renderer.xr.setReferenceSpaceType('local'); await renderer.xr.setSession(session); }
    } catch (e) {
      console.warn('[xr] walk start', e);
      say('AR did not start. Press Stop and try again.');
      session.end().catch(finish);
      return null;
    }

    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(70, 1, 0.01, 100);
    // the line: separate flat quads on the floor (two triangles a segment); a gap where tracking was lost
    const pos = new Float32Array(MAXSEG * 6 * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    const strip = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: SAGE, side: THREE.DoubleSide, transparent: true, opacity: 0.92 }));
    strip.frustumCulled = false;
    scene.add(strip);
    const tickG = new THREE.BoxGeometry(0.12, 0.004, 0.012), tickM = new THREE.MeshBasicMaterial({ color: BONE });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.18, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: BONE, transparent: true, opacity: 0.85 }));
    scene.add(ring);

    let segs = 0, last = null, lastSide = null, floorY = 0, nextTick = 1, lostNow = false, sayUntil = 0, smooth = null;
    const p = new THREE.Vector3(), dir = new THREE.Vector3(), side = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
    const v = (i, x, y, z) => { pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z; };
    const addSeg = (a, sa, b, sb) => {          // quad a-left a-right b-left b-right as two triangles
      const o = segs * 6;
      v(o, a.x + sa.x, a.y, a.z + sa.z); v(o + 1, a.x - sa.x, a.y, a.z - sa.z); v(o + 2, b.x + sb.x, b.y, b.z + sb.z);
      v(o + 3, a.x - sa.x, a.y, a.z - sa.z); v(o + 4, b.x - sb.x, b.y, b.z - sb.z); v(o + 5, b.x + sb.x, b.y, b.z + sb.z);
      segs++; geo.attributes.position.needsUpdate = true; geo.setDrawRange(0, segs * 6);
    };
    renderer.setAnimationLoop((time, frame) => {
      if (!frame) return;
      frames++;
      const pose = frame.getViewerPose(renderer.xr.getReferenceSpace());
      const now = performance.now();
      if (!pose || pose.emulatedPosition) {                         // lost: say it once, then break the line here
        if (!lostNow) { lostNow = true; everLost = true; say('Tracking lost. Move slower. Add light.'); }
        last = null; smooth = null;
      } else {
        const t = pose.transform.position;
        if (!floorKnown && floorY === 0) floorY = t.y - 1.4;        // no floor from the phone: about 1.4 m below the eye
        if (lostNow) { lostNow = false; say('Tracking is back. Walk on.'); sayUntil = now + 2500; }
        else if (sayUntil && now > sayUntil) { sayUntil = 0; say('Hold the phone up. Walk slowly. CAUTION: Look where you walk.'); }
        // the position, smoothed over about half a second (the walk, not the hand)
        const y = (floorKnown ? 0 : floorY) + 0.004;
        if (!smooth) smooth = new THREE.Vector3(t.x, y, t.z);
        else smooth.lerp(p.set(t.x, y, t.z), 0.08);
        ring.position.copy(smooth);
        if (!last) { last = smooth.clone(); lastSide = null; }        // after a gap the line starts again here
        const d = Math.hypot(smooth.x - last.x, smooth.z - last.z);
        if (d >= STEP && segs < MAXSEG) {
          dir.subVectors(smooth, last).setY(0).normalize();
          side.crossVectors(dir, UP).multiplyScalar(HALF);
          addSeg(last, lastSide || side, smooth, side);
          metres += d; last.copy(smooth); lastSide = side.clone();
          if (metres >= nextTick) {                                    // a tick across the line every metre
            const tk = new THREE.Mesh(tickG, tickM);
            tk.position.copy(smooth); tk.rotation.y = Math.atan2(dir.x, dir.z);
            scene.add(tk); nextTick += 1;
          }
          if (metres >= MAX_M) { say('That is 30 m. The walk stops here.'); session.end().catch(() => {}); }
        }
      }
      if ((frames & 7) === 0) ui.querySelector('.xr-m').textContent = fmt(metres).toUpperCase();
      renderer.render(scene, camera);
    });
    return session;
  }, e => {
    if (ended) return null;                                  // closed already: no words about it
    console.warn('[xr] walk', e);
    finish();
    const nm = String(e?.name || '');
    toast(nm === 'NotAllowedError' ? 'AR was not allowed.' : /NotSupported|Security/.test(nm) ? 'This phone cannot start AR here. Open this page in Chrome.' : 'AR did not start. Try again.');
    return null;
  });
}

export function mountWalk(btn) {
  if (!btn) return;
  btn.hidden = false;
  btn.closest('[hidden]')?.removeAttribute('hidden');
  btn.addEventListener('click', () => startWalk());
}
