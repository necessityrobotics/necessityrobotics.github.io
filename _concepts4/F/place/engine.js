// V12 concept F (owner pick 2026-11-13: C's first screen + one photo, then A's lift-off). This file = A's engine copy
// merged (git merge-file) with C's photo pose (setDirect). The live engine in site/js/place is unchanged.
// V12 concept A (LIFT-OFF): a COPY of site/js/place/engine.js with these changes (the original is unchanged):
//   - the lift: one camera curve from eye height (k 0) to the whole place from above (k 1). Phase 1 (k 0 - 0.28): the
//     camera steps back along the path and up, with a subtle dolly-zoom on a point 14 m ahead. Phase 2: it rises on a
//     curve to the view from above. The scroll drives k through a spring (setLift); the 3-D view tweens it (above, drop).
//   - pointer parallax: the camera ORBITS a little around the point it looks at (0.4 m sideways at eye height), so near
//     things pass in front of far things. It follows the pointer and stops when the pointer stops.
//   - a cone where the visitor stands, a line down to the ground, metre marks every 10 m, labels every 50 m.
//   - mode 'lift' (the home background: Lite, no stepping lights, a click opens the 3-D view); never Standard or Full.
//   - a click on the ground (3-D view) walks there; a ring on the ground shows the distance in metres.
//   - two soft edits of the place while the camera is off the ground (Spark SplatEdit, world space): a bubble around the
//     camera (it rises through the tree tops without a wall of leaves in front of it), and from above the tree tops fade
//     to a ghost so the path under them shows. On the ground (k 0) both are off: the place is as built.
// CONCEPT C (Camera ghosts) COPY of site/js/place/engine.js. Changes, all marked "C:":
//   - absolute imports (this copy lives in _concepts4/C/place/)
//   - a pose set by the page (this.X, setDirect): the scroll director of the home page and the one arrival of the 3-D
//     view blend the camera from the engine's own pose (w = 0) to that pose (w = 1); fov and a projection shift too
//   - the camera's path in the accent colour; it is hidden behind the standing photo frames (depth test on)
//   - tap(): the page may take a tap first (a click on a photo frame); opts.tierPref 'lite' skips the cut
// Necessity Robotics v4, lane ENGINE: the ONE 3-D engine of the site (BUILD_PLAN section 4). It is loaded by
// js/place/mount.js only when the device can run it. One instance = one 3-D place in one box.
//
// THE RULE OF THIS FILE (R1): nothing in the scene moves unless the visitor causes it. There is no clock, no time, no
// playback. The visitor's position is "at" = metres along the camera's path. The stage draws a frame only when something
// asks for one (viewer/scene.js Stage: on demand), so a place that nobody touches draws nothing at all.
//
//   position   C(at) + off * left(at)        the camera's own position on its path, plus metres sideways (soft leash)
//   view       heading = camera heading(at) + look.yaw ; pitch = rest + look.pitch ; roll = 0 (always level)
//   walk       stepBy(metres): an eased 300 ms move along the path          ride(on): a glide at the recorded speed
//   above      a view of the whole path from above; a tap on the path glides down to that point
//   ground     the camera's path is a ribbon on the ground under the camera's path; the stepping circles are DOM buttons
//              projected onto that ground after each drawn frame (js/place/steps.js)
import * as THREE from 'three';
import { SplatEdit, SplatEditSdf } from '@sparkjsdev/spark';
import { Stage } from '/js/viewer/scene.js';
import { SplatLayer } from '/js/viewer/layers.js';
import { mapBytes, mapJSON } from '/js/viewer/assets.js';
import { asset } from '/js/config.js';
import { getJSON, siteUrl, REDUCED, fmtLen } from '/js/v4/common.js';
import { PathTrack, fitRoute, makeRibbon, makeTicks } from './path.js';
import { makePointsMaterial, loadPointPrefix, makePoints } from '../points.js';   // F: the measured points (v3's view from above)
import { StepCircles } from '/js/place/steps.js';
import { attachFull, attachFrame, attachLift } from './controls.js';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const DEG = Math.PI / 180;
const easeOut = k => 1 - Math.pow(1 - k, 3);
const easeInOut = k => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const UP = new THREE.Vector3(0, 1, 0);
const smooth = k => { k = clamp(k, 0, 1); return k * k * (3 - 2 * k); };
const KD = 0.28;                                 // the lift: k below this = the step back (dolly); above = the rise
const AHEAD = 14;                                // metres: the point ahead that the dolly-zoom and the parallax keep still

// The projection rule. The still pictures are 16:10 (landscape) and 9:16 (portrait) renders of this same engine, shown
// with object-fit: cover, so the live view must "cover" the same way or the swap from still to live would jump.
const STILL_ASPECT = 1.6, PORTRAIT_ASPECT = 0.5625, PORTRAIT_VFOV = 70;
/** Vertical field of view (degrees) for a canvas of aspect a; v0 = the camera's own vertical field of view. */
export function vfovFor(a, v0) {
  if (a >= 1) return a <= STILL_ASPECT ? v0 : 2 * Math.atan(Math.tan(v0 * DEG / 2) * STILL_ASPECT / a) / DEG;
  if (a <= PORTRAIT_ASPECT) return PORTRAIT_VFOV;
  return 2 * Math.atan(Math.tan(PORTRAIT_VFOV * DEG / 2) * PORTRAIT_ASPECT / a) / DEG;
}

/** The stage of viewer/scene.js with two switches: off-screen pause (home frame) and a pinned resolution (?shot=1). */
class PlaceStage extends Stage {
  constructor(canvas, opts, pin) {
    super(canvas, opts);
    this.off = false;
    this.pin = !!pin;
    if (this.pin) this._pinNow();
  }
  _pinNow() {
    this.maxScale = this.minScale = this.scale = 1;
    if (this.drawScale !== 1) { this.drawScale = 1; this.renderer.setPixelRatio(1); this.renderer.setSize(this.size.w, this.size.h, false); }
  }
  _schedule() { if (!this.off) super._schedule(); }
  _adapt(now) { if (!this.pin) super._adapt(now); }
  _idleSoon() { if (!this.pin) super._idleSoon(); }
  resize(w, h) { const r = super.resize(w, h); if (this.pin && r) this._pinNow(); return r; }
  /** Stop drawing while the box is off screen; one frame when it comes back. */
  setOff(off) {
    if (this.off === off) return;
    this.off = off;
    if (off) { if (this._raf) cancelAnimationFrame(this._raf); this._raf = 0; this._chain = false; }
    else { this._last = performance.now(); this.invalidate(); }
  }
}

export class PlaceEngine {
  /**
   * o: { el, canvas, gl, place, mode: 'frame' | 'full', params (caps.js tier), at, kf, emit(type, detail),
   *      shot (pin the resolution), soft (software WebGL, forced by ?force3d=1), quality ('lite' | 'standard' | null),
   *      layer (the DOM layer for the stepping circles), stepLabel (HTML) }
   */
  constructor(o) {
    this.o = o;
    this.el = o.el; this.canvas = o.canvas; this.mode = o.mode; this.place = o.place; this.params = o.params;
    this.emit = o.emit || (() => {});
    this.folder = o.folder || 'maps';                    // 'maps_sgm32' = the old-depth twin (depth page)
    this.ride_ = o.place.travel !== 'walk';
    this.step = this.ride_ ? 4 : 2;                       // metres per step: walks 2, rides and drives 4
    this.leash = this.ride_ ? 5 : 3;                      // metres sideways from the path, at most
    this.dead = false; this.live = false;
    // the visitor's state. Every field changes only through a visitor's input or a call of the public methods.
    this.S = {
      at: 0, off: 0, offRaw: 0,
      yaw: 0, pitch: 0, tyaw: 0, tpitch: 0,               // look, relative to the path's heading and the rest pitch
      tw: null,                                           // the running move along the path { from, to, t0, dur, offFrom, offTo }
      riding: false, rideDir: 1, rideLast: 0, facing: 1,
      above: { on: false, k: 0, tw: null, az: 0, el: 55 * DEG, zoom: 1, taz: 0, tel: 55 * DEG },
      firstLook: false, firstStep: false, walked: 0,
    };
    this.tiers = {};                                      // 'cut' | 'lite' | 'standard' | 'full' -> true once loaded
    this.tier = null;
    this.layerMode = 'splats';
    this.loads = {};                                      // file -> { loaded, total } (the engineer sheet's loading list)
    this._v = new THREE.Vector3(); this._v2 = new THREE.Vector3(); this._v4 = new THREE.Vector4();
    this._q = new THREE.Quaternion(); this._e = new THREE.Euler(0, 0, 0, 'YXZ');
    this._gp = new THREE.Vector3(); this._gq = new THREE.Quaternion(); this._ap = new THREE.Vector3(); this._aq = new THREE.Quaternion();
    this._m = new THREE.Matrix4();
    this._lastPose = ''; this._photoKey = ''; this._lastTick = 0; this._offShown = false;
    // concept A
    this.lift = { spring: null, v: 0, frozen: false, dolly: o.dolly !== false, el: (o.aboveEl ?? 55) * DEG, shiftX: o.shiftX || 0, dropping: false };
    this.P = { x: 0, y: 0, tx: 0, ty: 0 };             // pointer parallax target and value, -1 .. 1
    this._dir = new THREE.Vector3(); this._T0 = new THREE.Vector3(); this._B = new THREE.Vector3(); this._tgt = new THREE.Vector3();
    this._p1 = new THREE.Vector3(); this._p2 = new THREE.Vector3(); this._rel = new THREE.Vector3(); this._ax = new THREE.Vector3();
    this._foot = new THREE.Vector3(); this._fovNow = 0;
    // C: a pose set by the page. w = weight (0 = the engine's own pose, 1 = this pose). fov in radians (null = the
    // engine's). sx, sy = projection shift in clip units (moves the picture, not the camera). dark = 0..1 black backdrop.
    // ribbon = opacity of the camera's path. all = draw the whole path.
    this.X = { w: 0, p: new THREE.Vector3(), q: new THREE.Quaternion(), fov: null, sx: 0, sy: 0, dark: 0, ribbon: 1, all: false };
    this.onTap = null;                                   // C: (px, py) => true when the page took the tap
  }
  /** C: set (part of) the page's pose; one frame is drawn. */
  setDirect(o) { Object.assign(this.X, o); if (this.stage && this.track) { this._camera(); this.stage.invalidate(); } }

  // ------------------------------------------------------------------ start
  async start() {
    const { place, mode, params, canvas } = this.o, id = place.id;
    const needCut = mode === 'frame' && this.o.tierPref !== 'lite';   // A: the lift needs the whole place (Lite); C: tierPref
    const [traj, kfs, routes, ground, atlas] = await Promise.all([
      this._json(asset(id, 'traj.json', this.folder), 'traj.json'),
      this._json(asset(id, 'keyframes.json', this.folder), 'keyframes.json'),
      getJSON('data/routes.json'),
      getJSON('js/place/ground.json').catch(() => ({ places: {} })),
      needCut ? getJSON('data/atlas.json').catch(() => null) : null,
    ]);
    if (this.dead) return false;
    const pin = !!this.o.shot, soft = !!this.o.soft;
    const stage = this.stage = new PlaceStage(canvas, {
      context: this.o.gl, clear: 0x000000,
      maxDpr: pin || soft ? 1 : params.dprCap, maxPixels: pin ? 1e9 : soft ? 0.3e6 : params.pixCap,
      onContext: s => { if (s === 'lost') this.emit('lost', {}); },
    }, pin);
    if (!stage.spark) throw new Error('the splat renderer did not start');
    // Where the 3-D place holds nothing (open sky in some places) the view shows a plain light backdrop, as the day
    // sky was; from above the backdrop is black. It is not part of the 3-D place.
    this.sky = new THREE.Color(place.colour === false ? 0xc6cace : 0xbdc9d6);
    this._bg = new THREE.Color();
    this._bgK = -1;
    if (params.spark && !pin) Object.assign(stage.spark, params.spark);
    const up = new THREE.Vector3(...(traj.notes?.gravity?.up_map || traj.up || [0, -1, 0])).normalize();
    stage.world.quaternion.setFromUnitVectors(up, UP);
    stage.world.updateMatrixWorld(true);
    const g = ground.places?.[id] || {};
    const track = this.track = new PathTrack(traj.ours, stage.world.quaternion, { camH: g.cam_h || 1.4, profile: g.h ? { h: g.h, step: g.h_step } : null, ride: this.ride_ });
    this.total = track.total;
    this.speed = clamp(track.speed, 1.0, 9);              // the ride: about the recorded speed (metres per second)
    this.kfs = kfs;
    this.photos = kfs.keyframes.map((k, i) => ({ i, t: k.t, at: track.atOfTime(k.t), src: asset(id, k.file, this.folder) }));
    track.setAnchors(kfs.keyframes.map(k => k.t));       // at a photo's own position the view looks where the photo looks
    const route = routes.routes[id];
    this.v0 = route?.cam?.vfov_deg || 46;
    this.fit = route ? fitRoute(track, route.pts) : { ok: false, xy: () => [0, 0], deg: () => 0 };
    this.rest = clamp(track.pitchMedian, -10 * DEG, -4 * DEG);              // the camera's own usual pitch: level, or a little down
    // where the visitor starts: a real photo's camera position (start_kf), or ?at= (snapped to a photo within 0.6 m)
    let at = null;
    if (this.o.at != null && Number.isFinite(+this.o.at)) {
      at = clamp(+this.o.at, 0, this.total);
      const near = this._nearestPhoto(at);
      if (near && Math.abs(near.at - at) <= 0.6) at = near.at;
    } else {
      const k = this.photos[this.o.kf != null ? this.o.kf : place.start_kf];
      at = k ? k.at : clamp(place.start_at_m || 0, 0, this.total);
    }
    this.S.at = at;
    this.cut = this._cutOf(atlas, id);

    this.ribbon = makeRibbon(track, { width: this.ride_ ? 0.16 : 0.12, ...(this.o.ribbon || {}) });
    this.ribbon.mesh.material.depthTest = true;            // C: the standing photo frames (they write depth) hide the path behind them
    stage.scene.add(this.ribbon.mesh);
    this.ticks = makeTicks(track, { every: 10, big: 50, color: this.o.accentRim || '#e8f6f1' });   // F: the accent's light tint
    this.ticks.uniforms.uHalf.value = (this.ride_ ? 0.16 : 0.12) / 2;
    stage.scene.add(this.ticks.mesh);
    this._makeCone();
    this._makeLabels();
    this._makeEdits();
    this.steps = new StepCircles(this.o.layer, {
      mode, label: this.o.stepLabel, step: this.step,
      onPick: (atPick, how) => this._circle(atPick, how),
    });
    if (mode === 'lift') this.steps.setHidden(true);
    this.controls = mode === 'frame' ? attachFrame(this) : mode === 'lift' ? attachLift(this) : attachFull(this);
    stage.hooks.add(() => this._tick());
    stage.before.add(() => this._before());
    stage.after.add(() => this._after());
    this._ro = new ResizeObserver(() => this._fit());
    this._ro.observe(this.el);
    this._fit();
    this._overview(false);
    if (this.o.startAbove) { this.S.above.on = true; this.S.above.k = 1; this.steps.setAbove(true); this._faceOverview(); }
    if (this.o.lift != null) { this.lift.spring = clamp(+this.o.lift, 0, 1); this.S.above.k = this.lift.spring; this.S.above.on = this.S.above.k > 0.5; this.steps.setAbove(this.S.above.on); }
    this._camera();

    // the 3-D place itself: one file first (the ride cut where it covers the start, else Lite), more after it is live
    this.splats = new SplatLayer(stage);
    this.splats.setOn(true);
    const first = this.cut && needCut && this.covers(at, 'cut') ? 'cut' : 'lite';
    await this._load(first);
    if (this.dead) return false;
    this.splats.show(first, { dur: 0 });
    this.tier = first;
    const ok = await this._settle(pin || soft ? 240000 : 12000);
    if (this.dead) return false;
    this.live = true;
    this.steps.setLive(true);
    if (this.o.pointsAbove) this.loadMeasured().catch(e => console.warn('[F] points', e));
    stage.invalidate();
    this._upgrade(first).catch(e => { if (e?.name !== 'AbortError') console.warn('[place] upgrade', e); });
    if (!pin && !soft) this._floor();
    return ok;
  }

  _json(url, name) {
    this.loads[name] = { loaded: 0, total: 0 };
    return mapJSON(url, { onProgress: (l, t) => { this.loads[name] = { loaded: l, total: t || l }; } });
  }
  _cutOf(atlas, id) {
    if (this.folder !== 'maps') return null;            // the cut is made from the default map
    const isl = atlas?.islands?.[id];
    if (!isl?.cut?.file) return null;
    const r = isl.ride?.t0 != null ? isl.ride : isl.dive;
    if (!r || r.t0 == null) return null;
    return { url: siteUrl(isl.cut.file), bytes: isl.cut.bytes, a0: this.track.atOfTime(r.t0), a1: this.track.atOfTime(r.t1) };
  }
  /** True when the 3-D file on screen (or the named one) holds the place around `at` metres. */
  covers(at, tier = this.tier) {
    if (tier !== 'cut') return true;
    return !!this.cut && at >= this.cut.a0 - 0.5 && at <= this.cut.a1 + 0.5;
  }
  static FILES = { lite: 'splats_lite.spz', standard: 'splats.spz', full: 'full/splats.ply' };
  async _load(tier) {
    if (this.tiers[tier]) return;
    const id = this.place.id, file = tier === 'cut' ? 'cut.spz' : PlaceEngine.FILES[tier];
    const url = tier === 'cut' ? this.cut.url : asset(id, file, this.folder);
    const onProgress = (l, t) => { this.loads[tier] = { loaded: l, total: t || this.place.map?.files?.[file] || 0 }; this.emit('progress', { tier, loaded: l, total: t }); };
    this.loads[tier] = { loaded: 0, total: tier === 'cut' ? this.cut.bytes : this.place.map?.files?.[file] || 0 };
    // Lite, Standard and the cut: our own fetch (bytes from, and to, the shared map cache). Full streams inside Spark.
    const src = tier === 'full' ? url : { bytes: await mapBytes(url, { onProgress, keep: tier !== 'standard' }), fileName: file };
    if (this.dead) throw Object.assign(new Error('gone'), { name: 'AbortError' });
    const mesh = await this.splats.load(tier, src, { onProgress });
    this.tiers[tier] = true;
    this.loads[tier].splats = mesh.numSplats;
    this.loads[tier].done = true;
  }
  /** After the first file is live: the whole place (Lite) over a cut, then Standard on strong desktops or on request. */
  async _upgrade(first) {
    const { mode, params } = this.o;
    if (mode === 'frame' || mode === 'lift') return;       // the home keeps its one file
    const fade = REDUCED ? 0 : 700;
    if (first === 'cut') { await this._load('lite'); if (this.dead) return; this.splats.show('lite', { dur: fade, drop: ['cut'] }); delete this.tiers.cut; this.tier = 'lite'; this.emit('tier', { tier: 'lite' }); }
    // concept A: Lite only (the budget of the concept gate); never Standard or Full
  }
  /** Engineer sheet: 'lite' | 'standard' | 'full'. Resolves when it is on screen. */
  async setQuality(tier) {
    if (!this.splats || tier === this.tier || !PlaceEngine.FILES[tier]) return this.tier;
    await this._load(tier);
    if (this.dead) return this.tier;
    this.splats.show(tier, { dur: REDUCED ? 0 : 700, drop: ['cut', 'lite', 'standard', 'full'].filter(x => x !== tier) });
    for (const t of Object.keys(this.tiers)) if (t !== tier) delete this.tiers[t];
    this.tier = tier;
    this.emit('tier', { tier });
    return tier;
  }
  /** Engineer sheet: 'splats' | 'points' | 'both'. The point cloud loads on first use. */
  async setLayer(mode) {
    this.layerMode = mode;
    if (mode !== 'splats' && !this.points) {
      const [{ PointCloud }, { loadPointChunks }] = await Promise.all([import('/js/viewer/layers.js'), import('/js/viewer/assets.js')]);
      const id = this.place.id, meta = await mapJSON(asset(id, 'points.json', this.folder));
      if (this.dead) return;
      this.points = new PointCloud(meta, { pr: this.stage.drawScale });
      this.points.setScale({ ref: 12, fogNear: 30, fogFar: 300 });
      this.stage.world.add(this.points.object);
      this.stage.before.add(() => this.points?.setPixelRatio(this.stage.drawScale));
      this.loads.points = { loaded: 0, total: this.place.map?.files?.['points.bin'] || 0 };
      loadPointChunks(asset(id, 'points.bin', this.folder), meta, {
        onProgress: (l, t) => { this.loads.points = { loaded: l, total: t }; },
        onChunk: ch => { if (!this.dead) { this.points.addChunk(ch); this.stage.invalidate(); } },
      }).then(() => { this.loads.points.done = true; }).catch(e => console.warn('[place] points', e));
    }
    this.points?.setMode(this.layerMode === 'splats' ? 'off' : this.layerMode === 'both' ? 'both' : 'points');
    this.splats?.setOn(this.layerMode !== 'points');
    this.stage.invalidate();
  }
  showPath(on) { this.ribbon.mesh.visible = !!on; this.steps.setHidden(!on); this.stage.invalidate(); }

  /** Resolves true when the place has been sorted and drawn and the stage is at rest (false on a timeout). */
  _settle(max) {
    return new Promise(res => {
      const t0 = performance.now(), c0 = this.stage.renderCount;
      const iv = setInterval(() => {
        const ok = this.stage.renderCount >= c0 + 2 && this.settled;
        if (ok || this.dead || performance.now() - t0 > max) { clearInterval(iv); res(ok); }
      }, 80);
      this.stage.invalidate();
    });
  }
  get settled() {
    const st = this.stage, sp = st?.spark;
    return !!sp && !st.busy && !st._dirty && !sp.sorting && !sp.sortDirty && sp.activeSplats > 0;
  }
  /** A device that draws the place at under about 5 frames per second while the visitor moves it gets the still back. */
  _floor() {
    let slow = 0;
    this.stage.after.add(() => {
      if (this.dead || this._tooSlow) return;
      const f = this.stage.frames, n = f.length;
      if (n < 12 || !this._moving) { slow = 0; return; }
      let sum = 0;
      for (let i = n - 8; i < n; i++) sum += Math.min(1000, f[i][1]);
      if (sum / 8 > 190 && this.stage.drawScale <= this.stage.minScale + 0.02) slow++; else slow = Math.max(0, slow - 2);
      if (slow > 24) { this._tooSlow = true; this.emit('slow', {}); }
    });
  }

  // ------------------------------------------------------------------ per frame
  _fit() {
    const r = this.el.getBoundingClientRect(), w = Math.round(r.width), h = Math.round(r.height);
    if (!w || !h || this.dead) return;
    this.W = w; this.H = h;
    this.stage.resize(w, h);
    if (this._ov) this._overview(true);
  }
  /** The view's field of view for the box as it is now (radians): { v, h }. */
  fov() {
    const a = this.W / this.H, v = vfovFor(a, this.v0) * DEG;
    return { v, h: 2 * Math.atan(Math.tan(v / 2) * a) };
  }
  _before() {
    if (!this.W || !this.H) return;
    const cam = this.stage.camera, f = this.fov(), X = this.X;
    const base = this._fovNow ? this._fovNow * DEG : f.v;            // A: the dolly-zoom fov
    const v = X.w > 0 && X.fov ? base + (X.fov - base) * X.w : base;    // C: the page's field of view
    cam.fov = v / DEG; cam.aspect = this.W / this.H;
    cam.near = 0.08; cam.far = 4000;
    // the shift: the centre of the view sits right of the middle (the words of the page are on the left)
    const shift = (this.lift.shiftX + (this.o.shiftUp || 0) * smooth(this.S.above.k)) * (1 - X.w);   // F: none at a photo's own pose
    if (shift) cam.setViewOffset(this.W, this.H, -shift * this.W, 0, this.W, this.H);
    else if (cam.view) cam.clearViewOffset();
    cam.updateProjectionMatrix();
    if (X.sx || X.sy) {                                   // C: shift the picture (a photo's own centre, or room for the words)
      cam.projectionMatrix.elements[8] += X.sx; cam.projectionMatrix.elements[9] += X.sy;
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    }
    this.ribbon.uniforms.uViewH.value = this.H * this.stage.drawScale;
    this.ticks.uniforms.uViewH.value = this.H * this.stage.drawScale;
  }
  /** Advance the visitor-caused moves. Returns true while one is still running (the stage then draws another frame). */
  _tick() {
    const S = this.S, now = performance.now();
    const dt = clamp((now - (this._lastTick || now)) / 1000, 0, 0.25);
    this._lastTick = now;
    let more = false;
    if (S.riding) {
      const d = this.speed * (this.rideK || 1) * Math.min(0.25, (now - S.rideLast) / 1000);   // rideK: the visitor's speed choice
      S.rideLast = now;
      const to = clamp(S.at + S.rideDir * d, 0, this.total);
      S.walked += Math.abs(to - S.at);
      S.at = to;
      if (to <= 0 || to >= this.total) { this.ride(false); this.emit('end', { at: to }); } else more = true;
    }
    if (S.tw) {
      const k = S.tw.dur <= 0 ? 1 : clamp((now - S.tw.t0) / S.tw.dur, 0, 1), e = easeOut(k);
      S.at = S.tw.from + (S.tw.to - S.tw.from) * e;
      S.offRaw = S.tw.offFrom + (S.tw.offTo - S.tw.offFrom) * e;
      if (k >= 1) { const done = S.tw.done; S.tw = null; done?.(); } else more = true;
    }
    S.off = this.leash * Math.tanh(S.offRaw / this.leash);
    // the look follows its target fast; it lands exactly, so the stage can rest
    if (this.controls.step) more = this.controls.step(dt) || more;
    const k = dt >= 0.2 ? 1 : 1 - Math.exp(-dt * (this.mode === 'full' ? 22 : 7));
    S.yaw += (S.tyaw - S.yaw) * k; S.pitch += (S.tpitch - S.pitch) * k;
    if (Math.abs(S.tyaw - S.yaw) < 2e-4 && Math.abs(S.tpitch - S.pitch) < 2e-4) { S.yaw = S.tyaw; S.pitch = S.tpitch; } else more = true;
    const A = S.above, L = this.lift;
    if (L.frozen) { /* a test hook holds the lift still (window.__anim.at) */ }
    else if (A.tw) {
      const kk = A.tw.dur <= 0 ? 1 : clamp((now - A.tw.t0) / A.tw.dur, 0, 1);
      A.k = A.tw.from + (A.tw.to - A.tw.from) * easeInOut(kk);
      A.u = kk;
      if (kk >= 1) { const done = A.tw.done; A.tw = null; L.dropping = false; done?.(); this.emit('landed', { above: A.on }); } else more = true;
    } else if (L.spring != null && A.k !== L.spring) {
      // the scroll's target: a critically damped spring (it lands exactly and stops; no frames when it rests)
      const w = 7.5, x0 = A.k - L.spring, c = L.v + w * x0, e = Math.exp(-w * dt);
      const x = REDUCED || dt >= 0.2 ? 0 : (x0 + c * dt) * e;
      L.v = REDUCED || dt >= 0.2 ? 0 : (L.v - w * c * dt) * e;
      A.k = clamp(L.spring + x, 0, 1);
      if (Math.abs(x) < 3e-4 && Math.abs(L.v) < 3e-3) { A.k = L.spring; L.v = 0; } else more = true;
      const on = A.k > 0.5;
      if (on !== A.on) { A.on = on; this.steps.setAbove(on); this.emit('above', { on }); }
    }
    const P = this.P, kp = dt >= 0.2 ? 1 : 1 - Math.exp(-dt * 6);
    P.x += (P.tx - P.x) * kp; P.y += (P.ty - P.y) * kp;
    if (Math.abs(P.tx - P.x) < 1e-3 && Math.abs(P.ty - P.y) < 1e-3) { P.x = P.tx; P.y = P.ty; } else more = true;
    if (A.k > 0) {
      const ka = dt >= 0.2 ? 1 : 1 - Math.exp(-dt * 18);
      A.az += (A.taz - A.az) * ka; A.el += (A.tel - A.el) * ka;
      if (Math.abs(A.taz - A.az) < 2e-4 && Math.abs(A.tel - A.el) < 2e-4) { A.az = A.taz; A.el = A.tel; } else more = true;
    }
    this._moving = more;
    this._camera();
    return more;
  }
  /** The heading of the view on the ground (radians about +Y). */
  get viewYaw() { return this.track.yawAt(this.S.at) + this.S.yaw; }
  _groundPose(p, q) {
    const S = this.S, tr = this.track, tan = tr.tanAt(S.at);
    tr.pos(S.at, p);
    if (S.off) { p.x += -Math.cos(tan) * S.off; p.z += Math.sin(tan) * S.off; }     // left of the path = positive
    this._e.set(clamp(this.rest + S.pitch, -50 * DEG, 40 * DEG), this.viewYaw, 0, 'YXZ');
    q.setFromEuler(this._e);
  }
  _abovePose(p, q) {
    const A = this.S.above, O = this._ov;
    const d = O.dist * A.zoom, ce = Math.cos(A.el), se = Math.sin(A.el);
    p.set(O.c.x + Math.sin(A.az) * ce * d, O.c.y + se * d, O.c.z + Math.cos(A.az) * ce * d);
    this._m.lookAt(p, O.c, UP);
    q.setFromRotationMatrix(this._m);
  }
  /** Behind and above the eye: the end of the step back. Along the path when the view faces along it, else straight up. */
  _backPoint(B) {
    const S = this.S, tr = this.track, G = this._gp, c = Math.cos(this.viewYaw - tr.tanAt(S.at));
    if (Math.abs(c) > 0.7) {
      const sgn = c > 0 ? 1 : -1, a = clamp(S.at - sgn * 9, 0, this.total);
      tr.pos(a, B);
      if (Math.abs(a - S.at) < 4) { B.copy(G).addScaledVector(this._dir.set(-Math.sin(this.viewYaw), 0, -Math.cos(this.viewYaw)), -9); }
      B.y = Math.max(B.y, G.y) + 2.6;
    } else { B.copy(G); B.y += 3.4; }
    return B;
  }
  /** The view of the lift at k (0 = the eye on the path, 1 = the whole place from above), with the pointer's parallax. */
  _liftPose(k, p, q) {
    const S = this.S, L = this.lift, G = this._gp;
    const dir = this._dir.set(0, 0, -1).applyQuaternion(this._gq);
    const T0 = this._T0.copy(G).addScaledVector(dir, AHEAD), tgt = this._tgt;
    const f0 = this.fov().v / DEG;
    let fov = f0;
    if (k <= 0 || !this._ov) { p.copy(G); tgt.copy(T0); }
    else {
      const B = this._backPoint(this._B);
      const T = this._T0b || (this._T0b = new THREE.Vector3());
      T.copy(T0);
      const dollyFov = D => { const fd = 2 * Math.atan(Math.tan(f0 * DEG / 2) * AHEAD / Math.max(AHEAD, D)) / DEG; return f0 + (fd - f0) * 0.55; };
      if (k < KD) {
        p.lerpVectors(G, B, smooth(k / KD)); tgt.copy(T);
        if (L.dolly) fov = dollyFov(p.distanceTo(T));
      } else {
        const v = (k - KD) / (1 - KD), e = smooth(v);
        this._abovePose(this._ap, this._aq);
        const O = this._ap, H = Math.max(0, O.y - B.y);
        const P1 = this._p1.copy(B).addScaledVector(UP, 0.55 * H), P2 = this._p2.lerpVectors(O, P1, 0.3);
        const u = 1 - e;
        p.set(0, 0, 0).addScaledVector(B, u * u * u).addScaledVector(P1, 3 * u * u * e).addScaledVector(P2, 3 * u * e * e).addScaledVector(O, e * e * e);
        tgt.lerpVectors(T, this._ov.c, smooth(v / 0.85));
        if (L.dolly) { const fa = dollyFov(B.distanceTo(T)); fov = fa + (f0 - fa) * smooth(v); }
      }
    }
    // the pointer's parallax: a small orbit around the point the view holds still (0.4 m sideways at eye height)
    const P = this.P;
    if (P.x || P.y) {
      const rel = this._rel.subVectors(p, tgt);
      rel.applyAxisAngle(UP, P.x * (1.6 + 3.4 * k) * DEG);
      const ax = this._ax.crossVectors(UP, rel);
      if (ax.lengthSq() > 1e-8) rel.applyAxisAngle(ax.normalize(), P.y * (0.8 + 1.7 * k) * DEG);
      p.addVectors(tgt, rel);
    }
    this._m.lookAt(p, tgt, UP);
    q.setFromRotationMatrix(this._m);
    this._fovNow = fov;
  }
  _camera() {
    const cam = this.stage.camera, A = this.S.above;
    this._groundPose(this._gp, this._gq);
    this._liftPose(this._ov ? A.k : 0, cam.position, cam.quaternion);
    const X = this.X;
    if (X.w > 0) { cam.position.lerp(X.p, X.w); cam.quaternion.slerp(X.q, X.w); }     // C: the page's pose
    this._placeCone();
    this._placeEdits(this._ov ? A.k : 0);
    const dk = Math.max(A.k, X.dark || 0);
    if (dk !== this._bgK) {
      // concept A: the light backdrop goes to black as the camera leaves the ground (in sRGB, so mid-way is not a grey veil)
      this._bgK = dk;
      const f = 1 - smooth(dk / 0.4), o = {};
      this.sky.getRGB(o, THREE.SRGBColorSpace);
      this.stage.renderer.setClearColor(this._bg.setRGB(o.r * f, o.g * f, o.b * f, THREE.SRGBColorSpace), 1);
    }
    const u = this.ribbon.uniforms, above = A.k > 0.02 || X.all;
    u.uOpacity.value = X.ribbon;
    u.uAt.value = this.S.at;
    u.uBack.value = above ? 1e9 : 10; u.uAhead.value = above ? 1e9 : this.ride_ ? 90 : 45; u.uFar.value = above ? 1e9 : this.ride_ ? 110 : 48;
    u.uPx.value = this.stage.drawScale;
    u.uMinPx.value = (above ? 2.4 : 1.4) * this.stage.drawScale;
    u.uMaxPx.value = above ? 1e6 : clamp(0.0135 * (this.H || 800), 7, 12) * this.stage.drawScale;   // half the band's width near the eye
    // concept A: the path opens up as the camera rises (its window grows with k), so the whole line is there from above
    if (A.k > 0) { const w = smooth(A.k / 0.6); u.uBack.value = Math.max(u.uBack.value, 10 + w * 600); u.uAhead.value = Math.max(u.uAhead.value, 45 + w * 600); u.uFar.value = Math.max(u.uFar.value, 48 + w * 2000); }
    const t = this.ticks.uniforms;
    t.uAt.value = u.uAt.value; t.uBack.value = u.uBack.value; t.uAhead.value = u.uAhead.value; t.uFar.value = u.uFar.value;
    t.uPx.value = u.uPx.value; t.uMinPx.value = u.uMinPx.value; t.uMaxPx.value = Math.min(u.uMaxPx.value, 12 * this.stage.drawScale);
    // F: the live site's grammar (v3's rise): the camera's height above the visitor's eye decides the look. The splats
    // fade out (3 -> 13 m) and the measured points fade in (2 -> 11 m) as it climbs. No metre marks (o.marks false).
    if (this.o.pointsAbove) {
      const alt = cam.position.y - this._gp.y;
      const ks = 1 - smooth((alt - 3) / 10), kp = smooth((alt - 2) / 9);       // F: splats 3 -> 13 m, points 2 -> 11 m
      this._kSplat = ks; this._kPts = kp;
      for (const m of Object.values(this.splats?.meshes || {})) if (m.opacity !== ks) { m.opacity = ks; m.updateVersion?.(); }
      if (this.mp) { this.mp.uniforms.uOpacity.value = kp; this.mpts.holder.visible = kp > 0.004; }
    }
    if (this.o.marks === false && t.uOpacity) t.uOpacity.value = 0;
    if (X.route) {                                        // F: the page draws the path's window (it grows from one spot)
      u.uBack.value = X.route.back; u.uAhead.value = X.route.ahead; u.uFar.value = X.route.far ?? (Math.max(X.route.back, X.route.ahead) + 60);
      if (X.route.minPx) u.uMinPx.value = X.route.minPx * this.stage.drawScale;
      if (X.route.maxPx) u.uMaxPx.value = X.route.maxPx * this.stage.drawScale;
      t.uBack.value = u.uBack.value; t.uAhead.value = u.uAhead.value; t.uFar.value = u.uFar.value;
    }
    // F: the first screen's walk goes round the loop (home.js closes it: the line's last metres bend onto its start)
    const lp = X.loop;
    u.uLoopK.value = lp ? lp.k : 0;
    if (lp) { u.uLoop.value = lp.len; u.uSeamLen.value = lp.seamLen; u.uSeam.value.set(lp.seam[0], lp.seam[1], lp.seam[2]); }
    // which way is "forward" for the visitor: along the path, on the side the view faces (with a little hysteresis)
    const c = Math.cos(this.viewYaw - this.track.tanAt(this.S.at));
    if (c > 0.17) this.S.facing = 1; else if (c < -0.17) this.S.facing = -1;
  }
  /** World point -> CSS pixels in the box. Returns false when the point is behind the camera. */
  project(v, out) {
    const cam = this.stage.camera, q = this._v4.set(v.x, v.y, v.z, 1).applyMatrix4(cam.matrixWorldInverse).applyMatrix4(cam.projectionMatrix);
    if (q.w <= 0.02) return false;
    out.x = (q.x / q.w + 1) / 2 * this.W; out.y = (1 - q.y / q.w) / 2 * this.H;
    return true;
  }
  _after() {
    if (this.dead) return;
    const S = this.S, cam = this.stage.camera;
    cam.updateMatrixWorld(); cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    this.steps.place(this);
    this._placeLabels();
    const p = cam.position, xy = this.fit.xy(this._gp.x, this._gp.z);
    const heading = this.fit.ok ? this.fit.deg(this.viewYaw) : null;
    const key = `${S.at.toFixed(2)}|${S.off.toFixed(2)}|${this.viewYaw.toFixed(3)}|${S.pitch.toFixed(3)}|${S.above.k.toFixed(2)}|${p.x.toFixed(2)}`;
    if (key !== this._lastPose) {
      this._lastPose = key;
      this.emit('pose', {
        at: S.at, total: this.total, heading, x: this.fit.ok ? xy[0] : null, y: this.fit.ok ? xy[1] : null,
        look: (this.viewYaw - this.track.tanAt(S.at)) / DEG, pitch: (this.rest + S.pitch) / DEG, off: S.off, facing: S.facing,
        above: S.above.on, riding: S.riding, walked: S.walked, lift: S.above.k,
      });
      this._photo();
      const show = Math.abs(S.off) > 0.3;
      if (show !== this._offShown) { this._offShown = show; this.emit('offpath', { off: S.off, show }); }
    }
  }
  _nearestPhoto(at) {
    let best = null, d = Infinity;
    for (const k of this.photos) { const e = Math.abs(k.at - at); if (e < d) { d = e; best = k; } }
    return best;
  }
  /** The real camera photo of the current spot. exact = the visitor stands at that photo's own camera position. */
  _photo() {
    const k = this._nearestPhoto(this.S.at);
    if (!k) return;
    const exact = Math.abs(k.at - this.S.at) < 0.3 && Math.abs(this.S.off) < 0.25;
    const key = `${k.i}|${exact}`;
    if (key === this._photoKey) return;
    this._photoKey = key;
    this.emit('photo', { src: k.src, exact, at: k.at, kf: k.i, t: k.t });
  }

  // ------------------------------------------------------------------ the visitor's moves (public)
  get at() { return this.S.at; }
  get heading() { const y = this.track.yawAt(this.S.tw ? this.S.tw.to : this.S.at) + this.S.tyaw; return this.fit.ok ? this.fit.deg(y) : y / DEG; }
  /** Turn the view. dx: radians to the LEFT; dy: radians UP. */
  lookBy(dx, dy, { first = true } = {}) {
    const S = this.S;
    if (S.above.on) { S.above.taz += dx; S.above.tel = clamp(S.above.tel - dy, 25 * DEG, 85 * DEG); }
    else { S.tyaw += dx; S.tpitch = clamp(S.tpitch + dy, -38 * DEG - this.rest, 32 * DEG - this.rest); }
    if (first) this._firstLook();
    this.stage.invalidate();
  }
  /** Set the look targets (controls use this during a drag). */
  lookTo(yaw, pitch) {
    this.S.tyaw = yaw; this.S.tpitch = clamp(pitch, -38 * DEG - this.rest, 32 * DEG - this.rest);
    this.stage.invalidate();
  }
  _firstLook() { if (!this.S.firstLook && this.live) { this.S.firstLook = true; this.emit('first-look', {}); } }
  _firstStep(moved) {
    if (this.S.firstStep || !this.live) return;
    this.S.firstStep = true;
    this.emit('first-step', { moved: Math.abs(moved), at: this.S.tw ? this.S.tw.to : this.S.at, total: this.total });
  }
  /** Walk `metres` along the camera's path (+ = towards its end). An eased move of about 300 ms; instant with reduced motion. */
  stepBy(metres, { dur = 300 } = {}) {
    const S = this.S;
    if (S.above.on) return;
    const from = S.at, base = S.tw ? S.tw.to : S.at, to = clamp(base + metres, 0, this.total);
    if (Math.abs(to - from) < 0.01) { this.emit('end', { at: to }); return; }
    S.walked += Math.abs(to - base);
    S.tw = { from, to, t0: performance.now(), dur: REDUCED ? 0 : dur, offFrom: S.offRaw, offTo: S.offRaw };
    this._firstStep(to - base);
    this.stage.invalidate();
  }
  /** Step in the direction the view faces (the arrow keys, the pad): n steps forward (+) or back (-). */
  walk(n) { this.stepBy(n * this.step * this.S.facing); }
  /** Move freely by `fwd` metres along the view and `right` metres sideways; the path holds the visitor on a soft leash. */
  moveBy(fwd, right = 0) {
    const S = this.S;
    if (S.above.on) { S.above.zoom = clamp(S.above.zoom * Math.exp(-fwd * 0.08), 0.35, 2.2); this.stage.invalidate(); return; }
    const phi = this.viewYaw - this.track.tanAt(S.at);
    const ds = fwd * Math.cos(phi) + right * Math.sin(phi), dl = fwd * Math.sin(phi) - right * Math.cos(phi);
    S.tw = null;
    S.at = clamp(S.at + ds, 0, this.total);
    S.offRaw = clamp(S.offRaw + dl, -this.leash * 2.2, this.leash * 2.2);
    S.walked += Math.abs(ds);
    this._firstStep(ds);
    this.stage.invalidate();
  }
  /** Back onto the camera's path (the "Back to the camera's path" button). */
  toPath() {
    const S = this.S;
    S.tw = { from: S.at, to: S.at, t0: performance.now(), dur: REDUCED ? 0 : 350, offFrom: S.offRaw, offTo: 0 };
    this.stage.invalidate();
  }
  /**
   * Go to a point of the path: { at: metres } or { kf: index of a real photo }. A short way: a glide along the path.
   * A long way: the picture dips to black, the visitor is there. In the view from above: a glide down to that point.
   */
  goTo(to, { instant = false } = {}) {
    const S = this.S;
    let at = to?.kf != null ? this.photos[to.kf]?.at : to?.at;
    if (at == null || !Number.isFinite(+at)) return false;
    at = clamp(+at, 0, this.total);
    if (this.mode === 'frame' && !this.covers(at)) { this.emit('enter', { at }); return false; }   // the file on screen ends before that point
    const near = this._nearestPhoto(at);
    if (near && Math.abs(near.at - at) <= 0.6) at = near.at;
    this.ride(false);
    const d = Math.abs(at - S.at);
    S.walked += d;
    if (S.above.on) { S.tw = null; S.at = at; S.offRaw = 0; S.tpitch = S.pitch = 0; this._faceOverview(); this.above(false); this._firstStep(d); this.emit('drop', { at }); return true; }
    if (instant || REDUCED || d < 0.05) { S.tw = null; S.at = at; S.offRaw = 0; this.stage.invalidate(); }
    else if (d <= this.step * 10) {
      S.tw = { from: S.at, to: at, t0: performance.now(), dur: clamp(d / this.step * 140, 300, 1100), offFrom: S.offRaw, offTo: 0 };
      this.stage.invalidate();
    } else this._dip(() => { S.tw = null; S.at = at; S.offRaw = 0; });
    this._firstStep(d);
    return true;
  }
  /** A long jump: the canvas dips to black, the pose changes, the picture comes back once it is drawn. */
  _dip(change) {
    const c = this.canvas;
    c.style.transition = 'opacity .14s linear'; c.style.opacity = '0';
    clearTimeout(this._dipT);
    this._dipT = setTimeout(() => {
      change();
      this.stage.invalidate();
      const back = () => { c.style.opacity = '1'; };
      this._settle(this.o.soft ? 6000 : 900).then(back);
    }, 150);
  }
  /** The ride: glide along the path at about the recorded speed while `on` is true. It stops at the ends of the path. */
  ride(on) {
    const S = this.S;
    on = !!on && !S.above.on && this.live;
    if (S.riding === on) return on;
    if (on) {
      if ((S.facing > 0 && S.at >= this.total - 0.01) || (S.facing < 0 && S.at <= 0.01)) { this.emit('end', { at: S.at }); return false; }
      S.tw = null; S.rideDir = S.facing; S.rideLast = performance.now();
      this._firstStep(0.001);
    }
    S.riding = on;
    this.emit('ride', { on });
    this.stage.invalidate();
    return on;
  }
  /** The whole path from above (on) and back to the ground (off). */
  above(on) {
    const A = this.S.above;
    on = !!on;
    if (A.on === on) return;
    this.ride(false);
    A.on = on;
    if (on) { this._overview(false); this.lift.spring = null; }
    this.lift.dropping = !on;
    A.tw = { from: A.k, to: on ? 1 : 0, t0: performance.now(), dur: REDUCED ? 0 : on ? 1300 : (this.o.dropMs || 1600) };
    this.steps.setAbove(on);
    this.emit('above', { on });
    this.stage.invalidate();
  }
  /** The overview pose: the whole path fits the box. keep: keep the visitor's turn of the overview (a resize). */
  _overview(keep) {
    const tr = this.track, n = tr.n, A = this.S.above;
    let mx = 0, mz = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += tr.GX[i]; mz += tr.GZ[i]; my += tr.GY[i]; }
    mx /= n; mz /= n; my /= n;
    let cxx = 0, cxz = 0, czz = 0;
    for (let i = 0; i < n; i++) { const dx = tr.GX[i] - mx, dz = tr.GZ[i] - mz; cxx += dx * dx; cxz += dx * dz; czz += dz * dz; }
    const th = 0.5 * Math.atan2(2 * cxz, cxx - czz), ax = Math.cos(th), az = Math.sin(th);      // the path's long axis on the ground
    let l0 = Infinity, l1 = -Infinity, w0 = Infinity, w1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const dx = tr.GX[i] - mx, dz = tr.GZ[i] - mz, l = dx * ax + dz * az, w = -dx * az + dz * ax;
      l0 = Math.min(l0, l); l1 = Math.max(l1, l); w0 = Math.min(w0, w); w1 = Math.max(w1, w);
    }
    const L = Math.max(6, l1 - l0), Wd = Math.max(6, w1 - w0), lc = (l0 + l1) / 2, wc = (w0 + w1) / 2;
    const c = new THREE.Vector3(mx + ax * lc - az * wc, my, mz + az * lc + ax * wc);
    const f = this.fov(), el = this.lift.el, th2 = Math.tan(f.h / 2) * (1 - 1.6 * (this.lift.shiftX + (this.o.shiftUp || 0))), tv2 = Math.tan(f.v / 2), se = Math.sin(el);
    const dA = Math.max(L * 1.2 / (2 * th2), Wd * se * 1.5 / (2 * tv2), 14);      // the long axis across the screen
    const dB = Math.max(Wd * 1.25 / (2 * th2), L * se * 1.5 / (2 * tv2), 14);     // the long axis up the screen
    const across = dA <= dB;
    // the camera sits behind the visitor's own view direction, so "ahead" stays up on the screen
    let dir = across ? [-az, ax] : [ax, az];                                       // the horizontal view direction
    const vy = this.viewYaw, vd = [-Math.sin(vy), -Math.cos(vy)];
    if (dir[0] * vd[0] + dir[1] * vd[1] < 0) dir = [-dir[0], -dir[1]];
    this._ov = { c, dist: (across ? dA : dB) * (this.o.ovMargin || 1) };
    if (!keep) { A.az = A.taz = Math.atan2(-dir[0], -dir[1]); A.el = A.tel = el; A.zoom = 1; }
  }
  /**
   * The point of the path under a pointer: { at, x, y, d } (d = pixels from the pointer) or null. On the ground only the
   * stretch of path that is drawn counts; from above, the whole path.
   */
  pickPath(px, py, maxPx = 26) {
    // F: the page may hold the camera above the place (the pull-back): then the whole line is a door, as in the lift
    const tr = this.track, S = this.S, v = this._v, o = { x: 0, y: 0 };
    const above = S.above.k > 0.5 || (this.X?.w > 0.5 && (this.X.dark || 0) > 0.5);
    const a0 = above ? 0 : Math.max(0, S.at - 9), a1 = above ? this.total : Math.min(this.total, S.at + (this.ride_ ? 80 : 50));
    const stepM = above ? Math.max(0.5, this.total / 600) : 0.5;
    let best = null;
    for (let a = a0; a <= a1; a += stepM) {
      tr.ground(a, v);
      if (!this.project(v, o)) continue;
      const d = Math.hypot(o.x - px, o.y - py);
      if (d < maxPx && (!best || d < best.d)) best = { at: a, x: o.x, y: o.y, d };
    }
    if (best && !above && Math.abs(best.at - S.at) < 1.2) return null;
    return best;
  }
  /** A tap or click on a stepping circle (how: 'pointer' | 'key'). */
  _circle(at) {
    if (this.mode === 'frame') { this.emit('enter', { at }); return; }
    const S = this.S, d = at - (S.tw ? S.tw.to : S.at);
    this.ride(false);
    S.walked += Math.abs(d);
    S.tw = { from: S.at, to: clamp(at, 0, this.total), t0: performance.now(), dur: REDUCED ? 0 : clamp(Math.abs(at - S.at) / this.step * 170, 300, 700), offFrom: S.offRaw, offTo: 0 };
    this._firstStep(d);
    this.stage.invalidate();
  }
  /** A tap or click on the picture (not a drag). */
  tap(px, py) {
    if (this.onTap?.(px, py)) return;                    // C: a photo frame took the tap
    const hit = this.pickPath(px, py, 30);
    if (this.mode === 'frame' || this.mode === 'lift') {
      // F: from above, a click off the line opens nothing (only the line is a door); at eye height, as before
      const fromAbove = this.X?.w > 0.5 && (this.X.dark || 0) > 0.5;
      if (fromAbove && !hit) return;
      this.emit('enter', { at: hit ? hit.at : this.S.at, above: this.S.above.k > 0.5 || fromAbove }); return;
    }
    if (hit) this.goTo({ at: hit.at });
    else if (this.S.above.k < 0.02) this.walkToGround(px, py);
  }
  setOffscreen(off) { this.stage?.setOff(off); }

  // ------------------------------------------------------------------ concept A: the lift, the parallax, the cone, the marks
  /** The scroll's lift target, 0 (eye height) .. 1 (the whole place from above). The view follows with a spring. */
  setLift(k) {
    const L = this.lift, A = this.S.above;
    if (A.tw || L.frozen) return;
    L.spring = clamp(k, 0, 1);
    this.stage.invalidate();
  }
  /** The pointer, -1 .. 1 in x and y. The camera orbits a little around the point it looks at. Off with reduced motion. */
  setPar(x, y) {
    if (REDUCED) return;
    this.P.tx = clamp(x, -1, 1); this.P.ty = clamp(y, -1, 1);
    this.stage.invalidate();
  }
  /** The drop is running: any input of the visitor ends it at once (it lands). */
  skipDrop() {
    const A = this.S.above;
    if (!this.lift.dropping || !A.tw) return false;
    A.tw.t0 = -1e9;
    this.stage.invalidate();
    return true;
  }
  /** TEST: hold the lift at k (no spring, no tween). null releases it. */
  freeze(k) {
    const L = this.lift, A = this.S.above;
    if (k == null) { L.frozen = false; this.stage.invalidate(); return; }
    L.frozen = true; A.tw = null; L.spring = null; A.k = clamp(k, 0, 1);
    this.stage.invalidate();
  }
  /** From above, the landing view faces along the path in the direction that is "up" on the screen (no half turn). */
  _faceOverview() {
    const S = this.S, A = S.above, y = this.track.yawAt(S.at);
    const c = Math.cos(y - A.taz);
    S.tyaw = S.yaw = c < 0 ? Math.PI : 0;
  }
  /** The bubble around the camera and the fade of the tree tops (both identity at k 0). */
  _makeEdits() {
    const tr = this.track;
    let gy = 0; for (let i = 0; i < tr.n; i++) gy += tr.GY[i]; gy /= tr.n;
    const bubble = new SplatEdit({ name: 'bubble around the camera', rgbaBlendMode: 'multiply', softEdge: 2.0 });
    const sphere = new SplatEditSdf({ type: 'sphere', radius: 0, opacity: 1 });
    bubble.addSdf(sphere);
    const cut = (name, y, soft) => {
      const e = new SplatEdit({ name, rgbaBlendMode: 'multiply', softEdge: soft });
      const p = new SplatEditSdf({ type: 'plane', opacity: 1 });
      p.rotation.x = Math.PI / 2;                         // the plane's +z = world down: "inside" = above the cut
      p.position.set(0, y, 0);
      e.addSdf(p);
      this.stage.scene.add(e);
      return p;
    };
    const plane = cut('tree tops from above', gy + (this.o.cutH ?? 4.2), 3.0);
    const sky = cut('the soft splats over the trees', gy + 11, 4.0);
    // the island: a soft box round the path's footprint; from above, what lies outside it fades into the dark
    let mx = 0, mz = 0; for (let i = 0; i < tr.n; i++) { mx += tr.GX[i]; mz += tr.GZ[i]; } mx /= tr.n; mz /= tr.n;
    let cxx = 0, cxz = 0, czz = 0;
    for (let i = 0; i < tr.n; i++) { const dx = tr.GX[i] - mx, dz = tr.GZ[i] - mz; cxx += dx * dx; cxz += dx * dz; czz += dz * dz; }
    const th = 0.5 * Math.atan2(2 * cxz, cxx - czz), ax = Math.cos(th), az = Math.sin(th);
    let l0 = Infinity, l1 = -Infinity, w0 = Infinity, w1 = -Infinity;
    for (let i = 0; i < tr.n; i++) { const dx = tr.GX[i] - mx, dz = tr.GZ[i] - mz, l = dx * ax + dz * az, w = -dx * az + dz * ax; l0 = Math.min(l0, l); l1 = Math.max(l1, l); w0 = Math.min(w0, w); w1 = Math.max(w1, w); }
    const lc = (l0 + l1) / 2, wc = (w0 + w1) / 2, M = this.o.islandM ?? 13;
    const isle = new SplatEdit({ name: 'the island round the path', rgbaBlendMode: 'multiply', softEdge: 12 });
    const box = new SplatEditSdf({ type: 'box', opacity: 1, invert: true, radius: 6 });
    box.position.set(mx + ax * lc - az * wc, gy, mz + az * lc + ax * wc);
    box.rotation.y = -th;
    box.scale.set((l1 - l0) / 2 + M, 60, (w1 - w0) / 2 + M);
    isle.addSdf(box);
    this.stage.scene.add(bubble, isle);
    this.edits = { sphere, plane, sky, box, gy, last: '' };
  }
  _placeEdits(k) {
    const E = this.edits;
    if (!E) return;
    const cam = this.stage.camera.position, h = cam.y - E.gy;
    const r = k > 0 ? clamp(0.85 * h - 0.5, 0, 80) * smooth(k / 0.06) : 0;
    // by the camera's height above the ground: under the trees nothing changes; above them the tops become a ghost
    const topA = k > 0 ? 1 - 0.86 * smooth((h - 4.4) / 6) : 1, skyA = k > 0 ? 1 - smooth((h - 4.2) / 5) : 1;
    const isleA = k > 0 ? 1 - 0.9 * smooth((h - 6) / 18) : 1;
    const dim = 1 - 0.22 * smooth((k - 0.35) / 0.5);
    const key = `${r.toFixed(2)}|${cam.x.toFixed(2)}|${cam.y.toFixed(2)}|${cam.z.toFixed(2)}|${topA.toFixed(3)}|${skyA.toFixed(3)}|${isleA.toFixed(3)}|${dim.toFixed(3)}|${Object.keys(this.splats?.meshes || {}).length}`;
    if (key === E.last) return;
    E.last = key;
    E.sphere.position.copy(cam); E.sphere.radius = r; E.sphere.opacity = r > 0.05 ? 0 : 1;
    E.plane.opacity = topA; E.sky.opacity = skyA; E.box.opacity = isleA;
    for (const m of Object.values(this.splats?.meshes || {})) if (m.recolor) m.recolor.setScalar(dim);
  }
  _makeCone() {
    const hw = 0.45, hh = 0.28, d = 0.7;
    const V = [0, 0, 0, -hw, hh, -d, hw, hh, -d, hw, -hh, -d, -hw, -hh, -d];
    const eg = new THREE.BufferGeometry();
    const E = [1, 2, 2, 3, 3, 4, 4, 1];
    eg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(E.flatMap(i => V.slice(i * 3, i * 3 + 3))), 3));
    const fg = new THREE.BufferGeometry();
    const F = [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 1, 1, 2, 3, 1, 3, 4];
    fg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(F.flatMap(i => V.slice(i * 3, i * 3 + 3))), 3));
    const acc = new THREE.Color(this.o.accent || '#6fc7b0');            // F: the page's accent
    const lm = new THREE.LineBasicMaterial({ color: 0xf3f5f6, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false });
    const fm = new THREE.MeshBasicMaterial({ color: acc, transparent: true, opacity: 0.24, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    const cone = new THREE.Group();
    cone.add(new THREE.Mesh(fg, fm), new THREE.LineSegments(eg, lm));
    cone.children.forEach(c => { c.renderOrder = 33; c.frustumCulled = false; });
    cone.name = 'where the visitor stands';
    // a hairline from the eye down to the ground, and a small ring on the ground
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const stem = new THREE.Line(sg, new THREE.LineBasicMaterial({ color: 0xf3f5f6, transparent: true, opacity: 0.7, depthTest: false, depthWrite: false }));
    const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 40 }, (_, i) => new THREE.Vector3(Math.cos(i / 40 * Math.PI * 2) * 0.5, 0, Math.sin(i / 40 * Math.PI * 2) * 0.5))),
      new THREE.LineBasicMaterial({ color: acc, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false }));
    [stem, ring].forEach(c => { c.renderOrder = 33; c.frustumCulled = false; });
    this.cone = { group: cone, stem, ring, mats: [lm, fm, stem.material, ring.material], base: [0.85, 0.24, 0.7, 0.95] };
    this.stage.scene.add(cone, stem, ring);
  }
  _placeCone() {
    const C = this.cone, cam = this.stage.camera, G = this._gp;
    if (!C || !C.group) return;
    const d = cam.position.distanceTo(G), a = smooth((d - 1.2) / 3) * (1 - (this.X?.w || 0));   // F: not while the page holds the camera
    const show = a > 0.01 && this.o.cone !== false;
    C.group.visible = C.stem.visible = C.ring.visible = show;
    if (!show) return;
    const s = clamp(d / 22, 0.6, 40);
    C.group.position.copy(G); C.group.quaternion.copy(this._gq); C.group.scale.setScalar(s);
    const foot = this.track.ground(this.S.at, this._foot);
    const tan = this.track.tanAt(this.S.at);
    if (this.S.off) { foot.x += -Math.cos(tan) * this.S.off; foot.z += Math.sin(tan) * this.S.off; }
    const pa = C.stem.geometry.attributes.position;
    pa.setXYZ(0, G.x, G.y, G.z); pa.setXYZ(1, foot.x, foot.y, foot.z); pa.needsUpdate = true;
    C.ring.position.copy(foot); C.ring.scale.setScalar(s * 0.8);
    C.mats.forEach((m, i) => { m.opacity = C.base[i] * a; });
  }
  _makeLabels() {
    const lay = this.o.layer;
    const mk = (cls, txt) => { const e = document.createElement('span'); e.className = cls; e.textContent = txt; e.hidden = true; e.setAttribute('aria-hidden', 'true'); lay.appendChild(e); return e; };
    const g0 = new THREE.Vector3(), g1 = new THREE.Vector3();
    this.track.ground(0, g0); this.track.ground(this.total, g1);
    const closed = g0.distanceTo(g1) < 12;                 // a loop: the start and the end are one spot, so one label
    this.mlabs = closed ? [{ m: 0, el: mk('a-mlab a-mlab--end', `0 m · ${fmtLen(this.total)}`) }]
      : [{ m: this.total, el: mk('a-mlab a-mlab--end', fmtLen(this.total)) }, { m: 0, el: mk('a-mlab a-mlab--end', '0 m') }];
    this.mlabs.push(...this.ticks.marks.filter(m => m > 0 && m < this.total - 15 && Math.abs(m / 50 - Math.round(m / 50)) < 1e-6)
      .map(m => ({ m, el: mk('a-mlab', fmtLen(m)) })));
    this.mlabs.forEach(L => { L.w = 7.5 * L.el.textContent.length + 22; });
    this.youEl = mk('a-you', this.o.youLabel || 'You stand here');
  }
  setYouLabel(t) { if (this.youEl) this.youEl.textContent = t; this.o.youLabel = t; this.stage?.invalidate(); }
  /** F: the depth points our software measured (points.bin prefix; any prefix is a uniform subsample). Hidden until the
   *  camera climbs (o.pointsAbove). */
  async loadMeasured(n = this.o.soft ? 200000 : this.params?.phone ? 150000 : 450000) {
    if (this.mpts || this._mptsLoading) return;
    this._mptsLoading = true;
    const id = this.place.id, meta = await mapJSON(asset(id, 'points.json', this.folder));
    const data = await loadPointPrefix(asset(id, 'points.bin', this.folder), meta, n);
    if (this.dead) return;
    const mat = this.mp = makePointsMaterial(meta, { size: 0.03, minPx: 1.0, maxPx: 2.4, gain: 1.3, near: 0.35, rgb: data.rgb });
    const u = mat.uniforms;
    u.uR.value = -1e4; u.uOpacity.value = 0;              // every dot is a point (no growth front); shown by height
    const P = this.mpts = makePoints(meta, data, mat);
    P.pts.renderOrder = 5;
    P.holder.visible = false;
    this.stage.world.add(P.holder);
    this.stage.before.add(() => { u.uPR.value = this.stage.drawScale; u.uViewH.value = (this.H || 800) * this.stage.drawScale; });
    this.measured = { n: data.n, of: meta.count };
    this._camera(); this.stage.invalidate();
  }
  _placeLabels() {
    if (!this.mlabs) return;
    const k = this.S.above.k, a = smooth((k - 0.42) / 0.25), o = { x: 0, y: 0 }, g = this._v;
    const box = this.o.layer.getBoundingClientRect(), taken = [];
    if (a > 0.01) for (const c of document.querySelectorAll('.a-cap, .o-card')) {
      const r = c.getBoundingClientRect(), cs = getComputedStyle(c);
      if (r.width && cs.visibility !== 'hidden' && +cs.opacity > 0.05) taken.push({ x0: r.left - box.left - 6, x1: r.right - box.left + 6, y0: r.top - box.top - 6, y1: r.bottom - box.top + 6 });
    }
    for (const L of this.mlabs) {
      let show = a > 0.01 && this.o.marks !== false;
      if (show) { this.track.ground(L.m, g); show = this.project(g, o) && o.x > 8 && o.x < this.W - 8 && o.y > 8 && o.y < this.H - 8; }
      if (show) {
        const r = { x0: o.x + 8, x1: o.x + 10 + L.w, y0: o.y - 11, y1: o.y + 13 };
        show = !taken.some(t => r.x0 < t.x1 && r.x1 > t.x0 && r.y0 < t.y1 && r.y1 > t.y0);
        if (show) taken.push(r);
      }
      if (!show) { if (!L.el.hidden) L.el.hidden = true; continue; }
      if (L.el.hidden) L.el.hidden = false;
      L.el.style.opacity = a.toFixed(3);
      L.el.style.transform = `translate(${o.x.toFixed(1)}px, ${o.y.toFixed(1)}px)`;
    }
    const C = this.cone, y = this.youEl;
    const cy = C && C.group.visible && this.o.youLabel !== '' && k > 0.08 && this.project(this._gp, o) && o.x > 8 && o.x < this.W - 8 && o.y > 30 && o.y < this.H - 8;
    if (!cy) { if (!y.hidden) y.hidden = true; }
    else { if (y.hidden) y.hidden = false; y.style.opacity = smooth((k - 0.08) / 0.12).toFixed(3); y.style.transform = `translate(${o.x.toFixed(1)}px, ${o.y.toFixed(1)}px)`; }
  }
  /** The point of the ground under a pointer near the visitor: { p: Vector3, d: metres from the visitor's feet } or null. */
  groundAt(px, py) {
    if (this.S.above.k > 0.02 || !this.W) return null;
    const cam = this.stage.camera, ndc = new THREE.Vector2((px / this.W) * 2 - 1, -(py / this.H) * 2 + 1);
    const rc = this._rc || (this._rc = new THREE.Raycaster());
    rc.setFromCamera(ndc, cam);
    const foot = this.track.ground(this.S.at, new THREE.Vector3());
    const plane = new THREE.Plane(UP.clone(), -foot.y), hitP = new THREE.Vector3();
    if (!rc.ray.intersectPlane(plane, hitP)) return null;
    const d = Math.hypot(hitP.x - cam.position.x, hitP.z - cam.position.z);
    if (d < 1.2 || d > 16) return null;                 // far away the ground plane may lie behind trees: no ring
    return { p: hitP, d };
  }
  /** A click on the ground: walk to the point of the path nearest to it, a little to the side when the click was beside it. */
  walkToGround(px, py) {
    const h = this.groundAt(px, py);
    if (!h) return false;
    const tr = this.track, S = this.S, g = new THREE.Vector3();
    let best = null;
    for (let a = Math.max(0, S.at - 45); a <= Math.min(this.total, S.at + 45); a += 0.5) {
      tr.ground(a, g);
      const dd = Math.hypot(g.x - h.p.x, g.z - h.p.z);
      if (!best || dd < best.d) best = { a, d: dd };
    }
    if (!best) return false;
    tr.ground(best.a, g);
    const tan = tr.tanAt(best.a), lx = -Math.cos(tan), lz = Math.sin(tan);
    const side = clamp((h.p.x - g.x) * lx + (h.p.z - g.z) * lz, -1.5, 1.5);
    this.ride(false);
    S.walked += Math.abs(best.a - S.at);
    S.tw = { from: S.at, to: best.a, t0: performance.now(), dur: REDUCED ? 0 : clamp(Math.abs(best.a - S.at) * 90, 300, 1000), offFrom: S.offRaw, offTo: side };
    this._firstStep(best.a - S.at);
    this.stage.invalidate();
    return true;
  }
  info() {
    const st = this.stage;
    return { tier: this.tier, splats: this.splats?.numSplats || 0, points: this.points?.n || 0, scale: st.drawScale, frames: st.renderCount,
      t: this.track.timeAt(this.S.at), kf: this.track.nearest(this.S.at) + 1, kfs: this.track.n, loads: this.loads, gpu: st.info().gpu };
  }

  destroy() {
    if (this.dead) return;
    this.dead = true;
    clearTimeout(this._dipT);
    this._ro?.disconnect();
    this.controls?.detach();
    this.steps?.destroy();
    try { this.ribbon?.dispose(); this.ticks?.dispose(); this.points?.dispose(); this.splats?.dispose(); } catch (e) { /* already gone */ }
    this.mlabs?.forEach(L => L.el.remove()); this.youEl?.remove();
    const st = this.stage;
    if (st) {
      st.setOff(true);
      try { st.spark?.dispose(); st.renderer.dispose(); if (!st.lost && !st.gl.isContextLost()) st.gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch (e) { /* already gone */ }
    }
  }
}
