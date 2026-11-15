import { stepBall, groundBall } from '../shared/ball.js';

/**
 * Bowling — ten-pin logic. No renderer, no DOM.
 *
 * The player aims with the pointer and swings the phone to release; power
 * comes from swing speed, same contract as golf's strike(). The lane is flat
 * (shared/ball.js's ground function needs a height function either way, so a
 * bowling lane is just the degenerate case), a gutter is simply "off the
 * lane's half-width", and pin knockdown is distance-based with a small chain
 * radius so a solid hit topples its neighbours instead of only the one pin
 * it touched. Scoring is the standard rolling ten-pin algorithm, computed
 * from a flat list of pinfall-per-ball so it's exactly the thing a scoreboard
 * actually tracks.
 */

export const LANE = { LENGTH: 18, HALF_WIDTH: 0.53 };
export const PIN_RADIUS = 0.06;
export const BALL_RADIUS = 0.13;
export const CHAIN_RADIUS = 0.33;    // a felled pin topples a neighbour this close
export const HEADPIN_Z = LANE.LENGTH - 2.2;
export const ROW_STEP = 0.305;       // depth between pin rows
export const FRAMES = 10;

/** The standard 1-2-3-4 triangle, apex (headpin) toward the bowler. */
export function standardPins() {
  const rows = [1, 2, 3, 4];
  const pins = [];
  let id = 0;
  for (let r = 0; r < rows.length; r += 1) {
    const count = rows[r];
    const z = HEADPIN_Z + r * ROW_STEP * 0.87;
    const width = (count - 1) * ROW_STEP;
    for (let i = 0; i < count; i += 1) {
      pins.push({ id: id++, x: -width / 2 + i * ROW_STEP, z, standing: true });
    }
  }
  return pins;
}

/**
 * Standard rolling ten-pin score from a flat rolls[] list (pins knocked per
 * ball, in order bowled — exactly `Game.rolls`).
 */
export function scoreRolls(rolls) {
  let total = 0;
  let i = 0;
  for (let frame = 0; frame < FRAMES; frame += 1) {
    if (rolls[i] === undefined) break;
    if (rolls[i] === 10) {
      total += 10 + (rolls[i + 1] || 0) + (rolls[i + 2] || 0);
      i += 1;
    } else if ((rolls[i] || 0) + (rolls[i + 1] || 0) === 10) {
      total += 10 + (rolls[i + 2] || 0);
      i += 2;
    } else {
      total += (rolls[i] || 0) + (rolls[i + 1] || 0);
      i += 2;
    }
  }
  return total;
}

export class Game {
  constructor({ onEvent = () => {} } = {}) {
    this.onEvent = onEvent;
    this.state = 'aim';            // aim | roll | over
    this.pins = standardPins();
    this.standingAtRollStart = 10;
    this.ball = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
    this.aimOffset = 0;            // radians, left/right of straight down the lane
    this.frameIndex = 0;           // 0..9
    this.ballInFrame = 0;          // balls bowled so far this frame
    this.rolls = [];               // pinfall per ball, flat, for scoreRolls()
    this.settleMs = 0;
  }

  /** Pins still standing. */
  standingCount() {
    return this.pins.reduce((n, p) => n + (p.standing ? 1 : 0), 0);
  }

  score() {
    return scoreRolls(this.rolls);
  }

  /** Swing with power 0..1. Returns the launch, or null if not ready to roll. */
  roll(power, aimOffset = this.aimOffset) {
    if (this.state !== 'aim') return null;
    const p = Math.max(0.12, Math.min(1, power));
    const speed = 6 + p * 9;
    this.ball = { x: 0, y: 0, z: 0, vx: Math.sin(aimOffset) * speed, vy: 0, vz: Math.cos(aimOffset) * speed };
    this.standingAtRollStart = this.standingCount();
    this.state = 'roll';
    this.settleMs = 0;
    this.onEvent({ type: 'roll', power: p, speed });
    return { speed };
  }

  /** Fell pins topple any standing neighbour within CHAIN_RADIUS — recursive. */
  knockPin(pin) {
    if (!pin.standing) return;
    pin.standing = false;
    this.onEvent({ type: 'pin-down', id: pin.id });
    for (const other of this.pins) {
      if (other.standing && Math.hypot(other.x - pin.x, other.z - pin.z) < CHAIN_RADIUS) {
        this.knockPin(other);
      }
    }
  }

  update(now, dt) {
    if (this.state !== 'roll') return;
    const b = this.ball;
    stepBall(b, dt, { gravity: 9.81, drag: 0 });
    groundBall(b, dt, { heightAt: () => 0, friction: 0.4, restitution: 0 });

    if (Math.abs(b.x) <= LANE.HALF_WIDTH) {
      for (const pin of this.pins) {
        if (pin.standing && Math.hypot(b.x - pin.x, b.z - pin.z) < PIN_RADIUS + BALL_RADIUS) {
          this.knockPin(pin);
        }
      }
    }

    const speed = Math.hypot(b.vx, b.vz);
    const past = b.z > HEADPIN_Z + 1.4 || Math.abs(b.x) > LANE.HALF_WIDTH + 0.6;
    if (past || speed < 0.06) {
      this.settleMs += dt * 1000;
      if (this.settleMs > 250) this.finishRoll();
    } else {
      this.settleMs = 0;
    }
  }

  finishRoll() {
    const standing = this.standingCount();
    const knocked = this.standingAtRollStart - standing;
    this.rolls.push(knocked);
    this.onEvent({ type: 'settled', pinsDown: knocked, standing, score: this.score() });
    this.advanceFrame(knocked);
  }

  advanceFrame(knocked) {
    this.ballInFrame += 1;
    const tenth = this.frameIndex === FRAMES - 1;

    if (!tenth) {
      if (this.ballInFrame === 1 && knocked === 10) { this.endFrame(); return; }
      if (this.ballInFrame === 2) { this.endFrame(); return; }
      this.state = 'aim';
      return;
    }

    // 10th frame: a strike or spare earns bonus ball(s), replacing the rack.
    if (this.ballInFrame === 1) {
      if (knocked === 10) this.pins = standardPins();
      this.state = 'aim';
      return;
    }
    if (this.ballInFrame === 2) {
      const first = this.rolls[this.rolls.length - 2];
      if (first === 10 || first + knocked === 10) {
        this.pins = standardPins();
        this.state = 'aim';
      } else {
        this.gameOver();
      }
      return;
    }
    this.gameOver();
  }

  endFrame() {
    this.frameIndex += 1;
    this.ballInFrame = 0;
    if (this.frameIndex >= FRAMES) { this.gameOver(); return; }
    this.pins = standardPins();
    this.state = 'aim';
    this.onEvent({ type: 'frame', frame: this.frameIndex, score: this.score() });
  }

  gameOver() {
    this.state = 'over';
    this.onEvent({ type: 'over', score: this.score() });
  }
}
