/*
 * Ten Thousand — game state, UI, and localStorage persistence.
 * Depends on js/logic.js (window.DiceLogic).
 * Online multiplayer depends on js/config.js (window.DICE_CONFIG) and
 * js/net.js (window.DiceNet). See docs/PROTOCOL.md for the wire protocol.
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

  /* ---------- lifetime stats (LOCAL games only) ---------- */

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

  /* ---------- mode + screen switching ---------- */

  let mode = 'local'; // 'local' | 'online'

  function showScreen(name) {
    $('#setup').hidden = name !== 'setup';
    $('#lobby').hidden = name !== 'lobby';
    $('#game').hidden = name !== 'game';
  }

  /* ================================================================== */
  /* ========================  LOCAL PASS-AND-PLAY  ==================== */
  /* ================================================================== */

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
    const bankCheck = L.canBank(p.score, state.turn.points);
    if (!bankCheck.valid) {
      state.banner = {
        type: 'invalid-bank',
        title: 'Cannot bank yet',
        emoji: '⏸️',
        text: bankCheck.reason,
      };
      save();
      render();
      return;
    }
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

  /* ---------- shared rendering helpers ---------- */

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

  /*
   * These render* functions work off a plain state-like object (`s`) rather
   * than the module-level `state` global, so both local play and online play
   * (whose RoomState mirrors this shape — see docs/PROTOCOL.md) can share
   * the exact same rendering code.
   */

  function renderScoreboard(s, opts) {
    opts = opts || {};
    const board = $('#scoreboard');
    board.innerHTML = '';
    s.players.forEach((p, i) => {
      const card = document.createElement('div');
      card.className =
        'player-card' +
        (i === s.current && s.winner === null ? ' active' : '') +
        (s.winner === i ? ' winner' : '') +
        (p.connected === false ? ' disconnected' : '');
      const need = TARGET - p.score;
      card.innerHTML = `
        <div class="player-name"></div>
        <div class="player-score">${fmt(p.score)}</div>
        <div class="player-need">${s.winner === i ? '🏆 winner' : `needs ${fmt(need)}`}</div>
        <div class="bar"><div class="bar-fill" style="width:${Math.min(100, (p.score / TARGET) * 100)}%"></div></div>`;
      let nameText = p.name;
      if (opts.youId && p.id === opts.youId) nameText += ' (you)';
      if (p.connected === false) nameText += ' (disconnected)';
      card.querySelector('.player-name').textContent = nameText;
      board.appendChild(card);
    });
  }

  function renderTurn(s, sel, opts) {
    opts = opts || {};
    const interactive = opts.interactive !== false;
    const t = s.turn;
    const p = s.players[s.current];
    $('#turn-player').textContent = s.winner !== null ? 'Game over' : `${p.name}'s turn — round ${s.round}`;
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
      if (sel.has(i)) d.classList.add('selected');
      if (hints[i]) d.classList.add('can-score');
      d.disabled = !!s.banner || s.winner !== null || !interactive;
      d.addEventListener('click', () => {
        if (sel.has(i)) sel.delete(i);
        else sel.add(i);
        if (opts.onSelectionChange) opts.onSelectionChange();
        else renderTurn(s, sel, opts);
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
    const frozen = !!s.banner || s.winner !== null || !interactive;

    rollBtn.hidden = t.phase !== 'preroll';
    keepRollBtn.hidden = t.phase !== 'rolled';
    bankBtn.hidden = t.phase !== 'rolled';
    rollBtn.disabled = frozen;

    if (t.phase === 'preroll') {
      rollBtn.textContent =
        t.diceCount === 5 && t.kept.length > 0
          ? 'Roll all 5 (hot dice!)'
          : `Roll ${t.diceCount === 5 ? 'all 5 dice' : `${t.diceCount} ${t.diceCount === 1 ? 'die' : 'dice'}`}`;
    }

    let res = null;
    let remaining = 0;
    if (t.phase === 'rolled') {
      res = L.validateKeep(t.dice, [...sel]);
      remaining = t.dice.length - sel.size;
      keepRollBtn.disabled = frozen || !res.valid;
      bankBtn.disabled = frozen || !res.valid;
      keepRollBtn.textContent =
        res.valid && remaining === 0 ? 'Keep all & roll 5 (hot dice!)' : `Keep & roll ${remaining} ${remaining === 1 ? 'die' : 'dice'}`;
      bankBtn.textContent = res.valid ? `Bank ${fmt(t.points + res.points)} & end turn` : 'Bank points';
    }

    if (!interactive) {
      info.textContent = t.phase === 'preroll' ? ' ' : opts.waitingText || `Waiting for ${p.name}…`;
      info.className = 'selection-info';
      return;
    }

    if (t.phase === 'preroll') {
      info.innerHTML = '&nbsp;';
      return;
    }

    if (!res.valid) {
      info.textContent = sel.size === 0 ? 'Tap the dice you want to set aside. Dotted dice can score.' : res.reason;
      info.className = 'selection-info' + (sel.size ? ' invalid' : '');
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

  function renderLog(s) {
    const box = $('#log');
    box.innerHTML = '';
    s.log.forEach((line) => {
      const div = document.createElement('div');
      div.textContent = line;
      box.appendChild(div);
    });
  }

  function renderBanner(s, opts) {
    opts = opts || {};
    const overlay = $('#banner');
    const b = s.banner;
    overlay.hidden = !b;
    if (!b) return;
    $('#banner-emoji').textContent = b.emoji;
    $('#banner-title').textContent = b.title;
    $('#banner-text').textContent = b.text;
    const btn = $('#btn-banner-continue');
    if (opts.renderContinueButton) {
      opts.renderContinueButton(btn, b, s);
      return;
    }
    if (b.type === 'win') {
      btn.textContent = 'New game';
    } else if (b.type === 'invalid-bank') {
      btn.textContent = 'Keep rolling';
    } else {
      btn.textContent = 'Next player';
    }
    btn.disabled = false;
    btn.hidden = false;
  }

  /* ---------- local-mode top-level render ---------- */

  function render() {
    const inGame = !!state;
    showScreen(inGame ? 'game' : 'setup');
    $('#btn-new-game').hidden = !inGame;
    if (!inGame) {
      $('#banner').hidden = true;
      return;
    }

    renderScoreboard(state);
    renderTurn(state, selection);
    renderLog(state);
    renderBanner(state);
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

  /* ---------- setup screen (local) ---------- */

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

  /* ================================================================== */
  /* =============================  ONLINE  ============================ */
  /* ================================================================== */

  let onlineState = null; // last RoomState broadcast from the server
  let onlinePlayerId = null; // this browser's playerId, from the 'joined' reply
  let onlineRoomCode = null;
  let onlineServerUrl = null;
  let onlineConnStatus = 'closed'; // 'connecting' | 'open' | 'reconnecting' | 'closed'
  let onlineSelection = new Set(); // ephemeral dice selection, cleared when turn.dice changes
  let onlineLastDiceKey = '';

  let toastTimer = null;

  function showOnlineToast(msg) {
    const el = $('#online-toast');
    if (!el || !msg) return;
    el.textContent = msg;
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 4000);
  }

  function buildInviteLink(code) {
    const url = new URL(window.location.href);
    const params = new URLSearchParams();
    params.set('room', code);
    if (window.DICE_CONFIG && window.DICE_CONFIG.serverOverride) {
      params.set('server', window.DICE_CONFIG.serverOverride);
    }
    url.search = params.toString();
    url.hash = '';
    return url.toString();
  }

  function fallbackCopy(text) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard
        .writeText(text)
        .then(() => true)
        .catch(() => fallbackCopy(text));
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function copyInviteLink() {
    if (!onlineRoomCode) return;
    const link = buildInviteLink(onlineRoomCode);
    Promise.resolve(copyToClipboard(link)).then((ok) => {
      showOnlineToast(ok ? 'Invite link copied!' : `Copy failed. Link: ${link}`);
    });
  }

  const CONN_META = {
    connecting: { cls: 'connecting', label: 'Connecting…' },
    open: { cls: 'open', label: 'Connected' },
    reconnecting: { cls: 'reconnecting', label: 'Reconnecting…' },
    closed: { cls: 'closed', label: 'Disconnected' },
  };

  function renderConnStatus() {
    const meta = CONN_META[onlineConnStatus] || CONN_META.closed;
    [
      ['#lobby-conn-dot', '#lobby-conn-label'],
      ['#game-conn-dot', '#game-conn-label'],
    ].forEach(([dotSel, labelSel]) => {
      const dot = $(dotSel);
      const label = $(labelSel);
      if (dot) dot.className = 'conn-dot ' + meta.cls;
      if (label) label.textContent = meta.label;
    });
  }

  function isHostNow() {
    return !!(onlineState && onlinePlayerId && onlineState.hostId === onlinePlayerId);
  }

  function isCurrentPlayerNow() {
    return !!(
      onlineState &&
      onlinePlayerId &&
      onlineState.turn &&
      onlineState.players[onlineState.current] &&
      onlineState.players[onlineState.current].id === onlinePlayerId
    );
  }

  function renderLobby() {
    const s = onlineState;
    $('#lobby-room-code').textContent = onlineRoomCode || (s && s.roomCode) || '';
    const list = $('#lobby-players');
    list.innerHTML = '';
    if (s) {
      s.players.forEach((p) => {
        const li = document.createElement('li');
        li.className = 'lobby-player' + (p.connected ? '' : ' disconnected');
        const dot = document.createElement('span');
        dot.className = 'conn-dot ' + (p.connected ? 'open' : 'closed');
        const nameSpan = document.createElement('span');
        nameSpan.className = 'lobby-player-name';
        nameSpan.textContent = p.name;
        li.appendChild(dot);
        li.appendChild(nameSpan);
        if (p.id === s.hostId) {
          const tag = document.createElement('span');
          tag.className = 'tag host-tag';
          tag.textContent = 'Host';
          li.appendChild(tag);
        }
        if (p.id === onlinePlayerId) {
          const you = document.createElement('span');
          you.className = 'tag you-tag';
          you.textContent = '(you)';
          li.appendChild(you);
        }
        list.appendChild(li);
      });
    }
    const startBtn = $('#btn-lobby-start');
    const host = isHostNow();
    startBtn.hidden = !host;
    const playerCount = s ? s.players.length : 0;
    startBtn.disabled = playerCount < 2;
    $('#lobby-hint').textContent = !s
      ? 'Connecting…'
      : playerCount < 2
      ? 'Waiting for at least one more player…'
      : host
      ? 'Ready when you are.'
      : 'Waiting for the host to start…';
    renderConnStatus();
  }

  function renderOnlineHeader() {
    const header = $('#online-header');
    if (header) header.hidden = false;
    $('#game-room-code').textContent = onlineRoomCode || (onlineState && onlineState.roomCode) || '';
    renderConnStatus();
  }

  function onlineRenderContinueButton(btn, b, s) {
    const host = isHostNow();
    const current = isCurrentPlayerNow();
    if (s.phase === 'ended') {
      btn.textContent = host ? 'Play again' : 'Waiting for host…';
      btn.disabled = !host;
      btn.hidden = false;
      return;
    }
    if (b.type === 'invalid-bank') {
      btn.textContent = 'Keep rolling';
    } else {
      btn.textContent = 'Next player';
    }
    btn.disabled = !(host || current);
    btn.hidden = false;
  }

  function renderOnlineTurn() {
    const s = onlineState;
    if (!s || !s.turn) return;
    const interactive = isCurrentPlayerNow() && !s.banner && s.winner === null;
    renderTurn(s, onlineSelection, { interactive, onSelectionChange: renderOnlineTurn });
  }

  function renderOnlineGame() {
    const s = onlineState;
    if (!s) return;
    renderOnlineHeader();
    renderScoreboard(s, { youId: onlinePlayerId });
    renderOnlineTurn();
    renderLog(s);
    renderBanner(s, { renderContinueButton: onlineRenderContinueButton });
  }

  function renderOnlineState() {
    const s = onlineState;
    if (!s) return;
    $('#btn-new-game').hidden = false;
    $('#btn-new-game').textContent = 'Leave room';
    if (s.phase === 'lobby') {
      showScreen('lobby');
      renderLobby();
    } else {
      showScreen('game');
      renderOnlineGame();
    }
  }

  function onlineDoRoll() {
    window.DiceNet.sendAction({ type: 'roll' });
  }

  function onlineDoKeepAndRoll() {
    window.DiceNet.sendAction({ type: 'keepAndRoll', keptIdx: [...onlineSelection] });
  }

  function onlineDoBank() {
    window.DiceNet.sendAction({ type: 'bank', keptIdx: [...onlineSelection] });
  }

  function startOnlineConnection(code, name) {
    mode = 'online';
    onlineRoomCode = String(code).toUpperCase();
    onlineServerUrl = (window.DICE_CONFIG && window.DICE_CONFIG.serverUrl) || 'ws://localhost:8787';
    onlinePlayerId = null;
    onlineState = null;
    onlineSelection = new Set();
    onlineLastDiceKey = '';

    showScreen('lobby');
    $('#lobby-room-code').textContent = onlineRoomCode;
    $('#lobby-players').innerHTML = '';
    $('#lobby-hint').textContent = 'Connecting…';
    $('#btn-lobby-start').hidden = true;
    $('#btn-new-game').hidden = false;
    $('#btn-new-game').textContent = 'Leave room';
    renderConnStatus();

    window.DiceNet.connect(onlineServerUrl, onlineRoomCode, name);
  }

  function exitOnlineMode() {
    if (window.DiceNet) window.DiceNet.leave();
    mode = 'local';
    onlineState = null;
    onlinePlayerId = null;
    onlineRoomCode = null;
    const header = $('#online-header');
    if (header) header.hidden = true;
    $('#btn-new-game').textContent = 'New game';
    render();
  }

  const JOIN_FATAL_CODES = ['room-full', 'game-in-progress', 'name-taken'];

  if (window.DiceNet) {
    window.DiceNet.onJoined = function (msg) {
      onlinePlayerId = msg.playerId;
      onlineRoomCode = msg.roomCode || onlineRoomCode;
    };
    window.DiceNet.onState = function (s) {
      onlineState = s;
      const diceKey = s.turn ? s.turn.dice.join(',') : '';
      if (diceKey !== onlineLastDiceKey) {
        onlineSelection = new Set();
        onlineLastDiceKey = diceKey;
      }
      renderOnlineState();
    };
    window.DiceNet.onError = function (err) {
      showOnlineToast((err && err.message) || (err && err.code) || 'Something went wrong.');
      if (mode === 'online' && !onlinePlayerId && err && JOIN_FATAL_CODES.includes(err.code)) {
        exitOnlineMode();
      }
    };
    window.DiceNet.onConnectionChange = function (status) {
      onlineConnStatus = status;
      renderConnStatus();
    };
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

  $('#btn-roll').addEventListener('click', () => {
    if (mode === 'online') onlineDoRoll();
    else doRoll();
  });
  $('#btn-keep-roll').addEventListener('click', () => {
    if (mode === 'online') onlineDoKeepAndRoll();
    else doKeepAndRoll();
  });
  $('#btn-bank').addEventListener('click', () => {
    if (mode === 'online') onlineDoBank();
    else doBank();
  });

  $('#btn-banner-continue').addEventListener('click', () => {
    if (mode === 'online') {
      if (!onlineState || !onlineState.banner) return;
      if (onlineState.phase === 'ended') {
        if (isHostNow()) window.DiceNet.sendAction({ type: 'newGame' });
        return;
      }
      window.DiceNet.sendAction({ type: 'continue' });
      return;
    }
    if (state.banner && state.banner.type === 'win') {
      state = null;
      localStorage.removeItem(GAME_KEY);
      render();
    } else if (state.banner && state.banner.type === 'invalid-bank') {
      state.banner = null;
      save();
      render();
    } else {
      nextTurn();
    }
  });

  $('#btn-new-game').addEventListener('click', () => {
    if (mode === 'online') {
      if (!confirm('Leave this room?')) return;
      exitOnlineMode();
      return;
    }
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

  /* ---------- online wiring ---------- */

  $('#btn-create-room').addEventListener('click', () => {
    const name = $('#online-name').value.trim();
    if (!name) {
      showOnlineToast('Enter your name first.');
      $('#online-name').focus();
      return;
    }
    const code = window.DiceNet.generateRoomCode();
    startOnlineConnection(code, name);
  });

  $('#btn-join-room').addEventListener('click', () => {
    const name = $('#online-name').value.trim();
    const code = $('#online-join-code').value.trim().toUpperCase();
    if (!name) {
      showOnlineToast('Enter your name first.');
      $('#online-name').focus();
      return;
    }
    if (!code) {
      showOnlineToast('Enter a room code.');
      $('#online-join-code').focus();
      return;
    }
    startOnlineConnection(code, name);
  });

  $('#btn-lobby-start').addEventListener('click', () => {
    window.DiceNet.sendAction({ type: 'start' });
  });

  $('#btn-copy-invite').addEventListener('click', copyInviteLink);
  $('#btn-copy-invite-game').addEventListener('click', copyInviteLink);

  /* ---------- boot: resume a saved local game, or pre-fill a shared room link ---------- */

  renderNameInputs(2);
  const saved = loadJSON(GAME_KEY);
  if (saved && saved.players && saved.turn && saved.winner === null) {
    state = saved;
    selection = new Set();
  }

  try {
    const bootParams = new URLSearchParams(window.location.search);
    const roomParam = bootParams.get('room');
    if (roomParam) {
      $('#online-join-code').value = roomParam.toUpperCase();
      const stored = window.DiceNet && window.DiceNet.getIdentity(roomParam.toUpperCase());
      if (stored && stored.name) $('#online-name').value = stored.name;
      $('#online-name').focus();
      $('#online-panel').scrollIntoView({ block: 'nearest' });
    }
  } catch {
    /* URLSearchParams unavailable — ignore, local setup still works */
  }

  render();
})();
