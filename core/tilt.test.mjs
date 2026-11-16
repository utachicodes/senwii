import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TraySteer, SteerFilter, captureTray, trayRead, shapeSteer,
  STEER_FULL, STEER_DEADZONE, SMOOTH_TAU_S,
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

test('TraySteer: stillness-gated capture, neutral reads zero, rolls read true', () => {
  for (const flip of ['A', 'B']) {
    const rest = trayGrip(flip);
    const steer = new TraySteer({});
    // 1s of jittery rest (±0.5° around the true pose) then a hold.
    const jitter = [];
    for (let i = 0; i < 60; i += 1) {
      jitter.push(rotAxes(rest, NORTH, (Math.random() - 0.5) * 1));
    }
    run(steer, jitter);
    for (let i = 0; i < 90; i += 1) steer.update(rest, DT, (i + 61) * 16.7);
    assert.equal(steer.status, 'locked', 'captured once the phone held still');
    // Roll 12°: after the ramp settles, the output tracks the roll.
    let out = 0;
    const rolled = rotAxes(rest, NORTH, 12 * (Math.PI / 180));
    for (let i = 0; i < 120; i += 1) out = steer.update(rolled, DT, 0);
    assert.ok(out > 8, `a 12° roll steers hard after the ramp (${out.toFixed(1)})`);
    // Back to rest: zero, quickly — the smoothing carries no offset.
    out = run(steer, Array(120).fill(rest));
    assert.ok(Math.abs(out) < 0.5, `rest reads centred (${out.toFixed(2)})`);
  }
});

test('TraySteer: a capture mid-motion is impossible — it waits for stillness', () => {
  const rest = trayGrip('A');
  const steer = new TraySteer({});
  // Swing hard for 2s straight: the hunt must never lock during the motion.
  let t = 0;
  for (let i = 0; i < 120; i += 1) {
    t += DT * 1000;
    steer.update(rotAxes(rest, NORTH, (i % 2 ? 20 : -20) * (Math.PI / 180)), DT, t);
    assert.equal(steer.status, 'hunting', 'no capture while the hand moves');
  }
  // Then rest: it locks.
  for (let i = 0; i < 90; i += 1) {
    t += DT * 1000;
    steer.update(rest, DT, t);
  }
  assert.equal(steer.status, 'locked');
});

test('TraySteer: a capture taken at rest is unaffected by the give-up path', () => {
  // Give-up must not hand back a mid-motion pose as neutral: the window it
  // averages is always the still window, never the moving one.
  const rest = trayGrip('A');
  const steer = new TraySteer({});
  const HUNT_GIVE_UP_MS = 2500;
  let t = 0;
  // Move for just under the give-up time…
  while (t < HUNT_GIVE_UP_MS - 200) {
    t += DT * 1000;
    steer.update(rotAxes(rest, NORTH, (Math.sin(t / 100) > 0 ? 1 : -1) * 15 * (Math.PI / 180)), DT, t);
  }
  // …then hold still: the capture is from the still pose.
  for (let i = 0; i < 120; i += 1) {
    t += DT * 1000;
    steer.update(rest, DT, t);
  }
  assert.equal(steer.status, 'locked');
  const out = run(steer, Array(60).fill(rest));
  assert.ok(Math.abs(out) < 0.5, `captured neutral is this exact pose (${out.toFixed(2)})`);
});

test('TraySteer: output is smoothed — packet noise cannot reach the vehicle', () => {
  const rest = trayGrip('A');
  const steer = new TraySteer({});
  for (let i = 0; i < 90; i += 1) steer.update(rest, DT, i * 16.7);
  // Feed a clean 12° roll, then measure step-to-step variation at the output.
  const rolled = rotAxes(rest, NORTH, 12 * (Math.PI / 180));
  const outs = [];
  for (let i = 0; i < 60; i += 1) outs.push(steer.update(rolled, DT, 0));
  for (let i = 1; i < outs.length; i += 1) {
    const jump = Math.abs(outs[i] - outs[i - 1]);
    // The slew cap (300°/s at 60Hz = 5°/frame) bounds every step.
    assert.ok(jump <= 5 + 1e-9, `no teleporting steps (${jump.toFixed(2)}°)`);
  }
  assert.ok(outs[outs.length - 1] > 8, 'and the real steering still arrives');
});

test('TraySteer: grip change (pitch move held) re-hunts and re-centres', () => {
  const rest = trayGrip('A');
  const steer = new TraySteer({});
  for (let i = 0; i < 90; i += 1) steer.update(rest, DT, i * 16.7);
  assert.equal(steer.status, 'locked');
  const pitch0 = steer.pitch0;
  // Player picks the phone up (whole frame tips 60° about the east axis —
  // a rigid rotation, like lifting the far end) and holds it there.
  const held = rotAxes(rest, { x: 1, y: 0, z: 0 }, 60 * (Math.PI / 180));
  let t = 100_000;
  for (let i = 0; i < 30; i += 1) {    // 0.5s: past GRIP_CHANGE_MS
    t += DT * 1000;
    steer.update(held, DT, t);
  }
  assert.equal(steer.status, 'hunting', 'the stale reference was dropped fast');
  // And the held pose becomes the new neutral once it holds still…
  for (let i = 0; i < 90; i += 1) {
    t += DT * 1000;
    steer.update(held, DT, t);
  }
  assert.equal(steer.status, 'locked');
  assert.notEqual(steer.pitch0, pitch0, 're-anchored to the new pose');
  // …and laying it back down re-centres on the original pose too.
  for (let i = 0; i < 90; i += 1) {
    t += DT * 1000;
    steer.update(rest, DT, t);
  }
  assert.equal(steer.status, 'locked');
  const out = run(steer, Array(60).fill(rest));
  assert.ok(Math.abs(out) < 0.5, `re-centred on the true pose (${out.toFixed(2)})`);
});

test('TraySteer: idle re-zero adopts the resting pose before a new round', () => {
  const rest = trayGrip('A');
  const steer = new TraySteer({});
  for (let i = 0; i < 90; i += 1) steer.update(rest, DT, i * 16.7);
  // The phone now rests at a genuine 6° bank (dropped slightly crooked).
  const crooked = rotAxes(rest, NORTH, 6 * (Math.PI / 180));
  steer.idle = true;
  for (let i = 0; i < 180; i += 1) steer.update(crooked, DT, 0);   // 3s idle
  steer.idle = false;
  const out = run(steer, Array(90).fill(crooked));
  assert.ok(Math.abs(out) < 1, `the crooked rest became neutral (${out.toFixed(2)})`);
  // …but during play the same filter refuses to eat a held steer.
  const steer2 = new SteerFilter();
  for (let i = 0; i < 60 * 5; i += 1) steer2.update(10, DT);
  assert.ok(steer2.update(10, DT) > 6, 'a held 10° steer survives');
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
  assert.ok(SMOOTH_TAU_S > 0 && SMOOTH_TAU_S < 0.2, 'smoothing stays out of the way');
});
