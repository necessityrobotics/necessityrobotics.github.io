// The home page's 2-D story (website_nr3/MASTER_PLAN.md 1.3): the board's numbers and tallies from data/board.json
// (the HTML carries the same values, so nothing moves when they arrive), and Fig. 1's point field beside the xclean
// heading on wide screens. Nothing counts up: a latency figure never shows a value that was not measured (FA-4).
import { fmtInt, getJSON, idle } from '../site.js';
import { tallyHTML } from '../tally.js';

export function startStory() {
  getJSON('data/board.json').then(b => {
    const h = b.headline;
    const V = { p50: h.latency_ms.p50.toFixed(1), p95: h.latency_ms.p95.toFixed(1), p99: h.latency_ms.p99.toFixed(1), runs: String(h.runs), routes: String(h.routes) };
    document.querySelectorAll('[data-b]').forEach(el => { const v = V[el.dataset.b]; if (v != null && el.textContent !== v) el.textContent = v; });
    document.querySelectorAll('[data-tally]').forEach(el => {
      const k = el.dataset.tally;
      el.innerHTML = tallyHTML(b.tallies[k], k.includes('okvis') ? 'OKVIS2-X' : 'ORB-SLAM3');
    });
  }).catch(e => console.warn('[home] board', e));

  // Fig. 1: only where it is shown (1100 px and wider), loaded when it comes near the screen
  const box = document.querySelector('.xc-field');
  if (!box) return;
  const wide = matchMedia('(min-width: 1100px)');
  const io = new IntersectionObserver(es => {
    if (!wide.matches || !es.some(e => e.isIntersecting)) return;
    io.disconnect();
    idle(() => Promise.all([import('../field.js'), getJSON('data/starfield.json')]).then(([{ PointField }, d]) => {
      document.querySelectorAll('[data-f="sf-n"]').forEach(e => { e.textContent = fmtInt(d.n); });
      document.querySelectorAll('[data-f="sf-of"]').forEach(e => { e.textContent = fmtInt(d.of); });
      new PointField(box.querySelector('canvas'), d, { tilt: 0.95, zoom: 0.8, centerX: 0.5, centerY: 0.5 });
    }).catch(e => console.warn('[home] Fig. 1', e)), 1200);
  }, { rootMargin: '600px 0px' });
  io.observe(box);
}
