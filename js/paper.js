// Paper page: the summary's numbers come from data/board.json (the static text is the same numbers, as a no-JS fallback);
// the run count counts up and the two tallies grow when they come into view.
import { countUp, getJSON } from './site.js';
import { tallyHTML } from './tally.js';
import './copy.js';

const b = await getJSON('data/board.json');
const set = (s, v) => document.querySelectorAll(s).forEach(e => { e.textContent = v; });
const o = b.tallies.unseen_vs_orb3, k = b.tallies.unseen_vs_okvis2x;
set('.js-tw', o.win); set('.js-tt', o.tie); set('.js-tl', o.loss);
set('.js-ow', k.win); set('.js-ot', k.tie); set('.js-ol', k.loss);
set('.js-cp', b.claims_unseen.filter(c => c.pass).length); set('.js-cn', b.claims_unseen.length);
document.querySelectorAll('.js-tally').forEach(el => { el.innerHTML = tallyHTML(b.tallies[el.dataset.k], el.dataset.k.includes('okvis') ? 'OKVIS2-X' : 'ORB-SLAM3'); });
document.querySelectorAll('.js-runs').forEach(el => countUp(el, b.headline.runs));
// the summary paragraph is written out in full in the HTML; check it still matches the data and say so in the console
const h = b.headline, txt = document.querySelector('.js-abstract').textContent;
const want = [`${h.routes} routes`, `${h.runs} real-time replays`, `${h.latency_ms.p50} ms`, `p95 ${h.latency_ms.p95} ms`, `${h.unseen_routes} routes`, `wins ${o.win}, ties ${o.tie} and loses ${o.loss}`];
const miss = want.filter(w => !txt.includes(w));
if (miss.length) console.warn('[paper] the summary no longer matches data/board.json:', miss);
