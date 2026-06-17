// Hole terrain builder. Consumes the hole data shape from `holes.js` and emits
// a Three.js group + cannon static bodies (via physics.addStaticMesh).
//
// Region shapes supported:
//   - rect:   { x, z, w, d, rotY? }                             — tee, water, rectangular hazards
//   - circle: { x, z, r, elevation? }                           — greens, fairway islands, bunkers
//   - ring:   { x, z, r, r2 }                                   — collar of rough around a green
//   - spline: { points: [{x,z,w}, ...] }                        — fairway corridor with per-control-point width
//   - fill:   {} (implicit ground — caller doesn't need a mesh) — handled by infinite cannon plane
//
// Surface tagging: every region's `type` is passed to the physics layer:
//   tee/fairway/green -> 'fairway' (low friction). rough -> 'rough'. sand -> 'rough' (high friction).
//   water -> NOT collidable; treated as a hazard sensor zone (returned in `hazards` for the engine).
//
// Vertical stacking (so each surface rolls correctly):
//   rough:    y=0.000  (default ground)
//   fairway:  y=0.010
//   tee:      y=0.020
//   sand:     y=0.015
//   green:    y=0.025 (+ optional elevation from hole data)
//   water:    y=0.005 (visual only)

import * as THREE from 'three';
import { heightAt, greenBreakAt } from './heightfield.js';

const Y = {
  rough: 0.000,
  fairway: 0.010,
  sand: 0.015,
  tee: 0.020,
  green: 0.025,
  water: 0.005,
};

// Subdivision densities for displacement. Higher = smoother contour but more
// triangles. ~1 segment per 4m is a good visual+perf compromise.
const SEG_PER_METER = 1 / 4;
function segments(extent) {
  return Math.max(8, Math.min(64, Math.round(extent * SEG_PER_METER)));
}

// Apply the heightAt() displacement to a Three.js plane that has already been
// rotated -90° about X (so the plane lies in world XZ). Position attribute is
// pre-rotation, so geometry y-axis points "up" out of the plane — we set z
// (geometry z) to the height delta, then computeVertexNormals.
//
// World-space coordinate of vertex i = (mesh.position.x + posAttr.getX(i),
//                                       _,
//                                       mesh.position.z - posAttr.getY(i))
// because the -90° rotation maps geometry Y onto world -Z. We need world XZ to
// look up heightAt().
function displacePlane(geometry, mesh, holeData) {
  const pos = geometry.attributes.position;
  const mx = mesh.position.x;
  const mz = mesh.position.z;
  for (let i = 0; i < pos.count; i++) {
    const gx = pos.getX(i);
    const gy = pos.getY(i);
    const worldX = mx + gx;
    const worldZ = mz - gy; // rotation -90° X: world z = -geometry y
    const dh = heightAt(worldX, worldZ, holeData);
    pos.setZ(i, dh); // before rotation, geometry Z becomes world Y after rotation
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
}

// Spline meshes are already in world XZ (no -90° rotation needed); displacement
// is direct on the Y axis of each vertex.
function displaceWorldPlane(geometry, holeData) {
  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    pos.setY(i, heightAt(x, z, holeData) + pos.getY(i));
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
}

// Fallback colors used when no applyMaterial callback is supplied or the
// art-agent materials throw.
const FALLBACK_COLORS = {
  fairway: 0x4ea24a,
  rough: 0x2c6a30,
  green: 0x7ed070,
  tee: 0x6fbf6c,
  sand: 0xe8d28a,
  water: 0x2a6db5,
};

const HOLE_CUP_RADIUS = 0.108;

export function buildHole(scene, physics, holeData, { applyMaterial } = {}) {
  const group = new THREE.Group();
  scene.add(group);
  const ownedMeshes = [];
  const hazards = []; // { type: 'water'|'sand', shape, x, z, r?, w?, d? }
  const cupMeshes = [];

  // ---- BASE ROUGH GROUND ----
  // Without this, anything outside an explicit region renders as bare sky.
  // Big plane stretching from well behind the tee to well past the pin.
  const baseSize = 1200;
  const dx = (holeData.tee?.x ?? 0) + (holeData.pin?.x ?? 0);
  const dz = (holeData.tee?.z ?? 0) + (holeData.pin?.z ?? 0);
  const baseCenter = { x: dx * 0.5, z: dz * 0.5 };
  // Subdivide the base so the per-hole fbm roll is visible in the foreground rough.
  // ~1 segment per 8m for the big base plane; over a 1200x1200 area that's ~150x150
  // verts ≈ 22k triangles. Fine on any GPU; the alternative is a flat sky-base.
  const baseSeg = 150;
  const baseGeo = new THREE.PlaneGeometry(baseSize, baseSize, baseSeg, baseSeg);
  let baseMat = null;
  if (applyMaterial) {
    try {
      const dummy = new THREE.Mesh();
      const ret = applyMaterial('rough', dummy, { shape: 'fill' });
      baseMat = ret instanceof THREE.Material ? ret : dummy.material;
    } catch {}
  }
  if (!baseMat) baseMat = new THREE.MeshStandardMaterial({ color: FALLBACK_COLORS.rough, roughness: 0.95 });
  const base = new THREE.Mesh(baseGeo, baseMat);
  base.rotation.x = -Math.PI / 2;
  base.position.set(baseCenter.x, -0.005, baseCenter.z);
  displacePlane(baseGeo, base, holeData);
  // receiveShadow OFF on the base — the directional light's shadow camera frustum
  // (±160 m from origin) is much smaller than the base plane (±600 m), so the
  // foreground samples outside the shadow map and is treated as fully shadowed.
  base.receiveShadow = false;
  group.add(base);
  ownedMeshes.push(base);

  function makeMaterial(surfaceType, opts = {}) {
    if (applyMaterial) {
      try {
        const dummy = new THREE.Mesh();
        const ret = applyMaterial(surfaceType, dummy, opts);
        // applyMaterial may return a Material or attach via dummy.material
        const m = ret instanceof THREE.Material ? ret : dummy.material;
        if (m) return m;
      } catch (err) {
        console.warn(`[terrain] applyMaterial(${surfaceType}) failed, falling back:`, err?.message);
      }
    }
    const color = FALLBACK_COLORS[surfaceType] ?? 0x808080;
    const params = { color, roughness: 0.95, metalness: 0 };
    if (surfaceType === 'water') { params.roughness = 0.1; params.metalness = 0.6; params.transparent = true; params.opacity = 0.85; }
    return new THREE.MeshStandardMaterial(params);
  }

  function addMesh(mesh, surfaceType, { collidable = true, physicsSurface = null } = {}) {
    mesh.receiveShadow = true;
    group.add(mesh);
    ownedMeshes.push(mesh);
    if (collidable) {
      const tag = physicsSurface ?? mapSurface(surfaceType);
      try {
        physics.addStaticMesh(mesh, tag);
      } catch (err) {
        console.warn(`[terrain] addStaticMesh failed for ${surfaceType}:`, err?.message);
      }
    }
    return mesh;
  }

  function rectMesh(region, surfaceType) {
    const segW = segments(region.w);
    const segD = segments(region.d);
    const geo = new THREE.PlaneGeometry(region.w, region.d, segW, segD);
    const mat = makeMaterial(surfaceType, region);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    if (region.rotY) mesh.rotation.z = region.rotY;
    mesh.position.set(region.x, Y[surfaceType] ?? 0, region.z);
    // Water is flat — don't ripple the lake surface with terrain bumps.
    if (surfaceType !== 'water') displacePlane(geo, mesh, holeData);
    return mesh;
  }

  function circleMesh(region, surfaceType, segs = 48) {
    const r = region.r;
    // Add radial segments for displacement: extra rings between center + edge.
    const rings = Math.max(4, Math.round(r * SEG_PER_METER * 2));
    const geo = new THREE.CircleGeometry(r, segs, 0, Math.PI * 2);
    // CircleGeometry only has a center vertex + edge ring by default — not enough
    // for smooth contour. Build our own disc with rings instead.
    const discGeo = buildDiscGeometry(r, segs, rings);
    geo.dispose();
    const mat = makeMaterial(surfaceType, region);
    const mesh = new THREE.Mesh(discGeo, mat);
    mesh.rotation.x = -Math.PI / 2;
    const y = (Y[surfaceType] ?? 0); // base elevation is applied via heightAt, not mesh.y
    mesh.position.set(region.x, y, region.z);
    if (surfaceType !== 'water') displacePlane(discGeo, mesh, holeData);
    return mesh;
  }

  function ringMesh(region, surfaceType, segs = 48) {
    // Add radial rings between r and r2 so collar of rough catches the height field.
    const rings = Math.max(2, Math.round((region.r2 - region.r) * SEG_PER_METER * 2));
    const geo = buildRingGeometry(region.r, region.r2, segs, rings);
    const mat = makeMaterial(surfaceType, region);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(region.x, Y[surfaceType] ?? 0, region.z);
    displacePlane(geo, mesh, holeData);
    return mesh;
  }

  function splineMesh(region, surfaceType) {
    // Sample a Catmull-Rom centerline through the control points; emit a triangle
    // strip along the +X/-X offset by per-segment width.
    const ctrl = region.points.map((p) => new THREE.Vector3(p.x, 0, p.z));
    if (ctrl.length < 2) return null;
    const curve = new THREE.CatmullRomCurve3(ctrl, false, 'catmullrom', 0.2);
    const samples = Math.max(32, ctrl.length * 16);
    const positions = [];
    const indices = [];
    const widthAt = (t) => {
      // piecewise-linear width by segment
      const seg = t * (region.points.length - 1);
      const i0 = Math.floor(seg);
      const i1 = Math.min(region.points.length - 1, i0 + 1);
      const f = seg - i0;
      return region.points[i0].w * (1 - f) + region.points[i1].w * f;
    };
    const tmpTangent = new THREE.Vector3();
    const tmpPt = new THREE.Vector3();
    const y = Y[surfaceType] ?? 0;
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      curve.getPointAt(t, tmpPt);
      curve.getTangentAt(t, tmpTangent);
      // Side vector in XZ (perpendicular to tangent, on the ground plane)
      const sx = tmpTangent.z;
      const sz = -tmpTangent.x;
      const sLen = Math.hypot(sx, sz) || 1;
      const nx = sx / sLen;
      const nz = sz / sLen;
      const half = widthAt(t) * 0.5;
      positions.push(tmpPt.x + nx * half, y, tmpPt.z + nz * half);
      positions.push(tmpPt.x - nx * half, y, tmpPt.z - nz * half);
    }
    for (let i = 0; i < samples; i++) {
      const a = i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      indices.push(a, c, b, b, c, d);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mat = makeMaterial(surfaceType, region);
    // Spline verts are already in world XZ — apply terrain height directly on Y.
    displaceWorldPlane(geo, holeData);
    return new THREE.Mesh(geo, mat);
  }

  // ---- Process regions ----
  for (const region of holeData.regions) {
    const t = region.type;
    if (region.shape === 'fill') {
      // Implicit: handled by physics' default ground plane (rough). No mesh emitted —
      // the art agent layers a big rough plane elsewhere if they want one.
      continue;
    }
    if (t === 'water') {
      const m = region.shape === 'rect' ? rectMesh(region, 'water')
        : region.shape === 'circle' ? circleMesh(region, 'water')
        : null;
      if (m) addMesh(m, 'water', { collidable: false });
      hazards.push({ type: 'water', ...region });
      continue;
    }
    if (region.shape === 'rect') {
      const m = rectMesh(region, t);
      addMesh(m, t);
    } else if (region.shape === 'circle') {
      const m = circleMesh(region, t);
      addMesh(m, t);
      if (t === 'sand') hazards.push({ type: 'sand', ...region });
    } else if (region.shape === 'ring') {
      const m = ringMesh(region, t);
      addMesh(m, t);
    } else if (region.shape === 'spline') {
      const m = splineMesh(region, t);
      if (m) addMesh(m, t);
    }
  }

  // ---- Pin + cup ----
  // Pin sits on the actual contoured green surface, not just the region's base
  // elevation — heightAt() composes plateau + contour + base roll.
  const pinTerrainH = heightAt(holeData.pin.x, holeData.pin.z, holeData);
  const pinWorld = new THREE.Vector3(holeData.pin.x, Y.green + pinTerrainH, holeData.pin.z);

  const pinGroup = new THREE.Group();
  const poleGeo = new THREE.CylinderGeometry(0.015, 0.015, 2.2, 8);
  const poleMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
  const pole = new THREE.Mesh(poleGeo, poleMat);
  pole.position.y = 1.1;
  pole.castShadow = true;
  pinGroup.add(pole);
  const flagShape = new THREE.BufferGeometry();
  flagShape.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 2.1, 0,
    0.6, 1.9, 0,
    0, 1.7, 0,
  ], 3));
  flagShape.setIndex([0, 1, 2]);
  flagShape.computeVertexNormals();
  const flagMat = new THREE.MeshStandardMaterial({ color: 0xd23030, side: THREE.DoubleSide });
  pinGroup.add(new THREE.Mesh(flagShape, flagMat));
  pinGroup.position.copy(pinWorld);
  group.add(pinGroup);

  // Cup hole (dark disc just above the green surface)
  const cupGeo = new THREE.CircleGeometry(HOLE_CUP_RADIUS, 24);
  const cupMat = new THREE.MeshBasicMaterial({ color: 0x080808 });
  const cup = new THREE.Mesh(cupGeo, cupMat);
  cup.rotation.x = -Math.PI / 2;
  cup.position.set(pinWorld.x, pinWorld.y + 0.001, pinWorld.z);
  group.add(cup);
  cupMeshes.push(cup);

  // Tee world position lifted so the ball starts on top of the contoured tee box
  const teeTerrainH = heightAt(holeData.tee.x, holeData.tee.z, holeData);
  const teeWorld = new THREE.Vector3(
    holeData.tee.x,
    Y.tee + teeTerrainH + 0.025,
    holeData.tee.z,
  );

  function dispose() {
    scene.remove(group);
    for (const m of ownedMeshes) {
      m.geometry?.dispose?.();
      // Materials may be shared (cached in materials.js) — only dispose locally-created fallback materials.
      // Safest: skip material disposal; Three.js handles GC on unreferenced unique materials.
    }
    physics.removeStaticBodies?.();
  }

  // Expose green-break sampler so physics (and the bead-reader visual) can call
  // it per step. Returns world XZ acceleration; physics gates application to
  // ball-on-green via the existing setGreenSlope/ballOnGreen path or the new
  // setGreenBreakField sampler the engine wires up.
  function greenBreakAtXZ(x, z) {
    return greenBreakAt(x, z, holeData);
  }
  function heightAtXZ(x, z) {
    return heightAt(x, z, holeData);
  }

  return {
    teeWorld,
    pinWorld,
    cupRadius: HOLE_CUP_RADIUS,
    group,
    hazards,
    greenBreakAt: greenBreakAtXZ,
    heightAt: heightAtXZ,
    dispose,
  };
}

const TAU = Math.PI * 2;

// ---- Custom disc + ring builders with subdivided radial rings ----
//
// Three's CircleGeometry has 1 center vert + N edge verts → only one ring of
// triangles, so heightAt() displacement is invisible. These builders emit
// `rings+1` concentric rings of verts so the disc/ring picks up the height field.

function buildDiscGeometry(radius, sides, rings) {
  const positions = [];
  const indices = [];
  // Center vertex
  positions.push(0, 0, 0);
  // Concentric rings: ring index 0 has very small radius (close to center),
  // ring index `rings` sits at `radius`. Each ring has `sides` verts.
  for (let r = 1; r <= rings; r++) {
    const rr = (r / rings) * radius;
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * TAU;
      positions.push(Math.cos(a) * rr, Math.sin(a) * rr, 0);
    }
  }
  // Triangles fan from center to ring 1
  for (let s = 0; s < sides; s++) {
    const a = 1 + s;
    const b = 1 + ((s + 1) % sides);
    indices.push(0, a, b);
  }
  // Stitched rings
  for (let r = 0; r < rings - 1; r++) {
    const base0 = 1 + r * sides;
    const base1 = 1 + (r + 1) * sides;
    for (let s = 0; s < sides; s++) {
      const a = base0 + s;
      const b = base0 + ((s + 1) % sides);
      const c = base1 + s;
      const d = base1 + ((s + 1) % sides);
      indices.push(a, c, b);
      indices.push(b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function buildRingGeometry(rInner, rOuter, sides, rings) {
  const positions = [];
  const indices = [];
  // (rings+1) concentric rings of verts from rInner to rOuter.
  for (let r = 0; r <= rings; r++) {
    const rr = rInner + (r / rings) * (rOuter - rInner);
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * TAU;
      positions.push(Math.cos(a) * rr, Math.sin(a) * rr, 0);
    }
  }
  for (let r = 0; r < rings; r++) {
    const base0 = r * sides;
    const base1 = (r + 1) * sides;
    for (let s = 0; s < sides; s++) {
      const a = base0 + s;
      const b = base0 + ((s + 1) % sides);
      const c = base1 + s;
      const d = base1 + ((s + 1) % sides);
      indices.push(a, c, b);
      indices.push(b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function mapSurface(type) {
  // Tag for cannon contact material lookup. Each surface has its own material so
  // the green checks, the sand plugs, the fairway runs out, and the rough deadens.
  switch (type) {
    case 'green':   return 'green';
    case 'sand':    return 'sand';
    case 'rough':   return 'rough';
    case 'fairway':
    case 'tee':
    default:        return 'fairway';
  }
}

// ---------- public lie detection ----------
// Returns the surface the ball is sitting on given (x, z) and a hole's region list.
// Priority order: green > water > sand > tee > fairway > rough (explicit fill or default).
// "Rough" wins as the fallback for any in-bounds-but-not-otherwise-tagged ground.
// Returns 'oob' if the point is far outside the hole's playing corridor.
export function lieAt(x, z, holeData) {
  if (!holeData) return 'fairway';

  const checkGreen   = (r) => r.type === 'green'   && shapeContains(r, x, z);
  const checkWater   = (r) => r.type === 'water'   && shapeContains(r, x, z);
  const checkSand    = (r) => r.type === 'sand'    && shapeContains(r, x, z);
  const checkTee     = (r) => r.type === 'tee'     && shapeContains(r, x, z);
  const checkFairway = (r) => r.type === 'fairway' && shapeContains(r, x, z);
  const checkRough   = (r) => r.type === 'rough'   && r.shape !== 'fill' && shapeContains(r, x, z);

  for (const r of holeData.regions || []) if (checkGreen(r))   return 'green';
  for (const r of holeData.regions || []) if (checkWater(r))   return 'water';
  for (const r of holeData.regions || []) if (checkSand(r))    return 'sand';
  for (const r of holeData.regions || []) if (checkTee(r))     return 'tee';
  for (const r of holeData.regions || []) if (checkFairway(r)) return 'fairway';
  for (const r of holeData.regions || []) if (checkRough(r))   return 'rough';

  // Implicit fill rough — anywhere reasonably near the hole corridor.
  if (holeData.regions?.some((r) => r.type === 'rough' && r.shape === 'fill')) {
    // OOB only if very far from any region center
    const corridorX = Math.max(
      Math.abs(x - (holeData.tee?.x ?? 0)),
      Math.abs(x - (holeData.pin?.x ?? 0)),
    );
    const corridorZ = Math.max(
      Math.abs(z - (holeData.tee?.z ?? 0)),
      Math.abs(z - (holeData.pin?.z ?? 0)),
    );
    if (corridorX > 120 || corridorZ > 80) return 'oob';
    return 'rough';
  }
  return 'fairway';
}

function shapeContains(r, x, z) {
  switch (r.shape) {
    case 'rect': {
      return Math.abs(x - r.x) <= (r.w ?? 0) / 2 &&
             Math.abs(z - r.z) <= (r.d ?? 0) / 2;
    }
    case 'circle': {
      const dx = x - r.x, dz = z - r.z;
      return dx * dx + dz * dz <= (r.r ?? 0) ** 2;
    }
    case 'ring': {
      const dx = x - r.x, dz = z - r.z;
      const d2 = dx * dx + dz * dz;
      return d2 <= (r.r2 ?? 0) ** 2 && d2 >= (r.r ?? 0) ** 2;
    }
    case 'spline': {
      // Distance to polyline with per-segment width
      const pts = r.points || [];
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const dx = b.x - a.x, dz = b.z - a.z;
        const len2 = dx * dx + dz * dz;
        if (len2 < 1e-6) continue;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2));
        const px = a.x + dx * t, pz = a.z + dz * t;
        const ex = x - px, ez = z - pz;
        const w = (a.w + (b.w - a.w) * t) / 2;
        if (ex * ex + ez * ez <= w * w) return true;
      }
      return false;
    }
    case 'fill':
      return false;
    default:
      return false;
  }
}
