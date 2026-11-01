// The scroll timeline (MASTER_PLAN.md 1.2 / 3.3): HOME's [data-beat] elements, measured once (load, width or
// orientation change; never on a height-only resize), turned into scroll ranges. A beat starts when its element's top
// crosses data-anchor (default 0.7) of the stage height: y0 = document top - anchor x H. Beats are contiguous: each ends
// where the next begins, so the camera path has no gaps. Reading the ranges costs no layout.

export class Timeline {
  constructor(root) {
    this.root = root;
    this.beats = [];
    this.H = 1;
    this.storyTop = Infinity;
    this.curtain = [Infinity, Infinity];
    this.chapters = [];          // [{n, island, beats: {glide, dive, ride, pullback}, el}]
    this.measure();
  }
  /** Re-read the geometry (layout reads happen here only). */
  measure() {
    const root = this.root;
    const stage = root.querySelector('.stage');
    this.H = Math.max(1, stage?.offsetHeight || innerHeight);
    const H = this.H, sy = scrollY;
    const top = el => el.getBoundingClientRect().top + sy;
    const els = [...root.querySelectorAll('[data-beat]')];
    // a beat's chapter is the [data-chapter] section around it inside the world, never the world element itself: #world
    // carries the story's live data-chapter / data-island (core.js, Writer), so a re-measure inside a chapter (a phone
    // turned, a window resized) gave the hero, rise, atlas and explore beats that chapter, and the chapter the hero's
    // island: the camera flew to the hero island's ride pose and stayed there, even after the size went back
    const chapterOf = el => { const c = el.closest('[data-chapter]'); return c && c !== root && root.contains(c) ? c : null; };
    const beats = els.map((el, i) => {
      const ch = chapterOf(el);
      const anchor = Number.parseFloat(el.dataset.anchor ?? '0.7');
      const y0 = top(el) - (Number.isFinite(anchor) ? anchor : 0.7) * H;
      return {
        i, el, kind: el.dataset.beat, variant: el.dataset.variant || '',
        chapter: ch ? Number(ch.dataset.chapter) || 0 : 0,
        island: el.dataset.island || ch?.dataset.island || '',
        y0, y1: y0 + Math.max(1, el.offsetHeight),
      };
    });
    for (let i = 0; i < beats.length - 1; i++) beats[i].y1 = Math.max(beats[i].y0 + 1, beats[i + 1].y0);
    this.beats = beats;
    const story = document.querySelector('[data-world-end]');
    this.storyTop = story ? top(story) : (beats.length ? beats[beats.length - 1].y1 + 0.7 * H : Infinity);
    this.curtain = [this.storyTop - 0.9 * H, this.storyTop - 0.45 * H];
    // the page under the world (the story's sections, then what follows their parent: the footer), document top and
    // bottom of each, so a re-measure can put a reader there back in the same place (placeAt / yAt)
    this.tail = [];
    for (let up = story; up && up !== document.body; up = up.parentElement) {
      for (let e = up === story ? up : up.nextElementSibling; e; e = e.nextElementSibling) {
        const r = e.getBoundingClientRect();
        if (r.height > 0) this.tail.push({ el: e, y0: r.top + sy, y1: r.bottom + sy });
      }
    }
    this.maxY = Math.max(0, (document.scrollingElement || document.documentElement).scrollHeight - innerHeight);
    const chs = new Map();
    for (const b of beats) {
      if (!b.chapter) continue;
      if (!chs.has(b.chapter)) chs.set(b.chapter, { n: b.chapter, island: b.island, beats: {}, el: chapterOf(b.el) });
      chs.get(b.chapter).beats[b.kind] = b;
    }
    this.chapters = [...chs.values()].sort((a, b) => a.n - b.n);
    return this;
  }
  /** {beat, p} at scroll y (p in [0, 1] inside the beat; clamped at both ends of the page). */
  beatAt(y) {
    const B = this.beats;
    if (!B.length) return { beat: null, p: 0 };
    let lo = 0, hi = B.length - 1;
    if (y < B[0].y0) return { beat: B[0], p: 0 };
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (B[m].y0 <= y) lo = m; else hi = m - 1; }
    const b = B[lo];
    return { beat: b, p: Math.min(1, Math.max(0, (y - b.y0) / (b.y1 - b.y0))) };
  }
  /**
   * Where a reader at scroll y is once past the last beat (null inside the beats, where beatAt holds): in the curtain,
   * {curtain: (y - storyTop) / H}, which keeps the fade; under the world, {el, f}: the element of the page under it
   * that the viewport's top is in, and how far into it; at the page's end, {end: true} (it stays there).
   */
  placeAt(y) {
    const B = this.beats, T = this.tail;
    if (!B.length || y < B[B.length - 1].y1) return null;
    if (!T.length || y < T[0].y0) return { curtain: (y - this.storyTop) / this.H };
    if (y >= this.maxY - 2) return { end: true };
    let k = 0;
    while (k + 1 < T.length && T[k + 1].y0 <= y) k++;
    return { el: T[k].el, f: Math.min(1, (y - T[k].y0) / Math.max(1, T[k].y1 - T[k].y0)) };
  }
  /** The scroll y of a placeAt() place in the current geometry (null when its element has gone). */
  yAt(pl) {
    if (pl.curtain != null) return this.storyTop + pl.curtain * this.H;
    if (pl.end) return this.maxY;
    const t = this.tail.find(x => x.el === pl.el);
    return t ? t.y0 + pl.f * (t.y1 - t.y0) : null;
  }
  find(kind, chapter = 0) { return this.beats.find(b => b.kind === kind && (!chapter || b.chapter === chapter)) || null; }
  /** The stage's fade to black under the story's entry (0..1, easeInQuad). */
  out(y) {
    const [a, b] = this.curtain;
    if (!(b > a)) return 0;
    const k = Math.min(1, Math.max(0, (y - a) / (b - a)));
    return k * k;
  }
}

export function buildTimeline(root) { return new Timeline(root); }
