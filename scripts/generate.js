#!/usr/bin/env node
// Stage 2 — generation runner. Reads assets.json and calls PixelLab once per
// asset that doesn't have a raw/<id>.png yet. Writes the untouched PNG plus a
// sidecar raw/<id>.json recording exactly what was asked for.
//
//   node scripts/generate.js                 # everything missing
//   node scripts/generate.js --only a,b      # just these ids
//   node scripts/generate.js --force         # regenerate even if raw exists
//   node scripts/generate.js --dry-run       # print requests, spend nothing
//   node scripts/generate.js --only a --candidates 6 [--seed-offset 10]
//        # try 6 seeds into candidates/<id>/ instead of raw/ (see contact sheet);
//        # the offset moves on to fresh seeds after a batch with no keeper
//   node scripts/generate.js --adopt a:1234  # pin seed 1234 in assets.json and
//        # move that candidate into raw/ (it *is* what the pinned request returns)
//   node scripts/generate.js --adopt a:1235:a_b  # keep another candidate as a
//        # new variant entry a_b (same request, its own pinned seed)
const fs = require('fs');
const path = require('path');
const palette = require('../lib/palette');
const { post, b64, decode } = require('../lib/pixellab');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const flag = f => args.includes(f);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : [];
const nCandidates = args.includes('--candidates') ? +args[args.indexOf('--candidates') + 1] : 0;
const seedOffset = args.includes('--seed-offset') ? +args[args.indexOf('--seed-offset') + 1] : 0;
const CONCURRENCY = +process.env.CONCURRENCY || 4;

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets.json'), 'utf8'));
const D = manifest.defaults;
const pal = palette.load(path.join(ROOT, D.palette));
const colorImage = b64(palette.swatchPng(pal));

function request(asset) {
  const body = {
    ...D.params,
    ...D.typeParams?.[asset.type],
    ...asset.params,
    description: [D.style, D.typeStyle?.[asset.type], asset.prompt].filter(Boolean).join(', '),
    image_size: { width: asset.size[0], height: asset.size[1] },
    color_image: colorImage,
    seed: asset.seed ?? hashSeed(asset.id),
  };
  // A null in the manifest removes an inherited default (pixflux has no coverage_percentage).
  for (const k of Object.keys(body)) if (body[k] === null) delete body[k];
  if (asset.init === 'reference') {
    const ref = path.join(ROOT, manifest.reference);
    if (!fs.existsSync(ref)) throw new Error(`${asset.id} conditions on ${manifest.reference}, which doesn't exist yet — run make-reference first`);
    body.init_image = b64(fs.readFileSync(ref));
  }
  return { endpoint: asset.endpoint || D.endpoint, body };
}

// Stable per-id seed, so a --force regeneration is reproducible unless the
// manifest pins a different seed.
function hashSeed(s) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0) % 1e9;
}

function adopt(spec) {
  const [id, seedStr, newId] = spec.split(':');
  const seed = +seedStr, dir = path.join(ROOT, 'candidates', id);
  const src = path.join(dir, `seed_${seed}.png`);
  if (!fs.existsSync(src)) throw new Error(`no candidate ${path.relative(ROOT, src)}`);
  const file = path.join(ROOT, 'assets.json');
  let text = fs.readFileSync(file, 'utf8');
  const at = text.indexOf(`"id": "${id}",`);
  if (at < 0) throw new Error(`${id} not found in assets.json`);
  // An asset entry is one {...} object; find its extent by brace depth.
  const start = text.lastIndexOf('{', at);
  let depth = 0, end = start;
  for (; end < text.length; end++) { if (text[end] === '{') depth++; if (text[end] === '}' && --depth === 0) break; }
  end++;
  const target = newId || id;
  // Pin the seed with a text edit so the manifest's formatting survives.
  const entry = text.slice(start, end).replace(/ "seed": \d+,/, '').replace(`"id": "${id}",`, `"id": "${target}", "seed": ${seed},`);
  if (newId) {
    // A second keeper from the same candidates: a new variant entry right after the original.
    if (text.includes(`"id": "${newId}",`)) throw new Error(`${newId} already exists`);
    text = text.slice(0, end) + ',\n    ' + entry + text.slice(end);
  } else {
    text = text.slice(0, start) + entry + text.slice(end);
  }
  JSON.parse(text);
  fs.writeFileSync(file, text);
  fs.mkdirSync(path.join(ROOT, 'raw'), { recursive: true });
  fs.copyFileSync(src, path.join(ROOT, 'raw', `${target}.png`));
  const meta = JSON.parse(fs.readFileSync(src.replace(/\.png$/, '.json'), 'utf8'));
  fs.writeFileSync(path.join(ROOT, 'raw', `${target}.json`), JSON.stringify({ ...meta, id: target, adoptedFrom: `${id}:${seed}` }, null, 2) + '\n');
  console.log(`adopted ${id} seed ${seed}${newId ? ` as ${newId}` : ''}`);
}

async function main() {
  if (args.includes('--adopt')) return args.slice(args.indexOf('--adopt') + 1).filter(a => !a.startsWith('--')).forEach(adopt);
  if (nCandidates && !only.length) throw new Error('--candidates needs --only');
  let todo = manifest.assets.filter(a =>
    !a.derive && !a.source && !a.procedural && (!only.length || only.includes(a.id)) &&
    (nCandidates || flag('--force') || !fs.existsSync(path.join(ROOT, 'raw', `${a.id}.png`))));
  // Each candidate is the manifest request with only the seed changed.
  if (nCandidates) todo = todo.flatMap(a => Array.from({ length: nCandidates }, (_, i) => ({ ...a, seed: hashSeed(a.id) + seedOffset + i + 1, candidate: true })));

  if (!todo.length) return console.log('nothing to generate (use --force to regenerate)');

  let failed = 0;
  const queue = [...todo];
  const worker = async () => {
    for (let a; (a = queue.shift());) {
      const { endpoint, body } = request(a);
      const record = { id: a.id, endpoint, ...body, color_image: '<palette.json>', init_image: body.init_image ? `<${manifest.reference}>` : undefined };
      if (flag('--dry-run')) { console.log(JSON.stringify(record)); continue; }
      try {
        const res = await post(endpoint, body);
        const out = a.candidate
          ? path.join(ROOT, 'candidates', a.id, `seed_${body.seed}.png`)
          : path.join(ROOT, 'raw', `${a.id}.png`);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, decode(res.image));
        fs.writeFileSync(out.replace(/\.png$/, '.json'), JSON.stringify({ ...record, usage: res.usage, generatedAt: new Date().toISOString() }, null, 2) + '\n');
        console.log(`✓ ${a.id}${a.candidate ? ` seed ${body.seed}` : ''}`);
      } catch (e) {
        failed++;
        console.error(`✗ ${a.id}: ${e.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (failed) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exit(1); });
