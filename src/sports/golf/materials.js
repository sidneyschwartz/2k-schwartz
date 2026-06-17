// Procedural PBR materials for golf surfaces. All generated via CanvasTexture so the
// build stays self-contained — no external image assets required.
//
// Phase 3 additions: applyMaterial(surfaceType, mesh, region?) is the engine's
// dispatch entry; Lakeside water becomes a Reflector with animated ripple;
// elevated greens get a side cliff; addBunkerLip raises a brown berm around sand.

import * as THREE from 'three';
import { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import { Water } from 'three/examples/jsm/objects/Water.js';

const TEX_SIZE = 512;

function makeCanvas(size = TEX_SIZE) {
  const c = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(size, size)
    : Object.assign(document.createElement('canvas'), { width: size, height: size });
  return c;
}

function canvasTexture(canvas, { repeat = [8, 8], anisotropy = 8 } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat[0], repeat[1]);
  tex.anisotropy = anisotropy;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function dataTexture(canvas, { repeat = [8, 8], anisotropy = 8 } = {}) {
  const tex = canvasTexture(canvas, { repeat, anisotropy });
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

// ---------- procedural texture generators ----------

function noiseFill(ctx, size, baseRGB, variance) {
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * variance;
    d[i] = Math.max(0, Math.min(255, baseRGB[0] + n));
    d[i + 1] = Math.max(0, Math.min(255, baseRGB[1] + n));
    d[i + 2] = Math.max(0, Math.min(255, baseRGB[2] + n));
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function generateFairwayMap(size = TEX_SIZE) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  // Mowed green with two-tone stripes. Deepened base + darker bright-stripe
  // so the env-lit fairway reads as Augusta turf rather than a sunlit highlight.
  noiseFill(ctx, size, [58, 100, 42], 18);
  const stripeH = size / 8;
  ctx.globalAlpha = 0.18;
  for (let y = 0; y < size; y += stripeH * 2) {
    ctx.fillStyle = '#2c5028';
    ctx.fillRect(0, y, size, stripeH);
    ctx.fillStyle = '#6a9a4a';
    ctx.fillRect(0, y + stripeH, size, stripeH);
  }
  ctx.globalAlpha = 1;
  return c;
}

function generateRoughMap(size = TEX_SIZE) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  noiseFill(ctx, size, [56, 92, 40], 42);
  // sparse darker grass tufts
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = `rgba(30,${60 + Math.random() * 40 | 0},25,0.4)`;
    const x = Math.random() * size;
    const y = Math.random() * size;
    ctx.fillRect(x, y, 1 + Math.random() * 2, 2 + Math.random() * 4);
  }
  return c;
}

function generateGreenMap(size = TEX_SIZE) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  // Deepened to read as a manicured green under bright IBL — the old
  // (110, 168, 80) was washing out to white-green near the sun.
  noiseFill(ctx, size, [82, 132, 60], 10);
  ctx.globalAlpha = 0.06;
  for (let y = 0; y < size; y += 16) {
    ctx.fillStyle = '#6a9648';
    ctx.fillRect(0, y, size, 8);
  }
  ctx.globalAlpha = 1;
  return c;
}

function generateSandMap(size = TEX_SIZE) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  noiseFill(ctx, size, [218, 196, 144], 30);
  // pebble specks
  for (let i = 0; i < 200; i++) {
    ctx.fillStyle = `rgba(120,90,60,${0.2 + Math.random() * 0.3})`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 1, 1);
  }
  return c;
}

function generateNormalMap(size = TEX_SIZE, strength = 1) {
  // crude bumpy normal map encoded around (128,128,255)
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const dx = (Math.random() - 0.5) * 80 * strength;
    const dy = (Math.random() - 0.5) * 80 * strength;
    d[i] = 128 + dx;
    d[i + 1] = 128 + dy;
    d[i + 2] = 255;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// ---------- cached textures (one set per module load) ----------

let _cache = null;
function getCache() {
  if (_cache) return _cache;
  _cache = {
    fairwayColor: canvasTexture(generateFairwayMap(), { repeat: [16, 16] }),
    fairwayNormal: dataTexture(generateNormalMap(256, 0.5), { repeat: [16, 16] }),
    roughColor: canvasTexture(generateRoughMap(), { repeat: [20, 20] }),
    roughNormal: dataTexture(generateNormalMap(256, 1.2), { repeat: [20, 20] }),
    greenColor: canvasTexture(generateGreenMap(), { repeat: [8, 8] }),
    greenNormal: dataTexture(generateNormalMap(256, 0.25), { repeat: [8, 8] }),
    sandColor: canvasTexture(generateSandMap(), { repeat: [12, 12] }),
    sandNormal: dataTexture(generateNormalMap(256, 0.8), { repeat: [12, 12] }),
  };
  return _cache;
}

// ---------- material factories ----------

export function fairwayMaterial() {
  const c = getCache();
  return new THREE.MeshStandardMaterial({
    map: c.fairwayColor,
    normalMap: c.fairwayNormal,
    normalScale: new THREE.Vector2(0.35, 0.35),
    // Maxed roughness so the env map can't put a bright sky-coloured sheen on
    // the grass. envMapIntensity tames the IBL contribution further — the
    // PMREM-baked sky is bright and was washing the fairway to near-white.
    roughness: 1.0,
    metalness: 0.0,
    color: 0xffffff,
    envMapIntensity: 0.30,
  });
}

export function roughMaterial() {
  const c = getCache();
  return new THREE.MeshStandardMaterial({
    map: c.roughColor,
    normalMap: c.roughNormal,
    normalScale: new THREE.Vector2(0.9, 0.9),
    roughness: 1.0,
    metalness: 0.0,
    envMapIntensity: 0.30,
  });
}

export function greenMaterial() {
  const c = getCache();
  return new THREE.MeshStandardMaterial({
    map: c.greenColor,
    normalMap: c.greenNormal,
    normalScale: new THREE.Vector2(0.15, 0.15),
    // Greens are still smoother (slight sheen on a real putting surface), but
    // tamed envMap so the highlight doesn't blow out near the cup.
    roughness: 0.85,
    metalness: 0.0,
    envMapIntensity: 0.35,
  });
}

export function sandMaterial() {
  const c = getCache();
  return new THREE.MeshStandardMaterial({
    map: c.sandColor,
    normalMap: c.sandNormal,
    normalScale: new THREE.Vector2(0.6, 0.6),
    roughness: 1.0,
    metalness: 0.0,
    envMapIntensity: 0.45,
  });
}

// Lightweight reflective water — kept for fallback / non-reflector callers.
export function waterMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0x2a6db5,
    roughness: 0.1,
    metalness: 0.6,
    transparent: true,
    opacity: 0.85,
    envMapIntensity: 1.2,
  });
}

// ---------- water ripple (animated normal map) ----------

function generateWaterNormal(size = 256, t = 0) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size * 6.283;
      const v = y / size * 6.283;
      const dx = Math.sin(u * 2 + t) * 40 + Math.sin(v * 3 - t * 0.7) * 30;
      const dy = Math.cos(v * 2 + t * 0.8) * 40 + Math.cos(u * 3 - t) * 30;
      const i = (y * size + x) * 4;
      d[i] = 128 + dx;
      d[i + 1] = 128 + dy;
      d[i + 2] = 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// Track animated reflectors so we can update ripple from a single update tick.
const _reflectors = new Set();
let _waterNormalTex = null;
let _waterClock = 0;

function getWaterNormalTexture() {
  if (_waterNormalTex) return _waterNormalTex;
  _waterNormalTex = dataTexture(generateWaterNormal(256, 0), { repeat: [8, 8] });
  return _waterNormalTex;
}

// Engine should call this once per frame to advance ripple animation.
export function tickWater(dt) {
  if (!_reflectors.size && !_waters.size) return;
  _waterClock += dt;
  // Cheap ripple for Reflector fallback: scroll the normal map UV offset.
  if (_reflectors.size) {
    const tex = getWaterNormalTexture();
    if (tex) {
      tex.offset.x = (_waterClock * 0.03) % 1;
      tex.offset.y = (_waterClock * 0.02) % 1;
    }
  }
  // Real Water class: advance its `time` uniform so the waves animate.
  for (const w of _waters) {
    if (w.material?.uniforms?.time) {
      w.material.uniforms.time.value += dt;
    }
  }
}

// ---------- water ----------

// Generate a smoother waves normal map for the Water shader (white-noise looks bad).
let _wavesNormalTex = null;
function getWavesNormalTexture() {
  if (_wavesNormalTex) return _wavesNormalTex;
  const size = 512;
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Multi-octave sin waves -> rolling wave normals
      const u = (x / size) * Math.PI * 4;
      const v = (y / size) * Math.PI * 4;
      const h =
        Math.sin(u * 1.0 + v * 0.3) * 0.5 +
        Math.sin(u * 0.6 - v * 1.1) * 0.3 +
        Math.sin(u * 2.4 + v * 1.7) * 0.2;
      // numerical derivative
      const du =
        Math.cos(u * 1.0 + v * 0.3) * 1.0 +
        Math.cos(u * 0.6 - v * 1.1) * 0.6 +
        Math.cos(u * 2.4 + v * 1.7) * 2.4 * 0.2;
      const dv =
        Math.cos(u * 1.0 + v * 0.3) * 0.3 +
        -Math.cos(u * 0.6 - v * 1.1) * 1.1 * 0.3 +
        Math.cos(u * 2.4 + v * 1.7) * 1.7 * 0.2;
      const i = (y * size + x) * 4;
      d[i]     = 128 + du * 40;
      d[i + 1] = 128 + dv * 40;
      d[i + 2] = 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  _wavesNormalTex = new THREE.CanvasTexture(c);
  _wavesNormalTex.wrapS = _wavesNormalTex.wrapT = THREE.RepeatWrapping;
  _wavesNormalTex.colorSpace = THREE.NoColorSpace;
  _wavesNormalTex.needsUpdate = true;
  return _wavesNormalTex;
}

// Track the live Water meshes so we can advance their time uniform from tickWater().
const _waters = new Set();

function buildWaterPlane(width, depth, { sunDir = new THREE.Vector3(0.5, 1, 0.5).normalize() } = {}) {
  const geo = new THREE.PlaneGeometry(width, depth, 1, 1);
  // sunColor toned WAY down — at Lakeside we look straight into the reflected
  // sun and the original 0xfff4d6 blew out to pure white across half the
  // screen. Dim the sun reflection AND deepen the base water so the lake
  // reads as deep water, not a mirror.
  const water = new Water(geo, {
    textureWidth: 512,
    textureHeight: 512,
    waterNormals: getWavesNormalTexture(),
    sunDirection: sunDir.clone(),
    sunColor: 0x7d8a6a,
    waterColor: 0x0e3a5c,
    distortionScale: 1.2,
    fog: true,
    alpha: 0.95,
  });
  water.rotation.x = -Math.PI / 2;
  water.material.uniforms.size.value = 4.0;
  _waters.add(water);
  return water;
}

// Cheap fallback (used by low-quality / when Water class fails for some reason).
function buildReflectorWater(width, depth, resolution = 512) {
  // Darker reflector tint so the reflected sky doesn't blow out highlights.
  const geo = new THREE.PlaneGeometry(width, depth);
  const reflector = new Reflector(geo, {
    clipBias: 0.003,
    textureWidth: resolution,
    textureHeight: resolution,
    color: 0x0e2238,
  });
  reflector.rotateX(-Math.PI / 2);
  _reflectors.add(reflector);

  // Heavy tint plane on top to mute the reflection. Opacity bumped to 0.85
  // and color deepened so the lake reads as deep water from any angle.
  const tintGeo = new THREE.PlaneGeometry(width, depth);
  const tintMat = new THREE.MeshStandardMaterial({
    color: 0x0e3a5c,
    transparent: true,
    opacity: 0.85,
    roughness: 0.35,
    metalness: 0.0,
    normalMap: getWaterNormalTexture(),
    normalScale: new THREE.Vector2(0.6, 0.6),
    envMapIntensity: 0.20,
  });
  const tint = new THREE.Mesh(tintGeo, tintMat);
  tint.rotateX(-Math.PI / 2);
  tint.position.y = 0.02;
  reflector.add(tint);

  reflector.userData.isWaterReflector = true;
  return reflector;
}

// ---------- bunker lip ----------

const BERM_COLOR = 0x6e5a3a;
function bermMaterial() {
  const c = getCache();
  return new THREE.MeshStandardMaterial({
    color: BERM_COLOR,
    map: c.sandColor,
    roughness: 0.95,
    metalness: 0,
  });
}

export function addBunkerLip(scene, x, z, r) {
  const ringGeo = new THREE.RingGeometry(r * 0.98, r * 1.12, 36, 1);
  ringGeo.rotateX(-Math.PI / 2);
  const ring = new THREE.Mesh(ringGeo, bermMaterial());
  ring.position.set(x, 0.03, z);
  ring.receiveShadow = true;
  ring.castShadow = false;
  scene.add(ring);

  // A short raised lip on the back side using a TorusGeometry slice — gives the
  // classic "lip" silhouette when viewed from the fairway side.
  const torusGeo = new THREE.TorusGeometry(r * 1.04, 0.10, 8, 36, Math.PI);
  const torus = new THREE.Mesh(torusGeo, bermMaterial());
  torus.rotation.x = -Math.PI / 2;
  torus.rotation.z = Math.PI; // lip on the far side from tee
  torus.position.set(x, 0.10, z);
  torus.castShadow = true;
  torus.receiveShadow = true;
  scene.add(torus);

  return { ring, torus };
}

// ---------- elevated green ----------

function addElevationCliff(scene, mesh, region) {
  const elev = region.elevation ?? 0;
  if (elev <= 0) return null;
  const r = region.r ?? 10;
  // Lift the green mesh.
  mesh.position.y = (mesh.position.y || 0) + elev;
  // Side cliff: a short cylinder skirt under the green.
  const cliffGeo = new THREE.CylinderGeometry(r * 1.02, r * 1.10, elev, 36, 1, true);
  const c = getCache();
  const cliffMat = new THREE.MeshStandardMaterial({
    color: 0x5b6f3d,
    map: c.roughColor,
    roughness: 0.95,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  const cliff = new THREE.Mesh(cliffGeo, cliffMat);
  cliff.position.set(region.x ?? 0, elev / 2, region.z ?? 0);
  cliff.receiveShadow = true;
  cliff.castShadow = true;
  scene.add(cliff);
  return cliff;
}

// ---------- public dispatch ----------

const FACTORY = {
  tee: greenMaterial,
  fairway: fairwayMaterial,
  rough: roughMaterial,
  green: greenMaterial,
  sand: sandMaterial,
};

// Engine calls applyMaterial(surfaceType, mesh, region?) for each region.
// For 'water' we swap the mesh's material with a Reflector (which the engine
// can choose to add as a sibling; for safety we attach it to the same parent).
// Returns the mesh (or a replacement) the engine should add to the scene.
export function applyMaterial(surfaceType, mesh, region = null) {
  if (!mesh) return mesh;

  if (surfaceType === 'water') {
    // We had the real three.js Water class here for the sun-glint reflection,
    // but on shots where the camera looks straight INTO the reflected sun
    // (Lakeside tee, low-angle approach) it blew out to near-white across half
    // the screen even with darkened sunColor. The Reflector path with a
    // translucent tint plane gives a properly deep-blue lake at every angle
    // and still looks reflective.
    const width = region?.w ?? 50;
    const depth = region?.d ?? 50;
    const waterMesh = buildReflectorWater(width, depth, 512);
    mesh.visible = false;
    waterMesh.position.set(0, 0.01, 0);
    mesh.add(waterMesh);
    return mesh;
  }

  const factory = FACTORY[surfaceType] ?? fairwayMaterial;
  const mat = factory();
  // Dispose previous if engine pre-assigned a placeholder.
  if (mesh.material && mesh.material.dispose) {
    try { mesh.material.dispose(); } catch {}
  }
  mesh.material = mat;
  mesh.receiveShadow = true;
  if (surfaceType === 'tee') mesh.castShadow = false;

  // Elevated green handling.
  if (surfaceType === 'green' && region && region.elevation) {
    // Engine may have already positioned mesh; we add a cliff to its parent.
    const parent = mesh.parent ?? mesh;
    addElevationCliff(parent, mesh, region);
  }
  return mesh;
}
