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

const GOLF_HOLE_COUNT = 18; // upper bound; clients drive UI off their local course data

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(room, msg, except) {
  for (const peer of room.players) if (peer !== except) send(peer, msg);
}
function broadcastAll(room, msg) {
  for (const peer of room.players) send(peer, msg);
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
        room = {
          key, sport, code,
          players: [],
          state: null,
          // golf-specific authoritative state
          turn: 0,
          hole: 0,
          scorecard: [[], []],
          holeComplete: false,    // current hole already closed by both clients?
          holeStrokes: [null, null], // submitted strokes for the active hole (null = not yet)
          matchComplete: false,
        };
        rooms.set(key, room);
      }
      if (room.players.length >= 2) return send(ws, { type: 'error', error: 'room full' });
      ws.room = room;
      ws.slot = room.players.length;
      room.players.push(ws);
      send(ws, { type: 'joined', slot: ws.slot, code, sport });
      if (sport === 'golf') {
        // Send state right away so a late-joining slot 1 has the truth.
        send(ws, golfState(room));
      }
      if (room.players.length === 2) {
        broadcast(room, { type: 'start' });
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
    //   { type: 'shot', shot: { club, power, accuracy, aim, startPos } }
    //   { type: 'shot-result', result: { endPos, strokes } }
    //   { type: 'hole-complete', strokes }
    //   { type: 'end-turn' }
    //   { type: 'next-hole' }                — advisory only; server may already have advanced
    //
    // Protocol (server -> client):
    //   { type: 'joined', slot, code, sport }
    //   { type: 'start' }
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
        // shot intent — only the active turn-holder is allowed to send
        if (ws.slot !== room.turn) return send(ws, { type: 'error', error: 'not your turn' });
        broadcast(room, { type: 'shot', slot: ws.slot, ...msg.shot }, ws);
      } else if (msg.type === 'shot-result') {
        // authoritative ball landing from active player's client; bind the slot ourselves
        if (ws.slot !== room.turn) return;
        broadcast(room, {
          type: 'shot-result',
          slot: ws.slot,
          endPos: msg.result?.endPos,
          strokes: Number(msg.result?.strokes) || 0,
        }, ws);
      } else if (msg.type === 'hole-complete') {
        // Each slot can only submit a hole-complete once per hole. Server records the score
        // and re-broadcasts the canonical scorecard. We don't trust the client's slot index.
        if (room.holeComplete) return;
        if (room.holeStrokes[ws.slot] != null) return; // dup from same slot
        const strokes = Math.max(1, Number(msg.strokes) || 0);
        room.holeStrokes[ws.slot] = strokes;
        room.scorecard[ws.slot][room.hole] = strokes;
        broadcastAll(room, { type: 'scorecard', scorecard: room.scorecard });
      } else if (msg.type === 'end-turn') {
        // Only the active slot may end its turn — kills the echo-desync class of bugs.
        if (ws.slot !== room.turn) return;
        // Don't flip during a closed hole — the next-hole transition will reset the turn.
        if (room.holeComplete) return;
        room.turn = 1 - room.turn;
        broadcastAll(room, { type: 'turn', turn: room.turn });
      } else if (msg.type === 'next-hole') {
        // Advisory — server decides when to advance. Trigger when both players have
        // submitted hole-complete for the current hole. The active player's client
        // typically sends this after their settle; the spectator may also send it once
        // they receive the scorecard broadcast — either path is safe (idempotent).
        if (room.holeComplete) return; // already advanced this beat
        const bothDone = room.holeStrokes[0] != null && room.holeStrokes[1] != null;
        if (!bothDone) return;
        room.holeComplete = true;
        if (room.hole + 1 >= GOLF_HOLE_COUNT) {
          // No more holes possible — but clients drive end-of-match based on their course
          // length, so we just leave the room in a 'holeComplete' state.
        }
        room.hole += 1;
        room.holeStrokes = [null, null];
        room.holeComplete = false;
        room.turn = 0;
        broadcastAll(room, { type: 'next-hole', hole: room.hole, turn: 0 });
        broadcastAll(room, golfState(room));
      } else if (msg.type === 'match-complete') {
        // Either client may declare end-of-course (their local course length defines it).
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
    room.players = room.players.filter((p) => p !== ws);
    broadcast(room, { type: 'opponent-left' });
    if (room.players.length === 0) rooms.delete(room.key);
  });
});

server.listen(PORT, () => {
  if (SERVE_STATIC) console.log(`http://localhost:${PORT}  (serving dist/ + WS)`);
  else console.log(`ws://localhost:${PORT}  (dev WS only — Vite serves the client)`);
});
