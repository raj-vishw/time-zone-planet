// The planet: low-poly mesh, day/night/dawn shader, the dawn light curtain, atmosphere, sun glow, stars, hour ring.
import * as THREE from 'three';
import { icosphere, base64ToBytes, hash01, latLonToVec, vecToLatLon } from './geo.js';

export const RELIEF = 0.05; // the highest land (Everest region) as a fraction of the planet radius: ~50× real

// Face colours come from NASA Blue Marble (via build-globe), stored as a 256-colour palette. The raw imagery is dark,
// so it's graded here: a curve that lifts shadows and mid-tones but rolls off the highlights, so deserts and ice don't
// blow out. The sea gets a stronger lift so the light continental shelves read against the deep ocean.
const grade = (v, k) => 1 - Math.pow(1 - v, k);
const LAND_LIFT = 1.5, SEA_LIFT = 1.75, LAND_SAT = 1.15;

// Shared GLSL: where is this point relative to the dawn line?
const DAWN_GLSL = /* glsl */ `
  // s > 0 on the day side. morning > 0 where the sun is to the east, i.e. the side that is waking up.
  void dawnInfo(vec3 p, vec3 sun, out float s, out float morning) {
    s = dot(p, sun);
    vec3 east = vec3(p.z, 0.0, -p.x);
    float el = length(east);
    morning = el > 1e-4 ? dot(east / el, sun) : 0.0;
  }
`;

export async function createGlobe(scene, landUrl) {
  const data = await (await fetch(landUrl)).json();
  const heights = base64ToBytes(data.heights);
  const codes = base64ToBytes(data.faces);
  const { positions: P, faces: F } = icosphere(data.freq);
  const nv = P.length / 3, nf = F.length / 3;
  if (heights.length !== nv || codes.length !== nf) throw new Error('globe/land.json does not match the mesh');

  const radius = new Float32Array(nv);
  for (let v = 0; v < nv; v++) radius[v] = 1 + (heights[v] / 255) * RELIEF;

  // Vertices bucketed into 6° cells, so a surface lookup checks a few dozen vertices instead of all of them.
  const CELL = 6, ROWS = 180 / CELL, COLS = 360 / CELL;
  const cells = Array.from({ length: ROWS * COLS }, () => []);
  const cellOf = (lat, lon) => {
    const r = Math.min(ROWS - 1, Math.floor((lat + 90) / CELL));
    const c = ((Math.floor((lon + 180) / CELL) % COLS) + COLS) % COLS;
    return [r, c];
  };
  for (let v = 0; v < nv; v++) {
    const [lat, lon] = vecToLatLon(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
    const [r, c] = cellOf(lat, lon);
    cells[r * COLS + c].push(v);
  }
  function surfaceRadius(lat, lon) {
    const [x, y, z] = latLonToVec(lat, lon);
    const [r0, c0] = cellOf(lat, lon);
    // Near the poles a cell is narrow in longitude, so take whole rows there.
    const polar = Math.abs(lat) > 66;
    const cFrom = polar ? 0 : c0 - 1, cTo = polar ? COLS - 1 : c0 + 1;
    let b1 = -2, b2 = -2, b3 = -2, r1 = 1, r2 = 1, r3 = 1;
    for (let r = Math.max(0, r0 - 1); r <= Math.min(ROWS - 1, r0 + 1); r++) {
      for (let c = cFrom; c <= cTo; c++) {
        for (const v of cells[r * COLS + ((c % COLS) + COLS) % COLS]) {
          const d = P[v * 3] * x + P[v * 3 + 1] * y + P[v * 3 + 2] * z;
          if (d > b3) {
            if (d > b1) { b3 = b2; r3 = r2; b2 = b1; r2 = r1; b1 = d; r1 = radius[v]; }
            else if (d > b2) { b3 = b2; r3 = r2; b2 = d; r2 = radius[v]; }
            else { b3 = d; r3 = radius[v]; }
          }
        }
      }
    }
    return Math.max(r1, r2, r3);
  }

  // Palette (sRGB bytes) → graded linear colours, once per palette entry.
  const palBytes = base64ToBytes(data.palette), colourIdx = base64ToBytes(data.colours);
  if (colourIdx.length !== nf) throw new Error('globe/land.json colours do not match the mesh');
  const palLand = [], palSea = [];
  for (let i = 0; i < palBytes.length / 3; i++) {
    const r = palBytes[i * 3] / 255, g = palBytes[i * 3 + 1] / 255, b = palBytes[i * 3 + 2] / 255;
    const land = new THREE.Color().setRGB(grade(r, LAND_LIFT), grade(g, LAND_LIFT), grade(b, LAND_LIFT), THREE.SRGBColorSpace);
    const hsl = {};
    land.getHSL(hsl);
    land.setHSL(hsl.h, Math.min(1, hsl.s * LAND_SAT), hsl.l);
    palLand.push(land);
    palSea.push(new THREE.Color().setRGB(grade(r, SEA_LIFT), grade(g, SEA_LIFT), grade(b, SEA_LIFT), THREE.SRGBColorSpace));
  }

  // The imagery is noisy at this scale, which reads as a mosaic. Blend each face with the faces around its corners
  // (land with land, sea with sea, so coasts stay crisp). Facets still show through the lighting and the jitter.
  const base = new Float32Array(nf * 3), acc = new Float32Array(nv * 8); // per vertex: land rgb+n, sea rgb+n
  for (let f = 0; f < nf; f++) {
    const isLand = codes[f] >= 64, src = (isLand ? palLand : palSea)[colourIdx[f]];
    base[f * 3] = src.r; base[f * 3 + 1] = src.g; base[f * 3 + 2] = src.b;
    for (let k = 0; k < 3; k++) {
      const o = F[f * 3 + k] * 8 + (isLand ? 0 : 4);
      acc[o] += src.r; acc[o + 1] += src.g; acc[o + 2] += src.b; acc[o + 3]++;
    }
  }
  const SMOOTH = 0.55;

  const pos = new Float32Array(nf * 9), col = new Float32Array(nf * 9), kind = new Float32Array(nf * 3);
  const c = new THREE.Color();
  for (let f = 0; f < nf; f++) {
    for (let k = 0; k < 3; k++) {
      const v = F[f * 3 + k], r = radius[v];
      pos[f * 9 + k * 3] = P[v * 3] * r;
      pos[f * 9 + k * 3 + 1] = P[v * 3 + 1] * r;
      pos[f * 9 + k * 3 + 2] = P[v * 3 + 2] * r;
    }
    const isLand = codes[f] >= 64;
    let r = 0, g = 0, b = 0, n = 0;
    for (let k = 0; k < 3; k++) {
      const o = F[f * 3 + k] * 8 + (isLand ? 0 : 4);
      r += acc[o]; g += acc[o + 1]; b += acc[o + 2]; n += acc[o + 3];
    }
    c.setRGB(
      base[f * 3] * (1 - SMOOTH) + (r / n) * SMOOTH,
      base[f * 3 + 1] * (1 - SMOOTH) + (g / n) * SMOOTH,
      base[f * 3 + 2] * (1 - SMOOTH) + (b / n) * SMOOTH,
    );
    c.multiplyScalar(0.96 + hash01(f + 99991) * 0.07); // a touch of per-face jitter keeps the facets readable
    for (let k = 0; k < 3; k++) {
      col[f * 9 + k * 3] = c.r; col[f * 9 + k * 3 + 1] = c.g; col[f * 9 + k * 3 + 2] = c.b;
      kind[f * 3 + k] = isLand ? 1 : 0;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aKind', new THREE.BufferAttribute(kind, 1));
  geo.computeVertexNormals(); // non-indexed → one flat normal per face
  geo.computeBoundingSphere();

  const uniforms = {
    uSun: { value: new THREE.Vector3(0, 0, 1) },
    uTime: { value: 0 },
  };

  const globeMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      attribute vec3 color;
      attribute float aKind;
      varying vec3 vColor; varying vec3 vNormal; varying vec3 vPos; varying float vKind;
      void main() {
        vColor = color; vNormal = normal; vPos = position; vKind = aKind;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun; uniform float uTime;
      varying vec3 vColor; varying vec3 vNormal; varying vec3 vPos; varying float vKind;
      ${DAWN_GLSL}
      void main() {
        vec3 p = normalize(vPos);
        vec3 n = normalize(vNormal);
        vec3 v = normalize(cameraPosition - vPos);
        float s, morning; dawnInfo(p, uSun, s, morning);
        float diff = max(dot(n, uSun), 0.0);
        float day = smoothstep(-0.1, 0.12, s);
        float dawnSide = smoothstep(-0.15, 0.35, morning);

        vec3 night = vColor * 0.03 + vec3(0.003, 0.006, 0.02);
        vec3 lit = vColor * (0.12 + 1.0 * diff);
        vec3 col = mix(night, lit, day);

        // The dawn band: warm gold on the waking side, a dimmer rose on the dusk side.
        float band = exp(-pow((s - 0.02) / 0.075, 2.0));
        vec3 dawnCol = vec3(1.0, 0.55, 0.16);
        vec3 duskCol = vec3(0.75, 0.22, 0.28);
        float face = 0.45 + 0.55 * max(dot(n, uSun) + 0.25, 0.0);
        col = mix(col, col * mix(duskCol, dawnCol, dawnSide) * 2.2, band * mix(0.28, 0.55, dawnSide));
        col += band * mix(duskCol * 0.10, dawnCol * 0.42, dawnSide) * face;

        // Sun glint on the water, from the smooth sphere so it doesn't light up single facets.
        if (vKind < 0.5) {
          vec3 h = normalize(uSun + v);
          vec3 sn = normalize(mix(n, p, 0.8));
          col += pow(max(dot(sn, h), 0.0), 140.0) * day * vec3(1.0, 0.9, 0.75) * 0.3;
          // Sky reflected off the water toward the limb.
          col += pow(1.0 - max(dot(v, sn), 0.0), 5.0) * vec3(0.16, 0.3, 0.55) * 0.18 * day;
        }

        // Hour meridians every 15° of longitude.
        float hours = atan(p.x, p.z) * 3.8197186; // 12 / PI
        float d = abs(fract(hours + 0.5) - 0.5);
        float line = 1.0 - smoothstep(0.0, fwidth(hours) * 1.3, d);
        line *= 1.0 - smoothstep(0.72, 0.92, abs(p.y));
        col += vec3(0.45, 0.65, 1.0) * line * mix(0.008, 0.014, day);

        // Atmospheric haze toward the limb.
        float rim = pow(1.0 - max(dot(v, p), 0.0), 3.0);
        col += rim * mix(vec3(0.02, 0.04, 0.10), vec3(0.25, 0.5, 0.95), day) * 0.6;
        col += rim * band * mix(duskCol, dawnCol, dawnSide) * 0.5;

        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, globeMat);
  scene.add(mesh);

  // --- Clouds: a faceted shell just above the lowlands (high plateaus poke through, as they do) ---
  const clouds = makeClouds(uniforms);
  scene.add(clouds);

  // --- Atmosphere halo: the inside of a slightly bigger sphere, bright at the limb ---
  const atmoMat = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vW;
      void main() {
        vN = normalize(normalMatrix * normal);
        vW = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun;
      varying vec3 vN; varying vec3 vW;
      ${DAWN_GLSL}
      void main() {
        vec3 p = normalize(vW);
        float s, morning; dawnInfo(p, uSun, s, morning);
        // We see the inside of this shell: normals point away from us. Facing straight away = behind the planet,
        // edge-on = the outer rim of the halo. Glow peaks around the planet's limb and fades out to the rim.
        float k = pow(clamp(-vN.z / 0.42, 0.0, 1.0), 2.6);
        float day = smoothstep(-0.25, 0.3, s);
        float band = exp(-pow(s / 0.16, 2.0));
        vec3 col = mix(vec3(0.03, 0.06, 0.18), vec3(0.3, 0.6, 1.0), day);
        col += band * mix(vec3(0.6, 0.15, 0.25), vec3(1.0, 0.55, 0.2), smoothstep(-0.2, 0.3, morning)) * 0.9;
        gl_FragColor = vec4(col * k * 1.15, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const atmo = new THREE.Mesh(new THREE.SphereGeometry(1.1, 128, 96), atmoMat);
  scene.add(atmo);

  // --- The ray of light: a glowing curtain standing on the dawn line ---
  const curtain = makeCurtain(uniforms);
  scene.add(curtain);

  // --- Sun glow far away in the sun direction ---
  const sun = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture(['rgba(255,250,235,1)', 'rgba(255,226,170,0.5)', 'rgba(255,190,110,0.16)', 'rgba(255,160,70,0.05)', 'rgba(255,140,40,0)']),
    blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
  }));
  sun.scale.set(9, 9, 1);
  scene.add(sun);

  const stars = makeStars();
  scene.add(stars);

  // --- City lights on the night side, switching off one by one as dawn comes ---
  if (data.lights) scene.add(makeLights(base64ToBytes(data.lights), surfaceRadius, uniforms));

  const ring = makeHourRing(uniforms);
  scene.add(ring.group);

  return {
    mesh,
    uniforms,
    /** Surface radius under a lat/lon (max of the nearest few vertices, so dots sit on top of mountains). */
    surfaceRadius,
    /** Lat/lon under a ray, or null (analytic sphere test; plenty for a readout). */
    hitLatLon(ray) {
      const o = ray.origin, d = ray.direction;
      const b = o.dot(d), cc = o.lengthSq() - 1.0;
      const disc = b * b - cc;
      if (disc < 0) return null;
      const t = -b - Math.sqrt(disc);
      if (t < 0) return null;
      const h = o.clone().addScaledVector(d, t);
      const [lat, lon] = vecToLatLon(h.x, h.y, h.z);
      return { lat, lon };
    },
    update(sunVec, time, ms, camera) {
      uniforms.uSun.value.set(sunVec[0], sunVec[1], sunVec[2]);
      uniforms.uTime.value = time;
      curtain.quaternion.setFromUnitVectors(X_AXIS, uniforms.uSun.value);
      sun.position.copy(uniforms.uSun.value).multiplyScalar(60);
      ring.update(ms, uniforms.uSun.value, camera);
    },
  };
}

const X_AXIS = new THREE.Vector3(1, 0, 0);

function makeCurtain(uniforms) {
  // A band standing on the great circle at 90° from the sun, built around the X axis and turned to face the sun.
  const SEG = 360, H0 = 0.985, H1 = 1.3;
  const pos = new Float32Array((SEG + 1) * 2 * 3), hgt = new Float32Array((SEG + 1) * 2), ang = new Float32Array((SEG + 1) * 2);
  const idx = [];
  for (let i = 0; i <= SEG; i++) {
    const t = (i / SEG) * Math.PI * 2, cy = Math.cos(t), cz = Math.sin(t);
    pos.set([0, cy * H0, cz * H0, 0, cy * H1, cz * H1], i * 6);
    hgt[i * 2] = 0; hgt[i * 2 + 1] = 1;
    ang[i * 2] = ang[i * 2 + 1] = i / SEG;
    if (i < SEG) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aH', new THREE.BufferAttribute(hgt, 1));
  g.setAttribute('aA', new THREE.BufferAttribute(ang, 1));
  g.setIndex(idx);
  const m = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float aH; attribute float aA;
      varying float vH; varying float vA; varying vec3 vW;
      void main() {
        vH = aH; vA = aA;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun; uniform float uTime;
      varying float vH; varying float vA; varying vec3 vW;
      ${DAWN_GLSL}
      float hash(float n) { return fract(sin(n) * 43758.5453); }
      float noise(float x) { float i = floor(x), f = fract(x); return mix(hash(i), hash(i + 1.0), f * f * (3.0 - 2.0 * f)); }
      void main() {
        vec3 p = normalize(vW);
        float s, morning; dawnInfo(p, uSun, s, morning);
        float dawn = smoothstep(0.0, 0.45, morning);
        float dusk = smoothstep(0.0, 0.45, -morning) * 0.07;
        // Vertical streaks that drift along the line, like light through haze.
        float x = vA * 420.0;
        float rays = 0.45 + 0.55 * noise(x + uTime * 1.3) * noise(x * 0.37 - uTime * 0.6);
        float fade = pow(1.0 - vH, 2.2) * smoothstep(0.0, 0.06, vH + 0.02);
        // A brighter pulse that travels along the dawn line.
        float sweep = 0.6 + 0.4 * sin(vA * 6.2831 * 2.0 - uTime * 0.8);
        float facing = 1.0 - 0.6 * smoothstep(0.85, 1.0, abs(dot(normalize(cameraPosition - vW), uSun)));
        vec3 col = vec3(1.0, 0.68, 0.3) * dawn * rays * sweep + vec3(0.85, 0.3, 0.4) * dusk * rays;
        gl_FragColor = vec4(col * fade * 0.75 * facing, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.renderOrder = 2;
  return mesh;
}

function glowTexture(stops) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  stops.forEach((s, i) => grad.addColorStop(i / (stops.length - 1), s));
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function makeStars() {
  const N = 2600;
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3), size = new Float32Array(N);
  const c = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const u = hash01(i * 3) * 2 - 1, th = hash01(i * 3 + 1) * Math.PI * 2, r = 70 + hash01(i * 3 + 2) * 30;
    const s = Math.sqrt(1 - u * u);
    pos.set([s * Math.cos(th) * r, u * r, s * Math.sin(th) * r], i * 3);
    const t = hash01(i + 7777);
    c.setHSL(t < 0.3 ? 0.6 : t < 0.5 ? 0.1 : 0.0, t < 0.5 ? 0.5 : 0.0, 0.75 + hash01(i + 4242) * 0.25);
    col.set([c.r, c.g, c.b], i * 3);
    size[i] = 0.6 + Math.pow(hash01(i + 1234), 6) * 2.4;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  const m = new THREE.ShaderMaterial({
    uniforms: { uPx: { value: Math.min(window.devicePixelRatio || 1, 2) } },
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      attribute vec3 color; attribute float aSize; uniform float uPx; varying vec3 vC;
      void main() { vC = color; gl_PointSize = aSize * uPx * 1.6; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      varying vec3 vC;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vC * a, a);
        #include <colorspace_fragment>
      }`,
  });
  return new THREE.Points(g, m);
}

// Clouds are worked out per face of their own coarser icosphere, so they're faceted like the land. Cover follows the
// real climate bands: a cloudy belt near the equator, clear subtropics (the big deserts), stormy mid-latitudes.
// Features are squashed north-south so they stretch along the winds, and drift slowly east while they change shape.
function makeClouds(uniforms) {
  const R = 1.026;
  const { positions: P, faces: F } = icosphere(36);
  const nf = F.length / 3;
  const pos = new Float32Array(nf * 9), centre = new Float32Array(nf * 9);
  for (let f = 0; f < nf; f++) {
    let cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < 3; k++) { const v = F[f * 3 + k]; cx += P[v * 3]; cy += P[v * 3 + 1]; cz += P[v * 3 + 2]; }
    const l = Math.hypot(cx, cy, cz);
    for (let k = 0; k < 3; k++) {
      const v = F[f * 3 + k];
      pos.set([P[v * 3] * R, P[v * 3 + 1] * R, P[v * 3 + 2] * R], f * 9 + k * 3);
      centre.set([cx / l, cy / l, cz / l], f * 9 + k * 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aCentre', new THREE.BufferAttribute(centre, 3));
  g.computeVertexNormals();
  const m = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      attribute vec3 aCentre;
      uniform float uTime;
      varying float vCover; varying float vThick; varying vec3 vN; varying vec3 vP;
      float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float noise(vec3 x) {
        vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
                   mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
      }
      float fbm(vec3 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.07 + vec3(1.7, 9.2, 3.1); a *= 0.5; } return s; }
      void main() {
        vec3 c = aCentre;
        float lat = asin(clamp(c.y, -1.0, 1.0)) * 57.29578, al = abs(lat);
        // Slow eastward drift plus slow change of shape.
        float a = uTime * 0.004;
        vec3 q = vec3(c.x * cos(a) - c.z * sin(a), c.y, c.x * sin(a) + c.z * cos(a));
        float n = fbm(vec3(q.x * 4.2, q.y * 8.0, q.z * 4.2) + vec3(0.0, 0.0, uTime * 0.006));
        // Threshold on the noise: lower = more cloud. fbm is ~0.47 ± 0.1, so 0.5 ≈ 40% cover, 0.57 ≈ 15%.
        float t = 0.55
          - 0.045 * exp(-pow(lat / 9.0, 2.0))           // tropical rain belt
          + 0.05 * exp(-pow((al - 23.0) / 8.0, 2.0))    // dry subtropics
          - 0.06 * exp(-pow((al - 55.0) / 11.0, 2.0))   // mid-latitude storm tracks
          + 0.05 * smoothstep(70.0, 88.0, al);          // dry polar air
        // Soft edges: thin and translucent at the fringe, thick in the middle, plus a little per-face variety.
        float body = smoothstep(t - 0.01, t + 0.13, n);
        vCover = body * (0.75 + 0.25 * hash(c * 91.7)) * 0.88;
        vThick = body;
        vN = normal; vP = position;
        gl_Position = vCover < 0.01 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun;
      varying float vCover; varying float vThick; varying vec3 vN; varying vec3 vP;
      ${DAWN_GLSL}
      void main() {
        vec3 p = normalize(vP), n = normalize(vN);
        float s, morning; dawnInfo(p, uSun, s, morning);
        float day = smoothstep(-0.12, 0.1, s);
        float diff = max(dot(n, uSun), 0.0);
        // Thin cloud edges are greyer and let more light through; thick cores are bright white.
        vec3 col = mix(vec3(0.78, 0.82, 0.9), vec3(1.0), vThick) * (0.2 + 0.8 * diff);
        float band = exp(-pow((s - 0.02) / 0.09, 2.0));
        float dawnSide = smoothstep(-0.15, 0.35, morning);
        col = mix(col, col * mix(vec3(1.0, 0.45, 0.4), vec3(1.0, 0.68, 0.3), dawnSide) * 1.5, band * 0.75);
        col = mix(vec3(0.0035, 0.0055, 0.011), col, day); // at night: about as dark as the ground below
        float a = vCover * mix(0.45, 0.78, day); // night clouds are dim but still veil the city lights
        gl_FragColor = vec4(col, a);
        #include <colorspace_fragment>
        // Premultiply after the colour-space conversion: before it, dark night clouds come out brighter than the
        // ground under them (the sRGB curve is steep near black) and lay a pale veil over the night side.
        gl_FragColor.rgb *= a;
      }`,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.renderOrder = 3; // after the city lights (2) so clouds veil them; dots (5) stay on top
  return mesh;
}

// Every town of 50k+ people (from build-globe) becomes a little cluster of warm points; bigger towns spread wider.
// Each point has its own switch-off moment in the twilight band, so dawn turns the lights off one by one
// just ahead of the gold band, and dusk turns them back on.
function makeLights(bytes, surfaceRadius, uniforms) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = Math.floor(bytes.length / 5);
  const pos = [], data = [];
  for (let i = 0; i < n; i++) {
    const lat = view.getInt16(i * 5, true) / 100, lon = view.getInt16(i * 5 + 2, true) / 100;
    const w = view.getUint8(i * 5 + 4) / 255;
    const r = surfaceRadius(lat, lon) + 0.003;
    const count = 1 + Math.round(w * w * 16);
    const spread = 0.12 + 0.55 * w * w; // degrees
    const k = 1 / Math.max(0.2, Math.cos(lat * (Math.PI / 180)));
    for (let j = 0; j < count; j++) {
      const seed = i * 31 + j * 7;
      // Roughly Gaussian scatter around the centre; the first point is the centre itself.
      const rr = j === 0 ? 0 : spread * Math.sqrt(-2 * Math.log(1 - hash01(seed) * 0.95)) * 0.5;
      const th = hash01(seed + 1) * Math.PI * 2;
      const [x, y, z] = latLonToVec(lat + rr * Math.sin(th), lon + rr * Math.cos(th) * k);
      pos.push(x * r, y * r, z * r);
      const bright = j === 0 ? 0.55 + 0.45 * w : (0.3 + 0.5 * w) * (0.5 + 0.5 * hash01(seed + 2));
      data.push(bright, hash01(seed + 3), hash01(seed + 4));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aData', new THREE.Float32BufferAttribute(data, 3)); // brightness, switch-off point, tint
  const m = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uPx: { value: Math.min(window.devicePixelRatio || 1, 2) } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec3 aData; uniform vec3 uSun; uniform float uTime; uniform float uPx;
      varying float vA; varying float vTint;
      void main() {
        vec3 p = normalize(position);
        float s = dot(p, uSun);
        // Switch point between sun altitude ~-1.5° and ~-9°: lights go out through civil/nautical twilight.
        float thr = -0.025 - 0.13 * aData.y;
        float on = 1.0 - smoothstep(thr - 0.012, thr + 0.012, s);
        float twinkle = 0.88 + 0.12 * sin(uTime * (0.7 + aData.z * 2.0) + aData.y * 40.0);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 toCam = normalize(cameraPosition - position);
        float facing = smoothstep(0.0, 0.35, dot(p, toCam)); // fade at the limb, where points would bunch up
        vA = aData.x * on * twinkle * facing;
        vTint = aData.z;
        gl_PointSize = (2.4 + 3.6 * aData.x) * uPx * clamp(3.0 / -mv.z, 0.75, 2.4);
        gl_Position = projectionMatrix * mv;
        if (vA < 0.003) gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // off: push out of the clip volume
      }`,
    fragmentShader: /* glsl */ `
      varying float vA; varying float vTint;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = (exp(-d * d * 12.0) + 0.3 * exp(-d * d * 3.0)) * vA; // bright core, soft warm halo
        vec3 col = mix(vec3(1.0, 0.56, 0.2), vec3(1.0, 0.82, 0.52), vTint * vTint);
        gl_FragColor = vec4(col * a, a);
        #include <colorspace_fragment>
      }`,
  });
  const points = new THREE.Points(g, m);
  points.renderOrder = 2;
  return points;
}

// 24 labels around the equator: the clock time on each hour meridian (UTC + lon/15), like a bezel.
function makeHourRing() {
  const group = new THREE.Group();
  const R = 1.25;
  const ringGeo = new THREE.BufferGeometry().setFromPoints(
    Array.from({ length: 241 }, (_, i) => new THREE.Vector3(Math.sin((i / 240) * Math.PI * 2) * 1.2, 0, Math.cos((i / 240) * Math.PI * 2) * 1.2)),
  );
  const ringLine = new THREE.Line(ringGeo, new THREE.LineBasicMaterial({ color: 0x5f8fd0, transparent: true, opacity: 0.18, depthWrite: false }));
  group.add(ringLine);

  const ticks = [];
  for (let k = -11; k <= 12; k++) {
    const lon = k * 15;
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 64;
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    const [x, y, z] = latLonToVec(0, lon);
    sp.position.set(x * R, y * R, z * R);
    sp.scale.set(0.17, 0.085, 1);
    sp.renderOrder = 3;
    group.add(sp);
    ticks.push({ k, lon, cv, tex, sp, last: '', dir: new THREE.Vector3(x, y, z), east: new THREE.Vector3(z, 0, -x).normalize() });
  }
  const camDir = new THREE.Vector3();
  return {
    group,
    update(ms, sunV, camera) {
      camDir.copy(camera.position).normalize();
      const utcMin = Math.floor(ms / 60000);
      for (const t of ticks) {
        const m = (((utcMin + t.k * 60) % 1440) + 1440) % 1440;
        const hh = String(Math.floor(m / 60)).padStart(2, '0'), mm = String(m % 60).padStart(2, '0');
        const s = t.dir.dot(sunV);
        const east = t.east.dot(sunV);
        const state = Math.abs(s) < 0.2 ? (east > 0 ? 'dawn' : 'dusk') : s > 0 ? 'day' : 'night';
        const text = `${hh}:${mm}|${state}|${t.k}`;
        if (text !== t.last) {
          t.last = text;
          drawLabel(t.cv, `${hh}:${mm}`, t.k, state);
          t.tex.needsUpdate = true;
        }
        // Labels behind the planet fade out instead of popping.
        const facing = t.dir.dot(camDir);
        // Behind the planet: fade out. Right in front of it: dim a little, so labels don't sit loudly on the land.
        const behind = Math.max(0, Math.min(1, (facing + 0.35) / 0.5));
        const front = 1 - 0.4 * Math.max(0, Math.min(1, (facing - 0.25) / 0.5));
        t.sp.material.opacity = behind * front;
      }
    },
  };
}

function drawLabel(cv, time, k, state) {
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);
  const color = { dawn: '#ffc46b', dusk: '#ff8f8f', day: '#e9f1ff', night: '#7f97c4' }[state];
  g.textAlign = 'center';
  g.fillStyle = color;
  g.font = '600 30px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  g.fillText(time, 64, 30);
  g.font = '500 17px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  g.globalAlpha = 0.65;
  g.fillText(k === 0 ? 'UTC' : `UTC${k > 0 ? '+' : '−'}${Math.abs(k)}`, 64, 54);
  g.globalAlpha = 1;
}
