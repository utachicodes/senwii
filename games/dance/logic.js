/**
 * Dance Party — chart, judging and progression logic. No renderer, no DOM.
 *
 * A "chart" is a timed sequence of prompts (body left/right/up, face, phone
 * shake/swing/raise) aligned to a song's beat grid. The player performs the
 * move in a timing window around each prompt: Perfect / Good / Miss drive
 * score, combo and a final grade. Four songs ramp the BPM and the density so
 * clearing one (grade C or better) unlocks the next.
 *
 * Moves the camera/vision and phone layers can satisfy are declared per
 * prompt; judging is agnostic to *how* a move was detected — vision.js and
 * game.js just report which move kinds fired and when.
 */

export const MOVES = {
  BODY_LEFT:  { id: 'body-left',  label: 'Step Left',   icon: '⬅️', group: 'body' },
  BODY_RIGHT: { id: 'body-right', label: 'Step Right',  icon: '➡️', group: 'body' },
  BODY_UP:    { id: 'body-up',    label: 'Arms Up',     icon: '🙌', group: 'body' },
  FACE:       { id: 'face',       label: 'Face Move',   icon: '😄', group: 'face' },
  PHONE_SHAKE:{ id: 'phone-shake',label: 'Shake Phone', icon: '📳', group: 'phone' },
  PHONE_SWING:{ id: 'phone-swing',label: 'Swing Phone', icon: '📱', group: 'phone' },
  PHONE_RAISE:{ id: 'phone-raise',label: 'Raise Phone', icon: '☝️', group: 'phone' },
};

const M = MOVES;

export const SONGS = [
  {
    id: 'warmup', name: 'Warm Up', emoji: '🌤️', bpm: 92, bars: 16, order: 0,
    moves: [M.BODY_LEFT, M.BODY_RIGHT, M.PHONE_SHAKE],
    density: 0.55, doubleEvery: 0,
    desc: 'Easy groove — learn the steps.',
  },
  {
    id: 'sunny', name: 'Sunny Strut', emoji: '🌈', bpm: 108, bars: 20, order: 1,
    moves: [M.BODY_LEFT, M.BODY_RIGHT, M.BODY_UP, M.PHONE_SHAKE, M.PHONE_SWING],
    density: 0.7, doubleEvery: 8,
    desc: 'Pick up the pace, add arms and swings.',
  },
  {
    id: 'neon', name: 'Neon Pop', emoji: '🌃', bpm: 124, bars: 24, order: 2,
    moves: [M.BODY_LEFT, M.BODY_RIGHT, M.BODY_UP, M.FACE, M.PHONE_SHAKE, M.PHONE_SWING],
    density: 0.8, doubleEvery: 4,
    desc: 'Face the camera — smile or move your head!',
  },
  {
    id: 'finale', name: 'Finale', emoji: '🔥', bpm: 138, bars: 28, order: 3,
    moves: [M.BODY_LEFT, M.BODY_RIGHT, M.BODY_UP, M.FACE, M.PHONE_SHAKE, M.PHONE_SWING, M.PHONE_RAISE],
    density: 0.9, doubleEvery: 4,
    desc: 'Everything at once. Bring it home.',
  },
];

export const songById = (id) => SONGS.find((s) => s.id === id) || SONGS[0];

export const WINDOWS = { perfect: 110, good: 220 };   // ms either side of the beat
export const SCORES = { perfect: 300, good: 120, miss: 0 };

export function gradeFor(acc) {
  if (acc >= 0.95) return 'S';
  if (acc >= 0.85) return 'A';
  if (acc >= 0.7) return 'B';
  if (acc >= 0.5) return 'C';
  return 'D';
}
export const gradePassed = (g) => g === 'S' || g === 'A' || g === 'B' || g === 'C';

/** Deterministic PRNG for chart generation. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a note chart for a song. Notes land on beat subdivisions (quarters,
 * with occasional eighths on higher songs) chosen from the song's move set.
 * Returns [{t, moveId, hit, judge}] sorted by time (ms from song start).
 */
export function buildChart(song, seed = 1) {
  const rng = mulberry32(seed ^ (song.order * 2654435761));
  const beatMs = 60000 / song.bpm;
  const totalBeats = song.bars * 4;
  const notes = [];
  // Give the player 2 bars of intro before the first prompt.
  const introBeats = 8;
  for (let b = introBeats; b < totalBeats - 2; b += 1) {
    // place a note on this beat?
    if (rng() > song.density) continue;
    // occasional off-beat eighth on denser songs
    const off = song.density > 0.75 && rng() < 0.25 ? 0.5 : 0;
    const beat = b + off;
    const move = song.moves[Math.floor(rng() * song.moves.length)];
    notes.push({ t: beat * beatMs, moveId: move.id, label: move.label, icon: move.icon, group: move.group, hit: false, judge: null });
    // a quick follow-up (double) on some songs
    if (song.doubleEvery && beat % song.doubleEvery < 1 && rng() < 0.45) {
      const move2 = song.moves[Math.floor(rng() * song.moves.length)];
      if (move2.id !== move.id) {
        notes.push({ t: (beat + 0.5) * beatMs, moveId: move2.id, label: move2.label, icon: move2.icon, group: move2.group, hit: false, judge: null });
      }
    }
  }
  notes.sort((a, b) => a.t - b.t);
  // de-dupe notes that landed too close (within 180ms) — keep the first
  const filtered = [];
  for (const n of notes) {
    if (!filtered.length || n.t - filtered[filtered.length - 1].t >= 180) filtered.push(n);
  }
  return filtered;
}

export const songDurationMs = (song) => song.bars * 4 * (60000 / song.bpm);

// ── Session / judging ──────────────────────────────────────────────────────

export class DanceSession {
  constructor({ song, onEvent = () => {}, seed = 7, phoneOnly = false } = {}) {
    this.song = song;
    this.onEvent = onEvent;
    this.phoneOnly = phoneOnly;
    this.notes = buildChart(song, seed);
    // In phone-only mode drop body/face prompts (can't be satisfied).
    if (phoneOnly) {
      this.notes = this.notes.filter((n) => n.group === 'phone');
      // re-time sparsity is fine; keep them.
    }
    this.durationMs = songDurationMs(song);
    this.state = 'ready';        // ready | countdown | playing | finished
    this.startedAt = 0;
    this.nowMs = 0;
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.counts = { perfect: 0, good: 0, miss: 0 };
    this.mult = 1;
    this.recentMoves = new Map(); // moveId -> last-fired ms (performance clock)
  }

  start(now) {
    this.state = 'playing';
    this.startedAt = now;
    this.nowMs = 0;
    this.onEvent({ type: 'start' });
  }

  /** Report that the player performed a move kind at absolute time `now`. */
  perform(moveId, now) {
    if (this.state !== 'playing') return null;
    this.recentMoves.set(moveId, now);
    return this.tryHit(moveId, now);
  }

  /** Try to match the closest unhit, in-window note of this move. */
  tryHit(moveId, now) {
    const songMs = now - this.startedAt;
    let best = null;
    let bestDt = Infinity;
    for (const n of this.notes) {
      if (n.hit || n.moveId !== moveId) continue;
      const dt = Math.abs(songMs - n.t);
      if (dt <= WINDOWS.good && dt < bestDt) { best = n; bestDt = dt; }
    }
    if (!best) return null;
    const judge = bestDt <= WINDOWS.perfect ? 'perfect' : 'good';
    best.hit = true;
    best.judge = judge;
    this.counts[judge] += 1;
    this.combo += 1;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    this.mult = this.combo >= 20 ? 4 : this.combo >= 10 ? 3 : this.combo >= 5 ? 2 : 1;
    const gained = SCORES[judge] * this.mult;
    this.score += gained;
    this.onEvent({ type: 'hit', judge, moveId, note: best, gained, combo: this.combo });
    return judge;
  }

  /** Advance time: auto-miss notes whose window has passed. */
  update(now) {
    if (this.state !== 'playing') return;
    this.nowMs = now - this.startedAt;
    for (const n of this.notes) {
      if (n.hit) continue;
      if (this.nowMs > n.t + WINDOWS.good) {
        n.hit = true;
        n.judge = 'miss';
        this.counts.miss += 1;
        this.combo = 0;
        this.mult = 1;
        this.onEvent({ type: 'miss', note: n });
      }
    }
    // song ends a little after the last bar so trailing notes can resolve
    if (this.nowMs > this.durationMs + 600) this.finish();
  }

  finish() {
    if (this.state === 'finished') return;
    // anything still unresolved counts as a miss
    for (const n of this.notes) {
      if (!n.hit) { n.hit = true; n.judge = 'miss'; this.counts.miss += 1; }
    }
    this.state = 'finished';
    const total = this.notes.length || 1;
    const acc = (this.counts.perfect + this.counts.good * 0.6) / total;
    const grade = gradeFor(acc);
    this.onEvent({
      type: 'finish', score: this.score, grade, acc, counts: { ...this.counts },
      maxCombo: this.maxCombo, passed: gradePassed(grade),
    });
  }

  /** Notes near the play head (for the renderer). */
  visibleNotes(windowBefore = 1800, windowAfter = 300) {
    return this.notes.filter((n) => n.t >= this.nowMs - windowAfter && n.t <= this.nowMs + windowBefore);
  }
}

// ── Persistence ────────────────────────────────────────────────────────────

const SAVE_KEY = 'senwii.dance.v1';
export function loadDanceSave() {
  try {
    const raw = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}');
    return {
      unlocked: Math.max(1, raw.unlocked || 1),
      best: raw.best || {},       // songId -> { score, grade }
    };
  } catch {
    return { unlocked: 1, best: {} };
  }
}
export function persistDanceSave(save) {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch { /* ignore */ }
}
