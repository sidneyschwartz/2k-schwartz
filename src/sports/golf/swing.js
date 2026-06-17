// Swing controller. Owns two interchangeable swing mechanics:
//
//   1. 'gesture' (default, modernized — PGA 2K EvoSwing style):
//      Mouse drag DOWN (backswing) → pause/transition → drag UP (downswing).
//      Up-stroke speed = power. Horizontal drift across the up-stroke =
//      face/path angle (positive drift = pulled, negative = pushed). Tempo
//      is the ratio backswing:downswing duration; ideal ~3:1.
//      Gamepad right-stick down then up replaces the mouse for analog input.
//      Emits onShot({ power, pathDeg, faceDeg, tempo, accuracyError, aimYaw, ...}).
//
//   2. 'click' (legacy three-click meter): retained behind setSwingMode so we
//      can A/B and so the HUD can render either visual. Putting mode also uses
//      the click path because gesture is too twitchy for short putts.
//
// Aim controls (shared): RMB drag or right-stick X axis rotates the camera
// around the ball. WASD / left stick adjusts stance for a small bias.

import { clubs, clubByName } from './clubs.js';

// ---- click-meter constants (legacy) ----
const POWER_RISE_SECONDS = 1.0;
const ACCURACY_SWEEP_SECONDS = 0.8;
const ACCURACY_PERFECT_HALFWIDTH = 0.06;

// ---- gesture-swing constants ----
// Reference upstroke speed (px/sec at our default canvas) — a brisk swing should
// hit ~1.0 power. Tuned in normalized space: we divide measured speed by the
// viewport height so 1.0 ≈ a full-canvas-height upstroke in 0.4s.
const REF_UPSTROKE_PER_HEIGHT_PER_SEC = 2.5; // i.e. 2.5 canvas-heights / sec → power 1.0
const MIN_BACKSWING_DROP = 0.06;   // fraction of viewport height — needs to drag at least this far
const MAX_BACKSWING_DROP = 0.45;   // bigger doesn't add power (caps the gesture)
const IDEAL_TEMPO_RATIO = 3.0;     // tour pros: ~3 backswing : 1 downswing
const TEMPO_WINDOW = 1.5;          // outside [IDEAL/window, IDEAL*window] = bad tempo, hurts contact
const DOWNSWING_TIMEOUT = 0.6;     // if the user stalls mid-downswing, abort
const TRANSITION_TIMEOUT = 0.4;    // dwell at top max — beyond this the swing aborts
const PATH_CLAMP_DEG = 18;         // path angles clamped to ±18°
const FACE_CLAMP_DEG = 18;
// Gamepad right-stick Y maps the same way: positive = "down" backswing, ramping
// negative through transition into "up" downswing.
const STICK_TRIGGER_DOWN = 0.5;    // axis Y > 0.5 starts the backswing
const STICK_RELEASE_UP = -0.5;     // axis Y < -0.5 means we've completed downswing

export function createSwingController({ onSwingStart, onShot } = {}) {
  const state = {
    // shared
    phase: 'idle',         // 'idle' | 'backswing' | 'transition' | 'downswing' | 'done' | 'power-rising' | 'power-locked' | 'accuracy'
    mode: 'gesture',       // 'gesture' | 'click'
    aimYaw: 0,
    stance: { x: 0, y: 0 },
    clubName: clubs[0].name,
    putting: false,

    // click-meter fields (legacy)
    power: 0,
    powerMeter: 0,
    powerDir: 1,
    accuracyMeter: 0,
    accuracyDir: 1,
    accuracyError: 0,
    elapsed: 0,

    // gesture fields
    gesture: {
      // input source — 'mouse' or 'stick' — so we don't mix sources mid-swing
      source: null,
      // path of samples [{t, x, y}] in normalized canvas coords (y: 0..1 top→bottom).
      samples: [],
      // anchor positions
      startY: 0,           // y at which backswing started (normalized)
      bottomY: 0,          // deepest y reached during backswing
      bottomT: 0,          // time of deepest y
      startT: 0,           // time backswing began
      backswingDuration: 0,
      downswingDuration: 0,
      // computed at impact
      power: 0,            // 0..1
      pathDeg: 0,          // path angle (deg) — see comment on emitShot
      faceDeg: 0,          // face angle (deg)
      tempoQuality: 1,     // 0..1 — 1 = ideal, 0 = totally off
      tempoRatio: 0,       // raw backswing/downswing
    },
  };

  function getClub() { return clubByName(state.clubName); }
  function setClub(name) { state.clubName = name; }
  function setAim(rad) { state.aimYaw = rad; }
  function setPutting(b) { state.putting = !!b; }
  function setSwingMode(mode) {
    if (mode === 'gesture' || mode === 'click') state.mode = mode;
  }
  function getSwingMode() { return state.mode; }

  function getMeter() {
    // HUD reads this each frame. We expose a single union shape — fields are
    // null/zero when not applicable to the current mode/phase.
    return {
      phase: state.phase,
      mode: state.mode,
      putting: state.putting,
      // click-meter fields
      power: state.phase === 'power-rising' ? state.powerMeter : state.power,
      lockedPower: state.power,
      accuracy: state.accuracyMeter,
      accuracyError: state.accuracyError,
      // gesture fields — HUD uses these to render the path trail / power arc
      gesture: {
        active: state.mode === 'gesture' && state.phase !== 'idle' && state.phase !== 'done',
        samples: state.gesture.samples,   // shared reference; HUD must not mutate
        backswingDepth: backswingDepth(),  // 0..1 — how far down the user has dragged
        power: state.gesture.power,
        pathDeg: state.gesture.pathDeg,
        faceDeg: state.gesture.faceDeg,
        tempoRatio: state.gesture.tempoRatio,
        tempoQuality: state.gesture.tempoQuality,
      },
    };
  }

  function backswingDepth() {
    if (state.mode !== 'gesture') return 0;
    if (state.phase === 'idle') return 0;
    const g = state.gesture;
    const drop = g.bottomY - g.startY;
    return clamp01((drop - MIN_BACKSWING_DROP) / (MAX_BACKSWING_DROP - MIN_BACKSWING_DROP));
  }

  // ---- input plumbing ----
  const keys = new Set();
  let rmbDragging = false;
  let rmbDragYaw = 0;
  let rmbLastX = 0;
  const prevGamepadButtons = new Map();
  let viewportH = 1;     // updated on each pointermove from window.innerHeight
  let viewportW = 1;

  // Mouse / pointer events for the gesture swing. We use pointerdown/move/up so
  // the same code handles touch + pen + mouse on a laptop.
  function onPointerDown(e) {
    if (e.button === 2) {
      // RMB still rotates the camera around the ball regardless of swing mode.
      rmbDragging = true;
      rmbLastX = e.clientX;
      rmbDragYaw = state.aimYaw;
      return;
    }
    if (e.button !== 0) return;
    viewportH = window.innerHeight || 1;
    viewportW = window.innerWidth || 1;
    if (state.mode === 'click') {
      click();
      return;
    }
    // Gesture mode: LMB starts the swing capture (backswing).
    if (state.putting) {
      // Putts fall through to click-meter — gesture is too twitchy for 2m putts.
      click();
      return;
    }
    if (state.phase !== 'idle') return;
    beginGestureBackswing('mouse', e.clientX / viewportW, e.clientY / viewportH);
  }

  function onPointerMove(e) {
    if (rmbDragging) {
      const dx = e.clientX - rmbLastX;
      state.aimYaw = rmbDragYaw + dx * 0.005;
    }
    if (state.mode === 'gesture' && state.gesture.source === 'mouse'
        && (state.phase === 'backswing' || state.phase === 'transition' || state.phase === 'downswing')) {
      viewportH = window.innerHeight || viewportH;
      viewportW = window.innerWidth || viewportW;
      sampleGesture(e.clientX / viewportW, e.clientY / viewportH);
    }
  }

  function onPointerUp(e) {
    if (e.button === 2) { rmbDragging = false; return; }
    if (e.button !== 0) return;
    if (state.mode !== 'gesture' || state.gesture.source !== 'mouse') return;
    // Releasing LMB ends the swing. If we've completed an upstroke past the
    // start Y, fire. Otherwise abort.
    finishGesture();
  }

  function onContextMenu(e) { e.preventDefault(); }

  function onKeyDown(e) {
    keys.add(e.code);
    if (e.code === 'Space' && state.mode === 'click') {
      e.preventDefault();
      click();
    }
  }
  function onKeyUp(e) { keys.delete(e.code); }

  // ---- click meter (legacy) ----
  function click() {
    if (state.phase === 'idle') {
      state.phase = 'power-rising';
      state.powerMeter = 0;
      state.powerDir = 1;
      state.elapsed = 0;
      onSwingStart?.();
    } else if (state.phase === 'power-rising') {
      state.power = state.powerMeter;
      if (state.putting) {
        state.accuracyError = 0;
        state.accuracyMeter = 0;
        state.phase = 'done';
        emitShotClick();
        return;
      }
      state.phase = 'power-locked';
      state.elapsed = 0;
    } else if (state.phase === 'accuracy') {
      state.accuracyError = state.accuracyMeter;
      state.phase = 'done';
      emitShotClick();
    }
  }

  function emitShotClick() {
    const club = getClub();
    const accuracy = state.accuracyError;
    const forgivenErr = Math.sign(accuracy) *
      Math.max(0, Math.abs(accuracy) - ACCURACY_PERFECT_HALFWIDTH * club.forgiveness);
    onShot?.({
      club,
      power: state.power,
      accuracyError: forgivenErr,
      rawAccuracyError: accuracy,
      // Click-meter doesn't measure path/face; emit zeros so launch math behaves
      // identically to the legacy code path.
      pathDeg: 0,
      faceDeg: 0,
      tempo: 1,
      aimYaw: state.aimYaw,
      stance: { ...state.stance },
      isPutt: !!state.putting,
      source: 'click',
    });
  }

  // ---- gesture swing ----
  function beginGestureBackswing(source, nx, ny) {
    state.gesture.source = source;
    state.gesture.samples = [{ t: 0, x: nx, y: ny }];
    state.gesture.startY = ny;
    state.gesture.bottomY = ny;
    state.gesture.bottomT = 0;
    state.gesture.startT = 0;
    state.gesture.backswingDuration = 0;
    state.gesture.downswingDuration = 0;
    state.gesture.power = 0;
    state.gesture.pathDeg = 0;
    state.gesture.faceDeg = 0;
    state.gesture.tempoRatio = 0;
    state.gesture.tempoQuality = 0;
    state.phase = 'backswing';
    state.elapsed = 0;
    onSwingStart?.();
  }

  function sampleGesture(nx, ny) {
    const g = state.gesture;
    const t = state.elapsed;
    g.samples.push({ t, x: nx, y: ny });
    // Cap buffer to avoid pathological memory growth on very slow swings.
    if (g.samples.length > 240) g.samples.shift();

    if (state.phase === 'backswing') {
      // Track deepest-down position
      if (ny > g.bottomY) {
        g.bottomY = ny;
        g.bottomT = t;
      } else if (ny < g.bottomY - 0.01) {
        // User has started moving back up by more than 1% of viewport height.
        // If they reached at least MIN_BACKSWING_DROP, transition into downswing.
        const drop = g.bottomY - g.startY;
        if (drop >= MIN_BACKSWING_DROP) {
          g.backswingDuration = g.bottomT;
          state.phase = 'downswing';
        }
      }
    } else if (state.phase === 'downswing') {
      // Check if we've returned to (or above) startY — that's "impact".
      if (ny <= g.startY + 0.005) {
        g.downswingDuration = t - g.bottomT;
        computeShotFromGesture(nx, ny, t);
        finalizeShot();
      }
    }
  }

  function computeShotFromGesture(impactX, impactY, impactT) {
    const g = state.gesture;
    // ---- Power: from upstroke speed (path length in y per time during downswing) ----
    // Use the vertical distance traveled bottom→impact (= bottomY - impactY) over downswingDuration.
    const upDist = Math.max(0.0001, g.bottomY - impactY);
    const ups = g.downswingDuration > 0 ? upDist / g.downswingDuration : 0;
    g.power = clamp01(ups / REF_UPSTROKE_PER_HEIGHT_PER_SEC);

    // ---- Path angle ----
    // Path = average horizontal drift over the DOWNSWING samples, expressed as
    // an angle relative to straight-up. Positive pathDeg = the upstroke veered
    // to +X (across the ball to the right) → "outside-in" path → causes draw
    // for a right-handed player (ball curves toward -X). Engine launch mapping
    // decides the sign convention; we just measure.
    const downSamples = g.samples.filter((s) => s.t >= g.bottomT);
    let dxSum = 0, dySum = 0;
    if (downSamples.length >= 2) {
      const a = downSamples[0];
      const b = downSamples[downSamples.length - 1];
      dxSum = b.x - a.x;
      dySum = a.y - b.y;  // positive = went up
    }
    // angle from vertical (atan2 of horizontal vs vertical components, both in
    // normalized space). Note: viewport aspect is roughly 16:9 — we scale dx to
    // canvas pixels so the angle reads in true degrees.
    const dxPx = dxSum * (viewportW || 1);
    const dyPx = dySum * (viewportH || 1);
    const rawPath = Math.atan2(dxPx, dyPx) * 180 / Math.PI;
    g.pathDeg = clamp(rawPath, -PATH_CLAMP_DEG, PATH_CLAMP_DEG);

    // ---- Face angle ----
    // Face = instantaneous X position at impact relative to the startX.
    // A user who closes the face will end the upstroke offset to the left of
    // the start position. We map the impact X delta to a face angle using the
    // average path angle as the "neutral" line.
    const startX = g.samples[0].x;
    const impactDX = (impactX - startX) * (viewportW || 1);
    const impactDY = (g.startY - impactY) * (viewportH || 1);
    const rawFace = Math.atan2(impactDX, Math.max(50, impactDY)) * 180 / Math.PI;
    g.faceDeg = clamp(rawFace, -FACE_CLAMP_DEG, FACE_CLAMP_DEG);

    // ---- Tempo ----
    const ratio = g.backswingDuration / Math.max(0.05, g.downswingDuration);
    g.tempoRatio = ratio;
    // Distance from ideal on a log scale (so 1:3 and 3:1 are equally "bad")
    const logRatio = Math.log(ratio / IDEAL_TEMPO_RATIO);
    const tol = Math.log(TEMPO_WINDOW);
    g.tempoQuality = clamp01(1 - Math.abs(logRatio) / tol);
  }

  function finalizeShot() {
    state.phase = 'done';
    emitShotGesture();
  }

  function emitShotGesture() {
    const club = getClub();
    const g = state.gesture;
    // Map tempo quality into a power scalar — bad tempo costs ~15% power.
    const tempoPower = 0.85 + 0.15 * g.tempoQuality;
    const finalPower = clamp01(g.power * tempoPower);

    // Back-compat accuracyError: derive from (face - path). The engine's
    // existing physics consumes accuracyError to spin the ball; with gesture
    // we feed the relative face angle here (positive accuracyError = pushed
    // ball with open face, etc.). Normalized to -1..1 by /FACE_CLAMP_DEG.
    const relFace = g.faceDeg - g.pathDeg;
    const accuracyError = clamp(relFace / FACE_CLAMP_DEG, -1, 1)
      * (1 - club.forgiveness * 0.4);

    onShot?.({
      club,
      power: finalPower,
      // New fields the engine launch mapping consumes for fade/draw shaping.
      pathDeg: g.pathDeg,
      faceDeg: g.faceDeg,
      tempo: g.tempoRatio,
      tempoQuality: g.tempoQuality,
      // Back-compat shim so the existing physics path still computes spin
      // without engine.js needing to change before team-lead integrates.
      accuracyError,
      rawAccuracyError: relFace / FACE_CLAMP_DEG,
      aimYaw: state.aimYaw,
      stance: { ...state.stance },
      isPutt: !!state.putting,
      source: 'gesture',
    });
  }

  function abortGesture() {
    state.phase = 'idle';
    state.gesture.source = null;
    state.gesture.samples = [];
  }

  function finishGesture() {
    // Called on pointerup. If we're mid-downswing close to impact, fire what we have.
    // If we never made it out of backswing, abort.
    if (state.phase === 'backswing' || state.phase === 'transition') {
      abortGesture();
      return;
    }
    if (state.phase === 'downswing') {
      // Treat the release point as impact even if we hadn't crossed startY yet.
      const g = state.gesture;
      const last = g.samples[g.samples.length - 1];
      g.downswingDuration = Math.max(0.05, state.elapsed - g.bottomT);
      computeShotFromGesture(last.x, last.y, state.elapsed);
      finalizeShot();
    }
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
    state.gesture.source = null;
    state.gesture.samples = [];
    state.gesture.power = 0;
    state.gesture.pathDeg = 0;
    state.gesture.faceDeg = 0;
    state.gesture.tempoRatio = 0;
    state.gesture.tempoQuality = 0;
  }

  function pollGamepad(dt) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad = null;
    for (const p of pads) { if (p) { pad = p; break; } }
    if (!pad) return;

    // A button: legacy click-meter shortcut. Only meaningful in click mode.
    const a = pad.buttons[0]?.pressed;
    const prevA = prevGamepadButtons.get('a');
    if (a && !prevA && state.mode === 'click') click();
    prevGamepadButtons.set('a', a);

    // RMB-equivalent camera rotate: right-stick X
    const rx = pad.axes[2] ?? 0;
    if (Math.abs(rx) > 0.15) state.aimYaw += rx * dt * 1.8;

    // Stance fine-tune: left stick
    const lx = pad.axes[0] ?? 0;
    const ly = pad.axes[1] ?? 0;
    state.stance.x = Math.abs(lx) > 0.15 ? clamp(lx, -1, 1) : 0;
    state.stance.y = Math.abs(ly) > 0.15 ? clamp(ly, -1, 1) : 0;

    // Gesture swing on right-stick Y. Map: +1 = stick fully down, -1 = fully up.
    // Some pads invert; users can flip with a setting later. We treat positive
    // Y as down (backswing).
    if (state.mode === 'gesture' && !state.putting) {
      const ry = pad.axes[3] ?? 0;
      const sourceOk = state.gesture.source === null || state.gesture.source === 'stick';
      if (sourceOk) {
        // For gesture-from-stick we model "virtual cursor" at (0.5, 0.5 + 0.4*ry)
        // — a stick fully down lives at y ≈ 0.9, fully up at y ≈ 0.1.
        const nx = 0.5 + (pad.axes[2] ?? 0) * 0.05; // small left/right slop = path/face
        const ny = 0.5 + ry * 0.4;
        if (state.phase === 'idle' && ry > STICK_TRIGGER_DOWN) {
          beginGestureBackswing('stick', nx, ny);
        } else if (state.gesture.source === 'stick'
                   && (state.phase === 'backswing' || state.phase === 'downswing')) {
          sampleGesture(nx, ny);
          // Auto-finish if user pulls stick fully up.
          if (state.phase === 'downswing' && ry < STICK_RELEASE_UP) {
            finishGesture();
          }
        }
      }
    }
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

    if (state.mode === 'click') {
      // Legacy click-meter state machine
      if (state.phase === 'power-rising') {
        const period = state.putting ? POWER_RISE_SECONDS * 2.2 : POWER_RISE_SECONDS;
        const v = state.powerMeter + state.powerDir * (dt / period);
        if (v >= 1) { state.powerMeter = 1; state.powerDir = -1; }
        else if (v <= 0) { state.powerMeter = 0; state.powerDir = 1; }
        else state.powerMeter = v;
      } else if (state.phase === 'power-locked') {
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
      return;
    }

    // Gesture watchdogs — abort the swing if the user gets stuck.
    const g = state.gesture;
    if (state.phase === 'backswing' && state.elapsed > TRANSITION_TIMEOUT * 4) {
      abortGesture();
    } else if (state.phase === 'downswing' && state.elapsed - g.bottomT > DOWNSWING_TIMEOUT) {
      abortGesture();
    }
  }

  function attach(target = window) {
    target.addEventListener('keydown', onKeyDown);
    target.addEventListener('keyup', onKeyUp);
    target.addEventListener('pointerdown', onPointerDown);
    target.addEventListener('pointermove', onPointerMove);
    target.addEventListener('pointerup', onPointerUp);
    target.addEventListener('pointercancel', onPointerUp);
    target.addEventListener('contextmenu', onContextMenu);
  }
  function detach(target = window) {
    target.removeEventListener('keydown', onKeyDown);
    target.removeEventListener('keyup', onKeyUp);
    target.removeEventListener('pointerdown', onPointerDown);
    target.removeEventListener('pointermove', onPointerMove);
    target.removeEventListener('pointerup', onPointerUp);
    target.removeEventListener('pointercancel', onPointerUp);
    target.removeEventListener('contextmenu', onContextMenu);
  }

  return {
    state,
    get club() { return getClub(); },
    get aim() { return state.aimYaw; },
    setClub,
    setAim,
    setPutting,
    setSwingMode,
    getSwingMode,
    getMeter,
    update,
    reset,
    click,            // legacy — HUD or tests can drive the click meter manually
    attach,
    detach,
  };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
