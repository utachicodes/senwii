import * as THREE from '/vendor/three/three.module.js';
import { consumeLaunchSplash } from '../../core/splash.js';

// Carry the menu's launch banner across the navigation, then fade it out.
const launchData = consumeLaunchSplash();
import { createChannel } from '../../core/channel.js';
import { axesFromSample } from '../../core/orientation.js';
import { TraySteer } from '../../core/tilt.js';
import {
  Race, TRACKS, trackBySlug, trackCenterAt, trackNormal, trackHeading,
  trackLengthM, tAtS, nearestOnTrack, fmtMs, medalFor, loadSave, persistSave,
  ordinal, TOP_SPEED, BOOST_SPEED, BOOST_T, DRIFT_CHARGE_T1, DRIFT_CHARGE_T2,
  DRIFT_CHARGE_T3, RACER_COUNT, GRID_ROW_M, PODIUM, POINTS,
} from './logic.js';

/**
 * Turbo Racing — renderer. Three themed cups on parametric centrelines,
 * drift sparks, boost pads and a rubber-banded rival pack. The phone is the
 * wheel: TraySteer (core/tilt.js) does the capture/anti-drift work, logic.js
 * does the racing, this file only draws and wires.
 */

const $ = (id) => document.getElementById(id);

const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, 1, 0.3, 1500);

scene.add(new THREE.AmbientLight(0xffffff, 0.72));
const sun = new THREE.DirectionalLight(0xfff2d8, 1.45);
sun.position.set(120, 240, 90);
scene.add(sun);
const fill = new THREE.DirectionalLight(0x9fb4ff, 0.35);
fill.position.set(-100, 60, -140);
scene.add(fill);

const mat = (c, r = 0.7) => new THREE.MeshStandardMaterial({ color: c, roughness: r });
const glow = (c, opacity = 1) => new THREE.MeshBasicMaterial({
  color: c, transparent: opacity < 1, opacity,
});
const additive = (c, opacity = 1) => new THREE.MeshBasicMaterial({
  color: c, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false,
});

// Logic z runs forward along the track; world −z is forward on screen.
const wz = (z) => -z;

// Everything track-specific lives in one group so cups can be swapped.
const world = new THREE.Group();
scene.add(world);

function disposeWorld() {
  world.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material && !Array.isArray(o.material)) o.material.dispose();
  });
  world.clear();
}

// ── Track construction ─────────────────────────────────────────────────────

function ribbonMesh(track, half, y, material) {
  const verts = [];
  const idx = [];
  const N = 384;
  for (let i = 0; i <= N; i += 1) {
    const t = (i % N) / N;
    const p = trackCenterAt(track, t);
    const n = trackNormal(track, t);
    verts.push(p.x - n.x * half, y, wz(p.z - n.z * half),
      p.x + n.x * half, y, wz(p.z + n.z * half));
  }
  for (let i = 0; i < N; i += 1) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, material);
}

function edgeLine(track, off, color, y) {
  const pts = [];
  for (let i = 0; i <= 384; i += 1) {
    const t = (i % 384) / 384;
    const p = trackCenterAt(track, t);
    const n = trackNormal(track, t);
    pts.push(new THREE.Vector3(p.x + n.x * off, y, wz(p.z + n.z * off)));
  }
  return new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color }),
  );
}

function chevronTexture() {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#1fc8ff';
  for (const [y0, w] of [[96, 26], [64, 34], [32, 42]]) {
    g.beginPath();
    g.moveTo(64 - w, y0 + 22);
    g.lineTo(64, y0 - 8);
    g.lineTo(64 + w, y0 + 22);
    g.lineTo(64 + w, y0 + 6);
    g.lineTo(64, y0 - 24 + (42 - w));
    g.lineTo(64 - w, y0 + 6);
    g.closePath();
    g.globalAlpha = 0.4 + w / 100;
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function startArch(track) {
  const g = new THREE.Group();
  const post = () => new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.65, 11, 10), mat(0xe23b3b, 0.5));
  const l = post();
  l.position.set(-track.halfWidth - 0.6, 5.5, 0);
  const r = post();
  r.position.set(track.halfWidth + 0.6, 5.5, 0);
  const bar = new THREE.Mesh(
    new THREE.BoxGeometry(track.halfWidth * 2 + 2.4, 2, 1.3), mat(0xf6f2ea, 0.5),
  );
  bar.position.y = 11.4;
  const checker = new THREE.Mesh(
    new THREE.PlaneGeometry(track.halfWidth * 2, 2.6),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 }),
  );
  checker.rotation.x = -Math.PI / 2;
  checker.position.y = 0.06;
  g.add(l, r, bar, checker);
  const p = trackCenterAt(track, 0);
  const h = trackHeading(track, 0);
  g.position.set(p.x, 0, wz(p.z));
  g.rotation.y = Math.PI - h;
  return g;
}

function themeProps(track) {
  const props = new THREE.Group();
  const rnd = (i) => {
    const x = Math.sin(i * 127.1) * 43758.5453;
    return x - Math.floor(x);
  };
  if (track.theme === 'sunset') {
    // A low sun on the horizon and palms scattered off-road.
    const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: (() => {
        const c = document.createElement('canvas');
        c.width = 256;
        c.height = 256;
        const g = c.getContext('2d');
        const grad = g.createRadialGradient(128, 128, 10, 128, 128, 128);
        grad.addColorStop(0, '#ffe9b0ff');
        grad.addColorStop(0.35, '#ffc46eaa');
        grad.addColorStop(1, '#ff9a5e00');
        g.fillStyle = grad;
        g.fillRect(0, 0, 256, 256);
        return new THREE.CanvasTexture(c);
      })(),
      transparent: true, depthWrite: false, fog: false,
    }));
    sunSprite.scale.setScalar(220);
    sunSprite.position.set(-260, 34, -420);
    props.add(sunSprite);
    for (let i = 0; i < 46; i += 1) {
      const palm = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.5, 7, 7), mat(0x8a6a45, 0.9));
      trunk.position.y = 3.5;
      trunk.rotation.z = (rnd(i) - 0.5) * 0.3;
      palm.add(trunk);
      for (let f = 0; f < 6; f += 1) {
        const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.5, 4.4, 4), mat(0x2f8a4a, 0.85));
        leaf.position.set(Math.cos(f) * 1.1, 7, Math.sin(f) * 1.1);
        leaf.rotation.set(Math.cos(f) * 1.25, 0, Math.sin(f) * 1.25 + 0.4);
        palm.add(leaf);
      }
      const a = (i / 46) * Math.PI * 2 + rnd(i + 9) * 0.4;
      const r = (i % 2 ? 210 : 70) + rnd(i + 3) * 60;
      palm.position.set(Math.cos(a) * r, 0, Math.sin(a) * r * 0.9);
      palm.scale.setScalar(0.8 + rnd(i + 5) * 0.7);
      props.add(palm);
    }
  } else if (track.theme === 'neon') {
    // Glow pylons and a skyline of dark towers with lit windows.
    for (let i = 0; i < 60; i += 1) {
      const a = (i / 60) * Math.PI * 2;
      const r = (i % 3 === 0 ? 55 : 150) + rnd(i) * 130;
      const h = 8 + rnd(i + 2) * 42;
      const tower = new THREE.Mesh(
        new THREE.BoxGeometry(6 + rnd(i + 4) * 8, h, 6 + rnd(i + 7) * 8),
        mat(0x191631, 0.9),
      );
      tower.position.set(Math.cos(a) * r, h / 2, Math.sin(a) * r);
      props.add(tower);
      if (i % 2 === 0) {
        const strip = new THREE.Mesh(
          new THREE.BoxGeometry(0.7, h * 0.7, 0.7),
          additive([0x53f2e0, 0xb06cff, 0xff5ea8][i % 3], 0.85),
        );
        strip.position.set(tower.position.x, h * 0.6, tower.position.z);
        props.add(strip);
      }
    }
    for (let i = 0; i < 26; i += 1) {
      const a = (i / 26) * Math.PI * 2;
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(3.2, 0.28, 8, 26),
        additive(0x53f2e0, 0.7),
      );
      const r = 96 + rnd(i + 1) * 40;
      ring.position.set(Math.cos(a) * r, 5 + rnd(i + 6) * 10, Math.sin(a) * r);
      ring.rotation.x = Math.PI / 2;
      props.add(ring);
    }
  } else {
    // Canyon: mesas and cacti under a wide hot sky.
    for (let i = 0; i < 34; i += 1) {
      const a = (i / 34) * Math.PI * 2;
      const r = 130 + rnd(i) * 190;
      const h = 10 + rnd(i + 2) * 30;
      const mesa = new THREE.Mesh(
        new THREE.CylinderGeometry(9 + rnd(i + 4) * 16, 13 + rnd(i + 5) * 20, h, 7),
        mat(i % 2 ? 0xc98d52 : 0xb3763f, 0.95),
      );
      mesa.position.set(Math.cos(a) * r, h / 2, Math.sin(a) * r * 0.9);
      props.add(mesa);
    }
    for (let i = 0; i < 30; i += 1) {
      const a = (i / 30) * Math.PI * 2 + 0.13;
      const r = 62 + rnd(i + 8) * 60;
      const cactus = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.7, 4.2, 8), mat(0x3f7a44, 0.9));
      body.position.y = 2.1;
      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.45, 2, 8), mat(0x3f7a44, 0.9));
      arm.position.set(0.9, 2.6, 0);
      arm.rotation.z = -0.9;
      cactus.add(body, arm);
      cactus.position.set(Math.cos(a) * r, 0, Math.sin(a) * r * 0.92);
      cactus.scale.setScalar(0.8 + rnd(i) * 0.8);
      props.add(cactus);
    }
  }
  return props;
}

function buildTrack(track) {
  disposeWorld();
  scene.background = new THREE.Color(track.sky);
  const [fc, fnear, ffar] = track.fog;
  scene.fog = new THREE.Fog(fc, fnear, ffar);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1700, 1700), mat(track.ground, 0.95));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.06;
  world.add(ground);

  world.add(ribbonMesh(track, track.halfWidth, 0, mat(track.road, 0.92)));
  // Slightly wider dark verge under the painted edge = the rumble strip.
  world.add(ribbonMesh(track, track.halfWidth + 0.9, -0.02, mat(0x2c2a33, 0.95)));
  world.add(edgeLine(track, -track.halfWidth + 0.35, track.edge, 0.05));
  world.add(edgeLine(track, track.halfWidth - 0.35, track.edge, 0.05));

  // Boost pads: glowing chevron quads on the road.
  const tex = chevronTexture();
  for (const padT of track.pads) {
    const p = trackCenterAt(track, padT);
    const n = trackNormal(track, padT);
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(5.4, 7),
      new THREE.MeshBasicMaterial({
        map: tex, transparent: true, opacity: 0.95, depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    quad.rotation.x = -Math.PI / 2;
    quad.rotation.z = Math.PI - trackHeading(track, padT);
    quad.position.set(p.x, 0.08, wz(p.z));
    quad.userData.pulse = Math.random() * 6;
    world.add(quad);
    pads.push(quad);
  }

  world.add(startArch(track));
  world.add(themeProps(track));
}

const pads = [];

// ── Karts ──────────────────────────────────────────────────────────────────

function buildKart(bodyColor, opts = {}) {
  const g = new THREE.Group();
  const tilt = new THREE.Group();
  g.add(tilt);
  const ghostly = opts.ghost ? { transparent: true, opacity: 0.35, depthWrite: false } : {};
  const m = (c, r = 0.5) => new THREE.MeshStandardMaterial({ color: c, roughness: r, ...ghostly });
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.5, 3.0), m(bodyColor, 0.4));
  body.position.y = 0.6;
  const nose = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.32, 0.9), m(bodyColor, 0.4));
  nose.position.set(0, 0.55, -1.85);
  const spoiler = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.12, 0.55), m(0x23232b, 0.5));
  spoiler.position.set(0, 1.06, 1.5);
  const wingL = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.42, 0.5), m(0x23232b, 0.5));
  wingL.position.set(-0.85, 0.82, 1.5);
  const wingR = wingL.clone();
  wingR.position.x = 0.85;
  const driver = new THREE.Mesh(new THREE.SphereGeometry(0.4, 10, 8), m(0xf5d7b0, 0.75));
  driver.position.set(0, 1.16, 0.25);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.44, 10, 8), m(opts.helmet || 0xf6f2ea, 0.35));
  helmet.position.set(0, 1.28, 0.25);
  helmet.scale.y = 0.82;
  tilt.add(body, nose, spoiler, wingL, wingR, driver, helmet);

  // Wheels: steer wrapper ⊃ spin wrapper ⊃ mesh, so both transforms compose.
  const wheels = [];
  const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.36, 12);
  for (const [wx, wzz, front] of [[-0.95, -1.05, 1], [0.95, -1.05, 1], [-0.95, 1.05, 0], [0.95, 1.05, 0]]) {
    const steerWrap = new THREE.Group();
    steerWrap.position.set(wx, 0.42, wzz);
    const spinWrap = new THREE.Group();
    const wheel = new THREE.Mesh(wheelGeo, m(0x232327, 0.9));
    wheel.rotation.z = Math.PI / 2;
    spinWrap.add(wheel);
    steerWrap.add(spinWrap);
    tilt.add(steerWrap);
    wheels.push({ steerWrap, spinWrap, front: !!front });
  }
  return { group: g, tilt, wheels };
}

const playerKart = buildKart(0xe23b3b, { helmet: 0xf6f2ea });
scene.add(playerKart.group);
const rivalKarts = new Map();          // kart id → { group, tilt, wheels }
const ghostKart = buildKart(0x9ecbff, { ghost: true });
ghostKart.group.visible = false;
scene.add(ghostKart.group);

// Boost flames on the player's tail.
const flames = [];
{
  const flameGeo = new THREE.ConeGeometry(0.34, 1.6, 8);
  flameGeo.rotateX(-Math.PI / 2);
  for (const side of [-0.55, 0.55]) {
    const f = new THREE.Mesh(flameGeo, additive(0x7fd4ff, 0.9));
    f.position.set(side, 0.55, 2.4);
    f.visible = false;
    playerKart.tilt.add(f);
    flames.push(f);
  }
}

// ── Particles: sparks, dust, confetti ──────────────────────────────────────

const POOL = 90;
const particles = [];
{
  const geo = new THREE.PlaneGeometry(0.34, 0.34);
  for (let i = 0; i < POOL; i += 1) {
    const mesh = new THREE.Mesh(geo, additive(0xffffff, 0));
    mesh.visible = false;
    scene.add(mesh);
    particles.push({ mesh, life: 0, ttl: 1, vel: new THREE.Vector3(), spin: 0 });
  }
}
let poolCursor = 0;
function spawnParticle(x, y, z, color, vel, ttl = 0.5, scale = 1) {
  const p = particles[poolCursor];
  poolCursor = (poolCursor + 1) % POOL;
  p.mesh.visible = true;
  p.mesh.material.color.setHex(color);
  p.mesh.material.opacity = 1;
  p.mesh.position.set(x, y, z);
  p.mesh.scale.setScalar(scale);
  p.mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
  p.vel.copy(vel);
  p.life = ttl;
  p.ttl = ttl;
  p.spin = (Math.random() - 0.5) * 12;
}
function stepParticles(dt) {
  for (const p of particles) {
    if (p.life <= 0) continue;
    p.life -= dt;
    if (p.life <= 0) { p.mesh.visible = false; continue; }
    p.mesh.position.addScaledVector(p.vel, dt);
    p.vel.y -= 6 * dt;
    p.mesh.rotation.z += p.spin * dt;
    p.mesh.material.opacity = Math.min(1, (p.life / p.ttl) * 1.6);
  }
}

// ── Minimap ────────────────────────────────────────────────────────────────

const minimap = $('minimap');
const mmCtx = minimap.getContext('2d');
const mm = { pts: [], scale: 1, ox: 0, oy: 0, road: null };

function buildMinimap(track) {
  mm.pts = [];
  let minX = Infinity; let maxX = -Infinity; let minZ = Infinity; let maxZ = -Infinity;
  for (let i = 0; i < 128; i += 1) {
    const p = trackCenterAt(track, i / 128);
    mm.pts.push(p);
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  const pad = 26;
  const w = minimap.width; const h = minimap.height;
  mm.scale = Math.min((w - pad * 2) / (maxX - minX), (h - pad * 2) / (maxZ - minZ));
  mm.ox = w / 2 - ((minX + maxX) / 2) * mm.scale;
  mm.oy = h / 2 - ((minZ + maxZ) / 2) * mm.scale;
  // Road: one static offscreen layer.
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const g = off.getContext('2d');
  g.lineCap = 'round';
  g.strokeStyle = '#ffffff2e';
  g.lineWidth = track.halfWidth * 2 * mm.scale;
  g.beginPath();
  for (let i = 0; i <= 128; i += 1) {
    const p = mm.pts[i % 128];
    const x = p.x * mm.scale + mm.ox;
    const y = p.z * mm.scale + mm.oy;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
  g.strokeStyle = '#ffffffb0';
  g.lineWidth = 2;
  g.stroke();
  // Start line tick.
  const s = trackCenterAt(track, 0);
  g.fillStyle = '#ffd23e';
  g.beginPath();
  g.arc(s.x * mm.scale + mm.ox, s.z * mm.scale + mm.oy, 4.5, 0, Math.PI * 2);
  g.fill();
  mm.road = off;
}

function drawMinimap(race, now) {
  mmCtx.clearRect(0, 0, minimap.width, minimap.height);
  if (mm.road) mmCtx.drawImage(mm.road, 0, 0);
  if (!race) return;
  const dot = (x, z, color, r) => {
    mmCtx.fillStyle = color;
    mmCtx.beginPath();
    mmCtx.arc(x * mm.scale + mm.ox, z * mm.scale + mm.oy, r, 0, Math.PI * 2);
    mmCtx.fill();
  };
  for (const k of race.karts) {
    const kp = race.kartWorldPos(k);
    dot(kp.x, kp.z, `#${k.color.toString(16).padStart(6, '0')}`, 5);
  }
  const pulse = 6 + Math.sin(now / 180) * 1.4;
  dot(race.pos.x, race.pos.z, '#ff3b30', pulse);
}

// ── UI + persistence ───────────────────────────────────────────────────────

let save = loadSave();
let trackIndex = 0;
const cupPoints = [0, 0, 0];

function syncTrackSelect() {
  const wrap = $('tracks');
  wrap.innerHTML = '';
  TRACKS.forEach((t, i) => {
    const unlocked = i < save.unlocked;
    const best = save.bestLaps[t.slug];
    const medal = medalFor(t, best);
    const card = document.createElement('div');
    card.className = `track${i === trackIndex ? ' sel' : ''}${unlocked ? '' : ' locked'}`;
    card.innerHTML = `<div class="te">${unlocked ? t.emoji : '🔒'}</div>
      <div class="tn">${t.name}</div>
      <div class="tm">${unlocked ? (best ? `${fmtMs(best)} ${medal === 'gold' ? '🥇' : medal === 'silver' ? '🥈' : '🥉'}` : 'no record') : 'finish top 3 to unlock'}</div>`;
    wrap.appendChild(card);
  });
  const total = cupPoints.reduce((a, b) => a + b, 0);
  $('points').textContent = total ? `Cup points: ${cupPoints.join(' + ')} = ${total}` : '';
}

function changeTrack(delta) {
  if (race && (race.state === 'racing' || race.state === 'countdown')) return;
  let i = trackIndex;
  for (let step = 0; step < TRACKS.length; step += 1) {
    i = (i + delta + TRACKS.length) % TRACKS.length;
    if (i < save.unlocked) { trackIndex = i; break; }
  }
  syncTrackSelect();
  loadTrack(trackIndex);
  channel.audio.play('hover');
}

function showMenu() {
  syncTrackSelect();
  $('panel').innerHTML = `<h1>🏎️ <em>Turbo Racing</em></h1>
    <p>Hold the phone like a wheel and roll it to steer. Bank into a corner and
       hold <b>A</b> to drift — let go for a mini-turbo. Blue arrows are boost
       pads. Finish <b>top 3</b> to unlock the next cup.</p>
    <div id="tracks"></div>
    <div id="points"></div>
    <div class="cta"><strong>A</strong> or <strong>Space</strong> race · <strong>↑↓</strong> pick track · <strong>B</strong> menu</div>`;
  syncTrackSelect();
  $('overlay').classList.remove('hide');
}

// ── State ──────────────────────────────────────────────────────────────────

let race = null;
let started = false;
let last = performance.now();
let fps = 0; let frames = 0; let fpsMark = last;
let countdownPulse = 0;
let toastUntil = 0;
let resultMenuShown = false;

// Failsafe: if steering ever feels backwards, I inverts it and sticks.
let invertSteer = localStorage.getItem('senwii.racingInvert') === '1';
const steer = new TraySteer({ invert: invertSteer });

function loadTrack(index) {
  pads.length = 0;
  // remove rival meshes
  for (const rk of rivalKarts.values()) scene.remove(rk.group);
  rivalKarts.clear();
  buildTrack(TRACKS[index]);
  buildMinimap(TRACKS[index]);
  drawMinimap(null, performance.now());
}

// ── Sound design ───────────────────────────────────────────────────────────

const channel = createChannel({
  room: launchData?.room,
  onA: () => {
    if (!started || (race && race.state === 'finished')) {
      startRace();
      return;
    }
    // non-wheel fallback: tap A starts/holds drift while running
  },
  onB: null, // default home
  onCommand: (cmd) => {
    if (cmd.type === 'calibrate' || cmd.type === 'recentre') {
      steer.recentre();
      flashToast('steering centred');
    }
    if (cmd.type === 'button') {
      const b = cmd.button;
      if (b === 'A') {
        if (!started || (race && race.state === 'finished')) startRace();
        else if (race) race.setDrift(true, performance.now());
      } else if (b === '1') {
        if (race) race.setBrake(true);
      } else if (b === 'up') {
        changeTrack(-1);
      } else if (b === 'down') {
        changeTrack(1);
      }
      // menuDirection from the crosspad (default controller profile)
      if (cmd.menuDirection === 'up') changeTrack(-1);
      if (cmd.menuDirection === 'down') changeTrack(1);
    }
    if (cmd.type === 'button-up') {
      const b = cmd.button;
      if (b === 'A' && race) race.setDrift(false, performance.now());
      if (b === '1' && race) race.setBrake(false);
    }
  },
  onSample: (sample, dt, now) => {
    if (race) race.setSteer(steer.update(axesFromSample(sample), dt, now));
  },
});

const { audio } = channel;

// Engine is a continuous loop that follows speed: implemented by re-ticking
// a short tone burst on a timer (Web Audio oscillator-per-note model).
let engineTimer = null;
let enginePhase = 0;
function startEngine() {
  if (engineTimer) return;
  engineTimer = setInterval(() => {
    if (!race || race.state === 'ready' || !audio.ctx || audio.ctx.state !== 'running') return;
    const speed = race.speed;
    if (speed < 0.5) return;
    const f = 55 + speed * 5.5 + (race.drifting ? 38 : 0);
    const g = 0.018 + Math.min(0.03, speed / 1600);
    audio.tone({ freq: f, dur: 0.09, type: 'sawtooth', gain: g, attack: 0.004 });
    if (enginePhase++ % 2 === 0) {
      audio.tone({ freq: f * 2, dur: 0.06, type: 'square', gain: g * 0.25, attack: 0.003 });
    }
  }, 90);
}
function stopEngine() {
  if (engineTimer) { clearInterval(engineTimer); engineTimer = null; }
}

audio.register('race-count', () => {
  audio.tone({ freq: 440, dur: 0.18, type: 'square', gain: 0.18, attack: 0.004 });
});
audio.register('race-go', () => {
  audio.tone({ freq: 880, dur: 0.35, type: 'square', gain: 0.2, attack: 0.004 });
  audio.tone({ freq: 1320, dur: 0.25, type: 'sine', gain: 0.12, delay: 0.06 });
});
audio.register('race-hop', () => {
  audio.tone({ freq: 320, dur: 0.08, type: 'triangle', gain: 0.16, slideTo: 520 });
});
audio.register('race-spark', (_, { tier = 1 } = {}) => {
  const f = 700 + tier * 260;
  audio.tone({ freq: f, dur: 0.12, type: 'sine', gain: 0.14 + tier * 0.02, attack: 0.003 });
  audio.tone({ freq: f * 1.5, dur: 0.08, type: 'triangle', gain: 0.08, delay: 0.03 });
});
audio.register('race-boost', (_, { tier = 1 } = {}) => {
  audio.noise({ dur: 0.35, gain: 0.18, type: 'bandpass', freq: 600 + tier * 400, sweepTo: 3800, q: 1.2 });
  audio.tone({ freq: 220, dur: 0.35, type: 'sawtooth', gain: 0.16, slideTo: 520 + tier * 120 });
});
audio.register('race-pad', () => {
  audio.tone({ freq: 520, dur: 0.18, type: 'sawtooth', gain: 0.14, slideTo: 980 });
  audio.noise({ dur: 0.14, gain: 0.08, type: 'highpass', freq: 2000 });
});
audio.register('race-lap', (_, { best = false } = {}) => {
  audio.tone({ freq: 660, dur: 0.1, type: 'sine', gain: 0.18 });
  audio.tone({ freq: best ? 1100 : 880, dur: 0.18, type: 'sine', gain: 0.18, delay: 0.07 });
  if (best) audio.tone({ freq: 1320, dur: 0.22, type: 'sine', gain: 0.14, delay: 0.16 });
});
audio.register('race-scrape', () => {
  audio.noise({ dur: 0.12, gain: 0.06, type: 'bandpass', freq: 1800, q: 2.5 });
});

// ── Race lifecycle ─────────────────────────────────────────────────────────

function ensureRivals() {
  // Create meshes for the rival karts of the active race.
  for (const k of race.karts) {
    if (rivalKarts.has(k.id)) continue;
    const rk = buildKart(k.color, { helmet: 0xdfe6f5 });
    rivalKarts.set(k.id, rk);
    scene.add(rk.group);
  }
}

function startRace() {
  if (trackIndex >= save.unlocked) return;
  started = true;
  resultMenuShown = false;
  steer.recentre();
  audio.unlock();
  startEngine();

  const track = TRACKS[trackIndex];
  const ghost = save.ghosts[track.slug] || null;
  race = new Race({ trackIndex, onEvent: handleEvent, seed: (performance.now() * 997) | 0, ghost });
  ensureRivals();
  ghostKart.group.visible = false;

  race.start(performance.now());
  $('overlay').classList.add('hide');
  flashBanner('', 0);
  syncHud(performance.now());
}

const keys = {};
window.addEventListener('keydown', (e) => {
  keys[e.key] = true;
  const k = e.key.toLowerCase();
  if (e.key === 'ArrowUp') { e.preventDefault(); changeTrack(-1); }
  if (e.key === 'ArrowDown') { e.preventDefault(); changeTrack(1); }
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    if (!started || (race && race.state === 'finished')) startRace();
    else if (race) race.setDrift(true, performance.now());
  }
  if (k === 'i') {
    invertSteer = !invertSteer;
    steer.setInvert(invertSteer);
    localStorage.setItem('senwii.racingInvert', invertSteer ? '1' : '0');
    flashToast(invertSteer ? 'steering inverted' : 'steering normal');
  }
  if (k === 'x' || k === '1') { if (race) race.setBrake(true); }
});
window.addEventListener('keyup', (e) => {
  keys[e.key] = false;
  if (e.key === ' ' || e.key === 'Enter') { if (race) race.setDrift(false, performance.now()); }
  const k = e.key.toLowerCase();
  if (k === 'x' || k === '1') { if (race) race.setBrake(false); }
});

function flashBanner(text, ms = 1000) {
  $('banner').innerHTML = text;
  if (text) { $('banner').classList.add('on'); countdownPulse = performance.now() + ms; }
  else $('banner').classList.remove('on');
}
function flashToast(text, ms = 1400) {
  $('toast').textContent = text;
  $('toast').classList.add('on');
  toastUntil = performance.now() + ms;
}

function handleEvent(e) {
  if (e.type === 'countdown') {
    flashBanner('3', 3200);
    audio.play('race-count');
  } else if (e.type === 'go') {
    flashBanner('GO!', 700);
    channel.feedback({ type: 'launch' });
    audio.play('race-go');
  } else if (e.type === 'hop') {
    audio.play('race-hop');
  } else if (e.type === 'spark') {
    audio.play('race-spark', { tier: e.tier });
    flashToast(['', 'BLUE DRIFT', 'ORANGE DRIFT', 'PINK DRIFT'][e.tier] || '', 600);
    channel.feedback({ type: 'slice', combo: e.tier });
  } else if (e.type === 'boost') {
    audio.play('race-boost', { tier: e.tier });
    channel.feedback({ type: 'slice', combo: e.tier });
  } else if (e.type === 'pad') {
    audio.play('race-pad');
    channel.feedback({ type: 'slice', combo: 1 });
  } else if (e.type === 'lap') {
    audio.play('race-lap', { best: e.best });
    channel.feedback({ type: 'slice', combo: e.best ? 3 : 1 });
    flashToast(e.best ? `LAP ${e.lap} — NEW BEST ${fmtMs(e.ms)}` : `LAP ${e.lap}  ${fmtMs(e.ms)}`, 2200);
  } else if (e.type === 'rescue') {
    audio.play('fail');
    flashToast('rescued!', 900);
    channel.feedback({ type: 'miss' });
  } else if (e.type === 'finish') {
    audio.play(e.place <= 3 ? 'race-go' : 'fail');
    channel.feedback({ type: e.place === 1 ? 'slice' : 'miss', combo: 3 });
    cupPoints[race.track.order] = e.points;
    const track = race.track;
    const prevBest = save.bestLaps[track.slug];
    if (!prevBest || (e.bestLapMs && e.bestLapMs < prevBest)) {
      save.bestLaps[track.slug] = e.bestLapMs;
      if (race.recording && race.recording.length) save.ghosts[track.slug] = race.recording;
    }
    if (e.place <= PODIUM && track.order + 1 >= save.unlocked) {
      save.unlocked = Math.min(TRACKS.length, track.order + 2);
    }
    persistSave(save);
    showResults(e);
  }
}

function showResults(e) {
  const track = race.track;
  const medal = medalFor(track, e.bestLapMs);
  const unlocked = e.place <= PODIUM && track.order + 1 < TRACKS.length
    && save.unlocked > track.order + 1;
  const rows = e.standings.map((s, i) => {
    const cls = s.who === 'you' ? ' class="you"' : '';
    const tag = s.who === 'you' ? 'YOU' : s.who;
    const mark = s.done !== null ? '🏁' : `${Math.round(s.prog)}m`;
    return `<div${cls}>${i + 1}. ${tag}<b>${mark}</b></div>`;
  }).join('');
  const head = e.place === 1 ? 'Champion!' : e.place <= 3 ? 'Podium!' : 'Race over';
  const medalTxt = medal ? ` · ${medal === 'gold' ? '🥇 gold' : medal === 'silver' ? '🥈 silver' : '🥉 bronze'}` : '';
  $('panel').innerHTML = `<h1>🏁 <em>${head}</em></h1>
    <p>${ordinal(e.place)} place — <strong>${e.points} pts</strong>${medalTxt}. Best lap ${fmtMs(e.bestLapMs)}.</p>
    <div class="results">${rows}</div>
    <p>${unlocked ? `Unlocked <strong>${TRACKS[track.order + 1].name}</strong>!` : e.place > PODIUM ? 'Finish top 3 to unlock the next cup.' : ''}</p>
    <div id="tracks"></div>
    <div id="points"></div>
    <div class="cta"><strong>A</strong> race again · <strong>↑↓</strong> pick track · <strong>B</strong> menu</div>`;
  syncTrackSelect();
  $('overlay').classList.remove('hide');
  resultMenuShown = true;
}

function syncHud(now) {
  if (!race) return;
  $('place').textContent = ordinal(race.rank);
  const lap = Math.min(race.lap, race.laps);
  $('laprow').textContent = `lap ${lap}/${race.laps} · best ${fmtMs(race.bestLapMs)}`;
  $('timetrial').textContent = fmtMs(race.state === 'countdown' ? 0 : race.lapMs);
  const kmh = Math.round(race.speed * 3.6);
  const boosting = now < Math.max(race.boostUntil, race.padBoostUntil);
  $('speed').innerHTML = `${kmh}<small> km/h${boosting ? ' ⚡' : ''}</small>`;
  const dw = $('driftwrap');
  if (race.drifting || race.driftTier > 0) {
    dw.classList.add('on');
    const pct = race.driftTier === 3 ? 100
      : race.driftTier === 2 ? 66 + ((race.driftCharge - DRIFT_CHARGE_T2) / (DRIFT_CHARGE_T3 - DRIFT_CHARGE_T2)) * 34
      : race.driftTier === 1 ? 33 + ((race.driftCharge - DRIFT_CHARGE_T1) / (DRIFT_CHARGE_T2 - DRIFT_CHARGE_T1)) * 33
      : (race.driftCharge / DRIFT_CHARGE_T1) * 33;
    $('drift').style.width = `${Math.min(100, pct)}%`;
  } else {
    dw.classList.remove('on');
  }
  // standings strip
  const st = race.standings();
  $('standings').innerHTML = st.map((s, i) => {
    const cls = s.who === 'you' ? ' class="you"' : '';
    const tag = s.who === 'you' ? 'YOU' : s.who;
    return `<div${cls}>${i + 1}. ${tag}</div>`;
  }).join('');
  // debug
  const dbg = $('debug');
  if (dbg && dbg.classList.contains('on')) {
    dbg.textContent = [
      `fps ${fps.toFixed(0)}  steer ${steer.describe()}`,
      `spd ${race.speed.toFixed(1)}  onTrack ${race.onTrack}  scraping ${race.scraping}`,
      `drift ${race.drifting} tier ${race.driftTier} chg ${race.driftCharge.toFixed(2)}`,
      `prog ${race.progressM.toFixed(1)}  t ${race.trackT.toFixed(3)}  lap ${race.lap}`,
      `state ${race.state}  rank ${race.rank}`,
    ].join('\n');
  }
}

// ── Loop ───────────────────────────────────────────────────────────────────

function wheelFeedback(now) {
  // The phone reverts to default after 2.5s without a profile nudge.
  if (now - wheelFeedback.last > 2000) {
    channel.feedback({ type: 'controller-profile', profile: 'wheel' });
    wheelFeedback.last = now;
  }
}
wheelFeedback.last = 0;

function placeKart(obj, x, z, heading, lean = 0, wheelSpin = 0, steerDeg = 0) {
  obj.group.position.set(x, 0, wz(z));
  // Logic motion heading 0 = travel toward −z (world). +logic heading is a
  // right turn. A yaw that rotates a forward mesh the same sense:
  obj.group.rotation.set(0, Math.PI - heading, 0);
  obj.tilt.rotation.z = lean;
  for (const w of obj.wheels) {
    w.spinWrap.rotation.x += wheelSpin;
    if (w.front) w.steerWrap.rotation.y = -steerDeg * Math.PI / 180 * 0.45;
  }
}

let scrapeAccum = 0;
let sparkAccum = 0;

function step(now, dt) {
  // Animate boost pads.
  for (const pad of pads) {
    pad.userData.pulse += dt * 4;
    pad.material.opacity = 0.7 + Math.sin(pad.userData.pulse) * 0.25;
  }

  // Player kart.
  const leaning = race.steer * Math.PI / 180 * 0.18;
  const boosting = now < Math.max(race.boostUntil, race.padBoostUntil);
  const wheelSpin = race.speed * dt / 0.42;      // r ≈ 0.42 m
  placeKart(playerKart, race.pos.x, race.pos.z, race.heading, leaning, wheelSpin, race.steer);
  for (const f of flames) {
    f.visible = boosting && race.state !== 'finished';
    f.scale.set(1, 1, 0.6 + Math.random() * 0.9);
  }

  // Drift sparks from the rear wheels.
  if (race.drifting && race.speed > 10) {
    sparkAccum += dt;
    const tier = race.driftTier;
    const color = tier >= 3 ? 0xff4e6e : tier >= 2 ? 0xff8a3e : tier >= 1 ? 0x4ecbff : 0xf0f4ff;
    const count = tier >= 2 ? 3 : 1;
    while (sparkAccum > 0.025) {
      sparkAccum -= 0.025;
      for (let n = 0; n < count; n += 1) {
        const side = n % 2 ? -0.8 : 0.8;
        const rx = Math.cos(race.motionHeading) * side - Math.sin(race.motionHeading) * 1.4;
        const rz = -Math.sin(race.motionHeading) * side - Math.cos(race.motionHeading) * 1.4;
        spawnParticle(
          race.pos.x + rx, 0.25, wz(race.pos.z + rz),
          color,
          new THREE.Vector3((Math.random() - 0.5) * 4, 2 + Math.random() * 3, (Math.random() - 0.5) * 4),
          0.35 + Math.random() * 0.25, 0.7 + tier * 0.15,
        );
      }
    }
  } else {
    sparkAccum = 0;
  }

  // Dust when off the road.
  if (!race.onTrack && race.speed > 5) {
    if (Math.random() < dt * 18) {
      spawnParticle(
        race.pos.x + (Math.random() - 0.5) * 1.4, 0.15, wz(race.pos.z) + (Math.random() - 0.5) * 1.4,
        0xd7c49a,
        new THREE.Vector3((Math.random() - 0.5) * 3, 1.5 + Math.random() * 2, (Math.random() - 0.5) * 3),
        0.5, 0.9,
      );
    }
  }

  // Scrape sound tick.
  if (race.scraping) {
    scrapeAccum += dt;
    if (scrapeAccum > 0.14) { scrapeAccum = 0; audio.play('race-scrape'); }
  } else scrapeAccum = 0;

  // Rival karts.
  for (const k of race.karts) {
    let rk = rivalKarts.get(k.id);
    if (!rk) { ensureRivals(); rk = rivalKarts.get(k.id); }
    if (!rk) continue;
    const kp = race.kartWorldPos(k);
    const h = trackHeading(race.track, k.t);
    const lean = -k.offset / Math.max(1, race.track.halfWidth) * 0.08;
    placeKart(rk, kp.x, kp.z, h, lean, k.speed * dt / 0.42, 0);
  }

  // Ghost.
  if (race.state === 'racing' && race.ghost) {
    const g = race.ghostAt(race.lapMs);
    if (g) {
      ghostKart.group.visible = true;
      placeKart(ghostKart, g.x, g.z, g.h, 0, race.speed * dt / 0.42, 0);
    }
  } else {
    ghostKart.group.visible = race.state !== 'racing' ? false : ghostKart.group.visible;
  }

  stepParticles(dt);

  // Chase camera: behind and above the player, looking ahead of the motion.
  const ahead = 1.8;
  const back = 8.5 - Math.min(2.4, race.speed / 22);
  const up = 4.2 + Math.min(1.2, race.speed / 40);
  const camX = race.pos.x + Math.sin(race.motionHeading) * back;
  const camZ = wz(race.pos.z + Math.cos(race.motionHeading) * back);
  const targetX = race.pos.x - Math.sin(race.motionHeading) * ahead;
  const targetZ = wz(race.pos.z - Math.cos(race.motionHeading) * ahead);
  const lerp = 1 - Math.exp(-6.5 * dt);
  camera.position.lerp(new THREE.Vector3(camX, up, camZ), lerp);
  const look = new THREE.Vector3(targetX, 1.2, targetZ);
  camera.lookAt(look);

  drawMinimap(race, now);
}

function frame(now) {
  requestAnimationFrame(frame);
  let dt = (now - last) / 1000;
  if (dt > 1 / 20) dt = 1 / 20;
  last = now;
  if (dt <= 0) return;
  frames += 1;
  if (now - fpsMark >= 500) { fps = (frames * 1000) / (now - fpsMark); frames = 0; fpsMark = now; }

  wheelFeedback(now);
  channel.poll(now);

  // Keyboard steering fallback (and augment) when no live pointer/tilt.
  if (!channel.pointer.live || race?.state !== 'racing') {
    // Tilt steer comes from onSample; keyboard overrides while keys held.
  }
  if (race) {
    const kSteer = (keys.ArrowRight ? 24 : 0) + (keys.ArrowLeft ? -24 : 0);
    if (kSteer) {
      keys._steered = true;
      race.setSteer(kSteer);
    } else if (keys._steered && !channel.pointer.live) {
      // ease back to centre when keys released and no phone
      race.setSteer(0);
      keys._steered = false;
    }
    // Between rounds the phone rests however: keep steer idle so the next
    // race captures from rest.
    steer.idle = race.state !== 'racing' && race.state !== 'countdown';

    // Countdown pulse banner
    if (race.state === 'countdown') {
      const remain = Math.ceil((race.countdownEnds - now) / 1000);
      if (remain > 0 && remain <= 3) {
        const n = String(remain);
        if ($('banner').textContent.replace(/<[^>]+>/g, '') !== n) {
          flashBanner(n, 3200);
          audio.play('race-count');
        }
      }
    }
    if (countdownPulse && now > countdownPulse) { $('banner').classList.remove('on'); countdownPulse = 0; }
    if (toastUntil && now > toastUntil) { $('toast').classList.remove('on'); toastUntil = 0; }

    race.update(now, dt);
    step(now, dt);
    syncHud(now);
  } else {
    steer.idle = true;
  }

  const w = window.innerWidth; const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
}

// ── Boot ───────────────────────────────────────────────────────────────────

loadTrack(trackIndex);
syncTrackSelect();
if (launchData && launchData.splash) {
  launchData.splash.addEventListener('animationend', () => launchData.splash.remove(), { once: true });
}
requestAnimationFrame(frame);

