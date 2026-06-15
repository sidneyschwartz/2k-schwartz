// 2K Schwartz — Tennis (starter)
// Slot 0 simulates physics (authoritative). Slot 1 mirrors received state.

const W = 800, H = 480;
const PADDLE_W = 12, PADDLE_H = 80;
const BALL_R = 8;
const PADDLE_SPEED = 7;

const screens = {
  menu: document.getElementById('menu'),
  lobby: document.getElementById('lobby'),
  game: document.getElementById('game'),
};
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const scoreEl = document.getElementById('score');
const roomLabel = document.getElementById('room-label');
const lobbyStatus = document.getElementById('lobby-status');
const roomInput = document.getElementById('room-code');

let ws = null;
let mySlot = null;
let started = false;

const state = {
  paddles: [H / 2, H / 2],
  ball: { x: W / 2, y: H / 2, vx: 5, vy: 3 },
  score: [0, 0],
};
const input = { up: false, down: false, mouseY: null };

function show(name) {
  for (const [k, el] of Object.entries(screens)) el.classList.toggle('hidden', k !== name);
}

document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', leave));
document.querySelectorAll('.sport:not(.disabled)').forEach((b) => {
  b.addEventListener('click', () => show('lobby'));
});

document.getElementById('join').addEventListener('click', joinRoom);
roomInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });

function randomCode() {
  return Array.from({ length: 4 }, () => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 31)]).join('');
}

function joinRoom() {
  const code = (roomInput.value.trim() || randomCode()).toUpperCase();
  roomInput.value = code;
  connect(code);
}

function connect(code) {
  lobbyStatus.textContent = 'connecting…';
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'join', code })));
  ws.addEventListener('message', onMessage);
  ws.addEventListener('close', () => { lobbyStatus.textContent = 'disconnected.'; });
  ws.addEventListener('error', () => { lobbyStatus.textContent = 'connection error.'; });
}

function onMessage(ev) {
  const msg = JSON.parse(ev.data);
  if (msg.type === 'joined') {
    mySlot = msg.slot;
    roomLabel.textContent = `room ${msg.code} · you are P${mySlot + 1}`;
    lobbyStatus.textContent = mySlot === 0 ? 'waiting for opponent…' : 'joined. waiting for host…';
  } else if (msg.type === 'start') {
    started = true;
    resetBall(1);
    show('game');
    loop();
  } else if (msg.type === 'input') {
    state.paddles[msg.slot] = msg.y;
  } else if (msg.type === 'ball') {
    if (mySlot !== 0) {
      state.ball.x = msg.x; state.ball.y = msg.y;
      state.ball.vx = msg.vx; state.ball.vy = msg.vy;
    }
  } else if (msg.type === 'score') {
    state.score = msg.score;
    updateScore();
  } else if (msg.type === 'opponent-left') {
    lobbyStatus.textContent = 'opponent left.';
    leave();
  } else if (msg.type === 'error') {
    lobbyStatus.textContent = msg.error;
  }
}

function leave() {
  started = false;
  if (ws) { ws.close(); ws = null; }
  mySlot = null;
  state.score = [0, 0];
  updateScore();
  show('menu');
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'w' || e.key === 'W' || e.key === 'ArrowUp') input.up = true;
  if (e.key === 's' || e.key === 'S' || e.key === 'ArrowDown') input.down = true;
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'w' || e.key === 'W' || e.key === 'ArrowUp') input.up = false;
  if (e.key === 's' || e.key === 'S' || e.key === 'ArrowDown') input.down = false;
});
canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  input.mouseY = ((e.clientY - rect.top) / rect.height) * H;
});

function updateMyPaddle() {
  let y = state.paddles[mySlot];
  if (input.mouseY != null) y = input.mouseY;
  if (input.up) y -= PADDLE_SPEED;
  if (input.down) y += PADDLE_SPEED;
  y = Math.max(PADDLE_H / 2, Math.min(H - PADDLE_H / 2, y));
  if (y !== state.paddles[mySlot]) {
    state.paddles[mySlot] = y;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', y }));
  }
}

function resetBall(dir) {
  state.ball.x = W / 2;
  state.ball.y = H / 2;
  state.ball.vx = 5 * (dir || (Math.random() > 0.5 ? 1 : -1));
  state.ball.vy = (Math.random() * 4 - 2);
}

function physicsHost() {
  const b = state.ball;
  b.x += b.vx;
  b.y += b.vy;
  if (b.y < BALL_R) { b.y = BALL_R; b.vy *= -1; }
  if (b.y > H - BALL_R) { b.y = H - BALL_R; b.vy *= -1; }

  // Paddle collisions
  const leftX = 20 + PADDLE_W;
  const rightX = W - 20 - PADDLE_W;
  if (b.x - BALL_R < leftX && b.vx < 0) {
    const py = state.paddles[0];
    if (b.y > py - PADDLE_H / 2 && b.y < py + PADDLE_H / 2) {
      b.vx = Math.abs(b.vx) * 1.05;
      b.vy += (b.y - py) * 0.08;
    }
  }
  if (b.x + BALL_R > rightX && b.vx > 0) {
    const py = state.paddles[1];
    if (b.y > py - PADDLE_H / 2 && b.y < py + PADDLE_H / 2) {
      b.vx = -Math.abs(b.vx) * 1.05;
      b.vy += (b.y - py) * 0.08;
    }
  }

  // Scoring
  if (b.x < -BALL_R) { state.score[1]++; updateScore(); broadcastScore(); resetBall(1); }
  else if (b.x > W + BALL_R) { state.score[0]++; updateScore(); broadcastScore(); resetBall(-1); }

  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'ball', state: { x: b.x, y: b.y, vx: b.vx, vy: b.vy } }));
  }
}

function broadcastScore() {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'score', score: state.score }));
}

function updateScore() {
  scoreEl.textContent = `${state.score[0]} — ${state.score[1]}`;
}

function draw() {
  ctx.fillStyle = '#050816';
  ctx.fillRect(0, 0, W, H);

  // Center line
  ctx.strokeStyle = '#1f2a55';
  ctx.setLineDash([8, 12]);
  ctx.beginPath();
  ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H); ctx.stroke();
  ctx.setLineDash([]);

  // Paddles
  ctx.fillStyle = '#6cf';
  ctx.fillRect(20, state.paddles[0] - PADDLE_H / 2, PADDLE_W, PADDLE_H);
  ctx.fillStyle = '#fc6';
  ctx.fillRect(W - 20 - PADDLE_W, state.paddles[1] - PADDLE_H / 2, PADDLE_W, PADDLE_H);

  // Ball
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(state.ball.x, state.ball.y, BALL_R, 0, Math.PI * 2);
  ctx.fill();
}

function loop() {
  if (!started) return;
  updateMyPaddle();
  if (mySlot === 0) physicsHost();
  draw();
  requestAnimationFrame(loop);
}

show('menu');
