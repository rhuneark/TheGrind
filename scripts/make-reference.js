#!/usr/bin/env node
// Build-order step 2 — the reference tile.
//
// Generates N candidate paving tiles, fits each one's top face onto the exact
// tileW x tileH diamond, and writes them to ref/candidates/. A human then picks
// one, cleans it by hand, and saves it as ref/base_tile.png. Every later ground
// generation uses that file as its init image.
//
//   node scripts/make-reference.js [count=4]
//   node scripts/make-reference.js --refit     # redo the fit only
const fs = require('fs');
const path = require('path');
const png = require('../lib/png');
const palette = require('../lib/palette');
const { fitTopFace } = require('../lib/ground');
const { post, b64, decode } = require('../lib/pixellab');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets.json'), 'utf8'));
const pal = palette.load(path.join(ROOT, manifest.defaults.palette));
const refAsset = manifest.assets.find(a => a.reference);
const count = +process.argv[2] || 4;

// Fit, then quantize so the candidate is already on-palette for hand cleaning.
function fit(img) {
  const out = fitTopFace(img);
  if (!out) return null;
  for (let i = 0; i < out.data.length; i += 4) {
    if (out.data[i + 3] < 128) { out.data.fill(0, i, i + 4); continue; }
    out.data.set([...pal.rgb[palette.nearest(pal.rgb, out.data.subarray(i, i + 3))], 255], i);
  }
  return out;
}

const dir = path.join(ROOT, 'ref', 'candidates');

if (process.argv[2] === "--refit") { // re-run the fit on existing raw_*.png, no generation
  for (const f of fs.readdirSync(dir).filter(f => f.startsWith('raw_'))) {
    const out = fit(png.read(path.join(dir, f)));
    if (out) png.write(path.join(dir, f.replace('raw_', 'candidate_')), out);
  }
  return;
}

(async () => {
  fs.mkdirSync(dir, { recursive: true });
  await Promise.all(Array.from({ length: count }, async (_, i) => {
    const res = await post('/create-image-pixflux', {
      description: `${manifest.defaults.style}, ${refAsset.prompt}`,
      image_size: { width: 64, height: 64 },
      isometric: true, no_background: true,
      outline: 'lineless', shading: 'flat shading',
      color_image: b64(palette.swatchPng(pal)),
      seed: i + 1,
    });
    const raw = png.fromBuffer(decode(res.image));
    png.write(path.join(dir, `raw_${i + 1}.png`), raw);
    const out = fit(raw);
    if (out) png.write(path.join(dir, `candidate_${i + 1}.png`), out);
    console.log(out ? `✓ candidate_${i + 1}` : `✗ seed ${i + 1}: empty`);
  }));
  console.log(`\nPick one, clean it by hand, save as ${manifest.reference}.`);
})().catch(e => { console.error(e); process.exit(1); });
