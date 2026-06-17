# 🎾 Tennis — Start Here, Wilson

This folder is **your** part of the project. Golf is built out (`../golf`) — copy its
patterns. Tennis is a minimal runnable stub so you always have something on screen.

## Run it
```bash
npm install      # first time only
npm run dev      # then open http://localhost:3000 and click "Tennis"
```
Shortcut: open `http://localhost:3000/?tennis=1` to skip the menu.

## The one rule
`tennis.js` exports `mountTennis(host, onExit)` and returns an `unmount()` function.
`main.js` calls it when you click the Tennis tile. Keep that signature; everything
else inside is yours to change.

## Suggested path (each step is a `TODO` in tennis.js)
1. **Opponent paddle** on the right — start with simple AI that tracks the ball.
2. **Scoring + serve** — points when the ball passes a paddle.
3. **Go 3D** — copy the Three.js setup from `../golf/scene.js` (scene, camera,
   renderer, animation loop).
4. **Online multiplayer** — the server already speaks "tennis": it relays paddle +
   ball state between two players (see `../../../server/index.js`, the `room.sport
   === 'tennis'` block). The original pong-style 2-player tennis is preserved in git
   history — get it with:
   ```bash
   git show 84b796c:public/game.js
   ```

## Working together
We both commit to `main`. Pull before you push:
```bash
git pull --rebase
git add -A && git commit -m "tennis: <what you did>"
git push
```
Sid is building golf in `../golf` — your tennis changes won't collide with his as long
as you stay in this folder (and only touch the Tennis tile in `main.js`/`index.html`).
