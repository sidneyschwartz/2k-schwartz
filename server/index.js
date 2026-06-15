// 2K Schwartz multiplayer server.
// Dev: WS only on port 3001 (Vite serves the client on 3000 and proxies aren't needed —
//      the client opens ws://hostname:3001 directly when import.meta.env.DEV).
// Prod: serves the built dist/ as static AND the WS endpoint on the same port (default 3000).
//
// Reliability:
//  - Heartbeat: server pings each client every 25s; sockets that miss 2 pongs are dropped.
//  - Room TTL: an empty room is kept alive for ROOM_TTL_MS so a player who briefly
//    disconnects can reconnect (with the same clientId) and reclaim their slot.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, '..', 'dist');
const PORT = process.env.PORT || 3001;
const SERVE_STATIC = fs.existsSync(DIST_DIR);
const HEARTBEAT_MS = 25_000;       // server ping interval
const MISSED_PONG_LIMIT = 2;       // drop after this many consecutive missed pongs
const ROOM_TTL_MS = 60_000;        // keep empty rooms around this long for reconnect

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
  // Tiny health endpoint for Render. Always 200, even in dev.
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
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

const GOLF_HOLE_COUNT = 18; // upper bound; clients drive UI off their local course data

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room, msg, exceptWs) {
  for (const p of room.players) if (p?.ws && p.ws !== exceptWs) send(p.ws, msg);
}
function broadcastAll(room, msg) {
  for (const p of room.players) if (p?.ws) send(p.ws, msg);
}
function liveCount(room) {
  return room.players.filter((p) => p?.ws && p.ws.readyState === 1).length;
}

function roomKey(sport, code) { return `${sport}:${code}`; }

// Server-authoritative state snapshot for golf rooms — sent on every meaningful change
// so clients can render without any local guessing about whose turn it is or what hole.
function golfState(room) {
  return {
    type: 'state',
    turn: room.turn,
    hole: room.hole,
    scorecard: room.scorecard,
    holeComplete: !!room.holeComplete,
    matchComplete: !!room.matchComplete,
  };
}

function newGolfRoom(key, sport, code) {
  return {
    key, sport, code,
    // players is a fixed-length [slot0, slot1] array; either entry may be null while a
    // player is disconnected. slot is stable across reconnects.
    players: [null, null],
    state: null,
    // golf-specific authoritative state
    turn: 0,
    hole: 0,
    scorecard: [[], []],
    holeComplete: false,
    holeStrokes: [null, null],
    matchComplete: false,
    // reconnect tombstone — when both slots are empty, schedule GC after ROOM_TTL_MS
    gcAt: 0,
  };
}

function scheduleRoomGc(room) {
  if (liveCount(room) > 0) {
    room.gcAt = 0;
    return;
  }
  room.gcAt = Date.now() + ROOM_TTL_MS;
}

// Sweep stale rooms once per second. Cheap; rooms map is tiny.
setInterval(() => {
  const now = Date.now();
  for (const [key, room] of rooms) {
    if (liveCount(room) === 0 && room.gcAt && now >= room.gcAt) {
      rooms.delete(key);
    }
  }
}, 1000).unref?.();

// Heartbeat: every HEARTBEAT_MS, ping every live ws. If a ws has not responded to the
// previous N pings, terminate it. Each ws tracks its own missed-pong counter.
setInterval(() => {
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    client.missedPongs = (client.missedPongs ?? 0) + 1;
    if (client.missedPongs > MISSED_PONG_LIMIT) {
      try { client.terminate(); } catch {}
      continue;
    }
    try { client.ping(); } catch {}
  }
}, HEARTBEAT_MS).unref?.();

wss.on('connection', (ws) => {
  ws.room = null;
  ws.slot = null;
  ws.clientId = null;
  ws.missedPongs = 0;

  ws.on('pong', () => { ws.missedPongs = 0; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // App-level keepalive: client may send {type:'ping'} when it suspects the network is
    // unreliable. We immediately respond with {type:'pong'} so the client can detect a
    // working server. This is independent of the WebSocket ping/pong frames above.
    if (msg.type === 'ping') {
      send(ws, { type: 'pong', t: msg.t });
      return;
    }

    if (msg.type === 'join') {
      const sport = (msg.sport || 'tennis').toLowerCase();
      const code = (msg.code || '').toUpperCase().slice(0, 6);
      const clientId = typeof msg.clientId === 'string' ? msg.clientId.slice(0, 64) : null;
      if (!code) return send(ws, { type: 'error', error: 'missing code' });
      const key = roomKey(sport, code);
      let room = rooms.get(key);
      if (!room) {
        room = sport === 'golf'
          ? newGolfRoom(key, sport, code)
          : { key, sport, code, players: [null, null], state: null, turn: 0, hole: 0, scorecard: [[], []], holeComplete: false, holeStrokes: [null, null], matchComplete: false, gcAt: 0 };
        rooms.set(key, room);
      }

      // Reclaim path: same clientId as a previously-occupied (now-empty) slot.
      let reclaimedSlot = null;
      if (clientId) {
        for (let s = 0; s < room.players.length; s++) {
          const p = room.players[s];
          if (p && !p.ws && p.clientId === clientId) {
            reclaimedSlot = s;
            break;
          }
        }
      }

      let slot;
      if (reclaimedSlot != null) {
        slot = reclaimedSlot;
        room.players[slot] = { ws, slot, clientId };
      } else {
        // Find the lowest empty slot index.
        slot = room.players.findIndex((p) => p == null || !p.ws);
        if (slot === -1 || liveCount(room) >= 2) {
          return send(ws, { type: 'error', error: 'room full' });
        }
        room.players[slot] = { ws, slot, clientId };
      }

      ws.room = room;
      ws.slot = slot;
      ws.clientId = clientId;
      room.gcAt = 0;
      send(ws, { type: 'joined', slot, code, sport, reclaimed: reclaimedSlot != null });

      if (sport === 'golf') {
        send(ws, golfState(room));
      }
      // 'start' fires the first time the room has 2 live players. We track this via a
      // sticky flag so a returning player doesn't see a fresh 'start' on reclaim.
      if (liveCount(room) === 2) {
        if (!room.started) {
          room.started = true;
          broadcastAll(room, { type: 'start' });
        } else {
          broadcastAll(room, { type: 'opponent-rejoined' });
        }
        if (sport === 'golf') broadcastAll(room, golfState(room));
      }
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

    // ---- GOLF ---- (server-authoritative: turn, scorecard, hole advance, match-complete)
    //
    // Protocol (client -> server):
    //   { type: 'join', sport: 'golf', code, clientId?, character? }
    //   { type: 'ping', t? }
    //   { type: 'shot', shot: { club, power, accuracy, aim, startPos } }
    //   { type: 'shot-result', result: { endPos, strokes } }
    //   { type: 'hole-complete', strokes }
    //   { type: 'end-turn' }
    //   { type: 'next-hole' }                — advisory only; server may already have advanced
    //   { type: 'match-complete' }
    //
    // Protocol (server -> client):
    //   { type: 'joined', slot, code, sport, reclaimed? }
    //   { type: 'pong', t? }
    //   { type: 'start' }                    — first time both slots are live
    //   { type: 'opponent-rejoined' }        — peer reconnected mid-match
    //   { type: 'state', turn, hole, scorecard, holeComplete, matchComplete }
    //   { type: 'shot', slot, club, power, accuracy, aim, startPos }
    //   { type: 'shot-result', slot, endPos, strokes }
    //   { type: 'turn', turn }
    //   { type: 'scorecard', scorecard }
    //   { type: 'next-hole', hole, turn }
    //   { type: 'match-complete', scorecard }
    //   { type: 'opponent-left' }
    //   { type: 'error', error }
    if (room.sport === 'golf') {
      if (room.matchComplete) return; // ignore stragglers after the match is over

      if (msg.type === 'shot') {
        if (ws.slot !== room.turn) return send(ws, { type: 'error', error: 'not your turn' });
        broadcast(room, { type: 'shot', slot: ws.slot, ...msg.shot }, ws);
      } else if (msg.type === 'shot-result') {
        if (ws.slot !== room.turn) return;
        broadcast(room, {
          type: 'shot-result',
          slot: ws.slot,
          endPos: msg.result?.endPos,
          strokes: Number(msg.result?.strokes) || 0,
        }, ws);
      } else if (msg.type === 'hole-complete') {
        if (room.holeComplete) return;
        if (room.holeStrokes[ws.slot] != null) return;
        const strokes = Math.max(1, Number(msg.strokes) || 0);
        room.holeStrokes[ws.slot] = strokes;
        room.scorecard[ws.slot][room.hole] = strokes;
        broadcastAll(room, { type: 'scorecard', scorecard: room.scorecard });
      } else if (msg.type === 'end-turn') {
        if (ws.slot !== room.turn) return;
        if (room.holeComplete) return;
        room.turn = 1 - room.turn;
        broadcastAll(room, { type: 'turn', turn: room.turn });
      } else if (msg.type === 'next-hole') {
        if (room.holeComplete) return;
        const bothDone = room.holeStrokes[0] != null && room.holeStrokes[1] != null;
        if (!bothDone) return;
        room.holeComplete = true;
        room.hole += 1;
        room.holeStrokes = [null, null];
        room.holeComplete = false;
        room.turn = 0;
        broadcastAll(room, { type: 'next-hole', hole: room.hole, turn: 0 });
        broadcastAll(room, golfState(room));
      } else if (msg.type === 'match-complete') {
        if (room.matchComplete) return;
        room.matchComplete = true;
        broadcastAll(room, { type: 'match-complete', scorecard: room.scorecard });
      }
      return;
    }
  });

  ws.on('close', () => {
    const room = ws.room;
    if (!room) return;
    // Don't shift slots — keep the seat warm for a possible reclaim.
    const seat = room.players.find((p) => p?.ws === ws);
    if (seat) seat.ws = null;
    broadcast(room, { type: 'opponent-left' }, ws);
    scheduleRoomGc(room);
  });
});

server.listen(PORT, () => {
  if (SERVE_STATIC) console.log(`http://localhost:${PORT}  (serving dist/ + WS)`);
  else console.log(`ws://localhost:${PORT}  (dev WS only — Vite serves the client)`);
});
