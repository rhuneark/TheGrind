// Grind City runtime renderer — the only code RUN needs.
// Consumes exactly three files: city.png, atlas.json, map.json.
// No knowledge of how the art was made.
//
//   import { loadCity, createCityRenderer } from './city-renderer.js';
//   const city = await loadCity('assets/city/');
//   const r = createCityRenderer(canvas, city, { resolve: id => save.buildings[id] });
//   r.draw({ camX, camY, hour });
//
// `resolve(objectId)` returns { tier, producing } from the save file. The map
// only says a building exists; tier never lives in map.json.

export async function loadCity(base = './') {
  const [atlas, map] = await Promise.all(['atlas.json', 'map.json'].map(f => fetch(base + f).then(r => r.json())));
  const image = new Image();
  image.src = base + atlas.image;
  await image.decode();
  return { atlas, map, image };
}

// Painter's order: ascending front-most cell. col + row alone breaks on
// multi-tile buildings.
export const sortKey = o => (o.col + o.footprint[0] - 1) + (o.row + o.footprint[1] - 1);

// Stable per-object variant choice, so a building keeps its look across loads.
function hash(str, salt) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

// Time-of-day multiply colour, keyed by hour. Interpolated.
const SKY = [[0, '#4a4f7a'], [5, '#5a5a86'], [7, '#e8c6b0'], [9, '#ffffff'], [17, '#ffffff'], [19, '#f0b890'], [21, '#6a5f8a'], [24, '#4a4f7a']];
function skyAt(hour) {
  const h = ((hour % 24) + 24) % 24;
  let i = 0; while (SKY[i + 1][0] < h) i++;
  const [h0, c0] = SKY[i], [h1, c1] = SKY[i + 1], t = (h - h0) / (h1 - h0 || 1);
  const rgb = c => [1, 3, 5].map(k => parseInt(c.slice(k, k + 2), 16));
  const a = rgb(c0), b = rgb(c1);
  return { color: `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * t)).join(',')})`, night: Math.max(0, Math.min(1, h < 12 ? (7 - h) / 2 : (h - 18) / 2)) };
}

// A glow sheet the same size as the atlas: window-glass pixels recoloured to
// the glow colour, everything else transparent. Built once, from city.png, in code.
function buildGlowSheet(image, atlas) {
  const c = document.createElement('canvas');
  c.width = image.width; c.height = image.height;
  const g = c.getContext('2d');
  g.drawImage(image, 0, 0);
  const px = g.getImageData(0, 0, c.width, c.height), d = px.data;
  const glass = new Set((atlas.lighting?.glass || []).map(h => h.toLowerCase()));
  const glow = atlas.lighting?.glow || '#E0C27A';
  const [gr, gg, gb] = [1, 3, 5].map(k => parseInt(glow.slice(k, k + 2), 16));
  const inBuilding = new Uint8Array(c.width * c.height);
  for (const f of Object.values(atlas.frames)) if (f.type === 'building')
    for (let y = f.y; y < f.y + f.h; y++) inBuilding.fill(1, y * c.width + f.x, y * c.width + f.x + f.w);
  for (let p = 0; p < inBuilding.length; p++) {
    const i = p * 4;
    const hex = '#' + [d[i], d[i + 1], d[i + 2]].map(v => v.toString(16).padStart(2, '0')).join('');
    if (inBuilding[p] && d[i + 3] && glass.has(hex)) { d[i] = gr; d[i + 1] = gg; d[i + 2] = gb; }
    else d[i + 3] = 0;
  }
  g.putImageData(px, 0, 0);
  return c;
}

export function createCityRenderer(canvas, { atlas, map, image }, opts = {}) {
  const ctx = canvas.getContext('2d');
  const { tileW, tileH } = map;
  const resolve = opts.resolve || (() => ({ tier: 1, producing: false }));
  const glowSheet = buildGlowSheet(image, atlas);
  let scale = opts.scale || 2; // integer only

  const objects = [...map.objects].sort((a, b) => sortKey(a) - sortKey(b) || a.col - b.col);

  // Bottom vertex of a footprint in world pixels (origin = top vertex of cell 0,0).
  const bottom = (col, row, [w, h]) => ({ x: (col + w - 1 - (row + h - 1)) * tileW / 2, y: (col + w - 1 + row + h - 1) * tileH / 2 + tileH });

  function blit(sheet, id, x, y) {
    const f = atlas.frames[id];
    ctx.drawImage(sheet, f.x, f.y, f.w, f.h, Math.round(x), Math.round(y), f.w, f.h);
  }

  // Resolve an object to [{ id, x, y }] draw calls: base, then overlays on sockets.
  function layersFor(o) {
    if (o.sprite) {
      const f = atlas.frames[o.sprite], b = bottom(o.col, o.row, o.footprint);
      return [{ id: o.sprite, x: b.x - f.anchorX, y: b.y - f.anchorY }];
    }
    const state = resolve(o.objectId) || {};
    const tiers = atlas.stacks[o.category];
    if (!tiers) return [];
    const stack = tiers[state.tier] || tiers[Math.max(...Object.keys(tiers).map(Number).filter(t => t <= (state.tier || 1)), 1)] || Object.values(tiers)[0];
    const ids = stack.map((variants, i) => variants[hash(o.objectId, i) % variants.length]);
    const base = atlas.frames[ids[0]], b = bottom(o.col, o.row, o.footprint);
    const bx = b.x - base.anchorX, by = b.y - base.anchorY;
    return [{ id: ids[0], x: bx, y: by, base: true }, ...ids.slice(1).map(id => {
      const f = atlas.frames[id], [sx, sy] = base.sockets[f.attach];
      return { id, x: bx + sx - f.anchorX, y: by + sy - f.anchorY };
    })];
  }

  function draw({ camX = 0, camY = 0, hour = 12, debug = false } = {}) {
    const W = canvas.width, H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = opts.background || '#2B1D14';
    ctx.fillRect(0, 0, W, H);
    // World → screen: integer scale, camera centred.
    const ox = Math.round(W / 2 / scale - camX), oy = Math.round(H / 2 / scale - camY);
    ctx.setTransform(scale, 0, 0, scale, ox * scale, oy * scale);
    const vis = (x, y, w, h) => x + ox < W / scale && x + w + ox > 0 && y + oy < H / scale && y + h + oy > 0;

    // 1. Ground
    for (let row = 0; row < map.size.rows; row++) for (let col = 0; col < map.size.cols; col++) {
      const id = map.ground[row][col], f = atlas.frames[id];
      if (!f) continue;
      const x = (col - row) * tileW / 2 - f.anchorX, y = (col + row) * tileH / 2 + tileH - f.anchorY;
      if (vis(x, y, f.w, f.h)) blit(image, id, x, y);
    }
    // 2. Objects, painter's order
    const lit = [];
    for (const o of objects) for (const l of layersFor(o)) {
      const f = atlas.frames[l.id];
      if (!vis(l.x, l.y, f.w, f.h)) continue;
      blit(image, l.id, l.x, l.y);
      if (l.base && resolve(o.objectId)?.producing) lit.push(l);
    }
    // 3. Lighting: one multiply for time of day, then window glow on top.
    const sky = skyAt(hour);
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = sky.color;
    ctx.fillRect(-ox, -oy, W / scale, H / scale);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 0.35 + 0.65 * sky.night;
    for (const l of lit) blit(glowSheet, l.id, l.x, l.y);
    ctx.globalAlpha = 1;
    // Debug: footprint outlines, to check sprites sit on their cells.
    if (debug) {
      ctx.strokeStyle = '#d33'; ctx.lineWidth = 1 / scale;
      for (const o of objects) {
        const b = bottom(o.col, o.row, o.footprint), [w, h] = o.footprint;
        ctx.beginPath();
        ctx.moveTo(b.x, b.y);
        ctx.lineTo(b.x - w * tileW / 2, b.y - w * tileH / 2);
        ctx.lineTo(b.x + (h - w) * tileW / 2, b.y - (w + h) * tileH / 2);
        ctx.lineTo(b.x + h * tileW / 2, b.y - h * tileH / 2);
        ctx.closePath(); ctx.stroke();
      }
    }
  }

  // World bounds, handy for centring the camera.
  const bounds = { x0: -map.size.rows * tileW / 2, x1: map.size.cols * tileW / 2, y0: 0, y1: (map.size.cols + map.size.rows) * tileH / 2 };

  return { draw, bounds, setScale: s => { scale = Math.max(1, Math.round(s)); }, get scale() { return scale; } };
}
