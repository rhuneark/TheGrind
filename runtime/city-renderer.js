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
// only says a building exists (category, footprint, and `facing` — which
// visible wall its door is on); tier never lives in map.json.

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

// A glow sheet the same size as the atlas: window panes recoloured to the
// glow colour, everything else transparent. Built once, from city.png, in code.
// A pane is a small, enclosed patch of glass-coloured pixels. Long runs of the
// same colour are trim or outline, and anything touching the silhouette edge
// is outline, so neither lights up.
function buildGlowSheet(image, atlas) {
  const c = document.createElement('canvas');
  c.width = image.width; c.height = image.height;
  const g = c.getContext('2d');
  g.drawImage(image, 0, 0);
  const W = c.width, px = g.getImageData(0, 0, W, c.height), d = px.data;
  const glass = new Set((atlas.lighting?.glass || []).map(h => parseInt(h.slice(1), 16)));
  const [gr, gg, gb] = [1, 3, 5].map(k => parseInt((atlas.lighting?.glow || '#E8C878').slice(k, k + 2), 16));
  const isGlass = p => d[p * 4 + 3] && glass.has((d[p * 4] << 16) | (d[p * 4 + 1] << 8) | d[p * 4 + 2]);
  const lit = new Uint8Array(W * c.height), seen = new Uint8Array(W * c.height);
  for (const f of Object.values(atlas.frames)) {
    if (f.type !== 'building') continue;
    const inside = (x, y) => x >= f.x && y >= f.y && x < f.x + f.w && y < f.y + f.h;
    // Skip the roof: the top face is a 2:1 diamond centred on the roof socket.
    const [rx, ry] = f.sockets?.roof || [-1e9, -1e9];
    const onRoof = (x, y) => Math.abs(x - f.x - rx) / (f.w / 2) + Math.abs(y - f.y - ry) / (f.w / 4) <= 1;
    for (let y = f.y; y < f.y + f.h; y++) for (let x = f.x; x < f.x + f.w; x++) {
      const s = y * W + x;
      if (seen[s] || !isGlass(s) || onRoof(x, y)) continue;
      // Flood one glass patch, tracking its size, extent and whether it touches the edge.
      const patch = [s], stack = [s]; seen[s] = 1;
      let edge = false, x0 = x, x1 = x, y0 = y, y1 = y;
      while (stack.length) {
        const p = stack.pop(), px_ = p % W, py = (p / W) | 0;
        x0 = Math.min(x0, px_); x1 = Math.max(x1, px_); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = px_ + dx, ny = py + dy, q = ny * W + nx;
          if (!inside(nx, ny) || !d[q * 4 + 3]) { edge = true; continue; }
          if (!seen[q] && isGlass(q)) { seen[q] = 1; stack.push(q); patch.push(q); }
        }
      }
      const pane = !edge && patch.length >= 5 && patch.length <= 60 && x1 - x0 <= 10 && y1 - y0 <= 14;
      if (pane) for (const p of patch) lit[p] = 1;
    }
  }
  for (let p = 0; p < lit.length; p++) {
    if (lit[p]) { d[p * 4] = gr; d[p * 4 + 1] = gg; d[p * 4 + 2] = gb; }
    else d[p * 4 + 3] = 0;
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
  const fpKey = f => f.join('x');
  function layersFor(o) {
    if (o.sprite) {
      const f = atlas.frames[o.sprite], b = bottom(o.col, o.row, o.footprint);
      return [{ id: o.sprite, x: b.x - f.anchorX, y: b.y - f.anchorY }];
    }
    const state = resolve(o.objectId) || {};
    const tiers = atlas.stacks[o.category];
    if (!tiers) return [];
    // Highest tier at or below the saved one that has a base for this footprint.
    const fits = id => fpKey(atlas.frames[id].footprint) === fpKey(o.footprint);
    const want = state.tier || 1;
    const tierKeys = Object.keys(tiers).map(Number).sort((a, b) => b - a);
    const tier = tierKeys.find(t => t <= want && tiers[t][0].some(fits)) ?? tierKeys.reverse().find(t => tiers[t][0].some(fits));
    if (tier === undefined) return [];
    const [baseVariants, ...overlayLayers] = tiers[tier];
    // Door on the wall the map says faces the street.
    let bases = baseVariants.filter(id => fits(id) && (!o.facing || atlas.frames[id].door === o.facing));
    if (!bases.length) bases = baseVariants.filter(fits);
    const baseId = bases[hash(o.objectId, 0) % bases.length];
    const base = atlas.frames[baseId], b = bottom(o.col, o.row, o.footprint);
    const bx = b.x - base.anchorX, by = b.y - base.anchorY;
    const ids = overlayLayers.map((variants, i) => variants[hash(o.objectId, i + 1) % variants.length]).filter(Boolean);
    // Flat roofs on 2x2 and up get a piece of rooftop kit (or nothing, 1 in 3).
    const roofKit = atlas.rooftops || [];
    if (base.roof === 'flat' && o.footprint[0] >= 2 && roofKit.length && hash(o.objectId, 99) % 3) ids.push(roofKit[hash(o.objectId, 98) % roofKit.length]);
    return [{ id: baseId, x: bx, y: by, base: true }, ...ids.map(id => {
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
