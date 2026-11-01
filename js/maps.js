// Maps page: an atlas gallery.
//   1. The header is the atlas: every published map as an island in one dark 3-D world (the engine's mountAtlas).
//      Hovering or tapping an island (or its name) lifts it and shows its card; choosing it opens the viewer in
//      xclean's camera view. Until the atlas is up, and wherever it cannot run, the maps' posters stand in and a name
//      under the pointer brings its map behind the text.
//   2. The gallery: one plate per map (credit, licence and known limits always visible; the files folded away). On wide
//      screens a sticky view beside the list shows the map of the plate being read, cross-fading as you scroll, and
//      plays the map's film when the pointer rests on it; on phones each plate carries its own picture and film.
// Every fact comes from data/maps.json (+ its board route in data/board.json); nothing here runs on scroll events.
import { $, REDUCED, esc, fmtInt, fmtLen, fmtMB, getJSON, idle, keepScroll, restoreScroll } from './site.js';
import { asset } from './config.js';
import { mountAtlas } from './world/api.js';

keepScroll();   // back/forward and reload land where the visitor left, once the gallery is built (site.js)
const [M, B] = await Promise.all([getJSON('data/maps.json'), getJSON('data/board.json').catch(() => null)]);
const byId = Object.fromEntries(M.maps.map(m => [m.id, m]));
const num = id => String(M.maps.findIndex(m => m.id === id) + 1).padStart(2, '0');
const fly = id => `viewer.html?map=${encodeURIComponent(id)}&cam=pov`;
const route = id => B?.rows.find(r => r.route === id);
const FINE = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
const WIDE = window.matchMedia('(min-width: 1100px)');
const SAVE = navigator.connection?.saveData === true;
const CC_BY = 'https://creativecommons.org/licenses/by/4.0/';
const ROSARIO = 'The Rosario Dataset, CIFASIS-CONICET, CC BY 4.0';
const S = { mode: 'poster', focus: null, current: null };
window.__maps = { info: () => ({ ...S }) };

// ---------------------------------------------------------------- plate text (every verdict code of data/board.json)
function statusText(st) {
  if (!st) return '';
  let m = st.match(/^div (\d+)\/(\d+)$/); if (m) return `diverged in ${m[1]} of ${m[2]} runs`;
  m = st.match(/^lost (\d+)\/(\d+)$/); if (m) return `lost tracking in ${m[1]} of ${m[2]} runs`;
  return st === 'partial span' ? 'trajectory covers only part of the route' : st;
}
const SETS = { design: 'design route, used during development', k12: 'seen once by an earlier kill test', k13: 'seen once by an earlier kill test', k14: 'seen once by the last kill test', unseen: 'unseen route', sealed: 'unseen route' };
function verdictText(v, st) {
  return { win: 'xclean better', tie: 'a tie', loss: 'ORB-SLAM3 better', both_lost: 'both lost the route',
    win_forfeit: `xclean, by forfeit (ORB-SLAM3 ${statusText(st)})`, loss_forfeit: 'ORB-SLAM3, by forfeit (xclean lost tracking)' }[v] || v;
}
const f3 = x => (x < 10 ? x.toFixed(3) : x.toFixed(2));
const dur = s => `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')} s`;
const licText = m => `${m.map_licence}${m.own_data ? ' · own data' : ' · Rosario Dataset'}`;
const behind = m => `${esc(m.title)} (${esc(m.id)}), rendered from the map. ${m.own_data ? 'Our own recording.' : `Source images: ${esc(ROSARIO)}.`}`;

function plate(m, i) {
  const s = m.stats, r = m.board_route ? route(m.board_route) : null, name = `${esc(m.title)}, ${esc(m.id)}`;
  const files = [
    ['Standard splats', 'splats.spz', 'the viewer\'s default'],
    ['Lite splats', 'splats_lite.spz', 'phones, quick look'],
    ['Full resolution', 'full/splats.ply', 'PLY, every Gaussian'],
    ['Point cloud', 'points.bin', 'stereo depth of the keyframes'],
    ['Film', m.film.mp4, `${m.film.duration_s} s, MP4`],
  ].filter(f => m.files[f[1]]);
  let board = '';
  if (r?.gt && r.ours) {
    board = `<p class="board"><span class="label">Board ATE</span> xclean ${f3(r.ours.med)} m, ORB-SLAM3 ${f3(r.orb3.med)} m${r.orb3.status ? ` (ORB-SLAM3 ${esc(statusText(r.orb3.status))})` : ''} on this route: <a href="results.html#r-${esc(r.route)}">${esc(verdictText(r.vs_orb3, r.orb3.status))}<span class="sr">: the ${esc(r.route)} row of the results</span></a>${SETS[r.group] ? ` <span class="rng">(${esc(SETS[r.group])})</span>` : ''}${r.orb3.stereo_only && r.orb3.stereo_only === r.orb3.draws ? '. ORB-SLAM3 ran stereo-only here: its IMU start-up crashed.' : ''}</p>`;
  } else if (r) {
    board = `<p class="board"><span class="label">Board</span> No ground truth: latency ${r.lat_ms_p50.toFixed(1)} ms median, ${r.lost_runs} of ${r.runs} runs lost. <a href="results.html#r-${esc(r.route)}">Its row<span class="sr"> (${esc(r.route)})</span></a></p>`;
  }
  return `<article class="mplate" id="${esc(m.id)}" data-id="${esc(m.id)}" aria-labelledby="h-${esc(m.id)}">
    <figure class="mp-fig">
      <a class="plate frame" href="${fly(m.id)}" aria-label="Fly ${name} in 3-D">
        <img src="img/maps/${esc(m.id)}.webp" alt="${esc(m.title)}: a frame rendered from the map along xclean's trajectory" width="1280" height="800" loading="lazy" decoding="async">
      </a>
      <figcaption><b>Plate ${i + 1}</b> ${esc(m.id)}, rendered from the map. A reconstruction, not camera video.</figcaption>
    </figure>
    <p class="label">Plate ${i + 1} · ${esc(m.id)}</p>
    <h2 id="h-${esc(m.id)}">${esc(m.title)}</h2>
    <p class="cat">${esc(m.platform)} · ${esc(m.place)} · ${fmtLen(s.path_m)} · ${dur(s.duration_s)}</p>
    <div class="btns"><a class="btn btn--ion" href="${fly(m.id)}">Fly it in 3-D<span class="sr">: ${name}</span> <span class="arr" aria-hidden="true">→</span></a>
      <button class="btn js-film" type="button" data-id="${esc(m.id)}">Watch the film<span class="sr"> of ${name}</span></button>
      <span class="lic">${esc(licText(m))}</span></div>
    <p class="stats">${fmtInt(s.keyframes)} keyframes (xclean's live poses) · ${(s.gaussians / 1e6).toFixed(2)} M Gaussians full, ${(s.gaussians_lite / 1e6).toFixed(2)} M lite · ${fmtInt(s.points)} points from stereo depth · ground truth: ${s.has_gt ? 'yes, shown in the viewer for comparison' : 'none for this route'}</p>
    ${board}
    <div class="disclose lim" id="lim-${esc(m.id)}"><h3>Known limits</h3><p>${esc(m.limitation)}</p></div>
    <p class="credit"><strong>Credit.</strong> ${esc(m.credit)}</p>
    <details class="files"><summary>Licence, source and files<span class="sr"> of ${name}</span></summary>
      <dl class="kv">
        <dt>Map licence</dt><dd><a href="${CC_BY}">${esc(m.map_licence)}</a></dd>
        <dt>Source</dt><dd>${esc(m.source)}${m.own_data ? '' : ` (${esc(m.source_licence)})`}</dd>
      </dl>
      <div class="table-wrap"><table class="t"><thead><tr><th>File</th><th>Use</th><th class="num">Size</th></tr></thead><tbody>
        ${files.map(f => `<tr><td><a href="${asset(m.id, f[1])}">${esc(f[0])}<span class="sr"> of ${esc(m.id)}</span></a></td><td>${esc(f[2])}</td><td class="num">${fmtMB(m.files[f[1]])}</td></tr>`).join('')}
      </tbody></table></div>
    </details>
  </article>`;
}
$('.js-plates').innerHTML = M.maps.map(plate).join('');

// ---------------------------------------------------------------- films (the map flown along xclean's route, 12 s)
const probe = document.createElement('video');
const AV1 = probe.canPlayType(M.maps[0]?.film.webm_type || '') === 'probably';
function filmSources(v, m) {
  v.poster = `img/maps/${m.id}.webp`;
  v.innerHTML = `${AV1 && m.film.webm ? `<source src="${asset(m.id, m.film.webm)}" type='${m.film.webm_type}'>` : ''}<source src="${asset(m.id, m.film.mp4)}" type='${m.film.mp4_type}'>`;
  v.load();
}

// ---------------------------------------------------------------- the header: atlas, posters, names, card
const head = $('.mx-head'), posters = $('.mx-posters'), card = $('.js-card'), stageEl = $('.mx-atlas'), credit = $('.js-credit');
const chips = [...document.querySelectorAll('.mx-chip')];
const WIDEHEAD = window.matchMedia('(min-width: 1200px)');   // the header's two-column layout (css/pages.css)
let atlas = null;

// the one credit line over the atlas: the Rosario credit while islands show (Rosario islands are always among them), or
// the Rosario poster's credit while a Rosario poster stands in; the full caption and the note sit with the words
function setCredit() {
  const t = S.mode !== 'poster' ? `Rosario islands: ${ROSARIO}` : byId[posterAt] && !byId[posterAt].own_data ? `Behind: ${posterAt}, rendered from the map. Source images: ${ROSARIO}` : '';
  if (credit.textContent !== t) credit.textContent = t;
}

// where an island was last seen under the pointer (viewport px), so the card can stand clear of it; the engine may also
// report it (atlas.where, when it offers one)
const seenAt = {};
let ptr = null;
stageEl.addEventListener('pointermove', e => { ptr = [e.clientX, e.clientY]; }, { passive: true });
stageEl.addEventListener('pointerdown', e => { ptr = [e.clientX, e.clientY]; }, { passive: true });
/** Put the (shown) card where it leaves the island it describes in sight: at the foot or the top of the atlas, and on the
 *  stacked layout's wide atlas (tablets) on its right or left side. A few box reads on a hover or tap, never per frame. */
function placeCard(id) {
  const r = stageEl.getBoundingClientRect(), w = atlas?.where?.(id);
  const p = w && Number.isFinite(w.x) && Number.isFinite(w.y) ? [r.left + w.x, r.top + w.y] : seenAt[id];
  const opts = WIDEHEAD.matches || r.width < 760 ? [['bottom', 'right'], ['top', 'right']]
    : [['bottom', 'right'], ['top', 'right'], ['bottom', 'left'], ['top', 'left']];
  let best = opts[0], far = -1;
  if (p) for (const o of opts) {
    [card.dataset.at, card.dataset.side] = o;
    const b = card.getBoundingClientRect();
    const d = Math.hypot(Math.max(b.left - p[0], 0, p[0] - b.right), Math.max(b.top - p[1], 0, p[1] - b.bottom));
    if (d > 40) { best = o; break; }
    if (d > far) { far = d; best = o; }
  }
  [card.dataset.at, card.dataset.side] = best;
}

function showCard(id) {
  const m = byId[id];
  if (!m) { card.hidden = true; return; }
  const s = m.stats, behindOn = S.mode === 'live' && WIDEHEAD.matches;   // not over the 2-D atlas's drawn names
  const own = `3-D map by Necessity Robotics (xclean), ${esc(m.map_licence)}. Our own recording.`;
  const ros = `Source images: ${esc(ROSARIO)}. Map ${esc(m.map_licence)}.`;
  card.innerHTML = `<button class="mx-card-x" type="button" aria-label="Close the card">×</button>
    <p class="label">${num(id)} / ${String(M.maps.length).padStart(2, '0')} · ${esc(m.place)}</p>
    <p class="mx-card-t">${esc(m.title)} <span class="mono">${esc(m.id)}</span></p>
    <p class="mx-card-m"><span class="mx-card-pl">${esc(m.place)} · </span>${esc(m.platform)} · ${fmtLen(s.path_m)} · ${dur(s.duration_s)} · ${fmtInt(s.keyframes)} keyframes</p>
    <p class="mx-card-c">${behindOn ? 'Behind the islands: a frame rendered from this map, not camera video. ' : ''}${m.own_data ? own : ros}</p>
    <div class="btns"><a class="btn btn--ion" href="${fly(id)}">Ride it in xclean's view<span class="sr">: ${esc(m.title)}, ${esc(m.id)}</span> <span class="arr" aria-hidden="true">→</span></a>
      <a class="btn" href="#lim-${esc(id)}">Its limits<span class="sr"> (${esc(m.id)})</span></a><span class="lic">${esc(licText(m))}</span></div>`;
  card.hidden = false;
  placeCard(id);
  card.dataset.id = id;
  card.querySelector('.mx-card-x').onclick = () => closeCard();
  // the 3-D atlas up (wide layout): the card's map comes in behind the islands
  if (behindOn) { showPoster(id); head.dataset.behind = ''; }
}
let quietFocus = false;   // focus handed back to a name by closeCard() must not open the card again
function closeCard() {
  if (card.hidden) return false;
  const back = card.contains(document.activeElement) ? chips.find(c => c.dataset.id === card.dataset.id) : null;
  card.hidden = true; S.focus = null; atlas?.focus(null); focusChip(null);
  delete head.dataset.behind;
  onCard = false;
  if (back) { quietFocus = true; back.focus({ preventScroll: true }); quietFocus = false; }
  return true;
}
// the pointer on the card: the islands it covers must not take the card over (the engine follows the pointer anywhere
// inside the atlas's box, the card included)
let onCard = false;
card.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') onCard = true; });
card.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') onCard = false; });
addEventListener('keydown', e => { if (e.key === 'Escape' && closeCard()) e.preventDefault(); });
function focusChip(id) { chips.forEach(c => c.classList.toggle('is-on', c.dataset.id === id)); }

// poster stand-in: the outgoing map fades to black before the caption and the incoming map change, so a caption never
// names a map that is not the one behind it (and a Rosario poster is never on screen without its credit; FA-9)
let posterAt = 'oak_161834', posterT = 0;
function showPoster(id) {
  if (id === posterAt || !byId[id]) return;
  posterAt = id;
  let im = posters.querySelector(`img[data-id="${id}"]`);
  if (!im) {
    im = new Image(1280, 800);
    im.alt = ''; im.decoding = 'async'; im.dataset.id = id;
    im.src = `img/maps/${id}.webp`;
    posters.appendChild(im);
  }
  clearTimeout(posterT);
  posters.querySelectorAll('img.on').forEach(x => x.classList.remove('on'));
  const swap = () => {
    if (posterAt !== id) return;
    posterT = setTimeout(() => { $('.js-cap-t').innerHTML = behind(byId[id]); setCredit(); im.classList.add('on'); }, REDUCED ? 0 : 320);
  };
  im.decode().then(swap, swap);
}

function hoverMap(id, why) {
  S.focus = id;
  focusChip(id);
  if (id) showCard(id);
  if (S.mode === 'poster' && id) { stopCycle(); showPoster(id); }
  if (atlas && why !== 'atlas') atlas.focus(id);
}
let onChips = false;   // the pointer is on the names: the atlas's own "no island under the pointer" must not clear them
chips.forEach(c => {
  c.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') hoverMap(c.dataset.id, 'chip'); });
  c.addEventListener('focus', () => { if (!quietFocus) hoverMap(c.dataset.id, 'chip'); });
});
$('.mx-chips').addEventListener('pointerenter', e => { onChips = e.pointerType === 'mouse'; });
$('.mx-chips').addEventListener('pointerleave', e => { onChips = false; if (e.pointerType === 'mouse' && atlas) atlas.focus(null); });

// the stand-in cycles through the maps (every 7 s, only while the header is on screen) until a name is chosen
let cycleT = 0, headOn = true;
function stopCycle() { clearInterval(cycleT); cycleT = 0; }
if (!REDUCED) {
  new IntersectionObserver(es => { headOn = es[0].isIntersecting; }).observe(head);
  cycleT = setInterval(() => {
    if (!headOn || document.hidden || S.mode !== 'poster') return;
    const i = M.maps.findIndex(m => m.id === posterAt);
    showPoster(M.maps[(i + 1) % M.maps.length].id);
  }, 7000);
}

// the atlas: after the first paint, from the engine (which picks live 3-D or its 2-D atlas for this device)
let selectAt = -1e9;
setCredit();
idle(async () => {
  try {
    const at = await getJSON('data/atlas.json');
    atlas = await mountAtlas($('.mx-atlas'), {
      maps: M, atlas: at, interactive: true, initial: null,
      shift: WIDEHEAD.matches ? 0.6 : 0.5,   // wide: the islands' middle right of the words; stacked: centred
      still: REDUCED || SAVE,
      onSelect: (id, info = {}) => {
        if (onCard) return;
        if (!id || info.why === 'clear') { if (!onChips) { S.focus = null; focusChip(null); } return; }
        if (ptr) seenAt[id] = ptr;
        selectAt = performance.now();
        hoverMap(id, 'atlas');
      },
      onDive: (id, info = {}) => { location.href = fly(id) + (Number.isFinite(info.t) ? `&t=${info.t.toFixed(1)}` : ''); },
    });
    S.mode = atlas.mode;
    stopCycle();
    head.dataset.atlas = atlas.mode;
    setCredit();
    if (S.focus) { atlas.focus(S.focus); showCard(S.focus); }
    // a tap or click on the atlas that lifts no island puts the card away (the engine reports picks before the click)
    stageEl.addEventListener('click', () => { if (performance.now() - selectAt > 300) closeCard(); });
  } catch (e) {
    console.warn('[maps] atlas unavailable, posters stay', e);
  }
}, 600);

// ---------------------------------------------------------------- the gallery's sticky view (wide screens)
const view = $('.js-view'), vimgs = $('.js-view-imgs'), vfilm = $('.js-view-film');
let filmT = 0, vt = 0, overPic = false;
function setCurrent(id) {
  if (!WIDE.matches || id === S.current || !byId[id]) return;
  const m = byId[id];
  S.current = id;
  stopFilm(true);
  if (overPic) filmT = setTimeout(playFilm, 400);   // the pointer rests on the view while the plate changes
  view.hidden = false;
  $('.js-view-a').href = fly(id);
  $('.js-view-name').textContent = `Fly ${m.title}, ${m.id} in 3-D`;
  let im = vimgs.querySelector(`img[data-id="${id}"]`);
  if (!im) {
    im = new Image(1280, 800);
    im.alt = ''; im.decoding = 'async'; im.dataset.id = id;
    im.src = `img/maps/${id}.webp`;
    vimgs.appendChild(im);
  }
  document.querySelectorAll('.mplate').forEach(p => p.classList.toggle('is-current', p.dataset.id === id));
  vimgs.querySelectorAll('img.on').forEach(x => x.classList.remove('on'));
  clearTimeout(vt);
  const swap = () => {
    if (S.current !== id) return;
    vt = setTimeout(() => {
      $('.js-view-cap').innerHTML = `<b>Plate ${Number(num(id))}</b> ${behind(m)} A reconstruction, not camera video.`;
      im.classList.add('on');
    }, REDUCED ? 0 : 220);
  };
  im.decode().then(swap, swap);
}
function playFilm() {
  const m = byId[S.current];
  if (!m || SAVE) return;
  if (!vfilm.dataset.id || vfilm.dataset.id !== m.id) { vfilm.dataset.id = m.id; filmSources(vfilm, m); }
  vfilm.play().catch(() => {});
}
function stopFilm(unload = false) {
  clearTimeout(filmT);
  view.classList.remove('is-film');
  vfilm.pause();
  if (unload && vfilm.dataset.id) { delete vfilm.dataset.id; vfilm.removeAttribute('poster'); vfilm.innerHTML = ''; vfilm.load(); }
}
vfilm.addEventListener('playing', () => view.classList.add('is-film'));
if (FINE && !REDUCED) {
  const pic = $('.js-view-a');
  pic.addEventListener('pointerenter', () => { overPic = true; clearTimeout(filmT); filmT = setTimeout(playFilm, 400); });
  pic.addEventListener('pointerleave', () => { overPic = false; stopFilm(); });
}

// the plate being read: the one crossing a band just above the middle of the screen (and, with a mouse, the one under it)
const plates = [...document.querySelectorAll('.mplate')];
let reading = null;   // the plate crossing the band, at every width
const band = new IntersectionObserver(es => {
  for (const e of es) {
    if (e.isIntersecting) { reading = e.target.dataset.id; if (WIDE.matches) setCurrent(reading); }
    else if (reading === e.target.dataset.id) reading = null;
  }
}, { rootMargin: '-42% 0px -52% 0px' });
plates.forEach(p => band.observe(p));
const watch = () => { if (WIDE.matches) setCurrent(S.current || reading || plates[0]?.dataset.id); else { stopFilm(true); view.hidden = true; S.current = null; } };
// crossing the wide layout (a tablet turned, a window resized) changes every plate's height: keep the plate being read
WIDE.addEventListener('change', () => {
  const keep = reading;
  watch();
  if (keep) requestAnimationFrame(() => document.getElementById(keep)?.scrollIntoView({ block: 'start' }));
});
watch();
if (FINE) plates.forEach(p => p.addEventListener('pointerenter', () => setCurrent(p.dataset.id)));

// "Watch the film": in the sticky view on wide screens, in the plate itself on phones and tablets
document.querySelector('.js-plates').addEventListener('click', e => {
  const b = e.target.closest('.js-film');
  if (!b) return;
  const m = byId[b.dataset.id];
  if (WIDE.matches) { setCurrent(m.id); playFilm(); return; }
  const fig = b.closest('.mplate').querySelector('.mp-fig');
  let v = fig.querySelector('video');
  if (!v) {
    v = document.createElement('video');
    v.className = 'plate frame';
    v.muted = true; v.loop = true; v.playsInline = true; v.controls = true; v.preload = 'none';
    filmSources(v, m);
    fig.querySelector('.plate').replaceWith(v);
  }
  v.play().catch(() => {});
});

// ---------------------------------------------------------------- deep links: #<id> (a plate) or #lim-<id> (its limits)
function landHash() {
  const el = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)));
  if (!el) return;
  el.scrollIntoView({ block: 'start' });
  if (el.classList.contains('lim') && !REDUCED) { el.classList.remove('pulse'); requestAnimationFrame(() => el.classList.add('pulse')); }
}
if (!restoreScroll()) landHash();
addEventListener('hashchange', landHash);
