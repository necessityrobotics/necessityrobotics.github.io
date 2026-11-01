// The still path (T0; MASTER_PLAN.md 2.5): the same beats, events and DOM state as the live world, from the scroll
// alone, with no three.js or Spark. Posters cross-fade for the hero and the rides (the chapters' skies darkened by CSS);
// the atlas beats show the 2-D atlas (atlasmap.js), which pans to the next island as you scroll; the minimap, cards and
// chapter 2's fact dock run as in 3-D. A parallax look-around moves the poster, except under reduced motion. Also the fallback
// the live world drops to (governor floor, a slow link, repeated context losses).
import { EVENTS, _emit } from './api.js';
import { log, setInfo } from './debug.js';
import { Pace, Story, Posters, Hud } from './core.js';
import { attachInput } from './input.js';
import { buildTimeline } from './timeline.js';
import { AtlasMap } from './atlasmap.js';
import { lerp, ease } from './camera.js';

export function start({ maps, atlas, routes, root, why = '', tier = 'T0', timeline = null, reduced = false }) {
  const tl = timeline || buildTimeline(root);
  const story = new Story({ root, atlas, maps, routes, timeline: tl });
  const posters = new Posters(root);
  const byId = Object.fromEntries(maps.maps.map(m => [m.id, m]));
  const titles = Object.fromEntries(atlas.order.map(id => [id, byId[id]?.title || id]));
  const hud = new Hud(root, story, atlas, titles);
  const pace = new Pace();
  const stage = root.querySelector('.stage');
  const media = root.querySelector('.stage-media') || stage;
  const dip = root.querySelector('.stage-dip');
  if (dip) dip.style.opacity = '0';
  let a2 = media.querySelector('canvas.stage-atlas2d');
  if (!a2) {
    a2 = document.createElement('canvas');
    a2.className = 'stage-atlas2d';
    a2.setAttribute('aria-hidden', 'true');
    media.insertBefore(a2, root.querySelector('.stage-dip'));
  }
  const amap = new AtlasMap(a2, atlas, { labels: true, titles, pad: 24 });
  const [bx0, bz0, bx1, bz1] = amap.bounds, mid = [(bx0 + bx1) / 2, (bz0 + bz1) / 2];
  const at = id => [atlas.islands[id].place.x, atlas.islands[id].place.z];
  story.w.attr('mode', 'still');
  story.w.attr('tier', tier);
  story.w.attr('why', why);
  story.w.attr('level', 0);
  story.w.attr('load', 'poster');
  _emit(EVENTS.MODE, { mode: 'still', tier, level: 0, why });
  log('mode', null, { mode: 'still', tier, why, phone: matchMedia('(pointer: coarse)').matches });

  let raf = 0, last = performance.now(), onscreen = true, alive = true;
  const input = attachInput(root, {
    reduced,
    onLook: () => wake(),
    onTap: (x, y) => {
      if (story.S.kind !== 'explore') return;
      const r = a2.getBoundingClientRect();
      const id = amap.pick(x - r.left, y - r.top);
      if (id) impl.select(id, { why: 'tap' });
    },
    onType: t => story.w.attr('input', t),
  });

  function wake() { if (!raf && onscreen && alive) raf = requestAnimationFrame(frame); }
  function frame(now) {
    raf = 0;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const y = scrollY;
    const S = story.update(y, now, {});
    const kind = S.kind, p = S.p;
    // the stage: posters for the hero and the rides, the 2-D atlas for the atlas beats
    let posterId = '', posterA = 0, atlasA = 0, centre = null, zoom = 1;
    if (kind === 'hero') { posterId = story.heroId; posterA = 1; }
    else if (kind === 'rise') {
      // the hero's poster gives way to the 2-D atlas, zoomed on the street's island
      posterId = story.heroId; posterA = 1 - Math.min(1, p / 0.7);
      atlasA = Math.min(1, Math.max(0, (p - 0.3) / 0.5));
      centre = at(story.heroId); zoom = lerp(2.4, 1.6, p);
    } else if (kind === 'atlas') {
      const k = ease.easeInOutSine(Math.min(1, p / 0.55));
      atlasA = 1; centre = [lerp(at(story.heroId)[0], mid[0], k), lerp(at(story.heroId)[1], mid[1], k)]; zoom = lerp(1.6, 1, k);
    } else if (kind === 'explore') atlasA = 1;
    else if (kind === 'glide') {
      // pan from the whole atlas to the chapter's island
      const k = ease.smootherstep(p);
      atlasA = 1; centre = [lerp(mid[0], at(S.island)[0], k), lerp(mid[1], at(S.island)[1], k)]; zoom = lerp(1, 2.2, k);
    } else { posterId = S.island; posterA = 1; }
    posters.only(posterId, posterA);
    posters.current(posterId || S.island);
    a2.style.opacity = atlasA.toFixed(2);
    if (atlasA > 0) amap.draw({ centre, zoom, focus: S.island, hi: new Set(story.selected ? [story.selected] : []) });
    const rosarioVisible = (posterA > 0.05 && posterId.startsWith('rosario_')) || atlasA > 0.05;
    story.w.attr('rosario', rosarioVisible && tl.out(y) < 0.999 ? '1' : '');
    // parallax look-around on the poster (not under reduced motion)
    const L = input.look, more = !reduced && input.step(dt);
    const im = posters.img.get(posterId);
    if (im && !reduced) im.style.transform = `translate3d(${(-L.x * 60).toFixed(1)}px, ${(-L.y * 40).toFixed(1)}px, 0) scale(1.06)`;
    story.w.css(stage, '--out', tl.out(y));
    story.w.css(stage, '--atlas', atlasA);
    hud.frame(now, S, { hi: new Set(story.selected ? [story.selected] : []) });
    story.progress();
    if (more) wake();
  }
  const onScroll = () => { pace.onScroll(); posters.flick(Math.abs(pace.read().vInst) > 2.5 * tl.H); wake(); };
  addEventListener('scroll', onScroll, { passive: true });
  let lastW = innerWidth, lastO = screen.orientation?.angle;
  const onResize = () => {
    // height only: the address bar (the stage, 100lvh, keeps its height) is ignored; a real window resize is not
    if (innerWidth === lastW && screen.orientation?.angle === lastO && Math.abs((stage?.offsetHeight || 0) - tl.H) < 2) return;
    lastW = innerWidth; lastO = screen.orientation?.angle;
    story.remeasure(pace.y); hud.resize(); amap.resize(); wake();
  };
  addEventListener('resize', onResize, { passive: true });
  const io = new IntersectionObserver(es => { onscreen = es[0].isIntersecting; if (onscreen) { last = performance.now(); wake(); } });
  io.observe(root);
  wake();

  const impl = {
    select(id, { why = 'chip' } = {}) {
      story.selected = id;
      _emit(EVENTS.ISLAND, { id, why: 'select', via: why });
      wake();
      return Promise.resolve({ id, mode: 'still' });
    },
    dive(id) { return Promise.resolve({ id, mode: 'still', href: `viewer.html?map=${encodeURIComponent(id)}&cam=pov` }); },
    surface() { return Promise.resolve(false); },
    goto(target, opts = {}) {
      const m = /^island:(.+)$/.exec(target);
      if (m && !tl.chapters.some(c => c.island === m[1])) story.selected = m[1];
      return story.goto(target, { ...opts, reduced });
    },
    tilt(on) { return reduced ? Promise.resolve('unavailable') : input.tilt(on); },
    info() { return { mode: 'still', tier, why, beat: story.S.kind, p: +story.S.p.toFixed(3), chapter: story.S.chapter, island: story.S.island, selected: story.selected }; },
    destroy() {
      alive = false;
      cancelAnimationFrame(raf);
      removeEventListener('scroll', onScroll);
      removeEventListener('resize', onResize);
      io.disconnect();
      input.detach();
    },
  };
  setInfo(() => impl.info());
  return impl;
}
