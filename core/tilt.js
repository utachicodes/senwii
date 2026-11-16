/**
 * Tilt steering, shared by every "hold it and roll it" game (Alien Attack,
 * the racer). The phone is held sideways — flat like a tray, or tilted back
 * like a steering wheel — and rolling it (right end down) steers right.
 * Everything is measured RELATIVE to a reference captured from the player's
 * own pose, never from assumed Euler angles.
 *
 * Games drive this through `TraySteer` (capture + anti-drift filter).
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

// ── Gyro boost: undo the phone's attitude-fusion lag ──────────────────────
// The bank comes from the OS's fused orientation, which trails the real hand
// by 20-120ms depending on the phone. The gyro has no such lag: the rotation
// it recorded over the last (measured) lag window is exactly how far the
// fused bank is behind, so adding it puts the reading where the hand actually
// is. Once the hand has been still for one lag window it adds nothing, so it
// can never leave the steering offset, and an unmeasurable lag means no
// boost at all.
export const LAG_CANDIDATES_MS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
// A lag only counts if the gyro, shifted by it, explains the fused motion:
// residual under this fraction of the motion's own power. A backwards or
// garbage gyro explains nothing, so it gets no boost at all.
export const LAG_FIT_MAX = 0.2;
export const LAG_EVIDENCE_S = 1.2;     // seconds of real rolling before trusting a lag
export const LEAD_CAP_DEG = 20;        // safety bound on the catch-up a sample can add
const MOVING_DPS = 12;
const RATE_TAU_S = 0.04;

/** d(bank)/dt in deg/s from gyro body rates (deg/s), for a capture with sign sy. */
export function gyroBankRate(axes, bodyRate, sy) {
  const w = {
    x: axes.x.x * bodyRate.x + axes.y.x * bodyRate.y + axes.z.x * bodyRate.z,
    y: axes.x.y * bodyRate.x + axes.y.y * bodyRate.y + axes.z.y * bodyRate.z,
  };
  // d(y.z)/dt = (ω_world × y).z; bank = −asin(sy·y.z).
  const dyz = w.x * axes.y.y - w.y * axes.y.x;
  return (-sy * dyz) / Math.sqrt(Math.max(1e-4, 1 - axes.y.z * axes.y.z));
}

class LagMeter {
  constructor() {
    this.clock = 0;
    this.hist = [];                    // { t, g } smoothed gyro bank rate
    this.steps = [];                   // { t, d } raw gyro bank change per sample
    this.err = LAG_CANDIDATES_MS.map(() => 0);
    this.evidence = 0;
    this.sF = 0;                       // smoothed fused bank rate
    this.sG = 0;                       // smoothed gyro bank rate
    this.prevBank = undefined;
    this.prevG = undefined;
    this.power = 0;                    // Σ sF² over the same window as err
    this.lagS = 0;
  }

  /**
   * How far the fused bank is behind the hand: the rotation the gyro recorded
   * over the last `lagS` seconds. Exact where "rate × lag" only extrapolates
   * (and mis-guesses whenever the hand is speeding up or slowing down).
   */
  catchUp() {
    if (!(this.lagS > 0)) return 0;
    const from = this.clock - this.lagS;
    let sum = 0;
    for (let i = this.steps.length - 1; i >= 0; i -= 1) {
      const s = this.steps[i];
      const prevT = i > 0 ? this.steps[i - 1].t : s.t - 1e-9;
      if (prevT >= from) sum += s.d;
      else { sum += s.d * Math.max(0, (s.t - from) / (s.t - prevT)); break; }
    }
    return sum;
  }

  gyroAt(t) {
    // Linear interpolation between the samples around t: picking the nearest
    // older sample quantised every candidate to the packet grid, so 20ms and
    // 30ms read the same 33ms-old sample and the lag came out short.
    const h = this.hist;
    for (let i = h.length - 1; i >= 0; i -= 1) {
      if (h[i].t <= t) {
        const next = h[i + 1];
        if (!next) return h[i].g;
        const u = (t - h[i].t) / (next.t - h[i].t);
        return h[i].g + (next.g - h[i].g) * u;
      }
    }
    return undefined;
  }

  update(fusedBank, gyroRate, dt) {
    if (!(dt > 0)) return this.lagS;
    this.clock += dt;
    const k = 1 - Math.exp(-dt / RATE_TAU_S);
    if (this.prevBank !== undefined) this.sF += ((fusedBank - this.prevBank) / dt - this.sF) * k;
    this.prevBank = fusedBank;
    // The fused rate is a backward difference over this interval, i.e. the
    // mean rate across it; give the gyro the same mean (trapezoid) so the
    // two are in phase and a lag-free phone measures exactly 0.
    const gMean = this.prevG === undefined ? gyroRate : 0.5 * (gyroRate + this.prevG);
    this.prevG = gyroRate;
    this.sG += (gMean - this.sG) * k;
    this.hist.push({ t: this.clock, g: this.sG });
    while (this.hist.length > 2 && this.clock - this.hist[0].t > 0.2) this.hist.shift();
    this.steps.push({ t: this.clock, d: gMean * dt });
    while (this.steps.length > 2 && this.clock - this.steps[0].t > 0.2) this.steps.shift();

    // Score candidates only once both rate signals have settled (a few
    // smoothing time constants) and the history covers EVERY candidate:
    // otherwise short lags absorb the start-up transient that long lags
    // skip, and the comparison is rigged.
    const maxLagS = LAG_CANDIDATES_MS[LAG_CANDIDATES_MS.length - 1] / 1000;
    const warmed = this.clock > 5 * RATE_TAU_S && this.clock - this.hist[0].t >= maxLagS;
    if (warmed && (Math.abs(this.sG) > MOVING_DPS || Math.abs(this.sF) > MOVING_DPS)) {
      const decay = Math.exp(-dt / 20);
      LAG_CANDIDATES_MS.forEach((ms, i) => {
        const g = this.gyroAt(this.clock - ms / 1000);
        if (g === undefined) return;
        this.err[i] = this.err[i] * decay + (this.sF - g) ** 2 * dt;
      });
      this.power = this.power * decay + this.sF ** 2 * dt;
      this.evidence += dt;
      if (this.evidence >= LAG_EVIDENCE_S) {
        let best = 0;
        for (let i = 1; i < this.err.length; i += 1) if (this.err[i] < this.err[best]) best = i;
        // Hysteresis: keep the current lag unless another fits clearly better,
        // so neighbouring candidates with near-equal fits can't flicker.
        const cur = LAG_CANDIDATES_MS.indexOf(Math.round(this.lagS * 1000));
        if (cur >= 0 && this.lagS > 0 && this.err[cur] <= this.err[best] * 1.15) best = cur;
        this.lagS = this.err[best] < LAG_FIT_MAX * this.power ? LAG_CANDIDATES_MS[best] / 1000 : 0;
      }
    }
    return this.lagS;
  }
}

// ── TraySteer: capture + filter, nothing else ─────────────────────────────

/**
 * TraySteer — the tilt-steering stack games drive: exactly the pipeline
 * Alien Attack shipped with and was play-proven on. The neutral is captured
 * from the pose at (re)start, optionally after a grace period while the
 * hand settles; SteerFilter then heals any small standing bias.
 *
 * Deliberately NOT here (a previous build added these and they broke play):
 *   - grip-change re-centring: in the flat tray grip, banking the phone IS
 *     tilting the screen normal, so every hard turn read as a "grip change",
 *     dropped the neutral mid-corner and re-locked on the banked pose;
 *   - stillness-gated capture: sensor shimmer alone exceeds any usable
 *     stillness threshold, so the capture hunted for seconds of dead steer;
 *   - output smoothing / authority ramps: latency the player feels as mush.
 * The player re-centres with the phone's recentre button when they want.
 *
 * Gyro boost: pass the pointer's learned gyro (channel.pointer.bodyRate) as
 * update()'s 4th argument and the fused attitude's lag is measured per phone
 * and cancelled (see LagMeter). Unlike the smoothing above, this REMOVES
 * latency, and it switches itself off when the gyro can't be trusted.
 */
export class TraySteer {
  constructor({ invert = false, boost = true } = {}) {
    this.invert = invert;
    this.filter = new SteerFilter();
    this.ref = null;                     // captured neutral; null = capture next sample
    this.prevRight = null;               // keeps the right-hand side stable across recentres
    this.notBefore = 0;                  // capture grace (hand still coming to rest)
    this.idleMode = false;
    this.lastBank = undefined;
    this.out = 0;
    this.boost = boost;                  // gyro lag compensation (see LagMeter)
    this.lag = new LagMeter();           // per-phone, survives recentres
    this.lead = 0;
  }

  get status() { return this.ref ? 'locked' : 'hunting'; }

  /** Take the next sample (at or after `notBefore`, ms) as "straight". */
  recentre(notBefore = 0) {
    this.ref = null;
    this.notBefore = notBefore;
    this.filter = new SteerFilter();
    this.filter.idle = this.idleMode;
  }

  setInvert(v) { this.invert = v; }

  describe() {
    const raw = this.lastBank === undefined ? '—' : `${this.lastBank.toFixed(1)}°`;
    const lag = this.lag.evidence >= LAG_EVIDENCE_S ? `${Math.round(this.lag.lagS * 1000)}ms` : '—';
    return `${this.status} · raw ${raw} · lag ${lag} · lead ${this.lead.toFixed(1)}°`;
  }

  /** Games mark the steer idle between rounds: resting pose = new neutral. */
  set idle(v) {
    this.idleMode = v;
    this.filter.idle = v;
  }

  get idle() { return this.idleMode; }

  /**
   * Feed one sample; returns steer in degrees (+right, ±STEER_FULL at full
   * lock). `bodyRate` is the pointer's learned gyro (channel.pointer.bodyRate,
   * deg/s, body frame) or null; with it the reading is lag-compensated.
   */
  update(axes, dt, now, bodyRate = null) {
    if (!this.ref) {
      if (now < this.notBefore) return (this.out = 0);
      this.ref = captureTray(axes, this.prevRight);
      this.prevRight = this.ref.right;
    }
    let raw = trayRead(axes, this.ref).bank;
    if (!Number.isFinite(raw)) return this.out;       // corrupt packet: hold
    this.lastBank = raw;
    if (bodyRate && this.boost) {
      const g = gyroBankRate(axes, bodyRate, this.ref.sy);
      if (Number.isFinite(g)) {
        this.lag.update(raw, g, dt);
        this.lead = Math.max(-LEAD_CAP_DEG, Math.min(LEAD_CAP_DEG, this.lag.catchUp())) + 0;  // no -0
        raw += this.lead;
      }
    } else {
      this.lead = 0;
    }
    const shaped = this.filter.update(raw, dt);
    this.out = this.invert ? -shaped : shaped;
    if (Object.is(this.out, -0)) this.out = 0;
    return this.out;
  }
}
