#!/usr/bin/env node
// The human step. contact-sheet.html shows every sprite in the atlas at 1x and
// 3x, grouped by type, on the project background — plus rejects and any
// pending seed candidates. Open it after every generation batch and scan for
// drift: off-palette colour, wrong apparent scale, inconsistent light.
// Self-contained (images inlined) so it can be opened or shared as one file.
const fs = require('fs');
const path = require('path');
const png = require('../lib/png');
const { run, Reject } = require('./process');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets.json'), 'utf8'));
const palette = JSON.parse(fs.readFileSync(path.join(ROOT, manifest.defaults.palette), 'utf8'));
const atlas = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'atlas.json'), 'utf8'));
const atlasW = png.read(path.join(ROOT, 'dist', atlas.image)).width;
const atlasUri = 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'dist', atlas.image)).toString('base64');
const uri = file => 'data:image/png;base64,' + fs.readFileSync(file).toString('base64');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// One atlas frame, cropped with CSS, at integer scale k.
function frame(id, f, k) {
  const marks = [[f.anchorX, f.anchorY, 'anchor'], ...Object.entries(f.sockets || {}).map(([n, [x, y]]) => [x, y, `socket:${n}`])]
    .map(([x, y, t]) => `<i class="mark ${t === 'anchor' ? 'a' : 's'}" style="left:${x * k}px;top:${y * k}px" title="${t} (${x},${y})"></i>`).join('');
  return `<div class="spr" style="width:${f.w * k}px;height:${f.h * k}px;background-image:url(${atlasUri});background-position:${-f.x * k}px ${-f.y * k}px;background-size:${atlasW * k}px auto">${marks}</div>`;
}

const groups = {};
for (const [id, f] of Object.entries(atlas.frames)) (groups[f.type] ||= []).push([id, f]);
const order = ['ground', 'building', 'overlay', 'prop'];

let html = '';
for (const type of [...order, ...Object.keys(groups).filter(t => !order.includes(t))]) {
  if (!groups[type]) continue;
  html += `<h2>${type} <small>${groups[type].length}</small></h2><div class="row">`;
  for (const [id, f] of groups[type]) {
    const fp = f.footprint ? ` · ${f.footprint.join('×')}` : '';
    html += `<figure><div class="pair">${frame(id, f, 1)}${frame(id, f, 3)}</div><figcaption><b>${esc(id)}</b><br>${f.w}×${f.h} · anchor ${f.anchorX},${f.anchorY}${fp}${f.attach ? ` · attach ${f.attach}` : ''}</figcaption></figure>`;
  }
  html += '</div>';
}

// Rejects from the last process run.
const rejDir = path.join(ROOT, 'rejected');
const rejects = fs.existsSync(rejDir) ? fs.readdirSync(rejDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(rejDir, f), 'utf8'))) : [];
if (rejects.length) {
  html += `<h2>rejected <small>${rejects.length}</small></h2><div class="row">`;
  for (const r of rejects) {
    const img = path.join(rejDir, `${r.id}.png`);
    html += `<figure class="bad">${fs.existsSync(img) ? `<img src="${uri(img)}" style="zoom:2">` : ''}<figcaption><b>${esc(r.id)}</b><br>${esc(r.reason)}</figcaption></figure>`;
  }
  html += '</div>';
}

// Seed candidates, each put through the real Stage 3 so you see the verdict.
const candDir = path.join(ROOT, 'candidates');
if (fs.existsSync(candDir)) {
  for (const id of fs.readdirSync(candDir).sort()) {
    const asset = manifest.assets.find(a => a.id === id);
    if (!asset) continue;
    html += `<h2>candidates · ${esc(id)} <small>pin one with <code>node scripts/generate.js --adopt ${esc(id)}:&lt;seed&gt;</code></small></h2><div class="row">`;
    for (const f of fs.readdirSync(path.join(candDir, id)).filter(f => f.endsWith('.png')).sort()) {
      const seed = f.match(/seed_(\d+)/)[1];
      let img = png.read(path.join(candDir, id, f)), verdict, out;
      try { out = run(asset, img).img; verdict = 'passes Stage 3'; } catch (e) { if (!(e instanceof Reject)) throw e; verdict = e.message; }
      const shown = out ? 'data:image/png;base64,' + png.toBuffer(out).toString('base64') : uri(path.join(candDir, id, f));
      html += `<figure class="${out ? '' : 'bad'}"><img src="${shown}" style="zoom:2"><figcaption><b>seed ${seed}</b>${asset.seed == seed ? ' (pinned)' : ''}<br>${esc(verdict)}</figcaption></figure>`;
    }
    html += '</div>';
  }
}

const swatches = palette.colors.map(c => `<span style="background:${c}" title="${c}"></span>`).join('');
const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Grind City Contact Sheet</title>
<style>
:root{--bg:${palette.background};--ink:#2B1D14;--muted:#6A645C;--bad:#9C5040}
*{box-sizing:border-box}body{margin:0;padding:16px 24px 48px;background:var(--bg);color:var(--ink);font:13px/1.4 ui-monospace,Menlo,Consolas,monospace}
h1{font-size:18px;margin:0 0 4px}h2{font-size:14px;margin:28px 0 10px;border-bottom:1px solid #0002;padding-bottom:4px}h2 small{color:var(--muted);font-weight:normal}
.pal{display:flex;flex-wrap:wrap;gap:2px;margin:8px 0}.pal span{width:18px;height:18px;border:1px solid #0002}
.row{display:flex;flex-wrap:wrap;gap:20px;align-items:flex-end}
figure{margin:0;max-width:100%}figcaption{margin-top:6px;color:var(--muted)}figcaption b{color:var(--ink)}
.pair{display:flex;gap:12px;align-items:flex-end}
.spr{position:relative;image-rendering:pixelated;background-repeat:no-repeat;outline:1px dashed #0000}
body.guides .spr{outline-color:#0003}
.mark{display:none;position:absolute;width:7px;height:7px;margin:-3px 0 0 -3px;border-radius:50%}
body.guides .mark{display:block}.mark.a{background:#d33;box-shadow:0 0 0 1px #fff}.mark.s{background:#36c;box-shadow:0 0 0 1px #fff}
img{image-rendering:pixelated}.bad figcaption{color:var(--bad)}
label{cursor:pointer;user-select:none}
</style></head><body>
<h1>Grind City · contact sheet</h1>
<div>${Object.keys(atlas.frames).length} sprites in atlas · ${rejects.length} rejected · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}</div>
<div class="pal">${swatches}</div>
<label><input type="checkbox" id="g"> show bounds, anchors (red) and sockets (blue)</label>
${html}
<script>document.getElementById('g').onchange=e=>document.body.classList.toggle('guides',e.target.checked)</script>
</body></html>
`;
fs.writeFileSync(path.join(ROOT, 'contact-sheet.html'), page);
console.log(`contact-sheet.html: ${Object.keys(atlas.frames).length} sprites, ${rejects.length} rejects`);
