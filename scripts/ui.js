#!/usr/bin/env node
// UI kit: generate → pick → pack.
//   node scripts/ui.js generate [--only a,b] [--force]   variants → ui/candidates/<id>/NN.png
//   node scripts/ui.js pick id:NN [id:NN ...]           copy a variant to ui/raw/<id>.png
//   node scripts/ui.js pack                              ui/raw → dist/ui.png + dist/ui.json
const fs = require('fs');
const path = require('path');
const png = require('../lib/png');
const { post, waitForJob, decode } = require('../lib/pixellab');

const ROOT = path.join(__dirname, '..');
const UI = path.join(ROOT, 'ui');
const manifest = JSON.parse(fs.readFileSync(path.join(UI, 'assets.json'), 'utf8'));
const [cmd, ...args] = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;

async function generate() {
  const todo = manifest.assets.filter(a => (!only || only.includes(a.id)) && (args.includes('--force') || !fs.existsSync(path.join(UI, 'candidates', a.id))));
  let queue = [...todo];
  const worker = async () => { for (let a; (a = queue.shift());) {
    try {
      const r = await post('/generate-ui-v2', { description: `${manifest.style}, ${a.prompt}`, image_size: { width: a.size[0], height: a.size[1] }, color_palette: manifest.palette, no_background: true, seed: a.seed ?? 1 });
      const job = await waitForJob(r.background_job_id);
      const ims = job.last_response.images || [];
      const dir = path.join(UI, 'candidates', a.id); fs.mkdirSync(dir, { recursive: true });
      (Array.isArray(ims) ? ims : Object.values(ims)).forEach((im, i) => fs.writeFileSync(path.join(dir, `${String(i).padStart(2, '0')}.png`), decode(im)));
      console.log(`✓ ${a.id} (${ims.length})`);
    } catch (e) { console.error(`✗ ${a.id}: ${e.message}`); }
  } };
  await Promise.all(Array.from({ length: 4 }, worker));
}

function pick() {
  fs.mkdirSync(path.join(UI, 'raw'), { recursive: true });
  const picks = fs.existsSync(path.join(UI, 'picks.json')) ? JSON.parse(fs.readFileSync(path.join(UI, 'picks.json'), 'utf8')) : {};
  for (const spec of args) {
    const [id, n, as] = spec.split(':');
    const src = path.join(UI, 'candidates', id, `${n.padStart(2, '0')}.png`);
    const out = as || id;
    fs.copyFileSync(src, path.join(UI, 'raw', `${out}.png`));
    picks[out] = `${id}:${n}`;
    console.log(`picked ${id} #${n}${as ? ` as ${as}` : ''}`);
  }
  fs.writeFileSync(path.join(UI, 'picks.json'), JSON.stringify(picks, null, 2) + '\n');
}

// Fill transparency the outside can't reach (holes inside a frame).
function fillHoles(img, colour, inset) {
  const { width: W, height: H, data: d } = img, out = new Uint8Array(W * H), stack = [];
  // Inside the nine-slice insets is always the panel's face, whatever leaks.
  const inner = (x, y) => inset && y >= inset[0] && x < W - inset[1] && y < H - inset[2] && x >= inset[3];
  for (let x = 0; x < W; x++) stack.push(x, (H - 1) * W + x);
  for (let y = 0; y < H; y++) stack.push(y * W, y * W + W - 1);
  while (stack.length) {
    const p = stack.pop(); if (out[p] || d[p * 4 + 3]) continue; out[p] = 1;
    const x = p % W, y = (p / W) | 0;
    if (x > 0) stack.push(p - 1); if (x < W - 1) stack.push(p + 1); if (y > 0) stack.push(p - W); if (y < H - 1) stack.push(p + W);
  }
  let rgb;
  if (colour === 'auto') { // most common opaque colour in the middle third
    const hist = new Map();
    for (let y = (H / 3) | 0; y < (2 * H / 3) | 0; y++) for (let x = (W / 3) | 0; x < (2 * W / 3) | 0; x++) { const i = (y * W + x) * 4; if (!d[i + 3]) continue; const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2]; hist.set(k, (hist.get(k) || 0) + 1); }
    const k = [...hist].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0x2A2C30; rgb = [k >> 16, (k >> 8) & 255, k & 255];
  } else rgb = [1, 3, 5].map(i => parseInt(colour.slice(i, i + 2), 16));
  for (let p = 0; p < W * H; p++) if ((!out[p] || inner(p % W, (p / W) | 0)) && !d[p * 4 + 3]) d.set([...rgb, 255], p * 4);
  // The generator sometimes paints a fake transparency checkerboard into the
  // face. Flood from the centre over near-grey light pixels and repaint them.
  if (!inset) return;
  const fake = p => { const i = p * 4, mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]); return mn > 170 && mx - mn < 24; };
  const seen = new Uint8Array(W * H), q = [((H >> 1) * W) + (W >> 1)];
  while (q.length) {
    const p = q.pop(); if (seen[p]) continue; seen[p] = 1;
    const x = p % W, y = (p / W) | 0;
    if (!inner(x, y) && !fake(p)) continue;
    d.set([...rgb, 255], p * 4);
    if (x > 0) q.push(p - 1); if (x < W - 1) q.push(p + 1); if (y > 0) q.push(p - W); if (y < H - 1) q.push(p + W);
  }
}

// Trim, quantize to the city palette, shelf-pack. Nine-slice insets come
// from ui/slices.json (per id: [top, right, bottom, left]).
function pack() {
  const slices = fs.existsSync(path.join(UI, 'slices.json')) ? JSON.parse(fs.readFileSync(path.join(UI, 'slices.json'), 'utf8')) : {};
  const fills = fs.existsSync(path.join(UI, 'fill.json')) ? JSON.parse(fs.readFileSync(path.join(UI, 'fill.json'), 'utf8')) : {};
  const sprites = fs.readdirSync(path.join(UI, 'raw')).filter(f => f.endsWith('.png')).sort().map(f => {
    const img = png.read(path.join(UI, 'raw', f)), d = img.data;
    let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      // UI keeps its own colours (generated from the same colour brief as the
      // city); snapping to the city palette turned the green button grey.
      if (d[i + 3] < 128) { d.fill(0, i, i + 4); continue; }
      d[i + 3] = 255;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    const out = png.create(x1 - x0 + 1, y1 - y0 + 1); png.blit(img, out, 0, 0, x0, y0, out.width, out.height);
    const id = f.replace(/\.png$/, '');
    if (fills[id]) fillHoles(out, fills[id], slices[id]);
    return { id, img: out };
  });
  const W = 512; let x = 1, y = 1, sh = 0;
  for (const s of [...sprites].sort((a, b) => b.img.height - a.img.height)) {
    if (x + s.img.width + 1 > W) { x = 1; y += sh + 1; sh = 0; }
    s.x = x; s.y = y; x += s.img.width + 1; sh = Math.max(sh, s.img.height);
  }
  const H = 2 ** Math.ceil(Math.log2(y + sh + 1)), sheet = png.create(W, H), frames = {};
  for (const s of sprites) { png.blit(s.img, sheet, s.x, s.y); frames[s.id] = { x: s.x, y: s.y, w: s.img.width, h: s.img.height, ...(slices[s.id] && { slice: slices[s.id] }) }; }
  png.write(path.join(ROOT, 'dist', 'ui.png'), sheet);
  fs.writeFileSync(path.join(ROOT, 'dist', 'ui.json'), JSON.stringify({ image: 'ui.png', frames }, null, 2) + '\n');
  console.log(`packed ${sprites.length} UI sprites into ${W}x${H}`);
}

const run = { generate, pick, pack }[cmd];
if (run) run(); else console.log('usage: node scripts/ui.js generate|pick|pack');
