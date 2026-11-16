import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyAxes, bodyAxesFromQuat, axesFromSample, DEG } from './orientation.js';
import { TraySteer } from './tilt.js';
import { Pointer } from './pointer.js';

/**
 * Tests for the rate-based pointer with the learned device axis map.
 *
 * Ground rules, written in blood:
 *  - Every gyro signal is computed NUMERICALLY from consecutive attitudes.
 *  - Device conventions are simulated as transforms of that numeric truth
 *    (permuted, mirrored, rescaled, garbage) — never hand-derived.
 * Hand-picked conventions caused the circle bug, the swing-up-goes-left bug,
 * and twice produced tests that confidently asserted the wrong thing.
 */

// ── Quaternion helpers (test-local, independent of the code under test) ────
const mul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const axisQ = (ax, deg) => {
  const h = (deg * DEG) / 2;
  const s = Math.sin(h);
  return [ax === 0 ? s : 0, ax === 1 ? s : 0, ax === 2 ? s : 0, Math.cos(h)];
};
const quatFromEuler = (al, be, ga) => mul(mul(axisQ(2, al), axisQ(0, be)), axisQ(1, ga));

/** Body-frame angular velocity between two attitudes, deg/s. */
function omegaBody(a1, a2, h) {
  const col = (a, k) => [a[k].x, a[k].y, a[k].z];
  const R1 = [col(a1, 'x'), col(a1, 'y'), col(a1, 'z')];
  const R2 = [col(a2, 'x'), col(a2, 'y'), col(a2, 'z')];
  const M = [0, 1, 2].map((i) => [0, 1, 2].map(
    (j) => R1[i][0] * R2[j][0] + R1[i][1] * R2[j][1] + R1[i][2] * R2[j][2],
  ));
  return {
    x: (M[2][1] - M[1][2]) / (2 * h) / DEG,
    y: (M[0][2] - M[2][0]) / (2 * h) / DEG,
    z: (M[1][0] - M[0][1]) / (2 * h) / DEG,
  };
}

// ── Device models: what a phone might do to the true body rates ────────────
const DEVICE = {
  spec: (w) => [w.x, w.y, w.z],
  radians: (w) => [w.x / 57.29578, w.y / 57.29578, w.z / 57.29578],
  mirrored: (w) => [-w.x, -w.y, -w.z],
  // The "swing up moved the cursor left" phone: reports each rotation on a
  // different axis label than the body axis it happened about.
  swapped: (w) => [w.z, w.x, w.y],
};

const FLAT = quatFromEuler(0, 0, 0);
const UPRIGHT = quatFromEuler(0, 80, 0);
const LANDSCAPE = quatFromEuler(0, 0, 90);

/**
 * Simulate a phone driven by yaw(t)/pitch(t) in the *user's* frame:
 * attitude = Rworld-up(yaw) · Rworld-right(pitch) · grip. Orientation samples
 * (as quaternions) are lagged by `lagMs`; the gyro is derived from the true
 * attitude and passed through the device model.
 */
// Every real pipeline delays packets (sensor cadence + LAN + socket): 25ms is
// a measured-typical default. A zero-delay harness once made honest display
// prediction look like pure overshoot — and before that, hid latency wins.
function drive({
  yaw = () => 0, pitch = () => 0, grip = FLAT, device = DEVICE.spec,
  lagMs = 60, secs = 6, pointer = null, packetDelayMs = 25,
  // Wi-Fi model: each packet gets up to `jitterMs` of extra random delay but
  // TCP keeps them in order, so a late one holds back everything behind it
  // and they land in bunches. dt is then measured from arrivals, exactly as
  // core/channel.js does.
  jitterMs = 0,
  // Send the phone-side gyro integrals (public/controller.js) with each packet.
  integrals = false,
  // Stamp each packet with the phone's send time, as the controller does.
  phoneClock = true,
}) {
  const p = pointer || new Pointer({ degPerScreen: 30 });
  const attitude = (t) => mul(mul(axisQ(2, yaw(t)), axisQ(0, pitch(t))), grip);
  const FRAME = 1000 / 60;
  const h = 1e-4;
  const track = [];
  const queue = [];   // packets in flight: sensor → network → game
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let lastAt = 0;
  let prevArrival = 0;
  const acc = { x: 0, y: 0, z: 0, t: 0 };
  let prevR = null;
  let ms = 0;
  for (let i = 0; i < secs * 60; i += 1, ms += FRAME) {
    const t = ms / 1000;
    const w = omegaBody(
      bodyAxesFromQuat(attitude(t)),
      bodyAxesFromQuat(attitude(t + h)),
      h,
    );
    const r = device ? device(w) : null;
    const sample = { quat: attitude(Math.max(0, ms - lagMs) / 1000) };
    if (phoneClock) sample.t = ms;
    if (r) {
      sample.motion = { rx: r[0], ry: r[1], rz: r[2] };
      if (integrals) {
        if (prevR) {
          const dS = FRAME / 1000;
          acc.x += 0.5 * (prevR[0] + r[0]) * dS;
          acc.y += 0.5 * (prevR[1] + r[1]) * dS;
          acc.z += 0.5 * (prevR[2] + r[2]) * dS;
          acc.t += dS;
        }
        prevR = r;
        Object.assign(sample.motion, { ix: acc.x, iy: acc.y, iz: acc.z, it: acc.t });
      }
    }
    // Real packets take time to reach the game: emit now, deliver later.
    const at = Math.max(lastAt, ms + packetDelayMs + jitterMs * rand());
    lastAt = at;
    queue.push({ at, sample });
    while (queue.length && queue[0].at <= ms) {
      const pkt = queue.shift();
      let dt = FRAME / 1000;
      if (jitterMs) {
        dt = prevArrival ? Math.min(Math.max((ms - prevArrival) / 1000, 1 / 240), 0.1) : 1 / 60;
        prevArrival = ms;
      }
      p.update(pkt.sample, dt, ms);
    }
    const d = p.sampleAt(ms);
    track.push({ ms, x: d.x, y: d.y, yaw: yaw(t), pitch: pitch(t) });
  }
  return { p, track };
}

/** Two-axis wander that exercises yaw and pitch at unrelated frequencies. */
const WANDER = {
  yaw: (t) => 12 * Math.sin(2 * Math.PI * 1.0 * t),
  pitch: (t) => 8 * Math.sin(2 * Math.PI * 1.4 * t),
};

// The reference mapping every physics scenario here is authored at: 30° of
// yaw per screen width, passed explicitly to each Pointer. The mapping is
// linear in this parameter; the shipped DEFAULT is rebased to 20 (the old
// "150% speed" as the new 100%) and pinned by its own test below.
const DEG_PER_SCREEN = 30;

/** Demeaned tracking error of cursor x against commanded yaw, screen units. */
function yawError(track, fromMs) {
  const rows = track.filter((r) => r.ms >= fromMs);
  const mx = rows.reduce((s, r) => s + r.x, 0) / rows.length;
  const my = rows.reduce((s, r) => s + r.yaw, 0) / rows.length;
  let sum = 0;
  for (const r of rows) sum += Math.abs((r.x - mx) - -((r.yaw - my) / DEG_PER_SCREEN));
  return sum / rows.length;
}

function travel(rows, key) {
  const v = rows.map((r) => r[key]);
  return Math.max(...v) - Math.min(...v);
}

// ── Foundation ──────────────────────────────────────────────────────────────
test('quaternion decoding matches Euler decoding exactly', () => {
  const cases = [
    [0, 0, 0], [37, 0, 0], [0, 52, 0], [0, 0, -41], [120, -33, 67],
    [-95, 88, 15], [200, -140, -70], [359, 179, 89], [45, 90, 0], [270, -90, 45],
  ];
  let worst = 0;
  for (const [al, be, ga] of cases) {
    const a = bodyAxes(al, be, ga);
    const b = bodyAxesFromQuat(quatFromEuler(al, be, ga));
    for (const k of ['x', 'y', 'z']) {
      for (const c of ['x', 'y', 'z']) worst = Math.max(worst, Math.abs(a[k][c] - b[k][c]));
    }
  }
  assert.ok(worst < 1e-9, `worst component error ${worst.toExponential(2)}`);
});

// ── Device conventions are learned, never assumed ──────────────────────────
test('a spec-convention phone earns trust and tracks tightly', () => {
  const { p, track } = drive({ ...WANDER });
  assert.ok(p.gyroTrusted, 'axis map trusted');
  const err = yawError(track, 2500);
  assert.ok(err < 0.06, `tracking error ${(err * 100).toFixed(1)}% of screen`);
});

test('THE BUG: a phone reporting gyro on swapped axes still aims straight', () => {
  // Reported as: rx carries the true z rotation, ry the true x, rz the true y.
  // Under the old assumed-convention code, a vertical swing on this phone
  // moved the cursor horizontally. The learned map must absorb it.
  const warm = drive({ ...WANDER, device: DEVICE.swapped, secs: 5 });
  assert.ok(warm.p.gyroTrusted, 'swapped map learned and trusted');
  warm.p.recentre();   // isolate cross-talk from the wander's leftover offset

  // Now a PURE vertical swing on the same pointer.
  const { track } = drive({
    pitch: (t) => 14 * Math.sin(2 * Math.PI * 0.8 * t),
    device: DEVICE.swapped,
    pointer: warm.p,
    secs: 4,
  });
  const rows = track.filter((r) => r.ms > 1000);
  const xT = travel(rows, 'x');
  const yT = travel(rows, 'y');
  assert.ok(xT < 0.03, `horizontal drift ${(xT * 100).toFixed(1)}% during vertical swing`);
  assert.ok(yT > 0.3, `vertical actually moves (${(yT * 100).toFixed(0)}%)`);
});

test('a rad/s phone is learned: per-axis scale ≈ 57.3', () => {
  const { p, track } = drive({ ...WANDER, device: DEVICE.radians, secs: 7 });
  assert.ok(p.gyroTrusted, 'trusted');
  for (const m of p.map) {
    if (!m) continue;
    assert.ok(Math.abs(m.scale - 57.29578) / 57.29578 < 0.15,
      `scale ≈ 57.3 (got ${m.scale.toFixed(1)})`);
  }
  const err = yawError(track, 3500);
  assert.ok(err < 0.06, `tracking error ${(err * 100).toFixed(1)}%`);
});

test('a mirrored-convention phone is learned and tracks the right way', () => {
  const { p, track } = drive({ ...WANDER, device: DEVICE.mirrored, secs: 7 });
  assert.ok(p.gyroTrusted, 'trusted');
  const err = yawError(track, 3500);
  assert.ok(err < 0.06, `tracking error ${(err * 100).toFixed(1)}%`);
});

test('an unlearnable gyro is never trusted, and directions stay correct', () => {
  // Garbage readings must fail the residual gate; the pointer then runs on
  // convention-free ground truth: softer, but never pointing the wrong way.
  let seed = 5;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5;
  const garbage = () => [rnd() * 40, rnd() * 40, rnd() * 40];
  const { p, track } = drive({
    pitch: (t) => 14 * Math.sin(2 * Math.PI * 0.8 * t),
    device: garbage,
    secs: 6,
  });
  assert.equal(p.gyroTrusted, false, 'garbage never earns trust');
  const rows = track.filter((r) => r.ms > 2000);
  assert.ok(travel(rows, 'x') < 0.04, 'no horizontal drift from garbage');
  assert.ok(travel(rows, 'y') > 0.25, 'vertical swing still works via fallback');
});

test('no gyro at all still points the right way', () => {
  const { p, track } = drive({ ...WANDER, device: null, secs: 6 });
  assert.equal(p.hasGyro, false);
  const rows = track.filter((r) => r.ms > 2000);
  // Fallback is lagged, so assert direction (covariance) and amplitude.
  const mx = rows.reduce((s, r) => s + r.x, 0) / rows.length;
  const my = rows.reduce((s, r) => s + r.yaw, 0) / rows.length;
  const cov = rows.reduce((s, r) => s + (r.x - mx) * -(r.yaw - my), 0);
  assert.ok(cov > 0, 'cursor moves the same way as the hand');
  const expected = (2 * 12) / DEG_PER_SCREEN;
  assert.ok(Math.abs(travel(rows, 'x') - expected) / expected < 0.3,
    `travel within 30% of expected (${(travel(rows, 'x') * 100).toFixed(0)}%)`);
});

// ── Grip-agnostic geometry ──────────────────────────────────────────────────
test('a vertical swing is vertical in flat, upright and landscape grips', () => {
  for (const [name, grip] of [['flat', FLAT], ['upright', UPRIGHT], ['landscape', LANDSCAPE]]) {
    const { track } = drive({
      pitch: (t) => 14 * Math.sin(2 * Math.PI * 0.8 * t),
      grip,
      secs: 5,
    });
    const rows = track.filter((r) => r.ms > 1500);
    assert.ok(travel(rows, 'x') < 0.03,
      `${name}: horizontal drift ${(travel(rows, 'x') * 100).toFixed(1)}%`);
    assert.ok(travel(rows, 'y') > 0.3, `${name}: vertical moves`);
  }
});

test('upright grip yaw tracks like flat grip yaw', () => {
  const { p, track } = drive({ ...WANDER, grip: UPRIGHT, secs: 6 });
  assert.ok(p.gyroTrusted, 'trusted in upright grip');
  const err = yawError(track, 2500);
  assert.ok(err < 0.06, `tracking error ${(err * 100).toFixed(1)}%`);
});

// ── Latency ─────────────────────────────────────────────────────────────────
test('realistic orientation lag does not slow the cursor', () => {
  // 100ms of OS fusion lag — worse than typical. The live path reads the raw
  // gyro through the learned map, so the lag only touches the learning side,
  // where the delay-aligned comparison absorbs it.
  const { p, track } = drive({ ...WANDER, lagMs: 100, secs: 7 });
  assert.ok(p.gyroTrusted, 'trusted despite lag');
  const err = yawError(track, 3500);
  assert.ok(err < 0.08, `tracking error at 100ms lag ${(err * 100).toFixed(1)}%`);
});

test('absurd orientation lag degrades to correct-but-soft, never wrong', () => {
  const { track } = drive({
    pitch: (t) => 14 * Math.sin(2 * Math.PI * 0.8 * t),
    lagMs: 300,
    secs: 6,
  });
  const rows = track.filter((r) => r.ms > 2000);
  assert.ok(travel(rows, 'x') < 0.04, 'still no cross-axis motion at 300ms lag');
  assert.ok(travel(rows, 'y') > 0.2, 'vertical still works');
});

// ── Stillness and lifecycle ─────────────────────────────────────────────────
test('the cursor is rock-still at rest', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5;
  const p = new Pointer({ degPerScreen: 30 });
  let ms = 0;
  const xs = [];
  for (let i = 0; i < 60 * 5; i += 1, ms += 1000 / 60) {
    p.update({
      alpha: rnd() * 0.3, beta: rnd() * 0.3, gamma: 0,
      motion: { rx: rnd() * 0.2, ry: rnd() * 0.2, rz: rnd() * 0.2 },
    }, 1 / 60, ms);
    xs.push(p.sampleAt(ms).x);
  }
  const t = Math.max(...xs) - Math.min(...xs);
  assert.ok(t < 0.005, `rest wobble ${(t * 100).toFixed(2)}% of screen`);
});

test('stillness never corrupts the learned map', () => {
  const { p } = drive({ ...WANDER, secs: 5 });
  assert.ok(p.gyroTrusted);
  const before = p.map.map((m) => (m ? { ...m } : null));
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5;
  let ms = 100000;
  for (let i = 0; i < 60 * 30; i += 1, ms += 1000 / 60) {
    p.update({
      alpha: rnd() * 0.3, beta: 0, gamma: 0,
      motion: { rx: rnd() * 0.1, ry: rnd() * 0.1, rz: rnd() * 0.1 },
    }, 1 / 60, ms);
  }
  // Columns and signs must be untouched; scale may drift a couple of percent
  // from the handful of packets where the motion-EMA decays across the
  // wander-to-stillness boundary. That is a bounded transition tail, not
  // learning-from-noise.
  const after = p.map;
  before.forEach((b, i) => {
    if (!b) { assert.equal(after[i], null); return; }
    assert.equal(after[i].col, b.col, `axis ${i} column unchanged`);
    assert.equal(after[i].sign, b.sign, `axis ${i} sign unchanged`);
    assert.ok(Math.abs(after[i].scale - b.scale) / b.scale < 0.05,
      `axis ${i} scale within 5% (${b.scale.toFixed(3)} → ${after[i].scale.toFixed(3)})`);
  });
  assert.ok(p.gyroTrusted, 'trust retained');
});

test('recentre snaps to the middle and stays', () => {
  const { p } = drive({ ...WANDER, secs: 2 });
  p.recentre();
  assert.equal(p.pos.x, 0.5);
  assert.equal(p.pos.y, 0.5);
  assert.equal(p.sampleAt(999999).x, 0.5, 'no coasting after recentre');
});

test('when packets stop, the cursor freezes instead of coasting', () => {
  const { p, track } = drive({ yaw: (t) => 20 * t, secs: 2 });
  const last = track[track.length - 1];
  const later = p.sampleAt(last.ms + 1000);
  assert.ok(Math.abs(later.x - last.x) < 0.02,
    `coasted ${(Math.abs(later.x - last.x) * 100).toFixed(1)}% after packets stopped`);
});

// ── Pose anchoring: the cursor's centre must stay the phone's centre ────────
// The complaint that drove this: constant slashing (fruit ninja) un-centred
// the cursor until the player recentred by hand every minute. Two mechanisms
// fix it — overshoot headroom at the edges, and stillness re-anchoring to the
// beam's absolute pose. Trajectories here are in the user's frame; everything
// the pointer sees is derived numerically, per the rules at the top.

test('an over-swing past the edge comes back to centre', () => {
  const p = new Pointer({ degPerScreen: 30 });
  drive({ ...WANDER, secs: 4, pointer: p });          // earn gyro trust first
  assert.ok(p.gyroTrusted, 'trusted after wander');
  p.recentre();
  // 25° right and back — 10° past the half-screen edge (15° at sensitivity 1).
  // The old screen-space clamp lost those 10° forever: the cursor came back
  // 33% off and stayed there. Now the overshoot buffer absorbs part and the
  // provable-error heal repays the rest within about a second.
  const out = (t) => (t < 1 ? 0
    : t < 1.5 ? -25 * ((t - 1) / 0.5)
      : t < 2 ? -25
        : t < 2.5 ? -25 * (1 - ((t - 2) / 0.5)) : 0);
  const { track } = drive({ yaw: out, pitch: () => 0, secs: 4.5, pointer: p });
  const done = track[track.length - 1];
  assert.ok(Math.abs(done.x - 0.5) < 0.06, `returned to x=${done.x.toFixed(3)}`);
});

test('drift from a huge clamped swing heals while the hand is still', () => {
  const p = new Pointer({ degPerScreen: 30 });
  drive({ ...WANDER, secs: 4, pointer: p });
  assert.ok(p.gyroTrusted, 'trusted after wander');
  p.recentre();
  // 60° out and back blows even the overshoot margin — the clamp genuinely
  // eats aim. The stillness that follows must re-anchor to the true pose.
  const out = (t) => (t < 0.5 ? 0
    : t < 1 ? -60 * ((t - 0.5) / 0.5)
      : t < 1.5 ? -60
        : t < 2 ? -60 * (1 - ((t - 1.5) / 0.5)) : 0);
  const { track } = drive({ yaw: out, pitch: () => 0, secs: 6.5, pointer: p });
  const justBack = track.find((r) => r.ms >= 2200);
  const done = track[track.length - 1];
  assert.ok(Math.abs(justBack.x - 0.5) > 0.2,
    `sanity: the clamp cost real aim first (x=${justBack.x.toFixed(3)})`);
  assert.ok(Math.abs(done.x - 0.5) < 0.06, `healed to x=${done.x.toFixed(3)}`);
});

test('a held aim is never dragged — healing targets the pose, not the centre', () => {
  // Asserts the linear pose mapping, so precision mode (which deliberately
  // moves slow motion less) is off; its own no-creep test is below.
  const p = new Pointer({ degPerScreen: 30, precision: false });
  drive({ ...WANDER, secs: 4, pointer: p });
  p.recentre();
  // Raise the aim 4° and hold it there, dead still, for seven seconds.
  const hold = (t) => (t < 0.5 ? 0 : t < 1 ? 4 * ((t - 0.5) / 0.5) : 4);
  const { track } = drive({ yaw: () => 0, pitch: hold, secs: 8, pointer: p });
  // By 4s the deadzone loss from the ramp has healed; from there on the aim
  // must sit at the pose-true position (0.5 − 4/18 = 0.278) and not creep.
  const settled = track.find((r) => r.ms >= 4000);
  const done = track[track.length - 1];
  assert.ok(Math.abs(done.y - 0.5) > 0.1, `sanity: aim is off-centre (y=${done.y.toFixed(3)})`);
  assert.ok(Math.abs(done.y - (0.5 - 4 / 18)) < 0.02,
    `holds the pose-true position (y=${done.y.toFixed(3)})`);
  assert.ok(Math.abs(done.y - settled.y) < 0.01,
    `held aim crept: ${settled.y.toFixed(3)} → ${done.y.toFixed(3)}`);
});

test('clamp loss is repaid mid-play — gentle aiming, no stillness required', () => {
  // The real complaint: fruit ninja never contains 800ms of true stillness,
  // so drift piled up until the player pressed re-centre by hand. A clamped
  // swing's loss must now heal during ordinary between-slash aiming motion.
  const p = new Pointer({ degPerScreen: 30 });
  drive({ ...WANDER, secs: 4, pointer: p });
  assert.ok(p.gyroTrusted, 'trusted after wander');
  p.recentre();
  // A huge 60° slash out and back — far past the overshoot cap, aim is lost —
  // followed by continuous gentle pitch wobble (~9°/s peak: above the still
  // gate, well under the calm gate), never a moment of stillness.
  const yaw = (t) => (t < 0.5 ? 0
    : t < 1 ? -60 * ((t - 0.5) / 0.5)
      : t < 1.5 ? -60
        : t < 2 ? -60 * (1 - ((t - 1.5) / 0.5)) : 0);
  const pitch = (t) => (t < 2 ? 0 : 3 * Math.sin(2 * Math.PI * 0.5 * (t - 2)));
  const { track } = drive({ yaw, pitch, secs: 7, pointer: p });
  const justBack = track.find((r) => r.ms >= 2100);
  assert.ok(Math.abs(justBack.x - 0.5) > 0.2,
    `sanity: the clamp cost real aim (x=${justBack.x.toFixed(3)})`);
  const done = track[track.length - 1];
  assert.ok(Math.abs(done.x - 0.5) < 0.08,
    `repaid during gentle aiming, no stillness (x=${done.x.toFixed(3)})`);
});

test('display lead cuts tracking delay during swings, and only during swings', () => {
  // Identical wander through a realistic 30ms sensor→game pipeline, lead on
  // vs off. The led cursor must track the commanded motion measurably
  // tighter (it exists to cover exactly that delay), while gentle aiming
  // must be bit-identical — the lead is gated on real motion, so tremor is
  // never amplified (that bug shipped once; see the git history).
  const on = drive({ ...WANDER, secs: 6, packetDelayMs: 30 });
  const off = drive({
    ...WANDER, secs: 6, packetDelayMs: 30, pointer: new Pointer({ degPerScreen: 30, displayLead: false }),
  });
  assert.ok(on.p.gyroTrusted && off.p.gyroTrusted, 'both trusted');
  const errOn = yawError(on.track, 3000);
  const errOff = yawError(off.track, 3000);
  assert.ok(errOn < errOff * 0.8,
    `lead tightens tracking: ${(errOn * 100).toFixed(2)}% vs ${(errOff * 100).toFixed(2)}%`);

  // Gentle aiming (under the 15°/s ramp): the two must agree exactly.
  const slowOn = drive({
    yaw: (t) => 2 * Math.sin(2 * Math.PI * 0.5 * t), secs: 4, packetDelayMs: 30,
  });
  const slowOff = drive({
    yaw: (t) => 2 * Math.sin(2 * Math.PI * 0.5 * t), secs: 4, packetDelayMs: 30,
    pointer: new Pointer({ degPerScreen: 30, displayLead: false }),
  });
  let maxDiff = 0;
  for (let i = 0; i < slowOn.track.length; i += 1) {
    maxDiff = Math.max(maxDiff, Math.abs(slowOn.track[i].x - slowOff.track[i].x));
  }
  assert.ok(maxDiff < 1e-9, `no lead below the motion gate (max diff ${maxDiff.toExponential(1)})`);
});

test('display lead does not shimmer: noisy gyro, smooth cursor', () => {
  // Raw per-packet rate noise multiplied by the lead horizon lands straight
  // in the drawn position as frame-to-frame shimmer — the regression that
  // shipped and was felt immediately. The lead must extrapolate a smoothed
  // rate: with a noisy gyro, lead-on frame-to-frame roughness must stay
  // close to lead-off. Roughness = mean |second difference| of x, which a
  // constant-rate sweep keeps near zero except for noise.
  let seed = 11;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  const noisy = (w) => [w.x + rnd() * 10, w.y + rnd() * 10, w.z + rnd() * 10];
  // ±10° at 0.7Hz: rates peak ~44°/s (lead fully engaged), cursor on-screen.
  const sweep = {
    yaw: (t) => 10 * Math.sin(2 * Math.PI * 0.7 * t),
    secs: 6, device: noisy, packetDelayMs: 30,
  };

  const roughness = (track) => {
    let sum = 0;
    let n = 0;
    for (let i = 2; i < track.length; i += 1) {
      if (track[i].ms < 3000) continue;   // trust earned, ramp fully on
      sum += Math.abs(track[i].x - 2 * track[i - 1].x + track[i - 2].x);
      n += 1;
    }
    return sum / n;
  };
  seed = 11;
  const on = drive({ ...sweep });
  seed = 11;
  const off = drive({ ...sweep, pointer: new Pointer({ degPerScreen: 30, displayLead: false }) });
  const rOn = roughness(on.track);
  const rOff = roughness(off.track);
  assert.ok(rOn < rOff * 1.35,
    `lead adds no shimmer: ${(rOn * 1e4).toFixed(2)} vs ${(rOff * 1e4).toFixed(2)} (×1e-4/frame²)`);

  // And at genuinely fast swings (~100°/s peak, lead fully engaged) — the
  // "jittery when I move fast" report. The raw-rate lead measured ~2× here.
  const fast = {
    yaw: (t) => 13 * Math.sin(2 * Math.PI * 1.2 * t),
    secs: 6, device: noisy, packetDelayMs: 30,
  };
  seed = 11;
  const fOn = drive({ ...fast });
  seed = 11;
  const fOff = drive({ ...fast, pointer: new Pointer({ degPerScreen: 30, displayLead: false }) });
  const frOn = roughness(fOn.track);
  const frOff = roughness(fOff.track);
  assert.ok(frOn < frOff * 1.7,
    `fast swings stay clean: ${(frOn * 1e4).toFixed(2)} vs ${(frOff * 1e4).toFixed(2)} (×1e-4/frame²)`);
});

test('network latency lead: tighter tracking over a slow link, unchanged on LAN', () => {
  // Online play adds real one-way transit (~100ms at 200ms RTT) that the
  // LAN-tuned horizon never covered. Feeding the measured delay in must
  // tighten tracking over that link, and must be exactly a no-op at 0.
  const slow = { ...WANDER, secs: 6, packetDelayMs: 100 };
  const lan = drive(slow);
  const tuned = drive({ ...slow, pointer: new Pointer({ degPerScreen: 30, networkLatency: 0.1 }) });
  const errLan = yawError(lan.track, 3000);
  const errTuned = yawError(tuned.track, 3000);
  assert.ok(errTuned < errLan * 0.8,
    `latency-aware lead tracks better: ${(errTuned * 100).toFixed(2)}% vs ${(errLan * 100).toFixed(2)}%`);

  // ...without the longer lead turning into shimmer: held to the same bounds
  // the LAN lead is (see "display lead does not shimmer").
  let seed = 11;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  const noisy = (w) => [w.x + rnd() * 10, w.y + rnd() * 10, w.z + rnd() * 10];
  const rough = (track) => {
    let s = 0; let n = 0;
    for (let i = 2; i < track.length; i += 1) {
      if (track[i].ms < 3000) continue;
      s += Math.abs(track[i].x - 2 * track[i - 1].x + track[i - 2].x); n += 1;
    }
    return s / n;
  };
  for (const [yaw, bound] of [
    [(t) => 10 * Math.sin(2 * Math.PI * 0.7 * t), 1.35],
    [(t) => 13 * Math.sin(2 * Math.PI * 1.2 * t), 1.7],
  ]) {
    const run = (pointer) => { seed = 11; return rough(drive({ yaw, secs: 6, device: noisy, packetDelayMs: 100, pointer }).track); };
    const off = run(new Pointer({ degPerScreen: 30, displayLead: false }));
    const on = run(new Pointer({ degPerScreen: 30, networkLatency: 0.1 }));
    assert.ok(on < off * bound, `no shimmer over a slow link: ${(on * 1e4).toFixed(2)} vs ${(off * 1e4).toFixed(2)}`);
  }

  const a = drive({ ...WANDER, secs: 4, packetDelayMs: 30 });
  const b = drive({ ...WANDER, secs: 4, packetDelayMs: 30, pointer: new Pointer({ degPerScreen: 30, networkLatency: 0 }) });
  const maxDiff = Math.max(...a.track.map((r, i) => Math.abs(r.x - b.track[i].x)));
  assert.ok(maxDiff < 1e-9, 'zero latency is bit-identical to the old behaviour');

  const p = new Pointer({});
  p.setNetworkRtt(200);
  assert.ok(Math.abs(p.networkLatency - 0.1) < 1e-9, 'first RTT seeds one-way directly');
  p.setNetworkRtt(400);
  assert.ok(p.networkLatency > 0.1 && p.networkLatency < 0.2, 'later RTTs are smoothed');
});

test('the default pointer speed is the rebased 20°-per-screen (old 150%)', () => {
  assert.equal(new Pointer({}).degPerScreen, 20);
  assert.equal(new Pointer({}).sensitivity, 1);
});

// ── Wi-Fi jitter: the phone's own clock keeps aim exact ─────────────────────
// Learn (0-5s), hold still (5-6.5s), aim hard (6.5-12.5s), then stop dead.
// The error that matters is how far the cursor sits from where it should be
// the moment the hand stops — before any healing can hide it. "Where it
// should be" is the pointer's own fully healed rest position 7s later.
const AIM = (u) => 4.5 * Math.sin(2 * Math.PI * 1.1 * u) + 3 * Math.sin(2 * Math.PI * 0.37 * u)
  + 2 * Math.sin(2 * Math.PI * 2.3 * u);
const STOP_DRILL = {
  yaw: (t) => (t < 5 ? 5 * Math.sin(2 * Math.PI * t) : 5 * Math.sin(2 * Math.PI * 5)
    + (t < 6.5 ? 0 : AIM(Math.min(t, 12.5) - 6.5))),
  pitch: (t) => (t < 5 ? 5 * Math.sin(2 * Math.PI * 1.4 * t) : 5 * Math.sin(2 * Math.PI * 1.4 * 5)
    + (t < 6.5 ? 0 : 4 * Math.sin(2 * Math.PI * 1.7 * (Math.min(t, 12.5) - 6.5)))),
  secs: 20,
};
function stopError(opts) {
  const { p, track } = drive({ ...STOP_DRILL, ...opts });
  const off = (r) => r.x - (0.5 - r.yaw / DEG_PER_SCREEN);
  const atStop = track.find((r) => r.ms >= 12850);
  const healed = track.find((r) => r.ms >= 19900);
  return { p, err: Math.abs(off(atStop) - off(healed)) };
}

test('Wi-Fi jitter cannot move the cursor off the hand (phone clock)', () => {
  const calm = stopError({});
  assert.ok(calm.p.gyroTrusted);
  assert.ok(calm.err < 0.01, `on a clean link the cursor stops within 1% (${(calm.err * 100).toFixed(2)}%)`);
  for (const jitterMs of [40, 70, 120]) {
    for (const integrals of [false, true]) {
      const { p, err } = stopError({ jitterMs, integrals });
      assert.ok(p.gyroTrusted, `trusted under ${jitterMs}ms jitter`);
      assert.ok(Math.abs(err - calm.err) < 0.002,
        `${jitterMs}ms jitter${integrals ? ' + integrals' : ''}: same as a clean link (${(err * 100).toFixed(2)}% vs ${(calm.err * 100).toFixed(2)}%)`);
    }
  }
});

test('regression: timing by packet ARRIVAL let Wi-Fi jitter push the cursor off', () => {
  // Pins why the phone clock matters: without it the same drill drifts.
  const calm = stopError({ phoneClock: false });
  const worst = Math.max(...[40, 70].map((jitterMs) => stopError({ jitterMs, phoneClock: false }).err));
  assert.ok(worst > calm.err + 0.01, `arrival timing drifts under jitter (${(worst * 100).toFixed(2)}%)`);
});

test('phone-side integrals recover gyro motion the send-rate cap skipped', () => {
  // The gyro fires at 120Hz but only every other reading is sent, and the
  // reading that IS sent was taken while the hand had slowed down. Without
  // integrals the game sees only that last rate; with them it gets the full
  // rotation, skipped readings included.
  const p = new Pointer({ degPerScreen: 30 });
  drive({ ...WANDER, secs: 5, pointer: p, integrals: true });
  assert.ok(p.gyroTrusted);
  const yawAxis = p.map[2] || p.map[1];
  const send = (rateSent, rotated, dtS) => {
    const r = [0, 0, 0];
    r[yawAxis.col] = rateSent * yawAxis.sign;
    const ints = { ...p.prevInt };
    ints[['x', 'y', 'z'][yawAxis.col]] += rotated * yawAxis.sign;
    const t = p.prevPhoneT + dtS * 1000;
    p.update({
      quat: FLAT, t,
      motion: { rx: r[0], ry: r[1], rz: r[2], ix: ints.x, iy: ints.y, iz: ints.z, it: ints.t + dtS },
    }, dtS, t);
  };
  const before = p.yawOffDeg;
  // 10 packets, each covering two 1/120s readings: 150°/s then 50°/s.
  // True rotation per packet = (150 + 50) / 120 = 1.667° (in reported units
  // before the learned scale); the sent rate alone would claim 50/60 = 0.83°.
  for (let k = 0; k < 10; k += 1) send(50, (150 + 50) / 120, 1 / 60);
  const moved = Math.abs(p.yawOffDeg - before) / Math.abs(yawAxis.scale);
  assert.ok(Math.abs(moved - 16.67) < 1.5, `full rotation committed: ${moved.toFixed(2)} of 16.67`);
});

// ── Precision mode ──────────────────────────────────────────────────────────

test('precision: slow careful motion moves the cursor less, fast moves are untouched', () => {
  const travelFor = (precision, degPerSec) => {
    const p = new Pointer({ degPerScreen: 30, precision });
    drive({ ...WANDER, secs: 5, pointer: p, integrals: true });
    p.recentre();
    const secs = 3 / degPerSec;                     // a 3° move at this speed
    const yaw = (t) => (t < 0.3 ? 0 : t < 0.3 + secs ? -degPerSec * (t - 0.3) : -3);
    const { track } = drive({ yaw, secs: 0.3 + secs + 0.25, pointer: p, integrals: true });
    return track[track.length - 1].x - 0.5;
  };
  const slowOn = travelFor(true, 2);
  const slowOff = travelFor(false, 2);
  const fastOn = travelFor(true, 120);
  const fastOff = travelFor(false, 120);
  assert.ok(slowOff > 0.08, `sanity: a 3° move travels ~10% (${slowOff.toFixed(3)})`);
  assert.ok(slowOn < slowOff * 0.65, `slow aim is finer (${slowOn.toFixed(3)} vs ${slowOff.toFixed(3)})`);
  assert.ok(Math.abs(fastOn - fastOff) < 0.01, `fast moves unchanged (${fastOn.toFixed(3)} vs ${fastOff.toFixed(3)})`);
});

test('precision: a precise adjustment stays put — healing never undoes it', () => {
  const p = new Pointer({ degPerScreen: 30 });
  drive({ ...WANDER, secs: 5, pointer: p, integrals: true });
  p.recentre();
  // Creep the aim 2° over 1s, then hold dead still for 6s.
  const pitch = (t) => (t < 0.3 ? 0 : t < 1.3 ? 2 * (t - 0.3) : 2);
  const { track } = drive({ pitch, secs: 7.5, pointer: p, integrals: true });
  const after = track.find((r) => r.ms >= 1600);
  const done = track[track.length - 1];
  assert.ok(Math.abs(after.y - 0.5) > 0.02, `sanity: it moved (${after.y.toFixed(3)})`);
  assert.ok(Math.abs(done.y - after.y) < 0.004, `no creep: ${after.y.toFixed(3)} → ${done.y.toFixed(3)}`);
});

test('precision: hand tremor shimmer is reduced', () => {
  // One continuous run: learn on the wander (which ends at rest at 5s), then
  // hold the aim with 10Hz physiological tremor of 0.06°.
  const tremor = (t) => 0.06 * Math.sin(2 * Math.PI * 10 * t);
  const shimmer = (precision) => {
    const { track } = drive({
      yaw: (t) => (t < 5 ? WANDER.yaw(t) : tremor(t)),
      pitch: (t) => (t < 5 ? WANDER.pitch(t) : tremor(t)),
      secs: 12,
      pointer: new Pointer({ degPerScreen: 30, precision }),
      integrals: true,
    });
    // Shimmer = frame-to-frame jitter (slow settling is not shimmer).
    const xs = track.filter((r) => r.ms >= 9000).map((r) => r.x);
    let sum = 0;
    for (let i = 1; i < xs.length; i += 1) sum += Math.abs(xs[i] - xs[i - 1]);
    return sum / (xs.length - 1);
  };
  const on = shimmer(true);
  const off = shimmer(false);
  assert.ok(off > 0.0002, `sanity: tremor is visible without precision (${(off * 1000).toFixed(3)}‰/frame)`);
  assert.ok(on <= off * 0.7, `tremor shimmer cut (${(on * 1000).toFixed(3)} vs ${(off * 1000).toFixed(3)} ‰ of screen per frame)`);
});

// ── Tilt games: the pointer's learned gyro powers the steering boost ───────

test('tray steering: the gyro learned from rolling alone cancels fusion lag (swapped-axis phone)', () => {
  // Tray grip: flat, long axis across, screen leaned 8° toward the face;
  // steering rolls it about the player's forward (world north) axis.
  const grip = mul(axisQ(0, -8), axisQ(2, 90));
  const roll = (t) => 20 * Math.sin(2 * Math.PI * 0.7 * t) + 7 * Math.sin(2 * Math.PI * 1.9 * t);
  const att = (t) => mul(axisQ(1, roll(Math.max(0, t))), grip);
  const run = (boost) => {
    const p = new Pointer({ degPerScreen: 30 });
    const steer = new TraySteer({ boost });
    const ideal = new TraySteer({ boost: false });
    const FRAME = 1000 / 60;
    let err = 0;
    let n = 0;
    for (let i = 0; i < 14 * 60; i += 1) {
      const ms = i * FRAME;
      const t = ms / 1000;
      const h = 1e-4;
      const w = omegaBody(bodyAxesFromQuat(att(t)), bodyAxesFromQuat(att(t + h)), h);
      const r = DEVICE.swapped(w);
      const sample = { quat: att(t - 0.06), t: ms, motion: { rx: r[0], ry: r[1], rz: r[2] } };
      p.update(sample, FRAME / 1000, ms);
      const out = steer.update(axesFromSample(sample), FRAME / 1000, ms, p.bodyRate);
      const want = ideal.update(axesFromSample({ quat: att(t) }), FRAME / 1000, ms);
      if (t > 8) { err += Math.abs(out - want); n += 1; }
    }
    return { err: err / n, p, steer };
  };
  const off = run(false);
  const on = run(true);
  assert.ok(on.p.bodyRate, 'the map proved itself on roll-only motion');
  assert.ok(Math.abs(on.steer.lag.lagS - 0.06) <= 0.02, `measured ${on.steer.lag.lagS * 1000}ms of a 60ms lag`);
  assert.ok(on.err < off.err * 0.3, `steer error ${on.err.toFixed(2)}° vs ${off.err.toFixed(2)}° without the gyro`);
});
