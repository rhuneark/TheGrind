# Grind City — asset pipeline

This repo builds the city art for RUN: a pixel-art downtown. PixelLab makes the individual building and prop sprites, and code does everything else.
RUN receives exactly three files, all in `dist/`:

| File | What it is |
|---|---|
| `dist/city.png` | One packed sprite atlas |
| `dist/atlas.json` | Frame rects, anchors, footprints, sockets, door side, tier stacks, rooftop kit, glass colours for lighting |
| `dist/map.json` | Ground grid plus object placements: category, footprint, and which wall the door is on (`facing`). Never tier |

`runtime/city-renderer.js` is the renderer RUN copies in. It has no knowledge of PixelLab.

## Locked constants

`grid.json` holds `tileW 64`, `tileH 32` (2:1 dimetric) and integer `scale 2`. `palette.json` holds 32 downtown colours: asphalt, concrete, limestone, dark brick, glass, steel and a few muted accents. The three sidewalk colours come from the hand-cleaned `ref/base_tile.png`.

```
screenX = (col - row) * tileW/2      screenY = (col + row) * tileH/2
anchor  = the sprite point that lands on the footprint's bottom vertex
order   = ascending (col + w - 1) + (row + h - 1)
facing  = "left"  → door on the +row wall (lower-left on screen)
          "right" → door on the +col wall (lower-right on screen)
```

## Running it

```sh
npm install
npm run generate                                  # every asset in assets.json missing from raw/
npm run generate -- --only id1,id2 --candidates 3 # try seeds → candidates/, reviewed on the contact sheet
node scripts/generate.js --adopt id:<seed>        # pin that seed in assets.json, move it to raw/
npm run build                                     # process → pack → assemble → contact sheet
npm run preview                                   # http://localhost:8080/preview/
```

Set `PIXELLAB_TOKEN`. Node's `fetch` needs `NODE_USE_ENV_PROXY=1` behind a proxy; the npm scripts set it.

## Where each sprite comes from

| | How it's made |
|---|---|
| Sidewalk | `ref/base_tile.png`, hand-cleaned. Stage 3 snaps it to the exact diamond so it tiles seamlessly |
| Roads | **Drawn in code** (`lib/roads.js`): asphalt, dashed yellow centre lines, double yellow and dashed white on 4-lane avenues, curbs, zebra crosswalks, parking stalls, junctions. 43 tiles. Lane lines have to meet exactly at tile edges, and a generator can't know where those edges are |
| Grass | PixelLab, top face fitted to the diamond |
| Buildings, props, rooftop kit | PixelLab `create-image-pixflux`, forced palette, short prompts. Bitforge came out worse and caps canvas height at 200px |

Every building is mirrored automatically, which swaps its two visible walls. That gives a right-door variant of each left-door building for free. Sprites with legible lettering set `"mirror": false`, because mirrored text reads backwards.

## Stages

- **Stage 3, `scripts/process.js`.** For every sprite:
  - quantize to the palette and remove stray specks;
  - trim, then check that it's a real isometric building: it comes to a point at the bottom, the front corner is where the footprint needs it, and it fills 78–100% of the lot width;
  - compute the anchor and the roof socket, then re-pad to multiples of 32×16.
  
  Failures go to `rejected/` with a reason. Don't hand-fix them; pick another seed.
- **Stage 4, `scripts/pack.js`.** Packs `dist/city.png` and `dist/atlas.json`. Tier stacks are built from each building's `category` and `tier` tags. The pack reports any category that's missing a door side.
- **Stage 5, `scripts/assemble.js`.** Builds `dist/map.json` from `city.json`, laid out like a real downtown:
  - North–south streets are unevenly spaced, some are 4-lane avenues, and some stop at a cross avenue, so block lengths vary a lot.
  - Cross streets are placed per strip, so they jog and form T-junctions.
  - Every block has a 2-tile sidewalk ring, then a row of lots facing the street, a service alley, and a row of lots facing the alley.
  - Buildings share side walls, but **every door faces open ground**: a street sidewalk, the alley, or the side street for corner buildings that turn. The assembler fails the build if any door wall touches another building.
  - Lots are also parking lots (with cars), plazas and pocket parks, plus the occasional whole-block park.
  - Districts shift from towers, offices, hotels and civic buildings in the core to retail, shops and residential at the edges.
  - Street trees, lamps, hydrants and bins go only on the curbside row of the sidewalk, and never at corners, so doorways and crosswalks stay clear.
- **Human check, `contact-sheet.html`.** Shows every atlas sprite at 1× and 3×, grouped by category, with anchors and sockets you can toggle. Also lists rejects and pending seed candidates, each run through the real Stage 3.

## Runtime

```js
import { loadCity, createCityRenderer } from './city-renderer.js';
const city = await loadCity('assets/city/');
const r = createCityRenderer(canvas, city, { resolve: id => save.buildings[id] /* {tier, producing} */ });
r.draw({ camX, camY, hour });
```

For each building, the runtime takes the highest saved tier that has a base for its footprint. It picks a base whose door matches `facing`, choosing between variants by hashing the objectId. Flat roofs on 2×2 and larger get a piece of rooftop kit at the roof socket. Draw order is ground, then objects in painter's order, then a time-of-day multiply, then window glow on producing buildings. The glow comes from recolouring the palette's glass colours in code.
