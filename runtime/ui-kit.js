// Grind City UI kit — draws sprites from dist/ui.png + dist/ui.json.
//
//   import { loadUI } from './ui-kit.js';
//   const ui = await loadUI('assets/ui/');
//   ui.icon('icon_cash', 2)                  → <canvas> at integer scale
//   ui.nineSlice('panel', 320, 200, 2)       → <canvas> stretched without
//                                              distorting corners/edges
//   ui.url('button_primary', 160, 40, 2)     → data: URL, for CSS backgrounds
//   ui.progress(0.6, 160, 12, 2)             → <canvas> progress bar (code-drawn)
//
// Sizes are in UI pixels; `scale` multiplies them (integer only, so pixels
// stay crisp). Sprites with a `slice` [top, right, bottom, left] stretch only
// their middle; others scale uniformly.

export async function loadUI(base = './') {
  const kit = await fetch(base + 'ui.json').then(r => r.json());
  const image = new Image();
  image.src = base + kit.image;
  await image.decode();
  const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').imageSmoothingEnabled = false; return c; };
  const frame = id => { const f = kit.frames[id]; if (!f) throw new Error(`no UI sprite "${id}"`); return f; };

  function icon(id, scale = 1) {
    const f = frame(id), c = canvas(f.w * scale, f.h * scale);
    c.getContext('2d').drawImage(image, f.x, f.y, f.w, f.h, 0, 0, c.width, c.height);
    return c;
  }

  function nineSlice(id, w, h, scale = 1) {
    const f = frame(id);
    if (!f.slice) { const c = canvas(w * scale, h * scale); c.getContext('2d').drawImage(image, f.x, f.y, f.w, f.h, 0, 0, c.width, c.height); return c; }
    const [t, r, b, l] = f.slice, c = canvas(w * scale, h * scale), g = c.getContext('2d');
    const sx = [0, l, f.w - r, f.w], sy = [0, t, f.h - b, f.h];
    const dx = [0, l, w - r, w], dy = [0, t, h - b, h];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      const sw = sx[i + 1] - sx[i], shh = sy[j + 1] - sy[j], dw = dx[i + 1] - dx[i], dh = dy[j + 1] - dy[j];
      if (sw > 0 && shh > 0 && dw > 0 && dh > 0) g.drawImage(image, f.x + sx[i], f.y + sy[j], sw, shh, dx[i] * scale, dy[j] * scale, dw * scale, dh * scale);
    }
    return c;
  }

  const url = (id, w, h, scale = 1) => nineSlice(id, w, h, scale).toDataURL();

  // Progress bar in the kit's colours: dark frame, recessed track, brass fill
  // with a highlight row. Drawn in code so any length stays pixel-exact.
  function progress(t, w, h, scale = 1, fill = '#C9A444') {
    const c = canvas(w * scale, h * scale), g = c.getContext('2d');
    const px = (x, y, ww, hh, col) => { g.fillStyle = col; g.fillRect(x * scale, y * scale, ww * scale, hh * scale); };
    px(1, 0, w - 2, h, '#1B1C1F'); px(0, 1, w, h - 2, '#1B1C1F');
    px(1, 1, w - 2, h - 2, '#4A2A25');
    const fw = Math.round((w - 2) * Math.max(0, Math.min(1, t)));
    if (fw > 0) { px(1, 1, fw, h - 2, fill); px(1, 1, fw, 1, '#E8C878'); px(1, h - 2, fw, 1, '#8A4E40'); }
    return c;
  }

  return { kit, image, icon, nineSlice, url, progress };
}
