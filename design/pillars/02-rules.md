# Pillar 2 — Rules & Match-Flow State Machine

> A single, serializable, pure reducer — `nextState(state, event) -> state` in a new `src/sports/basketball/rules.js` — owns the entire streetball ruleset (check-ball, make-it-take-it, take-it-back, 1s/2s scoring, first-to-11 win-by-2, OOB, backcourt/clear, optional shot clock, streetball fouls/and-1, stalling). It runs ONLY on the host (slot 0) inside the basketball rAF tick, exactly where golf.js runs its game-state mutations, and its full output object is the authoritative payload broadcast to the guest. The physics/possession sim produces low-level EVENTS (made shot, ball OOB, ball crossed arc, foul); the reducer consumes them and produces the next match-flow state. No Three.js, no cannon-es, no DOM — it is a plain JS state object + reducer, unit-testable with node:test like clubs.test.js.

# Pillar: Streetball 1v1 Rules & Match-Flow State Machine

> Scope: I own the *ruleset as a state machine*. I do **not** own ball physics,
> player movement, the shot meter, rendering, or netcode transport — but I define the
> exact event interface those systems must produce/consume, and the exact serialized
> state they must render. Everything here lives in **one new file**,
> `src/sports/basketball/rules.js`, plus `tests/basketball-rules.test.js`.

---

## 1. Where this fits in the codebase

This pillar is the basketball analogue of the mutation block inside `golf.js` that
manages `game.strokes / game.complete / game.localActive / game.activeSlot` — except
where golf scatters those mutations across `launchShot`, `onHoleComplete`,
`onBallSettled`, and the net `onEvent` handler, **basketball centralizes ALL rule
transitions into a single pure reducer**. This is mandatory because basketball is
host-authoritative real-time (per the project's fixed netcode decision): the host runs
one authoritative sim and broadcasts snapshots, so the rules must be a deterministic
function of `(prevState, event)` that produces exactly the bytes the guest renders.

Concretely, mirroring `golf.js`:

- golf.js builds a `game = { ... }` object literal (golf.js:289). Basketball builds
  `match = createMatchState(cfg)` from `rules.js`.
- golf.js's rAF `tick(now)` (golf.js:1235) steps `swing.update`, `physics.step`, then
  mutates `game`. Basketball's tick steps `physics.step`, drains an **event queue** the
  sim produced this frame, folds each event through `match = nextState(match, event)`,
  then renders. **Only the host runs `nextState`.** The guest receives `match` whole in
  the snapshot and renders it read-only.
- golf's `dt = Math.min(0.05, dtMs/1000)` clamp (golf.js:1240) is reused verbatim; the
  reducer receives time exclusively via a `TICK` event carrying that clamped `dt` so it
  never reads a wall clock (purity → determinism → no desync).

The reducer is the **single source of truth** for: whose ball it is, whether the ball is
live, the score, whether a check is required, whether the offense must clear the ball
past the arc, the shot/stall clocks, and game-over. The physics sim owns *positions and
collisions*; rules.js owns *meaning*.

```
                 emits BBEvent[]            folds events
 physics/sim  ───────────────────►  host tick  ──────────►  nextState(match, ev)
 (ball,hoop,                                                      │
  players,arc                                                     ▼
  sensors)     ◄───────────────────  reads match.*  ◄──────  new match state
                 (ballLive, mustClear,         │ serialized whole into the
                  possessionSlot gate inputs)  └─► host→guest snapshot (net.js)
```

---

## 2. File layout & exports (`src/sports/basketball/rules.js`)

No shared base class (per codebase contract — sports COPY patterns). Pure module, no
imports of Three/cannon/DOM. The ONE import allowed is the shared court geometry
constant (see §9):

```js
// src/sports/basketball/rules.js
import { ARC_RADIUS, HOOP_CENTER } from './court-constants.js'; // shared w/ Court pillar

export const PHASE = Object.freeze({ /* §3 */ });
export const EVENT = Object.freeze({ /* §4 */ });
export const RULESET_DEFAULT = Object.freeze({ /* §8 config */ });

export function createMatchState(cfg) { /* §5 factory */ }
export function nextState(state, event) { /* §7 reducer — PURE */ }

// small pure helpers, all exported for unit tests:
export function isGameOver(state) { ... }
export function leaderSlot(state) { ... }       // 0 | 1 | -1 (tie)
export function pointsForShot(state, shotMeta) { ... } // 1 | 2 (streetball 1s & 2s)
export function cloneState(state) { ... }       // structuredClone wrapper, snapshot-safe
```

The reducer **never mutates its input**; it returns a new object (clone-then-modify).
This makes it trivially testable and makes host→guest snapshots a plain
`structuredClone(match)` with no aliasing hazards.

---

## 3. States (the `PHASE` enum)

Every state below is a value of `state.phase`. Each owns specific fields and accepts
specific events; everything else is ignored (defensive — unknown events return state
unchanged, exactly like golf's net `onEvent` ignoring unknown `e.type`).

| PHASE | Meaning | ballLive | Player control |
|---|---|---|---|
| `PRE_GAME` | Both joined, first-possession decided, awaiting first check. | false | frozen |
| `CHECK_BALL` | Defender must "check" the ball back to the offense at the top of the arc. | false | offense holds ball at check spot; defender adjacent |
| `LIVE` | Ball is live; normal play, clocks running. | true | full |
| `MADE_BASKET` | A shot just went in; resolving make-it-take-it. | false (brief) | frozen ~1s |
| `CHANGE_POSSESSION` | Possession just flipped (miss-rebound, steal, OOB, turnover). | transient | — |
| `CLEARING` | New offense must take the ball back past the arc before it can score. | true | full, but a made basket before clear = no points |
| `DEAD_BALL` | Generic stoppage (OOB resolution staging). | false | frozen |
| `INBOUND` | Ball awarded at a spot after OOB; brief restart. | false→true | offense re-takes |
| `FOUL_DEAD` | A foul was called; resolving per ruleset (and-1 / FT / check). | false | frozen |
| `FREE_THROW` | (Optional ruleset) a free throw is being shot. | true (FT only) | shooter only |
| `GAME_OVER` | first-to-11 win-by-2 satisfied. | false | frozen |

Phase graph (happy path is the spine; branches are change-of-possession & fouls):

```
PRE_GAME ─►CHECK_BALL ─►LIVE ─┬─►MADE_BASKET ─►(same offense) CHECK_BALL
                              │                 └─(if game point reached)─►GAME_OVER
                              ├─►CHANGE_POSSESSION ─►CLEARING ─►LIVE …
                              ├─►DEAD_BALL ─►INBOUND ─►LIVE (OOB, same or flipped)
                              └─►FOUL_DEAD ─► (FREE_THROW │ CHECK_BALL │ CLEARING)
```

---

## 4. Events (the `EVENT` taxonomy — the sim→rules contract)

These are the ONLY way state changes. The continuous physics/possession sim (other
pillar) MUST emit these as plain objects `{ type, ...payload, id }` into a per-frame
queue that the host drains in tick order. `id` is a monotonic counter for de-dup.

```js
export const EVENT = Object.freeze({
  // --- lifecycle / wiring ---
  TICK:               'TICK',            // { dt }  — drives clocks; emitted once/frame on host
  MATCH_START:        'MATCH_START',     // { firstPossession: 0|1 }  (host decides once)

  // --- check-ball handshake ---
  CHECK_REQUESTED:    'CHECK_REQUESTED', // defender pressed "check" / sim reached check spot
  CHECK_ACCEPTED:     'CHECK_ACCEPTED',  // offense received check -> ball goes live

  // --- live play results (sim sensors) ---
  SHOT_RELEASED:      'SHOT_RELEASED',   // { slot, fromBeyondArc:bool }  (locks shot value)
  BALL_THROUGH_HOOP:  'BALL_THROUGH_HOOP', // make detected by hoop sensor
  SHOT_MISSED:        'SHOT_MISSED',     // ball hit rim/backboard and is now a live rebound
  REBOUND_SECURED:    'REBOUND_SECURED', // { slot }  a player gained clean possession
  STEAL:              'STEAL',           // { slot }  defender took it during dribble/pass
  TURNOVER:           'TURNOVER',        // { slot, reason }  (double-dribble, travel, 5s, etc.)

  // --- boundaries / clear ---
  BALL_OUT_OF_BOUNDS: 'BALL_OUT_OF_BOUNDS', // { lastTouchedBy:0|1, spot:{x,z} }
  BALL_CROSSED_ARC:   'BALL_CROSSED_ARC',   // { slot }  ball+handler fully behind 3pt line
  BACKCOURT_VIOLATION:'BACKCOURT_VIOLATION',// (half-court: ball returned behind clear line w/o reset)

  // --- fouls (streetball: usually called by the fouled player) ---
  FOUL_CALLED:        'FOUL_CALLED',     // { by:0|1, on:0|1, shooting:bool }
  FREE_THROW_RESULT:  'FREE_THROW_RESULT', // { slot, made:bool }

  // --- clocks (host-internal, emitted by reducer-driven sub-timers) ---
  SHOT_CLOCK_EXPIRED: 'SHOT_CLOCK_EXPIRED',
  STALL_EXPIRED:      'STALL_EXPIRED',

  // --- control ---
  RESET_MATCH:        'RESET_MATCH',     // rematch button
});
```

Design note: `SHOT_CLOCK_EXPIRED` / `STALL_EXPIRED` are *derived inside the reducer*
when a `TICK` drains a clock to ≤0. They appear as named events only to keep the
transition table readable; the reducer raises them internally by recursing
`nextState(state, {type: SHOT_CLOCK_EXPIRED})`. This keeps the clock logic in one place
and serializable.

---

## 5. State shape (serializable — this IS the snapshot payload)

Every field is a JSON primitive / plain array so `structuredClone` and
`JSON.stringify` round-trip cleanly for the net layer. No class instances, no NaN, no
functions.

```js
export function createMatchState(cfg = {}) {
  const R = { ...RULESET_DEFAULT, ...(cfg.ruleset || {}) };
  return {
    // --- identity / config (static for the match) ---
    ruleset: R,                 // frozen config snapshot (§8)
    target: R.target,           // 11
    winBy: R.winBy,             // 2
    arcRadius: ARC_RADIUS,      // copied so guest renders the same clear gate

    // --- flow ---
    phase: PHASE.PRE_GAME,
    seq: 0,                     // increments every accepted transition (snapshot ordering)
    lastEventId: -1,            // de-dup: ignore events with id <= this when id provided

    // --- possession ---
    possessionSlot: -1,         // 0 | 1 | -1 (undecided)
    ballLive: false,
    checkRequired: false,       // true while CHECK_BALL pending
    mustClear: false,           // take-it-back gate; true in CLEARING until BALL_CROSSED_ARC
    clearedBy: -1,              // slot that owes the clear (sanity / HUD)

    // --- scoring ---
    score: [0, 0],              // index by slot
    lastBasket: null,           // { slot, value:1|2, seq }  (for HUD ticker + net dedup)
    pendingShot: null,          // { slot, value } locked at SHOT_RELEASED; resolves on make/miss

    // --- clocks (seconds; null = disabled) ---
    shotClock: R.shotClock ? R.shotClockSeconds : null,
    stallClock: R.stallSeconds ?? null,
    deadTimer: 0,               // counts down freeze windows (MADE_BASKET pause, etc.)

    // --- fouls ---
    fouls: [0, 0],              // cumulative per slot
    pendingFoul: null,          // { by, on, shooting } while resolving in FOUL_DEAD
    ftRemaining: 0,             // free throws left to shoot (optional ruleset)

    // --- OOB / inbound staging ---
    inbound: null,              // { slot, spot:{x,z} }

    // --- terminal ---
    winner: -1,                 // 0 | 1 | -1
    over: false,
  };
}
```

This object is ~25 scalar fields → well under 1KB serialized, cheap to broadcast every
snapshot or (better) only on `seq` change.

---

## 6. Transition table (every transition: trigger → guard → effect → next phase)

Notation: `phase | EVENT [guard] -> nextPhase {effects}`. "off" = offense =
`possessionSlot`, "def" = `1 - possessionSlot`.

**PRE_GAME**
- `MATCH_START -> CHECK_BALL` {`possessionSlot = ev.firstPossession`; `checkRequired=true`;
  `mustClear=false`; reset clocks}.

**CHECK_BALL**
- `CHECK_REQUESTED -> CHECK_BALL` {no-op staging; ensures defender initiated}.
- `CHECK_ACCEPTED -> LIVE` {`ballLive=true`; `checkRequired=false`; start/reset
  `shotClock`; reset `stallClock`}.
  - Guard: ignore unless `checkRequired`. After a check, the ball is **already cleared**
    (check is at the top of the arc), so `mustClear=false`.

**LIVE** (the hot state — most events land here)
- `SHOT_RELEASED -> LIVE` {`pendingShot = { slot, value: pointsForShot(...) }`}.
  - `value` = 2 if `ev.fromBeyondArc` AND `!mustClear-violation`, else 1 (streetball 1s/2s).
  - Guard: `slot === possessionSlot`; else ignore (defender can't shoot offense's ball).
- `BALL_THROUGH_HOOP [pendingShot && !mustClear] -> MADE_BASKET`
  {`applyBasket(state, pendingShot)`; `lastBasket={...}`; `deadTimer=R.madeBasketPauseS`}.
- `BALL_THROUGH_HOOP [mustClear] -> CHANGE_POSSESSION`
  {**no points** — basket scored before clearing the arc is waved off; ball to defense}.
  This is the rule enforcement for take-it-back.
- `SHOT_MISSED -> LIVE` {`pendingShot=null`; ball is a live rebound; `shotClock` resets to
  `R.shotClockOffReboundS` per ruleset}.
- `REBOUND_SECURED [slot === possessionSlot] -> LIVE` {offensive rebound; `mustClear` stays
  as-is (already past arc); reset stall}.
- `REBOUND_SECURED [slot !== possessionSlot] -> CHANGE_POSSESSION` {defensive rebound →
  change of possession}.
- `STEAL -> CHANGE_POSSESSION` {`possessionSlot=ev.slot` handled in CHANGE_POSSESSION entry}.
- `TURNOVER -> CHANGE_POSSESSION` {ev.reason logged}.
- `BALL_OUT_OF_BOUNDS -> DEAD_BALL` {`inbound = { slot: 1-ev.lastTouchedBy, spot }`}.
- `FOUL_CALLED -> FOUL_DEAD` {`pendingFoul = ev`}.
- `BACKCOURT_VIOLATION -> CHANGE_POSSESSION` {half-court backcourt = turnover}.
- `TICK -> LIVE` {`tickClocks(state, dt)`; if `shotClock<=0` raise `SHOT_CLOCK_EXPIRED`;
  if `stallClock<=0` raise `STALL_EXPIRED`}.
- `SHOT_CLOCK_EXPIRED -> CHANGE_POSSESSION` {turnover, ball to defense}.
- `STALL_EXPIRED -> CHANGE_POSSESSION` {anti-stall turnover (only if ruleset.stall on)}.

**MADE_BASKET** (make-it-take-it resolution)
- `TICK [deadTimer>0] -> MADE_BASKET` {decrement `deadTimer`}.
- `TICK [deadTimer<=0 && isGameOver] -> GAME_OVER` {`over=true`; `winner=leaderSlot`}.
- `TICK [deadTimer<=0 && !isGameOver] -> CHECK_BALL`
  {**scorer keeps possession** (make-it-take-it): `possessionSlot` unchanged;
  `checkRequired=true`; `mustClear=false` because the ensuing check re-spots at the arc}.

**CHANGE_POSSESSION** (entry-effect state — resolves in the same fold, never lingers)
- entry effect: `possessionSlot = 1 - possessionSlot` (or `= ev.slot` for STEAL/REBOUND);
  `pendingShot=null`; `ballLive=true`; `mustClear=true`; `clearedBy=possessionSlot`;
  reset `shotClock` to full; reset `stallClock`. Then immediately `-> CLEARING`.
  (Implementation: the reducer handles CHANGE_POSSESSION as a *computed* phase — it sets
  fields and tail-calls into CLEARING within the same `nextState` invocation so the guest
  never has to render a half-state.)

**CLEARING** (take-it-back enforcement)
- `BALL_CROSSED_ARC [slot === possessionSlot] -> LIVE` {`mustClear=false`; `clearedBy=-1`}.
- `BALL_THROUGH_HOOP -> CHANGE_POSSESSION` {scored before clearing → waved off, flip again}.
- `BALL_OUT_OF_BOUNDS -> DEAD_BALL` {still owes clear after inbound; `inbound.mustClear=true`}.
- `STEAL / TURNOVER -> CHANGE_POSSESSION` {defender stole during the clear; now THEY must clear}.
- `FOUL_CALLED -> FOUL_DEAD`.
- `TICK -> CLEARING` {clocks tick; shot clock can still expire while failing to clear}.
- All scoring guards in LIVE also exist here but resolve to "no points" because
  `mustClear` is true (defense-in-depth; the explicit BALL_THROUGH_HOOP rule above is the
  primary).

**DEAD_BALL**
- `TICK -> DEAD_BALL` {brief stage}; transitions on `INBOUND` readiness:
- (auto) `-> INBOUND` {copy `inbound` staging; `possessionSlot = inbound.slot`}.

**INBOUND**
- `CHECK_ACCEPTED / (sim ready) -> LIVE or CLEARING`
  {if possession flipped due to OOB off the new offense's defender, `mustClear` carries;
  in half-court, OOB that changes possession sets `mustClear=true -> CLEARING`, OOB that
  keeps possession (defense knocked it out) goes straight to `LIVE`}.

**FOUL_DEAD** (streetball foul resolution — ruleset-driven, see §8)
- Default ruleset (`fouls:'possession'`): `-> CHECK_BALL`
  {`fouls[on-defender]++`; offense keeps ball; check at top; `mustClear=false`}.
- `and1` ruleset on a shooting foul where the basket also counted: basket already applied
  in LIVE via BALL_THROUGH_HOOP; foul just re-checks → `-> CHECK_BALL`.
- `freeThrow` ruleset: `-> FREE_THROW` {`ftRemaining = ev.shooting ? R.ftCount : 0`}.

**FREE_THROW** (optional)
- `FREE_THROW_RESULT [made] -> FREE_THROW|CHECK_BALL` {`score[shooter]++` if made;
  `ftRemaining--`; if `ftRemaining>0` stay; else resolve possession per made/miss}.

**GAME_OVER**
- `RESET_MATCH -> PRE_GAME` {`return createMatchState({ruleset})`}.
- all else ignored.

---

## 7. The reducer (pseudo-code, implementation-ready)

```js
export function nextState(state, event) {
  // de-dup: sim may emit a sensor event on consecutive frames
  if (event.id != null && event.id <= state.lastEventId) return state;

  let s = cloneState(state);               // structuredClone — pure, no input mutation
  if (event.id != null) s.lastEventId = event.id;

  switch (s.phase) {
    case PHASE.PRE_GAME:    s = preGame(s, event); break;
    case PHASE.CHECK_BALL:  s = checkBall(s, event); break;
    case PHASE.LIVE:        s = live(s, event); break;
    case PHASE.CLEARING:    s = clearing(s, event); break;
    case PHASE.MADE_BASKET: s = madeBasket(s, event); break;
    case PHASE.DEAD_BALL:   s = deadBall(s, event); break;
    case PHASE.INBOUND:     s = inbound(s, event); break;
    case PHASE.FOUL_DEAD:   s = foulDead(s, event); break;
    case PHASE.FREE_THROW:  s = freeThrow(s, event); break;
    case PHASE.GAME_OVER:   s = gameOver(s, event); break;
  }
  if (s !== state && s.phase !== state.phase) s.seq++;  // bump on real phase change
  // also bump seq on score/possession change even within a phase:
  if (s.score[0]!==state.score[0] || s.score[1]!==state.score[1] ||
      s.possessionSlot!==state.possessionSlot || s.mustClear!==state.mustClear) s.seq++;
  return s;
}

function live(s, ev) {
  switch (ev.type) {
    case EVENT.SHOT_RELEASED:
      if (ev.slot !== s.possessionSlot) return s;
      s.pendingShot = { slot: ev.slot, value: pointsForShot(s, ev) };
      return s;

    case EVENT.BALL_THROUGH_HOOP:
      if (s.mustClear) return toChangePossession(s, 1 - s.possessionSlot, 'no-clear');
      if (!s.pendingShot) return s;                 // ball through hoop w/o a shot? ignore
      applyBasket(s, s.pendingShot);
      s.pendingShot = null;
      s.deadTimer = s.ruleset.madeBasketPauseS;
      s.ballLive = false;
      s.phase = PHASE.MADE_BASKET;
      return s;

    case EVENT.SHOT_MISSED:
      s.pendingShot = null;
      s.shotClock = s.ruleset.shotClock ? s.ruleset.shotClockOffReboundS : null;
      return s;

    case EVENT.REBOUND_SECURED:
      return ev.slot === s.possessionSlot
        ? resetStall(s)                              // offensive board, play on
        : toChangePossession(s, ev.slot, 'def-reb');

    case EVENT.STEAL:
    case EVENT.TURNOVER:
      return toChangePossession(s, ev.slot ?? (1 - s.possessionSlot), ev.type);

    case EVENT.BALL_OUT_OF_BOUNDS:
      s.inbound = { slot: 1 - ev.lastTouchedBy, spot: ev.spot, flips: ev.lastTouchedBy === s.possessionSlot };
      s.ballLive = false;
      s.phase = PHASE.DEAD_BALL;
      return s;

    case EVENT.FOUL_CALLED:
      s.pendingFoul = { by: ev.by, on: ev.on, shooting: !!ev.shooting };
      s.ballLive = false;
      s.phase = PHASE.FOUL_DEAD;
      return s;

    case EVENT.BACKCOURT_VIOLATION:
      return toChangePossession(s, 1 - s.possessionSlot, 'backcourt');

    case EVENT.TICK:
      tickClocks(s, ev.dt);
      if (s.shotClock != null && s.shotClock <= 0) return live(s, { type: EVENT.SHOT_CLOCK_EXPIRED });
      if (s.stallClock != null && s.stallClock <= 0) return live(s, { type: EVENT.STALL_EXPIRED });
      return s;

    case EVENT.SHOT_CLOCK_EXPIRED:
    case EVENT.STALL_EXPIRED:
      return toChangePossession(s, 1 - s.possessionSlot, ev.type);

    default: return s;
  }
}

// --- shared effect helpers ---
function applyBasket(s, shot) {
  s.score[shot.slot] += shot.value;
  s.lastBasket = { slot: shot.slot, value: shot.value, seq: s.seq + 1 };
}
function pointsForShot(s, ev) { return ev.fromBeyondArc ? 2 : 1; } // streetball 1s & 2s

function toChangePossession(s, newOff, reason) {
  s.possessionSlot = newOff;
  s.pendingShot = null;
  s.ballLive = true;
  s.mustClear = true;                // TAKE IT BACK
  s.clearedBy = newOff;
  s.shotClock = s.ruleset.shotClock ? s.ruleset.shotClockSeconds : null;
  resetStall(s);
  s.phase = PHASE.CLEARING;
  s._lastChangeReason = reason;      // debug/HUD only; safe to serialize
  return s;
}

function clearing(s, ev) {
  switch (ev.type) {
    case EVENT.BALL_CROSSED_ARC:
      if (ev.slot !== s.possessionSlot) return s;
      s.mustClear = false; s.clearedBy = -1; s.phase = PHASE.LIVE; return s;
    case EVENT.BALL_THROUGH_HOOP:    // scored before clearing -> waved off
      return toChangePossession(s, 1 - s.possessionSlot, 'no-clear');
    case EVENT.STEAL:
    case EVENT.TURNOVER:
      return toChangePossession(s, ev.slot ?? (1 - s.possessionSlot), ev.type);
    case EVENT.BALL_OUT_OF_BOUNDS:
      s.inbound = { slot: 1 - ev.lastTouchedBy, spot: ev.spot, mustClear: true };
      s.ballLive = false; s.phase = PHASE.DEAD_BALL; return s;
    case EVENT.FOUL_CALLED:
      s.pendingFoul = { by: ev.by, on: ev.on, shooting: !!ev.shooting };
      s.phase = PHASE.FOUL_DEAD; return s;
    case EVENT.TICK:
      tickClocks(s, ev.dt);
      if (s.shotClock != null && s.shotClock <= 0) return toChangePossession(s, 1 - s.possessionSlot, 'shot-clock');
      return s;
    default: return s;
  }
}

function madeBasket(s, ev) {
  if (ev.type !== EVENT.TICK) return s;
  s.deadTimer -= ev.dt;
  if (s.deadTimer > 0) return s;
  if (isGameOver(s)) { s.over = true; s.winner = leaderSlot(s); s.phase = PHASE.GAME_OVER; return s; }
  // make-it-take-it: scorer keeps the ball, defender checks it
  s.checkRequired = true; s.mustClear = false; s.ballLive = false;
  s.shotClock = s.ruleset.shotClock ? s.ruleset.shotClockSeconds : null;
  s.phase = PHASE.CHECK_BALL;
  return s;
}

function tickClocks(s, dt) {
  if (s.shotClock != null) s.shotClock = Math.max(0, s.shotClock - dt);
  if (s.stallClock != null) s.stallClock = Math.max(0, s.stallClock - dt);
}
function resetStall(s) { if (s.stallClock != null) s.stallClock = s.ruleset.stallSeconds; return s; }
```

### Win condition (first-to-11, win-by-2)

```js
export function isGameOver(state) {
  const [a, b] = state.score;
  const hi = Math.max(a, b), lo = Math.min(a, b);
  return hi >= state.target && (hi - lo) >= state.winBy;
}
export function leaderSlot(state) {
  const [a, b] = state.score;
  return a === b ? -1 : (a > b ? 0 : 1);
}
```

Note: a "game point" make is applied like any other basket; the `MADE_BASKET → TICK`
path is the single place we check `isGameOver`, so the win-by-2 deuce logic (10–10 →
play on, 12–10 → over) falls out naturally without special-casing.

---

## 8. Ruleset config (the swappable, don't-relitigate knobs)

```js
export const RULESET_DEFAULT = Object.freeze({
  target: 11,
  winBy: 2,
  twoPointArc: true,            // streetball 1s & 2s (deep shots = 2)
  makeItTakeIt: true,
  takeItBack: true,             // clear past arc on change of possession
  checkBall: true,              // defender checks at top of arc after each dead ball

  // clocks (set shotClock:false to disable entirely for casual 1v1)
  shotClock: false,             // OFF by default for v1 (see open question)
  shotClockSeconds: 24,
  shotClockOffReboundS: 14,
  stall: false,                 // anti-stall turnover
  stallSeconds: 10,
  madeBasketPauseS: 1.0,        // freeze window after a make (cinematic + lets net settle)

  // fouls: 'possession' = fouled team keeps ball & checks (default, no FT sim)
  //        'freeThrow'  = shooting foul -> FT(s)
  fouls: 'possession',
  ftCount: 1,
  foulOut: 0,                   // 0 = no foul-out in 1v1
});
```

These mirror golf's `settings.js`/`quality.js` "config object passed at mount" pattern.
The lobby (`lobby.js` analogue) can surface a couple of these (target score, shot clock
on/off) as a `cfg.ruleset` override forwarded through `mountBasketball(host, {ruleset})`.

---

## 9. Integration points (exact bindings)

**(a) Host tick** (in `basketball.js`, analogous to golf.js:1235):
```js
// HOST ONLY
const evs = sim.drainEvents();             // sim collected sensor events this frame
for (const ev of evs) match = nextState(match, ev);
match = nextState(match, { type: EVENT.TICK, dt }); // dt = Math.min(0.05, dtMs/1000)
// drive sim's allowed actions from match.* (ballLive, mustClear, possessionSlot)
sim.setControlGate({ ballLive: match.ballLive, mustClear: match.mustClear,
                     offense: match.possessionSlot });
```

**(b) Snapshot broadcast** (host→guest, via `connectBasketball` copied from net.js).
The rules state is a field of the snapshot; broadcast on `seq` change (cheap) plus a
keyframe every N frames for late-join resilience:
```js
if (match.seq !== lastSentSeq) { net.sendSnapshot({ rules: match, ... }); lastSentSeq = match.seq; }
```
Guest's `onEvent` for `{type:'snapshot'}` does `match = e.rules;` (read-only render).
This is the same shape as golf's `onEvent` `e.type==='state'` accepting the server's
authoritative `turn/hole/scorecard` (golf.js:1139) — here the *peer host* is the
authority and rules state is the analogue of golf's `state` payload.

**(c) Server** stays a dumb relay (tennis pattern, server/index.js:237). Add a
`room.sport === 'basketball'` branch that relays guest `input` → host and host
`snapshot` → guest, slot-0-authoritative — no rules logic on the server. The reducer
NEVER runs server-side; this keeps the server stateless for basketball exactly like
tennis.

**(d) HUD** (`mountHud` getter pattern, hud.js): pull-based getters read `match`:
```js
getScore: () => match.score,
getPossession: () => match.possessionSlot,
getPhaseLabel: () => phaseLabel(match),  // "CHECK BALL", "CLEAR IT", "GAME POINT"…
getShotClock: () => match.shotClock,
getWinner: () => match.winner,
```
"Take it back / clear it" prompt = `match.mustClear`. "Game point" banner =
`isGameOver` would be true on the next make for the leader at `target-1` with the lead.

**(e) Shared arc constant**: `ARC_RADIUS` MUST be imported by both rules.js and the
Court/sim pillar from `court-constants.js` (do not duplicate) — `BALL_CROSSED_ARC` is
emitted by the sim using that radius, and rules.js stores it into the snapshot so the
guest HUD draws the same clear gate. A mismatch soft-locks CLEARING (see Risks).

---

## 10. Testing (node:test, like clubs.test.js / server.test.js)

`tests/basketball-rules.test.js` — pure reducer tests, no server, no browser. The
reducer's purity makes this exhaustive and fast:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMatchState, nextState, EVENT, PHASE, isGameOver } from '../src/sports/basketball/rules.js';

const start = (cfg) => nextState(createMatchState(cfg), { type: EVENT.MATCH_START, firstPossession: 0 });
const live  = (s) => nextState(s, { type: EVENT.CHECK_ACCEPTED });

test('make-it-take-it: scorer keeps possession & must NOT re-clear after check', () => {
  let s = live(start());
  s = nextState(s, { type: EVENT.SHOT_RELEASED, slot: 0, fromBeyondArc: false });
  s = nextState(s, { type: EVENT.BALL_THROUGH_HOOP });
  assert.equal(s.phase, PHASE.MADE_BASKET);
  assert.deepEqual(s.score, [1, 0]);
  s = nextState(s, { type: EVENT.TICK, dt: 2 });        // drain deadTimer
  assert.equal(s.phase, PHASE.CHECK_BALL);
  assert.equal(s.possessionSlot, 0);                    // kept it
  assert.equal(s.mustClear, false);
});

test('change of possession requires take-it-back: basket before clear = no points', () => {
  let s = live(start());
  s = nextState(s, { type: EVENT.TURNOVER, slot: 1 });  // -> CLEARING for slot 1
  assert.equal(s.phase, PHASE.CLEARING);
  assert.equal(s.mustClear, true);
  s = nextState(s, { type: EVENT.SHOT_RELEASED, slot: 1, fromBeyondArc: true });
  s = nextState(s, { type: EVENT.BALL_THROUGH_HOOP });  // scored w/o clearing
  assert.deepEqual(s.score, [0, 0]);                    // waved off
  assert.equal(s.possessionSlot, 0);                    // back to other player
});

test('2-pointer for deep shot; first-to-11 win-by-2 deuce', () => {
  let s = live(start());
  s.score = [10, 10]; s.phase = PHASE.LIVE; s.possessionSlot = 0;
  s = nextState(s, { type: EVENT.SHOT_RELEASED, slot: 0, fromBeyondArc: true });
  s = nextState(s, { type: EVENT.BALL_THROUGH_HOOP });  // 12-10
  s = nextState(s, { type: EVENT.TICK, dt: 2 });
  assert.equal(s.phase, PHASE.GAME_OVER);
  assert.equal(s.winner, 0);
});

test('reducer is pure: input not mutated', () => {
  const s0 = live(start());
  const snap = JSON.stringify(s0);
  nextState(s0, { type: EVENT.TURNOVER, slot: 1 });
  assert.equal(JSON.stringify(s0), snap);
});

test('event de-dup: same id folds once', () => {
  let s = live(start());
  s = nextState(s, { type: EVENT.SHOT_RELEASED, slot: 0, fromBeyondArc: false, id: 5 });
  s = nextState(s, { type: EVENT.BALL_THROUGH_HOOP, id: 6 });
  const after = nextState(s, { type: EVENT.BALL_THROUGH_HOOP, id: 6 }); // dup
  assert.equal(after, s); // unchanged ref
});
```

A separate `tests/basketball-relay.test.js` copies server.test.js's `bootServer/
makeClient/waitFor` harness to assert the server *relays* `input`/`snapshot` between
two clients slot-0-authoritatively and never inspects rules state — proving the server
stayed dumb. CI already runs `node --test tests/*.test.js` + `npm run build`, so these
files are picked up with zero config changes.

---

## 11. Perf / feasibility

- The reducer is O(1) per event, allocates one `structuredClone` (~25 scalars + 2 small
  arrays) per accepted transition. At a worst-case handful of events/frame plus one
  TICK, this is a few microseconds — utterly negligible next to cannon-es stepping and
  Three rendering. It runs only on the host.
- Snapshot size: the whole `match` object is <1KB JSON; broadcasting on `seq`-change
  means typically 0 rules bytes/frame during live dribbling (rules state only changes on
  discrete events), with a small keyframe cadence for resilience. This fits comfortably
  inside the per-frame input/snapshot budget the tennis relay already tolerates.
- Determinism guarantee: the reducer reads NO wall clock, NO RNG, NO globals. The only
  time source is `TICK.dt`. The only randomness in the whole match (first-possession
  coin flip) is computed once by the host at PRE_GAME and shipped in the snapshot, so the
  guest never diverges. This is what makes host-authority safe with a dumb relay.

## 12. Implementation order (for the engineer)

1. `court-constants.js` with `ARC_RADIUS`, `HOOP_CENTER` (coordinate with Court pillar).
2. `rules.js`: `PHASE`, `EVENT`, `RULESET_DEFAULT`, `createMatchState`, helpers
   (`isGameOver`, `leaderSlot`, `pointsForShot`, `cloneState`).
3. `nextState` + per-phase handlers (§7). Ship `fouls:'possession'`, `shotClock:false`,
   `stall:false` defaults; stub `FREE_THROW` behind the ruleset flag.
4. `basketball-rules.test.js` (§10) — get it green before wiring any Three.js.
5. Wire into `basketball.js` host tick + snapshot (§9 a/b); guest renders `match`
   read-only.
6. Add the server `room.sport==='basketball'` relay branch + `basketball-relay.test.js`.


---

## Adversarial Critique (AAA-bar review)

**Verdict:** needs-work

### Gaps
- MISCITED CODEBASE FACT (credibility risk). The design repeatedly leans on 'tennis is a dumb relay we COPY' and 'connectBasketball copied from net.js'. Verified: src/sports/tennis/tennis.js is a 2D <canvas> single-paddle stub with NO networking at all (no net.js, no WebSocket). The relay exists ONLY server-side (server/index.js:237 room.sport==='tennis'). There is no tennis client net layer to copy; the only real client net template is golf's net.js (golf-specific, turn-based). The 'copy tennis' framing is wrong and will mislead the implementer.
- The reducer owns only ~1% of what makes basketball feel real-time-authoritative, yet the design's perf/feasibility section implies the netcode is basically solved ('typically 0 rules bytes/frame'). The hard problem is the 30Hz position/velocity snapshot stream for ball + 2 players + interpolation/reconciliation — which this pillar explicitly disowns but whose absence the doc papers over. 'Rules state only changes on discrete events' is true and irrelevant to whether the game is playable online; it understates the real bandwidth/latency work.
- CHANGE_POSSESSION is defined two contradictory ways. §3/§6 list it as a real PHASE in the table and graph; §6 and §7 then say it's a 'computed phase' that tail-calls into CLEARING and 'never lingers' — and the actual reducer code (toChangePossession) sets phase=CLEARING directly and never has a CHANGE_POSSESSION case in the switch. So CHANGE_POSSESSION is dead as a state but alive in the spec/tests' mental model. Pick one. As written, a guest could never receive phase==='CHANGE_POSSESSION', yet the table documents events landing on it.
- Self-rebroadcasting clock events break the de-dup invariant the design rests on. SHOT_CLOCK_EXPIRED/STALL_EXPIRED are raised internally with NO id, while the whole netcode-safety argument is 'every sim event carries a monotonic id for de-dup.' Internal recursion is fine for purity, but the doc never states that derived events are id-less by contract, and the de-dup guard `event.id <= state.lastEventId` would silently no-op any future event that legitimately reuses a low id after a RESET_MATCH (lastEventId is not reset by RESET — it returns createMatchState which sets lastEventId=-1, OK — but a reconnecting guest/keyframe replay path is undefined).
- Make-it-take-it + take-it-back interaction with OFFENSIVE REBOUND is under-specified and probably wrong for pro feel. §6 LIVE REBOUND_SECURED[offense] says 'mustClear stays as-is (already past arc).' But the canonical streetball rule after a MISSED shot is that the offense must take it back PAST THE ARC again before scoring (you don't get to put-back-dunk a miss in most 1s-and-2s halfcourt rules). The design bakes in 'offensive board = play on, no re-clear,' which is a real variant but the OPPOSITE of the most common ranked-2K Blacktop convention. This is a feel-defining rule shipped as an undiscussed default.
- Foul model is too thin for an 'NBA 2K Blacktop AAA bar.' Default 'fouls:possession, no FT, no foul-out' yields zero shooting fouls, zero and-1 drama, zero bonus — i.e., the single most clutch streetball moment (the and-1) is behind a stubbed FREE_THROW phase. and-1 is even mis-modeled: §6 says 'basket already applied in LIVE, foul just re-checks,' but a defensive foul that does NOT result in a make should award the ball back to offense, and the doc never distinguishes 'shooting foul + make' vs 'shooting foul + miss' in the possession-ruleset path.
- INBOUND/DEAD_BALL flow is hand-wavy and has no concrete trigger. DEAD_BALL '(auto) -> INBOUND' and INBOUND '(sim ready) -> LIVE or CLEARING' rely on undefined 'sim ready' signals that aren't in the EVENT taxonomy. There is no INBOUND_READY / BALL_INBOUNDED event, so the reducer literally cannot leave DEAD_BALL/INBOUND with the listed events. This is a soft-lock in the state machine as specified.
- seq-bump logic is buggy and will cause snapshot ordering/dedup glitches. In nextState, applyBasket sets lastBasket.seq = s.seq+1 BEFORE the post-switch block conditionally increments s.seq. On a made basket the phase changes (LIVE->MADE_BASKET) so seq++ fires once, but the score-change branch can ALSO fire seq++ in the same call (two increments), making lastBasket.seq off-by-one vs final seq. Guest dedup keyed on seq could drop or double-count the basket ticker.
- 'Broadcast on seq change' loses guest-side liveness for clocks. shotClock/stallClock tick every frame via TICK but DON'T bump seq (intentionally — clocks aren't a phase/score/possession change). So a guest watching the shot clock would see it FROZEN until the next discrete event, unless a keyframe cadence fills in. The 'keyframe every N frames' is mentioned once and never specified; if the clock UI matters for feel, this needs a defined cadence and it undercuts the '0 bytes/frame' selling point.
- Phase enum has GAME_OVER reachable ONLY via the MADE_BASKET TICK path. A game-winning play that isn't a made basket from the live phase — e.g., reaching target via a free throw (FREE_THROW phase) — never checks isGameOver. FREE_THROW resolves to CHECK_BALL unconditionally. So a game won at the FT line cannot end. Even with FT stubbed for v1, shipping a win-check that lives in exactly one phase is fragile.
- No spec for late-join / reconnect of the GUEST against host-authoritative state. net.js golf has clientId slot-reclaim, but the rules pillar's only resilience note is 'keyframe every N frames.' On reconnect the guest needs the WHOLE match object + the current position sim state; the design asserts <1KB makes this cheap but never defines who sends the keyframe, on what trigger, or how mid-CLEARING/mid-deadTimer state resyncs without a double-applied event.

### Must-Fix (applied in synthesis)
- Fix the codebase citations: state plainly that there is NO client-side net template for tennis (tennis.js is a 2D stub) and that connectBasketball must be adapted from golf's net.js, which is turn-based and will need a NEW continuous snapshot/input message path. Do not tell the implementer to 'copy tennis client patterns' — they don't exist.
- Resolve CHANGE_POSSESSION: either delete it from the PHASE enum and transition table (it's purely a computed helper toChangePossession -> CLEARING) and document it as a transition function, OR make it a real one-fold phase. The current doc/code disagreement will cause the implementer to write a dead switch case and the guest to handle a phase it never receives.
- Add the missing events to make DEAD_BALL/INBOUND escapable: define BALL_INBOUNDED (or INBOUND_READY) in the EVENT taxonomy and wire deadBall()/inbound() handlers. As written the machine soft-locks on any OOB. This is a correctness bug, not a polish item.
- Decide and DOCUMENT the offensive-rebound-after-miss rule explicitly, because it defines feel. For the 2K Blacktop bar, the common ranked convention is 'change of possession on defensive board; on offensive board the offense must re-clear (take it back) before scoring.' The design's current 'offensive board = play on, no re-clear' should at minimum be a named ruleset flag (reclearOnOffensiveRebound) with the 2K-default ON, not silently OFF.
- Centralize the win check: call isGameOver in a single resolveAfterScore() helper invoked from EVERY scoring path (made basket AND free throw), not only MADE_BASKET's TICK. Otherwise FT-decided games can't end and any future scoring path silently bypasses game-over.
- Fix the seq accounting: compute the final seq once at the end of nextState (single increment if anything material changed), and set lastBasket.seq to that final value, not s.seq+1 mid-fold. Define exactly what bumps seq and guarantee at most one bump per nextState call so guest dedup is sound.
- Specify the keyframe/snapshot cadence concretely (e.g., full match keyframe at 4-8Hz + immediate send on seq change), and decide whether shotClock is part of the per-frame position snapshot (recommended — clocks belong with the high-rate stream, not the seq-gated rules object). Resolve the contradiction between 'broadcast only on seq change' and 'guest must see a ticking clock.'
- Specify guest reconnect/late-join: on guest (re)join the host sends one keyframe = {rules: full match, simState: ball+players}; define the trigger (server forwards a 'request-keyframe' or host sends on 'opponent-rejoined' which already exists server-side at index.js:226). Without this the host-authoritative model has no recovery story.
- Promise and stub the and-1 properly even if FT is deferred: in the 'possession' foul ruleset, distinguish shooting-foul-on-make (count basket + offense keeps ball, check) from shooting-foul-on-miss (offense keeps ball, check) from common foul. The and-1 is the AAA-feel moment; shipping it as an undifferentiated 'foul -> check' misses the bar even for v1.
- State the id contract explicitly: sim-emitted events carry monotonic ids; reducer-derived events (SHOT_CLOCK_EXPIRED, STALL_EXPIRED, computed CHANGE_POSSESSION) carry NO id and are exempt from the dedup guard. Add a test asserting a derived event after a high-id sim event is not swallowed by the id<=lastEventId guard.

### Feasibility Notes
The reducer itself is unambiguously feasible and cheap: a pure O(1) state-machine over ~25 scalars with a structuredClone per transition is microseconds, runs host-only, and the <1KB serialized rules object is trivial over WebSocket. node:test unit-testing mirrors clubs.test.js exactly and is the strongest part of the design. The server staying a dumb relay is correct and matches the existing tennis branch (server/index.js:237) and broadcast helpers (send/broadcast at :74-78) — adding a room.sport==='basketball' relay branch is low-risk. WHERE IT IS NOT FEASIBLE AS SCOPED: the design's feasibility argument only covers the rules object and quietly ignores the actual hard real-time cost — the 20-30Hz ball+2-player position/velocity snapshot stream, client-side interpolation, and input lag hiding — which this pillar disowns but which determines shippability. That belongs to the sim/net pillars, but THIS doc should stop implying the netcode is mostly solved. TRIM SCOPE: ship v1 with shotClock OFF (already default), stall OFF, fouls='possession' WITH the and-1 make/miss distinction wired (cheap, no FT phase needed), and reclearOnOffensiveRebound=ON. Defer FREE_THROW phase entirely behind the flag as proposed — that's a reasonable cut. Keep court-constants.js shared ARC_RADIUS — that risk call is correct and important.

