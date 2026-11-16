// V12 "floating trajectories" (owner 2026-11-13: "bring back the floating trajectories from current live website, make
// them interactive (when clicked goes to 3d map or depth map difference etc.)").
// The 8 places as point islands floating in the dark, each with the camera's path as one line: the live site's atlas
// (data/atlas.json + data/atlas.bin, the arrangement concept E drew). Each name is a door with two choices:
// walk into the 3-D place, or see its depth (classic against AI). A click on an island opens the same choice.
// Plain three.js points and lines (no splat renderer). Frames are drawn only when the pointer, the scroll or the size
// changes; nothing moves by itself. Phones and devices without WebGL2 keep the static list in the HTML.
import * as THREE from 'three';
import { getJSON, loadPlaces } from '/js/v4/common.js';

const DEG = Math.PI / 180;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;
const css = (name, fb) => (getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb);

const VERT = /* glsl */`
  attribute vec3 aRgb;
  uniform float uSize, uPR, uViewH, uOpacity, uHi, uMinPx, uMaxPx, uGain;
  varying vec3 vC; varying float vA;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float d = max(1e-3, -mv.z);
    gl_Position = projectionMatrix * mv;
    float px = uSize * uViewH * 0.5 * projectionMatrix[1][1] / d;
    gl_PointSize = clamp(px, uMinPx * uPR, uMaxPx * uPR);
    vC = min(vec3(1.0), aRgb * uGain + 0.05) * (1.0 + 0.5 * uHi);
    vA = uOpacity * max(0.3, clamp(px / (uMinPx * uPR), 0.0, 1.0));
  }`;
const FRAG = /* glsl */`
  varying vec3 vC; varying float vA;
  void main() {
    vec2 q = gl_PointCoord * 2.0 - 1.0;
    float r = dot(q, q);
    if (r > 1.0) discard;
    float a = vA * (1.0 - r * r);
    gl_FragColor = vec4(min(vec3(1.0), vC) * a, a);
  }`;

/**
 * root: the section's stage element, holding canvas.f-atlas-canvas, .f-atlas-labels and .f-atlas-pick.
 * links: { open(id) -> url of the 3-D view, depth(id) -> url of the depth comparison }
 */
export async function mountAtlas(root, links, opts = {}) {
  // embedded (in the home stage): the page sets k (0 = close on one island, 1 = all eight) and turns the doors on
  const EMB = !!opts.embedded;
  const canvas = root.querySelector('.f-atlas-canvas'), layer = root.querySelector('.f-atlas-labels'), pick = root.querySelector('.f-atlas-pick');
  // transparent: during the hand-off the park shows through until it fades (the stage behind is black)
  const TOUCH = matchMedia('(hover: none), (pointer: coarse)').matches;
  const AA = !TOUCH;                                                  // touch screens: no MSAA (lighter)
  const gl = canvas.getContext('webgl2', { antialias: AA, alpha: true, premultipliedAlpha: true, powerPreference: 'high-performance' });
  if (!gl) return null;
  const [A, P] = await Promise.all([getJSON('data/atlas.json'), loadPlaces()]);
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: AA });
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(40, 1, 1, 20000);
  const ids = A.order.filter(id => A.islands[id] && P.byId[id]);
  const pathCol = new THREE.Color(css('--path', '#6fc7b0'));
  const isl = new Map();
  for (const id of ids) {
    const d = A.islands[id], s = d.scale;
    const g = new THREE.Group();
    g.position.set(d.place.x, d.place.y, d.place.z); g.rotation.set(0, d.place.yaw, 0); g.scale.setScalar(s);
    const box = new THREE.Group();
    box.position.fromArray(d.box[0]);
    box.scale.set(...d.box[1].map((v, k) => Math.max(1e-6, v - d.box[0][k])));
    g.add(box);
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendEquation: THREE.AddEquation,
      uniforms: { uSize: { value: 1.1 * s }, uPR: { value: 1 }, uViewH: { value: 900 }, uOpacity: { value: 0.95 }, uHi: { value: 0 },
        uMinPx: { value: 1.3 }, uMaxPx: { value: 5 }, uGain: { value: d.points?.colour === 'rgb8' ? 1.15 : 1.3 } },
    });
    // the camera's path: one line in the path colour, a little above the points
    let line = null;
    if (d.route?.length > 1) {
      const pts = d.route.map(p => new THREE.Vector3(p[0], p[1] + 0.6, p[2]));
      line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: pathCol, transparent: true, opacity: 0.9, depthWrite: false }));
      line.renderOrder = 2;
      g.add(line);
    }
    g.updateMatrixWorld(true);
    const cx = (d.box[0][0] + d.box[1][0]) / 2, cz = (d.box[0][2] + d.box[1][2]) / 2;
    const top = g.localToWorld(new THREE.Vector3(cx, d.box[1][1] + 3, cz));
    const mid = g.localToWorld(new THREE.Vector3(cx, (d.box[0][1] + d.box[1][1]) / 2, cz));
    scene.add(g);
    isl.set(id, { id, d, g, box, mat, line, top, mid, hi: 0 });
  }
  // the points: atlas.bin (levels 0 and 1; 10-byte records: uint16 x, y, z over the island box, then r, g, b, pad)
  const lv = A.bin.levels, st = A.bin.stride;
  // touch (owner 11-16: "heavy"): level 0 only (12 000 points a place, not 36 000), and only its bytes (0.96 of 2.88 MB)
  const r = await fetch('/' + A.bin.file, TOUCH ? { headers: { Range: `bytes=0-${lv[0].offset + lv[0].bytes - 1}` } } : undefined);
  if (!r.ok) throw new Error(`atlas.bin: HTTP ${r.status}`);
  const all = new Uint8Array(await r.arrayBuffer());
  // the range starts at byte 0, so a 206 (bytes 0..end of level 0) and a 200 (the whole file) slice the same way
  if (all.byteLength < lv[0].offset + lv[0].bytes) throw new Error(`atlas.bin: ${all.byteLength} bytes, short`);
  const n0 = lv[0].n, n1 = TOUCH ? 0 : lv[1]?.n || 0;
  for (const I of isl.values()) {
    const i = A.order.indexOf(I.id), rec = new Uint8Array((n0 + n1) * st);
    rec.set(all.subarray(lv[0].offset + i * n0 * st, lv[0].offset + (i + 1) * n0 * st));
    if (n1) rec.set(all.subarray(lv[1].offset + i * n1 * st, lv[1].offset + (i + 1) * n1 * st), n0 * st);
    const g = new THREE.BufferGeometry(), n = n0 + n1;
    g.setAttribute('position', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(new Uint16Array(rec.buffer, 0, n * 5), 5), 3, 0, true));
    g.setAttribute('aRgb', new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(new Uint8Array(rec.buffer, 0, n * 10), 10), 3, 6, true));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0.5, 0.5, 0.5), 0.87);
    const pts = new THREE.Points(g, I.mat);
    pts.frustumCulled = false;
    I.box.add(pts);
  }

  // ---- the camera: the atlas overview, fitted to the box; the pointer and the scroll turn it a little
  // the middle of the eight places (owner 11-13: "make it so it all stays in the middle of page"); the overview's direction
  const ov = A.views.overview, T = new THREE.Vector3();
  for (const I of isl.values()) T.add(I.mid);
  T.multiplyScalar(1 / isl.size);
  const dv = new THREE.Vector3(...ov.pos).sub(new THREE.Vector3(...ov.target));
  const az0 = Math.atan2(dv.x, dv.z), el0 = Math.atan2(dv.y, Math.hypot(dv.x, dv.z));
  let reach = 0;
  for (const I of isl.values()) reach = Math.max(reach, Math.hypot(I.mid.x - T.x, I.mid.z - T.z) + I.d.radius * I.d.scale);
  const S = { W: 1, H: 1, dist: 1, fov: 40, px: 0, py: 0, tpx: 0, tpy: 0, scroll: 0.5, hi: '', k: EMB ? 0 : 1, on: !EMB, from: null };
  const C = isl.get(opts.close) || isl.values().next().value;     // the island the page comes from (close view, k 0)
  function fit() {
    const w = root.clientWidth, h = root.clientHeight;
    if (!w || !h) return;
    S.W = w; S.H = h;
    renderer.setPixelRatio(Math.min(TOUCH ? 1 : 2, devicePixelRatio || 1));   // touch: lighter (soft points need no more)
    renderer.setSize(w, h, false);
    cam.aspect = w / h;
    S.fov = w / h >= 1 ? 40 : 58;
    const vf = S.fov * DEG, hf = 2 * Math.atan(Math.tan(vf / 2) * cam.aspect);
    // all eight in the middle, with room around them (the page's words sit above)
    const fitAng = cam.aspect >= 1 ? Math.min(hf * 0.62, vf * 1.05) : Math.min(vf, hf) * 0.9;
    S.dist = reach / Math.sin(fitAng / 2);
    for (const I of isl.values()) { I.mat.uniforms.uPR.value = renderer.getPixelRatio(); I.mat.uniforms.uViewH.value = h * renderer.getPixelRatio(); }
    draw();
  }
  const Tk = new THREE.Vector3(), o0 = new THREE.Vector3(), o1 = new THREE.Vector3(), d0 = new THREE.Vector3(), d1 = new THREE.Vector3();
  const q0 = new THREE.Quaternion(), qs = new THREE.Quaternion(), Z = new THREE.Vector3(0, 0, 1);
  function place() {
    // k 0 = the page's own camera (setFrom: the park's camera, so this island lies on the park's points); k 1 = all eight
    // in the middle. The target moves straight; the camera's offset turns on a sphere and its length moves on a log scale.
    const e = S.k * S.k * (3 - 2 * S.k);
    const az = az0 + (REDUCE ? 0 : (S.px * 9 * DEG + (S.scroll - 0.5) * 14 * DEG) * e);
    const el = clamp(el0 + (REDUCE ? 0 : -S.py * 4 * DEG * e), 18 * DEG, 80 * DEG);
    o1.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).multiplyScalar(S.dist);
    const F = S.from;
    if (F) {
      Tk.copy(F.target).lerp(T, e);
      o0.subVectors(F.pos, F.target);
      const L0 = o0.length(), L1 = o1.length();
      d0.copy(o0).normalize(); d1.copy(o1).normalize();
      q0.setFromUnitVectors(d0, d1); qs.identity().slerp(q0, e);
      cam.position.copy(d0).applyQuaternion(qs).multiplyScalar(Math.exp(Math.log(L0) + (Math.log(L1) - Math.log(L0)) * e)).add(Tk);
    } else {
      const dC = C.d.radius * C.d.scale * 2.4;
      Tk.copy(C.mid).lerp(T, e);
      cam.position.copy(o1).normalize().multiplyScalar(Math.exp(Math.log(dC) + (Math.log(S.dist) - Math.log(dC)) * e)).add(Tk);
    }
    cam.lookAt(Tk);
    // the lens and the picture's shift go from the page's camera to the atlas's own
    cam.fov = F ? F.fov + (S.fov - F.fov) * e : S.fov;
    const sx = (F ? F.shiftX * (1 - e) : 0) + (opts.shiftX || 0) * e, sy = (opts.shiftY || 0) * e;
    if ((sx || sy) && S.W) cam.setViewOffset(S.W, S.H, -sx * S.W, -sy * S.H, S.W, S.H); else if (cam.view) cam.clearViewOffset();
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    void Z;
  }

  // ---- the names: doors with two choices
  const v4 = new THREE.Vector4();
  const project = (v, o) => {
    v4.set(v.x, v.y, v.z, 1).applyMatrix4(cam.matrixWorldInverse).applyMatrix4(cam.projectionMatrix);
    if (v4.w <= 0) return false;
    o.x = (v4.x / v4.w + 1) / 2 * S.W; o.y = (1 - v4.y / v4.w) / 2 * S.H;
    return true;
  };
  const labels = ids.map(id => {
    const pl = P.byId[id], b = document.createElement('button');
    b.type = 'button'; b.className = 'f-isl';
    b.innerHTML = `<span>${pl.name}</span><small>${pl.length}</small>`;
    b.setAttribute('aria-haspopup', 'dialog');
    b.setAttribute('aria-label', `${pl.name}, ${pl.length}: walk in or see its depth`);
    b.addEventListener('pointerenter', () => setHi(id));
    b.addEventListener('pointerleave', () => setHi(''));
    b.addEventListener('focus', () => setHi(id));
    b.addEventListener('blur', () => setHi(''));
    b.addEventListener('click', () => choose(id, b));
    layer.appendChild(b);
    return { id, el: b };
  });
  function setHi(id) {
    if (S.hi === id) return;
    S.hi = id;
    for (const I of isl.values()) {
      const on = I.id === id;
      I.mat.uniforms.uHi.value = on ? 1 : 0;
      I.mat.uniforms.uOpacity.value = !id || on ? 0.95 : 0.55;
      if (I.line) I.line.material.opacity = !id || on ? 0.9 : 0.4;
    }
    root.dataset.hi = id || '';
    draw();
  }
  // the choice: walk into the 3-D place, or see its depth (classic against AI)
  function choose(id, from) {
    const pl = P.byId[id];
    pick.innerHTML = `<p class="f-pick-n">${pl.name}</p>
      <a class="btn btn--acc f-pick-go" href="${links.open(id)}">Walk in (3-D) <span aria-hidden="true">&rarr;</span></a>
      <a class="btn f-pick-depth" href="${links.depth(id)}">Its depth: classic vs ML <span aria-hidden="true">&rarr;</span></a>
      <button type="button" class="f-pick-x" aria-label="Close">&times;</button>`;
    pick.hidden = false;
    pick.setAttribute('aria-label', `${pl.name}: choose`);
    const r = from.getBoundingClientRect(), R = root.getBoundingClientRect();
    const x = clamp(r.left - R.left, 8, R.width - 290), y = clamp(r.bottom - R.top + 8, 8, R.height - 170);
    pick.style.left = `${x.toFixed(0)}px`; pick.style.top = `${y.toFixed(0)}px`;   // plain position (no transform layer over WebGL)
    pick.querySelector('.f-pick-x').addEventListener('click', close);
    pick.querySelector('.f-pick-go').focus({ preventScroll: true });     // never scroll the page under the stage
    setHi(id);
  }
  function close() { if (!pick.hidden) { pick.hidden = true; setHi(''); } }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  document.addEventListener('pointerdown', e => { if (!pick.hidden && !pick.contains(e.target) && !e.target.closest('.f-isl')) close(); });
  // a click on an island itself: the nearest island under the pointer (its middle, within its drawn size)
  canvas.addEventListener('click', e => {
    if (!S.on) return;
    const R = root.getBoundingClientRect(), x = e.clientX - R.left, y = e.clientY - R.top, o = { x: 0, y: 0 };
    let best = null, bd = 1e9;
    for (const I of isl.values()) {
      if (!project(I.mid, o)) continue;
      const rad = Math.max(40, I.d.radius * I.d.scale / S.dist * S.H * 1.1);
      const d = Math.hypot(o.x - x, o.y - y);
      if (d < rad && d < bd) { bd = d; best = I.id; }
    }
    if (best) choose(best, labels.find(L => L.id === best).el);
  });
  canvas.addEventListener('pointermove', e => {
    if (!S.on) return;
    const R = root.getBoundingClientRect(), x = e.clientX - R.left, y = e.clientY - R.top, o = { x: 0, y: 0 };
    let best = '', bd = 1e9;
    for (const I of isl.values()) {
      if (!project(I.mid, o)) continue;
      const rad = Math.max(40, I.d.radius * I.d.scale / S.dist * S.H * 1.1), d = Math.hypot(o.x - x, o.y - y);
      if (d < rad && d < bd) { bd = d; best = I.id; }
    }
    canvas.style.cursor = best ? 'pointer' : '';
    if (pick.hidden) setHi(best);
  }, { passive: true });

  // ---- frames: only on change
  // shown: embedded, the page fades the canvas in only at the hand-off; before that nothing is drawn
  // warm: one hidden frame at mount (the canvas is at opacity 0) links the shaders and uploads the points while the walk
  // plays, so the first frame of the cross-fade does not pay for them
  let raf = 0, visible = false, shown = !EMB, warm = EMB, dead = false;
  function draw() { if (!raf && !dead && visible && (shown || warm)) raf = requestAnimationFrame(frame); }
  function frame() {
    raf = 0;
    if (dead) return;
    warm = false;
    const k = REDUCE ? 1 : 0.18;
    S.px += (S.tpx - S.px) * k; S.py += (S.tpy - S.py) * k;
    const more = Math.abs(S.tpx - S.px) + Math.abs(S.tpy - S.py) > 1e-3;
    if (!more) { S.px = S.tpx; S.py = S.tpy; }
    place();
    renderer.render(scene, cam);
    const o = { x: 0, y: 0 };
    const la = clamp((S.k - 0.72) / 0.2, 0, 1);              // the names come in as the view pulls out
    for (const L of labels) {
      const I = isl.get(L.id);
      const ok = la > 0.01 && project(I.top, o) && o.x > 12 && o.x < S.W - 12 && o.y > 12 && o.y < S.H - 12;
      L.el.style.opacity = la.toFixed(3);
      L.el.hidden = !ok;
      if (ok) {
        // the name stays inside the stage (a portrait tablet or a narrow window): its box starts 12 px left of the anchor
        const w = L.el.offsetWidth || 0, x = Math.max(20, Math.min(o.x, S.W - 8 - w + 12));
        L.el.style.transform = `translate(${x.toFixed(1)}px, ${o.y.toFixed(1)}px)`;
      }
    }
    if (more) draw();
  }
  root.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse') return;
    const R = root.getBoundingClientRect();
    S.tpx = clamp((e.clientX - R.left) / R.width * 2 - 1, -1, 1); S.tpy = clamp((e.clientY - R.top) / R.height * 2 - 1, -1, 1);
    draw();
  }, { passive: true });
  root.addEventListener('pointerleave', () => { S.tpx = S.tpy = 0; draw(); });
  if (!EMB) addEventListener('scroll', () => {
    const R = root.getBoundingClientRect();
    S.scroll = clamp(1 - (R.bottom) / (innerHeight + R.height), 0, 1);
    draw();
  }, { passive: true });
  new IntersectionObserver(es => { visible = es.some(e => e.isIntersecting); if (visible) draw(); }).observe(root);
  new ResizeObserver(fit).observe(root);
  root.dataset.live = '1';
  root.dataset.on = S.on ? '1' : '0';
  visible = true;
  fit();
  return {
    get islands() { return [...isl.keys()]; }, choose: id => choose(id, labels.find(L => L.id === id).el), close,
    /** embedded: 0 = close on the island the page came from, 1 = all eight */
    setK(k) { k = clamp(k, 0, 1); if (k !== S.k) { S.k = k; draw(); } },
    /** embedded: the canvas is on screen (the page's fade); hidden = no frames */
    setShown(v) { v = !!v; if (v !== shown) { shown = v; if (v) draw(); } },
    /** the page went to its still mode: no more frames, the GL context released */
    destroy() { dead = true; if (raf) { cancelAnimationFrame(raf); raf = 0; } try { renderer.dispose(); renderer.forceContextLoss(); } catch (e) { /* gone */ } },
    /** embedded: the doors (names, clicks, hover) work only when on */
    /** embedded: the page's camera to start from (atlas frame): { pos, target, fov (deg), shiftX (fraction of width) } */
    setFrom(f) { S.from = { pos: f.pos.clone(), target: f.target.clone(), fov: f.fov, shiftX: f.shiftX || 0 }; draw(); },
    /** map -> atlas frame for island `id` (its group's matrix times its map -> island matrix) */
    mapToScene(id) { const I = isl.get(id); if (!I) return null; I.g.updateMatrixWorld(true); return I.M || (I.M = I.g.matrixWorld.clone().multiply(new THREE.Matrix4().fromArray(I.d.local))); },
    setOn(on) { if (S.on === on) return; S.on = on; root.dataset.on = on ? '1' : '0'; if (!on) { close(); setHi(''); canvas.style.cursor = ''; } draw(); },
  };
}
