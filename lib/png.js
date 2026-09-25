const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const read = file => PNG.sync.read(fs.readFileSync(file));
const fromBuffer = buf => PNG.sync.read(buf);
const create = (w, h) => new PNG({ width: w, height: h }); // zero-filled = transparent
function write(file, png) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
}
const toBuffer = png => PNG.sync.write(png);

// Copy src (or a sub-rect of it) into dst at (dx, dy). Straight copy, no blending.
function blit(src, dst, dx, dy, sx = 0, sy = 0, w = src.width, h = src.height) {
  for (let y = 0; y < h; y++) {
    const ty = dy + y; if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < w; x++) {
      const tx = dx + x; if (tx < 0 || tx >= dst.width) continue;
      const si = ((sy + y) * src.width + sx + x) * 4, di = (ty * dst.width + tx) * 4;
      src.data.copy(dst.data, di, si, si + 4);
    }
  }
}

// Alpha-over composite, for previews only (the atlas itself uses blit).
function over(src, dst, dx, dy) {
  for (let y = 0; y < src.height; y++) {
    const ty = dy + y; if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const tx = dx + x; if (tx < 0 || tx >= dst.width) continue;
      const si = (y * src.width + x) * 4, di = (ty * dst.width + tx) * 4;
      const a = src.data[si + 3] / 255; if (!a) continue;
      for (let c = 0; c < 3; c++) dst.data[di + c] = Math.round(src.data[si + c] * a + dst.data[di + c] * (1 - a));
      dst.data[di + 3] = Math.max(dst.data[di + 3], src.data[si + 3]);
    }
  }
}

module.exports = { read, fromBuffer, create, write, toBuffer, blit, over };
