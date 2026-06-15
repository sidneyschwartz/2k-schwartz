// Three.js scene + camera follow helper. No HDRI; sky-gradient via fog + clear color.
// followBall(ballMesh, targetMesh) smooths a 3rd-person chase camera behind the ball
// looking toward the pin.

import * as THREE from 'three';

export function createScene(host) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.BasicShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const canvas = renderer.domElement;
  canvas.classList.add('golf-canvas');
  host.appendChild(canvas);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9ad0ff);
  scene.fog = new THREE.Fog(0x9ad0ff, 220, 520);

  const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1500);
  camera.position.set(0, 4, -8);
  camera.lookAt(0, 0, 30);

  // Sun
  const sun = new THREE.DirectionalLight(0xfff2d6, 1.05);
  sun.position.set(60, 120, 40);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 400;
  const s = 80;
  sun.shadow.camera.left = -s;
  sun.shadow.camera.right = s;
  sun.shadow.camera.top = s;
  sun.shadow.camera.bottom = -s;
  scene.add(sun);

  const ambient = new THREE.HemisphereLight(0xbcdcff, 0x2d4d2d, 0.55);
  scene.add(ambient);

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener('resize', resize);

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
    const aimYaw = opts.aimYaw ?? 0;
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

  function dispose() {
    window.removeEventListener('resize', resize);
    renderer.dispose();
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  }

  return { scene, camera, renderer, sun, followBall, dispose };
}
