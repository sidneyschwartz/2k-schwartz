# Pillar 1 — Game Design & Core Loop

> This pillar defines the moment-to-moment feel of half-court 1v1 "Blacktop" basketball: the offense/defense loop, a keyboard+mouse dribble engine, a timing/green-window shot system built on swing.js's meter state-machine pattern, a drive→layup/dunk decision system, a defense model, a lightweight attributes+badge layer that measurably moves outcomes, momentum/heat, and difficulty tuning. Everything is a self-contained module set (no shared base class) that COPIES the golf patterns: a single rAF tick with dt=min(0.05,dtMs/1000), pull-based HUD getters, a controller-shaped action payload identical for human/AI/network, and host-authoritative simulation. The core deliverable is the shot-make probability function P_make(meterErr, contest, rating, range, stamina, badges) plus exact bindings and pseudo-code for every action.

# Pillar 1 — Game Design & Core Loop (NBA 2K "Blacktop" 1v1, half-court)

This document specifies the feel layer for the basketball sport. It is written to be implemented directly. It assumes the existence (owned by other pillars) of: a `scene.js` clone returning `{scene,camera,renderer,follow,...}`, a `physics.js` clone wrapping cannon-es for ball/rim/backboard/floor, a `hud.js` clone with pull-based getters, an `audio.js` clone (procedural), and `connectBasketball`/server `room.sport==='basketball'` relay. This pillar owns the **rules, controls, and math** that make it feel like 2K Blacktop.

All files live in `src/sports/basketball/`. **No shared base class** — we copy golf's patterns verbatim where they fit (cited inline).

---

## 0. Design pillars (the "feel" contract)

1. **The ball is always physical-ish, but control is animation-driven, not ragdoll.** Dribbling and shooting are *state machines that drive the ball's target position* (kinematic), and only "go physical" (hand off to cannon-es) on a release: shot in flight, loose ball, rebound. This mirrors golf, where the swing controller is a pure state machine and physics only owns the ball *after* `launchShot`. The ball is a kinematic body during dribble/gather, a dynamic body in flight.
2. **One meter to rule shooting** — a green-window timing meter that is the swing.js 3-click pattern re-skinned (idle → rising → release-window). We reuse swing.js's *architecture* (a controller factory emitting an `onShot` payload), not its golf-specific gesture math.
3. **Reads beat reflexes, but reflexes matter.** Contest level and defender position are computed every frame; shot quality multiplies meter timing. A wide-open green is a near-lock; a contested green is a coin flip. This is the sim-lite knob.
4. **Every action is one payload shape** so human, AI, and network all flow through the same `applyIntent(intent)` — exactly how golf routes human `onShot`, `createAiGolfer.planShot`, and `net` opponent shots into one `launchShot`.

---

## 1. Core loop & possession state machine (`core.js`)

### 1.1 Game constants (streetball, fixed product decision)

```js
export const RULES = {
  WIN_SCORE: 11,        // first to 11
  WIN_BY: 2,            // win by 2
  MAX_SCORE: 21,        // hard cap (defensive infinite-game guard)
  MADE_1S: 1, MADE_2S: 2, // inside arc = 1, beyond arc = 2 (streetball 1s & 2s)
  MAKE_IT_TAKE_IT: true,
  CLEAR_RADIUS: 6.75,   // arc radius (m) — ball must be "taken back" past this on change of possession
  SHOT_CLOCK: null,     // none in casual Blacktop; optional 24 for ranked (see §9)
  CHECK_REQUIRED: true, // check-ball at top of key after every dead ball
};
```

### 1.2 Possession state machine

The whole sport is one finite state machine ticked from the rAF loop. States:

```
CHECK        // ball at top of key, on defense to "check" (confirm). No live play.
LIVE_OFFENSE // ballhandler has it inside/at arc; defender guarding
SHOT_LIVE    // a shot is in the air (physics owns ball); both players can rebound/contest
LOOSE        // rebound/steal/block knocked ball free; first to gather gains possession
CLEARING     // change of possession — new offense must dribble/carry ball past CLEAR_RADIUS ("take it back")
MADE_BASKET  // brief celebration beat; make-it-take-it → back to CHECK with same offense, or change
DEAD         // out of bounds / foul → resets to CHECK
GAME_OVER
```

Transition table (authoritative; runs on host only in MP):

```js
function stepPossession(dt, world) {
  switch (world.phase) {
    case 'CHECK':
      // Offense presses Pass/Check (Space) to accept the check → LIVE_OFFENSE.
      if (world.checkAccepted) { world.phase = 'LIVE_OFFENSE'; world.clearedArc = true; }
      break;
    case 'LIVE_OFFENSE':
      if (world.shotReleased)         world.phase = 'SHOT_LIVE';
      else if (world.ballStolen || world.ballKnockedLoose) world.phase = 'LOOSE';
      else if (world.outOfBounds)     beginDead(world, /*turnover*/true);
      break;
    case 'SHOT_LIVE':
      if (world.ball.settledInNet)    onMade(world);          // → MADE_BASKET
      else if (world.ball.deadAfterMiss) onMiss(world);        // → LOOSE (rebound)
      break;
    case 'LOOSE':
      // first body within GATHER_RADIUS with lower ball-distance gathers
      if (world.gatheredBy != null) onGather(world, world.gatheredBy);
      break;
    case 'CLEARING':
      // possession illegal until ballhandler XZ-distance to hoop > CLEAR_RADIUS
      if (dist2D(world.ballHandlerPos, world.hoopXZ) > RULES.CLEAR_RADIUS) {
        world.clearedArc = true; world.phase = 'LIVE_OFFENSE';
      } else if (world.shotReleasedBeforeClear) { beginDead(world, true); } // violation → turnover
      break;
    case 'MADE_BASKET':
      world.scoreBeatTimer -= dt;
      if (world.scoreBeatTimer <= 0) {
        if (checkGameOver(world)) { world.phase = 'GAME_OVER'; }
        else resetToCheck(world, /*offenseKeepsBall=*/RULES.MAKE_IT_TAKE_IT);
      }
      break;
    case 'DEAD':
      resetToCheck(world, world.deadGivesBallToDefense ? FLIP : SAME);
      break;
  }
}
```

`checkGameOver`: `score>=WIN_SCORE && (score-other)>=WIN_BY` or `score>=MAX_SCORE`.

**"Take it back" enforcement** (the streetball rule) is just the `CLEARING` state plus a HUD ring at `CLEAR_RADIUS`. On any change of possession we set `phase='CLEARING'`, `clearedArc=false`. A shot attempt while `clearedArc===false` is a violation → turnover. This is cheap (one XZ distance check/frame) and reads as authentic.

### 1.3 The tick (copies golf.js exactly)

```js
function tick(now) {
  if (stopped) return;
  rafId = requestAnimationFrame(tick);
  const dt = Math.min(0.05, (now - last) / 1000); last = now;   // golf.js:1240
  if (world.paused) { render(); return; }

  // 1. Inputs → intents (local controller + AI + netDecode)
  const myIntent  = input.sample(dt);                // {move, sprint, action, aimYaw}
  const oppIntent = isMP ? net.latestOppIntent()     // guest streams input
                  : hasCpu ? ai.decide(dt, world)    // same payload shape as input.sample
                  : null;

  // 2. Advance gameplay state machines (HOST authoritative in MP)
  if (amAuthority) {
    ballhandler.update(dt, world, offenseIntent(myIntent, oppIntent));
    defense.update(dt, world, defenseIntent(myIntent, oppIntent));
    shot.update(dt);                 // meter state machine (swing.js pattern)
    stepPossession(dt, world);
    physics.step(dt);                // only matters in SHOT_LIVE/LOOSE
    resolvePendingShot(world);       // P_make roll at apex (see §5)
    net?.broadcastSnapshot(world);   // host → guest
  } else {
    net.applySnapshot(world);        // guest interpolates (Pillar: netcode)
    shot.update(dt);                 // local meter still runs for input feel
  }

  // 3. Render-side: sync meshes, camera, vfx, audio
  syncMeshes(world); camera.update(dt); audio.tickAmbient(dt);
  render();   // defensive try/catch composer→renderer fallback, copied from golf.js
}
```

> Perf note: there are exactly **two** bodies that need continuous integration (the ball, plus the two players are kinematic capsules, not dynamic). cannon-es only does real work during `SHOT_LIVE`/`LOOSE`. This is well inside the golf budget — golf already steps a full `CANNON.World` every frame.

---

## 2. Input bindings (`input.js`) — exact key/mouse map

Keyboard + mouse only (gamepad optional, mirror swing.js's `pollGamepad`). Movement is **camera-relative WASD**; the camera sits behind the offensive basket (broadcast-low), so "W = toward hoop".

`input.sample(dt)` returns an **intent** object (the universal payload):

```js
{
  moveX, moveZ,        // -1..1 from WASD (camera-relative, normalized)
  sprint,              // Shift held
  aimYaw,              // mouse X drag → facing/aim (RMB or always-on, setting)
  // edge-triggered action this frame (one-shot), null if none:
  action,              // 'shoot_down'|'shoot_up'|'pass'|'crossover'|'behindback'|
                       // 'spin'|'hesi'|'sizeup'|'drive'|'pumpfake'|'call_dunk'|
                       // 'steal'|'block'|'contest_down'|'contest_up'|'take_charge'
  shootHeld,           // bool: is the shoot button currently down (meter rising)
  contestHeld,         // bool: defender raise-hands held
}
```

### 2.1 Offense bindings

| Action | Binding | Notes |
|---|---|---|
| Move | `W A S D` | camera-relative |
| Sprint / push pace | `Shift` (hold) | drains stamina; enables speed-boost out of dribble moves |
| **Shoot (meter)** | **Hold `LMB`** (or `Space`) → release | hold = power/gather rising, release in green window = make. The swing.js 3-state machine (§4). |
| Pump fake | tap `LMB` (< 120 ms) | quick tap = fake, not a shot; baits contest/block |
| **Drive / gather to basket** | `RMB` (hold) while moving toward hoop | triggers a euro/gather; on entering paint → dunk/layup decision (§6) |
| Call dunk (manual) | `E` during a drive | force dunk attempt if dunk rating allows |
| Crossover | `A`/`D` flick + `Q` | left↔right hand swap, lateral burst |
| Behind-the-back | `Q` + back-pedal (`S`) | |
| Hesitation ("hesi") | `C` (tap) | decelerate then explode; freezes a pressing defender |
| Size-up (combo) | `C` (hold) | stationary combo animation; builds a small shake meter |
| Spin move | `Shift+Q` while driving | quick rotation past defender; high stamina cost |
| Pass / **Check-ball accept** | `Space` (in CHECK state) | also "give it back" to check |
| Step-back | `RMB` + back-flick (`S`) at gather | creates space → open jumper |

### 2.2 Defense bindings

| Action | Binding | Notes |
|---|---|---|
| Move / slide | `W A S D` | lateral slide is faster than backpedal |
| **On-ball pressure / intensity** | `Shift` (hold) | tighter cushion, faster contest, but more blow-by risk + stamina drain |
| **Contest / raise hands** | hold `LMB` | raises contest level vs a shooter in real time (§5.2) |
| **Block** | tap `Space` | timed vertical/swipe; mistime = foul or blow-by |
| **Steal / swipe** | `F` | reach-in at the ball; success scales with handler exposure (§7.3); miss → reach foul chance |
| **Take charge** | `RMB` (hold) | plant feet; if driver collides while you're set & outside restricted zone → offensive foul |
| Intentional foul | `G` | stop-the-clock equivalent (rarely used in 1v1; included for completeness) |

> Binding philosophy: offense and defense **share the same physical keys** (you only ever do one role at a time), exactly like a real controller. `LMB-hold` is "the important verb for my role" (shoot on O, contest on D). This keeps the muscle-memory tight and the binding list short.

---

## 3. Dribble engine (`ballhandler.js`)

The ballhandler is a kinematic capsule with a **handle state**. The ball mesh is parented to a "dribble anchor" whose XZ offset and bounce are procedurally animated; the ball is *not* dynamic while dribbling (avoids cannon-es jitter and keeps it cheap). Each move is a short timed animation that (a) moves the anchor, (b) optionally bursts player velocity, (c) sets a `defenderShakeWindow` during which the defender's lateral tracking is degraded.

```js
createBallhandler({ ratings }) -> {
  update(dt, world, intent),   // advances move animations, dribble bounce, speed
  startMove(name),             // 'crossover'|'behindback'|'hesi'|'sizeup'|'spin'
  getExposure(),               // 0..1 how "stealable" the ball is RIGHT NOW
  getSpeedMul(),               // current speed multiplier from moves/sprint/stamina
  state,                       // {hand:'L'|'R', move, moveT, anchor, shakeWindow}
}
```

### 3.1 Move table (data-driven so designers tune in one place)

```js
const MOVES = {
  crossover:  { dur:0.32, burst:1.18, shake:0.45, exposure:0.55, stam:4,  reqHandle:0  },
  behindback: { dur:0.40, burst:1.10, shake:0.55, exposure:0.50, stam:5,  reqHandle:55 },
  spin:       { dur:0.55, burst:1.25, shake:0.70, exposure:0.35, stam:9,  reqHandle:70 },
  hesi:       { dur:0.45, burst:1.30, shake:0.60, exposure:0.30, stam:5,  reqHandle:0  },
  sizeup:     { dur:0.70, burst:1.00, shake:0.35*hold, exposure:0.65, stam:2, reqHandle:0 },
};
```

- `burst` = peak speed multiplier applied as a velocity impulse curve over `dur`.
- `shake` = how much the defender's `trackQuality` drops this frame (defender §7.1 reads it). Modulated by handler's **Ball Handle** rating and **Shifty** badge.
- `exposure` = base steal vulnerability while the move plays (the windup of a behind-the-back leaves the ball out).
- `reqHandle` = minimum Ball Handle rating to even attempt cleanly; below it, the move is slower and can be fumbled (small loose-ball chance).

### 3.2 Effective shake (the read that beats the defender)

```
shake_eff = move.shake
          * (0.6 + 0.008*ratings.ballHandle)     // 50 BH → ×1.0, 99 BH → ×1.39
          * (badge.Shifty ? 1.0 + 0.12*tier : 1) // Shifty bronze/silver/gold = +12/24/36%
          * timingBonus                            // chaining moves rhythmically adds up to +20%
```

`shake_eff` writes a `defenderShakeWindow = {amount: shake_eff, t: 0.5s}` that decays. While active, the defender's slide-tracking gain is reduced (§7.1) → that's the "ankle-breaker" blow-by. A blow-by is not scripted; it emerges when handler speed×shake exceeds defender recovery.

### 3.3 Dribble bounce & ball position

Pure procedural (no physics): `anchorY = restY + |sin(t*bounceFreq)| * 0.55`, `bounceFreq` rises with speed. Hand swap on crossover/behind-back flips `anchor.x` sign with an ease. Cost: trivial.

---

## 4. Shot meter (`shot.js`) — built on the swing.js 3-click pattern

We reuse swing.js's **shape**: a controller factory with an internal phase machine, a `getMeter()` the HUD polls each frame, an `update(dt)`, and an `onShot(payload)` emit. We replace golf's gesture math with a **hold-and-release green-window** meter (the modern 2K shot-meter).

### 4.1 Phases (compare swing.js `state.phase`)

```
idle → gather (LMB pressed, meter rising) → release (LMB up) → resolved
```

- On `LMB down` while `LIVE_OFFENSE`: `phase='gather'`, `meter=0`, freeze handler into a jumpshot animation (or, if moving fast toward hoop, branch to drive/layup — see §6). Tempo of rise is set by shot type + Shot Speed rating.
- `meter` rises 0→1 over `riseTime`. A **green window** `[gLo,gHi]` sits near the top (the "release point").
- On `LMB up`: capture `meterAtRelease`; compute `meterErr = signed distance from green-window center`, normalized so `|meterErr|<=greenHalfWidth` ⇒ "green/perfect".

```js
const SHOT_TIMING = {
  jumper:   { riseTime: 0.62, greenCenter: 0.88, greenHalf: 0.06 },
  three:    { riseTime: 0.70, greenCenter: 0.90, greenHalf: 0.045 }, // tighter beyond arc
  floater:  { riseTime: 0.48, greenCenter: 0.85, greenHalf: 0.07 },
  layup:    { riseTime: 0.40, greenCenter: 0.82, greenHalf: 0.09 },  // forgiving
};
```

`greenHalf` is widened by the shooter's **Shot Consistency/Deadeye** badge and narrowed by contest/stamina/range (so a fatigued contested three has a razor window). This *is* the difficulty/skill knob.

### 4.2 The emitted shot payload (universal shape)

Mirrors swing.js `emitShot` and AI `planShot` so human/AI/net all converge on `resolveShot`:

```js
onShot({
  type,           // 'jumper'|'three'|'floater'|'layup'|'dunk'
  meterErr,       // signed, 0 = perfect green. -1..1 (early/late)
  isGreen,        // |meterErr| <= effGreenHalf
  rangeM,         // shooter→hoop XZ distance
  fromBeyondArc,  // 1s vs 2s
  shooterPos, aimYaw,
  source,         // 'human'|'ai'|'net'
});
```

### 4.3 getMeter() for HUD (pull-based, like swing.js)

```js
getMeter() {
  return {
    phase, value: meter,                 // 0..1 fill
    greenLo: greenCenter-greenHalf_eff,  // HUD draws the green band; shrinks under contest
    greenHi: greenCenter+greenHalf_eff,
    contestTint: contestLevel,           // HUD reddens band when contested
    shotType,
  };
}
```

The HUD just renders a vertical bar + a green band — directly analogous to golf's power/accuracy bars in the fallback HUD. **Crucially, the green band visibly shrinks** as the defender contests, giving the shooter live feedback to pass up a bad shot. That single feedback loop is most of "the 2K feel."

---

## 5. Shot-make probability function (`resolve.js`) — the core formula

This is the heart of the pillar. A shot resolves at the meter release, but the *visible* make/miss is committed at the **apex** of the ball arc (so contests/blocks can still flip it). `P_make` is a product of independent factors clamped to a sane floor/ceiling.

```js
function pMake({ type, meterErr, isGreen, contest, rating, rangeM, stamina, badges, heat }) {
  // --- 1. Base by shot type & range ---
  let base = BASE_MAKE[type];                 // see table
  base *= rangeFalloff(type, rangeM, rating); // distance penalty, softened by Range badge

  // --- 2. Timing (meter) — the skill term ---
  // Perfect green ≈ near-ceiling; error falls off on a gaussian.
  const greenHalf = effGreenHalf(type, contest, stamina, badges);
  const e = Math.max(0, Math.abs(meterErr) - greenHalf); // forgiven inside green
  const timing = isGreen ? 1.0 : Math.exp(-(e*e) / (2*TIMING_SIGMA*TIMING_SIGMA));
  // green shots: a SMALL miss chance remains if contest/quality is bad (no auto-bucket)

  // --- 3. Contest — the read term ---
  // contest 0 (wide open) .. 1 (hand in face) .. >1 (block-contest at rim)
  const contestPen = 1 - CONTEST_K[type] * contest * (1 - 0.004*rating.contestResist);

  // --- 4. Shooter rating ---
  const ratePen = 0.55 + 0.0045 * relevantRating(type, rating); // 50→0.775, 99→0.995

  // --- 5. Stamina ---
  const stamPen = 0.80 + 0.20 * smoothstep(stamina);            // gassed → -20%

  // --- 6. Momentum / heat ---
  const heatBonus = 1 + heat * 0.10;                            // hot hand up to +10%

  let p = base * timing * clamp01(contestPen) * ratePen * stamPen * heatBonus;

  // --- 7. Badge overrides (multiplicative, after the stack) ---
  if (badges.Deadeye)     p *= 1 + 0.04*tier*contest;     // negates part of contest
  if (badges.RangeExt && fromBeyondArc) p *= 1 + 0.05*tier;
  if (badges.SlitherFinish && type==='layup') p *= 1 + 0.06*tier;

  return clamp(p, 0.02, 0.985);   // never 0, never automatic
}
```

### 5.1 Constants (tuned for "green = ~85-95% open, ~45-60% contested")

```js
const BASE_MAKE = { dunk:0.95, layup:0.78, floater:0.62, jumper:0.55, three:0.46 };
const CONTEST_K = { dunk:0.20, layup:0.45, floater:0.40, jumper:0.55, three:0.62 };
const TIMING_SIGMA = 0.16;     // how fast make-prob decays off-green
```

Worked examples (rating 75, full stamina, no heat/badges):
- **Open green three** (contest 0): `0.46·1·1·0.8875·1·1 ≈ 0.408`… *too low for a green.* Green forces a floor: when `isGreen && contest<0.15`, apply `p = max(p, GREEN_OPEN_FLOOR[type])` with `GREEN_OPEN_FLOOR.three=0.82`. **A wide-open green should reward the player.** Contested greens skip the floor.
- **Contested (0.7) green three**: `0.46·1·(1−0.62·0.7)·0.8875 ≈ 0.46·0.566·0.8875 ≈ 0.231`, no floor → ~23%. Correct: a hand in your face on a three is a bad shot even greened.
- **Slightly-late open jumper** (`meterErr=0.10`, greenHalf 0.06 → e=0.04, timing=exp(−.0008/.0512)=0.985): `0.55·0.985·1·0.8875 ≈ 0.481`.

> The `GREEN_OPEN_FLOOR` mechanic is what makes shot selection matter: the game *teaches* "get open, then green it." This is the single most important tuning lever; expose it in a debug panel.

### 5.2 Contest level computation (per frame, defender-driven)

```js
function contestLevel(shooter, defender) {
  const d = dist2D(shooter.pos, defender.pos);
  const closeout = clamp01((CONTEST_RANGE - d) / CONTEST_RANGE); // 2.0m range
  const handsUp = defender.contestHeld ? 1.0 : 0.45;             // LMB-hold = full
  const facing  = facingDot(defender, shooter);                  // in front of shooter?
  const vertical = defender.airborne ? 1.15 : 1.0;               // contest at apex
  let c = closeout * handsUp * facing * vertical;
  if (defender.badges.RimProtector && shooter.inPaint) c *= 1 + 0.15*tier;
  return clamp(c, 0, 1.4);
}
```

The shooter sees this *live* via the shrinking green band (§4.3) — the read.

---

## 6. Drive / dunk system (`finishing.js`)

A **drive** is triggered by `RMB`-hold while moving toward the hoop. On crossing into the paint (`rangeM < PAINT_R` and speed above threshold), the system makes a **finish decision**:

```js
function decideFinish(world, h) {
  const lane = laneOpenness(world);     // 0..1, defender between handler and rim?
  const speed = h.speed;
  const canDunk = h.ratings.dunk >= DUNK_GATE   // e.g. >=70
               && speed > DUNK_SPEED
               && lane > 0.35
               && h.stamina > 0.25;
  if (h.intent.action === 'call_dunk' && canDunk) return 'dunk';
  if (canDunk && lane > 0.6) return 'dunk';        // auto-dunk wide-open lanes
  if (lane < 0.25) return 'floater';               // defender wall → kick to floater
  return 'layup';
}
```

### 6.1 Dunk vs layup vs floater
- **Dunk**: highest `BASE_MAKE` (0.95), short/forgiving meter (or no meter on a wide-open lane — auto-finish like golf's deterministic `_debugSink` snap). Uses a procedural rim-hang animation + camera punch-in.
- **Posterizer**: if a `take_charge`/contest defender is *in the lane* during a dunk and the dunker has the **Posterizer** badge + speed, run a contact-dunk: dunker make-prob gets `×(1+0.10·tier)` AND the defender suffers a brief stun (knocked-back animation, −contest for 1s). Pure feel payoff; resolves via the same `pMake` (dunk, contest from the defender) with the posterizer multiplier.
- **Layup**: most forgiving meter (`greenHalf 0.09`), gather animation, vulnerable to **block** (§7.2) and steal-on-gather.
- **Floater**: medium range escape over a set defender; tighter than layup, lower base.

Contact/charge: if the defender is **set** (`take_charge` held, feet planted, outside the restricted arc) and the driver's capsule collides → **offensive foul**, turnover, `DEAD`. If the defender is moving or inside the restricted arc → **blocking foul**, ball stays with offense (and-one potential).

---

## 7. Defense model (`defense.js`)

Defender is a kinematic capsule with **slide tracking**, **contest**, **block**, **steal**, **take-charge**.

### 7.1 Positioning / slide tracking

The defender's ability to stay in front is a gain-controlled pursuit reduced by the handler's active shake:

```js
function update(dt, world, intent) {
  const target = idealDefensiveSpot(world);   // between handler and hoop, at cushion
  const trackQuality =
      (0.5 + 0.005*ratings.perimeterD)         // 50→0.75, 99→0.995
    * (intent.sprint ? 1.15 : 1.0)             // pressure boost (costs stamina)
    * (1 - world.handler.shakeWindow.amount)   // ankle-break term (§3.2)
    * (ratings.badges.Clamps ? 1+0.1*tier : 1);
  // move toward target with gain = SLIDE_GAIN * trackQuality
  ...
  // blow-by happens when handler.speed*Δ outpaces this gain → defender trails
}
```

Lateral slide speed > backpedal speed (forces correct angles). On-ball pressure (`Shift`) shrinks cushion (better contest, more block-by risk) and drains stamina ~2×.

### 7.2 Block

Tap `Space` near a shooter/finisher. A timed window vs the shot's apex:

```js
function tryBlock(world) {
  const dt2apex = world.shot.timeToApex;
  const timing = gaussWindow(dt2apex, BLOCK_WINDOW);          // best ≈ at release→rise
  const reach  = 0.4 + 0.006*ratings.block;
  const inRange = dist3D(defender.handPos, ball.pos) < reach;
  let p = inRange ? (0.25 + 0.5*timing) * heightFactor : 0;
  if (ratings.badges.RimProtector && shooter.inPaint) p *= 1+0.2*tier;
  if (roll() < p) { world.ballKnockedLoose = true; vfx.block(); }
  else if (timing < 0.2 && contactWithShooter) maybeFoul();   // late = foul
}
```

A block sends the ball to `LOOSE` (rebound battle), not always out of bounds — keeps play flowing.

### 7.3 Steal / swipe

`F` reaches at the ball. Success scales with the handler's **current exposure** (§3.1 — high during behind-the-back windups, low mid-crossover-protect):

```js
p_steal = clamp01(
    (0.10 + 0.006*ratings.steal)        // base
  * (0.3 + 1.4*handler.exposure)        // exposure is the big term
  * (handler.badges.UnpluckableHandle ? 0.7 : 1)
  - 0.004*handler.ratings.ballHandle ); // good handlers protect
if (miss && reachDistance small) p_reachFoul = 0.15; // reach-in foul risk
```

Success → `LOOSE`. This rewards reading the handler's move (poke during the windup), not mashing.

### 7.4 Take-charge

Covered in §6.1 — `RMB`-hold plants feet; set defender + driver contact outside restricted zone = offensive foul.

---

## 8. Attributes & badges (`ratings.js`)

### 8.1 Attribute vector (0–99, attached per character)

```js
const ATTRS = {
  // Offense
  speed, acceleration, ballHandle, shotMid, shotThree, shotClose, layup, dunk,
  shotConsistency, shotSpeed, stamina,
  // Defense
  perimeterD, steal, block, strength,
  // Meta
  contestResist, // resists opponents' contest penalty on your shots
};
```

Characters reuse golf's `characters.js` portrait system; each gets an attribute preset (e.g. a slasher: high speed/dunk/layup, low three; a sniper: high shotThree/consistency, low dunk). The lobby/character-select shows a small radar.

### 8.2 Badge system (lightweight, table-driven, *measurable*)

Each badge has a tier (0=none,1=bronze,2=silver,3=gold). Effects are pure multipliers/offsets consumed by the formulas above — **no badge is cosmetic**. Ship ~8 badges:

| Badge | Effect (cited section) |
|---|---|
| **Deadeye** | reduces contest penalty on jumpers: `pMake ×(1+0.04·tier·contest)` (§5) |
| **Shifty** | dribble shake `×(1+0.12·tier)` (§3.2) → easier blow-bys |
| **RangeExtender** | three-pt base `×(1+0.05·tier)` + softer `rangeFalloff` |
| **Posterizer** | enables contact dunks + dunk make `×(1+0.10·tier)` + defender stun (§6.1) |
| **RimProtector** | block `×(1+0.2·tier)` & opponent paint-contest `×(1+0.15·tier)` (§7.2) |
| **Clamps** | defensive slide trackQuality `×(1+0.1·tier)` (§7.1) |
| **SlitherFinish** | layup make `×(1+0.06·tier)` through traffic (§5) |
| **UnpluckableHandle** | steal chance against you `×0.7` (§7.3) |

Badge tiers are part of the character preset. A debug overlay (copy golf's `mountDebugOverlay`) prints live `pMake` inputs + active badge multipliers so tuning is data-driven, not vibes.

---

## 9. Momentum / heat (`heat.js`)

A single `heat` scalar in [−0.4, 1.0] per player.

```js
onMake(shooter):   heat = clamp(heat + (wasContested?0.35:0.20), -0.4, 1.0);
onMiss(shooter):   heat = clamp(heat - 0.10, -0.4, 1.0);
onGotScoredOn:     heat = clamp(heat - 0.15, -0.4, 1.0); // defense low
onStop(blk/stl):   heat = clamp(heat + 0.25, -0.4, 1.0);
decay each possession: heat *= 0.92;  // cools over time
```

`heat` feeds: shot `heatBonus` (§5, up to +10%), a subtle player-glow VFX at `heat>0.6` ("on fire"), and a small speed/stamina-recovery bump. It is bounded and decays, so it amplifies momentum without snowballing a blowout (important in first-to-11).

---

## 10. Difficulty tuning (CPU & assist levels)

Two orthogonal knobs, mirroring golf's `DIFFICULTIES` Gaussian-jitter model in `ai.js`:

1. **AI competence** (`ai.js`, copies `createAiGolfer`): the CPU defender/handler emits the same intent payload with difficulty-scaled noise & reaction delay:

```js
const AI = {
  rookie: { reactDelay:0.28, slideErr:0.30, contestMiss:0.35, meterErr:0.18, stealAggro:0.4 },
  pro:    { reactDelay:0.16, slideErr:0.15, contestMiss:0.18, meterErr:0.09, stealAggro:0.6 },
  allstar:{ reactDelay:0.09, slideErr:0.07, contestMiss:0.08, meterErr:0.045, stealAggro:0.75 },
  hof:    { reactDelay:0.05, slideErr:0.03, contestMiss:0.03, meterErr:0.02, stealAggro:0.9 },
};
```

The CPU "shoots" by feeding `meterErr ~ gauss()*AI.meterErr` into the same `resolveShot`, exactly as golf's AI feeds `accuracyError` into `launchShot`.

2. **Player assist** (separate, so a beginner human can have a wide green window even vs a hard AI): `greenHalf *= (assist==='casual'?1.4 : assist==='normal'?1.0 : 0.8)`. Casual also auto-aims the drive and shows a bigger meter. This decouples "how good is the opponent" from "how punishing is my input," the way 2K separates difficulty from shot-meter settings.

---

## 11. Module map & signatures (deliverables for this pillar)

```
src/sports/basketball/
  core.js          mountBasketball(host, cfg) -> unmount   // tick + possession FSM
  input.js         createInput({assist}) -> {sample(dt), attach, detach}
  ballhandler.js   createBallhandler({ratings}) -> {update, startMove, getExposure, getSpeedMul, state}
  shot.js          createShotController({onShot, ratings}) -> {update, getMeter, press, release, state}
  finishing.js     decideFinish(world,h), runDunk(world), runLayup(world)
  defense.js       createDefender({ratings}) -> {update, tryBlock, trySteal, takeCharge}
  resolve.js       pMake(args), resolveShot(world), contestLevel(s,d)
  ratings.js       ATTRS presets, BADGES table, badgeMul(name,tier,ctx)
  heat.js          createHeat() -> {onMake,onMiss,onStop,decay,value}
  ai.js            createAiBaller({difficulty,ratings}) -> {decide(dt,world)}  // intent payload
```

`mountBasketball(host, cfgOrOnExit)` follows golf's dual-signature pattern (function = onExit, object = `{mode,code,character,cpu,onExit}`), wires the menu tile in `main.js`, and is host-authoritative in MP (slot 0 runs `stepPossession`+`resolveShot`; slot 1 streams `input.sample()` and renders snapshots).

---

## 12. Feel checklist (acceptance for "is this 2K Blacktop?")

- Holding shoot shows a rising meter with a green band that **visibly shrinks** when the defender closes out + raises hands.
- A wide-open green three goes in ~80–85%; a contested green three ~25–35%; a contested *bad-timing* three <10%.
- A well-timed crossover vs a flat-footed defender produces a visible blow-by → open layup/dunk.
- A mistimed block = foul or trailing; a well-timed block sends the ball loose for a scramble.
- Streaks feel hot (glow + small bump) but never snowball the game out of reach before 11.
- Make-it-take-it + "take it back past the arc" reads correctly on every change of possession (HUD arc ring during `CLEARING`).


---

## Adversarial Critique (AAA-bar review)

**Verdict:** needs-work

### Gaps
- NETCODE FEASIBILITY IS THE WHOLE BALLGAME AND IT'S PUNTED. The design's core loop (continuous 60Hz host-authoritative sim + snapshot interpolation for the guest) is hand-waved to 'the netcode pillar.' But the existing infrastructure does NOT support it and the design never verifies this. The server (server/index.js) is request/reply over a single ws with a 25s heartbeat; there is no input/snapshot relay for any continuous sport. The author cites 'tennis is a DUMB RELAY to copy' as proof of feasibility, but the tennis relay branch (server/index.js:237) is effectively DEAD CODE: generic rooms are created at line 181 WITHOUT a `sport` field, so `room.sport===undefined`, and neither the tennis nor a future basketball dispatch branch ever fires. Tennis multiplayer doesn't actually round-trip through the server today — tennis.js is a local canvas stub. So the design rests its 'this is just like tennis' feasibility argument on a relay that has never run. A Blacktop shot-meter + live contest read at WAN latency (60-120ms) with naive snapshot interp will feel rubber-bandy for the guest defender, which is exactly the moment 2K feel lives or dies. There is no mention of input prediction, lag compensation for steals/blocks/contests, snapshot rate, interpolation buffer depth, or reconciliation. This is not a 'feel' detail; it determines whether the product is shippable at all.
- AI PATTERN IS A CATEGORY MISMATCH. The design repeatedly claims `createAiGolfer` is the template for `createAiBaller.decide(dt,world)` emitting 'the same intent payload.' It is not. ai.js exposes `planShot({ballPos,wind})` — a SINGLE turn-based decision returning {club,power,accuracyError,aimYaw}. It has no per-frame state, no notion of defending, no reaction-delay/pursuit loop, no continuous locomotion. A basketball CPU needs a real-time behavior controller (pursue, slide, decide-to-contest, time a block, pick a dribble move, read shot quality) ticked every frame. Almost none of golf's AI transfers; the 'copy createAiGolfer' framing badly understates the work and will mislead the implementer into thinking ai.js is a starting point. The DIFFICULTIES Gaussian-jitter idea transfers; the architecture does not.
- PHYSICS REUSE CLAIM IS OVERSTATED. golf/physics.js is a SINGLE-BODY world (one sphere ball + an infinite ground plane + static trimeshes). It has no rim torus, no backboard, no hoop capture geometry, no second/third dynamic body, no player capsule colliders, no character-vs-ball or character-vs-character contact, no dunk/rim-hang constraint. The design's 'physics only does real work in SHOT_LIVE/LOOSE, well within golf's budget' is true for the BALL but ignores that take-charge collisions (§6.1), block reach overlap (§7.2), and rebound battles require capsule-vs-capsule and capsule-vs-ball overlap tests that golf never does. The author even flags this in their own risks ('relies on accurate capsule overlap from the physics pillar') but then designs charge/block/steal as if those colliders exist. The rim physics for a believable in/out/rim-hang shot is a genuinely hard cannon-es problem (small fast sphere vs thin torus tunnels at 60Hz) and gets one sentence.
- THE SHOT-METER IS NOT ACTUALLY THE swing.js PATTERN. The design says it 'reuses swing.js's architecture.' swing.js's shipped default is a GESTURE swing (mouse drag down/up), and its 3-CLICK meter is the LEGACY 'click' path. The design's hold-LMB-release green-window meter is a THIRD mechanic that exists nowhere in swing.js. That's fine as a choice, but 'we re-skin swing.js's 3-click state machine' is inaccurate: swing.js's click machine is idle→power-rising→power-locked→accuracy (a bouncing meter you tap twice), which is a completely different input model from hold-and-release. The reusable part is genuinely small: the factory shape (state + getMeter() + update(dt) + onShot emit) and the attach/detach plumbing. The author should claim that and stop implying the timing math ports.
- P_make IS A MULTiplicative STACK THAT THE AUTHOR'S OWN WORKED EXAMPLE PROVES IS BROKEN. §5.1's first worked example computes an open green three at 0.408 and then BOLTS ON a `GREEN_OPEN_FLOOR` override to rescue it. That's an admission the model doesn't produce sensible numbers on its own. The floor creates a hard discontinuity at contest<0.15 (the author flags it but the fix — 'smoothstep' — isn't specified, and smoothstepping a max() against a product is fiddly). Deeper problem: a product of 6+ independent [0,1] factors compounds toward zero, so EVERY shot trends low and the whole table has to be propped up with floors and >1 badge multipliers. This is hard to tune and brittle. A logit/odds model (sum log-odds of timing, contest, rating, range, stamina, then sigmoid) is the standard way to make 'green=lock, contested=coinflip' fall out naturally without floor hacks, and is no more code.
- MANY CONSTANTS ARE PLACEHOLDERS DRESSED AS TUNED VALUES. BASE_MAKE/CONTEST_K/TIMING_SIGMA/badge multipliers are presented with confident worked examples, but the worked examples themselves don't hit the stated targets ('~80-85% open green three') without the floor patch. CONTEST_K.three=0.62 with contest capped at 1.4 can drive contestPen negative (1 - 0.62*1.4 = -0.13), relying on clamp01 to save it — meaning a hard-contested three's contest term is pinned at 0 and stops responding to defender quality differences in that regime. The model has dead zones.
- CONTROL SCHEME IS OVERLOADED FOR KB+M AND WILL FIGHT ITSELF. §2.1 maps shoot=hold-LMB, pump-fake=tap-LMB(<120ms), drive=hold-RMB, step-back=RMB+S, crossover=A/D+Q, behind-back=Q+S, hesi=C-tap, size-up=C-hold, spin=Shift+Q, plus aim=mouse-X-drag (RMB or always-on). LMB is simultaneously the shoot meter AND, on a short tap, a pump fake — so every shot attempt's first 120ms is ambiguous and the meter can't start rising until the tap-vs-hold timer resolves, adding input latency to the single most important verb. RMB is both 'aim' and 'drive' and 'step-back' and 'take-charge.' On a trackpad (the author's own open question) this is unworkable. This is not a AAA-feeling control map; it's a list of every move bound to the fewest keys.
- POSSESSION FSM HAS UNDEFINED-BEHAVIOR HOLES. stepPossession references world.deadGivesBallToDefense, FLIP, SAME, beginDead, onMade, onMiss, onGather, resetToCheck, checkGameOver as if defined, but several (FLIP/SAME) are bare identifiers with no definition and the SHOT_LIVE→onMiss path sets LOOSE while MADE_BASKET handles make-it-take-it — yet there is no state for a made-basket-that-also-needs-take-it-back vs make-it-take-it-keeps-ball-at-arc reconciliation. 'Take it back' is only enforced via a shot-attempt check; a player can DRIVE to the rim and lay it in without ever clearing if the layup isn't routed through the same clearedArc gate (the gate is only described for 'shot attempt'). Layups/dunks must also be blocked pre-clear.
- HEAT + GREEN_OPEN_FLOOR + BADGES STACK CAN EXCEED INTENDED CEILINGS AND UNDERMINE THE 'no snowball' claim. heatBonus up to +10%, Deadeye negating contest, RangeExt +15% (gold), and the open-green floor all multiply. The design asserts heat 'never snowballs a blowout' but provides no analysis; in first-to-11 with make-it-take-it, a hot shooter who keeps possession on makes can run an uninterrupted 7-0 with elevated make%. make-it-take-it + heat is structurally a snowball amplifier, and the only damper is heat*=0.92 per possession — which barely cools during an unbroken scoring run because possessions are short. The acceptance checklist asserts the opposite of what the math implies.

### Must-Fix (applied in synthesis)
- Before any feel work, PROVE the netcode is real: (a) Fix the server so non-golf rooms actually carry `sport` (the generic room at server/index.js:181 omits `sport`, so the tennis relay at line 237 never fires today). (b) Add the `room.sport==='basketball'` branch as a genuine relay and write the server.test.js two-client protocol test FIRST, exactly like the existing harness, asserting input(guest->host) and snapshot(host->guest) round-trip. (c) Specify snapshot rate (e.g. 15-20Hz), interpolation buffer (100-150ms), and that the GUEST runs its OWN local shot meter and local movement prediction with only the OUTCOME host-authoritative. Without this written down, the meter/contest reads the design depends on will feel laggy and the pillar's premise collapses.
- Replace the multiplicative P_make with a log-odds (logit) model: logit = b_type + w_timing*timingTerm + w_contest*(-contest) + w_rating*(rating-50) + w_range*(-rangeDeficit) + w_stam*(stamina-1) + heat; P=sigmoid(logit), clamp [0.02,0.985]. Calibrate so open-green-three≈0.83, contested-green-three≈0.30, contested-bad-timing<0.10 fall out WITHOUT any GREEN_OPEN_FLOOR hack and with no discontinuity. Delete GREEN_OPEN_FLOOR. Keep the live debug overlay as a hard requirement (the author already flagged it).
- Stop claiming `createAiGolfer.planShot` and golf/physics.js are drop-in templates. Rewrite §10 and §3-7 to state explicitly: the AI needs a NEW per-frame behavior controller (only the Gaussian-jitter difficulty idea ports), and the physics pillar must ADD player capsule colliders, a ball-vs-capsule contact, and a rim/backboard collider set that golf does not have. Specify the rim as a ring of small static spheres or a torus-approximation and require a high substep count or CCD for the small-fast-ball-vs-thin-rim tunneling problem.
- Disambiguate the input scheme. Move pump-fake OFF the shoot button (it adds latency to every real shot via the tap-vs-hold timer) — bind it to a separate key. Pick ONE meaning for RMB. Provide an explicit trackpad-viable fallback (the author listed this as an open question; for a shippable browser game it must be answered, not deferred). Reduce the move list to what's bound cleanly; a smaller, crisp move set reads more AAA than a maximal one with overloaded chords.
- Close the FSM: define FLIP/SAME/beginDead/resetToCheck/onMade/onMiss/onGather/checkGameOver concretely (or as referenced helpers with signatures), and route ALL scoring attempts (jumper, three, layup, dunk) through the clearedArc gate so a player cannot score off a change-of-possession without taking it back past the arc. Add the missing transition for a made basket that requires re-check.
- Fix the contest math dead zone: CONTEST_K*contest can exceed 1 (0.62*1.4>0.86, and stacked terms push contestPen negative), so above a threshold defender quality stops mattering. In the logit reformulation this disappears, but if the multiplicative model is kept, bound the contest term so it stays monotonic and responsive across the whole [0,1.4] range.
- Provide an actual no-snowball analysis for heat + make-it-take-it (simulate a worst-case run to 11), and either cool heat faster, cap consecutive make-it-take-it possessions' heat contribution, or gate heat so it can't compound with badge+floor multipliers. The acceptance checklist asserts 'never snowballs' — that must be demonstrated, not assumed.

### Feasibility Notes
The single-dynamic-ball + two-kinematic-capsule render/sim budget IS realistic for browser WebGL/cannon-es — golf already steps a full CANNON.World every frame for one body, and the procedural-dribble-anchor approach (no dynamic ball during dribble) is the right call to avoid jitter and cost. The kinematic-players/dynamic-ball-on-release model is sound. The infeasible/under-budgeted parts are: (1) the NETCODE — this is the real risk and the existing 'tennis relay' it leans on is currently dead code (rooms never set `sport`), so it has never actually run; treat host-authoritative real-time over this stack as net-new work with prediction+interpolation, not a copy job. (2) RIM physics — small fast sphere vs thin torus is a known cannon-es tunneling hazard; budget CCD/substeps or fake the rim with a capture volume + scripted rattle rather than rigid-body rim-outs. (3) capsule-vs-capsule collisions for charges/blocks — net-new, golf has none. Where to trim scope to stay shippable: ship ONE clean dribble move set (cross, behind-back, hesi) not five; make dunks a scripted capture animation (no rigid-body contact dunk / Posterizer stun in v1); cut take-charge/offensive-foul in v1 (it's the most collider-fragile mechanic); start with a fixed broadcast camera (defer possession-swapping camera). The feel core — hold-release meter with a visibly-shrinking green band driven by a per-frame contest scalar — is the right 80/20 and is cheap; protect that and the logit P_make, and cut the badge/heat/posterizer surface area until the netcode is proven.

