// Wins / ties / losses bar with text labels (colour is never the only carrier).
import { esc } from './site.js';

export function tallyHTML(t, theirs) {
  const n = t.win + t.tie + t.loss;
  const pc = x => `${(100 * x / n).toFixed(2)}%`;
  return `<div class="tally-bar" role="img" aria-label="${t.win} xclean better, ${t.tie} ties, ${t.loss} ${esc(theirs)} better, of ${n} routes">
      <i class="w" style="width:${pc(t.win)}"></i><i class="t" style="width:${pc(t.tie)}"></i><i class="l" style="width:${pc(t.loss)}"></i></div>
    <div class="tally-legend"><span class="w">${t.win} xclean better</span><span class="t">${t.tie} tie</span><span class="l">${t.loss} ${esc(theirs)} better</span></div>`;
}
