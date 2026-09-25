// Procedural ground: road surface and markings, lawn, and building-site dirt.
//
// Roads are the one ground type drawn in code rather than generated: lane
// lines, crosswalks and curbs have to meet exactly at tile edges or the street
// reads as a checkerboard, and PixelLab has no way to know where the edges are.
//
// Tile-local coordinates: u runs from the -col edge (top-left) to the +col
// edge (bottom-right); v runs from the -row edge (top-right) to the +row edge
// (bottom-left). A road "ns" runs along the row axis, so its lane lines sit on
// the u = 0 / u = 1 edges.
const png = require('./png');
const { hexToRgb } = require('./palette');
const { tileW, tileH } = require('./grid');
const { inDiamond } = require('./ground');

const C = {
  asphalt: ['#36393D', '#2A2C30', '#44474C'],
  white: '#E6E2D6',
  yellow: '#C9A444',
  curb: '#8A8B84',
  gutter: '#2A2C30',
};

// Deterministic per-pixel noise so every tile of a kind is identical.
const noise = (x, y, s) => {
  let h = Math.imul(x * 374761393 + y * 668265263 + s * 2147483647, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

function uv(x, y) {
  const a = (x + 0.5) / (tileW / 2) - 1, b = (y + 0.5) / (tileH / 2) - 1;
  return { u: (a + b + 1) / 2, v: (b - a + 1) / 2 };
}

// One screen pixel measured across a 2:1 edge is ~1/32 of a tile.
const PX = 1 / 32;

function asphalt(seed = 1) {
  const img = png.create(tileW, tileH);
  for (let y = 0; y < tileH; y++) for (let x = 0; x < tileW; x++) {
    if (!inDiamond(x, y)) continue;
    const n = noise(x, y, seed);
    const hex = n < 0.10 ? C.asphalt[1] : n > 0.95 ? C.asphalt[2] : C.asphalt[0];
    img.data.set([...hexToRgb(hex), 255], (y * tileW + x) * 4);
  }
  return img;
}

// Lawn: same treatment as asphalt — seamless, identical on every tile.
function grass(seed = 3) {
  const img = png.create(tileW, tileH);
  for (let y = 0; y < tileH; y++) for (let x = 0; x < tileW; x++) {
    if (!inDiamond(x, y)) continue;
    const n = noise(x, y, seed);
    // Tufts are 2px wide so they read at 2:1 like everything else.
    const t = noise(x >> 1, y, seed + 1);
    const hex = t < 0.12 ? '#465A3F' : n > 0.97 ? '#8A8B84' : '#6C7F58';
    img.data.set([...hexToRgb(hex), 255], (y * tileW + x) * 4);
  }
  return img;
}

// Bare earth for building sites: packed dirt with gravel.
function dirt(seed = 5) {
  const img = png.create(tileW, tileH);
  for (let y = 0; y < tileH; y++) for (let x = 0; x < tileW; x++) {
    if (!inDiamond(x, y)) continue;
    const n = noise(x, y, seed), t = noise(x >> 1, y, seed + 1);
    const hex = t < 0.1 ? '#4A2A25' : n < 0.08 ? '#8A8B84' : n > 0.93 ? '#9C8B72' : '#7A6A58';
    img.data.set([...hexToRgb(hex), 255], (y * tileW + x) * 4);
  }
  return img;
}

const set = (img, x, y, hex) => img.data.set([...hexToRgb(hex), 255], (y * tileW + x) * 4);

// Paint one edge. `d` is distance from that edge (0 at the edge), `t` the
// position along it (0..1). Each tile paints its half of a shared line, so
// neighbours together make a whole one.
function edgeMark(code, d, t, x, y) {
  const worn = noise(x, y, 7) < 0.08; // a few missing pixels, like old paint
  switch (code) {
    case 'c': // curb: gutter line against the kerb
      return d < PX ? C.curb : d < 2 * PX ? C.gutter : null;
    case 'y': // centre line, dashed yellow
      return d < PX && t > 0.2 && t < 0.7 && !worn ? C.yellow : null;
    case 'Y': // double solid yellow: one line per side, 1px off the edge
      return d >= PX && d < 2 * PX && !worn ? C.yellow : null;
    case 'w': // lane divider, dashed white
      return d < PX && t > 0.2 && t < 0.7 && !worn ? C.white : null;
    default:
      return null;
  }
}

// edges: { u0, u1, v0, v1 } codes; crosswalk: 'u' (stripes across a road
// running along v, i.e. an ns road) or 'v'; stall: 'ns' for a parking stall
// whose car points along the row axis, 'ew' along the col axis.
function paint(img, { edges = {}, crosswalk = null, stall = null } = {}) {
  for (let y = 0; y < tileH; y++) for (let x = 0; x < tileW; x++) {
    if (!inDiamond(x, y)) continue;
    const { u, v } = uv(x, y);
    if (crosswalk) {
      // Zebra bars parallel to traffic, laid across the road width.
      const across = crosswalk === 'u' ? u : v, along = crosswalk === 'u' ? v : u;
      if (along > 0.14 && along < 0.86 && Math.floor(across * 8) % 2 === 0 && noise(x, y, 9) > 0.05) set(img, x, y, C.white);
    }
    if (stall) {
      // Perpendicular parking: white dividers down both sides of the stall,
      // parallel to the parked car. Neighbouring stalls share the line.
      const [d0, d1, t] = stall === 'ns' ? [u, 1 - u, v] : [v, 1 - v, u];
      if (Math.min(d0, d1) < PX && t > 0.06 && t < 0.94) set(img, x, y, C.white);
    }
    for (const [edge, d, t] of [['u0', u, v], ['u1', 1 - u, v], ['v0', v, u], ['v1', 1 - v, u]]) {
      const hex = edges[edge] && edgeMark(edges[edge], d, t, x, y);
      if (hex) set(img, x, y, hex);
    }
  }
  return img;
}

// The fixed road set. `ns` tiles run along the row axis; `ew` tiles are the
// same markings on the other pair of edges. Every road cell the map generator
// produces maps onto exactly one of these ids (see roadTileId).
function roadSet() {
  const tiles = [];
  const lanes = ['cc', 'cy', 'yc', 'cw', 'wY', 'Yw', 'wc', 'nn'];
  const xwalks = ['cn', 'nc', 'nn', 'cc'];
  for (const axis of ['ns', 'ew']) {
    const [e0, e1] = axis === 'ns' ? ['u0', 'u1'] : ['v0', 'v1'];
    for (const l of lanes) tiles.push({ id: `ground_road_${axis}_${l}`, edges: { [e0]: l[0], [e1]: l[1] } });
    for (const l of xwalks) tiles.push({ id: `ground_xwalk_${axis}_${l}`, edges: { [e0]: l[0], [e1]: l[1] }, crosswalk: axis === 'ns' ? 'u' : 'v' });
    tiles.push({ id: `ground_parking_${axis}`, stall: axis });
  }
  // Junction cells: plain asphalt, a curb on any edge that meets sidewalk.
  for (let m = 0; m < 16; m++) {
    const code = ['u0', 'u1', 'v0', 'v1'].map((e, i) => (m >> i) & 1 ? 'c' : 'n').join('');
    tiles.push({ id: `ground_junction_${code}`, edges: { u0: code[0], u1: code[1], v0: code[2], v1: code[3] } });
  }
  tiles.push({ id: 'ground_asphalt', edges: {} });
  return tiles;
}

function render(spec) {
  return paint(asphalt(), spec);
}

module.exports = { roadSet, render, asphalt, paint, grass, dirt };
