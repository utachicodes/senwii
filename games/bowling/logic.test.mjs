import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, scoreRolls, standardPins, frameCards, previewPath, PATTERNS, LANE, HEADPIN_Z } from './logic.js';

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

// ── 10th frame: strike then non-strike keeps the leftovers ─────────────────
function intoTenth(g) {
  for (let f = 0; f < 9; f += 1) { knockN(g, 0); knockN(g, 0); }
  assert.equal(g.frameIndex, 9);
}

test('10th frame X then 7: the bonus ball faces the 3 left standing, not a fresh rack', () => {
  const g = new Game();
  intoTenth(g);
  knockAll(g);                     // X
  knockN(g, 7);                    // 7 of a fresh rack
  assert.equal(g.state, 'aim', 'bonus ball still to come');
  assert.equal(g.standingCount(), 3, 'the leftovers stay');
  knockAll(g);                     // converts the 3
  assert.equal(g.state, 'over');
  assert.deepEqual(g.rolls.slice(-3), [10, 7, 3]);
  assert.deepEqual(frameCards(g.rolls)[9].marks, ['X', '7', '/']);
  assert.equal(g.score(), 20);
});

test('10th frame X X: the third ball gets a fresh rack', () => {
  const g = new Game();
  intoTenth(g);
  knockAll(g);
  knockAll(g);
  assert.equal(g.state, 'aim');
  assert.equal(g.standingCount(), 10);
  knockN(g, 4);
  assert.equal(g.state, 'over');
  assert.equal(g.score(), 24);
});

// ── settled carries the strike/spare verdict ───────────────────────────────
function settledEvents(g) {
  const out = [];
  g.onEvent = (e) => { if (e.type === 'settled') out.push(e); };
  return out;
}

test('settled flags a normal spare and a strike', () => {
  const g = new Game();
  const ev = settledEvents(g);
  knockN(g, 6); knockAll(g);       // 6 /
  knockAll(g);                     // X
  knockN(g, 3); knockN(g, 2);      // open
  assert.deepEqual(ev.map((e) => [e.strike, e.spare]),
    [[false, false], [false, true], [true, false], [false, false], [false, false]]);
});

test('settled flags in the 10th: bonus strikes are strikes, X-then-9 is no spare', () => {
  const g = new Game();
  intoTenth(g);
  const ev = settledEvents(g);
  knockAll(g); knockN(g, 9); knockN(g, 0);        // X 9 -
  assert.deepEqual(ev.map((e) => [e.strike, e.spare]), [[true, false], [false, false], [false, false]]);
  const h = new Game();
  intoTenth(h);
  const ev2 = settledEvents(h);
  knockN(h, 6); knockAll(h); knockAll(h);         // 6 / X
  assert.deepEqual(ev2.map((e) => [e.strike, e.spare]), [[false, false], [false, true], [true, false]]);
});

// ── Robustness and pinfall ─────────────────────────────────────────────────
function rollOut(g) {
  for (let i = 0; i < 5000 && g.state === 'roll'; i += 1) g.update(i * 16, 0.016);
}

test('a NaN spin/power from a bad sensor read still bowls a real ball', () => {
  const g = new Game();
  g.roll(NaN, 0, NaN);
  assert.ok(Number.isFinite(g.ball.spin) && Number.isFinite(g.ball.vz));
  rollOut(g);
  assert.ok(g.rolls[0] > 0, `a straight ball hits pins (${g.rolls[0]})`);
});

test('pinfall is graded: mid-power off-centre rolls leave partial counts', () => {
  const counts = new Set();
  for (let tx = -0.3; tx <= 0.3; tx += 0.05) {
    const g = new Game();
    g.roll(0.5, Math.atan2(tx, HEADPIN_Z), 0);
    rollOut(g);
    counts.add(g.rolls[0]);
  }
  const partial = [...counts].filter((n) => n > 0 && n < 8);
  assert.ok(partial.length >= 2, `several partial counts, got ${[...counts].sort((a, b) => a - b)}`);
});

test('a gentle nudge tips one pin without felling the rack', () => {
  const g = new Game();
  g.knockPin(g.pins[9], 0, 2);     // back-row corner, pushed into the pit
  assert.equal(g.standingCount(), 9);
  const h = new Game();
  h.knockPin(h.pins[0], 0, 0.5);   // below the topple threshold: a wobble
  assert.equal(h.standingCount(), 10);
});

test('the ball is back on the approach after the pins are swept', () => {
  const g = new Game();
  g.roll(0.5, 0.02, 0);
  rollOut(g);
  assert.equal(g.state, 'aim');
  assert.equal(g.ball.z, 0);
  assert.equal(g.ball.x, 0);
});

test('previewPath follows the real ball and the hook bends it', () => {
  const straight = previewPath(0, 0, 0);
  const hooked = previewPath(0, 0, 0.5);
  assert.ok(straight.at(-1).z > HEADPIN_Z - 1, 'reaches the pin deck');
  assert.ok(Math.abs(straight.at(-1).x) < 1e-6);
  assert.ok(hooked.at(-1).x > 0.1, `positive spin breaks right (${hooked.at(-1).x.toFixed(2)})`);
});

test('patterns name an icon (logic stays DOM-free, no emoji)', () => {
  for (const p of PATTERNS) {
    assert.equal(typeof p.icon, 'string');
    assert.equal(p.emoji, undefined);
  }
});
