/**
 * Split-screen layout — one helper shared by every local-multiplayer game.
 *
 * Pure geometry, no DOM and no renderer, so it's testable in Node. A rect is
 * `{ x, y, w, h }` in 0..1 of the window, origin top-left (CSS convention).
 *
 *   mode 'cols' — players sit side by side. Suits games whose action is
 *                 vertical (Fruit Ninja): 1 → full, 2 → two columns,
 *                 3 → three columns, 4 → a 2×2 grid.
 *   mode 'rows' — players stack. Suits games whose action is horizontal
 *                 (racing): 1 → full, 2 → top/bottom, 3 and 4 → a 2×2 grid
 *                 (a 3-player grid leaves one spare cell for shared HUD).
 */
export const MAX_SPLIT = 4;

const grid = (cols, rows, count) => {
  const cells = [];
  for (let i = 0; i < count; i += 1) {
    cells.push({ x: (i % cols) / cols, y: Math.floor(i / cols) / rows, w: 1 / cols, h: 1 / rows });
  }
  // A grid with more cells than players leaves the trailing cell(s) spare.
  const spare = [];
  for (let i = count; i < cols * rows; i += 1) {
    spare.push({ x: (i % cols) / cols, y: Math.floor(i / cols) / rows, w: 1 / cols, h: 1 / rows });
  }
  return { cells, spare: spare[0] || null, cols, rows };
};

export function splitLayout(count, mode = 'cols') {
  const n = Math.max(1, Math.min(MAX_SPLIT, Math.floor(count) || 1));
  if (n === 1) return grid(1, 1, 1);
  if (n === 4) return grid(2, 2, 4);
  if (mode === 'rows') return n === 2 ? grid(1, 2, 2) : grid(2, 2, 3);
  return grid(n, 1, n);
}

/** A rect as pixel coordinates, top-left origin, rounded so cells tile exactly. */
export function toPixels(rect, width, height) {
  const x0 = Math.round(rect.x * width);
  const y0 = Math.round(rect.y * height);
  const x1 = Math.round((rect.x + rect.w) * width);
  const y1 = Math.round((rect.y + rect.h) * height);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The same rect as a WebGL/three.js viewport (origin bottom-left). */
export function toViewport(rect, width, height) {
  const p = toPixels(rect, width, height);
  return { x: p.x, y: height - p.y - p.h, w: p.w, h: p.h };
}

/** Aspect ratio a cell renders at, for the camera that fills it. */
export const cellAspect = (rect, width, height) => {
  const p = toPixels(rect, width, height);
  return Math.max(1, p.w) / Math.max(1, p.h);
};
