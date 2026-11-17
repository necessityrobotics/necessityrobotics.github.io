// See it on your table (owner 2026-11-16: "can we introduce ar\vr features in site for phone and tablet ... amaze users").
// WebXR immersive-ar with hit-test (Android Chrome on ARCore phones, Samsung Internet). The place stands on a real table as
// a model about 50 cm long, at an exact round scale (1 : N): the 3-D points our software measured (data/atlas.bin, one island,
// true metres) and the camera's path as one sage line, with a bone dot that walks the path at 20 times the recorded speed.
// Its own renderer and canvas (three only, no Spark): the page's 3-D place is paused while AR runs.
//
//   openTable({ id, name, len, onEnd })   MUST be called from a tap: the session is requested before anything awaits
// (the page checks navigator.xr.isSessionSupported('immersive-ar') before it loads this module)
import * as THREE from '/vendor/three/three.module.js';   // (absolute: also on pages without an import map; the same URL as 'three')

const SAGE = 0xa7bb98, BONE = 0xe8e0cf;
const TARGET = 0.5;                    // the model's longest side on the table, about this many metres
const WALK_X = 20;                     // the dot walks the path at 20 x the recorded speed
const NICE = [50, 75, 100, 125, 150, 200, 250, 300, 400, 500, 600, 750, 1000, 1250, 1500, 2000, 2500, 3000, 4000, 5000];

/** The round N nearest to the real ratio (log scale), so the label is exact: the model is built at 1 : N. */
const nearestN = n => NICE.reduce((a, v) => (Math.abs(Math.log(v / n)) < Math.abs(Math.log(a / n)) ? v : a), NICE[0]);
const lin = c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));   // sRGB byte / 255 -> linear (three's working space)

async function islandData(id) {
  const r0 = await fetch('/data/atlas.json');
  if (!r0.ok) throw new Error(`atlas.json HTTP ${r0.status}`);
  const A = await r0.json();
  const isl = A.islands[id], i = A.order.indexOf(id);
  if (!isl || i < 0) throw new Error(`no island ${id}`);
  const st = A.bin.stride;
  const range = async (off, n) => {
    const r = await fetch('/' + A.bin.file, { headers: { Range: `bytes=${off}-${off + n - 1}` } });
    if (!r.ok) throw new Error(`atlas.bin HTTP ${r.status}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    return r.status === 206 ? buf : buf.subarray(off, off + n);     // a server without ranges sends the whole file
  };
  const parts = await Promise.all(A.bin.levels.map(L => range(L.offset + i * L.n * st, L.n * st)));
  const n = parts.reduce((a, p) => a + p.length / st, 0);
  const box = isl.box, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let k = 0;
  for (const p of parts) {
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    for (let o = 0; o + st <= p.length; o += st, k++) {
      for (let c = 0; c < 3; c++) pos[k * 3 + c] = box[0][c] + dv.getUint16(o + c * 2, true) / 65535 * (box[1][c] - box[0][c]);
      // a small lift (a dark table under the model), then into three's linear working space (no double brightening)
      for (let c = 0; c < 3; c++) col[k * 3 + c] = lin(Math.min(1, 0.04 + (p[o + 6 + c] / 255) * 1.08));
    }
  }
  return { isl, pos, col, n };
}

function makeUI(title, onClose) {
  const ui = document.createElement('div');
  ui.className = 'xr-ui';
  ui.innerHTML = `
    <div class="xr-top"><p class="xr-t"></p><button type="button" class="xr-x">Close</button></div>
    <p class="xr-say" role="status">Point your phone at a table. Move it slowly.</p>
    <div class="xr-foot"><button type="button" class="xr-move" hidden>Move it</button></div>`;
  ui.querySelector('.xr-t').textContent = title;
  ui.querySelector('.xr-x').addEventListener('click', onClose);
  document.body.append(ui);
  // a tap on our own buttons must not also place the model
  ui.addEventListener('beforexrselect', e => { if (e.target instanceof Element && e.target.closest('button')) e.preventDefault(); });
  return ui;
}

/** A short line on the page itself (the AR overlay is gone when AR could not start). */
export function toast(text) {
  const t = document.createElement('p');
  t.className = 'xr-toast'; t.setAttribute('role', 'status'); t.textContent = text;
  document.body.append(t);
  setTimeout(() => t.remove(), 5000);
}

export function openTable({ id, name = '', len = '', onEnd = () => {} }) {
  const head = `${name}${len ? ' · ' + len : ''}`;
  let session = null, renderer = null, ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    try { renderer?.setAnimationLoop(null); renderer?.dispose(); renderer?.forceContextLoss(); } catch (e) { /* gone */ }
    renderer?.domElement.remove(); ui.remove();
    onEnd();
  };
  const ui = makeUI(head.toUpperCase(), () => (session ? session.end().catch(finish) : finish()));
  const say = t => { ui.querySelector('.xr-say').textContent = t; };
  // the session first, inside the visitor's tap (the browser refuses it after an await); the model loads at the same time
  const sessionP = navigator.xr.requestSession('immersive-ar', {
    requiredFeatures: ['hit-test'], optionalFeatures: ['dom-overlay'], domOverlay: { root: ui },
  });
  const dataP = islandData(id);
  dataP.catch(() => {});                                      // (handled below)
  return sessionP.then(async sess => {
    if (ended) { sess.end().catch(() => {}); return null; }   // closed while the browser still asked: no AR after it
    session = sess;
    session.addEventListener('end', finish);
    const hide = () => { if (document.hidden) session.end().catch(() => {}); };
    document.addEventListener('visibilitychange', hide);
    session.addEventListener('end', () => document.removeEventListener('visibilitychange', hide));
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
      renderer.domElement.className = 'xr-canvas';
      document.body.append(renderer.domElement);
      renderer.xr.enabled = true;
      renderer.xr.setReferenceSpaceType('local');
      renderer.xr.setFramebufferScaleFactor?.(0.7);         // phones run hot in AR: fewer pixels, every frame
      await renderer.xr.setSession(session);
    } catch (e) {
      console.warn('[xr] start', e);
      say('AR did not start. Close and try again.');
      session.end().catch(finish);
      return null;
    }

    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(70, 1, 0.01, 50);   // near 1 cm: lean in close
    const reticle = new THREE.Mesh(new THREE.RingGeometry(0.055, 0.065, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: SAGE, transparent: true, opacity: 0.95 }));
    reticle.matrixAutoUpdate = false; reticle.visible = false;
    scene.add(reticle);

    const model = new THREE.Group(), inner = new THREE.Group();
    model.visible = false; model.add(inner); scene.add(model);
    const walker = new THREE.Mesh(new THREE.SphereGeometry(0.0028, 16, 12), new THREE.MeshBasicMaterial({ color: BONE }));
    let curve = null, routeT = 60, s = 1, N = 1;
    let hitSource = null, placed = false, t0 = performance.now(), seen = false;
    const label = () => {
      const n = Math.round(1 / model.scale.x);
      ui.querySelector('.xr-t').textContent = `${head} · 1 : ${Math.abs(n - N) / N < 0.01 ? N : n}`.toUpperCase();
    };
    dataP.then(({ isl, pos, col, n }) => {
      const box = isl.box, ex = Math.max(box[1][0] - box[0][0], box[1][2] - box[0][2]);
      N = nearestN(ex / TARGET); s = 1 / N;                   // exactly 1 : N
      // the ground: the 3rd percentile of the points' height (the box also holds a few stray points below the ground)
      const ys = []; for (let k = 0; k < n; k += 7) ys.push(pos[k * 3 + 1]); ys.sort((a, b) => a - b);
      const gy = ys[Math.floor(ys.length * 0.03)] ?? box[0][1];
      inner.position.set(-(box[0][0] + box[1][0]) / 2, -gy, -(box[0][2] + box[1][2]) / 2);
      model.scale.setScalar(s);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      // the point size is in world metres (three's PointsMaterial ignores the model's scale)
      inner.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 0.0045, sizeAttenuation: true, vertexColors: true })));
      const pts = isl.route.map(p => new THREE.Vector3(p[0], p[1] + 0.45, p[2]));
      curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
      inner.add(new THREE.Mesh(new THREE.TubeGeometry(curve, Math.min(2000, pts.length * 3), 0.0011 / s, 6, false),
        new THREE.MeshBasicMaterial({ color: SAGE })));
      routeT = Math.max(10, (isl.route_t?.[1] || 0) - (isl.route_t?.[0] || 0)) || 60;
      walker.scale.setScalar(1 / s);
      inner.add(walker);
      label();
      if (seen && !placed) say('Tap to place it here.');
    }).catch(e => { console.warn('[xr] model', e); say('The model did not load. Close and try again.'); });

    session.requestReferenceSpace('viewer').then(sp => session.requestHitTestSource({ space: sp })).then(h => { hitSource = h; })
      .catch(e => { console.warn('[xr] hit-test', e); say('This phone cannot find surfaces. Close and try again.'); });
    session.addEventListener('select', () => {
      if (placed || !reticle.visible || !curve) return;
      model.position.setFromMatrixPosition(reticle.matrix);
      // turn the model so its long side lies across the view
      const cam = renderer.xr.getCamera(), d = new THREE.Vector3().subVectors(model.position, cam.position); d.y = 0;
      model.rotation.set(0, Math.atan2(d.x, d.z) + Math.PI, 0);
      model.visible = true; placed = true; reticle.visible = false;
      ui.querySelector('.xr-move').hidden = false;
      say('Walk round it. Pinch to change its size. Turn two fingers to turn it.');
    });
    ui.querySelector('.xr-move').addEventListener('click', () => { placed = false; model.visible = false; ui.querySelector('.xr-move').hidden = true; say('Point your phone at a table. Tap to place it.'); });

    // two fingers on the screen: size and turn (the label shows the new scale)
    const touches = new Map();
    let pinch = null;
    ui.addEventListener('pointerdown', e => { touches.set(e.pointerId, [e.clientX, e.clientY]); if (touches.size === 2) pinch = gesture(); });
    ui.addEventListener('pointermove', e => {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, [e.clientX, e.clientY]);
      if (touches.size === 2 && pinch && placed) {
        const g = gesture();
        model.scale.setScalar(THREE.MathUtils.clamp(pinch.scale * g.d / pinch.d, s * 0.25, s * 6));
        model.rotation.y = pinch.rot - (g.a - pinch.a);
        label();
      }
    });
    const up = e => { touches.delete(e.pointerId); if (touches.size < 2) pinch = null; };
    ui.addEventListener('pointerup', up); ui.addEventListener('pointercancel', up);
    function gesture() {
      const [a, b] = [...touches.values()];
      return { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, a: Math.atan2(b[1] - a[1], b[0] - a[0]), scale: model.scale.x, rot: model.rotation.y };
    }

    renderer.setAnimationLoop((time, frame) => {
      if (!frame) return;
      if (hitSource && !placed) {
        const hits = frame.getHitTestResults(hitSource);
        const pose = hits.length ? hits[0].getPose(renderer.xr.getReferenceSpace()) : null;
        if (pose) {
          reticle.visible = true; reticle.matrix.fromArray(pose.transform.matrix);
          if (!seen) { seen = true; say(curve ? 'Tap to place it here.' : 'Found a surface. The model is loading.'); }
        } else reticle.visible = false;
        if (!seen && performance.now() - t0 > 8000) { t0 = performance.now(); say('Find a surface with some pattern, in good light.'); }
      }
      if (curve && model.visible) walker.position.copy(curve.getPointAt(((time / 1000) * WALK_X / routeT) % 1));
      renderer.render(scene, camera);
    });
    return session;
  }, e => {
    // the request itself was refused: no AR on the screen, so the words go on the page
    if (ended) return null;                                  // closed already: no words about it
    console.warn('[xr] session', e);
    finish();
    const nm = String(e?.name || '');
    toast(nm === 'NotAllowedError' ? 'AR was not allowed.' : /NotSupported|Security/.test(nm) ? 'This phone cannot start AR here. Open this page in Chrome.' : 'AR did not start. Try again.');
    return null;
  });
}
