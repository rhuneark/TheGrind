// Projection math. Mirrors runtime/city-renderer.js — if you change one, change both.
const fs = require('fs');
const path = require('path');
const G = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'grid.json'), 'utf8'));
const { tileW, tileH } = G;

// Top vertex of cell (col, row).
const toScreen = (col, row) => ({ x: (col - row) * tileW / 2, y: (col + row) * tileH / 2 });

// Bottom vertex of a footprint = bottom vertex of its front-most tile. This is
// where every sprite's anchor lands.
function footprintBottom(col, row, [w, h]) {
  const s = toScreen(col + w - 1, row + h - 1);
  return { x: s.x, y: s.y + tileH };
}

// Screen-space geometry of a [w, h] footprint, relative to its bottom vertex.
const footprintWidth = ([w, h]) => (w + h) * tileW / 2;
const footprintHeight = ([w, h]) => (w + h) * tileH / 2;
const leftVertex = ([w]) => ({ x: -w * tileW / 2, y: -w * tileH / 2 });
const rightVertex = ([, h]) => ({ x: h * tileW / 2, y: -h * tileH / 2 });

// Painter's order. col + row alone breaks on multi-tile buildings.
const sortKey = o => (o.col + o.footprint[0] - 1) + (o.row + o.footprint[1] - 1);

module.exports = { ...G, toScreen, footprintBottom, footprintWidth, footprintHeight, leftVertex, rightVertex, sortKey };
