import * as THREE from '/vendor/three/three.module.js';
import { consumeLaunchSplash, goHome } from '../../core/splash.js';
import { icon, hydrateIcons } from '../../core/icons.js';

// Carry the menu's launch banner across the navigation, then fade it out.
const launchData = consumeLaunchSplash();
import { createChannel } from '../../core/channel.js';
import { axesFromSample } from '../../core/orientation.js';
import { TraySteer } from '../../core/tilt.js';
import { splitLayout, toViewport } from '../../core/splitscreen.js';
import {
  Race, TRACKS, trackBySlug, trackCenterAt, trackNormal, trackHeading,
  trackLengthM, tAtS, nearestOnTrack, fmtMs, medalFor, loadSave, persistSave,
  ordinal, TOP_SPEED, BOOST_SPEED, BOOST_T, DRIFT_CHARGE_T1, DRIFT_CHARGE_T2,
  DRIFT_CHARGE_T3, RACER_COUNT, GRID_ROW_M, PODIUM, POINTS, MAX_HUMANS,
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
// One chase camera per human; a lone player only ever uses cameras[0].
const cameras = Array.from({ length: MAX_HUMANS }, () => new THREE.PerspectiveCamera(62, 1, 0.3, 1500));

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

/** Free an object tree's GPU resources (geometries, materials, their maps). */
function disposeTree(root) {
  root.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      if (m.map) m.map.dispose();
      m.dispose();
    }
  });
}

function disposeWorld() {
  disposeTree(world);
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

// One kart per possible human. Colours are distinct from the CPU rivals' and
// double as the player colour on every HUD (P1 red … P4 white).
const PLAYER_COLORS = [0xe23b3b, 0x00d1c1, 0xff5fa8, 0xf2f2f2];
const cssColor = (c) => `#${c.toString(16).padStart(6, '0')}`;
const playerKarts = PLAYER_COLORS.map((c) => {
  const k = buildKart(c, { helmet: 0xf6f2ea });
  k.group.visible = false;
  scene.add(k.group);
  // Boost flames on the tail.
  const flameGeo = new THREE.ConeGeometry(0.34, 1.6, 8);
  flameGeo.rotateX(-Math.PI / 2);
  k.flames = [-0.55, 0.55].map((side) => {
    const f = new THREE.Mesh(flameGeo, additive(0x7fd4ff, 0.9));
    f.position.set(side, 0.55, 2.4);
    f.visible = false;
    k.tilt.add(f);
    return f;
  });
  return k;
});
playerKarts[0].group.visible = true;
const rivalKarts = new Map();          // kart id → { group, tilt, wheels }
const ghostKart = buildKart(0x9ecbff, { ghost: true });
ghostKart.group.visible = false;
scene.add(ghostKart.group);

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
  // Screen y follows WORLD z (= −logic z, see wz) so the map isn't mirrored.
  mm.oy = h / 2 + ((minZ + maxZ) / 2) * mm.scale;
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
    const y = -p.z * mm.scale + mm.oy;
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
  g.arc(s.x * mm.scale + mm.ox, -s.z * mm.scale + mm.oy, 4.5, 0, Math.PI * 2);
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
    mmCtx.arc(x * mm.scale + mm.ox, -z * mm.scale + mm.oy, r, 0, Math.PI * 2);
    mmCtx.fill();
  };
  for (const k of race.karts) {
    const kp = race.kartWorldPos(k);
    dot(kp.x, kp.z, `#${k.color.toString(16).padStart(6, '0')}`, 5);
  }
  const pulse = 6 + Math.sin(now / 180) * 1.4;
  for (const c of race.cars) {
    if (c.out) continue;
    dot(c.pos.x, c.pos.z, cssColor(PLAYER_COLORS[c.index]), pulse);
  }
}

// ── UI + persistence ───────────────────────────────────────────────────────

let save = loadSave();
let trackIndex = 0;
const cupPoints = [0, 0, 0];

const medalTag = (medal) => (medal ? `${icon('medal', medal)} ${medal}` : '');

function syncTrackSelect() {
  const wrap = $('tracks');
  wrap.innerHTML = '';
  TRACKS.forEach((t, i) => {
    const unlocked = i < save.unlocked;
    const best = save.bestLaps[t.slug];
    const medal = medalFor(t, best);
    const card = document.createElement('div');
    card.className = `track${i === trackIndex ? ' sel' : ''}${unlocked ? '' : ' locked'}`;
    card.innerHTML = `<div class="te">${icon(unlocked ? t.icon : 'lock')}</div>
      <div class="tn">${t.name}</div>
      <div class="tm">${unlocked ? (best ? `${fmtMs(best)} ${medalTag(medal)}` : 'no record') : 'finish top 3 to unlock'}</div>`;
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
    if (i < save.unlocked) break;
  }
  if (i === trackIndex || i >= save.unlocked) return;   // nothing else unlocked
  trackIndex = i;
  // A finished race lives on the old track's coordinates: stop stepping it
  // under the new scenery. The next A starts a fresh race here.
  race = null;
  buildCells(1);
  syncTrackSelect();
  loadTrack(trackIndex);
  channel.audio.play('hover');
}

// ── Players ────────────────────────────────────────────────────────────────
// A "slot" is the relay's phone index (P1 = slot 0). A "car" is a seat in the
// current race. `participants[car] = slot`, fixed when the race starts, so a
// phone that joins mid-race waits for the next one.

let participants = [];               // car index → relay slot
let phoneCars = new Set();           // cars driven by a real phone (vs. keyboard only)
const steers = new Map();            // slot → TraySteer, one neutral per phone
const lastSampleAt = new Map();      // slot → performance.now() of its latest packet

let invertSteer = false;
try { invertSteer = localStorage.getItem('senwii.racingInvert') === '1'; } catch { /* private mode */ }

function steerFor(slot) {
  let st = steers.get(slot);
  if (!st) {
    // Failsafe: if steering ever feels backwards, I inverts it and sticks.
    st = new TraySteer({ invert: invertSteer });
    steers.set(slot, st);
  }
  return st;
}
const carOfSlot = (slot) => participants.indexOf(slot);
const slotLabel = (car) => `P${(participants[car] ?? car) + 1}`;
const occupiedSlots = () => (channel.link.slots || []).filter((s) => s.occupied).map((s) => s.slot);

function rosterHtml() {
  const occ = occupiedSlots();
  if (!occ.length) return '<span class="pl">keyboard · 1 player</span>';
  return occ.slice(0, MAX_HUMANS).map((s) => `<span class="pl"><span class="pdot" style="background:${cssColor(PLAYER_COLORS[s % PLAYER_COLORS.length])}"></span>P${s + 1}</span>`).join('')
    + (occ.length > 1 ? `<span class="pl">${occ.length} players · split screen</span>` : '');
}
function refreshRoster() {
  const el = $('roster');
  if (el) el.innerHTML = rosterHtml();
}

// ── Split-screen HUD ───────────────────────────────────────────────────────
// One HUD card set per cell; a lone player's cell is the whole screen and
// looks exactly as the single-player HUD always has.

let layout = splitLayout(1, 'rows');
const cellEls = [];

function buildCells(n) {
  layout = splitLayout(n, 'rows');
  $('hud').classList.toggle('split', n > 1);
  const host = $('cells');
  host.innerHTML = '';
  cellEls.length = 0;
  layout.cells.forEach((r, i) => {
    const el = document.createElement('div');
    el.className = 'cell';
    el.style.cssText = `left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%;`;
    el.style.setProperty('--pc', cssColor(PLAYER_COLORS[i]));
    el.innerHTML = `<div class="card racecard"><div class="place">6th</div>
        <div class="laprow">lap 1/3</div><div class="timetrial">0:00.00</div></div>
      <div class="tag">${slotLabel(i)}</div>
      <div class="fin"></div>
      <div class="speedo"><div class="speed">0<small> km/h</small></div>
        <div class="driftwrap"><div class="drift"></div></div></div>
      <div class="toast"></div>`;
    host.appendChild(el);
    const q = (c) => el.querySelector(`.${c}`);
    cellEls.push({
      root: el, place: q('place'), laprow: q('laprow'), time: q('timetrial'), tag: q('tag'),
      fin: q('fin'), speed: q('speed'), driftwrap: q('driftwrap'), drift: q('drift'),
      toast: q('toast'), toastUntil: 0,
    });
  });
  layoutHud(n);
}

/** Park the shared minimap/standings where the split leaves room for them. */
function layoutHud(n) {
  const mmEl = $('minimap');
  const st = $('standings');
  mmEl.style.cssText = '';
  st.style.cssText = '';
  if (n === 1) return;
  st.style.display = 'none';
  const centre = (x, y, size) => {
    mmEl.style.cssText = `left:${x * 100}%;top:${y * 100}%;right:auto;bottom:auto;`
      + `width:${size}px;height:${size}px;transform:translate(-50%,-50%);`;
  };
  if (n === 3 && layout.spare) {
    const sp = layout.spare;
    centre(sp.x + sp.w * 0.74, sp.y + sp.h * 0.5, 176);
    st.style.cssText = `display:block;right:auto;left:${(sp.x + sp.w * 0.06) * 100}%;top:${(sp.y + sp.h * 0.5) * 100}%;`
      + 'transform:translateY(-50%);';
  } else {
    centre(0.5, 0.5, 112);
  }
}

function showMenu() {
  syncTrackSelect();
  $('panel').innerHTML = `<h1>${icon('car')} <em>Turbo Racing</em></h1>
    <p>Hold the phone like a wheel and roll it to steer. Bank into a corner and
       hold <b>A</b> to drift — let go for a mini-turbo. Blue arrows are boost
       pads. Finish <b>top 3</b> to unlock the next cup. Up to <b>4 players</b>:
       every phone that joins gets its own split-screen view.</p>
    <div id="roster"></div>
    <div id="tracks"></div>
    <div id="points"></div>
    <div class="cta"><strong>A</strong> or <strong>Space</strong> race · <strong>↑↓</strong> pick track · <strong>B</strong> menu</div>`;
  syncTrackSelect();
  refreshRoster();
  $('overlay').classList.remove('hide');
}

// ── State ──────────────────────────────────────────────────────────────────

let race = null;
let finishedAt = -Infinity;          // performance.now() of the last finish
const RESTART_GUARD_MS = 1000;       // a held/bounced A must not skip the results
let last = performance.now();
let fps = 0; let frames = 0; let fpsMark = last;
let countdownPulse = 0;
let resultMenuShown = false;

// Grid pose of the selected track, for the menu backdrop between races.
let preview = null;

function loadTrack(index) {
  pads.length = 0;
  for (const rk of rivalKarts.values()) {
    scene.remove(rk.group);
    disposeTree(rk.group);
  }
  rivalKarts.clear();
  buildTrack(TRACKS[index]);
  buildMinimap(TRACKS[index]);
  drawMinimap(null, performance.now());
  preview = new Race({ trackIndex: index });
  preview.start(0);                  // only to place the player on the grid
}

const canStart = () => !race || race.state === 'finished';
/** A from any phone starts a race; mid-race it hops that phone's own car into a drift. */
function pressA(slot) {
  if (canStart()) {
    if (race && performance.now() - finishedAt < RESTART_GUARD_MS) return;
    startRace();
  } else if (race.state === 'racing') {
    // The keyboard (no slot) drives the first seat.
    const car = slot === undefined || slot === null ? 0 : carOfSlot(slot);
    if (car >= 0) race.setDrift(true, performance.now(), car);
  }
}

// ── Input ──────────────────────────────────────────────────────────────────

const channel = createChannel({
  room: launchData?.room,
  // Phone A, Space/Enter (auto-repeat filtered by the channel) and a click
  // all land here: start a race from the menu, or hop into a drift. The
  // release comes back as button-up / keyup / pointerup below.
  onA: pressA,
  onB: null, // default home
  // ←/→ steer here; they must not rewrite the shared pointer sensitivity.
  deskKeys: false,
  onCommand: (cmd, slot = 0) => {
    const car = carOfSlot(slot);
    if (cmd.type === 'calibrate' || cmd.type === 'recentre') {
      steerFor(slot).recentre();
      flashToast('steering centred', 1400, car >= 0 && race ? car : null);
    }
    // The wheel-mode HOME button sends its own type; treat it like B.
    if (cmd.type === 'home') goHome(channel.audio, channel.link.room);
    if (cmd.type === 'button') {
      // (A and B never reach here: the channel routes them to onA / onB.)
      const b = cmd.button;
      if (b === '1' && race && car >= 0) race.setBrake(true, car);
      // One direction per press: the crosspad's on-screen direction when
      // the phone sends it, else the physical button.
      const dir = cmd.menuDirection || b;
      if (dir === 'up') changeTrack(-1);
      else if (dir === 'down') changeTrack(1);
    }
    if (cmd.type === 'button-up' && race && car >= 0) {
      const b = cmd.button;
      if (b === 'A') race.setDrift(false, performance.now(), car);
      if (b === '1') race.setBrake(false, car);
    }
  },
  onSample: (sample, dt, now, slot = 0) => {
    // Each phone has its own pointer (for body rate) and its own neutral.
    const ptr = channel.pointerFor(slot);
    const deg = steerFor(slot).update(axesFromSample(sample), dt, now, ptr.bodyRate);
    lastSampleAt.set(slot, performance.now());
    const car = carOfSlot(slot);
    if (race && car >= 0) race.setSteer(deg, car);
  },
  onPresenceChange: (p) => onPresence(p),
});

const { audio } = channel;
const steer = steerFor(0);           // desk/keyboard seat; also the debug read-out

const announced = new Set();
function onPresence(p) {
  const occ = (p.slots || []).filter((s) => s.occupied).map((s) => s.slot);
  for (const s of occ) channel.pointerFor(s);   // per-phone input from the first packet
  const live = race && (race.state === 'racing' || race.state === 'countdown');
  if (live) {
    participants.forEach((slot, car) => {
      if (phoneCars.has(car) && !occ.includes(slot) && !race.cars[car].out) {
        race.dropCar(car, performance.now());
        flashToast(`${slotLabel(car)} left the race`, 2200);
      }
    });
    for (const s of occ) {
      if (!participants.includes(s) && !announced.has(s)) {
        announced.add(s);
        flashToast(`P${s + 1} joins next race`, 2200);
      }
    }
  } else {
    announced.clear();
    refreshRoster();
  }
  setTimeout(syncLinkLabel, 0);   // after the channel's own one-line label
}

function syncLinkLabel() {
  const occ = occupiedSlots();
  const label = $('link-t');
  if (!label) return;
  if (occ.length > 1) label.textContent = `${occ.length} remotes · ${occ.map((s) => `P${s + 1}`).join(' ')}`;
}
setInterval(syncLinkLabel, 1000);

// Engine is a continuous loop that follows speed: implemented by re-ticking
// a short tone burst on a timer (Web Audio oscillator-per-note model).
// Split screen shares one speaker: it follows the fastest car.
let engineTimer = null;
let enginePhase = 0;
function startEngine() {
  if (engineTimer) return;
  engineTimer = setInterval(() => {
    if (!race || race.state === 'ready' || !audio.ctx || audio.ctx.state !== 'running') return;
    const lead = race.cars.reduce((a, c) => (c.speed > a.speed ? c : a), race.cars[0]);
    const speed = lead.speed;
    if (speed < 0.5) return;
    const f = 55 + speed * 5.5 + (lead.drifting ? 38 : 0);
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
  // A smaller field than last race (more humans): hide the spare CPU karts.
  const ids = new Set(race.karts.map((k) => k.id));
  for (const [id, rk] of rivalKarts) rk.group.visible = ids.has(id);
}

function startRace() {
  if (trackIndex >= save.unlocked) return;
  resultMenuShown = false;
  const now = performance.now();

  // Seats: every phone currently in the room (max 4), else the keyboard alone.
  const occ = occupiedSlots().slice(0, MAX_HUMANS);
  participants = occ.length ? occ : [0];
  phoneCars = new Set(occ.length ? occ.map((_, i) => i) : []);
  announced.clear();
  for (const slot of participants) {
    // Capture "straight" mid-countdown, once the player is holding the wheel.
    steerFor(slot).recentre(now + 1200);
    steerFor(slot).idle = false;
    if (phoneCars.size) channel.pointerFor(slot);
  }
  audio.unlock();
  startEngine();

  const track = TRACKS[trackIndex];
  const humans = participants.length;
  const ghost = humans === 1 ? save.ghosts[track.slug] || null : null;
  race = new Race({ trackIndex, onEvent: handleEvent, seed: (now * 997) | 0, ghost, humans });
  buildCells(humans);
  ensureRivals();
  ghostKart.group.visible = false;

  race.start(now);
  // Snap every chase camera onto its kart: a fresh camera must not glide in from the origin.
  race.cars.forEach((c, i) => chaseCamera(cameras[i], c.pos, c.motionHeading, 0, null));
  playerKarts.forEach((k, i) => { k.group.visible = i < humans; });
  $('overlay').classList.add('hide');
  flashBanner('', 0);
  syncHud(now);
}

const keys = {};
window.addEventListener('keydown', (e) => {
  keys[e.key] = true;
  if (e.key.startsWith('Arrow')) e.preventDefault();
  // Space/Enter press → channel → onA (pressA). Everything below is a
  // one-shot action, so auto-repeat is "still holding", not a new press.
  if (e.repeat) return;
  const k = e.key.toLowerCase();
  if (e.key === 'ArrowUp') changeTrack(-1);
  if (e.key === 'ArrowDown') changeTrack(1);
  // deskKeys is off (arrows steer here), so the debug overlay lives here.
  if (k === 'd') $('debug').classList.toggle('on');
  if (k === 'i') {
    invertSteer = !invertSteer;
    for (const st of steers.values()) st.setInvert(invertSteer);
    try { localStorage.setItem('senwii.racingInvert', invertSteer ? '1' : '0'); } catch { /* private mode */ }
    flashToast(invertSteer ? 'steering inverted' : 'steering normal');
  }
  if (k === 'x' || k === '1') { if (race) race.setBrake(true, 0); }
});
window.addEventListener('keyup', (e) => {
  keys[e.key] = false;
  if (e.key === ' ' || e.key === 'Enter') { if (race) race.setDrift(false, performance.now(), 0); }
  const k = e.key.toLowerCase();
  if (k === 'x' || k === '1') { if (race) race.setBrake(false, 0); }
});
// A click is A (via the channel); letting go ends the drift it started.
window.addEventListener('pointerup', () => { if (race) race.setDrift(false, performance.now(), 0); });

function flashBanner(text, ms = 1000) {
  $('banner').innerHTML = text;
  if (text) { $('banner').classList.add('on'); countdownPulse = performance.now() + ms; }
  else $('banner').classList.remove('on');
}
/** A toast in one player's cell (`car`), or in every cell. */
function flashToast(text, ms = 1400, car = null) {
  const targets = car === null || car === undefined ? cellEls : [cellEls[car]].filter(Boolean);
  for (const c of targets) {
    c.toast.textContent = text;
    c.toast.classList.add('on');
    c.toastUntil = performance.now() + ms;
  }
}

/** Per-phone haptics: a car event buzzes only its own driver's phone. */
const buzz = (e, msg) => channel.feedback({ ...msg, slot: participants[e.car] });

function handleEvent(e) {
  const solo = race.humans === 1;
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
    flashToast(['', 'BLUE DRIFT', 'ORANGE DRIFT', 'PINK DRIFT'][e.tier] || '', 600, e.car);
    buzz(e, { type: 'slice', combo: e.tier });
  } else if (e.type === 'boost') {
    audio.play('race-boost', { tier: e.tier });
    buzz(e, { type: 'slice', combo: e.tier });
  } else if (e.type === 'pad') {
    audio.play('race-pad');
    buzz(e, { type: 'slice', combo: 1 });
  } else if (e.type === 'lap') {
    audio.play('race-lap', { best: e.best });
    buzz(e, { type: 'slice', combo: e.best ? 3 : 1 });
    flashToast(e.best ? `LAP ${e.lap} — NEW BEST ${fmtMs(e.ms)}` : `LAP ${e.lap}  ${fmtMs(e.ms)}`, 2200, e.car);
  } else if (e.type === 'rescue') {
    audio.play('fail');
    flashToast('rescued!', 900, e.car);
    buzz(e, { type: 'miss' });
  } else if (e.type === 'dropout') {
    flashToast('DISCONNECTED', 4000, e.car);
  } else if (e.type === 'finish') {
    audio.play(e.place <= 3 ? 'race-go' : 'fail');
    buzz(e, { type: e.place === 1 ? 'slice' : 'miss', combo: 3 });
    const track = race.track;
    const wasUnlocked = save.unlocked;
    if (solo) {
      finishedAt = performance.now();
      cupPoints[track.order] = e.points;
      const prevBest = save.bestLaps[track.slug];
      if (!prevBest || (e.bestLapMs && e.bestLapMs < prevBest)) {
        save.bestLaps[track.slug] = e.bestLapMs;
        // The best lap's keys, not whichever lap happened to be last.
        if (race.bestRecording && race.bestRecording.length) save.ghosts[track.slug] = race.bestRecording;
      }
    }
    // Anyone's podium opens the next cup; records and ghosts stay solo-only.
    if (!e.dnf && e.place <= PODIUM && track.order + 1 >= save.unlocked) {
      save.unlocked = Math.min(TRACKS.length, track.order + 2);
    }
    persistSave(save);
    if (solo) showResults(e, save.unlocked > wasUnlocked);
    else flashToast(e.dnf ? 'DNF' : `${ordinal(e.place)} place!`, 4000, e.car);
  } else if (e.type === 'raceover' && !solo) {
    finishedAt = performance.now();
    showResultsMulti(e);
  }
}

function showResults(e, newlyUnlocked) {
  const track = race.track;
  const medal = medalFor(track, e.bestLapMs);
  const hasNext = track.order + 1 < TRACKS.length;
  const unlockLine = newlyUnlocked && hasNext
    ? `Unlocked <strong>${TRACKS[track.order + 1].name}</strong>!`
    : e.place > PODIUM && hasNext && save.unlocked <= track.order + 1
      ? 'Finish top 3 to unlock the next cup.' : '';
  const rows = e.standings.map((s, i) => {
    const cls = s.who === 'you' ? ' class="you"' : '';
    const tag = s.who === 'you' ? 'YOU' : s.who;
    const mark = s.done !== null ? icon('flag') : `${Math.round(s.prog)}m`;
    return `<div${cls}>${i + 1}. ${tag}<b>${mark}</b></div>`;
  }).join('');
  const head = e.place === 1 ? 'Champion!' : e.place <= 3 ? 'Podium!' : 'Race over';
  const medalTxt = medal ? ` · ${medalTag(medal)}` : '';
  $('panel').innerHTML = `<h1>${icon('flag')} <em>${head}</em></h1>
    <p>${ordinal(e.place)} place — <strong>${e.points} pts</strong>${medalTxt}. Best lap ${fmtMs(e.bestLapMs)}.</p>
    <div class="results">${rows}</div>
    <p>${unlockLine}</p>
    <div id="tracks"></div>
    <div id="points"></div>
    <div class="cta"><strong>A</strong> race again · <strong>↑↓</strong> pick track · <strong>B</strong> menu</div>`;
  syncTrackSelect();
  $('overlay').classList.remove('hide');
  resultMenuShown = true;
}

/** Everyone's result once the last human is done: places, points, full order. */
function showResultsMulti(e) {
  const at = (car) => e.standings.findIndex((s) => s.car === car) + 1;
  const humans = race.cars.map((c) => ({ car: c.index, place: at(c.index), dnf: c.dnf, out: c.out }))
    .sort((a, b) => a.place - b.place);
  const winner = humans.find((h) => !h.out && !h.dnf) || humans[0];
  const hl = humans.map((h) => {
    const pts = h.out ? 0 : POINTS[Math.min(POINTS.length, h.place) - 1];
    const note = h.out ? 'left' : h.dnf ? 'DNF' : `${pts} pts`;
    return `<div><b style="color:${cssColor(PLAYER_COLORS[h.car])}">${slotLabel(h.car)}</b> ${ordinal(h.place)} · ${note}</div>`;
  }).join('');
  const rows = e.standings.map((s, i) => {
    const human = s.car !== undefined;
    const tag = human ? slotLabel(s.car) : s.who;
    const mark = s.dnf ? 'DNF' : s.done !== null ? icon('flag') : `${Math.round(s.prog)}m`;
    return `<div class="${human ? 'you' : ''}${s.dnf ? ' dnf' : ''}">${i + 1}. ${tag}<b>${mark}</b></div>`;
  }).join('');
  $('panel').innerHTML = `<h1>${icon('flag')} <em>${slotLabel(winner.car)} wins!</em></h1>
    <div class="humans">${hl}</div>
    <div class="results">${rows}</div>
    <div id="tracks"></div>
    <div id="points"></div>
    <div class="cta"><strong>A</strong> race again · <strong>↑↓</strong> pick track · <strong>B</strong> menu</div>`;
  syncTrackSelect();
  $('overlay').classList.remove('hide');
  resultMenuShown = true;
}

function syncHud(now) {
  if (!race) return;
  race.cars.forEach((car, i) => {
    const el = cellEls[i];
    if (!el) return;
    el.place.textContent = ordinal(car.rank);
    const lap = Math.min(car.lap, race.laps);
    el.laprow.textContent = `lap ${lap}/${race.laps} · best ${fmtMs(car.bestLapMs)}`;
    el.time.textContent = fmtMs(race.state === 'countdown' ? 0 : car.lapMs);
    const kmh = Math.round(car.speed * 3.6);
    const boosting = now < Math.max(car.boostUntil, car.padBoostUntil);
    el.speed.innerHTML = `${kmh}<small> km/h${boosting ? ` ${icon('bolt', 'fill')}` : ''}</small>`;
    if (car.drifting || car.driftTier > 0) {
      el.driftwrap.classList.add('on');
      const pct = car.driftTier === 3 ? 100
        : car.driftTier === 2 ? 66 + ((car.driftCharge - DRIFT_CHARGE_T2) / (DRIFT_CHARGE_T3 - DRIFT_CHARGE_T2)) * 34
        : car.driftTier === 1 ? 33 + ((car.driftCharge - DRIFT_CHARGE_T1) / (DRIFT_CHARGE_T2 - DRIFT_CHARGE_T1)) * 33
        : (car.driftCharge / DRIFT_CHARGE_T1) * 33;
      el.drift.style.width = `${Math.min(100, pct)}%`;
    } else {
      el.driftwrap.classList.remove('on');
    }
    // Done (or gone) while the others are still racing.
    if (car.out) {
      el.fin.innerHTML = 'DISCONNECTED';
      el.fin.classList.add('on');
    } else if (car.finishedMs !== null || car.dnf) {
      el.fin.innerHTML = `${car.dnf ? 'DNF' : 'FINISHED'}<small>${ordinal(car.rank)} place</small>`;
      el.fin.classList.add('on');
    } else {
      el.fin.classList.remove('on');
    }
  });
  // standings strip (shown for a lone player, and in the spare cell for three)
  if (race.cars.length === 1 || race.cars.length === 3) {
    $('standings').innerHTML = race.standings().map((s, i) => {
      const human = s.car !== undefined;
      const cls = human ? ' class="you"' : '';
      const tag = s.who === 'you' ? 'YOU' : human ? slotLabel(s.car) : s.who;
      return `<div${cls}>${i + 1}. ${tag}</div>`;
    }).join('');
  }
  // debug
  const dbg = $('debug');
  if (dbg && dbg.classList.contains('on')) {
    const c = race.cars[0];
    dbg.textContent = [
      `fps ${fps.toFixed(0)}  steer ${steer.describe()}  cars ${race.cars.length}`,
      `spd ${c.speed.toFixed(1)}  onTrack ${c.onTrack}  scraping ${c.scraping}`,
      `drift ${c.drifting} tier ${c.driftTier} chg ${c.driftCharge.toFixed(2)}`,
      `prog ${c.progressM.toFixed(1)}  t ${c.trackT.toFixed(3)}  lap ${c.lap}`,
      `state ${race.state}  rank ${c.rank}`,
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

const scrapeAccum = [0, 0, 0, 0];
const sparkAccum = [0, 0, 0, 0];

function stepCar(car, i, now, dt) {
  const kart = playerKarts[i];
  const leaning = car.steer * Math.PI / 180 * 0.18;
  const boosting = now < Math.max(car.boostUntil, car.padBoostUntil);
  const wheelSpin = car.speed * dt / 0.42;      // r ≈ 0.42 m
  placeKart(kart, car.pos.x, car.pos.z, car.heading, leaning, wheelSpin, car.steer);
  for (const f of kart.flames) {
    f.visible = boosting && car.finishedMs === null;
    f.scale.set(1, 1, 0.6 + Math.random() * 0.9);
  }

  // Drift sparks from the rear wheels.
  if (car.drifting && car.speed > 10) {
    sparkAccum[i] += dt;
    const tier = car.driftTier;
    const color = tier >= 3 ? 0xff4e6e : tier >= 2 ? 0xff8a3e : tier >= 1 ? 0x4ecbff : 0xf0f4ff;
    const count = tier >= 2 ? 3 : 1;
    while (sparkAccum[i] > 0.025) {
      sparkAccum[i] -= 0.025;
      for (let n = 0; n < count; n += 1) {
        const side = n % 2 ? -0.8 : 0.8;
        const rx = Math.cos(car.motionHeading) * side - Math.sin(car.motionHeading) * 1.4;
        const rz = -Math.sin(car.motionHeading) * side - Math.cos(car.motionHeading) * 1.4;
        spawnParticle(
          car.pos.x + rx, 0.25, wz(car.pos.z + rz),
          color,
          new THREE.Vector3((Math.random() - 0.5) * 4, 2 + Math.random() * 3, (Math.random() - 0.5) * 4),
          0.35 + Math.random() * 0.25, 0.7 + tier * 0.15,
        );
      }
    }
  } else {
    sparkAccum[i] = 0;
  }

  // Dust when off the road.
  if (!car.onTrack && car.speed > 5) {
    if (Math.random() < dt * 18) {
      spawnParticle(
        car.pos.x + (Math.random() - 0.5) * 1.4, 0.15, wz(car.pos.z) + (Math.random() - 0.5) * 1.4,
        0xd7c49a,
        new THREE.Vector3((Math.random() - 0.5) * 3, 1.5 + Math.random() * 2, (Math.random() - 0.5) * 3),
        0.5, 0.9,
      );
    }
  }

  // Scrape sound tick.
  if (car.scraping) {
    scrapeAccum[i] += dt;
    if (scrapeAccum[i] > 0.14) { scrapeAccum[i] = 0; audio.play('race-scrape'); }
  } else scrapeAccum[i] = 0;
}

function step(now, dt) {
  // Animate boost pads.
  for (const pad of pads) {
    pad.userData.pulse += dt * 4;
    pad.material.opacity = 0.7 + Math.sin(pad.userData.pulse) * 0.25;
  }

  race.cars.forEach((car, i) => stepCar(car, i, now, dt));

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

  // Ghost (solo only: Race drops it when several humans race).
  if (race.state === 'racing' && race.ghost) {
    const g = race.ghostAt(race.cars[0].lapMs);
    if (g) {
      ghostKart.group.visible = true;
      placeKart(ghostKart, g.x, g.z, g.h, 0, race.cars[0].speed * dt / 0.42, 0);
    }
  } else {
    ghostKart.group.visible = race.state !== 'racing' ? false : ghostKart.group.visible;
  }

  stepParticles(dt);

  race.cars.forEach((car, i) => chaseCamera(cameras[i], car.pos, car.motionHeading, car.speed, dt));
  drawMinimap(race, now);
}

/** Behind and above the kart, looking ahead of its motion. */
function chaseCamera(cam, pos, motionHeading, speed, dt) {
  const ahead = 1.8;
  const back = 8.5 - Math.min(2.4, speed / 22);
  const up = 4.2 + Math.min(1.2, speed / 40);
  const camX = pos.x + Math.sin(motionHeading) * back;
  const camZ = wz(pos.z + Math.cos(motionHeading) * back);
  const targetX = pos.x - Math.sin(motionHeading) * ahead;
  const targetZ = wz(pos.z - Math.cos(motionHeading) * ahead);
  const lerp = dt === null ? 1 : 1 - Math.exp(-6.5 * dt);
  cam.position.lerp(new THREE.Vector3(camX, up, camZ), lerp);
  cam.lookAt(new THREE.Vector3(targetX, 1.2, targetZ));
}

/** Menu backdrop: the player's kart parked on the selected track's grid. */
function stepPreview(dt) {
  if (!preview) return;
  playerKarts.forEach((k, i) => { k.group.visible = i === 0; });
  placeKart(playerKarts[0], preview.pos.x, preview.pos.z, preview.heading);
  for (const f of playerKarts[0].flames) f.visible = false;
  ghostKart.group.visible = false;
  if (dt) stepParticles(dt);
  chaseCamera(cameras[0], preview.pos, preview.heading, 0, dt);
}

/** One render per cell: each camera gets its own scissored viewport. */
renderer.setClearColor(0x0d0b18);
function renderViews(n) {
  const w = window.innerWidth; const h = window.innerHeight;
  renderer.setSize(w, h, false);
  if (cellEls.length !== n) buildCells(n);
  renderer.setScissorTest(true);
  // Wipe everything first so a spare cell (3 players) reads as a dark panel.
  renderer.setViewport(0, 0, w, h);
  renderer.setScissor(0, 0, w, h);
  renderer.setClearColor(0x0d0b18);   // scene.background overwrites this on every render
  renderer.clear();
  for (let i = 0; i < n; i += 1) {
    const vp = toViewport(layout.cells[i], w, h);
    renderer.setViewport(vp.x, vp.y, vp.w, vp.h);
    renderer.setScissor(vp.x, vp.y, vp.w, vp.h);
    cameras[i].aspect = Math.max(1, vp.w) / Math.max(1, vp.h);
    cameras[i].updateProjectionMatrix();
    renderer.render(scene, cameras[i]);
  }
  renderer.setScissorTest(false);
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

  for (const st of steers.values()) st.idle = !race || (race.state !== 'racing' && race.state !== 'countdown');

  if (race) {
    // Tilt steer arrives via onSample; held arrow keys override it on the
    // first seat. A phone that went quiet centres its wheel — one that drops
    // mid-corner must not leave the car locked at its last angle.
    const kSteer = (keys.ArrowRight ? 24 : 0) + (keys.ArrowLeft ? -24 : 0);
    race.cars.forEach((car, i) => {
      const slot = participants[i];
      const live = performance.now() - (lastSampleAt.get(slot) ?? -Infinity) < 500;
      if (i === 0 && kSteer) race.setSteer(kSteer, 0);
      else if (!live) race.setSteer(0, i);
    });

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
    for (const c of cellEls) {
      if (c.toastUntil && performance.now() > c.toastUntil) { c.toast.classList.remove('on'); c.toastUntil = 0; }
    }

    race.update(now, dt);
    step(now, dt);
    syncHud(now);
  } else {
    stepPreview(dt);
  }

  renderViews(race ? race.cars.length : 1);
}

// ── Boot ───────────────────────────────────────────────────────────────────

hydrateIcons();
buildCells(1);
loadTrack(trackIndex);
syncTrackSelect();
if (preview) stepPreview(null);       // snap the camera, no glide-in from origin
if (launchData && launchData.splash) {
  launchData.splash.addEventListener('animationend', () => launchData.splash.remove(), { once: true });
}
requestAnimationFrame(frame);

// Exposed for the end-to-end tests (tests/e2e/racing.mjs).
//   race / cars     the live Race and its human Car objects (null / [] in the menu)
//   participants()  car index → relay slot for the current race
//   link, channel   the relay link and input channel; steers: slot → TraySteer
//   cameras, layout(), cellEls  the split-screen view state actually rendered
//   playerKarts     the per-human kart meshes; startRace() begins a race
window.__senwii = {
  get race() { return race; },
  get cars() { return race ? race.cars : []; },
  participants: () => participants.slice(),
  link: channel.link,
  channel,
  steers,
  cameras,
  layout: () => layout,
  cellEls,
  playerKarts,
  renderer,
  scene,
  startRace,
  lastSampleAt,
};
