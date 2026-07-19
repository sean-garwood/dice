/*
 * Pure game engine for online Ten Thousand rooms. No I/O, no transport:
 * the Room Durable Object (room.js) feeds it messages and persists/broadcasts
 * whatever comes back. All game-rule decisions live here.
 *
 * Rules are reused from js/logic.js (UMD/CommonJS — default import gives
 * module.exports) and the turn semantics mirror js/app.js exactly.
 * See docs/PROTOCOL.md for the binding contract.
 */
import L from '../../js/logic.js';

const TARGET = L.TARGET; // 10000
const MAX_PLAYERS = 8;
const MAX_LOG = 50;
const MAX_NAME = 20;

function fmt(n) {
  return n.toLocaleString('en-US');
}

export function createRoomState(roomCode) {
  return {
    phase: 'lobby', // 'lobby' | 'playing' | 'ended'
    roomCode,
    hostId: null,
    players: [], // { id, name, score, connected }
    current: 0,
    round: 1,
    turn: null, // { points, kept, dice, diceCount, phase: 'preroll'|'rolled' }
    banner: null, // { type, title, emoji, text }
    winner: null, // player index
    log: [], // newest first, max 50
  };
}

/*
 * Apply one client message to the room state.
 * Returns { state, error }. On success `state` is a new object (the input is
 * never mutated) and `error` is null; on failure `state` is the untouched
 * input and `error` is { code, message }. Randomness is injected via
 * rollDie() so callers/tests control it.
 */
export function applyAction(state, playerId, msg, rollDie) {
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
    return { state, error: err('bad-message', 'Message must be a JSON object with a "type" field.') };
  }
  const next = structuredClone(state);
  const error = dispatch(next, playerId, msg, rollDie);
  if (error) return { state, error };
  return { state: next, error: null };
}

/*
 * A player's last socket went away. Returns { state, changed }.
 * In the lobby, non-host players are removed; otherwise (or for the host)
 * the player is only marked disconnected. Never mutates the input.
 */
export function applyDisconnect(state, playerId) {
  const idx = state.players.findIndex((p) => p.id === playerId);
  if (idx === -1) return { state, changed: false };
  const next = structuredClone(state);
  const p = next.players[idx];
  if (next.phase === 'lobby' && playerId !== next.hostId) {
    next.players.splice(idx, 1);
    log(next, `${p.name} left.`);
  } else {
    if (!p.connected) return { state, changed: false };
    p.connected = false;
    log(next, `${p.name} disconnected.`);
  }
  return { state: next, changed: true };
}

/* ---------- internals (mutate the cloned state) ---------- */

function err(code, message) {
  return { code, message };
}

function log(state, msg) {
  state.log.unshift(msg);
  if (state.log.length > MAX_LOG) state.log.length = MAX_LOG;
}

function freshTurn() {
  return { points: 0, kept: [], dice: [], diceCount: 5, phase: 'preroll' };
}

function currentPlayer(state) {
  return state.players[state.current];
}

function nextTurn(state) {
  state.banner = null;
  state.current = (state.current + 1) % state.players.length;
  if (state.current === 0) state.round++;
  state.turn = freshTurn();
}

function dispatch(state, playerId, msg, rollDie) {
  switch (msg.type) {
    case 'join':
      return doJoin(state, playerId, msg);
    case 'start':
      return doStart(state, playerId);
    case 'roll': {
      const e = requireTurn(state, playerId, 'preroll');
      if (e) return e;
      doRoll(state, rollDie);
      return null;
    }
    case 'keepAndRoll':
      return doKeepAndRoll(state, playerId, msg, rollDie);
    case 'bank':
      return doBank(state, playerId, msg);
    case 'continue':
      return doContinue(state, playerId);
    case 'newGame':
      return doNewGame(state, playerId);
    default:
      return err('bad-message', `Unknown message type "${msg.type}".`);
  }
}

function doJoin(state, playerId, msg) {
  if (typeof playerId !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(playerId)) {
    return err('bad-message', 'join requires a valid "playerId".');
  }
  const existing = state.players.find((p) => p.id === playerId);
  if (existing) {
    // Reconnect: reclaim the seat. Allowed in any phase.
    if (!existing.connected) {
      existing.connected = true;
      log(state, `${existing.name} reconnected.`);
    }
    return null;
  }
  if (state.phase !== 'lobby') {
    return err('game-in-progress', 'A game is in progress — new players can only join in the lobby.');
  }
  if (state.players.length >= MAX_PLAYERS) {
    return err('room-full', `This room already has ${MAX_PLAYERS} players.`);
  }
  const name = typeof msg.name === 'string' ? msg.name.trim() : '';
  if (name.length < 1 || name.length > MAX_NAME) {
    return err('bad-message', `Name must be 1–${MAX_NAME} characters.`);
  }
  if (state.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    return err('name-taken', `The name "${name}" is already taken in this room.`);
  }
  state.players.push({ id: playerId, name, score: 0, connected: true });
  if (!state.hostId) state.hostId = playerId;
  log(state, `${name} joined.`);
  return null;
}

function doStart(state, playerId) {
  if (playerId !== state.hostId) return err('not-host', 'Only the host can start the game.');
  if (state.phase !== 'lobby') return err('bad-phase', 'The game has already started.');
  if (state.players.length < 2) return err('need-players', 'Need at least 2 players to start.');
  state.phase = 'playing';
  state.current = 0;
  state.round = 1;
  state.winner = null;
  state.banner = null;
  state.turn = freshTurn();
  log(state, `New game: ${state.players.map((p) => p.name).join(', ')}. First to exactly ${fmt(TARGET)} wins!`);
  return null;
}

/* Guard shared by roll/keepAndRoll/bank. Returns an error or null. */
function requireTurn(state, playerId, turnPhase) {
  if (state.phase !== 'playing') return err('bad-phase', 'The game is not in progress.');
  const p = currentPlayer(state);
  if (p.id !== playerId) return err('not-your-turn', `It's ${p.name}'s turn.`);
  if (state.banner) return err('bad-phase', 'A banner is showing — send "continue" first.');
  if (state.turn.phase !== turnPhase) {
    return err('bad-phase', turnPhase === 'preroll' ? 'You already rolled — keep dice or bank.' : 'Roll first.');
  }
  return null;
}

function doRoll(state, rollDie) {
  const t = state.turn;
  t.dice = Array.from({ length: t.diceCount }, () => rollDie());
  t.phase = 'rolled';
  if (!L.hasAnyScore(t.dice)) {
    const p = currentPlayer(state);
    log(state, `${p.name} rolled ${t.dice.join(' ')} — farkle! ${fmt(t.points)} points lost.`);
    state.banner = {
      type: 'farkle',
      title: 'Farkle!',
      emoji: '💥',
      text: `${p.name} rolled ${t.dice.join(' · ')} — nothing scores. ${
        t.points > 0 ? `${fmt(t.points)} points on the table blow up.` : 'The turn is over.'
      }`,
    };
  }
}

/*
 * Validate and apply keeping the dice at keptIdx. Mirrors app.js applyKeep().
 * Returns { points, hot } on success, { error } on failure.
 */
function applyKeep(state, keptIdx) {
  const t = state.turn;
  if (!Array.isArray(keptIdx) || keptIdx.some((i) => !Number.isInteger(i))) {
    return { error: err('bad-message', '"keptIdx" must be an array of dice indices.') };
  }
  const seen = new Set();
  for (const i of keptIdx) {
    if (i < 0 || i >= t.dice.length || seen.has(i)) {
      return { error: err('invalid-keep', 'keptIdx contains an out-of-range or duplicate die index.') };
    }
    seen.add(i);
  }
  const res = L.validateKeep(t.dice, keptIdx);
  if (!res.valid) return { error: err('invalid-keep', res.reason) };
  t.points += res.points;
  t.kept.push(...keptIdx.map((i) => t.dice[i]));
  const remaining = t.dice.length - keptIdx.length;
  const hot = remaining === 0;
  t.diceCount = hot ? 5 : remaining;
  t.dice = [];
  t.phase = 'preroll';
  return { points: res.points, hot };
}

function bust(state) {
  const p = currentPlayer(state);
  const total = p.score + state.turn.points;
  log(state, `${p.name} busted at ${fmt(total)} — over ${fmt(TARGET)}! Turn points lost.`);
  state.banner = {
    type: 'bust',
    title: 'Bust!',
    emoji: '🚫',
    text: `${p.name} went over ${fmt(TARGET)} (${fmt(total)}). The turn ends and all points on the table are lost. You need exactly ${fmt(TARGET)}!`,
  };
}

function doKeepAndRoll(state, playerId, msg, rollDie) {
  const e = requireTurn(state, playerId, 'rolled');
  if (e) return e;
  const kept = applyKeep(state, msg.keptIdx);
  if (kept.error) return kept.error;
  const p = currentPlayer(state);
  if (p.score + state.turn.points > TARGET) {
    bust(state);
    return null;
  }
  if (kept.hot) log(state, `${p.name} — hot dice! All five scored; rolling all five again.`);
  doRoll(state, rollDie);
  return null;
}

function doBank(state, playerId, msg) {
  const e = requireTurn(state, playerId, 'rolled');
  if (e) return e;
  const kept = applyKeep(state, msg.keptIdx);
  if (kept.error) return kept.error;
  const p = currentPlayer(state);
  const bankCheck = L.canBank(p.score, state.turn.points);
  if (!bankCheck.valid) {
    // Not an error: the keep stands and the turn continues for this player.
    state.banner = {
      type: 'invalid-bank',
      title: 'Cannot bank yet',
      emoji: '⏸️',
      text: bankCheck.reason,
    };
    return null;
  }
  const total = p.score + state.turn.points;
  if (total > TARGET) {
    bust(state);
    return null;
  }
  const banked = state.turn.points;
  p.score = total;
  if (total === TARGET) {
    state.winner = state.current;
    state.phase = 'ended';
    log(state, `${p.name} banked ${fmt(banked)} to land on exactly ${fmt(TARGET)} — WINNER!`);
    state.banner = {
      type: 'win',
      title: `${p.name} wins!`,
      emoji: '🏆',
      text: `Exactly ${fmt(TARGET)} points in ${state.round} round${state.round === 1 ? '' : 's'}. What a game!`,
    };
    return null;
  }
  log(state, `${p.name} banked ${fmt(banked)} (total ${fmt(total)}, needs ${fmt(TARGET - total)}).`);
  nextTurn(state);
  return null;
}

function doContinue(state, playerId) {
  if (!state.banner) return err('bad-phase', 'Nothing to continue — no banner is showing.');
  const isHost = playerId === state.hostId;
  const isCurrent = currentPlayer(state) && currentPlayer(state).id === playerId;
  if (!isHost && !isCurrent) {
    return err('not-your-turn', 'Only the current player or the host can continue.');
  }
  const type = state.banner.type;
  state.banner = null;
  if (type === 'farkle' || type === 'bust') {
    nextTurn(state);
  }
  // 'invalid-bank': turn continues for the same player (phase stays preroll).
  // 'win': banner dismissed; game stays ended until the host sends newGame.
  return null;
}

function doNewGame(state, playerId) {
  if (playerId !== state.hostId) return err('not-host', 'Only the host can start a new game.');
  if (state.phase !== 'ended') return err('bad-phase', 'A new game can only be started after a game ends.');
  for (const p of state.players) p.score = 0;
  state.phase = 'lobby';
  state.turn = null;
  state.winner = null;
  state.banner = null;
  state.current = 0;
  state.round = 1;
  log(state, 'Back to the lobby — scores reset. The host can start a new game.');
  return null;
}
