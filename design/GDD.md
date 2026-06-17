# Master Game Design Document — 2K Schwartz "Blacktop" 1v1 Half-Court Basketball

# Master GDD — "Blacktop": 1v1 Half-Court Basketball for 2K Schwartz

**Status:** Implementation-ready master design. **Quality bar:** NBA 2K "Blacktop" mode, 1v1, AAA-feeling within a browser WebGL/cannon-es budget. **Module root:** `src/sports/basketball/`. **Pattern law:** sports COPY the golf patterns; there is NO shared base class. Where this doc cites golf, the citation has been verified against the live code (`src/sports/golf/`, `server/index.js`).

This document is the single authority that resolves conflicts between the seven pillar designs (gameplay, rules, avatars/animation, court/visual, architecture, netcode, ui/ux, audio) and folds in every pillar's critique `mustFix`. Where pillars disagreed, the resolution is stated inline with a **RESOLVED** tag.

---

## 1. Vision & Pillars

**Vision.** Two players, one hoop, golden-hour blacktop. The feel is *reads beat reflexes, but reflexes matter*: you create separation with a crisp dribble move, you rise into a shot meter whose green window visibly shrinks as the defender closes out, and the ball arc, the swish (or the chain rattle), the crowd swell, and the broadcast lower-third all confirm the bucket. It must read as "a place and a game," not a tech demo — even on the low-quality render path.

**Design pillars (the feel contract):**

1. **Animation-driven control, physics-only-on-release.** Dribbling and shooting are kinematic state machines that drive the ball's target position. The ball goes *dynamic* (handed to cannon-es) only at a release/loose/rebound moment. Exactly the golf model: the swing controller is a pure state machine; physics owns the ball only after `launchShot`.
2. **One meter to rule shooting.** A hold-and-release green-window timing meter, re-skinning the `swing.js` controller-factory architecture (phase machine + `getMeter()` poll + `onShot` emit). The shrinking green band under contest is ~80% of "the 2K feel" and is cheap.
3. **Host-authoritative, one truth.** Slot 0 runs the single authoritative cannon-es sim (ball, both players, collisions, fouls, possession FSM, scoring) and broadcasts snapshots. Slot 1 streams input and renders interpolated snapshots with local self-prediction. The server stays a dumb relay, exactly like tennis.
4. **One payload shape everywhere.** Human input, AI output, and network input all produce the same `InputFrame`, routed through one `applyInputs(...)`. Outcomes are decided in one place (`resolve.js`) by one function (`pMake`).

**v1 scope discipline (applies every pillar's "trim" guidance):** ship one canonical golden-hour lot; one clean dribble move-set (crossover, behind-the-back, hesi); scripted dunks (no rigid-body contact-dunk/posterizer-stun); cut take-charge/offensive-foul; fixed broadcast camera framing with a two-subject constraint; **single-player + vs-CPU FIRST**, online as the second milestone gated on guest self-prediction; the per-possession-lockstep net mode wired alongside realtime as the shippable floor.

---

## 2. Core Loop

```
MENU TILE (Blacktop) → LOBBY (mode/rules/character/loadout) → MATCH:
  ┌──────────────────────────────────────────────────────────────┐
  │ CHECK-BALL (top of key)                                       │
  │   defender checks → ball live                                 │
  │ LIVE OFFENSE: dribble / create separation / read defender     │
  │   ├─ shoot (meter) ──► SHOT IN AIR ──► MAKE ──► make-it-take-it│
  │   │                                  └► MISS ──► LOOSE/rebound │
  │   ├─ drive ──► layup / dunk / floater (finish decision)        │
  │   └─ turnover (steal / block→loose / OOB)                      │
  │ CHANGE OF POSSESSION → CLEARING ("take it back" past the arc)  │
  └───────────────► repeat until FIRST TO 11, WIN BY 2 ───────────┘
  → GAME SUMMARY (box score, Run it back / Menu)
```

Per-point loop: **check → create → finish/contest → resolve → reset (make-it-take-it or clear-it)**. Streetball scoring: inside the arc = **1**, beyond the arc = **2**. First to 11, win by 2; hard cap 21 (anti-stall guard).

---

## 3. Controls (full binding table)

Keyboard + mouse primary; gamepad optional (mirror `swing.js` `pollGamepad`). Movement is **camera-relative WASD** (camera behind the offensive basket → "W = toward hoop"). **RESOLVED (gameplay mustFix #4):** pump-fake moved OFF the shoot button (no tap-vs-hold latency tax on every real shot); `RMB` has exactly ONE meaning per role; move-set trimmed to a crisp set; a trackpad fallback is mandatory.

You only ever hold one role, so offense and defense share physical keys.

### 3.1 Offense

| Action | Binding | Notes |
|---|---|---|
| Move | `W A S D` | camera-relative, normalized to unit disk |
| Sprint / push pace | `Shift` (hold) | drains stamina; enables speed-burst out of moves |
| **Shoot (meter)** | hold `LMB` → release | hold = gather/meter rising; release in green = make. The `swing.js` machine. |
| Pump fake | `Q` (tap) | dedicated key — NOT the shoot button |
| **Drive / gather to rim** | `RMB` (hold) while moving toward hoop | the ONLY meaning of RMB on offense; on entering paint → finish decision |
| Crossover | `E` | hand-swap lateral burst |
| Behind-the-back | `C` | requires Ball-Handle ≥ 55 |
| Hesitation ("hesi") | `Space` (tap) | decelerate then explode; freezes a pressing defender |
| Step-back | `RMB` + back-flick (`S`) at gather | creates space → open jumper |
| Check-ball accept | `Space` (in CHECK phase only) | context-swaps with hesi (no conflict: hesi only in LIVE) |

Cut from v1 move-set: spin, size-up, between-the-legs (defer to polish).

### 3.2 Defense

| Action | Binding | Notes |
|---|---|---|
| Move / slide | `W A S D` | lateral slide faster than backpedal |
| On-ball pressure | `Shift` (hold) | tighter cushion, faster contest, more blow-by risk, 2× stamina drain |
| **Contest / hands up** | hold `LMB` | raises contest level vs a shooter in real time (narrows their green band) |
| **Block** | `Space` (tap) | timed vertical/swipe; mistime = trailing/foul |
| **Steal / swipe** | `F` | reach at the ball; scales with handler exposure; miss → reach-foul chance |

### 3.3 Trackpad / no-mouse fallback (mandatory)

`LMB`→`J`, `RMB`→`K`, aim via `← →` arrows. A single `inputScheme: 'mouse'|'trackpad'` in settings remaps at the `input.js` layer; everything downstream still sees the same `InputFrame`. Aim drag (mouse-X) is replaced by discrete arrow-yaw steps on trackpad.

---

## 4. Systems: Shooting, Dribbling, Dunking, Defense + the Make-Probability Model

### 4.1 Shot meter (`shot.js`, built on the `swing.js` pattern)

Controller factory with an internal phase machine, a `getMeter()` the HUD polls, an `update(dt)`, and an `onShot(payload)` emit — same shape as `swing.js`. Phases: `idle → gather (LMB held, meter rising) → release (LMB up) → resolved`.

```js
const SHOT_TIMING = {
  jumper:  { riseTime: 0.62, greenCenter: 0.88, greenHalf: 0.060 },
  three:   { riseTime: 0.70, greenCenter: 0.90, greenHalf: 0.045 }, // tighter beyond arc
  floater: { riseTime: 0.48, greenCenter: 0.85, greenHalf: 0.070 },
  layup:   { riseTime: 0.40, greenCenter: 0.82, greenHalf: 0.090 }, // forgiving
};
```

`greenHalf` (the effective green window) widens with the shooter's consistency/Deadeye badge and assist setting, and **narrows with contest, stamina drain, and range** — this is the entire skill/difficulty knob and the live feedback the HUD draws.

Emitted payload (universal shape, mirrors `swing.js` `emitShot` and AI `planShot`):

```js
onShot({ type, meterErr, isGreen, rangeM, fromBeyondArc, shooterPos, aimYaw, source }); // source: 'human'|'ai'|'net'
```

`getMeter()` returns `{ phase, value, greenLo, greenHi, contestTint, shotType }` so the HUD draws a vertical bar + green band that visibly shrinks/reddens as contest rises.

### 4.2 The make-probability model (`resolve.js`) — LOGIT, not multiplicative

**RESOLVED (gameplay mustFix #2 & #6):** the multiplicative `P_make` and the `GREEN_OPEN_FLOOR` hack are DELETED. They produced a contest dead-zone (`CONTEST_K·contest` could exceed 1 and push terms negative) and a discontinuity at the open/contested boundary. The model is a **log-odds (logit) sum through a sigmoid** — monotonic, responsive across the whole contest range, no floor hack, no cliff.

```js
function pMake({ type, meterErr, isGreen, contest, rating, rangeM, stamina, heat, badges }) {
  const e = Math.max(0, Math.abs(meterErr) - effGreenHalf(type, contest, stamina, badges));
  const timingTerm = isGreen ? 1.0 : Math.exp(-(e*e) / (2*TIMING_SIGMA*TIMING_SIGMA)); // 0..1
  const rangeDeficit = Math.max(0, rangeM - comfortRange(type, badges));               // m beyond comfort

  let logit =
      B_TYPE[type]                          // base intercept per shot type
    + W_TIMING   * timingTerm               // skill term
    + W_CONTEST  * (-contest)               // contest in [0..1.4], monotonic
    + W_RATING   * (relevantRating(type, rating) - 50) / 10
    + W_RANGE    * (-rangeDeficit)
    + W_STAM     * (stamina - 1)            // gassed → negative
    + W_HEAT     * heat;                    // [-0.4..1.0]

  // badges shift the logit (additive in log-odds = clean, no discontinuity):
  if (badges.Deadeye)  logit += badges.Deadeye  * 0.25 * contest;       // negates part of contest
  if (badges.RangeExt && fromBeyondArc) logit += badges.RangeExt * 0.30;
  if (badges.SlitherFinish && type==='layup') logit += badges.SlitherFinish * 0.35;

  return clamp(sigmoid(logit), 0.02, 0.985); // never 0, never automatic
}
```

**Calibration targets (tune the weights/intercepts to hit these, verified offline like golf verified carries):**

| Situation (rating 75, full stamina, no heat/badge) | Target P |
|---|---|
| Open (contest 0) green three | **≈ 0.83** |
| Contested (0.7) green three | **≈ 0.30** |
| Contested + bad timing three | **< 0.10** |
| Open green mid jumper | ≈ 0.62–0.68 |
| Open layup (green) | ≈ 0.78 |
| Wide-open dunk | ≈ 0.95 |

Resolution is committed at the **release event frame** (§7), so contests/blocks can still flip it. **The live debug overlay printing every `pMake` input + active badge shifts is a hard requirement, not optional** (copy golf's `mountDebugOverlay`).

### 4.3 Contest level (per frame, defender-driven)

```js
function contestLevel(shooter, defender) {
  const d = dist2D(shooter.pos, defender.pos);
  const closeout = clamp01((CONTEST_RANGE - d) / CONTEST_RANGE);   // CONTEST_RANGE = 2.0 m
  const handsUp  = defender.contestHeld ? 1.0 : 0.45;              // LMB-hold = full
  const facing   = facingDot(defender, shooter);                  // in front of shooter?
  const vertical = defender.airborne ? 1.15 : 1.0;                // contest at apex
  let c = closeout * handsUp * facing * vertical;
  if (defender.badges.RimProtector && shooter.inPaint) c *= 1 + 0.15*tier;
  return clamp(c, 0, 1.4);
}
```

The host has exact positions of both players every sim tick, so contest is trivially authoritative — neither client reports "I was contested." This is the big payoff of host-authority for a contest-centric sport.

### 4.4 Dribble engine (`ballhandler.js`)

Kinematic capsule with a handle state. The ball is parented to a per-hand dribble anchor (procedural bounce, NOT a dynamic body — avoids cannon-es jitter and net desync). Each move is a short timed animation that (a) moves the anchor, (b) bursts velocity, (c) opens a `defenderShakeWindow` that degrades the defender's lateral tracking.

```js
const MOVES = { // v1 trimmed set
  crossover:  { dur:0.32, burst:1.18, shake:0.45, exposure:0.55, stam:4, reqHandle:0  },
  behindback: { dur:0.40, burst:1.10, shake:0.55, exposure:0.50, stam:5, reqHandle:55 },
  hesi:       { dur:0.45, burst:1.30, shake:0.60, exposure:0.30, stam:5, reqHandle:0  },
};
shake_eff = move.shake * (0.6 + 0.008*ratings.ballHandle) * shiftyBadgeMul * timingBonus;
```

A blow-by is emergent (handler speed × shake outpaces defender recovery), not scripted. `getExposure()` (0..1) feeds steal vulnerability — high during a behind-the-back windup, low mid-crossover-protect.

### 4.5 Finishing (`finishing.js`)

`RMB`-hold while moving toward the rim triggers a drive; crossing into the paint above a speed threshold makes a finish decision:

```js
function decideFinish(world, h) {
  const lane = laneOpenness(world);                                  // 0..1
  const canDunk = h.ratings.dunk >= DUNK_GATE && h.speed > DUNK_SPEED
               && lane > 0.35 && h.stamina > 0.25;
  if (canDunk && lane > 0.6) return 'dunk';        // wide-open lane → scripted dunk
  if (lane < 0.25) return 'floater';               // wall of defender → floater
  return 'layup';
}
```

**RESOLVED (court & avatar trim):** dunks are a **scripted capture animation** in v1 (rim-hang clip + camera punch-in + dust), NOT a rigid-body contact event. Posterizer-stun, contact dunks, and take-charge/offensive-foul are deferred — they are the most collider-fragile mechanics. Layups (forgiving meter) remain vulnerable to block and steal-on-gather.

### 4.6 Defense model (`defense.js`)

Slide tracking is gain-controlled pursuit reduced by the handler's active shake:

```js
trackQuality = (0.5 + 0.005*ratings.perimeterD)      // 50→0.75, 99→0.995
             * (sprint ? 1.15 : 1.0)
             * (1 - handler.shakeWindow.amount)        // the ankle-break term
             * (badges.Clamps ? 1 + 0.1*tier : 1);
```

- **Block** (`Space`): timed vs the shot's apex window (`block_window_open/close` clip events, §7). Success → ball goes **LOOSE** (rebound scramble), not always OOB. Mistime → trailing or foul.
- **Steal** (`F`): success scales primarily with `handler.exposure`; reward reading the move (poke during the windup). Miss at close range → reach-in foul chance.
- Take-charge: **cut from v1**.

---

## 5. Attributes & Badges (`ratings.js`)

**RESOLVED (ui/ux mustFix #10):** the `{attrs, badges, badge tiers}` catalog below is the SINGLE canonical source consumed by gameplay, AI, the loadout screen, and the HUD badge rail. Badge ids must match exactly across pillars.

### 5.1 Attribute vector (0–99)

`speed, acceleration, ballHandle, shotMid, shotThree, shotClose, layup, dunk, shotConsistency, shotSpeed, stamina, perimeterD, steal, block, strength, contestResist`.

**Loadout screen (`loadout.js`):** a budget *pool* (not free sliders) of 6 surfaced attributes — Speed, Shooting, Inside, Defense, Stamina, Ball-handling — allocated from a fixed point pool (~360, avg 60). Up to 3 badges from a badge-point pool (~8; Bronze1/Silver2/Gold3/HOF4). Character presets reuse golf's `characters.js` portrait system; each preset is a body-type + attribute + badge bundle.

### 5.2 Badge catalog (8 badges, all measurable, additive in log-odds)

| Badge | Effect (cites §) |
|---|---|
| **Deadeye** | reduces contest penalty on jumpers: `logit += tier·0.25·contest` (§4.2) |
| **RangeExtender** | three-pt logit `+= tier·0.30` + larger `comfortRange` |
| **SlitherFinish** | layup logit `+= tier·0.35` through traffic |
| **Shifty** | dribble shake `×(1 + 0.12·tier)` → easier blow-bys (§4.4) |
| **Clamps** | defensive slide `trackQuality ×(1 + 0.1·tier)` (§4.6) |
| **RimProtector** | block `×(1+0.2·tier)`, paint-contest `×(1+0.15·tier)` |
| **Posterizer** | dunk emphasis (cosmetic priority in v1; full effect deferred) |
| **UnpluckableHandle** | steal chance against you `×0.7` |

A debug overlay prints live `pMake` inputs + active badge shifts so tuning is data-driven.

### 5.3 Momentum / heat (`heat.js`) — bounded, no-snowball

A single `heat` scalar per player in `[-0.4, 1.0]`, fed as `W_HEAT*heat` into the logit (capped contribution).

```js
onMake:       heat = clamp(heat + (contested?0.30:0.18), -0.4, 1.0);
onMiss:       heat = clamp(heat - 0.10, -0.4, 1.0);
onGotScored:  heat = clamp(heat - 0.12, -0.4, 1.0);
onStop:       heat = clamp(heat + 0.22, -0.4, 1.0);  // block/steal
each possession: heat *= 0.90;                        // faster cool than the original 0.92
```

**RESOLVED (gameplay mustFix #7 — no-snowball analysis):** worst-case run-to-11 simulation requirement. With make-it-take-it a hot shooter could in theory run the table. Mitigations, all shipped: (1) heat decays each possession at 0.90 and caps at +1.0 → `W_HEAT*1.0` is bounded to a small logit nudge (calibrate so max heat ≈ +8% absolute make at the 50% region, never compounding past it); (2) the logit model has NO floor and NO multiplicative stacking, so heat + badges cannot multiply into a lock; (3) defender pressure/contest scales make-difficulty independently of heat. A run-simulation script (offline, like the carry-sim) must demonstrate that even a 99-rated hot shooter facing a 75 defender on make-it-take-it has expected-buckets-per-possession < 0.62, i.e. the trailing player gets the ball back regularly. This must be *demonstrated*, not asserted, before ship.

---

## 6. The 1v1 Ruleset (the state machine, `rules.js`)

The entire streetball ruleset is **one pure, serializable reducer** `nextState(state, event) -> state`, run ONLY on the host inside the rAF tick. No Three.js/cannon/DOM; unit-testable in `node:test` like `clubs.test.js`. The sim produces low-level **events**; the reducer produces match-flow state; the full `match` object is the authoritative payload embedded in host→guest snapshots.

### 6.1 Phases

`PRE_GAME, CHECK_BALL, LIVE, MADE_BASKET, CLEARING, DEAD_BALL, INBOUND, FOUL_DEAD, FREE_THROW (flag-gated, stubbed v1), GAME_OVER`.

**RESOLVED (rules mustFix #2):** `CHANGE_POSSESSION` is NOT a phase — it is a transition helper `toChangePossession(s, newOff, reason)` that sets fields and tail-calls into `CLEARING` within one `nextState` invocation, so the guest never renders a half-state. Delete it from the enum.

### 6.2 Events (sim → reducer)

`TICK{dt}, MATCH_START{firstPossession}, CHECK_REQUESTED, CHECK_ACCEPTED, SHOT_RELEASED{slot,fromBeyondArc}, BALL_THROUGH_HOOP, SHOT_MISSED, REBOUND_SECURED{slot}, STEAL{slot}, TURNOVER{slot,reason}, BALL_OUT_OF_BOUNDS{lastTouchedBy,spot}, BALL_INBOUNDED, BALL_CROSSED_ARC{slot}, BACKCOURT_VIOLATION, FOUL_CALLED{by,on,shooting,onMake}, FREE_THROW_RESULT{slot,made}, SHOT_CLOCK_EXPIRED, STALL_EXPIRED, RESET_MATCH`.

**RESOLVED (rules mustFix #3 & #10):** `BALL_INBOUNDED` is added so DEAD_BALL/INBOUND are escapable (was a soft-lock bug). `FOUL_CALLED` carries `onMake` so the and-1 is differentiated (see §6.5).

### 6.3 Key transitions (correctness-critical)

- **Take-it-back gate (the streetball rule):** on ANY change of possession, `toChangePossession` sets `mustClear=true, phase=CLEARING`. **EVERY scoring path** (jumper/three/layup/dunk → `BALL_THROUGH_HOOP`) is routed through the `mustClear` gate: a basket while `mustClear===true` scores **no points** and flips possession again. `BALL_CROSSED_ARC{slot===possessionSlot}` clears the gate → `LIVE`. (rules mustFix #5.)
- **Make-it-take-it:** on a clean make, `MADE_BASKET → (deadTimer) → CHECK_BALL` with possession UNCHANGED and `mustClear=false` (the ensuing check re-spots at the arc).
- **Offensive rebound after miss:** **RESOLVED (rules mustFix #4)** — ship the 2K-ranked default `reclearOnOffensiveRebound = ON`. A defensive board = change of possession (→ CLEARING). An offensive board sets `mustClear=true` (must take it back) — exposed as a named ruleset flag, defaulting ON.
- **Win check:** **RESOLVED (rules mustFix #5)** — a single `resolveAfterScore()` helper calls `isGameOver()` from EVERY scoring path (made basket AND free throw), so FT-decided and future scoring paths can end the game. `isGameOver = hi >= target && (hi - lo) >= winBy`. Deuce logic (10–10 → play on, 12–10 → over) falls out naturally.

### 6.4 seq, dedup, determinism

**RESOLVED (rules mustFix #6 & #11):** `seq` is incremented **once** at the end of `nextState` if anything material changed (phase/score/possession/mustClear); `lastBasket.seq` is set to that final value. Sim-emitted events carry monotonic `id` and are deduped via `id <= lastEventId`; **reducer-derived events** (`SHOT_CLOCK_EXPIRED`, `STALL_EXPIRED`, the computed clear/possession tail-calls) carry NO `id` and are exempt from the dedup guard (a test asserts a derived event after a high-id sim event is not swallowed). The reducer reads NO wall clock, NO RNG, NO globals — time enters only via `TICK.dt`; the only match randomness (first-possession coin flip) is computed once by the host at `PRE_GAME` and shipped in the snapshot.

### 6.5 Fouls / and-1 (v1)

**RESOLVED (rules mustFix #9):** ship `fouls: 'possession'` (fouled team keeps ball, checks at top — no FT phase) BUT differentiate via `FOUL_CALLED.onMake`:
- **shooting foul on a make** → count the basket (and-1!) + offense keeps ball + check. The marquee AAA moment; cheap, no FT phase.
- shooting foul on a miss → offense keeps ball + check.
- common foul → offense keeps ball + check.

`FREE_THROW` phase remains stubbed behind `fouls:'freeThrow'`. `shotClock:false`, `stall:false` are v1 defaults.

### 6.6 Check-ball / clear authority over the net

Phase transitions are host-authoritative and carried in `snapshot.r`. The check handshake is the only netcode-arbitrated control: guest sends `check-ready`; host sends `check-ball`; **the host must NOT act on `LIVE` until it estimates the guest has rendered `LIVE`** (hold host go-live by the interpolation delay or until the guest's `ackSnap` confirms the LIVE snapshot) — otherwise the host gets a free jump on every check (netcode mustFix #5).

---

## 7. Game Feel & Animation

### 7.1 Rig & animation system

Both players are **procedural bone-hierarchy humanoids extending golf's `buildGolfer`** (a tree of `THREE.Group` joints posed by writing `.rotation`), NOT glTF: zero asset pipeline, matches the art style, proven in-budget. New: a root that translates/yaws around the court, a per-hand `ballAnchor` (reparentable ball carrier, the `gripPivot` trick), `ankle` IK targets, and independent head yaw.

Modules: `characters.js` (rig only), `animator.js` (the state machine — the expanded `swing.js` fused with the golf pose-tween), `clips.js` (authored keyframe pose-target clips + event-frame metadata), `ik.js` (2-bone analytic IK), `playerctl.js` (human → `InputFrame`), `defenderAI.js` (CPU → same `InputFrame`).

### 7.2 Layer precedence (defined BEFORE building — avatar mustFix #3)

Resolution order per joint group: **procedural locomotion base → masked action clip (ease-in/out blend) → procedural overrides (look-at, dribble hand) → IK pass last.** IK foot-lock is **DISABLED** for any leg the active clip's mask owns AND whenever `ctx.grounded === false`. The airborne case is wired into `evalLocomotion`/`solveFootIK` so jumpshot/dunk/layup legs are clip-driven, never floor-locked (kills the "IK stomps the jump into the floor" bug). Ground is flat (`footY = 0`) — a free simplification over golf's heightfield.

**v1 trim (avatar feasibility):** ship action-owns-whole-body cross-fade (golf's model) first; add per-joint mask BLENDING only if dribble-bounce-during-jog actually needs it. Ship ~6 hero clips: **jumpshot, layup, dunk, block, steal, crossover** (+ procedural idle/jog/sprint/slide/dribble). Defer floater/behind-back/posted-up/celebrate. Skip the wrist Group and neck-yaw initially. Provide 2–3 FULLY authored example clips (jumpshot, layup, defensive_slide) with every keyframe value, plus an in-browser pose-scrubber (`?scrub` param stepping `actionT`) so clips tune without Blender. **This authoring is critical-path work, not a footnote.**

### 7.3 Animation timing IS gameplay (the core mechanic)

A shot/layup/dunk does NOT resolve until its `release` event frame fires (the `swing.js` `onShot` analog). The meter result is *latched at input*; the make/miss `pMake` roll happens at `release`. Event handlers (host-authoritative):

| Event | Sim action |
|---|---|
| `release` | detach ball from hand → spawn free cannon-es body toward hoop; **`pMake` decided here** |
| `block_window_open/close` | defender hand is an active block volume only between these frames |
| `steal_active/done` | reach hand is a steal volume vs the carry |
| `ball_switch_hands` | move ball anchor L↔R (drives steal-exposure windows) |
| `rim_contact` (dunk) | camera shake + audio + force ball through |
| `land` | re-enable locomotion; contested landing → `bump_react` |

**RESOLVED (avatar mustFix #1 — determinism):** action clocks advance inside a **fixed-step accumulator reusing the verified `physics.js` `FIXED_DT = 1/60, MAX_SUBSTEPS = 6`** (NOT 1/120 — that was an unverified invention; the live code is 1/60). Event frames are evaluated per fixed substep so `release`/`block_window` fire on a deterministic substep boundary regardless of host FPS. Timing is host-authoritative; the guest trusts it.

### 7.4 Ball-in-hand vs free-ball

Two states switched at event frames: **CARRIED** (kinematic, animator-owned; cannon body sleeping/not stepped) and **FREE** (dynamic, cannon-es-owned; render follows `physics.ball.position` like golf). Handoff at `release`/steal/rebound reads the hand anchor world transform, sets body position+velocity, wakes it dynamic. The clean blend point is the release apex.

**RESOLVED (avatar mustFix #4 — dribble ball authority):** the dribble ball is host-authoritative. The host includes `ball XZ + dribbleY` in the snapshot (a few bytes) so both clients render the SAME ball; ALL steal-vulnerability windows live in host sim state that is broadcast. The guest's locally-phased dribble is render-cosmetic only and never drives an outcome. (This also resolves the "sim places ball" vs "guest computes phase locally" contradiction.)

---

## 8. Art Direction & Camera

### 8.1 The court (one fixed golden-hour lot)

1 unit = 1 m, +Y up, court at y=0, hoop at +Z. Design in feet (`FT = 0.3048`). Single source of truth `COURT` in `court-constants.js` — **`ARC_RADIUS` is imported by BOTH the court/sim and `rules.js`** so the painted line and the rule line are literally the same number (a mismatch soft-locks CLEARING — rules risk).

NBA half-court dims: width 50 ft (15.24 m), depth 47 ft (14.33 m), rim 10 ft (3.048 m), rim inner Ø 18 in (0.4572 m), backboard 72×42 in, 3-pt arc 23.75 ft (7.24 m). Floor is a lightly displaced slab (±1.5 cm asphalt waviness, ~8k tris, 1 draw).

**RESOLVED (court mustFix #4 — line/displacement):** court markings are rendered into the asphalt material's OWN color/roughness maps on a flat sub-region (no separate offset plane, no z-fight). Micro-displacement applies ONLY outside the painted footprint. One 2048² vector-drawn `CanvasTexture` (arc/key/circle/hashes + faded/cracked wear via `destination-out`), `anisotropy 16`.

Hoop (`hoop.js`, the hero prop, ~6–8 draws): pole+gooseneck (merged), `MeshPhysicalMaterial` transmission glass backboard (quality-gated; falls back to plain transparent), orange chrome rim torus, and a **verlet nylon net** (12 strands × 6 nodes × 3 iters, `swish(ballVel)` on a make — the money visual). **Rim collider = ring of 12–16 static `CANNON.Sphere`s** (stable rim-rattle, no thin-torus tunneling), backboard = one static box. The net is NOT a collider; the make is a geometric downward-crossing sensor (§9).

### 8.2 Lighting, post, fallback

Copy golf's `visuals.js` (Sky + PMREM IBL + sun + fog + composer: RenderPass→SSAO→Bloom→ColorGrade→SMAA→OutputPass), retuned for golden hour (sun elevation 12°, warm amber, tight static shadow frustum since the court never moves — verified golf values: exposure 1.0, `envMapIntensity ≈ 0.30`, SSAO 0.001/0.04, shadow bias −0.0002, normalBias 0.03). Asphalt/matte metal `envMapIntensity 0.35`; glass/chrome 1.0–1.5.

**RESOLVED (court mustFix #3 & #7 — player look + low-path fallback):** even on the no-composer (low) path the scene must read as "a place": bake AO into the asphalt color map; ship a **faked soft contact-shadow quad** (blurred radial alphaMap) under each player AND the ball so grounding survives; add a cheap rim-light hemi tint to separate players from asphalt; add a single-material fullscreen vignette/grade (not a composer pass). The hero court-tag graffiti is the framed focal point.

**RESOLVED (court mustFix #6 — player shadows):** "court never moves" does NOT buy stable *player* shadows. Players cast a single blob/contact shadow (the quad above), NOT full shadow-map casters, at 6–12 m distance — saves the second-humanoid shadow pass and removes swimming long-shadow edges.

**v1 cuts (court trim):** night/dusk time-of-day + floodlight spots, chain-net variant, replay orbit cam, heat-shimmer/chromatic aberration, multi-skin courts. One canonical golden-hour lot.

### 8.3 Camera — the two-subject 1v1 framing (court mustFix #1 & #2)

`followBall` frames ONE subject; 1v1 needs two. **RESOLVED:** the camera sits behind the handler on the handler→hoop line, but `lookAt` = weighted midpoint(handler, ball) and distance/FOV are driven by the **bounding of {handler, defender, ball}**: an explicit "keep defender in frame" constraint dollies back / widens FOV when separation exceeds a margin, falling to a wider broadcast pose. Modes: `broadcast` (default), `chase` (drive), `shot` (frame arc→rim), `dunk` (low hero), `check` (high establishing). `resetCameraFor` snaps on phase cuts (no lerp across the court — golf's "looking-at-sky" bug class). `camState` is exported from `scene.js`; the director mutates only `camState.distance/height/yaw` (golf's `makeCameraDirector` contract). Camera is a pure function of (interpolated) sim state → no netcode.

### 8.4 VFX (`vfx.js`)

Copy golf's `makeBurst`/`ballTrail`. Net swish (verlet kick), ball trail (shot flight only), score pop (ring + `+1/+2`), floor dust (dunk/hard cut), rim spark (clank), dunk camera shake. All short-lived, self-cleaning, capped particle counts.

---

## 9. UI/HUD & Presentation

The HUD is a pure read-model: `mountBballHud(host, getters) -> unmount` with `.setPrompt/.showToast/.broadcast/.root`, one `tick()` rAF loop diffing against a `last` cache (golf `hud.js` pattern). **No WebGL in the HUD** (only character-select portraits use it — 2 tiny disposed renderers, proven in-budget).

### 9.1 Read-model split (ui/ux mustFix #3)

**RESOLVED:** `meter` and `stamina` are read from **LOCAL** getters (`getMeter()`/`getStamina()` — host: own sim; guest: local input prediction, instant), while `score/possession/phase/events/conn` come from the interpolated `getState()` snapshot. Keeping the meter inside the interpolated snapshot is the latency bug; the meter is a first-class local getter like golf's.

`bballState` (the snapshot read-model): `score[2], target, gamePoint, possession (-1 = loose), phase, needClear, ballHandler, shotClock|null, stamina, badgePop{id,…}, event{id, kind, slot, points, slowmo}, conn, selfSlot`. **Transients are id-stamped** so the HUD fires each toast/pop exactly once even with snapshot coalescing; the host keeps a unique event sticky for ~3 snapshots (ui/ux risk + netcode latching).

### 9.2 Broadcast layer

- **Score bug** (top-center): score-to-11, possession dots, status slot (priority: `GAME POINT` > shot clock > none), accent-colored name plates, `isMe` ring. **Animated number roll** (count-up on score change) + overshoot/settle on game-point pulse — the cheap thing that separates "broadcast" from "web form" (ui/ux mustFix #4).
- **Prompt band** (auto from phase): `CHECK BALL` / `CLEAR IT — take it back past the arc` (amber, pulsing) / `MAKE IT, TAKE IT` / wait states. Mutually-timed with the meter (meter hides prompts).
- **Loose-ball indicator** (`possession === -1`): contested glyph / both dots dimmed-pulsing — never a blank bug (ui/ux mustFix #6).
- **Single-slot toast** with a priority queue (and-1/poster > steal/block > bucket > brick), reused DOM node, replace-in-place (NOT golf's append-stacking — ui/ux mustFix #2). A new `crossover`/ankle-breaker callout is in the catalog (ui/ux mustFix #8).
- **Lower-third scorer chip** on bucket/and-1/dunk (~2s slide). Game-point sting; `GAME!` on the winning bucket. Dunk = cosmetic freeze-frame + vignette ("replay-lite"), NOT true bullet-time (descoped — a 30Hz interpolated stream can't be slowed cleanly).
- **Screen-shake / and-1 flash** (ui/ux mustFix #5): short transform keyframe on HUD root; and-1 flash = gold, ~120 ms, opacity ease-out.
- **Connection chip + disconnect banner**: copy golf's `connstatus`/`disconnect` DOM verbatim, driven by `conn`.

### 9.3 Lobby / character / loadout / summary

Copy `showLobby`/`showCharacterSelect`/`showRoundSummary`. Lobby steps: mode (Practice/Vs CPU/Host/Join) → rules (1s vs 1s-&-2s, make-it-take-it toggle; **shot-clock toggle removed** — streetball has none, ui/ux mustFix #7) → character → loadout. Summary = box-score (FG, 2PT, dunks, blocks, steals, best run), graceful score-only if stats absent.

**RESOLVED (ui/ux mustFix #9):** character-select is gated behind a placeholder capsule baller so this pillar isn't blocked on the full rigged humanoid; `createBaller`/`listAiDefenders` are explicit blocking dependencies with agreed shapes.

---

## 10. Audio (`audio.js`, fully procedural)

Copy golf's `createAudio()` shape (lazy `ensureCtx`, gesture-unlock, baked white/pink/brown buffers, `NAMES`-gated `play()`, managed loops, `tickAmbient(dt)`). Mixing graph adds group busses (sfx/court/crowd/music) → a `duckGain` sidechain → master → a `DynamicsCompressor` limiter (the headroom golf lacks).

**RESOLVED (audio mustFix, the high-ROI set):**
1. **Duck-graph fix:** whistle/swish/buzzer route to a post-duck priority send (bypass `duckGain`) so the sidechain ducks gameplay/crowd WITHOUT ducking the featured sound.
2. **Shared convolver reverb** (one `ConvolverNode`, impulse baked from the white buffer — near-free): court SFX + cheer get a send. The single largest perceptual jump toward "Blacktop space"; without it everything reads as a browser toy.
3. **Stereo panning** (`StereoPannerNode` per voice, ~1 node): pan dribble/sneaker/body/shot by source court-X relative to camera. Mono-everything is the low-effort tell.
4. **Reworked dribble** (plays thousands of times): broadband click transient (white→highpass ~1.5 kHz, 3–5 ms) + damped resonant 150–220 Hz pock; impact-driven pitch/gain from ball vy at floor contact, 60 ms debounce. Tune by ear against reference FIRST.
5. **Metallic chain swish:** scattered burst of 4–8 randomized inharmonic pings (jittered 40–70 ms) under a noise transient — not 3 static bandpasses.
6. **Arena buzzer:** fat detuned saw stack → WaveShaper distortion → resonant bandpass, 30 Hz tremolo.
7. **Crowd variety:** 3–4 distinct positive recipes (clean make / and-1 / block / game-point) + sparse scheduled individual whoops; an excitement `level` model swells then decays.
8. **Block + steal sounds added** to the event map (signature defensive moments).
9. **Procedural music: CUT for v1** (`setMusicEnabled` default OFF) — reinvest in reverb + crowd variety. A half-effort drum-machine cheapens the product.

**Host-authoritative event map:** host fires SFX from sim callbacks; discrete events (swish/whistle/cheer/rim/buzzer/score) mirror to the guest via a `snapshot.audioEvents[]` array (id + opts; co-designed with netcode, NOT assumed). **Dribble + sneaker squeak are guest-predicted locally** from interpolated ball height/player accel (must not round-trip at 15–20 Hz); host ALSO emits bounce events (id + impact + timestamp) and the guest **dedups predicted vs host within ~80 ms** (audio mustFix #9). All timing vs `ctx.currentTime` (lookahead), never wall clock. Peak < 40 live nodes — trivially in budget.

---

## 11. Technical Architecture & Netcode

### 11.1 Module map (`src/sports/basketball/`)

`bball.js` (orchestrator + single rAF tick), `scene.js`, `court.js` + `court-constants.js`, `physics.js`, `input.js`/`controls.js`, `shot.js`, `ballhandler.js`, `finishing.js`, `defense.js`, `resolve.js`, `ratings.js`, `heat.js`, `characters.js`/`animator.js`/`clips.js`/`ik.js`, `rules.js`, `hud.js`, `audio.js`, `net.js`, `lobby.js`/`character-select.js`/`loadout.js`, `ai.js`, `snapshot.js`, `round-summary.js`. No shared base class — copy golf patterns.

`mountBasketball(host, cfgOrOnExit) -> unmount` follows golf's dual-signature normalize. `unmount()`: stopped flag, cancel rAF, remove listeners, `net?.close()`, dispose scene/physics/players, `host.innerHTML=''`.

### 11.2 The tick (host vs guest)

Single `requestAnimationFrame`, `dt = Math.min(0.05, dtMs/1000)` (golf clamp), `paused` → static render, defensive `try{composer.render()}catch{renderer.render()}` (golf).

**HOST (slot 0, or single/cpu):** fixed-step accumulator reusing `physics.js` `FIXED_DT=1/60, MAX_SUBSTEPS=6` (netcode mustFix #1 — do NOT invent 1/120; build on real code). Per substep: apply BOTH players' latest inputs → `stepSim` → drain events → fold through `rules.nextState` → resolve pending shots. Snapshots on a **separate 18 Hz accumulator**. **The host renders its own world INTERP_DELAY in the past too** (a small ring-buffer of authoritative states, same `renderT` the guest uses) so contests/steals/blocks are symmetric — without this the host wins every contested moment and the game feels rigged (netcode mustFix #2).

**GUEST (slot 1):** sample input → `net.sendInput` at 30 Hz → `InterpBuffer.sample(now - INTERP_DELAY)` → render. **Self-prediction of own locomotion is v1-mandatory** (netcode/architecture mustFix): dead-reckon the local avatar from local input, error-correct toward the authoritative snapshot (hard-snap > 0.8 m, else lerp 0.2). Ball/opponent stay interpolated; ball gets velocity-aware extrapolation (≤120 ms), players hold-last on starvation.

**Deterministic intra-tick order (netcode mustFix #3):** per sim tick resolve `[steals/swipes → blocks/contests → shot release → ball/rim physics → rebound/possession → fouls]`, slot-0-before-slot-1 tiebreak only where genuinely simultaneous.

### 11.3 Server (dumb relay, ~15 lines)

The generic-room branch at `server/index.js:181` ALREADY sets `sport` on the room object (`{ key, sport, code, ... }`), so the relay-by-`room.sport` dispatch fires — **the gameplay pillar's claim that the generic room omits `sport` is a misread; no fix needed there.** Add a `room.sport === 'basketball'` branch mirroring tennis (`input` guest→host with `ws.slot!==1` guard; `snapshot` host→guest with `ws.slot!==0` guard; `check-ready`/`check-ball`/`rematch` control). Extend the room-creation ternary to a minimal `{players:[null,null], started, checkReady, rematch, gcAt}`. **Add `socket.setNoDelay(true)` on every accepted ws** (verified absent today; Nagle+delayed-ACK silently adds ~40 ms — netcode mustFix #8). Reconnect/reclaim/`opponent-left`/TTL are generic and reused.

### 11.4 Wire schemas

- **InputFrame** (guest→host, 30 Hz): `{ seq, t, ackSnap, mx, my, aim, b(bitfield), rel?{tRelease, meter} }`. **Held buttons coalesce; edge events (shot release, pump-fake, steal-press) do NOT** — the host queues frames by `seq` and drains each, or carries release as a separately-latched field acked via `ackInput` (netcode mustFix #4). ~50 B/frame ≈ 1.5 KB/s up.
- **Snapshot** (host→18 Hz): **fixed-point integer encoding NOW** (pos ×100 cm int16, yaw ×1000 int16, packed array — nearly free, halves parse cost; netcode mustFix #6). Carries `tick, t, ackInput, ball[x,y,z,vx,vy,vz,dribbleY], p[2][x,z,yaw,animEnum,animPhase,flags], r{phase,poss,score,needTakeback,event,eventSlot}, audioEvents[]`. **Per-player anim phase/normalized-time + client crossfade** (blend from interpolated velocity, NOT a teleporting 18 Hz enum, which looks like stop-motion — netcode mustFix #7). ~250 B ≈ 4.5 KB/s down.

### 11.5 Make detection (rim sensor)

Per-substep geometric downward-crossing (NOT a trigger body — fast ball tunnels a thin sensor): ball center passes from above to below the rim plane while inside the rim radius (XZ interpolated at the crossing instant) with `vy < -0.5`. Debounce via a `lastMade` timestamp (rim-hang guard). On a true crossing, emit `BALL_THROUGH_HOOP`; `rules` decides 1 vs 2 from `isBehindArc(shotOrigin)` captured at release.

### 11.6 Shot-meter authority (resolve the desync — gameplay risk + netcode mustFix #4)

**RESOLVED:** the shooter's meter UI runs **locally** for instant feedback, but it is **advisory/non-committal** until the host confirms — NO "PERFECT" flash before the authoritative result. The guest sends full release timing (`rel.meter`, `rel.tRelease`) in the InputFrame; the host honors the guest's locally-evaluated release deterministically and computes `pMake` with exact (host-known) contest. The shooter plays the release windup immediately (cosmetic) to mask the ~RTT gap; the ball appears from the authoritative snapshot once it leaves the hand; the outcome lands via the snapshot `event`.

### 11.7 Reconnect / host-drop / game-over (netcode mustFix #9, #10)

**RESOLVED:** the copied golf reconnect logic doesn't work when authoritative state lives on a peer. Decision for v1: **host-drop = match paused for the reclaim window, then forfeit/over** (NO host migration). To survive a host reconnect, the host piggybacks a minimal authoritative state (score, possession, phase, mustClear, ball pos/vel, both transforms) to a **server-held "last known state"** on every Nth snapshot, surviving the room TTL; a reclaimed host restores from it. GAME_OVER + final score is a **sticky, server-arbitrated control message** (like golf's `match-complete`) in addition to `snapshot.r.phase`, so a guest reconnecting across the game-over window still learns the result.

### 11.8 Net mode floor (netcode mustFix #12)

Ship **per-possession-lockstep as the shippable floor** AND realtime as the upside, behind `NET_MODE = 'realtime' | 'possession-lockstep'`. Lockstep is "a host-loop change only" (same wire protocol/server branch/transport): the sim runs LIVE only during a check-originated possession; dead-ball/check phases already pause. If realtime feel doesn't clear the bar in two-tab playtest, fall back per-possession without a rewrite.

---

## 12. Tuning Defaults

| Knob | Default | Source |
|---|---|---|
| Win | first to 11, win by 2, cap 21 | product |
| Scoring | inside arc 1, beyond arc 2 | product |
| Make-it-take-it | ON | product |
| Take-it-back / reclear-on-offensive-rebound | ON | rules mustFix #4 |
| Shot clock / stall | OFF | rules default |
| Fouls | `'possession'` + and-1 make/miss distinction | rules mustFix #9 |
| `ARC_RADIUS` (clear gate) | 6.75–7.24 m (shared constant) | court/rules |
| Sim step | `FIXED_DT=1/60, MAX_SUBSTEPS=6` | verified golf physics |
| Snapshot rate | 18 Hz + sticky-event keyframe; server last-known every Nth | netcode |
| Input rate | 30 Hz (guest) | netcode |
| `INTERP_DELAY` | 110 ms (adaptive 90–200 ms v2) | netcode |
| Rim collider | ring of 12–16 static spheres | architecture/court |
| Heat | `[-0.4, 1.0]`, decay 0.90/possession, bounded logit term | gameplay mustFix #7 |
| `pMake` calibration | open-green-3 ≈ 0.83, contested-green-3 ≈ 0.30, contested-bad < 0.10 | gameplay mustFix #2 |
| Contest range | 2.0 m | gameplay |
| Move-set | crossover / behind-back / hesi | gameplay mustFix #4 |
| Hero clips | jumpshot, layup, dunk, block, steal, crossover | avatar trim |
| Music | OFF (cut v1) | audio mustFix #6 |
| Player shadows | blob/contact quad (no shadow-map cast) | court mustFix #6 |
| `pixelRatio` cap | 1.5 | golf scene |
| `setNoDelay(true)` | on every accepted ws | netcode mustFix #8 |
| AI difficulty | rookie/pro/allstar/hof via Gaussian jitter (new per-frame behavior controller; only the jitter idea ports from golf) | gameplay mustFix #3 |

---

## 13. Build Order

1. **Offline core (no net):** `court-constants.js` + `rules.js` reducer + `tests/basketball-rules.test.js` GREEN (make-it-take-it, take-it-back, win-by-2, and-1, dedup) before any Three.js.
2. Scene/visuals/court/hoop (copy + retune golf); contact-shadow quads + low-path fallback.
3. `characters.js` rig (two T-poses, smoke-shot) → `animator.js` + 2–3 authored clips + pose-scrubber → `release` event unit test → procedural locomotion + `ik.js` foot-lock → dribble coupling + free-ball handoff.
4. `physics.js` (cannon-es ball + sphere-ring rim + backboard + geometric make sensor). **Rim spike first:** prototype sphere-ring vs the chosen substep at real shot speeds, measure tunneling/rattle, pin params before locking the architecture.
5. `shot.js` + `resolve.js` logit `pMake` (calibrate offline to the §4.2 targets, like golf's carry-sim) + debug overlay; `ballhandler`/`finishing`/`defense`/`heat`/`ratings`.
6. `hud.js` + lobby/character/loadout/summary + `audio.js` (dribble + chain swish + reverb + panning first).
7. **vs-CPU milestone** complete and playable offline; run the no-snowball run-simulation.
8. **Online milestone:** `snapshot.js` + `net.js` + server branch + `setNoDelay` + `tests/basketball-server.test.js` (relay routing, slot guards, check handshake, rematch, reclaim) FIRST; then guest self-prediction; ship `possession-lockstep` floor; A/B realtime in two-tab playtest.
9. Wire `main.js` tile + `index.html` + `style.css`; Playwright `?sport=basketball` blank-render smoke.

---

## 14. Open Questions

1. **Realtime vs lockstep ship decision** — only a two-tab feel playtest at real RTT/jitter can score it. The `NET_MODE` flag de-risks, but which ships as default is unresolved until measured.
2. **`pMake` weight calibration** — the §4.2 targets are fixed; the exact logit weights/intercepts that hit them need the offline calibration pass + the no-snowball run-sim to confirm together (they interact via the heat term).
3. **Rim-spike outcome** — sphere-count, substep, and whether a swept/raycast CCD is needed for ball-vs-rim are pending the spike; the architecture's substep is provisionally the verified 1/60.
4. **and-1 vs full FT** — v1 ships and-1-as-check; whether ranked wants the `FREE_THROW` phase is deferred behind the flag.
5. **Loadout balance** — the 360-attr / 8-badge pools are starting values; balance vs the `pMake` model needs playtesting once gameplay + ratings are wired.
6. **Host-side latency advantage** — even with symmetric INTERP_DELAY rendering on the host, the host's own input is zero-latency. Whether a ranked context needs the host to also delay its own input by one snapshot for full symmetry is an open fairness call.
7. **Anti-cheat** — a malicious guest can send `meter:1.0`; acceptable for friends-code v1. Host clamping `meter` against `tRelease` plausibility is optional hardening, not v1.

