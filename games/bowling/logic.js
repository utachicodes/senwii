import { stepBall, groundBall } from '../shared/ball.js';

/**
 * Bowling — ten-pin logic with hand-movement delivery and lane patterns.
 * No renderer, no DOM.
 *
 * The player aims, then delivers with a real hand motion: swing speed sets
 * power, and the sideways component at release imparts hook (spin) so the
 * ball curves down the lane — the same reading a bowler gives the ball. Three
 * lane patterns (house / sport / challenge) change the oil, so hook bites
 * differently and a clean line is its own puzzle.
 *
 * Pinfall is momentum-based: the ball knocks the pins it meets, and a felled
 * pin carries that momentum into its neighbours (a chain). `standing` flips
 * false the moment a pin is struck, so scoring reads the rack instantly and
 * deterministically; the renderer animates the topple from the impact data
 * stashed on each pin (`fallDir`, `fallAxis`, `impact`).
 *
 * Scoring is the standard rolling ten-pin algorithm over a flat rolls[] list,
 * which is exactly what a scoreboard tracks.
 */

export const LANE = { LENGTH: 18, HALF_WIDTH: 0.53 };
export const PIN_RADIUS = 0.06;
export const BALL_RADIUS = 0.13;
export const CHAIN_RADIUS = 0.33;     // a felled pin can topple a neighbour this close
export const HEADPIN_Z = LANE.LENGTH - 2.2;
export const ROW_STEP = 0.305;        // depth between pin rows
export const FRAMES = 10;

// Three oil patterns — "levels". House hooks easily (forgiving), sport rewards
// a clean read, challenge is slick and punishes a lazy release.
export const PATTERNS = [
  { id: 'house', name: 'House', emoji: '🏠', hookMult: 1.25, friction: 0.38, desc: 'Friendly oil — the ball grips and hooks easily.', unlockAt: 0 },
  { id: 'sport', name: 'Sport', emoji: '🎯', hookMult: 0.9, friction: 0.3, desc: 'Flatter pattern — you earn the hook.', unlockAt: 80 },
  { id: 'challenge', name: 'Challenge', emoji: '🔥', hookMult: 0.6, friction: 0.22, desc: 'Slick and tight — precision or the gutter.', unlockAt: 140 },
];

export const patternById = (id) => PATTERNS.find((p) => p.id === id) || PATTERNS[0];

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
      pins.push({
        id: id++,
        x: -width / 2 + i * ROW_STEP,
        z,
        standing: true,
        // Impact/animation state — filled when the pin is struck.
        vx: 0, vz: 0,
        fallDir: 1,
        fallAxis: 0,
        impact: 0,
      });
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

/** Per-frame marks for a scoreboard: 'X', '7/', '9-', numbers, or null. */
export function frameCards(rolls) {
  const cards = [];
  let i = 0;
  for (let f = 0; f < FRAMES; f += 1) {
    if (rolls[i] === undefined) { cards.push({ marks: [null, null, null], total: null }); continue; }
    const tenth = f === FRAMES - 1;
    if (!tenth) {
      if (rolls[i] === 10) {
        cards.push({ marks: ['X', null, null], i });
        i += 1;
      } else if (rolls[i + 1] === undefined) {
        cards.push({ marks: [String(rolls[i]), null, null], i });
        i += 1;
      } else {
        const a = rolls[i];
        const b = rolls[i + 1];
        cards.push({ marks: [String(a === 0 ? '-' : a), a + b === 10 ? '/' : String(b === 0 ? '-' : b), null], i });
        i += 2;
      }
    } else {
      // 10th: up to three balls, mark strikes and spares in place.
      const m = [null, null, null];
      const r = [rolls[i], rolls[i + 1], rolls[i + 2]];
      if (r[0] !== undefined) m[0] = r[0] === 10 ? 'X' : String(r[0] === 0 ? '-' : r[0]);
      if (r[1] !== undefined) {
        if (r[0] === 10) m[1] = r[1] === 10 ? 'X' : String(r[1] === 0 ? '-' : r[1]);
        else m[1] = r[0] + r[1] === 10 ? '/' : String(r[1] === 0 ? '-' : r[1]);
      }
      if (r[2] !== undefined) {
        if (r[0] === 10 && r[1] !== 10) m[2] = r[1] + r[2] === 10 ? '/' : String(r[2] === 0 ? '-' : r[2]);
        else m[2] = r[2] === 10 ? 'X' : String(r[2] === 0 ? '-' : r[2]);
      }
      cards.push({ marks: m, i });
      i += 3;
    }
  }
  // running totals (only where the frame's bonus balls are known)
  let total = 0;
  let j = 0;
  for (let f = 0; f < FRAMES; f += 1) {
    if (rolls[j] === undefined) break;
    if (rolls[j] === 10) {
      if (rolls[j + 1] === undefined || rolls[j + 2] === undefined) break;
      total += 10 + rolls[j + 1] + rolls[j + 2];
      cards[f].total = total;
      j += 1;
    } else if ((rolls[j] || 0) + (rolls[j + 1] || 0) === 10) {
      if (rolls[j + 2] === undefined) break;
      total += 10 + rolls[j + 2];
      cards[f].total = total;
      j += 2;
    } else {
      if (rolls[j + 1] === undefined) break;
      total += (rolls[j] || 0) + rolls[j + 1];
      cards[f].total = total;
      j += 2;
    }
  }
  return cards;
}

// Simple best-score persistence per pattern.
const SAVE_KEY = 'senwii.bowling.v1';
export function loadBowlSave() {
  try {
    const raw = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}');
    return { best: raw.best || {}, unlocked: Math.max(1, raw.unlocked || 1) };
  } catch {
    return { best: {}, unlocked: 1 };
  }
}
export function persistBowlSave(save) {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch { /* ignore */ }
}

export class Game {
  constructor({ onEvent = () => {}, pattern = 0, animateSweep = false } = {}) {
    this.onEvent = onEvent;
    this.patternIndex = typeof pattern === 'number' ? pattern : Math.max(0, PATTERNS.findIndex((p) => p.id === pattern));
    this.pattern = PATTERNS[this.patternIndex] || PATTERNS[0];
    this.animateSweep = animateSweep;   // renderer opts in; logic/tests stay synchronous
    this.state = 'aim';            // aim | roll | sweep | over
    this.pins = standardPins();
    this.standingAtRollStart = 10;
    this.ball = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, spin: 0 };
    this.aimOffset = 0;            // radians, left/right of straight down the lane
    this.frameIndex = 0;           // 0..9
    this.ballInFrame = 0;          // balls bowled so far this frame
    this.rolls = [];               // pinfall per ball, flat, for scoreRolls()
    this.settleMs = 0;
    this.sweepMs = 0;
    this.sweepKind = 'clear';      // clear | reset
  }

  /** Pins still standing. */
  standingCount() {
    return this.pins.reduce((n, p) => n + (p.standing ? 1 : 0), 0);
  }

  score() {
    return scoreRolls(this.rolls);
  }

  /**
   * Deliver the ball. `power` 0..1 from swing speed, `spin` is the hook
   * imparted by the hand's sideways motion at release (−1..1, + = hooks right
   * for a right-hand release feel, i.e. curves in the +x direction initially).
   * Returns the launch, or null if not ready to roll.
   */
  roll(power, aimOffset = this.aimOffset, spin = 0) {
    if (this.state !== 'aim') return null;
    const p = Math.max(0.12, Math.min(1, power));
    const s = Math.max(-1, Math.min(1, spin));
    const speed = 6 + p * 9;
    this.ball = {
      x: 0, y: 0, z: 0,
      vx: Math.sin(aimOffset) * speed,
      vy: 0,
      vz: Math.cos(aimOffset) * speed,
      spin: s,
    };
    this.standingAtRollStart = this.standingCount();
    this.state = 'roll';
    this.settleMs = 0;
    this.onEvent({ type: 'roll', power: p, speed, spin: s });
    return { speed, spin: s };
  }

  /**
   * Strike a pin: mark it down for scoring immediately, record the impact for
   * the renderer, and carry momentum into neighbours (a chain reaction). The
   * impulse comes from the ball or the pin that hit this one.
   */
  knockPin(pin, impulseX = 0, impulseZ = 0, depth = 0) {
    if (!pin.standing) return;
    pin.standing = false;
    // Topple away from the impact: fall axis is perpendicular to the impulse.
    const mag = Math.hypot(impulseX, impulseZ) || 1;
    pin.vx = impulseX;
    pin.vz = impulseZ;
    pin.impact = mag;
    pin.fallAxis = Math.atan2(impulseZ, impulseX);
    // sign: +1 falls "with" the impulse
    pin.fallDir = 1;
    this.onEvent({ type: 'pin-down', id: pin.id, impulse: mag });
    if (depth > 3) return;              // safety cap on cascades
    for (const other of this.pins) {
      if (!other.standing) continue;
      const dx = other.x - pin.x;
      const dz = other.z - pin.z;
      const d = Math.hypot(dx, dz);
      if (d < CHAIN_RADIUS && d > 1e-6) {
        // Carry a fraction of the impulse forward, biased along the contact.
        const nx = dx / d;
        const nz = dz / d;
        const carry = mag * 0.55;
        this.knockPin(other, nx * carry + impulseX * 0.15, nz * carry + impulseZ * 0.15, depth + 1);
      }
    }
  }

  update(now, dt) {
    if (this.state === 'sweep') {
      this.sweepMs += dt * 1000;
      if (this.sweepMs > 750) this.endSweep();
      return;
    }
    if (this.state !== 'roll') return;
    const b = this.ball;
    const pat = this.pattern;

    stepBall(b, dt, { gravity: 9.81, drag: 0 });
    groundBall(b, dt, { heightAt: () => 0, friction: pat.friction, restitution: 0 });

    // Hook: side spin curves the ball. The hook "reads" the lane more as the
    // ball slows (skid → hook → roll), so scale gently by (1 - speed fraction)
    // and by the pattern's oil. Spin bleeds off as it drives the curve.
    if (Math.abs(b.x) <= LANE.HALF_WIDTH && b.z < HEADPIN_Z - 0.4) {
      const speed = Math.hypot(b.vx, b.vz);
      const grip = 0.35 + 0.65 * Math.max(0, 1 - speed / 15);  // more bite as it slows
      const hook = b.spin * pat.hookMult * grip * 3.2;
      b.vx += hook * dt;
      b.spin *= Math.max(0, 1 - 0.35 * dt);
    }

    if (Math.abs(b.x) <= LANE.HALF_WIDTH) {
      for (const pin of this.pins) {
        if (!pin.standing) continue;
        if (Math.hypot(b.x - pin.x, b.z - pin.z) < PIN_RADIUS + BALL_RADIUS) {
          // Impulse from the ball's velocity toward the pin.
          const dx = pin.x - b.x;
          const dz = pin.z - b.z;
          const d = Math.hypot(dx, dz) || 1;
          const sp = Math.hypot(b.vx, b.vz);
          this.knockPin(pin, (dx / d) * sp * 0.6 + b.vx * 0.25, (dz / d) * sp * 0.6 + b.vz * 0.25);
          // The ball loses a little energy through the rack.
          b.vx *= 0.94;
          b.vz *= 0.94;
        }
      }
    }

    const speed = Math.hypot(b.vx, b.vz);
    const past = b.z > HEADPIN_Z + 1.6 || Math.abs(b.x) > LANE.HALF_WIDTH + 0.6;
    if (past || speed < 0.06) {
      this.settleMs += dt * 1000;
      if (this.settleMs > 280) this.finishRoll();
    } else {
      this.settleMs = 0;
    }
  }

  finishRoll() {
    const standing = this.standingCount();
    const knocked = this.standingAtRollStart - standing;
    this.rolls.push(knocked);
    this.onEvent({ type: 'settled', pinsDown: knocked, standing, score: this.score() });
    this.planAdvance(knocked);
  }

  /** Decide what happens next, but route through a sweep animation first. */
  planAdvance(knocked) {
    this.ballInFrame += 1;
    const tenth = this.frameIndex === FRAMES - 1;

    if (!tenth) {
      if (this.ballInFrame === 1 && knocked === 10) { this.beginSweep('reset', { endFrame: true }); return; }
      if (this.ballInFrame === 2) { this.beginSweep('reset', { endFrame: true }); return; }
      // second ball of the frame: clear only the fallen pins, keep survivors
      this.beginSweep('clear', { endFrame: false });
      return;
    }

    // 10th frame: strike/spare earns bonus ball(s) with a fresh rack.
    if (this.ballInFrame === 1) {
      if (knocked === 10) this.beginSweep('reset', { endFrame: false });
      else this.beginSweep('clear', { endFrame: false });
      return;
    }
    if (this.ballInFrame === 2) {
      const first = this.rolls[this.rolls.length - 2];
      if (first === 10 || first + knocked === 10) {
        this.beginSweep('reset', { endFrame: false });
      } else {
        this.gameOver();
      }
      return;
    }
    this.gameOver();
  }

  beginSweep(kind, { endFrame }) {
    this.pendingEndFrame = endFrame;
    this.sweepKind = kind;
    this.sweepMs = 0;
    if (!this.animateSweep) {
      this.endSweep();
      return;
    }
    this.state = 'sweep';
    this.onEvent({ type: 'sweep', kind });
  }

  endSweep() {
    if (this.sweepKind === 'reset') {
      this.pins = standardPins();
    } else {
      // clear: remove fallen pins, survivors stay for the next ball
      this.pins = this.pins.filter((p) => p.standing);
    }
    if (this.pendingEndFrame) {
      this.endFrame();
    } else {
      this.state = 'aim';
    }
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
    this.onEvent({ type: 'over', score: this.score(), pattern: this.pattern.id });
  }
}
