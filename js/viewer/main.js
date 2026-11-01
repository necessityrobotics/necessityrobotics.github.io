// Necessity Robotics 3-D map viewer ("mission control", DESIGN.md section 5.2).
//   viewer.html?map=<id>[&t=<s>][&cam=pov|follow][&q=lite|standard]
//
// Progressive and never blocking (the approved review viewer's pipeline, re-wired to the staged asset layout):
//   0. the catalogue renders from data/maps.json at once, the map's poster fills the stage, and the map's licence and
//      source stay on screen in a credit line whatever the panels do;
//   1. traj.json + keyframes.json + points.json (small, in parallel; from the shared map cache when the home page or an
//      earlier visit already fetched them): trajectory, marker, timeline;
//   2. points.bin streams in HTTP Range chunks; the first chunk puts the 3-D view on screen;
//   3. Lite splats fade in over the points (cache first); on desktops Standard follows; Full (PLY) only on request.
// Arriving from a map link with cam=pov (the home page's chapters and islands, the maps page) lands in xclean's camera
// view at that moment, already playing, with the panels folded away: drag, swipe or the arrow keys look around.
// Every heavy file comes from config.js ASSET_BASE (local mount in development, Hugging Face in production).
// The page shell (poster, catalogue, credit line, controls) needs none of the 3-D code: three.js and Spark (about
// 1.4 MB compressed) load in parallel with the map's data and are never fetched by a browser without WebGL2, so a slow
// link shows the map's picture and credit at once instead of a black screen.
import { asset } from '../config.js';
import { CONSTRAINED, REDUCED, esc, fmtInt, fmtLen, fmtMB, getJSON } from '../site.js';
import { mapBytes, mapJSON, loadPointChunks } from './assets.js';
import { clamp, isTyping } from './util.js';

let THREE, Stage, PointCloud, SplatLayer, Grid, gridCell, PoseTrack, Trajectories, Marker, CameraRig;
const load3d = () => Promise.all([import('three'), import('./scene.js'), import('./layers.js'), import('./trajectories.js'), import('./camera.js')])
  .then(([three, sc, ly, tr, cam]) => {
    THREE = three;
    ({ Stage } = sc); ({ PointCloud, SplatLayer, Grid, gridCell } = ly); ({ PoseTrack, Trajectories, Marker } = tr); ({ CameraRig } = cam);
    initMath();
  });

const $ = s => document.querySelector(s);
const qs = k => new URLSearchParams(location.search).get(k);
const vw = $('.vw');
const ARRIVE_POV = qs('cam') === 'pov';
const S = { m: null, t: 0, t0: 0, t1: 1, playing: false, speed: 1, cam: 'orbit', layer: 'points', tier: null };
const R = {};
window.__viewer = { S, R };

function note(html, ms = 0) {
  const n = $('.js-note');
  n.innerHTML = html; n.hidden = false;
  clearTimeout(note.t);
  if (ms) note.t = setTimeout(() => { n.hidden = true; }, ms);
  return n;
}

// ---------------------------------------------------------------- loading list (real bytes, never a spinner)
const LD = {};
function ld(key, label, bytes) {
  const li = document.createElement('li');
  li.innerHTML = `<b>${esc(label)}</b> <span class="js-b">${bytes ? fmtMB(bytes) : ''}</span><span class="bar"><i></i></span>`;
  $('.js-ld').appendChild(li);
  LD[key] = { li, bytes };
}
function ldp(key, loaded, total) {
  const x = LD[key]; if (!x) return;
  const tot = total || x.bytes || 0;
  x.li.querySelector('.bar i').style.setProperty('--p', `${tot ? clamp(100 * loaded / tot, 0, 100).toFixed(1) : 0}%`);
  x.li.querySelector('.js-b').textContent = tot ? `${fmtMB(loaded)} / ${fmtMB(tot)}` : fmtMB(loaded);
}
function ldd(key, text) { const x = LD[key]; if (!x) return; x.li.classList.add('done'); x.li.querySelector('.bar i').style.setProperty('--p', '100%'); if (text) x.li.querySelector('.js-b').textContent = text; }
function ldf(key, text) { const x = LD[key]; if (!x) return; x.li.classList.add('fail'); x.li.querySelector('.js-b').textContent = text || 'failed'; }

// ---------------------------------------------------------------- panels and site menu
function setPanels(open) {
  vw.dataset.panels = open ? 'open' : 'closed';
  $('.js-info-btn').setAttribute('aria-expanded', String(open));
  if (open) feed();
}
function setMenu(open) {
  $('#vw-nav').hidden = !open;
  $('.js-menu-btn').setAttribute('aria-expanded', String(open));
  $('.js-menu-btn').textContent = open ? 'Close' : 'Menu';
}
$('.js-info-btn').addEventListener('click', () => setPanels(vw.dataset.panels === 'closed'));
$('.js-menu-btn').addEventListener('click', () => setMenu($('#vw-nav').hidden));
setPanels(!(CONSTRAINED || ARRIVE_POV));
// the credit line sits just above the control bar, whatever height the bar wraps to
new ResizeObserver(([e]) => vw.style.setProperty('--bar-h', `${Math.round(e.borderBoxSize?.[0]?.blockSize ?? e.target.offsetHeight)}px`)).observe($('.vw-bar'));

// ---------------------------------------------------------------- catalogue panel
const STXT = st => { let m = st.match(/^div (\d+)\/(\d+)$/); if (m) return `diverged in ${m[1]} of ${m[2]} runs`;
  m = st.match(/^lost (\d+)\/(\d+)$/); if (m) return `lost tracking in ${m[1]} of ${m[2]} runs`; return st === 'partial span' ? 'covers only part of the route' : st; };
const SETS = { design: 'design route, used during development', k12: 'seen once by an earlier kill test', k13: 'seen once by an earlier kill test', k14: 'seen once by the last kill test', unseen: 'unseen route', sealed: 'unseen route' };
const VTXT = { win: 'xclean better', tie: 'tie', loss: 'ORB-SLAM3 better', win_forfeit: 'xclean, by forfeit', loss_forfeit: 'ORB-SLAM3, by forfeit', both_lost: 'both lost' };
const CC_BY = 'https://creativecommons.org/licenses/by/4.0/';
/**
 * The map picker opens the chosen map. A pick from the open list (pointer, touch, or the list's own Enter) opens it at
 * once. Arrow keys or type-ahead on the closed picker (Windows and Linux change the value without opening the list) only
 * move the choice and Enter opens it, so a keyboard visitor can read the list without a reload on every key (WCAG
 * 3.2.2); leaving the picker without Enter puts back the map on screen.
 */
function wireMapPicker(sel, m, maps) {
  const go = () => { if (sel.value !== m.id) location.search = `?map=${encodeURIComponent(sel.value)}`; };
  let keyAt = -1e9, pending = false;
  sel.addEventListener('keydown', e => {
    if (e.key === 'Enter') { if (sel.value !== m.id) { e.preventDefault(); go(); } return; }
    if (e.key.startsWith('Arrow') || ['Home', 'End', 'PageUp', 'PageDown'].includes(e.key) || (e.key.length === 1 && e.key !== ' ')) keyAt = performance.now();
  });
  sel.addEventListener('change', () => {
    if (performance.now() - keyAt > 80) { go(); return; }   // not the same task as a key on the closed picker: a pick from the list
    pending = true;
    const x = maps.find(y => y.id === sel.value);
    note(`Press Enter to open ${esc(x ? x.title : sel.value)} (${esc(sel.value)}).`, 6000);
  });
  sel.addEventListener('blur', () => { if (pending && sel.value !== m.id) sel.value = m.id; pending = false; });
}
function catalogue(m, maps, board) {
  const s = m.stats;
  $('.js-cat-id').textContent = `Catalogue · ${m.id}`;
  $('#vw-title').textContent = m.title;
  // the page's heading stays readable when the panels are folded away (POV arrivals, phones)
  $('.js-sr-title').textContent = `3-D map viewer: ${m.title} (${m.id})`;
  $('.js-sub').textContent = `${m.platform} · ${m.place}`;
  $('.js-lic').textContent = `${m.map_licence}${m.own_data ? ' · own data' : ' · Rosario Dataset'}`;
  const r = board?.rows.find(x => x.route === m.board_route);
  const f3 = x => (x < 10 ? x.toFixed(3) : x.toFixed(2));
  $('.js-kv').innerHTML = `
    <dt>Duration</dt><dd>${s.duration_s.toFixed(1)} s</dd>
    <dt>Path</dt><dd>${fmtLen(s.path_m)}</dd>
    <dt>Keyframes</dt><dd>${fmtInt(s.keyframes)}</dd>
    <dt>Gaussians</dt><dd>${(s.gaussians / 1e6).toFixed(2)} M</dd>
    <dt>Points</dt><dd>${fmtInt(s.points)}</dd>
    ${r?.gt && r.ours ? `<dt>Board ATE</dt><dd>${f3(r.ours.med)} m (ORB-SLAM3 ${f3(r.orb3.med)} m${r.orb3.status ? `; ORB-SLAM3 ${esc(STXT(r.orb3.status))}` : ''}${r.orb3.stereo_only && r.orb3.stereo_only === r.orb3.draws ? '; ORB-SLAM3 ran stereo-only here: its IMU start-up crashed' : ''}): ${esc(VTXT[r.vs_orb3] || r.vs_orb3)}${SETS[r.group] ? ` (${esc(SETS[r.group])})` : ''} · <a href="results.html#r-${esc(r.route)}">row</a> · <a href="results.html#disclosures">K14 caveat</a></dd>` : ''}
    ${r && !r.gt ? `<dt>Latency</dt><dd>${r.lat_ms_p50.toFixed(1)} ms median · <a href="results.html#r-${esc(r.route)}">row</a></dd>` : ''}
    <dt>Poses</dt><dd>xclean's live output in a real-time (paced) replay: the median run of the three final-board runs</dd>`;
  $('.js-lim').textContent = m.limitation;
  $('.js-credit').textContent = m.credit;
  $('.vw-cat').dataset.ready = '';
  // the credit line: on screen at every width, panels open or closed (the Rosario credit in its short form)
  const chip = $('.js-chip');
  chip.innerHTML = `<span>${m.own_data ? '3-D map by Necessity Robotics (xclean)' : 'Source images: The Rosario Dataset, CIFASIS-CONICET, CC BY 4.0'} · map <a href="${CC_BY}">CC BY 4.0</a> · <a href="credits.html#maps">credits</a></span>`
    + '<span class="vw-chip-k">A 3-D reconstruction from xclean\'s camera poses, not camera video.</span>';
  chip.hidden = false;
  const sel = $('.js-map');
  sel.innerHTML = maps.map(x => `<option value="${esc(x.id)}" ${x.id === m.id ? 'selected' : ''}>${esc(x.id)} · ${esc(x.title)}</option>`).join('');
  wireMapPicker(sel, m, maps);
  document.title = `${m.id} · 3-D map viewer · Necessity Robotics`;
}

// ---------------------------------------------------------------- fallback (no WebGL2): the film
function fallback(m, msg) {
  vw.dataset.state = 'fallback';
  setPanels(!CONSTRAINED);
  const fb = $('.js-fallback'); fb.hidden = false;
  $('.js-fb-msg').textContent = msg;
  const v = $('.js-fb-video');
  v.poster = `img/maps/${m.id}.webp`;
  v.innerHTML = `${m.film.webm ? `<source src="${asset(m.id, m.film.webm)}" type='${m.film.webm_type}'>` : ''}<source src="${asset(m.id, m.film.mp4)}" type='${m.film.mp4_type}'>`;
  $('.vw-bar').hidden = true;
}

// ---------------------------------------------------------------- context loss: poster up, then a fresh start at the same moment
function viewUrl() {
  const u = new URL(location.href);
  u.searchParams.set('map', S.m.id);
  u.searchParams.set('t', S.t.toFixed(1));
  u.searchParams.set('cam', S.cam);
  return u.href;
}
function onContext(state) {
  if (state === 'lost') {
    vw.dataset.state = 'lost';
    play(false);
    const n = note('The browser paused the 3-D view to save memory. <button type="button" class="vbtn js-reload">Restart the 3-D view</button>');
    n.querySelector('.js-reload').onclick = () => location.replace(viewUrl());
  } else {
    location.replace(viewUrl());
  }
}

// ---------------------------------------------------------------- scene
let stage, rig;
/** The run's box in the world (gravity up) and the floor under the camera: typed arrays, no per-point objects. */
function bounds() {
  const e = stage.world.matrixWorld.elements, tr = R.track, v = new THREE.Vector3();
  const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = lo.clone().negate();
  const ys = new Float32Array(tr.n);
  for (let i = 0; i < tr.n; i++) { v.set(tr.p[i * 3], tr.p[i * 3 + 1], tr.p[i * 3 + 2]).applyMatrix4(stage.world.matrixWorld); lo.min(v); hi.max(v); ys[i] = v.y; }
  const s = R.points ? R.points.sampleMap(12000) : new Float32Array(0);
  const py = new Float32Array(s.length / 3);
  for (let i = 0, j = 0; i < s.length; i += 3, j++) py[j] = e[1] * s[i] + e[5] * s[i + 1] + e[9] * s[i + 2] + e[13];
  ys.sort(); py.sort();
  const camY = ys[ys.length >> 1];
  let k = 0;
  while (k < py.length && py[k] < camY - 0.2) k++;   // the points below the camera: py[0..k)
  const floor = k > 200 ? py[Math.floor(k * 0.6)] : lo.y - 1.5;
  const center = lo.clone().add(hi).multiplyScalar(0.5);
  const size = hi.clone().sub(lo);
  const horiz = Math.max(size.x, size.z, 1);
  const dur = Math.max(1e-3, tr.t[tr.n - 1] - tr.t[0]);
  return { center, size, horiz, radius: Math.max(1, 0.5 * Math.hypot(size.x, size.z) * 1.05), floor, speed: tr.cum[tr.n - 1] / dur };
}

let pp, pq, fwd, F_CV, ONE;   // scratch maths, made by initMath() once three.js has loaded
function setTime(t, fromUser = false) {
  S.t = clamp(t, S.t0, S.t1);
  if (!R.track) return;
  R.track.pose(S.t, pp, pq);
  R.marker?.set(pp, pq);
  const wq = stage.world.quaternion;
  const wp = pp.clone().applyQuaternion(wq);
  fwd.set(0, 0, 1).applyQuaternion(pq).applyQuaternion(wq);
  rig.setFollowTarget(wp, fwd);
  $('.js-t').textContent = `${S.t.toFixed(1)} s`;
  $('.js-d').textContent = fmtLen(R.track.dist(S.t));
  const i = R.track.nearest(S.t);
  $('.js-kf').textContent = `${i + 1} of ${fmtInt(R.track.n)}`;
  const sc = $('.js-scrub');
  if (!fromUser) sc.value = S.t.toFixed(2);
  $('.js-tt').textContent = `${S.t.toFixed(1)} / ${S.t1.toFixed(1)} s`;
  feed();
  stage.invalidate();
}
let feedAt = -1;
function feed() {
  const k = R.kfs?.keyframes; if (!k?.length || vw.dataset.panels === 'closed') return;
  let j = 0; for (let i = 0; i < k.length; i++) if (k[i].t <= S.t) j = i;
  if (j === feedAt) return;
  feedAt = j;
  $('.js-feed').classList.remove('is-empty');
  $('.js-feed-img').src = asset(S.m.id, k[j].file);
  $('.js-feed-t').textContent = `real keyframe image at ${k[j].t.toFixed(1)} s`;
}

function play(on) {
  if (!stage) return;
  S.playing = on;
  const b = $('.js-play');
  b.textContent = on ? 'Pause' : 'Play';
  b.setAttribute('aria-label', on ? 'Pause the run' : 'Play the run');
  if (on && S.t >= S.t1 - 0.05) setTime(S.t0);
  // Play takes you into the camera's own POV, unless you chose Free or Chase yourself
  if (on && S.cam === 'orbit' && !S.camChosen) setCam('pov');
  stage.invalidate();
}

// ---------------------------------------------------------------- POV: the SLAM camera's own view, explorable
// camera.matrixWorld = world.matrixWorld * T_map_cam(t) * diag(1,-1,-1,1) (keyframes.json three_js_pose); the projection is
// the keyframes' rectified K mapped onto an image rectangle that covers the canvas (camera.js _povFrustum, principal point
// included). The visitor can look around (drag, arrow keys), pull back (wheel / pinch) and recenter (double-click) while
// it plays.
const POV = { yaw: 0, pitch: 0, tyaw: 0, tpitch: 0, back: 0, tback: 0, blend: 1, from: null, init: false };
window.__viewer.POV = POV;
function initMath() {
  pp = new THREE.Vector3(); pq = new THREE.Quaternion(); fwd = new THREE.Vector3();
  F_CV = new THREE.Matrix4().makeScale(1, -1, -1); ONE = new THREE.Vector3(1, 1, 1);
  Object.assign(POV, { tp: new THREE.Vector3(), tq: new THREE.Quaternion(), sp: new THREE.Vector3(), sq: new THREE.Quaternion(), M: new THREE.Matrix4(), sc: new THREE.Vector3() });
}
function povRect() {
  const { w: W, h: H } = stage.size, [IW, IH] = R.kfs.image_size;
  const s = Math.max(W / IW, H / IH);
  return { x: (W - IW * s) / 2, y: (H - IH * s) / 2, w: IW * s, h: IH * s };
}
function povPose(outP, outQ) {
  R.track.pose(S.t, pp, pq);
  POV.M.compose(pp, pq, ONE).premultiply(stage.world.matrixWorld).multiply(F_CV);
  POV.M.decompose(outP, outQ, POV.sc);
}
function povStep(dt) {
  if (S.cam !== 'pov' || !R.track) return false;
  povPose(POV.tp, POV.tq);
  if (!POV.init) { POV.sp.copy(POV.tp); POV.sq.copy(POV.tq); POV.init = true; }
  else { POV.sp.lerp(POV.tp, 1 - Math.exp(-dt * 14)); POV.sq.slerp(POV.tq, 1 - Math.exp(-dt * 9)); }
  const k = 1 - Math.exp(-dt * 10);
  POV.yaw += (POV.tyaw - POV.yaw) * k; POV.pitch += (POV.tpitch - POV.pitch) * k; POV.back += (POV.tback - POV.back) * k;
  const q = POV.sq.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(POV.pitch, POV.yaw, 0, 'YXZ')));
  const p = POV.sp.clone().add(new THREE.Vector3(0, 0, 1).applyQuaternion(q).multiplyScalar(POV.back));
  const cam = stage.camera;
  if (POV.blend < 1) {
    POV.blend = Math.min(1, POV.blend + dt / (REDUCED ? 0.01 : 1.2));
    const e = POV.blend < 0.5 ? 4 * POV.blend ** 3 : 1 - Math.pow(-2 * POV.blend + 2, 3) / 2;
    cam.position.lerpVectors(POV.from.p, p, e); cam.quaternion.slerpQuaternions(POV.from.q, q, e);
    if (POV.blend >= 1) rig.pov = { K: R.kfs.K, size: R.kfs.image_size };   // the camera's own intrinsics once it has arrived
  } else {
    cam.position.copy(p); cam.quaternion.copy(q);
  }
  const moving = POV.sp.distanceToSquared(POV.tp) > 1e-8 || 1 - Math.abs(POV.sq.dot(POV.tq)) > 1e-10
    || Math.abs(POV.tyaw - POV.yaw) > 1e-4 || Math.abs(POV.tpitch - POV.pitch) > 1e-4 || Math.abs(POV.tback - POV.back) > 1e-3;
  return S.playing || POV.blend < 1 || moving;
}
function recenter() { POV.tyaw = 0; POV.tpitch = 0; POV.tback = 0; stage.invalidate(); }
const POV_HINT = matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches
  ? 'Camera POV: swipe to look around, pinch to pull back, double-tap to recenter. <b>Free</b> lets you orbit the map.'
  : 'Camera POV: drag or use the arrow keys to look around, scroll or pinch to pull back, double-click to recenter. <b>Free</b> lets you orbit the map.';

/** Switch camera mode. instant: land in POV at once (arriving from a map link, the frame matches the one just left). */
function setCam(mode, { user = false, instant = false } = {}) {
  if (user) S.camChosen = mode !== 'pov';
  const prev = S.cam;
  S.cam = mode;
  if (mode === 'pov') {
    if (prev !== 'pov') {
      rig.setMode('pov');
      rig.cancelTween?.(false);
      POV.from = { p: stage.camera.position.clone(), q: stage.camera.quaternion.clone() };
      POV.init = false;
      POV.blend = instant ? 1 : 0;
      rig.pov = instant ? { K: R.kfs.K, size: R.kfs.image_size } : null;
      if (!S.povHinted) { S.povHinted = true; note(POV_HINT, 7000); }
    }
  } else {
    rig.pov = null;
    rig.setMode(mode);
  }
  document.querySelectorAll('.js-cam button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === mode)));
  const inPov = mode === 'pov';
  if (R.marker) R.marker.group.visible = !inPov;
  if (R.grid) R.grid.mesh.visible = !inPov;
  if (R.trajs) R.trajs.group.visible = !inPov;
  vw.dataset.cam = mode;
  if (mode === 'follow' && !S.playing && !REDUCED) play(true);
  stage.invalidate();
}
function wirePovInput() {
  const el = stage.canvas;
  const ptrs = new Map();
  let drag = null, pinch = null;
  el.addEventListener('pointerdown', e => {
    if (S.cam !== 'pov') return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    el.setPointerCapture?.(e.pointerId);
    if (ptrs.size === 1) drag = { x: e.clientX, y: e.clientY, yaw: POV.tyaw, pitch: POV.tpitch };
    if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), back: POV.tback }; drag = null; }
  });
  el.addEventListener('pointermove', e => {
    if (S.cam !== 'pov' || !ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const fovK = stage.size.h > 0 ? 1.4 / stage.size.h : 0.004;
    const f = rig.scene.followDist || 3;
    if (pinch && ptrs.size === 2) {
      const [a, b] = [...ptrs.values()];
      POV.tback = clamp(pinch.back + (pinch.d - Math.hypot(a.x - b.x, a.y - b.y)) * 0.02 * f / 3, 0, f * 4);
    } else if (drag) {
      POV.tyaw = clamp(drag.yaw + (e.clientX - drag.x) * fovK, -1.4, 1.4);
      POV.tpitch = clamp(drag.pitch + (e.clientY - drag.y) * fovK, -0.7, 0.7);
    }
    stage.invalidate();
  });
  // a double tap recenters on touch screens (they send no dblclick reliably; the canvas has touch-action: none)
  let lastTap = null;
  const up = e => {
    const d = drag;
    ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null; if (!ptrs.size) drag = null;
    if (e.type !== 'pointerup' || e.pointerType !== 'touch' || S.cam !== 'pov' || !d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10) return;
    const now = performance.now();
    if (lastTap && now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) { lastTap = null; recenter(); }
    else lastTap = { t: now, x: e.clientX, y: e.clientY };
  };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  el.addEventListener('wheel', e => {
    if (S.cam !== 'pov') return;
    e.preventDefault();
    const f = rig.scene.followDist || 3;
    POV.tback = clamp(POV.tback + e.deltaY * 0.004 * f, 0, f * 4);
    stage.invalidate();
  }, { passive: false });
  el.addEventListener('dblclick', () => { if (S.cam === 'pov') recenter(); });
}

function setLayer(mode) {
  S.layer = mode;
  document.querySelectorAll('.js-layer button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === mode)));
  R.points?.setMode(mode === 'splats' ? 'off' : mode === 'both' ? 'both' : 'points');
  R.splats?.setOn(mode !== 'points');
  stage?.invalidate();
}

function setTierUI() {
  document.querySelectorAll('.js-q button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === S.tier)));
}

const TIER_FILE = { lite: 'splats_lite.spz', standard: 'splats.spz', full: 'full/splats.ply' };
async function loadTier(tier) {
  const m = S.m, file = TIER_FILE[tier];
  if (!m.files[file]) throw new Error(`no ${tier} file for this map`);
  if (R.splats.has(tier)) return;
  if (!LD[tier]) ld(tier, `${tier[0].toUpperCase()}${tier.slice(1)} splats`, m.files[file]);
  const onProgress = (l, t) => ldp(tier, l, t);
  // Lite and Standard: our own fetch, so the bytes come from (and go to) the shared map cache; Full streams in Spark
  const src = tier === 'full' ? asset(m.id, file)
    : { bytes: await mapBytes(asset(m.id, file), { onProgress, keep: tier === 'lite' }), fileName: file };
  const mesh = await R.splats.load(tier, src, { onProgress });
  ldd(tier, `${(mesh.numSplats / 1e6).toFixed(2)} M splats`);
}
async function showTier(tier) {
  try {
    await loadTier(tier);
  } catch (e) {
    if (e?.name === 'AbortError') return;
    ldf(tier); console.warn('[viewer] splats', tier, e);
    note(`The ${tier} splats could not be loaded. Showing the point cloud.`, 8000);
    return;
  }
  const first = !S.tier;
  S.tier = tier;
  R.splats.show(tier, { dur: REDUCED ? 0 : 700, drop: ['lite', 'standard', 'full'].filter(x => x !== tier) });
  setTierUI();
  if (first) setLayer('splats');
  $('.js-draw').textContent = `${fmtInt(R.splats.numSplats)} splats`;
}

function onQuality(q) {
  if (!R.splats || q === S.tier) return;
  if (q === 'full') {
    const b = S.m.files['full/splats.ply'];
    const n = note(`Full resolution is one ${fmtMB(b)} file, ${(S.m.stats.gaussians / 1e6).toFixed(1)} M Gaussians. Standard already holds every Gaussian, compressed. <button type="button" class="vbtn js-yes">Load ${fmtMB(b)}</button> <button type="button" class="vbtn js-no">Cancel</button>`);
    n.querySelector('.js-yes').onclick = () => { n.hidden = true; showTier('full'); };
    n.querySelector('.js-no').onclick = () => { n.hidden = true; };
    return;
  }
  showTier(q);
}

// ---------------------------------------------------------------- boot
(async function boot() {
  // the WebGL2 context is made once, on the real canvas, and handed to the renderer (no throwaway probe context); with
  // it in hand the 3-D modules start downloading at once, alongside the catalogue's data below
  let gl = null;
  try { gl = $('#vw-canvas').getContext('webgl2', { antialias: false, alpha: false, stencil: false, powerPreference: 'high-performance' }); } catch (e) { gl = null; }
  const mods = gl ? load3d() : null;
  mods?.catch(() => {});   // awaited (and reported) below, once the shell is on screen
  const [M, board] = await Promise.all([getJSON('data/maps.json'), getJSON('data/board.json').catch(() => null)]);
  const m = M.maps.find(x => x.id === qs('map')) || M.maps.find(x => x.id === M.hero) || M.maps[0];
  S.m = m;
  catalogue(m, M.maps, board);
  const poster = $('.js-poster');
  poster.fetchPriority = 'high';
  poster.src = `img/maps/${m.id}.webp`;
  if (!gl) { fallback(m, 'This browser has no WebGL2, so here is the pre-rendered film of this map instead.'); return; }
  // the map's small files (trajectory, keyframes, point-cloud header) download while three.js and Spark still arrive
  ld('traj', 'Trajectory + keyframes', (m.files['traj.json'] || 0) + (m.files['keyframes.json'] || 0));
  ld('points', 'Point cloud', m.files['points.bin']);
  const data = Promise.all([mapJSON(asset(m.id, 'traj.json'), { onProgress: l => ldp('traj', l) }), mapJSON(asset(m.id, 'keyframes.json')), mapJSON(asset(m.id, 'points.json'))]);
  data.catch(() => {});   // awaited (and reported) below
  // drawing-buffer caps: phones 1.25 x / 1.2 MP, desktops 2 x / 4.2 MP (a 4K screen draws at about 0.75 scale)
  try {
    await mods;
    stage = new Stage($('#vw-canvas'), { context: gl, clear: 0x000000, maxDpr: CONSTRAINED ? 1.25 : 2, maxPixels: CONSTRAINED ? 1.2e6 : 4.2e6, onContext });
  } catch (e) {
    console.warn('[viewer] 3-D start', e);
    fallback(m, 'The 3-D view could not start here, so here is the pre-rendered film of this map instead.');
    return;
  }
  window.__viewer.stage = stage;
  rig = new CameraRig(stage, stage.canvas);
  const fit = () => stage.resize(innerWidth, innerHeight);
  addEventListener('resize', fit); fit();
  wirePovInput();
  stage.hooks.add(dt => povStep(dt));
  stage.before.add(() => { if (S.cam === 'pov' && R.kfs) rig.povRect = povRect(); });   // no invalidate from inside a frame
  stage.hooks.add(dt => {
    if (!S.playing || !R.track) return false;
    let t = S.t + dt * S.speed;
    if (t >= S.t1) { t = S.t1; setTime(t); play(false); return false; }
    setTime(t);
    return true;
  });
  let drawAt = 0;
  stage.after.add(() => {
    const now = performance.now();
    if (now - drawAt < 500) return; drawAt = now;
    if (R.splats?.numSplats && S.layer !== 'points') $('.js-draw').textContent = `${fmtInt(R.splats.numSplats)} splats`;
    else if (R.points) $('.js-draw').textContent = `${fmtInt(R.points.n)} points`;
  });

  let traj, kfs, pmeta;
  try {
    [traj, kfs, pmeta] = await data;
  } catch (e) {
    console.error('[viewer] map data', e); ldf('traj');
    fallback(m, 'The map files could not be loaded from the map host. Here is the pre-rendered film instead.');
    return;
  }
  ldd('traj', `${fmtInt(traj.ours.t.length)} poses`);
  R.kfs = kfs;
  // world: gravity up -> +Y
  const up = new THREE.Vector3(...(traj.notes?.gravity?.up_map || traj.up || [0, -1, 0])).normalize();
  stage.world.quaternion.setFromUnitVectors(up, new THREE.Vector3(0, 1, 0));
  stage.world.updateMatrixWorld(true);
  R.track = new PoseTrack(traj.ours);
  const C = { ours: '#6cc9ff', orb3: '#ffad7a', gt: '#f2f5fa', ink: '#000000', none: '#a3aebe' };
  const ext = Math.max(1, R.track.cum[R.track.n - 1] / 20);
  R.trajs = new Trajectories({ ...traj, orb3: null }, { seg: null, C, ramp: null, scale: null, dash: clamp(ext / 40, 0.05, 6) });
  stage.world.add(R.trajs.group);
  if (traj.gt) { $('.js-gt-wrap').hidden = false; }
  R.marker = new Marker(kfs, { size: clamp(ext * 0.05, 0.15, 3), color: C.ours, pr: stage.drawScale });
  stage.world.add(R.marker.group);
  stage.before.add(() => { R.points?.setPixelRatio(stage.drawScale); R.marker?.setPixelRatio(stage.drawScale); });
  S.t0 = traj.t0 ?? R.track.t[0]; S.t1 = traj.t1 ?? R.track.t[R.track.n - 1];
  const sc = $('.js-scrub'); sc.min = S.t0; sc.max = S.t1;

  // points
  R.points = new PointCloud(pmeta, { pr: stage.drawScale });
  stage.world.add(R.points.object);
  let shown = false;
  const showScene = () => {
    if (shown) return; shown = true;
    const b = bounds();
    R.grid = new Grid(); R.grid.build({ center: b.center, y: b.floor, extent: b.horiz, cell: gridCell(b.horiz) });
    stage.scene.add(R.grid.mesh);
    rig.setScene({ center: b.center, radius: b.radius, followDist: clamp(Math.max(b.speed * 2.2, b.horiz * 0.015), 1.4, 14) });
    const view = rig.defaultView({ azimuth: 0.7, elevation: 0.75 });
    R.points.setScale({ ref: view.dist, fogNear: view.dist * 0.7, fogFar: view.dist * 3.5 });
    const ft = m.film?.stretch?.t0, tq = Number(qs('t'));
    setTime(qs('t') && Number.isFinite(tq) ? tq : (Number.isFinite(ft) ? ft : S.t0));
    vw.dataset.state = 'live';
    if (ARRIVE_POV) {
      setCam('pov', { instant: true });
      if (!REDUCED) play(true);
    } else {
      rig.intro(view, { dur: REDUCED ? 0 : 2200 });
      if (qs('cam') === 'follow') setCam('follow');
    }
  };
  const pts = loadPointChunks(asset(m.id, 'points.bin'), pmeta, {
    onProgress: (l, t) => ldp('points', l, t),
    onChunk: ch => { R.points.addChunk(ch); stage.invalidate(); if (ch.start === 0) showScene(); },
  }).then(() => ldd('points', `${fmtInt(R.points.n)} points`)).catch(e => { console.warn('[viewer] points', e); ldf('points'); showScene(); });
  await Promise.race([pts, new Promise(r => setTimeout(r, 2000))]);
  showScene();

  // splats: Lite first, then Standard on desktops
  R.splats = new SplatLayer(stage);
  if (!stage.spark) { note('Splats need Spark, which did not start in this browser. Showing the point cloud.', 9000); document.querySelectorAll('.js-q button, .js-layer button').forEach(b => { b.disabled = true; }); return; }
  for (const b of document.querySelectorAll('.js-q button')) {
    const f = TIER_FILE[b.dataset.v];
    if (!m.files[f]) b.disabled = true;
    b.title = m.files[f] ? fmtMB(m.files[f]) : 'not published for this map';
  }
  const want = ['lite', 'standard'].includes(qs('q')) ? qs('q') : CONSTRAINED ? 'lite' : 'standard';
  await showTier('lite');
  if (want === 'standard') showTier('standard');
  else if (CONSTRAINED && !ARRIVE_POV) note(`Showing the Lite splats to keep this device responsive. Standard is ${fmtMB(m.files['splats.spz'])}.`, 9000);
})().catch(e => { console.error('[viewer]', e); note('The viewer hit an error. The <a href="maps.html">maps page</a> has the films.'); });

// ---------------------------------------------------------------- controls
$('.js-play').addEventListener('click', () => play(!S.playing));
$('.js-scrub').addEventListener('input', e => { setTime(Number(e.target.value), true); });
$('.js-speed').addEventListener('change', e => { S.speed = Number(e.target.value); });
document.querySelectorAll('.js-cam button').forEach(b => b.addEventListener('click', () => { if (!stage) return; if (b.dataset.v === 'pov' && S.cam === 'pov') recenter(); else setCam(b.dataset.v, { user: true }); }));
document.querySelectorAll('.js-layer button').forEach(b => b.addEventListener('click', () => setLayer(b.dataset.v)));
document.querySelectorAll('.js-q button').forEach(b => b.addEventListener('click', () => onQuality(b.dataset.v)));
$('.js-v-ours').addEventListener('change', e => { R.trajs?.set('ours', e.target.checked); stage?.invalidate(); });
$('.js-v-gt').addEventListener('change', e => { R.trajs?.set('gt', e.target.checked); stage?.invalidate(); });
const LOOK = { ArrowLeft: [-0.12, 0], ArrowRight: [0.12, 0], ArrowUp: [0, -0.08], ArrowDown: [0, 0.08] };
addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#vw-nav').hidden) { setMenu(false); $('.js-menu-btn').focus(); return; }
  if (isTyping(e) || !stage || !R.track) return;
  // Space belongs to a focused button or link (it activates it); everywhere else (the 3-D view, the page) it plays
  if (e.key === ' ' && e.target instanceof Element && e.target.closest('button, a[href], summary, [role="button"]')) return;
  if (e.key === ' ') { e.preventDefault(); play(!S.playing); }
  else if (e.key === 'f' || e.key === 'F') setCam('follow', { user: true });
  else if (e.key === 'o' || e.key === 'O') setCam('orbit', { user: true });
  else if (e.key === 'p' || e.key === 'P') setCam('pov', { user: true });
  else if (LOOK[e.key] && S.cam === 'pov') {
    e.preventDefault();
    POV.tyaw = clamp(POV.tyaw + LOOK[e.key][0], -1.4, 1.4);
    POV.tpitch = clamp(POV.tpitch + LOOK[e.key][1], -0.7, 0.7);
    stage.invalidate();
  }
});
