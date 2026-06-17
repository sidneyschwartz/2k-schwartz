// Visual polish: procedural sky, IBL via PMREM (image-based PBR lighting +
// reflections sourced from the sky itself — no HDRI download needed),
// ACES tonemapping, bloom, SSAO, SMAA, shadow tuning, color grading.

import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

// Sun config used by both sky and directional light so they agree.
const SUN_ELEVATION_DEG = 28;   // mid-morning
const SUN_AZIMUTH_DEG = 135;
const SUN_DISTANCE = 450;

// ---- Color grading shader ----
// Tuned for a "PGA Tour broadcast" look: gentle shadow lift, slightly warm
// midtones, subtle saturation boost. Cheap to compute (one full-screen pass).
const ColorGradeShader = {
  uniforms: {
    tDiffuse:    { value: null },
    uShadowLift: { value: 0.005 },    // very subtle floor raise
    uMidWarm:    { value: 0.012 },    // very gentle warmth in midtones
    uSaturation: { value: 1.18 },     // bigger saturation pop — recovers the green after exposure cut
    uContrast:   { value: 1.06 },     // slightly stronger S-curve
    uVignette:   { value: 0.14 },     // soft edge darkening
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uShadowLift;
    uniform float uMidWarm;
    uniform float uSaturation;
    uniform float uContrast;
    uniform float uVignette;
    varying vec2 vUv;

    vec3 saturation(vec3 c, float s) {
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      return mix(vec3(l), c, s);
    }
    vec3 contrast(vec3 c, float k) {
      return (c - 0.5) * k + 0.5;
    }

    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = src.rgb;

      // Lift shadows so deep greens never crush to black.
      c = c + uShadowLift * (1.0 - c);

      // Warm midtones: subtle bias to R/G centered around 0.5 luminance.
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      float midMask = 1.0 - abs(l - 0.5) * 2.0;
      c.r += uMidWarm * midMask;
      c.g += uMidWarm * 0.5 * midMask;

      // Saturation + gentle contrast curve.
      c = saturation(c, uSaturation);
      c = contrast(c, uContrast);

      // Soft vignette.
      vec2 d = vUv - 0.5;
      float v = smoothstep(0.85, 0.30, dot(d, d) * 4.0); // 1 at center, 0 at corners
      c *= mix(1.0 - uVignette, 1.0, v);

      gl_FragColor = vec4(clamp(c, 0.0, 1.0), src.a);
    }
  `,
};

function sunVector() {
  const phi = THREE.MathUtils.degToRad(90 - SUN_ELEVATION_DEG);
  const theta = THREE.MathUtils.degToRad(SUN_AZIMUTH_DEG);
  const v = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
  return v;
}

function addSky(scene) {
  const sky = new Sky();
  sky.scale.setScalar(10000);
  scene.add(sky);

  const u = sky.material.uniforms;
  u.turbidity.value = 4.5;
  u.rayleigh.value = 1.8;
  u.mieCoefficient.value = 0.005;
  u.mieDirectionalG.value = 0.8;

  const sun = sunVector();
  u.sunPosition.value.copy(sun);

  // Cloud dome: a thin hemispherical shell above the play area with a
  // procedural multi-octave noise sampled in the FRAGMENT shader, so we get
  // soft, slow-drifting cumulus without billions of polys. Renders BEFORE the
  // scene so PMREM (which only grabs the Sky for IBL) is unaffected.
  const cloudGeo = new THREE.SphereGeometry(2400, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  const cloudMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    uniforms: {
      uTime: { value: 0 },
      uSunDir: { value: sun.clone() },
      uCloudColor: { value: new THREE.Color(0xffffff) },
      uSkyTint: { value: new THREE.Color(0x9ec6ea) },
      uCoverage: { value: 0.42 }, // 0 = clear blue, 1 = total overcast
      uSoftness: { value: 0.18 },
    },
    vertexShader: /* glsl */`
      varying vec3 vWorldDir;
      void main() {
        vWorldDir = normalize((modelMatrix * vec4(position, 1.0)).xyz);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      precision highp float;
      varying vec3 vWorldDir;
      uniform float uTime;
      uniform vec3 uSunDir;
      uniform vec3 uCloudColor;
      uniform vec3 uSkyTint;
      uniform float uCoverage;
      uniform float uSoftness;

      // value-noise basics
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float vnoise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
                   mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
      }
      float fbm(vec2 p) {
        float s = 0.0, a = 0.5;
        for (int k = 0; k < 5; k++) {
          s += a * vnoise(p);
          p *= 2.13;
          a *= 0.5;
        }
        return s;
      }

      void main() {
        // Discard everything below horizon — only render the upper hemisphere.
        if (vWorldDir.y < 0.02) discard;

        // Project the view direction onto a 2D plane far above; drift over time.
        vec2 uv = vWorldDir.xz / max(0.05, vWorldDir.y);
        uv = uv * 0.6 + vec2(uTime * 0.005, uTime * 0.003);

        float n = fbm(uv * 1.2);
        // Coverage threshold + softness — squashes noise into puffy clouds.
        float cloud = smoothstep(1.0 - uCoverage - uSoftness, 1.0 - uCoverage + uSoftness, n);

        // Fade clouds near the horizon so they don't poke through trees.
        float horizonFade = smoothstep(0.04, 0.18, vWorldDir.y);
        cloud *= horizonFade;

        // Cheap lighting — directional sun gives the cloud tops a warm rim.
        float sunCos = clamp(dot(vWorldDir, normalize(uSunDir)), 0.0, 1.0);
        vec3 lit = mix(uSkyTint, uCloudColor, 0.85);
        lit += vec3(0.10, 0.06, 0.0) * pow(sunCos, 8.0);

        gl_FragColor = vec4(lit, cloud * 0.85);
      }
    `,
  });
  const clouds = new THREE.Mesh(cloudGeo, cloudMat);
  clouds.position.y = 200;
  clouds.frustumCulled = false;
  clouds.renderOrder = -1; // draw before the rest of the scene
  scene.add(clouds);

  return { sky, sun, clouds };
}

function findOrAddSunLight(scene, sunDir) {
  // Reuse the engine's directional light if it already added one; otherwise add ours.
  let sunLight = null;
  scene.traverse((o) => {
    if (!sunLight && o.isDirectionalLight) sunLight = o;
  });
  if (!sunLight) {
    // Warmer key light — drifts the broadcast look toward the late-afternoon
    // "Augusta" feel rather than overcast mid-morning. Slightly higher intensity
    // to compensate for the deeper grass.
    sunLight = new THREE.DirectionalLight(0xffe1b0, 2.4);
    scene.add(sunLight);
  }
  // Always ensure a strong-enough ambient fill so foreground ground doesn't go pitch black.
  let hasHemi = false;
  scene.traverse((o) => { if (o.isHemisphereLight) hasHemi = true; });
  if (!hasHemi) {
    // Sky-up tint slightly cooler, ground-up slightly greener — gives the
    // figure proper rim-light separation from the green carpet.
    const ambient = new THREE.HemisphereLight(0xb9d0ee, 0x3f6a36, 1.05);
    scene.add(ambient);
  }
  sunLight.position.copy(sunDir).multiplyScalar(SUN_DISTANCE);
  sunLight.target.position.set(0, 0, 0);
  sunLight.target.updateMatrixWorld();

  sunLight.castShadow = true;
  // Bigger shadow map for crisper edges. quality.js can dial this down for Low.
  sunLight.shadow.mapSize.set(4096, 4096);
  const cam = sunLight.shadow.camera;
  // Tighter frustum focused around the player area gives much sharper shadows
  // than the previous ±160 spread. Engine should move the light target to the
  // ball if it wants long-range shadows on the par-5; we keep this for the
  // near-camera character + tee box where it matters most.
  cam.left = -80;
  cam.right = 80;
  cam.top = 80;
  cam.bottom = -80;
  cam.near = 1;
  cam.far = 800;
  cam.updateProjectionMatrix();
  sunLight.shadow.bias = -0.0002;
  sunLight.shadow.normalBias = 0.03;
  sunLight.shadow.radius = 2; // soft edges
  return sunLight;
}

export function applyVisuals(scene, renderer, camera = null) {
  // Renderer-side polish.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // Reduced from 1.05 to keep grass surfaces from blowing out under the
  // PMREM-sky IBL contribution. Combined with envMapIntensity ≈ 0.3 on the
  // surface materials this lands the fairway in the rich-green zone instead
  // of pale whitish-green.
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Crisper PBR with physically-correct light falloff.
  renderer.physicallyCorrectLights = true;

  // Sky + sun.
  const { sky, sun, clouds } = addSky(scene);
  const sunDir = sun.clone().normalize();
  const sunLight = findOrAddSunLight(scene, sunDir);

  // ---- IBL via PMREM: bake the procedural Sky into an env map so all PBR
  // materials pick up real reflection + ambient color from the sky. No HDRI
  // download needed; we self-source from the in-scene Sky shader.
  let pmremRT = null;
  try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    // Render the Sky into the PMREM in a temp mini-scene so we don't include
    // any not-yet-loaded scene props (which would still be undefined here).
    const skyScene = new THREE.Scene();
    const skyClone = sky.clone();
    // Shallow-clone the uniforms so we don't mutate the live sky.
    skyClone.material = sky.material;
    skyScene.add(skyClone);
    pmremRT = pmrem.fromScene(skyScene, 0.04);
    scene.environment = pmremRT.texture;
    pmrem.dispose();
  } catch (err) {
    console.warn('[visuals] PMREM IBL failed; PBR will use sun+ambient only', err);
  }

  // Mild fog for distance haze; matches sky horizon. Pushed WAY back so the
  // fairway stays crisp green out to the 500m+ par-5 green. Original 400-1400
  // had haze creeping over the mid-fairway and making it look washed-out.
  scene.fog = new THREE.Fog(0xbcd4e6, 700, 2000);
  if (!scene.background) scene.background = new THREE.Color(0x87b6e0);

  // Post-processing.
  let composer = null;
  let bloomPass = null;
  let smaaPass = null;
  let ssaoPass = null;
  let gradePass = null;
  const size = renderer.getSize(new THREE.Vector2());

  if (camera) {
    composer = new EffectComposer(renderer);
    composer.setSize(size.x, size.y);
    composer.addPass(new RenderPass(scene, camera));

    // SSAO — subtle ambient occlusion so the figure, sand, and rough geometry
    // ground into the terrain. Tuned mild so we don't get the dirty-fingerprint
    // look on the open fairway.
    try {
      ssaoPass = new SSAOPass(scene, camera, size.x, size.y);
      // Bumped kernel + a touch more contact AO. The figure + bunker rim now
      // ground into the terrain instead of floating; the wider kernel doesn't
      // turn the open fairway dirty because everything there is far apart.
      ssaoPass.kernelRadius = 0.9;
      ssaoPass.minDistance = 0.0015;
      ssaoPass.maxDistance = 0.06;
      ssaoPass.output = SSAOPass.OUTPUT.Default;
      composer.addPass(ssaoPass);
    } catch (err) { console.warn('[visuals] SSAO unavailable', err); }

    // Bloom kept very gentle so it doesn't wash out the horizon line.
    bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.12, 0.7, 0.92);
    composer.addPass(bloomPass);

    // Color grading (shadow lift + warm midtones + saturation + vignette).
    // Tuned to read as "PGA Tour broadcast" without obvious filtering.
    try {
      gradePass = new ShaderPass(ColorGradeShader);
      composer.addPass(gradePass);
    } catch (err) { console.warn('[visuals] color grade unavailable', err); }

    smaaPass = new SMAAPass(size.x * renderer.getPixelRatio(), size.y * renderer.getPixelRatio());
    composer.addPass(smaaPass);

    composer.addPass(new OutputPass());
  }

  function setSize(w, h) {
    renderer.setSize(w, h, false);
    if (composer) composer.setSize(w, h);
    if (bloomPass) bloomPass.setSize(w, h);
    if (smaaPass) smaaPass.setSize(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
    if (ssaoPass) ssaoPass.setSize(w, h);
  }

  // Move the shadow camera so its frustum stays centered on a target point
  // (typically the ball). Without this, long par-5 shots fall outside the
  // ±80m frustum and lose their shadows.
  //
  // We snap the target to a 16m grid so the shadow map isn't regenerated
  // every frame (each shadow re-render is a full scene pass for the depth
  // texture). 16m is small enough that the frustum still contains the player
  // + ball + nearby trees, but large enough to amortize the cost.
  const _sunTargetPos = new THREE.Vector3();
  function setSunTarget(x, z) {
    if (!sunLight) return;
    const snapX = Math.round(x / 16) * 16;
    const snapZ = Math.round(z / 16) * 16;
    if (_sunTargetPos.x === snapX && _sunTargetPos.z === snapZ) return;
    _sunTargetPos.set(snapX, 0, snapZ);
    sunLight.target.position.copy(_sunTargetPos);
    sunLight.target.updateMatrixWorld();
    sunLight.position.copy(sunDir).multiplyScalar(SUN_DISTANCE).add(_sunTargetPos);
  }

  function render() {
    if (composer) composer.render();
    else if (camera) renderer.render(scene, camera);
  }

  return {
    composer,
    bloomPass,
    smaaPass,
    ssaoPass,
    gradePass,
    sunLight,
    sunDirection: sunDir,
    envMap: pmremRT?.texture ?? null,
    clouds,
    // Engine should call tickSky(dt) every frame so clouds drift.
    tickSky(dt) {
      if (clouds?.material?.uniforms?.uTime) clouds.material.uniforms.uTime.value += dt;
    },
    render,
    setSize,
    setSunTarget,
  };
}
