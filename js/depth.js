// The depth page (2026-11-12): 1. the split slider (classic SGM32 depth | AI depth nrs-large, or photo | AI depth),
// route and photo pickers, from data/depth.json;  2. the 3-D pair: the same place built with each depth, one view.
// Nothing moves by itself (R1). The 3-D pair loads only on "Open both in 3-D" (two 3-D files; a phone shows one at a time).
// The home page uses part 1 too (index.html #ai: a stage with data-route and no pickers).
const $ = (s, r = document) => r.querySelector(s);
const pct = n => Math.max(0, Math.min(100, n));

async function json(url) { const r = await fetch(url); if (!r.ok) throw new Error(url); return r.json(); }
// ?map=<id>: open both comparisons on that place (the floating trajectories link here: depth.html?map=<id>#dm-cmp)
const QMAP = new URLSearchParams(location.search).get('map');

// ------------------------------------------------------------------ 1. the split slider
function slider(stage, handle, onMove) {
  let cut = 50, drag = false;
  const set = v => { cut = pct(v); stage.style.setProperty('--cut', cut + '%'); handle?.setAttribute('aria-valuenow', String(Math.round(cut))); onMove?.(cut); };
  const at = e => { const r = stage.getBoundingClientRect(); return (e.clientX - r.left) / r.width * 100; };
  stage.addEventListener('pointerdown', e => { if (e.button !== 0 || e.target.closest('button,a')) return; drag = true; stage.setPointerCapture(e.pointerId); set(at(e)); });
  stage.addEventListener('pointermove', e => { if (drag) set(at(e)); });
  const end = () => { drag = false; };
  stage.addEventListener('pointerup', end); stage.addEventListener('pointercancel', end);
  handle?.addEventListener('keydown', e => {
    const k = { ArrowLeft: -5, ArrowRight: 5, PageDown: -20, PageUp: 20 }[e.key];
    if (k) { set(cut + k); e.preventDefault(); } else if (e.key === 'Home') { set(0); e.preventDefault(); } else if (e.key === 'End') { set(100); e.preventDefault(); }
  });
  set(50);
  return { set };
}

function percent(x) { return `${Math.round(x * 100)} %`; }

async function comparer() {
  const root = $('#dm-cmp');
  if (!root) return;
  const [D, P] = await Promise.all([json('data/depth.json'), json('data/places.json')]);
  const names = Object.fromEntries(P.places.map(p => [p.id, p.short || p.name]));
  const ids = P.places.map(p => p.id).filter(id => D.routes[id]);
  const A = $('#dm-a'), B = $('#dm-b'), PH = $('#dm-photo'), tagA = $('#dm-tag-a'), stat = $('#dm-stat');
  const routesEl = $('#dm-routes'), thumbsEl = $('#dm-thumbs'), photoBtn = $('#dm-photo-btn');
  let route = QMAP && D.routes[QMAP] ? QMAP : root.dataset.route && D.routes[root.dataset.route] ? root.dataset.route : ids[0], k = 0, photo = false;
  slider($('#dm-stage'), $('#dm-handle'));

  function show() {
    const R = D.routes[route], pic = R.pictures[k];
    A.src = pic.file_sgm; B.src = pic.file_nrs; PH.src = pic.file_photo;
    A.alt = `Depth from the classic method (32-path SGM), ${names[route]}`;
    B.alt = `Depth from our ML model (nrs-large), ${names[route]}`;
    PH.alt = `The camera's photo, ${names[route]}`;
    PH.hidden = !photo; tagA.textContent = photo ? 'Camera photo' : 'Classic: 32-path SGM';
    stat.textContent = `Classic method: an answer for ${percent(pic.sgm_answered)} of the pixels. ML model: ${percent(pic.nrs_answered)}.` +
      (pic.agree_1px != null ? ` Where both answer, they agree within one pixel on ${percent(pic.agree_1px)} of them.` : '');
    routesEl.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.id === route)));
    thumbsEl.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(i === k)));
  }
  function thumbs() {
    thumbsEl.textContent = '';
    D.routes[route].pictures.forEach((pic, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-label', `Photo ${i + 1} of ${D.routes[route].pictures.length} along the path`);
      b.innerHTML = `<img src="${pic.file_photo}" alt="" width="160" height="100" loading="lazy" decoding="async">`;
      b.addEventListener('click', () => { k = i; show(); });
      thumbsEl.appendChild(b);
    });
  }
  ids.forEach(id => {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.id = id; b.textContent = names[id];
    b.addEventListener('click', () => { route = id; k = 0; thumbs(); show(); });
    routesEl.appendChild(b);
  });
  photoBtn.addEventListener('click', () => { photo = !photo; photoBtn.setAttribute('aria-pressed', String(photo)); photoBtn.textContent = photo ? 'Show classic depth' : 'Show the photo'; show(); });
  thumbs(); show();
}

// the home page block: one fixed picture pair, the slider only
function homeBlock() {
  const st = $('#h4-ai-stage');
  if (st) slider(st, $('#h4-ai-handle'));
}

// ------------------------------------------------------------------ 2. the 3-D pair
const COPY = ['at', 'off', 'offRaw', 'yaw', 'tyaw', 'pitch', 'tpitch', 'facing'];
const WIDE = matchMedia('(min-width: 900px)');

async function pair() {
  const root = $('#dm-pair');
  if (!root) return;
  const P = await json('data/places.json');
  const D = await json('data/depth.json').catch(() => ({ routes: {} }));
  const names = Object.fromEntries(P.places.map(p => [p.id, p.short || p.name]));
  const byId = Object.fromEntries(P.places.map(p => [p.id, p]));
  const ids = P.places.map(p => p.id).filter(id => D.routes[id] || id === root.dataset.place);
  const panes = [...root.querySelectorAll('.dm-pane')];
  const frames = panes.map(p => p.querySelector('.dm-frame'));
  const routesEl = $('#dm-pair-routes'), sw = $('#dm-switch'), go = $('#dm-go');
  let id = root.dataset.place, H = [null, null], lead = 1, show = 'maps', mod = null, syncing = false;
  root.dataset.show = show;

  function stills() {
    frames[0].querySelector('.pl-still').src = `img/depth/sgm32/${id}.jpg`;
    frames[1].querySelector('.pl-still').src = byId[id].still;
    frames.forEach(f => { f.querySelector('.pl-still').dataset.place = id; });
  }
  function state(h) { const e = h?.engine; return e && e.S ? e : null; }
  function copy(from, to) {
    const a = state(from), b = state(to);
    if (!a || !b || syncing) return;
    syncing = true;
    for (const k of COPY) b.S[k] = a.S[k];
    b.S.tw = null; b.S.riding = false;
    const A = a.S.above, B = b.S.above;
    for (const k of ['on', 'k', 'az', 'el', 'zoom', 'taz', 'tel']) B[k] = A[k];
    B.tw = null;
    b.stage?.invalidate();
    syncing = false;
  }
  function setLead(i) {
    lead = i;
    H.forEach((h, j) => h?.keys(j === i));
  }
  async function mount(i, start) {
    const folder = panes[i].dataset.folder;
    const h = await mod.mountPlace(frames[i], {
      id, mode: 'full', q: 'lite', folder, at: start,
      onEvent: (t) => { if (t === 'pose' && i === lead) copy(H[i], H[1 - i]); },
    });
    frames[i].addEventListener('pointerdown', () => setLead(i), { capture: true });
    frames[i].addEventListener('focusin', () => setLead(i));
    return h;
  }
  function destroy() { H.forEach(h => h?.destroy()); H = [null, null]; root.removeAttribute('data-live'); }
  async function open() {
    mod = mod || await import('./place/mount.js');
    destroy();
    root.dataset.live = '1';
    const start = byId[id].start_at_m;
    if (WIDE.matches) { H = await Promise.all([mount(0, start), mount(1, start)]); setLead(1); }
    else { const i = show === 'maps' ? 1 : 0; H[i] = await mount(i, start); setLead(i); }
  }
  ids.forEach(pid => {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.id = pid; b.textContent = names[pid];
    b.setAttribute('aria-pressed', String(pid === id));
    b.addEventListener('click', () => {
      if (pid === id) return;
      const live = !!root.dataset.live;
      destroy(); id = pid; root.dataset.place = id; stills();
      routesEl.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.id === id)));
      if (live) open();
    });
    routesEl.appendChild(b);
  });
  // phones: one view at a time; the switch keeps the spot and the view direction
  sw.querySelectorAll('button').forEach(b => b.addEventListener('click', async () => {
    const want = b.dataset.folder;
    if (want === show) return;
    show = want; root.dataset.show = show;
    sw.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.folder === show)));
    if (!root.dataset.live || WIDE.matches) return;
    const from = H.find(Boolean), i = show === 'maps' ? 1 : 0;
    const keep = state(from) ? { ...state(from).S, above: { ...state(from).S.above } } : null;
    const at = from?.at ?? byId[id].start_at_m;
    from?.destroy(); H = [null, null];
    H[i] = await mount(i, at); setLead(i);
    if (keep) {
      const wait = () => state(H[i])?.live ? (Object.assign(state(H[i]).S, Object.fromEntries(COPY.map(k => [k, keep[k]]))), state(H[i]).stage?.invalidate()) : setTimeout(wait, 120);
      wait();
    }
  }));
  go.addEventListener('click', open);
  stills();
  // test hook: both views' spot and look (the CPU tests compare them)
  window.__dmState = () => H.map(h => { const e = state(h); return e ? { at: +e.S.at.toFixed(2), yaw: +e.S.yaw.toFixed(3), pitch: +e.S.pitch.toFixed(3), live: !!e.live, folder: e.folder } : null; });
}

// ------------------------------------------------------------------ 3. seen from the same spot (held-out triptychs)
// All four held-out views of every place (data/map_pairs.json); the visitor picks the place and the view. No picking by us.
async function sameSpot() {
  const root = $('#dm-same');
  if (!root) return;
  const [M, P] = await Promise.all([json('data/map_pairs.json'), json('data/places.json')]);
  const names = Object.fromEntries(P.places.map(p => [p.id, p.short || p.name]));
  const ids = P.places.map(p => p.id).filter(id => M.places[id]?.length);
  const img = $('#dm-same-img'), views = $('#dm-same-views'), stat = $('#dm-same-stat'), routes = $('#dm-same-routes');
  let id = ids.includes(QMAP) ? QMAP : ids[0], k = 0;
  const show = () => {
    const v = M.places[id][k];
    img.src = v.file;
    img.alt = `${names[id]}, photo ${k + 1} of ${M.places[id].length}: the camera photo, the 3-D place with the classic depth, and the 3-D place with the ML depth, from the same spot`;
    const d = v.psnr_nrs - v.psnr_sgm32;
    stat.textContent = `How close to the photo: classic depth ${v.psnr_sgm32.toFixed(2)} dB, ML depth ${v.psnr_nrs.toFixed(2)} dB (${d >= 0 ? 'ML closer' : 'classic closer'}).`;
    routes.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.id === id)));
    views.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(i === k)));
  };
  const viewButtons = () => {
    views.textContent = '';
    M.places[id].forEach((v, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = String(i + 1);
      b.setAttribute('aria-label', `Photo ${i + 1} of ${M.places[id].length}`);
      b.addEventListener('click', () => { k = i; show(); });
      views.appendChild(b);
    });
  };
  for (const pid of ids) {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.id = pid; b.textContent = names[pid];
    b.addEventListener('click', () => { id = pid; k = 0; viewButtons(); show(); });
    routes.appendChild(b);
  }
  viewButtons(); show();
}

comparer().catch(e => console.warn('[depth] comparer', e));
sameSpot().catch(e => console.warn('[depth] same', e));
homeBlock();
pair().catch(e => console.warn('[depth] pair', e));
