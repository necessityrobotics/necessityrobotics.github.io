// Explore (website_nr3/MASTER_PLAN.md 1.3 "Explore", 2.6): the chips toolbar (one tab stop, arrows move), the island
// card (hover, focus or tap: a bottom sheet on phones) and the dive bar. The engine lifts, picks and flies; this module
// only shows what it reports (world:island, world:dive) and asks it to act (world.select / dive / surface).
import { esc, REDUCED } from '../site.js';
import { EVENTS } from '../world/api.js';
import { fields, isRosario, shortCredit } from './facts.js';

const timers = new WeakMap();

/** data-ov on / off (CSS animates it); with hide, the element leaves the tab order once it has faded. */
export function setOv(el, on, hide = false) {
  if (!el) return;
  clearTimeout(timers.get(el));
  if (on) {
    if (hide && el.hidden) { el.hidden = false; getComputedStyle(el).opacity; }   // start the fade from "off"
    if (el.dataset.ov !== 'on') el.dataset.ov = 'on';
  } else {
    if (el.dataset.ov !== 'off') el.dataset.ov = 'off';
    if (hide && !el.hidden) timers.set(el, setTimeout(() => { el.hidden = true; }, 380));
  }
}

export function startExplore(world, { byId, order, say, onChange }) {
  const sec = document.getElementById('atlas');
  const wrap = sec.querySelector('.ex-wrap');
  const intro = sec.querySelector('.ex-intro'), nav = sec.querySelector('.ex-chips'), card = sec.querySelector('.explore-card');
  const foot = sec.querySelector('.ex-foot'), bar = sec.querySelector('.dive-bar');
  const barT = bar.querySelector('.dive-t'), barOpen = bar.querySelector('.dive-open'), barBack = bar.querySelector('.dive-back');
  const S = { on: false, live: false, hov: null, sel: null, shown: null, diving: null };

  // ---------------------------------------------------------------- the chips: links (no script) become one toolbar
  const tb = document.createElement('div');
  tb.className = 'xbar';
  tb.setAttribute('role', 'toolbar');
  tb.setAttribute('aria-label', 'All maps: arrow keys move, Enter shows the card');
  const chips = order.map((id, i) => {
    const m = byId[id], b = document.createElement('button');
    b.type = 'button'; b.className = 'xchip'; b.dataset.id = id; b.tabIndex = i ? -1 : 0;
    b.setAttribute('aria-pressed', 'false');
    b.innerHTML = `${esc(m.title)} <span>${esc(id)}</span>`;
    return b;
  });
  tb.append(...chips);
  nav.replaceChildren(tb);
  const chipOf = id => chips.find(c => c.dataset.id === id);
  const rove = b => { if (b) chips.forEach(c => { c.tabIndex = c === b ? 0 : -1; }); };
  tb.addEventListener('click', e => {
    const b = e.target.closest('.xchip');
    if (!b) return;
    rove(b);
    world.select(b.dataset.id, { why: 'chip' });
  });
  tb.addEventListener('keydown', e => {
    const i = chips.indexOf(document.activeElement);
    if (i < 0) return;
    const n = chips.length;
    const j = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1 + n, ArrowUp: i - 1 + n, Home: 0, End: n - 1 }[e.key];
    if (j == null) return;
    e.preventDefault();
    const b = chips[j % n];
    rove(b); b.focus(); world.select(b.dataset.id, { why: 'key' });
  });

  // ---------------------------------------------------------------- the card (from data/maps.json)
  function cardHTML(m) {
    const f = fields(m), id = encodeURIComponent(f.id), dive = S.live && !REDUCED;
    return `<p class="mcard-k">${esc(f.place)} · <span data-f="id">${esc(f.id)}</span></p>
      <h3 id="explore-card-h">${esc(f.title)}</h3>
      <p class="mcard-meta">${esc(f.platform)}</p>
      <p class="mcard-line">Rebuilt from xclean's own live camera poses, not from ground truth.</p>
      <dl class="mcard-stats"><div><dt>Route</dt><dd>${esc(f.path)}</dd></div><div><dt>Duration</dt><dd>${esc(f.dur)}</dd></div>
        <div><dt>Keyframes</dt><dd>${esc(f.kf)}</dd></div><div><dt>Gaussians <span class="nb">(full map)</span></dt><dd>${esc(f.g)}</dd></div></dl>
      <p class="mcard-links">${dive ? `<button class="btn btn--ion ex-dive" type="button">Dive in<span class="sr"> to ${esc(f.title)} (${esc(f.id)})</span> <span class="arr" aria-hidden="true">↘</span></button>` : ''}<a class="btn${dive ? '' : ' btn--ion'}" href="viewer.html?map=${id}&amp;cam=pov">Explore in 3-D<span class="sr"> the ${esc(f.title)} map (${esc(f.id)})</span> <span class="arr" aria-hidden="true">→</span></a> <a class="mcard-lim" href="maps.html#lim-${id}">Known limits<span class="sr"> of ${esc(f.id)}</span></a></p>
      <p class="mcard-credit"><a class="lic" href="credits.html#maps">${esc(f.lic)}</a> <span class="when-wide">${esc(f.credit)}</span><span class="when-narrow">${esc(isRosario(m) ? `Source images: ${shortCredit(m)}.` : f.credit)}</span></p>`;
  }
  card.addEventListener('click', e => { if (e.target.closest('.ex-dive') && S.shown) world.dive(S.shown); });

  // ---------------------------------------------------------------- the dive bar
  barBack.addEventListener('click', () => world.surface());
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.diving) { e.preventDefault(); world.surface(); } });

  function render() {
    const id = S.on && !S.diving ? (S.hov || S.sel) : null;
    if (id !== S.shown) {
      S.shown = id;
      if (id) card.innerHTML = cardHTML(byId[id]);
    }
    chips.forEach(c => { const v = String(c.dataset.id === S.sel); if (c.getAttribute('aria-pressed') !== v) c.setAttribute('aria-pressed', v); });
    const ui = S.on && !S.diving;
    setOv(intro, ui && !id);
    setOv(nav, ui);
    setOv(card, !!id, true);
    setOv(foot, ui);
    setOv(bar, !!S.diving, true);
    if ((wrap.dataset.card === '1') !== !!id) wrap.dataset.card = id ? '1' : '';
    onChange({ card: id, diving: S.diving });
  }

  world.on(EVENTS.ISLAND, ({ id, why }) => {
    if (why === 'clear' || !id) { if (S.hov) S.hov = null; else S.sel = null; }
    else if (why === 'select') {
      S.sel = id; S.hov = null;
      rove(chipOf(id));
      const m = byId[id];
      if (m && S.on) say(`${m.title}, ${id}, ${shortCredit(m)}`);
    } else if (S.on) S.hov = id;                       // hover, focus
    render();
  });

  world.on(EVENTS.DIVE, ({ id, phase }) => {
    const m = byId[id];
    if ((phase === 'in' || phase === 'ride') && m && S.diving !== id) {
      const from = document.activeElement, inUi = sec.contains(from);
      S.diving = id;
      barT.innerHTML = `${esc(m.title)}<span>${esc(id)}</span>`;
      if (isRosario(m)) bar.dataset.rosario = '1'; else delete bar.dataset.rosario;
      barOpen.href = `viewer.html?map=${encodeURIComponent(id)}&cam=pov`;
      render();
      if (inUi) barBack.focus({ preventScroll: true });
      say(`Inside ${m.title}, ${id}. Escape returns to the atlas.`);
    } else if (phase === 'out') setOv(bar, false, true);
    else if (phase === 'done' && S.diving) {
      const back = bar.contains(document.activeElement) || document.activeElement === document.body;
      S.diving = null;
      render();
      if (back) { const c = chipOf(id); rove(c); c?.focus({ preventScroll: true }); }
    }
  });

  return {
    /** The explore beat is on screen (or not). */
    show(on) { if (S.on === on) return; S.on = on; if (!on) S.hov = null; render(); },
    /** live / still: the card offers "Dive in" only where the engine can fly. */
    mode(live) { if (S.live === live) return; S.live = live; S.shown = undefined; render(); },
    /** The replay clock of the dive, for "Open in the viewer" (it opens at the same moment, camera POV). */
    telemetry(id, t) { if (S.diving === id) barOpen.href = `viewer.html?map=${encodeURIComponent(id)}&t=${t.toFixed(1)}&cam=pov`; },
    get diving() { return S.diving; },
    get card() { return S.shown; },
  };
}
