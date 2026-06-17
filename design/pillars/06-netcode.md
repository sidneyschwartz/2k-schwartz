# Pillar 6 — Netcode & Real-Time Multiplayer

> Online 1v1 basketball runs host-authoritative: slot 0 (host) runs the single authoritative cannon-es sim — ball, both players, collisions, fouls, possession/check-ball state machine, scoring — and broadcasts ~18Hz state snapshots; slot 1 (guest) streams ~30Hz input frames and renders interpolated snapshots with light local prediction of its own avatar. The server stays a dumb relay exactly like tennis (input guest→host, snapshot host→guest), adding only a `room.sport==='basketball'` branch and the lobby/check/rematch control messages it must arbitrate. The shot meter resolves authoritatively on the host (guest sends only release timing). This is the #1 technical risk; the fallback if feel is poor is per-possession lockstep, which the protocol is designed to degrade into without a rewrite.

# Pillar: Netcode & Real-Time Multiplayer — 1v1 Half-Court Basketball

> Scope: everything that makes online 1v1 basketball play in real time. Owns the host-authoritative model, the input/snapshot wire protocol, client interpolation + prediction, the shot-meter authority resolution, the new server relay branch, and the join/check/start/rematch/reconnect flow. Grounded entirely in the existing golf/tennis netcode (`src/sports/golf/net.js`, `server/index.js`, `tests/server.test.js`) and the golf orchestrator tick (`src/sports/golf/golf.js`).

---

## 0. The core decision and why

Golf is **server-authoritative turn-based**: the server owns turn/scorecard/hole and clients send discrete `shot`/`shot-result`/`end-turn` messages (`server/index.js` lines 275-318). Tennis is a **dumb relay**: slot-0 is authoritative for the ball, the server just rebroadcasts `input`/`ball`/`score` (lines 237-247).

Basketball is continuous real-time, so neither maps directly. We use the **tennis relay topology** (server stays dumb) with a **host-authoritative simulation** (slot 0 runs one cannon-es world for everything). This is the only model that:

1. Keeps the server a relay (cheap, no physics on the Node box, matches the tennis branch the brief mandates).
2. Gives one source of truth for ball/collision/foul/possession so the two clients can never disagree on the score or who has the ball.
3. Reuses `connectGolf`'s transport wholesale (auto-reconnect, slot reclaim, app-ping, visibility-reconnect, cold-start `waking`).

**Topology**
```
 guest(slot1) ──input frames(30Hz)──▶ server(relay) ──input──▶ host(slot0)
 host(slot0)  ──snapshots(18Hz)─────▶ server(relay) ──snapshot─▶ guest(slot1)
```
The server **never** inspects ball position or score for basketball. It relays two message types between the two seats and arbitrates only lobby/check/rematch control state (which seat is host, has the guest readied the check-ball, etc.). This mirrors tennis's `if (ws.slot !== 0) return;` ball-authority guard (line 241).

---

## 1. New module: `src/sports/basketball/net.js` — `connectBasketball`

Copy `connectGolf` verbatim, then swap the protocol surface. Everything in the transport layer is reused unchanged:

- `getOrCreateClientId()` / `CLIENT_ID_KEY` (sessionStorage slot reclaim) — **reuse**.
- `wsUrl()` (dev `ws://host:3001`, prod same-origin `wss`) — **reuse**.
- `RECONNECT_DELAYS`, `COLD_START_TIMEOUT_MS`, `APP_PING_INTERVAL_MS`/`APP_PING_TIMEOUT_MS`, `openWatchdog`, `scheduleReconnect`, `onVisibility` — **reuse unchanged**.
- `onStatus` state machine (`connecting|waking|connected|reconnecting|disconnected`) — **reuse unchanged**; the basketball orchestrator wires the same `mountConnStatus`/`setConnStatus` dot UI from golf.js (lines 1063-1101).

Signature:
```js
export function connectBasketball({ code, character, onEvent, onStatus } = {}) -> {
  // role discovered from the 'joined' slot: slot 0 = host, slot 1 = guest
  get slot(),         // 0|1
  get status(),
  // --- guest → host (relayed) ---
  sendInput(inputFrame),     // hot path: ~30Hz
  // --- host → guest (relayed) ---
  sendSnapshot(snapshot),    // hot path: ~18Hz
  // --- lobby/control (server-arbitrated) ---
  sendCheckReady(),          // guest signals "ready to receive check ball"
  sendCheckBall(),           // host signals the check ball is live → tip-in/start
  sendRematch(),
  close(),
}
```

`sendInput`/`sendSnapshot` are pure `sendRaw` wrappers (same as `sendShot` in golf net.js line 255). They are gated by role at the **call site** (the orchestrator only calls `sendInput` when `slot===1`, only `sendSnapshot` when `slot===0`), and the server enforces it again (defense in depth, like tennis line 241).

`onEvent` surfaces:
```
'joined' | 'start' | 'opponent-rejoined' | 'opponent-left'
'input'    (host receives this)   { input: <InputFrame>, slot:1 }
'snapshot' (guest receives this)  { snapshot: <Snapshot> }
'check-ready' | 'check-ball' | 'rematch'
'error' | 'closed'
```

The single behavioral change vs golf net.js: the `message` handler routes the two hot-path types by name and forwards the **opaque payload** (`emit({type:'snapshot', snapshot: msg.snapshot})`) without reshaping every field — snapshots are large and reshaping per-message is wasted CPU on the 18Hz guest path.

---

## 2. Input message schema (guest → host)

Sent by the guest at a **fixed 30Hz** (every other 60fps frame), decoupled from render. Buttons are edge-or-held booleans; axes are normalized floats. Each frame carries a monotonically increasing `seq` and the client's high-res clock for RTT/jitter measurement.

```js
// InputFrame — guest → host, ~30Hz
{
  type: 'input',
  seq: 1234,              // u32 monotonic, never resets within a connection
  t: 81234.5,             // performance.now() at sample time (ms), for RTT + dejitter
  ackSnap: 980,           // last snapshot.tick the guest has applied (for host-side reconcile)
  // axes: left stick / WASD movement, camera-relative, normalized to unit disk
  mx: 0.0, my: 0.0,       // move vector, each in [-1,1]
  aim: 0.0,               // facing/aim yaw delta this frame (rad) — mirrors swing.js RMB aim
  // buttons: held state THIS frame (host does edge detection by diffing seqs)
  b: 0b0000000            // bitfield, see below
}
```
`b` bitfield (1 byte is plenty):
```
bit0 SHOOT      (held = charging the meter; release = shot — see §6)
bit1 SPRINT     (drains stamina)
bit2 DRIBBLE_LR (crossover input, paired with mx sign)
bit3 PUMP_FAKE
bit4 STEAL/SWIPE
bit5 BLOCK/CONTEST (held = arms up)
bit6 PASS_NA    (reserved; 1v1 has no teammate, used for "call for ball"/reset)
```

**Why not send every 60fps render frame?** 30Hz halves uplink and the host re-samples held buttons each sim tick anyway. **Why a `seq`?** The host needs ordering and gap detection (TCP guarantees order but the host still wants to know how many sim ticks each input covers). **Why `ackSnap`?** It lets the host compute the guest's effective interpolation delay and is the hook for the optional prediction-reconcile (§5).

Hot path is tiny (~40 bytes JSON). 30Hz × ~50B ≈ **1.5 KB/s up** from the guest. Acceptable.

---

## 3. Snapshot schema (host → guest)

The host runs the authoritative sim and broadcasts a full snapshot at **18Hz** (`SNAPSHOT_HZ=18`, every ~55ms; 3.33 sim ticks at 60Hz per snapshot). Full snapshots (no deltas) because the entity set is tiny: 2 players + 1 ball + rules state.

```js
// Snapshot — host → guest, 18Hz. Compact fixed-order arrays, not verbose objects.
{
  type: 'snapshot',
  tick: 981,              // u32 host sim tick at send time (authoritative clock)
  t: 81250.0,            // host performance.now() (ms) — guest clock-skew estimate
  ackInput: 1234,        // last guest input.seq the host has consumed (closes the loop)
  // ball: pos[3], vel[3]  (vel lets the guest dead-reckon between snapshots if needed)
  ball: [bx,by,bz, vx,vy,vz],
  // players: fixed [slot0, slot1]; each = pos[3], yaw, animState(u8), flags(u8)
  p: [
    [x0,y0,z0, yaw0, anim0, flags0],
    [x1,y1,z1, yaw1, anim1, flags1],
  ],
  // rules state — the authoritative possession/check-ball/score machine (§7)
  r: {
    phase: 2,            // enum: 0 PREGAME,1 CHECK,2 LIVE,3 SHOT_AIR,4 DEAD,5 GAMEOVER
    poss: 0,             // slot with possession (0|1), -1 = loose ball
    score: [7, 5],       // [slot0, slot1]
    needTakeback: 0,     // bitflag: slot must clear past arc before scoring
    shotClock: 14.2,     // optional; streetball often clockless — send if used
    event: 0,            // one-shot event enum this tick (MAKE,MISS,FOUL,STEAL,REBOUND…) for SFX/HUD
    eventSlot: 0,
  }
}
```

`animState` (u8) is an enum the guest maps to a clip: `idle, run, dribble, crossover, jumpshot_rise, jumpshot_release, layup, block, steal, rebound, stumble`. The host owns it; the guest never decides its own animation authoritatively (it may *predict* it locally for its own avatar, §5).

**Size & rate.** Encoded as the array form above, a snapshot JSON-stringifies to ~220-280 bytes. 18Hz ≈ **~4.5 KB/s down** to the guest. If we measure that too high, drop to 15Hz (still fine with interpolation) or switch numeric fields to fixed-point integers (×100 cm, ×1000 rad) to shrink JSON. **Recommendation: ship full-precision floats at 18Hz first; only optimize if profiling shows it.**

**One-shot events** (`r.event`) are carried *in the snapshot*, not as separate reliable messages, so they arrive in-order with the state that produced them. The guest dedupes on `(tick, event)` so a retransmitted/duplicate snapshot doesn't double-play a buzzer. Because WebSocket is TCP (ordered, reliable), a critical event like MAKE/FOUL is never lost — it just may arrive in the next snapshot if a tick was coalesced. To be safe against snapshot coalescing dropping a transient event, the host **latches** `r.event` for 2 consecutive snapshots when it fires.

---

## 4. Host sim loop (slot 0) — fixed timestep + snapshot scheduler

The golf tick uses a **variable** step: `const dt = Math.min(0.05, dtMs/1000); physics.step(dt);` (golf.js lines 1240, 1282). That is fine for golf (one ball, turn-based) but **wrong for authoritative real-time**: collision/foul/shot outcomes would depend on the host's frame rate. The basketball host must run a **fixed-timestep accumulator**:

```js
// HostNetSim — runs ONLY when slot===0
const SIM_HZ = 60, SIM_DT = 1/60;
const SNAPSHOT_HZ = 18, SNAP_INTERVAL = 1/18;
let acc = 0, snapAcc = 0, simTick = 0;

function hostTick(now) {            // called from the same rAF as render
  rafId = requestAnimationFrame(hostTick);
  let dtMs = now - last; last = now;
  acc += Math.min(0.25, dtMs/1000);           // clamp huge gaps (tab refocus)
  // 1) consume queued guest inputs → latestGuestInput (held buttons persist)
  // 2) fixed steps
  while (acc >= SIM_DT) {
    stepSim(SIM_DT);                            // applies BOTH players' inputs
    acc -= SIM_DT; simTick++;
  }
  // 3) snapshot at 18Hz, decoupled from sim and render
  snapAcc += dtMs/1000;
  if (snapAcc >= SNAP_INTERVAL) {
    snapAcc -= SNAP_INTERVAL;
    net.sendSnapshot(encodeSnapshot(world, rules, simTick, lastGuestSeq));
  }
  // 4) render the host's own view from the authoritative world (no interp needed)
  renderHostView();
}
```

`stepSim(SIM_DT)`:
- Apply **host's own input** (read locally, zero latency) and **guest's latest input** (from the relay) to the cannon-es character controllers.
- `world.step(SIM_DT)` — cannon-es ball/rim/backboard/floor collisions (reuse golf physics.js's `CANNON.World` + NaN sanitize guard pattern).
- Run the rules machine (§7): possession transfer on rebound/steal/make, take-it-back gating, foul detection on contest, score updates.
- Run the AI defender on the host only if the opponent seat is a CPU (not in pure 1v1 online; `createAiBaller` copied from `ai.js` lives here for the single-player path and never runs on the guest).

**The guest does NOT run `stepSim`.** Its rAF only does: sample input → `net.sendInput` (30Hz throttle) → `InterpBuffer.sample(renderTime)` → render. This is the tennis model: one authority, one relay.

---

## 5. Client-side interpolation & guest prediction

### 5.1 Interpolation buffer (`InterpBuffer`) — used by the guest for ALL remote entities (ball + host's avatar)

The guest buffers incoming snapshots and renders **`INTERP_DELAY` in the past** so it always has two snapshots to interpolate between, absorbing jitter and the occasional late packet.

```js
// INTERP_DELAY budget = ~2 snapshot intervals + jitter margin
// At 18Hz, one interval = 55ms. Budget = 110ms render-behind-newest.
const INTERP_DELAY_MS = 110;

class InterpBuffer {
  push(snap) { /* insert by snap.t, drop older than 1s */ }
  sample(nowClient) {
    const renderT = nowClient - skew - INTERP_DELAY_MS; // skew = clock offset est.
    // find s0,s1 with s0.t <= renderT <= s1.t, lerp pos/yaw, slerp not needed (yaw only)
    // hermite the ball using vel for smoother arcs: p = lerp(p0,p1,a) but blend in vel
    // if renderT > newest.t (starved): extrapolate ball via vel for up to EXTRAP_MAX_MS,
    //   then hold-last for players (avoid players sliding through walls on packet loss)
  }
}
const EXTRAP_MAX_MS = 120; // ball only; never extrapolate the rules state
```

Clock skew (`skew`): EWMA of `(snap.t - localRecvT)` so the guest's `renderT` is expressed in the host's clock domain. Standard technique; ~50 samples to converge.

**Ball gets velocity-aware extrapolation** (we ship `vel` in the snapshot for this) so a fast pass/shot in flight keeps moving during a brief starvation rather than freezing. **Players hold-last** on starvation (extrapolating a defender into you feels worse than a 1-frame stutter).

### 5.2 Guest prediction of its OWN avatar — recommend the simplest thing that feels OK

Two options, in increasing complexity:

- **(A) Pure interpolation, no prediction.** The guest renders its own avatar from snapshots, same as the remote. Control lag = RTT/2 + INTERP_DELAY (~110-180ms). Movement feels floaty but is trivially correct and ships day one. **Recommend starting here behind a flag.**
- **(B) Local movement prediction + reconciliation.** The guest predicts only its own **horizontal locomotion** (the cheap, forgiving part) immediately on input, while keeping ball/shot/contest authoritative on the host. On each snapshot it reconciles:

```js
// GuestPredictor — predicts ONLY own-avatar position from own input
predictedPos = applyMove(predictedPos, input.mx, input.my, SIM_DT);  // each input tick
onSnapshot(snap) {
  const authPos = snap.p[mySlot].slice(0,3);
  const err = dist(predictedPos, authPos);
  if (err > HARD_SNAP /*0.8m*/) predictedPos = authPos;       // teleport (stumble/foul reset)
  else predictedPos = lerp(predictedPos, authPos, 0.2);       // smooth pull-in (err-correction)
  // No input replay needed: we only predict position, not collisions, so a simple
  // error-correction lerp toward authority is enough (this is "dead reckoning with
  // server correction", not full rollback). Keeps it cheap.
}
```

We deliberately **do not** predict the ball, shots, steals, fouls, or possession on the guest — those are the things that must be authoritative and the things players notice when prediction is wrong. Predicting only locomotion is the NBA-2K-feel sweet spot at minimal complexity. **Recommend enabling (B) once the movement controller is stable; gate behind `PREDICT_SELF` flag so we can A/B feel.**

The host can optionally **input-delay its own avatar by one snapshot interval** (`HOST_FAIRNESS_DELAY`, default off) to equalize the host's zero-latency advantage vs the guest; ship off, enable if guest playtesters report the host "always wins the steal."

---

## 6. Authoritative shot-meter resolution

The shot meter is the golf 3-click/gesture pattern (`swing.js`) adapted to a hold-and-release jump shot. **The meter UI runs locally on whoever is shooting** (so the shooter gets zero-latency visual feedback on their own bar), but **the make/miss is decided on the host**.

Flow:
1. Shooter holds SHOOT (`b` bit0). The local HUD renders a rising/sweeping release meter (reuse `swing.js`'s `power-rising`→`accuracy` state machine shape and `getMeter()` for the HUD bar, golf.js lines 670, 1566-1569).
2. On release the shooter's client sends a **release frame**: the normal input frame plus a release payload (still just bits + one axis — no "I made it" claim):
```js
// release encoded INTO the input frame on the release tick:
{ ...inputFrame, rel: { tRelease: 81260.2, meter: 0.94 } }
// meter ∈ [0,1] is the shooter's locked accuracy reading from the LOCAL meter
// (1.0 = perfect release). Host trusts the timing/meter value but computes the make.
```
   - For the **host shooting**, there is no message — it reads its own meter directly in `stepSim`.
   - For the **guest shooting**, the host receives `rel` and resolves on the next sim tick.
3. **Host `ShotResolver`** computes the make probability authoritatively:
```js
makeProb = baseByShotType(dist, isLayup)         // distance/zone base %
         * meterQuality(rel.meter)                // green window → ×1.0, edges → ×0.5
         * contestPenalty(defenderProximity,armsUp) // host knows BOTH players exactly
         * staminaFactor(shooterStamina)
         * (1 - foulShotFlag ? bonus : 0);
made = hostRng() < makeProb;                       // host owns the RNG seed
// host then drives ball physics: a make = scripted arc into the cup-equivalent rim
// sensor; a miss = physical bounce off rim/backboard via cannon-es. Either way the
// resulting ball trajectory goes out in the NEXT snapshots, so BOTH clients see the
// same arc. The shooter's own "green/red" feedback is shown immediately from meter,
// then confirmed by the snapshot 'event' (MAKE/MISS).
```
   - **Contest is trivially authoritative** because the host has exact positions of both players every sim tick — no need for either client to report "I was contested." This is the big payoff of host-authority for a sport built around shot contests.
   - The shooter sees instant *meter* feedback (their own bar), and the *outcome* lands ~RTT later via the snapshot event. To hide the gap, the local shooter plays the shot **release animation** immediately on release (predicted, non-authoritative cosmetic) and the ball is rendered from the authoritative snapshot once it leaves the hand — so the hand-off is masked by the release windup.

**Anti-cheat note:** a malicious guest could send `meter:1.0` every shot. For a friends-code game this is acceptable (the host could clamp `meter` against the timing plausibility of `tRelease` vs when SHOOT was first held, but that's optional hardening, not v1).

---

## 7. Server changes: `room.sport==='basketball'` branch

Add to `server/index.js`. The server **never** touches ball/score — it relays the two hot-path types and arbitrates only the lobby/check/rematch control flow (which it already does for golf-style `start`/reclaim). Reuse the existing room scaffolding: `newRoom` (generalize `newGolfRoom`), fixed `[slot0,slot1]`, `liveCount`, `scheduleRoomGc`, heartbeat, `broadcast`/`broadcastAll`, the `join`/reclaim path (lines 171-231), and `opponent-left` on close (lines 321-329) — **all unchanged**.

### 7.1 Room shape
```js
function newBasketballRoom(key, sport, code) {
  return {
    key, sport, code,
    players: [null, null],   // slot0 = HOST (authority), slot1 = GUEST
    started: false,          // sticky, same semantics as golf (line 222)
    // basketball control state (NOT sim state — sim lives only on the host client)
    checkReady: [false, false],
    rematch: [false, false],
    gcAt: 0,
  };
}
```
**Host is always slot 0** — guaranteed by the existing "lowest empty slot" assignment (line 203) and stable across reclaim. The orchestrator derives `isHost = (slot===0)` from the `joined` message; no new field needed.

### 7.2 Dispatch branch (insert alongside tennis/golf)
```js
// ---- BASKETBALL ---- (dumb relay; slot0 host runs the authoritative sim)
if (room.sport === 'basketball') {
  if (msg.type === 'input') {
    // guest → host only. Drop if a non-guest sends it (defense in depth).
    if (ws.slot !== 1) return;
    broadcast(room, { type: 'input', input: msg.input, slot: 1 }, ws); // → host
  } else if (msg.type === 'snapshot') {
    // host → guest only. Mirror of tennis's `if (ws.slot !== 0) return;`.
    if (ws.slot !== 0) return;
    broadcast(room, { type: 'snapshot', snapshot: msg.snapshot }, ws); // → guest
  } else if (msg.type === 'check-ready') {        // guest is set; host may inbound the check
    if (ws.slot !== 1) return;
    room.checkReady[1] = true;
    broadcast(room, { type: 'check-ready', slot: 1 }, ws);             // → host
  } else if (msg.type === 'check-ball') {          // host puts the ball live
    if (ws.slot !== 0) return;
    room.checkReady = [false, false];
    broadcast(room, { type: 'check-ball' }, ws);                       // → guest
  } else if (msg.type === 'rematch') {
    room.rematch[ws.slot] = true;
    if (room.rematch[0] && room.rematch[1]) {
      room.rematch = [false, false];
      broadcastAll(room, { type: 'rematch' });    // both → reset to PREGAME/check
    } else {
      broadcast(room, { type: 'rematch-pending', slot: ws.slot }, ws);
    }
  }
  return;
}
```
That is the **entire** server protocol surface for basketball. It is structurally identical to the tennis branch (a relay with a slot-authority guard) plus a tiny rematch counter (modeled on golf's `match-complete` flag).

### 7.3 join/start/reconnect — **already handled**, no new code
- `join` + slot assignment + `joined` + sticky `start` on 2 live players: the generic path at lines 171-229 already does this for any sport; we just route `sport==='basketball'` through `newBasketballRoom`. (Add the constructor to the `room ? ... : ...` selector at line 179-181.)
- `opponent-left` / `opponent-rejoined` / clientId reclaim / `ROOM_TTL_MS` seat-warming: all generic (lines 185-229, 321-329) — **reused unchanged**.

---

## 8. Full client↔server protocol (basketball)

Direction key `c→s` / `s→c` (relayed → "the other seat").

```
--- Lobby (generic, reused from golf/tennis) ---
c→s  { type:'join', sport:'basketball', code, clientId, character? }
s→c  { type:'joined', slot:0|1, code, sport, reclaimed? }
s→c  { type:'start' }                  (first time both seats live)
s→c  { type:'opponent-rejoined' }
s→c  { type:'opponent-left' }
c↔s  { type:'ping', t } / { type:'pong', t }     (app keepalive, reused)

--- Hot path ---
c→s  { type:'input',    input:<InputFrame> }     (guest only; relayed → host)
s→c  { type:'input',    input, slot:1 }          (host receives)
c→s  { type:'snapshot', snapshot:<Snapshot> }    (host only; relayed → guest)
s→c  { type:'snapshot', snapshot }               (guest receives)

--- Check-ball / control ---
c→s  { type:'check-ready' }            (guest: ready for check)   → host
c→s  { type:'check-ball' }             (host: ball is live)       → guest
c→s  { type:'rematch' }                (either seat)
s→c  { type:'rematch' }                (both agreed → reset)
s→c  { type:'rematch-pending', slot }

s→c  { type:'error', error }
```

The shooter's release is **inside** the InputFrame (`rel`), so there is no separate shot message — the host resolves it during `stepSim`. The score, fouls, possession, take-it-back, and game-over (`first to 11, win by 2`) are all **carried in `snapshot.r`** and never sent as discrete reliable messages: the snapshot stream is the single channel for game state, which guarantees the two clients can never desync on the score.

---

## 9. Check-ball / possession / "take it back" — where it lives

Per the fixed product decisions: half-court, single hoop, check-ball, make-it-take-it, take-it-back past the arc on change of possession, first to 11 win by 2. **All of this is authoritative on the host's rules machine** (`r.phase`/`r.poss`/`r.score`/`r.needTakeback` in the snapshot). The netcode pillar's responsibility is only the *handshake* around the check and the broadcast of the resulting state:

1. **PREGAME → CHECK:** host enters `phase=CHECK`, `poss=` (loser of last point, or coin-flip at start). Guest UI shows "check the ball." When the on-ball player is set, guest sends `check-ready`; host sends `check-ball`; host flips `phase=LIVE` on the next sim tick and the snapshot stream carries it.
2. **make-it-take-it:** on a MAKE event, host keeps `poss` with the scorer, sets `needTakeback` bit for them, re-enters `CHECK`. Pure host logic; the guest just renders `r`.
3. **take it back:** host clears the `needTakeback` bit only when that player's position crosses behind the arc; until cleared, a made basket doesn't count (host won't increment `score`). Guest sees the bit in `r.needTakeback` to render the "clear it" prompt.
4. **GAMEOVER:** host sets `phase=GAMEOVER` when `score` hits 11 with a 2-point margin; both clients show the result; either can `rematch`.

This keeps the netcode pillar thin: it transports `r` and arbitrates the single `check-ready`/`check-ball` handshake. The **rules/possession pillar** owns the state machine internals; we only define the wire contract above.

---

## 10. Latency / jitter / packet-loss handling over WebSocket (TCP)

WebSocket is **TCP**, so: ordered + reliable, but with **head-of-line blocking** — one lost segment stalls everything behind it until retransmit (~1 RTT). We cannot drop stale packets at the transport layer the way a UDP game would. Design consequences:

- **Interpolation delay is the primary defense.** `INTERP_DELAY_MS=110` (≈2 snapshot intervals) gives the guest a cushion so a single late snapshot is invisible. Tune per-build; on a bad connection raise to 150ms.
- **Adaptive interp delay (optional, recommended for v2):** the guest measures snapshot inter-arrival jitter (variance of `recvT` deltas) and nudges `INTERP_DELAY_MS` between 90-200ms. More jitter → more delay (smoother but laggier). Standard Source-engine-style lerp adjustment.
- **Coalescing under loss:** if the guest receives a burst of queued snapshots after a stall, it does **not** fast-forward visibly — `InterpBuffer.sample` always renders at `now - INTERP_DELAY`, so it catches up smoothly over the next ~INTERP_DELAY window.
- **Ball extrapolation** (§5.1) covers ball-in-flight during a brief stall; players hold-last.
- **App-level liveness:** reuse golf net.js's `APP_PING`/`APP_PING_TIMEOUT` (lines 67-68, 160-168) — if the socket silently wedges (intermediary), the client force-reopens and the existing reconnect+reclaim flow restores the seat. During reconnect the sim **freezes** (host pauses `stepSim`; guest shows the reused `golf-connstatus` amber dot).
- **No client-side anti-lag for shots:** because shot outcome is host-authoritative and the shooter gets instant *meter* feedback, latency manifests only as a short delay before the ball's authoritative arc appears — masked by the release animation (§6). We explicitly do **not** do lag-compensation/rewind on shots (over-engineering for TCP at these rates).

Practical budget: at a typical 40-80ms RTT, guest end-to-end control→see-result latency ≈ RTT/2 (input up) + ~one sim tick + ~snapshot interval + INTERP_DELAY ≈ **~180-230ms**. With self-prediction (§5.2-B) the guest's *own movement* feels instant; only ball/contest outcomes carry that latency, which is the right tradeoff for a 1v1 hoops feel.

---

## 11. The #1 technical risk + fallback

**This pillar is the #1 technical risk in the whole basketball feature.** The existing netcode has *never* run a continuous real-time loop — golf and tennis are turn-based/relay with no interpolation, prediction, or fixed-timestep authority. Everything in §4-§6 is new code paths. The risks (TCP head-of-line, host advantage, no host migration, sim determinism vs frame rate) are enumerated in the structured `risks` field.

**Fallback if real-time feel is poor: per-possession lockstep.** The protocol is deliberately designed to degrade into this **without a rewrite**:

- Keep the exact same server relay branch and message types.
- Change the host loop so the sim only runs LIVE during an active possession that *originates from a check-ball handshake*, and **between possessions the game is effectively turn-based** (the dead-ball/check/setup phases already pause the sim).
- For the LIVE window, if interpolation feel is unacceptable, restrict the action model: the shooter's drive-and-shoot resolves as a **short authoritative sequence** (like a golf "shot" — guest sends intent + meter, host simulates the whole possession outcome and streams the resulting ball/player arc as snapshots for *playback*, with the defender's input sampled but the contest resolved at release). This is closer to the golf `shot` → `shot-result` model (golf.js lines 522-531, 994-1004) and removes the need for tight bidirectional real-time control — it becomes "both players set up, the possession plays out, repeat," which is robust over TCP.
- Because snapshots are already the only state channel and possession/check is already a discrete host-arbitrated handshake (§9), switching to lockstep-per-possession is a **host-loop change only** — the wire protocol, server branch, transport, and reconnect flow are identical. We can ship real-time, measure feel, and fall back per-possession if needed, all behind a `NET_MODE = 'realtime' | 'possession-lockstep'` flag on the host.

---

## 12. Testing (extend `tests/server.test.js`)

The server test harness (`makeClient`/`waitFor`/`bootServer`, lines 15-54) is the template. Add basketball cases mirroring the golf ones:

1. **Two clients join a basketball room, slots 0/1 assigned, both see `start`** (copy lines 56-73, `sport:'basketball'`).
2. **Relay direction guards:** guest (slot 1) `snapshot` is dropped (no rebroadcast to host); host (slot 0) `input` is dropped. Assert by sending and `waitFor` *not* seeing it within a short timeout (negative assertion).
3. **Input relay:** guest sends `input` → host's buffer receives `{type:'input', input, slot:1}`.
4. **Snapshot relay:** host sends `snapshot` → guest receives `{type:'snapshot', snapshot}` with the payload intact.
5. **Check handshake:** guest `check-ready` → host sees it; host `check-ball` → guest sees it; server clears `checkReady`.
6. **Rematch:** both seats `rematch` → both receive `{type:'rematch'}`; one seat alone → `rematch-pending`.
7. **Reconnect reclaim** (copy lines 130-162 verbatim with `sport:'basketball'`): host drops, reclaims slot 0 with same clientId, guest sees `opponent-rejoined` — proves the sim authority returns to the same seat.

CI already runs `npm test` + `npm run build`; these node:test cases need no browser. The Playwright `.mjs` smoke harness (boots `?sport=…`, samples canvas pixels for blank-render) extends to `?sport=basketball` for render-liveness, but real two-client netcode is covered by the server tests above plus a manual two-tab playtest for *feel* (the thing no automated test can score).

---

## 13. Orchestrator wiring summary (`src/sports/basketball/basketball.js`)

Mirrors `mountGolf` structure (golf.js lines 210, 1099-1228, 1230-1436, 1499-1517):
- `mountBasketball(host, { mode, code, character, cpu, onExit })` → `unmount`.
- One rAF tick. **If host:** the fixed-timestep `hostTick` (§4) — sim + 18Hz snapshot send + render-from-world. **If guest:** sample input → 30Hz `sendInput` → `InterpBuffer.sample` → render; optional `GuestPredictor` for own avatar.
- `net = connectBasketball({code, character, onEvent, onStatus})`; reuse golf's `mountConnStatus`/`setConnStatus`/`showDisconnectBanner` (lines 1063-1101) and the `onStatus` pause-on-disconnect behavior verbatim.
- `unmount()`: `stopped=true; cancelAnimationFrame; net?.close(); physics.dispose(); disposeScene(); host.innerHTML=''` — identical shape to golf's unmount (lines 1499-1517).
- `main.js`/`index.html`/`style.css`: add the menu tile + `mountBasketball` start fn per the sport-module contract (copy the golf/tennis tile pattern; not owned by this pillar but listed for completeness).

---

## Adversarial Critique (AAA-bar review)

**Verdict:** needs-work

### Gaps
- FACTUALLY WRONG PREMISE in §4: the design asserts golf uses a 'variable step (dt=Math.min(0.05,dtMs/1000)) that is WRONG for authoritative real-time' and that basketball 'must' replace it with a fixed-timestep accumulator. But golf/physics.js ALREADY does this: physics.step(dt) at line 447-461 runs `accumulator += min(dt,0.1); while(accumulator>=FIXED_DT && steps<MAX_SUBSTEPS){ world.step(FIXED_DT) }` with FIXED_DT=1/60, MAX_SUBSTEPS=6. The orchestrator's dt=min(0.05,...) is just the frame delta FED to that accumulator, not the physics step. The design reinvents an accumulator the codebase already has and mischaracterizes the existing pattern it claims to build on. This undermines confidence that the author read physics.js. The correct statement: reuse golf's existing fixed-step accumulator wholesale; the only new thing is feeding BOTH players' inputs before world.step and emitting snapshots — not a timestep rewrite.
- The host renders its OWN view directly from the authoritative world (renderHostView, no interpolation) while the guest renders 110ms in the past from interpolated snapshots. This means the two players are NOT looking at the same game state — the host sees the live present, the guest sees the past. For a 1v1 contest sport this creates an asymmetric fairness problem far bigger than the 'host has zero input lag' issue the design acknowledges: the host sees the guest's true current position, the guest sees the host 110ms+RTT stale. A host defender contesting a guest's shot is contesting the REAL shooter; a guest defender is contesting a ghost. HOST_FAIRNESS_DELAY (input delay, off by default) does NOT fix this — it delays the host's input application, not the host's render. To equalize perception the host must also render INTERP_DELAY in the past (render from a ring buffer of its own past authoritative states), which the design never proposes. This is the actual #1 feel risk and it's under-addressed.
- Snapshot rate vs animation feel: 18Hz (55ms) snapshots driving animState as a u8 enum means the guest sees the host's avatar change animation state at most every 55ms, with NO blending data. A jumpshot_rise->jumpshot_release->layup transition sampled at 18Hz will visibly pop/snap on the remote avatar. NBA-2K feel is ALL about animation blending. The design treats animState as a discrete teleporting enum with 'the guest maps to a clip' — there is no crossfade duration, no anim phase/normalized-time field, no root-motion handling. At the AAA bar the remote player will look like a stop-motion puppet. Need at minimum an anim phase float and client-side crossfade, and probably to drive locomotion anim from interpolated velocity rather than a sampled enum.
- Possession/check-ball handshake has a race the design doesn't resolve: §9 says host flips phase=LIVE 'on the next sim tick' after sending check-ball, and the guest learns LIVE only via the snapshot stream (110ms+ later due to interp delay). So the host is live and can move/steal before the guest's screen even shows the ball is live. On a check-ball — the most ceremonially 'fair' moment in streetball — the host gets a free head start every single possession. This compounds the render-asymmetry gap above.
- 'rel' (shot release) is carried inside the InputFrame, but InputFrames are sent at 30Hz and are NOT individually reliable in the sense that matters: TCP delivers them in order, but the host samples 'latestGuestInput' once per sim tick (§4 step 1) and 'held buttons persist'. If two input frames arrive in one host frame, or the release frame's rel is overwritten by a later frame before the host consumes it, the release is LOST. The design says 'host receives rel and resolves on the next sim tick' but the input-coalescing model ('latestGuestInput') explicitly drops intermediate frames. Release is an edge event that MUST NOT be coalesced — it needs its own latched/queued handling, not 'latest wins'.
- 'Two simultaneous shot/steal resolutions need deterministic ordering' is listed as a flagged risk but the design provides NO ordering rule anywhere in the body. For a steal-vs-shoot or block-vs-shoot contested at the same tick (the defining 1v1 moments), the outcome is undefined. This is hand-waved to the risks field instead of specified. Need an explicit resolution order in stepSim (e.g., resolve steals/blocks before shot release, slot tiebreak documented).
- Reconnect freezes the sim ('host pauses stepSim; guest shows amber dot') — but the design never says what happens to a SHOT IN FLIGHT or an in-progress possession on reconnect, nor whether the shot clock / game state is preserved across a host reclaim. Golf reclaim works because state lives on the SERVER; here ALL sim state lives on the host CLIENT. If the host's tab is the one that drops and reclaims, the cannon-es world is GONE (fresh page = fresh world). The design admits 'no host migration' but does NOT admit that host-reclaim itself loses the entire sim unless the host serializes and restores world+rules state on reconnect, which is unspecified. Golf survives reclaim trivially; basketball does not, and the design implies parity it doesn't have.
- Determinism claim is muddled: §4 risks say 'cannon-es determinism is not required (single authority).' True for host-vs-guest. But the guest's GuestPredictor (§5.2-B) runs applyMove independently and reconciles against snapshots — if applyMove's movement model diverges from the host's character controller (which it WILL, since the host's is coupled to cannon-es collisions and the guest's is a bare integrator), the err will be chronically nonzero and the 0.2 lerp pull-in will fight the player's input every snapshot, producing rubber-band on the player's OWN avatar near walls/contact. Predicting only locomotion 'cheaply' without the collision response that the host applies is exactly where dead-reckoning feels worst in a contact sport.
- No mention of TCP_NODELAY / Nagle. Node ws does not set noDelay by default on the underlying socket in all paths; at 18-30Hz small JSON messages, Nagle coalescing + delayed-ACK can add 40ms of latency per hop. For a real-time sport this is a concrete, fixable feel-killer the design omits entirely. Must set socket.setNoDelay(true) server-side and rely on browser WS (already nodelay).
- Score/possession authority is 'carried only in snapshots, never as reliable discrete messages' — presented as a desync-proof feature. But the GAMEOVER and MAKE events are exactly the moments you want a reliable, acked, idempotent message. The design's mitigation (latch r.event for 2 snapshots, dedupe on (tick,event)) handles SFX double-play but NOT the case where the guest disconnects across the GAMEOVER snapshot window: it reconnects, the host has moved to PREGAME/rematch, and the guest never saw the final score transition. Golf sends match-complete as a discrete sticky server state; basketball's 'snapshot-only' game-over can be missed entirely on a reconnect straddling it.

### Must-Fix (applied in synthesis)
- Fix the §4 premise: DO NOT rewrite the timestep. Reuse golf/physics.js's existing accumulator (physics.step(dt), FIXED_DT=1/60, MAX_SUBSTEPS=6 at lines 443-461). The only host-loop changes are: (a) apply both players' latest inputs before each world.step substep, (b) run the rules machine per substep, (c) emit snapshots on a separate 18Hz accumulator. Correct the design text so it builds on the real code, not a misread of it.
- Make the host render its own avatar/world INTERP_DELAY in the past too (ring-buffer of authoritative states, render the same renderT the guest uses). This is the only way to give both seats symmetric perception for contests/steals/blocks. Without it, host wins every contested moment and the game feels rigged to the guest — fatal at the 2K bar. This replaces the weaker, optional HOST_FAIRNESS_DELAY idea.
- Specify deterministic intra-tick resolution order in stepSim and put it in the design body, not the risks field: e.g. per sim tick resolve in fixed order [steals/swipes -> blocks/contests -> shot release -> ball/rim physics -> rebound/possession -> fouls], with slot-0-before-slot-1 tiebreak only where genuinely simultaneous. Contested 1v1 outcomes are undefined until this exists.
- Give shot RELEASE its own reliable edge handling, not coalesced 'latest input wins'. Either: queue input frames on the host and process each (with seq) so no release is dropped, or carry release as a separately-latched field the host drains exactly once and acks via ackInput. Document that held buttons coalesce but edge events (release, pump-fake, steal-press) do not.
- Solve check-ball fairness: the host must not act on phase=LIVE until it estimates the guest has also rendered LIVE (i.e., hold the host's own input until guest's ackInput/ackSnap confirms the LIVE snapshot was applied, OR delay host go-live by INTERP_DELAY). Otherwise the host gets a free jump on every check-ball.
- Commit to fixed-point integer snapshot encoding NOW (pos x100 cm as int16, yaw x1000 as int16, packed array), not 'optimize later if >4KB/s'. It is nearly free, halves parse cost, and removes a deferred risk. Keep JSON for control messages; consider a single typed-array/ArrayBuffer frame for the hot snapshot path since ws supports binary.
- Add anim phase/normalized-time to the per-player snapshot record and client-side crossfade with an explicit blend duration; drive locomotion blend from interpolated velocity, not the sampled enum. An 18Hz teleporting u8 enum will look like stop-motion on the remote avatar — incompatible with the 2K feel.
- Set socket.setNoDelay(true) on every accepted ws server-side (and verify ws library passes it through). Document it. Nagle+delayed-ACK can silently add ~40ms to the hot path.
- Specify host-reclaim state recovery: on host reconnect the cannon-es world is gone, so EITHER persist a minimal authoritative state (score, possession, phase, needTakeback, ball pos/vel, both player transforms) to the SERVER on a low rate (e.g. piggyback every Nth snapshot to a server-held 'last known state' that survives the room TTL) so a reclaimed host can restore, OR explicitly scope online basketball as 'host drop = game over/no-reclaim' and remove the implied golf-parity reconnect promise. Pick one and write it down.
- Make GAMEOVER (and final score) a sticky, server-arbitrated control message like golf's match-complete, in addition to the snapshot r.phase — so a guest reconnecting across the game-over window still learns the result. Snapshot-only game state is fine for continuous play but not for terminal/transactional moments.
- Start with pure interpolation (option A) AND build the per-possession-lockstep NET_MODE in v1, not as a someday-fallback. The design's own #1-risk admission means realtime feel may not clear the bar; having lockstep already wired (it's 'a host-loop change only' per the design) de-risks the entire pillar. Treat lockstep-per-possession as the shippable floor and realtime as the upside, not vice versa.

### Feasibility Notes
Overall topology (tennis relay + host-authoritative sim) is feasible and correctly reuses the codebase. Bandwidth math (~1.5KB/s up, ~4.5KB/s down) is realistic for TCP WebSocket. cannon-es can carry 2 capsules + 1 ball + a few static colliders at 60Hz on a laptop trivially — the sim cost is NOT the risk; the rules/animation state machine and interpolation feel are. Scope to trim for v1: (1) ship pure interpolation (option A), defer GuestPredictor entirely until movement feel is judged; (2) defer adaptive interp delay and HOST_FAIRNESS_DELAY (both correctly flagged optional); (3) ship the per-possession-lockstep mode FIRST or in parallel, not as a 'fallback we can drop into later' — see mustFix. The single biggest feasibility trap is binary framing: this whole design is JSON-over-TCP. ArrayBuffer snapshots are a real option the design dismisses too early given the host must JSON.stringify at 18Hz AND the guest JSON.parse — fine at 2 entities, but the design should commit to the fixed-point int encoding now since it's nearly free and removes the 'optimize later' risk.

