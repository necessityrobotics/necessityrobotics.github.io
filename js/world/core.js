// The part of the world that runs the same in every mode (live 3-D or still 2-D): the scroll's pace, the story state
// (which beat, how far into it, which island, the replay clock), the events and #world's data-* state, the posters, the
// HUD's minimaps and readouts, and scroll targets for world.goto(). No three.js. (The rail's aria-current is HOME's.)
import { EVENTS, _emit, _progress } from './api.js';
import { log } from './debug.js';
import { Track } from '../tour/track.js';
import { Minimap } from '../tour/minimap.js';
import { AtlasMap } from './atlasmap.js';
import { rideU } from './director.js';


const fmtLen = m => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(0)} m`);
export const CH_EXPLORE = 4;

/** The visitor's scrolling: instantaneous speed, the 12 s average including pauses, and the direction of travel. */
export class Pace {
  constructor() { this.y = scrollY; this.t = performance.now(); this.v = 0; this.hist = []; this.dir = 1; this.engaged = false; }
  onScroll() {
    const now = performance.now(), y = scrollY, dt = Math.max(1, now - this.t);
    this.v = this.v * 0.55 + ((y - this.y) / dt * 1000) * 0.45;
    this.hist.push([now, y]);
    while (this.hist.length && now - this.hist[0][0] > 12000) this.hist.shift();
    if (y !== this.y) this.dir = Math.sign(y - this.y);
    if (Math.abs(y - this.y) > 2) this.engaged = true;
    this.y = y; this.t = now;
  }
  read() {
    const now = performance.now();
    if (now - this.t > 180) this.v *= Math.exp(-(now - this.t - 180) / 200);
    let ad = 0;
    for (let k = 1; k < this.hist.length; k++) ad += Math.abs(this.hist[k][1] - this.hist[k - 1][1]);
    const span = this.hist.length > 1 ? Math.max(2000, now - this.hist[0][0]) : 0;
    return { vInst: this.v, vAvg: span ? ad / span * 1000 : 0, dir: this.dir, engaged: this.engaged };
  }
}

/** Write an attribute / CSS variable only when it changes. */
export class Writer {
  constructor(el) { this.el = el; this.a = {}; this.v = {}; }
  attr(name, val) {
    const v = val == null || val === '' ? null : String(val);
    if (this.a[name] === v) return;
    this.a[name] = v;
    if (v == null) this.el.removeAttribute(`data-${name}`); else this.el.setAttribute(`data-${name}`, v);
  }
  /** A CSS variable, written when it moves by more than eps (or lands exactly on 0 or 1). */
  css(el, name, val, eps = 0.002) {
    const old = this.v[name];
    if (old === val || (old != null && Math.abs(old - val) <= eps && val !== 0 && val !== 1)) return;
    this.v[name] = val;
    el.style.setProperty(name, val.toFixed(3));
  }
}

/** The posters in the stage: one per island; loaded on demand; shown at an opacity (CSS fades them). */
export class Posters {
  constructor(root) {
    this.root = root;
    this.host = root.querySelector('[data-world="posters"]') || root.querySelector('.stage-posters');
    this.img = new Map();
    for (const im of this.host?.querySelectorAll('img[data-island]') || []) this.img.set(im.dataset.island, im);
    this.op = new Map();
    this.cur = null;
  }
  load(id) {
    const im = this.img.get(id);
    if (im && !im.getAttribute('src') && im.dataset.src) { im.decoding = 'async'; im.src = im.dataset.src; log('poster', null, { id }); }
  }
  set(id, a) {
    const im = this.img.get(id);
    if (!im) return;
    const v = Math.round(a * 100) / 100;
    if (this.op.get(id) === v) return;
    this.op.set(id, v);
    if (v > 0) this.load(id);
    im.style.opacity = String(v);
  }
  /** Every poster but `keep` goes to 0. */
  only(keep, a) { for (const id of this.img.keys()) this.set(id, id === keep ? a : 0); }
  current(id) {
    if (this.cur === id) return;
    if (this.cur) this.img.get(this.cur)?.removeAttribute('data-cur');
    this.cur = id;
    this.img.get(id)?.setAttribute('data-cur', '');
  }
  flick(on) { this.host?.classList.toggle('is-flick', on); }
}

/**
 * The story state machine. update(y, extra) -> S = {beat, kind, variant, p, chapter, island, t, d, len, ch}; emits
 * world:beat on a change of beat, and the per-frame progress.
 */
export class Story {
  constructor({ root, atlas, maps, routes, timeline }) {
    this.root = root; this.A = atlas; this.tl = timeline;
    this.maps = Object.fromEntries(maps.maps.map(m => [m.id, m]));
    this.heroId = atlas.hero?.id || atlas.order[0];
    this.route = {};
    for (const [id, r] of Object.entries(routes.routes || {})) this.route[id] = Track.fromRoute(r.pts);
    this.trackFor = id => this.route[id];          // live replaces it with xclean's own track once it has arrived
    this.w = new Writer(root);
    this.S = { beat: null, kind: '', variant: '', p: 0, chapter: 0, island: '', t: null, d: null, len: null, ch: 0 };
    this.selected = '';
    this.dive = null;            // {id, t} while an explore dive rides
    this.lastTele = 0;
    this.lastTo = null;          // the last re-measure's target {y (unrounded), px}
    // a smooth goto in flight {target, top, t}: until it arrives, the reader's own input, or 4 s
    this.going = null;
    for (const ev of ['wheel', 'touchstart', 'pointerdown', 'keydown']) addEventListener(ev, () => { this.going = null; }, { passive: true, capture: true });
  }
  islandOf(kind, b) {
    if (this.dive) return this.dive.id;
    if (kind === 'hero' || kind === 'rise') return this.heroId;
    if (kind === 'atlas') return '';
    if (kind === 'explore') return this.selected;
    return b?.island || '';
  }
  /** y: scrollY; extra: {heroT, capT, yaw}. */
  update(y, now, extra = {}) {
    if (this.going && Math.abs(y - this.going.top) <= 2) this.going = null;      // the smooth goto arrived
    const { beat, p } = this.tl.beatAt(y);
    const S = this.S;
    const kind = beat?.kind || 'hero';
    const prevKind = S.kind, prevCh = S.chapter;
    S.beat = beat; S.kind = kind; S.variant = beat?.variant || ''; S.p = p; S.chapter = beat?.chapter || 0;
    S.island = this.islandOf(kind, beat);
    S.ch = kind === 'explore' ? CH_EXPLORE : S.chapter;
    // the replay clock along the island's route
    const id = S.island, A = this.A.islands[id];
    let t = null;
    if (this.dive) t = this.dive.t;
    else if (kind === 'hero') t = extra.heroT ?? this.A.hero?.t0;
    else if (kind === 'rise') t = extra.capT ?? extra.heroT ?? this.A.hero?.t0;
    else if (A?.ride && kind === 'dive') t = A.ride.t0;
    else if (A?.ride && kind === 'pullback') t = A.ride.t1;
    else if (A?.ride && kind === 'ride') {
      const tr = this.trackFor(id), u = rideU(S.variant, p);
      t = tr && A.ride.d0 != null ? tr.timeAt(A.ride.d0 + u * (A.ride.d1 - A.ride.d0)) : A.ride.t0 + u * (A.ride.t1 - A.ride.t0);
    }
    const rt = this.route[id];
    S.t = t; S.d = t != null && rt ? rt.dist(t) : null; S.len = rt ? rt.length : null;
    S.yaw = extra.yaw || 0;
    S.heroT = extra.heroT ?? this.A.hero?.t0;
    if (kind !== prevKind || S.chapter !== prevCh) {
      const dir = this.tl.beats.indexOf(beat) >= (this.prevIndex ?? -1) ? 1 : -1;
      this.prevIndex = this.tl.beats.indexOf(beat);
      this.w.attr('beat', kind);
      this.w.attr('chapter', S.chapter || '');
      log('enter', S.ch, { beat: kind, from: prevKind || null, y: Math.round(y) });
      _emit(EVENTS.BEAT, { beat: kind, chapter: S.chapter, island: S.island, dir, from: prevKind || null, variant: S.variant });
    }
    this.w.attr('island', S.island);
    if (S.island !== this.lastIsland) {
      this.lastIsland = S.island;
      _emit(EVENTS.ISLAND, { id: S.island, why: S.island ? 'focus' : 'clear' });
    }
    if (now - this.lastTele >= 100 && S.t != null) {
      this.lastTele = now;
      _emit(EVENTS.TELEMETRY, { id: S.island, t: +S.t.toFixed(2), d: S.d != null ? +S.d.toFixed(1) : null, len: S.len != null ? +S.len.toFixed(1) : null });
    }
    return S;
  }
  progress() {
    const S = this.S;
    _progress({ beat: S.kind, p: S.p, chapter: S.chapter, island: S.island, t: S.t, d: S.d, len: S.len, yaw: S.yaw, variant: S.variant });
  }
  /** Scroll positions for world.goto(). */
  yOf(target) {
    const tl = this.tl, f = (b, k) => (b ? b.y0 + k * (b.y1 - b.y0) : null);
    if (target === 'hero') return 0;
    if (target === 'atlas') return f(tl.find('atlas'), 0.62);
    if (target === 'explore') return f(tl.find('explore'), 0.12);
    if (target === 'story') return tl.storyTop;
    const m = /^chapter:(\d+)$/.exec(target);
    if (m) return f(tl.find('ride', Number(m[1])), 0.02);
    const i = /^island:(.+)$/.exec(target);
    if (i) {
      const ch = tl.chapters.find(c => c.island === i[1]);
      return ch ? f(ch.beats.ride, 0.02) : i[1] === this.heroId ? 0 : f(tl.find('explore'), 0.12);
    }
    return null;
  }
  goto(target, { smooth = true, reduced = false } = {}) {
    const y = this.yOf(target);
    if (y == null) return Promise.resolve(false);
    const top = Math.max(0, Math.round(y)), sm = smooth && !reduced;
    this.going = sm ? { target, top, t: performance.now() } : null;
    window.scrollTo({ top, behavior: sm ? 'smooth' : 'auto' });
    return Promise.resolve(true);
  }
  /**
   * A width / orientation change: re-measure, and keep the reader on the same beat at the same progress (RA-3). y0: the
   * reader's scroll before the change (the last scroll event's): by the resize event the browser has already moved
   * scrollY on its own, clamped to the shorter page (a story reader turning a phone) or restored
   */
  remeasure(y0 = scrollY) {
    const tl = this.tl;
    // a resize during a smooth goto (a rail link): the smooth scroll was stopped where it was (re-placed at the same
    // beat and progress, part-way); it goes on to the goto's target as re-measured
    const g = this.going;
    this.going = null;
    if (g && performance.now() - g.t < 4000 && Math.abs(y0 - g.top) > 2) {
      tl.measure();
      const y = this.yOf(g.target);
      if (y != null) {
        this.lastTo = null;
        this.going = { ...g, top: Math.max(0, Math.round(y)) };
        window.scrollTo({ top: this.going.top, behavior: 'smooth' });
        return;
      }
    }
    // a window edge dragged re-measures at every frame with no scroll of the reader's in between: go on from the last
    // re-measure's own target, unrounded (the whole-pixel rounding added up: 0.016 of chapter 1's glide in 20 steps)
    if (this.lastTo && Math.abs(y0 - this.lastTo.px) <= 1) y0 = this.lastTo.y;
    const { beat, p } = tl.beatAt(y0);
    const i = tl.beats.indexOf(beat), atTop = y0 < 2;
    // past the last beat (the curtain, the story under the world, the footer) the reader keeps their place there: the
    // beat's progress is clamped at 1 there, so a phone turned while reading the story was put back at the end of the
    // explore beat, into the world (up to 9000 px up)
    const place = tl.placeAt(y0);
    tl.measure();
    const b = tl.beats[i];
    const y = place ? tl.yAt(place) : b && !atTop ? b.y0 + p * (b.y1 - b.y0) : null;
    this.lastTo = y != null && Number.isFinite(y) ? { y, px: Math.max(0, Math.round(y)) } : null;
    if (this.lastTo && Math.abs(this.lastTo.px - scrollY) > 1) window.scrollTo({ top: this.lastTo.px, behavior: 'auto' });
  }
}

/** The HUD's live parts: the ride minimap, the atlas minimap, the state chip and the readout. */
export class Hud {
  constructor(root, story, atlas, titles) {
    this.story = story;
    const q = s => root.querySelector(`[data-world="${s}"]`);
    this.miniC = q('minimap'); this.atlasC = q('atlasmap'); this.stateEl = q('state'); this.teleEl = q('telemetry');
    this.mini = this.miniC ? new Minimap(this.miniC, q('scale')) : null;
    this.amap = this.atlasC ? new AtlasMap(this.atlasC, atlas, { titles }) : null;
    this.miniFor = null; this.lastMini = 0; this.lastTele = 0; this.stateTxt = null;
    // the boxes change size between beats (chapter 3's map-vs-view): re-bake at the new size, redraw on the next frame
    // integrator: the re-bake runs on the next frame, not inside the observer (a canvas resize inside it raised WebKit's
    // "ResizeObserver loop completed with undelivered notifications" when the still path built a second HUD)
    let roT = 0;
    const ro = new ResizeObserver(() => { if (!roT) roT = requestAnimationFrame(() => { roT = 0; this.mini?.resize(); this.amap?.resize(); this.lastMini = 0; this.miniFor = null; }); });
    for (const c of [this.miniC, this.atlasC]) if (c) ro.observe(c);
  }
  resize() { this.mini?.resize(); this.amap?.resize(); }
  /** One HUD frame (throttled to 30 Hz). cam: {x, z, heading} for the atlas minimap. */
  frame(now, S, { cam = null, hi = new Set() } = {}) {
    if (now - this.lastMini < 33) return;
    this.lastMini = now;
    const id = S.island, A = this.story.A.islands[id];
    if (this.mini && id && this.story.route[id] && (S.kind === 'ride' || S.kind === 'dive' || S.kind === 'pullback' || S.kind === 'hero' || this.story.dive)) {
      const seg = this.story.dive ? [A.dive.t0, A.dive.t1] : A?.ride ? [A.ride.t0, A.ride.t1] : [this.story.A.hero.t0, this.story.A.hero.t1];
      const key = `${id}:${seg.join(',')}`;
      if (this.miniFor !== key) { this.miniFor = key; this.mini.set(this.story.route[id], seg); }
      if (S.t != null) this.mini.draw(S.t, S.yaw);
    }
    if (this.amap && (S.kind === 'explore' || S.kind === 'atlas' || S.kind === 'glide')) this.amap.draw({ focus: S.island, hi, cam });
    if (this.teleEl && now - this.lastTele > 120) {
      this.lastTele = now;
      const txt = S.t != null && S.d != null && S.len ? `${fmtLen(Math.max(0, S.d))} of ${fmtLen(S.len)} · ${S.t.toFixed(1)} s into the replay` : '';
      if (this.teleEl.textContent !== txt) this.teleEl.textContent = txt;
    }
  }
  state(txt, s) {
    if (!this.stateEl || this.stateTxt === txt) return;
    this.stateTxt = txt;
    this.stateEl.textContent = txt;
    if (s) this.stateEl.dataset.s = s;
  }
}


