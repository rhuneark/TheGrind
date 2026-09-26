# Wiring Grind City into RUN

This guide is everything RUN needs. It works as a brief for whoever builds the integration, including Claude Code opened in the RUN repo.

## 1. Copy four files

```
dist/city.png                → RUN/assets/city/city.png
dist/atlas.json              → RUN/assets/city/atlas.json
dist/map.json                → RUN/assets/city/map.json
runtime/city-renderer.js     → RUN/src/city/city-renderer.js   (ES module, no dependencies)
```

Re-copy them whenever the pipeline is rebuilt. RUN never edits them.

## 2. Draw the city

```js
import { loadCity, createCityRenderer } from './city/city-renderer.js';

const city = await loadCity('assets/city/');
const renderer = createCityRenderer(canvas, city, {
  scale: 2,                                   // integer only
  resolve: id => cityState(id),               // see §3
});

let camX = 0, camY = 0, hour = 12;
function tick(now) {
  renderer.draw({ camX, camY, hour, time: now });
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
```

If RUN doesn't redraw every frame, redraw at least every 100 ms while `renderer.animating()` is true. That keeps the build and dust animations moving.

## 3. Tell the renderer about the player's coffee shops

`resolve(objectId)` is called for every building. Return what the save file knows about it, or nothing:

```js
{ state, tier, producing, progress }
```

| field | meaning |
|---|---|
| `state` | `'vacant'`, `'constructing'`, `'built'` or `'renovating'`. When missing, the map's `startState` is used, then `'built'` |
| `tier` | 1–3. Picks the building size for that tier |
| `producing` | true lights the windows at night |
| `progress` | 0–1 while `constructing`, picks one of the 5 build frames. Leave it out and the frames loop |

**The map already says which spots start unbought.** Coffee spots marked `startState: "vacant"` in `map.json` show cones from the start, with no save data needed. There are 12, on prominent street-facing 2×2 lots. There are also 3 coffee stands (`category: "stand"`), small kiosks in a park and on plazas, which work exactly like shops.

A save file only needs entries for spots the player has touched:

```js
// save.shops = { "shop_004": { state: "built", tier: 2, producing: true }, ... }
function cityState(id) {
  const s = save.shops[id];
  if (!s) return null;                                   // → map's startState, else built
  if (s.state === 'constructing' || s.state === 'renovating') {
    const t = (Date.now() - s.startedAt) / s.durationMs;
    if (t >= 1) { s.state = 'built'; delete s.startedAt; }   // finished: flip to built
    else return { ...s, progress: s.state === 'constructing' ? t : undefined, producing: false };
  }
  return s;
}
```

## 4. Buying and renovating

```js
function buyShop(id) {                   // the player buys a coned spot
  save.shops[id] = { state: 'constructing', tier: 1, startedAt: Date.now(), durationMs: 4000 };
}
function renovateShop(id, newTier) {     // the player upgrades an open shop
  save.shops[id] = { ...save.shops[id], state: 'renovating', tier: newTier, startedAt: Date.now(), durationMs: 2500 };
}
```

- **Building:** 5 frames. Foundation, frame rising in scaffolding, topped out in bare concrete, cladding going on, then finished with a puff of dust. With `progress` driven by time, it plays once and lands on the finished building. Use any duration; real time works too.
- **Renovating:** a 4-frame dust loop over the building for as long as the state lasts.
- Café tables that belong to a shop (`belongsTo` in `map.json`) stay hidden while it's vacant or under construction.

The frames are drawn by the renderer from whichever building the spot will become, so there's nothing extra to load. `preview/frames.html` shows every frame.

## 5. Clicking a spot

Map objects give grid cells, and the renderer's projection is fixed. To turn a click into a cell:

```js
// sx, sy: pointer position in CSS pixels on the canvas; k = CSS scale (e.g. 2)
const wx = (sx - canvas.clientWidth / 2) / k + camX;
const wy = (sy - canvas.clientHeight / 2) / k + camY;
const col = Math.floor((wx / 32 + wy / 16) / 2);
const row = Math.floor((wy / 16 - wx / 32) / 2);
const shop = city.map.objects.find(o => ['shop', 'stand'].includes(o.category) &&
  col >= o.col && col < o.col + o.footprint[0] && row >= o.row && row < o.row + o.footprint[1]);
```

This hits the building's ground footprint, which is where the cones sit. The preview (`preview/index.html`, and the published preview page) does exactly this: click a coned spot to buy it, or click an open coffee shop to renovate it.
