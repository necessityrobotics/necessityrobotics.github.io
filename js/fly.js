// Map playback for the landing page (DESIGN.md section 2).
//   attachHero(): the first screen's background. The poster paints first; once the hero is visible and the browser is idle,
//     desktops swap it for a LIVE render of the map (Spark, Lite tier) flown along xclean's own trajectory in a loop, with a
//     subtle look-around that follows the mouse (touch screens: a slow drift). Phones / low-memory / Save-Data get the
//     pre-rendered film with a slow CSS drift. Reduced motion keeps the poster. Rendering pauses when the hero is off-screen.
//   attachFilm(): a figure that plays its map's film only while it is on screen (poster first).
// three.js and Spark are imported only inside live(), only then, so the page never waits on them.
import { asset } from './config.js';
import { REDUCED, CONSTRAINED, idle } from './site.js';

function webgl2() {
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch (e) { return false; }
}
const HOVER = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

function makeVideo(m, cls) {
  const v = document.createElement('video');
  Object.assign(v, { muted: true, loop: true, playsInline: true, preload: 'auto', autoplay: true });
  v.setAttribute('muted', ''); v.setAttribute('playsinline', ''); v.setAttribute('aria-hidden', 'true');
  v.className = cls;
  if (m.film.webm) v.insertAdjacentHTML('beforeend', `<source src="${asset(m.id, m.film.webm)}" type='${m.film.webm_type || 'video/webm'}'>`);
  if (m.film.mp4) v.insertAdjacentHTML('beforeend', `<source src="${asset(m.id, m.film.mp4)}" type='${m.film.mp4_type || 'video/mp4'}'>`);
  return v;
}
function playWhileVisible(el, v) {
  new IntersectionObserver(es => { if (es[0].isIntersecting && !document.hidden) v.play().catch(() => {}); else v.pause(); }).observe(el);
  document.addEventListener('visibilitychange', () => { if (document.hidden) v.pause(); });
}

/** A figure (.plate > img) that plays the map's film while visible. */
export function attachFilm(fig, m, { onState } = {}) {
  const plate = fig.querySelector('.plate');
  const state = s => { fig.dataset.state = s; onState?.(s); };
  state('poster');
  if (REDUCED || navigator.connection?.saveData) return;
  let started = false;
  new IntersectionObserver((es, io) => {
    if (!es[0].isIntersecting || started) return;
    started = true; io.disconnect();
    const v = makeVideo(m, 'fly-layer');
    v.addEventListener('playing', () => { v.classList.add('in'); state('film'); }, { once: true });
    plate.appendChild(v);
    playWhileVisible(plate, v);
  }, { rootMargin: '0px 0px -10% 0px' }).observe(plate);
}

/** The hero background: poster -> live playback (desktop) or film (phones). */
export function attachHero(hero, m, { onState, loopS = 34 } = {}) {
  const layer = hero.querySelector('.hero-live');
  const state = s => { hero.dataset.live = s; onState?.(s); };
  state('poster');
  if (REDUCED) return;
  let started = false;
  const go = () => {
    if (started) return; started = true;
    idle(() => {
      if (CONSTRAINED || !webgl2()) return heroFilm(layer, m, state);
      live(hero, layer, m, state, loopS).catch(e => { console.warn('[hero] live playback unavailable, showing the film', e); heroFilm(layer, m, state); });
    }, 2000);
  };
  new IntersectionObserver((es, io) => { if (es[0].isIntersecting) { io.disconnect(); go(); } }).observe(hero);
}

function heroFilm(layer, m, state) {
  if (navigator.connection?.saveData) return;
  const v = makeVideo(m, 'hero-layer hero-drift');
  v.addEventListener('playing', () => { v.classList.add('in'); state('film'); }, { once: true });
  layer.appendChild(v);
  playWhileVisible(layer, v);
}

async function live(hero, layer, m, state, loopS) {
  state('loading');
  const [THREE, { Stage }, { SplatLayer }, { PoseTrack }] = await Promise.all([
    import('three'), import('./viewer/scene.js'), import('./viewer/layers.js'), import('./viewer/trajectories.js'),
  ]);
  const traj = await (await fetch(asset(m.id, 'traj.json'))).json();
  const canvas = document.createElement('canvas');
  canvas.className = 'hero-layer';
  canvas.setAttribute('aria-hidden', 'true');
  layer.appendChild(canvas);
  const stage = new Stage(canvas, { clear: 0x000000 });
  if (!stage.spark) throw stage.sparkError || new Error('Spark unavailable');
  stage.maxScale = Math.min(stage.maxScale, 1.5);          // a background: cap the pixel ratio
  const fit = () => { const r = layer.getBoundingClientRect(); stage.resize(Math.round(r.width), Math.round(r.height)); };
  new ResizeObserver(fit).observe(layer);
  fit();
  const track = new PoseTrack(traj.ours);
  const splats = new SplatLayer(stage);
  await splats.load('lite', asset(m.id, 'splats_lite.spz'));
  splats.setOn(true);
  splats.show('lite', { dur: 0 });

  // camera: xclean's live keyframe pose (OpenCV axes -> three.js axes, keyframes.json three_js_pose), slerped and
  // lightly smoothed, then a look-around offset in the camera's own frame (yaw about its up axis, pitch about its right)
  const cam = stage.camera;
  const VFOV = 46;                                   // the keyframes' rectified K: 2 atan(h/2 / fy)
  const F = new THREE.Matrix4().makeScale(1, -1, -1);
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), qs = new THREE.Quaternion(), M = new THREE.Matrix4();
  const ps = new THREE.Vector3(), pS = new THREE.Vector3(), sc = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);
  const qLook = new THREE.Quaternion(), eLook = new THREE.Euler(0, 0, 0, 'YXZ');
  const s0 = m.film.stretch?.t0 ?? track.t[0];
  const t0 = Math.max(track.t[0], s0 - 2), t1 = Math.min(track.t[track.n - 1], t0 + loopS);
  let t = t0, first = true;
  stage.before.add(() => {
    const asp = stage.size.w / stage.size.h;
    cam.fov = asp >= 1.6 ? VFOV : THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(VFOV) / 2) * 1.6 / asp));
    cam.aspect = asp; cam.near = 0.05; cam.far = 600; cam.updateProjectionMatrix();
  });
  // look-around: the cursor anywhere on the page sets a target of up to 7 deg yaw / 4 deg pitch; touch screens drift
  const look = { x: 0, y: 0, tx: 0, ty: 0 };
  if (HOVER) window.addEventListener('pointermove', e => { look.tx = (e.clientX / innerWidth - 0.5) * 2; look.ty = (e.clientY / innerHeight - 0.5) * 2; }, { passive: true });
  let visible = true, el = 0, fade = 0;
  new IntersectionObserver(es => { visible = es[0].isIntersecting; if (visible) stage.invalidate(); }).observe(hero);
  stage.hooks.add(dt => {
    if (!visible) return false;                       // off-screen: no frames at all
    el += dt;
    t += dt * (m.film.speed_factor || 1);
    // loop with a short dip to black so the cut back to the start is not a jump
    const left = t1 - t;
    fade = left < 0.6 ? Math.max(0, Math.min(fade, left / 0.6)) : Math.min(1, fade + dt / 1.0);
    if (t >= t1) { t = t0; first = true; fade = 0; }
    canvas.style.opacity = canvas.classList.contains('in') ? String(fade.toFixed(3)) : '';
    track.pose(t, p, q);
    M.compose(p, q, one).multiply(F);
    M.decompose(ps, q, sc);
    if (first) { qs.copy(q); pS.copy(ps); first = false; }
    else { qs.slerp(q, 1 - Math.exp(-dt * 4)); pS.lerp(ps, 1 - Math.exp(-dt * 10)); }
    if (!HOVER) { look.tx = Math.sin(el * 0.21) * 0.6; look.ty = Math.sin(el * 0.13) * 0.35; }
    const k = 1 - Math.exp(-dt * 2.5);
    look.x += (look.tx - look.x) * k; look.y += (look.ty - look.y) * k;
    eLook.set(-look.y * THREE.MathUtils.degToRad(4), -look.x * THREE.MathUtils.degToRad(7), 0);
    qLook.setFromEuler(eLook);
    cam.position.copy(pS); cam.quaternion.copy(qs).multiply(qLook);
    return true;
  });
  await stage.sparkReady;
  stage.invalidate();
  canvas.classList.add('in');
  state('live');
}
