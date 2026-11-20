// In-memory stand-in for Upstash's REST pipeline: just the commands api/ uses.
import http from 'node:http';

export async function startFakeRedis(token = 'test-token') {
  const zsets = new Map(), hashes = new Map();
  const zset = (k) => zsets.get(k) || (zsets.set(k, new Map()), zsets.get(k));
  const sorted = (k) => [...zset(k).entries()].sort((a, b) => a[1] - b[1]);
  const num = (s) => (s === '-inf' ? -Infinity : s === '+inf' ? Infinity : Number(s));

  function run([cmd, key, ...a]) {
    switch (cmd) {
      case 'ZADD': zset(key).set(a[1], Number(a[0])); return 1;
      case 'ZREMRANGEBYSCORE': {
        let n = 0;
        for (const [m, s] of zset(key)) if (s >= num(a[0]) && s <= num(a[1])) { zset(key).delete(m); n++; }
        return n;
      }
      case 'ZREMRANGEBYRANK': {
        const all = sorted(key), len = all.length;
        let start = Number(a[0]), stop = Number(a[1]);
        if (start < 0) start += len;
        if (stop < 0) stop += len;
        let n = 0;
        for (let i = Math.max(0, start); i <= Math.min(len - 1, stop); i++) { zset(key).delete(all[i][0]); n++; }
        return n;
      }
      case 'ZRANGE': return sorted(key).map(([m]) => m);
      case 'HINCRBY': {
        const h = hashes.get(key) || new Map();
        hashes.set(key, h);
        h.set(a[0], (h.get(a[0]) || 0) + Number(a[1]));
        return h.get(a[0]);
      }
      case 'EXPIRE': return 1;
      case 'HGETALL': return [...(hashes.get(key) || new Map())].flatMap(([f, v]) => [f, String(v)]);
      default: throw new Error('unsupported ' + cmd);
    }
  }

  let calls = 0, commands = 0, lastCommands = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls++;
      if (req.headers.authorization !== `Bearer ${token}` || req.url !== '/pipeline') { res.writeHead(401).end(); return; }
      const cmds = JSON.parse(body);
      commands += cmds.length;
      lastCommands = cmds.map((c) => c[0]);
      const out = cmds.map((c) => { try { return { result: run(c) }; } catch (e) { return { error: e.message }; } });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, token, zset, close: () => server.close(), get calls() { return calls; }, get commands() { return commands; }, get lastCommands() { return lastCommands; } };
}
