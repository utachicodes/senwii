/**
 * Alien Attack — endless rail-shooter logic. No renderer, no DOM.
 *
 * The ship flies forward on its own; the phone lies flat like a tray and
 * rolling it strafes left and right (the exact steering the cow had). A
 * fires a bolt straight ahead. Saucers approach in endless waves, sway,
 * shoot back, and ram — three hits and the run is over. Score is kills
 * plus distance flown.
 *
 * The tilt-steering primitives (captureTray/trayRead/SteerFilter and the
 * TraySteer stack that wraps them) live in core/tilt.js, shared with the
 * racer; they are re-exported here so the game's own tests keep covering
 * them against this game's exact contract.
 */

export {
  captureTray, trayRead, shapeSteer, SteerFilter, TraySteer,
  STEER_FULL, BIAS_HEAL_BAND, BIAS_HEAL_TAU_S,
  BIAS_SETTLE_S, BIAS_SETTLE_TAU_S,
  STILL_RATE_DPS, STILL_MS, GRIP_CHANGE_DEG, GRIP_CHANGE_MS,
  HUNT_GIVE_UP_MS, SMOOTH_TAU_S, SLEW_DPS, RAMP_S,
} from '../../core/tilt.js';

import { STEER_FULL } from '../../core/tilt.js';

export const LANE_HALF = 12;         // playable half-width
export const LATERAL_SPEED = 13;     // m/s of strafe at full lock
export const SHIP_SPEED = 22;        // m/s at launch…
export const SHIP_SPEED_MAX = 34;    // …ramping to this
export const SHIP_R = 1.1;
export const ALIEN_R = 1.3;
export const BOLT_REL_SPEED = 60;    // player bolt speed over ship speed
export const BOLT_RANGE = 130;       // metres a bolt lives
export const FIRE_COOLDOWN_MS = 140;
export const ALIEN_BOLT_SPEED = 26;  // toward the player, plus ship speed closing
export const ALIEN_FIRE_RANGE = 95;  // aliens open fire inside this distance
export const ALIEN_FIRE_MS = 1700;   // per-alien trigger discipline
export const SPAWN_MS_START = 1400;
export const SPAWN_MS_MIN = 550;
export const SPAWN_AHEAD = 140;      // metres ahead of the ship
export const LIVES = 3;
export const INVULN_MS = 1500;
export const KILL_POINTS = 100;

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

export const STEER_DEADZONE = 2.5;   // degrees of hand tremor ignored

export class Patrol {
  constructor({ onEvent = () => {}, seed = 17 } = {}) {
    this.onEvent = onEvent;
    this.rng = mulberry32(seed);
    this.state = 'ready';            // ready | running | done
    this.x = 0;
    this.z = 0;
    this.speed = 0;
    this.steer = 0;                  // degrees of bank, +right
    this.lives = LIVES;
    this.kills = 0;
    this.aliens = [];
    this.bolts = [];                 // player fire
    this.alienBolts = [];
    this.startMs = 0;
    this.timeMs = 0;
    this.lastFireMs = -Infinity;
    this.invulnUntil = 0;
    this.nextSpawnMs = 0;
    this.nextId = 1;
  }

  start(now) {
    const fresh = new Patrol({ onEvent: this.onEvent, seed: (this.rng() * 2 ** 31) | 0 });
    Object.assign(this, fresh);
    this.state = 'running';
    this.speed = SHIP_SPEED;
    this.startMs = now;
    this.nextSpawnMs = now + 700;
  }

  get score() {
    return this.kills * KILL_POINTS + Math.floor(this.z);
  }

  setSteer(bankDeg) {
    this.steer = bankDeg;
  }

  shoot(now) {
    if (this.state !== 'running') return false;
    if (now - this.lastFireMs < FIRE_COOLDOWN_MS) return false;
    this.lastFireMs = now;
    this.bolts.push({ x: this.x, z: this.z + 2, born: this.z });
    this.onEvent({ type: 'fire' });
    return true;
  }

  spawnAlien(now) {
    const a = {
      id: this.nextId++,
      x0: (this.rng() * 2 - 1) * (LANE_HALF - 1.5),
      x: 0,
      z: this.z + SPAWN_AHEAD,
      speed: 9 + this.rng() * 5 + Math.min(8, (now - this.startMs) / 12_000),
      swayAmp: this.rng() * 3.5,
      swayHz: 0.25 + this.rng() * 0.5,
      phase: this.rng() * Math.PI * 2,
      bornMs: now,
      nextFireMs: now + 600 + this.rng() * ALIEN_FIRE_MS,
    };
    a.x = a.x0;
    this.aliens.push(a);
    this.onEvent({ type: 'spawn', alien: a });
    return a;
  }

  loseLife(now, cause) {
    if (now < this.invulnUntil) return;
    this.lives -= 1;
    this.invulnUntil = now + INVULN_MS;
    this.onEvent({ type: 'hit', cause, lives: this.lives });
    if (this.lives <= 0) {
      this.state = 'done';
      this.onEvent({
        type: 'done',
        score: this.score,
        kills: this.kills,
        distanceM: Math.floor(this.z),
        timeMs: this.timeMs,
      });
    }
  }

  update(now, dt) {
    if (this.state !== 'running') return;
    const elapsedS = (now - this.startMs) / 1000;

    this.speed = Math.min(SHIP_SPEED_MAX, SHIP_SPEED + elapsedS * 0.12);
    const lock = Math.max(-1, Math.min(1, this.steer / STEER_FULL));
    this.x = Math.max(-LANE_HALF, Math.min(LANE_HALF, this.x + lock * LATERAL_SPEED * dt));
    this.z += this.speed * dt;

    // Waves keep coming, faster and faster.
    if (now >= this.nextSpawnMs) {
      this.spawnAlien(now);
      this.nextSpawnMs = now + Math.max(SPAWN_MS_MIN, SPAWN_MS_START - elapsedS * 10);
    }

    // Player bolts fly ahead; expire out of range.
    this.bolts = this.bolts.filter((b) => {
      b.z += (this.speed + BOLT_REL_SPEED) * dt;
      return b.z - b.born < BOLT_RANGE;
    });

    for (const a of this.aliens) {
      a.z -= a.speed * dt;
      const age = (now - a.bornMs) / 1000;
      a.x = Math.max(-LANE_HALF, Math.min(LANE_HALF,
        a.x0 + Math.sin(a.phase + age * a.swayHz * Math.PI * 2) * a.swayAmp));

      // Bolt × alien.
      for (const b of this.bolts) {
        if (b.dead) continue;
        if (Math.hypot(b.x - a.x, b.z - a.z) < ALIEN_R + 0.4) {
          b.dead = true;
          a.dead = true;
          this.kills += 1;
          this.onEvent({ type: 'kill', alien: a, kills: this.kills, score: this.score });
        }
      }

      // Alien fire: inside range, on its own trigger discipline.
      if (!a.dead && a.z - this.z < ALIEN_FIRE_RANGE && now >= a.nextFireMs) {
        a.nextFireMs = now + ALIEN_FIRE_MS + this.rng() * 600;
        this.alienBolts.push({ x: a.x, z: a.z - ALIEN_R });
        this.onEvent({ type: 'alienFire', x: a.x, z: a.z });
      }

      // Ram: the saucer reaches the ship's plane on top of it.
      if (!a.dead && a.z <= this.z && Math.abs(a.x - this.x) < SHIP_R + ALIEN_R) {
        a.dead = true;
        this.loseLife(now, 'ram');
        if (this.state !== 'running') return;
      }
    }
    this.aliens = this.aliens.filter((a) => !a.dead && a.z > this.z - 12);
    this.bolts = this.bolts.filter((b) => !b.dead);

    // Alien bolts close on the ship. Both parties move every tick, so the
    // crossing must be read in RELATIVE coordinates — the ship overtaking a
    // bolt is the same event as the bolt reaching the ship.
    this.alienBolts = this.alienBolts.filter((b) => {
      b.z -= ALIEN_BOLT_SPEED * dt;
      const rel = b.z - this.z;
      const crossed = (b.rel === undefined ? rel > 0 : b.rel > 0) && rel <= 0;
      b.rel = rel;
      if (crossed && Math.abs(b.x - this.x) < SHIP_R) {
        this.loseLife(now, 'bolt');
        return false;
      }
      return rel > -12;
    });

    this.timeMs = now - this.startMs;
  }
}

export function fmtMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—:—';
  const s = ms / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}
