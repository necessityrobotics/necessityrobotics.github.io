// The world's 3-D content (MASTER_PLAN.md 2.1 / 2.2): one scene graph for the hero, the atlas, the rides and the dives.
// Every published map is an island: a group placed by atlas.json (place x yaw x display scale) holding
//   base points   atlas.bin (levels 0 and 1): bound straight to the GPU as normalised uint16 / uint8 attributes and
//                 de-quantised by the object transform (no CPU pass); always resident; one draw call;
//   dense points  a points.bin prefix (map frame, de-quantised the same way, under the island's map -> island matrix):
//                 the focus island only; it replaces the base points (it is a superset: both are prefixes of one
//                 random permutation);
//   route         xclean's keyframe route, a screen-space ribbon whose drawn range can grow from any point both ways;
//   splats        cut / Lite / Standard SplatMesh children (map frame, under the same matrix): decoded hidden, joined
//                 by the caller when the main thread can take the upload, cross-faded in (0.8 s), the replaced tier
//                 fading out after.
// The POV image is scale-invariant: a camera at xclean's pose inside a display-scaled island sees what it would at true
// scale (near plane scaled with it).
import * as THREE from 'three';
import { SplatMesh } from '@sparkjsdev/spark';

const F_CV = new THREE.Matrix4().makeScale(1, -1, -1);   // OpenCV camera axes -> three.js camera axes
const FADE_S = 0.8;
const OUT_S = 0.4;
const RANK = { cut: 1, lite: 2, standard: 3 };

function token(name, fallback) {
  try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; } catch (e) { return fallback; }
}

const POINT_VERT = /* glsl */`
  #if GREY
  attribute float aGrey;
  #else
  attribute vec3 aRgb;
  #endif
  uniform float uSize, uPR, uViewH, uOpacity, uHi, uMinPx, uMaxPx, uTintMix, uNear, uGain;
  uniform vec3 uTint;
  varying vec3 vC; varying float vA;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float d = max(1e-3, -mv.z);
    gl_Position = projectionMatrix * mv;
    float px = uSize * uViewH * 0.5 * projectionMatrix[1][1] / d;
    gl_PointSize = clamp(px, uMinPx * uPR, uMaxPx * uPR);
    #if GREY
    vec3 c = vec3(aGrey);
    #else
    vec3 c = aRgb;
    #endif
    c = min(vec3(1.0), c * uGain);
    vC = mix(c, uTint, clamp(uTintMix + 0.3 * uHi, 0.0, 1.0)) * (1.0 + 0.6 * uHi);
    vA = uOpacity * smoothstep(uNear, uNear * 3.0, d) * max(0.2, clamp(px / (uMinPx * uPR), 0.0, 1.0));
  }`;
const POINT_FRAG = /* glsl */`
  varying vec3 vC; varying float vA;
  void main() {
    vec2 q = gl_PointCoord * 2.0 - 1.0;
    float r = dot(q, q);
    if (r > 1.0) discard;
    float a = vA * (1.0 - r * r);
    gl_FragColor = vec4(vC * a, a);
  }`;

const ROUTE_VERT = /* glsl */`
  attribute vec3 aA; attribute vec3 aB; attribute vec2 aU;
  uniform float uWidth, uNear;
  uniform vec2 uRes;
  varying float vU; varying float vSide;
  void main() {
    vec4 a = modelViewMatrix * vec4(aA, 1.0), b = modelViewMatrix * vec4(aB, 1.0);
    float n = -uNear;
    if (a.z > n && b.z > n) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
    if (a.z > n) a = mix(a, b, (a.z - n) / (a.z - b.z));
    if (b.z > n) b = mix(b, a, (b.z - n) / (b.z - a.z));
    vec4 ca = projectionMatrix * a, cb = projectionMatrix * b;
    vec2 sa = ca.xy / ca.w * uRes * 0.5, sb = cb.xy / cb.w * uRes * 0.5;
    vec2 dv = sb - sa;
    vec2 d = length(dv) > 1e-4 ? normalize(dv) : vec2(1.0, 0.0);
    vec4 c = position.x < 0.5 ? ca : cb;
    vec2 off = vec2(-d.y, d.x) * position.y * uWidth * 0.5 + d * (position.x < 0.5 ? -0.5 : 0.5) * uWidth;
    c.xy += off / (uRes * 0.5) * c.w;
    gl_Position = c;
    vU = mix(aU.x, aU.y, position.x);
    vSide = position.y;
  }`;
const ROUTE_FRAG = /* glsl */`
  uniform float uA, uB, uOpacity;
  uniform vec3 uColor;
  varying float vU; varying float vSide;
  void main() {
    if (vU < uA || vU > uB) discard;
    float a = uOpacity * (1.0 - smoothstep(0.45, 1.0, abs(vSide)));
    gl_FragColor = vec4(uColor * a, a);
  }`;

// WIRE: a soft ground glow under each island's footprint cells (atlas.json foot / foot_cell), so the islands read as
// places from above rather than as thin outlines (MASTER_PLAN 7, first risk, "a soft ground halo per island"). Additive,
// flat on the island's ground (y = 0), drawn first; on with the backdrop (not T1, not from governor rung 3), off at eye
// level and under splats.
const HALO_VERT = /* glsl */`
  attribute vec2 aXZ;
  uniform float uCell;
  varying vec2 vQ;
  void main() {
    vQ = position.xy;
    vec3 p = vec3(aXZ.x + position.x * uCell, 0.0, aXZ.y + position.y * uCell);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }`;
const HALO_FRAG = /* glsl */`
  uniform float uOpacity;
  uniform vec3 uColor;
  varying vec2 vQ;
  void main() {
    float r2 = dot(vQ, vQ);
    if (r2 > 1.0) discard;
    float a = uOpacity * (1.0 - r2) * (1.0 - r2);
    gl_FragColor = vec4(uColor * a, a);
  }`;

export class WorldScene {
  /** stage: WorldStage; atlas: atlas.json; params: the tier's. */
  constructor(stage, atlas, params) {
    this.stage = stage; this.atlas = atlas; this.params = params;
    this.ion = new THREE.Color(token('--path', '#6fc7b0'));
    this.islands = new Map();
    this.mats = new Set();
    this.routeMats = new Set();
    this.backdrop = null;
    this.haloK = 0;
    this.halfPoints = false;
    this._v = new THREE.Vector3(); this._m = new THREE.Matrix4(); this._m2 = new THREE.Matrix4();
    this._p = new THREE.Vector3(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3(); this._one = new THREE.Vector3(1, 1, 1);
    stage.before.add(() => this._uniforms());
    if (/[?&]debug=1/.test(location.search)) window.__scene = this;   // dev inspection only (?debug=1)
    // empty draws with the real programs (grey and colour points, the route): compiled with the scene before the first
    // 3-D frame, and kept, so every later island reuses a linked program
    const warm = new THREE.Group();
    warm.name = 'program warm-up';
    for (const grey of [false, true]) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Uint16Array(0), 3, true));
      g.setAttribute(grey ? 'aGrey' : 'aRgb', new THREE.BufferAttribute(new Uint8Array(0), grey ? 1 : 3, true));
      const p = new THREE.Points(g, this._pointsMat({ grey, size: 1 }));
      p.frustumCulled = false;
      warm.add(p);
    }
    stage.scene.add(warm);
    this.warm = warm;
  }
  _uniforms() {
    const st = this.stage, pr = st.drawScale, vh = st.size.h * pr;
    for (const m of this.mats) { m.uniforms.uPR.value = pr; m.uniforms.uViewH.value = vh; }
    for (const m of this.routeMats) m.uniforms.uRes.value.set(st.size.w * pr, vh);
  }
  _pointsMat({ grey = false, size, minPx = 1.2, maxPx = 6, tint = 0.2, near = 0.5, gain = 1.15 }) {
    const m = new THREE.ShaderMaterial({
      defines: { GREY: grey ? 1 : 0 }, vertexShader: POINT_VERT, fragmentShader: POINT_FRAG,
      transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendEquation: THREE.AddEquation,
      uniforms: {
        uSize: { value: size }, uPR: { value: this.stage.drawScale }, uViewH: { value: 900 }, uOpacity: { value: 0 }, uHi: { value: 0 },
        uMinPx: { value: minPx }, uMaxPx: { value: maxPx }, uTintMix: { value: tint }, uTint: { value: this.ion.clone() }, uNear: { value: near },
        uGain: { value: gain },
      },
    });
    this.mats.add(m);
    return m;
  }

  /** One island. desc: atlas.json island; base: {rec: Uint8Array (n x 10 bytes), n} or null (setBase later). */
  addIsland(id, desc, base) {
    const s = desc.scale;
    const group = new THREE.Group();
    group.name = id;
    group.position.set(desc.place.x, desc.place.y, desc.place.z);
    group.rotation.set(0, desc.place.yaw, 0);
    group.scale.setScalar(s);
    group.updateMatrixWorld(true);
    const local = new THREE.Matrix4().fromArray(desc.local);
    const rgb = desc.points?.colour === 'rgb8';
    const phone = this.params.phone;
    const mat = this._pointsMat({ size: (phone ? 1.3 : 1.05) * s, minPx: phone ? 1.6 : 1.5, maxPx: phone ? 6 : 7, tint: rgb ? 0.06 : 0.1, near: 0.3 * s, gain: rgb ? 1.2 : 1.3 });
    const box = new THREE.Group();
    box.position.fromArray(desc.box[0]);
    box.scale.set(...desc.box[1].map((v, k) => Math.max(1e-6, v - desc.box[0][k])));
    group.add(box);
    const isl = {
      id, desc, group, box, local, mat, base: null, baseN: 0, dense: null, denseMat: null, denseData: null, route: null,
      splats: {}, pending: {}, best: null,
      show: 0, showT: 0, lift: 0, liftT: 0, hi: 0, hiT: 0, splatK: 0, splatT: 0, routeA: 0, routeB: 1, routeO: 0, routeOT: 0,
      grey: !rgb,
    };
    this.islands.set(id, isl);
    if (base) this.setBase(id, base.rec, base.n);
    this._route(isl);
    this._halo(isl);
    this.stage.scene.add(group);
    return isl;
  }
  /** (Re)bind the base points (level 0, or levels 0 + 1 concatenated). */
  setBase(id, rec, n) {
    const isl = this.islands.get(id);
    if (isl.base) { isl.box.remove(isl.base); isl.base.geometry.dispose(); }
    const g = new THREE.BufferGeometry();
    const ib16 = new THREE.InterleavedBuffer(new Uint16Array(rec.buffer, rec.byteOffset, n * 5), 5);
    const ib8 = new THREE.InterleavedBuffer(new Uint8Array(rec.buffer, rec.byteOffset, n * 10), 10);
    g.setAttribute('position', new THREE.InterleavedBufferAttribute(ib16, 3, 0, true));
    g.setAttribute('aRgb', new THREE.InterleavedBufferAttribute(ib8, 3, 6, true));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0.5, 0.5, 0.5), 0.87);
    const pts = new THREE.Points(g, isl.mat);
    pts.frustumCulled = false;
    pts.renderOrder = -1;
    isl.box.add(pts);
    isl.base = pts; isl.baseN = n;
    g.setDrawRange(0, this.halfPoints ? n >> 1 : n);
    this.stage.invalidate();
  }
  /** The dense prefix of points.bin (map frame): {n, pos: Uint16Array, col: Uint8Array, meta}. */
  densify(id, chunk) {
    const isl = this.islands.get(id);
    if (!isl || isl.dense) return;
    const m = chunk.meta, grey = m.colour !== 'rgb8';
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(chunk.pos, 3, true));
    g.setAttribute(grey ? 'aGrey' : 'aRgb', new THREE.BufferAttribute(chunk.col, grey ? 1 : 3, true));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0.5, 0.5, 0.5), 0.87);
    const s = isl.desc.scale, phone = this.params.phone;
    const mat = this._pointsMat({ grey, size: (phone ? 0.5 : 0.4) * s, minPx: phone ? 1.3 : 1.2, maxPx: phone ? 6 : 7, tint: grey ? 0.08 : 0.04, near: 0.3 * s, gain: grey ? 1.3 : 1.2 });
    const holder = new THREE.Group();
    holder.matrixAutoUpdate = false;
    holder.matrix.copy(isl.local);
    const q = new THREE.Group();
    q.position.fromArray(m.bbox_min);
    q.scale.set(...m.bbox_max.map((v, k) => Math.max(1e-6, v - m.bbox_min[k])));
    const pts = new THREE.Points(g, mat);
    pts.frustumCulled = false;
    pts.renderOrder = -1;
    q.add(pts); holder.add(q); isl.group.add(holder);
    g.setDrawRange(0, this.halfPoints ? chunk.n >> 1 : chunk.n);
    isl.dense = { holder, pts, n: chunk.n };
    isl.denseMat = mat;
    isl.denseData = chunk;
    this.stage.invalidate();
  }
  dropDense(id) {
    const isl = this.islands.get(id);
    if (!isl?.dense) return;
    isl.dense.holder.removeFromParent();
    isl.dense.pts.geometry.dispose();
    isl.denseMat.dispose(); this.mats.delete(isl.denseMat);
    isl.dense = null; isl.denseMat = null; isl.denseData = null;
  }
  _route(isl) {
    const r = isl.desc.route;
    const n = r.length;
    if (n < 2) return;
    const cum = new Float32Array(n);
    for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(r[i][0] - r[i - 1][0], r[i][1] - r[i - 1][1], r[i][2] - r[i - 1][2]);
    const L = cum[n - 1] || 1;
    const A = new Float32Array((n - 1) * 3), B = new Float32Array((n - 1) * 3), U = new Float32Array((n - 1) * 2);
    for (let i = 0; i < n - 1; i++) {
      A.set([r[i][0], r[i][1] + 0.6, r[i][2]], i * 3);
      B.set([r[i + 1][0], r[i + 1][1] + 0.6, r[i + 1][2]], i * 3);
      U[i * 2] = cum[i] / L; U[i * 2 + 1] = cum[i + 1] / L;
    }
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0]), 3));
    g.setIndex([0, 2, 1, 2, 3, 1]);
    g.setAttribute('aA', new THREE.InstancedBufferAttribute(A, 3));
    g.setAttribute('aB', new THREE.InstancedBufferAttribute(B, 3));
    g.setAttribute('aU', new THREE.InstancedBufferAttribute(U, 2));
    g.instanceCount = n - 1;
    const m = new THREE.ShaderMaterial({
      vertexShader: ROUTE_VERT, fragmentShader: ROUTE_FRAG, transparent: true, depthWrite: false, depthTest: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
      uniforms: { uWidth: { value: 2 }, uNear: { value: 0.05 }, uRes: { value: new THREE.Vector2(1, 1) }, uA: { value: 0 }, uB: { value: 1 },
        uOpacity: { value: 0 }, uColor: { value: this.ion.clone() } },
    });
    this.routeMats.add(m);
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    isl.group.add(mesh);
    isl.route = { mesh, cum, L };
  }
  _halo(isl) {
    const f = isl.desc.foot, cell = isl.desc.foot_cell;
    if (!f?.length || !cell) return;
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]), 3));
    g.setIndex([0, 1, 2, 2, 1, 3]);
    g.setAttribute('aXZ', new THREE.InstancedBufferAttribute(new Float32Array(f.flat()), 2));
    g.instanceCount = f.length;
    const tint = new THREE.Color(0xdde6f2).lerp(this.ion, 0.3);
    const m = new THREE.ShaderMaterial({
      vertexShader: HALO_VERT, fragmentShader: HALO_FRAG, transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation,
      uniforms: { uCell: { value: cell * 2.0 }, uOpacity: { value: 0 }, uColor: { value: tint } },
    });
    const mesh = new THREE.Mesh(g, m);
    mesh.frustumCulled = false;
    mesh.renderOrder = -3;
    mesh.visible = false;
    isl.group.add(mesh);
    isl.halo = mesh;
  }
  // ---------------------------------------------------------------- generic parts for other modules (marks.js)
  /** A group under the island in its map frame (metres; the matrix of the dense points and the splats), made once. */
  mapFrame(id) {
    const isl = this.islands.get(id);
    if (!isl) return null;
    if (!isl.mapFrame) {
      const g = new THREE.Group();
      g.name = `${id} map frame`;
      g.matrixAutoUpdate = false;
      g.matrix.copy(isl.local);
      isl.group.add(g);
      g.updateMatrixWorld(true);
      isl.mapFrame = g;
    }
    return isl.mapFrame;
  }
  /**
   * A screen-space ribbon material on the route's program (same shader source and uniforms: three.js reuses the linked
   * program; uRes is kept with the routes'). blend 'over' (premultiplied) or 'add'.
   */
  lineMaterial({ blend = 'add' } = {}) {
    const m = new THREE.ShaderMaterial({
      vertexShader: ROUTE_VERT, fragmentShader: ROUTE_FRAG, transparent: true, depthWrite: false, depthTest: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: blend === 'over' ? THREE.OneMinusSrcAlphaFactor : THREE.OneFactor,
      blendEquation: THREE.AddEquation,
      uniforms: { uWidth: { value: 2 }, uNear: { value: 0.05 }, uRes: { value: new THREE.Vector2(1, 1) }, uA: { value: 0 }, uB: { value: 1 },
        uOpacity: { value: 0 }, uColor: { value: this.ion.clone() } },
    });
    this.routeMats.add(m);
    return m;
  }
  /** A points material on the grey points' program (tint 1: the ion colour), drawn over the map (no depth test). */
  dotMaterial(opts = {}) {
    const m = this._pointsMat({ grey: true, tint: 1, ...opts });
    m.depthTest = false;
    return m;
  }
  /** Dispose a material made by lineMaterial() / dotMaterial(). */
  release(mat) {
    if (!mat) return;
    this.mats.delete(mat);
    this.routeMats.delete(mat);
    mat.dispose();
  }

  /** Fraction along the island's route line nearest to a point of the island frame (metres). */
  routeFrac(id, p) {
    const isl = this.islands.get(id), r = isl?.desc.route;
    if (!r) return 0;
    let best = 0, bd = Infinity;
    for (let i = 0; i < r.length; i++) { const d = (r[i][0] - p[0]) ** 2 + (r[i][1] - p[1]) ** 2 + (r[i][2] - p[2]) ** 2; if (d < bd) { bd = d; best = i; } }
    return isl.route ? isl.route.cum[best] / isl.route.L : 0;
  }

  // ---------------------------------------------------------------- splats
  /** Decode a splat file hidden (Spark's workers). Resolves with the mesh (not yet in the scene) or null. */
  async attachSplats(id, tier, bytes) {
    const isl = this.islands.get(id);
    if (!isl || isl.splats[tier] || isl.pending[tier]) return isl?.splats[tier] || isl?.pending[tier] || null;
    const mesh = new SplatMesh({ fileBytes: bytes, fileName: tier === 'standard' ? 'splats.spz' : 'splats_lite.spz', extSplats: true });
    mesh.maxSh = 1;
    mesh.visible = false;
    mesh.opacity = 0;
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(isl.local);
    isl.pending[tier] = mesh;
    try { await mesh.initialized; } catch (e) { if (isl.pending[tier] === mesh) delete isl.pending[tier]; try { mesh.dispose(); } catch (e2) { /* already gone */ } throw e; }
    if (isl.pending[tier] !== mesh || !this.islands.has(id)) { try { mesh.dispose(); } catch (e) { /* dropped meanwhile */ } return null; }
    mesh.ready = true;
    return mesh;
  }
  /** Decoded but not yet joined. */
  pendingTiers(id) { const isl = this.islands.get(id); return isl ? Object.keys(isl.pending).filter(t => isl.pending[t].ready) : []; }
  /** Join a decoded tier: it enters the scene and fades in over the current best. */
  join(id, tier) {
    const isl = this.islands.get(id);
    const mesh = isl?.pending[tier];
    if (!mesh?.ready) return false;
    delete isl.pending[tier];
    isl.group.add(mesh);
    isl.splats[tier] = { mesh, k: 0 };
    if (!isl.best || RANK[tier] > RANK[isl.best]) isl.best = tier;
    this.stage.invalidate();
    return true;
  }
  dropSplats(id, tier = null) {
    const isl = this.islands.get(id);
    if (!isl) return;
    for (const t of tier ? [tier] : ['cut', 'lite', 'standard']) {
      const l = isl.splats[t], p = isl.pending[t];
      if (l) { l.mesh.removeFromParent(); try { l.mesh.dispose(); } catch (e) { /* gone */ } delete isl.splats[t]; }
      if (p) { delete isl.pending[t]; if (p.ready) try { p.dispose(); } catch (e) { /* gone */ } }
    }
    isl.best = ['standard', 'lite', 'cut'].find(t => isl.splats[t]) || null;
    if (!isl.best) isl.splatK = 0;
  }
  best(id) { return this.islands.get(id)?.best || null; }
  splatCount(id) { const isl = this.islands.get(id); return isl?.best ? isl.splats[isl.best].mesh.numSplats || 0 : 0; }
  hasSplats(id) { return !!this.islands.get(id)?.best; }
  splatTiers() { const o = {}; for (const [id, isl] of this.islands) { const t = Object.keys(isl.splats); if (t.length) o[id] = t; } return o; }
  /** Per island: what is resident and how visible it is (debug info). */
  state() {
    const o = {};
    for (const [id, isl] of this.islands) {
      o[id] = { show: +isl.show.toFixed(2), splatK: +isl.splatK.toFixed(2), best: isl.best, base: isl.baseN, dense: isl.dense?.n || 0,
        pending: Object.keys(isl.pending), route: [+isl.routeA.toFixed(2), +isl.routeB.toFixed(2), +isl.routeO.toFixed(2)] };
    }
    return o;
  }

  // ---------------------------------------------------------------- per-frame state
  /**
   * Targets for one island: show (0..1, faded by the caller's timing), lift (world units), hi (0..1), splat (0..1: the
   * splat display rule, already including altitude), route {a, b, o} (drawn fraction range and opacity), dense (0..1).
   */
  setIsland(id, s) {
    const isl = this.islands.get(id);
    if (!isl) return;
    if (s.show != null) isl.showT = s.show;
    if (s.lift != null) isl.liftT = s.lift;
    if (s.hi != null) isl.hiT = s.hi;
    if (s.splat != null) isl.splatT = s.splat;
    if (s.route) { isl.routeA = s.route.a; isl.routeB = s.route.b; isl.routeOT = s.route.o; }
  }
  /** Advance fades and lifts. Returns true while something still moves. */
  update(dt) {
    let more = false;
    const kL = 1 - Math.exp(-dt / 0.12), kH = 1 - Math.exp(-dt / 0.18), kS = 1 - Math.exp(-dt / 0.3);
    for (const isl of this.islands.values()) {
      const step = (cur, tgt, k, eps) => { const v = cur + (tgt - cur) * k; if (Math.abs(tgt - v) > eps) { more = true; return v; } return tgt; };
      isl.show = step(isl.show, isl.showT, kS, 0.002);
      isl.lift = step(isl.lift, isl.liftT, kL, 0.01);
      isl.hi = step(isl.hi, isl.hiT, kH, 0.002);
      isl.routeO = step(isl.routeO, isl.routeOT, kS, 0.002);
      // splats: the target already holds the altitude rule; arriving layers fade in over FADE_S
      const want = isl.best ? isl.splatT : 0;
      const kk = 1 - Math.exp(-dt / (FADE_S / 3));
      isl.splatK = step(isl.splatK, want, want < isl.splatK ? 1 : kk, 0.002);
      const y = isl.desc.place.y + isl.lift;
      if (Math.abs(isl.group.position.y - y) > 1e-4) { isl.group.position.y = y; isl.group.updateMatrixWorld(true); }
      // layers: the best fades in; the ones it replaces fade out after (so a subset is not drawn twice for long)
      const bestL = isl.best ? isl.splats[isl.best] : null;
      if (bestL && bestL.k < 1) { bestL.k = Math.min(1, bestL.k + dt / FADE_S); more = true; }
      for (const [t, l] of Object.entries(isl.splats)) {
        if (l === bestL) continue;
        if (bestL && bestL.k >= 1 && l.k > 0) {
          l.k = Math.max(0, l.k - dt / OUT_S);
          more = true;
          if (l.k === 0 && t === 'cut') this.dropSplats(isl.id, 'cut');   // Lite holds every splat of the cut
        }
      }
      const vis = isl.show * isl.splatK;
      for (const l of Object.values(isl.splats)) {
        // written only on a change: Spark treats a written opacity as an edit and asks for a new frame
        const e = l.k * l.k * (3 - 2 * l.k), o = Math.round(vis * e * 1000) / 1000, v = o > 0.003;
        if (l.o !== o) { l.o = o; l.mesh.opacity = o; }
        if (l.mesh.visible !== v) l.mesh.visible = v;
      }
      const pk = isl.show * (1 - isl.splatK);
      const pa = Math.min(1, 0.9 * pk * (1 + 0.3 * isl.hi));
      isl.mat.uniforms.uOpacity.value = isl.dense ? 0 : pa;
      isl.mat.uniforms.uHi.value = isl.hi;
      if (isl.base) isl.base.visible = !isl.dense && pa > 0.002;
      if (isl.dense) {
        isl.denseMat.uniforms.uOpacity.value = pa;
        isl.denseMat.uniforms.uHi.value = isl.hi;
        isl.dense.pts.visible = pa > 0.002;
      }
      if (isl.halo) {
        const o = 0.12 * this.haloK * isl.show * isl.routeO * (1 - isl.splatK) * (0.75 + 0.5 * isl.hi);
        isl.halo.material.uniforms.uOpacity.value = o;
        isl.halo.visible = o > 0.002;
      }
      if (isl.route) {
        const u = isl.route.mesh.material.uniforms;
        u.uA.value = isl.routeA; u.uB.value = isl.routeB;
        u.uOpacity.value = isl.routeO * isl.show * (0.55 + 0.45 * isl.hi);
        u.uNear.value = this.stage.camera.near;
        u.uWidth.value = (this.params.phone ? 2.6 : 2.4) * this.stage.drawScale;
        isl.route.mesh.visible = u.uOpacity.value > 0.003 && isl.routeB > isl.routeA;
      }
    }
    return more;
  }

  // ---------------------------------------------------------------- geometry helpers
  /** World pose of xclean's camera at map-frame pose (p, q[x,y,z,w]) on island id: into outP [3], outQ [4]. */
  poseWorld(id, p, q, outP, outQ) {
    const isl = this.islands.get(id);
    this._m.compose(this._p.set(p[0], p[1], p[2]), this._q.set(q[0], q[1], q[2], q[3]), this._one);
    this._m2.copy(isl.group.matrixWorld).multiply(isl.local).multiply(this._m).multiply(F_CV);
    this._m2.decompose(this._p, this._q, this._s);
    outP[0] = this._p.x; outP[1] = this._p.y; outP[2] = this._p.z;
    outQ[0] = this._q.x; outQ[1] = this._q.y; outQ[2] = this._q.z; outQ[3] = this._q.w;
  }
  /** Island-frame point (metres) -> world, into out [3]. */
  toWorld(id, v, out) {
    const isl = this.islands.get(id);
    this._v.set(v[0], v[1], v[2]).applyMatrix4(isl.group.matrixWorld);
    out[0] = this._v.x; out[1] = this._v.y; out[2] = this._v.z;
    return out;
  }
  /** Islands' screen positions (CSS px): centre, label anchor (top), screen radius, in front of the camera. */
  project(w, h) {
    const cam = this.stage.camera, v = this._v, out = [];
    cam.updateMatrixWorld();
    const f = (h / 2) / Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    for (const isl of this.islands.values()) {
      const s = isl.desc.scale, gp = isl.group.position;
      v.set(gp.x, gp.y + isl.desc.height * s * 0.55 + 4, gp.z).project(cam);
      const top = { x: (v.x + 1) / 2 * w, y: (1 - v.y) / 2 * h };
      const topFront = v.z < 1;
      v.set(gp.x, gp.y + isl.desc.height * s * 0.2, gp.z);
      const dist = v.distanceTo(cam.position);
      v.project(cam);
      const c = { x: (v.x + 1) / 2 * w, y: (1 - v.y) / 2 * h };
      const r = isl.desc.radius * s / Math.max(1e-3, dist) * f;
      const front = v.z < 1 && v.z > -1 && topFront;
      out.push({ id: isl.id, c, top, r, dist, front, show: isl.show, inView: front && c.x > -r && c.x < w + r && c.y > -r && c.y < h + r });
    }
    return out;
  }

  /** The backdrop: data/starfield.json (Fig. 1's 5,200 points of oak_161834, enlarged; not stars). */
  setBackdrop(sf, { scale, y, relief = 2 }) {
    if (this.backdrop || !sf?.p) return;
    const n = sf.p.length / 3, P = new Float32Array(n * 3), G = new Uint8Array(n).fill(205);
    for (let i = 0; i < n; i++) { P[i * 3] = sf.p[i * 3] * scale; P[i * 3 + 1] = sf.p[i * 3 + 1] * scale * relief + y; P[i * 3 + 2] = sf.p[i * 3 + 2] * scale; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('aGrey', new THREE.BufferAttribute(G, 1, true));
    const m = this._pointsMat({ grey: true, size: scale * 0.0022, minPx: 1.0, maxPx: 2.6, tint: 0.3, near: 1 });
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    pts.renderOrder = -2;
    this.stage.scene.add(pts);
    this.backdrop = { pts, mat: m, k: 0, kT: 0 };
  }
  /** Backdrop visibility (0..1, eased by the caller). */
  setBackdropK(k) { this.haloK = k; if (this.backdrop) { this.backdrop.mat.uniforms.uOpacity.value = 0.32 * k; this.backdrop.pts.visible = k > 0.003; } }
  /** Governor: draw half of every point set (any prefix is a uniform subsample). */
  setHalfPoints(on) {
    if (this.halfPoints === on) return;
    this.halfPoints = on;
    for (const isl of this.islands.values()) {
      isl.base?.geometry.setDrawRange(0, on ? isl.baseN >> 1 : isl.baseN);
      isl.dense?.pts.geometry.setDrawRange(0, on ? isl.dense.n >> 1 : isl.dense.n);
    }
  }
  memory() {
    let points = 0, splats = 0, maps = 0;
    for (const isl of this.islands.values()) {
      points += isl.baseN * 10 + (isl.dense ? isl.dense.n * (isl.grey ? 7 : 9) : 0);
      for (const l of Object.values(isl.splats)) { splats += (l.mesh.numSplats || 0) * 32; maps++; }
    }
    return { points_mb: +(points / 1e6).toFixed(1), splats_mb: +(splats / 1e6).toFixed(1), splat_maps: maps };
  }
  disposeAll() {
    for (const isl of this.islands.values()) {
      this.dropSplats(isl.id);
      this.dropDense(isl.id);
      isl.base?.geometry.dispose();
      isl.route?.mesh.geometry.dispose();
      if (isl.halo) { isl.halo.geometry.dispose(); isl.halo.material.dispose(); }
      isl.group.removeFromParent();
    }
    for (const m of this.mats) m.dispose();
    for (const m of this.routeMats) m.dispose();
    if (this.backdrop) { this.backdrop.pts.geometry.dispose(); this.backdrop.pts.removeFromParent(); }
    for (const w of this.warm.children) w.geometry.dispose();
    this.warm.removeFromParent();
    this.islands.clear(); this.mats.clear(); this.routeMats.clear(); this.backdrop = null;
  }
}
