import * as THREE from '/vendor/three/three.module.js';
import { consumeLaunchSplash } from '../../core/splash.js';

// Carry the menu's launch banner across the navigation, then fade it out.
const launchData = consumeLaunchSplash();
import { createChannel } from '../../core/channel.js';
import { SwingDetector } from '../../core/gesture.js';
import { ParticleBurst, dotTexture, canvasTexture } from '../shared/fx.js';
import { Bout, AI, ZONE, zoneOfSwing } from './logic.js';

/**
 * Boxing — renderer. The bout runs in logic.js (HIGH/LOW zones instead of
 * swordplay's continuous blade angle); this draws it and pipes the phone in:
 * pointer vertical position is the held guard, a completed swing is a punch
 * aimed by the gesture's vertical direction. Carries its own sound design
 * and impact particles, same tier as fruit-ninja/shooting-range/alien-attack.
 */

const $ = (id) => document.getElementById(id);

const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x120d08);
scene.fog = new THREE.Fog(0x120d08, 7, 22);

const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 60);
camera.position.set(0, 1.5, 5.6);
camera.lookAt(0, 1.3, -2);

scene.add(new THREE.AmbientLight(0xffffff, 0.5));
const spot = new THREE.SpotLight(0xfff2d0, 2.6, 22, Math.PI / 4, 0.4);
spot.position.set(0, 7, 2);
spot.target.position.set(0, 1, -3.6);
scene.add(spot, spot.target);
const rim = new THREE.PointLight(0xff6a3d, 0.8, 14);
rim.position.set(0, 2, -5.5);
scene.add(rim);

const mat = (c, r = 0.65, m = 0) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: m });

// ── Crowd backdrop — without it the arena is a flat black void ────────────
const crowdTex = canvasTexture((g, s) => {
  const grad = g.createLinearGradient(0, 0, 0, s);
  grad.addColorStop(0, '#241a12'); grad.addColorStop(1, '#0c0804');
  g.fillStyle = grad; g.fillRect(0, 0, s, s);
  const palette = ['#5a4432', '#6e5038', '#3f3024', '#7a5a3f', '#4a3828'];
  for (let row = 0; row < 10; row += 1) {
    const y = s * 0.15 + row * s * 0.065;
    for (let i = 0; i < 46; i += 1) {
      g.fillStyle = palette[(row * 7 + i) % palette.length];
      const x = (i / 46) * s + (row % 2) * (s / 92);
      g.beginPath();
      g.arc(x, y, s * 0.012, 0, Math.PI * 2);
      g.fill();
    }
  }
}, 512);
const crowd = new THREE.Mesh(
  new THREE.PlaneGeometry(26, 9),
  new THREE.MeshBasicMaterial({ map: crowdTex, fog: true }),
);
crowd.position.set(0, 4, -9.5);
scene.add(crowd);

// Ring canvas: a wordmark underfoot instead of a flat fill.
const canvasTex = canvasTexture((g, s) => {
  g.fillStyle = '#b7452f'; g.fillRect(0, 0, s, s);
  g.strokeStyle = 'rgba(255,255,255,0.18)'; g.lineWidth = s * 0.01;
  g.beginPath(); g.arc(s / 2, s / 2, s * 0.34, 0, Math.PI * 2); g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.font = `900 ${s * 0.09}px -apple-system, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  // CylinderGeometry's top cap reads this texture mirrored; flip the text
  // so it reads correctly once it's wrapped onto the ring floor.
  g.save();
  g.translate(s, 0); g.scale(-1, 1);
  g.fillText('SENWII', s / 2, s / 2);
  g.restore();
}, 512);

const ring = new THREE.Mesh(
  new THREE.CylinderGeometry(4.6, 4.9, 0.5, 32),
  new THREE.MeshStandardMaterial({ map: canvasTex, roughness: 0.85 }),
);
ring.position.y = -0.25;
scene.add(ring);

const postMat = mat(0xe8e2d4, 0.35, 0.1);
const postPositions = [Math.PI / 4, Math.PI * 0.75, Math.PI * 1.25, Math.PI * 1.75].map((a) => new THREE.Vector3(
  Math.sin(a) * 4.3, 1.1, Math.cos(a) * 4.3 - 2,
));
for (const p of postPositions) {
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 2.4, 10), postMat);
  post.position.copy(p);
  scene.add(post);
}
// Three ropes strung corner to corner, red/white/red.
const ropeColours = [0xd4302a, 0xf2f0ea, 0xd4302a];
for (let h = 0; h < 3; h += 1) {
  const y = 0.35 + h * 0.5;
  const ropeMat = new THREE.MeshStandardMaterial({ color: ropeColours[h], roughness: 0.5 });
  for (let i = 0; i < 4; i += 1) {
    const a = postPositions[i];
    const b = postPositions[(i + 1) % 4];
    const from = new THREE.Vector3(a.x, y, a.z);
    const to = new THREE.Vector3(b.x, y, b.z);
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1, 6), ropeMat);
    orientSegment(seg, from, to);
    scene.add(seg);
  }
}

/** Point a unit-height cylinder from `from` to `to` — the one arm/rope primitive. */
function orientSegment(mesh, from, to) {
  const mid = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
  const dir = new THREE.Vector3().subVectors(to, from);
  const len = dir.length() || 0.001;
  mesh.position.copy(mid);
  mesh.scale.y = len;
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
}

// ── Rival: body, head, a real arm to the glove ──────────────────────────────
function makeFighter(colour, gloveColour) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.42, 0.8, 4, 12), mat(colour));
  body.position.y = 1.0;
  g.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), mat(0xcc8f66));
  head.position.y = 1.95;
  g.add(head);
  const shoulder = new THREE.Vector3(0.28, 1.65, 0.15);
  const glove = new THREE.Mesh(new THREE.SphereGeometry(0.22, 14, 12), mat(gloveColour, 0.4));
  glove.position.set(0.55, 1.5, 0.3);
  g.add(glove);
  const arm = new THREE.Mesh(
    new THREE.CylinderGeometry(0.1, 0.13, 1, 8),
    mat(colour, 0.6),
  );
  g.add(arm);
  g.position.z = -3.6;
  scene.add(g);
  return { group: g, glove, arm, shoulder };
}
const rival = makeFighter(0x8e4fd0, 0xe2432f);

const telegraph = new THREE.Mesh(
  new THREE.RingGeometry(0.3, 0.42, 24),
  new THREE.MeshBasicMaterial({ color: 0xffb000, transparent: true, opacity: 0 }),
);
telegraph.position.z = -3.0;
scene.add(telegraph);

// Player glove + forearm, anchored off-camera-bottom like the player's own arm.
const glove = new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 12), mat(0xffb000, 0.4));
scene.add(glove);
const playerShoulder = new THREE.Vector3(0.75, 0.85, 4.1);
const playerArm = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 1, 8), mat(0xcc8f66, 0.6));
scene.add(playerArm);

// Impact particles.
const sparks = new ParticleBurst(scene, { texture: dotTexture('#ffd27a'), maxParticles: 90 });
const blockSparks = new ParticleBurst(scene, { texture: dotTexture('#cfe6ff'), maxParticles: 60 });

// ── Wiring ─────────────────────────────────────────────────────────────────
const swingDetector = new SwingDetector({ onThreshold: 140, minTravel: 22 });
let punchFlash = 0;
let clang = 0;
let koFlash = 0;

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
      audio.play('bx-punch');
      bout.punch(sw, now);
    }
  },
});

// Boxing's own cues — a bell, a dry glove whoosh, a solid landed thud, a
// glove-on-glove block, and a fanfare/groan for the finish.
const { audio } = channel;

audio.register('bx-bell', (a) => {
  for (let i = 0; i < 2; i += 1) {
    a.tone({ freq: 1760, dur: 0.5, type: 'triangle', gain: 0.22, delay: i * 0.3, attack: 0.002 });
    a.tone({ freq: 880, dur: 0.6, type: 'sine', gain: 0.1, delay: i * 0.3 });
  }
});

audio.register('bx-punch', (a) => {
  a.noise({ dur: 0.1, gain: 0.14, type: 'highpass', freq: 1400, sweepTo: 2200 });
});

audio.register('bx-land', (a, { zone = 'high' } = {}) => {
  a.noise({ dur: 0.14, gain: 0.32, type: 'lowpass', freq: 1800, sweepTo: 250 });
  a.tone({ freq: zone === 'high' ? 150 : 110, dur: 0.16, type: 'triangle', gain: 0.22, slideTo: 60 });
});

audio.register('bx-hit-taken', (a) => {
  a.noise({ dur: 0.16, gain: 0.34, type: 'lowpass', freq: 1500, sweepTo: 180 });
  a.tone({ freq: 90, dur: 0.22, type: 'sawtooth', gain: 0.2, slideTo: 40 });
});

audio.register('bx-block', (a) => {
  a.noise({ dur: 0.07, gain: 0.22, type: 'bandpass', freq: 1200, q: 2.2 });
  a.tone({ freq: 500, dur: 0.06, type: 'square', gain: 0.1 });
});

audio.register('bx-win', (a) => {
  a.tone({ freq: 523.25, dur: 0.16, type: 'sine', gain: 0.2 });
  a.tone({ freq: 659.25, dur: 0.16, type: 'sine', gain: 0.2, delay: 0.14 });
  a.tone({ freq: 783.99, dur: 0.18, type: 'sine', gain: 0.2, delay: 0.28 });
  a.tone({ freq: 1046.5, dur: 0.45, type: 'sine', gain: 0.22, delay: 0.42 });
});

audio.register('bx-lose', (a) => {
  a.noise({ dur: 0.5, gain: 0.2, type: 'lowpass', freq: 500, sweepTo: 80 });
  a.tone({ freq: 220, dur: 0.5, type: 'sawtooth', gain: 0.18, slideTo: 70 });
});

function startMatch() {
  bout.start(performance.now());
  $('overlay').classList.add('hide');
  syncHud();
  audio.play('bx-bell');
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
      audio.play(e.who === 'player' ? 'bx-land' : 'bx-hit-taken', { zone: e.zone });
      sparks.spawn(
        e.who === 'player' ? rival.glove.getWorldPosition(new THREE.Vector3()) : glove.position,
        { count: 18, speed: 2.4, size: 0.06, color: 0xffd27a, life: 0.5 },
      );
      if (e.who === 'ai') koFlash = 0.4;
      break;
    case 'blocked':
      banner(e.who === 'ai' ? 'BLOCKED!' : 'GUARDED', 700);
      channel.feedback({ type: 'slice', combo: 1 });
      audio.play('bx-block');
      blockSparks.spawn(
        e.who === 'ai' ? rival.glove.getWorldPosition(new THREE.Vector3()) : glove.position,
        { count: 10, speed: 1.4, size: 0.05, color: 0xcfe6ff, life: 0.4, upBias: 0.1 },
      );
      clang = 1;
      break;
    case 'over': {
      const won = e.winner === 'player';
      $('panel').innerHTML = `<h1>${won ? '🏆 <em>You win!</em>' : '💀 <em>Defeated</em>'}</h1>
        <p>${won ? 'Clean hands.' : 'Watch the telegraph — guard the zone it winds up toward.'}</p>
        <div class="cta"><strong>A</strong> rematch · <strong>B</strong> menu</div>`;
      $('overlay').classList.remove('hide');
      channel.feedback({ type: won ? 'slice' : 'bomb' });
      audio.play(won ? 'bx-win' : 'bx-lose');
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
  sparks.update(dt);
  blockSparks.update(dt);
  step(now, dt, aim);
  renderer.render(scene, camera);
}

function step(now, dt, aim) {
  // Guard hand rests toward the bottom-right corner (Punch-Out style) so it
  // frames the view instead of blocking the rival dead-centre.
  const px = 0.85 + (aim.x - 0.5) * 1.0;
  const py = (bout.guardZone === ZONE.HIGH ? 1.85 : 1.1) + (1 - aim.y) * 0.2;
  glove.position.set(px, py, 3.6);
  orientSegment(playerArm, playerShoulder, glove.position);

  punchFlash = Math.max(0, punchFlash - dt * 4);
  clang = Math.max(0, clang - dt * 3);
  koFlash = Math.max(0, koFlash - dt * 1.5);

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
  orientSegment(rival.arm, rival.shoulder, rival.glove.position);

  camera.position.x = (Math.random() - 0.5) * 0.05 * clang;
  camera.position.y = 1.5 + (Math.random() - 0.5) * 0.04 * koFlash;
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
