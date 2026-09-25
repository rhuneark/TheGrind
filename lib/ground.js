// Ground-tile geometry shared by make-reference.js and process.js.
const png = require('./png');
const { tileW, tileH } = require('./grid');

const inDiamond = (x, y) => Math.abs((x + 0.5) / (tileW / 2) - 1) + Math.abs((y + 0.5) / (tileH / 2) - 1) <= 1;

// Generated iso tiles come back as a slab: a top-face diamond with a strip of
// side wall underneath, at whatever size the model felt like. Keep the top
// face and fit it (nearest-neighbour) onto the exact grid diamond.
function fitTopFace(img) {
  const A = (x, y) => img.data[(y * img.width + x) * 4 + 3] >= 128;
  let x0 = img.width, x1 = -1, y0 = img.height;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++)
    if (A(x, y)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); }
  if (x1 < 0) return null;
  // The top face ends where the silhouette is widest (the left/right vertex);
  // everything below that is side wall.
  let yl = y0;
  for (let y = y0; y < img.height; y++) if (A(x0, y)) { yl = y; break; }
  const cw = x1 - x0 + 1, ch = Math.max(2, 2 * (yl - y0) + 1);
  const out = png.create(tileW, tileH);
  for (let y = 0; y < tileH; y++) for (let x = 0; x < tileW; x++) {
    if (!inDiamond(x, y)) continue;
    const sx = Math.min(img.width - 1, x0 + Math.floor((x + 0.5) * cw / tileW));
    const sy = Math.min(img.height - 1, y0 + Math.floor((y + 0.5) * ch / tileH));
    img.data.copy(out.data, (y * tileW + x) * 4, (sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4);
  }
  return out;
}

module.exports = { inDiamond, fitTopFace };
