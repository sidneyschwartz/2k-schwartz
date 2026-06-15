// Per-hole environment dressing: low-poly trees, tee signage, a cinematic
// camera flyover for hole transitions, and (new) an instanced grass-blade
// carpet that follows the ball.
//
// decorateHole(scene, holeData, { ballRef, camera, sunDir, wind }) returns an
// env handle with:
//   tick(dt, { ballPos, cameraPos, wind })  — call each frame
//   setGrassDensity(d)                       — 0..1, called by quality.js
//   setTreeDensity(d)                        — 0..1, called by quality.js
//   setWaterReflection(enabled, size)        — stub for future water swap
//   dispose()                                — frees all decor

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createGrassPatch } from './grass.js';

// ---------- helpers ----------

function pointInCircle(x, z, cx, cz, r) {
  const dx = x - cx, dz = z - cz;
  return dx * dx + dz * dz <= r * r;
}

function pointInRect(x, z, cx, cz, w, d) {
  return Math.abs(x - cx) <= w / 2 && Math.abs(z - cz) <= d / 2;
}

function pointInRing(x, z, cx, cz, rIn, rOut) {
  const dx = x - cx, dz = z - cz;
  const d2 = dx * dx + dz * dz;
  return d2 <= rOut * rOut && d2 >= rIn * rIn;
}

function pointInSpline(x, z, points) {
  // Simple polyline distance-to-segments check against per-segment width.
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const ax = a.x, az = a.z, bx = b.x, bz = b.z;
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz;
    if (len2 < 1e-6) continue;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2));
    const px = ax + dx * t, pz = az + dz * t;
    const ex = x - px, ez = z - pz;
    const w = (a.w + (b.w - a.w) * t) / 2;
    if (ex * ex + ez * ez <= w * w) return true;
  }
  return false;
}

function regionContains(region, x, z) {
  switch (region.shape) {
    case 'rect':   return pointInRect(x, z, region.x, region.z, region.w, region.d);
    case 'circle': return pointInCircle(x, z, region.x, region.z, region.r);
    case 'ring':   return pointInRing(x, z, region.x, region.z, region.r, region.r2);
    case 'spline': return pointInSpline(x, z, region.points);
    case 'fill':   return false;
    default:       return false;
  }
}

function holeBounds(holeData) {
  // Conservative axis-aligned box around tee + pin + regions.
  let minX = Math.min(holeData.tee.x, holeData.pin.x) - 40;
  let maxX = Math.max(holeData.tee.x, holeData.pin.x) + 40;
  let minZ = Math.min(holeData.tee.z, holeData.pin.z) - 10;
  let maxZ = Math.max(holeData.tee.z, holeData.pin.z) + 40;
  for (const r of holeData.regions ?? []) {
    if (r.shape === 'rect') {
      minX = Math.min(minX, r.x - r.w / 2 - 20);
      maxX = Math.max(maxX, r.x + r.w / 2 + 20);
      minZ = Math.min(minZ, r.z - r.d / 2);
      maxZ = Math.max(maxZ, r.z + r.d / 2);
    } else if (r.shape === 'circle' || r.shape === 'ring') {
      const rr = (r.r2 ?? r.r) + 20;
      minX = Math.min(minX, r.x - rr);
      maxX = Math.max(maxX, r.x + rr);
      minZ = Math.min(minZ, r.z - rr);
      maxZ = Math.max(maxZ, r.z + rr);
    } else if (r.shape === 'spline') {
      for (const p of r.points) {
        minX = Math.min(minX, p.x - p.w / 2 - 20);
        maxX = Math.max(maxX, p.x + p.w / 2 + 20);
        minZ = Math.min(minZ, p.z);
        maxZ = Math.max(maxZ, p.z);
      }
    }
  }
  return { minX, maxX, minZ, maxZ };
}

// ---------- trees ----------
//
// Two species, both rendered as InstancedMesh (1 draw call each for trunks
// and 1 for crowns):
//
//   conifer:   layered, jittered cones with denser, more numerous tiers.
//              Foliage is densely irregular — reads as a pine, not a cone.
//   broadleaf: noise-displaced icosphere clusters with proper lobed silhouette
//              and a few exposed branches sticking through the crown.
//
// Foliage uses a custom shader extending Standard: it adds AO-style darkening
// at clump centers, brighter tips, per-instance tint and height variation, and
// a gentle wind sway driven by a shared uTime + per-instance phase attribute.

// Random in [-1, 1] without bias.
function rng() { return Math.random() * 2 - 1; }

// Jitter a position attribute in-place by a per-vertex random offset bounded by
// `mag`. Recomputes flat-ish normals after. Use this to roughen up the
// silhouette of cones and icospheres so they don't look mathematical.
function jitterGeometry(geo, mag = 0.12) {
  const pos = geo.attributes.position;
  // Group identical positions so seams don't pop apart.
  const key = (x, y, z) =>
    `${(x * 100) | 0}_${(y * 100) | 0}_${(z * 100) | 0}`;
  const seen = new Map();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = key(x, y, z);
    let off = seen.get(k);
    if (!off) {
      off = { x: rng() * mag, y: rng() * mag * 0.6, z: rng() * mag };
      seen.set(k, off);
    }
    pos.setXYZ(i, x + off.x, y + off.y, z + off.z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

// Build a conifer crown: 5 stacked tapered cones with jitter for ragged
// branches. Each layer is rotated slightly so the silhouette doesn't repeat.
function makeConiferCrownGeo() {
  const layers = [];
  // Bottom tier widest, top narrowest. Layers overlap so there are no gaps.
  const tiers = [
    { y: 1.6, r: 1.7,  h: 1.6, seg: 11 },
    { y: 2.4, r: 1.45, h: 1.5, seg: 10 },
    { y: 3.1, r: 1.20, h: 1.4, seg: 10 },
    { y: 3.8, r: 0.95, h: 1.3, seg: 9 },
    { y: 4.5, r: 0.65, h: 1.1, seg: 8 },
    { y: 5.1, r: 0.30, h: 0.8, seg: 7 },
  ];
  for (const t of tiers) {
    const g = new THREE.ConeGeometry(t.r, t.h, t.seg);
    g.translate(0, t.y, 0);
    // Rotate each layer randomly so seams don't line up vertically.
    g.rotateY(Math.random() * Math.PI * 2);
    jitterGeometry(g, 0.13);
    layers.push(g);
  }
  const geo = mergeGeometries(layers, false);
  layers.forEach((g) => g.dispose());
  return geo;
}

// Build a broadleaf crown: a cluster of noise-displaced icospheres of varying
// size and offset, plus a couple of internal branches that poke through.
function makeBroadleafCrownGeo() {
  const blobs = [
    // Central canopy
    new THREE.IcosahedronGeometry(1.7, 1).translate(0, 3.0, 0),
    // Side lobes
    new THREE.IcosahedronGeometry(1.25, 1).translate(1.1, 2.8, 0.4),
    new THREE.IcosahedronGeometry(1.20, 1).translate(-1.0, 2.7, -0.5),
    new THREE.IcosahedronGeometry(1.05, 1).translate(0.4, 3.6, -0.8),
    new THREE.IcosahedronGeometry(0.95, 1).translate(-0.6, 3.5, 0.7),
    // Crown top
    new THREE.IcosahedronGeometry(0.90, 1).translate(0.1, 4.0, 0.1),
    // Skirt blobs hanging down a little
    new THREE.IcosahedronGeometry(0.75, 1).translate(0.8, 2.1, 0.6),
    new THREE.IcosahedronGeometry(0.70, 1).translate(-0.7, 2.2, -0.3),
  ];
  for (const b of blobs) jitterGeometry(b, 0.18);

  // A couple of stub branches that pop out so the foliage isn't a perfect blob.
  const branchA = new THREE.CylinderGeometry(0.045, 0.07, 0.9, 6);
  branchA.translate(0, 0.45, 0);
  branchA.rotateZ(0.5); branchA.rotateY(0.3);
  branchA.translate(0.6, 2.0, 0.0);
  const branchB = new THREE.CylinderGeometry(0.04, 0.065, 0.85, 6);
  branchB.translate(0, 0.45, 0);
  branchB.rotateZ(-0.6); branchB.rotateY(-0.4);
  branchB.translate(-0.55, 2.1, 0.15);

  const merged = mergeGeometries([...blobs, branchA, branchB], false);
  blobs.forEach((b) => b.dispose());
  branchA.dispose(); branchB.dispose();
  return merged;
}

// Build a tapered trunk: 8-sided cylinder with a slight curve and bark grooves
// (radial vertex jitter on the sides). Keeps the trunk count low (<100 tris).
function makeTrunkGeo({ baseR = 0.34, topR = 0.16, height = 1.8, segs = 8 } = {}) {
  const geo = new THREE.CylinderGeometry(topR, baseR, height, segs, 3);
  geo.translate(0, height / 2, 0);
  // Slight bark roughness: jitter X/Z by a small amount (NOT Y, so the trunk
  // doesn't grow taller).
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const r = Math.hypot(x, z) || 1;
    const wob = (Math.random() - 0.5) * 0.025;
    pos.setXYZ(i, x + (x / r) * wob, y, z + (z / r) * wob);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

// Foliage shader: wind sway + AO + tip-lighter gradient + per-instance tint.
// Wraps the basic standard material features we need without paying for the
// full MeshStandardMaterial PBR cost (which is overkill for ~tens of thousands
// of tris of leaves).
const FOLIAGE_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uWind;
  attribute vec3 instanceColor; // tint per instance
  varying vec3 vNormalW;
  varying vec3 vWorldPos;
  varying vec3 vTint;
  varying float vRelHeight; // 0 at trunk top, 1 at crown top

  void main() {
    vec3 p = position;

    // Wind sway: only affects high parts of the crown. The base of the foliage
    // sits at ~y=1.5; cap the sway so it doesn't drift past visual plausibility.
    float swayMask = clamp((p.y - 1.6) * 0.55, 0.0, 1.0);
    // Use the per-instance world position so adjacent trees don't sway in lockstep.
    vec3 instPos = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
    float ph = instPos.x * 0.21 + instPos.z * 0.17;
    float t = uTime;
    p.x += sin(t * 1.1 + ph) * uWind * 0.18 * swayMask;
    p.z += cos(t * 0.9 + ph * 1.3) * uWind * 0.13 * swayMask;

    vec4 wp = instanceMatrix * vec4(p, 1.0);
    wp = modelMatrix * wp;
    vWorldPos = wp.xyz;

    vec3 n = normalize(normalMatrix * (mat3(instanceMatrix) * normal));
    vNormalW = n;

    vTint = instanceColor;
    vRelHeight = clamp((p.y - 1.5) / 4.0, 0.0, 1.0);

    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FOLIAGE_FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uAmbient;
  uniform vec3 uBaseColor;
  uniform vec3 uTipColor;
  uniform vec3 uFogColor;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform vec3 uCamPos;

  varying vec3 vNormalW;
  varying vec3 vWorldPos;
  varying vec3 vTint;
  varying float vRelHeight;

  void main() {
    vec3 normal = normalize(vNormalW);
    // Gradient: base color at the interior, tip color at high relative height.
    vec3 col = mix(uBaseColor, uTipColor, vRelHeight);
    col *= vTint;

    // Lambert + ambient.
    float ndl = max(dot(normal, normalize(uSunDir)), 0.0);
    // Soften the contact light so deeply-shaded undersides still read green.
    vec3 lit = col * (uAmbient + uSunColor * ndl);

    // Cheap fake-AO: darker for downward-facing normals (interior of the crown).
    float ao = 0.55 + 0.45 * clamp(normal.y * 0.5 + 0.5, 0.0, 1.0);
    lit *= ao;

    // Distance fog matching the scene.
    float d = distance(uCamPos, vWorldPos);
    float fog = clamp((d - uFogNear) / max(1.0, uFogFar - uFogNear), 0.0, 1.0);
    lit = mix(lit, uFogColor, fog);

    gl_FragColor = vec4(lit, 1.0);
  }
`;

function makeFoliageMaterial(kind) {
  const isConifer = kind === 'conifer';
  return new THREE.ShaderMaterial({
    vertexShader: FOLIAGE_VERT,
    fragmentShader: FOLIAGE_FRAG,
    uniforms: {
      uTime:      { value: 0 },
      uWind:      { value: 0.7 },
      uSunDir:    { value: new THREE.Vector3(0.5, 1, 0.5).normalize() },
      uSunColor:  { value: new THREE.Color(0xfff2dd) },
      uAmbient:   { value: new THREE.Color(0x3a4a30) },
      uBaseColor: { value: new THREE.Color(isConifer ? 0x1f3a1a : 0x2a4f24) },
      uTipColor:  { value: new THREE.Color(isConifer ? 0x4f7e3a : 0x8fbd5a) },
      uFogColor:  { value: new THREE.Color(0xbcd4e6) },
      uFogNear:   { value: 60 },
      uFogFar:    { value: 600 },
      uCamPos:    { value: new THREE.Vector3() },
    },
  });
}

// Track foliage materials so the env can advance their time + camera uniforms.
const _foliageMaterials = new Set();

function makeTreeInstanced(count, kind = 'conifer') {
  const trunkGeo = makeTrunkGeo({
    baseR: kind === 'broadleaf' ? 0.40 : 0.30,
    topR:  kind === 'broadleaf' ? 0.22 : 0.14,
    height: kind === 'broadleaf' ? 2.1 : 1.7,
    segs: 8,
  });
  const crownGeo = kind === 'broadleaf' ? makeBroadleafCrownGeo() : makeConiferCrownGeo();

  // Trunk uses a cheap MeshLambertMaterial with vertex-driven instance tinting
  // so each tree gets a slightly different bark color.
  const trunkMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const crownMat = makeFoliageMaterial(kind);
  _foliageMaterials.add(crownMat);

  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
  const crowns = new THREE.InstancedMesh(crownGeo, crownMat, count);
  trunks.castShadow = true;
  crowns.castShadow = true;
  trunks.receiveShadow = true;
  crowns.receiveShadow = false;
  trunks.frustumCulled = true;
  crowns.frustumCulled = true;
  return { trunks, crowns };
}

// Engine should call this from its tick to animate the wind sway + update the
// camera-position uniform for fog and (eventually) view-dependent shading.
export function tickFoliage(dt, { cameraPos, sunDir, wind } = {}) {
  for (const m of _foliageMaterials) {
    m.uniforms.uTime.value += dt;
    if (cameraPos) m.uniforms.uCamPos.value.copy(cameraPos);
    if (sunDir)    m.uniforms.uSunDir.value.copy(sunDir).normalize();
    if (typeof wind === 'number') m.uniforms.uWind.value = wind;
  }
}

// Green + bark palettes for per-instance variation.
const FOLIAGE_TINTS = [
  new THREE.Color(0.90, 0.95, 0.85),
  new THREE.Color(1.00, 1.05, 0.95),
  new THREE.Color(0.85, 0.95, 0.80),
  new THREE.Color(1.05, 1.00, 0.85),
  new THREE.Color(0.95, 1.00, 0.90),
  new THREE.Color(0.80, 0.90, 0.78),
];
const BARK_TINTS = [
  new THREE.Color(0x4f3220), new THREE.Color(0x5a3a22),
  new THREE.Color(0x6b4a30), new THREE.Color(0x42291a),
  new THREE.Color(0x7a5236),
];

// ---------- rocks ----------

// Small instanced rocks scattered in the rough outside the play corridor. Adds
// terrain texture and breaks up the empty rough.
function scatterRocks(scene, holeData) {
  const { minX, maxX, minZ, maxZ } = holeBounds(holeData);
  const area = (maxX - minX) * (maxZ - minZ);
  const target = Math.min(80, Math.max(20, Math.floor(area * 0.0015)));

  const safe = (x, z) => {
    for (const r of holeData.regions ?? []) {
      if (r.type === 'rough' && r.shape === 'fill') continue;
      if (regionContains(r, x, z)) return false;
    }
    // keep out of the immediate tee corridor
    if (Math.abs(x - holeData.tee.x) < 6 && z < holeData.tee.z + 20 && z > holeData.tee.z - 5) return false;
    return true;
  };

  const positions = [];
  let attempts = 0;
  while (positions.length < target && attempts < target * 8) {
    attempts++;
    const x = minX + Math.random() * (maxX - minX);
    const z = minZ + Math.random() * (maxZ - minZ);
    if (!safe(x, z)) continue;
    positions.push({ x, z });
  }
  if (!positions.length) return null;

  const geo = new THREE.IcosahedronGeometry(0.45, 0);
  // Jitter vertices a little for non-uniform rock shapes.
  const arr = geo.attributes.position.array;
  for (let i = 0; i < arr.length; i++) arr[i] *= 0.85 + Math.random() * 0.3;
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    color: 0x8a8076,
    roughness: 0.95,
    metalness: 0.0,
    flatShading: true,
  });

  const inst = new THREE.InstancedMesh(geo, mat, positions.length);
  inst.castShadow = true;
  inst.receiveShadow = true;
  inst.name = 'rocks';
  const dummy = new THREE.Object3D();
  positions.forEach((p, i) => {
    const s = 0.35 + Math.random() * 1.4;
    dummy.position.set(p.x, s * 0.3, p.z);
    dummy.rotation.set(Math.random() * 0.4, Math.random() * Math.PI * 2, Math.random() * 0.4);
    dummy.scale.set(s, s * (0.6 + Math.random() * 0.4), s);
    dummy.updateMatrix();
    inst.setMatrixAt(i, dummy.matrix);
  });
  inst.instanceMatrix.needsUpdate = true;
  scene.add(inst);
  return inst;
}

function scatterTrees(scene, holeData, density = 0.012) {
  const { minX, maxX, minZ, maxZ } = holeBounds(holeData);
  const area = (maxX - minX) * (maxZ - minZ);
  const target = Math.min(450, Math.floor(area * density));
  if (target <= 0) return null;

  // Pick candidate points first so we can size the InstancedMesh exactly.
  const candidates = [];
  const safeFromPlay = (x, z) => {
    for (const r of holeData.regions ?? []) {
      if (r.type === 'rough' && r.shape === 'fill') continue;
      // tree must be OUTSIDE any region (we don't want trees in fairway/sand/water)
      if (regionContains(r, x, z)) return false;
    }
    return true;
  };

  let attempts = 0;
  while (candidates.length < target && attempts < target * 6) {
    attempts++;
    const x = minX + Math.random() * (maxX - minX);
    const z = minZ + Math.random() * (maxZ - minZ);
    if (!safeFromPlay(x, z)) continue;
    // Don't block view from tee.
    if (Math.abs(x - holeData.tee.x) < 8 && z < holeData.tee.z + 8) continue;
    candidates.push({ x, z });
  }

  if (!candidates.length) return null;

  // Split candidates ~60/40 between conifers and broadleaf for variety.
  const coniferPts = [];
  const broadleafPts = [];
  for (const c of candidates) (Math.random() < 0.6 ? coniferPts : broadleafPts).push(c);

  const meshes = [];
  const dummy = new THREE.Object3D();

  function buildSpecies(pts, kind) {
    if (!pts.length) return;
    const { trunks, crowns } = makeTreeInstanced(pts.length, kind);
    pts.forEach((c, i) => {
      // Three size classes so the forest reads as multi-generational, not
      // copy-pasted. Small saplings (10%), medium (60%), large mature (30%).
      const sizeRoll = Math.random();
      let scale;
      if (sizeRoll < 0.10) scale = 0.55 + Math.random() * 0.20;       // sapling
      else if (sizeRoll < 0.70) scale = 0.85 + Math.random() * 0.35;  // medium
      else scale = 1.25 + Math.random() * 0.55;                       // mature
      const yScale = scale * (0.92 + Math.random() * 0.18);
      const rot = Math.random() * Math.PI * 2;
      const lean = (Math.random() - 0.5) * 0.08;
      dummy.position.set(c.x, 0, c.z);
      dummy.rotation.set(lean, rot, lean);
      dummy.scale.set(scale, yScale, scale);
      dummy.updateMatrix();
      trunks.setMatrixAt(i, dummy.matrix);
      crowns.setMatrixAt(i, dummy.matrix);
      crowns.setColorAt(i, FOLIAGE_TINTS[(Math.random() * FOLIAGE_TINTS.length) | 0]);
      trunks.setColorAt(i, BARK_TINTS[(Math.random() * BARK_TINTS.length) | 0]);
    });
    trunks.instanceMatrix.needsUpdate = true;
    crowns.instanceMatrix.needsUpdate = true;
    if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
    if (trunks.instanceColor) trunks.instanceColor.needsUpdate = true;
    scene.add(trunks);
    scene.add(crowns);
    meshes.push(trunks, crowns);
  }

  buildSpecies(coniferPts, 'conifer');
  buildSpecies(broadleafPts, 'broadleaf');

  // Keep the legacy { trunks, crowns } shape AND expose the full mesh list so
  // golf.js disposeDecor can clean everything up regardless of species count.
  return { trunks: meshes[0] ?? null, crowns: meshes[1] ?? null, meshes };
}

// ---------- tee sign ----------

function makeTextTexture(lines, { width = 512, height = 256, bg = '#1a3a1f' } = {}) {
  const c = (typeof OffscreenCanvas !== 'undefined')
    ? new OffscreenCanvas(width, height)
    : Object.assign(document.createElement('canvas'), { width, height });
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);
  // Subtle wood-plank seam
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(0, height / 2); ctx.lineTo(width, height / 2);
  ctx.stroke();

  ctx.fillStyle = '#f5e9c8';
  ctx.font = 'bold 56px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(lines[0] ?? '', width / 2, height / 3);
  ctx.font = 'bold 40px system-ui, sans-serif';
  ctx.fillText(lines[1] ?? '', width / 2, (height * 2) / 3);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function addTeeSign(scene, holeData) {
  const tex = makeTextTexture([
    `HOLE ${holeData.number}  ·  PAR ${holeData.par}`,
    `${holeData.yardage} YDS  ·  ${holeData.name}`,
  ]);
  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(2.2, 1.0),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7, metalness: 0.05, side: THREE.DoubleSide }),
  );
  board.position.set(0, 1.3, -0.05);
  board.castShadow = true;

  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.07, 1.6, 8),
    new THREE.MeshStandardMaterial({ color: 0x6b3f1e, roughness: 0.85 }),
  );
  post.position.set(0, 0.8, -0.05);
  post.castShadow = true;

  const grp = new THREE.Group();
  grp.add(board);
  grp.add(post);
  // Place just behind and to the side of the tee box.
  grp.position.set(holeData.tee.x - 4.5, 0, holeData.tee.z - 1.5);
  // Face the player
  grp.rotation.y = Math.PI * 0.05;
  scene.add(grp);
  return grp;
}

// ---------- public API ----------

// `opts` may include { sunDir, fogColor, fogNear, fogFar, wind } to seed the
// grass shader. The engine should call `env.tick(dt, { ballPos, cameraPos })`
// each frame so the grass patch follows the ball and the wind animates.
export function decorateHole(scene, holeData, opts = {}) {
  const trees = scatterTrees(scene, holeData);
  const rocks = scatterRocks(scene, holeData);
  const sign = addTeeSign(scene, holeData);

  // Instanced grass patch around the ball. Uses InstancedMesh — one draw call
  // for up to several thousand blades. Frustum-culled by its bounding sphere.
  let grass = null;
  try {
    grass = createGrassPatch({
      count: 5000,
      radius: 20,
      sunDir: opts.sunDir ?? new THREE.Vector3(0.5, 1, 0.5).normalize(),
      fogColor: opts.fogColor ?? new THREE.Color(0xbcd4e6),
      fogNear: opts.fogNear ?? 30,
      fogFar:  opts.fogFar  ?? 110,
    });
    grass.setCenter(new THREE.Vector3(holeData.tee.x, 0.02, holeData.tee.z));
    scene.add(grass.mesh);
  } catch (err) {
    console.warn('[environment] grass init failed', err);
  }

  let grassDensity = 1.0;
  let treeDensity = 1.0;
  let windSpeed = opts.wind?.speed ?? 0.7;

  function tick(dt, ctx = {}) {
    if (grass) {
      if (ctx.ballPos) {
        grass.setCenter(new THREE.Vector3(ctx.ballPos.x, 0.02, ctx.ballPos.z));
      }
      grass.tick(dt, {
        cameraPos: ctx.cameraPos,
        sunDir: ctx.sunDir,
        wind: ctx.wind ?? windSpeed,
      });
    }
    // Trees: animate the wind sway uniform and feed camera pos for fog.
    tickFoliage(dt, {
      cameraPos: ctx.cameraPos,
      sunDir: ctx.sunDir,
      wind: ctx.wind ?? windSpeed,
    });
  }

  function setGrassDensity(d) {
    grassDensity = Math.max(0, Math.min(1, d));
    if (grass) grass.setDensity(grassDensity);
  }
  function setTreeDensity(d) {
    treeDensity = Math.max(0, Math.min(1, d));
    // Trees were rendered as merged geometry — toggle visibility for now.
    // (A finer-grained cut would re-scatter at lower density; not worth the cost yet.)
    if (trees?.meshes) {
      for (const m of trees.meshes) m.visible = treeDensity > 0;
    } else {
      if (trees?.trunks) trees.trunks.visible = treeDensity > 0;
      if (trees?.crowns) trees.crowns.visible = treeDensity > 0;
    }
  }
  function setWaterReflection(_enabled, _size) {
    // materials.js owns the water reflector swap; this stub is here so the
    // quality.applyQuality() call signature works without errors.
  }

  function dispose() {
    if (grass) { scene.remove(grass.mesh); try { grass.dispose(); } catch {} }
    if (sign?.parent) scene.remove(sign);
    if (rocks?.parent) scene.remove(rocks);
    if (trees?.meshes) for (const m of trees.meshes) scene.remove(m);
    else {
      if (trees?.trunks) scene.remove(trees.trunks);
      if (trees?.crowns) scene.remove(trees.crowns);
    }
  }

  return {
    trees, rocks, sign, grass,
    tick,
    setGrassDensity,
    setTreeDensity,
    setWaterReflection,
    dispose,
  };
}

// ---------- flyover ----------

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

// Animates the camera from above the pin down to a 3rd-person tee position
// over `durationMs`. Returns a Promise resolved when the animation completes.
// Caller is responsible for not running its own camera follow during the flyover.
export function holeFlyover(camera, scene, holeData, durationMs = 3000) {
  return new Promise((resolve) => {
    const tee = holeData.tee;
    const pin = holeData.pin;

    // Direction tee -> pin in XZ
    const dx = pin.x - tee.x;
    const dz = pin.z - tee.z;
    const dirLen = Math.hypot(dx, dz) || 1;
    const fx = dx / dirLen, fz = dz / dirLen;

    // Start: high above pin, looking back toward tee
    const start = {
      pos: new THREE.Vector3(pin.x - fx * 25, 55, pin.z - fz * 25),
      look: new THREE.Vector3(tee.x, 0, tee.z),
    };
    // Mid: along the fairway, half-height
    const mid = {
      pos: new THREE.Vector3((tee.x + pin.x) / 2 - fx * 5, 22, (tee.z + pin.z) / 2 - fz * 10),
      look: new THREE.Vector3(pin.x, 0, pin.z),
    };
    // End: 3rd-person tee shot framing
    const end = {
      pos: new THREE.Vector3(tee.x - fx * 6, 2.6, tee.z - fz * 6),
      look: new THREE.Vector3(tee.x + fx * 20, 0.5, tee.z + fz * 20),
    };

    const t0 = performance.now();
    const tmpPos = new THREE.Vector3();
    const tmpLook = new THREE.Vector3();

    function bezier(a, b, c, t) {
      const u = 1 - t;
      return tmpPos.set(0, 0, 0)
        .addScaledVector(a, u * u)
        .addScaledVector(b, 2 * u * t)
        .addScaledVector(c, t * t)
        .clone();
    }
    function lerpV(a, b, t) {
      return tmpLook.set(0, 0, 0).addScaledVector(a, 1 - t).addScaledVector(b, t).clone();
    }

    let raf = 0;
    function step() {
      const now = performance.now();
      const raw = Math.min(1, (now - t0) / durationMs);
      const t = easeInOut(raw);
      const pos = bezier(start.pos, mid.pos, end.pos, t);
      const look = (t < 0.5)
        ? lerpV(start.look, mid.look, t * 2)
        : lerpV(mid.look, end.look, (t - 0.5) * 2);
      camera.position.copy(pos);
      camera.lookAt(look);
      if (raw < 1) {
        raf = requestAnimationFrame(step);
      } else {
        resolve();
      }
    }
    raf = requestAnimationFrame(step);
  });
}
