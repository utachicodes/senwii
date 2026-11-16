/**
 * Tilt steering, shared by every "hold it and roll it" game (Alien Attack,
 * the racer). The phone is held sideways — flat like a tray, or tilted back
 * like a steering wheel — and rolling it (right end down) steers right.
 * Everything is measured RELATIVE to a reference captured from the player's
 * own pose, never from assumed Euler angles.
 *
 * Games should drive this through `TraySteer`, which adds the glitch-
 * proofing a bare capture+filter stack lacks: stillness-gated capture,
 * grip-change re-centring, idle re-zero, and output smoothing.
 *
 * The capture decides which end of the phone is under the right hand from
 * the screen's lean toward the face: the player's right is 90° clockwise
 * from the player→phone line — the textbook v×up, DEVICE-PINNED
 * (2026-08-24) after two earlier builds accidentally play-tested only
 * their fallbacks and briefly pinned a mirror of reality.
 */

export const STEER_FULL = 18;         // degrees of bank for full lock
export const STEER_DEADZONE = 2.5;    // degrees of hand tremor ignored
export const BIAS_HEAL_BAND = 4.5;    // neutral re-learns only inside this
export const BIAS_HEAL_TAU_S = 6;     // …and this slowly, once settled
export const BIAS_SETTLE_S = 2;       // fast heal right after capture
export const BIAS_SETTLE_TAU_S = 0.6;

const DEG = Math.PI / 180;
const clamp1 = (v) => (v < -1 ? -1 : v > 1 ? 1 : v);

/**
 * Capture the neutral pose. Which end is under the right hand comes from
 * the screen's lean toward the face; when the lean is too small to measure
 * (a phone held nearly perfectly flat) it falls back to the grip the
 * controller shows in wheel mode: crosspad (the phone's top edge) on the
 * player's LEFT. `prevRight` carries the decision across captures so a
 * momentary lean glitch can't flip the steering sign mid-session.
 */
export function captureTray(axes, prevRight = null) {
  const vx = -axes.z.x;                 // player→phone viewing direction,
  const vy = -axes.z.y;                 // horizontal part
  const m = Math.hypot(vx, vy);
  let right = prevRight || { x: 1, y: 0 };
  if (m > 0.05) right = { x: vy / m, y: -vx / m };

  const sy = axes.y.x * right.x + axes.y.y * right.y >= 0 ? 1 : -1;
  const ref = { right, sy, bank0: 0 };
  ref.bank0 = trayRead(axes, ref).bank;
  return ref;
}

/** Bank in degrees, + = right end down, relative to the captured neutral. */
export function trayRead(axes, ref) {
  const rightEndZ = ref.sy * axes.y.z;
  return { bank: -Math.asin(clamp1(rightEndZ)) / DEG - ref.bank0 };
}

/** Deadzone with the full-lock point preserved: 2.5° reads as 0, 18° as 18. */
export function shapeSteer(bankDeg) {
  const a = Math.abs(bankDeg);
  if (a <= STEER_DEADZONE) return 0;
  const sign = bankDeg < 0 ? -1 : 1;
  return sign * (a - STEER_DEADZONE) * (STEER_FULL / (STEER_FULL - STEER_DEADZONE));
}

/**
 * The anti-drift stage. Ordinary attitude wander leaves a degree or two of
 * standing bias, and at 18° full lock that is a constant slide. The filter
 * re-learns the resting bias whenever the corrected bank sits inside a small
 * band (a hand at rest), quickly right after capture and very slowly after,
 * and never while the player is clearly steering.
 *
 * `idle` (set by the game between rounds / on menus) widens the band and
 * speeds the heal: whatever pose the phone then rests in IS the neutral the
 * next round should start from. During play the band stays narrow — a long
 * gentle corner is a deliberate 5° hold, and eating it would be theft.
 */
export class SteerFilter {
  constructor() {
    this.bias = 0;
    this.ageS = 0;
    this.idle = false;
  }

  update(rawBank, dt) {
    this.ageS += dt;
    const corrected = rawBank - this.bias;
    if (this.idle || Math.abs(corrected) < BIAS_HEAL_BAND) {
      const tau = this.idle ? 1.5
        : this.ageS < BIAS_SETTLE_S ? BIAS_SETTLE_TAU_S : BIAS_HEAL_TAU_S;
      this.bias += Math.min(1, dt / tau) * (rawBank - this.bias);
    }
    return shapeSteer(corrected);
  }
}

// ── TraySteer: capture + filter + the glue that makes it glitch-free ──────

// Below this bank rate (°/s) the hand counts as still: a tremor floor, not a
// motion gate. Measured from the bank signal itself, so it needs no
// calibration and works on every device.
export const STILL_RATE_DPS = 7;
// The phone must hold still this long before its pose is trusted as neutral.
export const STILL_MS = 400;
// A persistent change in the play plane's pitch (screen-normal tilt) larger
// than this means the grip itself changed — phone picked up to read a
// message, set on its edge, handed to someone else. Transient leans never
// hold this long; a steep-but-stable wheel grip never leaves its own pitch.
export const GRIP_CHANGE_DEG = 25;
// How long the pose may disagree with the captured pitch before the
// reference is dropped: short enough that steering stops while the phone
// is elsewhere, long enough that a thrown lean never trips it.
export const GRIP_CHANGE_MS = 350;
// The hunt waits this long for stillness before capturing anyway (a moving
// hand should not mean dead steering forever — best effort beats nothing).
export const HUNT_GIVE_UP_MS = 2500;
// Output smoothing: one-pole low-pass on the shaped steer. Small enough to
// stay out of the way of real steering, big enough to erase packet-to-packet
// gyro shimmer — the "jittery ship" failure.
export const SMOOTH_TAU_S = 0.045;
// …plus a slew cap so a corrupted packet can never teleport the wheel.
export const SLEW_DPS = 300;
// Steering authority fades in over this window after a capture, so even a
// mediocre capture can never yank the vehicle on the frame it lands.
export const RAMP_S = 0.35;

/**
 * TraySteer — the whole tilt-steering stack in one object.
 *
 * Why not just captureTray() + SteerFilter() per sample (what Alien Attack
 * did originally): a neutral captured from a single packet is only as good
 * as that packet. Capture while the hand is still coming to rest — pressing
 * A on the results screen does exactly that — and the ship/kart drifts for
 * seconds while the filter slowly heals a bias it was handed at birth. And
 * when the player picks the phone up to look at it and lays it back down,
 * the old neutral is simply wrong from then on.
 *
 * The fixes, each one a failure actually observed in play:
 *
 *   1. Stillness-gated capture. The reference is the AVERAGE of a window in
 *      which the bank reading barely moved — the phone is provably at rest —
 *      so "straight" is a measurement, not a snapshot. A capture mid-swing
 *      is impossible; the hunt waits for stillness.
 *   2. Grip-change re-hunt. A persistent change in the play plane's pitch
 *      (phone picked up, rotated, set down differently) marks the reference
 *      stale; the next still moment re-captures. No more "it drifted after
 *      I checked a message".
 *   3. Idle re-zero. Between rounds the game marks the steer idle, and
 *      whatever pose the phone rests in becomes the neutral for the next
 *      round — the first corner of a new run is as centred as the last.
 *   4. Output smoothing + slew cap. Gyro shimmer stops at the filter; the
 *      vehicle sees a clean signal.
 *   5. Authority ramp. For RAMP_S after every capture the output eases in,
 *      so the worst a capture can do is a soft lean, never a lurch.
 */
export class TraySteer {
  constructor({ invert = false, onCapture = null } = {}) {
    this.invert = invert;
    this.onCapture = onCapture;          // ({ noise }) — HUD may show it
    this.filter = new SteerFilter();
    this.ref = null;                     // locked reference; null = hunting
    this.prov = null;                    // provisional reference while hunting
    this.prevRight = null;               // carries the right-hand sign forward
    this.stillSince = 0;
    this.huntSince = 0;
    this.window = [];                    // { bank, t } recent still samples
    this.pitch0 = 0;                     // play-plane pitch at capture, rad
    this.gripMovedMs = 0;
    this.smoothed = 0;
    this.out = 0;
    this.authority = 0;
    this.status = 'hunting';             // hunting | locked
    this.lastBank = undefined;
    this.prevRaw = undefined;
    this.lastAxes = null;
    this.noise = 0;
    this.idleMode = false;
  }

  /** Drop the reference and wait for stillness to capture a fresh one. */
  recentre() {
    this.ref = null;
    this.prov = null;
    this.stillSince = 0;
    this.huntSince = 0;
    this.window.length = 0;
    this.gripMovedMs = 0;
    this.lastBank = undefined;
    this.prevRaw = undefined;
    this.status = 'hunting';
  }

  setInvert(v) {
    this.invert = v;
  }

  /** One-line summary for the games' debug overlays. */
  describe() {
    const raw = this.lastBank === undefined ? '—' : `${this.lastBank.toFixed(1)}°`;
    return `${this.status} · raw ${raw} · noise ${this.noise.toFixed(1)}°`;
  }

  /**
   * Feed one orientation sample. Returns the shaped steer (−STEER_FULL…
   * STEER_FULL, degrees, +right, post-smoothing).
   */
  update(axes, dt, now) {
    this.lastAxes = axes;

    if (!this.ref) return this.hunt(axes, dt, now);

    // ── Locked ──
    const raw = trayRead(axes, this.ref).bank;
    this.lastBank = raw;

    // Grip-change watch: the play plane's pitch drifting away from the
    // captured pitch — persistently — marks the reference stale. Dropping
    // to hunting right away is the point: a phone lifted out of the play
    // pose must stop steering, not wobble on a dead reference for seconds.
    const pitch = Math.acos(clamp1(axes.z.z));
    const moved = Math.abs(pitch - this.pitch0) > GRIP_CHANGE_DEG * DEG;
    this.gripMovedMs = moved ? this.gripMovedMs + dt * 1000 : 0;
    if (this.gripMovedMs > GRIP_CHANGE_MS) this.recentre();

    const shaped = this.filter.update(raw, dt);
    return this.emit(shaped, dt);
  }

  /** Hunt: wait for stillness, then lock a reference in. */
  hunt(axes, dt, now) {
    if (!this.prov) {
      this.prov = captureTray(axes, this.prevRight);
      if (!this.huntSince) this.huntSince = now;
    }
    const raw = trayRead(axes, this.prov).bank;
    this.lastBank = raw;

    const rate = this.prevRaw === undefined || dt <= 0
      ? Infinity : Math.abs(raw - this.prevRaw) / dt;
    this.prevRaw = raw;

    if (rate < STILL_RATE_DPS) {
      if (!this.stillSince) this.stillSince = now;
      this.window.push({ bank: raw, t: now });
      // Keep roughly STILL_MS + a little of history; more is dead weight.
      while (this.window.length > 2 && now - this.window[0].t > STILL_MS + 300) {
        this.window.shift();
      }
      const held = now - this.stillSince >= STILL_MS;
      if (held || now - this.huntSince > HUNT_GIVE_UP_MS) this.capture(now);
    } else {
      // Motion resets the window but NOT the give-up clock: a hand that
      // never quite stops still gets a best-effort capture.
      this.stillSince = 0;
      this.window.length = 0;
    }
    return this.emit(0, dt);             // no steering until we have a neutral
  }

  /** Average the still window into the reference and lock it. */
  capture(now) {
    const avg = this.window.length
      ? this.window.reduce((a, s) => a + s.bank, 0) / this.window.length
      : 0;
    // Keep the provisional reference's frozen signs — they held through the
    // whole still window — and re-zero it to the window's average pose.
    this.ref = {
      right: this.prov.right,
      sy: this.prov.sy,
      bank0: this.prov.bank0 + avg,
    };
    this.prevRight = this.prov.right;
    this.pitch0 = Math.acos(clamp1(this.lastAxes.z.z));
    // Capture noise: how much the "still" window actually moved. Large
    // noise means the capture is suspect — the authority ramp covers it.
    this.noise = this.window.length > 1
      ? Math.max(...this.window.map((s) => Math.abs(s.bank - avg)))
      : 0;
    this.window.length = 0;
    this.stillSince = 0;
    this.huntSince = 0;
    this.gripMovedMs = 0;
    this.prov = null;
    this.prevRaw = undefined;
    this.filter = new SteerFilter();     // fresh filter; the neutral is exact
    this.filter.idle = this.idleMode;
    this.status = 'locked';
    if (this.onCapture) this.onCapture({ noise: this.noise, at: now });
  }

  /** Games mark the steer idle between rounds: resting pose = new neutral. */
  set idle(v) {
    this.idleMode = v;
    this.filter.idle = v;
  }

  /** Smoothing + slew cap + invert + authority ramp on the way out. */
  emit(shaped, dt) {
    const target = this.invert ? -shaped : shaped;
    // Authority fades in after a capture (and out while hunting); it never
    // ramps down mid-play.
    this.authority = Math.max(0, Math.min(1,
      this.authority + (this.status === 'locked' ? dt / RAMP_S : -dt / RAMP_S)));
    const goal = target * this.authority;
    const k = 1 - Math.exp(-dt / SMOOTH_TAU_S);
    this.smoothed += (goal - this.smoothed) * k;
    const maxStep = SLEW_DPS * dt;
    const step = Math.max(-maxStep, Math.min(maxStep, this.smoothed - this.out));
    this.out += step;
    if (Object.is(this.out, -0)) this.out = 0;
    return this.out;
  }
}
