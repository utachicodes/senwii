/**
 * Turbo Racing, end to end: the real server, the real game page in headless
 * Chromium, and 1–4 simulated phones talking the relay protocol.
 *
 *   node tests/e2e/racing.mjs        (SHOTS_DIR=… to choose where screenshots go)
 */
import { startServer, launchBrowser, openGame, roomOf, Phone, shot, suite, sleep } from './harness.mjs';
import { splitLayout, toViewport, toPixels } from '../../core/splitscreen.js';

const T = suite('racing e2e');
const W = 1280;
const H = 720;

/** A phone held like a wheel, rolled `bank` degrees (+ = right). Tray pose, see core/tilt.js. */
const stream = (phone, bank = 0) => phone.startStream(`() => ({ alpha: 270, beta: ${-bank}, gamma: 8 })`);

// Everything a scenario opens is closed afterwards, pass or fail, so a failed
// test doesn't leave SwiftShader pages burning CPU under the next one.
const opened = [];
const run = async (title, fn) => {
  await T.test(title, fn);
  while (opened.length) await opened.pop().close().catch(() => {});
};

async function lobby(browser, srv, n, { query = '' } = {}) {
  const page = await openGame(browser, srv, 'racing', { query, viewport: { width: W, height: H } });
  const room = await roomOf(page);
  const phones = [];
  for (let i = 0; i < n; i += 1) {
    const p = await Phone.join(browser, srv, room);
    if (p.slot !== i) throw new Error(`phone ${i} got slot ${p.slot}`);
    await stream(p, 0);
    phones.push(p);
  }
  opened.push(page.context(), ...phones.map((p) => p.page.context()));
  await page.waitForFunction((c) => window.__senwii.link.slots.filter((s) => s.occupied).length === c, n, { timeout: 10000 });
  // Count every setViewport call, so the test can see what was actually drawn.
  await page.evaluate(() => {
    const r = window.__senwii.renderer;
    const orig = r.setViewport.bind(r);
    window.__vps = [];
    r.setViewport = (...a) => { window.__vps.push(a.slice(0, 4)); if (window.__vps.length > 64) window.__vps.shift(); return orig(...a); };
  });
  return { page, phones };
}

async function begin(page, starter) {
  if (starter) { await starter.press('A'); await starter.release('A'); } else await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__senwii.race && window.__senwii.race.state === 'racing', null, { timeout: 20000 });
}

async function teardown(page, phones) {
  for (const p of phones) await p.close().catch(() => {});
  await page.context().close();
}

const carState = (page) => page.evaluate(() => window.__senwii.cars.map((c) => ({
  steer: c.steer, heading: c.heading, speed: c.speed, drifting: c.drifting, x: c.pos.x, z: c.pos.z,
  out: c.out, finished: c.finishedMs !== null, rank: c.rank, brake: c.brakeHeld,
})));

/** Run the race to its end inside the page (synchronously, faster than real time) with a pure-pursuit autopilot. */
const autopilot = (page) => page.evaluate(async () => {
  const L = await import('/games/racing/logic.js');
  const r = window.__senwii.race;
  const TAU = Math.PI * 2;
  let t = performance.now() + 50;
  let steps = 0;
  while (r.state !== 'finished' && steps < 60 * 500) {
    r.cars.forEach((c, i) => {
      if (c.out) return;
      const c2 = L.trackCenterAt(r.track, L.tAtS(r.track, c.progressM + 28));
      let err = Math.atan2(-(c2.x - c.pos.x), -(c2.z - c.pos.z)) - c.heading;
      while (err > Math.PI) err -= TAU;
      while (err < -Math.PI) err += TAU;
      r.setSteer(Math.max(-30, Math.min(30, err * 250)), i);
    });
    t += 1000 / 60;
    r.update(t, 1 / 60);
    steps += 1;
  }
  return { state: r.state, steps };
});

async function main() {
  const srv = await startServer();
  const browser = await launchBrowser();
  try {
    // ── Layout and HUD, for every player count ───────────────────────────────
    for (const n of [1, 2, 3, 4]) {
      await run(`${n}P: split-screen geometry, cameras and HUD`, async () => {
        const { page, phones } = await lobby(browser, srv, n);
        // The menu shows who's connected.
        const roster = await page.locator('#roster').innerText();
        T.ok(n === 1 ? /P1/.test(roster) : new RegExp(`${n} players`).test(roster), `roster says ${n} players: "${roster}"`);
        await shot(page, `racing-${n}p-menu`);
        await begin(page, phones[0]);
        await sleep(600);

        const want = splitLayout(n, 'rows');
        T.eq(await page.evaluate(() => window.__senwii.cars.length), n, 'one car per phone');
        T.eq(await page.evaluate(() => window.__senwii.participants()), [...Array(n).keys()], 'seats map to slots');
        T.eq(await page.locator('.cell').count(), n, 'one HUD cell per player');
        T.eq(await page.locator('#hud.split').count(), n > 1 ? 1 : 0, 'split class only when split');

        // DOM cells sit exactly on the layout rects.
        const boxes = await page.locator('.cell').evaluateAll((els) => els.map((e) => {
          const b = e.getBoundingClientRect();
          return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) };
        }));
        want.cells.forEach((c, i) => T.eq(boxes[i], toPixels(c, W, H), `cell ${i} DOM rect`));

        // …and so do the WebGL viewports that were actually rendered.
        const vps = await page.evaluate(() => window.__vps.slice(-6));
        const frame = vps.slice(-(n + 1));
        T.eq(frame[0], [0, 0, W, H], 'frame starts with a full-screen clear');
        want.cells.forEach((c, i) => {
          const vp = toViewport(c, W, H);
          T.eq(frame[i + 1], [vp.x, vp.y, vp.w, vp.h], `cell ${i} viewport`);
        });
        // Each camera is shaped for its own cell.
        const aspects = await page.evaluate(() => window.__senwii.cameras.map((c) => c.aspect));
        want.cells.forEach((c, i) => {
          const p = toPixels(c, W, H);
          T.ok(Math.abs(aspects[i] - p.w / p.h) < 0.01, `camera ${i} aspect ${aspects[i]} vs ${p.w / p.h}`);
        });
        // Cameras follow their own kart: each sits behind its own car and apart from the others.
        const cams = await page.evaluate(() => window.__senwii.cameras.slice(0, window.__senwii.cars.length)
          .map((c, i) => ({ cx: c.position.x, cz: c.position.z, kx: window.__senwii.cars[i].pos.x, kz: -window.__senwii.cars[i].pos.z })));
        cams.forEach((c, i) => T.ok(Math.hypot(c.cx - c.kx, c.cz - c.kz) < 14, `camera ${i} stays with its kart`));

        // Tags, minimap and standings land where the split leaves room.
        const tags = await page.locator('.tag').evaluateAll((els) => els.map((e) => [e.textContent, getComputedStyle(e).display]));
        if (n > 1) tags.forEach(([txt, disp], i) => { T.eq(txt, `P${i + 1}`, 'tag text'); T.ok(disp !== 'none', 'tag visible'); });
        else T.eq(tags[0][1], 'none', 'no player tag when alone');
        const mm = await page.locator('#minimap').boundingBox();
        const mx = mm.x + mm.width / 2;
        const my = mm.y + mm.height / 2;
        if (n === 2 || n === 4) {
          T.ok(Math.abs(mx - W / 2) < 3 && Math.abs(my - H / 2) < 3, `minimap centred (${mx},${my})`);
          T.eq(await page.locator('#standings').isVisible(), false, 'standings hidden');
        } else if (n === 3) {
          const sp = toPixels(want.spare, W, H);
          T.ok(mx > sp.x && mx < sp.x + sp.w && my > sp.y && my < sp.y + sp.h, 'minimap sits in the spare cell');
          const sb = await page.locator('#standings').boundingBox();
          T.ok(sb && sb.x >= sp.x && sb.x + sb.width <= sp.x + sp.w, 'standings in the spare cell');
        } else {
          T.ok(mx > W * 0.8 && my > H * 0.7, 'solo minimap stays bottom-right');
          T.eq(await page.locator('#standings').isVisible(), true, 'standings shown solo');
        }
        T.eq(await page.evaluate(() => window.__senwii.race.karts.length), 6 - n, 'CPU fills the rest of the grid');
        await sleep(2500);   // let the countdown finish so the shot shows live karts
        await shot(page, `racing-${n}p-race`);
        T.eq(page.errors, [], 'no page errors');
        await teardown(page, phones);
      });
    }

    // ── Input ownership ──────────────────────────────────────────────────────
    for (const n of [2, 3, 4]) {
      await run(`${n}P: each phone steers only its own car`, async () => {
        const { page, phones } = await lobby(browser, srv, n);
        await begin(page, phones[0]);
        // Wheel neutral is captured mid-countdown; roll P1 right and P2 left, keep the rest straight.
        const h0 = (await carState(page)).map((c) => c.heading);
        await stream(phones[0], 20);
        await stream(phones[1], -20);
        await sleep(2500);
        const cs = await carState(page);
        const turn = (i) => { let d = cs[i].heading - h0[i]; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
        T.ok(cs[0].steer > 8, `P1 steers right (${cs[0].steer.toFixed(1)})`);
        T.ok(cs[1].steer < -8, `P2 steers left (${cs[1].steer.toFixed(1)})`);
        for (let i = 2; i < n; i += 1) T.ok(Math.abs(cs[i].steer) < 3, `P${i + 1} stays straight (${cs[i].steer.toFixed(1)})`);
        T.ok(turn(0) > 0.02 && turn(1) < -0.02, `cars turned opposite ways (${turn(0).toFixed(2)}, ${turn(1).toFixed(2)})`);
        // Swap: P1 straight, P2 now right. Only P2's car follows.
        await stream(phones[0], 0);
        await stream(phones[1], 20);
        await sleep(1200);
        const c2 = await carState(page);
        T.ok(Math.abs(c2[0].steer) < 4, `P1 back to straight (${c2[0].steer.toFixed(1)})`);
        T.ok(c2[1].steer > 8, `P2 now right (${c2[1].steer.toFixed(1)})`);
        T.eq(page.errors, [], 'no page errors');
        await teardown(page, phones);
      });
    }

    await run('1P: keyboard-only race with no phone (Space, arrow keys)', async () => {
      const { page } = await lobby(browser, srv, 0);
      await begin(page, null);
      T.eq(await page.evaluate(() => window.__senwii.cars.length), 1, 'one car');
      await page.keyboard.down('ArrowRight');
      await sleep(900);
      const cs = await carState(page);
      await page.keyboard.up('ArrowRight');
      T.ok(cs[0].steer > 10, `arrow right steers (${cs[0].steer})`);
      T.eq(page.errors, [], 'no page errors');
      await teardown(page, []);
    });

    await run('2P: A drifts only the pressing phone\'s car, brake is per phone', async () => {
      const { page, phones } = await lobby(browser, srv, 2);
      await begin(page, phones[0]);
      await stream(phones[0], 22);
      await stream(phones[1], 22);
      await page.waitForFunction(() => window.__senwii.cars.every((c) => c.speed > 14), null, { timeout: 20000 });
      await phones[1].press('A');
      // Hold until the first mini-turbo tier is banked (that spark buzzes the phone).
      await page.waitForFunction(() => window.__senwii.cars[1].driftTier >= 1, null, { timeout: 30000 });
      let cs = await carState(page);
      T.eq(cs.map((c) => c.drifting), [false, true], 'only P2 drifts');
      await phones[0].press('1');
      await sleep(200);
      cs = await carState(page);
      T.eq(cs.map((c) => c.brake), [true, false], 'brake only on P1');
      await phones[0].release('1');
      await phones[1].release('A');
      await sleep(250);
      cs = await carState(page);
      T.eq(cs.map((c) => c.drifting), [false, false], 'releasing A ends the drift');
      T.eq(cs.map((c) => c.brake), [false, false], 'releasing 1 ends the brake');
      // Haptics went to the phone that earned them, not to the other one.
      const fb = await Promise.all(phones.map((p) => p.feedback()));
      T.ok(fb[1].some((f) => f.type === 'slice'), 'P2 got haptic feedback for its own spark');
      T.eq(page.errors, [], 'no page errors');
      await teardown(page, phones);
    });

    // ── A whole race ─────────────────────────────────────────────────────────
    for (const n of [1, 2, 3, 4]) {
      await run(`${n}P: race runs to the end and the results list every human`, async () => {
        const { page, phones } = await lobby(browser, srv, n);
        await begin(page, phones[0]);
        await sleep(300);
        const r = await autopilot(page);
        T.eq(r.state, 'finished', 'race finished');
        await page.waitForSelector('#overlay:not(.hide)', { timeout: 5000 });
        const info = await page.evaluate(() => ({
          places: window.__senwii.cars.map((c) => c.rank),
          finished: window.__senwii.cars.map((c) => c.finishedMs !== null),
          humans: document.querySelectorAll('.humans > div').length,
          rows: document.querySelectorAll('.results > div').length,
          text: document.getElementById('panel').innerText,
        }));
        info.fin = await page.evaluate(() => [...document.querySelectorAll('.fin')].map((e) => e.textContent));
        await page.waitForFunction(() => [...document.querySelectorAll('.fin')].every((e) => /FINISHED/.test(e.textContent)), null, { timeout: 10000 });
        T.eq(info.finished, Array(n).fill(true), 'every human crossed the line');
        T.eq(new Set(info.places).size, n, `places unique: ${info.places}`);
        T.eq(info.rows, 6, 'six racers in the standings');
        if (n > 1) {
          T.eq(info.humans, n, 'a result line per human');
          for (let i = 1; i <= n; i += 1) T.ok(info.text.includes(`P${i}`), `results mention P${i}`);
          T.ok(/wins!/.test(info.text), 'a winner is named');
          T.ok(info.fin.every((t) => /FINISHED/.test(t)), 'each cell shows FINISHED');
        } else {
          T.ok(/place/.test(info.text), 'solo results show the place');
        }
        await sleep(1100);   // past the restart guard
        await shot(page, `racing-${n}p-results`);
        // A from any phone races again, with the same field.
        await (phones[n - 1] || { press: () => page.keyboard.press('Space'), release: () => {} }).press('A');
        await page.waitForFunction(() => window.__senwii.race && window.__senwii.race.state !== 'finished', null, { timeout: 10000 });
        T.eq(await page.evaluate(() => window.__senwii.cars.length), n, 'rematch keeps every player');
        T.eq(page.errors, [], 'no page errors');
        await teardown(page, phones);
      });
    }

    // ── Phones coming and going ──────────────────────────────────────────────
    await run('3P: a phone leaving mid-race is dropped and the race still ends', async () => {
      const { page, phones } = await lobby(browser, srv, 3);
      await begin(page, phones[0]);
      await sleep(500);
      await phones[2].disconnect();
      await page.waitForFunction(() => window.__senwii.cars[2].out === true, null, { timeout: 8000 });
      T.eq(await page.evaluate(() => window.__senwii.race.state), 'racing', 'race carries on');
      await page.waitForFunction(() => /DISCONNECTED/.test(document.querySelectorAll('.cell .fin')[2].textContent), null, { timeout: 5000 });
      await shot(page, 'racing-3p-dropout');
      const t0 = Date.now();
      const r = await autopilot(page);
      T.eq(r.state, 'finished', 'race finished without the dropped driver');
      T.ok(Date.now() - t0 < 60000, 'did not wait for a grace timeout');
      const info = await page.evaluate(() => ({ text: document.getElementById('panel').innerText, humans: document.querySelectorAll('.humans > div').length }));
      T.eq(info.humans, 3, 'results still list all three seats');
      T.ok(/left/.test(info.text), 'dropped player marked as left');
      T.eq(page.errors, [], 'no page errors');
      await teardown(page, phones);
    });

    await run('2P: a phone joining mid-race waits for the next race', async () => {
      const { page, phones } = await lobby(browser, srv, 2);
      await begin(page, phones[0]);
      const late = await Phone.join(browser, srv, await roomOf(page));
      await stream(late, 0);
      await sleep(500);
      T.eq(await page.evaluate(() => window.__senwii.cars.length), 2, 'still two cars');
      const toast = await page.locator('.toast.on').first().innerText();
      T.ok(/joins next race/.test(toast), `toast: "${toast}"`);
      await autopilot(page);
      await sleep(1100);
      await phones[0].press('A');
      await page.waitForFunction(() => window.__senwii.race.state !== 'finished', null, { timeout: 10000 });
      T.eq(await page.evaluate(() => window.__senwii.cars.length), 3, 'the late phone races next time');
      await shot(page, 'racing-3p-after-join');
      T.eq(page.errors, [], 'no page errors');
      await late.close();
      await teardown(page, phones);
    });
  } finally {
    await browser.close();
    await srv.stop();
  }
  T.finish();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
