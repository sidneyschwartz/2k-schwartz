// Golf multiplayer transport. Wraps the WS server's server-authoritative golf
// protocol and exposes a small controller-shaped API.
//
// =============================================================================
// PROTOCOL
// =============================================================================
//
// Direction key: `c→s` = client to server. `s→c` = server to client (broadcast
// unless noted). The server is the single source of truth for: room registry,
// slot assignment, current hole index, whose turn it is, per-player scorecard,
// and match-complete state. Clients render off these broadcasts and never write
// to their own slot's scorecard except via `hole-complete`.
//
// --- Lobby ---
//   c→s  { type: 'join', sport: 'golf', code, character? }
//   s→c  { type: 'joined', slot: 0|1, code, sport }     (this client only)
//   s→c  { type: 'start' }                              (both, once 2 players)
//   s→c  { type: 'state', turn, hole, scorecard, holeComplete, matchComplete }
//                                                       (sync snapshot, on join + transitions)
//
// --- In-round ---
//   c→s  { type: 'shot', shot: { club, power, accuracy, aim, startPos } }
//   s→c  { type: 'shot', slot, club, power, accuracy, aim, startPos } (forwarded to peer)
//
//   c→s  { type: 'shot-result', result: { endPos: [x,y,z], strokes } }
//   s→c  { type: 'shot-result', slot, endPos, strokes }   (forwarded to peer;
//                                                          slot is server-bound, not client-set)
//
//   c→s  { type: 'hole-complete', strokes }
//   s→c  { type: 'scorecard', scorecard: [[h1,h2,...], [h1,h2,...]] }
//
//   c→s  { type: 'end-turn' }                — server flips room.turn if sender is active
//   s→c  { type: 'turn', turn: 0|1 }
//
//   c→s  { type: 'next-hole' }               — advisory; server advances when both slots have
//                                              submitted hole-complete for the current hole
//   s→c  { type: 'next-hole', hole, turn }
//
//   c→s  { type: 'match-complete' }
//   s→c  { type: 'match-complete', scorecard }
//
//   s→c  { type: 'opponent-left' }
//   s→c  { type: 'error', error }
//
// =============================================================================
// connectGolf({ code, character, onEvent }) -> {
//   sendShot, sendShotResult, sendHoleComplete, endTurn, nextHole,
//   sendMatchComplete, close, slot
// }
//
// Events surfaced via onEvent({ type, ...payload }):
//   'joined' | 'start' | 'state' | 'turn'
//   'opponent-shot' | 'opponent-shot-result'
//   'scorecard' | 'next-hole' | 'match-complete'
//   'opponent-left' | 'error' | 'closed'

export function connectGolf({ code, character, onEvent } = {}) {
  if (!code) throw new Error('connectGolf: code is required');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const host = import.meta.env.DEV ? `${location.hostname}:3001` : location.host;
  const ws = new WebSocket(`${proto}://${host}`);

  let slot = null;
  let closed = false;

  function emit(e) { try { onEvent?.(e); } catch (err) { console.error(err); } }
  function send(obj) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  ws.addEventListener('open', () => {
    send({ type: 'join', sport: 'golf', code, character: character?.id || null });
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'joined') {
      slot = msg.slot;
      emit({ type: 'joined', slot: msg.slot, code: msg.code });
    } else if (msg.type === 'start') {
      emit({ type: 'start' });
    } else if (msg.type === 'state') {
      emit({
        type: 'state',
        turn: msg.turn,
        hole: msg.hole,
        scorecard: msg.scorecard,
        holeComplete: msg.holeComplete,
        matchComplete: msg.matchComplete,
      });
    } else if (msg.type === 'shot') {
      emit({
        type: 'opponent-shot',
        slot: msg.slot,
        club: msg.club, power: msg.power, accuracy: msg.accuracy,
        aim: msg.aim, startPos: msg.startPos,
      });
    } else if (msg.type === 'shot-result') {
      emit({
        type: 'opponent-shot-result',
        slot: msg.slot,
        endPos: msg.endPos,
        strokes: msg.strokes,
      });
    } else if (msg.type === 'scorecard') {
      emit({ type: 'scorecard', scorecard: msg.scorecard });
    } else if (msg.type === 'turn') {
      emit({ type: 'turn', turn: msg.turn });
    } else if (msg.type === 'next-hole') {
      emit({ type: 'next-hole', hole: msg.hole, turn: msg.turn });
    } else if (msg.type === 'match-complete') {
      emit({ type: 'match-complete', scorecard: msg.scorecard });
    } else if (msg.type === 'opponent-left') {
      emit({ type: 'opponent-left' });
    } else if (msg.type === 'error') {
      emit({ type: 'error', error: msg.error });
    }
  });
  ws.addEventListener('close', () => {
    if (closed) return;
    closed = true;
    emit({ type: 'closed' });
  });
  ws.addEventListener('error', () => {
    emit({ type: 'error', error: 'connection error' });
  });

  return {
    get slot() { return slot; },
    sendShot(shot) {
      // shot: { club: name, power, accuracy, aim, startPos: [x,y,z] }
      send({ type: 'shot', shot });
    },
    sendShotResult(result) {
      // result: { endPos: [x,y,z], strokes }
      send({ type: 'shot-result', result });
    },
    sendHoleComplete(strokes) {
      send({ type: 'hole-complete', strokes });
    },
    endTurn() { send({ type: 'end-turn' }); },
    nextHole() { send({ type: 'next-hole' }); },
    sendMatchComplete() { send({ type: 'match-complete' }); },
    close() {
      if (closed) return;
      closed = true;
      try { ws.close(); } catch {}
    },
  };
}
