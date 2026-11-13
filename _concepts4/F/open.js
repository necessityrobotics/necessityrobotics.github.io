// V12 concept A, LIFT-OFF: what happens when a visitor opens a 3-D place.
// 1. The place opens ABOVE: the whole path, the spot marked with a cone ("You will stand here"). It is still; the pointer
//    turns it a little (parallax), a drag turns it, a click on the line picks another spot.
// 2. The visitor clicks "Drop in here" (or the line): the view DROPS IN, one time, about 1.6 s, down to eye height at
//    that spot, on the same curve as the home page's lift, in reverse. Any input (press, wheel, key, touch) lands it at once.
// 3. It ends still. The pointer moves the eye about 0.4 m sideways: near trees pass in front of far trees. A drag turns
//    the view. A click on the ground or on a light walks there; a ring on the ground shows the distance in metres.
// Reduced motion: the drop is a cut, no parallax.
import { mountPlace } from './place/mount.js';
import { current as accent, picker } from './accent.js';
import { loadPlaces, fmtLen, fmtOf } from '/js/v4/common.js';

const $ = (s, r = document) => r.querySelector(s);
const Q = new URLSearchParams(location.search);
const body = document.body, placeEl = $('#place'), still = $('#still');
const dropBtn = $('#drop'), upBtn = $('#up'), note = $('#note'), say = $('#say'), atEl = $('#at');
const P = await loadPlaces();
const place = P.byId[Q.get('map')] || P.byId.oak_161206;
const at = Q.has('at') && Number.isFinite(+Q.get('at')) ? +Q.get('at') : place.start_at_m;
if (Q.get('bare') === '1') document.body.classList.add('a-bare');      // TEST: the picture alone (the still)
const easeInOut = k => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

$('#name').textContent = place.name;
document.title = `${place.name}: concept A, Lift-off`;
$('#credit').textContent = place.credit_plain;
if (place.id !== 'oak_161206') { still.src = `/img/places/${place.id}.jpg`; still.alt = `Picture of the 3-D place: ${place.name}`; }
still.addEventListener('error', () => { still.src = `/img/places/${place.id}.jpg`; }, { once: true });

let handle = null;
const phase = p => {
  body.dataset.phase = p;
  for (const el of document.querySelectorAll('.o-phase')) el.hidden = el.dataset.show !== (p === 'loading' ? 'above' : p);
  upBtn.hidden = p !== 'ground';
};
const line = t => { say.textContent = t; say.hidden = !t; };
phase('loading');
line('');

function landed() {
  phase('ground');
  handle?.setYouLabel('You stand here');
  line('');
}

handle = await mountPlace(placeEl, {
  id: place.id, mode: 'full', at,
  stepLabel: 'Walk here',
  ribbon: { color: accent().path || accent().hex, rim: accent().pathRim || accent().rim },   // the camera's path
  engine: { startAbove: true, aboveEl: 46, shiftX: 0.1, ovMargin: 1.12, youLabel: 'You will stand here', dropMs: 1600, dolly: false, accent: accent().path || accent().hex, accentRim: accent().pathRim || accent().rim,
    pointsAbove: true, marks: false },   // F: the live site's view from above (points + the line, no metre marks)
  onEvent(type, d) {
    if (type === 'state') {
      note.hidden = d.state === 'live';
      note.textContent = d.state === 'loading' ? 'Getting the 3-D place ready' : d.text || '';
      if (d.state === 'live') { phase('above'); dropBtn.disabled = false; }
    }
    if (type === 'above') {
      if (d.on) { phase('above'); handle.setYouLabel('You will stand here'); }
      else phase('dropping');
    }
    if (type === 'landed' && !d.above) landed();
    if (type === 'pose' && d.total) atEl.textContent = fmtOf(d.at, d.total);
    if (type === 'first-look') line('You turned it yourself. A video cannot do that.');
    if (type === 'first-step' && body.dataset.phase === 'ground') line(`You walked ${fmtLen(d.moved)}. A video cannot do that either.`);
  },
});

dropBtn.addEventListener('click', () => { if (handle.live) handle.above(false); });
upBtn.addEventListener('click', () => { if (handle.live) handle.above(true); });

// TEST hook (cpu_shot): hold the drop at a moment u (0 = above, 1 = landed) for exact frames; end() lands it
window.__anim = {
  at(u) {
    if (body.dataset.phase === 'above') handle.above(false);
    handle.freeze(1 - easeInOut(Math.min(1, Math.max(0, u))));
    phase('dropping'); handle.setYouLabel('You will stand here');      // the page as it is during a real drop (a slow CPU frame may have ended it)
  },
  end() { handle.freeze(0); handle.freeze(null); handle.engine.lift.dropping = false; landed(); },
};

if (!new URLSearchParams(location.search).has('shot')) picker();   // the review bar (prototype only)
