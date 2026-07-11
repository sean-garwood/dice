/*
 * Ten Thousand — game state, UI, and localStorage persistence.
 * Depends on js/logic.js (window.DiceLogic).
 */
(function () {
  'use strict';

  const L = window.DiceLogic;
  const TARGET = L.TARGET;

  const GAME_KEY = 'dice10k.game.v1';
  const STATS_KEY = 'dice10k.stats.v1';

  const $ = (sel) => document.querySelector(sel);

  /* ---------- persistence ---------- */

  function loadJSON(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage full or unavailable — the game still works, it just won't persist */
    }
  }

  /* ---------- lifetime stats ---------- */

  function blankStats() {
    return { games: 0, wins: 0, banks: 0, totalBanked: 0, bestTurn: 0, farkles: 0, busts: 0 };
  }

  function statsFor(all, name) {
    const key = name.trim().toLowerCase();
    if (!all[key]) all[key] = Object.assign(blankStats(), { name: name.trim() });
    return all[key];
  }

  function bumpStats(name, fn) {
    const all = loadJSON(STATS_KEY) || {};
    fn(statsFor(all, name));
    saveJSON(STATS_KEY, all);
  }

  /* ---------- game state ---------- */

  let state = null; // null = setup screen
  let selection = new Set(); // indices into state.turn.dice (ephemeral)

  function newGame(names) {
    state = {
      players: names.map((name) => ({ name, score: 0 })),
      current: 0,
      round: 1,
      turn: null,
      banner: null,
      winner: null,
      log: [],
    };
    for (const name of names) bumpStats(name, (s) => s.games++);
    startTurn();
    log(`New game: ${names.join(', ')}. First to exactly ${fmt(TARGET)} wins!`);
    save();
    render();
  }

  function startTurn() {
    state.turn = { points: 0, kept: [], dice: [], diceCount: 5, phase: 'preroll' };
    selection = new Set();
  }

  function currentPlayer() {
    return state.players[state.current];
  }

  function nextTurn() {
    state.banner = null;
    state.current = (state.current + 1) % state.players.length;
    if (state.current === 0) state.round++;
    startTurn();
    save();
    render();
  }

  function log(msg) {
    state.log.unshift(msg);
    if (state.log.length > 50) state.log.length = 50;
  }

  function save() {
    if (state && !state.winner) saveJSON(GAME_KEY, state);
    else localStorage.removeItem(GAME_KEY);
  }

  function rollDie() {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return (buf[0] % 6) + 1;
  }

  /* ---------- turn actions ---------- */

  function doRoll() {
    const t = state.turn;
    t.dice = Array.from({ length: t.diceCount }, rollDie);
    t.phase = 'rolled';
    selection = new Set();
    if (!L.hasAnyScore(t.dice)) {
      const p = currentPlayer();
      log(`${p.name} rolled ${t.dice.join(' ')} — farkle! ${fmt(t.points)} points lost.`);
      bumpStats(p.name, (s) => s.farkles++);
      state.banner = {
        type: 'farkle',
        title: 'Farkle!',
        emoji: '💥',
        text: `${p.name} rolled ${t.dice.join(' · ')} — nothing scores. ${
          t.points > 0 ? `${fmt(t.points)} points on the table blow up.` : 'The turn is over.'
        }`,
      };
    }
    save();
    render();
  }

  /* Apply the current selection as kept dice. Returns null if invalid. */
  function applyKeep() {
    const t = state.turn;
    const idx = [...selection];
    const res = L.validateKeep(t.dice, idx);
    if (!res.valid) return null;
    t.points += res.points;
    t.kept.push(...idx.map((i) => t.dice[i]));
    const remaining = t.dice.length - idx.length;
    const hot = remaining === 0;
    t.diceCount = hot ? 5 : remaining;
    t.dice = [];
    t.phase = 'preroll';
    selection = new Set();
    return { points: res.points, hot };
  }

  function bust() {
    const p = currentPlayer();
    const total = p.score + state.turn.points;
    log(`${p.name} busted at ${fmt(total)} — over ${fmt(TARGET)}! Turn points lost.`);
    bumpStats(p.name, (s) => s.busts++);
    state.banner = {
      type: 'bust',
      title: 'Bust!',
      emoji: '🚫',
      text: `${p.name} went over ${fmt(TARGET)} (${fmt(total)}). The turn ends and all points on the table are lost. You need exactly ${fmt(TARGET)}!`,
    };
    save();
    render();
  }

  function doKeepAndRoll() {
    const kept = applyKeep();
    if (!kept) return;
    const p = currentPlayer();
    if (p.score + state.turn.points > TARGET) {
      bust();
      return;
    }
    if (kept.hot) log(`${p.name} — hot dice! All five scored; rolling all five again.`);
    doRoll();
  }

  function doBank() {
    const kept = applyKeep();
    if (!kept) return;
    const p = currentPlayer();
    const total = p.score + state.turn.points;
    if (total > TARGET) {
      bust();
      return;
    }
    p.score = total;
    const banked = state.turn.points;
    bumpStats(p.name, (s) => {
      s.banks++;
      s.totalBanked += banked;
      if (banked > s.bestTurn) s.bestTurn = banked;
    });
    if (total === TARGET) {
      state.winner = state.current;
      log(`${p.name} banked ${fmt(banked)} to land on exactly ${fmt(TARGET)} — WINNER!`);
      bumpStats(p.name, (s) => s.wins++);
      state.banner = {
        type: 'win',
        title: `${p.name} wins!`,
        emoji: '🏆',
        text: `Exactly ${fmt(TARGET)} points in ${state.round} round${state.round === 1 ? '' : 's'}. What a game!`,
      };
      save();
      render();
      return;
    }
    log(`${p.name} banked ${fmt(banked)} (total ${fmt(total)}, needs ${fmt(TARGET - total)}).`);
    nextTurn();
  }

  /* ---------- rendering ---------- */

  const PIP_CELLS = { 1: [5], 2: [3, 7], 3: [3, 5, 7], 4: [1, 3, 7, 9], 5: [1, 3, 5, 7, 9], 6: [1, 3, 4, 6, 7, 9] };

  function dieEl(value, opts = {}) {
    const el = document.createElement(opts.button ? 'button' : 'span');
    el.className = 'die' + (opts.small ? ' small' : '');
    el.dataset.value = value;
    if (opts.button) el.type = 'button';
    for (let cell = 1; cell <= 9; cell++) {
      const pip = document.createElement('span');
      pip.className = PIP_CELLS[value].includes(cell) ? 'pip' : 'pip empty';
      el.appendChild(pip);
    }
    return el;
  }

  function fmt(n) {
    return n.toLocaleString('en-US');
  }

  function render() {
    const inGame = !!state;
    $('#setup').hidden = inGame;
    $('#game').hidden = !inGame;
    $('#btn-new-game').hidden = !inGame;
    if (!inGame) {
      $('#banner').hidden = true;
      return;
    }

    renderScoreboard();
    renderTurn();
    renderLog();
    renderBanner();
  }

  function renderScoreboard() {
    const board = $('#scoreboard');
    board.innerHTML = '';
    state.players.forEach((p, i) => {
      const card = document.createElement('div');
      card.className = 'player-card' + (i === state.current && !state.winner ? ' active' : '') + (state.winner === i ? ' winner' : '');
      const need = TARGET - p.score;
      card.innerHTML = `
        <div class="player-name"></div>
        <div class="player-score">${fmt(p.score)}</div>
        <div class="player-need">${state.winner === i ? '🏆 winner' : `needs ${fmt(need)}`}</div>
        <div class="bar"><div class="bar-fill" style="width:${Math.min(100, (p.score / TARGET) * 100)}%"></div></div>`;
      card.querySelector('.player-name').textContent = p.name;
      board.appendChild(card);
    });
  }

  function renderTurn() {
    const t = state.turn;
    const p = currentPlayer();
    $('#turn-player').textContent = state.winner !== null ? 'Game over' : `${p.name}'s turn — round ${state.round}`;
    $('#turn-points').textContent = fmt(t.points);

    // set-aside tray
    const tray = $('#kept-tray');
    tray.hidden = t.kept.length === 0;
    const keptBox = $('#kept-dice');
    keptBox.innerHTML = '';
    t.kept.forEach((v) => keptBox.appendChild(dieEl(v, { small: true })));

    // dice
    const row = $('#dice-row');
    row.innerHTML = '';
    const hints = t.phase === 'rolled' ? L.scoringCandidates(t.dice) : [];
    t.dice.forEach((v, i) => {
      const d = dieEl(v, { button: true });
      if (selection.has(i)) d.classList.add('selected');
      if (hints[i]) d.classList.add('can-score');
      d.disabled = !!state.banner || state.winner !== null;
      d.addEventListener('click', () => {
        if (selection.has(i)) selection.delete(i);
        else selection.add(i);
        renderTurn();
      });
      row.appendChild(d);
    });
    if (t.phase === 'preroll') {
      for (let i = 0; i < t.diceCount; i++) {
        const ph = document.createElement('span');
        ph.className = 'die placeholder';
        ph.textContent = '?';
        row.appendChild(ph);
      }
    }

    // buttons + selection info
    const rollBtn = $('#btn-roll');
    const keepRollBtn = $('#btn-keep-roll');
    const bankBtn = $('#btn-bank');
    const info = $('#selection-info');
    const frozen = !!state.banner || state.winner !== null;

    rollBtn.hidden = t.phase !== 'preroll';
    keepRollBtn.hidden = t.phase !== 'rolled';
    bankBtn.hidden = t.phase !== 'rolled';
    rollBtn.disabled = frozen;

    if (t.phase === 'preroll') {
      rollBtn.textContent = t.diceCount === 5 && t.kept.length > 0 ? 'Roll all 5 (hot dice!)' : `Roll ${t.diceCount === 5 ? 'all 5 dice' : `${t.diceCount} ${t.diceCount === 1 ? 'die' : 'dice'}`}`;
      info.innerHTML = '&nbsp;';
      return;
    }

    const res = L.validateKeep(t.dice, [...selection]);
    const remaining = t.dice.length - selection.size;
    keepRollBtn.disabled = frozen || !res.valid;
    bankBtn.disabled = frozen || !res.valid;
    keepRollBtn.textContent = res.valid && remaining === 0 ? 'Keep all & roll 5 (hot dice!)' : `Keep & roll ${remaining} ${remaining === 1 ? 'die' : 'dice'}`;
    bankBtn.textContent = res.valid ? `Bank ${fmt(t.points + res.points)} & end turn` : 'Bank points';

    if (!res.valid) {
      info.textContent = selection.size === 0 ? 'Tap the dice you want to set aside. Dotted dice can score.' : res.reason;
      info.className = 'selection-info' + (selection.size ? ' invalid' : '');
    } else {
      const wouldTotal = p.score + t.points + res.points;
      let extra = '';
      let cls = ' valid';
      if (wouldTotal > TARGET) {
        extra = ` — ⚠ that puts you at ${fmt(wouldTotal)}: BUST!`;
        cls = ' danger-text';
      } else if (wouldTotal === TARGET) {
        extra = ` — banking now lands on exactly ${fmt(TARGET)}: the win! 🏆`;
      }
      info.textContent = `Selection worth ${fmt(res.points)} (table total ${fmt(t.points + res.points)})${extra}`;
      info.className = 'selection-info' + cls;
    }
  }

  function renderLog() {
    const box = $('#log');
    box.innerHTML = '';
    state.log.forEach((line) => {
      const div = document.createElement('div');
      div.textContent = line;
      box.appendChild(div);
    });
  }

  function renderBanner() {
    const overlay = $('#banner');
    const b = state.banner;
    overlay.hidden = !b;
    if (!b) return;
    $('#banner-emoji').textContent = b.emoji;
    $('#banner-title').textContent = b.title;
    $('#banner-text').textContent = b.text;
    $('#btn-banner-continue').textContent = b.type === 'win' ? 'New game' : 'Next player';
  }

  /* ---------- stats dialog ---------- */

  function renderStats() {
    const all = loadJSON(STATS_KEY) || {};
    const entries = Object.values(all).sort((a, b) => b.wins - a.wins || b.games - a.games);
    const body = $('#stats-body');
    if (entries.length === 0) {
      body.innerHTML = '<p class="muted">No games recorded yet. Play a game!</p>';
      return;
    }
    const table = document.createElement('table');
    table.className = 'stats-table';
    table.innerHTML = `<thead><tr>
      <th>Player</th><th>Games</th><th>Wins</th><th>Best turn</th><th>Avg bank</th><th>Farkles</th><th>Busts</th>
    </tr></thead>`;
    const tbody = document.createElement('tbody');
    for (const s of entries) {
      const tr = document.createElement('tr');
      const avg = s.banks ? Math.round(s.totalBanked / s.banks) : 0;
      const cells = [s.name, s.games, s.wins, fmt(s.bestTurn), fmt(avg), s.farkles, s.busts];
      cells.forEach((c) => {
        const td = document.createElement('td');
        td.textContent = c;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    body.innerHTML = '';
    body.appendChild(table);
  }

  /* ---------- setup screen ---------- */

  function renderNameInputs(n) {
    const box = $('#name-inputs');
    const existing = [...box.querySelectorAll('input')].map((i) => i.value);
    box.innerHTML = '';
    for (let i = 0; i < n; i++) {
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 20;
      input.placeholder = `Player ${i + 1}`;
      input.value = existing[i] || '';
      box.appendChild(input);
    }
  }

  /* ---------- wiring ---------- */

  $('#player-count').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-n]');
    if (!btn) return;
    document.querySelectorAll('#player-count button').forEach((b) => b.classList.toggle('active', b === btn));
    renderNameInputs(Number(btn.dataset.n));
  });

  $('#btn-start').addEventListener('click', () => {
    const names = [...document.querySelectorAll('#name-inputs input')].map(
      (input, i) => input.value.trim() || `Player ${i + 1}`
    );
    newGame(names);
  });

  $('#btn-roll').addEventListener('click', doRoll);
  $('#btn-keep-roll').addEventListener('click', doKeepAndRoll);
  $('#btn-bank').addEventListener('click', doBank);

  $('#btn-banner-continue').addEventListener('click', () => {
    if (state.banner && state.banner.type === 'win') {
      state = null;
      localStorage.removeItem(GAME_KEY);
      render();
    } else {
      nextTurn();
    }
  });

  $('#btn-new-game').addEventListener('click', () => {
    if (!confirm('Abandon the current game and start over?')) return;
    state = null;
    localStorage.removeItem(GAME_KEY);
    render();
  });

  $('#btn-rules').addEventListener('click', () => $('#dlg-rules').showModal());
  $('#btn-stats').addEventListener('click', () => {
    renderStats();
    $('#dlg-stats').showModal();
  });
  $('#btn-reset-stats').addEventListener('click', () => {
    if (!confirm('Erase all lifetime stats?')) return;
    localStorage.removeItem(STATS_KEY);
    renderStats();
  });

  /* ---------- boot: resume a saved game if there is one ---------- */

  renderNameInputs(2);
  const saved = loadJSON(GAME_KEY);
  if (saved && saved.players && saved.turn && saved.winner === null) {
    state = saved;
    selection = new Set();
  }
  render();
})();
