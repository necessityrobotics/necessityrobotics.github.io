// The live minimap: the chapter's route from above (data/routes.json), the stretch the scroll rides in ion, and the camera
// dot with its heading, moving in step with the 3-D view (or the poster in 2-D mode). Plain 2-D canvas; the static route is
// drawn once per chapter into a cached layer, so a frame costs one drawImage plus a short path.
const ION = '#6cc9ff';

export class Minimap {
  constructor(canvas, scaleEl) {
    this.c = canvas; this.scaleEl = scaleEl;
    this.ctx = canvas.getContext('2d');
    this.layer = document.createElement('canvas');
    this.track = null; this.seg = null; this.last = null;
    this.xy = [0, 0, 0];
    this.resize();
  }
  resize() {
    const r = this.c.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = r.width; this.h = r.height; this.dpr = dpr;
    this.c.width = this.layer.width = Math.round(r.width * dpr);
    this.c.height = this.layer.height = Math.round(r.height * dpr);
    if (this.track) this._bake();
    this.last = null;
    return true;
  }
  /** track: Track.fromRoute(); seg: [t0, t1] on the replay clock. */
  set(track, seg) {
    this.track = track; this.seg = seg; this.last = null;
    this._bake();
  }
  _fit() {
    const X = this.track.xy;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < X.length; i += 2) { x0 = Math.min(x0, X[i]); x1 = Math.max(x1, X[i]); y0 = Math.min(y0, X[i + 1]); y1 = Math.max(y1, X[i + 1]); }
    const pad = 10, W = this.w - 2 * pad, H = this.h - 2 * pad;
    const s = Math.min(W / Math.max(1e-3, x1 - x0), H / Math.max(1e-3, y1 - y0));
    const ox = pad + (W - (x1 - x0) * s) / 2, oy = pad + (H - (y1 - y0) * s) / 2;
    // screen y grows downwards; the route's y axis points "up" on the map (a top view, not mirrored)
    this.T = (x, y) => [ox + (x - x0) * s, this.h - (oy + (y - y0) * s)];
    this.s = s;
  }
  _path(ctx, i0, i1, tEnd = null) {
    const X = this.track.xy;
    ctx.beginPath();
    for (let i = i0; i <= i1; i++) {
      const [x, y] = this.T(X[i * 2], X[i * 2 + 1]);
      if (i === i0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    if (tEnd != null) { this.track.xyAt(tEnd, this.xy); const [x, y] = this.T(this.xy[0], this.xy[1]); ctx.lineTo(x, y); }
  }
  _range(t0, t1) {
    const [a] = this.track.locate(t0), [b, k] = this.track.locate(t1);
    return [a, Math.min(this.track.n - 1, b + (k > 0 ? 1 : 0))];
  }
  _bake() {
    if (!this.w) return;
    this._fit();
    const g = this.layer.getContext('2d');
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    g.lineJoin = g.lineCap = 'round';
    g.strokeStyle = 'rgba(255,255,255,.34)'; g.lineWidth = 1.4;
    this._path(g, 0, this.track.n - 1); g.stroke();
    const [a, b] = this._range(this.seg[0], this.seg[1]);
    g.strokeStyle = 'rgba(108,201,255,.42)'; g.lineWidth = 3;
    this._path(g, a, b); g.stroke();
    // a scale bar on the 1-2-5 ladder, about a fifth of the width
    if (this.scaleEl) {
      const want = this.w * 0.22 / this.s;
      const p = Math.pow(10, Math.floor(Math.log10(want)));
      const L = [1, 2, 5, 10].map(k => k * p).reduce((best, v) => (Math.abs(v - want) < Math.abs(best - want) ? v : best), p);
      this.scaleEl.innerHTML = `<i style="width:${Math.round(L * this.s)}px"></i>${L >= 1000 ? `${L / 1000} km` : `${L} m`}`;
    }
  }
  /** Draw the camera at t (replay clock); yaw (radians, optional): the look-around, which turns the heading fan (DE-18). */
  draw(t, yaw = 0) {
    if (!this.track || !this.w) return;
    const key = `${t.toFixed(2)}:${yaw.toFixed(2)}`;
    if (key === this.last) return;
    this.last = key;
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.c.width, this.c.height);
    g.drawImage(this.layer, 0, 0);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.lineJoin = g.lineCap = 'round';
    const t0 = this.seg[0], tt = Math.max(t0, Math.min(this.seg[1], t));
    if (tt > t0) {
      const [a, b] = this._range(t0, tt);
      g.strokeStyle = ION; g.lineWidth = 3;
      this._path(g, a, Math.max(a, b - 1), tt); g.stroke();
    }
    this.track.xyAt(t, this.xy);
    const [x, y] = this.T(this.xy[0], this.xy[1]);
    const h = -this.xy[2] - yaw;  // screen y is flipped; a look to the left (positive yaw) turns the fan left
    // heading wedge (a field-of-view fan), then the dot
    g.fillStyle = 'rgba(108,201,255,.28)';
    g.beginPath(); g.moveTo(x, y); g.arc(x, y, 16, h - 0.42, h + 0.42); g.closePath(); g.fill();
    g.fillStyle = '#000'; g.beginPath(); g.arc(x, y, 5.5, 0, 7); g.fill();
    g.fillStyle = ION; g.beginPath(); g.arc(x, y, 4, 0, 7); g.fill();
    g.strokeStyle = '#f4f4f4'; g.lineWidth = 1.2; g.beginPath(); g.arc(x, y, 6.5, 0, 7); g.stroke();
  }
}
