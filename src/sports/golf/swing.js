// Three-click swing meter + aim controller.
//
// State machine:
//   idle           — waiting for first click to start swing
//   power-rising   — meter sweeps 0 -> 1 (~1.0s); click locks power
//   power-locked   — brief settle so the user sees the lock; auto-transitions to accuracy
//   accuracy       — indicator sweeps a small zone; click sets accuracy error
//   done           — shot emitted; controller resets to idle after onShot returns
//
// Inputs: mouse left, Space, gamepad button 0 (Xbox A). Right-mouse drag or right stick
// rotate the camera around the ball. WASD / left stick = stance fine-tune (small effect).

import { clubs, clubByName } from './clubs.js';

const POWER_RISE_SECONDS = 1.0;     // 0 -> 1 -> 0 ping-pong period is 2x this
const ACCURACY_SWEEP_SECONDS = 0.8; // left -> right -> left
const ACCURACY_PERFECT_HALFWIDTH = 0.06; // green zone half-width (before forgiveness scaling)

export function createSwingController({ onSwingStart, onShot } = {}) {
  const state = {
    phase: 'idle',
    power: 0,            // 0..1 locked power
    powerMeter: 0,       // 0..1 current display value
    powerDir: 1,
    accuracyMeter: 0,    // -1..1
    accuracyDir: 1,
    accuracyError: 0,    // -1..1 final
    elapsed: 0,
    aimYaw: 0,           // rad
    stance: { x: 0, y: 0 }, // -1..1 fine-tune
    clubName: clubs[0].name,
  };

  function getClub() { return clubByName(state.clubName); }
  function setClub(name) { state.clubName = name; }
  function setAim(rad) { state.aimYaw = rad; }

  function getMeter() {
    return {
      phase: state.phase,
      power: state.phase === 'power-rising' ? state.powerMeter : state.power,
      lockedPower: state.power,
      accuracy: state.accuracyMeter,
      accuracyError: state.accuracyError,
    };
  }

  // ---- input plumbing ----
  const keys = new Set();
  let mouseDragging = false;
  let mouseDragYaw = 0;
  let lastMouseX = 0;
  const prevGamepadButtons = new Map();

  function onKeyDown(e) {
    keys.add(e.code);
    if (e.code === 'Space') { e.preventDefault(); click(); }
  }
  function onKeyUp(e) { keys.delete(e.code); }
  function onMouseDown(e) {
    if (e.button === 0) {
      click();
    } else if (e.button === 2) {
      mouseDragging = true;
      lastMouseX = e.clientX;
      mouseDragYaw = state.aimYaw;
    }
  }
  function onMouseMove(e) {
    if (mouseDragging) {
      const dx = e.clientX - lastMouseX;
      state.aimYaw = mouseDragYaw + dx * 0.005;
    }
  }
  function onMouseUp(e) {
    if (e.button === 2) mouseDragging = false;
  }
  function onContextMenu(e) { e.preventDefault(); }

  function click() {
    if (state.phase === 'idle') {
      state.phase = 'power-rising';
      state.powerMeter = 0;
      state.powerDir = 1;
      state.elapsed = 0;
      onSwingStart?.();
    } else if (state.phase === 'power-rising') {
      state.power = state.powerMeter;
      state.phase = 'power-locked';
      state.elapsed = 0;
    } else if (state.phase === 'accuracy') {
      state.accuracyError = state.accuracyMeter;
      state.phase = 'done';
      emitShot();
    }
  }

  function emitShot() {
    const club = getClub();
    const accuracy = state.accuracyError;
    // forgive a bit of error before treating as miss
    const forgivenErr = Math.sign(accuracy) *
      Math.max(0, Math.abs(accuracy) - ACCURACY_PERFECT_HALFWIDTH * club.forgiveness);
    onShot?.({
      club,
      power: state.power,
      accuracyError: forgivenErr,
      rawAccuracyError: accuracy,
      aimYaw: state.aimYaw,
      stance: { ...state.stance },
    });
  }

  function reset() {
    state.phase = 'idle';
    state.power = 0;
    state.powerMeter = 0;
    state.powerDir = 1;
    state.accuracyMeter = 0;
    state.accuracyDir = 1;
    state.accuracyError = 0;
    state.elapsed = 0;
  }

  function pollGamepad(dt) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad = null;
    for (const p of pads) { if (p) { pad = p; break; } }
    if (!pad) return;

    // Button 0 (A) edge-trigger
    const a = pad.buttons[0]?.pressed;
    const prevA = prevGamepadButtons.get('a');
    if (a && !prevA) click();
    prevGamepadButtons.set('a', a);

    // Right stick yaw (axes 2,3) — small dead-zone
    const rx = pad.axes[2] ?? 0;
    if (Math.abs(rx) > 0.15) {
      state.aimYaw += rx * dt * 1.8;
    }
    // Left stick stance (axes 0,1)
    const lx = pad.axes[0] ?? 0;
    const ly = pad.axes[1] ?? 0;
    state.stance.x = Math.abs(lx) > 0.15 ? clamp(lx, -1, 1) : 0;
    state.stance.y = Math.abs(ly) > 0.15 ? clamp(ly, -1, 1) : 0;
  }

  function pollKeys(dt) {
    if (keys.has('KeyA')) state.aimYaw -= dt * 1.5;
    if (keys.has('KeyD')) state.aimYaw += dt * 1.5;
    if (keys.has('KeyW')) state.stance.y = -1;
    else if (keys.has('KeyS')) state.stance.y = 1;
    else state.stance.y = 0;
  }

  function update(dt) {
    pollGamepad(dt);
    pollKeys(dt);
    state.elapsed += dt;
    if (state.phase === 'power-rising') {
      // ping-pong 0..1 with period 2 * POWER_RISE_SECONDS
      const v = state.powerMeter + state.powerDir * (dt / POWER_RISE_SECONDS);
      if (v >= 1) { state.powerMeter = 1; state.powerDir = -1; }
      else if (v <= 0) { state.powerMeter = 0; state.powerDir = 1; }
      else state.powerMeter = v;
    } else if (state.phase === 'power-locked') {
      // brief settle then advance to accuracy
      if (state.elapsed > 0.15) {
        state.phase = 'accuracy';
        state.elapsed = 0;
        state.accuracyMeter = -1;
        state.accuracyDir = 1;
      }
    } else if (state.phase === 'accuracy') {
      const v = state.accuracyMeter + state.accuracyDir * (dt * 2 / ACCURACY_SWEEP_SECONDS);
      if (v >= 1) { state.accuracyMeter = 1; state.accuracyDir = -1; }
      else if (v <= -1) { state.accuracyMeter = -1; state.accuracyDir = 1; }
      else state.accuracyMeter = v;
    }
  }

  function attach(target = window) {
    target.addEventListener('keydown', onKeyDown);
    target.addEventListener('keyup', onKeyUp);
    target.addEventListener('mousedown', onMouseDown);
    target.addEventListener('mousemove', onMouseMove);
    target.addEventListener('mouseup', onMouseUp);
    target.addEventListener('contextmenu', onContextMenu);
  }
  function detach(target = window) {
    target.removeEventListener('keydown', onKeyDown);
    target.removeEventListener('keyup', onKeyUp);
    target.removeEventListener('mousedown', onMouseDown);
    target.removeEventListener('mousemove', onMouseMove);
    target.removeEventListener('mouseup', onMouseUp);
    target.removeEventListener('contextmenu', onContextMenu);
  }

  return {
    state,
    get club() { return getClub(); },
    get aim() { return state.aimYaw; },
    setClub,
    setAim,
    getMeter,
    update,
    reset,
    click,
    attach,
    detach,
  };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
