import { startServer, launchBrowser, openGame, roomOf, Phone, shot, sleep, suite } from './harness.mjs';

const t = suite('fruit-ninja e2e');
const srv = await startServer();
const browser = await launchBrowser();

// A fast horizontal slash sweeping across the phone's aim, as a stream.
const SLASH = `(t) => ({ alpha: 0, beta: 90, gamma: 25 * Math.sin(t * 9) })`;
const VIEW = { width: 960, height: 540 };   // software GL is slow: keep frames small
const open = (page, ...a) => openGame(browser, srv, 'fruit-ninja', { viewport: VIEW, ...(a[0] || {}) });

// Slash across a cell with the real mouse (drives slot 0 whenever its phone isn't streaming).
async function mouseSlash(page, cell, until) {
  for (let i = 0; i < 80; i += 1) {
    if (await page.evaluate(until)) return true;
    const y = cell[1] + cell[3] * (0.25 + 0.5 * ((i * 0.37) % 1));
    await page.mouse.move(cell[0] + 6, y);
    for (let k = 1; k <= 6; k += 1) await page.mouse.move(cell[0] + (cell[2] - 12) * (k / 6), y + (i % 2 ? 20 : -20) * (k / 6));
  }
  return page.evaluate(until);
}
const state = (page) => page.evaluate(() => {
  const m = window.__senwii.match;
  return {
    phase: m.phase, slots: m.slots,
    boards: m.slots.map((s) => ({ s, score: m.board(s).state.score, lives: m.board(s).state.lives, over: m.isOver(s) })),
    cells: [...document.querySelectorAll('.cell')].map((c) => { const r = c.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; }),
  };
});

try {
  await t.test('solo: starts, uses real rules (3 lives), one full-screen cell', async () => {
    const page = await open(null);
    await sleep(500);
    const s = await state(page);
    t.eq(s.phase, 'playing'); t.eq(s.slots, [0]);
    t.eq(s.cells, [[0, 0, 960, 540]]);
    t.eq(s.boards[0].lives, 3);
    t.ok(page.errors.length === 0, `page errors: ${page.errors}`);
    await shot(page, 'fn-solo');
    await page.context().close();
  });

  await t.test('solo: game ends when lives run out and results show; A restarts', async () => {
    const page = await open(null);
    await sleep(2200);      // fruit spawns, nobody slices → misses
    await t.waitFor(page, () => window.__senwii.match.phase === 'over', null, 40000);
    t.ok(await page.locator('#overlay:not(.hide)').count() === 1, 'results overlay visible');
    t.ok((await page.locator('#panel').innerText()).includes('GAME OVER'));
    await shot(page, 'fn-solo-over');
    await sleep(1100);
    await page.keyboard.press('Space');
    await t.waitFor(page, () => window.__senwii.match.phase === 'playing');
    t.eq((await state(page)).boards[0].lives, 3);
    await page.context().close();
  });

  for (const n of [2, 3, 4]) {
    await t.test(`${n} players: split screen, independent boards`, async () => {
      const page = await open(null);
      const room = await roomOf(page);
      const phones = [];
      for (let i = 0; i < n; i += 1) phones.push(await Phone.join(browser, srv, room));
      t.eq(phones.map((p) => p.slot), [...Array(n).keys()]);
      await t.waitFor(page, (k) => window.__senwii.match.slots.length === k, n);
      await sleep(400);
      const s = await state(page);
      t.eq(s.slots, [...Array(n).keys()]);
      t.eq(s.cells.length, n);
      const area = s.cells.reduce((a, c) => a + c[2] * c[3], 0);
      t.eq(area, 960 * 540, 'cells tile the screen exactly');
      if (n === 2) t.eq(s.cells, [[0, 0, 480, 540], [480, 0, 480, 540]]);
      if (n === 4) t.eq(s.cells, [[0, 0, 480, 270], [480, 0, 480, 270], [0, 270, 480, 270], [480, 270, 480, 270]]);
      // Only P1 slashes: only P1's score moves.
      // Phone 2 starts streaming: its own pointer goes live, routed by slot.
      await phones[1].startStream(SLASH);
      await t.waitFor(page, () => window.__senwii.inputs.get(1)?.pointer.live === true, null, 20000);
      t.ok(await page.evaluate(() => !window.__senwii.inputs.get(0).pointer.live), 'P1 pointer not driven by P2');
      await phones[1].stopStream();
      t.ok(await mouseSlash(page, s.cells[0], () => window.__senwii.match.board(0).state.score > 0), 'P1 slashed a fruit');
      const after = await state(page);
      t.ok(after.boards[0].score > 0, 'P1 scored');
      t.ok(after.boards.slice(1).every((b) => b.score === 0), 'others untouched');
      await shot(page, `fn-${n}p`);
      t.ok(page.errors.length === 0, `page errors: ${page.errors}`);
      for (const p of phones) await p.close();
      await page.context().close();
    });
  }

  await t.test('2 players: one goes out, the other plays on; match ends with a winner', async () => {
    const page = await open(null);
    const room = await roomOf(page);
    const a = await Phone.join(browser, srv, room);
    const b = await Phone.join(browser, srv, room);
    await t.waitFor(page, () => window.__senwii.match.slots.length === 2);
    await page.evaluate(() => {
      const m = window.__senwii.match; window.__snaps = [];
      setInterval(() => window.__snaps.push({ over: m.slots.filter((x) => m.isOver(x)).length, phase: m.phase }), 50);
    });
    await t.waitFor(page, () => window.__senwii.match.phase === 'over', null, 90000);
    const snaps = await page.evaluate(() => window.__snaps);
    t.ok(snaps.some((x) => x.over === 1 && x.phase === 'playing'), 'one board out while the match was still running');
    const txt = await page.locator('#panel').innerText();
    t.ok(/WINS|DRAW/.test(txt), `winner shown: ${txt}`);
    await shot(page, 'fn-2p-results');
    // A from either phone restarts; both seated again.
    await sleep(1100);
    await a.press('A');
    await t.waitFor(page, () => window.__senwii.match.phase === 'playing');
    t.eq((await state(page)).slots, [0, 1]);
    await a.close(); await b.close(); await page.context().close();
  });

  await t.test('a phone joining mid-round gets a board; leaving forfeits it', async () => {
    const page = await open(null);
    const room = await roomOf(page);
    const a = await Phone.join(browser, srv, room);
    await t.waitFor(page, () => window.__senwii.match.slots.length === 1 && window.__senwii.link.slots[0]?.occupied);
    const b = await Phone.join(browser, srv, room);
    await t.waitFor(page, () => window.__senwii.match.slots.length === 2);
    t.eq((await state(page)).cells.length, 2);
    await b.disconnect();
    await t.waitFor(page, () => window.__senwii.match.isOver(1));
    t.eq((await state(page)).phase, 'playing');
    await a.close(); await b.close(); await page.context().close();
  });

  await t.test('practice mode (?practice) never ends', async () => {
    const page = await open(null, { query: '?practice' });
    await sleep(9000);
    const s = await state(page);
    t.eq(s.phase, 'playing');
    await page.context().close();
  });
} finally {
  await browser.close();
  await srv.stop();
}
if (!t.finish()) console.log('--- server log (tail) ---\n' + srv.log().split('\n').slice(-15).join('\n'));
