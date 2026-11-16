/**
 * Webcam motion + (optional) face detection for Dance Party. On-device only.
 *
 * Frames are downscaled to a tiny luminance buffer and differenced against the
 * previous frame: energy in spatial zones (left / right / upper / center) maps
 * to body moves. Face/head moves are timed from motion (a burst in the upper zone),
 * never from the detector: FaceDetector is async and slow, so polling it can't
 * place a move inside a ±220ms window. When the API works it only *confirms* a
 * face is in frame; when it's missing or broken, motion alone drives it.
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
    this.loop = null;           // { kind: 'raf' | 'vfc', id }
    this.faceDetector = null;
    this.faceOk = false;
    this.faceBusy = false;
    this.lastFacePoll = 0;
    this.lastFaceSeen = 0;
    this.cool = { 'body-left': 0, 'body-right': 0, 'body-up': 0, face: 0 };
    this.enabled = false;
    this.pending = null;        // in-flight start() promise
    this.gen = 0;               // bumps on stop(); stale starts discard their stream
  }

  /**
   * Start the camera. Idempotent: while a start is in flight every caller gets
   * the same promise, and a running camera resolves true without a second
   * getUserMedia (a second call used to leak the first stream + tick loop).
   */
  start(videoEl) {
    if (this.enabled && this.stream) return Promise.resolve(true);
    if (this.pending) return this.pending;
    this.pending = this.startInner(videoEl).finally(() => { this.pending = null; });
    return this.pending;
  }

  async startInner(videoEl) {
    this.video = videoEl;
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      this.onStatus({ camera: 'insecure', face: 'unavailable' });
      return false;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.onStatus({ camera: 'unavailable', face: 'unavailable' });
      return false;
    }
    const gen = this.gen;
    this.onStatus({ camera: 'waiting', face: 'unavailable' });
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 } },
        audio: false,
      });
    } catch (err) {
      const name = err && err.name;
      const camera = name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError' ? 'none'
        : name === 'NotReadableError' || name === 'TrackStartError' ? 'busy'
        : name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError' ? 'denied'
        : 'error';
      this.onStatus({ camera, face: 'unavailable', error: err && err.message });
      return false;
    }
    if (gen !== this.gen) {
      // stop() ran while the permission prompt was up — don't resurrect.
      for (const t of stream.getTracks()) t.stop();
      return false;
    }
    this.releaseStream();
    this.stream = stream;
    this.video.srcObject = stream;
    try { await this.video.play(); } catch { /* autoplay policies vary */ }

    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = W;
      this.canvas.height = H;
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }
    this.prev = null;

    // FaceDetector (experimental). Only trusted once a detect() succeeds.
    this.faceDetector = null;
    this.faceOk = false;
    this.lastFaceSeen = 0;
    if (typeof window !== 'undefined' && 'FaceDetector' in window) {
      try {
        this.faceDetector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
      } catch {
        this.faceDetector = null;
      }
    }

    this.running = true;
    this.enabled = true;
    this.emitStatus();
    this.schedule();
    return true;
  }

  emitStatus() {
    this.onStatus({ camera: 'on', face: this.faceOk ? 'on' : 'motion-fallback' });
  }

  releaseStream() {
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
  }

  cancelLoop() {
    if (!this.loop) return;
    if (this.loop.kind === 'vfc' && this.video && this.video.cancelVideoFrameCallback) {
      this.video.cancelVideoFrameCallback(this.loop.id);
    } else if (this.loop.kind === 'raf') {
      cancelAnimationFrame(this.loop.id);
    }
    this.loop = null;
  }

  stop() {
    this.gen += 1;
    this.running = false;
    this.enabled = false;
    this.cancelLoop();
    this.releaseStream();
    this.prev = null;
    if (this.video) this.video.srcObject = null;
    this.onStatus({ camera: 'off', face: 'unavailable' });
  }

  /** One processing loop only; per *new video frame* when the browser can say. */
  schedule() {
    this.cancelLoop();
    if (!this.running) return;
    const v = this.video;
    if (v && typeof v.requestVideoFrameCallback === 'function') {
      this.loop = {
        kind: 'vfc',
        id: v.requestVideoFrameCallback((_t, meta) => {
          const now = performance.now();
          const cap = meta && meta.captureTime;
          // captureTime is when the sensor grabbed it — closer to the move.
          this.tick(cap > 0 && Math.abs(now - cap) < 300 ? cap : now);
        }),
      };
    } else {
      this.loop = { kind: 'raf', id: requestAnimationFrame(() => this.tick(performance.now())) };
    }
  }

  tick(now) {
    if (!this.running) return;
    this.schedule();
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
    this.processFrame(frame.data, now);
  }

  processFrame(data, now) {
    if (!this.prev) {
      this.prev = new Uint8ClampedArray(data.length / 4);
      for (let p = 0, i = 0; i < data.length; i += 4, p += 1) this.prev[p] = luminance(data, i);
      return;
    }
    // Accumulate motion energy per zone. The video element is CSS-mirrored,
    // so the viewer's left = frame right; map screen-left motion to BODY_LEFT.
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

    if (left > sideThresh && left > right * 1.25) this.fire('body-left', now, 320);
    else if (right > sideThresh && right > left * 1.25) this.fire('body-right', now, 320);

    if (up > upThresh && up > total * 0.38) this.fire('body-up', now, 420);

    // Face/head move: timed from this frame's motion burst. A working
    // FaceDetector only gates it on "a face was in frame recently".
    const headZone = (up * 0.6 + center * 0.4);
    // Only gate once it has proven it can see this player at all, so a
    // detector that never finds faces (lighting, angle) can't mute the lane.
    const facePresent = !this.faceOk || !this.lastFaceSeen || now - this.lastFaceSeen < 2000;
    if (headZone > area * 2.8 && facePresent) this.fire('face', now, 500);

    if (this.faceDetector && !this.faceBusy && now - this.lastFacePoll > 400) {
      this.lastFacePoll = now;
      this.detectFace();
    }
  }

  async detectFace() {
    const det = this.faceDetector;
    if (!det || !this.running) return;
    this.faceBusy = true;
    try {
      const faces = await det.detect(this.video);   // full-res: 80×60 is too small for faces
      if (det !== this.faceDetector) return;
      if (!this.faceOk) { this.faceOk = true; this.emitStatus(); }
      if (faces && faces.length) this.lastFaceSeen = performance.now();
    } catch {
      // Exposed behind a flag without a backend, or otherwise broken: stop
      // trusting it so motion alone drives face moves again.
      if (det === this.faceDetector) {
        this.faceDetector = null;
        const was = this.faceOk;
        this.faceOk = false;
        if (was && this.running) this.emitStatus();
      }
    } finally {
      this.faceBusy = false;
    }
  }

  fire(moveId, now, cooldownMs) {
    if (now < (this.cool[moveId] || 0)) return;
    this.cool[moveId] = now + cooldownMs;
    this.onMove(moveId, now);
  }
}
