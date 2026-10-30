// Copy buttons on code blocks + board numbers on content pages (.js-h spans fall back to their static text).
import { getJSON } from './site.js';

document.querySelectorAll('.code .copy').forEach(btn => {
  btn.addEventListener('click', async () => {
    const text = btn.parentElement.querySelector('code').innerText;
    try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; } catch (e) { btn.textContent = 'Select and copy'; }
    setTimeout(() => { btn.textContent = 'Copy'; }, 1600);
  });
});

if (document.querySelector('.js-h')) {
  getJSON('data/board.json').then(b => {
    const h = b.headline;
    const V = { p50: h.latency_ms.p50.toFixed(1), p95: h.latency_ms.p95.toFixed(1), p99: h.latency_ms.p99.toFixed(1), runs: h.runs, routes: h.routes, lost: h.unseen_lost_runs, unseen: h.unseen_routes };
    document.querySelectorAll('.js-h').forEach(el => { if (el.dataset.k in V) el.textContent = V[el.dataset.k]; });
  }).catch(() => {});
}
