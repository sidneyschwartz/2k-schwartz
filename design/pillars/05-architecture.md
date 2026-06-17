# Pillar 5 — Technical Architecture & Module Decomposition

> Basketball is a NEW sport module under src/sports/basketball/ that COPIES golf's file split and contracts rather than sharing a base class. It exports mountBasketball(host, cfgOrOnExit) -> unmount with a single rAF tick (dt = Math.min(0.05, dtMs/1000)) that runs a fixed update order: gather input -> apply authoritative inputs -> physics sim step -> rules reducer -> camera -> render (defensive try/catch fallback). The hard new constraint is continuous real-time netcode: slot 0 (host) runs the ONE authoritative sim and broadcasts state snapshots; slot 1 (guest) streams input + renders interpolated snapshots; the server gains a dumb 'basketball' relay branch exactly like tennis. Makes are detected by a downward-crossing rim sensor (ball center passes from above to below the rim plane while inside the rim radius with downward velocity).

# Pillar A — Technical Architecture & Module Decomposition

This pillar owns the **code structure** of `src/sports/basketball/`. It mirrors golf's split, reuses golf's named utilities/patterns, and defines the central per-frame update order plus the host-authoritative data flow. Every other pillar (visuals, gameplay feel, netcode tuning, content) plugs into the signatures defined here.

> Guiding rule from the codebase facts: **sports COPY the golf patterns, no shared base class.** So we literally clone the golf file layout and adapt. Where a golf helper is generic (camera smoothing math, cannon trimesh builder, procedural audio envelope, net reconnect/backoff/slot-reclaim), we copy it into the basketball module rather than importing across sports — golf may diverge and we must not couple them.

---

## 1. File decomposition (`src/sports/basketball/`)

Only what 1v1 half-court needs. Each file lists its one-line responsibility and key exported signatures.

### `bball.js` — orchestrator (mirrors `golf.js`)
Assembles scene + physics + court + controls + players + rules + HUD + audio + net; owns the single rAF tick and `unmount()`.
```js
export function mountBasketball(host, configOrOnExit) -> unmount
// config shape (from lobby.js), copying golf's normalize:
//   { mode:'single'|'cpu'|'host'|'join', code?, character, cpu?:{personaId,difficulty},
//     target?:11, winBy?:2, onExit }
// mode→role:  host => authoritative slot 0; join => guest slot 1;
//             single/cpu => local authoritative (no net).
```
Internally identical scaffolding to `mountGolf`: normalize `configOrOnExit` (function => `{onExit}`), `host.innerHTML=''`, `host.style.position='relative'`, mount debug overlay (`?debug` gated), build subsystems, expose `host._bballController` (test/integration surface mirroring `host._golfController`), return `unmount`.

### `scene.js` — renderer + camera (mirrors golf `scene.js`)
Owns `WebGLRenderer({antialias})`, `pixelRatio<=1.5`, PCFSoft shadows, ACESFilmic tonemapping, `PerspectiveCamera(55,…,0.1,1500)`, resize listener removed on dispose, and a **broadcast court camera** instead of a chase-ball camera.
```js
export function createScene(host) -> {
  scene, camera, renderer,
  followAction(ballPos, lookFocus, dt, opts),  // smooth broadcast cam (see §5)
  resetCameraFor(ballPos, lookFocus),          // snap (copy golf semantics)
  addResizeHook(cb), removeResizeHook(cb),
  camState, dispose
}
```
`camState` reuses golf's smoothing fields (`smoothed`, `smoothedLook`, `distance`, `height`, `yaw`) with the same `k = 1 - exp(-smooth*dt)` lerp. We **copy golf's exact lerp math** — it's proven NaN-safe and frame-rate independent.

### `court.js` — geometry (mirrors `course/terrain.js` + `course/holes.js`, vastly simpler)
Builds the half-court visual meshes and returns the zone metrics the rules engine needs (arc radius, paint, hoop world position). One static court, no per-hole loader.
```js
export const COURT = {            // single source of truth for dimensions (meters)
  HALF_LEN: 14.33, WIDTH: 15.24,  // FIBA-ish half court
  RIM_HEIGHT: 3.05, RIM_RADIUS: 0.2286, RIM_CENTER: {x:0, y:3.05, z:1.2},
  BACKBOARD: { w:1.83, h:1.07, z:0.9, yBottom:2.9 },
  THREE_PT_RADIUS: 6.75,          // arc measured from hoop
  PAINT: { w:4.9, len:5.8 },
  CHECK_SPOT: { x:0, z:8.5 },     // top of key — check-ball / take-it-back line ref
};
export function buildCourt(scene, physics) -> {
  hoopWorld: THREE.Vector3,       // rim center, used by camera + make sensor + AI
  isBehindArc(x, z) -> bool,      // |hoop->point| > THREE_PT_RADIUS  (for 2s/3s + take-it-back)
  isInbounds(x, z) -> bool,
  dispose()
}
```
`buildCourt` calls `physics.addCourtColliders()` (floor plane + rim torus-approx + backboard box) — see physics. Court mesh stays static for the whole match (huge perf win vs golf's per-hole rebuilds).

### `physics.js` — cannon-es world (mirrors golf `physics.js`)
A `CANNON.World` (fixed-timestep accumulator, NaN `sanitize()` guard copied verbatim from golf), the basketball body, static colliders (floor, rim, backboard, optional pole), and the **make sensor**. Players are **NOT** rigid bodies — they're kinematic capsules driven by controls (sim-lite). The ball is the only dynamic body.
```js
export function createPhysics() -> {
  world, ball,                    // CANNON.Body sphere, BALL_RADIUS=0.119, mass=0.62
  addCourtColliders(),            // floor plane + rim + backboard (called by buildCourt)
  addPlayerColliders(p0, p1),     // two kinematic cylinders for ball deflection/contests
  setPlayerPose(slot, x, z, h),   // host moves kinematic capsules each step
  step(dt),                       // fixed 1/120 substep (faster than golf's 1/60: bounces)
  makeSensor: { lastBelow, check(prevY, y, vx,vy,vz, x, z) -> bool },  // see §6
  markSafePos(x,y,z), dispose,
  BALL_RADIUS, materials
}
```
Aerodynamics from golf are **dropped** (no Magnus needed for a basketball arc) — we keep simple gravity + a light linear drag and tuned restitution. Rim/backboard use a stiff `ContactMaterial` (restitution ~0.5 rim, ~0.4 backboard, ~0.6 floor) so shots rattle realistically. Substep at **1/120** (`FIXED_DT=1/120, MAX_SUBSTEPS=8`) because a 24 cm ball at shot speed can tunnel a thin rim torus at 1/60.

### `controls.js` — input + shot meter (mirrors `swing.js`)
The **`createSwingController` 3-state meter is the template** for the shot meter, but basketball needs continuous locomotion + dribble + actions, so controls.js is a superset: a movement/action sampler PLUS the shot-meter state machine.
```js
export function createControls({ onShotStart, onShotRelease, onAction }) -> {
  state,                          // { move:{x,z}, sprint, action, meter:{phase,power,...} }
  attach(target), detach(target),
  update(dt),                     // advances meter; polls keys/gamepad like swing.pollKeys
  sampleInput() -> InputFrame,    // {seq, move:{x,z}, sprint, btn:{shoot,pass,steal,...}, aimYaw}
  getMeter() -> {phase,power,release,perfectZone}, // HUD pulls this, same shape as swing.getMeter
  reset()
}
```
Shot meter reuses swing's idle→rising→(release window)→done machine. We adopt the simpler **'click' two-phase** form (hold to raise power, release in green = perfect) rather than the gesture path — it maps cleanly to a 2K shot meter and to a single `btn.shoot` edge. `onShotRelease({power, release, contestPenalty})` is the analogue of golf's `onShot`. `sampleInput()` is the netcode hook: it produces a compact per-frame `InputFrame` (the guest streams this; the host applies both its own and the guest's).

### `player.js` — avatar + animation (mirrors `characters.js`)
Builds a player rig and runs a small anim state machine (idle/dribble/drive/jump/shoot/defend). Pure presentation + a kinematic pose the host advances.
```js
export function createPlayer({ character, team }) -> {
  group: THREE.Group,
  setAnimState(s),               // 'idle'|'dribble'|'drive'|'gather'|'jump'|'shoot'|'land'|'defend'
  setPose(x, z, facingYaw, dt),  // moves group; lerps facing
  update(dt), dispose, name
}
```
Reuse `createGolfer` body-build conventions where possible (the codebase already has rigged character meshes keyed by `character.id`).

### `rules.js` — match state machine (the **reducer**, golf's `onHoleComplete`/turn logic generalized)
Pure-ish function: takes current `GameState` + `events` for this frame, returns the next phase/score/possession. No Three.js, no DOM — testable in `node:test` without a browser (this is the unit-test seam, like golf's deterministic `_debugSink`).
```js
export function createRules({ target=11, winBy=2 }) -> {
  reduce(state, events, dt),     // events: {made?, ballOOB?, ballLoose?, fouled?, clearedArc?}
  // mutates/returns state.phase, state.score, state.possession, state.checkBall, state.takeBackNeeded
}
```
Phases: `tipoff → checkBall → live → deadBall(make|miss|oob|foul) → takeBack → checkBall …`, terminal `gameOver`. Streetball rules baked in: **make-it-take-it** (scorer keeps possession), **take-it-back past the arc** on a change of possession (sets `takeBackNeeded=true` until ball-handler `clearedArc`), **1s & 2s**, **first to 11 win-by-2** (`won = score[a]>=target && score[a]-score[b]>=winBy`).

### `hud.js` — DOM overlay (mirrors golf `hud.js`)
`mountHud(host, getters) -> unmount` with `.setStatus()/.showToast()/.root` add-ons (golf's `.setTurn()/.showToast()`). Pull-based getters, rAF diff-update vs a `last` cache.
```js
export function mountHud(host, getters) -> unmount   // getters: getScore, getShotClock?, getMeter,
                                                     // getPhase, getPossession, getStamina, getToast
```

### `audio.js` — procedural Web Audio (mirrors golf `audio.js`)
`createAudio() -> { play(name,opts), tickAmbient(dt), setMuted, muted }`. Names: `dribble`, `swish`, `rim`, `backboard`, `whistle`, `buzzer`, `sneaker`, `crowd`. **No asset files** — copy golf's oscillator/noise-burst envelope approach.

### `net.js` — `connectBasketball` (COPY `connectGolf`, change the protocol)
Same auto-reconnect backoff, `clientId` slot-reclaim (sessionStorage), `waking/connecting/connected/reconnecting/disconnected` status, app-level ping/pong, visibility-reconnect, and identical `wsUrl()` (`dev=ws://host:3001`, `prod=same-origin wss`). New message verbs (see §3).
```js
export function connectBasketball({ code, character, onEvent, onStatus }) -> {
  sendInput(frame),    // guest→host (relayed)
  sendSnapshot(snap),  // host→guest (relayed)
  sendCheck(),         // either→ control msgs if needed
  close, slot, status
}
```

### `lobby.js` — mode/character wizard (mirrors golf `lobby.js`)
`showLobby(host) -> Promise<cfg|null>`. Reuse golf's mode tiles (single / vs CPU / host / join) and the live mini-Three.js portrait from `character-select.js` (import directly — it's sport-agnostic). Round-length step is replaced by "First to 11 (win by 2)" copy.

### `ai.js` — CPU defender + offense (mirrors golf `ai.js`)
`createAiDefender(...)` and `createAiBallhandler(...)` that emit the **same `InputFrame` shape** the human `controls.sampleInput()` produces, so the host feeds AI through the identical apply-input path (exactly golf's "AI emits actions in the same shape as the human controller" pattern, Gaussian noise by difficulty).
```js
export function createAiDefender({ difficulty, court, hoopWorld }) -> { think(state, dt) -> InputFrame }
export function createAiBallhandler({ difficulty, court }) -> { think(state, dt) -> InputFrame }
export const AI_PERSONAS = { ... }   // mirror golf's persona table
```

### `snapshot.js` — serialization + interpolation (NEW; no golf analogue, because golf is turn-based)
The seam that makes host-authoritative real-time work. Shared by host (encode) and guest (decode + interpolate). Kept tiny and allocation-free in the hot path.
```js
export function encodeSnapshot(state) -> Snapshot          // see §4 shape
export function createInterpolator(bufferMs=100) -> {
  push(snap),                  // guest stores timestamped snapshots
  sample(now) -> InterpState   // render-time interpolated positions (ball + 2 players)
}
```

---

## 2. Central per-frame update order (the rAF tick in `bball.js`)

Single `requestAnimationFrame(tick)`, `dt = Math.min(0.05, dtMs/1000)` (copied from golf). The order is **role-dependent** but the skeleton is one function. `paused` short-circuits to a static render (copy golf).

```
tick(now):
  if stopped: return
  rafId = requestAnimationFrame(tick)
  dt = min(0.05, (now-last)/1000); last = now
  if game.paused: render(); return

  // 1) INPUT  — always gather local input
  controls.update(dt)
  localInput = controls.sampleInput()           // {seq, move, btn, aimYaw, meter}

  if role === HOST (slot 0, or single/cpu):
     // 1a) ingest remote/AI inputs into the authoritative input set
     inputs[0] = localInput
     inputs[1] = isCpu ? ai.think(game, dt) : net.latestGuestInput()  // last-received frame
     // 2) SIM STEP (authoritative)
     applyInputs(inputs, dt)                     // move kinematic players, dribble, trigger shots
     physics.step(dt)                            // ONE dynamic ball; substep 1/120
     events = collectEvents()                    // make sensor, OOB, loose-ball, contest/foul
     // 3) RULES
     rules.reduce(game, events, dt)              // possession, score, phase, take-back, win
     // 3a) BROADCAST
     if isOnline: net.sendSnapshot(encodeSnapshot(game))   // ~15-20 Hz, not every frame
  else (role === GUEST, slot 1):
     // 1a) stream input up
     net.sendInput(localInput)                   // ~30-60 Hz
     // 2') no local sim — sample interpolated authoritative state
     interp = interpolator.sample(now - INTERP_DELAY_MS)
     applyInterpToScene(interp)                  // ball mesh, both players, score, phase
     // (guest still runs its OWN shot meter visually for responsiveness; host is truth)

  // 4) CAMERA (both roles) — broadcast cam follows ball + active scorer focus
  camDir.update(dt, { ballPos, focus, possession })

  // 5) PRESENTATION (both roles)
  syncBallMesh(); players[0].update(dt); players[1].update(dt)
  audio.tickAmbient(dt)

  // 6) RENDER (defensive, copied from golf)
  try { visuals?.composer && game.postFx ? composer.render() : renderer.render(scene,camera) }
  catch { try { renderer.render(scene,camera) } catch {} }

  if debugOverlay: debugOverlay.tick({...})
```

Key properties carried over from golf:
- **Single rAF, single dt clamp** at 0.05 — prevents physics explosions on tab-stall.
- **Defensive render** with composer→plain fallback so a broken post-FX never blue-screens.
- **Static-frame render while paused** so the settings overlay has a backdrop.

Decoupling note: the **physics substep is fixed (1/120) inside `physics.step(dt)`** via golf's accumulator, so the authoritative sim is deterministic-ish regardless of render fps. The host's sim is the ONLY place `physics.step` runs; the guest never steps physics.

---

## 3. Host-authoritative data flow & server branch

The server stays a **dumb relay**, exactly like tennis. We add one branch in `server/index.js` dispatch keyed on `room.sport === 'basketball'`. No authoritative game state on the server (unlike golf).

### Server branch (add next to the tennis branch, ~line 247)
```js
if (room.sport === 'basketball') {
  if (msg.type === 'input') {                 // guest → host
    if (ws.slot !== 1) return;                // only the guest streams input
    broadcast(room, { type:'input', input: msg.input }, ws);  // to host (slot 0)
  } else if (msg.type === 'snapshot') {       // host → guest
    if (ws.slot !== 0) return;                // only the host is authoritative
    broadcast(room, { type:'snapshot', snap: msg.snap }, ws);
  } else if (msg.type === 'check') {          // optional control (rematch/check-ball ack)
    broadcast(room, { type:'check', ...msg }, ws);
  }
  return;
}
```
Room creation: extend the existing `newGolfRoom`/generic-room ternary so a `basketball` join builds the same minimal `{players:[null,null], started, gcAt}` room (it needs nothing golf-specific — no turn/scorecard/hole). The fixed `[slot0,slot1]` array, reclaim-by-clientId, heartbeat, and `ROOM_TTL_MS` GC all work unchanged.

### Role assignment
- `mode:'host'` → joins with `sport:'basketball'`, gets `slot 0` → **authoritative**.
- `mode:'join'` → typically `slot 1` → **guest**. (Defensive: role is derived from the server-assigned `slot`, NOT from `mode`, in case of reclaim — `role = slot===0 ? 'host' : 'guest'`.)
- `single`/`cpu` → no net; local host role.

### Flow summary
```
GUEST:  controls → InputFrame --(input)--> server --(input)--> HOST
HOST:   apply both inputs → sim → snapshot --(snapshot)--> server --(snapshot)--> GUEST
GUEST:  interpolator.push(snap) → render delayed-interpolated state
```

### Rates & latency hiding
- Guest `sendInput`: every tick, capped ~**40 Hz** (skip-send throttle, last-frame coalescing — golf-style timer).
- Host `sendSnapshot`: ~**18 Hz** (every ~3rd-4th tick). Snapshots are small (§4).
- Guest renders at `now - INTERP_DELAY_MS` (default **100 ms**) using `snapshot.js` interpolator → smooth even with 18 Hz snapshots and jitter.
- **No client-side prediction in v1** (out of scope/risk). The guest shows its own shot-meter UI locally for feel, but ball truth comes from the host. This is the realistic browser budget; prediction/reconciliation is an explicit follow-up (see risks).

---

## 4. Shared game-state object shape (`GameState`)

One plain object, like golf's `game`. Authoritative on host; on guest it's hydrated from snapshots. Field groups:

```js
const game = {
  // --- match ---
  phase: 'tipoff',          // 'tipoff'|'checkBall'|'live'|'deadBall'|'takeBack'|'gameOver'
  target: 11, winBy: 2,
  score: [0, 0],            // [slot0, slot1]
  possession: 0,            // slot id with the ball (0|1)
  checkBall: true,          // ball must be checked at top of key before going live
  takeBackNeeded: false,    // change-of-possession requires clearing the arc
  winner: null,             // null | 0 | 1

  // --- entities (world space) ---
  ball: { x:0, y:1.2, z:8, vx:0, vy:0, vz:0, held: 0|1|null },   // held=slot dribbling, null=loose/air
  players: [
    { x:-1, z:8, h:0, facing:0, anim:'idle', stamina:1, withBall:true,  hasBall:true },
    { x: 1, z:8, h:0, facing:Math.PI, anim:'idle', stamina:1, withBall:false, hasBall:false },
  ],

  // --- per-frame transient (host-computed, not all serialized) ---
  shot: null,               // {shooter, power, release, launchTime} while a shot is airborne
  contest: 0,               // 0..1 defender contest factor at release (feeds make probability)

  // --- net/role (local, not serialized) ---
  mySlot: 0, role: 'host'|'guest', isOnline: bool, localActive: true,

  // --- presentation flags (copy golf) ---
  paused:false, postFx:true, qualityLevel:'high', flying:false,
};
```

### `Snapshot` (wire shape — minimal, host→guest)
```js
// snapshot.js encodeSnapshot(game) -> :
{
  t: perfTimestampMs,        // for interpolation ordering
  seq: monotonicCounter,     // drop out-of-order
  ph: phaseEnum,             // small int
  sc: [s0, s1],              // score
  po: possession, fl: flagsBitmask,   // checkBall|takeBackNeeded|gameOver packed
  b: [x,y,z, held],          // ball (vel not sent; guest interpolates position)
  p: [ [x,z,h,facing,animEnum], [x,z,h,facing,animEnum] ],
}
```
~25 numbers/snapshot ≈ well under 300 bytes JSON. (We keep JSON — tennis/golf already do; binary packing is a perf follow-up, not needed for 2 entities @ 18 Hz.)

`InputFrame` (wire shape — guest→host):
```js
{ seq, move:{x,z}, sprint:0|1, aimYaw, btn:{shoot,pass,steal,pump,sprint}, meterRelease:0..1|null }
```

---

## 5. Camera (broadcast cam, replacing golf's chase cam)

`scene.followAction(ballPos, focus, dt, opts)` keeps golf's smoothing core (`smoothed.lerp(pos, k)`, `k=1-exp(-smooth*dt)`) but the target is a **broadcast framing**: position the camera on the half-court's open side, distance/height chosen by `camDir` mode (`half` default, `drive`, `shot`, `check`), look at a point between the ball and the hoop. A small `makeCameraDirector(camState, followAction)` (copy golf's `makeCameraDirector`) switches modes from rules/phase:
```js
case 'check':  distance=10 height=4.5            // top-of-key wide
case 'drive':  distance=8  height=3.2 lookBiasHoop=0.4
case 'shot':   distance=9  height=3.8 lookBiasHoop=0.7
case 'half':   distance=11 height=5.0            // default live
```
`resetCameraFor` snaps on phase transitions (after a make, on check-ball) so the cam never lerps across a cut — identical bug-class to golf's "looking-at-sky" fix.

---

## 6. Make detection (the rim sensor)

A make = the ball passing **downward through the rim plane while inside the rim radius**. We do NOT rely on a cannon trigger body (the ball can be moving fast and a thin sensor tunnels). Instead, a cheap per-step geometric check using the previous and current ball Y (golf already keeps prior state for its cup sensor; we copy that idea):

```js
// physics.makeSensor.check(prevY, y, vx,vy,vz, x, z):
const R = COURT.RIM_CENTER, RAD = COURT.RIM_RADIUS;
const ballR = BALL_RADIUS;
// 1) downward motion through the rim's horizontal plane this step
const crossedDown = prevY > R.y && y <= R.y && vy < 0;
if (!crossedDown) return false;
// 2) interpolate XZ at the moment Y == R.y (linear within the substep)
const t = (prevY - R.y) / (prevY - y);          // 0..1
const ix = lerp(prevX, x, t), iz = lerp(prevZ, z, t);
// 3) inside the rim circle (ball center within rim radius minus a margin)
const d2 = (ix-R.x)**2 + (iz-R.z)**2;
const inside = d2 < (RAD - ballR*0.5)**2;
// 4) sane downward speed (reject a ball wedged on the rim crawling through)
return inside && vy < -0.5;
```
Run this **inside the fixed substep** (in `physics.step`, right after `world.step`) so fast shots can't skip the plane. On a true crossing it sets `events.made = { shooter: ball.held??game.shot.shooter }`. `rules.reduce` then: adds 2 or 3 (via `court.isBehindArc(shotOrigin)` captured at release time), keeps possession for the scorer (make-it-take-it), sets `phase='deadBall'→'checkBall'`, plays `swish` vs `rim+swish` audio (driven by whether it touched rim — a separate rim-contact flag from the contact-material callback). The **rim torus + backboard box** remain real colliders so misses physically rattle and rebound; the sensor is purely the scoring oracle layered on top.

---

## 7. Clean disposal (`unmount`, copied from golf)

```js
return function unmount() {
  stopped = true;
  cancelAnimationFrame(rafId);
  controls.detach(window);
  window.removeEventListener('keydown', onKey);   // any extra listeners
  try { unmountHud?.(); } catch {}
  try { net?.close(); } catch {}
  try { settingsUi?.unmount(); } catch {}
  try { court?.dispose(); } catch {}
  try { players[0]?.dispose(); players[1]?.dispose(); } catch {}
  try { physics.dispose(); } catch {}             // removes all world bodies (golf pattern)
  try { disposeScene(); } catch {}                // removes resize listener + canvas + renderer.dispose
  try { audio.setMuted(true); } catch {}
  delete host._audio; delete host._bballController;
  host.innerHTML = '';
};
```
Matches golf's contract exactly: stopped flag, cancel rAF, remove listeners, dispose scene/physics, `host.innerHTML=''`. `physics.dispose()` copies golf's `while(world.bodies.length) world.removeBody(...)`. `scene.dispose()` copies golf's `removeEventListener('resize') + renderer.dispose() + canvas removal`.

---

## 8. Reused golf utilities (named)

| Golf source | Reuse strategy | What we take |
|---|---|---|
| `golf.js` orchestrator | **Pattern-copy** | normalize-config, debug overlay, rAF tick skeleton, paused static-render, defensive composer→plain render, `host._xController` test surface, `_state()`/`_debug*` hooks |
| `scene.js` | **Copy + adapt cam** | renderer/camera setup, resize-hook list, `camState` smoothing math (`1-exp(-k*dt)`), `resetCameraFor` snap |
| `physics.js` | **Copy core** | accumulator `step(dt)` + `FIXED_DT`/`MAX_SUBSTEPS`, `sanitize()` NaN/clamp guard, `markSafePos`, `addStaticMesh` trimesh builder (for backboard/court), `dispose` body-drain |
| `swing.js` | **Pattern-copy** | shot-meter state machine (idle→rising→release→done), `getMeter()` union shape, `attach/detach`, `pollGamepad/pollKeys` |
| `hud.js` | **Pattern-copy** | `mountHud(host,getters)`, pull getters, rAF diff vs `last`, `.showToast()`/`.set*()` add-ons |
| `audio.js` | **Pattern-copy** | `createAudio()` procedural envelopes, `play/tickAmbient/setMuted` |
| `net.js` | **Copy `connectGolf`→`connectBasketball`** | `wsUrl()`, clientId+sessionStorage reclaim, reconnect backoff array, `waking/connected/...` status machine, app ping/pong, visibility-reconnect |
| `ai.js` | **Pattern-copy** | persona table, Gaussian (`gauss`) noise-by-difficulty, **emit-same-shape-as-human** principle (here: `InputFrame`) |
| `lobby.js` + `character-select.js` | **Copy lobby / import char-select** | mode wizard; `showCharacterSelect` is sport-neutral and imported directly |
| `makeCameraDirector`, `mountDebugOverlay`, `makeShotTracer` (golf.js locals) | **Copy** | mode-routed camera; on-screen diag overlay; a shot-arc tracer for replays |

---

## 9. Integration wiring (outside this dir, minimal)

Mirrors how golf/tennis are wired (no new architecture):
- `src/main.js`: import `mountBasketball` + (its) `showLobby`; add `startBasketball()` (clone `startGolf`: `showLobby` → `mountBasketball(host,{...cfg,onExit:showMenu})`); branch in the `.sport` click handler on `data-sport==='basketball'`.
- `index.html`: add the basketball tile (`data-sport="basketball"`).
- `style.css`: add a tile gradient (court-orange).
- `server/index.js`: add the `room.sport==='basketball'` relay branch (§3) + extend room-creation ternary.
- Tests: `tests/basketball-server.test.js` (clone `server.test.js`: two ws clients, assert `input`/`snapshot` relay routing & slot guards); `tests/rules.test.js` (pure `rules.reduce` unit tests — make-it-take-it, take-it-back, win-by-2); a Playwright `?sport=…` smoke shot for blank-render detection.

---

## 10. Perf / feasibility notes (browser WebGL + cannon-es)

- **One dynamic body** (ball) + a handful of static colliders + 2 kinematic capsules → cannon-es is trivially within budget even at 1/120 substeps. Golf already runs heavier (trimesh terrain + aero forces).
- **Static court** (no per-hole rebuild) means draw calls and GC pressure are far below golf; we can spend that budget on crowd/board visuals (other pillar).
- **Snapshots @18 Hz, 2 entities** → ~5 KB/s/peer. Trivial. JSON is fine (matches existing sports); binary is an optional later optimization.
- **Risk-managed netcode**: dumb-relay + host-authority + interpolation is the *minimum* viable real-time model and reuses tennis's relay shape, so server changes are ~15 lines. No prediction in v1 keeps the guest path simple and bug-light; the cost is ~100 ms input-to-visual latency for the guest's ball (acceptable for a sim-lite feel, and the guest's own shot-meter UI is local/instant).


---

## Adversarial Critique (AAA-bar review)

**Verdict:** needs-work

### Gaps
- NETCODE CORE IS UNDERSPECIFIED FOR A TWITCH GAME. The design's headline 'no client-side prediction in v1, guest sees ball ~100ms late' is positioned as acceptable for 'sim-lite,' but the loop it describes is worse than 100ms. The guest's OWN movement is also non-predicted: guest move input -> 40Hz send -> WAN -> host applies -> host sims -> 18Hz snapshot -> WAN -> guest interp buffer (100ms) -> render. That is ~RTT + up-to-55ms snapshot quantization + 100ms interp on the guest's own avatar locomotion, not just the ball. For a 1v1 where defensive positioning and drive timing ARE the game, a guest whose own player slides 150-250ms behind their stick fails the Blacktop feel bar outright. The doc only flags the ball lag, not the avatar-control lag, which is the more damaging one.
- HOST ADVANTAGE IS A COMPETITIVE-INTEGRITY HOLE, not a tuning footnote. Host has 0ms on its own inputs and full prediction implicitly (it IS the sim); guest has none. In a first-to-11 win-by-2 ranked-feeling 1v1 this is a permanent ~one-possession handicap. 'Mitigate with higher snapshot rate / tight interp' does not close it. There is no plan for which slot becomes host (always the room creator?), no host-migration, and no acknowledgement that this makes online matches asymmetric by construction.
- SHOT METER REUSE IS UNDER-ANALYZED FOR THE GUEST. swing.js getMeter()/phases are a single-actor turn-based machine (verified: phases idle->power-rising->power-locked/accuracy->done, one onShot). The design says the guest runs a 'local visual-only shot meter' but ball truth is the host. That means a guest can green a perfect-release meter locally and still get a miss/blocked result from the host 150ms later, with the meter UI already showing 'perfect.' That is a jarring desync the 2K bar would never ship. There is no reconciliation story for meter-vs-result, and meterRelease is the ONLY shot data in InputFrame -- the host must re-derive contest/timing, so the guest's perfect green is advisory at best.
- MAKE-SENSOR DESIGN IS PLAUSIBLE BUT THE PHYSICS BUDGET CONTRADICTS GOLF. Verified golf uses FIXED_DT=1/60, MAX_SUBSTEPS=6, accumulator += min(dt,0.1). The design wants 1/120 with MAX_SUBSTEPS=8 'copying golf's accumulator.' At the dt clamp of 0.05s a single rAF frame already needs 6 substeps at 1/120 to not fall behind; on a stalled/jank frame (the exact case golf's clamp exists for) the while(steps<8) cap drops time and the sim slows -- and ball-on-rim rattle is exactly where you accumulate substeps. 8 is under-budgeted; either raise MAX_SUBSTEPS or justify 1/120 with a CCD/raycast sweep instead of brute substepping.
- RIM COLLIDER IS LEFT AS AN OPEN QUESTION YET IT IS THE WHOLE GAME FEEL. 'thin cylinder shell vs ring-of-spheres vs torus trimesh -- pick during implementation' defers the single hardest cannon-es problem. A ring-of-spheres rim that produces believable 2K-style rattle/roll-out without tunneling or exploding a 0.24m ball at shot speed is non-trivial and may not be achievable at 1/120; this needs a spike NOW, not a footnote, because it gates whether the make-sensor-on-top approach even feels right (sensor says MAKE but collider visually clanked it out = broken).
- BALL POSSESSION / DRIBBLE PHYSICS IS HAND-WAVED. game.ball.held = slot|null toggles between 'dynamic body' and 'attached to a kinematic player.' The transition (gather, steal deflection, strip, loose-ball recovery) is the meat of 1v1 ball-handling and is entirely unspecified. 'Players are kinematic capsules, contests are probabilistic in rules.js' means steals/strips are dice rolls, not physical -- that is explicitly BELOW the Blacktop bar where on-ball defense and ripping the ball is skill-expressive. The design even admits bodychecks would force revisiting the kinematic-capsule decision; that decision is load-bearing and made for convenience, not feel.
- GUEST JOIN HAS NO INITIAL-STATE BOOTSTRAP. Verified the server only sends golfState() on join for golf; basketball guest gets 'joined'+'start' but no snapshot until the host's next 18Hz broadcast, and there is no server-side last-snapshot cache (server is a dumb relay). On a mid-match reclaim/reconnect the guest renders an empty/default GameState for up to a snapshot interval. The design's reconnect story is copied from golf but golf is server-authoritative (state is on the server); here state lives only on the host, so reconnect semantics are fundamentally different and unaddressed.
- TAKE-IT-BACK / CHECK-BALL OVER THE NET IS UNRESOLVED. Open question 'host-gated phase=live on both players behind arc, no extra message' is the right instinct but interacts badly with guest lag: the guest must physically walk behind the arc, but the guest's position is host-derived and lagged, so the guest sees themselves cross the arc later than the host registers it -- ambiguous 'why didn't it check' moments. Needs an explicit host-authoritative check confirmation surfaced to the guest, not silent gating.

### Must-Fix (applied in synthesis)
- Add guest-side prediction for the GUEST'S OWN PLAYER LOCOMOTION at minimum (dead-reckon the local avatar from local input, reconcile to host snapshot with error-smoothing). Without this the guest's own movement is unplayable for a 1v1. Ball/opponent can stay interpolated in v1, but self-prediction is not optional -- promote it from 'risk/follow-up' to v1 scope or explicitly cut online and ship single/cpu first.
- Specify the possession state machine concretely: gather window, dribble-attach offset, steal/strip resolution (probabilistic is acceptable for v1 but DEFINE the inputs -- defender distance, hand position, ball-handler facing, RNG seed shared so host/guest agree on outcome), and the exact moment ball.held flips and the dynamic body is re-enabled. This is the gameplay core, not a physics detail.
- Run a rim-collider spike before committing the architecture: prototype ring-of-spheres vs thin cylinder at the chosen substep with real shot speeds, measure tunneling and rattle feel. Pin FIXED_DT/MAX_SUBSTEPS to the spike result. Do not ship 1/120 + MAX_SUBSTEPS=8 unverified -- either raise substeps to cover the 0.05 dt clamp or add a swept/raycast CCD for the ball vs rim+backboard.
- Resolve the shot-meter-vs-authoritative-result desync: either (a) make the guest's meter result advisory-only and visually NON-committal until the host confirms (no 'PERFECT' flash before result), or (b) send the full release timing in InputFrame and have the host honor the guest's locally-evaluated release deterministically. Pick one; the current 'local visual meter, host is truth' silently contradicts itself.
- Add a server-cached last-snapshot (tiny, sport-specific) OR an explicit host->guest 'request-state' verb so a joining/reconnecting guest gets immediate state. The copied golf reconnect logic does not work when authoritative state lives on a peer, not the server. Define what happens to the sim when the HOST drops (golf can't lose its authority; here the match is dead -- need an explicit forfeit/pause/host-migration policy).
- Make check-ball / take-it-back host-authoritative with an explicit confirmation event to the guest (phase transition + 'cleared arc' ack), not silent host-gated position checks, to avoid lag-ambiguous dead-ball stalls.
- Define host selection deterministically (room creator = slot0 = host) and document the unavoidable host-side latency advantage as a known limitation, plus a mitigation (e.g., cap host input buffering by one snapshot so the host isn't a full frame ahead, or run host inputs through the same interp delay for symmetry in ranked contexts).

### Feasibility Notes
The module decomposition, file split, server relay branch (~15 lines is accurate -- tennis already proves the dumb-relay slot-0-authoritative pattern at lines 237-247), single-rAF tick, defensive render, and dispose contract are all faithful to the codebase and clearly feasible. cannon-es with one dynamic body + kinematic capsules is well within budget; golf already runs heavier (trimesh terrain + per-substep aero). The HARD risk is entirely netcode feel, not CPU/GPU: a non-predicted guest in a continuous 1v1 will not reach the Blacktop bar. Realistic scope trim: ship single-player + vs-CPU FIRST (no net path, host role is local, all the gameplay/feel/physics work is shared and testable offline), then add online as a second milestone WITH at least guest self-prediction. Treating online-without-prediction as the v1 'minimum viable' is the core misjudgment -- it is cheap to build and bad to play. Physics substep numbers (1/120, MAX_SUBSTEPS=8) are stated as 'copying golf' but golf is 1/60/6; that inconsistency plus the unresolved rim collider are the two technical items that need a spike before the architecture is locked.

