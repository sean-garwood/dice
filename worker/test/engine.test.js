/*
 * node:test suite for the pure game engine (worker/src/engine.js).
 * Dice are stubbed via the injected rollDie so every scenario is deterministic.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoomState, applyAction, applyDisconnect } from '../src/engine.js';

const noRoll = () => {
  throw new Error('rollDie called when no roll was expected');
};

/* rollDie stub fed from a fixed queue of values. */
function rigged(...values) {
  const q = [...values];
  return () => {
    if (q.length === 0) throw new Error('rollDie called more times than the test rigged');
    return q.shift();
  };
}

function pid(n) {
  return `${n}`.repeat(16).slice(0, 16); // e.g. pid('a') = 'aaaaaaaaaaaaaaaa'
}

const A = pid('a'); // Alice — host
const B = pid('b'); // Bob

/* Join players into a fresh room; asserts each join is accepted. */
function setup(names = ['Alice', 'Bob'], ids = [A, B]) {
  let state = createRoomState('TEST');
  names.forEach((name, i) => {
    const r = applyAction(state, ids[i], { type: 'join', name, playerId: ids[i] }, noRoll);
    assert.equal(r.error, null, `join ${name} should succeed`);
    state = r.state;
  });
  return state;
}

function started(names, ids) {
  let state = setup(names, ids);
  const r = applyAction(state, A, { type: 'start' }, noRoll);
  assert.equal(r.error, null, 'start should succeed');
  return r.state;
}

/* Convenience: apply an action that must succeed. */
function ok(state, playerId, msg, rollDie = noRoll) {
  const r = applyAction(state, playerId, msg, rollDie);
  assert.equal(r.error, null, `${msg.type} should succeed, got: ${r.error && r.error.code} ${r.error && r.error.message}`);
  return r.state;
}

/* Convenience: apply an action that must fail with the given code, state untouched. */
function fails(state, playerId, msg, code, rollDie = noRoll) {
  const before = structuredClone(state);
  const r = applyAction(state, playerId, msg, rollDie);
  assert.ok(r.error, `${msg.type} should be rejected`);
  assert.equal(r.error.code, code);
  assert.deepEqual(r.state, before, 'state must be unchanged on error');
  assert.deepEqual(state, before, 'input state must not be mutated');
  return r;
}

test('createRoomState shape matches the protocol', () => {
  const s = createRoomState('ABCD');
  assert.deepEqual(s, {
    phase: 'lobby',
    roomCode: 'ABCD',
    hostId: null,
    players: [],
    current: 0,
    round: 1,
    turn: null,
    banner: null,
    winner: null,
    log: [],
  });
});

test('join: first player becomes host, names are trimmed', () => {
  let s = createRoomState('TEST');
  s = ok(s, A, { type: 'join', name: '  Alice  ', playerId: A });
  assert.equal(s.hostId, A);
  assert.deepEqual(s.players, [{ id: A, name: 'Alice', score: 0, connected: true }]);
  assert.match(s.log[0], /Alice joined/);
});

test('join: duplicate name rejected case-insensitively', () => {
  const s = setup(['Alice', 'Bob']);
  fails(s, pid('c'), { type: 'join', name: 'alice', playerId: pid('c') }, 'name-taken');
  fails(s, pid('c'), { type: 'join', name: ' BOB ', playerId: pid('c') }, 'name-taken');
});

test('join: bad names and bad playerId rejected as bad-message', () => {
  const s = setup(['Alice']);
  fails(s, pid('c'), { type: 'join', name: '   ', playerId: pid('c') }, 'bad-message');
  fails(s, pid('c'), { type: 'join', name: 'x'.repeat(21), playerId: pid('c') }, 'bad-message');
  fails(s, undefined, { type: 'join', name: 'Carol' }, 'bad-message');
  fails(s, 'no spaces!', { type: 'join', name: 'Carol', playerId: 'no spaces!' }, 'bad-message');
});

test('join: room full at 8 players', () => {
  const names = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'];
  const ids = ['1', '2', '3', '4', '5', '6', '7', '8'].map(pid);
  const s = setup(names, ids);
  assert.equal(s.players.length, 8);
  fails(s, pid('9'), { type: 'join', name: 'P9', playerId: pid('9') }, 'room-full');
});

test('start: host only, needs 2+ players, lobby only', () => {
  const one = setup(['Alice'], [A]);
  fails(one, A, { type: 'start' }, 'need-players');

  const two = setup(['Alice', 'Bob']);
  fails(two, B, { type: 'start' }, 'not-host');

  const s = ok(two, A, { type: 'start' });
  assert.equal(s.phase, 'playing');
  assert.equal(s.current, 0);
  assert.equal(s.round, 1);
  assert.deepEqual(s.turn, { points: 0, kept: [], dice: [], diceCount: 5, phase: 'preroll' });
  assert.equal(s.banner, null);

  fails(s, A, { type: 'start' }, 'bad-phase');
});

test('new player join blocked mid-game, reconnect by playerId allowed', () => {
  let s = started();
  fails(s, pid('c'), { type: 'join', name: 'Carol', playerId: pid('c') }, 'game-in-progress');

  // Bob drops and reclaims his seat by playerId while the game is running.
  const gone = applyDisconnect(s, B);
  assert.equal(gone.changed, true);
  s = gone.state;
  assert.deepEqual(s.players.map((p) => p.connected), [true, false]);
  assert.match(s.log[0], /Bob disconnected/);

  s = ok(s, B, { type: 'join', name: 'Ignored New Name', playerId: B });
  assert.deepEqual(s.players.map((p) => p.connected), [true, true]);
  assert.equal(s.players[1].name, 'Bob', 'reconnect keeps the original name');
  assert.match(s.log[0], /Bob reconnected/);
});

test('disconnect: lobby removes non-host, keeps host; never removes mid-game', () => {
  const lobby = setup(['Alice', 'Bob']);
  const r1 = applyDisconnect(lobby, B);
  assert.equal(r1.changed, true);
  assert.deepEqual(r1.state.players.map((p) => p.name), ['Alice']);
  assert.match(r1.state.log[0], /Bob left/);

  const r2 = applyDisconnect(lobby, A); // host stays, marked disconnected
  assert.equal(r2.changed, true);
  assert.deepEqual(r2.state.players.map((p) => p.name), ['Alice', 'Bob']);
  assert.equal(r2.state.players[0].connected, false);

  const unknown = applyDisconnect(lobby, pid('f'));
  assert.equal(unknown.changed, false);
});

test('2-player happy path: roll, keep, roll, bank; turn passes to Bob', () => {
  let s = started();

  // Alice rolls 1 5 2 3 3 — the 1 and the 5 score.
  s = ok(s, A, { type: 'roll' }, rigged(1, 5, 2, 3, 3));
  assert.equal(s.turn.phase, 'rolled');
  assert.deepEqual(s.turn.dice, [1, 5, 2, 3, 3]);
  assert.equal(s.banner, null);

  // Keep the 1 and the 5 (150), roll the remaining 3 dice: 2 2 5.
  s = ok(s, A, { type: 'keepAndRoll', keptIdx: [0, 1] }, rigged(2, 2, 5));
  assert.equal(s.turn.points, 150);
  assert.deepEqual(s.turn.kept, [1, 5]);
  assert.deepEqual(s.turn.dice, [2, 2, 5]);

  // Keep the 5 (50) and bank 200... blocked below 500 — covered elsewhere.
  // Here: keep the 5 and roll the last two dice instead: 1 1.
  s = ok(s, A, { type: 'keepAndRoll', keptIdx: [2] }, rigged(1, 1));
  assert.equal(s.turn.points, 200);
  assert.equal(s.turn.diceCount, 2);

  // Keep both 1s (200 more = 400)... still under 500, keep rolling one? No —
  // keep one 1 (100 -> 300), roll the last die: a 5.
  s = ok(s, A, { type: 'keepAndRoll', keptIdx: [0] }, rigged(5));
  assert.equal(s.turn.points, 300);
  assert.deepEqual(s.turn.dice, [5]);

  // Bank the final 5: 350... under 500! Use it to roll instead — keeping the
  // lone die is hot dice (covered elsewhere). Roll gives 1 1 1 2 6.
  s = ok(s, A, { type: 'keepAndRoll', keptIdx: [0] }, rigged(1, 1, 1, 2, 6));
  assert.equal(s.turn.points, 350);
  assert.equal(s.turn.diceCount, 5, 'hot dice: kept the last remaining die');

  // Bank the trip ones: 350 + 1000 = 1350.
  s = ok(s, A, { type: 'bank', keptIdx: [0, 1, 2] });
  assert.equal(s.players[0].score, 1350);
  assert.equal(s.players[1].score, 0);
  assert.equal(s.current, 1, 'turn passes to Bob');
  assert.equal(s.round, 1);
  assert.deepEqual(s.turn, { points: 0, kept: [], dice: [], diceCount: 5, phase: 'preroll' });
  assert.equal(s.banner, null);
  assert.match(s.log[0], /Alice banked 1,350 \(total 1,350, needs 8,650\)\./);

  // Bob banks 500 flat; wrap back to Alice bumps the round.
  s = ok(s, B, { type: 'roll' }, rigged(5, 5, 5, 2, 6));
  s = ok(s, B, { type: 'bank', keptIdx: [0, 1, 2] });
  assert.equal(s.players[1].score, 500);
  assert.equal(s.current, 0);
  assert.equal(s.round, 2, 'round increments when play wraps to player 0');
});

test('farkle: banner shows, table points lost, continue advances turn', () => {
  let s = started();
  s = ok(s, A, { type: 'roll' }, rigged(1, 5, 2, 2, 6));
  s = ok(s, A, { type: 'keepAndRoll', keptIdx: [0] }, rigged(2, 3, 4, 6)); // 100 on the table, then junk
  assert.ok(s.banner);
  assert.equal(s.banner.type, 'farkle');
  assert.equal(s.turn.points, 100);
  assert.match(s.log[0], /Alice rolled 2 3 4 6 — farkle! 100 points lost\./);
  assert.match(s.banner.text, /100 points on the table blow up/);

  // Rolling through the banner is rejected.
  fails(s, A, { type: 'roll' }, 'bad-phase');

  s = ok(s, A, { type: 'continue' });
  assert.equal(s.banner, null);
  assert.equal(s.current, 1, 'farkle continue advances to the next player');
  assert.equal(s.players[0].score, 0, 'table points were lost');
  assert.deepEqual(s.turn, { points: 0, kept: [], dice: [], diceCount: 5, phase: 'preroll' });
});

test('farkle on the opening roll: "The turn is over." text, host may continue', () => {
  let s = started();
  s = ok(s, A, { type: 'roll' }, rigged(2, 3, 4, 6, 6));
  assert.equal(s.banner.type, 'farkle');
  assert.match(s.banner.text, /The turn is over\./);

  // Bob is neither current player nor host — cannot continue.
  fails(s, B, { type: 'continue' }, 'not-your-turn');
  // Host (also current player here) continues.
  s = ok(s, A, { type: 'continue' });
  assert.equal(s.current, 1);

  // Now Bob farkles; the HOST may continue on Bob's behalf.
  s = ok(s, B, { type: 'roll' }, rigged(2, 3, 4, 6, 6));
  assert.equal(s.banner.type, 'farkle');
  s = ok(s, A, { type: 'continue' });
  assert.equal(s.current, 0);
  assert.equal(s.round, 2);
});

test('bust: keeping past 10000 shows bust banner; continue advances, points lost', () => {
  let s = started();
  s.players[0].score = 9900; // banked previously (test fixture)
  s = ok(s, A, { type: 'roll' }, rigged(2, 2, 2, 3, 4));
  s = ok(s, A, { type: 'keepAndRoll', keptIdx: [0, 1, 2] }); // 200 -> 10100: bust before rerolling
  assert.equal(s.banner.type, 'bust');
  assert.match(s.log[0], /Alice busted at 10,100 — over 10,000! Turn points lost\./);
  assert.equal(s.players[0].score, 9900, 'banked score untouched by a bust');

  s = ok(s, A, { type: 'continue' });
  assert.equal(s.current, 1);
  assert.equal(s.players[0].score, 9900);
  assert.equal(s.banner, null);
});

test('bust on bank: banking past 10000 is a bust, not a bank', () => {
  let s = started();
  s.players[0].score = 9900;
  s = ok(s, A, { type: 'roll' }, rigged(1, 1, 2, 3, 4));
  s = ok(s, A, { type: 'bank', keptIdx: [0, 1] }); // 200 -> 10100
  assert.equal(s.banner.type, 'bust');
  assert.equal(s.players[0].score, 9900);
  s = ok(s, A, { type: 'continue' });
  assert.equal(s.current, 1);
});

test('cannot bank under 500 on a zero score: invalid-bank banner, turn continues', () => {
  let s = started();
  s = ok(s, A, { type: 'roll' }, rigged(1, 2, 3, 4, 6));
  s = ok(s, A, { type: 'bank', keptIdx: [0] }); // 100 on the table, score 0
  assert.ok(s.banner);
  assert.equal(s.banner.type, 'invalid-bank');
  assert.match(s.banner.text, /500 points/);
  assert.equal(s.players[0].score, 0);
  assert.equal(s.current, 0, 'still Alice\'s turn');
  assert.equal(s.turn.points, 100, 'the keep stands');
  assert.equal(s.turn.phase, 'preroll');
  assert.equal(s.turn.diceCount, 4);

  // Continue clears the banner only; Alice keeps rolling the 4 dice.
  s = ok(s, A, { type: 'continue' });
  assert.equal(s.banner, null);
  assert.equal(s.current, 0);
  assert.equal(s.turn.points, 100);
  s = ok(s, A, { type: 'roll' }, rigged(1, 1, 1, 5));
  s = ok(s, A, { type: 'bank', keptIdx: [0, 1, 2, 3] }); // 1050 + 100 = 1150 >= 500
  assert.equal(s.players[0].score, 1150);
  assert.equal(s.current, 1);
});

test('once on the board, small banks are allowed', () => {
  let s = started();
  s.players[0].score = 600;
  s = ok(s, A, { type: 'roll' }, rigged(5, 2, 3, 4, 6));
  s = ok(s, A, { type: 'bank', keptIdx: [0] }); // banks just 50
  assert.equal(s.players[0].score, 650);
  assert.equal(s.current, 1);
});

test('hot dice: keeping all five brings diceCount back to 5', () => {
  let s = started();
  s = ok(s, A, { type: 'roll' }, rigged(1, 1, 1, 5, 5));
  // All five score: trip ones (1000) + two fives (100). Hot dice → reroll 5.
  s = ok(s, A, { type: 'keepAndRoll', keptIdx: [0, 1, 2, 3, 4] }, rigged(1, 2, 3, 4, 6));
  assert.equal(s.turn.points, 1100);
  assert.deepEqual(s.turn.kept, [1, 1, 1, 5, 5]);
  assert.equal(s.turn.dice.length, 5, 'rolled all five again');
  assert.ok(s.log.some((l) => /hot dice/i.test(l)), 'hot dice log line present');
  assert.equal(s.banner, null);
});

test('exactly 10000 wins: winner set, phase ended, win banner', () => {
  let s = started();
  s.players[0].score = 9000;
  s = ok(s, A, { type: 'roll' }, rigged(1, 1, 1, 2, 3));
  s = ok(s, A, { type: 'bank', keptIdx: [0, 1, 2] }); // 1000 -> exactly 10000
  assert.equal(s.players[0].score, 10000);
  assert.equal(s.winner, 0);
  assert.equal(s.phase, 'ended');
  assert.equal(s.banner.type, 'win');
  assert.equal(s.banner.title, 'Alice wins!');
  assert.match(s.log[0], /Alice banked 1,000 to land on exactly 10,000 — WINNER!/);

  // No more actions once ended.
  fails(s, B, { type: 'roll' }, 'bad-phase');

  // Continue only dismisses the banner; the game stays ended.
  s = ok(s, A, { type: 'continue' });
  assert.equal(s.banner, null);
  assert.equal(s.phase, 'ended');
  assert.equal(s.winner, 0);
});

test('newGame: host only, from ended only; resets scores, keeps players', () => {
  let s = started();
  s.players[0].score = 9000;
  s = ok(s, A, { type: 'roll' }, rigged(1, 1, 1, 2, 3));
  s = ok(s, A, { type: 'bank', keptIdx: [0, 1, 2] });
  assert.equal(s.phase, 'ended');

  fails(s, B, { type: 'newGame' }, 'not-host');
  s = ok(s, A, { type: 'newGame' });
  assert.equal(s.phase, 'lobby');
  assert.deepEqual(s.players.map((p) => p.score), [0, 0]);
  assert.deepEqual(s.players.map((p) => p.name), ['Alice', 'Bob']);
  assert.equal(s.turn, null);
  assert.equal(s.winner, null);
  assert.equal(s.banner, null);

  // newGame outside 'ended' is rejected.
  fails(s, A, { type: 'newGame' }, 'bad-phase');
});

test('out-of-turn actions rejected with not-your-turn, state unchanged', () => {
  let s = started();
  fails(s, B, { type: 'roll' }, 'not-your-turn');
  s = ok(s, A, { type: 'roll' }, rigged(1, 5, 2, 3, 3));
  fails(s, B, { type: 'keepAndRoll', keptIdx: [0] }, 'not-your-turn');
  fails(s, B, { type: 'bank', keptIdx: [0] }, 'not-your-turn');
});

test('phase guards: roll in lobby, roll after rolling, keep before rolling', () => {
  const lobby = setup();
  fails(lobby, A, { type: 'roll' }, 'bad-phase');
  fails(lobby, A, { type: 'continue' }, 'bad-phase'); // no banner

  let s = started();
  fails(s, A, { type: 'keepAndRoll', keptIdx: [0] }, 'bad-phase'); // preroll: nothing to keep
  fails(s, A, { type: 'bank', keptIdx: [0] }, 'bad-phase');
  s = ok(s, A, { type: 'roll' }, rigged(1, 5, 2, 3, 3));
  fails(s, A, { type: 'roll' }, 'bad-phase'); // already rolled
});

test('invalid keeps rejected: breaking trips, non-scoring dice, bad indices', () => {
  let s = started();
  s = ok(s, A, { type: 'roll' }, rigged(5, 5, 5, 2, 3));
  // Breaking up the trip of fives is illegal.
  fails(s, A, { type: 'keepAndRoll', keptIdx: [0] }, 'invalid-keep');
  fails(s, A, { type: 'keepAndRoll', keptIdx: [0, 1] }, 'invalid-keep');
  // A junk die can never be kept.
  fails(s, A, { type: 'keepAndRoll', keptIdx: [3] }, 'invalid-keep');
  fails(s, A, { type: 'bank', keptIdx: [0, 1, 2, 3] }, 'invalid-keep');
  // Empty, out-of-range, duplicate, or malformed keeps.
  fails(s, A, { type: 'keepAndRoll', keptIdx: [] }, 'invalid-keep');
  fails(s, A, { type: 'keepAndRoll', keptIdx: [7] }, 'invalid-keep');
  fails(s, A, { type: 'keepAndRoll', keptIdx: [0, 0, 1] }, 'invalid-keep');
  fails(s, A, { type: 'keepAndRoll', keptIdx: 'nope' }, 'bad-message');
  fails(s, A, { type: 'keepAndRoll' }, 'bad-message');
  fails(s, A, { type: 'keepAndRoll', keptIdx: [0.5] }, 'bad-message');
  // The whole trip is fine.
  s = ok(s, A, { type: 'keepAndRoll', keptIdx: [0, 1, 2] }, rigged(1, 5));
  assert.equal(s.turn.points, 500);
});

test('malformed messages rejected with bad-message', () => {
  const s = started();
  fails(s, A, { type: 'hack-the-planet' }, 'bad-message');
  {
    const before = structuredClone(s);
    for (const bad of [null, 42, 'roll', {}, { type: 7 }]) {
      const r = applyAction(s, A, bad, noRoll);
      assert.ok(r.error);
      assert.equal(r.error.code, 'bad-message');
      assert.deepEqual(s, before);
    }
  }
});

test('log is newest-first and capped at 50 lines', () => {
  let s = started();
  for (let i = 0; i < 60; i++) {
    s = ok(s, s.players[s.current].id, { type: 'roll' }, rigged(2, 3, 4, 6, 6)); // farkle
    s = ok(s, A, { type: 'continue' });
  }
  assert.equal(s.log.length, 50);
  assert.match(s.log[0], /farkle/);
});
