#!/usr/bin/env node
// Stage 4 — atlas packer. processed/*.png → dist/city.png + dist/atlas.json.
// Shelf packing, tallest first. Sprites are copied, never resampled.
const fs = require('fs');
const path = require('path');
const png = require('../lib/png');
const grid = require('../lib/grid');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets.json'), 'utf8'));
const PROC = path.join(ROOT, 'processed'), DIST = path.join(ROOT, 'dist');
const PAD = 2;
const ATLAS_W = 512;

const sprites = manifest.assets
  .filter(a => fs.existsSync(path.join(PROC, `${a.id}.json`)))
  .map(a => ({ meta: JSON.parse(fs.readFileSync(path.join(PROC, `${a.id}.json`), 'utf8')), img: png.read(path.join(PROC, `${a.id}.png`)) }));

// Shelf pack, tallest first, stable by id for deterministic output.
const order = [...sprites].sort((a, b) => b.img.height - a.img.height || a.meta.id.localeCompare(b.meta.id));
let x = PAD, y = PAD, shelfH = 0;
for (const s of order) {
  if (s.img.width + 2 * PAD > ATLAS_W) throw new Error(`${s.meta.id} is wider than the atlas`);
  if (x + s.img.width + PAD > ATLAS_W) { x = PAD; y += shelfH + PAD; shelfH = 0; }
  s.x = x; s.y = y; x += s.img.width + PAD; shelfH = Math.max(shelfH, s.img.height);
}
let H = y + shelfH + PAD;
H = 2 ** Math.ceil(Math.log2(H)); // power-of-two height keeps older GPUs happy

const atlasImg = png.create(ATLAS_W, H);
const frames = {};
for (const s of sprites) { // manifest order in the JSON, packed order in the image
  png.blit(s.img, atlasImg, s.x, s.y);
  const m = s.meta;
  frames[m.id] = {
    x: s.x, y: s.y, w: m.w, h: m.h, anchorX: m.anchorX, anchorY: m.anchorY,
    footprint: m.footprint, type: m.type,
    ...(m.sockets && { sockets: m.sockets }), ...(m.attach && { attach: m.attach }),
  };
}

// Tier → layer stacks. Art data, so it ships with the atlas; tier itself
// lives in RUN's save file. Variants that didn't make it through Stage 3 are
// dropped; a layer with no surviving variants drops its whole tier.
const stacks = {}, problems = [];
for (const [category, tiers] of Object.entries(manifest.stacks || {})) {
  for (const [tier, layers] of Object.entries(tiers)) {
    const kept = layers.map(vs => vs.filter(id => frames[id]));
    const missing = layers.flat().filter(id => !frames[id]);
    if (missing.length) problems.push(`${category} tier ${tier}: missing ${missing.join(', ')}`);
    if (kept.some(vs => !vs.length)) { problems.push(`${category} tier ${tier}: dropped (a layer has no sprites)`); continue; }
    const bad = kept.slice(1).flat().filter(id => !frames[kept[0][0]].sockets?.[frames[id].attach]);
    if (bad.length) { problems.push(`${category} tier ${tier}: base has no socket for ${bad.join(', ')}`); continue; }
    (stacks[category] ||= {})[tier] = kept;
  }
}

fs.mkdirSync(DIST, { recursive: true });
png.write(path.join(DIST, 'city.png'), atlasImg);
// Which palette colours are window glass, so RUN can light them in code.
const pal = JSON.parse(fs.readFileSync(path.join(ROOT, manifest.defaults.palette), 'utf8'));
const lighting = { glass: pal.glass || [], glow: pal.glow };
const atlas = { image: 'city.png', tileW: grid.tileW, tileH: grid.tileH, frames, stacks, lighting };
fs.writeFileSync(path.join(DIST, 'atlas.json'), JSON.stringify(atlas, null, 2) + '\n');
console.log(`packed ${sprites.length} sprites into ${ATLAS_W}x${H}`);
for (const p of problems) console.log(`  ! ${p}`);
