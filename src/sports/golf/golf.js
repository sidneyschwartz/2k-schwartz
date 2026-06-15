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
import { connectGolf } from './net.js';
import { DEMO_HOLES, getHole } from './course/holes.js';
import { buildHole } from './course/terrain.js';
import { createAiGolfer, AI_PERSONAS } from './ai.js';
import { createAudio, clubHitName } from './audio.js';
import { divotSpray, ballTrail, splashEffect } from './vfx.js';
import { mountMinimap } from './minimap.js';
import { mountSettings, loadSettings } from './settings.js';
import { showRoundSummary } from './round-summary.js';

const HOLE_RADIUS = 0.108;        // real golf hole radius (m)

// Try to resolve the art-agent material factories if present. We pass an applyMaterial
// callback to buildHole so terrain.js can attach textured materials per surface — and
// silently fall back to flat colors if materials.js isn't merged yet.
async function loadApplyMaterial() {
  try {
    const mod = await import('./materials.js');
    const factories = {
      fairway: mod.fairwayMaterial,
      rough: mod.roughMaterial,
      green: mod.greenMaterial,
      tee: mod.fairwayMaterial,      // tee box uses fairway texture
      sand: mod.sandMaterial,
      water: mod.waterMaterial,
    };
    return (surface, mesh) => {
      const f = factories[surface];
      if (!f) return null;
      const m = f();
      mesh.material = m;
      return m;
    };
  } catch {
    return null;
  }
}

// Accepts either:
//   mountGolf(host, onExitFn)                       — legacy single-player
//   mountGolf(host, { mode, code, character, onExit }) — lobby config
export function mountGolf(host, configOrOnExit) {
  let _cfg = {};
  if (typeof configOrOnExit === 'function') _cfg = { onExit: configOrOnExit };
  else if (configOrOnExit && typeof configOrOnExit === 'object') _cfg = configOrOnExit;
  const { mode = 'single', code = null, character = null, cpu = null, onExit } = _cfg;
  const isMultiplayer = mode === 'host' || mode === 'join';
  const hasCpu = mode === 'cpu' && !!cpu;

  host.innerHTML = '';
  host.style.position = 'relative';

  // ---- Scene ----
  const { scene, camera, renderer, followBall, dispose: disposeScene, camState } = createScene(host);

  // ---- Physics ----
  const physics = createPhysics();

  // Ball mesh synced from physics
  const ballMesh = new THREE.Mesh(
    new THREE.SphereGeometry(physics.BALL_RADIUS, 24, 16),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 }),
  );
  ballMesh.castShadow = true;
  scene.add(ballMesh);

  // Aim arrow (visual line from ball toward pin direction adjusted by aim)
  const aimGeo = new THREE.BufferGeometry();
  aimGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
  const aimLine = new THREE.Line(
    aimGeo,
    new THREE.LineBasicMaterial({ color: 0xffeb3b }),
  );
  scene.add(aimLine);

  // Pin sensor target (used for camera follow). Re-positioned per hole.
  const pinTarget = new THREE.Object3D();
  scene.add(pinTarget);

  // Current hole state (terrain instance is rebuilt on each hole change).
  let activeTerrain = null;
  let teeWorld = new THREE.Vector3();
  let pinWorld = new THREE.Vector3();
  let applyMaterial = null;

  // ---- Game state ----
  const game = {
    strokes: 0,
    complete: false,
    inFlight: false,
    paused: false,
    aimLineEnabled: true,
    wind: { speed: 0, dir: 0, dirDeg: 0 },
    flightStart: 0,
    settleTimer: 0,
    // multiplayer
    mySlot: 0,
    activeSlot: 0,
    localActive: !isMultiplayer,
    hole: 1,
    par: DEMO_HOLES[0].par,
    holeName: DEMO_HOLES[0].name,
    holeData: DEMO_HOLES[0],
    holeCount: DEMO_HOLES.length,
    holes: DEMO_HOLES.map((h) => ({ par: h.par, length: h.yardage })),
    // CPU state (single-player vs CPU): alternating-hole format. Player plays the
    // hole, then the CPU plays the same hole, then we advance both.
    cpuPhase: hasCpu ? 'player' : null, // 'player' | 'cpu' | 'done'
    aiName: hasCpu ? (AI_PERSONAS[cpu.personaId]?.name ?? 'CPU') : null,
    aiDifficulty: hasCpu ? cpu.difficulty : null,
    scorecard: isMultiplayer ? {
      players: [
        { name: character?.name || 'You', scores: [] },
        { name: 'Opponent', scores: [] },
      ],
      par: DEMO_HOLES.map((h) => h.par),
      holeCount: DEMO_HOLES.length,
      currentHole: 1,
    } : hasCpu ? {
      players: [
        { name: character?.name || 'You', scores: [] },
        { name: AI_PERSONAS[cpu.personaId]?.name ?? 'CPU', scores: [] },
      ],
      par: DEMO_HOLES.map((h) => h.par),
      holeCount: DEMO_HOLES.length,
      currentHole: 1,
    } : {
      players: [{ name: character?.name || 'You', scores: [] }],
      par: DEMO_HOLES.map((h) => h.par),
      holeCount: DEMO_HOLES.length,
      currentHole: 1,
    },
  };

  const ai = hasCpu ? createAiGolfer({
    difficulty: cpu.difficulty,
    personaId: cpu.personaId,
    clubList: clubs,
    holeData: game.holeData,
  }) : null;

  function loadHole(holeNumber) {
    const data = getHole(holeNumber);
    if (activeTerrain) { try { activeTerrain.dispose(); } catch {} activeTerrain = null; }
    activeTerrain = buildHole(scene, physics, data, { applyMaterial });
    teeWorld.copy(activeTerrain.teeWorld);
    pinWorld.copy(activeTerrain.pinWorld);
    pinTarget.position.copy(pinWorld);
    physics.setWind(data.wind ?? { speed: 0, dir: 0 });
    game.wind = {
      speed: data.wind?.speed ?? 0,
      dir: data.wind?.dir ?? 0,
      dirDeg: ((data.wind?.dir ?? 0) * 180 / Math.PI),
    };
    game.hole = data.number;
    game.par = data.par;
    game.holeName = data.name;
    game.holeData = data;
    if (game.scorecard) game.scorecard.currentHole = data.number;
    if (ai) ai.holeData = data;
    placeBallOnTee();
  }

  function placeBallOnTee() {
    physics.ball.velocity.set(0, 0, 0);
    physics.ball.angularVelocity.set(0, 0, 0);
    physics.ball.position.set(teeWorld.x, teeWorld.y + physics.BALL_RADIUS, teeWorld.z);
    physics.ball.quaternion.set(0, 0, 0, 1);
    physics.ball.wakeUp();
  }

  // Load hole 1 immediately (synchronously, using fallback materials). When the
  // art-agent module finishes loading, we don't rebuild — Phase 2 can hot-swap if needed.
  loadHole(1);
  loadApplyMaterial().then((fn) => { applyMaterial = fn; });

  // ---- Audio + VFX ----
  const audio = createAudio();
  host._audio = audio; // settings menu (ui-ux-mp) can wire a mute toggle here
  const trail = ballTrail(scene, ballMesh);
  let splashed = false; // dedupe splash per shot

  // ---- Swing controller ----
  const swing = createSwingController({
    onSwingStart: () => { audio.play('click_meter'); },
    onShot: (shot) => launchShot(shot),
  });
  swing.attach(window);

  function launchShot({ club, power, accuracyError, aimYaw, stance }) {
    if (game.complete) return;
    if (isMultiplayer && !game.localActive) return;
    if (hasCpu && game.cpuPhase !== 'player') return; // ignore human swings during CPU's turn
    game.strokes += 1;
    game.inFlight = true;
    game.flightStart = performance.now();

    // Audio + VFX on impact.
    audio.play(clubHitName(club.name));
    const bp0 = physics.ball.position;
    divotSpray(scene, { x: bp0.x, y: bp0.y, z: bp0.z });
    splashed = false;
    trail.start();

    // Snapshot for replay: ball start state + the shot params. The ring buffer is
    // separately captured each frame in the rAF tick; this snapshot is the rewind point.
    const ballPos = physics.ball.position;
    replay.start = {
      pos: [ballPos.x, ballPos.y, ballPos.z],
      hole: game.hole,
      shooter: hasCpu && game.cpuPhase === 'cpu' ? 'cpu' : 'player',
    };
    replay.frames.length = 0;
    replay.available = true;

    if (isMultiplayer && net) {
      const ball = physics.ball.position;
      net.sendShot({
        club: club.name,
        power,
        accuracy: accuracyError,
        aim: aimYaw,
        startPos: [ball.x, ball.y, ball.z],
      });
    }

    // Compute launch velocity in world space.
    // Direction toward pin from ball, rotated by aimYaw + small stance bias.
    const ball = physics.ball.position;
    const toPinX = pinWorld.x - ball.x;
    const toPinZ = pinWorld.z - ball.z;
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
    replay.shotStart = performance.now();
  }

  // ---- Replay (ring buffer over the last shot's flight) ----
  const REPLAY_MAX_SECONDS = 6;
  const replay = {
    frames: [],
    start: null,
    available: false,
    playing: false,
    cursor: 0,
    playStart: 0,
    shotStart: 0,
  };
  function captureReplayFrame() {
    if (!replay.start || replay.playing || !game.inFlight) return;
    const t = performance.now() - replay.shotStart;
    if (t > REPLAY_MAX_SECONDS * 1000) return;
    if (replay.frames.length && t - replay.frames[replay.frames.length - 1].t < 8) return;
    const p = physics.ball.position;
    const q = physics.ball.quaternion;
    replay.frames.push({
      t, x: p.x, y: p.y, z: p.z,
      qx: q.x, qy: q.y, qz: q.z, qw: q.w,
    });
  }
  function replayLastShot() {
    if (!replay.available || replay.playing) return false;
    if (!replay.frames.length || !replay.start) return false;
    replay.playing = true;
    replay.cursor = 0;
    replay.playStart = performance.now();
    physics.ball.velocity.set(0, 0, 0);
    physics.ball.angularVelocity.set(0, 0, 0);
    physics.ball.sleep();
    return true;
  }
  function advanceReplay(now) {
    if (!replay.playing) return;
    const elapsed = (now - replay.playStart) * 0.6;
    while (replay.cursor < replay.frames.length - 1 &&
           replay.frames[replay.cursor + 1].t <= elapsed) {
      replay.cursor += 1;
    }
    const f = replay.frames[replay.cursor];
    if (!f) { endReplay(); return; }
    physics.ball.position.set(f.x, f.y, f.z);
    physics.ball.quaternion.set(f.qx, f.qy, f.qz, f.qw);
    const lastT = replay.frames[replay.frames.length - 1].t;
    if (elapsed > lastT + 300) endReplay();
  }
  function endReplay() {
    replay.playing = false;
    const last = replay.frames[replay.frames.length - 1];
    if (last) {
      physics.ball.velocity.set(0, 0, 0);
      physics.ball.angularVelocity.set(0, 0, 0);
      physics.ball.position.set(last.x, last.y, last.z);
      physics.ball.quaternion.set(last.qx, last.qy, last.qz, last.qw);
      physics.ball.wakeUp();
    }
  }
  function onReplayKey(e) {
    if (e.repeat) return;
    if (e.code === 'KeyR') {
      replayLastShot();
    } else if (e.code === 'KeyM') {
      // Expand to fullscreen for ~3s when pressed while panel is small; otherwise toggle.
      if (!minimap) return;
      if (minimap.expanded) minimap.setExpanded(false);
      else {
        minimap.setExpanded(true);
        clearTimeout(onReplayKey._mapTimer);
        onReplayKey._mapTimer = setTimeout(() => { minimap?.setExpanded(false); }, 3000);
      }
    } else if (e.code === 'KeyP' || e.code === 'Escape') {
      if (!settingsUi) return;
      if (settingsUi.isOpen()) {
        game.paused = false;
        settingsUi.close();
      } else {
        game.paused = true;
        settingsUi.open();
      }
    }
  }
  window.addEventListener('keydown', onReplayKey);

  // ---- HUD ----
  let unmountHud = null;
  // Queue HUD method calls fired before the async HUD module finishes loading.
  const pendingHudCalls = [];
  function flushHudQueue() {
    while (pendingHudCalls.length) {
      const fn = pendingHudCalls.shift();
      try { fn(); } catch {}
    }
  }
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
    getHole: () => game.hole,
    getPar: () => game.par,
    getHoleInfo: () => ({
      par: game.par,
      number: game.hole,
      name: game.holeName,
      length: game.holeData?.yardage ?? 0,
    }),
    getClubs: () => clubs,                  // legacy alias for fallback HUD
    getScorecard: () => game.scorecard,
    setClub: (name) => swing.setClub(name),
    onSelectClub: (name) => swing.setClub(name),
  };

  (async () => {
    try {
      const mod = await import('./hud.js');
      if (mod?.mountHud) {
        unmountHud = mod.mountHud(hudHost, getters);
        flushHudQueue();
        return;
      }
    } catch (err) {
      // fall through to fallback
      console.warn('[golf] hud.js not available, using fallback HUD:', err?.message);
    }
    unmountHud = mountFallbackHud(hudHost, getters);
    flushHudQueue();
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

  const settingsBtn = document.createElement('button');
  settingsBtn.className = 'golf-iconbtn';
  settingsBtn.setAttribute('aria-label', 'Settings (P)');
  settingsBtn.title = 'Settings (P)';
  settingsBtn.innerHTML = '&#9881;';
  settingsBtn.addEventListener('click', () => settingsUi?.toggle());
  overlay.appendChild(settingsBtn);

  const mapBtn = document.createElement('button');
  mapBtn.className = 'golf-iconbtn';
  mapBtn.setAttribute('aria-label', 'Toggle map (M)');
  mapBtn.title = 'Toggle map (M)';
  mapBtn.innerHTML = '&#128506;';
  mapBtn.addEventListener('click', () => minimap?.toggle());
  overlay.appendChild(mapBtn);

  const replayBtn = document.createElement('button');
  replayBtn.className = 'golf-iconbtn golf-iconbtn--replay';
  replayBtn.setAttribute('aria-label', 'Replay last shot');
  replayBtn.title = 'Replay last shot';
  replayBtn.innerHTML = '&#9654;';
  replayBtn.style.display = 'none';
  replayBtn.addEventListener('click', () => { replayLastShot(); });
  overlay.appendChild(replayBtn);

  host.appendChild(overlay);

  // ---- Minimap ----
  let minimap = null;
  try {
    minimap = mountMinimap(host, {
      getHoleData: () => game.holeData,
      getBallPos: () => {
        const p = physics.ball.position;
        return { x: p.x, y: p.y, z: p.z };
      },
    });
  } catch (err) {
    console.warn('[golf] minimap failed to mount', err);
  }

  // ---- Settings + pause ----
  const persisted = loadSettings();
  let settingsUi = null;
  try {
    settingsUi = mountSettings({
      host,
      onClose: () => { game.paused = false; },
      onResumeGame: () => { game.paused = false; },
      onResetHole: resetHole,
      onExitToMenu: () => onExit?.(),
      onSetMuted: (m) => { try { audio.setMuted(m); } catch {} },
      onSetCameraOffset: (d) => { if (camState) camState.distance = d; },
      onSetMinimapVisible: (v) => minimap?.setVisible(v),
      onSetAimLineVisible: (v) => { game.aimLineEnabled = !!v; },
    });
  } catch (err) {
    console.warn('[golf] settings failed to mount', err);
  }

  // Apply persisted settings on boot.
  game.aimLineEnabled = persisted.aimLine;
  if (camState) camState.distance = persisted.cameraDistance;
  if (persisted.muted) { try { audio.setMuted(true); } catch {} }
  minimap?.setVisible(persisted.minimap);

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

  function onHoleComplete() {
    // Record locally (multiplayer scorecard updates also come from server).
    if (game.scorecard) {
      let slot;
      if (isMultiplayer) slot = game.mySlot;
      else if (hasCpu && game.cpuPhase === 'cpu') slot = 1;
      else slot = 0;
      const me = game.scorecard.players[slot];
      if (me) me.scores[game.hole - 1] = game.strokes;
    }
    if (isMultiplayer && net) {
      net.sendHoleComplete(game.strokes);
      if (game.hole < game.holeCount) {
        setTimeout(() => { try { net.nextHole(); } catch {} }, 1500);
      } else {
        showHudToast?.('Match complete!');
        setTimeout(() => { if (!stopped) showFinalSummary(); }, 1600);
      }
      return;
    }
    // Single-player vs CPU: after the player finishes, the CPU plays the same hole.
    if (hasCpu && game.cpuPhase === 'player') {
      setTimeout(() => {
        if (stopped) return;
        game.cpuPhase = 'cpu';
        game.strokes = 0;
        game.complete = false;
        completeBanner.style.display = 'none';
        resetBtn.style.display = 'none';
        placeBallOnTee();
        scheduleCpuShot();
      }, 1600);
      return;
    }
    // Either solo (no CPU) or CPU just finished this hole — advance to next.
    if (game.hole < game.holeCount) {
      setTimeout(() => {
        if (stopped) return;
        const next = game.hole + 1;
        game.strokes = 0;
        game.complete = false;
        completeBanner.style.display = 'none';
        resetBtn.style.display = 'none';
        if (hasCpu) game.cpuPhase = 'player';
        loadHole(next);
        if (ai) ai.holeData = game.holeData;
        swing.reset();
      }, 1800);
    } else {
      // Final hole done in solo or vs CPU — show the polished round summary.
      setTimeout(() => { if (!stopped) showFinalSummary(); }, 1200);
    }
  }

  function showFinalSummary() {
    // Build a scorecard if solo (no MP/CPU): synthesize a single-player card from history.
    let players, par, totalHoles;
    if (game.scorecard) {
      players = game.scorecard.players;
      par = game.scorecard.par || DEMO_HOLES.slice(0, game.holeCount).map((h) => h.par);
      totalHoles = game.holeCount;
    } else {
      // Solo without scorecard: fall back to a single-player single-hole record.
      players = [{ name: character?.name || 'You', scores: [game.strokes] }];
      par = [game.par];
      totalHoles = 1;
    }
    completeBanner.style.display = 'none';
    showRoundSummary(host, {
      players, par, totalHoles,
      onPlayAgain: () => {
        // Reload by quickly bouncing the host's _golfController out and back via onExit.
        onExit?.();
      },
      onExit: () => onExit?.(),
    });
  }

  // ---- CPU turn machinery (single-player vs CPU) ----
  // The CPU plans a shot, builds a synthetic onShot payload (matching the human swing
  // controller's shape) and feeds it into launchShot. After the ball settles, if the
  // hole isn't complete, plan the next CPU shot.
  function scheduleCpuShot() {
    if (!ai || game.cpuPhase !== 'cpu' || game.complete) return;
    // Update ai's hole reference each shot so wind/pin reflect current state.
    ai.holeData = game.holeData;
    setTimeout(() => {
      if (stopped || game.cpuPhase !== 'cpu' || game.complete || game.inFlight) return;
      const ballPos = physics.ball.position;
      const shot = ai.planShot({
        ballPos: { x: ballPos.x, y: ballPos.y, z: ballPos.z },
        wind: game.wind,
      });
      launchShot({
        club: shot.club,
        power: shot.power,
        accuracyError: shot.accuracyError,
        aimYaw: shot.aimYaw,
        stance: { x: 0, y: 0 },
      });
    }, 900);
  }

  // Called when the ball settles (after a shot stops moving).
  function onBallSettled(bp) {
    // Replay buffer is finalized when the shot ends.
    replay.available = replay.frames.length > 0 && !!replay.start;

    if (isMultiplayer && net && game.localActive) {
      net.sendShotResult({
        endPos: [bp.x, bp.y, bp.z],
        strokes: game.strokes,
      });
      if (!game.complete) {
        net.endTurn();
        game.localActive = false;
        showHudToast?.("Opponent's turn");
      }
      return;
    }
    // CPU: if it's the CPU's turn and the hole isn't done, schedule another CPU shot.
    if (hasCpu && game.cpuPhase === 'cpu' && !game.complete) {
      scheduleCpuShot();
    }
  }

  // ---- Multiplayer connection ----
  let net = null;
  let showHudToast = null;
  let setHudTurn = null;
  if (isMultiplayer) {
    setHudTurn = (t) => {
      if (unmountHud?.setTurn) unmountHud.setTurn(t);
      else pendingHudCalls.push(() => unmountHud?.setTurn?.(t));
    };
    showHudToast = (t) => {
      if (unmountHud?.showToast) unmountHud.showToast(t);
      else pendingHudCalls.push(() => unmountHud?.showToast?.(t));
    };
    net = connectGolf({
      code,
      character,
      onEvent: (e) => {
        if (e.type === 'joined') {
          game.mySlot = e.slot;
          game.localActive = (e.slot === 0); // host starts as active by default
          setHudTurn?.(e.slot === 0 ? 'Waiting for opponent…' : 'Joined. Waiting for host…');
        } else if (e.type === 'start') {
          showHudToast?.('Match start!');
          setHudTurn?.(game.localActive ? 'Your turn' : "Opponent's turn");
        } else if (e.type === 'turn') {
          game.activeSlot = e.turn;
          game.localActive = (e.turn === game.mySlot);
          setHudTurn?.(game.localActive ? 'Your turn' : "Opponent's turn");
          // When it becomes your turn after a hole reset, ensure ball is on tee for new hole.
        } else if (e.type === 'opponent-shot') {
          // Stub: engine can play a swing animation here. For Phase 4 we just teleport on result.
        } else if (e.type === 'opponent-shot-result') {
          // Spectator: teleport the ball to the opponent's landing position.
          const [x, y, z] = e.endPos || [0, 0, 0];
          physics.ball.velocity.set(0, 0, 0);
          physics.ball.angularVelocity.set(0, 0, 0);
          physics.ball.position.set(x, Math.max(y, physics.BALL_RADIUS), z);
          physics.ball.wakeUp();
          game.strokes = e.strokes || game.strokes;
        } else if (e.type === 'scorecard') {
          if (game.scorecard && Array.isArray(e.scorecard)) {
            e.scorecard.forEach((perPlayer, slotIdx) => {
              if (game.scorecard.players[slotIdx]) {
                game.scorecard.players[slotIdx].scores = perPlayer.slice();
              }
            });
          }
        } else if (e.type === 'next-hole') {
          // server: hole index advanced; reset local state for the new hole
          const newHole = (e.hole || 0) + 1;
          game.strokes = 0;
          game.complete = false;
          loadHole(newHole);   // rebuilds terrain + repositions ball on new tee
          swing.reset();
          completeBanner.style.display = 'none';
          resetBtn.style.display = 'none';
          game.activeSlot = e.turn;
          game.localActive = (e.turn === game.mySlot);
          setHudTurn?.(game.localActive ? 'Your turn' : "Opponent's turn");
          showHudToast?.(`Hole ${newHole}`);
        } else if (e.type === 'opponent-left') {
          showHudToast?.('Opponent left');
          setHudTurn?.('Opponent left');
        } else if (e.type === 'error') {
          showHudToast?.(e.error || 'network error');
        } else if (e.type === 'closed') {
          setHudTurn?.('Disconnected');
        }
      },
    });
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

    // Replay button visibility tracks replay availability and idle state.
    if (replayBtn) {
      const show = replay.available && !replay.playing && !game.inFlight;
      replayBtn.style.display = show ? 'inline-block' : 'none';
    }

    if (game.paused) {
      // Render the static frame so the scene stays visible behind the settings overlay.
      renderer.render(scene, camera);
      return;
    }

    // Putting-mode auto-switch: when the ball is on the green and at rest, switch
    // to the Putter and enable the slower power-only meter. Only re-evaluate during
    // the idle phase so we don't pull the rug out mid-swing.
    if (swing.state.phase === 'idle' && !game.inFlight && !game.complete) {
      const greenRegion = game.holeData?.regions?.find((r) => r.type === 'green');
      if (greenRegion) {
        const ddx = physics.ball.position.x - greenRegion.x;
        const ddz = physics.ball.position.z - greenRegion.z;
        const onGreen = (ddx * ddx + ddz * ddz) < (greenRegion.r * greenRegion.r);
        if (onGreen) {
          if (swing.club.name !== 'Putter') swing.setClub('Putter');
          if (!swing.state.putting) swing.setPutting(true);
        } else if (swing.state.putting) {
          swing.setPutting(false);
        }
      }
    }

    swing.update(dt);
    if (!replay.playing) {
      physics.step(dt);
      captureReplayFrame();
    } else {
      advanceReplay(now);
    }

    // Sync ball mesh
    const bp = physics.ball.position;
    ballMesh.position.set(bp.x, bp.y, bp.z);
    const bq = physics.ball.quaternion;
    ballMesh.quaternion.set(bq.x, bq.y, bq.z, bq.w);

    // Aim line — only while idle, and only when enabled in settings.
    if (game.aimLineEnabled && swing.state.phase === 'idle' && !game.inFlight && !game.complete) {
      const toPinX = pinWorld.x - bp.x;
      const toPinZ = pinWorld.z - bp.z;
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

    // Settle / in-flight detection (skipped during replay since we manually drive the ball)
    if (game.inFlight && !replay.playing) {
      const speed = physics.ball.velocity.length();
      // Rolling-ball SFX gain follows ground speed (only while near the ground).
      const onGround = bp.y < physics.BALL_RADIUS * 3;
      audio.play('ball_roll', { speed: onGround ? speed : 0 });

      // Water splash: detect ball entering a water region.
      if (!splashed && game.holeData?.regions) {
        for (const r of game.holeData.regions) {
          if (r.type !== 'water') continue;
          const inX = Math.abs(bp.x - r.x) <= (r.w ?? 0) / 2;
          const inZ = Math.abs(bp.z - r.z) <= (r.d ?? 0) / 2;
          if (inX && inZ && bp.y < 0.5) {
            audio.play('ball_splash');
            splashEffect(scene, { x: bp.x, y: 0.05, z: bp.z });
            splashed = true;
            break;
          }
        }
      }

      if (speed < 0.15 && bp.y < physics.BALL_RADIUS * 2.5) {
        game.settleTimer += dt;
        if (game.settleTimer > 0.6) {
          game.inFlight = false;
          game.settleTimer = 0;
          audio.play('ball_roll', { speed: 0 });
          trail.stop();
          onBallSettled(bp);
        }
      } else {
        game.settleTimer = 0;
      }
    }

    // Trail update + ambient wind.
    trail.update(dt);
    audio.tickAmbient(dt);

    // Cup sensor: when ball center is within HOLE_RADIUS * 1.5 in XZ of the pin AND
    // its vertical speed is below 2 m/s, count it as holed and snap-stop. This catches
    // both rolling putts and gentle landings near the cup without requiring exact
    // sphere/sensor body math.
    if (!game.complete && !replay.playing) {
      const dx = bp.x - pinWorld.x;
      const dz = bp.z - pinWorld.z;
      const distXZ = Math.sqrt(dx * dx + dz * dz);
      const vy = Math.abs(physics.ball.velocity.y);
      const nearGround = bp.y < pinWorld.y + physics.BALL_RADIUS * 6;
      if (distXZ < HOLE_RADIUS * 1.5 && nearGround && vy < 2) {
        // Snap to bottom of cup
        physics.ball.velocity.set(0, 0, 0);
        physics.ball.angularVelocity.set(0, 0, 0);
        physics.ball.position.set(pinWorld.x, pinWorld.y - 0.1, pinWorld.z);
        game.complete = true;
        game.inFlight = false;
        audio.play('ball_roll', { speed: 0 });
        audio.play('ball_in_hole');
        trail.stop();
        onHoleComplete();
        completeBanner.innerHTML = `Hole ${game.hole} <small style="opacity:0.7">${game.holeName || ''}</small><br/>complete in ${game.strokes} stroke${game.strokes === 1 ? '' : 's'}`;
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

  // ---- Controller (exposed for net.js / external integrations) ----
  const controller = {
    state: game,
    isMultiplayer,
    mode,
    setActive(b) { game.localActive = !!b; },
    applyShot() { /* engine can render opponent swing here */ },
    applyShotResult({ endPos }) {
      const [x, y, z] = endPos || [0, 0, 0];
      physics.ball.velocity.set(0, 0, 0);
      physics.ball.angularVelocity.set(0, 0, 0);
      physics.ball.position.set(x, Math.max(y, physics.BALL_RADIUS), z);
      physics.ball.wakeUp();
    },
    notifyHoleComplete(strokes) { net?.sendHoleComplete(strokes); },
    nextHole() { net?.nextHole(); },
    endTurn() { net?.endTurn(); },
    replayLastShot() { return replayLastShot(); },
    canReplay() { return replay.available && !replay.playing; },
    // ---- Phase 5+6 polish surface ----
    getBallPos() {
      const p = physics.ball.position;
      return { x: p.x, y: p.y, z: p.z };
    },
    getHoleData() { return game.holeData; },
    getScorecard() { return game.scorecard; },
    setCameraOffset(d) { if (camState) camState.distance = d; },
    setPaused(b) { game.paused = !!b; },
    setMuted(b) { try { audio.setMuted(!!b); } catch {} },
    setMinimapVisible(b) { minimap?.setVisible(b); },
    setAimLineVisible(b) { game.aimLineEnabled = !!b; },
    openSettings() { game.paused = true; settingsUi?.open(); },
  };
  host._golfController = controller;

  // ---- Unmount ----
  return function unmount() {
    stopped = true;
    cancelAnimationFrame(rafId);
    swing.detach(window);
    window.removeEventListener('keydown', onReplayKey);
    try { unmountHud?.(); } catch {}
    try { net?.close(); } catch {}
    try { minimap?.unmount(); } catch {}
    try { settingsUi?.unmount(); } catch {}
    try { activeTerrain?.dispose(); } catch {}
    try { physics.dispose(); } catch {}
    try { disposeScene(); } catch {}
    try { trail.dispose(); } catch {}
    try { audio.setMuted(true); } catch {}
    delete host._audio;
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
