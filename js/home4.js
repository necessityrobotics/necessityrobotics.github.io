// Necessity Robotics v4, lane HOME: the script of the home page (index.html).
// The page is complete without it: the name, the sentence, the photos, the picture of the 3-D place, the buttons and
// the 8 cards are static HTML and plain links (R10). This script adds, after the first paint:
//   1. the live 3-D place in the frame (js/place/mount.js, mode "frame"), on a device that can run it;
//   2. the true hint for each state of the frame (R3): a hint about dragging shows only while the place is live;
//   3. the camera photos as doors into the live frame (a tap moves the frame to the spot of that photo);
//   4. the camera's path of screen 3 as a route door (js/v4/route-door.js), drawn when it comes near the screen.
// Nothing here moves the 3-D place by itself (R1): every move answers a tap, a drag or a swipe of the visitor.
import { exploreHref, loadPlaces } from './v4/common.js';
import { routeDoor } from './v4/route-door.js';
import { mountPlace } from './place/mount.js';
import { LINKS } from './config.js';

const $ = (sel, root = document) => root.querySelector(sel);
const hero = $('.h4-hero');
const el = $('#frame');
const chip = $('#h4-chip');
const sayEl = $('#h4-say');
const still = el && $('.pl-still', el);

const TAP = '<span class="when-touch">Tap</span><span class="when-fine">Click</span>';
const CHIP = 'v4-chip v4-chip--wrap h4-chip';
const TEXT = {
  door: `Picture of the 3-D place. ${TAP} to walk in.`,
  wait: 'Getting the 3-D place ready',
  look: `<span class="h4-chip-ico" aria-hidden="true">&harr;</span><span class="when-touch">Swipe sideways</span><span class="when-fine">Drag</span> to look around`,
  turned: 'You turned it yourself. A video cannot do that.',
  photo: 'This photo was taken here. Now look around. The photo cannot.',
  still: 'Nothing moves until you move it.',
};

// the test switches of the engine follow the visitor into the 3-D view (ENGINE.md section 4)
const CARRY = (() => {
  const q = new URLSearchParams(location.search), out = new URLSearchParams();
  for (const k of ['force3d', 'shot', 'q', 'tier', 'assets']) if (q.has(k)) out.set(k, q.get(k));
  const s = out.toString();
  return s ? `&${s}` : '';
})();
const hrefOf = (id, at) => exploreHref(id, at) + CARRY;

// ------------------------------------------------------------------ small things that need no 3-D
// one source for the repository and the e-mail address (js/config.js); the HTML carries the same values without scripts
document.querySelectorAll('[data-link="repo"]').forEach((a) => { a.href = LINKS.repo; });
document.querySelectorAll('[data-link="email"]').forEach((a) => { a.href = `mailto:${LINKS.email}`; a.textContent = LINKS.email; });

// screen 3: the camera's path of the farm robot. Drawn from data/routes.json only when it comes near the screen.
function initWhyRoute() {
  const a = $('.h4-beat-route');
  if (!a) return;
  const start = async () => {
    let at = null;
    try { at = (await loadPlaces()).byId[a.dataset.route]?.start_at_m ?? null; } catch (e) { /* the path still draws */ }
    routeDoor(a, { id: a.dataset.route, start: at, pad: { t: 16, r: 20, b: 40, l: 20 } });
  };
  if (!('IntersectionObserver' in window)) { start(); return; }
  const io = new IntersectionObserver((es) => {
    if (!es.some((e) => e.isIntersecting)) return;
    io.disconnect();
    start();
  }, { rootMargin: '900px 0px' });
  io.observe(a);
}
initWhyRoute();

// ------------------------------------------------------------------ the frame
let frame = null;
let looked = false;
const photos = [...document.querySelectorAll('#h4-photos .v4-photo')];
const markPhoto = (a) => photos.forEach((p) => { if (p === a) p.setAttribute('aria-current', 'true'); else p.removeAttribute('aria-current'); });

function setChip(kind, cls = '') {
  if (!chip) return;
  const cn = `${CHIP}${cls ? ` ${cls}` : ''}`;
  if ((chip.dataset.kind || 'door') === kind && chip.className === cn) return;      // no second announcement of the same line
  chip.className = cn;
  chip.innerHTML = TEXT[kind];
  chip.dataset.kind = kind;
}

/** One plain line beside the buttons: the line of the live place, or why the place stopped (with a button to try again). */
function setSay(text, again) {
  if (!sayEl) return;
  sayEl.textContent = text || '';
  if (text && again) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = again;
    b.addEventListener('click', () => frame?.again());
    sayEl.append(' ', b);
  }
  sayEl.hidden = !text;
}

/** R3: a hint is true when it shows. The line beside the buttons is in the page only in two states:
 *  live   = "Nothing moves until you move it."
 *  failed = the 3-D place ran on this device and stopped: one plain sentence and "Open it again".
 *  In state still (also on a device that cannot run the place) the chip in the frame says it all, and the line is
 *  not in the page flow: no empty gap. */
function onState(d) {
  if (hero) hero.dataset.frame = d.state;
  if (d.state === 'live') {
    setChip(looked ? 'turned' : 'look', looked ? 'v4-chip--ion' : 'v4-chip--line is-new');
    setSay(TEXT.still);
  } else if (d.state === 'loading') {
    setChip('wait', 'v4-chip--wait');
    setSay('');
    markPhoto(null);
  } else {                                   // still | failed: the frame is a picture and a door
    setChip('door');
    if (d.state === 'failed') setSay(d.text, d.again); else setSay('');
    markPhoto(null);
  }
}

async function initFrame() {
  if (!el || !still) return;
  const id = still.dataset.place;
  const startAt = Number(still.dataset.at);
  // the door of the frame opens the same spot the picture shows
  const door = $('#h4-door');
  if (door && id) door.href = hrefOf(id, Number.isFinite(startAt) ? startAt : undefined);

  // the first paint comes first: the 3-D code waits for the picture and for two frames of the browser
  if (!still.complete) await new Promise((r) => { still.addEventListener('load', r, { once: true }); still.addEventListener('error', r, { once: true }); setTimeout(r, 3000); });
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  frame = await mountPlace(el, {
    id, mode: 'frame',
    stepLabel: `${TAP} to step here`,
    onEvent(type, d) {
      if (type === 'state') onState(d);
      else if (type === 'first-look') { looked = true; if (chip?.dataset.kind !== 'photo') setChip('turned', 'v4-chip--ion'); }
      else if (type === 'enter') location.href = hrefOf(id, d.at);        // the visitor tapped the picture, the path or a circle
    },
  });
  window.__home = { frame };

  // a camera photo is a door. Live frame + the spot is inside the loaded 3-D file: the frame goes there (visitor-caused).
  // In every other case the photo's own link opens the 3-D view at that spot.
  photos.forEach((a) => a.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return;
    const kf = Number(a.dataset.kf);
    if (!frame || !frame.live || !Number.isFinite(kf) || !frame.covers({ kf })) return;
    e.preventDefault();
    frame.goTo({ kf });
    markPhoto(a);
    setChip('photo', 'v4-chip--line');
  }));
  if (CARRY) photos.forEach((a) => { a.href += CARRY; });
}

// the grey line is true only for a black-and-white place (places.json: colour)
loadPlaces().then((P) => {
  const g = $('#h4-grey');
  if (g && P.heroPlace && P.heroPlace.colour) g.hidden = true;
}).catch(() => {});

initFrame().catch((e) => { console.warn('[home] the frame stays a picture:', e); });
