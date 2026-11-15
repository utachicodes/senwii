import * as THREE from '/vendor/three/three.module.js';

/**
 * Shared visual-polish primitives — a pooled sprite particle burst and a
 * tiny canvas-texture helper. Three games (bowling, boxing, air-hockey) hit
 * impacts/goals often enough that a one-off burst per call site would be a
 * lot of near-identical code; this is the one copy.
 */

/** A radial-gradient dot, for glow sprites and particle textures. */
export function dotTexture(hex = '#ffffff', size = 64) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, hex);
  grad.addColorStop(1, `${hex}00`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

/** Any procedural canvas texture: draw(ctx, size) does the painting. */
export function canvasTexture(draw, size = 256) {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  draw(c.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

/**
 * A fixed pool of additive sprites for impact bursts — no per-event alloc,
 * no cleanup to forget. spawn() fires a burst from a point; update(dt) ages
 * and moves every live particle, gravity included.
 */
export class ParticleBurst {
  constructor(scene, { texture, maxParticles = 80, gravity = -2.4 } = {}) {
    this.gravity = gravity;
    this.pool = [];
    for (let i = 0; i < maxParticles; i += 1) {
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: texture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      sprite.visible = false;
      scene.add(sprite);
      this.pool.push({ sprite, vx: 0, vy: 0, vz: 0, age: 0, life: 1, active: false });
    }
    this.cursor = 0;
  }

  spawn(pos, {
    count = 14, speed = 2, spread = 1, size = 0.08, life = 0.6, color = 0xffffff, upBias = 0.3,
  } = {}) {
    for (let i = 0; i < count; i += 1) {
      const p = this.pool[this.cursor];
      this.cursor = (this.cursor + 1) % this.pool.length;
      const az = Math.random() * Math.PI * 2;
      const el = (Math.random() - 0.3) * Math.PI * 0.5;
      const v = speed * (0.4 + Math.random() * 0.9);
      p.vx = Math.cos(az) * Math.cos(el) * v * spread;
      p.vy = Math.sin(el) * v + speed * upBias;
      p.vz = Math.sin(az) * Math.cos(el) * v * spread;
      p.age = 0;
      p.life = life * (0.7 + Math.random() * 0.6);
      p.sprite.position.copy(pos);
      p.sprite.scale.setScalar(size * (0.7 + Math.random() * 0.7));
      p.sprite.material.color.set(color);
      p.sprite.material.opacity = 1;
      p.sprite.visible = true;
      p.active = true;
    }
  }

  update(dt) {
    for (const p of this.pool) {
      if (!p.active) continue;
      p.age += dt;
      if (p.age >= p.life) { p.active = false; p.sprite.visible = false; continue; }
      p.vy += this.gravity * dt;
      p.sprite.position.x += p.vx * dt;
      p.sprite.position.y += p.vy * dt;
      p.sprite.position.z += p.vz * dt;
      p.sprite.material.opacity = Math.max(0, 1 - p.age / p.life);
    }
  }
}
