# 2K Schwartz

Wii Sports-style multi-sport game by the Schwartz brothers. Current focus: **Golf MVP** (Wii Golf meets 2K Golf).

## Run it

```bash
npm install
npm run dev
```

- Vite client dev server: http://localhost:3000
- WebSocket server: ws://localhost:3001

Open the client URL in two windows to play multiplayer.

## Build & serve (prod)

```bash
npm run build      # outputs dist/
npm start          # serves dist/ + WS on port 3000
```

## Stack

- **Client**: Vite + Three.js + cannon-es (golf), Canvas 2D (tennis)
- **Server**: Node + `ws`
- **Input**: mouse/keyboard + Xbox controller (Gamepad API)

## Layout

```
src/
  index.html                   # vite entry
  main.js                      # menu router
  style.css
  sports/
    tennis.js                  # tennis (lifted from v0.1 scaffold)
    golf/                      # golf MVP
      golf.js                  # game loop, state machine
      scene.js                 # Three.js scene
      physics.js               # cannon-es world
      swing.js                 # three-click meter + gamepad
      clubs.js
      characters.js
      hud.js
      net.js                   # WS protocol
      course/
public/assets/                 # static models / textures / audio
server/
  index.js                     # WS multiplexed by sport + static (dist) in prod
vite.config.js
```

## Sports

- [ ] Golf (Phase 1–6 in progress; see plan)
- [x] Tennis (v0.1 scaffold — still playable from the menu)
- [ ] Bowling
- [ ] Boxing

## Workflow

We commit directly to `main`. Pull before you push:

```bash
git pull --rebase
# edit
git add -A
git commit -m "what you changed"
git push
```
