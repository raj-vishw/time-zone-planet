// Builds globe/land.json: which faces of the low-poly globe are land, what kind of land, and how high each vertex is.
// Run once: node tools/build-globe.mjs
// Land shapes: Natural Earth 1:50m land (public domain), via the world-atlas TopoJSON package.
// Heights are stylised: a hand-placed list of the big mountain ranges, plus a little per-vertex noise.
// City lights: Natural Earth 1:10m populated places (public domain), every place of 50k+ people.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { icosphere, vecToLatLon, latLonToVec, hash01, DEG } from '../src/geo.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FREQ = 24; // 20 × 24² = 11,520 faces
const SRC = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-50m.json';
const CACHE = join(ROOT, 'tools', '.cache', 'land-50m.json');
const PLACES_SRC = 'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@v5.1.2/geojson/ne_10m_populated_places_simple.geojson';
const PLACES_CACHE = join(ROOT, 'tools', '.cache', 'places-10m.geojson');
const MIN_POP = 50_000;

async function cached(src, cache) {
  try {
    return JSON.parse(await readFile(cache, 'utf8'));
  } catch {
    console.log('downloading', src);
    const res = await fetch(src);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    const text = await res.text();
    await mkdir(dirname(cache), { recursive: true });
    await writeFile(cache, text);
    return JSON.parse(text);
  }
}
const loadTopology = () => cached(SRC, CACHE);

// --- city lights: [lat, lon, weight 0..255] for every town of MIN_POP+, near-duplicates merged ---
// Packed as 5 bytes per place: int16 lat×100, int16 lon×100 (little-endian), uint8 weight (log of population).
async function buildLights() {
  const geo = await cached(PLACES_SRC, PLACES_CACHE);
  const all = [];
  for (const f of geo.features) {
    const pop = Number(f.properties.pop_max) || 0;
    const [lon, lat] = f.geometry?.coordinates || [];
    if (pop >= MIN_POP && Number.isFinite(lat) && Number.isFinite(lon)) all.push({ lat, lon, pop });
  }
  all.sort((a, b) => b.pop - a.pop);
  const kept = [];
  for (const c of all) {
    const k = Math.cos(c.lat * DEG);
    if (kept.some((o) => Math.abs(o.lat - c.lat) < 0.12 && Math.abs(((o.lon - c.lon + 540) % 360) - 180) * k < 0.12)) continue;
    kept.push(c);
  }
  const LO = Math.log10(MIN_POP), HI = 7.5; // ~32 million → 255
  const buf = Buffer.alloc(kept.length * 5);
  kept.forEach((c, i) => {
    buf.writeInt16LE(Math.round(c.lat * 100), i * 5);
    buf.writeInt16LE(Math.round(c.lon * 100), i * 5 + 2);
    buf.writeUInt8(Math.max(0, Math.min(255, Math.round((255 * (Math.log10(c.pop) - LO)) / (HI - LO)))), i * 5 + 4);
  });
  console.log(`city lights: ${kept.length} places of ${MIN_POP.toLocaleString()}+ (from ${all.length}, near-duplicates merged)`);
  const top = kept.slice(0, 3).map((c) => `${c.lat.toFixed(1)},${c.lon.toFixed(1)}`).join('  ');
  check(kept.length > 3000 && kept.length < 5000, `light count ${kept.length}`);
  check(kept.some((c) => Math.abs(c.lat - 35.7) < 0.3 && Math.abs(c.lon - 139.7) < 0.3), `Tokyo present (top: ${top})`);
  return buf.toString('base64');
}
function check(ok, what) {
  if (!ok) throw new Error('sanity check failed: ' + what);
  console.log('ok  ', what);
}

// --- TopoJSON → list of rings in [lon, lat] ---
function decodeRings(topo) {
  const { scale, translate } = topo.transform;
  const arcs = topo.arcs.map((arc) => {
    let x = 0, y = 0;
    return arc.map(([dx, dy]) => {
      x += dx; y += dy;
      return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
    });
  });
  const ring = (ids) => {
    const out = [];
    for (const id of ids) {
      const a = id < 0 ? arcs[~id].slice().reverse() : arcs[id];
      out.push(...(out.length ? a.slice(1) : a));
    }
    return out;
  };
  const rings = [];
  const walk = (g) => {
    if (g.type === 'GeometryCollection') g.geometries.forEach(walk);
    else if (g.type === 'Polygon') g.arcs.forEach((r) => rings.push(ring(r)));
    else if (g.type === 'MultiPolygon') g.arcs.forEach((p) => p.forEach((r) => rings.push(ring(r))));
  };
  walk(topo.objects.land);
  return rings.map((raw) => {
    // world-atlas is spherical: rings may cross the antimeridian. Unwrap longitudes so each ring is continuous
    // in the plane (it may then reach past ±180; isLand also tests lon ± 360 to match).
    const pts = [raw[0].slice()];
    for (let i = 1; i < raw.length; i++) {
      let x = raw[i][0];
      const px = pts[i - 1][0];
      while (x - px > 180) x -= 360;
      while (x - px < -180) x += 360;
      pts.push([x, raw[i][1]]);
    }
    // A ring that goes all the way round (Antarctica) doesn't close in the plane: close it via the pole.
    const drift = pts[pts.length - 1][0] - pts[0][0];
    if (Math.abs(drift) > 180) {
      const pole = pts.reduce((s, p) => s + p[1], 0) < 0 ? -90 : 90;
      pts.push([pts[pts.length - 1][0], pole], [pts[0][0], pole], pts[0].slice());
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of pts) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    return { pts, minX, maxX, minY, maxY };
  });
}

// Even-odd point-in-polygon over every ring (holes such as the Caspian count as water automatically).
function inRing(r, lon, lat) {
  if (lon < r.minX || lon > r.maxX || lat < r.minY || lat > r.maxY) return false;
  const p = r.pts;
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i], [xj, yj] = p[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function isLand(rings, lon, lat) {
  let inside = false;
  for (const r of rings) {
    if (inRing(r, lon, lat) || inRing(r, lon + 360, lat) || inRing(r, lon - 360, lat)) inside = !inside;
  }
  return inside;
}

// --- Stylised relief: [height 0..1, half-width in degrees, ...[lat, lon] points]. One point = a round massif. ---
const RANGES = [
  [1.0, 3.2, [35.5, 72], [34, 77], [30.5, 81], [28, 86], [27.6, 92], [28.4, 96.5]], // Himalaya
  [0.72, 7, [33, 86], [32, 92]], // Tibetan plateau
  [0.75, 2.6, [36, 70], [38.5, 73.5], [41.5, 78], [43, 85]], // Hindu Kush, Pamir, Tian Shan
  [0.55, 3, [49.5, 87.5], [47, 95]], // Altai
  [0.32, 5, [46, 101]], // Mongolian plateau
  [0.92, 2.4, [10, -73], [5, -75.8], [0, -78.2], [-6, -78.8], [-11, -76.5], [-16, -70.5], [-22, -67.5], [-30, -69.8], [-40, -71.3], [-48, -73], [-53, -72]], // Andes
  [0.62, 3.6, [62, -132], [57, -125], [51, -117], [46, -112], [41, -107], [36, -106]], // Rockies
  [0.42, 1.8, [49, -121], [44, -122], [39, -120.5], [36, -118.5]], // Cascades, Sierra Nevada
  [0.5, 3, [62.5, -152], [61, -143]], // Alaska Range
  [0.42, 2.6, [29, -108], [24, -105], [19.5, -101], [17, -97]], // Sierra Madre
  [0.25, 3, [47, -70], [42, -75], [38, -80], [34.5, -84]], // Appalachians
  [0.55, 1.4, [44, 6.8], [46, 8], [46.8, 10.5], [47, 13], [46.6, 15]], // Alps
  [0.32, 1.1, [42.8, -1.5], [42.6, 1.5]], // Pyrenees
  [0.3, 1.6, [45.5, 22.5], [47.5, 25]], // Carpathians
  [0.36, 2.4, [69.5, 19], [65, 14], [61.5, 8]], // Scandinavian mountains
  [0.3, 1.8, [67.5, 65.5], [61, 59], [53, 58.5]], // Urals
  [0.55, 1.5, [43.4, 40.5], [42, 47]], // Caucasus
  [0.35, 4.5, [39, 34]], // Anatolia
  [0.5, 3, [38, 45], [33.5, 48], [29, 54], [27.5, 57]], // Zagros
  [0.35, 5, [33, 58]], // Iranian plateau
  [0.38, 2, [31, -8], [33.5, -3], [35.5, 3], [36.2, 8]], // Atlas
  [0.32, 3, [21, 6], [23, 8]], // Hoggar / Aïr
  [0.55, 3.2, [10, 39], [7, 38]], // Ethiopian highlands
  [0.42, 2.6, [3, 36], [-1, 36.8], [-3, 37.3], [-8, 34]], // East African rift
  [0.33, 2.6, [-31, 27], [-28, 29.5], [-25, 31]], // Drakensberg
  [0.32, 2.4, [-14, 145], [-22, 148.5], [-30, 152], [-37, 148]], // Great Dividing Range
  [0.4, 1.6, [-46, 168], [-42, 172]], // Southern Alps NZ
  [0.45, 2, [-4, 136], [-5.5, 142], [-7, 146]], // New Guinea highlands
  [0.33, 1.8, [35, 136], [37, 138.5], [40, 140.5]], // Japan
  [0.33, 2.4, [56, 159], [60, 163]], // Kamchatka
  [0.3, 3, [64, 138], [60, 150]], // Verkhoyansk / Kolyma
  [0.22, 8, [-17, -46]], // Brazilian highlands
  [0.62, 11, [73, -40]], // Greenland ice dome
  [0.65, 22, [-82, 70]], // East Antarctic ice sheet
  [0.35, 8, [-79, -100]], // West Antarctica
];

const ICE_BOXES = [[59, 84, -74, -10]]; // Greenland [latMin, latMax, lonMin, lonMax]
const DESERTS = [
  // [lat, lon, radiusLat, radiusLon]
  [23, 8, 9, 19], [24.5, 25, 7, 8], [23, 46, 8, 11], [32.5, 57, 4, 7], [27, 69.5, 3, 3.5], [42, 103, 4.5, 10],
  [39, 84, 2.6, 6], [-25, 129, 7.5, 13], [-23, 19, 5, 6], [33.5, -112, 4, 6], [-24, -69.5, 4, 1.4],
];

function biomeFor(lat, lon) {
  if (lat < -60) return 2;
  for (const [a, b, c, d] of ICE_BOXES) if (lat >= a && lat <= b && lon >= c && lon <= d) return 2;
  if (Math.abs(lat) > 76) return 2;
  for (const [la, lo, rla, rlo] of DESERTS) {
    if (((lat - la) / rla) ** 2 + ((lon - lo) / rlo) ** 2 <= 1) return 1;
  }
  if (Math.abs(lat) > 60) return 3;
  return 0; // grass / forest
}

function rangeSamples() {
  const samples = [];
  for (const [h, w, ...pts] of RANGES) {
    if (pts.length === 1) { samples.push([latLonToVec(...pts[0]), h, w]); continue; }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = latLonToVec(...pts[i]), b = latLonToVec(...pts[i + 1]);
      const steps = 12;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const v = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        samples.push([v, h, w]);
      }
    }
  }
  return samples;
}

async function main() {
  const topo = await loadTopology();
  const rings = decodeRings(topo);
  console.log(`land rings: ${rings.length}, points: ${rings.reduce((n, r) => n + r.pts.length, 0)}`);

  // Sanity checks on known places before trusting the output.
  const checks = [
    ['Sahara', 23, 13, true], ['Pacific', 0, -150, false], ['Greenland', 72, -40, true], ['Antarctic interior', -85, 30, true],
    ['Caspian Sea', 42, 50.5, false], ['Paris', 48.86, 2.35, true], ['Atlantic', 30, -40, false], ['Chukotka (180°)', 66, 179.5, true],
  ];
  for (const [name, lat, lon, want] of checks) {
    const got = isLand(rings, lon, lat);
    console.log(`${got === want ? 'ok  ' : 'WARN'} ${name}: ${got ? 'land' : 'water'}`);
  }
  const antarcticOk = isLand(rings, 30, -85);

  const { positions: P, faces: F } = icosphere(FREQ);
  const nv = P.length / 3, nf = F.length / 3;
  const land = new Uint8Array(nf);
  const centroid = new Float64Array(nf * 3);

  for (let f = 0; f < nf; f++) {
    const a = F[f * 3] * 3, b = F[f * 3 + 1] * 3, c = F[f * 3 + 2] * 3;
    const cx = (P[a] + P[b] + P[c]) / 3, cy = (P[a + 1] + P[b + 1] + P[c + 1]) / 3, cz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
    centroid.set([cx, cy, cz], f * 3);
    // Sample the centre plus three points halfway to the corners; land wins on 2 of 4.
    let votes = 0;
    for (const v of [null, a, b, c]) {
      const x = v === null ? cx : (cx + P[v]) / 2, y = v === null ? cy : (cy + P[v + 1]) / 2, z = v === null ? cz : (cz + P[v + 2]) / 2;
      const [lat, lon] = vecToLatLon(x, y, z);
      if (isLand(rings, lon, lat) || (!antarcticOk && lat < -80)) votes++;
    }
    land[f] = votes >= 2 ? 1 : 0;
  }

  // Edge adjacency for the ocean-distance flood fill.
  const edgeMap = new Map();
  const neighbours = Array.from({ length: nf }, () => []);
  for (let f = 0; f < nf; f++) {
    for (let k = 0; k < 3; k++) {
      const u = F[f * 3 + k], w = F[f * 3 + ((k + 1) % 3)];
      const key = u < w ? `${u},${w}` : `${w},${u}`;
      const other = edgeMap.get(key);
      if (other === undefined) edgeMap.set(key, f);
      else { neighbours[f].push(other); neighbours[other].push(f); }
    }
  }
  const dist = new Int16Array(nf).fill(-1);
  let frontier = [];
  for (let f = 0; f < nf; f++) if (land[f]) { dist[f] = 0; frontier.push(f); }
  for (let d = 1; frontier.length && d < 16; d++) {
    const next = [];
    for (const f of frontier) for (const g of neighbours[f]) if (dist[g] < 0) { dist[g] = d; next.push(g); }
    frontier = next;
  }

  // Face code: ocean = distance to land (1..15), land = 64 + biome.
  const faceCode = new Uint8Array(nf);
  for (let f = 0; f < nf; f++) {
    if (land[f]) {
      const [lat, lon] = vecToLatLon(centroid[f * 3], centroid[f * 3 + 1], centroid[f * 3 + 2]);
      faceCode[f] = 64 + biomeFor(lat, lon);
    } else {
      faceCode[f] = dist[f] < 0 ? 15 : Math.min(15, dist[f]);
    }
  }

  // Vertex heights: only vertices with land on every side rise, so coastlines stay at sea level.
  const allLand = new Uint8Array(nv).fill(1), anyFace = new Uint8Array(nv);
  for (let f = 0; f < nf; f++) for (let k = 0; k < 3; k++) {
    const v = F[f * 3 + k];
    anyFace[v] = 1;
    if (!land[f]) allLand[v] = 0;
  }
  const samples = rangeSamples();
  const heights = new Uint8Array(nv);
  for (let v = 0; v < nv; v++) {
    if (!allLand[v] || !anyFace[v]) continue;
    const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
    let m = 0;
    for (const [s, h, w] of samples) {
      const d = Math.acos(Math.max(-1, Math.min(1, x * s[0] + y * s[1] + z * s[2]))) / DEG;
      if (d > w * 3) continue;
      const c = h * Math.exp(-((d / w) ** 2));
      if (c > m) m = c;
    }
    const h = 0.1 + m * 0.85 + hash01(v * 7 + 3) * (0.06 + m * 0.12);
    heights[v] = Math.max(1, Math.min(255, Math.round(h * 255)));
  }

  const landCount = land.reduce((n, x) => n + x, 0);
  console.log(`vertices ${nv}, faces ${nf}, land faces ${landCount} (${((landCount / nf) * 100).toFixed(1)}%; Earth is ~29%)`);

  const out = {
    about: 'Generated by tools/build-globe.mjs from Natural Earth 1:50m land and 1:10m populated places (public domain). Do not edit by hand.',
    freq: FREQ,
    heights: Buffer.from(heights).toString('base64'),
    faces: Buffer.from(faceCode).toString('base64'),
    lights: await buildLights(),
  };
  await mkdir(join(ROOT, 'globe'), { recursive: true });
  const file = join(ROOT, 'globe', 'land.json');
  await writeFile(file, JSON.stringify(out));
  console.log(`wrote ${file} (${(JSON.stringify(out).length / 1024).toFixed(1)} KB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
