// The frame-time governor (MASTER_PLAN.md 4.3): corrects the start tier live, one rung of a quality ladder at a time,
// with enough hysteresis that quality never oscillates.
//   refresh  the display's rate from the shortest recurring rAF interval of light frames (work < 4 ms; PL: not the
//            median, see vsyncPeriod): iOS Low Power Mode (30 Hz) and ProMotion / 120 Hz panels show up here; a
//            vsync-limited interval is never read as overload;
//   cost     GPU time where EXT_disjoint_timer_query_webgl2 exists, else the rAF interval: an interval over 1.15 x the
//            budget for 3 frames in a row, or (PL) a single stall over 2.5 x, costs max(work, 0.75 x interval); an
//            on-time interval costs at most 0.8 x the budget (0.6 x when the frame's own work was under half the
//            budget, so a device can climb back);
//   degrade  p75 of the last 750 ms of continuous rendering > 1.15 B, or (PL) its mean frame interval > 1.3 B (the
//            frame rate the visitor sees), >= 1 s since the last change;
//   upgrade  p90 of the last 4 s < 0.65 B and (PL) its mean frame interval < 1.05 B (frames on time), >= 5 s since the
//            last change, the level not banned (a level left by degrading twice within 30 s is banned for 60 s); an
//            upgrade that would be the 2nd change of direction within 60 s is
//            refused and freezes upgrades for 60 s at the lower level (PL: oscillation = reversals; a one-way recovery
//            goes on one level per 5 s); a step down is never frozen;
//   grace    500 ms of frames are ignored after a first splat upload, a decode, a context restore, the tab becoming
//            visible, a resize or a beat with a layer swap; idle refine frames never count;
//   half     (O2) on a display over 100 Hz drawn on every vsync (T4 at 120-165 Hz), the first step down halves the frame
//            rate (k = 2: 82.5 fps at 165 Hz) before any resolution cut: Firefox at 165 Hz has no GPU timer, so every
//            missed vsync read as overload and the governor cut resolution L0 -> L6 (p95 30 ms) chasing a rate the
//            browser could not give. Further steps cut resolution at the halved rate; on the way up the rate comes back
//            last, and only when the frame costs under 0.65 x the full-rate budget (an interval-only browser never shows
//            that, so it keeps the halved rate: no probe up, no flicker). A cut made on frame intervals alone (no GPU
//            timer) is undone when it did not shorten them (see frame());
//   L7       still mode, only after 3 s at L6 below 20 fps (O2: or 3 s below 20 fps while cuts are off as useless).

export const LADDER = Object.freeze([
  { level: 0, scale: 1.0 },
  { level: 1, scale: 0.85 },
  { level: 2, scale: 0.72, labelHz: 15 },
  { level: 3, scale: 0.72, labelHz: 15, trims: true, backdrop: false },
  { level: 4, scale: 0.6, labelHz: 15, trims: true, backdrop: false, halfPoints: true },
  { level: 5, scale: 0.6, labelHz: 15, trims: true, backdrop: false, halfPoints: true, cap30: true },
  { level: 6, scale: 0, labelHz: 10, trims: true, backdrop: false, halfPoints: true, cap30: true, dropNonCurrent: true },
  { level: 7, scale: 0, still: true },
]);

const pct = (a, q) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
// O2: a place on the ladder for the bans: the level, + 0.5 at the halved frame rate
const key = (level, half) => level + (half ? 0.5 : 0);

/**
 * PL: the vsync period from rAF intervals = the shortest interval that recurs (3 or more within 12 %), not the median.
 * rAF timestamps are vsync-aligned, so an interval is one period or a multiple of it; a busy main thread (the 3-D side
 * starting, a phone at 4-6x CPU) misses vsyncs, and then most intervals are 2-3 periods long: the median read 83 Hz on a
 * 164 Hz display at 6x CPU for the first 12 s, so k was 1 and every vsync was drawn (twice the tier's frame rate, and
 * on a real 60 Hz phone the 30 fps hero playback would have run at 60). The median stays the fallback.
 */
export function vsyncPeriod(iv) {
  const s = iv.slice().sort((a, b) => a - b);
  for (let i = 0; i + 2 < s.length; i++) {
    if (s[i + 2] > s[i] * 1.12) continue;
    let j = i + 2;
    while (j + 1 < s.length && s[j + 1] <= s[i] * 1.12) j++;
    return s[(i + j) >> 1];
  }
  return s[s.length >> 1];
}

export class Governor {
  constructor(params, { onLevel } = {}) {
    this.params = params;
    this.onLevel = onLevel || (() => {});
    this.level = 0;
    this.half = false;            // O2: the halved-rate rung (k = 2 where the tier's rate would draw every vsync)
    this.check = null;            // O2: a cut made on intervals alone, waiting for its verdict {from, before (ms)}
    this.noCutUntil = 0;          // O2: no cut on intervals alone before this time
    this.noCutFor = 0;
    this.refreshHz = 60;
    this._iv = [];                // light rAF intervals for the refresh estimate
    this._ivAt = 0;
    this._ivN = 0;                // estimates made (the first two come as soon as there are 20 samples)
    this.samples = [];            // [t, cost / budget, interval / budget] of counted frames (4 s)
    this.lastChange = -1e9;
    this.frozenUntil = 0;         // no upgrade before this time
    this.banned = new Map();      // level -> until
    this.leftBy = new Map();      // level -> [times it was left by degrading]
    this.graceUntil = 0;
    this.graceWhy = '';
    this.over = 0;
    this.slowSince = 0;
    this.history = [];
  }
  get rung() { return LADDER[this.level]; }
  /** Every rAF callback (drawn or skipped): the interval since the previous one and the work it did (ms). */
  vsync(interval, workMs, now) {
    if (!(interval > 2 && interval < 100) || workMs >= 4) return;
    this._iv.push(interval);
    if (this._iv.length > 40) this._iv.shift();
    // PL: every 2 s for the first 5 estimates (the start is the busiest time), then every 10 s
    if (this._iv.length >= 20 && (now - this._ivAt > (this._ivN < 5 ? 2000 : 10000) || this._ivN < 2)) {
      this._ivN++;
      this._ivAt = now;
      this.refreshHz = Math.max(20, Math.min(240, 1000 / vsyncPeriod(this._iv)));
    }
  }
  /**
   * k-th vsync for a frame-rate ceiling: k = max(1, floor(refresh / maxFps)) gives even pacing. PL: one vsync more when
   * that would still overshoot the ceiling by over 40 % and the slower rate keeps >= 72 % of it and >= 30 fps: a 90 Hz
   * phone at T2's 60 gets k = 2 (45 fps, evenly; MASTER_PLAN 4.6), where k = 1 drew 90 fps against an 11 ms budget and
   * the governor cut resolution to chase a rate above the tier's. 60 / 120 / 144 / 165 Hz keep their k.
   */
  kFor(maxFps) {
    const k = this.kBase(maxFps);
    return k === 1 && this.half && this.refreshHz > 100 ? 2 : k;
  }
  /** k without the halved-rate rung. */
  kBase(maxFps) {
    const k = Math.max(1, Math.floor(this.refreshHz / maxFps + 0.05));
    const slower = this.refreshHz / (k + 1);
    return this.refreshHz / k > 1.4 * maxFps && slower >= 0.72 * maxFps && slower >= 30 ? k + 1 : k;
  }
  /** O2: the halved-rate rung is open (not taken, a display over 100 Hz, the tier's scroll rate drawn on every vsync). */
  halfOpen() { return !this.half && this.refreshHz > 100 && this.kBase(this.maxFps()) === 1; }
  /** The frame-rate ceiling now: the tier's, lowered to 30 at L5+ on phones and laptops. */
  maxFps(play = false) {
    let f = play ? this.params.playFps : this.params.fps;
    if (this.rung.cap30 && this.params.tier !== 'T4') f = Math.min(f, 30);
    return f;
  }
  capFps(play = false) { return this.refreshHz / this.kFor(this.maxFps(play)); }
  grace(ms, why) { const t = performance.now() + ms; if (t > this.graceUntil) { this.graceUntil = t; this.graceWhy = why; } }
  /**
   * One rendered frame. f: {interval (ms since the previous rendered frame), workMs, gpuMs (or null), budget (ms),
   * refine (an idle full-resolution redraw), continuous (part of an unbroken run of frames)}.
   */
  frame(now, f) {
    if (f.refine || now < this.graceUntil || !f.continuous) { this.over = 0; return; }
    const B = f.budget;
    let cost;
    if (f.gpuMs != null) cost = Math.max(f.gpuMs, f.workMs);
    else {
      const period = B;
      // PL: a stall of 2.5 budgets or more counts at once. A GPU-bound phone (no timer) drew 4 frames on time, then the
      // main thread stalled ~190 ms while Chrome's queue of GPU work drained: 'over' never reached 3 and the on-time
      // frames read as headroom, so the governor stepped back UP under full load and the page ran at 16 fps
      if (f.interval > 1.15 * B) { this.over++; cost = this.over >= 3 || f.interval > 2.5 * B ? Math.max(f.workMs, 0.75 * f.interval) : f.workMs; }
      else {
        this.over = 0;
        cost = Math.abs(f.interval - period) <= 0.1 * period ? (f.workMs < 0.5 * B ? 0.6 * B : Math.min(f.interval, 0.8 * B)) : f.workMs;
      }
    }
    // PL: each sample is kept relative to ITS frame's budget: the budget changes with what drives the frames (a phone's
    // 30 fps hero playback, 30.5 ms, then 60 fps scrolling, 12.2 ms at k = 2 on 164 Hz), and playback costs judged
    // against the scroll budget stepped every phone without a GPU timer down at the first scroll, and up 5 s later
    this.samples.push([now, cost / B, f.interval / B]);
    while (this.samples.length && now - this.samples[0][0] > 4000) this.samples.shift();
    // O2: a resolution cut made on frame intervals alone (no GPU timer) stays only if the frames got shorter. Headless
    // Firefox at 1440 x 900 scrolls at a mean 15.7-16.4 ms a frame at L0, L3 and L6 alike (the page, not our pixels):
    // each cut there cost sharpness for nothing, down to L6. A cut of the render scale that did not shorten the mean
    // frame interval (in budgets) by 10 % over the next 1.5 s, against every frame since the change before it (not
    // just the window that tripped the step: that one is the worst by selection), is undone, and no step is made on
    // intervals alone for 60 s (doubling, at most 8 min)
    const c = this.check;
    if (c && this.samples.length >= 20 && now - this.samples[0][0] >= 1500) {
      const after = this.samples.reduce((x, s) => x + s[2], 0) / this.samples.length;
      this.check = null;
      if (after > 0.9 * c.before) {
        this.noCutFor = Math.min(480000, (this.noCutFor || 30000) * 2);
        this.noCutUntil = now + this.noCutFor;
        this._go(c.from, this.half, now, `the cut left the mean frame at ${(after * B).toFixed(1)} ms (${(c.before * B).toFixed(1)} ms before): undone, no step on intervals alone for ${this.noCutFor / 1000} s`, after * B, B, true);
        return;
      }
    }
    // L7: 3 s at L6 below 20 fps (PL: frames per second as drawn, not the median interval, which a stall pattern hides).
    // O2: or 3 s below 20 fps while cuts are off because they did not help (a device slow for reasons our pixels do not
    // cause never reaches L6, and still mode is its floor)
    const useless = now < this.noCutUntil;
    if (this.level === 6 || useless) {
      const last = this.samples.filter(s => now - s[0] < 1000);
      const fps = last.length >= 3 ? (last.length - 1) * 1000 / Math.max(1, last[last.length - 1][0] - last[0][0]) : 60;
      if (fps < 20) { if (!this.slowSince) this.slowSince = now; else if (now - this.slowSince > 3000) this._set(7, now, `${fps.toFixed(0)} fps at L${this.level} for 3 s${this.level < 6 ? ' (resolution cuts did not help)' : ''}`, cost, B); }
      else this.slowSince = 0;
    }
    // WIRE: a governor still over budget keeps stepping down through a freeze (M10 held L3 at p75 8.4 ms > 7 ms for 60 s;
    // a weak phone would judder that long). PL: the freeze holds upgrades only, whatever came before: a step down can
    // never start an oscillation (the step back up is what the freeze and the bans gate), and a load that grows after
    // a reversal used to be frozen in place for up to 60 s
    const frozen = now < this.frozenUntil;
    // (costs and intervals below are in budgets; the reasons print them in ms of the current budget)
    const win = this.samples.filter(s => now - s[0] <= 750), recent = win.map(s => s[1]);
    // PL: the mean frame interval is the frame rate the visitor sees; stalls between on-time frames hide from any
    // percentile of per-frame cost, never from the mean (4 frames at 30 ms + 1 at 190 ms: p75 30 ms, mean 63 ms)
    const mean = a => a.reduce((x, s) => x + s[2], 0) / Math.max(1, a.length);
    const p75 = pct(recent, 0.75), over75 = p75 > 1.15, slow = mean(win) > 1.3;
    const halve = this.halfOpen();
    if (recent.length >= 6 && (over75 || slow) && now - this.lastChange >= 1000 && (this.level < 6 || halve)) {
      const v = over75 ? p75 : mean(win);
      const why = over75 ? `p75 ${(v * B).toFixed(1)} ms > 1.15 x ${B.toFixed(1)}` : `mean frame ${(v * B).toFixed(1)} ms > 1.3 x ${B.toFixed(1)}`;
      // O2: the rate first (the next frames' budget doubles), resolution only if the halved rate still misses
      if (halve) this._go(this.level, true, now, `${why}: half the frame rate (${(this.refreshHz / 2).toFixed(1)} fps)`, v * B, B);
      else if (f.gpuMs != null) this._go(this.level + 1, this.half, now, why, v * B, B);
      else if (!this.check && !(now < this.noCutUntil)) {
        // the verdict is for render-scale cuts only (L3's trims and L5's 30 fps cap are not pixel cuts)
        const scaleCut = LADDER[this.level + 1].scale !== LADDER[this.level].scale, before = mean(this.samples);
        this._go(this.level + 1, this.half, now, why, v * B, B);
        if (scaleCut) this.check = { from: this.level - 1, before };
      }
      return;
    }
    if (frozen) return;
    const all = this.samples.map(s => s[1]);
    const span = this.samples.length ? now - this.samples[0][0] : 0;
    if ((this.level > 0 || this.half) && span > 3500 && all.length >= 20 && mean(this.samples) < 1.05 && now - this.lastChange >= 5000) {
      // O2: the halved rate goes last, judged against the full-rate budget it would bring back (half this one)
      const rate = this.level === 0;
      const halfOn = rate && this.kFor(this.maxFps()) !== this.kBase(this.maxFps());
      const bar = halfOn ? 0.325 : 0.65, p90 = pct(all, 0.9);
      if (!(p90 < bar)) return;
      const to = rate ? [0, false] : [this.level - 1, this.half];
      if ((this.banned.get(key(...to)) || 0) > now) return;
      this._go(to[0], to[1], now, `p90 ${(p90 * B).toFixed(1)} ms < ${bar} x ${B.toFixed(1)}${rate ? ': full frame rate' : ''}`, p90 * B, B);
    }
  }
  /** Changes of direction among the level changes of the last 60 s, counting one more change in direction dir (+1 down). */
  reversals(now, dir) {
    let n = 0, prev = 0;
    for (const h of this.history) {
      if (now - h.t >= 60000) continue;
      const d = h.dir;
      if (prev && d !== prev) n++;
      prev = d;
    }
    return n + (prev && dir !== prev ? 1 : 0);
  }
  _set(level, now, reason, cost, budget) { this._go(level, this.half, now, reason, cost, budget); }
  /** Move to (level, half): a level change, the halved-rate rung (O2), or both. undo: a cut that did not help. */
  _go(level, half, now, reason, cost, budget, undo = false) {
    const from = this.level, fromHalf = this.half;
    if (level === from && half === fromHalf) return;
    this.check = null;
    const dir = key(level, half) > key(from, fromHalf) ? 1 : -1;      // +1: down (less quality)
    // PL: oscillation is quality going down, up, down. An upgrade that would be the 2nd change of direction within 60 s
    // (up after a down that followed an up) is refused, and upgrades freeze for 60 s at the lower quality. The first
    // upgrade after a descent, and every further step of the same recovery, go through (one level per 5 s): the old rule
    // (any 3 changes in 60 s) refroze a one-way recovery, so after a 6-step descent the way back from L6 to L0 took 195 s.
    // (O2: undoing a cut that did not help is a correction, not a recovery: never refused)
    if (dir < 0 && !undo && this.reversals(now, -1) >= 2) {
      this.frozenUntil = now + 60000;
      return;
    }
    if (dir > 0) {
      const k = key(from, fromHalf);
      const t = (this.leftBy.get(k) || []).filter(x => now - x < 30000);
      t.push(now);
      this.leftBy.set(k, t);
      if (t.length >= 2) this.banned.set(k, now + 60000);
    }
    this.level = level;
    this.half = half;
    this.lastChange = now;
    this.samples.length = 0;
    this.slowSince = 0;
    const rec = { level, from, ...(half !== fromHalf ? { half } : {}), reason, cost: +(+cost).toFixed(2), budget: +(+budget).toFixed(2) };
    this.history.push({ t: Math.round(now), dir, ...rec });
    if (this.history.length > 64) this.history.splice(0, 32);
    this.onLevel(level, rec);
  }
  /** Force a level (context loss escalation, ?gov_test). */
  force(level, reason) { this._set(Math.max(0, Math.min(7, level)), performance.now(), reason, 0, 0); }
  info() {
    return { level: this.level, half: this.half, noCut: this.noCutUntil > performance.now(), refreshHz: +this.refreshHz.toFixed(1), capFps: +this.capFps().toFixed(1), frozen: this.frozenUntil > performance.now(),
      banned: [...this.banned].filter(([, t]) => t > performance.now()).map(([l]) => l), history: this.history.slice(-8) };
  }
}
