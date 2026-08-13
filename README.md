# Dynamic Wallpaper

A live Windows wallpaper where **each monitor hosts a blob of particles**, and the blobs pull on each
other gravitationally according to how your monitors are actually arranged in Windows display settings.

Rotate a screen, nudge its vertical offset, make it primary, unplug it — the simulation reshapes itself
live. The glowing bridge that forms between two blobs isn't drawn: it's particles genuinely being
stripped across the gravitational balance point between them.

> Status: **in development.** See [Roadmap](#roadmap) for what works today.

## How it works

Each display contributes a **gravity well** at its centre, positioned in a single coordinate space shared
across the whole virtual desktop. Every particle is a test mass moving in the combined field of all
wells, integrated with Plummer-softened gravity:

```
F = Σ  G · M_w · (x_w − x_p) / (|x_w − x_p|² + ε²)^(3/2)
    w
```

Particles start on randomised near-circular orbits around their home well, which is what gives each blob
its fluffy spherical shape without any containment hack. An energy thermostat keeps the cloud radius
stable over long uptimes so it neither collapses to a point nor slowly boils away.

The interesting behaviour falls out of the physics for free. The neighbouring well's **tidal field**
stretches each cloud into a teardrop aimed at its companion, and particles near the balance point between
the two wells get stripped and stream across — the same mechanism as mass transfer between binary stars.
Move your monitors closer together in Windows display settings and the stream thickens.

### Rendering across monitors

A window can only paint the monitor it sits on, so a particle drifting from one screen to the next has to
be handed over. Rather than shuttle particle state between processes, every wallpaper window simulates
the **entire** system identically and renders only what falls inside its own camera frustum.

Determinism comes from a seeded RNG, a fixed 1/120 s timestep, and a shared simulation epoch — each
window independently derives the same tick count from wall-clock time, so they stay in lockstep without
any per-frame IPC. A periodic state snapshot guards against float drift over long runs.

## Requirements

- Windows 10/11
- Node.js 20+ (developed against 24.16)

## Development

```bash
npm install
```

```bash
npm run dev
```

## Roadmap

- [x] Render surface covering every monitor, pinned beneath all application windows
- [x] Live display topology tracking (rotation, offset, add/remove, primary change, DPI)
- [x] Particle simulation and bloom rendering
- [x] Cross-bezel continuity validation
- [ ] Tray icon and settings app with themes
- [ ] Installer

### A note on the wallpaper layer

Windows 11 build 26200 offers no working way to render into the real wallpaper layer. Four approaches
were built and measured, and all four fail:

| Approach | Result |
| --- | --- |
| Reparent the Chromium window into the shell's `WorkerW` | attaches correctly, composites nothing |
| Offscreen render, blit into the desktop DC with GDI | 60fps at 1.81ms/frame, draws nothing |
| Plain `FillRect` into `WorkerW` / `Progman` DCs | reports success, draws nothing |
| Reparent a classic Win32 window into the desktop hierarchy | composites nothing |

The last one is the informative one: it is not a Chromium limitation. Windows composites no foreign
child window in the desktop hierarchy on this build — only Explorer's own icon host renders.

Adopting that icon host into our own window *does* layer the icons above the live wallpaper, but they
are painted over within a second or two by the renderer's next frame. That mechanism is present
behind `DW_ADOPT_ICON_HOST=1` and off by default. Full measurements, the geometry fix it needs, and a
safety hazard around it are in [docs/desktop-layer-findings.md](docs/desktop-layer-findings.md).

The surface is therefore a top-level window per monitor, pinned to the bottom of the z-order,
non-activatable, click-through, and absent from the taskbar and Alt+Tab. Every application window
draws above it. **With desktop icons hidden it is indistinguishable from a real wallpaper; with icons
enabled it covers them,** and "Show desktop" reveals the desktop over it.

## Settings

The app lives in the system tray and starts with Windows. The settings panel exposes themes (colour,
particle count, blob size, glow, speed, stream density, drift strength), physics tuning, optional cursor
interaction, and power-saving toggles.

Power saving ships **off by default** — it targets quality first. If you want longer battery life, the
frame cap, GPU pinning, and auto-pause switches are all in there.

## Licence

MIT — see [LICENSE](LICENSE).

Inspired by [Bjørn Gunnar Staal](https://github.com/bgstaal)'s multi-window 3D scene experiments. No code
from any prior implementation is used here; the simulation is written from scratch.
