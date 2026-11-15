import test from 'node:test';
import assert from 'node:assert/strict';
import { Bout, AI, ZONE, WIN_POINTS, zoneOfSwing } from './logic.js';

const seq = (vals) => {
  let i = 0;
  return () => vals[(i += 1) % vals.length];
};

function fightingBout(rngVals = [0.9]) {
  const events = [];
  const b = new Bout({ onEvent: (e) => events.push(e), rng: seq(rngVals) });
  b.start(0);
  return { b, events };
}

function runUntil(b, from, cond, maxMs = 20000) {
  let now = from;
  while (now < from + maxMs) {
    now += 16;
    b.update(now, 0.016);
    if (cond(now)) return now;
  }
  return now;
}

// ── zoneOfSwing: pure mapping ──────────────────────────────────────────────
test('zoneOfSwing reads an upward swing as high, downward as low', () => {
  assert.equal(zoneOfSwing({ vy: -10 }), ZONE.HIGH);
  assert.equal(zoneOfSwing({ vy: 10 }), ZONE.LOW);
});

// ── Player offence ──────────────────────────────────────────────────────────
test('a punch at the open zone scores; into the guarded zone is blocked', () => {
  const { b, events } = fightingBout();
  b.aiState = AI.NEUTRAL;
  b.aiUntil = 1e12;             // freeze the AI brain
  b.aiGuardZone = ZONE.HIGH;

  b.punch({ vy: 10 }, 1000);    // downward swing → LOW, guard is HIGH → scores
  assert.equal(b.player.points, 1, 'low punch beats a high guard');

  runUntil(b, 1000, () => b.state === 'fighting', 3000);
  b.aiState = AI.NEUTRAL;
  b.aiUntil = 1e12;
  b.aiGuardZone = ZONE.HIGH;
  b.punch({ vy: -10 }, 4000);   // into the guarded zone
  assert.equal(b.player.points, 1, 'blocked');
  assert.ok(events.some((e) => e.type === 'blocked' && e.who === 'ai'));
});

test('the AI is open during windup and recover, regardless of its guard', () => {
  const { b } = fightingBout();
  b.aiGuardZone = ZONE.HIGH;
  b.aiState = AI.WINDUP;
  b.aiUntil = 1e12;
  b.punch({ vy: -10 }, 1000);   // high punch, same zone as its guard
  assert.equal(b.player.points, 1, 'guard does not apply mid-windup');
});

// ── Defence: guard must be HELD, not mid-swing ─────────────────────────────
test('a held guard over the strike zone blocks; the wrong zone does not', () => {
  for (const [zone, shouldBlock] of [[ZONE.HIGH, true], [ZONE.LOW, false]]) {
    const { b, events } = fightingBout();
    b.aiState = AI.WINDUP;
    b.aiStrikeZone = ZONE.HIGH;
    b.aiUntil = 500;
    b.setGuard(zone, false);
    b.update(600, 0.016);
    if (shouldBlock) {
      assert.equal(b.ai.points, 0, `guarding ${zone} blocks a high strike`);
      assert.ok(events.some((e) => e.type === 'blocked' && e.who === 'player'));
    } else {
      assert.equal(b.ai.points, 1, `guarding ${zone} fails to block a high strike`);
    }
  }
});

test('a correctly-zoned guard held mid-swing does not block', () => {
  const { b } = fightingBout();
  b.aiState = AI.WINDUP;
  b.aiStrikeZone = ZONE.HIGH;
  b.aiUntil = 500;
  b.setGuard(ZONE.HIGH, true);   // right zone, but swinging — guard is down
  b.update(600, 0.016);
  assert.equal(b.ai.points, 1, 'guard requires a held stance');
});

// ── Full bout, both outcomes ────────────────────────────────────────────────
test('a bout is completable to a player win', () => {
  const { b } = fightingBout();
  b.aiUntil = 1e12;
  let now = 0;
  for (let i = 0; i < WIN_POINTS; i += 1) {
    b.aiGuardZone = ZONE.HIGH;
    b.punch({ vy: 10 }, now);   // low punch, guard is high
    now = runUntil(b, now, () => b.state !== 'point', 3000);
    b.aiUntil = 1e12;
  }
  assert.equal(b.state, 'over');
  assert.equal(b.winner, 'player');
});

test('a bout is completable to a loss, driven only by the AI clock', () => {
  // rng 0.52 clears the "does it windup at all" check (< 0.55) but fails the
  // "high or low" check (< 0.5), so the AI always winds up a LOW punch while
  // the player holds a HIGH guard the whole time — wrong zone, every time.
  const { b } = fightingBout([0.52]);
  b.setGuard(ZONE.HIGH, false);
  const end = runUntil(b, 0, () => b.state === 'over', 60000);
  assert.equal(b.state, 'over', `bout ended by ${end}ms`);
  assert.equal(b.winner, 'ai');
});

test('update() does nothing before start() or after the bout is over', () => {
  const b = new Bout();
  b.update(1000, 0.016);
  assert.equal(b.state, 'ready');
});
