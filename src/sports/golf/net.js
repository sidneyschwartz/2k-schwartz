// Golf multiplayer transport. Wraps the WS server's golf protocol and exposes
// a small controller-shaped API. The server is authoritative for whose turn it is.
//
// connectGolf({ code, character, onEvent }) -> {
//   sendShot(shot), sendShotResult(result), sendHoleComplete(strokes),
//   endTurn(), nextHole(), close()
// }
//
// Events emitted via onEvent({ type, ...payload }):
//   { type: 'joined', slot, code }
//   { type: 'start' }
//   { type: 'turn', turn }                 // server announces whose turn it is (slot index)
//   { type: 'opponent-shot', slot, club, power, accuracy, aim, startPos }
//   { type: 'opponent-shot-result', slot, endPos, strokes }
//   { type: 'scorecard', scorecard }
//   { type: 'next-hole', hole, turn }
//   { type: 'opponent-left' }
//   { type: 'error', error }
//   { type: 'closed' }

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
    } else if (msg.type === 'shot') {
      // server forwards opponent intent (server already filtered out own echo)
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
    close() {
      if (closed) return;
      closed = true;
      try { ws.close(); } catch {}
    },
  };
}
