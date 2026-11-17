// The AR doors of every page that shows a place (owner 2026-11-17: "the ar\vr feature is perfect, can we do same for all 3d
// maps"): the 3-D view's footer, the home's eight places, the depth page, the 3-D places list. One rule for all of them:
// a door shows only on a touch device where immersive-ar can start (Android Chrome on ARCore phones); the AR code
// (js/xr/table.js + three) is loaded BEFORE the tap, because the session must be requested inside the tap itself.
//
//   arDoors(buttons, { before, after })   buttons carry data-ar="<place id>", data-name, data-len; hidden until ready
let ready = null;
export function arReady() {
  if (ready) return ready;
  const ok = !!(window.isSecureContext && navigator.xr && matchMedia('(pointer: coarse)').matches);
  ready = ok ? navigator.xr.isSessionSupported('immersive-ar').then(s => (s ? import('/js/xr/table.js') : null)).catch(() => null)
    : Promise.resolve(null);
  return ready;
}

export function arDoors(buttons, { before, after } = {}) {
  const list = [...(buttons || [])].filter(Boolean);
  if (!list.length) return Promise.resolve(false);
  return arReady().then(m => {
    if (!m) return false;
    for (const b of list) {
      b.hidden = false;
      b.addEventListener('click', e => {
        e.preventDefault();
        if (window.__xrBusy) return;                         // one AR session at a time
        window.__xrBusy = true;
        before?.(b);
        m.openTable({ id: b.dataset.ar, name: b.dataset.name || '', len: b.dataset.len || '', onEnd: () => { window.__xrBusy = false; after?.(b); } });   // (inside the tap)
      });
    }
    return true;
  });
}
