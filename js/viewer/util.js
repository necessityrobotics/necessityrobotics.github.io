// Necessity Robotics viewer (ported from the approved review viewer) — small shared helpers (DOM, maths, formatting, design tokens, per-viewer storage).

export const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
/** Close to the site's cubic-bezier(.2,.7,0,1): a fast start and a long settle. */
export const easeOut = t => 1 - Math.pow(1 - t, 4);

/** A design token from core.css (the single source of every colour). */
export function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
/** '#4fd8ff' -> [r, g, b] in 0..1, sRGB (for raw shaders that write sRGB directly). */
export function hexToRgb01(hex) {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  return [0, 2, 4].map(i => parseInt(v.slice(i, i + 2), 16) / 255);
}

// ---------- formatting (mono HUD) ----------
/** Seconds on the replay clock: 042.30 */
export function fmtT(t, w = 3) {
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, t);
  const [a, b] = s.toFixed(2).split('.');
  return `${a.padStart(w, '0')}.${b}`;
}
/** Signed map-frame coordinate: +012.441 / −000.312 */
export function fmtCoord(v, d = 3) {
  if (!Number.isFinite(v)) return '—';
  return (v < 0 ? '−' : '+') + Math.abs(v).toFixed(d).padStart(d + 4, '0');
}
/** A length with a sensible unit: 0.85 m, 58.5 m, 844 m, 3.72 km */
export function fmtLen(m) {
  if (m == null || !Number.isFinite(m)) return '—';
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
  if (m >= 100) return `${m.toFixed(0)} m`;
  if (m >= 10) return `${m.toFixed(1)} m`;
  return `${m.toFixed(2)} m`;
}
/** Per-keyframe error in metres, 3 significant digits. */
export function fmtErr(e) {
  if (e == null || !Number.isFinite(e)) return '—';
  const a = Math.abs(e);
  const d = a < 0.1 ? 4 : a < 1 ? 3 : a < 10 ? 2 : a < 100 ? 1 : 0;
  return `${e.toFixed(d)} m`;
}
export function fmtMB(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  const mb = bytes / 1e6;   // decimal MB / KB, as the site's docs and the gallery state sizes
  return mb >= 100 ? `${mb.toFixed(0)} MB` : mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** True when a key event belongs to a text field (global shortcuts must not fire there). */
export function isTyping(e) {
  const t = e.target;
  if (!t || !(t instanceof Element)) return false;
  return !!t.closest('input:not([type="checkbox"]):not([type="range"]), textarea, select, [contenteditable="true"]');
}

// ---------- per-viewer conveniences (never state that must persist) ----------
export const store = {
  get(k, d = null) { try { const v = localStorage.getItem(`nr.viewer.${k}`); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(`nr.viewer.${k}`, JSON.stringify(v)); } catch (e) { /* private window: ignore */ } },
};

/** Yield one macrotask (not throttled like rAF in hidden tabs). */
export const yieldTask = () => new Promise(r => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });
