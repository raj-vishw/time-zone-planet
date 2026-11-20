// Talks to the tiny API (heartbeat + live list + 24h history), or fakes it in ?demo mode.
// Modes: 'connecting' → 'live' | 'offline' | 'demo'.
import { PLACES, guessPlace } from './places.js';
import { localHour, zoneOffsetHours, isValidTimeZone } from './sun.js';
import { hash01 } from './geo.js';

const BEAT_MS = 60000;
const POLL_MS = 20000;
const HISTORY_MS = 10 * 60000;

function browserZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function sessionId() {
  let first = false, sid = null;
  try { sid = sessionStorage.getItem('tzp.sid'); } catch {}
  if (!sid) {
    first = true;
    sid = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now().toString(36)).toLowerCase();
    try { sessionStorage.setItem('tzp.sid', sid); } catch {}
  }
  return { sid, first };
}

export const placeKey = (p) => `${p.lat},${p.lon},${p.country || ''},${p.city || ''}`;

/**
 * handlers: onStatus(mode), onYou(place), onLive({ places, total, countries }), onHistory(hours)
 * hours: [{ t: hourStartMs, places: [...] }] oldest first.
 */
export function createNet(handlers, { demo = false } = {}) {
  const tz = browserZone();
  const offsetOf = (z) => zoneOffsetHours(Date.now(), z);
  let mode = 'connecting';
  let you = null;
  let failures = 0;
  const timers = [];

  const setMode = (m) => { if (m !== mode) { mode = m; handlers.onStatus?.(m); } };
  const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

  function fallbackYou() {
    const g = guessPlace(tz, offsetOf);
    return { lat: g.lat, lon: g.lon, city: g.city, country: g.country, tz, approx: true };
  }

  async function api(path, body) {
    const res = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.includes('json')) throw new Error(`${path}: ${res.status}`);
    return res.json();
  }

  const { sid, first } = sessionId();
  let firstBeat = first;

  async function beat() {
    if (!visible()) return;
    try {
      const r = await api('/api/beat', { sid, tz, first: firstBeat });
      firstBeat = false;
      failures = 0;
      if (r.you && (!you || you.lat !== r.you.lat || you.lon !== r.you.lon)) {
        you = r.you;
        handlers.onYou?.(you);
      }
      setMode('live');
    } catch {
      fail();
    }
  }

  async function poll() {
    if (!visible() || mode === 'offline') return;
    try {
      const r = await api('/api/live');
      failures = 0;
      handlers.onLive?.({ places: r.places || [], total: r.total || 0, countries: r.countries || 0 });
    } catch {
      fail();
    }
  }

  async function history() {
    if (mode !== 'live') return;
    try {
      const r = await api('/api/history');
      handlers.onHistory?.(r.hours || []);
    } catch {}
  }

  function fail() {
    failures++;
    // First contact failing means there's no API here (local static server). Later blips get a few retries.
    if (mode === 'connecting' || failures >= 3) {
      if (mode !== 'offline') {
        if (!you) { you = fallbackYou(); handlers.onYou?.(you); }
        handlers.onLive?.({ places: [], total: 0, countries: 0 });
        handlers.onHistory?.([]);
      }
      setMode('offline');
    }
  }

  // --- demo: believable but clearly-labelled fake traffic ---
  function demoCount(p, ms, salt) {
    const h = localHour(ms, p.tz, p.lon);
    // Asleep 1–5, waking 6–9, busy 10–23.
    const awake = h < 1 ? 0.35 : h < 5 ? 0.06 : h < 6 ? 0.15 : h < 9 ? 0.35 + (h - 6) * 0.2 : h < 23 ? 1 : 0.6;
    const r = hash01(Math.floor(ms / 60000 / (salt === 'h' ? 60 : 1)) * 131 + PLACES.indexOf(p) * 7919);
    return Math.max(0, Math.round(Math.pow(p.w, 0.55) * awake * (0.4 + r * 1.4) - 0.3));
  }

  function demoPlaces(ms, salt) {
    const out = [];
    for (const p of PLACES) {
      const n = demoCount(p, ms, salt);
      if (n > 0) out.push({ lat: p.lat, lon: p.lon, city: p.city, country: p.country, tz: p.tz, n });
    }
    return out;
  }

  function demoLive() {
    const places = demoPlaces(Date.now(), 'm');
    const total = places.reduce((s, p) => s + p.n, 0) + 1;
    handlers.onLive?.({ places, total, countries: new Set(places.map((p) => p.country)).size });
  }

  function demoHistory() {
    const now = Date.now(), hour = Math.floor(now / 3600000);
    const hours = [];
    for (let i = 24; i >= 0; i--) {
      const t = (hour - i) * 3600000;
      hours.push({ t, places: demoPlaces(t + 1800000, 'h') });
    }
    handlers.onHistory?.(hours);
  }

  return {
    get mode() { return mode; },
    get tz() { return tz; },
    start() {
      if (demo) {
        you = fallbackYou();
        handlers.onYou?.(you);
        setMode('demo');
        demoLive();
        demoHistory();
        timers.push(setInterval(demoLive, POLL_MS), setInterval(demoHistory, HISTORY_MS));
        return;
      }
      handlers.onStatus?.(mode);
      beat().then(() => { poll(); history(); });
      timers.push(setInterval(beat, BEAT_MS), setInterval(poll, POLL_MS), setInterval(history, HISTORY_MS));
      document.addEventListener('visibilitychange', () => {
        if (visible() && mode !== 'offline') { beat(); poll(); }
      });
    },
    validZone: isValidTimeZone(tz),
  };
}
