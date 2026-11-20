// Shared sphere math. No three.js here, because tools/build-globe.mjs runs this same file in Node.
// The globe uses Earth-fixed coordinates: +Y is the north pole, longitude 0 faces +Z, longitude 90°E faces +X.

export const DEG = Math.PI / 180;

export function latLonToVec(lat, lon) {
  const la = lat * DEG, lo = lon * DEG, c = Math.cos(la);
  return [c * Math.sin(lo), Math.sin(la), c * Math.cos(lo)];
}

export function vecToLatLon(x, y, z) {
  const r = Math.hypot(x, y, z) || 1;
  return [Math.asin(Math.max(-1, Math.min(1, y / r))) / DEG, Math.atan2(x, z) / DEG];
}

export function wrapLon(lon) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

// Great-circle distance in degrees.
export function angularDistance(lat1, lon1, lat2, lon2) {
  const a = latLonToVec(lat1, lon1), b = latLonToVec(lat2, lon2);
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.acos(Math.max(-1, Math.min(1, d))) / DEG;
}

/**
 * Geodesic icosphere: each icosahedron face is split into freq² triangles, then projected onto the unit sphere.
 * Only uses + - * / and sqrt, so Node and every browser produce the exact same vertex order, which is how the
 * per-vertex heights in globe/land.json line up with the mesh built at runtime.
 * Returns { positions: Float64Array (xyz per vertex), faces: Uint32Array (3 indices per triangle, CCW from outside) }.
 */
export function icosphere(freq) {
  const t = (1 + Math.sqrt(5)) / 2;
  const base = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const tris = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  const pos = [];
  const index = new Map();
  const vertex = (x, y, z) => {
    const r = Math.sqrt(x * x + y * y + z * z);
    x /= r; y /= r; z /= r;
    const key = `${Math.round(x * 1e6)},${Math.round(y * 1e6)},${Math.round(z * 1e6)}`;
    let i = index.get(key);
    if (i === undefined) {
      i = pos.length / 3;
      pos.push(x, y, z);
      index.set(key, i);
    }
    return i;
  };
  const faces = [];
  const n = freq;
  for (const [ia, ib, ic] of tris) {
    const A = base[ia], B = base[ib], C = base[ic];
    const grid = [];
    for (let i = 0; i <= n; i++) {
      grid[i] = [];
      for (let j = 0; j <= n - i; j++) {
        const x = A[0] + ((B[0] - A[0]) * i) / n + ((C[0] - A[0]) * j) / n;
        const y = A[1] + ((B[1] - A[1]) * i) / n + ((C[1] - A[1]) * j) / n;
        const z = A[2] + ((B[2] - A[2]) * i) / n + ((C[2] - A[2]) * j) / n;
        grid[i][j] = vertex(x, y, z);
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n - i; j++) {
        faces.push(grid[i][j], grid[i + 1][j], grid[i][j + 1]);
        if (i + j < n - 1) faces.push(grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]);
      }
    }
  }
  // Make every triangle wind counter-clockwise when seen from outside.
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f] * 3, b = faces[f + 1] * 3, c = faces[f + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * pos[a] + ny * pos[a + 1] + nz * pos[a + 2] < 0) {
      const tmp = faces[f + 1]; faces[f + 1] = faces[f + 2]; faces[f + 2] = tmp;
    }
  }
  return { positions: Float64Array.from(pos), faces: Uint32Array.from(faces) };
}

// Small deterministic hash → [0, 1). Used for per-face colour jitter and fake-free "randomness".
export function hash01(n) {
  let x = (n | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

export function base64ToBytes(b64) {
  if (typeof atob === 'function') {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}
