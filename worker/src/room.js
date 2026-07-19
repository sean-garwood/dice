/*
 * Room Durable Object — one instance per room code (idFromName).
 * Transport, persistence, and identity only; every game-rule decision is
 * delegated to the pure engine (engine.js). Uses the WebSocket Hibernation
 * API so idle rooms cost nothing, and serializeAttachment so wake-ups can
 * map sockets back to players. See docs/PROTOCOL.md.
 */
import { createRoomState, applyAction, applyDisconnect } from './engine.js';

const JSON_HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
};

function rollDie() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return (buf[0] % 6) + 1;
}

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    // In-memory cache of the persisted room state.
    // undefined = not loaded yet; null = nothing in storage.
    this.roomState = undefined;
  }

  /* Lazy-load state from storage; create it on first use if roomCode known. */
  async getState(roomCode) {
    if (this.roomState === undefined) {
      this.roomState = (await this.ctx.storage.get('state')) ?? null;
    }
    if (this.roomState === null && roomCode) {
      this.roomState = createRoomState(roomCode);
      await this.ctx.storage.put('state', this.roomState);
    }
    return this.roomState;
  }

  /* Persist after every accepted change. */
  async setState(state) {
    this.roomState = state;
    await this.ctx.storage.put('state', state);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9]{4,8})\/ws$/i);
    if (!m) {
      return new Response(JSON.stringify({ error: 'not-found' }), { status: 404, headers: JSON_HEADERS });
    }
    if ((request.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return new Response(JSON.stringify({ error: 'upgrade-required', message: 'This endpoint expects a WebSocket upgrade.' }), {
        status: 426,
        headers: JSON_HEADERS,
      });
    }
    await this.getState(m[1].toUpperCase());

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string') {
      return this.sendError(ws, 'bad-message', 'Expected a JSON text frame.');
    }
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return this.sendError(ws, 'bad-message', 'Invalid JSON.');
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      return this.sendError(ws, 'bad-message', 'Message must be a JSON object with a "type" field.');
    }

    const state = await this.getState();
    if (!state) {
      return this.sendError(ws, 'bad-message', 'Room is not initialized.');
    }

    if (msg.type === 'join') {
      const playerId = msg.playerId;
      const { state: next, error } = applyAction(state, playerId, msg, rollDie);
      if (error) return this.sendError(ws, error.code, error.message);
      // Attach the identity so wake-from-hibernation still maps this socket.
      ws.serializeAttachment({ playerId });
      await this.setState(next);
      this.send(ws, {
        type: 'joined',
        playerId,
        roomCode: next.roomCode,
        youAreHost: next.hostId === playerId,
      });
      this.broadcast(next);
      return;
    }

    const attachment = this.attachmentOf(ws);
    if (!attachment || !attachment.playerId) {
      return this.sendError(ws, 'bad-message', 'Send a "join" message first.');
    }
    const { state: next, error } = applyAction(state, attachment.playerId, msg, rollDie);
    if (error) return this.sendError(ws, error.code, error.message);
    await this.setState(next);
    this.broadcast(next);
  }

  async webSocketClose(ws, _code, _reason, _wasClean) {
    await this.socketGone(ws);
  }

  async webSocketError(ws, _error) {
    await this.socketGone(ws);
    try {
      ws.close(1011, 'error');
    } catch {
      /* already closed */
    }
  }

  /* Mark/remove the player if this was their last open socket. */
  async socketGone(ws) {
    const attachment = this.attachmentOf(ws);
    const playerId = attachment && attachment.playerId;
    if (!playerId) return;
    const stillConnected = this.ctx
      .getWebSockets()
      .some((s) => s !== ws && (this.attachmentOf(s) || {}).playerId === playerId);
    if (stillConnected) return;
    const state = await this.getState();
    if (!state) return;
    const { state: next, changed } = applyDisconnect(state, playerId);
    if (!changed) return;
    await this.setState(next);
    this.broadcast(next);
  }

  attachmentOf(ws) {
    try {
      return ws.deserializeAttachment();
    } catch {
      return null;
    }
  }

  broadcast(state) {
    const frame = JSON.stringify({ type: 'state', state });
    for (const s of this.ctx.getWebSockets()) {
      try {
        s.send(frame);
      } catch {
        /* socket is closing; its close handler will clean up */
      }
    }
  }

  send(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* socket is closing */
    }
  }

  sendError(ws, code, message) {
    this.send(ws, { type: 'error', code, message });
  }
}
