import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

const server = http.createServer((req, res) => {
  const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

const rooms = new Map();

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, except) {
  for (const peer of room.players) {
    if (peer !== except) send(peer, msg);
  }
}

wss.on('connection', (ws) => {
  ws.room = null;
  ws.slot = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      const code = (msg.code || '').toUpperCase().slice(0, 6);
      if (!code) return send(ws, { type: 'error', error: 'missing code' });
      let room = rooms.get(code);
      if (!room) {
        room = { code, players: [], state: null };
        rooms.set(code, room);
      }
      if (room.players.length >= 2) return send(ws, { type: 'error', error: 'room full' });
      ws.room = room;
      ws.slot = room.players.length;
      room.players.push(ws);
      send(ws, { type: 'joined', slot: ws.slot, code });
      if (room.players.length === 2) {
        broadcast(room, { type: 'start' });
      }
      return;
    }

    if (!ws.room) return;

    if (msg.type === 'input') {
      // Relay paddle position to the opponent
      broadcast(ws.room, { type: 'input', slot: ws.slot, y: msg.y }, ws);
      return;
    }

    if (msg.type === 'ball') {
      // Authoritative ball state from slot 0 (host) — relay to slot 1
      if (ws.slot !== 0) return;
      broadcast(ws.room, { type: 'ball', ...msg.state }, ws);
      return;
    }

    if (msg.type === 'score') {
      broadcast(ws.room, { type: 'score', score: msg.score }, ws);
      return;
    }
  });

  ws.on('close', () => {
    const room = ws.room;
    if (!room) return;
    room.players = room.players.filter((p) => p !== ws);
    broadcast(room, { type: 'opponent-left' });
    if (room.players.length === 0) rooms.delete(room.code);
  });
});

server.listen(PORT, () => {
  console.log(`http://localhost:${PORT}`);
});
