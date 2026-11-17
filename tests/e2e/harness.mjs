/**
 * End-to-end harness: boots the real server, drives the real game pages in
 * headless Chromium, and plays the part of N phones by speaking the relay's
 * socket protocol (the same messages public/controller.html sends).
 *
 *   const srv = await startServer();
 *   const browser = await launchBrowser();
 *   const page = await openGame(browser, srv, 'fruit-ninja');
 *   const p1 = await Phone.join(browser, srv, await roomOf(page));
 *   ...
 *   await srv.stop(); await browser.close();
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const SHOTS_DIR = process.env.SHOTS_DIR
  || fs.mkdtempSync(path.join(os.tmpdir(), 'senwii-e2e-'));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

export async function startServer() {
  const port = await freePort();
  const proc = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, HTTP: '1', PORT: String(port), NO_OPEN: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`${base}/api/session`)).ok) break; } catch { /* not up yet */ }
    await sleep(100);
    if (i === 99) throw new Error(`server did not start:\n${log}`);
  }
  return { base, port, log: () => log, stop: () => new Promise((r) => { proc.once('exit', r); proc.kill(); }) };
}

export function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
  });
}

/** Open a game page and wait until it has registered with the relay. Errors are collected on page.errors. */
export async function openGame(browser, srv, slug, { query = '', viewport = { width: 1280, height: 720 } } = {}) {
  const ctx = await browser.newContext({ viewport, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e)));
  // Missing optional assets (audio overrides) and offline web fonts are not game errors.
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) page.errors.push(m.text());
  });
  // 'load' would wait on Google Fonts, which a sandboxed/offline run can't reach.
  await page.goto(`${srv.base}/games/${slug}/${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__senwii && window.__senwii.link && window.__senwii.link.room, null, { timeout: 30000 });
  return page;
}

export const roomOf = (page) => page.evaluate(() => window.__senwii.link.room);

export async function shot(page, name) {
  const file = path.join(SHOTS_DIR, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

/** A simulated phone. Lives in its own page so it has its own socket. */
export class Phone {
  static async join(browser, srv, room) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${srv.base}/api/session`);
    await page.addScriptTag({ url: `${srv.base}/socket.io/socket.io.js` });
    const slot = await page.evaluate((code) => new Promise((resolve, reject) => {
      const socket = io({ transports: ['websocket'] });
      window.__phone = { socket, slot: null, feedback: [], t0: performance.now() };
      socket.on('connect', () => socket.emit('register', 'controller', { room: code }));
      socket.on('slot', ({ slot: s }) => { window.__phone.slot = s; resolve(s); });
      socket.on('feedback', (f) => window.__phone.feedback.push(f));
      socket.on('room-denied', () => reject(new Error('room denied')));
      socket.on('slot-denied', () => resolve(-1));
      setTimeout(() => reject(new Error('phone join timed out')), 8000);
    }), room);
    const phone = new Phone(page, slot);
    return phone;
  }

  constructor(page, slot) { this.page = page; this.slot = slot; }

  /** One orientation packet, as the controller page would send it. */
  sendOrientation({ alpha = 0, beta = 0, gamma = 0 } = {}) {
    return this.page.evaluate((o) => {
      window.__phone.socket.emit('orientation', { ...o, t: performance.now() - window.__phone.t0 });
    }, { alpha, beta, gamma });
  }

  command(cmd) { return this.page.evaluate((c) => window.__phone.socket.emit('command', c), cmd); }
  press(button = 'A') { return this.command({ type: 'button', button, pressed: true }); }
  release(button = 'A') { return this.command({ type: 'button-up', button }); }
  recentre() { return this.command({ type: 'recentre' }); }

  /**
   * Stream `fn(t_seconds) → {alpha,beta,gamma}` at ~60 Hz inside the phone page
   * until stop() — runs in the page so timing isn't at the mercy of the
   * test's own event loop. `fn` is a string of JS source (it's serialised).
   */
  startStream(fnSource) {
    return this.page.evaluate((src) => {
      const fn = new Function('t', `return (${src})(t);`);
      const p = window.__phone;
      p.streamStart = performance.now();
      clearInterval(p.streamTimer);
      p.streamTimer = setInterval(() => {
        const t = (performance.now() - p.streamStart) / 1000;
        p.socket.emit('orientation', { ...fn(t), t: performance.now() - p.t0 });
      }, 16);
    }, fnSource);
  }
  stopStream() { return this.page.evaluate(() => clearInterval(window.__phone.streamTimer)); }

  feedback() { return this.page.evaluate(() => window.__phone.feedback.slice()); }
  disconnect() { return this.page.evaluate(() => window.__phone.socket.disconnect()); }
  close() { return this.page.context().close(); }
}

/** Tiny assertion/reporting layer so e2e scripts read like specs and exit non-zero on failure. */
export function suite(name) {
  const results = [];
  let current = '';
  return {
    async test(title, fn) {
      current = title;
      const t0 = Date.now();
      try {
        await fn();
        results.push({ title, ok: true });
        console.log(`  ✔ ${title} (${Date.now() - t0}ms)`);
      } catch (err) {
        results.push({ title, ok: false, err });
        console.log(`  ✘ ${title}\n      ${String(err && err.stack || err).split('\n').slice(0, 6).join('\n      ')}`);
      }
    },
    ok(cond, msg) { if (!cond) throw new Error(`assertion failed: ${msg || current}`); },
    eq(a, b, msg) {
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        throw new Error(`${msg || current}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
      }
    },
    async waitFor(page, fn, arg, timeout = 15000) {
      await page.waitForFunction(fn, arg, { timeout });
    },
    finish() {
      const failed = results.filter((r) => !r.ok).length;
      console.log(`\n${name}: ${results.length - failed}/${results.length} passed · screenshots in ${SHOTS_DIR}`);
      process.exitCode = failed ? 1 : 0;
      return failed === 0;
    },
  };
}
