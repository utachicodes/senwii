import * as THREE from '/vendor/three/three.module.js';
import { consumeLaunchSplash } from '../../core/splash.js';

// Carry the menu's launch banner across the navigation, then fade it out.
const launchData = consumeLaunchSplash();
import { createChannel } from '../../core/channel.js';
import {
  Match, TABLE, GOAL_WIDTH, PLAYER_Z, AI_Z, PUCK_RADIUS, PADDLE_RADIUS,
} from './logic.js';

/**
 * Air Hockey — renderer. The rally runs in logic.js; the pointer's full
 * position IS the mallet (no swing input — positioning is the whole game).
 */

const $ = (id) => document.getElementById(id);

const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0c1420);
scene.fog = new THREE.Fog(0x0c1420, 3, 8);

const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 20);
camera.position.set(0, 2.1, PLAYER_Z + 0.9);
camera.lookAt(0, 0, 0);

scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const key = new THREE.DirectionalLight(0xffffff, 1.2);
key.position.set(1, 5, 2);
scene.add(key);

const mat = (c, r = 0.5) => new THREE.MeshStandardMaterial({ color: c, roughness: r });

// Table.
const top = new THREE.Mesh(new THREE.PlaneGeometry(TABLE.WIDTH, TABLE.LENGTH), mat(0x163a5c, 0.4));
top.rotation.x = -Math.PI / 2;
scene.add(top);

const lineMat = mat(0xeaf2ff, 0.3);
function line(w, d, x, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.004, d), lineMat);
  m.position.set(x, 0.003, z);
  scene.add(m);
}
line(TABLE.WIDTH, 0.02, 0, 0);                               // centre line
line(0.02, TABLE.LENGTH, -TABLE.WIDTH / 2 + 0.01, 0);
line(0.02, TABLE.LENGTH, TABLE.WIDTH / 2 - 0.01, 0);
line(0.02, TABLE.LENGTH, 0, 0);                               // reused as a faint centre guide

const goalMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 });
for (const z of [PLAYER_Z, AI_Z]) {
  const goal = new THREE.Mesh(new THREE.PlaneGeometry(GOAL_WIDTH, 0.02), goalMat);
  goal.rotation.x = -Math.PI / 2;
  goal.position.set(0, 0.004, z);
  scene.add(goal);
}

const puck = new THREE.Mesh(
  new THREE.CylinderGeometry(PUCK_RADIUS, PUCK_RADIUS, 0.025, 20),
  mat(0x1a2230, 0.3),
);
scene.add(puck);

function makeMallet(colour) {
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(PADDLE_RADIUS, PADDLE_RADIUS * 1.1, 0.05, 20),
    mat(colour, 0.25),
  );
  scene.add(m);
  return m;
}
const playerMallet = makeMallet(0xffb000);
const aiMallet = makeMallet(0x5b8cff);

// ── Wiring ─────────────────────────────────────────────────────────────────
const match = new Match({ onEvent: handleEvent });

const channel = createChannel({
  room: launchData?.room,
  onA: () => { if (match.state === 'ready' || match.state === 'over') startMatch(); },
});

function startMatch() {
  match.start(performance.now());
  $('overlay').classList.add('hide');
  syncHud();
}

function banner(text, ms = 1100) {
  const el = $('banner');
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(banner.t);
  banner.t = setTimeout(() => el.classList.remove('on'), ms);
}

function syncHud() {
  $('p-score').textContent = String(match.score.player);
  $('a-score').textContent = String(match.score.ai);
}

function handleEvent(e) {
  switch (e.type) {
    case 'goal':
      syncHud();
      banner(e.who === 'player' ? 'GOAL!' : 'SCORED ON');
      channel.feedback({ type: e.who === 'player' ? 'slice' : 'miss' });
      channel.audio.play(e.who === 'player' ? 'swipe' : 'fail');
      break;
    case 'hit':
      channel.audio.play('impact');
      if (e.by === 'player') channel.feedback({ type: 'slice', combo: 1 });
      break;
    case 'over': {
      const won = e.winner === 'player';
      $('panel').innerHTML = `<h1>${won ? '🏆 <em>You win!</em>' : '💀 <em>Defeated</em>'}</h1>
        <p>Final score ${match.score.player}-${match.score.ai}.</p>
        <div class="cta"><strong>A</strong> rematch · <strong>B</strong> menu</div>`;
      $('overlay').classList.remove('hide');
      channel.feedback({ type: won ? 'slice' : 'bomb' });
      channel.audio.play(won ? 'swipe' : 'explode');
      break;
    }
    default: break;
  }
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
  match.setPaddle(aim.x, aim.y, dt);
  match.update(now, dt);
  step();
  renderer.render(scene, camera);
}

function step() {
  puck.position.set(match.puck.x, 0.015, match.puck.z);
  playerMallet.position.set(match.paddle.x, 0.025, match.paddle.z);
  aiMallet.position.set(match.aiPaddle.x, 0.025, match.aiPaddle.z);
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
    `match     ${match.state}`,
    `puck      ${match.puck.x.toFixed(2)}, ${match.puck.z.toFixed(2)}`,
    `paddle    ${match.paddle.x.toFixed(2)}, ${match.paddle.z.toFixed(2)}`,
    `sensor    ${channel.link.rate.toFixed(0)} Hz`,
  ].join('\n');
}, 250);

resize();
syncHud();
requestAnimationFrame(frame);

window.__senwii = {
  match, channel, pointer: channel.pointer,
  scene, camera, renderer, step, startMatch,
  fps: () => fps,
};
