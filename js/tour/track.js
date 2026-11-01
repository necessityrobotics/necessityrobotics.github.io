// A camera track over time, with distance along it. Pure JS (no three.js), so the 2-D layer can use it before the 3-D
// code has loaded.
//   Track.fromTraj(traj.json ours{t, p, q[x,y,z,w] = R_map_cam}) : xclean's keyframe poses, map frame, OpenCV camera axes
//   Track.fromRoute(routes.json pts[[t, x, y, d]])              : the 2-D top view of the same route (minimap)
export class Track {
  constructor(t, cum, p = null, q = null, xy = null) {
    this.t = t; this.cum = cum; this.p = p; this.q = q; this.xy = xy;
    this.n = t.length;
    this.length = cum[this.n - 1] || 0;
  }
  static fromTraj(ours) {
    const n = ours.t.length;
    const t = Float64Array.from(ours.t), p = new Float64Array(n * 3), q = new Float64Array(n * 4), cum = new Float64Array(n);
    ours.p.forEach((v, i) => p.set(v, i * 3));
    ours.q.forEach((v, i) => q.set(v, i * 4));
    for (let i = 1; i < n; i++) {
      cum[i] = cum[i - 1] + Math.hypot(p[i * 3] - p[i * 3 - 3], p[i * 3 + 1] - p[i * 3 - 2], p[i * 3 + 2] - p[i * 3 - 1]);
    }
    return new Track(t, cum, p, q);
  }
  static fromRoute(pts) {
    const n = pts.length, t = new Float64Array(n), cum = new Float64Array(n), xy = new Float64Array(n * 2);
    pts.forEach((v, i) => { t[i] = v[0]; xy[i * 2] = v[1]; xy[i * 2 + 1] = v[2]; cum[i] = v[3]; });
    return new Track(t, cum, null, null, xy);
  }
  /** [i, a]: t[i] <= t <= t[i+1], clamped. */
  locate(t) {
    const T = this.t, n = this.n;
    if (n < 2 || t <= T[0]) return [0, 0];
    if (t >= T[n - 1]) return [n - 2, 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (T[m] <= t) lo = m; else hi = m; }
    const s = T[hi] - T[lo];
    return [lo, s > 0 ? (t - T[lo]) / s : 0];
  }
  dist(t) { const [i, a] = this.locate(t); return this.cum[i] + (this.cum[i + 1] - this.cum[i]) * a; }
  /** The time at which the route has covered distance d (metres), clamped. */
  timeAt(d) {
    const C = this.cum, n = this.n;
    if (d <= C[0]) return this.t[0];
    if (d >= C[n - 1]) return this.t[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (C[m] <= d) lo = m; else hi = m; }
    const s = C[hi] - C[lo];
    return this.t[lo] + (this.t[hi] - this.t[lo]) * (s > 0 ? (d - C[lo]) / s : 0);
  }
  /** Position (3-D track) at t into out[0..2]. */
  pos(t, out) {
    const [i, a] = this.locate(t), P = this.p, j = i + 1;
    for (let k = 0; k < 3; k++) out[k] = P[i * 3 + k] + (P[j * 3 + k] - P[i * 3 + k]) * a;
    return out;
  }
  /** Orientation (3-D track) at t into out[x, y, z, w] (slerp). */
  quat(t, out) {
    const [i, a] = this.locate(t), Q = this.q, j = i + 1;
    let ax = Q[i * 4], ay = Q[i * 4 + 1], az = Q[i * 4 + 2], aw = Q[i * 4 + 3];
    let bx = Q[j * 4], by = Q[j * 4 + 1], bz = Q[j * 4 + 2], bw = Q[j * 4 + 3];
    let c = ax * bx + ay * by + az * bz + aw * bw;
    if (c < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; c = -c; }
    let k0 = 1 - a, k1 = a;
    if (c < 0.9995) { const th = Math.acos(c), s = Math.sin(th); k0 = Math.sin((1 - a) * th) / s; k1 = Math.sin(a * th) / s; }
    out[0] = ax * k0 + bx * k1; out[1] = ay * k0 + by * k1; out[2] = az * k0 + bz * k1; out[3] = aw * k0 + bw * k1;
    const l = Math.hypot(out[0], out[1], out[2], out[3]) || 1;
    out[0] /= l; out[1] /= l; out[2] /= l; out[3] /= l;
    return out;
  }
  /** Top-view position (2-D route) at t into out[x, y], and the heading (radians) of the route there. */
  xyAt(t, out) {
    const [i, a] = this.locate(t), X = this.xy, j = i + 1;
    out[0] = X[i * 2] + (X[j * 2] - X[i * 2]) * a;
    out[1] = X[i * 2 + 1] + (X[j * 2 + 1] - X[i * 2 + 1]) * a;
    // heading over a short window, so a pause or a rotation in place does not spin the marker
    let k0 = Math.max(0, i - 2), k1 = Math.min(this.n - 1, j + 2);
    out[2] = Math.atan2(X[k1 * 2 + 1] - X[k0 * 2 + 1], X[k1 * 2] - X[k0 * 2]);
    return out;
  }
}
