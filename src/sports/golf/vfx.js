// Impact VFX: divot spray on swing impact, ball trail during flight, water splash.
// All effects are short-lived; callers should keep handles only when they need
// to update (ballTrail) or explicitly dispose. Otherwise effects clean themselves
// up after their lifetime.

import * as THREE from 'three';

const tmpV = new THREE.Vector3();
const upV = new THREE.Vector3(0, 1, 0);

// ---------- short-lived particle group helper ----------

function makeBurst(scene, opts) {
  const {
    count = 30,
    position = new THREE.Vector3(),
    color = 0x88aa44,
    lifetime = 0.6,
    size = 0.06,
    spread = 1.2,
    upBias = 1.5,
    gravity = 9.0,
    castShadow = false,
  } = opts;

  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const velocities = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = position.x;
    positions[i * 3 + 1] = position.y;
    positions[i * 3 + 2] = position.z;
    const dirX = (Math.random() - 0.5) * spread;
    const dirZ = (Math.random() - 0.5) * spread;
    const dirY = Math.random() * upBias + 0.2;
    const speed = 1.5 + Math.random() * 2.5;
    velocities[i * 3] = dirX * speed;
    velocities[i * 3 + 1] = dirY * speed;
    velocities[i * 3 + 2] = dirZ * speed;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const mat = new THREE.PointsMaterial({
    color,
    size,
    transparent: true,
    opacity: 1.0,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geo, mat);
  points.castShadow = castShadow;
  scene.add(points);

  let elapsed = 0;
  let raf = 0;
  let last = performance.now();

  function step(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    elapsed += dt;
    const arr = geo.attributes.position.array;
    for (let i = 0; i < count; i++) {
      arr[i * 3]     += velocities[i * 3] * dt;
      arr[i * 3 + 1] += velocities[i * 3 + 1] * dt;
      arr[i * 3 + 2] += velocities[i * 3 + 2] * dt;
      velocities[i * 3 + 1] -= gravity * dt;
    }
    geo.attributes.position.needsUpdate = true;
    mat.opacity = Math.max(0, 1 - elapsed / lifetime);
    if (elapsed < lifetime) {
      raf = requestAnimationFrame(step);
    } else {
      scene.remove(points);
      geo.dispose();
      mat.dispose();
    }
  }
  raf = requestAnimationFrame(step);
  return () => {
    cancelAnimationFrame(raf);
    scene.remove(points);
    geo.dispose();
    mat.dispose();
  };
}

// ---------- divot spray ----------

export function divotSpray(scene, position, normal = upV) {
  const pos = new THREE.Vector3().copy(position);
  pos.y = Math.max(pos.y, 0.02);
  // grass tint
  makeBurst(scene, {
    count: 28,
    position: pos,
    color: 0x6f9a3f,
    lifetime: 0.5,
    size: 0.08,
    spread: 2.0,
    upBias: 1.8,
    gravity: 12.0,
  });
  // dirt tint, smaller
  makeBurst(scene, {
    count: 18,
    position: pos,
    color: 0x5b4326,
    lifetime: 0.45,
    size: 0.06,
    spread: 1.4,
    upBias: 1.0,
    gravity: 14.0,
  });
}

// ---------- ball trail ----------

// Maintains a fading polyline trail behind the ball. Caller drives via
// trail.update(dt). Disposes geometry on dispose().
export function ballTrail(scene, ballMesh, { maxPoints = 80, color = 0xffffff, width = 2 } = {}) {
  const positions = new Float32Array(maxPoints * 3);
  const alphas = new Float32Array(maxPoints);
  for (let i = 0; i < maxPoints; i++) {
    positions[i * 3] = ballMesh.position.x;
    positions[i * 3 + 1] = ballMesh.position.y;
    positions[i * 3 + 2] = ballMesh.position.z;
    alphas[i] = 0;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));

  // Simple gradient via custom shader so the line fades from head -> tail.
  const mat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) } },
    vertexShader: `
      attribute float alpha;
      varying float vAlpha;
      void main() {
        vAlpha = alpha;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      varying float vAlpha;
      void main() {
        if (vAlpha < 0.01) discard;
        gl_FragColor = vec4(uColor, vAlpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    linewidth: width, // most platforms ignore — kept for symmetry
  });

  const line = new THREE.Line(geo, mat);
  line.frustumCulled = false;
  scene.add(line);

  let head = 0;        // index of the newest point
  let filled = 0;
  let active = false;
  let sampleAccum = 0;
  const SAMPLE_INTERVAL = 0.02; // seconds per sample

  function pushPoint(x, y, z) {
    positions[head * 3] = x;
    positions[head * 3 + 1] = y;
    positions[head * 3 + 2] = z;
    alphas[head] = 1.0;
    head = (head + 1) % maxPoints;
    if (filled < maxPoints) filled++;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.alpha.needsUpdate = true;
  }

  function update(dt, opts = {}) {
    // Decay all alphas
    const decay = (opts.decay ?? 1.2) * dt;
    for (let i = 0; i < maxPoints; i++) {
      alphas[i] = Math.max(0, alphas[i] - decay);
    }
    geo.attributes.alpha.needsUpdate = true;

    if (!active) return;
    sampleAccum += dt;
    if (sampleAccum >= SAMPLE_INTERVAL) {
      sampleAccum = 0;
      pushPoint(ballMesh.position.x, ballMesh.position.y, ballMesh.position.z);
    }
  }

  function start() {
    active = true;
    // reset alphas
    for (let i = 0; i < maxPoints; i++) alphas[i] = 0;
    head = 0;
    filled = 0;
    pushPoint(ballMesh.position.x, ballMesh.position.y, ballMesh.position.z);
  }

  function stop() {
    active = false;
  }

  function dispose() {
    scene.remove(line);
    geo.dispose();
    mat.dispose();
  }

  return { update, start, stop, dispose };
}

// ---------- water splash ----------

export function splashEffect(scene, position) {
  const pos = new THREE.Vector3().copy(position);
  // Particle plume
  makeBurst(scene, {
    count: 40,
    position: pos,
    color: 0xaaccff,
    lifetime: 0.8,
    size: 0.10,
    spread: 1.6,
    upBias: 2.2,
    gravity: 10.0,
  });

  // Expanding ring
  const ringGeo = new THREE.RingGeometry(0.3, 0.45, 32);
  ringGeo.rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({
    color: 0xcfe6ff,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.position.copy(pos);
  ring.position.y = Math.max(pos.y, 0.02);
  scene.add(ring);

  const lifetime = 0.9;
  let elapsed = 0;
  let last = performance.now();
  let raf = 0;
  function step(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    elapsed += dt;
    const t = elapsed / lifetime;
    const scale = 1 + t * 8;
    ring.scale.set(scale, 1, scale);
    ringMat.opacity = Math.max(0, 0.9 - t);
    if (elapsed < lifetime) {
      raf = requestAnimationFrame(step);
    } else {
      scene.remove(ring);
      ringGeo.dispose();
      ringMat.dispose();
    }
  }
  raf = requestAnimationFrame(step);
}
