// Three.js scene + camera follow helper. The sky / lighting / post-FX are layered
// on top by visuals.js — this file only owns the renderer, scene root, camera, and
// the 3rd-person chase logic.
//
// followBall(ballMesh, targetMesh, dt, opts) smooths a chase camera behind the ball
// looking toward the pin. resetCameraFor(ballPos, lookAtPos) snaps the smoothed
// state so the camera doesn't jump after a flyover or hole change.

import * as THREE from 'three';

const AIM_CLAMP = Math.PI * 0.5; // ±90° max — prevents spinning behind the player

export function createScene(host) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  // Cap pixel ratio at 1.5 — going to 2x on a 4K laptop costs ~2x fragment work for
  // marginal visual gain. quality.js can dial this further per preset.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const canvas = renderer.domElement;
  canvas.classList.add('golf-canvas');
  host.appendChild(canvas);

  const scene = new THREE.Scene();
  // Background + fog + sun are owned by visuals.js; scene.js just provides safe defaults
  // so the scene isn't pure black if visuals.js fails to load.
  scene.background = new THREE.Color(0x87b6e0);

  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1500);
  camera.position.set(0, 4, -8);
  camera.lookAt(0, 0, 30);

  // Resize hook — visuals.js layers a composer on top and pushes its own setSize
  // into this list so EffectComposer / Bloom / SMAA all keep in sync.
  const resizeHooks = [];
  function onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    for (const cb of resizeHooks) {
      try { cb(w, h); } catch {}
    }
  }
  onResize();
  window.addEventListener('resize', onResize);

  // Camera follow state
  const camState = {
    yaw: 0,            // user-controlled spin around ball
    distance: 6.5,
    height: 2.4,
    look: new THREE.Vector3(),
    pos: new THREE.Vector3(),
    smoothed: new THREE.Vector3().copy(camera.position),
    smoothedLook: new THREE.Vector3(),
  };

  function followBall(ballMesh, targetMesh, dt = 1 / 60, opts = {}) {
    let aimYaw = opts.aimYaw ?? 0;
    // Hard clamp aim so RMB-drag can't spin the camera past the player.
    if (aimYaw > AIM_CLAMP) aimYaw = AIM_CLAMP;
    if (aimYaw < -AIM_CLAMP) aimYaw = -AIM_CLAMP;

    const inFlight = opts.inFlight ?? false;
    const target = targetMesh.position;
    const ball = ballMesh.position;

    // direction from ball -> pin (XZ)
    const dx = target.x - ball.x;
    const dz = target.z - ball.z;
    const baseYaw = Math.atan2(dx, dz);
    const yaw = baseYaw + aimYaw;

    let dist = camState.distance;
    let height = camState.height;
    if (inFlight) {
      dist = 9;
      height = 3.6;
    }

    camState.pos.set(
      ball.x - Math.sin(yaw) * dist,
      ball.y + height,
      ball.z - Math.cos(yaw) * dist,
    );
    camState.look.set(
      ball.x + Math.sin(yaw) * 4,
      ball.y + 0.4,
      ball.z + Math.cos(yaw) * 4,
    );

    const smooth = inFlight ? 4 : 8;
    const k = 1 - Math.exp(-smooth * dt);
    camState.smoothed.lerp(camState.pos, k);
    camState.smoothedLook.lerp(camState.look, k);
    camera.position.copy(camState.smoothed);
    camera.lookAt(camState.smoothedLook);
  }

  // Snap-init the chase camera state for a fresh hole or after a flyover so the
  // camera doesn't have to lerp from wherever it was on the previous hole. Pass
  // the upcoming ball position + the point you want the camera initially aimed at
  // (usually the pin). The next followBall() call will lerp from this clean base.
  function resetCameraFor(ballPos, lookAtPos) {
    const dx = lookAtPos.x - ballPos.x;
    const dz = lookAtPos.z - ballPos.z;
    const yaw = Math.atan2(dx, dz);
    const dist = camState.distance;
    const height = camState.height;
    camState.smoothed.set(
      ballPos.x - Math.sin(yaw) * dist,
      ballPos.y + height,
      ballPos.z - Math.cos(yaw) * dist,
    );
    camState.smoothedLook.set(
      ballPos.x + Math.sin(yaw) * 4,
      ballPos.y + 0.4,
      ballPos.z + Math.cos(yaw) * 4,
    );
    camera.position.copy(camState.smoothed);
    camera.lookAt(camState.smoothedLook);
  }

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
    followBall, resetCameraFor,
    addResizeHook, removeResizeHook,
    dispose, camState,
  };
}
