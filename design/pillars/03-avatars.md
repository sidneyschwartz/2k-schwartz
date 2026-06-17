# Pillar 3 — Player Avatars, Animation & Game Feel

> Build both players as procedural bone-hierarchy humanoids by EXTENDING the existing golf `characters.js` rig (THREE.Group joints driven by direct rotation, no GLB/skinning), not glTF — it ships zero asset bytes, already matches the art style, and the team has tooling for it. Replace golf's 6-pose tween with a proper additive-blend animation state machine (`createBaller`) whose clips are authored as keyframed pose-target arrays and driven procedurally for locomotion (jog/sprint/dribble/slide) and IK foot-lock. Animation TIMING is gameplay-authoritative: each shot/layup/dunk clip exposes a `releaseFrame` and the sim resolves the shot ONLY when that frame fires, exactly like golf's swing phase emits `onShot`. Ball-in-hand is a parent-attachment to a hand bone until the release frame hands the ball off to the cannon-es free-body. The realistic ceiling is "stylized-readable AAA silhouette + crisp gameplay timing," not motion-captured fluidity.

# Pillar: Player Avatars, Animation & Game Feel

This pillar owns the two on-court humanoids, every pose they hit, how locomotion couples to the ball, and how animation timing drives the shot/steal/block/foul resolution. It is the visible surface of the host-authoritative sim: the host runs the truth, but **both** clients render avatars from the same animation system off either local input (host's own player) or interpolated snapshots (the remote player).

Everything here is an EXTENSION of the golf `characters.js` rig + `swing.js` phase machine. Names below map 1:1 onto golf patterns so an engineer can copy-paste-mutate.

---

## 0. Hard recommendation up front: procedural rig, NOT glTF

**Use a procedural bone-hierarchy humanoid built exactly like `characters.js`'s `buildGolfer`** (a tree of `THREE.Group` "bones" with `roundedBox`/sphere meshes, posed by writing `.rotation.{x,y,z}` on the joint groups). Do **not** introduce skinned glTF meshes.

Justification grounded in the codebase:

1. **Zero asset pipeline.** `audio.js` is "fully procedural Web Audio, NO asset files"; `characters.js` builds faces with `OffscreenCanvas`; grass/terrain are procedural. The whole project's bias is *generate, don't ship bytes*. A glTF baller needs a rigged + skinned mesh + a clip library (idle/run/dribble/jumpshot/dunk/...) authored in Blender, plus `THREE.AnimationMixer`, plus `GLTFLoader`, plus a loading state the menu/lobby don't currently have. That is the single largest scope/perf/asset risk in the whole basketball effort and it buys fluidity we cannot hit anyway in a browser budget shared with the court, crowd, and ball physics.
2. **The rig already exists and is proven.** `buildGolfer` already produces an anatomically-proportioned jointed humanoid (hips → torsoPivot → armsPivot → per-side shoulder/elbow/hand; hips → per-side leg/knee/foot; neck/head). Brunson is *already a basketball player preset* in `PRESETS`. We extend, we don't reinvent.
3. **Two players, half-court, 6–12 m camera.** At that distance the stylized 2K/Wii silhouette reads fine (the file literally notes "matches the stylized look of 2K/Wii Golf"). We do not need finger articulation.
4. **Skinning cost is real.** Two skinned meshes + `AnimationMixer` per frame, plus shadow passes (PCFSoft), on top of cannon-es, on the same rAF budget golf already fills, is a worse perf story than ~30 matrix writes/frame for two rigs.

**The cost we accept:** no smooth skin deformation at joints (elbows/knees show the same chamfered-box seam golf has). We hide it with the same `roundedBox` chamfer + a slight joint-cap sphere (already done for shoulders). This is the realistic ceiling — see §11.

What we MUST add beyond golf's rig: more DOF (wrists, a ball-carry hand anchor, neck yaw, a root that translates/rotates around the court instead of standing on a tee), a real blend/transition system (golf only cross-fades between 6 discrete poses), procedural locomotion, and IK foot-lock.

---

## 1. Module map (new files, golf-pattern-named)

```
src/sports/basketball/
  characters.js     // createBaller({character}) -> {group, root, parts, name, character}
                    //   (the RIG ONLY — bones + meshes, copied/extended from golf characters.js)
  animator.js       // createAnimator(parts, {onEvent}) -> {set(state,opts), update(dt, locoCtx), pose, event hooks}
                    //   THE STATE MACHINE. Owns clips, blending, IK, ball-hand transform.
  clips.js          // authored pose-target keyframe data + per-clip event frames (releaseFrame etc.)
  ik.js             // 2-bone analytic IK (foot-lock, reach-to-ball) — pure math, no THREE deps except Vector3
  playerctl.js      // local player input -> intent (the human controller; sibling of swing.js)
  defenderAI.js     // CPU defender -> intent, SAME shape as playerctl (copy ai.js pattern)
```

`animator.js` is the heart of this pillar. `characters.js` is "just geometry." Keeping them split mirrors golf, where `buildGolfer` (geometry) and the `POSES`/`update` tween (animation) live in one file but are cleanly separable — we split them because basketball animation is ~5x the complexity.

The basketball orchestrator (`basketball.js`, another pillar's file) will, per player, do exactly what `golf.js` does with the golfer:

```js
const baller = createBaller({ character: cfg.character.id });
scene.add(baller.group);
const anim = createAnimator(baller.parts, { onEvent: handleAnimEvent });
// in tick: anim.update(dt, locoCtx);  // locoCtx = {velocity, facing, hasBall, grounded, ...}
```

---

## 2. The rig: `createBaller` (extends `buildGolfer`)

Reuse `buildGolfer`'s skeleton verbatim, then add the joints basketball needs. Keep the same proportion math (`headSize = H/6.5`, leg/arm fractions) and the `roundedBox` helper.

### 2.1 New / changed joints vs golf

| Joint group | Golf has it? | Basketball change |
|---|---|---|
| `root` (Group) | yes (static at tee) | now **translates + yaws** every frame to move the player around the court. Position = sim body XZ; rotation.y = facing. |
| `hips` | yes | gains a vertical bob + pelvis yaw/tilt offset channel for dribble/slide weight-shift |
| `torsoPivot` | yes (spine twist for swing) | reused for gather/shot lean + crossover counter-rotation |
| `armsPivot` | yes (both arms together) | **demoted** — basketball needs independent arms; keep for symmetric idle but drive shoulders directly |
| per-arm `shoulder`,`elbow`,`hand` | yes | add a **`wrist`** Group between elbow's `hand` and the palm (shot follow-through snap + dribble flick) |
| `ballHand` anchor | no | **NEW**: an empty `THREE.Group` parented under the right `hand` (and a left one) at the palm center. The ball mesh re-parents here when carried. See §8. |
| per-leg `knee`,`foot` | yes | add an **`ankle`** Group (foot-plant IK target) and an `ankleIKTarget` world anchor |
| `neck`/`headGroup` | yes | add independent `headGroup.rotation.y` look-at (track ball/hoop) |

Add a `gripPivot`-style empty under each hand named `parts.handR.ballAnchor` / `parts.handL.ballAnchor`. Golf already does this exact trick for the club (`gripPivot` parented under `armsPivot` holds the club). We're doing the same with the ball, but per-hand and reparentable.

### 2.2 Exposed `parts` (the animator writes only these)

```js
return {
  group: root,
  parts: {
    root, hips, torsoPivot,
    shoulderL, elbowL, wristL, handL: { group, ballAnchor },
    shoulderR, elbowR, wristR, handR: { group, ballAnchor },
    hipL, kneeL, ankleL, footL,   // ankle is new
    hipR, kneeR, ankleR, footR,
    neck, headGroup,
    // precomputed lengths for IK:
    L: { thigh, shin, upperArm, foreArm }, H, headSize,
  },
  name, character,
};
```

Preset additions to `PRESETS` (reuse golf's color schema; add body-type + signature tags):

```js
brunson: { ...existing,
  bodyType: 'guard',          // 'guard'|'wing'|'big' -> scales reach/jump/slide width
  jumpshotStyle: 'set',       // -> picks a clip variant in clips.js
  dribbleStyle: 'low',        // -> dribble apex height + hand timing
  signature: { crossover: 'hard', stepback: true },
}
```

`bodyType` also nudges `shoulderWidth`/`build`/`height` so a "big" reads visibly bigger — drives both look and the sim's reach/contest radius (handoff to the rules pillar).

---

## 3. Animation state machine: `createAnimator`

This is the **expanded `swing.js` + golf-character-tween fused together**. Golf's character animation is a 6-state pose cross-fade (`STATES`, `POSES`, `TIMING`, `setSwingState`, `lerpPose`). Basketball needs: many more states, *additive layering* (a dribble bounce that survives while you jog), per-clip *event frames*, and procedural locomotion underneath authored clips. Same core idea, more machinery.

### 3.1 States

```
LOCOMOTION (procedural, looping):
  idle, dribble_idle, jog, sprint, defensive_slide, backpedal, jump_landing
ACTIONS (authored clips, mostly one-shot):
  crossover, between_legs, behind_back, hesitation,        // dribble moves
  drive_gather, jumpshot, layup, dunk, floater,            // scoring
  pump_fake, pass,
  block, steal_reach, contest, rebound_jump,               // defense
  bump_react_L, bump_react_R, posted_up,                   // contact
  celebrate, dejection, check_ball                          // dead-ball
```

### 3.2 State container (copy `swing.js`'s `state` object shape)

```js
const state = {
  base: 'idle',           // current locomotion base
  action: null,           // current one-shot action clip or null
  actionT: 0,             // seconds into the action clip
  actionClip: null,       // resolved clip object from clips.js
  blendOut: 0,            // remaining cross-fade time into base
  prevPose: null,         // captured pose at transition (== golf's fromPose)
  // procedural channels:
  dribblePhase: 0,        // 0..1 ball-bounce cycle, advanced by speed
  strideClock: 0,         // foot cadence
  facing: 0, lookYaw: 0,
  hasBall: false, grounded: true,
};
```

### 3.3 `set(stateName, opts)` — the `setSwingState` analog

```js
function set(name, opts = {}) {
  if (LOCO.has(name)) { state.base = name; return; }    // locomotion = just switch base
  if (state.action === name) return;
  state.prevPose = readPose(parts);                     // golf's readPose()
  state.action = name;
  state.actionClip = CLIPS[name];
  state.actionT = 0;
  state.actionSpeed = opts.speed ?? state.actionClip.speed ?? 1;
  state.eventsFired = new Set();                         // for releaseFrame de-dupe
}
```

This is intentionally the same contract as `setSwingState(next)`: capture current pose, point at the target, reset the clock. The difference is basketball has a **locomotion base that keeps running underneath** the one-shot action, and clips fire **events** at specific normalized times.

### 3.4 `update(dt, locoCtx)` — the tween + procedural + IK + events pump

Pseudo-code (mirrors golf `update(dt)` but layered):

```js
function update(dt, ctx) {
  // ctx = { velocity:Vec3, speed, facing, hasBall, grounded, ballState, lookTarget }
  // 1. BASE LAYER — procedural locomotion writes the whole-body pose
  const basePose = evalLocomotion(state.base, ctx, dt);   // returns a full pose object

  // 2. ACTION LAYER — authored clip, sampled + blended OVER base
  let pose = basePose;
  if (state.action) {
    state.actionT += dt * state.actionSpeed;
    const clip = state.actionClip;
    const u = state.actionT / clip.duration;              // 0..1
    if (u >= 1) {
      finishAction(ctx);                                   // -> back to base, fire 'end'
    } else {
      const clipPose = sampleClip(clip, u);                // keyframe lerp (see §4)
      // golf cross-fades; we blend action over base by clip.mask weight
      const w = actionBlendWeight(u, clip);                // ease-in 0->1->0 ramp
      pose = blendPose(basePose, clipPose, w, clip.mask);  // mask = which joints clip owns
      fireClipEvents(clip, u, ctx);                        // <-- releaseFrame etc.
    }
  }

  // 3. PROCEDURAL OVERRIDES that always win (look-at, dribble hand if hasBall)
  applyLookAt(pose, ctx.lookTarget, dt);
  if (ctx.hasBall && !state.action?.ownsBallHand) applyDribbleHand(pose, ctx, dt);

  applyPose(parts, pose);                                  // golf's applyPose(), extended

  // 4. IK PASS — runs AFTER pose is applied, corrects feet to the ground
  solveFootIK(parts, ctx, dt);                             // §6
}
```

Key departures from golf, each justified:
- **Layering with a `mask`** (which joints a clip controls) lets `jumpshot` own the arms while the base still controls subtle hip/leg settle. Golf never needed this because a swing owns the whole body.
- **`actionBlendWeight` ease-in/out** replaces golf's single `ease(raw, easing)` so actions blend *in and out* without a hard pop back to locomotion.
- **IK runs last** — see §6.

---

## 4. Clips: authored vs procedural (the central recommendation)

**Author the ACTION clips as keyframed pose-target arrays in `clips.js`; drive LOCOMOTION procedurally.** This is the golf model scaled up: golf's `POSES` is effectively a 1-keyframe-per-state clip set. We give action clips *multiple* keyframes + event metadata.

### 4.1 Clip data shape

```js
// clips.js
export const CLIPS = {
  jumpshot: {
    duration: 0.62, speed: 1, mask: ARMS | TORSO | LEGS,  // bitmask of joint groups
    ownsBallHand: true,
    keys: [
      // t (0..1), then the SAME pose keys golf uses, extended for basketball joints
      { t: 0.00, ...P('gather') },        // dip
      { t: 0.35, ...P('set_point') },     // ball at set point, knees loaded
      { t: 0.55, ...P('release') },       // arms extended up
      { t: 1.00, ...P('follow_through') } // wrist snap, hold
    ],
    events: [
      { t: 0.00, name: 'gather_start' },
      { t: 0.55, name: 'release' },        // <-- GAMEPLAY-AUTHORITATIVE (see §7)
      { t: 0.62, name: 'land' },
    ],
  },
  dunk:   { duration: 0.9,  events:[{t:0.0,'gather_start'},{t:0.62,'release'},{t:0.78,'rim_contact'},{t:1.0,'land'}], ... },
  layup:  { duration: 0.7,  events:[{t:0.0,'gather_start'},{t:0.50,'release'},{t:0.8,'land'}], ... },
  block:  { duration: 0.5,  events:[{t:0.28,'block_window_open'},{t:0.40,'block_window_close'},{t:0.5,'land'}], ... },
  steal_reach: { duration:0.35, events:[{t:0.18,'steal_active'},{t:0.30,'steal_done'}], ... },
  crossover:   { duration:0.45, events:[{t:0.22,'ball_switch_hands'},{t:0.45,'end'}], ... },
  ...
};
```

`sampleClip(clip, u)` = find the bracketing keyframes by `t`, then `lerpPose` (golf already has `lerpPose(from,to,t)` — reuse it) with the per-segment easing. This is *exactly* golf's tween, just with N keys instead of 2.

### 4.2 Why not all-procedural (like golf's idle bob)?
Golf gets away with procedural idle (`Math.sin` sway/bob/breathe). We do that too for `idle`/`dribble_idle`/`jog`/`sprint`/`slide` because they're cyclic and need to couple continuously to speed. But a jumpshot/dunk/crossover has a *specific silhouette and a specific event frame* — hand-tuned keyframes give us the 2K-readable pose and a precise `releaseFrame`. Procedural sine waves can't hit "ball at the set point at exactly t=0.35."

### 4.3 Why not glTF clips?
Covered in §0 — no asset pipeline, no loader/mixer cost, no loading screen. The pose-key format is also trivially **net-serializable and deterministic**, which matters because the host sim must produce the same `releaseFrame` timing both clients agree on (§9).

---

## 5. Locomotion (procedural) and ball coupling

`evalLocomotion(base, ctx, dt)` produces a full pose from speed + a stride clock. Concretely:

```js
function evalLocomotion(base, ctx, dt) {
  const sp = ctx.speed;                     // m/s from sim
  const cadence = lerp(2.0, 5.2, clamp01(sp/SPRINT_SPEED));  // steps/sec
  state.strideClock += dt * cadence;
  const phase = state.strideClock * Math.PI;
  // legs: opposite-phase thigh swing + knee bend timed to plant
  pose.hipL = Math.sin(phase) * STRIDE_AMP(sp);
  pose.hipR = Math.sin(phase + Math.PI) * STRIDE_AMP(sp);
  pose.kneeL = bendFor(phase);  pose.kneeR = bendFor(phase + Math.PI);
  // counter-rotating arms — UNLESS carrying the ball (then dribble hand owns one arm)
  pose.shoulderR = ctx.hasBall ? DRIBBLE_ARM : Math.sin(phase+Math.PI)*ARM_SWING;
  pose.shoulderL = Math.sin(phase)*ARM_SWING;
  // torso lean into velocity + vertical bob synced to plant
  pose.torsoX = 0.05 + 0.12*clamp01(sp/SPRINT_SPEED);
  pose.rootBobY = Math.abs(Math.sin(phase)) * BOB_AMP(sp);   // applied to hips.position.y
  return pose;
}
```

`defensive_slide` is a special base: wide stance (legs splayed via `hipL/hipR` z-rotation), low hips, no arm swing (arms out), foot shuffle phase that never crosses over. `backpedal` reuses jog with reversed arm phase and a lean-back torso.

### 5.1 Dribble coupling (the signature game-feel piece)

When `ctx.hasBall && grounded && !action`, the ball is **NOT free** in physics — it's a kinematic bounce owned by the animator so the hand and ball stay glued (real cannon-es dribbling would jitter and desync over the net). `applyDribbleHand`:

```js
function applyDribbleHand(pose, ctx, dt) {
  state.dribblePhase = (state.dribblePhase + dt * dribbleHz(ctx)) % 1; // hz scales with speed/style
  const apex = DRIBBLE_APEX[preset.dribbleStyle];     // low/medium/high
  const y = floorBounce(state.dribblePhase, apex);    // 0 at floor contact, apex at top
  // hand pushes down at top, recoils at floor; wrist flicks
  pose.wristR = -0.3 - 0.6*Math.sin(state.dribblePhase*Math.PI*2);
  pose.shoulderR = 0.2 + 0.4*(1-y/apex);
  // ball world pos = hand ballAnchor world pos when y>contact, else interpolate to floor
  ctx.ballState.dribbleY = y;   // sim/render reads this to place the kinematic ball
}
```

The **sim places the ball** at `lerp(handAnchorWorld, floorPoint, bouncePhase)` each frame using `dribbleY`. On a steal/turnover the ball converts from this kinematic-attached state to a free cannon-es body (§8). Dribble style (`low`/`medium`/`high` from preset) changes apex + hz → visible signature handles.

---

## 6. Foot-locking / IK (anti-skating)

Golf never moves the golfer so it has no skating. Basketball moves constantly → mandatory. Use **2-bone analytic IK** (cheap, deterministic, no solver iteration) in `ik.js`:

```js
// solveLeg(hipPos, targetFootPos, thighLen, shinLen) -> {hipRot, kneeRot}  (law of cosines)
```

Algorithm in `solveFootIK(parts, ctx, dt)`:
1. Procedural locomotion already produced *desired* foot positions in world space (forward kinematics from the stride). 
2. **Plant detection:** during the stance phase of each leg's stride cycle (`Math.sin(phase) < plantThreshold`), LOCK that foot's world XZ to where it first touched. Only release the lock when the cycle lifts the foot. This kills sliding — the foot stays pinned while the body moves over it (the defining anti-skate trick).
3. Ground the locked foot: raycast/heightlookup is trivial (half-court is **flat** — unlike golf's heightfield — so `footY = 0`). This is a huge simplification we get for free vs golf's contoured terrain.
4. Solve the 2-bone IK so the ankle reaches the locked+grounded target; write back `hip`/`knee` rotations *over* the procedural pose.
5. Pelvis drop: lower `hips.position.y` slightly when the stretched leg can't reach (prevents over-extension pop).

Cost: ~10 trig ops × 2 legs × 2 players = negligible. No iterative CCD/FABRIK needed.

The same `ik.js` 2-bone solver is reused for **reach IK**: steal_reach and contest aim the *hand* at the ball's world position (target = ball, solve shoulder/elbow) so swipes actually point at the handle instead of playing a canned wave.

---

## 7. Animation timing IS gameplay (the core mechanic)

This is the direct analog of golf's `swing.js`: the swing *phase machine* decides WHEN `onShot` fires, and only then does the engine compute launch velocity (`launchShot`). Basketball does the same but the trigger is a **clip event frame**, not a meter click.

**Rule: a shot/layup/dunk does not resolve until its `release` event fires.** The shot meter result (other pillar) is *latched* at input time; the *resolution* happens on the release frame.

```js
function fireClipEvents(clip, u, ctx) {
  for (const ev of clip.events) {
    if (u >= ev.t && !state.eventsFired.has(ev.name)) {
      state.eventsFired.add(ev.name);
      onEvent(ev.name, { clip: state.action, ctx });   // -> sim handles it
    }
  }
}
```

`onEvent` handlers in the sim (host-authoritative):

| Event | Sim action |
|---|---|
| `release` (jumpshot/layup/floater/dunk) | Detach ball from hand → spawn free cannon-es body with velocity toward hoop computed from latched shot-meter result + contest modifier. **The make/miss is decided here**, at the release frame. |
| `block_window_open`/`close` | Defender's hand is an active block volume only between these frames. A shot whose `release` falls in another player's open block window → blocked (ball deflected as free body). |
| `steal_active`/`steal_done` | Reach hand is a steal volume vs the dribbler's ball-carry for those frames. |
| `ball_switch_hands` (crossover/between_legs) | Move ball kinematic anchor from `handR.ballAnchor` to `handL.ballAnchor` — the moment the handle is exposed/protected (drives steal vulnerability windows). |
| `rim_contact` (dunk) | Camera shake hook + audio + force the ball through. |
| `land` | Re-enable locomotion base; if a landing was contested, possibly trigger `bump_react`. |
| `end` (dribble moves) | Return to `dribble_idle`/jog base. |

This gives 2K's feel: faster signature jumpshots (shorter `release` t) get the shot off before a slow contest's `block_window`. Release timing is a *real* competitive variable, authored per clip + per `jumpshotStyle`.

**Determinism requirement:** because the host owns truth, the host advances `actionT` with the same `dt=Math.min(0.05, dtMs/1000)` clamp golf uses, and resolves `release` in *sim* time, then broadcasts the outcome. The guest's animator plays the same clip for *visual* purposes off the snapshot but **never resolves gameplay** (§9).

---

## 8. Ball-in-hand attachment vs free-ball handoff

Two ball states, switched at event frames. This mirrors golf's club, which is permanently parented to `gripPivot` — we just make the parent dynamic.

**State A — `CARRIED` (kinematic, animator-owned):**
- Ball mesh's transform is driven each frame from a hand `ballAnchor` (dribble: interpolated hand↔floor; gather/carry: glued to anchor). 
- The cannon-es ball body is `type = CANNON.Body.STATIC` / sleeping, or simply not stepped — render reads the anchor, not physics.
- Possession is a sim flag; only the host mutates it.

**State B — `FREE` (dynamic, cannon-es-owned):**
- On `release`/steal/turnover/rebound-loose, the host: reads the hand `ballAnchor` world transform, sets the cannon body's position there, wakes it, sets velocity (shot vector or deflection), flips body to dynamic. Render now follows the physics body (exactly how `golf.js` follows `physics.ball.position` to `ballMesh`).
- Rebound/catch converts B→A: when a player's catch volume overlaps the free ball at low relative speed and they have possession priority, re-parent kinematic to their hand and play `posted_up`/`dribble_idle`.

Handoff helper (host-only):

```js
function ballToFree(handAnchor, velWorld) {
  handAnchor.getWorldPosition(_v); handAnchor.getWorldQuaternion(_q);
  body.position.copy(_v); body.quaternion.copy(_q);
  body.velocity.set(velWorld.x, velWorld.y, velWorld.z);
  body.type = CANNON.Body.DYNAMIC; body.wakeUp();
  possession.carried = false;
}
function ballToHand(player, hand) {
  body.sleep(); possession = { carried: true, player, hand };
  // render switches to anchor-follow next frame
}
```

The animator exposes `parts.handR.ballAnchor.getWorldPosition()` so the sim can do this without knowing rig internals — clean seam, same as golf reading `physics.ball.position`.

---

## 9. Networking coupling (host-authoritative, per the fixed tech model)

The animator runs on **both** clients but means different things:
- **Host:** animation `actionT` and event frames are sim-authoritative. `release`/`block_window`/`steal_active` resolve gameplay here. Host broadcasts compact snapshots.
- **Guest:** receives snapshots `{ playerA:{pos,facing,baseState,actionState,actionT}, playerB:{...}, ball:{state,pos,vel} }` and **drives the animator purely visually** — calls `set(actionState)` / lerps `actionT` to the snapshot value, interpolates root pos/facing. It does NOT fire gameplay-resolving events; it just plays the matching clip so the avatar looks right. Outcomes (make/miss/block/steal) arrive as explicit sim events in the snapshot.

Snapshot animation payload is tiny: `baseState` (enum byte), `actionState` (enum byte), `actionT` (uint8 normalized), `facing` (int16), root XZ + ballY. Procedural locomotion (`strideClock`, `dribblePhase`, IK) is **recomputed locally on each client** from `speed`/`facing` — never sent — so we spend bytes only on discrete state + the action clock. Interpolate root pos between snapshots (like a snapshot-render buffer); snap action state on change.

This is the tennis "dumb relay" pattern: guest input → host, host snapshot → guest, server rebroadcasts. The animator is the render-side interpolation target.

---

## 10. Hit reactions / light contact on contests

Authored micro-clips on the action layer, triggered by sim collision/proximity events (host decides, broadcasts):
- `bump_react_L/R`: short (0.25s) torso recoil + arm brace + a small root knockback impulse (sim moves the body; animator plays the flinch). Fired when a drive collides with a set defender, or on a contested gather.
- `contest`: defender hand-up reach (reach IK to ball) that raises the shooter's effective shot difficulty (handoff to rules pillar via the same `onEvent` channel — animator just reports the contest window; sim applies the make% penalty).
- `posted_up`: low-grade idle when two bodies overlap at low speed (back-to-chest), with a subtle lean toward the defender. Pure pose, no gameplay beyond signaling.

Contact stays "light" (no ragdoll, no full collision animation) — that's the realistic ceiling and it matches the budget. The flinch sells it.

---

## 11. The realistic ceiling (flagging it explicitly)

What this design **will** deliver: instantly readable 2K-Blacktop silhouettes (gather → set → release → follow-through; defensive slide; reach swipes; rim-hang dunk), crisp gameplay-driving release/block/steal timing, no foot skating, per-character signature dribble/shot styles, glued ball-in-hand and clean free-ball handoff, and full netcode determinism on the host.

What it will **NOT** deliver, and we accept: mocap-smooth weight transfer, finger/wrist articulation on the ball, contact-aware blended collisions (no ragdoll/IK-driven bracing between two bodies), cloth/jersey sim, or skin deformation at joints. Joints will show the chamfered-box seam golf already ships — we mitigate with joint-cap spheres (golf's `shoulderCap` trick, extended to elbows/knees/hips) and the 6–12 m camera distance. If a later milestone demands more fluidity, the seam is `characters.js` swapping to glTF skinned meshes *behind the same `parts`/`createAnimator` contract* — the animator's state machine, event frames, IK, and net payload stay identical, which is why we keep geometry and animation in separate modules from day one.

---

## 12. Build order (so it's incrementally testable, golf-style)

1. `characters.js` — `createBaller`, render two static T-pose rigs in the scene (smoke-shot a la `tests/*.mjs` pixel sampling).
2. `clips.js` + `animator.js` core: `set`/`update`/`sampleClip`/`blendPose`, action layer only. Play `jumpshot` on a keypress, verify `release` event fires once at t=0.55 (unit test on `fireClipEvents` — pure function, node:test friendly).
3. Procedural locomotion (`evalLocomotion`) + drive root from WASD via `playerctl.js`.
4. `ik.js` foot-lock — verify no skating by logging locked-foot world XZ delta < ε while moving.
5. Dribble coupling + ball kinematic anchor; then free-ball handoff at `release`.
6. `defenderAI.js` (copy `ai.js`): emits the SAME intent shape as `playerctl` (Gaussian noise by difficulty) → block/steal/slide states.
7. Hit reactions + signature styles + celebrate/dejection polish.

Each step renders something a Playwright smoke harness can screenshot, matching the project's existing `tests/playthrough.mjs` / pixel-sample-for-blank-render approach.

---

## Adversarial Critique (AAA-bar review)

**Verdict:** needs-work

### Gaps
- DETERMINISM IS INTERNALLY INCONSISTENT. The design (§7) insists release timing is 'sim-authoritative' and resolved 'in sim time' with golf's dt-clamp, but §3.4 advances state.actionT by the variable render dt (anim.update(dt,...)), NOT inside a fixed-step loop. Golf's actual physics (physics.js step()) uses a FIXED_DT=1/60 accumulator with MAX_SUBSTEPS=6 that DROPS substeps under load. So a host at 30fps and a host at 144fps will cross ev.t=0.55 on different absolute frames, and a low-FPS host will accumulate dt clamped at 0.05 -- the release frame fires at a different wall-clock moment than authored. The design name-drops the dt-clamp as if it confers determinism; it does not. For a single host running the truth this is survivable (host is the only authority), but the design oversells it as 'full netcode determinism on the host' (§11) when it's actually frame-rate-dependent timing the guest must blindly trust.
- TENNIS RELAY IS NOT THE PROVEN TEMPLATE THE DESIGN IMPLIES. tennis.js in this repo is a LOCAL-ONLY prototype: it has no slot/authoritative/snapshot/input-send code (grep finds none) -- only the server relays. The design repeatedly says 'this is the tennis dumb-relay pattern' (§9) as if there's working continuous-real-time client netcode to copy. There isn't. The only proven client netcode is net.js's TURN-BASED golf. So the single hardest, highest-risk part of basketball -- a 60Hz host-authoritative snapshot/interpolation loop with input prediction -- is presented as 'copy tennis' when it must be built from scratch. This pillar leans on that assumption (§9 snapshot payload) without owning the risk.
- CLIP AUTHORING EFFORT IS UNDERSCOPED AND UNDER-SPECIFIED. The design itself flags '~15-20 multi-key action clips by hand' as a risk, then does almost nothing to de-risk it. The example clips (§4.1) show only events arrays for dunk/layup/block with '...' standing in for the actual keyframe pose data -- the hard part (authoring readable 2K silhouettes across ~14 new joints per frame, multiple keys each) is hand-waved. Golf shipped 6 single-keyframe poses tuned over presumably many iterations; this asks for ~15-20 clips x 3-4 keys x ~20 DOF = the real cost center, with no authoring tool, no in-browser pose editor, no reference, and no time estimate. This is where the AAA feel lives or dies and it's a stub.
- LAYERED BLEND + PER-JOINT MASK SYSTEM IS THE LARGEST NET-NEW SUBSYSTEM AND IS SPEC'D AT PSEUDO-CODE DEPTH ONLY. Golf has zero blending (whole-body cross-fade between 2 poses). The design introduces bitmask joint masks (ARMS|TORSO|LEGS), blendPose(base, clip, w, mask), actionBlendWeight ease-in/out, AND procedural overrides that 'always win' -- three layers fighting over the same rotation channels. The interaction between (a) procedural locomotion writing hipL/kneeL, (b) a masked clip blending over them, and (c) IK writing hip/knee LAST 'over the procedural pose' is exactly where snap-pops and double-driven-joint bugs live, and it's left as 'TODO, see §6'. There is no defined precedence contract for what happens when a masked clip owns LEGS but IK also wants the legs (does foot-lock fight the jumpshot's leg keys?).
- IK FOOT-LOCK + CLIP-DRIVEN LEGS ARE ON A COLLISION COURSE. §6 says IK runs LAST and overwrites hip/knee from foot-lock targets. But §4.1 jumpshot has mask=ARMS|TORSO|LEGS and authored knee-load keyframes. During a jumpshot the player leaves the ground -- foot-lock to footY=0 is wrong mid-air, yet the design never says IK disables when !grounded for the action layer. The grounded flag exists in ctx but the precedence ('IK always last') would stomp the authored jump pose's legs into the floor. This is a concrete bug baked into the stated update order.
- DRIBBLE-AS-KINEMATIC vs HOST AUTHORITY HAS AN UNRESOLVED SEAM. §5.1 says the ball during dribble is animator-owned kinematic (ctx.ballState.dribbleY), placed at lerp(handAnchorWorld, floorPoint, phase). But the animator runs on BOTH clients computing dribblePhase LOCALLY from speed (§9 says strideClock/dribblePhase are never sent). So the guest's locally-computed dribble ball position will NOT match the host's authoritative ball position -- two clients render the dribbling ball at different heights/phases. For a carried ball that's cosmetic, but the steal windows (ball_switch_hands exposing the handle) are gameplay-authoritative on the host while the guest sees a desynced ball. The design declares the seam clean ('sim places the ball') but the per-client local phase computation contradicts the single-authority model for the one object that matters most.
- BUDGET CLAIM ('~30 matrix writes each, rigs are cheap') IGNORES THE REAL COST: SHADOWS + DRAW CALLS. The rig isn't 30 matrix writes -- buildGolfer creates ~25+ separate Meshes per humanoid (each leg segment, arm segment, head, jaw, ears, pelvis, belt, collar, shoes/soles), every one castShadow=true. Two ballers = ~50 shadow-casting meshes re-rendered every frame in the PCFSoft shadow pass, PLUS the court, rim, backboard, net, ball, and the 'crowd' the design casually references. Golf renders ONE golfer. The design's mitigation ('drop crowd/shadow detail before touching rigs') is right but the cost accounting that justifies 'rigs are cheap' is wrong -- it's draw-call and shadow-pass bound, not matrix-write bound, and two fully-articulated non-instanced humanoids is a real per-frame cost the design dismisses.
- GUEST VISUAL FIDELITY UNDERSPECIFIED: actionT AS uint8 + snap-on-change WILL JUDDER ON FAST CLIPS. §9 sends actionT as a uint8 (256 steps) and 'snaps action state on change'. A steal_reach clip is 0.35s; block_window is 0.12s wide (t=0.28-0.40). At a typical 15-20Hz snapshot rate the guest gets ~5-7 snapshots across a 0.35s clip -- it will see the steal/block as a coarse stutter, and because the guest 'never resolves gameplay,' a block that connected on the host can VISUALLY appear to whiff on the guest's screen (ball deflects with no visible hand-on-ball contact). This is the classic authority/render mismatch and the design doesn't address reconciling the visible animation with the authoritative outcome.

### Must-Fix (applied in synthesis)
- Resolve the determinism contradiction explicitly: advance action clocks INSIDE a fixed-step accumulator (reuse physics.js's FIXED_DT=1/60 pattern), not on render dt. Define that event frames are evaluated per fixed substep so release/block_window fire on a deterministic substep boundary regardless of host FPS. Then drop the overclaim and state plainly: 'timing is host-authoritative, guest trusts it; it is frame-rate-stable on the host because clocks tick in fixed substeps, not render frames.'
- Stop calling the netcode 'the tennis pattern.' Tennis.js has NO real-time client netcode in this repo. Add an explicit dependency/handoff to the netcode pillar for a 60Hz-sim / ~15-20Hz-snapshot host-authoritative loop with a guest snapshot-interpolation buffer and input send, and scope THIS pillar to only: (a) expose actionState/actionT/baseState/facing/rootXZ as the snapshot payload, (b) provide setFromSnapshot() that drives the animator visually. Make the boundary a contract, not an assumption.
- Define the layer-precedence contract concretely BEFORE building: write the exact resolution order and ownership rules for procedural-base vs masked-clip vs IK per joint group, and specify that IK foot-lock is DISABLED for any leg the active clip's mask owns AND whenever ctx.grounded is false. Add the airborne case to evalLocomotion/solveFootIK so jumpshot/dunk/layup legs are clip-driven, not floor-locked. This kills the stated 'IK stomps the jump pose into the floor' bug.
- Make the dribbling ball host-authoritative like every other gameplay object: either (a) include dribbleY/ball XZ in the snapshot (it's a few bytes) so both clients render the SAME ball, OR (b) explicitly accept the dribble ball as cosmetic-only and move ALL steal-vulnerability windows to host-side sim state that is broadcast, so the guest's locally-phased ball never drives an outcome. Do not leave 'sim places the ball' and 'guest computes dribblePhase locally' both true -- pick one.
- Spec the actual clip data, not stubs. Produce 2-3 FULLY authored example clips (jumpshot, layup, defensive_slide) with every keyframe's pose values across the new joints, and build a minimal in-browser pose-scrubber (a dev URL param that steps actionT) so clips can be tuned without a Blender pipeline. Without a tuning loop, 15-20 hand-authored clips will not reach the 2K-readable bar. Give a real time estimate for this authoring work and treat it as the critical path, not a footnote.
- Fix the per-frame budget accounting: state the real cost as ~25+ shadow-casting meshes x 2 players in the PCFSoft shadow pass plus the court/rim/crowd draw calls, not '30 matrix writes.' Decide now whether ballers cast shadows in the shadow map at all (a single blob/contact shadow under each player may be enough at 6-12m and saves the whole second humanoid's shadow pass). Set a draw-call budget and a fallback ladder before crowd is even added.
- Address guest visual/authority reconciliation for fast clips: define how a host-resolved block/steal/make is reflected when the guest's coarse actionT interpolation didn't show the contact frame. At minimum, send the discrete outcome event (blocked/stolen/made) explicitly in the snapshot (the design already says outcomes arrive as sim events -- make that the source of truth for VFX/audio so the guest never relies on its interpolated animation landing the hit).

### Feasibility Notes
Core thesis -- procedural rig extending buildGolfer, no glTF, swing.js-style event-frame-drives-gameplay -- is sound and well-grounded in the actual code (verified: characters.js bone hierarchy + gripPivot club parenting, swing.js phase machine emitting onShot, physics.js fixed-step accumulator all exist as described). This is the right call for a browser budget and zero asset pipeline. The realistic ceiling (§11) is honestly stated. WHERE TO TRIM: (1) Cut the joint count for v1 -- skip the wrist Group and neck-yaw look-at initially; golf gets by with headGroup.rotation only. Add wrists only if shot follow-through reads poorly. (2) Defer per-joint mask BLENDING; ship action-owns-whole-body cross-fade (exactly golf's model) for v1 and add masked layering only for dribble-bounce-during-jog if it's actually needed -- the layering system is the biggest net-new complexity and biggest bug surface. (3) Ship 5-6 hero clips (jumpshot, layup, dunk, block, steal, crossover) not 15-20; defer floater/between-legs/behind-back/posted-up/celebrate to a polish milestone. (4) Single blob shadow per player, not full shadow-casting rigs. The pillar is feasible but is currently scoped as ~2-3 pillars of work (rig + animation state machine + IK + dribble-ball authority + per-character signatures); the build order (§12) is good but each step 2-7 is heavier than golf's entire character system. Recommend explicitly splitting 'rig + core action clips' (clearly feasible, copy golf) from 'IK + layered blend + dribble-ball netcode authority' (the risky third) so the latter can be cut or simplified without blocking a playable v1.

