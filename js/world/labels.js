// Island labels anchored in 3-D (MASTER_PLAN.md 2.6 / 4.4): HOME's <template id="tpl-island-label"> cloned once per
// island; the engine only moves them (transform) and toggles .on / .hi when that changes. aria-hidden, tabindex -1: the
// chips are the keyboard path. A greedy declutter keeps the most important labels (lifted / focus first, then the
// nearest) and hides any that would overlap one already placed. Updated at most labelHz times a second.

const FEATHERED = '.title-panel, .ex-intro';

export class Labels {
  /** host: the labels layer; tpl: the template; items: [{id, num, title, sub}]; onPick(id). */
  constructor(host, tpl, items, { onPick } = {}) {
    this.host = host;
    this.els = new Map();
    this.last = 0;
    this.shown = false;
    for (const it of items) {
      let el;
      if (tpl?.content?.firstElementChild) {
        el = tpl.content.firstElementChild.cloneNode(true);
        const f = k => el.querySelector(`[data-f="${k}"]`);
        if (f('num')) f('num').textContent = it.num;
        if (f('title')) f('title').textContent = it.title;
        if (f('sub')) f('sub').textContent = it.sub;
      } else {
        el = document.createElement('button');
        el.type = 'button';
        el.className = 'isl';
        el.textContent = `${it.num} ${it.title}`;
      }
      el.dataset.id = it.id;
      el.tabIndex = -1;
      el.setAttribute('aria-hidden', 'true');
      el.addEventListener('click', () => onPick?.(it.id));
      host.appendChild(el);
      this.els.set(it.id, { el, on: false, hi: false, w: 0, h: 0, x: NaN, y: NaN });
    }
    this.measure();
  }
  /**
   * Label sizes and the overlay boxes labels must keep out of (after a resize or a beat change): layout reads happen
   * here only. blockers: a CSS selector of HOME's panels.
   */
  measure(blockers = '') {
    for (const l of this.els.values()) { l.w = l.el.offsetWidth || 120; l.h = l.el.offsetHeight || 28; }
    // integrator (review DE, E-DE4): the big title panels have a feathered black edge (40 px blur): a label just outside
    // their box read half dimmed, so their boxes grow by 40 px on every side
    this.blocked = blockers ? [...document.querySelectorAll(blockers)].map(e => [e.getBoundingClientRect(), e.matches(FEATHERED) ? 40 : 0])
      .filter(([r]) => r.width > 0 && r.height > 0)
      .map(([r, g]) => [r.left - g, r.top - g, r.right + g, r.bottom + g]) : [];
  }
  /**
   * projected: scene.project() rows; state: {visible (labels wanted at all), hi: Set of ids, focus, minR, w, h, hz, now}.
   */
  update(projected, state) {
    if (state.now - this.last < 1000 / state.hz && state.visible === this.shown) return;
    this.last = state.now;
    this.shown = state.visible;
    const placed = [];
    const rows = projected.slice().sort((a, b) => (state.hi.has(b.id) - state.hi.has(a.id)) || (b.r - a.r));
    // the lifted / selected islands' bodies stay clear of other islands' labels: a label is a tap target, and one lying
    // over the selected island took the second tap (the dive) for its own island (landscape phones, islands overlap)
    const bodies = rows.filter(p => state.hi.has(p.id) && p.front && p.show > 0.5)
      .map(p => { const r = Math.max(26, 0.6 * p.r); return [p.c.x - r, p.c.y - r, p.c.x + r, p.c.y + r]; });
    for (const p of rows) {
      const l = this.els.get(p.id);
      if (!l) continue;
      let hi = state.hi.has(p.id);
      let on = state.visible && p.front && p.show > 0.5 && (p.r >= state.minR || hi)
        && p.top.x > -40 && p.top.x < state.w + 40 && p.top.y > 48 && p.top.y < state.h - 24;
      if (on) {
        const x0 = p.top.x - l.w / 2, y0 = p.top.y - l.h - 14;
        const hit = r => x0 < r[2] && x0 + l.w > r[0] && y0 < r[3] && y0 + l.h > r[1];
        if (this.blocked?.some(hit) || (!hi && bodies.some(hit))) on = false;
        else if (placed.some(hit)) on = hi;
        if (on) placed.push([x0 - 4, y0 - 4, x0 + l.w + 4, y0 + l.h + 4]);
      }
      hi = hi && on;
      if (on !== l.on) { l.on = on; l.el.classList.toggle('on', on); }
      if (hi !== l.hi) { l.hi = hi; l.el.classList.toggle('hi', hi); }
      if (on && !(Math.abs(p.top.x - l.x) <= 0.3 && Math.abs(p.top.y - l.y) <= 0.3)) {
        l.x = p.top.x; l.y = p.top.y;
        l.el.style.transform = `translate3d(${p.top.x.toFixed(1)}px, ${p.top.y.toFixed(1)}px, 0) translate(-50%, -100%)`;
      }
    }
  }
  hideAll() { for (const l of this.els.values()) if (l.on) { l.on = false; l.el.classList.remove('on'); } this.shown = false; }
  destroy() { for (const l of this.els.values()) l.el.remove(); this.els.clear(); }
}

/**
 * World-anchored DOM, generic (FACTS_WORLD_PLAN.md 2.2; chapter 2's signposts, marks.js): HOME's elements placed at
 * points the caller projects, in stage pixels. No layout read in a frame: sizes come from one ResizeObserver; the boxes
 * the elements keep clear of are read in measure() only (after a beat change, a resize, a change of the host's
 * data-avoid). place() writes a transform snapped to device pixels (sharp text), only when it moved; show() writes
 * data-vis, only on a change.
 */
export class Anchors {
  /** host: the layer the elements live in; stage: the stage element (projections are in its pixels); onSize(). */
  constructor(host, stage, { onSize } = {}) {
    this.host = host;
    this.stage = stage;
    this.items = [];
    this.bySize = new Map();
    this.boxes = [];             // [l, t, r, b] in stage px
    this.named = new Map();      // selector -> its first box
    this.off = [0, 0];           // the host's offset to the stage
    this.ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(es => {
      for (const e of es) {
        const h = this.bySize.get(e.target);
        if (!h) continue;
        const b = e.borderBoxSize?.[0] ?? e.borderBoxSize;
        h.w = b?.inlineSize ?? e.target.offsetWidth; h.h = b?.blockSize ?? e.target.offsetHeight;
      }
      onSize?.();
    });
  }
  /** el: the element moved (left 0, top 0 in the host); sizeEl: the one whose size the caller needs. A handle. */
  add(el, sizeEl = el) {
    const h = { el, sizeEl, w: 0, h: 0, x: NaN, y: NaN, s: 1, vis: el.hasAttribute('data-vis') };
    this.items.push(h);
    if (sizeEl) { this.bySize.set(sizeEl, h); this.ro?.observe(sizeEl, { box: 'border-box' }); }
    return h;
  }
  /**
   * The boxes to keep clear of (blockers: a comma-separated list of plain selectors; elements not displayed, not visible
   * or of no size are left out), the boxes of other elements the caller needs by name (also: not blockers), and the
   * host's offset to the stage. The only layout reads.
   */
  measure(blockers = '', also = '') {
    const sr = this.stage.getBoundingClientRect(), hr = this.host.getBoundingClientRect();
    this.off = [hr.left - sr.left, hr.top - sr.top];
    this.boxes = [];
    this.named.clear();
    const list = s => s.split(',').map(x => x.trim()).filter(Boolean);
    for (const [sel, blocks] of [...list(blockers).map(x => [x, true]), ...list(also).map(x => [x, false])]) {
      for (const e of document.querySelectorAll(sel)) {
        const r = e.getBoundingClientRect();
        if (r.width < 1 || r.height < 1 || getComputedStyle(e).visibility === 'hidden') continue;
        const b = [r.left - sr.left, r.top - sr.top, r.right - sr.left, r.bottom - sr.top];
        if (blocks) this.boxes.push(b);
        if (!this.named.has(sel)) this.named.set(sel, b);
      }
    }
  }
  /** The first measured box of one selector of the list (null when it had none). */
  box(sel) { return this.named.get(sel) || null; }
  /** Whether a box (stage px) comes within pad px of any measured box (but skip, one of them). */
  hits(b, pad = 0, skip = null) { return this.boxes.some(o => o !== skip && b[0] < o[2] + pad && b[2] > o[0] - pad && b[1] < o[3] + pad && b[3] > o[1] - pad); }
  /** Move a handle to the stage point (x, y), optionally stretched vertically by sy (transform origin: its top). */
  place(h, x, y, sy = 1) {
    const dpr = window.devicePixelRatio || 1;
    const X = Math.round((x - this.off[0]) * dpr) / dpr, Y = Math.round((y - this.off[1]) * dpr) / dpr;
    if (X === h.x && Y === h.y && Math.abs(sy - h.s) < 0.002) return;
    h.x = X; h.y = Y; h.s = sy;
    h.el.style.transform = sy === 1 ? `translate3d(${X}px, ${Y}px, 0)` : `translate3d(${X}px, ${Y}px, 0) scaleY(${sy.toFixed(3)})`;
  }
  show(h, on) { if (on !== h.vis) { h.vis = on; h.el.toggleAttribute('data-vis', on); } }
  destroy() { this.ro?.disconnect(); for (const h of this.items) this.show(h, false); this.items = []; this.bySize.clear(); }
}
