// Site v4.1, one finish for every page (lead): the light answers the visitor.
//  1. a soft light follows the pointer;  2. a card shows a highlight where the pointer is;
//  3. a light runs along every orange path;  4. blocks rise into place as they come on screen.
// The page is complete without this file. Nothing here loads data or 3-D code.
const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;
const FINE = matchMedia('(hover: hover) and (pointer: fine)').matches;
const root = document.documentElement;

// 1. the pointer light
if (FINE && !REDUCE) {
  const l = document.createElement('div');
  l.className = 'x-light'; l.setAttribute('aria-hidden', 'true');
  document.body.appendChild(l);
  let x = 0, y = 0, pending = false;
  addEventListener('pointermove', (e) => {
    x = e.clientX; y = e.clientY;
    if (pending) return; pending = true;
    requestAnimationFrame(() => { pending = false; l.style.setProperty('--gx', x + 'px'); l.style.setProperty('--gy', y + 'px'); l.classList.add('on'); });
  }, { passive: true });
  document.addEventListener('pointerleave', () => l.classList.remove('on'));

  // 2. the highlight on a card
  document.addEventListener('pointermove', (e) => {
    const c = e.target.closest?.('.v4-card');
    if (!c) return;
    const r = c.getBoundingClientRect();
    c.style.setProperty('--mx', (e.clientX - r.left) + 'px'); c.style.setProperty('--my', (e.clientY - r.top) + 'px');
  }, { passive: true });
}

// 3. the running light: a second copy of each route line, drawn as one short bright dash that travels
function runLights(scope = document) {
  if (REDUCE) return;
  scope.querySelectorAll('.v4-route-svg .v4-route-line:not([data-x])').forEach((line) => {
    line.dataset.x = '1';
    const run = line.cloneNode(false);
    run.removeAttribute('data-x'); run.setAttribute('class', 'x-run'); run.setAttribute('pathLength', '1'); run.setAttribute('aria-hidden', 'true');
    line.after(run);
  });
}
runLights();
// routes that a page script draws later (route-door.js) get their light too
if ('MutationObserver' in window && !REDUCE) {
  let t = 0;
  new MutationObserver(() => { clearTimeout(t); t = setTimeout(runLights, 120); }).observe(document.body, { childList: true, subtree: true });
}

// 4. rise into place
if ('IntersectionObserver' in window && !REDUCE) {
  const sel = 'main .h4-head, main .v4-card, main .v4-fact, main .h4-beat, main .h4-ready, main .h4-building, main .h4-goal, main .h4-engdoor, main .v4-note, main .p4-plain, main .x-rise';
  const items = [...document.querySelectorAll(sel)].filter((el) => !el.closest('.d-hero'));
  if (items.length) {
    root.classList.add('js-x');
    const vh = innerHeight;
    const io = new IntersectionObserver((es) => {
      for (const e of es) if (e.isIntersecting) { e.target.classList.add('x-in'); io.unobserve(e.target); }
    }, { rootMargin: '0px', threshold: 0 });
    items.forEach((el) => {
      el.classList.add('x-r');
      const sibs = el.parentElement ? [...el.parentElement.children].filter((c) => c.classList.contains('x-r') || c === el) : [el];
      el.style.setProperty('--xi', Math.min(5, Math.max(0, sibs.indexOf(el) % 6)));
      if (el.getBoundingClientRect().top < vh * .95) el.classList.add('x-in'); else io.observe(el);
    });
    // never leave a block hidden: a print, a hash jump or a slow observer still shows the page
    addEventListener('beforeprint', () => items.forEach((el) => el.classList.add('x-in')));
    setTimeout(() => items.forEach((el) => { if (el.getBoundingClientRect().top < innerHeight) el.classList.add('x-in'); }), 2500);
  }
}

// 5. AI / ML term tips (css/ml.css): keep the tip inside the window. The tip is max 320 px wide (or the window less 32 px).
function placeTip(e) {
  const t = e.target.closest?.('.ml');
  if (!t) return;
  const r = t.getBoundingClientRect();
  const w = Math.min(320, innerWidth - 32);
  const over = r.left + w - (innerWidth - 16);
  t.style.setProperty('--ml-x', (over > 0 ? -Math.min(over, r.left - 16) : 0) + 'px');
}
document.addEventListener('pointerover', placeTip, { passive: true });
document.addEventListener('focusin', placeTip);
