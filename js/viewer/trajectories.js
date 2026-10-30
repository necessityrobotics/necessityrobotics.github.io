// Necessity Robotics viewer (ported from the approved review viewer) — trajectories (ours / ORB-SLAM3 / GT as Line2), error colouring, the map-segment split,
// the 80 exported keyframe frustums and the moving marker. Everything is built in the map frame (OpenCV axes) and
// lives under the 'world' group. traj.json: ours{t,p,q[x,y,z,w] = R_map_cam,kf_id,err}, orb3{t,p,q}|null, gt{t,p}|null.
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';

// draw order (transparent pass, after Spark at 0): GT under ORB-SLAM3 under ours; marker always on top
const ORDER = { gt: 10, orb3: 11, oursCase: 12, ours: 13, frustums: 14, hover: 15, marker: 20 };
const DIM = 0.16; // opacity of trajectory outside the map segment when MAP SEGMENT ONLY is on

// ---------------------------------------------------------------- our pose over time
export class PoseTrack {
  constructor(ours) {
    const n = ours.t.length;
    this.n = n;
    this.t = Float64Array.from(ours.t);
    this.p = new Float32Array(n * 3);
    this.q = new Float32Array(n * 4);
    ours.p.forEach((v, i) => this.p.set(v, i * 3));
    ours.q.forEach((v, i) => this.q.set(v, i * 4));
    this.kf = ours.kf_id || [];
    this.err = ours.err || [];
    this.cum = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      const dx = this.p[i * 3] - this.p[i * 3 - 3], dy = this.p[i * 3 + 1] - this.p[i * 3 - 2], dz = this.p[i * 3 + 2] - this.p[i * 3 - 1];
      this.cum[i] = this.cum[i - 1] + Math.hypot(dx, dy, dz);
    }
    this._qa = new THREE.Quaternion();
    this._qb = new THREE.Quaternion();
  }
  /** [i, alpha] with t[i] <= t <= t[i+1] (clamped to the run). */
  locate(t) {
    const T = this.t, n = this.n;
    if (n < 2 || t <= T[0]) return [0, 0];
    if (t >= T[n - 1]) return [n - 2, 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
    const span = T[hi] - T[lo];
    return [lo, span > 0 ? (t - T[lo]) / span : 0];
  }
  /** Interpolated pose at t (lerp p, slerp q), map frame. */
  pose(t, outP, outQ) {
    const [i, a] = this.locate(t);
    const j = Math.min(this.n - 1, i + 1);
    const P = this.p;
    outP.set(P[i * 3] + (P[j * 3] - P[i * 3]) * a, P[i * 3 + 1] + (P[j * 3 + 1] - P[i * 3 + 1]) * a, P[i * 3 + 2] + (P[j * 3 + 2] - P[i * 3 + 2]) * a);
    if (outQ) {
      this._qa.fromArray(this.q, i * 4);
      this._qb.fromArray(this.q, j * 4);
      outQ.slerpQuaternions(this._qa, this._qb, a);
    }
    return outP;
  }
  nearest(t) { const [i, a] = this.locate(t); return a < 0.5 ? i : Math.min(this.n - 1, i + 1); }
  dist(t) { const [i, a] = this.locate(t); const j = Math.min(this.n - 1, i + 1); return this.cum[i] + (this.cum[j] - this.cum[i]) * a; }
  /** Index range [i0, i1] of the keyframes inside [t0, t1] (inclusive), or null. */
  range(t0, t1) {
    const T = this.t, n = this.n;
    let lo = 0, hi = n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] < t0 - 1e-6) lo = m + 1; else hi = m; }
    const i0 = lo;
    lo = i0; hi = n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] <= t1 + 1e-6) lo = m + 1; else hi = m; }
    const i1 = lo - 1;
    return i0 <= i1 ? [i0, i1] : null;
  }
}

// ---------------------------------------------------------------- distance fade (FOLLOW / low orbit)
// Splats write no depth, so a trajectory far down the road is drawn over everything: at eye level in FOLLOW, the rest
// of a 3.7 km run (and its keyframe frustums) collapsed into a bright horizontal line across the whole picture at the
// horizon (review, kitti_00). The trajectory and frustum materials therefore fade out with view distance between
// LINE_FADE.x and LINE_FADE.y metres; main.js sets the range per camera mode (no fade at the overview).
export const LINE_FADE = { value: new THREE.Vector2(1e9, 2e9) };
function withFade(mat) {
  mat.onBeforeCompile = sh => {
    const head = 'uniform vec2 uFade;\nvarying float vFadeD;\n';
    const mv = 'vec4 mvPosition = ( position.y < 0.5 ) ? start : end; // this is an approximation';
    const out = 'gl_FragColor = vec4( diffuseColor.rgb, alpha );';
    if (!sh.vertexShader.includes(mv) || !sh.fragmentShader.includes(out)) return; // three changed: no fade, still correct
    sh.uniforms.uFade = LINE_FADE;
    sh.vertexShader = head + sh.vertexShader.replace(mv, mv + '\nvFadeD = -mvPosition.z;');
    sh.fragmentShader = head + sh.fragmentShader.replace(out, 'alpha *= 1.0 - smoothstep( uFade.x, uFade.y, vFadeD );\nif ( alpha < 0.004 ) discard;\n' + out);
  };
  mat.customProgramCacheKey = () => 'xv-fade';
  return mat;
}

// ---------------------------------------------------------------- helpers
function flat(points, i0 = 0, i1 = points.length - 1) {
  const out = new Float32Array((i1 - i0 + 1) * 3);
  for (let i = i0; i <= i1; i++) out.set(points[i], (i - i0) * 3);
  return out;
}
/** Split sample indices by a time window: before / inside / after, sharing the boundary samples so parts join. */
function split(t, t0, t1) {
  const n = t.length;
  let a = 0; while (a < n && t[a] < t0 - 1e-6) a++;
  let b = n - 1; while (b >= 0 && t[b] > t1 + 1e-6) b--;
  const parts = {};
  if (a <= b) parts.in = [a, b];
  if (a > 0) parts.pre = [0, Math.min(n - 1, a)];
  if (b < n - 1) parts.post = [Math.max(0, b), n - 1];
  return parts;
}
function makeLine(pos, mat, order, colors) {
  const g = new LineGeometry();
  g.setPositions(pos);
  if (colors) g.setColors(colors);
  const l = new Line2(g, mat);
  l.renderOrder = order;
  l.frustumCulled = false;
  return l;
}

// ---------------------------------------------------------------- trajectories
export class Trajectories {
  /**
   * traj: traj.json; seg: {t0, t1} or null (whole run is the map); C: {ours, orb3, gt, ink, none} hex tokens;
   * ramp: f(u) -> sRGB; scale: errorScale() result or null; dash: GT dash length (m).
   */
  constructor(traj, { seg, C, ramp, scale, dash }) {
    this.group = new THREE.Group();
    this.group.name = 'trajectories';
    this.parts = { ours: [], oursCase: [], oursErr: [], orb3: [], gt: [] };
    this.vis = { ours: true, orb3: !!traj.orb3, gt: !!traj.gt, err: false };
    this.segOnly = !!seg;
    this.hasSeg = !!seg;
    const mats = [];
    const mk = (key, opts) => {
      const m = withFade(new LineMaterial({ worldUnits: false, transparent: true, ...opts }));
      mats.push(m);
      return m;
    };

    const add = (key, sys, pts, times, matOpts, order, colorsFn) => {
      const pieces = seg ? split(times, seg.t0, seg.t1) : { in: [0, pts.length - 1] };
      for (const [where, [i0, i1]] of Object.entries(pieces)) {
        if (i1 - i0 < 1) continue;
        const mat = mk(key, matOpts);
        const line = makeLine(flat(pts, i0, i1), mat, order, colorsFn ? colorsFn(i0, i1) : null);
        if (matOpts.dashed) line.computeLineDistances();
        line.userData = { where, base: matOpts.opacity ?? 1 };
        this.parts[key].push(line);
        this.group.add(line);
      }
    };

    const ours = traj.ours;
    if (traj.gt) add('gt', 'gt', traj.gt.p, traj.gt.t, { color: C.gt, linewidth: 1.5, dashed: true, dashSize: dash, gapSize: dash * 0.7, opacity: 0.95 }, ORDER.gt);
    if (traj.orb3) add('orb3', 'orb3', traj.orb3.p, traj.orb3.t, { color: C.orb3, linewidth: 2, opacity: 1 }, ORDER.orb3);
    // a dark casing under ours keeps it legible over bright splats
    // depthWrite off: the casing must not occlude the line drawn over it (Line2 quads of different widths interpolate
    // slightly different depths, so an equal-depth test fails and the ion line vanished under its own casing)
    add('oursCase', 'ours', ours.p, ours.t, { color: C.ink, linewidth: 5, opacity: 0.55, depthWrite: false }, ORDER.oursCase);
    add('ours', 'ours', ours.p, ours.t, { color: C.ours, linewidth: 2.6, opacity: 1 }, ORDER.ours);
    if (scale && ramp) {
      const none = new THREE.Color(C.none);
      const col = new THREE.Color();
      const errColors = (i0, i1) => {
        const out = new Float32Array((i1 - i0 + 1) * 3);
        for (let i = i0; i <= i1; i++) {
          const e = ours.err?.[i];
          if (e == null) col.copy(none);
          else { const [r, g, b] = ramp(e / scale.top); col.setRGB(r, g, b, THREE.SRGBColorSpace); }
          out.set([col.r, col.g, col.b], (i - i0) * 3);
        }
        return out;
      };
      add('oursErr', 'ours', ours.p, ours.t, { color: 0xffffff, vertexColors: true, linewidth: 3.2, opacity: 1 }, ORDER.ours, errColors);
    }
    this.materials = mats;
    this.apply();
  }

  set(k, v) { this.vis[k] = v; this.apply(); }
  setSegmentOnly(on) { this.segOnly = on; this.apply(); }

  apply() {
    const { ours, orb3, gt, err } = this.vis;
    const show = {
      gt, orb3,
      oursCase: ours,
      ours: ours && !(err && this.parts.oursErr.length),
      oursErr: ours && err && this.parts.oursErr.length > 0,
    };
    for (const [key, lines] of Object.entries(this.parts)) {
      for (const l of lines) {
        l.visible = !!show[key];
        const outside = l.userData.where !== 'in';
        const dim = outside && this.segOnly;
        l.material.opacity = l.userData.base * (dim ? DIM : 1);
      }
    }
  }

  dispose() {
    this.group.removeFromParent();
    for (const lines of Object.values(this.parts)) for (const l of lines) l.geometry.dispose();
    for (const m of this.materials) m.dispose();
  }
}

// ---------------------------------------------------------------- camera frustum geometry (OpenCV camera frame)
/** Segments of a camera frustum with the image's own K (principal point included) plus an 'up' tick. */
function frustumSegments(K, [W, H], depth) {
  const fx = K[0][0], fy = K[1][1], cx = K[0][2], cy = K[1][2];
  const P = (u, v) => [((u - cx) / fx) * depth, ((v - cy) / fy) * depth, depth];
  const c = [P(0, 0), P(W, 0), P(W, H), P(0, H)];
  const o = [0, 0, 0];
  const s = [];
  for (const v of c) s.push(o, v);
  for (let i = 0; i < 4; i++) s.push(c[i], c[(i + 1) % 4]);
  // the 'up' tick on the top edge (image row 0 is up: OpenCV y down)
  const a = P(W * 0.38, 0), b = P(W * 0.62, 0), tip = P(W * 0.5, -H * 0.2);
  s.push(a, tip, tip, b);
  return s;
}

export class KeyframeFrustums {
  /** kfs: keyframes.json; size: frustum depth (m); C: {train, held, hover} hex tokens. */
  constructor(kfs, { size, C }) {
    this.kfs = kfs.keyframes;
    this.group = new THREE.Group();
    this.group.name = 'keyframe frustums';
    const segs = frustumSegments(kfs.K, kfs.image_size, size);
    const pos = [];
    const col = [];
    const cTrain = new THREE.Color(C.train), cHeld = new THREE.Color(C.held);
    const M = new THREE.Matrix4();
    const v = new THREE.Vector3();
    this.centers = [];
    this.mats = [];
    for (const kf of this.kfs) {
      const T = kf.T_map_cam;
      M.set(...T[0], ...T[1], ...T[2], ...T[3]);
      this.mats.push(M.clone());
      this.centers.push(new THREE.Vector3(T[0][3], T[1][3], T[2][3]));
      const c = kf.held_out_of_map ? cHeld : cTrain;
      for (const p of segs) {
        v.fromArray(p).applyMatrix4(M);
        pos.push(v.x, v.y, v.z);
        col.push(c.r, c.g, c.b);
      }
    }
    const g = new LineSegmentsGeometry();
    g.setPositions(pos);
    g.setColors(col);
    this.material = withFade(new LineMaterial({ color: 0xffffff, vertexColors: true, linewidth: 1.3, transparent: true, opacity: 0.9, worldUnits: false }));
    this.lines = new LineSegments2(g, this.material);
    this.lines.renderOrder = ORDER.frustums;
    this.lines.frustumCulled = false;
    this.group.add(this.lines);

    // hover / current highlight: one frustum, drawn thicker
    this.segs = segs;
    const hg = new LineSegmentsGeometry();
    hg.setPositions(new Float32Array(segs.length * 3));
    this.hoverMat = new LineMaterial({ color: C.hover, linewidth: 2.6, transparent: true, opacity: 1, worldUnits: false, depthTest: false });
    this.hover = new LineSegments2(hg, this.hoverMat);
    this.hover.renderOrder = ORDER.hover;
    this.hover.frustumCulled = false;
    this.hover.visible = false;
    this.group.add(this.hover);
    this.hoverIndex = -1;
  }
  highlight(i) {
    if (i === this.hoverIndex) return;
    this.hoverIndex = i;
    if (i < 0) { this.hover.visible = false; return; }
    const M = this.mats[i];
    const v = new THREE.Vector3();
    const pos = [];
    for (const p of this.segs) { v.fromArray(p).applyMatrix4(M); pos.push(v.x, v.y, v.z); }
    this.hover.geometry.setPositions(pos);
    this.hover.visible = true;
  }
  dispose() {
    this.group.removeFromParent();
    this.lines.geometry.dispose(); this.material.dispose();
    this.hover.geometry.dispose(); this.hoverMat.dispose();
  }
}

// ---------------------------------------------------------------- the moving marker (our camera at time t)
const DOT_VERT = /* glsl */`
  uniform float uPx, uPR;
  void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = uPx * uPR; }`;
const DOT_FRAG = /* glsl */`
  uniform vec3 uCol;
  void main() {
    vec2 p = gl_PointCoord - 0.5; float r = length(p);
    if (r > 0.5) discard;
    float core = 1.0 - smoothstep(0.18, 0.24, r);
    float ring = smoothstep(0.30, 0.36, r) * (1.0 - smoothstep(0.44, 0.5, r));
    float a = max(core, ring * 0.9);
    if (a < 0.02) discard;
    gl_FragColor = vec4(uCol, a);
  }`;

export class Marker {
  constructor(kfs, { size, color, pr }) {
    this.group = new THREE.Group();
    this.group.name = 'marker (ours at t)';
    const segs = frustumSegments(kfs.K, kfs.image_size, size);
    const g = new LineSegmentsGeometry();
    g.setPositions(segs.flat());
    this.mat = new LineMaterial({ color, linewidth: 2.2, transparent: true, depthTest: false, worldUnits: false });
    this.lines = new LineSegments2(g, this.mat);
    this.lines.renderOrder = ORDER.marker;
    this.lines.frustumCulled = false;
    const rgb = new THREE.Color(color);
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    this.dotMat = new THREE.ShaderMaterial({
      vertexShader: DOT_VERT, fragmentShader: DOT_FRAG, transparent: true, depthTest: false, depthWrite: false,
      uniforms: { uPx: { value: 15 }, uPR: { value: pr }, uCol: { value: new THREE.Vector3() } },
    });
    // the dot's shader writes sRGB directly: read the token back from the THREE.Color in sRGB space
    const s = {}; rgb.getRGB(s, THREE.SRGBColorSpace);
    this.dotMat.uniforms.uCol.value.set(s.r, s.g, s.b);
    this.dot = new THREE.Points(dg, this.dotMat);
    this.dot.renderOrder = ORDER.marker + 1;
    this.dot.frustumCulled = false;
    this.group.add(this.lines, this.dot);
  }
  set(p, q) { this.group.position.copy(p); this.group.quaternion.copy(q); }
  setPixelRatio(pr) { this.dotMat.uniforms.uPR.value = pr; }
  dispose() {
    this.group.removeFromParent();
    this.lines.geometry.dispose(); this.mat.dispose();
    this.dot.geometry.dispose(); this.dotMat.dispose();
  }
}
