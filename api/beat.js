// POST /api/beat  { sid, tz, first }
// Records that this tab is here right now. Location comes from Vercel's geo headers, rounded to 0.5° (~50 km).
// The IP address is never read or stored. Returns the coarse place so the page can draw "you".
import { configured, pipeline, json, pruneLive, LIVE_KEY, HOUR_PREFIX } from './_redis.js';
import { isValidTimeZone, zoneOffsetHours } from '../src/sun.js';
import { guessPlace } from '../src/places.js';

const SID = /^[a-z0-9-]{8,40}$/;
const round = (x) => Math.round(x * 2) / 2;

function header(req, name) {
  const v = req.headers.get(name);
  if (!v) return '';
  try { return decodeURIComponent(v); } catch { return v; }
}

export async function POST(req) {
  if (!configured()) return json({ error: 'storage not configured' }, 503);
  if (Number(req.headers.get('content-length') || 0) > 1024) return json({ error: 'too large' }, 413);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const sid = typeof body?.sid === 'string' ? body.sid.toLowerCase() : '';
  if (!SID.test(sid)) return json({ error: 'bad sid' }, 400);
  const tz = isValidTimeZone(body.tz) ? body.tz : '';

  let lat = parseFloat(header(req, 'x-vercel-ip-latitude'));
  let lon = parseFloat(header(req, 'x-vercel-ip-longitude'));
  let city = header(req, 'x-vercel-ip-city').slice(0, 48);
  let country = header(req, 'x-vercel-ip-country').slice(0, 2).toUpperCase();
  let approx = false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    // No geo headers (local `vercel dev`, or an unknown IP): fall back to the browser's time zone.
    const g = guessPlace(tz || 'UTC', (z) => zoneOffsetHours(Date.now(), z));
    ({ lat, lon } = g);
    city = '';
    country = g.country || '';
    approx = true;
  }
  lat = round(lat);
  lon = round(lon);
  if (lon === -180) lon = 180;

  const place = [lat, lon, country, city, tz];
  const now = Date.now();
  // A repeat heartbeat is a single Redis command. Pruning lives in /api/live (CDN-cached, so it runs a few times a
  // minute at most); a session's first beat also prunes, so the set stays capped even if nobody is polling.
  const cmds = [['ZADD', LIVE_KEY, now, JSON.stringify([...place, sid])]];
  if (body.first === true) {
    // One count per session per hour bucket: this is what the 24h replay and the faint "earlier" dots show.
    const key = HOUR_PREFIX + Math.floor(now / 3600000);
    cmds.push(
      ...pruneLive(now),
      ['HINCRBY', key, JSON.stringify(place), 1],
      ['EXPIRE', key, 26 * 3600],
    );
  }
  try {
    await pipeline(cmds);
  } catch {
    return json({ error: 'storage unavailable' }, 502);
  }
  return json({ you: { lat, lon, city, country, tz, approx } });
}

export function GET() {
  return json({ error: 'POST only' }, 405, { Allow: 'POST' });
}
