// Builds globe/land.json: which faces of the low-poly globe are land, what colour each face is, how high each vertex
// is, and where the city lights go.
// Run once: node tools/build-globe.mjs   (needs the dev-only `jpeg-js`: run `npm install` first)
// Sources, all public domain, downloaded once into tools/.cache:
//   - Land shapes: Natural Earth 1:50m land, via the world-atlas TopoJSON package.
//   - Face colours: NASA Blue Marble (land plus ocean-depth shading). Heights: NASA topography. Coast check: NASA
//     water mask. These are the copies three-globe ships with its examples.
//   - City lights: Natural Earth 1:10m populated places, every place of 50k+ people.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import jpeg from 'jpeg-js';
import { icosphere, vecToLatLon, hash01, DEG } from '../src/geo.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FREQ = 48; // 20 × 48² = 46,080 faces
const SRC = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-50m.json';
const CACHE = join(ROOT, 'tools', '.cache', 'land-50m.json');
const PLACES_SRC = 'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@v5.1.2/geojson/ne_10m_populated_places_simple.geojson';
const PLACES_CACHE = join(ROOT, 'tools', '.cache', 'places-10m.geojson');
const IMG_SRC = 'https://cdn.jsdelivr.net/npm/three-globe@2.31.0/example/img/';
const MIN_POP = 50_000;

async function cachedBytes(src, cache) {
  try {
    return await readFile(cache);
  } catch {
    console.log('downloading', src);
    const res = await fetch(src);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await mkdir(dirname(cache), { recursive: true });
    await writeFile(cache, buf);
    return buf;
  }
}
const cached = async (src, cache) => JSON.parse((await cachedBytes(src, cache)).toString('utf8'));
const loadTopology = () => cached(SRC, CACHE);
const loadImageBytes = (name) => cachedBytes(IMG_SRC + name, join(ROOT, 'tools', '.cache', name));

function check(ok, what) {
  if (!ok) throw new Error('sanity check failed: ' + what);
  console.log('ok  ', what);
}

// --- images ---

/** Minimal PNG reader: 8-bit, non-interlaced, greyscale / RGB / RGBA. Returns { w, h, ch, data }. */
function decodePng(buf) {
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20), depth = buf[24], type = buf[25], interlace = buf[28];
  const ch = { 0: 1, 2: 3, 6: 4 }[type];
  if (depth !== 8 || !ch || interlace) throw new Error(`unsupported PNG (depth ${depth}, type ${type}, interlace ${interlace})`);
  const idat = [];
  for (let i = 8; i < buf.length; ) {
    const len = buf.readUInt32BE(i), kind = buf.toString('ascii', i + 4, i + 8);
    if (kind === 'IDAT') idat.push(buf.subarray(i + 8, i + 8 + len));
    i += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch, data = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? data[row + x - ch] : 0;
      const b = y ? data[row - stride + x] : 0;
      const c = x >= ch && y ? data[row - stride + x - ch] : 0;
      let v = raw[src + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      data[row + x] = v & 255;
    }
  }
  return { w, h, ch, data };
}

async function loadImages() {
  const colour = jpeg.decode(await loadImageBytes('earth-blue-marble.jpg'), { useTArray: true, maxMemoryUsageInMB: 1024 });
  return {
    colour: { w: colour.width, h: colour.height, ch: 4, data: colour.data },
    topo: decodePng(await loadImageBytes('earth-topology.png')),
    water: decodePng(await loadImageBytes('earth-water.png')),
  };
}

/** Bilinear sample of an equirectangular image at lat/lon, channel c, 0..255. */
function sample(img, lat, lon, c = 0) {
  const x = ((lon + 180) / 360) * img.w - 0.5;
  const y = Math.max(0, Math.min(img.h - 1.001, ((90 - lat) / 180) * img.h - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const at = (xx, yy) => img.data[(yy * img.w + (((xx % img.w) + img.w) % img.w)) * img.ch + c];
  const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
  const bot = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
  return top * (1 - fy) + bot * fy;
}
const toLin = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toSrgb = (v) => Math.round(255 * Math.max(0, Math.min(1, v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055)));

/** k-means palette over sRGB colours. Returns { palette: [[r,g,b], ...], index } with index into this palette. */
function quantize(colours, k) {
  const n = colours.length;
  if (!n) return { palette: [], index: new Uint16Array(0) };
  k = Math.min(k, n);
  // Seed with colours spread evenly through the set sorted by brightness, so darks and brights both get entries.
  const order = colours.map((c, i) => [c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11, i]).sort((a, b) => a[0] - b[0]);
  let cent = Array.from({ length: k }, (_, j) => colours[order[Math.floor(((j + 0.5) / k) * n)][1]].slice());
  const index = new Uint16Array(n);
  for (let it = 0; it < 14; it++) {
    const sum = Array.from({ length: k }, () => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      const c = colours[i];
      let best = 0, bd = Infinity;
      for (let j = 0; j < k; j++) {
        const e = cent[j], d = (c[0] - e[0]) ** 2 * 0.3 + (c[1] - e[1]) ** 2 * 0.59 + (c[2] - e[2]) ** 2 * 0.11;
        if (d < bd) { bd = d; best = j; }
      }
      index[i] = best;
      const s = sum[best];
      s[0] += c[0]; s[1] += c[1]; s[2] += c[2]; s[3]++;
    }
    cent = cent.map((e, j) => (sum[j][3] ? [sum[j][0] / sum[j][3], sum[j][1] / sum[j][3], sum[j][2] / sum[j][3]] : e));
  }
  return { palette: cent.map((e) => e.map((v) => Math.round(v))), index };
}

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

const unit = (lat, lon) => [Math.cos(lat * DEG) * Math.sin(lon * DEG), Math.sin(lat * DEG), Math.cos(lat * DEG) * Math.cos(lon * DEG)];

async function main() {
  const t0 = Date.now();
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
  console.log(`land mask done (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

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

  // Face code: ocean = distance to land in faces (1..15), land = 64.
  const faceCode = new Uint8Array(nf);
  for (let f = 0; f < nf; f++) faceCode[f] = land[f] ? 64 : dist[f] < 0 ? 15 : Math.min(15, dist[f]);

  // Face colours from Blue Marble: average a grid of points inside each face in linear light, keeping only points whose
  // water-mask class matches the face, so a coastal land face doesn't pick up the sea (or a sea face the beach).
  const img = await loadImages();
  console.log(`images: colour ${img.colour.w}x${img.colour.h}, topography ${img.topo.w}x${img.topo.h}, water ${img.water.w}x${img.water.h}x${img.water.ch}`);
  check(sample(img.water, 0, -150) > 127 && sample(img.water, 23, 13) < 128, 'water mask: Pacific wet, Sahara dry');
  const BARY = [];
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5 - i; j++) BARY.push([(i + 1 / 3) / 5, (j + 1 / 3) / 5]);
  const faceRgb = new Array(nf);
  for (let f = 0; f < nf; f++) {
    const a = F[f * 3] * 3, b = F[f * 3 + 1] * 3, c = F[f * 3 + 2] * 3;
    const match = [0, 0, 0, 0], any = [0, 0, 0, 0];
    for (const [u, w] of BARY) {
      const t = 1 - u - w;
      const [lat, lon] = vecToLatLon(
        P[a] * u + P[b] * w + P[c] * t, P[a + 1] * u + P[b + 1] * w + P[c + 1] * t, P[a + 2] * u + P[b + 2] * w + P[c + 2] * t,
      );
      const wet = sample(img.water, lat, lon, 0) > 127;
      const r = toLin(sample(img.colour, lat, lon, 0)), g = toLin(sample(img.colour, lat, lon, 1)), bl = toLin(sample(img.colour, lat, lon, 2));
      any[0] += r; any[1] += g; any[2] += bl; any[3]++;
      if (wet === !land[f]) { match[0] += r; match[1] += g; match[2] += bl; match[3]++; }
    }
    const use = match[3] ? match : any;
    faceRgb[f] = [toSrgb(use[0] / use[3]), toSrgb(use[1] / use[3]), toSrgb(use[2] / use[3])];
  }

  // 256-colour palette: 168 entries for land (where the detail is), 88 for the ocean.
  const landIdx = [], seaIdx = [];
  for (let f = 0; f < nf; f++) (land[f] ? landIdx : seaIdx).push(f);
  const qL = quantize(landIdx.map((f) => faceRgb[f]), 168);
  const qS = quantize(seaIdx.map((f) => faceRgb[f]), 256 - qL.palette.length);
  const palette = Buffer.alloc(256 * 3), colourIdx = new Uint8Array(nf);
  [...qL.palette, ...qS.palette].forEach((c, i) => palette.set(c, i * 3));
  landIdx.forEach((f, i) => (colourIdx[f] = qL.index[i]));
  seaIdx.forEach((f, i) => (colourIdx[f] = qL.palette.length + qS.index[i]));
  let err = 0;
  for (let f = 0; f < nf; f++) {
    const o = colourIdx[f] * 3;
    err += Math.abs(palette[o] - faceRgb[f][0]) + Math.abs(palette[o + 1] - faceRgb[f][1]) + Math.abs(palette[o + 2] - faceRgb[f][2]);
  }
  console.log(`palette: ${qL.palette.length} land + ${qS.palette.length} sea colours, mean error ${(err / nf / 3).toFixed(1)}/255 per channel`);

  // Vertex heights from NASA topography. Only vertices with land on every side rise, so coastlines stay at sea level.
  // Each vertex blends the mean and the max of a small neighbourhood, so peaks survive the coarse mesh.
  const allLand = new Uint8Array(nv).fill(1), anyFace = new Uint8Array(nv);
  for (let f = 0; f < nf; f++) for (let k = 0; k < 3; k++) {
    const v = F[f * 3 + k];
    anyFace[v] = 1;
    if (!land[f]) allLand[v] = 0;
  }
  const heights = new Uint8Array(nv);
  const R = 0.7; // degrees, about half the vertex spacing
  for (let v = 0; v < nv; v++) {
    if (!allLand[v] || !anyFace[v]) continue;
    const [lat, lon] = vecToLatLon(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
    const k = 1 / Math.max(0.15, Math.cos(lat * DEG));
    let sum = 0, max = 0, n = 0;
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
      const t = sample(img.topo, lat + (i * R) / 2, lon + ((j * R) / 2) * k, 0) / 255;
      sum += t; n++;
      if (t > max) max = t;
    }
    const t = 0.55 * (sum / n) + 0.45 * max;
    const h = 0.05 + 0.95 * Math.pow(t, 0.8) + hash01(v * 7 + 3) * 0.02; // a little jitter keeps flat plains faceted
    heights[v] = Math.max(1, Math.min(255, Math.round(h * 255)));
  }

  // Sanity checks on the real data.
  const nearest = (lat, lon, count, pos) => {
    const [x, y, z] = unit(lat, lon);
    let best = 0, bd = -2;
    for (let i = 0; i < count; i++) {
      const d = pos[i * 3] * x + pos[i * 3 + 1] * y + pos[i * 3 + 2] * z;
      if (d > bd) { bd = d; best = i; }
    }
    return best;
  };
  const hAt = (lat, lon) => heights[nearest(lat, lon, nv, P)] / 255;
  const rgbAt = (lat, lon) => [...palette.subarray(colourIdx[nearest(lat, lon, nf, centroid)] * 3, colourIdx[nearest(lat, lon, nf, centroid)] * 3 + 3)];
  check(hAt(31, 88) > 0.6, `Tibet is high (${hAt(31, 88).toFixed(2)})`);
  check(hAt(-20, -67.5) > 0.45, `Altiplano is high (${hAt(-20, -67.5).toFixed(2)})`);
  check(hAt(-80, 60) > 0.45, `East Antarctic ice is high (${hAt(-80, 60).toFixed(2)})`);
  check(hAt(52, 30) < 0.3, `Belarus plain is low (${hAt(52, 30).toFixed(2)})`);
  check(hAt(-3, -60) < 0.25, `Amazon basin is low (${hAt(-3, -60).toFixed(2)})`);
  const sahara = rgbAt(23, 13), amazon = rgbAt(-3, -60), pacific = rgbAt(0, -150);
  check(sahara[0] > sahara[2] + 40, `Sahara is sandy (rgb ${sahara})`);
  check(amazon[1] >= amazon[0] && amazon[1] > amazon[2], `Amazon is green (rgb ${amazon})`);
  check(pacific[2] > pacific[0] + 10, `Pacific is blue (rgb ${pacific})`);

  const landCount = land.reduce((n, x) => n + x, 0);
  console.log(`vertices ${nv}, faces ${nf}, land faces ${landCount} (${((landCount / nf) * 100).toFixed(1)}%; Earth is ~29%)`);

  const out = {
    about: 'Generated by tools/build-globe.mjs from Natural Earth (land, populated places) and NASA Blue Marble + topography (public domain). Do not edit by hand.',
    freq: FREQ,
    heights: Buffer.from(heights).toString('base64'),
    faces: Buffer.from(faceCode).toString('base64'),
    palette: palette.toString('base64'),
    colours: Buffer.from(colourIdx).toString('base64'),
    lights: await buildLights(),
  };
  await mkdir(join(ROOT, 'globe'), { recursive: true });
  const file = join(ROOT, 'globe', 'land.json');
  await writeFile(file, JSON.stringify(out));
  console.log(`wrote ${file} (${(JSON.stringify(out).length / 1024).toFixed(1)} KB) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
