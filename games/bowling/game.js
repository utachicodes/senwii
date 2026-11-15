import * as THREE from '/vendor/three/three.module.js';
import { consumeLaunchSplash } from '../../core/splash.js';

// Carry the menu's launch banner across the navigation, then fade it out.
const launchData = consumeLaunchSplash();
import { createChannel } from '../../core/channel.js';
import { SwingDetector } from '../../core/gesture.js';
import { Game, LANE, HEADPIN_Z, PIN_RADIUS } from './logic.js';

/**
 * Bowling — renderer. Ten-pin logic lives in logic.js; this just draws the
 * lane, pins and ball and turns swings into roll()s, same shape as golf.
 */

const $ = (id) => document.getElementById(id);

const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a2230);
scene.fog = new THREE.Fog(0x1a2230, 14, 28);

const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 60);

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const key = new THREE.DirectionalLight(0xfff2d0, 1.3);
key.position.set(2, 10, 6);
scene.add(key);
const aisleGlow = new THREE.PointLight(0x5b8cff, 0.8, 20);
aisleGlow.position.set(0, 3, HEADPIN_Z);
scene.add(aisleGlow);

// ── Lane ─────────────────────────────────────────────────────────────────
const laneGeo = new THREE.PlaneGeometry(LANE.HALF_WIDTH * 2, LANE.LENGTH + 2);
laneGeo.rotateX(-Math.PI / 2);
const lane = new THREE.Mesh(laneGeo, new THREE.MeshStandardMaterial({ color: 0xcfa05a, roughness: 0.35 }));
lane.position.z = LANE.LENGTH / 2 - 1;
scene.add(lane);

for (const side of [-1, 1]) {
  const gutter = new THREE.Mesh(
    new THREE.PlaneGeometry(0.4, LANE.LENGTH + 2),
    new THREE.MeshStandardMaterial({ color: 0x0e131c, roughness: 0.6 }),
  );
  gutter.rotateX(-Math.PI / 2);
  gutter.position.set(side * (LANE.HALF_WIDTH + 0.2), -0.02, LANE.LENGTH / 2 - 1);
  scene.add(gutter);
}

// ── Pins (simple cone-on-cylinder) and ball ─────────────────────────────────
const pinHeight = 0.38;
function makePin() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(PIN_RADIUS * 0.55, PIN_RADIUS, pinHeight, 10),
    new THREE.MeshStandardMaterial({ color: 0xf4f1ea, roughness: 0.3 }),
  );
  body.position.y = pinHeight / 2;
  g.add(body);
  const neck = new THREE.Mesh(
    new THREE.SphereGeometry(PIN_RADIUS * 0.6, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0xe2432f, roughness: 0.35 }),
  );
  neck.position.y = pinHeight * 0.78;
  g.add(neck);
  return g;
}

let game = new Game({ onEvent: handleEvent });
let pinMeshes = game.pins.map(() => {
  const m = makePin();
  scene.add(m);
  return m;
});

const ball = new THREE.Mesh(
  new THREE.SphereGeometry(0.13, 18, 14),
  new THREE.MeshStandardMaterial({ color: 0x5b8cff, roughness: 0.2, metalness: 0.1 }),
);
scene.add(ball);

const aimArrow = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.5, 4),
  new THREE.MeshBasicMaterial({ color: 0xfff1a8, transparent: true, opacity: 0.9 }));
aimArrow.rotation.x = Math.PI / 2;
scene.add(aimArrow);

function syncPins() {
  for (let i = 0; i < game.pins.length; i += 1) {
    const p = game.pins[i];
    const mesh = pinMeshes[i];
    mesh.position.set(p.x, 0, p.z);
    mesh.visible = p.standing;
  }
}
syncPins();

// ── Wiring ─────────────────────────────────────────────────────────────────
const swing = new SwingDetector({ onThreshold: 120, minTravel: 20 });
let started = false;

const channel = createChannel({
  room: launchData?.room,
  onA: () => { if (!started || game.state === 'over') startGame(); },
  onSample: (sample, dt, now) => {
    const s = swing.update(channel.pointer.rateDps, dt, now);
    if (s && started && game.state === 'aim') {
      const power = Math.min(1, s.peak / 420);
      game.roll(power);
      channel.feedback({ type: 'slice', combo: 1 });
      channel.audio.play('impact');
      flashPower(power);
    }
  },
});

function startGame() {
  started = true;
  game = new Game({ onEvent: handleEvent });
  pinMeshes.forEach((m) => scene.remove(m));
  pinMeshes = game.pins.map(() => { const m = makePin(); scene.add(m); return m; });
  syncPins();
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
  if (e.type === 'roll') syncHud();
  else if (e.type === 'settled') {
    syncHud();
    syncPins();
    $('banner').textContent = e.pinsDown === 10 ? 'STRIKE!' : `${e.pinsDown} pin${e.pinsDown === 1 ? '' : 's'}`;
    $('banner').classList.add('on');
    clearTimeout(handleEvent.t);
    handleEvent.t = setTimeout(() => $('banner').classList.remove('on'), 1300);
  } else if (e.type === 'frame') {
    syncPins();
    syncHud();
  } else if (e.type === 'over') {
    $('panel').innerHTML = `<h1>🎳 <em>Game over</em></h1>
      <p>Final score: ${e.score} / 300.</p>
      <div class="cta"><strong>A</strong> play again · <strong>B</strong> menu</div>`;
    $('overlay').classList.remove('hide');
    channel.feedback({ type: 'slice', combo: 3 });
    channel.audio.play('swipe');
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
  step(now, dt);
  renderer.render(scene, camera);
}

function step(now, dt) {
  const b = game.ball;
  ball.position.set(b.x, 0.13, b.z);

  aimArrow.visible = started && game.state === 'aim';
  if (aimArrow.visible) {
    const ax = Math.sin(game.aimOffset) * 1.2;
    const az = Math.cos(game.aimOffset) * 1.2;
    aimArrow.position.set(ax, 0.3, az);
    aimArrow.rotation.z = -game.aimOffset;
  }

  const back = 3.4;
  const cx = b.x - Math.sin(game.aimOffset) * 0;
  const cz = game.state === 'aim' ? -back : Math.max(-back, b.z - 2.2);
  camera.position.lerp(new THREE.Vector3(cx * 0.3, 1.1, cz), Math.min(1, dt * 3));
  camera.lookAt(0, 0.3, HEADPIN_Z);
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
  game, channel, pointer: channel.pointer, scene, camera, renderer, step, startGame,
  fps: () => fps,
};
