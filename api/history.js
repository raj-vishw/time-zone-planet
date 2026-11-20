// GET /api/history → { hours: [{ t, places: [{ lat, lon, country, city, tz, n }] }] }, oldest first.
// The last 25 hour buckets (24 full hours plus the current one). Cached on the CDN for 5 minutes.
import { configured, pipeline, json, addToGroups, HOUR_PREFIX } from './_redis.js';

export async function GET() {
  if (!configured()) return json({ error: 'storage not configured' }, 503);
  const current = Math.floor(Date.now() / 3600000);
  const ids = Array.from({ length: 25 }, (_, i) => current - 24 + i);
  let results;
  try {
    results = await pipeline(ids.map((h) => ['HGETALL', HOUR_PREFIX + h]));
  } catch {
    return json({ error: 'storage unavailable' }, 502);
  }
  const hours = ids.map((h, i) => {
    const flat = results[i] || [];
    const groups = new Map();
    for (let k = 0; k + 1 < flat.length; k += 2) {
      let t;
      try { t = JSON.parse(flat[k]); } catch { continue; }
      addToGroups(groups, t, parseInt(flat[k + 1], 10));
    }
    return { t: h * 3600000, places: [...groups.values()] };
  });
  return json({ hours }, 200, { 'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=300' });
}
