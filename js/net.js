/*
 * Ten Thousand — WebSocket client for online play.
 * Plain script (no modules). Exposes window.DiceNet.
 *
 * Protocol: see docs/PROTOCOL.md (this file is written strictly against it).
 * No DOM assumptions beyond `window`/`localStorage`/`crypto`/`WebSocket` —
 * js/app.js owns all rendering and wires callbacks onto DiceNet.
 */
(function () {
  'use strict';

  const IDENTITY_KEY = 'dice10k.online.v1';
  const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const MAX_BACKOFF_MS = 15000;

  /* ---------- identity storage: { [roomCode]: { playerId, name } } ---------- */

  function loadIdentityStore() {
    try {
      const raw = localStorage.getItem(IDENTITY_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function saveIdentityStore(store) {
    try {
      localStorage.setItem(IDENTITY_KEY, JSON.stringify(store));
    } catch {
      /* storage full/unavailable — connection still works, just won't persist identity */
    }
  }

  function loadIdentity(roomCode) {
    const store = loadIdentityStore();
    return store[roomCode] || null;
  }

  function saveIdentity(roomCode, identity) {
    const store = loadIdentityStore();
    store[roomCode] = identity;
    saveIdentityStore(store);
  }

  /* ---------- id / code generation ---------- */

  function randomHex(byteLen) {
    const bytes = new Uint8Array(byteLen);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function generatePlayerId() {
    return randomHex(8); // 16 hex chars
  }

  function generateRoomCode() {
    const bytes = new Uint8Array(4);
    crypto.getRandomValues(bytes);
    let code = '';
    for (let i = 0; i < 4; i++) {
      code += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
    }
    return code;
  }

  /* ---------- connection state ---------- */

  let ws = null;
  let serverUrl = null;
  let roomCode = null;
  let identity = null; // { playerId, name }
  let explicitLeave = false;
  let reconnectAttempts = 0;
  let reconnectTimer = null;

  const DiceNet = {
    onJoined: null, // fn({type:'joined', playerId, roomCode, youAreHost})
    onState: null, // fn(RoomState)
    onError: null, // fn({type:'error', code, message})
    onConnectionChange: null, // fn(status: 'connecting'|'open'|'reconnecting'|'closed')

    generateRoomCode,

    getIdentity(code) {
      return loadIdentity(String(code || '').toUpperCase());
    },

    connect(url, code, name) {
      explicitLeave = false;
      clearReconnectTimer();
      reconnectAttempts = 0;

      serverUrl = url;
      roomCode = String(code || '').toUpperCase();

      let stored = loadIdentity(roomCode);
      if (!stored) {
        stored = { playerId: generatePlayerId(), name: (name && name.trim()) || 'Player' };
      } else if (name && name.trim()) {
        stored = { playerId: stored.playerId, name: name.trim() };
      }
      identity = stored;
      saveIdentity(roomCode, identity);

      openSocket();
    },

    sendAction(obj) {
      sendRaw(obj);
    },

    leave() {
      explicitLeave = true;
      clearReconnectTimer();
      reconnectAttempts = 0;
      if (ws) {
        try {
          ws.close();
        } catch {
          /* already closing/closed */
        }
        ws = null;
      }
      setStatus('closed');
    },
  };

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function setStatus(status) {
    if (typeof DiceNet.onConnectionChange === 'function') {
      DiceNet.onConnectionChange(status);
    }
  }

  function sendRaw(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  function openSocket() {
    setStatus(reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

    const url = `${serverUrl}/room/${roomCode}/ws`;
    let socket;
    try {
      socket = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    ws = socket;

    socket.addEventListener('open', () => {
      reconnectAttempts = 0;
      sendRaw({ type: 'join', name: identity.name, playerId: identity.playerId });
      setStatus('open');
    });

    socket.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      handleMessage(msg);
    });

    socket.addEventListener('close', () => {
      if (ws === socket) ws = null;
      if (explicitLeave) {
        setStatus('closed');
        return;
      }
      scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      /* 'close' always follows 'error' for WebSocket — reconnect handled there */
    });
  }

  function scheduleReconnect() {
    if (explicitLeave) return;
    setStatus('reconnecting');
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, reconnectAttempts));
    reconnectAttempts++;
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
      if (explicitLeave) return;
      openSocket();
    }, delay);
  }

  function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'joined':
        if (typeof DiceNet.onJoined === 'function') DiceNet.onJoined(msg);
        break;
      case 'state':
        if (typeof DiceNet.onState === 'function') DiceNet.onState(msg.state);
        break;
      case 'error':
        if (typeof DiceNet.onError === 'function') DiceNet.onError(msg);
        break;
      default:
        break;
    }
  }

  window.DiceNet = DiceNet;
})();
