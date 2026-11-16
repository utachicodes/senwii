/**
 * A tiny beat-driven synth backing track for Dance Party.
 *
 * Uses the shared AudioEngine's context/primitives so cues share the same
 * unlock/volume graph. Patterns are simple four-on-the-floor + hat + bass
 * figures derived from the song BPM; this is an original groove, not a
 * transcription. Scheduling runs a bar ahead on a timer for a steady feel.
 */

export class DanceMusic {
  constructor(audio, { bpm = 120 } = {}) {
    this.audio = audio;
    this.bpm = bpm;
    this.timer = null;
    this.nextTime = 0;
    this.step = 0;
    this.playing = false;
    this.startTime = null;      // ctx time of step 0 while playing
  }

  setBpm(bpm) { this.bpm = bpm; }

  start() {
    const a = this.audio;
    if (!a || !a.ctx) return;
    if (a.ctx.state === 'suspended') a.ctx.resume().catch(() => {});
    this.stop();
    this.playing = true;
    this.step = 0;
    this.nextTime = a.ctx.currentTime + 0.05;
    // Step 0 = song time 0. The game reads its chart clock off this so the
    // notes and the beat share one clock (see SongClock in game.js).
    this.startTime = this.nextTime;
    const tick = () => {
      if (!this.playing || !a.ctx) return;
      const beat = 60 / this.bpm;
      const sixteenth = beat / 4;
      while (this.nextTime < a.ctx.currentTime + 0.25) {
        this.scheduleStep(this.nextTime, this.step, sixteenth, beat);
        this.nextTime += sixteenth;
        this.step += 1;
      }
    };
    tick();
    this.timer = setInterval(tick, 25);
  }

  scheduleStep(t, step, sixteenth, beat) {
    const a = this.audio;
    if (!a || !a.ctx) return;
    const delay = Math.max(0, t - a.ctx.currentTime);
    const barStep = step % 16;        // 16th-note grid per bar
    const beatStep = step % 4;        // which 16th inside the beat

    // Kick on 1 and 3 (and sometimes the 'and' of 2 for drive)
    if (barStep === 0 || barStep === 8 || (barStep === 10 && this.bpm > 110)) {
      a.tone({ freq: 110, slideTo: 42, dur: 0.18, type: 'sine', gain: 0.28, attack: 0.002, delay });
      a.noise({ dur: 0.04, gain: 0.12, type: 'lowpass', freq: 500, delay });
    }
    // Snare/clap on 2 and 4
    if (barStep === 4 || barStep === 12) {
      a.noise({ dur: 0.12, gain: 0.18, type: 'highpass', freq: 1800, delay });
      a.tone({ freq: 220, dur: 0.06, type: 'triangle', gain: 0.08, delay });
    }
    // Closed hats on off-8ths, open-ish on upbeats at higher bpm
    if (beatStep === 2) {
      const open = (barStep === 6 || barStep === 14) && this.bpm > 100;
      a.noise({ dur: open ? 0.09 : 0.035, gain: open ? 0.08 : 0.06, type: 'highpass', freq: 6000, delay });
    }
    if (beatStep === 0 && barStep % 8 !== 0) {
      a.noise({ dur: 0.03, gain: 0.045, type: 'highpass', freq: 6500, delay });
    }

    // Bass: a simple root-fifth bounce each beat
    if (beatStep === 0) {
      const bar = Math.floor(step / 16) % 4;
      const roots = [55, 55, 73.42, 65.41];     // A1, A1, D2, C2
      const root = roots[bar];
      const note = (barStep === 8) ? root * 1.5 : root; // fifth on beat 3
      a.tone({ freq: note, dur: beat * 0.7, type: 'sawtooth', gain: 0.07, attack: 0.01, delay });
    }

    // Chord stab on beat 1 of each bar for a bit of color
    if (barStep === 0) {
      const bar = Math.floor(step / 16) % 4;
      const chords = [
        [220, 277.18, 329.63],   // A
        [220, 277.18, 329.63],
        [293.66, 369.99, 440],   // D
        [261.63, 329.63, 392],   // C
      ];
      const ch = chords[bar];
      for (const f of ch) {
        a.tone({ freq: f, dur: 0.18, type: 'triangle', gain: 0.035, attack: 0.01, delay });
      }
    }
  }

  stop() {
    this.playing = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  // One-shot SFX helpers (registered or called directly by the game)
  static perfect(audio) {
    audio.tone({ freq: 880, dur: 0.1, type: 'sine', gain: 0.18 });
    audio.tone({ freq: 1320, dur: 0.16, type: 'sine', gain: 0.16, delay: 0.05 });
  }
  static good(audio) {
    audio.tone({ freq: 660, dur: 0.1, type: 'sine', gain: 0.14 });
  }
  static miss(audio) {
    audio.tone({ freq: 180, dur: 0.14, type: 'triangle', gain: 0.1, slideTo: 120 });
  }
}
