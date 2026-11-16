import { Pointer } from '/core/pointer.js';
import { saveSensitivity, loadSensitivity } from '/core/calibration.js';
import { AudioEngine } from '/core/audio.js';
import { GameLink } from '/core/net.js';
import { clamp } from '/core/orientation.js';

/**
 * The SenWii menu.
 *
 * Real DOM, not a Three.js world — but still a motion-controlled UI: every
 * connected phone drives an on-screen hand that can hover a game and press A
 * to launch it, exactly like a channel on the console this is modelled on.
 * Desktop falls back to the mouse for slot 0 (unchanged behaviour from the
 * previous build).
 */

const $ = (id) => document.getElementById(id);

const ICONS = {
  racing: 'i-kart',
  'fruit-ninja': 'i-blade',
  'alien-attack': 'i-invader',
  'shooting-range': 'i-target',
  bowling: 'i-pin',
  boxing: 'i-glove',
  'air-hockey': 'i-puck',
};
const iconFor = (slug) => ICONS[slug] || 'i-joy';

let games = [];

// ── Per-player input state ──────────────────────────────────────────────────
const inputs = new Map();   // slot → { pointer, hand, hover, lastHover }
function inputFor(slot) {
  let inp = inputs.get(slot);
  if (!inp) {
    const pointer = new Pointer({ sensitivity: slot === 0 ? loadSensitivity() : 1 });
    const hand = document.createElement('div');
    hand.className = `hand p${slot + 1}`;
    document.body.appendChild(hand);
    inp = { pointer, hand, hover: null, lastHover: null };
    inputs.set(slot, inp);
  }
  return inp;
}
inputFor(0);

// ── Audio ────────────────────────────────────────────────────────────────
const audio = new AudioEngine();
let musicReady = false;
function ensureAudio() {
  for (const cue of ['menu-hover', 'menu-select', 'menu-back']) audio.loadOverride(cue);
  audio.unlock().then((ok) => {
    if (!ok) return;
    if (!audio.music && !launching && musicReady) audio.startMusic();
  });
}
ensureAudio();

// ── Relay link ───────────────────────────────────────────────────────────
let launching = null;        // { el, t, rect } during the launch zoom
let latencyMs = null;

// Safari's back-forward cache freezes this whole page's JS state — including
// `launching` — at the exact instant you clicked a game, then restores it
// unchanged on a back navigation. Without this, `launching` stays truthy
// forever and pressA()/every click silently no-ops: the menu *looks* fine
// but is permanently inert. `pageshow`'s `persisted` flag is how a page
// tells a bfcache restore apart from a normal load.
window.addEventListener('pageshow', (e) => {
  if (!e.persisted) return;
  launching = null;
  document.getElementById('launch')?.remove();
});

// Backing out of a game stashes its room code (see core/splash.js) so
// returning here reclaims it instead of stranding any phone still connected.
let homeRoom = null;
try {
  homeRoom = sessionStorage.getItem('senwii.homeRoom') || null;
  sessionStorage.removeItem('senwii.homeRoom');
} catch { /* storage unavailable */ }

const link = new GameLink({
  room: homeRoom,
  onRoom: (code) => {
    $('join-url').textContent = `room ${code}`;
    fetch(`/api/pairing?room=${encodeURIComponent(code)}`).then((r) => r.json()).then(({ url, qr }) => {
      $('qr').src = qr;
      $('join-url').textContent = url;
    }).catch(() => { $('join-url').textContent = `room ${code} (pairing unavailable)`; });
  },
  onOrientation: (sample, slot) => {
    const now = performance.now();
    const inp = inputFor(slot);
    const dt = inp.pointer.lastSeen ? clamp((now - inp.pointer.lastSeen) / 1000, 1 / 240, 0.1) : 1 / 60;
    inp.pointer.update(sample, dt, now);
    if (slot === activeTelemetrySlot()) updateTelemetry(sample);
  },
  onCommand: (cmd, slot) => {
    if (cmd.type === 'button' && cmd.button === 'A') pressA(slot);
    else if (cmd.type === 'button' && cmd.button === 'B') pressB();
    else if (cmd.type === 'calibrate' || cmd.type === 'recentre') quickRecentre(slot);
    else if (cmd.type === 'speed') {
      const p = inputFor(slot).pointer;
      p.sensitivity = clamp(p.sensitivity * (cmd.factor || 1), 0.2, 6);
      if (slot === 0) saveSensitivity(p.sensitivity);
      showSpeed(slot);
    }
  },
  onPresence: (pr) => {
    $('led').classList.toggle('on', pr.controller > 0);
    $('status-pill').classList.toggle('off', pr.controller === 0);
    $('status-text').textContent = pr.controller === 1 ? '1 connected' : `${pr.controller} connected`;
    const bays = $('bays');
    (pr.slots || []).forEach((s, i) => {
      const bay = bays.children[i];
      if (bay) bay.classList.toggle('on', !!s.occupied);
    });
    for (const s of pr.slots || []) {
      if (s.occupied) continue;
      const inp = inputs.get(s.slot);
      if (inp) { inp.pointer.live = false; inp.hand.style.display = 'none'; inp.hover = null; }
    }
    if (pr.controller === 0) {
      $('attitude-label').textContent = 'ATTITUDE, NO SIGNAL';
    }
    updateTicker();
  },
});
link.onLatency = (ms) => {
  latencyMs = ms;
  for (const inp of inputs.values()) inp.pointer.setNetworkRtt(ms);
  updateTicker();
};
setInterval(() => link.probeLatency(), 4000);

function activeTelemetrySlot() {
  for (const [slot, inp] of inputs) if (inp.pointer.live) return slot;
  return -1;
}

function updateTelemetry(sample) {
  // Decorative, not aim-critical: a direct read of tilt for the dashboard
  // readout, independent of the learned-axis pointer above.
  const roll = clamp(Math.round(sample.gamma ?? 0), -60, 60);
  const pitch = clamp(Math.round(-(sample.beta ?? 0)), -40, 40);
  $('t-roll').textContent = `${roll}°`;
  $('t-pitch').textContent = `${pitch}°`;
  $('horizon-rot').setAttribute('transform', `translate(100 100) rotate(${-roll}) translate(0 ${pitch * 1.4})`);
  const slot = activeTelemetrySlot();
  $('attitude-label').textContent = slot >= 0 ? `ATTITUDE, P${slot + 1}` : 'ATTITUDE, NO SIGNAL';
}

// Idle demo: cursor drives the dial until a real phone takes over.
let demoActive = true;
window.addEventListener('mousemove', (e) => {
  if (!demoActive) return;
  const px = e.clientX / window.innerWidth;
  const py = e.clientY / window.innerHeight;
  const roll = Math.round((px - 0.5) * 60);
  const pitch = Math.round((0.5 - py) * 40);
  $('t-roll').textContent = `${roll}°`;
  $('t-pitch').textContent = `${pitch}°`;
  $('horizon-rot').setAttribute('transform', `translate(100 100) rotate(${-roll}) translate(0 ${pitch * 1.4})`);
});

function updateTicker() {
  const n = link.controllers;
  const rate = link.rate ? `${link.rate.toFixed(0)}Hz` : '--';
  const rtt = latencyMs != null ? `${latencyMs.toFixed(0)}ms` : '--';
  const text = `${n} CONTROLLER${n === 1 ? '' : 'S'} CONNECTED &middot; STREAM ${rate} &middot; RTT ${rtt} &middot; `
    + `${games.length} GAME${games.length === 1 ? '' : 'S'} AVAILABLE &middot; `;
  $('ticker-text').innerHTML = text.repeat(3);
  $('t-rate').textContent = link.rate ? `${link.rate.toFixed(0)}Hz` : '–';
}
setInterval(updateTicker, 1000);

// ── Game library ─────────────────────────────────────────────────────────
function renderGames() {
  const list = $('cart-list');
  list.innerHTML = '';
  if (!games.length) {
    list.innerHTML = '<div class="cart-empty">No games found under games/.</div>';
    return;
  }
  for (const game of games) {
    const el = document.createElement('a');
    el.className = 'cart';
    el.href = game.url;
    el.tabIndex = 0;
    el.dataset.slug = game.slug;
    el.innerHTML = `<span class="cart-led"></span>`
      + `<span class="cart-plate"><svg class="icon"><use href="#${iconFor(game.slug)}"/></svg></span>`
      + `<div class="cart-copy"><h3>${game.title}</h3><p>${game.tagline || ''}</p></div>`
      + `<span class="cart-players">${game.players === 1 ? '1 PLAYER' : `${game.players || 1} PLAYERS`}</span>`;
    el.addEventListener('click', (e) => {
      e.preventDefault();
      ensureAudio();
      launch(game, el);
    });
    el.addEventListener('mouseenter', () => audio.play('menu-hover'));
    list.appendChild(el);
  }
}

function launch(game, el) {
  if (launching) return;
  launching = { t: 0 };
  audio.play('menu-select');
  audio.stopMusic();
  link.feedback({ type: 'launch', game: game.slug });

  const r = el.getBoundingClientRect();
  const c0 = '#141b2b';
  const c1 = '#28344c';
  const banner = document.createElement('div');
  banner.id = 'launch';
  banner.style.cssText = `left:${r.left}px; top:${r.top}px; width:${r.width}px; height:${r.height}px;`;
  banner.innerHTML = `<div class="l-emoji">${game.emoji || '\u{1F3AE}'}</div><div class="l-title">${game.title}</div>`;
  document.body.appendChild(banner);
  void banner.offsetWidth;
  banner.classList.add('full');

  try {
    sessionStorage.setItem('senwii.launch', JSON.stringify({
      slug: game.slug, title: game.title, emoji: game.emoji || '\u{1F3AE}', c0, c1, t: Date.now(),
      room: link.room,
    }));
  } catch { /* storage may be unavailable; the splash just won't carry over */ }

  setTimeout(() => { window.location.href = game.url; }, 650);
}

// ── Interaction ──────────────────────────────────────────────────────────
function pressA(slot = 0) {
  ensureAudio();
  if (launching) return;
  const hovered = inputFor(slot).hover;
  if (hovered) launch(hovered.game, hovered.el);
}
function pressB() {
  ensureAudio();
  audio.play('menu-back');
}
function quickRecentre(slot = 0) {
  ensureAudio();
  inputFor(slot).pointer.recentre();
  audio.play('menu-select');
}

let speedUntil = 0;
function showSpeed(slot = 0) {
  speedUntil = performance.now() + 1600;
  const p = inputFor(slot).pointer;
  const who = link.controllers > 1 ? `P${slot + 1} pointer` : 'Pointer';
  $('speed').textContent = `${who} speed ${(p.sensitivity * 100).toFixed(0)}%`;
  $('speed').classList.add('on');
}

// ── Hit testing against the live DOM ─────────────────────────────────────
function hitTest(px, py) {
  const el = document.elementFromPoint(px, py);
  const cart = el && el.closest ? el.closest('.cart') : null;
  if (!cart) return null;
  const game = games.find((g) => g.slug === cart.dataset.slug);
  return game ? { el: cart, game } : null;
}

// ── Desk fallback (no phone) ───────────────────────────────────────────────
const mouse = { x: 0.5, y: 0.5, active: false };
window.addEventListener('mousemove', (e) => {
  mouse.x = e.clientX / window.innerWidth;
  mouse.y = e.clientY / window.innerHeight;
  mouse.active = true;
  demoActive = inputFor(0).pointer.live === false && activeTelemetrySlot() === -1;
});
window.addEventListener('keydown', (e) => {
  ensureAudio();
  if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); pressA(); }
  else if (e.key === 'Escape' || e.key.toLowerCase() === 'b') pressB();
  else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault();
    const step = e.key === 'ArrowRight' ? 1.12 : 1 / 1.12;
    const p0 = inputFor(0).pointer;
    p0.sensitivity = clamp(p0.sensitivity * step, 0.2, 6);
    saveSensitivity(p0.sensitivity);
    showSpeed();
  } else if (e.key.toLowerCase() === 'r' || e.key.toLowerCase() === 'c') quickRecentre();
  else if (e.key.toLowerCase() === 'd') $('debug').classList.toggle('on');
});

// ── Frame loop: move hands, hit-test, hover feedback ───────────────────────
function frame(now) {
  requestAnimationFrame(frame);
  for (const [slot, inp] of inputs) {
    const ptr = inp.pointer;
    if (!ptr.live && slot === 0 && mouse.active) ptr.setFromMouse(mouse.x, mouse.y);
    if (ptr.live && now - ptr.lastSeen > 500) ptr.live = false;

    const active = ptr.live || (slot === 0 && mouse.active);
    inp.hand.style.display = (active && !launching) ? 'block' : 'none';
    if (!active || launching) { inp.hover = null; continue; }

    const aim = ptr.sampleAt(now);
    const px = aim.x * window.innerWidth;
    const py = aim.y * window.innerHeight;
    inp.hand.style.transform = `translate3d(${px}px, ${py}px, 0)`;

    inp.hover = hitTest(px, py);
    const hoverEl = inp.hover ? inp.hover.el : null;
    if (inp.lastHover && inp.lastHover !== hoverEl) inp.lastHover.classList.remove('hover');
    if (hoverEl) {
      hoverEl.classList.add('hover');
      if (inp.lastHover !== hoverEl) audio.play('menu-hover');
    }
    inp.lastHover = hoverEl;
  }
  if (speedUntil && now > speedUntil) { speedUntil = 0; $('speed').classList.remove('on'); }
}

// ── Boot ───────────────────────────────────────────────────────────────────
fetch('/api/games').then((r) => r.json()).then((list) => {
  games = list;
  renderGames();
  updateTicker();
}).catch(() => { games = []; renderGames(); });

setInterval(() => {
  if (!$('debug').classList.contains('on')) return;
  const p0 = inputFor(0).pointer;
  const perPlayer = [...inputs.entries()].map(([slot, inp]) =>
    `P${slot + 1} ${inp.pointer.live ? 'live' : '-'} ${inp.hover ? inp.hover.game.title : 'none'}`).join('  ');
  $('debug').textContent = [
    `pointer     ${p0.display.x.toFixed(3)}, ${p0.display.y.toFixed(3)}`,
    `gyro map    ${p0.describeMap()}`,
    `mode        ${p0.mode}`,
    `players     ${perPlayer}`,
    `sensor      ${link.rate.toFixed(0)} Hz`,
    `games       ${games.length}`,
  ].join('\n');
}, 250);

{
  let fromHome = false;
  let homeChimed = false;
  try {
    const homeAt = Number(sessionStorage.getItem('senwii.home') || 0);
    sessionStorage.removeItem('senwii.home');
    fromHome = Date.now() - homeAt < 4000;
    homeChimed = sessionStorage.getItem('senwii.homeChimed') === '1';
    sessionStorage.removeItem('senwii.homeChimed');
  } catch { /* storage unavailable */ }

  const veil = document.createElement('div');
  veil.style.cssText = 'position:fixed;inset:0;background:#eef1f6;z-index:999;'
    + 'transition:opacity .9s ease;pointer-events:none;';
  document.body.appendChild(veil);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    veil.style.opacity = '0';
    setTimeout(() => veil.remove(), 1000);
    audio.unlock().then((ok) => {
      if (!ok) return;
      if (fromHome && !homeChimed) audio.loadOverride('menu-back').then(() => audio.play('menu-back'));
    });
    setTimeout(() => { musicReady = true; audio.startMusic(); }, 300);
  }));
}

requestAnimationFrame(frame);

window.__senwii = {
  inputs, audio, link, games,
  pressA, pressB, hitTest,
  state: () => ({
    hovers: [...inputs.entries()].map(([s, i]) => [s, i.hover ? i.hover.game.title : null]),
    launching: !!launching, games,
  }),
};
