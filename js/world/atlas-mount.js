// The atlas on any page (MASTER_PLAN.md 3.1; the Maps page header, SB-1): every published map as an island, seen from
// the overview, with the same tiers, governor and scene as the home page's world, and no beats. Hover (mouse) or a first
// tap lifts an island and reports it (onSelect); a click or a second tap reports a dive (onDive), which the page turns
// into the viewer. Devices on the still path get the 2-D atlas (atlasmap.js) with the same picking.
import { detectCaps, chooseTier } from './caps.js';
import { AtlasMap } from './atlasmap.js';
import { Spring, lookQuat, orbit, qmul, yawPitch } from './camera.js';
import { attachInput } from './input.js';

const qs = new URLSearchParams(location.search);
/** The page's projection rule: 46 deg on landscape; narrower elements widen it (keeping the width), to 64 deg. */
const fovFor = asp => (asp >= 1.6 ? 46 : Math.min(64, 2 * Math.atan(Math.tan(23 * Math.PI / 180) * 1.6 / asp) * 180 / Math.PI));

export async function mount(el, { maps, atlas, interactive = true, initial = null, still = false, onSelect, onDive, shift = 0.6 } = {}) {
  const byId = Object.fromEntries((maps?.maps || []).map(m => [m.id, m]));
  const ids = atlas.order.filter(id => atlas.islands[id]);
  const force = { world: still ? 'still' : qs.get('world'), tier: qs.get('tier') };
  let choice = chooseTier(detectCaps(), { force });
  if (choice.tier === 'T0') return mountStill(el, { atlas, byId, ids, interactive, initial, onSelect, onDive });
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  el.appendChild(canvas);
  const caps = detectCaps({ canvas });
  choice = chooseTier(caps, { force });
  if (choice.tier === 'T0') {
    caps.gl?.getExtension('WEBGL_lose_context')?.loseContext();
    canvas.remove();
    return mountStill(el, { atlas, byId, ids, interactive, initial, onSelect, onDive });
  }
  // PL: if the 3-D modules cannot load (a failed vendor fetch, a browser without import maps that slipped past caps.js),
  // the 2-D atlas takes over (P1: "still instead of reject"); the probed context is released, not left on a live canvas
  let mods;
  try { mods = await Promise.all([import('./stage.js'), import('./scene.js'), import('./governor.js')]); } catch (e) {
    caps.gl?.getExtension('WEBGL_lose_context')?.loseContext();
    canvas.remove();
    return mountStill(el, { atlas, byId, ids, interactive, initial, onSelect, onDive });
  }
  const [{ WorldStage }, { WorldScene }, { Governor }] = mods;
  const params = choice.params, PHONE = params.phone;
  let stage = null;
  const gov = new Governor(params, { onLevel: (level) => { if (level >= 7) { destroy(); fallback(); } else { stage.applyRung(gov.rung); scene.setHalfPoints(!!gov.rung.halfPoints); } } });
  stage = new WorldStage(canvas, { gl: caps.gl, params, governor: gov });
  const scene = new WorldScene(stage, atlas, params);
  // integrator (review SB, E-SB1): WIRE's island glow (haloK) is raised only by the home world's backdrop fade; here no
  // backdrop is built, so set it at once: the islands read as places from above, not thin outlines
  scene.setBackdropK(1);
  for (const id of ids) scene.addIsland(id, atlas.islands[id], null);
  const spring = new Spring(PHONE ? { wPos: 7, wRot: 6 } : { wPos: 9, wRot: 7 });
  const S = { hover: '', focus: '', sel: initial || '', proj: [], lastProj: 0, alive: true, onscreen: true };
  const fit = () => { const r = el.getBoundingClientRect(); stage.resize(Math.round(r.width), Math.round(r.height)); };
  const ro = new ResizeObserver(fit);
  ro.observe(el);
  fit();

  // the base points: level 0 for every island (then level 1 on desktops), straight to the GPU; the mount resolves once
  // level 0 is on the canvas (the page fades its poster stand-in out then)
  let firstFrame = null;
  const drawn = new Promise(r => { firstFrame = r; });
  const loaded = (async () => {
    const lv = atlas.bin.levels, st = atlas.bin.stride;
    const get = async l => {
      const r = await fetch(atlas.bin.file, { headers: { Range: `bytes=${l.offset}-${l.offset + l.bytes - 1}` } });
      if (!r.ok) throw new Error(`atlas.bin: HTTP ${r.status}`);
      const b = new Uint8Array(await r.arrayBuffer());
      return r.status === 206 ? b : b.subarray(l.offset, l.offset + l.bytes);
    };
    const l0 = await get(lv[0]);
    if (!S.alive) return;
    ids.forEach(id => { const i = atlas.order.indexOf(id); scene.setBase(id, l0.subarray(i * lv[0].n * st, (i + 1) * lv[0].n * st), lv[0].n); });
    S.based = true;
    stage.invalidate();
    if (params.baseLevels < 2) return;
    get(lv[1]).then(l1 => {
      if (!S.alive) return;
      ids.forEach(id => {
        const i = atlas.order.indexOf(id), n0 = lv[0].n, n1 = lv[1].n, rec = new Uint8Array((n0 + n1) * st);
        rec.set(l0.subarray(i * n0 * st, (i + 1) * n0 * st)); rec.set(l1.subarray(i * n1 * st, (i + 1) * n1 * st), n0 * st);
        scene.setBase(id, rec, n0 + n1);
      });
    }).catch(() => null);
  })();
  stage.after.add(() => { if (S.based && scene.islands.size) firstFrame(); });

  const input = interactive ? attachInput(el, {
    onLook: () => stage.invalidate(),
    onHover: (x, y) => {
      // a move outside the element clears only a lift the pointer made (a page-set focus stays until focus(null))
      const r = el.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) { if (S.hover) setHover(''); return; }
      setHover(pick(x - r.left, y - r.top) || '');
    },
    onTap: (x, y, type) => {
      const r = el.getBoundingClientRect(), id = pick(x - r.left, y - r.top);
      if (!id) return;
      if (type === 'mouse' || S.sel === id) onDive?.(id, { t: atlas.islands[id].dive?.t0 });
      else { S.sel = id; onSelect?.(id, { why: 'tap' }); stage.invalidate(); }
    },
  }) : null;
  function pick(x, y) {
    let best = null, bs = Infinity;
    for (const p of S.proj) {
      if (!p.front) continue;
      const s = Math.hypot(x - p.c.x, y - p.c.y) / Math.max(p.r, 26);
      if (s < 1 && s < bs) { bs = s; best = p.id; }
    }
    return best;
  }
  function setHover(id) {
    if (id === S.hover) return;
    S.hover = id;
    el.style.cursor = id ? 'pointer' : '';
    onSelect?.(id || null, { why: id ? 'hover' : 'clear' });
    stage.invalidate();
  }

  // one frame: the overview, fitted to fill about 70 % of the element (this page has no panel to leave room for), a
  // look-around that orbits it, the lifted island
  const ov = atlas.views.overview;
  const dir = [0, 1, 2].map(k => ov.pos[k] - ov.target[k]);
  const dl = Math.hypot(...dir);
  const reach = Math.max(...ids.map(id => { const i = atlas.islands[id]; return Math.hypot(i.place.x - ov.target[0], i.place.z - ov.target[2]) + i.radius * i.scale; }));
  const fitPos = (w, h) => {
    const asp = w / Math.max(1, h), vf = fovFor(asp) * Math.PI / 180, hf = 2 * Math.atan(Math.tan(vf / 2) * asp);
    const d = reach / Math.sin(Math.min(vf, hf) / 2) * 0.8;
    return dir.map((v, k) => ov.target[k] + v / dl * d);
  };
  stage.hooks.add((dt, now) => {
    let more = false;
    const pos0 = fitPos(stage.size.w, stage.size.h), tgt = ov.target;
    if (input?.step(dt)) more = true;
    const L = input?.look || { x: 0, y: 0 };
    const pos = orbit(pos0, tgt, -L.x * 0.6);
    const q = qmul(lookQuat(pos, tgt), yawPitch(0, -L.y * 0.3));
    if (spring.step(dt, pos, q, 46, 0.05)) more = true;
    const cam = stage.camera;
    cam.position.set(...spring.pos); cam.quaternion.set(...spring.quat);
    const w = stage.size.w, h = stage.size.h, asp = w / Math.max(1, h), fov = fovFor(asp);
    // a lens shift (not a turn): on a wide element the arrangement's middle sits at `shift` of its width
    const k = asp > 1.2 && w >= 700 ? 2 * shift : 1;
    if (cam.fov !== fov || cam.aspect !== asp || S.k !== k) {
      S.k = k;
      cam.fov = fov; cam.aspect = asp; cam.near = 1; cam.far = 30000;
      if (k > 1.001) cam.setViewOffset(w * k, h, 0, 0, w, h); else cam.clearViewOffset();
      cam.updateProjectionMatrix();
    }
    for (const id of ids) {
      const isl = atlas.islands[id], on = id === S.hover || id === S.focus || id === S.sel;
      scene.setIsland(id, { show: 1, lift: on ? 14 + 0.06 * isl.radius * isl.scale : 0, hi: on ? 1 : 0, splat: 0, route: { a: 0, b: 1, o: 1 } });
    }
    if (scene.update(dt)) more = true;
    if (now - S.lastProj > 33) { S.lastProj = now; S.proj = scene.project(stage.size.w, stage.size.h); }
    return more;
  });
  const io = new IntersectionObserver(es => { S.onscreen = es[es.length - 1].isIntersecting; if (S.onscreen) stage.resume('offscreen'); else stage.pause('offscreen'); });
  io.observe(el);
  const vis = () => { if (document.hidden) stage.pause('hidden'); else stage.resume('hidden'); };
  document.addEventListener('visibilitychange', vis);
  vis();
  canvas.addEventListener('webglcontextlost', () => { destroy(); fallback(); }, { once: true });
  stage.invalidate();

  let alt = null;
  function fallback() { alt = mountStill(el, { atlas, byId, ids, interactive, initial: S.sel, onSelect, onDive }); firstFrame(); }
  // resolve after the first frame with the islands (or after the 2-D fallback took over); a failed atlas.bin rejects
  try { await Promise.race([drawn, loaded.then(() => drawn)]); } catch (e) { destroy(); throw e; }
  function destroy() {
    if (!S.alive) return;
    S.alive = false;
    ro.disconnect(); io.disconnect(); input?.detach();
    document.removeEventListener('visibilitychange', vis);
    try { scene.disposeAll(); } catch (e) { /* the context is gone */ }
    stage.dispose();
    canvas.remove();
  }
  return {
    get mode() { return alt ? alt.mode : 'live'; },
    select(id) { if (alt) return alt.select(id); S.sel = id || ''; stage.invalidate(); return Promise.resolve(id); },
    focus(id) { if (alt) return alt.focus(id); S.focus = id || ''; stage.invalidate(); return null; },
    /** integrator (review SB, E-SB2): the island's projected centre and radius in element pixels (null on the 2-D path or
     *  when it is behind the camera): maps.js places its card clear of the island it names */
    where(id) { if (alt) return null; const p = S.proj.find(q => q.id === id); return p && p.front ? { x: p.c.x, y: p.c.y, r: p.r } : null; },
    destroy() { if (alt) alt.destroy(); else destroy(); },
  };
}

/** The 2-D atlas in an element: footprints, routes, names; hover / tap picks the same way. */
function mountStill(el, { atlas, byId, ids, interactive, initial, onSelect, onDive }) {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  el.appendChild(canvas);
  const map = new AtlasMap(canvas, atlas, { labels: true, titles: Object.fromEntries(ids.map(id => [id, byId[id]?.title || id])), pad: 28 });
  const S = { hover: '', sel: initial || '' };
  const draw = () => map.draw({ focus: S.hover || S.sel, hi: new Set([S.hover, S.sel].filter(Boolean)) });
  const ro = new ResizeObserver(() => { map.resize(); draw(); });
  ro.observe(el);
  const local = e => { const r = canvas.getBoundingClientRect(); return map.pick(e.clientX - r.left, e.clientY - r.top); };
  const onMove = e => { if (e.pointerType !== 'mouse') return; const id = local(e) || ''; if (id !== S.hover) { S.hover = id; canvas.style.cursor = id ? 'pointer' : ''; onSelect?.(id || null, { why: id ? 'hover' : 'clear' }); draw(); } };
  const onUp = e => {
    const id = local(e);
    if (!id) return;
    if (e.pointerType === 'mouse' || S.sel === id) onDive?.(id, { t: atlas.islands[id].dive?.t0 });
    else { S.sel = id; onSelect?.(id, { why: 'tap' }); draw(); }
  };
  if (interactive) { el.addEventListener('pointermove', onMove, { passive: true }); el.addEventListener('pointerup', onUp, { passive: true }); }
  draw();
  return {
    mode: 'still',
    select(id) { S.sel = id || ''; draw(); return Promise.resolve(id); },
    focus(id) { S.hover = id || ''; draw(); return null; },
    destroy() { ro.disconnect(); el.removeEventListener('pointermove', onMove); el.removeEventListener('pointerup', onUp); canvas.remove(); },
  };
}
