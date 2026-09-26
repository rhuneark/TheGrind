Add the Grind City map to RUN, including buying and renovating coffee shops.

**Source:** the city comes from github.com/rhuneark/TheGrind (branch `claude/determined-cori-xnz9ad`). The full integration guide is `docs/RUN_INTEGRATION.md` in that repo; read it first. RUN must not know PixelLab exists. It only consumes these files.

1. **Copy the city files** from TheGrind into RUN:
   - `dist/city.png`, `dist/atlas.json`, `dist/map.json` → `assets/city/`
   - `runtime/city-renderer.js` → `src/city/city-renderer.js` (ES module, no dependencies)

   Treat these as vendored; don't edit them.

2. **Render the city** on a canvas with `loadCity('assets/city/')` and `createCityRenderer(canvas, city, { scale: 2, resolve })`. Call `renderer.draw({ camX, camY, hour, time })` every animation frame. `time` is the rAF timestamp; `hour` is RUN's in-game time of day, 0–24. Add drag-to-pan for the camera. Zoom uses integer scales only.

3. **Store coffee-shop state in the save file**, never in `map.json`: `save.shops[objectId] = { state, tier, producing, startedAt, durationMs }`.
   - `state` is one of `'vacant' | 'constructing' | 'built' | 'renovating'`.
   - Only spots the player has touched need an entry. Untouched spots use the map's `startState`: spots marked `"vacant"` already show cones. Everything else is built.

4. **Implement `resolve(objectId)`:**
   - Return the save entry, or `null` if there isn't one.
   - While `constructing`, return `progress = (now - startedAt) / durationMs`, clamped 0–1. That drives the 5 build frames.
   - When a timed state reaches 1, set the entry to `'built'` and persist it.
   - Set `producing: true` for open shops that are making money; their windows light up at night.

5. **Buying:** clicking a shop whose state is vacant (save entry, else map `startState`) triggers RUN's purchase flow. On success, set `{ state: 'constructing', tier: 1, startedAt: Date.now(), durationMs: <build time> }`. Only buy when the player can afford it, using RUN's existing money logic.

6. **Renovating/upgrading:** clicking an open shop offers renovation. On confirm, set `{ ...entry, state: 'renovating', tier: entry.tier + 1, startedAt, durationMs }`. Tiers top out at 3.

7. **Click → cell:** `col = floor((wx/32 + wy/16)/2)`, `row = floor((wy/16 - wx/32)/2)`, where `wx = (sx - canvas.clientWidth/2)/scale + camX` and `wy` works the same way. Pick the `map.objects` entry with `category` `'shop'` or `'stand'` whose footprint contains `(col, row)`. Stands (3 coffee kiosks in a park and on plazas) are ownable the same way as shops.

8. **Leave the animations to the renderer.** Don't reimplement them; the renderer draws the build and dust frames from the target building.

**Done when:**
- A fresh save shows cones on the vacant spots.
- Buying one plays the build animation and ends as a coffee shop that persists across reloads.
- Renovating plays dust, then shows the next tier.
- Existing RUN features still work.
