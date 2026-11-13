// Concept C, CAMERA GHOSTS: the camera's real photos stand in the 3-D place as thin frames, at the exact spot and in the
// exact direction where the camera took them (keyframes.json: T_map_cam and K, the camera's own model). A video can
// never show its own camera; this page shows it from outside.
//
// One frame = one quad in the camera's own coordinates (OpenCV: x right, y down, z forward), `depth` metres in front
// of the camera, the size of the photo at that depth (plus a thin white rim), and the four lines from the camera's
// centre to the photo's corners. Seen from the camera's own spot, the quad covers the view exactly: the photo lines up
// with the place behind it. Solid frames are drawn BEFORE the splats and write depth (they hide what is behind them);
// a fading frame is drawn after the splats and the path, without depth (a cross-fade with the place).
import * as THREE from 'three';

const VERT = /* glsl */`
  varying vec2 vUv; varying vec4 vClip; varying float vFront;
  void main() {
    vUv = uv;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vec3 n = normalize(mat3(modelMatrix) * vec3(0.0, 0.0, -1.0));     // towards the photo's own camera
    vFront = dot(cameraPosition - w.xyz, n);
    vClip = projectionMatrix * viewMatrix * w;
    gl_Position = vClip;
  }`;
// the colours are written as they are (sRGB), like the splats and the camera's path
const FRAG = /* glsl */`
  uniform sampler2D uTex; uniform float uOp, uWipe, uHas; uniform vec3 uRim, uBack;
  varying vec2 vUv; varying vec4 vClip; varying float vFront;
  void main() {
    float sx = vClip.x / vClip.w * 0.5 + 0.5;
    if (sx > uWipe) discard;                                         // the line between "photo" and "3-D place"
    bool inside = vUv.x >= 0.0 && vUv.x <= 1.0 && vUv.y >= 0.0 && vUv.y <= 1.0;
    vec3 c = uRim;
    if (inside) c = vFront > 0.0 ? (uHas > 0.5 ? texture2D(uTex, vec2(vUv.x, 1.0 - vUv.y)).rgb : vec3(0.1)) : uBack;
    gl_FragColor = vec4(c, uOp);
  }`;

const srgb = hex => { const c = new THREE.Color(hex); return new THREE.Vector3(c.r, c.g, c.b); };   // raw values, no conversion
const D = new THREE.Matrix4().makeScale(1, -1, -1);                  // OpenCV camera axes -> three.js camera axes

export class Ghosts {
  /**
   * engine: the place engine (live). ids: indices into keyframes.json to build.
   * depth: metres from the camera to its photo. rim: width of the white rim in photo pixels.
   */
  constructor(engine, { ids, depth = 0.9, rim = 3, base }) {
    this.E = engine;
    const kfs = engine.kfs, K = kfs.K, [w, h] = kfs.image_size;
    this.K = { fx: K[0][0], fy: K[1][1], cx: K[0][2], cy: K[1][2], w, h };
    this.depth = depth;
    this.base = base;                                                 // the folder URL of the keyframe photos
    this.group = new THREE.Group();
    this.group.name = "the camera's photos";
    engine.stage.world.add(this.group);
    this.loader = new THREE.TextureLoader();
    this.frames = new Map();
    // one geometry for all: the photo plus its rim, in the camera's own coordinates
    const { fx, fy, cx, cy } = this.K, d = depth, r = rim;
    const P = (u, v) => [(u - cx) / fx * d, (v - cy) / fy * d, d];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([...P(-r, -r), ...P(w + r, -r), ...P(w + r, h + r), ...P(-r, h + r)], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([-r / w, -r / h, 1 + r / w, -r / h, 1 + r / w, 1 + r / h, -r / w, 1 + r / h], 2));
    g.setIndex([0, 3, 2, 0, 2, 1]);
    this.geo = g;
    const L = [0, 0, 0], c = [P(0, 0), P(w, 0), P(w, h), P(0, h)];
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute([...L, ...c[0], ...L, ...c[1], ...L, ...c[2], ...L, ...c[3]], 3));
    this.lgeo = lg;
    this.world = engine.stage.world;
    this.world.updateMatrixWorld(true);
    for (const i of ids) this._make(i);
  }

  _make(i) {
    const k = this.E.kfs.keyframes[i];
    if (!k || this.frames.has(i)) return this.frames.get(i);
    const T = new THREE.Matrix4().set(...k.T_map_cam.flat());
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, side: THREE.DoubleSide, transparent: true, depthWrite: false,
      uniforms: { uTex: { value: null }, uOp: { value: 0 }, uWipe: { value: 1.01 }, uHas: { value: 0 },
        uRim: { value: srgb('#eef0f1') }, uBack: { value: srgb('#1c1e20') } },
    });
    const mesh = new THREE.Mesh(this.geo, mat);
    mesh.matrixAutoUpdate = false; mesh.matrix.copy(T);
    mesh.visible = false; mesh.renderOrder = 31; mesh.frustumCulled = false;
    mesh.userData.kf = i;
    const lmat = new THREE.LineBasicMaterial({ color: 0xeef0f1, transparent: true, opacity: 0, depthWrite: false });
    const lines = new THREE.LineSegments(this.lgeo, lmat);
    lines.matrixAutoUpdate = false; lines.matrix.copy(T); lines.visible = false; lines.renderOrder = 32; lines.frustumCulled = false;
    this.group.add(mesh, lines);
    // the photo's own camera in the world: position, direction, and the centre of the photo
    const M = new THREE.Matrix4().multiplyMatrices(this.world.matrixWorld, T).multiply(D);
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    M.decompose(p, q, s);
    const { fx, fy, cx, cy, w, h } = this.K;
    const centre = new THREE.Vector3((w / 2 - cx) / fx * this.depth, (h / 2 - cy) / fy * this.depth, this.depth)
      .applyMatrix4(new THREE.Matrix4().multiplyMatrices(this.world.matrixWorld, T));
    const f = { i, at: this.E.photos[i]?.at ?? 0, t: k.t, file: k.file, mesh, mat, lines, lmat, p, q, centre, op: 0, lop: 0, lbase: 0, wipe: 1, solid: null, tex: null };
    // the four lines show only when the frame is seen from the side (a camera's field of view). Seen from behind the
    // camera they cross the photo as an X, so there they fade out.
    const fw = new THREE.Vector3().subVectors(centre, p).normalize(), eye = new THREE.Vector3();
    lines.onBeforeRender = (r, sc, cam) => {
      eye.setFromMatrixPosition(cam.matrixWorld).sub(p).normalize();
      const side = 1 - Math.abs(eye.dot(fw));
      lmat.opacity = f.lbase * Math.min(1, Math.max(0, (side - 0.2) / 0.35));
    };
    this.frames.set(i, f);
    return f;
  }
  _tex(f) {
    if (f.tex) return;
    f.tex = this.loader.load(`${this.base}/${f.file}`, t => {
      t.colorSpace = THREE.NoColorSpace; t.anisotropy = 4;
      f.mat.uniforms.uHas.value = 1;
      this.E.stage.invalidate();                                   // a load step: one frame
    });
    f.mat.uniforms.uTex.value = f.tex;
  }
  /** The photo frame's opacity (0..1). Solid at 1: drawn before the splats, it hides what is behind it. */
  set(i, { op, lines, wipe } = {}) {
    const f = this.frames.get(i) || this._make(i);
    if (!f) return;
    if (op != null) f.op = Math.max(0, Math.min(1, op));
    if (lines != null) f.lop = Math.max(0, Math.min(1, lines));
    if (wipe != null) f.wipe = wipe;
    if (f.op > 0.002) this._tex(f);
    f.mat.uniforms.uOp.value = f.op;
    f.mat.uniforms.uWipe.value = f.wipe >= 1 ? 1.01 : f.wipe;
    f.mesh.visible = f.op > 0.002 && f.wipe > 0.001;
    const solid = f.op >= 0.999;
    if (solid !== f.solid) {
      f.solid = solid;
      f.mat.transparent = !solid; f.mat.depthWrite = solid;
      f.mesh.renderOrder = solid ? -10 : 31;                // fading: after the splats and the camera's path
      f.mat.needsUpdate = true;
    }
    f.lbase = f.lop * 0.4 * Math.min(1, f.op * 1.5);
    f.lmat.opacity = f.lbase;
    f.lines.visible = f.lbase > 0.003;
  }
  each(fn) { for (const f of this.frames.values()) fn(f); }
  get(i) { return this.frames.get(i) || this._make(i); }

  /** The camera's field of view and projection shift at which photo i fills a box of aspect a ("cover"), exactly. */
  view(a) {
    const { fx, fy, cx, cy, w, h } = this.K;
    const th = (w / 2) / fx, tv = (h / 2) / fy;                  // half-angle tangents of the photo
    const ty = a >= w / h ? th / a : tv, tx = ty * a;
    return { fov: 2 * Math.atan(ty), sx: ((w / 2 - cx) / fx) / tx, sy: ((cy - h / 2) / fy) / ty };
  }
  /** The photo frame under a pointer (CSS px in the box), or null. Only frames that show. */
  pick(px, py) {
    const E = this.E, cam = E.stage.camera;
    if (!E.W) return null;
    const rc = this._rc || (this._rc = new THREE.Raycaster());
    rc.setFromCamera(new THREE.Vector2(px / E.W * 2 - 1, 1 - py / E.H * 2), cam);
    const list = [...this.frames.values()].filter(f => f.mesh.visible && f.op > 0.3).map(f => f.mesh);
    const hit = rc.intersectObjects(list, false)[0];
    return hit ? this.frames.get(hit.object.userData.kf) : null;
  }
  /** Screen position (CSS px) of a point of photo i: u, v in 0..1 of the photo. */
  screen(i, u, v, out = {}) {
    const f = this.get(i), { fx, fy, cx, cy, w, h } = this.K;
    const P = new THREE.Vector3((u * w - cx) / fx * this.depth, (v * h - cy) / fy * this.depth, this.depth)
      .applyMatrix4(f.mesh.matrix).applyMatrix4(this.world.matrixWorld);
    return this.E.project(P, out) ? out : null;
  }
  dispose() {
    this.group.removeFromParent();
    this.each(f => { f.mat.dispose(); f.lmat.dispose(); f.tex?.dispose(); });
    this.geo.dispose(); this.lgeo.dispose();
  }
}
