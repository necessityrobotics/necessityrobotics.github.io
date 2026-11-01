// Beats -> camera (MASTER_PLAN.md 1.2 - 1.4). One continuous camera: every beat starts exactly where the previous one
// ends, so scrubbing in either direction is seamless. Scroll-scrubbed beats map progress p through their curve to a
// target pose (the world follows it with a critically damped spring); the explore dives are time-based.
//   hero      xclean's pose along the hero loop (autoplay, time-based, owned by world.js)
//   rise      LIFT + REVEAL: a cubic Bezier from the pose captured at the hand-off, up and back, to the island's pullback
//   atlas     LIFT-OFF to the overview, then a slow orbit (0 -> 8 deg)
//   glide     ARC (apex 0.22 x span) or LOW SWOOP (0.08), smootherstep with a 16 % dwell at each end
//   dive      DESCENT (near-vertical, smoothstep(smoothstep)), SWOOP-IN (Hermite, ending along the route's heading) or
//             DROP-IN (expo in, then out) into xclean's pose at the ride's start
//   ride      scroll = distance along the ride (the 'look' variant: the look beat, then the facts beat slower: rideU)
//   pullback  RISE & TURN (+30 deg), ORBIT-OUT (+90 deg) or SURFACE (straight up into the explore view)
//   explore   the explore view, orbiting 0 -> 40 deg with the scroll
import {
  ease, clamp01, ramp, lerp, lerp3, add, sub, scale, norm, dist, arc, orbit, bezier3, hermite, slerp, lookQuat, qrot,
} from './camera.js';

const UP = [0, 1, 0];
export const ATLAS_FOV = 46;
const DEG = Math.PI / 180;
const ss = ease.smootherstep;
const SWOOP_LIFT = 14;           // island metres (x scale): see approach()

// chapter 2's ride ('look'; css/home.css --b-r2: 187 lvh, phones 176): its first quarter is the way in and the look beat,
// at the scroll length they had in the 85 lvh ride (its p 0 - 0.55); the facts beat has the other three quarters, about a
// third of a screen per fact (lead, 11-01: at 86 px of scroll per fact a mouse wheel showed none of them). The camera's
// path is the same: the 85 lvh ride's map (40 % of the speed between its p 0.35 and 0.65), on its p stretched (q), so the
// facts beat covers the same metres of the route (d 108.49 -> 125.14), 3.0 x slower
export const LOOK = { end: 0.25, was: 0.55 };     // the facts beat starts at p `end` (p `was` of the 85 lvh ride)
/** The ride's scroll -> distance map (0..1 -> 0..1). 'look': above; other rides: p. */
export function rideU(variant, p) {
  if (variant !== 'look') return p;
  const q = p < LOOK.end ? p * LOOK.was / LOOK.end : LOOK.was + (p - LOOK.end) * (1 - LOOK.was) / (1 - LOOK.end);
  const m = 1 / (0.35 + 0.3 * 0.4 + 0.35);
  if (q < 0.35) return q * m;
  if (q < 0.65) return 0.35 * m + (q - 0.35) * 0.4 * m;
  return 0.35 * m + 0.12 * m + (q - 0.65) * m;
}

export class Director {
  constructor({ atlas, scene, timeline }) {
    this.A = atlas; this.scene = scene; this.tl = timeline;
    this.tracks = {};
    this.portrait = false;
    this.cap = null;             // {pos, quat, t}: the hero pose captured at the hand-off to the rise
    this._P = [0, 0, 0]; this._Q = [0, 0, 0, 1];
    this.dv = null;              // an explore dive {id, phase, k, t, from, mid, ...}
  }
  setAspect(asp) { this.portrait = asp < 1; }
  setTrack(id, track) { this.tracks[id] = track; }
  isl(id) { return this.A.islands[id]; }
  fovOf(id) { return this.isl(id)?.cam?.vfov_deg || ATLAS_FOV; }
  view(v) { return this.portrait && v.pos_p ? { pos: v.pos_p, target: v.target_p || v.target } : { pos: v.pos, target: v.target }; }
  look(v) { return { pos: v.pos, target: v.target, quat: lookQuat(v.pos, v.target) }; }
  rot(v, yaw, c = v.target) { return { pos: orbit(v.pos, c, yaw), target: orbit(v.target, c, yaw) }; }
  /** The island's middle (world): the pivot of the pullbacks' turns, so a view framed off-centre stays framed. */
  centre(id) { const i = this.isl(id); return [i.place.x, i.place.y + 0.15 * i.height * i.scale, i.place.z]; }
  /** xclean's camera at replay time t on island id, world frame; null without its track. */
  pov(id, t) {
    const tr = this.tracks[id];
    if (!tr) return null;
    tr.pos(t, this._P); tr.quat(t, this._Q);
    const pos = [0, 0, 0], quat = [0, 0, 0, 1];
    this.scene.poseWorld(id, this._P, this._Q, pos, quat);
    return { pos, quat };
  }
  /** The island-frame position of xclean's camera at t (for the route's draw range). */
  routeFracAt(id, t) {
    const tr = this.tracks[id], isl = this.isl(id);
    if (!tr || !isl) return 0;
    tr.pos(t, this._P);
    const L = isl.local, p = this._P;
    const v = [L[0] * p[0] + L[4] * p[1] + L[8] * p[2] + L[12], L[1] * p[0] + L[5] * p[1] + L[9] * p[2] + L[13], L[2] * p[0] + L[6] * p[1] + L[10] * p[2] + L[14]];
    return this.scene.routeFrac(id, v);
  }
  ride(id) { return this.isl(id)?.ride || this.isl(id)?.dive; }
  rideT(id, u) {
    const r = this.ride(id), tr = this.tracks[id];
    if (!r) return 0;
    if (!tr || r.d0 == null) return lerp(r.t0, r.t1, u);
    return tr.timeAt(r.d0 + clamp01(u) * (r.d1 - r.d0));
  }

  // ---------------------------------------------------------------- the beat anchors
  heroId() { return this.A.hero?.id; }
  riseEnd() { return this.view(this.isl(this.heroId()).views.pullback); }
  atlasEnd() { return this.rot(this.view(this.A.views.overview), 8 * DEG); }
  approach(ch) {
    const isl = this.isl(ch.island), dive = ch.beats.dive;
    // integrator (review DE, E-DE2): the swoop starts SWOOP_LIFT island metres above atlas.json's behind view, so it comes
    // in over the park's trees instead of through them (the glide before it ends here too, so the two stay continuous)
    if (dive?.variant === 'swoop' && isl.views.behind) {
      const b = isl.views.behind, up = SWOOP_LIFT * isl.scale;
      return { pos: [b.pos[0], b.pos[1] + up, b.pos[2]], target: [b.target[0], b.target[1] + 0.5 * up, b.target[2]] };
    }
    return this.view(isl.views.approach);
  }
  pullEnd(ch) {
    const v = ch.beats.pullback?.variant, isl = this.isl(ch.island);
    if (v === 'surface') return this.view(this.A.views.explore);
    return this.rot(this.view(isl.views.pullback), (v === 'orbit' ? 90 : 30) * DEG, this.centre(ch.island));
  }
  glideFrom(n) {
    const prev = this.tl.chapters.find(c => c.n === n - 1);
    return prev ? this.pullEnd(prev) : this.atlasEnd();
  }

  /**
   * The target camera for the story state S = {kind, p, chapter, island, heroT, variant}: {pos, quat, fov, look:
   * 'pov'|'orbit', centre (orbit look-around pivot), route: {id, a, b} | null}. Null when the pose needs a track that
   * has not arrived (the caller holds the camera).
   */
  target(S) {
    const hero = this.heroId(), p = S.p;
    switch (S.kind) {
      case 'hero': {
        const c = this.pov(hero, S.heroT);
        return c ? { ...c, fov: this.fovOf(hero), look: 'pov' } : { ...this.look(this.riseEnd()), fov: ATLAS_FOV, look: 'orbit' };
      }
      case 'rise': {
        const end = this.riseEnd();
        const c = this.cap || this.pov(hero, this.A.hero.t0 + 2);
        if (!c) return { ...this.look(end), fov: ATLAS_FOV, look: 'orbit' };
        const s = this.isl(hero).scale;
        const f = qrot(c.quat, [0, 0, -1]); f[1] = 0; norm(f, f);
        const P1 = add(add(c.pos, scale(UP, 25 * s)), scale(f, -40 * s));
        const P2 = lerp3(P1, end.pos, 0.5); P2[1] += 0.15 * dist(P1, end.pos);
        const e = ss(p);
        const pos = bezier3(c.pos, P1, P2, end.pos, e);
        // WIRE: the gaze tilts down onto the street ahead early in the lift (it reached the island only at p ~0.6
        // before, so scroll 0.45-0.85 was a black screen above the horizon), then pans to the overview's target.
        const ahead = add(c.pos, scale(f, 30 * s)); ahead[1] = this.isl(hero).place.y;
        const T = lerp3(ahead, end.target, ss(ramp(p, 0.1, 0.7)));
        const quat = slerp(c.quat, lookQuat(pos, T), ss(ramp(p, 0, 0.3)));
        const k = ease.easeOutCubic(ramp(p, 0.35, 0.85));
        const uc = this.routeFracAt(hero, c.t ?? this.A.hero.t0 + 2);
        return { pos, quat, fov: lerp(this.fovOf(hero), ATLAS_FOV, ss(p)), look: p < 0.5 ? 'pov' : 'orbit', centre: end.target,
          route: { id: hero, a: uc * (1 - k), b: uc + (1 - uc) * k } };
      }
      case 'atlas': {
        const a = this.riseEnd(), b = this.view(this.A.views.overview);
        const e = ease.easeInOutSine(ramp(p, 0, 0.55));
        const pos = arc(a.pos, b.pos, 0.12 * dist(a.pos, b.pos), e);
        const target = lerp3(a.target, b.target, e);
        const yaw = 8 * DEG * p;
        const P = orbit(pos, b.target, yaw), T = orbit(target, b.target, yaw);
        return { pos: P, quat: lookQuat(P, T), fov: ATLAS_FOV, look: 'orbit', centre: T };
      }
      case 'explore': {
        const v = this.rot(this.view(this.A.views.explore), 40 * DEG * p);
        return { ...this.look(v), fov: ATLAS_FOV, look: 'orbit', centre: v.target };
      }
      default: break;
    }
    const ch = this.tl.chapters.find(c => c.n === S.chapter);
    if (!ch) return null;
    const id = ch.island, isl = this.isl(id), r = this.ride(id), fovP = this.fovOf(id);
    if (S.kind === 'glide') {
      const from = this.glideFrom(ch.n), to = this.approach(ch);
      const e = ss(ramp(p, 0.16, 0.84));
      const span = Math.hypot(to.pos[0] - from.pos[0], to.pos[2] - from.pos[2]);
      const pos = arc(from.pos, to.pos, (S.variant === 'low' ? 0.08 : 0.22) * span, e);
      const target = lerp3(from.target, to.target, e);
      return { pos, quat: lookQuat(pos, target), fov: ATLAS_FOV, look: 'orbit', centre: target };
    }
    if (S.kind === 'dive') {
      const from = this.approach(ch), to = this.pov(id, r.t0);
      if (!to) return { ...this.look(from), fov: ATLAS_FOV, look: 'orbit', centre: from.target };
      const q0 = lookQuat(from.pos, from.target);
      if (S.variant === 'swoop') {
        const e = ease.easeInOutCubic(p), d = dist(from.pos, to.pos);
        const f = qrot(to.quat, [0, 0, -1]);
        // integrator (review DE, E-DE2): the landing tangent comes down from above along the route's heading (about 35 deg),
        // so the last fifth of the swoop stays above the path instead of skimming through the hedge beside it (scroll
        // 4.2-4.35 at 1440 was a noisy close-up of bushes for about 0.15 screens)
        f[1] = 0; norm(f, f); f[1] = -0.7;
        const pos = hermite(from.pos, scale(norm(sub(to.pos, from.pos)), d * 0.6), to.pos, scale(norm(f), d * 0.9), e);
        return { pos, quat: slerp(q0, to.quat, e), fov: lerp(ATLAS_FOV, fovP, e), look: 'pov' };
      }
      if (S.variant === 'drop') {
        const e = p < 0.6 ? 0.6 * ease.expoIn(p / 0.6) : 0.6 + 0.4 * ease.easeOutCubic((p - 0.6) / 0.4);
        const d = dist(from.pos, to.pos);
        const P1 = lerp3(from.pos, to.pos, 0.3); P1[1] += 0.1 * d;
        const P2 = add(to.pos, scale(UP, 0.3 * Math.max(0, from.pos[1] - to.pos[1])));
        const pos = bezier3(from.pos, P1, P2, to.pos, e);
        const q = slerp(lookQuat(pos, lerp3(from.target, to.pos, e)), to.quat, ease.smoothstep(ramp(e, 0.2, 1)));
        return { pos, quat: q, fov: lerp(ATLAS_FOV, fovP, ease.smoothstep(e)), look: 'pov' };
      }
      // descent: across to above the landing, then a near-vertical drop; the view turns to xclean's from p 0.15
      const e = ease.smoothstep(ease.smoothstep(p));
      const M = [to.pos[0], from.pos[1], to.pos[2]];
      const P1 = lerp3(from.pos, M, 0.75);
      const P2 = add(to.pos, scale(UP, 0.45 * Math.max(0, from.pos[1] - to.pos[1])));
      const pos = bezier3(from.pos, P1, P2, to.pos, e);
      const q = slerp(lookQuat(pos, lerp3(from.target, to.pos, Math.min(1, e * 1.4))), to.quat, ease.smoothstep(ramp(p, 0.15, 1)));
      return { pos, quat: q, fov: lerp(ATLAS_FOV, fovP, ease.smoothstep(ramp(p, 0.5, 1))), look: 'pov' };
    }
    if (S.kind === 'ride') {
      const c = this.pov(id, this.rideT(id, rideU(S.variant, p)));
      return c ? { ...c, fov: fovP, look: 'pov' } : null;
    }
    if (S.kind === 'pullback') {
      const from = this.pov(id, r.t1);
      const endV = S.variant === 'surface' ? this.view(this.A.views.explore) : this.view(isl.views.pullback);
      if (!from) return { ...this.look(this.pullEnd(ch)), fov: ATLAS_FOV, look: 'orbit' };
      const uc = this.routeFracAt(id, r.t1), k = ease.easeOutCubic(ramp(p, 0.15, 0.8));
      const route = { id, a: uc * (1 - k), b: uc + (1 - uc) * k };
      if (S.variant === 'surface') {
        const P1 = add(from.pos, scale(UP, 0.6 * Math.max(0, endV.pos[1] - from.pos[1])));
        const e = ease.easeInOutSine(p);
        const pos = bezier3(from.pos, P1, lerp3(P1, endV.pos, 0.6), endV.pos, e);
        const centre = isl.views.pullback.target;
        // integrator (review DE, E-DE1): the gaze drops onto the ground ahead early, as WIRE did for rise-turn / orbit-out;
        // it used to slerp to the far target over p 0-0.7 while the camera went straight up, and looked over the horizon
        // into black (scroll 6.88-7.0 at 1440 x 900 was a dead screen)
        const s = isl.scale;
        const fh = qrot(from.quat, [0, 0, -1]); fh[1] = 0; norm(fh, fh);
        const ahead = [from.pos[0] + fh[0] * 30 * s, isl.place.y, from.pos[2] + fh[2] * 30 * s];
        const q = slerp(from.quat, lookQuat(pos, lerp3(ahead, lerp3(centre, endV.target, e), ss(ramp(p, 0.2, 0.9)))), ss(ramp(p, 0, 0.3)));
        return { pos, quat: q, fov: lerp(fovP, ATLAS_FOV, ss(p)), look: p < 0.5 ? 'pov' : 'orbit', centre: endV.target, route };
      }
      const s = isl.scale, c = this.centre(id);
      let pos, yaw;
      if (S.variant === 'orbit') {
        const e = ease.easeInOutCubic(p);
        pos = lerp3(from.pos, endV.pos, e);
        pos[1] = lerp(from.pos[1], endV.pos[1], ease.easeOutCubic(p));
        yaw = 90 * DEG * e;
      } else {
        const f = qrot(from.quat, [0, 0, -1]); f[1] = 0; norm(f, f);
        const P1 = add(add(from.pos, scale(UP, 25 * s)), scale(f, -20 * s));
        const P2 = lerp3(endV.pos, P1, 0.3);
        pos = bezier3(from.pos, P1, P2, endV.pos, ss(p));
        yaw = 30 * DEG * ease.easeInOutCubic(p);
      }
      pos = orbit(pos, c, yaw);
      const target = orbit(endV.target, c, yaw);
      // WIRE: as in the rise, the gaze drops onto the ground ahead early (a phone saw black sky at p 0.3-0.6)
      const fh = qrot(from.quat, [0, 0, -1]); fh[1] = 0; norm(fh, fh);
      const ahead = orbit([from.pos[0] + fh[0] * 30 * s, isl.place.y, from.pos[2] + fh[2] * 30 * s], c, yaw);
      const q = slerp(from.quat, lookQuat(pos, lerp3(ahead, target, ss(ramp(p, 0.15, 0.9)))), ss(ramp(p, 0, 0.3)));
      return { pos, quat: q, fov: lerp(fovP, ATLAS_FOV, ss(p)), look: p < 0.5 ? 'pov' : 'orbit', centre: target, route };
    }
    return null;
  }

  // ---------------------------------------------------------------- explore dives (time-based)
  /** Start a dive from the current camera (needs the island's track). */
  startDive(id, from, phone) {
    const d = this.isl(id).dive;
    const to = this.pov(id, d.t0);
    if (!to) return false;
    const mid = lerp3(from.pos, to.pos, 0.5);
    mid[1] = Math.max(from.pos[1], to.pos[1]) + 0.12 * dist(from.pos, to.pos);
    this.dv = { id, phase: 'in', k: 0, t: d.t0, t0: d.t0, t1: d.t1, speed: this.isl(id).speed || 1, from: { ...from }, mid, dur: phone ? 1.4 : 2.0 };
    return true;
  }
  surface(from) {
    if (!this.dv || this.dv.phase === 'out') return false;
    this.dv.phase = 'out'; this.dv.k = 0; this.dv.from = { ...from };
    return true;
  }
  /**
   * One frame of the dive: {pose, phase, dip (0..1), done}. scrollPose: where the scroll camera is (the surface target).
   */
  diveFrame(dt, scrollPose) {
    const d = this.dv;
    if (!d) return null;
    const id = d.id, fovP = this.fovOf(id);
    if (d.phase === 'out') {
      d.k = Math.min(1, d.k + dt / 1.2);
      const e = ease.easeOutCubic(d.k);
      const pose = { pos: lerp3(d.from.pos, scrollPose.pos, e), quat: slerp(d.from.quat, scrollPose.quat, e), fov: lerp(d.from.fov, scrollPose.fov, e) };
      if (d.k >= 1) { this.dv = null; return { pose, phase: 'done', dip: 0, id }; }
      return { pose, phase: 'out', dip: 0, id };
    }
    let dip = 0;
    if (d.phase === 'ride') {
      d.t += dt * d.speed;
      if (d.t > d.t1) d.t = d.t0;
      const left = (d.t1 - d.t) / d.speed, back = (d.t - d.t0) / d.speed;
      dip = left < 0.6 ? 1 - left / 0.6 : back < 0.6 ? 1 - back / 0.6 : 0;
    }
    const to = this.pov(id, d.t);
    if (d.phase === 'in') {
      d.k = Math.min(1, d.k + dt / d.dur);
      const e = ease.easeInOutCubic(d.k), u = 1 - e;
      const pos = [0, 1, 2].map(j => u * u * d.from.pos[j] + 2 * u * e * d.mid[j] + e * e * to.pos[j]);
      const pose = { pos, quat: slerp(d.from.quat, to.quat, ease.smoothstep(ramp(d.k, 0.15, 1))), fov: lerp(d.from.fov, fovP, e) };
      if (d.k >= 1) d.phase = 'ride';
      return { pose, phase: d.k >= 1 ? 'ride' : 'in', dip: 0, id, t: d.t };
    }
    return { pose: { ...to, fov: fovP }, phase: 'ride', dip, id, t: d.t };
  }
}
