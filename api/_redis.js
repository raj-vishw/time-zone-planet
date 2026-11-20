// Minimal Upstash Redis client over its REST API: plain fetch, no npm packages.
// Files starting with "_" inside api/ are helpers, not routes.
// Vercel's Upstash integration sets KV_REST_API_URL / KV_REST_API_TOKEN; a direct Upstash setup uses the UPSTASH_ names.

const env = (...names) => names.map((n) => process.env[n]).find(Boolean);

export const LIVE_KEY = 'tzp:live';
export const HOUR_PREFIX = 'tzp:h:';
export const LIVE_MS = 120_000; // a tab that hasn't beaten for 2 minutes is gone
export const MAX_LIVE = 5000;

/** Drop tabs that went quiet, then cap the set at MAX_LIVE (newest kept). */
export function pruneLive(now) {
  return [
    ['ZREMRANGEBYSCORE', LIVE_KEY, '-inf', now - LIVE_MS],
    ['ZREMRANGEBYRANK', LIVE_KEY, 0, -(MAX_LIVE + 1)],
  ];
}

export function configured() {
  return Boolean(env('KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL') && env('KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN'));
}

/** Run several commands in one round trip. Returns each command's result, or throws on any error. */
export async function pipeline(commands) {
  const url = env('KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL');
  const token = env('KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN');
  const res = await fetch(`${url.replace(/\/$/, '')}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands.map((c) => c.map(String))),
  });
  if (!res.ok) throw new Error(`redis ${res.status}`);
  const out = await res.json();
  return out.map((r) => {
    if (r.error) throw new Error(`redis: ${r.error}`);
    return r.result;
  });
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

/** Place tuple stored in Redis: [lat, lon, country, city, tz]. */
export function placeFromTuple(t) {
  if (!Array.isArray(t) || t.length < 5) return null;
  const [lat, lon, country, city, tz] = t;
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  return { lat, lon, country: String(country || ''), city: String(city || ''), tz: String(tz || '') };
}

/** Add n visitors at tuple t to a Map of places, merging by location + city (time zone may differ or be blank). */
export function addToGroups(groups, t, n) {
  const p = placeFromTuple(t);
  if (!p || !(n > 0)) return;
  const key = `${p.lat},${p.lon},${p.country},${p.city}`;
  const g = groups.get(key);
  if (!g) groups.set(key, { ...p, n });
  else {
    g.n += n;
    if (!g.tz && p.tz) g.tz = p.tz;
  }
}
