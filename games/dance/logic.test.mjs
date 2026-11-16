import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SONGS, MOVES, WINDOWS, SCORES, buildChart, songDurationMs, DanceSession,
  gradeFor, gradePassed, loadDanceSave, persistDanceSave,
} from './logic.js';

const beatMs = (song) => 60000 / song.bpm;

// A hand-built session: replace the generated chart with known notes.
function sessionWith(notes, song = SONGS[0]) {
  const events = [];
  const s = new DanceSession({ song, onEvent: (e) => events.push(e) });
  s.notes = notes.map(([t, moveId]) => ({ t, moveId, hit: false, judge: null }));
  s.start(0);
  return { s, events };
}

// ── Chart generation ──────────────────────────────────────────────────────
test('buildChart is deterministic for a seed and varies across seeds', () => {
  for (const song of SONGS) {
    assert.deepEqual(buildChart(song, 42), buildChart(song, 42));
  }
  const a = JSON.stringify(buildChart(SONGS[3], 1));
  const b = JSON.stringify(buildChart(SONGS[3], 2));
  assert.notEqual(a, b);
});

test('chart notes are sorted with at least 180ms between them', () => {
  for (const song of SONGS) {
    for (let seed = 1; seed < 40; seed += 1) {
      const notes = buildChart(song, seed);
      assert.ok(notes.length > 0, `${song.id} seed ${seed} has notes`);
      for (let i = 1; i < notes.length; i += 1) {
        assert.ok(notes[i].t - notes[i - 1].t >= 180, `${song.id} seed ${seed} note ${i}`);
      }
    }
  }
});

test('notes sit after the 2-bar intro and before the song ends', () => {
  for (const song of SONGS) {
    for (let seed = 1; seed < 40; seed += 1) {
      for (const n of buildChart(song, seed)) {
        assert.ok(n.t >= 8 * beatMs(song), `${song.id}: ${n.t} in intro`);
        assert.ok(n.t <= (song.bars * 4 - 2) * beatMs(song), `${song.id}: ${n.t} in outro`);
        assert.ok(n.t + WINDOWS.good < songDurationMs(song) + 600, 'resolvable before finish');
      }
    }
  }
});

test('charts only use the song\'s own moves, with icon names (not emoji)', () => {
  const iconNames = new Set(Object.values(MOVES).map((m) => m.icon));
  for (const m of Object.values(MOVES)) assert.match(m.icon, /^[a-z-]+$/);
  for (const song of SONGS) {
    assert.match(song.icon, /^[a-z-]+$/);
    const allowed = new Set(song.moves.map((m) => m.id));
    for (let seed = 1; seed < 20; seed += 1) {
      for (const n of buildChart(song, seed)) {
        assert.ok(allowed.has(n.moveId), `${song.id} uses ${n.moveId}`);
        assert.ok(iconNames.has(n.icon));
      }
    }
  }
});

test('phone-only sessions keep only phone notes', () => {
  const s = new DanceSession({ song: SONGS[3], seed: 9, phoneOnly: true });
  assert.ok(s.notes.length > 0);
  assert.ok(s.notes.every((n) => n.group === 'phone'));
});

// ── Judging windows ───────────────────────────────────────────────────────
test('perfect / good / miss window boundaries', () => {
  const t = 5000;
  const cases = [
    [0, 'perfect'], [WINDOWS.perfect, 'perfect'], [-WINDOWS.perfect, 'perfect'],
    [WINDOWS.perfect + 1, 'good'], [-(WINDOWS.perfect + 1), 'good'],
    [WINDOWS.good, 'good'], [-WINDOWS.good, 'good'],
    [WINDOWS.good + 1, null], [-(WINDOWS.good + 1), null],
  ];
  for (const [off, want] of cases) {
    const { s } = sessionWith([[t, 'body-left']]);
    assert.equal(s.perform('body-left', t + off), want, `offset ${off}`);
  }
});

test('a note auto-misses only once its good window has passed', () => {
  const { s, events } = sessionWith([[1000, 'face']]);
  s.update(1000 + WINDOWS.good);
  assert.equal(s.counts.miss, 0);
  s.update(1000 + WINDOWS.good + 1);
  assert.equal(s.counts.miss, 1);
  assert.equal(events.filter((e) => e.type === 'miss').length, 1);
  s.update(3000);
  assert.equal(s.counts.miss, 1, 'not missed twice');
});

test('overlapping notes: the closest one is hit', () => {
  const { s } = sessionWith([[1000, 'body-up'], [1300, 'body-up']]);
  assert.equal(s.perform('body-up', 1250), 'perfect');
  assert.equal(s.notes[1].hit, true);
  assert.equal(s.notes[0].hit, false);
});

test('a wrong move is a no-op and a note cannot be hit twice', () => {
  const { s } = sessionWith([[1000, 'body-left']]);
  assert.equal(s.perform('body-right', 1000), null);
  assert.equal(s.combo, 0);
  assert.equal(s.notes[0].hit, false);
  assert.equal(s.perform('body-left', 1000), 'perfect');
  assert.equal(s.perform('body-left', 1010), null);
  assert.equal(s.counts.perfect, 1);
  assert.equal(s.score, SCORES.perfect);
});

test('moves before start / after finish are ignored', () => {
  const s = new DanceSession({ song: SONGS[0] });
  assert.equal(s.perform('body-left', 0), null);
  s.start(0);
  s.finish();
  assert.equal(s.perform('body-left', 0), null);
});

// ── Combo / multiplier ────────────────────────────────────────────────────
test('multiplier steps at 5 / 10 / 20 combo and resets on a miss', () => {
  const notes = Array.from({ length: 22 }, (_, i) => [1000 + i * 500, 'phone-shake']);
  const { s } = sessionWith(notes);
  const mults = [];
  let expectScore = 0;
  for (let i = 0; i < 21; i += 1) {
    s.perform('phone-shake', notes[i][0]);
    mults.push(s.mult);
    expectScore += SCORES.perfect * s.mult;
  }
  assert.deepEqual(mults.slice(0, 4), [1, 1, 1, 1]);
  assert.equal(mults[4], 2);   // combo 5
  assert.equal(mults[8], 2);   // combo 9
  assert.equal(mults[9], 3);   // combo 10
  assert.equal(mults[18], 3);  // combo 19
  assert.equal(mults[19], 4);  // combo 20
  assert.equal(s.score, expectScore);
  assert.equal(s.maxCombo, 21);
  s.update(notes[21][0] + WINDOWS.good + 1);   // miss the last
  assert.equal(s.combo, 0);
  assert.equal(s.mult, 1);
  assert.equal(s.maxCombo, 21);
});

// ── Finish / grading ──────────────────────────────────────────────────────
test('finish fires once, counts leftovers as misses, accuracy weights good at 0.6', () => {
  const { s, events } = sessionWith([
    [1000, 'body-left'], [2000, 'body-left'], [3000, 'body-left'], [4000, 'body-left'], [5000, 'body-left'],
  ]);
  s.perform('body-left', 1000);                        // perfect
  s.perform('body-left', 2000 + WINDOWS.perfect + 50); // good
  s.update(s.durationMs + 601);                        // rest auto-miss + finish
  s.finish();
  s.update(s.durationMs + 5000);
  const fin = events.filter((e) => e.type === 'finish');
  assert.equal(fin.length, 1);
  assert.equal(s.state, 'finished');
  assert.deepEqual(fin[0].counts, { perfect: 1, good: 1, miss: 3 });
  assert.ok(Math.abs(fin[0].acc - (1 + 0.6) / 5) < 1e-9);
  assert.equal(fin[0].grade, 'D');
  assert.equal(fin[0].passed, false);
});

test('an empty chart finishes with accuracy 0 rather than NaN', () => {
  const { s, events } = sessionWith([]);
  s.finish();
  assert.equal(events.at(-1).acc, 0);
});

test('gradeFor boundaries and gradePassed', () => {
  assert.equal(gradeFor(1), 'S');
  assert.equal(gradeFor(0.95), 'S');
  assert.equal(gradeFor(0.9499), 'A');
  assert.equal(gradeFor(0.85), 'A');
  assert.equal(gradeFor(0.8499), 'B');
  assert.equal(gradeFor(0.7), 'B');
  assert.equal(gradeFor(0.6999), 'C');
  assert.equal(gradeFor(0.5), 'C');
  assert.equal(gradeFor(0.4999), 'D');
  assert.equal(gradeFor(0), 'D');
  for (const g of ['S', 'A', 'B', 'C']) assert.equal(gradePassed(g), true);
  assert.equal(gradePassed('D'), false);
});

// ── Persistence ───────────────────────────────────────────────────────────
function withStorage(value, fn) {
  const store = new Map();
  if (value !== undefined) store.set('senwii.dance.v1', value);
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  try { return fn(store); } finally { delete globalThis.localStorage; }
}

test('loadDanceSave without localStorage returns defaults', () => {
  assert.equal(typeof globalThis.localStorage, 'undefined');
  assert.deepEqual(loadDanceSave(), { unlocked: 1, best: {} });
  persistDanceSave({ unlocked: 2, best: {} });   // must not throw
});

test('loadDanceSave handles missing and corrupt data', () => {
  const defaults = { unlocked: 1, best: {} };
  for (const raw of [undefined, '', '{not json', 'null', '5', '[]', '"x"',
    '{"unlocked":"abc"}', '{"unlocked":-3,"best":[1,2]}', '{"unlocked":null,"best":"no"}']) {
    withStorage(raw, () => assert.deepEqual(loadDanceSave(), defaults, `raw ${raw}`));
  }
  withStorage('{"unlocked":99}', () => assert.equal(loadDanceSave().unlocked, SONGS.length));
  withStorage('{"unlocked":2.7}', () => assert.equal(loadDanceSave().unlocked, 2));
});

test('save round-trips through localStorage', () => {
  withStorage(undefined, () => {
    const save = { unlocked: 3, best: { warmup: { score: 1200, grade: 'A' } } };
    persistDanceSave(save);
    assert.deepEqual(loadDanceSave(), save);
  });
});
