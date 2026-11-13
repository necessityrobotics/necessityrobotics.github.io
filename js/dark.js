// Site v4.1, the home page's first screen: "Out of the dark" (lead). Was site/_concepts2/D/d.js. The page is black: the place is unknown until the software has seen it.
// The place shows only where the visitor points, touches or tilts; the scroll lights the whole place.
// Prototype: a still of the real 3-D place under a 2-D canvas of darkness. The real build puts the live engine under the same canvas.

const $ = (s, r = document) => r.querySelector(s);
const stage = $('#stage'), hero = $('.d-hero'), plate = $('#plate');
const dark = $('#dark'), first = $('#first'), hint = $('#hint');
const pulse = $('#pulse'), pulseLine = $('#d-line'), pulseG = $('#d-pulses');
const photoBox = $('#photos'), photos = [...document.querySelectorAll('.d-ph')];
const caps = [...document.querySelectorAll('.d-cap')];

const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;
const TOUCH = matchMedia('(pointer: coarse)').matches;
const PHONE_MQ = matchMedia('(max-width: 760px)');           // the same test as the CSS and the <picture>
document.documentElement.classList.add('js');
if (TOUCH) document.body.classList.add('d-touch');
if (REDUCE) hint.innerHTML = '<b>The dark is a real place.</b> Scroll to light it.';

// the two stills of the place: where the path meets the horizon (vp), the camera's path, where the photos hang (x, y, width, turn)
const CFG = {
  L: { w: 1280, h: 800, vp: [743, 300],
       line: 'M722 800 C 716 700, 716 600, 721 520 S 738 400, 746 335 S 744 300, 743 284', r: [9, 1.4],
       ph: { 1: [900, 560, 270, -16], 2: [500, 390, 200, 18], 3: [905, 400, 170, -16], 4: [665, 326, 120, 18], 5: [835, 312, 96, -14], 6: [715, 262, 66, 16] } },
  P: { w: 720, h: 1280, vp: [460, 505],
       line: 'M440 1280 C 438 1100, 438 900, 441 800 S 452 640, 462 575 S 461 530, 460 512', r: [8, 1.3],
       ph: { 1: [560, 860, 250, -14], 2: [300, 760, 200, 16], 3: [585, 690, 150, -14], 4: [345, 640, 116, 16], 5: [550, 590, 90, -12], 6: [410, 560, 68, 14] } },
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

let W = 0, H = 0, q = 1, phone = false, cfg = CFG.L, dy0 = 0, lastW = -1, lastH = -1, lastPhone = null;
const cover = { l: 0, t: 0, w: 0, h: 0, s: 1 };
const ctx = dark.getContext('2d');
const mem = document.createElement('canvas');                      // what the visitor has looked at (low resolution, fades)
const mctx = mem.getContext('2d', { willReadFrequently: true });
let MW = 0, MH = 0;
const ptr = { x: .5, y: .5, tx: .5, ty: .5, on: false };
const par = { x: .5, y: .5 };
let p = 0, raf = 0, last = 0, activeUntil = 0, found = 0, dust = [], heroOn = true, stopNow = -1;

function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// one soft opening: full in the middle, a long tail at the rim
const STOPS = [[0, 1], [.42, .86], [.72, .36], [.9, .08], [1, 0]];
function blob(c, x, y, rx, ry, a) {
  c.save(); c.translate(x, y); c.scale(rx, ry);
  const g = c.createRadialGradient(0, 0, 0, 0, 0, 1);
  for (const [o, v] of STOPS) g.addColorStop(o, `rgba(255,255,255,${(a * v).toFixed(4)})`);
  c.fillStyle = g; c.beginPath(); c.arc(0, 0, 1, 0, 6.2832); c.fill(); c.restore();
}
function profile(d) {
  if (d >= 1) return 0;
  for (let i = 1; i < STOPS.length; i++) if (d <= STOPS[i][0]) { const [o0, v0] = STOPS[i - 1], [o1, v1] = STOPS[i]; return v0 + (v1 - v0) * (d - o0) / (o1 - o0); }
  return 0;
}

function layout(force) {
  const r = stage.getBoundingClientRect();
  const ph = PHONE_MQ.matches;
  // a phone's address bar changes the height while the visitor scrolls: that is not a new layout
  if (!force && r.width === lastW && ph === lastPhone && Math.abs(r.height - lastH) < 120) return;
  lastW = r.width; lastH = r.height; lastPhone = ph;
  W = r.width; H = r.height; phone = ph; cfg = phone ? CFG.P : CFG.L;
  q = Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt(2.4e6 / (W * H)));      // at most 2.4 megapixels of darkness
  const s = Math.max(W / cfg.w, H / cfg.h) * (phone ? 1 : 1.22);     // larger than the screen: room to place the horizon
  cover.s = s; cover.w = cfg.w * s; cover.h = cfg.h * s;
  cover.l = clamp((phone ? .53 : .67) * W - cfg.vp[0] * s, W - cover.w, 0);
  cover.t = clamp((phone ? .40 : .40) * H - cfg.vp[1] * s, H - cover.h, 0);
  dy0 = phone ? Math.max(0, .6 * H - (cover.t + cfg.vp[1] * s)) : 0;         // upright screens: the opening starts under the text
  const st = plate.style;
  st.setProperty('--pl', cover.l + 'px'); st.setProperty('--pt', cover.t + 'px');
  st.setProperty('--pw', cover.w + 'px'); st.setProperty('--ph', cover.h + 'px');
  st.transformOrigin = `${cfg.vp[0] / cfg.w * 100}% ${cfg.vp[1] / cfg.h * 100}%`;
  dark.width = Math.round(W * q); dark.height = Math.round(H * q);
  MW = Math.max(64, Math.round(W / 6)); MH = Math.max(64, Math.round(H / 6)); mem.width = MW; mem.height = MH;

  const rnd = rng(20261110), n = phone ? 420 : 1000; dust = [];
  for (let i = 0; i < n; i++) dust.push({ x: rnd() * W, y: rnd() * H, s: .7 + rnd() * 1.5, ph: rnd() * 6.28, b: rnd() < .22 });

  for (const a of photos) {
    const [x, y, w, ry] = cfg.ph[a.dataset.k];
    a.style.setProperty('--x', (cover.l + x * s) + 'px'); a.style.setProperty('--y', (cover.t + y * s) + 'px');
    a.style.setProperty('--w', (w * s) + 'px'); a.style.setProperty('--ry', ry + 'deg');
  }
  setPulse(); onScroll(); render(0, performance.now());
}

// light that runs along the camera's path, from the visitor to the horizon
function setPulse() {
  const NS = 'http://www.w3.org/2000/svg';
  pulse.setAttribute('viewBox', `0 0 ${cfg.w} ${cfg.h}`);
  pulseLine.setAttribute('d', cfg.line);
  pulseG.textContent = '';
  if (REDUCE) return;
  const n = 6, dur = 3.6;
  for (let i = 0; i < n; i++) for (const halo of [true, false]) {
    const c = document.createElementNS(NS, 'circle');
    if (halo) c.setAttribute('class', 'halo');
    const k = halo ? 2.6 : 1;
    const m = document.createElementNS(NS, 'animateMotion');
    m.setAttribute('dur', dur + 's'); m.setAttribute('begin', (-i * dur / n).toFixed(2) + 's'); m.setAttribute('repeatCount', 'indefinite');
    m.setAttribute('keyPoints', '0;1'); m.setAttribute('keyTimes', '0;1'); m.setAttribute('calcMode', 'spline'); m.setAttribute('keySplines', '.2 .6 .4 1');
    const mp = document.createElementNS(NS, 'mpath'); mp.setAttribute('href', '#d-line'); m.appendChild(mp);
    const a = document.createElementNS(NS, 'animate');
    a.setAttribute('attributeName', 'r'); a.setAttribute('dur', dur + 's'); a.setAttribute('begin', (-i * dur / n).toFixed(2) + 's'); a.setAttribute('repeatCount', 'indefinite');
    a.setAttribute('values', `${cfg.r[0] * k};${cfg.r[1] * k}`); a.setAttribute('calcMode', 'spline'); a.setAttribute('keyTimes', '0;1'); a.setAttribute('keySplines', '.2 .6 .4 1');
    c.appendChild(m); c.appendChild(a); pulseG.appendChild(c);
  }
}

function pool(dy, e0) {
  const cx = cover.l + cfg.vp[0] * cover.s, cy = cover.t + cfg.vp[1] * cover.s + dy + (phone ? .03 : .075) * H;
  const grow = 1 + e0 * e0 * 9;
  return { cx, cy, rx: (phone ? .6 : .2) * W * grow, ry: (phone ? .24 : .41) * H * grow };
}

function render(dt, now) {
  const e0 = smooth(p / .3);                       // the known area grows with the scroll
  const D = 1 - smooth((p - .05) / .27);           // how dark the unknown still is
  const dy = dy0 * (1 - smooth(p / .28));
  const st = plate.style;
  const fixed = REDUCE || stage.dataset.live === 'live';
  st.setProperty('--px', (fixed ? 0 : -(par.x - .5) * 30).toFixed(2) + 'px');
  st.setProperty('--py', (dy - (fixed ? 0 : (par.y - .5) * 18)).toFixed(2) + 'px');
  st.setProperty('--ps', (1.04 + .07 * smooth(p)).toFixed(4));
  const P = pool(dy, e0);

  // 1. memory: what was looked at fades; where the visitor points now, it becomes known
  if (!REDUCE && dt > 0) {
    mctx.globalCompositeOperation = 'destination-out';
    mctx.fillStyle = `rgba(0,0,0,${(1 - Math.pow(.5, dt / 1.15)).toFixed(4)})`; mctx.fillRect(0, 0, MW, MH);
    if (ptr.on && D > .01) {
      mctx.globalCompositeOperation = 'source-over';
      const R = (phone ? .4 : .17) * W * (MW / W);
      blob(mctx, ptr.x * MW, ptr.y * MH, R, R * (MH / H) / (MW / W), Math.min(.85, dt * 7.5));
    }
  }

  // 2. the dark, with its openings
  ctx.setTransform(q, 0, 0, q, 0, 0);
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, W, H);
  if (D > .004) {
    ctx.fillStyle = `rgba(0,0,0,${D.toFixed(4)})`; ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'destination-out';
    blob(ctx, P.cx, P.cy, P.rx, P.ry, 1);
    if (!REDUCE) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'low'; ctx.drawImage(mem, 0, 0, MW, MH, 0, 0, W, H); }

    // 3. points of light on the edge of the known area
    ctx.globalCompositeOperation = 'source-over';
    const md = REDUCE ? null : mctx.getImageData(0, 0, MW, MH).data;
    const t = now / 1000;
    for (const pass of [false, true]) {
      ctx.fillStyle = pass ? '#ffffff' : 'rgb(255,170,120)';
      for (const d of dust) {
        if (d.b !== pass) continue;
        const ex = (d.x - P.cx) / P.rx, ey = (d.y - P.cy) / P.ry;
        const b = profile(Math.sqrt(ex * ex + ey * ey));
        const m = md ? md[(Math.min(MH - 1, d.y / H * MH | 0) * MW + Math.min(MW - 1, d.x / W * MW | 0)) * 4 + 3] / 255 : 0;
        const k = 1 - (1 - b) * (1 - m), e = 4 * k * (1 - k);
        if (e < .1) continue;
        ctx.globalAlpha = e * (REDUCE ? 1 : .62 + .38 * Math.sin(t * 2.4 + d.ph)) * D * (pass ? .95 : .8);
        ctx.fillRect(d.x, d.y, d.s, d.s);
      }
    }
    ctx.globalAlpha = 1;
  }

  // the hint sits under the opening
  hint.style.setProperty('--hx', (phone ? W / 2 : P.cx) + 'px');
  hint.style.setProperty('--hy', (phone ? P.cy + P.ry * .5 : P.cy + P.ry * .74) + 'px');
}

function frame(now) {
  raf = 0;
  const dt = Math.min(.05, Math.max(.001, (now - last) / 1000)); last = now;
  const k = 1 - Math.exp(-dt * 13);
  ptr.x += (ptr.tx - ptr.x) * k; ptr.y += (ptr.ty - ptr.y) * k;
  const k2 = 1 - Math.exp(-dt * 4.5);
  par.x += ((ptr.on ? ptr.x : .5) - par.x) * k2; par.y += ((ptr.on ? ptr.y : .5) - par.y) * k2;
  render(dt, now);
  if (now < activeUntil && heroOn) raf = requestAnimationFrame(frame);
}
function kick(ms = 3400) {
  if (!heroOn) return;
  activeUntil = Math.max(activeUntil, performance.now() + ms);
  if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
}

// the visitor's hand
function at(e) {
  if (REDUCE) return;
  const r = stage.getBoundingClientRect();
  ptr.tx = clamp((e.clientX - r.left) / r.width, 0, 1); ptr.ty = clamp((e.clientY - r.top) / r.height, 0, 1);
  if (!ptr.on) { ptr.x = ptr.tx; ptr.y = ptr.ty; }
  ptr.on = true; noteFound(); kick();
}
function noteFound() {
  if (found) return;
  found = 1;
  setTimeout(() => { if (p < .1) hint.innerHTML = '<b>That is a real place.</b> Scroll to light all of it.'; }, 1500);
}
stage.addEventListener('pointermove', at, { passive: true });
stage.addEventListener('pointerdown', (e) => {
  at(e);
  if (e.pointerType !== 'mouse' && !REDUCE) {            // a touch: the place answers at once, under the finger
    mctx.globalCompositeOperation = 'source-over';
    const R = .4 * W * (MW / W);
    blob(mctx, ptr.tx * MW, ptr.ty * MH, R, R, .8);
  }
}, { passive: true });
const leave = () => { ptr.on = false; kick(2800); };
stage.addEventListener('pointerleave', leave, { passive: true });
stage.addEventListener('pointercancel', leave, { passive: true });
stage.addEventListener('pointerup', (e) => { if (e.pointerType !== 'mouse') leave(); }, { passive: true });

// a phone is a window: tilt it and the opening moves
let tiltAt = 0;
function onTilt(e) {
  if (e.gamma == null || e.beta == null || p > .34 || !heroOn) return;
  const tx = clamp(.5 + e.gamma / 46, .06, .94), ty = clamp(.62 + (e.beta - 50) / 70, .3, .95);
  if (Math.abs(tx - ptr.tx) + Math.abs(ty - ptr.ty) < .03) return;             // the sensor never rests: ignore its noise
  ptr.tx += (tx - ptr.tx) * .5; ptr.ty += (ty - ptr.ty) * .5;
  if (!ptr.on) { ptr.x = tx; ptr.y = ty; }
  ptr.on = true; noteFound();
  const now = performance.now(); if (now - tiltAt > 300) { tiltAt = now; kick(1200); }
}
if (TOUCH && 'DeviceOrientationEvent' in window && !REDUCE) {
  const DOE = window.DeviceOrientationEvent;
  const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!IOS || typeof DOE.requestPermission !== 'function') addEventListener('deviceorientation', onTilt, { passive: true });
  else {
    // iPhone asks the visitor first: one plain button, and the system question appears only after a tap on it
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'd-tilt'; b.textContent = 'Tilt your phone to look around';
    b.addEventListener('click', () => {
      DOE.requestPermission().then((r) => { if (r === 'granted') { addEventListener('deviceorientation', onTilt, { passive: true }); b.remove(); } else b.textContent = 'Tilt is off. Touch the dark instead.'; })
        .catch(() => { b.textContent = 'Tilt is off. Touch the dark instead.'; });
    });
    first.appendChild(b);
  }
}

// the scroll: the visitor's own movement lights the place, stop by stop
function onScroll() {
  const r = hero.getBoundingClientRect();
  heroOn = r.bottom > 0 && r.top < H;
  p = clamp(-r.top / Math.max(1, r.height - H), 0, 1);
  const stop = p < .2 ? 0 : p < .5 ? 1 : p < .8 ? 2 : 3;
  if (stop !== stopNow) {
    stopNow = stop; stage.dataset.stop = stop;
    for (const c of caps) c.inert = +c.dataset.cap !== stop;              // a hidden stop takes no focus
    photoBox.inert = stop !== 2;
  }
  const f = 1 - smooth((p - .012) / .13);
  first.style.opacity = f.toFixed(3);
  first.style.transform = `translate3d(0, ${(-(1 - f) * 44).toFixed(1)}px, 0)`;
  first.style.visibility = f < .01 ? 'hidden' : 'visible';
  first.style.pointerEvents = f < .5 ? 'none' : '';
  first.inert = f < .5;
}
let sPending = false;
addEventListener('scroll', () => {
  if (sPending) return; sPending = true;
  requestAnimationFrame(() => { sPending = false; onScroll(); kick(500); });
}, { passive: true });
if ('ResizeObserver' in window) new ResizeObserver(() => layout(false)).observe(stage); else addEventListener('resize', () => layout(false));
PHONE_MQ.addEventListener?.('change', () => layout(true));

// place cards lift when they reach the middle of a touch screen
if (TOUCH && 'IntersectionObserver' in window) {
  const io = new IntersectionObserver((es) => { for (const e of es) e.target.classList.toggle('lit', e.isIntersecting); }, { rootMargin: '-38% 0px -38% 0px' });
  document.querySelectorAll('.d-card').forEach((c) => io.observe(c));
}

layout(true);
window.__d = { ptr, get p() { return p; }, kick };

// every photo is a door to its own spot: the distances come from data/places.json, never from typed numbers
fetch('data/places.json').then((r) => r.json()).then((d) => {
  const q = new URLSearchParams(location.search), keep = new URLSearchParams();
  for (const k of ['force3d', 'shot', 'q', 'tier', 'assets']) if (q.has(k)) keep.set(k, q.get(k));
  const tail = keep.toString() ? `&${keep}` : '';
  (d.hero_photos || []).forEach((h, i) => {
    const a = photos.find((x) => +x.dataset.k === i + 1);
    if (!a) return;
    const m = Math.round(h.at_m);
    a.href = `explore.html?map=${d.hero}&at=${m}${tail}`;
    const im = a.querySelector('img');
    if (im) im.alt = `Camera photo, ${m} m along the path. Open the 3-D place at this spot.`;
  });
}).catch(() => {});

// The live 3-D place under the dark. Measured on an RTX 5090 (2026-11-12): 60 frames a second, no frame over 20 ms.
// Default: on a desktop screen with a mouse. A phone keeps the picture (fast, and kind to the battery).
// ?live=1 forces it, ?live=0 keeps the picture. The engine itself stays a picture on a weak device, on Save-Data and
// with reduced motion. It follows the pointer by a few degrees and nothing else moves. Its stepping circles are hidden
// here (css/dark.css): the doors of this screen are the buttons and the photos.
const LIVE = new URLSearchParams(location.search).get('live');
const SAVE = !!navigator.connection?.saveData;
const wantLive = LIVE === '1' || (LIVE !== '0' && !REDUCE && !TOUCH && !SAVE && matchMedia('(hover: hover) and (pointer: fine) and (min-width: 1000px)').matches);
if (wantLive) {
  const start = () => import('./place/mount.js').then(async ({ mountPlace }) => {
    const box = document.createElement('div');
    box.className = 'd-live';
    plate.appendChild(box);
    let handle = null;
    handle = await mountPlace(box, {
      mode: 'frame',
      onEvent(type, d) {
        if (type === 'state') { stage.dataset.live = d.state; kick(600); }
        else if (type === 'enter') location.href = `explore.html?map=${handle?.place?.id || box.dataset.place || 'oak_161206'}${Number.isFinite(d?.at) ? `&at=${Math.round(d.at)}` : ''}`;
      },
    });
    window.__d.live = handle;
  }).catch((e) => { console.warn('[home] the first screen stays a picture:', e); });
  // the first paint comes first: the 3-D code waits for the page to load and for an idle moment
  const idle = () => ('requestIdleCallback' in window ? requestIdleCallback(start, { timeout: 2500 }) : setTimeout(start, 600));
  if (document.readyState === 'complete') idle(); else addEventListener('load', idle, { once: true });
}
