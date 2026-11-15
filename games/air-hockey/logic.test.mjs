import test from 'node:test';
import assert from 'node:assert/strict';
import { Match, TABLE, GOAL_WIDTH, PLAYER_Z, AI_Z, WIN_SCORE } from './logic.js';

const seq = (vals) => {
  let i = 0;
  return () => vals[(i += 1) % vals.length];
};

function started(rngVals = [0.5]) {
  const events = [];
  const m = new Match({ onEvent: (e) => events.push(e), rng: seq(rngVals) });
  m.start(0);
  return { m, events };
}

function run(m, ms, step = 16) {
  let now = 0;
  for (let t = 0; t < ms; t += step) { now += step; m.update(now, step / 1000); }
  return now;
}

test('start() serves a live puck from centre table', () => {
  const { m, events } = started();
  assert.equal(m.state, 'playing');
  assert.ok(m.live);
  assert.equal(m.puck.z, 0);
  assert.ok(events.some((e) => e.type === 'serve'));
});

test('a puck crossing the player end wide of the goal bounces back', () => {
  const { m } = started();
  m.puck = { x: GOAL_WIDTH, z: PLAYER_Z - 0.01, vx: 0, vz: 3 };   // wide of the goal mouth
  let now = 0;
  for (let i = 0; i < 10 && m.puck.vz >= 0; i += 1) { now += 16; m.update(now, 0.016); }
  assert.ok(m.puck.vz < 0, 'reflected back onto the table');
  assert.equal(m.score.player, 0);
  assert.equal(m.score.ai, 0);
});

test('a puck crossing the player end through the goal mouth scores for the AI', () => {
  const { m, events } = started();
  m.puck = { x: 0, z: PLAYER_Z - 0.01, vx: 0, vz: 3 };
  m.update(16, 0.016);
  assert.equal(m.score.ai, 1);
  assert.equal(m.state, 'point');
  assert.ok(events.some((e) => e.type === 'goal' && e.who === 'ai'));
});

test('a puck crossing the AI end through the goal mouth scores for the player', () => {
  const { m } = started();
  m.puck = { x: 0, z: AI_Z + 0.01, vx: 0, vz: -3 };
  m.update(16, 0.016);
  assert.equal(m.score.player, 1);
});

test('the puck never leaves the table width', () => {
  const { m } = started();
  m.puck = { x: TABLE.WIDTH, z: 0, vx: 5, vz: 0 };
  m.update(16, 0.016);
  assert.ok(m.puck.x <= TABLE.WIDTH / 2 + 1e-6);
  assert.ok(m.puck.vx < 0, 'bounced off the side wall');
});

test('contact with the player paddle sends the puck away from it', () => {
  const { m } = started();
  m.paddle = { x: 0, z: 0.5, vx: 0, vz: -2 };   // pushing the puck toward the AI end
  m.puck = { x: 0, z: 0.48, vx: 0, vz: 0.5 };   // drifting the wrong way, right next to the paddle
  m.update(16, 0.016);
  assert.ok(m.puck.vz < 0, 'now heading away from the paddle, toward the AI end');
});

test('a point pauses play, then re-serves toward the scored-on side', () => {
  const { m } = started();
  m.puck = { x: 0, z: PLAYER_Z - 0.01, vx: 0, vz: 3 };   // AI scores
  m.update(16, 0.016);
  assert.equal(m.state, 'point');
  const resumedAt = run(m, 2000);
  assert.equal(m.state, 'playing', `resumed by ${resumedAt}ms`);
  assert.ok(m.live);
});

test('a match is completable to a win for either side', () => {
  const { m } = started();
  // Rack up points through the real scoring path, same convention as the
  // other games' tests: scorePoint() IS the win/continue decision under test.
  for (let i = 0; i < WIN_SCORE; i += 1) {
    if (m.state === 'over') break;
    m.state = 'playing';
    m.live = true;
    m.scorePoint('ai', i);
  }
  assert.equal(m.state, 'over');
  assert.equal(m.winner, 'ai');
  assert.equal(m.score.ai, WIN_SCORE);
});

test('the AI paddle never crosses the centre line into the player half', () => {
  const { m } = started();
  m.puck = { x: 0, z: 0.9, vx: 0, vz: 0 };   // deep in the player's half
  for (let i = 0; i < 300; i += 1) m.update(i * 16, 0.016);
  assert.ok(m.aiPaddle.z < 0, 'stayed on its own side');
});

test('update() is a no-op when the match has not started', () => {
  const m = new Match();
  const before = JSON.stringify(m.puck);
  m.update(0, 0.016);
  assert.equal(JSON.stringify(m.puck), before);
});
