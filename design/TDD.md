# Master Technical Design Document — 1v1 Half-Court Basketball ("2K Schwartz: Blacktop")

# Master Technical Design Document — 1v1 Half-Court "Blacktop" Basketball

**Audience:** the engineer implementing the sport directly.
**Status:** engineer-ready spec synthesizing seven critiqued pillars (architecture, netcode, physics/court, gameplay, rules, avatars, HUD/UX, audio) with all `mustFix` items applied and feasibility cuts taken.

This document is the single source of truth. Where a pillar's design conflicted with the verified codebase, **the codebase wins** and the conflict is resolved here explicitly.

---

## 0. Ground truth (verified against the repo)

These facts were confirmed by reading the source; the design below depends on them:

- **`server/index.js`** already sets `sport` on the generic (non-golf) room literal at line 181 (`{ key, sport, code, players:[null,null], ... }`), and the `room.sport === 'tennis'` relay branch (line 237) **does fire**. The earlier worry that "rooms never set sport" is false for current code. **However** the generic room carries golf-specific cruft (`turn`, `scorecard`, etc.); basketball gets its own clean constructor (§9).
- **`src/sports/golf/physics.js`** uses a fixed-step accumulator: `FIXED_DT = 1/60`, `MAX_SUBSTEPS = 6`, `accumulator += Math.min(dt, 0.1)`, then `world.step(FIXED_DT)` + `sanitize()` per substep (lines 443–460). **Basketball reuses this exact pattern — we do NOT invent 1/120.** (See §4 for the tunneling resolution.)
- **`src/sports/golf/golf.js`** tick: `dt = Math.min(0.05, dtMs/1000)` (line 1240), single rAF (1237/1436), defensive composer→renderer fallback (1250/1412–1422), `unmount` sets `stopped`, cancels rAF, `host.innerHTML=''`, `delete host._audio` (1500–1515), exposes `host._golfController` (1496).
- **`src/sports/golf/swing.js`** `createSwingController({onSwingStart,onShot})` exposes `getMeter()` returning `{phase,power,...}` (lines 43/93). This is the shot-meter template.
- **`src/sports/golf/net.js`** `connectGolf({code,character,onEvent,onStatus})` with `getOrCreateClientId()` (sessionStorage), `wsUrl()` (dev `ws://host:3001` / prod same-origin `wss`), `RECONNECT_DELAYS`, status machine `connecting|waking|connected|reconnecting|disconnected`. **`connectBasketball` is adapted from THIS file.**
- **`src/sports/tennis/tennis.js`** is a **113-line stub with NO client netcode** (only a comment that the server relays tennis). **There is no "tennis client pattern" to copy.** The tennis *server relay branch* is the only tennis reference that is real.
- **`src/sports/golf/characters.js`**: `buildGolfer(preset)` builds a `THREE.Group` bone hierarchy with `roundedBox` meshes and a `gripPivot` that parents the club (lines 204+). This is the avatar rig base.
- **`src/sports/golf/ai.js`**: `createAiGolfer` emits actions in the human's shape via `gauss()` noise by `DIFFICULTIES`. Only the *Gaussian-jitter-by-difficulty idea* ports; basketball needs a new per-frame behavior controller.
- **`src/main.js`**: `startGolf()` (lines 26–33) `await showLobby` → `mountGolf(host,{...cfg,onExit:showMenu})`; tile dispatch on `b.dataset.sport` (line 56); dev deep-link `?golf=1` (line 61).

---

## 1. Scope, decisions, and v1 cuts

### 1.1 Shipped in v1
Full-3D half-court 1v1 to 11 (win by 2), streetball 1s & 2s, check-ball, make-it-take-it, take-it-back past the arc. Single-player + vs-CPU **first**, then online (host-authoritative). Hold-release shot meter with a per-frame contest scalar. One golden-hour blacktop court. Procedural avatars extending the golf rig. Procedural audio. DOM broadcast HUD.

### 1.2 Cut from v1 (re-scope items from feasibility notes)
- **Online ships as milestone 2.** Milestone 1 = `single`/`cpu` (local authority, no net path), which exercises all gameplay/physics/rules/avatar/HUD/audio code offline. This is the single most important scope decision: a non-predicted guest in continuous 1v1 will not meet the bar, and self-prediction is the gating online work.
- Take-charge / offensive fouls (collider-fragile) — defer.
- Posterizer contact-dunks + defender stun — defer; dunks are scripted captures in v1.
- Dunk bullet-time / real slow-mo — ship a cosmetic freeze-frame card only.
- Procedural **music bed** — default OFF, behind `setMusicEnabled`; reinvest effort in dribble/swish/reverb/crowd variety.
- `ambient_city` bed, chain-net audio-variant tuning beyond default, night/dusk time-of-day, floodlights, chain-net *visual* variant, replay orbit cam, heat-shimmer, multi-skin courts.
- Free-throw phase (behind `ruleset.fouls==='freeThrow'` flag; v1 ships `fouls:'possession'` with the and-1 make/miss distinction wired — it's cheap and is the AAA moment).
- Shot clock OFF by default (streetball). Remove the dead toggle from the rules UI unless wired.

### 1.3 Dribble move set (trimmed)
Ship **crossover, behind-the-back, hesitation** only. Defer spin/size-up/between-legs to polish.

### 1.4 Hero animation clips (trimmed)
Ship **jumpshot, layup, dunk, block, steal, crossover** (+ procedural locomotion). Defer floater/posted-up/celebrate.

---

## 2. Module decomposition — `src/sports/basketball/`

No shared base class. Each file copies the named golf pattern. `core.js` is the orchestrator (named `core.js`, not `bball.js`/`basketball.js`, to disambiguate).

| File | Responsibility | Key signatures |
|---|---|---|
| `core.js` | Orchestrator. Assembles subsystems, owns the single rAF tick, role routing (host/guest/local), `unmount`. Mirrors `mountGolf`. | `mountBasketball(host, cfgOrOnExit) -> unmount` |
| `court-constants.js` | **Shared** geometry/rules constants. Imported by court, physics, rules, gameplay. No duplication of `ARC_RADIUS`. | `export const COURT = {...}` (§5) |
| `scene.js` | Renderer + broadcast camera scaffold (copy golf `scene.js`). | `createScene(host) -> {scene,camera,renderer,camState,followAction,resetCameraFor,addResizeHook,dispose}` |
| `visuals.js` | Sky + golden-hour sun + PMREM IBL + fog + post-FX composer (copy golf `visuals.js`, retuned). | `applyVisuals(scene,renderer,camera) -> {envMap,sunDirection,composer,render(),dispose}` |
| `court.js` | Displaced asphalt slab + baked line-overlay texture + court colliders + zone helpers. | `buildCourt(scene,{envMap},physics) -> {hoopWorld,isBehindArc(x,z),isInbounds(x,z),dispose}` |
| `hoop.js` | Pole/glass-backboard/rim assembly + verlet nylon net + collider specs + swish. | `buildHoop(scene,{envMap},physics) -> {group,colliders,swish(ballVel),tickNet(dt),dispose}` |
| `materials.js` | Procedural PBR factories (asphalt/lines/metal/glass/fence/net) + `tickAnims`. Copy golf `materials.js`. | `asphaltMaterial(envMap)`, `glassBackboard(envMap)`, `fenceMaterial()`, `tickAnims(dt)` |
| `environment.js` | Fence, graffiti tag, backdrop skyline, clutter, billboarded crowd. Copy golf `decorateCourt`. | `decorateCourt(scene,{sunDir,envMap}) -> {tick(dt,ctx),setDensity(d),dispose}` |
| `physics.js` | cannon-es world (copy golf accumulator + `sanitize`), ball, static colliders, kinematic player capsules, make sensor. | `createPhysics() -> {world,ball,addCourtColliders,addPlayerColliders,setPlayerPose(slot,x,z,h),step(dt),makeSensor,markSafePos,dispose,BALL_RADIUS}` |
| `input.js` | Keyboard+mouse → intent; edge vs held disambiguation. | `createInput({assist}) -> {sample(dt) -> InputFrame, attach(t), detach(t)}` |
| `shot.js` | Hold-release shot meter (swing.js pattern). Runs **locally** on whoever shoots. | `createShotController({onShot,ratings}) -> {update(dt),getMeter(),press(),release(),state}` |
| `ballhandler.js` | Dribble engine: kinematic ball-anchor bounce, moves, exposure. | `createBallhandler({ratings}) -> {update(dt,world,intent),startMove(name),getExposure(),getSpeedMul(),state}` |
| `finishing.js` | Drive trigger + dunk/layup/floater decision (scripted captures in v1). | `decideFinish(world,h)`, `runDunk(world)`, `runLayup(world)` |
| `defense.js` | Defender slide tracking, contest, block, steal. | `createDefender({ratings}) -> {update(dt,world,intent),tryBlock(world),trySteal(world)}` |
| `resolve.js` | **Logit** shot-make model + contest scalar + outcome roll. | `pMake(args) -> 0..1`, `resolveShot(world)`, `contestLevel(shooter,defender) -> 0..1.4` |
| `ratings.js` | Attribute presets + badge table (multiplier/offset consumers). | `ATTRS`, `BADGES`, `badgeMul(name,tier,ctx)` |
| `heat.js` | Momentum scalar with bounded decay. | `createHeat() -> {onMake,onMiss,onStop,decay(dt),value}` |
| `rules.js` | **Pure reducer** match state machine. No Three/cannon/DOM. Host-only. | `createMatchState(cfg)`, `nextState(state,event)`, `isGameOver`, `leaderSlot`, `pointsForShot`, `cloneState`, `PHASE`, `EVENT`, `RULESET_DEFAULT` |
| `characters.js` | Procedural baller rig (extends `buildGolfer`). Geometry only. | `createBaller({character}) -> {group,parts,name,character,dispose}` |
| `animator.js` | Layered locomotion + clip state machine with event frames + IK. | `createAnimator(parts,{onEvent}) -> {set(state,opts),update(dt,locoCtx),setFromSnapshot(s),dispose}` |
| `clips.js` | Authored keyframe pose clips + event-frame metadata. | `export const CLIPS = {...}`, `sampleClip(clip,u)` |
| `ik.js` | 2-bone analytic IK (foot-lock + reach). Pure math. | `solveLeg(hip,target,thigh,shin)`, `solveFootIK(parts,ctx,dt)` |
| `ai.js` | CPU defender + ballhandler. **New** behavior controller; emits `InputFrame`. | `createAiBaller({difficulty,ratings,role}) -> {decide(dt,world) -> InputFrame}`, `AI`, `listAiDefenders()` |
| `hud.js` | DOM broadcast overlay (copy golf `hud.js` rAF-diff). | `mountBballHud(host,getters) -> unmount` (+ `.setPrompt`,`.showToast`,`.broadcast`,`.root`) |
| `audio.js` | Procedural Web Audio (copy golf `audio.js`) + mixer/duck/limiter. | `createBballAudio() -> {play(name,opts),tickAmbient(dt),setMuted,setMusicEnabled,duck,muted}`, `bballSfxFor(ev)` |
| `net.js` | `connectBasketball` (adapted from golf `connectGolf`). | `connectBasketball({code,character,onEvent,onStatus}) -> {sendInput,sendSnapshot,sendCheckReady,sendCheckBall,sendRematch,close,slot,status}` |
| `snapshot.js` | Encode/decode + interpolation buffer + guest self-prediction. | `encodeSnapshot(game) -> ArrayBuffer`, `decodeSnapshot(buf)`, `createInterpolator(delayMs)`, `createGuestPredictor()` |
| `lobby.js` | Mode/rules/character/loadout wizard (copy golf `showLobby`). | `showBballLobby(host) -> Promise<cfg|null>` |
| `character-select.js` | Live-portrait grid (copy golf `showCharacterSelect`). | `showBballSelect(host) -> Promise<character>` |
| `loadout.js` | Pool-based attribute + badge build screen. | `showLoadout(host,character) -> Promise<{attrs,badges}>` |
| `round-summary.js` | End-of-game box score (copy golf `showRoundSummary`). | `showGameSummary(host,opts) -> cleanup` |
| `settings.js` | Pause/quality/mute overlay (copy golf `settings.js`). | `mountSettings(host,handlers)` |
| `quality.js` | low/med/high presets (copy golf `quality.js`, retuned). | `applyQuality(level,handles)` |

---

## 3. Central game-state object (`GameState`)

One plain object, like golf's `game`. **Authoritative on host** (slot 0 / local); on the guest it is hydrated from snapshots + local prediction. The **rules portion is the `rules.js` reducer's serializable state** — it is embedded, not duplicated.

```js
const game = {
  // ---- role / net (local-only, NOT serialized) ----
  role: 'host'|'guest'|'local',   // derived from server-assigned slot (slot===0 ? host)
  mySlot: 0, isOnline: false,
  netMode: 'realtime'|'possession-lockstep',  // see §7.9

  // ---- authoritative match state = rules.js reducer output (serialized whole, §6) ----
  match: createMatchState(cfg),   // {phase, possessionSlot, score[2], mustClear, pendingShot,
                                  //  shotClock, fouls[2], lastBasket, seq, winner, over, ...}

  // ---- entities (world space; host-authoritative) ----
  ball: { x:0, y:1.2, z:8, vx:0, vy:0, vz:0, held: 0|1|null, // held=slot dribbling, null=free
          state: 'CARRIED'|'FREE' },
  players: [
    { x:-1, z:8, h:0, facing:0, stamina:1, base:'idle', action:null, actionT:0, flags:0 },
    { x: 1, z:8, h:0, facing:Math.PI, stamina:1, base:'idle', action:null, actionT:0, flags:0 },
  ],

  // ---- per-frame transient (host-computed; SOME serialized as snapshot.event) ----
  shot: null,            // {shooter, type, fromBeyondArc, meterErr, contest, launchTick} while airborne
  contest: 0,            // 0..1.4 defender contest at this frame
  heat: [0, 0],          // per-player momentum scalar
  event: null,           // {id, kind, slot, points, slowmo}  id-stamped one-shots (§8.6)
  audioEvents: [],       // {id, name, opts} stamped this tick → mirrored to guest (§11)

  // ---- LOCAL presentation (read by HUD via getMeter/getStamina, NOT in snapshot.r) ----
  localMeter: {phase:'idle', power:0, perfectZone:[0.86,0.96], feedback:null, contested:false},

  // ---- flags (copy golf) ----
  paused:false, postFx:true, qualityLevel:'high',
};
```

**Critical separation (resolves the meter-latency contradiction):** the **shot meter and local stamina are read from local getters**, never from the interpolated snapshot. `getMeter()` on the host reads its own sim; on the guest reads its own local input. `match.score/possession/phase/events` come from the authoritative snapshot. The meter is **never** a field inside `snapshot.r`.

---

## 4. Per-frame update order (the `core.js` tick)

Single `requestAnimationFrame(tick)`, `dt = Math.min(0.05, dtMs/1000)` (copied from golf). `paused` short-circuits to a static render. The skeleton is one function; behavior branches on `role`.

```
tick(now):
  if stopped: return
  rafId = requestAnimationFrame(tick)
  let dtMs = now - last; last = now
  dt = min(0.05, dtMs/1000)
  if game.paused: render(); return

  // (1) INPUT — always sample local input → InputFrame
  input.update(dt)
  localInput = input.sample(dt)
  shot.update(dt)                      // local meter runs for BOTH roles (instant feel)
  game.localMeter = shot.getMeter()

  if role === 'host' || role === 'local':
     // ---- AUTHORITATIVE PATH ----
     hostAccumulator += min(0.25, dtMs/1000)
     while (hostAccumulator >= SIM_DT):           // SIM_DT = 1/60 (fixed, §4.1)
        // (2) ingest inputs for THIS substep
        inputs[mySlot] = localInput
        inputs[1-mySlot] = isCpu ? ai.decide(dt, game)
                          : isOnline ? net.latestGuestInput()   // last-received
                          : neutralInput
        // (3) resolve intra-tick in FIXED ORDER (§4.2)
        stepSim(SIM_DT, inputs)
        hostAccumulator -= SIM_DT; simTick++
     // (4) snapshot on a SEPARATE accumulator
     if isOnline:
        snapAccumulator += dtMs/1000
        if snapAccumulator >= 1/SNAPSHOT_HZ:      // 18 Hz
           snapAccumulator -= 1/SNAPSHOT_HZ
           net.sendSnapshot(encodeSnapshot(game, simTick))
     // (5) render host view from authoritative world (with INTERP_DELAY ring-buffer, §7.4)
     renderState = hostRing.sampleDelayed(now)    // symmetric perception (mustFix)

  else: // role === 'guest'
     net.sendInput(localInput)                     // 30 Hz throttle
     interp = interpolator.sample(now - INTERP_DELAY_MS)   // ball + opponent
     predictor.predictSelf(localInput, dt)         // guest's OWN avatar locomotion
     renderState = mergeGuest(interp, predictor)

  // (6) PRESENTATION (both roles)
  syncBallMesh(renderState); animator0.update(dt, locoCtx0); animator1.update(dt, locoCtx1)
  hoop.tickNet(dt); materials.tickAnims(dt); env.tick(dt, {cameraPos, ballPos})
  camDir.update(dt, getCamCtx(renderState))
  audio.tickAmbient(dt); drainAudioEvents()

  // (7) RENDER — defensive, copied from golf
  try { visuals?.composer && game.postFx ? visuals.composer.render() : renderer.render(scene,camera) }
  catch { try { renderer.render(scene,camera) } catch {} }
```

### 4.1 Fixed-step (resolves the timestep mustFix)
Reuse golf's accumulator exactly: `SIM_DT = 1/60`, `MAX_SUBSTEPS = 6`. The host's authoritative sim and **all animation action-clocks** advance in fixed substeps so collision/foul/shot-release/block-window outcomes are frame-rate-stable. Render `dt` never touches gameplay timing. (Animation clips evaluate event frames per fixed substep — see §10.4.)

### 4.2 Deterministic intra-tick resolution order (mustFix)
Inside `stepSim`, resolve in **this fixed order** every substep; only use slot-0-before-slot-1 tiebreak where genuinely simultaneous:

1. Apply both players' movement intents → kinematic capsule poses (`physics.setPlayerPose`)
2. **Steals / swipes** (`defense.trySteal`)
3. **Blocks / contests** (`defense.tryBlock`; contest scalar computed here)
4. **Shot release** (drain the shooter's release edge; `resolve.resolveShot`)
5. `physics.step(SIM_DT)` → ball vs rim/backboard/floor (+ make sensor inside the substep)
6. **Rebound / possession** transfer
7. **Fouls** (block/charge resolution)
8. Build events for `rules.nextState`; fold each through the reducer; then `nextState(TICK,{dt})`

A shared RNG seeded once by the host at match start (shipped in the first snapshot) drives all probabilistic outcomes so host and guest agree.

### 4.3 Edge vs held inputs (mustFix)
Held buttons (`SHOOT` charging, `SPRINT`, `CONTEST`) coalesce — the host reads the latest. **Edge events** (shot release, pump-fake, steal-press, block-press) do **not** coalesce: they are queued per-`seq` and drained exactly once. `InputFrame` carries an edge bitfield separate from held bits.

---

## 5. Court & physics setup

### 5.1 Shared constants (`court-constants.js`)
1 unit = 1 m, +Y up, court plane y=0, hoop at +Z. **`ARC_RADIUS` lives here and is imported by court/physics/rules/gameplay — never duplicated** (a mismatch soft-locks `CLEARING`).

```js
export const COURT = {
  HALF_LEN: 14.33, WIDTH: 15.24,
  RIM_HEIGHT: 3.048, RIM_RADIUS: 0.2286,
  RIM_CENTER: { x:0, y:3.048, z:1.2 },
  BACKBOARD: { w:1.829, h:1.067, z:0.9, yBottom:2.756, depth:0.03 },
  ARC_RADIUS: 6.75,          // from RIM_CENTER; the take-it-back / 1s-2s line
  PAINT: { w:4.9, len:5.8 },
  CHECK_SPOT: { x:0, z:8.5 },
  BALL_RADIUS: 0.119,
};
export const HOOP_CENTER = COURT.RIM_CENTER;
```

### 5.2 cannon-es world (`physics.js`)
Copy golf's `CANNON.World` + accumulator `step(dt)` + `sanitize()` NaN guard + body-drain `dispose`. **The ball is the only dynamic body.** Players are kinematic capsules. Drop golf's aerodynamics (no Magnus); use gravity + light linear drag + tuned restitution.

Colliders (`addCourtColliders`, called by `buildCourt`):
- **Floor**: static plane, restitution ~0.6, friction ~0.4.
- **Backboard**: one static `CANNON.Box`, restitution ~0.5, friction ~0.3.
- **Rim**: a **ring of 12–16 small static `CANNON.Sphere`** bodies (radius ≈ rim tube) on a circle of radius `RIM_RADIUS` at `RIM_CENTER`. Sphere-ring > trimesh torus for stable rattles ("in-and-out") and avoids thin-torus tunneling. The visual torus and the sphere ring are generated from the **same `RIM_RADIUS`**.
- **Pole** (optional): static cylinder behind baseline.

`addPlayerColliders(p0,p1)` adds two kinematic cylinders for ball deflection on contests; `setPlayerPose(slot,x,z,h)` moves them each substep.

### 5.3 Tunneling resolution (resolves the 1/120-vs-1/60 conflict)
Keep `FIXED_DT = 1/60` to match golf. The thin-rim tunneling risk is handled **not** by raising substep count globally but by:
1. The **make is detected geometrically, not by a trigger body** (§5.4) — so a fast ball never needs to physically intersect a sensor.
2. The **ball-vs-rim/backboard** physical bounce uses cannon-es with the sphere-ring rim (thicker effective collider than a torus shell). If a pre-ship spike (do this before locking) shows tunneling at max shot speed, add **swept-sphere CCD against the rim/backboard only** (cheap: ray from `prevPos`→`pos` vs the few rim spheres + board box), not a global substep bump. `MAX_SUBSTEPS` already covers the 0.05 dt clamp (3 substeps worst case).

### 5.4 Make-detection sensor (`makeSensor`)
A make = ball center crossing the rim plane **downward, inside the rim circle, at sane speed**. Evaluated **inside the fixed substep** right after `world.step`:

```js
function check(prev, cur) {  // prev/cur = {x,y,z} of ball center
  const R = COURT.RIM_CENTER, RAD = COURT.RIM_RADIUS, br = COURT.BALL_RADIUS;
  const crossedDown = prev.y > R.y && cur.y <= R.y && (cur.y - prev.y) < 0;
  if (!crossedDown) return false;
  const t = (prev.y - R.y) / (prev.y - cur.y);          // interp moment Y==R.y
  const ix = lerp(prev.x,cur.x,t), iz = lerp(prev.z,cur.z,t);
  const inside = (ix-R.x)**2 + (iz-R.z)**2 < (RAD - br*0.5)**2;
  const vy = (cur.y - prev.y) / SIM_DT;
  return inside && vy < -0.5;                            // reject rim-crawl
}
```
On a true crossing: emit `EVENT.BALL_THROUGH_HOOP`. **Debounce** with a `lastMadeTick` (ignore re-crossings within ~0.4 s) to prevent double-count on rim hangs. The rim spheres + board remain real colliders so misses physically rattle and rebound; the sensor is purely the scoring oracle. A separate rim-contact flag (from the contact callback) chooses `swish` vs `rim+swish` audio.

### 5.5 Court visuals (summary)
Golden-hour single static court (huge perf win vs golf's streaming course): displaced asphalt slab (±1.5 cm noise, but **flat under the painted footprint** to kill z-fight — bake markings into the asphalt color/roughness map on the flat sub-region rather than a separate offset plane); merged hoop (~5 draws); alphaTest chain-link fence (diamond shadows); instanced backdrop skyline; billboarded crowd sprites; verlet nylon net (72 nodes, 3 iters, 1 draw). **Glass backboard** = `MeshPhysicalMaterial` transmission on high/medium, plain transparent on low (and on medium if profiling shows the transmission+shadow+main triple-traversal misses frame time). Players + ball get **faked soft contact-shadow quads** so grounding survives the no-post path. Budget: ~60–80 draws/frame, <100 k tris — fill/pass-bound, not geometry-bound.

### 5.6 Camera (1v1 framing — mustFix)
`createScene` exports `camState`; `camDir` (a `makeCameraDirector` clone kept in `core.js`) mutates only `camState.distance/height/yaw`. **Do not reuse golf's single-subject `followBall` verbatim.** Frame from the **bounding of {handler, defender, ball}**: position behind the handler on the handler→hoop line, `lookAt = weighted midpoint(handler, ball)`, and **dolly back / widen FOV when the defender approaches a frustum margin** so the defender never leaves frame. Modes: `broadcast` (default), `chase`, `shot`, `dunk`, `check`. `resetCameraFor` snaps on phase cuts. The camera is a pure function of (interpolated) sim state → needs no netcode; mode-cut triggers arrive in `snapshot.r.event`.

---

## 6. Rules reducer (`rules.js`) — the match state machine

Pure, serializable, host-only. `nextState(state,event) -> state` (clone-then-modify; never mutates input). The continuous sim emits **events**; the reducer folds them into the next match-flow state. Reads time only via a `TICK` event's `dt` (determinism). The reducer's output object **is** `game.match` and **is** the `snapshot.r` payload.

### 6.1 Phases
`PRE_GAME → CHECK_BALL → LIVE ⇄ {MADE_BASKET, CLEARING, DEAD_BALL, INBOUND, FOUL_DEAD} → … → GAME_OVER`. (`CHANGE_POSSESSION` is a **transition helper** `toChangePossession()`, NOT a phase — it tail-calls into `CLEARING` within one `nextState` so the guest never renders a half-state. The `FREE_THROW` phase exists only behind `ruleset.fouls==='freeThrow'`.)

### 6.2 Events (`EVENT`) — sim→rules contract
`TICK{dt}`, `MATCH_START{firstPossession}`, `CHECK_REQUESTED`, `CHECK_ACCEPTED`, `SHOT_RELEASED{slot,fromBeyondArc}`, `BALL_THROUGH_HOOP`, `SHOT_MISSED`, `REBOUND_SECURED{slot}`, `STEAL{slot}`, `TURNOVER{slot,reason}`, `BALL_OUT_OF_BOUNDS{lastTouchedBy,spot}`, `BALL_CROSSED_ARC{slot}`, `BALL_INBOUNDED{slot}` (escapes DEAD_BALL/INBOUND — mustFix), `FOUL_CALLED{by,on,shooting,onMake}`, `FREE_THROW_RESULT{slot,made}`, `SHOT_CLOCK_EXPIRED`, `STALL_EXPIRED`, `RESET_MATCH`. Clock-expiry events are derived inside the reducer when `TICK` drains a clock.

### 6.3 Key effect helpers (concretely defined — mustFix)
```js
function applyBasket(s, shot) { s.score[shot.slot] += shot.value;
  s.lastBasket = { slot: shot.slot, value: shot.value }; }          // seq set once at end
function pointsForShot(s, ev) { return ev.fromBeyondArc ? 2 : 1; }   // 1s & 2s

function toChangePossession(s, newOff, reason) {                     // helper, not a phase
  s.possessionSlot = newOff; s.pendingShot = null; s.ballLive = true;
  s.mustClear = true; s.clearedBy = newOff;
  if (s.ruleset.shotClock) s.shotClock = s.ruleset.shotClockSeconds;
  resetStall(s); s.phase = PHASE.CLEARING; return s;
}
function resolveAfterScore(s) {   // SINGLE win-check, called from EVERY scoring path
  if (isGameOver(s)) { s.over = true; s.winner = leaderSlot(s); s.phase = PHASE.GAME_OVER; }
}
```

### 6.4 Rules baked in (the streetball decisions)
- **Score gate through `mustClear`:** `BALL_THROUGH_HOOP` while `mustClear===true` → **no points**, `toChangePossession(other)`. ALL scoring paths (jumper/three/layup/dunk) route through this gate.
- **Make-it-take-it:** on a clean make, scorer keeps `possessionSlot`; `MADE_BASKET` pauses `deadTimer`, then re-enters `CHECK_BALL` with `mustClear=false` (the ensuing check re-spots at the arc).
- **Take-it-back:** any change of possession → `CLEARING`, `mustClear=true`; cleared only when `BALL_CROSSED_ARC` for the possessing slot.
- **Offensive rebound:** `reclearOnOffensiveRebound` ruleset flag, **default ON** (2K-ranked convention): defensive board → change of possession (+ clear); offensive board → keep ball but **must re-clear** before scoring.
- **And-1 (cheap, no FT phase):** `FOUL_CALLED{shooting:true, onMake:true}` → basket already counted in `LIVE` via the make path, foul just re-checks with offense keeping the ball (`-> CHECK_BALL`). `shooting:true,onMake:false` → offense keeps ball, check. Common foul → offense keeps ball, check. These three are distinguished even in `fouls:'possession'`.
- **Win:** `isGameOver = max(score)>=target && (max-min)>=winBy`. Deuce (10–10 plays on; 12–10 ends) falls out naturally.

### 6.5 `seq` accounting (mustFix)
Compute final `seq` **once at the end of `nextState`**: bump by 1 iff anything material changed (phase, score, possession, or mustClear). Set `lastBasket.seq` to that final value. At most one bump per call → guest dedup is sound.

### 6.6 `id` contract (mustFix)
Sim-emitted events carry monotonic `id`; the reducer's dedup guard ignores `id <= lastEventId`. **Reducer-derived events** (`SHOT_CLOCK_EXPIRED`, `STALL_EXPIRED`, the computed change-of-possession) carry **no `id`** and are exempt. A test asserts a derived event after a high-id sim event is not swallowed.

### 6.7 Ruleset defaults
`{ target:11, winBy:2, twoPointArc:true, makeItTakeIt:true, takeItBack:true, checkBall:true, reclearOnOffensiveRebound:true, shotClock:false, stall:false, madeBasketPauseS:1.0, fouls:'possession' }`.

---

## 7. Host-authoritative netcode (milestone 2)

Topology: **tennis relay shape + host-authoritative sim.** Slot 0 (host) runs the one cannon-es world; slot 1 (guest) streams input + renders interpolated snapshots; the server is a dumb relay.

```
guest(slot1) ──input(30Hz)──▶ server(relay) ──input──▶ host(slot0)
host(slot0)  ──snapshot(18Hz)─▶ server(relay) ──snap──▶ guest(slot1)
```

### 7.1 `connectBasketball` (adapt golf `net.js`, NOT tennis — there is no tennis client)
Reuse unchanged: `getOrCreateClientId`, `wsUrl()`, `RECONNECT_DELAYS`, `COLD_START`/app-ping/visibility-reconnect, the 5-state `onStatus` machine. New verbs: `sendInput`, `sendSnapshot`, `sendCheckReady`, `sendCheckBall`, `sendRematch`. Role from the `joined` slot: `isHost = (slot===0)`. Hot-path payloads forwarded opaque (no per-field reshaping on the 18 Hz path).

### 7.2 Input schema (guest→host, 30 Hz)
```js
{ type:'input', seq, t,           // u32 seq; performance.now() for RTT/jitter
  ackSnap,                        // last snapshot tick applied (host reconcile + go-live ack)
  mx, my,                         // move vector [-1,1]
  aim,                            // facing/aim delta (rad)
  held,                           // bitfield: SHOOT,SPRINT,CONTEST,...
  edge,                           // bitfield: SHOT_RELEASE,PUMP,STEAL,BLOCK (drained once each)
  rel }                           // on a release tick: {meter:0..1} (shooter's local timing)
```
~40–50 B. ~1.5 KB/s up.

### 7.3 Snapshot schema (host→guest, 18 Hz) — **binary fixed-point** (mustFix)
Commit to fixed-point ArrayBuffer now (nearly free, halves parse cost, ws supports binary). Positions ×100 cm as int16, yaw ×1000 rad as int16, anim enum + **anim normalized-phase** (u8) per player.
```
header:  tick(u32), t(f32), ackInput(u32)
ball:    x,y,z (int16 cm), vx,vy,vz (int16 cm/s), held(i8)
players[2]: x,z (int16), yaw(int16), animEnum(u8), animPhase(u8), flags(u8)
r (rules): phase(u8), poss(i8), score0,score1(u8), flags(u8: mustClear|gamePoint|over),
           shotClock(int16 deciseconds or 0xFFFF=none),
           event(u8 kind), eventSlot(i8), eventId(u8)   // latched 2 snapshots
```
~80–120 B. ~2 KB/s down. **Control messages stay JSON.** `r` (rules) rides the high-rate snapshot stream so the guest always sees a ticking clock and current score — resolving the "broadcast only on seq change vs ticking clock" contradiction by putting clocks/score in the position stream and using `eventId` dedup for transients.

### 7.4 Interpolation, prediction, symmetric perception
- **Guest** buffers snapshots and renders at `now - INTERP_DELAY_MS` (110 ms ≈ 2 snapshot intervals). Ball uses **velocity-aware extrapolation** up to `EXTRAP_MAX_MS=120` on starvation; players **hold-last**. Clock-skew via EWMA of `(snap.t - localRecvT)`.
- **Guest self-prediction (v1-online required, mustFix):** predict ONLY the guest's own avatar **locomotion** immediately from local input; reconcile each snapshot (`err>0.8m`→snap, else `lerp(pred, auth, 0.2)`). No ball/shot/steal/foul prediction.
- **Symmetric perception (mustFix):** the **host also renders INTERP_DELAY in the past** via a ring-buffer of authoritative states (`hostRing.sampleDelayed`). Without this the host wins every contested moment and the game feels rigged to the guest. This replaces the optional `HOST_FAIRNESS_DELAY` idea.

### 7.5 Shot-meter authority (resolves the desync)
The meter UI runs locally on whoever shoots (zero-latency feel). The **make/miss is host-authoritative**. The shooter's release sends `rel.meter` inside its `InputFrame` edge; the host honors that locally-evaluated timing deterministically in `resolve.resolveShot` (it does **not** trust a "made" claim — only the timing value). The shooter plays the release **animation** immediately (cosmetic, non-committal — no "PERFECT" flash before the host confirms); the ball arc and the authoritative `MAKE`/`MISS` arrive via `snapshot.r.event`. Contest is trivially authoritative (host knows both positions every substep).

### 7.6 Check-ball fairness (mustFix)
The host must not act on `phase=LIVE` until it estimates the guest has rendered LIVE: hold the host's own go-live input until the guest's `ackSnap` confirms the LIVE snapshot was applied (or delay host go-live by `INTERP_DELAY`). Check transition is an explicit confirmation flow (`check-ready` → `check-ball` → LIVE in the snapshot stream), never a silent host-gated position check.

### 7.7 Reconnect / host-drop policy (mustFix)
The authoritative world lives on the host peer, so golf's server-state reconnect does not apply. Choose **server-cached last-known state**: the host piggybacks a minimal authoritative snapshot (score, possession, phase, mustClear, ball pos/vel, both transforms) to a **server-held `room.lastState`** every Nth snapshot; it survives `ROOM_TTL_MS`. On host reconnect/reclaim the server replays `lastState` so the reclaimed host restores; on guest (re)join the server forwards `lastState` immediately. **`GAME_OVER` is also sent as a sticky, server-arbitrated `match-complete` control message** (like golf) so a guest reconnecting across game-over still learns the result.

### 7.8 Latency over TCP
WebSocket is TCP (ordered/reliable, head-of-line blocking). `INTERP_DELAY` is the primary defense; ball extrapolation covers in-flight stalls; coalesced bursts after a stall catch up smoothly (always render at `now-delay`). **`socket.setNoDelay(true)` on every accepted server socket** (mustFix — Nagle+delayed-ACK adds ~40 ms). No shot lag-compensation/rewind (over-engineering for TCP at these rates).

### 7.9 Lockstep floor (mustFix — build in v1, not "someday")
Wire `netMode='possession-lockstep'` alongside `'realtime'`. Same server branch, same wire types. In lockstep the sim runs LIVE only during an active possession from a check-ball handshake; between possessions it's effectively turn-based (dead-ball/check already pause the sim). This is a host-loop change only and is the **shippable floor** if realtime feel misses the bar.

---

## 8. Server branch (`server/index.js`)

### 8.1 Room constructor (clean, no golf cruft)
Replace the generic literal at line 181 with a `sport`-dispatched constructor:
```js
function newBasketballRoom(key, sport, code) {
  return { key, sport, code, players:[null,null], started:false,
           checkReady:[false,false], rematch:[false,false],
           lastState:null,           // server-cached authoritative keyframe (§7.7)
           gcAt:0 };
}
// in join: room = sport==='golf' ? newGolfRoom(...)
//                : sport==='basketball' ? newBasketballRoom(...)
//                : <existing generic literal for tennis>;
```
Host is always slot 0 (existing "lowest empty slot" assignment guarantees it). Reclaim/heartbeat/`ROOM_TTL_MS`/`opponent-left`/`opponent-rejoined` are generic and reused unchanged. `setNoDelay(true)` on accept.

### 8.2 Dispatch branch (insert next to tennis at ~line 237)
```js
if (room.sport === 'basketball') {
  if (msg.type === 'input') {
    if (ws.slot !== 1) return;                                  // guest only
    broadcast(room, { type:'input', input: msg.input }, ws);    // → host
  } else if (msg.type === 'snapshot') {
    if (ws.slot !== 0) return;                                  // host only
    if (msg.keyframe) room.lastState = msg.keyframe;            // cache for reconnect
    broadcast(room, { type:'snapshot', snapshot: msg.snapshot }, ws); // → guest
  } else if (msg.type === 'check-ready') {
    if (ws.slot !== 1) return; room.checkReady[1] = true;
    broadcast(room, { type:'check-ready', slot:1 }, ws);
  } else if (msg.type === 'check-ball') {
    if (ws.slot !== 0) return; room.checkReady = [false,false];
    broadcast(room, { type:'check-ball' }, ws);
  } else if (msg.type === 'match-complete') {                   // sticky game-over (§7.7)
    if (ws.slot !== 0) return; room.matchComplete = msg.result;
    broadcast(room, { type:'match-complete', result: msg.result }, ws);
  } else if (msg.type === 'rematch') {
    room.rematch[ws.slot] = true;
    if (room.rematch[0] && room.rematch[1]) { room.rematch=[false,false];
      broadcastAll(room, { type:'rematch' }); }
    else broadcast(room, { type:'rematch-pending', slot: ws.slot }, ws);
  }
  return;
}
```
On guest (re)join (in the `join` path), if `room.lastState` exists, `send(ws, {type:'snapshot', snapshot: room.lastState})` immediately.

### 8.3 Message tables

**Client → Server**
| type | from | relayed to | payload |
|---|---|---|---|
| `join` | both | — | `{sport:'basketball',code,clientId,character}` |
| `input` | guest | host | `{input:InputFrame}` |
| `snapshot` | host | guest | `{snapshot, keyframe?}` |
| `check-ready` | guest | host | — |
| `check-ball` | host | guest | — |
| `match-complete` | host | guest | `{result}` |
| `rematch` | both | — | — |
| `ping` | both | — | `{t}` |

**Server → Client**
| type | to | payload |
|---|---|---|
| `joined` | joiner | `{slot,code,sport,reclaimed}` |
| `start` / `opponent-rejoined` / `opponent-left` | both | — |
| `input` | host | `{input}` |
| `snapshot` | guest | `{snapshot}` |
| `check-ready` | host | `{slot:1}` |
| `check-ball` | guest | — |
| `match-complete` | guest | `{result}` |
| `rematch` / `rematch-pending` | both | `{slot?}` |
| `pong` / `error` | — | — |

---

## 9. Gameplay math (`resolve.js`) — logit shot model (mustFix)

Replace the multiplicative `P_make` + `GREEN_OPEN_FLOOR` hack with a **log-odds model** (no discontinuity, no contest dead-zone):

```js
function pMake({ type, meterErr, isGreen, contest, rating, rangeDeficit, stamina, heat, badges }) {
  const greenHalf = effGreenHalf(type, contest, stamina, badges);
  const e = Math.max(0, Math.abs(meterErr) - greenHalf);     // forgiven inside green
  const timing = isGreen ? 1 : Math.exp(-(e*e)/(2*0.16*0.16));
  let logit = B_TYPE[type]
            + W_TIMING  * timing
            + W_CONTEST * (-contest)                          // contest 0..1.4, monotonic
            + W_RATING  * (relevantRating(type,rating) - 50)
            + W_RANGE   * (-rangeDeficit)
            + W_STAM    * (stamina - 1)
            + heat;                                           // heat in log-odds
  logit += badgeLogit(badges, type, contest, fromBeyondArc); // additive offsets
  return clamp(1/(1+Math.exp(-logit)), 0.02, 0.985);
}
```
Calibrate weights so: **open green three ≈ 0.83, contested green three ≈ 0.30, contested bad-timing three < 0.10** — all falling out of the sigmoid with no floor. `contestLevel(shooter,defender)` returns 0..1.4 from closeout distance × hands-up × facing × airborne, fed live to the HUD so the green band visibly shrinks. **A live debug overlay printing every `pMake` term is a hard requirement** (copy golf's `mountDebugOverlay`, `?debug`-gated).

Badges are additive logit offsets / multiplier consumers from `ratings.js`; ship ~6 (Deadeye, Shifty, RangeExtender, RimProtector, Clamps, Unpluckable). `heat.js` is bounded `[-0.4, +0.8 logit]`, decays per possession (`*0.92`); run a worst-case-run-to-11 simulation to confirm no snowball before shipping the make-it-take-it + heat combo.

---

## 10. Avatars & animation

### 10.1 Rig (`characters.js`)
`createBaller` extends `buildGolfer`: same proportions, `roundedBox` meshes, `PRESETS` color schema. Adds: a `root` that **translates + yaws** (vs golf's static tee), per-hand `ballAnchor` empties (reparentable ball, like golf's `gripPivot` holds the club), `ankle` groups for foot-lock IK, independent `headGroup.rotation.y`. **v1 cut:** skip the wrist group and neck look-at initially (golf gets by on `headGroup.rotation` only); add wrists only if follow-through reads poorly. Geometry and animation stay in **separate modules** so a later glTF swap fits behind the same `parts`/`createAnimator` contract.

### 10.2 Animator (`animator.js`) — v1 simplification
Ship **action-owns-whole-body cross-fade** (golf's model) for v1. Defer per-joint masked layering (the dribble-bounce-during-jog blend) unless it proves necessary — it is the biggest net-new complexity and bug surface. Procedural locomotion (`evalLocomotion`: idle/jog/sprint/slide/backpedal) runs as the base; one-shot action clips cross-fade over it.

### 10.3 Clips (`clips.js`)
Author the 6 hero clips (jumpshot, layup, dunk, block, steal, crossover) as keyframed pose arrays + event-frame metadata. `sampleClip(clip,u)` reuses golf's `lerpPose` with N keys. **Build a dev pose-scrubber** (`?scrub` URL param steps `actionT`) to tune clips without a Blender pipeline — treat the ~6-clip authoring as critical-path, not a footnote.

### 10.4 Animation timing IS gameplay (host-authoritative)
A shot/layup/dunk resolves only when its `release` event frame fires. Event frames are evaluated **per fixed substep** (§4.1) so release/block-window fire on deterministic substep boundaries regardless of host FPS. On `release` the host detaches the ball (`CARRIED`→`FREE`), spawns velocity from the latched meter result + contest, decides make/miss via `resolve.pMake`. **The guest never resolves gameplay** — it plays the matching clip visually from `snapshot.animEnum`/`animPhase` and trusts the discrete outcome in `snapshot.r.event` (so a coarse-interpolated guest that didn't render the contact frame still gets correct VFX/audio).

### 10.5 Ball authority during dribble (mustFix — pick one)
The dribble ball is **host-authoritative**: include ball XZ + `dribbleY` in the snapshot (a few bytes) so both clients render the same ball, and **all steal-vulnerability windows are host-side sim state**, broadcast. The guest does NOT locally phase its own dribble ball into a gameplay outcome. (`CARRIED` kinematic on host, rendered from snapshot on guest; `ballToFree`/`ballToHand` handoff at `release`/steal happens host-side.)

### 10.6 IK (`ik.js`) — layer precedence (mustFix)
2-bone analytic IK, foot-lock anti-skate (flat court → `footY=0`, free vs golf's heightfield). **IK foot-lock is DISABLED for any leg the active clip's mask owns AND whenever `ctx.grounded===false`** — so jumpshot/dunk/layup legs are clip-driven, not floor-locked (kills the "IK stomps the jump into the floor" bug). Resolution order per joint: procedural-base → clip → IK (feet only, when grounded & not clip-owned).

### 10.7 Shadows (mustFix)
**One faked blob/contact shadow per player** (blurred radial alphaMap quad), NOT a full shadow-casting humanoid in the PCFSoft pass, at 6–12 m. Saves the entire second-humanoid shadow pass. Set a draw-call budget + fallback ladder before crowd is added.

### 10.8 AI (`ai.js`)
**New** per-frame behavior controller emitting the same `InputFrame` as `input.sample`. Only the Gaussian-jitter-by-difficulty idea ports from `createAiGolfer`. Personas/difficulties scale `reactDelay`, slide error, contest miss, meter error, steal aggression. Runs on the host only.

---

## 11. HUD & audio

### 11.1 HUD (`hud.js`)
`mountBballHud(host, getters)` copies golf's rAF-diff overlay with a `last` cache; every DOM write gated by a diff. Getters: **`getState()`** (one snapshot: score/target/gamePoint/possession/phase/mustClear/event/conn) + **`getMeter()`** and **`getStamina()`** as **separate local getters** (host: own sim; guest: local input prediction — resolves the meter-latency bug; meter is never in the snapshot). `getPlayers()`, `getBadges(slot)` are stable lists.

Components: broadcast **score bug** (score-to-11 + possession dots + GAME POINT slot + animated number roll on change), **streetball prompt band** auto-derived from `phase`/`mustClear` (CHECK BALL / CLEAR IT / MAKE IT TAKE IT) with `.setPrompt` override, **vertical shot meter** (hold-release fill + shrinking contested green band + feedback flash, reusing golf's fill/zone diff-render), **badge rail + badgePop**, **stamina bar**, **connstatus chip + disconnect banner** (verbatim golf DOM, driven by `s.conn`), **toast router + lower-third** fired from id-stamped `event` (dedup by `eventId`), and a **loose-ball indicator** for `possession:-1`. Transient events are **id-stamped and latched 2 snapshots** so coalescing never drops a toast and dedup prevents doubles.

### 11.2 Audio (`audio.js`)
Copy golf's `createAudio` shape (lazy `ensureCtx` + gesture-unlock, baked white/pink/brown buffers, `NAMES` allowlist, managed loops, `tickAmbient`). Add a small mixer: `master → {sfx,court,crowd,music}` busses → **`duckGain`** (sfx+court only) → **limiter** (`DynamicsCompressorNode`). **Whistle/swish/buzzer route post-duck (bypassing duckGain) so the sidechain ducks gameplay WITHOUT ducking the featured sound** (mustFix). Add **one ConvolverNode reverb** (impulse baked from the white buffer — near-free, biggest perceptual jump) and **per-voice StereoPanner** from court-X position (mustFix).

Hero sounds tuned by ear: **dribble** (broadband click transient + damped 150–220 Hz cavity pock, impact-driven pitch/gain, 60 ms debounce), **chain swish** (4–8 randomized inharmonic metallic pings + noise transient, not static bandpass), **buzzer** (4 detuned saws → WaveShaper → resonant bandpass), plus rim_clank/backboard/sneaker/body_contact/whistle/cheer/and_one, and **block + steal** (signature 1v1 moments — mustFix). Crowd bed = pink-noise loop with an excitement `level` model (≥3–4 distinct reaction recipes). **Music bed cut from v1** (default OFF behind `setMusicEnabled`).

Host-authoritative event firing: host fires `play()` directly; guest replays `game.audioEvents` (id-stamped, mirrored in the snapshot side-channel). **Dribble is guest-local-predicted** from interpolated ball height **AND** deduped against host bounce events within an ~80 ms window (suppress the predicted one if a host event arrives). Wire stings to the SAME id-stamped `event` the HUD toasts use (one call site).

---

## 12. Integration edits (outside `src/sports/basketball/`)

**`src/main.js`** — clone `startGolf`:
```js
async function startBasketball() {
  const { showBballLobby } = await import('./sports/basketball/lobby.js');
  const cfg = await showBballLobby(host);
  if (!cfg) return showMenu();
  clearHost();
  const { mountBasketball } = await import('./sports/basketball/core.js');
  unmount = mountBasketball(host, { ...cfg, onExit: showMenu });
}
// tile dispatch:  if (b.dataset.sport === 'basketball') startBasketball();
// dev deep-link:  if (params.get('sport')==='basketball' || params.get('bball')==='1') bootDirectBasketball();
```

**`src/index.html`** — add tile:
```html
<button class="tile tile--basketball" data-sport="basketball">
  <span class="tile__emoji">🏀</span>
  <span class="tile__name">Blacktop</span>
  <span class="tile__sub">1v1 half-court · first to 11</span>
</button>
```

**`src/style.css`** — tile gradient + all `.bb-*` HUD/UI CSS (BEM namespace mirroring `.golf-hud__*`). Reuse golf's `.btn`, `.screen`, `.lobby*`, `.mode-tile*`, `.code-card`, `.code-input`, `.round-tile` (renamed copy for the rules step). Inject character-select CSS via the same `ensureStyle`/`STYLE_ID` mechanism.
```css
.tile--basketball{ background:linear-gradient(150deg,#e8852b 0%,#7a3b12 60%,#241008 100%); }
```

**`server/index.js`** — add `newBasketballRoom` + dispatch the room constructor by sport + insert the `room.sport==='basketball'` relay branch (§8) + `setNoDelay(true)` on accept + forward `room.lastState` on guest join.

---

## 13. Disposal / cleanup (`unmount`, copied from golf)

```js
return function unmount() {
  stopped = true;
  cancelAnimationFrame(rafId);
  input.detach(window);
  try { unmountHud?.(); } catch {}
  try { net?.close(); } catch {}
  try { settingsUi?.unmount(); } catch {}
  try { court?.dispose(); hoop?.dispose(); env?.dispose(); } catch {}
  try { animator0?.dispose(); animator1?.dispose();
        baller0?.dispose(); baller1?.dispose(); } catch {}
  try { physics.dispose(); } catch {}        // while(world.bodies.length) world.removeBody(...)
  try { visuals?.dispose(); } catch {}       // composer + all passes + PMREM RT
  try { scene.dispose(); } catch {}          // removeEventListener('resize') + renderer.dispose + canvas removal
  try { audio.setMuted(true); audio.stopAllLoops?.(); } catch {}
  delete host._audio; delete host._bballController;
  host.innerHTML = '';
};
```
Dispose every CanvasTexture (asphalt/lines/fence/graffiti/net), every geometry/material, the composer + PMREM render target, and explicitly stop crowd/music loops to free the audio thread.

---

## 14. Reused golf utilities (named)

| Golf source | Strategy | Taken |
|---|---|---|
| `golf.js` | Pattern-copy | normalize-config, `?debug` overlay, rAF skeleton + `dt=min(0.05,..)`, paused static render, defensive composer→renderer fallback, `host._xController` test surface, `makeCameraDirector` |
| `scene.js` | Copy + adapt cam | renderer/camera/resize-hook, `camState` smoothing (`1-exp(-k*dt)`), `resetCameraFor` |
| `physics.js` | **Copy core** | accumulator `step(dt)` + `FIXED_DT=1/60`/`MAX_SUBSTEPS=6`, `sanitize()` NaN guard, body-drain `dispose`, `markSafePos` |
| `swing.js` | Pattern-copy | meter state machine, `getMeter()` shape, `attach/detach`, gamepad/key poll |
| `hud.js` | Pattern-copy | `mountHud(host,getters)`, pull getters, rAF diff vs `last`, `.showToast()`/`.set*()` |
| `audio.js` | Pattern-copy | `createAudio()` envelopes, baked noise buffers, managed loops, `tickAmbient`, gesture-unlock |
| `net.js` | **Adapt `connectGolf`** | `wsUrl()`, clientId+sessionStorage reclaim, `RECONNECT_DELAYS`, status machine, app ping/pong, visibility-reconnect |
| `ai.js` | Idea only | Gaussian-jitter-by-difficulty + emit-same-shape-as-human (new behavior controller) |
| `characters.js` | Extend `buildGolfer` | bone hierarchy, `roundedBox`, `PRESETS`, `gripPivot`→`ballAnchor` pattern, `lerpPose` |
| `lobby.js` + `character-select.js` | Copy lobby / clone select | DOM-swap wizard; live mini-Three portrait |
| `round-summary.js` / `settings.js` / `quality.js` | Copy + retune | summary overlay; pause/mute/quality; presets |

---

## 15. Testing

- `tests/basketball-rules.test.js` — pure `nextState` reducer (node:test): make-it-take-it keeps possession & no re-clear after check; change-of-possession requires take-it-back (basket before clear = no points); deep shot = 2; first-to-11 win-by-2 deuce; reducer purity (input not mutated); event id dedup; **derived event after high-id sim event is NOT swallowed**; offensive-rebound re-clear; and-1 make/miss distinction.
- `tests/basketball-server.test.js` — clone `server.test.js` harness (`bootServer`/`makeClient`/`waitFor`): two clients join `sport:'basketball'`, slots 0/1, both see `start`; **negative** relay guards (guest `snapshot` dropped, host `input` dropped); input relay guest→host; snapshot relay host→guest payload intact; check handshake; `match-complete` sticky; rematch counter; reconnect reclaim → `opponent-rejoined` + `lastState` replay.
- Playwright `?sport=basketball` smoke harness — boot canvas, sample pixels for blank-render (mirrors existing `tests/*.mjs`).
- HUD unit test — mount `mountBballHud(div,{getState:()=>fake,...})`, mutate `fake`, step `tick()`, assert `textContent`/classes (no server/Three).
- Pre-ship **physics spike** (not a test, a gate): prototype sphere-ring rim vs real shot speeds at `1/60`/`MAX_SUBSTEPS=6`; measure tunneling + rattle; add swept-sphere CCD vs rim/board only if needed. Pin the result before locking the architecture.

CI already runs `node --test tests/*.test.js` + `npm run build` — these files need no config change.

---

## 16. Implementation order

1. `court-constants.js`, `rules.js` + `basketball-rules.test.js` (green before any Three.js).
2. `scene.js`/`visuals.js`/`court.js`/`hoop.js`/`materials.js` + Playwright blank-render smoke; **physics spike** (rim).
3. `physics.js` (accumulator + colliders + make sensor) wired to `rules.js` events.
4. `characters.js` + `animator.js` (whole-body cross-fade) + `clips.js` (6 hero clips) + `ik.js` foot-lock + pose-scrubber.
5. `input.js`/`shot.js`/`ballhandler.js`/`finishing.js`/`defense.js`/`resolve.js` (logit) + `ratings.js`/`heat.js` + **debug overlay** → playable **single/cpu** (Milestone 1 complete, fully offline).
6. `hud.js`/`audio.js`/`lobby.js`/`character-select.js`/`loadout.js`/`round-summary.js`/`settings.js` + main.js/index.html/style.css wiring.
7. `ai.js` behavior controller.
8. **Milestone 2 (online):** `net.js` `connectBasketball` + `snapshot.js` (binary encode + interp + self-prediction + host ring-buffer) + server branch + `basketball-server.test.js`. Ship pure-interpolation + lockstep floor first; layer self-prediction; A/B feel.

---

## 17. Risk register (top items + mitigation)

| Risk | Mitigation (in this spec) |
|---|---|
| Real-time feel over TCP (#1 risk) | INTERP_DELAY 110 ms, ball extrapolation, **lockstep floor wired in v1** as shippable fallback, ship single/cpu first |
| Guest movement unplayable | **Guest self-prediction of own locomotion is v1-online required**, not optional |
| Host advantage | **Host renders INTERP_DELAY in the past** (symmetric perception ring-buffer) |
| Host drop kills the sim | Server-cached `room.lastState` keyframe + sticky `match-complete`; host-reclaim restores |
| Thin-rim tunneling | Sphere-ring rim + geometric make sensor; CCD vs rim/board only if spike shows it |
| Meter feels laggy on guest | Meter is a **local getter**, never in the snapshot; outcome host-authoritative |
| pMake dead-zone / floor cliff | **Logit model**, no `GREEN_OPEN_FLOOR`, monotonic contest term |
| Audio ducks its own feature | Whistle/swish/buzzer routed **post-duck** |
| Arc mismatch soft-locks CLEARING | `ARC_RADIUS` is a single shared `court-constants.js` import |
| Clip authoring underestimated | 6 hero clips only + pose-scrubber, treated as critical path |

