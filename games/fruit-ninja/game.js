import * as THREE from '/vendor/three/three.module.js';
import { consumeLaunchSplash, goHome } from '../../core/splash.js';

// Carry the menu's launch banner across the navigation, then fade it out.
const launchData = consumeLaunchSplash();
import { FruitMatch, FIELD_H } from './logic.js';
import { splitLayout, toPixels, toViewport, cellAspect } from '../../core/splitscreen.js';
import { Pointer } from '../../core/pointer.js';
import { saveSensitivity, loadSensitivity } from '../../core/calibration.js';
import { AudioEngine } from '../../core/audio.js';
import { GameLink } from '../../core/net.js';
import { clamp } from '../../core/orientation.js';
import { hydrateIcons } from '../../core/icons.js';

/**
 * Fruit Ninja — Three.js renderer, styled after the original: a wooden dojo
 * wall, fruit that looks like fruit, juice that stains the boards, a white
 * blade swoosh, and brush-lettered score UI.
 *
 * Gameplay runs on the fixed play field in logic.js; this file only maps that
 * field into a 3D scene and draws it. The camera sits at the distance where the
 * field's height exactly fills the frame, which keeps world↔screen a plain
 * linear map and lets the proven 2D collision math carry over untouched.
 */

const $ = (id) => document.getElementById(id);

// Real rules by default: three lives, and a bomb ends your run. Add
// ?practice to the URL for the endless mode (misses and bombs just cost points).
const PRACTICE = new URLSearchParams(location.search).has('practice');
document.body.classList.toggle('practice', PRACTICE);

// ── Scene ──────────────────────────────────────────────────────────────────
const canvas = $('game');
// desynchronized: lets Chrome present the canvas without waiting for the
// compositor's queue — worth up to a frame of cursor latency. Ignored where
// unsupported.
const renderer = new THREE.WebGLRenderer({
  canvas, antialias: true, desynchronized: true, powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2b1a0c);

const FOV = 45;
// One camera per player's cell (see cellFor): same FOV and distance, so the
// field's height always exactly fills a cell whatever its width.
const CAM_Z = (FIELD_H / 2) / Math.tan((FOV / 2) * (Math.PI / 180));

scene.add(new THREE.AmbientLight(0xfff4e0, 0.85));
const key = new THREE.DirectionalLight(0xfff1d6, 1.5);
key.position.set(3, 7, 9);
scene.add(key);
const fill = new THREE.DirectionalLight(0xcfe0ff, 0.3);
fill.position.set(-6, -3, 5);
scene.add(fill);

// ── Canvas-texture helpers ─────────────────────────────────────────────────
function makeTexture(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const rand = (a, b) => a + Math.random() * (b - a);

// ── The dojo wall ──────────────────────────────────────────────────────────
// Vertical planks, warm brown, wavy grain, a few knots, heavy vignette —
// the Original Wood dojo.
const woodTex = makeTexture(1024, 640, (ctx, W, H) => {
  const plank = 93;
  for (let x = 0; x < W; x += plank) {
    const tone = 0.86 + Math.sin(x * 12.7) * 0.1 + Math.random() * 0.08;
    const g = ctx.createLinearGradient(x, 0, x + plank, 0);
    g.addColorStop(0, `rgb(${134 * tone | 0}, ${88 * tone | 0}, ${46 * tone | 0})`);
    g.addColorStop(0.5, `rgb(${148 * tone | 0}, ${99 * tone | 0}, ${54 * tone | 0})`);
    g.addColorStop(1, `rgb(${126 * tone | 0}, ${82 * tone | 0}, ${42 * tone | 0})`);
    ctx.fillStyle = g;
    ctx.fillRect(x, 0, plank, H);

    // Grain: wavy vertical strokes.
    ctx.strokeStyle = `rgba(62, 38, 16, ${rand(0.12, 0.3)})`;
    for (let i = 0; i < 7; i += 1) {
      const gx = x + rand(6, plank - 6);
      ctx.lineWidth = rand(0.6, 1.8);
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      for (let y = 0; y <= H; y += 32) {
        ctx.lineTo(gx + Math.sin(y * 0.02 + gx) * rand(1, 4), y);
      }
      ctx.stroke();
    }
    // The odd knot.
    if (Math.random() < 0.4) {
      const kx = x + plank / 2 + rand(-14, 14);
      const ky = rand(60, H - 60);
      for (let r = 9; r > 1; r -= 2.2) {
        ctx.strokeStyle = `rgba(58, 34, 12, ${0.5 - r * 0.04})`;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.ellipse(kx, ky, r, r * 1.5, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    // Plank seam.
    ctx.fillStyle = 'rgba(40, 22, 8, 0.75)';
    ctx.fillRect(x + plank - 2, 0, 2, H);
  }
  // Vignette so the action pops off the wall.
  const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.72);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(20, 8, 0, 0.55)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
});

const backdrop = new THREE.Mesh(
  new THREE.PlaneGeometry(80, 50),
  new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.92 }),
);
backdrop.position.z = -14;
scene.add(backdrop);

// ── Fruit skins ────────────────────────────────────────────────────────────
// One rind texture (equirect, wrapped around a sphere) and one flesh texture
// (the cut face) per type, drawn once and shared by every instance.
const speckle = (ctx, W, H, n, color, rMin, rMax) => {
  ctx.fillStyle = color;
  for (let i = 0; i < n; i += 1) {
    ctx.beginPath();
    ctx.ellipse(Math.random() * W, Math.random() * H, rand(rMin, rMax), rand(rMin, rMax), rand(0, 3), 0, Math.PI * 2);
    ctx.fill();
  }
};

const RIND_PAINTERS = {
  watermelon: (ctx, W, H) => {
    ctx.fillStyle = '#7ab648';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#2c661e';
    const stripes = 8;
    for (let i = 0; i < stripes; i += 1) {
      const cx = (i + 0.5) * (W / stripes);
      ctx.beginPath();
      ctx.moveTo(cx - 9, 0);
      for (let y = 0; y <= H; y += 16) {
        ctx.lineTo(cx - 9 + Math.sin(y * 0.09 + i * 2) * 7, y);
      }
      for (let y = H; y >= 0; y -= 16) {
        ctx.lineTo(cx + 9 + Math.sin(y * 0.11 + i * 2) * 7, y);
      }
      ctx.closePath();
      ctx.fill();
    }
    speckle(ctx, W, H, 140, 'rgba(44, 102, 30, 0.35)', 1, 3);
  },
  pineapple: (ctx, W, H) => {
    ctx.fillStyle = '#d99c34';
    ctx.fillRect(0, 0, W, H);
    // Diamond lattice with a pale stud in each cell.
    ctx.strokeStyle = 'rgba(122, 76, 20, 0.85)';
    ctx.lineWidth = 3;
    const s = 32;
    for (let d = -H; d < W + H; d += s) {
      ctx.beginPath(); ctx.moveTo(d, 0); ctx.lineTo(d + H, H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(d, H); ctx.lineTo(d + H, 0); ctx.stroke();
    }
    for (let y = s / 2; y < H; y += s) {
      for (let x = (y / s % 2) * (s / 2); x < W; x += s) {
        ctx.fillStyle = 'rgba(245, 216, 130, 0.8)';
        ctx.beginPath();
        ctx.arc(x, y, 3.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  },
  strawberry: (ctx, W, H) => {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#e6392b');
    g.addColorStop(1, '#c01d14');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // Seeds in an offset grid.
    for (let y = 10; y < H - 6; y += 22) {
      for (let x = (y % 44 ? 11 : 0); x < W; x += 23) {
        ctx.fillStyle = '#f8e58a';
        ctx.beginPath();
        ctx.ellipse(x, y, 2.4, 3.6, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(120, 20, 10, 0.5)';
        ctx.beginPath();
        ctx.ellipse(x, y + 4, 2.6, 1.6, 0, 0, Math.PI);
        ctx.fill();
      }
    }
  },
  orange: (ctx, W, H) => {
    ctx.fillStyle = '#f28511';
    ctx.fillRect(0, 0, W, H);
    speckle(ctx, W, H, 420, 'rgba(205, 106, 8, 0.5)', 0.8, 2);
    speckle(ctx, W, H, 160, 'rgba(255, 176, 84, 0.4)', 0.8, 1.8);
  },
  kiwi: (ctx, W, H) => {
    ctx.fillStyle = '#7a5b39';
    ctx.fillRect(0, 0, W, H);
    // Fuzz: short scratchy strokes.
    for (let i = 0; i < 700; i += 1) {
      const x = Math.random() * W;
      const y = Math.random() * H;
      ctx.strokeStyle = Math.random() < 0.5 ? 'rgba(146, 116, 78, 0.5)' : 'rgba(84, 60, 34, 0.5)';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + rand(-3, 3), y + rand(-3, 3));
      ctx.stroke();
    }
  },
  lemon: (ctx, W, H) => {
    ctx.fillStyle = '#f5d321';
    ctx.fillRect(0, 0, W, H);
    speckle(ctx, W, H, 300, 'rgba(214, 178, 14, 0.5)', 0.8, 2);
    speckle(ctx, W, H, 120, 'rgba(255, 244, 150, 0.5)', 0.8, 1.6);
  },
  apple: (ctx, W, H) => {
    ctx.fillStyle = '#7bb92e';
    ctx.fillRect(0, 0, W, H);
    // Faint vertical streaks, like a granny smith.
    for (let i = 0; i < 90; i += 1) {
      const x = Math.random() * W;
      ctx.strokeStyle = Math.random() < 0.6 ? 'rgba(158, 212, 85, 0.5)' : 'rgba(96, 150, 32, 0.45)';
      ctx.lineWidth = rand(1, 2.6);
      ctx.beginPath();
      ctx.moveTo(x, rand(0, H * 0.3));
      ctx.lineTo(x + rand(-4, 4), rand(H * 0.7, H));
      ctx.stroke();
    }
    speckle(ctx, W, H, 90, 'rgba(235, 245, 200, 0.5)', 0.6, 1.2);
  },
  peach: (ctx, W, H) => {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#f8b04a');
    g.addColorStop(0.5, '#f5923e');
    g.addColorStop(1, '#e8543f');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // Blush patches.
    for (let i = 0; i < 12; i += 1) {
      const x = Math.random() * W;
      const y = Math.random() * H;
      const r = rand(18, 44);
      const b = ctx.createRadialGradient(x, y, 0, x, y, r);
      b.addColorStop(0, 'rgba(224, 70, 52, 0.35)');
      b.addColorStop(1, 'rgba(224, 70, 52, 0)');
      ctx.fillStyle = b;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    speckle(ctx, W, H, 200, 'rgba(255, 220, 160, 0.25)', 0.6, 1.4);
  },
};

/** The cut face. Radius 128, centred at (128,128) on a 256² canvas. */
const FLESH_PAINTERS = {
  watermelon: (ctx) => {
    disc(ctx, '#8ec44e');                       // rind edge
    disc(ctx, '#e9f2d0', 122);                  // white rim
    disc(ctx, '#f1373b', 112);                  // red flesh
    // Seeds in two loose rings, pointing outward.
    ctx.fillStyle = '#241a12';
    for (const [ring, n] of [[74, 9], [44, 6]]) {
      for (let i = 0; i < n; i += 1) {
        const a = (i / n) * Math.PI * 2 + ring;
        ctx.save();
        ctx.translate(128 + Math.cos(a) * ring, 128 + Math.sin(a) * ring);
        ctx.rotate(a + Math.PI / 2);
        ctx.beginPath();
        ctx.ellipse(0, 0, 4, 6.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  },
  pineapple: (ctx) => {
    disc(ctx, '#c78a2e');
    disc(ctx, '#f7de74', 118);
    // Fibrous radial strokes + concentric rings.
    ctx.strokeStyle = 'rgba(214, 172, 74, 0.8)';
    for (let i = 0; i < 40; i += 1) {
      const a = (i / 40) * Math.PI * 2;
      ctx.lineWidth = rand(1, 2.4);
      ctx.beginPath();
      ctx.moveTo(128 + Math.cos(a) * 24, 128 + Math.sin(a) * 24);
      ctx.lineTo(128 + Math.cos(a) * 114, 128 + Math.sin(a) * 114);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(230, 196, 110, 0.9)';
    for (const r of [50, 80, 105]) {
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(128, 128, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    disc(ctx, '#f3e9b4', 20);                   // core
  },
  strawberry: (ctx) => {
    disc(ctx, '#d8261f');
    disc(ctx, '#f7bfae', 116);
    disc(ctx, '#fbe9e2', 78);
    // Radial streaks from the pale core.
    ctx.strokeStyle = 'rgba(240, 120, 104, 0.8)';
    for (let i = 0; i < 26; i += 1) {
      const a = (i / 26) * Math.PI * 2;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(128 + Math.cos(a) * 20, 128 + Math.sin(a) * 20);
      ctx.lineTo(128 + Math.cos(a) * 108, 128 + Math.sin(a) * 108);
      ctx.stroke();
    }
  },
  orange: (ctx) => citrus(ctx, '#f28511', '#ffa62b', '#ffd9a3'),
  lemon: (ctx) => citrus(ctx, '#e3c114', '#fbe97b', '#fdf6cd'),
  kiwi: (ctx) => {
    disc(ctx, '#6d5132');
    disc(ctx, '#8cc63f', 120);
    // Pale starburst toward the core.
    ctx.strokeStyle = 'rgba(214, 236, 160, 0.75)';
    for (let i = 0; i < 36; i += 1) {
      const a = (i / 36) * Math.PI * 2;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(128 + Math.cos(a) * 34, 128 + Math.sin(a) * 34);
      ctx.lineTo(128 + Math.cos(a) * 100, 128 + Math.sin(a) * 100);
      ctx.stroke();
    }
    // Seed ring around a white oval core.
    ctx.fillStyle = '#1c150c';
    for (let i = 0; i < 26; i += 1) {
      const a = (i / 26) * Math.PI * 2;
      const r = 44 + (i % 2) * 8;
      ctx.beginPath();
      ctx.ellipse(128 + Math.cos(a) * r, 128 + Math.sin(a) * r, 2.2, 3.4, a, 0, Math.PI * 2);
      ctx.fill();
    }
    disc(ctx, '#f2f7e2', 26);
  },
  apple: (ctx) => {
    disc(ctx, '#9ed455');
    disc(ctx, '#f4f0d5', 118);
    // Star core with two dark seeds.
    ctx.fillStyle = 'rgba(216, 205, 160, 0.9)';
    ctx.beginPath();
    for (let i = 0; i < 10; i += 1) {
      const a = (i / 10) * Math.PI * 2;
      const r = i % 2 ? 14 : 30;
      ctx[i ? 'lineTo' : 'moveTo'](128 + Math.cos(a) * r, 128 + Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#4a2c14';
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(128 + s * 9, 128, 4, 8, s * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
  },
  peach: (ctx) => {
    disc(ctx, '#f5923e');
    disc(ctx, '#fad089', 118);
    const g = ctx.createRadialGradient(128, 128, 12, 128, 128, 70);
    g.addColorStop(0, 'rgba(224, 70, 52, 0.55)');
    g.addColorStop(1, 'rgba(224, 70, 52, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    // The pit.
    disc(ctx, '#8a3d1e', 26);
    ctx.strokeStyle = 'rgba(60, 24, 8, 0.7)';
    for (let i = 0; i < 14; i += 1) {
      const a = rand(0, Math.PI * 2);
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(128 + Math.cos(a) * 6, 128 + Math.sin(a) * 6);
      ctx.lineTo(128 + Math.cos(a) * rand(16, 24), 128 + Math.sin(a) * rand(16, 24));
      ctx.stroke();
    }
  },
};

function disc(ctx, color, r = 128) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(128, 128, r, 0, Math.PI * 2);
  ctx.fill();
}

/** Citrus cut face: pith ring, wedge segments, pale core. */
function citrus(ctx, rindC, fleshC, pithC) {
  disc(ctx, rindC);
  disc(ctx, pithC, 118);
  const wedges = 9;
  ctx.fillStyle = fleshC;
  for (let i = 0; i < wedges; i += 1) {
    const a0 = (i / wedges) * Math.PI * 2 + 0.05;
    const a1 = ((i + 1) / wedges) * Math.PI * 2 - 0.05;
    ctx.beginPath();
    ctx.moveTo(128 + Math.cos(a0) * 12, 128 + Math.sin(a0) * 12);
    ctx.arc(128, 128, 106, a0, a1);
    ctx.closePath();
    ctx.fill();
  }
  disc(ctx, pithC, 11);
}

// Per-type non-uniform scale so a lemon reads as a lemon, not a yellow ball.
const FRUIT_SHAPE = {
  watermelon: [1.18, 0.94, 1],
  pineapple: [0.82, 1.18, 0.82],
  strawberry: [0.95, 1.12, 0.95],
  orange: [1, 1, 1],
  kiwi: [0.92, 1.12, 0.92],
  lemon: [0.88, 1.14, 0.88],
  apple: [1.06, 0.96, 1.06],
  peach: [1.02, 0.98, 1.02],
};

const rindTex = new Map();
const fleshTex = new Map();
for (const name of Object.keys(RIND_PAINTERS)) {
  rindTex.set(name, makeTexture(256, 128, RIND_PAINTERS[name]));
  fleshTex.set(name, makeTexture(256, 256, FLESH_PAINTERS[name]));
}

const match = new FruitMatch({ onEvent: handleEvent, infiniteLives: PRACTICE });

// ── Meshes ─────────────────────────────────────────────────────────────────
const sphereGeo = new THREE.SphereGeometry(1, 28, 20);
const halfGeo = new THREE.SphereGeometry(1, 28, 20, 0, Math.PI);
const particleGeo = new THREE.SphereGeometry(1, 6, 5);
const meshes = new Map();   // logic id → Object3D

const rindMats = new Map();
const fleshMats = new Map();
function rindMat(name) {
  if (!rindMats.has(name)) {
    rindMats.set(name, new THREE.MeshStandardMaterial({
      map: rindTex.get(name), roughness: 0.55, metalness: 0.02,
    }));
  }
  return rindMats.get(name);
}
function fleshMat(name) {
  if (!fleshMats.has(name)) {
    fleshMats.set(name, new THREE.MeshStandardMaterial({
      map: fleshTex.get(name), roughness: 0.85, side: THREE.DoubleSide,
    }));
  }
  return fleshMats.get(name);
}

const leafMat = new THREE.MeshStandardMaterial({ color: 0x2f7a2a, roughness: 0.7 });
const stemMat = new THREE.MeshStandardMaterial({ color: 0x6d4a24, roughness: 0.9 });
const leafGeo = new THREE.ConeGeometry(0.16, 0.75, 6);
const stemGeo = new THREE.CylinderGeometry(0.045, 0.06, 0.3, 6);

/** Crowns, stems and calyxes — the little garnishes that sell the silhouette. */
function garnish(name) {
  const g = new THREE.Group();
  if (name === 'pineapple') {
    for (let i = 0; i < 6; i += 1) {
      const leaf = new THREE.Mesh(leafGeo, leafMat);
      const a = (i / 6) * Math.PI * 2;
      leaf.position.set(Math.cos(a) * 0.16, 1.12, Math.sin(a) * 0.16);
      leaf.rotation.set(Math.sin(a) * 0.55, 0, -Math.cos(a) * 0.55);
      g.add(leaf);
    }
    const centre = new THREE.Mesh(leafGeo, leafMat);
    centre.position.y = 1.25;
    g.add(centre);
  } else if (name === 'strawberry') {
    for (let i = 0; i < 5; i += 1) {
      const leaf = new THREE.Mesh(leafGeo, leafMat);
      const a = (i / 5) * Math.PI * 2;
      leaf.scale.setScalar(0.6);
      leaf.position.set(Math.cos(a) * 0.3, 1.02, Math.sin(a) * 0.3);
      leaf.rotation.set(Math.sin(a) * 1.15, 0, -Math.cos(a) * 1.15);
      g.add(leaf);
    }
  } else if (name === 'apple' || name === 'peach') {
    const stem = new THREE.Mesh(stemGeo, stemMat);
    stem.position.y = 1.02;
    g.add(stem);
    if (name === 'apple') {
      const leaf = new THREE.Mesh(leafGeo, leafMat);
      leaf.scale.set(0.5, 0.4, 0.35);
      leaf.position.set(0.18, 1.06, 0);
      leaf.rotation.z = -1.2;
      g.add(leaf);
    }
  }
  return g.children.length ? g : null;
}

function fruitMesh(f) {
  if (f.bomb) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(sphereGeo, new THREE.MeshStandardMaterial({
      color: 0x15151c, roughness: 0.25, metalness: 0.55,
    }));
    body.scale.setScalar(f.r);
    g.add(body);
    const fuse = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.07, 0.34, 6),
      stemMat,
    );
    fuse.position.y = f.r * 1.1;
    fuse.rotation.z = 0.25;
    g.add(fuse);
    const spark = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xffe08a }),
    );
    spark.position.set(-0.08, f.r * 1.1 + 0.2, 0);
    g.add(spark);
    const glow = new THREE.PointLight(0xffb347, 5, 4);
    glow.position.copy(spark.position);
    g.add(glow);
    g.userData.spark = spark;
    g.userData.glow = glow;
    return g;
  }
  const g = new THREE.Group();
  const body = new THREE.Mesh(sphereGeo, rindMat(f.kind.name));
  body.scale.set(...(FRUIT_SHAPE[f.kind.name] || [1, 1, 1]));
  g.add(body);
  const extra = garnish(f.kind.name);
  if (extra) g.add(extra);
  g.scale.setScalar(f.r);
  return g;
}

function halfMesh(h) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(halfGeo, rindMat(h.kind.name)));
  const flesh = new THREE.Mesh(new THREE.CircleGeometry(1, 28), fleshMat(h.kind.name));
  flesh.rotation.y = Math.PI / 2;
  g.add(flesh);
  g.scale.setScalar(h.r);
  return g;
}

/**
 * Point a half's cut face along the direction it flew, then tumble it about the
 * slice line so the exposed flesh swings into view.
 *
 * The hemisphere geometry's flat face normal is −X, so the alignment rotation
 * about Z is `cut + side·90°`. Tumbling about Z instead — the obvious first
 * guess — keeps the flat face permanently edge-on to the camera, and both
 * halves just read as whole fruit.
 */
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const qAlign = new THREE.Quaternion();
const qTumble = new THREE.Quaternion();
const cutAxis = new THREE.Vector3();

function applyHalfOrientation(mesh, h) {
  qAlign.setFromAxisAngle(Z_AXIS, h.cut + h.side * (Math.PI / 2));
  cutAxis.set(Math.cos(h.cut), Math.sin(h.cut), 0);
  qTumble.setFromAxisAngle(cutAxis, h.tumble);
  mesh.quaternion.copy(qTumble).multiply(qAlign);
}

function particleMesh(p) {
  return new THREE.Mesh(
    particleGeo,
    new THREE.MeshBasicMaterial({ color: p.color, transparent: true }),
  );
}


/** Put an entity (and any lights inside it) on one player's layer only. */
function setLayer(obj, layer) {
  obj.traverse((o) => o.layers.set(layer));
}

/**
 * Meshes are created on first sight and tagged with their board's layer: each
 * player's camera renders only its own layer (plus layer 0 — the wall and the
 * lights), so six boards share one scene without seeing each other's fruit.
 */
function syncMeshes(list, build, apply, layer) {
  for (const item of list) {
    let m = meshes.get(item.id);
    if (!m) {
      m = build(item);
      setLayer(m, layer);
      meshes.set(item.id, m);
      scene.add(m);
    }
    apply(m, item);
  }
}

/** Drop meshes whose logic object is gone — otherwise the scene leaks. */
function pruneMeshes() {
  const alive = new Set();
  for (const board of match.boards.values()) {
    for (const f of board.fruits) alive.add(f.id);
    for (const h of board.halves) alive.add(h.id);
    for (const p of board.particles) alive.add(p.id);
  }
  for (const [id, m] of meshes) {
    if (alive.has(id)) continue;
    scene.remove(m);
    if (m.material && m.material.dispose && !m.material.map) m.material.dispose();
    meshes.delete(id);
  }
}

// ── Juice on the wall ──────────────────────────────────────────────────────
// Every slice throws a splat onto the dojo boards; it lingers, then fades.
const splatTex = makeTexture(256, 256, (ctx) => {
  const blob = (x, y, r) => {
    ctx.beginPath();
    let a0 = rand(0, Math.PI * 2);
    ctx.moveTo(x + Math.cos(a0) * r, y + Math.sin(a0) * r);
    for (let a = 0.5; a <= Math.PI * 2; a += 0.5) {
      const rr = r * rand(0.65, 1.25);
      ctx.lineTo(x + Math.cos(a0 + a) * rr, y + Math.sin(a0 + a) * rr);
    }
    ctx.closePath();
    ctx.fill();
  };
  ctx.fillStyle = '#fff';
  blob(128, 128, 52);
  for (let i = 0; i < 13; i += 1) {
    const a = rand(0, Math.PI * 2);
    const d = rand(50, 110);
    blob(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, rand(4, 17));
  }
});


const SPLAT_MAX = 34;
const SPLAT_Z = -13.8;
const splats = [];

function addSplat(x, y, colour, now, layer) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      map: splatTex, transparent: true, color: colour,
      opacity: 0.85, depthWrite: false,
    }),
  );
  // Splats live on the wall: project the slice point out to the backdrop.
  const k = -SPLAT_Z / CAM_Z + 1;
  m.position.set(x * k, y * k, SPLAT_Z);
  m.rotation.z = rand(0, Math.PI * 2);
  m.scale.setScalar(rand(2.2, 3.6) * k * 0.55);
  setLayer(m, layer);
  scene.add(m);
  splats.push({ m, born: now, layer });
  // Cap per player, so one busy board can't wipe everyone else's stains.
  const mine = splats.filter((s) => s.layer === layer);
  if (mine.length > SPLAT_MAX) removeSplat(mine[0]);
}

function removeSplat(s) {
  scene.remove(s.m);
  s.m.material.dispose();
  const i = splats.indexOf(s);
  if (i !== -1) splats.splice(i, 1);
}

function clearSplats() {
  for (const s of [...splats]) removeSplat(s);
}

function stepSplats(now) {
  for (let i = splats.length - 1; i >= 0; i -= 1) {
    const s = splats[i];
    const age = (now - s.born) / 1000;
    if (age < 1.4) continue;
    s.m.material.opacity = 0.85 * Math.max(0, 1 - (age - 1.4) / 4.5);
    if (s.m.material.opacity <= 0) removeSplat(s);
  }
}

// ── Blade trails, one per player ────────────────────────────────────────────
/**
 * A tapered ribbon rather than a line: the blade arc is the signature visual,
 * and THREE.Line is locked to 1px on every platform regardless of linewidth.
 * Two passes — a wide soft glow under a bright core — for the original's
 * silver swoosh. Every connected phone gets its own pair, tinted so it's
 * obvious whose blade is whose; slot 0 keeps the exact white-on-blue look
 * solo play has always had.
 */
const RIBBON_MAX = 48;

function makeRibbon({ width, colour, opacity, blending }) {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(RIBBON_MAX * 2 * 3);
  const colours = new Float32Array(RIBBON_MAX * 2 * 4);
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colours, 4));

  // Index buffer is static: two triangles per quad, for the maximum length.
  const idx = [];
  for (let i = 0; i < RIBBON_MAX - 1; i += 1) {
    idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  }
  geo.setIndex(idx);

  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity,
    blending,
    depthWrite: false,
    side: THREE.DoubleSide,
  }));
  mesh.frustumCulled = false;
  mesh.userData = { width, colour: new THREE.Color(colour) };
  scene.add(mesh);
  return mesh;
}

// Fixed palette by slot — 4 phones max (see server.js's MAX_PLAYERS).
const PLAYER_TINTS = [
  { glow: 0xbfd9ff, core: 0xffffff },   // slot 0 — the original white/blue blade
  { glow: 0xffb3c0, core: 0xff5f6d },   // slot 1 — red
  { glow: 0xc8f5b0, core: 0x7ed957 },   // slot 2 — green
  { glow: 0xffe9b0, core: 0xffd166 },   // slot 3 — gold
];
const tintFor = (slot) => PLAYER_TINTS[slot % PLAYER_TINTS.length];


const visuals = new Map();   // slot → { ribbons: [glow, core], tip, tipGlow }
function visualFor(slot) {
  let v = visuals.get(slot);
  if (v) return v;
  const tint = tintFor(slot);
  const layer = slot + 1;
  const ribbons = [
    makeRibbon({ width: 0.5, colour: tint.glow, opacity: 0.35, blending: THREE.AdditiveBlending }),
    makeRibbon({ width: 0.16, colour: tint.core, opacity: 0.95, blending: THREE.NormalBlending }),
  ];
  const tip = new THREE.Mesh(
    new THREE.SphereGeometry(0.11, 12, 10),
    new THREE.MeshBasicMaterial({ color: tint.core }),
  );
  scene.add(tip);
  const tipGlow = new THREE.PointLight(tint.glow, 5, 6);
  scene.add(tipGlow);
  // Only that player's own camera sees (and is lit by) their blade.
  for (const o of [...ribbons, tip, tipGlow]) setLayer(o, layer);
  v = { ribbons, tip, tipGlow };
  visuals.set(slot, v);
  return v;
}

function drawOneTrail(player, v) {
  const pts = player.trail.points;
  const n = Math.min(pts.length, RIBBON_MAX);
  const start = pts.length - n;

  for (const ribbon of v.ribbons) {
    const pos = ribbon.geometry.attributes.position.array;
    const col = ribbon.geometry.attributes.color.array;
    const { width, colour } = ribbon.userData;

    for (let i = 0; i < n; i += 1) {
      const p = pts[start + i];
      const prev = pts[start + Math.max(0, i - 1)];
      const next = pts[start + Math.min(n - 1, i + 1)];
      let tx = next.x - prev.x;
      let ty = next.y - prev.y;
      const len = Math.hypot(tx, ty) || 1;
      tx /= len;
      ty /= len;

      // Widest at the head, pinched to nothing at the tail.
      const taper = n > 1 ? i / (n - 1) : 1;
      const hw = (width * taper * taper) / 2;
      const o = i * 6;
      pos[o] = p.x - ty * hw; pos[o + 1] = p.y + tx * hw; pos[o + 2] = 0.4;
      pos[o + 3] = p.x + ty * hw; pos[o + 4] = p.y - tx * hw; pos[o + 5] = 0.4;

      const c = i * 8;
      for (const off of [0, 4]) {
        col[c + off] = colour.r; col[c + off + 1] = colour.g; col[c + off + 2] = colour.b;
        col[c + off + 3] = taper * taper;
      }
    }

    ribbon.geometry.attributes.position.needsUpdate = true;
    ribbon.geometry.attributes.color.needsUpdate = true;
    ribbon.geometry.setDrawRange(0, Math.max(0, (n - 1) * 6));
    ribbon.visible = n > 1;
  }

  v.tip.position.set(player.cursor.x, player.cursor.y, 0.4);
  v.tipGlow.position.copy(v.tip.position);
  v.tip.visible = player.cursor.active;
  v.tipGlow.visible = player.cursor.active;
}

function hideVisual(v) {
  for (const r of v.ribbons) r.visible = false;
  v.tip.visible = false;
  v.tipGlow.visible = false;
}

function drawTrail() {
  for (const [slot, board] of match.boards) drawOneTrail(board.getPlayer(0), visualFor(slot));
  for (const [slot, v] of visuals) if (!match.boards.has(slot)) hideVisual(v);
}

// ── Audio ──────────────────────────────────────────────────────────────────
const audio = new AudioEngine();

// The fruit-ninja cue set: squishy slices, a throw-pop, a gong. Every one is
// overridable by dropping audio/<name>.mp3 next to the server.
audio.register('fn-throw', (a) => {
  a.noise({ dur: 0.22, gain: 0.1, type: 'bandpass', freq: 500, sweepTo: 2600, q: 1.6 });
  a.tone({ freq: 300, slideTo: 540, dur: 0.16, type: 'sine', gain: 0.07 });
});

audio.register('fn-slice', (a, { size = 0.65, combo = 1 } = {}) => {
  const depth = 1 - clamp((size - 0.55) / 0.31, 0, 1);   // big fruit = wetter, lower
  a.noise({ dur: 0.1, gain: 0.32, type: 'highpass', freq: 2400, sweepTo: 6000 });
  a.noise({
    dur: 0.16, gain: 0.3, type: 'bandpass',
    freq: 500 + depth * 500 + Math.random() * 120, sweepTo: 180, q: 1.1,
  });
  a.tone({
    freq: 120 + depth * 90 + Math.min(combo, 6) * 12,
    slideTo: 60, dur: 0.14, type: 'triangle', gain: 0.22,
  });
});

audio.register('fn-combo', (a, { combo = 3 } = {}) => {
  const base = 440 + Math.min(combo, 8) * 55;
  a.tone({ freq: base, dur: 0.09, type: 'square', gain: 0.08 });
  a.tone({ freq: base * 1.5, dur: 0.14, type: 'sine', gain: 0.16, delay: 0.06 });
});

audio.register('fn-critical', (a) => {
  a.tone({ freq: 880, dur: 0.08, type: 'square', gain: 0.09 });
  a.tone({ freq: 1318, dur: 0.09, type: 'square', gain: 0.09, delay: 0.05 });
  a.tone({ freq: 1760, dur: 0.22, type: 'sine', gain: 0.16, delay: 0.1 });
  a.noise({ dur: 0.25, gain: 0.08, type: 'highpass', freq: 6000 });
});

audio.register('fn-miss', (a) => {
  a.tone({ freq: 330, slideTo: 190, dur: 0.22, type: 'sine', gain: 0.18 });
  a.tone({ freq: 247, slideTo: 140, dur: 0.28, type: 'sine', gain: 0.14, delay: 0.1 });
});

audio.register('fn-gameover', (a) => {
  // A gong: low fundamentals with slow decay under a metallic shimmer.
  a.tone({ freq: 130.8, dur: 2.4, type: 'sine', gain: 0.34, attack: 0.01 });
  a.tone({ freq: 98, dur: 2.8, type: 'sine', gain: 0.26, attack: 0.01 });
  a.tone({ freq: 196, dur: 1.9, type: 'triangle', gain: 0.12, attack: 0.01 });
  a.noise({ dur: 1.6, gain: 0.1, type: 'bandpass', freq: 900, sweepTo: 300, q: 6 });
});

// ── Pointer, one per connected phone ────────────────────────────────────────
// Rate-based gyro aiming, no calibration flow: each pointer is live from its
// own phone's first packet, and the learned gyro gain lives inside the
// Pointer itself — independently per phone. `inputs` is keyed by the
// server-assigned slot (see server.js); slot 0 always exists so mouse/keyboard
// desk-testing keeps working with no phone attached at all.
const inputs = new Map();   // slot → { pointer, lastSampleAt }

function inputFor(slot) {
  let inp = inputs.get(slot);
  if (!inp) {
    const p = new Pointer({});
    // Only slot 0's sensitivity is persisted; every other slot starts at default.
    p.sensitivity = (slot === 0 ? loadSensitivity() : null) ?? 1;
    p.setViewport(window.innerWidth, window.innerHeight);
    inp = { pointer: p, lastSampleAt: 0 };
    inputs.set(slot, inp);
  }
  return inp;
}
inputFor(0);

// ── Cells: one viewport + camera + DOM HUD per board ───────────────────────
const cells = new Map();   // slot → cell
const layerOf = (slot) => slot + 1;

/** CSS colour for a slot's blade, so its text reads as theirs. */
const cssTint = (slot) => `#${tintFor(slot).core.toString(16).padStart(6, '0')}`;

function cellFor(slot) {
  let c = cells.get(slot);
  if (c) return c;
  const cam = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
  cam.position.set(0, 0, CAM_Z);
  cam.layers.enable(layerOf(slot));
  const el = document.createElement('div');
  el.className = 'cell';
  el.dataset.slot = String(slot);
  el.style.setProperty('--tint', cssTint(slot));
  el.innerHTML = `
    <div class="c-score">
      <div class="c-score-row"><span class="c-ico"><i data-icon="fruit"></i></span><span class="c-score-v">0</span></div>
      <div class="c-best">BEST: 0</div>
      <div class="c-name">P${slot + 1}</div>
    </div>
    <div class="c-lives"><div><span class="x">✗</span><span class="x">✗</span><span class="x">✗</span></div>
      <div class="c-practice">PRACTICE · ∞ LIVES</div></div>
    <div class="c-fx"></div>
    <div class="c-miss">✗</div>
    <div class="c-flash"></div>
    <div class="c-out"><div><b>OUT</b><span></span><small>waiting for the others…</small></div></div>`;
  $('cells').appendChild(el);
  hydrateIcons(el);
  c = {
    slot, layer: layerOf(slot), cam, el,
    rect: { x: 0, y: 0, w: 1, h: 1 }, px: { x: 0, y: 0, w: 1, h: 1 }, aspect: 16 / 9,
    refs: {
      score: el.querySelector('.c-score-v'), best: el.querySelector('.c-best'),
      xs: [...el.querySelectorAll('.c-lives .x')], fx: el.querySelector('.c-fx'),
      miss: el.querySelector('.c-miss'), flash: el.querySelector('.c-flash'),
      out: el.querySelector('.c-out'), outScore: el.querySelector('.c-out span'),
    },
    missTimer: 0,
  };
  cells.set(slot, c);
  return c;
}

/** Split the window between the boards in play and size every camera/pointer to its cell. */
function layoutCells() {
  const slots = match.slots;
  const W = Math.max(1, window.innerWidth);
  const H = Math.max(1, window.innerHeight);
  const { cells: rects } = splitLayout(slots.length, 'cols');
  document.body.classList.toggle('multi', slots.length > 1);
  slots.forEach((slot, i) => {
    const c = cellFor(slot);
    c.rect = rects[i];
    c.px = toPixels(rects[i], W, H);
    c.aspect = cellAspect(rects[i], W, H);
    c.cam.aspect = c.aspect;
    c.cam.updateProjectionMatrix();
    match.setAspect(slot, c.aspect);
    Object.assign(c.el.style, {
      left: `${c.px.x}px`, top: `${c.px.y}px`, width: `${c.px.w}px`, height: `${c.px.h}px`,
    });
    c.el.style.setProperty('--s', String(clamp(Math.min(c.px.w / 1000, c.px.h / 640), 0.45, 1.3)));
    inputFor(slot).pointer.setViewport(c.px.w, c.px.h);
  });
  for (const [slot, c] of cells) {
    if (slots.includes(slot)) continue;
    c.el.remove();
    cells.delete(slot);
  }
}

function resize() {
  renderer.setSize(Math.max(1, window.innerWidth), Math.max(1, window.innerHeight), false);
  layoutCells();
}
window.addEventListener('resize', resize);

/** Cell-normalised pointer (0..1, y down) → world units on the z=0 plane. */
function toWorld(nx, ny, aspect) {
  const halfH = FIELD_H / 2;
  const halfW = halfH * aspect;
  return { x: (nx - 0.5) * 2 * halfW, y: (0.5 - ny) * 2 * halfH };
}

/** World units → percent of the cell, for the DOM splash text. */
function toCellPercent(x, y, aspect) {
  const halfH = FIELD_H / 2;
  const halfW = halfH * aspect;
  return { left: (x / (2 * halfW) + 0.5) * 100, top: (0.5 - y / (2 * halfH)) * 100 };
}

/**
 * The link pill names every connected phone and whether it's actually
 * streaming motion — "P2 no motion" is the difference between a paired phone
 * and a playing one.
 */
function syncLinkLabel() {
  const occupied = (link.slots || []).filter((s) => s.occupied);
  const streaming = (slot) => {
    const inp = inputs.get(slot);
    return inp && performance.now() - inp.lastSampleAt < 2000;
  };
  if (occupied.length === 0) { $('link-t').textContent = 'no remote connected'; return; }
  if (occupied.length === 1) {
    $('link-t').textContent = streaming(occupied[0].slot) ? 'remote connected' : 'remote paired · no motion yet';
    return;
  }
  $('link-t').textContent = occupied.map((s) => `P${s.slot + 1}${streaming(s.slot) ? '' : ' (no motion)'}`).join(' · ');
}
setInterval(syncLinkLabel, 1000);

/** Re-centre one phone's blade; names the player once there's more than one. */
function recentreSlot(slot) {
  inputFor(slot).pointer.recentre();
  flash(link.controllers > 1 ? `P${slot + 1} re-centred` : 're-centred');
}

// ── Lobby ──────────────────────────────────────────────────────────────────
// The first round waits for someone to say go (A on any phone, Space, or a
// click) instead of throwing fruit at an empty room: friends scanning the QR
// code take a while to connect, and an unattended round used to be over before
// they arrived. Fruit is held back, boards and phones are live. Arriving from
// the launcher with a phone already paired auto-starts after a short grace
// (restarted by every new arrival), so the common case stays one tap.
let lobby = true;
let lobbyTimer = 0;
const AUTO_START_MS = 3000;

function renderLobby() {
  if (!lobby) return;
  const occupied = occupiedSlots();
  const roster = occupied.length
    ? occupied.map((slot) => `<span class="pdot" style="background:${cssTint(slot)}"></span>P${slot + 1}`).join(' &nbsp; ')
    : '<span style="font-size:16px;font-family:inherit;color:#b39468">no remote connected — mouse &amp; keyboard work too</span>';
  const auto = launchData?.room && occupied.length ? ' · starting…' : '';
  showOverlay(`<h1>Fruit <em>Ninja</em></h1>
    <p>Three lives each. Bombs end your run. Last one standing with the top score wins.</p>
    <div style="font-family:'Permanent Marker',cursive;font-size:24px;margin:4px 0 8px;text-align:center">${roster}</div>
    <div class="cta"><strong>A</strong> / <strong>Space</strong> / click to start${auto}</div>`);
}

function leaveLobby() {
  if (!lobby) return;
  lobby = false;
  clearTimeout(lobbyTimer);
  hideOverlay();
  const at = performance.now() + 1200;
  for (const b of match.boards.values()) b.state.nextSpawn = at;
}

function armAutoStart() {
  clearTimeout(lobbyTimer);
  if (lobby && launchData?.room && occupiedSlots().length > 0) {
    lobbyTimer = setTimeout(leaveLobby, AUTO_START_MS);
  }
}

// ── Who is playing ─────────────────────────────────────────────────────────
// deskMode: no phone has ever been seen this round, so slot 0 is the
// mouse/keyboard player. The moment a phone appears the board belongs to it.
let deskMode = true;

const occupiedSlots = () => (link.slots || []).filter((s) => s.occupied).map((s) => s.slot);

/** Reconcile the running match with whoever is connected right now. */
function syncParticipants() {
  const occupied = occupiedSlots();
  const now = performance.now();
  if (match.phase !== 'playing') return;
  if (deskMode && occupied.length > 0) {
    deskMode = false;
    // The only connected phone isn't slot 0: the desk board was a placeholder.
    if (!occupied.includes(0)) { startGame(); return; }
  }
  if (!deskMode) {
    for (const slot of occupied) {
      if (match.join(slot, now)) flash(`P${slot + 1} joined`);
    }
    for (const slot of match.slots) {
      if (!occupied.includes(slot) && !match.isOver(slot)) {
        match.leave(slot, now);
        flash(`P${slot + 1} left`);
      }
    }
  }
  layoutCells();
  syncHud();
}

function onRosterChange() {
  syncParticipants();
  renderLobby();
  armAutoStart();
}

const link = new GameLink({
  room: launchData?.room,
  onOrientation: (sample, slot) => {
    const now = performance.now();
    const inp = inputFor(slot);
    const dt = inp.lastSampleAt ? clamp((now - inp.lastSampleAt) / 1000, 1 / 240, 0.1) : 1 / 60;
    inp.lastSampleAt = now;
    inp.pointer.update(sample, dt, now);
  },
  onCommand: (cmd, slot) => {
    if (cmd.type === 'calibrate' || cmd.type === 'recentre') recentreSlot(slot);
    else if (cmd.type === 'start') beginPlay();
    else if (cmd.type === 'button' && cmd.button === 'A') beginPlay();
    // B returns to the menu, so the whole loop is reachable from the phone.
    else if (cmd.type === 'button' && cmd.button === 'B') goHome(audio, link.room);
    else if (cmd.type === 'speed') {
      const inp = inputFor(slot);
      inp.pointer.sensitivity = clamp(inp.pointer.sensitivity * (cmd.factor || 1), 0.2, 6);
      if (slot === 0) saveSensitivity(inp.pointer.sensitivity);
      const label = link.controllers > 1 ? `P${slot + 1} speed` : 'pointer speed';
      flash(`${label} ${(inp.pointer.sensitivity * 100).toFixed(0)}%`);
    }
  },
  onPresence: (p) => {
    $('dot').classList.toggle('on', p.controller > 0);
    syncLinkLabel();
    onRosterChange();
  },
});

// Lead every blade by the measured network delay (see Pointer.setNetworkRtt).
link.onLatency = (ms) => { for (const inp of inputs.values()) inp.pointer.setNetworkRtt(ms); };
setInterval(() => link.probeLatency(), 3000);

// ── DOM effects: splash text, the red miss ✗, the bomb flash ──────────────
function splash(slot, worldX, worldY, text, cls = '', colour = null) {
  const c = cells.get(slot);
  if (!c) return;
  const el = document.createElement('div');
  el.className = `splash ${cls}`;
  el.textContent = text;
  if (colour) el.style.color = colour;
  const p = toCellPercent(worldX, worldY, c.aspect);
  el.style.left = `${p.left}%`;
  el.style.top = `${p.top}%`;
  c.refs.fx.appendChild(el);
  setTimeout(() => el.remove(), 950);
}

function missFlash(slot, worldX) {
  const c = cells.get(slot);
  if (!c) return;
  const el = c.refs.miss;
  const board = match.board(slot);
  const lim = (board ? board.w : 16) * 0.42;
  el.style.left = `${toCellPercent(clamp(worldX, -lim, lim), 0, c.aspect).left}%`;
  el.classList.remove('on');
  void el.offsetWidth;               // restart the animation
  el.classList.add('on');
  clearTimeout(c.missTimer);
  c.missTimer = setTimeout(() => el.classList.remove('on'), 800);
}

function bombFlash(slot) {
  const c = cells.get(slot);
  if (!c) return;
  c.refs.flash.classList.remove('on');
  void c.refs.flash.offsetWidth;
  c.refs.flash.classList.add('on');
}

// ── Events from the logic layer ────────────────────────────────────────────
// Browsers keep audio locked until a click or keypress on THIS page. When the
// whole session is phone-driven, that never happens — so say so, once.
let soundHintShown = false;
function maybeSoundHint() {
  if (soundHintShown || audio.muted) return;
  if (!audio.ctx || audio.ctx.state !== 'running') {
    soundHintShown = true;
    flash('click or press any key to enable sound');
  }
}

let lastThrowAt = 0;
let finishedAt = -Infinity;
const RESTART_GUARD_MS = 1000;   // a swinging player's A press must not skip the results

function handleEvent(e) {
  const slot = e.slot ?? 0;
  if (e.type === 'launch') {
    // Four boards launch at once in a full lobby: one whoosh, not four.
    const t = performance.now();
    if (t - lastThrowAt > 80) { lastThrowAt = t; audio.play('fn-throw'); }
  } else if (e.type === 'slice') {
    maybeSoundHint();
    audio.play('fn-slice', { size: e.r, combo: e.combo });
    addSplat(e.x, e.y, e.kind.splat, performance.now(), layerOf(slot));
    if (e.critical) {
      audio.play('fn-critical');
      splash(slot, e.x, e.y, 'CRITICAL', 'crit');
      splash(slot, e.x, e.y - 0.9, `+${e.gained}`, 'plus', cssTint(slot));
    } else if (e.combo >= 3) {
      audio.play('fn-combo', { combo: e.combo });
      splash(slot, e.x, e.y, `COMBO ×${e.combo}`, 'combo');
    } else {
      splash(slot, e.x, e.y, `+${e.gained}`, 'plus', cssTint(slot));
    }
    // Only the phone that landed the cut feels it (server routes by slot).
    link.feedback({ type: 'slice', combo: e.combo, slot });
  } else if (e.type === 'bomb') {
    audio.play('explode');
    bombFlash(slot);
    if (!e.fatal) splash(slot, e.x, e.y, '−10', 'penalty');
    link.feedback({ type: 'bomb', slot });
  } else if (e.type === 'miss') {
    audio.play('fn-miss');
    missFlash(slot, e.x ?? 0);
    link.feedback({ type: 'miss', slot });
  } else if (e.type === 'out') {
    audio.play('fn-gameover');
    const board = match.board(slot);
    // Their blade goes with them.
    if (board) { const p = board.getPlayer(0); p.cursor.active = false; p.trail.clear(); }
  } else if (e.type === 'matchover') {
    finishedAt = performance.now();
    showResults(e);
  }
  syncHud();
}

function showResults(e) {
  if (e.solo) {
    const score = e.standings[0].score;
    const best = Math.max(Number(localStorage.getItem('fn.best') || 0), score);
    localStorage.setItem('fn.best', String(best));
    showOverlay(`<h1 class="gameover">GAME OVER</h1>
      <div id="final">score <b>${score}</b> · best <b>${best}</b></div>
      <div class="cta"><strong>Space</strong> / <strong>A</strong> to play again</div>`);
    return;
  }
  const title = e.winners.length > 1
    ? 'DRAW!'
    : `<span style="color:${cssTint(e.winners[0])}">P${e.winners[0] + 1}</span> WINS!`;
  const why = { lives: 'out of lives', out: 'out', left: 'left' };
  const rows = e.standings.map((s) => `<div class="row${e.winners.includes(s.slot) ? ' win' : ''}">
      <span class="pdot" style="background:${cssTint(s.slot)}"></span>${s.rank}. P${s.slot + 1}
      <i>${why[s.reason] || ''}</i><b>${s.score}</b></div>`).join('');
  showOverlay(`<h1 class="gameover" style="font-size:72px">${title}</h1>
    <div class="results">${rows}</div>
    <div class="cta"><strong>Space</strong> / <strong>A</strong> to play again</div>`);
}

// ── Overlays / HUD ─────────────────────────────────────────────────────────
let toastUntil = 0;
function flash(text) {
  toastUntil = performance.now() + 2200;
  $('toast').textContent = text.toUpperCase();
  $('toast').classList.add('on');
}

const showOverlay = (html) => { $('panel').innerHTML = html; $('overlay').classList.remove('hide'); };
const hideOverlay = () => $('overlay').classList.add('hide');

function syncHud() {
  const multi = match.count > 1;
  const best = Number(localStorage.getItem('fn.best') || 0);
  for (const [slot, board] of match.boards) {
    const c = cellFor(slot);
    const st = board.state;
    c.refs.score.textContent = st.score;
    c.refs.best.textContent = `BEST: ${Math.max(best, st.score)}`;
    for (let i = 0; i < c.refs.xs.length; i += 1) {
      c.refs.xs[i].classList.toggle('lost', !PRACTICE && i >= st.lives);
    }
    // Solo shows the full-screen game-over panel instead.
    const out = multi && match.isOver(slot);
    c.refs.out.classList.toggle('on', out);
    if (out) c.refs.outScore.textContent = `score ${st.score}`;
  }
}

function startGame() {
  if (!lobby) hideOverlay();
  clearSplats();
  const occupied = occupiedSlots();
  deskMode = occupied.length === 0;
  match.start(occupied, performance.now());
  layoutCells();
  syncHud();
}

function beginPlay() {
  audio.unlock();
  if (lobby) { leaveLobby(); return; }
  if (match.phase === 'playing') return;
  if (performance.now() - finishedAt < RESTART_GUARD_MS) return;
  startGame();
}

/** Mirror the logic state into the scene graph. Split out so the verification
 *  harness can time a frame's work directly, without depending on rAF cadence. */
function syncScene(now = performance.now()) {
  for (const [slot, board] of match.boards) {
    const layer = layerOf(slot);
    syncMeshes(board.fruits, fruitMesh, (m, f) => {
      m.position.set(f.x, f.y, 0);
      m.rotation.set(f.rot * f.spinAxis.x, f.rot * f.spinAxis.y, f.rot * f.spinAxis.z);
      if (m.userData.spark) {
        // The fuse flickers.
        const flicker = 0.65 + Math.abs(Math.sin(now / 47 + f.id)) * 0.8;
        m.userData.glow.intensity = 5 * flicker;
        m.userData.spark.scale.setScalar(flicker);
      }
    }, layer);
    syncMeshes(board.halves, halfMesh, (m, h) => {
      m.position.set(h.x, h.y, 0);
      applyHalfOrientation(m, h);
    }, layer);
    syncMeshes(board.particles, particleMesh, (m, p) => {
      m.position.set(p.x, p.y, 0.2);
      m.scale.setScalar(p.r * Math.max(0.2, p.life));
      m.material.opacity = clamp(p.life, 0, 1);
    }, layer);
  }
  pruneMeshes();
  stepSplats(now);
  drawTrail();
}

/** One render per cell, each through its own camera and scissor rect. */
function renderCells() {
  const W = Math.max(1, window.innerWidth);
  const H = Math.max(1, window.innerHeight);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, W, H);
  renderer.clear();
  renderer.setScissorTest(true);
  for (const slot of match.slots) {
    const c = cells.get(slot);
    if (!c) continue;
    const vp = toViewport(c.rect, W, H);
    renderer.setViewport(vp.x, vp.y, vp.w, vp.h);
    renderer.setScissor(vp.x, vp.y, vp.w, vp.h);
    renderer.render(scene, c.cam);
  }
}

// ── Loop ───────────────────────────────────────────────────────────────────
let last = performance.now();
let frames = 0;
let fpsMark = performance.now();
let fps = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 1 / 20);
  last = now;
  if (dt <= 0) return;

  frames += 1;
  if (now - fpsMark >= 500) {
    fps = (frames * 1000) / (now - fpsMark);
    frames = 0;
    fpsMark = now;
  }

  // Drive every board's blade every frame, not every packet: the trail's
  // speed window then sees display-rate motion, which is what the slice
  // threshold is tuned against.
  for (const slot of match.slots) {
    if (match.isOver(slot)) continue;
    const inp = inputFor(slot);
    const c = cells.get(slot);
    if (!c) continue;
    if (inp.pointer.live && now - inp.pointer.lastSeen > 500) inp.pointer.live = false;
    // Mouse fallback only ever stands in for slot 0 — there's one mouse.
    const useMouse = slot === 0 && !inp.pointer.live && mouse.active;
    if (useMouse) {
      const nx = clamp((mouse.x * window.innerWidth - c.px.x) / c.px.w, 0, 1);
      const ny = clamp((mouse.y * window.innerHeight - c.px.y) / c.px.h, 0, 1);
      inp.pointer.setFromMouse(nx, ny);
    }
    if (inp.pointer.live || useMouse) {
      const aim = inp.pointer.sampleAt(now);
      const p = toWorld(aim.x, aim.y, c.aspect);
      match.setCursor(slot, p.x, p.y, now);
    }
  }

  if (lobby) for (const b of match.boards.values()) b.state.nextSpawn = Infinity;
  match.update(now, dt);
  syncScene(now);

  if (toastUntil && now > toastUntil) { toastUntil = 0; $('toast').classList.remove('on'); }

  renderCells();
}

// ── Input ──────────────────────────────────────────────────────────────────
const mouse = { x: 0.5, y: 0.5, active: false };
window.addEventListener('mousemove', (e) => {
  mouse.x = e.clientX / window.innerWidth;
  mouse.y = e.clientY / window.innerHeight;
  mouse.active = true;
});
window.addEventListener('pointerdown', () => { audio.unlock(); if (lobby) leaveLobby(); });

// Keyboard/desk fallback always addresses slot 0 — the one guaranteed input.
window.addEventListener('keydown', (e) => {
  audio.unlock();
  const p0 = inputFor(0).pointer;
  switch (e.key.toLowerCase()) {
    case ' ': e.preventDefault(); beginPlay(); break;
    case 'r':
    case 'c': recentreSlot(0); break;
    case 'arrowright':
      p0.sensitivity = clamp(p0.sensitivity * 1.12, 0.2, 6);
      saveSensitivity(p0.sensitivity);
      flash(`pointer speed ${(p0.sensitivity * 100).toFixed(0)}%`);
      break;
    case 'arrowleft':
      p0.sensitivity = clamp(p0.sensitivity / 1.12, 0.2, 6);
      saveSensitivity(p0.sensitivity);
      flash(`pointer speed ${(p0.sensitivity * 100).toFixed(0)}%`);
      break;
    case 'd': $('debug').classList.toggle('on'); break;
    default: break;
  }
});

setInterval(() => {
  syncHud();
  if (!$('debug').classList.contains('on')) return;
  const p0 = inputFor(0).pointer;
  const players = [...inputs.entries()]
    .map(([slot, inp]) => `P${slot + 1}:${inp.pointer.hasGyro ? (inp.pointer.gyroTrusted ? '✓' : '…') : '–'}`)
    .join(' ');
  const b0 = match.board(match.slots[0]);
  $('debug').textContent = [
    `mode        ${p0.mode}`,
    `gyro map    ${p0.describeMap()}`,
    `rate        ${p0.rateDps.yaw.toFixed(1)} / ${p0.rateDps.pitch.toFixed(1)} deg/s`,
    `pointer     ${p0.display.x.toFixed(3)}, ${p0.display.y.toFixed(3)}`,
    `gesture     ${b0 ? b0.trail.speed().toFixed(2) : '–'} u/s`,
    `sensor rate ${link.rate.toFixed(0)} Hz`,
    `source      ${p0.source}`,
    `fps         ${fps.toFixed(0)}`,
    `players     ${players}`,
    `boards      ${match.slots.map((s) => `P${s + 1}`).join(' ')}`,
    `meshes      ${meshes.size} · splats ${splats.length}`,
  ].join('\n');
}, 250);

resize();
// Try to unlock audio immediately: when the page was reached by clicking a
// channel tile, the browser carries that gesture across the navigation and
// this succeeds — sound works without ever touching the PC again.
audio.unlock();
// Boards exist from the first frame, but the first fruit waits in the lobby
// (see above). startGame touches const helpers that are in the temporal dead
// zone until the whole module has evaluated, hence calling it down here.
startGame();
renderLobby();
requestAnimationFrame(frame);

// Exposed for the verification harness / e2e tests. `game` is the first
// board (what the single-player build exposed); `match`/`cells` are the full
// multiplayer picture.
window.__senwii = {
  match, cells, inputs, audio, link, toWorld, toCellPercent,
  get game() { return match.board(match.slots[0]); },
  get pointer() { return inputFor(0).pointer; },
  scene, renderer, meshes, splats, visuals,
  get lobby() { return lobby; },
  syncScene, drawTrail, pruneMeshes, layoutCells, startGame, beginPlay,
  fps: () => fps,
};

hydrateIcons();
