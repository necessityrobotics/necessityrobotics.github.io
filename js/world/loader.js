// The predictive loader (MASTER_PLAN.md 2.4): v2's scroll-timed plan, extended to islands, with the speed review's fixes.
//
//  * Net is kept PER ORIGIN (the site and the asset host differ: Hugging Face pays 0.5-1.4 s to the first byte): bandwidth
//    from our own downloads and the time to first byte, starting from navigator.connection where the browser has it.
//  * Download streams one file into one buffer of its size. It can be PAUSED: what arrived is kept, shrunk to what
//    arrived (and counted in the budget), and resumed by HTTP Range. On the site's own origin the resume carries If-Range
//    with the ETag; on the asset host the resumed length is checked against the known size instead (If-Range is not a
//    CORS-safelisted header: it would cost a preflight per resume). A 200 answer to a Range request starts over cleanly.
//    A stall watchdog stops a request with no first byte in 8 s or no new byte in 6 s.
//  * Loader.plan() runs whenever the scroll moves (and when a part finishes):
//      light parts first: the camera path (traj.json) and the dense point prefix of the island on screen and the next
//      islands in the direction of travel come before any big file that is not for the island on screen;
//      big files (splats) ONE at a time across the page (parallel streams share, and on HF even shrink, the throughput):
//        T_k = distance to island k / max(current speed, the visitor's average pace, 0.1 screen / s)
//        D_k = time to first byte + bytes left / bandwidth + decode time
//        start when T_k <= 1.5 D_k + 1 s AND the file is feasible (it lands at least 2 s before the visitor leaves that
//        island); an infeasible island keeps its points and poster and the slot goes to the next feasible one;
//      a flick (> 2.5 screens / s) may start only the island on screen and the landing one; files of islands flown past
//      are paused, except a file more than 75 % done or less than 2 s from done, and the hero's file, which is never
//      paused for another big file;
//      explore intents come first: a dive, then a tap, then a hover of 260 ms or more (desktops only);
//      Standard splats (T4) only for the ride in view, once per chapter per visit (the caller checks dwell and speed).
//  * Failures back off (2 s x 4^n, at most 3 tries, retried once when the browser comes back online); a failed light part
//    never blocks the splats, and a file that is failing, backing off or silent (no byte for 2 s: a host that hangs)
//    holds neither the big-file slot nor the light parts behind it. Light requests have their own stall watchdog.
//  * An island with a ride cut reads xclean's camera track from the site, next to the cut (data/cuts/<id>.track.json);
//    the asset host's traj.json is the fallback. Completed files, tracks and point prefixes go to the Cache API
//    (cache.js) under their stable URL, four maps on every tier.
import { cachedBytes, putBytes, putResponse } from './cache.js';

const conn = navigator.connection;
const BIG = new Set(['cut', 'lite', 'standard']);
const RANK = { dive: 3, tap: 2, select: 2, hover: 1 };
const abortError = why => Object.assign(new Error(why || 'aborted'), { name: 'AbortError' });
const SLICE_MS = 4;
const BYOB_STEP = 256 * 1024;
const YIELD_BYTES = 1 << 20;
// one long-lived channel (a per-call channel can be garbage-collected before its message arrives, and the await never
// returns); scheduler.yield() where the browser has it
const chan = new MessageChannel(), waiting = [];
chan.port1.onmessage = () => waiting.shift()?.();
const yieldTask = () => (globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise(r => { waiting.push(r); chan.port2.postMessage(0); }));
const idleCall = fn => ('requestIdleCallback' in window ? requestIdleCallback(fn, { timeout: 4000 }) : setTimeout(fn, 500));

export class Net {
  constructor(name, { phone = false, local = false } = {}) {
    this.name = name;
    const dl = conn?.downlink;                     // Mbit/s, rounded and capped at 10 by Chrome: a floor
    this.bw = dl ? Math.max(0.2e6, dl * 1e6 / 8 * 0.85) : local ? 50e6 : (phone ? 1.2e6 : 2.5e6);
    this.ttfb = conn?.rtt ? Math.min(1.5, conn.rtt * 2 / 1000) : local ? 0.02 : 0.35;
    this.n = 0; this.nT = 0;
    this.src = dl ? 'navigator.connection' : local ? 'local default' : 'default';
  }
  sampleTTFB(s) { this.ttfb = this.nT ? 0.6 * this.ttfb + 0.4 * s : s; this.nT++; }
  /** A throughput sample (time from the first byte): small files say more about latency than bandwidth, so are skipped. */
  sample(bytes, s, whole = false) {
    if (bytes < 256e3 || (!whole && s < 0.05)) return;
    const bw = bytes / Math.max(s, 0.01);
    this.bw = this.n ? 0.65 * this.bw + 0.35 * bw : bw;
    this.n++; this.src = 'measured';
  }
  eta(bytes) { return bytes > 0 ? this.ttfb + bytes / this.bw : 0; }
  info() { return { bw_mbps: +(this.bw * 8 / 1e6).toFixed(1), ttfb_s: +this.ttfb.toFixed(2), src: this.src }; }
}

export class Download {
  constructor(url, total, net, { sameOrigin = false, keep = null } = {}) {
    this.url = url; this.total = total || 0; this.net = net; this.sameOrigin = sameOrigin;
    this.keep = keep;            // (response clone) -> void: a complete 200 answer streams into the cache as it arrives
    this.buf = null; this.got = 0; this.bytes = null; this.etag = null; this.ctrl = null; this.why = '';
    this.tByte = 0;              // when the last byte (or the request) arrived: a silent file uses no bandwidth
  }
  get done() { return !!this.bytes; }
  get running() { return !!this.ctrl; }
  left() { return this.done ? 0 : Math.max(0, (this.total || 0) - this.got); }
  frac() { return this.done ? 1 : this.total ? this.got / this.total : 0; }
  held() { return this.bytes ? this.bytes.byteLength : this.got; }
  /** Stop, keeping what arrived (resumed later by Range). */
  pause(why = 'paused') { if (this.ctrl) { this.why = why; this.ctrl.abort(); } }
  /** Forget everything. */
  drop() { this.pause('dropped'); this.buf = null; this.bytes = null; this.got = 0; }
  async run(onProgress) {
    if (this.bytes) return this.bytes;
    const ctrl = this.ctrl = new AbortController();
    this.why = '';
    const t0 = performance.now();
    const headers = {};
    if (this.got > 0) {
      headers.Range = `bytes=${this.got}-`;
      if (this.sameOrigin && this.etag) headers['If-Range'] = this.etag;
    }
    let stall = setTimeout(() => this.pause('stall'), 8000);
    this.tByte = t0;
    const kick = () => { clearTimeout(stall); stall = setTimeout(() => this.pause('stall'), 6000); this.tByte = performance.now(); };
    try {
      const r = await fetch(this.url, { signal: ctrl.signal, headers });
      if (!r.ok) throw new Error(`${this.url.split('/').slice(-2).join('/')}: HTTP ${r.status}`);
      const len = Number(r.headers.get('content-length')) || 0;
      // a resume must continue the same file (206 with exactly the bytes left); anything else starts over
      if (this.got > 0 && (r.status !== 206 || (this.total && len && this.got + len !== this.total))) { this.got = 0; this.buf = null; }
      if (r.status === 200 && len) this.total = len;
      if (r.status === 200 && this.got === 0) this.keep?.(r.clone());
      this.etag = r.headers.get('etag') || this.etag;
      const tH = performance.now();
      this.net.sampleTTFB((tH - t0) / 1000);
      kick();
      if (this.total && (!this.buf || this.buf.byteLength < this.total)) {
        const nb = new Uint8Array(this.total);
        if (this.buf && this.got) nb.set(this.buf.subarray(0, this.got));
        this.buf = nb;
      }
      // a BYOB reader bounds each step (256 KB into a scratch buffer, then one copy into the file's buffer, which never
      // leaves our hands, so a pause keeps every byte); without one, chunk by chunk. A fast link delivers megabytes
      // faster than a frame, so the loop also yields a macrotask every few ms: a download never makes a long task.
      let byob = null, scratch = null;
      try { byob = r.body.getReader({ mode: 'byob' }); scratch = new Uint8Array(BYOB_STEP); } catch (e) { byob = null; }
      const reader = byob || r.body.getReader();
      let tL = tH, bL = 0, busy = 0, since = 0;
      const got0 = this.got;
      for (;;) {
        // yield after a few ms of copying or a megabyte (the browser's own copy into each chunk is not measurable here)
        if (busy > SLICE_MS || since > YIELD_BYTES) { await yieldTask(); busy = 0; since = 0; }
        let value;
        if (byob) {
          const res = await byob.read(new Uint8Array(scratch.buffer, 0, BYOB_STEP));
          if (res.done) break;
          value = res.value;
          scratch = new Uint8Array(value.buffer);             // the read transferred the scratch: reuse what came back
        } else {
          const res = await reader.read();
          if (res.done) break;
          value = res.value;
        }
        if (!this.buf || this.got + value.byteLength > this.buf.byteLength) {   // size unknown or larger than announced
          const nb = new Uint8Array(Math.max(this.got + value.byteLength, Math.ceil((this.buf?.byteLength || 1 << 20) * 1.5)));
          if (this.buf) nb.set(this.buf.subarray(0, this.got));
          this.buf = nb;
        }
        const tc = performance.now();
        this.buf.set(value, this.got);
        const n = value.byteLength;
        kick();
        this.got += n;
        bL += n;
        const now = performance.now();
        busy += now - tc;
        since += n;
        if (now - tL > 350) { this.net.sample(bL, (now - tL) / 1000); tL = now; bL = 0; }
        onProgress?.(this.got, this.total);
      }
      if (this.net.n) this.net.sample(bL, (performance.now() - tL) / 1000);
      else this.net.sample(this.got - got0, (performance.now() - tH) / 1000, true);
      this.bytes = this.got === this.buf.byteLength ? this.buf : this.buf.slice(0, this.got);
      this.total = this.got;
      this.buf = null;
      return this.bytes;
    } catch (e) {
      // paused, stalled or failed: keep exactly what arrived (shrunk, so the budget counts the real size)
      if (this.buf) this.buf = this.got ? this.buf.slice(0, this.got) : null;
      if (this.why === 'stall') throw Object.assign(new Error('stall'), { stall: true });
      if (ctrl.signal.aborted) throw abortError(this.why);
      throw e;
    } finally {
      clearTimeout(stall);
      this.ctrl = null;
    }
  }
}

/**
 * A small request (a camera track, a point prefix) with a stall watchdog: no answer in 8 s, or a body slower than 20 KB/s,
 * fails it as a stall (backoff and retry). SP: without one, two requests to a host that hangs held both light slots for
 * good (asset host stalled: the camera tracks of chapters 2 and 3 never started, so chapter 3 never went 3-D).
 * onAnswer() runs when the response headers arrive. (The body is read whole: read chunk by chunk, Chrome's throttled
 * runs reported the finished requests as canceled.)
 */
async function fetchBytes(url, signal, headers = {}, onAnswer = null, expect = 0) {
  if (signal.aborted) throw abortError(signal.reason?.message);
  const c = new AbortController();
  let stalled = false, timer = 0;
  const arm = ms => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; c.abort(); }, ms); };
  const relay = () => c.abort(signal.reason);
  signal.addEventListener('abort', relay, { once: true });
  arm(8000);
  try {
    const r = await fetch(url, { signal: c.signal, headers });
    const tH = performance.now();
    onAnswer?.();
    if (!r.ok) throw new Error(`${url.split('/').slice(-2).join('/')}: HTTP ${r.status}`);
    arm(Math.max(6000, (Number(r.headers.get('content-length')) || expect) / 20));
    return { r, tH, bytes: new Uint8Array(await r.arrayBuffer()) };
  } catch (e) {
    if (stalled && !signal.aborted) throw Object.assign(new Error('stall'), { stall: true });
    throw e;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', relay);
  }
}

async function getRange(url, a, b, signal, onAnswer) {
  const { r, bytes } = await fetchBytes(url, signal, { Range: `bytes=${a}-${b - 1}` }, onAnswer, b - a);
  return r.status === 206 ? bytes : bytes.subarray(a, b);
}

/**
 * islands: {id: {files (maps.json sizes), points (atlas.json points.bin facts), cut: {file, bytes} | null}}
 * asset(id, file) -> URL; params: the tier's; hooks: {log(ev, ch, extra), onPart(id, part, data), onProgress(id, part,
 * got, total), onStall(id, part)}. Parts: 'traj', 'dense', 'cut', 'lite', 'standard'.
 */
export class Loader {
  constructor({ islands, asset, params, hooks }) {
    this.asset = asset; this.params = params; this.hooks = hooks;
    const first = Object.keys(islands)[0];
    const assetLocal = new URL(asset(first, 'x'), location.href).origin === location.origin;
    this.nets = { site: new Net('site', { phone: params.phone, local: true }), assets: new Net('assets', { phone: params.phone, local: assetLocal }) };
    this.I = {};
    for (const [id, d] of Object.entries(islands)) this.I[id] = { id, files: d.files || {}, points: d.points || null, cut: d.cut || null, parts: {} };
    this.view = null;
    this.paused = new Set();
    this.intents = new Map();       // id -> {why, at}
    this.decodeS = params.phone ? 1.4 : 0.6;
    this.lru = [];
    this.stdDone = new Set();
    this.infeasible = new Map();     // id -> part last found infeasible (logged once per verdict)
    this.stalled = false;
    this.noSplats = false;           // O1: set when this device's splats drew nothing (stopSplats)
    addEventListener('online', () => {
      for (const isl of Object.values(this.I)) for (const p of Object.values(isl.parts)) if (p.state === 'failed' && !p.online) { p.state = 'idle'; p.tries = 2; p.next = 0; p.online = true; }
      this.replan();
    });
  }
  net(name) { return name === 'cut' ? this.nets.site : this.nets.assets; }
  part(id, name) {
    const isl = this.I[id];
    return isl.parts[name] || (isl.parts[name] = { name, state: 'idle', tries: 0, next: 0, dl: null, data: null, ctrl: null, released: false });
  }
  /** Delivered: downloaded, or already handed to the 3-D layer. */
  delivered(id, name) { const p = this.I[id]?.parts[name]; return !!p && (p.state === 'done' || p.released); }
  data(id, name) { return this.I[id]?.parts[name]?.data ?? null; }
  /** The next splat file an island needs on this tier, or null. Phones stop at the first; desktops go cut -> Lite. */
  nextBig(id) {
    if (this.noSplats) return null;
    const tiers = this.params.splatTiers, isl = this.I[id];
    // WIRE: desktops (no 'cut' in their tiers) start with the cut only while the asset host is slow (< 40 Mbit/s, e.g.
    // Hugging Face measured 10-14 Mbit/s here): the cut comes from the site's own origin and is half a Lite file. On a
    // fast link they go straight to Lite (no second file, no second upload). A cut once begun is kept as the first step.
    const cutBegun = isl.parts.cut && isl.parts.cut.state !== 'idle';
    const slowAssets = this.nets.assets.bw * 8 < 40e6;
    const first = isl.cut && (tiers.includes('cut') || (!this.params.phone && (cutBegun || (slowAssets && !this.delivered(id, 'lite'))))) ? 'cut' : 'lite';
    if (!this.delivered(id, first)) return first;
    if (first === 'cut' && tiers.includes('lite') && !this.params.phone && !this.delivered(id, 'lite')) return 'lite';
    return null;
  }
  size(id, name) {
    const isl = this.I[id];
    if (name === 'cut') return isl.cut?.bytes || 0;
    if (name === 'lite') return isl.files['splats_lite.spz'] || 12e6;
    if (name === 'standard') return isl.files['splats.spz'] || 40e6;
    if (name === 'traj') return isl.cut?.track_bytes || isl.files['traj.json'] || 2e5;
    if (name === 'dense') return Math.min(isl.points?.count || 0, this.params.densePts) * (isl.points?.colour === 'rgb8' ? 9 : 7);
    return 0;
  }
  left(id, name) {
    const p = this.I[id]?.parts[name];
    if (p && (p.state === 'done' || p.released)) return 0;
    return p?.dl ? p.dl.left() : this.size(id, name);
  }
  /** An upgrade: a desktop's Lite over the cut it already shows (slow asset host). Release QA: once the reader moves, an
   * upgrade ranks below what the islands ahead need first (their light parts, then their first splats). At 9 Mbit/s the
   * hero's 10.67 MB Lite held the one big-file slot for 20-26 s and chapter 1 never went 3-D; at 16 Mbit/s chapter 1's
   * Lite, fetched in its own ride, held chapter 3's light parts and so chapter 2's cut, which came 2.5 s into its ride. */
  upgrade(id, name) { return name === 'lite' && !this.params.phone && this.delivered(id, 'cut'); }
  running() { const out = []; for (const isl of Object.values(this.I)) for (const p of Object.values(isl.parts)) if (p.state === 'running') out.push([isl.id, p]); return out; }
  bigRunning() { return this.running().find(([, p]) => BIG.has(p.name)) || null; }

  /**
   * SP: a file that failed for good, or is waiting out a failure's backoff, gives way: it used to hold the one big-file
   * slot (and the light parts behind it) for its 2 + 8 s of backoff (asset host down: the chapters' site cuts waited
   * 10 s behind the hero's failing Lite file).
   */
  backingOff(id, name) { const p = this.I[id]?.parts[name]; return !!p && p.state !== 'running' && (p.state === 'failed' || performance.now() < p.next); }
  /** SP: a running light part that has its answer, or asked less than 2 s ago (else: a host that hangs). */
  alive(q) { return q.state === 'running' && (q.answered || performance.now() - q.t0 <= 2000); }
  /** SP: a running big file with no byte for 2 s (no answer yet, or a host that hangs): it uses no bandwidth, so it holds
   * neither the big-file slot against another origin nor the light parts behind it. */
  silent(id, name) { const p = this.I[id]?.parts[name]; return !!p?.dl && p.state === 'running' && performance.now() - p.dl.tByte > 2000; }
  /** An explore intent: 'dive' > 'tap' / 'select' > 'hover'. */
  want(id, why) {
    if (!this.I[id]) return;
    const cur = this.intents.get(id);
    if (!cur || RANK[why] >= RANK[cur.why]) this.intents.set(id, { why, at: performance.now() });
    this.hooks.log('intent', null, { id, why });
    this.replan();
  }
  clearIntent(id) { this.intents.delete(id); }
  /** Pause everything (off screen, curtain, story, hidden tab); resumable. */
  pause(why) {
    this.paused.add(why);
    for (const [, p] of this.running()) this.stop(p, `paused (${why})`);
  }
  resume(why) { if (this.paused.delete(why) && !this.paused.size) this.replan(); }
  stop(p, why) { p.ctrl?.abort(abortError(why)); p.dl?.pause(why); }
  replan() { if (this.view) this.plan(this.view); }
  /** The 3-D layer took the bytes: unless the tier keeps them (desktops), no JS copy stays (re-visits use the Cache API). */
  release(id, name) {
    const p = this.I[id]?.parts[name];
    if (!p) return;
    p.released = true;
    if (!this.params.keepBytes || name === 'standard') { p.data = null; p.state = 'idle'; }
  }
  /** The 3-D layer dropped an island's splats: deliver the kept bytes again later, or fetch them again (cache first). */
  forget(id, name) {
    const p = this.I[id]?.parts[name];
    if (!p) return;
    p.released = false;
    if (!p.data && p.state === 'done') p.state = 'idle';
  }
  /** Re-deliver kept bytes (an island coming back into range). Returns true when it did. */
  redeliver(id, name) {
    const p = this.I[id]?.parts[name];
    if (!p?.data || p.released) return false;
    this.touch(id);
    this.hooks.onPart(id, name, p.data);
    return true;
  }
  held() {
    let b = 0;
    for (const isl of Object.values(this.I)) for (const p of Object.values(isl.parts)) if (BIG.has(p.name)) b += p.data?.byteLength || p.dl?.held() || 0;
    return b;
  }
  /** Keep the held bytes under the tier's budget: least recently used first, skipping (not stopping at) protected ids. */
  trim(protect = []) {
    let over = this.held() - this.params.byteCache;
    for (const id of this.lru.slice()) {
      if (over <= 0) break;
      if (protect.includes(id)) continue;
      for (const name of ['standard', 'lite', 'cut']) {
        const p = this.I[id].parts[name];
        if (!p || p.state === 'running') continue;
        const b = p.data?.byteLength || p.dl?.held() || 0;
        if (!b) continue;
        p.data = null; p.uncached = null; p.dl?.drop(); p.dl = null;
        if (p.state !== 'failed') p.state = 'idle';
        over -= b;
        this.hooks.log('evict', null, { id, part: name, mb: +(b / 1e6).toFixed(1) });
      }
    }
  }
  touch(id) { this.lru = this.lru.filter(x => x !== id); this.lru.push(id); }
  /** O1: this device draws no splats: nothing more is fetched or kept for them this visit (light parts carry on). */
  stopSplats() {
    this.noSplats = true;
    for (const isl of Object.values(this.I)) for (const p of Object.values(isl.parts)) {
      if (!BIG.has(p.name)) continue;
      if (p.state === 'running') this.stop(p, 'no splats on this device');
      p.data = null; p.uncached = null; p.dl?.drop(); p.dl = null; p.released = false;
      if (p.state !== 'failed' && p.state !== 'running') p.state = 'idle';
    }
  }

  start(id, name, why) {
    const p = this.part(id, name);
    if (p.state === 'running' || p.state === 'done' || p.state === 'failed' || performance.now() < p.next) return false;
    const ctrl = p.ctrl = new AbortController();
    p.state = 'running'; p.t0 = performance.now(); p.answered = false;
    const left = this.left(id, name);
    this.hooks.log('dl-start', null, { id, part: name, why, mb: +(left / 1e6).toFixed(2), eta: +this.net(name).eta(left).toFixed(2) });
    this._run(id, p, ctrl).then(data => {
      p.state = 'done'; p.data = data; p.tries = 0; p.released = false;
      // WIRE: Lite supersedes the cut: its bytes leave the budget at once (the cut and Lite of four islands overflowed a
      // desktop's byte cache, and the LRU then refetched both)
      const cut = this.I[id].parts.cut;
      if (name !== 'cut' && BIG.has(name) && cut && cut.state !== 'running' && cut.state !== 'idle') { cut.data = null; cut.uncached = null; cut.dl?.drop(); cut.dl = null; cut.state = 'done'; }
      const bytes = data?.byteLength ?? (data?.pos ? data.pos.byteLength + data.col.byteLength : this.size(id, name));
      this.hooks.log('dl-done', null, { id, part: name, mb: +(bytes / 1e6).toFixed(2), s: +((performance.now() - p.t0) / 1000).toFixed(2), bw_mbps: this.net(name).info().bw_mbps });
      if (BIG.has(name)) this.touch(id);
      this.hooks.onPart(id, name, data);
      if (BIG.has(name)) this.intents.delete(id);
    }).catch(e => {
      if (e?.name === 'AbortError') {
        p.state = p.dl?.got ? 'paused' : 'idle';
        this.hooks.log(p.state === 'paused' ? 'dl-pause' : 'dl-abort', null, { id, part: name, why: e.message, mb: +((p.dl?.got || 0) / 1e6).toFixed(2) });
        return;
      }
      p.tries++;
      p.next = performance.now() + 2000 * Math.pow(4, p.tries - 1);
      p.state = p.tries >= 3 ? 'failed' : (p.dl?.got ? 'paused' : 'idle');
      if (e?.stall) { this.stalled = true; this.hooks.onStall?.(id, name); }
      this.hooks.log('dl-fail', null, { id, part: name, why: String(e?.message || e).slice(0, 120), tries: p.tries });
      if (p.state !== 'failed') setTimeout(() => this.replan(), p.next - performance.now() + 20);
    }).finally(() => {
      p.ctrl = null;
      this.replan();
    });
    return true;
  }
  async _run(id, p, ctrl) {
    const isl = this.I[id], A = f => this.asset(id, f), net = this.net(p.name), onAnswer = () => { p.answered = true; };
    // SP: four maps on every tier. The Cache API lives on disk, not in the tab's memory, and with one map phones
    // re-downloaded every cut, track and point prefix on each return (3 down / up passes: 81.7 MB instead of 29.6 MB)
    const maxMaps = 4;
    if (p.name === 'traj') {
      // SP: an island with a ride cut reads xclean's track from the site (data/cuts/<id>.track.json, the same poses as
      // traj.json), next to its cut: no asset-host round trip on the first 3-D frame, and the cut still plays when the
      // asset host is down. The asset host's traj.json is the fallback.
      const urls = [...(isl.cut?.track ? [new URL(isl.cut.track, document.baseURI).href] : []), A('traj.json')];
      for (let k = 0; ; k++) {
        try { return await this._json(urls[k], urls[k].startsWith(location.origin) ? this.nets.site : net, ctrl.signal, maxMaps, onAnswer); }
        catch (e) { if (e?.name === 'AbortError' || ctrl.signal.aborted || k === urls.length - 1) throw e; }
      }
    }
    if (p.name === 'dense') {
      // a uniform prefix of points.bin (its order is a random permutation): positions, then colours, two Range requests
      // whose offsets come from atlas.json (no points.json round trip). SP: both slices are kept in the Cache API (under
      // the stable URL + the byte range), so a return to the island does not fetch them again.
      const m = isl.points, n = Math.min(m.count, this.params.densePts), cb = m.colour === 'rgb8' ? 3 : 1;
      const url = A('points.bin'), t0 = performance.now();
      const ra = [0, n * 6], rb = [m.colour_offset, m.colour_offset + n * cb];
      const [ka, kb] = [ra, rb].map(r => `bytes=${r[0]}-${r[1] - 1}`);
      let [pos, col] = await Promise.all([cachedBytes(url, ka), cachedBytes(url, kb)]);
      if (pos?.byteLength === ra[1] - ra[0] && col?.byteLength === rb[1] - rb[0]) this.hooks.log('cache-hit', null, { id, part: 'dense', mb: +((pos.byteLength + col.byteLength) / 1e6).toFixed(2) });
      else {
        [pos, col] = await Promise.all([getRange(url, ra[0], ra[1], ctrl.signal, onAnswer), getRange(url, rb[0], rb[1], ctrl.signal, onAnswer)]);
        net.sample(pos.byteLength + col.byteLength, (performance.now() - t0) / 1000, true);
        // a Response copies its bytes: at idle, never in the frame that hands the points to the scene
        idleCall(() => { putBytes(url, pos, { maxMaps, part: ka }); putBytes(url, col, { maxMaps, part: kb }); });
      }
      return { n, pos: new Uint16Array(pos.buffer, pos.byteOffset, n * 3), col, meta: m };
    }
    const url = p.name === 'cut' ? new URL(isl.cut.file, document.baseURI).href : A(p.name === 'lite' ? 'splats_lite.spz' : 'splats.spz');
    // O3: a file whose copy into the Cache API has not finished yet is still held here: a phone's fast down / up pass
    // evicted an island for a decode slot right after its cut arrived, planned it again 1 ms later, missed the cache
    // (still being written) and downloaded the 5.35 MB a second time
    if (p.uncached) { this.hooks.log('cache-hit', null, { id, part: p.name, mb: +(p.uncached.byteLength / 1e6).toFixed(2), src: 'kept' }); return p.uncached; }
    if (p.name !== 'standard' && !p.dl) {
      const hit = await cachedBytes(url);
      if (hit) { this.hooks.log('cache-hit', null, { id, part: p.name, mb: +(hit.byteLength / 1e6).toFixed(2) }); return hit; }
    }
    if (ctrl.signal.aborted) throw abortError(ctrl.signal.reason?.message);
    if (!p.dl) {
      p.dl = new Download(url, this.size(id, p.name), net, { sameOrigin: new URL(url).origin === location.origin,
        keep: p.name === 'standard' ? null : res => { p.streamed = putResponse(url, res, { maxMaps }); } });
    }
    const dl = p.dl;
    const onAbort = () => dl.pause(ctrl.signal.reason?.message || 'aborted');
    ctrl.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const bytes = await dl.run((got, tot) => this.hooks.onProgress?.(id, p.name, got, tot));
      // a file that could not stream into the cache (paused and resumed by Range) is stored at idle, as a copy. O3: the
      // part keeps a reference to the bytes until the cache holds them (or has refused them; 15 s at most)
      if (p.name !== 'standard') {
        p.uncached = bytes;
        const stored = () => { if (p.uncached === bytes) p.uncached = null; };
        setTimeout(stored, 15000);
        (p.streamed || Promise.resolve(false)).then(ok => { if (ok) stored(); else idleCall(() => putBytes(url, bytes, { maxMaps }).then(stored, stored)); });
      }
      p.streamed = null;
      p.dl = null;
      return bytes;
    } finally {
      ctrl.signal.removeEventListener('abort', onAbort);
    }
  }
  /** A small JSON file (a camera track), from the Cache API or the network (then cached). */
  async _json(url, net, signal, maxMaps, onAnswer) {
    let buf = await cachedBytes(url);
    if (!buf) {
      const t0 = performance.now(), got = await fetchBytes(url, signal, {}, onAnswer);
      buf = got.bytes;
      net.sampleTTFB((got.tH - t0) / 1000);
      net.sample(buf.byteLength, (performance.now() - got.tH) / 1000, true);
      putBytes(url, buf, { maxMaps });
    }
    return JSON.parse(new TextDecoder().decode(buf));
  }
  /** Pause a big file for another one, unless it is nearly done or is the hero's. Returns true when it yielded. */
  yieldBig(id, p, why, hero) {
    const dl = p.dl;
    if (id === hero) return false;
    if (dl && (dl.frac() > 0.75 || this.net(p.name).eta(dl.left()) < 2)) return false;
    this.stop(p, why);
    return true;
  }

  /**
   * view: {y, H, vInst (px/s, signed), vAvg (px/s), dir (+1 / -1), engaged, offscreen, cur (island on screen or ''),
   *        hero, stops: [{id, y (scroll y where its splats are needed), leave (where it leaves)}], std (id or null),
   *        holdLight (true until the first 3-D frame: nothing but the first screen's own files)}
   */
  plan(view) {
    this.view = view;
    if (this.paused.size || view.offscreen) {
      for (const [, p] of this.running()) this.stop(p, view.offscreen ? 'off screen' : 'paused');
      return;
    }
    const { y, H } = view, dir = view.dir || 1;
    const speed = view.engaged ? Math.max(Math.abs(view.vInst), view.vAvg || 0, 0.1 * H) : 0.1 * H;
    const fling = Math.abs(view.vInst) > 2.5 * H;
    const stops = view.stops;
    const landing = fling ? (stops.filter(s => s.y - H <= y + view.vInst * 0.45).pop() || stops[0])?.id : null;
    const timeTo = s => Math.max(0, (dir > 0 ? s.y - y : y - s.leave) / speed);
    // how long the visitor will stay before leaving island s: at their average pace (a wheel burst is not their pace),
    // or at the flick's speed during a flick
    const stay = fling ? Math.abs(view.vInst) : Math.max(view.vAvg || 0, 0.1 * H);
    const timeLeave = s => Math.max(0, (dir > 0 ? s.leave - y : y - (s.y - H)) / stay);
    const cur = stops.find(s => s.id === view.cur);
    const ahead = stops.filter(s => s !== cur && (dir > 0 ? s.leave > y : s.y - H < y)).sort((a, b) => (dir > 0 ? a.y - b.y : b.y - a.y));
    const order = [...(cur ? [cur] : []), ...ahead.slice(0, this.params.lookahead)];
    // big files may look past the lookahead: when every nearer island is infeasible, the next feasible one gets the slot
    const bigOrder = [...(cur ? [cur] : []), ...ahead];
    const allowed = s => !fling || s.id === view.cur || s.id === landing;
    // behind the direction of travel (flown past); while moving, such an island neither gets nor keeps the big slot
    const moving = Math.abs(view.vInst) > 0.2 * H;
    const behind = s => (dir > 0 ? s.leave < y : s.y - H > y);

    // 1. light parts (at most two in flight): the islands on screen and ahead, then explore intents. The camera path
    // starts with the island's splats; the dense prefixes (for the views from above) wait until the splats of the
    // island on screen are in, so they never take bandwidth from the first 3-D frame
    const lightIds = [...order.filter(allowed).map(s => s.id), ...[...this.intents.keys()]];
    const curName = view.cur && this.nextBig(view.cur);
    // (an upgrade on screen holds nothing back once the reader moves: upgrade())
    const curUp = view.engaged && curName && this.upgrade(view.cur, curName);
    const curBig = view.holdLight || (curName && !curUp && !this.backingOff(view.cur, curName) && !this.silent(view.cur, curName));
    for (const id of lightIds) {
      for (const name of ['traj', 'dense']) {
        // at most two light parts in flight; SP: one still unanswered after 2 s (a host that hangs) does not count
        if (this.running().filter(([, q]) => !BIG.has(q.name) && this.alive(q)).length >= 2) break;
        if (name === 'dense' && (!this.I[id].points || curBig)) continue;
        if (name === 'traj' && curBig && id !== view.cur && !this.intents.has(id)) continue;
        const p = this.part(id, name);
        if (p.state === 'idle' || p.state === 'paused') this.start(id, name, id === view.cur ? 'on screen' : this.intents.has(id) ? `intent ${this.intents.get(id).why}` : 'ahead (light first)');
      }
    }
    // SP: a part waiting out a failure's backoff is not pending (a failed optional part never blocks the splats, SP-4:
    // with the asset host down, each failing point prefix used to hold its island's cut back for 10 s)
    // and a request still unanswered after 2 s (a host that hangs) is not pending either
    const pendingLight = (id, n) => {
      const q = this.part(id, n);
      return q.state === 'running' ? this.alive(q) : (q.state === 'idle' || q.state === 'paused') && !q.tries;
    };
    const lightPending = order.some(s => s !== cur && ['traj', 'dense'].some(n => (n === 'traj' || this.I[s.id].points) && pendingLight(s.id, n)));

    // 2. who wants the one big-file slot, most urgent first
    const want = [];
    for (const [id, it] of [...this.intents].sort((a, b) => RANK[b[1].why] - RANK[a[1].why])) {
      if (it.why === 'hover' && this.params.phone) continue;
      const name = this.nextBig(id);
      if (!name) { this.intents.delete(id); continue; }
      if (this.backingOff(id, name)) continue;
      want.push({ id, name, urgent: it.why !== 'hover', why: `intent ${it.why}` });
    }
    let prefetch = null, nearer = 0, bestEffort = null, upNext = null;
    for (const s of bigOrder) {
      // SP: an island flown past is skipped here too: the best-effort rule used to restart the file that rule 3 had just
      // paused, a new request every plan through the second half of each pull-back
      if (!allowed(s) || (moving && behind(s))) continue;
      if (!order.includes(s) && (nearer > 0 || want.length)) break;     // past the lookahead only when nothing nearer qualifies
      const name = this.nextBig(s.id);
      if (!name || this.backingOff(s.id, name)) continue;
      const net = this.net(name);
      const T = s === cur ? 0 : timeTo(s);
      const D = net.eta(this.left(s.id, name)) + this.decodeS;
      const feasible = s.id === view.hero || !view.engaged || D <= timeLeave(s) - 2;
      if (!feasible) {
        if (this.infeasible.get(s.id) !== name) this.hooks.log('infeasible', null, { id: s.id, part: name, D: +D.toFixed(1), leave_s: +timeLeave(s).toFixed(1) });
        this.infeasible.set(s.id, name);
        const margin = timeLeave(s) - D;
        // (not an upgrade: an island that shows its cut gains little from a Lite that lands after the reader has gone,
        // and at 9 Mbit/s chapter 1's, best effort at D 56 s, slowed the light parts that chapter 2's cut waits for)
        if (!this.upgrade(s.id, name) && (!bestEffort || margin > bestEffort.margin)) bestEffort ={ id: s.id, name, urgent: false, margin, why: `best effort, link idle (D ${D.toFixed(1)} s)` };
        continue;
      }
      this.infeasible.delete(s.id);
      // WIRE: a nearer island still fetching its light parts holds the slot for itself (counted as nearer): skipping it
      // without counting let the loop look past the lookahead and give the slot to chapter 3 before chapter 1 (M4 4G)
      if (s !== cur && lightPending && order.includes(s)) { nearer++; continue; }
      nearer++;
      if (s === cur && curUp) upNext = { id: s.id, name, urgent: false, why: 'upgrade on screen' };     // after the others
      else if (s === cur) want.push({ id: s.id, name, urgent: true, why: 'on screen' });
      else if (T <= 1.5 * D + 1) want.push({ id: s.id, name, urgent: false, why: `T ${T.toFixed(1)} s <= 1.5 D + 1 (D ${D.toFixed(1)} s)` });
      else if (!prefetch && view.engaged) prefetch = { id: s.id, name, urgent: false, why: 'idle prefetch' };
    }
    // (an upgrade in flight counts as an idle link here: it gives way to first splats, below; an upgrade ahead waits for
    // the one on screen)
    const run0 = this.bigRunning(), idle = !run0 || (view.engaged && this.upgrade(run0[0], run0[1].name));
    const after = x => upNext && this.upgrade(x.id, x.name);
    if (prefetch && !want.length && idle && !after(prefetch)) want.push(prefetch);
    // nothing feasible and the link idle: the island with the best margin still gets it (a reader who slows down sees it)
    if (bestEffort && !want.length && idle && view.engaged && !fling && !after(bestEffort)) want.push(bestEffort);
    if (upNext) want.push(upNext);
    if (view.std && !this.noSplats && this.params.splatTiers.includes('standard') && !this.stdDone.has(view.std) && !this.running().length
      && this.nets.assets.eta(this.left(view.std, 'standard')) <= 12) want.push({ id: view.std, name: 'standard', urgent: false, why: 'standard: the ride in view' });

    // 3. flown past: files of islands behind the direction of travel are paused (resumable)
    if (moving) {
      for (const [id, p] of this.running()) {
        if (!BIG.has(p.name) || this.intents.has(id) || want.some(w => w.id === id)) continue;
        const s = stops.find(x => x.id === id);
        if (s && behind(s)) this.yieldBig(id, p, 'flown past', this.upgrade(id, p.name) ? null : view.hero);    // the hero's upgrade too
      }
    }
    const w = want[0];
    if (!w) return;
    const run = this.bigRunning();
    if (run) {
      const [rid, rp] = run;
      if (rid === w.id && rp.name === w.name) return;
      // SP: beside a silent file from another origin (an asset host that hangs), the wanted file starts at once; it used
      // to wait out the silent file's stall and retries (hero's Lite on a hung host: chapter 1's site cut waited 18 s)
      const beside = this.silent(rid, rp.name) && this.net(rp.name) !== this.net(w.name);
      // an upgrade in flight is paused (resumable) for another island's first splats once the reader moves, the hero's
      // too: its cut is already on screen (the never-abort rule protects the hero's first file)
      const first = view.engaged && rid !== w.id && w.name !== 'standard' && this.upgrade(rid, rp.name) && !this.upgrade(w.id, w.name);
      if (!beside && !(first && this.yieldBig(rid, rp, `${w.id} ${w.why} goes before an upgrade`, null))
        && (!w.urgent || !this.yieldBig(rid, rp, `${w.id} ${w.why} goes first`, view.hero))) return;
    }
    if (w.name === 'standard') this.stdDone.add(w.id);
    this.start(w.id, w.name, w.why);
  }
  info() {
    const parts = {};
    for (const isl of Object.values(this.I)) {
      const o = {};
      for (const p of Object.values(isl.parts)) o[p.name] = (p.state === 'running' && p.dl ? `${Math.round(p.dl.frac() * 100)}%` : p.state) + (p.released ? '+gpu' : '');
      if (Object.keys(o).length) parts[isl.id] = o;
    }
    return { nets: { site: this.nets.site.info(), assets: this.nets.assets.info() }, held_mb: +(this.held() / 1e6).toFixed(1), parts, intents: [...this.intents.keys()], stalled: this.stalled };
  }
}
