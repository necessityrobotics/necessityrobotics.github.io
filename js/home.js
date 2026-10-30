// Landing page: the live map playback behind the company name, the SLAM point field (Fig. 1), the board numbers, the
// map cards and the film figure (Fig. 2).
import { $, esc, fmtInt, fmtLen, getJSON, idle, REDUCED, CONSTRAINED } from './site.js';
import { PointField } from './field.js';
import { attachHero, attachFilm } from './fly.js';
import { tallyHTML } from './tally.js';

// 1. numbers from the board
getJSON('data/board.json').then(b => {
  const h = b.headline;
  const V = { p50: h.latency_ms.p50.toFixed(1), p95: h.latency_ms.p95.toFixed(1), p99: h.latency_ms.p99.toFixed(1), runs: h.runs, routes: h.routes, lost: h.unseen_lost_runs, unseen: h.unseen_routes };
  document.querySelectorAll('.js-h').forEach(el => { if (el.dataset.k in V) el.textContent = V[el.dataset.k]; });
  document.querySelectorAll('.js-tally').forEach(el => {
    el.innerHTML = tallyHTML(b.tallies[el.dataset.k], el.dataset.k.includes('okvis') ? 'OKVIS2-X' : 'ORB-SLAM3');
  });
}).catch(e => console.warn('[home] board', e));

// 2. maps: the hero playback, the film figure, the cards
getJSON('data/maps.json').then(M => {
  const hero = M.maps.find(m => m.id === M.hero) || M.maps[0];
  const hint = $('.js-hero-hint');
  if (REDUCED) hint.textContent = '';
  else if (CONSTRAINED || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) hint.textContent = '';
  const HS = { poster: 'Poster', loading: 'Loading the live map', live: 'Live render', film: 'Pre-rendered film' };
  attachHero($('.hero'), hero, { onState: s => { $('.js-hero-state').textContent = HS[s] || s; } });

  const f2 = M.maps.find(m => m.id === 'rosario_01') || M.maps.find(m => m.id !== hero.id) || hero;
  attachFilm($('.fly'), f2, { onState: s => { $('.js-fly-state').textContent = { poster: 'Poster', film: 'Pre-rendered film' }[s] || s; } });

  $('.js-maps').innerHTML = M.maps.slice(0, 4).map(m => `
    <a class="mapcard" href="viewer.html?map=${encodeURIComponent(m.id)}">
      <div class="plate"><img src="img/maps/${esc(m.id)}.webp" alt="${esc(m.title)}, rendered from the map" loading="lazy" decoding="async" width="1280" height="800"><span class="lic">${esc(m.map_licence)}${m.own_data ? ' · own data' : ' · Rosario Dataset'}</span></div>
      <h3>${esc(m.title)} <span class="muted">· ${esc(m.id)}</span></h3>
      <p>${esc(m.platform)}, ${esc(m.place)}.</p>
      <span class="label">${fmtLen(m.stats.path_m)} · ${(m.stats.gaussians / 1e6).toFixed(1)} M Gaussians · ${fmtInt(m.stats.keyframes)} keyframes</span>
    </a>`).join('');
}).catch(e => console.warn('[home] maps', e));

// 3. Fig. 1: the point field (cheap 2-D canvas, 107 KB of data, fetched once the page is idle; it animates only on screen)
const canvas = $('.field-canvas');
idle(() => getJSON('data/starfield.json').then(d => {
  document.querySelectorAll('.js-field-n').forEach(e => { e.textContent = fmtInt(d.n); });
  document.querySelectorAll('.js-field-of').forEach(e => { e.textContent = fmtInt(d.of); });
  new PointField(canvas, d, { tilt: 0.95, zoom: 0.78, centerX: 0.5, centerY: 0.5 });
}).catch(e => console.warn('[home] starfield', e)), 3000);
