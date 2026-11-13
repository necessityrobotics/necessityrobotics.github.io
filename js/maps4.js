// "3-D places" page (maps.html), site v4. The page is static HTML: the 8 cards (generated fragment), the two notes and
// one sheet per place under "Where it is not perfect". This script adds only what needs a script:
//   1. the sheets follow data/places.json: same order, and a place that has no static sheet yet gets one;
//   2. each closed "For engineers" block gets the technical facts the old maps page showed (data/maps.json and the
//      place's row of data/board.json): id, platform, numbers, pose source, the known limits in full, the board
//      result with its links and the K14 caveat, licence, source, credit, the files.
// The route doors on the cards are wired by js/v4/route-door.js (loaded by the page). Nothing here moves by itself.
// No atlas, no film, no code as a label: technical words stay inside the closed blocks.
import { esc, fmtLen, getJSON, loadPlaces } from './v4/common.js';
import { initRouteDoors } from './v4/route-door.js';
import { LINKS, asset } from './config.js';

const CC_BY = 'https://creativecommons.org/licenses/by/4.0/';
const S = { ready: false, places: 0, eng: 0, added: [], moved: false, error: null };
window.__places4 = S;                                  // test aid

// ------------------------------------------------------------------ small formatters (same rules as the old page)
const fmtInt = (x) => { if (x == null) return '—'; const [i, f] = String(x).split('.'); return i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? `.${f}` : ''); };
function fmtMB(b) { if (!Number.isFinite(b)) return '—'; const mb = b / 1e6; return mb >= 100 ? `${mb.toFixed(0)} MB` : mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`; }
const f3 = (x) => (x < 10 ? x.toFixed(3) : x.toFixed(2));
const dur = (s) => `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')} s`;
// every verdict code of data/board.json
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

// ------------------------------------------------------------------ one sheet (only for a place without a static one)
function sheetHTML(p) {
  const id = esc(p.id), href = `explore.html?map=${encodeURIComponent(p.id)}`;
  return `<article class="pl-item" id="${id}" aria-labelledby="pl-h-${id}">
    <a class="pl-pic" href="${href}" tabindex="-1" aria-hidden="true"><img src="${esc(p.still)}" alt="" width="1280" height="800" loading="lazy" decoding="async"></a>
    <div class="pl-head"><h3 class="pl-name" id="pl-h-${id}">${esc(p.name)}</h3><p class="pl-kind">${esc(p.kind)}</p></div>
    <div class="pl-body">
      <p class="pl-lim" id="lim-${id}"><b class="pl-lim-h">Where it is not perfect</b> ${esc(p.limits_plain)}</p>
      <p class="v4-credit">${esc(p.credit_plain)}</p>
      <div class="pl-acts"><a class="btn btn--ion" href="${href}"><span>Walk in<span class="v4-sr">: ${esc(p.name)}</span></span> <span class="arr" aria-hidden="true">&rarr;</span></a></div>
      <details class="pl-eng" data-eng="${id}"><summary>For engineers<span class="v4-sr">: the technical facts of this place (${esc(p.name)})</span></summary><div class="pl-eng-in"></div></details>
    </div>
  </article>`;
}

// ------------------------------------------------------------------ the engineer facts of one place
function boardHTML(m, B) {
  const caveat = ' The board numbers come from an engine frozen with its last pre-registered kill test (K14) failed on two routes; <a href="results.html#disclosures">details</a>.';
  if (!B) return 'The board file did not load. <a href="results.html#routes">Every route is on the results page</a>.';
  const r = m.board_route ? B.rows.find((x) => x.route === m.board_route) : null;
  if (!r) return 'This place has no row on the board.';
  const row = `results.html#r-${encodeURIComponent(r.route)}`;
  if (r.gt && r.ours && r.orb3) {
    return `ATE: xclean ${f3(r.ours.med)} m, ORB-SLAM3 ${f3(r.orb3.med)} m${r.orb3.status ? ` (ORB-SLAM3 ${esc(statusText(r.orb3.status))})` : ''} on this route: `
      + `<a href="${row}">${esc(verdictText(r.vs_orb3, r.orb3.status))}<span class="v4-sr">: the ${esc(r.route)} row of the results</span></a>`
      + `${SETS[r.group] ? ` <span class="rng">(${esc(SETS[r.group])})</span>` : ''}`
      + `${r.orb3.stereo_only && r.orb3.stereo_only === r.orb3.draws ? '. ORB-SLAM3 ran stereo-only here: its IMU start-up crashed' : ''}.${caveat}`;
  }
  return `No ground truth: latency ${r.lat_ms_p50.toFixed(1)} ms median, ${r.lost_runs} of ${r.runs} runs lost. `
    + `<a href="${row}">Its row<span class="v4-sr"> (${esc(r.route)})</span></a>.${caveat}`;
}

function engHTML(p, B) {
  const m = p.map, s = m.stats;
  const files = [
    ['Standard splats', 'splats.spz', 'SPZ'],
    ['Lite splats', 'splats_lite.spz', 'SPZ, for phones and a quick look'],
    ['Full resolution', 'full/splats.ply', 'PLY, every Gaussian'],
    ['Point cloud', 'points.bin', 'stereo depth of the keyframes'],
  ].filter((f) => m.files && m.files[f[1]]);
  const other = m.board_route && m.board_route !== m.id ? ` · board route <span class="mono">${esc(m.board_route)}</span>` : '';
  return `<p class="pl-eng-id"><span class="mono">${esc(m.id)}</span> · ${esc(m.title)}${other}</p>
    <dl class="kv">
      <dt>Platform</dt><dd>${esc(m.platform)} · ${esc(m.place)}</dd>
      <dt>Route</dt><dd>${fmtLen(s.path_m)} · ${dur(s.duration_s)} · ${fmtInt(s.keyframes)} keyframes (xclean's live poses)</dd>
      <dt>Map</dt><dd>${(s.gaussians / 1e6).toFixed(2)} M Gaussians full, ${(s.gaussians_lite / 1e6).toFixed(2)} M lite · ${fmtInt(s.points)} points from stereo depth</dd>
      <dt>Ground truth</dt><dd>${s.has_gt ? 'this route has ground truth' : 'none for this route'}</dd>
      <dt>Camera poses</dt><dd>${esc(m.engine_note || '')}</dd>
      <dt>Known limits</dt><dd>${esc(m.limitation)}</dd>
      <dt>Board</dt><dd>${boardHTML(m, B)}</dd>
      <dt>Map licence</dt><dd><a href="${CC_BY}">${esc(m.map_licence)}</a> · ${m.own_data ? 'own data' : 'Rosario Dataset'}</dd>
      <dt>Source</dt><dd>${esc(m.source)}${m.own_data ? '' : ` (${esc(m.source_licence)})`}</dd>
      <dt>Credit</dt><dd>${esc(m.credit)}</dd>
    </dl>
    <p class="pl-eng-h">Files</p>
    <div class="table-wrap"><table class="t"><thead><tr><th>File</th><th>Use</th><th class="num">Size</th></tr></thead><tbody>
      ${files.map((f) => `<tr><td><a href="${asset(m.id, f[1])}">${esc(f[0])}<span class="v4-sr"> of ${esc(m.id)}</span></a></td><td class="wrapcell">${esc(f[2])}</td><td class="num">${fmtMB(m.files[f[1]])}</td></tr>`).join('')}
    </tbody></table></div>`;
}

// ------------------------------------------------------------------ build
async function build() {
  const list = document.querySelector('.js-places');
  if (!list) return;
  const P = await loadPlaces();
  S.places = P.places.length;

  // 1. the sheets follow data/places.json (normally a no-op: the static HTML already matches)
  let prev = null;
  for (const p of P.places) {
    let el = document.getElementById(p.id);
    if (!el || !el.classList.contains('pl-item')) {
      list.insertAdjacentHTML('beforeend', sheetHTML(p));
      el = list.lastElementChild;
      S.added.push(p.id);
    }
    const inPlace = prev ? prev.nextElementSibling === el : list.firstElementChild === el;
    if (!inPlace) { if (prev) prev.after(el); else list.prepend(el); S.moved = true; }
    prev = el;
  }
  if (S.added.length) initRouteDoors(list);
  if ((S.added.length || S.moved) && location.hash.length > 1) {          // the page changed under a deep link: go there again
    const t = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (t) t.scrollIntoView({ block: 'start' });
  }

  // 2. the closed "For engineers" blocks (closed: filling them moves nothing on the page)
  const B = await getJSON('data/board.json').catch(() => null);
  for (const p of P.places) {
    const box = document.querySelector(`#${CSS.escape(p.id)} .pl-eng-in`);
    if (!box) continue;
    box.innerHTML = engHTML(p, B);
    S.eng += 1;
  }
  document.querySelectorAll('a.js-hf').forEach((a) => { a.href = LINKS.maps; });
}

build().catch((e) => { S.error = String(e); console.warn('[places] the engineer facts did not load', e); }).finally(() => { S.ready = true; });
