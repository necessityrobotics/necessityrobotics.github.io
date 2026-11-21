// Necessity Robotics v4, lane ENGINE: the page script of the 3-D view (explore.html).
//   explore.html?map=<id>&at=<whole metres along the camera's path>      no map = the hero place; no at = its start
// The page is a picture first (static HTML). This script fills the names from data/places.json, mounts the place
// (js/place/mount.js) and wires the interface. RULES it keeps: nothing moves unless the visitor causes it (R1); no
// video-player part (R2); every hint and walk control is on screen only while the place is live (R3); loading is a
// small text chip (R4); a device that cannot run the place keeps the picture and gets one plain sentence (R5).
import { loadPlaces, fmtOf, fmtLen, exploreHref, getJSON, esc, isTouch } from '../v4/common.js';
import { routeDoor } from '../v4/route-door.js';
import { mountPlace, SWITCH } from './mount.js';
import { canTilt, startTilt, lookSwitch } from './tilt.js';

const $ = id => document.getElementById(id);
const html = document.documentElement, body = document.body;
const Q = new URLSearchParams(location.search);
const KEEP = ['force3d', 'shot', 'q', 'tier', 'assets'];          // test switches follow from place to place
const link = (id, at) => { const u = new URL(exploreHref(id, at)); for (const k of KEEP) if (Q.has(k)) u.searchParams.set(k, Q.get(k)); return u.href; };
const DEG = Math.PI / 180;
const TAP = '<span class="when-touch">tap</span><span class="when-fine">click</span>';

const P = await loadPlaces();
const place = P.byId[Q.get('map')] || P.heroPlace;
const atQ = Q.has('at') && Q.get('at') !== '' && Number.isFinite(+Q.get('at')) ? +Q.get('at') : null;
let view = null, door = null, lastPose = null, rode = false, keepOn = false;
const PHONE = window.matchMedia('(max-width: 759px)');             // the compact layout of css/explore.css

// ------------------------------------------------------------------ names, credit, the switcher (from data/places.json)
$('xp-name').textContent = place.name;
document.title = `${place.name} · a 3-D place you can walk through · Necessity Robotics`;
$('xp-count').textContent = `Place ${place.n} of ${place.of}`;
$('xp-pill').setAttribute('aria-label', `${place.name}. Place ${place.n} of ${place.of}. Change place.`);
const pic = $('xp-pill-pic');
pic.src = place.still; pic.hidden = false;
for (const [id, to, word] of [['xp-prev', place.prev, 'Previous'], ['xp-next', place.next, 'Next']]) {
  $(id).href = link(to);
  $(id).setAttribute('aria-label', `${word} place: ${P.byId[to].name}`);
  $(id).title = P.byId[to].name;
}
html.classList.toggle('xp-ros', !place.own);
html.classList.toggle('xp-other', place.id !== P.hero);
(place.own ? document.querySelector('.xp-credit-own') : document.querySelector('.xp-credit-ros')).textContent = place.credit_plain;
html.classList.add('xp-ready');
for (const a of document.querySelectorAll('#xp-places .v4-placerow-item')) {
  const id = a.dataset.place;
  a.href = link(id);
  if (id === place.id) { a.setAttribute('aria-current', 'true'); a.setAttribute('aria-label', `${place.name}. You are here.`); }
}
// the plain part of the sheet
$('xp-s-kind').innerHTML = `<b>${esc(place.name)}</b>${esc(place.kind)}`;
$('xp-s-limits').textContent = place.limits_plain;
$('xp-s-intro').textContent = P.limitsIntro;
$('xp-s-bw-h').hidden = $('xp-s-bw').hidden = place.colour !== false;
$('xp-s-credit').textContent = place.credit_plain;
if (atQ == null) $('xp-photo-img').src = place.photo;            // the start photo is a same-origin copy

// the bars' heights, for the panels that hang from them
const sizes = () => {
  html.style.setProperty('--xp-top-h', `${document.querySelector('.xp-top').offsetHeight}px`);
  html.style.setProperty('--xp-foot-h', `${document.querySelector('.xp-foot').offsetHeight}px`);
  const h = $('xp-hint');
  if (h.offsetHeight) body.style.setProperty('--xp-hint-b', `${h.offsetTop + h.offsetHeight + 8}px`);
  const mv = $('xp-move');
  if (mv.offsetHeight) body.style.setProperty('--xp-move-h', `${mv.offsetHeight}px`);     // phone: the photo sits above the ride button
};
// a panel over the place changed its size (the photo card opened, the tips folded): the circles are tested again
const redraw = new ResizeObserver(() => view?.redraw());
for (const id of ['xp-hint', 'xp-help', 'xp-you', 'xp-photo', 'xp-move', 'xp-backpath', 'xp-said']) redraw.observe($(id));
new ResizeObserver(sizes).observe(document.querySelector('.xp-top'));
new ResizeObserver(sizes).observe(document.querySelector('.xp-foot'));
window.addEventListener('resize', sizes);
sizes();

// ------------------------------------------------------------------ one plain line (also read by screen readers)
const saidEl = $('xp-said');
function said(htmlText, ms = 7000) {
  saidEl.innerHTML = htmlText;
  saidEl.classList.add('is-on');
  clearTimeout(said.t);
  // CPU tests (?force3d=1) draw one frame in seconds: the line stays long enough to be in the screenshot
  said.t = setTimeout(() => saidEl.classList.remove('is-on'), SWITCH.force3d ? ms * 12 : ms);
}

// ------------------------------------------------------------------ the hint (non-blocking; only while live)
const done = { look: false, step: false };
function setHint(open) {
  $('xp-hint').hidden = !open;
  $('xp-help').hidden = open;
  body.dataset.hint = open ? 'open' : 'closed';
  sizes();
}
function hintDone(what) {
  if (done[what]) return;
  done[what] = true;
  $(what === 'look' ? 'xp-h-look' : 'xp-h-step').classList.add('is-done');
  if (done.look && done.step) {
    try { sessionStorage.setItem('xp-hint', 'done'); } catch (e) { /* private mode */ }
    setTimeout(() => setHint(false), 2600);           // the tips have done their work: they fold into "How to move"
  }
}
// phone: the tips are two short lines; after the first swipe they fold into "How to move" at once (the place is small)
const hintFold = () => { if ((PHONE.matches || isTouch()) && body.dataset.hint === 'open') setHint(false); };   // (touch: the place keeps the screen)
$('xp-hint-x').addEventListener('click', () => { setHint(false); $('xp-help').focus(); });
$('xp-help').addEventListener('click', () => { setHint(true); $('xp-hint-x').focus(); });

// ------------------------------------------------------------------ the place
function onEvent(type, d) {
  if (type === 'state') return onState(d);
  if (type === 'pose') return onPose(d);
  if (type === 'photo') {
    const im = $('xp-photo-img');
    // the start photo is already on screen as a same-origin copy: keep it
    const same = d.kf === place.start_kf && im.getAttribute('src') === place.photo;
    if (!same && im.getAttribute('src') !== d.src) im.src = d.src;
    // R11: "from here" only when the visitor stands at that photo's own camera position; else "nearest photo"
    $('xp-photo-h').textContent = d.exact ? 'The camera’s photo from here.' : 'The camera’s nearest photo.';
    $('xp-photo-s').textContent = d.exact ? 'Photo from here' : 'Nearest photo';
    im.alt = d.exact ? 'The real camera photo taken at this spot' : 'The real camera photo taken nearest to this spot';
    photoExact = d.exact;
    photoLabel();
    photoT = d.t;
    return;
  }
  if (type === 'first-look') { hintDone('look'); hintFold(); said('You just looked around. A video cannot do that.'); return; }
  if (type === 'first-step') {
    if (body.hasAttribute('data-riding') || !(d.moved >= 0.01)) return;
    hintDone('step');
    if (d.moved >= 0.5) said(`You walked ${fmtLen(d.moved)} of a ${fmtLen(d.total)} path. Keep going, or ${TAP} the map to jump.`, 8000);
    return;
  }
  if (type === 'ride') {
    body.toggleAttribute('data-riding', d.on);
    if (d.on) { rode = true; atEnd = false; body.setAttribute('data-rode', ''); setHint(false); }
    else if (view && view.total && view.at >= view.total - 0.6) atEnd = true;
    rideLabel(d.on);
    said(d.on ? 'Riding along the camera’s path. Press the button again to stop.' : atEnd ? 'The ride stopped at the end of the path.' : 'The ride stopped. You are in control.', 3500);
    sizes();
    return;
  }
  if (type === 'above') {
    body.toggleAttribute('data-above', d.on);
    $('xp-aboveui').hidden = !d.on;
    if (d.on) { saidEl.classList.remove('is-on'); photoOpen(false); }
    return;
  }
  if (type === 'offpath') { $('xp-backpath').hidden = !d.show; return; }
  if (type === 'end') { said(`This is the end of the camera’s path. Turn around, or ${TAP} the map to jump.`, 6000); return; }
  if (type === 'tier' || type === 'progress') engRefresh();
}
function onState(d) {
  body.dataset.state = d.state;
  if (typeof tiltOnState === 'function') tiltOnState(d);   // (look with your phone: only while the place is live)
  $('xp-status').hidden = d.state !== 'loading';
  const cannot = (d.state === 'still' || d.state === 'failed') && !!d.text;
  $('xp-cannot').hidden = !cannot;
  if (cannot) {
    $('xp-cannot-t').innerHTML = esc(d.text).replace(/3-D/g, '<span class="nb">3-D</span>');
    const b = $('xp-again');
    b.hidden = !d.again; b.textContent = d.again || 'Open it again';
  }
  if (d.state === 'live') {
    if (isTouch()) setTimeout(hintFold, 8000);                 // touch: the words fold away by themselves
    let seen = false;
    try { seen = sessionStorage.getItem('xp-hint') === 'done'; } catch (e) { /* private mode */ }
    setHint(!seen);
    $('xp-photo-img').addEventListener('load', sizes);
    if (lastPose) onPose(lastPose);
    engRefresh();
  } else body.dataset.hint = 'closed';
}
let urlT = 0, urlAt = null;
function onPose(d) {
  lastPose = d;
  if (door) {
    if (d.x != null && Math.abs(d.off) > 0.3) door.setXY(d.x, d.y, d.at); else door.setAt(d.at);
    if (d.heading != null) door.setHeading(d.heading); else door.setLook(d.look);
  }
  const prog = fmtOf(d.at, d.total);
  if ($('xp-prog').textContent !== prog) $('xp-prog').textContent = prog;
  // the address follows the visitor (whole metres), so a reload or a shared link opens the same spot
  urlAt = d.at;
  if (!urlT) urlT = setTimeout(() => {
    urlT = 0;
    const u = new URL(location.href);
    u.searchParams.set('map', place.id); u.searchParams.set('at', String(Math.round(urlAt)));
    try { history.replaceState(null, '', u); } catch (e) { /* file: or a sandbox */ }
  }, 600);
  if ($('xp-eng').open && !$('xp-sheet').hidden) telemetry();
}
let photoT = place.start_t, photoExact = true;

// the camera's photo: the print is a button. Phone: the small picture opens the card. Desktop: the photo gets larger.
function photoLabel() {
  const open = $('xp-photo').classList.contains('is-open');
  $('xp-photo-btn').setAttribute('aria-label', `${photoExact ? 'The camera’s photo from here' : 'The camera’s nearest photo'}. ${open ? 'Make it smaller' : 'Make it larger'}.`);
}
function photoOpen(on) {
  const f = $('xp-photo');
  if (f.classList.contains('is-open') === on) return;
  f.classList.toggle('is-open', on);
  $('xp-photo-btn').setAttribute('aria-expanded', String(on));
  photoLabel();
}
$('xp-photo-btn').addEventListener('click', () => photoOpen(!$('xp-photo').classList.contains('is-open')));
photoLabel();

// the "You are here" map: the shared route door in mode 'jump' (a tap on the line = go there)
door = routeDoor($('xp-map'), {
  id: place.id, mode: 'jump', pad: PHONE.matches ? { t: 13, r: 18, b: 13, l: 18 } : { t: 16, r: 22, b: 16, l: 22 },
  label: isTouch() ? "Map of the camera's path, seen from above. Tap the path to jump there."
    : "Map of the camera's path, seen from above. Left and Right choose a point of the path. Enter jumps there.",
  onJump: (m) => { view?.goTo({ at: m }); },
});
door.ready.then(() => { if (lastPose) onPose(lastPose); });

// ------------------------------------------------------------------ panels: change place, about this place
const panels = { places: { el: $('xp-places'), btn: $('xp-pill'), head: $('xp-places-h') }, sheet: { el: $('xp-sheet'), btn: $('xp-about'), head: $('xp-sheet-h') } };
let opener = null;
function openPanel(name, from, focusId) {
  for (const [k, p] of Object.entries(panels)) {
    const on = k === name;
    if (!on && !p.el.hidden) { p.el.hidden = true; p.btn.setAttribute('aria-expanded', 'false'); }
    if (on) { p.el.hidden = false; p.btn.setAttribute('aria-expanded', 'true'); }
  }
  opener = from || null;
  view?.keys(!name);                                   // the arrow keys belong to the open panel
  // touch: the places sheet covers the screen; the 3-D place rests and hides under it, and its pictures load now
  const places = name === 'places' && isTouch();
  body.toggleAttribute('data-places-open', places);
  view?.engine?.setOffscreen?.(places);
  if (name === 'places') for (const im of panels.places.el.querySelectorAll('img[loading="lazy"]')) im.loading = 'eager';
  if (name) {
    const target = (focusId && $(focusId)) || panels[name].head;
    if (focusId) { target.tabIndex = -1; target.scrollIntoView({ block: 'start' }); }
    target.focus({ preventScroll: !focusId });
  }
}
function closePanels() {
  const o = opener;
  openPanel(null);
  if (o && o.isConnected) o.focus({ preventScroll: true });
}
$('xp-pill').addEventListener('click', e => (panels.places.el.hidden ? openPanel('places', e.currentTarget) : closePanels()));
$('xp-places-x').addEventListener('click', closePanels);
$('xp-about').addEventListener('click', e => (panels.sheet.el.hidden ? openPanel('sheet', e.currentTarget) : closePanels()));
$('xp-about2').addEventListener('click', e => openPanel('sheet', e.currentTarget));
$('xp-limits-btn').addEventListener('click', e => openPanel('sheet', e.currentTarget, 'xp-limits'));
$('xp-sheet-x').addEventListener('click', closePanels);
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!panels.places.el.hidden || !panels.sheet.el.hidden) { closePanels(); return; }
  if ($('xp-photo').classList.contains('is-open')) { photoOpen(false); return; }
  if (body.hasAttribute('data-riding')) { view?.ride(false); return; }
  if (body.hasAttribute('data-above')) view?.above(false);
});
document.addEventListener('pointerdown', e => {         // a tap outside an open panel closes it
  const open = Object.values(panels).find(p => !p.el.hidden);
  if (open && !open.el.contains(e.target) && !e.target.closest('.xp-top, .xp-foot, .v4-tip')) closePanels();
  if (PHONE.matches && !e.target.closest('#xp-photo')) photoOpen(false);          // phone: a touch elsewhere folds the photo card
}, { passive: true });

view = await mountPlace($('pl'), { id: place.id, mode: 'full', at: atQ, onEvent });

// ------------------------------------------------------------------ look with your phone (tilt.js; touch + HTTPS only)
// Owner 11-21: the phone look is the default; the Phone / Touch switch in the bar turns it off (the choice is kept on every
// page). Dragging works in both modes.
const lookEl = $('xp-tilt');
let tilt = null;
var tiltOnState;                                            // (var: onState may run before this line)
const look = lookEl && canTilt() ? lookSwitch(lookEl, {
  start: () => {
    // a window into the place: the phone's turn = the view's turn
    tilt = startTilt(d => view?.engine?.setDeviceLook?.(d));   // the pitch from how the phone is held now: a level first view
    if (view?.engine) view.engine.onRecentre = () => tilt?.recentre();      // double-tap: ahead is where the phone points
    said('Turn your phone to look around. Dragging still works. Tap the hand button to turn this off.', 6500);
  },
  stop: () => { tilt?.stop(); tilt = null; },
  say: t => said(t, 5000),
}) : null;
const tiltOff = () => look?.stop();
if (look) {
  // only while the place is live (as the dock); a place that fails stops the phone look
  tiltOnState = d => { if (d.state === 'live') look.live(true); else { lookEl.hidden = true; if (d.state === 'failed') look.live(false); } };
  if (view?.engine?.live) look.live(true);
  addEventListener('pagehide', () => look.stop());
  addEventListener('pageshow', e => { if (e.persisted && view?.engine?.live) look.live(true); });   // Back / Forward: the look comes back
}

// ------------------------------------------------------------------ see it on your table (WebXR AR, js/xr/table.js; Android ARCore)
const arBtn = $('xp-ar');
// phones and tablets only (a headset browser has no screen overlay for the words and Close); three loads only where AR can run
if (arBtn && window.isSecureContext && navigator.xr && matchMedia('(pointer: coarse)').matches) {
  navigator.xr.isSessionSupported('immersive-ar').then(ok => (ok ? import('../xr/table.js') : null)).then(async m => {
    if (!m) return;
    const { openTable } = m;
    arBtn.hidden = false;
    arBtn.addEventListener('click', () => {
      if (window.__xrBusy) return;                         // one AR session at a time
      window.__xrBusy = true;
      tiltOff();
      view?.engine?.setOffscreen?.(true);                    // the place rests while AR runs
      openTable({ id: place.id, name: place.name, len: place.length || '', onEnd: () => { window.__xrBusy = false; view?.engine?.setOffscreen?.(false); view?.engine?.stage?.invalidate?.(); if (view?.engine?.live) look?.live(true); } });
    });
  }).catch(e => console.warn('[xr]', e));
}

// ------------------------------------------------------------------ walk, turn, ride
for (const b of document.querySelectorAll('.xp-key')) {
  b.addEventListener('click', () => {
    const a = b.dataset.act;
    if (body.hasAttribute('data-riding')) view.ride(false);
    if (a === 'fwd') view.walk(1); else if (a === 'back') view.walk(-1);
    else view.lookBy((a === 'left' ? 15 : -15) * DEG, 0);
  });
}
// The ride: ONE button. A tap starts it, a tap stops it. No holding. Space does the same.
// While it rides, a drag still looks around. At the end of the path the button offers the start again.
const rideB = $('xp-ride');
let atEnd = false;
const LOOKW = '<span class="when-touch">Swipe</span><span class="when-fine">Drag</span>';
const TAPW = '<span class="when-touch">Tap</span><span class="when-fine">Click</span>';
function rideLabel(on) {
  rideB.setAttribute('aria-pressed', String(on));
  $('xp-ride-b').textContent = on ? 'Stop here' : atEnd ? 'Ride again from the start' : 'Ride along the path';
  $('xp-ride-i').innerHTML = on ? `Riding. ${LOOKW} to look around.` : atEnd ? 'You reached the end of the path.' : `${TAPW} to start. ${TAPW} again to stop.`;
}
// the ride always goes forward along the camera's path: a visitor who looks back is turned to face ahead first
function faceAhead() {
  // degrees between the view and the path's direction, the phone's own turn included
  const E = view.engine, l = E ? Math.atan2(Math.sin(E.viewYaw - E.track.tanAt(E.S.at)), Math.cos(E.viewYaw - E.track.tanAt(E.S.at))) / DEG : 0;
  if (Math.abs(l) > 80) view.engine.lookBy(-l * DEG, 0, { first: false });
  view.engine.S.facing = 1;
}
function rideToggle() {
  if (!view || !view.live) return;
  if (body.hasAttribute('data-riding')) { view.ride(false); return; }
  if (body.hasAttribute('data-above')) view.above(false);
  faceAhead();
  if (atEnd || view.at >= view.total - 0.6) {            // at the end: one jump to the start (no long glide), then the ride
    atEnd = false;
    view.goTo({ at: 0 }, { instant: true });
    setTimeout(() => { faceAhead(); view.ride(true); }, 350);
    return;
  }
  if (!view.ride(true)) { atEnd = true; rideLabel(false); }
}
rideB.addEventListener('click', rideToggle);
document.addEventListener('keydown', (e) => {
  if (e.key !== ' ' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && t.closest && t.closest('button, a, input, select, textarea, summary, [contenteditable]')) return;   // a focused control keeps its own Space
  if (!panels.places.el.hidden || !panels.sheet.el.hidden) return;
  e.preventDefault(); rideToggle();
});
// three speeds; the engine multiplies its recorded speed by this
for (const sb of document.querySelectorAll('#xp-speed button')) {
  sb.addEventListener('click', () => {
    if (view && view.engine) view.engine.rideK = Number(sb.dataset.k) || 1;
    document.querySelectorAll('#xp-speed button').forEach((o) => o.setAttribute('aria-pressed', String(o === sb)));
  });
}
// a visitor who does nothing for a while sees the ride button glow once: an offer, never a start
{
  let idle = setTimeout(() => rideB.classList.add('is-offer'), 7000);     // one glow
  const used = () => { clearTimeout(idle); rideB.classList.remove('is-offer'); };
  for (const ty of ['pointerdown', 'keydown', 'wheel']) addEventListener(ty, used, { passive: true, once: true });
}
$('xp-above').addEventListener('click', () => { view.above(true); $('xp-ground').focus({ preventScroll: true }); });
$('xp-ground').addEventListener('click', () => { view.above(false); $('xp-above').focus({ preventScroll: true }); });
$('xp-backpath').addEventListener('click', () => view.toPath());
$('xp-again').addEventListener('click', () => view.again());

// ------------------------------------------------------------------ For engineers (closed by default; nothing of the old viewer panel is lost)
const fmtInt = x => (x == null ? '—' : String(Math.round(x)).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
const fmtMB = b => { if (!Number.isFinite(b)) return '—'; const mb = b / 1e6; return mb >= 100 ? `${mb.toFixed(0)} MB` : mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`; };
const STXT = st => { let m = st.match(/^div (\d+)\/(\d+)$/); if (m) return `diverged in ${m[1]} of ${m[2]} runs`;
  m = st.match(/^lost (\d+)\/(\d+)$/); if (m) return `lost tracking in ${m[1]} of ${m[2]} runs`; return st === 'partial span' ? 'covers only part of the route' : st; };
const SETS = { design: 'design route, used during development', k12: 'seen once by an earlier kill test', k13: 'seen once by an earlier kill test', k14: 'seen once by the last kill test', unseen: 'unseen route', sealed: 'unseen route' };
const VTXT = { win: 'xclean better', tie: 'tie', loss: 'ORB-SLAM3 better', win_forfeit: 'xclean, by forfeit', loss_forfeit: 'ORB-SLAM3, by forfeit', both_lost: 'both lost' };
const CC_BY = 'https://creativecommons.org/licenses/by/4.0/';
const FILES = { lite: 'splats_lite.spz', standard: 'splats.spz', full: 'full/splats.ply' };
let engBuilt = false;
async function buildEng() {
  if (engBuilt) return;
  engBuilt = true;
  const m = place.map, s = m.stats, box = $('xp-eng-body');
  const board = await getJSON('data/board.json').catch(() => null);
  const r = board?.rows.find(x => x.route === m.board_route);
  const f3 = x => (x < 10 ? x.toFixed(3) : x.toFixed(2));
  const q = t => `<button type="button" data-v="${t}" aria-pressed="false" ${m.files[FILES[t]] ? `title="${fmtMB(m.files[FILES[t]])}"` : 'disabled title="not published for this map"'}>${t[0].toUpperCase()}${t.slice(1)}</button>`;
  box.innerHTML = `
    <h4>Catalogue · ${esc(m.id)}</h4>
    <p class="xp-eng-title">${esc(m.title)}</p>
    <p>${esc(m.platform)} · ${esc(m.place)}</p>
    <a class="lic" href="credits.html#maps">${esc(m.map_licence)}${m.own_data ? ' · own data' : ' · Rosario Dataset'}</a>
    <dl class="kv">
      <dt>Duration</dt><dd>${s.duration_s.toFixed(1)} s</dd>
      <dt>Path</dt><dd>${fmtLen(s.path_m)}</dd>
      <dt>Keyframes</dt><dd>${fmtInt(s.keyframes)}</dd>
      <dt>Gaussians</dt><dd>${(s.gaussians / 1e6).toFixed(2)} M</dd>
      <dt>Points</dt><dd>${fmtInt(s.points)}</dd>
      ${r?.gt && r.ours ? `<dt>Board ATE</dt><dd>${f3(r.ours.med)} m (ORB-SLAM3 ${f3(r.orb3.med)} m${r.orb3.status ? `; ORB-SLAM3 ${esc(STXT(r.orb3.status))}` : ''}${r.orb3.stereo_only && r.orb3.stereo_only === r.orb3.draws ? '; ORB-SLAM3 ran stereo-only here: its IMU start-up crashed' : ''}): ${esc(VTXT[r.vs_orb3] || r.vs_orb3)}${SETS[r.group] ? ` (${esc(SETS[r.group])})` : ''} · <a href="results.html#r-${esc(r.route)}">row</a> · <a href="results.html#disclosures">K14 caveat</a></dd>` : ''}
      ${r && !r.gt ? `<dt>Latency</dt><dd>${r.lat_ms_p50.toFixed(1)} ms median · <a href="results.html#r-${esc(r.route)}">row</a></dd>` : ''}
      <dt>Poses</dt><dd>xclean's live output in a real-time (paced) replay. Routes with ground truth: the median run of the three final-board runs (by ATE). Our OAK routes: the run whose end point is closest to the other two</dd>
    </dl>
    <h4>Known limits</h4>
    <p>${esc(m.limitation)}</p>
    ${m.engine_note ? `<p class="xp-eng-note">${esc(m.engine_note)}</p>` : ''}
    <h4>Credit and licence</h4>
    <p>${esc(m.credit)}</p>
    <p>${m.own_data ? '3-D map by Necessity Robotics (xclean)' : 'Source images: The Rosario Dataset, CIFASIS-CONICET, CC BY 4.0'} · map <a href="${CC_BY}">CC BY 4.0</a> · <a href="credits.html#maps">credits</a></p>
    <p>A 3-D reconstruction from xclean's camera poses, not camera video.</p>
    <h4>Telemetry</h4>
    <dl class="kv">
      <dt>Distance</dt><dd class="num" id="xp-t-d">—</dd>
      <dt>Run time</dt><dd class="num" id="xp-t-t">—</dd>
      <dt>Keyframe</dt><dd class="num" id="xp-t-kf">—</dd>
      <dt>Drawing</dt><dd class="num" id="xp-t-draw">—</dd>
      <dt>View</dt><dd class="num" id="xp-t-view">—</dd>
    </dl>
    <div class="xp-eng-feed"><img id="xp-t-img" alt="" width="320" height="200" loading="lazy"><p><b>Camera</b> <span id="xp-t-feed">the real keyframe image nearest this spot</span></p></div>
    <h4>Layer</h4>
    <div class="seg" id="xp-layer" role="group" aria-label="Layer"><button type="button" data-v="splats" aria-pressed="true">Splats</button><button type="button" data-v="points" aria-pressed="false">Points</button><button type="button" data-v="both" aria-pressed="false">Both</button></div>
    <h4>Splat quality</h4>
    <div class="seg" id="xp-q" role="group" aria-label="Splat quality">${q('lite')}${q('standard')}${q('full')}</div>
    <p class="xp-eng-ask" id="xp-q-ask" hidden></p>
    <label class="tog"><input type="checkbox" id="xp-path" checked> xclean path (the bright line and the ground lights)</label>
    <h4>Loading</h4>
    <ul class="xp-ld" id="xp-ld"></ul>
    <p><a href="results.html">Every route and every result</a> · <a href="xclean.html">xclean</a> · <a href="paper.html">Paper</a> · <a href="credits.html">Data credits</a></p>`;
  for (const b of box.querySelectorAll('#xp-layer button')) {
    b.addEventListener('click', () => {
      view.setLayer(b.dataset.v);
      box.querySelectorAll('#xp-layer button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    });
  }
  const ask = $('xp-q-ask');
  const setQ = async t => { ask.hidden = true; try { await view.setQuality(t); } catch (e) { ask.hidden = false; ask.textContent = `The ${t} splats could not be loaded.`; } engRefresh(); };
  for (const b of box.querySelectorAll('#xp-q button')) {
    b.addEventListener('click', () => {
      const t = b.dataset.v;
      if (t !== 'full') { setQ(t); return; }
      const bytes = m.files['full/splats.ply'];
      ask.hidden = false;
      ask.innerHTML = `Full resolution is one ${fmtMB(bytes)} file, ${(s.gaussians / 1e6).toFixed(1)} M Gaussians. Standard already holds every Gaussian, compressed.<br><button type="button" id="xp-q-yes">Load ${fmtMB(bytes)}</button><button type="button" id="xp-q-no">Cancel</button>`;
      $('xp-q-yes').onclick = () => setQ('full');
      $('xp-q-no').onclick = () => { ask.hidden = true; };
    });
  }
  $('xp-path').addEventListener('change', e => view.showPath(e.target.checked));
  engRefresh();
  telemetry();
}
function engRefresh() {
  if (!engBuilt || !view) return;
  const i = view.info();
  const ld = $('xp-ld');
  if (!i) { if (ld) ld.innerHTML = '<li>The 3-D place is not running on this device.</li>'; return; }
  document.querySelectorAll('#xp-q button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === i.tier)));
  const name = { 'traj.json': 'Trajectory', 'keyframes.json': 'Keyframes', cut: 'Ride cut splats', lite: 'Lite splats', standard: 'Standard splats', full: 'Full splats', points: 'Point cloud' };
  if (ld) ld.innerHTML = Object.entries(i.loads).map(([k, v]) => `<li><b>${esc(name[k] || k)}</b> ${fmtMB(v.loaded)}${v.total && v.total !== v.loaded ? ` / ${fmtMB(v.total)}` : ''}${v.splats ? ` · ${(v.splats / 1e6).toFixed(2)} M splats` : ''}</li>`).join('');
}
function telemetry() {
  if (!engBuilt || !view) return;
  const i = view.info();
  if (!i || !lastPose) return;
  $('xp-t-d').textContent = `${fmtLen(lastPose.at)} of ${fmtLen(lastPose.total)}`;
  $('xp-t-t').textContent = `${i.t.toFixed(1)} s`;
  $('xp-t-kf').textContent = `${fmtInt(i.kf)} of ${fmtInt(i.kfs)}`;
  $('xp-t-draw').textContent = i.points && !i.splats ? `${fmtInt(i.points)} points` : `${fmtInt(i.splats)} splats (${i.tier})`;
  $('xp-t-view').textContent = `look ${lastPose.look.toFixed(0)}° from the path, pitch ${lastPose.pitch.toFixed(0)}°, ${Math.abs(lastPose.off).toFixed(1)} m off the path, render scale ${i.scale.toFixed(2)}`;
  const im = $('xp-t-img'), src = $('xp-photo-img').getAttribute('src');
  if (src && im.getAttribute('src') !== src) im.src = src;
  $('xp-t-feed').textContent = `real keyframe image at ${Number(photoT).toFixed(1)} s`;
}
$('xp-eng').addEventListener('toggle', () => { if ($('xp-eng').open) buildEng().then(() => { engRefresh(); telemetry(); }); });
