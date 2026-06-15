// Minimal WebSocket handshake check against the production URL.
// Useful for verifying the Render deploy is up and accepting WS connections
// without spinning up two browsers.
//
//   node tests/ws-handshake.mjs https://2k-schwartz.onrender.com
//   node tests/ws-handshake.mjs http://localhost:3001   # dev WS-only server
//
// Exits 0 on success, non-zero on any failure.

import { WebSocket } from 'ws';

const arg = process.argv[2];
if (!arg) {
  console.error('usage: node tests/ws-handshake.mjs <http(s) base URL>');
  process.exit(2);
}

const httpUrl = new URL(arg);
const wsProto = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${wsProto}//${httpUrl.host}`;
const code = 'PROBE' + Math.floor(Math.random() * 9000 + 1000);

console.log('→ connecting to', wsUrl);
const t0 = Date.now();
const ws = new WebSocket(wsUrl);

let joined = false;
let timedOut = false;
const COLD_START_BUDGET_MS = 60_000;

const timer = setTimeout(() => {
  timedOut = true;
  console.error(`✗ timed out after ${COLD_START_BUDGET_MS}ms — server is asleep or unreachable`);
  try { ws.close(); } catch {}
  process.exit(1);
}, COLD_START_BUDGET_MS);

ws.on('open', () => {
  console.log(`✓ WS open in ${Date.now() - t0}ms`);
  ws.send(JSON.stringify({ type: 'join', sport: 'golf', code, clientId: 'handshake-probe' }));
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'joined') {
    joined = true;
    console.log(`✓ joined room ${msg.code} as slot ${msg.slot}`);
  } else if (msg.type === 'state') {
    console.log(`✓ received state snapshot (turn=${msg.turn}, hole=${msg.hole})`);
    clearTimeout(timer);
    if (joined) {
      console.log(`OK — handshake completed in ${Date.now() - t0}ms`);
      ws.close();
      process.exit(0);
    }
  } else if (msg.type === 'error') {
    console.error('✗ server error:', msg.error);
    clearTimeout(timer);
    ws.close();
    process.exit(1);
  } else {
    console.log('  •', msg.type);
  }
});

ws.on('close', () => {
  if (!joined && !timedOut) {
    console.error('✗ connection closed before join completed');
    process.exit(1);
  }
});

ws.on('error', (err) => {
  console.error('✗ ws error:', err.message);
  clearTimeout(timer);
  process.exit(1);
});
