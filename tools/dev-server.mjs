// Local dev server: serves the site and runs the real api/ handlers, so live mode works without Vercel.
// Run: node tools/dev-server.mjs   (then open http://localhost:8730)
// With no KV_REST_API_URL / KV_REST_API_TOKEN in the environment it uses an in-memory Redis stand-in.
// There are no geo headers locally, so you are placed from your time zone. To fake other visitors:
//   curl -X POST localhost:8730/api/beat -H "x-vercel-ip-latitude: 35.7" -H "x-vercel-ip-longitude: 139.7" \
//        -H "x-vercel-ip-city: Tokyo" -H "x-vercel-ip-country: JP" -d '{"sid":"test-tokyo-1","tz":"Asia/Tokyo","first":true}'
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startFakeRedis } from './fake-redis.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8730);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

if (!process.env.KV_REST_API_URL && !process.env.UPSTASH_REDIS_REST_URL) {
  const fake = await startFakeRedis('dev');
  process.env.KV_REST_API_URL = fake.url;
  process.env.KV_REST_API_TOKEN = 'dev';
  console.log('using in-memory Redis (nothing is saved)');
}

const handlers = {};
async function api(name) {
  if (!/^[a-z]+$/.test(name)) return null;
  if (!(name in handlers)) {
    try { handlers[name] = await import(pathToFileURL(join(ROOT, 'api', `${name}.js`)).href); } catch { handlers[name] = null; }
  }
  return handlers[name];
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const mod = await api(url.pathname.slice(5));
      const fn = mod?.[req.method];
      if (!fn) { res.writeHead(mod ? 405 : 404).end(); return; }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const request = new Request(url, {
        method: req.method,
        headers: Object.entries(req.headers).filter(([, v]) => typeof v === 'string'),
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
      });
      const out = await fn(request);
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(Buffer.from(await out.arrayBuffer()));
      return;
    }
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    if (path === '' || path.endsWith('/') || path.endsWith('\\')) path += 'index.html';
    const file = join(ROOT, path);
    if (!file.startsWith(ROOT) || /(^|[/\\])(tools|api|node_modules)([/\\]|$)|^\./.test(path)) { res.writeHead(404).end(); return; }
    if (!(await stat(file)).isFile()) throw new Error('not a file');
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Time-Zone Planet on http://localhost:${PORT}`));
