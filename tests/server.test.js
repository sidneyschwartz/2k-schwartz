// Integration: spin up the WS server, connect two clients, walk the golf turn
// protocol end-to-end without a browser.
//
// Each client buffers every message it receives so we never miss one due to a
// listener being attached a tick too late (the server broadcasts 'start'/'state'
// the instant the room fills).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';

const PORT = 4321;
const ROOM = 'TST';

function makeClient(ws) {
  const buf = [];
  ws.on('message', (raw) => {
    try { buf.push(JSON.parse(raw.toString())); } catch {}
  });
  return {
    ws,
    buf,
    send(obj) { ws.send(JSON.stringify(obj)); },
    // Wait until a buffered message matches, scanning past + future messages.
    async waitFor(predicate, timeoutMs = 2000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const hit = buf.find(predicate);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('timed out waiting for ws message; buffer=' + JSON.stringify(buf));
    },
    close() { ws.close(); },
  };
}

async function bootServer() {
  const child = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve) => {
    child.stdout.on('data', (chunk) => { if (chunk.toString().includes(`${PORT}`)) resolve(); });
    setTimeout(resolve, 1000);
  });
  return child;
}

async function openClient() {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return makeClient(ws);
}

test('two clients join a golf room, only the active player can shoot, turn flips', async (t) => {
  const server = await bootServer();
  t.after(() => server.kill());

  const a = await openClient();
  const b = await openClient();

  a.send({ type: 'join', sport: 'golf', code: ROOM });
  const aJ = await a.waitFor((m) => m.type === 'joined');
  assert.equal(aJ.slot, 0);

  b.send({ type: 'join', sport: 'golf', code: ROOM });
  const bJ = await b.waitFor((m) => m.type === 'joined');
  assert.equal(bJ.slot, 1);

  // Both should see 'start' once the room fills (buffered, so no race).
  await a.waitFor((m) => m.type === 'start');
  await b.waitFor((m) => m.type === 'start');

  // B (slot 1) is not the active player (turn defaults to 0) → server rejects its shot.
  b.send({ type: 'shot', shot: { club: 'Driver', power: 0.8 } });
  const err = await b.waitFor((m) => m.type === 'error');
  assert.match(err.error || '', /turn/i);

  // A (slot 0) shoots — B should see the relayed shot.
  a.send({ type: 'shot', shot: { club: 'Driver', power: 0.9 } });
  await b.waitFor((m) => m.type === 'shot' && m.slot === 0);

  // A reports the result and ends its turn → turn flips to slot 1.
  a.send({ type: 'shot-result', result: { endPos: [0, 0, 80], strokes: 1 } });
  a.send({ type: 'end-turn' });
  // Wait specifically for the flip to slot 1 (an earlier buffered 'state' has turn:0).
  const turn = await b.waitFor((m) => (m.type === 'turn' || m.type === 'state') && m.turn === 1);
  assert.equal(turn.turn, 1);

  a.close(); b.close();
});

test('rejects join with no code', async (t) => {
  const server = await bootServer();
  t.after(() => server.kill());
  const c = await openClient();
  c.send({ type: 'join', sport: 'golf', code: '' });
  const err = await c.waitFor((m) => m.type === 'error');
  assert.match(err.error || '', /code/i);
  c.close();
});

test('third client is rejected from a full room', async (t) => {
  const server = await bootServer();
  t.after(() => server.kill());
  const a = await openClient();
  const b = await openClient();
  const c = await openClient();
  a.send({ type: 'join', sport: 'golf', code: 'FULL' });
  await a.waitFor((m) => m.type === 'joined');
  b.send({ type: 'join', sport: 'golf', code: 'FULL' });
  await b.waitFor((m) => m.type === 'joined');
  c.send({ type: 'join', sport: 'golf', code: 'FULL' });
  const err = await c.waitFor((m) => m.type === 'error');
  assert.match(err.error || '', /full/i);
  a.close(); b.close(); c.close();
});
