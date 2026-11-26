// The arm prototype as a 3-D line model (investor page, "Hardware so far").
// Rule of the site: nothing moves by itself. The model turns only under the visitor's hand (drag, arrow keys, view buttons),
// and a frame is drawn only when something changed. Our printed parts come from the design file as edges; each bought actuator
// is a plain cylinder of its measured size (the makers' own CAD models are not published).
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

const VIEWS = { angle: [-0.62, 0.36], side: [0, 0], top: [0, Math.PI / 2] };       // [turn, tilt] in radians

/** Called by the small loader (fund_arm3d.js) when the visitor comes near the model. */
export function mount(el) { return start(el).catch((e) => fail(el, e)); }

function fail(el, e) {
  el.classList.add('is-off');
  const note = el.querySelector('.fd-arm3d-note');
  if (note) note.textContent = 'This device cannot show the 3-D model. The drawing above shows the same design.';
  if (e) console.warn('[arm3d]', e);
}

function cylinderLines(a, n = 40, ribs = 10) {
  // rings at both ends and in the middle, and straight ribs between the ends
  const ax = new THREE.Vector3(...a.axis).normalize();
  const u = new THREE.Vector3(1, 0, 0);
  if (Math.abs(ax.dot(u)) > 0.9) u.set(0, 1, 0);
  u.sub(ax.clone().multiplyScalar(ax.dot(u))).normalize();
  const v = new THREE.Vector3().crossVectors(ax, u);
  const c = new THREE.Vector3(...a.c), r = a.d / 2, h = a.l / 2, out = [];
  const pt = (t, s) => c.clone().addScaledVector(ax, s).addScaledVector(u, r * Math.cos(t)).addScaledVector(v, r * Math.sin(t));
  for (const s of [-h, 0, h]) {
    for (let i = 0; i < n; i++) {
      const p = pt((i / n) * 2 * Math.PI, s), q = pt(((i + 1) / n) * 2 * Math.PI, s);
      out.push(p.x, p.y, p.z, q.x, q.y, q.z);
    }
  }
  for (let i = 0; i < ribs; i++) {
    const t = (i / ribs) * 2 * Math.PI, p = pt(t, -h), q = pt(t, h);
    out.push(p.x, p.y, p.z, q.x, q.y, q.z);
  }
  return out;
}

async function start(el) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  } catch (e) { return fail(el, e); }
  const [model, buf] = await Promise.all([
    fetch(el.dataset.model).then((r) => { if (!r.ok) throw new Error('model ' + r.status); return r.json(); }),
    fetch(el.dataset.lines).then((r) => { if (!r.ok) throw new Error('lines ' + r.status); return r.arrayBuffer(); }),
  ]);
  const css = getComputedStyle(document.documentElement);
  const bone = (css.getPropertyValue('--acc') || '').trim() || '#e8e0cf';

  const scene = new THREE.Scene();
  const group = new THREE.Group();
  group.rotation.order = 'XYZ';                       // turn about the upright axis first, then tilt towards the viewer
  scene.add(group);
  const mats = [];
  const add = (positions, color, width) => {
    const g = new LineSegmentsGeometry();
    g.setPositions(positions);
    const m = new LineMaterial({ color, linewidth: width, worldUnits: false, transparent: true, depthTest: false });
    mats.push(m);
    group.add(new LineSegments2(g, m));
  };
  add(model.actuators.flatMap((a) => cylinderLines(a)), '#7d7d7d', 1.0);
  add(new Float32Array(buf), bone, 1.35);

  const R = 0.5 * Math.hypot(...model.size) * 1.06;   // the model always fits, at any turn
  const cam = new THREE.OrthographicCamera(-R, R, R, -R, -4 * R, 4 * R);
  cam.position.set(0, 0, 2 * R);

  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'A 3-D line model of the arm prototype. Drag it, or use the arrow keys, to turn it.');
  el.prepend(canvas);
  renderer.setClearColor(0x000000, 0);

  let turn = VIEWS.angle[0], tilt = VIEWS.angle[1], queued = false;
  // the model fills the box at every turn: the scale follows the outline of its box as seen from the camera
  const half = model.size.map((s) => s / 2), corner = new THREE.Vector3();
  const fit = () => {
    let ex = 1, ey = 1;
    for (let i = 0; i < 8; i++) {
      corner.set(i & 1 ? half[0] : -half[0], i & 2 ? half[1] : -half[1], i & 4 ? half[2] : -half[2]).applyEuler(group.rotation);
      ex = Math.max(ex, Math.abs(corner.x)); ey = Math.max(ey, Math.abs(corner.y));
    }
    cam.zoom = Math.min(2.6, 0.86 * Math.min(cam.right / ex, cam.top / ey));
    cam.updateProjectionMatrix();
  };
  const draw = () => { queued = false; group.rotation.set(tilt, turn, 0); fit(); renderer.render(scene, cam); };
  const ask = () => { if (!queued) { queued = true; requestAnimationFrame(draw); } };
  const size = () => {
    const w = Math.max(1, el.clientWidth), h = Math.max(1, el.clientHeight), dpr = Math.min(devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    const asp = w / h;
    if (asp >= 1) { cam.left = -R * asp; cam.right = R * asp; cam.top = R; cam.bottom = -R; }
    else { cam.left = -R; cam.right = R; cam.top = R / asp; cam.bottom = -R / asp; }
    cam.updateProjectionMatrix();
    mats.forEach((m) => m.resolution.set(w * dpr, h * dpr));
    draw();                                           // at once: a resized canvas is blank until it is drawn
  };
  new ResizeObserver(size).observe(el);
  size();

  const buttons = [...el.querySelectorAll('[data-view]')];
  const press = (name) => buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === name)));
  buttons.forEach((b) => b.addEventListener('click', () => { [turn, tilt] = VIEWS[b.dataset.view]; press(b.dataset.view); ask(); }));

  let last = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    last = { x: e.clientX, y: e.clientY, id: e.pointerId };
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* older engines */ }
    el.classList.add('is-drag');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!last || e.pointerId !== last.id) return;
    turn += (e.clientX - last.x) * 0.0085;
    if (e.pointerType !== 'touch') tilt = Math.max(-1.5, Math.min(1.5, tilt + (e.clientY - last.y) * 0.0085));   // a finger moving up or down scrolls the page
    last.x = e.clientX; last.y = e.clientY;
    press(null);
    ask();
  });
  const end = () => { last = null; el.classList.remove('is-drag'); };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('keydown', (e) => {
    const k = { ArrowLeft: [-0.14, 0], ArrowRight: [0.14, 0], ArrowUp: [0, -0.12], ArrowDown: [0, 0.12] }[e.key];
    if (!k) return;
    e.preventDefault();
    turn += k[0];
    tilt = Math.max(-1.5, Math.min(1.5, tilt + k[1]));
    press(null);
    ask();
  });
  el.dataset.ready = '1';
  window.__arm3d = { get view() { return [turn, tilt]; }, segments: model.segments, set(t, p) { turn = t; tilt = p; draw(); } };   // for tests
}
