# Pillar 8 — Audio Design (Procedural Web Audio)

> A fully procedural audio module for 1v1 Blacktop, copying the golf `createAudio()` template verbatim in structure: lazy `ensureCtx()` with gesture-unlock, pre-baked noise buffers (white/pink/brown), a NAMES allowlist routed through `play(name,opts)`, managed loops, and a `tickAmbient(dt)` LFO driver. It adds a small mixing topology (master → 4 group busses: sfx/court/crowd/music) with sidechain ducking, a host-authoritative event map so only slot 0 fires gameplay one-shots (mirrored to slot 1 via snapshot flags), and a light rhythmic music bed synthesized from oscillators. No asset files; ~16 named sounds + 3 loops, all CPU-cheap (short envelopes, shared buffers).

# Basketball Audio Design — Procedural Web Audio

**Pillar:** Sound for 1v1 half-court Blacktop. **Pattern source:** `src/sports/golf/audio.js` (`createAudio()`), wired exactly like golf wires it in `src/sports/golf/golf.js` (discrete `audio.play(name,opts)` on sim events, `audio.tickAmbient(dt)` every frame, `audio.setMuted(b)` from settings).

This document is implementation-ready: every sound has a synthesis recipe (waveforms / noise color / filter / ADSR), the module has full signatures, and there is a complete event map plus mixing/ducking spec.

---

## 1. Module skeleton — `src/sports/basketball/audio.js`

Copy the golf module's exact shape. Same helpers (`makeNoiseBuffer`, an `envGain`-style envelope helper), same lazy `ensureCtx()` + gesture-unlock, same `NAMES` allowlist gating `play()`, same managed-loop slots, same `tickAmbient(dt)`, same `setMuted`. Export `createBballAudio()` and a `bballSfxFor(event)` mapper (the `clubHitName()` analog).

```js
// src/sports/basketball/audio.js
const NAMES = [
  // one-shots
  'dribble',        // opts:{ impact:0..1, surface:'blacktop'|'rim' }
  'shot_release',   // whoosh
  'swish',          // opts:{ net:'chain'|'nylon' }
  'rim_clank',      // opts:{ hard:0..1 }
  'rim_roll',       // short metallic roll (managed micro-loop, see §4)
  'backboard',      // bank off glass
  'sneaker_squeak', // opts:{ intensity:0..1 }
  'body_contact',   // contest bump; opts:{ hard:0..1 }
  'whistle',        // opts:{ kind:'foul'|'check'|'violation' }
  'buzzer',         // shot-clock / period-end
  'cheer',          // made-basket pop
  'and_one',        // crowd "ooh" + layered cheer
  'score_blip',     // UI tick when scoreboard increments
  'check_thud',     // ball check-pass to defender
  // loops
  'crowd_bed',
  'music_bed',
  'ambient_city',   // optional outdoor bed under crowd
];

export function createBballAudio() {
  let ctx=null, master=null, limiter=null;
  let busses=null;            // {sfx, court, crowd, music}
  let duckGain=null;          // sidechain target on sfx+court
  let muted=false, musicOn=true;
  let buffers=null;           // {white,pink,brown, chainIR}

  const loops = {
    crowd_bed:   { src:null, gain:null, filter:null, level:0 },
    music_bed:   { running:false, gain:null, nextNoteTime:0, step:0 },
    ambient_city:{ src:null, gain:null, filter:null },
    rim_roll:    { src:null, gain:null, filter:null }, // micro-loop
  };

  function ensureCtx(){ /* identical to golf: build ctx, master, gesture resume */ }
  // ... synths below ...
  return {
    play, tickAmbient, setMuted,
    setMusicEnabled, duck,           // extras over golf
    get muted(){ return muted; }
  };
}
```

`ensureCtx()` is line-for-line the golf version **plus** the mixing graph in §2. The gesture-unlock (`pointerdown`/`keydown` `{once:true}` → `ctx.resume()`) is copied verbatim — basketball needs it identically since the lobby/menu click is the unlock gesture.

`play(name,opts)` is the golf `switch`: reject names not in `NAMES`, `ensureCtx()`, resume-if-suspended, dispatch. `setMuted` ramps `master.gain` to 0/0.7 over 0.1s and tears down loops, exactly as golf does.

---

## 2. Mixing topology (the one real addition over golf)

Golf has `master` + a single `ambientGain`. Basketball runs **3 loops + frequent one-shots simultaneously**, so it needs group busses, headroom, ducking, and a final limiter to prevent clipping.

```
oscillators/noise --> [per-voice gain] --> groupBus --> duckGain(sfx/court only)
                                                      \--> master(0.7) --> limiter --> destination
groupBus levels (linear gain):
  sfxGain   = 0.9   (dribble, shot, body, sneaker, blips)
  courtGain = 0.85  (swish, rim, backboard, check)   -> routed through duckGain
  crowdGain = 0.5   (crowd bed + cheer + and-one)
  musicGain = 0.32  (rhythmic bed)
limiter = DynamicsCompressorNode {threshold:-3, knee:6, ratio:12, attack:0.003, release:0.12}
```

- `sfxGain` and `courtGain` connect through a shared **`duckGain`** node before master (crowd/music bypass duck so the bed never pumps).
- The final `limiter` is the headroom guarantee golf lacks. It is one node, negligible cost, and stops crowd+music+rapid-dribble from summing past 0 dBFS.

**`duck(amount, attackS, releaseS)`** — sidechain dip used by whistles/buzzer/swish so the call/result punches through gameplay:

```js
function duck(amount=0.45, atk=0.02, rel=0.35){
  if(!ctx) return;
  const t=ctx.currentTime;
  duckGain.gain.cancelScheduledValues(t);
  duckGain.gain.setValueAtTime(duckGain.gain.value, t);
  duckGain.gain.linearRampToValueAtTime(amount, t+atk);   // dip
  duckGain.gain.linearRampToValueAtTime(1.0,    t+atk+rel); // recover
}
```

---

## 3. One-shot synthesis recipes

All envelopes use the golf idiom: `setValueAtTime` → `linearRampToValueAtTime` attack → `exponentialRampToValueAtTime(0.0001, …)` release. Buffers are the shared pre-baked `white/pink/brown` from `ensureCtx()` (golf already bakes these once — copy it). Times are relative to `t0 = ctx.currentTime`.

### 3.1 `dribble` — pitch varies with height/speed  *(hero sound)*
Per-bounce composite: a **brown-noise thump** (rubber-on-blacktop) + a short **sine "pock"** body.
- `impact = clamp((dropHeight*0.6 + ballSpeed*0.1), 0..1)` computed by caller from sim (ball vy at floor contact, see §6).
- Thump: `brown` buffer → lowpass `freq = 180 + impact*260`, `Q=0.7`. Gain ADSR: A=0.001, peak `0.25+impact*0.45`, exp release `0.07 + impact*0.05`.
- Pock: `sine`, `freq = (140 + impact*120)` with a fast pitch-drop `freq*1.6 → freq` over 0.012s (gives the "tock" snap). Gain peak `0.18+impact*0.3`, release 0.06.
- `surface:'rim'` variant (ball off rim during dribble-rare): swap lowpass for bandpass at 1600Hz, add 6dB.
- **Cost control:** exactly 4 nodes/bounce (2 sources, 2 gains, 1 shared filter chain). At a crossover (~8/s) that's ~32 short-lived nodes/sec — fine; they auto-GC on `stop()`.

### 3.2 `shot_release` — whoosh
White-noise band-sweep simulating arm/ball cutting air.
- `white` buffer → **bandpass**, `freq: 1200 → 3800` exp over 0.18s, `Q=0.8`.
- Gain: A=0.01 to peak 0.22, exp release 0.22. Subtle stereo: detune via a second voice +5% freq at 0.6 gain (optional).

### 3.3 `swish` — chain vs nylon
The marquee result sound. Two recipes off the same trigger:
- **nylon** (indoor): two stacked white-noise bursts ("sh-shf"). Burst = `white` → bandpass `2600Hz Q=2`, gain A=0.004 peak 0.3 release 0.05; second burst at +0.045s, freq 2200, 0.7 gain. Soft, dry.
- **chain** (blacktop default): metallic, ringing. `white` → **comb/resonant** stack: feed through 3 bandpass filters at 1850/2750/3900Hz (Q=9) summed, then a short `exponentialRamp` 0.14s release. Add 2 detuned `triangle` pings at 2100/3150Hz (gain 0.12, release 0.18) for the "ching". Reads distinctly metallic vs nylon's airy hiss.
- Caller passes `{net:'chain'}` by default (Blacktop). Always `duck(0.4,0.01,0.3)` so the swish sits forward.

### 3.4 `rim_clank` — hard miss off iron
Inharmonic metallic clank: 3 detuned `square`/`triangle` partials at non-integer ratios.
- Partials: `square` 430Hz, `triangle` 690Hz, `square` 1170Hz (ratios ~1:1.6:2.72). Each: gain peak `0.18..0.3 * hard`, exp release `0.12 + hard*0.18`.
- Add `white` → bandpass 2500Hz Q=4 transient (A=0.001, peak 0.25*hard, release 0.04) for the "tang" attack.
- `hard` from impact speed of ball→rim contact (sim provides relative speed).

### 3.5 `rim_roll` — ball rattling the rim
Managed **micro-loop** (see §4), not a one-shot: looping `brown` → bandpass 900Hz with an LFO-wobbled center + amplitude tremolo (gain LFO 8Hz). Started when sim flags ball-on-rim contact streak, stopped on settle/fall-through. Mirrors golf's `startBallRoll`/`stopBallRoll`/`setBallRollSpeed` exactly.

### 3.6 `backboard` — bank off glass
Bright resonant knock + glassy ring.
- Body: `triangle` 520Hz, fast drop 520→300 over 0.02s, gain peak 0.5, release 0.16.
- Glass ring: 2 `sine` partials 2400/3600Hz, gain 0.12, release 0.30 (longer = "glassy").
- Transient: `white` → highpass 3000Hz, 0.02s blip.

### 3.7 `sneaker_squeak` — cuts/jukes
Pitched filtered-noise chirp (the classic "EEK").
- `white` → **bandpass** with a **rising→falling** center sweep: `1900 → 3200 → 2400` over 0.18s, `Q=14` (high Q = vocal/squeaky). Gain A=0.01 peak `0.12+intensity*0.18`, release 0.16.
- `intensity` from player lateral accel / direction-change magnitude (sim/controller provides speed delta on a hard cut).

### 3.8 `body_contact` — contest bump / box-out
Low dull thud, no ring.
- `brown` → lowpass 220Hz, gain peak `0.3+hard*0.4`, release `0.1+hard*0.08`.
- Add tiny `sine` 90Hz "oomph" (gain 0.2*hard, release 0.12). Fabric rustle: `white` → bandpass 1500Hz Q=1, very low gain 0.06, release 0.05.

### 3.9 `whistle` — foul / check / violation
Two detuned high `sine`/`triangle` with fast pulse tremolo = pea-whistle.
- Carriers: `triangle` 2400Hz + `sine` 2412Hz (12Hz beat → shrill). Tremolo: gain LFO `square`-ish 18Hz via a gain modulated by a fast oscillator, or just `setValueCurveAtTime` of a pulsing array.
- Envelope by `kind`: `foul` = two blasts (0.18s, gap 0.09s, 0.18s); `check` = single 0.22s blast; `violation` (24s/backcourt) = three short chirps.
- Always `duck(0.5,0.015,0.4)` — the whistle owns the mix momentarily.

### 3.10 `buzzer` — shot-clock expiry / game point
Harsh sustained buzzer.
- `sawtooth` 180Hz + `sawtooth` 182Hz (beating) → **distortion** via light WaveShaper (or just sum 3 saws 180/240/360). Add amplitude tremolo 30Hz for the "BRRRT".
- Length: shot-clock = 0.6s; period/game-end = 1.4s with a slow gain fade-tail. `duck(0.55,0.01,0.6)`.

### 3.11 `cheer` — made basket
Golf already has `playCrowdClap` (white→bandpass 1400Hz, slow swell ~1.6s). **Copy it**, raise peak to 0.45, shorten to 1.1s, and add a quick crowd-bed excitement bump (`crowd_bed.level += 0.3` for 1.5s, §4).

### 3.12 `and_one` — and-1 reaction
Layered: a crowd **"OOOH"** (pink → bandpass center sweep 500→900Hz, slow 0.5s swell-down, gain 0.4) immediately followed (+0.25s, scheduled on `ctx.currentTime`, **not** setTimeout) by `cheer` at +20% gain. Bumps crowd bed harder (`+0.5`, 2.5s). This is the signature "Blacktop" moment.

### 3.13 `score_blip` / `check_thud`
- `score_blip`: golf's `playClick` recipe (`square` 1800Hz, 0.05s exp) — copy directly, route to `sfxGain`. Fired by HUD on scoreboard increment.
- `check_thud`: single `dribble`-thump at fixed `impact=0.5` plus a `body_contact` low oomph — the check-ball pass to the defender at the top of the arc.

---

## 4. Loops (managed, golf-pattern)

Three persistent loops, each a slot in `loops{}` with `start/stop` and gain ramps, exactly like golf's `ball_roll` + `wind_ambient`.

### 4.1 `crowd_bed`
Golf `wind_ambient` clone: `pink` buffer, `loop=true` → highpass 90Hz → lowpass (LFO-driven 500→1100Hz from `tickAmbient`) → `crowdGain`. Fade in over 1.2s. **Excitement model:** a `level` field (0..1) drives gain `0.18 + level*0.4`; events bump it (`cheer:+0.3`, `and_one:+0.5`, `buzzer:+0.2`), and `tickAmbient` decays it: `level += (target-level)*min(1,dt*0.8)` then `target *= 0.96`. This makes the crowd swell on big plays and settle — the cheap "alive arena" trick.

### 4.2 `music_bed` (light rhythmic bed)
A 4-on-the-floor blacktop beat synthesized with a **lookahead scheduler** (golf has no scheduler; add a tiny one driven from `tickAmbient`). Tempo ~92 BPM. Per 16th-step the scheduler (looking ~0.12s ahead vs `ctx.currentTime`) emits:
- **Kick** (steps 0,4,8,12): `sine` 120→45Hz drop over 0.09s, gain 0.5 exp release 0.12.
- **Hat** (off-beats): `white` → highpass 7000Hz, 0.03s blip, gain 0.12.
- **Bass arp** (steps 0,6,10): `sawtooth` through lowpass 600Hz, root note cycling a minor pentatonic [A1,C2,D2,E2], gain 0.18 release 0.18.
- **Snare/clap** (steps 4,12): white → bandpass 1800Hz, 0.05s, gain 0.2.

```js
function tickMusic(){
  if(!loops.music_bed.running || !musicOn) return;
  const m=loops.music_bed, ahead=0.12, spb=60/92/4; // 16th
  while(m.nextNoteTime < ctx.currentTime + ahead){
    scheduleStep(m.step % 16, m.nextNoteTime);
    m.nextNoteTime += spb; m.step++;
  }
}
```
`tickMusic()` is called from `tickAmbient(dt)`. The bed gates by phase: **on** during live play (low gain 0.32), **ducked to ~0.12** during check-ball/dead-ball, **off** at game-end (replaced by cheer). Toggle via `setMusicEnabled(false)` for users who want silence — independent of `setMuted`.

### 4.3 `ambient_city` (optional outdoor bed)
Very low `brown`→lowpass 300Hz drone + occasional scheduled distant-traffic swells. Sits at gain 0.08 under the crowd. Cuttable if perf-constrained; default **on** for Blacktop flavor.

### 4.4 `tickAmbient(dt)` — the per-frame driver
Called from the golf-style rAF tick (`audio.tickAmbient(dt)` in `bball.js`). Responsibilities, in order: ensure `crowd_bed`/`ambient_city`/`music_bed` started; advance crowd `level` decay; LFO-sweep crowd lowpass (copy golf's `_ambientClock` sine LFO); call `tickMusic()`. No allocations in steady state except the short-lived music voices.

---

## 5. Audio event map (host-authoritative)

Per the netcode constraint, **slot 0 (host) runs the sim and is the source of truth for all gameplay audio.** Two firing paths:

1. **Host-local events** — host fires `audio.play(...)` directly from its sim callbacks (it already computes every collision/score).
2. **Guest mirroring** — the host snapshot carries an `audioEvents` array (id + opts) per tick; the guest replays them through `play()`. Discrete, low-rate events (swish, whistle, cheer, rim, buzzer, score) go this route — they tolerate the ~15-20Hz snapshot cadence.
3. **Guest-local prediction for high-rate audio** — **dribble** must NOT round-trip. The guest synthesizes dribble locally from the interpolated ball height in its render state: when interpolated ball `vy` crosses zero near floor `y`, fire `dribble` with `impact` from the pre-bounce speed. This keeps dribble tight on both clients regardless of snapshot rate. (Sneaker squeak similarly can be guest-local from interpolated player accel.)

### Event → sound bindings

| Game event (sim / state machine) | `play()` call | Bus | Notes |
|---|---|---|---|
| Ball–floor contact (dribble) | `dribble` `{impact}` | sfx | host-local + guest-predicted; see §6 |
| Hard direction change / juke | `sneaker_squeak` `{intensity}` | sfx | from controller accel |
| Shot launched (release frame of shot meter) | `shot_release` | sfx | shot meter is the `swing.js` analog |
| Made FG (clean) | `swish` `{net:'chain'}` → then `cheer` | court→crowd | duck on swish |
| Make off glass | `backboard` → `swish` | court | bank shot |
| Miss hits rim | `rim_clank` `{hard}` | court | hard from impact speed |
| Ball rattling rim | `rim_roll` start/stop | court | managed micro-loop |
| Body contact on contest/box-out | `body_contact` `{hard}` | sfx | |
| Foul called | `whistle` `{kind:'foul'}` | court | duck 0.5 |
| Check-ball (top of arc) | `whistle` `{kind:'check'}` → `check_thud` | court/sfx | possession reset |
| Violation (backcourt/"take it back", 24s soft) | `whistle` `{kind:'violation'}` | court | |
| Shot-clock expiry | `buzzer` (0.6s) | court | |
| And-1 (made + foul) | `and_one` | crowd | layered, signature |
| Score increments to win (11, win-by-2) | `buzzer` (1.4s) → `and_one` | court/crowd | game-point celebration |
| Scoreboard tick (HUD) | `score_blip` | sfx | HUD-driven, both clients |
| Possession change | (no sound; crowd `level` tiny bump) | crowd | |
| Game phase → live | `music_bed` gain 0.32 | music | |
| Game phase → dead/check | `music_bed` gain 0.12 | music | |

### `bballSfxFor(event)` (the `clubHitName()` analog)
A pure string mapper so callers in `bball.js` don't hardcode names:
```js
export function bballSfxFor(ev){
  switch(ev){
    case 'make_clean': return 'swish';
    case 'make_glass': return 'backboard';
    case 'miss_rim':   return 'rim_clank';
    case 'foul':       return 'whistle';
    case 'and1':       return 'and_one';
    default:           return null;
  }
}
```

---

## 6. Dribble pitch/gain formula (the detail that sells it)

Caller computes `impact` from the sim at floor-contact. Given ball vertical velocity `vyImpact` (m/s, magnitude at the bounce) and horizontal ball speed `vxz`:

```
impact = clamp01( |vyImpact|/8 * 0.7 + vxz/6 * 0.3 )
// loud, snappy dribble on a hard pound; soft on a lazy dribble
```
Then in `playDribble(impact)`: thump lowpass `freq = 180 + impact*260`, pock `freq = 140 + impact*120`, both gains scale with `impact` (§3.1). A **hard pound-dribble** (setting up a move) → high impact → louder, brighter, higher "tock". A **soft control dribble** → quiet, dull. This is the spec-required "pitch varies with height/speed."

Re-trigger guard: ignore contacts within 60ms of the last dribble (debounce double-contacts from the trimesh floor collider — analogous to golf's NaN/contact guards in `physics.js`).

---

## 7. Wiring into the orchestrator (`bball.js`)

Mirror golf.js exactly:
- `const audio = createBballAudio(); host._audio = audio;` (so the settings menu can call `setMuted`, like golf line 459/785/812).
- In the single rAF tick (`dt=Math.min(0.05,dtMs/1000)`): after stepping sim/render, call `audio.tickAmbient(dt)` (golf line 1365).
- Fire one-shots from sim/state-machine callbacks (collision handler, shot resolve, possession FSM) — the golf model of `audio.play(...)` at lines 494/845/1317/1326.
- Settings hooks: `onSetMuted:(m)=>audio.setMuted(m)` and a new `onSetMusic:(b)=>audio.setMusicEnabled(b)`; restore persisted `muted`/`musicOn` on mount (golf lines 785/812).
- `unmount()`: `audio.setMuted(true)` and `delete host._audio` (golf lines 1514-1515). Loops self-stop on mute; also explicitly stop `music_bed`/`crowd_bed`/`ambient_city` sources to free the audio thread, since unmount disposes everything.

---

## 8. Perf / feasibility budget

- **Steady state:** 3 loop sources (crowd/city/music gain stages) + ~6 short music voices/sec + dribble (≤8/s) + occasional one-shots. Peak realistic node count <40 live nodes — trivially within Web Audio budget on a laptop, well under the rendering/physics cost.
- **No asset files, no fetch, no decode** — buffers baked once in `ensureCtx()` (white 1.5s / pink 2.5s / brown 1.5s, same as golf). Total baked memory ~1.5 MB of Float32, identical to golf's footprint.
- **All timing vs `ctx.currentTime`** — the music scheduler uses lookahead; no `setInterval`/wall-clock for sound timing (the one golf `setTimeout` in `playBallInHole` is acceptable for a non-rhythmic follow, but and-1 uses scheduled `ctx.currentTime` offsets instead to avoid drift).
- **Limiter** (one `DynamicsCompressorNode`) is the only added always-on DSP node beyond golf — negligible cost, prevents clipping from simultaneous beds.
- **Mobile/low-end fallback:** if `ctx.sampleRate < 44100` or a perf flag is set, disable `ambient_city` and `music_bed` (keep crowd + gameplay SFX). Single boolean gate in `tickAmbient`.

---

## 9. Summary of new vs copied

- **Copied verbatim from golf `audio.js`:** `ensureCtx`, gesture-unlock, `makeNoiseBuffer`, envelope idiom, `NAMES`-gated `play()`, managed-loop start/stop/ramp pattern (`ball_roll`→`crowd_bed`/`rim_roll`), `tickAmbient` LFO, `setMuted`, `playClick`→`score_blip`, `playCrowdClap`→`cheer`.
- **New for basketball:** group-bus mixer + limiter + `duck()` sidechain; the dribble per-bounce engine with impact-driven pitch; chain-vs-nylon swish; lookahead-scheduled `music_bed`; crowd excitement `level` model; host-authoritative event map with guest-local dribble/squeak prediction; `setMusicEnabled`; `bballSfxFor()` mapper.

**Relevant files:** template at `C:\Users\sidney\documents\Projects\2k-schwartz\src\sports\golf\audio.js`; wiring reference at `C:\Users\sidney\documents\Projects\2k-schwartz\src\sports\golf\golf.js` (lines 458-466, 494, 785-812, 845-846, 1317-1365, 1514-1515); new module to create at `C:\Users\sidney\documents\Projects\2k-schwartz\src\sports\basketball\audio.js`.

---

## Adversarial Critique (AAA-bar review)

**Verdict:** needs-work

### Gaps
- NO REVERB / SPATIALIZATION = no 'Blacktop' space. NBA 2K's audio signature is the open-air, slightly slap-back court ambience and ball/crowd sitting in a believable space. This design has zero reverb in the main spec (it's relegated to an open question) and zero panning/StereoPanner. Everything is dead-mono-dry. Dry procedural noise bursts in mono is exactly the 'generic browser game' read the brief warns against. The single shared 0.6s convolver send is the one thing that would most move it toward AAA, yet it's left as 'recommend' in open questions rather than specced.
- DRIBBLE IS THE HERO SOUND AND THE RECIPE IS THE WEAKEST PART. A real basketball bounce on blacktop has a sharp broadband transient + a pitched cavity resonance (~150-250Hz) with a fast decay, plus surface grit. The proposed 'brown-noise thump lowpassed at 180-440Hz + sine pock' will read as a soft 'boomf', not a crisp 'POK'. Brown noise lowpassed is muddy; the transient snap needs a short HIGHpass/broadband click, not a lowpassed brown bed. The pock pitch-drop over 0.012s on a sine is too clean/synthy. This is the sound the player hears thousands of times — it must be excellent and it currently isn't.
- SWISH chain-vs-nylon is acknowledged-subtle and the chain recipe is wrong physics. A chain net is a dense cluster of metallic clinks (many short inharmonic impulses across ~30-80ms), NOT a comb-filtered noise ring. Three static bandpass filters on white noise = a 'shhhing' resonance, not 'chink-chink-chink'. To read as chain you need a small burst of randomized short metallic pings (the rim_clank partial approach, scattered in time with jitter), layered over noise. As specced it will read as generic filtered hiss — the exact failure the author flagged but did not actually solve.
- BUZZER recipe will sound thin/cheap. 'sawtooth 180Hz + light WaveShaper' is the classic weak-synth-buzzer. A real arena horn is a fat detuned-saw stack with strong harmonic distortion AND a band of resonance ~400-1200Hz, gated hard. At 180Hz with light shaping it'll buzz like a doorbell, not a 2K horn. This is a marquee moment (game point) — under-specced.
- CROWD BED is a single pink-noise loop with an LFO lowpass. That is wind, relabeled (it's literally the golf wind_ambient clone, by the author's own admission). A crowd reads as crowd because of intermittent transients (claps, individual whoops, murmur texture) — none of which a static filtered pink loop produces. The 'excitement level' gain bump makes it louder, not more crowd-like. For a 1v1 Blacktop you arguably want a SMALL crowd (a handful of people on a fence), which is even harder to fake with a noise bed and would be better as sparse scheduled one-shot reactions than a continuous wash.
- MUSIC BED scope/quality risk and licensing-of-feel mismatch. A procedurally synthesized 92 BPM minor-pentatonic loop will sound like a 1980s drum machine, not Blacktop's hip-hop bed. This is the single biggest 'reads as amateur' risk and the author treats it as a light add. The honest call for a browser build is: either ship a genuinely good 1-2 bar loop (hard procedurally) or cut music entirely and lean on crowd+SFX. Half-committing to a synth beat is the worst outcome.
- INTERNAL INCONSISTENCY in the duck/limiter graph. duckGain sits BEFORE master, and swish/whistle call duck() — but swish and whistle are routed through courtGain which feeds duckGain. So when a whistle ducks the bus, it ALSO ducks itself (the whistle is on courtGain → duckGain). The design says duck lets 'the call punch through gameplay' but as wired the call attenuates along with the gameplay. The whistle/swish must be on a separate non-ducked path (or a post-duck send) for sidechain to work. This is a real bug in the one novel subsystem.
- GUEST-LOCAL DRIBBLE PREDICTION is under-specified and will double-fire or mis-fire. The guest detects 'vy crosses zero near floor y' from INTERPOLATED snapshots. Interpolation between 15-20Hz snapshots smooths/clips the bounce apex and contact — the very vy zero-crossing it keys on may never appear cleanly, or a single bounce spanning two snapshots can register twice. Meanwhile host fires from true sim contacts. Result: desynced dribble cadence between the two clients (host crisp, guest aliased) — the exact risk flagged, with no concrete reconciliation (e.g., host sends bounce events AND guest predicts, dedup by timestamp window).
- and_one / game-point sequencing leans on layering cheer+ooh but there is no actual 'crowd reaction variety' — every made basket is the same single 'cheer' (copied golf clap). In 2K, makes, and-1s, blocks, and game-point have distinct crowd reactions. One cheer recipe reused for all positive events will feel repetitive within minutes of a first-to-11 game.
- NO DISTINCT 'BLOCK' / 'STEAL' / 'REBOUND' audio. The event map covers shots, fouls, dribble, check. For 1v1 streetball, a block (huge momentum sound + crowd 'OHHH') and a clean steal are signature highlight moments. They're absent. Body_contact is the only defensive sound and it's a dull thud.

### Must-Fix (applied in synthesis)
- FIX THE DUCK GRAPH BUG: route whistle/swish/buzzer to a post-duck 'priority' send (or directly to master, bypassing duckGain) so the sidechain dip attenuates gameplay/crowd/dribble WITHOUT attenuating the call itself. As currently wired, the ducking subsystem — the design's headline novel feature — ducks the very sound it's trying to feature. Re-spec the routing diagram in §2 accordingly.
- ADD A SHARED CONVOLVER REVERB SEND (promote it from open-question to spec). One procedurally generated impulse: a 0.4-0.7s exponentially-decaying noise burst (built in ensureCtx from the existing white buffer — near-zero extra cost, one ConvolverNode). Route court SFX (swish, rim, backboard, dribble at low send) and cheer through it. This single node is the largest perceptual jump toward 'Blacktop space' and the brief explicitly demands a pro feel. Without it everything is dry-mono and reads as a browser toy.
- REWORK THE DRIBBLE (hero sound): transient = short broadband click (white→highpass ~1.5kHz, 3-5ms) for the 'snap'; body = damped resonant lowpass-bandpass around 150-220Hz on a SHORT noise/sine with fast decay for the cavity 'pock'; keep impact-driven pitch/gain. Drop the muddy lowpassed-brown bed as the primary layer. Build it and tune by ear against a reference before anything else — it plays thousands of times.
- ADD STEREO PANNING (StereoPannerNode per one-shot voice, cheap). Pan dribble/sneaker/body-contact/shot by the sound source's court-X position relative to camera. Mono everything is a dead giveaway of low-effort audio; per-voice pan is ~1 node and transforms perceived production value. Spec the pan-from-world-position mapping (you already compute positions in the sim).
- MAKE CHAIN-NET SWISH ACTUALLY METALLIC: replace the 3-static-bandpass 'ring' with a short scattered burst of 4-8 randomized inharmonic metallic pings (reuse rim_clank partial generator, jittered over 40-70ms with random detune), layered under a noise transient. Static bandpassed noise will not read as chain. This is the marquee result sound on every made shot.
- DECIDE MUSIC: either commit to a genuinely good short loop and budget real tuning time, or CUT it and reinvest in crowd reaction variety + reverb. Do not ship a half-effort synth drum-machine beat — it will actively cheapen the product. Recommend cutting procedural music for v1; gate behind setMusicEnabled defaulting OFF.
- ADD CROWD REACTION VARIETY: at minimum 3-4 distinct positive recipes (clean make, and-1, block/big-play, game-point) plus scheduled sparse individual whoops/claps layered on the bed so the crowd reads as people, not a noise wash. Reusing one golf-clap for every event will feel repetitive in a first-to-11.
- ADD BLOCK and STEAL/REBOUND sounds to the event map (signature 1v1 highlight moments). Block = sharp leather/hand contact + big crowd 'OHHH' duck; steal = quick swipe + dribble-takeaway. Without these the defensive side of 1v1 is silent.
- SPECIFY GUEST DRIBBLE DEDUP CONCRETELY: host SHOULD still emit bounce events in the snapshot (id + impact + timestamp); guest predicts locally for tightness but DEDUPS against host events within a ~80ms window, suppressing the predicted one if a host event arrives. Define the exact reconciliation, debounce window, and what happens when interpolation hides a bounce. 'Just predict locally' as written will alias.
- REWORK THE BUZZER: fat detuned saw stack (e.g. 4 saws ~178-186Hz) → strong WaveShaper distortion → resonant bandpass ~600-1000Hz, hard-gated, 30Hz amplitude tremolo. Light shaping at 180Hz reads as a doorbell, not an arena horn. It's the game-point sound — it must land.

### Feasibility Notes
Node-count and CPU budget claims are accurate and conservative — peak <40 live nodes is trivial for Web Audio; the per-bounce 4-node graph with auto-GC is the right call. Baking white/pink/brown once in ensureCtx is correct and matches the golf footprint. The cited golf.js wiring lines (458/459/466/494/785/812/845/1317/1365/1471/1514/1515) are ALL accurate against the actual source, and the golf audio.js template (envGain idiom, NAMES gating, managed-loop slots, gesture-unlock, _ambientClock LFO) is faithfully described — copy claims hold up. The ConvolverNode reverb (1 node, impulse baked from existing white buffer) and StereoPanner-per-voice are both well within budget and should be ADDED, not cut — they are the cheapest path to a pro feel. The DynamicsCompressor limiter is correctly negligible. WHERE TO TRIM: cut procedural music_bed for v1 (highest effort-to-quality risk, and the lookahead scheduler is the only piece that doesn't exist in golf, adding the most new surface area); cut ambient_city (the brief is 1v1 Blacktop, not an open-world). Reinvest that effort into the dribble, the chain swish, reverb, panning, and crowd-reaction variety — i.e., make fewer sounds excellent rather than 16 sounds + 3 loops mediocre. The host-authoritative model is structurally sound and matches the tennis dumb-relay precedent confirmed in server/index.js (slot-0-authoritative, broadcast relay), but the snapshot schema (audioEvents[] array) is genuinely unresolved in the netcode and must be co-designed with that pillar, not assumed.

