// 2K Schwartz multiplayer server.
// Dev: WS only on port 3001 (Vite serves the client on 3000 and proxies aren't needed —
//      the client opens ws://hostname:3001 directly when import.meta.env.DEV).
// Prod: serves the built dist/ as static AND the WS endpoint on the same port (default 3000).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, '..', 'dist');
const PORT = process.env.PORT || 3001;
const SERVE_STATIC = fs.existsSync(DIST_DIR);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.hdr': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

const server = http.createServer((req, res) => {
  if (!SERVE_STATIC) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('2k-schwartz ws server (dev mode — open the Vite dev URL).');
  }
  const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const filePath = path.join(DIST_DIR, urlPath);
  if (!filePath.startsWith(DIST_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback
      fs.readFile(path.join(DIST_DIR, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const rooms = new Map(); // key: `${sport}:${code}`

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room, msg, except) {
  for (const peer of room.players) if (peer !== except) send(peer, msg);
}

function roomKey(sport, code) { return `${sport}:${code}`; }

wss.on('connection', (ws) => {
  ws.room = null;
  ws.slot = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const sport = (msg.sport || 'tennis').toLowerCase();
      const code = (msg.code || '').toUpperCase().slice(0, 6);
      if (!code) return send(ws, { type: 'error', error: 'missing code' });
      const key = roomKey(sport, code);
      let room = rooms.get(key);
      if (!room) {
        room = { key, sport, code, players: [], state: null, turn: 0, hole: 0, scorecard: [[], []] };
        rooms.set(key, room);
      }
      if (room.players.length >= 2) return send(ws, { type: 'error', error: 'room full' });
      ws.room = room;
      ws.slot = room.players.length;
      room.players.push(ws);
      send(ws, { type: 'joined', slot: ws.slot, code, sport });
      if (room.players.length === 2) broadcast(room, { type: 'start' });
      return;
    }

    if (!ws.room) return;
    const room = ws.room;

    // ---- TENNIS ----
    if (room.sport === 'tennis') {
      if (msg.type === 'input') {
        broadcast(room, { type: 'input', slot: ws.slot, y: msg.y }, ws);
      } else if (msg.type === 'ball') {
        if (ws.slot !== 0) return;
        broadcast(room, { type: 'ball', ...msg.state }, ws);
      } else if (msg.type === 'score') {
        broadcast(room, { type: 'score', score: msg.score }, ws);
      }
      return;
    }

    // ---- GOLF ---- (turn-based; Phase 4 will flesh out)
    if (room.sport === 'golf') {
      if (msg.type === 'shot') {
        // shot intent: { club, power, accuracy, aim, startPos }
        if (ws.slot !== room.turn) return send(ws, { type: 'error', error: 'not your turn' });
        broadcast(room, { type: 'shot', slot: ws.slot, ...msg.shot }, ws);
      } else if (msg.type === 'shot-result') {
        // authoritative ball landing from active player's client
        if (ws.slot !== room.turn) return;
        broadcast(room, { type: 'shot-result', slot: ws.slot, ...msg.result }, ws);
      } else if (msg.type === 'hole-complete') {
        const strokes = Number(msg.strokes) || 0;
        room.scorecard[ws.slot][room.hole] = strokes;
        broadcast(room, { type: 'scorecard', scorecard: room.scorecard });
      } else if (msg.type === 'end-turn') {
        room.turn = 1 - room.turn;
        broadcast(room, { type: 'turn', turn: room.turn });
      } else if (msg.type === 'next-hole') {
        room.hole++;
        room.turn = 0;
        broadcast(room, { type: 'next-hole', hole: room.hole, turn: 0 });
      }
      return;
    }
  });

  ws.on('close', () => {
    const room = ws.room;
    if (!room) return;
    room.players = room.players.filter((p) => p !== ws);
    broadcast(room, { type: 'opponent-left' });
    if (room.players.length === 0) rooms.delete(room.key);
  });
});

server.listen(PORT, () => {
  if (SERVE_STATIC) console.log(`http://localhost:${PORT}  (serving dist/ + WS)`);
  else console.log(`ws://localhost:${PORT}  (dev WS only — Vite serves the client)`);
});
