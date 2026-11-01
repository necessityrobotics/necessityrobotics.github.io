// xclean page: Fig. 1, the SLAM point field, behind the header's right column. A cheap 2-D canvas; its 107 KB of data
// are fetched once the page is idle, and it animates only while on screen.
import { $, fmtInt, getJSON, idle } from './site.js';
import { PointField } from './field.js';

const canvas = $('.field-canvas');
if (canvas) idle(() => getJSON('data/starfield.json').then(d => {
  document.querySelectorAll('.js-field-n').forEach(e => { e.textContent = fmtInt(d.n); });
  document.querySelectorAll('.js-field-of').forEach(e => { e.textContent = fmtInt(d.of); });
  new PointField(canvas, d, { tilt: 0.95, zoom: 0.55, centerX: 0.5, centerY: 0.5 });
}).catch(e => console.warn('[xclean] starfield', e)), 1200);
