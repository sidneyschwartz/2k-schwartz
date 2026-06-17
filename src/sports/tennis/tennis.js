// ============================================================================
//  🎾  TENNIS — START HERE, WILSON
// ============================================================================
//
//  This is YOUR sandbox. The golf game lives in ../golf and is fully built out;
//  use it as a reference for how a sport is structured (scene, physics, HUD,
//  multiplayer). Tennis is intentionally a minimal runnable stub so you have a
//  working thing on screen to build out from.
//
//  HOW TO RUN IT:
//    npm run dev   →  open http://localhost:3000  →  click the "Tennis" tile
//    (or jump straight in with  http://localhost:3000/?tennis=1 )
//
//  THE CONTRACT (don't change this signature — main.js calls it):
//    mountTennis(hostElement, onExit)  →  returns an unmount() function
//      - hostElement: a <div> you render into
//      - onExit():    call this to go back to the menu
//      - return a cleanup function that stops your loop + removes listeners
//
//  WHAT'S HERE NOW: a single paddle you move with the mouse/W-S that bounces a
//  ball off the walls. That's it — a heartbeat to build on.
//
//  👉 BUILD-OUT IDEAS (each is a "TODO" below — search for TODO):
//    1. Add an opponent paddle (AI, then a second player).
//    2. Add scoring + serve.
//    3. Make it 3D with Three.js (copy the pattern from ../golf/scene.js).
//    4. Add online multiplayer (the WebSocket server already supports a
//       'tennis' sport — see ../../../server/index.js, it relays paddle/ball
//       state. The OLD pong-style multiplayer tennis is in git history at commit
//       84b796c if you want to crib it: `git show 84b796c:public/game.js`).
// ============================================================================

const W = 800, H = 480;
const PADDLE_W = 14, PADDLE_H = 90, BALL_R = 9, PADDLE_SPEED = 8;

export function mountTennis(host, onExit) {
  host.innerHTML = `
    <section class="screen" style="text-align:center;">
      <h2>🎾 Tennis <small style="opacity:.6;font-size:.5em;">(your sandbox — build it out!)</small></h2>
      <canvas id="tn" width="${W}" height="${H}"
        style="background:#0a2818;border:2px solid #2a8d4a;border-radius:10px;max-width:96vw;height:auto;"></canvas>
      <p class="hint">Move with the mouse or W / S. &nbsp; See the TODOs in
        <code>src/sports/tennis/tennis.js</code> to start building.</p>
      <button class="back" id="tn-back">← back</button>
    </section>`;

  const canvas = host.querySelector('#tn');
  const ctx = canvas.getContext('2d');
  const state = {
    paddleY: H / 2,
    ball: { x: W / 2, y: H / 2, vx: 5, vy: 3.2 },
  };
  const input = { up: false, down: false, mouseY: null };

  const onKey = (down) => (e) => {
    if (e.key === 'w' || e.key === 'W') input.up = down;
    if (e.key === 's' || e.key === 'S') input.down = down;
  };
  const keyDown = onKey(true), keyUp = onKey(false);
  window.addEventListener('keydown', keyDown);
  window.addEventListener('keyup', keyUp);
  canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    input.mouseY = ((e.clientY - r.top) / r.height) * H;
  });
  host.querySelector('#tn-back').addEventListener('click', () => onExit?.());

  let raf = 0;
  function loop() {
    // --- move paddle ---
    let y = state.paddleY;
    if (input.mouseY != null) y = input.mouseY;
    if (input.up) y -= PADDLE_SPEED;
    if (input.down) y += PADDLE_SPEED;
    state.paddleY = Math.max(PADDLE_H / 2, Math.min(H - PADDLE_H / 2, y));

    // --- move ball, bounce off walls ---
    const b = state.ball;
    b.x += b.vx; b.y += b.vy;
    if (b.y < BALL_R || b.y > H - BALL_R) b.vy *= -1;
    if (b.x > W - BALL_R) b.vx *= -1;                 // right wall
    // left side: bounce off the paddle, else reset (TODO #2: that's a point against you)
    if (b.x - BALL_R < 20 + PADDLE_W) {
      if (b.y > state.paddleY - PADDLE_H / 2 && b.y < state.paddleY + PADDLE_H / 2) {
        b.vx = Math.abs(b.vx) * 1.03;
        b.vy += (b.y - state.paddleY) * 0.05;
      } else if (b.x < 0) {
        b.x = W / 2; b.y = H / 2; b.vx = 5; b.vy = 3.2; // TODO #2: score, serve
      }
    }

    // --- draw ---
    ctx.fillStyle = '#0a2818'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#2a8d4a'; ctx.setLineDash([8, 12]);
    ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#6cf';
    ctx.fillRect(20, state.paddleY - PADDLE_H / 2, PADDLE_W, PADDLE_H);
    // TODO #1: draw the opponent paddle on the right side here.
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(b.x, b.y, BALL_R, 0, Math.PI * 2); ctx.fill();

    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);

  // Cleanup — main.js calls this when leaving tennis.
  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', keyDown);
    window.removeEventListener('keyup', keyUp);
  };
}
