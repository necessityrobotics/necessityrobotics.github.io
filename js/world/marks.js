// Ride marks (website_nr3/_build/FACTS_WORLD_PLAN.md 1 / 2.2): signposts stood in an island's map beside xclean's route,
// for HOME's facts in the world (chapter 2's facts beat). Generic: every [data-world="marks"] host whose island has
// atlas.json ride.marks gets them; the content (cards, dock, words) is HOME's markup, the engine only places it.
//   GL   per mark a ground ring (40 segments) and a post (one segment) on the route's ribbon program: a 2.2 px core
//        (premultiplied over) and a 9 px glow at 0.25 (additive); the keyframe dots on the grey points' program. No new
//        program. Planting animates the drawn range uB: the ring draws itself (aU 0 - 0.5), then the post grows (0.5 - 1).
//   DOM  the current mark's anchor (HOME's card hangs from it; on phones a node at a stub's head) and, on phones, a leader
//        down to the dock, through Anchors (labels.js): transforms only, snapped to device pixels; sizes from a
//        ResizeObserver; blocker boxes read in measure() only, never in a frame.
// Every position is computed once, in the island's map frame, from ride.marks / ride.ground and xclean's track, so a
// resize or a turn never moves a post: only what the layout shows switches (the next post, a stub or a full post, the
// card or the dock). The host's state is HOME's (js/home/signposts.js): data-layout (cards | slim | dock | dock-slim),
// data-avoid (the boxes the marks keep clear of), data-dock (the dock's selector, for the leader).

import { setHook } from './debug.js';

const SEG = 40;
// card: a card's way out (0.18 s) and a frame; rel / keep: how far ahead a new / kept place keeps clear of its ring's
// motion against it (cardAt); move: a shown card's move to a new place (offset)
const T = { plant: 0.6, gone: 0.3, block: 0.15, out: 0.4, quick: 0.15, dots: 0.5, hi: 0.4, card: 0.22, rel: 0.45, keep: 0.3, move: 0.18 };
const PAD = 16, HYST = 24;                       // blocker clearance, and the clearance to come back after a fade
const MINPOST = 24;                              // px of post that must stay drawn to hang a card from (or stand)
const TIE = { y: 16, ly: 22, min: 14, max: 120 };  // the side-hung card's tie: >= y px from the card's ends, at ly below its top, 14-120 px long
const REDUCED = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

export class Marks {
  /** tracks(id): xclean's Track of an island once it has arrived; onLive(on): HOME's #world[data-marks]. */
  constructor({ THREE, scene, stage, atlas, root, Anchors, tracks, onLive }) {
    this.THREE = THREE; this.scene = scene; this.stage = stage; this.tracks = tracks; this.onLive = onLive; this.Anchors = Anchors;
    this.stageEl = root.querySelector('.stage');
    this.v = new THREE.Vector3();
    this.dead = false;
    this.sets = [...root.querySelectorAll('[data-world="marks"]')].map(host => {
      const id = host.dataset.island, r = atlas.islands[id]?.ride;
      return r?.marks && r.ground ? { host, id, mk: r.marks, gr: r.ground, built: false, active: false, cur: -1, nxt: -1, avoid: null, mN: 0, actN: 0 } : null;
    }).filter(Boolean);
    // a size change: the boxes are stale until the first measure after it (the next task, after the frame that drew the
    // new size, so the read costs no forced layout); until then nothing is faded or hidden for a stale box
    this._resize = () => {
      this.stale = true;
      clearTimeout(this.rT0); clearTimeout(this.rT); clearTimeout(this.rT2);
      this.rT0 = setTimeout(() => { this.stale = false; this.unlock(); this.measureAll(); }, 0);
      this.rT = setTimeout(() => this.measureAll(), 150);
      this.rT2 = setTimeout(() => this.measureAll(), 520);            // again once HOME's panels have settled
    };
    addEventListener('resize', this._resize, { passive: true });
    setHook('marks', () => this.info());
  }

  /** The marks of one host, once its island and track exist (map frame, metres). */
  build(s) {
    const tr = this.tracks(s.id), isl = this.scene.islands.get(s.id);
    if (!tr || !isl) return false;
    const THREE = this.THREE, mk = s.mk, gr = s.gr;
    const up = norm([...isl.desc.points.up]);
    const pos = d => tr.pos(tr.timeAt(d), [0, 0, 0]);
    const g = d => { const x = (d - gr.d0) / gr.step, i = Math.max(0, Math.min(gr.below.length - 2, Math.floor(x))), a = Math.max(0, Math.min(1, x - i)); return gr.below[i] + (gr.below[i + 1] - gr.below[i]) * a; };
    const frame = this.scene.mapFrame(s.id);
    s.frame = frame; s.up = up; s.scale = isl.desc.scale;
    s.marks = mk.at.map((a, k) => {
      const c = pos(a.d), h = sub(pos(a.d + 0.7), pos(a.d - 0.7));
      const hz = norm(sub(h, mul(up, dot(h, up)))), right = norm(cross(hz, up));
      const foot = sub(add(c, mul(right, a.side * a.off)), mul(up, g(a.d)));
      const head = add(foot, mul(up, mk.post_m)), stub = add(foot, mul(up, mk.stub_m));
      // the ring (aU 0 - 0.5) starts on the side facing back along the path, then the post (aU 0.5 - 1)
      const n = SEG + 1, A = new Float32Array(n * 3), B = new Float32Array(n * 3), U = new Float32Array(n * 2);
      const at = th => add(foot, add(mul(hz, -Math.cos(th) * mk.ring_m), mul(right, Math.sin(th) * mk.ring_m)));
      for (let i = 0; i < SEG; i++) {
        A.set(at(i / SEG * 2 * Math.PI), i * 3); B.set(at((i + 1) / SEG * 2 * Math.PI), i * 3);
        U[i * 2] = 0.5 * i / SEG; U[i * 2 + 1] = 0.5 * (i + 1) / SEG;
      }
      A.set(foot, SEG * 3); B.set(head, SEG * 3); U[SEG * 2] = 0.5; U[SEG * 2 + 1] = 1;
      const geo = new THREE.InstancedBufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -1, 0, 0, 1, 0, 1, -1, 0, 1, 1, 0]), 3));
      geo.setIndex([0, 2, 1, 2, 3, 1]);
      geo.setAttribute('aA', new THREE.InstancedBufferAttribute(A, 3));
      geo.setAttribute('aB', new THREE.InstancedBufferAttribute(B, 3));
      geo.setAttribute('aU', new THREE.InstancedBufferAttribute(U, 2));
      geo.instanceCount = n;
      const mesh = (blend, w, o) => {
        const m = new THREE.Mesh(geo, this.scene.lineMaterial({ blend }));
        m.frustumCulled = false; m.renderOrder = 3; m.visible = false; m.userData = { w, o };
        frame.add(m);
        return m;
      };
      const glow = mesh('add', 9, 0.25), core = mesh('over', 2.2, 1);
      const el = s.host.querySelector(`[data-mark="${k}"] .sp-at`);
      return { k, foot, head, stub, geo, core, glow, stubB: 0.5 + 0.5 * mk.stub_m / mk.post_m, o: 0, b: 0, ra: 0, block: false,
        ringHit: false, ringV: [0, 0, 0, 0], ringP: null, ringRel: null, ringSoon: null, hdV: [0, 0], hdP: null, fade: 0, aOff: null,
        aDock: false, side: null, off: null, offFace: '', mv: null, out: false, front: false, ring: null, px: null, el,
        card: el?.querySelector('.sp-card') || null, tie: el?.querySelector('.sp-tie') || null,
        face: el?.dataset.face || 'l', hang: el?.dataset.hang || 'down', at: null };
    });
    // the keyframe dots: every keyframe in the stretch, at its own horizontal place, on the ground under it
    const idx = [];
    for (let i = 0; i < tr.n; i++) if (tr.cum[i] >= mk.dots.d[0] && tr.cum[i] <= mk.dots.d[1]) idx.push(i);
    const P = new Float32Array(idx.length * 3);
    idx.forEach((i, j) => { const p = [tr.p[i * 3], tr.p[i * 3 + 1], tr.p[i * 3 + 2]]; P.set(sub(p, mul(up, g(tr.cum[i]))), j * 3); });
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(P, 3));
    dg.setAttribute('aGrey', new THREE.BufferAttribute(new Uint8Array(idx.length).fill(255), 1, true));
    const dm = this.scene.dotMaterial({ size: 0.07 * s.scale, minPx: 2, maxPx: 4.5, near: 0.6 * s.scale });
    const dots = new THREE.Points(dg, dm);
    dots.frustumCulled = false; dots.renderOrder = 3; dots.visible = false;
    frame.add(dots);
    s.dots = { pts: dots, n: idx.length, o: 0, hi: 0 };
    // HOME's anchored elements
    s.anchors = new this.Anchors(s.host, this.stageEl, { onSize: () => this.stage.invalidate() });
    for (const m of s.marks) m.h = m.el ? s.anchors.add(m.el, m.el.querySelector('.sp-card')) : null;
    const lead = s.host.querySelector('.sp-lead');
    s.lead = lead ? s.anchors.add(lead, null) : null;
    s.built = true;
    this.measure(s);
    this.onLive?.(true);
    return true;
  }

  measure(s) {
    if (this.dead || !s.built) return;
    s.avoid = s.host.dataset.avoid || '';
    s.dockSel = s.host.dataset.dock || '';
    s.anchors.measure(s.avoid, s.dockSel);
    s.mN++;
    this.stage.invalidate();
  }
  measureAll() { for (const s of this.sets) this.measure(s); }
  /** A new size: a card may take the other side at its next change of place (its own side is kept while it fits). */
  unlock() { for (const s of this.sets) for (const m of s.marks || []) m.side = null; }
  /** A measure ms from now, per reason (one timer each, so a later reason never cancels an earlier one). */
  measureSoon(s, ms, why) { s.mT = s.mT || {}; clearTimeout(s.mT[why]); s.mT[why] = setTimeout(() => this.measure(s), ms); }

  /** One drawn frame (world.js frame3D, after the camera is set). true while something still moves. */
  frame(S, now, dt, w, h, dir) {
    if (this.dead) return false;
    let more = false;
    for (const s of this.sets) if ((s.built || this.build(s)) && this.step(s, S, now, dt, w, h, dir)) more = true;
    return more;
  }

  step(s, S, now, dt, w, h, dir) {
    const P = s.mk.p, active = S.kind === 'ride' && S.island === s.id;
    // the current fact: HOME's (data-cur on the layer: js/home/signposts.js holds each fact a while, so it may lag the
    // scroll), else the scroll's window; while HOME's lags, frames keep coming for its hand-over
    let thr = -1;
    if (active) for (let k = 0; k < s.marks.length; k++) if (S.p >= P[k]) thr = k;
    const hc = s.host.getAttribute('data-cur'), hn = hc === null ? NaN : Number(hc);
    const cur = !active ? -1 : Number.isInteger(hn) ? Math.max(-1, Math.min(s.marks.length - 1, hn)) : thr;
    const back = s.host.dataset.enter === 'back' || (Number.isNaN(hn) && dir < 0);   // the way in: planted at once
    const on = cur >= 0;
    if (on !== s.on) { s.on = on; if (on) this.measureSoon(s, 450, 'beat'); }   // the beat's panels have settled by then
    const av = s.host.dataset.avoid || '';
    if (av !== s.avoid && av !== s.avoidSeen) { s.avoidSeen = av; this.measureSoon(s, 60, 'avoid'); }
    const lay = s.host.dataset.layout || 'cards', dock = lay.startsWith('dock');
    if (lay !== s.layout) for (const m of s.marks) { m.pick = true; m.side = null; }   // a new layout: each card picks its place afresh
    const nxt = on && !dock && cur + 1 < s.marks.length ? cur + 1 : -1;
    // the phones' leader is one element: at a hand-over it waits for the new fact (the old one is gone by 0.3 s)
    if (cur !== s.cur) s.leadAt = now + (back ? 180 : 300);
    // review A: the layer's offset to the stage (Anchors.off) is read in measure(), and the last read may come from
    // wherever the reader was then (at build: thousands of px above this chapter's pin, so the first card hung off screen
    // until the beat's 450 ms measure and popped in, and the phones' leader ran from above the screen to the dock). Read
    // it again as the ride begins (its pin has stuck by then) and hang nothing from the old one meanwhile
    if (active && !s.active) { s.actN = s.mN; this.measureSoon(s, 60, 'ride'); }
    const fresh = s.mN > s.actN;
    s.cur = cur; s.nxt = nxt; s.layout = lay; s.active = active;
    const cam = this.stage.camera, an = s.anchors;
    cam.updateMatrixWorld();
    const MW = s.frame.matrixWorld, near = cam.near, sx = cam.projectionMatrix.elements[0] * w / 2, ds = this.stage.drawScale;
    const camPos = cam.position, upW = this.v.set(s.up[0], s.up[1], s.up[2]).transformDirection(MW).toArray();
    const R = s.mk.ring_m * s.scale, head = an.box('.head'), hb = (head?.[3] ?? 0) + 12;     // hb: the header's line
    const proj = p => {
      const v = this.v.set(p[0], p[1], p[2]).applyMatrix4(MW);
      const hc = (camPos.x - v.x) * upW[0] + (camPos.y - v.y) * upW[1] + (camPos.z - v.z) * upW[2];
      v.applyMatrix4(cam.matrixWorldInverse);
      const z = -v.z;
      v.applyMatrix4(cam.projectionMatrix);
      return { x: (v.x + 1) / 2 * w, y: (1 - v.y) / 2 * h, z, hc };
    };
    let more = active && cur !== thr, leadOn = false;
    for (const m of s.marks) {
      const isCur = m.k === cur, isNext = m.k === nxt;
      const bMax = isCur && dock ? m.stubB : 1;
      let want = isCur ? 1 : isNext ? 0.6 : 0, anchorOn = false, out = false, clip = 0;
      m.px = null; m.cap = 1;
      if (isCur || isNext) {
        const f = proj(m.foot), hd = proj(isCur && dock ? m.stub : m.head);
        m.front = f.z > 2 * near && hd.z > 2 * near && hd.x > -0.5 * w && hd.x < 1.5 * w;
        if (m.front) {
          const rx = R * sx / f.z, ry = rx * Math.min(1, Math.max(0.05, f.hc / f.z));
          m.ring = [f.x - rx - 5, f.y - ry - 5, f.x + rx + 5, f.y + ry + 5];
          // where the ring is heading (its box's px/s, eased): panels and the card keep clear of the box it sweeps over the
          // next fade, so near a panel it has undrawn, and a card has moved or gone, before they meet, however fast the
          // camera closes in on its post (a fact held at 1000 px/s: about 6 px a frame)
          if (m.ringP && dt > 0 && !this.stale) for (let i = 0; i < 4; i++) m.ringV[i] = 0.5 * m.ringV[i] + 0.5 * (m.ring[i] - m.ringP[i]) / dt;
          else m.ringV = [0, 0, 0, 0];
          m.ringP = m.ring.slice();
          // verifier (11-01): a card keeps clear of where its ring is heading against the card itself, which moves with the
          // head (the ring's growth as the camera closes in), not of the ring's sweep across the screen: tested against
          // the card's place on screen now, that sweep made a card shown at speed jump from place to place (50-470 px, up
          // to 8 times in 0.4 s), and on a mouse wheel at a notch. A card on its way out keeps to its post (below)
          if (m.hdP && dt > 0 && !this.stale) for (let i = 0; i < 2; i++) m.hdV[i] = 0.5 * m.hdV[i] + 0.5 * ((i ? hd.y : hd.x) - m.hdP[i]) / dt;
          else m.hdV = [0, 0];
          m.hdP = [hd.x, hd.y];
          const hv = m.hdV;
          const rv = [m.ringV[0] - hv[0], m.ringV[1] - hv[1], m.ringV[2] - hv[0], m.ringV[3] - hv[1]];
          m.ringRel = sweep(m.ring, rv, T.rel); m.ringSoon = sweep(m.ring, rv, T.keep);
          const x0 = Math.min(f.x, hd.x) - 4, x1 = Math.max(f.x, hd.x) + 4;
          // the ring keeps clear of every panel (16 px; 24 to come back). Near one, on the cards' layouts, the ring goes
          // (it undraws itself) and the post is drawn down to that panel's line: a post may go down behind a panel, as it
          // may rise behind the header, a ring may not (lead, 11-01: a fact held for its read stays on its post while the
          // camera closes in on it). The post itself keeps clear of every panel but the one it goes behind and the header;
          // with less than MINPOST of it left above that panel, nothing of it below the header (a far post, the camera
          // looking down), or on the phones' dock, the whole signpost goes
          if (!this.stale) m.ringHit = an.hits(sweep(m.ring, m.ringV, T.block), m.ringHit ? HYST : PAD);
          let fl = f.y;
          const under = [];
          if (m.ringHit && !dock) for (const b of an.boxes) if (b !== head && b[0] - PAD < x1 && b[2] + PAD > x0 && b[1] - PAD > hd.y + 4 && b[1] - PAD < f.y + ry + 5) { fl = Math.min(fl, b[1] - PAD); under.push(b); }
          const top = !dock && hd.y < hb && f.y > hb ? hb : hd.y;
          const post = [x0, top - 4, x1, m.ringHit && !dock ? fl : m.ring[1]];
          if (!this.stale) {
            m.block = (m.ringHit && (dock || post[3] - top < (under.length ? MINPOST : 4)))
              || an.boxes.some(o => o !== head && !under.includes(o) && post[0] < o[2] + PAD && post[2] > o[0] - PAD && post[1] < o[3] + PAD && post[3] > o[1] - PAD);
          }
          if (m.ringHit && !dock && fl < f.y) clip = 0.5 + 0.5 * (f.y - fl) / Math.max(1, f.y - hd.y);
          m.px = { fx: f.x, fy: f.y, hx: hd.x, hy: hd.y };
          // review A: the post's drawn top stops at the header's line (the post's height is a display size). Risen behind
          // the header, it ran on through it (the header is translucent; up to 22 px on a phone on its side); now it ends
          // where the card's corner slides, the head node on its drawn top (cardAt may slide it a little further down)
          if (!dock && hd.y < hb && f.y > hb) m.cap = 0.5 + 0.5 * (f.y - hb) / (f.y - hd.y);
          if (m.block) want = 0;
          else if (isCur && m.h && fresh) {
            if (!m.open) { m.open = true; m.pick = true; m.side = null; }
            if (dock) {
              an.place(m.h, hd.x, hd.y);
              m.aOff = [0, 0]; m.aDock = true;
              anchorOn = true;
              const cap = s.dockSel && an.box(s.dockSel);
              if (cap && s.lead && cap[1] > f.y + 2 && now >= s.leadAt) {
                an.place(s.lead, Math.max(cap[0] + 14, Math.min(cap[2] - 14, f.x)), f.y, (cap[1] - f.y) / 100);
                leadOn = true;
              }
            } else {
              anchorOn = this.cardAt(s, m, hd, f, w, h, hb, clip ? fl : f.y, now);
              if (m.mv) more = true;                                      // the card is moving to a new place
            }
          }
          // HOME's queue hands a held fact over at once when its signpost has left the screen, or its card has no place
          // (cards only: on phones the fact waits in the dock)
          if (isCur && fresh && !dock) out = m.block || !anchorOn || hd.x < 0 || hd.x > w || hd.y > h;
        } else { m.block = false; m.ringHit = false; m.ring = m.ringP = m.hdP = null; want = 0; out = isCur && fresh && !dock; }
      } else { m.block = false; m.ringHit = false; m.ringP = m.hdP = null; }
      if (!isCur) m.open = false;
      if (m.h) {
        if (m.h.vis && !anchorOn) m.fade = now + T.card * 1000;
        an.show(m.h, anchorOn);
        // verifier (11-01): a card on its way out (0.18 s) moves on with its post, at its place's offset from the head: it
        // stayed where its anchor last stood, so a fast camera could carry the ring under it
        if (!anchorOn && m.fade > now && m.aOff) {
          const q = proj(m.aDock ? m.stub : m.head);
          if (q.z > 2 * near) { an.place(m.h, q.x + m.aOff[0], q.y + m.aOff[1]); more = true; }
        }
      }
      if (out !== !!m.out) { m.out = out; m.el?.toggleAttribute('data-out', out); }
      // GL: plant (the drawn range) on the way in, instantly on the way back; fade by why it goes
      if (want > 0) {
        if (m.b > bMax || back) m.b = bMax;
        else if (m.b < bMax) { m.b = Math.min(bMax, m.b + dt / T.plant); more = true; }
        if (m.o < want) { m.o = Math.min(want, m.o + dt / T.quick); more = true; } else if (m.o > want) { m.o = Math.max(want, m.o - dt / T.gone); more = true; }
      } else if (m.o > 0) {
        m.o = Math.max(0, m.o - dt / (m.block ? T.block : active ? T.gone : T.out));
        more = true;
      }
      if (!(want > 0) && m.o === 0 && !m.block) m.b = 0;              // gone: it plants again when it comes back
      // the ring's drawn start: it undraws itself near a panel (0 -> 0.5 of the range, T.block) and draws back after
      const ra = m.ringHit && !dock && want > 0 ? 0.5 : 0;
      if (m.ra !== ra) { m.ra = ra > m.ra ? Math.min(ra, m.ra + 0.5 * dt / T.block) : Math.max(ra, m.ra - 0.5 * dt / T.block); if (m.o > 0) more = true; }
      const vis = m.o > 0.003 && m.b > 0.001;
      for (const mesh of [m.core, m.glow]) {
        const u = mesh.material.uniforms;
        u.uOpacity.value = m.o * mesh.userData.o; u.uB.value = Math.min(m.b, m.cap); u.uA.value = m.ra < 0.5 ? m.ra : Math.max(0.5, clip);
        u.uNear.value = near; u.uWidth.value = mesh.userData.w * ds;
        mesh.visible = vis;
      }
    }
    if (s.lead) an.show(s.lead, leadOn);
    if (dock && on && now < s.leadAt) more = true;
    // the dots: on through the beat (0.5), brighter while their fact (Keyframes) is current
    const D = s.dots, dT = on ? 0.5 : 0, hT = on && cur === s.mk.dots.hi ? 1 : 0;
    if (D.o !== dT) { D.o = dT > D.o ? Math.min(dT, D.o + dt * 0.5 / T.dots) : Math.max(dT, D.o - dt * 0.5 / (active ? T.gone : T.out)); more = true; }
    if (D.hi !== hT) { D.hi = hT > D.hi ? Math.min(1, D.hi + dt / T.hi) : Math.max(0, D.hi - dt / T.hi); more = true; }
    D.pts.material.uniforms.uOpacity.value = D.o;
    D.pts.material.uniforms.uHi.value = D.hi;
    D.pts.visible = D.o > 0.003;
    return more;
  }

  /**
   * Where the card hangs from its signpost (lead, 11-01: hanging down from the head, a card covered 39-48 % of its own
   * ring). Above the head, its bottom corner on it ('up'), wherever that fits under the header. Else beside the post
   * ('side'), on the side away from the path's middle (left for these left-hand posts; right only where the left does not
   * fit), joined to the head by a short level tie (.sp-tie): raised clear of the ring where it can be, held off to the
   * side of the ring where it cannot, so the ring and the post stay in view. Where neither fits, as a last resort, it
   * hangs down from the head's height ('down'), still beside the post and clear of the ring. Where the head is under the
   * header (the camera looking down) the node slides down the post below the header's line, and the post is drawn up to
   * the node. A card picks its place as it opens and keeps it, moving rigidly with its head, while that place still fits
   * (the screen, the panels, the header, its ring and post); then it picks again, its own kind of place first. Pure
   * arithmetic on cached sizes; data-face / data-hang, the card's offset and the tie's length are written on a change.
   * A card that is shown moves to its new place (offset()), never jumps.
   * fy: the lowest point of the post drawn (its foot, or the line of the panel it goes behind). false: no place, or no size.
   */
  cardAt(s, m, hd, f, w, h, hb, fy, now) {
    const an = s.anchors, cw = m.h.w, ch = m.h.h;
    if (!cw || !ch) return false;
    // the anchor: the head, or the post's point TIE.y below the header's line (a side tie needs that much card above it),
    // or on the line itself where the post is too short for that (the first fact on a phone on its side: the head under
    // the header, 30-40 px of post below it); the node stays above its ring
    const rg = m.ring, ra = m.ringRel || rg, gap = 6;         // ra: the ring now and where it is heading against the card
    let ax = hd.x, ay = hd.y;
    const yMin = hb + TIE.y <= Math.min(fy, rg[1]) - 6 ? hb + TIE.y : hb;
    if (ay < yMin) {
      if (yMin > Math.min(fy, rg[1]) - 2) return false;
      const t = (yMin - hd.y) / Math.max(1, f.y - hd.y);
      ax = hd.x + (f.x - hd.x) * t; ay = yMin;
      m.cap = Math.min(m.cap, 0.5 + 0.5 * (f.y - ay) / Math.max(1, f.y - hd.y));
    }
    // the post's x over a span of heights (it leans with the camera's roll): [min, max]
    const postX = (y0, y1) => {
      const at = y => hd.x + (f.x - hd.x) * Math.min(1, Math.max(0, (y - hd.y) / Math.max(1, f.y - hd.y)));
      const a = at(Math.max(y0, ay)), b = at(Math.min(Math.max(y1, ay), fy));
      return [Math.min(a, b), Math.max(a, b)];
    };
    const clear = b => b[0] >= 8 && b[2] <= w - 8 && b[1] >= hb && b[3] <= h - 8 && !an.hits(b, 8);
    // how much of a ring a box hides (the share of its outline, by angle): this ring, where it is heading against the
    // card (a new place: over the next T.rel s, so it is not left at once; a kept one: over the next T.keep s, so the
    // card has glided clear (.16 s) before they meet: none of this ring), and the next signpost's (desktop, tablet,
    // landscape: it stands without a card; a kept place may graze it, 5 %)
    const nx = s.marks[m.k + 1], nr = s.nxt === m.k + 1 && nx && nx.o > 0.05 ? nx.ring : null;
    const hides = (b, R) => Math.max(ringIn(b, rg), ringIn(b, R));
    // a place: hang ('up' | 'side' | 'down'), face ('l' | 'r'), ly (the tie's height below the card's top), L (the tie);
    // its offset from the anchor (the card's inner top corner: right on face l, left on r) and its box
    const offOf = c => c.hang === 'up' ? [0, -ch] : [c.face === 'l' ? -c.L : c.L, -c.ly];
    const boxAt = (face, o) => face === 'l' ? [ax + o[0] - cw, ay + o[1], ax + o[0], ay + o[1] + ch] : [ax + o[0], ay + o[1], ax + o[0] + cw, ay + o[1] + ch];
    const box = c => boxAt(c.face, offOf(c));
    const ok = (c, slack) => {
      const b = box(c);
      if (!clear(slack ? [b[0] + 4, b[1] + 4, b[2] - 4, b[3] - 4] : b) || hides(b, slack ? m.ringSoon || rg : ra) > 0
        || ringIn(b, nr) > (slack ? 0.05 : 0)) return false;
      if (c.hang === 'up') return true;
      const [p0, p1] = postX(b[1], b[3]);
      return c.face === 'l' ? b[2] <= p0 - (slack ? 0 : 2) : b[0] >= p1 + (slack ? 0 : 2);
    };
    // a place beside the post, on one face: the tie's height and length that keep the ring and the post in view
    const beside = (face, hang) => {
      let ly = hang === 'down' ? 0 : TIE.ly;
      if (hang === 'side') {
        const lo = Math.max(TIE.y, ay + ch + gap - ra[1]), hi = Math.min(ch - TIE.y, ay - hb);
        ly = lo <= hi ? Math.min(hi, Math.max(lo, TIE.ly)) : Math.max(TIE.y, Math.min(hi, TIE.ly));
      }
      const y0 = ay - ly, y1 = y0 + ch, [p0, p1] = postX(y0, y1);
      const meets = y1 > ra[1] && y0 < ra[3];                    // the card's height meets the ring's: keep to its side
      const L = Math.round(face === 'l' ? Math.max(TIE.min, ax - (meets ? Math.min(p0, ra[0]) : p0) + gap)
        : Math.max(TIE.min, (meets ? Math.max(p1, ra[2]) : p1) + gap - ax));
      return L > (hang === 'down' ? 2 * TIE.max : TIE.max) ? null : { hang, face, ly: Math.round(ly), L };
    };
    let c = m.at && m.at.hang === m.hang && m.at.face === m.face ? m.at : null;
    if (m.pick || !c || !ok(c, true)) {
      // its own kind of place first, then above, beside, below: opening, each on the side away from the path's middle (the
      // post's side of the path), then the other; while it shows, on its own side only (lead, 11-01: a card keeps its side
      // while read; it crossed its post, 274-472 px, as a place stopped fitting). With no place left on its side it hides
      // and its fact hands over, as when its post leaves the screen; once it has faded out it may open on either side
      const o = (s.mk.at[m.k]?.side ?? -1) < 0 ? 'l' : 'r', i = o === 'l' ? 'r' : 'l';
      const sides = m.side && (m.h.vis || now < m.fade) ? [m.side] : [o, i];
      const order = !m.pick && c ? [c.hang === 'up' ? { hang: 'up', face: c.face } : beside(c.face, c.hang)] : [];
      for (const f of sides) order.push({ hang: 'up', face: f });
      for (const hang of ['side', 'down']) for (const f of sides) order.push(beside(f, hang));
      c = order.find(x => x && ok(x, false)) || null;
      if (!c && this.stale && m.at) c = m.at;                    // boxes stale (a resize): keep the place a frame or two
      m.pick = false;
      if (!c) return false;
    }
    m.at = c; m.side = c.face;
    an.place(m.h, ax, ay);
    m.aOff = [ax - hd.x, ay - hd.y]; m.aDock = false;
    if (c.face !== m.face) { m.face = c.face; m.el.dataset.face = c.face; }
    if (c.hang !== m.hang) { m.hang = c.hang; m.el.dataset.hang = c.hang; }
    this.offset(m, c, offOf(c), o => boxAt(c.face, o), now);
    return true;
  }

  /**
   * The card's offset from its anchor, and its tie's length (the offset's x): a card that is shown moves to a new place
   * over T.move s, straight there, or round the ring's corner where the straight way crosses its ring (across, then up
   * or down; or up or down, then across); at once where neither way is clear of it, where the card is not shown yet, or
   * under reduced motion (verifier, 11-01: a card shown jumped 50-470 px, several times a second at speed). Writes the
   * transforms on a change only, in whole device px (sharp text); m.mv is set while it moves (frames keep coming).
   */
  offset(m, c, to, boxAt, now) {
    const rg = m.ring, hit = b => ringIn(b, rg) > 0;
    const crosses = (a, b) => [0.25, 0.5, 0.75].some(t => hit(boxAt([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])));
    const aim = m.mv ? m.mv.to : m.off;
    if (!m.off || !m.h.vis || REDUCED?.matches || c.face !== m.offFace) { m.mv = null; m.off = to; }
    else if (aim[0] !== to[0] || aim[1] !== to[1]) {
      const a = m.off, kx = [to[0], a[1]], ky = [a[0], to[1]];
      const way = !crosses(a, to) ? 's' : !hit(boxAt(kx)) && !crosses(a, kx) && !crosses(kx, to) ? 'x'
        : !hit(boxAt(ky)) && !crosses(a, ky) && !crosses(ky, to) ? 'y' : '';
      m.mv = way ? { a: a.slice(), to, t0: now, way } : null;
      if (!way) m.off = to;
    }
    m.offFace = c.face;
    if (m.mv) {
      const { a, to: b, t0, way } = m.mv, u = Math.min(1, (now - t0) / (T.move * 1000));
      const e = x => x * x * (3 - 2 * x), lerp = (i, k) => a[i] + (b[i] - a[i]) * k;
      if (way === 's') m.off = [lerp(0, e(u)), lerp(1, e(u))];
      else {                                                     // two legs: the first axis, then the other
        const k1 = e(Math.min(1, 2 * u)), k2 = e(Math.max(0, 2 * u - 1));
        m.off = way === 'x' ? [lerp(0, k1), lerp(1, k2)] : [lerp(0, k2), lerp(1, k1)];
      }
      if (u >= 1) { m.mv = null; m.off = b; }
    }
    const dpr = window.devicePixelRatio || 1, px = v => Math.round(v * dpr) / dpr;
    const off = `translate(${px(m.off[0])}px, ${px(m.off[1])}px)`;
    const tie = c.hang === 'up' ? '' : `scaleX(${(Math.abs(m.off[0]) / 100).toFixed(3)})`;
    if (m.offW !== off) { m.offW = off; if (m.card) m.card.style.transform = off; }
    if (m.tieW !== tie) { m.tieW = tie; if (m.tie) m.tie.style.transform = tie; }
  }

  /** For the QA tools (window.__world.marks()): the state of every host, in stage pixels and world units. */
  info() {
    return this.sets.map(s => {
      if (!s.built) return { id: s.id, built: false };
      const MW = s.frame.matrixWorld, wp = p => this.v.set(p[0], p[1], p[2]).applyMatrix4(MW).toArray().map(x => +x.toFixed(3));
      const r = a => a && a.map(x => Math.round(x));
      const an = s.anchors;
      return { id: s.id, built: true, active: s.active, cur: s.cur, next: s.nxt, layout: s.layout, avoid: s.avoid, off: r(an.off), blockers: an.boxes.map(r),
        marks: s.marks.map(m => ({ k: m.k, o: +m.o.toFixed(3), b: +m.b.toFixed(3), cap: +(m.cap ?? 1).toFixed(3), block: m.block, front: m.front, vis: !!m.h?.vis,
          ring: m.px ? r(m.ring) : null, foot: m.px && [+m.px.fx.toFixed(1), +m.px.fy.toFixed(1)], top: m.px && [+m.px.hx.toFixed(1), +m.px.hy.toFixed(1)],
          anchor: m.h && Number.isFinite(m.h.x) ? [+(m.h.x + an.off[0]).toFixed(2), +(m.h.y + an.off[1]).toFixed(2)] : null, card: m.h ? [Math.round(m.h.w), Math.round(m.h.h)] : null,
          face: m.face, hang: m.hang, at: m.at, ringHit: !!m.ringHit, ra: +(m.ra || 0).toFixed(3), out: !!m.out, world: { foot: wp(m.foot), head: wp(m.head) } })),
        lead: s.lead ? { vis: s.lead.vis, x: s.lead.x, y: s.lead.y, s: +s.lead.s.toFixed(3) } : null,
        dots: { n: s.dots.n, o: +s.dots.o.toFixed(3), hi: +s.dots.hi.toFixed(3) },
        programs: this.stage.renderer.info.programs?.length ?? null };
    });
  }

  destroy() {
    this.dead = true;
    removeEventListener('resize', this._resize);
    clearTimeout(this.rT0); clearTimeout(this.rT); clearTimeout(this.rT2);
    for (const s of this.sets) {
      for (const t of Object.values(s.mT || {})) clearTimeout(t);
      if (!s.built) continue;
      for (const m of s.marks) {
        for (const mesh of [m.core, m.glow]) { mesh.removeFromParent(); this.scene.release(mesh.material); }
        m.geo.dispose();
        m.el?.removeAttribute('data-out');
      }
      s.dots.pts.removeFromParent(); s.dots.pts.geometry.dispose(); this.scene.release(s.dots.pts.material);
      s.anchors.destroy();
      s.built = false;
    }
    this.onLive?.(false);
  }
}

/** The share of ring r's outline (its box, less the 5 px glow; 32 points by angle) inside box b. */
function ringIn(b, r) {
  if (!r || b[0] > r[2] || b[2] < r[0] || b[1] > r[3] || b[3] < r[1]) return 0;
  const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2, rx = Math.max(1, (r[2] - r[0]) / 2 - 5), ry = Math.max(0.5, (r[3] - r[1]) / 2 - 5);
  let n = 0;
  for (let i = 0; i < 32; i++) {
    const x = cx + rx * Math.cos(i * Math.PI / 16), y = cy + ry * Math.sin(i * Math.PI / 16);
    if (x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]) n++;
  }
  return n / 32;
}
/** The box b covers now and over the next t s at velocity v (px/s per edge). */
const sweep = (b, v, t) => [Math.min(b[0], b[0] + v[0] * t), Math.min(b[1], b[1] + v[1] * t), Math.max(b[2], b[2] + v[2] * t), Math.max(b[3], b[3] + v[3] * t)];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
