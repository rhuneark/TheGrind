#!/usr/bin/env node
// Stage 5 — map assembly. chunks.json → dist/map.json.
// Every chunk is cellSize with roads entering at the same edge cells, so any
// chunk joins any other with no alignment logic. The map records only that a
// building exists at a position; tier lives in RUN's save file.
//
//   node scripts/assemble.js [--chunks 8x8] [--seed 1]
const fs = require('fs');
const path = require('path');
const grid = require('../lib/grid');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const [chunksX, chunksY] = arg('--chunks', '8x8').split('x').map(Number);
const seed = +arg('--seed', 1);

const chunks = JSON.parse(fs.readFileSync(path.join(ROOT, 'chunks.json'), 'utf8'));
const atlas = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'atlas.json'), 'utf8'));
const [cw, ch] = chunks.cellSize;

// mulberry32 — small, seedable, and the same on every machine.
let s = seed >>> 0;
const rand = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = arr => arr[Math.floor(rand() * arr.length)];

const errors = [];
for (const t of chunks.templates) {
  if (JSON.stringify(t.connectors) !== JSON.stringify(chunks.connectors)) errors.push(`${t.id}: connectors differ from the shared set`);
  if (t.ground.length !== ch || t.ground.some(r => r.length !== cw)) errors.push(`${t.id}: ground is not ${cw}x${ch}`);
  for (const g of t.ground.flat()) if (!atlas.frames[g]) errors.push(`${t.id}: ground sprite ${g} is not in the atlas`);
  for (const p of t.props || []) for (const sp of p.sprite) if (!atlas.frames[sp]) errors.push(`${t.id}: prop sprite ${sp} is not in the atlas`);
  for (const sl of t.slots) if (!atlas.stacks[sl.category]) errors.push(`${t.id}: no stacks for category ${sl.category}`);
}
if (errors.length) { [...new Set(errors)].forEach(e => console.error(`✗ ${e}`)); process.exit(1); }

const totalW = chunks.templates.reduce((a, t) => a + (t.weight || 1), 0);
const pickTemplate = () => { let r = rand() * totalW; for (const t of chunks.templates) if ((r -= t.weight || 1) < 0) return t; };

const cols = chunksX * cw, rows = chunksY * ch;
const ground = Array.from({ length: rows }, () => Array(cols));
const objects = [], counters = {}, layout = [];
const nextId = prefix => `${prefix}_${String((counters[prefix] = (counters[prefix] || 0) + 1)).padStart(3, '0')}`;

for (let cy = 0; cy < chunksY; cy++) for (let cx = 0; cx < chunksX; cx++) {
  const t = pickTemplate();
  layout.push(t.id);
  const oc = cx * cw, or = cy * ch;
  t.ground.forEach((row, r) => row.forEach((g, c) => { ground[or + r][oc + c] = g; }));
  for (const sl of t.slots) objects.push({ objectId: nextId(sl.category), col: oc + sl.col, row: or + sl.row, footprint: sl.footprint, category: sl.category });
  for (const p of t.props || []) {
    const sprite = pick(p.sprite);
    objects.push({ objectId: nextId(sprite.replace(/^prop_/, '').split('_')[0]), col: oc + p.col, row: or + p.row, footprint: atlas.frames[sprite].footprint || [1, 1], sprite });
  }
}

// Painter's order: ascending front-most cell. Pre-sorted so RUN can draw
// straight through the list (it still re-sorts if objects move).
objects.sort((a, b) => grid.sortKey(a) - grid.sortKey(b) || a.col - b.col);

// Nothing may overlap.
const occ = new Map();
for (const o of objects) for (let dc = 0; dc < o.footprint[0]; dc++) for (let dr = 0; dr < o.footprint[1]; dr++) {
  const k = `${o.col + dc},${o.row + dr}`;
  if (occ.has(k)) { console.error(`✗ ${o.objectId} overlaps ${occ.get(k)} at ${k}`); process.exit(1); }
  occ.set(k, o.objectId);
}

const map = { tileW: grid.tileW, tileH: grid.tileH, size: { cols, rows }, seed, chunks: { cellSize: chunks.cellSize, layout: Array.from({ length: chunksY }, (_, y) => layout.slice(y * chunksX, (y + 1) * chunksX)) }, ground, objects };
fs.writeFileSync(path.join(ROOT, 'dist', 'map.json'), JSON.stringify(map) + '\n');
console.log(`map ${cols}x${rows}: ${objects.length} objects (${Object.entries(counters).map(([k, v]) => `${v} ${k}`).join(', ')})`);
