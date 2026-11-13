// Necessity Robotics viewer (ported from the approved review viewer) — the stage: one WebGLRenderer, one three.js scene, one SparkRenderer, one 'world' group.
//
// Rendering is ON DEMAND and NEVER RE-ENTRANT. A frame is drawn only when something asks for one (camera motion,
// playback, a fade, a load step, or Spark finishing a sort). At most ONE requestAnimationFrame is in flight:
// invalidate() called while a frame is being drawn (Spark calls onDirty from inside render()) only marks the stage
// dirty, and the end of that frame schedules the next one.
//   The previous viewer scheduled a second rAF in that case, so every frame with a moving camera doubled the number
//   of pending callbacks (1, 2, 4 ... 2^n renders per vsync). That callback storm was the "big maps hang": a GPU
//   queue thousands of frames deep and a main thread frozen for tens of seconds (notes/VIEWER_NOTES.md §1).
//
// Adaptive resolution: the render scale (device px per CSS px) follows the GPU time of each frame, measured with
// EXT_disjoint_timer_query_webgl2 when available (rAF intervals otherwise), to hold ~60 fps; when the view comes to
// rest, one frame is re-drawn at full resolution. The scale never exceeds a device-pixel-ratio cap nor a drawing-buffer
// pixel cap (phones 1.25 / 1.2 MP, desktops 2 / 4.2 MP: a 4K screen draws at about 0.75 of its pixels), so fill rate is
// bounded on high-DPI screens. Rendering pauses while the tab is hidden and while the WebGL context is lost.
import * as THREE from 'three';
import { SparkRenderer } from '@sparkjsdev/spark';

const BUDGET_HI = 12.5;   // ms of GPU per frame above which the scale drops (leaves room for 60 fps)
const BUDGET_LO = 5.5;    // ms below which it may climb back
const STREAK_GAP = 60;    // ms: frames closer than this belong to one continuous streak (motion)

/** The display's vsync period from recent render gaps: the shortest interval that recurs (3 within 12 %), since rAF
 *  timestamps are vsync-aligned (the engine's governor uses the same rule, engine_PL F1). */
function vsyncOf(frames) {
  const g = frames.slice(-120).map(x => x[1]).filter(x => x >= 4 && x < 200).sort((a, b) => a - b);
  for (let i = 0; i + 2 < g.length; i++) if (g[i + 2] <= g[i] * 1.12) return g[i];
  return null;
}

export class Stage {
  constructor(canvas, { clear = 0x04060a, context = null, maxDpr = 2, maxPixels = 4.2e6, onContext = null } = {}) {
    this.canvas = canvas;
    this.maxDpr = maxDpr;
    this.maxPixels = maxPixels;
    // throws when WebGL2 is unavailable (three r186 is WebGL2-only); main.js catches it and shows the fallback
    this.renderer = new THREE.WebGLRenderer({ canvas, context: context || undefined, antialias: false, alpha: false, stencil: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(clear, 1);
    this.gl = this.renderer.getContext();
    this.maxScale = Math.min(window.devicePixelRatio || 1, maxDpr);
    this.minScale = Math.min(0.5, this.maxScale);
    this.scale = this.maxScale;       // adaptive scale used while the view moves
    this.drawScale = this.maxScale;   // scale of the current drawing buffer
    this.renderer.setPixelRatio(this.drawScale);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 5000);
    this.world = new THREE.Group();
    this.world.name = 'world (map frame, up_gravity -> +Y)';
    this.scene.add(this.world);

    this.spark = null;
    this.sparkError = null;
    try {
      // enableLod off: our maps carry no LoD tree (Spark's lod build was measured: +5.1 s to first splat on kitti_00 for
      // no frame-time gain on the target GPU; VIEWER_NOTES §4)
      this.spark = new SparkRenderer({ renderer: this.renderer, onDirty: () => this.invalidate(), enableLod: false });
      this.scene.add(this.spark);
      // Spark's splat program is large (26 kB vertex shader): linked synchronously at the first frame, it blocked the main
      // thread for 78 ms on a cold shader cache (review trace, kitti_00). The SparkRenderer lives in the scene from the
      // start, so the very first frame (an empty stage) used to link it. Compile it in parallel instead and keep it out
      // of the frames until it is ready.
      this.spark.visible = false;
      this.sparkReady = Promise.race([
        this.renderer.compileAsync(this.spark, this.camera, this.scene),
        new Promise(r => setTimeout(r, 4000)),
      ]).catch(e => console.warn('[viewer] splat shader warm-up', e)).then(() => { this.spark.visible = true; this.invalidate(); });
    } catch (e) {
      this.sparkError = e;
      console.warn('[viewer] SparkRenderer unavailable:', e);
    }

    this.hooks = new Set();   // fn(dt, now) -> true while it still needs frames (tweens, damping, playback)
    this.before = new Set();  // fn() just before each render (projection)
    this.after = new Set();   // fn() after each render (HUD)
    this.size = { w: 1, h: 1 };
    this._raf = 0;
    this._inTick = false;
    this._dirty = true;
    this._last = performance.now();
    this._lastRender = 0;
    this.paused = document.hidden;
    this.renderCount = 0;
    this.frames = [];         // [t, dtSincePreviousRender, gpuMs|null] for the recent renders (QA + FPS readout)
    this._streak = 0;
    this._chain = false;      // integrator (H-PL2): the pending frame was asked for by the previous rendered frame
    this._tick = this._tick.bind(this);

    // GPU timing (async, never blocks): one TIME_ELAPSED query per frame, read back a few frames later
    this.tq = this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this._queries = [];
    this.gpuMs = [];          // recent GPU frame times (ms)
    this._slow = 0; this._fast = 0;
    this._refineTimer = 0;
    this.budgetHi = BUDGET_HI;  // instance copies: QA can tighten them to exercise the controller on a fast GPU
    this.budgetLo = BUDGET_LO;

    document.addEventListener('visibilitychange', () => this._visibility());
    window.addEventListener('pagehide', () => this._visibility(true));
    window.addEventListener('pageshow', e => { if (e.persisted) this._visibility(); });
    // context loss (iOS evicts WebGL contexts under memory pressure): stop drawing, let the page show its poster
    this.lost = false;
    canvas.addEventListener('webglcontextlost', e => {
      e.preventDefault();
      this.lost = true;
      this._chain = false;
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = 0;
      onContext?.('lost');
    });
    canvas.addEventListener('webglcontextrestored', () => onContext?.('restored'));
  }

  /** A frame cap in ms (0 = none). The adaptive resolution starts its judgement afresh, and with a GPU timer its budget
   *  follows the cap (12.5 ms is a 60 fps budget; at 30 fps a frame may cost twice that). */
  setMinFrame(ms) {
    this.minFrameMs = ms > 0 ? ms : 0;
    const f = this.minFrameMs ? this.minFrameMs / 16.7 : 1;
    this.budgetHi = BUDGET_HI * f; this.budgetLo = BUDGET_LO * f;
    this._vs = null; this._vsAt = -1e9; this._judgeFrom = performance.now(); this._lastDraw = null;
    this._slow = 0; this._fast = 0;
  }

  // ------------------------------------------------------------------ scheduling
  /** Ask for (at least) one more frame. Safe to call from anywhere, including from inside render(). */
  invalidate() {
    this._dirty = true;
    this._schedule();
  }
  _schedule() {
    if (this._raf || this._inTick || this.paused || this.lost) return;
    this._raf = requestAnimationFrame(this._tick);
  }
  _visibility(forceHidden = false) {
    const hidden = forceHidden || document.hidden;
    this.paused = hidden;
    this._chain = false;                                 // a run never spans a hidden period
    if (hidden) {
      if (this._raf) cancelAnimationFrame(this._raf);
      this._raf = 0;
    } else {
      this._last = performance.now();
      this.invalidate();
    }
  }

  _tick(now) {
    this._raf = 0;
    if (this.paused || this.lost) return;
    // an optional frame cap (minFrameMs, 0 = none): a page may hold a phone or tablet to 30 fps so that its GPU and the
    // page's own work keep up; a skipped vsync only asks for the next one (dt then spans both)
    if (this.minFrameMs > 0 && this._lastDraw != null && now - this._lastDraw < this.minFrameMs - 2) { this._schedule(); return; }
    this._lastDraw = now;
    this._inTick = true;
    let more = false;
    try {
      const dt = Math.min(0.1, Math.max(0, (now - this._last) / 1000));
      this._last = now;
      this._pollQueries();
      for (const h of this.hooks) { if (h(dt, now)) more = true; }
      if (this._dirty || more) {
        this._dirty = false;
        this._adapt(now);
        this._chainNow = this._chain;
        this._tickNow = now;            // the rAF timestamp (vsync-aligned): render gaps from it, not from after the render
        this.render(true);
        this._chainNow = false;
        this._tickNow = null;
      }
    } catch (e) {
      console.error('[viewer] frame', e);
    } finally {
      this._inTick = false;
    }
    if (more || this._dirty) { this._chain = true; this._schedule(); }
    else { this._chain = false; this._idleSoon(); }
  }

  /** Draw one frame now. timed: wrap it in a GPU timer query (only from the frame loop). */
  render(timed = false) {
    for (const f of this.before) f();
    const gl = this.gl;
    let q = null;
    if (timed && this.tq && this._queries.length < 8) {
      q = gl.createQuery();
      gl.beginQuery(this.tq.TIME_ELAPSED_EXT, q);
    }
    this.renderer.render(this.scene, this.camera);
    const t = timed && this._tickNow != null ? this._tickNow : performance.now();
    const gap = this._lastRender ? t - this._lastRender : 1e9;
    // a frame the previous frame asked for stays in the run whatever its gap: a GPU stall (100-190 ms with no timer)
    // used to reset the run, so the scaler never judged the frames that showed the overload (H-PL2, engine_PL F3)
    this._streak = gap < STREAK_GAP || (timed && this._chainNow) ? this._streak + 1 : 0;
    this._lastRender = t;
    const rec = [t, gap, null];
    this.frames.push(rec);
    if (q) { gl.endQuery(this.tq.TIME_ELAPSED_EXT); this._queries.push([q, rec]); }
    if (this.frames.length > 600) this.frames.splice(0, 300);
    this.renderCount++;
    for (const f of this.after) f();
  }

  _pollQueries() {
    const gl = this.gl;
    while (this._queries.length) {
      const [q, rec] = this._queries[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      this._queries.shift();
      const disjoint = gl.getParameter(this.tq.GPU_DISJOINT_EXT);
      if (!disjoint) {
        const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        this.gpuMs.push(ms);
        if (this.gpuMs.length > 120) this.gpuMs.shift();
        rec[2] = +ms.toFixed(3);
      }
      gl.deleteQuery(q);
    }
  }

  // ------------------------------------------------------------------ adaptive resolution
  _adapt(now) {
    clearTimeout(this._refineTimer);
    // coming back from an idle full-resolution refine: return to the adaptive scale for motion
    if (this.drawScale !== this.scale && this._streak > 0) this._applyScale(this.scale);
    if (this._streak < 3) return;                       // only judge continuous motion
    let cost = null;
    if (this.tq && this.gpuMs.length >= 6) {
      const r = this.gpuMs.slice(-8).sort((a, b) => a - b);
      cost = r[r.length >> 1];
    } else if (!this.tq) {
      // no GPU timer (phones, Safari, Firefox): the MEAN rAF interval of the current run over the last 750 ms, against the
      // display's own vsync period. Under a GPU load Chrome draws about 4 frames on time and then stalls 100-190 ms: the
      // median of 8 stayed at the vsync interval and the viewer played at about 16 fps at full resolution (H-PL2). Judged
      // relative to vsync, a 30 Hz display (iOS Low Power Mode) is not overload, and a one-off hitch is diluted by the
      // window. cost = the budget's middle x (mean / vsync): slow above 1.39 x vsync, neutral below (never "fast": with no
      // timer the scale only steps down, as before, so it cannot oscillate; the rest refine still draws full resolution).
      // Judged only over at least 600 ms of the run since the last scale change, and only a RECURRING stall counts (3 or
      // more gaps over 2.5 vsyncs in the window): one hitch (a decode, an upload) is not overload. A short window
      // stepped a calm 165 Hz viewer to its floor during loading when this was first tried.
      const f = this.frames, t0 = Math.max(now - 750, this._judgeFrom || 0);
      if (this.renderCount - (this._vsAt || -1e9) >= 30) { this._vsAt = this.renderCount; this._vs = vsyncOf(f) || this._vs; }
      // under a frame cap (minFrameMs) every drawn gap is at least the cap: judge against the cap (a missed slot is a gap
      // over 1.5 caps), not against the display's vsync
      const cap = this.minFrameMs > 0 ? this.minFrameMs : 0, vs = cap ? Math.max(this._vs || 0, cap) : this._vs;
      let sum = 0, n = 0, long = 0;
      for (let i = f.length - 1, k = 0; i >= 0 && k < this._streak && f[i][0] >= t0; i--, k++) { sum += f[i][1]; n++; if (vs && f[i][1] > (cap ? 1.5 : 2.5) * vs) long++; }
      if (sum >= 600 && n >= 6 && vs) cost = ((this.budgetHi + this.budgetLo) / 2) * (long >= 3 ? Math.max(1, (sum / n) / vs) : 1);
    }
    if (cost == null) return;
    if (cost > this.budgetHi) { this._slow++; this._fast = 0; } else if (cost < this.budgetLo) { this._fast++; this._slow = 0; } else { this._slow = 0; this._fast = 0; }
    if (this._slow >= 6 && this.scale > this.minScale + 1e-3) {
      // pixels scale with scale^2: aim for the middle of the budget
      const k = Math.max(0.7, Math.min(0.95, Math.sqrt(((this.budgetHi + this.budgetLo) / 2) / cost)));
      this.scale = Math.max(this.minScale, +(this.scale * k).toFixed(3));
      this._applyScale(this.scale);
      this._slow = 0; this.gpuMs.length = 0; this._judgeFrom = now;
    } else if (this._fast >= 45 && this.scale < this.maxScale - 1e-3) {
      this.scale = Math.min(this.maxScale, +(this.scale * 1.12).toFixed(3));
      this._applyScale(this.scale);
      this._fast = 0; this.gpuMs.length = 0; this._judgeFrom = now;
    }
  }
  _applyScale(s) {
    if (Math.abs(s - this.drawScale) < 1e-3) return;
    this.drawScale = s;
    this.renderer.setPixelRatio(s);
    this.renderer.setSize(this.size.w, this.size.h, false);
  }
  /** When the view comes to rest below full resolution, re-draw one frame at full resolution. */
  _idleSoon() {
    if (this.drawScale >= this.maxScale - 1e-3) return;
    clearTimeout(this._refineTimer);
    this._refineTimer = setTimeout(() => {
      if (this._raf || this.paused || this.lost) return;
      this._applyScale(this.maxScale);
      this._streak = 0;
      this.render(false);
    }, 160);
  }
  get busy() { return !!this._raf || this._inTick; }

  // ------------------------------------------------------------------ size, stats
  resize(w, h) {
    if (!w || !h) return false;            // a hidden pane reports 0
    this.size = { w, h };
    this.maxScale = Math.min(window.devicePixelRatio || 1, this.maxDpr, Math.sqrt(this.maxPixels / (w * h)));
    this.minScale = Math.min(0.5, this.maxScale);
    this.scale = Math.min(this.scale, this.maxScale);
    this.drawScale = Math.min(this.drawScale, this.maxScale);
    this.renderer.setPixelRatio(this.drawScale);
    this.renderer.setSize(w, h, false);
    this.invalidate();
    return true;
  }

  /** Frames per second over the last second of continuous rendering, or null when idle. */
  fps() {
    const f = this.frames;
    const now = performance.now();
    if (f.length < 6 || now - f[f.length - 1][0] > 250) return null;
    let i = f.length - 1;
    while (i > 0 && now - f[i - 1][0] < 1000) i--;
    const n = f.length - 1 - i;
    const span = f[f.length - 1][0] - f[i][0];
    return n >= 4 && span > 0 ? (n * 1000) / span : null;
  }
  gpu() {
    if (!this.gpuMs.length) return null;
    const r = this.gpuMs.slice(-30).sort((a, b) => a - b);
    return r[r.length >> 1];
  }

  /** Synchronous frame-time benchmark: each frame drained by a 1-pixel readPixels (upper bound on GPU time). */
  bench(n = 60, step = null) {
    const gl = this.gl;
    const px = new Uint8Array(4);
    this.render(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const d = [];
    for (let i = 0; i < n; i++) {
      step?.(i);
      const t0 = performance.now();
      this.render(); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      d.push(performance.now() - t0);
    }
    d.sort((a, b) => a - b);
    const db = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    return { frames: n, p50_ms: +d[n >> 1].toFixed(2), p95_ms: +d[Math.floor(n * 0.95)].toFixed(2), max_ms: +d[n - 1].toFixed(2), buffer: [db.x, db.y] };
  }

  info() {
    const gl = this.gl;
    let gpu = '';
    try {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    } catch (e) { /* ignore */ }
    const m = this.renderer.info.memory;
    return { gpu, timerQuery: !!this.tq, scale: this.scale, drawScale: this.drawScale, maxScale: this.maxScale, calls: this.renderer.info.render.calls,
      frames: this.renderCount, textures: m.textures, geometries: m.geometries, programs: this.renderer.info.programs?.length ?? null };
  }
}
