# Contributing

SenWii's relay is room-based: every connecting PC gets its own join code and
its own up-to-4 phone slots (see **server.js** and the README's "How it
works"). That's the one piece of architecture worth understanding before you
touch `server.js`, `core/net.js`, or `core/splash.js` — a change that breaks
room isolation or the reclaim-on-navigation handoff is the easiest way to
strand every phone connected to a session.

## Adding a game

A game is any folder under `games/<slug>/` with an `index.html` — the server
finds it on boot, nothing to register. Copy the shape of an existing game
closest to what you're building:

- **Single-player, swing/point-and-press:** `games/shooting-range/` or
  `games/alien-attack/` — both built on `core/channel.js`'s `createChannel()`,
  which wires the relay link, phone A/B buttons, mouse fallback, and the
  speed/debug keyboard shortcuts for you.
- **A duel or 1-vs-AI game:** `games/swordplay/` or `games/table-tennis/`.
- **Heavier, bespoke input handling:** `games/fruit-ninja/` constructs
  `GameLink` directly instead of going through `createChannel()`.

Each game keeps rendering (`game.js`) separate from pure, tested logic
(`logic.js` + `logic.test.mjs`) — run the whole suite with `npm run
test:unit`. A new game should ship with tests for anything that isn't purely
visual: scoring, collision, win conditions, the stuff a reviewer can't verify
by eyeballing a screenshot.

`game.json` is optional and only feeds the launcher card (`title`, `tagline`,
`icon` — a name from `core/icons.js`, `players`). Set `hidden: true` while a game is still rough — it stays
reachable by direct URL but off the menu — and drop it once you're ready for
it to show up for everyone.

If your game launches from the menu or returns to it, call
`consumeLaunchSplash()` / `goHome(audio, link.room)` from `core/splash.js`
(or just pass `room` through `createChannel()`/`GameLink`) — skipping this is
what strands already-connected phones on a navigation.

## Workflow

Fork, branch, open a PR. Keep PRs scoped to one game or one piece of the
relay/engine — a PR that touches `core/` should explain why every game that
imports it still behaves the same.

Run `npm run test:unit` before opening a PR.

Don't commit generated/downloaded assets (models, audio source archives) —
procedural art belongs in the game's own code, and anything large and
third-party should stay out of git.
