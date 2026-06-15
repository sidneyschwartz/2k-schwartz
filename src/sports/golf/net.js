// Golf multiplayer transport. Wraps the WS server's server-authoritative golf
// protocol, with auto-reconnect, slot reclaim, and a connection-status callback.
//
// =============================================================================
// PROTOCOL
// =============================================================================
//
// Direction key: `c→s` = client to server. `s→c` = server to client (broadcast
// unless noted). The server is the single source of truth for: room registry,
// slot assignment, current hole index, whose turn it is, per-player scorecard,
// and match-complete state.
//
// --- Lobby ---
//   c→s  { type: 'join', sport: 'golf', code, clientId, character? }
//   s→c  { type: 'joined', slot: 0|1, code, sport, reclaimed?: bool }
//   s→c  { type: 'start' }                              (first time both slots are live)
//   s→c  { type: 'opponent-rejoined' }                  (peer reconnected mid-match)
//   s→c  { type: 'state', turn, hole, scorecard, holeComplete, matchComplete }
//
// --- In-round ---
//   c→s  { type: 'shot', shot: { club, power, accuracy, aim, startPos } }
//   s→c  { type: 'shot', slot, club, power, accuracy, aim, startPos }
//
//   c→s  { type: 'shot-result', result: { endPos: [x,y,z], strokes } }
//   s→c  { type: 'shot-result', slot, endPos, strokes }
//
//   c→s  { type: 'hole-complete', strokes }
//   s→c  { type: 'scorecard', scorecard: [[h1,h2,...], [h1,h2,...]] }
//
//   c→s  { type: 'end-turn' }
//   s→c  { type: 'turn', turn: 0|1 }
//
//   c→s  { type: 'next-hole' }                          (advisory)
//   s→c  { type: 'next-hole', hole, turn }
//
//   c→s  { type: 'match-complete' }
//   s→c  { type: 'match-complete', scorecard }
//
//   c→s  { type: 'ping', t }                            (keepalive; server replies 'pong')
//   s→c  { type: 'pong', t }
//
//   s→c  { type: 'opponent-left' }
//   s→c  { type: 'error', error }
//
// =============================================================================
// connectGolf({ code, character, onEvent, onStatus }) -> {
//   sendShot, sendShotResult, sendHoleComplete, endTurn, nextHole,
//   sendMatchComplete, close, slot, status
// }
//
// onStatus(status: 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'waking')
//   - 'connecting' — first WebSocket open in flight
//   - 'connected'  — open AND join acknowledged
//   - 'waking'     — first connect is taking unusually long (likely Render cold-start)
//   - 'reconnecting' — drop happened; we're trying to come back
//   - 'disconnected' — we've given up (close() was called, or too many retries)
//
// Events surfaced via onEvent({ type, ...payload }):
//   'joined' | 'start' | 'opponent-rejoined' | 'state' | 'turn'
//   'opponent-shot' | 'opponent-shot-result'
//   'scorecard' | 'next-hole' | 'match-complete'
//   'opponent-left' | 'error' | 'closed'

const CLIENT_ID_KEY = '2kschwartz-clientId';
const RECONNECT_DELAYS = [250, 500, 1000, 2000, 5000]; // ms, capped at 5s
const COLD_START_TIMEOUT_MS = 4000;                    // mark 'waking' if first open takes >4s
const APP_PING_INTERVAL_MS = 15_000;                   // client-side keepalive
const APP_PING_TIMEOUT_MS = 30_000;                    // no server traffic for this long → reconnect

function genClientId() {
  // Browser crypto.randomUUID where available; otherwise a fallback.
  try { return crypto.randomUUID(); } catch {}
  return 'c-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function getOrCreateClientId() {
  try {
    let id = sessionStorage.getItem(CLIENT_ID_KEY);
    if (!id) {
      id = genClientId();
      sessionStorage.setItem(CLIENT_ID_KEY, id);
    }
    return id;
  } catch {
    return genClientId();
  }
}

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const host = import.meta.env?.DEV ? `${location.hostname}:3001` : location.host;
  return `${proto}://${host}`;
}

export function connectGolf({ code, character, onEvent, onStatus } = {}) {
  if (!code) throw new Error('connectGolf: code is required');

  const clientId = getOrCreateClientId();

  let ws = null;
  let slot = null;
  let stopped = false;
  let attempt = 0;
  let status = 'connecting';
  let openWatchdog = null;
  let lastServerMessageAt = 0;
  let appPingTimer = null;
  let firstOpenSeen = false;
  let joinedOnce = false;

  function emit(e) { try { onEvent?.(e); } catch (err) { console.error(err); } }
  function setStatus(s) {
    if (s === status) return;
    status = s;
    try { onStatus?.(s); } catch (err) { console.error(err); }
  }
  function sendRaw(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function clearTimers() {
    if (openWatchdog) { clearTimeout(openWatchdog); openWatchdog = null; }
    if (appPingTimer) { clearInterval(appPingTimer); appPingTimer = null; }
  }

  function scheduleReconnect() {
    if (stopped) return;
    setStatus('reconnecting');
    const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
    attempt += 1;
    setTimeout(open, delay);
  }

  function open() {
    if (stopped) return;
    clearTimers();
    setStatus(firstOpenSeen ? 'reconnecting' : 'connecting');

    // If the first open is slow (Render cold start), surface 'waking' so the UI can show
    // a friendlier message. The status flips to 'connected' as soon as the join is acked.
    if (!firstOpenSeen) {
      openWatchdog = setTimeout(() => {
        if (!firstOpenSeen && !stopped) setStatus('waking');
      }, COLD_START_TIMEOUT_MS);
    }

    try {
      ws = new WebSocket(wsUrl());
    } catch (err) {
      console.warn('[golf-net] ws construct failed', err);
      scheduleReconnect();
      return;
    }

    ws.addEventListener('open', () => {
      firstOpenSeen = true;
      attempt = 0;
      if (openWatchdog) { clearTimeout(openWatchdog); openWatchdog = null; }
      sendRaw({ type: 'join', sport: 'golf', code, clientId, character: character?.id || null });
      lastServerMessageAt = Date.now();
      appPingTimer = setInterval(() => {
        // Re-open if we haven't heard anything from the server in a long time, even though
        // the underlying ws claims to be open (intermediaries can silently wedge).
        if (Date.now() - lastServerMessageAt > APP_PING_TIMEOUT_MS) {
          try { ws.close(); } catch {}
          return;
        }
        sendRaw({ type: 'ping', t: Date.now() });
      }, APP_PING_INTERVAL_MS);
    });

    ws.addEventListener('message', (ev) => {
      lastServerMessageAt = Date.now();
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      // Internal: app-level pong; don't surface.
      if (msg.type === 'pong') return;

      if (msg.type === 'joined') {
        slot = msg.slot;
        joinedOnce = true;
        setStatus('connected');
        emit({ type: 'joined', slot: msg.slot, code: msg.code, reclaimed: !!msg.reclaimed });
      } else if (msg.type === 'start') {
        emit({ type: 'start' });
      } else if (msg.type === 'opponent-rejoined') {
        emit({ type: 'opponent-rejoined' });
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
        emit({ type: 'opponent-shot-result', slot: msg.slot, endPos: msg.endPos, strokes: msg.strokes });
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
      clearTimers();
      ws = null;
      if (stopped) {
        setStatus('disconnected');
        emit({ type: 'closed' });
        return;
      }
      // Auto-reconnect.
      scheduleReconnect();
      emit({ type: 'closed' });
    });

    ws.addEventListener('error', () => {
      // Don't surface every error as a fatal — the close handler will run next.
      // Just hint the consumer something's up.
      emit({ type: 'error', error: 'connection error' });
    });
  }

  open();

  // If the user puts the tab back in the foreground, try to reconnect more eagerly.
  function onVisibility() {
    if (document.visibilityState === 'visible' && (!ws || ws.readyState !== 1) && !stopped) {
      attempt = 0;
      open();
    }
  }
  document.addEventListener?.('visibilitychange', onVisibility);

  return {
    get slot() { return slot; },
    get status() { return status; },
    sendShot(shot)        { sendRaw({ type: 'shot', shot }); },
    sendShotResult(result){ sendRaw({ type: 'shot-result', result }); },
    sendHoleComplete(s)   { sendRaw({ type: 'hole-complete', strokes: s }); },
    endTurn()             { sendRaw({ type: 'end-turn' }); },
    nextHole()            { sendRaw({ type: 'next-hole' }); },
    sendMatchComplete()   { sendRaw({ type: 'match-complete' }); },
    close() {
      stopped = true;
      clearTimers();
      document.removeEventListener?.('visibilitychange', onVisibility);
      try { ws?.close(); } catch {}
      ws = null;
      setStatus('disconnected');
    },
  };
}
