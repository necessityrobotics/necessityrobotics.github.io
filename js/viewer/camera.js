// Necessity Robotics viewer (ported from the approved review viewer) — camera rig: ORBIT (OrbitControls), FOLLOW (a chase camera behind our pose at the timeline time)
// and POV (the exact keyframe camera). The projection is set here before every render as an off-axis frustum:
// symmetric in ORBIT / FOLLOW, and in POV the keyframe's full K (fx, fy, cx, cy) mapped onto the image rectangle
// inside the canvas, which is pixel-identical to SPARK_NOTES §10.4 (T_map_cam · diag(1,-1,-1,1) + setViewOffset)
// within the rectangle, and keeps rendering the scene around it.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { REDUCED, clamp, easeInOut, easeOut } from './util.js';

const FOV = 50;
// FOLLOW is the fly-through camera: close behind and a little above our camera, looking along the run (the views the
// map was trained from, so the splats look their best). The wheel pulls it back into a chase view.
export const FOLLOW_ZOOM = 0.35;
const UP = new THREE.Vector3(0, 1, 0);
const F_CV = new THREE.Matrix4().makeScale(1, -1, -1); // OpenCV camera axes -> three.js camera axes

export class CameraRig {
  constructor(stage, dom) {
    this.stage = stage;
    this.camera = stage.camera;
    this.dom = dom;
    const c = this.controls = new OrbitControls(this.camera, dom);
    c.enableDamping = true;
    c.dampingFactor = 0.1;
    c.screenSpacePanning = true;
    c.zoomToCursor = true;
    c.rotateSpeed = 0.8;
    c.maxPolarAngle = Math.PI * 0.54;
    this.interacting = false;
    c.addEventListener('start', () => { this.interacting = true; this.cancelTween(true); this.onUser?.(); stage.invalidate(); });
    c.addEventListener('end', () => { this.interacting = false; stage.invalidate(); });
    // inside a frame (the damping tail), update() below decides whether another frame is worth drawing
    c.addEventListener('change', () => { if (!stage._inTick) stage.invalidate(); });
    this._lastPos = new THREE.Vector3();
    this._lastQuat = new THREE.Quaternion();

    this.mode = 'orbit';
    this.tween = null;
    this.scene = { center: new THREE.Vector3(), radius: 10, followDist: 3, near: 0.05 };
    this.frustum = { l: -1, r: 1, t: 1, b: -1 };   // tangent extents at unit depth, current
    this.povFrustum = null;
    this.povRect = null;                             // {x, y, w, h} in canvas CSS px
    this.pov = null;                                 // {world: Matrix4, K, size}
    this.saved = null;                               // the orbit view to return to
    this.follow = { yaw: 0, pitch: 0, zoom: FOLLOW_ZOOM, heading: new THREE.Vector3(0, 0, -1), ready: false, pos: new THREE.Vector3(), look: new THREE.Vector3(), target: new THREE.Vector3(), fwd: new THREE.Vector3(0, 0, -1) };
    this._hookDrag();
    stage.hooks.add(dt => this.update(dt));
    stage.before.add(() => this.applyProjection());
  }

  // ---------------------------------------------------------------- scene scale
  setScene({ center, radius, followDist }) {
    this.scene.center.copy(center);
    this.scene.radius = radius;
    this.scene.followDist = followDist;
    this.controls.minDistance = Math.max(0.05, radius * 0.002);
    this.controls.maxDistance = radius * 12;
  }

  /** The default ORBIT view: an oblique view that fits the map's bounding sphere into the free area. */
  defaultView({ azimuth, elevation = 0.62, free } = {}) {
    const { center, radius } = this.scene;
    const asp = free ? free.w / free.h : this.stage.size.w / this.stage.size.h;
    const vf = THREE.MathUtils.degToRad(FOV) / 2;
    const hf = Math.atan(Math.tan(vf) * asp);
    const half = Math.min(vf, hf);
    // the free area is a fraction of the canvas: the map should fit inside it, not inside the whole canvas
    const fill = free ? Math.min(free.w / this.stage.size.w, free.h / this.stage.size.h) : 1;
    const dist = (radius / Math.sin(half)) * 0.92 / Math.max(0.55, fill);
    const az = azimuth ?? 0.7;
    const dir = new THREE.Vector3(Math.cos(elevation) * Math.sin(az), Math.sin(elevation), Math.cos(elevation) * Math.cos(az));
    return { pos: center.clone().addScaledVector(dir, dist), target: center.clone(), dist };
  }

  // ---------------------------------------------------------------- projection
  symmetric() { return this._symmetric(); }
  _symmetric(out = {}) {
    const { w, h } = this.stage.size;
    const t = Math.tan(THREE.MathUtils.degToRad(FOV) / 2);
    const r = t * (w / h);
    return Object.assign(out, { l: -r, r, t, b: -t });
  }
  /** The keyframe's K mapped onto the image rectangle in the canvas (off-axis frustum, tangent extents). */
  _povFrustum() {
    if (!this.pov || !this.povRect) return null;
    const { K, size: [IW] } = this.pov;
    const { x, y, w } = this.povRect;
    const { w: W, h: H } = this.stage.size;
    const s = w / IW;
    const fx = K[0][0] * s, fy = K[1][1] * s, cx = x + K[0][2] * s, cy = y + K[1][2] * s;
    return { l: -cx / fx, r: (W - cx) / fx, t: cy / fy, b: -(H - cy) / fy };
  }
  applyProjection() {
    const cam = this.camera;
    let f;
    if (this.tween && this.tween.f0 && this.tween.f1) {
      const k = this.tween.k;
      const a = this.tween.f0, b = this.tween.f1;
      f = { l: a.l + (b.l - a.l) * k, r: a.r + (b.r - a.r) * k, t: a.t + (b.t - a.t) * k, b: a.b + (b.b - a.b) * k };
    } else if (this.mode === 'pov' && !this.tween) {
      f = this._povFrustum() || this._symmetric();
    } else {
      f = this._symmetric();
    }
    this.frustum = f;
    const { radius } = this.scene;
    let near, far;
    if (this.mode === 'pov' || (this.tween && this.tween.toPov)) {
      near = clamp(radius * 0.0004, 0.02, 0.25); far = radius * 20;
    } else {
      const d = this.mode === 'orbit' ? cam.position.distanceTo(this.controls.target) : this.scene.followDist;
      near = clamp(d * 0.004, 0.01, 2); far = Math.max(radius * 20, d * 10);
    }
    cam.near = near; cam.far = far;
    cam.fov = THREE.MathUtils.radToDeg(2 * Math.atan((f.t - f.b) / 2));
    cam.aspect = (f.r - f.l) / (f.t - f.b);
    cam.projectionMatrix.makePerspective(f.l * near, f.r * near, f.t * near, f.b * near, near, far);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  }

  // ---------------------------------------------------------------- tweens
  /** Animate to {pos, target} (orbit-style, looking at a target) or {pos, quat} (pose-style). */
  tweenTo(to, { dur = 900, ease = easeInOut, toPov = false, f1 = null, onDone } = {}) {
    const cam = this.camera;
    this.cancelTween(false);
    const from = { pos: cam.position.clone(), quat: cam.quaternion.clone(), target: this.controls.target.clone() };
    if (REDUCED || dur <= 0) {
      this.tween = null;
      cam.position.copy(to.pos);
      if (to.target) { this.controls.target.copy(to.target); cam.lookAt(to.target); } else if (to.quat) cam.quaternion.copy(to.quat);
      onDone?.();
      this.stage.invalidate();
      return;
    }
    this.tween = { from, to, t: 0, dur: dur / 1000, ease, k: 0, toPov, f0: f1 ? { ...this.frustum } : null, f1, onDone };
    this.stage.invalidate();
  }
  cancelTween(finish) {
    const tw = this.tween;
    if (!tw) return;
    this.tween = null;
    if (finish === 'end') { tw.k = 1; this._applyTween(tw); tw.onDone?.(); }
    else if (tw.to.target && this.mode === 'orbit') {
      // hand the interpolated view over to the controls where it is
      this.controls.target.lerpVectors(tw.from.target, tw.to.target, tw.k);
    }
  }
  _applyTween(tw) {
    const cam = this.camera;
    const k = tw.k;
    cam.position.lerpVectors(tw.from.pos, tw.to.pos, k);
    if (tw.to.target) {
      const tg = new THREE.Vector3().lerpVectors(tw.from.target, tw.to.target, k);
      cam.up.copy(UP);
      cam.lookAt(tg);
      if (this.mode === 'orbit') this.controls.target.copy(tg);
    } else {
      cam.quaternion.slerpQuaternions(tw.from.quat, tw.to.quat, k);
    }
  }

  // ---------------------------------------------------------------- modes
  setMode(mode) {
    const prev = this.mode;
    if (prev === 'orbit' && mode !== 'orbit') this.saved = { pos: this.camera.position.clone(), target: this.controls.target.clone() };
    this.mode = mode;
    this.controls.enabled = mode === 'orbit';
    if (mode === 'follow') this.follow.ready = false;
    if (mode === 'orbit' && prev !== 'orbit') {
      const back = this.saved || this.defaultView();
      // leave POV / FOLLOW: fly back to the saved orbit view
      this.camera.up.copy(UP);
      this.tweenTo({ pos: back.pos, target: back.target }, { dur: 900, f1: this._symmetric() });
    }
    this.stage.invalidate();
  }

  /** Enter or move POV: world matrix of the keyframe camera (world · T_map_cam), K and image size. */
  setPov({ worldMatrix, K, size }, { animate = true } = {}) {
    const M = worldMatrix.clone().multiply(F_CV);
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), s = new THREE.Vector3();
    M.decompose(pos, quat, s);
    this.pov = { K, size };
    const f1 = this._povFrustum();
    if (animate && f1) this.tweenTo({ pos, quat }, { dur: this._wasPov ? 520 : 1100, toPov: true, f1, ease: this._wasPov ? easeOut : easeInOut });
    else { this.cancelTween(false); this.camera.position.copy(pos); this.camera.quaternion.copy(quat); this.stage.invalidate(); }
    this._wasPov = true;
  }
  leavePov() { this._wasPov = false; this.pov = null; }
  setPovRect(rect) { this.povRect = rect; if (this.tween?.toPov) this.tween.f1 = this._povFrustum(); this.stage.invalidate(); }

  /** A short cinematic intro: from a high orbit down to the default view. */
  intro(view, { dur = 2600 } = {}) {
    const { center, radius } = this.scene;
    const d = view.pos.clone().sub(view.target);
    const r = d.length();
    const az = Math.atan2(d.x, d.z) - 0.9;
    const start = new THREE.Vector3(Math.sin(az) * 0.35, 1, Math.cos(az) * 0.35).normalize().multiplyScalar(r * 2.1).add(center);
    this.mode = 'orbit';
    this.controls.enabled = true;
    this.camera.up.copy(UP);
    this.camera.position.copy(start);
    this.controls.target.copy(center).addScaledVector(UP, -radius * 0.05);
    this.camera.lookAt(this.controls.target);
    this.tweenTo(view, { dur: REDUCED ? 0 : dur, ease: easeOut });
  }

  // ---------------------------------------------------------------- follow input (drag = look around, wheel = distance)
  _hookDrag() {
    let down = null;
    this.dom.addEventListener('pointerdown', e => {
      if (this.mode !== 'follow' || e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY, yaw: this.follow.yaw, pitch: this.follow.pitch, id: e.pointerId };
      this.dom.setPointerCapture?.(e.pointerId);
      this.onUser?.();
    });
    this.dom.addEventListener('pointermove', e => {
      if (!down || e.pointerId !== down.id) return;
      this.follow.yaw = down.yaw - (e.clientX - down.x) * 0.006;
      this.follow.pitch = clamp(down.pitch + (e.clientY - down.y) * 0.004, -0.3, 1.2);
      this.stage.invalidate();
    });
    const up = e => { if (down && e.pointerId === down.id) down = null; };
    this.dom.addEventListener('pointerup', up);
    this.dom.addEventListener('pointercancel', up);
    this.dom.addEventListener('wheel', e => {
      if (this.mode !== 'follow') return;
      e.preventDefault();
      this.follow.zoom = clamp(this.follow.zoom * Math.exp(e.deltaY * 0.0012), 0.12, 6);
      this.onFollowZoom?.(this.follow.zoom);
      this.stage.invalidate();
    }, { passive: false });
    this.dom.addEventListener('dblclick', () => {
      if (this.mode !== 'follow') return;
      Object.assign(this.follow, { yaw: 0, pitch: 0, zoom: FOLLOW_ZOOM });
      this.onFollowZoom?.(this.follow.zoom);
      this.stage.invalidate();
    });
  }
  /** Follow target in world: position and our camera's optical axis (world). */
  setFollowTarget(p, fwd) { this.follow.target.copy(p); this.follow.fwd.copy(fwd); }

  _updateFollow(dt) {
    const F = this.follow;
    const h = new THREE.Vector3(F.fwd.x, 0, F.fwd.z);
    if (h.lengthSq() > 0.04) {
      h.normalize();
      if (!F.ready || F.heading.distanceToSquared(h) < 1e-8) F.heading.copy(h);   // snap the last sliver (see below)
      else F.heading.lerp(h, 1 - Math.exp(-dt * 2.6)).normalize();
    }
    const dir = F.heading.clone().applyAxisAngle(UP, F.yaw);
    const dist = this.scene.followDist * F.zoom;
    const height = dist * (0.36 + F.pitch);
    const want = F.target.clone().addScaledVector(dir, -dist).addScaledVector(UP, height);
    // look well ahead along the run (a level horizon), further when close behind
    const ahead = Math.max(dist * 0.55, this.scene.followDist * 0.9);
    const look = F.target.clone().addScaledVector(dir, ahead).addScaledVector(UP, -Math.min(dist * 0.04, ahead * 0.02));
    if (!F.ready || REDUCED) { F.pos.copy(want); F.look.copy(look); F.ready = true; }
    else {
      const k = 1 - Math.exp(-dt * 5.5);
      F.pos.lerp(want, k); F.look.lerp(look, k);
    }
    if (this.tween) {
      // entering FOLLOW: blend from wherever the camera was
      this.tween.to = { pos: F.pos.clone(), target: F.look.clone() };
      return true;
    }
    const moving = F.pos.distanceTo(want) > dist * 0.002 || F.look.distanceTo(look) > dist * 0.002;
    // Settled: land exactly on the goal. An exponential approach never arrives, so every frame nudged the camera by a
    // sub-pixel amount, every nudge made Spark re-sort, and every finished sort asked for another frame: after a pause
    // in FOLLOW the stage kept drawing ~34 frames per second at rest (review measurement, 4s_20201222_115).
    if (!moving) { F.pos.copy(want); F.look.copy(look); }
    this.camera.up.copy(UP);
    this.camera.position.copy(F.pos);
    this.camera.lookAt(F.look);
    return moving;
  }

  // ---------------------------------------------------------------- per frame
  update(dt) {
    let more = false;
    if (this.mode === 'follow') more = this._updateFollow(dt) || more;
    if (this.tween) {
      const tw = this.tween;
      tw.t += dt;
      tw.k = tw.ease(Math.min(1, tw.t / tw.dur));
      this._applyTween(tw);
      if (tw.t >= tw.dur) {
        this.tween = null;
        if (this.mode === 'orbit' && tw.to.target) { this.controls.target.copy(tw.to.target); this.controls.update(); }
        tw.onDone?.();
      }
      more = true;
    } else if (this.mode === 'orbit') {
      const cam = this.camera;
      if (this.controls.update(dt)) {
        // OrbitControls keeps reporting changes until the camera moves < 1 mm, which at kilometre range is seconds of
        // invisible damping (and of Spark re-sorts). Stop asking for frames once a frame's motion is sub-pixel.
        const range = Math.max(1e-3, cam.position.distanceTo(this.controls.target));
        const moved = cam.position.distanceTo(this._lastPos) / range;
        const turned = 1 - Math.abs(cam.quaternion.dot(this._lastQuat));
        if (moved > 2e-5 || turned > 5e-11 || this.interacting) more = true;
        else {
          // settle: drop the invisible remainder of the damping, so later frames (Spark finishing a sort) do not keep
          // nudging the camera and re-triggering sorts
          this.controls._sphericalDelta?.set(0, 0, 0);
          this.controls._panOffset?.set(0, 0, 0);
        }
      }
      this._lastPos.copy(cam.position);
      this._lastQuat.copy(cam.quaternion);
      if (this.interacting) more = true;
    }
    return more;
  }
}
