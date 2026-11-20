// Runs the api/ handlers against a tiny in-memory stand-in for Upstash's REST pipeline. Run: node tools/test-api.mjs
import { startFakeRedis } from './fake-redis.mjs';

const redis = await startFakeRedis();
const zset = redis.zset;

let fail = 0;
const check = (name, ok, extra = '') => { if (!ok) fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`); };

// Not configured yet → 503.
{
  const { GET } = await import('../api/live.js');
  check('503 without storage env', (await GET()).status === 503);
}
process.env.KV_REST_API_URL = redis.url;
process.env.KV_REST_API_TOKEN = 'test-token';

const beat = (await import('../api/beat.js')).POST;
const live = (await import('../api/live.js')).GET;
const history = (await import('../api/history.js')).GET;

const req = (body, headers = {}) => new Request('http://x/api/beat', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const pune = { 'x-vercel-ip-latitude': '18.5204', 'x-vercel-ip-longitude': '73.8567', 'x-vercel-ip-city': 'Pune', 'x-vercel-ip-country': 'IN' };
const sp = { 'x-vercel-ip-latitude': '-23.55', 'x-vercel-ip-longitude': '-46.63', 'x-vercel-ip-city': 'S%C3%A3o%20Paulo', 'x-vercel-ip-country': 'BR' };

let r = await beat(req({ sid: 'aaaaaaaa-1111', tz: 'Asia/Kolkata', first: true }, pune));
let j = await r.json();
check('beat 200', r.status === 200);
check('location rounded to 0.5°', j.you.lat === 18.5 && j.you.lon === 74, JSON.stringify(j.you));
check('no IP in response', !JSON.stringify(j).includes('ip'));
await beat(req({ sid: 'bbbbbbbb-2222', tz: 'Asia/Kolkata', first: true }, pune));
await beat(req({ sid: 'bbbbbbbb-2222', tz: 'Asia/Kolkata', first: false }, pune)); // same tab again: no double count
check('repeat heartbeat is one Redis command', redis.lastCommands.join() === 'ZADD', redis.lastCommands.join());
j = await (await beat(req({ sid: 'cccccccc-3333', tz: 'America/Sao_Paulo', first: true }, sp))).json();
check('city header is URI-decoded', j.you.city === 'São Paulo', j.you.city);
j = await (await beat(req({ sid: 'dddddddd-4444', tz: 'Europe/Berlin', first: true }))).json();
check('no geo headers → time-zone fallback', j.you.approx === true && j.you.country === 'DE', JSON.stringify(j.you));

check('bad sid → 400', (await beat(req({ sid: 'x', tz: 'UTC' }, pune))).status === 400);
check('bad json → 400', (await beat(new Request('http://x', { method: 'POST', body: '{nope' }))).status === 400);
j = await (await beat(req({ sid: 'eeeeeeee-5555', tz: '../../etc', first: false }, pune))).json();
check('junk tz is dropped', j.you.tz === '', JSON.stringify(j.you));

// A tab that went quiet 3 minutes ago is pruned.
zset('tzp:live').set(JSON.stringify([10, 10, 'XX', 'Ghost', 'UTC', 'ffffffff-6666']), Date.now() - 180000);

r = await live();
j = await r.json();
const puneN = j.places.filter((p) => p.city === 'Pune').reduce((s, p) => s + p.n, 0);
check('live groups by place', puneN === 3 && j.places.filter((p) => p.city === 'Pune').length === 1, JSON.stringify(j.places));
check('live total', j.total === 5, `total=${j.total}`);
check('stale tab pruned', !j.places.some((p) => p.city === 'Ghost'));
check('live has no session ids', !JSON.stringify(j).includes('aaaaaaaa'));
// Flood past the cap without anyone polling: live must still cap the set before reading it.
for (let i = 0; i < 5010; i++) zset('tzp:live').set(JSON.stringify([1, 1, 'ZZ', 'Flood', '', `flood-${i}`]), Date.now() - 1000);
r = await live();
check('live caps the set at 5000', zset('tzp:live').size === 5000 && (await r.json()).total === 5000, `size=${zset('tzp:live').size}`);
r = await live();
check('live is CDN-cacheable', /s-maxage=15/.test(r.headers.get('cache-control')));

r = await history();
j = await r.json();
const last = j.hours[j.hours.length - 1];
check('history has 25 hourly buckets', j.hours.length === 25);
check('history counts first visits only', last.places.reduce((s, p) => s + p.n, 0) === 4, JSON.stringify(last.places));

console.log(`(${redis.calls} pipeline calls, ${redis.commands} commands)`);
redis.close();
process.exit(fail ? 1 : 0);
