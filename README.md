# Grind City — asset pipeline

This repo builds the city art for RUN: a pixel-art downtown. PixelLab makes the individual building and prop sprites, and code does everything else.
RUN receives exactly three files, all in `dist/`:

| File | What it is |
|---|---|
| `dist/city.png` | One packed sprite atlas |
| `dist/atlas.json` | Frame rects, anchors, footprints, sockets, door side, tier stacks, rooftop kit, glass colours for lighting |
| `dist/map.json` | Ground grid plus object placements: category, footprint, which wall the door is on (`facing`), and for small movers a `nudge` within the tile. Never tier or ownership |

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
| People | PixelLab 8-direction characters; we keep the four diagonals, the four ways along an isometric street. Standard mode (1 generation) for one person on foot; pro mode (about 20) when there's a dog, kids, a bike or a scooter, which the standard template can't draw |
| Vehicles | PixelLab 8-direction objects made from our own car sprites (`reference`), plus a taxi and a van styled from them (`styleFrom`), so traffic and parked cars can face either way |
| Vacant lots | Composed in Stage 3: dirt ground plus the generated cones and barrier, one sprite per footprint (`atlas.lots`) |

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
  - Lots are also car parks, plazas and pocket parks, plus the occasional whole-block park or paved square.
  - Car parks are laid out like real ones: rows of perpendicular stalls with white dividers between them, a driving aisle, and every car centred in its stall and pointing the same way (`props.carAxis`).
  - Breathing room: `lots.gapChance` leaves a one-tile passage or garden between buildings, and `lots.openBackChance` turns the row behind the alley into a courtyard or car park. The assembler prints how much of the block interiors is built on (about a third by default).
  - Districts shift from towers, offices, hotels and civic buildings in the core to retail, shops and residential at the edges.
  - Street trees, lamps, hydrants and bins go only on the curbside row of the sidewalk, so doorways stay clear. Corners get traffic lights, and cells beside crosswalks stay clear.
  - Street parking: cars against the curb (`nudge`), facing the way their lane flows. Traffic keeps right, with a few moving cars, taxis and vans in the lanes, and none within a car length of a crosswalk. Car parks are now rare.
  - People walk along the sidewalks in both directions: on their own, with a dog, with kids, on a bike or a scooter. Some cross at crosswalks and some wander the plazas and parks. Café tables go outside coffee shops.
- **Human check, `contact-sheet.html`.** Shows every atlas sprite at 1× and 3×, grouped by category, with anchors and sockets you can toggle. Also lists rejects and pending seed candidates, each run through the real Stage 3.

## Map editor

`preview/editor.html` (run `npm run preview`, then open `/preview/editor.html`) and the published editor page let you:
- click to select anything, drag it to move it, or nudge it with the arrow keys;
- delete things, flip a building's door side, and toggle cones on coffee spots;
- add buildings and props from a palette.

Edits are saved per object in `edits.json` (`{ "edits": { "<objectId>": … } }`). `scripts/assemble.js` applies them after generating the map, so rebuilding with the same seed and settings keeps them. Any generated prop sitting where you placed something is removed. If you change the seed, edits that point at objects which no longer exist are reported and skipped. `--no-edits` builds without them.

On the published page, edits go to the page's shared storage; ask Claude to "apply the editor edits" and they're written to `edits.json` and rebuilt. Locally they're kept in the browser; **Save edits.json** downloads the file to drop into the repo.

## Building states and animations

**Wiring it into RUN:** see [`docs/RUN_INTEGRATION.md`](docs/RUN_INTEGRATION.md).

Coffee spots that start unbought are marked `startState: "vacant"` in `map.json`, so the handed-off map already shows their cones. There are 12 of them (`city.json → shops.vacantSpots`), taken only from coffee-shop lots (`category: "shop"`) that face a street, away from the map edge and spread apart. They're picked for being easy to see and click: the fewest taller buildings in front, corners preferred. Three coffee stands (`category: "stand"`, 1×1 kiosks) sit in a park and on plazas (`shops.coffeeStands`).

Whether a coffee spot is bought, and what's happening to it, is save-file state, so `map.json` never changes. `resolve(objectId)` returns `{ state, tier, producing, progress }`:

| `state` | What's drawn |
|---|---|
| `vacant` | An unbought spot (default for spots with `startState: "vacant"`): dirt, cones along the street edges, a barrier |
| `constructing` | Five frames: foundation, then the frame rising in scaffolding, topped out in bare concrete, cladding going on, and finished with a little dust. Pass `progress` (0–1) to drive it, or leave it out and it loops |
| `built` (default) | The building for its tier |
| `renovating` | The building with a four-frame dust loop around its base, up the facade and off the roof |

The construction and dust frames are drawn by the runtime from the actual building sprite, so every shop variant, tier and footprint gets a build-up that ends in exactly that building, with nothing extra in the atlas. `preview/frames.html` lays every frame out side by side. Pass `time` to `draw()` and keep redrawing while `r.animating()` is true.

## Runtime

```js
import { loadCity, createCityRenderer } from './city-renderer.js';
const city = await loadCity('assets/city/');
const r = createCityRenderer(canvas, city, { resolve: id => save.buildings[id] /* {tier, producing} */ });
r.draw({ camX, camY, hour });
```

For each building, the runtime takes the highest saved tier that has a base for its footprint. It picks a base whose door matches `facing`, choosing between variants by hashing the objectId. Flat roofs on 2×2 and larger get a piece of rooftop kit at the roof socket. Draw order is ground, then objects in painter's order, then a time-of-day multiply, then window glow on producing buildings. The glow comes from recolouring the palette's glass colours in code.

## UI kit

The idle-sim interface art lives in `ui/` and packs to two more files:

| File | What it is |
|---|---|
| `dist/ui.png` | 512×256 sheet: 20 icons, 12 barista portraits, 4 buttons, 2 panels, ribbon, tab, slot, notification badge |
| `dist/ui.json` | `frames[id] = {x, y, w, h, slice?}`; `slice` is `[top, right, bottom, left]` for nine-slice stretching |

`runtime/ui-kit.js` draws them: `icon(id, scale)`, `nineSlice(id, w, h, scale)`, `url(...)` for CSS backgrounds, and `progress(t, w, h, scale)`, which draws a pixel-exact bar in code. `preview/hud.html` is a playable mockup over the live city: top bar, tab bar, shop panel (buy, construction, hire staff, upgrade), welcome-back modal and toast.

```sh
node scripts/ui.js generate [--only id,...]   # PixelLab generate-ui-v2 → ui/candidates/<id>/NN.png
node scripts/ui.js pick icon_cash:00 worker_portraits:03:worker_01
node scripts/ui.js pack                       # ui/raw → dist/ui.png + dist/ui.json
```

Nine-slice insets live in `ui/slices.json`. `ui/fill.json` repaints panel faces that background removal ate, or that the generator painted as a fake transparency checkerboard. The badge is drawn in code so RUN can print any count on it. UI sprites keep their own colours and aren't snapped to the city palette, because snapping turned the green button grey.
