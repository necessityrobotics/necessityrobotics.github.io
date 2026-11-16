// Necessity Robotics site shell: header state, phone menu, scroll reveals, fast navigation. Header and footer are plain
// HTML in every page (readable without JS); this file only adds behaviour. No scroll handler anywhere: the header state
// and the reveals run on IntersectionObservers, so scrolling stays on the compositor.
import { CODE_PUBLIC, LINKS } from './config.js';
document.documentElement.classList.add('js');

// the code-release switch (config.js CODE_PUBLIC): static HTML ships the "coming soon" state
if (CODE_PUBLIC) {
  document.querySelectorAll('[data-code-when="pending"]').forEach(e => { e.hidden = true; });
  document.querySelectorAll('[data-code-when="public"]').forEach(e => { e.hidden = false; });
  document.querySelectorAll('a[data-code-href]').forEach(a => { a.href = LINKS.repo; });
  document.querySelectorAll('[data-code-repo]').forEach(e => { e.textContent = LINKS.repo; });
}
// still (classic) mode: every phone and tablet (owner 11-16; the page head sets html.nr-still) has no motion either:
// sections show at once, numbers show their value, the xclean point field is one still figure
export const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('nr-still');
const SAVE = navigator.connection?.saveData === true || /(^|-)2g$/.test(navigator.connection?.effectiveType || '');

/** Run fn once the page is shown: at once, or when a prerendered page is activated (no animation runs unseen). */
export function whenActive(fn) {
  if (document.prerendering) document.addEventListener('prerenderingchange', () => fn(), { once: true });
  else fn();
}

// ---------------------------------------------------------------- header: transparent over a [data-head-over] header
const head = document.querySelector('.head');
if (head) {
  const over = document.querySelector('[data-head-over]');
  if (over && 'IntersectionObserver' in window) {
    // a 1 px probe 40 px below the top of the page: once it has scrolled under the header, the header turns solid
    const probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:absolute;top:40px;left:0;width:1px;height:1px;pointer-events:none';
    document.body.prepend(probe);
    head.classList.toggle('is-top', window.scrollY < 40);
    new IntersectionObserver(es => head.classList.toggle('is-top', es[es.length - 1].isIntersecting)).observe(probe);
  }
  const btn = head.querySelector('.nav-btn');
  const nav = head.querySelector('.nav');
  const close = () => { nav.classList.remove('open'); btn?.setAttribute('aria-expanded', 'false'); if (btn) btn.querySelector('span').textContent = 'Menu'; };
  btn?.addEventListener('click', () => {
    const open = !nav.classList.contains('open');
    nav.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
    btn.querySelector('span').textContent = open ? 'Close' : 'Menu';
  });
  nav?.addEventListener('click', e => { if (e.target.closest('a')) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && nav?.classList.contains('open')) { close(); btn?.focus(); } });
}

// ---------------------------------------------------------------- reveals (content is visible without JS / reduced motion)
const els = document.querySelectorAll('[data-reveal]');
if (els.length) {
  if (REDUCED || !('IntersectionObserver' in window)) els.forEach(e => e.classList.add('in'));
  else whenActive(() => {
    const io = new IntersectionObserver(es => es.forEach(en => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }), { rootMargin: '0px 0px -8% 0px' });
    els.forEach(e => io.observe(e));
  });
}

/** Small helpers shared by the page modules. */
export const $ = (s, r = document) => r.querySelector(s);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const fmt = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(d));
// thousands separators by hand: the first toLocaleString() call loads locale data (about 35 ms on a 4x-throttled phone)
export const fmtInt = x => { if (x == null) return '—'; const [i, f] = String(x).split('.'); return i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? `.${f}` : ''); };
export function fmtMB(b) { if (!Number.isFinite(b)) return '—'; const mb = b / 1e6; return mb >= 100 ? `${mb.toFixed(0)} MB` : mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`; }
export function fmtLen(m) { if (!Number.isFinite(m)) return '—'; return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(0)} m`; }
export async function getJSON(url) {
  // integrator: a request the page's head started early (window.__nrPre, an inline script) is used once, here
  const pre = window.__nrPre?.[url];
  if (pre) {
    delete window.__nrPre[url];
    const r = await pre;
    if (r?.ok) return r.json();
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}
/** Run fn when the browser is idle (or after a timeout). */
export const idle = (fn, timeout = 1500) => ('requestIdleCallback' in window ? requestIdleCallback(fn, { timeout }) : setTimeout(fn, 200));
// ---------------------------------------------------------------- scroll position on pages built from data
// The maps and results pages build most of their height from JSON after the first paint, so the browser's own
// restoration (back/forward without the back/forward cache, reload) runs on a short page and lands near the top. Those
// pages call keepScroll() before they build and restoreScroll() once built: the visitor lands where they left. One key
// per history entry (the Navigation API's entry key; elsewhere the URL).
const NAV_TYPE = performance.getEntriesByType?.('navigation')?.[0]?.type;
const RETURNING = NAV_TYPE === 'back_forward' || NAV_TYPE === 'reload';
const yKey = () => `nr-y:${window.navigation?.currentEntry?.key || location.pathname + location.search + location.hash}`;
export function keepScroll() {
  if (RETURNING && 'scrollRestoration' in history) history.scrollRestoration = 'manual';
  const save = () => { try { sessionStorage.setItem(yKey(), String(Math.round(window.scrollY))); } catch (e) { /* storage off: the browser's own restoration */ } };
  addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });
}
/** Put back the saved position of this history entry (returns true when it did; then a #hash must not move the page). */
export function restoreScroll() {
  if (!RETURNING) return false;
  if ('scrollRestoration' in history) history.scrollRestoration = 'auto';
  let y = null;
  try { y = sessionStorage.getItem(yKey()); } catch (e) { y = null; }
  if (y === null || !Number.isFinite(+y)) return false;
  window.scrollTo(0, +y);   // the two-argument form: no ScrollBehavior value an older engine might reject (no smooth scrolling is set)
  return true;
}

/** True on phones, low-memory devices and Save-Data: these get posters, the film or the Lite tier, never the heavy path. */
export const CONSTRAINED = (navigator.deviceMemory && navigator.deviceMemory <= 4) || navigator.connection?.saveData === true
  || window.matchMedia('(max-width: 760px), (pointer: coarse) and (max-width: 1024px)').matches;

/**
 * Count an integer up to its value when it comes into view (RA-12 / FA-4: counts only, never a latency). The element
 * keeps its final text for assistive technology; an aria-hidden twin of the same width shows the count, then leaves.
 */
export function countUp(el, to, dec = 0) {
  const final = Number(to).toFixed(dec);
  el.textContent = final;
  if (REDUCED || !('IntersectionObserver' in window) || !Number.isFinite(Number(to))) return;
  whenActive(() => {
    const io = new IntersectionObserver(es => {
      if (!es.some(e => e.isIntersecting)) return;
      io.disconnect();
      const twin = document.createElement('span');
      twin.className = 'cu';
      twin.setAttribute('aria-hidden', 'true');
      twin.style.minWidth = `${final.length}ch`;
      el.classList.add('cu-final');
      el.after(twin);
      const t0 = performance.now();
      const step = now => {
        const k = Math.min(1, (now - t0) / 1100), e = 1 - Math.pow(1 - k, 3);
        twin.textContent = (to * e).toFixed(dec);
        if (k < 1) requestAnimationFrame(step);
        else { twin.remove(); el.classList.remove('cu-final'); }
      };
      requestAnimationFrame(step);
    }, { threshold: 0.6 });
    io.observe(el);
  });
}

// ---------------------------------------------------------------- fast navigation (SB-10)
// 1. Speculation rules (Chromium): content pages are prerendered on intent (hover ~200 ms, pointer down); the maps page,
//    the viewer and the home page are only prefetched (their 3-D must not start unseen).
// 2. On intent toward a viewer link (any browser): the viewer's heavy modules go to the HTTP cache. (Map files are not
//    fetched on intent: the viewer reads them from the shared map cache when the home page or a visit put them there,
//    and a hover must never evict a map someone opened from that small cache.)
if (!SAVE) {
  const here = p => new URL(p, location.href).pathname;
  if (HTMLScriptElement.supports?.('speculationrules')) {
    const rules = document.createElement('script');
    rules.type = 'speculationrules';
    rules.textContent = JSON.stringify({
      prerender: [{ where: { or: ['xclean.html', 'results.html', 'paper.html', 'credits.html'].map(p => ({ href_matches: here(p) })) }, eagerness: 'moderate' }],
      prefetch: [{ where: { or: [here('./'), here('index.html'), here('maps.html'), here('viewer.html')].map(p => ({ href_matches: p })) }, eagerness: 'moderate' }],
    });
    document.head.append(rules);
  }
  const VIEWER_FILES = ['js/viewer/main.js', 'css/viewer.css', 'vendor/three/three.module.js', 'vendor/three/three.core.js', 'vendor/spark/spark.module.js'];
  let viewerWarm = false;
  const warm = a => {
    const u = new URL(a.href, location.href);
    if (viewerWarm || u.origin !== location.origin || !u.pathname.endsWith('/viewer.html') || location.pathname.endsWith('/viewer.html')) return;
    viewerWarm = true;
    for (const f of VIEWER_FILES) {
      const l = document.createElement('link');
      l.rel = 'prefetch'; l.href = new URL(f, u).href;
      document.head.append(l);
    }
  };
  // intent = the pointer resting on a link for 150 ms, or keyboard focus resting on it for 300 ms (not a fast Tab walk)
  let intentT = 0;
  const intent = (a, ms) => { clearTimeout(intentT); if (a) intentT = setTimeout(() => warm(a), ms); };
  document.addEventListener('pointerover', e => { if (e.pointerType === 'mouse') intent(e.target.closest?.('a[href]'), 150); }, { passive: true });
  document.addEventListener('focusin', e => intent(e.target.closest?.('a[href]'), 300));
}
