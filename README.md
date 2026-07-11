# 🎲 Ten Thousand

A push-your-luck dice game for 1–4 players, playable entirely in the browser — no
server, no build step. Game state and lifetime stats live in `localStorage`, so a
refresh resumes your game and your win/farkle record survives between visits.

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

## Running locally

It's plain HTML/CSS/JS — open `index.html` in a browser, or serve the folder:

```sh
python3 -m http.server 8000
```

## Tests

The scoring/validation logic is pure and covered by Node tests:

```sh
node test/logic.test.js
```

## Deploying to GitHub Pages

A workflow at `.github/workflows/deploy-pages.yml` deploys the repository root
on every push to `main`. One-time setup: in the repo's
**Settings → Pages**, set **Source** to **GitHub Actions**. After the next push
to `main`, the game will be live at `https://<user>.github.io/dice/`.
