/**
 * Webcam motion + (optional) face detection for Dance Party. On-device only.
 *
 * Frames are downscaled to a tiny luminance buffer and differenced against the
 * previous frame: energy in spatial zones (left / right / upper / center) maps
 * to body moves. Face detection uses the FaceDetector API when available and
 * falls back to treating strong upper-zone motion as a "face/head" move, so the
 * game stays playable without the experimental API.
 *
 * Nothing leaves the device; the video element is local and never uploaded.
 */

const W = 80;
const H = 60;

function luminance(data, i) {
  // i = pixel index * 4 (RGBA)
  return data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
}

export class Vision {
  constructor({ onMove = () => {}, onStatus = () => {} } = {}) {
    this.onMove = onMove;
    this.onStatus = onStatus;
    this.stream = null;
    this.video = null;
    this.canvas = null;
    this.ctx = null;
    this.prev = null;
    this.running = false;
    this.raf = 0;
    this.faceDetector = null;
    this.faceOk = false;
    this.lastFaceAt = 0;
    this.lastFaceBox = null;
    this.cool = { 'body-left': 0, 'body-right': 0, 'body-up': 0, face: 0 };
    this.enabled = false;
  }

  async start(videoEl) {
    this.video = videoEl;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.onStatus({ camera: 'unavailable', face: 'unavailable' });
      return false;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 } },
        audio: false,
      });
    } catch (err) {
      this.onStatus({ camera: 'denied', face: 'unavailable', error: err && err.message });
      return false;
    }
    this.video.srcObject = this.stream;
    try { await this.video.play(); } catch { /* autoplay policies vary */ }

    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.prev = null;

    // FaceDetector (Chrome origin trial / experimental). Guarded heavily.
    this.faceDetector = null;
    this.faceOk = false;
    if (typeof window !== 'undefined' && 'FaceDetector' in window) {
      try {
        this.faceDetector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
        this.faceOk = true;
      } catch {
        this.faceDetector = null;
        this.faceOk = false;
      }
    }

    this.running = true;
    this.enabled = true;
    this.onStatus({ camera: 'on', face: this.faceOk ? 'on' : 'motion-fallback' });
    this.tick();
    return true;
  }

  stop() {
    this.running = false;
    this.enabled = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
    }
    this.stream = null;
    this.prev = null;
    if (this.video) this.video.srcObject = null;
  }

  tick() {
    if (!this.running) return;
    this.raf = requestAnimationFrame(() => this.tick());
    const v = this.video;
    if (!v || v.readyState < 2) return;
    try {
      this.ctx.drawImage(v, 0, 0, W, H);
    } catch {
      return;
    }
    let frame;
    try {
      frame = this.ctx.getImageData(0, 0, W, H);
    } catch {
      return;
    }
    const now = performance.now();
    this.processFrame(frame.data, now);
  }

  processFrame(data, now) {
    if (!this.prev) {
      this.prev = new Uint8ClampedArray(data.length / 4);
      for (let p = 0, i = 0; i < data.length; i += 4, p += 1) this.prev[p] = luminance(data, i);
      return;
    }
    // Accumulate motion energy per zone. Mirror-aware: the user sees
    // themselves mirrored, so "step left" on screen means moving to camera
    // right in the raw frame — but it's more intuitive to map screen-left
    // motion to BODY_LEFT. We compute in frame space then interpret: the
    // video element is CSS-mirrored, so the viewer's left = frame right.
    let left = 0, right = 0, up = 0, center = 0, total = 0;
    const thirdW = W / 3;
    const upperH = H * 0.45;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const p = y * W + x;
        const lum = luminance(data, p * 4);
        const d = Math.abs(lum - this.prev[p]);
        this.prev[p] = lum;
        if (d < 18) continue; // noise floor
        const e = d;
        total += e;
        // frame-left zone = viewer's right (because mirrored preview)
        if (x < thirdW) right += e; else if (x >= W - thirdW) left += e; else center += e;
        if (y < upperH) up += e;
      }
    }
    const area = W * H;
    // Thresholds tuned for "a deliberate move" at ~0.5-1.5m from a laptop cam.
    const sideThresh = area * 2.6;
    const upThresh = area * 3.2;
    const centerThresh = area * 2.0;

    if (left > sideThresh && left > right * 1.25) this.fire('body-left', now, 320);
    else if (right > sideThresh && right > left * 1.25) this.fire('body-right', now, 320);

    if (up > upThresh && up > total * 0.38) this.fire('body-up', now, 420);

    // Face/head move fallback when FaceDetector isn't driving it: a sharp
    // burst in the upper-center region reads as a head bob/nod/turn.
    if (!this.faceOk) {
      const headZone = (up * 0.6 + center * 0.4);
      if (headZone > area * 2.8) this.fire('face', now, 500);
    } else if (now - this.lastFaceAt > 700) {
      // Poll FaceDetector opportunistically (not every frame — it's async).
      this.lastFaceAt = now;
      this.detectFace(now);
    }
  }

  async detectFace(now) {
    if (!this.faceDetector || !this.running) return;
    try {
      const faces = await this.faceDetector.detect(this.canvas);
      if (!faces || !faces.length) { this.lastFaceBox = null; return; }
      const b = faces[0].boundingBox;
      if (this.lastFaceBox) {
        // A noticeable shift in the face box = a head move / expression beat.
        const dx = Math.abs((b.x + b.width / 2) - (this.lastFaceBox.x + this.lastFaceBox.width / 2));
        const dy = Math.abs((b.y + b.height / 2) - (this.lastFaceBox.y + this.lastFaceBox.height / 2));
        const dw = Math.abs(b.width - this.lastFaceBox.width);
        const move = dx + dy + dw * 0.5;
        if (move > 2.2) this.fire('face', now, 450);
      }
      this.lastFaceBox = b;
    } catch {
      // Some implementations throw when the source isn't ready; ignore.
    }
  }

  fire(moveId, now, cooldownMs) {
    if (now < (this.cool[moveId] || 0)) return;
    this.cool[moveId] = now + cooldownMs;
    this.onMove(moveId, now);
  }
}
