// Necessity Robotics viewer: asset loading. Small files and the splats come through the shared map cache when the site
// has it (js/world/cache.js, keyed by the stable map-host URL), so a map the home page or an earlier visit already
// fetched opens without downloading it again (SB-3); the point cloud streams in HTTP Range chunks.
//
// points.bin (DESIGN §8) is planar: count x 3 uint16 positions, then count x (1 | 3) colour bytes, and its points are a
// random permutation, so ANY PREFIX IS A UNIFORM SUBSAMPLE. The cloud is fetched as HTTP Range chunks of matching
// positions + colours (first 250 k points, then 400 k at a time); each chunk is drawn as soon as it lands. Nothing is
// de-quantised on the CPU: the uint16 positions are a normalised vertex attribute and the object transform maps them
// into the map frame (layers.js), so a chunk costs a typed-array view and one small GPU upload.

// the shared map cache, or null (a browser without the Cache API, or a site build without it)
const CACHE = import('../world/cache.js').catch(() => null);

/** The whole body of a response as bytes, streamed into one buffer, with onProgress(loaded, total). */
async function readBytes(r, onProgress) {
  const total = Number(r.headers.get('content-length')) || 0;
  // a compressed answer's Content-Length is its compressed size: never size the buffer from it then
  const exact = total && !r.headers.get('content-encoding');
  if (!r.body) { const b = new Uint8Array(await r.arrayBuffer()); onProgress?.(b.length, b.length); return b; }
  const reader = r.body.getReader();
  let buf = new Uint8Array(exact ? total : 1 << 20), n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.length > buf.length) { const g = new Uint8Array(Math.max(buf.length * 2, n + value.length)); g.set(buf.subarray(0, n)); buf = g; }
    buf.set(value, n);
    n += value.length;
    onProgress?.(n, exact ? total : 0);
  }
  return n === buf.length ? buf : buf.slice(0, n);
}

/**
 * A map file's bytes: from the shared map cache when it holds them, else from the network (then stored there when
 * `keep` is set). onProgress(loaded, total) reports real bytes; a cache hit reports the whole file at once.
 */
export async function mapBytes(url, { onProgress, signal, keep = true } = {}) {
  const C = await CACHE;
  const hit = await C?.cachedBytes(url).catch(() => null);
  if (hit) { onProgress?.(hit.length, hit.length); return hit; }
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const bytes = await readBytes(r, onProgress);
  // stored before the bytes are handed on (Spark may transfer the buffer to its worker); a failed store (quota,
  // private mode) only means the next visit downloads again
  if (keep) await C?.putBytes(url, bytes).catch(() => {});
  return bytes;
}

/** A map's JSON file (cache first), with byte progress. */
export async function mapJSON(url, opts = {}) {
  return JSON.parse(new TextDecoder().decode(await mapBytes(url, opts)));
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
