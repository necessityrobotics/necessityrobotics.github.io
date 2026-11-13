// F: a copy of concept E grow.js (the measured points: material, prefix loader, holder). F uses only the points part.
// Concept E ("Points to place"), shared by the home stage (world.js) and the 3-D view (place/engine.js).
//
// One idea in two parts, both driven by ONE number: the radius R of a front around a spot (metres, map frame).
//   splats  (Spark objectModifier)   outside R: hidden. In a band inside R: a fine dot that swells to its true size.
//                                     Deep inside R: the place as it is.
//   points  (three.js Points)        the depth points our software measured from the camera's photos. Outside R: fine
//                                     dots. As the front passes, they fade, and the place takes their spot.
// Nothing here has a clock. The page sets R from the scroll (home) or from the one arrival after a click (3-D view).
import * as THREE from 'three';
import { dyno } from '@sparkjsdev/spark';

/**
 * The growth modifier for a SplatMesh (object frame = the map frame).
 * Returns { modifier, set({ c, r, band }), r } . Call mesh.updateVersion() after set() so Spark generates again.
 */
export function makeGrow({ band = 6, dot = 0.012, jitter = 2.2 } = {}) {
  const uC = new dyno.DynoVec3({ value: new THREE.Vector3() });
  const uR = new dyno.DynoFloat({ value: -1e4 });
  const uBand = new dyno.DynoFloat({ value: band });
  const uDot = new dyno.DynoFloat({ value: dot });
  const uJit = new dyno.DynoFloat({ value: jitter });
  const modifier = dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
    const d = new dyno.Dyno({
      inTypes: { gsplat: dyno.Gsplat, c: 'vec3', r: 'float', band: 'float', dot: 'float', jit: 'float' },
      outTypes: { gsplat: dyno.Gsplat },
      inputs: { gsplat, c: uC, r: uR, band: uBand, dot: uDot, jit: uJit },
      globals: () => [dyno.defineGsplat],
      statements: ({ inputs: i, outputs: o }) => [
        `${o.gsplat} = ${i.gsplat};`,
        `if (isGsplatActive(${i.gsplat}.flags)) {`,
        `  float h = fract(sin(float(${i.gsplat}.index) * 12.9898 + 4.1414) * 43758.5453);`,
        `  float dd = distance(${i.gsplat}.center, ${i.c}) + h * ${i.jit};`,
        `  float f = clamp((${i.r} - dd) / ${i.band}, 0.0, 1.0);`,
        `  float s = f * f * (3.0 - 2.0 * f);`,
        `  vec3 big = max(${i.gsplat}.scales, vec3(1e-6));`,
        `  vec3 small = max(min(big, vec3(${i.dot})), vec3(1e-6));`,
        `  ${o.gsplat}.scales = exp(mix(log(small), log(big), s));`,          // a fine dot that swells, each axis by the same factor
        `  ${o.gsplat}.rgba.a = ${i.gsplat}.rgba.a * smoothstep(0.0, 0.45, f);`,
        `}`,
      ],
    });
    return { gsplat: d.outputs.gsplat };
  });
  return {
    modifier,
    get r() { return uR.value; },
    set({ c, r, band: b } = {}) {
      if (c) uC.value.copy(c);
      if (r != null) uR.value = r;
      if (b != null) uBand.value = b;
    },
  };
}

// ---------------------------------------------------------------- the measured points, with the same front
const PTS_VERT = /* glsl */`
  #if RGB
  attribute vec3 aRgb;
  #else
  attribute float aGrey;
  #endif
  uniform vec3 uMin, uExt, uC;
  uniform float uR, uBand, uJit, uSize, uPR, uViewH, uMinPx, uMaxPx, uGain, uNear;
  varying vec3 vC; varying float vA;
  void main() {
    vec3 m = uMin + position * uExt;                                   // map frame, metres
    float h = fract(sin(float(gl_VertexID) * 12.9898 + 4.1414) * 43758.5453);
    float dd = distance(m, uC) + h * uJit;
    float inside = clamp((uR - dd) / uBand, 0.0, 1.0);               // 0 = still a point, 1 = the place took its spot
    float rim = 1.0 - abs(inside * 2.0 - 1.0);                        // brightest in the middle of the band
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float d = max(1e-3, -mv.z);
    gl_Position = projectionMatrix * mv;
    float px = uSize * uViewH * 0.5 * projectionMatrix[1][1] / d;
    gl_PointSize = clamp(px, uMinPx * uPR, uMaxPx * uPR);
    #if RGB
    vec3 c = aRgb;
    #else
    vec3 c = vec3(aGrey);
    #endif
    c = min(vec3(1.0), c * uGain + 0.06);
    vC = min(vec3(1.0), c * (1.0 + 0.7 * rim));
    vA = (1.0 - smoothstep(0.35, 1.0, inside)) * smoothstep(uNear, uNear * 3.0, d);
  }`;
const PTS_FRAG = /* glsl */`
  uniform float uOpacity;
  varying vec3 vC; varying float vA;
  void main() {
    vec2 q = gl_PointCoord * 2.0 - 1.0;
    float r = dot(q, q);
    if (r > 1.0) discard;
    float a = uOpacity * vA * (1.0 - r * r);
    if (a < 0.003) discard;
    gl_FragColor = vec4(vC * a, a);
  }`;

/** A points material with the front. size: world units of one point (metres x the parent's scale). */
export function makePointsMaterial(meta, { size = 0.05, minPx = 1.0, maxPx = 3.2, gain = 1.25, near = 0.3, rgb = false } = {}) {
  return new THREE.ShaderMaterial({
    defines: { RGB: rgb ? 1 : 0 }, vertexShader: PTS_VERT, fragmentShader: PTS_FRAG,
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendEquation: THREE.AddEquation,
    uniforms: {
      uMin: { value: new THREE.Vector3(...meta.bbox_min) },
      uExt: { value: new THREE.Vector3(...meta.bbox_max.map((v, k) => v - meta.bbox_min[k])) },
      uC: { value: new THREE.Vector3() }, uR: { value: -1e4 }, uBand: { value: 6 }, uJit: { value: 2.2 },
      uSize: { value: size }, uPR: { value: 1 }, uViewH: { value: 900 }, uMinPx: { value: minPx }, uMaxPx: { value: maxPx },
      uGain: { value: gain }, uNear: { value: near }, uOpacity: { value: 1 },
    },
  });
}

/**
 * The first n points of points.bin (a random permutation: any prefix is a uniform subsample). Two HTTP Range requests
 * (positions, colours); a server that ignores Range answers with the whole file once, and the prefix is cut from it.
 */
export async function loadPointPrefix(url, meta, n) {
  n = Math.min(n, meta.count);
  const cb = meta.colour === 'rgb8' ? 3 : 1, off = meta.colour_offset ?? meta.count * 6;
  const r1 = await fetch(url, { headers: { Range: `bytes=0-${n * 6 - 1}` } });
  if (!(r1.ok)) throw new Error(`points: HTTP ${r1.status}`);
  if (r1.status === 206) {
    const pos = new Uint16Array(await r1.arrayBuffer());
    const r2 = await fetch(url, { headers: { Range: `bytes=${off}-${off + n * cb - 1}` } });
    const col = new Uint8Array(await r2.arrayBuffer());
    return { n, pos, col, rgb: cb === 3 };
  }
  const buf = await r1.arrayBuffer();
  return { n, pos: new Uint16Array(buf, 0, n * 3), col: new Uint8Array(buf, off, n * cb), rgb: cb === 3 };
}

/** THREE.Points from a prefix (positions stay normalised uint16; the material de-quantises with uMin / uExt). */
export function makePoints(meta, data, mat) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(data.pos, 3, true));
  g.setAttribute(data.rgb ? 'aRgb' : 'aGrey', new THREE.BufferAttribute(data.col, data.rgb ? 3 : 1, true));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0.5, 0.5, 0.5), 0.87);
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  const holder = new THREE.Group();                                 // the de-quantising transform
  holder.position.fromArray(meta.bbox_min);
  holder.scale.set(...meta.bbox_max.map((v, k) => Math.max(1e-6, v - meta.bbox_min[k])));
  holder.add(pts);
  return { holder, pts, dispose() { holder.removeFromParent(); g.dispose(); } };
}

/**
 * A fade of the splats that are very near the eye (a world modifier, view depth). Used while the camera comes down
 * through the trees: leaves a few metres from the eye would fill the picture with soft blobs. set(n0, n1): fully
 * hidden nearer than n0, fully shown beyond n1 (world units); set(0, 0) = off.
 */
export function makeNearFade(mesh) {
  const uN0 = new dyno.DynoFloat({ value: 0 }), uN1 = new dyno.DynoFloat({ value: 0 });
  mesh.enableWorldToView = true;
  const modifier = dyno.dynoBlock({ gsplat: dyno.Gsplat }, { gsplat: dyno.Gsplat }, ({ gsplat }) => {
    const { center } = dyno.splitGsplat(gsplat).outputs;
    const vc = mesh.context.worldToView.apply(center);
    const d = new dyno.Dyno({
      inTypes: { gsplat: dyno.Gsplat, vc: 'vec3', n0: 'float', n1: 'float' }, outTypes: { gsplat: dyno.Gsplat },
      inputs: { gsplat, vc, n0: uN0, n1: uN1 }, globals: () => [dyno.defineGsplat],
      statements: ({ inputs: i, outputs: o }) => [
        `${o.gsplat} = ${i.gsplat};`,
        `if (${i.n1} > 0.001) ${o.gsplat}.rgba.a *= smoothstep(${i.n0}, ${i.n1}, -${i.vc}.z);`,
      ],
    });
    return { gsplat: d.outputs.gsplat };
  });
  return { modifier, set(n0, n1) { const ch = uN0.value !== n0 || uN1.value !== n1; uN0.value = n0; uN1.value = n1; return ch; } };
}

/** The front radius for an arrival / growth fraction k (0..1): near first, then faster outward. */
export function frontOf(k, rmax, band) {
  if (k <= 0) return -band * 2;
  if (k >= 1) return 1e4;
  return -band + (rmax + band) * Math.pow(k, 1.35);
}
