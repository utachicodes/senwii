# SenWii

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)
![Socket.IO](https://img.shields.io/badge/socket.io-4-010101?logo=socket.io&logoColor=white)
![Three.js](https://img.shields.io/badge/three.js-r185-black?logo=three.js&logoColor=white)
![Status](https://img.shields.io/badge/status-active-success.svg)

Motion-controlled games for the browser: your phone is the remote. A
Node/Socket.io relay streams phone IMU data over the LAN to a game running on
the PC.

**Live:** [www.senwii.utachi.website](https://www.senwii.utachi.website/)
(scan the QR there with your phone, no install).

## Why this and not another phone-as-controller app

Most "scan a QR, phone is the controller" setups use the phone as a keypad:
buttons and taps forwarded over the network. SenWii reads the phone's actual
gyro and accelerometer and turns the motion itself into the input: a swing is
a swing, a tilt is a tilt, not a button mapped to one.

That only works if it works for everyone holding the phone differently, so
the pointer engine (`core/pointer.js`) learns each device's gyro-axis
convention from its own data at runtime rather than assuming one: the same
swing reads correctly whether the phone's flat, upright, or sideways, with no
calibration screen. No app to install either: the controller is a web page,
same as the game.

## Layout

```
server.js         Socket.io relay + static serving. Auto-discovers games/.
public/           Launcher (index.html) + the shared phone controller.
games/<slug>/     One folder per game, each with its own index.html.
```

A game is any folder under `games/` containing an `index.html`. No registry to
edit: the server scans on boot. `game.json` (title/tagline/emoji) is optional
and only feeds the launcher card.

## Things that will bite you

- **Sensors need HTTPS.** Browsers block motion sensors on insecure origins and
  Chrome does it silently: listeners attach, no error, no events. `npm start`
  serves HTTPS with a self-signed cert. `HTTP=1` is mouse-only.
- **Never send orientation `volatile`.** Socket.IO drops volatile packets when
  the transport isn't writable, which on long-polling is most of the time.
- **Don't reduce the mapping back to raw Euler angles.** Aim is measured in a
  calibrated frame built from the player's actual grip; the naive version breaks
  entirely for anyone holding the phone upright.
- **A page navigation is a new socket.** Menu → game and game → menu both tear
  down the old connection and open a new one, so the new page must reclaim the
  old room code (stashed in `sessionStorage`, see `core/splash.js`) or every
  phone that already joined gets silently stranded. The server holds a closed
  room open for 8 seconds specifically for this handoff.

## Quick start

Requires **Node.js 22+**, **OpenSSL**, a computer browser with WebGL 2, and a
motion-capable phone browser on the **same Wi-Fi**.

```bash
git clone https://github.com/utachicodes/SenWii.git
cd SenWii
npm ci
npm start
```

1. Open **https://localhost:8443/** on your computer. On macOS, Chrome opens
   automatically.
2. Scan the launcher's QR code with your phone. Accept the local self-signed
   certificate, tap **Enable motion sensors**, and allow access.
3. Choose a game and follow its controls. Stop the server with **Ctrl+C**.

**Phone motion requires HTTPS.** Use the QR code or the terminal's **Phone remote**
address, not `localhost` on your phone. SenWii is designed for shared local-network
play.

## Games

| Game | How to play | Players |
| --- | --- | --- |
| [Mario Kart](games/mario-kart/README.md) | Hold your phone sideways to steer, drift, boost and use items. The linked guide covers controls and included assets. | 1 human + 7 CPU racers |
| [Fruit Ninja](games/fruit-ninja/) | Swing to slice fruit, dodge bombs and build combos. | Up to 4 |
| [Alien Attack](games/alien-attack/) | Tilt to fly and press A to fire. | 1 |
| [Shooting Range](games/shooting-range/) | Point and press A to hit targets against the clock. | 1 |
| [Bowling](games/bowling/) | Point down the lane, swing to release. Ten frames, standard scoring. | 1 |
| [Boxing](games/boxing/) | Guard high or low, swing up or down to punch. First to 3 clean hits. | 1 |
| [Air Hockey](games/air-hockey/) | Point to move your mallet. Defend your goal, pot the puck in theirs. | 1 |

Golf, Table Tennis, Swordplay, Kart Time Trial and Island Flyover exist under
`games/` but are marked `hidden` in their `game.json`: in active development,
reachable by direct URL, not yet on the launcher menu.

## How it works

```mermaid
flowchart TD
    phone["Phone<br/>a web page acting as the Wii remote<br/><code>public/controller.*</code>"]
    relay["Node relay<br/>forwards packets, tags players P1 to P4<br/><code>server.js</code>"]
    browser["Browser tab<br/>Wii menu + games + motion engine<br/><code>public/menu.js · games/ · core/</code>"]
    phone -- "motion 60/s + buttons" --> relay
    relay -- "same stream, slot-tagged" --> browser
    browser -. "rumble, per player" .-> phone
```

A real Wii needs an IR sensor bar to know where the remote points; SenWii replaces it with pure software. The
engine learns each phone's gyro axis conventions from its own data at runtime
(they genuinely differ between devices), heals drift back toward the true pose
between swings, and dead-reckons the cursor slightly ahead of the packet
stream so it never feels laggy.

The relay is room-based: every PC that connects gets its own short join code
and its own up-to-4 phone slots, so two PCs on the same network (or, run
online, two unrelated groups on the same server) never see each other's
packets. The menu's QR and join panel encode that code; the controller page
reads it from `?room=`.

## Running online

`npm start`'s self-signed cert and LAN IP scan are a local-play convenience:
they don't mean anything once this isn't running on your own network. For a
public deployment, a platform's own edge (Fly.io, Render, Railway, an nginx
box you run yourself) terminates real TLS and forwards plain HTTP to the
container; set `TRUST_PROXY=1` and the server adapts:

- It skips `ensureCert()` entirely and just serves HTTP on `PORT`, since there's
  no LAN to generate a cert for.
- `app.set('trust proxy', 1)` so Express reads the edge's `X-Forwarded-*`
  headers instead of this process's own (plain-HTTP) view of itself.
- `/api/pairing`'s QR and join URL are built from the *request's* own `Host`
  header and protocol, not a scanned LAN address: that's the only thing
  that's actually correct once "the server" and "the network phones are on"
  aren't the same LAN anymore.

A `Dockerfile` and `fly.toml` are included: `fly launch` (after renaming
`app` in `fly.toml`) or an equivalent Render/Railway service pointed at the
same Dockerfile both work, since neither needs anything beyond `TRUST_PROXY`
and `PORT`. Sensors need a genuinely secure context, same as local HTTPS, so
double-check the platform's default domain/cert actually serves HTTPS before
expecting phones to connect.

What this doesn't change: the relay is still a single in-memory process (see
"How it works"). `rooms`/`roles`/`socketRoom` all live in one Node process's
memory, so this deploys as **one instance**, not a horizontally-scaled
fleet, until that state moves to something shared (Redis, etc.). For a
friend-group game night this is the right amount of infrastructure; for
anything bigger it's the next thing to build.

## Troubleshooting

- **Cannot connect:** check both devices are on the same Wi-Fi, allow Node.js
  through the firewall, and avoid guest networks that isolate devices.
- **Buttons work but motion does not:** check HTTPS and motion permissions. If
  the terminal reports an HTTP fallback, install OpenSSL and restart.
- **Black screen:** enable WebGL 2 / hardware acceleration in the computer browser.
- **No sound:** click the game to unlock audio and check its mute control.

Set `PORT` to use another port, or `NO_OPEN=1` to skip auto-opening Chrome.

## License

[MIT](LICENSE). Built by [Abdoullah Ndao](https://github.com/utachicodes) on
top of the original OpenWii concept by Patrick Sun. This is an independent fan
project, not affiliated with or endorsed by Nintendo.