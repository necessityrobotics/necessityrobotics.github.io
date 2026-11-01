// The home page's world (MASTER_PLAN.md 2 / 4): decides the tier, then runs the live 3-D world on ONE WebGL context,
// or hands over to the still path (still.js). Everything that does not need 3-D (beats, events, posters, HUD) runs from
// the first frame; three.js, Spark and the 3-D modules load at idle, so the first paint never waits on them.
//
// One frame (the stage's hook, drawn only when something moves):
//   scroll -> story state (core.js) -> target pose (director.js) -> critically damped follow + look-around -> per-island
//   layer targets (show, lift, highlight, the splat rule, the route's drawn range) -> scene fades -> posters, labels, HUD.
// Splats join the scene only when the main thread can take their upload (scroll idle >= 150 ms, no drag, at most one
// join a second, the island on screen or next), under cover of the poster or the points.
import { EVENTS, _attach, _emit } from './api.js';
import { log, setInfo, setHook, logged } from './debug.js';
import { detectCaps, chooseTier, TIER_PARAMS } from './caps.js';
import { buildTimeline } from './timeline.js';
import { Pace, Story, Posters, Hud } from './core.js';
import { attachInput } from './input.js';
import { Loader } from './loader.js';
import { asset } from '../config.js';
import { Track } from '../tour/track.js';
import { Spring, ease, ramp, lerp, slerp, qmul, qrot, add, sub, scale, yawPitch, orbit, headingOf } from './camera.js';

const qs = new URLSearchParams(location.search);
const idle = (fn, timeout) => ('requestIdleCallback' in window ? requestIdleCallback(fn, { timeout }) : setTimeout(fn, Math.min(timeout, 300)));
const HIDDEN_DISPOSE_MS = 60000;
const LABEL_BLOCKERS = '.head, [data-world="chips"], .explore-card, .ex-intro, .ex-foot, .rail-in, .mcard, .ov-panel';   // .head: integrator (E-DE4)
// the boxes a selected island is kept clear of in the explore beat (the header, HOME's panels, the visible HUD parts)
const PANELS = '.head, [data-world="chips"], .explore-card, .ex-intro, .ex-foot, .dive-bar, .world-hud > *';
// integrator: Spark (vendored, hash-locked) rejects its in-flight async readbacks with "No target" / "No renderer" once its
// renderer is disposed (the governor's still-mode fallback, a context replacement): an uncaught error in WebKit when the
// iPad run fell back to still mode. Only those two teardown messages are silenced; everything else still reports.
addEventListener('unhandledrejection', e => { const m = e.reason?.message ?? e.reason; if (m === 'No target' || m === 'No renderer') e.preventDefault(); });

/**
 * The point nearest (x, y) where a square of half-size r sits inside the w x h screen and clear of every box
 * ([l, t, r, b]); (x, y) itself when it already is, null when nothing fits. Candidates are the point and its moves to
 * each box edge and screen edge, in every x / y combination, so the answer moves continuously with (x, y).
 */
function freeSpot(x, y, r, w, h, boxes) {
  const m = r + 6;
  const ok = (px, py) => px >= m && px <= w - m && py >= m && py <= h - m
    && boxes.every(b => px + r <= b[0] || px - r >= b[2] || py + r <= b[1] || py - r >= b[3]);
  if (ok(x, y)) return [x, y];
  const xs = [x, m, w - m], ys = [y, m, h - m];
  for (const b of boxes) { xs.push(b[0] - r - 1, b[2] + r + 1); ys.push(b[1] - r - 1, b[3] + r + 1); }
  let best = null, bd = Infinity;
  for (const px of xs) for (const py of ys) {
    const d = (px - x) ** 2 + (py - y) ** 2;
    if (d < bd && ok(px, py)) { bd = d; best = [px, py]; }
  }
  return best;
}

export async function start({ maps, atlas, routes, root }) {
  const force = { world: qs.get('world'), tier: qs.get('tier') };
  const tl = buildTimeline(root);
  const canvas = root.querySelector('[data-world="canvas"]');
  // the cheap signals first: a still-mode device never creates a WebGL context or imports three.js
  const cheap = detectCaps();
  const choice = chooseTier(cheap, { force });
  if (choice.tier === 'T0' || !canvas) return still({ maps, atlas, routes, root, tl, why: canvas ? choice.why : 'no stage canvas', reduced: cheap.reduced });
  return live({ maps, atlas, routes, root, tl, cheap, force, canvas });
}

async function still({ maps, atlas, routes, root, tl, why, reduced, tier = 'T0' }) {
  const m = await import('./still.js');
  const impl = m.start({ maps, atlas, routes, root, why, tier, timeline: tl, reduced });
  _attach(impl);
  return impl;
}

function live({ maps, atlas, routes, root, tl, cheap, force, canvas }) {
  // the tier is final once WebGL2 has been probed on the stage's canvas (at idle, see probe())
  let caps = cheap, choice = null, params = null, tier = '', loader = null;
  let PHONE = cheap.touch && !cheap.fine;
  let canvasNow = canvas;
  const byId = Object.fromEntries(maps.maps.map(m => [m.id, m]));
  const ids = atlas.order.filter(id => atlas.islands[id] && byId[id]);
  const hero = atlas.hero.id;
  const story = new Story({ root, atlas, maps, routes, timeline: tl });
  const posters = new Posters(root);
  const titles = Object.fromEntries(ids.map(id => [id, byId[id].title]));
  const hud = new Hud(root, story, atlas, titles);
  const pace = new Pace();
  const stageEl = root.querySelector('.stage');
  const dip = root.querySelector('.stage-dip');
  const W = story.w;
  W.attr('load', 'poster');

  // ---------------------------------------------------------------- state
  const T = {
    heroT: atlas.hero.t0 + 2, heroLoops: 0, heroLive: false, capT: null, prevKind: '', enteredAt: performance.now(),
    hover: '', onscreen: true, out: 0, lastJoin: -1e9, dead: false, best: {}, upload: null,
    atlasOnAt: 0, stagger: {}, backdropK: 0, atlasK: 0, shiftK: 0, shiftOn: 0, lookW: 1, diveY: 0, pendingDive: null, diveDisposeT: {}, lastLayerEv: 0,
    first3d: false, stallChip: false, progress: {}, losses: [], ctxTimer: 0,
    splatCheck: {}, noSplats: false,     // O1: per splat tier 'pending' / 'ok' / 'unknown' / 'failed'; no splats this visit
    splatSeen: {}, splatTries: {}, splatWait: 0,
  };
  let G = null;            // the 3-D side once loaded: {THREE, stage, scene, director, gov, labels, spring}
  let atlasBin = null, binStarted = false;    // atlas.bin levels (kept for a context rebuild)
  let impl = null;

  // ---------------------------------------------------------------- input
  const input = attachInput(root, {
    reduced: false,
    onLook: () => wake(),
    onHover: (x, y, target) => hoverAt(x, y, target),
    onTap: (x, y, type) => tapAt(x, y, type),
    onKey: k => { if (k === 'Escape' && story.dive) impl.surface(); },
    onType: t => { W.attr('input', t); T.heroLoops = 0; },
  });

  // ---------------------------------------------------------------- the tier, decided at idle on the real canvas
  function probe() {
    caps = detectCaps({ canvas: canvasNow });
    choice = chooseTier(caps, { force });
    if (choice.tier === 'T0') { caps.gl?.getExtension('WEBGL_lose_context')?.loseContext(); toStill(choice.why); return false; }
    params = { ...choice.params };
    const cap = Number(qs.get('cap'));
    if (cap > 0) params = { ...params, fps: Math.min(params.fps, cap), playFps: Math.min(params.playFps, cap) };
    tier = choice.tier; PHONE = params.phone;
    W.attr('mode', 'live'); W.attr('tier', tier); W.attr('why', choice.why); W.attr('level', 0);
    _emit(EVENTS.MODE, { mode: 'live', tier, level: 0, why: choice.why });
    log('mode', null, { mode: 'live', tier, why: choice.why, phone: PHONE, renderer: caps.renderer.slice(0, 80) });
    const tiltBtn = root.querySelector('[data-world="tilt"]');
    if (tiltBtn && !caps.fine && 'DeviceOrientationEvent' in window) tiltBtn.hidden = false;
    loader = new Loader({ islands: Object.fromEntries(ids.map(id => [id, { files: byId[id].files, points: atlas.islands[id].points, cut: atlas.islands[id].cut || null }])),
      asset, params, hooks: {
        log: (ev, ch, extra) => log(ev, chOf(extra?.id), extra),
        onPart: (id, part, data) => onPart(id, part, data),
        onProgress: (id, part, got, tot) => { T.progress[id] = tot ? got / tot : 0; if (id === story.S.island) layerEvent(id, true); },
        onStall: () => { T.stallChip = true; chip(); },
      } });
    return true;
  }
  const chOf = id => (id === hero ? 0 : tl.chapters.find(c => c.island === id)?.n ?? 4);
  function stops() {
    const out = [];
    const rise = tl.find('rise');
    out.push({ id: hero, y: -tl.H, leave: rise ? rise.y0 + 0.4 * (rise.y1 - rise.y0) : tl.H });
    for (const c of tl.chapters) {
      const d = c.beats.dive, pb = c.beats.pullback;
      if (d && pb) out.push({ id: c.island, y: d.y0 + 0.5 * (d.y1 - d.y0), leave: pb.y0 + 0.5 * (pb.y1 - pb.y0) });
    }
    return out;
  }
  let planT = 0;
  function planSoon() { if (!planT) planT = setTimeout(() => { planT = 0; plan(); }, 120); }
  function plan() {
    if (T.dead || !loader) return;
    const S = story.S, pc = pace.read();
    const cur = story.dive ? story.dive.id : (S.kind === 'hero' || S.kind === 'rise') ? hero : ['dive', 'ride', 'pullback'].includes(S.kind) ? S.island : '';
    const std = S.kind === 'ride' && performance.now() - T.enteredAt > 1500 && Math.abs(pc.vInst) < 0.3 * tl.H && scrollY > tl.H ? S.island : null;
    loader.plan({ y: scrollY, H: tl.H, vInst: pc.vInst, vAvg: pc.vAvg, dir: pc.dir, engaged: pc.engaged, offscreen: !T.onscreen || T.out >= 0.999,
      cur, hero, stops: stops(), std, holdLight: !T.heroLive && !T.noSplats && story.S.kind === 'hero' && !pc.engaged });
    if (loader.running().length) { clearTimeout(plan.t); plan.t = setTimeout(plan, 500); }
  }

  // splat files decode one at a time (two together double the transient memory on phones)
  let decodeQ = Promise.resolve();
  // SP: islands with a splat file queued for (or in) decode, id -> token. They count as resident in canDecode(): files
  // that arrive together (cache hits, a fast link, a context rebuild) all passed the slot check before any of them was
  // decoded, so a phone held 3 maps with 2 slots (T2) and 2 with 1 (T1) after a context loss
  const decoding = new Map();
  function onPart(id, part, data) {
    if (part === 'traj') {
      const tr = Track.fromTraj(data.ours);
      tracks[id] = tr;
      (G || T.building)?.director.setTrack(id, tr);
      if (T.pendingDive === id) { T.pendingDive = null; impl.dive(id); }
      wake();
      return;
    }
    if (part === 'dense') { if (G) G.scene.densify(id, data); wake(); return; }
    if (T.noSplats) { loader.stopSplats(); return; }       // O1: this device draws no splats (a file already in flight)
    // a splat file: hand it to Spark (its decode runs in Spark's workers); desktops keep a JS copy for re-visits. The
    // bytes wait in the loader (counted in its budget) while the 3-D side is not up, or while every resident slot is
    // taken by an island nearer the reader; redeliverWanted() hands them over when that changes.
    if (!G || !canDecode(id)) { log('held', chOf(id), { id, part }); return; }
    loader.release(id, part);
    const t0 = performance.now(), scene = G.scene, token = {};
    decoding.set(id, token);
    decodeQ = decodeQ.then(() => {
      if (G?.scene !== scene || decoding.get(id) !== token || !wanted(id)) { loader.forget(id, part); return null; }
      return scene.attachSplats(id, part, params.keepBytes ? data.slice() : data);
    }).then(mesh => {
      if (!mesh) return;
      const s = (performance.now() - t0) / 1000;
      loader.decodeS = 0.6 * loader.decodeS + 0.4 * s;
      log('ready', chOf(id), { id, part, decode_s: +s.toFixed(2) });
      G?.gov.grace(500, 'decode');
      wake();
    }).catch(e => { loader.forget(id, part); log('decode-fail', chOf(id), { id, part, msg: String(e?.message || e).slice(0, 100) }); })
      .finally(() => { if (decoding.get(id) === token) decoding.delete(id); });
  }
  const tracks = {};
  story.trackFor = i => tracks[i] || story.route[i];
  /** Kept bytes of islands coming back into range go to the 3-D layer again (desktops; phones fetch from the cache). */
  function redeliverWanted() {
    if (!G) return;
    for (const id of ids.slice().sort((a, b) => nearness(a) - nearness(b))) {
      if (!wanted(id) || G.scene.hasSplats(id) || G.scene.pendingTiers(id).length || decoding.has(id)) continue;
      for (const t of ['lite', 'cut']) if (loader.redeliver(id, t)) break;
    }
  }
  function seqIndex(id) { return id === hero ? 0 : tl.chapters.find(c => c.island === id)?.n ?? null; }
  function curIndex() {
    const S = story.S;
    if (S.kind === 'hero' || S.kind === 'rise' || S.kind === 'atlas') return 0;
    if (S.kind === 'explore') return 4;
    return S.chapter || 0;
  }
  /** The resident window: one chapter behind the reader to the loader's lookahead ahead, plus the explore picks. */
  function wanted(id) {
    if (story.dive?.id === id || T.pendingDive === id || loader?.intents.has(id) || (story.S.kind === 'explore' && story.selected === id)) return true;
    const i = seqIndex(id), ci = curIndex();
    return i != null && i >= ci - 1 && i <= ci + (params?.lookahead ?? 1);
  }
  /** Rank for the resident slots: the island on screen, then the dive, then the nearest ahead, then behind. */
  function nearness(id) {
    if (id === story.dive?.id || id === T.pendingDive) return -2;
    const i = seqIndex(id), ci = curIndex();
    if (id === story.S.island) return -1;
    if (i == null) return story.selected === id ? 0.5 : 20;
    return i >= ci ? i - ci : 10 + ci - i;
  }
  /** A file may decode when a resident slot is free, or when it outranks a resident island (which then goes). */
  function canDecode(id) {
    if (!wanted(id)) return false;
    const res = new Set([...Object.keys(G.scene.splatTiers()), ...ids.filter(i => G.scene.pendingTiers(i).length), ...decoding.keys()]);
    res.delete(id);
    if (res.size < params.maxSplatMaps) return true;
    const worst = [...res].sort((a, b) => nearness(b) - nearness(a))[0];
    if (nearness(worst) <= nearness(id)) return false;
    for (const t of ['cut', 'lite', 'standard']) loader.forget(worst, t);
    G.scene.dropSplats(worst);
    decoding.delete(worst);
    log('dispose', chOf(worst), { id: worst, why: `slot for ${id}` });
    return true;
  }
  function disposeFar() {
    if (!G) return;
    const scene = G.scene, S = story.S;
    const resident = Object.keys(scene.splatTiers()).concat(ids.filter(id => scene.pendingTiers(id).length));
    for (const id of new Set(resident)) {
      const tiers = scene.splatTiers()[id] || [];
      if (!wanted(id) && !(T.diveDisposeT[id] > performance.now())) {
        for (const t of ['cut', 'lite', 'standard']) loader.forget(id, t);
        scene.dropSplats(id);
        log('dispose', chOf(id), { id });
      } else if (tiers.includes('standard') && !(S.kind === 'ride' && S.island === id)) {
        scene.dropSplats(id, 'standard'); loader.forget(id, 'standard'); log('dispose-std', chOf(id), { id });
      }
    }
    // dense prefixes stay from one chapter behind to the loader's lookahead ahead (the loader fetches exactly those)
    const ci = curIndex();
    for (const id of ids) {
      const i = seqIndex(id);
      const keep = i == null ? story.dive?.id === id || story.selected === id : i >= ci - 1 && i <= ci + params.lookahead;
      if (scene.islands.get(id)?.dense && !keep) {
        scene.dropDense(id);
        const p = loader.part(id, 'dense'); p.state = 'idle'; p.data = null;
      }
    }
    loader.trim([story.S.island, ...ids.filter(id => wanted(id))]);
  }

  // ---------------------------------------------------------------- the 2-D ticker until the 3-D side is up
  let raf = 0, lastNow = performance.now();
  function wake() {
    if (T.dead || !T.onscreen) return;
    if (G) { G.stage.invalidate(); return; }
    if (!raf) raf = requestAnimationFrame(now => { raf = 0; const dt = Math.min(0.1, (now - lastNow) / 1000); lastNow = now; if (tick(dt, now)) wake(); });
  }

  // ---------------------------------------------------------------- one frame
  const pose = { pos: [0, 0, 0], quat: [0, 0, 0, 1], fov: 46 };
  let lastTarget = null;
  function tick(dt, now) {
    if (T.dead) return false;
    let more = false;
    const y = scrollY;
    const k0 = story.S.kind;
    // the hero's autoplay: real time along xclean's trajectory, a loop with a 0.6 s dip at the cut; it plays once the
    // hero's splats are on screen, and holds after two loops without input on phones (PH-8, SP-10)
    let dipA = 0;
    const playing = k0 === 'hero' && T.heroLive && !story.dive && !(PHONE && T.heroLoops >= 2) && G;
    if (playing) {
      const a = atlas.hero.t0, b = atlas.hero.t1, sp = byId[hero].film?.speed_factor || 1;
      T.heroT += dt * sp;
      if (T.heroT >= b) { T.heroT = a; T.heroLoops++; G.spring.pos = null; }
      const left = (b - T.heroT) / sp, back = (T.heroT - a) / sp;
      dipA = left < 0.6 ? 1 - left / 0.6 : back < 0.6 ? 1 - back / 0.6 : 0;
      more = true;
    }
    const S = story.update(y, now, { heroT: T.heroT, capT: T.capT, yaw: -input.look.x });
    if (S.kind !== T.prevKind || S.chapter !== T.prevCh) onBeat(S, now);
    if (G) more = frame3D(dt, now, S) || more;
    else {
      const pid = posterFor(S, false);
      posters.only(pid, 1);
      // integrator (review FA, H-FA2): the flag keeps its contract before the 3-D side arrives (a slow phone shows posters)
      W.attr('rosario', pid.startsWith('rosario_') && T.out < 0.999 ? '1' : '');
    }
    if (story.dive) dipA = T.diveDip || 0;
    if (dip) { const v = dipA.toFixed(2); if (dip.dataset.v !== v) { dip.dataset.v = v; dip.style.opacity = v; } }
    W.css(stageEl, '--out', T.out);
    story.progress();
    if (playing || story.dive) G?.stage.setCapFps(G.gov.maxFps(!pace.engaged || now - pace.t > 400));
    else G?.stage.setCapFps(G.gov.maxFps(false));
    return more;
  }
  function posterFor(S, live) {
    if (story.dive) return story.dive.id;
    if (S.kind === 'hero' || S.kind === 'rise') return hero;
    return ['dive', 'ride', 'pullback'].includes(S.kind) ? S.island : live ? '' : S.island || hero;
  }

  function frame3D(dt, now, S) {
    const { stage, scene, director, spring } = G;
    let more = false;
    const asp = stage.size.w / Math.max(1, stage.size.h);
    director.setAspect(asp);
    // ---- the target: an explore dive (time-based) or the scroll's beat
    let tgt = director.target(S) || lastTarget;
    if (!tgt) return false;
    lastTarget = tgt;
    if (S.kind === 'explore' && story.selected && T.panels) tgt = clearOfPanels(tgt, story.selected, asp, stage.size.w, stage.size.h);
    let direct = false;
    if (director.dv) {
      const d = director.diveFrame(dt, tgt);
      if (d) {
        tgt = { ...d.pose, look: 'pov' };
        direct = true;
        T.diveDip = d.dip;
        if (d.t != null) story.dive.t = d.t;
        if (d.phase !== T.divePhase) {
          T.divePhase = d.phase;
          _emit(EVENTS.DIVE, { id: d.id, phase: d.phase, t: d.t ?? null });
          log(d.phase === 'done' ? 'surface' : 'dive', 4, { id: d.id, phase: d.phase });
          if (d.phase === 'done') {
            story.dive = null; W.attr('diving', ''); T.divePhase = null; panelsSoon();
            T.diveDisposeT[d.id] = performance.now() + 20000;
            setTimeout(() => { disposeFar(); wake(); }, 20100);
          }
        }
        more = true;
      }
    }
    // ---- follow: a critically damped spring (snaps when settled), or the dive's pose directly
    const focus = atlas.islands[S.island] || atlas.islands[hero];
    const eps = 1e-4 * focus.radius * focus.scale;
    // SP: while the hero's poster still covers the stage, the camera goes straight to its pose: a track that arrives
    // after the 3-D side is up used to start a 0.8 s flight down from the overview (unseen under the poster), and the
    // splats waited for it (production phone: first 3-D frame 2.87 s, of which 0.8 s was this flight)
    if (direct || (S.kind === 'hero' && !T.heroLive && !story.dive)) spring.snap(tgt.pos, tgt.quat, tgt.fov);
    else if (spring.step(dt, tgt.pos, tgt.quat, tgt.fov, eps)) { more = true; T.why = 'spring'; }
    // ---- the look-around: in the camera frame on xclean's pose; around the view's centre over the atlas
    if (input.step(dt, 1)) { more = true; T.why = 'look'; }
    const L = input.look;
    const wantW = tgt.look === 'pov' ? 1 : 0;
    T.lookW += (wantW - T.lookW) * (1 - Math.exp(-dt * 5));
    if (Math.abs(wantW - T.lookW) > 1e-3) { more = true; T.why = 'lookW'; } else T.lookW = wantW;
    const qPov = qmul(spring.quat, yawPitch(-L.x, -L.y));
    let pPos = spring.pos, qFin = qPov;
    if (T.lookW < 1 && tgt.centre) {
      const yaw = -L.x * 0.9;
      const pOrb = orbit(spring.pos, tgt.centre, yaw);
      const qOrb = qmul(qmul([0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], spring.quat), yawPitch(0, -L.y * 0.5));
      pPos = [0, 1, 2].map(j => lerp(pOrb[j], spring.pos[j], T.lookW));
      qFin = slerp(qOrb, qPov, T.lookW);
    }
    pose.pos = pPos; pose.quat = qFin; pose.fov = spring.fov;
    const cam = stage.camera;
    cam.position.set(pPos[0], pPos[1], pPos[2]);
    cam.quaternion.set(qFin[0], qFin[1], qFin[2], qFin[3]);
    // the projection: landscape keeps the view's own vertical field of view; narrower screens widen it, to 64 deg
    const A = focus.cam?.aspect || 1.6, v = spring.fov;
    const fov = asp >= A ? v : Math.min(64, 2 * Math.atan(Math.tan(v * Math.PI / 360) * A / asp) * 180 / Math.PI);
    const alt = (pPos[1] - focus.place.y) / focus.scale;
    const near = Math.min(4, Math.max(0.04 * focus.scale, Math.abs(pPos[1] - focus.place.y) * 0.02));
    // integrator (review DE, E-DE3): on screens of 761 x 501 or more the atlas is framed in the free right 60 % (a lens
    // shift, not a turn): the title panel covered the India group (Street ride, Park walk) for the whole atlas beat. On in
    // the atlas beat, out over the first half of chapter 1's glide (before its card enters); eased in time, so a jump
    // in the scroll never snaps the frame
    const wide = stage.size.w >= 761 && stage.size.h >= 501 && stage.size.w >= 1.2 * stage.size.h && !story.dive;   // landscape-wide screens only (DE checked desktops)
    const shW = !wide ? 0 : S.kind === 'atlas' ? 1 : S.kind === 'glide' && S.chapter === 1 ? 1 - ease.smoothstep(ramp(S.p, 0.1, 0.45)) : 0;
    T.shiftK += (shW - T.shiftK) * (1 - Math.exp(-dt * 4));
    if (Math.abs(shW - T.shiftK) > 0.002) more = true; else T.shiftK = shW;
    const shift = Math.round(T.shiftK * 1000) / 1000;
    if (cam.fov !== fov || cam.aspect !== asp || Math.abs(cam.near - near) > 1e-4 || T.shiftOn !== shift || T.shiftCam !== cam) {
      cam.fov = fov; cam.aspect = asp; cam.near = near; cam.far = 30000; T.shiftOn = shift; T.shiftCam = cam;
      if (shift > 0) cam.setViewOffset(stage.size.w, stage.size.h, -0.18 * stage.size.w * shift, 0, stage.size.w, stage.size.h);
      else cam.clearViewOffset();
      cam.updateProjectionMatrix();
    }

    // ---- per-island layers
    const kind = S.kind, atlasOn = !['hero', 'rise'].includes(kind) || !!story.dive;
    if (atlasOn && !T.atlasOnAt) {
      T.atlasOnAt = now;
      const order = ids.filter(id => id !== hero).sort((a, b) => distTo(a) - distTo(b));
      order.forEach((id, i) => { T.stagger[id] = now + i * 120; });
      log('atlas', null, { islands: ids.length });
    } else if (!atlasOn && T.atlasOnAt) T.atlasOnAt = 0;
    const sel = story.selected, hov = T.hover;
    const inChapter = ['dive', 'ride', 'pullback'].includes(kind);
    const hiSet = new Set([sel, hov].filter(Boolean));
    for (const id of ids) {
      const isl = atlas.islands[id], s = isl.scale;
      let show = id === hero || (atlasOn && now >= (T.stagger[id] || 0)) ? 1 : 0;
      // integrator (review SB, H-SB2): inside an explore dive's ride (eye level) the other islands go, as in the chapter
      // rides (nothing floats over a ride's horizon): at 0.35 they still counted as "in view" behind the splats, and the
      // stage showed the Rosario credit inside an OAK map
      if (story.dive && id !== story.dive.id) show = T.divePhase === 'ride' ? 0 : 0.35;
      else if (inChapter && id !== S.island) show *= kind === 'ride' ? 0 : 0.45;     // nothing floats over a ride's horizon
      if (show && !atlasOn && id !== hero) show = 0;
      if (T.stagger[id] > now) { more = true; T.why = 'stagger'; }
      const lifted = (id === hov || id === sel) && (kind === 'explore' || kind === 'atlas') && !story.dive;
      const altI = (pPos[1] - isl.place.y) / s;
      const eligible = story.dive ? id === story.dive.id : (id === hero && (kind === 'hero' || kind === 'rise')) || (inChapter && id === S.island);
      const splat = eligible ? 1 - ease.smoothstep(ramp(altI, 12, 30)) : 0;
      const r = tgt.route && tgt.route.id === id ? tgt.route : { a: 0, b: 1 };
      scene.setIsland(id, {
        show, lift: lifted ? 14 + 0.06 * isl.radius * s : 0, hi: lifted ? 1 : id === S.island ? 0.35 : 0, splat,
        route: { a: r.a, b: r.b, o: kind === 'hero' ? 0 : ease.smoothstep(ramp(altI, 8, 22)) },
      });
    }
    const bk = atlasOn && params.backdrop && G.gov.rung.backdrop !== false ? 1 : 0;
    T.backdropK += (bk - T.backdropK) * (1 - Math.exp(-dt * 3));
    if (Math.abs(bk - T.backdropK) > 0.003) { more = true; T.why = 'backdrop'; } else T.backdropK = bk;
    scene.setBackdropK(T.backdropK);
    // --atlas (0..1): how much of the atlas the stage shows, for HOME's overlays
    T.atlasK += ((atlasOn ? 1 : 0) - T.atlasK) * (1 - Math.exp(-dt * 3));
    if (Math.abs((atlasOn ? 1 : 0) - T.atlasK) > 0.003) more = true; else T.atlasK = atlasOn ? 1 : 0;
    W.css(stageEl, '--atlas', T.atlasK);
    if (scene.update(dt)) { more = true; T.why = 'scene'; }

    // ---- the join gate: a decoded splat file enters the scene when the main thread can take its upload
    if (now - T.lastJoin >= 1000 && now - pace.t >= 150 && !input.look.drag) {
      for (const id of [story.dive?.id, S.island, ...ids.filter(i => wanted(i))].filter(Boolean)) {
        const tiers = scene.pendingTiers(id);
        if (!tiers.length) continue;
        const tier = tiers.sort((a, b) => ({ cut: 1, lite: 2, standard: 3 }[b] - { cut: 1, lite: 2, standard: 3 }[a]))[0];
        if (scene.join(id, tier)) {
          T.lastJoin = now; T.upload = { id, tier };
          G.gov.grace(500, 'upload');
          more = true; T.why = 'join';
          break;
        }
      }
    } else if (ids.some(id => G.scene.pendingTiers(id).length)) setTimeout(wake, 160);

    // ---- what is on screen: posters, first frames, the layer events, the state chip
    const fid = story.dive ? story.dive.id : S.island;
    const fIsl = scene.islands.get(fid);
    const splatsOn = fIsl && fIsl.splatK > 0.5 && fIsl.best;
    // O1: the first time each splat tier is on screen at eye level (the hero, a ride, a dive's ride), one check that Spark
    // drew anything at all: the hero's poster waits for it (about 0.1 s); nothing drawn keeps the posters and points
    const bl = fIsl?.best ? fIsl.splats[fIsl.best] : null;
    const pov = kind === 'hero' || kind === 'ride' || (story.dive && T.divePhase === 'ride');
    if (bl && pov && !T.splatCheck[fIsl.best] && (bl.o || 0) >= 0.12) {
      // not before Spark can draw at all: its program compiled (visible) and its first sort done (until then it rightly
      // draws nothing); a Spark that never gets there is checked after 5 s, and reads as nothing drawn
      const tier = fIsl.best, sp = stage.spark;
      T.splatSeen[tier] ??= now;
      if ((sp.visible && sp.activeSplats > 0) || now - T.splatSeen[tier] > 5000) checkSplats(fid, tier);
      else if (!T.splatWait) T.splatWait = setTimeout(() => { T.splatWait = 0; wake(); }, 250);
    }
    if (fid === hero && splatsOn && !T.heroLive && splatOk(fIsl.best)) { T.heroLive = true; more = true; T.why = 'herolive'; planSoon(); }
    let pA = 0;
    if (kind === 'hero') pA = T.heroLive ? 0 : 1;
    else if (kind === 'rise') pA = T.heroLive ? 0 : 1 - ramp(S.p, 0, 0.3);
    else if ((kind === 'ride' || story.dive?.t != null && T.divePhase === 'ride') && !splatsOn) pA = 0.55;
    posters.only(posterFor(S, true), pA);
    posters.current(fid || hero);
    if (fIsl && fIsl.splatK > 0.5 && fIsl.best) {
      const ch = story.dive ? 4 : chOf(fid);
      if (!logged('live', ch) && (ch !== 0 || kind === 'hero' || kind === 'rise')) {
        log('live', ch, { id: fid, best: fIsl.best });
        if (ch === 0 && !T.first3d) { T.first3d = true; _emit(EVENTS.READY, { first3d_ms: Math.round(now) }); }
      }
    } else if (fIsl && fIsl.show > 0.5 && !fIsl.best && !logged('pts-live', chOf(fid))) log('pts-live', chOf(fid), { id: fid });
    if (fid) layerEvent(fid, false);
    // integrator (review FA, H-FA3): data-load follows a focus change too (it kept the previous island's value)
    if (fid && fid !== T.loadFid) { T.loadFid = fid; W.attr('load', T.best[fid] || 'poster'); }
    // rosario credit: whenever a Rosario island is in view
    const vis = T.proj || [];
    const ros = T.out < 0.999 && (vis.some(p => p.id.startsWith('rosario_') && p.show > 0.3 && p.inView && p.r >= 6)
      || (fid?.startsWith('rosario_') && fIsl?.show > 0.3 && alt < 60));
    W.attr('rosario', ros ? '1' : '');

    // ---- labels and picking (projected at the tier's label rate)
    const hz = G.gov.rung.labelHz || params.labelHz;
    if (now - (T.lastProj || 0) >= 1000 / hz) {
      T.lastProj = now;
      T.proj = scene.project(stage.size.w, stage.size.h);
      const labelsOn = !story.dive && (kind === 'atlas' || kind === 'glide' || kind === 'explore' || (kind === 'pullback' && S.variant === 'surface' && S.p > 0.6));
      G.labels?.update(T.proj, { visible: labelsOn, hi: hiSet, w: stage.size.w, h: stage.size.h, hz, now, minR: PHONE ? 22 : 14 });
    }
    // ---- ride marks (chapter 2's signposts: marks.js), every drawn frame, after the camera is set
    if (G.marks?.frame(S, now, dt, stage.size.w, stage.size.h, pace.dir)) more = true;
    hud.frame(now, S, { cam: { x: pPos[0], z: pPos[2], heading: headingOf(qFin) }, hi: hiSet });
    return more;
  }
  function distTo(id) { const p = atlas.islands[id].place; return Math.hypot(pose.pos[0] - p.x, pose.pos[1] - p.y, pose.pos[2] - p.z); }

  /**
   * O1: a black-splat safety net. Spark can draw nothing where the engine believes its splats are live (a shader or
   * worker that fails on some device): the poster went and the stage stayed black. Once per tier per visit, the stage
   * draws Spark alone and reads 64 pixels of it back (stage.probeSplats); not one lit pixel at eye level inside a map
   * means nothing was drawn (a dark scene still lights some: the test is "nothing", not "dark"). Then every splat layer
   * goes, the points and posters stay, and the loader fetches no splat file for the rest of the visit.
   */
  function checkSplats(id, tier) {
    T.splatCheck[tier] = 'pending';
    const stage = G.stage;
    stage.probeSplats().then(res => {
      if (T.dead) return;
      // the context was lost or rebuilt meanwhile: the next stage checks again
      if (G?.stage !== stage || (!res && stage.gl.isContextLost())) { delete T.splatCheck[tier]; return; }
      if (res && res.lit === 0) { splatsFailed(id, tier, res); return; }
      // no answer from the GPU is no verdict: asked once more, then taken as no evidence of a failure
      T.splatTries[tier] = (T.splatTries[tier] || 0) + 1;
      if (!res && T.splatTries[tier] < 2) { delete T.splatCheck[tier]; wake(); return; }
      T.splatCheck[tier] = res ? 'ok' : 'unknown';
      log('splat-check', chOf(id), { id, tier, lit: res?.lit ?? null, n: res?.n ?? null, max: res?.max ?? null });
      wake();
    });
  }
  function splatOk(tier) { const s = T.splatCheck[tier]; return s === 'ok' || s === 'unknown'; }
  function splatsFailed(id, tier, res) {
    T.splatCheck[tier] = 'failed';
    T.noSplats = true;
    T.heroLive = false;            // the hero's poster comes back (if the hero beat is ever shown again)
    log('splat-check', chOf(id), { id, tier, lit: 0, n: res.n, max: res.max, failed: true });
    console.info(`[world] the ${tier} splats of ${id} drew nothing on this device: posters and points for the rest of the visit, no splat files fetched`);
    loader.stopSplats();
    decoding.clear();
    for (const i of ids) G.scene.dropSplats(i);
    chip();
    planSoon(); wake();
  }

  /**
   * Explore: the selected (lifted) island is kept clear of the panels. On a phone the card rises over the lower half,
   * so the island the reader had just tapped went under it (2 of 5 picks at 375 x 812, 3 of 5 in landscape) and the
   * second tap, the dive, landed on the card. The camera pans in its own plane (no turn) until the island's centre,
   * projected from the scroll's target pose (not the drawn one: no feedback), sits at the nearest clear spot; the
   * follow spring makes the pan a glide, and the scroll's orbit carries on around it.
   */
  function clearOfPanels(tgt, id, asp, w, h) {
    const isl = atlas.islands[id];
    if (!isl || !tgt.quat || !tgt.pos) return tgt;
    const s = isl.scale, A = isl.cam?.aspect || 1.6, v = tgt.fov || 46;
    const fov = asp >= A ? v : Math.min(64, 2 * Math.atan(Math.tan(v * Math.PI / 360) * A / asp) * 180 / Math.PI);
    const F = (h / 2) / Math.tan(fov * Math.PI / 360);
    const P = [isl.place.x, isl.place.y + 14 + 0.06 * isl.radius * s + isl.height * s * 0.2, isl.place.z];
    const inv = [-tgt.quat[0], -tgt.quat[1], -tgt.quat[2], tgt.quat[3]];
    const c = qrot(inv, sub(P, tgt.pos));
    const z = -c[2];
    if (z < 1e-3) return tgt;
    const sx = w / 2 + c[0] / z * F, sy = h / 2 - c[1] / z * F;
    const r = Math.min(0.2 * Math.min(w, h), Math.max(22, 0.75 * isl.radius * s / Math.hypot(c[0], c[1], c[2]) * F));
    const g = freeSpot(sx, sy, r, w, h, T.panels);
    if (!g || (Math.abs(g[0] - sx) < 0.5 && Math.abs(g[1] - sy) < 0.5)) return tgt;
    const k = z / F;
    const off = add(scale(qrot(tgt.quat, [1, 0, 0]), (sx - g[0]) * k), scale(qrot(tgt.quat, [0, 1, 0]), (g[1] - sy) * k));
    return { ...tgt, pos: add(tgt.pos, off), centre: tgt.centre ? add(tgt.centre, off) : tgt.centre };
  }
  /** The panel boxes in stage pixels (read after a beat change, a selection, a dive or a resize: never per frame). */
  function measurePanels() {
    if (T.dead) return;
    const sr = stageEl.getBoundingClientRect();
    T.panels = [...document.querySelectorAll(PANELS)].filter(e => { const cs = getComputedStyle(e); return cs.visibility !== 'hidden' && +cs.opacity >= 0.5; })
      .map(e => e.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0 && r.bottom > sr.top && r.top < sr.bottom)
      .map(r => [r.left - sr.left, r.top - sr.top, r.right - sr.left, r.bottom - sr.top]);
    G?.labels?.measure(LABEL_BLOCKERS);          // the card that came with the selection is a blocker for labels too
    wake();
  }
  // after HOME's panels have finished their 0.42 s entrance
  function panelsSoon() { clearTimeout(T.panelT); T.panelT = setTimeout(measurePanels, 480); }

  function layerEvent(id, progressOnly) {
    const isl = G?.scene.islands.get(id);
    const best = isl?.best && isl.splatK > 0.05 ? isl.best : isl && isl.show > 0.5 && (isl.base || isl.dense) ? 'points' : 'poster';
    const now = performance.now();
    if (best === T.best[id] && (!progressOnly || now - T.lastLayerEv < 250)) return;
    T.lastLayerEv = now;
    const changed = best !== T.best[id];
    T.best[id] = best;
    const splats = best === 'standard' ? byId[id].stats.gaussians : best === 'lite' ? byId[id].stats.gaussians_lite : best === 'cut' ? atlas.islands[id].cut?.splats : null;
    _emit(EVENTS.LAYER, { id, best, progress: T.progress[id] ?? null, splats: splats ?? null });
    if (id === (story.dive?.id || story.S.island)) { if (changed) W.attr('load', best); chip(); }
  }
  function chip() {
    const id = story.dive?.id || story.S.island || hero;
    const best = T.best[id];
    const m = byId[id];
    if (T.stallChip && best !== 'lite' && best !== 'standard' && best !== 'cut') return hud.state('Preview', 'preview');
    if (best === 'standard') return hud.state(`Live render · ${(m.stats.gaussians / 1e6).toFixed(2)} M splats`, 'live');
    if (best === 'lite') return hud.state(`Live render · ${(m.stats.gaussians_lite / 1e6).toFixed(2)} M splats`, 'live');
    if (best === 'cut') return hud.state(`Live render · ${(atlas.islands[id].cut.splats / 1e6).toFixed(2)} M splats shown`, 'live');
    if (best === 'points') return hud.state('Live render · points', 'points');
    const pr = T.progress[id];
    return hud.state(pr ? `Loading ${Math.round(pr * 100)} %` : 'Preview', pr ? 'loading' : 'poster');
  }

  function onBeat(S, now) {
    const from = T.prevKind;
    T.prevKind = S.kind; T.prevCh = S.chapter; T.enteredAt = now;
    // the hand-off: the rise starts from wherever the autoplay was (no rewind, DE-2); back up, the autoplay resumes
    if (from === 'hero' && S.kind === 'rise' && G) { G.director.cap = { pos: pose.pos.slice(), quat: pose.quat.slice(), t: T.heroT }; T.capT = T.heroT; }
    if (S.kind === 'hero') { G && (G.director.cap = null); T.capT = null; }
    if (story.dive && S.kind !== 'explore') impl.surface();
    G?.gov.grace(500, `beat ${S.kind}`);
    // HOME's panels change per beat (after their 0.42 s entrance): the labels re-measure the boxes they keep out of
    if (G?.labels) setTimeout(() => G?.labels?.measure(LABEL_BLOCKERS), 500);
    if (S.kind === 'explore') panelsSoon();
    T.heroLoops = 0;
    for (const k of [-1, 0, 1]) { const c = tl.chapters.find(x => x.n === S.chapter + k); if (c) posters.load(c.island); }
    disposeFar();
    redeliverWanted();
    chip();
    planSoon();
  }

  // ---------------------------------------------------------------- explore: hover, tap, select, dive
  function pick(x, y) {
    if (!T.proj) return null;
    let best = null, bs = Infinity;
    for (const p of T.proj) {
      if (!p.front || p.show < 0.5) continue;
      // the selected island is lifted above the others: where islands overlap (landscape phones), it wins the tap
      const s = Math.hypot(x - p.c.x, y - p.c.y) / Math.max(p.r, 26) * (p.id === story.selected ? 0.6 : 1);
      if (s < 1 && s + p.dist * 1e-6 < bs) { bs = s + p.dist * 1e-6; best = p.id; }
    }
    return best;
  }
  function hoverAt(x, y, el) {
    if (story.S.kind !== 'explore' || story.dive || !G) { if (T.hover) setHover(''); return; }
    // at most 30 picks a second, with a trailing one: a pointer that stops inside the throttle window is still picked
    const since = performance.now() - (T.lastHover || 0);
    clearTimeout(T.hoverT);
    if (since < 33) { T.hoverT = setTimeout(() => hoverAt(x, y, el), 34 - since); return; }
    T.lastHover = performance.now();
    const overUi = el?.closest?.('a, button, [data-world="chips"], .explore-card, .dive-bar, .head, .mcard, .ov-panel, .strip, .ex-intro, .ex-foot');
    setHover(overUi ? '' : pick(x, y) || '');
  }
  function setHover(id) {
    if (id === T.hover) return;
    T.hover = id;
    root.toggleAttribute('data-hovering', !!id);
    _emit(EVENTS.ISLAND, id ? { id, why: 'hover' } : { id: story.selected || '', why: story.selected ? 'select' : 'clear' });
    if (id && !PHONE) setTimeout(() => { if (T.hover === id) loader?.want(id, 'hover'); }, 260);
    wake();
  }
  function tapAt(x, y, type) {
    if (story.S.kind !== 'explore' || story.dive || !G) return;
    const id = pick(x, y);
    if (!id) { if (story.selected) { story.selected = ''; _emit(EVENTS.ISLAND, { id: '', why: 'clear' }); wake(); } return; }
    if (type === 'mouse' || story.selected === id) impl.dive(id);
    else impl.select(id, { why: 'tap' });
  }

  // ---------------------------------------------------------------- the public implementation (api.js)
  impl = {
    select(id, { why = 'chip' } = {}) {
      if (!atlas.islands[id]) return Promise.resolve(null);
      story.selected = id;
      _emit(EVENTS.ISLAND, { id, why: 'select', via: why });
      loader?.want(id, why === 'hover' ? 'hover' : 'tap');
      redeliverWanted();
      panelsSoon();
      wake();
      return Promise.resolve({ id, mode: 'live' });
    },
    async dive(id) {
      if (!atlas.islands[id] || T.dead) return null;
      if (story.S.kind !== 'explore') await story.goto('explore', { smooth: false });
      story.selected = id;
      loader?.want(id, 'dive');
      if (!G || !tracks[id]) { T.pendingDive = id; planSoon(); return { id, mode: 'live', phase: 'waiting' }; }
      if (story.dive && story.dive.id === id) return { id, mode: 'live', phase: T.divePhase };
      if (story.dive) G.director.dv = null;
      if (!G.director.startDive(id, { pos: pose.pos.slice(), quat: pose.quat.slice(), fov: pose.fov }, PHONE)) return null;
      story.dive = { id, t: atlas.islands[id].dive.t0 };
      T.diveY = scrollY; T.divePhase = 'in';
      redeliverWanted();
      W.attr('diving', '1');
      _emit(EVENTS.DIVE, { id, phase: 'in', t: story.dive.t });
      log('dive', 4, { id, phase: 'in' });
      setHover('');
      planSoon(); wake();
      return { id, mode: 'live', phase: 'in' };
    },
    surface() {
      T.pendingDive = null;
      if (!G || !story.dive) return Promise.resolve(false);
      const ok = G.director.surface({ pos: pose.pos.slice(), quat: pose.quat.slice(), fov: pose.fov });
      if (ok) { T.divePhase = 'out'; _emit(EVENTS.DIVE, { id: story.dive.id, phase: 'out', t: story.dive.t }); }
      wake();
      return Promise.resolve(ok);
    },
    goto(target, opts = {}) {
      const m = /^island:(.+)$/.exec(target);
      if (m && !tl.chapters.some(c => c.island === m[1]) && m[1] !== hero) impl.select(m[1], { why: 'goto' });
      return story.goto(target, opts);
    },
    tilt(on) { return input.tilt(on); },
    info,
  };
  _attach(impl);
  setInfo(info);
  setHook('stage', () => G?.stage ?? null);
  function info() {
    return { mode: loader ? 'live' : 'pending', tier, why: choice?.why ?? '', level: G?.gov.level ?? 0, refreshHz: G ? +G.gov.refreshHz.toFixed(1) : null, capFps: G ? +G.gov.capFps().toFixed(1) : null,
      beat: story.S.kind, p: +story.S.p.toFixed(3), chapter: story.S.chapter, island: story.S.island, selected: story.selected,
      dive: story.dive ? { id: story.dive.id, phase: T.divePhase, t: +(story.dive.t ?? 0).toFixed(2) } : null, heroT: +T.heroT.toFixed(2), heroLive: T.heroLive,
      splatCheck: { ...T.splatCheck }, noSplats: T.noSplats,
      loader: loader?.info() ?? null, stage: G?.stage.info() ?? null, gov: G?.gov.info() ?? null, memory: G?.scene.memory() ?? null,
      layers: G ? G.scene.state() : null, camera: G ? { pos: pose.pos.map(v => +v.toFixed(2)), fov: +pose.fov.toFixed(1), near: +G.stage.camera.near.toFixed(3) } : null, moving: T.why, out: +T.out.toFixed(3), onscreen: T.onscreen,
      look: { x: +input.look.x.toFixed(4), y: +input.look.y.toFixed(4), drag: !!input.look.drag, tilt: !!input.look.tilt },
      proj: (T.proj || []).filter(p => p.front && p.show > 0.5).map(p => ({ id: p.id, x: Math.round(p.c.x), y: Math.round(p.c.y), r: Math.round(p.r) })), gpu: (caps.renderer || '').slice(0, 80), params: params && { tier: params.tier, fps: params.fps, playFps: params.playFps } };
  }

  // ---------------------------------------------------------------- scroll, size, visibility
  const onScroll = () => {
    pace.onScroll();
    T.heroLoops = 0;
    T.out = tl.out(scrollY);
    posters.flick(Math.abs(pace.v) > 2.5 * tl.H);
    if (T.out >= 0.999) { W.css(stageEl, '--out', 1); W.attr('rosario', ''); }
    if (G) { if (T.out >= 0.999) G.stage.pause('curtain'); else G.stage.resume('curtain'); }
    if (story.dive && T.divePhase !== 'out' && Math.abs(scrollY - T.diveY) > 60) impl.surface();
    wake(); planSoon();
  };
  addEventListener('scroll', onScroll, { passive: true });
  let lastW = innerWidth, lastO = screen.orientation?.angle ?? 0;
  // explore: the panel boxes the selected island is kept clear of are read at once, and again after the panels settle
  // (the old size's boxes aimed the camera wrong for 0.48 s after a turn: a 400-unit swerve on a phone)
  const fit = () => { if (G) { G.stage.resize(stageEl.clientWidth, stageEl.clientHeight); G.labels?.measure(LABEL_BLOCKERS); } hud.resize(); if (story.S.kind === 'explore') { measurePanels(); panelsSoon(); } };
  addEventListener('resize', () => {
    if (T.dead) return;
    const o = screen.orientation?.angle ?? 0;
    // height only: a phone's address bar moves innerHeight but not the stage (100lvh): no re-measure (PH-14). A window,
    // split screen or Stage Manager resize changes lvh too, and the beats (in lvh) with it: that one re-measures
    if (innerWidth === lastW && o === lastO && Math.abs(stageEl.offsetHeight - tl.H) < 2) { fit(); return; }
    lastW = innerWidth; lastO = o;
    story.remeasure(pace.y);
    // an explore dive stays down: the re-measure's own scroll (the beats moved in px) is not the reader's (> 60 px surfaced it)
    if (story.dive) T.diveY = scrollY;
    // a surfacing dive flies to the scroll's pose, which the new size re-fits (a turned phone's explore view moves about
    // 650 units): it flies on from where the camera is (it jumped up to 250 units in one frame)
    const dv = G?.director.dv;
    if (dv?.phase === 'out') { dv.from = { pos: pose.pos.slice(), quat: pose.quat.slice(), fov: pose.fov }; dv.k = 0; }
    fit(); planSoon(); wake();
  }, { passive: true });
  new IntersectionObserver(es => {
    const vis = es[es.length - 1].isIntersecting;
    if (vis === T.onscreen || T.dead) return;
    T.onscreen = vis;
    if (!vis) W.attr('rosario', '');
    log(vis ? 'onscreen' : 'offscreen', null);
    if (G) { if (vis) G.stage.resume('offscreen'); else G.stage.pause('offscreen'); }
    if (vis) { loader?.resume('offscreen'); lastNow = performance.now(); wake(); } else loader?.pause('offscreen');
  }).observe(root);
  document.addEventListener('visibilitychange', () => {
    if (T.dead) return;
    if (document.hidden) {
      G?.stage.pause('hidden'); loader?.pause('hidden');
      if (PHONE) T.hideT = setTimeout(() => { if (document.hidden && G) { for (const id of Object.keys(G.scene.splatTiers())) if (id !== story.S.island && id !== story.dive?.id) { G.scene.dropSplats(id); for (const t of ['cut', 'lite', 'standard']) loader.forget(id, t); } log('hidden-dispose', null); } }, HIDDEN_DISPOSE_MS);
    } else {
      clearTimeout(T.hideT);
      G?.stage.resume('hidden'); loader?.resume('hidden'); wake();
    }
  });
  // the back-forward cache: nothing in flight survives a page hide; a restored page plans afresh (RA-6)
  addEventListener('pagehide', () => { loader?.pause('pagehide'); G?.stage.pause('pagehide'); });
  addEventListener('pageshow', e => { if (e.persisted) { loader?.resume('pagehide'); G?.stage.resume('pagehide'); planSoon(); wake(); } });

  // ---------------------------------------------------------------- start
  posters.current(hero);
  story.update(scrollY, performance.now(), { heroT: T.heroT });
  T.prevKind = story.S.kind; T.prevCh = story.S.chapter;
  T.out = tl.out(scrollY);
  chip();
  wake();
  const battery = (navigator.getBattery ? Promise.race([navigator.getBattery().then(b => !b.charging && b.level < 0.98), new Promise(r => setTimeout(() => r(false), 1000))]) : Promise.resolve(false)).catch(() => false);
  idle(() => { if (probe()) { plan(); boot(battery).catch(e => fail(e)); } }, 600);
  return impl;

  // ---------------------------------------------------------------- the 3-D side
  function fail(e) {
    console.warn('[world] 3-D unavailable, staying on posters', e);
    log('no-3d', null, { msg: String(e?.message || e).slice(0, 120) });
    toStill(`3-D failed (${String(e?.message || e).slice(0, 60)})`);
  }
  async function boot(batteryP) {
    if (await batteryP) {
      params = tier === 'T4' ? { ...TIER_PARAMS.T3, playFps: 30, battery: true } : tier === 'T3' ? { ...params, playFps: 30, battery: true } : params;
      loader.params = params;      // SP: the loader kept the T4 limits (Standard files, 64 MB cache) on battery
      log('battery', null, { tier: params.tier, playFps: params.playFps });
    }
    if (!(await slowLinkOk())) return;
    // WIRE: fetch (and let the browser compile) three.js, Spark and the 3-D modules first, then evaluate them only in a
    // scroll pause: their evaluation is one 70-106 ms task at 4-6x CPU, which used to land inside a gesture on 4G
    // (on a fast link with the visitor still on the first screen the modules are imported at once: the preload round
    // trip cost the local first 3-D frame about 90 ms)
    const nav = performance.getEntriesByType?.('navigation')?.[0];
    const fastLink = !!nav && nav.responseEnd - nav.requestStart < 80;
    if (!fastLink || pace.engaged) {
      await prefetchModules();
      await scrollCalm(180, 3000);
    }
    if (T.dead) return;
    const [THREE, { WorldStage }, { WorldScene }, { Director }, { Governor }, { Labels, Anchors }, { Marks }] = await Promise.all([
      import('three'), import('./stage.js'), import('./scene.js'), import('./director.js'), import('./governor.js'), import('./labels.js'), import('./marks.js')]);
    if (T.dead) return;
    build({ THREE, WorldStage, WorldScene, Director, Governor, Labels, Anchors, Marks }, caps.gl);
    loadAtlasBin();
    fetch('data/starfield.json').then(r => (r.ok ? r.json() : null)).then(sf => { if (sf && G && params.backdrop) G.scene.setBackdrop(sf, atlas.backdrop); }).catch(() => null);
  }
  /** modulepreload every 3-D module (fetch + compile, no evaluation); resolves when all have settled (or after 20 s). */
  function prefetchModules() {
    const l0 = document.createElement('link');
    if (!l0.relList?.supports?.('modulepreload')) return Promise.resolve();
    const urls = ['vendor/three/three.core.js', 'vendor/three/three.module.js', 'vendor/three/addons/postprocessing/Pass.js',
      'vendor/spark/spark.module.js', 'js/world/stage.js', 'js/world/scene.js', 'js/world/director.js', 'js/world/governor.js',
      'js/world/labels.js', 'js/world/marks.js'].map(u => new URL(u, document.baseURI).href);
    const have = new Set([...document.querySelectorAll('link[rel="modulepreload"]')].map(l => l.href));
    return Promise.race([Promise.all(urls.filter(u => !have.has(u)).map(href => new Promise(res => {
      const l = document.createElement('link');
      l.rel = 'modulepreload'; l.href = href;
      l.onload = l.onerror = () => res();
      document.head.appendChild(l);
    }))), new Promise(r => setTimeout(r, 20000))]);
  }
  /** Resolves once the page has not scrolled for `quietMs`, or after `maxMs` at the latest. */
  function scrollCalm(quietMs, maxMs) {
    const t0 = performance.now();
    return new Promise(res => {
      const check = () => {
        const now = performance.now();
        if (now - pace.t >= quietMs || now - t0 >= maxMs || document.hidden) return res();
        setTimeout(check, Math.max(30, quietMs - (now - pace.t)));
      };
      check();
    });
  }
  /**
   * A link too slow for the first 3-D frame within 15 s goes to the still path before Spark is imported (SP-7). A '4g'
   * link always passes. Otherwise ('3g', or no navigator.connection: Safari, Firefox) the hero's own download is watched
   * for up to 1.5 s and judged on that file's origin (SP: the hero's first file is the ride cut, from the SITE; this used
   * to read the asset host's estimate, which on Safari / Firefox is a fixed default, so a slow-3G iPhone went live, and
   * it trusted Chrome's coarse '3g' estimate, which also fires on good links). The code (about 1.4 MB compressed) counts.
   */
  async function slowLinkOk() {
    const name = () => loader.nextBig(hero) || 'lite';
    const projected = () => loader.net(name()).eta(loader.left(hero, name()) + 1.4e6) + loader.decodeS;
    if (navigator.connection?.effectiveType === '4g') return true;
    const t0 = performance.now();
    while (performance.now() - t0 < 1500) {
      await new Promise(r => setTimeout(r, 250));
      const p = loader.I[hero].parts[name()];
      if (!p || p.state === 'done' || p.released || (loader.net(name()).n > 0 && projected() < 10)) return true;
    }
    // a slow link yields no throughput sample (those need 256 KB): the bytes the hero's file got in the window decide,
    // time to first byte included (conservative); with no byte at all, the estimate stands
    const p = loader.I[hero].parts[name()], got = p?.dl?.got || 0;
    const el = Math.max(0.25, (performance.now() - (p?.t0 ?? t0)) / 1000);
    const s = got > 0 && loader.net(name()).n === 0 ? (loader.left(hero, name()) + 1.4e6) / (got / el) + loader.decodeS : projected();
    if (s <= 15) return true;
    log('slow-link', null, { projected_s: +s.toFixed(1), got_mb: +(got / 1e6).toFixed(2) });
    T.stallChip = true;
    toStill(`slow connection (first 3-D frame in about ${s.toFixed(0)} s)`);
    return false;
  }

  function build(mods, gl) {
    const gov = new mods.Governor(params, { onLevel: (level, rec) => onLevel(level, rec) });
    const stage = new mods.WorldStage(canvasNow, { gl, params, governor: gov });
    const scene = new mods.WorldScene(stage, atlas, params);
    const director = new mods.Director({ atlas, scene, timeline: tl });
    for (const [id, tr] of Object.entries(tracks)) director.setTrack(id, tr);
    for (const id of ids) scene.addIsland(id, atlas.islands[id], null);
    const tpl = document.getElementById('tpl-island-label');
    const host = root.querySelector('[data-world="labels"]');
    const labels = host ? new mods.Labels(host, tpl, ids.map((id, i) => ({
      id, num: '', title: byId[id].title, sub: id,
    })), { onPick: id => (story.S.kind === 'explore' && story.selected === id ? impl.dive(id) : impl.select(id, { why: 'label' })) }) : null;
    const spring = new Spring(PHONE ? { wPos: 7, wRot: 6 } : { wPos: 9, wRot: 7 });
    // chapter 2's signposts (HOME's [data-world="marks"] layer): built once the island's track has arrived
    const marks = mods.Marks ? new mods.Marks({ THREE: mods.THREE, scene, stage, atlas, root, Anchors: mods.Anchors, tracks: id => tracks[id],
      onLive: on => W.attr('marks', on ? 'live' : '') }) : null;
    const g = { THREE: mods.THREE, mods, stage, scene, director, gov, labels, spring, marks };
    // the first frame that draws a joined splat file pays its GPU upload (inside Spark, on the main thread): logged
    stage.after.add(rec => {
      const u = T.upload;
      if (!u) return;
      const l = scene.islands.get(u.id)?.splats[u.tier];
      if (!l) { T.upload = null; return; }            // dropped before it was ever drawn
      if (!l.mesh.visible) return;
      T.upload = null;
      log('upload', chOf(u.id), { id: u.id, tier: u.tier, ms: +rec[3].toFixed(1) });
    });
    T.building = g;
    stage.onContext(state => onContext(state));
    stage.resize(stageEl.clientWidth, stageEl.clientHeight);
    // the points and route programs compile in parallel (KHR_parallel_shader_compile) before the first 3-D frame, so no
    // frame links a program on the main thread; the 2-D ticker keeps the page alive meanwhile
    const go = () => {
      if (T.dead || T.building !== g) return;
      T.building = null;
      G = g;
      for (const [id, tr] of Object.entries(tracks)) g.director.setTrack(id, tr);
      const gt = /^gpu:(\d+)$/.exec(qs.get('gov_test') || '');
      if (gt) govLoad(Number(gt[1]));
      if (atlasBin) for (const id of ids) setBase(id);
      for (const [id, isl] of Object.entries(loader.I)) if (isl.parts.dense?.data) scene.densify(id, isl.parts.dense.data);
      redeliverWanted();
      stage.hooks.add((dt, now) => tick(dt, now));
      if (!T.onscreen) stage.pause('offscreen');
      if (T.out >= 0.999) stage.pause('curtain');
      if (document.hidden) stage.pause('hidden');
      cancelAnimationFrame(raf); raf = 0;
      stage.sparkReady.then(() => { planSoon(); wake(); });
      planSoon();
      wake();
    };
    Promise.race([stage.renderer.compileAsync(stage.scene, stage.camera), new Promise(r => setTimeout(r, 2000))]).catch(() => null).then(go);
    return g;
  }

  function onLevel(level, rec) {
    log('gov', null, rec);
    W.attr('level', level);
    _emit(EVENTS.TIER, { tier, level, reason: rec.reason });
    if (level >= 7) { toStill(`below 20 fps at the lowest quality (${rec.reason})`); return; }
    const rung = G.gov.rung;
    G.stage.applyRung(rung);
    G.scene.setHalfPoints(!!rung.halfPoints);
    if (rung.dropNonCurrent) for (const id of Object.keys(G.scene.splatTiers())) if (id !== story.S.island && id !== story.dive?.id) { G.scene.dropSplats(id); for (const t of ['cut', 'lite', 'standard']) loader.forget(id, t); }
  }
  /** ?gov_test=gpu:N: a synthetic fragment load (N loop iterations per pixel) to exercise the governor (M10). */
  function govLoad(n) {
    const THREE = G.THREE;
    const m = new THREE.ShaderMaterial({
      vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `uniform float uN; void main(){ float v = 0.0; for (int i = 0; i < 4000000; i++) { if (float(i) >= uN) break; v += sin(float(i) * 0.37 + gl_FragCoord.x * 0.01); } gl_FragColor = vec4(vec3(v * 1e-12), 0.0); }`,
      uniforms: { uN: { value: n } }, depthTest: false, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending,
    });
    const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), m);
    q.frustumCulled = false; q.renderOrder = 99;
    G.stage.scene.add(q);
    // PL: the load can change while the page runs (M10 down then up: __world.govLoad(0) lifts it)
    setHook('govLoad', v => { m.uniforms.uN.value = Math.max(0, +v || 0); G?.stage.invalidate(); });
  }

  // atlas.bin: level 0 for every island (phones stop there), then level 1 (T3 / T4). Starts at the first scroll, 1 s after
  // the hero is live, or at 6 s, whichever comes first; the bytes are kept for a context rebuild.
  function setBase(id) {
    if (!G || !atlasBin) return;
    const i = atlas.order.indexOf(id), lv = atlas.bin.levels, st = atlas.bin.stride;
    const n0 = lv[0].n, rec0 = atlasBin.l0.subarray(i * n0 * st, (i + 1) * n0 * st);
    if (!atlasBin.l1) { G.scene.setBase(id, rec0, n0); return; }
    const n1 = lv[1].n, rec = new Uint8Array((n0 + n1) * st);
    rec.set(rec0); rec.set(atlasBin.l1.subarray(i * n1 * st, (i + 1) * n1 * st), n0 * st);
    G.scene.setBase(id, rec, n0 + n1);
  }
  /** Resolves once the stage is in view (on screen, curtain open, tab visible); never after the world has stopped. */
  function onStage() {
    return new Promise(res => { const chk = () => { if (T.dead) return; if (T.onscreen && T.out < 0.999 && !document.hidden) res(); else setTimeout(chk, 500); }; chk(); });
  }
  function loadAtlasBin() {
    if (binStarted) return;
    const go = () => {
      if (binStarted || T.dead) return;
      binStarted = true;
      removeEventListener('scroll', go);
      const lv = atlas.bin.levels, url = atlas.bin.file;
      const range = async l => {
        const t0 = performance.now();
        const r = await fetch(url, { headers: { Range: `bytes=${l.offset}-${l.offset + l.bytes - 1}` } });
        if (!(r.ok)) throw new Error(`atlas.bin: HTTP ${r.status}`);
        const buf = new Uint8Array(await r.arrayBuffer());
        loader.nets.site.sample(buf.byteLength, (performance.now() - t0) / 1000, true);
        return r.status === 206 ? buf : buf.subarray(l.offset, l.offset + l.bytes);
      };
      log('dl-start', null, { part: 'atlas.bin', level: 0 });
      range(lv[0]).then(l0 => {
        atlasBin = { l0, l1: null };
        log('dl-done', null, { part: 'atlas.bin', level: 0, mb: +(l0.byteLength / 1e6).toFixed(2) });
        for (const id of ids) setBase(id);
        wake();
        // SP: level 1 (1.9 MB, desktops) waits until the stage is in view: a flick to the story used to start it after
        // the curtain had closed (the plan allows no bytes after the curtain)
        if (params.baseLevels > 1) return onStage().then(() => range(lv[1])).then(l1 => { atlasBin.l1 = l1; for (const id of ids) setBase(id); log('dl-done', null, { part: 'atlas.bin', level: 1 }); wake(); });
        return null;
      }).catch(e => { binStarted = false; log('dl-fail', null, { part: 'atlas.bin', why: String(e?.message || e).slice(0, 80) }); setTimeout(go, 4000); });
    };
    addEventListener('scroll', go, { passive: true, once: true });
    setTimeout(go, 6000);
    const w8 = setInterval(() => { if (T.heroLive) { clearInterval(w8); setTimeout(go, 1000); } if (binStarted) clearInterval(w8); }, 250);
    if (scrollY > tl.H * 0.2) go();
  }

  // ---------------------------------------------------------------- context loss (iOS evicts contexts under memory pressure)
  function onContext(state) {
    if (state === 'lost') {
      W.attr('ctx', 'lost');
      T.losses = T.losses.filter(t => performance.now() - t < 60000);
      T.losses.push(performance.now());
      _emit(EVENTS.CTX, { state: 'lost' }); log('ctx-lost', null, { n: T.losses.length });
      // WIRE: release the old GPU objects now, while the context is lost (the rebuild makes everything afresh). Chapter 2's
      // signposts too (reviewer B): freed at the rebuild, after a restore, their buffers named the old context's objects (22
      // INVALID_OPERATION warnings), and their card hung over the poster cover until then; the strip's cap holds the fact
      if (G && !G.released) { G.released = true; G.marks?.destroy(); try { G.scene.disposeAll(); } catch (e) { /* gone */ } G.stage.releaseGpu(); }
      clearTimeout(T.ctxTimer);
      T.ctxTimer = setTimeout(() => rebuild('replaced'), 3000);      // iOS often never restores: replace the canvas
      return;
    }
    if (state === 'restored') { clearTimeout(T.ctxTimer); rebuild('restored'); }
  }
  function rebuild(how) {
    if (T.dead || !G) return;
    const mods = G.mods, old = G;
    G = null;
    if (!old.released) try { old.scene.disposeAll(); } catch (e) { /* the context is gone */ }
    old.stage.dispose();
    old.labels?.destroy();
    old.marks?.destroy();
    if (T.losses.length >= 3) { _emit(EVENTS.CTX, { state: 'failed' }); log('ctx-failed', null, {}); toStill('the 3-D context was lost three times'); return; }
    if (T.losses.length === 2 && params.tier !== 'T1') {
      const down = { T4: 'T3', T3: 'T2', T2: 'T1' }[params.tier];
      params = { ...TIER_PARAMS[down], fps: Math.min(params.fps, TIER_PARAMS[down].fps), playFps: Math.min(params.playFps, TIER_PARAMS[down].playFps) };
      loader.params = params;      // SP: the loader's byte cache, lookahead and splat tiers follow the lower tier
      tier = down; W.attr('tier', down);
      log('tier-down', null, { to: down });
      _emit(EVENTS.TIER, { tier: down, level: 0, reason: 'second context loss within 60 s' });
    }
    // a fresh canvas and context (the restored one is not trusted after a loss)
    const fresh = canvasNow.cloneNode(false);
    canvasNow.replaceWith(fresh);
    canvasNow = fresh;
    const c2 = detectCaps({ canvas: fresh });
    if (!c2.webgl2 || c2.software) { _emit(EVENTS.CTX, { state: 'failed' }); toStill('no WebGL2 after a context loss'); return; }
    decoding.clear();          // queued decodes belong to the old scene (they skip themselves)
    for (const id of ids) for (const t of ['cut', 'lite', 'standard']) loader.forget(id, t);
    for (const id of ids) { const p = loader.I[id].parts.dense; if (p?.state === 'done' && !p.data) p.state = 'idle'; }
    build(mods, c2.gl).gov.grace(1000, 'context restore');
    W.attr('ctx', '');
    _emit(EVENTS.CTX, { state: how }); log(how === 'restored' ? 'ctx-restored' : 'ctx-replaced', null, {});
    lastTarget = null;
    planSoon(); wake();
  }
  // ---------------------------------------------------------------- the floor: still mode
  function toStill(why) {
    if (T.dead) return;
    T.dead = true;
    log('degrade', null, { reason: why });
    loader?.pause('degraded');
    input.detach();
    // PL: a context probed on the stage's canvas but never handed to a stage (a slow link, a module that failed to load)
    // is released: it held GPU memory for the rest of the visit in still mode
    if (!G && !T.building && caps.gl && !caps.gl.isContextLost()) caps.gl.getExtension('WEBGL_lose_context')?.loseContext();
    for (const g of [G, T.building]) if (g) { g.marks?.destroy(); try { g.scene.disposeAll(); } catch (e) { /* gone */ } g.stage.dispose(); g.labels?.destroy(); }
    G = null; T.building = null;
    removeEventListener('scroll', onScroll);
    still({ maps, atlas, routes, root, tl, why, reduced: false, tier: 'T0' });
  }
}
