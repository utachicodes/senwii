'use strict';

/**
 * SenWii — LAN relay server.
 *
 * Serves the clients and pipes messages between them:
 *   /                     → game launcher
 *   /controller           → phone controller (the "remote", shared by all games)
 *   /games/<slug>/        → a game's PC client
 *
 * The server holds no game state. It is a dumb, low-latency switchboard so the
 * phone's orientation stream reaches the PC with as few hops as possible.
 */

const { exec } = require('child_process');
const express = require('express');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { ensureCert, localAddresses } = require('./scripts/gen-cert');

const PORT = Number(process.env.PORT) || 8443;
const FORCE_HTTP = process.env.HTTP === '1';
// Set when a platform's own edge (Fly.io, Render, Railway, nginx, ...)
// terminates TLS and forwards plain HTTP: this process serves HTTP (no local
// cert to manage) and trusts that edge's X-Forwarded-* headers instead of
// generating a self-signed cert for a LAN no one here is actually on. See
// README's "Running online" section for the two or three env vars this needs.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const GAMES_DIR = path.join(__dirname, 'games');

const app = express();
if (TRUST_PROXY) app.set('trust proxy', 1);
// no-cache (NOT no-store): browsers must revalidate every file against its
// ETag on each load, so a plain reload after a git pull always runs current
// code — while unchanged files still come back as cheap 304s. Heuristic
// freshness on module scripts otherwise happily serves a stale game.js.
const NO_CACHE = { setHeaders: (res) => res.set('Cache-Control', 'no-cache') };
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], ...NO_CACHE }));
app.use('/games', express.static(GAMES_DIR, { extensions: ['html'], ...NO_CACHE }));
// The shared motion engine, imported directly by games as ES modules.
app.use('/core', express.static(path.join(__dirname, 'core'), NO_CACHE));
// Three.js straight from node_modules — no build step, no bundler.
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules', 'three', 'build')));
app.use('/vendor/three-examples', express.static(path.join(__dirname, 'node_modules', 'three', 'examples', 'jsm')));
app.use('/assets', express.static(path.join(__dirname, 'assets'), NO_CACHE));
// Optional audio overrides. Gitignored: nothing copyrighted ships by default.
app.use('/audio', express.static(path.join(__dirname, 'audio'), { fallthrough: true }));

/**
 * Discover games from disk rather than a hardcoded list: a game is any folder
 * under games/ with an index.html. Dropping in a new folder is the whole
 * install step.
 *
 * game.json may set `hidden: true` to keep a game off the menu (still
 * reachable by URL) and `order` (lower first) to pin its menu position;
 * unordered games follow alphabetically.
 */
function listGames() {
  let entries;
  try {
    entries = fs.readdirSync(GAMES_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(GAMES_DIR, e.name, 'index.html')))
    .map((e) => {
      const meta = { title: e.name, tagline: '', emoji: '🎮' };
      try {
        Object.assign(meta, JSON.parse(fs.readFileSync(path.join(GAMES_DIR, e.name, 'game.json'), 'utf8')));
      } catch { /* game.json is optional */ }
      return { slug: e.name, url: `/games/${e.name}/`, ...meta };
    })
    .filter((g) => !g.hidden)
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || a.title.localeCompare(b.title));
}

app.get('/api/games', (_req, res) => res.json(listGames()));

/**
 * A fresh id per server run. Clients tie their saved calibration to it, so
 * calibration happens once when you `npm start` and is then inherited by every
 * page for the life of that run — restart the server and you calibrate again.
 */
const BOOT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
app.get('/api/session', (_req, res) => res.json({ bootId: BOOT_ID }));

// Behind a trusted edge, that edge holds the real cert — this process just
// speaks plain HTTP on PORT, same as FORCE_HTTP's local dev path, but without
// FORCE_HTTP's "sensors won't work" caveat (the public URL genuinely is
// HTTPS; only the hop from the edge to here is plain).
const tls = (FORCE_HTTP || TRUST_PROXY) ? null : ensureCert();
const server = tls ? https.createServer(tls, app) : http.createServer(app);
const scheme = tls || TRUST_PROXY ? 'https' : 'http';

const lanIp = localAddresses()[0] || 'localhost';
const controllerUrl = `${scheme}://${lanIp}:${PORT}/controller`;

/**
 * The base URL phones should use to reach this server. On a LAN this is the
 * scanned local IP; behind a reverse proxy there's no such thing — the only
 * correct source is the request's own Host header (which `trust proxy` above
 * makes `req.get('host')`/`req.protocol` reflect the public hostname/scheme,
 * not this process's local plain-HTTP view of itself).
 */
function publicBaseUrl(req) {
  if (TRUST_PROXY) return `${req.protocol}://${req.get('host')}`;
  return `${scheme}://${lanIp}:${PORT}`;
}

// The PC client fetches this to render a scannable join code, once it has a
// room code from the socket connection (see 'register' below). Without one
// it falls back to the bare controller URL — still useful for manual typing.
const ROOM_CODE_RE = /^[A-Z0-9]{3,8}$/;
app.get('/api/pairing', async (req, res) => {
  const room = String(req.query.room || '').toUpperCase();
  const valid = ROOM_CODE_RE.test(room);
  const base = `${publicBaseUrl(req)}/controller`;
  const url = valid ? `${base}?room=${room}` : base;
  try {
    const qr = await QRCode.toDataURL(url, {
      margin: 1,
      width: 320,
      color: { dark: '#0b0e14', light: '#ffffff' },
    });
    res.json({ url, qr, room: valid ? room : null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const io = new Server(server, {
  // Orientation samples are tiny and constant; skip the polling handshake.
  transports: ['websocket', 'polling'],
  pingInterval: 10000,
  pingTimeout: 5000,
  cors: { origin: '*' },
});

/** socket.id → 'game' | 'controller' */
const roles = new Map();

/**
 * A room is one PC + up to MAX_PLAYERS phones. Every game page that connects
 * gets its own room and its own code — a single `npm start` still behaves
 * exactly like before (one room, one code), but nothing stops two PCs on the
 * same LAN (or, once this runs online, two unrelated groups on the same
 * server) from running concurrent sessions without their packets crossing.
 *
 * The server holds no game state *within* a room — see the file banner —
 * but it does now hold room membership, which is the minimum needed to keep
 * two sessions' orientation streams from colliding.
 */
const MAX_PLAYERS = 4;
// A page navigation (menu → game) drops the old socket and opens a new one;
// the new page's GameLink reclaims the menu's room code (see core/net.js and
// core/splash.js) instead of minting a fresh one, so this window just covers
// the gap between the old socket's disconnect and the new page's connect.
const ROOM_RECLAIM_MS = 8000;
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
const rooms = new Map();        // code → { code, gameSocketId, slots: [socketId|null] }
const socketRoom = new Map();   // socket.id → room code (both game and controller sockets)
const roomCloseTimers = new Map();   // code → Timeout, pending while a room's game socket is away

function genRoomCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom(gameSocketId) {
  const room = { code: genRoomCode(), gameSocketId, slots: new Array(MAX_PLAYERS).fill(null) };
  rooms.set(room.code, room);
  return room;
}

function cancelRoomClose(code) {
  const timer = roomCloseTimers.get(code);
  if (timer) {
    clearTimeout(timer);
    roomCloseTimers.delete(code);
  }
}

function assignSlot(room, socketId) {
  const free = room.slots.indexOf(null);
  if (free === -1) return -1;
  room.slots[free] = socketId;
  return free;
}

function releaseSlot(room, socketId) {
  const i = room.slots.indexOf(socketId);
  if (i !== -1) room.slots[i] = null;
}

const gameRoomOf = (code) => `room:${code}:game`;
const controllerRoomOf = (code) => `room:${code}:controller`;

function broadcastPresence(room) {
  io.to(gameRoomOf(room.code)).to(controllerRoomOf(room.code)).emit('presence', {
    game: room.gameSocketId ? 1 : 0,
    controller: room.slots.filter(Boolean).length,
    slots: room.slots.map((id, i) => ({ slot: i, occupied: id !== null })),
  });
}

io.on('connection', (socket) => {
  socket.on('register', (role, payload) => {
    if (role === 'game') {
      roles.set(socket.id, 'game');
      const wantCode = String((payload && payload.room) || '').toUpperCase();
      const existing = wantCode && rooms.get(wantCode);
      let room;
      if (existing) {
        // Reclaiming the room this socket's previous page (the menu, or an
        // earlier game) was holding — same code, same phones, new socket.
        cancelRoomClose(existing.code);
        existing.gameSocketId = socket.id;
        room = existing;
      } else {
        room = createRoom(socket.id);
      }
      socketRoom.set(socket.id, room.code);
      socket.join(gameRoomOf(room.code));
      socket.emit('room', { code: room.code });
      console.log(`[io] game connected, room ${room.code}${existing ? ' (reclaimed)' : ''} (${socket.id})`);
      broadcastPresence(room);
      return;
    }

    if (role === 'controller') {
      const code = String((payload && payload.room) || '').toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        socket.emit('room-denied', { code });
        console.log(`[io] controller rejected — unknown room ${code || '(none)'} (${socket.id})`);
        return;
      }
      const slot = assignSlot(room, socket.id);
      if (slot === -1) {
        socket.emit('slot-denied', { reason: 'all player slots full', max: MAX_PLAYERS });
        console.log(`[io] controller rejected — ${MAX_PLAYERS} slots full in room ${code} (${socket.id})`);
        return;
      }
      roles.set(socket.id, 'controller');
      socketRoom.set(socket.id, room.code);
      socket.join(controllerRoomOf(room.code));
      socket.emit('slot', { slot });
      console.log(`[io] controller connected as player ${slot + 1} in room ${code} (${socket.id})`);
      broadcastPresence(room);
    }
  });

  // Latency probe. Echoed straight back so the game can measure a true round
  // trip — a one-way timestamp would need synchronised clocks across devices.
  socket.on('ping-probe', (data) => {
    const code = socketRoom.get(socket.id);
    if (code) socket.to(controllerRoomOf(code)).emit('ping-probe', data);
  });
  socket.on('pong-probe', (data) => {
    const code = socketRoom.get(socket.id);
    if (code) socket.to(gameRoomOf(code)).emit('pong-probe', data);
  });

  // Phone → PC.
  //
  // NOT volatile. Socket.IO discards volatile packets whenever the transport
  // reports itself unwritable, which on the long-polling transport is most of
  // the time — so a connection that falls back to polling (easy to trigger with
  // a self-signed cert) drops effectively the entire orientation stream while
  // ordinary emits still get through. That failure is invisible: the phone
  // connects, commands work, and the blade simply never moves. The payload is
  // ~100 bytes at 60Hz; the rate cap on the sender is the real backpressure.
  socket.on('orientation', (data) => {
    const code = socketRoom.get(socket.id);
    const room = code && rooms.get(code);
    if (!room) return;
    socket.to(gameRoomOf(code)).emit('orientation', { ...data, slot: room.slots.indexOf(socket.id) });
  });

  socket.on('motion', (data) => {
    const code = socketRoom.get(socket.id);
    const room = code && rooms.get(code);
    if (!room) return;
    socket.to(gameRoomOf(code)).emit('motion', { ...data, slot: room.slots.indexOf(socket.id) });
  });

  // Phone → PC control actions: calibrate, start, pause, sensitivity nudges.
  socket.on('command', (data) => {
    const code = socketRoom.get(socket.id);
    const room = code && rooms.get(code);
    if (!room) return;
    socket.to(gameRoomOf(code)).emit('command', { ...data, slot: room.slots.indexOf(socket.id) });
  });

  // PC → phone feedback: hits (haptics), score, game state.
  //
  // A message with a `slot` goes to that one phone only — e.g. a multiplayer
  // slice should buzz the hand that swung it, not every hand in the lobby.
  // Anything without a slot broadcasts to every controller in the sender's
  // own room, unchanged from before slots existed — every existing
  // single-player game's feedback calls omit it, so this is purely additive.
  socket.on('feedback', (data) => {
    const code = socketRoom.get(socket.id);
    const room = code && rooms.get(code);
    if (!room) return;
    if (typeof data.slot === 'number' && room.slots[data.slot]) {
      io.to(room.slots[data.slot]).emit('feedback', data);
    } else {
      socket.to(controllerRoomOf(code)).emit('feedback', data);
    }
  });

  socket.on('disconnect', () => {
    const role = roles.get(socket.id);
    roles.delete(socket.id);
    const code = socketRoom.get(socket.id);
    socketRoom.delete(socket.id);
    const room = code && rooms.get(code);
    if (room) {
      if (role === 'game') {
        // A navigation (menu → game, or back to the menu) drops this socket
        // and a new one reclaims the same code almost immediately — if that
        // already happened, room.gameSocketId no longer points at us, and
        // the room is alive under the new socket. Only start the grace
        // timer when this socket is still the one the room thinks it has.
        if (room.gameSocketId === socket.id) {
          room.gameSocketId = null;
          console.log(`[io] game disconnected, room ${code} reclaimable for ${ROOM_RECLAIM_MS}ms (${socket.id})`);
          const timer = setTimeout(() => {
            roomCloseTimers.delete(code);
            if (rooms.get(code) === room && room.gameSocketId === null) {
              io.to(controllerRoomOf(code)).emit('room-closed');
              rooms.delete(code);
              console.log(`[io] room ${code} closed — nothing reclaimed it in time`);
            }
          }, ROOM_RECLAIM_MS);
          roomCloseTimers.set(code, timer);
        }
      } else {
        releaseSlot(room, socket.id);
        broadcastPresence(room);
      }
    }
    if (role && role !== 'game') console.log(`[io] ${role} disconnected (${socket.id})`);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const line = '─'.repeat(52);
  console.log(`\n${line}`);
  console.log('  🕹  SenWii — your phone is the remote');
  console.log(line);
  if (TRUST_PROXY) {
    console.log(`  Listening     http://0.0.0.0:${PORT} (plain HTTP — behind a TLS-terminating edge)`);
  } else {
    console.log(`  Launcher      ${scheme}://localhost:${PORT}/`);
    console.log(`  Phone remote  ${controllerUrl}`);
  }
  const games = listGames();
  console.log(`\n  ${games.length} game${games.length === 1 ? '' : 's'}:`);
  for (const g of games) console.log(`    ${g.emoji}  ${g.title}  →  ${g.url}`);
  if (TRUST_PROXY) {
    console.log('\n  ☁  TRUST_PROXY mode: pairing URLs are built from each request\'s');
    console.log('     own Host header, not a scanned LAN address.');
  } else if (!tls) {
    console.log('\n  ⚠  Running plain HTTP. Phone sensors will NOT work off');
    console.log('     localhost — browsers gate the IMU behind a secure context.');
  } else {
    console.log('\n  ⚠  Self-signed cert: the phone will show a warning once.');
    console.log('     Tap Advanced → Proceed. Sensors need HTTPS to unlock.');
  }

  // One command, whole console: npm start also opens the TV browser — its
  // own Chrome profile so the autoplay flag genuinely applies (handing the
  // URL to an already-running Chrome silently drops process flags).
  // HTTP dev mode and NO_OPEN=1 skip this.
  if (tls && process.platform === 'darwin' && !process.env.NO_OPEN) {
    exec('open -na "Google Chrome" --args'
      + ' --user-data-dir="$HOME/.openwii-chrome" --no-first-run --no-default-browser-check'
      + ` --autoplay-policy=no-user-gesture-required --new-window https://localhost:${PORT}/`);
    console.log('\n  📺 Opening the console in Chrome (autoplay enabled)…');
    console.log('     Skip with NO_OPEN=1 npm start.');
  }
  console.log(`${line}\n`);
});
