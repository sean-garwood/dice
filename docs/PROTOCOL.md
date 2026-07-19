# Ten Thousand — Multiplayer Protocol & Architecture Spec (v1)

Contract between the Cloudflare Worker backend and the browser client.
This file is committed as `docs/PROTOCOL.md` by the backend PR. Client and
server are developed in parallel against this spec — DO NOT deviate from
message shapes or state shapes without updating this file.

## Architecture

- Frontend: static site (GitHub Pages) — `index.html`, `js/*`, `css/*`. Plain
  scripts, no modules, no build step. `js/logic.js` exposes `window.DiceLogic`
  (UMD, also `module.exports` for Node/bundlers).
- Backend: one Cloudflare Worker (`worker/`) with a Durable Object class
  `Room` — one instance per room code, addressed via `idFromName(code)`.
  **SQLite-backed** (`new_sqlite_classes` migration) so it runs on the
  Workers Free plan. Uses the WebSocket Hibernation API
  (`ctx.acceptWebSocket`, `webSocketMessage`, `webSocketClose`) so idle
  connections cost nothing.
- The DO is the single source of truth in online games. It rolls the dice
  (crypto RNG), validates every action with the same rules module the
  browser uses (`js/logic.js`, bundled into the worker by wrangler/esbuild),
  and broadcasts full state after every change. Clients render state; they
  never mutate it in online mode.
- Game state is persisted to DO storage (`ctx.storage`) on every change, so
  eviction/hibernation never loses a game.

## HTTP surface (Worker routes)

- `GET /health` → `200 {"ok":true}` (JSON). CORS: `Access-Control-Allow-Origin: *`.
- `GET /room/:code/ws` → WebSocket upgrade, forwarded to the Room DO for
  `:code`. Room codes are 4–8 chars, `A–Z0–9`, case-insensitive (normalize to
  uppercase before `idFromName`). Non-upgrade requests → 426.
- Anything else → 404 JSON.

There is no "create room" endpoint: the client generates a code and connects;
the DO is created on first connect.

## Room codes & identity

- Client generates codes: 4 chars from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`
  (no I/L/O/0/1 lookalikes).
- Client generates a `playerId` (random hex, 16 chars) per room, stored in
  localStorage key `dice10k.online.v1` as `{ [roomCode]: { playerId, name } }`.
  Sending the same `playerId` on join reclaims the seat (reconnect).

## WebSocket messages — client → server (JSON, one object per frame)

| type          | fields                          | who may send                  | when                       |
|---------------|---------------------------------|-------------------------------|----------------------------|
| `join`        | `name` (1–20 chars), `playerId` | anyone                        | first message after connect|
| `start`       | —                               | host only                     | `phase === 'lobby'`, ≥2 players |
| `roll`        | —                               | current player                | playing, `turn.phase === 'preroll'`, no banner |
| `keepAndRoll` | `keptIdx: number[]`             | current player                | playing, `turn.phase === 'rolled'`, no banner |
| `bank`        | `keptIdx: number[]`             | current player                | playing, `turn.phase === 'rolled'`, no banner |
| `continue`    | —                               | current player OR host        | a banner is showing        |
| `newGame`     | —                               | host only                     | `phase === 'ended'`        |

Any invalid/out-of-turn message → `error` reply to the sender only; state is
untouched and NOT rebroadcast.

## WebSocket messages — server → client

- `{ "type": "joined", "playerId": "...", "roomCode": "ABCD", "youAreHost": bool }`
  — sent to the joining socket only, immediately followed by a `state`.
- `{ "type": "state", "state": <RoomState> }` — broadcast to every connected
  socket after any accepted change (join, disconnect, action).
- `{ "type": "error", "code": "<slug>", "message": "human readable" }` — to
  sender only. Codes: `bad-message`, `room-full`, `game-in-progress`,
  `name-taken`, `not-host`, `not-your-turn`, `bad-phase`, `invalid-keep`,
  `cannot-bank`, `need-players`.

## RoomState shape (what `state` broadcasts carry)

Mirrors the existing local-game state in `js/app.js` so rendering code is
reused. `banner` semantics are identical to local play.

```json
{
  "phase": "lobby",            // 'lobby' | 'playing' | 'ended'
  "roomCode": "ABCD",
  "hostId": "a1b2...",
  "players": [
    { "id": "a1b2...", "name": "Sean", "score": 0, "connected": true }
  ],
  "current": 0,                 // index into players; whose turn
  "round": 1,
  "turn": null,                 // null in lobby; else:
  //   { "points": 0, "kept": [], "dice": [], "diceCount": 5, "phase": "preroll" | "rolled" }
  "banner": null,               // null | { "type": "farkle"|"bust"|"win"|"invalid-bank", "title", "emoji", "text" }
  "winner": null,               // null | player index
  "log": ["..."]                // newest first, max 50
}
```

## Game rules on the server (engine semantics — MUST mirror js/app.js)

The engine reuses `DiceLogic` (`js/logic.js`): `hasAnyScore`, `validateKeep`,
`canBank`, `TARGET` (10000). Semantics copied from `js/app.js`:

- `start`: requires ≥2 joined players. Sets `phase:'playing'`, `current:0`,
  `round:1`, fresh turn `{points:0,kept:[],dice:[],diceCount:5,phase:'preroll'}`.
- `roll`: roll `diceCount` dice (uniform 1–6, crypto RNG). `turn.phase='rolled'`.
  If `!hasAnyScore(dice)` → farkle banner; on `continue` → next player.
- `keepAndRoll {keptIdx}`: `validateKeep(turn.dice, keptIdx)`; if invalid →
  `error invalid-keep`. Apply: `points += res.points`, push kept die values to
  `turn.kept`, `remaining = dice.length - keptIdx.length`,
  `diceCount = remaining === 0 ? 5 : remaining` (hot dice), `dice=[]`,
  `phase='preroll'`. If `player.score + turn.points > 10000` → bust banner
  (on `continue` → next player). Otherwise immediately roll (same as `roll`,
  including farkle check).
- `bank {keptIdx}`: validate & apply keep exactly as above. Then
  `canBank(player.score, turn.points)` — if invalid → banner
  `invalid-bank` (turn CONTINUES for that player; `continue` just clears the
  banner, phase stays 'preroll'). If `total > 10000` → bust banner. If
  `total === 10000` → `winner = current`, `phase='ended'`, win banner.
  Else `player.score = total`, next player.
- next player: `current = (current+1) % players.length`; when it wraps to 0,
  `round++`; fresh turn; `banner=null`.
- `newGame` (host, from 'ended'): reset all scores to 0, `phase:'lobby'`,
  `turn:null`, `winner:null`, `banner:null`, keep players & log line.
- Log lines: same spirit as local play (join/leave/farkle/bust/bank/win),
  newest first, capped at 50.

## Join / reconnect / disconnect rules

- Join with a `playerId` already in `players` → reconnect: mark
  `connected:true`, allowed in ANY phase.
- New player: only in `phase:'lobby'`, max **8** players, name trimmed,
  1–20 chars; duplicate names (case-insensitive) → `error name-taken`.
- First player to ever join becomes host (`hostId`). If the host seat is
  empty... host NEVER transfers in v1 (keep simple).
- Disconnect (`webSocketClose`): mark `connected:false`, broadcast state.
  Players are never removed from a started game. In the lobby, a
  disconnected non-host player IS removed.
- The DO attaches `{playerId}` to each socket via
  `serializeAttachment`/`deserializeAttachment` so hibernation wake-ups can
  map sockets back to players.

## Client behavior (frontend PR)

- `js/config.js` (new, plain script): sets `window.DICE_CONFIG = { serverUrl }`.
  Default: `ws(s)://localhost:8787` when hostname is `localhost`/`127.0.0.1`,
  else the placeholder `wss://REPLACE-WITH-YOUR-WORKER.workers.dev` — and a
  `?server=wss://...` URL param always overrides (also carried into the
  room-share link).
- `js/net.js` (new, plain script, `window.DiceNet`): open/close, send, events
  (`onState`, `onJoined`, `onError`, `onConnectionChange`); auto-reconnect
  with backoff 1s,2s,4s,8s max 15s (re-sends `join` with stored playerId on
  reopen); stops after explicit `leave()`.
- Setup screen gains a "Play with friends online" section: create room
  (generate code, connect), join room (code input), name field; joining via
  shared link `index.html?room=ABCD` pre-fills and auto-prompts for name.
  Local pass-and-play mode remains untouched and default.
- Online mode: actions send messages; UI renders only the last received
  `state`. Current player sees action buttons enabled; others see them
  disabled with "<name>'s turn". Banner "continue" button enabled only for
  current player or host. Show room code + share-link copy button + a
  connection status dot. localStorage game persistence (GAME_KEY) and
  lifetime stats apply to LOCAL games only.

## Dev & deploy

- `worker/package.json`: `"type": "module"`, wrangler as devDependency;
  scripts: `dev` → `wrangler dev`, `deploy` → `wrangler deploy`,
  `test` → `node --test test/`.
- `worker/wrangler.jsonc`: name `dice10k-worker`, recent `compatibility_date`,
  DO binding `ROOM` → class `Room`, migration tag v1 with
  `new_sqlite_classes: ["Room"]` (NOT `new_classes` — SQLite backend is what
  the free plan supports).
- Local dev: `npx wrangler dev` (port 8787) + any static server for the site
  root (e.g. `python3 -m http.server 8000`).
- Frontend stays on GitHub Pages; worker deployed with `wrangler deploy`
  (manual, or the `workflow_dispatch` GitHub Action once
  `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` secrets are set).
