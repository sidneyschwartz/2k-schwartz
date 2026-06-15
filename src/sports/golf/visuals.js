// Visual polish: procedural sky, IBL via PMREM (image-based PBR lighting +
// reflections sourced from the sky itself — no HDRI download needed),
// ACES tonemapping, bloom, SSAO, SMAA, shadow tuning.

import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

// Sun config used by both sky and directional light so they agree.
const SUN_ELEVATION_DEG = 28;   // mid-morning
const SUN_AZIMUTH_DEG = 135;
const SUN_DISTANCE = 450;

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
  return { sky, sun };
}

function findOrAddSunLight(scene, sunDir) {
  // Reuse the engine's directional light if it already added one; otherwise add ours.
  let sunLight = null;
  scene.traverse((o) => {
    if (!sunLight && o.isDirectionalLight) sunLight = o;
  });
  if (!sunLight) {
    sunLight = new THREE.DirectionalLight(0xfff2dd, 2.0);
    scene.add(sunLight);
  }
  // Always ensure a strong-enough ambient fill so foreground ground doesn't go pitch black.
  let hasHemi = false;
  scene.traverse((o) => { if (o.isHemisphereLight) hasHemi = true; });
  if (!hasHemi) {
    const ambient = new THREE.HemisphereLight(0xcfe2ff, 0x4a6a40, 1.2);
    scene.add(ambient);
  }
  sunLight.position.copy(sunDir).multiplyScalar(SUN_DISTANCE);
  sunLight.target.position.set(0, 0, 0);
  sunLight.target.updateMatrixWorld();

  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  const cam = sunLight.shadow.camera;
  // Frustum sized for a Phase 1 hole (~250m long, ~80m wide).
  cam.left = -160;
  cam.right = 160;
  cam.top = 160;
  cam.bottom = -160;
  cam.near = 1;
  cam.far = 1200;
  cam.updateProjectionMatrix();
  sunLight.shadow.bias = -0.0003;
  sunLight.shadow.normalBias = 0.04;
  return sunLight;
}

export function applyVisuals(scene, renderer, camera = null) {
  // Renderer-side polish.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Crisper PBR with physically-correct light falloff.
  renderer.physicallyCorrectLights = true;

  // Sky + sun.
  const { sky, sun } = addSky(scene);
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

  // Mild fog for distance haze; matches sky horizon. Pushed back so a 145m par-3
  // doesn't disappear into white.
  scene.fog = new THREE.Fog(0xbcd4e6, 400, 1400);
  if (!scene.background) scene.background = new THREE.Color(0x87b6e0);

  // Post-processing.
  let composer = null;
  let bloomPass = null;
  let smaaPass = null;
  let ssaoPass = null;
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
      ssaoPass.kernelRadius = 0.6;
      ssaoPass.minDistance = 0.001;
      ssaoPass.maxDistance = 0.04;
      ssaoPass.output = SSAOPass.OUTPUT.Default;
      composer.addPass(ssaoPass);
    } catch (err) { console.warn('[visuals] SSAO unavailable', err); }

    // Bloom kept very gentle so it doesn't wash out the horizon line.
    bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.12, 0.7, 0.92);
    composer.addPass(bloomPass);

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

  function render() {
    if (composer) composer.render();
    else if (camera) renderer.render(scene, camera);
  }

  return {
    composer,
    bloomPass,
    smaaPass,
    ssaoPass,
    sunLight,
    sunDirection: sunDir,
    envMap: pmremRT?.texture ?? null,
    render,
    setSize,
  };
}
