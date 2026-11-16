import { consumeLaunchSplash } from '../../core/splash.js';

// Carry the menu's launch banner across the navigation, then fade it out.
const launchData = consumeLaunchSplash();
import { createChannel } from '../../core/channel.js';
import { axesFromSample } from '../../core/orientation.js';
import { SwingDetector } from '../../core/gesture.js';
import { Vision } from './vision.js';
import { DanceMusic } from './music.js';
import { icon, hydrateIcons } from '../../core/icons.js';
import {
  SONGS, DanceSession, MOVES, loadDanceSave, persistDanceSave,
} from './logic.js';

/**
 * Dance Party — canvas 2D renderer and wiring.
 *
 * Three input lanes feed the same judge:
 *   • camera (vision.js): body left/right/arms-up via frame-diff zones, and
 *     face/head moves via FaceDetector when available (motion fallback).
 *   • phone: shake (gyro burst), swing (SwingDetector), raise (phone lifted
 *     upright). The phone is always available when a controller is connected.
 *   • keyboard fallback for desk testing (arrows/W, F, J/K/L).
 *
 * Notes scroll down a lane toward a hit line in time with a synth beat track.
 * Clearing a song (grade C+) unlocks the next.
 */

const $ = (id) => document.getElementById(id);

const canvas = $('game');
const ctx = canvas.getContext('2d');

let save = loadDanceSave();
let songIndex = 0;
let session = null;
let phoneOnly = false;

// ── Channel / phone input ──────────────────────────────────────────────────

const swing = new SwingDetector({ onThreshold: 140, offThreshold: 55, minTravel: 22, maxMs: 500 });
let shakeEnergy = 0;
let lastShakeAt = 0;
let raised = false;
let lastRaiseAt = 0;

function onMove(moveId, now) {
  if (!session || session.state !== 'playing') return;
  session.perform(moveId, clock.at(now));
}

const channel = createChannel({
  room: launchData?.room,
  deskKeys: false,          // ←/→/D are dance moves here, not sensitivity/debug
  onA: () => {
    if (!session || session.state === 'ready' || session.state === 'finished') startDance();
  },
  onCommand: (cmd) => {
    if (cmd.type === 'button') {
      if (cmd.menuDirection === 'up' || cmd.button === 'up') changeSong(-1);
      if (cmd.menuDirection === 'down' || cmd.button === 'down') changeSong(1);
    }
  },
  onSample: (sample, dt, now) => {
    const rate = channel.pointer.rateDps;
    const mag = Math.hypot(rate.yaw, rate.pitch);

    // Shake: bursts of high angular motion.
    shakeEnergy = shakeEnergy * 0.82 + mag * 0.18;
    if (shakeEnergy > 180 && now - lastShakeAt > 380) {
      lastShakeAt = now;
      onMove('phone-shake', now);
    }

    // Swing.
    const s = swing.update(rate, dt, now);
    if (s) onMove('phone-swing', now);

    // Raise: phone's long axis (+y in device coords) pointing upward in world.
    try {
      const axes = axesFromSample(sample);
      const upness = axes.y.z;       // +1 = top of phone points to sky
      if (!raised && upness > 0.55 && now - lastRaiseAt > 600) {
        raised = true;
        lastRaiseAt = now;
        onMove('phone-raise', now);
      } else if (raised && upness < 0.2) {
        raised = false;
      }
    } catch { /* sample may be incomplete */ }
  },
});

const { audio } = channel;
const music = new DanceMusic(audio);

/**
 * Song clock — one time base for the chart *and* the beat.
 *
 * With a running AudioContext the chart reads the audio clock (the music is
 * scheduled on it), corrected for output latency. AudioEngine suspends the
 * context while the tab is hidden, which freezes this clock too, so a tab
 * switch pauses the song instead of knocking the music out of phase and
 * bursting misses. Without audio it falls back to performance.now() and
 * pauses itself while hidden. Returns ms since song start; inputs carry
 * performance.now() stamps and are converted with at().
 */
const clock = {
  mode: 'perf',
  last: 0,
  perfStart: 0,
  paused: 0,
  hiddenAt: 0,
  start() {
    const c = audio.ctx;
    if (c && c.state === 'running' && music.startTime != null) {
      this.mode = 'audio';
    } else {
      this.mode = 'perf';
      this.perfStart = performance.now();
      this.paused = 0;
      this.hiddenAt = document.hidden ? performance.now() : 0;
    }
    this.last = -Infinity;
    this.last = this.tick();
  },
  /** Song ms at a performance.now() timestamp (not clamped). */
  at(perfT) {
    if (this.mode === 'audio') {
      const c = audio.ctx;
      if (!c || c.state !== 'running') return this.last;     // suspended: frozen
      const pnow = performance.now();
      let ctxT;
      const ts = typeof c.getOutputTimestamp === 'function' ? c.getOutputTimestamp() : null;
      if (ts && ts.performanceTime > 0 && ts.contextTime > 0 && pnow - ts.performanceTime < 500) {
        ctxT = ts.contextTime + (perfT - ts.performanceTime) / 1000;   // latency-exact
      } else {
        ctxT = c.currentTime - (c.outputLatency || c.baseLatency || 0) + (perfT - pnow) / 1000;
      }
      return (ctxT - music.startTime) * 1000;
    }
    if (this.hiddenAt) return this.last;
    return perfT - this.perfStart - this.paused;
  },
  /** Advance the frame clock; never runs backwards. */
  tick() {
    const t = this.at(performance.now());
    if (t > this.last) this.last = t;
    return this.last;
  },
};
document.addEventListener('visibilitychange', () => {
  if (clock.mode !== 'perf') return;
  const now = performance.now();
  if (document.hidden) { if (!clock.hiddenAt) clock.hiddenAt = now; }
  else if (clock.hiddenAt) { clock.paused += now - clock.hiddenAt; clock.hiddenAt = 0; }
});

audio.register('dance-perfect', () => DanceMusic.perfect(audio));
audio.register('dance-good', () => DanceMusic.good(audio));
audio.register('dance-miss', () => DanceMusic.miss(audio));

// ── Vision ─────────────────────────────────────────────────────────────────

const CAM_LABELS = {
  waiting: 'waiting for camera…',
  off: 'off — starts on play',
  denied: 'blocked — phone only',
  none: 'no camera — phone only',
  busy: 'camera busy — phone only',
  insecure: 'needs HTTPS — phone only',
  unavailable: 'unsupported — phone only',
  error: 'unavailable — phone only',
  timeout: 'no answer — phone only',
};
// Outcomes that won't change by asking again: stop retrying, go phone-only.
const CAM_FINAL = new Set(['denied', 'none', 'insecure', 'unavailable']);

function setCamStatus(s) {
  const cam = $('camstatus');
  if (!cam) return;
  cam.textContent = s.camera === 'on'
    ? (s.face === 'on' ? 'on + face' : 'on (motion)')
    : CAM_LABELS[s.camera] || 'phone only';
}

const vision = new Vision({
  onMove: (moveId, now) => onMove(moveId, now),
  onStatus: (s) => {
    if (CAM_FINAL.has(s.camera)) phoneOnly = true;
    $('camwrap').classList.toggle('off', s.camera !== 'on');
    setCamStatus(s);
  },
});

const CAMERA_TIMEOUT_MS = 10000;

async function ensureCamera() {
  if (vision.enabled) return true;
  if (phoneOnly) return false;
  // The HUD is under the overlay here, so say it on the panel itself.
  const cta = document.querySelector('#panel .cta');
  const ctaHtml = cta ? cta.innerHTML : '';
  if (cta) cta.textContent = 'Waiting for camera… allow access in the browser prompt (or wait — phone-only in 10s)';
  let timer = 0;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), CAMERA_TIMEOUT_MS); });
  // Unanswered prompt: play phone-only now. The start stays pending, so a
  // late "Allow" turns the camera on for the next song.
  const res = await Promise.race([vision.start($('cam')), timeout]);
  clearTimeout(timer);
  if (cta) cta.innerHTML = ctaHtml;
  if (res === 'timeout') setCamStatus({ camera: 'timeout' });
  return res === true;
}

// ── UI: song select ────────────────────────────────────────────────────────

function syncSongs() {
  const wrap = $('songs');
  if (!wrap) return;
  wrap.innerHTML = '';
  SONGS.forEach((s, i) => {
    const unlocked = i < save.unlocked;
    const best = save.best[s.id];
    const card = document.createElement('div');
    card.className = `song${i === songIndex ? ' sel' : ''}${unlocked ? '' : ' locked'}`;
    card.innerHTML = `<div class="se">${icon(unlocked ? s.icon : 'lock')}</div>
      <div class="sn">${s.name}</div>
      <div class="sm">${unlocked ? `${s.bpm} BPM · ${best ? `${best.grade} ${best.score}` : s.desc}` : 'clear previous to unlock'}</div>`;
    wrap.appendChild(card);
  });
}

function changeSong(delta) {
  if (session && session.state === 'playing') return;
  let i = songIndex;
  for (let step = 0; step < SONGS.length; step += 1) {
    i = (i + delta + SONGS.length) % SONGS.length;
    if (i < save.unlocked) { songIndex = i; break; }
  }
  syncSongs();
  audio.play('hover');
}

// ── Dance lifecycle ────────────────────────────────────────────────────────

let judgeUntil = 0;
let promptUntil = 0;

let starting = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startDance() {
  // Space/click/phone A can all land while the camera prompt is up; only
  // one start may be in flight (two used to open two camera streams).
  if (starting || (session && session.state === 'playing')) return;
  if (songIndex >= save.unlocked) return;
  starting = true;
  try {
    const unlocking = audio.unlock().catch(() => false);   // inside the gesture
    await ensureCamera();
    // Give resume() a moment; a context that never runs (no gesture) → perf clock.
    await Promise.race([unlocking, sleep(500)]);
    const song = SONGS[songIndex];
    const po = !vision.enabled;

    session = new DanceSession({
      song,
      seed: (performance.now() * 997) | 0,
      phoneOnly: po,
      onEvent: handleEvent,
    });
    music.stop();
    music.setBpm(song.bpm);
    // Only play the beat if it can share the chart's clock; music scheduled
    // on a context that wakes up later would be out of phase.
    if (audio.ctx && audio.ctx.state === 'running') music.start();
    clock.start();
    session.start(0);
    $('overlay').classList.add('hide');
    $('songtag').innerHTML = `${icon(song.icon)} ${song.name}`;
    showPrompt(po ? 'phone moves only — camera off' : 'match the moves!', 1800);
  } finally {
    starting = false;
  }
}

function handleEvent(e) {
  if (e.type === 'hit') {
    const label = e.judge === 'perfect' ? 'PERFECT!' : 'GOOD';
    showJudge(label, e.judge === 'perfect' ? '#ffe36e' : '#7fd4ff', 420);
    audio.play(e.judge === 'perfect' ? 'dance-perfect' : 'dance-good');
    channel.feedback({ type: 'slice', combo: e.judge === 'perfect' ? 2 : 1 });
  } else if (e.type === 'miss') {
    showJudge('MISS', '#ff6a6a', 360);
    audio.play('dance-miss');
  } else if (e.type === 'finish') {
    music.stop();
    // Back on the menu: release the camera (light off). It restarts on the
    // next song without a new prompt once permission is granted.
    // (A still-pending permission prompt is left alone so a late Allow counts.)
    if (vision.enabled) vision.stop();
    const song = session.song;
    const prev = save.best[song.id];
    if (!prev || e.score > prev.score) save.best[song.id] = { score: e.score, grade: e.grade };
    const before = save.unlocked;
    if (e.passed && song.order + 1 >= save.unlocked) {
      save.unlocked = Math.min(SONGS.length, song.order + 2);
    }
    persistDanceSave(save);
    showResults(e, save.unlocked > before);
  }
}

function showJudge(text, color, ms) {
  const el = $('judge');
  el.textContent = text;
  el.style.color = color;
  el.classList.add('on');
  judgeUntil = performance.now() + ms;
}
function showPrompt(text, ms) {
  const el = $('prompt');
  el.textContent = text;
  el.classList.add('on');
  promptUntil = performance.now() + ms;
}

function showResults(e, newlyUnlocked) {
  const song = session.song;
  const unlocked = newlyUnlocked && song.order + 1 < SONGS.length;
  const accPct = Math.round(e.acc * 100);
  $('panel').innerHTML = `<h1>${icon('music')} <em>${e.passed ? 'Cleared!' : 'Keep grooving'}</em></h1>
    <div class="grade" style="color:${e.passed ? '#ffe36e' : '#9aa7bd'}">${e.grade}</div>
    <div class="results">
      <div>Score &nbsp;&nbsp; <b>${e.score}</b></div>
      <div>Accuracy <b>${accPct}%</b></div>
      <div>Max combo <b>${e.maxCombo}</b></div>
      <div>Perfect / Good / Miss <b>${e.counts.perfect} / ${e.counts.good} / ${e.counts.miss}</b></div>
    </div>
    <p>${unlocked ? `Unlocked <strong>${SONGS[song.order + 1].name}</strong>!` : e.passed ? 'Great moves!' : 'Reach grade C to unlock the next song.'}</p>
    <div id="songs"></div>
    <div class="cta"><strong>A</strong> or <strong>Space</strong> dance again · <strong>↑↓</strong> pick song · <strong>B</strong> menu</div>`;
  syncSongs();
  $('overlay').classList.remove('hide');
}

// ── Rendering (canvas 2D) ──────────────────────────────────────────────────

const MOVE_COLORS = {
  'body-left': '#7fd4ff',
  'body-right': '#7fd4ff',
  'body-up': '#6ef0a8',
  'face': '#ffe36e',
  'phone-shake': '#ff8bd1',
  'phone-swing': '#ffb36b',
  'phone-raise': '#c7a6ff',
};

// Move icons drawn on the canvas: the shared SVG glyphs rasterised once each.
const NOTE_INK = '#0b0816';
const iconImages = new Map();
function iconImage(name) {
  let img = iconImages.get(name);
  if (!img) {
    const inner = icon(name).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="64" height="64" color="${NOTE_INK}" `
      + `fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
    img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    iconImages.set(name, img);
  }
  return img;
}
Object.values(MOVES).forEach((m) => iconImage(m.icon));

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = window.innerWidth; const h = window.innerHeight;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);

function roundRect(x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function draw(now) {
  const w = window.innerWidth; const h = window.innerHeight;
  // background
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#120d24');
  bg.addColorStop(1, '#0b0816');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // stage lights
  const t = now / 1000;
  for (let i = 0; i < 3; i += 1) {
    const cx = w * (0.2 + i * 0.3) + Math.sin(t * (0.6 + i * 0.2) + i) * w * 0.08;
    const grd = ctx.createRadialGradient(cx, -40, 10, cx, h * 0.4, h * 0.7);
    const hue = [320, 190, 45][i];
    grd.addColorStop(0, `hsla(${hue},90%,70%,0.18)`);
    grd.addColorStop(1, 'hsla(0,0%,0%,0)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, w, h);
  }

  // dance floor grid
  ctx.save();
  ctx.globalAlpha = 0.12;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  const horizon = h * 0.38;
  for (let i = -10; i <= 10; i += 1) {
    const bx = w / 2 + i * 90;
    ctx.beginPath(); ctx.moveTo(w / 2 + i * 18, horizon); ctx.lineTo(bx, h); ctx.stroke();
  }
  for (let j = 0; j < 12; j += 1) {
    const y = horizon + (j / 12) * (j / 12) * (h - horizon);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  ctx.restore();

  if (!session) return;

  // Note highway: three visual lanes grouped by input (body/face/phone)
  const laneW = Math.min(520, w * 0.55);
  const laneX = w / 2 - laneW / 2;
  const hitY = h * 0.78;
  const travel = hitY - h * 0.12;          // pixels representing lead time
  const leadMs = 1800;

  // hit line
  ctx.save();
  ctx.strokeStyle = '#ffffffaa';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(laneX - 10, hitY); ctx.lineTo(laneX + laneW + 10, hitY); ctx.stroke();
  ctx.fillStyle = '#ffffff22';
  roundRect(laneX - 10, hitY - 18, laneW + 20, 36, 10); ctx.fill();
  ctx.restore();

  // group labels at bottom
  const groups = ['body', 'face', 'phone'];
  const gW = laneW / 3;
  ctx.save();
  ctx.font = '600 12px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  groups.forEach((g, i) => {
    const gx = laneX + gW * i + gW / 2;
    ctx.fillStyle = g === 'body' ? '#7fd4ff' : g === 'face' ? '#ffe36e' : '#ff8bd1';
    ctx.fillText(g === 'body' ? 'BODY' : g === 'face' ? 'FACE' : 'PHONE', gx, hitY + 22);
  });
  ctx.restore();

  // notes
  const visible = session.visibleNotes(leadMs, 400);
  for (const n of visible) {
    const dt = n.t - session.nowMs;
    const y = hitY - (dt / leadMs) * travel;
    if (y < h * 0.05 || y > h * 0.95) continue;
    const groupIdx = n.group === 'body' ? 0 : n.group === 'face' ? 1 : 2;
    // spread body moves across sub-lanes
    let sub = 0.5;
    if (n.moveId === 'body-left') sub = 0.18;
    else if (n.moveId === 'body-right') sub = 0.82;
    else if (n.moveId === 'body-up') sub = 0.5;
    else if (n.group === 'face') sub = 0.5;
    else if (n.moveId === 'phone-shake') sub = 0.22;
    else if (n.moveId === 'phone-swing') sub = 0.5;
    else if (n.moveId === 'phone-raise') sub = 0.78;
    const x = laneX + gW * groupIdx + gW * sub;

    const color = MOVE_COLORS[n.moveId] || '#fff';
    const alpha = n.hit ? (n.judge === 'miss' ? 0.18 : 0.35) : Math.min(1, 0.4 + (1 - dt / leadMs) * 0.7);
    const r = n.hit ? 22 : 26 + Math.max(0, 1 - Math.abs(dt) / 300) * 6;

    ctx.save();
    ctx.globalAlpha = alpha;
    // glow
    const grd = ctx.createRadialGradient(x, y, 4, x, y, r * 1.6);
    grd.addColorStop(0, color);
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.arc(x, y, r * 1.6, 0, Math.PI * 2); ctx.fill();
    // disc
    ctx.fillStyle = n.hit ? '#ffffff' : color;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#ffffffcc'; ctx.lineWidth = 2; ctx.stroke();
    // icon
    ctx.globalAlpha = n.hit ? 0.5 : 1;
    const img = iconImage(n.icon);
    if (img.complete && img.naturalWidth) {
      const sz = n.hit ? 22 : 28;
      ctx.drawImage(img, x - sz / 2, y - sz / 2, sz, sz);
    }
    ctx.restore();

    // label near the hit line for upcoming notes
    if (!n.hit && dt > -80 && dt < 420) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - Math.abs(dt) / 420);
      ctx.font = '700 14px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillStyle = color;
      ctx.fillText(n.label, x, y - r - 6);
      ctx.restore();
    }
  }

  // progress bar
  // Song time starts slightly negative (music lead-in), so clamp both ends.
  const prog = Math.max(0, Math.min(1, session.nowMs / Math.max(1, session.durationMs)));
  ctx.save();
  ctx.fillStyle = '#ffffff22';
  roundRect(w * 0.25, 14, w * 0.5, 6, 3); ctx.fill();
  ctx.fillStyle = '#ff8bd1';
  roundRect(w * 0.25, 14, w * 0.5 * prog, 6, 3); ctx.fill();
  ctx.restore();

  // HUD text
  $('score').textContent = String(session.score);
  $('combo').textContent = `combo ${session.combo} · x${session.mult}`;
}

function update(now) {
  // Expire pointer.live after 500ms of silence (and keep the mouse fallback).
  channel.poll(now);
  const ps = $('phonestatus');
  if (ps) {
    const txt = channel.pointer.live ? 'connected' : (channel.pointer.lastSeen ? 'not connected' : 'waiting');
    if (ps.textContent !== txt) ps.textContent = txt;
  }
  if (session && session.state === 'playing') session.update(clock.tick());
  if (judgeUntil && now > judgeUntil) { $('judge').classList.remove('on'); judgeUntil = 0; }
  if (promptUntil && now > promptUntil) { $('prompt').classList.remove('on'); promptUntil = 0; }
}

function frame(now) {
  requestAnimationFrame(frame);
  update(now);
  draw(now);
}

// ── Keyboard fallback (desk testing) ───────────────────────────────────────

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  const now = performance.now();
  if (e.key === 'ArrowUp') { e.preventDefault(); changeSong(-1); }
  if (e.key === 'ArrowDown') { e.preventDefault(); changeSong(1); }
  if (session && session.state === 'playing') {
    if (k === 'arrowleft' || k === 'a') { e.preventDefault(); onMove('body-left', now); }
    if (k === 'arrowright' || k === 'd') { e.preventDefault(); onMove('body-right', now); }
    if (k === 'w') { onMove('body-up', now); }
    if (k === 'f') { onMove('face', now); }
    if (k === 'j') { onMove('phone-shake', now); }
    if (k === 'k') { onMove('phone-swing', now); }
    if (k === 'l') { onMove('phone-raise', now); }
  }
  // Space/Enter start is handled once, by the channel's onA.
});

// ── Boot ───────────────────────────────────────────────────────────────────

hydrateIcons();
syncSongs();
resize();
$('phonestatus').textContent = 'waiting';
$('camstatus').textContent = 'off — starts on play';

if (launchData && launchData.splash) {
  launchData.splash.addEventListener('animationend', () => launchData.splash.remove(), { once: true });
}

// Stop camera/music when leaving.
window.addEventListener('pagehide', () => { music.stop(); vision.stop(); });

requestAnimationFrame(frame);

window.__senwii = {
  get session() { return session; },
  channel, vision, music, startDance, save,
};
