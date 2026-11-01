// The "stars": a sparse sample of a map's points (stereo depth of xclean's keyframes, placed with xclean's live poses;
// data/starfield.json, built by tools/build_site_data.py)
// drawn on a 2-D canvas in perspective, slowly orbiting, with xclean's live trajectory drawing in as one thin ion line.
// Cheap on every device (a few thousand dots per frame, at most 30 frames a second, colours from a fixed palette so a
// frame builds no strings); pauses off-screen and in hidden tabs; one still frame under prefers-reduced-motion.
import { REDUCED } from './site.js';

const FRAME_MS = 1000 / 30;
const ALPHAS = Array.from({ length: 16 }, (_, i) => `rgba(226,236,250,${(0.9 * i / 15).toFixed(3)})`);

export class PointField {
  constructor(canvas, data, { trail = true, speed = 1, tilt = 0.55, zoom = 1, centerX = 0.5, centerY = 0.52, onFrame = null } = {}) {
    this.c = canvas; this.ctx = canvas.getContext('2d', { alpha: true });
    this.n = data.p.length / 3;
    this.P = Float32Array.from(data.p);
    this.T = Float32Array.from(data.traj || []);
    this.trail = trail; this.speed = speed; this.tilt = tilt; this.zoom = zoom; this.cx = centerX; this.cy = centerY;
    this.onFrame = onFrame;
    this.t0 = performance.now(); this.yaw = -0.6; this.px = 0; this.py = 0; this.tx = 0; this.ty = 0;
    this.visible = true; this.raf = 0; this.last = 0;
    this.resize = this.resize.bind(this); this.tick = this.tick.bind(this);
    new ResizeObserver(this.resize).observe(canvas);
    this.resize();
    const io = new IntersectionObserver(es => { this.visible = es[0].isIntersecting; this.kick(); });
    io.observe(canvas);
    document.addEventListener('visibilitychange', () => this.kick());
    if (!REDUCED) window.addEventListener('pointermove', e => { this.tx = (e.clientX / innerWidth - .5); this.ty = (e.clientY / innerHeight - .5); }, { passive: true });
    this.kick();
  }
  resize() {
    const r = this.c.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = Math.max(1, r.width); this.h = Math.max(1, r.height);
    this.c.width = Math.round(this.w * dpr); this.c.height = Math.round(this.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw(performance.now());
  }
  kick() {
    if (REDUCED) { this.draw(this.t0 + 9000); return; }
    if (this.visible && !document.hidden && !this.raf) this.raf = requestAnimationFrame(this.tick);
  }
  tick(now) {
    this.raf = 0;
    if (!this.visible || document.hidden) return;
    if (now - this.last >= FRAME_MS - 1) { this.last = now; this.draw(now); }
    this.raf = requestAnimationFrame(this.tick);
  }
  draw(now) {
    const { ctx, w, h } = this;
    const el = (now - this.t0) / 1000;
    this.px += (this.tx - this.px) * 0.04; this.py += (this.ty - this.py) * 0.04;
    const yaw = this.yaw + el * 0.035 * this.speed + this.px * 0.25;
    const pitch = this.tilt + this.py * 0.12;
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    const s = Math.min(w, h * 1.5) * 0.62 * this.zoom, D = 2.6, ox = w * this.cx, oy = h * this.cy;
    ctx.clearRect(0, 0, w, h);
    const P = this.P;
    // points: white dust, nearer = brighter / larger
    for (let i = 0; i < this.n; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      const x1 = x * cy - z * sy, z1 = x * sy + z * cy;
      const y2 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
      const k = D / (D + z2);
      if (k <= 0) continue;
      const X = ox + x1 * k * s, Y = oy - y2 * k * s;
      if (X < -4 || X > w + 4 || Y < -4 || Y > h + 4) continue;
      const a = Math.min(0.9, 0.18 + 0.5 * (k - 0.6));
      const r = 0.55 + 0.9 * Math.max(0, k - 0.7);
      const ai = Math.min(15, Math.round(a / 0.9 * 15));
      if (ai <= 0) continue;
      ctx.fillStyle = ALPHAS[ai];
      ctx.fillRect(X - r, Y - r, r * 2, r * 2);
    }
    // the trajectory: draws in over 14 s, then stays
    const T = this.T, nt = T.length / 3;
    if (this.trail && nt > 1) {
      const upto = REDUCED ? nt : Math.min(nt, Math.floor(nt * Math.min(1, el / 14)));
      ctx.lineWidth = 1.6; ctx.strokeStyle = 'rgba(108,201,255,.95)'; ctx.lineJoin = 'round';
      ctx.beginPath();
      let head = null;
      for (let i = 0; i < upto; i++) {
        const x = T[i * 3], y = T[i * 3 + 1], z = T[i * 3 + 2];
        const x1 = x * cy - z * sy, z1 = x * sy + z * cy;
        const y2 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
        const k = D / (D + z2);
        const X = ox + x1 * k * s, Y = oy - y2 * k * s;
        if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
        head = [X, Y];
      }
      ctx.stroke();
      if (head && upto < nt) {
        ctx.fillStyle = '#bfe6ff'; ctx.beginPath(); ctx.arc(head[0], head[1], 3, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(108,201,255,.35)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(head[0], head[1], 9, 0, Math.PI * 2); ctx.stroke();
      }
      this.onFrame?.(upto / nt);
    }
  }
}
