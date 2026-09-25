// Grind City runtime renderer — the only code RUN needs.
// Consumes exactly three files: city.png, atlas.json, map.json.
// No knowledge of how the art was made.
//
//   import { loadCity, createCityRenderer } from './city-renderer.js';
//   const city = await loadCity('assets/city/');
//   const r = createCityRenderer(canvas, city, { resolve: id => save.buildings[id] });
//   r.draw({ camX, camY, hour, time });
//
// `resolve(objectId)` returns the building's state from the save file (any
// field may be missing; a missing `state` falls back to the map's
// `startState`, then 'built'):
//   { state, tier, producing, progress }
//   state: 'built' (default) | 'vacant' | 'constructing' | 'renovating'
//     vacant       — an unbought spot: bare dirt, cones and a barrier
//     constructing — 5-frame build-up of the building it will become. Pass
//                    progress 0..1 to drive it, or leave it out to loop.
//     renovating   — the building with a 4-frame dust loop over it
// The map only says a building exists (category, footprint, and `facing` —
// which visible wall its door is on); tier and state never live in map.json.
// Props with `belongsTo` (café seating) are hidden while that shop is vacant
// or under construction.
// `time` (ms, default performance.now()) drives the animations.

export async function loadCity(base = './') {
  const [atlas, map] = await Promise.all(['atlas.json', 'map.json'].map(f => fetch(base + f).then(r => r.json())));
  const image = new Image();
  image.src = base + atlas.image;
  await image.decode();
  return { atlas, map, image };
}

// Painter's order: ascending front-most cell. col + row alone breaks on
// multi-tile buildings.
// `nudge` [du, dv] moves a small object within its tile (in tile units), so
// a parked car can sit against the curb or two people can share a sidewalk tile.
export const sortKey = o => (o.col + o.footprint[0] - 1) + (o.row + o.footprint[1] - 1) + (o.nudge ? o.nudge[0] + o.nudge[1] : 0);

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


// ---------------------------------------------------------------------------
// Construction and renovation frames, drawn in code from the building itself,
// so every variant gets a build-up that ends in exactly that building.
export const CONSTRUCTION_FRAMES = 5, DUST_FRAMES = 4, FRAME_MS = 170;
const rgb = h => [1, 3, 5].map(k => parseInt(h.slice(k, k + 2), 16));
const STRUCT = ['#36393D', '#5A5E63', '#8A8B84'].map(rgb); // bare concrete frame, dark to light
const POLE = rgb('#44474C'), BOARD = rgb('#9C8B72');
const DUST = ['#E6E2D6', '#CFC8B4', '#B5AB93'].map(rgb);
const DUST_MARGIN = 16;
const n2 = (x, y, s) => { let h = Math.imul(x * 374761393 + y * 668265263 + s * 2147483647, 1274126177); h = Math.imul(h ^ (h >>> 13), 1103515245); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

function canvasOf(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

// Pixels of one atlas frame, plus the measurements the effects need.
function spriteInfo(image, f) {
  const c = canvasOf(f.w, f.h), g = c.getContext('2d');
  g.drawImage(image, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
  const d = g.getImageData(0, 0, f.w, f.h);
  let top = f.h, x0 = f.w, x1 = 0;
  for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) if (d.data[(y * f.w + x) * 4 + 3]) { top = Math.min(top, y); x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
  const ax = f.anchorX, ay = f.anchorY;
  // Ground line under each wall: 2:1 slopes up from the front corner.
  const ground = x => ay - Math.abs(x - ax) / 2;
  return { d, top, x0, x1, ax, ay, ground, height: Math.max(1, ay - top) };
}

// Five frames: foundation, frame rising, frame topped out, cladding going on,
// finished with the scaffolding gone.
const STAGES = [
  { reveal: 0.08, clad: 0, scaffold: 0.22 },
  { reveal: 0.38, clad: 0, scaffold: 0.5 },
  { reveal: 0.72, clad: 0, scaffold: 0.84 },
  { reveal: 1.0, clad: 0.5, scaffold: 1.04 },
  { reveal: 1.0, clad: 1, scaffold: 0 },
];
function constructionFrames(image, f) {
  const s = spriteInfo(image, f), src = s.d.data;
  return STAGES.map(stage => {
    const c = canvasOf(f.w, f.h), g = c.getContext('2d'), out = g.createImageData(f.w, f.h), o = out.data;
    const put = (x, y, [r, gg, b]) => { if (x < 0 || y < 0 || x >= f.w || y >= f.h) return; const i = (y * f.w + x) * 4; o[i] = r; o[i + 1] = gg; o[i + 2] = b; o[i + 3] = 255; };
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
      const i = (y * f.w + x) * 4;
      if (!src[i + 3]) continue;
      const up = s.ground(x) - y; // height above the ground line
      if (up > stage.reveal * s.height + 0.5) continue;
      if (up <= stage.clad * s.height) { o[i] = src[i]; o[i + 1] = src[i + 1]; o[i + 2] = src[i + 2]; o[i + 3] = 255; continue; }
      const lum = (src[i] * 0.3 + src[i + 1] * 0.59 + src[i + 2] * 0.11) / 255;
      put(x, y, STRUCT[lum < 0.28 ? 0 : lum < 0.55 ? 1 : 2]);
    }
    // Scaffolding over both street walls: steel poles every 8px, boards every 9px of height.
    const sh = Math.round(stage.scaffold * s.height);
    if (sh > 0) {
      for (let x = s.x0 + 1; x <= s.x1 - 1; x++) {
        const gy = Math.round(s.ground(x));
        if ((x - s.x0) % 8 === 1 || x === s.ax) for (let k = 0; k <= sh; k++) put(x, gy - k, POLE);
        for (let k = 6; k <= sh; k += 9) put(x, gy - k, BOARD);
      }
    }
    g.putImageData(out, 0, 0);
    return c;
  });
}

// Dust: billowing puffs along the foot of both street walls, a few up the
// facade and off the roof, each a step out of phase so the loop reads as
// continuous. Light cores with grey edges, so they read on pale sidewalks and
// dark brick alike.
function dustFrames(image, f) {
  const s = spriteInfo(image, f), M = DUST_MARGIN, W = f.w + 2 * M, H = f.h + M;
  const spots = [];
  for (const t of [0.1, 0.35, 0.6, 0.85]) {
    const xl = Math.round(s.x0 + (s.ax - s.x0) * t), xr = Math.round(s.ax + (s.x1 - s.ax) * t);
    spots.push([xl, s.ground(xl) - 2], [xr, s.ground(xr) - 2]);
  }
  for (const [t, hgt] of [[0.3, 0.35], [0.7, 0.55], [0.5, 0.75]]) {
    const xl = Math.round(s.x0 + (s.ax - s.x0) * t), xr = Math.round(s.ax + (s.x1 - s.ax) * (1 - t));
    spots.push([xl, s.ground(xl) - s.height * hgt], [xr, s.ground(xr) - s.height * (hgt + 0.1)]);
  }
  spots.push([Math.round((s.x0 + s.x1) / 2), s.top + 4]);
  const shade = [[230, 226, 214, 255], [207, 200, 180, 240], [169, 163, 140, 210]]; // core, body, edge: dusty, not snowy
  return Array.from({ length: DUST_FRAMES }, (_, frame) => {
    const c = canvasOf(W, H), g = c.getContext('2d'), out = g.createImageData(W, H), o = out.data;
    spots.forEach(([cx, cy], i) => {
      const onGround = i < 8;
      const k = (frame + i) % DUST_FRAMES; // each puff grows, rises and breaks up
      const r = onGround ? 4 + k * 2.4 : 3 + k * 1.6, ragged = 0.15 + k * 0.2;
      // Three overlapping lobes make a cloud rather than a disc.
      const lobes = [[0, 0, 1], [-r * 0.7, r * 0.2, 0.7], [r * 0.7, r * 0.25, 0.65]];
      for (let dy = -Math.ceil(r); dy <= Math.ceil(r * 0.6); dy++) for (let dx = -Math.ceil(r * 1.9); dx <= Math.ceil(r * 1.9); dx++) {
        let dist = 9;
        for (const [lx, ly, ls] of lobes) dist = Math.min(dist, Math.hypot((dx - lx) / 1.3, dy - ly) / (r * ls));
        if (dist > 1 || (dist > 0.55 && n2((dx >> 1) + i * 31, dy + frame * 17, 3) < ragged)) continue;
        const x = Math.round(cx + dx) + M, y = Math.round(cy + dy - k * 1.5) + M;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const col = shade[dist < 0.5 ? 0 : dist < 0.82 ? 1 : 2], j = (y * W + x) * 4;
        if (o[j + 3] && o[j] >= col[0]) continue; // lighter core wins where puffs overlap
        o[j] = col[0]; o[j + 1] = col[1]; o[j + 2] = col[2]; o[j + 3] = col[3];
      }
    });
    g.putImageData(out, 0, 0);
    return c;
  });
}

export function createCityRenderer(canvas, { atlas, map, image }, opts = {}) {
  const ctx = canvas.getContext('2d');
  const { tileW, tileH } = map;
  const resolve = opts.resolve || (() => ({ tier: 1, producing: false }));
  const glowSheet = buildGlowSheet(image, atlas);
  let scale = opts.scale || 2; // integer only

  // A building's state: what the save file says, else the map's starting
  // state (`startState: "vacant"` on spots that begin unbought), else built.
  const byId = new Map(map.objects.map(o => [o.objectId, o]));
  const stateOf = id => { const saved = resolve(id) || {}; return { ...saved, state: saved.state ?? byId.get(id)?.startState ?? 'built' }; };

  const objects = [...map.objects].sort((a, b) => sortKey(a) - sortKey(b) || a.col - b.col);

  // Bottom vertex of a footprint in world pixels (origin = top vertex of cell 0,0).
  const bottom = (col, row, [w, h]) => ({ x: (col + w - 1 - (row + h - 1)) * tileW / 2, y: (col + w - 1 + row + h - 1) * tileH / 2 + tileH });

  const effectCache = new Map();
  const cached = (id, kind, make) => { const k = `${id}:${kind}`; if (!effectCache.has(k)) effectCache.set(k, make()); return effectCache.get(k); };
  let time = 0;

  function blit(sheet, id, x, y) {
    const f = atlas.frames[id];
    ctx.drawImage(sheet, f.x, f.y, f.w, f.h, Math.round(x), Math.round(y), f.w, f.h);
  }

  // Resolve an object to [{ id, x, y }] draw calls: base, then overlays on sockets.
  const fpKey = f => f.join('x');
  function layersFor(o) {
    if (o.sprite) {
      // Street furniture that belongs to a shop (café seating) only appears once it's open.
      if (o.belongsTo && ['vacant', 'constructing'].includes(stateOf(o.belongsTo).state)) return [];
      const f = atlas.frames[o.sprite], b = bottom(o.col, o.row, o.footprint);
      const [du, dv] = o.nudge || [0, 0];
      return [{ id: o.sprite, x: b.x - f.anchorX + (du - dv) * tileW / 2, y: b.y - f.anchorY + (du + dv) * tileH / 2 }];
    }
    const state = stateOf(o.objectId);
    const lotId = atlas.lots?.[fpKey(o.footprint)];
    const lotLayer = () => { const f = atlas.frames[lotId], b = bottom(o.col, o.row, o.footprint); return { id: lotId, x: b.x - f.anchorX, y: b.y - f.anchorY }; };
    if (state.state === 'vacant') return lotId ? [lotLayer()] : [];
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
    if (state.state === 'constructing') {
      const frames = cached(baseId, 'build', () => constructionFrames(image, base));
      const i = state.progress != null ? Math.min(CONSTRUCTION_FRAMES - 1, Math.floor(state.progress * CONSTRUCTION_FRAMES)) : Math.floor(time / (FRAME_MS * 3)) % CONSTRUCTION_FRAMES;
      const layers = i < CONSTRUCTION_FRAMES - 1 && lotId ? [lotLayer()] : [];
      layers.push({ canvas: frames[i], x: bx, y: by });
      // The last frame kicks up a little dust as the scaffolding comes down.
      if (i === CONSTRUCTION_FRAMES - 1) layers.push({ canvas: cached(baseId, 'dust', () => dustFrames(image, base))[Math.floor(time / FRAME_MS) % DUST_FRAMES], x: bx - DUST_MARGIN, y: by - DUST_MARGIN });
      return layers;
    }
    const ids = overlayLayers.map((variants, i) => variants[hash(o.objectId, i + 1) % variants.length]).filter(Boolean);
    // Flat roofs on 2x2 and up get a piece of rooftop kit (or nothing, 1 in 3).
    const roofKit = atlas.rooftops || [];
    if (base.roof === 'flat' && o.footprint[0] >= 2 && roofKit.length && hash(o.objectId, 99) % 3) ids.push(roofKit[hash(o.objectId, 98) % roofKit.length]);
    const layers = [{ id: baseId, x: bx, y: by, base: true }, ...ids.map(id => {
      const f = atlas.frames[id], [sx, sy] = base.sockets[f.attach];
      return { id, x: bx + sx - f.anchorX, y: by + sy - f.anchorY };
    })];
    if (state.state === 'renovating')
      layers.push({ canvas: cached(baseId, 'dust', () => dustFrames(image, base))[Math.floor(time / FRAME_MS) % DUST_FRAMES], x: bx - DUST_MARGIN, y: by - DUST_MARGIN });
    return layers;
  }

  function draw({ camX = 0, camY = 0, hour = 12, debug = false, time: t } = {}) {
    time = t ?? (typeof performance !== 'undefined' ? performance.now() : 0);
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
      if (l.canvas) { if (vis(l.x, l.y, l.canvas.width, l.canvas.height)) ctx.drawImage(l.canvas, Math.round(l.x), Math.round(l.y)); continue; }
      const f = atlas.frames[l.id];
      if (!vis(l.x, l.y, f.w, f.h)) continue;
      blit(image, l.id, l.x, l.y);
      if (l.base && stateOf(o.objectId).producing) lit.push(l);
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

  // True when something on the map is animating, so the caller knows to keep
  // redrawing (a requestAnimationFrame loop at ~10fps is plenty).
  const animating = () => objects.some(o => o.category && ['constructing', 'renovating'].includes(stateOf(o.objectId).state));

  return { draw, bounds, animating, setScale: s => { scale = Math.max(1, Math.round(s)); }, get scale() { return scale; } };
}
