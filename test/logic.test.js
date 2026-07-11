'use strict';
const assert = require('assert');
const L = require('../js/logic.js');

let passed = 0;
function eq(actual, expected, msg) {
  assert.deepStrictEqual(actual, expected, msg);
  passed++;
}

// --- scoreSelection ---
eq(L.scoreSelection([5]).points, 50, 'lone five = 50');
eq(L.scoreSelection([1]).points, 100, 'lone one = 100');
eq(L.scoreSelection([1, 5]).points, 150, 'one + five');
eq(L.scoreSelection([2, 2, 2]).points, 200, 'trip twos = 200');
eq(L.scoreSelection([6, 6, 6]).points, 600, 'trip sixes = 600');
eq(L.scoreSelection([1, 1, 1]).points, 1000, 'trip ones = 1000');
eq(L.scoreSelection([1, 1, 1, 1]).points, 1100, 'four ones = 1000 + 100');
eq(L.scoreSelection([1, 1, 1, 1, 1]).points, 1200, 'five ones');
eq(L.scoreSelection([5, 5, 5, 5, 5]).points, 600, 'five fives = 500 + 50 + 50');
eq(L.scoreSelection([5, 5, 5, 1, 5]).points, 650, 'four fives + one');
eq(L.scoreSelection([2, 2, 2, 5]).points, 250, 'trip twos + five');
eq(L.scoreSelection([1, 2, 3, 4, 5]).points, 1000, 'straight 1-5');
eq(L.scoreSelection([6, 3, 4, 2, 5]).points, 1000, 'straight 2-6 unordered');
eq(L.scoreSelection([]).valid, false, 'empty selection invalid');
eq(L.scoreSelection([2]).valid, false, 'lone two invalid');
eq(L.scoreSelection([2, 2]).valid, false, 'pair of twos invalid');
eq(L.scoreSelection([5, 2]).valid, false, 'five plus junk two invalid');
eq(L.scoreSelection([2, 2, 2, 2]).valid, false, 'four twos: fourth die does not score');

// --- validateKeep (breaking trips) ---
// roll 5 5 5 2 3: keeping one or two 5s breaks the trip
eq(L.validateKeep([5, 5, 5, 2, 3], [0]).valid, false, 'cannot keep 1 of trip fives');
eq(L.validateKeep([5, 5, 5, 2, 3], [0, 1]).valid, false, 'cannot keep 2 of trip fives');
eq(L.validateKeep([5, 5, 5, 2, 3], [0, 1, 2]).points, 500, 'keep whole trip of fives');
// roll 1 1 1 5 2: keeping just the 5 is fine (trip left behind entirely)
eq(L.validateKeep([1, 1, 1, 5, 2], [3]).points, 50, 'keep lone five, reroll trip ones');
eq(L.validateKeep([1, 1, 1, 5, 2], [0]).valid, false, 'cannot keep 1 of trip ones');
eq(L.validateKeep([1, 1, 1, 5, 2], [0, 1, 2, 3]).points, 1050, 'trip ones + five');
// four fives rolled: keeping exactly three is legal (not "one or two")
eq(L.validateKeep([5, 5, 5, 5, 2], [0, 1, 2]).points, 500, 'keep 3 of 4 fives');
eq(L.validateKeep([5, 5, 5, 5, 2], [0, 1, 2, 3]).points, 550, 'keep all 4 fives');
// the example from the rules: 22465 -> keep the 5 for 50
eq(L.validateKeep([2, 2, 4, 6, 5], [4]).points, 50, 'rules example 22465');
eq(L.validateKeep([2, 2, 4, 6, 5], [0, 4]).valid, false, 'cannot leave... err, keep a junk 2');

// --- hasAnyScore (farkle detection) ---
eq(L.hasAnyScore([2, 2, 4, 6, 5]), true, '22465 scores');
eq(L.hasAnyScore([2, 2, 3, 4, 6]), false, '22346 is a farkle');
eq(L.hasAnyScore([2, 3, 4, 4, 6]), false, '23446 is a farkle');
eq(L.hasAnyScore([2, 2, 2, 4, 6]), true, 'trips score');
eq(L.hasAnyScore([2, 3, 4, 5, 6]), true, 'straight scores');
eq(L.hasAnyScore([3, 3, 4, 4, 6]), false, 'pairs alone do not score');
eq(L.hasAnyScore([2, 2]), false, 'two junk dice farkle');
eq(L.hasAnyScore([1]), true, 'single one scores');

// --- isStraight ---
eq(L.isStraight([1, 2, 3, 4, 5]), true, '1-5 straight');
eq(L.isStraight([2, 3, 4, 5, 6]), true, '2-6 straight');
eq(L.isStraight([1, 2, 3, 4, 6]), false, 'gap is not a straight');
eq(L.isStraight([2, 3, 4, 5]), false, 'four dice never a straight');

// --- scoringCandidates ---
eq(L.scoringCandidates([2, 2, 4, 6, 5]), [false, false, false, false, true], 'only the 5 hints');
eq(L.scoringCandidates([2, 2, 2, 4, 1]), [true, true, true, false, true], 'trips and the 1 hint');
eq(L.scoringCandidates([2, 3, 4, 5, 6]), [true, true, true, true, true], 'straight: all hint');

console.log(`ok — ${passed} assertions passed`);
