// Device capability tiers (MASTER_PLAN.md 4.1 / 4.2). Decided once at start, in a few ms; the frame-time governor
// (governor.js) only ever moves quality down from here. Pure apart from the WebGL probe, so the tier fixtures
// (tools/qa/engine/caps_cases.json) can run chooseTier() on recorded signals.
//   T0 still   no WebGL2 / software GL / reduced motion / Save-Data / 2g / deviceMemory < 2 / ?world=still
//   T1 weak    touch and (deviceMemory <= 3, or <= 4 cores, or a low-end GPU, or a small iPhone)
//   T2 phone   touch (tablets >= 768 px get the tablet parameters)
//   T4 desktop fine pointer, a discrete GPU (or Apple M Pro / Max / Ultra), >= 8 GB or unknown, screen >= 1280 x 720
//   T3         everything else (laptops, integrated GPUs, unknown renderers, Safari / Firefox without signals)

export const GPU_SOFTWARE = /SwiftShader|llvmpipe|softpipe|Microsoft Basic Render/i;
export const GPU_LOW = /Mali-(4\d\d|T\d+|G(31|51|52|57|68))|Adreno \(TM\) ([1-5]\d\d|6[01]\d)|PowerVR|Vivante|VideoCore|Intel\(R\) HD Graphics [2-5]\d\d/i;
export const GPU_DISCRETE = /NVIDIA|GeForce|Quadro|RTX|Radeon (RX|Pro)|Arc\(TM\)|Apple M\d (Pro|Max|Ultra)/i;

const MB = 1e6;
/** What each tier gets. Scales are device px per CSS px; pixel caps bound the drawing buffer (fill rate on 4K / high DPR). */
// WIRE: ride cuts (data/cuts, tools/build_ride_cuts.py) serve phones only (T1/T2 stop at the cut). Desktops and laptops
// go straight to Lite: cut -> Lite doubled their bytes and uploads and overflowed the byte cache into refetches.
// SP: tablets (T2tab) take the cut like phones (they had Lite only: on 4G the hero's 10.7 MB arrived after the reader
// had left the hero, so a tablet showed no 3-D on the first screen; same memory cap as phones).
export const TIER_PARAMS = Object.freeze({
  T0: { tier: 'T0', live: false, memCap: 60 * MB },
  T1: { tier: 'T1', live: true, dprCap: 1.0, pixCap: 0.6e6, scale: [0.45, 1.0], fps: 30, playFps: 30, maxSplatMaps: 1, baseLevels: 1,
    densePts: 40000, lookahead: 1, byteCache: 12 * MB, backdrop: false, labelHz: 10, splatTiers: ['cut', 'lite'], keepBytes: false,
    spark: { maxPixelRadius: 200, minAlpha: 0.004 }, memCap: 200 * MB, phone: true },
  T2: { tier: 'T2', live: true, dprCap: 1.25, pixCap: 1.2e6, scale: [0.5, 1.25], fps: 60, playFps: 30, maxSplatMaps: 2, baseLevels: 1,
    densePts: 80000, lookahead: 2, byteCache: 26 * MB, backdrop: true, labelHz: 30, splatTiers: ['cut', 'lite'], keepBytes: false,
    spark: { maxPixelRadius: 320 }, memCap: 300 * MB, phone: true },
  T2tab: { tier: 'T2', live: true, dprCap: 1.5, pixCap: 1.2e6, scale: [0.5, 1.25], fps: 60, playFps: 30, maxSplatMaps: 2, baseLevels: 1,
    densePts: 80000, lookahead: 2, byteCache: 26 * MB, backdrop: true, labelHz: 30, splatTiers: ['cut', 'lite'], keepBytes: false,
    spark: { maxPixelRadius: 320 }, memCap: 300 * MB, phone: true, tablet: true },
  T3: { tier: 'T3', live: true, dprCap: 1.5, pixCap: 2.3e6, scale: [0.6, 1.5], fps: 60, playFps: 60, maxSplatMaps: 2, baseLevels: 2,
    densePts: 150000, lookahead: 2, byteCache: 48 * MB, backdrop: true, labelHz: 30, splatTiers: ['lite'], keepBytes: true,
    spark: {}, memCap: 450 * MB, phone: false },
  T4: { tier: 'T4', live: true, dprCap: 2.0, pixCap: 4.2e6, scale: [0.6, 2.0], fps: 120, playFps: 120, maxSplatMaps: 3, baseLevels: 2,
    densePts: 250000, lookahead: 2, byteCache: 64 * MB, backdrop: true, labelHz: 30, splatTiers: ['lite', 'standard'], keepBytes: true,
    spark: {}, memCap: 700 * MB, phone: false },
});

const mq = q => { try { return window.matchMedia(q).matches; } catch (e) { return false; } };

/**
 * The device's signals. With a canvas, WebGL2 is probed ON that canvas (the context is kept and handed to three.js):
 * first with failIfMajorPerformanceCaveat (a software rasteriser refuses it), then, if that fails, on a throwaway canvas
 * without it (success there means software GL), released at once.
 */
export function detectCaps({ canvas = null } = {}) {
  const nav = navigator, conn = nav.connection || {};
  const ua = nav.userAgent || '';
  const touch = (nav.maxTouchPoints || 0) > 0;
  const mac = /Macintosh/.test(ua);
  const caps = {
    ua: ua.slice(0, 160),
    deviceMemory: nav.deviceMemory ? Math.min(8, nav.deviceMemory) : null,
    cores: nav.hardwareConcurrency || null,
    w: Math.round(screen.width || innerWidth), h: Math.round(screen.height || innerHeight),
    vw: innerWidth, vh: innerHeight, dpr: window.devicePixelRatio || 1,
    fine: mq('(pointer: fine)'), hover: mq('(hover: hover)'), touch,
    ios: /iPhone|iPad|iPod/.test(ua) || (mac && touch), android: /Android/.test(ua), mac: mac && !touch,
    saveData: conn.saveData === true, effectiveType: conn.effectiveType || null,
    reduced: mq('(prefers-reduced-motion: reduce)'),
    // PL: the 3-D modules import 'three' and '@sparkjsdev/spark' through the page's import map. Safari 15.x-16.3 and
    // Firefox < 108 have WebGL2 but no import maps: they downloaded ~1.4 MB of modules that could not run (and the Maps
    // atlas rejected). HTMLScriptElement.supports is missing only where import maps are too (Safari 15) or on Chrome < 96
    modules: typeof HTMLScriptElement !== 'undefined' && typeof HTMLScriptElement.supports === 'function' && HTMLScriptElement.supports('importmap'),
    webgl2: null, software: false, renderer: '', gl: null, timerQuery: false,
  };
  if (!canvas) return caps;
  const attrs = { alpha: false, antialias: false, stencil: false, depth: true, powerPreference: 'high-performance', preserveDrawingBuffer: false };
  let gl = null;
  try { gl = canvas.getContext('webgl2', { ...attrs, failIfMajorPerformanceCaveat: true }); } catch (e) { gl = null; }
  if (!gl) {
    let soft = null;
    try { soft = document.createElement('canvas').getContext('webgl2', attrs); } catch (e) { soft = null; }
    caps.webgl2 = false;
    if (soft) {
      caps.software = true;
      caps.renderer = rendererOf(soft);
      soft.getExtension('WEBGL_lose_context')?.loseContext();
    }
    return caps;
  }
  caps.webgl2 = true;
  caps.gl = gl;
  caps.renderer = rendererOf(gl);
  caps.software = GPU_SOFTWARE.test(caps.renderer);
  caps.timerQuery = !!gl.getExtension('EXT_disjoint_timer_query_webgl2');
  return caps;
}

function rendererOf(gl) {
  try {
    // Firefox deprecates WEBGL_debug_renderer_info and already returns the (sanitised) renderer in RENDERER
    const r = gl.getParameter(gl.RENDERER) || '';
    if (/firefox/i.test(navigator.userAgent)) return r;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return (ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || r;
  } catch (e) { return ''; }
}

/** Why T0, from the cheap signals alone (no WebGL needed), or null. */
export function stillReason(caps, force) {
  if (force === 'still') return '?world=still';
  if (caps.reduced) return 'reduced motion';
  if (caps.saveData) return 'Save-Data';
  if (caps.effectiveType === '2g' || caps.effectiveType === 'slow-2g') return `slow connection (${caps.effectiveType})`;
  if (caps.deviceMemory != null && caps.deviceMemory < 2) return `deviceMemory ${caps.deviceMemory} GB`;
  if (caps.modules === false) return 'no import maps (browser too old for the 3-D modules)';
  return null;
}

/**
 * caps -> {tier, why, params}. force: {world: 'still'|'live'|null, tier: 'T0'..'T4'|null} (?world= / ?tier=).
 * ?world=live overrides the cheap still reasons (not a missing WebGL2).
 */
export function chooseTier(caps, { force = {} } = {}) {
  const pick = (tier, why) => {
    const params = tier === 'T2' && Math.min(caps.w, caps.h) >= 768 ? TIER_PARAMS.T2tab : TIER_PARAMS[tier];
    return { tier, why, params };
  };
  const still = force.world === 'live' ? null : stillReason(caps, force.world);
  if (still) return pick('T0', still);
  if (caps.webgl2 === false) return pick('T0', caps.software ? `software WebGL (${caps.renderer.slice(0, 40)})` : 'no WebGL2');
  if (caps.software) return pick('T0', `software WebGL (${caps.renderer.slice(0, 40)})`);
  if (force.tier && TIER_PARAMS[force.tier]) return pick(force.tier, `?tier=${force.tier}`);
  // integrator: every iPhone / iPad (UA, or iPadOS's desktop UA with touch) takes the touch tiers whatever its pointer
  // media says: Safari's per-tab memory limit applies to all of them, and an iPad with a trackpad (pointer: fine) or an
  // emulated iPhone without touch media (Playwright's WebKit) fell to T3 (Lite files, the desktop memory cap)
  const touchFirst = (caps.touch && !caps.fine) || (caps.ios && !caps.mac);
  const low = GPU_LOW.test(caps.renderer);
  if (touchFirst) {
    const smallIphone = caps.ios && Math.max(caps.w, caps.h) <= 667;
    // PH: WebKit reports navigator.hardwareConcurrency as 4 on any device with fewer than 8 cores (anti-fingerprinting),
    // so on iOS / iPadOS "4 cores" says nothing, and every 6-core iPhone fell to T1 (DPR 1.0 on a 3x screen, one map);
    // there the screen rule above is the weak-device signal
    const fewCores = caps.cores != null && caps.cores <= 4 && !caps.ios;
    if ((caps.deviceMemory != null && caps.deviceMemory <= 3) || fewCores || low || smallIphone) {
      return pick('T1', low ? `low-end GPU (${caps.renderer.slice(0, 40)})` : smallIphone ? 'small iPhone' : `touch, ${caps.deviceMemory ?? '?'} GB, ${caps.cores ?? '?'} cores`);
    }
    return pick('T2', Math.min(caps.w, caps.h) >= 768 ? 'touch tablet' : 'touch phone');
  }
  // the screen, or the window when it is larger (headless and some embedded browsers report a small screen)
  const big = Math.max(caps.w, caps.h, caps.vw, caps.vh) >= 1280 && Math.max(Math.min(caps.w, caps.h), Math.min(caps.vw, caps.vh)) >= 720;
  const discrete = GPU_DISCRETE.test(caps.renderer);
  if (caps.fine && discrete && (caps.deviceMemory == null || caps.deviceMemory >= 8) && big) return pick('T4', `discrete GPU (${caps.renderer.slice(0, 40)})`);
  return pick('T3', caps.renderer ? `desktop (${caps.renderer.slice(0, 40)})` : 'desktop, no GPU string');
}
