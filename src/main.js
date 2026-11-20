import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createGlobe } from './globe.js';
import { createDots } from './dots.js';
import { createNet, placeKey } from './net.js';
import { createHud, placeName } from './hud.js';
import { PLACES } from './places.js';
import { sunVector, subsolarPoint, sunAltitude, isMorning, localTime, localHour, dawnLongitude } from './sun.js';
import { latLonToVec, vecToLatLon, wrapLon, angularDistance, DEG } from './geo.js';

const REPLAY_HOURS_PER_S = 0.5; // 24h in 48s
const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');
const coarse = matchMedia('(pointer: coarse)').matches;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const loading = document.getElementById('loading');
const canvas = document.getElementById('scene');

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch {
  loading.textContent = 'This page needs WebGL, which your browser has turned off or does not support.';
  loading.classList.add('error');
  throw new Error('WebGL unavailable');
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, coarse ? 1.75 : 2));
// Pure black: with the bloom composer, three r160 sRGB-encodes the clear colour twice, which turns a dark navy grey.
renderer.setClearColor(0x000000, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 500);
camera.position.set(0, 0.6, 3.6);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.enablePan = false;
controls.rotateSpeed = 0.55;
controls.zoomSpeed = 0.7;
controls.minDistance = 1.2; // close enough to see single mountain ranges
controls.maxDistance = 9;
controls.autoRotateSpeed = 0.35;

// --- state ---
const state = {
  offsetH: 0, // 0 = live, -24..0 = replay position
  playing: false,
  follow: false,
  interacted: false,
  lastInteraction: performance.now(),
  mode: 'connecting',
  live: { places: [], total: 0, countries: 0 },
  history: [],
  you: null,
  fly: null, // { from: Vector3, to: Vector3, t, dur }
};

const hud = createHud({
  onScrub(v) {
    state.playing = false;
    state.offsetH = v > -0.05 ? 0 : v;
    refreshDots();
  },
  onPlay() {
    if (state.playing) { state.playing = false; return; }
    if (state.offsetH > -0.25) state.offsetH = -24;
    state.playing = true;
    refreshDots();
  },
  onLive() {
    state.playing = false;
    state.offsetH = 0;
    refreshDots();
  },
  onFollow() {
    setFollow(!state.follow);
  },
  onFly(lat, lon) { flyTo(lat, lon); },
  onFlyYou() { if (state.you) flyTo(state.you.lat, state.you.lon); },
});

function setFollow(on) {
  state.follow = on;
  if (on) state.fly = null;
  hud.setFollow(on);
}

controls.addEventListener('start', () => {
  state.interacted = true;
  state.lastInteraction = performance.now();
  state.fly = null;
  if (state.follow) setFollow(false);
});
controls.addEventListener('end', () => { state.lastInteraction = performance.now(); });

// --- size: the planet fills ~82% of the screen height on wide screens and ~94% of the width on phones.
// The hour ring is wider than the planet; its side labels may run off a narrow screen, and that's fine. ---
const FILL_WIDE = 0.82, FILL_NARROW = 0.94;
function fitDistance() {
  const aspect = camera.aspect;
  const vHalf = (camera.fov / 2) * DEG;
  const narrow = aspect < 0.8;
  const half = narrow ? Math.atan(Math.tan(vHalf) * aspect) : vHalf;
  return 1 / Math.sin(half * (narrow ? FILL_NARROW : FILL_WIDE));
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // Nudge the planet up a little on wide screens so the time bar at the bottom covers less of it.
  if (w / h >= 0.8) camera.setViewOffset(w, h, 0, h * 0.025, w, h);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();
  composer?.setSize(w, h);
  if (!state.interacted) camera.position.setLength(fitDistance());
  controls.maxDistance = Math.max(9, fitDistance() * 1.8);
}
let composer = null;
window.addEventListener('resize', resize);
resize();

// --- camera moves ---
function flyTo(lat, lon) {
  setFollow(false);
  const dist = camera.position.length();
  const viewLat = Math.max(-50, Math.min(55, lat));
  const [x, y, z] = latLonToVec(viewLat, lon);
  state.fly = { from: camera.position.clone().normalize(), to: new THREE.Vector3(x, y, z), t: 0, dur: 1.4, dist };
  state.interacted = true;
  state.lastInteraction = performance.now();
}

function stepFly(dt) {
  const f = state.fly;
  if (!f) return;
  f.t = Math.min(1, f.t + dt / f.dur);
  const e = f.t < 0.5 ? 4 * f.t ** 3 : 1 - (-2 * f.t + 2) ** 3 / 2;
  const q = new THREE.Quaternion().setFromUnitVectors(f.from, f.to);
  const dir = f.from.clone().applyQuaternion(new THREE.Quaternion().slerp(q, e));
  camera.position.copy(dir.multiplyScalar(f.dist));
  if (f.t >= 1) state.fly = null;
}

function stepFollow(dt, ms) {
  if (!state.follow) return;
  const r = camera.position.length();
  const [lat, lon] = vecToLatLon(camera.position.x, camera.position.y, camera.position.z);
  const target = dawnLongitude(ms);
  const k = 1 - Math.exp(-dt * (state.playing ? 6 : 2.5));
  const newLon = lon + wrapLon(target - lon) * k;
  const newLat = lat + (Math.max(-30, Math.min(40, lat)) - lat) * k;
  const [x, y, z] = latLonToVec(newLat, newLon);
  camera.position.set(x * r, y * r, z * r);
}

// --- what's shown ---
function displayMs() {
  return Date.now() + state.offsetH * 3600000;
}

function bucketAt(ms) {
  if (!state.history.length) return null;
  const t = Math.floor(ms / 3600000) * 3600000;
  return state.history.find((h) => h.t === t) || null;
}

let dots = null;
let lastBucket = null;

/** Places visited in the last 24 h that nobody is at right now: { ...place, n: visits, lastT, earlier: true }. */
function earlierPlaces() {
  const since = Date.now() - 24 * 3600000;
  const skip = new Set(state.live.places.map(placeKey));
  if (state.you) skip.add(placeKey(state.you));
  const out = new Map();
  for (const h of state.history) {
    if (h.t + 3600000 <= since) continue;
    for (const p of h.places) {
      const key = placeKey(p);
      if (skip.has(key)) continue;
      const e = out.get(key);
      if (e) { e.n += p.n; e.lastT = Math.max(e.lastT, h.t); if (!e.tz && p.tz) e.tz = p.tz; }
      else out.set(key, { ...p, key, lastT: h.t, earlier: true });
    }
  }
  return [...out.values()];
}
let earlier = [];

function refreshDots() {
  if (!dots) return;
  const list = [];
  if (state.offsetH === 0 && !state.playing) {
    lastBucket = null;
    for (const p of state.live.places) list.push({ ...p, key: placeKey(p) });
    earlier = earlierPlaces();
    list.push(...earlier);
  } else {
    const b = bucketAt(displayMs());
    lastBucket = b;
    if (b) for (const p of b.places) list.push({ ...p, key: placeKey(p), replay: true });
  }
  if (state.you) list.push({ ...state.you, key: 'me', me: true, n: 1 });
  dots.setPlaces(list);
}

function wakingCount(ms) {
  let n = 0;
  for (const p of state.live.places) {
    const h = localHour(ms, p.tz, p.lon);
    if (h >= 5 && h < 9 && isMorning(p.lat, p.lon, ms)) n += p.n;
  }
  return n;
}

function updateStatus() {
  if (state.offsetH === 0 && !state.playing) {
    if (state.mode === 'offline' || state.mode === 'connecting') hud.setStatus(state.mode, 0, 0, 0);
    else hud.setStatus(state.mode, Math.max(state.live.total, state.you ? 1 : 0), state.live.countries, wakingCount(Date.now()));
    hud.setEarlier(state.mode === 'live' || state.mode === 'demo' ? earlier.length : 0);
  } else {
    hud.setEarlier(0);
    const b = lastBucket;
    hud.setReplayStatus(b ? b.places.reduce((s, p) => s + p.n, 0) : 0, b ? b.places.length : 0);
  }
}

function sunriseItems(ms) {
  const replay = state.offsetH !== 0 || state.playing;
  const visitors = replay ? lastBucket?.places || [] : state.live.places;
  const items = [];
  const consider = (p, n) => {
    const alt = sunAltitude(p.lat, p.lon, ms);
    if (alt < -6 || alt > 9 || !isMorning(p.lat, p.lon, ms)) return;
    items.push({ lat: p.lat, lon: p.lon, name: placeName(p), time: localTime(ms, p.tz, p.lon), alt, n });
  };
  for (const p of visitors) consider(p, p.n);
  const withVisitors = items.length;
  for (const p of PLACES) {
    if (items.slice(0, withVisitors).some((v) => angularDistance(v.lat, v.lon, p.lat, p.lon) < 3)) continue;
    consider(p, 0);
  }
  const vis = items.slice(0, withVisitors).sort((a, b) => b.n - a.n);
  const ref = items.slice(withVisitors).sort((a, b) => Math.abs(a.alt - 1) - Math.abs(b.alt - 1));
  return [...vis, ...ref].slice(0, 6);
}

function phaseOf(p, ms) {
  const alt = sunAltitude(p.lat, p.lon, ms);
  const morning = isMorning(p.lat, p.lon, ms);
  if (alt < -6) return ['night', ''];
  if (alt < 0) return [morning ? 'first light' : 'dusk', morning ? 'dawn' : 'dusk'];
  if (alt < 10) return [morning ? 'sunrise' : 'sunset', morning ? 'dawn' : 'dusk'];
  return ['day', ''];
}

function tipFor(p, ms) {
  const [phase, cls] = phaseOf(p, ms);
  const time = localTime(ms, p.tz, p.lon);
  if (p.me) {
    const where = p.approx ? 'placed from your time zone' : placeName(p);
    return `<div class="me"><b>You</b></div><div class="t">${time}</div><div class="m">${hud.esc(where)}</div><div class="m ${cls}">${phase}</div>`;
  }
  const visits = `${p.n} ${p.n === 1 ? 'visit' : 'visits'}`;
  let count = p.replay ? `${visits} that hour` : `${p.n} here now`;
  if (p.earlier) {
    const ago = Math.floor((Date.now() - p.lastT) / 3600000);
    count = `${visits} in the last 24 h</div><div class="m">last one ${ago < 1 ? 'under an hour' : `${ago} h`} ago`;
  }
  return `<div><b>${hud.esc(placeName(p))}</b></div><div class="t">${time}</div><div class="m ${cls}">${phase} · local time</div><div class="m">${count}</div>`;
}

function tipForGround(hit, ms) {
  const alt = sunAltitude(hit.lat, hit.lon, ms);
  const solar = localTime(ms, null, hit.lon);
  const [phase, cls] = phaseOf({ ...hit }, ms);
  const ll = `${Math.abs(hit.lat).toFixed(1)}°${hit.lat >= 0 ? 'N' : 'S'} ${Math.abs(hit.lon).toFixed(1)}°${hit.lon >= 0 ? 'E' : 'W'}`;
  return `<div class="m">${ll}</div><div class="t">${solar}</div><div class="m">sun time · sun ${alt >= 0 ? '+' : ''}${alt.toFixed(0)}°</div><div class="m ${cls}">${phase}</div>`;
}

// --- pointer: hover tips on desktop, tap tips on touch ---
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let pointer = null;
let tapTimer = 0;
let downAt = null;

canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse') pointer = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointerleave', () => { pointer = null; hud.hideTip(); });
canvas.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; if (e.pointerType !== 'mouse') hud.hideTip(); });
canvas.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'mouse' || !downAt) return;
  if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 8) return;
  showTipAt(e.clientX, e.clientY, true);
  clearTimeout(tapTimer);
  tapTimer = setTimeout(() => hud.hideTip(), 3500);
});

function showTipAt(x, y, touch) {
  if (!dots) return;
  const ms = displayMs();
  const p = dots.pick(x, y, camera, window.innerWidth, window.innerHeight, touch ? 28 : 16);
  if (p) { hud.showTip(x, y, tipFor(p, ms)); return; }
  ndc.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = globe.hitLatLon(raycaster.ray);
  if (hit) hud.showTip(x, y, tipForGround(hit, ms));
  else hud.hideTip();
}

// --- boot ---
let globe;
try {
  globe = await createGlobe(scene, 'globe/land.json');
} catch (err) {
  loading.textContent = 'Could not load the planet. Try reloading the page.';
  loading.classList.add('error');
  throw err;
}
dots = createDots(scene, globe);

// Start facing roughly where the visitor is, from their time zone offset, before the API answers.
{
  const offMin = -new Date().getTimezoneOffset();
  const [x, y, z] = latLonToVec(20, wrapLon((offMin / 60) * 15));
  camera.position.set(x, y, z).setLength(fitDistance());
}

const net = createNet(
  {
    onStatus(mode) {
      state.mode = mode;
      updateStatus();
    },
    onYou(you) {
      state.you = you;
      refreshDots();
      if (!state.interacted) {
        flyTo(you.lat, you.lon);
        state.interacted = false; // a fly on load isn't the user taking control
      }
    },
    onLive(live) {
      state.live = live;
      if (state.offsetH === 0 && !state.playing) refreshDots();
      updateStatus();
    },
    onHistory(hours) {
      state.history = hours;
      refreshDots();
      updateStatus();
    },
  },
  { demo: DEMO },
);
net.start();

// Bloom makes the dawn line and dots glow. Desktop only: it's the most expensive part of a frame.
if (!coarse && !params.has('nobloom')) {
  import('./bloom.js')
    .then(({ createBloom }) => {
      composer = createBloom(renderer, scene, camera);
      composer.setSize(window.innerWidth, window.innerHeight);
    })
    .catch(() => {});
}

// --- loop ---
const clock = new THREE.Clock();
let hudTimer = 0;
let lastBucketT = null;

function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);
  const time = clock.elapsedTime;

  if (state.playing) {
    state.offsetH = Math.min(0, state.offsetH + dt * REPLAY_HOURS_PER_S);
    if (state.offsetH >= 0) { state.offsetH = 0; state.playing = false; refreshDots(); }
  }
  const ms = displayMs();

  // Replay: swap the visible hour of visits as time crosses hour boundaries.
  if (state.offsetH !== 0 || state.playing) {
    const t = Math.floor(ms / 3600000);
    if (t !== lastBucketT) { lastBucketT = t; refreshDots(); updateStatus(); }
  } else lastBucketT = null;

  stepFly(dt);
  stepFollow(dt, ms);
  const idle = performance.now() - state.lastInteraction > 9000;
  controls.autoRotate = !reduceMotion && idle && !state.follow && !state.fly;
  controls.update();

  globe.update(sunVector(ms), time, ms, camera);
  dots.update(dt);

  hudTimer -= dt;
  if (hudTimer <= 0) {
    hudTimer = state.playing ? 0.1 : 0.25;
    hud.setClock(ms, state.offsetH, state.playing);
    const s = subsolarPoint(ms);
    hud.setSunPoint(s.lat, s.lon);
    hud.setSunrise(sunriseItems(ms), state.offsetH !== 0 || state.playing);
    hud.setYou(state.you, state.you ? localTime(ms, state.you.tz, state.you.lon) : '');
    updateStatus();
    if (pointer) showTipAt(pointer.x, pointer.y, false);
  }

  if (composer) composer.render();
  else renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

hud.setFollow(false);
updateStatus();
requestAnimationFrame(() => {
  loading.classList.add('gone');
  frame();
});

// For headless checks.
window.__tzp = { state, camera, scene, renderer, get composer() { return composer; }, get dots() { return dots; }, get globe() { return globe; }, net };
