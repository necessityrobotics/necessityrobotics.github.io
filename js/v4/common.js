// Necessity Robotics v4: what every page shares. Load it on every page:
//   <script type="module" src="js/v4/common.js"></script>
// On load it (1) wires the phone menu of the shared header, (2) sets class "is-touch" or "can-hover" on <html>
// (pages write <span class="when-touch">Tap</span><span class="when-fine">Click</span>), (3) sets class "v4-js".
// It exports the place data loader and the small formatters. No dependency on js/site.js. See FOUNDATION.md.

/** The site root (the folder of index.html), whatever page or folder imports this module. */
export const ROOT = new URL('../../', import.meta.url);
/** Absolute URL of a file of the site: siteUrl('img/places/oak_161206.jpg'). */
export const siteUrl = (rel) => new URL(rel, ROOT).href;

const jsonCache = new Map();
/** One JSON file of the site, fetched once per page: getJSON('data/places.json'). */
export function getJSON(rel) {
  if (!jsonCache.has(rel)) {
    const pre = window.__nrPre && window.__nrPre[rel];      // a request the page's <head> started early (optional)
    const load = () => fetch(siteUrl(rel)).then((r) => { if (!r.ok) throw new Error(`${rel}: HTTP ${r.status}`); return r.json(); });
    const p = pre ? Promise.resolve(pre).then((r) => (r && r.ok ? r.json() : load())) : load();
    jsonCache.set(rel, p);
    p.catch(() => jsonCache.delete(rel));
  }
  return jsonCache.get(rel);
}

const NBSP = ' ';
/** Metres as people read them: 227.1 -> "227 m", 1020.7 -> "1.02 km" (a no-break space before the unit). */
export function fmtLen(m) {
  if (!Number.isFinite(m)) return '';
  return m >= 1000 ? `${(m / 1000).toFixed(2)}${NBSP}km` : `${Math.floor(m + 0.5)}${NBSP}m`;
}
/** "140 m of 1.02 km": progress along a path, never as time. */
export const fmtOf = (at, total) => `${fmtLen(Math.max(0, Math.min(total, at)))} of ${fmtLen(total)}`;

/** The link that opens a 3-D place: explore.html?map=<id>&at=<whole metres along the camera's path>. `at` is optional. */
export function exploreHref(id, at) {
  // a page may send its place doors to another 3-D view (the V12 mix prototype sets window.__nrExplore); default unchanged
  const u = new URL((typeof window !== 'undefined' && window.__nrExplore) || 'explore.html', ROOT);
  if (id) u.searchParams.set('map', id);
  if (at != null && Number.isFinite(+at)) u.searchParams.set('at', String(Math.max(0, Math.round(+at))));
  return u.href;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let placesP = null;
/**
 * The 8 public places: data/places.json merged with data/maps.json. Resolves to
 *   { hero, heroPlace, heroPhotos: [{file, kf, at_m, t, src}], places: [place], byId: {id: place},
 *     rosarioCredit, ownCredit, limitsIntro }
 * place = every field of places.json (id, name, short, kind, colour, still, photo, start_kf, start_at_m, limits_plain,
 *   credit_plain, real, this, travel, camera, country, length, start_t, start_file) plus
 *   n (1-based position), of (number of places), own (true = our own recording), path_m, href (explore link),
 *   prev / next (ids, wrapping), map (the place's whole maps.json entry: stats, limitation, credit, map_licence ...).
 * Picture paths (still, photo, file) are relative to the site root: use siteUrl() from a page in a sub-folder.
 */
export function loadPlaces() {
  if (!placesP) {
    placesP = Promise.all([getJSON('data/places.json'), getJSON('data/maps.json')]).then(([doc, maps]) => {
      const mapOf = Object.fromEntries(maps.maps.map((m) => [m.id, m]));
      const list = doc.places.filter((p) => mapOf[p.id]);
      const places = list.map((p, i) => {
        const map = mapOf[p.id];
        return {
          ...p, n: i + 1, of: list.length, own: !!map.own_data, path_m: map.stats.path_m, length: fmtLen(map.stats.path_m),
          href: exploreHref(p.id), prev: list[(i + list.length - 1) % list.length].id, next: list[(i + 1) % list.length].id, map,
        };
      });
      const byId = Object.fromEntries(places.map((p) => [p.id, p]));
      return {
        hero: doc.hero, heroPlace: byId[doc.hero] || places[0], heroPhotos: doc.hero_photos || [], places, byId,
        rosarioCredit: doc.rosario_credit, ownCredit: doc.own_credit, limitsIntro: doc.limits_intro_plain,
      };
    });
    placesP.catch(() => { placesP = null; });
  }
  return placesP;
}

// ------------------------------------------------------------------ touch or mouse (BUILD_PLAN R8)
// First paint: CSS media queries choose (v4.css). Here the class follows what the visitor really uses, so a laptop with
// a touch screen says "Tap" after a touch and "Click" after a mouse move.
const html = document.documentElement;
export const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/** True while the visitor's last input was a finger. */
export const isTouch = () => html.classList.contains('is-touch');
function setInput(touch) {
  if (html.classList.contains('is-touch') === touch && html.classList.contains('can-hover') === !touch) return;
  html.classList.toggle('is-touch', touch);
  html.classList.toggle('can-hover', !touch);
  document.dispatchEvent(new CustomEvent('v4:input', { detail: { touch } }));
}
function initInput() {
  setInput(!window.matchMedia('(hover: hover) and (pointer: fine)').matches);
  let lastTouch = 0;
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') { lastTouch = performance.now(); setInput(true); }
  }, { passive: true, capture: true });
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse' && performance.now() - lastTouch > 800) setInput(false);
  }, { passive: true, capture: true });
}

// ------------------------------------------------------------------ the shared header (fragment "header")
function initHeader() {
  const head = document.querySelector('.v4-head');
  if (!head || head.dataset.v4 === 'on') return;
  head.dataset.v4 = 'on';
  initPanels(head);
  const btn = head.querySelector('.v4-menu-btn');
  const nav = head.querySelector('.v4-nav');
  if (!btn || !nav) return;
  const txt = btn.querySelector('.v4-menu-txt');
  const set = (open) => {
    nav.classList.toggle('is-open', open);
    head.classList.toggle('is-menu', open);
    btn.setAttribute('aria-expanded', String(open));
    if (txt) txt.textContent = open ? 'Close' : 'Menu';
  };
  const isOpen = () => nav.classList.contains('is-open');
  btn.addEventListener('click', () => set(!isOpen()));
  nav.addEventListener('click', (e) => { if (e.target.closest('a')) set(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen()) { set(false); btn.focus(); } });
  document.addEventListener('pointerdown', (e) => { if (isOpen() && !head.contains(e.target)) set(false); }, { passive: true });
  window.matchMedia('(min-width: 901px)').addEventListener('change', (e) => { if (e.matches) set(false); });
}

// ------------------------------------------------------------------ the panels of the company top bar (owner 11-13)
// Products and Research open a panel: a click, a mouse that rests on them, or the keyboard. One panel is open at a time.
// Escape, a click outside or leaving with the mouse closes it. On a phone (the menu) the panels are plain groups (CSS).
function initPanels(head) {
  const dds = [...head.querySelectorAll('.nr-dd')];
  if (!dds.length) return;
  const phone = window.matchMedia('(max-width: 900px)');
  const btnOf = (dd) => dd.querySelector('.nr-dd-btn');
  const isOpen = (dd) => dd.classList.contains('is-open');
  const set = (dd, open) => { dd.classList.toggle('is-open', open); btnOf(dd).setAttribute('aria-expanded', String(open)); };
  const closeAll = (keep) => dds.forEach((d) => { if (d !== keep && isOpen(d)) set(d, false); });
  dds.forEach((dd) => {
    const b = btnOf(dd);
    let timer = 0, hoverAt = -1e9;
    b.addEventListener('click', () => {
      // a mouse that opened the panel a moment ago and then clicks: keep it open (no open-close flicker)
      if (isOpen(dd) && performance.now() - hoverAt < 600) return;
      const open = !isOpen(dd);
      closeAll(dd); set(dd, open);
    });
    dd.addEventListener('pointerenter', (e) => {
      if (e.pointerType !== 'mouse' || phone.matches) return;
      clearTimeout(timer);
      if (!isOpen(dd)) { hoverAt = performance.now(); closeAll(dd); set(dd, true); }
    });
    dd.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'mouse' || phone.matches) return;
      clearTimeout(timer);
      timer = setTimeout(() => { if (!dd.contains(document.activeElement) || document.activeElement === b) set(dd, false); }, 180);
    });
    dd.addEventListener('focusout', (e) => {
      if (phone.matches || !isOpen(dd) || dd.contains(e.relatedTarget)) return;
      if (e.relatedTarget == null && dd.matches(':hover')) return;   // a click on the panel's own empty area
      set(dd, false);
    });
    dd.addEventListener('click', (e) => { if (e.target.closest('a')) set(dd, false); });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || phone.matches) return;
    const dd = dds.find(isOpen);
    if (!dd) return;
    const inside = dd.contains(document.activeElement);
    set(dd, false);
    if (inside) btnOf(dd).focus();
  });
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.nr-dd')) closeAll(null); }, { passive: true });
  phone.addEventListener('change', () => closeAll(null));
}

html.classList.add('v4-js');
initInput();
initHeader();
