// Map facts for the home overlays, formatted exactly as the static HTML writes them. Every value comes from
// data/maps.json; nothing here adds a number.
import { fmtInt, fmtLen } from '../site.js';

export const isRosario = m => !m.own_data;
export const licence = m => `${m.map_licence} · ${m.own_data ? 'own data' : 'Rosario Dataset'}`;
/** The short credit spoken or shown where the full one does not fit (MASTER_PLAN.md 1.5, Rosario rule). */
export const shortCredit = m => (m.own_data ? `our own recording, ${m.map_licence}` : 'The Rosario Dataset, CIFASIS-CONICET, CC BY 4.0');

export function fields(m) {
  const s = m.stats;
  return {
    id: m.id, title: m.title, place: m.place, platform: m.platform, credit: m.credit, lic: licence(m),
    path: fmtLen(s.path_m), dur: `${s.duration_s.toFixed(1)} s`, kf: fmtInt(s.keyframes), g: `${(s.gaussians / 1e6).toFixed(2)} M`,
  };
}

/** Write a map's fields into every [data-f] inside el (only where the text differs, so nothing re-lays out). */
export function fillMap(el, m) {
  const f = fields(m);
  el.querySelectorAll('[data-f]').forEach(e => { const v = f[e.dataset.f]; if (v != null && e.textContent !== v) e.textContent = v; });
}
