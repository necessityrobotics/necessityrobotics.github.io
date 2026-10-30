// Necessity Robotics viewer (ported from the approved review viewer) — asset loading: small JSON, the progressive point cloud, the optional LITE splat sidecar, the films
// index, and a per-asset load timeline (performance marks; window.__viewer.loadLog for QA and VIEWER_NOTES.md).
//
// points.bin (DESIGN §8) is planar: count x 3 uint16 positions, then count x (1 | 3) colour bytes, and its points are a
// random permutation, so ANY PREFIX IS A UNIFORM SUBSAMPLE. The cloud is fetched as HTTP Range chunks of matching
// positions + colours (first 250 k points, then 400 k at a time); each chunk is drawn as soon as it lands. Nothing is
// de-quantised on the CPU: the uint16 positions are a normalised vertex attribute and the object transform maps them
// into the map frame (layers.js), so a chunk costs a typed-array view and one small GPU upload.

const T0 = performance.timeOrigin;
export const loadLog = [];   // {row, asset, url, bytes, start, end, onScreen} in ms since navigation start

export function logStart(row, asset, url, bytes = null) {
  const rec = { row, asset, url, bytes, start: +performance.now().toFixed(1), end: null, onScreen: null };
  loadLog.push(rec);
  try { performance.mark(`xv:${row}:${asset}:start`); } catch (e) { /* ignore */ }
  return rec;
}
export function logEnd(rec, extra = {}) {
  if (!rec) return;
  rec.end = +performance.now().toFixed(1);
  Object.assign(rec, extra);
  try { performance.mark(`xv:${rec.row}:${rec.asset}:end`); } catch (e) { /* ignore */ }
}
export function logOnScreen(rec) {
  if (rec && rec.onScreen == null) rec.onScreen = +performance.now().toFixed(1);
}
export const navStart = () => T0;

/** JSON with byte progress (onProgress(loaded, total)). */
export async function fetchJSON(url, { signal, onProgress } = {}) {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  if (!onProgress || !r.body) return r.json();
  const total = Number(r.headers.get('content-length')) || 0;
  const reader = r.body.getReader();
  const parts = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.byteLength;
    onProgress(loaded, total);
  }
  const blob = new Blob(parts);
  return JSON.parse(await blob.text());
}

async function rangeBuffer(url, a, b, signal) {
  const r = await fetch(url, { headers: { Range: `bytes=${a}-${b - 1}` }, signal });
  if (!(r.status === 206 || r.status === 200)) throw new Error(`${url}: HTTP ${r.status}`);
  const buf = await r.arrayBuffer();
  return { buf, whole: r.status === 200 };
}

/**
 * Stream points.bin in Range chunks. onChunk({start, count, pos: Uint16Array(count*3), col: Uint8Array(count*cb)}) is
 * called in order; onProgress(loadedBytes, totalBytes). Falls back to one whole-file request if Range is ignored.
 */
export async function loadPointChunks(url, meta, { signal, onChunk, onProgress, first = 250000, step = 400000 } = {}) {
  const n = meta.count;
  const cb = meta.colour === 'rgb8' ? 3 : 1;
  const colOff = meta.colour_offset ?? n * 6;
  const total = n * 6 + n * cb;
  const plan = [];
  for (let s = 0; s < n;) { const c = Math.min(n - s, plan.length ? step : first); plan.push([s, c]); s += c; }
  let loaded = 0;
  for (let k = 0; k < plan.length; k++) {
    const [s, c] = plan[k];
    // the first chunk probes Range support with the positions alone (a server that ignores Range answers 200 with
    // the whole file: then that one response is used and nothing is fetched twice)
    let P, Cc;
    if (k === 0) {
      P = await rangeBuffer(url, s * 6, (s + c) * 6, signal);
      if (P.whole) {
        const buf = P.buf;
        onChunk({ start: 0, count: n, pos: new Uint16Array(buf, 0, n * 3), col: new Uint8Array(buf, colOff, n * cb) });
        onProgress?.(total, total);
        return;
      }
      Cc = await rangeBuffer(url, colOff + s * cb, colOff + (s + c) * cb, signal);
    } else {
      // later chunks: positions and colours in parallel
      [P, Cc] = await Promise.all([rangeBuffer(url, s * 6, (s + c) * 6, signal), rangeBuffer(url, colOff + s * cb, colOff + (s + c) * cb, signal)]);
    }
    loaded += P.buf.byteLength + Cc.buf.byteLength;
    onChunk({ start: s, count: c, pos: new Uint16Array(P.buf), col: new Uint8Array(Cc.buf) });
    onProgress?.(loaded, total);
  }
}

/** Yield to the event loop (a macrotask; not throttled like rAF in hidden tabs). */
export const yieldTask = () => new Promise(r => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });
