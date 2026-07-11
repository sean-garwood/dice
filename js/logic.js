/*
 * Pure scoring/validation logic for Ten Thousand.
 * No DOM, no storage — usable in the browser and in Node tests.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DiceLogic = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TARGET = 10000;

  function countsOf(dice) {
    const c = [0, 0, 0, 0, 0, 0, 0];
    for (const v of dice) c[v]++;
    return c;
  }

  function isStraight(dice) {
    if (dice.length !== 5) return false;
    const s = [...dice].sort().join('');
    return s === '12345' || s === '23456';
  }

  /*
   * Score a set of dice the player wants to keep.
   * Every kept die must contribute to the score.
   * Returns { valid, points, reason }.
   */
  function scoreSelection(dice) {
    if (dice.length === 0) {
      return { valid: false, points: 0, reason: 'Select at least one scoring die.' };
    }
    if (isStraight(dice)) {
      return { valid: true, points: 1000 };
    }
    const counts = countsOf(dice);
    let points = 0;
    for (let v = 1; v <= 6; v++) {
      let n = counts[v];
      if (n === 0) continue;
      if (n >= 3) {
        points += v === 1 ? 1000 : v * 100;
        n -= 3;
      }
      if (n > 0) {
        if (v === 1) points += 100 * n;
        else if (v === 5) points += 50 * n;
        else return { valid: false, points: 0, reason: `A lone ${v} doesn't score — every kept die must add points.` };
      }
    }
    return { valid: true, points };
  }

  /*
   * Validate keeping the dice at `keptIdx` out of `roll`.
   * Enforces the no-breaking-trips rule: if the roll shows three or more
   * of a value, you can't keep just one or two of them.
   */
  function validateKeep(roll, keptIdx) {
    const kept = keptIdx.map((i) => roll[i]);
    const res = scoreSelection(kept);
    if (!res.valid) return res;
    const rollCounts = countsOf(roll);
    const keptCounts = countsOf(kept);
    for (let v = 1; v <= 6; v++) {
      if (rollCounts[v] >= 3 && keptCounts[v] > 0 && keptCounts[v] < 3) {
        return {
          valid: false,
          points: 0,
          reason: `You can't break up three-of-a-kind ${v}s — keep all three or none.`,
        };
      }
    }
    return res;
  }

  /* True if the roll offers any way to score (i.e., not a farkle). */
  function hasAnyScore(roll) {
    if (roll.some((v) => v === 1 || v === 5)) return true;
    if (countsOf(roll).some((c) => c >= 3)) return true;
    return isStraight(roll);
  }

  /* Dice that could take part in some score, for UI hinting. */
  function scoringCandidates(roll) {
    if (isStraight(roll)) return roll.map(() => true);
    const counts = countsOf(roll);
    return roll.map((v) => v === 1 || v === 5 || counts[v] >= 3);
  }

  /* Validate that a player can bank. If they have zero points, they need 500+ accumulated. */
  function canBank(currentScore, tablePoints) {
    if (currentScore === 0 && tablePoints < 500) {
      return { valid: false, reason: 'You need 500 points to get on the board.' };
    }
    return { valid: true };
  }

  return { TARGET, countsOf, isStraight, scoreSelection, validateKeep, hasAnyScore, scoringCandidates, canBank };
});
