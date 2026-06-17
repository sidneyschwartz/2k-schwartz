# Production Roadmap — 1v1 Half-Court Basketball ("Blacktop") for 2K Schwartz

# Production Roadmap — 1v1 Half-Court Basketball ("Blacktop")

**Producer's framing.** Seven pillar designs landed; all seven came back `needs-work` for the same root reason: **the netcode is the only genuinely net-new system and every pillar leans on it as if it were a copy job.** It is not. The existing online stack is turn-based (golf) plus a dumb relay (tennis) that — per the critiques and confirmed in `server/index.js:179-181` — *never actually fires for non-golf sports today because the generic room path doesn't even carry `sport` into a working relay*. So the roadmap is built around one hard rule:

> **Get a runnable, fun, single-player 3D thing on screen FIRST. Prove the rules math with pure unit tests. Then, and only then, take the netcode risk — with the lockstep fallback already wired, not promised.**

This sequences the de-risking in the right order: **render → feel → rules → AI → netcode → depth → polish.** Online is Milestone 5, not Milestone 1, because (a) all gameplay/feel/physics/rules work is shared and fully testable offline, and (b) shipping online-without-prediction is, per the architecture and netcode critiques, "cheap to build and bad to play" — we must not gate a playable product on it.

Every milestone below names: **Goal · Files · Done-criteria · Tests · Top risk.** Scope-trim guidance and a cross-cutting risk register (netcode = #1) close the document.

---

## Global conventions (apply to every milestone)

- **Module home:** `src/sports/basketball/`. Sports COPY golf patterns; **no shared base class.**
- **Entry contract:** `mountBasketball(host, cfgOrOnExit) -> unmount`, dual-signature like `mountGolf`. Wired into `main.js` (`data-sport="basketball"` + `?basketball=1` deep-link), `index.html` (tile), `style.css` (`.tile--basketball`).
- **One rAF tick**, `dt = Math.min(0.05, dtMs/1000)`, defensive `try{composer.render()}catch{renderer.render()}`, `unmount()` sets `stopped`, cancels rAF, removes listeners, disposes scene/physics, `host.innerHTML=''`.
- **Fixed-timestep discipline from day one:** reuse golf's `physics.js` accumulator verbatim (`FIXED_DT=1/60`, `MAX_SUBSTEPS=6`, confirmed at `physics.js:443-460`). All gameplay-authoritative timing (shot release frames, rules `TICK`, collisions) advances in fixed substeps — **never on render `dt`** — so Milestone 5 host-authority is deterministic without a rewrite. **This is non-negotiable and must land in M1**, because retrofitting fixed-step into a render-dt codebase later is the single most expensive avoidable mistake.
- **Shared constants:** `court-constants.js` (`ARC_RADIUS`, `HOOP_CENTER`, `RIM_*`, `CHECK_SPOT`) is the single source of truth imported by court, rules, physics, AI, and camera. No duplicated magic numbers — a mismatch soft-locks the "take it back" clear (flagged by two pillars).
- **`?debug=1` overlay is a hard requirement, not polish** — it prints live `pMake` inputs and rules phase from M3 onward. The gameplay critique is explicit: without it, balancing is guesswork.

---

## Milestone 0 — Skeleton & Scaffolding (0.5 wk)

**Goal.** A clickable basketball tile that mounts an empty-but-valid sport module and unmounts cleanly. Zero gameplay. This exists so every later milestone has a real harness to run inside and so CI is green from commit one.

**Files created/touched.**
- `src/sports/basketball/basketball.js` — `mountBasketball` shell: normalize cfg, build `scene.js`, single rAF tick that just renders, `unmount()`.
- `src/sports/basketball/scene.js` — copy golf `scene.js`; swap chase cam for a fixed broadcast cam placeholder.
- `src/sports/basketball/court-constants.js` — the shared geometry constants.
- `src/main.js` — `startBasketball()` (clone `startGolf` at `main.js:26`), tile dispatch (`main.js:56`), `?basketball=1` deep-link (`main.js:61`).
- `index.html` — basketball tile (`data-sport="basketball"`).
- `src/style.css` — `.tile--basketball` gradient.

**Done-criteria.**
- Clicking the tile (or `?basketball=1`) mounts a non-blank canvas (a colored ground plane + sky is enough) and `unmount()` returns to the menu with no console errors and no leaked rAF/listeners.
- `npm run build` clean; bundle for the golf path unchanged (lazy `import()` of the basketball module).

**Tests.**
- `tests/basketball-smoke.mjs` — Playwright harness cloning `tests/smoke-browser.mjs`: boot `?basketball=1`, screenshot canvas, **sample pixels to assert non-blank render** (the project's blank-render detector). This file is extended in every subsequent milestone.
- Manual: mount→unmount→mount 3× with no growth in listener count.

**Top risk.** Trivial. Only watch the lazy-import wiring so the golf bundle doesn't regress.

---

## Milestone 1 — Local Single-Player Vertical Slice ★ (2–2.5 wk)

**Goal (the mandated M1).** A **local, single-player, end-to-end playable slice**: a half-court + hoop renders, one keyboard-controlled player dribbles around, holds-and-releases a shot meter, the ball becomes a physics body at release, and **makes/misses score on a rim sensor** — all inside the `mount/unmount` tick. No defender, no rules state machine, no net. This is the "is it fun and does it render" gate. **Everything in M1 is shared code that M5 will reuse unchanged**, which is why we front-load it.

**Files created/touched.**
- `basketball.js` — flesh out the tick to the role-agnostic order: `input → applyInput → physics.step → (M3 rules stub) → camera → render`.
- `court.js` — `buildCourt(scene) -> {handle, isBehindArc, isInbounds, colliders}`: displaced asphalt slab + one baked `CanvasTexture` line overlay; returns collider specs.
- `hoop.js` — `buildHoop(scene) -> {meshes, net, swish(), colliders}`: pole/backboard/rim, nylon verlet net (12 strands × 6 nodes × 3 iters), rim collider as a **ring of ~12–16 static spheres** (not a thin torus — tunneling hazard flagged by physics + gameplay critiques).
- `physics.js` — copy golf `physics.js` accumulator + `sanitize()` guard. One dynamic ball; static floor/rim/backboard colliders; **the make-sensor** (downward plane-crossing inside rim radius with `vy < -0.5`, interpolated within the substep). **Spike the rim collider first** (see risk).
- `controls.js` — `createControls()`: camera-relative WASD locomotion + the **shot meter** (copy `swing.js` phase-machine shape: `idle→rising→release→done`, `getMeter()` for HUD). Hold-LMB/Space rises, release resolves. **Pump-fake on a separate key** (not tap-vs-hold — critique: don't add latency to every shot).
- `player.js` — `createPlayer()`: procedural rig extending golf `characters.js` `buildGolfer`; M1 ships a **minimal pose set** (idle/dribble/gather/jumpshot) — no IK, no layered blend yet. A blob/contact shadow under the player (defer full shadow-casting rig).
- `ballhandler.js` — kinematic dribble anchor (procedural bounce, no physics) + `release` handoff that flips the ball to a dynamic cannon-es body.
- `hud.js` — `mountBballHud(host, getters)`: vertical shot meter + a placeholder score readout. Copy golf `hud.js` rAF-diff-vs-`last` pattern, `getMeter()`-shaped getter.
- `audio.js` — `createBballAudio()` minimum set: `dribble` (impact-pitched), `shot_release`, `swish`, `rim_clank`, `backboard`. Copy golf `audio.js` skeleton (gesture-unlock, baked noise buffers, `NAMES` allowlist, `tickAmbient`).
- `resolve.js` — `pMake(...)` as a **logit model** from day one (critique mandate: `sigmoid(b_type + w_timing·timing + w_contest·(−contest) + …)`, clamp `[0.02,0.985]`, **no GREEN_OPEN_FLOOR hack**). In M1 contest is hardcoded 0 (no defender), so it just exercises timing + range.

**Done-criteria.**
- Court + hoop render at the golf quality bar (golden-hour-ish lighting acceptable as placeholder); 60fps at 1.5× DPR on a mid laptop.
- A human can: move with WASD, dribble (ball glued to hand, audible impact-pitched bounce), hold-release the meter, and **see the ball arc, hit/swish/clank, and a scoreboard increment on a make**. Misses physically rattle off the sphere-ring rim and rebound.
- Ball never NaNs, never tunnels the rim across a full session of shots from varied distances/speeds.
- `unmount()` disposes court/hoop/physics/audio cleanly.

**Tests.**
- `tests/basketball-resolve.test.js` (node:test) — `pMake` calibration: open perfect-timed three ≈ 0.83; large miss-timing < 0.10; monotonic in contest across `[0,1.4]`; clamped `[0.02,0.985]`; **no discontinuity** as contest crosses any boundary.
- `tests/basketball-shotmeter.test.js` — `controls.js` meter phase machine: `idle→rising→release→done`, `getMeter()` shape, `release` fires exactly once with the latched timing value.
- `tests/basketball-makesensor.test.js` — feed synthetic ball trajectories (clean swish, rim-balance crawl, fast downward make, upward pass through plane) to `physics.makeSensor.check`; assert make only on downward crossing inside radius with `vy<-0.5`, and a debounce blocks double-counts.
- `tests/basketball-smoke.mjs` — extend: drive a scripted shot, screenshot mid-flight, assert ball pixels present and finite camera.

**Top risk.** **Rim-collider tunneling** (small fast ball vs thin rim). *Mitigation, and it must happen at the very start of M1:* a one-day physics spike comparing the sphere-ring rim vs a thin cylinder at real shot speeds and the chosen substep; pin `FIXED_DT`/`MAX_SUBSTEPS` (and add swept/CCD on ball-vs-rim if needed) to the spike result **before** building anything else on top. Do not assume 1/120; golf is 1/60 — measure.

---

## Milestone 2 — Animation & Feel Pass (1.5–2 wk)

**Goal.** Make the single player read as 2K-Blacktop: foot-locked locomotion (no skating), authored hero action clips with **gameplay-authoritative release frames**, dribble moves, and the clean kinematic-carry ↔ dynamic-free ball handoff. This milestone de-risks the *animation* claims (layered blend, event frames, IK) while there's still no defender or net to complicate it.

**Files created/touched.**
- `animator.js` — `createAnimator(parts,{onEvent})`: clip sampler + **event frames** (`release`, `block_window`, `land`). Advance clocks in **fixed substeps** (determinism mandate). **v1 ships whole-body crossfade (golf's model), NOT per-joint masked blending** — the masked-layer system is the biggest bug surface and is deferred per the avatars critique.
- `clips.js` — 5–6 fully authored hero clips: `jumpshot`, `layup`, `dunk` (scripted capture, no contact-dunk physics), `crossover`, `hesi`, plus `defensive_slide` (used in M3). Real keyframes, not stubs.
- `ik.js` — 2-bone analytic foot-lock (flat floor ⇒ `footY=0`, trivial). **IK disabled for any leg the active clip's mask owns AND whenever airborne** (critique: kills the "jumpshot stomped into the floor" bug).
- `player.js` — wire animator; **the `release` event is the gameplay trigger** that hands ball to physics (mirrors `swing.js onShot`).
- Dev tool: `?poseScrub=1` URL param to step `actionT` for tuning clips without a Blender pipeline (avatars critique requires a tuning loop).

**Done-criteria.**
- Player moves at speed with locked feet (logged locked-foot world-XZ delta < ε while translating).
- Jumpshot/layup/dunk fire `release` on a deterministic substep regardless of host FPS; the ball leaves the hand exactly at `release`.
- Dribble crossover swaps hands; ball stays glued in carry, converts cleanly to a free body with no teleport/jitter.
- Reads acceptably at 6–12 m broadcast distance with blob shadows.

**Tests.**
- `tests/basketball-clips.test.js` (node:test) — `fireClipEvents` purity: each event fires once at its `t`, ordering stable, `eventsFired` de-dupe works across variable substep counts.
- `tests/basketball-ik.test.js` — analytic 2-bone solver returns correct hip/knee angles for reachable targets; clamps gracefully when over-extended.
- Smoke: screenshot mid-jumpshot and mid-dribble; assert silhouette pixels (non-blank, player occupies expected region).

**Top risk.** Authoring effort underestimated — 5–6 hand-keyed clips is real work and is the critical path to "AAA feel," not a footnote. *Mitigation:* the pose-scrubber dev tool, and a hard scope cap at 6 clips (defer floater/behind-back/posted-up/celebrate to M7).

---

## Milestone 3 — CPU Defender + 1v1 Rules State Machine (2–2.5 wk)

**Goal.** A complete **offline 1v1 game**: pure-reducer streetball rules (check-ball, make-it-take-it, take-it-back, 1s/2s, first-to-11-win-by-2, fouls-as-possession) driven by sim events, plus a CPU defender/handler emitting the human controller's intent shape. This is the "the game is actually a game" gate and the last fully-offline milestone.

**Files created/touched.**
- `rules.js` — the **pure serializable reducer** `nextState(state,event)` + `createMatchState`, `PHASE`/`EVENT` enums, `RULESET_DEFAULT`. Ships with the critique's must-fixes baked in: `CHANGE_POSSESSION` is a *transition helper* not a dead phase; `DEAD_BALL`/`INBOUND` are escapable (`BALL_INBOUNDED` event); a single `resolveAfterScore()` calls `isGameOver` from every scoring path; `seq` bumps **once** per `nextState`; **and-1 make/miss distinction** wired in the `possession` foul ruleset; `reclearOnOffensiveRebound = ON` (2K default); `shotClock`/`stall`/`FREE_THROW` OFF behind flags. Reads `ARC_RADIUS` from `court-constants.js`.
- `core.js` (or fold into `basketball.js`) — drains a per-frame sim **event queue** into the reducer, then a fixed `TICK`. Wires `match.*` (ballLive/mustClear/possession) back into sim control gates and the **`clearedArc` gate on ALL scoring paths**.
- `defense.js` — slide-tracking, contest level (per-frame, defender-driven, feeds `pMake`), block (timed window), steal (handler-exposure-driven). Defer take-charge/offensive-foul to M6 (most collider-fragile, per gameplay critique trim).
- `ai.js` — `createAiBaller({difficulty})` per-frame behavior controller emitting `InputFrame`/intent shape (Gaussian jitter by difficulty — the *only* part that ports from `createAiGolfer`; the controller itself is net-new, per critique). Personas + difficulty table.
- `heat.js` — bounded momentum scalar `[−0.4, 1.0]` feeding `pMake` heatBonus. **Must ship with a simulated no-snowball worst-case run to 11** (heat critique mandate).
- `hud.js` — real score bug (score-to-11, possession dots, GAME POINT), streetball prompt band (CHECK BALL / CLEAR IT / MAKE IT TAKE IT) auto-derived from `phase`, contest-narrowing on the meter zone.
- `?debug=1` overlay — live `pMake` inputs, badge multipliers (stub), rules phase, possession, `mustClear`.

**Done-criteria.**
- A full game to 11 (win by 2) plays start→finish vs CPU: check-ball handshake, makes keep possession, change-of-possession forces a clear past the arc (basket before clear = waved off), 2s beyond arc, deuce logic at 10–10.
- CPU defends (slides, contests, occasionally blocks/steals) and can score on offense at `pro` difficulty.
- Debug overlay shows live `pMake` and rules state.

**Tests.**
- `tests/basketball-rules.test.js` (node:test, the strongest test surface) — exhaustive reducer coverage: make-it-take-it keeps possession & doesn't re-clear after check; basket-before-clear = no points + possession flip; 2-pointer beyond arc; first-to-11 win-by-2 deuce; **reducer purity (input not mutated)**; event de-dup by `id`; **derived events (SHOT_CLOCK_EXPIRED, computed CHANGE_POSSESSION) carry no id and are NOT swallowed by the dedup guard**; and-1 make vs miss vs common foul resolve distinctly; `DEAD_BALL→INBOUND→LIVE` escapes; `isGameOver` reachable from every scoring path.
- `tests/basketball-heat.test.js` — simulate a hot-shooter worst-case streak; assert the score gap cannot snowball past a bound before 11 (no-snowball proof).
- Smoke: play a scripted possession headless-ish via the debug hooks; assert score increments and phase transitions.

**Top risk.** Sim-event ↔ reducer boundary: a double-emitted sensor event (e.g. `BALL_THROUGH_HOOP` on two frames) double-scores. *Mitigation:* monotonic `eventId` de-dup + phase-gating in the reducer (most events rejected by phase), both covered by tests above.

---

## Milestone 4 — Lobby, Character/Loadout, Summary, Audio Bed (1 wk)

**Goal.** Wrap the offline game in the full front-of-house so it's a complete shippable single-player/vs-CPU product **before** we touch online. This is a deliberate checkpoint: if netcode (M5) slips or proves infeasible, **we ship here.**

**Files created/touched.**
- `lobby.js` — `showBballLobby` (clone golf `showLobby`): mode (Practice/Vs CPU/Host/Join — Host/Join are stubbed-disabled until M5), rules step, character, loadout.
- `character-select.js` — clone golf live-portrait wizard; `renderPortrait` calls `createBaller`. Ship **1–2 ballers** behind a placeholder capsule if the rig isn't final (uiux critique: don't render an empty card).
- `loadout.js` — pool-based attributes + ≤3 badges. **Badge catalog ids must match `ratings.js`/gameplay exactly** (cross-pillar dependency, not cosmetic).
- `ratings.js` — attribute vector + badge effects table (multipliers consumed by `pMake`/defense/dribble). Ship the trimmed ~8-badge set.
- `round-summary.js` — `showGameSummary` (clone golf summary) with box-score + Run It Back / Menu.
- `audio.js` — add mixing busses + limiter + `duck()` sidechain (**route whistle/swish/buzzer post-duck so the duck doesn't attenuate the featured sound** — audio critique bug), `cheer`/`and_one`/`whistle`/`buzzer`, crowd bed, a procedural **reverb send** (one ConvolverNode, cheap, biggest perceptual win), stereo pan per voice. **Cut procedural music for v1** (gate behind `setMusicEnabled`, default off — audio critique).
- `vfx.js` — net swish, ball trail, score pop, dunk dust + camera shake.

**Done-criteria.**
- End-to-end: tile → lobby → character → loadout → vs-CPU game to 11 → summary → rematch/menu, no dead UI.
- Loadout attributes/badges measurably change outcomes (verifiable in debug overlay).
- Audio reads as "a place" (reverb + crowd + impact-pitched dribble + duck on whistle/swish).

**Tests.**
- `tests/basketball-ratings.test.js` (node:test) — badge multipliers apply to `pMake`/defense as specced; pool/budget math in loadout is enforced.
- `tests/basketball-summary.test.js` — winner computation, win-by-2, graceful render with missing stats.
- Smoke: walk the lobby wizard headlessly, assert each step renders and resolves a cfg.

**Top risk.** Cross-pillar badge/attribute shape drift between `loadout.js`, `ratings.js`, and the gameplay consumers. *Mitigation:* one canonical catalog object in `ratings.js`, imported by all; the ratings test asserts every badge id is consumed somewhere.

---

## Milestone 5 — Host-Authoritative Online Netcode ★ (3–4 wk, THE risk milestone)

**Goal.** Two humans play online over the existing WebSocket server, **host-authoritative**: slot 0 runs the one authoritative sim and broadcasts snapshots; slot 1 streams input + renders interpolated snapshots **with self-prediction of its own avatar**; the server is a dumb relay. **The per-possession lockstep mode is built in this same milestone as the shippable floor — not deferred** (architecture + netcode critiques: realtime feel "may not clear the bar," so lockstep must already be wired).

**Sequencing inside M5 (de-risk order):**

1. **Prove the relay first (protocol before feel).** Fix the server, write the two-client protocol test, *then* build clients. This directly addresses the #1 must-fix across pillars: the tennis relay is effectively dead code for new sports today.
2. **Pure interpolation** (guest renders everything from snapshots) — correct but floaty. Ship-able checkpoint.
3. **Add guest self-prediction** of own locomotion + error-corrected reconciliation (mandatory — a non-predicted guest in 1v1 is unplayable).
4. **Symmetric perception:** host renders its own view `INTERP_DELAY` in the past (ring-buffer) so contests/steals/blocks are fair (netcode must-fix — without it the guest feels cheated, fatal at the 2K bar).
5. **Lockstep-per-possession `NET_MODE`** as the fallback floor.

**Files created/touched.**
- `server/index.js` — add `room.sport === 'basketball'` relay branch beside tennis (`server/index.js:237`): `input` guest→host (drop if `ws.slot!==1`), `snapshot` host→guest (drop if `ws.slot!==0`), `check-ready`/`check-ball`/`rematch` control. **Fix room creation** so basketball gets a real room with `sport` (today's generic ternary at `:179` is the dead-relay bug). `socket.setNoDelay(true)` on accepted sockets. Add a **server-cached last-snapshot** (tiny: score/phase/possession/ball+player transforms) so a (re)joining guest gets immediate state and game-over survives reconnect.
- `net.js` — `connectBasketball` (copy `connectGolf`: `wsUrl`, clientId/sessionStorage reclaim, reconnect backoff, app ping/pong, visibility-reconnect, status machine). New verbs: `sendInput`, `sendSnapshot`, `sendCheckReady`/`sendCheckBall`, `sendRematch`.
- `snapshot.js` — `encodeSnapshot`/`decodeSnapshot` (**fixed-point int packing from the start** — nearly free, removes a deferred risk), `createInterpolator(bufferMs≈100–110)` with velocity-aware ball extrapolation + hold-last for players. Per-player record carries **anim phase + normalized time** for crossfade (not a teleporting enum).
- `basketball.js` — split tick by role: **host** = fixed-step sim + 18Hz snapshot scheduler + render-from-(delayed)-world; **guest** = sample input → 30–40Hz `sendInput` → interp sample → render + self-prediction. `NET_MODE = 'realtime' | 'possession-lockstep'` flag on the host.
- `resolve.js`/`controls.js` — **shot-meter authority split:** the shooter's meter runs locally for instant feel; the **outcome is host-authoritative** (guest sends release timing in the input frame; host resolves). Guest meter is visually non-committal (no "PERFECT" flash) until the host confirms. **Release/pump/steal are edge events** the host drains exactly once (held buttons coalesce; edges do not).
- `rules.js` — already pure/serializable; its state object IS the snapshot's `r` field. **Game-over also sent as a sticky server-arbitrated control message** (not snapshot-only).

**Done-criteria.**
- Two browsers (host code + join code) play a full game to 11 online; score/possession/clear-state never desync between clients.
- Guest's **own movement feels responsive** (self-prediction); ball/opponent interpolated smoothly through 18Hz snapshots + jitter.
- Contested shots/steals/blocks feel fair to both seats (symmetric `INTERP_DELAY`).
- Host reconnect (clientId reclaim) restores authority and state from the server-cached snapshot; **host drop policy is explicit** (documented forfeit/pause, not silent).
- `NET_MODE='possession-lockstep'` plays a full game (the fallback floor verified, not theoretical).

**Tests.**
- `tests/basketball-relay.test.js` (node:test, clone `server.test.js` `bootServer`/`makeClient`/`waitFor`) — **written FIRST**: two clients join a basketball room, slots 0/1 + `start`; guest `input` relays to host; host `snapshot` relays to guest with payload intact; **direction guards** (host `input` dropped, guest `snapshot` dropped — negative assertions); check-ready/check-ball handshake; rematch counter; **reconnect reclaim** returns authority to the same seat; server-cached state served to a late joiner. Asserts the server never inspects ball/score (stays dumb).
- `tests/basketball-snapshot.test.js` — encode/decode round-trips through fixed-point packing within tolerance; interpolator produces monotonic, finite positions; ball extrapolation bounded; out-of-order/duplicate snapshots handled.
- Smoke: `?basketball=1&net=mock` boots a scripted two-client loopback and asserts non-blank render + finite camera on the guest path.
- **Manual two-tab feel playtest** — the one thing no automated test scores; gate the realtime-vs-lockstep decision on it.

**Top risk.** **THE #1 RISK OF THE ENTIRE FEATURE.** Real-time feel over TCP/WebSocket (head-of-line blocking, host advantage, no host migration, determinism). *Mitigations, all in-milestone:* relay proven by test before client work; pure-interp → self-prediction → symmetric-perception layered incrementally so each is independently shippable; **lockstep-per-possession built as the floor** so a bad feel verdict doesn't sink the product (it's "a host-loop change only," reusing the same wire protocol/server branch). If realtime fails the playtest, we ship lockstep and the M4 offline product is unaffected.

---

## Milestone 6 — Sim-Lite Depth (1.5–2 wk)

**Goal.** Add the systems that were deliberately cut from the playable core: fouls/and-1 surfacing, stamina effects, richer contests, take-charge/offensive fouls, the full badge surface (Posterizer/contact dunks, RimProtector, etc.). Done over a **proven** sim so collider-fragile mechanics land on stable ground.

**Files created/touched.**
- `finishing.js` — drive/dunk/layup/floater decision; **contact dunk + Posterizer stun** (deferred from M1 per gameplay trim — needs the proven capsule collisions).
- `defense.js` — add `take_charge`/offensive-foul (most collider-fragile mechanic — last to land).
- `ratings.js`/`heat.js` — full badge effects + heat glow VFX; final tuning via debug overlay.
- `rules.js` — enable `FREE_THROW` path behind flag if desired; harden foul ledger.
- `hud.js` — badge rail + `badgePop` activations, stamina bar polish, and-1/poster broadcast moments.

**Done-criteria.** Fouls call and resolve (incl. and-1); stamina visibly degrades shooting/speed; ≥1 contact-dunk/poster moment works without mis-triggering on loose colliders; badges measurably move outcomes (debug-verified) and survive a no-snowball check with heat.

**Tests.** Extend `basketball-rules.test.js` (foul/and-1/charge transitions) and `basketball-ratings.test.js` (full badge table). Add `tests/basketball-finishing.test.js` for the dunk/layup/floater decision function (pure). Smoke unaffected.

**Top risk.** Capsule-vs-capsule charge/block collisions mis-trigger on loose collider shapes. *Mitigation:* tight capsule specs validated in a spike; take-charge ships last and is cuttable.

---

## Milestone 7 — Art, Animation & Presentation Polish (1.5–2 wk)

**Goal.** Hit the "AAA-feeling within a browser budget" bar: golden-hour lighting, materials, post-FX, the **1v1 broadcast camera director**, set-dressing, full VFX/audio stings, and the broadcast lower-third.

**Files created/touched.**
- `visuals.js` — copy golf composer chain (RenderPass→SSAO→Bloom→ColorGrade→SMAA→OutputPass), retune for golden hour; PMREM IBL; tight static shadow frustum; **a second tighter shadow cascade following the action box** so *player* shadows don't swim.
- `materials.js` — asphalt/paint/metal/transmissive-glass-backboard/chain-link-fence/net factories (procedural CanvasTexture, no assets). Glass transmission quality-gated; bake AO into asphalt for the no-post fallback.
- `camera.js` — `createCameraDirector` with broadcast/chase/shot/dunk/check modes + `courtIntro` flyover. **Two-subject framing** (lookAt = weighted midpoint of {handler, ball}; dolly back / widen FOV to keep the defender in frame) — the explicit must-fix; `followBall` frames one subject, 1v1 needs two. `camState` exported from `scene.js`.
- `environment.js` — fence (alphaTest diamond shadows), backdrop skyline, billboarded crowd, clutter — all instanced/merged, `setDensity` for quality.
- `quality.js` — low/medium/high presets (post off + plain-transparent backboard + contact-shadow quads + a single fullscreen vignette material on low, so the raw path still reads as "a place").
- `vfx.js`/`audio.js` — final stings: score number-roll, game-point sting, dunk freeze-frame "replay-lite" (cosmetic, not sim time-scale — host/guest safe), block/steal/crossover callouts, crowd reaction variety.

**Done-criteria.** Golden-hour court reads at the 2K-broadcast bar; both players framed continuously through a 1v1 without losing the defender; draw calls ≈60–80 (≤120 ceiling), 60fps at 1.5× DPR with both players + glass backboard on-screen on medium; low preset still reads as a place.

**Tests.** Playwright `basketball-smoke.mjs` extended to screenshot a scripted made-shot from the broadcast cam and assert framing + non-blank + finite camera (golf's pixel-sample approach). Profiling pass (golf-style offline verification) to confirm the triple traversal (main + shadow + transmission) hits the medium frame-time target; define the threshold where medium also drops the transmission backboard.

**Top risk.** The 1v1 two-subject camera (cited template structurally frames one subject) and the main+shadow+transmission triple-pass budget. *Mitigation:* camera is designed/budgeted explicitly here (not a risk-field deferral); transmission and the second shadow cascade are quality-gated with measured fallback thresholds.

---

## Timeline summary

| M | Milestone | Est. | Gate |
|---|---|---|---|
| 0 | Skeleton & scaffolding | 0.5 wk | Tile mounts/unmounts, CI green |
| 1 | **Local single-player vertical slice** ★ | 2–2.5 wk | Renders + dribble + meter + scoring |
| 2 | Animation & feel pass | 1.5–2 wk | Reads as Blacktop, release-frame drives shot |
| 3 | CPU defender + rules state machine | 2–2.5 wk | Full offline game to 11 |
| 4 | Lobby/loadout/summary/audio | 1 wk | **Shippable single-player product** |
| 5 | **Host-authoritative online netcode** ★ | 3–4 wk | Two humans online; lockstep floor wired |
| 6 | Sim-lite depth | 1.5–2 wk | Fouls/stamina/contests/badges |
| 7 | Art/animation/audio/presentation polish | 1.5–2 wk | AAA-feel within budget |

**~13–17 weeks.** Two `★` milestones carry the program: **M1 proves it renders and is fun; M5 carries the only real technical risk.** M4 is the deliberate "ship even if M5 slips" line.

---

## Cross-cutting risk register

| # | Risk | Severity | Mitigation / owner milestone |
|---|---|---|---|
| **1** | **Real-time netcode feel over TCP/WebSocket** (HOL blocking, host advantage, determinism, no host migration). The existing relay is effectively dead for new sports today. | **Critical** | Prove relay by test before client work; layer pure-interp → self-prediction → symmetric host-delay; **build lockstep-per-possession as the floor in the same milestone**; fixed-step sim from M1. **(M5)** |
| 2 | Fixed-step retrofit cost if M1 uses render-`dt` for gameplay timing | High | **Mandate fixed substeps from M1** for all gameplay-authoritative timing; copy golf's accumulator verbatim. **(M0/M1)** |
| 3 | Rim-collider tunneling (small fast ball vs thin rim) | High | Sphere-ring rim + day-one spike to pin substeps/CCD before building on physics. **(M1)** |
| 4 | `pMake` non-intuitive cliffs / contest dead-zone | Medium | Logit model from M1 (no GREEN_OPEN_FLOOR); monotonicity + no-discontinuity unit tests; mandatory debug overlay. **(M1)** |
| 5 | Animation authoring effort underestimated; masked-blend bug surface | Medium-High | Cap at 6 hero clips; pose-scrubber tuning tool; ship whole-body crossfade, defer masked layering. **(M2)** |
| 6 | Cross-pillar shape drift (badges/attrs, snapshot schema, ARC_RADIUS) | Medium | Single canonical catalogs/constants imported everywhere; tests assert consumption; `court-constants.js` shared. **(M3/M4/M5)** |
| 7 | Heat + make-it-take-it snowball | Medium | Simulated worst-case no-snowball proof as a unit test; bounded/decaying heat. **(M3)** |
| 8 | 1v1 two-subject camera (template frames one subject) | Medium | Designed/budgeted explicitly in M7 with a "keep-defender-in-frame" constraint. **(M7)** |
| 9 | Triple render pass (main+shadow+transmission) budget | Medium | Quality-gate transmission + second shadow cascade; measured fallback thresholds; profiling pass. **(M7)** |
| 10 | Collider-fragile mechanics (take-charge, contact dunk) | Medium | Deferred to M6 onto a proven sim; take-charge ships last and is cuttable. **(M6)** |

---

## Where to trim scope (in cut order)

If schedule pressure hits, cut **bottom-up**, protecting the M1→M4 offline core and the M5 lockstep floor:

1. **Online realtime feel** → fall back to `NET_MODE='possession-lockstep'` (already built). The M4 offline product is untouched.
2. **M6 depth, last-in-first-out:** take-charge/offensive fouls → contact-dunk/Posterizer stun → `FREE_THROW` path (stays flagged off) → full badge breadth (ship the ~8 core).
3. **M7 presentation stretch:** night/dusk time-of-day + floodlights, chain-net variant, replay orbit cam, heat-shimmer/chromatic aberration, multi-skin courts → ship **one canonical golden-hour lot**.
4. **M2/M7 animation breadth:** floater, behind-back, posted-up, celebrate/dejection → ship the 6 hero clips.
5. **Audio:** procedural music bed (cut for v1, gated off); `ambient_city`. Reinvest in reverb + crowd-reaction variety.
6. **Loadout depth:** if `ratings.js` consumption isn't ready, ship fixed character presets (no point-pool) — the HUD/lobby degrade gracefully.

**Never cut:** the fixed-step discipline (M1), the rim spike (M1), the logit `pMake` + debug overlay (M1/M3), the pure-reducer rules tests (M3), the relay-first protocol test (M5), and the lockstep floor (M5). These are the load-bearing de-risks; everything else is negotiable.

