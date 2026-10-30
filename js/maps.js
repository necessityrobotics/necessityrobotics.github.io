// Maps page: one observatory-style plate per published map, from data/maps.json (+ its board route in data/board.json).
import { $, esc, fmtInt, fmtLen, fmtMB, getJSON } from './site.js';
import { asset } from './config.js';

const [M, B] = await Promise.all([getJSON('data/maps.json'), getJSON('data/board.json').catch(() => null)]);
const route = id => B?.rows.find(r => r.route === id);
const f3 = x => (x < 10 ? x.toFixed(3) : x.toFixed(2));
const dur = s => `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')} s`;

function plate(m, i) {
  const s = m.stats, r = m.board_route ? route(m.board_route) : null;
  const files = [
    ['Standard splats', 'splats.spz', 'the viewer\'s default'],
    ['Lite splats', 'splats_lite.spz', 'phones, quick look'],
    ['Full resolution', 'full/splats.ply', 'PLY, every Gaussian'],
    ['Point cloud', 'points.bin', 'SLAM depth points'],
    ['Film', m.film.mp4, `${m.film.duration_s} s, MP4`],
  ].filter(f => m.files[f[1]]);
  let board = '';
  if (r?.gt && r.ours) {
    board = `<dt>Board ATE</dt><dd>xclean ${f3(r.ours.med)} m, ORB-SLAM3 ${f3(r.orb3.med)} m on this route: <a href="results.html#r-${esc(r.route)}">${r.vs_orb3 === 'win' ? 'xclean better' : r.vs_orb3 === 'tie' ? 'a tie' : 'ORB-SLAM3 better'}</a></dd>`;
  } else if (r) {
    board = `<dt>Board</dt><dd>No ground truth: latency ${r.lat_ms_p50.toFixed(1)} ms median, ${r.lost_runs} of ${r.runs} runs lost. <a href="results.html#r-${esc(r.route)}">Its row</a></dd>`;
  }
  return `<article class="mplate" id="${esc(m.id)}" aria-labelledby="h-${esc(m.id)}">
    <figure>
      <a class="plate frame" href="viewer.html?map=${encodeURIComponent(m.id)}" aria-label="Open ${esc(m.id)} in the 3-D viewer">
        <img src="img/maps/${esc(m.id)}.webp" alt="${esc(m.title)}: a frame rendered from the map along xclean's trajectory" width="1280" height="800" ${i ? 'loading="lazy"' : 'fetchpriority="high"'} decoding="async">
        <span class="lic">${esc(m.map_licence)}${m.own_data ? ' · own data' : ' · Rosario Dataset'}</span>
      </a>
      <figcaption><b>Plate ${i + 1}</b> ${esc(m.id)}, rendered from the map. A reconstruction, not camera video.</figcaption>
    </figure>
    <div>
      <span class="label">Plate ${i + 1} · ${esc(m.id)}</span>
      <h2 id="h-${esc(m.id)}">${esc(m.title)}</h2>
      <p class="cat">${esc(m.platform)} · ${esc(m.place)} · ${fmtLen(s.path_m)} · ${dur(s.duration_s)}</p>
      <div class="btns" style="margin-top:0"><a class="btn btn--ion" href="viewer.html?map=${encodeURIComponent(m.id)}">Fly it in 3-D <span class="arr" aria-hidden="true">→</span></a>
        <a class="btn" href="${asset(m.id, m.film.mp4)}">Watch the film</a></div>
      <dl class="kv">
        <dt>Keyframes</dt><dd>${fmtInt(s.keyframes)} (xclean's live poses)</dd>
        <dt>Gaussians</dt><dd>${(s.gaussians / 1e6).toFixed(2)} M full · ${(s.gaussians_lite / 1e6).toFixed(2)} M lite</dd>
        <dt>Points</dt><dd>${fmtInt(s.points)} from stereo depth</dd>
        <dt>Ground truth</dt><dd>${s.has_gt ? 'yes: shown in the viewer for comparison' : 'none for this route'}</dd>
        ${board}
        <dt>Map licence</dt><dd>${esc(m.map_licence)}</dd>
        <dt>Source</dt><dd>${esc(m.source)}${m.own_data ? '' : ` (${esc(m.source_licence)})`}</dd>
      </dl>
      <div class="disclose lim"><h4>Known limits</h4><p>${esc(m.limitation)}</p></div>
      <p class="credit"><strong>Credit.</strong> ${esc(m.credit)}</p>
      <div class="table-wrap"><table class="t files"><thead><tr><th>File</th><th>Use</th><th class="num">Size</th></tr></thead><tbody>
        ${files.map(f => `<tr><td><a href="${asset(m.id, f[1])}">${esc(f[0])}</a></td><td>${esc(f[2])}</td><td class="num">${fmtMB(m.files[f[1]])}</td></tr>`).join('')}
      </tbody></table></div>
    </div>
  </article>`;
}
$('.js-plates').innerHTML = M.maps.map(plate).join('');
if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
