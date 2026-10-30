// Results page: everything rendered from data/board.json (built from the final board by tools/build_site_data.py).
import { $, esc, getJSON } from './site.js';
import { tallyHTML } from './tally.js';

const b = await getJSON('data/board.json');
const h = b.headline;
const set = (sel, v) => document.querySelectorAll(sel).forEach(e => { e.textContent = v; });
const V = { p50: h.latency_ms.p50.toFixed(1), p95: h.latency_ms.p95.toFixed(1), p99: h.latency_ms.p99.toFixed(1), runs: h.runs, routes: h.routes, lost: h.unseen_lost_runs, unseen: h.unseen_routes };
document.querySelectorAll('.js-h').forEach(el => { if (el.dataset.k in V) el.textContent = V[el.dataset.k]; });

set('.js-claims-pass', b.claims_unseen.filter(c => c.pass).length);
set('.js-claims-n', b.claims_unseen.length);
set('.js-k14', b.k14.note);
set('.js-load', b.load);
set('.js-ch-n', h.unseen_crash_or_hang_routes.length);
set('.js-us-n', h.unseen_unsupported_fail_routes.length);
const c1 = b.claims_unseen.find(c => c.id === 'C1');
set('.js-c1', c1.measured.replace(' routes pass', ''));
$('.js-lat-rule').innerHTML = `How these three numbers are made: the ${esc(h.latency_ms.rule)}. Over all ${h.runs} runs; one RTX 5090. We quote milliseconds, not frame periods: the routes run at 10 to 30 Hz.`;
$('.js-rob-note').innerHTML = `Crashed or hung attempt: ${h.unseen_crash_or_hang_routes.map(esc).join(', ')} (in the lock-step replay that checks the frame path). Failed the unsupported-frames check: ${h.unseen_unsupported_fail_routes.map(esc).join(', ')}. ${h.unseen_unsupported_pending_routes} more unseen routes (MADMAX) await a decision on that check, because their ground truth has known faults; both readings are in the board file. Across all ${h.runs} runs on all ${h.routes} routes, ${h.lost_runs_all} runs were lost.`;
const T = b.tallies.unseen_vs_orb3;
set('.js-t-w', T.win); set('.js-t-t', T.tie); set('.js-t-l', T.loss);
const bt = b.tallies.unseen_vs_orb3_both_tracked;
$('.js-bt').textContent = `On the routes where ORB-SLAM3 tracked: ${bt.win} wins, ${bt.tie} ties, ${bt.loss} losses.`;
document.querySelectorAll('.js-tally').forEach(el => { el.innerHTML = tallyHTML(b.tallies[el.dataset.k], el.dataset.k.includes('okvis') ? 'OKVIS2-X' : 'ORB-SLAM3'); });

$('.js-claims').innerHTML = b.claims_unseen.map(c => `<tr><td class="wrapcell"><span class="mono">${esc(c.id)}</span> · ${esc(c.claim)}</td>
  <td class="${c.pass ? 'pass' : 'fail'}">${c.pass ? 'Passed' : 'Failed'}</td><td class="wrapcell">${esc(c.measured)}</td></tr>`).join('');

const src = b.source;
$('.js-source').innerHTML = `Every number on this page is read from the final board, <code>${esc(src.file)}</code> (generated ${esc(src.board_generated)}, sha1 <code>${esc(src.sha1.slice(0, 12))}</code>), produced by the frozen evaluator for engine build <code>${esc(src.engine_md5.slice(0, 8))}</code> with the frozen live scorer (<code>${esc(src.scorer_md5.slice(0, 8))}</code>). The page's data file was built from it on ${esc(b.generated)}.`;

// ---------------------------------------------------------------- the route table
const G = Object.fromEntries(b.groups.map(g => [g.id, g]));
const setName = { unseen: 'unseen', sealed: 'unseen, sealed', k14: 'seen: K14', design: 'seen: design', k13: 'seen: K13', k12: 'seen: K12-e', oak: 'own camera' };
const fams = [...new Set(b.rows.map(r => r.family))].sort();
$('.js-fam').insertAdjacentHTML('beforeend', fams.map(f => `<option>${esc(f)}</option>`).join(''));
const S = { set: 'unseen', fam: '', ver: '', q: '' };
const f3 = x => (x == null ? '—' : x < 10 ? x.toFixed(3) : x.toFixed(2));
function ate(a) {
  if (!a) return '—';
  const rng = a.lo !== a.hi ? `${f3(a.lo)} – ${f3(a.hi)} · ` : '';
  return `<b>${f3(a.med)}</b><br><span class="rng">${rng}${a.n} runs</span>`;
}
const VL = { win: ['v-win', 'xclean better'], tie: ['v-tie', 'tie'], loss: ['v-loss', 'ORB-SLAM3 better'] };
const OL = { win: ['v-win', 'xclean better'], tie: ['v-tie', 'tie'], loss: ['v-loss', 'OKVIS2-X better'] };
function row(r) {
  const v = r.vs_orb3 ? VL[r.vs_orb3] : null, o = r.vs_okvis2x ? OL[r.vs_okvis2x] : null;
  const flags = [r.crash_or_hang ? '<span class="flag">crash/hang</span>' : '', r.unsupported === 'fail' ? '<span class="flag">unsupported</span>' : '', r.unsupported === 'pending' ? '<span class="flag">pending</span>' : ''].join('');
  return `<tr id="r-${esc(r.route)}"><td><span class="mono">${esc(r.route)}</span><br><span class="rng">${esc(setName[r.group])}</span></td><td>${esc(r.family)}<br><span class="rng">${esc(r.platform)}</span></td>
    <td class="num">${r.gt ? ate(r.ours) : 'no ground truth'}</td><td class="num">${r.gt ? ate(r.orb3) : '—'}</td>
    <td class="${v ? v[0] : ''}">${v ? v[1] : '—'}</td>
    <td class="${o ? o[0] : ''}">${o ? `${o[1]}<br><span class="rng">ratio ${r.okvis2x_ratio < 0.005 ? "< 0.01" : r.okvis2x_ratio?.toFixed(2)}</span>` : '—'}</td>
    <td class="num">${r.lat_ms_p50?.toFixed(1) ?? '—'}<br><span class="rng">p95 ${r.lat_ms_p95?.toFixed(1) ?? '—'}</span></td><td class="num">${r.lost_runs} of ${r.runs}</td><td>${flags || '—'}</td></tr>`;
}
function render() {
  const rows = b.rows.filter(r => (S.set === 'all' || (S.set === 'unseen' ? G[r.group].unseen : S.set === 'oak' ? r.group === 'oak' : !G[r.group].unseen && r.group !== 'oak'))
    && (!S.fam || r.family === S.fam) && (!S.ver || r.vs_orb3 === S.ver) && (!S.q || r.route.includes(S.q.toLowerCase())));
  $('.js-rows').innerHTML = rows.map(row).join('') || '<tr><td colspan="9">No route matches these filters.</td></tr>';
  const c = { win: 0, tie: 0, loss: 0 };
  rows.forEach(r => { if (r.vs_orb3) c[r.vs_orb3]++; });
  $('.js-count').textContent = `${rows.length} routes shown · vs ORB-SLAM3: ${c.win} xclean better, ${c.tie} tie, ${c.loss} ORB-SLAM3 better`;
}
document.querySelectorAll('.js-set button').forEach(btn => btn.addEventListener('click', () => {
  S.set = btn.dataset.set;
  document.querySelectorAll('.js-set button').forEach(x => x.setAttribute('aria-pressed', String(x === btn)));
  render();
}));
$('.js-fam').addEventListener('change', e => { S.fam = e.target.value; render(); });
$('.js-ver').addEventListener('change', e => { S.ver = e.target.value; render(); });
$('.js-q').addEventListener('input', e => { S.q = e.target.value.trim(); render(); });
// deep link: results.html#r-kitti_08
const hash = decodeURIComponent(location.hash.slice(1));
if (hash.startsWith('r-')) { S.set = 'all'; document.querySelectorAll('.js-set button').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.set === 'all'))); }
render();
if (hash.startsWith('r-')) document.getElementById(hash)?.scrollIntoView({ block: 'center' });
