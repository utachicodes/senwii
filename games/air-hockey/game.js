import * as THREE from '/vendor/three/three.module.js';
import { consumeLaunchSplash } from '../../core/splash.js';

// Carry the menu's launch banner across the navigation, then fade it out.
const launchData = consumeLaunchSplash();
import { createChannel } from '../../core/channel.js';
import { ParticleBurst, dotTexture, canvasTexture } from '../shared/fx.js';
import {
  Match, TABLE, GOAL_WIDTH, PLAYER_Z, AI_Z, PUCK_RADIUS, PADDLE_RADIUS,
} from './logic.js';
import { icon, hydrateIcons } from '../../core/icons.js';

/**
 * Air Hockey — renderer. The rally runs in logic.js; the pointer's full
 * position IS the mallet (no swing input — positioning is the whole game).
 * Carries its own sound design and impact particles, same tier as
 * fruit-ninja/shooting-range/alien-attack.
 */

const $ = (id) => document.getElementById(id);

const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x060a12);
scene.fog = new THREE.Fog(0x060a12, 3, 8.5);

const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 20);
camera.position.set(0, 2.15, PLAYER_Z + 0.9);
camera.lookAt(0, 0, 0);

scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const key = new THREE.DirectionalLight(0xdfeeff, 1.2);
key.position.set(1, 5, 2);
scene.add(key);
const rinkGlow = new THREE.PointLight(0x5b8cff, 1.0, 5);
rinkGlow.position.set(0, 1.6, 0);
scene.add(rinkGlow);

const mat = (c, r = 0.5, m = 0) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m });

// ── Rink surface: a procedural ice texture, not a flat fill ─────────────────
const iceTex = canvasTexture((g, s) => {
  const grad = g.createLinearGradient(0, 0, 0, s);
  grad.addColorStop(0, '#e8f4ff'); grad.addColorStop(1, '#c3ddf2');
  g.fillStyle = grad; g.fillRect(0, 0, s, s);
  for (let i = 0; i < 260; i += 1) {
    g.strokeStyle = `rgba(255,255,255,${0.04 + Math.random() * 0.08})`;
    g.lineWidth = 1 + Math.random();
    g.beginPath();
    const x = Math.random() * s; const y = Math.random() * s;
    g.moveTo(x, y);
    g.lineTo(x + (Math.random() - 0.5) * 60, y + (Math.random() - 0.5) * 60);
    g.stroke();
  }
}, 512);

const top = new THREE.Mesh(
  new THREE.PlaneGeometry(TABLE.WIDTH, TABLE.LENGTH),
  new THREE.MeshStandardMaterial({ map: iceTex, roughness: 0.15, metalness: 0.05 }),
);
top.rotation.x = -Math.PI / 2;
scene.add(top);

const lineMat = new THREE.MeshBasicMaterial({ color: 0xd4302a, transparent: true, opacity: 0.8 });
function line(w, d, x, z) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.004, d), lineMat);
  m.position.set(x, 0.003, z);
  scene.add(m);
}
line(TABLE.WIDTH, 0.016, 0, 0);                               // centre line
const centreRing = new THREE.Mesh(
  new THREE.RingGeometry(0.16, 0.176, 32),
  new THREE.MeshBasicMaterial({ color: 0xd4302a, transparent: true, opacity: 0.8, side: THREE.DoubleSide }),
);
centreRing.rotation.x = -Math.PI / 2;
centreRing.position.y = 0.003;
scene.add(centreRing);

// Raised side rails — real geometry, so the puck visibly bounces off a wall
// instead of an invisible boundary.
const railMat = mat(0x1b2a40, 0.4, 0.3);
for (const side of [-1, 1]) {
  const rail = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.06, TABLE.LENGTH + 0.06), railMat);
  rail.position.set(side * (TABLE.WIDTH / 2 + 0.015), 0.03, 0);
  scene.add(rail);
}
// End rails, split around the goal mouth so the goal itself stays open.
for (const zSign of [1, -1]) {
  const z = zSign * (TABLE.LENGTH / 2 + 0.015);
  const sideWidth = (TABLE.WIDTH - GOAL_WIDTH) / 2;
  for (const xSign of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(sideWidth, 0.06, 0.03), railMat);
    rail.position.set(xSign * (GOAL_WIDTH / 2 + sideWidth / 2), 0.03, z);
    scene.add(rail);
  }
}
// Goal pockets: a dark recess so the goal mouth reads as a real opening.
const pocketMat = new THREE.MeshStandardMaterial({ color: 0x030507, roughness: 0.9 });
for (const z of [PLAYER_Z, AI_Z]) {
  const pocket = new THREE.Mesh(new THREE.BoxGeometry(GOAL_WIDTH, 0.05, 0.14), pocketMat);
  pocket.position.set(0, -0.015, z + Math.sign(z) * 0.07);
  scene.add(pocket);
}
const goalGlowMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 });
for (const z of [PLAYER_Z, AI_Z]) {
  const goal = new THREE.Mesh(new THREE.PlaneGeometry(GOAL_WIDTH, 0.02), goalGlowMat);
  goal.rotation.x = -Math.PI / 2;
  goal.position.set(0, 0.004, z);
  scene.add(goal);
}

// ── Puck: a glowing disc with a speed trail ─────────────────────────────────
const puck = new THREE.Mesh(
  new THREE.CylinderGeometry(PUCK_RADIUS, PUCK_RADIUS, 0.025, 20),
  new THREE.MeshStandardMaterial({ color: 0x141a24, roughness: 0.3, emissive: 0x1a2a66, emissiveIntensity: 0.3 }),
);
scene.add(puck);
const trailMat = new THREE.SpriteMaterial({ map: dotTexture('#5b8cff'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 });
const trail = Array.from({ length: 6 }, () => {
  const s = new THREE.Sprite(trailMat.clone());
  s.scale.setScalar(PUCK_RADIUS * 2.4);
  scene.add(s);
  return s;
});

// ── Mallets: a dome over a flat base, the real air-hockey shape ─────────────
function makeMallet(colour) {
  const g = new THREE.Group();
  const base = new THREE.Mesh(new THREE.CylinderGeometry(PADDLE_RADIUS, PADDLE_RADIUS * 1.08, 0.035, 24), mat(colour, 0.3));
  base.position.y = 0.0175;
  g.add(base);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(PADDLE_RADIUS * 0.72, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), mat(colour, 0.2, 0.1));
  dome.position.y = 0.035;
  g.add(dome);
  scene.add(g);
  return g;
}
const playerMallet = makeMallet(0xffb000);
const aiMallet = makeMallet(0x5b8cff);

// Impact particles.
const hitSparks = new ParticleBurst(scene, { texture: dotTexture('#eaf2ff'), maxParticles: 60 });
const goalSparks = new ParticleBurst(scene, { texture: dotTexture('#ffd27a'), maxParticles: 100 });

// ── Wiring ─────────────────────────────────────────────────────────────────
const match = new Match({ onEvent: handleEvent });
let shake = 0;

const channel = createChannel({
  room: launchData?.room,
  onA: () => { if (match.state === 'ready' || match.state === 'over') startMatch(); },
});

// Air Hockey's own cues — a sharp plastic click, a flatter wall clack, and a
// real goal buzzer instead of the shared generic ones.
const { audio } = channel;

audio.register('ah-hit', (a, { speed = 2 } = {}) => {
  const pitch = 1 + Math.min(1, speed / 6) * 0.6;
  a.noise({ dur: 0.05, gain: 0.3, type: 'highpass', freq: 2200 * pitch });
  a.tone({ freq: 700 * pitch, dur: 0.04, type: 'square', gain: 0.14, attack: 0.001 });
});

audio.register('ah-wall', (a) => {
  a.noise({ dur: 0.04, gain: 0.16, type: 'bandpass', freq: 1500, q: 2 });
});

audio.register('ah-goal', (a) => {
  a.tone({ freq: 220, dur: 0.5, type: 'sawtooth', gain: 0.22, attack: 0.01 });
  a.tone({ freq: 220, dur: 0.5, type: 'sawtooth', gain: 0.18, detune: 8, delay: 0.02 });
  a.noise({ dur: 0.5, gain: 0.1, type: 'lowpass', freq: 1200, sweepTo: 300 });
});

audio.register('ah-scored-on', (a) => {
  a.tone({ freq: 180, dur: 0.3, type: 'sine', gain: 0.18, slideTo: 100 });
});

audio.register('ah-win', (a) => {
  a.tone({ freq: 659.25, dur: 0.14, type: 'sine', gain: 0.2 });
  a.tone({ freq: 880, dur: 0.16, type: 'sine', gain: 0.2, delay: 0.12 });
  a.tone({ freq: 1318.5, dur: 0.4, type: 'sine', gain: 0.22, delay: 0.26 });
});

audio.register('ah-lose', (a) => {
  a.tone({ freq: 240, dur: 0.45, type: 'sawtooth', gain: 0.18, slideTo: 80 });
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

let prevPuckSpeed = 0;
function handleEvent(e) {
  switch (e.type) {
    case 'goal':
      syncHud();
      banner(e.who === 'player' ? 'GOAL!' : 'SCORED ON');
      channel.feedback({ type: e.who === 'player' ? 'slice' : 'miss' });
      audio.play(e.who === 'player' ? 'ah-goal' : 'ah-scored-on');
      goalSparks.spawn(new THREE.Vector3(0, 0.05, e.who === 'player' ? AI_Z : PLAYER_Z), {
        count: 28, speed: 2.2, size: 0.05, color: 0xffd27a, life: 0.7, upBias: 0.6,
      });
      shake = 1;
      break;
    case 'hit':
      audio.play('ah-hit', { speed: prevPuckSpeed });
      hitSparks.spawn(new THREE.Vector3(match.puck.x, 0.04, match.puck.z), {
        count: 10, speed: 1.4, size: 0.035, color: 0xeaf2ff, life: 0.3, upBias: 0.4,
      });
      if (e.by === 'player') channel.feedback({ type: 'slice', combo: 1 });
      break;
    case 'over': {
      const won = e.winner === 'player';
      $('panel').innerHTML = `<h1>${won ? `${icon('trophy')} <em>You win!</em>` : `${icon('skull')} <em>Defeated</em>`}</h1>
        <p>Final score ${match.score.player}-${match.score.ai}.</p>
        <div class="cta"><strong>A</strong> rematch · <strong>B</strong> menu</div>`;
      $('overlay').classList.remove('hide');
      channel.feedback({ type: won ? 'slice' : 'bomb' });
      audio.play(won ? 'ah-win' : 'ah-lose');
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
  prevPuckSpeed = Math.hypot(match.puck.vx, match.puck.vz);
  hitSparks.update(dt);
  goalSparks.update(dt);
  step(dt);
  renderer.render(scene, camera);
}

const trailHistory = [];
function step(dt) {
  puck.position.set(match.puck.x, 0.015, match.puck.z);
  puck.rotation.y += dt * 6;
  playerMallet.position.set(match.paddle.x, 0, match.paddle.z);
  aiMallet.position.set(match.aiPaddle.x, 0, match.aiPaddle.z);

  // A short fading trail behind the puck, visible only once it has real pace.
  const speed = Math.hypot(match.puck.vx, match.puck.vz);
  trailHistory.unshift({ x: match.puck.x, z: match.puck.z });
  if (trailHistory.length > trail.length) trailHistory.length = trail.length;
  trail.forEach((s, i) => {
    const p = trailHistory[i];
    if (!p || speed < 0.8) { s.material.opacity = 0; return; }
    s.position.set(p.x, 0.012, p.z);
    s.material.opacity = Math.max(0, (1 - i / trail.length) * Math.min(1, speed / 4) * 0.5);
  });

  shake = Math.max(0, shake - dt * 2.5);
  camera.position.x = (Math.random() - 0.5) * 0.03 * shake;
  camera.position.y = 2.15 + (Math.random() - 0.5) * 0.03 * shake;
  rinkGlow.intensity = 0.9 + Math.sin(performance.now() / 500) * 0.1;
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

hydrateIcons();
