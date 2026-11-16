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
export const CHAIN_REACH = 0.62;      // a flying pin can reach a neighbour this far away
export const TOPPLE_IMPULSE = 1.6;    // impulse (m/s-ish) needed to knock a pin over
export const PIN_CARRY = 0.56;        // share of a pin's momentum passed down a chain link
export const HEADPIN_Z = LANE.LENGTH - 2.2;
export const ROW_STEP = 0.305;        // depth between pin rows
export const FRAMES = 10;
export const HOOK_ACCEL = 1.1;        // m/s² of side force per unit spin at full grip

// Three oil patterns — "levels". House hooks easily (forgiving), sport rewards
// a clean read, challenge is slick and punishes a lazy release.
export const PATTERNS = [
  { id: 'house', name: 'House', icon: 'house', hookMult: 1.25, friction: 0.14, desc: 'Friendly oil — the ball grips and hooks easily.', unlockAt: 0 },
  { id: 'sport', name: 'Sport', icon: 'target', hookMult: 0.9, friction: 0.11, desc: 'Flatter pattern — you earn the hook.', unlockAt: 80 },
  { id: 'challenge', name: 'Challenge', icon: 'flame', hookMult: 0.6, friction: 0.08, desc: 'Slick and tight — precision or the gutter.', unlockAt: 140 },
];

export const patternById = (id) => PATTERNS.find((p) => p.id === id) || PATTERNS[0];

/**
 * Where a delivery would go: a ghost roll of the real physics, sampled from
 * the foul line to just short of the headpin. Feeds the renderer's preview
 * arc so the line it draws is the line the ball takes.
 */
export function previewPath(pattern, aimOffset, spin = 0, power = 0.7, every = 4) {
  const g = new Game({ pattern });
  g.pins = [];                                   // a clear lane: path only
  g.roll(power, aimOffset, spin);
  const pts = [{ x: 0, z: 0 }];
  for (let i = 1; i < 2000 && g.state === 'roll'; i += 1) {
    g.update(0, 0.016);
    if (g.state !== 'roll' || g.ball.z > HEADPIN_Z - 0.3 || Math.abs(g.ball.x) > LANE.HALF_WIDTH) {
      pts.push({ x: g.ball.x, z: g.ball.z });
      break;
    }
    if (i % every === 0) pts.push({ x: g.ball.x, z: g.ball.z });
  }
  return pts;
}

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
    // Inputs come straight off a phone's sensors: sanitize, never trust.
    const p = Number.isFinite(power) ? Math.max(0.12, Math.min(1, power)) : 0.5;
    const s = Number.isFinite(spin) ? Math.max(-1, Math.min(1, spin)) : 0;
    if (!Number.isFinite(aimOffset)) aimOffset = 0;
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
   * Strike a pin with impulse (impulseX, impulseZ). Too soft and it only
   * wobbles; otherwise it goes down (scored immediately), the impact is
   * recorded for the renderer, and the pin flies on, carrying part of its
   * momentum into the neighbours it is heading toward. Each link of the
   * chain passes on less (PIN_CARRY × alignment × distance falloff), so a
   * weak or glancing hit dies out after a pin or two while a pocket hit with
   * pace carries through the rack.
   */
  knockPin(pin, impulseX = 0, impulseZ = 0, depth = 0) {
    if (!pin.standing) return;
    const mag = Math.hypot(impulseX, impulseZ);
    if (!(mag >= TOPPLE_IMPULSE)) return;      // also rejects NaN
    pin.standing = false;
    pin.vx = impulseX;
    pin.vz = impulseZ;
    pin.impact = mag;
    // Topple away from the impact: the renderer tips it along this heading.
    pin.fallAxis = Math.atan2(impulseZ, impulseX);
    pin.fallDir = 1;
    this.onEvent({ type: 'pin-down', id: pin.id, impulse: mag });
    if (depth > 8) return;              // safety cap; decay ends chains long before
    const ux = impulseX / mag;
    const uz = impulseZ / mag;
    for (const other of this.pins) {
      if (!other.standing) continue;
      const dx = other.x - pin.x;
      const dz = other.z - pin.z;
      const d = Math.hypot(dx, dz);
      if (d >= CHAIN_REACH || d < 1e-6) continue;
      const nx = dx / d;
      const nz = dz / d;
      const align = nx * ux + nz * uz;  // is the flying pin headed that way?
      if (align <= 0.25) continue;
      const transfer = mag * PIN_CARRY * align * (1 - (d / CHAIN_REACH) ** 2);
      // Contact pushes along the line of centres, plus a little carry-through.
      this.knockPin(other, (nx * 0.75 + ux * 0.25) * transfer, (nz * 0.75 + uz * 0.25) * transfer, depth + 1);
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
      const hook = b.spin * pat.hookMult * grip * HOOK_ACCEL;
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
          // A 7kg ball into a 1.5kg pin: the pin leaves faster than the ball
          // arrived, mostly along the line of centres.
          const ix = (dx / d) * sp * 1.1 + b.vx * 0.3;
          const iz = (dz / d) * sp * 1.1 + b.vz * 0.3;
          // Even a crawling ball tips a pin it leans on.
          const m = Math.hypot(ix, iz) || 1;
          const k = Math.max(1, (TOPPLE_IMPULSE * 1.05) / m);
          this.knockPin(pin, ix * k, iz * k);
          // The ball loses a little pace and deflects off the pin.
          b.vx = b.vx * 0.93 - (dx / d) * sp * 0.06;
          b.vz *= 0.93;
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
    // A strike clears a full rack with one ball; a spare clears what was left
    // of one. This holds in every frame, the 10th's bonus balls included.
    const fullRack = this.standingAtRollStart === 10;
    const strike = fullRack && standing === 0;
    const spare = !fullRack && standing === 0 && this.standingAtRollStart > 0;
    this.onEvent({
      type: 'settled', pinsDown: knocked, standing, score: this.score(),
      strike, spare, frame: this.frameIndex, ball: this.ballInFrame + 1,
    });
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
      if (first === 10 && knocked === 10) this.beginSweep('reset', { endFrame: false });  // X X → fresh rack
      else if (first === 10) this.beginSweep('clear', { endFrame: false });              // X 7 → bonus at the 3 left
      else if (first + knocked === 10) this.beginSweep('reset', { endFrame: false });     // spare → fresh rack
      else this.gameOver();
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
      this.resetBall();
      this.state = 'aim';
    }
  }

  endFrame() {
    this.frameIndex += 1;
    this.ballInFrame = 0;
    if (this.frameIndex >= FRAMES) { this.gameOver(); return; }
    this.pins = standardPins();
    this.resetBall();
    this.state = 'aim';
    this.onEvent({ type: 'frame', frame: this.frameIndex, score: this.score() });
  }

  /** Back on the approach for the next delivery. */
  resetBall() {
    this.ball = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, spin: 0 };
  }

  gameOver() {
    this.state = 'over';
    this.onEvent({ type: 'over', score: this.score(), pattern: this.pattern.id });
  }
}
