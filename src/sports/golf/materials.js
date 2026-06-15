// Procedural PBR materials for golf surfaces. All generated via CanvasTexture so the
// build stays self-contained — no external image assets required.

import * as THREE from 'three';

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
  // base mowed green with two-tone stripes
  noiseFill(ctx, size, [78, 132, 56], 24);
  const stripeH = size / 8;
  ctx.globalAlpha = 0.18;
  for (let y = 0; y < size; y += stripeH * 2) {
    ctx.fillStyle = '#3e6f3a';
    ctx.fillRect(0, y, size, stripeH);
    ctx.fillStyle = '#9ac96a';
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
  noiseFill(ctx, size, [110, 168, 80], 14);
  // very subtle cross-mowing
  ctx.globalAlpha = 0.06;
  for (let y = 0; y < size; y += 16) {
    ctx.fillStyle = '#86b85a';
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
    roughness: 0.85,
    metalness: 0.0,
    color: 0xffffff,
  });
}

export function roughMaterial() {
  const c = getCache();
  return new THREE.MeshStandardMaterial({
    map: c.roughColor,
    normalMap: c.roughNormal,
    normalScale: new THREE.Vector2(0.9, 0.9),
    roughness: 0.95,
    metalness: 0.0,
  });
}

export function greenMaterial() {
  const c = getCache();
  return new THREE.MeshStandardMaterial({
    map: c.greenColor,
    normalMap: c.greenNormal,
    normalScale: new THREE.Vector2(0.15, 0.15),
    roughness: 0.7,
    metalness: 0.0,
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
  });
}

// Lightweight reflective water — we skip three's Water class since it requires
// per-frame reflection rendering that we don't need for the Phase 1 hole.
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
