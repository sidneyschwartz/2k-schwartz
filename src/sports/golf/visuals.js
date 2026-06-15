// Visual polish: procedural sky, ACES tonemapping, bloom, SMAA, shadow tuning.
// Returns a composer the engine can render through. Falls back gracefully if
// post-processing imports fail (shouldn't with vite + three, but defensive).

import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
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
    sunLight = new THREE.DirectionalLight(0xfff2dd, 2.6);
    scene.add(sunLight);
    const ambient = new THREE.HemisphereLight(0xbfd8ff, 0x3a5530, 0.6);
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
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // Sky + sun.
  const { sun } = addSky(scene);
  const sunDir = sun.clone().normalize();
  const sunLight = findOrAddSunLight(scene, sunDir);

  // Mild fog for distance haze; matches sky horizon.
  scene.fog = new THREE.Fog(0xbcd4e6, 250, 900);
  if (!scene.background) scene.background = new THREE.Color(0x87b6e0);

  // Post-processing.
  let composer = null;
  let bloomPass = null;
  let smaaPass = null;
  const size = renderer.getSize(new THREE.Vector2());

  if (camera) {
    composer = new EffectComposer(renderer);
    composer.setSize(size.x, size.y);
    composer.addPass(new RenderPass(scene, camera));

    bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.3, 0.6, 0.85);
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
  }

  function render() {
    if (composer) composer.render();
    else if (camera) renderer.render(scene, camera);
  }

  return {
    composer,
    bloomPass,
    smaaPass,
    sunLight,
    sunDirection: sunDir,
    render,
    setSize,
  };
}
