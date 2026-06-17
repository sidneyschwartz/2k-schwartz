# Pillar 4 — Court, Environment & Visual Direction

> A blacktop/playground half-court rendered in Three.js r0.170 at the NBA 2K "Blacktop" quality bar, built by copying the golf rendering stack (scene.js, visuals.js, materials.js, environment.js, vfx.js, quality.js) into a new `src/sports/basketball/` directory. The environment is a single fixed scene — one half-court, one hoop, a fenced urban lot, golden-hour lighting — so it can be built far heavier (per-pixel) than golf's sprawling course while staying inside a ~120-draw-call / 60fps WebGL budget. Court geometry, hoop assembly, materials, lighting, post-FX, broadcast/chase camera language, cheap set-dressing, and net/ball/dust VFX are all specified concretely with construction code, dimensions, and perf tradeoffs. Everything is host-authoritative-friendly: this pillar owns only visuals and reads sim state (ball pos/vel, player transforms, possession/camera-cut events) pulled the same pull-based way hud.js consumes getters.

# Pillar: Court, Environment & Visual Direction

> Scope: the **look** of 1v1 Blacktop. Court geometry + markings, the hoop assembly (visual + the colliders the physics pillar will use), PBR materials, lighting/shadows, post-FX budget, camera language, set-dressing, and VFX. This pillar does **not** own gameplay, netcode, or the shot meter — but it defines the exact handles those pillars call.

---

## 0. Where this lives & how it plugs in

Per the codebase contract, sports **COPY** the golf patterns into their own folder — there is no shared base class. Create:

```
src/sports/basketball/
  basketball.js     # mountBasketball(host, cfgOrOnExit) -> unmount   (orchestrator, other pillar)
  scene.js          # ← THIS PILLAR: createScene(host) (copied from golf, court chase cam)
  visuals.js        # ← THIS PILLAR: applyVisuals(scene, renderer, camera)
  court.js          # ← THIS PILLAR: buildCourt(scene) -> { handle, colliders }
  hoop.js           # ← THIS PILLAR: buildHoop(scene, opts) -> { meshes, net, colliders, swish() }
  materials.js      # ← THIS PILLAR: asphalt/paint/metal/glass/net/fence/chain PBR factories
  environment.js    # ← THIS PILLAR: decorateCourt(scene) -> { tick, setDensity, dispose }
  vfx.js            # ← THIS PILLAR: swish/netRipple/ballTrail/dust/scorePop
  camera.js         # ← THIS PILLAR: createCameraDirector(camState, follow) (broadcast modes)
  quality.js        # ← THIS PILLAR: presets (copied & retuned from golf)
```

The orchestrator (other pillar) calls these in `mountBasketball` exactly like `mountGolf` does:

```js
const { scene, camera, renderer, followChase, resetCameraFor, addResizeHook, dispose } = createScene(host);
const visuals  = applyVisuals(scene, renderer, camera);       // sky, sun, IBL, composer, post
const court    = buildCourt(scene, { envMap: visuals.envMap });
const hoop     = buildHoop(scene, { envMap: visuals.envMap });
const env      = decorateCourt(scene, { sunDir: visuals.sunDirection });
const cameras  = createCameraDirector(scene.camState, followChase);
// per frame:
//   env.tick(dt, { ballPos, cameraPos }); materials.tickAnims(dt);
//   cameras.update(dt, { ball, handler, hoop, mode }); hoop.tickNet(dt);
//   visuals.render();  (else renderer.render(scene, camera) fallback, like golf.js)
```

**State is pulled, never pushed.** Like `hud.js`, the camera director and VFX read a `getters`-style object the sim pillar provides each frame: `{ ballPos, ballVel, handlerPos, defenderPos, possession, lastEvent }`. This keeps the visual pillar decoupled from netcode — the host-authoritative sim produces snapshots; on the guest these are already interpolated before they reach us, so visuals don't know or care whether they're host or guest.

`unmount()` must dispose everything this pillar created (geometries, materials, canvas textures, render targets, the composer) — golf's `dispose()` chains are the template. Court geometry is static and large, so disposal correctness matters less than in golf (no per-hole churn), but still do it for clean menu re-entry.

---

## 1. Court geometry & exact markings

### 1.1 Coordinate system & scale

Reuse golf's convention: **1 Three.js unit = 1 metre**, **+Y up**, court plane at **y = 0**. We design in **feet** (basketball is spec'd in feet) and convert: `const FT = 0.3048;`.

Orient the court so the **hoop is at +Z** and the **check-ball / top-of-key is toward −Z** (camera default looks down +Z, matching golf's `camera.lookAt(0,0,30)`). The half-court is mirror-symmetric about the X=0 plane (the line through the basket).

### 1.2 Official half-court dimensions (NBA, the Blacktop reference)

A half-court is the area from the baseline (under the hoop) to half-court line:

| Element | Value | Notes |
|---|---|---|
| Court width (X) | **50 ft (15.24 m)** | sideline to sideline |
| Half-court depth (Z) | **47 ft (14.33 m)** | baseline → mid-court line |
| Rim height | **10 ft (3.048 m)** | top of rim ring |
| Rim inner diameter | **18 in (0.4572 m)** | ball Ø is 9.51 in / 0.241 m — ~2 balls wide |
| Backboard | **72 in × 42 in (1.829 × 1.067 m)** | bottom edge at 9 ft 0.5 in (2.756 m) |
| Backboard → baseline | rim center **15 in (0.381 m)** from backboard face; backboard **48 in (1.219 m)** inside baseline | |
| 3-pt arc radius | **23.75 ft (7.24 m)** from rim center; **22 ft (6.71 m)** in corners | streetball often uses a flat ~21–22 ft arc; we use the NBA arc with straight corner segments |
| Free-throw line | **15 ft (4.572 m)** from backboard face | |
| Key (lane) width | **16 ft (4.877 m)** | painted rectangle |
| FT circle radius | **6 ft (1.829 m)** | |
| Restricted-area arc | **4 ft (1.219 m)** radius under rim | optional, cheap |

> **Streetball note:** the product calls for "take it back past the arc." Define a single source of truth `export const COURT = {…}` in `court.js` with `arcRadius`, `rimCenter:{x:0,y:3.048,z:Z_BASE+0.381}`, `checkLine` (the half-court line z), and `clearLine` (the arc) — the gameplay pillar imports these constants for its possession logic so the painted line and the rule line are literally the same number. **No magic numbers duplicated across pillars.**

### 1.3 Floor construction

The blacktop is **not** a flat plane — flat asphalt reads as plastic. Build a lightly displaced slab like golf's `heightfield.js` but ~10× subtler (asphalt is nearly flat; we only want it to catch grazing light and break specular):

```js
// court.js
const slabGeo = new THREE.PlaneGeometry(COURT.padW, COURT.padD, 64, 64); // ~8k tris, 1 draw
slabGeo.rotateX(-Math.PI/2);
// micro-displacement: ±1.5cm value-noise so wet spots/puddles + asphalt waviness read
displaceVerts(slabGeo, { amp: 0.015, freq: 0.35 });  // copy golf displaceVerts pattern
slabGeo.computeVertexNormals();
const slab = new THREE.Mesh(slabGeo, asphaltMaterial(envMap));
slab.receiveShadow = true;  // the hero shadow receiver
scene.add(slab);
```

`padW/padD` is bigger than the play area (~22 m × 20 m) so there's blacktop beyond the sidelines before the fence — the court markings are a **decal/overlay**, not the slab edge.

### 1.4 Painted lines — decal overlay, not geometry

Do **not** model lines as raised geometry (z-fighting, tri cost). Two viable approaches; **use (A)**:

**(A) Single baked line-texture on a slightly-raised transparent plane (recommended).** Paint ALL markings (arc, key, FT circle, lane hashes, half-court line, faded/cracked paint) into one `CanvasTexture` at 2048² using Canvas2D arcs/lines, then lay it as one transparent overlay mesh at `y = 0.005` over the asphalt. The asphalt shows through everywhere the canvas is transparent.

```js
function generateCourtLinesCanvas(px = 2048) {
  const c = makeCanvas(px); const ctx = c.getContext('2d');
  // transparent base; map metres→px with COURT dims
  ctx.lineWidth = 2*FT/COURT.padW*px;  // 2-inch lines
  ctx.strokeStyle = 'rgba(235,228,210,0.82)'; // weathered cream, NOT pure white
  // arc:
  ctx.beginPath(); ctx.arc(cx, rimPx, arcPx, startA, endA); ctx.stroke();
  // key rectangle, FT circle (top solid / bottom dashed), half-court line, lane hashes…
  // then PUNCH WEAR: erase along noisy strokes with ctx.globalCompositeOperation='destination-out'
}
```

- **One 2048² texture, one draw call, perfectly crisp arcs** (vector-drawn, not pixel-art). `anisotropy = 16`, `colorSpace = SRGB`, `transparent`, `depthWrite:false`, `polygonOffset` to kill z-fight with the slab.
- The faded/cracked look (Blacktop signature) comes free from the `destination-out` wear pass + an asphalt grunge multiply.
- A painted **center logo / "tag"** (graffiti court name) drops into the same canvas — zero extra cost.

> Tradeoff vs. decals: `three`'s `DecalGeometry` would conform to the displaced slab but costs N meshes + N draws and re-projects awkwardly over micro-displacement. One overlay plane at 0.5 cm is invisible against ±1.5 cm asphalt waviness from broadcast distance and is dramatically cheaper. Accept it.

### 1.5 The painted key / "paint"

The lane is a different blacktop color in real courts (often a faded red/green/blue). Bake it into the **same** line canvas as a semi-transparent fill so the asphalt grunge still shows through (`fillStyle='rgba(120,40,38,0.35)'`). No extra geometry.

---

## 2. The hoop assembly (`hoop.js`)

This is the **hero prop** and the one piece with real physics. Build it as a `THREE.Group` at `COURT.rimCenter`, returning both visual meshes and the cannon-es collider specs the physics pillar consumes (this pillar provides geometry + collider definitions; the physics pillar registers them in its world — same division of labor as golf where `materials.js`/`terrain.js` produce meshes and `physics.js` builds colliders from region data).

### 2.1 Parts, dimensions, materials, draw calls

| Part | Geometry | Material | Shadow | Collider (for physics pillar) |
|---|---|---|---|---|
| **Pole** | `CylinderGeometry(0.09,0.11,3.6,16)` set ~1.2 m behind baseline, plus a gooseneck `TorusGeometry` elbow | `metalPainted` (matte black, rough 0.5) | cast+recv | `CANNON.Cylinder` static (rare collision; keep) |
| **Backboard glass** | `BoxGeometry(1.829,1.067,0.03)` | `glassBackboard` (transparent, see §4.4) | cast (soft) | `CANNON.Box` static, high restitution |
| **Backboard frame + shooter's square** | thin `Box` border + inner rectangle outline (extruded) | `metalPainted` white + the square as a 1-px-thick emissive-free white border | cast | none (part of board box) |
| **Rim ring** | `TorusGeometry(0.2286, 0.0095, 12, 48)` (18″ ID, ~0.75″ tube) | `metalChrome` orange enamel (rough 0.35, metal 0.9) | cast | **`CANNON.Trimesh` torus** OR 12–16 small `CANNON.Sphere`s arranged in a ring (cheaper, stabler — recommend spheres) |
| **Rim braces / two bolts to board** | 2 short `Cylinder`s | `metalPainted` | cast | none |
| **Net** | see §2.2 — verlet chain *or* cone mesh | `netMaterial` (alpha, double-side) | no | none (visual only; ball passes through) |
| **Breakaway hinge** (optional flair) | none visible | — | — | optional spring on rim for dunks |

**Draw-call budget for the whole hoop: ~6–8.** Merge pole+gooseneck+braces into one `mergeGeometries` static mesh sharing `metalPainted` → 1 draw. Backboard glass = 1. Frame+square = 1. Rim = 1. Net = 1 (instanced segments or single mesh). That's the right place to spend polys — it's on camera every possession.

### 2.2 The net — chain vs. nylon (product decision says "chain OR nylon")

**Recommend nylon as default (cheap, animatable, reads "playground"), chain as a quality/style variant.**

**Nylon net (default):** a single open-ended cone-ish mesh whose vertices are driven by a tiny **verlet rope sim** at the 12 rim attach points, so it *swishes* when the ball passes. This is the money visual.

```js
// 12 strands × 6 nodes, cross-linked into a diamond mesh.
// Top ring = rim attach points (fixed). Each node below: verlet integrate
// p += (p - pPrev)*damp + gravity*dt^2 ; then satisfy distance constraints to
// neighbors (down + adjacent strand) for ~3 iterations. Mesh = TRIANGLE_STRIP
// skin over the node grid, rebuilt each frame (72 nodes → trivial CPU cost).
hoop.swish(ballVel) {           // called by sim on a make
  // kick the lower-middle nodes outward+down along ballVel.xz, let verlet settle
}
hoop.tickNet(dt) { /* integrate + constrain + write BufferAttribute positions */ }
```

72 nodes, 3 constraint iters, one `BufferAttribute` update per frame — **negligible CPU**, 1 draw call, and the swish sells every bucket. Material: `MeshStandardMaterial` white, `transparent`, `opacity 0.9`, `side: DoubleSide`, `alphaMap` of vertical net-mesh stripes (CanvasTexture) so it reads as cord, not a solid cone.

**Chain net (variant):** instanced short cylinder links (`InstancedMesh`, ~120 links, 1 draw) with the same verlet node positions driving link transforms; add a metallic `chainSwish` clink via the audio pillar. Heavier visually, classic NYC-cage look. Gate behind `quality.high` or a court-style flag.

### 2.3 Collider notes for the physics pillar

- Provide rim collision as **a ring of 12–16 static `CANNON.Sphere` bodies** (radius ≈ tube radius) on a circle of radius 0.219 m at y=3.048. Trimesh torus works but sphere-ring gives far more stable rim bounces and rattles ("in-and-out"), which is exactly the 2K feel. Export the ring positions from `hoop.js` so the visual torus and the colliders are generated from the **same radius constant**.
- Backboard = one static `CANNON.Box`, `restitution ≈ 0.6`, `friction ≈ 0.3`.
- Net is **not** a collider — the ball passes through; gameplay decides "make" by detecting ball center crossing a horizontal disk at rim plane moving downward with speed below a cap (mirrors golf's cup-catch test: `CUP_CATCH_RADIUS` + `CUP_PUTT_SPEED_LIMIT`). The swish VFX fires off that same event.

---

## 3. Materials (`materials.js`) — PBR, all procedural CanvasTexture

Copy golf's `materials.js` architecture verbatim: `makeCanvas()`, `canvasTexture()`/`dataTexture()` helpers, a module-level `_cache`, `noiseFill()`, `generateNormalMap()`, and a `tickAnims(dt)` for animated maps. **No external image assets** — golf proved the procedural pipeline.

`envMapIntensity` is the critical knob golf learned the hard way (IBL was blowing out surfaces). Asphalt and matte metal want **low** intensity (0.3–0.4); glass and chrome want **high** (1.0–1.5).

### 3.1 Asphalt

```js
function generateAsphaltColor(size=1024){
  noiseFill(ctx,size,[46,46,50],14);                 // dark blue-grey base
  // aggregate specks (light + dark pebbles):
  for (200..) speck light grey; for (300..) speck near-black;
  // oil stains: large soft dark radial-gradient blobs (multiply)
  // cracks: a few jagged dark polylines with feathered edges
  // tyre/scuff marks near the hoop: faint curved smudges
}
asphaltMaterial(envMap){
  return new MeshStandardMaterial({
    map: c.asphaltColor, normalMap: c.asphaltNormal,
    normalScale: (0.7,0.7), roughness: 0.92, metalness: 0.0,
    envMap, envMapIntensity: 0.35,                    // tamed, like golf grass
  });
}
```
Repeat `[6,6]`–`[8,8]` across the slab; `anisotropy 16` so grazing-angle asphalt near the camera stays sharp. A second **roughness map** (puddle areas → low roughness, ~0.15) gives wet-spot specular hotspots at golden hour — huge bang for buck, one extra canvas.

### 3.2 Painted lines / paint — see §1.4 (lives partly here as a texture factory).

### 3.3 Metal (pole, rim, frame)

Two metals: `metalPainted` (pole/frame, `metalness 0.6 roughness 0.5`, color-keyed) and `metalChrome`/enamel rim (`metalness 0.9 roughness 0.3`, orange `0xd9521b`, `envMapIntensity 1.2`). Rim needs the env reflection to pop — it's the brightest spec highlight in frame, and bloom (§5) will halo it slightly at golden hour. Add a subtle scratch normal map to the rim so it isn't a perfect mirror torus.

### 3.4 Glass backboard

```js
glassBackboard(envMap){
  return new MeshPhysicalMaterial({          // physical for transmission
    color: 0xeaf4ff, metalness: 0, roughness: 0.06,
    transmission: 0.9, thickness: 0.03, ior: 1.45,
    transparent: true, opacity: 1.0,
    envMap, envMapIntensity: 1.0,
    clearcoat: 0.3,
  });
}
```
`MeshPhysicalMaterial.transmission` is the correct tempered-glass look (you see fence/sky through it). **Perf caveat:** `transmission` triggers an extra opaque-scene render pass per transmissive material per frame. With exactly **one** transmissive object this is acceptable on medium/high; on **low** quality, fall back to a plain `MeshStandardMaterial({transparent:true, opacity:0.35, roughness:0.05, envMapIntensity:1.5})` — `quality.js` swaps it. The painted white border + orange/red shooter's square + bottom padding stay opaque so the board reads clearly against any background.

### 3.5 Fence (chain-link) & chain

Chain-link is the iconic blacktop frame. **Do not model wire.** Use a **single alpha-mapped texture** on plane segments:

```js
function generateChainLinkAlpha(size=512){
  // draw the diamond-wire pattern as opaque lines on transparent bg;
  // also bake a faint metallic color (galvanised grey) into a color map.
}
fenceMaterial(){ return new MeshStandardMaterial({
  map: c.fenceColor, alphaMap: c.fenceAlpha, transparent:true,
  alphaTest: 0.5,                      // alphaTest (not blend) → writes depth, sorts correctly, casts proper shadows
  side: THREE.DoubleSide, metalness:0.7, roughness:0.5, envMapIntensity:0.6,
});}
```
`alphaTest` (cutout) instead of alpha-blend means the fence **casts a real diamond shadow** and never needs sorting — critical at golden hour where the fence shadow stripes across the court are a signature look. Fence = 4 plane segments (back + 2 sides + gate) → **1 draw via merged geometry**, plus instanced posts/top-rail (1 draw). Total fence ~2 draws.

### 3.6 Material registry / animated tick

```js
export function tickAnims(dt){ /* advance puddle ripple offset if any; net handled in hoop.js */ }
```
Keep it tiny — unlike golf's water, the court has almost nothing animated in materials (the net is the animated thing and it lives in `hoop.js`).

---

## 4. Lighting & shadows (`visuals.js`)

Copy golf's `visuals.js` wholesale (Sky + PMREM IBL + sun + hemi + fog + composer) and **retune for golden hour + a contained urban scene.** Because the scene is one small court (not a 500 m course), we get **much sharper shadows for free** — the shadow frustum is tiny.

### 4.1 Sun (golden hour default)

```js
const SUN_ELEVATION_DEG = 12;   // low golden-hour sun (golf used 28 mid-morning)
const SUN_AZIMUTH_DEG   = 250;  // raking across the court from one sideline → long fence shadows
```
- `DirectionalLight(0xffd9a0, 2.4)` — warm amber, slightly hotter than golf's `0xfff2dd`.
- `HemisphereLight(skyTop 0xbcd0ff, ground 0x40382e, 0.9)` — cool sky fill / warm bounced-asphalt ground term. The warm ground hemi is what makes faces under the hoop not go dead black.
- **Tighten the shadow frustum hard** — the whole court is ~22×20 m, so:
  ```js
  cam.left=-14; cam.right=14; cam.top=12; cam.bottom=-16; cam.near=1; cam.far=80;
  sunLight.shadow.mapSize = (2048,2048);   // golf used 4096 over 160m; we cover ~25m → crisper at half the res
  sunLight.shadow.bias=-0.0002; normalBias=0.03; radius=3;  // PCFSoft soft edge
  ```
  **No `setSunTarget` re-centering needed** — the court never moves, so unlike golf we don't chase the ball with the shadow cam. One static shadow frustum, one shadow pass. Big win.

### 4.2 Sky & time-of-day

Sky uniforms tuned for golden hour: `turbidity 6`, `rayleigh 2.4`, `mieCoefficient 0.008`, `mieDirectionalG 0.85` → warm hazy horizon. Provide a small `setTimeOfDay(t)` that lerps `SUN_ELEVATION/AZIMUTH` + sky uniforms + sun color between **golden hour (default), midday, dusk (purple), night (court floodlights)**. Night mode swaps the sun for 2–4 `SpotLight`s on poles (see §7) — but **golden hour is the shipped default** per the brief; treat the others as cheap stretch toggles.

### 4.3 IBL via PMREM

Identical to golf: bake the procedural Sky into a PMREM env map, assign `scene.environment`, pass `envMap` to all PBR materials. This is what makes the **glass backboard and chrome rim reflect the warm sky** — non-negotiable for the AAA feel. One-time cost at mount.

### 4.4 Fog

Mild warm fog `Fog(0xe8c89a, 25, 90)` — much closer than golf's 700–2000 m because the scene is tiny; the fog just softens the far fence and any distant city backdrop and ties the palette together at golden hour. Match `scene.background` to the sky horizon.

---

## 5. Post-FX budget (`visuals.js` composer)

Copy golf's exact `EffectComposer` chain (`RenderPass → SSAO → Bloom → ColorGrade → SMAA → OutputPass`) and **retune**. The court is a small static scene, so we can afford slightly richer post than golf's wide-open course.

| Pass | Setting | Cost | Justify |
|---|---|---|---|
| **SSAO** | `kernelRadius 0.5, min 0.001, max 0.05` | medium | Grounds the hoop pole, player feet, fence base, ball→floor contact. Keep mild (golf learned the "dirty fingerprint" failure). **Disable on low.** |
| **Bloom** (`UnrealBloomPass`) | `strength 0.18, radius 0.7, threshold 0.85` | low | Halos the chrome rim + sun glints on glass + (night) floodlights. Slightly hotter than golf's 0.12 because golden-hour highlights are the vibe. |
| **ColorGrade** (golf's custom ShaderPass) | `uMidWarm 0.03, uSaturation 1.20, uContrast 1.08, uVignette 0.20, uShadowLift 0.006` | trivial (1 full-screen) | This is the "2K broadcast" grade. Warmer midtones + heavier vignette than golf's "PGA" grade → cinematic streetball. |
| **SMAA** | as golf | low | AA without MSAA cost; plays nice with the composer. |
| **OutputPass** | tonemap/sRGB | trivial | |

**Optional, gated to `high`:** a subtle **radial chromatic-aberration + heat-shimmer** could be added to the ColorGrade shader (one extra `texture2D` tap with UV offset) for golden-hour heat off the asphalt — cheap and very "playground summer." Ship off by default; one uniform toggles it.

**Perf rule (copy golf's quality.js):** `postFx:false` on **low** → `visuals.render()` falls back to `renderer.render(scene,camera)` (golf already structures `render()` this way). Composer stays allocated but unused.

---

## 6. Camera language (`camera.js` + scene chase)

Golf's `makeCameraDirector` + `followBall` is the template. Basketball needs a **broadcast/chase hybrid** that frames the **ball-handler driving toward the hoop**, plus event-cut angles for shots/dunks/checks. Build `createCameraDirector(camState, followChase)` returning `{ setMode, update(dt, ctx) }` with these modes:

| Mode | Framing | Params (`distance`/`height`/extras) | Trigger |
|---|---|---|---|
| **broadcast** (default) | Behind-offense 3/4 view, hoop in upper frame, both players visible. Camera sits behind the *ball-handler* on the line handler→hoop, like golf's behind-ball-toward-pin. | `dist 7.5, height 3.2`, yaw = atan2(hoop−handler), slight downward pitch | possession live |
| **chase** | Tighter low chase when a handler is isolating | `dist 5.5, height 1.8` | drive detected (handler speed↑) |
| **shot** | Snap to a side/baseline angle that frames ball arc → rim against the backboard | `dist 6, height 2.6`, look at midpoint(ball,rim) | shot released (sim event) |
| **dunk** | Low hero angle under/beside the rim, looking up | `dist 3.5, height 0.8`, look up at rim | dunk event |
| **check** | High broadcast establishing shot at the top of the key | `dist 9, height 4.5` | check-ball / dead ball |
| **replay** (stretch) | Orbit the last shot's apex | orbit param | post-make |

Core follow math is golf's `followBall` reused almost verbatim — it already does "position camera behind subject on subject→target line, smoothed via `1-exp(-k·dt)` lerp." Rename `followBall(ballMesh, pinTarget, …)` → `followChase(subjectPos, lookTarget, dt, opts)` and pass `subject = handlerPos`, `lookTarget = hoop` (broadcast) or `ball` (shot tracking). Keep the **`AIM_CLAMP ±90°`** so RMB aim can't spin behind the player, exactly like golf.

**Smoothing:** golf uses `smooth=8` chase / `4` in-flight. Use `broadcast 6, chase 9, shot 5, dunk 7`. On a mode change, call the golf-style **`resetCameraFor(subjectPos, lookAt)`** to snap the smoothed state so cuts don't lerp across the court (golf does this on hole change / after flyover).

**Establishing flyover:** copy golf's `holeFlyover` Bezier-cam → a `courtIntro(camera, COURT)` that sweeps from above the rim down to the top-of-key broadcast pose over ~2.5 s at match start. Returns a Promise; orchestrator awaits it before going live, exactly like golf awaits the flyover.

**Online consideration:** each client renders **its own** local broadcast cam framing **its own** player as the handler-of-interest — the camera is a pure function of the (interpolated) shared sim state, so it needs no netcode. Mode-cut *events* (shot/dunk/check) arrive in the snapshot's `lastEvent` field the sim pillar already broadcasts; the director reads them pull-style.

---

## 7. Set-dressing & ambient (kept cheap) (`environment.js`)

Copy golf's `decorateCourt` shape: returns `{ tick, setDensity, dispose }`, uses `InstancedMesh` for anything repeated, and registers any animated shader materials in a module pool like golf's `_foliageMaterials`.

| Dressing | Construction | Draws | Notes |
|---|---|---|---|
| **Chain-link fence** | §3.5 — merged plane segments + instanced posts/top-rail | ~2 | The frame of the whole lot. Casts diamond shadows (alphaTest). |
| **Graffiti** | painted into the asphalt line-canvas (court tag) + a couple of `PlaneGeometry` panels on the back fence/wall with CanvasTexture graffiti | 1–2 | Procedural spray-tag canvas (random bezier glyphs, drip streaks). |
| **Backdrop buildings** | 6–10 `BoxGeometry` brownstone blocks behind the fence, **InstancedMesh**, single windows-texture | 1–2 | Low-poly skyline. Fogged + parallaxed; never approached. Gives the "we're in a city lot" read. |
| **Bench / hydrant / trash can / shopping cart** | 3–5 low-poly merged props | 2–3 | Classic streetball clutter at court edges, outside play area. |
| **Light poles (for night mode)** | 2–4 poles w/ a `SpotLight` each | 2 (+ lights) | Only instantiated when `setTimeOfDay('night')`; otherwise just unlit geometry or omitted. |
| **Crowd / spectators** | **2–6 billboarded `Sprite`s** of low-fi onlookers leaning on the fence, OR 2–3 static low-poly figures from the existing `characters.js` rig (reuse!) posed idle | 1 (sprites) or 2–3 | Brief says crowd must be cheap. **Sprites with a 2-frame idle sway are the cheapest convincing crowd.** Do NOT simulate a real crowd. Optionally reuse `createGolfer()` from `characters.js` for 1–2 hero spectators near camera. |
| **Litter / leaves** | a few instanced quads that drift with "wind" | 1 | Reuse golf's grass/foliage wind-sway shader uniform pattern (`uTime` + per-instance phase). |

**`tick(dt, {cameraPos})`** advances any sway/sprite-sway uniforms and (if used) billboards the crowd sprites to face the camera. **`setDensity(d)`** (0..1) drops backdrop/clutter/crowd counts for `quality.js` low preset, mirroring golf's `setTreeDensity`/`setGrassDensity`.

**Total set-dressing budget: ~10–14 draws**, almost all instanced/merged. The fence + backdrop + court are the scene; everything else is garnish.

---

## 8. VFX (`vfx.js`)

Copy golf's `vfx.js` `makeBurst()` particle helper and `ballTrail()` line-trail verbatim; add basketball-specific effects. All are short-lived and self-cleaning (golf pattern: own a `raf`, decay opacity, dispose geo+mat on expiry).

| Effect | Built from | Trigger | Notes |
|---|---|---|---|
| **Net swish** | `hoop.swish(ballVel)` verlet kick (§2.2) | make detected | The primary make feedback. Pair with audio pillar `play('swish')`. |
| **Ball trail** | golf's `ballTrail()` shader-line, head→tail alpha fade | on shot release; `stop()` on catch/bounce | `color 0xff8a3c` (ball-orange), `decay ~1.5`. Subtle — only during shot flight, like golf only trails in-flight. |
| **Score pop** | expanding `RingGeometry` + `+2 / +1` sprite, golf `splashEffect` ring pattern | make | Quick scale-up + fade at rim. |
| **Floor dust** | golf `divotSpray` recolored grey `0x9a948c` | hard landing (dunk), sharp crossover, dive | Small low burst at feet, `gravity 14`, short life. |
| **Rim spark / clank flash** | tiny 4-particle white burst at rim contact | ball↔rim collision (from physics) | Optional; sells rattle-outs. Keep ≤8 particles. |
| **Dunk impact** | bigger dust + brief camera shake (sim drives `camState` offset) + net violent swish | dunk event | Camera shake = a decaying random offset added in `camera.update`, golf has no equivalent — add a `shake(amp)` to the director. |
| **Sweat/heat shimmer** | optional grade-shader (see §5) | golden hour | global, not per-event. |

All particle effects use **`PointsMaterial` / additive where glowy**, `depthWrite:false`, capped particle counts (golf uses 18–40). Per-effect lifetime < 0.9 s. These never threaten the frame budget because at most a couple fire at once.

---

## 9. Perf & draw-call budget

Target: **60 fps at 1.5× DPR on a mid laptop GPU** (golf's proven bar; `pixelRatio` capped at 1.5 in scene.js). Because this is **one small static scene**, we are far more comfortable than golf's streaming course.

### Draw-call budget (broadcast frame, high quality)

| Group | Draws |
|---|---|
| Asphalt slab | 1 |
| Court line overlay | 1 |
| Painted-key (folded into overlay) | 0 |
| Hoop (merged pole/frame + glass + rim + net) | ~5 |
| Fence (merged segments + instanced posts) | ~2 |
| Backdrop buildings (instanced) | ~2 |
| Graffiti panels | ~2 |
| Clutter props (merged) | ~3 |
| Crowd sprites | ~1 |
| 2 players (other pillar, `characters.js` rig ~10–15 each) | ~25 |
| Ball | 1 |
| Active VFX (transient) | 0–4 |
| **Static scene subtotal (this pillar)** | **~20** |
| **+ shadow pass (≈ duplicates shadow-casters)** | ~+18 |
| **+ transmission pass (1 glass board)** | +1 full-scene |
| **Total typical** | **~60–80 draws/frame** |

Comfortably under a ~120-draw soft ceiling. The two **biggest costs** are (a) the **shadow depth pass** (one extra pass over all casters — but the frustum is tiny so fill is cheap) and (b) the **glass `transmission` pass** (one extra opaque render). Both are single, bounded, and quality-gated.

### Triangle budget
Slab 8k + displaced, hoop ~6k, net ~1k, fence/backdrop/clutter ~15k, players ~40k. **Scene well under ~100k tris** — trivial for any WebGL2 GPU. We are **fill-rate / pass-count bound, not geometry bound**, so the levers that matter are DPR, post-FX, and the two extra passes.

### `quality.js` presets (copied from golf, retuned)

| Knob | low | medium | high |
|---|---|---|---|
| pixelRatio | 1.0 | 1.25 | 1.5 |
| shadowMapSize | 1024 | 1536 | 2048 |
| postFx (SSAO+Bloom+Grade+SMAA) | **off** (raw `renderer.render`) | on | on |
| glass backboard | plain transparent (no transmission pass) | transmission | transmission + clearcoat |
| crowd/clutter density (`env.setDensity`) | 0.3 | 0.7 | 1.0 |
| net | nylon, 4 strands | nylon, 8 | nylon/chain, 12 |
| chromatic-aberration/heat | off | off | optional |

`applyQuality(level, {renderer, visuals, environment, hoop})` mirrors golf's signature exactly so `settings.js` (if copied) drives it unchanged.

---

## 10. Construction order & defensive loading (match golf.js)

In `mountBasketball`, build in this order so each layer can find/extend the previous (golf's `findOrAddSunLight` traverses for an existing light — keep that defensive pattern):

1. `createScene(host)` → renderer/scene/camera/chase (safe-default `scene.background` so a failed visuals load isn't pure black, like golf).
2. `applyVisuals(scene, renderer, camera)` → sky/sun/IBL/fog/composer; returns `envMap`.
3. `buildCourt(scene, {envMap})` → slab + lines, returns `COURT` + colliders.
4. `buildHoop(scene, {envMap})` → hoop group + net + collider specs.
5. `decorateCourt(scene, {sunDir, envMap})` → fence/backdrop/crowd.
6. `createCameraDirector(camState, followChase)`; await `courtIntro()`.
7. `applyQuality(level, handles)`.

Lazy-import the heavy/optional decoration like golf does (`import('./environment.js').then(...)`) so a slow/failed dressing module still leaves a playable court. Every frame: defensive `try { visuals.render() } catch { renderer.render(scene,camera) }`, exactly golf.

`unmount()` disposes: composer + all passes, PMREM render target, every CanvasTexture (asphalt/lines/fence/graffiti), every geometry/material in court/hoop/env, removes the resize hook, `host.innerHTML=''` — golf's dispose chain copied.

---

## 11. What this pillar exports to other pillars (the contract)

- **`COURT`** constants (dimensions, `rimCenter`, `arcRadius`, `checkLine`, `clearLine`) — consumed by gameplay/possession.
- **`hoop.colliders`** (backboard box + rim sphere-ring specs) — consumed by physics.
- **`hoop.swish(ballVel)`**, **`vfx.scorePop()`**, **`vfx.ballTrail`**, **`camera.shake(amp)`** — called by gameplay on sim events.
- **`createCameraDirector`** consumes `{ ballPos, handlerPos, defenderPos, hoop, mode, lastEvent }` pulled each frame (hud.js getter style).
- **`applyQuality(level, handles)`** — consumed by settings UI.

All visual state is a **pure function of interpolated sim state**, so nothing here changes between host and guest — satisfying the host-authoritative netcode model without this pillar touching the network at all.

---

## Adversarial Critique (AAA-bar review)

**Verdict:** needs-work

### Gaps
- CAMERA IS THE REAL HOLE. The design says broadcast/chase 'reuse followBall almost verbatim,' but I read the actual followBall: it positions the cam behind ONE subject on subject→target line and looks at a point 4m PAST the subject. That framing structurally cannot keep both players in frame in a continuous 1v1 — the defender will routinely fall outside the frustum or be occluded by the handler's back. The author flagged this in Risks but the design body still presents it as a near-verbatim reuse with a one-line 'maybe widen FOV.' This is the single largest gap to a 2K Blacktop feel and it is unsolved, not just under-specified.
- camState OWNERSHIP MISSTATED. The design routes the camera director as createCameraDirector(camState, followChase) implying camState is a public handle. In the real code camState is a private closure variable inside createScene; golf's makeCameraDirector lives in golf.js (the orchestrator) and only mutates camState.distance/height — it does NOT own smoothing. The design's file split (camera.js owning a director that reads scene.camState) requires scene.js to newly EXPORT camState, a deviation from 'copy golf' that is presented as if it already matches. Minor but it will bite the implementer who expects a handle that isn't there.
- NO 2K-SPECIFIC VISUAL IDENTITY BEYOND 'GOLDEN HOUR + VIGNETTE.' Every concrete art lever (warmer grade, hotter bloom, raking sun, fence shadows) is a competent retune of golf, not a Blacktop signature. The things that actually make 2K Blacktop read as basketball — the painted-on player shadow/contact darkening, the slightly stylized high-contrast 'street' grade, sweat sheen on players, the heavy court-tag graffiti as hero focal point, jersey/skin rim-light separation — are mentioned only as cheap garnish or stretch toggles. Players (the actual hero of a basketball scene) are explicitly 'other pillar' and get zero visual-direction guidance here, yet 25 of the ~60 draws and the entire 'does this feel like 2K' judgment ride on them. The pillar that owns 'Visual Direction' punts on the most important on-screen subject.
- SHADOW STRATEGY IS INTERNALLY OPTIMISTIC. Design claims 'No setSunTarget re-centering needed — court never moves' as a 'big win.' True for the static court, but the PLAYERS and BALL move continuously and are the primary shadow casters that sell contact/grounding. A static 2048 frustum over 25m gives ~1.2cm/texel — fine for the court, but two moving figures + a ball at low golden-hour sun angle (12°) cast very long, soft shadows whose edges will alias/swim. The 'crisper at half the res' claim compares court coverage, not the moving-caster case that matters most.
- Z-FIGHT MITIGATION IS HAND-WAVY. Line overlay at y=0.005 over ±1.5cm displaced slab: the author admits z-fight risk and says 'polygonOffset + depthWrite:false.' But depthWrite:false on the line plane means it won't occlude correctly and polygonOffset over a DISPLACED (non-coplanar) surface is unreliable — at grazing golden-hour angles the lines will dip under asphalt waviness in patches. Either flatten the slab under the court footprint (lose the displacement exactly where lines are) or render lines via the asphalt material's own map blend. Currently contradictory: you can't have both ±1.5cm waviness AND crisp coplanar lines via a single offset plane.
- TRANSMISSION COST UNDERSTATED FOR THE MOVING CASE. 'One transmissive object, one extra opaque pass' is right, but that opaque pass re-renders the WHOLE scene (players included) every frame the board is on-screen — which is every possession. Combined with the main pass + shadow pass that's effectively 3 full scene traversals. On a mid laptop at 1.5 DPR with post-FX this is the real risk, not the draw count. The 'medium/high fine' claim isn't backed by the same offline-sim rigor golf used for carries.
- NO STATE FOR 'AAA WITHOUT POST.' Design admits low-quality drops the entire composer to raw renderer.render and flags 'could look flat,' but offers no concrete fallback art (e.g., baked AO into the asphalt map, a vignette quad, faked contact shadows) so the no-post path still reads. For a single-scene game a large fraction of players on low-end hardware will see the flat path.

### Must-Fix (applied in synthesis)
- SOLVE THE 1v1 CAMERA, don't reuse followBall verbatim. Specify a two-subject framing: place the camera behind the handler on the handler→hoop line (as proposed) BUT compute look-target and distance from the BOUNDING of {handler, defender, ball} — e.g. lookAt = weighted midpoint(handler, ball), and dynamically dolly back / widen FOV so the defender stays within a frustum margin. Add an explicit 'keep defender in frame' constraint with a max separation before the cam pulls to a wider broadcast pose. This must be designed and budgeted now, not left as a Risk.
- Make camState a real exported handle. Either (a) export camState from the copied scene.js and document that camera.js mutates camState.distance/height only (matching golf's makeCameraDirector), or (b) move the director back into basketball.js like golf keeps it in golf.js. Pick one and correct the createCameraDirector(camState, followChase) signature claim so the implementer isn't chasing a closure variable that golf never exposed.
- Add real visual direction for the PLAYERS and the make-moment, since this pillar owns 'look.' At minimum specify: a faked soft contact shadow (blurred radial alphaMap quad) under each player and the ball so grounding survives even on the no-post path; a rim-light term (second cheap directional or hemi tint) to separate players from the asphalt at golden hour; and the hero court-tag graffiti as the framed focal point. The handoff to characters.js cannot be a one-liner.
- Resolve the line/displacement contradiction concretely. Recommend: keep micro-displacement ONLY outside the painted footprint; render the court markings into the asphalt material's own color/roughness maps (or a second UV-aligned blended map) on a flat sub-region, eliminating the separate offset plane and the z-fight entirely. If keeping the overlay plane, drop displacement to ±3mm under the court and justify polygonOffset with a screenshot test (golf smoke-harness style) as the author already proposes.
- Budget the transmission+shadow+main triple-traversal explicitly. State the medium-preset target frame time with the backboard on-screen and both players present, and define the threshold at which medium ALSO falls back to the plain transparent backboard (don't reserve transmission-off for low only). Verify with an offline/profile pass the way golf verified carries, rather than asserting 'acceptable.'
- Tighten the moving-caster shadow story. Either add a second tighter shadow cascade/frustum that follows the action box (handler+ball), or raise the effective sun angle slightly / increase shadow.radius for the long player shadows so edges don't swim. Acknowledge that 'court never moves' does not buy you stable PLAYER shadows.
- Specify the low-quality (no composer) art fallback: bake AO into the asphalt map, ship the contact-shadow quads (above), and add a cheap fullscreen vignette/grade as a single material rather than a composer pass, so the raw renderer.render path still reads as 'a place,' not flat-lit geometry.
- Cut from v1 and say so: night/dusk time-of-day + floodlight SpotLights, chain-net variant, replay orbit cam, heat-shimmer/chromatic aberration, and multi-skin courts. Ship one canonical golden-hour lot. This keeps the pillar inside the verified budget and removes the under-costed stretch items currently presented alongside core work.

### Feasibility Notes
Core claim — "one fixed half-court can be built per-pixel-heavier than golf inside ~120 draws / 60fps" — is correct and well-evidenced. I verified against the real code: composer chain (RenderPass→SSAO→Bloom→ColorGrade ShaderPass→SMAA→OutputPass), exposure=1.0, envMapIntensity≈0.30, SSAO 0.001/0.04, shadow mapSize 4096 + bias -0.0002 + normalBias 0.03, PMREM IBL, and the cup-catch model in physics.js all exist exactly as cited. The draw/tri budget (~60-80 draws, <100k tris) is realistic and conservative. The verlet net (72 nodes, 3 iters) and procedural CanvasTexture pipeline are proven-feasible by golf. FEASIBLE. Trim scope: cut night/dusk time-of-day, chain-net variant, replay orbit cam, heat-shimmer, and multi-skin courts from v1 — these are the parts where "specified concretely" masks real cost (extra SpotLights = extra shadow passes; chain InstancedMesh + clink audio; orbit cam needs recorded state buffer). MeshPhysicalMaterial transmission for the backboard is the one genuinely expensive item and it is correctly quality-gated. The single biggest unsolved feasibility gap is the camera (see gaps/mustFix), because the cited followBall template structurally frames ONE subject and 1v1 needs two.

