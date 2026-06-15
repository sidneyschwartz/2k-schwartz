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

// Build a layered conifer crown (3 stacked, tapering cones) merged into ONE geometry
// so the whole tree's foliage is a single instanced draw call but reads as a real
// pine rather than a traffic cone.
function makeConiferCrownGeo() {
  const layers = [
    new THREE.ConeGeometry(1.5, 2.2, 9).translate(0, 1.9, 0),
    new THREE.ConeGeometry(1.15, 2.0, 9).translate(0, 3.0, 0),
    new THREE.ConeGeometry(0.75, 1.8, 9).translate(0, 4.1, 0),
  ];
  const geo = mergeGeometries(layers, false);
  layers.forEach((g) => g.dispose());
  return geo;
}

// Build a rounded broadleaf crown from a few overlapping low-poly spheres.
function makeBroadleafCrownGeo() {
  const blobs = [
    new THREE.IcosahedronGeometry(1.5, 1).translate(0, 3.0, 0),
    new THREE.IcosahedronGeometry(1.1, 1).translate(0.9, 2.6, 0.4),
    new THREE.IcosahedronGeometry(1.0, 1).translate(-0.8, 2.7, -0.5),
    new THREE.IcosahedronGeometry(0.9, 1).translate(0.2, 3.7, -0.3),
  ];
  const geo = mergeGeometries(blobs, false);
  blobs.forEach((g) => g.dispose());
  return geo;
}

function makeTreeInstanced(count, kind = 'conifer') {
  // Tapered trunk (wide base → narrow top) with a bark-ish color.
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.34, 1.8, 7);
  trunkGeo.translate(0, 0.9, 0);
  const crownGeo = kind === 'broadleaf' ? makeBroadleafCrownGeo() : makeConiferCrownGeo();

  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.95, metalness: 0 });
  // White base color so per-instance setColorAt tints give foliage variety.
  const crownMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, flatShading: true });

  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
  const crowns = new THREE.InstancedMesh(crownGeo, crownMat, count);
  trunks.castShadow = true;
  crowns.castShadow = true;
  trunks.receiveShadow = true;
  crowns.receiveShadow = false;
  return { trunks, crowns };
}

// Green palette for per-instance foliage variation.
const FOLIAGE_TINTS = [
  new THREE.Color(0x2f6b2f), new THREE.Color(0x3a7d3a), new THREE.Color(0x27592a),
  new THREE.Color(0x4c8a3c), new THREE.Color(0x356b2e), new THREE.Color(0x2d6b40),
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
      const scale = 0.8 + Math.random() * 0.8;
      const rot = Math.random() * Math.PI * 2;
      const lean = (Math.random() - 0.5) * 0.08; // slight natural lean
      dummy.position.set(c.x, 0, c.z);
      dummy.rotation.set(lean, rot, lean);
      dummy.scale.set(scale, scale * (0.9 + Math.random() * 0.5), scale);
      dummy.updateMatrix();
      trunks.setMatrixAt(i, dummy.matrix);
      crowns.setMatrixAt(i, dummy.matrix);
      const tint = FOLIAGE_TINTS[(Math.random() * FOLIAGE_TINTS.length) | 0];
      crowns.setColorAt(i, tint);
    });
    trunks.instanceMatrix.needsUpdate = true;
    crowns.instanceMatrix.needsUpdate = true;
    if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
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
