// V12 concept A (LIFT-OFF): a COPY of site/js/place/path.js. Changes: the path is drawn in the accent (Verdigris), and
// makeTicks() adds a metre mark across the path every 10 m (a longer one every 50 m). The original file is unchanged.
//
// Necessity Robotics v4, lane ENGINE: the camera's path of one place, by METRES (not by time).
//
// The visitor of a 3-D place moves along the path the camera took. Everything here is indexed by "at" = metres along
// that path (the same number as explore.html?at=, data/routes.json and maps.json stats.path_m), never by seconds.
//   PathTrack   positions, headings and the ground under the path, in the WORLD frame of the stage (gravity up = +Y)
//   fitRoute    the 2-D frame of data/routes.json (the "You are here" map) from the 3-D path, by a rigid 2-D fit
//   makeRibbon  the camera's path drawn ON THE GROUND (one mesh, one shader)
// World frame: stage.world carries the map frame (OpenCV axes) turned so that the map's up direction is +Y.
// A heading (yaw) is an angle about +Y; the direction of yaw a is (-sin a, 0, -cos a): three.js cameras look along -Z.
import * as THREE from 'three';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const TAU = Math.PI * 2;

/** Moving average of arr over +-w metres of path (cum = metres at each sample). */
function smooth(arr, cum, w) {
  const n = arr.length, out = new Float64Array(n), pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + arr[i];
  let lo = 0, hi = 0;
  for (let i = 0; i < n; i++) {
    while (cum[i] - cum[lo] > w) lo++;
    if (hi < i) hi = i;
    while (hi + 1 < n && cum[hi + 1] - cum[i] <= w) hi++;
    out[i] = (pre[hi + 1] - pre[lo]) / (hi + 1 - lo);
  }
  return out;
}

export class PathTrack {
  /**
   * ours:   traj.json "ours" { t: [s], p: [[x, y, z]], q: [[x, y, z, w]] = R_map_cam } (map frame, OpenCV camera axes)
   * worldQ: THREE.Quaternion, map frame -> world frame (up -> +Y)
   * camH:   the camera's height above the ground in metres (js/place/ground.json: the place's median)
   * profile: { h: [metres], step } the same height along the path, one value every `step` metres (optional)
   * ride:   true for rides and drives (longer smoothing windows)
   */
  constructor(ours, worldQ, { camH = 1.4, profile = null, ride = false } = {}) {
    const n = this.n = ours.t.length;
    this.t = Float64Array.from(ours.t);
    this.camH = camH;
    const X = this.X = new Float64Array(n), Y = this.Y = new Float64Array(n), Z = this.Z = new Float64Array(n);
    const yaw = new Float64Array(n), pit = new Float64Array(n), cum = this.cum = new Float64Array(n);
    const v = new THREE.Vector3(), q = new THREE.Quaternion(), f = new THREE.Vector3();
    let prev = 0;
    for (let i = 0; i < n; i++) {
      v.fromArray(ours.p[i]).applyQuaternion(worldQ);
      X[i] = v.x; Y[i] = v.y; Z[i] = v.z;
      q.fromArray(ours.q[i]).normalize();
      f.set(0, 0, 1).applyQuaternion(q).applyQuaternion(worldQ);          // the camera's optical axis, world frame
      let y = Math.hypot(f.x, f.z) > 0.2 ? Math.atan2(-f.x, -f.z) : prev;
      if (i) { while (y - prev > Math.PI) y -= TAU; while (y - prev < -Math.PI) y += TAU; }
      yaw[i] = prev = y;
      pit[i] = Math.asin(clamp(f.y, -1, 1));
      if (i) cum[i] = cum[i - 1] + Math.hypot(X[i] - X[i - 1], Y[i] - Y[i - 1], Z[i] - Z[i - 1]);
    }
    this.total = cum[n - 1];
    this.duration = Math.max(1e-3, this.t[n - 1] - this.t[0]);
    this.speed = this.total / this.duration;                               // metres per second, the recording's mean
    // the view's base heading: the camera's own heading, without the shake of a hand or a rough road
    this.yawRaw = yaw;
    this.yaw = smooth(yaw, cum, ride ? 3 : 1.5);
    this.anchorAt = null; this.anchorCorr = null;
    const sp = pit.slice().sort();
    this.pitchMedian = sp[n >> 1];
    // the ground under the path: the path's own height (smoothed), minus the camera's height
    const ys = smooth(Y, cum, ride ? 4 : 2), xs = smooth(X, cum, ride ? 5 : 3), zs = smooth(Z, cum, ride ? 5 : 3);
    const P = profile && Array.isArray(profile.h) && profile.h.length > 1 && profile.step > 0 ? profile : null;
    const hAt = s => {
      if (!P) return camH;
      const x = s / P.step, i = Math.min(P.h.length - 1, Math.floor(x)), j = Math.min(P.h.length - 1, i + 1);
      return P.h[i] + (P.h[j] - P.h[i]) * (x - i);
    };
    this.GX = xs; this.GZ = zs; this.GY = ys.map((y, i) => y - hAt(cum[i]));
    // the path's direction on the ground (for "left of the path" and "which way is forward")
    const w = ride ? 3 : 1.5, tan = new Float64Array(n);
    let lo = 0, hi = 0; prev = yaw[0];
    for (let i = 0; i < n; i++) {
      while (cum[i] - cum[lo] > w) lo++;
      if (hi < i) hi = i;
      while (hi + 1 < n && cum[hi + 1] - cum[i] <= w) hi++;
      const dx = xs[hi] - xs[lo], dz = zs[hi] - zs[lo];
      let a = Math.hypot(dx, dz) > 0.15 ? Math.atan2(-dx, -dz) : (i ? prev : this.yaw[0]);
      while (a - prev > Math.PI) a -= TAU; while (a - prev < -Math.PI) a += TAU;
      tan[i] = prev = a;
    }
    this.tan = smooth(tan, cum, w);
  }

  /** [i, a]: sample i and fraction a with cum[i] <= at <= cum[i + 1]. */
  locate(at) {
    const C = this.cum, n = this.n;
    if (n < 2 || at <= 0) return [0, 0];
    if (at >= this.total) return [n - 2, 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (C[m] <= at) lo = m; else hi = m; }
    const span = C[hi] - C[lo];
    return [lo, span > 0 ? (at - C[lo]) / span : 0];
  }
  _mix(arr, at) { const [i, a] = this.locate(at); const j = Math.min(this.n - 1, i + 1); return arr[i] + (arr[j] - arr[i]) * a; }
  /** The camera's position at `at` metres (world frame), into out (THREE.Vector3). */
  pos(at, out) {
    const [i, a] = this.locate(at), j = Math.min(this.n - 1, i + 1);
    return out.set(this.X[i] + (this.X[j] - this.X[i]) * a, this.Y[i] + (this.Y[j] - this.Y[i]) * a, this.Z[i] + (this.Z[j] - this.Z[i]) * a);
  }
  /** The point of the ground under the path at `at` metres (world frame). */
  ground(at, out) {
    const [i, a] = this.locate(at), j = Math.min(this.n - 1, i + 1);
    return out.set(this.GX[i] + (this.GX[j] - this.GX[i]) * a, this.GY[i] + (this.GY[j] - this.GY[i]) * a, this.GZ[i] + (this.GZ[j] - this.GZ[i]) * a);
  }
  /**
   * The view's base heading at `at` (radians about +Y): the camera's heading, smoothed, and exact at every anchor
   * (the real photos: at a photo's own position the view looks where that photo looks).
   */
  yawAt(at) {
    let y = this._mix(this.yaw, at);
    const A = this.anchorAt;
    if (A && A.length) {
      const C = this.anchorCorr, n = A.length;
      if (at <= A[0]) y += C[0];
      else if (at >= A[n - 1]) y += C[n - 1];
      else {
        let lo = 0, hi = n - 1;
        while (hi - lo > 1) { const m = (lo + hi) >> 1; if (A[m] <= at) lo = m; else hi = m; }
        const span = A[hi] - A[lo];
        y += C[lo] + (C[hi] - C[lo]) * (span > 1e-6 ? (at - A[lo]) / span : 0);
      }
    }
    return y;
  }
  /** Make the base heading exact at these moments of the recording (seconds): the real photos. */
  setAnchors(times) {
    const T = this.t, n = this.n, at = [], corr = [];
    for (const t of times) {
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
      const i = Math.abs(T[lo] - t) <= Math.abs(T[hi] - t) ? lo : hi;
      const a = this.cum[i];
      if (at.length && a - at[at.length - 1] < 0.25) continue;            // two photos of one spot: the first one decides
      at.push(a); corr.push(this.yawRaw[i] - this.yaw[i]);
    }
    this.anchorAt = at; this.anchorCorr = corr;
  }
  /** The path's direction at `at` (radians about +Y). */
  tanAt(at) { return this._mix(this.tan, at); }
  /** Seconds of the recording at `at` metres, and back. */
  timeAt(at) { return this._mix(this.t, at); }
  atOfTime(t) {
    const T = this.t, n = this.n;
    if (t <= T[0]) return 0;
    if (t >= T[n - 1]) return this.total;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
    const span = T[hi] - T[lo];
    return this.cum[lo] + (this.cum[hi] - this.cum[lo]) * (span > 0 ? (t - T[lo]) / span : 0);
  }
  /** Index of the sample nearest to `at`. */
  nearest(at) { const [i, a] = this.locate(at); return a < 0.5 ? i : Math.min(this.n - 1, i + 1); }
}

/**
 * The 2-D frame of data/routes.json from the 3-D path. routes.json holds a top view of the same path
 * ([t s, x m, y m, metres]); its axes are a rotation (or a mirror) of the world's ground plane. A rigid 2-D fit over the
 * route's points finds it. Returns { ok, rms, xy(X, Z) -> [x, y], deg(yaw) -> heading in degrees, counter-clockwise
 * from +x }, the numbers the route door's setXY() and setHeading() take.
 */
export function fitRoute(track, pts) {
  const step = Math.max(1, Math.floor(pts.length / 160)), A = [], B = [], v = new THREE.Vector3();
  for (let i = 0; i < pts.length; i += step) { track.pos(pts[i][3], v); A.push([v.x, v.z]); B.push([pts[i][1], pts[i][2]]); }
  const n = A.length;
  if (n < 3) return { ok: false, rms: Infinity, xy: () => [0, 0], deg: () => 0 };
  const mean = P => P.reduce((m, p) => [m[0] + p[0] / n, m[1] + p[1] / n], [0, 0]);
  const ma = mean(A), mb = mean(B);
  let best = null;
  for (const flip of [1, -1]) {
    let sc = 0, ss = 0;
    for (let i = 0; i < n; i++) {
      const ax = A[i][0] - ma[0], ay = (A[i][1] - ma[1]) * flip, bx = B[i][0] - mb[0], by = B[i][1] - mb[1];
      sc += ax * bx + ay * by; ss += ax * by - ay * bx;
    }
    const th = Math.atan2(ss, sc), c = Math.cos(th), s = Math.sin(th);
    let e = 0;
    for (let i = 0; i < n; i++) {
      const ax = A[i][0] - ma[0], ay = (A[i][1] - ma[1]) * flip;
      e += (c * ax - s * ay + mb[0] - B[i][0]) ** 2 + (s * ax + c * ay + mb[1] - B[i][1]) ** 2;
    }
    const rms = Math.sqrt(e / n);
    if (!best || rms < best.rms) best = { flip, c, s, rms };
  }
  const { flip, c, s, rms } = best;
  const lin = (dx, dz) => [c * dx - s * dz * flip, s * dx + c * dz * flip];
  return {
    ok: rms < 2.5, rms,
    xy(X, Z) { const d = lin(X - ma[0], Z - ma[1]); return [d[0] + mb[0], d[1] + mb[1]]; },
    deg(yaw) { const d = lin(-Math.sin(yaw), -Math.cos(yaw)); return Math.atan2(d[1], d[0]) * 180 / Math.PI; },
  };
}

// ------------------------------------------------------------------ the camera's path on the ground
const RIBBON_VERT = /* glsl */`
  attribute vec3 aN; attribute float aSide; attribute float aS;
  uniform float uHalf, uMinPx, uMaxPx, uViewH;
  uniform float uLoop, uLoopK, uSeamLen; uniform vec3 uSeam;
  varying float vS, vSide, vD, vW;
  void main() {
    // F (the home's first screen): the walk goes round a path that does not quite close; its last uSeamLen metres bend
    // onto its start by uSeam (the page's camera bends the same way). uLoopK 0 = the path as measured.
    vec3 P0 = position + uSeam * (uLoopK * smoothstep(uLoop - uSeamLen, uLoop, aS));
    vec4 mv = modelViewMatrix * vec4(P0, 1.0);
    float d = max(0.05, -mv.z);
    float pxPerM = projectionMatrix[1][1] * uViewH * 0.5 / d;
    float hw = max(min(uHalf, uMaxPx / pxPerM), uMinPx / pxPerM);      // near the eye the line keeps a width, it does not fill the picture
    gl_Position = projectionMatrix * modelViewMatrix * vec4(P0 + aN * (aSide * hw), 1.0);
    vS = aS; vSide = aSide; vD = d; vW = hw * pxPerM;                  // vW = half the line's width on screen, in buffer pixels
  }`;
// The look: a narrow band of blue light on the ground. Its middle is see-through (the ground shows through it), two
// brighter rims hold it together, one dark hairline outside keeps it readable on sunlit ground. Far away, where the
// band is only a few pixels wide, it becomes one solid line.
const RIBBON_FRAG = /* glsl */`
  uniform vec3 uCol, uRim, uEdge;
  uniform float uAt, uBack, uAhead, uFar, uOpacity, uBody, uHot, uPx;
  uniform float uLoop, uLoopK;
  varying float vS, vSide, vD, vW;
  float win(float ds) { return ds >= 0.0 ? 1.0 - smoothstep(uAhead * 0.55, uAhead, ds) : 1.0 - smoothstep(uBack * 0.5, uBack, -ds); }
  void main() {
    float a = win(vS - uAt);
    if (uLoopK > 0.0) {
      // F: round the loop. The window wraps at uLoop; the tail past it (beside the start) is hidden. Both mix with k, so
      // the pull-back (k 1 -> 0) turns the closed walk back into the path as measured with no switch.
      float aw = win(mod(vS - uAt + 0.5 * uLoop, uLoop) - 0.5 * uLoop) * (1.0 - step(uLoop, vS));
      a = mix(a, aw, uLoopK);
    }
    a *= 1.0 - smoothstep(uFar * 0.6, uFar, vD);
    float e = abs(vSide);
    float w = vW / uPx;                                          // half width in CSS pixels
    float thin = 1.0 - smoothstep(2.2, 5.5, w);                  // 1 = a thin far line
    float rim = smoothstep(0.50, 0.66, e) * (1.0 - smoothstep(0.80, 0.90, e));
    float hair = smoothstep(0.82, 0.92, e) * (1.0 - thin);
    float body = mix(uBody + uHot * 0.22, 0.96, thin);
    float alpha = mix(mix(body, 0.96, rim * (1.0 - thin)), 0.55, hair);
    vec3 c = mix(mix(uCol, uRim, max(rim * (1.0 - thin), uHot * 0.35)), uEdge, hair);
    alpha *= 1.0 - smoothstep(1.0 - min(0.5, 1.2 / max(w, 0.5)), 1.0, e);   // about one pixel of soft edge
    a *= alpha * uOpacity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(c, a);
  }`;

/**
 * The camera's path as a flat ribbon on the ground. It is drawn after the 3-D place and without a depth test (the place
 * writes no depth), so it shows only a window of the path around the visitor (uBack behind, uAhead ahead), or the whole
 * path in the view from above. width: metres. Returns { mesh, uniforms, dispose() }.
 */
export function makeRibbon(track, { width = 0.4, color = '#6fc7b0', rim = '#d9f3ec', spacing = 0.4 } = {}) {
  const idx = [];
  let last = -Infinity;
  for (let i = 0; i < track.n; i++) if (track.cum[i] - last >= spacing || i === track.n - 1) { idx.push(i); last = track.cum[i]; }
  const m = idx.length;
  const pos = new Float32Array(m * 2 * 3), nor = new Float32Array(m * 2 * 3), side = new Float32Array(m * 2), sv = new Float32Array(m * 2);
  for (let k = 0; k < m; k++) {
    const i = idx[k], a = idx[Math.max(0, k - 1)], b = idx[Math.min(m - 1, k + 1)];
    let dx = track.GX[b] - track.GX[a], dz = track.GZ[b] - track.GZ[a];
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    for (let e = 0; e < 2; e++) {
      const o = (k * 2 + e) * 3;
      pos[o] = track.GX[i]; pos[o + 1] = track.GY[i]; pos[o + 2] = track.GZ[i];
      nor[o] = dz; nor[o + 1] = 0; nor[o + 2] = -dx;                        // sideways on the ground
      side[k * 2 + e] = e ? 1 : -1;
      sv[k * 2 + e] = track.cum[i];
    }
  }
  const ind = new Uint32Array((m - 1) * 6);
  for (let k = 0; k < m - 1; k++) ind.set([k * 2, k * 2 + 1, k * 2 + 2, k * 2 + 1, k * 2 + 3, k * 2 + 2], k * 6);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aN', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
  g.setAttribute('aS', new THREE.BufferAttribute(sv, 1));
  g.setIndex(new THREE.BufferAttribute(ind, 1));
  const srgb = hex => { const o = {}; new THREE.Color(hex).getRGB(o, THREE.SRGBColorSpace); return new THREE.Vector3(o.r, o.g, o.b); };   // the shader writes sRGB values directly
  const uniforms = {
    uHalf: { value: width / 2 }, uMinPx: { value: 1.6 }, uMaxPx: { value: 11 }, uViewH: { value: 800 }, uPx: { value: 1 },
    uCol: { value: srgb(color) }, uRim: { value: srgb(rim) }, uEdge: { value: new THREE.Vector3(0.0, 0.035, 0.028) },
    uAt: { value: 0 }, uBack: { value: 10 }, uAhead: { value: 60 }, uFar: { value: 90 }, uOpacity: { value: 1 }, uBody: { value: 0.46 }, uHot: { value: 0 },
    uLoop: { value: 0 }, uLoopK: { value: 0 }, uSeamLen: { value: 1 }, uSeam: { value: new THREE.Vector3() },   // F: the closed walk (off)
  };
  const mat = new THREE.ShaderMaterial({ vertexShader: RIBBON_VERT, fragmentShader: RIBBON_FRAG, uniforms, transparent: true,
    depthTest: false, depthWrite: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 30;
  mesh.name = "the camera's path on the ground";
  return { mesh, uniforms, dispose() { mesh.removeFromParent(); g.dispose(); mat.dispose(); } };
}

// ------------------------------------------------------------------ concept A: metre marks across the path
const TICK_VERT = /* glsl */`
  attribute vec3 aT; attribute vec3 aN; attribute vec2 aUV; attribute float aBig; attribute float aS;
  uniform float uHalf, uMinPx, uMaxPx, uViewH, uPx;
  varying float vS, vBig, vD;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float d = max(0.05, -mv.z);
    float pxPerM = projectionMatrix[1][1] * uViewH * 0.5 / d;
    float band = clamp(uHalf * pxPerM, uMinPx, uMaxPx);              // half the path's width on screen (buffer px)
    float lpx = band + mix(5.0, 10.0, aBig) * uPx;                     // a mark always reaches past the band
    float wpx = mix(0.75, 1.1, aBig) * uPx;
    vec3 p = position + aN * (aUV.x * lpx / pxPerM) + aT * (aUV.y * wpx / pxPerM);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    vS = aS; vBig = aBig; vD = d;
  }`;
const TICK_FRAG = /* glsl */`
  uniform vec3 uCol;
  uniform float uAt, uBack, uAhead, uFar, uOpacity;
  varying float vS, vBig, vD;
  void main() {
    float ds = vS - uAt;
    float a = ds >= 0.0 ? 1.0 - smoothstep(uAhead * 0.55, uAhead, ds) : 1.0 - smoothstep(uBack * 0.5, uBack, -ds);
    a *= 1.0 - smoothstep(uFar * 0.6, uFar, vD);
    a *= mix(0.8, 1.0, vBig) * uOpacity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uCol, a);
  }`;

/**
 * A short mark across the path every `every` metres (a longer one every `big` metres). Same windows and pixel rules as the
 * ribbon, so the marks sit on it at every distance. Returns { mesh, uniforms, marks: [metres], dispose() }.
 */
export function makeTicks(track, { every = 10, big = 50, color = '#e8f6f1' } = {}) {
  const marks = [];
  for (let m = every; m < track.total - every * 0.4; m += every) marks.push(m);
  const n = marks.length, P = new Float32Array(n * 12), T = new Float32Array(n * 12), N = new Float32Array(n * 12);
  const UV = new Float32Array(n * 8), B = new Float32Array(n * 4), S = new Float32Array(n * 4), ind = new Uint32Array(n * 6);
  const g = new THREE.Vector3(), g0 = new THREE.Vector3(), g1 = new THREE.Vector3();
  const uv = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  marks.forEach((m, i) => {
    track.ground(m, g); track.ground(Math.max(0, m - 1), g0); track.ground(Math.min(track.total, m + 1), g1);
    let dx = g1.x - g0.x, dz = g1.z - g0.z; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    const isBig = Math.abs(m / big - Math.round(m / big)) < 1e-6 ? 1 : 0;
    for (let v = 0; v < 4; v++) {
      const o = (i * 4 + v) * 3;
      P[o] = g.x; P[o + 1] = g.y; P[o + 2] = g.z;
      T[o] = dx; T[o + 1] = 0; T[o + 2] = dz;
      N[o] = dz; N[o + 1] = 0; N[o + 2] = -dx;
      UV[(i * 4 + v) * 2] = uv[v][0]; UV[(i * 4 + v) * 2 + 1] = uv[v][1];
      B[i * 4 + v] = isBig; S[i * 4 + v] = m;
    }
    ind.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
  geo.setAttribute('aT', new THREE.BufferAttribute(T, 3));
  geo.setAttribute('aN', new THREE.BufferAttribute(N, 3));
  geo.setAttribute('aUV', new THREE.BufferAttribute(UV, 2));
  geo.setAttribute('aBig', new THREE.BufferAttribute(B, 1));
  geo.setAttribute('aS', new THREE.BufferAttribute(S, 1));
  geo.setIndex(new THREE.BufferAttribute(ind, 1));
  const o = {}; new THREE.Color(color).getRGB(o, THREE.SRGBColorSpace);
  const uniforms = {
    uHalf: { value: 0.06 }, uMinPx: { value: 1.4 }, uMaxPx: { value: 11 }, uViewH: { value: 800 }, uPx: { value: 1 },
    uCol: { value: new THREE.Vector3(o.r, o.g, o.b) }, uAt: { value: 0 }, uBack: { value: 10 }, uAhead: { value: 45 }, uFar: { value: 48 }, uOpacity: { value: 1 },
  };
  const mat = new THREE.ShaderMaterial({ vertexShader: TICK_VERT, fragmentShader: TICK_FRAG, uniforms, transparent: true,
    depthTest: false, depthWrite: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 31;
  mesh.name = 'metre marks on the path';
  return { mesh, uniforms, marks, dispose() { mesh.removeFromParent(); geo.dispose(); mat.dispose(); } };
}
