import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TraySteer, SteerFilter, captureTray, trayRead, shapeSteer,
  STEER_FULL, STEER_DEADZONE, gyroBankRate, LEAD_CAP_DEG,
} from './tilt.js';

// ── The tray pose, the same rig alien-attack's tests proved ────────────────
// World: x east, y north, z up. The player sits SOUTH; the phone lies flat,
// leaned toward the face, long axis across. Rolls happen about north–south.

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
const LEAN = 8 * (Math.PI / 180);

function trayGrip(flip) {
  const s = Math.sin(LEAN);
  const c = Math.cos(LEAN);
  if (flip === 'A') {
    return { x: { x: 0, y: -c, z: -s }, y: { x: 1, y: 0, z: 0 }, z: { x: 0, y: -s, z: c } };
  }
  return { x: { x: 0, y: c, z: s }, y: { x: -1, y: 0, z: 0 }, z: { x: 0, y: -s, z: c } };
}

const DT = 1 / 60;

/** Feed a sequence of poses at 60Hz; returns the last steer output. */
function run(steer, poses, { dt = DT } = {}) {
  let out = 0;
  let now = 0;
  for (const axes of poses) {
    now += dt * 1000;
    out = steer.update(axes, dt, now);
  }
  return out;
}

test('TraySteer: captures the pose at start, neutral reads zero, rolls read true', () => {
  for (const flip of ['A', 'B']) {
    const rest = trayGrip(flip);
    const steer = new TraySteer({});
    assert.equal(run(steer, [rest]), 0);
    assert.equal(steer.status, 'locked', 'first sample is the neutral');
    const right = rotAxes(rest, NORTH, 15 * (Math.PI / 180));
    const left = rotAxes(rest, NORTH, -15 * (Math.PI / 180));
    assert.ok(run(steer, [right]) > 12, `${flip}: right roll steers right`);
    assert.ok(run(steer, [left]) < -12, `${flip}: left roll steers left`);
  }
});

test('TraySteer: steering responds on the very next sample (no smoothing lag)', () => {
  const rest = trayGrip('A');
  const steer = new TraySteer({});
  run(steer, [rest]);
  const out = steer.update(rotAxes(rest, NORTH, 18 * (Math.PI / 180)), DT, 100);
  assert.ok(Math.abs(out - STEER_FULL) < 0.5, `full lock immediately (${out.toFixed(1)})`);
});

test('TraySteer: a hard bank held for seconds keeps steering — never re-centres mid-turn', () => {
  // Regression: a grip-change detector read flat-tray banking as the phone
  // being picked up, dropped the neutral and left the ship on reverse lock.
  const rest = trayGrip('A');
  const steer = new TraySteer({});
  run(steer, [rest]);
  for (const deg of [30, 45, 60]) {
    const bank = rotAxes(rest, NORTH, deg * (Math.PI / 180));
    const out = run(steer, Array(120).fill(bank));          // 2s held
    assert.ok(out > STEER_FULL, `${deg}° held: still steering right (${out.toFixed(1)})`);
    assert.equal(steer.status, 'locked');
    assert.equal(run(steer, [rest]), 0, `${deg}°: back to level reads straight`);
  }
});

test('TraySteer: recentre(notBefore) waits out the grace, then captures', () => {
  const rest = trayGrip('A');
  const tilted = rotAxes(rest, NORTH, 20 * (Math.PI / 180));
  const steer = new TraySteer({});
  steer.recentre(1000);
  assert.equal(steer.update(tilted, DT, 500), 0, 'no steer during grace');
  assert.equal(steer.status, 'hunting');
  steer.update(rest, DT, 1000);
  assert.equal(steer.status, 'locked');
  assert.ok(steer.update(tilted, DT, 1016) > 12, 'captured the post-grace pose');
});

test('TraySteer: a corrupt packet holds the last output', () => {
  const rest = trayGrip('A');
  const steer = new TraySteer({});
  run(steer, [rest]);
  const out = steer.update(rotAxes(rest, NORTH, 15 * (Math.PI / 180)), DT, 50);
  const bad = { x: { x: NaN, y: 0, z: 0 }, y: { x: NaN, y: NaN, z: NaN }, z: { x: 0, y: 0, z: NaN } };
  assert.equal(steer.update(bad, DT, 66), out);
});

test('TraySteer: idle re-zero adopts the resting pose before a new round', () => {
  const rest = trayGrip('A');
  const steer = new TraySteer({});
  run(steer, [rest]);
  const crooked = rotAxes(rest, NORTH, 9 * (Math.PI / 180));
  steer.idle = true;
  for (let i = 0; i < 180; i += 1) steer.update(crooked, DT, 0);   // 3s idle
  steer.idle = false;
  assert.equal(steer.update(crooked, DT, 0), 0, 'resting pose is the new straight');
});

test('TraySteer: invert flips the output, not the capture', () => {
  const rest = trayGrip('A');
  const steer = new TraySteer({ invert: true });
  for (let i = 0; i < 90; i += 1) steer.update(rest, DT, i * 16.7);
  const rolled = rotAxes(rest, NORTH, 12 * (Math.PI / 180));
  let out = 0;
  for (let i = 0; i < 120; i += 1) out = steer.update(rolled, DT, 0);
  assert.ok(out < -8, `inverted: a right roll steers left (${out.toFixed(1)})`);
});

test('SteerFilter keeps its proven contract (regression guard)', () => {
  const f = new SteerFilter();
  let out = 0;
  for (let i = 0; i < 60 * 10; i += 1) out = f.update(3, DT);
  assert.equal(out, 0);
  const g = new SteerFilter();
  for (let i = 0; i < 60 * 3; i += 1) g.update(0.5, DT);
  for (let i = 0; i < 60 * 5; i += 1) g.update(15, DT);
  assert.ok(g.update(15, DT) > 13, 'held hard steer intact');
});

test('the capture math still agrees with the device-pinned proofs', () => {
  const rest = trayGrip('A');
  const ref = captureTray(rest);
  assert.ok(Math.abs(trayRead(rest, ref).bank) < 1e-9);
  const rolled = rotAxes(rest, NORTH, 25 * (Math.PI / 180));
  assert.ok(Math.abs(trayRead(rolled, ref).bank - 25) < 1e-6, 'pinned sign: +right');
  assert.equal(shapeSteer(STEER_FULL), STEER_FULL, 'full lock preserved');
  assert.equal(shapeSteer(STEER_DEADZONE - 0.1), 0, 'deadzone preserved');
});

// ── Gyro boost: lag compensation ────────────────────────────────────────────

/** Body-frame angular velocity between two attitudes, deg/s (numeric truth). */
function omegaBody(a1, a2, h) {
  const col = (a, k) => [a[k].x, a[k].y, a[k].z];
  const R1 = [col(a1, 'x'), col(a1, 'y'), col(a1, 'z')];
  const R2 = [col(a2, 'x'), col(a2, 'y'), col(a2, 'z')];
  const M = [0, 1, 2].map((i) => [0, 1, 2].map(
    (j) => R1[i][0] * R2[j][0] + R1[i][1] * R2[j][1] + R1[i][2] * R2[j][2],
  ));
  const D = 180 / Math.PI;
  return {
    x: ((M[2][1] - M[1][2]) / (2 * h)) * D,
    y: ((M[0][2] - M[2][0]) / (2 * h)) * D,
    z: ((M[1][0] - M[0][1]) / (2 * h)) * D,
  };
}

test('gyroBankRate is the true derivative of the tray bank, both grips', () => {
  for (const flip of ['A', 'B']) {
    const rest = trayGrip(flip);
    const ref = captureTray(rest);
    for (const deg of [-30, -5, 0, 12, 40]) {
      const at = (d) => rotAxes(rest, NORTH, d * (Math.PI / 180));
      const h = 1e-4;
      const a1 = at(deg);
      const a2 = at(deg + 50 * h);                     // rolling at 50°/s
      const numeric = (trayRead(a2, ref).bank - trayRead(a1, ref).bank) / h;
      const g = gyroBankRate(a1, omegaBody(a1, a2, h), ref.sy);
      assert.ok(Math.abs(g - numeric) < 0.5, `${flip} @${deg}°: ${g.toFixed(2)} vs ${numeric.toFixed(2)}`);
    }
  }
});

/**
 * Roll the tray through a steering pattern. The fused attitude the steer sees
 * lags the hand by `lagMs`; the gyro (bodyRate) is the true, unlagged rate,
 * optionally mangled. Returns mean |steer − ideal steer| once settled.
 */
function boostRun({ lagMs, boost, gyro = (w) => w, secs = 10 }) {
  const rest = trayGrip('A');
  const bank = (t) => 22 * Math.sin(2 * Math.PI * 0.7 * t) + 8 * Math.sin(2 * Math.PI * 1.9 * t);
  const pose = (t) => rotAxes(rest, NORTH, bank(Math.max(0, t)) * (Math.PI / 180));
  const steer = new TraySteer({ boost });
  const ideal = new TraySteer({ boost: false });     // same pipeline, zero-lag input
  let err = 0;
  let n = 0;
  for (let i = 0; i < secs * 60; i += 1) {
    const t = i * DT;
    const h = 1e-4;
    const w = omegaBody(pose(t), pose(t + h), h);
    const out = steer.update(pose(t - lagMs / 1000), DT, t * 1000, gyro(w));
    const want = ideal.update(pose(t), DT, t * 1000);
    if (t > 4) { err += Math.abs(out - want); n += 1; }
  }
  return { err: err / n, steer };
}

test('gyro boost measures the phone\'s fusion lag and cancels most of it', () => {
  const off = boostRun({ lagMs: 60, boost: false });
  const on = boostRun({ lagMs: 60, boost: true });
  const lag = on.steer.lag.lagS * 1000;
  assert.ok(Math.abs(lag - 60) <= 15, `measured lag ${lag}ms for a 60ms phone`);
  assert.ok(on.err < off.err * 0.4, `steer error ${on.err.toFixed(2)}° vs ${off.err.toFixed(2)}° unboosted`);
});

test('gyro boost does no harm on a phone without fusion lag', () => {
  const on = boostRun({ lagMs: 0, boost: true });
  assert.ok(on.steer.lag.lagS <= 0.015, `measured lag ${on.steer.lag.lagS * 1000}ms`);
  assert.ok(on.err < 0.6, `tracks the hand (${on.err.toFixed(2)}°)`);
});

test('a backwards gyro can never make steering worse (lag reads 0, no boost)', () => {
  const off = boostRun({ lagMs: 60, boost: false });
  const bad = boostRun({ lagMs: 60, boost: true, gyro: (w) => ({ x: -w.x, y: -w.y, z: -w.z }) });
  assert.equal(bad.steer.lag.lagS, 0);
  assert.ok(Math.abs(bad.err - off.err) < 0.05, `${bad.err.toFixed(2)}° vs ${off.err.toFixed(2)}°`);
});

test('gyro boost vanishes at rest and is capped', () => {
  const rest = trayGrip('A');
  const steer = new TraySteer({});
  for (let i = 0; i < 120; i += 1) steer.update(rest, DT, i * 16.7, { x: 0, y: 0, z: 0 });
  assert.equal(steer.lead, 0);
  assert.equal(steer.update(rest, DT, 3000, { x: 0, y: 0, z: 0 }), 0);
  steer.lag.lagS = 0.12;
  steer.update(rest, DT, 3016, { x: 5000, y: 5000, z: 5000 });
  assert.ok(Math.abs(steer.lead) <= LEAD_CAP_DEG);
});
