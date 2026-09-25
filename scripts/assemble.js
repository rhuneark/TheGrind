#!/usr/bin/env node
// Stage 5 — map assembly. city.json + dist/atlas.json → dist/map.json.
//
// Lays out a downtown the way real ones grow:
//   - north–south streets run the full map at uneven spacing, some of them
//     four-lane avenues;
//   - cross streets are placed per strip, so they don't line up from one strip
//     to the next (T-junctions, blocks of different lengths), plus one or more
//     full-width cross avenues;
//   - every block gets a sidewalk ring, then one or two rows of lots split by
//     a service alley;
//   - every building's door wall faces open ground — a street sidewalk, the
//     alley, or (for corner lots) the side street. Buildings share party walls
//     sideways, the way downtown frontages do, but never put a door against
//     another building.
// The map records that a building exists (category, footprint, which wall
// its door is on). Tier lives in RUN's save file.
//
//   node scripts/assemble.js [--seed 7] [--size 80x80]
const fs = require('fs');
const path = require('path');
const grid = require('../lib/grid');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'city.json'), 'utf8'));
const atlas = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'atlas.json'), 'utf8'));
const [cols, rows] = arg('--size', cfg.size.join('x')).split('x').map(Number);
const seed = +arg('--seed', cfg.seed);
const SW = cfg.sidewalk;

// mulberry32 — small, seedable, identical on every machine.
let s = seed >>> 0;
const rand = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const randInt = ([a, b]) => a + Math.floor(rand() * (b - a + 1));
const pick = arr => arr[Math.floor(rand() * arr.length)];
function weighted(weights) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  let r = rand() * entries.reduce((a, [, w]) => a + w, 0);
  for (const [k, w] of entries) if ((r -= w) < 0) return k;
  return entries.length ? entries[entries.length - 1][0] : null;
}

// ---------------------------------------------------------------- streets
const kind = Array.from({ length: rows }, () => Array(cols).fill(null));
const lane = Array.from({ length: rows }, () => Array(cols).fill(null));
const inMap = (r, c) => r >= 0 && c >= 0 && r < rows && c < cols;
const isRoad = (r, c) => inMap(r, c) && (kind[r][c] === 'road' || kind[r][c] === 'junction');

// Cross avenues first (full width), since they split the map into row
// segments that north–south streets may or may not cross.
const cross = [];
for (let k = 0; k < cfg.streets.crossAvenues; k++) {
  const r0 = Math.round(rows * (k + 1) / (cfg.streets.crossAvenues + 1)) + randInt([-4, 4]);
  cross.push({ r0, w: 4 });
}
cross.sort((x, y) => x.r0 - y.r0);
const segments = [];
{
  let start = 0;
  for (const a of cross) { segments.push([start, a.r0 - 1]); start = a.r0 + a.w; }
  segments.push([start, rows - 1]);
}

// North–south streets (they run along the row axis) at uneven spacing. Some
// two-lane streets stop at a cross avenue instead of running the full map,
// which merges the blocks on either side into one long block.
const ns = [];
for (let c = randInt([4, 9]); c < cols - 4;) {
  const w = rand() < cfg.streets.avenueChance ? 4 : 2;
  let segs = segments.map((_, i) => i);
  if (w === 2 && segments.length > 1 && rand() < cfg.streets.partialStreetChance) segs = segs.filter(i => i !== Math.floor(rand() * segments.length));
  ns.push({ c0: c, w, segs });
  c += w + randInt(cfg.streets.blockLength);
}
const nsRows = n => {
  const out = new Set();
  n.segs.forEach(i => { for (let r = segments[i][0]; r <= segments[i][1]; r++) out.add(r); });
  // ...plus the avenue rows it meets, so it joins the avenue at a junction.
  for (const a of cross) if (n.segs.some(i => segments[i][1] + 1 === a.r0 || segments[i][0] - a.w === a.r0))
    for (let r = a.r0; r < a.r0 + a.w; r++) out.add(r);
  return out;
};
for (const n of ns) for (const r of nsRows(n)) for (let i = 0; i < n.w; i++) {
  kind[r][n.c0 + i] = 'road'; lane[r][n.c0 + i] = { axis: 'ns', i, w: n.w };
}
for (const a of cross) for (let c = 0; c < cols; c++) for (let i = 0; i < a.w; i++) {
  const r = a.r0 + i;
  if (kind[r][c] === 'road') kind[r][c] = 'junction';
  else { kind[r][c] = 'road'; lane[r][c] = { axis: 'ew', i, w: a.w }; }
}

// Column strips between the north–south streets, per row segment (a street
// that skips a segment leaves one wide strip there).
function stripsIn(seg) {
  const out = [];
  let start = 0;
  for (const n of ns.filter(n => n.segs.includes(seg))) { if (n.c0 > start) out.push([start, n.c0 - 1]); start = n.c0 + n.w; }
  if (start < cols) out.push([start, cols - 1]);
  return out;
}

const depth = () => randInt(rand() < cfg.streets.shallowBlockChance ? cfg.streets.shallowDepth : cfg.streets.blockDepth);
const blocks = [];
for (const [seg, [t0, t1]] of segments.entries()) for (const [s0, s1] of stripsIn(seg)) {
  // Cross streets for this strip only — so they jog from strip to strip.
  const cuts = [];
  let r = t0 + (t0 === 0 ? randInt([4, 9]) : depth());
  while (r + 2 + cfg.streets.shallowDepth[0] <= t1 + 1) { cuts.push(r); r += 2 + depth(); }
  for (const r0 of cuts) {
    for (let c = s0; c <= s1; c++) for (let i = 0; i < 2; i++) { kind[r0 + i][c] = 'road'; lane[r0 + i][c] = { axis: 'ew', i, w: 2 }; }
    // Where it meets a north–south street, those cells become a T-junction.
    for (const edge of [s0 - 1, s1 + 1]) {
      if (!isRoad(r0, edge)) continue;
      const n = ns.find(n => edge >= n.c0 && edge < n.c0 + n.w);
      for (let i = 0; i < 2; i++) for (let j = 0; j < n.w; j++) kind[r0 + i][n.c0 + j] = 'junction';
    }
  }
  let top = t0;
  for (const r0 of [...cuts, t1 + 1]) { if (r0 - 1 >= top) blocks.push({ c0: s0, c1: s1, r0: top, r1: r0 - 1 }); top = r0 + 2; }
}

// ---------------------------------------------------------------- lots
const objects = [];
const occupied = new Map();
const counters = {};
const nextId = prefix => `${prefix}_${String((counters[prefix] = (counters[prefix] || 0) + 1)).padStart(3, '0')}`;
function place(o) {
  for (let dc = 0; dc < o.footprint[0]; dc++) for (let dr = 0; dr < o.footprint[1]; dr++) {
    const k = `${o.col + dc},${o.row + dr}`;
    if (occupied.has(k)) throw new Error(`${o.objectId} overlaps ${occupied.get(k)} at ${k}`);
    occupied.set(k, o.objectId);
  }
  objects.push(o);
}
const free = (r, c) => !occupied.has(`${c},${r}`);
function prop(r, c, sprite) {
  if (!atlas.frames[sprite] || !free(r, c)) return;
  place({ objectId: nextId(sprite.replace(/^prop_/, '').replace(/_m$/, '').replace(/_[a-z]$/, '')), col: c, row: r, footprint: [1, 1], sprite });
}

// Which categories can fill a k x k lot, from what actually made it into the atlas.
const avail = {};
for (const [cat, tiers] of Object.entries(atlas.stacks)) for (const [bases] of Object.values(tiers))
  for (const id of bases) (avail[cat] ||= new Set()).add(atlas.frames[id].footprint[0]);
const cars = Object.keys(atlas.frames).filter(id => id.startsWith('prop_car_'));

function district(r, c) {
  const d = Math.hypot((c - cols / 2) / (cols / 2), (r - rows / 2) / (rows / 2));
  return Object.values(cfg.districts).find(x => d < x.radius);
}

function chooseBuilding(r, c, maxK, facesAlley) {
  const weights = district(r, c).weights;
  const fpWeights = Object.fromEntries(Object.entries(cfg.lots.footprint).filter(([k]) => +k <= maxK));
  for (let tries = 0; tries < 6; tries++) {
    const k = +weighted(fpWeights);
    const cats = Object.fromEntries(Object.entries(weights).filter(([cat]) =>
      avail[cat]?.has(k) && (!facesAlley || cfg.alleyCategories.includes(cat))));
    const cat = weighted(cats);
    if (cat) return { k, category: cat };
  }
  return null;
}

const setKind = (r, c, k) => { if (inMap(r, c) && kind[r][c] === null) kind[r][c] = k; };

function fillSpecial(type, r0, r1, c0, c1) {
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    kind[r][c] = type === 'parking' ? 'parking' : type === 'plaza' ? 'plaza' : 'grass';
    if (type === 'parking' && cars.length && rand() < cfg.props.carChance) prop(r, c, pick(cars));
    if (type === 'plaza') { const x = rand(); if (x < 0.15) prop(r, c, 'prop_street_tree'); else if (x < 0.25) prop(r, c, 'prop_bench'); else if (x < 0.3) prop(r, c, 'prop_lamp'); }
    if (type === 'pocketPark') { const x = rand(); if (x < 0.35) prop(r, c, 'prop_park_tree'); else if (x < 0.45) prop(r, c, 'prop_bench'); }
  }
}

// One row of lots. Doors go on the +row wall (the "left" face on screen),
// which by construction faces the street sidewalk or the alley.
function fillStrip(rTop, rFront, c0, c1, facesAlley, cornerOnRight) {
  const d = rFront - rTop + 1;
  for (let c = c0; c <= c1;) {
    const remaining = c1 - c + 1;
    // cfg.lots.special holds absolute per-lot chances.
    let x = rand(), special = null;
    for (const [k, p] of Object.entries(cfg.lots.special)) if ((x -= p) < 0) { special = k; break; }
    if (special && remaining >= 2) {
      const w = Math.min(remaining, special === 'parking' ? randInt([3, 6]) : randInt([2, 4]));
      fillSpecial(special, rTop, rFront, c, c + w - 1);
      c += w;
      continue;
    }
    const b = chooseBuilding(rFront, c, Math.min(d, remaining), facesAlley);
    if (!b) { fillSpecial('plaza', rTop, rFront, c, c); c++; continue; }
    const row = rFront - b.k + 1;
    // A corner building may turn to face the side street instead.
    const facing = cornerOnRight && c + b.k - 1 === c1 && !facesAlley && rand() < cfg.lots.cornerTurnChance ? 'right' : 'left';
    place({ objectId: nextId(b.category), col: c, row, footprint: [b.k, b.k], category: b.category, facing });
    const yard = rand() < 0.25 ? 'grass' : 'yard';
    for (let r = rTop; r < row; r++) for (let cc = c; cc < c + b.k; cc++) kind[r][cc] = yard;
    for (let r = row; r <= rFront; r++) for (let cc = c; cc < c + b.k; cc++) kind[r][cc] = 'lot';
    c += b.k;
  }
}

for (const bl of blocks) {
  const road = { top: isRoad(bl.r0 - 1, bl.c0), bottom: isRoad(bl.r1 + 1, bl.c0), left: isRoad(bl.r0, bl.c0 - 1), right: isRoad(bl.r0, bl.c1 + 1) };
  const ic0 = bl.c0 + (road.left ? SW : 0), ic1 = bl.c1 - (road.right ? SW : 0);
  const ir0 = bl.r0 + (road.top ? SW : 0), ir1 = bl.r1 - (road.bottom ? SW : 0);
  for (let r = bl.r0; r <= bl.r1; r++) for (let c = bl.c0; c <= bl.c1; c++)
    if (r < ir0 || r > ir1 || c < ic0 || c > ic1) kind[r][c] = 'sidewalk';
  const W = ic1 - ic0 + 1, H = ir1 - ir0 + 1;
  if (W < 2 || H < 2) { for (let r = ir0; r <= ir1; r++) for (let c = ic0; c <= ic1; c++) kind[r][c] = 'plaza'; continue; }
  if (rand() < cfg.lots.parkBlockChance) {
    for (let r = ir0; r <= ir1; r++) for (let c = ic0; c <= ic1; c++) {
      kind[r][c] = 'grass';
      const x = rand(); if (x < 0.22) prop(r, c, 'prop_park_tree'); else if (x < 0.26) prop(r, c, 'prop_bench');
    }
    continue;
  }
  // Lot rows from the front (+row street) back: [front strip, alley, back strip],
  // anything left over at the back is a yard.
  const plan = H <= 3 ? [H] : H === 4 ? [2] : H === 5 ? [2, 'alley', 2] : H === 6 ? (rand() < 0.5 ? [3, 'alley', 2] : [2, 'alley', 3]) : [3, 'alley', 3];
  let r = ir1, first = true;
  for (const p of plan) {
    if (p === 'alley') { for (let c = ic0; c <= ic1; c++) kind[r][c] = 'alley'; r--; continue; }
    fillStrip(r - p + 1, r, ic0, ic1, !first, road.right);
    r -= p; first = false;
  }
  const back = rand() < 0.5 ? 'grass' : 'yard';
  for (; r >= ir0; r--) for (let c = ic0; c <= ic1; c++) kind[r][c] = back;
}

// ---------------------------------------------------------------- ground ids
const LANES = { 2: ['cy', 'yc'], 4: ['cw', 'wY', 'Yw', 'wc'] };
const curb = (r, c) => (inMap(r, c) && !isRoad(r, c) ? 'c' : 'n');
const ground = Array.from({ length: rows }, () => Array(cols));
for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
  const k = kind[r][c];
  let id;
  if (k === 'junction') id = `ground_junction_${curb(r, c - 1)}${curb(r, c + 1)}${curb(r - 1, c)}${curb(r + 1, c)}`;
  else if (k === 'road') {
    const l = lane[r][c];
    const nearJunction = l.axis === 'ns'
      ? [r - 1, r + 1].some(rr => inMap(rr, c) && kind[rr][c] === 'junction')
      : [c - 1, c + 1].some(cc => inMap(r, cc) && kind[r][cc] === 'junction');
    if (nearJunction) id = l.axis === 'ns' ? `ground_xwalk_ns_${curb(r, c - 1)}${curb(r, c + 1)}` : `ground_xwalk_ew_${curb(r - 1, c)}${curb(r + 1, c)}`;
    else id = `ground_road_${l.axis}_${LANES[l.w][l.i]}`;
  } else id = {
    alley: 'ground_road_ew_nn', parking: 'ground_parking_ns', grass: 'ground_grass_01',
  }[k] || 'ground_sidewalk_01';
  if (!atlas.frames[id]) { console.error(`✗ ground sprite ${id} (for ${k} at ${c},${r}) is not in the atlas`); process.exit(1); }
  ground[r][c] = id;
}

// ---------------------------------------------------------------- street furniture
// Only on the curbside row of the sidewalk, so doorways stay clear, and not
// at corners, so crosswalks stay clear.
for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
  if (kind[r][c] !== 'sidewalk' || !free(r, c)) continue;
  const nbr = [[0, -1], [0, 1], [-1, 0], [1, 0]].filter(([dr, dc]) => isRoad(r + dr, c + dc));
  if (nbr.length !== 1) continue;
  let corner = false;
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++)
    if (inMap(r + dr, c + dc) && (kind[r + dr][c + dc] === 'junction' || ground[r + dr][c + dc].startsWith('ground_xwalk'))) corner = true;
  const along = nbr[0][0] === 0 ? r : c; // position along the curb
  if (corner) { if (rand() < cfg.props.hydrantChance * 2) prop(r, c, 'prop_hydrant'); continue; }
  if (along % cfg.props.streetTreeEvery === 0) prop(r, c, 'prop_street_tree');
  else if (along % cfg.props.lampEvery === 2) prop(r, c, 'prop_lamp');
  else if (rand() < cfg.props.hydrantChance) prop(r, c, 'prop_hydrant');
  else if (rand() < cfg.props.trashChance) prop(r, c, 'prop_trashcan');
}

// Painter's order: ascending front-most cell. Pre-sorted so RUN can draw
// straight through the list (it still re-sorts if objects move).
objects.sort((a, b) => grid.sortKey(a) - grid.sortKey(b) || a.col - b.col);

// Door check: every building's door wall must face open ground.
const byId = new Map(objects.map(o => [o.objectId, o]));
let blocked = 0;
for (const o of objects) {
  if (!o.category) continue;
  const [w, h] = o.footprint;
  const cells = o.facing === 'left'
    ? Array.from({ length: w }, (_, i) => [o.row + h, o.col + i])
    : Array.from({ length: h }, (_, i) => [o.row + i, o.col + w]);
  if (cells.some(([r, c]) => inMap(r, c) && byId.get(occupied.get(`${c},${r}`))?.category)) {
    console.error(`✗ ${o.objectId}: door wall (${o.facing}) is against another building`); blocked++;
  }
}
if (blocked) process.exit(1);

const map = { tileW: grid.tileW, tileH: grid.tileH, size: { cols, rows }, seed, ground, objects };
fs.writeFileSync(path.join(ROOT, 'dist', 'map.json'), JSON.stringify(map) + '\n');
const cats = {};
for (const o of objects) { const k = o.category || 'prop'; cats[k] = (cats[k] || 0) + 1; }
console.log(`map ${cols}x${rows}: ${ns.length} N–S streets, ${blocks.length} blocks, ${objects.length} objects (${Object.entries(cats).map(([k, v]) => `${v} ${k}`).join(', ')})`);
