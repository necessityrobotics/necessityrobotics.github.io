// The map-file cache shared by the home page and the viewer (MASTER_PLAN.md 2.4.5, SB-2 / SB-3). Completed splat files,
// traj.json and point slices are kept with the Cache API under their STABLE URL (the Hugging Face "resolve" URL or the
// local /assets URL, never a signed redirect), so a second visit or the viewer reuses them without the network.
// At most `maxMaps` maps are kept (oldest first out); nothing is stored under Save-Data; quota errors are ignored.
// Frozen API: CACHE_NAME, stableUrl, cachedBytes, putBytes.

export const CACHE_NAME = 'nr-maps-v1';
const ok = () => typeof caches !== 'undefined' && window.isSecureContext !== false && navigator.connection?.saveData !== true;

/** The cache key for a file URL: absolute, without a fragment. A `part` (e.g. a byte range) makes a separate entry. */
export function stableUrl(url, part = '') {
  const u = new URL(url, location.href);
  u.hash = '';
  if (part) u.searchParams.set('nr-part', part);
  return u.href;
}
// the map a key belongs to: an asset-host file (/maps/<id>/...) or a ride cut and its track on the site (/cuts/<id>.*)
const mapOf = key => (/\/maps\/([^/]+)\//.exec(key) || /\/cuts\/([^/.]+)\.[^/]*$/.exec(new URL(key).pathname) || [])[1] || key;

/** The cached bytes of a file, or null (no cache, a miss, or an error). */
export async function cachedBytes(url, part = '') {
  if (!ok()) return null;
  try {
    const c = await caches.open(CACHE_NAME);
    const r = await c.match(stableUrl(url, part));
    return r ? new Uint8Array(await r.arrayBuffer()) : null;
  } catch (e) {
    return null;
  }
}

/** Keep a completed file. Resolves true when stored (after the body has been copied into the cache). */
export async function putBytes(url, bytes, { maxMaps = 4, part = '' } = {}) {
  if (!ok() || !bytes?.byteLength) return false;
  return put(stableUrl(url, part), new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.byteLength) } }), maxMaps);
}

/**
 * Keep a network response as it streams in (a clone of a complete 200 answer): the browser copies the body into the
 * cache off the main thread, so a 10-12 MB splat file costs no main-thread copy. Rejected quietly if the download stops.
 */
export function putResponse(url, response, { maxMaps = 4 } = {}) {
  if (!ok() || response.status !== 200) return Promise.resolve(false);
  return put(stableUrl(url), response, maxMaps);
}

async function put(key, response, maxMaps) {
  try {
    const c = await caches.open(CACHE_NAME);
    await c.put(key, response);
    // keep at most maxMaps maps: keys() lists entries in insertion order, so the first maps listed are the oldest
    const keys = (await c.keys()).map(r => r.url);
    const order = [];
    for (const k of keys) { const m = mapOf(k); const i = order.indexOf(m); if (i >= 0) order.splice(i, 1); order.push(m); }
    const drop = order.slice(0, Math.max(0, order.length - maxMaps));
    if (drop.length) await Promise.all(keys.filter(k => drop.includes(mapOf(k))).map(k => c.delete(k)));
    return true;
  } catch (e) {
    return false;
  }
}
