// Necessity Robotics site shell: header state, phone menu, scroll reveals. Header and footer are plain HTML in every
// page (readable without JS); this file only adds behaviour.
import { CODE_PUBLIC, LINKS } from './config.js';
document.documentElement.classList.add('js');

// the code-release switch (config.js CODE_PUBLIC): static HTML ships the "coming soon" state
if (CODE_PUBLIC) {
  document.querySelectorAll('[data-code-when="pending"]').forEach(e => { e.hidden = true; });
  document.querySelectorAll('[data-code-when="public"]').forEach(e => { e.hidden = false; });
  document.querySelectorAll('a[data-code-href]').forEach(a => { a.href = LINKS.repo; });
  document.querySelectorAll('[data-code-repo]').forEach(e => { e.textContent = LINKS.repo; });
}
export const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const head = document.querySelector('.head');
if (head) {
  const hero = document.querySelector('[data-head-over]');
  const onScroll = () => head.classList.toggle('is-top', !!hero && window.scrollY < 40);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
  const btn = head.querySelector('.nav-btn');
  const nav = head.querySelector('.nav');
  btn?.addEventListener('click', () => {
    const open = !nav.classList.contains('open');
    nav.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open));
    btn.querySelector('span').textContent = open ? 'Close' : 'Menu';
  });
  nav?.addEventListener('click', e => { if (e.target.closest('a')) { nav.classList.remove('open'); btn?.setAttribute('aria-expanded', 'false'); } });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && nav?.classList.contains('open')) { nav.classList.remove('open'); btn?.setAttribute('aria-expanded', 'false'); btn?.focus(); } });
}

const els = document.querySelectorAll('[data-reveal]');
if (els.length) {
  if (REDUCED || !('IntersectionObserver' in window)) els.forEach(e => e.classList.add('in'));
  else {
    const io = new IntersectionObserver(es => es.forEach(en => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }), { rootMargin: '0px 0px -8% 0px' });
    els.forEach(e => io.observe(e));
  }
}

/** Small helpers shared by the page modules. */
export const $ = (s, r = document) => r.querySelector(s);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const fmt = (x, d = 2) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(d));
export const fmtInt = x => (x == null ? '—' : x.toLocaleString('en-US'));
export function fmtMB(b) { if (!Number.isFinite(b)) return '—'; const mb = b / 1e6; return mb >= 100 ? `${mb.toFixed(0)} MB` : mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`; }
export function fmtLen(m) { if (!Number.isFinite(m)) return '—'; return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(0)} m`; }
export async function getJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); }
/** Run fn when the browser is idle (or after a timeout). */
export const idle = (fn, timeout = 1500) => ('requestIdleCallback' in window ? requestIdleCallback(fn, { timeout }) : setTimeout(fn, 200));
/** True on phones, low-memory devices and Save-Data: these get posters, the film or the Lite tier, never the heavy path. */
export const CONSTRAINED = (navigator.deviceMemory && navigator.deviceMemory <= 4) || navigator.connection?.saveData === true
  || window.matchMedia('(max-width: 760px), (pointer: coarse) and (max-width: 1024px)').matches;
