# 2K Schwartz

Multi-sport game by the Schwartz brothers. Current focus: **Golf MVP** (Wii Golf meets 2K Golf — realistic 3D, 18 holes, online multiplayer, Tiger Woods & Jalen Brunson).

> ### 🎾 Wilson — start your tennis game here → [`src/sports/tennis/START_HERE.md`](src/sports/tennis/START_HERE.md)
> Run `npm run dev`, open http://localhost:3000, click **Tennis**. Your sandbox is the whole
> `src/sports/tennis/` folder. Golf (`src/sports/golf/`) is Sid's — use it as a reference.

---

## Quick start (local, two windows)

```bash
npm install
npm run dev
```

- Vite client dev server → http://localhost:3000
- WebSocket server → ws://localhost:3001 (the client auto-targets it in dev)

**Two-window local test:**
1. Open http://localhost:3000 in **window A** → click **Golf** → choose **Host** → write down the 4-character room code shown.
2. Open http://localhost:3000 in **window B** (separate browser window or incognito) → click **Golf** → choose **Join** → type the code → press Join.
3. Both windows enter the match. Window A swings first.
4. Use mouse (LMB to click meter, RMB to drag aim) or an Xbox controller (A button = click, right stick = aim).
5. Settle a shot → opponent takes their turn → repeat through 3 holes (or 18 with `holeCount` adjusted).

---

## Deploy on Render (so you can play online)

The repo includes [`render.yaml`](./render.yaml). On Render's free tier:

1. Push to GitHub (already wired — see `Workflow` below).
2. Go to https://render.com → **New +** → **Blueprint** → connect `sidneyschwartz/2k-schwartz` → **Apply**.
3. First build ≈ 3 min (Render runs `npm install && npm run build`, then `npm start`).
4. Render gives you a URL like `https://2k-schwartz.onrender.com`. Share with your brother.
5. Both go to the URL → **Golf** → one **Host**, one **Join** with the code.

**HTTPS / WSS**: Render terminates HTTPS for you. The client connects to a same-origin WebSocket so the URL upgrades to `wss://` automatically when the page is loaded over HTTPS. No config needed.

**Cold start**: the free tier sleeps after ~15 min of no traffic. First request after sleep takes ~30s to wake. Tell your brother to wait if the page hangs initially.

---

## Production build (locally)

```bash
npm run build      # outputs dist/
npm start          # serves dist/ AND ws:// on the same port
```

`npm start` serves both static + WebSocket on `PORT` (default 3001 locally; Render sets `PORT` automatically).

---

## Stack

- **Client**: Vite + Three.js + cannon-es (golf), Canvas 2D (tennis)
- **Server**: Node + `ws` (single port, sport-multiplexed)
- **Input**: mouse/keyboard + Xbox controller (Gamepad API)
- **Visual**: ACES tonemap + bloom + SMAA + PBR materials + procedural sky
- **Audio**: Web Audio API procedural (no binary assets)

---

## Layout

```
src/
  index.html                   # vite entry
  main.js                      # menu router → lobby → sport
  style.css
  sports/
    tennis.js                  # tennis (v0.1 scaffold — still playable)
    golf/
      golf.js                  # game loop + integration
      scene.js                 # Three.js scene + chase camera
      physics.js               # cannon-es world + wind + green slope
      swing.js                 # 3-click meter + gamepad + putting mode
      clubs.js                 # Driver / 5i / 9i / Wedge / Putter
      characters.js            # Tiger + Brunson procedural models
      character-select.js
      hud.js                   # broadcast HUD (meter, club, wind, lie, stats)
      lobby.js                 # Single / vs CPU / Host / Join
      net.js                   # WS protocol client
      ai.js                    # CPU opponent (3 difficulties)
      audio.js                 # procedural SFX + ambient
      vfx.js                   # ball trail, divot, splash
      visuals.js               # sky, ACES, bloom, SMAA
      materials.js             # PBR fairway/rough/green/sand/water
      environment.js           # trees, signs, holeFlyover
      lies.js                  # surface-specific shot modifiers
      minimap.js
      settings.js
      round-summary.js
      course/
        holes.js               # 18-hole par-72 course data
        terrain.js             # buildHole + lieAt
public/assets/                 # static models / textures / audio
server/
  index.js                     # WS + static (dist) in prod
vite.config.js
render.yaml                    # Render Blueprint
```

---

## Sports

- [x] **Golf** (Wii/2K style, 18 holes, online MP, vs CPU, Tiger + Brunson)
- [x] Tennis (v0.1 scaffold — still playable from the menu)
- [ ] Bowling
- [ ] Boxing

---

## Multiplayer playtest checklist

Run this before declaring a match working with your brother:

- [ ] Both windows show the same **room code** in their HUD
- [ ] Host's window shows "Your turn"; Joiner shows "Opponent's turn"
- [ ] Host swings → ball flies → settles → opponent's window sees ball teleport to settle point
- [ ] Turn indicator flips correctly after each shot
- [ ] **Lie panel** updates on both clients after settle (Fairway / Rough / Sand / Green)
- [ ] **Shot stats card** appears for ~4s on both clients after settle (Carry · Total · Apex · Ball speed · Offline)
- [ ] When ball goes in the **water**, both clients see +1 stroke penalty and the drop
- [ ] **Hole-complete** banner shows the same stroke count on both clients
- [ ] **Hole flyover** plays on both clients between holes; cameras don't get stuck
- [ ] **Scorecard** totals match on both clients after each hole
- [ ] Closing one window shows "Opponent disconnected" on the other and freezes the loop with a "Back to menu" button
- [ ] Xbox controller works on both ends (A button + left/right sticks)
- [ ] Match-complete summary identical on both clients (winner / totals / par-diff badges)

---

## Workflow

Commit directly to `main`. Pull before you push:

```bash
git pull --rebase
# edit
git add -A
git commit -m "what you changed"
git push
```

If `git push` is rejected because the other person pushed first, just `git pull --rebase` and push again.
