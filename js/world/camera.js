// Camera math for the world (MASTER_PLAN.md 1.4). Pure functions on plain arrays (vectors [x, y, z], quaternions
// [x, y, z, w]), so the director has no three.js dependency and the still path can share it.

export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const clamp01 = x => clamp(x, 0, 1);
export const lerp = (a, b, k) => a + (b - a) * k;
export const ramp = (x, a, b) => clamp01((x - a) / (b - a));

export const ease = {
  linear: t => t,
  smoothstep: t => t * t * (3 - 2 * t),
  smootherstep: t => t * t * t * (t * (6 * t - 15) + 10),
  easeInOutSine: t => -(Math.cos(Math.PI * t) - 1) / 2,
  easeInOutCubic: t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  easeOutCubic: t => 1 - Math.pow(1 - t, 3),
  easeInQuad: t => t * t,
  expoOut: t => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  expoIn: t => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10)),
};

// ---------------------------------------------------------------- vectors
export const add = (a, b, o = [0, 0, 0]) => { o[0] = a[0] + b[0]; o[1] = a[1] + b[1]; o[2] = a[2] + b[2]; return o; };
export const sub = (a, b, o = [0, 0, 0]) => { o[0] = a[0] - b[0]; o[1] = a[1] - b[1]; o[2] = a[2] - b[2]; return o; };
export const scale = (a, k, o = [0, 0, 0]) => { o[0] = a[0] * k; o[1] = a[1] * k; o[2] = a[2] * k; return o; };
export const len = a => Math.hypot(a[0], a[1], a[2]);
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const lerp3 = (a, b, k, o = [0, 0, 0]) => { o[0] = a[0] + (b[0] - a[0]) * k; o[1] = a[1] + (b[1] - a[1]) * k; o[2] = a[2] + (b[2] - a[2]) * k; return o; };
export const norm = (a, o = [0, 0, 0]) => { const l = len(a) || 1; return scale(a, 1 / l, o); };
export const cross = (a, b, o = [0, 0, 0]) => { const x = a[1] * b[2] - a[2] * b[1], y = a[2] * b[0] - a[0] * b[2], z = a[0] * b[1] - a[1] * b[0]; o[0] = x; o[1] = y; o[2] = z; return o; };

/** Cubic Bezier through p0, p1, p2, p3 at t. */
export function bezier3(p0, p1, p2, p3, t, o = [0, 0, 0]) {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  for (let k = 0; k < 3; k++) o[k] = a * p0[k] + b * p1[k] + c * p2[k] + d * p3[k];
  return o;
}
/** Cubic Hermite from p0 (tangent m0) to p1 (tangent m1). */
export function hermite(p0, m0, p1, m1, t, o = [0, 0, 0]) {
  const t2 = t * t, t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
  for (let k = 0; k < 3; k++) o[k] = h00 * p0[k] + h10 * m0[k] + h01 * p1[k] + h11 * m1[k];
  return o;
}
/** A glide from a to b with an apex of `apex` world units at the middle (C2's arc). */
export function arc(a, b, apex, e, o = [0, 0, 0]) {
  lerp3(a, b, e, o);
  o[1] += Math.sin(Math.PI * e) * apex;
  return o;
}
/** Rotate point p about the vertical axis through c by yaw (radians). */
export function orbit(p, c, yaw, o = [0, 0, 0]) {
  const dx = p[0] - c[0], dz = p[2] - c[2], cs = Math.cos(yaw), sn = Math.sin(yaw);
  o[0] = c[0] + dx * cs + dz * sn; o[1] = p[1]; o[2] = c[2] - dx * sn + dz * cs;
  return o;
}

// ---------------------------------------------------------------- quaternions
export function qmul(a, b, o = [0, 0, 0, 1]) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3], bx = b[0], by = b[1], bz = b[2], bw = b[3];
  o[0] = ax * bw + aw * bx + ay * bz - az * by;
  o[1] = ay * bw + aw * by + az * bx - ax * bz;
  o[2] = az * bw + aw * bz + ax * by - ay * bx;
  o[3] = aw * bw - ax * bx - ay * by - az * bz;
  return o;
}
export function qdot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]; }
export function qnorm(q) { const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1; q[0] /= l; q[1] /= l; q[2] /= l; q[3] /= l; return q; }
export function slerp(a, b, t, o = [0, 0, 0, 1]) {
  let bx = b[0], by = b[1], bz = b[2], bw = b[3];
  let c = qdot(a, b);
  if (c < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; c = -c; }
  let k0 = 1 - t, k1 = t;
  if (c < 0.9995) { const th = Math.acos(Math.min(1, c)), s = Math.sin(th); k0 = Math.sin((1 - t) * th) / s; k1 = Math.sin(t * th) / s; }
  o[0] = a[0] * k0 + bx * k1; o[1] = a[1] * k0 + by * k1; o[2] = a[2] * k0 + bz * k1; o[3] = a[3] * k0 + bw * k1;
  return qnorm(o);
}
/** Angle between two orientations (radians); robust to inputs a few ulp off unit length (three's decompose). */
export function qangle(a, b) {
  const la = Math.hypot(a[0], a[1], a[2], a[3]) || 1, lb = Math.hypot(b[0], b[1], b[2], b[3]) || 1, s = qdot(a, b) < 0 ? -1 : 1;
  let d2 = 0;
  for (let k = 0; k < 4; k++) { const d = a[k] / la - s * b[k] / lb; d2 += d * d; }
  return 4 * Math.asin(Math.min(1, Math.sqrt(d2) / 2));      // the chord between unit quaternions -> the rotation angle
}
/** Quaternion of a camera (looking down its -z, +y up) at pos looking at target, world up +y. */
export function lookQuat(pos, target, o = [0, 0, 0, 1]) {
  const z = norm(sub(pos, target));                         // camera +z points away from the target
  let x = cross([0, 1, 0], z);
  if (len(x) < 1e-6) x = [1, 0, 0];
  norm(x, x);
  const y = cross(z, x);
  return fromBasis(x, y, z, o);
}
export function fromBasis(x, y, z, o = [0, 0, 0, 1]) {
  const m00 = x[0], m01 = y[0], m02 = z[0], m10 = x[1], m11 = y[1], m12 = z[1], m20 = x[2], m21 = y[2], m22 = z[2];
  const tr = m00 + m11 + m22;
  if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); o[3] = 0.25 / s; o[0] = (m21 - m12) * s; o[1] = (m02 - m20) * s; o[2] = (m10 - m01) * s; }
  else if (m00 > m11 && m00 > m22) { const s = 2 * Math.sqrt(1 + m00 - m11 - m22); o[3] = (m21 - m12) / s; o[0] = 0.25 * s; o[1] = (m01 + m10) / s; o[2] = (m02 + m20) / s; }
  else if (m11 > m22) { const s = 2 * Math.sqrt(1 + m11 - m00 - m22); o[3] = (m02 - m20) / s; o[0] = (m01 + m10) / s; o[1] = 0.25 * s; o[2] = (m12 + m21) / s; }
  else { const s = 2 * Math.sqrt(1 + m22 - m00 - m11); o[3] = (m10 - m01) / s; o[0] = (m02 + m20) / s; o[1] = (m12 + m21) / s; o[2] = 0.25 * s; }
  return qnorm(o);
}
/** Yaw (about +y) then pitch (about the camera's x): the look-around offset, applied in the camera frame. */
export function yawPitch(yaw, pitch, o = [0, 0, 0, 1]) {
  const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(pitch / 2), sp = Math.sin(pitch / 2);
  o[0] = cy * sp; o[1] = sy * cp; o[2] = -sy * sp; o[3] = cy * cp;
  return o;
}
/** Rotate vector v by quaternion q. */
export function qrot(q, v, o = [0, 0, 0]) {
  const [x, y, z, w] = q, vx = v[0], vy = v[1], vz = v[2];
  const ix = w * vx + y * vz - z * vy, iy = w * vy + z * vx - x * vz, iz = w * vz + x * vy - y * vx, iw = -x * vx - y * vy - z * vz;
  o[0] = ix * w + iw * -x + iy * -z - iz * -y;
  o[1] = iy * w + iw * -y + iz * -x - ix * -z;
  o[2] = iz * w + iw * -z + ix * -y - iy * -x;
  return o;
}
/** Heading (radians about +y, 0 = looking down -z) of a camera orientation. */
export function headingOf(q) { const f = qrot(q, [0, 0, -1]); return Math.atan2(-f[0], -f[2]); }

// ---------------------------------------------------------------- the follow spring
/**
 * A critically damped spring that follows a moving target pose (position, orientation, field of view), so wheel steps
 * never jerk; it snaps when settled (the GPU then idles). wPos / wRot: natural frequencies (rad/s).
 */
export class Spring {
  constructor({ wPos = 9, wRot = 7 } = {}) {
    this.wPos = wPos; this.wRot = wRot;
    this.pos = null; this.vel = [0, 0, 0];
    this.quat = [0, 0, 0, 1]; this.fov = 46; this.fovV = 0;
    this.settled = true;
  }
  snap(pos, quat, fov) {
    this.pos = pos.slice(); this.quat = quat.slice(); this.fov = fov; this.vel = [0, 0, 0]; this.fovV = 0; this.settled = true;
  }
  /** One step toward the target; eps: the snap distance (world units). Returns true while still moving. */
  step(dt, pos, quat, fov, eps) {
    if (!this.pos) { this.snap(pos, quat, fov); return false; }
    dt = Math.min(dt, 0.05);
    const w = this.wPos;
    // closed-form critically damped step (stable for any dt)
    const e = Math.exp(-w * dt);
    for (let k = 0; k < 3; k++) {
      const x = this.pos[k] - pos[k], v = this.vel[k];
      const c = v + w * x;
      this.pos[k] = pos[k] + (x + c * dt) * e;
      this.vel[k] = (v - c * w * dt) * e;
    }
    {
      const x = this.fov - fov, c = this.fovV + w * x;
      this.fov = fov + (x + c * dt) * e;
      this.fovV = (this.fovV - c * w * dt) * e;
    }
    // orientation: exponential slerp (a rotation spring without overshoot)
    slerp(this.quat, quat, 1 - Math.exp(-this.wRot * dt * 1.6), this.quat);
    const d = dist(this.pos, pos), a = qangle(this.quat, quat);
    if (d < eps && a < 2e-5 && len(this.vel) < eps * 10 && Math.abs(this.fov - fov) < 1e-3) {
      this.snap(pos, quat, fov);
      return false;
    }
    this.settled = false;
    return true;
  }
}
