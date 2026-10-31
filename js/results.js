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
const A = b.attempts;
const feed = A.void_reasons.filter(x => x.why === 'feeder timing').length, load_ = A.void_reasons.filter(x => x.why !== 'feeder timing').length;
set('.js-attempts', `${A.valid} valid runs of record, 3 per route, out of ${A.attempts} attempts: ${A.VOID} attempts were void (${feed} for feeder timing, one of them while our own data copy was reading the same disk; ${load_} for outside CPU load, under a rule that amendment 8.40 later removed) and were re-run. ${A.INCOMPLETE_not_attempts} more were cut by power or session outages; these count as incomplete, not as attempts. The rules for void and incomplete runs were changed during the board (8.36, 8.40, 8.43, 8.44). Not counted in these attempts: the sentinel runs (a fixed reference route run between blocks to check the machine), 3 of which were void on 2026-10-30 because an outside app held the GPU (8.44). All attempts are in the board ledger; the 2 crashed or hung attempts were in the separate lock-step replay.`);
const c1d = b.c1_fail, c1drop = c1d.filter(x => x.drops_max > 0), c1drift = c1d.filter(x => x.drops_max === 0);
set('.js-c1-why', `On ${c1drop.length} of the ${c1d.length} failing routes, all 30 Hz 4Seasons car routes, xclean dropped frames: on all of them the bars on the worst frame (a dropped frame counts as infinitely late) and on the longest gap between published frames failed, and on most also consecutive drops or the worst 1-second window (between ${Math.min(...c1drop.map(x => x.drops_min))} and ${Math.max(...c1drop.map(x => x.drops_max))} dropped frames per run, at most ${Math.max(...c1drop.map(x => x.drop_pct_max))} % of a run); the p95 bar failed on only ${c1d.filter(x => x.failed.includes('p95 latency')).length}. The other ${c1drift.length} (${c1drift.map(x => x.route).join(', ')}) dropped no frame and failed only the latency-drift bar (late-run p95 against early-run p95).`);
const L1 = b.launch1;
const VA = Object.entries(L1.void_attempts).map(([r, n]) => `${r} ${n}`).join(', ');
set('.js-launch1', `The first launch (2026-10-28) ran a pre-fix build, 6bb6e65a, with identical engine code; only the harness's list of allowed background processes differed. It made ${L1.attempts_total} attempts: an opening sentinel run (valid), ${L1.valid_runs_set_aside.length} valid runs on ${L1.valid_runs_set_aside.length} held-out routes (${L1.valid_runs_set_aside.join(', ')}), ${Object.values(L1.void_attempts).reduce((x, y) => x + y, 0)} void attempts (${VA}) and ${L1.sentinel_voids} void sentinel runs; then it stopped. All of it was set aside: no accuracy number of it was read and none of it is used for any claim. So ${L1.routes.length} of the 38 held-out routes had in fact been run before the final board, by the identical engine code, in that set-aside launch (madmax_B0 only in voided attempts).`);
set('.js-load2', b.load);
const IM = b.imu;
$('.js-imu').innerHTML = Object.entries(IM.by_family).map(([f, v]) => `<tr><td>${esc(f)}</td><td class="num">${v.kept}</td><td class="num">${v.dropped}</td><td class="num">${v.refused}</td><td class="num">${v.none}</td></tr>`).join('')
  + `<tr><td><strong>All 216 runs</strong></td><td class="num"><strong>${IM.total.kept}</strong></td><td class="num"><strong>${IM.total.dropped}</strong></td><td class="num"><strong>${IM.total.refused}</strong></td><td class="num"><strong>${IM.total.none}</strong></td></tr>`;
$('.js-imu-note').textContent = `Definitions: ${IM.rule}. Source: data/board.json on this site (${IM.source}).`;
set('.js-c3b-p', b.c3b.pass); set('.js-c3b-f', b.c3b.fail); set('.js-c3b-n', b.c3b.pending);
set('.js-c2', `${b.c2.pass_rows} of ${b.c2.of}`); set('.js-c2-odom', b.c2.odom_jumps_zero_rows);
const FO = b.forfeits.orb3_all_gt;
set('.js-forfeit-text', `On the 38 unseen routes ORB-SLAM3 forfeited none. Over all 67 routes it forfeited ${FO.routes.length} (${FO.routes.join(', ')}): on ${FO.changed_verdict.length} of them (${FO.changed_verdict.join(', ')}) xclean wins only because of the forfeit and the table says "by forfeit"; on the other ${FO.would_win_anyway.length} (${FO.would_win_anyway.join(', ')}) the ATE ranges alone already favour xclean. On rosario_06, for example, our median 4.33 m is higher than ORB-SLAM3's 3.21 m, but ORB-SLAM3 lost tracking in 4 of its 5 runs. On all four Rosario routes it forfeited (rosario_01, 02, 03, 06) ORB-SLAM3 ran stereo-only: its IMU start-up crashed on every run.`);
set('.js-okv-all', `${b.okvis2x_failed_all_gt.length} of these ${b.tallies.all_gt_vs_okvis2x.win} wins are against a diverged OKVIS2-X run (${b.okvis2x_failed_all_gt.join(', ')}).`);
set('.js-identical', `On ${b.identical_runs.routes} of the ${b.headline.routes_gt} routes with ground truth, our three runs give the same ATE to 0.1 mm (shown as a single value). We checked why: on ${b.identical_runs.no_dropped_frame} of them no frame was dropped in any run, so each run processed the same frames; on ${b.identical_runs.byte_identical} the three published keyframe trajectories are byte-identical, and on the other ${b.identical_runs.routes - b.identical_runs.byte_identical} the ATE differs by at most ${(b.identical_runs.max_spread_m * 1000).toFixed(2)} mm.`);
const ST = st => { if (!st) return ''; let m = st.match(/^div (\d+)\/(\d+)$/); if (m) return `diverged in ${m[1]} of ${m[2]} runs`;
  m = st.match(/^lost (\d+)\/(\d+)$/); if (m) return `lost tracking in ${m[1]} of ${m[2]} runs`; if (st === 'partial span') return 'trajectory covers only part of the route'; return st; };
const fw = b.flagged_wins.unseen;
set('.js-flagged', `Of the ${b.tallies.unseen_vs_orb3.win} wins against ORB-SLAM3 on the 38 unseen routes, ${fw.length} are against an ORB-SLAM3 run set with a problem: ${fw.map(x => `${x.route} (ORB-SLAM3 ${ST(x.status)})`).join('; ')}. Of the ${b.tallies.unseen_vs_okvis2x.win} wins against OKVIS2-X, ${b.okvis2x_failed_unseen.length} (${b.okvis2x_failed_unseen.join(', ')}) is against a diverged OKVIS2-X run.`);
if (b.prereg) {
  const P = b.prereg;
  $('.js-prereg').innerHTML = `The pre-registration document was first written on ${esc(P.first_version)}; its last amendment is ${esc(P.last_amendment)}, and the file was last written on ${esc(P.file_last_written)}; the board was evaluated on ${esc(P.board_evaluated)}. (The header's approximate time is later than the file's write time; the file time is the recorded one, and the header gives only an approximate time written in the text.) That file's SHA-256 is <code class="hash">${esc(P.sha256)}</code>, first published here on ${esc(P.hash_published)}. The document will be published with the code release, and the fingerprint lets anyone check that it is the same file. The fingerprint proves that the document is unaltered from today on; it does not by itself prove when the document was written. The amendments made during the board (${esc(P.note)}):`;
  $('.js-amend').innerHTML = P.amendments_during_board.map(x => `<li><strong>${esc(x.id)}</strong> (${esc(x.date)}): ${esc(x.what)}.</li>`).join('');
}
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
$('.js-source').innerHTML = `Every number on this page is read from <a href="data/board.json">data/board.json</a> on this site. That file was built on ${esc(b.generated)} from the final board file (generated ${esc(src.board_generated)} by the frozen evaluator, sha1 <code>${esc(src.sha1.slice(0, 12))}</code>) for the board engine build <code>${esc(src.engine_md5.slice(0, 8))}</code> (the release package carries the same engine code with packaging changes, so its own hash differs), scored with the frozen live scorer (<code>${esc(src.scorer_md5.slice(0, 8))}</code>).`;

// ---------------------------------------------------------------- the route table
const G = Object.fromEntries(b.groups.map(g => [g.id, g]));
const setName = { unseen: 'unseen', sealed: 'unseen (sealed)', k14: 'seen once (last kill test, K14)', design: 'design route', k13: 'seen once (earlier kill test)', k12: 'seen once (earlier kill test)', oak: 'own camera' };
const fams = [...new Set(b.rows.map(r => r.family))].sort();
$('.js-fam').insertAdjacentHTML('beforeend', fams.map(f => `<option>${esc(f)}</option>`).join(''));
const S = { set: 'unseen', fam: '', ver: '', q: '' };
const f3 = x => (x == null ? '—' : x < 10 ? x.toFixed(3) : x.toFixed(2));
function ate(a) {
  if (!a) return '—';
  const rng = a.lo === a.hi ? '' : f3(a.lo) === f3(a.hi) ? `spread ${((a.hi - a.lo) * 1000).toFixed(1)} mm · ` : `${f3(a.lo)} – ${f3(a.hi)} · `;
  return `<b>${f3(a.med)}</b><br><span class="rng">${rng}${a.n} runs</span>`;
}
const VL = { win: ['v-win', 'xclean better'], tie: ['v-tie', 'tie'], loss: ['v-loss', 'ORB-SLAM3 better'], win_forfeit: ['v-win', 'xclean, by forfeit'], loss_forfeit: ['v-loss', 'ORB-SLAM3, by forfeit'], both_lost: ['v-tie', 'both lost'] };
const OL = { win: ['v-win', 'xclean better'], tie: ['v-tie', 'tie'], loss: ['v-loss', 'OKVIS2-X better'], win_forfeit: ['v-win', 'xclean, by forfeit'], loss_forfeit: ['v-loss', 'OKVIS2-X, by forfeit'], both_lost: ['v-tie', 'both lost'] };
function row(r) {
  const v = r.vs_orb3 ? VL[r.vs_orb3] : null, o = r.vs_okvis2x ? OL[r.vs_okvis2x] : null;
  const flags = [r.crash_or_hang ? '<span class="flag">crash/hang</span>' : '', r.unsupported === 'fail' ? '<span class="flag">unsupported</span>' : '', r.unsupported === 'pending' ? '<span class="flag">pending</span>' : ''].join('');
  return `<tr id="r-${esc(r.route)}"><td><span class="mono">${esc(r.route)}</span><br><span class="rng">${esc(setName[r.group])}</span></td><td>${esc(r.family)}<br><span class="rng">${esc(r.platform)}</span></td>
    <td class="num">${r.gt ? ate(r.ours) : 'no ground truth'}</td><td class="num">${r.gt ? ate(r.orb3) + (r.orb3?.status ? `<br><span class="flag">${esc(ST(r.orb3.status))}</span>` : '') + (r.orb3?.stereo_only ? `<br><span class="flag">stereo-only in ${r.orb3.stereo_only} of ${r.orb3.draws} runs: IMU start-up crashed</span>` : '') : '—'}</td>
    <td class="${v ? v[0] : ''}">${v ? v[1] : '—'}${r.vs_orb3 === 'win_forfeit' ? `<br><span class="rng">ORB-SLAM3 ${esc(ST(r.orb3.status))}</span>` : ''}</td>
    <td class="${o ? o[0] : ''}">${o ? `${o[1]}<br><span class="rng">${r.okvis2x_ratio < 0.01 ? `OKVIS2-X diverged: ATE ${r.okvis2x_ate >= 1e4 ? r.okvis2x_ate.toExponential(1) : r.okvis2x_ate?.toFixed(0)} m` : `ratio ${r.okvis2x_ratio?.toFixed(2)}`}${r.okvis2x_ours_frame != null && r.okvis2x_ate != null ? `<br>frame-level: xclean ${r.okvis2x_ours_frame < 10 ? r.okvis2x_ours_frame.toFixed(3) : r.okvis2x_ours_frame.toFixed(2)} m, OKVIS2-X ${r.okvis2x_ate >= 1e4 ? r.okvis2x_ate.toExponential(1) : r.okvis2x_ate < 10 ? r.okvis2x_ate.toFixed(3) : r.okvis2x_ate.toFixed(2)} m` : ''}</span>` : '—'}</td>
    <td class="num">${r.lat_ms_p50?.toFixed(1) ?? '—'}<br><span class="rng">p95 ${r.lat_ms_p95?.toFixed(1) ?? '—'}</span></td><td class="num">${r.lost_runs} of ${r.runs}</td><td>${flags || '—'}</td></tr>`;
}
function render() {
  const rows = b.rows.filter(r => (S.set === 'all' || (S.set === 'unseen' ? G[r.group].unseen : S.set === 'oak' ? r.group === 'oak' : !G[r.group].unseen && r.group !== 'oak'))
    && (!S.fam || r.family === S.fam) && (!S.ver || r.vs_orb3 === S.ver || (S.ver === 'win' && r.vs_orb3 === 'win_forfeit')) && (!S.q || r.route.includes(S.q.toLowerCase())));
  $('.js-rows').innerHTML = rows.map(row).join('') || '<tr><td colspan="9">No route matches these filters.</td></tr>';
  const c = { win: 0, tie: 0, loss: 0, f: 0 };
  rows.forEach(r => { const v = r.vs_orb3; if (!v) return; if (v === 'win' || v === 'win_forfeit') c.win++; else if (v === 'tie' || v === 'both_lost') c.tie++; else c.loss++; if (v === 'win_forfeit') c.f++; });
  $('.js-count').textContent = `${rows.length} routes shown · vs ORB-SLAM3: ${c.win} xclean better${c.f ? ` (${c.f} by forfeit)` : ''}, ${c.tie} tie, ${c.loss} ORB-SLAM3 better`;
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
