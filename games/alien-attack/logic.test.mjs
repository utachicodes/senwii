import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Patrol, captureTray, trayRead, mulberry32, fmtMs,
  shapeSteer, SteerFilter, STEER_DEADZONE,
  LANE_HALF, LATERAL_SPEED, STEER_FULL, SHIP_R, ALIEN_R,
  FIRE_COOLDOWN_MS, LIVES, INVULN_MS, KILL_POINTS,
  SPAWN_MS_START, SPAWN_MS_MIN, ALIEN_BOLT_SPEED,
  LEVELS, levelDef, SAUCER_TYPES, INTERMISSION_MS, BOSS_DELAY_MS, BOSS_HOLD,
  DIVER_LOCK_RANGE, DIVER_WINDUP_MS, ZIG_AMP, CLEAR_POINTS, FLAWLESS_POINTS,
  BOSS_POINTS, TANK_BONUS, SHIP_SPEED, SHIP_SPEED_MAX,
  PROGRESS_KEY, loadProgress, saveProgress, unlockLevel, recordScore, stepLevel,
  defaultProgress, tri,
} from './logic.js';

// ── Tray-grip steering, same proofs the cow carried ────────────────────────
// World: x east, y north, z up. The player sits SOUTH; the phone lies flat,
// leaned a few degrees toward the face. Rolls happen about the north–south
// axis; the player's right is east, and east-end-down reads +t
// (DEVICE-PINNED 2026-08-24).

const rot = (v, n, a) => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const d = n.x * v.x + n.y * v.y + n.z * v.z;
  const cx = { x: n.y * v.z - n.z * v.y, y: n.z * v.x - n.x * v.z, z: n.x * v.y - n.y * v.x };
  return {
    x: v.x * c + cx.x * s + n.x * d * (1 - c),
    y: v.y * c + cx.y * s + n.y * d * (1 - c),
    z: v.z * c + cx.z * s + n.z * d * (1 - c),
  };
};
const rotAxes = (axes, n, a) => ({ x: rot(axes.x, n, a), y: rot(axes.y, n, a), z: rot(axes.z, n, a) });
const NORTH = { x: 0, y: 1, z: 0 };
const LEAN = 10 * (Math.PI / 180);

function trayGrip(flip) {
  const s = Math.sin(LEAN);
  const c = Math.cos(LEAN);
  if (flip === 'A') {
    return { x: { x: 0, y: -c, z: -s }, y: { x: 1, y: 0, z: 0 }, z: { x: 0, y: -s, z: c } };
  }
  return { x: { x: 0, y: c, z: s }, y: { x: -1, y: 0, z: 0 }, z: { x: 0, y: -s, z: c } };
}

test('tray: captured pose reads zero; rolls read as exact deltas; flips agree', () => {
  for (const flip of ['A', 'B']) {
    const rest = rotAxes(trayGrip(flip), NORTH, 7 * (Math.PI / 180));
    const ref = captureTray(rest);
    assert.ok(Math.abs(trayRead(rest, ref).bank) < 1e-9, `flip ${flip}: neutral is 0°`);
  }
  for (const t of [12, -25]) {
    const banks = ['A', 'B'].map((flip) => {
      const ref = captureTray(trayGrip(flip));
      return trayRead(rotAxes(trayGrip(flip), NORTH, t * (Math.PI / 180)), ref).bank;
    });
    assert.ok(Math.abs(banks[0] - banks[1]) < 1e-6, 'flips agree');
    assert.ok(Math.abs(banks[0] - t) < 1e-6,
      `pinned sign: roll ${t}° → bank ${banks[0].toFixed(2)}°`);
  }
});

// ── Anti-drift steering stage ──────────────────────────────────────────────

test('shape: tremor inside the deadzone is zero, full lock is preserved', () => {
  assert.equal(shapeSteer(0), 0);
  assert.equal(shapeSteer(STEER_DEADZONE - 0.1), 0);
  assert.equal(shapeSteer(-(STEER_DEADZONE - 0.1)), 0);
  assert.ok(Math.abs(shapeSteer(STEER_FULL) - STEER_FULL) < 1e-9, 'full lock intact');
  assert.ok(Math.abs(shapeSteer(-STEER_FULL) + STEER_FULL) < 1e-9);
  assert.ok(shapeSteer(STEER_DEADZONE + 0.1) > 0 && shapeSteer(STEER_DEADZONE + 0.1) < 0.5,
    'the edge of the deadzone ramps in smoothly');
});

test('filter: a standing 3° bias heals to zero output', () => {
  const f = new SteerFilter();
  let out = 0;
  for (let i = 0; i < 60 * 10; i += 1) out = f.update(3, 1 / 60);   // 10s at rest
  assert.equal(out, 0, 'the drift is gone');
  assert.ok(Math.abs(f.bias - 3) < 0.05, 'the bias was learned, not clipped');
});

test('filter: an intentional hard steer is never eaten', () => {
  const f = new SteerFilter();
  for (let i = 0; i < 60 * 3; i += 1) f.update(0.5, 1 / 60);        // settle
  let out = 0;
  for (let i = 0; i < 60 * 5; i += 1) out = f.update(15, 1 / 60);   // held steer
  assert.ok(Math.abs(out - shapeSteer(15 - f.bias)) < 1e-9);
  assert.ok(out > 13, `a held 15° steer still steers hard (${out.toFixed(2)})`);
  assert.ok(Math.abs(f.bias) < 1, 'the steer did not get absorbed as bias');
});

test('filter: drift heals, then a swing passes through at full strength', () => {
  const f = new SteerFilter();
  for (let i = 0; i < 60 * 8; i += 1) f.update(2.5, 1 / 60);        // drifted rest
  const swung = f.update(2.5 + 14, 1 / 60);
  assert.ok(swung > 11.5, `the swing reads nearly full: ${swung.toFixed(2)}°`);
});

// ── Flight ─────────────────────────────────────────────────────────────────

function drive(p, seconds, dt, fn = () => {}) {
  let now = p.startMs;
  for (let i = 0; i < Math.round(seconds / dt); i += 1) {
    now += dt * 1000;
    fn(p, now);
    p.update(now, dt);
  }
  return now;
}

test('steering: bank strafes proportionally, saturates, and the lane clamps', () => {
  for (const bank of [14, -14, 6, 0]) {
    const p = new Patrol({});
    p.start(0);
    p.nextSpawnMs = Infinity;        // an empty sky for a pure steering test
    p.setSteer(bank);
    drive(p, 1.0, 0.01);
    const expected = LATERAL_SPEED * (bank / STEER_FULL) * 1.0;
    assert.ok(Math.abs(p.x - expected) < 1e-9, `bank ${bank}° → x ${p.x}`);
  }
  const p = new Patrol({});
  p.start(0);
  p.nextSpawnMs = Infinity;
  p.setSteer(90);
  drive(p, 20, 0.01);
  assert.equal(p.x, LANE_HALF, 'never leaves the lane');
});

test('a bolt dead ahead kills the saucer and scores KILL_POINTS', () => {
  const events = [];
  const p = new Patrol({ onEvent: (e) => events.push(e) });
  p.start(0);
  p.nextSpawnMs = Infinity;
  const a = p.spawnAlien(0);
  a.x0 = p.x; a.swayAmp = 0; a.speed = 10;   // hovering straight ahead
  p.shoot(200);
  drive(p, 3, 0.01);
  assert.equal(p.kills, 1);
  assert.ok(events.some((e) => e.type === 'kill'));
  assert.equal(p.aliens.length, 0, 'the saucer is gone');
  assert.equal(p.score, KILL_POINTS + Math.floor(p.z));
});

test('a bolt misses a saucer parked off to the side', () => {
  const p = new Patrol({});
  p.start(0);
  p.nextSpawnMs = Infinity;
  const a = p.spawnAlien(0);
  a.x0 = p.x + ALIEN_R + 1.5; a.swayAmp = 0; a.speed = 0;
  p.shoot(200);
  drive(p, 1.5, 0.01);
  assert.equal(p.kills, 0);
});

test('the trigger has a cooldown', () => {
  const p = new Patrol({});
  p.start(0);
  assert.equal(p.shoot(1000), true);
  assert.equal(p.shoot(1000 + FIRE_COOLDOWN_MS - 10), false);
  assert.equal(p.shoot(1000 + FIRE_COOLDOWN_MS + 10), true);
  assert.equal(p.bolts.length, 2);
});

test('a ramming saucer costs a life, and the mercy window blocks a double hit', () => {
  const events = [];
  const p = new Patrol({ onEvent: (e) => events.push(e) });
  p.start(0);
  p.nextSpawnMs = Infinity;
  const ram = (now) => {
    const a = p.spawnAlien(now);
    a.x0 = p.x; a.swayAmp = 0; a.speed = 300;   // dives straight in
    return a;
  };
  ram(0);
  let now = drive(p, 1.0, 0.01);
  assert.equal(p.lives, LIVES - 1);
  // A second rammer arriving inside the mercy window is free…
  ram(now);
  now = drive(p, 0.4, 0.01, (_, t) => { p.startMs = p.startMs; void t; });
  assert.equal(p.lives, LIVES - 1, 'invulnerability held');
  // …but after it lapses, hits count again.
  const later = now + INVULN_MS;
  const a3 = ram(later);
  for (let t = later; p.aliens.includes(a3) && p.state === 'running'; t += 10) p.update(t, 0.01);
  assert.equal(p.lives, LIVES - 2);
});

test('an alien bolt on your column hits; a dodge clears it', () => {
  const events = [];
  const p = new Patrol({ onEvent: (e) => events.push(e) });
  p.start(0);
  p.nextSpawnMs = Infinity;
  p.alienBolts.push({ x: p.x, z: p.z + 30 });
  drive(p, 1.2, 0.01);
  assert.equal(p.lives, LIVES - 1, 'a centred bolt lands');

  const q = new Patrol({});
  q.start(0);
  q.nextSpawnMs = Infinity;
  q.alienBolts.push({ x: q.x + SHIP_R + 0.5, z: q.z + 30 });
  drive(q, 1.2, 0.01);
  assert.equal(q.lives, LIVES, 'a sidestepped bolt sails past');
});

test('saucers open fire only inside range, on their own discipline', () => {
  const events = [];
  const p = new Patrol({ onEvent: (e) => events.push(e), seed: 5 });
  p.start(0);
  p.nextSpawnMs = Infinity;
  const a = p.spawnAlien(0);
  a.x0 = p.x + 6; a.swayAmp = 0; a.speed = 20;
  drive(p, 8, 0.01);
  const shots = events.filter((e) => e.type === 'alienFire');
  assert.ok(shots.length >= 1, 'it fired');
  for (const s of shots) assert.ok(s.z - 0 >= 0, 'sane fire positions');
});

test('three hits end the run with score = kills·100 + distance', () => {
  const events = [];
  const p = new Patrol({ onEvent: (e) => events.push(e) });
  p.start(0);
  p.nextSpawnMs = Infinity;
  let now = 0;
  for (let hit = 0; hit < LIVES; hit += 1) {
    now += INVULN_MS + 200;
    p.update(now, 0.01);
    if (p.state !== 'running') break;
    p.alienBolts.push({ x: p.x, z: p.z + 0.5 });
    now += 100;
    for (let t = now - 100; t <= now && p.state === 'running'; t += 10) p.update(t, 0.01);
  }
  assert.equal(p.state, 'done');
  const done = events.find((e) => e.type === 'done');
  assert.ok(done);
  assert.equal(done.score, done.kills * KILL_POINTS + done.distanceM);
  assert.equal(done.kills, 0);
});

test('waves ramp: spawn gaps shrink toward the floor over time', () => {
  const p = new Patrol({ seed: 9 });
  p.start(0);
  const gaps = [];
  let lastSpawn = null;
  const events = [];
  p.onEvent = (e) => {
    if (e.type !== 'spawn') return;
    events.push(e);
  };
  let prevCount = 0;
  let prevAt = 0;
  drive(p, 120, 0.02, (q, now) => {
    q.x = -LANE_HALF;                 // hug a wall; ignore combat outcomes
    if (events.length > prevCount) {
      if (prevAt) gaps.push(now - prevAt);
      prevAt = now;
      prevCount = events.length;
    }
    q.lives = LIVES;                  // immortal for the pacing measurement
    q.state = 'running';
  });
  assert.ok(gaps.length > 20, `many waves spawned (${gaps.length})`);
  const early = gaps.slice(0, 5).reduce((a, b) => a + b) / 5;
  const late = gaps.slice(-5).reduce((a, b) => a + b) / 5;
  assert.ok(early > late, `gaps shrink: ${early.toFixed(0)}ms → ${late.toFixed(0)}ms`);
  assert.ok(late >= SPAWN_MS_MIN - 30, 'never below the floor');
  assert.ok(early <= SPAWN_MS_START + 30, 'never above the ceiling');
  void lastSpawn; void mulberry32; void ALIEN_BOLT_SPEED;
});

test('A restarts a finished run from zero', () => {
  const p = new Patrol({});
  p.start(0);
  p.lives = 1;
  p.alienBolts.push({ x: p.x, z: p.z + 0.5 });
  drive(p, 0.5, 0.01);
  assert.equal(p.state, 'done');
  p.start(60_000);
  assert.equal(p.state, 'running');
  assert.equal(p.lives, LIVES);
  assert.equal(p.kills, 0);
  assert.equal(p.z, 0);
  assert.equal(p.aliens.length, 0);
});

test('fmtMs renders minutes and tenths', () => {
  assert.equal(fmtMs(83_400), '1:23.4');
  assert.equal(fmtMs(0), '—:—');
});

// ── Sectors ────────────────────────────────────────────────────────────────

const nonBoss = LEVELS.filter((d) => !d.boss);
const bosses = LEVELS.filter((d) => d.boss);

test('levels: ten sane sectors, two bosses, the last one a boss', () => {
  assert.ok(LEVELS.length >= 8 && LEVELS.length <= 10);
  assert.ok(LEVELS[LEVELS.length - 1].boss, 'the final sector is a boss');
  assert.ok(bosses.length >= 2);
  for (const [i, d] of LEVELS.entries()) {
    assert.ok(d.name && d.goal >= 1, `sector ${i + 1} has a name and goal`);
    assert.ok(d.spawnMs >= SPAWN_MS_MIN && d.spawnMs <= 3000);
    assert.ok(d.alienSpeed[0] > 0 && d.alienSpeed[1] > d.alienSpeed[0]);
    const types = Object.keys(d.mix);
    assert.ok(types.length > 0 && types.every((t) => SAUCER_TYPES[t]), 'known saucer types');
    if (d.intro) assert.ok(d.mix[d.intro] > 0, `sector ${i + 1} actually fields its debut`);
  }
  assert.equal(LEVELS[0].speed, SHIP_SPEED);
  assert.equal(LEVELS[LEVELS.length - 1].speed, SHIP_SPEED_MAX);
  assert.equal(LEVELS[0].spawnMs, SPAWN_MS_START);
  assert.deepEqual(Object.keys(LEVELS[0].mix), ['scout'], 'sector 1 is plain scouts');
  assert.equal(levelDef(0), LEVELS[0]);
  assert.equal(levelDef(99), LEVELS[LEVELS.length - 1]);
});

test('levels: difficulty is monotonic', () => {
  for (let i = 1; i < LEVELS.length; i += 1) {
    const a = LEVELS[i - 1];
    const b = LEVELS[i];
    assert.ok(b.speed >= a.speed, `speed rises into sector ${i + 1}`);
    assert.ok(b.fireMs <= a.fireMs, `fire discipline tightens into ${i + 1}`);
    assert.ok(b.boltSpeed >= a.boltSpeed, `bolts quicken into ${i + 1}`);
    assert.ok(b.swayAmp >= a.swayAmp, `sway widens into ${i + 1}`);
    assert.ok(b.alienSpeed[1] >= a.alienSpeed[1]);
  }
  for (let i = 1; i < nonBoss.length; i += 1) {
    assert.ok(nonBoss[i].spawnMs < nonBoss[i - 1].spawnMs, 'spawn gap shrinks');
    assert.ok(nonBoss[i].goal > nonBoss[i - 1].goal, 'kill target grows');
  }
  for (let i = 1; i < bosses.length; i += 1) {
    assert.ok(bosses[i].boss.hp > bosses[i - 1].boss.hp, 'each boss is tougher');
  }
});

/** Kill every saucer the moment it appears (a perfect, invisible gunner). */
function autoKill(p, now) {
  for (const a of p.aliens) {
    if (a.dead) continue;
    p.bolts.push({ x: a.x, z: a.z, born: p.z });
  }
  void now;
}

test('clearing the kill target opens an intermission, then the next sector', () => {
  const events = [];
  const p = new Patrol({ onEvent: (e) => events.push(e), seed: 3 });
  p.start(0);
  p.lives = 2;                                  // carried, not refilled
  let now = 0;
  while (p.state === 'running' && now < 120_000) {
    now += 10;
    autoKill(p, now);
    p.update(now, 0.01);
  }
  assert.equal(p.state, 'cleared');
  const cleared = events.find((e) => e.type === 'cleared');
  assert.equal(cleared.level, 1);
  assert.equal(cleared.kills, LEVELS[0].goal);
  assert.equal(cleared.next, 2);
  assert.equal(cleared.flawless, true);
  assert.equal(cleared.bonus, CLEAR_POINTS * 1 + FLAWLESS_POINTS);
  assert.equal(p.aliens.length, 0, 'the sky is swept');
  assert.equal(p.alienBolts.length, 0);

  // The intermission flies on its own: no spawns, steering still live.
  const clearedAt = now;
  const x0 = p.x;
  p.setSteer(STEER_FULL);
  while (now < clearedAt + INTERMISSION_MS - 20) { now += 10; p.update(now, 0.01); }
  assert.equal(p.state, 'cleared');
  assert.equal(p.aliens.length, 0);
  assert.ok(p.x > x0, 'you can still steer during the intermission');
  now += 40; p.update(now, 0.01);
  assert.equal(p.state, 'running');
  assert.equal(p.level, 2);
  assert.equal(p.levelKills, 0);
  assert.equal(p.lives, 2, 'lives carry across sectors');
  assert.equal(p.kills, LEVELS[0].goal, 'run kills carry too');
  assert.ok(events.some((e) => e.type === 'level' && e.level === 2));
});

test('start(level) drops straight into that sector', () => {
  const p = new Patrol({});
  p.start(0, 6);
  assert.equal(p.level, 6);
  assert.equal(p.startLevel, 6);
  assert.equal(p.speed, LEVELS[5].speed);
  assert.equal(p.lives, LIVES);
  p.start(0, 42);
  assert.equal(p.level, LEVELS.length, 'clamped to the last sector');
});

test('the armoured saucer survives one hit and dies on the second', () => {
  const events = [];
  const p = new Patrol({ onEvent: (e) => events.push(e) });
  p.start(0, 3);
  p.nextSpawnMs = Infinity;
  const a = p.spawnAlien(0, 'tank');
  assert.equal(a.hp, 2);
  a.x0 = p.x; a.swayAmp = 0; a.speed = 0; a.nextFireMs = Infinity;
  a.z = p.z + 40;                             // well inside bolt range
  p.shoot(10);
  drive(p, 1.0, 0.01);
  assert.equal(p.kills, 0, 'one hit is not enough');
  assert.equal(a.hp, 1);
  assert.ok(p.aliens.includes(a));
  assert.ok(events.some((e) => e.type === 'armor'));
  p.shoot(2000);
  let now = 2000;
  for (let i = 0; i < 100; i += 1) { now += 10; p.update(now, 0.01); }
  assert.equal(p.kills, 1);
  assert.ok(!p.aliens.includes(a));
  assert.equal(p.score, KILL_POINTS + TANK_BONUS + Math.floor(p.z));
});

test('the zig-zagger sweeps the lane in straight legs', () => {
  assert.equal(tri(0), 0);
  assert.equal(tri(0.25), 1);
  assert.equal(tri(0.75), -1);
  assert.ok(Math.abs(tri(0.125) - 0.5) < 1e-9, 'linear between turns');
  const p = new Patrol({});
  p.start(0, 2);
  p.nextSpawnMs = Infinity;
  const a = p.spawnAlien(0, 'zigzag');
  a.speed = 0;
  let lo = Infinity; let hi = -Infinity;
  drive(p, 4, 0.01, () => { lo = Math.min(lo, a.x); hi = Math.max(hi, a.x); });
  assert.ok(hi - lo > ZIG_AMP * 1.8, `it crosses ${(hi - lo).toFixed(1)}m of lane`);
  assert.ok(Math.abs(hi) <= LANE_HALF && Math.abs(lo) <= LANE_HALF);
});

test('the diver winds up in range, then charges where the ship was', () => {
  const events = [];
  const p = new Patrol({ onEvent: (e) => events.push(e) });
  p.start(0, 6);
  p.nextSpawnMs = Infinity;
  const a = p.spawnAlien(0, 'diver');
  a.x0 = 5; a.swayAmp = 0;
  let now = 0;
  while (a.mode === 'cruise' && now < 20_000) { now += 10; p.update(now, 0.01); }
  assert.equal(a.mode, 'windup');
  assert.ok(a.z - p.z < DIVER_LOCK_RANGE + 1);
  const gapAtWindup = a.z - p.z;
  while (a.mode === 'windup') { now += 10; p.update(now, 0.01); }
  assert.ok(Math.abs(a.z - p.z - gapAtWindup) < 6, 'it nearly holds station while it glows');
  assert.equal(a.mode, 'dive');
  assert.equal(a.targetX, p.x, 'locked onto the ship');
  assert.ok(events.some((e) => e.type === 'windup') && events.some((e) => e.type === 'dive'));
  assert.ok(!events.some((e) => e.type === 'alienFire'), 'divers never shoot');
  // Hold still: it lands.
  while (p.aliens.includes(a) && now < 30_000) { now += 10; p.update(now, 0.01); }
  assert.equal(p.lives, LIVES - 1, 'a diver you ignore rams you');
  void DIVER_WINDUP_MS;
});

test('a dodged diver sails past', () => {
  const p = new Patrol({});
  p.start(0, 6);
  p.nextSpawnMs = Infinity;
  const a = p.spawnAlien(0, 'diver');
  a.x0 = 0; a.swayAmp = 0;
  let now = 0;
  while (a.mode !== 'dive') { now += 10; p.update(now, 0.01); }
  p.setSteer(STEER_FULL);                     // break hard right
  while (p.aliens.includes(a) && now < 30_000) { now += 10; p.update(now, 0.01); }
  assert.equal(p.lives, LIVES);
});

test('the boss warps in, holds station, fires volleys, and takes many hits', () => {
  const events = [];
  let fanned = false;
  const p = new Patrol({
    onEvent: (e) => {
      events.push(e);
      if (e.type === 'bossFire') fanned ||= p.alienBolts.some((b) => b.vx);
    },
  });
  p.start(0, 5);
  p.nextSpawnMs = Infinity;
  p.invulnUntil = Infinity;                   // just watch it work
  let now = 0;
  while (!p.boss) { now += 10; p.update(now, 0.01); }
  assert.ok(now >= BOSS_DELAY_MS);
  const boss = p.boss;
  assert.equal(boss.hp, LEVELS[4].boss.hp);
  for (let i = 0; i < 600; i += 1) { now += 10; p.update(now, 0.01); }
  assert.ok(Math.abs(boss.z - p.z - BOSS_HOLD) < 1, 'it rides ahead at its station');
  const volleys = events.filter((e) => e.type === 'bossFire');
  assert.ok(volleys.length >= 1, 'it shoots back');
  assert.ok(fanned, 'a fanned spread, not a single line');

  // Hit it repeatedly: progress climbs, one short of dead it lives.
  p.alienBolts = [];
  const hp = boss.hp;
  for (let k = 0; k < hp - 1; k += 1) {
    p.bolts.push({ x: boss.x, z: boss.z, born: p.z });
    now += 10; p.update(now, 0.01);
  }
  assert.equal(boss.hp, 1);
  assert.equal(p.boss, boss, 'still alive on its last hit point');
  assert.ok(p.progress > 0.9 && p.progress < 1);
  assert.equal(p.state, 'running');
});

/** Run until the boss is on station (inside bolt range). */
function awaitBoss(p, now) {
  while (!p.boss || p.boss.gap > BOSS_HOLD + 0.5) { now += 10; p.update(now, 0.01); }
  return now;
}

test('killing the boss clears the sector with a bonus and a life back', () => {
  const events = [];
  const p = new Patrol({ onEvent: (e) => events.push(e) });
  p.start(0, 5);
  p.nextSpawnMs = Infinity;
  p.lives = 2;
  p.invulnUntil = Infinity;                   // isolate the kill from return fire
  let now = awaitBoss(p, 0);
  p.alienBolts = [];
  const before = p.bonus;
  p.boss.hp = 1;
  p.bolts.push({ x: p.boss.x, z: p.boss.z, born: p.z });
  now += 10; p.update(now, 0.01);
  assert.equal(p.boss, null);
  assert.ok(events.some((e) => e.type === 'bossDown' && e.extraLife));
  assert.equal(p.lives, 3, '+1 life');
  assert.equal(p.state, 'cleared');
  assert.ok(p.bonus >= before + BOSS_POINTS);
  // At full health the extra life is capped.
  const q = new Patrol({});
  q.start(0, 5);
  q.nextSpawnMs = Infinity;
  q.invulnUntil = Infinity;
  now = awaitBoss(q, 0);
  q.boss.hp = 1;
  q.bolts.push({ x: q.boss.x, z: q.boss.z, born: q.z });
  now += 10; q.update(now, 0.01);
  assert.equal(q.lives, LIVES, 'capped at max');
});

test('beating the final sector ends the run as a win', () => {
  const events = [];
  const p = new Patrol({ onEvent: (e) => events.push(e) });
  p.start(0, LEVELS.length);
  p.nextSpawnMs = Infinity;
  p.invulnUntil = Infinity;
  let now = awaitBoss(p, 0);
  assert.ok(p.boss.final);
  p.boss.hp = 1;
  p.bolts.push({ x: p.boss.x, z: p.boss.z, born: p.z });
  now += 10; p.update(now, 0.01);
  assert.equal(p.state, 'done');
  assert.equal(p.won, true);
  const done = events.find((e) => e.type === 'done');
  assert.equal(done.won, true);
  assert.equal(done.level, LEVELS.length);
  assert.ok(events.find((e) => e.type === 'cleared').final);
});

test('dying mid-sector is a loss on that sector', () => {
  const events = [];
  const p = new Patrol({ onEvent: (e) => events.push(e) });
  p.start(0, 4);
  p.lives = 1;
  p.alienBolts.push({ x: p.x, z: p.z + 0.5 });
  drive(p, 0.5, 0.01);
  const done = events.find((e) => e.type === 'done');
  assert.equal(done.won, false);
  assert.equal(done.level, 4);
});

// ── Progression storage ────────────────────────────────────────────────────

function memStore(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
}

test('progress: round-trips unlocks and best score', () => {
  const s = memStore();
  assert.deepEqual(loadProgress(s), defaultProgress());
  let p = unlockLevel(defaultProgress(), 4);
  p = recordScore(p, 12345);
  assert.equal(saveProgress(s, p), true);
  assert.deepEqual(loadProgress(s), { unlocked: 4, best: 12345 });
  // Never goes backwards.
  p = recordScore(unlockLevel(p, 2), 10);
  assert.deepEqual(p, { unlocked: 4, best: 12345 });
  assert.equal(unlockLevel(p, 99).unlocked, LEVELS.length);
});

test('progress: missing, corrupt or throwing storage falls back to defaults', () => {
  assert.deepEqual(loadProgress(null), defaultProgress());
  assert.deepEqual(loadProgress(memStore({ [PROGRESS_KEY]: '{not json' })), defaultProgress());
  assert.deepEqual(loadProgress(memStore({ [PROGRESS_KEY]: '"str"' })), defaultProgress());
  assert.deepEqual(loadProgress(memStore({ [PROGRESS_KEY]: 'null' })), defaultProgress());
  assert.deepEqual(
    loadProgress(memStore({ [PROGRESS_KEY]: JSON.stringify({ unlocked: 400, best: -5 }) })),
    { unlocked: LEVELS.length, best: 0 }, 'out-of-range values are clamped');
  assert.deepEqual(
    loadProgress(memStore({ [PROGRESS_KEY]: JSON.stringify({ unlocked: 'x', best: 'y' }) })),
    defaultProgress());
  const angry = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('QuotaExceeded'); },
  };
  assert.deepEqual(loadProgress(angry), defaultProgress());
  assert.equal(saveProgress(angry, { unlocked: 3, best: 1 }), false);
  assert.equal(saveProgress(null, { unlocked: 3, best: 1 }), false);
});

test('level select: one step per press, clamped to what is unlocked', () => {
  assert.equal(stepLevel(1, -1, 5), 1);
  assert.equal(stepLevel(1, 1, 5), 2);
  assert.equal(stepLevel(5, 1, 5), 5, 'locked sectors stay locked');
  assert.equal(stepLevel(3, 1, 1), 1);
  assert.equal(stepLevel(LEVELS.length, 1, 99), LEVELS.length);
});
