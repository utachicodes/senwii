import { Trail, segmentDistance } from '../../core/trail.js';

/**
 * Fruit Ninja — pure game logic. No Three.js, no DOM.
 *
 * Kept renderer-free so the mechanics can be tested headlessly in Node instead
 * of by evaluating JavaScript inside a browser tab. `game.js` owns rendering
 * and drives an instance of this.
 *
 * Units are a virtual play field measured in world units, `FIELD_H` tall and
 * `FIELD_H * aspect` wide — not pixels. The 2D original scaled its physics off
 * the window size, which quietly changed how the game felt when you resized it.
 */

export const FIELD_H = 9;
export const GRAVITY = 18.75;          // world units/s², = the old 1500 px/s²
export const MIN_SLICE_SPEED = 3.25;   // world units/s, = the old 260 px/s
export const CRITICAL_CHANCE = 0.05;   // like the original: rare, +10, gold burst
export const BOMB_PENALTY = 10;        // practice mode: bombs cost points, not the run

/**
 * The classic line-up. `splat` is the juice that stains the dojo wall — it is
 * the flesh colour, not the rind: a watermelon splats red, a kiwi green.
 */
export const FRUIT_TYPES = [
  { name: 'watermelon', rind: 0x27691f, flesh: 0xf1373b, splat: 0xd92a35, r: 0.86 },
  { name: 'pineapple', rind: 0xd9a13b, flesh: 0xf7de74, splat: 0xf0c945, r: 0.74 },
  { name: 'strawberry', rind: 0xd8261f, flesh: 0xf7a9a0, splat: 0xd92a35, r: 0.58 },
  { name: 'orange', rind: 0xf28511, flesh: 0xffb840, splat: 0xff9a1f, r: 0.62 },
  { name: 'kiwi', rind: 0x7a5b39, flesh: 0x8cc63f, splat: 0x7fb832, r: 0.55 },
  { name: 'lemon', rind: 0xf5d321, flesh: 0xfbe97b, splat: 0xf2d93b, r: 0.58 },
  { name: 'apple', rind: 0x7bb92e, flesh: 0xf4f0d5, splat: 0xb9d152, r: 0.62 },
  { name: 'peach', rind: 0xf5923e, flesh: 0xfad089, splat: 0xf5a623, r: 0.65 },
];

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class FruitNinja {
  constructor({ aspect = 16 / 9, onEvent = () => {}, infiniteLives = false, rng = Math.random } = {}) {
    this.h = FIELD_H;
    this.w = FIELD_H * aspect;
    this.onEvent = onEvent;
    this.infiniteLives = infiniteLives;   // practice: misses and bombs never end the run
    this.rng = rng;                        // injected so criticals are testable

    this.state = {
      phase: 'idle',        // idle | playing | over
      score: 0,              // combined total across every player, for the HUD/back-compat
      lives: 3,               // one shared pool: everyone's on the same board
      combo: 0,               // mirrors whichever player most recently scored
      comboUntil: 0,
      nextSpawn: 0,
      startedAt: 0,
      held: false,            // phone briefly gone: no new fruit, misses are free
    };

    this.fruits = [];
    this.halves = [];
    this.particles = [];
    // One board, sliced by up to MAX_PLAYERS blades — one per connected phone
    // (the server tags every packet with a `slot`; see server.js). Each slot
    // gets its own trail, so simultaneous swings never contaminate each
    // other's speed/segment history. Entries are created lazily by
    // `setCursor` and persist for the session (a reconnect keeps its slot's
    // running score), so this Map is never cleared, only reset in `start`.
    this.players = new Map();
  }

  setAspect(aspect) {
    this.w = this.h * aspect;
  }

  /** Lazily create a player's per-slot state: trail, cursor, score, combo. */
  getPlayer(slot) {
    let p = this.players.get(slot);
    if (!p) {
      p = {
        slot,
        trail: new Trail({ lifetimeMs: 140, minStep: 0.004, speedWindowMs: 55 }),
        cursor: { x: 0, y: 0, active: false },
        score: 0,
        combo: 0,
        comboUntil: 0,
        lastActiveAt: -Infinity,
      };
      this.players.set(slot, p);
    }
    return p;
  }

  // Back-compat accessors for the common single-player case (tests, and any
  // renderer code that hasn't been made slot-aware) — slot 0's trail/cursor.
  get trail() { return this.getPlayer(0).trail; }
  get cursor() { return this.getPlayer(0).cursor; }

  /** A phone's blade position in world units. `slot` defaults to the lone
   *  single-player controller. */
  setCursor(x, y, now, slot = 0) {
    const p = this.getPlayer(slot);
    p.cursor.x = x;
    p.cursor.y = y;
    p.cursor.active = true;
    p.lastActiveAt = now;
    p.trail.push(x, y, now);
  }

  start(now) {
    Object.assign(this.state, {
      phase: 'playing', score: 0, lives: 3, combo: 0, comboUntil: 0,
      startedAt: now, nextSpawn: now + 900, held: false,
    });
    this.fruits.length = 0;
    this.halves.length = 0;
    this.particles.length = 0;
    // Fresh round for every player who's ever connected — scores and combos
    // reset, but the slot (and its blade colour) is kept, so nobody has to
    // reconnect between rounds.
    for (const p of this.players.values()) {
      p.score = 0;
      p.combo = 0;
      p.comboUntil = 0;
      p.trail.clear();
    }
    this.onEvent({ type: 'start' });
  }

  end(now) {
    this.state.phase = 'over';
    this.onEvent({ type: 'gameover', score: this.state.score });
  }

  spawn(isBomb, now) {
    const kind = FRUIT_TYPES[(Math.random() * FRUIT_TYPES.length) | 0];
    const x = rand(-this.w * 0.38, this.w * 0.38);
    const rise = rand(this.h * 0.55, this.h * 0.88);
    this.fruits.push({
      x,
      y: -this.h / 2 - 0.8,
      vx: (-x / 4) * rand(0.4, 1.1),
      vy: Math.sqrt(2 * GRAVITY * rise),
      r: isBomb ? 0.6 : kind.r,
      rot: rand(0, Math.PI * 2),
      spin: rand(-2.4, 2.4),
      spinAxis: { x: rand(-1, 1), y: rand(-1, 1), z: rand(-1, 1) },
      bomb: !!isBomb,
      kind,
      id: FruitNinja.nextId++,
    });
    this.onEvent({ type: 'launch', bomb: !!isBomb });
  }

  slice(f, angle, now) {
    const perp = angle + Math.PI / 2;
    for (const side of [-1, 1]) {
      this.halves.push({
        x: f.x, y: f.y,
        vx: f.vx + Math.cos(perp) * side * rand(1.2, 2.2),
        vy: f.vy + Math.sin(perp) * side * rand(1.2, 2.2) - 0.8,
        r: f.r,
        // `cut` is the fixed angle of the slice line; `tumble` accumulates
        // about it. Keeping them separate lets the renderer point the flat
        // face along the separation direction and still spin the half so the
        // exposed flesh turns toward the camera.
        cut: angle,
        tumble: 0,
        spin: side * rand(1.5, 4),
        side,
        kind: f.kind,
        id: FruitNinja.nextId++,
      });
    }
    for (let i = 0; i < 22; i += 1) {
      const a = angle + rand(-0.9, 0.9) + (Math.random() < 0.5 ? 0 : Math.PI);
      const s = rand(1, 6);
      this.particles.push({
        x: f.x, y: f.y,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s + rand(0, 1.8),
        r: rand(0.03, 0.1), color: f.kind.splat, life: 1, decay: rand(0.7, 1.6),
        id: FruitNinja.nextId++,
      });
    }
  }

  explode(f) {
    for (let i = 0; i < 90; i += 1) {
      const a = rand(0, Math.PI * 2);
      const s = rand(1.5, 11);
      this.particles.push({
        x: f.x, y: f.y,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        r: rand(0.025, 0.11), color: Math.random() < 0.5 ? 0xffd166 : 0xff5f6d,
        life: 1, decay: rand(0.6, 1.4), id: FruitNinja.nextId++,
      });
    }
  }

  spawnInterval(now) {
    return Math.max(260, 780 - ((now - this.state.startedAt) / 1000) * 14);
  }

  bombChance(now) {
    return clamp(0.06 + ((now - this.state.startedAt) / 1000) * 0.003, 0, 0.25);
  }

  update(now, dt) {
    this.stepDebris(dt);
    if (this.state.phase !== 'playing') {
      // Game over (or not started): whatever is still in the air finishes its
      // arc and drops out of the frame — it just can't be cut or missed any
      // more. Freezing it mid-air looked like a rendering bug.
      this.stepFalling(dt);
      return;
    }

    if (this.state.held) {
      // Nothing launches while held; the clock restarts on release.
      this.state.nextSpawn = Math.max(this.state.nextSpawn, now + 1200);
    } else if (now >= this.state.nextSpawn) {
      const roll = Math.random();
      const burst = roll < 0.15 ? 4 : roll < 0.35 ? 3 : roll < 0.62 ? 2 : 1;
      for (let i = 0; i < burst; i += 1) this.spawn(Math.random() < this.bombChance(now), now);
      this.state.nextSpawn = now + this.spawnInterval(now);
    }

    const floor = -this.h / 2 - 1.2;

    // Only blades that are actually moving (and recently — see lastActiveAt
    // below) can cut. Computed once per frame, same as the old single-blade
    // version, just fanned out across however many phones are connected.
    const activeBlades = [];
    for (const p of this.players.values()) {
      // A staleness cutoff on top of the speed gate: without it, a player who
      // disconnects (or whose game.js stops calling setCursor) mid-swing
      // leaves their last real segment frozen in place forever — trail.speed()
      // keeps reporting that final swing's speed because nothing ages it
      // without a fresh push(). A "ghost blade" that never goes cold would
      // keep slicing anything that happens to drift across its last position.
      if (now - p.lastActiveAt > 200) continue;
      if (p.trail.speed() > MIN_SLICE_SPEED && p.trail.segments.length > 0) activeBlades.push(p);
    }

    for (let i = this.fruits.length - 1; i >= 0; i -= 1) {
      const f = this.fruits[i];
      f.vy -= GRAVITY * dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.rot += f.spin * dt;

      let cutBy = null;
      let cutSeg = null;
      for (const p of activeBlades) {
        for (const s of p.trail.segments) {
          if (segmentDistance(f.x, f.y, s.x1, s.y1, s.x2, s.y2) > f.r) continue;
          cutBy = p;
          cutSeg = s;
          break;
        }
        if (cutBy) break;
      }

      if (cutBy) {
        this.fruits.splice(i, 1);
        if (f.bomb) {
          this.explode(f);
          if (this.infiniteLives) {
            // Practice: the blast costs points, not the run.
            this.state.score = Math.max(0, this.state.score - BOMB_PENALTY);
            cutBy.score = Math.max(0, cutBy.score - BOMB_PENALTY);
            cutBy.combo = 0;
            this.state.combo = 0;
            this.onEvent({ type: 'bomb', fatal: false, x: f.x, y: f.y, slot: cutBy.slot });
          } else {
            this.onEvent({ type: 'bomb', fatal: true, x: f.x, y: f.y, slot: cutBy.slot });
            this.end(now);
            break;      // the run is over: no further cuts or misses this frame
          }
        } else {
          this.slice(f, Math.atan2(cutSeg.y2 - cutSeg.y1, cutSeg.x2 - cutSeg.x1), now);
          cutBy.combo = now < cutBy.comboUntil ? cutBy.combo + 1 : 1;
          cutBy.comboUntil = now + 260;
          // Mirrored onto shared state for back-compat (single-player reads
          // state.combo directly) and so the HUD's combo banner always shows
          // whoever most recently extended a streak.
          this.state.combo = cutBy.combo;
          this.state.comboUntil = cutBy.comboUntil;
          const critical = this.rng() < CRITICAL_CHANCE;
          const gained = 1 + (cutBy.combo > 1 ? cutBy.combo : 0) + (critical ? 10 : 0);
          cutBy.score += gained;
          this.state.score += gained;
          this.onEvent({
            type: 'slice', combo: cutBy.combo, gained, critical,
            x: f.x, y: f.y, kind: f.kind, r: f.r, slot: cutBy.slot, playerScore: cutBy.score,
          });
        }
        continue;
      }

      if (f.y + f.r < floor) {
        this.fruits.splice(i, 1);
        if (!f.bomb && this.state.phase === 'playing') {
          if (this.state.held) continue;   // dropped while its player was away
          if (!this.infiniteLives) this.state.lives -= 1;
          this.onEvent({ type: 'miss', lives: this.state.lives, x: f.x });
          if (this.state.lives <= 0) {
            this.end(now);
            activeBlades.length = 0;   // out: nothing else scores this frame
          }
        }
      }
    }

    for (const p of this.players.values()) {
      if (p.combo > 1 && now >= p.comboUntil) p.combo = 0;
    }
    if (this.state.combo > 1 && now >= this.state.comboUntil) this.state.combo = 0;
  }

  /** Fruit physics with no scoring: used once the board is over. */
  stepFalling(dt) {
    const floor = -this.h / 2 - 1.2;
    for (let i = this.fruits.length - 1; i >= 0; i -= 1) {
      const f = this.fruits[i];
      f.vy -= GRAVITY * dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.rot += f.spin * dt;
      if (f.y + f.r < floor) this.fruits.splice(i, 1);
    }
  }

  stepDebris(dt) {
    const floor = -this.h / 2 - 2;
    for (let i = this.halves.length - 1; i >= 0; i -= 1) {
      const h = this.halves[i];
      h.vy -= GRAVITY * dt;
      h.x += h.vx * dt;
      h.y += h.vy * dt;
      h.tumble += h.spin * dt;
      if (h.y < floor) this.halves.splice(i, 1);
    }
    for (let i = this.particles.length - 1; i >= 0; i -= 1) {
      const p = this.particles[i];
      p.vy -= GRAVITY * 0.55 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= p.decay * dt;
      if (p.life <= 0) this.particles.splice(i, 1);
    }
  }
}

FruitNinja.nextId = 1;

/**
 * A local match: one independent board per player, each with its own fruit,
 * lives and score (the split-screen layout is just each board's viewport).
 * First to lose all three lives — or touch a bomb — is out; the match ends when
 * the last board falls, and the highest score wins.
 *
 * Boards are keyed by the relay's player slot (0..3). Players may join late
 * (they get a fresh board at once — drop-in, like an arcade cabinet) or leave
 * (their board is forfeited and keeps its score on the results screen).
 */
export const MAX_BOARDS = 4;

export class FruitMatch {
  constructor({ onEvent = () => {}, infiniteLives = false, rng = Math.random } = {}) {
    this.onEvent = onEvent;
    this.infiniteLives = infiniteLives;
    this.rng = rng;
    this.phase = 'idle';          // idle | playing | over
    this.boards = new Map();      // slot → FruitNinja (insertion order = display order)
    this.meta = new Map();        // slot → { over, overAt, reason }
    this.startedAt = 0;
    this.now = 0;
    this.result = null;           // set when the match ends
  }

  get slots() { return [...this.boards.keys()].sort((a, b) => a - b); }
  get count() { return this.boards.size; }

  board(slot) { return this.boards.get(slot) || null; }
  isOver(slot) { return !!this.meta.get(slot)?.over; }

  #makeBoard(slot, aspect) {
    const board = new FruitNinja({
      aspect,
      infiniteLives: this.infiniteLives,
      rng: this.rng,
      onEvent: (e) => this.#forward(slot, e),
    });
    this.boards.set(slot, board);
    this.meta.set(slot, { over: false, overAt: null, reason: null });
    return board;
  }

  #forward(slot, e) {
    if (e.type === 'start') return;                 // the match announces its own start
    const meta = this.meta.get(slot);
    if (e.type === 'gameover') {
      if (meta.over) return;
      meta.over = true;
      meta.overAt = this.now;
      meta.reason ||= 'out';
      this.onEvent({ type: 'out', slot, score: this.board(slot).state.score, reason: meta.reason });
      this.#maybeFinish();
      return;
    }
    this.onEvent({ ...e, slot });
  }

  /** Begin a round for exactly these slots. */
  start(slots, now, aspects = {}) {
    const list = [...new Set(slots)].filter((s) => s >= 0 && s < MAX_BOARDS).sort((a, b) => a - b);
    if (list.length === 0) list.push(0);
    this.boards.clear();
    this.meta.clear();
    this.result = null;
    this.now = now;
    this.startedAt = now;
    this.phase = 'playing';
    for (const slot of list) this.#makeBoard(slot, aspects[slot] || 16 / 9).start(now);
    this.onEvent({ type: 'start', slots: list });
  }

  /** A phone connected mid-round: it gets its own fresh board immediately. */
  join(slot, now, aspect = 16 / 9) {
    if (this.phase !== 'playing' || this.boards.has(slot) || slot < 0 || slot >= MAX_BOARDS) return false;
    this.now = now;
    const b = this.#makeBoard(slot, aspect);
    b.start(now);
    this.onEvent({ type: 'join', slot });
    return true;
  }

  /** A phone left mid-round: forfeit its board; it keeps its score. */
  leave(slot, now) {
    const b = this.boards.get(slot);
    const meta = this.meta.get(slot);
    if (!b || meta.over || this.phase !== 'playing') return false;
    this.now = now;
    meta.reason = 'left';
    b.end(now);        // → 'gameover' → #forward marks it out
    return true;
  }

  /**
   * Pause/resume one board while its phone reconnects. A held board launches
   * nothing and fruit already in the air can't cost a life, so a Wi-Fi blip
   * or a dimmed screen isn't a death sentence. The caller decides when a
   * disconnect has gone on long enough to forfeit with leave().
   */
  hold(slot, on) {
    const b = this.boards.get(slot);
    if (b) b.state.held = !!on;
  }

  setAspect(slot, aspect) { this.boards.get(slot)?.setAspect(aspect); }

  setCursor(slot, x, y, now) {
    const b = this.boards.get(slot);
    if (b && !this.isOver(slot)) b.setCursor(x, y, now, 0);
  }

  update(now, dt) {
    this.now = now;
    for (const b of this.boards.values()) b.update(now, dt);
  }

  #maybeFinish() {
    if (this.phase !== 'playing' || this.boards.size === 0) return;
    for (const slot of this.boards.keys()) if (!this.meta.get(slot).over) return;
    this.phase = 'over';
    const standings = this.standings();
    const top = standings[0];
    const winners = standings.filter((s) => s.score === top.score && s.overAt === top.overAt).map((s) => s.slot);
    this.result = { standings, winners, solo: standings.length === 1 };
    this.onEvent({ type: 'matchover', ...this.result });
  }

  /**
   * Best first: higher score, then whoever lasted longer. Equal on both is a
   * genuine tie and shares a rank.
   */
  standings() {
    const rows = [...this.boards.entries()].map(([slot, b]) => {
      const meta = this.meta.get(slot);
      return {
        slot,
        score: b.state.score,
        lives: b.state.lives,
        over: meta.over,
        overAt: meta.overAt,
        reason: meta.reason,
      };
    });
    const alive = (r) => (r.over ? r.overAt : Infinity);
    rows.sort((a, b) => b.score - a.score || alive(b) - alive(a) || a.slot - b.slot);
    rows.forEach((r, i) => {
      const prev = rows[i - 1];
      r.rank = prev && prev.score === r.score && alive(prev) === alive(r) ? prev.rank : i + 1;
    });
    return rows;
  }
}
