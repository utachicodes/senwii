/**
 * Turbo Racing — track, kart and championship logic. No renderer, no DOM.
 *
 * Three circuits, each a deterministic parametric centreline, so tests, the
 * renderer and the AI all see exactly the same road. The player's kart is
 * free-physics (position, heading, a velocity that lags the heading — that
 * lag is the drift); the CPU karts ride the racing line with per-driver
 * skill and a gentle rubber band so a race stays close without being rigged.
 *
 * Everything is measured in "metres behind the start line": progress starts
 * negative on the grid, crosses zero at the line, and a lap completes every
 * trackLengthM() after that. The player and the AI karts share that model,
 * so standings are one straight comparison.
 *
 * Controls contract: steer = degrees of bank (+right), drift = hop-and-slide
 * that charges a mini-turbo, brake, and boost pads on the road. Throttle is
 * automatic — the skill is the line, the drift and the pads.
 */

export const TOP_SPEED = 34;        // m/s on the racing surface
export const GRASS_SPEED = 13;      // m/s cap off the road
export const BOOST_SPEED = 42;      // m/s floor while a boost is live
export const BOOST_PAD_MS = 1100;   // how long a pad's boost lasts
export const TURN_RATE = 3.4;       // deg of heading per deg of bank per s
export const DRIFT_TURN_MULT = 1.55;
export const GRIP = 6.5;            // velocity relaxes toward heading, 1/s
export const DRIFT_GRIP = 2.3;      // …much slower while drifting
export const GRASS_GRIP = 4;
export const ACCEL = 13;            // m/s²
export const BRAKE = 22;
export const DRAG = 0.8;            // 1/s overspeed decay past the cap
export const WALL_MARGIN = 0.9;     // metres of verge past the painted edge
export const WALL_SCRUB = 1.6;      // 1/s speed loss while scraping
export const DRIFT_MIN_STEER = 5;   // deg of bank needed to start/keep a drift
export const DRIFT_MIN_SPEED = 12;
export const DRIFT_CHARGE_T1 = 0.9; // seconds to the first mini-turbo tier
export const DRIFT_CHARGE_T2 = 1.8;
export const DRIFT_CHARGE_T3 = 2.9;
export const BOOST_T = [0.55, 1.0, 1.55];  // boost seconds per tier
export const RACER_COUNT = 6;
export const POINTS = [10, 8, 6, 5, 4, 3];  // championship points by place
export const PODIUM = 3;            // finish here or better to unlock the next track
export const COUNTDOWN_MS = 3000;
export const CHECKPOINT_COUNT = 8;  // includes the start line (checkpoint 0)
export const SAMPLES = 512;         // centreline resolution for nearest-point queries
export const GRID_ROW_M = 4.4;      // row spacing on the starting grid
export const KART_RADIUS = 1.3;
export const STEER_INPUT_MAX = 30;  // accepted input range (deg of bank)
export const OFFROAD_RESCUE_MS = 4000; // stuck off the road this long → rescue

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const clamp1 = (v) => clamp(v, -1, 1);

/** Deterministic PRNG so tests and replays agree. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function wrapAngle(a) {
  while (a > Math.PI) a -= TAU;
  while (a <= -Math.PI) a += TAU;
  return a;
}

/** Signed shortest distance between two track parameters, in (-0.5, 0.5]. */
export function tDiff(a, b) {
  let d = a - b;
  while (d > 0.5) d -= 1;
  while (d <= -0.5) d += 1;
  return d;
}

// ── The three circuits ─────────────────────────────────────────────────────
//
// Each centreline is a radius r(θ) around a loop, chosen so r never dips
// near zero (no self-intersection, no kinks) and the curvature stays within
// what a drifting kart can hold. Pads are track-parameter spots; medals are
// best-lap targets.

export const TRACKS = [
  {
    slug: 'sunset-speedway',
    name: 'Sunset Speedway',
    icon: 'sunset',
    laps: 3,
    halfWidth: 11,
    order: 0,
    sky: 0xffb36b,
    fog: [0xffb36b, 320, 900],
    ground: 0x8fbb5e,
    road: 0x4d4a56,
    edge: 0xf6f2ea,
    theme: 'sunset',
    pads: [0.16, 0.45, 0.79],
    medalGoldMs: 29_000,
    medalSilverMs: 33_000,
    center(t) {
      const a = t * TAU;
      const r = 150 + Math.sin(a * 2) * 30 + Math.cos(a * 3) * 12;
      return { x: Math.cos(a) * r, z: Math.sin(a) * r * 0.85 };
    },
  },
  {
    slug: 'neon-circuit',
    name: 'Neon Circuit',
    icon: 'city',
    laps: 3,
    halfWidth: 9,
    order: 1,
    sky: 0x140f2e,
    fog: [0x140f2e, 260, 780],
    ground: 0x1d1b33,
    road: 0x35323f,
    edge: 0x53f2e0,
    theme: 'neon',
    pads: [0.09, 0.31, 0.52, 0.74, 0.9],
    medalGoldMs: 28_000,
    medalSilverMs: 32_000,
    center(t) {
      const a = t * TAU;
      const r = 132 + Math.sin(a * 3 + 0.9) * 24 + Math.sin(a * 5 + 2.4) * 8;
      return { x: Math.cos(a) * r, z: Math.sin(a) * r };
    },
  },
  {
    slug: 'canyon-rush',
    name: 'Canyon Rush',
    icon: 'dunes',
    laps: 3,
    halfWidth: 10,
    order: 2,
    sky: 0xe9c48f,
    fog: [0xe9c48f, 340, 950],
    ground: 0xd9a75f,
    road: 0x5b5560,
    edge: 0xfff3d9,
    theme: 'canyon',
    pads: [0.22, 0.38, 0.63, 0.88],
    medalGoldMs: 30_000,
    medalSilverMs: 34_000,
    center(t) {
      const a = t * TAU;
      const r = 138 + Math.sin(a * 2 + 1.2) * 46 + Math.cos(a * 4) * 15;
      return { x: Math.cos(a) * r, z: Math.sin(a) * r * 0.92 };
    },
  },
];

export const trackBySlug = (slug) => TRACKS.find((tr) => tr.slug === slug) || TRACKS[0];

export function trackCenterAt(track, t) {
  return track.center(((t % 1) + 1) % 1);
}

/** Unit tangent of a track's centreline at t (central difference). */
export function trackTangent(track, t) {
  const e = 1 / 2048;
  const p0 = trackCenterAt(track, t - e);
  const p1 = trackCenterAt(track, t + e);
  const dx = p1.x - p0.x;
  const dz = p1.z - p0.z;
  const len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, z: dz / len };
}

/** Unit normal (points to the centreline's right, as the player drives). */
export function trackNormal(track, t) {
  const tan = trackTangent(track, t);
  return { x: tan.z, z: -tan.x };
}

/**
 * The heading a kart must hold to travel ALONG the centreline at t, in the
 * motion convention: velocity = (−sin h, −cos h). The renderer's mesh yaw
 * and the start-line/rescue spawns all consume this directly.
 */
export function trackHeading(track, t) {
  const tan = trackTangent(track, t);
  return Math.atan2(-tan.x, -tan.z);
}

/** Which side of the centreline a world point is on (+ = normal side). */
export function sideOf(track, t, pos) {
  const c = trackCenterAt(track, t);
  const n = trackNormal(track, t);
  return Math.sign((pos.x - c.x) * n.x + (pos.z - c.z) * n.z) || 1;
}

const SAMPLE_PTS = new Map();       // track.slug → [{x, z}]
function samplePts(track) {
  if (!SAMPLE_PTS.has(track.slug)) {
    SAMPLE_PTS.set(track.slug,
      Array.from({ length: SAMPLES }, (_, i) => trackCenterAt(track, i / SAMPLES)));
  }
  return SAMPLE_PTS.get(track.slug);
}

/** Nearest centreline parameter and distance for a world position. */
export function nearestOnTrack(track, x, z) {
  const pts = samplePts(track);
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < SAMPLES; i += 1) {
    const p = pts[i];
    const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
    if (d < bestD) { bestD = d; best = i; }
  }
  return { t: best / SAMPLES, dist: Math.sqrt(bestD) };
}

// ── Arc-length table: even-speed movement along the line for AI karts ──────

const ARC = new Map();              // track.slug → { cum: [m], total: m }
function arcTable(track) {
  if (!ARC.has(track.slug)) {
    const pts = samplePts(track);
    const cum = [0];
    for (let i = 1; i <= SAMPLES; i += 1) {
      const a = pts[i - 1];
      const b = pts[i % SAMPLES];
      cum.push(cum[i - 1] + Math.hypot(b.x - a.x, b.z - a.z));
    }
    ARC.set(track.slug, { cum, total: cum[SAMPLES] });
  }
  return ARC.get(track.slug);
}

export function trackLengthM(track) {
  return arcTable(track).total;
}

/** Progress in metres from the start line (may be negative) → parameter t. */
export function tAtS(track, s) {
  const { cum, total } = arcTable(track);
  const w = ((s % total) + total) % total;
  let lo = 0;
  let hi = SAMPLES;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= w) lo = mid; else hi = mid;
  }
  const seg = cum[lo + 1] - cum[lo] || 1;
  return (lo + (w - cum[lo]) / seg) / SAMPLES;
}

/** Centreline parameter t → arc position s in (0, total]. */
export function sAtT(track, t) {
  const { cum } = arcTable(track);
  const w = (((t % 1) + 1) % 1) * SAMPLES;
  const i = Math.floor(w) % SAMPLES;
  const f = w - Math.floor(w);
  return cum[i] + (cum[i + 1] - cum[i]) * f;
}

/**
 * Signed curvature, 1/m: d(heading)/ds. A larger heading is a right turn
 * (see stepPlayer), so positive = the road bends right.
 */
export function trackCurvature(track, t) {
  const e = 1 / 1024;
  const a0 = trackHeading(track, t - e);
  const a1 = trackHeading(track, t + e);
  let ds = sAtT(track, t + e) - sAtT(track, t - e);
  if (ds < 0) ds += trackLengthM(track);   // the seam at t = 0 wraps
  return wrapAngle(a1 - a0) / Math.max(ds, 1e-6);
}

/** A comfortable speed through the road's curvature at t, m/s. */
export function curveSpeed(track, t, halfWidth) {
  // Lateral acceleration a = v²·κ; keep it under what grip allows, with a
  // little slack for the road's width (you can run wide through a bend).
  const k = Math.abs(trackCurvature(track, t));
  const aMax = 26;                  // m/s² of cornering the karts can hold
  const widen = 1 + halfWidth * 0.035;
  return Math.sqrt((aMax * widen) / Math.max(k, 1e-4));
}

export function fmtMs(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—:—.——';
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const h = Math.floor((ms % 1000) / 10);
  return `${m}:${String(s).padStart(2, '0')}.${String(h).padStart(2, '0')}`;
}

const ORDINALS = ['th', 'st', 'nd', 'rd'];
export const ordinal = (n) => {
  const v = n % 100;
  return `${n}${ORDINALS[(v - 20) % 10] || ORDINALS[v] || ORDINALS[0]}`;
};

// ── Championship persistence ───────────────────────────────────────────────

const SAVE_KEY = 'senwii.racing.v1';

export function loadSave() {
  try {
    const raw = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}');
    return {
      unlocked: clamp(raw.unlocked || 1, 1, TRACKS.length),
      bestLaps: raw.bestLaps || {},
      ghosts: raw.ghosts || {},
    };
  } catch {
    return { unlocked: 1, bestLaps: {}, ghosts: {} };
  }
}

export function persistSave(save) {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch { /* ignore */ }
}

export function medalFor(track, lapMs) {
  if (!lapMs) return null;
  if (lapMs <= track.medalGoldMs) return 'gold';
  if (lapMs <= track.medalSilverMs) return 'silver';
  return 'bronze';
}

// ── The race ───────────────────────────────────────────────────────────────

const RIVAL_COLORS = [0x2f7fd6, 0xffc23e, 0x39b46a, 0xb06ce8, 0xff7a4d];
const RIVAL_NAMES = ['Breeze', 'Juno', 'Kestrel', 'Nova', 'Tango'];

export class Race {
  /**
   * @param trackIndex which circuit
   * @param seed       deterministic AI jitter
   * @param ghost      best-lap keyframes to race against (optional)
   */
  constructor({ trackIndex = 0, onEvent = () => {}, seed = 7, ghost = null } = {}) {
    this.onEvent = onEvent;
    this.track = TRACKS[clamp(trackIndex, 0, TRACKS.length - 1)];
    this.laps = this.track.laps;
    this.rng = mulberry32(seed);
    this.ghost = ghost;
    this.state = 'ready';            // ready | countdown | racing | finished
    this.countdownEnds = 0;
    this.startedAt = 0;

    // Player kart: free physics.
    this.pos = { x: 0, z: 0 };
    this.heading = 0;
    this.motionHeading = 0;          // the velocity's direction; drift = lag
    this.speed = 0;
    this.steer = 0;
    this.driftHeld = false;
    this.brakeHeld = false;
    this.drifting = false;
    this.driftCharge = 0;            // seconds of drift banked
    this.driftTier = 0;              // 0..3 sparks
    this.boostUntil = 0;
    this.padBoostUntil = 0;
    this.padCooldown = 0;
    this.scraping = false;
    this.onTrack = true;
    this.offRoadSince = null;
    this.trackT = 0;
    this.progressM = 0;
    this.lap = 1;
    this.nextCp = 1;
    this.lapStartMs = 0;
    this.lapMs = 0;
    this.lastLapMs = null;
    this.bestLapMs = null;
    this.lapTimes = [];
    this.finishedMs = null;
    this.rank = RACER_COUNT;
    this.recording = [];
    this.bestRecording = null;       // ghost keys of the best completed lap
    this.preStart = true;            // still on the grid side of the line (lap 1)
    this.lastKeyMs = -Infinity;

    // CPU grid: player starts 6th, rivals ahead — the comeback is the game.
    // Front rows are the quicker drivers.
    this.karts = [];
    for (let i = 0; i < RACER_COUNT - 1; i += 1) {
      const slot = i;                          // 0..4, player is slot 5
      const row = Math.floor(slot / 2);
      const side = slot % 2 ? -1 : 1;
      const off = side * (0.34 + (slot % 3) * 0.05) * this.track.halfWidth;
      const gridT = -(GRID_ROW_M * (row + 1.2)) / trackLengthM(this.track);
      const p = trackCenterAt(this.track, gridT);
      const n = trackNormal(this.track, gridT);
      this.karts.push({
        id: i,
        name: RIVAL_NAMES[i % RIVAL_NAMES.length],
        color: RIVAL_COLORS[i % RIVAL_COLORS.length],
        progressM: -GRID_ROW_M * (row + 1.2),
        t: gridT,
        offset: off,
        targetOffset: 0,
        speed: 0,
        skill: 0.905 - slot * 0.02 + this.rng() * 0.014,
        finishedMs: null,
        wobPhase: this.rng() * TAU,
        wobHz: 0.12 + this.rng() * 0.1,
        boostUntil: 0,
        padCooldown: 0,
        pos: { x: p.x + n.x * off, z: p.z + n.z * off },
      });
    }
  }

  start(now) {
    this.state = 'countdown';
    this.countdownEnds = now + COUNTDOWN_MS;
    this.startedAt = now + COUNTDOWN_MS;
    // Player at the back of the grid, free slot of the last row (kart 4 took
    // the +normal side, so the player takes the −normal side of that row).
    const row = Math.floor((RACER_COUNT - 1) / 2);
    const behind = GRID_ROW_M * (row + 1.2);
    const gridT = -behind / trackLengthM(this.track);
    const p = trackCenterAt(this.track, gridT);
    const n = trackNormal(this.track, gridT);
    this.pos = { x: p.x - n.x * 0.4 * this.track.halfWidth, z: p.z - n.z * 0.4 * this.track.halfWidth };
    this.heading = trackHeading(this.track, gridT);
    this.motionHeading = this.heading;
    this.speed = 0;
    this.progressM = -behind;
    this.lap = 1;
    this.nextCp = 1;
    this.lapStartMs = this.startedAt;
    this.lapMs = 0;
    this.lastLapMs = null;
    this.bestLapMs = null;
    this.lapTimes = [];
    this.finishedMs = null;
    this.recording = [];
    this.bestRecording = null;
    this.preStart = true;
    this.lastKeyMs = -Infinity;
    this.driftCharge = 0;
    this.drifting = false;
    this.boostUntil = 0;
    this.padBoostUntil = 0;
    this.offRoadSince = null;
    this.onEvent({ type: 'countdown' });
  }

  setSteer(bankDeg) {
    this.steer = clamp(bankDeg, -STEER_INPUT_MAX, STEER_INPUT_MAX);
  }

  setDrift(on, now = 0) {
    if (on && !this.drifting && this.state === 'racing') {
      // The hop: a drift only starts while turning at speed.
      if (Math.abs(this.steer) >= DRIFT_MIN_STEER && this.speed >= DRIFT_MIN_SPEED) {
        this.drifting = true;
        this.driftCharge = 0;
        this.onEvent({ type: 'hop' });
      }
    } else if (!on && this.drifting) {
      this.releaseDrift(now);
    }
    this.driftHeld = on;
  }

  releaseDrift(now = 0) {
    if (this.drifting && this.driftTier > 0) {
      const until = now + BOOST_T[this.driftTier - 1] * 1000;
      this.boostUntil = Math.max(this.boostUntil, until);
      this.onEvent({ type: 'boost', tier: this.driftTier });
    }
    this.drifting = false;
    this.driftCharge = 0;
    this.driftTier = 0;
  }

  setBrake(on) {
    this.brakeHeld = on;
  }

  // ── Per-frame update ──
  update(now, dt) {
    dt = Math.min(dt, 1 / 20);      // a background tab must not teleport karts
    if (this.state === 'countdown') {
      this.lapMs = 0;
      if (now >= this.countdownEnds) {
        this.state = 'racing';
        this.lapStartMs = now;
        this.onEvent({ type: 'go' });
      }
      return;
    }
    if (this.state !== 'racing' && this.state !== 'finished') return;
    const racing = this.state === 'racing';
    this.lapMs = racing ? now - this.lapStartMs : this.lapMs;

    this.stepPlayer(now, dt, racing);
    for (const k of this.karts) this.stepKart(k, now, dt, racing);
    this.separateKarts();

    if (racing) {
      this.checkProgress(now);
      // After the lap counter has had its say, so crossing the line is one
      // continuous step (never a frame a lap short or a lap ahead).
      this.updateProgress();
      this.recordGhost();
      this.updateRank();
      if (this.finishedMs !== null) this.finish();
    }
  }

  /** Snap the kart back onto the road after too long off it. */
  rescue(now) {
    const c = trackCenterAt(this.track, this.trackT);
    this.pos.x = c.x;
    this.pos.z = c.z;
    this.heading = trackHeading(this.track, this.trackT);
    this.motionHeading = this.heading;
    this.speed = 10;
    if (this.drifting) this.releaseDrift(now);
    this.boostUntil = 0;
    this.offRoadSince = null;
    this.onEvent({ type: 'rescue' });
  }

  stepPlayer(now, dt, racing) {
    const near = nearestOnTrack(this.track, this.pos.x, this.pos.z);
    this.trackT = near.t;
    this.onTrack = near.dist <= this.track.halfWidth;

    // Stuck off the road? Standard kart-racer rescue after a grace period.
    if (racing && !this.onTrack) {
      if (this.offRoadSince === null) this.offRoadSince = now;
      else if (now - this.offRoadSince > OFFROAD_RESCUE_MS) {
        this.rescue(now);
        return;
      }
    } else if (this.onTrack) {
      this.offRoadSince = null;
    }

    // Surface: grass caps speed and loosens grip; boosts push past the cap.
    let target = 0;
    if (racing) {
      target = this.onTrack ? TOP_SPEED : GRASS_SPEED;
      if (now < Math.max(this.boostUntil, this.padBoostUntil)) target = Math.max(target, BOOST_SPEED);
    }

    if (this.brakeHeld && racing) {
      this.speed = Math.max(0, this.speed - BRAKE * dt);
    } else if (this.speed < target) {
      this.speed = Math.min(target, this.speed + ACCEL * dt);
    } else if (this.speed > target) {
      // Drag decays the excess (boost bleed-off, grass) gently, not abruptly.
      this.speed = Math.max(target, this.speed - Math.max(ACCEL * 0.5, DRAG * (this.speed - target)) * dt);
    }
    if (!racing) this.speed = Math.max(0, this.speed - 8 * dt);

    // Keep a drift alive only while it deserves to exist.
    if (this.drifting
        && (!this.driftHeld || Math.abs(this.steer) < DRIFT_MIN_STEER * 0.6 || this.speed < DRIFT_MIN_SPEED * 0.7)) {
      this.releaseDrift(now);
    }

    // Steering: authority grows with speed; drifting carves harder.
    const authority = Math.min(1, this.speed / 10);
    const turn = TURN_RATE * (this.drifting ? DRIFT_TURN_MULT : 1);
    this.heading = wrapAngle(this.heading + this.steer * turn * authority * dt * DEG);

    // Velocity direction relaxes toward the heading — the drift is the lag.
    const grip = (this.drifting ? DRIFT_GRIP : 1) * (this.onTrack ? GRIP : GRASS_GRIP);
    this.motionHeading = wrapAngle(
      this.motionHeading + wrapAngle(this.heading - this.motionHeading) * Math.min(1, dt * grip),
    );

    // Logic z runs forward along the track; world −z is forward on screen,
    // so the renderer's wz() convention is honoured here: heading 0 → −z.
    this.pos.x -= Math.sin(this.motionHeading) * this.speed * dt;
    this.pos.z -= Math.cos(this.motionHeading) * this.speed * dt;

    // Drift charge while banking.
    if (this.drifting) {
      this.driftCharge += dt;
      const tier = this.driftCharge >= DRIFT_CHARGE_T3 ? 3
        : this.driftCharge >= DRIFT_CHARGE_T2 ? 2
        : this.driftCharge >= DRIFT_CHARGE_T1 ? 1 : 0;
      if (tier !== this.driftTier) {
        this.driftTier = tier;
        this.onEvent({ type: 'spark', tier });
      }
    }

    this.updateProgress();

    // Boost pads on the road.
    if (now > this.padCooldown) {
      for (const padT of this.track.pads) {
        if (Math.abs(tDiff(this.trackT, padT)) < 0.007 && this.onTrack) {
          this.padCooldown = now + 1500;
          this.padBoostUntil = now + BOOST_PAD_MS;
          this.onEvent({ type: 'pad' });
          break;
        }
      }
    }

    // Soft walls: past the verge, scrub speed and slide back onto the road.
    // Only the lateral overshoot is removed, so a scraping kart keeps
    // sliding along the wall instead of grinding against one spot.
    this.scraping = false;
    const lim = this.track.halfWidth + WALL_MARGIN;
    if (near.dist > lim) {
      const c = trackCenterAt(this.track, near.t);
      const n = trackNormal(this.track, near.t);
      const lat = (this.pos.x - c.x) * n.x + (this.pos.z - c.z) * n.z;
      const latC = clamp(lat, -lim, lim);
      this.pos.x += n.x * (latC - lat);
      this.pos.z += n.z * (latC - lat);
      this.speed *= Math.max(0, 1 - WALL_SCRUB * dt);
      this.scraping = true;
    }
  }

  /**
   * Progress in metres from the line. Before the first crossing the grid
   * sits just behind it (t ≈ 1), so that stretch counts as negative; once
   * past the line, t ∈ (0.5, 1) is simply the back half of the lap.
   */
  updateProgress() {
    const L = trackLengthM(this.track);
    let s = sAtT(this.track, this.trackT);
    if (this.preStart) {
      if (tDiff(this.trackT, 0) < 0) s -= L;
      else this.preStart = false;
    }
    // Laps actually closed, not this.lap: the last lap never bumps the counter.
    this.progressM = this.lapTimes.length * L + s;
  }

  stepKart(k, now, dt, racing) {
    if (k.finishedMs !== null) {
      // Rolling to a stop past the line.
      k.speed = Math.max(0, k.speed - 8 * dt);
      k.progressM += k.speed * dt;
      k.t = tAtS(this.track, k.progressM);
      return;
    }
    // Racing line: hug the inside of the bend. Curvature is positive when
    // the road bends right, and the normal points right — so the inside of
    // a bend is the +normal side, which is where the apex offset goes.
    const curve = trackCurvature(this.track, k.t);
    const apex = clamp(curve * 2.2, -0.62, 0.62) * this.track.halfWidth;
    const wobble = Math.sin(now / 1000 * k.wobHz * TAU + k.wobPhase) * this.track.halfWidth * 0.14;
    k.targetOffset = apex * 0.7 + wobble;
    k.offset += clamp(k.targetOffset - k.offset, -3.2 * dt, 3.2 * dt);

    // Pace: a 1.3× corner allowance (they ride the true line, the player
    // doesn't have to) capped by per-driver skill. The player is faster in
    // a straight line; the comeback is earned in the corners and the pads.
    let v = Math.min(
      curveSpeed(this.track, k.t, this.track.halfWidth) * 1.3,
      TOP_SPEED * k.skill * 1.02,
    );
    if (racing) {
      const gapM = this.progressM - k.progressM;    // + = kart behind the player
      v *= clamp(1 + gapM * 0.0009, 0.9, 1.09);
      if (now < k.boostUntil) v = Math.max(v, BOOST_SPEED * 0.94);
    } else {
      v = 0;
    }
    k.speed += clamp(v - k.speed, -BRAKE * dt, ACCEL * 0.85 * dt);
    k.progressM += k.speed * dt;
    k.t = tAtS(this.track, k.progressM);

    // Boost pads count for the AI too, a touch weaker.
    if (now > k.padCooldown) {
      for (const padT of this.track.pads) {
        if (Math.abs(tDiff(k.t, padT)) < 0.007) {
          k.padCooldown = now + 1500;
          k.boostUntil = now + BOOST_PAD_MS * 0.8;
          break;
        }
      }
    }

    if (k.progressM >= trackLengthM(this.track) * this.laps) {
      k.finishedMs = now;
      this.onEvent({ type: 'rival-finish', name: k.name });
    }
  }

  kartWorldPos(k) {
    const c = trackCenterAt(this.track, k.t);
    const n = trackNormal(this.track, k.t);
    return { x: c.x + n.x * k.offset, z: c.z + n.z * k.offset };
  }

  /** Soft separation so karts nudge rather than pass through each other. */
  separateKarts() {
    for (const k of this.karts) {
      const kp = this.kartWorldPos(k);
      const dx = kp.x - this.pos.x;
      const dz = kp.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      const minD = KART_RADIUS * 2;
      if (d > 0 && d < minD) {
        const push = (minD - d) / 2;
        const ux = dx / d;
        const uz = dz / d;
        this.pos.x -= ux * push;
        this.pos.z -= uz * push;
        const n = trackNormal(this.track, k.t);
        k.offset += (ux * n.x + uz * n.z) * push * 0.8;
        k.speed *= 0.995;
      }
    }
  }

  /** Checkpoints in order, then the line closes the lap. */
  checkProgress(now) {
    const near = nearestOnTrack(this.track, this.pos.x, this.pos.z);
    // Kart separation may have nudged us since stepPlayer; progress and the
    // lap counter must agree on which side of the line we are.
    this.trackT = near.t;
    const cpT = (this.nextCp % CHECKPOINT_COUNT) / CHECKPOINT_COUNT;
    const d = tDiff(near.t, cpT);
    // Mid-lap checkpoints are a window around the spot; the line itself only
    // counts once the kart is actually across it, not 40 m short.
    const inWindow = this.nextCp < CHECKPOINT_COUNT ? Math.abs(d) < 0.045 : d >= 0 && d < 0.045;
    if (inWindow && near.dist < this.track.halfWidth * 2.4) {
      if (this.nextCp < CHECKPOINT_COUNT) {
        this.nextCp += 1;
      } else {
        this.completeLap(now);
        this.nextCp = 1;
      }
    }
  }

  completeLap(now) {
    const ms = now - this.lapStartMs;
    this.lastLapMs = ms;
    this.lapTimes.push(ms);
    this.recording.push({ ms, x: this.pos.x, z: this.pos.z, h: this.heading });
    const isBest = this.bestLapMs === null || ms < this.bestLapMs;
    if (isBest) {
      this.bestLapMs = ms;
      this.bestRecording = this.recording.slice();
    }
    this.onEvent({ type: 'lap', lap: this.lap, ms, best: isBest });
    if (this.lap >= this.laps) {
      this.finishedMs = now;
      return;
    }
    this.lap += 1;
    this.lapStartMs = now;
    this.recording = [];
    this.lastKeyMs = -Infinity;
  }

  recordGhost() {
    if (this.lapMs - this.lastKeyMs >= 120) {
      this.recording.push({
        ms: Math.round(this.lapMs),
        x: Math.round(this.pos.x * 100) / 100,
        z: Math.round(this.pos.z * 100) / 100,
        h: Math.round(this.heading * 1000) / 1000,
      });
      this.lastKeyMs = this.lapMs;
    }
  }

  /** Standings: finished karts by time, the rest by track progress. */
  standings() {
    const entries = [
      { who: 'you', done: this.finishedMs, prog: this.progressM },
      ...this.karts.map((k) => ({ who: k.name, done: k.finishedMs, prog: k.progressM })),
    ];
    entries.sort((a, b) => {
      if (a.done !== null && b.done !== null) return a.done - b.done;
      if (a.done !== null) return -1;
      if (b.done !== null) return 1;
      return b.prog - a.prog;
    });
    return entries;
  }

  updateRank() {
    const s = this.standings();
    this.rank = s.findIndex((e) => e.who === 'you') + 1;
  }

  finish() {
    this.state = 'finished';
    const standings = this.standings();
    const place = standings.findIndex((e) => e.who === 'you') + 1;
    const pts = POINTS[clamp(place - 1, 0, POINTS.length - 1)];
    this.onEvent({
      type: 'finish',
      place,
      points: pts,
      standings,
      bestLapMs: this.bestLapMs,
      lapTimes: [...this.lapTimes],
    });
  }

  /** Ghost pose at a lap-relative time, interpolated between keyframes. */
  ghostAt(lapMs) {
    const g = this.ghost;
    if (!g || g.length === 0) return null;
    if (lapMs <= g[0].ms) return g[0];
    if (lapMs >= g[g.length - 1].ms) return g[g.length - 1];
    let lo = 0;
    while (lo + 1 < g.length && g[lo + 1].ms <= lapMs) lo += 1;
    const a = g[lo];
    const b = g[lo + 1];
    const f = (lapMs - a.ms) / Math.max(1, b.ms - a.ms);
    return {
      ms: lapMs,
      x: a.x + (b.x - a.x) * f,
      z: a.z + (b.z - a.z) * f,
      h: a.h + wrapAngle(b.h - a.h) * f,
    };
  }
}
