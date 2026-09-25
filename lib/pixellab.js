// Thin client for the PixelLab v2 REST API. Only the generation runner uses this;
// nothing downstream of raw/ should ever import it.
//
// Auth: set PIXELLAB_TOKEN. (In the Claude Code cloud sandbox the egress proxy
// injects the header for api.pixellab.ai, so the token can be left unset there.)
const BASE = process.env.PIXELLAB_BASE || 'https://api.pixellab.ai/v2';

async function post(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.PIXELLAB_TOKEN) headers.Authorization = `Bearer ${process.env.PIXELLAB_TOKEN}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, { method: 'POST', headers, body: JSON.stringify(body) });
    if (res.ok) return res.json();
    const text = await res.text();
    // 429 (rate or concurrent-job limit) and 5xx are worth retrying; other
    // 4xx means the request itself is wrong.
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      await new Promise(r => setTimeout(r, (res.status === 429 ? 5000 : 2000) * 2 ** Math.min(attempt, 4)));
      continue;
    }
    throw new Error(`PixelLab ${path} → ${res.status}: ${text.slice(0, 500)}`);
  }
}

const b64 = buf => ({ type: 'base64', base64: buf.toString('base64'), format: 'png' });
const decode = img => Buffer.from(img.base64.replace(/^data:image\/png;base64,/, ''), 'base64');

module.exports = { post, b64, decode };
