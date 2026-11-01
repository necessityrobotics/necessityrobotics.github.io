// Home page overlays (website_nr3/MASTER_PLAN.md sections 1.2-1.5, 2.6, 3.1-3.3): the 2-D layer over the world.
// The engine (js/world) reports where the visitor is (world:beat, onProgress) and what the stage shows (world:mode,
// world:layer, world:island, world:dive, world:telemetry). This module turns that into a few attribute changes on the
// overlay elements, written only when a state changes; the one per-frame write is the rail's fill (a transform).
// Chapter 2's facts in the world (its signposts and the strip's fact cap) are signposts.js, driven from view() below.
// Every motion is CSS (opacity / transform). Rules kept on every beat: at most one text block, always on its own
// backing; the Rosario credit whenever a Rosario map may be in view; "not camera video" in every ride.
import { REDUCED } from '../site.js';
import { EVENTS } from '../world/api.js';
import { fillMap, isRosario } from './facts.js';
import { setOv, startExplore } from './explore.js';
import { startSignposts } from './signposts.js';

// index.html ships <html class="ov">: the overlays are pinned from the first paint and wait, hidden, for their beats. If
// the data never arrive and startOverlays is never called, they fall back to the plain panels of the no-script page
// instead of staying hidden.
const doc = document.documentElement;
const giveUp = setTimeout(() => doc.classList.remove('ov'), 10000);

const PHONE = matchMedia('(max-width: 760px)');
const SHORT = matchMedia('(orientation: landscape) and (max-height: 500px)');   // phones on their side
const LOW = matchMedia('(max-width: 760px) and (max-height: 700px)');           // short phones: the slim dock
const FINE = matchMedia('(hover: hover) and (pointer: fine)');
const CH_BEATS = ['glide', 'dive', 'ride', 'pullback'];
// beat thresholds (progress p in the beat), from the storyboard. strip: the card hands the screen to the ride early
// (review DE: the card is read through the glide and the dive; the ride is the payoff, and the card covered a third of it).
// facts: chapter 2's facts in the world, from the end of the look beat to the end of the ride (run to the end: the strip
// stays, so nothing flashes back), one fact per window; startOverlays reads them from atlas.json (ride.marks.p, the
// thresholds the engine's signposts use too). Chapter 2's ride is 2.2 x the length it was (187 lvh: the facts beat has
// about a third of a screen per fact; js/world/director.js rideU) and its way in and look beat keep their scroll, in its
// first quarter: its strip and hint thresholds are the old ones x 0.25 / 0.55 (strip2: 0.2 there, hint: 0.30 - 0.55)
const C2 = 0.25 / 0.55;
const P = { rise: 0.8, title: 0.06, cardIn: 0.4, strip: 0.2, strip2: 0.2 * C2, facts: [0.25, 0.4375, 0.625, 0.8125, 1.0], hint: [0.3 * C2, 0.25],
  split: 0.12, cap: 0.2, exOut: 0.82, land: 0.5 };
const FACTS_ID = 'oak_161206';
/** One number for where the reader is along the story (chapter x 10 + beat + p), to tell the way into a beat. */
const pos = (beat, ch, p) => { const k = CH_BEATS.indexOf(beat); return k >= 0 && ch ? ch * 10 + k + p : beat === 'explore' ? 40 + p : p; };
/** Chapter 2's layout for the facts: cards hung in the world, the slim strip on a phone's side, or the dock on phones. */
const layout = () => (SHORT.matches ? 'slim' : PHONE.matches ? (LOW.matches ? 'dock-slim' : 'dock') : 'cards');

export function startOverlays(world, { maps, atlas }) {
  clearTimeout(giveUp);
  doc.classList.add('ov');
  const W = document.getElementById('world');
  const mk = atlas?.islands?.[FACTS_ID]?.ride?.marks;
  if (mk?.p?.length === 5) P.facts = mk.p.slice();
  const byId = Object.fromEntries(maps.maps.map(m => [m.id, m]));
  const order = (atlas?.order || maps.maps.map(m => m.id)).filter(id => byId[id]);

  // static texts refreshed from the data (the HTML carries the same values, so nothing moves)
  W.querySelectorAll('[data-map]').forEach(el => { const m = byId[el.dataset.map]; if (m) fillMap(el, m); });
  W.querySelectorAll('[data-f="n-maps"]').forEach(e => { e.textContent = String(order.length); });

  const hud = W.querySelector('.world-hud');
  const credit = hud.querySelector('.world-credit');
  const tiltBtn = hud.querySelector('.hud-tilt'), tiltMsg = hud.querySelector('.hud-tilt-msg');
  const heroChip = W.querySelector('.hero-state');
  const rise = W.querySelector('.rise-panel'), title = W.querySelector('.title-panel');
  const railIn = W.querySelector('.rail-in'), railFill = W.querySelector('.rail-track i');
  const railLinks = [...W.querySelectorAll('.rail-list a')];
  const sayEl = document.getElementById('world-say');
  const chapters = [1, 2, 3].map(n => {
    const el = document.getElementById(`ch-${n}`);
    return { n, el, id: el.dataset.island, card: el.querySelector('.ch-card'), strip: el.querySelector('.strip'), cap: el.querySelector('.ch-cap'),
      split: el.querySelector('.split-note') };
  });
  // "Explore in 3-D" links per map: they hand the replay moment to the viewer (?map=&t=&cam=pov)
  const explore = new Map();
  W.querySelectorAll('[data-explore]').forEach(a => {
    const id = a.closest('[data-map]')?.dataset.map;
    if (id) { if (!explore.has(id)) explore.set(id, []); explore.get(id).push(a); }
  });

  // ---------------------------------------------------------------- the polite live region (never per frame)
  let sayT = 0;
  const say = text => { clearTimeout(sayT); sayT = setTimeout(() => { sayEl.textContent = text; }, 150); };

  // ---------------------------------------------------------------- state
  const st = world.state();
  // kbd: keyboard focus is inside chapter 2's card; pos: where the last progress put the reader (pos() below); seen: the
  // position at the last render (a lower one now: the reader came back into a state)
  const S = { beat: st.beat || 'hero', ch: +st.chapter || 0, p: 0, mode: st.mode || W.dataset.mode || 'still', tilt: true, rail: -1, key: '',
    kbd: false, pos: -1, seen: -1, kbdWas: false };
  // chapter 2's facts in the world (after fillMap above: the numbers are split from their final text)
  const sp = startSignposts(world, { W, layer: W.querySelector(`.sp-layer[data-island="${FACTS_ID}"]`), ride: document.querySelector('#ch-2 > [data-beat="ride"]') });
  const ex = startExplore(world, { byId, order, say, onChange: () => render() });
  ex.mode(S.mode === 'live');

  const flag = (el, k, on) => { if (on) { if (el.dataset[k] !== '1') el.dataset[k] = '1'; } else if (k in el.dataset) delete el.dataset[k]; };

  /** What each overlay should show for the current beat and progress. */
  function view() {
    const { beat, ch, p } = S, phone = PHONE.matches, compact = phone || SHORT.matches, lay = layout(), dock = lay.startsWith('dock');
    const inCh = ch >= 1 && ch <= 3 && CH_BEATS.includes(beat);
    const v = { card: 0, strip: 0, cap: 0, facts: false, fk: -1, kbd: false, lay, dock, phone, split: false, hint: false, mini: false,
      rise: beat === 'rise' && p >= P.rise, title: beat === 'atlas' && p >= P.title, explore: beat === 'explore' && p < P.exOut,
      rail: inCh || beat === 'explore', at: beat === 'explore' ? 'explore' : inCh ? String(ch) : '' };
    if (inCh) {
      if (beat === 'glide') v.card = p >= P.cardIn ? ch : 0;
      else if (beat === 'dive') { if (compact && p >= P.land) v.strip = ch; else v.card = ch; }   // small screens: the landing gets the screen
      else if (beat === 'ride') {
        // chapter 2's facts in the world: the strip stays (its licence, caveat and link through the whole beat), the
        // current fact hangs from its signpost (or sits in the strip's cap on phones). Keyboard focus in chapter 2's card
        // keeps the card on screen instead (the strip and the cards go; graft from K1)
        const F = P.facts, inFacts = ch === 2 && p >= F[0];
        v.facts = inFacts && !S.kbd;
        v.kbd = inFacts && S.kbd;
        v.fk = inFacts ? F.slice(0, 4).reduce((k, t) => k + (p >= t ? 1 : 0), 0) - 1 : -1;
        v.split = ch === 3 && p >= P.split;
        if (v.kbd) v.card = ch;
        // map vs view takes the strip at once: the full card beside the split view was a second panel over the POV half
        else if (compact || v.split || p >= (ch === 2 ? P.strip2 : P.strip)) v.strip = ch; else v.card = ch;
        v.hint = ch === 2 && p >= P.hint[0] && p < P.hint[1];
        // phones (a phone on its side too): the signpost has the screen; the top view goes (the tilt button stays)
        v.mini = !v.split && !(v.facts && phone);
      } else if (beat === 'pullback' && ch !== 3) v.cap = p >= P.cap ? ch : 0;
    }
    const diving = ex.diving;
    if (diving) v.mini = true;
    // the Rosario credit: forced on the stage where Rosario islands may be in view (the engine adds data-rosario on
    // #world from its own projection), unless a panel on screen already carries it. Chapter 1's pull-back is forced too:
    // before its caption (p < P.cap) nothing carries the credit, and a live page whose 3-D side has not arrived shows
    // rosario_01's poster there without the engine's flag (review FA)
    const cardId = ex.card;
    v.force = beat === 'atlas' || (v.explore && !diving) || (beat === 'glide' && ch <= 2) || (beat === 'pullback' && (ch === 1 || ch === 3));
    v.carried = (ch === 1 && inCh && !!(v.card || v.strip || v.cap)) || v.title
      || (v.explore && !diving && ((!SHORT.matches && (!phone || !cardId)) || (!!cardId && isRosario(byId[cardId]))))   // the note, or a Rosario card
      || (!!diving && isRosario(byId[diving]));
    return v;
  }

  function render() {
    const v = view();
    setOv(rise, v.rise);
    setOv(title, v.title);
    setOv(railIn, v.rail);
    if (railIn.dataset.at !== v.at) railIn.dataset.at = v.at;
    flag(railIn, 'aside', v.split || (v.facts && v.phone));   // the rail steps aside for the split view and the phones' facts
    railLinks.forEach(a => { const c = String(a.dataset.chapter === v.at); if (a.getAttribute('aria-current') !== c) a.setAttribute('aria-current', c); });
    // chapter 2's facts: the way in first (back: the reader came back into the state, or keyboard focus left the card:
    // the card shows at once, no rise, the posts already planted), then the states it styles
    const back = S.pos < S.seen - 1e-4 || (S.kbdWas && !v.kbd);
    S.seen = S.pos; S.kbdWas = v.kbd;
    sp?.set({ k: v.fk, kbd: v.kbd, layout: v.lay, phone: v.phone, back, p: S.beat === 'ride' && S.ch === 2 ? S.p : null });
    // the strip under chapter 2's facts carries the layout, so the cap docks on it where it shows (css/home.css); back into
    // the ride from the pull-back it cuts in, so "not camera video" is on screen from the ride's first frame
    const s2 = chapters[1].strip;
    if (v.strip === 2 && s2.dataset.ov !== 'on') { if (back) s2.dataset.enter = 'back'; else delete s2.dataset.enter; }
    // review A: the pull-back's caption, left on the way back up, cuts out too: still fading (0.3 s) as the strip cut in, it
    // lay over the strip's caveat on a phone on its side (the two share a corner there) on any scroll back of the pull-back's
    // first fifth in under 0.3 s
    const c2 = chapters[1].cap;
    if (v.cap !== 2 && c2.dataset.ov === 'on') { if (back) c2.dataset.enter = 'back'; else delete c2.dataset.enter; }
    for (const c of chapters) {
      setOv(c.card, v.card === c.n);
      setOv(c.strip, v.strip === c.n);
      setOv(c.cap, v.cap === c.n);
      if (c.split) setOv(c.split, v.split);
    }
    if (v.facts) { if (s2.dataset.facts !== v.lay) s2.dataset.facts = v.lay; } else if ('facts' in s2.dataset) delete s2.dataset.facts;
    flag(hud, 'mini', v.mini);
    flag(hud, 'split', v.split);
    flag(hud, 'hint', v.hint);
    flag(hud, 'atlas', v.explore && !ex.diving);
    const tilt = S.tilt && S.mode === 'live' && !REDUCED && !FINE.matches && 'DeviceOrientationEvent' in window;
    if (tiltBtn.hidden === tilt) tiltBtn.hidden = !tilt;
    flag(hud, 'tilt', tilt && (v.mini || v.split || (v.facts && v.phone)));   // phones' facts: the tilt button stays
    flag(credit, 'force', v.force);
    flag(credit, 'carried', v.carried);
    ex.show(v.explore);
  }

  // ---------------------------------------------------------------- beats and progress
  function setBeat(beat, ch) {
    ch = +ch || 0;
    if (beat === S.beat && ch === S.ch) return false;
    const prevCh = CH_BEATS.includes(S.beat) ? S.ch : 0;
    S.beat = beat; S.ch = ch; S.p = 0; S.key = '';
    const nowCh = CH_BEATS.includes(beat) ? ch : 0;
    if (nowCh && nowCh !== prevCh) {
      const c = chapters[nowCh - 1], m = byId[c.id];
      say(`Chapter ${nowCh} of 3: ${m.title}, ${m.id}`);
    } else if (beat === 'explore') say(`The atlas: all ${order.length} of our published maps.`);
    return true;
  }
  /** The progress bucket that changes what is shown; render only when it changes. */
  const bucket = p => [P.rise, P.title, P.cardIn, P.strip, P.strip2, ...P.facts, P.hint[0], P.split, P.cap, P.exOut, P.land].reduce((k, t) => k + (p >= t ? 1 : 0), 0);

  // a beat change renders with the progress that follows it in the same frame (the engine emits both): rendered here, it
  // ran with p = 0 and the reader's previous place, so the way back into a beat (data-enter) was misread
  world.on(EVENTS.BEAT, ({ beat, chapter }) => { setBeat(beat, chapter); });
  world.onProgress(({ beat, chapter, p }) => {
    const moved = setBeat(beat, chapter);
    S.p = p;
    S.pos = pos(beat, +chapter || 0, p);
    const key = `${bucket(p)}`;
    if (moved || key !== S.key) { S.key = key; render(); } else sp?.tick(beat === 'ride' && +chapter === 2 ? p : null);   // the facts' queue
    railProgress(beat, +chapter || 0, p);
  });
  for (const q of [PHONE, SHORT, LOW]) q.addEventListener?.('change', render);   // Safari 13 has no addEventListener here: no live re-layout there

  function railProgress(beat, ch, p) {
    const k = CH_BEATS.indexOf(beat);
    const f = beat === 'explore' ? 1 : k >= 0 && ch >= 1 ? Math.min(1, ((ch - 1) + (k + p) / 4) / 3) : 0;
    if (Math.abs(f - S.rail) < 0.002) return;
    S.rail = f;
    railFill.style.setProperty('--rp', f.toFixed(4));
  }

  // ---------------------------------------------------------------- what the stage shows
  world.on(EVENTS.MODE, ({ mode }) => {
    if (!mode) return;
    S.mode = mode;
    ex.mode(mode === 'live');
    if (mode !== 'live') heroState({ id: maps.hero, best: 'poster', progress: null });
    render();
  });
  function heroState({ id, best, progress }) {
    if (id !== maps.hero) return;
    let s = 'poster', t = 'Preview';
    if (best === 'points') { s = 'points'; t = 'Live render (points)'; }
    else if (best === 'cut' || best === 'lite' || best === 'standard') { s = 'live'; t = 'Live render'; }
    else if (S.mode === 'live' && Number.isFinite(progress)) { s = 'loading'; t = `Loading 3-D · ${Math.round(progress * 100)} %`; }
    if (heroChip.dataset.s !== s) heroChip.dataset.s = s;
    if (heroChip.textContent !== t) heroChip.textContent = t;
  }
  world.on(EVENTS.LAYER, heroState);

  let hrefT = 0;
  world.on(EVENTS.TELEMETRY, ({ id, t }) => {
    if (!Number.isFinite(t)) return;
    ex.telemetry(id, t);
    const now = performance.now();
    if (now - hrefT < 400) return;
    hrefT = now;
    const href = `viewer.html?map=${encodeURIComponent(id)}&t=${t.toFixed(1)}&cam=pov`;
    for (const a of explore.get(id) || []) if (a.getAttribute('href') !== href) a.setAttribute('href', href);
  });

  // ---------------------------------------------------------------- tilt: iOS asks for permission inside this tap, so
  // world.tilt() is called synchronously in the handler (no await before it); the name never changes (RA-20)
  let msgT = 0;
  tiltBtn.addEventListener('click', () => {
    const on = tiltBtn.getAttribute('aria-pressed') !== 'true';
    world.tilt(on).then(r => {
      tiltBtn.setAttribute('aria-pressed', String(r === 'on'));
      if (r !== 'denied' && r !== 'unavailable') return;
      S.tilt = false;
      tiltMsg.textContent = r === 'denied' ? 'Tilt not allowed' : 'Tilt not available';
      clearTimeout(msgT);
      msgT = setTimeout(() => { tiltMsg.textContent = ''; }, 4000);
      render();
    });
  });

  // ---------------------------------------------------------------- navigation: the rail and the hero's "See our work"
  railLinks.forEach(a => a.addEventListener('click', e => {
    e.preventDefault();
    const c = a.dataset.chapter;
    world.goto(c === 'explore' ? 'explore' : `chapter:${c}`, { smooth: !REDUCED });
    document.querySelector(a.getAttribute('href'))?.focus({ preventScroll: true });
  }));
  W.querySelectorAll('.hero a[href="#maps"]').forEach(a => a.addEventListener('click', e => {
    e.preventDefault();
    world.goto('atlas', { smooth: !REDUCED });
  }));
  // a keyboard reader who Tabs into a chapter's card, or into the explore controls, is taken to that beat
  for (const c of chapters) {
    c.el.addEventListener('focusin', () => { if (S.ch !== c.n || !CH_BEATS.includes(S.beat)) world.goto(`chapter:${c.n}`, { smooth: false }); });
  }
  // keyboard focus inside chapter 2's card keeps the card on screen through the facts beat (view(): S.kbd): the strip and
  // the signposts' cards go, so the focused link is never under the strip; keyboard focus only (:focus-visible), so a
  // mouse click on a card link leaves the beat as it is
  const card2 = chapters[1].card;
  const keyFocus = el => { try { return el.matches(':focus-visible'); } catch { return true; } };
  card2.addEventListener('focusin', e => { if (!S.kbd && keyFocus(e.target)) { S.kbd = true; render(); } });
  card2.addEventListener('focusout', e => { if (S.kbd && !card2.contains(e.relatedTarget)) { S.kbd = false; render(); } });
  document.getElementById('atlas').addEventListener('focusin', () => { if (S.beat !== 'explore') world.goto('explore', { smooth: false }); });

  render();
}
