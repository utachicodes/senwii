import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRACKS, trackBySlug, trackCenterAt, trackTangent, trackNormal, trackHeading,
  trackCurvature, trackLengthM, curveSpeed, nearestOnTrack, tAtS, sAtT, tDiff,
  wrapAngle, mulberry32, ordinal, fmtMs, medalFor, loadSave,
  Race, TOP_SPEED, GRASS_SPEED, BOOST_SPEED, BOOST_PAD_MS, DRIFT_CHARGE_T1,
  DRIFT_CHARGE_T2, DRIFT_CHARGE_T3, BOOST_T, POINTS, RACER_COUNT,
  CHECKPOINT_COUNT, SAMPLES, KART_RADIUS, GRID_ROW_M, WALL_MARGIN,
  OFFROAD_RESCUE_MS,
} from './logic.js';

const DT = 1 / 60;
const TAU = Math.PI * 2;

// A pure-pursuit autopilot: aims at a point ~28 m up the centreline. Good
// enough to finish every circuit without touching a wall, deterministic.
function drive(race, now, { lookahead = 28, gain = 45 } = {}) {
  const tA = tAtS(race.track, race.progressM + lookahead);
  const c = trackCenterAt(race.track, tA);
  const want = Math.atan2(-(c.x - race.pos.x), -(c.z - race.pos.z));
  let err = want - race.heading;
  while (err > Math.PI) err -= TAU;
  while (err < -Math.PI) err += TAU;
  race.setSteer(Math.max(-30, Math.min(30, err * gain)));
}

/** Step a race until `stopMs` on the sim clock or a predicate fires. */
function run(race, { untilMs = Infinity, stop = null, dt = DT } = {}) {
  let now = 0;
  while (now < untilMs) {
    now += dt * 1000;
    drive(race, now);
    race.update(now, dt);
    if (stop && stop(race, now)) return now;
  }
  return now;
}

// ── Small pure helpers ──────────────────────────────────────────────────────

test('ordinal', () => {
  const seq = [1, 2, 3, 4, 9, 10, 11, 12, 20, 21, 22, 23, 100, 101, 111];
  const want = ['1st', '2nd', '3rd', '4th', '9th', '10th', '11th', '12th',
    '20th', '21st', '22nd', '23rd', '100th', '101st', '111th'];
  assert.deepEqual(seq.map(ordinal), want);
});

test('fmtMs', () => {
  assert.equal(fmtMs(null), '—:—.——');
  assert.equal(fmtMs(0), '0:00.00');
  assert.equal(fmtMs(26_540), '0:26.54');
  assert.equal(fmtMs(61_230), '1:01.23');
});

test('mulberry32 is deterministic and in range', () => {
  const a = mulberry32(7);
  const b = mulberry32(7);
  const c = mulberry32(8);
  for (let i = 0; i < 100; i += 1) {
    const v = a();
    assert.ok(v >= 0 && v < 1);
    assert.equal(v, b());
    assert.notEqual(v, c());
  }
});

test('tDiff and wrapAngle', () => {
  assert.ok(Math.abs(tDiff(0.1, 0.9) - 0.2) < 1e-12);   // wrap: -0.8 → +0.2
  assert.ok(Math.abs(tDiff(0.9, 0.1) + 0.2) < 1e-12);
  assert.ok(tDiff(0.5, 0) <= 0.5 && tDiff(0.5, 0) > -0.5);
  assert.ok(Math.abs(wrapAngle(Math.PI + 0.1) - (-Math.PI + 0.1)) < 1e-12);
  assert.ok(Math.abs(wrapAngle(-Math.PI - 0.1) - (Math.PI - 0.1)) < 1e-12);
});

// ── Track geometry — all three circuits must be drivable ───────────────────

test('every track: finite geometry, unit tangents, sane length', () => {
  for (const track of TRACKS) {
    assert.equal(TRACKS.filter((t) => t.slug === track.slug).length, 1);
    assert.ok(trackBySlug(track.slug) === track);
    for (const pad of track.pads) assert.ok(pad > 0 && pad < 1, 'pads inside the lap');
    assert.ok(track.medalGoldMs < track.medalSilverMs, 'gold is the faster target');
    const total = trackLengthM(track);
    assert.ok(total > 700 && total < 1200, `${track.slug} length ${total}`);
    for (let i = 0; i < 64; i += 1) {
      const t = i / 64;
      const c = trackCenterAt(track, t);
      assert.ok(Number.isFinite(c.x) && Number.isFinite(c.z));
      const tan = trackTangent(track, t);
      assert.ok(Math.abs(Math.hypot(tan.x, tan.z) - 1) < 1e-9, 'unit tangent');
      const n = trackNormal(track, t);
      assert.ok(Math.abs(n.x * tan.x + n.z * tan.z) < 1e-9, 'normal ⊥ tangent');
    }
  }
});

test('no road fold: centreline radius stays ≥ 2.5× half width', () => {
  for (const track of TRACKS) {
    let kMax = 0;
    for (let i = 0; i < 1024; i += 1) {
      kMax = Math.max(kMax, Math.abs(trackCurvature(track, i / 1024)));
    }
    const minRadius = 1 / kMax;
    assert.ok(minRadius > 2.5 * track.halfWidth,
      `${track.slug} min radius ${minRadius.toFixed(1)}m vs half width ${track.halfWidth}m`);
  }
});

test('curveSpeed never stalls the AI', () => {
  for (const track of TRACKS) {
    let vMin = Infinity;
    for (let i = 0; i < 512; i += 1) {
      vMin = Math.min(vMin, curveSpeed(track, i / 512, track.halfWidth));
    }
    assert.ok(vMin > 15, `${track.slug} min corner speed ${vMin.toFixed(1)}`);
  }
});

test('sAtT / tAtS round-trip along the whole lap', () => {
  for (const track of TRACKS) {
    const total = trackLengthM(track);
    assert.equal(sAtT(track, 0), 0);
    // t = 1 is the same point of the loop as t = 0
    assert.equal(sAtT(track, 1), 0);
    for (let i = 1; i < 64; i += 1) {
      const s = (i / 64) * total;
      const t = tAtS(track, s);
      const sBack = sAtT(track, t);
      assert.ok(Math.abs(sBack - s) < 2, `s=${s.toFixed(1)} → t=${t.toFixed(4)} → s=${sBack.toFixed(1)}`);
    }
    // a full lap of arc length maps to the seam parameter
    assert.ok(Math.abs(tAtS(track, total) - 1) < 1e-9 || tAtS(track, total) === 0);
    // negative progress wraps behind the line
    const tBehind = tAtS(track, -5);
    assert.ok(tBehind > 0.95, '5 m behind the line is near t = 1');
  }
});

test('nearestOnTrack finds a centreline point', () => {
  const track = TRACKS[0];
  const t = 0.25;
  const c = trackCenterAt(track, t);
  const near = nearestOnTrack(track, c.x, c.z);
  assert.ok(Math.abs(tDiff(near.t, t)) < 2 / SAMPLES);
  assert.ok(near.dist < 1.5);            // under half the sample spacing
});

// ── The grid ────────────────────────────────────────────────────────────────

test('grid: six karts, player last and clear of rivals', () => {
  const race = new Race({ trackIndex: 0, seed: 7 });
  assert.equal(race.karts.length, RACER_COUNT - 1);
  assert.equal(race.laps, TRACKS[0].laps);
  race.start(0);
  assert.equal(race.state, 'countdown');
  assert.ok(race.progressM < 0, 'player starts behind the line');
  const all = [race.pos, ...race.karts.map((k) => race.kartWorldPos(k))];
  for (let i = 0; i < all.length; i += 1) {
    for (let j = i + 1; j < all.length; j += 1) {
      const d = Math.hypot(all[i].x - all[j].x, all[i].z - all[j].z);
      assert.ok(d > KART_RADIUS * 2, `grid overlap: ${i} vs ${j} at ${d.toFixed(2)}m`);
    }
  }
  // everyone is roughly on the road
  for (const p of all) {
    const near = nearestOnTrack(race.track, p.x, p.z);
    assert.ok(near.dist < race.track.halfWidth + 1, 'grid spot on the road');
  }
});

test('countdown then go', () => {
  const race = new Race({ trackIndex: 0, seed: 7 });
  const ev = [];
  race.onEvent = (e) => ev.push(e.type);
  race.start(0);
  race.update(1500, DT);
  assert.equal(race.state, 'countdown');
  assert.equal(race.speed, 0, 'no speed during countdown');
  race.update(2999, DT);
  assert.equal(race.state, 'countdown');
  race.update(3000, DT);
  assert.equal(race.state, 'racing');
  assert.ok(ev.includes('countdown') && ev.includes('go'));
});

// ── Driving: surfaces, drift, pads, walls ──────────────────────────────────

test('accelerates on the road, capped off it', () => {
  const race = new Race({ trackIndex: 0, seed: 7 });
  race.start(0);
  let now = run(race, { untilMs: 6000 });
  assert.ok(race.speed > 20, 'up to speed after the countdown');
  // shove the kart into the grass
  const c = trackCenterAt(race.track, race.trackT);
  const n = trackNormal(race.track, race.trackT);
  race.pos.x = c.x + n.x * (race.track.halfWidth + 3);
  race.pos.z = c.z + n.z * (race.track.halfWidth + 3);
  race.speed = TOP_SPEED;
  // sail straight off the road: no steering correction, the cap must bite
  let sawOffTrack = false;
  for (let i = 0; i < 120; i += 1) {
    now += DT * 1000;
    race.update(now, DT);
    sawOffTrack = sawOffTrack || !race.onTrack;
  }
  assert.ok(sawOffTrack, 'left the road');
  assert.ok(race.speed < GRASS_SPEED + 0.5, `grass caps speed (${race.speed.toFixed(1)})`);
});

test('drift: needs bank and speed, charges tiers, boosts on release', () => {
  const race = new Race({ trackIndex: 0, seed: 7 });
  const ev = [];
  race.onEvent = (e) => ev.push(e);
  race.start(0);
  let now = run(race, { untilMs: 5500 });
  assert.ok(race.speed > 25, 'up to speed');

  // drift refuses without bank
  race.setSteer(0);
  race.setDrift(true, now);
  race.update(now, DT);
  assert.equal(race.drifting, false, 'no bank, no drift');

  // and refuses while stopped
  const savedSpeed = race.speed;
  race.speed = 0;
  race.setSteer(10);
  race.setDrift(true, now);
  race.update(now, DT);
  assert.equal(race.drifting, false, 'no speed, no drift');
  race.speed = savedSpeed;

  // hop, charge, tiers, release
  race.setDrift(true, now);
  assert.equal(race.drifting, true);
  assert.ok(ev.some((e) => e.type === 'hop'));
  now = run(race, { untilMs: now + (DRIFT_CHARGE_T3 + 0.4) * 1000, stop: (r) => r.driftTier === 3 });
  assert.equal(race.driftTier, 3, 'reached the top tier');
  const sparks = ev.filter((e) => e.type === 'spark').map((e) => e.tier);
  assert.deepEqual(sparks, [1, 2, 3], 'tiers fire in order');
  const t3 = now;
  race.setDrift(false, t3);
  assert.equal(race.drifting, false);
  const boost = ev.filter((e) => e.type === 'boost').pop();
  assert.equal(boost.tier, 3);
  assert.ok(Math.abs(race.boostUntil - (t3 + BOOST_T[2] * 1000)) < 1,
    `boostUntil ${race.boostUntil} vs ${t3 + BOOST_T[2] * 1000}`);
});

test('boost pads fire on the road', () => {
  const race = new Race({ trackIndex: 0, seed: 7 });
  const ev = [];
  race.onEvent = (e) => ev.push(e.type);
  race.start(0);
  const now = run(race, { untilMs: 6000 });
  // teleport onto the first pad
  const padT = race.track.pads[0];
  const c = trackCenterAt(race.track, padT);
  race.pos.x = c.x;
  race.pos.z = c.z;
  race.update(now + DT * 1000, DT);
  assert.ok(ev.includes('pad'), 'pad fired');
  assert.ok(race.padBoostUntil > 0);
});

test('walls: scraping scrubs speed but the kart keeps sliding, never pins', () => {
  const race = new Race({ trackIndex: 0, seed: 7 });
  race.start(0);
  let now = run(race, { untilMs: 6000 });
  // shove the kart well past the verge, nose into the wall
  const c = trackCenterAt(race.track, race.trackT);
  const n = trackNormal(race.track, race.trackT);
  race.pos.x = c.x + n.x * (race.track.halfWidth + 6);
  race.pos.z = c.z + n.z * (race.track.halfWidth + 6);
  race.speed = TOP_SPEED;
  // nose into the wall and hold it there: +steer presses the kart into the
  // +normal side we parked it on. No autopilot — the wall must fight the kart.
  race.setSteer(12);
  let scraped = false;
  for (let i = 0; i < 240; i += 1) {
    now += DT * 1000;
    race.update(now, DT);
    scraped = scraped || race.scraping;
  }
  assert.ok(scraped, 'scraping engaged');
  // keep grinding: scrub bites, the kart keeps sliding, no pin
  const tBefore = race.trackT;
  const speedAtScrape = race.speed;
  for (let i = 0; i < 180; i += 1) {
    now += DT * 1000;
    race.update(now, DT);
  }
  assert.ok(race.speed < speedAtScrape - 3, `scrubbed (${race.speed.toFixed(1)})`);
  const lat = (() => {
    const cc = trackCenterAt(race.track, race.trackT);
    const nn = trackNormal(race.track, race.trackT);
    return (race.pos.x - cc.x) * nn.x + (race.pos.z - cc.z) * nn.z;
  })();
  assert.ok(Math.abs(lat) <= race.track.halfWidth + WALL_MARGIN + 1e-6,
    'held at the verge');
  const advanced = Math.abs(tDiff(race.trackT, tBefore));
  assert.ok(advanced > 0.005, `kart slid along the wall (Δt ${advanced.toFixed(4)})`);
});

test('off-road rescue after the grace period', () => {
  const race = new Race({ trackIndex: 0, seed: 7 });
  const ev = [];
  race.onEvent = (e) => ev.push(e.type);
  race.start(0);
  let now = run(race, { untilMs: 6000 });
  // beach the kart hard against the wall and steer into it
  const c = trackCenterAt(race.track, race.trackT);
  const n = trackNormal(race.track, race.trackT);
  race.pos.x = c.x + n.x * (race.track.halfWidth + 6);
  race.pos.z = c.z + n.z * (race.track.halfWidth + 6);
  race.setSteer(20);
  // steer straight into the wall, no correction, until the rescue fires
  const beachAt = now;
  let rescuedAt = null;
  for (let i = 0; i < (OFFROAD_RESCUE_MS + 3000) / (DT * 1000); i += 1) {
    now += DT * 1000;
    race.update(now, DT);
    if (ev.includes('rescue')) { rescuedAt = now; break; }
  }
  assert.ok(ev.includes('rescue'), 'rescue fired');
  assert.ok(rescuedAt - beachAt < OFFROAD_RESCUE_MS + 2000, 'rescue within the grace window');
  race.setSteer(0);
  now += DT * 1000;
  race.update(now, DT);
  assert.ok(race.onTrack, 'back on the road');
  const near = nearestOnTrack(race.track, race.pos.x, race.pos.z);
  assert.ok(near.dist < 1.5, 'snapped to the centreline');
});

// ── AI and standings ────────────────────────────────────────────────────────

test('AI karts hold the line and make progress', () => {
  const race = new Race({ trackIndex: 0, seed: 7 });
  race.start(0);
  const now = run(race, { untilMs: 30_000 });
  assert.ok(now >= 30_000);
  for (const k of race.karts) {
    assert.ok(k.progressM > 300, `${k.name} advanced (${Math.round(k.progressM)}m)`);
    assert.ok(Math.abs(k.offset) <= race.track.halfWidth, 'stays on the road');
    assert.ok(k.speed > 5, 'moving');
  }
  const st = race.standings();
  assert.equal(st.length, RACER_COUNT);
  for (let i = 1; i < st.length; i += 1) {
    assert.ok(st[i - 1].prog >= st[i].prog, 'sorted by progress');
  }
});

test('full race: autopilot finishes, points and laps line up', { timeout: 30_000 }, () => {
  const race = new Race({ trackIndex: 0, seed: 7 });
  const ev = [];
  race.onEvent = (e) => ev.push(e);
  race.start(0);
  run(race, { untilMs: 240_000, stop: (r) => r.finishedMs !== null });
  assert.ok(race.finishedMs !== null, 'finished inside 4 minutes');
  assert.equal(race.lapTimes.length, race.laps);
  assert.ok(race.bestLapMs <= Math.min(...race.lapTimes) + 1e-9);
  const finish = ev.find((e) => e.type === 'finish');
  assert.ok(finish, 'finish event fired');
  assert.ok(finish.place >= 1 && finish.place <= RACER_COUNT);
  assert.equal(finish.points, POINTS[finish.place - 1]);
  assert.equal(finish.standings.length, RACER_COUNT);
  assert.equal(finish.standings[0].who, 'you');
  const lapEvents = ev.filter((e) => e.type === 'lap');
  assert.equal(lapEvents.length, race.laps);
  // checkpoints were all visited in order (each lap closes at the line)
  assert.equal(race.nextCp, 1);
});

test('rubber band keeps the race close', () => {
  // a mediocre-but-sane pilot: the autopilot with a weak gain and a wobble,
  // like a real player who over- and under-steers. The rubber band and the
  // rescue must keep the AI within half a lap of that.
  const race = new Race({ trackIndex: 0, seed: 7 });
  race.start(0);
  let now = 0;
  let frame = 0;
  while (now < 90_000 && race.finishedMs === null) {
    now += DT * 1000;
    frame += 1;
    drive(race, now, { lookahead: 18, gain: 16 });
    race.setSteer(race.steer + Math.sin(frame * 0.021) * 7);   // human wobble
    race.update(now, DT);
  }
  const worst = Math.max(...race.karts.map((k) => k.progressM));
  const gap = worst - race.progressM;
  assert.ok(gap < trackLengthM(race.track) * 0.5, `gap ${Math.round(gap)}m is under half a lap`);
});

// ── Ghost recording ────────────────────────────────────────────────────────

test('ghost: keys at ≥120 ms, ghostAt clamps and interpolates', () => {
  const race = new Race({ trackIndex: 0, seed: 7 });
  race.start(0);
  run(race, { untilMs: 12_000 });
  assert.ok(race.recording.length > 50, 'recorded a slice of the lap');
  for (let i = 1; i < race.recording.length; i += 1) {
    assert.ok(race.recording[i].ms - race.recording[i - 1].ms >= 119,
      'key spacing at least one frame under the 120 ms gate');
  }
  const g = [
    { ms: 0, x: 0, z: 0, h: 0 },
    { ms: 1000, x: 10, z: 0, h: 1 },
  ];
  const r = new Race({ trackIndex: 0, seed: 7, ghost: g });
  assert.deepEqual(r.ghostAt(-5), g[0]);
  assert.deepEqual(r.ghostAt(2000), g[1]);
  const mid = r.ghostAt(500);
  assert.equal(mid.x, 5);
  assert.equal(mid.z, 0);
  assert.equal(mid.h, 0.5);
});

// ── Medals and saves ───────────────────────────────────────────────────────

test('medalFor', () => {
  const t = TRACKS[0];
  assert.equal(medalFor(t, null), null);
  assert.equal(medalFor(t, t.medalGoldMs), 'gold');
  assert.equal(medalFor(t, t.medalGoldMs + 1), 'silver');
  assert.equal(medalFor(t, t.medalSilverMs), 'silver');
  assert.equal(medalFor(t, t.medalSilverMs + 1), 'bronze');
});

test('loadSave survives a missing localStorage (Node)', () => {
  const save = loadSave();
  assert.equal(save.unlocked, 1);
  assert.deepEqual(save.bestLaps, {});
  assert.deepEqual(save.ghosts, {});
});
