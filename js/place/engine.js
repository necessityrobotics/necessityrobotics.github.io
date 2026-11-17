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
import { Stage } from '../viewer/scene.js';
import { SplatLayer } from '../viewer/layers.js';
import { mapBytes, mapJSON } from '../viewer/assets.js';
import { asset } from '../config.js';
import { getJSON, siteUrl, REDUCED } from '../v4/common.js';
import { PathTrack, fitRoute, makeRibbon } from './path.js';
import { StepCircles } from './steps.js';
import { attachFull, attachFrame } from './controls.js';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const DEG = Math.PI / 180;
const easeOut = k => 1 - Math.pow(1 - k, 3);
const easeInOut = k => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const UP = new THREE.Vector3(0, 1, 0);

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
    this.dev = { on: false, yaw: 0, pitch: 0 };              // look with your phone (setDeviceLook)
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
  }

  // ------------------------------------------------------------------ start
  async start() {
    const { place, mode, params, canvas } = this.o, id = place.id;
    const needCut = mode === 'frame' || params.phone;
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

    this.ribbon = makeRibbon(track, { width: this.ride_ ? 0.16 : 0.12 });   // a narrow band: the ground it lies on stays in view
    stage.scene.add(this.ribbon.mesh);
    this.steps = new StepCircles(this.o.layer, {
      mode, label: this.o.stepLabel, step: this.step,
      onPick: (atPick, how) => this._circle(atPick, how),
    });
    this.controls = mode === 'frame' ? attachFrame(this) : attachFull(this);
    stage.hooks.add(() => this._tick());
    stage.before.add(() => this._before());
    stage.after.add(() => this._after());
    this._ro = new ResizeObserver(() => this._fit());
    this._ro.observe(this.el);
    this._fit();
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
    if (mode === 'frame') return;                          // the home frame keeps its one file
    const fade = REDUCED ? 0 : 700;
    if (first === 'cut') { await this._load('lite'); if (this.dead) return; this.splats.show('lite', { dur: fade, drop: ['cut'] }); delete this.tiers.cut; this.tier = 'lite'; this.emit('tier', { tier: 'lite' }); }
    const want = this.o.quality || (params.splatTiers.includes('standard') && !this.o.soft ? 'standard' : 'lite');
    if (want === 'standard' && this.place.map?.files?.['splats.spz']) await this.setQuality('standard');
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
      const [{ PointCloud }, { loadPointChunks }] = await Promise.all([import('../viewer/layers.js'), import('../viewer/assets.js')]);
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
    if (this.S.above.on) this._overview(true);
  }
  /** The view's field of view for the box as it is now (radians): { v, h }. */
  fov() {
    const a = this.W / this.H, v = vfovFor(a, this.v0) * DEG;
    return { v, h: 2 * Math.atan(Math.tan(v / 2) * a) };
  }
  _before() {
    if (!this.W || !this.H) return;
    const cam = this.stage.camera, f = this.fov();
    cam.fov = f.v / DEG; cam.aspect = this.W / this.H;
    cam.near = 0.08; cam.far = 4000;
    cam.updateProjectionMatrix();
    this.ribbon.uniforms.uViewH.value = this.H * this.stage.drawScale;
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
    const k = dt >= 0.2 ? 1 : 1 - Math.exp(-dt * (this.mode === 'frame' ? 7 : 22));
    S.yaw += (S.tyaw - S.yaw) * k; S.pitch += (S.tpitch - S.pitch) * k;
    if (Math.abs(S.tyaw - S.yaw) < 2e-4 && Math.abs(S.tpitch - S.pitch) < 2e-4) { S.yaw = S.tyaw; S.pitch = S.tpitch; } else more = true;
    const A = S.above;
    if (A.tw) {
      const kk = A.tw.dur <= 0 ? 1 : clamp((now - A.tw.t0) / A.tw.dur, 0, 1);
      A.k = A.tw.from + (A.tw.to - A.tw.from) * easeInOut(kk);
      if (kk >= 1) { const done = A.tw.done; A.tw = null; done?.(); } else more = true;
    }
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
  get viewYaw() { return this.track.yawAt(this.S.at) + this.S.yaw + this.dev.yaw; }
  _groundPose(p, q) {
    const S = this.S, tr = this.track, tan = tr.tanAt(S.at);
    tr.pos(S.at, p);
    if (S.off) { p.x += -Math.cos(tan) * S.off; p.z += Math.sin(tan) * S.off; }     // left of the path = positive
    // the phone's own turn (tilt.js) adds to the look; with it the visitor may look further up and down
    const lo = this.dev.on ? -85 * DEG : -50 * DEG, hi = this.dev.on ? 70 * DEG : 40 * DEG;
    this._e.set(clamp(this.rest + S.pitch + this.dev.pitch, lo, hi), this.viewYaw, 0, 'YXZ');
    q.setFromEuler(this._e);
  }
  _abovePose(p, q) {
    const A = this.S.above, O = this._ov;
    const d = O.dist * A.zoom, ce = Math.cos(A.el), se = Math.sin(A.el);
    p.set(O.c.x + Math.sin(A.az) * ce * d, O.c.y + se * d, O.c.z + Math.cos(A.az) * ce * d);
    this._m.lookAt(p, O.c, UP);
    q.setFromRotationMatrix(this._m);
  }
  _camera() {
    const cam = this.stage.camera, A = this.S.above;
    this._groundPose(this._gp, this._gq);
    if (A.k > 0 && this._ov) {
      this._abovePose(this._ap, this._aq);
      cam.position.lerpVectors(this._gp, this._ap, A.k);
      cam.quaternion.slerpQuaternions(this._gq, this._aq, A.k);
    } else { cam.position.copy(this._gp); cam.quaternion.copy(this._gq); }
    if (A.k !== this._bgK) { this._bgK = A.k; this.stage.renderer.setClearColor(this._bg.copy(this.sky).multiplyScalar(1 - A.k), 1); }
    const u = this.ribbon.uniforms, above = A.k > 0.02;
    u.uAt.value = this.S.at;
    u.uBack.value = above ? 1e9 : 10; u.uAhead.value = above ? 1e9 : this.ride_ ? 90 : 45; u.uFar.value = above ? 1e9 : this.ride_ ? 110 : 48;
    u.uPx.value = this.stage.drawScale;
    u.uMinPx.value = (above ? 2.4 : 1.4) * this.stage.drawScale;
    u.uMaxPx.value = above ? 1e6 : clamp(0.0135 * (this.H || 800), 7, 12) * this.stage.drawScale;   // half the band's width near the eye
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
    const p = cam.position, xy = this.fit.xy(this._gp.x, this._gp.z);
    const heading = this.fit.ok ? this.fit.deg(this.viewYaw) : null;
    const key = `${S.at.toFixed(2)}|${S.off.toFixed(2)}|${this.viewYaw.toFixed(3)}|${(S.pitch + this.dev.pitch).toFixed(3)}|${S.above.k.toFixed(2)}|${p.x.toFixed(2)}`;
    if (key !== this._lastPose) {
      this._lastPose = key;
      this.emit('pose', {
        at: S.at, total: this.total, heading, x: this.fit.ok ? xy[0] : null, y: this.fit.ok ? xy[1] : null,
        look: (this.viewYaw - this.track.tanAt(S.at)) / DEG, pitch: (this.rest + S.pitch + this.dev.pitch) / DEG, off: S.off, facing: S.facing,
        above: S.above.on, riding: S.riding, walked: S.walked,
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
  /** Look with your phone (tilt.js): d = { yaw, pitch } in radians added to the look, or null to stop. */
  setDeviceLook(d) {
    const v = this.dev, S = this.S;
    if (!d && v.on && this.rest != null) {
      // off: the phone's turn becomes the swipe look, so the view does not jump back (only after start: rest is known)
      S.yaw += v.yaw; S.tyaw += v.yaw;
      S.tpitch = S.pitch = clamp(S.pitch + v.pitch, -38 * DEG - this.rest, 32 * DEG - this.rest);
    }
    v.on = !!d; v.yaw = d ? d.yaw : 0; v.pitch = d ? d.pitch : 0;
    // from above the phone's turn has no effect: no frame for it
    if (!(S.above.k >= 1 && !S.above.tw) || !d) this.stage?.invalidate();
  }
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
    if (S.above.on) { S.tw = null; S.at = at; S.offRaw = 0; S.tyaw = S.yaw = 0; S.tpitch = S.pitch = 0; this.above(false); this._firstStep(d); return true; }
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
    if (on) this._overview(false);
    A.tw = { from: A.k, to: on ? 1 : 0, t0: performance.now(), dur: REDUCED ? 0 : 1300 };
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
    const f = this.fov(), el = 55 * DEG, th2 = Math.tan(f.h / 2), tv2 = Math.tan(f.v / 2), se = Math.sin(el);
    const dA = Math.max(L * 1.2 / (2 * th2), Wd * se * 1.5 / (2 * tv2), 14);      // the long axis across the screen
    const dB = Math.max(Wd * 1.25 / (2 * th2), L * se * 1.5 / (2 * tv2), 14);     // the long axis up the screen
    const across = dA <= dB;
    // the camera sits behind the visitor's own view direction, so "ahead" stays up on the screen
    let dir = across ? [-az, ax] : [ax, az];                                       // the horizontal view direction
    const vy = this.viewYaw, vd = [-Math.sin(vy), -Math.cos(vy)];
    if (dir[0] * vd[0] + dir[1] * vd[1] < 0) dir = [-dir[0], -dir[1]];
    this._ov = { c, dist: across ? dA : dB };
    if (!keep) { A.az = A.taz = Math.atan2(-dir[0], -dir[1]); A.el = A.tel = el; A.zoom = 1; }
  }
  /**
   * The point of the path under a pointer: { at, x, y, d } (d = pixels from the pointer) or null. On the ground only the
   * stretch of path that is drawn counts; from above, the whole path.
   */
  pickPath(px, py, maxPx = 26) {
    const tr = this.track, S = this.S, above = S.above.k > 0.5, v = this._v, o = { x: 0, y: 0 };
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
    const hit = this.pickPath(px, py, 30);
    if (this.mode === 'frame') { this.emit('enter', { at: hit ? hit.at : this.S.at }); return; }
    if (hit) this.goTo({ at: hit.at });
  }
  setOffscreen(off) { this.stage?.setOff(off); }
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
    try { this.ribbon?.dispose(); this.points?.dispose(); this.splats?.dispose(); } catch (e) { /* already gone */ }
    const st = this.stage;
    if (st) {
      st.setOff(true);
      try { st.spark?.dispose(); st.renderer.dispose(); if (!st.lost && !st.gl.isContextLost()) st.gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch (e) { /* already gone */ }
    }
  }
}
