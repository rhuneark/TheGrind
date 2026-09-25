#!/usr/bin/env node
// Static server for preview/ (fetch() doesn't work over file://).
//   node scripts/serve.js [port=8080]  →  http://localhost:8080/preview/
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
const port = +process.argv[2] || 8080;
http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const idx = path.join(file, 'index.html');
    if (file.startsWith(ROOT) && fs.existsSync(idx)) return fs.createReadStream(idx).pipe(res.writeHead(200, { 'Content-Type': 'text/html' }));
    return res.writeHead(404).end('not found');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(port, () => console.log(`http://localhost:${port}/preview/`));
