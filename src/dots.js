// Visitor dots: one instanced billboard per place. Glow, pulse, the dawn flare and the ripple ring all run on the GPU,
// so dots wake up on their own as the dawn line passes. The CPU side only fades places in and out.
// Three kinds: people here now, you, and "earlier" (visited in the last 24 h, not here now): those stay faint and
// still, but flare as dawn reaches them, so the globe keeps waking up even when few people are online.
import * as THREE from 'three';
import { latLonToVec } from './geo.js';

const MAX = 4096;
const FADE_PER_S = 1.8;
const EARLIER_ALPHA = 0.62;
const KIND = { visitor: 0, me: 1, earlier: 2 };
const kindOf = (p) => (p.me ? KIND.me : p.earlier ? KIND.earlier : KIND.visitor);

export function createDots(scene, globe) {
  const base = new THREE.PlaneGeometry(2, 2);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.getAttribute('position'));
  geo.setAttribute('uv', base.getAttribute('uv'));
  const iPos = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
  const iData = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4); // size, phase, alpha, kind
  iPos.setUsage(THREE.DynamicDrawUsage);
  iData.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('iPos', iPos);
  geo.setAttribute('iData', iData);
  geo.instanceCount = 0;

  const mat = new THREE.ShaderMaterial({
    uniforms: globe.uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: false, // occlusion by the planet is done analytically below, so mountains never clip a dot
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute vec3 iPos; attribute vec4 iData;
      uniform vec3 uSun; uniform float uTime;
      varying vec2 vUv; varying float vFlare; varying float vNight; varying float vAlpha; varying float vMe; varying float vPhase;
      varying float vEarly;
      void main() {
        vUv = uv * 2.0 - 1.0;
        vec3 p = normalize(iPos);
        float s = dot(p, uSun);
        vec3 east = vec3(p.z, 0.0, -p.x);
        float morning = length(east) > 1e-4 ? dot(normalize(east), uSun) : 0.0;
        vFlare = exp(-pow((s - 0.03) / 0.07, 2.0)) * smoothstep(0.0, 0.25, morning);
        vNight = 1.0 - smoothstep(-0.08, 0.2, s);
        vMe = step(0.5, iData.w) * (1.0 - step(1.5, iData.w)); vEarly = step(1.5, iData.w); vPhase = iData.y;

        // Hidden when behind the planet (a point at radius r is visible if p·camDir > 1/|cam|, roughly).
        vec3 cdir = normalize(cameraPosition);
        float horizon = 1.0 / length(cameraPosition);
        float vis = smoothstep(horizon - 0.04, horizon + 0.1, dot(p, cdir));
        vAlpha = iData.z * vis * (1.0 + vEarly * 0.9 * vFlare); // earlier dots wake up to nearly full strength

        float pulse = 1.0 + 0.1 * (1.0 - vEarly) * sin(uTime * 2.2 + iData.y * 6.2831);
        float size = iData.x * pulse * (1.0 + 0.9 * vFlare) * 3.0; // quad is 3× the dot so the halo and ripple fit
        vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
        mv.xy += (uv * 2.0 - 1.0) * size;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      varying vec2 vUv; varying float vFlare; varying float vNight; varying float vAlpha; varying float vMe; varying float vPhase;
      varying float vEarly;
      void main() {
        float r = length(vUv);
        if (r > 1.0) discard;
        float core = exp(-r * r * 90.0);
        float halo = exp(-r * r * 14.0) * 0.55 + exp(-r * r * 4.0) * 0.12;
        // Ripple: always on for "you", and on everyone while dawn passes over them.
        float t = fract(uTime * 0.45 + vPhase);
        float ring = smoothstep(0.05, 0.0, abs(r - t * 0.95)) * (1.0 - t) * max(vFlare * 1.3, vMe);
        vec3 visitor = mix(vec3(1.0, 0.86, 0.55), vec3(1.0, 0.95, 0.85), vNight);
        vec3 me = vec3(0.45, 0.95, 1.0);
        vec3 col = mix(visitor, me, vMe);
        col = mix(col, vec3(0.92, 0.88, 0.8), vEarly * (1.0 - vFlare));
        col = mix(col, vec3(1.0, 0.72, 0.3), vFlare * (1.0 - vMe) * 0.6);
        float glow = (core * 1.5 + halo * (0.6 + 0.25 * vNight + 0.8 * vFlare)) * (0.85 + 0.1 * vNight + 0.7 * vFlare);
        float a = (glow + ring * 0.9) * vAlpha;
        gl_FragColor = vec4(col * a, a);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 5;
  scene.add(mesh);

  /** key → { slot, place, alpha, target, world } */
  const items = new Map();
  const slots = []; // slot → key
  const radiusCache = new Map();

  function place(p) {
    const ck = `${p.lat},${p.lon}`;
    let r = radiusCache.get(ck);
    if (r === undefined) { r = globe.surfaceRadius(p.lat, p.lon) + 0.012; radiusCache.set(ck, r); }
    const [x, y, z] = latLonToVec(p.lat, p.lon);
    return new THREE.Vector3(x * r, y * r, z * r);
  }

  function sizeFor(p) {
    if (p.me) return 0.024;
    const lg = Math.log2(1 + (p.n || 1));
    return p.earlier ? 0.0125 + 0.004 * Math.min(lg, 5) : 0.014 + 0.007 * lg;
  }

  function write(it) {
    const s = it.slot;
    iPos.setXYZ(s, it.world.x, it.world.y, it.world.z);
    iData.setXYZW(s, sizeFor(it.place), it.phase, it.alpha, kindOf(it.place));
  }

  return {
    /** Replace the set of shown places. Each: { key, lat, lon, n, me?, earlier?, ...anything for the tooltip }.
     *  A place keeps its key when it goes from earlier to here-now, so its dot brightens instead of popping. */
    setPlaces(list) {
      const seen = new Set();
      for (const p of list) {
        seen.add(p.key);
        let it = items.get(p.key);
        if (!it) {
          if (slots.length >= MAX) continue;
          it = { slot: slots.length, alpha: 0, target: p.earlier ? EARLIER_ALPHA : 1, phase: Math.random(), place: p, world: place(p) };
          slots.push(p.key);
          items.set(p.key, it);
        } else {
          if (it.place.lat !== p.lat || it.place.lon !== p.lon) it.world = place(p);
          it.place = p;
          it.target = p.earlier ? EARLIER_ALPHA : 1;
        }
        write(it);
      }
      for (const [key, it] of items) if (!seen.has(key)) it.target = 0;
      geo.instanceCount = slots.length;
      iPos.needsUpdate = true;
      iData.needsUpdate = true;
    },
    update(dt) {
      let dirty = false;
      for (const [key, it] of items) {
        if (it.alpha === it.target) continue;
        it.alpha = it.target > it.alpha ? Math.min(it.target, it.alpha + dt * FADE_PER_S) : Math.max(it.target, it.alpha - dt * FADE_PER_S);
        if (it.alpha === 0 && it.target === 0) {
          // Free the slot by moving the last instance into it.
          const lastKey = slots[slots.length - 1];
          const last = items.get(lastKey);
          slots[it.slot] = lastKey;
          last.slot = it.slot;
          slots.pop();
          items.delete(key);
          if (last !== it) write(last);
          geo.instanceCount = slots.length;
        } else {
          write(it);
        }
        dirty = true;
      }
      if (dirty) { iPos.needsUpdate = true; iData.needsUpdate = true; }
    },
    /** Nearest visible dot to a screen point (px), within `maxPx`. */
    pick(px, py, camera, width, height, maxPx = 18) {
      const v = new THREE.Vector3(), cdir = camera.position.clone().normalize();
      const horizon = 1 / camera.position.length();
      let best = null, bestD = maxPx * maxPx;
      for (const it of items.values()) {
        if (it.target === 0 || it.world.clone().normalize().dot(cdir) < horizon + 0.02) continue;
        v.copy(it.world).project(camera);
        const sx = ((v.x + 1) / 2) * width, sy = ((1 - v.y) / 2) * height;
        // Faint "earlier" dots lose ties to people who are here now.
        const d = ((sx - px) ** 2 + (sy - py) ** 2) * (it.place.earlier ? 1.8 : 1);
        // "You" wins ties so your own dot is always easy to find.
        if (d < bestD || (it.place.me && d < maxPx * maxPx && (!best || !best.me))) { bestD = d; best = it.place; }
      }
      return best;
    },
    get count() { return items.size; },
  };
}
