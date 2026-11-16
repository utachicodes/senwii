/**
 * Alien Attack — rail-shooter logic. No renderer, no DOM.
 *
 * The ship flies forward on its own; the phone lies flat like a tray and
 * rolling it strafes left and right (the exact steering the cow had). A
 * fires a bolt straight ahead. The run is ten sectors: each one asks for a
 * number of kills (or a boss) and turns every knob a notch — cruise speed,
 * spawn rate, sway, trigger discipline, bolt speed and the saucer mix. Lives
 * carry from sector to sector; three hits and the run is over. Score is
 * kills plus distance flown plus sector bonuses.
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
} from '../../core/tilt.js';

import { STEER_FULL } from '../../core/tilt.js';

export const LANE_HALF = 12;         // playable half-width
export const LATERAL_SPEED = 13;     // m/s of strafe at full lock
export const SHIP_SPEED = 22;        // m/s in sector 1…
export const SHIP_SPEED_MAX = 34;    // …up to this in the last
export const SHIP_R = 1.1;
export const ALIEN_R = 1.3;
export const TANK_R = 1.7;           // the armoured saucer is a bigger target
export const BOSS_R = 4.4;          // matches the drawn hull (4.2 × 1.1)
export const BOLT_REL_SPEED = 60;    // player bolt speed over ship speed
export const BOLT_RANGE = 130;       // metres a bolt lives
export const FIRE_COOLDOWN_MS = 140;
export const ALIEN_BOLT_SPEED = 26;  // default enemy bolt speed (sector 1 is slower)
export const ALIEN_FIRE_RANGE = 95;  // aliens open fire inside this distance
export const ALIEN_FIRE_MS = 1700;   // baseline trigger discipline
export const SPAWN_MS_START = 1400;  // sector 1's spawn gap…
export const SPAWN_MS_MIN = 550;     // …and the floor no sector goes under
export const SPAWN_AHEAD = 140;      // metres ahead of the ship
export const LIVES = 3;
export const INVULN_MS = 1500;
export const KILL_POINTS = 100;
export const TANK_BONUS = 100;       // armour is worth a second kill
export const BOSS_POINTS = 1500;
export const CLEAR_POINTS = 250;     // × sector number
export const FLAWLESS_POINTS = 500;  // a sector cleared without a scratch
export const INTERMISSION_MS = 2500;
export const BOSS_DELAY_MS = 1500;   // the boss warps in this long after the sector opens
export const BOSS_HOLD = 48;         // metres the boss keeps ahead of the ship
export const BOSS_GLIDE = 32;        // m/s it closes to that station
export const ZIG_AMP = 6;            // zig-zagger lateral swing
export const DIVER_LOCK_RANGE = 62;  // a diver winds up inside this gap…
export const DIVER_WINDUP_MS = 520;  // …glows for this long…
export const DIVER_DIVE_SPEED = 40;  // …then charges the spot you were in
export const DIVER_TRACK = 9;        // m/s it can slide toward that spot

/**
 * Saucer types. `hp` hits to kill, `r` hit radius, `fires` whether it
 * shoots back. The renderer keys colour and silhouette off `type`.
 */
export const SAUCER_TYPES = {
  scout: { hp: 1, r: ALIEN_R, fires: true, label: 'Scout' },
  zigzag: { hp: 1, r: ALIEN_R, fires: true, label: 'Zig-zagger' },
  tank: { hp: 2, r: TANK_R, fires: true, label: 'Ironclad' },
  diver: { hp: 1, r: ALIEN_R, fires: false, label: 'Diver' },
};

/**
 * The ten sectors. Difficulty only ever goes one way: cruise speed, alien
 * speed, sway and bolt speed rise; spawn gap and trigger discipline shrink;
 * kill targets grow. `intro` names the saucer type a sector debuts.
 */
export const LEVELS = [
  {
    name: 'Outer Rim', goal: 8, speed: 22, spawnMs: 1400, alienSpeed: [9, 14],
    swayAmp: 3.5, swayHz: [0.25, 0.75], fireMs: 1900, boltSpeed: 24,
    mix: { scout: 1 },
  },
  {
    name: 'Comet Lane', goal: 10, speed: 23.5, spawnMs: 1250, alienSpeed: [10, 15],
    swayAmp: 3.7, swayHz: [0.27, 0.78], fireMs: 1800, boltSpeed: 25,
    mix: { scout: 0.7, zigzag: 0.3 }, intro: 'zigzag',
  },
  {
    name: 'Ironclad Drift', goal: 12, speed: 25, spawnMs: 1150, alienSpeed: [10.5, 16],
    swayAmp: 3.9, swayHz: [0.29, 0.81], fireMs: 1700, boltSpeed: 26,
    mix: { scout: 0.55, zigzag: 0.28, tank: 0.17 }, intro: 'tank',
  },
  {
    name: 'Candy Nebula', goal: 14, speed: 26.5, spawnMs: 1050, alienSpeed: [11, 17],
    swayAmp: 4.1, swayHz: [0.31, 0.84], fireMs: 1600, boltSpeed: 27,
    mix: { scout: 0.45, zigzag: 0.3, tank: 0.25 },
  },
  {
    name: 'Mothership', goal: 1, speed: 27, spawnMs: 2600, alienSpeed: [11, 17],
    swayAmp: 4.1, swayHz: [0.31, 0.84], fireMs: 1600, boltSpeed: 27,
    mix: { scout: 0.7, zigzag: 0.3 },
    boss: {
      name: 'Brood Mother', hp: 14, fireMs: 1500, spread: 3, spreadV: 6,
      aimed: false, swayAmp: 7, swayHz: 0.16,
    },
  },
  {
    name: 'Plunge Field', goal: 15, speed: 28.5, spawnMs: 950, alienSpeed: [12, 18],
    swayAmp: 4.3, swayHz: [0.33, 0.87], fireMs: 1500, boltSpeed: 28.5,
    mix: { scout: 0.35, zigzag: 0.25, tank: 0.2, diver: 0.2 }, intro: 'diver',
  },
  {
    name: 'Ring Gate', goal: 16, speed: 30, spawnMs: 850, alienSpeed: [12.5, 19],
    swayAmp: 4.5, swayHz: [0.35, 0.9], fireMs: 1400, boltSpeed: 30,
    mix: { scout: 0.3, zigzag: 0.25, tank: 0.2, diver: 0.25 },
  },
  {
    name: 'Static Storm', goal: 18, speed: 31.5, spawnMs: 750, alienSpeed: [13, 20],
    swayAmp: 4.7, swayHz: [0.37, 0.93], fireMs: 1300, boltSpeed: 31,
    mix: { scout: 0.25, zigzag: 0.25, tank: 0.25, diver: 0.25 },
  },
  {
    name: 'Last Picket', goal: 20, speed: 33, spawnMs: 650, alienSpeed: [14, 21],
    swayAmp: 4.9, swayHz: [0.39, 0.96], fireMs: 1200, boltSpeed: 32,
    mix: { scout: 0.2, zigzag: 0.25, tank: 0.25, diver: 0.3 },
  },
  {
    name: 'Overlord', goal: 1, speed: 34, spawnMs: 1800, alienSpeed: [14, 21],
    swayAmp: 4.9, swayHz: [0.39, 0.96], fireMs: 1200, boltSpeed: 32,
    mix: { zigzag: 0.5, diver: 0.5 },
    boss: {
      name: 'The Overlord', hp: 24, fireMs: 1150, spread: 5, spreadV: 8,
      aimed: true, swayAmp: 8.5, swayHz: 0.22,
    },
  },
];

export const levelDef = (n) => LEVELS[Math.max(1, Math.min(LEVELS.length, n | 0)) - 1];

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

/** Triangle wave in [-1, 1] over one unit of `u` — the zig-zagger's path. */
export const tri = (u) => 1 - 4 * Math.abs((((u + 0.25) % 1) + 1) % 1 - 0.5);

function pickType(mix, r) {
  const entries = Object.entries(mix);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let x = r * total;
  for (const [type, w] of entries) {
    if (x < w) return type;
    x -= w;
  }
  return entries[entries.length - 1][0];
}

export class Patrol {
  constructor({ onEvent = () => {}, seed = 17 } = {}) {
    this.onEvent = onEvent;
    this.rng = mulberry32(seed);
    this.state = 'ready';            // ready | running | cleared | done
    this.x = 0;
    this.z = 0;
    this.speed = 0;
    this.steer = 0;                  // degrees of bank, +right
    this.lives = LIVES;
    this.kills = 0;
    this.bonus = 0;
    this.aliens = [];
    this.bolts = [];                 // player fire
    this.alienBolts = [];
    this.startMs = 0;
    this.timeMs = 0;
    this.lastFireMs = -Infinity;
    this.invulnUntil = 0;
    this.nextSpawnMs = 0;
    this.nextId = 1;
    // Sector progress.
    this.level = 1;
    this.startLevel = 1;
    this.def = LEVELS[0];
    this.levelKills = 0;
    this.levelStartMs = 0;
    this.levelHitsTaken = 0;
    this.levelShots = 0;
    this.levelHits = 0;
    this.nextLevelAt = Infinity;
    this.boss = null;
    this.bossAt = Infinity;
    this.bossDefeated = false;
    this.won = false;
  }

  start(now, level = 1) {
    const fresh = new Patrol({ onEvent: this.onEvent, seed: (this.rng() * 2 ** 31) | 0 });
    Object.assign(this, fresh);
    const n = Math.max(1, Math.min(LEVELS.length, level | 0));
    this.startLevel = n;
    this.speed = levelDef(n).speed;
    this.startMs = now;
    this.beginLevel(n, now);
    this.nextSpawnMs = now + 700;
  }

  /** Open sector `n`: fresh goal and knobs, same ship, same lives. */
  beginLevel(n, now) {
    this.level = Math.max(1, Math.min(LEVELS.length, n | 0));
    this.def = levelDef(this.level);
    this.state = 'running';
    this.levelKills = 0;
    this.levelStartMs = now;
    this.levelHitsTaken = 0;
    this.levelShots = 0;
    this.levelHits = 0;
    this.nextLevelAt = Infinity;
    this.boss = null;
    this.bossDefeated = false;
    this.bossAt = this.def.boss ? now + BOSS_DELAY_MS : Infinity;
    this.nextSpawnMs = now + (this.def.boss ? 2600 : 900);
    this.onEvent({ type: 'level', level: this.level, def: this.def });
  }

  get score() {
    return this.kills * KILL_POINTS + Math.floor(this.z) + this.bonus;
  }

  /** 0…1 toward this sector's goal (boss sectors read the boss's damage). */
  get progress() {
    if (this.def.boss) {
      if (this.bossDefeated) return 1;
      return this.boss ? 1 - this.boss.hp / this.boss.maxHp : 0;
    }
    return Math.min(1, this.levelKills / this.def.goal);
  }

  setSteer(bankDeg) {
    this.steer = bankDeg;
  }

  shoot(now) {
    if (this.state !== 'running' && this.state !== 'cleared') return false;
    if (now - this.lastFireMs < FIRE_COOLDOWN_MS) return false;
    this.lastFireMs = now;
    this.bolts.push({ x: this.x, z: this.z + 2, born: this.z });
    if (this.state === 'running') this.levelShots += 1;
    this.onEvent({ type: 'fire' });
    return true;
  }

  spawnAlien(now, type = null) {
    const d = this.def;
    const kind = type || pickType(d.mix, this.rng());
    const spec = SAUCER_TYPES[kind];
    const [s0, s1] = d.alienSpeed;
    const a = {
      id: this.nextId++,
      type: kind,
      hp: spec.hp,
      maxHp: spec.hp,
      r: spec.r,
      x0: (this.rng() * 2 - 1) * (LANE_HALF - 1.5),
      x: 0,
      z: this.z + SPAWN_AHEAD,
      speed: s0 + this.rng() * (s1 - s0),
      swayAmp: this.rng() * d.swayAmp,
      swayHz: d.swayHz[0] + this.rng() * (d.swayHz[1] - d.swayHz[0]),
      phase: this.rng() * Math.PI * 2,
      bornMs: now,
      nextFireMs: now + 600 + this.rng() * d.fireMs,
      flashUntil: 0,
    };
    if (kind === 'zigzag') {
      a.x0 = (this.rng() * 2 - 1) * (LANE_HALF - ZIG_AMP - 1);
      a.swayAmp = ZIG_AMP;
      a.swayHz *= 0.9;
    } else if (kind === 'tank') {
      a.speed *= 0.75;
      a.swayAmp *= 0.5;
    } else if (kind === 'diver') {
      a.mode = 'cruise';             // cruise → windup → dive
      a.targetX = 0;
    }
    a.x = a.x0;
    this.aliens.push(a);
    this.onEvent({ type: 'spawn', alien: a });
    return a;
  }

  spawnBoss(now) {
    const b = this.def.boss;
    this.boss = {
      name: b.name,
      hp: b.hp,
      maxHp: b.hp,
      r: BOSS_R,
      x: 0,
      gap: SPAWN_AHEAD + 20,
      z: this.z + SPAWN_AHEAD + 20,
      bornMs: now,
      nextFireMs: now + 2600,
      volley: 0,
      flashUntil: 0,
      final: this.level === LEVELS.length,
    };
    this.onEvent({ type: 'bossSpawn', boss: this.boss });
    return this.boss;
  }

  loseLife(now, cause) {
    if (now < this.invulnUntil) return;
    this.lives -= 1;
    this.levelHitsTaken += 1;
    this.invulnUntil = now + INVULN_MS;
    this.onEvent({ type: 'hit', cause, lives: this.lives });
    if (this.lives <= 0) this.finish(false);
  }

  finish(won) {
    this.state = 'done';
    this.won = won;
    this.onEvent({
      type: 'done',
      won,
      level: this.level,
      startLevel: this.startLevel,
      score: this.score,
      kills: this.kills,
      distanceM: Math.floor(this.z),
      timeMs: this.timeMs,
    });
  }

  /**
   * The sector's goal is met: sweep the sky, bank the bonus, and either
   * open the intermission or — after the last sector — end the run a win.
   */
  clearLevel(now) {
    if (this.state !== 'running') return;
    const purged = this.aliens;
    this.aliens = [];
    this.alienBolts = [];
    const flawless = this.levelHitsTaken === 0;
    const bonus = CLEAR_POINTS * this.level + (flawless ? FLAWLESS_POINTS : 0);
    this.bonus += bonus;
    this.timeMs = now - this.startMs;
    const final = this.level >= LEVELS.length;
    this.onEvent({
      type: 'cleared',
      level: this.level,
      name: this.def.name,
      kills: this.levelKills,
      timeMs: now - this.levelStartMs,
      accuracy: this.levelShots ? this.levelHits / this.levelShots : 0,
      flawless,
      bonus,
      purged,
      final,
      next: final ? null : this.level + 1,
    });
    if (final) {
      this.finish(true);
      return;
    }
    this.state = 'cleared';
    this.nextLevelAt = now + INTERMISSION_MS;
  }

  update(now, dt) {
    if (this.state !== 'running' && this.state !== 'cleared') return;
    const d = this.def;
    const levelS = (now - this.levelStartMs) / 1000;

    // Cruise speed eases to the sector's — no lurch at the sector line.
    this.speed += (d.speed - this.speed) * Math.min(1, dt * 0.8);
    const lock = Math.max(-1, Math.min(1, this.steer / STEER_FULL));
    this.x = Math.max(-LANE_HALF, Math.min(LANE_HALF, this.x + lock * LATERAL_SPEED * dt));
    this.z += this.speed * dt;

    // Player bolts fly ahead; expire out of range.
    this.bolts = this.bolts.filter((b) => {
      b.z += (this.speed + BOLT_REL_SPEED) * dt;
      return !b.dead && b.z - b.born < BOLT_RANGE;
    });

    if (this.state === 'cleared') {
      // Intermission: the ship keeps flying, the sky is empty.
      this.timeMs = now - this.startMs;
      if (now >= this.nextLevelAt) this.beginLevel(this.level + 1, now);
      return;
    }

    // Waves keep coming; dawdle in a sector and they come faster.
    if (now >= this.nextSpawnMs) {
      this.spawnAlien(now);
      const gap = Math.max(d.spawnMs * 0.75, d.spawnMs - levelS * 5);
      this.nextSpawnMs = now + Math.max(SPAWN_MS_MIN, gap);
    }

    if (d.boss && !this.boss && !this.bossDefeated && now >= this.bossAt) this.spawnBoss(now);
    if (this.boss) {
      this.updateBoss(now, dt);
      if (this.state !== 'running') return;
    }

    for (const a of this.aliens) {
      const age = (now - a.bornMs) / 1000;
      this.moveAlien(a, now, dt, age);

      // Bolt × alien.
      for (const b of this.bolts) {
        if (b.dead || a.dead) continue;
        if (Math.hypot(b.x - a.x, b.z - a.z) < a.r + 0.4) {
          b.dead = true;
          this.levelHits += 1;
          a.hp -= 1;
          if (a.hp > 0) {
            a.flashUntil = now + 180;
            this.onEvent({ type: 'armor', alien: a });
            continue;
          }
          a.dead = true;
          this.kills += 1;
          this.levelKills += 1;
          if (a.type === 'tank') this.bonus += TANK_BONUS;
          this.onEvent({ type: 'kill', alien: a, kills: this.kills, score: this.score });
        }
      }

      // Alien fire: inside range, on its own trigger discipline.
      if (!a.dead && SAUCER_TYPES[a.type].fires
          && a.z - this.z < ALIEN_FIRE_RANGE && now >= a.nextFireMs) {
        a.nextFireMs = now + d.fireMs + this.rng() * 600;
        this.alienBolts.push({ x: a.x, z: a.z - a.r, speed: d.boltSpeed });
        this.onEvent({ type: 'alienFire', x: a.x, z: a.z });
      }

      // Ram: the saucer reaches the ship's plane on top of it.
      if (!a.dead && a.z <= this.z && Math.abs(a.x - this.x) < SHIP_R + a.r) {
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
      const closing = ((b.speed ?? ALIEN_BOLT_SPEED) + this.speed) * dt;
      b.z -= (b.speed ?? ALIEN_BOLT_SPEED) * dt;
      if (b.vx) b.x += b.vx * dt;
      const rel = b.z - this.z;
      // A fresh bolt has no previous reading: reconstruct it from this
      // tick's closing distance so a point-blank shot can't slip through.
      const crossed = (b.rel ?? rel + closing) > 0 && rel <= 0;
      b.rel = rel;
      if (crossed && Math.abs(b.x - this.x) < SHIP_R) {
        this.loseLife(now, 'bolt');
        return false;
      }
      return rel > -12;
    });
    if (this.state !== 'running') return;

    this.timeMs = now - this.startMs;
    if (!d.boss && this.levelKills >= d.goal) this.clearLevel(now);
  }

  moveAlien(a, now, dt, age) {
    if (a.type === 'diver') {
      const gap = a.z - this.z;
      if (a.mode === 'cruise' && gap < DIVER_LOCK_RANGE) {
        a.mode = 'windup';
        a.diveAt = now + DIVER_WINDUP_MS;
        this.onEvent({ type: 'windup', alien: a });
      }
      if (a.mode === 'windup') {
        a.z += this.speed * dt * 0.9;           // nearly holds station, glowing
        if (now >= a.diveAt) {
          a.mode = 'dive';
          a.targetX = this.x;                   // charges where you ARE
          this.onEvent({ type: 'dive', alien: a });
        }
        return;
      }
      if (a.mode === 'dive') {
        a.z -= DIVER_DIVE_SPEED * dt;
        const dx = a.targetX - a.x;
        a.x += Math.sign(dx) * Math.min(Math.abs(dx), DIVER_TRACK * dt);
        return;
      }
    }
    a.z -= a.speed * dt;
    const u = a.phase / (Math.PI * 2) + age * a.swayHz;
    const wave = a.type === 'zigzag' ? tri(u) : Math.sin(u * Math.PI * 2);
    a.x = Math.max(-LANE_HALF, Math.min(LANE_HALF, a.x0 + wave * a.swayAmp));
  }

  updateBoss(now, dt) {
    const boss = this.boss;
    const spec = this.def.boss;
    const age = (now - boss.bornMs) / 1000;
    boss.gap = Math.max(BOSS_HOLD, boss.gap - BOSS_GLIDE * dt);
    boss.z = this.z + boss.gap;
    boss.x = Math.sin(age * spec.swayHz * Math.PI * 2) * spec.swayAmp;
    const arrived = boss.gap <= BOSS_HOLD + 0.5;

    // Player bolts against the hull.
    for (const b of this.bolts) {
      if (b.dead || !this.boss) continue;
      if (Math.abs(b.x - boss.x) < boss.r && Math.abs(b.z - boss.z) < 2.5) {
        b.dead = true;
        this.levelHits += 1;
        boss.hp -= 1;
        boss.flashUntil = now + 120;
        this.onEvent({ type: 'bossHit', boss, hp: boss.hp });
        if (boss.hp <= 0) {
          this.boss = null;
          this.bossDefeated = true;
          this.kills += 1;
          this.levelKills += 1;
          this.bonus += BOSS_POINTS;
          const extraLife = this.lives < LIVES;
          this.lives = Math.min(LIVES, this.lives + 1);
          this.onEvent({ type: 'bossDown', boss, extraLife, lives: this.lives });
          this.clearLevel(now);
          return;
        }
      }
    }

    // Attack pattern: a fanned spread; the final boss alternates it with
    // an aimed triple that leads your ship.
    if (arrived && now >= boss.nextFireMs) {
      boss.nextFireMs = now + spec.fireMs;
      boss.volley += 1;
      const speed = this.def.boltSpeed;
      const z = boss.z - boss.r;
      if (spec.aimed && boss.volley % 2 === 0) {
        const t = (z - this.z) / (speed + this.speed);
        for (const off of [-3, 0, 3]) {
          const vx = (this.x + off - boss.x) / t;
          this.alienBolts.push({ x: boss.x, z, speed, vx });
        }
      } else {
        for (let i = 0; i < spec.spread; i += 1) {
          const k = spec.spread === 1 ? 0 : (i / (spec.spread - 1)) * 2 - 1;
          this.alienBolts.push({ x: boss.x + k * 1.5, z, speed, vx: k * spec.spreadV });
        }
      }
      this.onEvent({ type: 'bossFire', x: boss.x, z: boss.z, volley: boss.volley });
    }
  }
}

// ── Progression: unlocked sectors and best score, persisted ───────────────
// Storage is injected (localStorage in the browser, a stub in tests) and
// every touch is guarded — private windows and blocked storage throw.

export const PROGRESS_KEY = 'senwii.alienAttack.v1';

export const defaultProgress = () => ({ unlocked: 1, best: 0 });

export function sanitizeProgress(p) {
  const out = defaultProgress();
  if (!p || typeof p !== 'object') return out;
  const u = Number(p.unlocked);
  if (Number.isFinite(u)) out.unlocked = Math.max(1, Math.min(LEVELS.length, Math.floor(u)));
  const b = Number(p.best);
  if (Number.isFinite(b) && b > 0) out.best = Math.floor(b);
  return out;
}

export function loadProgress(storage) {
  try {
    const raw = storage && storage.getItem(PROGRESS_KEY);
    if (!raw) return defaultProgress();
    return sanitizeProgress(JSON.parse(raw));
  } catch {
    return defaultProgress();
  }
}

export function saveProgress(storage, p) {
  try {
    if (!storage) return false;
    storage.setItem(PROGRESS_KEY, JSON.stringify(sanitizeProgress(p)));
    return true;
  } catch {
    return false;
  }
}

/** Reaching sector `level` unlocks it as a starting point. */
export const unlockLevel = (p, level) => sanitizeProgress({
  ...p, unlocked: Math.max(p.unlocked, Math.min(LEVELS.length, level)),
});

export const recordScore = (p, score) => sanitizeProgress({
  ...p, best: Math.max(p.best || 0, score || 0),
});

/** One d-pad press: one step, clamped to the unlocked range. */
export function stepLevel(current, dir, unlocked) {
  const max = Math.max(1, Math.min(LEVELS.length, unlocked));
  return Math.max(1, Math.min(max, current + (dir < 0 ? -1 : dir > 0 ? 1 : 0)));
}

export function fmtMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—:—';
  const s = ms / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
}
