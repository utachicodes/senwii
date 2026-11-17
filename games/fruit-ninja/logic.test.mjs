import test from 'node:test';
import assert from 'node:assert/strict';
import { FruitNinja, FruitMatch, FIELD_H, MAX_BOARDS } from './logic.js';

/**
 * The eight mechanics that had to survive the 2D→3D port.
 *
 * These are the same eight behaviours the 2D build was verified against. The
 * coordinate literals differ because the units changed from window pixels to
 * world units — the assertions did not.
 */

/** A game with spawning suppressed, so tests control the board exactly. */
function game() {
  const g = new FruitNinja({ aspect: 16 / 9 });
  g.start(0);
  g.state.nextSpawn = Infinity;
  return g;
}

function put(g, x, y, bomb = false) {
  g.fruits.push({
    x, y, vx: 0, vy: 0, r: 0.65, rot: 0, spin: 0,
    spinAxis: { x: 0, y: 1, z: 0 }, bomb, kind: { rind: 0, flesh: 0 }, id: 1,
  });
  return g.fruits[g.fruits.length - 1];
}

/** Sweep the pointer across the field, stepping the real update loop. */
function sweep(g, x0, x1, y, steps, dtMs, clock) {
  for (let i = 0; i <= steps; i += 1) {
    clock.t += dtMs;
    g.setCursor(x0 + ((x1 - x0) * i) / steps, y, clock.t);
    g.state.nextSpawn = Infinity;
    g.update(clock.t, dtMs / 1000);
  }
}

test('a fast slash slices the fruit into two halves with juice', () => {
  const g = game();
  const clock = { t: 0 };
  put(g, 0, 0);
  sweep(g, -3, 3, 0, 5, 16, clock);
  assert.equal(g.fruits.length, 0, 'fruit consumed');
  assert.equal(g.halves.length, 2, 'two halves');
  assert.ok(g.particles.length > 0, 'juice particles');
  assert.ok(g.state.score > 0, 'scored');
});

test('a slow drag through a fruit does not slice it', () => {
  const g = game();
  const clock = { t: 0 };
  put(g, 0, 0);
  // 0.02 world units per 16ms = 1.25 u/s, well under MIN_SLICE_SPEED (3.25).
  sweep(g, -0.1, 0.1, 0, 10, 16, clock);
  assert.equal(g.fruits.length, 1, 'fruit survives');
  assert.equal(g.state.score, 0, 'no score');
});

test('a fast slash that misses does not slice', () => {
  const g = game();
  const clock = { t: 0 };
  put(g, 0, 0);
  sweep(g, -3, 3, 3.5, 5, 16, clock);   // same speed, far above the fruit
  assert.equal(g.fruits.length, 1, 'fruit survives');
  assert.equal(g.state.score, 0, 'no score');
});

test('slicing two fruits in one swipe pays a combo bonus', () => {
  const g = game();
  const clock = { t: 0 };
  put(g, -1.2, 0);
  put(g, 1.2, 0);
  sweep(g, -4, 4, 0, 6, 16, clock);
  assert.equal(g.state.combo, 2, 'combo counted');
  // 1 for the first + (1 + 2) for the second = 4, vs 2 with no bonus.
  assert.ok(g.state.score >= 3, `combo bonus applied (got ${g.state.score})`);
});

test('slicing a bomb ends the game', () => {
  const g = game();
  const clock = { t: 0 };
  put(g, 0, 0, true);
  sweep(g, -3, 3, 0, 5, 16, clock);
  assert.equal(g.state.phase, 'over', 'game over');
  assert.ok(g.particles.length > 50, 'explosion');
});

test('a bomb that falls off the bottom costs nothing', () => {
  const g = game();
  const f = put(g, 0, -FIELD_H / 2 - 2, true);
  f.vy = -1;
  g.update(16, 0.016);
  assert.equal(g.state.lives, 3, 'lives untouched');
  assert.equal(g.state.phase, 'playing', 'still playing');
  assert.equal(g.fruits.length, 0, 'bomb removed');
});

test('a fruit that falls off the bottom costs a life', () => {
  const g = game();
  const f = put(g, 0, -FIELD_H / 2 - 2);
  f.vy = -1;
  g.update(16, 0.016);
  assert.equal(g.state.lives, 2, 'one life lost');
  assert.equal(g.fruits.length, 0, 'fruit removed');
});

test('losing the last life ends the game', () => {
  const g = game();
  g.state.lives = 1;
  const f = put(g, 0, -FIELD_H / 2 - 2);
  f.vy = -1;
  g.update(16, 0.016);
  assert.equal(g.state.lives, 0);
  assert.equal(g.state.phase, 'over', 'game over');
});

// ── Practice mode and criticals ──────────────────────────────────────────────

function practiceGame(rng = () => 0.99) {
  const g = new FruitNinja({ aspect: 16 / 9, infiniteLives: true, rng });
  g.start(0);
  g.state.nextSpawn = Infinity;
  return g;
}

test('practice: dropped fruit never costs a life or ends the run', () => {
  const g = practiceGame();
  for (let n = 0; n < 10; n += 1) {
    const f = put(g, 0, -FIELD_H / 2 - 2);
    f.vy = -1;
    g.update(16 * (n + 1), 0.016);
  }
  assert.equal(g.state.lives, 3, 'lives untouched after 10 drops');
  assert.equal(g.state.phase, 'playing', 'still playing');
});

test('practice: a bomb explodes and costs points, not the run', () => {
  const g = practiceGame();
  g.state.score = 25;
  const clock = { t: 0 };
  put(g, 0, 0, true);
  sweep(g, -3, 3, 0, 5, 16, clock);
  assert.equal(g.state.phase, 'playing', 'run continues');
  assert.equal(g.state.score, 15, 'bomb penalty applied');
  assert.ok(g.particles.length > 50, 'still explodes visually');
});

test('practice: bomb penalty never takes the score negative', () => {
  const g = practiceGame();
  g.state.score = 3;
  const clock = { t: 0 };
  put(g, 0, 0, true);
  sweep(g, -3, 3, 0, 5, 16, clock);
  assert.equal(g.state.score, 0);
});

test('a critical slice pays +10 and is flagged in the event', () => {
  const events = [];
  const g = new FruitNinja({ aspect: 16 / 9, rng: () => 0, onEvent: (e) => events.push(e) });
  g.start(0);
  g.state.nextSpawn = Infinity;
  const clock = { t: 0 };
  put(g, 0, 0);
  sweep(g, -3, 3, 0, 5, 16, clock);
  const slice = events.find((e) => e.type === 'slice');
  assert.equal(slice.critical, true);
  assert.equal(slice.gained, 11, '1 base + 10 critical');
  assert.equal(g.state.score, 11);
});

test('spawning emits a launch event (the throw sound hook)', () => {
  const events = [];
  const g = new FruitNinja({ aspect: 16 / 9, onEvent: (e) => events.push(e) });
  g.start(0);
  g.spawn(false, 1000);
  g.spawn(true, 1000);
  const launches = events.filter((e) => e.type === 'launch');
  assert.equal(launches.length, 2);
  assert.deepEqual(launches.map((e) => e.bomb), [false, true]);
});

// ── Multiplayer: several phones on the same board ───────────────────────────
// The server tags every packet with a `slot` (see server.js); logic.js fans
// out its single blade into one per connected phone. These tests exercise
// slots directly rather than through a socket, same as every other test here.

/** Sweep a named slot's blade across the field. */
function sweepSlot(g, slot, x0, x1, y, steps, dtMs, clock) {
  for (let i = 0; i <= steps; i += 1) {
    clock.t += dtMs;
    g.setCursor(x0 + ((x1 - x0) * i) / steps, y, clock.t, slot);
    g.state.nextSpawn = Infinity;
    g.update(clock.t, dtMs / 1000);
  }
}

test('two players slicing at once keep separate scores and combos', () => {
  const g = game();
  const clock = { t: 0 };
  put(g, -1.2, 0);
  sweepSlot(g, 0, -4, 4, 0, 6, 16, clock);   // slot 0 slices the left fruit
  put(g, 1.2, 0);
  sweepSlot(g, 1, -4, 4, 0, 6, 16, clock);   // slot 1 slices the right fruit

  const p0 = g.getPlayer(0);
  const p1 = g.getPlayer(1);
  assert.equal(g.fruits.length, 0, 'both fruit sliced');
  assert.ok(p0.score > 0 && p1.score > 0, 'both players scored');
  assert.equal(g.state.score, p0.score + p1.score, 'combined total is the sum');
});

test('each slice event carries the slot that cut it', () => {
  const events = [];
  const g = new FruitNinja({ aspect: 16 / 9, onEvent: (e) => events.push(e) });
  g.start(0);
  g.state.nextSpawn = Infinity;
  const clock = { t: 0 };
  put(g, 0, 0);
  sweepSlot(g, 2, -3, 3, 0, 5, 16, clock);
  const slice = events.find((e) => e.type === 'slice');
  assert.equal(slice.slot, 2);
  assert.equal(slice.playerScore, g.getPlayer(2).score);
});

test('a slot that goes quiet stops slicing — no ghost blade', () => {
  const g = game();
  const clock = { t: 0 };
  // Slot 0 takes one fast real swing, then falls silent (as if the phone
  // disconnected mid-swing) — its last segment sits frozen at x≈4.
  sweepSlot(g, 0, -4, 4, 0, 6, 16, clock);
  assert.ok(g.getPlayer(0).trail.speed() > 0, 'sanity: that swing really was fast');

  // Nothing else touches the board for 300ms — comfortably past the 200ms
  // staleness cutoff — then a fruit drifts across the frozen blade's exact
  // former position, moving too slowly to be a real slice by anyone.
  for (let i = 0; i < 20; i += 1) { clock.t += 16; g.update(clock.t, 0.016); }
  put(g, 4, 0);
  for (let i = 0; i < 10; i += 1) { clock.t += 16; g.update(clock.t, 0.016); }
  assert.equal(g.fruits.length, 1, 'the stale blade did not cut it');
});

test('start() resets every known player\'s score but keeps their slot', () => {
  const g = game();
  const clock = { t: 0 };
  put(g, -1.2, 0);
  sweepSlot(g, 0, -4, 4, 0, 6, 16, clock);
  put(g, 1.2, 0);
  sweepSlot(g, 1, -4, 4, 0, 6, 16, clock);
  assert.ok(g.getPlayer(0).score > 0 && g.getPlayer(1).score > 0);

  g.start(1000);
  assert.equal(g.getPlayer(0).score, 0);
  assert.equal(g.getPlayer(1).score, 0);
  assert.equal(g.state.score, 0);
  assert.ok(g.players.has(0) && g.players.has(1), 'slots survive the reset');
});

test('practice: a bomb costs both the shared total and the popping player', () => {
  const g = practiceGame();
  g.state.score = 20;
  g.getPlayer(1).score = 8;
  const clock = { t: 0 };
  put(g, 0, 0, true);
  sweepSlot(g, 1, -3, 3, 0, 5, 16, clock);
  assert.equal(g.state.phase, 'playing');
  assert.equal(g.state.score, 10, 'shared total docked');
  assert.equal(g.getPlayer(1).score, 0, 'the popping player\'s own score docked and floored at 0');
});

test('the shared life pool costs everyone, regardless of who is playing', () => {
  const g = game();
  // Two players connected (slot 0 and 1), but a miss is not slot-scoped.
  g.getPlayer(1);
  const f = put(g, 0, -FIELD_H / 2 - 2);
  f.vy = -1;
  g.update(16, 0.016);
  assert.equal(g.state.lives, 2, 'one shared life lost');
});

// ── Multiplayer: one independent board per player ───────────────────────────

/** A running match with spawning suppressed so tests place fruit by hand. */
function match(slots, opts = {}) {
  const events = [];
  const m = new FruitMatch({ onEvent: (e) => events.push(e), ...opts });
  m.start(slots, 0);
  for (const b of m.boards.values()) b.state.nextSpawn = Infinity;
  return { m, events };
}
const putOn = (m, slot, x, y, bomb = false) => {
  const f = {
    x, y, vx: 0, vy: 0, r: 0.65, rot: 0, spin: 0,
    spinAxis: { x: 0, y: 1, z: 0 }, bomb, kind: { rind: 0, flesh: 0, splat: 0, name: 'x' }, id: 1,
  };
  m.board(slot).fruits.push(f);
  return f;
};
function swing(m, slot, clock, x0 = -3, x1 = 3, y = 0) {
  for (let i = 0; i <= 5; i += 1) {
    clock.t += 16;
    m.setCursor(slot, x0 + ((x1 - x0) * i) / 5, y, clock.t);
    for (const b of m.boards.values()) b.state.nextSpawn = Infinity;
    m.update(clock.t, 0.016);
  }
}
/** Let `n` fruit hit the floor on a board, one frame at a time. */
function dropMisses(m, slot, clock, n) {
  for (let i = 0; i < n; i += 1) {
    const f = putOn(m, slot, 0, -6);
    f.vy = -5;
    for (let k = 0; k < 10 && m.board(slot).fruits.includes(f); k += 1) {
      clock.t += 16;
      for (const b of m.boards.values()) b.state.nextSpawn = Infinity;
      m.update(clock.t, 0.016);
    }
  }
}

test('a solo game ends after three missed fruit (no more endless mode)', () => {
  const { m, events } = match([0]);
  const clock = { t: 0 };
  dropMisses(m, 0, clock, 2);
  assert.equal(m.phase, 'playing');
  assert.equal(m.board(0).state.lives, 1);
  dropMisses(m, 0, clock, 1);
  assert.equal(m.phase, 'over');
  assert.equal(events.filter((e) => e.type === 'matchover').length, 1);
  assert.equal(m.result.solo, true);
});

test('a bomb ends that player\'s run at once', () => {
  const { m, events } = match([0]);
  putOn(m, 0, 0, 0, true);
  swing(m, 0, { t: 0 });
  assert.equal(m.phase, 'over');
  assert.ok(events.some((e) => e.type === 'bomb' && e.fatal));
  assert.ok(events.some((e) => e.type === 'out' && e.slot === 0 && e.reason === 'out'));
});

test('practice mode never ends: misses and bombs cost nothing but points', () => {
  const { m } = match([0], { infiniteLives: true });
  const clock = { t: 0 };
  dropMisses(m, 0, clock, 6);
  assert.equal(m.phase, 'playing');
  putOn(m, 0, 0, 0, true);
  swing(m, 0, clock);
  assert.equal(m.phase, 'playing');
});

test('each player has their own fruit, lives and score', () => {
  const { m } = match([0, 1, 2]);
  assert.deepEqual(m.slots, [0, 1, 2]);
  const clock = { t: 0 };
  putOn(m, 1, 0, 0);
  swing(m, 1, clock);                       // only P2 slices
  assert.ok(m.board(1).state.score > 0);
  assert.equal(m.board(0).state.score, 0);
  assert.equal(m.board(2).state.score, 0);
  dropMisses(m, 2, clock, 1);               // only P3 misses
  assert.equal(m.board(2).state.lives, 2);
  assert.equal(m.board(0).state.lives, 3);
  assert.equal(m.board(1).state.lives, 3);
  assert.equal(m.board(0).fruits.length, 0, 'P2\'s fruit never appears on P1\'s board');
});

test('a blade only cuts on its own board', () => {
  const { m } = match([0, 1]);
  const f = putOn(m, 0, 0, 0);              // fruit on P1's board…
  swing(m, 1, { t: 0 });                    // …P2 swings through the same spot
  assert.ok(m.board(0).fruits.includes(f), 'untouched');
  assert.equal(m.board(0).state.score, 0);
});

test('one player going out does not end the match for the others', () => {
  const { m, events } = match([0, 1]);
  const clock = { t: 0 };
  dropMisses(m, 0, clock, 3);
  assert.equal(m.isOver(0), true);
  assert.equal(m.isOver(1), false);
  assert.equal(m.phase, 'playing');
  assert.ok(events.some((e) => e.type === 'out' && e.slot === 0));
  assert.ok(!events.some((e) => e.type === 'matchover'));
});

test('the match ends when the last board falls; highest score wins', () => {
  const { m, events } = match([0, 1]);
  const clock = { t: 0 };
  putOn(m, 1, 0, 0);
  swing(m, 1, clock);                       // P2 scores
  dropMisses(m, 0, clock, 3);               // P1 out with 0
  assert.equal(m.phase, 'playing');
  dropMisses(m, 1, clock, 3);               // P2 out
  assert.equal(m.phase, 'over');
  const over = events.find((e) => e.type === 'matchover');
  assert.deepEqual(over.winners, [1]);
  assert.deepEqual(over.standings.map((s) => s.slot), [1, 0]);
  assert.deepEqual(over.standings.map((s) => s.rank), [1, 2]);
});

test('a lower-ranked-at-the-time player can still overtake someone already out', () => {
  const { m } = match([0, 1]);
  const clock = { t: 0 };
  putOn(m, 0, 0, 0);
  swing(m, 0, clock);
  dropMisses(m, 0, clock, 3);
  const p1 = m.board(0).state.score;
  assert.ok(p1 > 0 && m.phase === 'playing');
  for (let i = 0; i < p1 + 1; i += 1) { putOn(m, 1, 0, 0); swing(m, 1, clock); }
  dropMisses(m, 1, clock, 3);
  assert.equal(m.phase, 'over');
  assert.ok(m.board(1).state.score > p1);
  assert.deepEqual(m.result.winners, [1]);
});

test('equal scores: the one who lasted longer ranks higher', () => {
  const { m } = match([0, 1]);
  const clock = { t: 0 };
  dropMisses(m, 0, clock, 3);               // P1 out first, score 0
  dropMisses(m, 1, clock, 3);               // P2 out later, score 0
  assert.deepEqual(m.result.standings.map((s) => s.slot), [1, 0]);
  assert.deepEqual(m.result.winners, [1]);
});

test('a late joiner gets a fresh board immediately; duplicates and out-of-range are refused', () => {
  const { m, events } = match([0]);
  assert.equal(m.join(1, 100), true);
  assert.deepEqual(m.slots, [0, 1]);
  assert.equal(m.board(1).state.lives, 3);
  assert.equal(m.board(1).state.phase, 'playing');
  assert.ok(events.some((e) => e.type === 'join' && e.slot === 1));
  assert.equal(m.join(1, 100), false, 'already seated');
  assert.equal(m.join(MAX_BOARDS, 100), false, 'no fifth player');
  assert.equal(m.join(-1, 100), false);
});

test('a player who leaves forfeits but keeps their score on the results', () => {
  const { m, events } = match([0, 1]);
  const clock = { t: 0 };
  putOn(m, 0, 0, 0);
  swing(m, 0, clock);
  const score = m.board(0).state.score;
  assert.equal(m.leave(0, clock.t), true);
  assert.ok(events.some((e) => e.type === 'out' && e.slot === 0 && e.reason === 'left'));
  assert.equal(m.phase, 'playing', 'the other player carries on');
  dropMisses(m, 1, clock, 3);
  assert.equal(m.phase, 'over');
  assert.equal(m.result.standings.find((s) => s.slot === 0).score, score);
  assert.equal(m.leave(0, clock.t), false, 'already out');
});

test('everyone leaving ends the match instead of hanging it', () => {
  const { m } = match([0, 1]);
  m.leave(0, 10);
  m.leave(1, 10);
  assert.equal(m.phase, 'over');
});

test('an eliminated board takes no further input', () => {
  const { m } = match([0, 1]);
  const clock = { t: 0 };
  dropMisses(m, 0, clock, 3);
  putOn(m, 0, 0, 0);
  swing(m, 0, clock);
  assert.equal(m.board(0).state.score, 0);
});

test('each board spawns on its own width', () => {
  const m = new FruitMatch();
  m.start([0, 1], 0, { 0: 0.6, 1: 1.8 });
  assert.ok(Math.abs(m.board(0).w - 9 * 0.6) < 1e-9);
  assert.ok(Math.abs(m.board(1).w - 9 * 1.8) < 1e-9);
  m.setAspect(0, 1);
  assert.equal(m.board(0).w, 9);
});

test('restarting resets everyone and drops boards that are no longer connected', () => {
  const { m } = match([0, 1, 2]);
  const clock = { t: 0 };
  putOn(m, 1, 0, 0);
  swing(m, 1, clock);
  m.start([1, 3], 5000);
  assert.deepEqual(m.slots, [1, 3]);
  assert.equal(m.board(1).state.score, 0);
  assert.equal(m.phase, 'playing');
  assert.equal(m.result, null);
  m.start([], 6000);
  assert.deepEqual(m.slots, [0], 'nobody connected → desk player on slot 0');
});

test('fruit still in the air when a player goes out finishes falling and clears', () => {
  const { m } = match([0]);
  const clock = { t: 0 };
  const f = putOn(m, 0, 0, 3);
  f.vy = 10;
  dropMisses(m, 0, clock, 3);
  assert.equal(m.phase, 'over');
  for (let i = 0; i < 300; i += 1) { clock.t += 16; m.update(clock.t, 0.016); }
  assert.equal(m.board(0).fruits.length, 0, 'nothing frozen mid-air');
});
