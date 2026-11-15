/**
 * Boxing — duel logic. No renderer, no DOM.
 *
 * Structurally the same contract as swordplay's Duel (openings during
 * windup/recover, guard must be held, not swung, to block) but the guard
 * geometry is swapped for something that actually fits a punch: two zones,
 * HIGH (head) and LOW (body), read straight off the phone's pitch rather
 * than a continuous blade angle. A completed swing is thrown at whichever
 * zone its vertical component pointed toward; the opponent's guard (and the
 * player's own) blocks only when it's actually held over that zone.
 *
 * First to WIN_POINTS clean punches lands wins. All randomness injected.
 */

export const WIN_POINTS = 3;
export const ZONE = { HIGH: 'high', LOW: 'low' };

export const AI = {
  NEUTRAL: 'neutral',
  WINDUP: 'windup',
  STRIKE: 'strike',
  RECOVER: 'recover',
};

/** A completed SwingDetector gesture → which zone it was thrown at. */
export function zoneOfSwing(sw) {
  return sw.vy < 0 ? ZONE.HIGH : ZONE.LOW;
}

export class Bout {
  constructor({ onEvent = () => {}, rng = Math.random, difficulty = 0.5 } = {}) {
    this.onEvent = onEvent;
    this.rng = rng;
    this.difficulty = difficulty;

    this.state = 'ready';          // ready | fighting | point | over
    this.player = { points: 0 };
    this.ai = { points: 0 };
    this.winner = null;

    this.guardZone = ZONE.HIGH;    // held continuously from the phone's pitch
    this.guarding = true;          // false mid-swing — a swing can't also guard

    this.aiState = AI.NEUTRAL;
    this.aiUntil = 0;
    this.aiGuardZone = ZONE.HIGH;
    this.aiStrikeZone = ZONE.HIGH;
    this.pauseUntil = 0;
  }

  start(now) {
    this.state = 'fighting';
    this.player.points = 0;
    this.ai.points = 0;
    this.winner = null;
    this.aiState = AI.NEUTRAL;
    this.aiUntil = now + 800;
    this.onEvent({ type: 'start' });
  }

  /** Continuous guard update from the phone's pitch (and whether it's mid-swing). */
  setGuard(zone, swinging) {
    this.guardZone = zone;
    this.guarding = !swinging;
  }

  /** A completed player swing from the SwingDetector. */
  punch(sw, now) {
    if (this.state !== 'fighting') return;
    const zone = zoneOfSwing(sw);
    this.onEvent({ type: 'player-punch', zone });

    const open = this.aiState === AI.WINDUP || this.aiState === AI.RECOVER;
    const blocked = !open && this.aiGuardZone === zone;
    if (blocked) {
      this.onEvent({ type: 'blocked', who: 'ai', zone });
      return;
    }
    this.scorePoint('player', now);
  }

  scorePoint(who, now) {
    this[who].points += 1;
    this.onEvent({ type: 'point', who, player: this.player.points, ai: this.ai.points });
    if (this[who].points >= WIN_POINTS) {
      this.state = 'over';
      this.winner = who;
      this.onEvent({ type: 'over', winner: who });
      return;
    }
    this.state = 'point';
    this.pauseUntil = now + 1300;
    this.aiState = AI.NEUTRAL;
  }

  update(now, dt) {
    if (this.state === 'point' && now >= this.pauseUntil) {
      this.state = 'fighting';
      this.aiState = AI.NEUTRAL;
      this.aiUntil = now + 650;
      this.onEvent({ type: 'resume' });
    }
    if (this.state !== 'fighting') return;
    void dt;

    if (now < this.aiUntil) return;

    switch (this.aiState) {
      case AI.NEUTRAL: {
        if (this.rng() < 0.45 + this.difficulty * 0.2) {
          this.aiStrikeZone = this.rng() < 0.5 ? ZONE.HIGH : ZONE.LOW;
          this.aiState = AI.WINDUP;
          this.aiUntil = now + 850 - this.difficulty * 300;
          this.onEvent({ type: 'ai-windup', zone: this.aiStrikeZone, untilMs: this.aiUntil });
        } else {
          this.aiGuardZone = this.rng() < 0.5 ? ZONE.HIGH : ZONE.LOW;
          this.aiUntil = now + 450 + this.rng() * 500;
        }
        break;
      }
      case AI.WINDUP: {
        this.aiState = AI.STRIKE;
        this.aiUntil = now + 140;
        const blocked = this.guarding && this.guardZone === this.aiStrikeZone;
        if (blocked) {
          this.onEvent({ type: 'blocked', who: 'player', zone: this.aiStrikeZone });
        } else {
          this.onEvent({ type: 'ai-hit', zone: this.aiStrikeZone });
          this.scorePoint('ai', now);
          return;
        }
        break;
      }
      case AI.STRIKE: {
        this.aiState = AI.RECOVER;
        this.aiUntil = now + 600 - this.difficulty * 220;
        break;
      }
      case AI.RECOVER:
      default: {
        this.aiState = AI.NEUTRAL;
        this.aiUntil = now + 280;
        break;
      }
    }
  }
}
