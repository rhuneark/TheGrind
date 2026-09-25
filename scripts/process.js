#!/usr/bin/env node
// Stage 3 — post-process. Runs on every raw generation, no exceptions:
//   1. quantize to palette.json    2. trim, recording the trim
//   3. verify against the grid     4. compute the anchor (and sockets)
//   5. write processed/<id>.png + processed/<id>.json
// Anything that fails verification goes to rejected/<id>.png with a reason.
// Don't hand-fix rejects into processed/ — change the prompt or seed and
// regenerate, or the next run silently loses the fix.
const fs = require('fs');
const path = require('path');
const png = require('../lib/png');
const palette = require('../lib/palette');
const grid = require('../lib/grid');
const { inDiamond, fitTopFace } = require('../lib/ground');
const roads = require('../lib/roads');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets.json'), 'utf8'));
const pal = palette.load(path.join(ROOT, manifest.defaults.palette));
const { tileW, tileH } = grid;
const OUT = path.join(ROOT, 'processed'), REJ = path.join(ROOT, 'rejected');

class Reject extends Error {}
const reject = msg => { throw new Reject(msg); };
const ceilTo = (v, m) => Math.ceil(v / m) * m;
const opaque = (img, x, y) => img.data[(y * img.width + x) * 4 + 3] !== 0;

// 1. Quantize: binary alpha, every visible pixel snapped to the palette.
function quantize(img) {
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) { d.fill(0, i, i + 4); continue; }
    const [r, g, b] = pal.rgb[palette.nearest(pal.rgb, d.subarray(i, i + 3))];
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
  }
}

// Pixflux only returns a transparent background up to 200x200; bigger
// canvases come back on a flat or speckled backdrop. Knock it out by flood
// filling from the border through the colours that dominate the border.
// Runs after quantize, so "colour" means palette entry.
function removeBackdrop(img) {
  const { width: W, height: H } = img, d = img.data;
  if (d[3] === 0 || d[(W * H - 1) * 4 + 3] === 0) return 0; // already transparent
  const key = p => (d[p * 4] << 16) | (d[p * 4 + 1] << 8) | d[p * 4 + 2];
  const border = [];
  for (let x = 0; x < W; x++) border.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y++) border.push(y * W, y * W + W - 1);
  const hist = new Map();
  for (const p of border) hist.set(key(p), (hist.get(key(p)) || 0) + 1);
  const bg = new Set([...hist].filter(([, n]) => n >= border.length * 0.03).map(([k]) => k));
  const seen = new Uint8Array(W * H), stack = border.filter(p => bg.has(key(p)));
  let removed = 0;
  for (const p of stack) seen[p] = 1;
  while (stack.length) {
    const p = stack.pop();
    d.fill(0, p * 4, p * 4 + 4); removed++;
    const x = p % W, y = (p / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, q = ny * W + nx;
      if (nx >= 0 && ny >= 0 && nx < W && ny < H && !seen[q] && d[q * 4 + 3] && bg.has(key(q))) { seen[q] = 1; stack.push(q); }
    }
  }
  return removed;
}

// Background removal leaves stray specks; drop components much smaller than
// the main body. Deterministic, so it's a pipeline step, not a hand fix.
function despeckle(img) {
  const { width: W, height: H } = img, seen = new Int32Array(W * H).fill(-1), sizes = [];
  for (let s = 0; s < W * H; s++) {
    if (seen[s] !== -1 || !img.data[s * 4 + 3]) continue;
    const id = sizes.length, stack = [s]; seen[s] = id; let n = 0;
    while (stack.length) {
      const p = stack.pop(); n++;
      const x = p % W, y = (p / W) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const nx = x + dx, ny = y + dy, q = ny * W + nx;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && seen[q] === -1 && img.data[q * 4 + 3]) { seen[q] = id; stack.push(q); }
      }
    }
    sizes.push(n);
  }
  const keep = Math.max(4, Math.max(0, ...sizes) * 0.02);
  let dropped = 0;
  for (let p = 0; p < W * H; p++) if (seen[p] !== -1 && sizes[seen[p]] < keep) { img.data.fill(0, p * 4, p * 4 + 4); dropped++; }
  return dropped;
}

function bounds(img) {
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++)
    if (opaque(img, x, y)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return x1 < 0 ? null : { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

const medianX = (img, y, b) => {
  const xs = []; for (let x = b.x0; x <= b.x1; x++) if (opaque(img, x, y)) xs.push(x);
  return xs[xs.length >> 1] + 0.5;
};

// Ground: exactly one tileW x tileH diamond, anchor at its bottom vertex.
// Larger raws are iso slabs; their top face is fitted onto the diamond first.
function processGround(img) {
  if (img.width !== tileW || img.height !== tileH) {
    img = fitTopFace(img);
    if (!img) reject('empty');
  }
  let inside = 0, covered = 0;
  for (let y = 0; y < tileH; y++) for (let x = 0; x < tileW; x++) {
    if (!inDiamond(x, y)) { img.data.fill(0, (y * tileW + x) * 4, (y * tileW + x) * 4 + 4); continue; }
    inside++; if (opaque(img, x, y)) covered++;
  }
  const coverage = covered / inside;
  if (coverage < 0.92) reject(`covers only ${(coverage * 100).toFixed(1)}% of the ground diamond (need 92%)`);
  // Fill the few remaining holes from the nearest filled neighbour.
  for (let pass = 0; pass < 8; pass++) for (let y = 0; y < tileH; y++) for (let x = 0; x < tileW; x++) {
    if (!inDiamond(x, y) || opaque(img, x, y)) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < tileW && ny < tileH && opaque(img, nx, ny)) { img.data.copy(img.data, (y * tileW + x) * 4, (ny * tileW + nx) * 4, (ny * tileW + nx) * 4 + 4); break; }
    }
  }
  return { img, anchorX: tileW / 2, anchorY: tileH, footprint: [1, 1], trim: { left: 0, top: 0, right: 0, bottom: 0 }, coverage: +coverage.toFixed(3) };
}

// Everything else: trim, verify, anchor, then re-pad to grid multiples.
function processSprite(asset, img) {
  const b = bounds(img);
  if (!b) reject('empty after quantize/despeckle');
  // Touching the top means cut off. Buildings generated at footprint width
  // legitimately fill the canvas sideways; the front-corner check below
  // catches the ones that are actually cropped.
  if (b.y0 === 0 && asset.type !== 'lot') reject('content touches the top of the canvas — probably cropped');
  if (asset.type !== 'building' && asset.type !== 'lot' && (b.x0 === 0 || b.x1 === img.width - 1)) reject('content touches the canvas edge — probably cropped');
  const footprint = asset.compose?.footprint || asset.footprint || [1, 1];
  const fw = grid.footprintWidth(footprint);
  const by = b.y1 + 1; // content bottom, in pixel-edge coordinates
  let ax, ay, extraBottom = 0; const sockets = {};

  if (asset.type === 'building') {
    // Downtown buildings stand shoulder to shoulder, so a base has to fill
    // most of its lot or the street wall shows gaps.
    if (b.w > fw + 12) reject(`${b.w}px wide — overhangs its ${footprint.join('x')} footprint (${fw}px)`);
    if (b.w < fw * 0.78) reject(`${b.w}px wide — too narrow for its ${footprint.join('x')} footprint (${fw}px, need ≥78%)`);
    // The lowest row of an iso box is its front corner: the footprint's bottom vertex.
    ax = medianX(img, b.y1, b); ay = by;
    // An iso box (or its forecourt plate) comes to a point at the bottom; a
    // flat front elevation has a full-width bottom edge.
    let bottomSpan = 0;
    for (let x = b.x0; x <= b.x1; x++) if (opaque(img, x, b.y1)) bottomSpan++;
    if (bottomSpan > b.w * 0.4) reject(`bottom edge is ${bottomSpan}px wide — a flat front view, not an isometric building`);
    const expected = b.x0 + b.w * footprint[0] / (footprint[0] + footprint[1]);
    if (Math.abs(ax - expected) > b.w * 0.12) reject(`front corner at x=${ax.toFixed(0)}, expected ≈${expected.toFixed(0)} — not a clean ${footprint.join('x')} iso box`);
    // Roof socket = centre of the top face. Measure the roof, not the whole
    // silhouette (which includes any forecourt plate): the widest row in the
    // top third is the roof's left/right vertices, and the face centre sits
    // level with them.
    let roofRow = b.y0, roofW = 0, roofX0 = b.x0;
    for (let y = b.y0; y < b.y0 + b.h / 3; y++) {
      let x0 = -1, x1 = -1;
      for (let x = b.x0; x <= b.x1; x++) if (opaque(img, x, y)) { if (x0 < 0) x0 = x; x1 = x; }
      if (x0 >= 0 && x1 - x0 + 1 > roofW) { roofW = x1 - x0 + 1; roofRow = y; roofX0 = x0; }
    }
    sockets.roof = [roofX0 + roofW / 2, roofRow];
    for (const [name, s] of Object.entries(asset.sockets || {})) {
      if (s.wall !== 'right') reject(`socket ${name}: only right-wall sockets are supported`);
      let yR = b.y1; while (yR > b.y0 && !opaque(img, b.x1, yR)) yR--;
      sockets[name] = [(ax + b.x1 + 1) / 2, (by + yR + 1) / 2 - s.height];
    }
  } else if (asset.type === 'overlay') {
    // Centre of the overlay's own base diamond (or, for a wall band, the
    // midpoint of its lower edge — same point for a 2:1 slope).
    ax = b.x0 + b.w / 2; ay = by - b.w / 4;
  } else if (asset.type === 'prop') {
    if (b.w > fw) reject(`${b.w}px wide — wider than its ${footprint.join('x')} footprint`);
    // Props stand on the tile centre, which is tileH/2 above the bottom vertex.
    // Posts and trees stand on their lowest point; a vehicle is centred on its
    // footprint (a 2:1 diamond as wide as the sprite), so it sits mid-stall.
    ax = asset.anchor === 'centre' ? b.x0 + b.w / 2 : medianX(img, b.y1, b);
    ay = (asset.anchor === 'centre' ? by - b.w / 4 : by) + tileH / 2;
    extraBottom = Math.max(0, Math.ceil(ay - by));
  } else if (asset.type === 'lot') {
    // Composed on an exact footprint canvas: the bottom vertex sits at
    // (w * tileW/2, canvas bottom) by construction.
    ax = footprint[0] * tileW / 2; ay = img.height;
    const out = png.create(img.width, img.height);
    png.blit(img, out, 0, 0);
    return { img: out, anchorX: ax, anchorY: ay, footprint, trim: { left: 0, top: 0, right: 0, bottom: 0 } };
  } else reject(`unknown type ${asset.type}`);

  // Re-pad: content bottom-aligned (plus any below-content anchor room),
  // horizontally centred, canvas rounded up to half-tile multiples.
  const W = ceilTo(b.w, tileW / 2), H = ceilTo(b.h + extraBottom, tileH / 2);
  const ox = Math.floor((W - b.w) / 2), oy = H - extraBottom - b.h;
  const out = png.create(W, H);
  png.blit(img, out, ox, oy, b.x0, b.y0, b.w, b.h);
  const shift = ([x, y]) => [Math.round(x - b.x0 + ox), Math.round(y - b.y0 + oy)];
  const [anchorX, anchorY] = shift([ax, ay]);
  for (const k of Object.keys(sockets)) sockets[k] = shift(sockets[k]);
  return {
    img: out, anchorX, anchorY, footprint, sockets: Object.keys(sockets).length ? sockets : undefined,
    trim: { left: b.x0, top: b.y0, right: img.width - 1 - b.x1, bottom: img.height - 1 - b.y1 },
  };
}

// 3. Verify — whatever path produced it, the result must sit on the grid.
function verify(r) {
  if (r.img.width % (tileW / 2) || r.img.height % (tileH / 2)) reject(`${r.img.width}x${r.img.height} is not a multiple of ${tileW / 2}x${tileH / 2}`);
  if (r.anchorX < 0 || r.anchorX > r.img.width || r.anchorY < 0 || r.anchorY > r.img.height) reject('anchor outside sprite');
}

// The whole per-sprite pipeline. Mutates img. Throws Reject on failure.
function run(asset, img) {
  if (asset.derive?.flipX) {
    const f = png.create(img.width, img.height);
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++)
      img.data.copy(f.data, (y * img.width + img.width - 1 - x) * 4, (y * img.width + x) * 4, (y * img.width + x) * 4 + 4);
    img = f;
  }
  quantize(img);
  if (asset.type !== 'ground' && asset.type !== 'lot') removeBackdrop(img);
  // Composed lots have deliberately small parts (cones) that despeckle would eat.
  const specks = asset.type === 'ground' || asset.type === 'lot' ? 0 : despeckle(img);
  const r = asset.type === 'ground' ? processGround(img) : processSprite(asset, img);
  verify(r);
  return { ...r, specks };
}

// The manifest plus everything derived from it: the procedural ground set, a
// mirrored copy of every building (flipping swaps the two visible faces, so a
// door on the left wall becomes a door on the right wall), one frame per
// diagonal for people and vehicles, and composed lot sprites. Composed lots
// come last because they are built from already-processed props.
function expandAssets() {
  const out = [], late = [];
  for (const a of manifest.assets) {
    if (a.atlas === false) continue;
    if (a.procedural === 'roads') {
      for (const t of roads.roadSet()) out.push({ id: t.id, type: 'ground', proc: t });
      continue;
    }
    if (a.procedural === 'grass' || a.procedural === 'dirt') { out.push({ id: a.id, type: 'ground', proc: { [a.procedural]: true } }); continue; }
    if (a.compose) { late.push(a); continue; }
    if (a.mode) {
      for (const d of ['se', 'sw', 'ne', 'nw']) out.push({ ...a, id: `${a.id}_${d}`, dir: d, group: a.id, view: d });
      continue;
    }
    out.push({ ...a, door: a.type === 'building' ? a.door || manifest.defaults.door : undefined });
    if (a.type === 'building' ? a.mirror !== false : a.mirror) {
      const door = a.type === 'building' ? { left: 'right', right: 'left' }[a.door || manifest.defaults.door] : undefined;
      out.push({ ...a, id: `${a.id}_m`, door, derive: { from: a.id, flipX: true }, mirrorOf: a.id });
    }
  }
  return [...out, ...late];
}

// A vacant lot, composed in code: dirt over the footprint, then props (cones,
// a barrier) stood at grid points given in footprint units (0..w, 0..h).
function compose(asset) {
  const { footprint: [w, h], props = [] } = asset.compose;
  const top = 48; // headroom for props above the footprint's top vertex
  const W = grid.footprintWidth([w, h]), H = top + grid.footprintHeight([w, h]);
  const img = png.create(W, H);
  const at = (gc, gr) => ({ x: h * tileW / 2 + (gc - gr) * tileW / 2, y: top + (gc + gr) * tileH / 2 });
  const dirt = roads.dirt();
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) { const p = at(c, r); png.over(dirt, img, p.x - tileW / 2, p.y); }
  for (const [id, gc, gr] of [...props].sort((a, b) => (a[1] + a[2]) - (b[1] + b[2]))) {
    const metaFile = path.join(OUT, `${id}.json`);
    if (!fs.existsSync(metaFile)) reject(`needs ${id}, which was not processed`);
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')), spr = png.read(path.join(OUT, `${id}.png`));
    const p = at(gc, gr);
    png.over(spr, img, Math.round(p.x - meta.anchorX), Math.round(p.y + tileH / 2 - meta.anchorY));
  }
  return img;
}

// Raw input for an asset, before any processing.
function source(asset) {
  if (asset.proc) return asset.proc.grass ? roads.grass() : asset.proc.dirt ? roads.dirt() : roads.render(asset.proc);
  if (asset.compose) return compose(asset);
  if (asset.view) {
    const file = path.join(ROOT, 'raw', `${asset.group}__${asset.view}.png`);
    if (!fs.existsSync(file)) reject(`missing ${path.relative(ROOT, file)} — run generate`);
    return png.read(file);
  }
  const from = manifest.assets.find(a => a.id === (asset.derive ? asset.derive.from : asset.id));
  const file = path.join(ROOT, from.source || path.join('raw', `${from.id}.png`));
  if (!fs.existsSync(file)) reject(`missing ${path.relative(ROOT, file)} — run generate`);
  const img = png.read(file);
  if (!from.source && (img.width !== from.size[0] || img.height !== from.size[1]))
    reject(`raw is ${img.width}x${img.height}, manifest says ${from.size.join('x')}`);
  return img;
}

function main() {
  for (const d of [OUT, REJ]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
  const report = { processed: [], rejected: [] };
  let procCount = 0;
  for (const asset of expandAssets()) {
    const { id } = asset;
    let img;
    try {
      img = source(asset);
      const r = run(asset, img);
      png.write(path.join(OUT, `${id}.png`), r.img);
      const meta = {
        id, type: asset.type, w: r.img.width, h: r.img.height, anchorX: r.anchorX, anchorY: r.anchorY,
        footprint: r.footprint, trim: r.trim, sockets: r.sockets, attach: asset.attach,
        category: asset.category, tier: asset.tier, door: asset.door, roof: asset.roof, mirrorOf: asset.mirrorOf,
        dir: asset.dir, group: asset.group,
        procedural: asset.proc ? true : undefined, coverage: r.coverage, specksRemoved: r.specks || undefined,
      };
      fs.writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify(meta, null, 2) + '\n');
      report.processed.push(id);
      if (asset.proc) procCount++;
      else console.log(`✓ ${id.padEnd(26)} ${r.img.width}x${r.img.height} anchor ${r.anchorX},${r.anchorY}`);
    } catch (e) {
      if (!(e instanceof Reject)) throw e;
      if (img) png.write(path.join(REJ, `${id}.png`), img);
      fs.writeFileSync(path.join(REJ, `${id}.json`), JSON.stringify({ id, reason: e.message }, null, 2) + '\n');
      report.rejected.push({ id, reason: e.message });
      console.log(`✗ ${id.padEnd(26)} ${e.message}`);
    }
  }
  fs.writeFileSync(path.join(OUT, '_report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`✓ ${procCount} procedural ground tiles (roads, grass)`);
  console.log(`\n${report.processed.length} processed, ${report.rejected.length} rejected`);
}

if (require.main === module) main();
module.exports = { run, Reject, expandAssets };
