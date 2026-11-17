// V12 home (owner 2026-11-13: "we land on landing page, we see park in background, we scroll down and move with the park
// for few seconds then animation takes to all floating trajectories to choose from, when further scrolled down let's
// choose maps (from thumbnail); this entire section is 1 about the 3d map, trajectories"). One sticky stage, six stops;
// the scroll is the only clock, except the first screen's ride.
//   0  first screen (V11): the park plays in the background (a walk round the path, which this page closes into a loop);
//      the pointer moves the camera sideways a little (parallax)
//   1  the scroll moves the visitor along the path with the park (30 m from where the ride was)
//   2  THE LIVE SITE'S PULL-BACK (website_nr3 director.js 'rise' + world.js splat rule): up and back on a cubic Bezier;
//      the gaze drops onto the ground ahead early, then pans to the place's middle. As the camera climbs, the splats
//      fade out and the 3-D points fade in (engine o.pointsAbove); the path draws outward from the visitor's spot.
//   3  the whole park from above: points and one line in the dark
//   4  the view goes on out to all eight places: the floating trajectories (atlas.js, the AI-depth points of each map)
//   5  pick one: each name or island opens a choice (walk into the 3-D place / its depth, classic vs AI)
// The page sets the camera (setDirect, w = 1). A short spring follows the scroll and stops; the pointer adds parallax.
// Reduced motion: no ride, the stage cuts from stop to stop. Test shots (?snap=1) and ?ride=0: no ride. Phones: pictures.
import { mountPlace, SWITCH } from './place/mount.js';
import { mountDark } from './dark.js';
import { canTilt, askTilt, startTilt, IOS as TILT_ASKS } from '/js/place/tilt.js';
import { current as accent, picker } from './accent.js';

performance.mark('f-mod');                                // timing marks (a test reads them; they cost nothing)
const $ = (s, r = document) => r.querySelector(s);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const sm = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const ss = t => { t = clamp(t, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); };      // smootherstep (as director.js)
const ramp = (x, a, b) => clamp((x - a) / (b - a), 0, 1);
const easeOutCubic = t => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
const DEG = Math.PI / 180;
const Q = new URLSearchParams(location.search);
const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;
const PHONE = matchMedia('(max-width: 760px)').matches;
// owner 11-14 (a real Android tablet): phones and tablets get the live place and touch. TOUCH = no mouse: the dark follows
// a finger, a sideways drag turns the view, frames are held to 30 fps and the drawing is lighter. Phones show the live
// place too when the phone has room for it (Save-Data off; 4 GB or more where the browser says; ?phone3d=0 = pictures).
const TOUCH = matchMedia('(hover: none), (pointer: coarse)').matches;
const MEM = navigator.deviceMemory, NET = navigator.connection, SAVE = NET?.saveData === true;
const SMALL = TOUCH && Math.min(screen.width, screen.height) < 600;      // a phone, also when held sideways
const SLOW = /(^|-)2g$|^3g$/.test(NET?.effectiveType || '');             // a slow link: about 15 MB is too much
// the still (classic) mode: decided in the page head (make_site_v12.py STILL_JS); no 3-D, no dark, no motion
const STILL = document.documentElement.classList.contains('nr-still');
let gone = false;                                         // goStill() ran: the page is in its still mode now
// owner 11-16 (later): "bring back previous version of site deployed for phone and tablet": no automatic still mode.
// Phones and tablets run the live place as on the live site (11-14); the still mode is a prototype behind ?still=1 only.
const AUTO_STILL = false;
if (STILL) document.documentElement.classList.remove('f-drift');
const LIVE_HOME = !STILL && (!(PHONE || SMALL) || (!SAVE && !SLOW && (MEM == null || MEM >= 4) && Q.get('phone3d') !== '0'));
const SNAP = Q.get('snap') === '1' || REDUCE;            // tests: no spring (one exact frame per scroll position)
const STOPS = 5;
const PLACE = 'oak_161206';
const RIDE = !REDUCE && !SNAP && Q.get('ride') !== '0';
const RIDE_MS = 1.4;                                      // metres per second (the first screen's ride)
const LOOK_M = 24;                                        // the eye looks this far ahead; the picture's push-in aims there (f.css)
// owner 11-13: "landing page should immediately show the moving map": until the live place is ready, its picture (a frame
// of this very view, img/first.jpg) pushes in like the walk; the live ride then starts as far along the path as the picture
// went. The page head adds f-drift too (before this module and three.js arrive); this line is for pages without that head.
if (RIDE && !PHONE && !STILL) document.documentElement.classList.add('f-drift');
if (!PHONE) document.documentElement.classList.add('f-desk');
const RIDE_TAU = 0.9;                                     // s: the live walk eases from the picture's speed to RIDE_MS
const FADE_MS = 650;                                      // the picture and the live place cross this long (f.css 0.6 s)
const SEAM_M = 25;                                        // the loop: the path's last metres bend onto its start
const MOVE_M = 30;                                        // stop 1: the scroll moves the visitor this far along the path
const FOLLOW_M = 70;                                      // stops 1-3: the camera goes on along the path this far as it rises
const RIDE_B = 0.04;                                      // the walk runs below this beat; above it the scroll moves the visitor
const ATLAS_B = 0.25;                                     // the eight places load once the visitor scrolls past this beat
const RISE0 = 1.05, RISE1 = 2.6;                          // the pull-back runs between these beats
const OUT0 = 3.25, OUT1 = 4.15;                           // the view goes out to all eight places between these beats
const END_SX = PHONE ? 0 : -0.22;                         // the whole park sits right of the caption cards (a phone: centred)
const SX0 = PHONE ? 0 : -0.24;                            // the walk's view centre: 62 % of the width (a phone: the middle)
const HERE = (p) => new URL(p, import.meta.url).href;      // this folder (the page may live elsewhere: the V12 mix)
const ACC = accent();
const OPEN = (typeof window !== 'undefined' && window.__fOpen) || HERE('open.html');   // the site build: explore.html

const stage = $('#stage'), hero = $('#hero'), box = $('#place');
const first = $('#first'), veil = $('#veil'), hint = $('#hint'), hintT = $('#hint-t'), stateEl = $('#state');
const still = $('#still'), stillP = $('#still-p'), atlasEl = $('#atlas-in'), darkEl = $('#dark');
// the first screen: out of the dark (site v4.1, owner 11-13): the place shows where the visitor points; the scroll lights it
const dark = LIVE_HOME && darkEl ? mountDark(darkEl, stage, PHONE ? { at: [0.5, 0.56], lobes: [[0, .02, .6, .14], [-.32, .08, .36, .12], [.3, .04, .36, .13], [0, .12, .58, .1]], light: true, intro: TOUCH }
  : { at: [0.62, 0.36], light: TOUCH, intro: TOUCH }) : null;
const caps = [...document.querySelectorAll('.h-cap')], rail = [...document.querySelectorAll('.h-rail li')];
// phones: pictures of the same views, cut at each stop
const PICS = ['/img/places/oak_161206_p.jpg', '/img/places/oak_161206_p.jpg', HERE('img/a_p2.jpg'), HERE('img/a_p3.jpg'), HERE('img/atlas_p.jpg'), HERE('img/atlas_p.jpg')];
// a desktop without the live place: the first screen is a frame of this very view (img/first.jpg)
const PICS_L = [HERE('img/first.jpg'), HERE('img/first.jpg'), HERE('img/a_l2.jpg'), HERE('img/a_l3.jpg'), HERE('img/a_l3.jpg'), HERE('img/a_l3.jpg')];

// links keep the test switches; the 3-D view opens where the visitor is on the path
const keep = new URLSearchParams();
for (const k of ['force3d', 'shot', 'q', 'tier', 'assets']) if (Q.has(k)) keep.set(k, Q.get(k));
let hereAt = 117;
const openHref = (at, id = PLACE) => { const u = new URL(OPEN, location.href); u.searchParams.set('map', id); if (at != null) u.searchParams.set('at', String(Math.round(at))); for (const [k, v] of keep) u.searchParams.set(k, v); return u.href; };
/** Every door of the stage (a[data-open]) opens the 3-D view: data-open="<id>" another place, "" this park where you are. */
function setLinks() {
  document.querySelectorAll('a[data-open]').forEach(a => { const id = a.dataset.open; a.href = id ? openHref(null, id) : openHref(hereAt); });
}
setLinks();

// ------------------------------------------------------------------ the classic hero: phones and tablets (html.nr-still)
// Plate I (Fig. 1 at eye level, Fig. 2 bird's-eye, Fig. 3 plan to scale) and the sheet of the eight places
// (tools/make_still_hero.py writes #ps; v12.css lays it out). The scroll is the only clock: stillUi(x) sets opacities and
// the ink of the camera paths (--ink, stroke-dashoffset); nothing runs between scrolls, nothing is drawn by script.
const PS = STILL ? document.getElementById('ps') : null;
const psWin = PS?.querySelector('.ps-win'), psFrame = PS?.querySelector('.ps-frame'), psNav = PS?.querySelector('.ps-sheet');
const psFig = PS ? [1, 2, 3].map(n => PS.querySelector(`.ps-fig[data-f="${n}"]`)) : [];
const psR = PS ? [1, 2, 3, 4, 5, 6, 7, 8].map(i => [...PS.querySelectorAll(`.ps-r[data-i="${i}"]`)]) : [];
const psLast = new Map();
/** Write a style only when it changed (at most a few dozen writes per scroll frame). */
function psPut(el, key, v, kind) {
  if (!el) return;
  v = Math.round(v * 1000) / 1000;
  if (psLast.get(key) === v) return;
  psLast.set(key, v);
  if (kind === 'o') { el.style.opacity = String(v); el.style.visibility = v < 0.005 ? 'hidden' : 'visible'; }
  else el.style.setProperty(kind, String(v));
}
function stillUi(x) {
  if (!PS) return;
  psPut(box, 'place', 1 - sm(0.55, 0.95, x), 'o');                                     // the full-bleed walk picture
  psPut(psWin, 'win', sm(0.55, 0.95, x) * (1 - sm(3.25, 3.5, x)), 'o');              // the plate window
  psPut(psFig[0], 'f1', 1 - sm(1.35, 1.75, x), 'o');
  psPut(psFig[1], 'f2', sm(1.35, 1.75, x) * (1 - sm(2.35, 2.75, x)), 'o');
  psPut(psFig[1], 'i2', ramp(x, 1.55, 1.95), '--ink');                                // Fig. 2: the path inks in
  psPut(psFig[1], 'm2', sm(1.85, 1.98, x), '--mk');                                   // then "You stood here"
  psPut(psFig[2], 'f3', sm(2.35, 2.75, x), 'o');                                     // Fig. 3: drawn already
  const so = sm(3.25, 3.5, x);
  psPut(psFrame, 'sheet', so, 'o');
  const on = so > 0.5;
  if (PS.dataset.sheet !== (on ? '1' : '0')) { PS.dataset.sheet = on ? '1' : '0'; psNav.inert = !on; if (!on) psClose(); }
  // the second animation: plate I arrives inked (the park just seen); II-VIII ink in, in reading order
  psR.forEach((gs, k) => {
    const v = k === 0 ? 1 : ramp(x, 3.5 + 0.06 * (k - 1), 3.64 + 0.06 * (k - 1));
    gs.forEach((g, j) => psPut(g, `r${k}${j}`, v, '--ink'));
  });
  if (psPick && !psPick.hidden && Math.abs(x - psPickAt) > 0.15) psClose();
}
// sizes: the tallest foot caption (stops 1-3) and the cartouche (stops 4-5) set the plate window and the sheet
function psMeasure() {
  if (!PS) return;
  const capH = Math.max(...caps.filter(c => +c.dataset.cap <= 3).map(c => c.offsetHeight));
  const top = caps.filter(c => +c.dataset.cap >= 4);
  const cartH = Math.max(...top.map(c => c.offsetTop + c.offsetHeight)) - (psFrame ? psFrame.offsetTop : 0) + 6;
  stage.style.setProperty('--cap-h', `${capH}px`);
  stage.style.setProperty('--cart-h', `${Math.max(60, cartH)}px`);
}
// the engravings load after the first picture (the walk is the first paint); only the format this screen shows
const psFmt = () => (matchMedia('(min-width: 761px)').matches ? 't' : 'p');
function psLoad() {
  if (!PS) return;
  PS.querySelectorAll(`.ps-${psFmt()} img[data-src]`).forEach(im => { im.fetchPriority = 'low'; im.src = im.dataset.src; im.removeAttribute('data-src'); });
}
// the pick slip (stop 5): a plate is a door with two choices, walk in or see its depth
const psPick = PS?.querySelector('.ps-pick');
let psPickAt = 0, psFrom = null;
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'];
function psOpen(a) {
  const id = a.dataset.open, i = +a.dataset.i;
  const nm = (a.getAttribute('aria-label') || '').replace(/^[IVX]+\. /, '');
  const cut = nm.lastIndexOf(', ');
  psPick.querySelector('.ps-pick-k').textContent = `Plate ${ROMAN[i - 1]}`;
  psPick.querySelector('#ps-pick-n').textContent = nm.slice(0, cut);
  psPick.querySelector('.ps-pick-m').textContent = `${nm.slice(cut + 2)} \u00b7 ${id.startsWith('rosario') ? 'Argentina' : 'India'}`.toUpperCase();
  psPick.querySelector('.ps-pick-go').href = a.href;
  psPick.querySelector('.ps-pick-dm').href = new URL(`/depth.html?map=${id}#dm-cmp`, location.href).href;
  psFrom = a; psPickAt = bt;
  psPick.hidden = false;
  psPick.querySelector('.ps-pick-go').focus();
}
function psClose() {
  if (!psPick || psPick.hidden) return;
  psPick.hidden = true;
  try { psFrom?.focus({ preventScroll: true }); } catch (e) { /* gone */ }
}
if (PS) {
  PS.querySelectorAll('.ps-link').forEach(a => a.addEventListener('click', e => { if (PS.dataset.sheet === '1') { e.preventDefault(); psOpen(a); } }));
  psPick?.addEventListener('click', e => { if (e.target instanceof Element && e.target.closest('[data-close]')) psClose(); });
  addEventListener('keydown', e => { if (e.key === 'Escape') psClose(); });
  psFig[2]?.style.setProperty('--ink', '1');
  if (document.readyState === 'complete') setTimeout(psLoad, 300);
  else addEventListener('load', () => (window.requestIdleCallback || (f => setTimeout(f, 1)))(psLoad, { timeout: 1500 }), { once: true });
  addEventListener('resize', () => { psMeasure(); psLoad(); });
  psMeasure();
  if (document.fonts?.ready) document.fonts.ready.then(psMeasure);
}

// ------------------------------------------------------------------ the scroll: beat b in 0..5 (one unit per stop)
let bt = 0, b = 0, fixedB = null, stopNow = -1;
function readScroll() {
  const r = hero.getBoundingClientRect(), H = innerHeight;
  const p = clamp(-r.top / Math.max(1, r.height - H), 0, 1);
  bt = fixedB != null ? fixedB : p * STOPS;
  if (REDUCE) bt = Math.round(bt);
}

/** The words and the layers of the stage for beat x (no 3-D here). */
function ui(x) {
  const f = 1 - sm(0.04, 0.3, x);
  first.style.opacity = (f * f).toFixed(3);
  first.style.visibility = f < 0.01 ? 'hidden' : 'visible';
  first.inert = f < 0.5;
  hint.style.opacity = (1 - sm(0.04, 0.22, x)).toFixed(3);
  hint.inert = x > 0.15;                                   // a faded hint takes no taps (its tilt link on an iPhone)
  // with the dark (desktop) the dark itself is the vignette, as on site v4.1: C's veil would keep a cleared area black
  veil.style.opacity = dark && !gone ? '0' : (1 - sm(0.08, 0.5, x)).toFixed(3);
  if (!gone) dark?.setP(ramp(x, 0, 1));
  const s = Math.round(x), on = Math.abs(x - s) < 0.3 ? s : -1;
  if (on !== stopNow) {
    stopNow = on;
    stage.dataset.stop = String(Math.max(0, on));
    caps.forEach(c => { const k = +c.dataset.cap === on; c.classList.toggle('is-on', k); c.inert = !k; });
    if (!live.E && !PS) {                                    // (the still prototype with its plates: stillUi)
      const i = clamp(s, 0, STOPS);
      if (still.src !== PICS_L[i]) still.src = PICS_L[i];
      if (new URL(stillP.getAttribute('srcset') || '', location.href).href !== new URL(PICS[i], location.href).href) stillP.srcset = PICS[i];
    }
  }
  rail.forEach((li, i) => li.classList.toggle('is-on', i === s));
  // the hand-off (owner 11-13: "more blend in, smoother"): the eight places start from the park's own camera, so the park
  // island lies exactly on the park's points; the two layers cross (no dark moment) and the view goes on out
  // no eight places (no 3-D here, or they failed): the park picture stays, and the list under the hero shows them
  const parkO = live.atlas ? 1 - sm(OUT0 + 0.05, OUT0 + 0.45, x) : 1, atlasO = live.atlas ? sm(OUT0 - 0.05, OUT0 + 0.25, x) : 0;
  if (!STILL) box.style.opacity = parkO.toFixed(3);
  if (atlasEl) {
    atlasEl.style.opacity = atlasO.toFixed(3);
    atlasEl.style.visibility = atlasO < 0.01 ? 'hidden' : 'visible';
    live.atlas?.setShown?.(atlasO >= 0.01);                 // no frames for eight places nobody sees
    live.atlas?.setK(ramp(x, OUT0 + 0.1, OUT1));
    live.atlas?.setOn(x > OUT1 - 0.1);
  }
  live.parkHidden = parkO < 0.01;
  if (live.E) live.E.setOffscreen(live.parkHidden);          // no frames for a park nobody sees
  // the park went dark before the beat arrived (a fast fling, a jump, Back): its frames drove the beat, so the page
  // carries the last stretch itself; otherwise the eight places would stop half way out, with no names
  if (live.parkHidden && !carry && Math.abs(bt - b) > 1e-3) carry = requestAnimationFrame(carryOn);
  if (STILL) stillUi(x);
}
let carry = 0;
function carryOn() {
  carry = 0;
  if (!live.parkHidden || Math.abs(bt - b) < 1e-3) return;
  b += (bt - b) * (SNAP ? 1 : 0.18);
  if (Math.abs(bt - b) < 1e-3) b = bt;
  ui(b);
  if (Math.abs(bt - b) >= 1e-3 && !carry) carry = requestAnimationFrame(carryOn);
}

// ------------------------------------------------------------------ the place
const live = { E: null, handle: null, atlas: null, par: { x: 0, y: 0, tx: 0, ty: 0 }, look: { yaw: 0, pitch: 0, tyaw: 0, tpitch: 0, drag: null },
  // the phone's turn (tilt.js) is used relative to a zero: a scroll moves the zero onto the phone, so the view goes back to
  // the path (owner 11-17: after a scroll "camera pov side ways ... when moved phone to left can see path")
  tz: { yaw: 0, pitch: 0 }, tzGo: false, tzBt: 0, tzT: null, tLimL: 0.45, tLimR: 0.45 };
window.__f = {
  get b() { return b; }, get bt() { return bt; }, get live() { return !!live.E; },
  get handle() { return handle; },                         // tests: the place loader (its engine before it is live)
  get settled() { return !!live.E && (live.parkHidden || live.E.settled) && Math.abs(b - bt) < 1e-3; },   // a hidden park draws nothing
  get points() { return live.E?.measured || null; },
  get atlas() { return live.atlas; },
  /** test hook: hold the stage at beat x (null = follow the scroll again) */
  at(x) { fixedB = x; readScroll(); if (SNAP) b = bt; live.E?.stage.invalidate(); ui(b); return true; },
  /** test hook: the pointer (-1..1) for parallax, without a mouse */
  par(x, y) { live.par.tx = live.par.x = x; live.par.ty = live.par.y = y; live.E?.stage.invalidate(); return true; },
  /** test hook: hold the first screen's ride at metre `at` (the ride stops; tests need exact frames) */
  ride(at) { return live.rideTo ? live.rideTo(at) : false; },
  /** test hook: the walk goes on from metre `at` (it keeps walking); returns the loop's length and seam */
  walk(at) { return live.walkFrom ? live.walkFrom(at) : false; },
  get rideState() { const r = live.ride; return r ? { at: r.at, v: r.v, lock: r.lock, on: r.on } : null; },
  get E() { return live.E; },
  get look() { return live.look; },                       // tests: the drag-to-look state (yaw, pitch)
  get tilt() { return live.tilt || null; },                // tests: the phone's turn (tilt.js), or null
  get tiltView() { return live.tiltEff ? live.tiltEff() : null; },   // tests: the turn the view uses (after the zero and the limit)
  get tiltChase() { return !!live.tzGo; },                // tests: the zero is still moving back onto the path
};

/** A phone or tablet that cannot keep up (a weak GPU, a frame rate at the floor, a load that does not finish): the page
 *  goes to its still (classic) mode now, and the rest of this visit starts there (sessionStorage). */

function goStill(why) {
  if (!AUTO_STILL || gone || Q.get('force3d') === '1' || Q.get('still') === '0') return;       // tests keep the 3-D
  gone = true;
  console.info('[F] still mode:', why);
  try { sessionStorage.setItem('nr-still', '1'); } catch (e) { /* private mode */ }
  document.documentElement.classList.add('nr-still');
  document.documentElement.classList.remove('f-drift');
  try { dark?.destroy(); } catch (e) { /* gone */ }
  if (darkEl) darkEl.style.display = 'none';
  try { live.atlas?.destroy?.(); } catch (e) { /* gone */ }
  live.atlas = null; delete stage.dataset.atlas;
  try { (live.handle || handle)?.destroy?.(); } catch (e) { /* gone */ }
  setState({ state: 'failed', text: '' });
  live.E = null; live.starting = false; live.riding = false; delete box.dataset.posed; stopNow = -1;
  stage.dataset.live = '0';
  hintT.textContent = 'A picture of the 3‑D place. Scroll to rise above it.';
  ui(bt);
}

function setState(d) {
  // the words: on a desktop the live versions from the start (the picture walks in, the dark answers the mouse); the
  // picture versions only where no live place will come
  const liveish = d.state === 'live' || (dark && (d.state === 'loading' || (d.state === 'still' && !d.text)));
  stage.dataset.live = liveish ? '1' : '0';
  if (d.state === 'failed' && live.E) {
    // the place died after it was live (too slow, context lost): the page goes back to its pictures for every stop
    live.E = null; live.starting = false; live.riding = false; delete box.dataset.posed; stopNow = -1; ui(bt);
  }
  if (d.state === 'failed' || (d.state === 'still' && d.text)) {
    document.documentElement.classList.add('f-noatlas');      // v12.css shows the list
    document.documentElement.classList.add('f-still');         // no live walk will follow: the picture stops where it is
  }
  // while the picture walks in (desktop), the first screen says nothing about loading: it is already moving
  stateEl.textContent = d.state === 'loading' ? (dark ? '' : 'Getting the 3-D place ready.') : d.state === 'live' ? '' : d.text || '';
  // a touch screen: the dark follows a finger (dark.js); a sideways drag turns the view once the place is live
  hintT.textContent = liveish ? (TOUCH ? (d.state === 'live' ? 'Touch the dark: it hides a real place. Drag sideways to look. Scroll to light it.' : 'Touch the dark: it hides a real place. Scroll to light it.') : 'Move your mouse. The dark hides a real place. Scroll to light it.') : 'Scroll: move along the path, then rise above it.';
}

async function startLive(handle) {
  const E = handle?.engine;
  if (!E?.live || live.E || live.starting) return;
  live.starting = true;
  performance.mark('f-live');
  const THREE = await import('three');
  live.E = E; live.handle = handle;
  const tr = E.track, UP = new THREE.Vector3(0, 1, 0);
  const left = at => { const a = tr.tanAt(at); return new THREE.Vector3(-Math.cos(a), 0, Math.sin(a)); };
  const m4 = new THREE.Matrix4();
  const look = (p, t) => new THREE.Quaternion().setFromRotationMatrix(m4.lookAt(p, t, UP));
  // the loop: the camera's path ends 9 m past its start, 1.7 m aside and 1.6 m LOWER (the drift of the measurement; the
  // map near metres 0-15 holds both passes' ground, 1.6-1.8 m apart). The walk goes round at LOOP, the metre nearest the
  // start, and the last SEAM_M metres bend onto the start (camera and line, engine X.loop): a slow rise of 1.6 m over 25 m
  // (the camera may not go below the start's own ground, which begins at about metre 2). From above, the line is drawn
  // as measured again (X.loop.k goes to 0 in the pull-back, while the camera is high).
  const L = E.total, g0 = tr.ground(0, new THREE.Vector3()), gq = new THREE.Vector3();
  let LOOP = L, gap = Infinity;
  for (let a = L - 40; a <= L; a += 0.05) { const h = tr.ground(a, gq); const d = Math.hypot(h.x - g0.x, h.z - g0.z); if (d < gap) { gap = d; LOOP = a; } }
  if (!(gap < 4)) LOOP = L;                                 // no near closure: the walk wraps as the path is
  const SEAM = LOOP < L ? g0.clone().sub(tr.ground(LOOP, gq)) : new THREE.Vector3();
  const wrap = a => ((a % LOOP) + LOOP) % LOOP;
  const G = (at, out) => { at = wrap(at); tr.ground(at, out); return out.addScaledVector(SEAM, sm(LOOP - SEAM_M, LOOP, at)); };
  const P = (at, side, h) => G(at, new THREE.Vector3()).addScaledVector(left(wrap(at)), side).addScaledVector(UP, h);
  const loopX = k => ({ len: LOOP, seam: [SEAM.x, SEAM.y, SEAM.z], seamLen: SEAM_M, k });
  // the eye 1.35 m up, a little left of the path, looking 24 m ahead
  const eyeAt = at => { const p = P(at, 0.3, 1.35); return { p, q: look(p, P(at + LOOK_M, 0, 1.05)), sx: SX0 }; };
  if (AUTO_STILL && TOUCH && E.params?.tier === 'T1') { goStill('weak device'); return; }
  if (TOUCH) E.stage.setMinFrame(33);                    // phones and tablets: 30 fps keeps the GPU and the page in step
  // phones and tablets (owner 11-16: "still lag-ish"): the first screen sits under the dark, so fewer pixels and no
  // screen-sized splats (the overdraw of near splats is most of a frame on a mobile GPU)
  if (TOUCH) {
    const st = E.stage;
    st.maxDpr = 1; st.maxPixels = PHONE ? 0.45e6 : 0.75e6;
    if (st.spark) st.spark.maxPixelRadius = 140;
    if (st.size?.w > 1) st.resize(st.size.w, st.size.h);
  }
  const at00 = wrap(E.photos[E.photos.length > 40 ? 40 : 0].at - 10.4);          // where img/first.jpg was made
  // how far the picture has walked: its push-in scale s (f.css) = LOOK_M (1 - 1 / s) metres toward the point ahead
  const pushed = RIDE && (still.currentSrc || still.src).includes('first.jpg');   // a phone shows its own portrait picture
  const went = () => {
    if (!pushed) return 0;
    const tf = getComputedStyle(still).transform, s = tf && tf !== 'none' ? parseFloat(tf.slice(tf.indexOf('(') + 1)) : 1;
    return s > 1 ? LOOK_M * (1 - 1 / s) : 0;
  };
  // lock: while the picture and the live place cross, the live walk stands where the picture is (from the first posed
  // frame for FADE_MS); then it goes on at the picture's speed v and eases to RIDE_MS
  live.ride = { at: wrap(at00 + went()), on: RIDE, at0: null, v: 0, lock: pushed ? -1 : 0 };
  performance.mark('f-went', { detail: { metres: live.ride.at - at00 } });
  live.walkFrom = at => { live.ride.on = RIDE; live.ride.lock = 0; live.ride.at = wrap(at); live.ride.at0 = null; E.stage.invalidate(); return { loop: LOOP, seam: SEAM.toArray() }; };
  live.rideTo = at => { live.ride.on = false; live.riding = false; live.ride.lock = 0; live.ride.at = wrap(at); live.ride.at0 = null; build(); E.S.at = live.ride.at; E.stage.invalidate(); return true; };
  // the whole park: its middle and size (ground points every 2 m), for the end of the pull-back
  const bb = new THREE.Box3(), g = new THREE.Vector3();
  for (let m = 0; m <= L; m += 2) bb.expandByPoint(tr.ground(m, g));
  const mid = bb.getCenter(new THREE.Vector3()), size = bb.getSize(new THREE.Vector3());
  const RAD = 0.5 * Math.hypot(size.x, size.z);
  /** The pull-back from the eye at metre `capAt` (director.js 'rise', scaled from the live site's 1 km street to 227 m). */
  function build() {
    const at0 = live.ride.at0 ?? live.ride.at, capAt = wrap(at0 + MOVE_M);
    const cap = eyeAt(capAt);
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(cap.q); f.y = 0; f.normalize();
    const endPos = mid.clone().addScaledVector(f, -RAD * 1.45).addScaledVector(UP, RAD * 2.05);
    const P1 = cap.p.clone().addScaledVector(UP, 14).addScaledVector(f, -22);
    const P2 = P1.clone().lerp(endPos, 0.5); P2.y += 0.15 * P1.distanceTo(endPos);
    const ahead = cap.p.clone().addScaledVector(f, 18); ahead.y = G(capAt, g).y;
    live.rise = { cap, capAt, P1, P2, endPos, endTarget: mid.clone(), ahead, f: f.clone() };
  }
  build();

  const rp = new THREE.Vector3(), T = new THREE.Vector3(), yawQ = new THREE.Quaternion(), pv = new THREE.Vector3();
  const fwd = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3(), F = new THREE.Vector3(), dir = new THREE.Vector3(), rot = new THREE.Quaternion(), dPar = new THREE.Vector3();
  const bez = (a, b1, b2, c, t, out) => {
    const u = 1 - t;
    return out.copy(a).multiplyScalar(u * u * u).addScaledVector(b1, 3 * u * u * t).addScaledVector(b2, 3 * u * t * t).addScaledVector(c, t * t * t);
  };
  const fv = () => E.fov().v;
  // the largest turn of the phone that the view takes, to the left (L, yaw +: the scene moves right) and to the right (R).
  // At eye level the view turns round the eye: on a narrow (portrait) screen a 26 degree turn takes the path out of the
  // picture. So the path 8 m ahead may move at most to 75 % of the way to either edge, from where it really is (b0: its
  // bearing, + = right of the view's axis; the eye stands 0.3 m beside the path) and with the view's centre shift sx
  // (tablets: the axis sits at 62 % of the width). On screen x = tan(bearing) / tan(half width) - sx. Higher up the view
  // turns round the path itself (the pivot moves to it), so there both sides blend (w) to the full turn.
  const qInv = new THREE.Quaternion(), vB = new THREE.Vector3(), gB = new THREE.Vector3();
  const bearing = (at, p, q) => { G(at + 8, gB); vB.copy(gB).sub(p).applyQuaternion(qInv.copy(q).invert()); return Math.atan2(vB.x, -vB.z); };
  const setLims = (sx, fov, w, b0 = 0) => {
    const sz = E.stage.size, t = Math.tan(fov / 2) * ((sz?.w || 1) / (sz?.h || 1));
    const l = clamp(Math.atan((0.75 + sx) * t) - b0, 0.12, 0.45), r = clamp(Math.atan((0.75 - sx) * t) + b0, 0.12, 0.45);
    live.tLimL = l + (0.45 - l) * w; live.tLimR = r + (0.45 - r) * w;
  };
  live.tiltEff = () => {
    const T = live.tilt;
    if (!T) return null;
    return { yaw: clamp(T.yaw - live.tz.yaw, -live.tLimR, live.tLimL), pitch: clamp(T.pitch - live.tz.pitch, -0.22, 0.22) };
  };
  function pose(x) {
    const par = live.par, R = live.rise;
    if (x <= RISE0) {
      // the first screen (the ride) and stop 1: the visitor moves along the path with the park
      const at0 = live.ride.at0 ?? live.ride.at, at = wrap(at0 + MOVE_M * easeOutCubic(ramp(x, RIDE_B, 1)));   // no still band
      const s = eyeAt(at);
      hereAt = at;
      E.S.at = at;                                         // the path's window follows the visitor
      // the pointer moves the camera sideways (parallax)
      dPar.set(0, 0, 0);
      if (!REDUCE && (par.x || par.y)) {
        fwd.set(0, 0, -1).applyQuaternion(s.q); right.set(1, 0, 0).applyQuaternion(s.q); up.set(0, 1, 0).applyQuaternion(s.q);
        F.copy(s.p).addScaledVector(fwd, 7);
        dPar.addScaledVector(right, par.x * 0.4).addScaledVector(up, -par.y * 0.16);
        s.p.add(dPar);
        dir.subVectors(F, s.p).normalize();
        s.q.premultiply(rot.setFromUnitVectors(fwd, dir));
      }
      setLims(s.sx || 0, fv(), 0, bearing(at, s.p, s.q));   // (before the turn is applied to s.q)
      const L0 = live.look, TT = live.tiltEff(), kt = TT ? 1 : 0;
      const ly = L0.yaw + (kt ? TT.yaw * kt : 0), lp = L0.pitch + (kt ? TT.pitch * kt : 0);
      if (ly || lp) {
        right.set(1, 0, 0).applyQuaternion(s.q);
        s.q.premultiply(yawQ.setFromAxisAngle(right, lp)).premultiply(rot.setFromAxisAngle(UP, ly));
      }
      E.setDirect({ w: 1, p: s.p, q: s.q, fov: fv(), sx: s.sx, sy: 0, ribbon: 1, route: null, dark: 0, loop: loopX(1) });
      return;
    }
    // ---- the rise (owner 11-16: "as user scrolls down make sure camera stays / follows trajectory ... lock camera at
    // trajectory path then let user rotate / explore map from that point"). The camera stays on the camera path: the
    // scroll carries its anchor on along the path while it rises behind it, a chase view that always looks at the path.
    // By stop 3 it is high enough to see the whole park, still over the path. A drag turns the view: at eye level in
    // place, higher up round the anchor (the map turns under the visitor); a further scroll gives the view back to the path.
    const e = ss(ramp(x, RISE0 + 0.08, 2.85));                                   // how far up (0 = the eye, 1 = high)
    const a = wrap(R.capAt + FOLLOW_M * ss(ramp(x, RISE0, 3.0)) + 12 * ss(ramp(x, 3.0, OUT1)));
    // a portrait screen sees less to the sides: the camera goes higher and further back so the whole park fits
    const sz = E.stage.size, fitK = Math.pow(Math.max(1, 1.05 / Math.max(0.3, (sz?.w || 1) / (sz?.h || 1))), 0.85);
    const h = 1.35 + (RAD * 2.05 * fitK - 1.35) * e, back = RAD * 1.25 * fitK * e;  // up through the canopy quickly
    dir.copy(G(a + 14, F)).sub(G(a - 14, T)); dir.y = 0;                         // the path's heading over 28 m (smooth corners)
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1); else dir.normalize();
    dir.lerp(R.f, ss(ramp(e, 0.3, 0.9))).normalize();                            // high up: one steady heading
    rp.copy(P(a, 0.3 * (1 - e), h)).addScaledVector(dir, -back);
    T.copy(P(a + LOOK_M * (1 - e) + 6 * e, 0, 1.05 * (1 - e))).lerp(mid, 0.85 * Math.pow(e, 1.6));   // high up: the whole park
    R.endTarget.copy(T);                                                          // the eight places start from this view
    // the pointer (desktop): a little parallax round the target, more as the view rises
    if (!REDUCE && (par.x || par.y)) {
      yawQ.setFromAxisAngle(UP, -par.x * 6 * DEG * e);
      rp.sub(T).applyQuaternion(yawQ).add(T);
      rp.y += -par.y * 3 * e;
    }
    let q = look(rp, T);
    if (x < RISE0 + 0.3) q = new THREE.Quaternion().slerpQuaternions(R.cap.q, q, ss(ramp(x, RISE0, RISE0 + 0.3)));
    // the visitor's drag + the phone's tilt (as on the first screen), until the eight places come
    setLims(R.cap.sx * (1 - e) + END_SX * e, fv() + (46 * DEG - fv()) * e, sm(3, 18, h - 1.35), bearing(a, rp, q));   // the sx and fov this frame uses; w = the pivot's weight below
    const L1 = live.look, TT = live.tiltEff(), kt = TT ? 1 - ss(ramp(x, OUT0 - 0.4, OUT0 - 0.05)) : 0;
    const ly = L1.yaw + (kt ? TT.yaw * kt : 0), lp = L1.pitch + (kt ? TT.pitch * kt : 0);
    if (ly || lp) {
      // the pivot moves from the eye (look round) to the target on the path (turn round it) as the camera rises
      pv.copy(rp).lerp(T, sm(3, 18, h - 1.35));
      right.set(1, 0, 0).applyQuaternion(q);
      rot.setFromAxisAngle(UP, ly).multiply(yawQ.setFromAxisAngle(right, lp));   // yaw . pitch . view (as at eye level)
      rp.sub(pv).applyQuaternion(rot).add(pv);
      q.premultiply(rot);
      const gy = G(a, F).y + 1.2;
      if (rp.y < gy) rp.y = gy;                                                   // never under the ground
    }
    const p = ramp(x, RISE0, RISE1), kr = easeOutCubic(ramp(p, 0.35, 0.85));
    hereAt = a;
    E.S.at = a;                                                                   // the path's window follows the anchor
    E.setDirect({
      w: 1, p: rp, q, fov: fv() + (46 * DEG - fv()) * e, sx: R.cap.sx * (1 - e) + END_SX * e, sy: 0,
      ribbon: 1, dark: sm(2, 12, h - 1.35), loop: loopX(1),
      route: e < 0.002 ? null : { back: 10 + kr * L, ahead: 45 + kr * L, far: 60 + kr * 2 * L, minPx: 1.4 + 0.8 * sm(3, 15, h - 1.35),
        maxPx: 12 + 1e6 * sm(3, 15, h - 1.35) },
    });
  }
  // the stage's own frame loop: runs while the scroll, the pointer or the first screen's ride moves something
  let last = performance.now();
  E.stage.hooks.add(() => {
    const now = performance.now(), raw = (now - last) / 1000, dt = clamp(raw, 0, 0.1);
    last = now;
    let more = false;
    if (SNAP) b = bt;
    else { b += (bt - b) * (1 - Math.exp(-dt * 7)); if (Math.abs(bt - b) < 1e-3) b = bt; else more = true; }
    const par = live.par, kp = REDUCE || SNAP ? 1 : 1 - Math.exp(-dt * 5);
    par.x += (par.tx - par.x) * kp; par.y += (par.ty - par.y) * kp;
    if (Math.abs(par.tx - par.x) + Math.abs(par.ty - par.y) < 1e-3) { par.x = par.tx; par.y = par.ty; } else more = true;
    // the phone's turn: a scroll gives the view back to the path (as it does after a drag). The zero follows the phone
    // while the page moves and until the view is back on the path; when the page is still, the phone looks round again.
    // While the page moves, the zero's target is the phone; once the page is still, the target holds, so a turn made then
    // acts at once (it is not absorbed) and the chase ends (no frames for a drifting hand).
    const TLt = live.tilt;
    if (TLt) {
      if (Math.abs(bt - live.tzBt) > 0.02) { live.tzBt = bt; live.tzGo = true; live.tzT = null; }
      if (live.tzGo) {
        if (Math.min(b, bt) >= OUT0 - 0.05) {               // the turn has no effect here: settle at once, no frames for it
          live.tz.yaw = TLt.yaw; live.tz.pitch = TLt.pitch; live.tzGo = false; live.tzT = null;
        } else {
          const moving = Math.abs(bt - b) >= 1e-3;
          if (moving || !live.tzT) live.tzT = { yaw: TLt.yaw, pitch: TLt.pitch };
          const T = live.tzT, kz = REDUCE ? 1 : 1 - Math.exp(-dt / 0.25);
          live.tz.yaw += (T.yaw - live.tz.yaw) * kz; live.tz.pitch += (T.pitch - live.tz.pitch) * kz;
          if (!moving && Math.abs(T.yaw - live.tz.yaw) + Math.abs(T.pitch - live.tz.pitch) < 1e-3) {   // within 0.06 degree (< 1 px): done
            live.tz.yaw = T.yaw; live.tz.pitch = T.pitch; live.tzGo = false; live.tzT = null;
          } else more = true;
        }
      }
    }
    // the first screen: the park plays (owner 11-13); the scroll freezes the ride and moves on from there
    const R0 = live.ride;
    if (R0.on && b < RIDE_B && fixedB == null && !document.hidden) {
      // the cross-fade starts with the first posed frame; if that frame came while the visitor was further down, the
      // picture is long gone and the walk just starts from where it stands
      if (R0.lock < 0) R0.lock = now - (live.posedAt ?? now) < 100 ? now + FADE_MS : 0;
      if (R0.lock) {
        // the hand-over: the live walk stands where the picture is while the two cross (f.css), and learns its speed
        const a = wrap(at00 + went()), step = ((a - R0.at) % LOOP + LOOP * 1.5) % LOOP - LOOP * 0.5;
        if (raw > 0.004) R0.v += (clamp(step / raw, 0, RIDE_MS * 1.5) - R0.v) * 0.35;
        R0.at = a;
        if (now > R0.lock) R0.lock = 0;
      } else {
        R0.v += (RIDE_MS - R0.v) * (1 - Math.exp(-dt / RIDE_TAU));
        R0.at = wrap(R0.at + dt * R0.v);
      }
      R0.at0 = null;
      if (!live.riding && !performance.getEntriesByName('f-ride').length) performance.mark('f-ride');
      live.riding = true; more = true;
    } else if (live.riding && b >= RIDE_B) {
      live.riding = false;
      R0.at0 = R0.at; R0.v = 0; R0.lock = 0;                // the scroll takes over; back at the top the walk starts again
      build();
    } else if (!live.riding && b < RIDE_B && R0.at0 != null && R0.on) {
      R0.at = R0.at0; R0.at0 = null;                        // back on the first screen: the walk goes on from here
    }
    const lk = live.look, kl = REDUCE ? 1 : 1 - Math.exp(-dt * 6);
    // the visitor's turn stays while the page is still; a scroll of more than 0.08 beat (or the eight places) gives the
    // view back to the path
    if (!lk.drag && lk.at != null) {
      const k = (1 - ramp(Math.abs(bt - lk.at), 0.08, 0.4)) * (1 - ramp(b, OUT0 - 0.4, OUT0 - 0.05));
      lk.tyaw = (lk.endYaw || 0) * k; lk.tpitch = (lk.endPitch || 0) * k;
      if (k <= 0) lk.at = null;
    }
    // the doors open the 3-D view where the camera is now (not where the last scroll event left it)
    if (Math.round(hereAt) !== live.linkAt) { live.linkAt = Math.round(hereAt); setLinks(); }
    lk.yaw += (lk.tyaw - lk.yaw) * kl; lk.pitch += (lk.tpitch - lk.pitch) * kl;
    if (Math.abs(lk.tyaw - lk.yaw) + Math.abs(lk.tpitch - lk.pitch) < 1e-4) { lk.yaw = lk.tyaw; lk.pitch = lk.tpitch; } else more = true;
    pose(b); ui(b);
    if (!box.dataset.posed) { box.dataset.posed = '1'; live.posedAt = now; }   // this frame shows the page's own view: the picture may go
    if (b > ATLAS_B) loadAtlas();
    if (TOUCH && b > RIDE_B) askPts();                     // the first scroll
    if (live.atlas && b > OUT0 - 0.6 && !live.parkHidden) heroToAtlas();
    return more;
  });
  // the park's camera, in the frame of the eight places (map -> atlas: the park island's own matrix)
  const Winv = new THREE.Matrix4(), hp = new THREE.Vector3(), ht = new THREE.Vector3(), hf = new THREE.Vector3();
  function heroToAtlas() {
    const cam = E.stage.camera, M = live.atlas.mapToScene(PLACE);
    if (!M) return;
    Winv.copy(E.stage.world.matrixWorld).invert();
    hf.set(0, 0, -1).applyQuaternion(cam.quaternion);
    const D = cam.position.distanceTo(live.rise.endTarget);
    hp.copy(cam.position).applyMatrix4(Winv).applyMatrix4(M);
    ht.copy(cam.position).addScaledVector(hf, D).applyMatrix4(Winv).applyMatrix4(M);
    live.atlas.setFrom({ pos: hp, target: ht, fov: cam.fov, shiftX: -(E.X?.sx || 0) / 2 });
  }
  // the eight places (the floating trajectories): one more canvas in the stage, loaded when the visitor scrolls toward
  // them (b > ATLAS_B): nothing extra runs on the main thread while the walk starts
  let atlasP = null;
  function loadAtlas() {
    if (atlasP || !atlasEl || gone) return;
    const links = { open: id => openHref(null, id), depth: id => new URL(`/depth.html?map=${id}#dm-cmp`, location.href).href };
    atlasP = import('./atlas.js')
      .then(({ mountAtlas }) => mountAtlas(atlasEl, links, { embedded: true, close: PLACE, shiftX: -0.03, shiftY: 0.09 }))   // the names sit right of each shape: the group moves left a little
      .then(h => {
        if (!h) throw new Error('no WebGL2 context for the eight places');
        if (gone) { try { h.destroy?.(); } catch (e) { /* gone */ } return; }
        const late = b > OUT0 + 0.05;                      // the visitor is already where they show: cross, do not cut
        if (late) for (const el of [box, atlasEl]) { el.style.transition = 'opacity .6s linear'; setTimeout(() => { el.style.transition = ''; }, 700); }
        live.atlas = h; stage.dataset.atlas = '1'; ui(b);   // the shapes are the choices now: f.css makes the last words short
        if (late) heroToAtlas();
      })
      .catch(e => { console.warn('[F] atlas', e); document.documentElement.classList.add('f-noatlas'); ui(b); });
  }
  live.loadAtlas = loadAtlas;
  // touch: the measured points (shown from above) load once the place is live and settled, or when the visitor scrolls
  function askPts() {
    if (live.ptsAsked || !live.E) return;
    live.ptsAsked = true;
    live.E.loadMeasured?.()?.catch?.(e => console.warn('[F] points', e));
  }
  if (TOUCH) setTimeout(() => (window.requestIdleCallback || (f => setTimeout(f, 1)))(askPts, { timeout: 2000 }), 6000);
  // ---- look with your phone (owner 11-16: "ar\vr features ... phone and tablet ... imu ... amaze users"): on the first
  // screen and at stop 1 the phone's turn turns the view a little (at most 26 degrees) and the dark clears where it points
  if (TOUCH && !REDUCE && canTilt()) {
    const begin = () => {
      if (live.tiltH) return;
      performance.mark('f-tilt');
      // the dark's centre (dark.js: VP + 7.5 % of the height): where the phone points at rest
      const cx = PHONE ? 0.5 : 0.62, cy = PHONE ? 0.635 : 0.435;
      live.tiltH = startTilt(d => {
        live.tilt = d;
        if (!d) { live.tz.yaw = live.tz.pitch = 0; live.tzGo = false; live.tzT = null; }
        else {
          // past the limit the zero slides along with the phone, so a turn back acts at once (no dead zone); a slide places
          // the zero itself on that axis, so a chase in progress is done on that axis (the other one finishes as usual)
          const ey = d.yaw - live.tz.yaw, ep = d.pitch - live.tz.pitch;
          let slidY = false, slidP = false;
          if (ey > live.tLimL) { live.tz.yaw = d.yaw - live.tLimL; slidY = true; } else if (ey < -live.tLimR) { live.tz.yaw = d.yaw + live.tLimR; slidY = true; }
          if (Math.abs(ep) > 0.22) { live.tz.pitch = d.pitch - Math.sign(ep) * 0.22; slidP = true; }
          if ((slidY || slidP) && live.tzGo && Math.abs(bt - b) < 1e-3) {
            const T = live.tzT || (live.tzT = { yaw: d.yaw, pitch: d.pitch });
            if (slidY) T.yaw = live.tz.yaw;
            if (slidP) T.pitch = live.tz.pitch;
          }
        }
        const tv = live.tiltEff();
        if (tv && b < 0.35) dark?.point?.(cx - tv.yaw / 0.9, cy - tv.pitch / 0.7);
        if (b < OUT0) E.stage.invalidate();                 // with the eight places the tilt has no effect: no frame for it
      });                                                   // no range here: the page's own zero and limit (live.tz, live.tLimL/R) do it,
                                                            // so after a scroll a further turn the same way still looks round
      hintT.textContent = 'Tilt your phone, or touch the dark: it hides a real place. Scroll to light it.';
    };
    if (TILT_ASKS && typeof window.DeviceOrientationEvent?.requestPermission === 'function') {
      // iPhone / iPad: the system asks once, and only from a tap
      const t = document.createElement('button');
      t.type = 'button'; t.className = 'h-tilt'; t.textContent = 'Tilt your phone to look';
      t.addEventListener('click', () => askTilt().then(r => { t.remove(); if (r === 'granted') begin(); }));
      hint.append(t);
    } else askTilt({ prompt: false }).then(r => { performance.mark('f-tilt-' + r); if (r === 'granted') begin(); });
    addEventListener('pagehide', () => { live.tiltH?.stop(); live.tiltH = null; live.tilt = null; });
    // Back / Forward from the page cache: the look comes back (Android needs no prompt; an iPhone keeps its answer)
    addEventListener('pageshow', e => { if (e.persisted && !live.tiltH) askTilt({ prompt: false }).then(r => { if (r === 'granted') begin(); }); });
  }
  // touch: the adaptive resolution at its floor for 5 s in a row = this device cannot hold even 30 fps: still mode
  if (AUTO_STILL && TOUCH) {
    let low = 0;
    const iv = setInterval(() => {
      const st = live.E?.stage;
      if (!st || gone) { clearInterval(iv); return; }
      if (b > RISE0 || document.hidden) { low = 0; return; }
      const fps = st.fps();
      low = st.maxScale > st.minScale + 1e-3 && st.scale <= st.minScale + 1e-3 && fps != null && fps < 20 ? low + 1 : 0;
      if (low >= 5) { clearInterval(iv); goStill('frame rate at the floor'); }
    }, 1000);
  }
  if (bt > ATLAS_B) loadAtlas();
  else setTimeout(() => (window.requestIdleCallback || (f => setTimeout(f, 1)))(loadAtlas, { timeout: 2000 }), TOUCH ? 9000 : 4000);
  // (touch: later, so its download and shader compile land while the walk plays, not in the first scroll)
  onScroll();
  E.stage.invalidate();
}

let handle = null, slowT = 0;
if (LIVE_HOME) {
  mountPlace(box, {
    id: PLACE, mode: 'lift', kf: 40, allowReduced: true, tierPref: 'lite',
    ribbon: { color: ACC.path || ACC.hex, rim: ACC.pathRim || ACC.rim },          // the camera's path
    // touch (owner 11-16: "still heavy"): the touch map (200 000 of Lite's 600 000 splats, 3.6 MB of 11 MB) and the
    // measured points only when the visitor scrolls towards the rise
    engine: { aboveEl: 40, shiftX: 0, ovMargin: 1.1, dolly: false, youLabel: '', cone: false, marks: false, pointsAbove: true,
      ...(TOUCH && PLACE === 'oak_161206' ? { liteUrl: new URL('/data/home/oak_161206_touch_200k.spz', location.href).href, liteBytes: 3624763, pointsLazy: true } : {}),
      lift: 0, accent: ACC.path || ACC.hex, accentRim: ACC.pathRim || ACC.rim },
    onEvent(type, d) {
      if (AUTO_STILL && TOUCH && handle?.engine?.params?.tier === 'T1') { goStill('weak device'); return; }
      if (type === 'state' && d.state === 'loading' && TOUCH && !slowT) {
        slowT = setTimeout(() => { if (!live.E && !gone && !document.hidden) goStill('slow load'); }, 45000);
      }
      if (type === 'state') { setState(d); if (d.state === 'live') startLive(handle).catch(e => console.warn('[F]', e)); }
    },
  }).then(h => { handle = h; if (gone) { try { h.destroy?.(); } catch (e) { /* gone */ } return; } if (h.live && !live.E) startLive(h).catch(e => console.warn('[F]', e)); });
  // touch on a slow link: no live place after 25 s = the pictures stay (the download stops)
  // (touch on a slow link: no live place 45 s after it started loading = the pictures stay; onEvent above)
} else {
  stage.dataset.live = '0';
  if (STILL) document.documentElement.classList.add('f-noatlas', 'f-still');
  hintT.textContent = STILL ? 'A picture of the 3‑D place. Scroll to rise above it.' : 'On a phone you see pictures. Tap Walk into the place to move in 3‑D.';
}

// the pointer: parallax (mouse); a drag looks around at eye level (owner 11-13: "make it interactive with mouse so user can
// explore / get glimpse of map in background"). A click never leaves the page.
// touch: a sideways drag turns the view; an up or down swipe still scrolls the page (touch-action pan-y)
// (pinch-zoom stays: low-vision visitors zoom the words). On touch the words take the drag too, but not their links/buttons.
const hId = $('.h-id');
const dragEls = TOUCH && hId ? [box, hId] : [box];
if (TOUCH) for (const el of dragEls) el.style.touchAction = 'pan-y pinch-zoom';
const onDown = e => {
  const mouse = e.pointerType !== 'touch';                // a pen drags like the mouse
  if ((mouse && e.button !== 0) || !live.E || b > OUT0 - 0.05 || live.look.drag) return;
  if (e.target instanceof Element && e.target.closest('a, button')) return;
  live.look.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, yaw: live.look.tyaw, pitch: live.look.tpitch, touch: !mouse };
  live.look.at = bt;
  stage.dataset.drag = '1';
  try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* older browsers */ }
};
const onMove = e => {
  const d = live.look.drag;
  if (!d || e.pointerId !== d.id) return;
  const k = d.touch ? 0.0034 : 0.0024;                    // a finger moves less far than a mouse for the same turn
  const lim = b <= RISE0 ? 0.75 : Math.PI;                 // eye level: at most 43 degrees (as before); from the rise on: all round
  live.look.tyaw = clamp(d.yaw - (e.clientX - d.x) * k, -lim, lim);             // a 300 px drag turns about 40 degrees
  if (!d.touch) live.look.tpitch = clamp(d.pitch - (e.clientY - d.y) * 0.0024, -0.45, 0.3);    // a finger's up/down is the scroll
  live.E?.stage.invalidate();
};
const endDrag = e => {
  const L = live.look;
  if (L.drag && e.pointerId === L.drag.id) { L.drag = null; L.at = bt; L.endYaw = L.tyaw; L.endPitch = L.tpitch; delete stage.dataset.drag; }
};
for (const el of dragEls) {
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove, { passive: true });
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
  el.addEventListener('lostpointercapture', endDrag);
}
addEventListener('pointermove', e => {
  if (e.pointerType !== 'mouse' || !live.E || REDUCE) return;
  live.par.tx = clamp(e.clientX / innerWidth * 2 - 1, -1, 1);
  live.par.ty = clamp(e.clientY / innerHeight * 2 - 1, -1, 1);
  live.E.stage.invalidate();
}, { passive: true });
document.addEventListener('pointerleave', () => { live.par.tx = live.par.ty = 0; live.E?.stage.invalidate(); });

function onScroll() {
  readScroll();
  // the stop-5 credit is fixed to the screen's foot: it goes once the stage itself scrolls away (it lay over later sections)
  const past = hero.getBoundingClientRect().bottom < innerHeight - 8 ? '1' : '0';
  if (stage.dataset.past !== past) stage.dataset.past = past;
  if (live.E && !live.parkHidden) live.E.stage.invalidate();
  else { b = bt; ui(bt); }                               // the park is hidden (no frames): the words and the islands follow directly
  if (live.E) setLinks();
}
let pend = false;
addEventListener('scroll', () => {
  if (pend) return; pend = true;
  requestAnimationFrame(() => { pend = false; onScroll(); });
}, { passive: true });
addEventListener('resize', () => { onScroll(); ui(live.E ? b : bt); });
// "See how": to stop 1 (the visitor's click; a cut with reduced motion)
$('.h-more').addEventListener('click', e => {
  e.preventDefault();
  scrollTo({ top: hero.offsetTop + (hero.offsetHeight - innerHeight) / STOPS, behavior: REDUCE ? 'auto' : 'smooth' });
});
readScroll(); b = bt; ui(b);
if (!Q.has('shot') && !window.__noAccentBar) picker();   // the review bar (prototype only; not in test shots or the site build)
void SWITCH;
