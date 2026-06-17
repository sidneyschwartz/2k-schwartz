# Pillar 7 — UI/UX, HUD & Broadcast Presentation

> This pillar owns everything the player reads and clicks for the basketball sport: the menu tile, the lobby/matchmaking wizard, character + loadout/attribute select, the in-game broadcast HUD (score-to-11, possession, shot meter, stamina, badge pops, streetball prompts, connection status), event toasts, a lightweight broadcast layer (score bug + scorer chip + optional dunk slow-mo), and the end-of-game summary. Everything copies the named golf patterns: `mountHud(host,getters)` rAF-diff overlay, `showLobby`/`showCharacterSelect` in-place DOM wizards, `showRoundSummary` overlay, and the golf `connstatus`/disconnect-banner DOM. The HUD is a pure read-model: it pulls one `getBball()` snapshot per frame from the host-authoritative game state and diffs against a `last` cache, so it works identically on host (slot 0, full sim) and guest (slot 1, interpolated snapshot) with zero netcode knowledge.

# Pillar: UI/UX, HUD & Broadcast Presentation — 1v1 Half-Court Basketball

This document specifies every screen and overlay the player reads/clicks, as concrete, implementation-ready modules. It reuses the golf patterns verbatim. New files live in `src/sports/basketball/`.

**Files this pillar owns**
- `src/main.js` (+ menu tile wiring), `src/index.html` (tile), `src/style.css` (tile gradient + all bball UI CSS)
- `src/sports/basketball/lobby.js` — `showBballLobby(host) -> Promise<cfg|null>`
- `src/sports/basketball/character-select.js` — `showBballSelect(host) -> Promise<character>`
- `src/sports/basketball/loadout.js` — attribute/badge picker (new step, same DOM-wizard idiom)
- `src/sports/basketball/hud.js` — `mountBballHud(host, getters) -> unmount` (with `.setPrompt`, `.showToast`, `.broadcast`, `.root`)
- `src/sports/basketball/round-summary.js` — `showGameSummary(host, opts) -> cleanup`
- CSS is added under a single `.bb-*` BEM namespace (mirrors `.golf-hud__*`).

The orchestrator `mountBasketball(host, cfgOrOnExit)` (other pillar) owns the rAF tick, game state, and netcode. **This pillar never reads netcode or physics directly** — it reads one pull-based snapshot per frame and renders. That is the entire contract.

---

## 1. The read-model contract (the single most important thing)

The golf HUD pulls many small getters (`getMeter`, `getStrokes`, …) and diffs each against a `last` cache (hud.js:172-330). At 1v1 real-time pace I keep the **pull-based + rAF-diff** pattern but collapse the getters into **one snapshot getter** plus a few stable-list getters. Rationale: golf's getters read cheap scalars; basketball state changes every frame (ball pos isn't HUD-relevant, but score/shotclock/meter/stamina are), and one allocation-free snapshot object per frame is cheaper and avoids 12 closure calls.

### 1.1 `getters` passed to `mountBballHud(host, getters)`

```js
const getters = {
  // ONE snapshot per frame. Host builds from sim; guest builds from last
  // interpolated server snapshot. Same shape both sides. Allocation-free:
  // the game reuses a single object and mutates fields (HUD only reads).
  getState: () => bballState,   // shape below — REQUIRED
  // Stable/rarely-changing lists (read once, re-read cheaply; diffed by identity/hash):
  getPlayers: () => [           // index 0 = slot0, 1 = slot1
    { slot:0, name:'Sid',     char:'tiger',   accent:'#ffcc33', isMe:true  },
    { slot:1, name:'Brunson', char:'brunson', accent:'#1f6dd6', isMe:false },
  ],
  getBadges: (slot) => [ 'limitless', 'clamps', 'posterizer' ], // owned badge ids, for the badge rail
};
```

### 1.2 `bballState` shape (the read-model)

This is the **exact** contract the gameplay/possession pillars must populate. Every field is optional-tolerant (HUD defaults each), exactly like golf's `getMeter()` tolerating both naming forms (hud.js:23-27).

```js
bballState = {
  // ---- SCOREBOARD ----
  score:      [7, 5],          // [slot0, slot1] points, streetball 1s & 2s
  target:     11,              // first to 11, win by 2
  gamePoint:  false,           // a player is 1 bucket from winning (drives the "GAME POINT" bug)

  // ---- POSSESSION / STATE MACHINE ----
  possession: 0,               // slot index with the ball, or -1 (loose ball / live rebound)
  phase:      'live',          // 'checkball' | 'clear' | 'live' | 'deadball' | 'inbound' | 'gameover'
  //   checkball = at top of key, waiting for check pass
  //   clear     = on-ball team must "take it back" past the arc (make-it-take-it / change of poss.)
  //   live      = ball in play
  //   deadball  = made basket / whistle, brief
  needClear:  true,            // true while the on-ball player still has to clear past the arc
  ballHandler: 0,              // slot dribbling (for the "ball" dot on the possession pill)

  // ---- SHOT CLOCK (streetball "no-clock" is a config; if enabled:) ----
  shotClock:  null,            // seconds remaining (number) or null = no shot clock this match

  // ---- SHOT METER (only meaningful for the local player while shooting) ----
  meter: {
    phase: 'idle',             // 'idle' | 'rising' | 'release' | 'done'  (see §5)
    power: 0.0,                // 0..1 fill height (release timing bar)
    perfectZone: [0.86, 0.96], // [lo,hi] in 0..1 — the green "excellent release" window
    feedback: null,            // null | 'perfect' | 'early' | 'late' | 'verylate'  (post-release flash)
    contested: false,          // defender contest raises difficulty → narrows zone visually
  },

  // ---- STAMINA (local player) ----
  stamina:   0.78,             // 0..1, drains on sprint/dribble moves, regens when idle
  staminaLow: false,           // <0.2 → pulse red

  // ---- BADGE / SIGNATURE ACTIVATIONS (transient, host stamps a monotonically rising id) ----
  badgePop:  null,             // null | { id:42, badge:'limitless', tier:'HOF', slot:0 } — id changes each pop

  // ---- BROADCAST EVENTS (transient, id-stamped so HUD fires once) ----
  event:     null,             // null | { id:108, kind:'swish'|'and1'|'block'|'steal'|'dunk'|'brick'|'bucket',
                               //          slot:0, points:2, slowmo:false }

  // ---- CONNECTION (guest mirrors host clock; host is always 'connected') ----
  conn:      'connected',      // 'connecting'|'waking'|'connected'|'reconnecting'|'disconnected'
  selfSlot:  0,                // which slot *I* am (drives "you"/"opp" coloring + meter ownership)
};
```

**Why id-stamped transients?** golf fires toasts/stats imperatively from net code (`showHudToast(...)`, golf.js:1108) and gates the stats card by object identity (`stats !== last.statsRef`, hud.js:303). For a host-authoritative sim, the cleanest equivalent is: the host stamps `event.id` / `badgePop.id` each time something happens; the HUD compares the id to `last.eventId` and fires the toast/animation exactly once. This survives snapshot interpolation, dropped frames, and the guest receiving the same snapshot twice — no double toasts, no missed swish.

---

## 2. Menu tile + main-menu entry (`main.js`, `index.html`, `style.css`)

Mirror the golf tile wiring exactly (main.js:8,26-33,56; the tile is keyed by `data-sport`).

**index.html** — add a tile next to golf/tennis:
```html
<button class="tile tile--basketball" data-sport="basketball">
  <span class="tile__emoji">&#127936;</span>            <!-- 🏀 -->
  <span class="tile__name">Blacktop</span>
  <span class="tile__sub">1v1 half-court · first to 11</span>
</button>
```

**main.js** — copy `startGolf` (main.js:26-33) to `startBasketball`, lazy-import to keep the golf-only bundle lean:
```js
async function startBasketball() {
  const cfg = await showBballLobby(host);   // from basketball/lobby.js
  if (!cfg) return showMenu();
  clearHost();
  const { mountBasketball } = await import('./sports/basketball/basketball.js');
  unmount = mountBasketball(host, { ...cfg, onExit: showMenu });
}
// in the tile dispatch (main.js:56):
if (b.dataset.sport === 'basketball') startBasketball();
// dev deep-link, mirroring ?golf=1 (main.js:61):
if (params.get('sport') === 'basketball' || params.get('bball') === '1') bootDirectBasketball();
```

**style.css** — tile gradient (hardwood/asphalt vibe; golf uses a green tile gradient):
```css
.tile--basketball{ background:linear-gradient(150deg,#e8852b 0%,#7a3b12 60%,#241008 100%); }
.tile--basketball .tile__name{ text-shadow:0 1px 0 rgba(0,0,0,.5); }
```

---

## 3. Lobby / matchmaking (`lobby.js`)

Copy `showLobby` (lobby.js:32-307) one-to-one: a `<section class="screen lobby">` with a `.lobby-body` whose `innerHTML` is swapped per step, a single `resolve(cfg|null)`, back-to-sports exit. **Reuse the existing `.mode-tile`, `.code-card`, `.code-input`, `.btn` CSS** — zero new lobby CSS needed (host/join steps are visually identical to golf; only labels differ).

### 3.1 Steps
1. **Mode** — 4 tiles, identical markup to golf's mode-grid (lobby.js:43-64) with bball copy:
   - `single` → "Practice" (shoot-around vs no defender / empty gym)
   - `cpu` → "Vs CPU" (pick opponent + difficulty; reuse golf's persona+difficulty step, lobby.js:93-158, swapping `listAiGolfer` → `listAiDefenders`)
   - `host` → "Host a match" (random 4-char code via golf's `randomCode`, lobby.js:206-235 verbatim)
   - `join` → "Join a match" (`.lobby-code-input`, validation, lobby.js:237-266 verbatim)
2. **Game rules** (replaces golf's "Round length", lobby.js:172-204) — tiles for the streetball variant:
   - `ones`  → "1s" — every bucket = 1 (first to 11)
   - `twos`  → "1s & 2s" — inside arc 1, behind arc 2 (DEFAULT, selected)
   - plus two toggles rendered as pill buttons: **Make-it-take-it** (default ON), **Shot clock** (default OFF → `shotClock:null`).
3. **Character** → `showBballSelect(body)` (§4).
4. **Loadout** → `showLoadout(body, character)` (§4.2) — only for `host`/`cpu`/`join`; `single` can skip to a default loadout.
5. `cpu` → opponent select; else `finish()`.

### 3.2 Resolved cfg
```js
resolve({
  mode: 'single'|'cpu'|'host'|'join',
  code?: 'AB3K',
  character,                       // full descriptor from showBballSelect
  loadout,                         // { attrs:{speed,shooting,...}, badges:[...] }  (§4.2)
  cpu?: { personaId, difficulty }, // when mode==='cpu'
  rules: { scoring:'twos', target:11, winBy:2, makeItTakeIt:true, shotClockSec:null },
});
```

### 3.3 ASCII wireframe — mode step (reuses golf grid)
```
+------------------------------------------------------------+
|  Blacktop                                                  |
|  How are we running it?                                    |
|                                                            |
|   [ 🏀 Practice ]   [ 🤖 Vs CPU ]                          |
|   [ 🏆 Host ]       [ 🔗 Join ]      (primary = Host)      |
|                                                            |
|  ← back to sports                                          |
+------------------------------------------------------------+
```
### 3.4 ASCII — host code step (verbatim golf `.code-card`)
```
+----------------------------------+
|  Your match code                 |
|  Send it to your brother.        |
|     +----------------------+     |
|     |   A  B  3  K         |     |
|     +----------------------+   [Copy]
|  ← change mode      Continue →   |
+----------------------------------+
```

---

## 4. Character + loadout/attribute select

### 4.1 Character select (`character-select.js`)
Copy `showCharacterSelect` (character-select.js:151-248) wholesale — the live-portrait Three.js card grid, keyboard/gamepad nav, `selected` ring, `resolve({...chosen, preset})`. Changes are purely data + the portrait builder:
- `CHARACTERS` array swaps golfers for ballers (still 2 to start: e.g. `tiger`→a slasher build, `brunson`→a sharpshooter build), each `{id,name,tagline,accent,avatar}`.
- `renderPortrait(canvas, id)` calls the basketball pillar's `createBaller({character:id})` instead of `createGolfer`, sets an `idle`/`dribble` pose, slow Y-spin (character-select.js:133-143). Camera framing tighter (player ~1.9m tall): `camera.position.set(2.2,1.7,4.0); camera.lookAt(0,1.1,0)`. Reuse the same 3-light rig (key/hemi/rim, character-select.js:113-120).
- **Perf:** identical to golf — 2 tiny `alpha:true` WebGLRenderers at `pixelRatio<=2`, disposed on confirm (character-select.js:145-148). Already proven in-budget.

```
+-------------------------------------------------------------+
|              Pick your baller                               |
|   +------------------+      +------------------+            |
|   | (T)              |      | (B)              |            |
|   |   [3D portrait   |      |   [3D portrait   |  ← selected|
|   |    spinning]     |      |    spinning]     |     ring   |
|   | Tiger Schwartz   |      | Brunson Schwartz |            |
|   | Ice in the veins |      | Big stick energy |            |
|   +------------------+      +------------------+            |
|         ← → switch · Enter / A confirm                      |
+-------------------------------------------------------------+
```

### 4.2 Loadout / attribute select (`loadout.js`) — NEW step, golf-wizard idiom
A "2K MyPlayer-lite" build screen. Same DOM-swap-in-`.lobby-body` pattern. Resolves a `loadout` object. Keep it **a budget pool, not free sliders** to stay balanced and fast to read.

- **6 attributes**, each 0–99, allocated from a fixed pool (e.g. 360 points, so the average is 60). Rendered as labeled bars with `−`/`+` steppers; the pool counter updates live (a single text node diff, no re-render):
  `Speed · Shooting · Inside · Defense · Stamina · Ball-handling`
- **Up to 3 badges** from a small catalog, each with a tier (Bronze/Silver/Gold/HOF). These are the things the HUD's badge rail (§5.5) and `badgePop` animate. Catalog examples: `Limitless Range`, `Clamps`, `Posterizer`, `Quick First Step`, `Deadeye`, `Pick Dodger`.
- Each tier costs pool-independent "badge points" (e.g. 8 total; Bronze1/Silver2/Gold3/HOF4) so a build trades breadth vs depth.

```js
showLoadout(host, character) -> Promise<{ attrs:{speed,shooting,inside,defense,stamina,handle}, badges:[{id,tier}] }>
```

```
+--------------------------------------------------------------+
|  Build your game            Attribute points: [ 92 ]         |
|                                                              |
|  Speed        [ − ] ████████████░░░░░░  72  [ + ]            |
|  Shooting     [ − ] ██████████████░░░░  84  [ + ]            |
|  Inside       [ − ] ████████░░░░░░░░░░  55  [ + ]            |
|  Defense      [ − ] █████████░░░░░░░░░  60  [ + ]            |
|  Stamina      [ − ] ███████████░░░░░░░  68  [ + ]            |
|  Handle       [ − ] ████████████░░░░░░  74  [ + ]            |
|                                                              |
|  Badges (2/3)        Badge pts: [ 3 ]                        |
|   [Limitless ◆HOF] [Clamps ◇Gold] [+ Posterizer] [+ Deadeye]|
|                                                              |
|     ← back            Run it →                               |
+--------------------------------------------------------------+
```
**Perf/feasibility:** pure DOM, no WebGL. Steppers mutate one bar width + two counters; trivial.

---

## 5. In-game HUD (`hud.js`) — the broadcast overlay

`mountBballHud(host, getters)` returns `unmount` with `.setPrompt`, `.showToast`, `.broadcast`, `.root` attached (golf attaches `.setTurn`/`.showToast`/`.root`, hud.js:359-361). The orchestrator mounts it into a `pointer-events:none; position:fixed; inset:0; z-index:10` host div exactly like golf (golf.js:662-667), and async-imports it with a queued-call fallback (golf.js:698-712, `pendingHudCalls`). Same single `tick()` rAF loop with a `last` cache; **every DOM write is gated by a diff** (hud.js:188-330).

### 5.1 Full-screen layout (ASCII wireframe)
```
+================================================================================+
|  SCORE BUG (top-center, broadcast style)                                       |
|        +--------------------------------------------------+                    |
|        |  ● SID    07     —     05    BRUNSON     ●        |   ◐ Connected     | <- conn dot (top-right)
|        |     (●=has ball)        GAME POINT? / :14 clock   |                    |
|        +--------------------------------------------------+                    |
|                                                                                |
|   PROMPT BAND (under bug, only when phase needs it):                           |
|        [  CHECK BALL  ]   /  [ CLEAR IT! ]  /  [ MAKE IT, TAKE IT ]            |
|                                                                                |
|                                                                                |
|                          ( 3D court / players )                                |
|                                                                                |
|  BADGE RAIL (left edge, vertical):                                             |
|   [◆]  <- glows + label slides out on activation                               |
|   [◇]                                                                          |
|   [◇]                                                                          |
|                                                                                |
|                                        SHOT METER (bottom-center, vertical):   |
|                                              ┌─┐                               |
|                                              │ │  <- green perfect zone band    |
|  STAMINA (bottom-left):                      │█│  <- fill rises with release   |
|   ▓▓▓▓▓▓▓░░░  stamina                         └─┘                               |
|                                              PERFECT! (feedback flash)         |
+================================================================================+
```

### 5.2 Score bug (the centerpiece — "2K broadcast" read)
A center-top pill. Diff-bound fields: `score[0]`, `score[1]`, possession dots (`possession`/`ballHandler`), and a right-hand status slot that shows, in priority order: `GAME POINT` (when `gamePoint`) > shot clock `:14` (when `shotClock!=null`) > nothing.

```js
// in tick(): each guarded like golf hud.js:193-197
if (s.score[0] !== last.s0){ els.s0.textContent = pad2(s.score[0]); els.scoreBug.classList.toggle('bb-bug--lead-l', s.score[0]>s.score[1]); last.s0 = s.score[0]; }
if (s.score[1] !== last.s1){ els.s1.textContent = pad2(s.score[1]); ... last.s1 = s.score[1]; }
if (s.possession !== last.poss){ els.dotL.hidden = s.possession!==0; els.dotR.hidden = s.possession!==1; last.poss = s.possession; }
// status slot
const status = s.gamePoint ? 'GAME POINT' : (s.shotClock!=null ? ':'+Math.ceil(s.shotClock) : '');
if (status !== last.status){ els.bugStatus.textContent = status; els.bugStatus.dataset.kind = s.gamePoint?'gp':(s.shotClock!=null?'clock':''); last.status = status; }
```
Player name plates use `getPlayers()[i].accent` for the dot/underline color, and the local player (`isMe`) gets a subtle ring. Score color flips to gold on `gamePoint`.

### 5.3 Streetball prompt band (`setPrompt` + auto from `phase`)
Replaces golf's `turnbar` (hud.js:83-85,334-343). Drives the streetball state machine prompts, **derived from `phase`/`needClear`** so the gameplay sim doesn't have to call imperatively (but `.setPrompt(text,kind)` is still exposed for net/host overrides, mirroring `setTurn`):

| `phase` / flag | Prompt text | kind (CSS color) |
|---|---|---|
| `checkball`, ball is mine | `CHECK BALL — pass to check` | `check` (white) |
| `checkball`, opp's ball | `Opponent checking…` | `wait` (grey) |
| `clear` / `needClear`, mine | `CLEAR IT — take it back past the arc` | `clear` (amber, pulsing) |
| `clear`, opp's | `Defense — they must clear` | `wait` |
| `inbound` | `Inbound` | `wait` |
| `gameover` | (hidden; summary takes over) | — |
| `live` | hidden | — |

```js
function autoPrompt(s, me){
  if (s.phase==='checkball') return s.possession===me
    ? {t:'CHECK BALL — pass to check', k:'check'} : {t:'Opponent checking…', k:'wait'};
  if (s.phase==='clear' || s.needClear) return s.possession===me
    ? {t:'CLEAR IT — take it back past the arc', k:'clear'} : {t:'Make them clear it', k:'wait'};
  if (s.phase==='inbound') return {t:'Inbound', k:'wait'};
  return null; // hidden
}
// diffed by `${t}|${k}` against last.prompt; toggles [hidden] + dataset.kind
```

### 5.4 Shot meter (vertical) — copies golf's meter mechanics, new visual
Golf's meter is a **3-click** machine (power→lock→accuracy, hud.js:222-271). 2K shooting is a **hold-and-release timing** meter: hold to start the jumper, the fill rises, release inside the green "perfect" window. So the *state model is simpler* (no second accuracy click) but the **rendering technique is identical**: a track, a fill whose extent maps a 0..1 value, a zone band, and a post-action feedback flash. I reuse golf's exact diff-render approach (`power*100 → width/height %`, hud.js:239-244; zone band positioned from `perfectZone`, hud.js:256-264).

- `meter.phase`: `idle` (hidden) → `rising` (fill grows as button held) → `release` (one frame, compares release power to `perfectZone`) → `done`/`idle`.
- **Fill** = vertical height `meter.power*100%`.
- **Perfect zone** = a green band drawn from `perfectZone[0]..perfectZone[1]` of the track height. `contested:true` → the band is rendered narrower + tinted orange (visual "harder shot"); the actual narrowing value is supplied by the sim, HUD just draws it.
- **Feedback flash**: on `meter.feedback` change (`'perfect'|'early'|'late'|'verylate'`), flash a label + tint (green/yellow/red), reusing the toast fade idiom (hud.js:344-351). Cleared on `idle`.
- The meter is shown **only for the local player** and **only while `meter.phase!=='idle'`**, so the guest never sees the host's meter and vice-versa (`meter` in the snapshot is the *recipient's own* meter — host fills it for itself, guest fills it from its local input prediction so it feels instant; see Risks).

```js
// meter render (guarded like hud.js:239-271)
const m = s.meter || {phase:'idle'};
if (m.phase !== last.mPhase){ els.meter.hidden = (m.phase==='idle'); els.meter.dataset.phase=m.phase; last.mPhase=m.phase; }
if (m.phase!=='idle'){
  const h = Math.round(clamp01(m.power)*1000)/10;
  if (h!==last.mFill){ els.meterFill.style.height = h+'%'; last.mFill=h; }
  const zk = m.perfectZone.join('_');
  if (zk!==last.mZone){
    els.meterZone.style.bottom = (m.perfectZone[0]*100)+'%';
    els.meterZone.style.height = ((m.perfectZone[1]-m.perfectZone[0])*100)+'%';
    els.meterZone.classList.toggle('bb-meter__zone--contested', !!m.contested);
    last.mZone=zk;
  }
}
if (m.feedback!==last.mFb){ if(m.feedback) flashFeedback(m.feedback); last.mFb=m.feedback; }
```

### 5.5 Badge rail + `badgePop`
Left-edge vertical rail of owned-badge glyphs (from `getBadges(selfSlot)`), each a small diamond tinted by tier. On `badgePop.id` change **for my slot**, the matching glyph pulses and a label slides out (`LIMITLESS RANGE · HOF`), then retracts after ~1.4s. Opponent badge pops route to a toast instead (§6) so they don't clutter my rail. Implemented as a CSS keyframe toggled by adding/removing a class — no per-frame work, only on the id-change event.

### 5.6 Stamina bar
Bottom-left horizontal bar, `stamina*100%` width, color-graded green→amber→red. `staminaLow` adds a pulse class. Single width-diff per frame (golf does the same for power fill).

### 5.7 Connection status + disconnect banner
Copy golf's `connstatus` chip and `disconnect` banner **verbatim** (golf.js:1063-1101 + the `.golf-connstatus__*` / `.golf-disconnect` CSS), renamed `.bb-connstatus` / `.bb-disconnect`. Drive it from `s.conn` (same 5 states, same amber/green/red mapping, golf.js:1071-1083). The banner pauses the sim on `disconnected` for the guest; on the host, slot-1 drop shows "Opponent disconnected — waiting to reconnect" using the same banner but **doesn't** pause the host clock indefinitely (host keeps possession state; uses the empty-room TTL window). This is identical UX to golf's reconnect handling (golf.js:1215-1224), just continuous instead of turn-based.

---

## 6. Toasts & event presentation (`showToast` + `broadcast`)

Two transient layers, both fired from the **id-stamped `event`** (§1.2), diffed once:

```js
if (s.event && s.event.id !== last.eventId){
  last.eventId = s.event.id;
  presentEvent(s.event, s.selfSlot);   // routes to toast and/or broadcast
}
```

**Toast** (top-mid, fade in/out — copy golf hud.js:344-351 exactly). Event → copy table:

| `event.kind` | toast text | accent | also triggers |
|---|---|---|---|
| `swish`   | `SWISH` | green | scorer chip |
| `bucket`  | `BUCKET +N` | white | scorer chip |
| `and1`    | `AND-1!` | gold | scorer chip + screen flash |
| `dunk`    | `POSTER!` | gold | scorer chip + optional slow-mo (§7) |
| `block`   | `REJECTED` | blue | — |
| `steal`   | `STEAL` | cyan | — |
| `brick`   | `BRICK` | grey | (only show on bad-release misses) |

Toasts are de-prioritized for the local vs opponent perspective: my made bucket reads `BUCKET +2`, the opponent's reads `THEY SCORE +2` (use `event.slot === selfSlot`). Mirrors golf coloring "your turn" vs "opponent".

**`broadcast(payload)`** is the imperative escape hatch (like `showToast`) for the orchestrator to push a scripted broadcast moment (e.g. tip-off "FIRST TO 11", "GAME!"). It animates the §7 lower-third.

---

## 7. Broadcast presentation layer (`.broadcast` lower-third + optional dunk slow-mo)

A thin "TV graphics" layer above the HUD, deliberately cheap:

1. **Scorer chip / lower-third.** On a `bucket`/`and1`/`dunk` event, slide in a lower-third for ~2s: `SID  ▸  7`  with the player accent bar and the running score. Pure DOM slide (CSS transform), one element reused (cache + re-text, never re-create). This is the highest-ROI "AAA feel" item and is essentially free.

2. **Game-point / match-point bug state.** When `gamePoint` flips true, the score bug pulses gold and the lower-third announces `GAME POINT`. On the winning bucket, `phase:'gameover'` + `event.kind` drive a full-width `GAME!` sting before the summary mounts.

3. **Dunk slow-mo (OPTIONAL, host-gated, feasibility-bounded).** *Recommendation: ship a "replay-lite", not true slow-mo, for v1.* True slow-mo requires the sim to scale `dt` and the camera to cut — that's a gameplay/camera concern, not this pillar, and over a 30Hz snapshot stream the guest can't be slowed cleanly without desync. Instead this pillar provides:
   - **Flash + vignette + freeze-frame card** on `event.slowmo:true`: a 0.6s dark vignette with the `POSTER!` graphic and the scorer's name, no sim manipulation. Works identically host/guest because it's purely cosmetic over whatever frame is on screen.
   - If the camera/gameplay pillars later add a real "time-scale" hook, this layer already exposes `broadcast({type:'replay', ...})` to drape graphics over it. **Do not block v1 on real slow-mo.**

**Perf budget for the whole broadcast layer:** all DOM/CSS transforms on a handful of reused nodes, work only on discrete events (not per-frame). Negligible. The per-frame cost stays = golf's HUD (a dozen guarded scalar diffs).

---

## 8. End-of-game summary (`round-summary.js`)

Copy `showRoundSummary` (round-summary.js:16-106): a `.bb-summary` overlay with an open transition (`requestAnimationFrame(() => overlay.classList.add('...--open'))`, round-summary.js:89), `Play Again` / `Back to Menu` buttons wired to `onPlayAgain`/`onExit`, and a `cleanup()` that fades out then removes (round-summary.js:100-103). Replace the golf scorecard table with a **box-score**:

```js
showGameSummary(host, {
  players,          // [{name,char,accent}]
  score,            // [11, 9]
  winnerSlot,       // 0|1
  rules,            // {scoring:'twos', target:11, ...}
  stats,            // optional per-player: { fgMade, fgAtt, threes, dunks, blocks, steals, biggestRun }
  onPlayAgain, onExit,
})
```

```
+----------------------------------------------------+
|                  GAME.                             |
|            SID  defeats  BRUNSON                    |
|                  11  —  9                           |
|  +----------------------------------------------+  |
|  |          SID        BRUNSON                   |  |
|  |  FG      6/11        5/12                      |  |
|  |  2PT     2           1                         |  |
|  |  Dunks   1           0                         |  |
|  |  Blocks  2           1                         |  |
|  |  Steals  3           1                         |  |
|  |  Best run 5-0        3-0                        |  |
|  +----------------------------------------------+  |
|        [ Back to menu ]   [ Run it back ]          |
+----------------------------------------------------+
```
Winner line reuses golf's `computeWinner`-style helper (round-summary.js:108-120), trivially adapted to "higher score wins, win-by-2 already enforced by the sim." If `stats` is absent, render just the final score + buttons (graceful, like golf tolerating missing scores).

---

## 9. CSS namespace & where it lives
All new CSS goes in `src/style.css` under `.bb-*` (BEM, mirroring `.golf-hud__*`). Reused as-is from golf (no duplication): `.btn`, `.btn--primary`, `.ghost`, `.screen`, `.lobby*`, `.mode-tile*`, `.code-card`, `.code-input`, `.round-grid/.round-tile` (renamed copy for the rules step). New blocks: `.bb-bug`, `.bb-prompt`, `.bb-meter`, `.bb-stamina`, `.bb-badge-rail`, `.bb-toast`, `.bb-lowerthird`, `.bb-summary`, `.bb-connstatus`, `.bb-disconnect`. The character-select style is injected via the same `ensureStyle`/`STYLE_ID` mechanism (character-select.js:81-88) to keep it self-contained.

---

## 10. Build/perf summary & testing hooks
- **Per-frame cost** = golf HUD: ~15 guarded scalar comparisons, a handful of style writes only on change. Safe at 60fps alongside the WebGL court.
- **No WebGL in the HUD.** Only the character-select portraits use WebGL (2 tiny disposed renderers, already proven by golf).
- **Lazy import** of the whole basketball module from `main.js` keeps the golf path's bundle unchanged.
- **Testability:** the HUD is a pure function of `getState()`. A unit test can mount `mountBballHud(div, {getState:()=>fakeSnap, ...})`, mutate `fakeSnap`, step rAF (or expose an internal `tick()` for tests), and assert `div.textContent`/classes — no server, no Three.js. This complements the Playwright `?sport=basketball` smoke harness (boots the canvas, samples pixels for blank-render) and the `server.test.js`-style relay test owned by the netcode pillar.


---

## Adversarial Critique (AAA-bar review)

**Verdict:** needs-work

### Gaps
- BROADCAST POLISH IS UNDERSPECIFIED AS PSEUDO-AAA. The 'broadcast' layer is a CSS slide-in lower-third + a vignette freeze-frame card. That is the floor, not the NBA 2K Blacktop bar. 2K's read comes from animated number rolls on the score bug, a kinetic scorer chip with photo/jersey accent, anticipation/overshoot easing, screen-shake on dunks, and crucially AUDIO stings synced to graphics. The design names audio.js as available but never wires a single broadcast SFX (swish whoosh, buzzer, crowd 'ohh' on a poster). A silent lower-third reads as a web form, not a broadcast. This is the single biggest gap to the stated bar.
- TOAST STACKING CONTRADICTS THE CITED GOLF CODE. The design asserts 'toasts are top-center single-slot to avoid stacking' and 'one element reused (cache + re-text, never re-create)'. But golf's showToast (hud.js:344-351) CREATES A NEW DOM NODE per call and appends it — verbatim copy stacks/overlaps. In a real-time game, swish+and1+badge can fire within ~200ms; copying golf gives you three overlapping toasts. The 'single-slot' behavior is asserted but not designed (no queue, no replace-in-place logic).
- THE 'COPY TENNIS' RELAY FOUNDATION DOESN'T EXIST CLIENT-SIDE. The design (and the brief) lean on tennis as the continuous dumb-relay template. The tennis CLIENT (src/sports/tennis/tennis.js) is a 113-line single-player 2D canvas stub with ZERO netcode — the relay is only a 10-line server branch (server/index.js:237-247) and old code in git history. This pillar is fine (it never touches netcode), but the read-model's id-stamped-transient + interpolated-snapshot assumptions rest on a netcode pillar that has no working client precedent to copy. The risk the author flagged (coalesced snapshots dropping a unique event.id) is real and the only mitigation offered ('sticky for ~3 snapshots') is hand-waved onto another pillar.
- CHARACTER/LOADOUT PORTRAIT TREATED AS 'PURELY DATA' BUT ISN'T. Section 4.1 says swapping createGolfer->createBaller is 'purely data + the portrait builder.' createGolfer is a ~600-line procedural rigged humanoid (characters.js:603) with swing-state poses. A basketball baller with idle/dribble pose, ball-in-hand, and 1.9m proportions is a whole other-pillar deliverable. The character-select rewrite is cheap; the thing it renders is not, and the dependency is buried as a one-liner. listAiDefenders is similarly invoked as a trivial listAiGolfer swap.
- SHOT METER OWNERSHIP IS THE LOAD-BEARING FEEL ITEM AND IT'S PUNTED. The design admits the meter must render from LOCAL input prediction on the guest (not host snapshot) or it feels broken at RTT, then says 'gameplay/netcode pillars must honor this.' But the read-model contract (one getState() snapshot, same shape both sides) directly conflicts with this: meter.phase/power can't come from the same interpolated snapshot path as score/possession if it must be locally predicted. The HUD contract as written ('meter in the snapshot is the recipient's-own meter') quietly requires the host AND guest to populate meter from different sources into the same field — that split is the actual hard part and it's named as someone else's problem.
- POSSESSION/LOOSE-BALL VISUAL IS A KNOWN HOLE. possession:-1 (live rebound/loose ball) hides BOTH dots — during the most exciting moment (a contested board) the score bug goes blank/ambiguous. The author lists this as an open question; for a 1v1 streetball game where every loose ball matters, 'hide both dots' is a visible regression from broadcast feel.
- SHOT-CLOCK TOGGLE MAY BE DEAD UI. The rules step exposes a Shot clock toggle and the bug supports :14, but the open questions admit it may always be null for streetball. Shipping a lobby toggle that does nothing is exactly the generic/hand-wavy tell a reviewer flags. Decide before building the toggle.
- NO STATE FOR THE MOMENTS THAT DEFINE 2K FEEL: ankle-breakers/crossovers, contest/contact on the shot beyond a 'contested' bool, and-1 contact, putback dunks. The 'signature moves' promised in the brief surface in the HUD only as generic badgePop glyphs on a left rail. There's no design for a crossover/ankle-break callout — arguably the most iconic streetball broadcast moment — even though the read-model could carry it as another event.kind.

### Must-Fix (applied in synthesis)
- Wire broadcast AUDIO via the existing audio.js: add swish/clank/buzzer/poster/and-1 stings fired off the SAME id-stamped event the toasts use (one call site in presentEvent). A silent broadcast layer cannot meet the 2K bar; this is the highest ROI fix and audio.js already exists with no asset files.
- Replace the 'copy golf showToast' plan with a real single-slot toast: one reused DOM node + a tiny priority queue (and-1/poster > steal/block > bucket > brick) that replaces-in-place rather than appending. As written, copying hud.js:344-351 verbatim stacks toasts and contradicts the design's own claim.
- Resolve the meter-ownership conflict IN THIS PILLAR's contract, not by deferring: split the read-model so meter (and stamina) are read from a LOCAL getMeter()/getStamina() getter (host: own sim, guest: local input prediction) while score/possession/phase/events come from the snapshot getState(). Keeping meter inside the single interpolated snapshot is the latency bug the author already predicted. Make getMeter a first-class getter like golf's, not a field in getState().
- Add animated number rolls + easing to the score bug and lower-third (count-up on score change, overshoot/settle on game-point pulse). Diff-gated CSS transition on textContent change is cheap and is what separates 'broadcast' from 'web form'. Specify the actual transition, don't just say 'pulses gold'.
- Add screen-shake / impact on dunk+and-1 (a short transform keyframe on the HUD root or a body class), and define the and-1 'screen flash' concretely (color, duration, opacity curve) — currently it's listed in the toast table with no spec.
- Define the possession:-1 loose-ball indicator: show a contested/jump-ball glyph or animate both dots dimmed-pulsing, never a blank bug. This is a 1-line read-model branch with outsized feel impact.
- Cut or commit the shot-clock toggle: either make it functional (decide streetball default + bug behavior) or remove it from the rules step so there is no dead UI.
- Add a crossover/ankle-breaker event.kind to the read-model and a dedicated callout (toast + audio) — the marquee streetball broadcast moment is currently absent. Cheap to add now, expensive to retrofit the contract later.
- Mark createBaller and listAiDefenders as explicit blocking dependencies with an agreed shape, and gate character-select behind a placeholder (e.g. a simple capsule baller) so this pillar isn't blocked on the full rigged-humanoid deliverable. Don't ship a portrait card that renders nothing.
- Agree the {attrs, badges, badge tiers} canonical catalog with the gameplay/AI pillar BEFORE building loadout.js, or the entire loadout step is cosmetic (the author's own flagged risk). The HUD badge rail + badgePop ids must match the gameplay badge ids exactly.

### Feasibility Notes
Per-frame HUD cost is genuinely fine: it is the proven golf diff-gated scalar pattern (hud.js:188-330) with no per-frame WebGL, and the character-select 2-renderer portrait pattern is already in-budget (alpha:true, pixelRatio<=2, disposed on confirm — verified at character-select.js:90-148). The DOM/CSS broadcast layer is cheap and correctly event-gated. The cosmetic freeze-frame instead of true bullet-time slow-mo is the RIGHT call for a 30Hz interpolated snapshot stream — keep that descope. Where to trim scope for v1: ship 1 selectable baller (not a carousel) until createBaller exists; drop the shot clock entirely (streetball has none) and remove the toggle; defer the box-score stats table to score-only if the host doesn't track FG/blocks (the design already degrades gracefully). Where NOT to trim: broadcast audio stings and the score-bug number roll are cheap and are precisely what buys the AAA read — do not cut them to save time. The real schedule risk is not this pillar's per-frame cost but its hidden cross-pillar dependencies (createBaller, the meter-ownership split in netcode, and the badge catalog), which are written as one-liners but are the actual critical path.

