# Grind City — asset pipeline

This repo builds the city art for RUN. It uses PixelLab to generate individual sprites, and code does everything else.
RUN receives only three files, all in `dist/`:

| File | What it is |
|---|---|
| `dist/city.png` | One packed sprite atlas |
| `dist/atlas.json` | Frame rects, anchors, footprints, sockets, tier→layer stacks, glass colours for lighting |
| `dist/map.json` | Ground grid and object placements. It records that a building exists at a position, never its tier |

`runtime/city-renderer.js` is the renderer RUN copies in. It has no knowledge of PixelLab.

## Locked constants

`grid.json` holds `tileW 64`, `tileH 32` (2:1 dimetric) and integer `scale 2`. `palette.json` holds 32 muted colours. Changing either one invalidates every sprite.

```
screenX = (col - row) * tileW/2      screenY = (col + row) * tileH/2
anchor  = the sprite point that lands on the footprint's bottom vertex
          (the bottom vertex of the front-most tile, col+w-1 / row+h-1)
order   = ascending (col + w - 1) + (row + h - 1)
```

## Stages

```sh
npm install
npm run reference -- 6        # step 2: candidates → ref/candidates/, pick + hand-clean → ref/base_tile.png
npm run generate              # Stage 2: every asset in assets.json missing from raw/
npm run generate -- --only id --candidates 4    # try seeds; results show on the contact sheet
node scripts/generate.js --adopt id:<seed>      # pin that seed in assets.json, move it to raw/
npm run build                 # Stage 3 process → Stage 4 pack → Stage 5 assemble → contact sheet
npm run preview               # http://localhost:8080/preview/  (4×4 test grid, or the full map)
```

- **Stage 2, `scripts/generate.js`.** Reads `assets.json`, calls the PixelLab v2 REST API, and writes `raw/<id>.png` plus a `raw/<id>.json` sidecar recording the request. It forces the palette via `color_image`. Seeds are stable per id unless pinned. Set `PIXELLAB_TOKEN`. Node's `fetch` needs `NODE_USE_ENV_PROXY=1` behind a proxy.
- **Stage 3, `scripts/process.js`.** Runs on every sprite:
  - quantizes to the palette and removes stray specks;
  - trims, then verifies and computes the anchor;
  - re-pads to multiples of 32×16.
  
  Buildings also get a `roof` socket at the centre of the top face, plus any wall sockets named in the manifest. Failures go to `rejected/` with a reason. Don't hand-fix them; change the prompt or seed.
- **Stage 4, `scripts/pack.js`.** Shelf-packs sprites into `dist/city.png` and `dist/atlas.json`. Also emits `stacks`, which maps category → tier → layers. Each layer is a list of variants, and RUN picks one per building by hashing its objectId.
- **Stage 5, `scripts/assemble.js`.** Builds `dist/map.json` from `chunks.json`: 8×8 chunks with shared road connectors, a seeded template choice, and checks for overlaps.
- **Human check, `contact-sheet.html`.** Shows every atlas sprite at 1× and 3× by type, with toggleable anchors and sockets. Also lists rejects and pending seed candidates, each run through the real Stage 3. Open it after every batch.

## Runtime

```js
import { loadCity, createCityRenderer } from './city-renderer.js';
const city = await loadCity('assets/city/');
const r = createCityRenderer(canvas, city, { resolve: id => save.buildings[id] /* {tier, producing} */ });
r.draw({ camX, camY, hour });
```

Draw order is ground, then objects in painter's order, then one time-of-day multiply, then window glow on producing buildings. The glow comes from recolouring window-glass palette pixels in code. Nothing about lighting is baked into sprites.

## Status

These notes cover build-order steps 1–5, based on testing in this pass.

- **Ground.** Guide images and init images did not work for ground. PixelLab returned either the flat guide or nothing, and when conditioned on the reference tile it returned mostly pavement. Ground tiles are now generated as isometric slabs. Stage 3 fits each slab's top face onto the exact diamond, the same code path as the reference tile.
- **Roads.** Road tiles are the weakest art. They read as striped paving rather than asphalt. They need prompt or seed work before step 6.
- **Roofs are rooftop props, not full roof caps.** Generated base widths vary (about 90–110 px on a 128 px 2×2 footprint), so one full-width roof sprite can't be shared across bases. Instead, bases carry their own roof and overlays sit on it: vents, a water tank. Those don't need matching widths.
- **Awning.** Every generation so far is a tiny shop, not an awning. It's processed but left out of the tier stacks. The wall-socket code is in place for when a usable one exists.
- **Reference tile.** `ref/base_tile.png` is candidate 3, auto-fitted but **not hand-cleaned yet**. It has some orange edge pixels. Clean it by hand, then regenerate the ground set.
