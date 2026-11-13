// The measurement hook (MASTER_PLAN.md 3.6): window.__world = {events, info} (aliased as window.__nr, so v2's tools keep
// working). events: [{t (performance.now ms), ev, ch (0 hero / street, 1-3 chapters, 4 explore, null), ...}]. A long-task
// observer logs every main-thread task over 50 ms; ?debug=1 also shows them in a corner of the page.

const W = window.__world = window.__nr = window.__world || { events: [], info: () => null };
const MAX = 4000;

export function log(ev, ch = null, extra = {}) {
  W.events.push({ t: +performance.now().toFixed(1), ev, ch, ...extra });
  if (W.events.length > MAX) W.events.splice(0, MAX / 4);
}
export function setInfo(fn) { W.info = fn; }
/** PL: a read-only accessor for the measurement tools (stage() -> the live WorldStage, govLoad(n) under ?gov_test). */
export function setHook(name, fn) { W[name] = fn; }
export function logged(ev, ch) { return W.events.some(e => e.ev === ev && (ch === undefined || e.ch === ch)); }

let overlay = null;
const DEBUG = new URLSearchParams(location.search).get('debug') === '1';
// integrator: only where the browser has long-task timing (Firefox and Safari have none; observing it there printed
// 'Ignoring unsupported entryTypes: longtask' in Firefox's console)
if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) try {
  new PerformanceObserver(list => {
    for (const e of list.getEntries()) {
      log('longtask', null, { ms: Math.round(e.duration), at: Math.round(e.startTime) });
      if (DEBUG) {
        if (!overlay) {
          overlay = document.createElement('pre');
          overlay.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:99;margin:0;padding:6px 8px;max-height:40vh;overflow:auto;font:11px/1.3 monospace;background:rgba(0,0,0,.85);color:#ff6a2b;pointer-events:none';
          document.body.appendChild(overlay);
        }
        overlay.textContent = `long task ${Math.round(e.duration)} ms @ ${(e.startTime / 1000).toFixed(2)} s\n${overlay.textContent}`.slice(0, 2000);
      }
    }
  }).observe({ type: 'longtask', buffered: true });
} catch (e) { /* no long-task timing in this browser */ }
