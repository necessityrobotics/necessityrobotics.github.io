// Necessity Robotics viewer: small shared helpers (maths, easing, design tokens, key handling).

export const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
/** Close to the site's cubic-bezier(.2,.7,0,1): a fast start and a long settle. */
export const easeOut = t => 1 - Math.pow(1 - t, 4);

/** A design token from site.css (the single source of every colour). */
export function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
/** '#4fd8ff' -> [r, g, b] in 0..1, sRGB (for raw shaders that write sRGB directly). */
export function hexToRgb01(hex) {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  return [0, 2, 4].map(i => parseInt(v.slice(i, i + 2), 16) / 255);
}

/** True when a key event belongs to a form control (the viewer's shortcuts must not fire there). */
export function isTyping(e) {
  const t = e.target;
  return t instanceof Element && !!t.closest('input, textarea, select, [contenteditable="true"]');
}
