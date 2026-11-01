// The world's renderer (MASTER_PLAN.md 2.3 / 4.3 / 4.5): a fork of the viewer's Stage (js/viewer/scene.js) for the
// home page. ONE WebGL2 context for the whole page, created by caps.js on the real canvas and handed in.
//   * On-demand and never re-entrant: a frame is drawn only when something asks (invalidate) and at most one rAF is in
//     flight; Spark's onDirty from inside render() only marks the stage dirty.
//   * Frame cap with even pacing: frames are drawn on every k-th vsync, k = max(1, floor(refresh / maxFps)).
//   * Render scale = the tier's (DPR cap and drawing-buffer pixel cap) x the governor's rung; one full-resolution refine
//     frame once the view rests (160 ms on desktops, 600 ms on phones).
//   * Pauses by reason (off screen, curtain, hidden tab, lost context, story): no frames while any reason holds.
//   * Context loss: preventDefault, pause, tell the owner (world.js rebuilds; see there).
import * as THREE from 'three';
import { SparkRenderer } from '@sparkjsdev/spark';

const STREAK_GAP = 80;
// O1: the layer the one-time splat check draws Spark alone on (nothing else is ever put on it)
const PROBE_LAYER = 31;
// O1: Playwright's WebKit build for Windows (WebKit with Apple's vendor string on a 'Win32' platform: no browser people
// use) stops showing a WebGL canvas for good once its drawing buffer is resized after it has been shown. A 10-line page
// repeats it (clear red, resize, clear green: black, with every context attribute), and the buffer still reads back what
// was drawn: the stage went black at the governor's first rung, splats and points alike, while Spark drew. There the
// governor's render scale stays at the tier's, so its WebKit runs show what the engine draws (window resizes still resize)
const FIXED_BUFFER = typeof navigator !== 'undefined' && navigator.platform === 'Win32' && /^Apple/.test(navigator.vendor || '');
// A context loss logged "Uncaught (in promise)" in 2 of 4 runs (5 of 6 here). Spark's sort reads its depths back through
// three's readRenderTargetPixelsAsync, whose fence poll rejects with NO reason when the context is lost (WAIT_FAILED,
// three.core.js probeAsync), and nothing in Spark handles that promise; its dispose() also rejects a sort in flight with
// "Worker terminate" (spark.module.js:3027). Only those two, and only while one of our contexts is lost (until 5 s after
// its stage is disposed) or in the 5 s after our own Spark dispose, are silenced; every other rejection still reports
const ourGls = new Set();
let sparkDisposedAt = -1e9;
addEventListener('unhandledrejection', e => {
  const r = e.reason;
  if ((r === undefined && [...ourGls].some(g => g.isContextLost())) || (r?.message === 'Worker terminate' && performance.now() - sparkDisposedAt < 5000)) e.preventDefault();
});

export class WorldStage {
  constructor(canvas, { gl, params, governor }) {
    this.canvas = canvas; this.params = params; this.gov = governor;
    this.renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: false, alpha: false, stencil: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x000000, 1);
    this.gl = this.renderer.getContext();
    ourGls.add(this.gl);         // (a context that is not lost never matches the rejection filter above)
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(46, 1, 0.05, 30000);
    this.size = { w: 1, h: 1 };
    this.base = 1;               // the tier's full scale for this size (DPR cap, pixel cap)
    this.scale = 1;              // the scale used while moving (base x the governor's rung)
    this.drawScale = 1;          // the drawing buffer's current scale
    this.trimmed = false;
    this.spark = new SparkRenderer({ renderer: this.renderer, onDirty: () => this.invalidate(), enableLod: false, ...(params.spark || {}) });
    this.sparkBase = { maxPixelRadius: this.spark.maxPixelRadius, maxStdDev: this.spark.maxStdDev, minAlpha: this.spark.minAlpha, minSortIntervalMs: this.spark.minSortIntervalMs };
    this.scene.add(this.spark);
    // Spark's splat program is large: compile it in parallel (KHR_parallel_shader_compile), out of the frames until ready
    this.spark.visible = false;
    this.sparkReady = Promise.race([this.renderer.compileAsync(this.spark, this.camera, this.scene), new Promise(r => setTimeout(r, 4000))])
      .catch(() => null).then(() => { this.spark.visible = true; this.invalidate(); });

    this.hooks = new Set();      // fn(dt, now) -> true while it needs more frames
    this.before = new Set();     // fn() before each render
    this.after = new Set();      // fn(info) after each render
    this.reasons = new Set();
    this.maxFps = params.fps;
    this._raf = 0; this._inTick = false; this._dirty = true;
    this._chain = false;         // PL: the pending frame was asked for by the previous rendered frame (a run of frames)
    this._lastCb = 0; this._lastRender = 0; this._streak = 0; this._refineT = 0; this._rest = 0;
    this.renderCount = 0;
    this._probe = null;          // O1: a pending splat check (probeSplats)
    this.frames = [];            // [t, interval, gpuMs|null, workMs]
    this.tq = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this._queries = [];
    this._ctxFns = new Set();
    this._tick = this._tick.bind(this);
    this._lost = e => { e.preventDefault(); this.pause('ctx'); for (const f of this._ctxFns) f('lost'); };
    this._restored = () => { for (const f of this._ctxFns) f('restored'); };
    canvas.addEventListener('webglcontextlost', this._lost);
    canvas.addEventListener('webglcontextrestored', this._restored);
    // the display's refresh, read once before the first frame from 24 empty rAF callbacks (iOS Low Power Mode: 30 Hz)
    let n = 0, prev = 0;
    const probe = t => { if (prev) this.gov.vsync(t - prev, 0, t); prev = t; if (++n < 25 && !this.reasons.has('disposed')) requestAnimationFrame(probe); };
    requestAnimationFrame(probe);
  }
  get paused() { return this.reasons.size > 0; }
  onContext(fn) { this._ctxFns.add(fn); return () => this._ctxFns.delete(fn); }
  invalidate() { this._dirty = true; this._schedule(); }
  _schedule() { if (!this._raf && !this._inTick && !this.paused) this._raf = requestAnimationFrame(this._tick); }
  pause(why) { this.reasons.add(why); if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; } }
  resume(why) {
    if (!this.reasons.delete(why) || this.paused) return;
    this._lastCb = 0; this._lastRender = 0; this._streak = 0; this._chain = false;
    this.gov.grace(500, `resume (${why})`);
    this.invalidate();
  }
  /** The frame-rate ceiling for what drives the frames now (scroll motion: the tier's fps; playback alone: playFps). */
  setCapFps(fps) { this.maxFps = fps; }

  _tick(now) {
    this._raf = 0;
    if (this.paused) return;
    const t0 = performance.now();
    const iv = this._lastCb ? now - this._lastCb : 0;
    this._lastCb = now;
    // even pacing: draw on every k-th vsync only
    const period = 1000 / this.gov.refreshHz, k = this.gov.kFor(this.maxFps);
    if (this._lastRender && k > 1 && now - this._lastRender < (k - 0.5) * period) {
      if (!(this.gpu() > 4)) this.gov.vsync(iv, performance.now() - t0, now);
      this._raf = requestAnimationFrame(this._tick);
      return;
    }
    const chained = this._chain;
    this._inTick = true;
    let more = false;
    try {
      const dt = Math.min(0.1, Math.max(0, (this._lastRender ? now - this._lastRender : period) / 1000));
      this._pollQueries();
      for (const h of this.hooks) if (h(dt, now)) more = true;
      if (this._dirty || more) {
        this._dirty = false;
        if (this.drawScale !== this.scale && (more || this._streak > 0)) this._applyScale(this.scale);
        this.render(true, now, k * period, t0, chained);
      }
    } catch (e) {
      console.error('[world] frame', e);
    } finally {
      this._inTick = false;
    }
    // the refresh estimate reads light frames only: GPU-bound frames stretch the rAF interval past one vsync
    if (!(this.gpu() > 4)) this.gov.vsync(iv, performance.now() - t0, now);
    if (more || this._dirty) { this._rest = 0; this._chain = true; this._schedule(); } else { this._chain = false; this._idleSoon(); }
  }

  /** Draw one frame. workStart: when this frame's work began (the hooks included), for the work-time record. */
  render(timed = false, now = performance.now(), budget = 16.7, workStart = performance.now(), chained = false) {
    const t0 = workStart;
    for (const f of this.before) f();
    const gl = this.gl;
    if (this._probe?.armed && timed) this._probePass();
    let q = null;
    if (timed && this.tq && this._queries.length < 8) { q = gl.createQuery(); gl.beginQuery(this.tq.TIME_ELAPSED_EXT, q); }
    this.renderer.render(this.scene, this.camera);
    if (q) gl.endQuery(this.tq.TIME_ELAPSED_EXT);
    const t = performance.now();
    const gap = this._lastRender ? now - this._lastRender : 1e9;
    this._streak = gap < Math.max(STREAK_GAP, budget * 3) ? this._streak + 1 : 0;
    this._lastRender = now;
    // continuous: part of a run of frames. PL: a frame the previous frame asked for is continuous whatever its gap: a
    // GPU-bound phone stalls 190 ms every few frames, and those stalls (gap > 3 budgets) were dropped as "idle", so the
    // governor never saw the overload; a gap after the stage went idle still starts a new run
    const rec = [t, gap, null, t - t0, budget, timed && (this._streak > 1 || chained)];
    this.frames.push(rec);
    if (q) this._queries.push([q, rec]);
    if (this.frames.length > 600) this.frames.splice(0, 300);
    this.renderCount++;
    if (timed && !q) this._report(rec);
    for (const f of this.after) f(rec);
  }
  _report(rec) {
    this.gov.frame(rec[0], { interval: rec[1], workMs: rec[3], gpuMs: rec[2], budget: rec[4], continuous: rec[5], refine: false });
  }
  /**
   * O1: a one-time look at what Spark draws by itself. The next drawn frame first renders Spark alone (its own layer,
   * no update), reads 8 x 8 single pixels over the middle 60 % of the drawing buffer into a pixel-pack buffer (no GPU
   * stall), then draws the frame as usual over it. Resolves {lit, n, max} once the GPU is done (polled at 8 ms; lit =
   * pixels with r + g + b > 3 of 255), or null when no answer came (a lost context, no fence in 1.5 s): no verdict.
   */
  probeSplats() {
    if (this._probe) return this._probe.promise;
    let resolve = null;
    const promise = new Promise(r => { resolve = r; });
    this._probe = { promise, resolve, armed: true };
    this.invalidate();
    return promise;
  }
  _probePass() {
    const p = this._probe;
    p.armed = false;
    const gl = this.gl, r = this.renderer, sp = this.spark, cam = this.camera, N = 8;
    let buf = null, sync = null;
    const done = res => {
      try { if (sync) gl.deleteSync(sync); if (buf) gl.deleteBuffer(buf); } catch (e) { /* context gone */ }
      if (this._probe === p) this._probe = null;
      p.resolve(res);
    };
    try {
      const mask = cam.layers.mask, au = sp.autoUpdate;
      sp.layers.enable(PROBE_LAYER); cam.layers.set(PROBE_LAYER); sp.autoUpdate = false;
      try { r.render(this.scene, cam); } finally { cam.layers.mask = mask; sp.autoUpdate = au; sp.layers.disable(PROBE_LAYER); }
      const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
      buf = gl.createBuffer();
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, N * N * 4, gl.STREAM_READ);
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        gl.readPixels(Math.floor(W * (0.2 + 0.6 * (i + 0.5) / N)), Math.floor(H * (0.2 + 0.6 * (j + 0.5) / N)), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, (j * N + i) * 4);
      }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
    } catch (e) {
      done(null);
      return;
    }
    const t0 = performance.now();
    const poll = () => {
      if (this.reasons.has('disposed') || gl.isContextLost()) { done(null); return; }
      const st = gl.clientWaitSync(sync, 0, 0);
      if (st === gl.TIMEOUT_EXPIRED) { if (performance.now() - t0 < 1500) setTimeout(poll, 8); else done(null); return; }
      if (st === gl.WAIT_FAILED) { done(null); return; }
      const px = new Uint8Array(N * N * 4);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, px);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      let lit = 0, max = 0;
      for (let k = 0; k < px.length; k += 4) { const v = px[k] + px[k + 1] + px[k + 2]; if (v > 3) lit++; if (v > max) max = v; }
      done({ lit, n: N * N, max });
    };
    setTimeout(poll, 8);
  }
  _pollQueries() {
    const gl = this.gl;
    while (this._queries.length) {
      const [q, rec] = this._queries[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      this._queries.shift();
      if (!gl.getParameter(this.tq.GPU_DISJOINT_EXT)) rec[2] = +(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6).toFixed(3);
      gl.deleteQuery(q);
      this._report(rec);
    }
  }
  _applyScale(s) {
    if (Math.abs(s - this.drawScale) < 1e-3) return;
    this.drawScale = s;
    this.renderer.setPixelRatio(s);
    this.renderer.setSize(this.size.w, this.size.h, false);
  }
  /** At rest below full resolution: one refine frame at the tier's full scale. */
  _idleSoon() {
    if (this.drawScale >= this.base - 1e-3) return;
    clearTimeout(this._refineT);
    this._refineT = setTimeout(() => {
      if (this._raf || this.paused) return;
      this._applyScale(this.base);
      this._streak = 0;
      this.render(false);
    }, this.params.phone ? 600 : 160);
  }
  /** Apply the governor's rung (render scale and the Spark fill-rate trims). */
  applyRung(rung) {
    const [lo, hi] = this.params.scale;
    const s = rung.scale ? Math.max(lo, Math.min(hi, this.base * rung.scale)) : lo;
    this.scale = FIXED_BUFFER ? this.base : Math.min(this.base, s);
    const sp = this.spark, b = this.sparkBase;
    if (rung.trims) {
      sp.maxPixelRadius = Math.min(b.maxPixelRadius, this.params.phone ? 160 : 200);
      sp.maxStdDev = Math.min(b.maxStdDev, 2.5);
      sp.minAlpha = b.minAlpha * 2;
    } else Object.assign(sp, { maxPixelRadius: b.maxPixelRadius, maxStdDev: b.maxStdDev, minAlpha: b.minAlpha });
    sp.minSortIntervalMs = rung.cap30 ? Math.max(b.minSortIntervalMs, 66) : b.minSortIntervalMs;
    this._applyScale(this.scale);
    this.invalidate();
  }
  resize(w, h) {
    if (!w || !h) return false;
    this.size = { w, h };
    const dpr = window.devicePixelRatio || 1;
    this.base = Math.max(0.25, Math.min(dpr, this.params.dprCap, Math.sqrt(this.params.pixCap / (w * h))));
    this.applyRung(this.gov.rung);
    this.renderer.setSize(w, h, false);
    this.gov.grace(500, 'resize');
    this.invalidate();
    return true;
  }
  gpu() {
    const g = this.frames.slice(-30).map(f => f[2]).filter(x => x != null).sort((a, b) => a - b);
    return g.length ? g[g.length >> 1] : null;
  }
  fps() {
    const f = this.frames, now = performance.now();
    if (f.length < 6 || now - f[f.length - 1][0] > 250) return null;
    let i = f.length - 1;
    while (i > 0 && now - f[i - 1][0] < 1000) i--;
    const n = f.length - 1 - i, span = f[f.length - 1][0] - f[i][0];
    return n >= 4 && span > 0 ? (n * 1000) / span : null;
  }
  rendersPerSecond() { const now = performance.now(); return this.frames.filter(f => now - f[0] < 1000).length; }
  /** The engine's own main-thread work per rendered frame (ms): p50 / p95 / max over the last 240 frames. */
  work() {
    const w = this.frames.slice(-240).map(f => f[3]).sort((a, b) => a - b);
    const q = k => (w.length ? +w[Math.min(w.length - 1, Math.floor(k * w.length))].toFixed(2) : null);
    return { n: w.length, p50: q(0.5), p95: q(0.95), max: q(1) };
  }
  info() {
    const m = this.renderer.info.memory;
    return { scale: +this.scale.toFixed(3), drawScale: +this.drawScale.toFixed(3), base: +this.base.toFixed(3), buffer: [this.canvas.width, this.canvas.height],
      gpu_ms: this.gpu(), work_ms: this.work(), fps: this.fps(), renders_1s: this.rendersPerSecond(), frames: this.renderCount, maxFps: this.maxFps,
      calls: this.renderer.info.render.calls, textures: m.textures, geometries: m.geometries, paused: [...this.reasons] };
  }
  dispose() {
    this.pause('disposed');
    clearTimeout(this._refineT);
    this.canvas.removeEventListener('webglcontextlost', this._lost);
    this.canvas.removeEventListener('webglcontextrestored', this._restored);
    this.hooks.clear(); this.before.clear(); this.after.clear();
    this.releaseGpu();
    const gl = this.gl;
    setTimeout(() => ourGls.delete(gl), 5000);
  }
  /** Free Spark's and three's GPU objects once (WIRE: called while a lost context is still lost, where deletes are
   * no-ops; after a restore they would name the old context's objects and log an INVALID_OPERATION warning each). */
  releaseGpu() {
    if (this._released) return;
    this._released = true;
    sparkDisposedAt = performance.now();
    try { this.spark.dispose?.(); } catch (e) { /* context gone */ }
    try { this.renderer.dispose(); } catch (e) { /* context gone */ }
  }
}
