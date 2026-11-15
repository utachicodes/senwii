import * as THREE from '/vendor/three/three.module.js';
import { consumeLaunchSplash } from '../../core/splash.js';

// Carry the menu's launch banner across the navigation, then fade it out.
const launchData = consumeLaunchSplash();
import { createChannel } from '../../core/channel.js';
import { SwingDetector } from '../../core/gesture.js';
import { ParticleBurst, dotTexture, canvasTexture } from '../shared/fx.js';
import { Game, LANE, HEADPIN_Z, PIN_RADIUS } from './logic.js';

/**
 * Bowling — renderer. Ten-pin logic lives in logic.js; this draws the lane,
 * pins and ball, turns swings into roll()s, and carries its own sound design
 * and impact particles — the same tier as fruit-ninja/shooting-range/
 * alien-attack's custom cues, not the shared generic ones.
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
// Overhead lane lights — a row of warm pools down the lane, the one thing
// that actually reads as "bowling alley" rather than "flat plane in the dark".
for (let i = 0; i < 5; i += 1) {
  const l = new THREE.PointLight(0xffd9a0, 0.55, 7, 2);
  l.position.set(0, 2.6, i * 3.6);
  scene.add(l);
}
const pinGlow = new THREE.PointLight(0x9fd6ff, 0.9, 10);
pinGlow.position.set(0, 2.2, HEADPIN_Z + 0.6);
scene.add(pinGlow);

// ── Lane: procedural wood-plank texture, not a flat fill ───────────────────
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
  // A little random grain noise so it doesn't read as a repeating tile.
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
  map: laneTex, roughness: 0.28, metalness: 0.08, envMapIntensity: 0.6,
}));
lane.position.z = LANE.LENGTH / 2 - 1;
scene.add(lane);

// Foul-line arrows, a real decal rather than empty wood.
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

// Pit backdrop — without it the pins float in pure black.
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

// ── Pins: a real lathed silhouette (neck, shoulder, head) with a red band ──
const pinHeight = 0.38;
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

let game = new Game({ onEvent: handleEvent });
let pinMeshes = [];
let pinFall = [];     // per-pin { t, dir } animation state, parallel to game.pins
let pinsRef = null;   // identity check: logic.js swaps in a fresh pins[] on

function rebuildPins() {
  pinMeshes.forEach((m) => scene.remove(m));
  pinMeshes = game.pins.map(() => { const m = makePin(); scene.add(m); return m; });
  pinFall = game.pins.map(() => ({ t: 0, dir: 1 }));
  pinsRef = game.pins;
}
rebuildPins();

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

// Impact particles: wood-chip sparks at each felled pin, scaled for strikes.
const burst = new ParticleBurst(scene, { texture: dotTexture('#ffe9b0'), maxParticles: 120 });

// ── Wiring ─────────────────────────────────────────────────────────────────
const swing = new SwingDetector({ onThreshold: 120, minTravel: 20 });
let started = false;
let shake = 0;

const channel = createChannel({
  room: launchData?.room,
  onA: () => { if (!started || game.state === 'over') startGame(); },
  onSample: (sample, dt, now) => {
    const s = swing.update(channel.pointer.rateDps, dt, now);
    if (s && started && game.state === 'aim') {
      const power = Math.min(1, s.peak / 420);
      game.roll(power);
      channel.feedback({ type: 'slice', combo: 1 });
      channel.audio.play('bw-release');
      flashPower(power);
    }
  },
});

// Bowling's own cues — layered noise/tone, not the generic shared ones.
// Every cue is still overridable by dropping audio/<name>.{mp3,wav,ogg}.
const { audio } = channel;

audio.register('bw-release', (a) => {
  a.noise({ dur: 0.22, gain: 0.1, type: 'lowpass', freq: 500, sweepTo: 150 });
  a.tone({ freq: 90, dur: 0.18, type: 'sine', gain: 0.12, slideTo: 60 });
});

// A single pin, or a few — a sharp crack plus a wooden clatter.
audio.register('bw-pins', (a, { pins = 1 } = {}) => {
  const n = Math.min(pins, 10);
  a.noise({ dur: 0.1, gain: 0.3, type: 'bandpass', freq: 1200, q: 1.4 });
  a.tone({ freq: 500, slideTo: 260, dur: 0.1, type: 'triangle', gain: 0.18 });
  for (let i = 0; i < Math.min(4, n); i += 1) {
    a.noise({
      dur: 0.08, gain: 0.14, type: 'bandpass', freq: 700 + Math.random() * 900,
      q: 2, delay: 0.03 + i * 0.045,
    });
  }
});

// The strike: a big crash, scattered clatter, and a bright resolving chime.
audio.register('bw-strike', (a) => {
  a.noise({ dur: 0.4, gain: 0.42, type: 'lowpass', freq: 2400, sweepTo: 300 });
  a.tone({ freq: 160, dur: 0.3, type: 'triangle', gain: 0.24, slideTo: 70 });
  for (let i = 0; i < 7; i += 1) {
    a.noise({
      dur: 0.1, gain: 0.16, type: 'bandpass', freq: 500 + Math.random() * 1400,
      q: 1.8, delay: 0.04 + i * 0.05 + Math.random() * 0.03,
    });
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

function startGame() {
  started = true;
  game = new Game({ onEvent: handleEvent });
  rebuildPins();
  $('overlay').classList.add('hide');
  syncHud();
}

function flashPower(p) {
  const el = $('power');
  el.style.width = `${Math.round(p * 100)}%`;
  el.parentElement.classList.add('on');
  clearTimeout(flashPower.t);
  flashPower.t = setTimeout(() => el.parentElement.classList.remove('on'), 1200);
}

function handleEvent(e) {
  if (e.type === 'roll') {
    syncHud();
  } else if (e.type === 'pin-down') {
    const pin = game.pins[e.id];
    if (pin) {
      burst.spawn(new THREE.Vector3(pin.x, 0.2, pin.z), {
        count: 10, speed: 1.6, size: 0.05, color: 0xffe9b0, life: 0.5,
      });
    }
    if (pinFall[e.id]) pinFall[e.id].dir = -1;
  } else if (e.type === 'settled') {
    syncHud();
    const prev = game.rolls[game.rolls.length - 2];
    const isSpare = game.ballInFrame === 1 && prev !== 10 && prev + e.pinsDown === 10;
    if (e.pinsDown === 10) { audio.play('bw-strike'); shake = 1; }
    else if (isSpare) audio.play('bw-spare');
    else if (e.pinsDown === 0) audio.play('bw-gutter');
    else audio.play('bw-pins', { pins: e.pinsDown });
    $('banner').textContent = e.pinsDown === 10 ? 'STRIKE!' : isSpare ? 'SPARE!' : `${e.pinsDown} pin${e.pinsDown === 1 ? '' : 's'}`;
    $('banner').classList.add('on');
    clearTimeout(handleEvent.t);
    handleEvent.t = setTimeout(() => $('banner').classList.remove('on'), 1300);
  } else if (e.type === 'frame') {
    rebuildPins();
    syncHud();
  } else if (e.type === 'over') {
    $('panel').innerHTML = `<h1>🎳 <em>Game over</em></h1>
      <p>Final score: ${e.score} / 300.</p>
      <div class="cta"><strong>A</strong> play again · <strong>B</strong> menu</div>`;
    $('overlay').classList.remove('hide');
    channel.feedback({ type: 'slice', combo: 3 });
    audio.play('bw-gameover');
  }
}

function syncHud() {
  $('frame').textContent = `frame ${Math.min(game.frameIndex + 1, 10)} / 10`;
  $('score').textContent = String(game.score());
  $('ball-no').textContent = `ball ${game.ballInFrame + 1}`;
}

// ── Loop ───────────────────────────────────────────────────────────────────
let last = performance.now();
let fps = 0; let frames = 0; let fpsMark = last;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 1 / 20);
  last = now;
  if (dt <= 0) return;
  frames += 1;
  if (now - fpsMark >= 500) { fps = (frames * 1000) / (now - fpsMark); frames = 0; fpsMark = now; }

  const aim = channel.poll(now);
  if (game.state === 'aim') game.aimOffset = (aim.x - 0.5) * 0.9;
  game.update(now, dt);
  // The 10th frame's bonus-ball rack reset (logic.js) fires no event of its
  // own — catch any pins[] swap here rather than missing that one case.
  if (game.pins !== pinsRef) rebuildPins();
  burst.update(dt);
  step(now, dt);
  renderer.render(scene, camera);
}

function step(now, dt) {
  const b = game.ball;
  ball.position.set(b.x, 0.13, b.z);
  ball.rotation.x += dt * 8 * (1 + Math.hypot(b.vx, b.vz) * 0.3);

  for (let i = 0; i < game.pins.length; i += 1) {
    const p = game.pins[i];
    const mesh = pinMeshes[i];
    const fall = pinFall[i];
    if (!p.standing && fall.t < 1) fall.t = Math.min(1, fall.t + dt * 2.6);
    else if (p.standing) fall.t = 0;
    const ease = fall.t * fall.t * (3 - 2 * fall.t);
    mesh.position.set(p.x, 0, p.z);
    mesh.rotation.set(ease * (Math.PI / 2) * fall.dir, 0, ease * 0.6 * fall.dir);
    mesh.position.y = -ease * 0.05;
  }

  aimArrow.visible = started && game.state === 'aim';
  if (aimArrow.visible) {
    const ax = Math.sin(game.aimOffset) * 1.2;
    const az = Math.cos(game.aimOffset) * 1.2;
    aimArrow.position.set(ax, 0.3, az);
    aimArrow.rotation.z = -game.aimOffset;
  }

  shake = Math.max(0, shake - dt * 2.2);
  const back = 3.4;
  const cz = game.state === 'aim' ? -back : Math.max(-back, b.z - 2.2);
  camera.position.lerp(new THREE.Vector3(0, 1.1, cz), Math.min(1, dt * 3));
  camera.position.x += (Math.random() - 0.5) * 0.04 * shake;
  camera.position.y += (Math.random() - 0.5) * 0.03 * shake;
  camera.lookAt(0, 0.3, HEADPIN_Z);

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
    `ball      ${game.ball.x.toFixed(2)}, ${game.ball.z.toFixed(2)}`,
    `standing  ${game.standingCount()}`,
    `gyro map  ${channel.pointer.describeMap()}`,
    `sensor    ${channel.link.rate.toFixed(0)} Hz`,
  ].join('\n');
}, 250);

resize();
syncHud();
camera.position.set(0, 1.1, -3.4);
camera.lookAt(0, 0.3, HEADPIN_Z);
requestAnimationFrame(frame);

window.__senwii = {
  get game() { return game; },   // startGame() replaces the instance; stay live across restarts
  channel, pointer: channel.pointer, scene, camera, renderer, step, startGame,
  fps: () => fps,
};
