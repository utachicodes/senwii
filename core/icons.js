/**
 * Shared line-icon set — the one place UI glyphs come from.
 *
 * Emoji render differently on every OS (and as tofu on some TVs), so all UI
 * symbols are drawn here as 24×24 stroke SVGs that inherit `currentColor` and
 * scale with font-size. Logic modules keep only the icon *name* (a string), so
 * they stay DOM-free and testable in Node; rendering code calls `icon(name)`.
 *
 *   icon('trophy')            → inline <svg> string, 1em square
 *   icon('heart', 'fill')     → solid variant
 *   icon('medal', 'gold')     → tinted (gold | silver | bronze)
 */

const P = {
  trophy: '<path d="M8 21h8M12 17v4"/><path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4"/>',
  skull: '<path d="M12 3a8 8 0 0 0-5 14.2V20a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2.8A8 8 0 0 0 12 3z"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><path d="M10 21v-2M14 21v-2"/>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/>',
  burst: '<path d="M12 2l2 6 6-3-3 6 6 2-6 2 3 6-6-3-2 6-2-6-6 3 3-6-6-2 6-2-3-6 6 3z"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  house: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
  flame: '<path d="M12 22a7 7 0 0 0 7-7c0-4-3-6-4-10-2 2-3 4-3 6-1-1-2-2-2-4-2 2-5 5-5 8a7 7 0 0 0 7 7z"/>',
  pin: '<path d="M12 2.5c-.9 0-1.6.8-1.6 1.8 0 .5.2.9.5 1.3-1.1.7-1.9 2.3-1.9 4.2 0 1.6.6 2.6.6 3.8 0 .9-.4 1.4-.9 2-.6.7-1.1 1.5-1.1 2.7 0 2 1.9 3.2 4.4 3.2s4.4-1.2 4.4-3.2c0-1.2-.5-2-1.1-2.7-.5-.6-.9-1.1-.9-2 0-1.2.6-2.2.6-3.8 0-1.9-.8-3.5-1.9-4.2.3-.4.5-.8.5-1.3 0-1-.7-1.8-1.6-1.8z"/><circle cx="5" cy="19" r="2.4"/>',
  glove: '<path d="M10 8.2V6a2 2 0 1 1 4 0v3.4"/><path d="M8 21h6a3 3 0 0 0 3-3v-3.3a5.3 5.3 0 0 0-2-4.1V6.4"/><path d="M8 13.6V11a3 3 0 0 1 3-3"/><path d="M5.8 15.2A2.3 2.3 0 0 0 5 17v.2A3.8 3.8 0 0 0 8.8 21H9"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  'arrow-left': '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
  'arms-up': '<circle cx="12" cy="6" r="2"/><path d="M5 3l3 6h8l3-6"/><path d="M9 9v5l-2 7M15 9v5l2 7M9 14h6"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14a4.5 4.5 0 0 0 8 0"/><path d="M9 9.5h0M15 9.5h0" stroke-width="2.6"/>',
  phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
  vibrate: '<rect x="8" y="4" width="8" height="16" rx="1.5"/><path d="M4.5 8v8M19.5 8v8M2 10v4M22 10v4"/>',
  swing: '<path d="M4 17a9 9 0 0 1 15-9"/><path d="M19 3v5h-5"/>',
  'phone-up': '<rect x="8" y="10" width="8" height="12" rx="1.5"/><path d="M12 7V2M9.5 4.5 12 2l2.5 2.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  rainbow: '<path d="M3 18a9 9 0 0 1 18 0"/><path d="M6.5 18a5.5 5.5 0 0 1 11 0"/><path d="M10 18a2 2 0 0 1 4 0"/>',
  city: '<path d="M3 21h18"/><path d="M5 21V11h4v10M9 21V7h5v14M14 21v-8h5v8"/><path d="M18 2.5a2.5 2.5 0 1 0 3 3 3 3 0 0 1-3-3z"/>',
  sunset: '<path d="M3 18h18M6 22h12"/><path d="M7 18a5 5 0 0 1 10 0"/><path d="M12 5v4M4.9 10.9l1.4 1.4M19.1 10.9l-1.4 1.4"/>',
  dunes: '<path d="M2 21h20"/><path d="M2 19c3-4 6-6 10-6s7 2 10 6"/><path d="M7 14c1.5-3 3.5-5 6-5"/><circle cx="18" cy="6" r="2"/>',
  flag: '<path d="M5 22V3"/><path d="M5 4h14v9H5"/><path d="M9.7 4v9M14.3 4v9M5 8.5h14"/>',
  car: '<path d="M5 15l1.5-5A2 2 0 0 1 8.4 8.5h7.2a2 2 0 0 1 1.9 1.5L19 15"/><rect x="3" y="15" width="18" height="4" rx="1"/><circle cx="7" cy="19.5" r="1.5"/><circle cx="17" cy="19.5" r="1.5"/>',
  medal: '<circle cx="12" cy="15" r="6"/><path d="M8.5 10.2 6 2h4l2 5M15.5 10.2 18 2h-4l-2 5"/><path d="M12 12.5v5"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  golf: '<path d="M8 21V3l9 4-9 4"/><ellipse cx="8" cy="21" rx="5" ry="1.2"/>',
  plane: '<path d="M2 12.5 22 4l-6 16-4-6.5z"/><path d="M12 13.5 22 4"/>',
  swords: '<path d="M3 3l10.5 10.5M21 3 10.5 13.5"/><path d="M6.5 15.5 4 18l2 2 2.5-2.5M17.5 15.5 20 18l-2 2-2.5-2.5"/><path d="M8 13l3 3M16 13l-3 3"/>',
  paddle: '<circle cx="10" cy="10" r="6.5"/><path d="M14.6 14.6 20 20"/><circle cx="19" cy="5" r="1.5"/>',
  puck: '<ellipse cx="12" cy="9" rx="8" ry="3.5"/><path d="M4 9v5c0 1.9 3.6 3.5 8 3.5s8-1.6 8-3.5V9"/>',
  gamepad: '<rect x="4" y="9" width="16" height="9" rx="2"/><path d="M8 12v3M6.5 13.5h3"/><circle cx="15" cy="12.5" r="1" fill="currentColor"/><circle cx="17.5" cy="15" r="1" fill="currentColor"/><path d="M12 9V6a2 2 0 0 1 2-2h1"/>',
  warning: '<path d="M12 3 2 20h20z"/><path d="M12 9v5M12 17.2h0" stroke-width="2.6"/>',
  tv: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M8 21h8M8 2l4 4 4-4"/>',
  invader: '<path d="M6 10V8a6 6 0 0 1 12 0v2"/><path d="M4 10h16v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M8 14h0M16 14h0" stroke-width="2.6"/><path d="M8 20v-2M16 20v-2"/>',
  blade: '<path d="M4 20 19 5"/><path d="M14 5h5v5"/><path d="M4 11l3 3"/>',
  fruit: '<path d="M3 8a9 9 0 0 0 18 0z"/><path d="M5.5 8a6.5 6.5 0 0 0 13 0"/><path d="M9 11h0M12 12.5h0M15 11h0" stroke-width="2.4"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.5 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  wheel: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.6"/><path d="M12 3v6.4M12 20.6V14.6M3 12h6.4M20.6 12h-6.4"/>',
};

const STYLE = '.ico{width:1em;height:1em;display:inline-block;vertical-align:-0.14em;'
  + 'fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex:none}'
  + '.ico.fill{fill:currentColor}.ico.gold{color:#f5c542}.ico.silver{color:#c9d1d9}.ico.bronze{color:#d08a4a}';

let styled = false;
function injectStyle() {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const s = document.createElement('style');
  s.id = 'senwii-icons';
  s.textContent = STYLE;
  document.head.appendChild(s);
}

export const ICON_NAMES = Object.keys(P);

/** Inline SVG markup for `name` (falls back to the gamepad). */
export function icon(name, cls = '') {
  injectStyle();
  return `<svg class="ico${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" aria-hidden="true">${P[name] || P.gamepad}</svg>`;
}

/** Swap every `<i data-icon="name" class="…">` in `root` for its SVG. */
export function hydrateIcons(root = document) {
  injectStyle();
  for (const el of root.querySelectorAll('i[data-icon]')) {
    el.outerHTML = icon(el.dataset.icon, el.className);
  }
}
