// Single-player golf — one par-3 hole. Assembles scene + physics + swing controller + HUD.
//
// Cross-agent interface (see also the team-lead coordination notes):
//   - exports `mountGolf(host, onExit) -> unmount`
//   - imports `mountHud(host, getters) -> unmount` from ./hud.js. If hud.js fails to load
//     (UI agent hasn't finished), we fall back to a tiny text HUD so this file still works
//     standalone.
//   - exposes `createSwingController` (swing.js) and `clubs` (clubs.js) for the HUD.

import * as THREE from 'three';
import { createScene } from './scene.js';
import { createPhysics } from './physics.js';
import { createSwingController } from './swing.js';
import { clubs } from './clubs.js';

const HOLE_LENGTH = 150;          // m from tee to pin (par 3)
const HOLE_RADIUS = 0.108;        // real golf hole radius (m)
const PIN_POS = new THREE.Vector3(0, 0, HOLE_LENGTH);
const TEE_POS = new THREE.Vector3(0, 0, 0);

export function mountGolf(host, onExit) {
  host.innerHTML = '';
  host.style.position = 'relative';

  // ---- Scene ----
  const { scene, camera, renderer, followBall, dispose: disposeScene } = createScene(host);

  // Ground (fairway)
  const fairwayGeo = new THREE.PlaneGeometry(120, 260, 1, 1);
  const fairwayMat = new THREE.MeshStandardMaterial({ color: 0x4ea24a, roughness: 0.95 });
  const fairway = new THREE.Mesh(fairwayGeo, fairwayMat);
  fairway.rotation.x = -Math.PI / 2;
  fairway.position.z = HOLE_LENGTH / 2;
  fairway.receiveShadow = true;
  scene.add(fairway);

  // Surrounding rough (a larger darker plane, behind fairway)
  const roughGeo = new THREE.PlaneGeometry(600, 600);
  const roughMat = new THREE.MeshStandardMaterial({ color: 0x2c6a30, roughness: 1.0 });
  const rough = new THREE.Mesh(roughGeo, roughMat);
  rough.rotation.x = -Math.PI / 2;
  rough.position.y = -0.01;
  rough.receiveShadow = true;
  scene.add(rough);

  // Tee box
  const teeBoxGeo = new THREE.BoxGeometry(4, 0.02, 3);
  const teeBoxMat = new THREE.MeshStandardMaterial({ color: 0x6fbf6c });
  const teeBox = new THREE.Mesh(teeBoxGeo, teeBoxMat);
  teeBox.position.set(0, 0.011, 0);
  teeBox.receiveShadow = true;
  scene.add(teeBox);

  // Green
  const greenGeo = new THREE.CircleGeometry(10, 36);
  const greenMat = new THREE.MeshStandardMaterial({ color: 0x7ed070, roughness: 0.9 });
  const green = new THREE.Mesh(greenGeo, greenMat);
  green.rotation.x = -Math.PI / 2;
  green.position.set(PIN_POS.x, 0.012, PIN_POS.z);
  green.receiveShadow = true;
  scene.add(green);

  // Hole (dark circle on green)
  const holeGeo = new THREE.CircleGeometry(HOLE_RADIUS, 24);
  const holeMat = new THREE.MeshBasicMaterial({ color: 0x080808 });
  const hole = new THREE.Mesh(holeGeo, holeMat);
  hole.rotation.x = -Math.PI / 2;
  hole.position.set(PIN_POS.x, 0.014, PIN_POS.z);
  scene.add(hole);

  // Pin: cylinder + flag triangle
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
  const flag = new THREE.Mesh(flagShape, flagMat);
  pinGroup.add(flag);
  pinGroup.position.copy(PIN_POS);
  scene.add(pinGroup);

  // Aim arrow (visual line from ball toward pin direction adjusted by aim)
  const aimGeo = new THREE.BufferGeometry();
  aimGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
  const aimLine = new THREE.Line(
    aimGeo,
    new THREE.LineBasicMaterial({ color: 0xffeb3b }),
  );
  scene.add(aimLine);

  // ---- Physics ----
  const physics = createPhysics();
  // Ball mesh synced from physics
  const ballMesh = new THREE.Mesh(
    new THREE.SphereGeometry(physics.BALL_RADIUS, 24, 16),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 }),
  );
  ballMesh.castShadow = true;
  scene.add(ballMesh);

  // Pin sensor target (used for camera follow)
  const pinTarget = new THREE.Object3D();
  pinTarget.position.copy(PIN_POS);
  scene.add(pinTarget);

  function placeBallOnTee() {
    physics.ball.velocity.set(0, 0, 0);
    physics.ball.angularVelocity.set(0, 0, 0);
    physics.ball.position.set(TEE_POS.x, physics.BALL_RADIUS + 0.025, TEE_POS.z);
    physics.ball.quaternion.set(0, 0, 0, 1);
    physics.ball.wakeUp();
  }
  placeBallOnTee();

  // ---- Game state ----
  const game = {
    strokes: 0,
    complete: false,
    inFlight: false,
    wind: { speed: 0, dirDeg: 0 }, // wind not applied yet — placeholder so HUD compiles
    flightStart: 0,
    settleTimer: 0,
  };

  // ---- Swing controller ----
  const swing = createSwingController({
    onSwingStart: () => { /* could play SFX */ },
    onShot: (shot) => launchShot(shot),
  });
  swing.attach(window);

  function launchShot({ club, power, accuracyError, aimYaw, stance }) {
    if (game.complete) return;
    game.strokes += 1;
    game.inFlight = true;
    game.flightStart = performance.now();

    // Compute launch velocity in world space.
    // Direction toward pin from ball, rotated by aimYaw + small stance bias.
    const ball = physics.ball.position;
    const toPinX = PIN_POS.x - ball.x;
    const toPinZ = PIN_POS.z - ball.z;
    const baseYaw = Math.atan2(toPinX, toPinZ);
    const yaw = baseYaw + aimYaw + (stance?.x ?? 0) * 0.05;

    const speed = club.maxPower * Math.max(0.05, power);
    const loft = club.loft;
    // ground-plane direction
    const dirX = Math.sin(yaw);
    const dirZ = Math.cos(yaw);
    // initial velocity
    const horiz = speed * Math.cos(loft);
    const vy = speed * Math.sin(loft);
    physics.ball.wakeUp();
    physics.ball.velocity.set(dirX * horiz, vy, dirZ * horiz);

    // Spin: backspin around an axis perpendicular to flight direction (in XZ plane,
    // pointing "left" of travel). Sidespin is accuracy error * sidespinScale around Y.
    const sideAxisX = -dirZ;
    const sideAxisZ = dirX;
    const backspin = club.backspin;
    const sidespin = accuracyError * club.sidespinScale * 400; // rad/s, generous
    physics.ball.angularVelocity.set(
      sideAxisX * backspin,
      sidespin,
      sideAxisZ * backspin,
    );

    swing.reset();
  }

  // ---- HUD ----
  let unmountHud = null;
  const hudHost = document.createElement('div');
  hudHost.style.position = 'fixed';
  hudHost.style.inset = '0';
  hudHost.style.pointerEvents = 'none';
  hudHost.style.zIndex = '10';
  host.appendChild(hudHost);

  const getters = {
    getMeter: () => swing.getMeter(),
    getClub: () => swing.club,
    getClubList: () => clubs,
    getWind: () => game.wind,
    getStrokes: () => game.strokes,
    getHole: () => 1,
    getPar: () => 3,
    getHoleInfo: () => ({ par: 3, number: 1, length: HOLE_LENGTH }),
    getClubs: () => clubs,                  // legacy alias for fallback HUD
    getScorecard: () => null,
    setClub: (name) => swing.setClub(name),
    onSelectClub: (name) => swing.setClub(name),
  };

  (async () => {
    try {
      const mod = await import('./hud.js');
      if (mod?.mountHud) {
        unmountHud = mod.mountHud(hudHost, getters);
        return;
      }
    } catch (err) {
      // fall through to fallback
      console.warn('[golf] hud.js not available, using fallback HUD:', err?.message);
    }
    unmountHud = mountFallbackHud(hudHost, getters);
  })();

  // ---- Back / reset UI ----
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed; top: 12px; left: 12px; z-index: 20;
    display: flex; gap: 8px; pointer-events: auto;
  `;
  const backBtn = document.createElement('button');
  backBtn.textContent = '← back';
  backBtn.className = 'back';
  backBtn.style.cssText = 'background:#0008;color:#fff;border:1px solid #fff3;border-radius:8px;padding:6px 12px;cursor:pointer;';
  backBtn.addEventListener('click', () => onExit?.());
  overlay.appendChild(backBtn);

  const resetBtn = document.createElement('button');
  resetBtn.textContent = 'Reset Hole';
  resetBtn.className = 'btn';
  resetBtn.style.cssText = 'background:#6cf;color:#001;border:0;border-radius:8px;padding:6px 12px;cursor:pointer;display:none;';
  resetBtn.addEventListener('click', resetHole);
  overlay.appendChild(resetBtn);
  host.appendChild(overlay);

  const completeBanner = document.createElement('div');
  completeBanner.style.cssText = `
    position: fixed; top: 30%; left: 50%; transform: translate(-50%, -50%);
    background: #0009; color: #fff; padding: 20px 32px; border-radius: 12px;
    font-size: 1.5rem; z-index: 25; display: none; text-align: center;
    border: 1px solid #fff3;
  `;
  host.appendChild(completeBanner);

  function resetHole() {
    game.strokes = 0;
    game.complete = false;
    game.inFlight = false;
    placeBallOnTee();
    swing.reset();
    completeBanner.style.display = 'none';
    resetBtn.style.display = 'none';
  }

  // ---- Game loop ----
  let last = performance.now();
  let rafId = 0;
  let stopped = false;

  function tick(now) {
    if (stopped) return;
    rafId = requestAnimationFrame(tick);
    const dtMs = now - last;
    last = now;
    const dt = Math.min(0.05, dtMs / 1000);

    swing.update(dt);
    physics.step(dt);

    // Sync ball mesh
    const bp = physics.ball.position;
    ballMesh.position.set(bp.x, bp.y, bp.z);
    const bq = physics.ball.quaternion;
    ballMesh.quaternion.set(bq.x, bq.y, bq.z, bq.w);

    // Aim line — only while idle
    if (swing.state.phase === 'idle' && !game.inFlight && !game.complete) {
      const toPinX = PIN_POS.x - bp.x;
      const toPinZ = PIN_POS.z - bp.z;
      const baseYaw = Math.atan2(toPinX, toPinZ);
      const yaw = baseYaw + swing.state.aimYaw;
      const len = 8;
      const arr = aimLine.geometry.attributes.position.array;
      arr[0] = bp.x; arr[1] = bp.y + 0.05; arr[2] = bp.z;
      arr[3] = bp.x + Math.sin(yaw) * len;
      arr[4] = bp.y + 0.05;
      arr[5] = bp.z + Math.cos(yaw) * len;
      aimLine.geometry.attributes.position.needsUpdate = true;
      aimLine.visible = true;
    } else {
      aimLine.visible = false;
    }

    // Settle / in-flight detection
    if (game.inFlight) {
      const speed = physics.ball.velocity.length();
      if (speed < 0.15 && bp.y < physics.BALL_RADIUS * 2.5) {
        game.settleTimer += dt;
        if (game.settleTimer > 0.6) {
          game.inFlight = false;
          game.settleTimer = 0;
        }
      } else {
        game.settleTimer = 0;
      }
    }

    // Hole detection (XZ distance to pin + ball near ground)
    if (!game.complete) {
      const dx = bp.x - PIN_POS.x;
      const dz = bp.z - PIN_POS.z;
      const distXZ = Math.sqrt(dx * dx + dz * dz);
      if (distXZ < HOLE_RADIUS * 1.3 && bp.y < physics.BALL_RADIUS * 2) {
        game.complete = true;
        game.inFlight = false;
        completeBanner.textContent = `Hole complete in ${game.strokes} stroke${game.strokes === 1 ? '' : 's'}`;
        completeBanner.style.display = 'block';
        resetBtn.style.display = 'inline-block';
      }
    }

    followBall(ballMesh, pinTarget, dt, {
      aimYaw: swing.state.aimYaw,
      inFlight: game.inFlight,
    });

    renderer.render(scene, camera);
  }
  rafId = requestAnimationFrame(tick);

  // ---- Unmount ----
  return function unmount() {
    stopped = true;
    cancelAnimationFrame(rafId);
    swing.detach(window);
    try { unmountHud?.(); } catch {}
    try { physics.dispose(); } catch {}
    try { disposeScene(); } catch {}
    host.innerHTML = '';
  };
}

// ---------------- Fallback HUD ----------------
function mountFallbackHud(host, getters) {
  const root = document.createElement('div');
  root.style.cssText = `
    position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
    background: #0009; color: #fff; padding: 12px 18px; border-radius: 10px;
    font-family: system-ui, sans-serif; pointer-events: auto;
    min-width: 320px; text-align: center; border: 1px solid #fff3;
  `;
  root.innerHTML = `
    <div style="display:flex;justify-content:space-between;font-size:0.9rem;margin-bottom:6px;">
      <span id="fb-hole">Hole 1 · Par 3</span>
      <span id="fb-strokes">Strokes: 0</span>
    </div>
    <div style="margin-bottom:6px;">
      <label style="font-size:0.85rem;opacity:0.8;">Club:</label>
      <select id="fb-club" style="margin-left:6px;padding:2px 6px;"></select>
    </div>
    <div style="background:#222;height:14px;border-radius:7px;overflow:hidden;position:relative;">
      <div id="fb-power" style="background:linear-gradient(90deg,#3aa55a,#ffeb3b,#d23030);height:100%;width:0%;"></div>
    </div>
    <div style="background:#222;height:8px;border-radius:4px;margin-top:6px;position:relative;">
      <div style="position:absolute;left:50%;top:-2px;width:6px;height:12px;background:#3aa55a;transform:translateX(-50%);border-radius:2px;"></div>
      <div id="fb-acc" style="position:absolute;top:0;width:4px;height:100%;background:#fff;left:50%;border-radius:2px;"></div>
    </div>
    <div id="fb-phase" style="font-size:0.8rem;opacity:0.7;margin-top:4px;">Click / Space to swing · RMB drag to aim</div>
  `;
  host.appendChild(root);

  const sel = root.querySelector('#fb-club');
  for (const c of getters.getClubs()) {
    const o = document.createElement('option');
    o.value = c.name; o.textContent = c.name;
    sel.appendChild(o);
  }
  sel.addEventListener('change', (e) => getters.setClub(e.target.value));

  const power = root.querySelector('#fb-power');
  const acc = root.querySelector('#fb-acc');
  const strokes = root.querySelector('#fb-strokes');
  const phaseEl = root.querySelector('#fb-phase');
  const holeEl = root.querySelector('#fb-hole');

  let rafId = 0;
  function tick() {
    rafId = requestAnimationFrame(tick);
    const m = getters.getMeter();
    power.style.width = `${Math.max(0, Math.min(1, m.power)) * 100}%`;
    const accFrac = (m.accuracy + 1) / 2; // -1..1 -> 0..1
    acc.style.left = `${accFrac * 100}%`;
    strokes.textContent = `Strokes: ${getters.getStrokes()}`;
    const info = getters.getHoleInfo ? getters.getHoleInfo() : { number: getters.getHole(), par: 3, length: 0 };
    holeEl.textContent = `Hole ${info.number} · Par ${info.par} · ${Math.round(info.length)}m`;
    phaseEl.textContent = phaseLabel(m.phase, getters.getClub().name);
  }
  rafId = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(rafId);
    if (root.parentNode) root.parentNode.removeChild(root);
  };
}

function phaseLabel(phase, clubName) {
  switch (phase) {
    case 'idle': return `${clubName} · click to start swing`;
    case 'power-rising': return 'Click to lock POWER';
    case 'power-locked': return 'Power locked...';
    case 'accuracy': return 'Click to lock ACCURACY';
    case 'done': return 'Swinging...';
    default: return clubName;
  }
}
