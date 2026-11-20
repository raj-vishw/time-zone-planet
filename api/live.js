// GET /api/live → { now, total, countries, places: [{ lat, lon, country, city, tz, n }] }
// Grouped by place, never includes session ids. Cached on Vercel's CDN for 15 s, so Redis sees a few reads
// a minute however many people are watching.
import { configured, pipeline, json, addToGroups, pruneLive, LIVE_KEY } from './_redis.js';

export async function GET() {
  if (!configured()) return json({ error: 'storage not configured' }, 503);
  const now = Date.now();
  let members;
  try {
    const out = await pipeline([...pruneLive(now), ['ZRANGE', LIVE_KEY, 0, -1]]);
    members = out[out.length - 1];
  } catch {
    return json({ error: 'storage unavailable' }, 502);
  }
  const groups = new Map();
  for (const m of members || []) {
    let t;
    try { t = JSON.parse(m); } catch { continue; }
    addToGroups(groups, t, 1);
  }
  const places = [...groups.values()];
  const total = places.reduce((s, p) => s + p.n, 0);
  const countries = new Set(places.map((p) => p.country).filter(Boolean)).size;
  return json({ now, total, countries, places }, 200, {
    'Cache-Control': 'public, max-age=0, s-maxage=15, stale-while-revalidate=15',
  });
}
