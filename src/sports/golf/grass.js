// Instanced grass-blade carpet. A single InstancedMesh of N triangular blades
// renders thousands of grass tufts in ~one draw call. Each blade is offset by
// the instance matrix and animated in the vertex shader (wind via sin/cos noise).
//
// Public API:
//   createGrassPatch({ count, radius, baseColor, tipColor, density }) -> patch
//     patch.mesh           — THREE.InstancedMesh to add to the scene
//     patch.setCenter(v3)  — move the patch to follow the ball/camera target
//     patch.setDensity(d)  — scale visible blade count 0..1
//     patch.tick(dt)       — advance wind animation clock
//     patch.dispose()      — free geometry + material
//
// Performance: at ~6000 blades, 1 draw call, ~12k tris. Vertex shader does the
// wind bend; fragment is cheap (gradient + simple lighting term). Frustum-cull
// the whole patch via its bounding sphere — we update sphere as it moves.

import * as THREE from 'three';

const VERT = /* glsl */ `
  uniform float uTime;
  uniform float uWind;
  uniform vec3  uSunDir;
  varying vec3  vNormalW;
  varying float vHeight;
  varying vec2  vWorldXZ;

  // Per-instance attributes (added below):
  //   instanceMatrix is provided by InstancedMesh
  //   aPhase  — float, randomized per blade so wind isn't synchronized
  //   aColor  — vec3, slight green tint variation
  //   aHeight — float, blade height multiplier (0.6 .. 1.4)
  attribute float aPhase;
  attribute vec3  aColor;
  attribute float aHeight;
  varying   vec3  vTint;

  void main() {
    vec3 p = position;
    // Scale blade height per-instance
    p.y *= aHeight;
    vHeight = position.y;

    // Wind bend: only affects top of the blade (y > 0). Bend in xz from a
    // pseudo-noise tied to time + instance phase.
    float bend = (position.y / 0.20);                // 0..1 along blade
    bend = bend * bend;                              // quadratic so root stays put
    float w = uWind * 0.18;
    float ph = aPhase + uTime * 1.4;
    float bx = sin(ph) * w;
    float bz = cos(ph * 0.7) * w * 0.5;
    p.x += bx * bend;
    p.z += bz * bend;
    p.y -= (bx*bx + bz*bz) * 0.5 * bend; // slight droop when bent

    // World-space transform via the instance matrix.
    vec4 worldPos = instanceMatrix * vec4(p, 1.0);
    worldPos = modelMatrix * worldPos;
    vWorldXZ = worldPos.xz;
    vTint = aColor;

    // Approximate normal: bent blade leans slightly toward wind.
    vec3 n = normalize(vec3(-bx * 0.6, 1.0, -bz * 0.6));
    vNormalW = normalize((modelMatrix * vec4(n, 0.0)).xyz);

    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  uniform vec3 uBaseColor;
  uniform vec3 uTipColor;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uAmbient;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform vec3  uFogColor;
  uniform vec3  uCamPos;

  varying vec3  vNormalW;
  varying float vHeight;
  varying vec2  vWorldXZ;
  varying vec3  vTint;

  void main() {
    // Vertical gradient from base (darker green) to tip (lighter, sun-bleached).
    float t = clamp(vHeight / 0.22, 0.0, 1.0);
    vec3 col = mix(uBaseColor, uTipColor, t);
    col *= vTint;

    // Simple lambert + ambient
    float ndl = max(dot(normalize(vNormalW), normalize(uSunDir)), 0.0);
    vec3 lit = col * (uAmbient + uSunColor * ndl);

    // AO-ish darkening at the root
    lit *= mix(0.55, 1.0, t);

    // Distance fog
    float d = distance(uCamPos.xz, vWorldXZ);
    float fog = clamp((d - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
    lit = mix(lit, uFogColor, fog);

    gl_FragColor = vec4(lit, 1.0);
  }
`;

// A grass blade is a thin triangle (3 verts): root-left, root-right, tip.
// Stack two so the back side is visible too (so we render front+back without
// having to disable culling for the whole material).
function makeBladeGeometry({ width = 0.012, height = 0.22 } = {}) {
  const geo = new THREE.BufferGeometry();
  // 2 quads (4 tris) forming a tall thin blade with a slight curve.
  // We use 5 verts: 0,1 root corners; 2,3 mid corners; 4 tip.
  const positions = new Float32Array([
    -width, 0,      0,    // 0 root left
     width, 0,      0,    // 1 root right
    -width * 0.6, height * 0.55, 0,   // 2 mid left
     width * 0.6, height * 0.55, 0,   // 3 mid right
     0,       height,         0,      // 4 tip
  ]);
  const indices = [
    0, 1, 2,
    2, 1, 3,
    2, 3, 4,
  ];
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

export function createGrassPatch({
  count = 6000,
  radius = 18,         // half-extent of the carpet (m)
  baseColor = new THREE.Color(0x2f5a23),
  tipColor  = new THREE.Color(0x9bc56a),
  sunDir    = new THREE.Vector3(1, 1, 1).normalize(),
  sunColor  = new THREE.Color(0xfff2dd),
  ambient   = new THREE.Color(0x4a6a40),
  fogNear   = 30,
  fogFar    = 110,
  fogColor  = new THREE.Color(0xbcd4e6),
  bladeHeight = 0.22,
} = {}) {
  const geo = makeBladeGeometry({ width: 0.012, height: bladeHeight });

  // Per-instance attributes
  const phases  = new Float32Array(count);
  const colors  = new Float32Array(count * 3);
  const heights = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    phases[i] = Math.random() * Math.PI * 2;
    // Per-blade tint variation
    const v = 0.85 + Math.random() * 0.30;
    colors[i * 3]     = v;
    colors[i * 3 + 1] = 0.85 + Math.random() * 0.35;
    colors[i * 3 + 2] = v * (0.8 + Math.random() * 0.4);
    heights[i] = 0.65 + Math.random() * 0.85;
  }
  geo.setAttribute('aPhase',  new THREE.InstancedBufferAttribute(phases, 1));
  geo.setAttribute('aColor',  new THREE.InstancedBufferAttribute(colors, 3));
  geo.setAttribute('aHeight', new THREE.InstancedBufferAttribute(heights, 1));

  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.DoubleSide,
    transparent: false,
    uniforms: {
      uTime:     { value: 0 },
      uWind:     { value: 0.7 },
      uSunDir:   { value: sunDir.clone() },
      uSunColor: { value: sunColor.clone() },
      uAmbient:  { value: ambient.clone() },
      uBaseColor:{ value: baseColor.clone() },
      uTipColor: { value: tipColor.clone() },
      uFogNear:  { value: fogNear },
      uFogFar:   { value: fogFar },
      uFogColor: { value: fogColor.clone() },
      uCamPos:   { value: new THREE.Vector3() },
    },
  });

  const mesh = new THREE.InstancedMesh(geo, material, count);
  mesh.frustumCulled = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.name = 'grass-patch';

  // Scatter inside a disc of `radius`. Bias toward the center with sqrt for
  // uniform area distribution; rotation random around Y so blades face any way.
  const dummy = new THREE.Object3D();
  let activeCount = count;
  function rebuild(density = 1) {
    activeCount = Math.max(0, Math.min(count, Math.floor(count * density)));
    for (let i = 0; i < count; i++) {
      const r = radius * Math.sqrt(Math.random());
      const a = Math.random() * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      dummy.position.set(x, 0, z);
      dummy.rotation.set(0, Math.random() * Math.PI * 2, 0);
      const s = 0.85 + Math.random() * 0.4;
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.count = activeCount;
    mesh.instanceMatrix.needsUpdate = true;
  }
  rebuild(1);

  // Track where the patch is centered so we can re-center near the ball/camera.
  const center = new THREE.Vector3();
  function setCenter(v3) {
    center.copy(v3);
    mesh.position.set(v3.x, v3.y || 0, v3.z);
  }

  let clock = 0;
  function tick(dt, opts = {}) {
    clock += dt;
    material.uniforms.uTime.value = clock;
    if (opts.cameraPos) material.uniforms.uCamPos.value.copy(opts.cameraPos);
    if (opts.sunDir)    material.uniforms.uSunDir.value.copy(opts.sunDir);
    if (typeof opts.wind === 'number') material.uniforms.uWind.value = opts.wind;
  }

  function setDensity(d) {
    const newActive = Math.max(0, Math.min(count, Math.floor(count * d)));
    if (newActive === activeCount) return;
    activeCount = newActive;
    mesh.count = activeCount;
  }

  function setColors({ base, tip } = {}) {
    if (base) material.uniforms.uBaseColor.value.copy(base);
    if (tip)  material.uniforms.uTipColor.value.copy(tip);
  }

  function setFog({ near, far, color } = {}) {
    if (typeof near === 'number') material.uniforms.uFogNear.value = near;
    if (typeof far === 'number')  material.uniforms.uFogFar.value  = far;
    if (color) material.uniforms.uFogColor.value.copy(color);
  }

  function dispose() {
    geo.dispose();
    material.dispose();
  }

  return {
    mesh,
    setCenter,
    setDensity,
    setColors,
    setFog,
    tick,
    dispose,
    get count() { return activeCount; },
  };
}

// Convenience: build a green-keeper variant (brighter, shorter blades) for
// the putting green vs the long-rough variant.
export function createGreenPatch(opts = {}) {
  return createGrassPatch({
    count: 4000,
    radius: 12,
    bladeHeight: 0.08,
    baseColor: new THREE.Color(0x4f8a3a),
    tipColor:  new THREE.Color(0xc5e08e),
    ...opts,
  });
}

export function createRoughPatch(opts = {}) {
  return createGrassPatch({
    count: 5500,
    radius: 22,
    bladeHeight: 0.34,
    baseColor: new THREE.Color(0x223e16),
    tipColor:  new THREE.Color(0x6e9244),
    ...opts,
  });
}
