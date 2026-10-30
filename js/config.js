// Necessity Robotics site: the ONE place that says where the heavy map files live (DESIGN.md section 6).
//
// Production: the Hugging Face dataset repo. HF answers HTTP Range requests with 206 and Access-Control-Allow-Origin: *,
// so the viewer can stream points.bin and the splats from a github.io page.
// Development: tools/serve.py mounts the staged assets folder at /assets/ on 127.0.0.1.
// To test the production host from a local preview, open any page with ?assets=prod.
export const ASSET_BASE_PROD = 'https://huggingface.co/datasets/Pyassahu/xclean-maps/resolve/main';
export const ASSET_BASE_DEV = '/assets';

// This PC, or a private LAN address (the dev preview opened on a phone or tablet on the same Wi-Fi).
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(location.hostname);
const FORCE = new URLSearchParams(location.search).get('assets');
export const ASSET_BASE = FORCE === 'prod' ? ASSET_BASE_PROD : FORCE === 'dev' ? ASSET_BASE_DEV : (LOCAL ? ASSET_BASE_DEV : ASSET_BASE_PROD);

/** Absolute URL of one file of one map (Spark and fetch never depend on <base>). */
export function asset(mapId, file) {
  const base = ASSET_BASE.startsWith('http') ? ASSET_BASE : new URL(ASSET_BASE, location.origin).href;
  return `${base.replace(/\/$/, '')}/maps/${encodeURIComponent(mapId)}/${file}`;
}

export const LINKS = {
  repo: 'https://github.com/necessityrobotics/xclean',
  github: 'https://github.com/necessityrobotics',
  hf: 'https://huggingface.co/Pyassahu',
  maps: 'https://huggingface.co/datasets/Pyassahu/xclean-maps',
  email: 'necessityrobotics@gmail.com',
};
