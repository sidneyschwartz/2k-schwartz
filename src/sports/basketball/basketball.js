// ============================================================================
//  🏀  BASKETBALL — 1v1 half-court "Blacktop"
//  Orchestrator + lifecycle. See design/ for the full GDD / TDD / ROADMAP.
//
//  THE CONTRACT (main.js calls this; mirrors mountGolf's dual signature):
//    mountBasketball(host, cfgOrOnExit) -> unmount()
//      - host:  the #sport-host <div> we render into
//      - arg2:  either an onExit() function, or a cfg object carrying onExit
//      - returns a cleanup function that stops the rAF loop, removes listeners,
//        disposes the scene/physics, and clears the host.
//
//  MILESTONE 0 (this file, for now): mounts a valid scene — placeholder asphalt
//  slab + a marker hoop + lights + the single rAF tick — and unmounts cleanly.
//  Real court.js / hoop.js / physics.js / controls.js arrive in Milestone 1.
// ============================================================================

import * as THREE from 'three';
import { createScene } from './scene.js';
import {
  COURT, HOOP_CENTER, HOOP_GROUND, ARC_RADIUS, RIM_RADIUS,
  BACKBOARD, CHECK_SPOT, PALETTE,
} from './court-constants.js';

export function mountBasketball(host, cfgOrOnExit) {
  // Normalize the dual signature (function => onExit; object => cfg).
  const cfg = typeof cfgOrOnExit === 'function' ? { onExit: cfgOrOnExit } : (cfgOrOnExit || {});
  const onExit = cfg.onExit || (() => {});
  const debug = new URLSearchParams(location.search).get('debug') === '1';

  host.style.position = 'relative';

  const view = createScene(host);
  const { scene, camera, renderer } = view;

  // --- Lighting (golden-hour-ish placeholder; M7 retunes) ----------------
  const hemi = new THREE.HemisphereLight(0xdfe9f5, 0x40341f, 0.85);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1d8, 1.7);
  sun.position.set(-8, 14, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 60;
  sun.shadow.camera.left = -16;
  sun.shadow.camera.right = 16;
  sun.shadow.camera.top = 16;
  sun.shadow.camera.bottom = -16;
  scene.add(sun);

  // --- Disposal bookkeeping ---------------------------------------------
  const disposables = [];
  const track = (obj) => { disposables.push(obj); return obj; };

  // --- Placeholder court slab (M0) --------------------------------------
  const courtW = COURT.maxX - COURT.minX;
  const courtL = COURT.maxZ - COURT.minZ;
  const slabGeo = track(new THREE.PlaneGeometry(courtW + 3, courtL + 3));
  const slabMat = track(new THREE.MeshStandardMaterial({ color: PALETTE.asphalt, roughness: 0.95 }));
  const slab = new THREE.Mesh(slabGeo, slabMat);
  slab.rotation.x = -Math.PI / 2;
  slab.position.set(0, 0, (COURT.minZ + COURT.maxZ) / 2);
  slab.receiveShadow = true;
  scene.add(slab);

  // Painted arc + key as a thin emissive ring/lines so the canvas reads as a
  // court (and the smoke test sees non-uniform pixels). Quick M0 placeholder.
  const lineMat = track(new THREE.LineBasicMaterial({ color: PALETTE.line }));
  const arcPts = [];
  for (let i = 0; i <= 48; i++) {
    const a = (Math.PI * i) / 48; // half circle facing out from the basket
    arcPts.push(new THREE.Vector3(
      HOOP_GROUND.x + Math.cos(a) * ARC_RADIUS,
      0.02,
      HOOP_GROUND.z + Math.sin(a) * ARC_RADIUS,
    ));
  }
  const arcGeo = track(new THREE.BufferGeometry().setFromPoints(arcPts));
  scene.add(new THREE.Line(arcGeo, lineMat));

  // Half-court boundary
  const b = COURT;
  const boundGeo = track(new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(b.minX, 0.02, b.minZ), new THREE.Vector3(b.maxX, 0.02, b.minZ),
    new THREE.Vector3(b.maxX, 0.02, b.maxZ), new THREE.Vector3(b.minX, 0.02, b.maxZ),
    new THREE.Vector3(b.minX, 0.02, b.minZ),
  ]));
  scene.add(new THREE.Line(boundGeo, lineMat));

  // --- Placeholder hoop (M0): pole + backboard + rim ring ---------------
  const hoopGroup = new THREE.Group();
  const poleMat = track(new THREE.MeshStandardMaterial({ color: PALETTE.pole, roughness: 0.6, metalness: 0.4 }));
  const poleGeo = track(new THREE.CylinderGeometry(0.08, 0.08, HOOP_CENTER.y + 0.6, 12));
  const pole = new THREE.Mesh(poleGeo, poleMat);
  pole.position.set(0, (HOOP_CENTER.y + 0.6) / 2, BACKBOARD.z - 0.6);
  pole.castShadow = true;
  hoopGroup.add(pole);

  const bbGeo = track(new THREE.BoxGeometry(BACKBOARD.width, BACKBOARD.height, 0.05));
  const bbMat = track(new THREE.MeshStandardMaterial({
    color: PALETTE.backboard, roughness: 0.2, metalness: 0.0,
    transparent: true, opacity: 0.85,
  }));
  const backboard = new THREE.Mesh(bbGeo, bbMat);
  backboard.position.set(0, BACKBOARD.bottom + BACKBOARD.height / 2, BACKBOARD.z);
  backboard.castShadow = true;
  hoopGroup.add(backboard);

  const rimGeo = track(new THREE.TorusGeometry(RIM_RADIUS, 0.018, 10, 28));
  const rimMat = track(new THREE.MeshStandardMaterial({ color: PALETTE.rim, roughness: 0.4, metalness: 0.6 }));
  const rim = new THREE.Mesh(rimGeo, rimMat);
  rim.rotation.x = Math.PI / 2;
  rim.position.set(HOOP_CENTER.x, HOOP_CENTER.y, HOOP_CENTER.z);
  rim.castShadow = true;
  hoopGroup.add(rim);
  scene.add(hoopGroup);

  // A marker where the offense checks the ball, so the broadcast frame has a
  // clear focal point in M0.
  const checkGeo = track(new THREE.RingGeometry(0.25, 0.32, 24));
  const checkMat = track(new THREE.MeshBasicMaterial({ color: 0xffd24a, side: THREE.DoubleSide }));
  const checkMark = new THREE.Mesh(checkGeo, checkMat);
  checkMark.rotation.x = -Math.PI / 2;
  checkMark.position.set(CHECK_SPOT.x, 0.03, CHECK_SPOT.z);
  scene.add(checkMark);

  // --- Optional debug overlay (smoke test reads <pre>) ------------------
  let dbg = null;
  if (debug) {
    dbg = document.createElement('pre');
    dbg.style.cssText = 'position:fixed;left:8px;top:8px;margin:0;z-index:20;color:#9f8;font:12px/1.4 ui-monospace,monospace;background:rgba(0,0,0,.45);padding:6px 8px;border-radius:6px;pointer-events:none;';
    host.appendChild(dbg);
  }

  // --- Back button -------------------------------------------------------
  const backBtn = document.createElement('button');
  backBtn.className = 'back';
  backBtn.textContent = '← back';
  backBtn.style.cssText = 'position:fixed;right:14px;top:12px;z-index:20;';
  backBtn.addEventListener('click', () => onExit());
  host.appendChild(backBtn);

  const onKey = (e) => { if (e.key === 'Escape') onExit(); };
  window.addEventListener('keydown', onKey);

  // --- Render/update loop (copies golf's defensive tick) ----------------
  let stopped = false;
  let rafId = 0;
  let last = performance.now();
  let frames = 0;
  let fpsTimer = 0;
  let fps = 0;

  function tick(now) {
    if (stopped) return;
    rafId = requestAnimationFrame(tick);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    view.frameCourt({ x: CHECK_SPOT.x, z: CHECK_SPOT.z }, dt);

    if (dbg) {
      frames++; fpsTimer += dt;
      if (fpsTimer >= 0.5) { fps = Math.round(frames / fpsTimer); frames = 0; fpsTimer = 0; }
      dbg.textContent = `🏀 basketball — M0 scaffold\nphase: SCAFFOLD\nfps: ${fps}`;
    }

    try {
      renderer.render(scene, camera);
    } catch (err) {
      // Never hard-crash the frame loop; surface once.
      if (!tick._warned) { console.error('[basketball] render error', err); tick._warned = true; }
    }
  }
  rafId = requestAnimationFrame(tick);

  // --- Cleanup -----------------------------------------------------------
  return function unmount() {
    stopped = true;
    cancelAnimationFrame(rafId);
    window.removeEventListener('keydown', onKey);
    for (const d of disposables) { try { d.dispose?.(); } catch {} }
    scene.traverse((o) => {
      if (o.isMesh || o.isLine) {
        o.geometry?.dispose?.();
        const m = o.material;
        if (Array.isArray(m)) m.forEach((mm) => mm.dispose?.()); else m?.dispose?.();
      }
    });
    view.dispose();
    host.innerHTML = '';
    host.style.position = '';
  };
}
