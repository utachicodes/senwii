import * as THREE from '/vendor/three/three.module.js';
import { consumeLaunchSplash } from '../../core/splash.js';

// Carry the menu's launch banner across the navigation, then fade it out.
const launchData = consumeLaunchSplash();
import { createChannel } from '../../core/channel.js';
import { SwingDetector } from '../../core/gesture.js';
import { icon, hydrateIcons } from '../../core/icons.js';
import { ParticleBurst, dotTexture, canvasTexture } from '../shared/fx.js';
import {
  Game, LANE, HEADPIN_Z, PATTERNS,
  frameCards, loadBowlSave, persistBowlSave, previewPath,
} from './logic.js';

/**
 * Bowling — renderer. Ten-pin logic lives in logic.js; this draws the lane,
 * pins and ball, turns hand swings into deliveries (speed = power, sideways
 * twist at release = hook), and renders a 10-frame scoreboard with three oil
 * patterns ("levels") that change how the ball reads the lane.
 */

const $ = (id) => document.getElementById(id);

const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x11161f);
scene.fog = new THREE.Fog(0x11161f, 11, 24);

const camera = new THREE.PerspectiveCamera(52, 1, 0.05, 60);

scene.add(new THREE.AmbientLight(0xffffff, 0.45));
const key = new THREE.DirectionalLight(0xfff2d0, 1.1);
key.position.set(1.5, 9, 4);
scene.add(key);
for (let i = 0; i < 5; i += 1) {
  const l = new THREE.PointLight(0xffd9a0, 0.55, 7, 2);
  l.position.set(0, 2.6, i * 3.6);
  scene.add(l);
}
const pinGlow = new THREE.PointLight(0x9fd6ff, 0.9, 10);
pinGlow.position.set(0, 2.2, HEADPIN_Z + 0.6);
scene.add(pinGlow);

// ── Lane: procedural wood-plank texture ────────────────────────────────────
const laneTex = canvasTexture((g, s) => {
  g.fillStyle = '#c99a5b';
  g.fillRect(0, 0, s, s);
  for (let i = 0; i < 9; i += 1) {
    g.fillStyle = i % 2 ? 'rgba(130,86,40,0.12)' : 'rgba(255,214,150,0.10)';
    g.fillRect((i * s) / 9, 0, s / 9, s);
  }
  g.strokeStyle = 'rgba(90,56,22,0.25)';
  g.lineWidth = 1;
  for (let i = 0; i <= 9; i += 1) {
    g.beginPath(); g.moveTo((i * s) / 9, 0); g.lineTo((i * s) / 9, s); g.stroke();
  }
  for (let i = 0; i < 400; i += 1) {
    g.fillStyle = `rgba(80,50,20,${0.03 + Math.random() * 0.05})`;
    g.fillRect(Math.random() * s, Math.random() * s, 2 + Math.random() * 14, 1);
  }
}, 512);
laneTex.wrapS = laneTex.wrapT = THREE.RepeatWrapping;
laneTex.repeat.set(1, 9);

const laneGeo = new THREE.PlaneGeometry(LANE.HALF_WIDTH * 2, LANE.LENGTH + 2);
laneGeo.rotateX(-Math.PI / 2);
const lane = new THREE.Mesh(laneGeo, new THREE.MeshStandardMaterial({
  map: laneTex, roughness: 0.28, metalness: 0.08,
}));
lane.position.z = LANE.LENGTH / 2 - 1;
scene.add(lane);

// Oil sheen overlay — tint varies with the selected pattern.
const oilMat = new THREE.MeshBasicMaterial({
  color: 0x9fd6ff, transparent: true, opacity: 0.06, depthWrite: false,
});
const oil = new THREE.Mesh(new THREE.PlaneGeometry(LANE.HALF_WIDTH * 1.7, LANE.LENGTH - 1), oilMat);
oil.rotation.x = -Math.PI / 2;
oil.position.set(0, 0.003, LANE.LENGTH / 2 - 0.6);
scene.add(oil);

const arrowTex = canvasTexture((g, s) => {
  g.clearRect(0, 0, s, s);
  g.fillStyle = 'rgba(20,20,24,0.55)';
  for (let i = 0; i < 5; i += 1) {
    const cx = s * (0.2 + i * 0.15);
    g.beginPath();
    g.moveTo(cx, s * 0.15); g.lineTo(cx - s * 0.045, s * 0.4); g.lineTo(cx + s * 0.045, s * 0.4);
    g.closePath(); g.fill();
  }
}, 256);
const arrows = new THREE.Mesh(
  new THREE.PlaneGeometry(LANE.HALF_WIDTH * 1.7, 2.2),
  new THREE.MeshBasicMaterial({ map: arrowTex, transparent: true }),
);
arrows.rotation.x = -Math.PI / 2;
arrows.position.set(0, 0.004, 4.5);
scene.add(arrows);

for (const side of [-1, 1]) {
  const gutter = new THREE.Mesh(
    new THREE.PlaneGeometry(0.4, LANE.LENGTH + 2),
    new THREE.MeshStandardMaterial({ color: 0x0a0d12, roughness: 0.5, metalness: 0.3 }),
  );
  gutter.rotateX(-Math.PI / 2);
  gutter.position.set(side * (LANE.HALF_WIDTH + 0.2), -0.03, LANE.LENGTH / 2 - 1);
  scene.add(gutter);
  const rim = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, 0.05, LANE.LENGTH + 2),
    new THREE.MeshStandardMaterial({ color: 0x3a3f4c, roughness: 0.3, metalness: 0.5 }),
  );
  rim.position.set(side * (LANE.HALF_WIDTH + 0.02), 0, LANE.LENGTH / 2 - 1);
  scene.add(rim);
}

const pit = new THREE.Mesh(
  new THREE.PlaneGeometry(LANE.HALF_WIDTH * 3.2, 3),
  new THREE.MeshStandardMaterial({ color: 0x1b2230, roughness: 0.8 }),
);
pit.position.set(0, 1.3, HEADPIN_Z + 1.5);
scene.add(pit);
const pitTrim = new THREE.Mesh(
  new THREE.BoxGeometry(LANE.HALF_WIDTH * 3.2, 0.06, 0.06),
  new THREE.MeshStandardMaterial({ color: 0x5b8cff, emissive: 0x1a2a66, emissiveIntensity: 0.6 }),
);
pitTrim.position.set(0, 0.03, HEADPIN_Z + 1.47);
scene.add(pitTrim);

// Sweep bar (animated between balls).
const sweepBar = new THREE.Mesh(
  new THREE.BoxGeometry(LANE.HALF_WIDTH * 2.2, 0.18, 0.18),
  new THREE.MeshStandardMaterial({ color: 0x4b5568, roughness: 0.4, metalness: 0.4 }),
);
sweepBar.visible = false;
scene.add(sweepBar);

// ── Pins ───────────────────────────────────────────────────────────────────
const pinProfile = [
  [0.050, 0.000], [0.062, 0.020], [0.073, 0.085], [0.070, 0.160],
  [0.052, 0.235], [0.034, 0.295], [0.050, 0.330], [0.044, 0.360], [0.000, 0.385],
].map(([r, y]) => new THREE.Vector2(r, y));
const pinGeo = new THREE.LatheGeometry(pinProfile, 16);
const pinMat = new THREE.MeshStandardMaterial({ color: 0xf4f1ea, roughness: 0.25 });
const bandGeo = new THREE.TorusGeometry(0.047, 0.012, 8, 20);
const bandMat = new THREE.MeshStandardMaterial({ color: 0xd4302a, roughness: 0.3 });

function makePin() {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(pinGeo, pinMat));
  const band = new THREE.Mesh(bandGeo, bandMat);
  band.rotation.x = Math.PI / 2;
  band.position.y = 0.315;
  g.add(band);
  const band2 = band.clone();
  band2.position.y = 0.275;
  g.add(band2);
  return g;
}

let game = new Game({ onEvent: handleEvent, animateSweep: true });
let pinMeshes = [];   // parallel to game.pins
let pinFall = [];     // parallel: { t, ax, dir }
let pinsRef = null;

function rebuildPins() {
  pinMeshes.forEach((m) => scene.remove(m));
  pinMeshes = game.pins.map(() => { const m = makePin(); scene.add(m); return m; });
  pinFall = game.pins.map((p) => ({
    t: p.standing ? 0 : 1,
    ax: p.fallAxis || 0,
    dir: p.fallDir || 1,
  }));
  pinsRef = game.pins;
}
rebuildPins();

// ── Ball + aim ─────────────────────────────────────────────────────────────
const ball = new THREE.Mesh(
  new THREE.SphereGeometry(0.13, 20, 16),
  new THREE.MeshStandardMaterial({ color: 0x5b8cff, roughness: 0.15, metalness: 0.25 }),
);
scene.add(ball);
const fingerHoleMat = new THREE.MeshStandardMaterial({ color: 0x0c1320, roughness: 0.6 });
for (const [dx, dz] of [[-0.045, 0], [0.045, 0], [0, 0.06]]) {
  const hole = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), fingerHoleMat);
  hole.position.set(dx, 0.09, dz);
  ball.add(hole);
}

const aimArrow = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.5, 4),
  new THREE.MeshBasicMaterial({ color: 0xfff1a8, transparent: true, opacity: 0.9 }));
aimArrow.rotation.x = Math.PI / 2;
scene.add(aimArrow);

// Hook preview: a faint arc showing where the current aim/last-hook would go.
const hookLine = new THREE.Line(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: 0x9fd6ff, transparent: true, opacity: 0.35 }),
);
scene.add(hookLine);

const burst = new ParticleBurst(scene, { texture: dotTexture('#ffe9b0'), maxParticles: 160 });

// ── UI + patterns ──────────────────────────────────────────────────────────
let bowlSave = loadBowlSave();
let patternIndex = 0;
let started = false;
let shake = 0;
let lastHookHint = 0;      // remembered hook from the previous delivery
const AIM_SPAN = 0.7;      // metres either side of centre at the pins, screen edge to edge
let previewKey = '';

function syncPatterns() {
  const wrap = $('patterns');
  if (!wrap) return;
  wrap.innerHTML = '';
  PATTERNS.forEach((p, i) => {
    const unlocked = i < bowlSave.unlocked;
    const best = bowlSave.best[p.id];
    const card = document.createElement('div');
    card.className = `pat${i === patternIndex ? ' sel' : ''}${unlocked ? '' : ' locked'}`;
    card.innerHTML = `<div class="pe">${icon(unlocked ? p.icon : 'lock')}</div>
      <div class="pn">${p.name}</div>
      <div class="pd">${unlocked ? (best ? `best ${best}` : p.desc) : `score ${p.unlockAt}+ to unlock`}</div>`;
    wrap.appendChild(card);
  });
}

function applyPattern(i) {
  patternIndex = Math.max(0, Math.min(i, bowlSave.unlocked - 1));
  // Oil sheen hint: slicker patterns look glossier.
  const slick = 1 - PATTERNS[patternIndex].friction;
  oilMat.opacity = 0.03 + slick * 0.09;
  oilMat.color.setHex(patternIndex === 2 ? 0xcfe8ff : patternIndex === 1 ? 0xbfe2ff : 0xa8d8ff);
  syncPatterns();
}

function changePattern(delta) {
  // The lane is picked on the menus only: switching mid-game would throw the
  // game in progress away. startGame() reads patternIndex for the next one.
  if (started && game.state !== 'over') return;
  let i = patternIndex;
  let next = patternIndex;
  for (let s = 0; s < PATTERNS.length; s += 1) {
    i = (i + delta + PATTERNS.length) % PATTERNS.length;
    if (i < bowlSave.unlocked) { next = i; break; }
  }
  if (next === patternIndex) return;      // nothing else unlocked yet
  applyPattern(next);
  channel.audio.play('hover');
}

function renderScoreboard() {
  const cards = frameCards(game.rolls);
  const board = $('board');
  board.innerHTML = cards.map((c, i) => {
    const tenth = i === 9;
    const m = c.marks || [null, null, null];
    const marks = tenth
      ? `<span>${m[0] || ''}</span><span>${m[1] || ''}</span><span>${m[2] || ''}</span>`
      : `<span>${m[0] || ''}</span><span>${m[1] || ''}</span>`;
    const tot = c.total != null ? c.total : '';
    return `<div class="fc${tenth ? ' tenth' : ''}"><div class="fn">${i + 1}</div><div class="marks">${marks}</div><div class="tot">${tot}</div></div>`;
  }).join('');
}

function syncHud() {
  $('frame').textContent = `frame ${Math.min(game.frameIndex + 1, 10)} / 10`;
  $('score').textContent = String(game.score());
  $('ball-no').textContent = `ball ${game.ballInFrame + 1}`;
  const tag = $('patternTag');
  if (tag) tag.innerHTML = `${icon(game.pattern.icon)} ${game.pattern.name} lane`;
  renderScoreboard();
}

// ── Wiring ─────────────────────────────────────────────────────────────────
const swing = new SwingDetector({ onThreshold: 110, offThreshold: 55, minTravel: 18, maxMs: 600 });
let shakeCam = 0;

// Track recent lateral rate so hook reflects the hand's twist at release.
let recentYaw = 0;
let recentPitch = 0;
let hookAccum = 0;        // smoothed hook reading over the active swing
let hookSamples = 0;

const channel = createChannel({
  room: launchData?.room,
  onA: () => {
    if (!started || game.state === 'over') startGame();
    // Hold-to-charge is the desk fallback only: with a phone connected the
    // ball goes by swinging, and a stray A tap must not auto-bowl.
    else if (game.state === 'aim' && !charge && !channel.pointer.live) beginCharge();
  },
  onCommand: (cmd) => {
    if (cmd.type === 'button') {
      if (cmd.menuDirection === 'up' || cmd.button === 'up') changePattern(-1);
      if (cmd.menuDirection === 'down' || cmd.button === 'down') changePattern(1);
    }
  },
  onSample: (sample, dt, now) => {
    const rate = channel.pointer.rateDps;
    recentYaw = rate.yaw;
    recentPitch = rate.pitch;

    const s = swing.update(rate, dt, now);
    if (swing.active) {
      // Lateral bias of this instant: negative yaw = hand moved right in
      // cursor space. Accumulate so the release hook is the swing's character,
      // not a single noisy sample.
      const mag = Math.hypot(rate.yaw, rate.pitch) || 1;
      hookAccum += (-rate.yaw / mag);
      hookSamples += 1;
    } else if (!s) {
      hookAccum = 0; hookSamples = 0;
    }

    if (s && started && game.state === 'aim') {
      const power = Math.min(1, Math.max(0.12, s.peak / 420));
      // Hook from the swing's travel vector (how sideways the hand moved)
      // blended with the accumulated instant bias.
      const travelMag = Math.hypot(s.vx, s.vy);
      const travelHook = travelMag > 0 ? s.vx / travelMag : 0;   // -1..1, + = swept right
      const instantHook = hookSamples ? hookAccum / hookSamples : 0;
      let hook = travelHook * 0.55 + instantHook * 0.45;
      // Scale: a mostly-forward swing keeps a gentle hook (a 15° sideways
      // lean ≈ 0.35 spin, a ~30 cm break on the house pattern); a very
      // sideways slash caps out. Damp tiny wiggles; never pass on a NaN.
      hook = Number.isFinite(hook) ? Math.max(-1, Math.min(1, hook * 1.4)) : 0;
      if (Math.abs(hook) < 0.1) hook = 0;
      lastHookHint = hook;

      const launched = game.roll(power, undefined, hook);
      if (launched) {
        cancelCharge();
        channel.feedback({ type: 'slice', combo: Math.abs(hook) > 0.35 ? 2 : 1 });
        channel.audio.play('bw-release');
        flashPower(power, hook);
      }
      hookAccum = 0; hookSamples = 0;
    }
  },
});

// ── Sound design ───────────────────────────────────────────────────────────
const { audio } = channel;

audio.register('bw-release', (a) => {
  a.noise({ dur: 0.22, gain: 0.1, type: 'lowpass', freq: 500, sweepTo: 150 });
  a.tone({ freq: 90, dur: 0.18, type: 'sine', gain: 0.12, slideTo: 60 });
});
audio.register('bw-pins', (a, { pins = 1 } = {}) => {
  const n = Math.min(pins, 10);
  a.noise({ dur: 0.1, gain: 0.3, type: 'bandpass', freq: 1200, q: 1.4 });
  a.tone({ freq: 500, slideTo: 260, dur: 0.1, type: 'triangle', gain: 0.18 });
  for (let i = 0; i < Math.min(4, n); i += 1) {
    a.noise({ dur: 0.08, gain: 0.14, type: 'bandpass', freq: 700 + Math.random() * 900, q: 2, delay: 0.03 + i * 0.045 });
  }
});
audio.register('bw-strike', (a) => {
  a.noise({ dur: 0.4, gain: 0.42, type: 'lowpass', freq: 2400, sweepTo: 300 });
  a.tone({ freq: 160, dur: 0.3, type: 'triangle', gain: 0.24, slideTo: 70 });
  for (let i = 0; i < 7; i += 1) {
    a.noise({ dur: 0.1, gain: 0.16, type: 'bandpass', freq: 500 + Math.random() * 1400, q: 1.8, delay: 0.04 + i * 0.05 + Math.random() * 0.03 });
  }
  a.tone({ freq: 880, dur: 0.22, type: 'sine', gain: 0.14, delay: 0.42 });
  a.tone({ freq: 1318, dur: 0.3, type: 'sine', gain: 0.12, delay: 0.5 });
});
audio.register('bw-gutter', (a) => {
  a.noise({ dur: 0.35, gain: 0.1, type: 'lowpass', freq: 300 });
  a.tone({ freq: 140, dur: 0.4, type: 'sine', gain: 0.14, slideTo: 60 });
});
audio.register('bw-spare', (a) => {
  a.tone({ freq: 880, dur: 0.14, type: 'sine', gain: 0.2 });
  a.tone({ freq: 1318, dur: 0.26, type: 'sine', gain: 0.18, delay: 0.1 });
});
audio.register('bw-gameover', (a) => {
  a.tone({ freq: 523.25, dur: 0.16, type: 'sine', gain: 0.2 });
  a.tone({ freq: 659.25, dur: 0.16, type: 'sine', gain: 0.2, delay: 0.14 });
  a.tone({ freq: 783.99, dur: 0.42, type: 'sine', gain: 0.22, delay: 0.28 });
});
audio.register('bw-sweep', (a) => {
  a.noise({ dur: 0.35, gain: 0.08, type: 'lowpass', freq: 700, sweepTo: 200 });
});

function startGame() {
  started = true;
  game = new Game({ onEvent: handleEvent, pattern: patternIndex, animateSweep: true });
  rebuildPins();
  $('overlay').classList.add('hide');
  $('hookhint').classList.add('on');
  setTimeout(() => $('hookhint').classList.remove('on'), 3500);
  syncHud();
}

// ── Desk fallback: hold A / Space / click to charge, release to bowl ──────
// Power grows with the hold (full at 1s). The phone's A has no release
// event, so a charge also lets go by itself after CHARGE_MAX_MS.
const CHARGE_FULL_MS = 1000;
const CHARGE_MAX_MS = 1500;
let charge = null;          // { t0 } while charging

function chargePower(now) {
  return 0.3 + 0.7 * Math.min(1, (now - charge.t0) / CHARGE_FULL_MS);
}
function beginCharge() {
  charge = { t0: performance.now() };
  $('power').style.width = '30%';
  $('powerwrap').classList.add('on');
}
function cancelCharge() { charge = null; }
function releaseCharge() {
  if (!charge) return;
  const power = chargePower(performance.now());
  charge = null;
  if (!started || game.state !== 'aim') return;
  lastHookHint = 0;
  if (game.roll(power, undefined, 0)) {
    channel.audio.play('bw-release');
    flashPower(power, 0);
  }
}
window.addEventListener('pointerup', releaseCharge);
window.addEventListener('blur', cancelCharge);

function flashPower(p, hook) {
  const el = $('power');
  el.style.width = `${Math.round(p * 100)}%`;
  el.parentElement.classList.add('on');
  const hh = $('hookhint');
  if (Math.abs(hook) > 0.18) {
    hh.textContent = hook > 0 ? 'hooking right ↷' : '↶ hooking left';
    hh.classList.add('on');
  }
  clearTimeout(flashPower.t);
  flashPower.t = setTimeout(() => { el.parentElement.classList.remove('on'); hh.classList.remove('on'); }, 1400);
}

function handleEvent(e) {
  if (e.type === 'roll') {
    syncHud();
  } else if (e.type === 'pin-down') {
    const pin = game.pins.find((p) => p.id === e.id) || game.pins[e.id];
    if (pin) {
      burst.spawn(new THREE.Vector3(pin.x, 0.22, pin.z), {
        count: 10, speed: 1.4 + (e.impulse || 1) * 0.15, size: 0.05, color: 0xffe9b0, life: 0.55,
      });
    }
    // sync fall direction from the logic pin's recorded impact
    const idx = game.pins.findIndex((p) => p.id === e.id);
    if (idx >= 0 && pinFall[idx]) {
      pinFall[idx].dir = 1;
      pinFall[idx].ax = game.pins[idx].fallAxis || 0;
    }
  } else if (e.type === 'settled') {
    syncHud();
    // The logic decides strike/spare (it knows the rack the ball faced).
    if (e.strike) { audio.play('bw-strike'); shake = 1; }
    else if (e.spare) audio.play('bw-spare');
    else if (e.pinsDown === 0) audio.play('bw-gutter');
    else audio.play('bw-pins', { pins: e.pinsDown });
    const label = e.strike ? 'STRIKE!'
      : e.spare ? 'SPARE!'
      : e.pinsDown === 0 ? 'GUTTER' : `${e.pinsDown} pin${e.pinsDown === 1 ? '' : 's'}`;
    $('banner').textContent = label;
    $('banner').classList.add('on');
    clearTimeout(handleEvent.t);
    handleEvent.t = setTimeout(() => $('banner').classList.remove('on'), 1300);
  } else if (e.type === 'sweep') {
    audio.play('bw-sweep');
  } else if (e.type === 'frame') {
    rebuildPins();
    syncHud();
  } else if (e.type === 'over') {
    // Persist best and unlocks.
    const prevBest = bowlSave.best[game.pattern.id] || 0;
    if (e.score > prevBest) bowlSave.best[game.pattern.id] = e.score;
    const hi = Math.max(...Object.values(bowlSave.best), 0);
    const unlocked = 1 + PATTERNS.filter((p, i) => i > 0 && hi >= p.unlockAt).length;
    bowlSave.unlocked = Math.max(bowlSave.unlocked, Math.min(PATTERNS.length, unlocked));
    persistBowlSave(bowlSave);

    $('panel').innerHTML = `<h1>${icon('pin')} <em>Game over</em></h1>
      <p>${icon(game.pattern.icon)} ${game.pattern.name} lane — final score <strong>${e.score}</strong> / 300.</p>
      <div id="patterns"></div>
      <div class="cta"><strong>A</strong> play again · <strong>↑↓</strong> pick lane · <strong>B</strong> menu</div>`;
    syncPatterns();
    $('overlay').classList.remove('hide');
    channel.feedback({ type: 'slice', combo: 3 });
    audio.play('bw-gameover');
  }
}

// ── Loop ───────────────────────────────────────────────────────────────────
let last = performance.now();
let fps = 0; let frames = 0; let fpsMark = last;

const keys = {};
window.addEventListener('keydown', (e) => {
  keys[e.key] = true;
  if (e.key === 'ArrowUp') { e.preventDefault(); changePattern(-1); }
  if (e.key === 'ArrowDown') { e.preventDefault(); changePattern(1); }
  // Space/Enter start a charge via the channel's onA; release bowls.
});
window.addEventListener('keyup', (e) => {
  keys[e.key] = false;
  if (e.key === ' ' || e.key === 'Enter') releaseCharge();
});

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 1 / 20);
  last = now;
  if (dt <= 0) return;
  frames += 1;
  if (now - fpsMark >= 500) { fps = (frames * 1000) / (now - fpsMark); frames = 0; fpsMark = now; }

  const aim = channel.poll(now);
  // The pointer picks the spot the ball would cross the headpin line at
  // (straight): the full screen spans ±AIM_SPAN m there — the lane, its
  // gutters, and room to aim off-centre and let the hook bring it back.
  if (game.state === 'aim' && Number.isFinite(aim.x)) {
    const target = (Math.max(0, Math.min(1, aim.x)) - 0.5) * 2 * AIM_SPAN;
    game.aimOffset = Math.atan2(target, HEADPIN_Z);
  }

  if (charge) {
    if (!started || game.state !== 'aim') cancelCharge();
    else if (now - charge.t0 > CHARGE_MAX_MS) releaseCharge();
    else $('power').style.width = `${Math.round(chargePower(now) * 100)}%`;
  }

  game.update(now, dt);
  if (game.pins !== pinsRef) { rebuildPins(); syncHud(); }   // after any sweep
  burst.update(dt);
  step(now, dt);
  renderer.render(scene, camera);
}

function step(now, dt) {
  const b = game.ball;
  ball.position.set(b.x, 0.13, b.z);
  const speed = Math.hypot(b.vx, b.vz);
  // Roll the ball visually: forward roll + a little side spin lean.
  ball.rotation.x -= speed * dt / 0.13;
  ball.rotation.z = b.spin * 0.35;

  // Pins: fall in the direction they were struck.
  for (let i = 0; i < game.pins.length; i += 1) {
    const p = game.pins[i];
    const mesh = pinMeshes[i];
    if (!mesh) continue;
    let fall = pinFall[i];
    if (!fall) { fall = pinFall[i] = { t: 0, ax: 0, dir: 1 }; }
    if (!p.standing && fall.t < 1) {
      fall.t = Math.min(1, fall.t + dt * (2.4 + (p.impact || 0) * 0.08));
      if (fall.ax === 0) fall.ax = p.fallAxis || 0;
    } else if (p.standing) {
      fall.t = 0; fall.ax = 0;
    }
    const ease = fall.t * fall.t * (3 - 2 * fall.t);
    mesh.position.set(p.x, 0, p.z);
    mesh.rotation.set(0, 0, 0);
    // Topple around an axis perpendicular to the fall direction.
    mesh.rotateY(-fall.ax);
    mesh.rotateX(-ease * (Math.PI / 2));
    mesh.rotateY(fall.ax);
    mesh.position.y = -ease * 0.04;
  }

  // Sweep bar animation.
  if (game.state === 'sweep') {
    sweepBar.visible = true;
    const t = Math.min(1, game.sweepMs / 750);
    // glide forward over the pins then back
    const go = t < 0.55 ? t / 0.55 : 1 - (t - 0.55) / 0.45;
    sweepBar.position.set(0, 0.22, HEADPIN_Z - 0.6 + go * 1.8);
  } else {
    sweepBar.visible = false;
  }

  // Aim arrow and hook preview while aiming.
  aimArrow.visible = started && game.state === 'aim';
  hookLine.visible = aimArrow.visible;
  if (aimArrow.visible) {
    const ax = Math.sin(game.aimOffset) * 1.2;
    const az = Math.cos(game.aimOffset) * 1.2;
    aimArrow.position.set(ax, 0.3, az);
    aimArrow.rotation.z = -game.aimOffset;
    // Preview arc: the real physics, ghost-rolled with the remembered hook
    // at medium pace (only re-run when the aim or hook actually changes).
    const key = `${game.aimOffset.toFixed(4)}|${lastHookHint}|${game.patternIndex}`;
    if (key !== previewKey) {
      previewKey = key;
      const pts = previewPath(game.patternIndex, game.aimOffset, lastHookHint)
        .map((p) => new THREE.Vector3(p.x, 0.02, p.z));
      hookLine.geometry.dispose();
      hookLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    }
  }

  shake = Math.max(0, shake - dt * 2.2);
  shakeCam = shake;
  const back = 3.4;
  let camZ = -back;
  if (game.state === 'roll') camZ = Math.max(-back, b.z - 2.4);
  else if (game.state === 'sweep') camZ = Math.max(-back, HEADPIN_Z - 3.5);
  camera.position.lerp(new THREE.Vector3(0, 1.15, camZ), Math.min(1, dt * 3));
  camera.position.x += (Math.random() - 0.5) * 0.04 * shakeCam;
  camera.position.y += (Math.random() - 0.5) * 0.03 * shakeCam;
  const lookZ = game.state === 'aim' ? HEADPIN_Z : Math.min(HEADPIN_Z, Math.max(4, b.z + 3));
  camera.lookAt(0, 0.3, lookZ);

  pinGlow.intensity = 0.8 + Math.sin(now / 400) * 0.1;
}

function resize() {
  const w = Math.max(1, window.innerWidth);
  const h = Math.max(1, window.innerHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  channel.pointer.setViewport(w, h);
}
window.addEventListener('resize', resize);

setInterval(() => {
  if (!$('debug').classList.contains('on')) return;
  $('debug').textContent = [
    `fps       ${fps.toFixed(0)}`,
    `state     ${game.state} · frame ${game.frameIndex + 1} ball ${game.ballInFrame + 1}`,
    `ball      ${game.ball.x.toFixed(2)}, ${game.ball.z.toFixed(2)} spin ${game.ball.spin.toFixed(2)}`,
    `standing  ${game.standingCount()} · pattern ${game.pattern.id}`,
    `hook mem  ${lastHookHint.toFixed(2)}`,
    `gyro map  ${channel.pointer.describeMap()}`,
    `sensor    ${channel.link.rate.toFixed(0)} Hz`,
  ].join('\n');
}, 250);

hydrateIcons();
applyPattern(0);
syncPatterns();
syncHud();
resize();
camera.position.set(0, 1.15, -3.4);
camera.lookAt(0, 0.3, HEADPIN_Z);

if (launchData && launchData.splash) {
  launchData.splash.addEventListener('animationend', () => launchData.splash.remove(), { once: true });
}
requestAnimationFrame(frame);

window.__senwii = {
  get game() { return game; },
  channel, pointer: channel.pointer, scene, camera, renderer, step, startGame,
  fps: () => fps,
};
