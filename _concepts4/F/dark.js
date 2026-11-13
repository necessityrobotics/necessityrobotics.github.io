// V12 first screen: "Out of the dark" (owner 2026-11-13: "copy the background animation of landing page from this
// version 127.0.0.1:8894 (only animation, black gets cleared when mouse moves etc.), else what we decided (colors etc.)").
// Ported from site v4.1 js/dark.js: a 2-D canvas of darkness over the live place. One soft opening shows the place where
// the path goes; where the visitor points, the dark clears and stays clear for a moment (a memory that fades, half-life
// 1.15 s); points of light sit on the edge of what is known. The scroll lights the whole place. The dust takes the
// path colour (the accent system), not the old ember. Frames: only while the pointer, the scroll or a fade runs.
// Reduced motion: no memory, no dust motion; the scroll still lights the place.
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;
const STOPS = [[0, 1], [.42, .86], [.72, .36], [.9, .08], [1, 0]];     // one soft opening: full in the middle, a long tail

function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
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

/**
 * canvas: the darkness canvas over the place; stage: the element whose box it covers.
 * opts.at: where the path meets the horizon, as fractions of the stage ([x, y]).
 * Returns { setP(p) (0 = dark, 1 = lit; the page maps its scroll to it), destroy() }.
 */
export function mountDark(canvas, stage, opts = {}) {
  const VP = opts.at || [0.62, 0.36];
  const SH = opts.shape || [0.2, 0.41];               // the opening's half width and half height, as fractions of the stage
  const LIGHT = !!opts.light;                          // phones and tablets: fewer pixels and fewer points of light
  const ctx = canvas.getContext('2d');
  const mem = document.createElement('canvas'), mctx = mem.getContext('2d', { willReadFrequently: true });
  const css = (n, fb) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb;
  const dustCol = `rgb(${css('--path-rgb', css('--acc-rgb', '111, 199, 176'))})`;
  let W = 0, H = 0, q = 1, MW = 0, MH = 0, dust = [], p = 0, raf = 0, last = 0, activeUntil = 0, on = true;
  const ptr = { x: .5, y: .5, tx: .5, ty: .5, on: false };

  function layout() {
    const r = stage.getBoundingClientRect();
    W = r.width; H = r.height;
    if (!W || !H) return;
    q = Math.min(window.devicePixelRatio || 1, LIGHT ? 1 : 1.5, Math.sqrt((LIGHT ? 0.9e6 : 2.4e6) / (W * H)));   // at most 2.4 (touch: 0.9) megapixels
    canvas.width = Math.round(W * q); canvas.height = Math.round(H * q);
    MW = Math.max(64, Math.round(W / 6)); MH = Math.max(64, Math.round(H / 6)); mem.width = MW; mem.height = MH;
    const rnd = rng(20261110), n = LIGHT ? 420 : 1000; dust = [];
    for (let i = 0; i < n; i++) dust.push({ x: rnd() * W, y: rnd() * H, s: .7 + rnd() * 1.5, ph: rnd() * 6.28, b: rnd() < .22 });
    render(0, performance.now());
  }
  function pool(e0) {
    const grow = 1 + e0 * e0 * 9;
    return { cx: VP[0] * W, cy: VP[1] * H + .075 * H, rx: SH[0] * W * grow, ry: SH[1] * H * grow };
  }
  function render(dt, now) {
    if (!W) return;
    const e0 = smooth(p / .55);                    // the known area grows with the scroll
    const D = 1 - smooth((p - .05) / .5);          // how dark the unknown still is
    const P = pool(e0);
    // 1. memory: what was looked at fades; where the visitor points now, it becomes known
    if (!REDUCE && dt > 0) {
      mctx.globalCompositeOperation = 'destination-out';
      mctx.fillStyle = `rgba(0,0,0,${(1 - Math.pow(.5, dt / 1.15)).toFixed(4)})`; mctx.fillRect(0, 0, MW, MH);
      if (ptr.on && D > .01) {
        mctx.globalCompositeOperation = 'source-over';
        const R = .17 * W * (MW / W);
        blob(mctx, ptr.x * MW, ptr.y * MH, R, R * (MH / H) / (MW / W), Math.min(.85, dt * 7.5));
      }
    }
    // 2. the dark, with its openings
    ctx.setTransform(q, 0, 0, q, 0, 0);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, W, H);
    canvas.style.visibility = D > .004 ? 'visible' : 'hidden';
    if (D <= .004) return;
    ctx.fillStyle = `rgba(0,0,0,${D.toFixed(4)})`; ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'destination-out';
    blob(ctx, P.cx, P.cy, P.rx, P.ry, 1);
    if (!REDUCE) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'low'; ctx.drawImage(mem, 0, 0, MW, MH, 0, 0, W, H); }
    // 3. points of light on the edge of the known area (the path colour and white)
    ctx.globalCompositeOperation = 'source-over';
    const md = REDUCE ? null : mctx.getImageData(0, 0, MW, MH).data;
    const t = now / 1000;
    for (const pass of [false, true]) {
      ctx.fillStyle = pass ? '#ffffff' : dustCol;
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
  function frame(now) {
    raf = 0;
    // phones and tablets: at most 30 draws a second (a 120 Hz screen would otherwise redraw 0.9 MP 120 times)
    if (LIGHT && now - last < 31) { if (now < activeUntil && on) raf = requestAnimationFrame(frame); return; }
    const dt = Math.min(.05, Math.max(.001, (now - last) / 1000)); last = now;
    const k = 1 - Math.exp(-dt * 13);
    ptr.x += (ptr.tx - ptr.x) * k; ptr.y += (ptr.ty - ptr.y) * k;
    render(dt, now);
    if (now < activeUntil && on) raf = requestAnimationFrame(frame);
  }
  function kick(ms = 3400) {
    if (!on) return;
    activeUntil = Math.max(activeUntil, performance.now() + ms);
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }
  const at = (x, y) => {
    const r = stage.getBoundingClientRect();
    ptr.tx = clamp((x - r.left) / r.width, 0, 1); ptr.ty = clamp((y - r.top) / r.height, 0, 1);
    if (!ptr.on) { ptr.x = ptr.tx; ptr.y = ptr.ty; }
    ptr.on = true; kick();
  };
  const move = e => { if (!REDUCE && e.pointerType !== 'touch') at(e.clientX, e.clientY); };
  // a finger: touch events keep coming while the page scrolls (pointer events stop there), so the dark follows the finger
  const touch = e => { const t = e.touches && e.touches[0]; if (!REDUCE && t) at(t.clientX, t.clientY); };
  addEventListener('pointermove', move, { passive: true });
  addEventListener('touchstart', touch, { passive: true });
  addEventListener('touchmove', touch, { passive: true });
  // touch screens: one slow look across the opening when the page opens, so the visitor sees that the dark answers
  let introT = [];
  if (opts.intro && !REDUCE) {
    const path = [[VP[0] + .16, VP[1] - .12], [VP[0] - .14, VP[1] + .06], [VP[0] + .06, VP[1] + .2], [VP[0], VP[1] + .04]];
    path.forEach(([x, y], i) => introT.push(setTimeout(() => {
      if (!on) return;
      ptr.tx = clamp(x, 0, 1); ptr.ty = clamp(y, 0, 1);
      if (!ptr.on) { ptr.x = ptr.tx; ptr.y = ptr.ty; }
      ptr.on = true; kick(2400);
    }, 700 + i * 650)));
  }
  const ro = new ResizeObserver(layout); ro.observe(stage);
  layout();
  return {
    setP(v) { v = clamp(v, 0, 1); if (v === p) return; p = v; on = p < .99; if (on) kick(600); else render(0, performance.now()); },
    destroy() {
      removeEventListener('pointermove', move); removeEventListener('touchstart', touch); removeEventListener('touchmove', touch);
      introT.forEach(clearTimeout); ro.disconnect();
    },
  };
}
