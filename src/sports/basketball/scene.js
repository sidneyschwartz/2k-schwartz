// Three.js renderer + scene root + camera for basketball. Mirrors the golf
// scene.js pattern (renderer config, resize hook list, dispose) but swaps the
// ball-chase logic for a 1v1 BROADCAST camera that frames the basket from
// behind the top of the key.
//
// M0: a fixed broadcast placement (frameCourt). The full two-subject director
// — keeping both the ball-handler AND the defender in frame — lands in M7
// (Roadmap risk #8); this file just exposes the hooks it will build on.

import * as THREE from 'three';
import { HOOP_CENTER, CHECK_SPOT, PALETTE } from './court-constants.js';

export function createScene(host) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const canvas = renderer.domElement;
  canvas.classList.add('basketball-canvas');
  host.appendChild(canvas);

  const scene = new THREE.Scene();
  // visuals.js (M7) will own sky/fog/IBL; provide a safe default so the scene
  // isn't pure black if that layer never loads.
  scene.background = new THREE.Color(PALETTE.sky);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 1500);

  const resizeHooks = [];
  function onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    for (const cb of resizeHooks) { try { cb(w, h); } catch {} }
  }
  onResize();
  window.addEventListener('resize', onResize);

  // Smoothed broadcast-camera state (lerped each frame toward its target).
  const camState = {
    pos: new THREE.Vector3(),
    look: new THREE.Vector3(),
    smoothed: new THREE.Vector3(),
    smoothedLook: new THREE.Vector3(),
  };

  // Place the broadcast camera behind the top of the key, looking at the rim.
  // focusXZ lets later milestones bias toward the ball-handler; defaults to the
  // check spot so M0 shows the whole court + hoop.
  function frameCourt(focusXZ = { x: CHECK_SPOT.x, z: CHECK_SPOT.z }, dt = null) {
    camState.pos.set(focusXZ.x * 0.4, 6.4, focusXZ.z + 7.0);
    camState.look.set(HOOP_CENTER.x, HOOP_CENTER.y - 0.6, HOOP_CENTER.z);
    if (dt == null) {
      camState.smoothed.copy(camState.pos);
      camState.smoothedLook.copy(camState.look);
    } else {
      const k = 1 - Math.exp(-6 * dt);
      camState.smoothed.lerp(camState.pos, k);
      camState.smoothedLook.lerp(camState.look, k);
    }
    camera.position.copy(camState.smoothed);
    camera.lookAt(camState.smoothedLook);
  }
  frameCourt(); // snap-init

  function addResizeHook(cb) { resizeHooks.push(cb); }
  function removeResizeHook(cb) {
    const i = resizeHooks.indexOf(cb);
    if (i >= 0) resizeHooks.splice(i, 1);
  }

  function dispose() {
    window.removeEventListener('resize', onResize);
    resizeHooks.length = 0;
    renderer.dispose();
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  }

  return {
    scene, camera, renderer,
    frameCourt,
    addResizeHook, removeResizeHook,
    dispose, camState,
  };
}
