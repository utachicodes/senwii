import test from 'node:test';
import assert from 'node:assert/strict';
import { splitLayout, toPixels, toViewport, cellAspect, MAX_SPLIT } from './splitscreen.js';

const area = (cells) => cells.reduce((a, c) => a + c.w * c.h, 0);
const overlap = (a, b) => a.x < b.x + b.w - 1e-9 && b.x < a.x + a.w - 1e-9
  && a.y < b.y + b.h - 1e-9 && b.y < a.y + a.h - 1e-9;

test('one player gets the whole screen in either mode', () => {
  for (const mode of ['cols', 'rows']) {
    const l = splitLayout(1, mode);
    assert.deepEqual(l.cells, [{ x: 0, y: 0, w: 1, h: 1 }]);
    assert.equal(l.spare, null);
  }
});

test('cols: 2 side by side, 3 side by side, 4 a grid', () => {
  assert.deepEqual(splitLayout(2, 'cols').cells.map((c) => [c.x, c.y, c.w, c.h]),
    [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]]);
  assert.equal(splitLayout(3, 'cols').cells.length, 3);
  assert.ok(splitLayout(3, 'cols').cells.every((c) => c.h === 1));
  assert.equal(splitLayout(4, 'cols').rows, 2);
});

test('rows: 2 stacked, 3 and 4 a 2x2 grid with a spare cell for three', () => {
  assert.deepEqual(splitLayout(2, 'rows').cells.map((c) => [c.x, c.y, c.w, c.h]),
    [[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]]);
  const three = splitLayout(3, 'rows');
  assert.equal(three.cells.length, 3);
  assert.deepEqual(three.spare, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  assert.equal(splitLayout(4, 'rows').spare, null);
});

test('cells never overlap and always tile the screen', () => {
  for (const mode of ['cols', 'rows']) {
    for (let n = 1; n <= MAX_SPLIT; n += 1) {
      const { cells, spare } = splitLayout(n, mode);
      assert.equal(cells.length, n);
      for (let i = 0; i < cells.length; i += 1) {
        for (let j = i + 1; j < cells.length; j += 1) assert.ok(!overlap(cells[i], cells[j]), `${mode}${n}`);
      }
      assert.ok(Math.abs(area(cells) + (spare ? spare.w * spare.h : 0) - 1) < 1e-9, `${mode}${n} tiles`);
    }
  }
});

test('out-of-range counts clamp', () => {
  assert.equal(splitLayout(0).cells.length, 1);
  assert.equal(splitLayout(9).cells.length, 4);
  assert.equal(splitLayout(NaN).cells.length, 1);
});

test('pixel rects tile exactly even when the size is odd', () => {
  const { cells } = splitLayout(3, 'cols');
  const px = cells.map((c) => toPixels(c, 1001, 599));
  assert.equal(px[0].x, 0);
  assert.equal(px[0].x + px[0].w, px[1].x);
  assert.equal(px[1].x + px[1].w, px[2].x);
  assert.equal(px[2].x + px[2].w, 1001);
});

test('viewport flips y for WebGL', () => {
  const [top, bottom] = splitLayout(2, 'rows').cells;
  assert.deepEqual(toViewport(top, 800, 600), { x: 0, y: 300, w: 800, h: 300 });
  assert.deepEqual(toViewport(bottom, 800, 600), { x: 0, y: 0, w: 800, h: 300 });
});

test('cell aspect follows the cell, not the window', () => {
  const [left] = splitLayout(2, 'cols').cells;
  assert.ok(Math.abs(cellAspect(left, 1600, 900) - 800 / 900) < 1e-9);
});
