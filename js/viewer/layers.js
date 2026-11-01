// Necessity Robotics viewer (ported from the approved review viewer) — map layers: the point cloud (THREE.Points per streamed chunk, one custom shader), the splats (Spark
// SplatMesh in three quality tiers, cross-faded) and the metric ground grid. Points and splats live under the 'world'
// group (map frame); the grid is horizontal in world space.
import * as THREE from 'three';
import { SplatMesh } from '@sparkjsdev/spark';
import { hexToRgb01, token } from './util.js';

// ---------------------------------------------------------------- point cloud
// positions: uint16 xyz over the bbox as a NORMALISED attribute, de-quantised by the object transform
// (position = bbox_min, scale = extent), so the GPU stays in float32 and the CPU never touches a coordinate.
// colours: grey8 (one byte, expanded in the shader: a 1-component colour attribute renders red) or rgb8.
const POINT_VERT = /* glsl */`
  #if RGB
  attribute vec3 aRgb;
  #else
  attribute float aGrey;
  #endif
  uniform float uSize, uPR, uRef, uMinPx, uMaxPx, uFogNear, uFogFar, uGain, uTintMix;
  uniform vec3 uTint;
  varying vec3 vCol;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float d = max(-mv.z, 1e-3);
    gl_Position = projectionMatrix * mv;
    float px = uSize * clamp(uRef / d, 0.5, 3.2);
    gl_PointSize = clamp(px, uMinPx, uMaxPx) * uPR;
    #if RGB
    vec3 c = aRgb;
    #else
    vec3 c = vec3(aGrey);
    #endif
    c = min(vec3(1.0), c * uGain);
    float fog = 1.0 - 0.7 * smoothstep(uFogNear, uFogFar, d);
    vCol = mix(c, uTint, uTintMix) * fog;
  }`;
const POINT_FRAG = /* glsl */`
  uniform float uOpacity, uSoft;
  varying vec3 vCol;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float r2 = dot(p, p);
    if (r2 > 0.25) discard;
    float a = uOpacity * mix(1.0, 1.0 - smoothstep(0.06, 0.25, r2), uSoft);
    gl_FragColor = vec4(vCol, a);
  }`;

export class PointCloud {
  /** meta: points.json. Chunks are added with addChunk() as they stream in. */
  constructor(meta, { pr }) {
    this.meta = meta;
    this.n = 0;                      // points on screen so far
    this.total = meta.count;
    this.rgb = meta.colour === 'rgb8';
    this.material = new THREE.ShaderMaterial({
      defines: { RGB: this.rgb ? 1 : 0 },
      vertexShader: POINT_VERT,
      fragmentShader: POINT_FRAG,
      uniforms: {
        uSize: { value: 1.6 }, uPR: { value: pr }, uRef: { value: 10 }, uMinPx: { value: 1 }, uMaxPx: { value: 9 },
        uFogNear: { value: 10 }, uFogFar: { value: 100 }, uGain: { value: 1.15 }, uTintMix: { value: 0 },
        uTint: { value: new THREE.Vector3(...hexToRgb01(token('--ours') || '#4fd8ff')) },
        uOpacity: { value: 1 }, uSoft: { value: 0 },
      },
    });
    this.object = new THREE.Group();
    this.object.name = 'point cloud';
    this.object.position.fromArray(meta.bbox_min);
    this.object.scale.set(...meta.bbox_max.map((v, i) => Math.max(1e-6, v - meta.bbox_min[i])));
    this.chunks = [];
    this.size = 1.6;
    this.mode = 'points';
    // an empty Points with the real attribute layout, so the shader can be compiled (asynchronously, see main.js
    // warmShaders) before the first chunk is drawn; it draws nothing
    const g0 = new THREE.BufferGeometry();
    g0.setAttribute('position', new THREE.BufferAttribute(new Uint16Array(0), 3, true));
    g0.setAttribute(this.rgb ? 'aRgb' : 'aGrey', new THREE.BufferAttribute(new Uint8Array(0), this.rgb ? 3 : 1, true));
    this.warm = new THREE.Points(g0, this.material);
    this.warm.frustumCulled = false;
    this.object.add(this.warm);
    this.setMode('points');
  }

  addChunk({ count, pos, col }) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3, true));
    if (this.rgb) geo.setAttribute('aRgb', new THREE.BufferAttribute(col, 3, true));
    else geo.setAttribute('aGrey', new THREE.BufferAttribute(col, 1, true));
    // culling is off (the de-quantising scale is non-uniform); a bounding sphere keeps three's raycaster quiet
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0.5, 0.5, 0.5), 0.87);
    const pts = new THREE.Points(geo, this.material);
    pts.frustumCulled = false;
    pts.renderOrder = this.object.renderOrder;
    this.object.add(pts);
    this.chunks.push({ pos, count });
    this.n += count;
  }

  /** 'points' = opaque natural colours; 'both' = a lighter, smaller, translucent ion dust over the splats; 'off'. */
  setMode(mode) {
    this.mode = mode;
    const u = this.material.uniforms;
    this.object.visible = mode !== 'off';
    if (mode === 'both') {
      Object.assign(this.material, { transparent: true, depthWrite: false });
      u.uOpacity.value = 0.55; u.uSoft.value = 1; u.uTintMix.value = 0.6;
      this.setOrder(5); // after Spark (0): splats never write depth, so the dust sits on top
    } else {
      Object.assign(this.material, { transparent: false, depthWrite: true });
      u.uOpacity.value = 1; u.uSoft.value = 0; u.uTintMix.value = 0;
      this.setOrder(0);
    }
    this.material.needsUpdate = true;
    this.applySize();
  }
  setOrder(o) { this.object.renderOrder = o; this.object.children.forEach(c => { c.renderOrder = o; }); }
  setSize(px) { this.size = px; this.applySize(); }
  applySize() { this.material.uniforms.uSize.value = this.size * (this.mode === 'both' ? 0.75 : 1); }
  setPixelRatio(pr) { this.material.uniforms.uPR.value = pr; }
  /** Reference distance (the default orbit distance): the slider's size is in px at that distance. */
  setScale({ ref, fogNear, fogFar }) {
    const u = this.material.uniforms;
    u.uRef.value = ref; u.uFogNear.value = fogNear; u.uFogFar.value = fogFar;
  }

  /** k points from the first chunk (a uniform subsample, since the file is a random permutation), map frame. */
  sampleMap(k = 60000) {
    const c = this.chunks[0];
    if (!c) return new Float32Array(0);
    const n = Math.min(k, c.count);
    const q = c.pos;
    const lo = this.meta.bbox_min, hi = this.meta.bbox_max;
    const s = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i += 3) {
      out[i] = lo[0] + (q[i] / 65535) * s[0];
      out[i + 1] = lo[1] + (q[i + 1] / 65535) * s[1];
      out[i + 2] = lo[2] + (q[i + 2] / 65535) * s[2];
    }
    return out;
  }

  dispose() {
    this.object.removeFromParent();
    for (const c of this.object.children) c.geometry.dispose();
    this.object.clear();
    this.material.dispose();
    this.chunks.length = 0;
  }
}

// ---------------------------------------------------------------- splats: LITE -> STANDARD (-> FULL on request)
export const TIERS = ['lite', 'standard', 'full'];
const OUT_MS = 400;          // the tier being replaced fades out over this once the new one is fully in

export class SplatLayer {
  constructor(stage) {
    this.stage = stage;
    this.meshes = {};          // tier -> SplatMesh (initialised)
    this.loading = {};         // tier -> Promise<SplatMesh>
    this.active = null;        // tier on screen
    this.opacity = 1;          // user slider
    this.on = false;           // the layer mode wants splats
    this.fade = null;          // {mesh, from, t0, dur, out: [meshes leaving]}
    this.disposed = false;
    this._hook = (dt, now) => this._step(now);
  }
  get mesh() { return this.active ? this.meshes[this.active] : null; }
  get numSplats() { return this.mesh?.numSplats ?? 0; }
  has(tier) { return !!this.meshes[tier]; }

  /**
   * Load a tier from an absolute URL (Spark ignores <base>) or from bytes already in hand ({bytes, fileName}).
   * Resolves with the initialised mesh, kept hidden.
   */
  load(tier, src, { onProgress } = {}) {
    if (this.meshes[tier]) return Promise.resolve(this.meshes[tier]);
    if (this.loading[tier]) return this.loading[tier];
    if (!this.stage.spark) return Promise.reject(this.stage.sparkError || new Error('Spark unavailable'));
    const mesh = new SplatMesh({
      ...(typeof src === 'string' ? { url: src, onProgress: e => onProgress?.(e.loaded, e.lengthComputable ? e.total : 0) }
        : { fileBytes: src.bytes, fileName: src.fileName }),
      extSplats: true, // float32 centres: the float16 default moves KITTI / 4Seasons splats by 0.25-1.1 m (SPARK_NOTES §6)
    });
    mesh.name = `splats (${tier})`;
    mesh.maxSh = 1;            // the v3 maps carry SH degree 1
    mesh.visible = false;      // invisible meshes are skipped by Spark's generator until shown
    this.stage.world.add(mesh);
    const p = mesh.initialized.then(() => {
      delete this.loading[tier];
      if (this.disposed) { this._drop(mesh); throw Object.assign(new Error('disposed'), { name: 'AbortError' }); }
      this.meshes[tier] = mesh;
      return mesh;
    }, e => {
      delete this.loading[tier];
      this._drop(mesh);
      throw e;
    });
    this.loading[tier] = p;
    return p;
  }

  /** Put a loaded tier on screen: it fades in over the one showing, which is then hidden (and disposed if `drop`). */
  show(tier, { dur = 520, drop = [] } = {}) {
    const mesh = this.meshes[tier];
    if (!mesh) return;
    const prev = this.active && this.active !== tier ? this.meshes[this.active] : null;
    this.active = tier;        // first: a running fade that ends below must not drop this tier
    this._finishFade();
    const out = [];
    if (prev && prev !== mesh) out.push(prev);
    for (const t of drop) if (t !== tier && this.meshes[t] && !out.includes(this.meshes[t])) out.push(this.meshes[t]);
    if (!this.on || dur <= 0 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      for (const m of out) m.visible = false;
      this._dropTiers(drop, tier);
      this.apply();
      return;
    }
    this.fade = { mesh, t0: performance.now(), dur, out, drop, tier };
    mesh.opacity = 0;
    mesh.visible = true;
    this.stage.hooks.add(this._hook);
    this.stage.invalidate();
  }
  _step(now) {
    const f = this.fade;
    if (!f) return false;
    const k = Math.min(1, (now - f.t0) / f.dur);
    f.mesh.opacity = this.opacity * (k * k * (3 - 2 * k));
    f.mesh.visible = this.on;
    if (k < 1) return true;
    // then the tiers leaving fade OUT under the one now fully in. Hiding them at once was a visible pop: LITE is a
    // subset of STANDARD, so its splats are drawn twice during the fade-in and that haze vanished in one frame
    // (mean |delta luma| 10-12 on kitti_01, notes/STREAMING_NOTES.md section 4.2)
    const out = f.out.filter(m => m !== this.meshes[this.active] && m.parent);
    if (!out.length) { this._finishFade(); return false; }
    if (f.t1 == null) f.t1 = now;
    const k2 = Math.min(1, (now - f.t1) / OUT_MS);
    const a = this.opacity * (1 - k2 * k2 * (3 - 2 * k2));
    for (const m of out) { m.opacity = a; m.visible = this.on && a > 0.001; }
    if (k2 >= 1) { this._finishFade(); return false; }
    return true;
  }
  _finishFade() {
    const f = this.fade;
    if (!f) return;
    this.fade = null;
    this.stage.hooks.delete(this._hook);
    for (const m of f.out) if (m !== this.meshes[this.active]) m.visible = false;
    this._dropTiers(f.drop, f.tier);
    this.apply();
  }
  _dropTiers(tiers, keep) {
    for (const t of tiers || []) {
      // never the tier on screen (a fade that finishes late may name the tier that has replaced it since)
      if (t === keep || t === this.active || !this.meshes[t]) continue;
      this._drop(this.meshes[t]);
      delete this.meshes[t];
    }
  }
  _drop(mesh) {
    mesh.removeFromParent();
    try { mesh.dispose(); } catch (e) { /* ignore */ }
  }
  /** Free a tier that is not on screen (e.g. LITE once STANDARD is showing). */
  drop(tier) { if (tier !== this.active) this._dropTiers([tier], this.active); }

  apply() {
    for (const [t, m] of Object.entries(this.meshes)) {
      if (t !== this.active) { if (!this.fade || !this.fade.out.includes(m)) m.visible = false; continue; }
      m.opacity = this.opacity;
      m.visible = this.on && this.opacity > 0.001;
    }
    this.stage.invalidate();
  }
  setOn(on) { this.on = on; if (this.fade) this.fade.mesh.visible = on; this.apply(); }
  setOpacity(a) { this.opacity = a; this.apply(); }

  dispose() {
    this.disposed = true;
    this._finishFade();
    for (const m of Object.values(this.meshes)) this._drop(m);
    this.meshes = {};
    this.active = null;
  }
}

// ---------------------------------------------------------------- metric ground grid
// A horizontal plane in world space (Y up) at the floor height, drawn before the splats with no depth write, so the
// map covers it where the map is solid. Minor and major lines; the minor lines fade where they get too dense.
const GRID_VERT = /* glsl */`
  varying vec3 vW;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;
const GRID_FRAG = /* glsl */`
  uniform float uCell, uMajor, uOpacity, uRadius;
  uniform vec2 uCenter;
  uniform vec3 uCol, uColMajor;
  varying vec3 vW;
  float line(vec2 p, float cell, float w) {
    vec2 q = p / cell;
    vec2 g = abs(fract(q - 0.5) - 0.5) / max(fwidth(q), vec2(1e-6));
    return 1.0 - min(min(g.x, g.y) / w, 1.0);
  }
  void main() {
    vec2 p = vW.xz;
    float dens = max(fwidth(p.x), fwidth(p.y)) / uCell;
    float minor = line(p, uCell, 1.0) * (1.0 - smoothstep(0.06, 0.3, dens));
    float major = line(p, uMajor, 1.4) * (1.0 - smoothstep(0.08, 0.5, dens / 10.0));
    float r = length(p - uCenter) / uRadius;
    float fade = 1.0 - smoothstep(0.45, 1.0, r);
    float a = max(minor * 0.26, major * 0.62) * fade * uOpacity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(mix(uCol, uColMajor, step(0.5, major)), a);
  }`;

export class Grid {
  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: GRID_VERT,
      fragmentShader: GRID_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uCell: { value: 1 }, uMajor: { value: 10 }, uOpacity: { value: 0.9 }, uRadius: { value: 50 },
        uCenter: { value: new THREE.Vector2() },
        uCol: { value: new THREE.Vector3(...hexToRgb01(token('--fg-3') || '#66727f')) },
        uColMajor: { value: new THREE.Vector3(...hexToRgb01(token('--fg-2') || '#9ba8b8')) },
      },
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.renderOrder = -1;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'metric grid';
    this.cell = 1;
  }
  /** center: world Vector3 (x, z used), y: floor height, extent: metres across, cell: minor spacing (m). */
  build({ center, y, extent, cell }) {
    const size = extent * 1.6;
    this.mesh.scale.set(size, size, 1);
    this.mesh.position.set(center.x, y, center.z);
    const u = this.material.uniforms;
    u.uCell.value = cell; u.uMajor.value = cell * 10; u.uRadius.value = size / 2;
    u.uCenter.value.set(center.x, center.z);
    this.cell = cell;
  }
  dispose() { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.material.dispose(); }
}

/** A minor grid spacing on the 1-10-100 ladder, giving roughly 10-40 cells across the map. */
export function gridCell(extent) {
  return Math.pow(10, Math.max(-1, Math.floor(Math.log10(Math.max(0.5, extent) / 10))));
}
