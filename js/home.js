// Landing page (v3): the world (js/world: one 3-D stage under every beat, or the still path) with HOME's overlays and
// the 2-D story. Every number is read from data/*.json; the static HTML carries the same values, so the page reads
// correctly before (and without) this script. The overlays subscribe first, so they see the world's first events.
import { getJSON } from './site.js';
import { world, startWorld } from './world/api.js';
import { startOverlays } from './home/overlays.js';
import { startStory } from './home/story.js';

startStory();
Promise.all([getJSON('data/maps.json'), getJSON('data/atlas.json'), getJSON('data/routes.json')]).then(([maps, atlas, routes]) => {
  startOverlays(world, { maps, atlas, routes });
  return startWorld({ maps, atlas, routes, root: document.getElementById('world') });
}).catch(e => console.warn('[home]', e));
