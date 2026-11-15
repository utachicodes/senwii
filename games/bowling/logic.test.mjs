import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, scoreRolls, standardPins, LANE } from './logic.js';

// ── Scoring algorithm, tested against the flat rolls[] list directly ──────
test('a perfect game (12 strikes) scores 300', () => {
  assert.equal(scoreRolls(Array(12).fill(10)), 300);
});

test('an all-gutter game scores 0', () => {
  assert.equal(scoreRolls(Array(20).fill(0)), 0);
});

test('an open frame sums both balls, repeated for ten frames', () => {
  const rolls = Array(10).fill([4, 3]).flat();
  assert.equal(scoreRolls(rolls), 70);
});

test('a spare adds the next ball as bonus', () => {
  // Frame 1: 6/4 (spare) + next ball 5 → 10+5=15. Frame 2: 5,3 → 8. Rest gutters.
  const rolls = [6, 4, 5, 3, ...Array(16).fill(0)];
  assert.equal(scoreRolls(rolls), 15 + 8);
});

test('a strike adds the next two balls as bonus', () => {
  // Frame 1: strike + next two balls (4,3) → 10+4+3=17. Frame 2: 4,3 → 7. Rest gutters.
  const rolls = [10, 4, 3, ...Array(16).fill(0)];
  assert.equal(scoreRolls(rolls), 17 + 7);
});

test('all spares (5/5) with a final 5 scores 150', () => {
  const rolls = [...Array(9).fill([5, 5]).flat(), 5, 5, 5];
  assert.equal(scoreRolls(rolls), 150);
});

// ── Frame/ball bookkeeping, driven directly (bypassing ball physics) ──────
function knockAll(g) {
  g.standingAtRollStart = g.standingCount();   // what roll() would capture
  for (const p of g.pins) p.standing = false;
  g.finishRoll();
}
function knockN(g, n) {
  g.standingAtRollStart = g.standingCount();
  let left = n;
  for (const p of g.pins) {
    if (left <= 0) break;
    if (p.standing) { p.standing = false; left -= 1; }
  }
  g.finishRoll();
}

test('a strike on the first ball ends the frame immediately', () => {
  const g = new Game();
  knockAll(g);
  assert.equal(g.frameIndex, 1, 'advanced to frame 2');
  assert.equal(g.ballInFrame, 0);
  assert.equal(g.rolls.length, 1);
  assert.equal(g.standingCount(), 10, 'fresh rack');
});

test('a non-strike first ball leaves the second ball of the same frame', () => {
  const g = new Game();
  knockN(g, 7);
  assert.equal(g.frameIndex, 0, 'still frame 1');
  assert.equal(g.ballInFrame, 1);
  assert.equal(g.standingCount(), 3, 'the three survivors stay down for ball two');
  assert.equal(g.state, 'aim');
});

test('a game of all strikes plays 12 balls and scores 300', () => {
  const g = new Game();
  let balls = 0;
  while (g.state !== 'over' && balls < 20) { knockAll(g); balls += 1; }
  assert.equal(g.state, 'over');
  assert.equal(balls, 12, 'ten strikes plus two 10th-frame bonus balls');
  assert.equal(g.score(), 300);
});

test('an all-gutter game plays 20 balls and scores 0, then stops', () => {
  const g = new Game();
  let balls = 0;
  while (g.state !== 'over' && balls < 25) { knockN(g, 0); balls += 1; }
  assert.equal(g.state, 'over');
  assert.equal(balls, 20);
  assert.equal(g.score(), 0);
});

test('a 10th-frame spare earns exactly one bonus ball, not two', () => {
  const g = new Game();
  // Frames 1-9: open frames of 0 pins each — two gutter balls per frame.
  for (let f = 0; f < 9; f += 1) { knockN(g, 0); knockN(g, 0); }
  assert.equal(g.frameIndex, 9, 'into the 10th');
  knockN(g, 6);     // ball 1 of the 10th
  assert.equal(g.state, 'aim');
  knockN(g, 4);     // ball 2 — spare, rack resets for the bonus ball
  assert.equal(g.state, 'aim', 'bonus ball still to come');
  assert.equal(g.standingCount(), 10, 'rack reset for the bonus ball');
  knockN(g, 9);     // bonus ball
  assert.equal(g.state, 'over');
  assert.equal(g.rolls.length, 21);
  assert.equal(g.score(), 19); // 10th-frame spare (6+4=10) plus its one bonus ball (9)
});

test('an open 10th frame ends the game after two balls', () => {
  const g = new Game();
  for (let f = 0; f < 9; f += 1) { knockN(g, 0); knockN(g, 0); }
  knockN(g, 3);
  knockN(g, 4);
  assert.equal(g.state, 'over');
  assert.equal(g.rolls.length, 20);
});

// ── Pin layout sanity ──────────────────────────────────────────────────────
test('standardPins lays out a 1-2-3-4 triangle, all standing', () => {
  const pins = standardPins();
  assert.equal(pins.length, 10);
  assert.ok(pins.every((p) => p.standing));
  // Unique ids, headpin on the centerline.
  assert.equal(new Set(pins.map((p) => p.id)).size, 10);
  assert.equal(pins[0].x, 0, 'headpin is centered');
});

// ── Physics integration: a real roll() + update() loop ─────────────────────
test('a full-power straight roll eventually settles and leaves the ball down-lane', () => {
  const g = new Game();
  g.roll(1, 0);
  assert.equal(g.state, 'roll');
  let now = 0;
  for (let i = 0; i < 2000 && g.state === 'roll'; i += 1) { now += 16; g.update(now, 0.016); }
  assert.equal(g.state, 'aim', 'settled back to aim (open frame) or ended the frame');
  assert.ok(g.rolls.length >= 1);
});

test('an aim far enough off centerline sends the ball into the gutter for 0 pins', () => {
  const g = new Game();
  // An extreme aim angle crosses the lane's half-width almost immediately.
  g.roll(1, Math.PI / 2.2);
  let now = 0;
  for (let i = 0; i < 2000 && g.state === 'roll'; i += 1) { now += 16; g.update(now, 0.016); }
  assert.equal(g.rolls[0], 0, 'gutter ball knocks nothing down');
});

test('update() is a no-op outside the roll state', () => {
  const g = new Game();
  const before = JSON.stringify(g.ball);
  g.update(0, 0.016);
  assert.equal(JSON.stringify(g.ball), before);
});

test('LANE half-width is positive and narrower than the full lane length', () => {
  assert.ok(LANE.HALF_WIDTH > 0);
  assert.ok(LANE.HALF_WIDTH < LANE.LENGTH);
});
