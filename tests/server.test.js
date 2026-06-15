// Integration: spin up the WS server, connect two clients, walk the golf turn
// protocol end-to-end without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = 4321;
const ROOM = 'TST';

function waitMsg(ws, predicate, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out waiting for ws message')), timeoutMs);
    function onMsg(raw) {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (predicate(msg)) {
        clearTimeout(t);
        ws.off('message', onMsg);
        resolve(msg);
      }
    }
    ws.on('message', onMsg);
  });
}

async function bootServer() {
  const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve) => {
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes(`${PORT}`)) resolve();
    });
    setTimeout(resolve, 800); // safety
  });
  return child;
}

async function openClient() {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
}

test('two clients can join the same golf room and exchange shots', async (t) => {
  const server = await bootServer();
  t.after(() => server.kill());

  const a = await openClient();
  const b = await openClient();

  const aJoined = waitMsg(a, (m) => m.type === 'joined');
  a.send(JSON.stringify({ type: 'join', sport: 'golf', code: ROOM }));
  const aJ = await aJoined;
  assert.equal(aJ.slot, 0);

  const bJoined = waitMsg(b, (m) => m.type === 'joined');
  b.send(JSON.stringify({ type: 'join', sport: 'golf', code: ROOM }));
  const bJ = await bJoined;
  assert.equal(bJ.slot, 1);

  // Both clients should receive 'start' when the room fills.
  await waitMsg(a, (m) => m.type === 'start');
  await waitMsg(b, (m) => m.type === 'start');

  // A (slot 0) shoots. Server should reject B trying to shoot.
  const bRejected = waitMsg(b, (m) => m.type === 'error');
  b.send(JSON.stringify({ type: 'shot', shot: { club: 'Driver', power: 0.8 } }));
  const err = await bRejected;
  assert.match(err.error || '', /turn/i);

  // A shoots — B should see the shot.
  const bSeesShot = waitMsg(b, (m) => m.type === 'shot' && m.slot === 0);
  a.send(JSON.stringify({ type: 'shot', shot: { club: 'Driver', power: 0.9 } }));
  await bSeesShot;

  // A's shot result + end-turn flips the active player.
  a.send(JSON.stringify({
    type: 'shot-result',
    result: { endPos: [0, 0, 80], strokes: 1 },
  }));
  a.send(JSON.stringify({ type: 'end-turn' }));
  const turn = await waitMsg(b, (m) => m.type === 'turn' || (m.type === 'state' && typeof m.turn === 'number'));
  assert.equal(turn.turn, 1);

  a.close(); b.close();
});

test('rejects join with no code', async (t) => {
  const server = await bootServer();
  t.after(() => server.kill());
  const ws = await openClient();
  const errP = waitMsg(ws, (m) => m.type === 'error');
  ws.send(JSON.stringify({ type: 'join', sport: 'golf', code: '' }));
  const err = await errP;
  assert.match(err.error || '', /code/i);
  ws.close();
});
