// site v12: ember literals read the accent token (tools/make_site_v12.py)
const __acc = () => (getComputedStyle(document.documentElement).getPropertyValue('--path').trim() || '#6fc7b0');
const __accRgb = () => (getComputedStyle(document.documentElement).getPropertyValue('--path-rgb').trim() || '111, 199, 176');
const __accRim = () => (getComputedStyle(document.documentElement).getPropertyValue('--path-rim').trim() || '#e3f4ee');
// The atlas from above, in 2-D (MASTER_PLAN.md 2.5): every island's footprint cells and xclean's route in ion, from
// atlas.json alone (about 85 KB; no three.js). Used by the explore minimap, the still (T0) path's atlas, and the Maps
// page when it cannot go live. The static layer (footprints, routes) is baked per view; a frame draws it plus the focus
// ring and the camera with its heading fan.
const ION = __acc();

export class AtlasMap {
  /** canvas: a 2-D canvas; atlas: atlas.json; opts: {labels (draw names), titles: {id: title}, pad} */
  constructor(canvas, atlas, { labels = false, titles = {}, pad = 10 } = {}) {
    this.c = canvas; this.A = atlas; this.labels = labels; this.titles = titles; this.pad = pad;
    this.ctx = canvas.getContext('2d');
    this.layer = document.createElement('canvas');
    this.ids = atlas.order.filter(id => atlas.islands[id]);
    this.w = 0; this.h = 0; this.key = '';
    // world-space footprint and route of every island (x, z), and the arrangement's bounds
    this.geo = {};
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const id of this.ids) {
      const isl = atlas.islands[id], s = isl.scale, cy = Math.cos(isl.place.yaw), sy = Math.sin(isl.place.yaw);
      const W = (x, z) => [isl.place.x + (cy * x + sy * z) * s, isl.place.z + (-sy * x + cy * z) * s];
      const foot = isl.foot.map(([x, z]) => W(x, z)), route = isl.route.map(([x, , z]) => W(x, z));
      for (const [x, z] of foot) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
      this.geo[id] = { foot, route, cell: isl.foot_cell * s, c: [isl.place.x, isl.place.z], r: isl.radius * s, rosario: id.startsWith('rosario_') };
    }
    this.bounds = [x0, z0, x1, z1];
    this.resize();
  }
  resize() {
    const r = this.c.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = r.width; this.h = r.height; this.dpr = dpr;
    this.c.width = this.layer.width = Math.round(r.width * dpr);
    this.c.height = this.layer.height = Math.round(r.height * dpr);
    this.key = '';
    return true;
  }
  /** The transform for a view: centre [x, z] (default: the whole arrangement) and zoom (1 = fit all). */
  _fit(centre, zoom) {
    const [x0, z0, x1, z1] = this.bounds, pad = this.pad;
    const s0 = Math.min((this.w - 2 * pad) / (x1 - x0), (this.h - 2 * pad) / (z1 - z0));
    const s = s0 * zoom;
    const cx = centre ? centre[0] : (x0 + x1) / 2, cz = centre ? centre[1] : (z0 + z1) / 2;
    this.s = s;
    this.T = (x, z) => [this.w / 2 + (x - cx) * s, this.h / 2 + (z - cz) * s];
  }
  _bake(centre, zoom) {
    const key = `${this.w}x${this.h}:${centre ? centre.map(v => v.toFixed(0)).join(',') : '-'}:${zoom.toFixed(3)}`;
    if (key === this.key) return;
    this.key = key;
    this._fit(centre, zoom);
    const g = this.layer.getContext('2d');
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    for (const id of this.ids) {
      const G = this.geo[id], cs = Math.max(1, G.cell * this.s * 0.9);
      g.fillStyle = G.rosario ? 'rgba(214,226,200,.42)' : 'rgba(220,230,240,.36)';
      for (const [x, z] of G.foot) { const [px, py] = this.T(x, z); g.fillRect(px - cs / 2, py - cs / 2, cs, cs); }
      g.strokeStyle = `rgba(${__accRgb()}, .85)`; g.lineWidth = 1.4; g.lineJoin = g.lineCap = 'round';
      g.beginPath();
      G.route.forEach(([x, z], i) => { const [px, py] = this.T(x, z); if (i) g.lineTo(px, py); else g.moveTo(px, py); });
      g.stroke();
    }
  }
  /** state: {centre, zoom, focus, hi: Set, cam: {x, z, heading} | null}. Returns nothing; cheap when unchanged. */
  draw(state = {}) {
    if (!this.w && !this.resize()) return;
    const zoom = state.zoom || 1;
    this._bake(state.centre || null, zoom);
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.c.width, this.c.height);
    g.drawImage(this.layer, 0, 0);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const hi = state.hi || new Set();
    for (const id of this.ids) {
      const G = this.geo[id], [x, y] = this.T(G.c[0], G.c[1]), on = hi.has(id) || id === state.focus;
      if (on) { g.strokeStyle = ION; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, Math.max(8, G.r * this.s + 4), 0, Math.PI * 2); g.stroke(); }
      if (this.labels) {
        g.font = '600 12px ui-monospace, SFMono-Regular, Consolas, monospace';
        g.fillStyle = on ? '#f4f4f4' : 'rgba(230,230,230,.8)';
        const tx = x + Math.max(8, G.r * this.s) + 4, txt = this.titles[id] ? `${this.titles[id]} · ${id}` : id;
        // names never run off the canvas: they go to the island's left when the right side is short
        const tw = g.measureText(txt).width;
        g.fillText(txt, tx + tw > this.w - 4 ? Math.max(4, x - Math.max(8, G.r * this.s) - 4 - tw) : tx, y + 4);
      }
    }
    const cam = state.cam;
    if (cam) {
      const [x, y] = this.T(cam.x, cam.z);
      const a = -Math.PI / 2 - cam.heading;      // heading 0 looks down -z (up on the map)
      g.fillStyle = `rgba(${__accRgb()}, .24)`;
      g.beginPath(); g.moveTo(x, y); g.arc(x, y, 22, a - 0.42, a + 0.42); g.closePath(); g.fill();
      g.fillStyle = '#000'; g.beginPath(); g.arc(x, y, 5, 0, 7); g.fill();
      g.fillStyle = '#f4f4f4'; g.beginPath(); g.arc(x, y, 3.2, 0, 7); g.fill();
    }
  }
  /** The island under a point (CSS px in the canvas), or null. */
  pick(px, py) {
    if (!this.T) return null;
    let best = null, bd = Infinity;
    for (const id of this.ids) {
      const G = this.geo[id], [x, y] = this.T(G.c[0], G.c[1]);
      const d = Math.hypot(px - x, py - y) / Math.max(18, G.r * this.s);
      if (d < 1 && d < bd) { bd = d; best = id; }
    }
    return best;
  }
  /** Where an island sits in the canvas (CSS px). */
  where(id) { const G = this.geo[id]; return G && this.T ? this.T(G.c[0], G.c[1]) : null; }
}
