import * as THREE from '/vendor/three/three.module.js';
import { consumeLaunchSplash } from '../../core/splash.js';

// Carry the menu's launch banner across the navigation, then fade it out.
const launchData = consumeLaunchSplash();
import { createChannel } from '../../core/channel.js';
import { SwingDetector } from '../../core/gesture.js';
import { Bout, AI, ZONE, zoneOfSwing } from './logic.js';

/**
 * Boxing — renderer. The bout runs in logic.js (HIGH/LOW zones instead of
 * swordplay's continuous blade angle); this draws it and pipes the phone in:
 * pointer vertical position is the held guard, a completed swing is a punch
 * aimed by the gesture's vertical direction.
 */

const $ = (id) => document.getElementById(id);

const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2a2117);
scene.fog = new THREE.Fog(0x2a2117, 6, 20);

const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 60);
camera.position.set(0, 1.5, 5.6);
camera.lookAt(0, 1.3, -2);

scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const spot = new THREE.SpotLight(0xfff2d0, 2.2, 20, Math.PI / 4, 0.4);
spot.position.set(0, 7, 2);
scene.add(spot);

const mat = (c, r = 0.65) => new THREE.MeshStandardMaterial({ color: c, roughness: r });

// Ring.
const mat_canvas = mat(0xb7452f, 0.9);
const ring = new THREE.Mesh(new THREE.CylinderGeometry(4.6, 4.9, 0.5, 24), mat_canvas);
ring.position.y = -0.25;
scene.add(ring);
for (const a of [Math.PI / 4, Math.PI * 0.75, Math.PI * 1.25, Math.PI * 1.75]) {
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.4, 8), mat(0xe8e2d4, 0.4));
  post.position.set(Math.sin(a) * 4.3, 1.1, Math.cos(a) * 4.3 - 2);
  scene.add(post);
}

// Rival.
function makeFighter(colour) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.8, 4, 12), mat(colour));
  body.position.y = 1.0;
  g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), mat(0xcc8f66));
  head.position.y = 1.95;
  g.add(head);
  const glove = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 10), mat(0xe2432f, 0.4));
  glove.position.set(0.55, 1.5, 0.3);
  g.add(glove);
  g.position.z = -3.6;
  scene.add(g);
  return { group: g, glove };
}
const rival = makeFighter(0x8e4fd0);

const telegraph = new THREE.Mesh(
  new THREE.RingGeometry(0.3, 0.42, 20),
  new THREE.MeshBasicMaterial({ color: 0xffb000, transparent: true, opacity: 0 }),
);
telegraph.position.z = -3.0;
scene.add(telegraph);

// Player glove.
const glove = new THREE.Mesh(new THREE.SphereGeometry(0.16, 14, 12), mat(0xffb000, 0.4));
scene.add(glove);

// ── Wiring ─────────────────────────────────────────────────────────────────
const swingDetector = new SwingDetector({ onThreshold: 140, minTravel: 22 });
let punchFlash = 0;
let clang = 0;

const bout = new Bout({ onEvent: handleEvent });

const channel = createChannel({
  room: launchData?.room,
  onA: () => { if (bout.state === 'ready' || bout.state === 'over') startMatch(); },
  onSample: (sample, dt, now) => {
    const sw = swingDetector.update(channel.pointer.rateDps, dt, now);
    const swinging = swingDetector.active;
    const zone = channel.pointer.pos.y < 0.5 ? ZONE.HIGH : ZONE.LOW;
    bout.setGuard(zone, swinging);
    syncGuardHud(zone);
    if (sw) {
      punchFlash = 1;
      bout.punch(sw, now);
    }
  },
});

function startMatch() {
  bout.start(performance.now());
  $('overlay').classList.add('hide');
  syncHud();
}

function banner(text, ms = 1200) {
  const el = $('banner');
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(banner.t);
  banner.t = setTimeout(() => el.classList.remove('on'), ms);
}

function syncHud() {
  const dots = (n) => '●'.repeat(n) + '○'.repeat(Math.max(0, 3 - n));
  $('p-score').textContent = dots(bout.player.points);
  $('a-score').textContent = dots(bout.ai.points);
}

function syncGuardHud(zone) {
  $('guard-high').classList.toggle('on', zone === ZONE.HIGH);
  $('guard-low').classList.toggle('on', zone === ZONE.LOW);
}

function handleEvent(e) {
  switch (e.type) {
    case 'point':
      syncHud();
      banner(e.who === 'player' ? 'LANDED!' : 'HIT TAKEN');
      channel.feedback({ type: e.who === 'player' ? 'slice' : 'miss' });
      channel.audio.play(e.who === 'player' ? 'swipe' : 'fail');
      break;
    case 'blocked':
      banner(e.who === 'ai' ? 'BLOCKED!' : 'GUARDED', 700);
      channel.feedback({ type: 'slice', combo: 1 });
      channel.audio.play('impact');
      clang = 1;
      break;
    case 'over': {
      const won = e.winner === 'player';
      $('panel').innerHTML = `<h1>${won ? '🏆 <em>You win!</em>' : '💀 <em>Defeated</em>'}</h1>
        <p>${won ? 'Clean hands.' : 'Watch the telegraph — guard the zone it winds up toward.'}</p>
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
  bout.update(now, dt);
  step(now, dt, aim);
  renderer.render(scene, camera);
}

function step(now, dt, aim) {
  const px = (aim.x - 0.5) * 2.2;
  const py = bout.guardZone === ZONE.HIGH ? 1.85 : 1.1;
  glove.position.set(px, py + (1 - aim.y) * 0.2, 3.6);

  punchFlash = Math.max(0, punchFlash - dt * 4);
  clang = Math.max(0, clang - dt * 3);

  const t = now / 1000;
  rival.group.position.y = Math.sin(t * 2.1) * 0.02;
  let gloveY = rival.aiGuardY ?? 1.5;
  const targetGuardY = bout.aiGuardZone === ZONE.HIGH ? 1.85 : 1.1;
  gloveY += (targetGuardY - gloveY) * Math.min(1, dt * 6);
  rival.aiGuardY = gloveY;
  rival.glove.position.y = gloveY;
  rival.glove.position.x = 0.55;

  if (bout.aiState === AI.WINDUP) {
    telegraph.material.opacity = 0.5 + 0.35 * Math.sin(t * 18);
    telegraph.position.y = bout.aiStrikeZone === ZONE.HIGH ? 1.85 : 1.1;
  } else if (bout.aiState === AI.STRIKE) {
    rival.glove.position.y = bout.aiStrikeZone === ZONE.HIGH ? 1.85 : 1.1;
    rival.glove.position.x = 0.1;
    telegraph.material.opacity = Math.max(0, telegraph.material.opacity - dt * 6);
  } else {
    telegraph.material.opacity = Math.max(0, telegraph.material.opacity - dt * 4);
  }
  rival.group.position.z = -3.6 + (bout.aiState === AI.STRIKE ? 0.6 : 0);

  camera.position.x = (Math.random() - 0.5) * 0.05 * clang;
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
    `bout      ${bout.state} · ai ${bout.aiState}`,
    `guard     ${bout.guardZone} ${bout.guarding ? '(held)' : '(swinging)'}`,
    `gyro map  ${channel.pointer.describeMap()}`,
    `sensor    ${channel.link.rate.toFixed(0)} Hz`,
  ].join('\n');
}, 250);

resize();
syncHud();
syncGuardHud(ZONE.HIGH);
requestAnimationFrame(frame);

window.__senwii = {
  bout, channel, pointer: channel.pointer, swingDetector, zoneOfSwing,
  scene, camera, renderer, step, startMatch,
  fps: () => fps,
};
