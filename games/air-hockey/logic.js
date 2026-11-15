/**
 * Air Hockey — rally logic. No renderer, no DOM.
 *
 * A top-down table, x/z only (no gravity — the puck glides on a cushion of
 * air, which is the one thing this sport gets to skip that table tennis and
 * golf can't). The player's paddle follows the pointer directly rather than
 * a swing: air hockey is a positioning game, so full 2D position control is
 * the natural input, and the paddle's own motion (derived from successive
 * positions) is what gives a shot its pace — a shove, not a swing. First to
 * WIN_SCORE goals wins. All randomness injected.
 */

export const TABLE = { WIDTH: 1.0, LENGTH: 2.0 };
export const GOAL_WIDTH = 0.42;
export const PUCK_RADIUS = 0.045;
export const PADDLE_RADIUS = 0.11;
export const WIN_SCORE = 7;
export const PLAYER_Z = TABLE.LENGTH / 2;
export const AI_Z = -TABLE.LENGTH / 2;
export const CENTER_LINE = 0.08;     // neither paddle may cross past this into the other half

export class Match {
  constructor({ onEvent = () => {}, rng = Math.random, aiSkill = 0.75 } = {}) {
    this.onEvent = onEvent;
    this.rng = rng;
    this.aiSkill = aiSkill;

    this.state = 'ready';            // ready | playing | point | over
    this.score = { player: 0, ai: 0 };
    this.winner = null;
    this.pauseUntil = 0;
    this.nextServer = 'player';

    this.puck = { x: 0, z: 0, vx: 0, vz: 0 };
    this.live = false;

    this.paddle = { x: 0, z: PLAYER_Z - 0.3, vx: 0, vz: 0 };
    this.aiPaddle = { x: 0, z: AI_Z + 0.3, vx: 0, vz: 0 };
  }

  start(now) {
    this.state = 'playing';
    this.score = { player: 0, ai: 0 };
    this.winner = null;
    this.serve('player', now);
    this.onEvent({ type: 'start' });
  }

  serve(who, now) {
    const dir = who === 'player' ? -1 : 1;    // serves toward the OTHER goal
    this.puck = {
      x: (this.rng() - 0.5) * 0.3,
      z: 0,
      vx: (this.rng() - 0.5) * 0.4,
      vz: dir * 1.1,
    };
    this.live = true;
    this.onEvent({ type: 'serve', who });
    void now;
  }

  /** Pointer position (normalised 0..1, y down) → the player's paddle. */
  setPaddle(nx, ny, dt) {
    const x = (nx - 0.5) * (TABLE.WIDTH - PADDLE_RADIUS * 2);
    const z = Math.max(CENTER_LINE, Math.min(PLAYER_Z - PADDLE_RADIUS, (1 - ny) * (PLAYER_Z - CENTER_LINE) + CENTER_LINE));
    if (dt > 0) {
      this.paddle.vx = (x - this.paddle.x) / dt;
      this.paddle.vz = (z - this.paddle.z) / dt;
    }
    this.paddle.x = x;
    this.paddle.z = z;
  }

  scorePoint(who, now) {
    this.score[who] += 1;
    this.onEvent({ type: 'goal', who, score: { ...this.score } });
    if (this.score[who] >= WIN_SCORE) {
      this.state = 'over';
      this.winner = who;
      this.live = false;
      this.onEvent({ type: 'over', winner: who });
      return;
    }
    this.state = 'point';
    this.live = false;
    this.pauseUntil = now + 1100;
    this.nextServer = who === 'player' ? 'ai' : 'player';   // scored-on side serves
  }

  /** Reflect+push off a paddle: puck leaves along the paddle→puck line. */
  bounceOffPaddle(paddle) {
    const p = this.puck;
    const dx = p.x - paddle.x;
    const dz = p.z - paddle.z;
    const dist = Math.hypot(dx, dz) || 0.001;
    const nx = dx / dist;
    const nz = dz / dist;
    const incoming = Math.hypot(p.vx, p.vz);
    const paddleSpeed = Math.hypot(paddle.vx || 0, paddle.vz || 0);
    const pushSpeed = Math.max(1.0, incoming * 0.5 + paddleSpeed * 1.1);
    p.vx = nx * pushSpeed;
    p.vz = nz * pushSpeed;
    const clearance = PADDLE_RADIUS + PUCK_RADIUS + 0.002;
    p.x = paddle.x + nx * clearance;
    p.z = paddle.z + nz * clearance;
  }

  update(now, dt) {
    if (this.state === 'point' && now >= this.pauseUntil) {
      this.state = 'playing';
      this.serve(this.nextServer, now);
    }
    if (this.state !== 'playing' || !this.live) return;

    const p = this.puck;
    p.x += p.vx * dt;
    p.z += p.vz * dt;
    const drag = Math.max(0, 1 - 0.15 * dt);
    p.vx *= drag; p.vz *= drag;

    // Side walls.
    const halfW = TABLE.WIDTH / 2 - PUCK_RADIUS;
    if (p.x > halfW) { p.x = halfW; p.vx = -Math.abs(p.vx) * 0.9; }
    else if (p.x < -halfW) { p.x = -halfW; p.vx = Math.abs(p.vx) * 0.9; }

    // End walls / goals.
    if (p.z > PLAYER_Z - PUCK_RADIUS) {
      if (Math.abs(p.x) < GOAL_WIDTH / 2) { this.scorePoint('ai', now); return; }
      p.z = PLAYER_Z - PUCK_RADIUS;
      p.vz = -Math.abs(p.vz) * 0.9;
    } else if (p.z < AI_Z + PUCK_RADIUS) {
      if (Math.abs(p.x) < GOAL_WIDTH / 2) { this.scorePoint('player', now); return; }
      p.z = AI_Z + PUCK_RADIUS;
      p.vz = Math.abs(p.vz) * 0.9;
    }

    // Paddle contact.
    if (Math.hypot(p.x - this.paddle.x, p.z - this.paddle.z) < PADDLE_RADIUS + PUCK_RADIUS) {
      this.bounceOffPaddle(this.paddle);
      this.onEvent({ type: 'hit', by: 'player' });
    } else if (Math.hypot(p.x - this.aiPaddle.x, p.z - this.aiPaddle.z) < PADDLE_RADIUS + PUCK_RADIUS) {
      this.bounceOffPaddle(this.aiPaddle);
      this.onEvent({ type: 'hit', by: 'ai' });
    }

    // AI paddle: tracks the puck within its own half, capped speed.
    const targetX = Math.max(-halfW, Math.min(halfW, p.x));
    const targetZ = Math.max(AI_Z + PADDLE_RADIUS, Math.min(-CENTER_LINE, p.z < 0 ? p.z : AI_Z + 0.3));
    const maxStep = (0.7 + this.aiSkill * 1.4) * dt;
    const dx = targetX - this.aiPaddle.x;
    const dz = targetZ - this.aiPaddle.z;
    const stepX = Math.max(-maxStep, Math.min(maxStep, dx));
    const stepZ = Math.max(-maxStep, Math.min(maxStep, dz));
    this.aiPaddle.vx = stepX / dt;
    this.aiPaddle.vz = stepZ / dt;
    this.aiPaddle.x += stepX;
    this.aiPaddle.z += stepZ;
  }
}
