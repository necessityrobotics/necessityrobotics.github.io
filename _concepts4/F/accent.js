// V12 accent options (lead, 2026-11-13; owner: "make it black color theme, see which color pairs well with black,
// provide options"). One table for the page (CSS tokens in accent.css) and for the 3-D colours (path, marks, the
// camera mark). The choice: ?acc=<id>, remembered in localStorage (per viewer). The <head> script of each page sets
// <html data-acc> before the first paint, so there is no flash. A reload applies it to the 3-D place.
export const ACCENTS = {
  verdigris: { name: 'Verdigris', hex: '#6fc7b0', rim: '#e3f4ee', note: 'cool copper green (current)' },
  brass:     { name: 'Brass',     hex: '#c9a86a', rim: '#f3e9d4', note: 'black and brass, like an instrument' },
  bone:      { name: 'Bone',      hex: '#e8e0cf', rim: '#f7f3ea', note: 'warm ivory; the most classic' },
  sage:      { name: 'Sage',      hex: '#a7bb98', rim: '#e9efe4', note: 'soft green' },
  lilac:     { name: 'Lilac',     hex: '#b9a6dc', rim: '#efe9f8', note: 'cool, unusual' },
  clay:      { name: 'Clay',      hex: '#c98d6f', rim: '#f4e4dc', note: 'muted warm (close to orange)' },
  // the owner's trio: bone = main action, sage = the camera's path, lilac = AI
  trio:      { name: 'Bone, sage, lilac', hex: '#e8e0cf', rim: '#f7f3ea', path: '#a7bb98', pathRim: '#e9efe4', ai: '#b9a6dc', note: 'one job per colour' },
};
export const DEFAULT = 'verdigris';

/** The accent of this page view: { id, name, hex, rim, note }. */
export function current() {
  const id = document.documentElement.dataset.acc;
  return { id: ACCENTS[id] ? id : DEFAULT, ...(ACCENTS[id] || ACCENTS[DEFAULT]) };
}

/** A small review bar: one square per accent. A click reloads the page with that accent (the 3-D colours are set at
 *  load). Prototype only: the real site has one accent, picked by the owner. */
export function picker() {
  if (document.querySelector('.acc-bar')) return;
  const now = current().id;
  const bar = document.createElement('div');
  bar.className = 'acc-bar';
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Review: accent colour');
  bar.innerHTML = `<span class="acc-bar-k">Accent</span>` + Object.entries(ACCENTS).map(([id, a]) =>
    `<button type="button" class="acc-sw" data-acc="${id}" aria-pressed="${id === now}" title="${a.name}: ${a.note}" style="--sw:${a.hex}"><span class="sr">${a.name}</span></button>`).join('')
    + `<span class="acc-bar-n" aria-live="polite">${ACCENTS[now].name}</span>`;
  bar.addEventListener('click', e => {
    const b = e.target.closest('.acc-sw');
    if (!b) return;
    try { localStorage.setItem('nr-acc', b.dataset.acc); } catch (err) { /* private window: the URL still carries it */ }
    const u = new URL(location.href);
    u.searchParams.set('acc', b.dataset.acc);
    location.replace(u.href);
  });
  document.body.appendChild(bar);
}
