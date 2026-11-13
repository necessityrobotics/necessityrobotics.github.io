// Necessity Robotics v4, lane ENGINE: the stepping circles. Real <button>s, projected onto the ground under the camera's
// path after every drawn frame (BUILD_PLAN 3.2). They are DOM, not pixels: a keyboard reaches them, a screen reader names
// them, and a tap needs no 3-D picking. The same layer holds the small ring + tooltip that follow a mouse over the
// orange path (every drawn path is a door: BRIEF T4).
//
// A circle of radius r metres on the ground becomes an ellipse on screen. The ellipse is a round element under a CSS
// matrix whose two columns are the screen images of two ground directions (an affine copy of the perspective at the
// circle's centre), so it lies flat on the ground at any heading and pitch.
import * as THREE from 'three';
import { fmtLen } from '../v4/common.js';

const SLOTS = [1, 2, 3, 4, 5, -1];          // steps ahead (in the direction the view faces) and one behind
const R_WALK = 0.30, R_RIDE = 0.42;          // metres (ground lights, owner 11-12); a near one is smaller still

export class StepCircles {
  /** layer: a positioned element over the canvas. o: { mode: 'frame' | 'full', label (HTML), step (metres), onPick(at) } */
  constructor(layer, o) {
    this.layer = layer; this.o = o;
    this.live = false; this.above = false; this.hidden = false;
    this._c = { x: 0, y: 0 }; this._a = { x: 0, y: 0 }; this._b = { x: 0, y: 0 };
    this._g = new THREE.Vector3(); this._g2 = new THREE.Vector3();
    this.slots = SLOTS.map(k => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'pl-step'; b.hidden = true; b.dataset.k = String(k);
      b.innerHTML = '<i class="pl-ring" aria-hidden="true"><b class="pl-chev"></b></i>';
      b.addEventListener('click', e => { e.stopPropagation(); if (b._at != null) o.onPick(b._at); });
      layer.appendChild(b);
      return { k, b, ring: b.firstChild, chev: b.firstChild.firstChild, shown: false };
    });
    this.tag = document.createElement('span');
    this.tag.className = 'pl-step-label'; this.tag.hidden = true; this.tag.setAttribute('aria-hidden', 'true');
    this.tag.innerHTML = o.label || 'Step here';
    layer.appendChild(this.tag);
    this.pick = document.createElement('div');
    this.pick.className = 'pl-pick'; this.pick.hidden = true; this.pick.setAttribute('aria-hidden', 'true');
    this.pick.innerHTML = '<i></i><span></span>';
    layer.appendChild(this.pick);
    this.you = document.createElement('div');                 // "You are here", in the view from above
    this.you.className = 'pl-you'; this.you.hidden = true; this.you.setAttribute('aria-hidden', 'true');
    this.you.innerHTML = '<i></i><span>You are here</span>';
    layer.appendChild(this.you);
  }
  setLive(on) { this.live = on; this.layer.dataset.live = on ? '1' : '0'; }
  setAbove(on) { this.above = on; }
  setHidden(h) { this.hidden = h; }

  /**
   * Called by the engine after each drawn frame: put every circle where its ground point is on screen now.
   * Two passes: first every position is worked out and tested (reads), then the styles are written. A circle that a
   * panel of the page covers at its centre or at one of eight points of its edge is not shown, so no circle on screen is ever
   * half under a control (the next one along the path is then the nearest).
   */
  place(E) {
    const S = E.S, tr = E.track, W = E.W, H = E.H;
    const on = this.live && !this.hidden && S.above.k < 0.03 && !S.riding;
    const base = S.tw ? S.tw.to : S.at, dir = S.facing, R = E.ride_ ? R_RIDE : R_WALK, eye = E.stage.camera.position;
    const c = this._c, a = this._a, b = this._b, g = this._g, g2 = this._g2;
    const used = [], box = on ? E.el.getBoundingClientRect() : null;
    const free = (x, y) => { const top = document.elementFromPoint(box.left + x, box.top + y); return !top || E.el.contains(top); };
    // pass 1: geometry and visibility
    for (const s of this.slots) {
      let at = base + dir * s.k * E.step, show = on;
      if (at > E.total) at = E.total; else if (at < 0) at = 0;
      if (Math.abs(at - base) < E.step * 0.45 || used.some(u => Math.abs(u - at) < E.step * 0.45)) show = false;
      if (show) {
        tr.ground(at, g);
        const r = Math.min(R, 0.105 * g.distanceTo(eye));
        show = E.project(g, c) && E.project(g2.set(g.x + r, g.y, g.z), a) && E.project(g2.set(g.x, g.y, g.z + r), b);
      }
      if (show) {
        const ax = a.x - c.x, ay = a.y - c.y, bx = b.x - c.x, by = b.y - c.y;
        const major = Math.max(Math.hypot(ax, ay), Math.hypot(bx, by));
        const hx = Math.hypot(ax, bx), hy = Math.hypot(ay, by);          // half the ellipse's width and height on screen
        // a circle is shown whole or not at all: never cut by an edge of the picture
        show = major >= 9 && major < W * 0.3 && c.x - hx > 2 && c.x + hx < W - 2 && c.y > H * 0.12 && c.y + hy < H - 3;
        if (show) show = free(c.x, c.y) && free(c.x - hx * 0.95, c.y) && free(c.x + hx * 0.95, c.y) && free(c.x, c.y - hy * 0.95) && free(c.x, c.y + hy * 0.95)
          && free(c.x - hx * 0.68, c.y - hy * 0.68) && free(c.x + hx * 0.68, c.y - hy * 0.68) && free(c.x - hx * 0.68, c.y + hy * 0.68) && free(c.x + hx * 0.68, c.y + hy * 0.68);
        if (show) { s.g = { at, cx: c.x, cy: c.y, ax, ay, bx, by, major, hx, hy }; used.push(at); }
      }
      if (!show) s.g = null;
    }
    // pass 2: write
    let near = null;
    for (const s of this.slots) {
      const q = s.g;
      if (!q) { if (s.shown) { s.b.hidden = true; s.shown = false; } s.b._at = null; continue; }
      s.b._at = q.at;
      s.b.style.transform = `translate(${q.cx.toFixed(1)}px, ${q.cy.toFixed(1)}px)`;
      s.ring.style.transform = `matrix(${(q.ax / 50).toFixed(4)}, ${(q.ay / 50).toFixed(4)}, ${(q.bx / 50).toFixed(4)}, ${(q.by / 50).toFixed(4)}, 0, 0)`;
      // the chevron points along the path, away from the visitor
      const tan = tr.tanAt(q.at), dx = -Math.sin(tan) * dir, dz = -Math.cos(tan) * dir;
      s.chev.style.transform = `rotate(${Math.atan2(dx, -dz).toFixed(3)}rad)`;
      const d = Math.abs(q.at - base), ahead = s.k > 0;
      const label = this.o.mode === 'frame'
        ? `Open this place in 3-D, ${fmtLen(d)} ${ahead ? 'ahead' : 'behind'} on the path`
        : `Step ${fmtLen(d)} ${ahead ? 'ahead' : 'back'} along the path`;
      if (s.b.getAttribute('aria-label') !== label) s.b.setAttribute('aria-label', label);
      if (!s.shown) { s.b.hidden = false; s.shown = true; }
      s.major = q.major; s.cx = q.cx; s.cy = q.cy; s.hx = q.hx; s.hy = q.hy;
      if (ahead && (!near || s.k < near.k)) near = s;
    }
    for (const s of this.slots) s.b.classList.toggle('is-near', s === near);
    if (near) {
      const t = this.tag;
      if (t.hidden) t.hidden = false;
      const lw = t.offsetWidth || 96, lh = t.offsetHeight || 34;
      // the label sits left of the nearest circle; else right of it; else above it. A place is good when the label is
      // inside the picture and no panel of the page covers it. No good place: no label (the circle keeps its arrow).
      const fits = (x, y) => x >= 6 && x + lw <= W - 6 && y - lh / 2 >= 4 && y + lh / 2 <= H - 2 && free(x + 3, y) && free(x + lw / 2, y) && free(x + lw - 3, y);
      const y0 = Math.min(H - lh / 2 - 3, near.cy);
      const tries = [['lhs', near.cx - near.hx - 14 - lw, y0], ['rhs', near.cx + near.hx + 14, y0],
        ['top', Math.min(W - lw - 6, Math.max(6, near.cx - lw / 2)), near.cy - near.hy - 10 - lh / 2]];
      const at = tries.find(([, x, y]) => fits(x, y));
      t.style.visibility = at ? '' : 'hidden';
      if (at) {
        t.classList.toggle('is-rhs', at[0] === 'rhs');
        t.classList.toggle('is-top', at[0] === 'top');
        t.style.transform = `translate(${Math.round(at[1])}px, ${Math.round(at[2])}px) translateY(-50%)`;
      }
    } else if (!this.tag.hidden) this.tag.hidden = true;
    // the view from above: a pin on the visitor's own spot
    if (this.live && S.above.k > 0.5) {
      tr.ground(S.at, g);
      if (E.project(g, c)) { this.you.hidden = false; this.you.style.transform = `translate(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px)`; }
      else this.you.hidden = true;
    } else if (!this.you.hidden) this.you.hidden = true;
  }
  /** The ring + tooltip on the point of the camera's path under a mouse. */
  showPick(x, y, text) {
    const p = this.pick;
    p.hidden = false;
    p.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    const s = p.lastChild;
    if (s.textContent !== text) s.textContent = text;
  }
  hidePick() { if (!this.pick.hidden) this.pick.hidden = true; }
  destroy() { for (const s of this.slots) s.b.remove(); this.tag.remove(); this.pick.remove(); this.you.remove(); }
}
