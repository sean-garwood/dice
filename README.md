# 🎲 Ten Thousand

A push-your-luck dice game for 1–4 players, playable entirely in the browser.

## What it is

**Local play:** Open the game and choose 1–4 players. Roll, score, and bank points
in the same browser without a server. Game state and lifetime stats live in
`localStorage`.

**Online play:** Invite friends to a room with a generated code, join via shared
link, and play over WebSockets. One person rolls the dice for all; the backend
validates every move and broadcasts game state in real-time.

## How to play online

**Create a room:** Click "Play with friends online" on the setup screen, generate a
4-letter code, and share the link.

**Join:** Friends visit the shared link, enter their name, and wait. When everyone
is ready, the host (the one who created the room) taps **Start game**.

**Play:** The current player sees action buttons; everyone else watches their turn.
Farkles, busts, and wins are broadcast live.

## Architecture

- **Frontend:** Static site (GitHub Pages) — HTML, CSS, plain JavaScript. No build
  step, no modules.
- **Backend:** Cloudflare Worker with one SQLite-backed Durable Object per room.
  Validates every action and broadcasts full state over WebSocket.
- **Game engine:** `js/logic.js` (pure functions for scoring/validation) runs on
  both client and server, ensuring identical rules.
- **Hosting:** Frontend at GitHub Pages (free); Worker on Cloudflare's free plan
  (see **Free-tier guardrails** below).

For protocol details (message shapes, state structure, error codes), see
`docs/PROTOCOL.md`.

## Rules

- **Win condition:** be the first to reach **exactly 10,000** points.
- If your banked score plus the points on the table ever *exceeds* 10,000, you
  **bust**: your turn ends immediately and everything accrued this turn is lost.
- Each turn starts by rolling all five six-sided dice.
- **Scoring:**
  | Dice | Points |
  |---|---|
  | Lone 5 | 50 |
  | Lone 1 | 100 |
  | Three of a kind | 100 × face value (three 2s = 200) |
  | Three 1s | 1,000 |
  | Straight (1–5 or 2–6) | 1,000 |
- After each roll you must set aside at least one scoring die, and every die you
  set aside must add to the score — you can't leave junk in the store.
- You may not break up a three-of-a-kind if that would lower the points on the
  table: keep all three or leave them all behind.
- After setting dice aside, either **bank** the table points (ending your turn)
  or reroll the remaining dice to build a bigger total.
- A roll with no scoring dice is a **farkle**: the turn ends and the table
  points blow up.
- If all five dice score, that's **hot dice** — pick all five back up and keep
  rolling with your points intact.

Think of your turn as a store of potential points that blows up if a roll can't
score.

## Local development

**Frontend only (local pass-and-play):** Serve the folder from the repo root:

```sh
python3 -m http.server 8000
# Visit http://localhost:8000
```

**Full stack (with online multiplayer):** In one terminal, start the static site
(as above). In another, start the Worker backend:

```sh
cd worker
npm install
npx wrangler dev
# Runs on http://localhost:8787
```

Then visit `http://localhost:8000`. The game will detect `localhost` and connect
to `ws://localhost:8787`. To override the server URL, pass it as a query
parameter: `?server=wss://your-worker.workers.dev`.

**Tests:** Game logic is pure functions covered by Node tests:

```sh
node test/logic.test.js      # frontend logic
cd worker && npm test         # backend logic (after 'npm install')
```

GitHub Actions runs both on every push and pull request (see `.github/workflows/ci.yml`).

## Deploying the frontend

The repo is set up for GitHub Pages. One-time setup:

1. Go to **Settings → Pages** in this repository.
2. Set **Source** to **GitHub Actions**.
3. Push to `main` (or manually trigger the workflow).

The game will be live at `https://<user>.github.io/dice/`.

## Deploying the Worker

The backend is deployed separately from the static site using Wrangler.

**One-time setup:**

1. Create a free Cloudflare account at https://www.cloudflare.com/products/workers/.
2. Log in locally: `npx wrangler login` (follow the browser prompts).

**Deploy:**

```sh
cd worker
npm install
npx wrangler deploy
```

The Worker will be live at `https://dice10k-worker.<account>.workers.dev/`.

**Update the frontend to use your deployed Worker:**

Edit `js/config.js` and set `serverUrl` to your Worker's URL (or pass it as a
`?server=wss://...` query parameter, which is carried into room-share links).

**Automated deployments (optional):** Use the GitHub Action at
`.github/workflows/deploy-worker.yml`:

1. Create a Cloudflare API token using the **Edit Cloudflare Workers** template:
   https://dash.cloudflare.com/profile/api-tokens. Copy the token.
2. In the repo **Settings → Secrets and variables → Actions**, add:
   - `CLOUDFLARE_API_TOKEN`: your API token
   - `CLOUDFLARE_ACCOUNT_ID`: your account ID (find it at
     https://dash.cloudflare.com/profile/account-resources in the "API" section)
3. Go to **Actions** and manually trigger **Deploy Worker** as needed, or commit
   to trigger the CI workflow first.

## Free-tier guardrails

This game is built to run free on Cloudflare's Workers plan:

- **Durable Objects:** Must use SQLite storage backend (`new_sqlite_classes` in
  `wrangler.jsonc`). This is what enables them on the free plan; `new_classes`
  is not supported.
- **Limits:** 100,000 requests/day, 13,000 GB-seconds/day duration, 5 GB storage.
  A typical game night (8 players, ~20 turns, ~2 minutes) uses negligible
  bandwidth and storage.
- **WebSocket Hibernation:** Idle connections use the Hibernation API to avoid
  burning duration. Reconnections are automatic.

See https://developers.cloudflare.com/durable-objects/platform/pricing/ for
details.
