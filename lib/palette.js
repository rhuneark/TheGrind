const fs = require('fs');
const png = require('./png');

const hexToRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

function load(file) {
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { ...p, rgb: p.colors.map(hexToRgb) };
}

// "Redmean" weighted RGB distance — cheap, and much closer to perceived
// difference than plain Euclidean RGB for the muted browns/greens we use.
function nearest(rgb, [r, g, b]) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < rgb.length; i++) {
    const [pr, pg, pb] = rgb[i];
    const rm = (r + pr) / 2, dr = r - pr, dg = g - pg, db = b - pb;
    const d = (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// A 1-row PNG of the palette, sent to PixelLab as `color_image` (forced palette).
function swatchPng(pal) {
  const img = png.create(pal.rgb.length, 1);
  pal.rgb.forEach(([r, g, b], i) => img.data.set([r, g, b, 255], i * 4));
  return png.toBuffer(img);
}

module.exports = { load, nearest, swatchPng, hexToRgb };
