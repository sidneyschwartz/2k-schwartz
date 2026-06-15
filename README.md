# 2K Schwartz

A Wii Sports-style multiplayer game by the Schwartz brothers.

## Run it

```bash
npm install
npm start
```

Open http://localhost:3000 in two browser windows (or two devices on the same network) to play.

## Stack

- **Client**: vanilla JS + HTML Canvas
- **Server**: Node + `ws` (WebSocket)
- No build step. Edit, refresh, play.

## Layout

```
public/        client (served as static files)
  index.html
  game.js
  style.css
server/        Node WebSocket + static file server
  index.js
```

## Sports

- [x] Tennis (first playable)
- [ ] Bowling
- [ ] Baseball
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
