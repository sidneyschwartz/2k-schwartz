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

const Y = {
  rough: 0.000,
  fairway: 0.010,
  sand: 0.015,
  tee: 0.020,
  green: 0.025,
  water: 0.005,
};

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
  const baseGeo = new THREE.PlaneGeometry(baseSize, baseSize, 1, 1);
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
    const geo = new THREE.PlaneGeometry(region.w, region.d, 1, 1);
    const mat = makeMaterial(surfaceType, region);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    if (region.rotY) mesh.rotation.z = region.rotY;
    mesh.position.set(region.x, Y[surfaceType] ?? 0, region.z);
    return mesh;
  }

  function circleMesh(region, surfaceType, segments = 48) {
    const r = region.r;
    const geo = new THREE.CircleGeometry(r, segments);
    const mat = makeMaterial(surfaceType, region);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    const y = (Y[surfaceType] ?? 0) + (region.elevation ?? 0);
    mesh.position.set(region.x, y, region.z);
    return mesh;
  }

  function ringMesh(region, surfaceType, segments = 48) {
    const geo = new THREE.RingGeometry(region.r, region.r2, segments);
    const mat = makeMaterial(surfaceType, region);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(region.x, Y[surfaceType] ?? 0, region.z);
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
  const pinWorld = new THREE.Vector3(holeData.pin.x, 0, holeData.pin.z);
  // Find green elevation if any (so pin sits on top of the elevated green)
  const greenRegion = holeData.regions.find((r) => r.type === 'green');
  const greenElev = greenRegion?.elevation ?? 0;
  pinWorld.y = greenElev;

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
  cup.position.set(pinWorld.x, pinWorld.y + (Y.green) + 0.001, pinWorld.z);
  group.add(cup);
  cupMeshes.push(cup);

  // Tee world position lifted so the ball starts on top of the tee box
  const teeWorld = new THREE.Vector3(
    holeData.tee.x,
    Y.tee + 0.025,
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

  return {
    teeWorld,
    pinWorld,
    cupRadius: HOLE_CUP_RADIUS,
    group,
    hazards,
    dispose,
  };
}

function mapSurface(type) {
  // Tag for cannon contact material lookup. tee/fairway/green roll fast (fairway);
  // rough and sand resist (rough).
  switch (type) {
    case 'fairway':
    case 'green':
    case 'tee':
      return 'fairway';
    case 'rough':
    case 'sand':
      return 'rough';
    default:
      return 'fairway';
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
