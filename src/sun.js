// Where the sun is. The low-precision formulas from the Astronomical Almanac are good to about 0.01°,
// which is far finer than one face of the globe.
import { DEG, latLonToVec, wrapLon } from './geo.js';

/** Subsolar point (where the sun is straight overhead) for a time in ms. Returns { lat, lon } in degrees. */
export function subsolarPoint(ms) {
  const n = ms / 86400000 + 2440587.5 - 2451545.0; // days since J2000.0
  const L = (280.46 + 0.9856474 * n) % 360; // mean longitude
  const g = ((357.528 + 0.9856003 * n) % 360) * DEG; // mean anomaly
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG; // ecliptic longitude
  const eps = (23.439 - 0.0000004 * n) * DEG; // obliquity
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const gmst = (280.46061837 + 360.98564736629 * n) % 360; // Greenwich sidereal time, degrees
  return { lat: dec / DEG, lon: wrapLon(ra / DEG - gmst) };
}

/** Unit vector toward the sun in globe coordinates. */
export function sunVector(ms) {
  const { lat, lon } = subsolarPoint(ms);
  return latLonToVec(lat, lon);
}

/** Sun elevation above the horizon in degrees at a place (Earth treated as a point; fine at this scale). */
export function sunAltitude(lat, lon, ms) {
  const s = sunVector(ms), p = latLonToVec(lat, lon);
  return Math.asin(Math.max(-1, Math.min(1, s[0] * p[0] + s[1] * p[1] + s[2] * p[2]))) / DEG;
}

/** True when the sun is rising at this place (morning side of the planet). */
export function isMorning(lat, lon, ms) {
  // The sun is east of a place in the morning. East at lon is the +lon direction, so compare longitudes.
  const { lon: sl } = subsolarPoint(ms);
  return wrapLon(sl - lon) > 0;
}

/** Longitude where the dawn line crosses the equator. */
export function dawnLongitude(ms) {
  return wrapLon(subsolarPoint(ms).lon - 90);
}

const fmtCache = new Map();
function formatter(tz) {
  let f = fmtCache.get(tz);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    } catch {
      f = null;
    }
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz) {
  return typeof tz === 'string' && tz.length > 0 && tz.length < 64 && formatter(tz) !== null;
}

/** "HH:MM" local time in an IANA zone. Falls back to mean solar time at lon when the zone is unknown. */
export function localTime(ms, tz, lon = 0) {
  const f = tz && formatter(tz);
  if (f) return f.format(ms);
  return utcHHMM(ms + (lon / 15) * 3600000);
}

/** Local hour as a fraction (e.g. 7.5 for 07:30). */
export function localHour(ms, tz, lon = 0) {
  const [h, m] = localTime(ms, tz, lon).split(':').map(Number);
  return h + m / 60;
}

export function utcHHMM(ms) {
  const d = new Date(ms);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** Offset of an IANA zone from UTC, in hours, at a given time. */
export function zoneOffsetHours(ms, tz) {
  const f = formatter(tz);
  if (!f) return null;
  let diff = localHour(ms, tz) - (new Date(ms).getUTCHours() + new Date(ms).getUTCMinutes() / 60);
  if (diff > 14) diff -= 24;
  if (diff < -12) diff += 24;
  return Math.round(diff * 4) / 4;
}
